# DSH 0.1.5-rc.2 — Native Cordis Plugin Interfaces (read-only investigation)

Install root: `<DSH install root>`
Nested packages: `<install>\node_modules\@deepseek-ai\`
Version: `0.1.5-rc.2` (install `package.json`)
Method: read-only inspection of the installed JS + `.d.ts`, plus four inline `node --input-type=module -e` reproductions against the installed `@deepseek-ai/cordis`. No files outside this document were written; no DSH server was started.

Legend: **[V]** = verified by reading code (or by executing a reproduction). **[I]** = inferred from verified code.

---

## 1. `tools/pre-execute` waterfall

**Event name:** `tools/pre-execute` (exact string).

**Declaration** — `dsh-tools/lib/types/index.d.ts:38` **[V]**:
```ts
'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
```
`dsh-tools/lib/types/index.d.ts:36` marks it `@mode waterfall`.

**Dispatch site** — `dsh-tools/lib/index.js:3116` **[V]** (inside `ToolRuntime.prepareExecution`):
```js
const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
```
`carrier` is built one line earlier, `dsh-tools/lib/index.js:3115`: `const carrier = scopeTarget(this, exec.agent);`

**Arguments passed:** `(exec, next)`.
- `exec` is a `ToolExecution` = `ToolExecutionInput` + `{rootCallId, token}`. Fields (`dsh-tools/lib/types/index.d.ts:197-221`, `:261-266`): `callId`, `rootCallId?`, `name`, `arguments` (losslessly JSON-serializable parsed args), `agent?`, `parent?`, `signal` (AbortSignal), `token`.
- `next` is the innermost continuation; calling it with no arguments delegates to the registry's default `() => Promise.resolve({ kind: "allow" })`.

**Listener signature in practice** — `dsh-hooks-claude-code/lib/index.js:248` **[V]**:
```js
ctx.on("tools/pre-execute", async (exec, next) => {
```

**Accepted return contract** — `PreToolDecision`, `dsh-tools/lib/types/index.d.ts:419-427` **[V]**:
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
- **(a) deny** → return `{ kind: 'deny', reason: <string> }`. The registry materializes an error result whose text is `Error: <reason>` (`dsh-tools/lib/index.js:3127-3139`, quoted below).
- **(b) ask the human** → return `{ kind: 'ask', reason?: <string> }`. Only `kind:'ask'` routes to the approval service (`dsh-tools/lib/index.js:3117`), which is consumed opportunistically via `ctx.get('approval')` (`:3315`). With no approval service, an agent-less call, or a non-grant outcome, `ask` degrades to `deny` (`:3316-3362`).
- **(c) pass through** → `return next()`.

**Code that interprets the return value** — `dsh-tools/lib/index.js:3116-3148` **[V]**:
```js
3116			const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
3117			const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : {
3118				decision: gate,
3119				approvalCancelled: false
3120			};
3121			const { decision } = askResolution;
...
3127			const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
3128			if (denialReason !== void 0) return await next({
3129				kind: "post-result",
3130				exec,
3131				result: this.materializeFinalResult({
3132					content: [{
3133						type: "text",
3134						text: `Error: ${denialReason}`
3135					}],
3136					isError: true,
3137					error: { message: denialReason }
3138				})
3139			});
...
3145			return await next({
3146				kind: "dispatch",
3147				exec
3148			});
```
Note `:3127`: an `allow` decision still consults `this.guardReason(exec)`, so a registered `tools.guard()` can deny even after every waterfall listener allowed.

**Is `next()` required for pass-through?** Yes. **[V]** — `cordis/lib/index.js:307-325`:
```js
307	/**
308	* Compose listeners around the final `next` callback.
309	*
310	* The last dispatch argument is treated as the innermost `next`. Listeners
311	* run outermost-first; a listener that does not call `next()` vetoes the
312	* rest of the chain, including the built-in behavior.
...
317	waterfall(...args) {
318		const cbs = this.dispatch("waterfall", args);
319		const inner = args.pop();
320		const next = () => {
321			return (cbs.shift() ?? inner)(...args);
322		};
323		args.push(next);
324		return next();
325	}
```

**What happens if a listener returns `undefined` without calling `next()`** — the chain stops, and the registry then **throws**, turning the call into an error result. **[V] for the control flow, [I] for the exact TypeError text:**
- `waterfall` returns whatever the outermost listener returned (`cordis/lib/index.js:324`, and `:315` "Returns the outermost listener's return value"). A listener that returns `undefined` without calling `next()` makes `gate === undefined`.
- `dsh-tools/lib/index.js:3117` then evaluates `gate.kind`, which throws `TypeError: Cannot read properties of undefined (reading 'kind')`.
- That throw is caught by the surrounding `try` at `dsh-tools/lib/index.js:3114` / `catch` at `:3149-3155`:
```js
3149		} catch (error) {
3150			return next({
3151				kind: "final-result",
3152				exec,
3153				result: toolErrorResult(error)
3154			});
3155		}
```
So it is **not** a silent allow and **not** a clean deny: it is an unclassified error result. A deny must be expressed as `{ kind: 'deny', reason }`.

---

## 2. `tools/post-execute`

**Event name:** `tools/post-execute`.

**Declaration** — `dsh-tools/lib/types/index.d.ts:61` **[V]**:
```ts
'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>;
```
`@mode waterfall` (`dsh-tools/lib/types/index.d.ts:59`).

**Dispatch site** — `dsh-tools/lib/index.js:3378` **[V]** (inside `ToolRuntime.postExecute`):
```js
const decision = await this.ctx.waterfall(scopeTarget(this, exec.agent), "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
```

**Arguments:**
- `exec` — "the call that just ran (name, parsed arguments, caller agent)" (`dsh-tools/lib/types/index.d.ts:57`). Same `ToolExecution` shape as §1.
- `result` — `Readonly<ToolExecutionResult>` = `ToolExecutionSuccess | ToolExecutionFailure` (`dsh-tools/lib/types/index.d.ts:412`). A failure carries `isError: true` and `error`; a success carries `value`/`content` (`:405-410`). The doc adds: "thrown tools still reach this waterfall as errors" (`:52`).
- `next` — default `() => Promise.resolve({ kind: "accept" })`.

**Listener signature in practice** — `dsh-hooks-claude-code/lib/index.js:265` **[V]**:
```js
ctx.on("tools/post-execute", async (exec, result, next) => {
```

**Accepted return contract** — `PostToolDecision`, `dsh-tools/lib/types/index.d.ts:432-446` **[V]**:
```ts
export type PostToolDecision = {
    kind: 'accept';
    content?: ContentBlock[];
    value?: never;
    additionalContexts?: UserMessage[];
} | {
    kind: 'accept';
    value: JsonValue;
    content?: never;
    additionalContexts?: UserMessage[];
} | {
    kind: 'block';
    feedback: ContentBlock[];
    additionalContexts?: UserMessage[];
};
```
- **observe-only** → `return next()` (or `return { kind: 'accept' }`).
- **replace projection** → `{ kind:'accept', content }` (replace rendered content) or `{ kind:'accept', value }` (replace structured value, successes only).
- **block** → `{ kind:'block', feedback: ContentBlock[] }` turns the call into `isError: true` with `feedback` as content (`dsh-tools/lib/index.js:3380-3387`).
- Either decision may attach `additionalContexts`, ferried for the loop's active-batch FIFO (`dsh-tools/lib/index.js:3379`, `:3390`).

**Interpretation code** — `dsh-tools/lib/index.js:3377-3405` **[V]**:
```js
3377	async postExecute(exec, result) {
3378		const decision = await this.ctx.waterfall(scopeTarget(this, exec.agent), "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
3379		const decisionContexts = decision.additionalContexts ?? [];
3380		if (decision.kind === "block") {
3381			const message = failureMessageFromContent(decision.feedback);
3382			return this.markCanonical(exec, {
3383				content: decision.feedback,
3384				isError: true,
3385				error: { message },
...
3389		if (Object.hasOwn(decision, "content") && Object.hasOwn(decision, "value")) throw new TypeError("tools/post-execute accept decision cannot replace both value and content");
...
3392			if (result.isError) throw new TypeError("tools/post-execute cannot replace the value of a failed result");
```
A listener that throws is contained: the doc comment at `dsh-tools/lib/index.js:3375` states "Runs inside `execute`'s outer try/catch (a throwing listener → isError)."

---

## 3. Turn stopping (`agent/turn-stopping`) and `agent.steer`

**Exact event name:** `agent/turn-stopping`.

**Declaration** — `dsh-agent/lib/types/runtime-types.d.ts:396-400` **[V]**:
```ts
'agent/turn-stopping'(this: Scoped<Agent>, payload: {
    agent: Agent;
    turn: number;
    signal: AbortSignal;
}): Promise<void> | void;
```
**Mode: `serial`**, not waterfall — `dsh-agent/lib/types/runtime-types.d.ts:394` (`@mode serial`). The listener therefore has **no `next` parameter**.

**Dispatch site** — `dsh-agent-loop/lib/index.js:966-973` **[V]**:
```js
966				if (turnEnds && this.inbox.nextStep.length === 0) {
967					await this.dispatch.serial("agent/turn-stopping", {
968						turn,
969						signal
970					});
971					signal.throwIfAborted();
972				}
973				if (turnEnds && this.inbox.nextStep.length === 0) break;
```
Note the literal payload passed is only `{ turn, signal }`.

**Where `agent` comes from** — `dsh-agent/lib/index.js:209-234` **[V]**: `AgentLoop.dispatch` is built by `agentEvents`, which injects the subject into every payload:
```js
210	const fused = (payload) => ({
211		...payload,
212		agent
213	});
...
231		async serial(name, payload) {
232			const serial = ctx.serial;
233			return await serial(carrier, name, fused(payload));
234		},
```
So a listener really receives `{ agent, turn, signal }`.

**Where the result is interpreted:** **nowhere.** `dsh-agent-loop/lib/index.js:967` is a bare `await` — the return value is discarded. `ctx.serial` only returns a value when a listener returns something `isBailed` (`cordis/lib/index.js:289-294`), and even then the loop ignores it. **A listener cannot veto the stop by returning a value.** **[V]**

**How a listener causes an extra step instead:** it calls `agent.steer(message)`, which enqueues into `inbox.nextStep`; the loop then re-reads the inbox at `:973` and, finding it non-empty, does not `break` — it sets `target = "next-step"` (`:974`) and runs another step **inside the same turn**.

`AgentLoop.steer` — `dsh-agent-loop/lib/index.js:792-794` **[V]**:
```js
792	steer(input) {
793		this.send(input, "next-step", true);
794	}
```
`send` — `dsh-agent-loop/lib/index.js:783-788` **[V]**:
```js
783	send(message, target, wakeup) {
784		const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
785		const resolvedTarget = wakingAfterAbort ? "next-turn" : target;
786		this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
787		if (wakeup) this.wakeDriver(wakingAfterAbort);
788	}
```
So `agent.steer(msg)` = append `msg` at the end of the `next-step` inbox boundary and wake the driver if it is idle. The argument is a `UserMessage` (`dsh-agent/lib/types/runtime-types.d.ts:200`: `steer(message: UserMessage): void;`).

**Documented contract** — `dsh-agent/lib/types/runtime-types.d.ts:379-389` **[V]**:
```
* The turn is about to close: the model owes no response (no live tool
* calls, no fresh steering). Awaited before the boundary commits — a
* listener that objects steers (`agent.steer(...)`) and the machine
* re-reads its inbox: fresh steering runs another step, none closes the
* turn. Data decides, so listener order cannot change the outcome.
```

**Reference implementation** — `dsh-hooks-claude-code/lib/index.js:292-308` **[V]**:
```js
292	ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
293		const merged = await runPoint("Stop", "", stopPayload(agent), {
294			agent,
295			turn,
296			signal
297		});
298		if (merged.decision === "deny") {
299			const text = merged.reason ?? "continue: blocked by Stop hook";
300			agent.steer(createUserMessage({
301				content: [{
302					type: "text",
303					text
304				}],
305				source: PLUGIN_SOURCE
306			}));
307		}
308	});
```

**Agent surface used here** (`dsh-agent/lib/types/runtime-types.d.ts:139-209`) **[V]**: `readonly session: Session` (`:143`), `readonly ctx: Context` (`:149`), `send(message, target, wakeup)` (`:186`), `followup(message)` (`:192`), `steer(message)` (`:200`), `inject(message)` (`:209`).

---

## 4. Services a plugin can read

All eight are Cordis services resolved through the context proxy. `ctx.<name>` requires `inject` on the reading plugin; `ctx.get('<name>')` does not (it returns `undefined` when absent — reproduced: `ctx.get("dep")` → `undefined`).

| `ctx` property | Providing package | Class / registration | Main methods (file:line) |
|---|---|---|---|
| `agents` | `@deepseek-ai/dsh-agent` | `AgentRegistry`, `dsh-agent/lib/index.js:299` `super(ctx, "agents");`; typing `dsh-agent/lib/types/index.d.ts:20` `agents: AgentRegistry;` | `create(options)` `:417`, `resume(options)` `:430`, `register(agent)` `:455`, `enter(agent, owner)` `:476`, `get(id)` `:563`, `list()` `:581`, `roots()` `:590`, `withInitiator(agent, operation)` `:364`, `currentInitiator()` `:334`, `isOwnedBy(id, owner)` `:574` |
| `sessions` | `@deepseek-ai/dsh-session` | `SessionStore`, `dsh-session/lib/index.js:1315` `super(ctx, "sessions");` | `create(id, options)` `:1347`, `prepare(id, options)` `:1374`, `get(id)` `:1555`, `list()` `:1562`, `fork(source, boundary, childSessionId)` `:1579`, `flush(session)` `:1526`, `liveEntryFor(session)` `:1545` |
| `sessionProjections` | `@deepseek-ai/dsh-session-projection` | `SessionProjectionRegistry`, `dsh-session-projection/lib/index.js:52` `super(ctx, "sessionProjections");` | `register(definition)` `:68`, `onChanged(listener)` `:110`, `stateOf(session, key)` `:127`, `snapshot(session, keys)` `:142`, `cachedSnapshot(session, keys)` `:165`, `checkpoint(session)` `:196`, `restoreFloor(checkpoint)` `:224`, `viewCheckpoint(checkpoint, keys)` `:244`, `restore(...)` `:287`, `hydrate(...)` `:330` |
| `tools` | `@deepseek-ai/dsh-tools` | `ToolRuntime`, `dsh-tools/lib/index.js:2606` `super(ctx, "tools");`; `static inject = ["systemPrompt"]` at `:2568` | `register(definition): () => void` `lib/types/index.d.ts:601`, `guard(guard: ToolGuard): () => void` `:620` (impl `lib/index.js:2816`), `execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>` `:730`, `restrict(...)` impl `lib/index.js:~2790` |
| `loader` | `@deepseek-ai/cordis-plugin-loader` | `Loader extends EntryTree`, `name = "loader"` at `lib/index.js:671`, registered at `:684` `ctx.reflect.provide("loader", this, this[Service.check]);` | `resolve(id)` `:206`, `resolveGroup(id)` `:218`, `resolveParent(id)` `:226`, `entries()`/tree accessors `:235-246`, `import(name, getOuterStack)` `:270` |
| `shell` | abstract `@deepseek-ai/dsh-shell` (`ShellExecutor`); mounted by `@deepseek-ai/dsh-pwsh-local`, `@deepseek-ai/dsh-pwsh-sandbox`, `@deepseek-ai/dsh-bash-local` | `dsh-shell/lib/index.js:86` `super(ctx, "shell");`; typing `dsh-shell/lib/types/index.d.ts:26` `shell: ShellExecutor;` | `abstract resolve(request: ShellExecRequest): ShellExecSpec` `dsh-shell/lib/types/index.d.ts:62`, `abstract run(spec): Promise<ShellRunResult>` `:69`, `abstract start(spec): ShellProcess` `:75` |
| `subprocess` | `@deepseek-ai/dsh-subprocess-local` (`LocalSubprocessRuntime`), seam defined by `@deepseek-ai/dsh-subprocess` | `dsh-subprocess/lib/index.js:88` `super(ctx, "subprocess");` | `resolveExecutable(command, env?, signal?): Promise<string>` `dsh-subprocess/lib/types/index.d.ts:88`, `spawn(spec: SubprocessSpawnSpec): SubprocessHandle` `:96`, `spawnTerminal(spec): Promise<SubprocessTerminalHandle>` `:104` |
| `sandboxPolicy` | `@deepseek-ai/dsh-sandbox-policy` | `SandboxPolicyService`, `dsh-sandbox-policy/lib/index.js:96` `var SandboxPolicyService = class extends Service {`; `static inject = ["sessionProjections"];` `:105` | `resolve(request = {})` `:141`, `defaultMode` field `:107`/`:112`, context renderer `:127` |

### `sessionProjections` and turn-tied event recording

**Important correction:** `appendHookInvoked` / `appendHookResult` in `dsh-hook-protocol` do **not** use `sessionProjections`. They call `session.append(type, data)` directly on `agent.session`.

`dsh-hook-protocol/lib/index.js:316-324` **[V]**:
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
```
`dsh-hook-protocol/lib/index.js:332-344` **[V]**:
```js
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
The `turn` is passed in by the caller, which reads it from `sessionProjections` — `dsh-hooks-claude-code/lib/index.js:341` **[V]**:
```js
	return ctx.sessionProjections.stateOf(agent.session, "turnBoundary").lastTurn;
```
and the session object is `agent.session` — `dsh-hooks-claude-code/lib/index.js:174` **[V]**: `const session = opts.agent?.session;`

**So a plugin records a turn-tied event by: `ctx.sessionProjections.stateOf(agent.session, "turnBoundary").lastTurn` for the turn number, then `agent.session.append("<type>", { turn, ...payload })`.** The invariant that such events stay turn-enclosed is enforced by `dsh-tools/lib/invariant.js:68-83` style stage checks and by the hook protocol's own doc (`dsh-hook-protocol/lib/index.js:283-288`).

`Session.append` — `dsh-session/lib/index.js:1170` **[V]**: `append(type, data, ...opts) {`.

---

## 5. Subprocess without `shell`

**Can a plugin use `node:child_process` directly? Yes — the harness does it itself.** **[V]** Direct `node:child_process` imports exist in shipped packages:

| File:line | Import |
|---|---|
| `dsh-host-open-in-app/lib/index.js:5` | `import { spawn } from "node:child_process";` |
| `dsh-host-directory-picker-native/lib/index.js:3` | `import { spawn } from "node:child_process";` |
| `dsh-native-command/lib/index.js:1` | `import { execFile } from "node:child_process";` |
| `dsh-subprocess-local/lib/index.js:7` | `import { execFile, spawn, spawnSync } from "node:child_process";` |
| `dsh-sandbox-local/lib/index.js:1` | `import { spawnSync } from "node:child_process";` |
| `dsh-web-app/lib/index.js:2` | `import { spawn } from "node:child_process";` |
| `node-addon-system/lib/index.js:16` | `import { spawnSync } from 'node:child_process';` |

**Harness-sanctioned alternative: `ctx.subprocess`.** **[V]**
- Seam package `@deepseek-ai/dsh-subprocess` registers nothing itself; it defines the abstract service. `dsh-subprocess/lib/index.js:88`: `super(ctx, "subprocess");`
- Implementation `@deepseek-ai/dsh-subprocess-local` exports `LocalSubprocessRuntime` as default (`dsh-subprocess-local/lib/index.js:1084`) and the class extends the abstract runtime (`:927-928`: `constructor(ctx) { super(ctx);`).
- Interface (`dsh-subprocess/lib/types/index.d.ts:88-104`, quoted in §4): `resolveExecutable(command, env?, signal?)`, `spawn(spec)`, `spawnTerminal(spec)`.
- `SubprocessSpawnSpec` (`dsh-subprocess/lib/types/types.d.ts:67-97`): `{ argv: readonly string[]; cwd: string; stdio: SubprocessStdio; graceMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }`. **"This seam applies no defaults: every disposition, limit, and directory is explicit"** (`:62-65`).
- Environment is scrubbed: `scrubbedParentEnv()` is exported (`dsh-subprocess/lib/types/index.d.ts:40`) and `env` entries are "merged onto the implementation's scrubbed parent base" (`types.d.ts:90-96`).

**Expected practice [I]:** the harness convention is to use `ctx.subprocess` for managed child processes (it gives the registry-owned process range, cancellation, teardown, and env scrubbing), and `node:child_process` directly only where that seam does not fit — the six shipped examples above are exactly such cases (native pickers, opening an external app, the subprocess provider's own bootstrap). Nothing in the installed code forbids `node:child_process` in a plugin; there is no lint or runtime guard I found. **NOT FOUND:** any explicit written policy requiring `ctx.subprocess` over `node:child_process`.

---

## 6. The `sandboxPolicy` failure

### The lines you asked for

`dsh-pwsh-sandbox/lib/index.js:145-150` **[V]**:
```js
145	resolve(request) {
146		return {
147			...super.resolve(request),
148			sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
149		};
150	}
```
`dsh-pwsh-sandbox/lib/index.js:119-123` **[V]**:
```js
	static inject = [
		"subprocess",
		"sandbox",
		"sandboxPolicy"
	];
```
`dsh-bash-sandbox/lib/index.js:138-142` **[V]** — the same read:
```js
138	resolve(request) {
139		return {
140			...super.resolve(request),
141			sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
142		};
143	}
```
`dsh-bash-sandbox/lib/index.js:112-115` **[V]**:
```js
	static inject = [
		"subprocess",
		"sandbox",
		"sandboxPolicy"
	];
```
`dsh-hooks-claude-code/lib/index.js:114` **[V]**:
```js
const inject = ["shell", "sessionProjections"];
```

### The throw site in cordis

`cordis/lib/index.js:671-698` **[V]** — the context proxy `get` trap:
```js
671	static handler = {
672		get: (target, prop, ctx) => {
673			if (isSpecialProperty(prop)) return Reflect.get(target, prop, ctx);
674			if (Reflect.has(target, prop)) return getTraceable(ctx, Reflect.get(target, prop, ctx));
675			const error = /* @__PURE__ */ new Error(`cannot get property "${prop}" without inject`);
676			try {
677				const def = target.reflect.props[prop];
678				if (def?.type === "accessor") return def.get.call(ctx, ctx[symbols.receiver], error);
679				if (!ctx.fiber.runtime) return ctx.reflect.get(prop, false);
680				return ctx.events.waterfall("internal/get", ctx, prop, error, () => {
681					const key = target[symbols.isolate][prop];
682					let fiber = (ctx[symbols.shadow] ?? ctx).fiber;
683					while (true) {
684						const impl = fiber.store?.[prop];
685						if (impl) return getTraceable(ctx, impl.value);
686						if (prop in fiber.inject) {
687							error.message = `cannot get required service "${prop}" in inactive context`;
688							throw error;
689						}
690						if (!fiber.runtime) throw error;
691						if (fiber.parent[symbols.isolate][prop] !== key) throw error;
692						fiber = fiber.parent.fiber;
693					}
694				});
695			} catch (e) {
696				throw e === error ? enhanceError(e) : e;
697			}
698		},
```
- **Message constructed:** `cordis/lib/index.js:675`.
- **Thrown:** `cordis/lib/index.js:690` (`if (!fiber.runtime) throw error;` — the root fiber has `runtime` null, `cordis/lib/index.js:1101-1105`) or `:691` (isolate-label mismatch).
- **Stack enhanced:** `cordis/lib/index.js:696`.

### Verdict on the stated chain

> "the bridge calls `shell.resolve()`, `resolve()` reads `this.ctx.sandboxPolicy`, and the bridge never injected `sandboxPolicy`, so the Cordis service proxy throws `cannot get property "sandboxPolicy" without inject`"

**REFUTED — the first three steps are VERIFIED, the causal step is not.** **[V]**

Reading `this.ctx.<dep>` inside a service method does **not** resolve against the caller's context. `cordis/lib/index.js:111-116` builds a "shadow" that carries the **service's own** ctx:
```js
111	function createShadow(ctx, target, property, receiver) {
112		if (!property) return receiver;
113		const origin = Reflect.getOwnPropertyDescriptor(target, property)?.value;
114		if (!origin) return receiver;
115		return withProp(receiver, property, ctx.extend({ [symbols.shadow]: origin }));
116	}
```
with `property` = `tracker.property` = `"ctx"` (`cordis/lib/index.js:1773-1776`) and `origin` = the service instance's **own** `ctx` property (`Service` constructor, `cordis/lib/index.js:1769-1770`: `this.ctx = ctx;`). The get trap then starts its walk from that provider ctx (`cordis/lib/index.js:682`: `let fiber = (ctx[symbols.shadow] ?? ctx).fiber;`).

**Executed reproduction (against the installed cordis, no files written):**
```
A(consumer injects only svc) -> dep-ok
B(consumer injects svc+dep) -> dep-ok
```
A `Service` subclass with `static inject = ["dep"]` whose method does `this.ctx.dep.hello()` works even when the *calling* plugin injects only the outer service and never `dep`.

**The premise becomes true only when the service instance has no own `ctx` property** (so `createShadow` bails at `:114` and `this.ctx` falls back to the caller's ctx). Reproduced:
```
H(no own ctx on service) -> THROW: cannot get property "dep" without inject
```
`PwshLocalExecutor` does have an own `ctx`: `dsh-pwsh-local/lib/index.js:222-223` `constructor(ctx, config) { super(ctx);` → `ShellExecutor` → `dsh-shell/lib/index.js:86` `super(ctx, "shell");` → `Service` constructor sets `this.ctx`. `dsh-pwsh-sandbox/lib/index.js:132-135` likewise calls `super(ctx, config)` and then reads `ctx.sandboxPolicy.defaultMode` at `:134`. Also note that `static inject` **is** honored for class plugins (`dsh-tools/lib/index.js:2568` relies on it).

**Consequence [I]:** the missing `sandboxPolicy` in `dsh-hooks-claude-code`'s `inject` is **not** by itself sufficient to produce that error, and I could not reproduce the reported failure from the installed sources alone. If the error was observed for real, the cause lies elsewhere — the most likely candidates, in order, are (i) the mounted `shell` service is not the sandbox executor at all in that composition, (ii) something reads `ctx.sandboxPolicy` **on the bridge's own ctx** (a caller-side read, which does throw — reproduced as case `D`), or (iii) the sandbox executor is provided through a path that produces an instance without an own `ctx`. **I did not verify which, and I will not guess.** What is certain: the identical message is produced whether the *caller* or the *service* forgot the injection (reproduced cases `C` and `D` both print `cannot get property "dep" without inject`), so the message alone cannot discriminate the two.

---

## 7. Would injecting `sandboxPolicy` in a third-party plugin fix it?

**Yes, but not for the reason stated in §6 — and it is not the mechanism that would be needed if the §6 premise were true.** **[V]**

Cordis resolution is **caller-relative only when the service has no own `ctx`**; otherwise it is provider-relative (§6). Two independent answers:

**(a) If the third-party plugin calls `shell.resolve()` directly** — it does **not** need `sandboxPolicy` in its own `inject`. The service's own shadow carries the provider ctx, and the provider already declares `sandboxPolicy` (`dsh-pwsh-sandbox/lib/index.js:119-123`). Reproduced as case `A`/`G` above (`G` also covers the nested-shadow case):
```
G(nested shadow) -> ok
```
So adding `sandboxPolicy` to the caller's `inject` is unnecessary here.

**(b) If the third-party plugin reads `ctx.sandboxPolicy` itself** — then `inject: ['sandboxPolicy']` is mandatory, and it works. Mechanism:
- `Fiber._checkImpl` resolves each injected name against the isolate-keyed registry and stores the impl on the fiber — `cordis/lib/index.js:1305-1315`:
```js
1305	_checkImpl(name) {
1306		const impl = this.ctx.reflect._getImpl(name, true);
1307		if (!impl) return delete this._store[name];
...
1314		this._store[name] = impl;
1315	}
```
  invoked per injected name at `cordis/lib/index.js:1098`: `for (const name of Object.keys(this.inject)) this._checkImpl(name);`
- `_reload` publishes the store — `cordis/lib/index.js:1349`: `this.store = { ...this._store };`
- The get trap finds it on the **first** iteration, before the inject check — `cordis/lib/index.js:684-685`:
```js
684					const impl = fiber.store?.[prop];
685					if (impl) return getTraceable(ctx, impl.value);
```
- `ctx.provide` writes into the provider's own fiber store — `cordis/lib/index.js:814`: `this.ctx.fiber.store[name] = impl;`

So a plugin whose `inject` lists `sandboxPolicy` can read `ctx.sandboxPolicy`; a plugin that does not must use `ctx.get('sandboxPolicy')` and handle `undefined`.

**Scoping caveat [V]:** the walk is bounded by isolate labels — `cordis/lib/index.js:691`: `if (fiber.parent[symbols.isolate][prop] !== key) throw error;` — and each name gets a global isolate key at `cordis/lib/index.js:804`: `this.ctx.root[symbols.isolate][name] ??= Symbol(name);`. A plugin mounted inside an `isolate` realm for `sandboxPolicy` would see that realm's provider, not the outer one.

---

## 8. Overlay composition

**Composition order** — `dsh-app-boot/lib/index.js:288-299` **[V]**: a profile is `package.json` (`dsh.profile` with an ordered `bundles` list) + a `cordis.patch.yml` user layer; "the tree is composed by applying each bundle's patch list in `dsh.profile.bundles` order over an empty entry list, then the profile's own patches, then any launcher layers (`--patch` files and flag-derived patches)."
`dsh-app-boot/lib/index.js:314` **[V]**: `const PROFILE_PATCH_FILENAME = "cordis.patch.yml";`
`lib/bin.js:53-55` **[V]**: `--patch` is a repeatable collector: `const patches = options.patch ?? [];` / `if (patches.includes("")) program.error("error: --patch needs a path");`
`lib/bin.js:150` **[V]**: `patchFiles: invocation.patches,` — the launcher layers are handed to boot after the profile layer.

### (a) Supported patch entry forms

The single implementation is `applyEntryPatches` — `dsh-app-boot/lib/index.js:59-108` **[V]**, whose doc at `:45-46` calls it "THE patch semantics of this include, shared by mounting (`applyPatches`) and offline config tooling (`dsh --dump-config`) so a dump can never drift from what boots":
```js
59	function applyEntryPatches(data, patches, warn) {
60		data = structuredClone(data);
61		if (!patches?.length) return data;
62		const entryMap = /* @__PURE__ */ new Map();
63		const buildMap = (entries) => {
64			for (const entry of entries) {
65				if (entry.id) entryMap.set(entry.id, entry);
66				if (entry.group && Array.isArray(entry.config)) buildMap(entry.config);
67			}
68		};
69		buildMap(data);
70		for (const patch of patches) {
71			const { id, insert, name, ...overrides } = patch;
72			if (insert) {
73				if (id) {
74					const target = entryMap.get(id);
75					if (!target) {
76						warn("patch insert: entry %C not found", id);
77						continue;
78					}
79					if (!target.group) {
80						warn("patch insert: entry %C is not a group", id);
81						continue;
82					}
83					if (!Array.isArray(target.config)) target.config = [];
84					target.config.push(...insert);
85				} else data.push(...insert);
86				buildMap(insert);
87				continue;
88			}
89			if (!id) {
90				warn("patch: id is required for non-insert patches");
91				continue;
92			}
93			const target = entryMap.get(id);
94			if (!target) {
95				warn("patch: entry %C not found", id);
96				continue;
97			}
98			if (name && name !== target.name) {
99				warn("patch: name mismatch for %C (expected %C, got %C), skipping", id, target.name, name);
100				continue;
101			}
102			for (const [key, value] of Object.entries(overrides)) {
103				if (key === "id") continue;
104				target[key] = value;
105			}
106		}
107		return data;
108	}
```

Three forms, all confirmed:
1. **id-targeted override** — `{ id: '<entry id>', config: {...} }`, or `{ id, disabled: true }`, or **any other key** (`:102-105` assigns every key except `id` verbatim onto the target row). Typed shape at `cordis-plugin-include/lib/types/index.d.ts:28-39`, which declares `config?`, `group?`, `disabled?`, `inject?`, `intercept?`, `isolate?` and `[key: string]: any`.
2. **`disabled: true`** — `{ id: '<id>', disabled: true }`, applied through the generic override loop at `:104`. Effective disabled state is also inherited from an owning group (`cordis-plugin-loader/lib/index.js:359-378`).
3. **`insert:` list** — `{ insert: [ ...entries ] }` appends to the root list (`:85`); `{ id: '<group id>', insert: [...] }` appends to that group's `config` (`:83-84`). Inserted entries are indexed immediately (`:86`), so "a later patch in the same list can target a row an earlier patch inserted" (`:51-53`).

A patch that matches nothing is a warning, not an error (`:75-77`, `:94-96`), and the whole list is parsed strictly — `dsh-app-boot/lib/index.js:1199` **[V]**: `if (!Array.isArray(parsed)) throw new Error(\`${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries\`);`

### (b) Can an id-targeted entry change a row's `name`?

**No.** **[V]** `name` is destructured out of the patch at `:71` (`const { id, insert, name, ...overrides } = patch;`) and is used **only as a guard** at `:98-101` — it must equal the target's current `name` or the patch is skipped with a warning. It never reaches the assignment loop at `:102-105`. The type declaration agrees: `name?: string;` sits next to `id?` in `PatchOptions` (`cordis-plugin-include/lib/types/index.d.ts:29-31`), and the doc at `dsh-app-boot/lib/index.js:1181` describes the format as "id-targeted config overrides and `insert` lists".

**Consequence:** a patch **cannot swap a package** on an existing row. To replace a plugin you must `disabled: true` the original row and `insert:` a new row with the desired `name` (in a group, or at the root). **[V]**

### (c) Is a row `name` allowed to be a relative path like `./x.mjs`, and what is it resolved against?

**Yes, for inserted entries.** **[V]** `dsh-app-boot/lib/index.js:1169-1178`:
```js
1169	/** Convert inserted filesystem paths to file URLs, anchoring relative paths beside the patch; keep assertion names literal. */
1170	function anchorInsertedPluginNames(patches, file) {
1171		const base = dirname(resolve(file));
1172		const visit = (entry) => {
1173			if (typeof entry.name === "string" && (isAbsolute(entry.name) || entry.name.startsWith("./") || entry.name.startsWith("../"))) entry.name = pathToFileURL(resolve(base, entry.name)).href;
1174			if (entry.group && Array.isArray(entry.config)) entry.config.forEach(visit);
1175		};
1176		for (const patch of patches) patch.insert?.forEach(visit);
1177		return patches;
1178	}
```
- Applies to `patch.insert` entries only, recursively through groups (`:1174`), and only to `name` values that are absolute, `./…`, or `../…` (`:1173`). Bare specifiers are left alone.
- **Resolved against the directory of the patch file that inserted them** — `const base = dirname(resolve(file));` (`:1171`), called from `parsePatchList` at `:1203` for both the profile layer and `--patch` overlays.

**For rows in a base `cordis.yml` (not inserted by a patch)** the resolution base is the including file's own directory — `dsh-app-boot/lib/index.js:140` **[V]**: `this.ctx.baseUrl = new URL(".", pathToFileURL(this.filename)).href;` — and relative names are imported against it in `cordis-plugin-loader/lib/index.js:275-278` **[V]**:
```js
275			else if (name.startsWith(".")) return await import(__rewriteRelativeImportExtension(
276				/* @vite-ignore */
277				new URL(name, this.ctx.baseUrl).href
278			));
```
**Note:** the anchoring at `:1170-1178` rewrites only `insert` entries, so a relative `name` on an **id-targeted override** would be a no-op anyway (and `name` is a guard, per (b)).

---

## 9. Environment manifest (SHA256)

Computed with `Get-FileHash -Algorithm SHA256` over the installed files. **[V]**

| SHA256 | Path |
|---|---|
| `236633296049129787E3E8DE705C5F7BADE2FD16A6554FF15AD0E9143CAC20A0` | `<install>\node_modules\@deepseek-ai\dsh-hooks-claude-code\lib\index.js` |
| `8B03C89ED6529049EB4FB567FFF6AD8D593E9405F1CC87487C446D8030BE98A3` | `<install>\node_modules\@deepseek-ai\dsh-hook-protocol\lib\index.js` |
| `77ABBC21DB4FC6D53BA29FF627EBA20C72F52109D8A9B16A7E010264B39338B8` | `<install>\node_modules\@deepseek-ai\dsh-pwsh-sandbox\lib\index.js` |
| `C6100B4EDBC71869E0207941B2DFE8D06FF90E332D502C4C9FE54E08339E555A` | `<install>\node_modules\@deepseek-ai\dsh-bash-sandbox\lib\index.js` |
| `AABA52BF5D0149355407642B3965C06977D1E9143F5C61BC19429ABBE6A11C5D` | `<install>\node_modules\@deepseek-ai\dsh-tools\lib\index.js` |
| `1729CDBF8EE40B17C8839E06BF96491490548559E11EF7E411271E0754E751C5` | `<install>\node_modules\@deepseek-ai\cordis\lib\index.js` |
| `0FF7F1D72C4E0CBE14001709C81E20A04B70464118A7F78568952988E28F2AC5` | `<install>\lib\bin.js` |

`<install>` = `<DSH install root>`

---

## 10. Minimum viable plugin

### Required exports for a plugin row

**[V]** The loader accepts "a function, class, or `{ apply }` object plugin" — `cordis/lib/index.js:1620`: `if (!callback) throw new Error("invalid plugin, expect function or object with an \"apply\" method, received " + typeof plugin);` and `:1613` (doc: "a function, class, or `{ apply }` object plugin"). Named exports are read off the module object by `unwrapExports` (`cordis-plugin-loader/lib/index.js:522`: `plugin = this.loader.unwrapExports(await this.parent.tree.import(this.options.name, this.getOuterStack));`).

- **`name`** — optional for behavior; used for diagnostics and for the row's `name` assertion in patches (§8b). The reference bridge exports it: `dsh-hooks-claude-code/lib/index.js:113` `const name = "hooks-claude-code";` and `:405` `export { Config, apply, inject, name };` **[V]**
- **`apply`** — **required** (the plugin body).
- **`inject`** — optional. `cordis/lib/index.js:1634`: `const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack);` — `Inject.resolve(undefined)` yields an empty map (`:1491`: `if (!inject) return result;`). **[V]**
- **`Config`** — **not required.** It is only stored on the runtime record and used to validate/resolve the row's `config` — `cordis/lib/index.js:1630` (`Config: plugin.Config`) and `:1346` (`return this.runtime ? resolveConfig(this.runtime, config) : config;`). A plugin with no `Config` still loads; the row's `config` is passed through unvalidated. The reference bridge declares one (`dsh-hooks-claude-code/lib/index.js:115-121`, a `z.object({...})`). **[V]**

### Must `inject` list every service used?

**Only the services accessed as `ctx.<name>`.** **[V]**
- `ctx.requiredService` without `inject` → the get trap throws `cannot get property "<name>" without inject` (`cordis/lib/index.js:675`; reproduced, case `D`).
- `ctx.get('<name>')` needs no `inject` and returns `undefined` when absent (`cordis/lib/index.js:762-764`; reproduced: `ctx.get("dep")` → `undefined`). It is the correct read for optional capabilities.
- An injected service also makes the fiber **wait** until the impl exists — `cordis/lib/index.js:1319-1327` (`_refresh` sets the epoch to `INACTIVE` when an injected impl is missing), so `inject` is a hard dependency, not just a permission.
- One exception worth knowing: a service method reading `this.ctx.<dep>` resolves against the **provider's** ctx when the service instance has an own `ctx` (§6/§7), so the caller need not inject that inner dependency.

### Smallest correct skeleton

Plain JS, ESM, no TypeScript, no build step. Save as e.g. `my-guard.mjs` and reference it from a row as `name: "./my-guard.mjs"` (resolved against the config/patch file's directory, §8c).

```js
// my-guard.mjs — minimal native Cordis plugin for DSH.
// Registers: a tools/pre-execute gate that can deny, a tools/post-execute
// observer, and an agent/turn-stopping reactor that can force another step.

/** Optional but useful: a stable identity for diagnostics and patch name-assertions. */
export const name = 'my-guard'

/**
 * Hard dependencies, read as `ctx.<name>` in apply().
 * `tools`       -> register/guard surface; also the owner of both waterfalls.
 * `agents`      -> optional here, but listed so the plugin waits for the registry.
 * Everything else is read with ctx.get() and handled when undefined.
 * `Config` is NOT required — omit it and the row's `config` passes through unvalidated.
 */
export const inject = ['tools', 'agents']

export function apply(ctx) {
  // ---- 1. tools/pre-execute: deny / ask / pass through -------------------
  // Waterfall mode: the listener MUST return next() to delegate downstream.
  // Returning undefined WITHOUT calling next() stops the chain and makes the
  // registry throw on `gate.kind`, turning the call into an unclassified error.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'bash' || exec.name === 'pwsh') {
      const command = String(exec.arguments?.command ?? '')
      if (/\brm\s+-rf\b/.test(command)) {
        return { kind: 'deny', reason: 'destructive command blocked by my-guard' }
      }
      // Escalate to the human instead of deciding:
      // return { kind: 'ask', reason: 'my-guard wants confirmation' }
    }
    return next() // pass through
  })

  // ---- 2. tools/post-execute: record an observation ----------------------
  // Waterfall mode. `next()` accepts the result unchanged; the return value
  // must be a PostToolDecision, so never return undefined.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (downstream.kind !== 'accept') return downstream
    try {
      const turn = ctx.get('sessionProjections')?.stateOf(exec.agent?.session, 'turnBoundary')?.lastTurn
      const session = exec.agent?.session
      if (session && turn !== undefined) {
        // Turn-tied durable record: append on the session, keyed by turn.
        session.append('my-guard/observed', {
          turn,
          tool: exec.name,
          isError: result.isError === true,
        })
      }
    } catch (error) {
      ctx.logger.warn(`my-guard: observation failed: ${String(error)}`)
    }
    return downstream
  })

  // ---- 3. agent/turn-stopping: react when a turn is about to close --------
  // SERIAL mode: no `next`. The return value is IGNORED — it cannot veto.
  // To force another step, steer a message; the loop re-reads its inbox and
  // runs one more step inside the same turn.
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (signal.aborted) return
    const needsWork = await someCheck(agent, turn)
    if (needsWork) {
      agent.steer({
        content: [{ type: 'text', text: 'my-guard: continue, outstanding work remains' }],
        source: { kind: 'plugin' },
      })
    }
  })
}

async function someCheck(agent, turn) {
  return false // replace with real logic; must not throw
}
```

**Notes that make this "smallest correct" rather than "smallest plausible":**
- `tools` is the service that owns both waterfalls; `ctx.on('tools/pre-execute', …)` registers on the event bus, not on the service, so a plugin *could* listen without `inject: ['tools']`. Listing it is a deliberate hard dependency so the plugin waits for the registry. Dropping it and using `ctx.get('tools')` is also valid.
- The `agent/turn-stopping` handler returns nothing meaningful — do not attempt to veto by return (§3).
- `agent.steer(...)` takes a `UserMessage`. The exact constructor is available in-repo as `createUserMessage` (`dsh-hooks-claude-code/lib/index.js` uses it at `:300`); the literal object above is the minimum shape the inbox consumes. **[I]** — I verified `steer` enqueues whatever it is given (`dsh-agent-loop/lib/index.js:783-788`) but did not verify the minimal `UserMessage` field set in this build.
- `session.append(type, data, ...opts)` is `dsh-session/lib/index.js:1170`; the event `type` must be one the session format accepts — `hook/invoked` and `hook/result` are the shipped examples. A bespoke type is **[I]** untested here.
- `ctx.logger` is a built-in service (`cordis/lib/index.js:1687`) and needs no `inject`.

---

## NOT FOUND

- Any written policy forbidding `node:child_process` in a plugin, or any runtime guard against it. (§5)
- Any code that interprets the return value of `agent/turn-stopping`. (§3 — the dispatch at `dsh-agent-loop/lib/index.js:967` discards it.)
- Any patch mechanism that changes an existing row's `name`. (§8b — `name` is a guard only.)
- The concrete cause of the reported `cannot get property "sandboxPolicy" without inject` failure in this deployment. (§6 — the stated chain is refuted by execution.) **Resolved after this document was written.** That string was an artifact of a diagnostic `Proxy` around `ctx.shell`; the real cause was established separately — the mounted sandboxed executor's `resolve()` reads `this.ctx.sandboxPolicy`, and `this.ctx` resolves to the **calling** context, which the shipped bridge does not inject it into. See `docs/_dsh-runtime-findings.md` §13 and `docs/DSH.md`. The measurements in §6 stand; the conclusion drawn from them there does not.
