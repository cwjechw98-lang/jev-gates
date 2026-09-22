/**
 * Evidence layer tests (stage C).
 *
 * These tests are about the difference between "I looked and it is not there"
 * and "I could not look". Every one of them fails if the code starts treating an
 * unknown as a value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestText, isWithinScope, joinPath, normalizePath, resolveCriterion, resolveCriteria, stableStringify } from '../lib/evidence.mjs';
import { collectArtifact, observationsFromEvents } from '../lib/collector.mjs';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const ROOT = 'C:/project';

const artifact = (over = {}) => ({
  observationId: 'obs-1',
  kind: 'artifact',
  runId: 'r',
  taskId: 't',
  sequence: 1,
  path: 'C:/project/reports/out.md',
  existence: true,
  bytes: 100,
  sha256: 'a'.repeat(64),
  capturedAt: '2026-09-22T11:59:00.000Z',
  sourceTrust: 'collector_observed',
  coverage: 'full',
  unstable: false,
  ...over,
});

const criterion = (over = {}) => ({
  id: 'c1',
  text: 'the report exists',
  kind: 'deterministic',
  required: true,
  verificationScope: [],
  evidenceRefs: ['obs-1'],
  check: { type: 'artifact_nonempty' },
  ...over,
});

// --- paths -------------------------------------------------------------------

test('paths: Windows comparison is case-insensitive and separator-agnostic', () => {
  assert.equal(normalizePath('C:\\Project\\SRC\\a.ts'), 'c:/project/src/a.ts');
  assert.equal(normalizePath('C:/project/src/'), 'c:/project/src');
  assert.equal(normalizePath('C:/project//src///a.ts'), 'c:/project/src/a.ts');
  assert.equal(isWithinScope('C:/Project/SRC/a.ts', ['c:/project/src']), true);
});

test('paths: a scope prefix only matches on a path boundary', () => {
  assert.equal(isWithinScope('C:/p/src/a.ts', ['C:/p/src']), true);
  assert.equal(isWithinScope('C:/p/src/a.tsx', ['C:/p/src/a.ts']), false, 'a sibling file is not in scope');
  assert.equal(isWithinScope('C:/p/other/a.ts', ['C:/p/src']), false);
  assert.equal(isWithinScope('C:/p/src', ['C:/p/src']), true, 'the directory itself is in scope');
});

test('paths: relative scope and absolute observation describe the same file', () => {
  const facts = resolveCriteria(
    [criterion({ verificationScope: ['reports/out.md'], evidenceRefs: ['obs-1'] })],
    [artifact()],
    { projectRoot: ROOT, now: NOW },
  );
  assert.equal(facts[0].result, 'pass');
});

// --- the unknown-versus-value distinction ------------------------------------

test('an unknown existence is unknown, never a pass', () => {
  const facts = resolveCriteria([criterion()], [artifact({ existence: null })], { projectRoot: ROOT, now: NOW });
  assert.equal(facts[0].result, 'unknown');
  assert.equal(facts[0].reasonCode, 'existence_unknown');
});

test('a missing observation is unknown, not a failure and not a pass', () => {
  const facts = resolveCriteria([criterion()], [], { projectRoot: ROOT, now: NOW });
  assert.equal(facts[0].result, 'unknown');
  assert.equal(facts[0].reasonCode, 'no_observation');
});

test('an absent file is a factual failure', () => {
  const facts = resolveCriteria([criterion()], [artifact({ existence: false, bytes: 0 })], { projectRoot: ROOT, now: NOW });
  assert.equal(facts[0].result, 'fail');
  assert.equal(facts[0].reasonCode, 'artifact_missing');
});

test('an empty file fails a non-empty check', () => {
  const facts = resolveCriteria([criterion()], [artifact({ bytes: 0 })], { projectRoot: ROOT, now: NOW });
  assert.equal(facts[0].result, 'fail');
  assert.equal(facts[0].reasonCode, 'artifact_empty');
});

// --- scope, freshness, stability, coverage -----------------------------------

test('T21: evidence outside the verification scope does not confirm the criterion', () => {
  const facts = resolveCriteria(
    [criterion({ verificationScope: ['src/'], evidenceRefs: ['obs-1'] })],
    [artifact({ path: 'C:/project/other/secret.txt' })],
    { projectRoot: ROOT, now: NOW },
  );
  assert.equal(facts[0].result, 'unknown');
  assert.equal(facts[0].reasonCode, 'evidence_scope_mismatch');
});

test('T21b: a traversal path in a scope cannot widen it', () => {
  assert.equal(isWithinScope('C:/project/src/../../etc/passwd', ['C:/project/src']), false);
  const facts = resolveCriteria(
    [criterion({ verificationScope: ['src'], evidenceRefs: ['obs-1'] })],
    [artifact({ path: 'C:/project/src/../../etc/passwd' })],
    { projectRoot: ROOT, now: NOW },
  );
  assert.notEqual(facts[0].result, 'pass');
});

test('T07: stale evidence does not confirm anything', () => {
  const old = artifact({ capturedAt: '2026-09-22T11:00:00.000Z' });
  const facts = resolveCriteria([criterion()], [old], { projectRoot: ROOT, now: NOW, maxAgeMs: 60_000 });
  assert.equal(facts[0].result, 'unknown');
  assert.equal(facts[0].reasonCode, 'evidence_stale');
  assert.equal(facts[0].fresh, false);

  const fresh = resolveCriteria([criterion()], [old], { projectRoot: ROOT, now: NOW, maxAgeMs: 3_600_000 });
  assert.equal(fresh[0].result, 'pass');
});

test('T10: an artifact that changed between two reads is unstable and cannot confirm', () => {
  const facts = resolveCriteria([criterion()], [artifact({ unstable: true, coverage: 'partial' })], { projectRoot: ROOT, now: NOW });
  assert.equal(facts[0].result, 'unknown');
  assert.equal(facts[0].reasonCode, 'observation_unstable');
});

test('coverage travels with the fact so the policy can refuse a partial pass', () => {
  const facts = resolveCriteria([criterion()], [artifact({ coverage: 'partial' })], { projectRoot: ROOT, now: NOW });
  assert.equal(facts[0].result, 'pass', 'the evidence layer reports what it saw');
  assert.equal(facts[0].coverage, 'partial', 'and the policy is the layer that refuses to confirm it');
});

// --- commands ----------------------------------------------------------------

test('T08: an expected non-zero exit is a legitimate pass', () => {
  const obs = {
    observationId: 'cmd-1',
    kind: 'command',
    runId: 'r',
    taskId: 't',
    executable: 'node',
    argv: ['-e', 'process.exit(1)'],
    status: 'completed',
    exit: 1,
    capturedAt: '2026-09-22T11:59:00.000Z',
    sourceTrust: 'harness_observed',
    coverage: 'full',
  };
  const facts = resolveCriteria(
    [criterion({ check: { type: 'command_exit', ref: 'cmd-1', expectExit: 1 }, evidenceRefs: ['cmd-1'] })],
    [obs],
    { projectRoot: ROOT, now: NOW },
  );
  assert.equal(facts[0].result, 'pass', 'a negative test that fails as designed is a pass');
  assert.equal(facts[0].reasonCode, 'command_exit_matched');
});

test('a missing exit code on a completed command is unknown, never zero', () => {
  const obs = {
    observationId: 'cmd-1',
    kind: 'command',
    runId: 'r',
    taskId: 't',
    executable: 'node',
    argv: [],
    status: 'completed',
    exit: null,
    capturedAt: '2026-09-22T11:59:00.000Z',
    sourceTrust: 'harness_observed',
    coverage: 'full',
  };
  const facts = resolveCriteria([criterion({ check: { type: 'command_exit', ref: 'cmd-1' } })], [obs], { projectRoot: ROOT, now: NOW });
  assert.equal(facts[0].result, 'unknown');
  assert.equal(facts[0].reasonCode, 'command_did_not_complete');
});

test('T09: a collector read is not a read-after-write provenance', () => {
  // The collector opened the file to hash it. That is not evidence that the
  // agent re-read its own write, and the two must not be substituted.
  const facts = resolveCriteria(
    [criterion({ check: { type: 'read_after_write' }, evidenceRefs: ['obs-1'] })],
    [artifact()],
    { projectRoot: ROOT, now: NOW },
  );
  assert.equal(facts[0].result, 'unknown');
  assert.equal(facts[0].reasonCode, 'event_provenance_unavailable');

  const withProvenance = resolveCriteria(
    [criterion({ check: { type: 'read_after_write' }, evidenceRefs: ['obs-1'] })],
    [artifact({ readAfterWrite: true })],
    { projectRoot: ROOT, now: NOW },
  );
  assert.equal(withProvenance[0].result, 'pass');
});

test('a digest check compares the recorded digest exactly', () => {
  const matching = resolveCriteria(
    [criterion({ check: { type: 'artifact_digest', ref: 'obs-1', digest: 'a'.repeat(64) }, evidenceRefs: ['obs-1'] })],
    [artifact()],
    { projectRoot: ROOT, now: NOW },
  );
  assert.equal(matching[0].result, 'pass');
  const mismatch = resolveCriteria(
    [criterion({ check: { type: 'artifact_digest', ref: 'obs-1', digest: 'b'.repeat(64) }, evidenceRefs: ['obs-1'] })],
    [artifact()],
    { projectRoot: ROOT, now: NOW },
  );
  assert.equal(mismatch[0].result, 'fail');
});

test('the latest observation wins when several describe the same artifact', () => {
  // No explicit reference: both observations describe the same path, and the
  // later sequence is the one that reflects the artifact as it stands now.
  const facts = resolveCriteria(
    [criterion({ evidenceRefs: [], verificationScope: ['reports/out.md'] })],
    [artifact({ sequence: 1, existence: false, bytes: 0 }), artifact({ observationId: 'obs-2', sequence: 5, existence: true, bytes: 10 })],
    { projectRoot: ROOT, now: NOW },
  );
  assert.equal(facts[0].result, 'pass', 'a later successful write supersedes an earlier absence');
});

// --- collector ---------------------------------------------------------------

test('the collector measures a real file and records a digest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-evidence-'));
  try {
    const file = join(dir, 'artifact.txt');
    writeFileSync(file, 'hello evidence');
    const obs = await collectArtifact({ path: file, runId: 'r', taskId: 't' });
    assert.equal(obs.existence, true);
    assert.equal(obs.bytes, 14);
    assert.equal(obs.sha256, digestText('hello evidence'));
    assert.equal(obs.coverage, 'full');
    assert.equal(obs.unstable, false);
    assert.equal(obs.sourceTrust, 'collector_observed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the collector reports an absent file as absent and a directory as partial', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-evidence-'));
  try {
    const missing = await collectArtifact({ path: join(dir, 'nope.txt'), runId: 'r', taskId: 't' });
    assert.equal(missing.existence, false);
    assert.equal(missing.coverage, 'full');

    const sub = join(dir, 'sub');
    mkdirSync(sub);
    const asDirectory = await collectArtifact({ path: sub, runId: 'r', taskId: 't' });
    assert.equal(asDirectory.existence, true);
    assert.equal(asDirectory.coverage, 'partial');
    assert.equal(asDirectory.bytes, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the collector marks an artifact that changed between two reads as unstable', async () => {
  let reads = 0;
  const fs = {
    stat: async () => ({ isFile: () => true, size: 10 }),
    hashFile: async () => {
      reads += 1;
      return reads === 1 ? 'a'.repeat(64) : 'b'.repeat(64);
    },
  };
  const obs = await collectArtifact({ path: 'C:/p/x.txt', runId: 'r', taskId: 't', fs });
  assert.equal(obs.unstable, true);
  assert.equal(obs.coverage, 'partial');
  assert.equal(obs.sha256, 'b'.repeat(64), 'the later reading is the one reported');
});

test('the collector refuses to guess a permission error as an absence', async () => {
  const fs = {
    stat: async () => {
      const error = new Error('denied');
      error.code = 'EACCES';
      throw error;
    },
    hashFile: async () => 'x',
  };
  const obs = await collectArtifact({ path: 'C:/p/x.txt', runId: 'r', taskId: 't', fs });
  assert.equal(obs.existence, null, 'could not look is not "not there"');
  assert.equal(obs.coverage, 'unknown');
});

// --- event ingest ------------------------------------------------------------

test('events become observations with the harness exit code copied verbatim', () => {
  const { observations, skipped } = observationsFromEvents(
    [
      { type: 'tool_result', toolName: 'Bash', toolCallId: 'call-1', status: 'completed', exitCode: 1, argv: ['vitest'], stdout: 'Tests 1 failed' },
      { type: 'unknown_thing' },
    ],
    { runId: 'r', taskId: 't' },
  );
  assert.equal(observations.length, 1);
  assert.equal(observations[0].exit, 1);
  assert.equal(observations[0].status, 'completed');
  assert.equal(observations[0].sourceTrust, 'harness_observed');
  assert.ok(observations[0].stdoutDigest);
  assert.equal(skipped.length, 1);
});

test('an event without a status does not become a success', () => {
  const { observations } = observationsFromEvents([{ type: 'tool_result', toolName: 'Bash', toolCallId: 'c' }], { runId: 'r', taskId: 't' });
  assert.equal(observations[0].status, 'unknown');
  assert.equal(observations[0].exit, null);
  assert.equal(observations[0].coverage, 'partial');
});

test('a write event produces an artifact observation without inventing a size', () => {
  const { observations } = observationsFromEvents(
    [{ type: 'tool_result', toolName: 'Edit', toolCallId: 'call-2', status: 'completed', writes: [{ path: 'C:/p/a.ts' }] }],
    { runId: 'r', taskId: 't' },
  );
  const write = observations.find((o) => o.kind === 'artifact');
  assert.equal(write.bytes, null);
  assert.equal(write.existence, null);
  assert.equal(write.coverage, 'partial');
});

// --- digests -----------------------------------------------------------------

test('a digest is stable under key order', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

test('joinPath leaves absolute paths alone', () => {
  assert.equal(joinPath('C:/p', 'C:/other/x'), 'C:/other/x');
  assert.equal(joinPath('C:/p', 'src/x'), 'C:/p/src/x');
  assert.equal(joinPath(null, 'src/x'), 'src/x');
});
