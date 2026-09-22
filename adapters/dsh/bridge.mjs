#!/usr/bin/env node
/**
 * DeepSeek Harness adapter — hook command (REQ-07, REQ-09).
 *
 * This file is the *bridge* dialect: it is invoked as a subprocess with a hook
 * payload on stdin and writes one JSON object to stdout. It exists because it
 * works on harnesses that already speak that protocol, and because it needs no
 * host privileges.
 *
 * READ THIS BEFORE TRUSTING IT — every claim below was verified against the
 * installed build (0.1.5-rc.2) and the citations are in docs/DSH.md:
 *
 *   1. `PreToolUse` can deny and can ask. A top-level `{"decision":"deny"}` is
 *      silently ignored by this build; the decision must travel inside
 *      `hookSpecificOutput.permissionDecision`, and `hookEventName` must match
 *      the firing point or the whole block is discarded.
 *   2. Under `approval policy = never` an `ask` becomes an AUTOMATIC DENY with
 *      the misleading reason "the user rejected tool ...". This adapter therefore
 *      never asks under that policy: it reports `authorization_unavailable` and
 *      leaves the decision to the harness. It does not auto-allow either —
 *      silence is not a grant.
 *   3. `PostToolUse` runs after the side effect and cannot undo it. The payload
 *      carries no structured exit code: the rendered `[exit code: N]` is text.
 *      Observations from here are recorded with `coverage: "partial"` and can
 *      therefore never produce a confirmed `done` on their own.
 *   4. `Stop` is NOT a veto. It steers one extra step, and the loop may skip the
 *      dispatch entirely. Steering is bounded here, and the bound is recorded.
 *   5. This adapter is NARROW ON PURPOSE. It speaks only about actions it
 *      recognises as irreversible. A gate that questions every tool call is
 *      unmounted within a day, and then it protects nothing.
 *
 * Configuration (environment):
 *   JEV_DSH_MODE        shadow (default) | enforce
 *   JEV_DSH_POLICY      never | ask | unknown (default: unknown)
 *   JEV_DSH_STATE       state directory (default: $JEV_GATES_HOME/dsh-state)
 *   JEV_DSH_MAX_STEERS  bounded Stop steering per session (default: 2)
 *
 * Exit code is always 0: the decision travels in JSON. Exit 2 would discard
 * stdout and hand the model a raw stderr string.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCommand, irreversibleFlags } from './classify.mjs';
import { ENFORCEMENT } from '../../lib/policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const ADAPTER_VERSION = '2.0.0';
export const DEFAULT_MAX_STEERS = 2;

/** Where per-session adapter state lives. */
export function stateDir(env = process.env) {
  const custom = env.JEV_DSH_STATE ?? (env.JEV_GATES_HOME ? join(env.JEV_GATES_HOME, 'dsh-state') : join(HERE, '..', '..', '.dsh-state'));
  if (!existsSync(custom)) mkdirSync(custom, { recursive: true });
  return custom;
}

function readState(sessionId, env) {
  const path = join(stateDir(env), `${sanitizeId(sessionId)}.json`);
  if (!existsSync(path)) return { path, state: { sessionId, steers: 0, decisions: [], observations: 0 } };
  try {
    return { path, state: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    // A corrupt state file must not become a crash inside a hook. Start clean
    // and say so in the state itself.
    return { path, state: { sessionId, steers: 0, decisions: [], observations: 0, recovered: true } };
  }
}

function writeState(path, state) {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function sanitizeId(id) {
  return String(id ?? 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

/** Append one observation for the session so the completion gate can consume it. */
export function appendObservation(sessionId, observation, env = process.env) {
  const path = join(stateDir(env), `${sanitizeId(sessionId)}.observations.jsonl`);
  appendFileSync(path, `${JSON.stringify(observation)}\n`, 'utf8');
  return path;
}

export function observationsPath(sessionId, env = process.env) {
  return join(stateDir(env), `${sanitizeId(sessionId)}.observations.jsonl`);
}

/**
 * A `[exit code: N]` marker in harness-rendered text.
 *
 * This is textual inference and is labelled as such: the observation it produces
 * is `partial` coverage, so it can never confirm a criterion by itself. The
 * alternative — pretending the bridge sees a structured exit code — would be a
 * lie that ends in a false `done`.
 */
export function inferExitCodeFromText(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/\[exit code:\s*(-?\d+)\]/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : null;
}

/**
 * Decide what to do with a PreToolUse event. Pure: no IO.
 *
 * Returns `{ decision: 'ask'|'deny'|null, reason, action, flags, mode }`.
 */
export function decidePreTool({ toolName, toolInput, mode = 'shadow', policy = 'unknown', rules = null }) {
  const command = typeof toolInput?.command === 'string' ? toolInput.command : typeof toolInput?.cmd === 'string' ? toolInput.cmd : '';
  const classification = classifyCommand(command, { toolName, rules });
  if (!classification.irreversible) {
    // Nothing to say. Silence preserves any other guard's deny, and it keeps the
    // adapter from becoming noise.
    return { decision: null, reason: null, action: classification.action, flags: classification.flags, mode, skipped: 'not_irreversible' };
  }
  if (mode !== 'enforce') {
    return {
      decision: null,
      reason: null,
      action: classification.action,
      flags: classification.flags,
      mode,
      shadowDecision: 'ask',
      note: 'shadow mode: the decision was computed and recorded but not enforced',
    };
  }
  if (policy === 'never') {
    // Under `never`, asking is silently converted into an automatic deny by the
    // harness, with a reason that blames the user. That was the reason this branch
    // used to emit no decision at all — but emitting nothing is not neutral: the
    // PreToolUse listener calls next() when no deny or ask is present, so the
    // action proceeded UNAUTHORISED, which is the opposite of enforcing.
    //
    // In enforce mode the honest outcome is a denial by this gate, with the real
    // reason attached. Shadow mode stays observational, because its whole purpose
    // is to measure without acting.
    return {
      decision: 'deny',
      reason:
        `jev-gates: authorization_unavailable — "${classification.action}" looks irreversible (${classification.flags.join(', ')}) and the approval ` +
        'policy is "never", so no human can authorise it in this session. This gate cannot obtain authorisation and ' +
        'will not let the action through unauthorised. Re-run with a policy that permits approval, or perform the ' +
        'action outside the session.',
      action: classification.action,
      flags: classification.flags,
      mode,
      authorization: 'authorization_unavailable',
      note: 'approval policy is "never": an ask would become an automatic deny, so this gate denies explicitly instead',
    };
  }
  return {
    decision: 'ask',
    reason: `jev-gates: "${classification.action}" looks irreversible (${classification.flags.join(', ')}); a human should decide`,
    action: classification.action,
    flags: classification.flags,
    mode,
  };
}

/**
 * Build the hook stdout object for a PreToolUse outcome.
 *
 * Only fields this build actually honours are emitted. `systemMessage` is
 * deliberately absent: the bridge logs a warning and drops it
 * (`dsh-hooks-claude-code/lib/index.js:193`), so sending one would produce noise
 * in the harness log and nothing else. Shadow mode therefore writes nothing at
 * all — its record lives in the state file, where a human can read it.
 */
export function preToolOutput(outcome) {
  const out = {};
  if (outcome.decision) {
    out.hookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision: outcome.decision,
      permissionDecisionReason: outcome.reason,
      // The reason travels with the decision; the context makes it visible even
      // when the decision itself is only logged.
      ...(outcome.authorization ? { additionalContext: `jev-gates: ${outcome.authorization} — ${outcome.note}` } : {}),
    };
  }
  return out;
}

/**
 * The Stop handler.
 *
 * Bounded steering. `stop_hook_active` is a constant false in this build, so the
 * bound is kept here instead: after `maxSteers` the adapter goes quiet and records
 * that the run ended without a confirmation. Silence is the honest outcome — the
 * gate cannot veto, and pretending otherwise would be the exact false confidence
 * this project exists to remove.
 */
export function decideStop({ sessionId, state, maxSteers = DEFAULT_MAX_STEERS, pendingClaim = null, gateResult = null, key = null }) {
  if (!pendingClaim) {
    return { output: {}, steer: false, reason: 'no unfinished claim was recorded for this session', steers: state.steers ?? 0 };
  }
  const steers = state.steers ?? 0;
  const claimText = typeof pendingClaim === 'string' ? pendingClaim : pendingClaim.claim ?? '(unnamed claim)';

  // A claim the gate has already confirmed is finished. Clearing it here is what
  // stops the next turn from being steered about work that is done — and what
  // makes the budget mean "unresolved turns" rather than "turns so far".
  if (gateResult && gateResult.exitCode === 0) {
    return {
      output: {},
      steer: false,
      confirmed: true,
      clearClaim: true,
      reason: `the gate confirmed "${claimText}" (exit 0); nothing more is required`,
      steers,
      gate: gateResult,
    };
  }
  if (steers >= maxSteers) {
    return {
      output: {},
      steer: false,
      exhausted: true,
      reason: `steering budget exhausted (${steers}/${maxSteers}); the run ends as incomplete, not as confirmed`,
      steers,
      gate: gateResult,
    };
  }
  // Anti-loop. A repeat of the SAME unresolved condition — same task, same prompt,
  // same snapshot, same reason codes — is not new information, so steering again
  // would only spend a turn to arrive back here. The spec asks for exactly this
  // key, and the reason it matters is that a bare counter still allows
  // `maxSteers` identical turns, which is grinding with a budget attached.
  if (key !== null && state.lastKey === key) {
    return {
      output: {},
      steer: false,
      repeated: true,
      reason: 'the same unresolved condition was already reported and no new evidence has arrived; not steering again',
      steers,
      gate: gateResult,
      key,
    };
  }
  const why = gateResult
    ? `the gate returned exit ${gateResult.exitCode} (${gateResult.status ?? 'unknown'})`
    : 'the gate was not run for this claim';
  return {
    output: {
      decision: 'block',
      reason: `jev-gates: "${claimText}" is still unconfirmed — ${why}. Supply evidence, or say plainly that it is not done.`,
    },
    steer: true,
    steers: steers + 1,
    key,
    reason: gateResult ? `one more step was requested: ${why}` : 'one more step was requested',
    gate: gateResult,
  };
}

/**
 * Run the completion gate for a claim, out of process, without ever throwing.
 *
 * The Stop hook runs inside a turn that must not hang, so this is bounded by a
 * timeout and every failure becomes a status rather than an exception. A gate
 * that cannot answer yields exit 3, and the caller steers — never a silent pass.
 */
export function runGateForClaim({ request, env = process.env, timeoutMs = 20_000, gateScript = null, collect = [] } = {}) {
  if (!request) return null;
  const script = gateScript ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'jev-gate.mjs');
  if (!existsSync(script)) return { exitCode: 3, status: 'unverified', reason: 'the gate script was not found' };
  if (!existsSync(request)) return { exitCode: 3, status: 'unverified', reason: `the request file does not exist: ${request}` };
  const extra = (env.JEV_DSH_GATE_ARGS ?? '--offline --no-journal').split(/\s+/).filter(Boolean);
  // A claim about an artifact has to be able to say WHICH artifact to read. The
  // gate will not guess, and without this every artifact criterion came back
  // `no_observation` — unverified, which steers forever without ever confirming.
  const collected = (Array.isArray(collect) ? collect : []).filter((p) => typeof p === 'string' && p.length > 0).flatMap((p) => ['--collect', p]);
  try {
    execFileSync(process.execPath, [script, '--request', request, ...collected, ...extra], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env,
    });
    return { exitCode: 0, status: 'done', reason: 'the gate confirmed the claim' };
  } catch (error) {
    const exitCode = typeof error.status === 'number' ? error.status : 3;
    return {
      exitCode,
      status: exitCode === 0 ? 'done' : exitCode === 1 ? 'not_done' : exitCode === 2 ? 'review' : 'unverified',
      reason: exitCode === 0 ? 'the gate confirmed the claim' : `the gate exited ${exitCode}`,
    };
  }
}

/** Build the PostToolUse observation. Never a decision: the effect already happened. */
export function postToolObservation(payload, { sequence = 0 } = {}) {
  const text = typeof payload?.tool_response === 'string' ? payload.tool_response : JSON.stringify(payload?.tool_response ?? '');
  const exit = inferExitCodeFromText(text);
  return {
    observationId: `dsh-${payload?.tool_use_id ?? sequence}`,
    kind: 'command',
    runId: payload?.session_id ?? null,
    taskId: payload?.session_id ?? null,
    collectorVersion: ADAPTER_VERSION,
    sequence,
    toolCallId: payload?.tool_use_id ?? null,
    executable: String(payload?.tool_name ?? 'unknown'),
    argv: [],
    cwd: payload?.cwd ?? null,
    status: exit === null ? 'unknown' : 'completed',
    exit,
    capturedAt: new Date().toISOString(),
    sourceEventId: payload?.tool_use_id ?? null,
    coverage: 'partial',
    sourceTrust: 'harness_observed',
    unstable: false,
    scope: [],
    exitSource: exit === null ? null : 'text_inference',
    note: 'PostToolUse carries no structured exit code in this build; the value is inferred from rendered text',
  };
}

// --- CLI ---------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const raw = await new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });

  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i > -1 ? argv[i + 1] ?? true : undefined;
  };
  const mode = String(flag('mode') ?? process.env.JEV_DSH_MODE ?? 'shadow');
  const policy = String(flag('policy') ?? process.env.JEV_DSH_POLICY ?? 'unknown');
  const maxSteers = Number(flag('max-steers') ?? process.env.JEV_DSH_MAX_STEERS ?? DEFAULT_MAX_STEERS);

  let payload = null;
  if (raw.trim() !== '') {
    try {
      payload = JSON.parse(raw);
    } catch {
      // A hook that cannot read its input must not invent one. Say so on stderr
      // (stdout must stay clean so the protocol parser sees no JSON at all).
      process.stderr.write('jev-gates dsh adapter: could not parse the hook payload\n');
      process.exitCode = 0;
    }
  }

  if (payload) {
    const event = payload.hook_event_name ?? 'unknown';
    const sessionId = payload.session_id ?? 'unknown';

    if (event === 'PreToolUse') {
      const outcome = decidePreTool({ toolName: payload.tool_name, toolInput: payload.tool_input, mode, policy });
      const { path, state } = readState(sessionId, process.env);
      state.decisions.push({ at: new Date().toISOString(), tool: payload.tool_name ?? null, action: outcome.action, flags: outcome.flags, mode, decision: outcome.decision, shadowDecision: outcome.shadowDecision ?? null, authorization: outcome.authorization ?? null });
      state.decisions = state.decisions.slice(-100);
      writeState(path, state);
      const out = preToolOutput(outcome);
      if (Object.keys(out).length) process.stdout.write(JSON.stringify(out));
    } else if (event === 'PostToolUse') {
      const { path, state } = readState(sessionId, process.env);
      state.observations = (state.observations ?? 0) + 1;
      writeState(path, state);
      const observation = postToolObservation(payload, { sequence: state.observations });
      appendObservation(sessionId, observation, process.env);
      // No decision: the side effect has already happened and cannot be undone.
    } else if (event === 'Stop' || event === 'SubagentStop') {
      const { path, state } = readState(sessionId, process.env);
      const claimPath = join(stateDir(process.env), `${sanitizeId(sessionId)}.pending-claim`);
      let pendingClaim = null;
      if (existsSync(claimPath)) {
        const rawClaim = readFileSync(claimPath, 'utf8').trim();
        try {
          pendingClaim = JSON.parse(rawClaim);
        } catch {
          // Written by hand as plain text: still a claim.
          pendingClaim = rawClaim ? { claim: rawClaim, request: null } : null;
        }
      }
      // The gate is what makes Stop mean something. Without it the handler could
      // only observe that a claim was written, never whether it was true.
      const gateResult = runGateForClaim({ request: pendingClaim?.request ?? null });
      const result = decideStop({ sessionId, state, maxSteers, pendingClaim, gateResult });
      state.steers = result.steers;
      state.lastStop = {
        at: new Date().toISOString(),
        steered: result.steer,
        exhausted: result.exhausted === true,
        confirmed: result.confirmed === true,
        gate: gateResult ? { exitCode: gateResult.exitCode, status: gateResult.status } : null,
        reason: result.reason,
      };
      if (result.exhausted) state.incomplete = true;
      if (result.clearClaim) rmSync(claimPath, { force: true });
      writeState(path, state);
      if (Object.keys(result.output).length) process.stdout.write(JSON.stringify(result.output));
      if (result.exhausted) process.stderr.write(`jev-gates: ${result.reason}\n`);
    } else {
      process.stderr.write(`jev-gates dsh adapter: event "${event}" is not handled\n`);
    }
  }

  process.exitCode = 0;
}
