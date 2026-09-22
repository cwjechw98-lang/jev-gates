#!/usr/bin/env node
/**
 * Replay the decision journal (REQ-06, stage D).
 *
 * Three modes, and the difference between them is the whole point:
 *
 *   policy  re-decides a recorded verdict from the recorded probabilities. No
 *           model, no network — so it answers "would a different threshold have
 *           changed the answer?" without spending anything.
 *   render  reproduces the human report from the record alone.
 *   model   re-asks the judge. This is the ONLY mode that can cost money, so it
 *           refuses unless `--allow-live` is passed explicitly.
 *
 * A record that predates the current policy version replays as `partial`: the
 * numbers are there but the basis is not, and saying "exact" about it would be a
 * claim the record cannot support.
 */
import { fileURLToPath } from 'node:url';
import { readJournal, findRecord, replayPolicy, replayRender, replayModel, thresholdSensitivity, journalPath } from '../lib/journal.mjs';
import { STATUS_EXIT } from '../lib/policy.mjs';

export function replayCommand(argv = process.argv.slice(2)) {
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i > -1 ? argv[i + 1] ?? true : undefined;
  };
  const mode = argv[0] ?? 'list';
  const id = flag('id');
  const path = flag('journal') ?? journalPath();

  if (mode === 'list' || mode === 'summary') {
    const journal = readJournal({ path });
    return {
      kind: 'list',
      exitCode: 0,
      journal,
      text: renderJournal(journal),
    };
  }

  if (!['policy', 'render', 'model', 'sweep'].includes(mode)) {
    return { kind: 'usage', exitCode: 2, text: 'usage: jev-replay <list|policy|render|model|sweep> [--id <record>] [--journal <path>] [--yes 0.8] [--no 0.2] [--allow-live]' };
  }

  const found = id ? findRecord(id, { path }) : lastRecord(path);
  if (!found.record) {
    return {
      kind: mode,
      exitCode: 3,
      missing: true,
      text: `no record found${id ? ` with id ${id}` : ' in the journal'} at ${path}\nthe journal is ${found.journal?.exists ? 'present but empty' : 'absent'} — nothing to replay, and an absent record is not a pass`,
    };
  }

  if (mode === 'render') {
    return { kind: mode, exitCode: 0, record: found.record, text: replayRender(found.record) };
  }

  if (mode === 'policy') {
    const yes = flag('yes');
    const no = flag('no');
    const thresholds = yes !== undefined || no !== undefined ? { yes: Number(yes ?? 0.8), no: Number(no ?? 0.2), calibrated: false } : null;
    const result = replayPolicy(found.record, { thresholds });
    // `status` and `verdict` are both read: records written by different versions
    // of the gate carry one or the other, and reading only one would report a
    // verdict of `undefined` about a perfectly good record.
    const status = result.status ?? found.record.status ?? found.record.verdict ?? null;
    // The exit code is derived from the status through the CURRENT policy, not
    // copied from the record. Copying it would print exit 0 next to a `review`
    // verdict as soon as the thresholds are overridden — a contradiction in the
    // one place a reader is least likely to question it.
    const exitCode = status === null ? null : STATUS_EXIT[status] ?? null;
    const lines = [
      `record: ${found.record.id ?? '(no id)'} at ${found.record.at ?? '(no timestamp)'}`,
      `replay: ${result.exact ? 'exact' : 'partial'}${result.note ? ` — ${result.note}` : ''}`,
      `status: ${status ?? '(not recorded)'}${exitCode === null ? '' : ` (exit ${exitCode})`}`,
    ];
    if (status === null) lines.push('the record stores no verdict, so this replay can only describe the inputs.');
    if (found.record.exitCode !== undefined && found.record.exitCode !== exitCode) {
      lines.push(`note: the record stored exit ${found.record.exitCode}; the current policy maps ${status} to exit ${exitCode}.`);
    }
    if (thresholds) lines.push(`thresholds used: yes=${thresholds.yes} no=${thresholds.no} (stated, not calibrated)`);
    if (!result.exact) lines.push('a partial replay describes the record, not the work: the basis was not stored.');
    return { kind: mode, exitCode: 0, record: found.record, result, text: lines.join('\n') };
  }

  if (mode === 'sweep') {
    const sweep = thresholdSensitivity(found.record, { steps: Number(flag('steps') ?? 9) });
    if (!sweep.ok) return { kind: mode, exitCode: 3, result: sweep, text: `cannot sweep: ${sweep.note}` };
    const lines = [
      `record: ${found.record.id ?? '(no id)'}`,
      `rows with a model probability: ${sweep.sweep[0].decisions.length}`,
      `no-threshold (fixed): ${sweep.no}`,
      '',
      'yes-threshold  per-row decisions',
    ];
    for (const row of sweep.sweep) lines.push(`  ${String(row.yes).padEnd(13)} ${row.decisions.join(', ')}`);
    lines.push('');
    lines.push(sweep.stable
      ? 'the verdict does not move across the swept band: the threshold is not the deciding factor here.'
      : `the verdict changes at: ${sweep.flipPoints.map((f) => `yes ${f.between[0]}→${f.between[1]}`).join(', ')} — the threshold IS a deciding factor, so it must be calibrated before it is trusted.`);
    return { kind: mode, exitCode: 0, result: sweep, text: lines.join('\n') };
  }

  // mode === 'model'
  const allowLive = argv.includes('--allow-live');
  const result = replayModel(found.record, { allowLive });
  const lines = [`record: ${found.record.id ?? '(no id)'}`, `live: ${result.ok ? 'yes' : 'no'}`];
  if (!result.ok) lines.push(`reason: ${result.reason}`);
  if (!result.ok && !allowLive) lines.push('pass --allow-live to re-ask the judge. It is the only mode that can cost money.');
  if (result.ok) lines.push(`status: ${result.status} (exit ${result.exitCode ?? '?'})`);
  return { kind: mode, exitCode: result.ok ? 0 : 3, result, text: lines.join('\n') };
}

function lastRecord(path) {
  const journal = readJournal({ path });
  const records = journal.records;
  return { record: records.length ? records[records.length - 1] : null, journal };
}

export function renderJournal(journal) {
  if (!journal.exists) {
    return `journal: ${journal.path}\nno journal yet. A journal that does not exist is not an empty journal — nothing has been recorded.`;
  }
  const lines = [
    `journal: ${journal.path}`,
    `records: ${journal.total}${journal.complete ? '' : ' (INCOMPLETE: some lines could not be parsed)'}`,
    '',
  ];
  for (const record of journal.records.slice(-20)) {
    lines.push(`  ${String(record.id ?? '(no id)').padEnd(24)} ${String(record.status ?? '?').padEnd(10)} ${record.at ?? ''}`);
  }
  if (journal.records.length > 20) lines.push(`  … and ${journal.records.length - 20} earlier`);
  if (!journal.complete) {
    lines.push('');
    lines.push(`${journal.corrupt.length} line(s) could not be parsed. The journal is marked incomplete: do not present it as the whole audit trail.`);
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const result = replayCommand();
  console.log(result.text);
  process.exitCode = result.exitCode;
}
