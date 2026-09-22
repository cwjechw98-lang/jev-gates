/**
 * Semantic scope review — capability C4, `jev_review_scope` (spec §14.3).
 *
 * The reviewer answers a narrow question per rubric criterion about material
 * that was pinned before the question was asked. It is deliberately the weakest
 * kind of instrument in this project, and the module is written so that its
 * weakness is visible rather than papered over:
 *
 *   - **Missing material is never a yes.** No material, a mismatched snapshot, or
 *     a required part that had to be cut is `unverified`, never `success`. The
 *     reason codes say which of the three happened.
 *   - **No invented line numbers.** Nothing here synthesises a `line` or
 *     `lineNumber`. A finding that needs a location carries the file path and a
 *     verbatim fragment quoted out of the material, so the main agent can check
 *     it against the real source instead of trusting a number a model guessed.
 *   - **No autopatches.** The output is a signal. Declaring a defect requires the
 *     main agent to verify the fragment against the source, and `limits` says so
 *     on every envelope.
 *   - **Deterministic checks are not this module's job.** Syntax, types and tests
 *     are decided by tools that can actually run them. A probability is a worse
 *     answer than a fact, so this module does not attempt one.
 *
 * The distinction between `fail` and `unverified` is the one that matters to a
 * reader: `fail` means the judge read the material and the criterion did not
 * hold; `unverified` means nothing was established, which is not a prohibition.
 */
import { readFileSync } from 'node:fs';

import {
  CAPABILITY_REASON,
  CAPABILITY_STATUS,
  capabilityEnvelope,
  modelLane,
  snapshotIdentity,
  withBudget,
} from './capability.mjs';
import { digestJson, digestText, isWithinScope, joinPath, normalizePath } from './evidence.mjs';
import { DEFAULT_THRESHOLDS, decideFromProbability } from './policy.mjs';
import { buildRequest, buildState, JUDGE_STATUS, wrapUntrusted } from './judge.mjs';

/** Per-capability implementation version, reported so a journal row can be reproduced. */
export const REVIEW_VERSION = '1.0.0';

/** Bounded judgments. `unverified` is an answer: it says nothing was established. */
export const REVIEW_VERDICT = Object.freeze({
  pass: 'pass',
  fail: 'fail',
  review: 'review',
  unverified: 'unverified',
});

/** The criterion id the pinned material is carried under in the judge state. */
export const MATERIAL_CRITERION_ID = 'material';

/** How much of a quoted fragment travels with a finding. Enough to locate, not to paste a file. */
export const QUOTE_MAX_CHARS = 160;

/** Files whose content arrives as anything other than a string. */
function contentOf(file) {
  if (typeof file?.content === 'string') return file.content;
  if (typeof file?.text === 'string') return file.text;
  return '';
}

/**
 * Resolve one file entry to `{ path, content, unreadable }`.
 *
 * Two shapes are accepted because both are honest and both are in use: a
 * `{path, content}` pair, where the caller already pinned the text, and a bare
 * path, which the harness reads here. Reading from disk is what makes the
 * capability usable through an adapter that only knows paths; when it fails the
 * entry is recorded as dropped, never quietly reviewed as empty.
 */
function resolveFile(file, { projectRoot = null } = {}) {
  if (typeof file === 'string') {
    const path = file;
    if (path === '') return { path: null, content: '', unreadable: 'a file entry arrived without a path' };
    const resolved = joinPath(projectRoot, path);
    try {
      return { path, content: readFileSync(resolved, 'utf8'), unreadable: null };
    } catch (error) {
      return { path, content: '', unreadable: `cannot read ${resolved}: ${error.message}` };
    }
  }
  const path = typeof file?.path === 'string' ? file.path : '';
  if (path === '') return { path: null, content: '', unreadable: 'a file entry arrived without a path' };
  const content = contentOf(file);
  if (content === '') return { path, content: '', unreadable: 'the file entry carried no content and no readable path' };
  return { path, content, unreadable: null };
}

/** A deterministic, readable block. Order is the caller's order, never a sort. */
function block(kind, label, text) {
  return `----- ${kind}: ${label} -----\n${text}`;
}

/**
 * Pin the material a review will be about.
 *
 * Pinning is the point: the digest is over the exact text handed to the judge,
 * so a later reader can tell whether the review covered what they are looking at.
 * Files outside the declared scope are dropped rather than reviewed — a review
 * that silently widens its scope is a review nobody can reason about — and a
 * dropped or truncated part is *recorded*, because "we did not see this" is a
 * fact the caller needs.
 *
 * @param {object} input
 * @param {string} [input.diff] - the pinned diff.
 * @param {object[]} [input.files] - `{ path, content }` pairs or bare paths, in reading order.
 * @param {string[]} [input.scope] - allowed paths or path prefixes. Empty means "no scope declared".
 * @param {number} [input.maxChars] - the character budget.
 * @param {string|null} [input.projectRoot] - resolved against when a file entry is a bare path.
 * @param {string} [input.source] - where the material came from, for the trust boundary.
 * @returns {{ material: string, truncated: boolean, dropped: object[], droppedFiles: string[], chars: number, digest: string, truncatedReason: string|null, filesIncluded: string[], maxChars: number }}
 */
export function pinMaterial({ diff = null, files = [], scope = [], maxChars = 20_000, projectRoot = null, source = 'review.pinMaterial' } = {}) {
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 20_000;
  const dropped = [];
  const blocks = [];

  if (typeof diff === 'string' && diff.length > 0) {
    blocks.push(block('diff', 'pinned', diff));
  }

  for (const file of Array.isArray(files) ? files : []) {
    const resolved = resolveFile(file, { projectRoot });
    const path = resolved.path;
    if (path === null) {
      dropped.push({ path: null, reason: 'invalid_path', detail: resolved.unreadable });
      continue;
    }
    // Scope is checked before the content is looked at: an out-of-scope file is
    // not material, so there is nothing to measure or truncate.
    if (!isWithinScope(path, scope)) {
      dropped.push({ path, reason: 'outside_scope', detail: 'the file is not inside the declared review scope' });
      continue;
    }
    if (resolved.unreadable !== null) {
      dropped.push({ path, reason: 'unreadable', detail: resolved.unreadable });
      continue;
    }
    blocks.push(block('file', path, resolved.content));
  }

  const full = blocks.join('\n\n');
  const truncated = full.length > budget;
  const material = truncated ? full.slice(0, budget) : full;

  if (truncated) {
    dropped.push({
      path: null,
      reason: 'over_budget',
      detail: `${full.length - budget} character(s) were cut from the end of the material`,
    });
  }

  const droppedFiles = [...new Set(dropped.map((entry) => entry.path).filter((path) => typeof path === 'string'))];
  const filesIncluded = (Array.isArray(files) ? files : [])
    .map((file) => (typeof file === 'string' ? file : typeof file?.path === 'string' ? file.path : null))
    .filter((path) => path !== null && !droppedFiles.includes(path));

  const truncatedReason = truncated
    ? `the material was ${full.length} characters and only ${budget} fit`
    : droppedFiles.length > 0
      ? `${droppedFiles.length} file(s) were dropped`
      : null;

  // The digest covers the material AND what was left out, so two reviews that
  // saw different things cannot share an identity.
  const digest = `sha256:${digestJson({
    material,
    truncated,
    dropped: dropped.map((entry) => `${entry.reason}:${entry.path ?? ''}`),
    maxChars: budget,
  })}`;

  return {
    material,
    truncated,
    dropped,
    droppedFiles,
    filesIncluded,
    chars: material.length,
    digest,
    truncatedReason,
    maxChars: budget,
    source,
  };
}

/** The snapshot the review is pinned to, derived from the material it actually used. */
export function reviewSnapshot(pinned, { source = 'review.pinMaterial', capturedAt } = {}) {
  return snapshotIdentity(
    { materialDigest: pinned.digest, materialChars: String(pinned.chars), truncated: String(pinned.truncated === true) },
    { source, capturedAt },
  );
}

/**
 * The rubric's criteria as a flat list, without inventing any.
 *
 * A rubric is the caller's; this module does not complete it, reorder it or
 * rewrite it. A criterion with no id is given a positional one so the finding
 * can still be keyed, and that substitution is visible in the id itself.
 */
function rubricCriteria(rubric) {
  const raw = Array.isArray(rubric) ? rubric : Array.isArray(rubric?.criteria) ? rubric.criteria : [];
  return raw
    .filter((criterion) => criterion !== null && typeof criterion === 'object')
    .map((criterion, index) => ({
      id: typeof criterion.id === 'string' && criterion.id.length > 0 ? criterion.id : `criterion_${index + 1}`,
      text: typeof criterion.text === 'string' ? criterion.text : typeof criterion.description === 'string' ? criterion.description : '',
      required: criterion.required !== false,
      scope: Array.isArray(criterion.scope) ? criterion.scope : [],
    }));
}

/** The rubric digest, which is what makes a cached review invalid. */
export function rubricIdentity(rubric) {
  const criteria = rubricCriteria(rubric);
  return {
    digest: `sha256:${digestJson(criteria.map((c) => ({ id: c.id, text: c.text, required: c.required })))}`,
    criteria,
  };
}

/**
 * The first line of material that a criterion's path can be checked against.
 *
 * This is the honest alternative to a line number: it is copied verbatim out of
 * the material that was pinned, so it either appears in the source or it does
 * not. Nothing is normalised, numbered or reconstructed.
 */
export function quoteFragment(material, { path = null, maxChars = QUOTE_MAX_CHARS } = {}) {
  const text = typeof material === 'string' ? material : '';
  if (text === '') return null;
  const header = typeof path === 'string' && path !== '' ? block('file', path, '') : null;
  const start = header === null ? -1 : text.indexOf(header);
  const region = header === null || start === -1 ? text : text.slice(start + header.length);
  for (const line of region.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('-----')) continue;
    return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
  }
  return null;
}

/**
 * One `noul` question per rubric criterion.
 *
 * `instructions` is required by the endpoint for every question type; omitting
 * it is the known R3 defect, so it is always present. The material is referenced
 * by the path the state carries rather than inlined per criterion, so a rubric
 * with ten criteria does not pay for the same diff ten times.
 *
 * @param {object} input
 * @param {object|object[]} input.rubric - the narrow rubric.
 * @param {string} input.material - the pinned material.
 * @param {string} [input.materialPath] - where the state carries it.
 * @returns {Record<string, object>} a questions map, ready for `askJudge`.
 */
export function buildReviewQuestions({ rubric, material, materialPath = `state.evidence.${MATERIAL_CRITERION_ID}` } = {}) {
  const questions = {};
  const body = typeof material === 'string' ? material : '';
  for (const criterion of rubricCriteria(rubric)) {
    const wrapped = wrapUntrusted(`criterion_${criterion.id}`, criterion.text);
    questions[criterion.id] = {
      type: 'noul',
      instructions: {
        question: 'Does the pinned material show that this criterion holds?',
        criterion: wrapped[`untrusted_criterion_${criterion.id}`],
        evidence_ref: materialPath,
        rules: [
          'Answer from the material given, and from nothing else.',
          'Say yes only if the material itself shows the criterion holds.',
          'If the material does not show it, or does not cover it, the answer is no.',
        ],
      },
      criteria: {
        true: 'The material shows the criterion holds.',
        false: 'The material does not show the criterion holds, or does not cover it.',
      },
    };
  }
  return questions;
}

/** Read a probability out of whichever answer shape arrived. */
function probabilityOf(answer) {
  if (!answer || typeof answer !== 'object') return null;
  if (typeof answer.noul === 'number') return answer.noul;
  if (typeof answer.value === 'number') return answer.value;
  return null;
}

/**
 * Translate the policy's probability verdict into this capability's vocabulary.
 *
 * `lib/policy.mjs` answers `yes`/`no`; a review finding answers `pass`/`fail`.
 * They are the same decision with different words, and mapping in one place is
 * what stops a reader from comparing a finding against the wrong scale. A
 * probability that is not a usable number stays `unverified` — it is not a
 * failure, it is the absence of a judgment.
 */
function verdictFromProbability(probability) {
  if (probability === null) return REVIEW_VERDICT.unverified;
  const decision = decideFromProbability(probability, DEFAULT_THRESHOLDS);
  if (decision === 'yes') return REVIEW_VERDICT.pass;
  if (decision === 'no') return REVIEW_VERDICT.fail;
  if (decision === 'review') return REVIEW_VERDICT.review;
  return REVIEW_VERDICT.unverified;
}

/**
 * Review a pinned scope against a narrow rubric.
 *
 * @param {object} input
 * @param {string} [input.diff] - the pinned diff.
 * @param {object[]} [input.files] - `{ path, content }` pairs or bare paths.
 * @param {object|object[]} [input.rubric] - the criteria to judge.
 * @param {object|string|null} [input.snapshot] - the pinned snapshot, or its digest.
 * @param {string[]} [input.scope] - the declared review scope.
 * @param {string|null} [input.projectRoot] - resolved against when a file entry is a bare path.
 * @param {object|null} [input.judge] - the model lane; `null` means no judge is configured.
 * @param {Function} [input.judge.ask] - async `{state, questions}` -> `{status, answers, ...}`.
 * @param {object[]} [input.evidence] - related evidence refs `{ ref, trust }`.
 * @param {string} [input.model] - the model id, for the record.
 * @param {number} [input.maxChars] - the character budget for the material.
 * @param {number} [input.timeoutMs] - wall-clock budget for the judge.
 * @param {AbortSignal} [input.signal] - outer cancellation.
 * @param {string} [input.taskId] - required by the envelope.
 * @param {string} [input.runId] - required by the envelope.
 * @returns {Promise<object>} a capability envelope; `decision.findings` carries one bounded judgment per criterion.
 */
export async function reviewScope({
  diff = null,
  files = [],
  rubric = null,
  snapshot = null,
  scope = [],
  judge = null,
  evidence = [],
  model = null,
  maxChars = 20_000,
  projectRoot = null,
  timeoutMs = 20_000,
  signal,
  taskId = 'task',
  runId = 'run',
} = {}) {
  const pinned = pinMaterial({ diff, files, scope, maxChars, projectRoot });
  const snapshotIdentityValue = reviewSnapshot(pinned);
  const rubricInfo = rubricIdentity(rubric);

  // The material is the only thing this capability can stand on, so its
  // presence is checked first: everything below is about material that exists.
  const materialEvidence = [
    {
      ref: `material:${pinned.digest}`,
      trust: 'harness_observed',
      note: `${pinned.chars} character(s) pinned from ${pinned.filesIncluded.length} file(s); truncated=${pinned.truncated}`,
    },
    ...(Array.isArray(evidence) ? evidence : []),
  ];

  const baseDecision = {
    findings: [],
    rubricDigest: rubricInfo.digest,
    materialDigest: pinned.digest,
    materialChars: pinned.chars,
    truncated: pinned.truncated,
    dropped: pinned.dropped,
  };

  const limits = [
    'this is a SIGNAL for the main agent to verify against the real source, not a verdict about the code',
    'declaring a defect requires the main agent to check the quoted fragment against the actual file',
    'no line numbers are produced: a finding carries a path and a verbatim fragment, never an invented location',
    'no autopatch is produced and none is implied',
    'syntax, type and test checks are NOT performed here: they belong to tools that can run them',
    'the judge sees only the pinned material; anything dropped or truncated was not reviewed',
    'the thresholds used to turn a probability into a verdict are uncalibrated on this task',
  ];
  const envelopeBase = {
    taskId,
    runId,
    snapshot: snapshotIdentityValue,
    capabilityVersion: REVIEW_VERSION,
    capability: 'jev_review_scope',
    evidence: materialEvidence,
    limits,
  };

  /** Every non-success return shares this shape, so a reader sees the decision it did not get. */
  const failure = (status, code, message, extra = {}) =>
    capabilityEnvelope({
      ...envelopeBase,
      status,
      code,
      message,
      decision: { ...baseDecision, ...extra },
      model: modelLane({ requested: false, used: false, note: null }),
    });

  if (rubricInfo.criteria.length === 0) {
    return failure(
      CAPABILITY_STATUS.unverified,
      CAPABILITY_REASON.invalidInput,
      'the rubric has no criteria, so there is nothing to review',
    );
  }
  if (pinned.material.length === 0) {
    return failure(
      CAPABILITY_STATUS.unverified,
      CAPABILITY_REASON.missingMaterial,
      'no material was pinned, so nothing can be reviewed',
    );
  }
  if (snapshot !== null && snapshot !== undefined) {
    const declared = typeof snapshot === 'string' ? snapshot : snapshot.digest;
    if (typeof declared === 'string' && declared.length > 0 && declared !== snapshotIdentityValue.digest) {
      return failure(
        CAPABILITY_STATUS.unverified,
        CAPABILITY_REASON.snapshotMismatch,
        'the declared snapshot does not match the material that was pinned',
        { declaredSnapshot: declared, computedSnapshot: snapshotIdentityValue.digest },
      );
    }
  }
  // A required part that had to be cut is exactly the case the spec names: the
  // reviewer did not see it, so it cannot report a success about it.
  if (pinned.truncated) {
    return failure(
      CAPABILITY_STATUS.unverified,
      CAPABILITY_REASON.truncatedMaterial,
      `the material exceeded ${pinned.maxChars} characters and was cut, so the review is incomplete`,
      { truncatedReason: pinned.truncatedReason },
    );
  }

  const criteria = rubricInfo.criteria;
  const questions = buildReviewQuestions({ rubric, material: pinned.material });
  const wrapped = wrapUntrusted('material', pinned.material, Math.max(pinned.maxChars, pinned.material.length));

  const facts = criteria.map((criterion) => ({
    criterionId: criterion.id,
    result: 'unknown',
    reasonCode: CAPABILITY_REASON.ok,
    sourceTrust: 'harness_observed',
    coverage: 'full',
    supported: true,
    material: { kind: 'artifact', path: criterion.scope[0] ?? null, sourceTrust: 'harness_observed', coverage: 'full', excerpt: pinned.material },
  }));

  const state = buildState(
    { taskId, runId, mode: 'scope_review', claims: { task: `review against ${criteria.length} criterion(s)` } },
    facts,
  );
  state.material = {
    digest: pinned.digest,
    chars: pinned.chars,
    truncated: false,
    files: pinned.filesIncluded,
    dropped: pinned.dropped,
  };
  state.evidence = state.evidence ?? {};
  state.evidence[MATERIAL_CRITERION_ID] = {
    kind: 'material',
    digest: pinned.digest,
    chars: pinned.chars,
    files: pinned.filesIncluded,
    ...wrapped,
  };

  if (typeof judge?.ask !== 'function') {
    return failure(
      CAPABILITY_STATUS.unverified,
      CAPABILITY_REASON.judgeUnavailable,
      'no judge is available, so no criterion could be judged',
    );
  }

  let outcome;
  try {
    buildRequest({ state, model: model ?? undefined, questions });
    outcome = await withBudget(
      () => judge.ask({ state, questions, model: model ?? undefined }),
      { timeoutMs, signal },
    );
  } catch (error) {
    return capabilityEnvelope({
      ...envelopeBase,
      status: CAPABILITY_STATUS.unverified,
      code: CAPABILITY_REASON.judgeError,
      message: `the judge request could not be built: ${String(error?.message ?? error)}`,
      decision: baseDecision,
      model: modelLane({ requested: true, used: false, status: JUDGE_STATUS.abstained, note: 'the request was malformed and was never sent' }),
    });
  }

  if (!outcome.ok) {
    const code =
      outcome.code === CAPABILITY_REASON.timeout || outcome.code === CAPABILITY_REASON.cancelled
        ? outcome.code
        : CAPABILITY_REASON.judgeUnavailable;
    return capabilityEnvelope({
      ...envelopeBase,
      status: CAPABILITY_STATUS.unverified,
      code,
      message: `the judge lane failed: ${outcome.message}`,
      decision: baseDecision,
      model: modelLane({ requested: true, used: false, status: JUDGE_STATUS.unavailable, note: outcome.code }),
    });
  }

  const answer = outcome.value ?? {};
  if (answer.status === JUDGE_STATUS.unavailable) {
    return capabilityEnvelope({
      ...envelopeBase,
      status: CAPABILITY_STATUS.unverified,
      code: CAPABILITY_REASON.judgeUnavailable,
      message: `the judge was unreachable: ${answer.reason ?? 'no reason given'}`,
      decision: baseDecision,
      model: modelLane({ requested: true, used: false, status: JUDGE_STATUS.unavailable, model, note: answer.reason ?? null }),
    });
  }
  if (answer.status === JUDGE_STATUS.abstained) {
    return capabilityEnvelope({
      ...envelopeBase,
      status: CAPABILITY_STATUS.unverified,
      code: CAPABILITY_REASON.judgeAbstained,
      message: `the judge did not answer: ${answer.reason ?? 'no reason given'}`,
      decision: baseDecision,
      model: modelLane({ requested: true, used: false, status: JUDGE_STATUS.abstained, model, note: answer.reason ?? null }),
    });
  }
  if (answer.status !== JUDGE_STATUS.ok) {
    return capabilityEnvelope({
      ...envelopeBase,
      status: CAPABILITY_STATUS.unverified,
      code: CAPABILITY_REASON.judgeError,
      message: `the judge returned an unusable status: ${JSON.stringify(answer.status)}`,
      decision: baseDecision,
      model: modelLane({ requested: true, used: false, status: answer.status ?? null, model, note: 'unusable status' }),
    });
  }

  const answers = answer.answers && typeof answer.answers === 'object' ? answer.answers : {};
  const findings = criteria.map((criterion) => {
    const raw = answers[criterion.id];
    const probability = probabilityOf(raw);
    const verdict = verdictFromProbability(probability);

    // The reference is the criterion's own scope when it declared one, and the
    // pinned material otherwise: a finding with no reference is a confident
    // statement with nothing behind it, which this module must not emit.
    const path = criterion.scope.length > 0 ? criterion.scope[0] : null;
    const evidenceRefs = [`material:${pinned.digest}`];
    if (path !== null) evidenceRefs.push(`scope:${normalizePath(path)}`);
    const quote = quoteFragment(pinned.material, { path });
    if (quote !== null) evidenceRefs.push(`quote:${digestText(quote).slice(0, 16)}`);

    const note = probability === null
      ? 'the judge returned no readable probability for this criterion'
      : `p=${probability} -> ${verdict} (thresholds yes>=${DEFAULT_THRESHOLDS.yes}, no<=${DEFAULT_THRESHOLDS.no}, uncalibrated)`;

    return {
      criterionId: criterion.id,
      verdict,
      confidence: probability,
      evidenceRefs,
      // A path plus a verbatim fragment: enough for the main agent to locate the
      // claim in the source, and not a line number this module would have guessed.
      location: { path, quote },
      downgraded: evidenceRefs.length === 0,
      note: raw?.note ? `${note}; judge: ${raw.note}` : note,
    };
  });

  return capabilityEnvelope({
    ...envelopeBase,
    status: CAPABILITY_STATUS.success,
    code: CAPABILITY_REASON.ok,
    message: `${findings.length} criterion(s) judged against ${pinned.chars} character(s) of pinned material`,
    decision: { ...baseDecision, findings },
    model: modelLane({ requested: true, used: true, status: answer.status, model, note: null }),
  });
}
