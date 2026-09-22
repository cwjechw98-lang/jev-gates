/**
 * The judge lane (REQ-04).
 *
 * This module asks Jev only about what code cannot decide. Every question here
 * is semantic by construction: a criterion that has a deterministic check never
 * becomes a question, because a probability is a worse answer than a fact.
 *
 * Untrusted text — the task, the claim, criterion wording, paths, file names and
 * command output — is wrapped and delimited, never concatenated into an
 * instruction. That is a reduction in attack surface, not a security boundary:
 * the spec is explicit that structure does not create a privilege boundary, so
 * nothing downstream trusts an answer more because it arrived in a tidy shape.
 */
import { createTransport } from './transport.mjs';
import { resolveApiKey } from './credentials.mjs';

export const JUDGE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
/** Pinned on purpose: `jev-latest` drifts between runs and a verdict must be reproducible. */
export const DEFAULT_MODEL = 'jev-1.13.0';
export const DEFAULT_MAX_UNTRUSTED_CHARS = 4000;

export const JUDGE_STATUS = Object.freeze({
  ok: 'ok',
  unavailable: 'unavailable',
  notRequested: 'not_requested',
  abstained: 'abstained',
});

/** Wrap untrusted text so the judge sees data, not an instruction. */
export function wrapUntrusted(label, text, maxChars = DEFAULT_MAX_UNTRUSTED_CHARS) {
  const body = String(text ?? '');
  const truncated = body.length > maxChars;
  const shown = truncated ? `${body.slice(0, maxChars)}\n[... truncated, ${body.length - maxChars} characters omitted]` : body;
  return {
    [`untrusted_${label}`]: `<untrusted:${label}>\n${shown}\n</untrusted:${label}>`,
    ...(truncated ? { [`untrusted_${label}_truncated`]: true } : {}),
  };
}

/**
 * Build the state the judge sees.
 *
 * Deliberately narrow: identity, the criterion being judged, and the evidence
 * facts that code already established. The claim is included as untrusted
 * context because a judge that cannot see what was claimed cannot notice a
 * contradiction — but it is never presented as fact.
 *
 * `evidence` carries the material each criterion resolved to, including file
 * excerpts where the collector captured them. Without it a semantic question is
 * unanswerable and the answer is a guess with a probability attached — which is
 * exactly how a `yes` used to become a pass with nothing behind it.
 */
export function buildState(request, facts, { maxUntrustedChars = DEFAULT_MAX_UNTRUSTED_CHARS } = {}) {
  const state = {
    taskId: request?.taskId ?? null,
    runId: request?.runId ?? null,
    mode: 'completion_check',
    instructions: 'Judge only the criterion given. Use the computed facts as ground truth. Do not evaluate anything that is not asked.',
  };
  if (request?.claims?.claimed) {
    Object.assign(state, wrapUntrusted('claim', request.claims.claimed, maxUntrustedChars));
  }
  if (request?.claims?.task) {
    Object.assign(state, wrapUntrusted('task', request.claims.task, maxUntrustedChars));
  }
  state.computed_facts = (facts ?? []).map((f) => ({
    criterionId: f.criterionId,
    result: f.result,
    reasonCode: f.reasonCode ?? null,
    sourceTrust: f.sourceTrust ?? null,
    coverage: f.coverage ?? 'unknown',
    supported: f.supported === true,
  }));
  // The material, keyed by criterion. Excerpts are wrapped like every other piece
  // of untrusted text: a file the agent wrote is data, not an instruction.
  const evidence = {};
  for (const f of facts ?? []) {
    if (!f.material) continue;
    const m = f.material;
    evidence[f.criterionId] = {
      kind: m.kind,
      path: m.path ?? null,
      bytes: m.bytes ?? null,
      sha256: m.sha256 ?? null,
      executable: m.executable ?? null,
      argv: m.argv ?? [],
      exit: m.exit ?? null,
      status: m.status ?? null,
      sourceTrust: m.sourceTrust ?? null,
      coverage: m.coverage ?? 'unknown',
      capturedAt: m.capturedAt ?? null,
      ...(typeof m.excerpt === 'string' && m.excerpt !== ''
        ? wrapUntrusted(`evidence_${f.criterionId}`, m.excerpt, maxUntrustedChars)
        : {}),
    };
  }
  if (Object.keys(evidence).length) state.evidence = evidence;
  return state;
}

/**
 * One question per semantic criterion.
 *
 * The shape is the documented one, not a convenient one: `instructions` is
 * required, and a noul's rubric lives under `criteria.true` / `criteria.false`.
 * An earlier version sent `{text, options}` and would have been rejected by the
 * API — it is asserted against the wire body in the tests now, so the fake judge
 * cannot bless a contract the real endpoint does not accept.
 */
export function buildQuestions(criteria, facts, { maxUntrustedChars = DEFAULT_MAX_UNTRUSTED_CHARS } = {}) {
  const factsById = new Map((facts ?? []).map((f) => [f.criterionId, f]));
  const questions = {};
  for (const criterion of criteria ?? []) {
    if (criterion.kind !== 'semantic') continue;
    const fact = factsById.get(criterion.id);
    // A criterion code already settled is not a question.
    if (fact && fact.result === 'fail') continue;
    // Neither is one with nothing to look at. Asking anyway would spend a call to
    // obtain an opinion that cannot be used, and would put an unanswerable
    // question in front of the judge.
    if (fact && fact.supported !== true) continue;

    const wrapped = wrapUntrusted('criterion', criterion.text, maxUntrustedChars);
    questions[criterion.id] = {
      type: 'noul',
      instructions: {
        question: 'Does the evidence support this criterion?',
        criterion: wrapped.untrusted_criterion,
        evidence_ref: `state.evidence.${criterion.id}`,
      },
      criteria: {
        true: 'The evidence shows the criterion holds. Answer yes only if the evidence itself shows it.',
        false: 'The evidence does not show the criterion holds, or there is not enough of it to tell.',
      },
    };
  }
  return questions;
}

/**
 * Build the wire body.
 *
 * One place builds the request, so the contract is asserted in one place. The
 * endpoint requires `state`, `model` and `questions`; every question requires
 * `type` and `instructions`, and each type has its own `criteria` shape. A body
 * that violates this is rejected here, before a request is made, rather than by
 * the endpoint after one has been paid for.
 */
export function buildRequest({ state, model = DEFAULT_MODEL, questions }) {
  const problems = [];
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    problems.push('questions must be a map');
  } else {
    for (const [id, q] of Object.entries(questions)) {
      if (!q || typeof q !== 'object') {
        problems.push(`${id}: question must be an object`);
        continue;
      }
      if (q.type !== 'noul' && q.type !== 'choice' && q.type !== 'score') {
        problems.push(`${id}: unknown question type ${JSON.stringify(q.type)}`);
      }
      if (q.instructions === undefined || q.instructions === null) {
        problems.push(`${id}: instructions is required`);
      }
      if (q.type === 'noul') {
        if (q.criteria !== undefined && (typeof q.criteria !== 'object' || q.criteria === null || Array.isArray(q.criteria))) {
          problems.push(`${id}: a noul criteria must be an object with true/false`);
        }
        for (const key of Object.keys(q.criteria ?? {})) {
          if (key !== 'true' && key !== 'false') problems.push(`${id}: noul criteria has an unexpected key ${JSON.stringify(key)}`);
        }
      }
      if (q.type === 'score' && q.criteria !== undefined && !Array.isArray(q.criteria)) {
        problems.push(`${id}: a score criteria must be an array`);
      }
      if (q.type === 'choice' && q.criteria !== undefined && (typeof q.criteria !== 'object' || Array.isArray(q.criteria))) {
        problems.push(`${id}: a choice criteria must be a map`);
      }
    }
  }
  if (problems.length) {
    const error = new Error(`invalid judge request: ${problems.join('; ')}`);
    error.code = 'invalid_request_shape';
    error.problems = problems;
    throw error;
  }
  return { state, model, questions };
}

/**
 * Ask the judge.
 *
 * Returns a status rather than throwing: an unreachable judge is `unavailable`,
 * and the policy turns that into `unverified`. It never becomes a block and it
 * never becomes a confirmation (INV-07).
 */
export async function askJudge({
  state,
  questions,
  apiKey = null,
  model = DEFAULT_MODEL,
  transport = null,
  endpoint = JUDGE_ENDPOINT,
  credentials = {},
} = {}) {
  if (!questions || Object.keys(questions).length === 0) {
    return { status: JUDGE_STATUS.notRequested, answers: {}, errors: [], usage: null, reason: 'no semantic criteria' };
  }

  let body;
  try {
    body = buildRequest({ state, model, questions });
  } catch (error) {
    // A malformed body is a defect in this code, not a judge outage. It is
    // reported as abstention with the reason, never sent.
    return { status: JUDGE_STATUS.abstained, answers: {}, errors: [], usage: null, reason: error.message };
  }

  let key = apiKey;
  if (!key) {
    const resolved = resolveApiKey(credentials);
    if (!resolved.ok) {
      return { status: JUDGE_STATUS.unavailable, answers: {}, errors: [], usage: null, reason: resolved.code };
    }
    key = resolved.value;
  }

  const tx = transport ?? createTransport();
  const result = await tx.postJson(
    endpoint,
    body,
    { headers: { Authorization: `Bearer ${key}` } },
  );

  if (!result.ok) {
    return { status: JUDGE_STATUS.unavailable, answers: {}, errors: [], usage: null, reason: result.code, attempts: result.attempts };
  }

  const payload = result.json ?? {};
  const answers = payload.answers ?? payload.answer ?? {};
  const usage = payload.usage ?? null;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return { status: JUDGE_STATUS.abstained, answers: {}, errors: [], usage, reason: 'the judge returned no answer object' };
  }
  return { status: JUDGE_STATUS.ok, answers, errors: [], usage, reason: null, attempts: result.attempts };
}
