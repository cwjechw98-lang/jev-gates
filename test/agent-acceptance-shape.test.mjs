/**
 * Offline shape tests for the real-agent-loop acceptance.
 *
 * What this file is for
 * ---------------------
 * `scripts/jev-agent-acceptance.mjs` boots a real harness, which makes it slow
 * and makes a red result ambiguous: a failure could be the harness, the
 * environment, the isolation, or the assertion logic. Everything here is PURE
 * and runs in milliseconds, so the parts that can be checked without a harness
 * are checked without one:
 *
 *   1. the scripted provider's response sequencing,
 *   2. the stream-chunk assembly shape it emits,
 *   3. the runner's failure-class mapping and verdict arithmetic.
 *
 * What it deliberately does NOT do
 * --------------------------------
 * It never boots DSH, never touches a network, and never asserts that the real
 * loop behaves a certain way. A test that booted the harness would be a second,
 * slower copy of the acceptance — and it would still not prove the mechanism,
 * because the mechanism is the harness's behaviour, not this file's.
 *
 * The instrument is tested too: several cases below assert that a check FAILS
 * when it should. A suite that can only produce green is not evidence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXHAUSTED_TEXT,
  PROVIDER_ID,
  MODEL_ID,
  emptyScript,
  normaliseScript,
  pickResponse,
  isScripted,
  chunksForResponse,
  blocksForResponse,
  userTexts,
} from '../adapters/dsh/scripted-provider.mjs';

import {
  MODE,
  SETS,
  JEV_TOOLS,
  NOT_DRIVEN_CLASSES,
  FAILURE_CLASSES,
  expect as expectCheck,
  failureClass,
  verdictOf,
  exitCodeOf,
  checksForSet,
  checksForS2,
  checksForS4,
  bootsFor,
} from '../scripts/jev-agent-acceptance.mjs';

// --- fixtures ----------------------------------------------------------------

/** One scripted response carrying a tool call and nothing else. */
function toolCallResponse(label = 'call', name = 'jev_marker', id = 'call-1') {
  return { label, stop: 'tool-calls', blocks: [{ type: 'tool-call', id, name, arguments: { path: 'x.marker' } }] };
}

/** One scripted response carrying plain text and nothing else. */
function textResponse(label = 'text', text = 'done') {
  return { label, stop: 'stop', blocks: [{ type: 'text', text }] };
}

/** A scenario observation with every field the checks read, all healthy. */
function healthyScenario(overrides = {}) {
  return {
    set: 's1',
    mode: MODE,
    notes: [],
    agent: { id: 'agent-1', sessionId: 'session-1' },
    catalog: {
      count: JEV_TOOLS.length,
      names: [...JEV_TOOLS],
      jevTools: JEV_TOOLS.map((name) => ({ name, descriptionLength: 20, parametersType: 'object' })),
    },
    events: {
      toolCalls: [{ callId: 'call-1', name: 'jev_marker', arguments: '{"path":"s1-marker.marker"}' }],
      toolResults: [{ callId: 'call-1', name: 'jev_marker', isError: false, text: 'ok' }],
      approvals: [],
      assistantMessages: [{ turn: 1, step: 1 }],
      steps: [{ turn: 1, step: 1 }, { turn: 1, step: 2 }],
      turnEnds: [{ turn: 1, reason: { kind: 'completed' } }],
      userMessages: [{ source: 'user', text: 'probe' }],
    },
    ...overrides,
  };
}

/** A provider summary with one recorded call per label given. */
function healthyProvider(labels = ['a', 'b']) {
  return {
    mode: MODE,
    provider: PROVIDER_ID,
    model: MODEL_ID,
    conversationCalls: labels.length,
    auxCalls: 1,
    lastLabel: labels[labels.length - 1] ?? null,
    calls: labels.map((label, index) => ({ index, label, scripted: true, lastUserText: null, userTexts: [], messageCount: 2 })),
  };
}

/** The healthy marker map. */
const HEALTHY_MARKERS = { s1: true, s2: true, s3Approved: true, s3Rejected: false, s4: true };

// --- 1. provider response sequencing -----------------------------------------

test('the scripted provider advances through its script in order', () => {
  const script = normaliseScript({ responses: [toolCallResponse('one'), textResponse('two'), textResponse('three')] });
  assert.equal(script.responses.length, 3);
  assert.equal(pickResponse(script, 0).label, 'one');
  assert.equal(pickResponse(script, 1).label, 'two');
  assert.equal(pickResponse(script, 2).label, 'three');
});

test('an exhausted script returns the same terminal response forever', () => {
  const script = normaliseScript({ responses: [textResponse('only')] });
  assert.equal(pickResponse(script, 0).label, 'only');
  // The terminal response is stable, so a loop that keeps asking cannot look
  // like a loop that keeps producing new content.
  for (const index of [1, 2, 99]) {
    const response = pickResponse(script, index);
    assert.equal(response.label, 'exhausted');
    assert.equal(response.blocks[0].text, EXHAUSTED_TEXT);
    assert.deepEqual(response, pickResponse(script, index));
  }
});

test('isScripted separates a scripted step from an exhausted one', () => {
  const script = normaliseScript({ responses: [textResponse('a'), textResponse('b')] });
  assert.equal(isScripted(script, 0), true);
  assert.equal(isScripted(script, 1), true);
  assert.equal(isScripted(script, 2), false);
  assert.equal(isScripted(script, -1), false);
  assert.equal(isScripted(emptyScript(), 0), false);
});

test('a malformed script becomes an empty script rather than a partial one', () => {
  // A half-applied script is worse than none: it makes the provider look
  // nondeterministic, and a nondeterministic provider cannot be a test fixture.
  assert.deepEqual(normaliseScript(null), emptyScript());
  assert.deepEqual(normaliseScript('not an object'), emptyScript());
  assert.deepEqual(normaliseScript({ responses: 'not an array' }), emptyScript());
  // A response without blocks is dropped, and the rest are kept.
  const mixed = normaliseScript({ responses: [textResponse('keep'), { label: 'no-blocks' }, null] });
  assert.equal(mixed.responses.length, 1);
  assert.equal(mixed.responses[0].label, 'keep');
  // A script with no provider/model falls back to the scripted route.
  const named = normaliseScript({ responses: [] });
  assert.equal(named.provider, PROVIDER_ID);
  assert.equal(named.model, MODEL_ID);
});

test('a response with an empty block list still advances the sequence', () => {
  const script = normaliseScript({ responses: [{ label: 'empty', stop: 'stop', blocks: [] }, textResponse('after')] });
  assert.equal(pickResponse(script, 0).label, 'empty');
  assert.equal(pickResponse(script, 1).label, 'after');
  assert.equal(isScripted(script, 0), true);
});

// --- 2. stream-chunk assembly shape ------------------------------------------

test('a text block emits start, delta, end at one index with the assembled block', () => {
  const chunks = chunksForResponse(textResponse('t', 'hello'));
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' });
  assert.deepEqual(chunks[1], { type: 'text-delta', index: 0, text: 'hello' });
  assert.deepEqual(chunks[2], { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } });
});

test('a tool-call block emits an id, a name and JSON arguments the loop can parse', () => {
  const chunks = chunksForResponse(toolCallResponse('t', 'jev_marker', 'call-9'));
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'tool-call' });
  const delta = chunks.find((chunk) => chunk.type === 'tool-call-delta');
  assert.equal(delta.index, 0);
  assert.equal(delta.id, 'call-9');
  assert.equal(delta.name, 'jev_marker');
  // This is the contract the real loop depends on: `ToolCallBlock.arguments` is
  // documented as "raw JSON string as produced by the model", so the delta must
  // be a string, and it must parse back to exactly the declared arguments.
  assert.equal(typeof delta.argumentsDelta, 'string');
  assert.deepEqual(JSON.parse(delta.argumentsDelta), { path: 'x.marker' });
  const end = chunks.find((chunk) => chunk.type === 'block-end');
  assert.deepEqual(end.block, { type: 'tool-call', id: 'call-9', name: 'jev_marker', arguments: '{"path":"x.marker"}' });
  assert.equal(typeof end.block.arguments, 'string');
});

test('every block-start has a matching block-end and the indices are sequential', () => {
  const chunks = chunksForResponse({ label: 'multi', stop: 'tool-calls', blocks: [{ type: 'text', text: 'a' }, { type: 'tool-call', id: 'c1', name: 'n', arguments: {} }, { type: 'text', text: 'b' }] });
  const starts = chunks.filter((chunk) => chunk.type === 'block-start');
  const ends = chunks.filter((chunk) => chunk.type === 'block-end');
  assert.equal(starts.length, 3);
  assert.equal(ends.length, 3);
  assert.deepEqual(starts.map((chunk) => chunk.index), [0, 1, 2]);
  assert.deepEqual(ends.map((chunk) => chunk.index), [0, 1, 2]);
  assert.deepEqual(starts.map((chunk) => chunk.blockType), ['text', 'tool-call', 'text']);
  // An index that closes must be the index that opened, in order.
  for (const [position, end] of ends.entries()) assert.equal(end.index, starts[position].index);
});

test('usage precedes finish, and finish is always last', () => {
  const chunks = chunksForResponse(textResponse());
  const usage = chunks.findIndex((chunk) => chunk.type === 'usage');
  const finish = chunks.findIndex((chunk) => chunk.type === 'finish');
  assert.ok(usage > -1 && finish > -1);
  assert.ok(usage < finish);
  assert.equal(finish, chunks.length - 1);
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
  assert.equal(chunks.filter((chunk) => chunk.type === 'usage').length, 1);
});

test('finish reports tool-calls only when the script says so', () => {
  assert.equal(chunksForResponse(toolCallResponse()).at(-1).reason.kind, 'tool-calls');
  assert.equal(chunksForResponse(textResponse()).at(-1).reason.kind, 'stop');
  // An unset `stop` is a plain stop, never a tool call: guessing the other way
  // would let a fixture silently keep the loop alive.
  assert.equal(chunksForResponse({ blocks: [] }).at(-1).reason.kind, 'stop');
});

test('a tool call without an id gets a deterministic one, so a stream is reproducible', () => {
  const first = chunksForResponse({ blocks: [{ type: 'tool-call', name: 'n', arguments: {} }] });
  const second = chunksForResponse({ blocks: [{ type: 'tool-call', name: 'n', arguments: {} }] });
  assert.equal(first.find((chunk) => chunk.type === 'tool-call-delta').id, 'call-0');
  assert.deepEqual(first, second);
});

test('string arguments pass through untouched and unparseable ones do not throw', () => {
  const asString = chunksForResponse({ blocks: [{ type: 'tool-call', id: 'c', name: 'n', arguments: '{"a":1}' }] });
  assert.equal(asString.find((chunk) => chunk.type === 'tool-call-delta').argumentsDelta, '{"a":1}');
  const cyclic = { blocks: [{ type: 'tool-call', id: 'c', name: 'n', arguments: {} }] };
  cyclic.blocks[0].arguments = cyclic;
  assert.equal(chunksForResponse(cyclic).find((chunk) => chunk.type === 'tool-call-delta').argumentsDelta, '{}');
});

test('blocksForResponse mirrors what the chunks claim to assemble', () => {
  const response = { blocks: [{ type: 'text', text: 'a' }, { type: 'tool-call', id: 'c1', name: 'n', arguments: { k: 'v' } }] };
  const blocks = blocksForResponse(response);
  assert.deepEqual(blocks[0], { type: 'text', text: 'a' });
  assert.deepEqual(blocks[1], { type: 'tool-call', id: 'c1', name: 'n', arguments: '{"k":"v"}' });
  const ends = chunksForResponse(response).filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block);
  assert.deepEqual(ends, blocks);
});

test('userTexts keeps the steer even when the harness appends its own user turns', () => {
  // This is the shape that made a naive "last user message" check useless: the
  // loop appends runtime-context and skill-catalog messages as user-role turns,
  // so the steer is not last.
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'probe' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    { role: 'user', content: [{ type: 'text', text: 'runtime context' }] },
    { role: 'user', content: [{ type: 'text', text: 'jev-gates: "x" is still unconfirmed' }] },
    { role: 'user', content: [{ type: 'text', text: 'skill catalog' }] },
  ];
  const texts = userTexts(messages);
  assert.equal(texts.length, 4);
  assert.ok(texts.some((text) => text.includes('is still unconfirmed')));
  assert.deepEqual(userTexts(null), []);
});

// --- 3. runner failure-class mapping -----------------------------------------

test('the class vocabulary is split between "not driven" and "driven and wrong"', () => {
  // The split is the whole point of the taxonomy: neither list may contain the
  // other's members, and neither may contain `held`.
  assert.ok(NOT_DRIVEN_CLASSES.length > 0 && FAILURE_CLASSES.length > 0);
  for (const name of NOT_DRIVEN_CLASSES) assert.equal(FAILURE_CLASSES.includes(name), false, `${name} is in both lists`);
  assert.equal(NOT_DRIVEN_CLASSES.includes('held'), false);
  assert.equal(FAILURE_CLASSES.includes('held'), false);
  assert.equal(NOT_DRIVEN_CLASSES.includes('assertion-failed'), false);
  assert.equal(FAILURE_CLASSES.includes('assertion-failed'), true);
});

test('failureClass reports a boot timeout before anything else', () => {
  assert.equal(failureClass({ bootTimedOut: true }), 'boot-timeout');
  // Even with a scenario and a provider present: the boot is the first cause.
  assert.equal(failureClass({ bootTimedOut: true, scenario: healthyScenario(), provider: healthyProvider() }), 'boot-timeout');
});

test('failureClass walks the causes in order and stops at the first true one', () => {
  assert.equal(failureClass({}), 'harness-not-driven');
  assert.equal(failureClass({ scenario: null, provider: healthyProvider() }), 'harness-not-driven');
  assert.equal(failureClass({ scenario: { notes: [{ name: 'fatal', error: 'x' }] } }), 'harness-not-driven');
  assert.equal(failureClass({ scenario: { notes: [{ name: 'claim:write-failed' }] } }), 'harness-not-driven');
  assert.equal(failureClass({ scenario: healthyScenario(), provider: null }), 'provider-not-called');
  assert.equal(failureClass({ scenario: healthyScenario(), provider: { conversationCalls: 0 } }), 'provider-not-called');
  assert.equal(failureClass({ scenario: healthyScenario(), provider: { conversationCalls: 'two' } }), 'provider-not-called');
});

test('a reached provider with no assistant message is a malformed stream', () => {
  const scenario = healthyScenario();
  scenario.events.assistantMessages = [];
  assert.equal(failureClass({ scenario, provider: healthyProvider() }), 'provider-stream-malformed');
});

test('a turn that produced messages and then failed is NOT a malformed stream', () => {
  // This distinction is the reason the class exists at all. A turn that died
  // later has a cause worth reporting; calling it a stream failure would hide
  // that cause behind a plausible-sounding label.
  const scenario = healthyScenario();
  scenario.events.turnEnds = [{ turn: 1, reason: { kind: 'error', error: { message: "Cannot read properties of undefined (reading 'kind')" } } }];
  scenario.notes = [{ name: 'agent:error', error: "Cannot read properties of undefined (reading 'kind')" }];
  assert.equal(failureClass({ scenario, provider: healthyProvider() }), null);
});

test('a scenario that observed no agent is a listener that never attached', () => {
  const scenario = healthyScenario({ agent: null, catalog: null });
  assert.equal(failureClass({ scenario, provider: healthyProvider() }), 'listener-not-attached');
});

test('tool calls with no results are tool-not-invoked', () => {
  const scenario = healthyScenario();
  scenario.events.toolResults = [];
  assert.equal(failureClass({ scenario, provider: healthyProvider() }), 'tool-not-invoked');
  // No tool calls at all is not this class: nothing was supposed to be invoked.
  const noCalls = healthyScenario();
  noCalls.events.toolCalls = [];
  noCalls.events.toolResults = [];
  assert.equal(failureClass({ scenario: noCalls, provider: healthyProvider() }), null);
});

test('a fully driven set has no infrastructure class', () => {
  assert.equal(failureClass({ scenario: healthyScenario(), provider: healthyProvider() }), null);
});

test('verdictOf prefers "not driven" over "not held", because it is the weaker claim', () => {
  assert.equal(verdictOf([]), 'not-driven');
  assert.equal(verdictOf([{ class: 'held' }, { class: 'held' }]), 'held');
  assert.equal(verdictOf([{ class: 'held' }, { class: 'assertion-failed' }]), 'not-held');
  assert.equal(verdictOf([{ class: 'blocked-by-interface' }]), 'not-held');
  // One undriven set makes the whole report undriven: the run cannot claim to
  // have measured something it never reached.
  assert.equal(verdictOf([{ class: 'held' }, { class: 'boot-timeout' }]), 'not-driven');
  assert.equal(verdictOf([{ class: 'provider-not-called' }]), 'not-driven');
  // An unrecognised class is not silently promoted to a pass.
  assert.equal(verdictOf([{ class: 'something-new' }]), 'not-driven');
});

test('exitCodeOf maps the three verdicts to three distinct codes', () => {
  assert.equal(exitCodeOf('held'), 0);
  assert.equal(exitCodeOf('not-held'), 1);
  assert.equal(exitCodeOf('not-driven'), 3);
  assert.equal(new Set([exitCodeOf('held'), exitCodeOf('not-held'), exitCodeOf('not-driven')]).size, 3);
});

test('expectCheck coerces `ok` to a real boolean and keeps the evidence', () => {
  assert.deepEqual(expectCheck('a', true, { x: 1 }), { name: 'a', ok: true, detail: { x: 1 } });
  assert.deepEqual(expectCheck('b', false), { name: 'b', ok: false, detail: null });
  // A truthy non-boolean must not become a pass by accident.
  assert.equal(expectCheck('c', 'yes').ok, false);
  assert.equal(expectCheck('d', 1).ok, false);
  assert.equal(expectCheck('e', undefined).ok, false);
});

// --- 4. the checks themselves, on synthetic observations ---------------------
//
// These matter more than they look. `checksForSet` is where a scenario turns
// into a verdict, so a bug there is a bug in the measuring instrument. Each
// group asserts BOTH directions: that a healthy observation passes, and that a
// deliberately broken one fails.

test('S1 passes on a healthy observation and fails on a missing marker', () => {
  const healthy = checksForSet('s1', { s1: { scenario: healthyScenario(), provider: healthyProvider(), markers: HEALTHY_MARKERS } });
  assert.equal(healthy.filter((check) => !check.ok).length, 0, JSON.stringify(healthy.filter((check) => !check.ok)));

  const broken = checksForSet('s1', { s1: { scenario: healthyScenario(), provider: healthyProvider(), markers: { ...HEALTHY_MARKERS, s1: false } } });
  const failures = broken.filter((check) => !check.ok);
  assert.equal(failures.length, 1);
  assert.match(failures[0].name, /marker file/);
});

test('S1 fails when the provider was never called, even if the tool ran', () => {
  const provider = { ...healthyProvider(['a']), conversationCalls: 1 };
  const checks = checksForSet('s1', { s1: { scenario: healthyScenario(), provider, markers: HEALTHY_MARKERS } });
  assert.ok(checks.some((check) => !check.ok && /called once per step/.test(check.name)));
});

test('the catalog check fails when a capability tool is missing', () => {
  const scenario = healthyScenario();
  scenario.catalog.jevTools = scenario.catalog.jevTools.slice(1);
  const checks = checksForSet('s1', { s1: { scenario, provider: healthyProvider(), markers: HEALTHY_MARKERS } });
  assert.ok(checks.some((check) => !check.ok && /carries all six capability tools/.test(check.name)));
});

test('the catalog check is not satisfied by the scenario fixture tools alone', () => {
  // The scenario plugin registers marker tools under the same `jev_` prefix. A
  // check that counted the prefix would pass on the fixtures and say nothing
  // about the product, so the check names the six tools instead.
  const scenario = healthyScenario();
  scenario.catalog.jevTools = ['jev_marker', 'jev_benign', 'jev_foreign', 'jev_artifact', 'jev_gated_ok', 'jev_gated_no'].map((name) => ({ name, descriptionLength: 5, parametersType: 'object' }));
  const checks = checksForSet('s1', { s1: { scenario, provider: healthyProvider(), markers: HEALTHY_MARKERS } });
  assert.ok(checks.some((check) => !check.ok && /carries all six capability tools/.test(check.name)));
});

test('S2 passes when the adapter steers a complete UserMessage', () => {
  // The control boot: the loop accepted a well-formed steer and ran one more step.
  const control = {
    scenario: {
      ...healthyScenario(),
      turnStopping: [{ turn: 1, providerConversationCalls: 2 }, { turn: 1, providerConversationCalls: 3 }],
      scenarioSteer: [
        { turn: 1, steer: true, repeated: false, confirmed: false, gateExitCode: 3, reason: 'steer text' },
        { turn: 1, steer: false, repeated: true, confirmed: false, gateExitCode: 3, reason: null },
      ],
    },
    provider: {
      ...healthyProvider(['a', 'b', 'c']),
      calls: [
        { index: 0, label: 'a', userTexts: [] },
        { index: 1, label: 'b', userTexts: [] },
        { index: 2, label: 'c', userTexts: ['jev-gates: "x" is still unconfirmed'] },
      ],
    },
    markers: HEALTHY_MARKERS,
    claimPending: true,
  };

  // The adapter boot as it behaves after the fix in `adapters/dsh/plugin.mjs`:
  // the steer carries the `source` and `id` a `UserMessage` requires, the loop
  // accepts it, and the turn completes.
  const adapterOk = {
    scenario: {
      ...healthyScenario(),
      turnStopping: [{ turn: 1, providerConversationCalls: 2 }, { turn: 1, providerConversationCalls: 3 }],
      adapterDecision: { recomputed: true, steer: true, steerText: 'steer text' },
      inboxSplices: [{ target: 'next-step', removed: 0, inserted: [{ hasSource: true, hasId: true, sourceKind: 'plugin', contentTypes: ['text'], text: 'steer text' }] }],
      events: { ...healthyScenario().events, turnEnds: [{ turn: 1, reason: { kind: 'completed' } }] },
    },
    provider: healthyProvider(['a', 'b', 'c']),
    markers: HEALTHY_MARKERS,
    claimPending: true,
  };

  const checks = checksForS2({ 's2-adapter': adapterOk, 's2-wellformed': control });
  const failures = checks.filter((check) => !check.ok);
  assert.equal(failures.length, 0, `expected the fixed adapter to pass every S2 check, got ${JSON.stringify(failures)}`);
  assert.ok(checks.some((check) => check.ok && /carries the `source` and `id`/.test(check.name)));
  assert.ok(checks.some((check) => check.ok && /anti-loop/.test(check.name)));
});

test('S2 fails again if the adapter steer loses its source', () => {
  // The regression guard. This is the exact boot that found the defect, so if the
  // message is ever malformed again the acceptance says so by name instead of
  // passing quietly.
  const control = {
    scenario: {
      ...healthyScenario(),
      turnStopping: [{ turn: 1, providerConversationCalls: 2 }, { turn: 1, providerConversationCalls: 3 }],
      scenarioSteer: [
        { turn: 1, steer: true, repeated: false, confirmed: false, gateExitCode: 3, reason: 'steer text' },
        { turn: 1, steer: false, repeated: true, confirmed: false, gateExitCode: 3, reason: null },
      ],
    },
    provider: {
      ...healthyProvider(['a', 'b', 'c']),
      calls: [{ index: 0, label: 'a', userTexts: [] }, { index: 1, label: 'b', userTexts: [] }, { index: 2, label: 'c', userTexts: ['jev-gates: "x" is still unconfirmed'] }],
    },
    markers: HEALTHY_MARKERS,
    claimPending: true,
  };
  const adapterBroken = {
    scenario: {
      ...healthyScenario(),
      turnStopping: [{ turn: 1, providerConversationCalls: 2 }],
      adapterDecision: { recomputed: true, steer: true, steerText: 'steer text' },
      inboxSplices: [{ target: 'next-step', removed: 0, inserted: [{ hasSource: false, hasId: false, sourceKind: null, contentTypes: ['text'], text: 'steer text' }] }],
      events: { ...healthyScenario().events, turnEnds: [{ turn: 1, reason: { kind: 'error', error: { message: "Cannot read properties of undefined (reading 'kind')" } } }] },
    },
    provider: healthyProvider(['a', 'b']),
    markers: HEALTHY_MARKERS,
    claimPending: true,
  };

  const failures = checksForS2({ 's2-adapter': adapterBroken, 's2-wellformed': control }).filter((check) => !check.ok);
  assert.ok(failures.length >= 1, 'a malformed steer must not pass');
  assert.ok(
    failures.some((check) => /carries the `source` and `id`/.test(check.name)),
    `expected the source check to fail, got ${JSON.stringify(failures.map((f) => f.name))}`,
  );
  assert.ok(
    failures.some((check) => /did not die on the `source\.kind` TypeError/.test(check.name)),
    `expected the turn-end check to fail, got ${JSON.stringify(failures.map((f) => f.name))}`,
  );
});

test('S2 fails when the control boot never took the extra step', () => {
  // If the control cannot produce the extra step, the defect is not isolated and
  // the whole diagnosis is unsupported — so the control's own checks must fail.
  const adapterBroken = {
    scenario: {
      ...healthyScenario(),
      turnStopping: [{ turn: 1, providerConversationCalls: 2 }],
      adapterDecision: { recomputed: true, steer: true, steerText: 'steer text' },
      inboxSplices: [{ target: 'next-step', inserted: [{ hasSource: false, hasId: false, contentTypes: ['text'], text: 'steer text' }] }],
      events: { ...healthyScenario().events, turnEnds: [{ turn: 1, reason: { kind: 'error', error: { message: "Cannot read properties of undefined (reading 'kind')" } } }] },
    },
    provider: healthyProvider(['a', 'b']),
    markers: HEALTHY_MARKERS,
    claimPending: true,
  };
  const control = {
    scenario: { ...healthyScenario(), turnStopping: [{ turn: 1, providerConversationCalls: 2 }], scenarioSteer: [{ turn: 1, steer: true, repeated: false, gateExitCode: 3 }] },
    provider: healthyProvider(['a', 'b']),
    markers: HEALTHY_MARKERS,
    claimPending: true,
  };
  const failures = checksForS2({ 's2-adapter': adapterBroken, 's2-wellformed': control }).filter((check) => !check.ok);
  assert.ok(failures.some((check) => /well-formed agent\.steer/.test(check.name)));
  assert.ok(failures.some((check) => /2 -> 3/.test(check.name)));
});

test('S4 passes when the adapter runs both verification phases', () => {
  // Both boots now take the same two-phase path: verify, fail, steer, fix,
  // verify, confirm. The adapter boot is the one under test; the control omits the
  // adapter and steers from the scenario, and is what tells "the loop broke" apart
  // from "our message broke".
  const twoPhase = () => ({
    scenario: {
      ...healthyScenario(),
      verify: [
        { turn: 1, status: 'success', exitCode: 1, reasonCode: 'criterion_failed', snapshotDigest: 'sha256:aa', artifactText: 'WRONG' },
        { turn: 1, status: 'success', exitCode: 0, reasonCode: 'confirmed', snapshotDigest: 'sha256:bb', artifactText: 'CORRECT' },
      ],
      turnStopping: [{ turn: 1, providerConversationCalls: 2 }, { turn: 1, providerConversationCalls: 4 }],
      scenarioSteer: [
        { turn: 1, steer: true, confirmed: false, gateExitCode: 1 },
        { turn: 1, steer: false, confirmed: true, gateExitCode: 0 },
      ],
      events: { ...healthyScenario().events, turnEnds: [{ turn: 1, reason: { kind: 'completed' } }] },
    },
    provider: healthyProvider(['a', 'b', 'c', 'd']),
    markers: HEALTHY_MARKERS,
    claimPending: false,
  });
  const adapterBoot = twoPhase();
  const controlBoot = twoPhase();
  const checks = checksForS4({ 's4-adapter': adapterBoot, 's4-wellformed': controlBoot });
  assert.equal(checks.filter((check) => !check.ok).length, 0, JSON.stringify(checks.filter((check) => !check.ok)));

  // The regression guard: an aborted turn must fail by name, not pass quietly.
  const aborted = {
    ...adapterBoot,
    scenario: {
      ...adapterBoot.scenario,
      verify: [adapterBoot.scenario.verify[0]],
      events: { ...healthyScenario().events, turnEnds: [{ turn: 1, reason: { kind: 'error', error: { message: "Cannot read properties of undefined (reading 'kind')" } } }] },
    },
  };
  const abortedFailures = checksForS4({ 's4-adapter': aborted, 's4-wellformed': controlBoot }).filter((check) => !check.ok);
  assert.ok(
    abortedFailures.some((check) => /survived the adapter's steer/.test(check.name)),
    `expected the abort to fail by name, got ${JSON.stringify(abortedFailures.map((f) => f.name))}`,
  );

  // A control that never confirmed must fail, not pass quietly.
  const unconfirmed = { ...controlBoot, scenario: { ...controlBoot.scenario, verify: [controlBoot.scenario.verify[0], { ...controlBoot.scenario.verify[1], exitCode: 1 }] } };
  const failures = checksForS4({ 's4-adapter': adapterBoot, 's4-wellformed': unconfirmed }).filter((check) => !check.ok);
  assert.ok(failures.some((check) => /second verification returned a confirmed verdict/.test(check.name)));
});

test('S5 fails when an explicit choice does not win', () => {
  const scenario = {
    ...healthyScenario(),
    skillRoute: [
      { label: 'auto', status: 'success', recommended: 'jev-completion-gate', source: 'deterministic', excludedLength: 0, limits: ['the deterministic filter is only as complete as the skills\' declared requires fields'] },
      { label: 'none', status: 'abstain', recommended: null, source: 'none', explicitSkillExists: false, limits: [] },
      { label: 'explicit', status: 'success', recommended: 'jev-completion-gate', source: 'explicit', load: { ok: true, path: '/skills/jev-completion-gate/SKILL.md', contentLength: 100 }, limits: [] },
      { label: 'filtered', status: 'success', recommended: 'jev-completion-gate', source: 'deterministic', excludedLength: 0, limits: ['the deterministic filter is only as complete as the skills\' declared requires fields'] },
    ],
  };
  const healthy = checksForSet('s5', { s5: { scenario, provider: healthyProvider(['a']), markers: HEALTHY_MARKERS } });
  const nonCatalog = healthy.filter((check) => !check.ok && !/exists in the skill root/.test(check.name));
  assert.equal(nonCatalog.length, 0, JSON.stringify(nonCatalog));

  const ignored = { ...scenario, skillRoute: scenario.skillRoute.map((entry) => (entry.label === 'explicit' ? { ...entry, source: 'deterministic' } : entry)) };
  const failures = checksForSet('s5', { s5: { scenario: ignored, provider: healthyProvider(['a']), markers: HEALTHY_MARKERS } }).filter((check) => !check.ok);
  assert.ok(failures.some((check) => /explicit user choice wins/.test(check.name)));
});

test('S5 fails when the router abstains and yet names a skill', () => {
  const scenario = {
    ...healthyScenario(),
    skillRoute: [
      { label: 'auto', status: 'success', recommended: 'jev-completion-gate', source: 'deterministic', excludedLength: 0, limits: [] },
      { label: 'none', status: 'abstain', recommended: 'jev-completion-gate', source: 'none', explicitSkillExists: false, limits: [] },
      { label: 'explicit', status: 'success', recommended: 'jev-completion-gate', source: 'explicit', load: { ok: true, path: '/x', contentLength: 1 }, limits: [] },
      { label: 'filtered', status: 'success', recommended: 'jev-completion-gate', source: 'deterministic', excludedLength: 0, limits: [] },
    ],
  };
  const failures = checksForSet('s5', { s5: { scenario, provider: healthyProvider(['a']), markers: HEALTHY_MARKERS } }).filter((check) => !check.ok);
  assert.ok(failures.some((check) => /abstains instead of inventing a skill/.test(check.name)));
});

test('S3 fails when the rejected tool still ran', () => {
  const scenario = {
    ...healthyScenario(),
    approval: { answerer: 'test', serviceMounted: true, decisions: [{ toolName: 'jev_gated_ok', agentId: 'agent-1', sessionId: 'session-1', callId: 's3-call-ok' }, { toolName: 'jev_gated_no', agentId: 'agent-1', sessionId: 'session-1', callId: 's3-call-no' }] },
    events: {
      ...healthyScenario().events,
      toolCalls: [{ callId: 's3-call-ok', name: 'jev_gated_ok' }, { callId: 's3-call-no', name: 'jev_gated_no' }],
      toolResults: [
        { callId: 's3-call-ok', name: 'jev_gated_ok', isError: false, text: 'ok' },
        { callId: 's3-call-no', name: 'jev_gated_no', isError: true, text: 'denied: rejected by policy' },
      ],
      approvals: [{ toolName: 'jev_gated_ok', outcome: 'allowed-once' }, { toolName: 'jev_gated_no', outcome: 'rejected' }],
    },
  };
  const healthy = checksForSet('s3', { s3: { scenario, provider: healthyProvider(['a', 'b']), markers: HEALTHY_MARKERS } });
  assert.equal(healthy.filter((check) => !check.ok).length, 0, JSON.stringify(healthy.filter((check) => !check.ok)));

  // The rejected tool left a marker: the gate did not hold, and the check must say so.
  const leaked = checksForSet('s3', { s3: { scenario, provider: healthyProvider(['a', 'b']), markers: { ...HEALTHY_MARKERS, s3Rejected: true } } });
  assert.ok(leaked.some((check) => !check.ok && /rejected tool did not run/.test(check.name)));

  // The answerer saw a different agent: identity was not preserved.
  const otherAgent = { ...scenario, approval: { ...scenario.approval, decisions: scenario.approval.decisions.map((d) => ({ ...d, agentId: 'agent-other' })) } };
  const wrongIdentity = checksForSet('s3', { s3: { scenario: otherAgent, provider: healthyProvider(['a', 'b']), markers: HEALTHY_MARKERS } });
  assert.ok(wrongIdentity.some((check) => !check.ok && /same agent identity/.test(check.name)));
});

// --- 5. the boot plan --------------------------------------------------------

test('only the sets whose subject is steering run a second, adapter-free boot', () => {
  assert.deepEqual(bootsFor('s2').map((plan) => plan.id), ['s2-adapter', 's2-wellformed']);
  assert.deepEqual(bootsFor('s4').map((plan) => plan.id), ['s4-adapter', 's4-wellformed']);
  // The adapter is mounted in the first boot and absent in the second, or the
  // control would be observing the thing it is supposed to isolate.
  assert.equal(bootsFor('s2')[0].mountAdapter, true);
  assert.equal(bootsFor('s2')[1].mountAdapter, false);
  for (const name of ['s1', 's3', 's5']) {
    const plans = bootsFor(name);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].mountAdapter, true);
  }
  assert.deepEqual(SETS, ['s1', 's2', 's3', 's4', 's5']);
});

test('every set name has a boot plan and every check name is prefixed with its set', () => {
  for (const name of SETS) {
    assert.ok(bootsFor(name).length >= 1);
    const checks = checksForSet(name, { [name]: { scenario: healthyScenario(), provider: healthyProvider(), markers: HEALTHY_MARKERS } });
    assert.ok(checks.length > 0, `${name} produced no checks`);
    for (const check of checks) assert.ok(check.name.startsWith(`${name}: `), `${check.name} is not prefixed with ${name}`);
  }
});
