/**
 * Offline regression tests for the native DSH adapter.
 *
 * These pin the behaviour the runtime acceptance proved, so a later edit that
 * breaks it fails here in milliseconds instead of needing a harness boot. They
 * are NOT a substitute for `scripts/jev-dsh-acceptance.mjs`: a fake context can
 * only show that this code takes the branch it says it takes. The runtime run is
 * what shows the harness agrees.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { classifyCommand } from '../adapters/dsh/classify.mjs';
import { decideStop, runGateForClaim } from '../adapters/dsh/bridge.mjs';
import { readClaim, writeClaim, clearClaim } from '../adapters/dsh/claim.mjs';
import { apply as applyAdapter } from '../adapters/dsh/plugin.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'jev-adapter-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The rule shape the acceptance uses: a tool name, not a command. */
const TOOL_RULE = [{ name: 'requires_authorization', tool: /^jev_marker$/i, flags: ['authorization_required'] }];

describe('classification by tool name', () => {
  it('marks a tool named by a rule as irreversible', () => {
    const result = classifyCommand('', { toolName: 'jev_marker', rules: TOOL_RULE });
    assert.equal(result.irreversible, true);
    assert.deepEqual(result.flags, ['authorization_required']);
    assert.equal(result.action, 'requires_authorization');
  });

  it('leaves an unnamed tool alone', () => {
    const result = classifyCommand('', { toolName: 'jev_benign', rules: TOOL_RULE });
    assert.equal(result.irreversible, false);
    assert.deepEqual(result.flags, []);
  });

  it('still classifies by command text when a rule has no tool pattern', () => {
    const result = classifyCommand('git push --force origin main', { toolName: 'Bash', rules: TOOL_RULE });
    // The acceptance rules replace the defaults, so a command rule that is not in
    // them does not fire — that is the documented meaning of passing `rules`.
    assert.equal(result.irreversible, false);
    const withDefaults = classifyCommand('git push --force origin main', { toolName: 'Bash' });
    assert.equal(withDefaults.irreversible, true);
  });
});

describe('the Stop anti-loop key', () => {
  const claim = { claim: 'the artifact is present' };

  it('steers once for an unresolved claim', () => {
    const outcome = decideStop({ sessionId: 's', state: {}, pendingClaim: claim, key: 'k1' });
    assert.equal(outcome.steer, true);
    assert.equal(outcome.steers, 1);
  });

  it('refuses to steer again for the same key, even with budget left', () => {
    const outcome = decideStop({ sessionId: 's', state: { steers: 1, lastKey: 'k1' }, pendingClaim: claim, key: 'k1' });
    assert.equal(outcome.steer, false);
    assert.equal(outcome.repeated, true);
    assert.equal(outcome.steers, 1);
  });

  it('steers again when the key changes, which is what new evidence looks like', () => {
    const outcome = decideStop({ sessionId: 's', state: { steers: 1, lastKey: 'k1' }, pendingClaim: claim, key: 'k2' });
    assert.equal(outcome.steer, true);
    assert.equal(outcome.steers, 2);
  });

  it('stops at the budget and says the run ends incomplete', () => {
    const outcome = decideStop({ sessionId: 's', state: { steers: 2, lastKey: 'k1' }, maxSteers: 2, pendingClaim: claim, key: 'k2' });
    assert.equal(outcome.steer, false);
    assert.equal(outcome.exhausted, true);
    assert.match(outcome.reason, /incomplete, not as confirmed/);
  });

  it('clears a confirmed claim instead of steering', () => {
    const outcome = decideStop({ sessionId: 's', state: {}, pendingClaim: claim, gateResult: { exitCode: 0 }, key: 'k1' });
    assert.equal(outcome.steer, false);
    assert.equal(outcome.clearClaim, true);
    assert.equal(outcome.confirmed, true);
  });

  it('does nothing at all without a claim', () => {
    const outcome = decideStop({ sessionId: 's', state: {}, pendingClaim: null, key: 'k1' });
    assert.equal(outcome.steer, false);
  });
});

describe('the claim record carries what the anti-loop key needs', () => {
  it('round-trips the identity fields', () => {
    const env = { JEV_DSH_STATE: join(scratch, 'state-identity') };
    writeClaim({ sessionId: 's1', claim: 'done', request: null, taskId: 't1', promptId: 'p1', snapshotDigest: 'snap', collect: ['a.txt'], env });
    const record = readClaim({ sessionId: 's1', env });
    assert.equal(record.claim, 'done');
    assert.equal(record.taskId, 't1');
    assert.equal(record.promptId, 'p1');
    assert.equal(record.snapshotDigest, 'snap');
    assert.deepEqual(record.collect, ['a.txt']);
    clearClaim({ sessionId: 's1', env });
    assert.equal(readClaim({ sessionId: 's1', env }), null);
  });

  it('keeps sessions apart', () => {
    const env = { JEV_DSH_STATE: join(scratch, 'state-isolation') };
    writeClaim({ sessionId: 'a', claim: 'claim-a', env });
    writeClaim({ sessionId: 'b', claim: 'claim-b', env });
    assert.equal(readClaim({ sessionId: 'a', env }).claim, 'claim-a');
    assert.equal(readClaim({ sessionId: 'b', env }).claim, 'claim-b');
    clearClaim({ sessionId: 'a', env });
    assert.equal(readClaim({ sessionId: 'a', env }), null);
    assert.equal(readClaim({ sessionId: 'b', env }).claim, 'claim-b');
  });
});

describe('the gate is given the artifacts the claim names', () => {
  it('passes --collect for every path and reports the exit code it saw', () => {
    const script = join(scratch, 'fake-gate.mjs');
    const argvOut = join(scratch, 'argv.json');
    writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argvOut)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(1);\n`, 'utf8');
    const request = join(scratch, 'req.json');
    writeFileSync(request, '{}', 'utf8');

    const result = runGateForClaim({ request, gateScript: script, collect: ['one.txt', 'two.txt'], env: { JEV_DSH_GATE_ARGS: '--offline --no-journal' } });

    assert.equal(result.exitCode, 1);
    assert.equal(result.status, 'not_done');
    const argv = JSON.parse(readFileSync(argvOut, 'utf8'));
    assert.deepEqual(argv, ['--request', request, '--collect', 'one.txt', '--collect', 'two.txt', '--offline', '--no-journal']);
  });

  it('never throws when the gate script is missing', () => {
    const request = join(scratch, 'req2.json');
    writeFileSync(request, '{}', 'utf8');
    const result = runGateForClaim({ request, gateScript: join(scratch, 'nope.mjs') });
    assert.equal(result.exitCode, 3);
    assert.match(result.reason, /not found/);
  });
});

// --- the adapter itself, driven through a context that records what it does ---

/** A context small enough to reason about, and honest about what it fakes. */
function fakeContext({ approval = undefined, logger = { info() {}, warn() {} } } = {}) {
  const listeners = new Map();
  const guards = [];
  return {
    tools: {
      guard(fn) {
        guards.push(fn);
        return () => guards.splice(guards.indexOf(fn), 1);
      },
    },
    logger,
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    get(name) {
      if (name === 'approval') return approval;
      return undefined;
    },
    effect() {},
    /** Run the pre-execute waterfall the way the registry does. */
    async preExecute(exec) {
      const handler = listeners.get('tools/pre-execute');
      assert.ok(handler, 'the adapter must register a pre-execute listener');
      let passed = false;
      const decision = await handler(exec, async () => {
        passed = true;
        return { kind: 'allow' };
      });
      return { decision, passed };
    },
    /** The guard layer runs after the waterfall, synchronously. */
    guardDecision(exec) {
      for (const guard of guards) {
        const reason = guard(exec);
        if (typeof reason === 'string') return reason;
      }
      return undefined;
    },
    listeners,
    guards,
  };
}

const markerExec = { name: 'jev_marker', arguments: { path: 'x' }, callId: 'c1' };
const benignExec = { name: 'jev_benign', arguments: { path: 'x' }, callId: 'c2' };

function mount(config) {
  const ctx = fakeContext({ approval: config.approval });
  applyAdapter(ctx, { rules: TOOL_RULE, logPath: null, ...config });
  return ctx;
}

describe('the native adapter decides on the real extension points', () => {
  it('off registers nothing at all', () => {
    const ctx = mount({ mode: 'off' });
    assert.equal(ctx.listeners.size, 0);
    assert.equal(ctx.guards.length, 0);
  });

  it('shadow passes the call through and registers no guard', async () => {
    const ctx = mount({ mode: 'shadow', policy: 'ask' });
    const { decision, passed } = await ctx.preExecute(markerExec);
    assert.equal(passed, true);
    assert.deepEqual(decision, { kind: 'allow' });
    assert.equal(ctx.guards.length, 0, 'shadow must not enforce');
  });

  it('enforce denies a tool that requires authorisation', async () => {
    const ctx = mount({ mode: 'enforce', policy: 'ask' });
    const { decision, passed } = await ctx.preExecute(markerExec);
    assert.equal(passed, false);
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /authorization_unavailable/);
  });

  it('enforce lets an ordinary tool through', async () => {
    const ctx = mount({ mode: 'enforce', policy: 'ask' });
    const { decision, passed } = await ctx.preExecute(benignExec);
    assert.equal(passed, true);
    assert.deepEqual(decision, { kind: 'allow' });
  });

  it('policy never denies with authorization_unavailable named in the reason', async () => {
    const ctx = mount({ mode: 'enforce', policy: 'never' });
    const { decision } = await ctx.preExecute(markerExec);
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /authorization_unavailable/);
  });

  it('a mandatory check that fails denies, and names the failure', async () => {
    const ctx = mount({ mode: 'enforce', policy: 'ask', failDecision: true });
    const { decision, passed } = await ctx.preExecute(markerExec);
    assert.equal(passed, false);
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /authorisation check failed/);
  });

  it('a mandatory check that fails does not block an ordinary tool', async () => {
    const ctx = mount({ mode: 'enforce', policy: 'ask', failDecision: true });
    const { decision, passed } = await ctx.preExecute(benignExec);
    assert.equal(passed, true, 'a blanket block is not fail-closed, it is a different bug');
    assert.deepEqual(decision, { kind: 'allow' });
  });

  it('the guard is the monotonic layer and denies what the waterfall allowed', () => {
    const ctx = mount({ mode: 'enforce', policy: 'ask' });
    const reason = ctx.guardDecision(markerExec);
    assert.equal(typeof reason, 'string');
    assert.match(reason, /authoris|authoriz/);
  });

  it('the guard has no opinion about an ordinary tool', () => {
    const ctx = mount({ mode: 'enforce', policy: 'ask' });
    assert.equal(ctx.guardDecision(benignExec), undefined);
  });

  it('shadow registers no guard, so it cannot deny anything', () => {
    const ctx = mount({ mode: 'shadow', policy: 'ask' });
    assert.equal(ctx.guardDecision(markerExec), undefined);
  });
});
