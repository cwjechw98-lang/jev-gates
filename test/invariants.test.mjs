/**
 * Regression tests for the R1–R6 review findings.
 *
 * Each test names the finding it pins and states the expected behaviour, so a
 * future change that reintroduces the defect fails here by name rather than
 * silently passing a weaker suite. No network, no key, no command is executed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runGate } from '../scripts/jev-gate.mjs';
import { validateRequest } from '../lib/contracts.mjs';
import { buildQuestions, buildRequest, buildState, askJudge, JUDGE_STATUS } from '../lib/judge.mjs';
import { decideCompletion, STATUS, REASON } from '../lib/policy.mjs';
import { collectArtifact } from '../lib/collector.mjs';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');

const artifact = (over = {}) => ({
  observationId: 'obs-1',
  kind: 'artifact',
  runId: 'run-1',
  taskId: 'task-1',
  path: 'reports/out.md',
  existence: true,
  bytes: 100,
  coverage: 'full',
  sourceTrust: 'collector_observed',
  ...over,
});

// --- R1: provenance is a property of the channel, not of the field -----------

test('R1: an inline observation cannot award itself an independent trust level', async () => {
  const request = {
    schemaVersion: 2,
    taskId: 'task-1',
    runId: 'run-1',
    projectRoot: 'C:/nonexistent-audit-root',
    criteria: [
      {
        id: 'c1',
        text: 'the audit artifact exists',
        kind: 'deterministic',
        required: true,
        verificationScope: ['C:/nonexistent-audit-root'],
        evidenceRefs: ['obs-1'],
        check: { type: 'artifact_exists', ref: 'obs-1' },
      },
    ],
    observations: [
      artifact({
        path: 'C:/nonexistent-audit-root/missing.txt',
        sourceTrust: 'collector_observed',
        taskId: 'OTHER-task',
        runId: 'OTHER-run',
      }),
    ],
  };

  const parsed = validateRequest(request);
  assert.equal(parsed.ok, true, 'the shape is valid; it is the provenance that is refused');
  const inline = parsed.value.observations[0];
  assert.equal(inline.sourceTrust, 'self_reported', 'an inline observation is self-reported');
  assert.equal(inline.declaredSourceTrust, 'collector_observed', 'what it claimed is kept for the report');
  assert.equal(inline.trustDowngraded, true);

  const result = await runGate({ request, answers: {}, now: NOW });
  assert.notEqual(result.decision.status, STATUS.done, 'a self-assigned trust level must not confirm anything');
  assert.equal(result.decision.status, STATUS.unverified);
  assert.ok(
    result.decision.reasonCodes.some((r) => r.code === REASON.trustDowngraded),
    'the downgrade is reported, not silent',
  );
  assert.ok(result.decision.reasonCodes.some((r) => r.code === REASON.foreignObservation));
});

test('R1: evidence gathered for another task or run is rejected as foreign', async () => {
  const request = {
    schemaVersion: 2,
    taskId: 'task-1',
    runId: 'run-1',
    criteria: [
      {
        id: 'c1',
        text: 'the report is not empty',
        kind: 'deterministic',
        required: true,
        evidenceRefs: ['obs-1'],
        check: { type: 'artifact_nonempty', ref: 'obs-1' },
      },
    ],
  };
  // Delivered through the channel, so its declared trust survives — but it is
  // about a different run, and a well-formed fact about the wrong run is not
  // evidence for this one.
  const foreign = artifact({ taskId: 'OTHER', runId: 'run-1' });
  const result = await runGate({ request, observations: [foreign], answers: {}, now: NOW });

  assert.equal(result.decision.status, STATUS.unverified);
  assert.equal(result.decision.rows[0].decision, 'unverified');
  assert.deepEqual(result.decision.rows[0].foreignRefs, ['obs-1']);
  assert.ok(result.decision.reasonCodes.some((r) => r.code === REASON.foreignObservation));
});

test('R1: the out-of-band channel can confer trust, because code produced the value', async () => {
  const request = {
    schemaVersion: 2,
    taskId: 'task-1',
    runId: 'run-1',
    criteria: [
      {
        id: 'c1',
        text: 'the report is not empty',
        kind: 'deterministic',
        required: true,
        evidenceRefs: ['obs-1'],
        check: { type: 'artifact_nonempty', ref: 'obs-1' },
      },
    ],
  };
  const measured = artifact({ sourceTrust: 'collector_observed' });
  const result = await runGate({ request, observations: [measured], answers: {}, now: NOW });
  assert.equal(result.decision.status, STATUS.done);
  assert.equal(result.decision.sourceTrust, 'collector_observed');
});

test('R1: a fabricated artifact written into the request does not confirm the claim', async () => {
  const request = {
    schemaVersion: 2,
    taskId: 'task-1',
    runId: 'run-1',
    criteria: [
      {
        id: 'c1',
        text: 'the artifact exists',
        kind: 'deterministic',
        required: true,
        evidenceRefs: ['obs-1'],
        check: { type: 'artifact_exists', ref: 'obs-1' },
      },
    ],
    observations: [artifact({ sourceTrust: 'harness_observed' })],
  };
  const result = await runGate({ request, answers: {}, now: NOW });
  assert.equal(result.decision.status, STATUS.unverified);
  assert.ok(result.decision.reasonCodes.some((r) => r.code === REASON.selfReportedOnly));
});

test('R1: the collector is what makes an observation collector-observed', async () => {
  // The real collector, against a real temp file: this is the path that earns
  // the trust level, and the test proves the level comes from the code.
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'jev-collect-'));
  const file = join(dir, 'out.md');
  writeFileSync(file, '# report\n\nthe root cause was a stale cache key\n');

  const observation = await collectArtifact({
    path: file,
    runId: 'run-1',
    taskId: 'task-1',
    withExcerpt: true,
  });
  assert.equal(observation.sourceTrust, 'collector_observed');
  assert.equal(observation.origin, undefined, 'the collector does not tag an origin; it IS the origin');
  assert.equal(observation.existence, true);
  assert.equal(observation.coverage, 'full');
  assert.match(observation.excerpt, /stale cache key/);
  assert.equal(observation.excerptTruncated, false);
});

// --- R2: a semantic yes needs material ---------------------------------------

test('R2: a semantic yes with no evidence is unverified, not done', async () => {
  const request = {
    schemaVersion: 2,
    taskId: 'task-1',
    runId: 'run-1',
    criteria: [{ id: 'c1', text: 'Root cause fixed, not the symptom', kind: 'semantic', required: true, evidenceRefs: ['missing-obs'] }],
    observations: [],
  };
  const result = await runGate({ request, answers: { c1: { noul: 1 } }, now: NOW });

  assert.equal(result.decision.status, STATUS.unverified);
  const row = result.decision.rows[0];
  assert.equal(row.decision, 'unverified');
  assert.equal(row.supported, false);
  assert.equal(row.modelProbability, 1, 'the model answer is recorded, so the disagreement is visible');
  assert.ok(
    result.decision.reasonCodes.some((r) => r.code === REASON.unsupportedByEvidence),
    'the reason names why a confident yes was not enough',
  );
});

test('R2: a declared evidence reference that does not resolve cannot pass', async () => {
  const request = {
    schemaVersion: 2,
    taskId: 'task-1',
    runId: 'run-1',
    criteria: [{ id: 'c1', text: 'the fix is complete', kind: 'semantic', required: true, evidenceRefs: ['ghost'] }],
  };
  const result = await runGate({ request, answers: { c1: { noul: 0.99 } }, now: NOW });
  assert.equal(result.decision.status, STATUS.unverified);
  assert.equal(result.decision.rows[0].supported, false);
});

test('R2: a semantic yes with material passes, and the judge is given the material', async () => {
  const request = {
    schemaVersion: 2,
    taskId: 'task-1',
    runId: 'run-1',
    criteria: [
      { id: 'c1', text: 'the report names the root cause', kind: 'semantic', required: true, evidenceRefs: ['obs-1'] },
    ],
  };
  // Delivered through the channel, not written into the request: this is the
  // path that makes the evidence collector-observed rather than self-reported.
  const measured = artifact({ path: 'reports/out.md', excerpt: 'the root cause was a stale cache key' });
  let seenState = null;
  const result = await runGate({
    request,
    observations: [measured],
    now: NOW,
    judge: async ({ state }) => {
      seenState = state;
      return { status: JUDGE_STATUS.ok, answers: { c1: { noul: 0.9 } }, errors: [], usage: null };
    },
  });

  assert.equal(result.decision.status, STATUS.done);
  assert.equal(result.decision.rows[0].decision, 'pass');
  assert.equal(result.decision.rows[0].supported, true);

  const material = seenState.evidence.c1;
  assert.ok(material, 'the judge must receive the material, or the question is unanswerable');
  assert.equal(material.path, 'reports/out.md');
  assert.match(material.untrusted_evidence_c1, /<untrusted:evidence_c1>/);
  assert.match(material.untrusted_evidence_c1, /stale cache key/);
  assert.equal(material.sourceTrust, 'collector_observed');
});

test('R2: a criterion with no material is not turned into a question at all', () => {
  const criteria = [{ id: 'c1', text: 'is it good?', kind: 'semantic', required: true }];
  const questions = buildQuestions(criteria, [{ criterionId: 'c1', result: 'unknown', supported: false }]);
  assert.deepEqual(questions, {}, 'asking an unanswerable question spends a call and yields an unusable opinion');

  const supported = buildQuestions(criteria, [{ criterionId: 'c1', result: 'unknown', supported: true }]);
  assert.ok(supported.c1, 'with material it becomes a question');
});

// --- R3: the documented request contract -------------------------------------

test('R3: the request body matches the documented API contract', () => {
  const questions = buildQuestions(
    [{ id: 'c1', text: 'the fix is complete', kind: 'semantic', required: true }],
    [{ criterionId: 'c1', result: 'unknown', supported: true }],
  );
  const q = questions.c1;
  assert.equal(q.type, 'noul');
  assert.ok(q.instructions !== undefined && q.instructions !== null, 'instructions is required');
  assert.ok(q.criteria && typeof q.criteria === 'object' && !Array.isArray(q.criteria), 'a noul rubric is an object');
  assert.deepEqual(Object.keys(q.criteria).sort(), ['false', 'true']);
  assert.equal(q.text, undefined, 'the old text/options shape is gone');
  assert.equal(q.options, undefined);

  const body = buildRequest({ state: { taskId: 't' }, model: 'jev-1.13.0', questions });
  assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
});

test('R3: a malformed question is refused before a request is made', () => {
  assert.throws(
    () => buildRequest({ state: {}, questions: { c1: { type: 'noul', text: 'x', options: ['yes', 'no'] } } }),
    /instructions is required/,
  );
  assert.throws(() => buildRequest({ state: {}, questions: { c1: { type: 'noul', instructions: 'x', criteria: ['yes'] } } }), /noul criteria/);
  assert.throws(() => buildRequest({ state: {}, questions: { c1: { type: 'noul', instructions: 'x', criteria: { maybe: 'y' } } } }), /unexpected key/);
  assert.throws(() => buildRequest({ state: {}, questions: { c1: { type: 'nonsense', instructions: 'x' } } }), /unknown question type/);
});

test('R3: the body actually handed to the transport satisfies the contract', async () => {
  let sent = null;
  const transport = {
    async postJson(url, body) {
      sent = { url, body };
      return { ok: true, json: { answers: { c1: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 2 } } };
    },
  };
  const questions = buildQuestions(
    [{ id: 'c1', text: 'the fix is complete', kind: 'semantic', required: true }],
    [{ criterionId: 'c1', result: 'unknown', supported: true }],
  );
  const result = await askJudge({ state: { taskId: 't' }, questions, apiKey: 'test-key-not-real', transport });

  assert.equal(result.status, JUDGE_STATUS.ok);
  assert.equal(sent.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(sent.body.model, 'jev-1.13.0');
  assert.ok(sent.body.state, 'state is required');
  assert.ok(sent.body.questions.c1.instructions, 'instructions is required on every question');
  assert.ok(sent.body.questions.c1.criteria.true);
  // Nothing that looks like the old shape survives anywhere in the body.
  const serialized = JSON.stringify(sent.body);
  assert.doesNotMatch(serialized, /"options"/);
  assert.doesNotMatch(serialized, /"text":/);
});

test('R3: an unreachable judge is unverified, and a malformed body is never sent', async () => {
  let called = false;
  const result = await askJudge({
    state: {},
    questions: { c1: { type: 'noul', text: 'x', options: ['yes', 'no'] } },
    apiKey: 'test-key-not-real',
    transport: {
      async postJson() {
        called = true;
        return { ok: true, json: {} };
      },
    },
  });
  assert.equal(called, false, 'a body this code got wrong must not be sent to a paid endpoint');
  assert.equal(result.status, JUDGE_STATUS.abstained);
  assert.match(result.reason, /instructions is required/);
});

// --- R6: no pointless model call ---------------------------------------------

test('R6: a required deterministic failure stops the model lane', async () => {
  const request = {
    schemaVersion: 2,
    taskId: 'task-1',
    runId: 'run-1',
    criteria: [
      {
        id: 'hard',
        text: 'the tests pass',
        kind: 'deterministic',
        required: true,
        evidenceRefs: ['cmd-1'],
        check: { type: 'command_exit', ref: 'cmd-1', expectExit: 0 },
      },
      { id: 'soft', text: 'the work is complete', kind: 'semantic', required: true, evidenceRefs: ['cmd-1'] },
    ],
    observations: [
      {
        observationId: 'cmd-1',
        kind: 'command',
        runId: 'run-1',
        taskId: 'task-1',
        executable: 'npx',
        argv: ['vitest'],
        status: 'completed',
        exit: 1,
        coverage: 'full',
        sourceTrust: 'harness_observed',
      },
    ],
  };
  let calls = 0;
  const result = await runGate({
    request,
    now: NOW,
    judge: async () => {
      calls += 1;
      return { status: JUDGE_STATUS.ok, answers: { soft: { noul: 0.99 } }, errors: [], usage: null };
    },
  });
  assert.equal(calls, 0, 'a verdict already determined by code must not be bought');
  assert.equal(result.decision.status, STATUS.not_done);
  assert.equal(result.judge.status, JUDGE_STATUS.notRequested);
  assert.match(result.judge.reason, /already failed/);
  // The questions that would have been asked are still built and visible under
  // `--dry`: they document what the run skipped. What matters is that no answer
  // was obtained and none was used.
  assert.equal(result.judge.answers ? Object.keys(result.judge.answers).length : 0, 0);
});

test('R6: a dry run does not consult the judge and writes no journal entry', async () => {
  const request = {
    schemaVersion: 2,
    taskId: 'task-1',
    runId: 'run-1',
    criteria: [{ id: 'c1', text: 'is it complete?', kind: 'semantic', required: true, evidenceRefs: ['obs-1'] }],
    observations: [artifact()],
  };
  let calls = 0;
  const result = await runGate({
    request,
    now: NOW,
    dryRun: true,
    judge: async () => {
      calls += 1;
      return { status: JUDGE_STATUS.ok, answers: { c1: { noul: 1 } }, errors: [], usage: null };
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.judge.status, JUDGE_STATUS.notRequested);
  assert.match(result.judge.reason, /dry run/);
  // The question is still built and shown: a dry run is for reading the request.
  assert.ok(result.questions.c1);
});

test('R6: with nothing semantic to ask, the judge is not called', async () => {
  const request = {
    schemaVersion: 2,
    taskId: 'task-1',
    runId: 'run-1',
    criteria: [
      {
        id: 'c1',
        text: 'the report is not empty',
        kind: 'deterministic',
        required: true,
        evidenceRefs: ['obs-1'],
        check: { type: 'artifact_nonempty', ref: 'obs-1' },
      },
    ],
  };
  let calls = 0;
  const result = await runGate({
    request,
    observations: [artifact()],
    now: NOW,
    judge: async () => {
      calls += 1;
      return { status: JUDGE_STATUS.ok, answers: {}, errors: [], usage: null };
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.decision.status, STATUS.done);
});

// --- R4: one safe credential path, for every public entry --------------------

test('R4: an unrelated YAML file is refused, never returned whole as the key', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const base = mkdtempSync(join(tmpdir(), 'jev-cred-'));
  const gates = join(base, 'gates');
  const user = join(base, 'user');
  mkdirSync(gates, { recursive: true });
  mkdirSync(user, { recursive: true });
  // A credentials file that does not contain the key we want. The old client fell
  // back to the whole file here, so a YAML document became the bearer token.
  writeFileSync(
    join(gates, 'key'),
    ['version: 1', 'refs:', '  DEEPSEEK_API_KEY: sk-synthetic-deepseek-000000000000', '  OPENROUTER_API_KEY: sk-or-synthetic-0000000000000000', ''].join('\n'),
  );

  const { apiKey } = await import('../scripts/jev.mjs');
  assert.throws(() => apiKey({ homeDir: gates, userHome: user }), /no API key/, 'a YAML document is not a key');
});

test('R4: the legacy client and the gate share one resolver, so the fix cannot be bypassed', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const source = readFileSync(join(root, 'scripts', 'jev.mjs'), 'utf8');

  assert.match(source, /import \{ resolveApiKey \} from '\.\.\/lib\/credentials\.mjs'/, 'the legacy client must use the shared resolver');
  // The pattern that caused the defect: a raw-file fallback when the YAML match fails.
  assert.doesNotMatch(source, /yaml \? yaml\[1\] : raw/, 'the raw-file fallback is gone');
  // Scoped to the key resolver: reading the experience journal is not reading a
  // credential, and a blanket ban on readFileSync would forbid both.
  const keyFn = source.slice(source.indexOf('export function apiKey('), source.indexOf('const sleep ='));
  assert.ok(keyFn.length > 0, 'apiKey is still defined');
  assert.doesNotMatch(keyFn, /readFileSync/, 'the key resolver no longer reads credential files itself');

  // Every public entry that can reach the network resolves the key the same way.
  const evals = readFileSync(join(root, 'scripts', 'jev-evals.mjs'), 'utf8');
  assert.match(evals, /import \{ ask \} from '\.\/jev\.mjs'/, 'evals go through the same client');
  const gate = readFileSync(join(root, 'scripts', 'jev-gate.mjs'), 'utf8');
  assert.match(gate, /from '\.\.\/lib\/judge\.mjs'/, 'the gate uses the judge module, which uses the same resolver');
});

test('R4: the legacy client validates the request body before sending it', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const source = readFileSync(join(root, 'scripts', 'jev.mjs'), 'utf8');
  assert.match(source, /buildRequest\(\{ state, model, questions \}\)/, 'the body is built by the shared builder');
  assert.doesNotMatch(source, /JSON\.stringify\(\{ state, model, questions \}\)/, 'the unchecked literal body is gone');
});

// --- The policy stays pure: the same inputs still give the same verdict ------

test('R2: an unsupported semantic criterion is unverified even when the model says no', () => {
  const request = {
    criteria: [{ id: 'c1', text: 'x', kind: 'semantic', required: true }],
  };
  const decision = decideCompletion({
    request,
    criterionFacts: [{ criterionId: 'c1', result: 'unknown', supported: false, refs: [], sourceTrust: null, coverage: 'unknown' }],
    answers: { c1: { value: 0.01 } },
    thresholds: { no: 0.2, yes: 0.8, calibrated: true },
  });
  // An unfounded "no" is no more a fact than an unfounded "yes": both are the
  // model's opinion, and the honest answer without evidence is that we do not know.
  assert.equal(decision.status, STATUS.unverified);
  assert.equal(decision.rows[0].modelVerdict, 'no');
});
