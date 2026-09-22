/**
 * Offline tests for capabilities C2 (`jev_route_skill`) and C4 (`jev_review_scope`).
 *
 * These are contract tests, and the fake judge is part of the contract rather
 * than a convenience. It validates every request it is handed the way
 * `buildRequest` does — an unknown question type, or a `noul` with no
 * `instructions`, makes it throw. So a builder that forgets `instructions` does
 * not merely fail an assertion here: it cannot produce a successful envelope at
 * all, because the request never reaches the judge.
 *
 * Nothing in this file touches the network, the filesystem, or a real model.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { CAPABILITY_REASON, CAPABILITY_STATUS } from '../lib/capability.mjs';
import { DEFAULT_THRESHOLDS } from '../lib/policy.mjs';
import { buildRouteQuestion, catalogIdentity, ROUTE_QUESTION_ID, routeSkill } from '../lib/route.mjs';
import { buildReviewQuestions, pinMaterial, reviewScope, reviewSnapshot } from '../lib/review.mjs';

// --- the fake judge ---------------------------------------------------------

const QUESTION_TYPES = ['noul', 'choice', 'score'];

/**
 * Reject anything the endpoint would reject.
 *
 * `instructions` is required for every question type; a `noul` without it is the
 * known R3 defect. A `choice` must offer the labels its criteria score, or the
 * judge is being asked to pick from a list it was never shown.
 */
function assertWellFormedRequest({ state, model, questions }) {
  assert.ok(state && typeof state === 'object', 'the request must carry a state');
  assert.ok(questions && typeof questions === 'object' && !Array.isArray(questions), 'questions must be a map');
  for (const [id, q] of Object.entries(questions)) {
    assert.ok(q && typeof q === 'object', `${id}: question must be an object`);
    assert.ok(QUESTION_TYPES.includes(q.type), `${id}: unknown question type ${JSON.stringify(q.type)}`);
    assert.notEqual(q.instructions, undefined, `${id}: instructions is required`);
    assert.notEqual(q.instructions, null, `${id}: instructions is required`);
    if (q.type === 'noul') {
      assert.ok(q.criteria && typeof q.criteria === 'object' && !Array.isArray(q.criteria), `${id}: a noul criteria must be an object`);
      for (const key of Object.keys(q.criteria)) {
        assert.ok(key === 'true' || key === 'false', `${id}: unexpected noul criteria key ${JSON.stringify(key)}`);
      }
    }
    if (q.type === 'choice') {
      assert.ok(Array.isArray(q.instructions.options), `${id}: a choice must offer options`);
      for (const key of Object.keys(q.criteria ?? {})) {
        assert.ok(q.instructions.options.includes(key), `${id}: criteria key ${JSON.stringify(key)} was never offered`);
      }
    }
  }
  if (model !== undefined && model !== null) assert.equal(typeof model, 'string');
  return true;
}

/**
 * A judge that validates the request, then answers from a script.
 *
 * `script` may be a function of the request, a map of question id -> answer, or
 * nothing at all (which makes it abstain). The call log is what lets a test show
 * that the model lane was *not* entered.
 */
function makeJudge(script = null) {
  const calls = [];
  const ask = async (request) => {
    assertWellFormedRequest(request);
    calls.push(request);
    if (typeof script === 'function') return script(request, calls.length);
    if (script && typeof script === 'object' && !Array.isArray(script)) {
      return { status: 'ok', answers: script, errors: [], usage: null, reason: null };
    }
    return { status: 'abstained', answers: {}, errors: [], usage: null, reason: 'the script had no answer' };
  };
  return {
    ask,
    calls,
    get count() {
      return calls.length;
    },
    get last() {
      return calls[calls.length - 1] ?? null;
    },
  };
}

/** A judge that is reachable but never answers. */
const abstainingJudge = () => makeJudge(null);

/** A judge that is not reachable at all. */
const deadJudge = () => ({
  ask: async () => ({ status: 'unavailable', answers: {}, errors: [], usage: null, reason: 'offline' }),
});

/** A judge whose transport fails outright. */
const throwingJudge = () => ({
  ask: async () => {
    throw new Error('connection refused');
  },
});

// --- C2 fixtures ------------------------------------------------------------

const ROUTE_SKILLS = [
  {
    id: 'alpha-route',
    name: 'alpha-route',
    description: 'Route a large catalog to the right skill and record the source id',
    whenToUse: 'When the catalog is too large to read',
    version: '1.0.0',
    digest: 'sha256:alpha',
    origin: 'package',
    declared: { capabilities: ['routing'], requires: ['jev_read'] },
  },
  {
    id: 'beta-route',
    name: 'beta-route',
    description: 'Route a large catalog of skills when the choice is ambiguous',
    whenToUse: 'When several skills could handle the task',
    version: '1.0.0',
    digest: 'sha256:beta',
    origin: 'package',
    declared: { capabilities: ['routing'], requires: [] },
  },
  {
    id: 'gamma-route',
    name: 'gamma-route',
    description: 'Route a large catalog by a different method',
    whenToUse: 'When the catalog is large',
    version: '1.0.0',
    digest: 'sha256:gamma',
    origin: 'package',
    declared: { capabilities: ['routing'], requires: [] },
  },
  {
    id: 'locked-skill',
    name: 'locked-skill',
    description: 'Route a large catalog but needs a tool this session does not have',
    whenToUse: 'When the catalog is large',
    version: '1.0.0',
    digest: 'sha256:locked',
    origin: 'package',
    declared: { capabilities: ['routing'], requires: ['jev_missing_tool'] },
  },
];

const ROUTE_TASK = 'the catalog is too large to read, so route the task to one skill';
const ROUTE_TOOLS = ['jev_read', 'jev_write'];

function makeCatalog(skills = ROUTE_SKILLS) {
  return { catalogVersion: '1.0.0', version: '2026.09.22', skills };
}

/** Every test asserts the envelope's own contract, so none of them can pass by accident. */
function assertEnvelope(envelope, capability) {
  assert.equal(envelope.capability, capability);
  assert.ok(
    [CAPABILITY_STATUS.success, CAPABILITY_STATUS.abstain, CAPABILITY_STATUS.unverified, CAPABILITY_STATUS.error].includes(envelope.status),
    `unknown status ${JSON.stringify(envelope.status)}`,
  );
  assert.ok(Object.values(CAPABILITY_REASON).includes(envelope.reason.code), `unknown reason code ${envelope.reason.code}`);
  assert.equal(envelope.actionAuthority, 'none', 'a capability never grants permission');
  assert.ok(envelope.snapshot && typeof envelope.snapshot.digest === 'string' && envelope.snapshot.digest.startsWith('sha256:'));
  assert.ok(Array.isArray(envelope.evidence));
  assert.ok(Array.isArray(envelope.limits) && envelope.limits.length > 0, 'limits must be stated, not omitted');
  assert.ok(envelope.model && typeof envelope.model.used === 'boolean');
  return envelope;
}

/** The laundering invariant, asserted directly rather than trusted to the core. */
function assertNoLaundering(envelope) {
  if (envelope.model.used !== true) return;
  const independent = envelope.evidence.filter((e) => e.trust === 'collector_observed' || e.trust === 'harness_observed');
  assert.ok(independent.length > 0, 'a model verdict needs at least one independently-acquired evidence ref');
}

// --- C2: order of authority -------------------------------------------------

describe('C2 routing — order of authority', () => {
  it('an explicit choice wins and the model is never consulted', async () => {
    const judge = makeJudge({ [ROUTE_QUESTION_ID]: { choice: 'beta-route', confidence: 0.9 } });
    const envelope = assertEnvelope(
      await routeSkill({ task: ROUTE_TASK, catalog: makeCatalog(), explicitSkill: 'locked-skill', availableTools: ROUTE_TOOLS, judge, taskId: 't1', runId: 'r1' }),
      'jev_route_skill',
    );
    assert.equal(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.explicitChoice);
    assert.equal(envelope.decision.source, 'explicit');
    assert.equal(envelope.decision.recommended, 'locked-skill');
    assert.equal(judge.count, 0, 'the model lane must not be entered for an explicit choice');
    assert.equal(envelope.model.requested, false);
    assert.equal(envelope.model.used, false);
    // The missing requirement is recorded rather than hidden: the user's choice
    // stands, and the reader is told it may not be runnable.
    assert.deepEqual(envelope.decision.missingCapabilities, ['jev_missing_tool']);
  });

  it('an explicit choice of an unknown skill is a non-success and never a substitution', async () => {
    const judge = makeJudge({ [ROUTE_QUESTION_ID]: { choice: 'beta-route', confidence: 0.9 } });
    const envelope = assertEnvelope(
      await routeSkill({ task: ROUTE_TASK, catalog: makeCatalog(), explicitSkill: 'no-such-skill', availableTools: ROUTE_TOOLS, judge, taskId: 't1', runId: 'r1' }),
      'jev_route_skill',
    );
    assert.notEqual(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.noCandidate);
    assert.equal(envelope.decision.recommended, null);
    assert.equal(envelope.decision.explicitSkillExists, false);
    assert.equal(judge.count, 0);
  });

  it('a skill whose required capability is missing is excluded before the model sees it', async () => {
    const judge = makeJudge({ [ROUTE_QUESTION_ID]: { choice: 'beta-route', confidence: 0.9 } });
    const envelope = assertEnvelope(
      await routeSkill({ task: ROUTE_TASK, catalog: makeCatalog(), availableTools: ROUTE_TOOLS, judge, taskId: 't1', runId: 'r1' }),
      'jev_route_skill',
    );
    assert.ok(envelope.decision.shortlist.some((c) => c.id === 'beta-route'));
    const excluded = envelope.decision.excluded.find((e) => e.id === 'locked-skill');
    assert.ok(excluded, 'locked-skill must be excluded');
    assert.equal(excluded.code, 'missing_capability');
    assert.match(excluded.detail, /jev_missing_tool/);
    const options = judge.last.questions[ROUTE_QUESTION_ID].instructions.options;
    assert.ok(!options.includes('locked-skill'), 'the model must never be offered an unavailable candidate');
    assert.ok(!judge.last.state.catalog.candidates.some((c) => c.id === 'locked-skill'), 'and must never be shown it as a candidate');
  });

  it('an empty catalog abstains with noCandidate', async () => {
    const judge = makeJudge({});
    const envelope = assertEnvelope(
      await routeSkill({ task: ROUTE_TASK, catalog: makeCatalog([]), availableTools: ROUTE_TOOLS, judge, taskId: 't1', runId: 'r1' }),
      'jev_route_skill',
    );
    assert.notEqual(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.noCandidate);
    assert.equal(envelope.decision.recommended, null);
    assert.equal(envelope.decision.emptyCatalog, true);
    assert.equal(judge.count, 0);
  });

  it('an unreachable judge still returns the deterministic shortlist', async () => {
    const envelope = assertEnvelope(
      await routeSkill({ task: ROUTE_TASK, catalog: makeCatalog(), availableTools: ROUTE_TOOLS, judge: deadJudge(), taskId: 't1', runId: 'r1' }),
      'jev_route_skill',
    );
    assert.equal(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.decision.source, 'deterministic');
    assert.ok(envelope.decision.shortlist.length >= 2, 'the catalog must stay usable without a judge');
    assert.equal(envelope.model.requested, true);
    assert.equal(envelope.model.used, false);
    assert.ok(typeof envelope.model.note === 'string' && envelope.model.note.length > 0);
  });

  it('no judge configured at all is the same fallback', async () => {
    const envelope = assertEnvelope(
      await routeSkill({ task: ROUTE_TASK, catalog: makeCatalog(), availableTools: ROUTE_TOOLS, judge: null, taskId: 't1', runId: 'r1' }),
      'jev_route_skill',
    );
    assert.equal(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.decision.source, 'deterministic');
    assert.equal(envelope.model.requested, true);
    assert.equal(envelope.model.used, false);
  });

  it('a judge that throws is caught and the deterministic answer stands', async () => {
    const envelope = assertEnvelope(
      await routeSkill({ task: ROUTE_TASK, catalog: makeCatalog(), availableTools: ROUTE_TOOLS, judge: throwingJudge(), taskId: 't1', runId: 'r1' }),
      'jev_route_skill',
    );
    assert.equal(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.decision.source, 'deterministic');
    assert.equal(envelope.model.used, false);
  });

  it('the model is not consulted when the shortlist has one candidate', async () => {
    const judge = makeJudge({ [ROUTE_QUESTION_ID]: { choice: 'beta-route', confidence: 0.9 } });
    const envelope = assertEnvelope(
      await routeSkill({ task: ROUTE_TASK, catalog: makeCatalog([ROUTE_SKILLS[0]]), availableTools: ROUTE_TOOLS, judge, taskId: 't1', runId: 'r1' }),
      'jev_route_skill',
    );
    assert.equal(judge.count, 0, 'one candidate is not a choice to judge');
    assert.equal(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.decision.source, 'deterministic');
    assert.equal(envelope.decision.recommended, 'alpha-route');
    assert.equal(envelope.model.requested, false);
    assert.equal(envelope.model.used, false);
  });

  it('the catalog digest enters the snapshot, so a changed catalog changes it', async () => {
    const first = assertEnvelope(
      await routeSkill({ task: ROUTE_TASK, catalog: makeCatalog(), availableTools: ROUTE_TOOLS, taskId: 't1', runId: 'r1' }),
      'jev_route_skill',
    );
    const changed = makeCatalog([{ ...ROUTE_SKILLS[0], description: 'a materially different description of the same skill' }, ...ROUTE_SKILLS.slice(1)]);
    const second = assertEnvelope(
      await routeSkill({ task: ROUTE_TASK, catalog: changed, availableTools: ROUTE_TOOLS, taskId: 't1', runId: 'r1' }),
      'jev_route_skill',
    );
    assert.notEqual(first.snapshot.digest, second.snapshot.digest, 'a changed catalog must change the snapshot digest');
    assert.notEqual(first.decision.catalogDigest, second.decision.catalogDigest);
    assert.equal(first.decision.catalogVersion, '2026.09.22');
    assert.deepEqual(catalogIdentity(makeCatalog()).digest, first.decision.catalogDigest);
  });

  it('an abstaining judge abstains with recommended null', async () => {
    const envelope = assertEnvelope(
      await routeSkill({ task: ROUTE_TASK, catalog: makeCatalog(), availableTools: ROUTE_TOOLS, judge: abstainingJudge(), taskId: 't1', runId: 'r1' }),
      'jev_route_skill',
    );
    assert.equal(envelope.status, CAPABILITY_STATUS.abstain);
    assert.equal(envelope.decision.recommended, null);
    assert.ok([CAPABILITY_REASON.abstained, CAPABILITY_REASON.judgeAbstained].includes(envelope.reason.code));
  });

  it('a judge that names "none" abstains with recommended null', async () => {
    const judge = makeJudge({ [ROUTE_QUESTION_ID]: { choice: 'none', confidence: 0.7 } });
    const envelope = assertEnvelope(
      await routeSkill({ task: ROUTE_TASK, catalog: makeCatalog(), availableTools: ROUTE_TOOLS, judge, taskId: 't1', runId: 'r1' }),
      'jev_route_skill',
    );
    assert.equal(envelope.status, CAPABILITY_STATUS.abstain);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.abstained);
    assert.equal(envelope.decision.recommended, null);
  });

  it('a low-confidence verdict abstains rather than recommending', async () => {
    const judge = makeJudge({ [ROUTE_QUESTION_ID]: { choice: 'beta-route', confidence: 0.2 } });
    const envelope = assertEnvelope(
      await routeSkill({ task: ROUTE_TASK, catalog: makeCatalog(), availableTools: ROUTE_TOOLS, judge, taskId: 't1', runId: 'r1' }),
      'jev_route_skill',
    );
    assert.equal(envelope.status, CAPABILITY_STATUS.abstain);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.judgeLowConfidence);
    assert.equal(envelope.decision.recommended, null);
  });

  it('a model verdict is used only for an offered candidate, and carries independent evidence', async () => {
    const judge = makeJudge({ [ROUTE_QUESTION_ID]: { choice: 'beta-route', confidence: 0.91 } });
    const envelope = assertEnvelope(
      await routeSkill({ task: ROUTE_TASK, catalog: makeCatalog(), availableTools: ROUTE_TOOLS, judge, model: 'jev-1.13.0', taskId: 't1', runId: 'r1' }),
      'jev_route_skill',
    );
    assert.equal(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.decision.source, 'model');
    assert.equal(envelope.decision.recommended, 'beta-route');
    assert.equal(envelope.model.used, true);
    assert.equal(judge.count, 1);
    assertNoLaundering(envelope);
  });

  it('reads the documented choice shape: choice plus probabilities plus confidence', async () => {
    const judge = makeJudge({
      [ROUTE_QUESTION_ID]: { choice: 'gamma-route', probabilities: { 'alpha-route': 0.02, 'beta-route': 0.07, 'gamma-route': 0.91 }, confidence: 0.91 },
    });
    const envelope = assertEnvelope(
      await routeSkill({ task: ROUTE_TASK, catalog: makeCatalog(), availableTools: ROUTE_TOOLS, judge, taskId: 't1', runId: 'r1' }),
      'jev_route_skill',
    );
    assert.equal(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.decision.recommended, 'gamma-route');
    assert.equal(envelope.decision.answerShape, 'choice');
    assert.equal(envelope.decision.confidence, 0.91);
  });

  it('a partial distribution is not argmaxed into a choice the judge never made', async () => {
    const judge = makeJudge({ [ROUTE_QUESTION_ID]: { probabilities: { 'beta-route': 0.4, 'gamma-route': 0.3 } } });
    const envelope = assertEnvelope(
      await routeSkill({ task: ROUTE_TASK, catalog: makeCatalog(), availableTools: ROUTE_TOOLS, judge, taskId: 't1', runId: 'r1' }),
      'jev_route_skill',
    );
    assert.notEqual(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.judgeAbstained);
    assert.equal(envelope.decision.recommended, null);
  });

  it('a verdict naming something that was never offered abstains instead of inventing a skill', async () => {
    const judge = makeJudge({ [ROUTE_QUESTION_ID]: { choice: 'invented-skill', confidence: 0.99 } });
    const envelope = assertEnvelope(
      await routeSkill({ task: ROUTE_TASK, catalog: makeCatalog(), availableTools: ROUTE_TOOLS, judge, taskId: 't1', runId: 'r1' }),
      'jev_route_skill',
    );
    assert.notEqual(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.noCandidate);
    assert.equal(envelope.decision.recommended, null);
  });
});

describe('C2 — the route question is well formed', () => {
  it('offers every candidate plus an abstain label, and carries instructions', () => {
    const shortlist = ROUTE_SKILLS.slice(0, 3).map((s) => ({ id: s.id, description: s.description, whenToUse: s.whenToUse, requires: s.declared.requires }));
    const questions = buildRouteQuestion({ task: ROUTE_TASK, shortlist });
    const question = questions[ROUTE_QUESTION_ID];
    assert.ok(question, 'the route question must be keyed by its documented id');
    assert.equal(question.type, 'choice');
    assert.notEqual(question.instructions, undefined, 'instructions is required — omitting it is the R3 defect');
    for (const id of shortlist.map((s) => s.id)) assert.ok(question.instructions.options.includes(id));
    assert.ok(question.instructions.options.includes('none'), 'abstention must be offerable');
    assertWellFormedRequest({ state: {}, questions });
  });

  it('the judge rejects a choice that scores a label it never offered', () => {
    assert.throws(
      () => assertWellFormedRequest({ state: {}, questions: { q: { type: 'choice', instructions: { options: ['a'] }, criteria: { b: 'no' } } } }),
      /never offered/,
    );
  });
});

// --- C4: material is pinned before it is judged -----------------------------

describe('C4 review — pinning', () => {
  it('includes a pinned diff and file in full up to the budget', () => {
    const pinned = pinMaterial({
      diff: '--- a/one.txt\n+++ b/one.txt\n+added line',
      files: [{ path: 'src/one.txt', content: 'export const one = 1;' }],
      scope: ['src'],
      maxChars: 4000,
    });
    assert.equal(pinned.truncated, false);
    assert.equal(pinned.chars, pinned.material.length);
    assert.ok(pinned.material.includes('+added line'));
    assert.ok(pinned.material.includes('export const one = 1;'));
    assert.ok(pinned.material.includes('src/one.txt'));
    assert.deepEqual(pinned.dropped, []);
    assert.deepEqual(pinned.filesIncluded, ['src/one.txt']);
  });

  it('records a file outside the declared scope instead of reviewing it', () => {
    const pinned = pinMaterial({
      files: [
        { path: 'src/kept.txt', content: 'kept content' },
        { path: 'secrets/outside.txt', content: 'should never be reviewed' },
      ],
      scope: ['src'],
    });
    assert.ok(pinned.material.includes('kept content'));
    assert.ok(!pinned.material.includes('should never be reviewed'), 'an out-of-scope file is not material');
    assert.equal(pinned.dropped.length, 1);
    assert.equal(pinned.dropped[0].path, 'secrets/outside.txt');
    assert.equal(pinned.dropped[0].reason, 'outside_scope');
  });

  it('records truncation rather than pretending the material was complete', () => {
    const pinned = pinMaterial({ diff: 'x'.repeat(500), maxChars: 100 });
    assert.equal(pinned.truncated, true);
    assert.equal(pinned.chars, 100);
    assert.ok(pinned.dropped.some((entry) => entry.reason === 'over_budget'));
    assert.ok(typeof pinned.truncatedReason === 'string');
  });

  it('reads a bare path from disk, and records one it cannot read', () => {
    // The DSH adapter passes paths rather than pinned text, so this is the shape
    // the capability actually sees in a session.
    writeFileSync(join(scratch, 'pinned.txt'), 'the pinned content', 'utf8');
    const pinned = pinMaterial({ files: ['pinned.txt', 'missing.txt'], scope: [], projectRoot: scratch });
    assert.ok(pinned.material.includes('the pinned content'));
    assert.deepEqual(pinned.filesIncluded, ['pinned.txt']);
    const unreadable = pinned.dropped.find((entry) => entry.path === 'missing.txt');
    assert.ok(unreadable, 'an unreadable file must be recorded, not silently reviewed as empty');
    assert.equal(unreadable.reason, 'unreadable');
  });
});

// --- C4: the review itself --------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'jev-c2c4-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const CLEAN_DIFF = '--- a/src/one.txt\n+++ b/src/one.txt\n-export const one = 0;\n+export const one = 1;';
const CLEAN_FILES = [{ path: 'src/one.txt', content: 'export const one = 1;\nexport function get() { return one; }' }];
const RUBRIC = {
  criteria: [
    { id: 'r1', text: 'the change is minimal and touches only the named constant' },
    { id: 'r2', text: 'no debug logging was added' },
  ],
};

/** A judge that answers every criterion with the same probability. */
const uniformJudge = (probability) => makeJudge(({ questions }) => {
  const answers = {};
  for (const id of Object.keys(questions)) answers[id] = { noul: probability };
  return { status: 'ok', answers, errors: [], usage: null, reason: null };
});

/** Walk every value, so a nested `line` key cannot hide from the assertion. */
function collectKeys(value, found = new Set()) {
  if (value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, found);
    return found;
  }
  for (const [key, nested] of Object.entries(value)) {
    found.add(key);
    collectKeys(nested, found);
  }
  return found;
}

describe('C4 review — missing material is never a yes', () => {
  it('no material at all is unverified, never success', async () => {
    const judge = uniformJudge(0.95);
    const envelope = assertEnvelope(
      await reviewScope({ diff: null, files: [], rubric: RUBRIC, judge, taskId: 't1', runId: 'r1' }),
      'jev_review_scope',
    );
    assert.notEqual(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.status, CAPABILITY_STATUS.unverified);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.missingMaterial);
    assert.deepEqual(envelope.decision.findings, []);
    assert.equal(judge.count, 0, 'a judge must not be asked about material that does not exist');
  });

  it('a mismatched snapshot is unverified', async () => {
    const judge = uniformJudge(0.95);
    const envelope = assertEnvelope(
      await reviewScope({ diff: CLEAN_DIFF, files: CLEAN_FILES, rubric: RUBRIC, snapshot: 'sha256:0000', judge, taskId: 't1', runId: 'r1' }),
      'jev_review_scope',
    );
    assert.notEqual(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.snapshotMismatch);
    assert.equal(judge.count, 0);
  });

  it('a snapshot the material actually has is accepted, while a stale one is refused', async () => {
    const pinned = pinMaterial({ diff: CLEAN_DIFF, files: CLEAN_FILES });
    const matching = reviewSnapshot(pinned);
    const accepted = assertEnvelope(
      await reviewScope({ diff: CLEAN_DIFF, files: CLEAN_FILES, rubric: RUBRIC, snapshot: matching, judge: null, taskId: 't1', runId: 'r1' }),
      'jev_review_scope',
    );
    // No judge configured, so this is unverified — but for the honest reason,
    // not because the snapshot was rejected.
    assert.equal(accepted.reason.code, CAPABILITY_REASON.judgeUnavailable);

    const refused = assertEnvelope(
      await reviewScope({ diff: CLEAN_DIFF, files: CLEAN_FILES, rubric: RUBRIC, snapshot: 'sha256:stale', judge: null, taskId: 't1', runId: 'r1' }),
      'jev_review_scope',
    );
    assert.equal(refused.reason.code, CAPABILITY_REASON.snapshotMismatch);
  });

  it('truncated required material is unverified with truncatedMaterial', async () => {
    const judge = uniformJudge(0.95);
    const envelope = assertEnvelope(
      await reviewScope({
        diff: 'y'.repeat(300),
        files: CLEAN_FILES,
        rubric: RUBRIC,
        judge,
        maxChars: 200,
        taskId: 't1',
        runId: 'r1',
      }),
      'jev_review_scope',
    );
    assert.notEqual(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.status, CAPABILITY_STATUS.unverified);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.truncatedMaterial);
    assert.equal(envelope.decision.truncated, true);
    assert.ok(envelope.decision.dropped.some((entry) => entry.reason === 'over_budget'));
    assert.equal(judge.count, 0, 'a truncated review must not spend a judge call');
  });

  it('a judge error is unverified, never success', async () => {
    const envelope = assertEnvelope(
      await reviewScope({ diff: CLEAN_DIFF, files: CLEAN_FILES, rubric: RUBRIC, judge: throwingJudge(), taskId: 't1', runId: 'r1' }),
      'jev_review_scope',
    );
    assert.notEqual(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.status, CAPABILITY_STATUS.unverified);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.judgeUnavailable);
    assert.equal(envelope.model.used, false);
  });

  it('an unreachable judge is unverified with judgeUnavailable', async () => {
    const envelope = assertEnvelope(
      await reviewScope({ diff: CLEAN_DIFF, files: CLEAN_FILES, rubric: RUBRIC, judge: deadJudge(), taskId: 't1', runId: 'r1' }),
      'jev_review_scope',
    );
    assert.equal(envelope.status, CAPABILITY_STATUS.unverified);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.judgeUnavailable);
  });

  it('an abstaining judge is unverified', async () => {
    const envelope = assertEnvelope(
      await reviewScope({ diff: CLEAN_DIFF, files: CLEAN_FILES, rubric: RUBRIC, judge: abstainingJudge(), taskId: 't1', runId: 'r1' }),
      'jev_review_scope',
    );
    assert.equal(envelope.status, CAPABILITY_STATUS.unverified);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.judgeAbstained);
  });

  it('an empty rubric is invalid input, not a clean review', async () => {
    const judge = uniformJudge(0.95);
    const envelope = assertEnvelope(
      await reviewScope({ diff: CLEAN_DIFF, files: CLEAN_FILES, rubric: { criteria: [] }, judge, taskId: 't1', runId: 'r1' }),
      'jev_review_scope',
    );
    assert.notEqual(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.invalidInput);
  });
});

describe('C4 review — a clean review', () => {
  it('succeeds with findings that carry evidence refs', async () => {
    const judge = uniformJudge(0.95);
    const envelope = assertEnvelope(
      await reviewScope({ diff: CLEAN_DIFF, files: CLEAN_FILES, rubric: RUBRIC, judge, model: 'jev-1.13.0', taskId: 't1', runId: 'r1' }),
      'jev_review_scope',
    );
    assert.equal(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.ok);
    assert.equal(envelope.model.used, true);
    assert.equal(envelope.decision.findings.length, 2);
    for (const finding of envelope.decision.findings) {
      assert.ok(Array.isArray(finding.evidenceRefs) && finding.evidenceRefs.length > 0, `${finding.criterionId}: a verdict must carry evidence refs`);
      assert.equal(finding.downgraded, false);
      assert.equal(finding.verdict, 'pass');
      assert.equal(finding.confidence, 0.95);
      assert.ok(typeof finding.note === 'string' && finding.note.length > 0);
    }
    assert.ok(typeof envelope.decision.materialDigest === 'string');
    assert.ok(typeof envelope.decision.rubricDigest === 'string');
    assert.equal(envelope.decision.materialChars, pinMaterial({ diff: CLEAN_DIFF, files: CLEAN_FILES }).chars);
    assertNoLaundering(envelope);
  });

  it('a failing verdict is a bounded judgment, not an autopatch', async () => {
    const judge = uniformJudge(0.05);
    const envelope = assertEnvelope(
      await reviewScope({ diff: CLEAN_DIFF, files: CLEAN_FILES, rubric: RUBRIC, judge, taskId: 't1', runId: 'r1' }),
      'jev_review_scope',
    );
    assert.equal(envelope.status, CAPABILITY_STATUS.success);
    assert.ok(envelope.decision.findings.every((f) => f.verdict === 'fail'));
    assert.ok(envelope.limits.some((limit) => /no autopatch/i.test(limit)));
    assert.ok(envelope.limits.some((limit) => /syntax, type and test checks are NOT performed here/i.test(limit)));
  });

  it('a probability inside the review band is review, not a pass', async () => {
    const judge = uniformJudge(0.5);
    const envelope = assertEnvelope(
      await reviewScope({ diff: CLEAN_DIFF, files: CLEAN_FILES, rubric: RUBRIC, judge, taskId: 't1', runId: 'r1' }),
      'jev_review_scope',
    );
    assert.ok(envelope.decision.findings.every((f) => f.verdict === 'review'));
    assert.ok(DEFAULT_THRESHOLDS.no < 0.5 && 0.5 < DEFAULT_THRESHOLDS.yes);
  });

  it('a file outside the declared scope is dropped and recorded, and the kept file is still reviewed', async () => {
    const judge = uniformJudge(0.95);
    const envelope = assertEnvelope(
      await reviewScope({
        diff: null,
        files: [...CLEAN_FILES, { path: 'outside/other.txt', content: 'never reviewed' }],
        rubric: RUBRIC,
        scope: ['src'],
        judge,
        taskId: 't1',
        runId: 'r1',
      }),
      'jev_review_scope',
    );
    assert.equal(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.decision.dropped.length, 1);
    assert.equal(envelope.decision.dropped[0].path, 'outside/other.txt');
    assert.equal(envelope.decision.dropped[0].reason, 'outside_scope');
    assert.ok(!JSON.stringify(judge.last).includes('never reviewed'), 'a dropped file must not reach the judge');
    assert.equal(envelope.decision.findings.length, 2);
  });

  it('no finding ever carries a line or lineNumber key', async () => {
    const judge = uniformJudge(0.95);
    const envelope = assertEnvelope(
      await reviewScope({
        diff: CLEAN_DIFF,
        files: CLEAN_FILES,
        rubric: { criteria: [{ id: 'r1', text: 'the constant is one', scope: ['src/one.txt'] }] },
        judge,
        taskId: 't1',
        runId: 'r1',
      }),
      'jev_review_scope',
    );
    assert.equal(envelope.status, CAPABILITY_STATUS.success);
    const finding = envelope.decision.findings[0];
    // The location is a path plus a verbatim fragment from the material, so the
    // main agent can check it against the source instead of trusting a number.
    assert.equal(finding.location.path, 'src/one.txt');
    assert.equal(finding.location.quote, 'export const one = 1;');
    assert.ok(finding.evidenceRefs.some((ref) => ref.startsWith('quote:')));
    const keys = collectKeys(envelope.decision);
    assert.ok(!keys.has('line'), 'a finding must never synthesise a line');
    assert.ok(!keys.has('lineNumber'), 'a finding must never synthesise a lineNumber');
  });

  it('the review question is a noul with instructions, one per criterion', () => {
    const questions = buildReviewQuestions({ rubric: RUBRIC, material: CLEAN_DIFF });
    assert.deepEqual(Object.keys(questions).sort(), ['r1', 'r2']);
    for (const question of Object.values(questions)) {
      assert.equal(question.type, 'noul');
      assert.notEqual(question.instructions, undefined, 'instructions is required — omitting it is the R3 defect');
      assert.ok(typeof question.instructions.evidence_ref === 'string');
    }
    assertWellFormedRequest({ state: {}, questions });
  });

  it('a malformed review question cannot reach the judge, so it cannot produce a success', async () => {
    assert.throws(() => assertWellFormedRequest({ state: {}, questions: { q: { type: 'noul', criteria: {} } } }), /instructions is required/);
  });
});
