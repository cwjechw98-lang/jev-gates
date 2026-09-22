/**
 * Decision journal and replay (REQ-06).
 *
 * A decision record has to be enough to answer three questions later:
 * what was decided, on what basis, and would the same input decide the same way
 * today. The record therefore stores the *basis* — the counted facts — and not
 * only the verdict. A verdict alone cannot be replayed, and a replay that
 * silently invents a basis is worse than no replay at all.
 *
 * Three replay modes, and the honest difference between them:
 *   policy  re-runs the thresholds over the stored basis, no model, no network
 *   render  prints the human report from the record
 *   model   re-asks the recorded questions — needs the API, so it is refused
 *           unless live execution is explicitly authorised
 *
 * Legacy records (written before the policy had a version) carry digests and a
 * verdict but no basis. They replay as `partial`: the journal says so instead of
 * presenting a guess as a reproduction.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideFromProbability } from './policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const JOURNAL_VERSION = 2;
export const REPLAY_MODE = Object.freeze({ policy: 'policy', render: 'render', model: 'model' });

/** Journals live in $JEV_GATES_HOME when set, otherwise next to the modules. */
export function journalHome() {
  const custom = process.env.JEV_GATES_HOME;
  if (!custom) return join(HERE, '..');
  if (!existsSync(custom)) mkdirSync(custom, { recursive: true });
  return custom;
}

export const journalPath = () => join(journalHome(), 'jev-decisions.jsonl');

/**
 * Build a record. `at` and `id` are parameters so a replay can be deterministic.
 */
export function makeRecord(fields, { at = new Date().toISOString(), id = null } = {}) {
  return {
    journalVersion: JOURNAL_VERSION,
    at,
    id: id ?? `${at}-${Math.random().toString(36).slice(2, 8)}`,
    ...fields,
  };
}

export function appendRecord(record, { path = journalPath() } = {}) {
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

/**
 * Read a journal.
 *
 * A corrupt line is not an exception and not a silent skip: it is counted, and
 * `complete` becomes false so a caller cannot present a partial journal as the
 * whole audit trail (T23).
 */
export function readJournal({ path = journalPath() } = {}) {
  if (!existsSync(path)) {
    return { records: [], corrupt: [], complete: false, exists: false, path, total: 0 };
  }
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const records = [];
  const corrupt = [];
  lines.forEach((line, i) => {
    try {
      records.push(JSON.parse(line));
    } catch {
      // A partially written trailing line is the common case; it is reported
      // with its line number and no content.
      corrupt.push({ line: i + 1, reason: 'invalid_json' });
    }
  });
  return { records, corrupt, complete: corrupt.length === 0, exists: true, path, total: lines.length };
}

export function findRecord(id, options = {}) {
  const journal = readJournal(options);
  const exact = journal.records.find((r) => r.id === id);
  if (exact) return { record: exact, journal };
  const tail = journal.records[journal.records.length - 1];
  return { record: tail ?? null, journal };
}

/**
 * Replay the policy over a record's stored basis.
 *
 * Exact only when the record carries everything the policy needs. Anything less
 * is `partial`, and the note says which field is missing.
 */
export function replayPolicy(record, { thresholds = null } = {}) {
  if (!record) return { ok: false, exact: false, status: null, note: 'no record' };

  const effectiveThresholds = thresholds ?? record.thresholds ?? null;
  if (!record.basis || !effectiveThresholds) {
    return {
      ok: true,
      exact: false,
      status: 'unverified',
      note: `partial replay: the record has no ${record.basis ? 'thresholds' : 'basis'}; a verdict cannot be reproduced from digests alone`,
      originalStatus: record.verdict ?? null,
      reasonCodes: record.reasonCodes ?? [],
    };
  }

  const basis = record.basis;
  const rows = Array.isArray(record.rows) ? record.rows : null;
  const reasonCodes = [];

  // Prefer the stored rows: they carry the per-criterion probabilities, so the
  // thresholds are applied to the same numbers the first run used.
  if (rows) {
    let failed = 0;
    let review = 0;
    let unverified = 0;
    let passed = 0;
    let required = 0;
    for (const row of rows) {
      if (row.required === false) continue;
      required += 1;
      const verdict = row.modelProbability === null || row.modelProbability === undefined
        ? row.decision
        : decideFromProbability(row.modelProbability, { no: effectiveThresholds.no, yes: effectiveThresholds.yes });
      if (row.deterministicResult === 'fail') failed += 1;
      else if (verdict === 'fail' || verdict === 'no') failed += 1;
      else if (verdict === 'review') review += 1;
      else if (verdict === 'pass' || verdict === 'yes') passed += 1;
      else unverified += 1;
    }
    let status;
    if (required === 0) status = 'unverified';
    else if (failed > 0) status = 'not_done';
    else if (review > 0) status = 'review';
    else if (unverified > 0) status = 'unverified';
    else status = passed === required ? 'done' : 'unverified';
    reasonCodes.push(...(record.reasonCodes ?? []).map((r) => r.code));
    return { ok: true, exact: true, status, originalStatus: record.verdict ?? null, matches: status === record.verdict, basis: { required, passed, failed, review, unverified }, reasonCodes };
  }

  // No rows: the basis counts are enough to reproduce the status.
  const { failed = 0, review = 0, unverified = 0, passed = 0, requiredTotal = 0 } = basis;
  let status;
  if (requiredTotal === 0) status = 'unverified';
  else if (failed > 0) status = 'not_done';
  else if (review > 0) status = 'review';
  else if (unverified > 0) status = 'unverified';
  else status = passed === requiredTotal ? 'done' : 'unverified';
  return {
    ok: true,
    exact: true,
    status,
    originalStatus: record.verdict ?? null,
    matches: status === record.verdict,
    basis,
    reasonCodes: (record.reasonCodes ?? []).map((r) => r.code),
  };
}

/** Render the human report from a record. No model, no network. */
export function replayRender(record) {
  if (!record) return 'no record';
  const lines = [];
  lines.push(`record: ${record.id ?? '(no id)'} at ${record.at ?? '(no timestamp)'}`);
  lines.push(`kind: ${record.kind ?? '-'}   label: ${record.label ?? '-'}`);
  lines.push(`verdict: ${record.verdict ?? '-'}   policyVersion: ${record.policyVersion ?? '(legacy)'}`);
  lines.push(`reason codes: ${(record.reasonCodes ?? []).map((r) => r.code).join(', ') || record.reason || 'none'}`);
  if (record.thresholds) lines.push(`thresholds: no<=${record.thresholds.no} yes>=${record.thresholds.yes} calibrated=${record.thresholds.calibrated}`);
  if (record.basis) lines.push(`basis: ${JSON.stringify(record.basis)}`);
  if (record.sourceTrust) lines.push(`source trust: ${record.sourceTrust}`);
  if (record.stateDigest) lines.push(`state digest: ${record.stateDigest}   questions: ${record.questionDigest ?? '-'}`);
  if (Array.isArray(record.rows) && record.rows.length) {
    lines.push('');
    for (const row of record.rows) {
      const p = row.modelProbability === null || row.modelProbability === undefined ? '   -  ' : row.modelProbability.toFixed(2).padStart(6);
      lines.push(`  ${String(row.criterionId).padEnd(22)} ${String(row.deterministicResult).padEnd(14)} ${p}   ${row.decision}`);
    }
  }
  lines.push('');
  lines.push('note: replaying a record reproduces the decision from the recorded basis.');
  lines.push('note: it does not re-verify the evidence — a record is a statement about the past, not a fresh measurement.');
  return lines.join('\n');
}

/**
 * Re-ask the recorded questions.
 *
 * Deliberately refuses by default: re-running the model costs money and produces
 * a *different* number, so it must be an explicit act, not a side effect of
 * asking for a replay.
 */
export function replayModel(record, { allowLive = false } = {}) {
  if (!record) return { ok: false, reason: 'no record' };
  if (!record.questions || Object.keys(record.questions).length === 0) {
    return { ok: false, reason: 'the record stored no questions' };
  }
  if (!allowLive) {
    return {
      ok: false,
      reason: 'model replay needs the API and is refused without --allow-live',
      questions: record.questions,
      state: record.state ?? null,
    };
  }
  return { ok: true, questions: record.questions, state: record.state ?? null, note: 'call the judge with these' };
}

/**
 * Threshold sweep over the stored rows: how sensitive was this verdict?
 *
 * The upper edge is swept because that is the one that turns a pass into a
 * question. A verdict that survives the whole range was decided by the evidence;
 * one that flips in the middle was decided by the threshold, and that is worth
 * knowing before trusting it.
 */
export function thresholdSensitivity(record, { steps = 9, from = 0.5, to = 1 } = {}) {
  const rows = Array.isArray(record?.rows) ? record.rows : null;
  if (!rows) return { ok: false, note: 'the record stored no rows' };
  const probabilities = rows.filter((r) => r.modelProbability !== null && r.modelProbability !== undefined).map((r) => r.modelProbability);
  if (probabilities.length === 0) return { ok: false, note: 'no model probabilities were recorded' };
  const no = record.thresholds?.no ?? 0.2;
  const sweep = [];
  const flipPoints = [];
  for (let i = 0; i <= steps; i += 1) {
    const yes = from + (i / steps) * (to - from);
    const decisions = probabilities.map((p) => decideFromProbability(p, { no, yes }));
    sweep.push({ yes: Number(yes.toFixed(3)), no, decisions });
    if (i > 0 && decisions.join(',') !== sweep[i - 1].decisions.join(',')) {
      flipPoints.push({ between: [sweep[i - 1].yes, Number(yes.toFixed(3))], decisions });
    }
  }
  return {
    ok: true,
    no,
    sweep,
    flipPoints,
    stable: flipPoints.length === 0,
    note: flipPoints.length === 0
      ? 'the verdict survives the whole swept range'
      : `the verdict changes at ${flipPoints.length} point(s) in the swept range`,
  };
}
