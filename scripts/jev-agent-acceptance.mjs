#!/usr/bin/env node
/**
 * Runtime acceptance for the JEV adapter that drives the REAL agent loop.
 *
 * Why this exists next to `scripts/jev-dsh-acceptance.mjs`
 * -------------------------------------------------------
 * That runner proves the tool pipeline, the guard surface and the Stop handler
 * by calling `ctx.tools.execute` directly. It cannot prove three things:
 *
 *   - that `Stop` works inside a real turn,
 *   - that `agent.steer` is accepted by the real loop,
 *   - that an agent-bound `ask` routes through the real approval service.
 *
 * All three live in the agent loop, and the only way into the loop is to be the
 * model. This runner boots a throwaway `DSH_HOME`, mounts the real
 * `adapters/dsh/plugin.mjs`, a deterministic scripted model provider
 * (`adapters/dsh/scripted-provider.mjs`) and a scenario plugin
 * (`adapters/dsh/agent-scenarios.mjs`), then lets the real one-shot driver run
 * one prompt to quiescence.
 *
 * What every result here is, and is not
 * -------------------------------------
 * Every result is labelled `real-agent-loop/scripted-provider`. It proves the
 * MECHANISM: the real loop really called a provider, really executed the tool
 * calls that came back, really accepted the steering message and really ran
 * another step, really routed an `ask` through the real approval service. It
 * proves NOTHING about model quality — the model is a JSON file. A green run
 * here is evidence about the harness and the adapter, never about a real model.
 *
 * Isolation
 * ---------
 * `DSH_HOME` points at a temp directory — including under `--keep`, so the
 * repository working tree is never a scratch space; the active profile is never
 * read or written; no global `node_modules` is touched; no paid API is called
 * (there is no credential and the scripted provider replaces the network). Every
 * tool under test writes a marker file and nothing else — no force-push, no
 * delete. The DeepSeek route is disabled by the overlay rather than left to fail
 * on a missing key: nothing in the composition needs a credential, so the boot
 * output should not carry a credential warning a reader has to be told to ignore.
 *
 * The result this runner currently produces
 * ----------------------------------------
 * S1, S3 and S5 hold. S2 fails, and the failure is the point of the exercise:
 * `adapters/dsh/plugin.mjs` steers with `agent.steer({ content: [...] })`, and a
 * `UserMessage` requires `source`. The loop's runtime-context projection reads
 * `message.source.kind` on every `user/message`, so the missing `source` throws
 * `Cannot read properties of undefined (reading 'kind')`, the turn ends as
 * `error`, and the steering message never becomes a step. S4 is unreachable
 * through the real adapter for the same reason: the abort lands before its second
 * verification.
 *
 * Both S2 and S4 therefore run TWO boots. The first mounts the real adapter and
 * shows the abort. The second omits the adapter and steers with the SAME real
 * `decideStop`, the SAME real claim and the SAME real out-of-process gate, and
 * the only difference is a well-formed message. That split is what turns an
 * alarm into a diagnosis: without it, a red S2 cannot be told apart from "the
 * loop rejects steering". The control does not excuse the defect — S2 still
 * fails, and the report lists every path the real adapter could not complete
 * under `blockedPaths`.
 *
 * Failure classes are kept apart on purpose, and none of them is a pass:
 *
 *   boot-timeout                the harness did not finish starting
 *   harness-not-driven          it started but produced no scenario result
 *   provider-not-called         the real loop never reached the scripted model
 *   provider-stream-malformed   the provider was reached but settled no message
 *   listener-not-attached       the scenario plugin observed no agent
 *   tool-not-invoked            a scripted tool call produced no tool result
 *   blocked-by-interface        a supported non-interactive path does not exist
 *   assertion-failed            the observation contradicted the expectation
 *
 * `provider-stream-malformed` is claimed only when the loop settled NO assistant
 * message. A turn that produced messages and then failed later is an assertion
 * to judge, not a broken stream, and conflating the two would hide the real cause
 * behind a plausible-sounding class.
 *
 * Usage:
 *   node scripts/jev-agent-acceptance.mjs [--set all|s1|s2|s3|s4|s5]
 *                                         [--json] [--timeout-ms 120000] [--keep]
 *
 * Exit codes: 0 every set held, 1 a set failed, 3 a set was not driven.
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readClaim } from '../adapters/dsh/claim.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const ADAPTERS = join(REPO, 'adapters', 'dsh');

/** The label every result in this report carries. */
export const MODE = 'real-agent-loop/scripted-provider';

/** The scenario sets, in the order they run. */
export const SETS = ['s1', 's2', 's3', 's4', 's5'];

/** The provider route and model the scripted provider serves. */
export const PROVIDER_ID = 'jev-scripted';
export const MODEL_ID = 'jev-scripted-1';

/** The repository skill used as the explicit user choice in S5. */
export const SKILL_CHOICE = 'jev-completion-gate';

/** The six tools `adapters/dsh/tools.mjs` registers. */
export const JEV_TOOLS = [
  'jev_check_progress',
  'jev_context_plan',
  'jev_diagnose',
  'jev_review_scope',
  'jev_route_skill',
  'jev_verify_completion',
];

/** Classes that mean the run was never driven. None of them is a pass. */
export const NOT_DRIVEN_CLASSES = ['boot-timeout', 'harness-not-driven', 'provider-not-called', 'provider-stream-malformed', 'listener-not-attached', 'tool-not-invoked'];

/** Classes that mean the observation was made and contradicted the expectation. */
export const FAILURE_CLASSES = ['assertion-failed', 'blocked-by-interface'];

// --- pure logic --------------------------------------------------------------

/** One assertion result. `detail` is evidence, never a second verdict. */
export function expect(name, ok, detail) {
  return { name, ok: ok === true, detail: detail === undefined ? null : detail };
}

/**
 * The infrastructure failure class for one set, or `null` when the set was
 * actually driven and only the assertions remain to be judged. Pure.
 *
 * The order matters: a boot that timed out is not also a provider failure, and
 * a provider that was never called is not an assertion failure. Reporting the
 * first true cause is what keeps the classes separable.
 *
 * @param {{bootTimedOut?: boolean, scenario?: object|null, provider?: object|null}} input
 * @returns {string|null} a class name, or null when the set was driven.
 */
export function failureClass({ bootTimedOut = false, scenario = null, provider = null } = {}) {
  if (bootTimedOut) return 'boot-timeout';
  if (!scenario || typeof scenario !== 'object') return 'harness-not-driven';

  const notes = Array.isArray(scenario.notes) ? scenario.notes : [];
  if (notes.some((note) => note?.name === 'fatal')) return 'harness-not-driven';
  if (notes.some((note) => note?.name === 'claim:write-failed')) return 'harness-not-driven';

  if (!provider || typeof provider !== 'object') return 'provider-not-called';
  if (!Number.isInteger(provider.conversationCalls) || provider.conversationCalls < 1) return 'provider-not-called';

  const events = scenario.events ?? null;
  if (!events || typeof events !== 'object') return 'harness-not-driven';

  // `provider-stream-malformed` is claimed only when the provider was reached and
  // the loop never settled a single assistant message from it. A turn that DID
  // produce assistant messages and then failed later is a downstream failure —
  // an assertion to judge — not a broken stream, and conflating the two would
  // hide the real cause behind a plausible-sounding class.
  const assistantMessages = Array.isArray(events.assistantMessages) ? events.assistantMessages : [];
  if (assistantMessages.length === 0) return 'provider-stream-malformed';

  if (!scenario.agent && !scenario.catalog) return 'listener-not-attached';

  const calls = Array.isArray(events.toolCalls) ? events.toolCalls : [];
  const results = Array.isArray(events.toolResults) ? events.toolResults : [];
  if (calls.length > 0 && results.length === 0) return 'tool-not-invoked';

  return null;
}

/**
 * The overall verdict from the per-set classes. Pure.
 * @param {{class: string}[]} results - one entry per set.
 * @returns {'held'|'not-held'|'not-driven'}
 */
export function verdictOf(results) {
  if (!Array.isArray(results) || results.length === 0) return 'not-driven';
  if (results.some((result) => NOT_DRIVEN_CLASSES.includes(result.class))) return 'not-driven';
  if (results.some((result) => FAILURE_CLASSES.includes(result.class))) return 'not-held';
  if (results.every((result) => result.class === 'held')) return 'held';
  return 'not-driven';
}

/** Exit code for a verdict. Pure. */
export function exitCodeOf(verdict) {
  return verdict === 'held' ? 0 : verdict === 'not-held' ? 1 : 3;
}

/** Find one recorded tool call by name. */
function callNamed(events, name) {
  return (events?.toolCalls ?? []).find((call) => call.name === name) ?? null;
}

/** Find one recorded tool result by callId. */
function resultFor(events, callId) {
  return (events?.toolResults ?? []).find((result) => result.callId === callId) ?? null;
}

/** Whether one skill id has a SKILL.md in the repository skill root. */
export function skillFileExists(id, repoRoot = REPO) {
  return typeof id === 'string' && id.length > 0 && existsSync(join(repoRoot, 'skills', id, 'SKILL.md'));
}

/**
 * S2 runs two boots, and the split is the point.
 *
 * Boot `s2-adapter` mounts the real JEV adapter, so its own `agent/turn-stopping`
 * listener produces the steering message. Boot `s2-wellformed` omits the adapter
 * and steers from the scenario with the SAME real `decideStop`, the SAME real
 * claim and the SAME real out-of-process gate.
 *
 * The control earned its place by finding a real defect. When the two boots first
 * disagreed, the difference was that the adapter's message lacked the `source` the
 * loop requires, and the control is what made that a fact rather than a guess: it
 * showed the loop accepting an otherwise identical steer, so the fault was in the
 * message and not in steering. `adapters/dsh/plugin.mjs` now sends a complete
 * `UserMessage` and both boots agree.
 *
 * The control is kept even though it now passes alongside the adapter, because it
 * is the thing that distinguishes "steering is broken" from "our message is
 * broken" the next time one of them fails.
 *
 * @param {Record<string, object>} boots
 * @param {object} shared
 */
export function checksForS2(boots, shared = {}) {
  const adapterBoot = boots?.['s2-adapter'] ?? {};
  const controlBoot = boots?.['s2-wellformed'] ?? {};
  const a = adapterBoot.scenario ?? null;
  const aProvider = adapterBoot.provider ?? null;
  const aEvents = a?.events ?? {};
  const aStopping = a?.turnStopping ?? [];
  const aSplices = (a?.inboxSplices ?? []).filter((splice) => Array.isArray(splice?.inserted) && splice.inserted.length > 0);
  const aTurnEnd = (aEvents.turnEnds ?? [])[0] ?? null;
  const aSteerMessage = aSplices.find((splice) => splice.target === 'next-step')?.inserted?.[0] ?? null;

  const c = controlBoot.scenario ?? null;
  const cProvider = controlBoot.provider ?? null;
  const cEvents = c?.events ?? {};
  const cStopping = c?.turnStopping ?? [];
  const cSteer = c?.scenarioSteer ?? [];
  const cTurnEnd = (cEvents.turnEnds ?? [])[0] ?? null;
  const cCalls = cProvider?.calls ?? [];
  const afterSteer = cCalls[2] ?? null;

  return [
    // --- the thing under test: the adapter's own steering message ------------
    expect(
      's2: the real JEV adapter reached its Stop decision at the turn boundary',
      aStopping.length >= 1 && a?.adapterDecision?.steer === true,
      { turnStopping: aStopping.map((entry) => entry.providerConversationCalls), adapterDecision: a?.adapterDecision ?? null },
    ),
    expect(
      's2: the adapter\'s steering message really reached the real inbox as a next-step message',
      aSteerMessage !== null && aSteerMessage.text === a?.adapterDecision?.steerText,
      { steerMessage: aSteerMessage, spliceTarget: aSplices.find((splice) => splice.target === 'next-step')?.target ?? null },
    ),
    // These three asserted the DEFECT while it existed: the steering message
    // carried no `source` or `id`, the turn died on `source.kind`, and the message
    // never became a step. `adapters/dsh/plugin.mjs` now steers a complete
    // `UserMessage`, so they assert the fixed behaviour instead. Kept as three
    // separate checks rather than deleted, because each names a distinct thing that
    // must be true and a regression in any one of them is readable on its own.
    expect(
      's2: the adapter\'s steering message carries the `source` and `id` a UserMessage requires',
      aSteerMessage !== null && aSteerMessage.hasSource === true && aSteerMessage.hasId === true,
      aSteerMessage,
    ),
    expect(
      's2: the turn did not die on the `source.kind` TypeError a missing `source` causes',
      aTurnEnd !== null && aTurnEnd?.reason?.kind !== 'error',
      { turnEndReason: aTurnEnd?.reason ?? null, notes: a?.notes ?? null },
    ),
    expect(
      's2: the adapter\'s steering message became a step, so the provider was called again',
      aProvider?.conversationCalls > 2,
      { conversationCalls: aProvider?.conversationCalls ?? null, stopping: aStopping.length },
    ),
    expect(
      's2: the real loop accepted the adapter\'s agent.steer and ran another step',
      aProvider?.conversationCalls > 2 && aTurnEnd?.reason?.kind === 'completed',
      { conversationCalls: aProvider?.conversationCalls ?? null, turnEndReason: aTurnEnd?.reason ?? null },
    ),

    // --- the control: the same rule, a well-formed message -------------------
    expect(
      's2: the real loop accepted a well-formed agent.steer and ran exactly one more step',
      cProvider?.conversationCalls === 3 && cStopping.length === 2,
      { conversationCalls: cProvider?.conversationCalls ?? null, stopping: cStopping.map((entry) => entry.providerConversationCalls) },
    ),
    expect(
      's2: the step count grew 2 -> 3 across the steer, and not further',
      cStopping[0]?.providerConversationCalls === 2 && cStopping[1]?.providerConversationCalls === 3,
      cStopping.map((entry) => entry.providerConversationCalls),
    ),
    expect(
      's2: the steering text the real loop accepted reached the model',
      Array.isArray(afterSteer?.userTexts) && afterSteer.userTexts.some((text) => text.includes('is still unconfirmed')),
      { userTexts: afterSteer?.userTexts ?? null, steerText: cSteer[0]?.reason ?? null },
    ),
    expect(
      's2: the real anti-loop rule suppressed a repeat of the same unresolved condition',
      cSteer.length === 2 && cSteer[0]?.steer === true && cSteer[1]?.steer === false && cSteer[1]?.repeated === true,
      cSteer,
    ),
    expect(
      's2: the real gate answered rather than hanging, so the steer was not a blind retry',
      cSteer[0]?.gateExitCode !== null && cSteer[0]?.gateExitCode !== 0,
      cSteer[0] ?? null,
    ),
    expect('s2: the claim is still pending after the turn', controlBoot.claimPending === true, { claimPending: controlBoot.claimPending ?? null, claimPath: controlBoot.claimPath ?? null }),
    expect('s2: the marker file the scripted tool wrote exists', controlBoot.markers?.s2 === true, controlBoot.markers ?? null),
    expect('s2: the control turn completed through the real loop', cTurnEnd?.reason?.kind === 'completed', cTurnEnd?.reason ?? null),
  ];
}

/**
 * S4 runs two boots for the same reason S2 does, and the split matters more
 * here. The two-phase completion check — verify, fail, steer, fix, verify,
 * confirm. Both phases are now reachable through the real adapter, because the
 * adapter's steering message is a complete `UserMessage`. So:
 *
 *   boot `s4-adapter`    mounts the real adapter and runs both phases: the gate
 *                        refuses the WRONG artifact, the adapter steers, the
 *                        artifact is corrected, and the gate confirms.
 *   boot `s4-wellformed` omits the adapter and steers from the scenario with the
 *                        same real `decideStop`, the same real claim and the same
 *                        real gate — the control that made the original defect
 *                        readable, kept as the discriminator between a broken loop
 *                        and a broken message.
 *
 * @param {Record<string, object>} boots
 * @param {object} shared
 */
export function checksForS4(boots, shared = {}) {
  const adapterBoot = boots?.['s4-adapter'] ?? {};
  const controlBoot = boots?.['s4-wellformed'] ?? {};
  const a = adapterBoot.scenario ?? null;
  const aVerify = a?.verify ?? [];
  const aTurnEnd = (a?.events?.turnEnds ?? [])[0] ?? null;
  const aFirst = aVerify[0] ?? null;

  const c = controlBoot.scenario ?? null;
  const cVerify = c?.verify ?? [];
  const cStopping = c?.turnStopping ?? [];
  const cSteer = c?.scenarioSteer ?? [];
  const cFirst = cVerify[0] ?? null;
  const cSecond = cVerify[1] ?? null;

  return [
    // --- the real verifier, observed through the real adapter ---------------
    expect(
      's4: the real verifier ran inside the real turn and did not confirm the WRONG artifact',
      aFirst !== null && aFirst.exitCode !== 0 && aFirst.artifactText === 'WRONG',
      aFirst,
    ),
    // This asserted the defect while it existed. The adapter now steers a complete
    // `UserMessage`, so the turn survives and both verifications run through the
    // real adapter — which is the path that was unreachable before.
    expect(
      's4: the turn survived the adapter\'s steer, so the second verification ran too',
      aTurnEnd !== null && aTurnEnd?.reason?.kind !== 'error' && aVerify.length === 2,
      { verifications: aVerify.length, turnEndReason: aTurnEnd?.reason ?? null },
    ),

    // --- the two-phase path, with a well-formed steer -----------------------
    expect('s4: the real verifier ran at both stop boundaries', cVerify.length === 2, cVerify),
    expect(
      's4: the first verification returned a not-confirmed verdict',
      cFirst !== null && cFirst.exitCode !== 0 && cFirst.reasonCode === 'criterion_failed',
      cFirst,
    ),
    expect('s4: the second verification returned a confirmed verdict', cSecond !== null && cSecond.exitCode === 0, cSecond),
    expect(
      's4: the snapshot digest changed between the two verifications',
      cFirst !== null && cSecond !== null && typeof cFirst.snapshotDigest === 'string' && cFirst.snapshotDigest !== cSecond.snapshotDigest,
      { first: cFirst?.snapshotDigest ?? null, second: cSecond?.snapshotDigest ?? null },
    ),
    expect('s4: the artifact content really changed from WRONG to CORRECT', cFirst?.artifactText === 'WRONG' && cSecond?.artifactText === 'CORRECT', { first: cFirst?.artifactText ?? null, second: cSecond?.artifactText ?? null }),
    expect(
      's4: the real Stop decision steered once after the failing verification and not after the passing one',
      cSteer.length === 2 && cSteer[0]?.steer === true && cSteer[0]?.gateExitCode !== 0 && cSteer[1]?.steer === false && cSteer[1]?.confirmed === true,
      cSteer,
    ),
    expect(
      's4: the step count grew 2 -> 4 across the two stops',
      cStopping.length === 2 && cStopping[0]?.providerConversationCalls === 2 && cStopping[1]?.providerConversationCalls === 4,
      cStopping.map((entry) => entry.providerConversationCalls),
    ),
    expect('s4: the provider was called 4 times (2 per artifact: write then stop)', controlBoot.provider?.conversationCalls === 4, controlBoot.provider?.conversationCalls ?? null),
    expect('s4: the claim was cleared once the gate confirmed', controlBoot.claimPending === false, { claimPending: controlBoot.claimPending ?? null, claimPath: controlBoot.claimPath ?? null }),
    expect('s4: the control turn completed through the real loop', (c?.events?.turnEnds ?? [])[0]?.reason?.kind === 'completed', (c?.events?.turnEnds ?? [])[0]?.reason ?? null),
  ];
}

/**
 * The checks for one set. Pure: it reads only the recorded observations.
 *
 * `boots` is a map from boot id to that boot's observations. Most sets run one
 * boot; S2 runs two, because it has to separate "the loop rejects steering" from
 * "the adapter's steering message is malformed", and one boot cannot hold both.
 *
 * @param {string} set - `s1`..`s5`.
 * @param {Record<string, {scenario: object, provider: object, markers: object, claimPending: boolean|null, claimPath: string|null}>} boots
 * @param {object} shared - runner-supplied facts (`repoRoot`).
 * @returns {{name: string, ok: boolean, detail: unknown}[]}
 */
export function checksForSet(set, boots, shared = {}) {
  const primary = boots?.[set] ?? Object.values(boots ?? {})[0] ?? {};
  const scenario = primary.scenario ?? null;
  const provider = primary.provider ?? null;
  const markers = primary.markers ?? {};
  const extra = { ...shared, claimPending: primary.claimPending ?? null, claimPath: primary.claimPath ?? null };
  const events = scenario?.events ?? {};
  const turnEnds = events.turnEnds ?? [];
  const steps = events.steps ?? [];
  const calls = provider?.calls ?? [];
  const checks = [];

  // The agent-scoped tool catalog. `ctx.tools.schemas(agent)` is the real
  // model-facing view, and the parent's measurement that a bare probe sees an
  // EMPTY catalog is the reason this is asserted inside an agent scope rather
  // than at boot: the global view is empty by design, the agent view is not.
  //
  // The six CAPABILITY tools are checked by name, not by counting `jev_*`: the
  // scenario plugin registers marker tools under the same prefix, so a count
  // would pass on the fixtures alone and say nothing about the product.
  const catalog = scenario?.catalog ?? null;
  const jevTools = Array.isArray(catalog?.jevTools) ? catalog.jevTools : [];
  const capabilityTools = jevTools.filter((tool) => JEV_TOOLS.includes(tool.name));
  checks.push(
    expect(
      `${set}: the agent-scoped tool catalog carries all six capability tools`,
      capabilityTools.length === JEV_TOOLS.length && JEV_TOOLS.every((name) => capabilityTools.some((tool) => tool.name === name)),
      catalog,
    ),
  );
  checks.push(
    expect(
      `${set}: every capability tool has a description and an object parameter schema`,
      capabilityTools.length === JEV_TOOLS.length && capabilityTools.every((tool) => tool.descriptionLength > 0 && tool.parametersType === 'object'),
      capabilityTools,
    ),
  );

  if (set === 's1') {
    const call = callNamed(events, 'jev_marker');
    const result = resultFor(events, call?.callId);
    checks.push(
      expect('s1: the scripted provider was called once per step (2)', provider?.conversationCalls === 2, { conversationCalls: provider?.conversationCalls, calls: calls.map((c) => c.label) }),
      expect('s1: the real loop logged the model-issued tool call', call !== null && String(call.arguments).includes('s1-marker'), call),
      expect('s1: the real loop logged a successful tool result for that call', result !== null && result.isError === false, result),
      expect('s1: the marker file the tool wrote exists', markers.s1 === true, markers),
      expect('s1: two steps ran (the tool-call step and the plain-text step)', steps.length === 2, steps),
      expect('s1: the turn completed through the real loop', turnEnds.length === 1 && turnEnds[0]?.reason?.kind === 'completed', turnEnds),
      expect('s1: the JEV adapter did not turn an ordinary turn into an error', !(events.toolResults ?? []).some((r) => r.isError === true), events.toolResults),
    );
  }

  if (set === 's2') {
    checks.push(...checksForS2(boots, shared));
    return checks;
  }

  if (set === 's3') {
    const approvals = events.approvals ?? [];
    const decisions = scenario?.approval?.decisions ?? [];
    const ok = approvals.find((entry) => entry.toolName === 'jev_gated_ok') ?? null;
    const no = approvals.find((entry) => entry.toolName === 'jev_gated_no') ?? null;
    const okResult = resultFor(events, callNamed(events, 'jev_gated_ok')?.callId);
    const noResult = resultFor(events, callNamed(events, 'jev_gated_no')?.callId);
    checks.push(
      expect('s3: the real approval service is mounted', scenario?.approval?.serviceMounted === true, scenario?.approval ?? null),
      expect('s3: the real approval service logged two ask/decide audit pairs', approvals.length === 2 && approvals.every((entry) => entry.outcome !== null), approvals),
      expect('s3: the approve decision was allowed-once', ok?.outcome === 'allowed-once', ok),
      expect('s3: the reject decision was rejected', no?.outcome === 'rejected', no),
      expect('s3: the answerer saw the same agent identity the loop used', decisions.length === 2 && decisions.every((d) => d.agentId === scenario?.agent?.id && d.agentId !== null), { decisions, agent: scenario?.agent ?? null }),
      expect('s3: the answerer saw the same session identity the loop used', decisions.length === 2 && decisions.every((d) => d.sessionId === scenario?.agent?.sessionId && d.sessionId !== null), { decisions, agent: scenario?.agent ?? null }),
      expect(
        's3: the ask carried the model-issued call id across the round trip',
        decisions.find((d) => d.toolName === 'jev_gated_ok')?.callId === 's3-call-ok' && decisions.find((d) => d.toolName === 'jev_gated_no')?.callId === 's3-call-no',
        decisions.map((d) => ({ toolName: d.toolName, callId: d.callId })),
      ),
      expect('s3: the approved tool ran and wrote its marker', markers.s3Approved === true && okResult?.isError === false, { marker: markers.s3Approved, result: okResult }),
      expect('s3: the rejected tool did not run and wrote no marker', markers.s3Rejected === false, { marker: markers.s3Rejected, result: noResult }),
      expect('s3: the rejection is visible as an error result naming the reason', noResult?.isError === true && /rejected/i.test(String(noResult?.text ?? '')), noResult),
      expect('s3: the turn completed through the real loop', turnEnds.length === 1 && turnEnds[0]?.reason?.kind === 'completed', turnEnds),
    );
  }

  if (set === 's4') {
    checks.push(...checksForS4(boots, shared));
    return checks;
  }

  if (set === 's5') {
    const route = scenario?.skillRoute ?? [];
    const byLabel = (label) => route.find((entry) => entry.label === label) ?? null;
    const auto = byLabel('auto');
    const none = byLabel('none');
    const explicit = byLabel('explicit');
    const filtered = byLabel('filtered');
    checks.push(
      expect('s5: the real jev_route_skill tool answered all four cases', route.length === 4 && route.every((entry) => entry.threw === undefined), route.map((entry) => ({ label: entry.label, threw: entry.threw ?? null }))),
      expect('s5: automatic routing recommends a real skill id', typeof auto?.recommended === 'string' && auto.recommended.length > 0 && auto.status === 'success', auto),
      expect('s5: the recommended skill exists in the skill root', skillFileExists(auto?.recommended, extra.repoRoot ?? REPO), { recommended: auto?.recommended ?? null, root: join(extra.repoRoot ?? REPO, 'skills') }),
      expect('s5: an explicit user choice wins unconditionally', explicit?.recommended === SKILL_CHOICE && explicit?.source === 'explicit', explicit),
      expect('s5: the session can really load the skill the router named', explicit?.load?.ok === true && typeof explicit?.load?.path === 'string', explicit?.load ?? null),
      expect('s5: the loaded skill body is non-empty', Number(explicit?.load?.contentLength) > 0, explicit?.load ?? null),
      expect('s5: an unknown explicit name abstains instead of inventing a skill', none?.recommended === null && none?.source === 'none' && none?.explicitSkillExists === false, none),
      expect(
        's5: the deterministic tool filter is inert on this catalog, because no skill declares `requires`',
        filtered?.recommended === auto?.recommended && filtered?.excludedLength === 0,
        { filtered: filtered ?? null, auto: auto?.recommended ?? null },
      ),
      expect(
        's5: the router declares that blind spot in its own limits rather than hiding it',
        Array.isArray(filtered?.limits) && filtered.limits.some((limit) => /declared requires/i.test(String(limit))),
        filtered?.limits ?? null,
      ),
      expect('s5: the turn completed through the real loop', turnEnds.length === 1 && turnEnds[0]?.reason?.kind === 'completed', turnEnds),
    );
  }

  return checks;
}

// --- environment -------------------------------------------------------------

function findDshEntry() {
  const explicit = process.env.JEV_DSH_ENTRY;
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return null;
}

function harnessFacts(entry) {
  const root = resolve(dirname(entry), '..');
  const facts = { entry, root, version: null, node: process.version };
  try {
    facts.version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  } catch {
    /* version stays null and the report says so */
  }
  return facts;
}

// --- overlay -----------------------------------------------------------------

function yamlRow(id, name, config) {
  const lines = [`    - id: ${id}`, `      name: '${name}'`];
  if (config && Object.keys(config).length > 0) {
    lines.push('      config:');
    for (const [key, value] of Object.entries(config)) {
      if (Array.isArray(value)) {
        lines.push(`        ${key}:`);
        for (const item of value) {
          const entries = Object.entries(item);
          lines.push(`          - ${entries[0][0]}: ${JSON.stringify(entries[0][1])}`);
          for (const [k, v] of entries.slice(1)) lines.push(`            ${k}: ${JSON.stringify(v)}`);
        }
      } else {
        lines.push(`        ${key}: ${JSON.stringify(value)}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * The overlay: the model and the scenario, the real adapter row, the real tool
 * rows, the model route repointed at the scripted provider, and the DeepSeek
 * route disabled.
 *
 * `mountAdapter` exists for S2's control boot. The adapter's own Stop handler is
 * the only steering producer in the composition, so a boot that needs to observe
 * a DIFFERENT steering producer has to leave it out; otherwise the malformed
 * message aborts the turn before the control can run.
 *
 * The DeepSeek row is disabled rather than left to fail on a missing key. It is
 * not merely non-fatal: with no adapter registered for it and nothing selecting
 * it, the route is unused, and leaving it mounted only adds a credential error
 * to every boot that a reader has to be told to ignore. Disabling it makes the
 * boot output honest — there is no credential because none is needed.
 */
function overlayFor({ mountAdapter = true } = {}) {
  const rows = [
    '- insert:',
    yamlRow('jev-scripted-provider', pathToFileURL(join(ADAPTERS, 'scripted-provider.mjs')).href, {}),
    yamlRow('jev-agent-scenarios', pathToFileURL(join(ADAPTERS, 'agent-scenarios.mjs')).href, {}),
  ];
  if (mountAdapter) {
    rows.push(yamlRow('jev-adapter', pathToFileURL(join(ADAPTERS, 'plugin.mjs')).href, { mode: 'enforce', policy: 'ask', maxSteers: 2, rules: [] }));
  } else {
    rows.push('# The JEV adapter is deliberately absent in this boot: see `checksForS2`.');
  }
  rows.push(
    yamlRow('jev-tools', pathToFileURL(join(ADAPTERS, 'tools.mjs')).href, {}),
    '',
    '# The model route the one-shot driver reads. Without this the profile would',
    '# select deepseek-official and the scripted provider would never be called.',
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    `    provider: ${PROVIDER_ID}`,
    `    model: ${MODEL_ID}`,
    '',
    '# No credential is needed anywhere in this composition, so the route that',
    '# would demand one is disabled instead of failing loudly and harmlessly.',
    '- id: llm-deepseek',
    '  disabled: true',
    '',
  );
  return rows.join('\n');
}

// --- one boot ----------------------------------------------------------------

/** Boot the harness, bounded, and make sure nothing survives the bound. */
function runBoot(entry, args, { env, cwd, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [entry, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      // The harness starts child processes of its own; kill the tree, or the
      // next set inherits a port, a lock, or a stale runner.
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, timeoutMs);
    const settle = (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({ exitCode, signal, stdout, stderr, timedOut });
    };
    child.on('error', (error) => {
      stderr += `\nspawn error: ${String(error?.message ?? error)}`;
      settle(null, null);
    });
    child.on('close', (exitCode, signal) => settle(exitCode, signal));
  });
}

/**
 * The boot plan for one set. Most sets need one boot; S2 needs two, and the
 * reason is in `checksForS2`.
 */
export function bootsFor(setName) {
  if (setName === 's2' || setName === 's4') {
    return [
      { id: `${setName}-adapter`, mountAdapter: true, env: { JEV_STEER_MODE: 'adapter' } },
      { id: `${setName}-wellformed`, mountAdapter: false, env: { JEV_STEER_MODE: 'scenario' } },
    ];
  }
  return [{ id: setName, mountAdapter: true, env: {} }];
}

/** Run one boot of one set and read back everything it left behind. */
async function runBootPlan(setName, plan, options) {
  const scratch = join(options.root, `run-${setName}`, plan.id);
  const project = join(scratch, 'project');
  mkdirSync(project, { recursive: true });

  // The harness's own skill provider discovers `<project>/.dsh/skills`. Copying
  // the repository catalog there is what makes "the skill the router named" also
  // "the skill the session can load" — otherwise S5 could only assert that a
  // file the router itself read exists, which would be the router agreeing with
  // itself.
  try {
    cpSync(join(REPO, 'skills'), join(project, '.dsh', 'skills'), { recursive: true });
  } catch {
    /* S5 records the resulting load failure rather than hiding it */
  }

  const scenarioOut = join(scratch, 'scenario.json');
  const providerOut = join(scratch, 'provider.json');
  const overlay = join(scratch, 'overlay.yml');
  writeFileSync(overlay, overlayFor({ mountAdapter: plan.mountAdapter }), 'utf8');

  const env = {
    ...process.env,
    DSH_HOME: options.home,
    JEV_SET: setName,
    JEV_SCENARIO_DIR: scratch,
    JEV_SCENARIO_OUT: scenarioOut,
    JEV_SCRIPT_PATH: join(scratch, 'script.json'),
    JEV_PROVIDER_OUT: providerOut,
    JEV_PROVIDER_ID: PROVIDER_ID,
    JEV_MODEL_ID: MODEL_ID,
    JEV_PROJECT_DIR: project,
    JEV_SKILL_CHOICE: SKILL_CHOICE,
    JEV_DSH_MODE: 'enforce',
    JEV_DSH_POLICY: 'ask',
    JEV_DSH_GATE_ARGS: '--offline --no-journal',
    // Keep every boot's claim state apart, so no scenario can pass on another
    // scenario's leftovers.
    JEV_DSH_STATE: join(scratch, 'state'),
    ...plan.env,
  };

  const started = Date.now();
  const boot = await runBoot(options.entry, ['--profile', options.profile, '--patch', overlay, 'probe'], {
    env,
    cwd: project,
    timeoutMs: options.timeoutMs,
  });

  let scenario = null;
  let provider = null;
  let parseError = null;
  try {
    if (existsSync(scenarioOut)) scenario = JSON.parse(readFileSync(scenarioOut, 'utf8'));
  } catch (error) {
    parseError = String(error?.message ?? error);
  }
  try {
    if (existsSync(providerOut)) provider = JSON.parse(readFileSync(providerOut, 'utf8'));
  } catch (error) {
    parseError = parseError ?? String(error?.message ?? error);
  }

  let claimPending = null;
  if (scenario?.claim?.sessionId) {
    try {
      claimPending = readClaim({ sessionId: scenario.claim.sessionId, env }) !== null;
    } catch {
      claimPending = null;
    }
  }

  return {
    id: plan.id,
    scratch,
    project,
    env,
    durationMs: Date.now() - started,
    bootTimedOut: boot.timedOut,
    bootExit: boot.exitCode,
    bootStderrTail: boot.stderr.slice(-800),
    credentialWarning: /MISSING_CREDENTIAL/.test(boot.stderr),
    scenario,
    provider,
    parseError,
    claimPending,
    claimPath: scenario?.claim?.claimPath ?? null,
    markers: {
      s1: existsSync(join(scratch, 's1-marker.marker')),
      s2: existsSync(join(scratch, 's2-marker.marker')),
      s3Approved: existsSync(join(scratch, 's3-approved.marker')),
      s3Rejected: existsSync(join(scratch, 's3-rejected.marker')),
      s4: existsSync(join(scratch, 's4-artifact.marker')),
    },
  };
}

async function runSet(setName, options) {
  const plans = bootsFor(setName);
  const ran = [];
  for (const plan of plans) ran.push(await runBootPlan(setName, plan, options));

  const result = {
    set: setName,
    durationMs: ran.reduce((total, one) => total + one.durationMs, 0),
    boots: ran.map((one) => ({
      id: one.id,
      bootExit: one.bootExit,
      bootTimedOut: one.bootTimedOut,
      providerCalls: one.provider?.conversationCalls ?? null,
      turnEndReason: (one.scenario?.events?.turnEnds ?? [])[0]?.reason?.kind ?? null,
      ...(one.parseError ? { parseError: one.parseError } : {}),
    })),
    bootTimedOut: ran.some((one) => one.bootTimedOut),
    bootExit: ran[0]?.bootExit ?? null,
    bootStderrTail: ran.map((one) => one.bootStderrTail).filter(Boolean).join('\n---\n').slice(-1200),
    credentialWarning: ran.some((one) => one.credentialWarning),
    checks: [],
    failures: [],
  };

  // The primary boot is the one named after the set; S2's diagnosis also reads
  // its control boot, which `checksForS2` reaches for by name.
  const primary = ran.find((one) => one.id === setName) ?? ran[0];
  result.observations = primary.scenario;

  const boots = {};
  for (const one of ran) boots[one.id] = { scenario: one.scenario, provider: one.provider, markers: one.markers, claimPending: one.claimPending, claimPath: one.claimPath };

  // Infrastructure classes are judged per boot, so a control boot that failed to
  // start cannot be mistaken for an assertion about the adapter.
  const infraBoot = ran.find((one) => failureClass({ bootTimedOut: one.bootTimedOut, scenario: one.scenario, provider: one.provider }) !== null) ?? null;
  const infra = infraBoot ? failureClass({ bootTimedOut: infraBoot.bootTimedOut, scenario: infraBoot.scenario, provider: infraBoot.provider }) : null;

  // S3 is the one set with a documented escape hatch: if the real approval
  // service cannot be driven non-interactively, the honest answer is
  // `blocked-by-interface` with the evidence, never a fabricated pass.
  if (setName === 's3' && infra === null && primary.scenario?.approval?.serviceMounted === false) {
    result.class = 'blocked-by-interface';
    result.failures = [
      expect('s3: the real approval service is mounted', false, {
        evidence: 'ctx.get("approval") was undefined at scenario mount',
        scenarioApproval: primary.scenario.approval,
      }),
    ];
    result.checks = result.failures;
    result.manualScenario =
      'Register a second answerer for `approval/request` in the profile and re-run: node scripts/jev-agent-acceptance.mjs --set s3 --keep';
    return result;
  }

  if (infra !== null) {
    result.class = infra;
    result.failures = [
      expect(`the set was actually driven (${infra})`, false, {
        boot: infraBoot.id,
        bootExit: infraBoot.bootExit,
        bootTimedOut: infraBoot.bootTimedOut,
        stderrTail: infraBoot.bootStderrTail,
      }),
    ];
    result.checks = result.failures;
    return result;
  }

  const checks = checksForSet(setName, boots, { repoRoot: REPO });
  result.checks = checks;
  result.failures = checks.filter((check) => !check.ok);
  result.class = result.failures.length === 0 ? 'held' : 'assertion-failed';

  // Two facts the product acceptance needs to place each capability on its ladder,
  // kept separate because they are not the same fact:
  //
  //   `catalog`  the tool was in a REAL agent's model-facing catalog. This proves
  //              registration reached the model, and nothing about use.
  //   `invoked`  a real loop actually dispatched a call to the tool. This is the
  //              only thing that can lift a capability to `runtime-tested`.
  //
  // Collapsing them would let a tool that was merely present be reported as one
  // that ran — the pass-counter substitution the product report exists to avoid.
  if (setName === 's5') {
    const catalogScenario = (boots?.['s5'] ?? Object.values(boots ?? {})[0] ?? {}).scenario ?? null;
    if (catalogScenario?.catalog) {
      result.catalog = {
        present: [...(catalogScenario.catalog.names ?? [])],
        jevTools: (catalogScenario.catalog.jevTools ?? []).map((tool) => ({
          name: tool.name,
          descriptionLength: tool.descriptionLength,
          parametersType: tool.parametersType,
        })),
      };
    }
  }
  result.invoked = [...new Set(ran.flatMap((one) => (one.scenario?.events?.toolCalls ?? []).map((call) => call.name)))].sort();
  // Tools the real registry executed on any route: model-issued calls, plus the
  // scenario's own `ctx.tools.execute`. Kept apart from `invoked` because the model
  // choosing a tool and the harness running it are different evidence.
  result.executed = [
    ...new Set([
      ...result.invoked,
      ...ran.flatMap((one) => (one.scenario?.skillRoute ?? []).filter((row) => typeof row?.tool === 'string' && row.threw === undefined).map((row) => row.tool)),
    ]),
  ].sort();

  // Record, at the set level, whether the REAL adapter's own path reached a
  // completed turn. For s2 and s4 the answer is no, and it must not be hidden
  // behind a `held` that is really a statement about the control boot.
  const adapterBoot = ran.find((one) => one.id === `${setName}-adapter`) ?? null;
  if (adapterBoot) {
    const reason = (adapterBoot.scenario?.events?.turnEnds ?? [])[0]?.reason ?? null;
    if (reason?.kind !== 'completed') {
      result.adapterPathBlocked = true;
      result.adapterPathBlockedReason = `the real adapter's turn ended as "${reason?.kind ?? 'unknown'}"${reason?.error?.message ? `: ${reason.error.message}` : ''}`;
    }
  }
  return result;
}

// --- main --------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const flag = (name, fallback = null) => {
    const index = argv.indexOf(`--${name}`);
    return index > -1 ? argv[index + 1] ?? true : fallback;
  };
  const asJson = argv.includes('--json');
  const keep = argv.includes('--keep');
  const only = flag('set', 'all');
  const timeoutMs = Number(flag('timeout-ms', 120_000));

  const entry = findDshEntry();
  if (!entry) {
    const report = { verdict: 'not-driven', exitCode: 3, mode: MODE, class: 'harness-not-found' };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 3;
    return report;
  }

  const facts = harnessFacts(entry);
  // The scratch root is ALWAYS outside the repository, including under `--keep`.
  // A kept run inside the repo is not merely untidy: the harness resolves its
  // skill roots from the enclosing project, so a project directory nested under
  // the repository silently changes which `.dsh/skills` is discovered and makes
  // a kept run observe something a normal run does not.
  const root = mkdtempSync(join(tmpdir(), keep ? 'jev-agent-acc-keep-' : 'jev-agent-acc-'));
  mkdirSync(root, { recursive: true });

  const home = join(root, 'dsh-home');
  const profile = 'jev-agent';
  const profileBuild = await runBoot(entry, ['--profile', profile, '--from-default-profile', 'headless', '--dump-config'], {
    env: { ...process.env, DSH_HOME: home },
    cwd: root,
    timeoutMs,
  });
  if (!existsSync(join(home, 'profiles', profile, 'cordis.yml'))) {
    const report = {
      verdict: 'not-driven',
      exitCode: 3,
      mode: MODE,
      class: 'profile-not-created',
      bootExit: profileBuild.exitCode,
      stderrTail: profileBuild.stderr.slice(-800),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 3;
    return report;
  }

  const names = only === 'all' ? SETS : SETS.filter((name) => name === only);
  const results = [];
  for (const name of names) results.push(await runSet(name, { root, entry, timeoutMs, home, profile }));

  const verdict = verdictOf(results);
  const exitCode = exitCodeOf(verdict);
  // A set can hold its own assertions and still not be reachable end to end
  // through the real adapter. That has to be visible at the top level, or a
  // green `held` would read as "the adapter works", which is the one thing this
  // runner must never imply.
  const blockedPaths = results
    .filter((result) => result.adapterPathBlocked === true)
    .map((result) => ({ set: result.set, reason: result.adapterPathBlockedReason ?? 'the real adapter path did not complete' }));
  const report = {
    verdict,
    exitCode,
    harnessVersion: facts.version,
    nodeVersion: facts.node,
    mode: MODE,
    label:
      'real-agent-loop/scripted-provider — proves the mechanism (the real loop, the real steering, the real approval service), NOT model quality; the model is a scripted JSON file.',
    harness: { entry: facts.entry, version: facts.version },
    credentialWarning: results.some((result) => result.credentialWarning === true),
    // The real agent-scoped catalog, and the tools a real loop actually invoked.
    // `present` is what the model could see; `invoked` is what it used.
    catalog: results.find((result) => result.catalog)?.catalog ?? null,
    invoked: [...new Set(results.flatMap((result) => result.invoked ?? []))].sort(),
    executed: [...new Set(results.flatMap((result) => result.executed ?? []))].sort(),
    blockedPaths,
    sets: results.map((result) => ({
      set: result.set,
      class: result.class,
      durationMs: result.durationMs,
      bootExit: result.bootExit,
      bootTimedOut: result.bootTimedOut,
      boots: result.boots,
      checks: result.checks,
      failures: result.failures,
      ...(result.adapterPathBlocked ? { adapterPathBlocked: true, adapterPathBlockedReason: result.adapterPathBlockedReason } : {}),
      ...(result.manualScenario ? { manualScenario: result.manualScenario } : {}),
      ...(result.class === 'held' ? {} : { bootStderrTail: result.bootStderrTail }),
    })),
    scratch: root,
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const lines = [];
    lines.push(`jev-gates DSH real-agent-loop acceptance — ${verdict.toUpperCase()}`);
    lines.push(`mode: ${MODE}`);
    lines.push('This proves the mechanism, not model quality: the model is a scripted JSON file.');
    lines.push(`harness ${facts.version ?? '(unknown version)'} on node ${facts.node}`);
    lines.push('');
    for (const result of report.sets) {
      const mark = result.class === 'held' ? 'PASS' : result.class === 'assertion-failed' ? 'FAIL' : 'NOT DRIVEN';
      lines.push(`[${mark}] ${result.set} (${result.class}, ${result.durationMs} ms, bootExit=${result.bootExit})`);
      for (const check of result.checks ?? []) lines.push(`    ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}`);
      if (result.class !== 'held' && result.class !== 'assertion-failed') lines.push(`    class=${result.class} bootExit=${result.bootExit}`);
      if (result.manualScenario) lines.push(`    manual: ${result.manualScenario}`);
    }
    lines.push('');
    lines.push(`DeepSeek credential warning present in any boot: ${report.credentialWarning}`);
    if (report.blockedPaths.length > 0) {
      lines.push('');
      lines.push('Paths the real adapter could not complete (the mechanism was proven only via the control boot):');
      for (const blocked of report.blockedPaths) lines.push(`    ${blocked.set}: ${blocked.reason}`);
    }
    lines.push(`scratch: ${root}${keep ? ' (kept)' : ''}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  if (!keep) rmSync(root, { recursive: true, force: true });
  process.exitCode = exitCode;
  return report;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ verdict: 'not-driven', class: 'runner-crashed', mode: MODE, error: String(error?.stack ?? error), exitCode: 3 }, null, 2)}\n`);
    process.exitCode = 3;
  });
}
