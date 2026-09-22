/**
 * Native DSH adapter for jev-gates.
 *
 * Why this exists instead of the shipped Claude Code hook bridge
 * ------------------------------------------------------------
 * The bridge (`@deepseek-ai/dsh-hooks-claude-code`) declares
 * `inject = ["shell", "sessionProjections"]` and executes every hook through
 * `shell.resolve()` / `shell.run()`. On the composed profiles of this build the
 * mounted `shell` is `SandboxPwshExecutor` (or `SandboxBashExecutor`), whose
 * `resolve()` reads `this.ctx.sandboxPolicy` — and `this.ctx` resolves to the
 * CALLING context, not the service's own. A caller that does not inject
 * `sandboxPolicy` therefore makes `resolve()` throw, the protocol turns the
 * throw into an outcome with no decision, the merge yields `allow`, and the tool
 * runs. Measured three ways in `docs/_dsh-runtime-findings.md` §13:
 *
 *   shell.run(shell.resolve("node --version"))  -> exitCode 1, stdout "", stderr ""
 *   shell.run(shell.resolve(<write a file>))    -> THROWS "cannot get required
 *                                                  service \"sandboxPolicy\" in
 *                                                  inactive context"
 *   runHook(shell, {command})                   -> stderr carries the same text
 *
 * So the shipped bridge cannot launch a hook here, and it says nothing when it
 * fails. This adapter is the supported alternative: it is a plain Cordis plugin
 * that uses the harness's own documented extension points and needs no `shell`
 * service at all, so the broken executor cannot affect it.
 *
 * What it registers
 * -----------------
 *   tools.guard()            monotonic denial; cannot be force-allowed downstream
 *   tools/pre-execute        waterfall; the only place `ask` can be raised
 *   tools/post-execute       observation of what actually ran
 *   agent/turn-stopping      completion check for an outstanding claim
 *
 * Failure policy
 * --------------
 * The classification runs FIRST and is pure, so it cannot fail. Everything after
 * it can. When it can, the outcome depends on whether the call needs
 * authorisation:
 *
 *   needs authorisation  -> the check was mandatory, so a failure DENIES
 *   ordinary action      -> the check had no opinion to give, so a failure PASSES
 *
 * That is the difference between fail-closed and a blanket block, and it is
 * tested in both directions by `adapters/dsh/scenarios.mjs`.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decidePreTool, decideStop, postToolObservation, runGateForClaim, stateDir } from './bridge.mjs';
import { classifyCommand } from './classify.mjs';
import { clearClaim, readClaim } from './claim.mjs';

export const name = 'jev-gates-dsh';

/** `tools` owns both waterfalls and the guard surface; everything else is optional. */
export const inject = ['tools'];

export const ADAPTER_MODES = ['off', 'shadow', 'enforce'];

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RULES = join(HERE, 'rules.default.json');

function sessionIdOf(exec, fallback = 'unknown') {
  const id = exec?.agent?.session?.id ?? exec?.agent?.id ?? exec?.session?.id;
  return typeof id === 'string' && id.length > 0 ? id : fallback;
}

/** Turn number for a turn-tied record, or null when the projection is absent. */
function turnOf(ctx, agent) {
  try {
    const value = ctx.get('sessionProjections')?.stateOf(agent?.session, 'turnBoundary')?.lastTurn;
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function loadRules(path) {
  if (!path) return null;
  try {
    return normaliseRules(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Accept both spellings of a rule. A rule written in a YAML/JSON row arrives with
 * string patterns; one written in JS arrives with real RegExps. Normalising here
 * means a rule cannot silently stop matching because of where it was declared.
 */
function normaliseRules(list) {
  if (!Array.isArray(list)) return null;
  return list.map((rule) => ({
    ...rule,
    test: typeof rule.test === 'string' ? new RegExp(rule.test, 'i') : rule.test,
    tool: typeof rule.tool === 'string' ? new RegExp(rule.tool, 'i') : rule.tool,
  }));
}

export function apply(ctx, config = {}) {
  const env = process.env;
  const settings = {
    mode: config.mode ?? env.JEV_DSH_MODE ?? 'shadow',
    policy: config.policy ?? env.JEV_DSH_POLICY ?? 'unknown',
    maxSteers: Number.isInteger(config.maxSteers) ? config.maxSteers : 2,
    gateTimeoutMs: Number.isInteger(config.gateTimeoutMs) ? config.gateTimeoutMs : 20_000,
    rules: normaliseRules(config.rules) ?? loadRules(config.rulesPath ?? DEFAULT_RULES),
    logPath: config.logPath ?? null,
    // Fault injection exists for the acceptance harness and for nothing else.
    // A real profile must never set it: it makes the decision step fail on
    // purpose so the failure policy can be observed.
    failDecision: config.failDecision === true,
    failStop: config.failStop === true,
  };

  if (!ADAPTER_MODES.includes(settings.mode)) {
    ctx.logger?.warn?.(`jev-gates: unknown mode "${settings.mode}"; staying out of the way`);
    return;
  }
  if (settings.mode === 'off') {
    ctx.logger?.info?.('jev-gates: mode=off, no listeners registered');
    return;
  }

  const log = (record) => {
    if (!settings.logPath) return;
    try {
      mkdirSync(dirname(settings.logPath), { recursive: true });
      appendFileSync(settings.logPath, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8');
    } catch {
      /* a log that cannot be written must never change a decision */
    }
  };

  const statePath = (sessionId) => join(stateDir(env), `${String(sessionId).replace(/[^a-zA-Z0-9._-]+/g, '_')}.adapter-state.json`);
  const readState = (sessionId) => {
    try {
      return JSON.parse(readFileSync(statePath(sessionId), 'utf8'));
    } catch {
      return {};
    }
  };
  const writeState = (sessionId, state) => {
    try {
      mkdirSync(stateDir(env), { recursive: true });
      writeFileSync(statePath(sessionId), JSON.stringify(state, null, 2), 'utf8');
    } catch {
      /* as above */
    }
  };

  // The one pure step. It runs before anything fallible, and its answer decides
  // whether a later failure is allowed to pass.
  const classify = (exec) => {
    const toolInput = exec?.arguments ?? {};
    const command = typeof toolInput.command === 'string' ? toolInput.command : typeof toolInput.cmd === 'string' ? toolInput.cmd : '';
    return classifyCommand(command, { toolName: exec?.name, rules: settings.rules });
  };

  const decide = (exec, classification) => {
    if (settings.failDecision) throw new Error('injected decision failure (acceptance only)');
    return decidePreTool({
      toolName: exec?.name,
      toolInput: exec?.arguments ?? {},
      mode: settings.mode,
      policy: settings.policy,
      rules: settings.rules,
    });
  };

  const denyReason = (outcome) =>
    outcome?.reason ?? 'jev-gates: this action requires authorisation and none could be obtained';

  /**
   * The monotonic layer. A guard cannot be force-allowed by any later listener,
   * which is what makes `enforce` mean something rather than "usually".
   */
  if (settings.mode === 'enforce') {
    ctx.tools.guard((execution) => {
      let classification;
      try {
        classification = classify(execution);
      } catch {
        return undefined;
      }
      if (!classification.irreversible) return undefined;
      try {
        const outcome = decide(execution, classification);
        if (outcome.decision === 'deny') {
          log({ kind: 'guard.deny', sessionId: sessionIdOf(execution), tool: execution.name, action: classification.action, reason: outcome.reason });
          return denyReason(outcome);
        }
        if (outcome.decision === 'ask') {
          log({ kind: 'guard.ask', sessionId: sessionIdOf(execution), tool: execution.name, action: classification.action });
          return `jev-gates: "${classification.action}" requires authorisation (${classification.flags.join(', ')})`;
        }
        return undefined;
      } catch (error) {
        // The classification said this needs authorisation, so the failed check
        // was mandatory: deny, with the real reason attached.
        const reason = `jev-gates: the authorisation check failed (${error.message}) for an action that requires it, so the action was not allowed through unchecked`;
        log({ kind: 'guard.failure', sessionId: sessionIdOf(execution), tool: execution.name, action: classification.action, error: error.message, verdict: 'deny' });
        return reason;
      }
    });
  }

  /**
   * The waterfall layer. Its job is the decision that a guard cannot express —
   * `ask` — plus the shadow record, plus the pass-through for everything else.
   */
  ctx.on('tools/pre-execute', async (exec, next) => {
    let classification;
    try {
      classification = classify(exec);
    } catch (error) {
      log({ kind: 'pre.classify-failure', tool: exec?.name, error: String(error?.message ?? error) });
      return next();
    }
    if (!classification.irreversible) return next();

    const sessionId = sessionIdOf(exec);
    let outcome;
    try {
      outcome = decide(exec, classification);
    } catch (error) {
      if (settings.mode === 'enforce') {
        const reason = `jev-gates: the authorisation check failed (${error.message}) for an action that requires it, so the action was not allowed through unchecked`;
        log({ kind: 'pre.failure', sessionId, tool: exec.name, action: classification.action, error: error.message, verdict: 'deny' });
        return { kind: 'deny', reason };
      }
      log({ kind: 'pre.failure', sessionId, tool: exec.name, action: classification.action, error: error.message, verdict: 'pass (shadow)' });
      return next();
    }

    log({ kind: 'pre.decision', sessionId, tool: exec.name, action: classification.action, flags: classification.flags, decision: outcome.decision, mode: settings.mode, authorization: outcome.authorization ?? null });

    if (settings.mode !== 'enforce') return next();
    if (outcome.decision === 'deny') return { kind: 'deny', reason: denyReason(outcome) };
    if (outcome.decision === 'ask') {
      // `ask` is only meaningful when somebody can actually be asked. Three ways
      // that fails, and all three must deny rather than quietly pass:
      //   - `policy: never` makes the harness convert the ask into an automatic
      //     deny and blame the user;
      //   - no approval service is mounted, so there is nobody to answer;
      //   - the call carries no agent, so the harness cannot route the question
      //     anywhere — measured as `tool "…" requires approval, but the call has
      //     no agent to route it through`.
      // The honest outcome in every case is a denial by this gate that names the
      // real reason — the decision R5 settled for the hook bridge, reached here
      // through a real API.
      const approvalAvailable = ctx.get('approval') !== undefined;
      const routable = exec.agent !== undefined;
      if (settings.policy === 'never' || !approvalAvailable || !routable) {
        const why =
          settings.policy === 'never'
            ? 'the approval policy is "never"'
            : !approvalAvailable
              ? 'no approval service is mounted in this session'
              : 'this call carries no agent to route the question through';
        return {
          kind: 'deny',
          reason:
            `jev-gates: authorization_unavailable — "${classification.action}" needs authorisation and ${why}, ` +
            'so no human can grant it here. This gate will not let the action through unauthorised. Re-run with a ' +
            'policy that permits approval, or perform the action outside the session.',
        };
      }
      return { kind: 'ask', reason: outcome.reason ?? undefined };
    }
    return next();
  });

  /** Observe what actually ran. Never a decision: the effect already happened. */
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next();
    try {
      const observation = postToolObservation(
        { tool_name: exec?.name, tool_input: exec?.arguments, tool_response: result?.isError === true ? result?.error?.message : result?.value },
        { sequence: 0 },
      );
      const sessionId = sessionIdOf(exec);
      log({ kind: 'post.observed', sessionId, tool: exec?.name, isError: result?.isError === true, observation });
      const agent = exec?.agent;
      const turn = turnOf(ctx, agent);
      if (agent?.session?.append && turn !== null) {
        agent.session.append('jev/observed', { turn, tool: exec?.name, isError: result?.isError === true });
      }
    } catch (error) {
      log({ kind: 'post.failure', tool: exec?.name, error: String(error?.message ?? error) });
    }
    return downstream;
  });

  /**
   * The completion check at the end of a turn.
   *
   * `agent/turn-stopping` is SERIAL and its return value is DISCARDED, so this
   * cannot veto a stop. The only lever is `agent.steer`, which enqueues another
   * step inside the same turn. Every bound lives here because of that.
   */
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    try {
      if (signal?.aborted === true) {
        log({ kind: 'stop.cancelled', turn });
        return;
      }
      const sessionId = sessionIdOf({ agent });
      const claim = readClaim({ sessionId, env });
      if (!claim) {
        log({ kind: 'stop.no-claim', sessionId, turn });
        return;
      }
      const state = readState(sessionId);

      let gateResult = null;
      if (claim.request) {
        if (settings.failStop) throw new Error('injected stop failure (acceptance only)');
        gateResult = runGateForClaim({ request: claim.request, env, timeoutMs: settings.gateTimeoutMs, collect: claim.collect ?? [] });
      }

      const reasonCodes = gateResult ? [`exit_${gateResult.exitCode}`] : ['no_gate_request'];
      const key = [claim.taskId ?? 'task?', claim.promptId ?? `turn${turn}`, claim.snapshotDigest ?? 'snap?', ...reasonCodes].join('|');

      const outcome = decideStop({ sessionId, state, maxSteers: settings.maxSteers, pendingClaim: claim, gateResult, key });
      log({ kind: 'stop.decision', sessionId, turn, key, ...outcome, output: undefined });

      if (outcome.clearClaim) clearClaim({ sessionId, env });
      if (!outcome.steer) return;

      writeState(sessionId, { ...state, steers: outcome.steers, lastKey: key, lastAt: new Date().toISOString() });
      agent.steer({ content: [{ type: 'text', text: outcome.output.reason }] });
    } catch (error) {
      // A failure here must not become an endless turn, and it must not be
      // reported as a confirmation either. Stay quiet and record it.
      log({ kind: 'stop.failure', error: String(error?.message ?? error) });
    }
  });

  ctx.logger?.info?.(`jev-gates: native adapter mounted (mode=${settings.mode}, policy=${settings.policy})`);
}
