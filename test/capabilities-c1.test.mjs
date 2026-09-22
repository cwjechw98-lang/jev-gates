/**
 * C1 — `jev_verify_completion`.
 *
 * These tests exist to pin the properties that make the verdict trustworthy, not
 * to raise a count. Each one fails if a specific safety rule is broken:
 *
 * - a missing observation must not become a pass;
 * - a request must not be able to promote its own evidence;
 * - an unreadable tool result must not become exit code 0;
 * - a judge must not be consulted when the answer is already computable, and its
 *   opinion must not override a measurement.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { CAPABILITY_STATUS } from '../lib/capability.mjs';
import { validateRequest } from '../lib/contracts.mjs';
import { JUDGE_STATUS, buildQuestions } from '../lib/judge.mjs';
import { STATUS, STATUS_EXIT } from '../lib/policy.mjs';
import { eventFromToolResult, judgeFromClient, verifyCompletion } from '../lib/verify.mjs';

/** A scratch directory that is removed when the test finishes. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-c1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A request with one required artifact criterion. */
function requestWith(overrides = {}) {
  return {
    schemaVersion: 2,
    taskId: 'task-1',
    runId: 'run-1',
    mode: 'completion',
    criteria: [
      {
        id: 'artifact',
        text: 'the artifact exists',
        kind: 'deterministic',
        required: true,
        verificationScope: ['out.txt'],
        check: { type: 'artifact_exists' },
      },
    ],
    claims: { task: 'produce out.txt', claimed: 'out.txt was produced' },
    ...overrides,
  };
}

test('C1: an existing artifact confirms completion with exit 0', async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'out.txt'), 'hello', 'utf8');
  const envelope = await verifyCompletion({
    taskId: 'task-1',
    runId: 'run-1',
    request: requestWith(),
    artifacts: ['out.txt'],
    projectRoot: dir,
  });
  assert.equal(envelope.status, CAPABILITY_STATUS.success);
  assert.equal(envelope.decision.completionStatus, STATUS.done);
  assert.equal(envelope.decision.exitCode, STATUS_EXIT.done);
  assert.equal(envelope.reason.code, 'ok');
});

test('C1: a missing artifact is unverified, never a pass', async (t) => {
  const dir = scratch(t);
  const envelope = await verifyCompletion({
    taskId: 'task-1',
    runId: 'run-1',
    request: requestWith(),
    artifacts: ['absent.txt'],
    projectRoot: dir,
  });
  assert.equal(envelope.status, CAPABILITY_STATUS.unverified);
  assert.equal(envelope.decision.completionStatus, STATUS.unverified);
  assert.equal(envelope.decision.exitCode, STATUS_EXIT.unverified);
  assert.notEqual(envelope.status, CAPABILITY_STATUS.success);
});

test('C1: no evidence at all is unverified, not done', async () => {
  const envelope = await verifyCompletion({ taskId: 'task-1', runId: 'run-1', request: requestWith() });
  assert.equal(envelope.status, CAPABILITY_STATUS.unverified);
  assert.equal(envelope.decision.exitCode, STATUS_EXIT.unverified);
});

test('C1: a failed required criterion is not_done with exit 1', async (t) => {
  const dir = scratch(t);
  // The criterion demands a command that exited 0; the observation says it did not.
  const request = {
    schemaVersion: 2,
    taskId: 'task-1',
    runId: 'run-1',
    mode: 'completion',
    criteria: [
      {
        id: 'tests',
        text: 'the test command succeeded',
        kind: 'deterministic',
        required: true,
        check: { type: 'command_exit', executable: 'node', argv: ['--test'], expect: 0 },
      },
    ],
    claims: { task: 'run the tests', claimed: 'tests pass' },
  };
  const envelope = await verifyCompletion({
    taskId: 'task-1',
    runId: 'run-1',
    request,
    events: [
      {
        type: 'tool_result',
        toolCallId: 'call-1',
        executable: 'node',
        argv: ['--test'],
        status: 'completed',
        exitCode: 1,
      },
    ],
    projectRoot: dir,
  });
  assert.equal(envelope.decision.completionStatus, STATUS.not_done);
  assert.equal(envelope.decision.exitCode, STATUS_EXIT.not_done);
});

test('C1: inline evidence is downgraded to self_reported and cannot confirm', async (t) => {
  const dir = scratch(t);
  const envelope = await verifyCompletion({
    taskId: 'task-1',
    runId: 'run-1',
    request: requestWith(),
    inlineEvidence: [
      {
        observationId: 'claimed',
        kind: 'artifact',
        path: 'out.txt',
        existence: true,
        // The request asserts the highest trust. The channel decides, not the field.
        sourceTrust: 'harness_observed',
      },
    ],
    projectRoot: dir,
  });
  assert.equal(envelope.status, CAPABILITY_STATUS.unverified, 'a self-reported fact must not confirm completion');
  assert.deepEqual(
    [...new Set(envelope.evidence.map((ref) => ref.trust))],
    ['self_reported'],
    'the acquisition path assigns trust, never an input field',
  );
});

test('C1: a tool result without an exit code does not invent zero', () => {
  const failed = eventFromToolResult({
    exec: { name: 'run', callId: 'c1', arguments: {} },
    result: { isError: true, error: { message: 'boom' } },
  });
  assert.equal(failed.exitCode, undefined, 'a failure carries no exit code; guessing 0 would fabricate a pass');
  assert.equal(failed.status, 'unknown');

  const ok = eventFromToolResult({
    exec: { name: 'run', callId: 'c2', arguments: {} },
    result: { isError: false, value: { exitCode: 0, status: 'completed', executable: 'node', argv: ['x'] } },
  });
  assert.equal(ok.exitCode, 0);
  assert.deepEqual(ok.argv, ['x']);
});

test('C1: a deterministic answer never calls the judge', async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'out.txt'), 'hello', 'utf8');
  let called = 0;
  const envelope = await verifyCompletion({
    taskId: 'task-1',
    runId: 'run-1',
    request: requestWith(),
    artifacts: ['out.txt'],
    projectRoot: dir,
    judge: async () => {
      called += 1;
      return { status: 'answered', answers: {} };
    },
  });
  assert.equal(called, 0, 'the model lane is for semantic criteria only');
  assert.equal(envelope.model.used, false);
  assert.equal(envelope.model.requested, false);
});

test('C1: a semantic criterion without a judge is unverified, not confirmed', async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'out.txt'), 'hello', 'utf8');
  const request = {
    schemaVersion: 2,
    taskId: 'task-1',
    runId: 'run-1',
    mode: 'completion',
    criteria: [
      {
        id: 'quality',
        text: 'the document explains the design',
        kind: 'semantic',
        required: true,
        verificationScope: ['out.txt'],
        check: { type: 'artifact_exists' },
      },
    ],
    claims: { task: 'document it', claimed: 'documented' },
  };
  const envelope = await verifyCompletion({ taskId: 'task-1', runId: 'run-1', request, artifacts: ['out.txt'], projectRoot: dir, allowModel: false });
  assert.equal(envelope.status, CAPABILITY_STATUS.unverified);
  assert.notEqual(envelope.status, CAPABILITY_STATUS.success);
});

test('C1: a judge failure is unverified and never success', async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'out.txt'), 'hello', 'utf8');
  const request = {
    schemaVersion: 2,
    taskId: 'task-1',
    runId: 'run-1',
    mode: 'completion',
    criteria: [
      { id: 'quality', text: 'the document explains the design', kind: 'semantic', required: true, verificationScope: ['out.txt'], check: { type: 'artifact_exists' } },
    ],
    claims: { task: 'document it', claimed: 'documented' },
  };
  const envelope = await verifyCompletion({
    taskId: 'task-1',
    runId: 'run-1',
    request,
    artifacts: ['out.txt'],
    projectRoot: dir,
    judge: async () => {
      throw new Error('judge exploded');
    },
  });
  assert.equal(envelope.status, CAPABILITY_STATUS.unverified);
});

test('C1: the snapshot identifies the material, not the attempt', async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'out.txt'), 'hello', 'utf8');
  const base = { taskId: 'task-1', request: requestWith(), artifacts: ['out.txt'], projectRoot: dir };

  // The same evidence judged twice is the SAME snapshot. This is what lets the
  // stop rule recognise a repeat: if the digest moved with the run id, every
  // retry would look like fresh information and the loop would never stop.
  const first = await verifyCompletion({ ...base, runId: 'run-1' });
  const second = await verifyCompletion({ ...base, runId: 'run-2' });
  assert.equal(first.snapshot.digest, second.snapshot.digest, 'a new attempt on identical evidence is not new information');

  // Different evidence IS a different snapshot.
  writeFileSync(join(dir, 'out.txt'), 'changed', 'utf8');
  const third = await verifyCompletion({ ...base, runId: 'run-3' });
  assert.notEqual(first.snapshot.digest, third.snapshot.digest, 'changed material must change the snapshot');
});

test('C1: every envelope declares that it authorises nothing', async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'out.txt'), 'hello', 'utf8');
  for (const envelope of [
    await verifyCompletion({ taskId: 't', runId: 'r1', request: requestWith(), artifacts: ['out.txt'], projectRoot: dir }),
    await verifyCompletion({ taskId: 't', runId: 'r2', request: requestWith(), artifacts: ['absent.txt'], projectRoot: dir }),
    await verifyCompletion({ taskId: 't', runId: 'r3', request: requestWith() }),
  ]) {
    assert.equal(envelope.actionAuthority, 'none', 'a completion verdict is never permission to act');
  }
});

test('C1: every envelope carries its own limits', async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'out.txt'), 'hello', 'utf8');
  const envelope = await verifyCompletion({ taskId: 't', runId: 'r', request: requestWith(), artifacts: ['out.txt'], projectRoot: dir });
  assert.ok(Array.isArray(envelope.limits) && envelope.limits.length > 0, 'an envelope with no stated limits overstates itself');
});

test('C1: the envelope is versioned and carries taskId/runId', async () => {
  const envelope = await verifyCompletion({ taskId: 'task-9', runId: 'run-9', request: requestWith() });
  assert.equal(envelope.taskId, 'task-9');
  assert.equal(envelope.runId, 'run-9');
  assert.equal(envelope.capability, 'jev_verify_completion');
  assert.ok(typeof envelope.envelopeVersion === 'number');
});

test('C1: every judge status the adapter emits is a real member of JUDGE_STATUS', async () => {
  const members = new Set(Object.values(JUDGE_STATUS));
  // A status that is not a member becomes `undefined`, which decideCompletion then
  // compares against strings and silently fails to match — a judge that failed
  // would be reported as a judge that answered. This was a real defect: the adapter
  // reached for `JUDGE_STATUS.error`, which does not exist.
  const questions = buildQuestions(
    [{ id: 'c1', text: 'the fix is complete', kind: 'semantic', required: true }],
    [{ criterionId: 'c1', result: 'unknown', supported: true }],
  );
  const good = { ok: true, json: { answers: { c1: { type: 'noul', noul: 0.9 } } } };
  const cases = [
    { name: 'an answer arrives', transport: { async postJson() { return good; } }, expect: JUDGE_STATUS.ok },
    // An empty answer *object* is a reachable judge that answered nothing: `ok`
    // with no usable answers, which decideCompletion then treats per criterion.
    // An answer *array* is not an answer object at all, which is the abstention.
    { name: 'the judge answers nothing', transport: { async postJson() { return { ok: true, json: { answers: {} } }; } }, expect: JUDGE_STATUS.ok },
    { name: 'the judge returns no answer object', transport: { async postJson() { return { ok: true, json: { answers: [] } }; } }, expect: JUDGE_STATUS.abstained },
    { name: 'the judge is unreachable', transport: { async postJson() { throw new Error('ECONNREFUSED'); } }, expect: JUDGE_STATUS.unavailable },
    { name: 'the transport fails', transport: { async postJson() { return { ok: false, status: 500, json: {} }; } }, expect: JUDGE_STATUS.unavailable },
  ];
  for (const { name, transport, expect } of cases) {
    const judge = judgeFromClient({ apiKey: 'test-key-not-real', transport });
    const out = await judge({ state: {}, questions });
    assert.ok(members.has(out.status), `${name}: status ${String(out.status)} is not a member of JUDGE_STATUS`);
    assert.equal(out.status, expect, name);
  }
});

test('C1: an abstaining judge does not confirm completion', async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'out.txt'), 'hello', 'utf8');
  // A semantic criterion carries no `check` by contract: the route is chosen by
  // `kind`, and the two routes are exclusive. Asking for both is rejected.
  const request = {
    schemaVersion: 2,
    taskId: 'task-1',
    runId: 'run-1',
    mode: 'completion',
    criteria: [
      { id: 'quality', text: 'the document explains the design', kind: 'semantic', required: true, verificationScope: ['out.txt'] },
    ],
    claims: { task: 'document it', claimed: 'documented' },
  };
  const envelope = await verifyCompletion({
    taskId: 'task-1',
    runId: 'run-1',
    request,
    artifacts: ['out.txt'],
    projectRoot: dir,
    judge: async () => ({ status: JUDGE_STATUS.abstained, answers: {}, answerErrors: [], reason: 'no answer object' }),
  });
  assert.notEqual(envelope.decision.completionStatus, STATUS.done, 'an abstention is never a confirmation');
});

test('C1: a criterion cannot be both semantic and deterministically checked', () => {
  // Supplying both used to be resolved silently in favour of the check, so an
  // author who asked for a semantic judgement got a file-existence test and the
  // declared `kind` was discarded. The ambiguity is now an error.
  const { errors } = validateRequest({
    schemaVersion: 2,
    taskId: 'task-1',
    runId: 'run-1',
    mode: 'completion',
    criteria: [
      { id: 'quality', text: 'the document explains the design', kind: 'semantic', required: true, check: { type: 'artifact_exists', ref: 'out.txt' } },
    ],
    claims: { task: 't', claimed: 'c' },
  });
  assert.ok(
    errors.some((e) => e.code === 'contradictory_criterion'),
    `expected contradictory_criterion, got ${JSON.stringify(errors.map((e) => e.code))}`,
  );
});
