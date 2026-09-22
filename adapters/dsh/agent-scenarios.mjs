/**
 * Scenario plugin for the real-agent-loop acceptance.
 *
 * This is the TEST, not the thing under test. It mounts beside the real
 * `adapters/dsh/plugin.mjs` (the JEV adapter) in a throwaway profile and beside
 * `scripted-provider.mjs` (the model). It does four things:
 *
 *   1. Writes the response script the scripted provider will replay, so the
 *      "model" is a data file rather than code that could itself call tools.
 *   2. Registers the safe marker tools the scripted tool calls target. Every
 *      one of them writes a file and nothing else — no force-push, no delete,
 *      no network. The `ask`-gated tool only writes a marker when the REAL
 *      approval service grants it.
 *   3. Installs the isolated approval answerer on the REAL `approval/request`
 *      waterfall, and observes the real loop's durable events.
 *   4. Writes what it observed to `JEV_SCENARIO_OUT` for the runner to judge.
 *      It never decides whether the run passed: a test that grades itself is
 *      not a test.
 *
 * Everything observed here is labelled `real-agent-loop/scripted-provider` by
 * the runner. It proves the mechanism — the real loop really called a provider,
 * really executed the returned tool calls, really accepted `agent.steer` — and
 * nothing about model quality.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { claimPath, clearClaim, readClaim, writeClaim } from './claim.mjs';
import { decideStop, runGateForClaim } from './bridge.mjs';
import { defineTool } from '../../lib/toolspec.mjs';
import { verifyCompletion } from '../../lib/verify.mjs';

export const name = 'jev-agent-scenarios';

/** `tools` owns the registry and the pre-execute waterfall; `loader` orders the mount. */
export const inject = ['tools', 'loader'];

/** The provider route the scripted provider serves. Kept in sync by env, not by import. */
const PROVIDER = process.env.JEV_PROVIDER_ID ?? 'jev-scripted';
const MODEL = process.env.JEV_MODEL_ID ?? 'jev-scripted-1';

/** Tools this scenario registers. All of them write a marker file and nothing else. */
export const MARKER_TOOL = 'jev_marker';
export const BENIGN_TOOL = 'jev_benign';
export const FOREIGN_TOOL = 'jev_foreign';
export const ARTIFACT_TOOL = 'jev_artifact';
export const GATED_OK_TOOL = 'jev_gated_ok';
export const GATED_NO_TOOL = 'jev_gated_no';

/** The text the correct artifact must carry for the C1 criterion to pass. */
export const ARTIFACT_EXPECTED = 'CORRECT';

/**
 * The response script for one scenario set. Pure — this is what the offline
 * test exercises, so the sequencing is verifiable without booting anything.
 *
 * The "model" only ever emits ordinary assistant messages with ordinary tool
 * calls. It never calls a tool itself; the real loop does that.
 *
 * @param {string} set - one of `s1`..`s5`.
 * @param {{dir: string}} paths - scenario directory for marker paths.
 * @returns {{provider: string, model: string, responses: object[]}}
 */
export function buildScript(set, paths) {
  const dir = paths?.dir ?? '.';
  const marker = (n) => join(dir, `${n}.marker`);
  const script = (responses) => ({ provider: PROVIDER, model: MODEL, responses });

  const plain = { label: 'plain-text', stop: 'stop', blocks: [{ type: 'text', text: 'scenario complete' }] };

  if (set === 's1') {
    return script([
      { label: 's1-call-marker', stop: 'tool-calls', blocks: [{ type: 'tool-call', id: 's1-call-1', name: MARKER_TOOL, arguments: { path: marker('s1-marker') } }] },
      { ...plain, label: 's1-final-text' },
    ]);
  }

  if (set === 's2') {
    return script([
      { label: 's2-call-marker', stop: 'tool-calls', blocks: [{ type: 'tool-call', id: 's2-call-1', name: MARKER_TOOL, arguments: { path: marker('s2-marker') } }] },
      { label: 's2-first-stop', stop: 'stop', blocks: [{ type: 'text', text: 's2 first stop — the claim is still pending' }] },
      { label: 's2-after-steer', stop: 'stop', blocks: [{ type: 'text', text: 's2 after the steer — nothing new to add' }] },
    ]);
  }

  if (set === 's3') {
    return script([
      {
        label: 's3-two-gated-calls',
        stop: 'tool-calls',
        blocks: [
          { type: 'tool-call', id: 's3-call-ok', name: GATED_OK_TOOL, arguments: { path: marker('s3-approved') } },
          { type: 'tool-call', id: 's3-call-no', name: GATED_NO_TOOL, arguments: { path: marker('s3-rejected') } },
        ],
      },
      { ...plain, label: 's3-final-text' },
    ]);
  }

  if (set === 's4') {
    // Four steps, not three. The turn only reaches its stop boundary when the
    // model returns no tool call, so a script of [wrong, correct, text] would
    // verify ONCE — against the already-correct artifact — and the "first
    // verification does not confirm" assertion would be measuring nothing. The
    // plain-text step after each artifact is what makes the loop stop and ask.
    return script([
      { label: 's4-wrong-artifact', stop: 'tool-calls', blocks: [{ type: 'tool-call', id: 's4-call-1', name: ARTIFACT_TOOL, arguments: { path: marker('s4-artifact'), content: 'WRONG' } }] },
      { label: 's4-stop-on-wrong', stop: 'stop', blocks: [{ type: 'text', text: 's4: the artifact is written; the claim is now unconfirmed' }] },
      { label: 's4-correct-artifact', stop: 'tool-calls', blocks: [{ type: 'tool-call', id: 's4-call-2', name: ARTIFACT_TOOL, arguments: { path: marker('s4-artifact'), content: ARTIFACT_EXPECTED } }] },
      { ...plain, label: 's4-final-text' },
    ]);
  }

  if (set === 's5') {
    return script([{ ...plain, label: 's5-plain-text' }]);
  }

  return script([plain]);
}

/**
 * The v2 gate request used by the Stop and C1 sets. Pure.
 *
 * The S4 criterion is `artifact_digest`, not a substring check: the vocabulary
 * in `lib/contracts.mjs` is closed (`artifact_exists`, `artifact_nonempty`,
 * `artifact_digest`, `command_exit`, `read_after_write`), and a digest is the
 * only member that can distinguish two different file CONTENTS while staying
 * deterministic. A criterion that cannot tell WRONG from CORRECT would make the
 * C1 assertion vacuous.
 *
 * The digest is a BARE hex string. `lib/contracts.mjs` validates it with
 * `/^[a-f0-9]{8,128}$/i` and rejects a `sha256:` prefix as `bad_value`, which
 * surfaces as exit 3 (`unverified`) rather than as a failed criterion — a
 * distinction that would have made this scenario look like a gate problem
 * instead of the malformed request it was.
 */
export function buildRequest({ taskId, runId, artifactPath, expected }) {
  const digest = createHash('sha256').update(String(expected)).digest('hex');
  return {
    schemaVersion: 2,
    taskId,
    runId,
    mode: 'completion',
    criteria: [
      {
        id: 'artifact-matches',
        text: `the artifact exists and matches the digest of ${expected}`,
        kind: 'deterministic',
        required: true,
        verificationScope: [artifactPath],
        check: { type: 'artifact_digest', digest },
      },
    ],
    claims: { task: taskId, claimed: `the artifact contains ${expected}` },
  };
}

/** Write JSON, creating the parent directory when it is missing. */
function writeJson(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* the directory may already exist */
  }
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

/** Read the provider's summary. Absence is reported, never invented. */
function readProvider(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Turn one durable session event into the small record the runner judges. */
function foldEvent(event, into) {
  const data = event?.data ?? {};
  if (event.type === 'tool/call') {
    into.toolCalls.push({ seq: event.seq, callId: data.callId, name: data.name, arguments: data.arguments });
    return;
  }
  if (event.type === 'tool/result') {
    const block = Array.isArray(data.message?.content) ? data.message.content[0] : null;
    const text = (block?.content ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('');
    into.toolResults.push({
      seq: event.seq,
      callId: block?.toolCallId ?? null,
      isError: block?.isError === true,
      text: text.slice(0, 400),
      error: data.error ?? null,
    });
    return;
  }
  if (event.type === 'approval/asked') {
    into.approvals.push({ seq: event.seq, id: String(data.id ?? ''), toolName: data.toolName, callId: data.callId ?? null, reason: data.reason ?? null, outcome: null });
    return;
  }
  if (event.type === 'approval/decided') {
    const asked = into.approvals.find((entry) => entry.id === String(data.id ?? ''));
    if (asked) asked.outcome = data.outcome;
    return;
  }
  if (event.type === 'assistant/message') {
    into.assistantMessages.push({
      seq: event.seq,
      turn: data.turn,
      step: data.step,
      text: (data.message?.content ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('')
        .slice(0, 200),
      toolCalls: (data.message?.content ?? []).filter((b) => b?.type === 'tool-call').map((b) => ({ id: b.id, name: b.name })),
    });
    return;
  }
  if (event.type === 'step/start') {
    into.steps.push({ turn: data.turn, step: data.step });
    return;
  }
  if (event.type === 'turn/end') {
    into.turnEnds.push({ seq: event.seq, turn: data.turn, reason: data.reason ?? null });
    return;
  }
  if (event.type === 'user/message') {
    const text = (data.content ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('');
    into.userMessages.push({ seq: event.seq, source: data.source?.kind ?? null, text: text.slice(0, 300) });
  }
}

/**
 * Mount the scenario plugin.
 * @param {object} ctx - Cordis context carrying `tools` and `loader`.
 * @param {object} [config] - unused; the scenario is selected by environment.
 */
export function apply(ctx, config = {}) {
  const env = process.env;
  const dir = env.JEV_SCENARIO_DIR;
  const out = env.JEV_SCENARIO_OUT;
  const set = env.JEV_SET ?? 's1';
  const scriptPath = env.JEV_SCRIPT_PATH ?? (dir ? join(dir, 'script.json') : null);
  const providerOut = env.JEV_PROVIDER_OUT ?? (dir ? join(dir, 'provider.json') : null);
  if (!dir || !out) return;

  // The script is written at mount time, before the first model call, so the
  // provider's lazy read always finds it regardless of row order.
  if (scriptPath) writeJson(scriptPath, buildScript(set, { dir }));

  const observations = { set, mode: 'real-agent-loop/scripted-provider', notes: [], events: null, approval: null, catalog: null, verify: [], turnStopping: [], inboxSplices: [], scenarioSteer: [], eventTypes: {} };
  const note = (name, value) => observations.notes.push({ name, ...value });
  const flush = () => writeJson(out, { ...observations, provider: readProvider(providerOut) });

  ctx.effect(async () => {
    try {
      await ctx.loader?.await?.();

      // ---- the tools under test -------------------------------------------
      const markerTool = (toolName, label) =>
        defineTool({
          name: toolName,
          description: `Acceptance marker tool ${toolName}. It writes a marker file and does nothing else.`,
          parameters: {
            path: { type: 'string', required: true, description: 'marker path' },
          },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
          async execute(args) {
            writeFileSync(String(args.path), label, 'utf8');
            return `wrote ${args.path}`;
          },
        });

      const artifactTool = defineTool({
        name: ARTIFACT_TOOL,
        description: 'Acceptance artifact tool. Writes the given content to the given path. Nothing else.',
        parameters: {
          path: { type: 'string', required: true, description: 'artifact path' },
          content: { type: 'string', required: true, description: 'exact content to write' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        async execute(args) {
          writeFileSync(String(args.path), String(args.content), 'utf8');
          return `wrote ${String(args.content).length} bytes to ${args.path}`;
        },
      });

      const register = (definition) => {
        try {
          ctx.tools.register(definition);
          return true;
        } catch (error) {
          note(`register:${definition.name}`, { ok: false, error: String(error?.message ?? error) });
          return false;
        }
      };

      register(markerTool(MARKER_TOOL, 'marker'));
      register(markerTool(BENIGN_TOOL, 'benign'));
      register(markerTool(FOREIGN_TOOL, 'foreign'));
      register(artifactTool);
      register(markerTool(GATED_OK_TOOL, 'approved'));
      register(markerTool(GATED_NO_TOOL, 'rejected'));

      // A guard owned by "another system", monotonic exactly like the JEV
      // adapter's. The point is that mounting this scenario does not weaken it.
      ctx.tools.guard((exec) => (exec.name === FOREIGN_TOOL ? 'foreign-guard: this tool is reserved by another policy' : undefined));

      // ---- S3: the REAL approval service ----------------------------------
      //
      // `approval/request` is a waterfall on the real ApprovalService. Returning
      // an outcome claims the request; calling `next()` delegates and, with no
      // other answerer composed, falls through to the fail-closed
      // `unavailable`. This answerer is deliberately keyed on the tool name, so
      // one turn proves both directions without a second boot.
      if (set === 's3') {
        const seen = [];
        observations.approval = { answerer: 'jev-agent-scenarios', serviceMounted: ctx.get('approval') !== undefined, decisions: seen };
        ctx.on('approval/request', async (req, next) => {
          const record = {
            toolName: req?.toolName ?? null,
            callId: req?.callId ?? null,
            reason: req?.reason ?? null,
            agentId: req?.agent?.id ?? null,
            sessionId: req?.agent?.session?.id ?? null,
            hasSignal: req?.signal !== undefined,
            at: new Date().toISOString(),
          };
          if (req?.toolName === GATED_OK_TOOL) {
            seen.push({ ...record, outcome: 'allowed-once' });
            flush();
            return 'allowed-once';
          }
          if (req?.toolName === GATED_NO_TOOL) {
            seen.push({ ...record, outcome: 'rejected' });
            flush();
            return 'rejected';
          }
          return next();
        });

        // The ask itself is raised by the ordinary pre-execute waterfall — the
        // only place a tool decision can become a question.
        ctx.on('tools/pre-execute', async (exec, next) => {
          if (exec?.name === GATED_OK_TOOL || exec?.name === GATED_NO_TOOL) {
            return { kind: 'ask', reason: `acceptance: ${exec.name} requires authorisation` };
          }
          return next();
        });
      }

      // ---- live capture of the real loop's durable log ---------------------
      const events = {
        toolCalls: [],
        toolResults: [],
        approvals: [],
        assistantMessages: [],
        steps: [],
        turnEnds: [],
        userMessages: [],
      };
      observations.events = events;
      // `agent/inbox/spliced` is the durable record of a steering message
      // reaching the real inbox. It is folded down to the SHAPE of each inserted
      // message — never the live message object — because the question this
      // answers is whether the message the real loop received was well formed.
      observations.inboxSplices = [];
      observations.eventTypes = {};
      ctx.on('session/event', (_session, event) => {
        const type = typeof event?.type === 'string' ? event.type : '(untyped)';
        observations.eventTypes[type] = (observations.eventTypes[type] ?? 0) + 1;
        if (event?.type === 'agent/inbox/spliced') {
          const inserted = Array.isArray(event.data?.inserted) ? event.data.inserted : [];
          observations.inboxSplices.push({
            target: event.data?.target ?? null,
            removed: Array.isArray(event.data?.removed) ? event.data.removed.length : 0,
            inserted: inserted.map((message) => ({
              hasSource: message?.source !== undefined && message?.source !== null,
              sourceKind: message?.source?.kind ?? null,
              sourcePlugin: message?.source?.plugin ?? null,
              hasId: typeof message?.id === 'string' && message.id.length > 0,
              contentTypes: Array.isArray(message?.content) ? message.content.map((block) => block?.type ?? null) : null,
              text: Array.isArray(message?.content) && message.content[0]?.type === 'text' ? String(message.content[0].text).slice(0, 200) : null,
            })),
          });
        }
        foldEvent(event, events);
        if (event?.type === 'turn/end') flush();
      });

      // ---- agent scope: the tool catalog is only real inside an agent ------
      ctx.on('agent/created', ({ agent }) => {
        observations.agent = { id: agent?.id ?? null, sessionId: agent?.session?.id ?? null };
        try {
          const schemas = ctx.tools.schemas(agent);
          observations.catalog = {
            count: schemas.length,
            names: schemas.map((schema) => schema.name).sort(),
            jevTools: schemas
              .filter((schema) => String(schema.name).startsWith('jev_'))
              .map((schema) => ({
                name: schema.name,
                descriptionLength: typeof schema.description === 'string' ? schema.description.length : 0,
                parametersType: schema.parameters?.type ?? null,
              })),
          };
        } catch (error) {
          observations.catalog = { error: String(error?.message ?? error) };
        }
        flush();
      });

      // ---- the claim producer (S2 and S4) ---------------------------------
      //
      // The claim is written through the real `writeClaim`, and the REAL JEV
      // adapter's `agent/turn-stopping` listener is what reads it and steers.
      // This plugin only supplies the input and records what happened.
      if (set === 's2' || set === 's4') {
        ctx.on('agent/created', ({ agent }) => {
          const sessionId = agent?.session?.id ?? agent?.id;
          if (!sessionId) return;
          try {
            if (set === 's2') {
              const requestPath = join(dir, 's2-request.json');
              writeJson(requestPath, buildRequest({ taskId: 's2-task', runId: 's2-run', artifactPath: join(dir, 's2-absent.txt'), expected: 'anything' }));
              const record = { claim: 'the absent artifact is present', request: requestPath, taskId: 's2-task', promptId: 'p1', collect: [join(dir, 's2-absent.txt')] };
              const written = writeClaim({ sessionId, env, ...record });
              observations.claim = { sessionId, path: written.path, record: written.record, claimPath: claimPath(sessionId, env) };
            } else {
              const requestPath = join(dir, 's4-request.json');
              const artifactPath = join(dir, 's4-artifact.marker');
              writeJson(requestPath, buildRequest({ taskId: 's4-task', runId: 's4-run', artifactPath, expected: ARTIFACT_EXPECTED }));
              const record = { claim: `the artifact contains ${ARTIFACT_EXPECTED}`, request: requestPath, taskId: 's4-task', promptId: 'p1', collect: [artifactPath] };
              const written = writeClaim({ sessionId, env, ...record });
              observations.claim = { sessionId, path: written.path, record: written.record, claimPath: claimPath(sessionId, env) };
            }
          } catch (error) {
            note('claim:write-failed', { error: String(error?.message ?? error) });
          }
        });
      }

      // ---- observation points ---------------------------------------------
      //
      // `agent/turn-stopping` is where the real loop decides whether the turn
      // closes. It is SERIAL and its return value is discarded, so this listener
      // can only observe — which is exactly what a test should do. It runs after
      // the JEV adapter's own listener, because the adapter's row mounts first.
      ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
        try {
          const provider = readProvider(providerOut);
          const entry = {
            turn,
            aborted: signal?.aborted === true,
            providerConversationCalls: provider?.conversationCalls ?? null,
            toolCalls: events.toolCalls.map((c) => c.name),
            markerExists: {
              s1: existsSync(join(dir, 's1-marker.marker')),
              s2: existsSync(join(dir, 's2-marker.marker')),
              s3Approved: existsSync(join(dir, 's3-approved.marker')),
              s3Rejected: existsSync(join(dir, 's3-rejected.marker')),
              s4: existsSync(join(dir, 's4-artifact.marker')),
            },
          };

          // S4: verify the completion claim against the real artifact, using the
          // real verifier. This runs inside the real turn, after the real tool
          // call has written the artifact, so the answer is about the world and
          // not about a fixture.
          if (set === 's4') {
            const artifactPath = join(dir, 's4-artifact.marker');
            const request = JSON.parse(readFileSync(join(dir, 's4-request.json'), 'utf8'));
            const envelope = await verifyCompletion({
              taskId: 's4-task',
              runId: `s4-run-turn${turn}-n${observations.verify.length + 1}`,
              request,
              artifacts: [artifactPath],
              allowModel: false,
            });
            observations.verify.push({
              turn,
              at: new Date().toISOString(),
              status: envelope?.status ?? null,
              exitCode: envelope?.decision?.exitCode ?? null,
              snapshotDigest: envelope?.snapshot?.digest ?? null,
              reasonCode: envelope?.reason?.code ?? null,
              artifactText: existsSync(artifactPath) ? readFileSync(artifactPath, 'utf8').slice(0, 60) : null,
            });
          }

          // S5: drive the REAL `jev_route_skill` tool through the real registry,
          // inside the agent's scope, and then try to load the skill it names
          // through the REAL skill service (`ctx.skills`, provided by
          // `@deepseek-ai/dsh-skill` over `dsh-skill-filesystem`). The project
          // root carries a `.dsh/skills` copy of the repository catalog, so a
          // routed id is loadable by the harness itself and not merely by the
          // file reader the router used.
          if (set === 's5') {
            observations.skillRoute = [];
            const cases = [
              { label: 'auto', arguments: {} },
              { label: 'none', arguments: { explicitSkill: 'none' } },
              { label: 'explicit', arguments: { explicitSkill: env.JEV_SKILL_CHOICE ?? null } },
              { label: 'filtered', arguments: { availableTools: ['definitely-not-a-real-tool'] } },
            ];
            for (const testCase of cases) {
              const args = {
                taskId: 's5-task',
                runId: `s5-${testCase.label}`,
                task: env.JEV_SKILL_TASK ?? 'verify that a change is actually finished before reporting it done',
                ...testCase.arguments,
              };
              if (args.explicitSkill === null) delete args.explicitSkill;
              const callId = `s5-${testCase.label}-${observations.skillRoute.length}`;
              const record = { label: testCase.label, args };
              try {
                const result = await ctx.tools.execute({ callId, name: 'jev_route_skill', arguments: args, agent, signal });
                const envelope = result?.value ?? null;
                const decision = envelope?.decision ?? null;
                record.isError = result?.isError === true;
                record.status = envelope?.status ?? null;
                record.reasonCode = envelope?.reason?.code ?? null;
                record.recommended = typeof decision?.recommended === 'string' ? decision.recommended : null;
                record.source = decision?.source ?? null;
                record.explicitSkillExists = decision?.explicitSkillExists ?? null;
                record.shortlistLength = Array.isArray(decision?.shortlist) ? decision.shortlist.length : null;
                record.excludedLength = Array.isArray(decision?.excluded) ? decision.excluded.length : null;
                record.limits = Array.isArray(envelope?.limits) ? envelope.limits : null;
                record.availableTools = Array.isArray(args.availableTools) ? args.availableTools : null;
                if (record.recommended) {
                  const skills = ctx.get('skills');
                  if (skills === undefined) {
                    record.load = { ok: false, error: 'the skills service is not mounted in this profile' };
                  } else {
                    try {
                      const loaded = await skills.get(record.recommended, { scope: agent, cwd: env.JEV_PROJECT_DIR });
                      record.load = loaded
                        ? { ok: true, path: loaded.path ?? null, contentLength: String(loaded.content ?? '').length, provider: loaded.provider ?? null }
                        : { ok: false, reason: 'the skill service returned nothing' };
                    } catch (error) {
                      record.load = { ok: false, error: String(error?.message ?? error) };
                    }
                  }
                }
              } catch (error) {
                record.threw = String(error?.message ?? error);
              }
              // Record which tool the real registry executed. The runner reports
              // this separately from model-issued calls: `ctx.tools.execute` is the
              // real harness running the real tool, but the model did not choose to,
              // and conflating the two would overstate what happened.
              record.tool = 'jev_route_skill';
              observations.skillRoute.push(record);
            }
          }

          // S2 (adapter boot): the adapter's own listener has already run and
          // called `agent.steer`. Its state file is private to `plugin.mjs`, so
          // this recomputes the SAME `decideStop` over the SAME real claim and
          // the SAME real gate result with the state the first stop must have
          // (`steers: 0`). It is labelled a recomputation everywhere it is
          // reported, because it is evidence about the inputs, not a recording
          // of the adapter's call.
          if ((set === 's2' || set === 's4') && env.JEV_STEER_MODE !== 'scenario') {
            const sessionId = observations.claim?.sessionId ?? agent?.session?.id ?? agent?.id;
            const claim = sessionId ? readClaim({ sessionId, env }) : null;
            if (claim) {
              const gateResult = claim.request ? runGateForClaim({ request: claim.request, env, timeoutMs: 20_000, collect: claim.collect ?? [] }) : null;
              const reasonCodes = gateResult ? [`exit_${gateResult.exitCode}`] : ['no_gate_request'];
              const key = [claim.taskId ?? 'task?', claim.promptId ?? `turn${turn}`, claim.snapshotDigest ?? 'snap?', ...reasonCodes].join('|');
              const outcome = decideStop({ sessionId, state: { steers: 0, lastKey: null }, maxSteers: 2, pendingClaim: claim, gateResult, key });
              observations.adapterDecision = {
                recomputed: true,
                turn,
                key,
                steer: outcome.steer === true,
                steers: outcome.steers ?? null,
                gateExitCode: gateResult?.exitCode ?? null,
                steerText: outcome.output?.reason ?? null,
              };
            }
          }

          observations.turnStopping.push(entry);
          flush();
        } catch (error) {
          note('turn-stopping:failed', { error: String(error?.stack ?? error) });
          flush();
        }
      });

      ctx.on('agent/error', ({ error }) => {
        note('agent:error', { error: String(error?.message ?? error) });
        flush();
      });

      // ---- the well-formed steering control (S2 and S4) ---------------------
      //
      // The acceptance has to separate two claims that look identical from
      // outside: "the real loop rejects steering" and "the message the JEV
      // adapter steers with is malformed". This listener supplies the control.
      // It runs the SAME decision rule the adapter runs — the real `decideStop`
      // from `bridge.mjs`, over the real claim and the real out-of-process gate
      // result — and the only difference is the message it hands to
      // `agent.steer`: it carries the `source` the loop requires. Mounted only
      // when the runner asks for it, and only in a boot where the adapter's own
      // Stop handler is absent, so the two cannot interfere.
      if ((set === 's2' || set === 's4') && env.JEV_STEER_MODE === 'scenario') {
        const state = { steers: 0, lastKey: null };
        observations.scenarioSteer = [];
        ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
          try {
            if (signal?.aborted === true) return;
            const sessionId = observations.claim?.sessionId ?? agent?.session?.id ?? agent?.id;
            const claim = readClaim({ sessionId, env });
            if (!claim) return;
            const gateResult = claim.request ? runGateForClaim({ request: claim.request, env, timeoutMs: 20_000, collect: claim.collect ?? [] }) : null;
            const reasonCodes = gateResult ? [`exit_${gateResult.exitCode}`] : ['no_gate_request'];
            const key = [claim.taskId ?? 'task?', claim.promptId ?? `turn${turn}`, claim.snapshotDigest ?? 'snap?', ...reasonCodes].join('|');
            const outcome = decideStop({ sessionId, state, maxSteers: 2, pendingClaim: claim, gateResult, key });
            observations.scenarioSteer.push({
              turn,
              key,
              steer: outcome.steer === true,
              repeated: outcome.repeated === true,
              confirmed: outcome.confirmed === true,
              exhausted: outcome.exhausted === true,
              clearClaim: outcome.clearClaim === true,
              steers: outcome.steers ?? null,
              gateExitCode: gateResult?.exitCode ?? null,
              reason: outcome.output?.reason ?? null,
            });
            if (outcome.clearClaim) clearClaim({ sessionId, env });
            if (!outcome.steer) {
              flush();
              return;
            }
            state.steers = outcome.steers;
            state.lastKey = key;
            // The one deliberate difference from the adapter: this is a complete
            // message. `agent.steer` takes a `UserMessage`, and the adapter sends
            // a bare `{content}` object — no `role`, no `id`, and crucially no
            // `source`. The loop's runtime-context projection dereferences
            // `message.source.kind` on every `user/message` event, so the missing
            // `source` is what kills the turn; `role` and `id` are what make the
            // message actually reach the model instead of being skipped by the
            // request assembler.
            agent.steer({
              id: `steer-${turn}-${state.steers}`,
              role: 'user',
              content: [{ type: 'text', text: outcome.output.reason }],
              source: { kind: 'user' },
            });
            flush();
          } catch (error) {
            note('scenario-steer:failed', { error: String(error?.message ?? error) });
            flush();
          }
        });
      }

      ctx.on('agent/status', ({ status }) => {
        if (status === 'idle') {
          observations.claimStillPending = observations.claim?.sessionId ? readClaim({ sessionId: observations.claim.sessionId, env }) !== null : null;
          flush();
        }
      });

      flush();
    } catch (error) {
      note('fatal', { error: String(error?.stack ?? error) });
      flush();
    }
  }, 'jev-agent-scenarios');
}
