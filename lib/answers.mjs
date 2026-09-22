/**
 * Answer validation (REQ-04, 8.2).
 *
 * A probability outside [0, 1], a NaN, an Infinity or a label that was not on
 * the list are not "roughly right". They are invalid, and an invalid answer
 * leaves its question unanswered — which means `unverified`, never `yes`.
 *
 * Why this is a whole module: the reviewed defect list showed that a literal 2
 * travels through JSON happily and lands above any threshold, so "2" silently
 * became a confident yes. Type-level validation is the only place that stops it.
 */

/** Comparison tolerance for probabilities and distributions. */
export const PROBABILITY_TOLERANCE = 1e-9;
/** A choice distribution is accepted when it sums to 1 within this margin. */
export const DISTRIBUTION_TOLERANCE = 1e-3;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

function probabilityError(value) {
  if (value === undefined || value === null) return 'missing_value';
  if (typeof value !== 'number') return 'not_a_number';
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return 'not_finite';
  if (value < 0 || value > 1) return 'out_of_range';
  return null;
}

/**
 * Noul: a single probability.
 * `{ noul: 0.93 }` -> valid; `{ noul: 2 }`, `{ noul: NaN }`, `{ noul: "0.9" }` -> invalid.
 */
export function validateNoul(id, answer) {
  const code = probabilityError(answer?.noul);
  if (code) return { ok: false, id, type: 'noul', code, detail: 'expected a probability in [0, 1]' };
  return { ok: true, id, type: 'noul', value: answer.noul };
}

/**
 * Choice: the label must be one of the options the question offered, and the
 * distribution, when present, must be a probability vector over those options.
 * A label that was never offered is not a decision — it is a different question.
 */
export function validateChoice(id, answer, question = {}) {
  const options = Array.isArray(question.options) ? question.options : null;
  if (typeof answer?.choice !== 'string' || answer.choice === '') {
    return { ok: false, id, type: 'choice', code: 'missing_value', detail: 'expected a choice label' };
  }
  if (options && !options.includes(answer.choice)) {
    return { ok: false, id, type: 'choice', code: 'label_not_offered', detail: 'the label is not one of the offered options' };
  }
  const dist = answer.probabilities;
  if (dist !== undefined && dist !== null) {
    if (typeof dist !== 'object' || Array.isArray(dist)) {
      return { ok: false, id, type: 'choice', code: 'bad_distribution', detail: 'expected an object of label -> probability' };
    }
    let sum = 0;
    for (const [label, p] of Object.entries(dist)) {
      if (options && !options.includes(label)) {
        return { ok: false, id, type: 'choice', code: 'distribution_label_not_offered', detail: 'the distribution mentions a label that was not offered' };
      }
      const code = probabilityError(p);
      if (code) return { ok: false, id, type: 'choice', code: `distribution_${code}`, detail: 'expected probabilities in [0, 1]' };
      sum += p;
    }
    if (Math.abs(sum - 1) > DISTRIBUTION_TOLERANCE) {
      return { ok: false, id, type: 'choice', code: 'distribution_not_normalized', detail: `the distribution sums to ${sum.toFixed(6)}` };
    }
  }
  return { ok: true, id, type: 'choice', value: answer.choice, probabilities: dist ?? null, confidence: isFiniteNumber(answer.confidence) ? answer.confidence : null };
}

/**
 * Score: a position on a declared discrete scale. A score outside the scale is
 * rejected rather than clamped — clamping would invent a judgment nobody made.
 */
export function validateScore(id, answer, question = {}) {
  if (!isFiniteNumber(answer?.score)) {
    const code = answer?.score === undefined ? 'missing_value' : probabilityError(answer.score) ? 'not_a_number' : 'invalid';
    return { ok: false, id, type: 'score', code, detail: 'expected a finite score' };
  }
  const levels = Array.isArray(question.levels) ? question.levels : null;
  if (levels && levels.length) {
    const values = levels.map((l) => (isFiniteNumber(l) ? l : l?.value)).filter(isFiniteNumber);
    if (values.length && !values.includes(answer.score)) {
      return { ok: false, id, type: 'score', code: 'score_not_on_scale', detail: 'the score is not one of the declared levels' };
    }
  }
  return { ok: true, id, type: 'score', value: answer.score, probabilities: answer.probabilities ?? null, confidence: isFiniteNumber(answer.confidence) ? answer.confidence : null };
}

/**
 * Validate a whole answer set against the questions that were asked.
 *
 * Returns only well-formed answers in `flat`. Every rejection is reported with
 * its question id and a reason code, and the caller must treat the missing
 * question as unanswered.
 */
export function validateAnswers(answers, questions) {
  const errors = [];
  const flat = {};
  const source = answers && typeof answers === 'object' ? answers : {};

  for (const [id, question] of Object.entries(questions ?? {})) {
    const answer = source[id];
    if (answer === undefined || answer === null) {
      errors.push({ id, code: 'no_answer', detail: 'the judge returned nothing for this question' });
      continue;
    }
    let result;
    if (question.type === 'noul') result = validateNoul(id, answer);
    else if (question.type === 'choice') result = validateChoice(id, answer, question);
    else if (question.type === 'score') result = validateScore(id, answer, question);
    else {
      errors.push({ id, code: 'unknown_question_type', detail: `unsupported question type` });
      continue;
    }
    if (result.ok) flat[id] = { type: result.type, value: result.value, probabilities: result.probabilities ?? null, confidence: result.confidence ?? null };
    else errors.push({ id, code: result.code, detail: result.detail });
  }

  // Answers to questions nobody asked are reported, not silently kept.
  for (const id of Object.keys(source)) {
    if (!(id in (questions ?? {}))) {
      errors.push({ id, code: 'unexpected_answer', detail: 'an answer arrived for a question that was not asked' });
    }
  }

  return { ok: errors.length === 0, flat, errors };
}
