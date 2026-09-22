# DSH runtime findings — hooks, approval, events (installed build 0.1.5-rc.2)

Read-only investigation of the **installed** DeepSeek Harness on Windows.

- Install root: `C:\Users\katoc\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`
- Nested packages: `C:\Users\katoc\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
  (found; 250+ `dsh-*` packages, including `dsh-hooks-claude-code`, `dsh-hooks-codex`, `dsh-hook-protocol`, `dsh-user-approval`)
- `DSH_HOME` = `C:\Users\katoc\.dsh` (confirmed from the live env: `DSH_HOME=C:\Users\katoc\.dsh`, `DSH_WEB_URL=http://127.0.0.1:3080`)
- Version `0.1.5-rc.2` confirmed: `dsh\package.json:55-56` pins `"@deepseek-ai/dsh-hooks-claude-code": "^0.1.5-rc.2"`, `"@deepseek-ai/dsh-hooks-codex": "^0.1.5-rc.2"`

Nothing was modified. No DSH process was started. No network call was made. Secret files were not opened.

Notation: `VERIFIED` = found in code in this build. `NOT FOUND` = searched, absent.
`MEASURED` = observed in a running harness (§13). `RETRACTED` = a claim withdrawn because the
instrument, not the harness, produced it (§13.0).

---

## 1. PreToolUse — how a call is blocked, exit codes, JSON fields

**VERDICT: VERIFIED**

### 1.1 The extension point

The Claude Code bridge listens on the harness waterfall `tools/pre-execute`:

`dsh-hooks-claude-code/lib/index.js:248-264`
```js
	ctx.on("tools/pre-execute", async (exec, next) => {
		const turn = lastTurn(ctx, exec.agent);
		const merged = await runPoint("PreToolUse", exec.name, preToolPayload(exec), {
			...exec.agent ? { agent: exec.agent } : {},
			turn,
			signal: exec.signal
		});
		if (merged.decision === "deny") return {
			kind: "deny",
			reason: merged.reason ?? "blocked by PreToolUse hook"
		};
		if (merged.decision === "ask") return {
			kind: "ask",
			...merged.reason !== void 0 ? { reason: merged.reason } : {}
		};
		return next();
	});
```

So the bridge maps the folded hook outcome onto the harness decision type:

`dsh-tools/lib/types/index.d.ts:419-427`
```ts
export type PreToolDecision = {
    kind: 'allow';
} | {
    kind: 'deny';
    reason: string;
} | {
    kind: 'ask';
    reason?: string;
};
```

The registry consumes it here — `deny` materializes an error result and **never dispatches** the tool:

`dsh-tools/lib/index.js:3116-3139`
```js
			const carrier = scopeTarget(this, exec.agent);
			const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
			const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : {
				decision: gate,
				approvalCancelled: false
			};
			const { decision } = askResolution;
			...
			const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
			if (denialReason !== void 0) return await next({
				kind: "post-result",
				exec,
				result: this.materializeFinalResult({
					content: [{
						type: "text",
						text: `Error: ${denialReason}`
					}],
					isError: true,
					error: { message: denialReason }
				})
			});
```

Note `"allow"` is **not** a pre-approval: a later monotonic guard can still deny it (`decision.kind === "allow" ? this.guardReason(exec) : ...`).

### 1.2 Exit codes

`dsh-hook-protocol/lib/index.js:56-62`
```js
/**
* Decode hook process outcomes for both dialects. Exit 0 may carry structured
* JSON or plain stdout; exit 2 blocks with stderr as the reason; every other
* exit is a non-blocking error. Bridges decide which recognized fields apply.
...
/** The exit code a hook uses to signal a blocking error (stderr → model). */
const BLOCKING_EXIT_CODE = 2;
```

`dsh-hook-protocol/lib/index.js:110-124`
```js
	if (exitCode === BLOCKING_EXIT_CODE) {
		output.decision = "block";
		if (trimmedErr.length > 0) output.reason = trimmedErr;
	}
	if (exitCode === 0) {
		if (trimmedOut.startsWith("{")) {
			let parsed;
			try {
				parsed = obj(JSON.parse(trimmedOut));
			} catch {
				parsed = void 0;
			}
			if (parsed) applyStructured(output, parsed, expectedEventName);
		}
	}
	return output;
```

| exit | meaning in this build |
|---|---|
| `2` | **blocks.** `output.decision = "block"`; stderr (trimmed) becomes the `reason`. No stdout is parsed on exit 2. |
| `0` | **not blocking by itself.** stdout is parsed as JSON **only if** the trimmed stdout starts with `{`; otherwise plain stdout is recorded and ignored. |
| any other (`1`, `3`, …) | non-blocking error. No decision is derived; `exitCode`/`stdout`/`stderr` are recorded only. `parseHookOutput` never throws. |
| `undefined` | spawn/infrastructure failure — `dsh-hook-protocol/lib/index.js:205-210` returns an outcome with no exit code and the error message as stderr. |

### 1.3 JSON on stdout — exactly which fields

`dsh-hook-protocol/lib/index.js:133-158`
```js
function applyStructured(output, parsed, expectedEventName) {
	const cont = bool(parsed, "continue");
	if (cont !== void 0) output.continue = cont;
	const stopReason = str(parsed, "stopReason");
	if (stopReason !== void 0) output.stopReason = stopReason;
	const sysMsg = str(parsed, "systemMessage");
	if (sysMsg !== void 0) output.systemMessage = sysMsg;
	const topDecision = topLevelDecisionOf(str(parsed, "decision"));
	if (topDecision !== void 0) output.decision = topDecision;
	const topReason = str(parsed, "reason");
	if (topReason !== void 0) output.reason = topReason;
	const hso = obj(parsed.hookSpecificOutput);
	if (hso) {
		const eventName = str(hso, "hookEventName");
		if (eventName !== void 0) output.hookEventName = eventName;
		if (expectedEventName !== void 0 && eventName !== expectedEventName) return;
		const permission = permissionDecisionOf(str(hso, "permissionDecision"));
		if (permission !== void 0) output.decision = permission;
		const permissionReason = str(hso, "permissionDecisionReason");
		if (permissionReason !== void 0) output.reason = permissionReason;
		const addCtx = str(hso, "additionalContext");
		if (addCtx !== void 0) output.additionalContext = addCtx;
		const updated = obj(hso, "updatedInput");
		if (updated !== void 0) output.updatedInput = updated;
	}
}
```

Recognized fields:

- top level: `continue` (boolean), `stopReason` (string), `systemMessage` (string), `decision`, `reason`
- `hookSpecificOutput.hookEventName` (string)
- `hookSpecificOutput.permissionDecision` — **only** `allow` | `deny` | `ask`
- `hookSpecificOutput.permissionDecisionReason` (string) → becomes `reason`
- `hookSpecificOutput.additionalContext` (string)
- `hookSpecificOutput.updatedInput` (object) — **parsed but NOT honored**

The top-level `decision` vocabulary is narrow and `deny` is deliberately invalid there:

`dsh-hook-protocol/lib/index.js:77-89`
```js
/**
* The legacy TOP-LEVEL `decision` is only `approve`/`block` in both reference
* schemas — `allow`/`deny`/`ask` are reserved for `hookSpecificOutput.
* permissionDecision`. So an out-of-band `{"decision":"deny"}` is invalid and
* ignored here (it must not become a real blocking decision).
*/
function topLevelDecisionOf(value) {
	return value === "approve" || value === "block" ? value : void 0;
}
/** A `hookSpecificOutput.permissionDecision` is `allow`/`deny`/`ask` only. */
function permissionDecisionOf(value) {
	return value === "allow" || value === "deny" || value === "ask" ? value : void 0;
}
```

**So `{"decision":"deny"}` on stdout is silently ignored.** To deny from PreToolUse you must use `hookSpecificOutput.permissionDecision: "deny"`, or exit 2.

### 1.4 `hookEventName` expectation

The expected name is the **firing hook point** — the bridge passes `expectedEventName: point`, and `point` is the literal `"PreToolUse"` for this listener:

`dsh-hooks-claude-code/lib/index.js:189`
```js
					expectedEventName: point
```

A `hookSpecificOutput` block whose `hookEventName` is missing or different has its event-scoped fields **discarded** (`permissionDecision`, `permissionDecisionReason`, `additionalContext`, `updatedInput`), while top-level fields survive:

`dsh-hook-protocol/lib/index.js:148`
```js
		if (expectedEventName !== void 0 && eventName !== expectedEventName) return;
```

### 1.5 Fold across multiple hooks: `deny > ask > allow`

`dsh-hook-protocol/lib/index.js:214-240`
```js
/**
* Merge matched hooks into one most-restrictive outcome. Permission precedence
* is `deny > ask > allow`; the first `continue:false` stop is sticky; reasons
* for the winning rank are joined; and context and system messages accumulate
* in hook order.
...
function rank(decision) {
	switch (decision) {
		case "deny":
		case "block": return 3;
		case "ask": return 2;
		case "approve":
		case "allow": return 1;
		default: return 0;
	}
}
```

`block` (exit 2) and `deny` share rank 3 and collapse to `deny` (`decisionForRank`, `dsh-hook-protocol/lib/index.js:233-240`).

### 1.6 The PreToolUse stdin payload

`dsh-hooks-claude-code/lib/index.js:347-374`
```js
function base(agent, event) {
	return {
		session_id: agent?.session.header.id ?? "",
		transcript_path: "",
		cwd: agent?.session.header.cwd ?? process.cwd(),
		hook_event_name: event
	};
}
...
function preToolPayload(exec) {
	return {
		...base(exec.agent, "PreToolUse"),
		tool_name: exec.name,
		tool_input: exec.arguments,
		tool_use_id: exec.callId
	};
}
```

`transcript_path` is always the empty string. `tool_use_id` is the harness `callId`.

### 1.7 Known gaps (documented, not inferred)

`dsh-hooks-claude-code/README.md:177`
```
- **`PreToolUse` is partial** — `deny` and `ask` decisions work; `allow` does not pre-approve, `defer` is unsupported, `additionalContext` is ignored, and `updatedInput` is logged + warned but not honored
```

Confirmed in code — `updatedInput` is warned and dropped:

`dsh-hooks-claude-code/lib/index.js:192-193`
```js
				if (output.updatedInput !== void 0) ctx.logger.warn(`hooks-claude-code: ${point} hook requested updatedInput, which is not yet honored (ignored)`);
				if (output.systemMessage !== void 0) ctx.logger.warn(`hooks-claude-code: ${point} hook emitted a systemMessage, which is not yet surfaced (ignored)`);
```

---

## 2. "Ask the human", and what `approval policy = never` does

**VERDICT: VERIFIED**

### 2.1 Yes — a PreToolUse hook can ask

`hookSpecificOutput.permissionDecision: "ask"` → `merged.decision === "ask"` → bridge returns `{ kind: "ask", reason? }` (`dsh-hooks-claude-code/lib/index.js:259-262`, quoted in §1.1) → the registry routes it through the approval seam:

`dsh-tools/lib/index.js:3117-3120`
```js
			const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : {
				decision: gate,
				approvalCancelled: false
			};
```

### 2.2 The `never` branch — automatic DENY, not allow, not an error

`dsh-user-approval/lib/index.js:175-179`
```js
	async decide(req, session) {
		const signal = req.signal;
		if (signal?.aborted) return "cancelled";
		if (this.effectivePolicy(session) === "never") return "rejected";
		const answer = Promise.resolve().then(() => this.ctx.waterfall(scopeTarget(req.agent, req.agent), "approval/request", req, () => Promise.resolve("unavailable"))).then((outcome) => OUTCOMES.includes(outcome) ? outcome : "unavailable", () => "unavailable");
```

The `never` check is **before** the `approval/request` waterfall — so with policy `never` no answerer is ever consulted; the outcome is the literal `"rejected"`. The service definition states the vocabulary:

`dsh-user-approval/lib/index.js:29-39`
```js
const OUTCOMES = [
	"allowed-once",
	"rejected",
	"cancelled",
	"unavailable"
];
/** Every {@link ApprovalPolicy}, for option advertisement and runtime validation of untrusted policy strings. */
const APPROVAL_POLICIES = ["ask", "never"];
/** Model-facing statement for the deterministic `'never'` policy. */
const NEVER_SENTENCE = "Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).";
```

`"rejected"` is mapped to a **deny** by the tool registry:

`dsh-tools/lib/index.js:3342-3348`
```js
			case "rejected": return {
				decision: {
					kind: "deny",
					reason: `the user rejected tool "${exec.name}"`
				},
				approvalCancelled: false
			};
```

**Consequence:** under policy `never`, a PreToolUse `ask` becomes a hard deny whose model-visible reason is `the user rejected tool "<name>"` — even though no human was ever asked. The reason string is misleading in this branch.

### 2.3 Other fail-closed paths (all deny)

`dsh-tools/lib/index.js:3303-3329`
```js
	* Resolve an `ask` decision to allow/deny through the approval seam. The
	* seam is consumed opportunistically with `ctx.get('approval')` — a
	* deployment that composes no ApprovalService keeps the historical degrade
	* to deny, and an unmount mid-session degrades the same way on the next ask.
	* An agent-less execution also degrades: without an agent there is no
	* session to audit to and no UI to route to. Otherwise the outcome maps
	* one-to-one — `allowed-once` proceeds; the three non-grants deny with
	* distinct reasons so the model can tell a human "no" from an absent
	* approval channel.
	*/
	async serviceAsk(exec, ask) {
		const approval = this.ctx.get("approval");
		if (approval === void 0) return {
			decision: {
				kind: "deny",
				reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)`
			},
			approvalCancelled: false
		};
		if (exec.agent === void 0) return {
			decision: {
				kind: "deny",
				reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through`
			},
			approvalCancelled: false
		};
```

`"allowed-once"` is the only grant (`dsh-tools/lib/index.js:3338-3341`); `"cancelled"` denies with `approval for tool "<name>" was cancelled` and sets `approvalCancelled: true` (3349-3355); `"unavailable"` denies with `requires approval, but no approval channel is available` (3356-3362).

### 2.4 Audit trail is still written under `never`

`dsh-user-approval/lib/index.js:131-147`
```js
	async request(req) {
		const session = req.agent.session;
		if (!hasOpenTurn(session)) throw new Error("approval.request() outside an open turn: ...");
		const id = ApprovalRequestId(randomUUID());
		session.append("approval/asked", {
			id,
			toolName: req.toolName,
			...req.callId !== void 0 ? { callId: req.callId } : {},
			...req.reason !== void 0 ? { reason: req.reason } : {}
		});
		const outcome = await this.decide(req, session);
		session.append("approval/decided", {
			id,
			outcome
		});
		return outcome;
	}
```

So the durable log still gets the `approval/asked` + `approval/decided{outcome:"rejected"}` pair under `never`. A request outside an open turn throws (the audit pair must be turn-enclosed).

### 2.5 This session

The live runtime context for the session under investigation states approval prompts are disabled, matching `NEVER_SENTENCE` verbatim — i.e. this session runs with `approval policy = never`. **VERIFIED** for the policy text; the per-session override is stored as an `approval/policy` session event:

`dsh-user-approval/lib/index.js:63-66`
```js
function setApprovalPolicy(session, policy) {
	if (!APPROVAL_POLICIES.includes(policy)) throw new TypeError("approval policy must be one of \"ask\" or \"never\"");
	session.append("approval/policy", { policy });
}
```

---

## 3. PostToolUse — runs after the tool, cannot undo the side effect

**VERDICT: VERIFIED**

### 3.1 It runs after execution

`tools/post-execute` is a waterfall dispatched from the registry's finalize stage:

`dsh-tools/lib/index.js:3366-3388`
```js
	* Run the `tools/post-execute` waterfall over a dispatched `result` and apply
	* its {@link PostToolDecision}: `accept` keeps the call successful (replacing
	* `content` when given), `block` turns it into an `isError` whose content is
	* the corrective `feedback`. Either decision may attach `additionalContexts`,
	* which are ferried on the returned result for the loop's active-batch FIFO.
	* Context deferred by the tool body survives an accepted result but is
	* discarded when the outer call is blocked; a block exposes only context the
	* blocking decision explicitly supplied.
	* Runs inside `execute`'s outer try/catch (a throwing listener → isError).
	*/
	async postExecute(exec, result) {
		const decision = await this.ctx.waterfall(scopeTarget(this, exec.agent), "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
		const decisionContexts = decision.additionalContexts ?? [];
		if (decision.kind === "block") {
			const message = failureMessageFromContent(decision.feedback);
			return this.markCanonical(exec, {
				content: decision.feedback,
				isError: true,
				error: { message },
				...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {}
			});
		}
```

The bridge listener:

`dsh-hooks-claude-code/lib/index.js:265-280`
```js
	ctx.on("tools/post-execute", async (exec, result, next) => {
		const turn = lastTurn(ctx, exec.agent);
		const merged = await runPoint("PostToolUse", exec.name, postToolPayload(exec, result), {
			...exec.agent ? { agent: exec.agent } : {},
			turn,
			signal: exec.signal
		});
		const context = contextFrom(merged);
		if (merged.decision === "deny") return {
			kind: "block",
			feedback: [{
				type: "text",
				text: merged.reason ?? "blocked by PostToolUse hook"
			}],
			...context ? { additionalContexts: [context] } : {}
		};
```

### 3.2 It cannot cancel a side effect

`block` only **re-labels the already-produced result** as an error (`isError: true`, `content = feedback`). The tool body has already run and any filesystem/network/process effect is done. There is no rollback, no undo hook, and no path from `tools/post-execute` back to dispatch. The only pre-effect interception point is `tools/pre-execute` (§1.1).

### 3.3 What the hook payload carries

`dsh-hooks-claude-code/lib/index.js:375-383`
```js
function postToolPayload(exec, result) {
	return {
		...base(exec.agent, "PostToolUse"),
		tool_name: exec.name,
		tool_input: exec.arguments,
		tool_use_id: exec.callId,
		tool_response: blocksToText(result.content)
	};
}
```

`blocksToText` flattens text blocks only:

`dsh-hooks-claude-code/lib/index.js:343-346`
```js
/** Flatten content blocks to the text a hook payload carries (the common case). */
function blocksToText(content) {
	return content.filter((b) => b.type === "text").map((b) => b.text).join("");
}
```

| question | answer |
|---|---|
| `toolCallId` available? | **yes** — `tool_use_id: exec.callId` |
| exit code available as a field? | **no** — not a payload field. It appears only inside the rendered `tool_response` text, e.g. pwsh emits `[exit code: ${result.exitCode}]` (`dsh-tool-pwsh/lib/index.js:76`) |
| stdout available as a field? | **no** — only as part of the rendered `tool_response` text |
| `result.isError` available to the hook? | **no** — not in the CC payload |
| full structured result available? | **not through the Claude Code bridge.** A native plugin listening on the same waterfall *does* receive `result: Readonly<ToolExecutionResult>` (§5.3) |

---

## 4. Stop — `agent.steer`, no veto, no `stop_hook_active` input

**VERDICT: VERIFIED**

### 4.1 What the handler does

`dsh-hooks-claude-code/lib/index.js:292-308`
```js
	ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
		const merged = await runPoint("Stop", "", stopPayload(agent), {
			agent,
			turn,
			signal
		});
		if (merged.decision === "deny") {
			const text = merged.reason ?? "continue: blocked by Stop hook";
			agent.steer(createUserMessage({
				content: [{
					type: "text",
					text
				}],
				source: PLUGIN_SOURCE
			}));
		}
	});
```

It is a **serial listener whose return value is ignored** — not a waterfall, no `decision` return channel. The live Inspect contract confirms the mode:

`Event.listEvents("agent/turn-stopping")` (live, host Inspect provider):
```
"mode": "serial",
"signature": "'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> | void"
```
> "The turn is about to close... Awaited before the boundary commits — a listener that objects steers (`agent.steer(...)`) and the machine re-reads its inbox: fresh steering runs another step, none closes the turn. Data decides, so listener order cannot change the outcome."

### 4.2 `agent.steer` targets the next-step inbox

`dsh-agent-loop/lib/index.js:783-797`
```js
	send(message, target, wakeup) {
		const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
		const resolvedTarget = wakingAfterAbort ? "next-turn" : target;
		this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
		if (wakeup) this.wakeDriver(wakingAfterAbort);
	}
	followup(input) {
		this.send(input, "next-turn", true);
	}
	steer(input) {
		this.send(input, "next-step", true);
	}
	inject(input) {
		this.send(input, "next-step", false);
	}
```

### 4.3 The loop re-checks the inbox after `turn-stopping`

`dsh-agent-loop/lib/index.js:965-975`
```js
				signal.throwIfAborted();
				if (turnEnds && this.inbox.nextStep.length === 0) {
					await this.dispatch.serial("agent/turn-stopping", {
						turn,
						signal
					});
					signal.throwIfAborted();
				}
				if (turnEnds && this.inbox.nextStep.length === 0) break;
				target = "next-step";
```

The `turn-stopping` dispatch is **skipped entirely** when the inbox already holds next-step work, and the `break` is re-evaluated after the dispatch. `agent.steer` from inside the Stop listener therefore adds a step and prevents the break. This is the mechanism by which Stop "blocks" completion.

### 4.4 `stop_hook_active`, `decision: block`, `continue`

- **Payload field `stop_hook_active` exists but is a constant `false`** — it is written by the bridge, never read from the hook's output:

`dsh-hooks-claude-code/lib/index.js:384-389`
```js
function stopPayload(agent) {
	return {
		...base(agent, "Stop"),
		stop_hook_active: false
	};
}
```

The Codex bridge does the same and adds `last_assistant_message: null`:

`dsh-hooks-codex/lib/index.js:272-276`
```js
	ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
		const merged = await runPoint("Stop", "", {
			...turnBase(ctx, agent, "Stop", model),
			stop_hook_active: false,
			last_assistant_message: null
		}, {
```

`SubagentStop` also carries `stop_hook_active: false` (`dsh-hooks-claude-code/lib/index.js:401`). **There is no loop guard**: a Stop hook that always exits 2 steers again on every pass.

- **`decision: "block"`** (top level) → `output.decision = "block"` → rank 3 → merged `deny` → **steers**. Works.
- **`hookSpecificOutput.permissionDecision: "deny"`** → merged `deny` → **steers**. Works.
- **`continue: false`** → sets `output.continue = false`, and the merge sets `stop = true` — **but the merged `decision` stays `"none"`**, and the bridge only acts on `merged.decision === "deny"`. `mergeHookOutputs` does not translate `continue:false` into a decision:

`dsh-hook-protocol/lib/index.js:264-267`
```js
		if (out.continue === false && !stop) {
			stop = true;
			if (out.stopReason !== void 0) stopReason = out.stopReason;
		}
```
`dsh-hook-protocol/lib/index.js:272-279`
```js
	return {
		decision: decisionForRank(maxRank),
		...reasons.length > 0 ? { reason: reasons.join("\n\n") } : {},
		stop,
		...stopReason !== void 0 ? { stopReason } : {},
		additionalContext,
		systemMessages
	};
```

**Therefore `{"continue": false}` alone does NOT block a turn in this build.** The merged `stop` flag is computed but never consulted by the `Stop` handler (nor by the `UserPromptSubmit` handler, which only checks `merged.decision === "deny"` at `dsh-hooks-claude-code/lib/index.js:239`).

### 4.5 Can Stop *guarantee* the agent cannot finish the turn?

**No.** It is bounded by the loop's own conditions:

- The dispatch only happens when `turnEnds && this.inbox.nextStep.length === 0`; the loop may break before ever reaching it if the inbox already has next-step work.
- `signal.throwIfAborted()` runs immediately after the dispatch (`dsh-agent-loop/lib/index.js:971`) — an aborted turn skips the steer's effect.
- The handler is `async` inside `dispatch.serial`; if it throws, nothing steers.
- The effect is a *steer* (one more step), not a veto: the turn closes as soon as the inbox drains.
- The correct early-stop control in the opposite direction is data, not a hook: a tool result carrying `concludesTurn` ends the turn at its step (`dsh-tools/lib/types/index.d.ts:398-399`, `dsh-agent-loop/lib/index.js:579`).

---

## 5. Full event list, payloads, structured results, `toolCallId`

**VERDICT: VERIFIED** (names + modes + signatures from the shipped event catalog; key events cross-checked against the live Host Inspect provider)

The authoritative catalog lives in the Cordis tool package: `dsh-tool-cordis/lib/index.js:4915-5720` — each entry has `name`, `mode`, `signature`, `summary`, `description`, `parameters`. Live confirmation: `cordis_inspect_list` reports a host provider `Event` with method `listEvents`, and `cordis_inspect_query(host, Event, listEvents, {event:"tools/post-execute"})` returns the same signature and `mode: "waterfall"`.

### 5.1 Complete event-name list (68 entries, with mode), `dsh-tool-cordis/lib/index.js:4915-5720`

| event | mode | line |
|---|---|---|
| `agent-loop/config-start-failed` | emit | 4915 |
| `agent-preset/selected` | emit | 4926 |
| `agent/assistant-stream` | emit | 4940 |
| `agent/created` | emit | 4951 |
| `agent/disposed` | emit | 4962 |
| `agent/error` | emit | 4973 |
| `agent/inbox/claimed` | emit | 4984 |
| `agent/inbox/discarded` | emit | 4995 |
| `agent/inbox/inserted` | emit | 5006 |
| `agent/pre-step` | waterfall | 5017 |
| `agent/request` | emit | 5028 |
| `agent/request-error` | emit | 5039 |
| `agent/session-start` | emit | 5050 |
| `agent/status` | emit | 5061 |
| `agent/turn-stopping` | serial | 5072 |
| `api-session/activity` | emit | 5083 |
| `api-session/added` | emit | 5097 |
| `api-session/error` | emit | 5108 |
| `api-session/removed` | emit | 5122 |
| `api-session/status` | emit | 5133 |
| `approval/request` | waterfall | 5147 |
| `authorization/settled` | emit | 5158 |
| `commands/change` | emit | 5172 |
| `cordis/dynamic-package` | emit | 5180 |
| `cordis/dynamic-retract` | emit | 5191 |
| `cordis/inspect-query` | waterfall | 5202 |
| `cordis/inspect-query-resolved` | emit | 5213 |
| `cordis/request-run` | waterfall | 5224 |
| `cordis/request-run-resolved` | emit | 5235 |
| `credentials/record-updated` | emit | 5246 |
| `credentials/reference-updated` | emit | 5257 |
| `domain/changed` | emit | 5268 |
| `feedback/committed` | emit | 5279 |
| `fs/edit-intent` | waterfall | 5290 |
| `fs/observed` | waterfall | 5304 |
| `fs/write-intent` | waterfall | 5325 |
| `goal/activation-changed` | emit | 5339 |
| `goal/changed` | emit | 5350 |
| `llm/adapters-updated` | emit | 5361 |
| `llm/stream` | waterfall | 5369 |
| `session-telemetry/record` | emit | 5380 |
| `session/created` | emit | 5391 |
| `session/disposed` | emit | 5402 |
| `session/event` | emit | 5413 |
| `session/flush` | emit | 5427 |
| `settings/document-updated` | emit | 5438 |
| `settings/updated` | emit | 5452 |
| `skills/change` | emit | 5477 |
| `subagent/end` | emit | 5485 |
| `subagent/provider-added` | emit | 5496 |
| `subagent/provider-removed` | emit | 5507 |
| `subagent/start` | emit | 5518 |
| `system-prompt/assemble` | waterfall | 5529 |
| `system-prompt/change` | emit | 5543 |
| `tools/change` | emit | 5551 |
| `tools/execute` | waterfall | 5559 |
| `tools/post-execute` | waterfall | 5570 |
| `tools/pre-execute` | waterfall | 5584 |
| `tools/ptc-dispatch-log` | waterfall | 5595 |
| `tools/result` | emit | 5606 |
| `user-questions/request` | waterfall | 5620 |
| `webserver/index-inject` | waterfall | 5631 |
| `workflow/agent-end` | emit | 5642 |
| `workflow/agent-start` | emit | 5656 |
| `workflow/end` | emit | 5670 |
| `workflow/log` | emit | 5684 |
| `workflow/phase` | emit | 5698 |
| `workflow/start` | emit | 5712 |

(The catalog continues past 5720 with **type** names, not events — `AdapterRegistrationHandle`, `Agent`, … at 5726+.)

### 5.2 The four tool events, exact contracts

`dsh-tool-cordis/lib/index.js:5584-5592`
```
		name: "tools/pre-execute",
		mode: "waterfall",
		signature: "'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>",
		summary: "Allow, deny, or ask before dispatch.",
```
> "`next()` delegates to allow; missing approval support turns `ask` into denial."

`dsh-tool-cordis/lib/index.js:5559-5566`
```
		name: "tools/execute",
		mode: "waterfall",
		signature: "'tools/execute'(this: Scoped<ToolRuntime>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>",
		summary: "Around-dispatch waterfall for timeout, retry, or metrics.",
```

`dsh-tool-cordis/lib/index.js:5570-5581`
```
		name: "tools/post-execute",
		mode: "waterfall",
		signature: "'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>",
		summary: "Accept, replace, enrich, or block a normalized dispatch result.",
```

`dsh-tool-cordis/lib/index.js:5606-5617`
```
		name: "tools/result",
		mode: "emit",
		signature: "'tools/result'(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined",
		summary: "Observe the frozen, lossless-JSON final outcome.",
```
> "Observe the frozen, lossless-JSON final outcome. Listener failures are contained. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): keyed by `exec.agent`."

Emit site — `dsh-tools/lib/index.js:3283-3295`
```js
	/** Notify observers without exposing a mutation or error channel into the outcome. */
	notifyResult(exec, result) {
		Object.freeze(exec);
		const { name: toolName, callId } = exec;
		...
		const callbacks = this.ctx.events.dispatch("emit", [
			scopeTarget(this, exec.agent),
			"tools/result",
			exec,
			result
		]);
```

### 5.3 The structured tool result — where exit code and stdout actually live

`dsh-tools/lib/types/index.d.ts:389-412`
```ts
export interface ToolExecutionSuccess {
    readonly isError: false;
    /** Execution-local canonical value; deliberately omitted from durable events. */
    readonly value: JsonValue;
    readonly content: ContentBlock[];
    readonly error?: never;
    readonly meta?: JsonValue;
    readonly additionalContexts?: UserMessage[];
    /** The agent loop stops after committing this successful result batch. */
    readonly concludesTurn?: true;
}
/** Failed canonical tool execution; failures never carry a successful value. */
export interface ToolExecutionFailure {
    readonly isError: true;
    readonly error: ToolFailure;
    readonly value?: never;
    readonly content: ContentBlock[];
    readonly meta?: JsonValue;
    readonly additionalContexts?: UserMessage[];
    readonly concludesTurn?: never;
}
```

There is **no generic `exitCode`/`stdout` field** on `ToolExecutionResult`. Exit code and stdout are tool-specific and ride inside `value`. For the pwsh tool:

`dsh-tool-pwsh/lib/index.js:157-179`
```js
function canonicalPwshResult(result) {
	const output = (stream) => ({
		text: stream.text,
		truncated: stream.truncated,
		...stream.spillPath !== void 0 ? { spillPath: stream.spillPath } : {}
	});
	return {
		kind: "foreground",
		exitCode: result.exitCode,
		signal: result.signal,
		timedOut: result.timedOut,
		aborted: result.aborted,
		timeoutMs: result.timeoutMs,
		stdout: output(result.stdout),
		stderr: output(result.stderr),
		...result.sandbox !== void 0 ? { sandbox: { ... } } : {}
	};
}
```

**So: to observe a structured `exitCode`/`stdout` programmatically, listen on `tools/result` (or `tools/post-execute`) and read `result.value` — the tool's own JSON schema.** The Claude Code file bridge does **not** expose this: its PostToolUse payload carries only `tool_response: blocksToText(result.content)` (§3.3).

`value` is deliberately excluded from the durable log (`dsh-tools/lib/types/index.d.ts:392`), so a listener is the only way to see it after the fact.

### 5.4 `toolCallId`-bearing events

`dsh-tools/lib/types/index.d.ts:197-221`
```ts
export interface ToolExecutionInput {
    readonly callId: ToolCallId;
    /**
     * Root model-requested call owning this execution tree. ...
     */
    readonly rootCallId?: ToolCallId;
    readonly name: string;
    /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
    readonly arguments: unknown;
    /** The agent on whose behalf the call runs (set by the agent loop). */
    readonly agent?: Agent;
    ...
    /** Required caller-owned cancellation for this invocation. */
    readonly signal: AbortSignal;
}
```
`dsh-tools/lib/types/index.d.ts:261-264`
```ts
export interface ToolExecution extends ToolExecutionInput {
    /** Root model-requested call, resolved for every root and nested execution. */
    readonly rootCallId: ToolCallId;
    /** Registry-assigned identity shared with nested calls only as their opaque `parent` token. */
    readonly token: ToolExecutionToken;
}
```

Events whose `exec` carries `callId`: `tools/pre-execute`, `tools/execute`, `tools/post-execute`, `tools/result`, `tools/ptc-dispatch-log` (the sub-call identity is `PtcDispatchLog.subCallId`, `dsh-tools/lib/types/index.d.ts:245-246`).

Durable session events also carry the id — `dsh-agent-loop/lib/index.js:687-712`
```js
function appendToolCall(session, turn, step, block) {
	return session.append("tool/call", {
		turn,
		step,
		callId: block.id,
		name: block.name,
		arguments: block.arguments
	}).seq;
}
/** Append a model-ordered result linked to its call event. */
function appendToolResult(session, turn, step, block, result, callSeq) {
	const message = createToolResultMessage({
		callId: block.id,
		content: result.content,
		isError: result.isError
	});
	session.append("tool/result", {
		turn,
		step,
		message,
		...result.error?.info ? { error: result.error.info } : {},
		...result.meta !== void 0 ? { meta: result.meta } : {}
	}, {
		surfaceOp: "append",
		sourceEventSeqs: [callSeq]
	});
}
```
Note `session.append("tool/result", …)` (durable log, singular `tool/`) is **distinct** from the Cordis event `tools/result` (plural `tools/`). `tool/result` carries `message` + `meta`, **not** `value`.

### 5.5 The hook bridge's own durable events

`dsh-hook-protocol/lib/index.js:316-344`
```js
function appendHookInvoked(session, invocation) {
	session.append("hook/invoked", {
		turn: invocation.turn,
		point: invocation.point,
		dialect: invocation.dialect,
		handlerId: invocation.handlerId,
		...invocation.matcher !== void 0 ? { matcher: invocation.matcher } : {}
	});
}
...
function appendHookResult(session, record) {
	const { output } = record;
	const stderrSummary = summarizeStderr(output.stderr, record.stderrSummaryMaxChars);
	session.append("hook/result", {
		turn: record.turn,
		point: record.point,
		handlerId: record.handlerId,
		decision: output.decision ?? (output.continue === false ? "stop" : "pass"),
		...output.exitCode !== void 0 ? { exitCode: output.exitCode } : {},
		...stderrSummary !== void 0 ? { stderrSummary } : {},
		durationMs: record.durationMs
	});
}
```

**`hook/result` is the durable record that carries a hook's `exitCode`** (not the tool's). stderr is trimmed and capped at `stderrSummaryMaxChars` (default 500, `dsh-hook-protocol/lib/index.js:296`).

---

## 6. How the hook bridge is mounted; absolute `configPath`

**VERDICT: VERIFIED for the mechanism; NOT FOUND for an actual mounted row or an actual `hooks.json` on this machine. MEASURED (§13): even when a row *is* mounted, the shipped bridge cannot launch a hook on this build.**

### 6.1 Plugin identity and required config

`dsh-hooks-claude-code/lib/index.js:113-121`
```js
const name = "hooks-claude-code";
const inject = ["shell", "sessionProjections"];
const Config = z.object({
	configPath: z.string().required(),
	pluginRoot: z.string(),
	projectDir: z.string(),
	defaultTimeoutMs: z.number().default(DEFAULT_HOOK_TIMEOUT_MS),
	stderrSummaryMaxChars: z.number().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS)
});
```

`configPath` is **required** and is a plain string. The Codex variant is analogous (`dsh-hooks-codex/lib/index.js`, plugin package `@deepseek-ai/dsh-hooks-codex`).

The `inject` set on line 114 is the load-bearing one: it is what the bridge may pass to
`runHook`, and §13 measures that the mounted executor cannot be driven with it. `shell` is
therefore not merely a dependency — it is the reason the bridge cannot launch a hook on the
composed profiles of this build.

### 6.2 Absolute `configPath` — supported

The path is passed straight to Node's `readFileSync`, with no normalization, base-dir join, or relative-only check:

`dsh-hooks-claude-code/lib/index.js:141-151`
```js
	try {
		const result = parseClaudeCodeConfig(JSON.parse(readFileSync(config.configPath, "utf8")), {
			...config.pluginRoot !== void 0 ? { pluginRoot: config.pluginRoot } : {},
			...config.projectDir !== void 0 ? { projectDir: config.projectDir } : {}
		});
		parsed = result.config;
		for (const s of result.skipped) ctx.logger.warn(`hooks-claude-code: skipping unsupported "${s.type}" hook on ${s.event} (only command hooks run)`);
	} catch (error) {
		ctx.logger.warn(`hooks-claude-code: could not load hook config "${config.configPath}": ${String(error)} — no hooks registered`);
		return;
	}
```

`readFileSync` resolves absolute paths as-is → **an absolute Windows path works.** The README states the relative-path rule explicitly:

`dsh-hooks-claude-code/README.md:70`
```
- One config applies to the whole process: it is read once at startup, and a relative `configPath` resolves from the directory that launched the process.
```

Also note: **a config that fails to load registers no hooks and only warns** — the agent still starts. There is no live reload (README:182).

### 6.3 Real configuration example found in installed files

`dsh-hooks-claude-code/README.md:36-42` (verbatim, from the installed package):
```yaml
- name: '@deepseek-ai/dsh-hooks-claude-code'
  config:
    configPath: ./.claude/hooks.json
    pluginRoot: ./.claude/plugins/my-plugin
    projectDir: .
```

`dsh-hooks-claude-code/README.md:44-50`
```
| Field | Default | Meaning |
|---|---|---|
| `configPath` | required | Path to a `hooks.json` or a settings file whose `hooks` key holds the config |
| `pluginRoot` | — | Replaces `${CLAUDE_PLUGIN_ROOT}` in command strings |
| `projectDir` | session workspace | Replaces `${CLAUDE_PROJECT_DIR}` and sets the `CLAUDE_PROJECT_DIR` env var |
| `defaultTimeoutMs` | `600,000` | Per-hook timeout when a hook sets none (the Claude Code default) |
| `stderrSummaryMaxChars` | `500` | Character cap on the persisted `hook/result` stderr summary |
```

The config parser accepts either a settings object with a `hooks` key **or** a bare event map, and understands exactly seven events:

`dsh-hooks-claude-code/lib/index.js:13-21`
```js
const CLAUDE_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"Stop",
	"SubagentStart",
	"SubagentStop"
];
```
`dsh-hooks-claude-code/lib/index.js:55-56`
```js
	const root = asObject(raw);
	const hooksMap = root ? asObject(root.hooks) ?? root : void 0;
```

Only `type: "command"` hooks run; other handler types are skipped with a warning (`dsh-hooks-claude-code/lib/index.js:72-79`, README:182). `matcher` is ignored for `UserPromptSubmit` and `Stop` (`dsh-hooks-claude-code/lib/index.js:87`).

### 6.4 What is NOT present on this machine

- **No `hooks.json` anywhere** under the install root or in `C:\Users\katoc\.dsh` (searched by filename — 0 results).
- **No composition row** referencing `hooks-claude-code`, `hooks-codex`, or `dsh-hook` in any `*.yml`/`*.yaml` under the install root or under `C:\Users\katoc\.dsh` (searched — the only hits are two `README.i18n.yaml` comments).
- The packages are present only as **dependencies of the `dsh` metapackage**:

`dsh/package.json:55-56`
```json
    "@deepseek-ai/dsh-hooks-claude-code": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-hooks-codex": "^0.1.5-rc.2",
```

**Conclusion: the hook bridge is installed but not mounted, and no hook config exists.**
Mounting it would require adding a composition row (see §8 for the exact files) — this was not
done, per instructions. And mounting it would not be enough on this build: §13 measures that the
mounted `shell` service cannot be driven by a caller that does not inject `sandboxPolicy`, so a
mounted row would register hooks that never launch. That is why the repository ships a native
Cordis adapter instead.

---

## 7. Programmatic tool-event access without the Claude Code file bridge

**VERDICT: VERIFIED — yes, and it is the same extension points.**

There is no separate "tool event service". The Claude Code bridge is itself just a Cordis plugin that subscribes to ordinary harness events; any other Cordis plugin (including a dynamic one) can subscribe to the same events with no file bridge, no subprocess, and no `configPath`.

### 7.1 The three mechanisms

**(a) Listen on the events directly** — `ctx.on(...)`, exactly as the bridge does:

`dsh-hooks-claude-code/lib/index.js:248` / `:265` / `:292`
```js
	ctx.on("tools/pre-execute", async (exec, next) => {
	ctx.on("tools/post-execute", async (exec, result, next) => {
	ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
```

These events are **defined and dispatched by `dsh-tools`** (`ToolRuntime`, a Cordis `Service`) and `dsh-agent-loop` — not by the hooks package. Dispatch sites: `dsh-tools/lib/index.js:3116` (pre), `:3378` (post), `:3290-3295` (result emit), `dsh-agent-loop/lib/index.js:967` (turn-stopping).

Live confirmation via the Host Inspect provider (read-only, no process started):
- `cordis_inspect_list` → host provider `Event`, method `listEvents`, description "Progressive Host Event discovery: compact listener directory, then one exact event contract."
- `cordis_inspect_query(host, Event, listEvents, {event:"tools/post-execute"})` → returns the exact contract, `mode: "waterfall"`, with `ToolExecution` / `ToolExecutionResult` / `PostToolDecision` declarations.

**(b) Register a monotonic guard** — `ctx.tools.guard(fn)`:

`dsh-tools/lib/index.js:2816-2826`
```js
	guard(guard) {
		...
			label: "tools.guard()",
	...
	guardReason(exec) {
		const globalReason = this.layers.global.guardReason(exec);
		...
			const reason = layer.guardReason(exec);
```
`dsh-tools/lib/types/index.d.ts` (via live Inspect):
```ts
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined;
```
`ToolRuntime.guard(guard: ToolGuard): () => void`. A returned string denies. Consumed after the waterfall:

`dsh-tools/lib/index.js:3127`
```js
			const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
```

**(c) `ctx.tools.register(definition)`** with an optional `finalizeContent(exec, result)` callback — the per-tool result hook (`ToolDefinition`, live Inspect declaration):
```ts
export interface ToolDefinition extends ToolSchema {
    readonly output: ToolOutputDefinition;
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    ...
}
```

### 7.2 Practical consequence for this task

A native/dynamic Cordis plugin can observe **structured** tool outcomes — `exec.callId`, `exec.name`, `exec.arguments`, and `result.value` (which for pwsh contains `exitCode`, `stdout.text`, `stderr.text`, `timedOut`, `sandbox`) — which the Claude Code bridge cannot deliver, because the bridge flattens the result to text (`blocksToText`, §3.3). If the goal is programmatic gating/observation of tool exit codes, **the Cordis plugin route is strictly more capable than the file bridge.**

`dsh-tool-cordis` (package `@deepseek-ai/dsh-tool-cordis`, tools `cordis_inspect_list` / `cordis_inspect_query` / `cordis_define` / `cordis_run` … at `dsh-tool-cordis/lib/index.js:9115-9457`) is the shipped surface for authoring such plugins, and the host provider list above is what it exposes.

---

## 8. Active profile and the compositions actually in use

**VERDICT: VERIFIED for which files are in use; NOT FOUND for any hook/bridge/jev row.**

### 8.1 Which profile is live

Live env: `DSH_HOME=C:\Users\katoc\.dsh`, `DSH_WEB_URL=http://127.0.0.1:3080`, `DSH_SESSION_ID=6c6f5d36-7f64-4561-81ea-1fab8d9a35b0`. The Web GUI is served by the **`web`** profile.

`C:\Users\katoc\.dsh\profiles` contains: `headless`, `rescue`, `tui`, `web`, `web.empty-backup-20260828-1248` (+ `node_modules`).

`C:\Users\katoc\.dsh\profiles\web\cordis.yml` (entire file, 4 lines):
```yaml
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

So the effective host composition = bundles from `profiles/web/package.json` → `dsh.profile.bundles`, then `profiles/web/cordis.patch.yml`, then any `--patch` overlays.

`profiles/web/package.json` → `dsh.profile.bundles` (verbatim):
```json
"bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@zseven-w/dsh-crew",
  "dsh-mnemon",
  "dshmarket",
  "@changfenhuang/dsh-genui",
  "@liustack/modlens",
  "@linxin666/dsh-client-ui-skill-explorer",
  "@vectorize-io/hindsight-coding-agents",
  "@furongjun1999/dsh-memory",
  "dsh-openviking",
  "dsh-autostart-deps",
  "dsh-restart",
  "dsh-autostart",
  "dsh-diag",
  "@liustack/modsearch",
  "dsh-better-sidebar",
  "dsh-codex-subscription"
]
```

### 8.2 Agent preset selection

`C:\Users\katoc\.dsh\settings.yaml:1-4`
```yaml
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
agent-presets:
  default: orchestrator-lean
```

Agent presets in use: `C:\Users\katoc\.dsh\.agent-presets\orchestrator-lean\agent.cordis.yml` (24 511 bytes) and `C:\Users\katoc\.dsh\.agent-presets\chat\agent.cordis.yml` (8 284 bytes). (Also present: `.agent-presets-retired`.)

### 8.3 Searched for hooks / bridge / jev rows — results

| file | search | result |
|---|---|---|
| `profiles\web\cordis.patch.yml` | `hook\|bridge\|jev\|approval` | **no matches** |
| `profiles\web\cordis.yml` | — | empty entry list (`[]`) |
| `.agent-presets\orchestrator-lean\agent.cordis.yml` | `hooks\|hook\|jev\|bridge\|approval\|user-approval` | only 2 incidental hits — the word "approval" inside `exit_plan_mode` prompt text (line 116) and the words "OCR bridge" inside a comment (line 386). **No plugin rows.** |
| `.agent-presets\chat\agent.cordis.yml` | same | only 1 incidental hit — "approval" inside `exit_plan_mode` prompt text (line 84). **No plugin rows.** |
| `settings.yaml` | `^hooks\|^  hooks\|hook` | **no matches** |
| whole install root + `.dsh`, `*.yml`/`*.yaml` | `hooks-claude-code\|hooks-codex\|dsh-hook` | only 2 README-comment hits; **no composition row** |
| install root + `.dsh` | filename `hooks.json` | **no matches** |

**Conclusion: nothing on this machine currently wires the hook bridge, and there is no `jev`-named plugin row in any active composition.** The word "jev" appears in `C:\Users\katoc\.dsh\AGENTS.md` (a prompt-level rule about routing to Jev) and in `.dsh/skills/jev-decision-judge/`, but **not** as a Cordis composition row.

---

## SHA256 of every file read / referenced

Algorithm: SHA-256, computed with `Get-FileHash` on the installed files (unmodified).

| SHA256 | bytes | path |
|---|---|---|
| `8B03C89ED6529049EB4FB567FFF6AD8D593E9405F1CC87487C446D8030BE98A3` | 15760 | `...\node_modules\@deepseek-ai\dsh-hook-protocol\lib\index.js` |
| `236633296049129787E3E8DE705C5F7BADE2FD16A6554FF15AD0E9143CAC20A0` | 15252 | `...\node_modules\@deepseek-ai\dsh-hooks-claude-code\lib\index.js` |
| `0711A7B6801B7A2BFDF16A6B5ECF55BA0066B47034E040681717BC5B420A91F0` | 16143 | `...\node_modules\@deepseek-ai\dsh-hooks-claude-code\README.md` |
| `9C2AE8358AE955F0C935D2F38BB9D0B461BFDC7D97CB72FE9FC241839041BD97` | 12197 | `...\node_modules\@deepseek-ai\dsh-hooks-codex\lib\index.js` |
| `FBD3F2E348358D27234739F8CBC4BDB2D6450B0A6B1B207572463977B14A5ECB` | 8507 | `...\node_modules\@deepseek-ai\dsh-user-approval\lib\index.js` |
| `AABA52BF5D0149355407642B3965C06977D1E9143F5C61BC19429ABBE6A11C5D` | 151784 | `...\node_modules\@deepseek-ai\dsh-tools\lib\index.js` |
| `82DAD60A51EE07A26EECC43DF70F6059B26989E6B00DE00DEFA4C2FC0A92075F` | 42684 | `...\node_modules\@deepseek-ai\dsh-tools\lib\types\index.d.ts` |
| `257EB83C00A05EE068E9F4BA80CA71AB94E3A1275D24B7A0CF5038FF23DD0FD8` | 71267 | `...\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js` |
| `55FB66CEB75EE92FDBD75E89DB813F59EDB8774CFA113968CDD132FADE65EDFE` | 500900 | `...\node_modules\@deepseek-ai\dsh-tool-cordis\lib\index.js` |
| `C1DD78A35722E47EAEEF57B33D15D4170F4BB27DB2BEE15DA76A6D4EA9557E63` | 20501 | `...\node_modules\@deepseek-ai\dsh-tool-pwsh\lib\index.js` |
| `5C0441EFAADE5ABC39F93CC1661C3EE57B3B49FCE0C343C7039C82E6590531B1` | 24540 | `C:\Users\katoc\.dsh\settings.yaml` |
| `C300DCF2EBC5F02062D6591268D29D3DB6FE45E0CB138F5467276FE2BA06076E` | 223 | `C:\Users\katoc\.dsh\profiles\web\cordis.yml` |
| `C1786F6532ABD9FCB36B779CCC9B4408ED37A1545A2F60838E1BEE2523108B84` | 12315 | `C:\Users\katoc\.dsh\profiles\web\cordis.patch.yml` |
| `46FEDE563581F9A7CFFAC0B4A7126C46A11901BB5C1E60D004E1E6316C5DA627` | 24511 | `C:\Users\katoc\.dsh\.agent-presets\orchestrator-lean\agent.cordis.yml` |
| `3A3E39E8E5E9817A1EFB4DAE5854D6D097024B9776EC652BB7AA883E09929319` | 8284 | `C:\Users\katoc\.dsh\.agent-presets\chat\agent.cordis.yml` |

Where `...\node_modules\@deepseek-ai\` expands to
`C:\Users\katoc\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`.

### Referenced but not hashed (read only via search/inspection, not as primary evidence)

- `C:\Users\katoc\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\package.json` (dependency pins, lines 51-59)
- `C:\Users\katoc\.dsh\profiles\web\package.json` (`dsh.profile.bundles`)

### Live Inspect calls used (read-only; no DSH process started, no network)

- `cordis_inspect_list` (host + client provider manifests)
- `cordis_inspect_query(host, Event, listEvents, {event:"tools/post-execute"})`
- `cordis_inspect_query(host, Event, listEvents, {event:"agent/turn-stopping"})`

---

## Summary of verdicts

| # | question | verdict | one-line answer |
|---|---|---|---|
| 1 | PreToolUse blocking, exit codes, JSON fields, `hookEventName` | **VERIFIED** | `tools/pre-execute` waterfall; exit 2 → `block`→`deny` with stderr as reason; exit 0 parses JSON only if stdout starts with `{`; `{"decision":"deny"}` is ignored — use `hookSpecificOutput.permissionDecision: "deny"\|"ask"`; `hookEventName` must equal the firing point (`"PreToolUse"`) or the event-scoped fields are discarded |
| 2 | "ask the human"; policy `never` | **VERIFIED** | PreToolUse can `ask`; `never` returns `"rejected"` **before** the answerer waterfall → registry maps it to **automatic DENY** with the misleading reason `the user rejected tool "<name>"`; audit pair still logged |
| 3 | PostToolUse timing / side effects / payload | **VERIFIED** | Runs after the tool (`tools/post-execute`); can only re-label the result as `isError` — **cannot undo the side effect**; payload has `tool_use_id`(=callId), `tool_input`, `tool_response` (text only), **no exit code or stdout fields** |
| 4 | Stop / `agent.steer` / `stop_hook_active` / veto | **VERIFIED** | Serial listener; on merged `deny` calls `agent.steer` → next-step inbox → loop re-checks and does not break. `stop_hook_active` is a hardcoded payload `false` and is never read from output. `{"continue":false}` alone does **not** block. **Not a guarantee** — skipped when the inbox is non-empty, and defeated by abort/throw |
| 5 | Full event list + payloads + structured results + toolCallId | **VERIFIED** | 68 events enumerated with modes (`dsh-tool-cordis/lib/index.js:4915-5720`); structured exit code/stdout live in `result.value` on `tools/result`/`tools/post-execute` (tool-specific, e.g. pwsh `exitCode`/`stdout.text`); `exec.callId` on all five tool events; `hook/result` carries the *hook's* `exitCode` |
| 6 | Hook bridge mounting, composition line, absolute `configPath` | **mechanism VERIFIED; actual config NOT FOUND; bridge unusable MEASURED (§13)** | Plugin `hooks-claude-code`, `inject: ["shell","sessionProjections"]` (`lib/index.js:114`), `configPath` **required**; `readFileSync` → **absolute path supported**; real example exists in the installed README; **no mounted row and no `hooks.json` exist on this machine**; and even when mounted, the executor `resolve()` reads `this.ctx.sandboxPolicy` against the **caller's** context, so no hook process is spawned |
| 7 | Programmatic tool-event access without the file bridge | **VERIFIED** | Yes — the same `tools/pre-execute` / `tools/post-execute` / `tools/result` / `agent/turn-stopping` events are ordinary Cordis events (dispatched by `dsh-tools`/`dsh-agent-loop`), plus `ctx.tools.guard(fn)`. Strictly more capable than the bridge (sees `result.value`) |
| 8 | Active profile and existing hooks/bridge/jev rows | **VERIFIED (no such rows)** | Profile `web`; root `profiles/web/cordis.yml` is `[]`, composed from `package.json` bundles + `cordis.patch.yml`; default agent preset `orchestrator-lean`; **zero hook/bridge rows and zero `jev` composition rows** in any active file |

## Explicitly unresolved / not established

1. **No live end-to-end *agent* run was performed** (forbidden at the time of §1–§8). All
   behavioural claims there are read from code paths; the loop/inbox interaction in §4.3 is a
   code-level deduction from `dsh-agent-loop/lib/index.js:966-973`, not an observed turn. §13
   later added an isolated runtime run with **no model** — it measures the mounted executor and
   the native adapter, and it still observes no assistant turn, so §4.3 is unchanged by it.
2. **Whether the loop bounds repeated Stop steering.** `stop_hook_active` is always `false` and no counter was found in the files read; a separate bound could exist outside the files inspected (e.g. in the goal-round driver or session turn limits). Not established.
3. **The effective per-session approval policy was not read from the session log** (session logs under `C:\Users\katoc\.dsh\sessions` were not opened). The `never` conclusion rests on the live runtime-context text matching `NEVER_SENTENCE` verbatim, not on an `approval/policy` event.
4. **`profiles/headless`, `profiles/tui`, `profiles/rescue` were not inspected** — only `web` (the live one per `DSH_WEB_URL`) and the two active agent presets.
5. **Bundle contents were not expanded.** Whether any of the 18 bundles in `dsh.profile.bundles` transitively mounts a hook row was not verified; the direct grep for hook package names across all `*.yml` under the install root and `.dsh` returned nothing.
6. **`dsh-hooks-codex` was read only at lines 225-299** (its PreToolUse/PostToolUse/Stop branches); its Codex-dialect config schema and payload builder were not fully read.

---

## 13. RUNTIME: the hook bridge cannot launch a hook under the sandboxed shell

**VERDICT: MEASURED IN A RUNNING HARNESS (2026-09-22; cause corrected 2026-09-22).** This
supersedes any reading of `runPoint` that assumes a configured hook runs.

### 13.0 RETRACTION — the first causal claim was an instrumentation artifact

The first version of this section blamed a missing `sandboxPolicy` injection in the bridge and
quoted `cannot get property "sandboxPolicy" without inject` as the failure. **That causal claim
is RETRACTED.**

The string was produced by a diagnostic wrapper that re-entered `ctx.shell` through a JavaScript
`Proxy`. A Cordis service accessor is context-bound: going through a proxy makes the service
resolve against the wrong context and throw an error the uninstrumented code never hits. The
observation was therefore about the probe, not about the harness.

A probe that touched nothing reproduced a different, real message:
`cannot get required service "sandboxPolicy" in inactive context`. That is the message the
clean measurements below use.

A wrong root cause left standing is worse than no root cause, so the retracted claim is marked
here rather than quietly deleted. Nothing downstream should cite it.

### 13.1 The historical measurement — proxy-instrumented, therefore NOT TRUSTWORTHY

The following sequence was recorded on 2026-09-22 by the instrumented probe described in 13.0.
It is kept only as a record of what was observed; **it is not evidence**, and step 4 in
particular is the artifact.

1. `bridge apply called with {"configPath":"…hooks.json", …}` — the row mounts.
2. `bridge ctx.shell.run: function; ctx.shell.resolve: function` — the service is there.
3. `bridge listener invoked: Bash` — the bridge's listener fires on the real dispatch.
4. ~~`shell.resolve THREW: cannot get property "sandboxPolicy" without inject`~~ — **artifact of
   the proxy wrapper; do not cite.**
5. `bridge listener returned {"kind":"allow"}` — and the command ran.

Steps 1, 2, 3 and 5 are consistent with the clean measurements below and are not in doubt.
Step 4 is withdrawn.

### 13.2 The real cause, measured without any proxy

On the composed profiles of this build the mounted `shell` service is `SandboxPwshExecutor`
(Windows) or `SandboxBashExecutor` (elsewhere). Its `resolve()` reads `this.ctx.sandboxPolicy`
(`dsh-pwsh-sandbox/lib/index.js:148`, `dsh-bash-sandbox/lib/index.js:141`), and `this.ctx`
resolves to the **calling** context — the caller's `inject` set appears first in the chain. A
caller that does not inject `sandboxPolicy` therefore cannot use the executor at all.

Clean replacement measurements:

| probe | measured result |
|---|---|
| `ctx.get('shell').ctx.fiber` | the **caller's** fiber, not the service's own |
| `shell.run(shell.resolve('node --version'))` | `{exitCode: 1, stdout: "", stderr: ""}` — a silent failure, no exception |
| `shell.run(shell.resolve(<write a file>))` | throws `cannot get required service "sandboxPolicy" in inactive context` |
| `runHook(ctx.shell, {command})` | stderr carries that text and **no hook process is ever spawned**; no marker file is written |

Reproduced identically under `DSH_PERMISSION_MODE=workspace-write` and `danger-full-access`, so
the permission mode is not the variable.

The chain, with citations:

- `dsh-hooks-claude-code/lib/index.js:114` — `inject = ["shell", "sessionProjections"]`.
- `dsh-hooks-claude-code/lib/index.js:~148` — `runHook(ctx.shell, hook, …)` per hook.
- `dsh-pwsh-sandbox/lib/index.js:148` / `dsh-bash-sandbox/lib/index.js:141` —
  `sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()`, evaluated against
  the **caller's** context.
- `dsh-hook-protocol/lib/index.js` (`runHook`) — the `catch` returns
  `parseHookOutput(undefined, "", error.message)`: **no exit code, no decision**.
- `mergeHookOutputs` therefore yields `allow`, and `tools/pre-execute` falls through to `next()`.

The same shape applies on Linux/macOS, where the mounted executor is `dsh-bash-sandbox`
(`dsh-bash-sandbox` is disabled only on Windows; `dsh-pwsh-sandbox` only off Windows).

### 13.3 Consequence

A hook that cannot launch and a gate that chose to stay silent are **behaviourally
identical** — same stdout, same decision, same outcome. Nothing in the harness, the bridge
or the protocol reports the failure, because the hook's stderr is only surfaced through
`appendHookResult`, which requires an open turn.

Therefore: **`PreToolUse` enforcement through the shipped bridge on this build is unverified and
unusable, and must not be claimed as verified because the hook is registered.** The cause is the
executor a caller cannot drive — not a missing injection in the bridge.

### 13.4 Resolution: a native Cordis adapter, not a repair

`adapters/dsh/plugin.mjs` is a native Cordis plugin that uses only documented harness interfaces
and needs **no `shell` service**, so the broken executor cannot affect it. It registers:

- `ctx.tools.guard(fn)` — monotonic denial, cannot be force-allowed downstream
  (`dsh-tools/lib/index.js:2816`, contract at `lib/types/index.d.ts:610-620`);
- `tools/pre-execute` — waterfall `(exec, next)`; `next()` is **required** for pass-through, and
  returning `undefined` without it makes the registry throw rather than silently allow
  (`dsh-tools/lib/index.js:3116-3148`);
- `tools/post-execute` — `(exec, result, next)`;
- `agent/turn-stopping` — **serial, no `next`, and its return value is DISCARDED**: it cannot
  veto a stop (`dsh-agent-loop/lib/index.js:967`). The only lever is `agent.steer(message)`,
  which enqueues another step inside the same turn.

This is a **replacement, not a repair**: the shipped bridge remains unusable, and the active DSH
profile and the global `node_modules` were never edited.

### 13.5 Reproducer and acceptance

`node scripts/jev-dsh-acceptance.mjs` — boots a throwaway `DSH_HOME` from
`--from-default-profile headless` plus a `--patch` overlay, mounts `adapters/dsh/plugin.mjs`
beside `adapters/dsh/scenarios.mjs`, and drives `ctx.tools.execute` — the same entry point the
agent loop uses — against a safe marker tool that only writes a file.

**Result: verdict HELD, exit 0, 5 scenario sets, 24 checks, 0 failures**, ~2–3 s per set,
harness `0.1.5-rc.2` on Node `v24.14.0`. The sets are `shadow`, `enforce`, `never`, `failure`
and `stop`. Runner failure classes, none of which is a pass: `boot-timeout`,
`harness-not-driven`, `listener-not-attached`, `tool-not-invoked`, `assertion-failed`. Exit
codes: `0` held, `1` not-held, `3` not-driven.

The result carries four limits and none of them is removable by rerunning it:

1. **No model is involved** — the tool calls come from the scenario plugin, not an assistant
   turn, so the acceptance says nothing about model behaviour.
2. **The Stop checks use a stub agent** recording `steer()` calls; the real loop's acceptance of
   the message shape is unverified and needs a live turn.
3. **The calls are agent-less**, so `ask` is exercised only in its "cannot be routed" form,
   which the adapter turns into `authorization_unavailable`.
4. **The active profile was never read or written** and the global `node_modules` was never
   edited.

The acceptance also found four real defects in this repository's own code, all fixed — the
bridge's `policy: never` reason text did not contain the literal `authorization_unavailable` it
set as a field; an `ask` with no agent to route it produced the harness's own message instead of
ours; `writeClaim` could not carry `taskId`/`promptId`/`snapshotDigest`, so the anti-loop key
could only be a turn number; and the completion gate was invoked without `--collect`, so every
artifact criterion returned `no_observation` and no claim could ever be confirmed.
