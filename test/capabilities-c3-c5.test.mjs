/**
 * Offline tests for the two experimental capabilities: C3 (`jev_check_progress`)
 * and C5 (`jev_context_plan`).
 *
 * These are mechanics tests, not quality measurements. They pin the rules that
 * the spec makes acceptance criteria — the ones whose violation is silent data
 * loss rather than a crash:
 *
 *   - C3: an equal diff size and a long-running command are never progress
 *     signals; similar actions with new information must NOT be stopped; a real
 *     repeat must be named with its evidence; the capability must not nag.
 *   - C5: the original is byte-identical afterwards, order is preserved, a
 *     tool call/result pair is never split, and a pinned fact is never dropped
 *     or summarised away.
 *
 * Nothing here starts a harness, touches the network or calls a model.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CAPABILITY_REASON,
  CAPABILITY_STATUS,
  ALL_REASON_CODES,
  renderEnvelope,
} from '../lib/capability.mjs';
import {
  PROGRESS_ACTION,
  PROGRESS_LIMITS,
  actionFingerprint,
  actionShape,
  analyseWindow,
  errorFingerprint,
  normalizeErrorText,
} from '../lib/progress.mjs';
import {
  BLOCK_ACTION,
  BLOCK_KIND,
  CONTEXT_LIMITS,
  PIN_KIND,
  estimateTokens,
  normaliseHistory,
  pinFacts,
  planContext,
  requiresExactness,
} from '../lib/context-plan.mjs';

const TASK = 'task-c3-c5';
const RUN = 'run-1';

// ---------------------------------------------------------------------------
// C3 — progress review
// ---------------------------------------------------------------------------

/** One window event, with the fields the fingerprint reads. */
function event(overrides = {}) {
  return {
    eventId: 'e',
    tool: 'Bash',
    argv: ['npm', 'test'],
    cwd: '/work/proj',
    targetPaths: ['/work/proj/src/a.mjs'],
    exit: 1,
    status: 'completed',
    error: 'AssertionError: expected 1 to equal 2',
    snapshotDigest: 'sha256:snap-a',
    ...overrides,
  };
}

/** The common identity arguments, so each call stays about its own question. */
const call = (events, extra = {}) => analyseWindow({ events, taskId: TASK, runId: RUN, ...extra });

describe('C3 action fingerprints', () => {
  it('is stable for two identical failing commands', () => {
    assert.equal(actionFingerprint(event()), actionFingerprint(event({ eventId: 'e2', exit: 1 })));
  });

  it('changes when the command changes', () => {
    assert.notEqual(actionFingerprint(event()), actionFingerprint(event({ argv: ['npm', 'run', 'lint'] })));
  });

  it('ignores the output, because output is not the shape of an action', () => {
    assert.equal(actionFingerprint(event()), actionFingerprint(event({ stdout: 'totally different', stderr: 'also different' })));
  });

  it('normalises paths so the same target written two ways is one action', () => {
    const a = actionShape(event({ targetPaths: ['C:\\work\\proj\\src\\a.mjs'] }));
    const b = actionShape(event({ targetPaths: ['C:/work/proj/src/a.mjs'] }));
    assert.deepEqual(a.targetPaths, b.targetPaths);
  });
});

describe('C3 error fingerprints', () => {
  it('matches the same failure recorded with different paths, PIDs and timestamps', () => {
    const first = event({
      error: '2026-09-22T10:00:00.123Z ENOENT: no such file or directory, open /home/user/proj/src/index.js (pid 4821)',
      errorClass: 'ENOENT',
    });
    const second = event({
      error: '2026-09-22T11:31:07.900Z ENOENT: no such file or directory, open C:\\Users\\me\\app\\index.js (pid 991)',
      errorClass: 'ENOENT',
    });
    assert.equal(errorFingerprint(first), errorFingerprint(second));
  });

  it('matches when only line and column numbers differ', () => {
    const first = event({ error: 'TypeError: x is not a function at /a/b/c.mjs:10:5', errorClass: 'TypeError' });
    const second = event({ error: 'TypeError: x is not a function at /a/b/c.mjs:214:88', errorClass: 'TypeError' });
    assert.equal(errorFingerprint(first), errorFingerprint(second));
  });

  it('separates two different error classes', () => {
    assert.notEqual(
      errorFingerprint(event({ error: 'ENOENT: no such file or directory', errorClass: 'ENOENT' })),
      errorFingerprint(event({ error: 'EACCES: permission denied', errorClass: 'EACCES' })),
    );
  });

  it('normalises volatile values without erasing the failure class', () => {
    const normalized = normalizeErrorText('Failed after 1500 ms on port 8080 (0xdeadbeef) pid=42');
    assert.match(normalized, /<dur>/);
    assert.match(normalized, /<port>/);
    assert.match(normalized, /<hex>/);
    assert.match(normalized, /<pid>/);
    assert.match(normalized, /Failed after/);
  });
});

describe('C3 the four decisions', () => {
  it('continues when there is no repetition at all', async () => {
    const envelope = await call([event(), event({ eventId: 'e2', argv: ['npm', 'run', 'lint'] })]);
    assert.equal(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.decision.action, PROGRESS_ACTION.continue);
    assert.equal(envelope.decision.repeats, 0);
  });

  it('does not raise a false alarm when similar actions carry a changed snapshot', async () => {
    const envelope = await call([
      event({ eventId: 'e1', snapshotDigest: 'sha256:snap-a' }),
      event({ eventId: 'e2', snapshotDigest: 'sha256:snap-b' }),
    ], { prior: { snapshotDigests: ['sha256:snap-a'] } });
    assert.equal(envelope.decision.action, PROGRESS_ACTION.continue);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.progressObserved);
    assert.ok(envelope.decision.novelSignals.some((s) => s.kind === 'snapshot'));
  });

  it('does not raise a false alarm when a new test result appears', async () => {
    const envelope = await call([
      event({ eventId: 'e1' }),
      event({ eventId: 'e2', testResults: ['suite/auth: 12 passed'] }),
    ], { prior: { tests: ['suite/core: 3 failed'] } });
    assert.equal(envelope.decision.action, PROGRESS_ACTION.continue);
    assert.ok(envelope.decision.novelSignals.some((s) => s.kind === 'test_result'));
  });

  it('does not raise a false alarm when a new artifact appears', async () => {
    const envelope = await call([
      event({ eventId: 'e1' }),
      event({ eventId: 'e2', artifacts: ['dist/bundle.mjs'] }),
    ], { prior: { artifacts: ['dist/index.mjs'] } });
    assert.equal(envelope.decision.action, PROGRESS_ACTION.continue);
    assert.ok(envelope.decision.novelSignals.some((s) => s.kind === 'artifact'));
  });

  it('replans on a repeat with nothing new, naming what is missing and the evidence', async () => {
    // Two occurrences is "the second repeat": a plan was already tried, but the
    // counter has not yet reached maxRepeats.
    const envelope = await call([
      event({ eventId: 'e1' }),
      event({ eventId: 'e2' }),
    ]);
    assert.equal(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.decision.action, PROGRESS_ACTION.replan);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.repeatedWithoutProgress);
    assert.equal(envelope.decision.repeats, 2);
    assert.deepEqual(envelope.decision.evidenceRefs.map((r) => r.ref), ['e1', 'e2']);
    assert.match(envelope.decision.summary, /no new snapshot digest/i);
    assert.match(envelope.decision.summary, /change the experiment/i);
  });

  it('reobserves when the repeat cannot be judged for want of a snapshot', async () => {
    const envelope = await call([
      event({ eventId: 'e1', snapshotDigest: null }),
      event({ eventId: 'e2', snapshotDigest: null }),
    ]);
    assert.equal(envelope.decision.action, PROGRESS_ACTION.reobserve);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.missingMaterial);
    assert.deepEqual(envelope.decision.missing, ['no_snapshot_digest']);
  });

  it('reobserves when the repeat cannot be judged for want of an exit status', async () => {
    const envelope = await call([
      event({ eventId: 'e1', exit: null, exitCode: null }),
      event({ eventId: 'e2', exit: null, exitCode: null }),
    ]);
    assert.equal(envelope.decision.action, PROGRESS_ACTION.reobserve);
    assert.deepEqual(envelope.decision.missing, ['no_exit_status']);
  });

  it('hands off when the repeat counter reaches maxRepeats', async () => {
    const envelope = await call([
      event({ eventId: 'e1' }),
      event({ eventId: 'e2' }),
      event({ eventId: 'e3' }),
      event({ eventId: 'e4' }),
    ], { maxRepeats: 3 });
    assert.equal(envelope.decision.action, PROGRESS_ACTION.handoff);
    assert.equal(envelope.decision.repeats, 4);
    assert.equal(envelope.decision.limit, 'maxRepeats');
  });

  it('hands off when the budget is exhausted even below maxRepeats', async () => {
    const envelope = await call([event({ eventId: 'e1' }), event({ eventId: 'e2' })], { budget: { exhausted: true } });
    assert.equal(envelope.decision.action, PROGRESS_ACTION.handoff);
    assert.equal(envelope.decision.limit, 'budget');
    assert.equal(envelope.decision.repeats, 2);
  });
});

describe('C3 cooldown — the anti-nag rule', () => {
  const repeated = [event({ eventId: 'e1' }), event({ eventId: 'e2' })];

  it('suppresses the same advice and abstains instead of repeating it', async () => {
    const envelope = await call(repeated, { cooldown: 60_000, lastAdvice: { action: PROGRESS_ACTION.replan, at: '2026-09-22T10:00:00Z' } });
    assert.equal(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.abstained);
    assert.equal(envelope.decision.action, PROGRESS_ACTION.continue);
    assert.equal(envelope.decision.suppressed, true);
    assert.equal(envelope.decision.wouldBeAction, PROGRESS_ACTION.replan);
  });

  it('advises normally when the previous advice was different', async () => {
    const envelope = await call(repeated, { cooldown: 60_000, lastAdvice: { action: PROGRESS_ACTION.reobserve } });
    assert.equal(envelope.decision.action, PROGRESS_ACTION.replan);
    assert.equal(envelope.decision.suppressed, false);
  });
});

describe('C3 the signals that must never stop a run', () => {
  it('treats a large elapsed time as no evidence at all', async () => {
    const envelope = await call([
      event({ eventId: 'e1', elapsedMs: 20 }),
      event({ eventId: 'e2', elapsedMs: 900_000 }),
    ]);
    assert.equal(envelope.decision.action, PROGRESS_ACTION.replan, 'elapsed time is not a progress signal in either direction');
  });

  it('treats an equal diff size as no evidence at all', async () => {
    const envelope = await call([
      event({ eventId: 'e1', diff: { bytes: 500, files: 2 } }),
      event({ eventId: 'e2', diff: { bytes: 500, files: 2 } }),
    ]);
    assert.equal(envelope.decision.action, PROGRESS_ACTION.replan, 'an equal diff size does not prove stagnation');
  });

  it('says so in limits, on every answer', async () => {
    const envelope = await call([event()]);
    const joined = envelope.limits.join(' ');
    assert.match(joined, /equal diff size/i);
    assert.match(joined, /long-running command/i);
    assert.match(joined, /never kills a process/i);
    assert.deepEqual(envelope.limits, [...PROGRESS_LIMITS]);
  });
});

describe('C3 envelope honesty', () => {
  it('reports no model lane and no action authority', async () => {
    const envelope = await call([event({ eventId: 'e1' }), event({ eventId: 'e2' })]);
    assert.equal(envelope.model.used, false);
    assert.equal(envelope.model.requested, false);
    assert.equal(envelope.actionAuthority, 'none');
    assert.ok(ALL_REASON_CODES.includes(envelope.reason.code));
  });

  it('downgrades an event that carries no acquisition marker', async () => {
    const envelope = await call([
      event({ eventId: 'e1', sourceTrust: undefined, origin: undefined, trust: 'harness_observed' }),
      event({ eventId: 'e2', sourceTrust: undefined, origin: undefined, trust: 'harness_observed' }),
    ]);
    // The event asserts its own trust but carries no marker from an acquisition
    // path, so the claim is not provenance and the envelope must say so.
    assert.equal(envelope.evidence[0].trust, 'self_reported');
  });

  it('keeps a trust the acquisition path actually earned', async () => {
    const envelope = await call([event({ eventId: 'e1', origin: 'collector_observed' }), event({ eventId: 'e2' })]);
    assert.equal(envelope.evidence[0].trust, 'collector_observed');
  });

  it('renders to the single text block a tool returns', async () => {
    const envelope = await call([event({ eventId: 'e1' }), event({ eventId: 'e2' })]);
    const rendered = renderEnvelope(envelope);
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].type, 'text');
    assert.match(rendered[0].text, /jev_check_progress: success/);
  });

  it('rejects a window that is not an array', async () => {
    await assert.rejects(() => analyseWindow({ events: null, taskId: TASK, runId: RUN }), /events must be an array/);
  });
});

// ---------------------------------------------------------------------------
// C5 — context plan
// ---------------------------------------------------------------------------

const FILLER = [
  'This paragraph is background prose that carries no pinned fact.',
  'It exists only to be long enough to become a stub.',
  'There are no paths, flags, versions or errors in it.',
].join('\n');

/** A DSH-shaped history: content parts for tool use, a tool message for results. */
function history() {
  return [
    { role: 'system', content: 'You are a coding agent. Follow the repository conventions.' },
    {
      role: 'user',
      content: 'Goal: make the offline test suite pass. Constraint: never edit the shipped preset. Authorization: the human approved running the migration.',
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Running the suite.' },
        { type: 'tool_use', id: 'call-1', name: 'Bash', input: { argv: ['npm', 'test'], cwd: '/work/proj' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'ENOENT: no such file or directory, open /work/proj/test/missing.mjs' },
    { role: 'user', content: FILLER },
    { role: 'assistant', content: 'Sure.' },
  ];
}

describe('C5 normalisation and pairing', () => {
  it('produces the documented block shape', () => {
    const blocks = normaliseHistory(history());
    for (const block of blocks) {
      assert.equal(typeof block.id, 'string');
      assert.ok(['user', 'assistant', 'tool_call', 'tool_result', 'system'].includes(block.kind));
      assert.equal(typeof block.text, 'string');
      assert.equal(typeof block.tokens, 'number');
      assert.equal(typeof block.pinned, 'boolean');
      assert.equal(block.source, 'history');
    }
    assert.deepEqual(blocks.map((b) => b.kind), ['system', 'user', 'tool_call', 'tool_result', 'user', 'assistant']);
  });

  it('gives a tool call and its result the same pairId', () => {
    const blocks = normaliseHistory(history());
    const callBlock = blocks.find((b) => b.kind === BLOCK_KIND.toolCall);
    const resultBlock = blocks.find((b) => b.kind === BLOCK_KIND.toolResult);
    assert.ok(callBlock.pairId);
    assert.equal(callBlock.pairId, resultBlock.pairId);
    assert.equal(callBlock.pairRole, 'call');
    assert.equal(resultBlock.pairRole, 'result');
    assert.equal(callBlock.incomplete, undefined, 'a call with a result is not incomplete');
  });

  it('marks an unanswered call incomplete and pins it', () => {
    const blocks = pinFacts({
      blocks: normaliseHistory([
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call-9', name: 'Bash', input: { argv: ['sleep', '10'] } }] },
      ]),
    });
    assert.equal(blocks[0].kind, BLOCK_KIND.toolCall);
    assert.equal(blocks[0].incomplete, true);
    assert.equal(blocks[0].pinned, true);
    assert.equal(blocks[0].reason, PIN_KIND.incompleteToolCalls);
  });

  it('pins an orphan result as provenance rather than dropping it', () => {
    const blocks = pinFacts({ blocks: normaliseHistory([{ role: 'tool', tool_call_id: 'gone', content: 'stale output' }]) });
    assert.equal(blocks[0].pinned, true);
    assert.equal(blocks[0].reason, PIN_KIND.provenance);
  });
});

describe('C5 pinning and token estimates', () => {
  it('detects every pinned category from markers, without a model', () => {
    const blocks = pinFacts({
      blocks: normaliseHistory([
        { role: 'user', content: 'Goal: ship the parser.' },
        { role: 'user', content: 'Constraint: must not delete user data.' },
        { role: 'user', content: 'Authorization: approved by the operator.' },
        { role: 'user', content: 'Plan: step 1 collect evidence, step 2 write the report.' },
        { role: 'assistant', content: 'The import still fails with ENOENT.' },
      ]),
    });
    const reasons = blocks.map((b) => b.reason);
    assert.ok(reasons.includes(PIN_KIND.currentGoal));
    assert.ok(reasons.includes(PIN_KIND.constraints));
    assert.ok(reasons.includes(PIN_KIND.authorisations));
    assert.ok(reasons.includes(PIN_KIND.activePlan));
    assert.ok(reasons.includes(PIN_KIND.unresolvedErrors));
  });

  it('does not treat a resolved error as unresolved', () => {
    const blocks = pinFacts({ blocks: normaliseHistory([{ role: 'assistant', content: 'The ENOENT error is fixed now and the suite passes.' }]) });
    assert.equal(blocks[0].pinned, false);
  });

  it('marks a path, a flag, a version or an error string as needing exactness', () => {
    assert.equal(requiresExactness({ text: 'open /work/proj/src/a.mjs' }), true);
    assert.equal(requiresExactness({ text: 'run with --offline' }), true);
    assert.equal(requiresExactness({ text: 'node v20.11.1' }), true);
    assert.equal(requiresExactness({ text: 'it fails with ENOENT' }), true);
    assert.equal(requiresExactness({ text: 'some plain prose about the design' }), false);
  });

  it('estimates tokens as a marked heuristic', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
    assert.equal(estimateTokens(12345), 0, 'a non-string is not text');
  });
});

describe('C5 the plan itself', () => {
  it('preserves the original byte-identically', async () => {
    const messages = history();
    const before = structuredClone(messages);
    const envelope = await planContext({ messages, budgetTokens: 80, taskId: TASK, runId: RUN, stubThreshold: 20 });
    assert.deepEqual(messages, before, 'planning must not mutate the history');
    assert.equal(envelope.decision.originalPreserved, true);
  });

  it('never mutates even on the failure path', async () => {
    const messages = history();
    const before = structuredClone(messages);
    await planContext({ messages, budgetTokens: 1, taskId: TASK, runId: RUN });
    assert.deepEqual(messages, before);
  });

  it('keeps the candidate a subsequence of the original, in order', async () => {
    const messages = history();
    const envelope = await planContext({ messages, budgetTokens: 80, taskId: TASK, runId: RUN, stubThreshold: 20 });
    const order = envelope.decision.candidate.map((entry) => (entry.stub === true ? entry.originalIndex : messages.indexOf(entry)));
    assert.ok(order.length > 0);
    for (const index of order) assert.ok(index >= 0, 'every candidate entry came from the original');
    const sorted = [...order].sort((a, b) => a - b);
    assert.deepEqual(order, sorted, 'the candidate must not be reordered');
  });

  it('never splits a tool call from its result', async () => {
    const messages = history();
    const envelope = await planContext({ messages, budgetTokens: 80, taskId: TASK, runId: RUN, stubThreshold: 20 });
    const actions = new Map(envelope.decision.plan.map((entry) => [entry.id, entry.action]));
    const blocks = normaliseHistory(messages);
    for (const block of blocks) {
      if (!block.pairId || String(block.pairId).startsWith('pair-orphan')) continue;
      const twin = blocks.find((other) => other.pairId === block.pairId && other.id !== block.id);
      assert.equal(actions.get(block.id), actions.get(twin.id), `${block.id} and ${twin.id} must share one action`);
    }
  });

  it('keeps a pinned block with a path verbatim, never as a stub', async () => {
    const messages = history();
    const envelope = await planContext({ messages, budgetTokens: 80, taskId: TASK, runId: RUN, stubThreshold: 20 });
    const result = envelope.decision.candidate.find((entry) => entry?.tool_call_id === 'call-1');
    assert.ok(result, 'the pinned tool result must survive');
    assert.equal(result.stub, undefined);
    assert.match(String(result.content), /\/work\/proj\/test\/missing\.mjs/);
  });

  it('covers every dropped and stubbed block in the restore map', async () => {
    const messages = history();
    const envelope = await planContext({ messages, budgetTokens: 80, taskId: TASK, runId: RUN, stubThreshold: 20 });
    const { restoreMap, droppedIds, stubbedIds } = envelope.decision;
    assert.ok(droppedIds.length > 0 && stubbedIds.length > 0, 'this fixture must exercise both actions');
    for (const id of [...droppedIds, ...stubbedIds]) {
      assert.equal(typeof restoreMap[id], 'number', `${id} must be recoverable by id`);
      const block = normaliseHistory(messages).find((b) => b.id === id);
      assert.equal(restoreMap[id], block.originalIndex);
    }
  });

  it('stubs an unpinned long block with its restore target', async () => {
    const messages = history();
    const envelope = await planContext({ messages, budgetTokens: 80, taskId: TASK, runId: RUN, stubThreshold: 20 });
    const stub = envelope.decision.candidate.find((entry) => entry?.stub === true);
    assert.ok(stub);
    assert.equal(typeof stub.restoreTo, 'number');
    assert.match(stub.text, /restore from original index/);
    const block = normaliseHistory(messages).find((b) => b.id === stub.id);
    assert.equal(stub.restoreTo, block.originalIndex);
  });

  it('reports token counts as estimates', async () => {
    const envelope = await planContext({ messages: history(), budgetTokens: 80, taskId: TASK, runId: RUN, stubThreshold: 20 });
    assert.equal(envelope.decision.tokensAreEstimate, true);
    assert.ok(envelope.decision.originalTokens > envelope.decision.candidateTokens, 'the candidate must be smaller here');
  });

  it('keeps an id the caller required', async () => {
    const messages = history();
    const blocks = normaliseHistory(messages);
    const filler = blocks.find((b) => b.text === FILLER);
    const envelope = await planContext({
      messages,
      budgetTokens: 80,
      taskId: TASK,
      runId: RUN,
      stubThreshold: 20,
      keepIds: [filler.id],
    });
    assert.equal(envelope.decision.plan.find((entry) => entry.id === filler.id).action, BLOCK_ACTION.keep);
    assert.ok(envelope.decision.candidate.includes(messages[filler.originalIndex]));
  });
});

describe('C5 the budget it cannot meet', () => {
  const pinnedOnly = [
    { role: 'user', content: `Goal: keep every pinned fact. Constraint: never drop this. ${'x'.repeat(2000)}` },
  ];

  it('refuses instead of returning an oversized candidate', async () => {
    const envelope = await planContext({ messages: pinnedOnly, budgetTokens: 50, taskId: TASK, runId: RUN });
    assert.notEqual(envelope.status, CAPABILITY_STATUS.success);
    assert.equal(envelope.reason.code, CAPABILITY_REASON.contextBudgetExceeded);
    assert.equal(envelope.decision.pinnedOverBudget, true);
    assert.ok(ALL_REASON_CODES.includes(envelope.reason.code));
  });

  it('returns the ORIGINAL as the candidate, with no dropped or stubbed block', async () => {
    const messages = pinnedOnly;
    const before = structuredClone(messages);
    const envelope = await planContext({ messages, budgetTokens: 50, taskId: TASK, runId: RUN });
    assert.deepEqual(envelope.decision.candidate, messages);
    assert.deepEqual(messages, before);
    assert.deepEqual(envelope.decision.droppedIds, []);
    assert.deepEqual(envelope.decision.stubbedIds, []);
    assert.equal(envelope.decision.originalPreserved, true);
  });

  it('never loses a pinned fact, even when the pins do not fit', async () => {
    const envelope = await planContext({ messages: pinnedOnly, budgetTokens: 50, taskId: TASK, runId: RUN });
    const kept = envelope.decision.plan.filter((entry) => entry.action === BLOCK_ACTION.keep).map((entry) => entry.id);
    const pinned = pinFacts({ blocks: normaliseHistory(pinnedOnly) }).filter((block) => block.pinned).map((block) => block.id);
    assert.ok(pinned.length > 0);
    for (const id of pinned) assert.ok(kept.includes(id), `${id} is pinned and must be kept`);
  });
});

describe('C5 envelope honesty', () => {
  it('states the estimate and the unestablished pipeline wiring in limits', async () => {
    const envelope = await planContext({ messages: history(), budgetTokens: 80, taskId: TASK, runId: RUN, stubThreshold: 20 });
    const joined = envelope.limits.join(' ');
    assert.match(joined, /ESTIMATES/i);
    assert.match(joined, /NOT established/i);
    assert.match(joined, /separate DSH interface check/i);
    assert.match(joined, /never be presented as active compaction/i);
    assert.deepEqual(envelope.limits, [...CONTEXT_LIMITS]);
  });

  it('reports no model lane and no action authority', async () => {
    const envelope = await planContext({ messages: history(), budgetTokens: 80, taskId: TASK, runId: RUN, stubThreshold: 20 });
    assert.equal(envelope.model.used, false);
    assert.equal(envelope.actionAuthority, 'none');
    assert.equal(envelope.capability, 'jev_context_plan');
  });

  it('rejects a history that is not an array', async () => {
    await assert.rejects(() => planContext({ messages: 'nope', taskId: TASK, runId: RUN }), /messages must be an array/);
  });

  it('rejects a budget that is not a positive integer', async () => {
    await assert.rejects(() => planContext({ messages: [], budgetTokens: 0, taskId: TASK, runId: RUN }), /budgetTokens/);
  });
});
