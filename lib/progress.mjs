/**
 * Progress review (spec §14.2, capability C3, tool `jev_check_progress`).
 *
 * The question this module answers is narrow and deliberately *not* a
 * measurement of effort: given the last few events of a run, is there any
 * evidence that the run learned something, or is it re-running the same attempt
 * and expecting a different result?
 *
 * Three rules exist because the obvious proxies are wrong, and each of them has
 * already produced a false stop in the case that motivated the capability
 * (CASE-2101015355133227348):
 *
 *   - **An equal diff SIZE is not evidence of no progress.** A refactor can
 *     change ten lines to ten different lines; a build can rewrite an identical
 *     byte count. Size, byte counts and elapsed time are therefore never read as
 *     a progress signal, in either direction.
 *   - **A long-running command is not evidence of no progress.** Duration is
 *     reported by the caller as context, never as a verdict input.
 *   - **Similar-looking actions are not repetition.** Same tool, same argv, but a
 *     changed snapshot digest, a new artifact, a new test result or a new
 *     observation means the window contains information it did not have before,
 *     and the answer is `continue`.
 *
 * The decision order is deterministic and runs *before* any model: `continue`
 * whenever no repetition is detected or new information arrived; `reobserve`
 * when the same fingerprint repeats but the window is missing what would be
 * needed to judge it; `replan` when the same fingerprint repeats with nothing
 * new and a plan was already tried; `handoff` when the repeat counter has
 * reached `maxRepeats` or the run's budget is gone.
 *
 * What this module must never do, and says so in `limits`: kill a process,
 * revert an edit, or switch a model. A `handoff` is advice to the agent, not an
 * enforcement action — enforcement belongs to the approval gate, which is a
 * different component with its own exit codes.
 *
 * Trust is assigned by the acquisition path and never read from the input: an
 * event that merely *claims* `trust: 'harness_observed'` is downgraded to
 * `self_reported`, because a claim about its own provenance is not provenance.
 */
import {
  CAPABILITY_REASON,
  CAPABILITY_STATUS,
  CapabilityError,
  capabilityEnvelope,
  modelLane,
  snapshotIdentity,
  withBudget,
} from './capability.mjs';
import { digestJson } from './evidence.mjs';

/** The logical tool name this module implements. */
export const PROGRESS_CAPABILITY = 'jev_check_progress';

/** The four verdicts. Ordered from "keep going" to "the human takes over". */
export const PROGRESS_ACTION = Object.freeze({
  continue: 'continue',
  reobserve: 'reobserve',
  replan: 'replan',
  handoff: 'handoff',
});

export const PROGRESS_ACTIONS = Object.freeze(Object.values(PROGRESS_ACTION));

/** Default repeat counter before a run is handed off rather than re-planned. */
export const DEFAULT_MAX_REPEATS = 3;

/** Trust levels, weakest first. Used to clamp a declared trust downward. */
const TRUST_ORDER = Object.freeze(['self_reported', 'collector_observed', 'harness_observed']);

/**
 * Why the window cannot be judged even though a repeat was seen.
 * Kept as data so a caller can render the missing piece instead of parsing prose.
 */
export const MISSING_JUDGE_INPUT = Object.freeze({
  snapshot: 'no_snapshot_digest',
  exit: 'no_exit_status',
});

/**
 * The limits every C3 answer carries.
 *
 * These are not boilerplate. A reader who skims `decision.action` must still be
 * able to see that a stop was never inferred from time or size, and that the
 * capability has no authority to act on its own advice.
 */
export const PROGRESS_LIMITS = Object.freeze([
  'an equal diff size, a byte count or elapsed time is NOT a progress signal and is never used as one here',
  'a long-running command is NOT evidence of no progress; duration is context, never a verdict input',
  'this capability never kills a process, reverts an edit or switches a model; its output is advice, and enforcement belongs to the approval gate',
  'the verdict is computed from the event window the caller supplied; events the caller did not pass are invisible to it',
  'actionAuthority is always none: a `handoff` is a suggestion to stop and report, not a stop',
]);

const asArray = (value) => (Array.isArray(value) ? value : []);
const asStrings = (value) => asArray(value).filter((v) => typeof v === 'string' && v !== '');

/** Normalize a path-shaped string for fingerprinting. No disk access. */
function normalizeFingerprintPath(value) {
  if (typeof value !== 'string' || value === '') return '';
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

/**
 * The shape of an action: which tool, which arguments, from where, against what.
 *
 * This is deliberately *not* the output. Two runs of the same failing command
 * have to produce the same fingerprint even when their stdout differs; if the
 * digest covered the output, a command that fails with a different message every
 * time would look like progress.
 *
 * @param {object} event - one window event.
 * @returns {{ tool: string, argv: string[], cwd: string, targetPaths: string[] }}
 */
export function actionShape(event) {
  const source = event ?? {};
  const tool = String(source.tool ?? source.toolName ?? source.executable ?? source.name ?? 'unknown');
  const argv = asArray(source.argv ?? source.args).filter((v) => typeof v === 'string');
  const cwd = typeof source.cwd === 'string' ? normalizeFingerprintPath(source.cwd) : '';
  const targetPaths = asStrings(source.targetPaths ?? source.paths ?? source.writes)
    .map(normalizeFingerprintPath)
    .sort();
  return { tool, argv, cwd, targetPaths };
}

/**
 * A stable digest over the shape of an action.
 *
 * @param {object} event - one window event.
 * @returns {string} `sha256:…` over `{tool, argv, cwd, targetPaths}`.
 */
export function actionFingerprint(event) {
  return `sha256:${digestJson(actionShape(event))}`;
}

/** The error class of an event, as a string, or null when it recorded none. */
function errorClassOf(event) {
  const source = event ?? {};
  const raw = source.errorClass ?? source.error?.class ?? source.error?.name ?? source.error?.code ?? source.errorCode;
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/** Flatten an error field of any of the shapes the harnesses use into text. */
function errorTextOf(event) {
  const raw = event?.error;
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    return [raw.name, raw.code, raw.message, raw.detail, raw.reason].filter((v) => typeof v === 'string').join(' ');
  }
  return String(raw);
}

/**
 * Strip everything about an error that changes between two occurrences of the
 * *same* failure.
 *
 * Without this, an error message that embeds the absolute path, the PID, the
 * port or the timestamp of the attempt makes every occurrence unique, the repeat
 * counter never fires, and the capability is silently useless. The normalizer
 * therefore removes volatile values while leaving the words that identify the
 * failure class — and, for a message, the tool name — in place.
 *
 * @param {string} text - raw error text.
 * @returns {string} normalized text.
 */
export function normalizeErrorText(text) {
  let out = String(text ?? '');
  // ISO timestamps, then clock times, then durations.
  out = out.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>');
  out = out.replace(/\d{1,2}:\d{2}:\d{2}(?:\.\d+)?/g, '<ts>');
  out = out.replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)\b/gi, '<dur>');
  // Network endpoints and hex addresses, before paths, so `host:port` does not
  // look like a Windows drive.
  out = out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>');
  out = out.replace(/\b(?:port|listen(?:ing)?(?:\s+on)?)\s*[:=]?\s*\d{2,5}\b/gi, '<port>');
  out = out.replace(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}\b/gi, '<host>');
  out = out.replace(/\b0x[0-9a-fA-F]+\b/g, '<hex>');
  // Paths: Windows drive, POSIX absolute, then any relative path with a
  // separator. A bare filename is left alone — it names the artifact and is part
  // of the failure class.
  out = out.replace(/[A-Za-z]:[\\/][^\s'"`,;)\]]+/g, '<path>');
  out = out.replace(/\/(?:[\w.@-]+\/)+[\w.@-]*/g, '<path>');
  out = out.replace(/(?:\.{0,2}[\\/])(?:[\w.@-]+[\\/])+[\w.@-]*/g, '<path>');
  // PIDs and bare long identifiers.
  out = out.replace(/\b(?:pid|process(?:Id)?)\s*[:=]?\s*\d+/gi, '<pid>');
  out = out.replace(/\b\d{4,}\b/g, '<num>');
  // Line and column numbers are positions, not classes.
  out = out.replace(/:\d+:\d+\b/g, ':<loc>');
  out = out.replace(/\bline\s+\d+(?:\s*,?\s*column\s+\d+)?/gi, '<loc>');
  out = out.replace(/[ \t]+/g, ' ').trim();
  return out;
}

/**
 * A stable digest over the *class* of a failure, not its instance.
 *
 * Two occurrences of the same underlying failure recorded at different paths,
 * with different PIDs or at different timestamps must produce the same digest;
 * a different error class must not.
 *
 * @param {object} event - one window event.
 * @returns {string} `sha256:…`.
 */
export function errorFingerprint(event) {
  const errorClass = errorClassOf(event) ?? '';
  const rawText = errorTextOf(event);
  const message = normalizeErrorText(rawText);
  // The tool is part of the class: the same sentence from two different tools is
  // not necessarily the same failure. It is taken from the raw text so that two
  // messages differing only in volatile values still match.
  const tool = actionShape(event).tool;
  return `sha256:${digestJson({ errorClass, message, tool })}`;
}

/** The exit status an event recorded, or null when it recorded none. */
function exitStatusOf(event) {
  const value = event?.exit ?? event?.exitCode;
  if (Number.isInteger(value)) return value;
  return null;
}

/** A short, stable reference for an event: its id when it has one, else its index. */
function eventRef(event, index) {
  return String(event?.eventId ?? event?.id ?? `event-${index}`);
}

/**
 * The trust of an event's *acquisition path*.
 *
 * A declared trust is clamped, never trusted: an event that says
 * `trust: 'harness_observed'` but carries no harness marker is self-reported.
 */
function eventTrust(event) {
  const marker = event?.sourceTrust ?? event?.origin;
  if (marker === 'harness_observed') return 'harness_observed';
  if (marker === 'collector_observed') return 'collector_observed';
  return 'self_reported';
}

/** The "before" state a novelty check compares against. */
function priorSets(prior) {
  return {
    snapshots: new Set(asStrings(prior?.snapshotDigests ?? prior?.snapshots)),
    artifacts: new Set(asStrings(prior?.artifacts ?? prior?.artifactRefs)),
    tests: new Set(asStrings(prior?.tests ?? prior?.testResults)),
    observations: new Set(asStrings(prior?.observations ?? prior?.observationRefs)),
  };
}

function isExhaustedBudget(budget) {
  if (budget === null || budget === undefined) return false;
  if (typeof budget === 'number') return budget <= 0;
  if (typeof budget === 'object') return budget.exhausted === true || budget.remaining <= 0;
  return false;
}

/** One evidence ref per event, with the trust the acquisition path earned. */
function evidenceFor(events, indexes) {
  return indexes.map((index) => {
    const event = events[index];
    const shape = actionShape(event);
    return {
      ref: eventRef(event, index),
      trust: eventTrust(event),
      note: `${shape.tool} ${shape.argv.join(' ')}`.trim(),
    };
  });
}

/** Everything the deterministic core needs, computed once and read by the decision. */
function inspectWindow(events, prior) {
  const before = priorSets(prior);
  const groups = new Map();
  const novelSignals = [];
  let snapshotPresent = false;
  let exitRecorded = false;

  events.forEach((event, index) => {
    const action = actionFingerprint(event);
    const group = groups.get(action) ?? { action, indexes: [], errorFingerprints: new Set(), firstIndex: index };
    group.indexes.push(index);
    group.errorFingerprints.add(errorFingerprint(event));
    groups.set(action, group);

    if (typeof event?.snapshotDigest === 'string' && event.snapshotDigest !== '') snapshotPresent = true;
    if (exitStatusOf(event) !== null) exitRecorded = true;

    const snapshot = event?.snapshotDigest;
    if (typeof snapshot === 'string' && snapshot !== '' && before.snapshots.size > 0 && !before.snapshots.has(snapshot)) {
      novelSignals.push({ kind: 'snapshot', ref: snapshot, event: eventRef(event, index) });
    }
    for (const ref of asStrings(event?.artifacts)) {
      if (before.artifacts.size > 0 && !before.artifacts.has(ref)) novelSignals.push({ kind: 'artifact', ref, event: eventRef(event, index) });
    }
    for (const ref of asStrings(event?.testResults)) {
      if (before.tests.size > 0 && !before.tests.has(ref)) novelSignals.push({ kind: 'test_result', ref, event: eventRef(event, index) });
    }
    for (const ref of asStrings(event?.observations)) {
      if (before.observations.size > 0 && !before.observations.has(ref)) novelSignals.push({ kind: 'observation', ref, event: eventRef(event, index) });
    }
  });

  const repeated = [...groups.values()]
    .filter((group) => group.indexes.length > 1)
    .sort((a, b) => b.indexes.length - a.indexes.length || a.firstIndex - b.firstIndex);

  const repeats = repeated.length === 0 ? 0 : repeated[0].indexes.length;
  const missing = [];
  if (!snapshotPresent) missing.push(MISSING_JUDGE_INPUT.snapshot);
  if (!exitRecorded) missing.push(MISSING_JUDGE_INPUT.exit);

  return { groups, repeated, repeats, novelSignals, missing, snapshotPresent, exitRecorded };
}

/**
 * The deterministic core. Pure: no clock, no I/O, no model.
 *
 * @param {object[]} events - the window, oldest first.
 * @param {object} options
 * @param {number} options.maxRepeats - repeats allowed before a handoff.
 * @param {object} [options.budget] - `{exhausted}` or `{remaining}`.
 * @param {object} [options.prior] - what the caller had already seen.
 * @returns {object} the decision, without the envelope around it.
 */
function coreDecision(events, { maxRepeats, budget, prior }) {
  const window = inspectWindow(events, prior);

  if (window.repeated.length === 0) {
    return {
      action: PROGRESS_ACTION.continue,
      summary: 'no repeated action fingerprint in this window: every action is new, so there is nothing to conclude.',
      reason: CAPABILITY_REASON.progressObserved,
      evidenceRefs: evidenceFor(events, events.map((_, index) => index)),
      repeats: 0,
      novelSignals: [],
      missing: [],
    };
  }

  const top = window.repeated[0];
  const evidenceRefs = evidenceFor(events, top.indexes);

  if (window.novelSignals.length > 0) {
    const kinds = [...new Set(window.novelSignals.map((s) => s.kind))].sort();
    return {
      action: PROGRESS_ACTION.continue,
      summary: `similar actions, but the window carries new information (${kinds.join(', ')}): this is progress, not repetition.`,
      reason: CAPABILITY_REASON.progressObserved,
      evidenceRefs,
      repeats: window.repeats,
      novelSignals: window.novelSignals,
      missing: [],
    };
  }

  if (window.missing.length > 0) {
    return {
      action: PROGRESS_ACTION.reobserve,
      summary: `the same action fingerprint repeated ${window.repeats} time(s), but the window is missing ${window.missing.join(' and ')}: collect that observation before changing the plan.`,
      reason: CAPABILITY_REASON.missingMaterial,
      evidenceRefs,
      repeats: window.repeats,
      novelSignals: [],
      missing: window.missing,
    };
  }

  if (window.repeats >= maxRepeats) {
    return {
      action: PROGRESS_ACTION.handoff,
      summary: `the same action fingerprint repeated ${window.repeats} time(s), reaching maxRepeats=${maxRepeats}: stop and hand off with what is known.`,
      reason: CAPABILITY_REASON.repeatedWithoutProgress,
      evidenceRefs,
      repeats: window.repeats,
      novelSignals: [],
      missing: [],
      limit: 'maxRepeats',
    };
  }

  if (isExhaustedBudget(budget)) {
    return {
      action: PROGRESS_ACTION.handoff,
      summary: 'the same action fingerprint repeated with nothing new, and the run budget is exhausted: hand off rather than re-plan.',
      // `budget_exhausted` is a non-success code, and a handoff here is still a
      // reached verdict about repetition — the spent budget is what caps the
      // advice, and `limit` says so. Using the non-success code would force the
      // envelope to contradict itself.
      reason: CAPABILITY_REASON.repeatedWithoutProgress,
      evidenceRefs,
      repeats: window.repeats,
      novelSignals: [],
      missing: [],
      limit: 'budget',
    };
  }

  return {
    action: PROGRESS_ACTION.replan,
    summary: `the same action fingerprint repeated ${window.repeats} time(s) with no new snapshot digest, artifact, test result or observation, and a plan was already tried: change the experiment.`,
    reason: CAPABILITY_REASON.repeatedWithoutProgress,
    evidenceRefs,
    repeats: window.repeats,
    novelSignals: [],
    missing: [],
  };
}

/**
 * The status a reached verdict carries.
 *
 * `success` means the capability reached a verdict, not that the run is fine.
 * The two exceptions are deliberate: a verdict that *cannot* be reached without
 * more observation is `unverified`, and a verdict that is withheld because the
 * capability would otherwise repeat itself is an `abstain`. Reporting either as
 * `success` would read as an answer when there is none.
 */
function statusFor(reason) {
  if (reason === CAPABILITY_REASON.missingMaterial || reason === CAPABILITY_REASON.evidenceMissing) {
    return CAPABILITY_STATUS.unverified;
  }
  if (reason === CAPABILITY_REASON.abstained || reason === CAPABILITY_REASON.budgetExhausted) {
    return CAPABILITY_STATUS.abstain;
  }
  return CAPABILITY_STATUS.success;
}

/** Build the envelope from the core decision plus the identity fields. */
function envelopeFor({ events, taskId, runId, decision, suppressed, lastAdvice, maxRepeats, cooldown }) {
  const snapshot = snapshotIdentity(
    { events: events.map((event, index) => `${eventRef(event, index)}:${actionFingerprint(event)}`) },
    { source: 'event_window' },
  );
  return capabilityEnvelope({
    capability: PROGRESS_CAPABILITY,
    taskId,
    runId,
    snapshot,
    status: suppressed ? CAPABILITY_STATUS.success : statusFor(decision.reason),
    code: suppressed ? CAPABILITY_REASON.abstained : decision.reason,
    message: decision.summary,
    decision: {
      action: decision.action,
      summary: decision.summary,
      reason: decision.reason,
      evidenceRefs: decision.evidenceRefs,
      repeats: decision.repeats,
      novelSignals: decision.novelSignals,
      missing: decision.missing ?? [],
      suppressed: suppressed === true,
      ...(decision.limit ? { limit: decision.limit } : {}),
      ...(suppressed ? { wouldBeAction: lastAdvice.wouldBeAction } : {}),
    },
    evidence: decision.evidenceRefs,
    limits: PROGRESS_LIMITS,
    model: modelLane({
      requested: false,
      used: false,
      note: 'the decision is deterministic and runs before any model; no semantic novelty judgement was requested',
    }),
    extra: { parameters: { maxRepeats, cooldown } },
  });
}

/**
 * Review an event window and say whether the run is progressing.
 *
 * @param {object} input
 * @param {object[]} input.events - the window, oldest first. Each event may carry
 *   `{eventId, tool|toolName, argv, cwd, targetPaths, exit|exitCode, error,
 *   snapshotDigest, artifacts, testResults, observations, sourceTrust}`.
 * @param {string} input.taskId - the task this answer belongs to.
 * @param {string} input.runId - this attempt.
 * @param {number} [input.maxRepeats=3] - repeats allowed before `handoff`.
 * @param {number} [input.cooldown=0] - when `> 0`, do not repeat the same advice.
 * @param {object} [input.budget] - `{exhausted}` or `{remaining}`; a spent budget forces `handoff`.
 * @param {object} [input.prior] - `{snapshotDigests, artifacts, tests, observations}` already seen.
 * @param {object} [input.lastAdvice] - `{action, at}` the previous advice for this run.
 * @param {number} [input.timeoutMs] - wall-clock budget for the review itself.
 * @param {AbortSignal} [input.signal] - caller cancellation.
 * @returns {Promise<object>} a capability envelope whose `decision.action` is one of
 *   {@link PROGRESS_ACTION}.
 */
export async function analyseWindow({
  events,
  taskId,
  runId,
  maxRepeats = DEFAULT_MAX_REPEATS,
  cooldown = 0,
  budget = null,
  prior = null,
  lastAdvice = null,
  timeoutMs = 5_000,
  signal,
} = {}) {
  if (!Array.isArray(events)) {
    throw new CapabilityError(CAPABILITY_REASON.invalidInput, 'events must be an array');
  }
  if (typeof taskId !== 'string' || taskId === '') {
    throw new CapabilityError(CAPABILITY_REASON.invalidInput, 'taskId is required');
  }
  if (typeof runId !== 'string' || runId === '') {
    throw new CapabilityError(CAPABILITY_REASON.invalidInput, 'runId is required');
  }
  if (!Number.isInteger(maxRepeats) || maxRepeats < 1) {
    throw new CapabilityError(CAPABILITY_REASON.invalidInput, 'maxRepeats must be a positive integer');
  }
  if (!Number.isFinite(cooldown) || cooldown < 0) {
    throw new CapabilityError(CAPABILITY_REASON.invalidInput, 'cooldown must be a non-negative number');
  }

  const outcome = await withBudget(() => coreDecision(events, { maxRepeats, budget, prior }), { timeoutMs, signal });

  if (!outcome.ok) {
    const status = outcome.code === CAPABILITY_REASON.cancelled || outcome.code === CAPABILITY_REASON.timeout
      ? CAPABILITY_STATUS.unverified
      : CAPABILITY_STATUS.error;
    return capabilityEnvelope({
      capability: PROGRESS_CAPABILITY,
      taskId,
      runId,
      snapshot: snapshotIdentity({ events: events.map((event, index) => eventRef(event, index)) }, { source: 'event_window' }),
      status,
      code: outcome.code,
      message: outcome.message,
      decision: null,
      limits: PROGRESS_LIMITS,
      model: modelLane({ requested: false, used: false }),
    });
  }

  const decision = outcome.value;

  // The anti-nag rule. A capability that repeats its own advice is the loop it
  // was built to break, so once the same advice has already been given for this
  // run it abstains instead of saying it again — and it abstains *as* `continue`,
  // because saying nothing is not a reason to change course.
  const previousAction = typeof lastAdvice?.action === 'string' ? lastAdvice.action : null;
  if (cooldown > 0 && previousAction !== null && previousAction === decision.action) {
    const suppressedDecision = {
      ...decision,
      action: PROGRESS_ACTION.continue,
      reason: CAPABILITY_REASON.abstained,
      summary: `the previous advice for this run was already '${previousAction}'; the cooldown suppresses a repeat, so nothing new is advised.`,
    };
    return envelopeFor({
      events,
      taskId,
      runId,
      decision: suppressedDecision,
      suppressed: true,
      lastAdvice: { wouldBeAction: decision.action },
      maxRepeats,
      cooldown,
    });
  }

  return envelopeFor({ events, taskId, runId, decision, suppressed: false, lastAdvice: null, maxRepeats, cooldown });
}
