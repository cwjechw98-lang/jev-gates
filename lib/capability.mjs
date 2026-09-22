/**
 * The cross-cutting contract every capability shares.
 *
 * The technical spec's §4 asks for one shape rather than five dialects: the same
 * identity fields, the same status vocabulary, the same reason codes, the same
 * snapshot pinning, and one journal. This module is that shape. A capability
 * module decides *what* to say; this module decides *how* it is said, so a new
 * capability cannot quietly invent a sixth status or a private reason string.
 *
 * Two rules are enforced here rather than left to discipline:
 *
 * 1. **A capability never grants permission.** `actionAuthority` is always
 *    `'none'`. The approval gate is a separate component with its own exit codes;
 *    a routing or review opinion must never be readable as an authorisation.
 * 2. **A model opinion never raises the trust of the evidence it was given.**
 *    `model.used` and `evidence[].trust` are separate fields, and
 *    `assertNoTrustLaundering` refuses to build an envelope where a semantic
 *    verdict has promoted a self-reported fact.
 */
import { createHash } from 'node:crypto';

import { EVIDENCE_REASON } from './evidence.mjs';
import { REASON } from './policy.mjs';

/** Envelope shape version. Bumped when a field changes meaning, not when one is added. */
export const ENVELOPE_VERSION = 3;

/** Per-capability implementation version, reported so a journal row can be reproduced. */
export const CAPABILITY_VERSION = '1.0.0';

/**
 * The status vocabulary. These describe the *answer*, never the *action*:
 * `success` means the capability reached a verdict, not that anything is allowed.
 */
export const CAPABILITY_STATUS = Object.freeze({
  success: 'success',
  abstain: 'abstain',
  unverified: 'unverified',
  error: 'error',
});

/** The statuses, for validation. */
export const CAPABILITY_STATUSES = Object.freeze(Object.values(CAPABILITY_STATUS));

/**
 * How a capability is allowed to act in a session.
 * - `off` — not registered at all;
 * - `advisory` — returns an opinion; the agent decides;
 * - `shadow` — computes and records the opinion, and the caller ignores it.
 * None of them is an enforcement mode: enforcement belongs to the approval gate.
 */
export const CAPABILITY_MODE = Object.freeze({ off: 'off', advisory: 'advisory', shadow: 'shadow' });
export const CAPABILITY_MODES = Object.freeze(Object.values(CAPABILITY_MODE));

/**
 * Reason codes shared by the capabilities.
 *
 * This is deliberately a *union*, not a second dialect. The completion gate
 * already publishes `REASON` (`lib/policy.mjs`) and the evidence resolver
 * publishes `EVIDENCE_REASON` (`lib/evidence.mjs`); those codes are re-exported
 * here so a capability says `evidence_stale` and means exactly what the gate
 * means by it. Only codes that genuinely belong to a new capability are new.
 */
export const CAPABILITY_REASON = Object.freeze({
  // reused verbatim — the gate's own vocabulary
  evidenceStale: REASON.evidenceStale,
  evidenceScopeMismatch: REASON.evidenceScopeMismatch,
  evidencePartial: REASON.evidencePartial,
  trustDowngraded: REASON.trustDowngraded,
  unsupportedByEvidence: REASON.unsupportedByEvidence,
  foreignObservation: REASON.foreignObservation,
  judgeUnavailable: REASON.judgeUnavailable,
  judgeAbstained: REASON.judgeAbstained,
  answerInvalid: REASON.answerInvalid,
  thresholdsUncalibrated: REASON.thresholdsUncalibrated,
  requiredUnknown: REASON.requiredUnknown,
  requiredFailed: REASON.requiredFailed,
  schemaInvalid: REASON.schemaInvalid,
  // reused from the evidence resolver
  evidenceMissing: EVIDENCE_REASON.noObservation,
  provenanceUnavailable: EVIDENCE_REASON.provenanceUnavailable,
  artifactMissing: EVIDENCE_REASON.artifactMissing,

  // new: the shared answer status of a capability
  ok: 'ok',
  // new: input problems a capability can have that the gate cannot
  invalidInput: 'invalid_input',
  missingMaterial: 'missing_material',
  truncatedMaterial: 'truncated_material',
  snapshotMismatch: 'snapshot_mismatch',
  emptyCatalog: 'empty_catalog',
  // new: the model lane
  judgeError: 'judge_error',
  judgeLowConfidence: 'judge_low_confidence',
  degenerateRun: 'degenerate_run',
  modelNotRequested: 'model_not_requested',
  // new: capability outcomes
  noCandidate: 'no_candidate',
  explicitChoice: 'explicit_choice',
  abstained: 'abstained',
  repeatedWithoutProgress: 'repeated_without_progress',
  progressObserved: 'progress_observed',
  criterionFailed: 'criterion_failed',
  contextBudgetExceeded: 'context_budget_exceeded',
  // new: budget and cancellation
  timeout: 'timeout',
  cancelled: 'cancelled',
  budgetExhausted: 'budget_exhausted',
  internalError: 'internal_error',
});

/**
 * Every reason code a capability envelope may carry: the union of this module's
 * codes, the gate's, and the evidence resolver's. An envelope is validated
 * against this set so an unknown code fails loudly instead of reaching a journal
 * as an uninterpretable string.
 */
export const ALL_REASON_CODES = Object.freeze([
  ...new Set([...Object.values(CAPABILITY_REASON), ...Object.values(REASON), ...Object.values(EVIDENCE_REASON)]),
]);

/** Which reason codes mean the capability could not reach a verdict. */
const NON_SUCCESS_REASONS = new Set([
  CAPABILITY_REASON.invalidInput,
  CAPABILITY_REASON.missingMaterial,
  CAPABILITY_REASON.truncatedMaterial,
  CAPABILITY_REASON.snapshotMismatch,
  CAPABILITY_REASON.judgeError,
  CAPABILITY_REASON.judgeUnavailable,
  CAPABILITY_REASON.degenerateRun,
  CAPABILITY_REASON.timeout,
  CAPABILITY_REASON.cancelled,
  CAPABILITY_REASON.budgetExhausted,
  CAPABILITY_REASON.internalError,
  CAPABILITY_REASON.contextBudgetExceeded,
  CAPABILITY_REASON.provenanceUnavailable,
  CAPABILITY_REASON.evidenceMissing,
  CAPABILITY_REASON.requiredUnknown,
]);

/** A structured failure a capability body can throw to produce a typed envelope. */
export class CapabilityError extends Error {
  /**
   * @param {string} code - one of {@link CAPABILITY_REASON}.
   * @param {string} message - human-readable detail.
   * @param {object} [details] - extra machine-readable context.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CapabilityError';
    this.code = code;
    this.details = details;
  }
}

/** Fail loudly on a malformed envelope rather than emitting a shape nobody can parse. */
function assertEnvelope(envelope) {
  if (!CAPABILITY_STATUSES.includes(envelope.status)) {
    throw new CapabilityError(CAPABILITY_REASON.internalError, `unknown status ${JSON.stringify(envelope.status)}`);
  }
  if (!ALL_REASON_CODES.includes(envelope.reason.code)) {
    throw new CapabilityError(CAPABILITY_REASON.internalError, `unknown reason code ${JSON.stringify(envelope.reason.code)}`);
  }
  if (envelope.status === CAPABILITY_STATUS.success && NON_SUCCESS_REASONS.has(envelope.reason.code)) {
    throw new CapabilityError(CAPABILITY_REASON.internalError, `status success contradicts reason ${envelope.reason.code}`);
  }
  if (typeof envelope.taskId !== 'string' || envelope.taskId.length === 0) {
    throw new CapabilityError(CAPABILITY_REASON.invalidInput, 'taskId is required');
  }
  if (typeof envelope.runId !== 'string' || envelope.runId.length === 0) {
    throw new CapabilityError(CAPABILITY_REASON.invalidInput, 'runId is required');
  }
}

/**
 * Refuse to launder trust through a model.
 *
 * A semantic verdict is an opinion about text that was handed to it. If the only
 * thing supporting a claim is the agent's own prose, a model agreeing does not
 * turn that into an observation — it turns it into a confident restatement. The
 * spec names this invariant; this function is where it is actually enforced.
 *
 * @param {object[]} evidence - evidence refs, each `{ ref, trust }`.
 * @param {{ used: boolean }} model - the model lane description.
 * @returns {void}
 * @throws {CapabilityError} when a model opinion is the sole support for a self-reported fact.
 */
export function assertNoTrustLaundering(evidence, model) {
  if (!model?.used) return;
  const independent = evidence.filter((e) => e.trust === 'collector_observed' || e.trust === 'harness_observed');
  if (evidence.length > 0 && independent.length === 0) {
    throw new CapabilityError(
      CAPABILITY_REASON.internalError,
      'a model verdict cannot be the only support for self-reported evidence',
    );
  }
}

/**
 * Pin the inputs a verdict was computed from.
 *
 * The digest is over the *material actually used*, not over the whole world: if a
 * capability dropped a file, the digest must change, or a later reader would
 * believe the verdict covered material it never saw.
 *
 * @param {object} parts - named pieces of material.
 * @param {string} [source] - where the material came from, for the trust boundary.
 * @param {string} [capturedAt] - ISO timestamp; defaults to now.
 * @returns {{ digest: string, source: string, capturedAt: string, parts: string[] }}
 */
export function snapshotIdentity(parts, { source = 'unknown', capturedAt = new Date().toISOString() } = {}) {
  const names = Object.keys(parts).sort();
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(name);
    hash.update('\u0000');
    const value = parts[name];
    hash.update(typeof value === 'string' ? value : JSON.stringify(value ?? null));
    hash.update('\u0001');
  }
  return { digest: `sha256:${hash.digest('hex')}`, source, capturedAt, parts: names };
}

/**
 * Describe the model lane, so a reader can tell a deterministic answer from a
 * judgement without reading the body.
 * @param {object} input
 * @param {boolean} input.requested - did this capability want a model verdict?
 * @param {boolean} input.used - did one actually run?
 * @param {string} [input.status] - the judge status, when one ran.
 * @param {string} [input.model] - the model id, when one ran.
 * @param {string} [input.note] - why it did not run.
 * @returns {{ requested: boolean, used: boolean, lane: string, status: string|null, model: string|null, note: string|null }}
 */
export function modelLane({ requested, used, status = null, model = null, note = null }) {
  return {
    requested: Boolean(requested),
    used: Boolean(used),
    lane: used ? 'jev' : 'none',
    status,
    model,
    note,
  };
}

/**
 * Resolve a capability's mode from configuration, defaulting to the safe side.
 * An unknown or absent value is `off`: a capability that was never asked for must
 * not start answering.
 * @param {object} config - the adapter's per-capability configuration.
 * @param {string} name - the capability name.
 * @returns {string} one of {@link CAPABILITY_MODES}.
 */
export function resolveMode(config, name) {
  const raw = config?.capabilities?.[name]?.mode ?? config?.mode ?? CAPABILITY_MODE.off;
  return CAPABILITY_MODES.includes(raw) ? raw : CAPABILITY_MODE.off;
}

/**
 * Run a body under a wall-clock budget and an abort signal.
 *
 * A capability that hangs is worse than one that abstains: the agent loop is
 * waiting on it. `timeout` and `cancelled` are distinct because they need
 * different fixes — one is a budget, the other is a user who changed their mind.
 *
 * @param {(signal: AbortSignal) => Promise<any>} body - the work.
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - wall-clock budget.
 * @param {AbortSignal} [options.signal] - an outer cancellation signal.
 * @returns {Promise<{ ok: boolean, value?: any, code?: string, message?: string }>}
 */
export async function withBudget(body, { timeoutMs = 20_000, signal } = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) return { ok: false, code: CAPABILITY_REASON.cancelled, message: 'the caller cancelled before the work started' };
    signal.addEventListener('abort', onAbort, { once: true });
  }
  let timer = null;
  let timedOut = false;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('timeout'));
      resolve();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const value = await Promise.race([body(controller.signal), timeout]);
    if (timedOut) return { ok: false, code: CAPABILITY_REASON.timeout, message: `exceeded the ${timeoutMs} ms budget` };
    if (controller.signal.aborted) return { ok: false, code: CAPABILITY_REASON.cancelled, message: 'the caller cancelled the work' };
    return { ok: true, value };
  } catch (error) {
    if (timedOut) return { ok: false, code: CAPABILITY_REASON.timeout, message: `exceeded the ${timeoutMs} ms budget` };
    if (controller.signal.aborted) return { ok: false, code: CAPABILITY_REASON.cancelled, message: 'the caller cancelled the work' };
    if (error instanceof CapabilityError) return { ok: false, code: error.code, message: error.message, details: error.details };
    return { ok: false, code: CAPABILITY_REASON.internalError, message: String(error?.message ?? error) };
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Assemble the envelope every capability returns.
 *
 * @param {object} input
 * @param {string} input.capability - the logical tool name, e.g. `jev_route_skill`.
 * @param {string} input.taskId - the task this answer belongs to.
 * @param {string} input.runId - this attempt.
 * @param {object} input.snapshot - from {@link snapshotIdentity}.
 * @param {string} input.status - one of {@link CAPABILITY_STATUSES}.
 * @param {string} input.code - one of {@link CAPABILITY_REASONS}.
 * @param {string} input.message - human-readable detail.
 * @param {object} [input.decision] - the capability-specific verdict.
 * @param {object[]} [input.evidence] - evidence refs `{ ref, trust, note? }`.
 * @param {string[]} [input.limits] - what this answer does not establish.
 * @param {object} [input.model] - from {@link modelLane}.
 * @param {object} [input.extra] - additional capability-specific fields.
 * @returns {object} the envelope.
 */
export function capabilityEnvelope(input) {
  const envelope = {
    envelopeVersion: ENVELOPE_VERSION,
    capability: input.capability,
    capabilityVersion: input.capabilityVersion ?? CAPABILITY_VERSION,
    taskId: input.taskId,
    runId: input.runId,
    snapshot: input.snapshot,
    status: input.status,
    reason: { code: input.code, message: input.message },
    // A capability describes a situation. It never authorises an action, and this
    // field exists so that a reader cannot mistake one for the other.
    actionAuthority: 'none',
    decision: input.decision ?? null,
    evidence: input.evidence ?? [],
    limits: input.limits ?? [],
    model: input.model ?? modelLane({ requested: false, used: false }),
    at: input.at ?? new Date().toISOString(),
    ...(input.extra ?? {}),
  };
  assertEnvelope(envelope);
  assertNoTrustLaundering(envelope.evidence, envelope.model);
  return envelope;
}

/**
 * Render an envelope as the single text block a tool returns to the model.
 * Kept deliberately plain: the model reads this, and a wall of JSON invites it to
 * paraphrase instead of act on the specific line that matters.
 * @param {object} envelope - from {@link capabilityEnvelope}.
 * @returns {{ type: 'text', text: string }[]}
 */
export function renderEnvelope(envelope) {
  const lines = [
    `${envelope.capability}: ${envelope.status} (${envelope.reason.code})`,
    envelope.reason.message,
  ];
  if (envelope.decision && typeof envelope.decision === 'object') {
    const summary = envelope.decision.summary;
    if (typeof summary === 'string' && summary.length > 0) lines.push(summary);
  }
  if (envelope.model.used) {
    lines.push(`judged by ${envelope.model.model ?? 'the judge'} (${envelope.model.status ?? 'unknown'})`);
  } else if (envelope.model.requested) {
    lines.push(`no model verdict: ${envelope.model.note ?? 'not available'}`);
  }
  if (envelope.limits.length > 0) {
    for (const limit of envelope.limits) lines.push(`limit: ${limit}`);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}
