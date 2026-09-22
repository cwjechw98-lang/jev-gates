/**
 * C1 — `jev_verify_completion`: decide whether a task is actually finished.
 *
 * The pipeline is fixed and ordered, because the order is the safety property:
 *
 *   real tool executions -> observations -> criteria -> (model lane) -> verdict
 *
 * Three rules shape every line below.
 *
 * 1. **Trust comes from the acquisition path, never from an input field.** An
 *    observation is `harness_observed` because the harness watched the call,
 *    `collector_observed` because this process read the file itself, and
 *    `self_reported` because a request asserted it. A request cannot promote
 *    itself; `lib/contracts.mjs` `markInlineOrigin` exists for exactly that.
 *
 * 2. **A missing fact is not a pass.** Evidence is resolved before the model is
 *    asked anything, and a required criterion with no observation stays
 *    unverified no matter what a judge says (INV-02, INV-08). A model verdict is
 *    never the only support for a claim about the world.
 *
 * 3. **A deterministic verdict never pays for a model.** If every required
 *    criterion is deterministic and resolved, the answer is computed and the
 *    judge is not called at all. The model lane is for semantic criteria only.
 *
 * The completion vocabulary (`done`/`not_done`/`review`/`unverified`, exit
 * `0/1/2/3`) is the gate's, and it travels in `decision`. The envelope's own
 * `status` is the capability vocabulary, where `not_done` is a `success` — the
 * capability succeeded in reaching a verdict. Collapsing those two into one field
 * is how a "no" starts looking like a failure to answer.
 */
import { markInlineOrigin } from './contracts.mjs';
import {
  CAPABILITY_REASON,
  CAPABILITY_STATUS,
  capabilityEnvelope,
  modelLane,
  snapshotIdentity,
  withBudget,
} from './capability.mjs';
import { collectArtifact, observationsFromEvents } from './collector.mjs';
import { resolveCriteria } from './evidence.mjs';
import { askJudge, buildQuestions, buildState, JUDGE_STATUS } from './judge.mjs';
import { ENFORCEMENT, STATUS, STATUS_EXIT, decideCompletion, DEFAULT_THRESHOLDS } from './policy.mjs';

/** C1 implementation version. */
export const VERIFY_VERSION = '1.0.0';

/** The capability's logical tool name. */
export const CAPABILITY = 'jev_verify_completion';

/** The completion statuses, re-exported so a caller need not reach into policy. */
export { STATUS, STATUS_EXIT };

/**
 * Which capability status corresponds to a completion status.
 *
 * `not_done` maps to `success` on purpose: the capability answered the question.
 * Whether the answer is good news is a different field, and keeping them apart is
 * what stops "we could not tell" from being read as "no".
 */
const COMPLETION_TO_CAPABILITY = Object.freeze({
  [STATUS.done]: CAPABILITY_STATUS.success,
  [STATUS.not_done]: CAPABILITY_STATUS.success,
  [STATUS.review]: CAPABILITY_STATUS.abstain,
  [STATUS.unverified]: CAPABILITY_STATUS.unverified,
});

/**
 * Turn one real tool execution into the event shape the collector understands.
 *
 * Deliberately defensive about what it does NOT know. A tool that never declared
 * an exit code leaves `exitCode` undefined rather than `0`: inventing a zero is
 * the single easiest way to turn an unknown into a pass, and the collector
 * already treats a missing status as `unknown` (INV-05).
 *
 * @param {object} input
 * @param {object} input.exec - the DSH `ToolExecution` (`name`, `callId`, `arguments`).
 * @param {object} input.result - the DSH `ToolExecutionResult`.
 * @param {number} [input.sequence] - position in the session's event stream.
 * @param {string} [input.startedAt] - ISO timestamp, when known.
 * @param {string} [input.endedAt] - ISO timestamp, when known.
 * @returns {object} an event for {@link observationsFromEvents}.
 */
export function eventFromToolResult({ exec, result, sequence = null, startedAt = null, endedAt = null } = {}) {
  const args = exec?.arguments ?? {};
  const value = result && result.isError === false ? result.value : null;
  // Only a canonical value that actually declares these fields is trusted. A
  // rendered string is not an exit code, and parsing one out of prose is how a
  // model's summary becomes a measurement.
  const declared = value !== null && typeof value === 'object' ? value : {};

  const event = {
    type: 'tool_result',
    toolCallId: exec?.callId ?? null,
    toolName: exec?.name ?? 'unknown',
    sequence,
    startedAt,
    endedAt,
    isError: result?.isError === true,
    // A failure carries no canonical value, so nothing about its outcome is known.
    status: declared.status ?? (result?.isError === true ? 'unknown' : undefined),
    exitCode: Number.isInteger(declared.exitCode) ? declared.exitCode : undefined,
    signal: typeof declared.signal === 'string' ? declared.signal : undefined,
    executable: typeof declared.executable === 'string' ? declared.executable : undefined,
    argv: Array.isArray(declared.argv) ? declared.argv.map(String) : undefined,
    cwd: typeof declared.cwd === 'string' ? declared.cwd : undefined,
    stdout: typeof declared.stdout === 'string' ? declared.stdout : undefined,
    stderr: typeof declared.stderr === 'string' ? declared.stderr : undefined,
    writes: Array.isArray(declared.writes) ? declared.writes.filter((p) => typeof p === 'string') : undefined,
    // Kept so a reader can see which tool produced the observation.
    argumentsDigestSource: args,
  };
  return event;
}

/**
 * Assemble the observations this verdict rests on, each with the trust its path earns.
 *
 * @param {object} input
 * @param {object[]} [input.events] - tool-execution events, from {@link eventFromToolResult}.
 * @param {string[]} [input.artifacts] - paths this process reads itself.
 * @param {object[]} [input.inlineEvidence] - observations asserted by the request.
 * @param {string} [input.projectRoot] - base for relative artifact paths.
 * @param {string} input.taskId
 * @param {string} input.runId
 * @param {boolean} [input.withExcerpt] - capture the head of each artifact.
 * @returns {Promise<{ observations: object[], notes: string[] }>}
 */
export async function gatherObservations({
  events = [],
  artifacts = [],
  inlineEvidence = [],
  projectRoot = null,
  taskId,
  runId,
  withExcerpt = false,
} = {}) {
  const notes = [];
  const observations = [];

  const fromEvents = observationsFromEvents(events, { runId, taskId, sourceTrust: 'harness_observed' });
  observations.push(...(fromEvents.observations ?? []));
  if (fromEvents.observations?.length > 0) {
    notes.push(`${fromEvents.observations.length} observation(s) from tool executions the harness performed`);
  }
  if (fromEvents.skipped?.length > 0) {
    // An event the collector could not read is reported, never dropped silently:
    // a shrinking observation set is how a required criterion turns into a pass.
    notes.push(`${fromEvents.skipped.length} event(s) could not be read as observations`);
  }

  let sequence = observations.length;
  for (const path of artifacts) {
    sequence += 1;
    const observation = await collectArtifact({ path, projectRoot, runId, taskId, sequence, sourceTrust: 'collector_observed', withExcerpt });
    observations.push(observation);
  }
  if (artifacts.length > 0) notes.push(`${artifacts.length} artifact(s) read by the collector, not reported by the agent`);

  for (const inline of inlineEvidence) {
    // The channel decides the trust, and this channel is the request itself.
    const marked = markInlineOrigin({ ...inline, runId, taskId });
    observations.push(marked);
  }
  if (inlineEvidence.length > 0) {
    notes.push(`${inlineEvidence.length} inline observation(s) downgraded to self_reported: a request cannot certify itself`);
  }

  return { observations, notes };
}

/**
 * Decide whether the work is finished.
 *
 * @param {object} input
 * @param {string} input.taskId
 * @param {string} input.runId
 * @param {object} input.request - a validated v2 request (`criteria`, `claims`, `verificationScope`).
 * @param {object[]} [input.events] - real tool executions, from {@link eventFromToolResult}.
 * @param {string[]} [input.artifacts] - paths to read directly.
 * @param {object[]} [input.inlineEvidence] - request-asserted observations.
 * @param {string} [input.projectRoot]
 * @param {object} [input.thresholds] - probability thresholds; uncalibrated by default.
 * @param {object} [input.enforcement] - `ENFORCEMENT.advisory` or `.blocking`.
 * @param {object} [input.judge] - an injected judge; omit to use the real client.
 * @param {boolean} [input.allowModel] - may a semantic criterion consult a judge?
 * @param {string|null} [input.model]
 * @param {AbortSignal} [input.signal]
 * @param {number} [input.timeoutMs]
 * @param {boolean} [input.withExcerpt]
 * @returns {Promise<object>} a capability envelope whose `decision` carries the completion verdict.
 */
export async function verifyCompletion({
  taskId,
  runId,
  request,
  events = [],
  artifacts = [],
  inlineEvidence = [],
  projectRoot = null,
  thresholds = DEFAULT_THRESHOLDS,
  enforcement = ENFORCEMENT.advisory,
  judge = null,
  allowModel = true,
  model = null,
  signal,
  timeoutMs = 20_000,
  withExcerpt = false,
} = {}) {
  const criteria = request?.criteria ?? [];

  const { observations, notes } = await gatherObservations({ events, artifacts, inlineEvidence, projectRoot, taskId, runId, withExcerpt });

  // The snapshot is computed AFTER the evidence is read, and that ordering is the
  // point. A snapshot built from paths alone cannot notice that a file changed
  // under it, so a completion verdict would keep describing a version that no
  // longer exists (INV-07). Including each observation's own digest means the
  // snapshot moves exactly when the material does — and, just as importantly,
  // stays put when only the attempt changed, which is what lets the stop rule
  // recognise a repeat instead of reading every retry as new information.
  const snapshot = snapshotIdentity(
    {
      criteria: JSON.stringify(criteria),
      request: JSON.stringify(request ?? null),
      artifacts,
      observations: JSON.stringify(
        observations.map((o) => ({
          id: o.observationId ?? null,
          kind: o.kind ?? null,
          path: o.path ?? null,
          existence: o.existence ?? null,
          sha256: o.sha256 ?? null,
          exit: o.exit ?? null,
          status: o.status ?? null,
          sequence: o.sequence ?? null,
        })),
      ),
    },
    { source: projectRoot ? `project:${projectRoot}` : 'session' },
  );

  const envelope = (fields) =>
    capabilityEnvelope({
      capability: CAPABILITY,
      capabilityVersion: VERIFY_VERSION,
      taskId,
      runId,
      snapshot,
      ...fields,
    });

  const facts = resolveCriteria(criteria, observations, { projectRoot });
  const requiredFacts = facts.filter((fact) => fact.required !== false);
  const unresolvedRequired = requiredFacts.filter((fact) => fact.result === 'unknown' || fact.result === 'unresolved');
  const failedRequired = requiredFacts.filter((fact) => fact.result === 'fail');
  const semanticCriteria = criteria.filter((criterion) => criterion.kind === 'semantic');

  const decisionBase = {
    completionStatus: null,
    exitCode: null,
    reasonCodes: [],
    criteriaTotal: facts.length,
    requiredTotal: requiredFacts.length,
    perCriterion: facts.map((fact) => ({
      id: fact.id,
      kind: fact.kind ?? null,
      required: fact.required !== false,
      result: fact.result,
      reason: fact.reason ?? null,
      sourceTrust: fact.sourceTrust ?? null,
      evidenceRefs: fact.evidenceRefs ?? [],
    })),
    observationNotes: notes,
    enforcement: enforcement.level,
    basis: 'deterministic',
  };

  // --- Hard stops, before any model is consulted ---------------------------
  //
  // A failed required criterion is a fact about the world. Asking a judge about
  // it afterwards would only invite the judge to disagree with a measurement.
  if (failedRequired.length > 0) {
    const reasons = [...new Set(failedRequired.map((fact) => fact.reason ?? CAPABILITY_REASON.criterionFailed))];
    const completion = decideCompletion({ request, criterionFacts: facts, judgeStatus: JUDGE_STATUS.not_requested, thresholds, enforcement });
    return envelope({
      status: CAPABILITY_STATUS.success,
      code: CAPABILITY_REASON.criterionFailed,
      message: `${failedRequired.length} required criterion(a) failed: ${failedRequired.map((f) => f.id).join(', ')}`,
      decision: { ...decisionBase, completionStatus: completion.status, exitCode: completion.exitCode, reasonCodes: reasons },
      evidence: observations.map((o) => ({ ref: o.observationId, trust: o.sourceTrust ?? 'self_reported' })),
      model: modelLane({ requested: false, used: false, note: 'a deterministic failure is not a question for a model' }),
      limits: ['this gate checks that the evidence is consistent, not that it is true', 'local evidence has tamperResistance "none" — a process with the same write access can alter it'],
    });
  }

  if (unresolvedRequired.length > 0) {
    const completion = decideCompletion({ request, criterionFacts: facts, judgeStatus: JUDGE_STATUS.not_requested, thresholds, enforcement });
    return envelope({
      status: CAPABILITY_STATUS.unverified,
      code: CAPABILITY_REASON.requiredUnknown,
      message: `${unresolvedRequired.length} required criterion(a) have no usable evidence: ${unresolvedRequired.map((f) => f.id).join(', ')}`,
      decision: { ...decisionBase, completionStatus: completion.status, exitCode: completion.exitCode, reasonCodes: completion.reasonCodes ?? [] },
      evidence: observations.map((o) => ({ ref: o.observationId, trust: o.sourceTrust ?? 'self_reported' })),
      model: modelLane({ requested: false, used: false, note: 'missing evidence is not a question for a model' }),
      limits: ['an absent observation is not a pass', 'this is not "done" and not "forbidden": nothing is confirmed, a human decides'],
    });
  }

  // --- All required criteria are deterministic and resolved ----------------
  if (semanticCriteria.length === 0) {
    const completion = decideCompletion({ request, criterionFacts: facts, judgeStatus: JUDGE_STATUS.not_requested, thresholds, enforcement });
    return envelope({
      status: COMPLETION_TO_CAPABILITY[completion.status] ?? CAPABILITY_STATUS.unverified,
      code: completion.status === STATUS.done ? CAPABILITY_REASON.ok : CAPABILITY_REASON.requiredUnknown,
      message: completion.reason ?? 'decided without a model: every required criterion was deterministic',
      decision: { ...decisionBase, completionStatus: completion.status, exitCode: completion.exitCode, reasonCodes: completion.reasonCodes ?? [] },
      evidence: observations.map((o) => ({ ref: o.observationId, trust: o.sourceTrust ?? 'self_reported' })),
      model: modelLane({ requested: false, used: false, note: 'no semantic criterion: the answer is computed, not judged' }),
      limits: ['a deterministic pass says the checks ran and matched; it does not say the checks were the right ones'],
    });
  }

  // --- Semantic lane ------------------------------------------------------
  if (!allowModel || judge === null) {
    return envelope({
      status: CAPABILITY_STATUS.unverified,
      code: CAPABILITY_REASON.judgeUnavailable,
      message: 'a semantic criterion needs a judge and none is available; the deterministic part is resolved but the whole task is not confirmed',
      decision: { ...decisionBase, completionStatus: STATUS.unverified, exitCode: STATUS_EXIT.unverified },
      evidence: observations.map((o) => ({ ref: o.observationId, trust: o.sourceTrust ?? 'self_reported' })),
      model: modelLane({ requested: true, used: false, note: allowModel ? 'no judge was injected' : 'the model lane is disabled' }),
      limits: ['an unavailable judge implies neither completion nor permission to act'],
    });
  }

  const state = buildState(request, facts);
  const questions = buildQuestions(semanticCriteria, facts);
  const budgeted = await withBudget(
    () => judge({ state, questions, model }),
    { timeoutMs, signal },
  );

  if (!budgeted.ok) {
    return envelope({
      status: CAPABILITY_STATUS.unverified,
      code: budgeted.code === CAPABILITY_REASON.timeout ? CAPABILITY_REASON.timeout : CAPABILITY_REASON.judgeError,
      message: budgeted.message,
      decision: { ...decisionBase, completionStatus: STATUS.unverified, exitCode: STATUS_EXIT.unverified },
      evidence: observations.map((o) => ({ ref: o.observationId, trust: o.sourceTrust ?? 'self_reported' })),
      model: modelLane({ requested: true, used: false, note: budgeted.message }),
      limits: ['a judge that did not answer cannot confirm anything'],
    });
  }

  const verdict = budgeted.value ?? {};
  const completion = decideCompletion({
    request,
    criterionFacts: facts,
    answers: verdict.answers ?? {},
    answerErrors: verdict.answerErrors ?? [],
    thresholds,
    judgeStatus: verdict.status ?? JUDGE_STATUS.answered,
    judgeReason: verdict.reason ?? null,
    enforcement,
    observations,
    rawAnswers: verdict.raw ?? null,
  });

  const status = COMPLETION_TO_CAPABILITY[completion.status] ?? CAPABILITY_STATUS.unverified;
  const code =
    completion.status === STATUS.done ? CAPABILITY_REASON.ok
      : completion.status === STATUS.review ? CAPABILITY_REASON.abstained
        : completion.status === STATUS.not_done ? CAPABILITY_REASON.unsupportedByEvidence
          : CAPABILITY_REASON.judgeAbstained;

  return envelope({
    status,
    code,
    message: completion.reason ?? `the judge returned ${completion.status}`,
    decision: { ...decisionBase, basis: 'semantic', completionStatus: completion.status, exitCode: completion.exitCode, reasonCodes: completion.reasonCodes ?? [] },
    evidence: observations.map((o) => ({ ref: o.observationId, trust: o.sourceTrust ?? 'self_reported' })),
    model: modelLane({ requested: true, used: true, status: verdict.status ?? null, model: verdict.model ?? model }),
    limits: [
      'a semantic pass is an opinion about the material handed to the judge; it is not independent evidence that the material is true',
      'the model does not recompute exit codes, hashes, counts or ordering',
    ],
  });
}

/**
 * Build the judge function the capability uses, so the transport stays in one place.
 * @param {object} [options] - forwarded to `askJudge`.
 * @returns {(input: object) => Promise<object>} a judge callable.
 */
export function judgeFromClient(options = {}) {
  return async ({ state, questions, model }) => {
    const response = await askJudge({ state, questions, model: model ?? undefined, ...options });
    return {
      status: response?.status ?? JUDGE_STATUS.error,
      answers: response?.answers ?? {},
      answerErrors: response?.errors ?? [],
      reason: response?.reason ?? null,
      raw: response?.raw ?? null,
      model: response?.model ?? model ?? null,
    };
  };
}
