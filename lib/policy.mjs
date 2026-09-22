/**
 * The completion policy (REQ-02). Pure: no filesystem, no clock, no network.
 *
 * Everything that can be decided by code is decided here, from facts that were
 * already collected. The model contributes probabilities and nothing else.
 *
 * The invariants this file exists to hold (spec 6):
 *   INV-01  a successful report and a factual failure must not become `done`
 *   INV-05  missing evidence is not proof of absence and never becomes a pass
 *   INV-06  an empty list of checks is not a successful completion
 *   INV-07  a missing answer is not a successful answer
 *   INV-08  a self-report does not raise the level of evidence
 *
 * Order of precedence is deliberate and is the fix for the reviewed defect V01:
 * deterministic facts outrank model opinions. A confident "yes" from the judge
 * cannot lift a criterion that code already found failed.
 */

export const POLICY_VERSION = '2.0.0';

/** Statuses and their exit codes. The exit code is the machine contract. */
export const STATUS = Object.freeze({ done: 'done', not_done: 'not_done', review: 'review', unverified: 'unverified' });
export const STATUS_EXIT = Object.freeze({ done: 0, not_done: 1, review: 2, unverified: 3 });

/**
 * Default thresholds. `calibrated: false` is not decoration: it records that
 * nobody measured these numbers on this task, and it travels into every decision
 * record so a report can say so out loud.
 */
export const DEFAULT_THRESHOLDS = Object.freeze({ no: 0.2, yes: 0.8, calibrated: false });

/**
 * Enforcement levels. `advisory` means the verdict informs a human; `blocking`
 * means the calling adapter is allowed to stop an action on it. Only an adapter
 * that has been verified at runtime may claim `blocking` (spec 9.3).
 */
export const ENFORCEMENT = Object.freeze({
  advisory: Object.freeze({ level: 'advisory', canBlock: false }),
  blocking: Object.freeze({ level: 'blocking', canBlock: true }),
});

export const REASON = Object.freeze({
  schemaInvalid: 'schema_invalid',
  noVerifiableCriteria: 'no_verifiable_criteria',
  requiredUnknown: 'required_criterion_unknown',
  requiredFailed: 'required_criterion_failed',
  selfReportedOnly: 'self_reported_only',
  judgeUnavailable: 'judge_unavailable',
  judgeAbstained: 'judge_abstained',
  answerInvalid: 'answer_invalid',
  reviewBand: 'threshold_review_band',
  thresholdsUncalibrated: 'thresholds_uncalibrated',
  evidenceStale: 'evidence_stale',
  evidenceScopeMismatch: 'evidence_scope_mismatch',
  evidencePartial: 'evidence_partial_coverage',
  observationUnstable: 'observation_unstable',
  deterministicConflict: 'deterministic_conflict_with_claim',
  legacyUntrusted: 'legacy_untrusted',
  optionalUnknown: 'optional_criterion_unknown',
  // A model said yes to a question that had no material attached to it. The
  // opinion is recorded, the pass is not granted: INV-08.
  unsupportedByEvidence: 'unsupported_by_evidence',
  // Evidence gathered for a different task or run was offered for this one.
  foreignObservation: 'foreign_observation',
  trustDowngraded: 'provenance_not_self_assignable',
  allCriteriaPassed: 'all_required_criteria_passed',
});

const TRUST_RANK = { self_reported: 0, collector_observed: 1, harness_observed: 2 };
export const INDEPENDENT_TRUST = ['collector_observed', 'harness_observed'];

/** Thresholds must be ordered, bounded and finite. A wrong pair is invalid input. */
export function normalizeThresholds(input) {
  if (input === undefined || input === null) return { ok: true, value: { ...DEFAULT_THRESHOLDS } };
  const { no, yes } = input;
  for (const [name, v] of [['no', no], ['yes', yes]]) {
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
      return { ok: false, code: 'invalid_threshold', detail: `${name} must be a finite number in [0, 1]` };
    }
  }
  const value = {
    no: no ?? DEFAULT_THRESHOLDS.no,
    yes: yes ?? DEFAULT_THRESHOLDS.yes,
    calibrated: input.calibrated === true,
  };
  if (!(value.no < value.yes)) {
    return { ok: false, code: 'invalid_threshold', detail: 'expected no < yes' };
  }
  return { ok: true, value };
}

/**
 * A probability becomes a verdict. Anything that is not a finite number in
 * [0, 1] is `unverified` — the defect was that 2 read as a confident yes.
 */
export function decideFromProbability(p, thresholds = DEFAULT_THRESHOLDS) {
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return 'unverified';
  if (p >= thresholds.yes) return 'yes';
  if (p <= thresholds.no) return 'no';
  return 'review';
}

/**
 * Turn criterion facts into a decision.
 *
 * `criterionFacts` is produced by the evidence layer and carries only what code
 * observed: `{ criterionId, result: 'pass'|'fail'|'unknown'|'not_applicable',
 * reasonCode, refs, sourceTrust, coverage, fresh }`.
 *
 * `answers` holds validated model probabilities keyed by criterion id, and
 * `answerErrors` holds the ids whose answers were rejected as malformed.
 */
/**
 * Pull a probability out of an answer, whichever shape it arrived in.
 *
 * The validated form is `{value}`, the wire form is `{type:'noul', noul}`. Both
 * are read here so that an opinion about a criterion that was never asked can
 * still be recorded: dropping it would erase the disagreement from the report.
 */
function numericAnswer(answer) {
  if (!answer || typeof answer !== 'object') return null;
  if (typeof answer.value === 'number') return answer.value;
  if (typeof answer.noul === 'number') return answer.noul;
  return null;
}

export function decideCompletion({
  request,
  criterionFacts = [],
  answers = {},
  answerErrors = [],
  thresholds = DEFAULT_THRESHOLDS,
  judgeStatus = 'not_requested',
  judgeReason = null,
  enforcement = ENFORCEMENT.advisory,
  policyVersion = POLICY_VERSION,
  observations = null,
  rawAnswers = null,
} = {}) {
  const reasons = [];
  const push = (code, detail) => {
    if (!reasons.some((r) => r.code === code && r.detail === detail)) reasons.push({ code, detail });
  };

  const criteria = request?.criteria ?? [];
  const factsById = new Map(criterionFacts.map((f) => [f.criterionId, f]));
  const required = criteria.filter((c) => c.required !== false);
  const invalidAnswerIds = new Set(answerErrors.map((e) => e.id));
  for (const e of answerErrors) push(REASON.answerInvalid, `${e.id}: ${e.code}`);
  // An inline observation that called itself independent is worth saying out loud:
  // the caller believed it was supplying collector-grade evidence, and it was not.
  // The list comes from the caller because it is the merged, normalized one — the
  // raw request still carries the trust level the claimant asked for.
  for (const obs of observations ?? request?.observations ?? []) {
    if (obs.trustDowngraded) {
      push(REASON.trustDowngraded, `${obs.observationId}: declared "${obs.declaredSourceTrust}" but arrived inside the request, so it was recorded as self_reported`);
    }
  }

  const rows = [];
  let deterministicFail = false;
  let anyPass = false;

  for (const criterion of criteria) {
    const fact = factsById.get(criterion.id) ?? {
      criterionId: criterion.id,
      result: 'unknown',
      reasonCode: REASON.requiredUnknown,
      refs: [],
      sourceTrust: null,
      coverage: 'unknown',
      fresh: null,
    };
    const isRequired = criterion.required !== false;
    const row = {
      criterionId: criterion.id,
      kind: criterion.kind,
      required: isRequired,
      deterministicResult: fact.result,
      reasonCode: fact.reasonCode ?? null,
      refs: fact.refs ?? [],
      sourceTrust: fact.sourceTrust ?? null,
      coverage: fact.coverage ?? 'unknown',
      fresh: fact.fresh ?? null,
      supported: fact.supported === true,
      foreignRefs: fact.foreignRefs ?? [],
      modelProbability: null,
      modelVerdict: null,
      decision: null,
    };
    if (row.foreignRefs.length) {
      push(REASON.foreignObservation, `${criterion.id}: ${row.foreignRefs.length} observation(s) belong to another task or run`);
    }

    if (fact.result === 'fail') {
      row.decision = 'fail';
      deterministicFail = true;
      push(REASON.requiredFailed, `${criterion.id}: ${fact.reasonCode ?? 'a deterministic check failed'}`);
    } else if (fact.result === 'pass') {
      // A pass on self-reported evidence is not a pass in completion mode.
      if (!INDEPENDENT_TRUST.includes(fact.sourceTrust)) {
        row.decision = 'unverified';
        push(REASON.selfReportedOnly, `${criterion.id}: only self-reported evidence`);
      } else if (fact.coverage === 'unknown') {
        row.decision = 'unverified';
        push(REASON.evidencePartial, `${criterion.id}: coverage unknown`);
      } else if (fact.coverage === 'partial') {
        row.decision = 'unverified';
        push(REASON.evidencePartial, `${criterion.id}: partial coverage`);
      } else if (fact.fresh === false) {
        row.decision = 'unverified';
        push(REASON.evidenceStale, `${criterion.id}: the observation is stale`);
      } else {
        row.decision = 'pass';
        anyPass = true;
      }
    } else if (criterion.kind === 'semantic') {
      // Semantic criteria are the only place a model probability is allowed in.
      // They are also the only place a model opinion was, until now, allowed to
      // become a pass with nothing behind it. `fact.supported` closes that: a
      // criterion with no resolvable material cannot pass, and cannot fail,
      // whatever the model answers. The opinion is recorded either way.
      const answer = answers[criterion.id];
      // Support is checked BEFORE answer validity. When the criterion has no
      // material it was never turned into a question, so its answer arrives as
      // "an answer to a question that was never asked" — a true statement about
      // the batch and a misleading one about this criterion. The real reason is
      // that there was nothing to judge, and saying so keeps the model's own
      // answer visible for diagnosis.
      if (fact.supported !== true) {
        row.decision = 'unverified';
        // The answer to a question that was never asked is dropped by answer
        // validation, so the raw answer is consulted to keep the model's opinion
        // in the record. Without it a confident yes would vanish from the report
        // and the disagreement would be invisible.
        const opinion = numericAnswer(answer) ?? numericAnswer(rawAnswers?.[criterion.id]);
        if (opinion !== null) {
          row.modelProbability = opinion;
          row.modelVerdict = decideFromProbability(opinion, thresholds);
        }
        push(
          REASON.unsupportedByEvidence,
          `${criterion.id}: no evidence was resolved for this criterion, so no question was asked — ${row.modelVerdict ?? 'the answer'} is recorded as the model's opinion, not as a fact`,
        );
      } else if (invalidAnswerIds.has(criterion.id)) {
        row.decision = 'unverified';
      } else if (!answer || typeof answer.value !== 'number') {
        row.decision = 'unverified';
        if (judgeStatus === 'unavailable') push(REASON.judgeUnavailable, judgeReason ?? 'the judge was unreachable');
        else push(REASON.judgeAbstained, `${criterion.id}: no usable answer`);
      } else {
        const verdict = decideFromProbability(answer.value, thresholds);
        row.modelProbability = answer.value;
        row.modelVerdict = verdict;
        if (verdict === 'yes') {
          row.decision = 'pass';
          anyPass = true;
        } else if (verdict === 'no') {
          row.decision = 'fail';
        } else if (verdict === 'review') {
          row.decision = 'review';
          push(REASON.reviewBand, `${criterion.id}: ${answer.value.toFixed(3)} is inside the review band`);
        } else {
          row.decision = 'unverified';
        }
      }
    } else {
      // A deterministic criterion with no usable fact: absence of evidence.
      row.decision = isRequired ? 'unverified' : 'not_applicable';
      if (isRequired) push(REASON.requiredUnknown, `${criterion.id}: ${fact.reasonCode ?? 'no evidence'}`);
      else push(REASON.optionalUnknown, `${criterion.id}: optional criterion has no evidence`);
    }

    if (!isRequired && row.decision === 'unverified') row.decision = 'not_applicable';
    rows.push(row);
  }

  // INV-06: an empty criterion list is not a successful completion.
  const evaluated = rows.filter((r) => r.decision !== 'not_applicable');
  if (evaluated.length === 0) {
    push(REASON.noVerifiableCriteria, 'there is nothing to evaluate: no applicable criteria');
  }

  const requiredRows = rows.filter((r) => r.required);
  const failed = requiredRows.filter((r) => r.decision === 'fail');
  const unverified = requiredRows.filter((r) => r.decision === 'unverified');
  const review = requiredRows.filter((r) => r.decision === 'review');
  const passed = requiredRows.filter((r) => r.decision === 'pass');

  let status;
  if (evaluated.length === 0) {
    status = STATUS.unverified;
  } else if (failed.length > 0) {
    status = STATUS.not_done;
    if (Object.keys(answers).length > 0) push(REASON.deterministicConflict, 'the judge approved while code found a failure');
  } else if (review.length > 0) {
    status = STATUS.review;
  } else if (unverified.length > 0) {
    status = STATUS.unverified;
  } else if (passed.length === requiredRows.length && requiredRows.length > 0) {
    status = STATUS.done;
    // The wording matters. A semantic pass now requires resolved material, but
    // that material may itself be self-reported, so "independent" is not always
    // true. The trust level is reported separately, and this line does not
    // overstate it.
    push(REASON.allCriteriaPassed, `all ${requiredRows.length} required criteria passed, each backed by resolved evidence`);
  } else {
    status = STATUS.unverified;
  }

  // The model's approval is recorded even when code overruled it: a report that
  // hides the disagreement is useless for tuning the rubric.
  //
  // `!== 'ok'`, not `=== 'not_requested'`. An abstention is the judge declining to
  // answer, which is missing evidence, not an answer — and a criterion the author
  // declared semantic reaching `done` with no usable judgement behind it is a pass
  // this product exists to refuse. The narrower test let `abstained` through: the
  // judge was asked, said nothing, and completion was confirmed anyway.
  if (status === STATUS.done && judgeStatus !== 'ok' && criteria.some((c) => c.kind === 'semantic')) {
    status = STATUS.unverified;
    push(REASON.judgeUnavailable, `semantic criteria exist but the judge did not answer (${judgeStatus})`);
  }

  if (thresholds.calibrated !== true) push(REASON.thresholdsUncalibrated, 'the thresholds were not calibrated on this task');

  const scope = [...new Set(rows.flatMap((r) => (r.decision === 'pass' ? r.refs : [])))];
  // Only criteria backed by evidence contribute to the evidence trust level. A
  // semantic criterion decided by the judge has no observation behind it, and
  // letting it count as "self_reported" would understate evidence that really
  // was observed by the harness.
  const evidenceRows = rows.filter((r) => r.decision === 'pass' && r.sourceTrust);
  const trustLevels = evidenceRows.map((r) => TRUST_RANK[r.sourceTrust] ?? 0);
  const sourceTrust = trustLevels.length
    ? Object.keys(TRUST_RANK).find((k) => TRUST_RANK[k] === Math.min(...trustLevels))
    : null;

  return {
    schemaVersion: 2,
    kind: 'completion',
    policyVersion,
    status,
    exitCode: STATUS_EXIT[status],
    reasonCodes: reasons,
    taskId: request?.taskId ?? null,
    runId: request?.runId ?? null,
    mode: request?.mode ?? 'completion',
    verificationScope: scope,
    sourceTrust,
    basis: {
      criteriaTotal: criteria.length,
      requiredTotal: requiredRows.length,
      passed: passed.length,
      failed: failed.length,
      review: review.length,
      unverified: unverified.length,
      evidenceBacked: evidenceRows.length,
      judged: rows.filter((r) => r.modelProbability !== null).length,
      deterministicFailures: deterministicFail ? rows.filter((r) => r.deterministicResult === 'fail').map((r) => r.criterionId) : [],
    },
    thresholds,
    calibrated: thresholds.calibrated === true,
    enforcement: { level: enforcement.level, canBlock: enforcement.canBlock },
    judge: { status: judgeStatus, reason: judgeReason },
    rows,
  };
}

/** Every status a caller must handle, with the meaning it carries. */
export const STATUS_MEANING = Object.freeze({
  done: 'every required criterion is supported by independent evidence',
  not_done: 'a deterministic check failed, or the evidence contradicts the claim',
  review: 'the evidence is not decisive: a human decides',
  unverified: 'the claim is not confirmed — this is not a prohibition',
});
