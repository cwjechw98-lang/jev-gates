/**
 * Register the JEV capabilities as real DSH tools.
 *
 * The task is explicit that a SKILL.md and a passing unit test are not delivery:
 * the tools have to appear in the harness's own tool catalog, or the agent cannot
 * call them. This plugin is what puts them there.
 *
 * It registers six tools on `ctx.tools.register`:
 *
 * | tool | capability | what it answers |
 * |---|---|---|
 * | `jev_verify_completion` | C1 | is this task actually finished? |
 * | `jev_route_skill` | C2 | which skill fits this task? |
 * | `jev_check_progress` | C3 | is this run repeating itself without progress? |
 * | `jev_review_scope` | C4 | does this change meet a narrow rubric? |
 * | `jev_context_plan` | C5 | what can be dropped from this history, safely? |
 * | `jev_diagnose` | — | why did the last gate answer that, and what should change? |
 *
 * Two design choices worth stating, because both are load-bearing:
 *
 * 1. **The tool observes real executions; it never re-runs a command.** The
 *    `tools/post-execute` listener records what the harness actually did. The
 *    spec forbids executing command strings that arrive in a request (INV-06),
 *    and a gate that re-ran them would be a new attack surface rather than a
 *    check.
 *
 * 2. **Every tool is advisory.** `actionAuthority` is always `none`. The approval
 *    gate is a different component; nothing here widens what the agent may do,
 *    and nothing here can force-allow a call another guard denied.
 *
 * The plugin declares `inject: ['tools']` only. It deliberately does not touch
 * `shell`: on this build the mounted sandboxed executor cannot be driven by a
 * caller that does not inject `sandboxPolicy`, and this code has no reason to
 * depend on it.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAPABILITY_REASON,
  CAPABILITY_STATUS,
  capabilityEnvelope,
  modelLane,
  resolveMode,
  snapshotIdentity,
} from '../../lib/capability.mjs';
import { readCatalog, shortlist } from '../../lib/skills.mjs';
import { defineTool } from '../../lib/toolspec.mjs';
import { CAPABILITY as VERIFY_CAPABILITY, eventFromToolResult, verifyCompletion } from '../../lib/verify.mjs';

/** Plugin name, as the loader reports it. */
export const name = 'jev-tools';

/** The only service this plugin needs. */
export const inject = ['tools'];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Tools this plugin owns. Their own calls are not evidence about the task. */
const OWN_TOOLS = new Set([
  'jev_verify_completion',
  'jev_route_skill',
  'jev_check_progress',
  'jev_review_scope',
  'jev_context_plan',
  'jev_diagnose',
]);

/** How many tool executions to keep per session. Bounded so a long run cannot grow without limit. */
const MAX_EVENTS = 500;

/**
 * Per-session state: the observed tool executions and the last advice given.
 *
 * Keyed by agent id so two concurrent sessions cannot read each other's
 * evidence — the failure mode that matters is a verdict computed from another
 * session's work, which would be both wrong and hard to notice.
 */
function createStore() {
  const events = new Map();
  const advice = new Map();
  return {
    record(sessionKey, event) {
      const list = events.get(sessionKey) ?? [];
      list.push(event);
      if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
      events.set(sessionKey, list);
    },
    eventsFor(sessionKey) {
      return [...(events.get(sessionKey) ?? [])];
    },
    lastAdvice(sessionKey) {
      return advice.get(sessionKey) ?? null;
    },
    setAdvice(sessionKey, value) {
      advice.set(sessionKey, value);
    },
    clear(sessionKey) {
      events.delete(sessionKey);
      advice.delete(sessionKey);
    },
  };
}

/** The session key for one execution. A call with no agent is its own bucket. */
function sessionKeyOf(exec) {
  const id = exec?.agent?.id ?? exec?.agent?.session?.id;
  return typeof id === 'string' && id.length > 0 ? id : 'anonymous';
}

/** Read the rules/config for this plugin row, tolerating an absent config. */
function readConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: config.mode ?? 'advisory',
    capabilities: config.capabilities ?? {},
    maxSteers: Number.isInteger(config.maxSteers) ? config.maxSteers : 2,
    timeoutMs: Number.isInteger(config.timeoutMs) ? config.timeoutMs : 20_000,
    projectRoot: typeof config.projectRoot === 'string' ? config.projectRoot : null,
    skillRoots: Array.isArray(config.skillRoots) ? config.skillRoots : null,
    logPath: typeof config.logPath === 'string' ? config.logPath : null,
    // The judge is injected, never constructed here: a plugin that reached for
    // credentials on its own would be doing something the session did not ask for.
    judge: typeof config.judge === 'function' ? config.judge : null,
    maxReviewChars: Number.isInteger(config.maxReviewChars) ? config.maxReviewChars : 60_000,
  };
}

/**
 * The permission a capability has to answer at all.
 * @param {object} config - from {@link readConfig}.
 * @param {string} capability - the logical tool name.
 * @returns {boolean} whether the tool should be registered.
 */
function isEnabled(config, capability) {
  return resolveMode(config, capability) !== 'off';
}

/**
 * Register the tools.
 * @param {object} ctx - the Cordis context, carrying the `tools` service.
 * @param {object} rawConfig - the row's `config`.
 */
export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig);
  const store = createStore();

  // Record what the harness actually did. This is the acquisition path that
  // earns `harness_observed`: the observation exists because the registry
  // dispatched the call, not because anything claimed it happened.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const toolName = exec?.name ?? 'unknown';
      if (!OWN_TOOLS.has(toolName)) {
        store.record(sessionKeyOf(exec), eventFromToolResult({ exec, result }));
      }
    } catch {
      // An observation that cannot be recorded must not break the call it was
      // watching. Losing evidence costs a verdict; throwing here would cost the
      // user their tool call.
    }
    return next();
  });

  const envelopeOutput = {
    // Envelopes are deliberately rich and evolve by adding fields, so the output
    // schema is open. It still declares `type: 'object'`, which is what makes the
    // registry materialize a structured value rather than a string.
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const lines = [`${value?.capability}: ${value?.status} (${value?.reason?.code})`];
      if (value?.reason?.message) lines.push(value.reason.message);
      if (value?.decision?.summary) lines.push(value.decision.summary);
      if (Array.isArray(value?.limits)) for (const limit of value.limits) lines.push(`limit: ${limit}`);
      return [{ type: 'text', text: lines.join('\n') }];
    },
  };

  const registered = [];

  // --- C1 -----------------------------------------------------------------
  if (isEnabled(config, VERIFY_CAPABILITY)) {
    registered.push(
      ctx.tools.register(
        defineTool({
          name: VERIFY_CAPABILITY,
          description:
            'Decide whether a task is actually finished, from evidence rather than from a claim. ' +
            'Reads files itself and uses the tool executions this session really performed. ' +
            'Returns done / not_done / review / unverified with the evidence behind each criterion. ' +
            'A missing observation is never a pass, and a failed check is never talked away.',
          parameters: {
            taskId: { type: 'string', required: true, description: 'The task this verdict belongs to.' },
            runId: { type: 'string', required: true, description: 'This attempt; a retry is a new runId.' },
            request: {
              type: 'object',
              required: true,
              additionalProperties: true,
              description: 'A v2 gate request: {criteria: [{id, text, kind, required, verificationScope, check}], claims}.',
            },
            artifacts: {
              type: 'array',
              items: { type: 'string' },
              description: 'Paths this tool should read itself. Reading them here earns collector trust; a path named only in the request does not.',
            },
            projectRoot: { type: 'string', description: 'Base for relative paths.' },
            allowModel: { type: 'boolean', description: 'May a semantic criterion consult a judge? Defaults to true.' },
          },
          output: envelopeOutput,
          async execute(args, exec) {
            return verifyCompletion({
              taskId: args.taskId,
              runId: args.runId,
              request: args.request,
              artifacts: args.artifacts ?? [],
              events: store.eventsFor(sessionKeyOf(exec)),
              projectRoot: args.projectRoot ?? config.projectRoot,
              allowModel: args.allowModel !== false,
              judge: config.judge,
              signal: exec?.signal,
              timeoutMs: config.timeoutMs,
            });
          },
          presentCall: (args) => ({ card: 'generic', title: `Verify completion: ${args.taskId}`, kind: 'other', rawInput: { taskId: args.taskId, runId: args.runId } }),
        }),
      ),
    );
  }

  // --- C2 -----------------------------------------------------------------
  if (isEnabled(config, 'jev_route_skill')) {
    registered.push(
      ctx.tools.register(
        defineTool({
          name: 'jev_route_skill',
          description:
            'Choose which existing skill fits a task. Filters the catalog deterministically first, then asks a judge only when more than one candidate survives. ' +
            'A skill named explicitly by the user always wins and is never ranked lower. Returns an existing skill id, or none — never an invented one.',
          parameters: {
            taskId: { type: 'string', required: true },
            runId: { type: 'string', required: true },
            task: { type: 'string', required: true, description: 'The task to route.' },
            explicitSkill: { type: 'string', description: 'A skill the user named. It wins unconditionally.' },
            availableTools: { type: 'array', items: { type: 'string' }, description: 'Tools this session has, used to filter skills that cannot run.' },
          },
          output: envelopeOutput,
          async execute(args, exec) {
            const route = await import('../../lib/route.mjs');
            const catalog = readCatalog({ roots: config.skillRoots ? config.skillRoots.map((root) => ({ root, origin: 'configured', rank: 0 })) : undefined, repoRoot: REPO_ROOT });
            return route.routeSkill({
              task: args.task,
              catalog,
              explicitSkill: args.explicitSkill ?? null,
              availableTools: args.availableTools ?? [],
              judge: config.judge,
              taskId: args.taskId,
              runId: args.runId,
              signal: exec?.signal,
              timeoutMs: config.timeoutMs,
            });
          },
          presentCall: (args) => ({ card: 'generic', title: `Route skill for: ${String(args.task).slice(0, 60)}`, kind: 'other', rawInput: { task: args.task } }),
        }),
      ),
    );
  }

  // --- C3 -----------------------------------------------------------------
  if (isEnabled(config, 'jev_check_progress')) {
    registered.push(
      ctx.tools.register(
        defineTool({
          name: 'jev_check_progress',
          description:
            'Notice that a run is repeating a failed action without producing new information, and choose a new experiment instead of another attempt. ' +
            'Advisory: it never kills a process, reverts an edit or switches a model. An equal diff size or a long command is not evidence of no progress.',
          parameters: {
            taskId: { type: 'string', required: true },
            runId: { type: 'string', required: true },
            events: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'The event window. Omit to use the tool executions this session performed.' },
            maxRepeats: { type: 'integer', description: 'Repeats before handoff. Defaults to 3.' },
          },
          output: envelopeOutput,
          async execute(args, exec) {
            const progress = await import('../../lib/progress.mjs');
            const key = sessionKeyOf(exec);
            const events = args.events ?? store.eventsFor(key);
            const result = progress.analyseWindow({
              events,
              taskId: args.taskId,
              runId: args.runId,
              maxRepeats: args.maxRepeats,
              lastAdvice: store.lastAdvice(key),
            });
            store.setAdvice(key, result?.decision?.action ?? null);
            return result;
          },
          presentCall: () => ({ card: 'generic', title: 'Check progress', kind: 'other', rawInput: {} }),
        }),
      ),
    );
  }

  // --- C4 -----------------------------------------------------------------
  if (isEnabled(config, 'jev_review_scope')) {
    registered.push(
      ctx.tools.register(
        defineTool({
          name: 'jev_review_scope',
          description:
            'Review a pinned diff or file set against a narrow rubric. The material is handed to the judge in full, up to a stated limit; if required material is missing or was truncated, the answer is unverified and never a pass. ' +
            'Returns criteria with evidence refs — not invented line numbers, and no autopatches. Treat a finding as a signal to check the real source.',
          parameters: {
            taskId: { type: 'string', required: true },
            runId: { type: 'string', required: true },
            rubric: {
              type: 'array',
              required: true,
              items: { type: 'object', additionalProperties: true },
              description: 'Rubric criteria: [{id, text, required?}]. Keep it narrow — one thing per criterion.',
            },
            files: { type: 'array', items: { type: 'string' }, description: 'Files to pin and review.' },
            diff: { type: 'string', description: 'A pinned diff, if the change is already captured as text.' },
            snapshot: { type: 'string', description: 'The snapshot the material was taken at. A mismatch means unverified.' },
            scope: { type: 'array', items: { type: 'string' }, description: 'Paths the review is allowed to look at.' },
          },
          output: envelopeOutput,
          async execute(args, exec) {
            const review = await import('../../lib/review.mjs');
            return review.reviewScope({
              taskId: args.taskId,
              runId: args.runId,
              rubric: args.rubric,
              files: args.files ?? [],
              diff: args.diff ?? null,
              snapshot: args.snapshot ?? null,
              scope: args.scope ?? null,
              projectRoot: config.projectRoot,
              judge: config.judge,
              maxChars: config.maxReviewChars,
              signal: exec?.signal,
              timeoutMs: config.timeoutMs,
            });
          },
          presentCall: () => ({ card: 'generic', title: 'Review scope', kind: 'other', rawInput: {} }),
        }),
      ),
    );
  }

  // --- C5 -----------------------------------------------------------------
  if (isEnabled(config, 'jev_context_plan')) {
    registered.push(
      ctx.tools.register(
        defineTool({
          name: 'jev_context_plan',
          description:
            'Plan what can be dropped from a long history without losing the goal, the constraints, live authorisations, unresolved errors or critical evidence. ' +
            'Returns a valid reduced candidate and a restore map; the original is preserved untouched. Token counts are estimates. ' +
            'This is a preview: it does not compact a live request.',
          parameters: {
            taskId: { type: 'string', required: true },
            runId: { type: 'string', required: true },
            messages: { type: 'array', required: true, items: { type: 'object', additionalProperties: true }, description: 'The history, in order, as {role, content} or DSH message objects.' },
            budgetTokens: { type: 'integer', description: 'Target size for the candidate.' },
            keepIds: { type: 'array', items: { type: 'string' }, description: 'Block ids that must survive regardless of budget.' },
          },
          output: envelopeOutput,
          async execute(args, exec) {
            const planner = await import('../../lib/context-plan.mjs');
            return planner.planContext({
              taskId: args.taskId,
              runId: args.runId,
              messages: args.messages,
              budgetTokens: args.budgetTokens,
              keepIds: args.keepIds ?? [],
              signal: exec?.signal,
              timeoutMs: config.timeoutMs,
            });
          },
          presentCall: () => ({ card: 'generic', title: 'Plan context', kind: 'other', rawInput: {} }),
        }),
      ),
    );
  }

  // --- diagnose -----------------------------------------------------------
  if (isEnabled(config, 'jev_diagnose')) {
    registered.push(
      ctx.tools.register(
        defineTool({
          name: 'jev_diagnose',
          description:
            'Explain why a capability returned unverified, abstain or an error, and name ONE new experiment instead of repeating the same call. ' +
            'Use it before retrying a gate that failed without explaining itself.',
          parameters: {
            taskId: { type: 'string', required: true },
            runId: { type: 'string', required: true },
            envelope: { type: 'object', additionalProperties: true, description: 'The envelope that needs explaining.' },
          },
          output: envelopeOutput,
          async execute(args) {
            return diagnose({ envelope: args.envelope, taskId: args.taskId, runId: args.runId });
          },
          presentCall: () => ({ card: 'generic', title: 'Diagnose a gate result', kind: 'other', rawInput: {} }),
        }),
      ),
    );
  }

  // Every registration is owned by this fiber: stop, update or undefine removes
  // all of them, and the plugin leaves no tool behind in the catalog.
  //
  // The cleanup is registered defensively. If `ctx.effect` is unavailable the
  // disposers are still held and the fiber's own teardown removes the listeners;
  // what must never happen is a missing teardown helper aborting `apply` and
  // leaving the session with no tools at all.
  const cleanup = () => {
    for (const dispose of registered) {
      try {
        dispose();
      } catch {
        // A disposer that has already run is not an error.
      }
    }
    registered.length = 0;
  };
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => cleanup);
  }

  ctx.logger?.info?.(`jev-tools: registered ${registered.length} tool(s) in mode ${config.mode}`);
}

/**
 * Explain one envelope and propose a single next experiment.
 *
 * The rules are deterministic and small on purpose: a diagnosis that itself
 * needed a model would be a second thing that can be wrong while the first is
 * being investigated. Each reason code maps to one concrete change, because "try
 * again" is not a diagnosis.
 *
 * @param {object} input
 * @param {object} input.envelope - the envelope to explain.
 * @param {string} input.taskId
 * @param {string} input.runId
 * @returns {object} a capability envelope whose `decision.nextExperiment` names one action.
 */
export function diagnose({ envelope, taskId, runId }) {
  const code = envelope?.reason?.code ?? null;
  const snapshot = snapshotIdentity({ envelope: JSON.stringify(envelope ?? null) }, { source: 'diagnose' });

  /** code -> what it means, and the one thing worth changing. */
  const rules = {
    [CAPABILITY_REASON.requiredUnknown]: {
      cause: 'a required criterion has no observation that this session can trust',
      nextExperiment: 'name the artifact explicitly in `artifacts` so this tool reads it, or point verificationScope at the path the check actually produces',
    },
    [CAPABILITY_REASON.evidenceMissing]: {
      cause: 'no observation matched the criterion at all',
      nextExperiment: 'run the check that produces the artifact in this session, then verify again — a claim is not an observation',
    },
    [CAPABILITY_REASON.criterionFailed]: {
      cause: 'a required criterion was measured and failed',
      nextExperiment: 'fix the measured failure and produce new evidence; re-running the gate on the same evidence cannot change a fact',
    },
    [CAPABILITY_REASON.judgeUnavailable]: {
      cause: 'a semantic criterion needs a judge and none is available',
      nextExperiment: 'resolve the deterministic criteria first, or supply a judge; do not read this as either done or permitted',
    },
    [CAPABILITY_REASON.judgeError]: {
      cause: 'the judge was reachable but the call failed',
      nextExperiment: 'check the request shape the transport actually sent, then retry once — a malformed request fails identically forever',
    },
    [CAPABILITY_REASON.timeout]: {
      cause: 'the work exceeded its budget',
      nextExperiment: 'narrow the material or raise the budget for this call; a timeout is not evidence about the task',
    },
    [CAPABILITY_REASON.cancelled]: {
      cause: 'the caller cancelled the work',
      nextExperiment: 're-issue the call if the cancellation was a mistake; nothing was decided',
    },
    [CAPABILITY_REASON.snapshotMismatch]: {
      cause: 'the material changed after the snapshot it was judged at',
      nextExperiment: 're-pin the snapshot and judge again; a verdict about an older version does not describe this one',
    },
    [CAPABILITY_REASON.truncatedMaterial]: {
      cause: 'required material was truncated before it reached the judge',
      nextExperiment: 'raise the material limit or review fewer files; a truncated review cannot pass',
    },
    [CAPABILITY_REASON.repeatedWithoutProgress]: {
      cause: 'the same action and the same error class repeated with no new information',
      nextExperiment: 'change the hypothesis, not the retry count: run a different probe that can distinguish the two candidate causes',
    },
    [CAPABILITY_REASON.contextBudgetExceeded]: {
      cause: 'the pinned facts do not fit the budget',
      nextExperiment: 'raise the budget or drop unpinned blocks; pinned facts are never dropped to fit',
    },
  };

  const rule = rules[code] ?? {
    cause: code === null ? 'the envelope carries no reason code' : `no specific rule for ${code}`,
    nextExperiment: 'read the envelope\'s own limits and evidence refs before retrying',
  };

  return capabilityEnvelope({
    capability: 'jev_diagnose',
    taskId,
    runId,
    snapshot,
    status: envelope ? CAPABILITY_STATUS.success : CAPABILITY_STATUS.unverified,
    code: envelope ? CAPABILITY_REASON.ok : CAPABILITY_REASON.invalidInput,
    message: envelope ? rule.cause : 'no envelope was supplied to diagnose',
    decision: { summary: rule.cause, nextExperiment: rule.nextExperiment, diagnosedCode: code },
    evidence: [],
    model: modelLane({ requested: false, used: false, note: 'a diagnosis of a deterministic failure does not need a model' }),
    limits: ['this explains the envelope it was given; it does not re-run the check'],
  });
}

/**
 * Where the plugin's own files live, for a caller that needs to point at them.
 * @returns {string} the repository root.
 */
export function repoRoot() {
  return REPO_ROOT;
}

/** Read a file without throwing, for a caller that wants a best-effort peek. */
export function readTextFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The default skill root, used by documentation and the installer. */
export function defaultSkillRoot(env = process.env) {
  return join(env.DSH_HOME && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh'), 'skills');
}
