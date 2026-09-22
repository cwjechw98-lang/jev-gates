/**
 * The replay surface (stage D remainder).
 *
 * A journal that cannot be replayed is a log, not an audit trail. These tests
 * pin the difference: the gate stores enough to re-decide and to re-ask, and the
 * replay refuses to pretend when it does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { replayCommand } from '../scripts/jev-replay.mjs';
import { appendRecord, makeRecord, readJournal } from '../lib/journal.mjs';
import { STATUS_EXIT } from '../lib/policy.mjs';

const request = {
  schemaVersion: 2,
  taskId: 'replay-task',
  runId: 'run-1',
  criteria: [
    {
      id: 'c1',
      text: 'the command succeeded',
      kind: 'deterministic',
      required: true,
      evidenceRefs: ['cmd-1'],
      check: { type: 'command_exit', ref: 'cmd-1', expectExit: 0 },
    },
    { id: 'c2', text: 'the change is complete', kind: 'semantic', required: true, evidenceRefs: ['obs-2'] },
  ],
};

/**
 * The evidence, delivered through the channel rather than written into the
 * request: an observation inside the request body is the claimant speaking about
 * itself and is recorded as self-reported.
 */
const observations = [
  {
    observationId: 'cmd-1',
    kind: 'command',
    runId: 'run-1',
    taskId: 'replay-task',
    executable: 'npx',
    argv: ['vitest'],
    status: 'completed',
    exit: 0,
    coverage: 'full',
    sourceTrust: 'harness_observed',
    capturedAt: '2026-09-22T11:59:00.000Z',
  },
  {
    observationId: 'obs-2',
    kind: 'artifact',
    runId: 'run-1',
    taskId: 'replay-task',
    path: 'reports/out.md',
    existence: true,
    bytes: 240,
    coverage: 'full',
    sourceTrust: 'collector_observed',
    capturedAt: '2026-09-22T11:59:01.000Z',
    excerpt: 'the timeout was a symptom of a per-process cache used as a per-worker cache',
  },
];

/** Run the gate in-process and return both the result and the journal path. */
async function recordDecision({ answers = { c2: { noul: 0.93 } }, journal = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-replay-'));
  const path = join(dir, 'jev-decisions.jsonl');
  const { runGate } = await import('../scripts/jev-gate.mjs');
  const result = await runGate({ request, observations, answers, now: Date.parse('2026-09-22T12:00:00.000Z') });
  if (journal) {
    // The same fields the CLI writes. Omitting `policyVersion` would make the
    // record replay as `partial` for the wrong reason, and the test would then be
    // asserting the wrong behaviour.
    appendRecord(
      makeRecord({
        id: 'rec-1',
        kind: 'gate',
        label: request.taskId,
        policyVersion: result.meta.policyVersion,
        status: result.decision.status,
        verdict: result.decision.status,
        exitCode: result.decision.exitCode,
        reasonCodes: result.decision.reasonCodes,
        basis: result.decision.basis,
        thresholds: result.decision.thresholds,
        rows: result.decision.rows,
        questions: result.questions,
        answers: result.validation.flat,
      }, { at: '2026-09-22T12:00:00.000Z' }),
      { path },
    );
  }
  return { result, path, dir };
}

test('a recorded decision stores enough to be replayed', async () => {
  const { result, path } = await recordDecision();
  const journal = readJournal({ path });
  assert.equal(journal.total, 1);
  assert.equal(journal.complete, true);
  const record = journal.records[0];
  assert.ok(Array.isArray(record.rows), 'rows are stored, otherwise a replay can only say "partial"');
  assert.ok(record.questions && Object.keys(record.questions).length > 0, 'questions are stored, otherwise the judge cannot be re-asked');
  assert.equal(record.status, result.decision.status);
});

test('policy replay is exact when the record carries rows and thresholds', async () => {
  const { path } = await recordDecision();
  const out = replayCommand(['policy', '--journal', path, '--id', 'rec-1']);
  assert.match(out.text, /replay: exact/);
  assert.match(out.text, /status: done \(exit 0\)/);
  assert.equal(out.exitCode, 0);
});

test('the exit code in a replay comes from the current policy, not from the record', async () => {
  const { path } = await recordDecision();
  // A 0.93 answer passes at yes=0.8 and becomes a review at yes=0.99. The
  // recorded exit code was 0; printing 0 next to `review` would be a
  // contradiction in the one place a reader is least likely to question it.
  const out = replayCommand(['policy', '--journal', path, '--id', 'rec-1', '--yes', '0.99', '--no', '0.2']);
  assert.match(out.text, /status: review/);
  assert.match(out.text, new RegExp(`exit ${STATUS_EXIT.review}`));
  assert.match(out.text, /the record stored exit 0/);
  assert.match(out.text, /stated, not calibrated/);
});

test('the threshold sweep names the point where the verdict changes', async () => {
  const { path } = await recordDecision();
  const out = replayCommand(['sweep', '--journal', path, '--id', 'rec-1']);
  assert.match(out.text, /per-row decisions/);
  assert.doesNotMatch(out.text, /undefined/, 'an unrendered field is a bug, not a formatting choice');
  assert.match(out.text, /the verdict changes at: yes 0\.8\d*→0\.9/);
  assert.match(out.text, /must be calibrated/);
});

test('a verdict that does not move across the band is reported as stable', async () => {
  // 1.0 is the only answer that survives the whole swept band: the sweep stops at
  // yes=1, so anything below 1 becomes a review at the top of the range.
  const { path } = await recordDecision({ answers: { c2: { noul: 1 } } });
  const out = replayCommand(['sweep', '--journal', path, '--id', 'rec-1', '--steps', '4']);
  assert.match(out.text, /does not move across the swept band/);
});

test('model replay refuses without --allow-live and says why', async () => {
  const { path } = await recordDecision();
  const out = replayCommand(['model', '--journal', path, '--id', 'rec-1']);
  assert.equal(out.exitCode, 3);
  assert.match(out.text, /live: no/);
  assert.match(out.text, /refused without --allow-live/);
  assert.match(out.text, /only mode that can cost money/);
});

test('render reproduces the report from the record alone', async () => {
  const { path } = await recordDecision();
  const out = replayCommand(['render', '--journal', path, '--id', 'rec-1']);
  assert.match(out.text, /kind: gate/);
  assert.match(out.text, /verdict: done/);
  assert.match(out.text, /policyVersion:/);
});

test('an absent journal is reported as absent, not as an empty pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-replay-none-'));
  const path = join(dir, 'missing.jsonl');
  const list = replayCommand(['list', '--journal', path]);
  assert.match(list.text, /is not an empty journal/);
  const policy = replayCommand(['policy', '--journal', path]);
  assert.equal(policy.exitCode, 3, 'a missing record is not a pass');
  assert.match(policy.text, /an absent record is not a pass/);
});

test('a record without rows replays as partial and says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-replay-partial-'));
  const path = join(dir, 'jev-decisions.jsonl');
  appendRecord(makeRecord({ id: 'old-1', verdict: 'done' }, { at: '2026-01-01T00:00:00.000Z' }), { path });
  const out = replayCommand(['policy', '--journal', path, '--id', 'old-1']);
  assert.match(out.text, /replay: partial/);
  assert.match(out.text, /describes the record, not the work/);
  // Without a basis the replay refuses to echo the recorded verdict. It reports
  // `unverified`, because a verdict it cannot reproduce is not one it can stand
  // behind — echoing `done` here would be the exact false confidence this project
  // exists to remove.
  assert.match(out.text, /status: unverified/);
  assert.match(out.text, /the record has no basis/);
});

test('a corrupt journal line is counted and the journal is marked incomplete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-replay-corrupt-'));
  const path = join(dir, 'jev-decisions.jsonl');
  writeFileSync(path, '{"id":"a","status":"done"}\nnot json at all\n', 'utf8');
  const out = replayCommand(['list', '--journal', path]);
  assert.match(out.text, /INCOMPLETE/);
  assert.match(out.text, /do not present it as the whole audit trail/);
});

test('an unknown mode prints usage and exits 2', () => {
  const out = replayCommand(['wat']);
  assert.equal(out.exitCode, 2);
  assert.match(out.text, /usage: jev-replay/);
});

test('the gate itself writes a replayable record when it runs as a CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-replay-cli-'));
  const { execFileSync } = await import('node:child_process');
  const { dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const requestPath = join(dir, 'request.json');
  const answersPath = join(dir, 'answers.json');
  writeFileSync(requestPath, JSON.stringify(request), 'utf8');
  writeFileSync(answersPath, JSON.stringify({ c2: { noul: 0.93 } }), 'utf8');

  const run = (args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [join(root, 'scripts', 'jev-gate.mjs'), ...args], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, JEV_GATES_HOME: dir },
      }) };
    } catch (error) {
      // A non-zero exit is a verdict, not a crash: the journal must be written
      // either way, because an unverified decision is exactly the one a reviewer
      // needs to be able to replay.
      return { code: error.status ?? 1, out: `${error.stdout ?? ''}`, err: `${error.stderr ?? ''}` };
    }
  };

  const first = run(['--request', requestPath, '--answers', answersPath]);
  assert.ok([0, 1, 2, 3].includes(first.code), `unexpected exit ${first.code}: ${first.err ?? ''}`);
  const journalPath = join(dir, 'jev-decisions.jsonl');
  assert.ok(existsSync(journalPath), 'the CLI must write the audit trail');
  const record = JSON.parse(readFileSync(journalPath, 'utf8').trim());
  assert.ok(record.rows, 'and it must be replayable');
  assert.equal(record.exitCode, first.code);
  assert.match(record.id, /^replay-task-/);

  run(['--request', requestPath, '--answers', answersPath, '--no-journal']);
  const lines = readFileSync(journalPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, '--no-journal must not append a second record');
});
