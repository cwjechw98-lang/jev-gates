# DeepSeek Harness adapter

How `jev-gates` attaches to DSH, what it can enforce on the build it targets, and — at
least as important — what it cannot.

Every claim on this page was read out of the installed build and is cited with a file and a
line. The full investigation is in [`_dsh-runtime-findings.md`](_dsh-runtime-findings.md).
Where a fact could not be established, this page says so instead of guessing.

Verified against **DSH `0.1.5-rc.2`** on Windows, Node `v24.14.0`.

---

## Start here: ask the installation

```bash
node adapters/dsh/doctor.mjs
node adapters/dsh/doctor.mjs --json
node adapters/dsh/doctor.mjs --policy never
```

| exit | status | meaning |
|---|---|---|
| 0 | `healthy` | every capability the adapter claims is available |
| 1 | `degraded` | it runs, with reduced effect — read the capability rows |
| 2 | `misconfigured` | no `@deepseek-ai/dsh` installation was found |

The doctor reads, and writes nothing. It never starts a harness. Each capability row carries
a `verdict` (`verified`, `unavailable`, `not_mounted`, `conditional`), a `consequence`, and an
`evidence` citation.

`--policy` exists because the approval policy is often not stated in the configuration. The
doctor will not guess it: with no key in `settings.yaml` it reports `unknown` and marks the
"ask" capability `conditional`, because an unknown policy may turn an ask into a silent deny.

---

## The two integration paths

| | hook bridge (file dialect) | Cordis plugin (programmatic) |
|---|---|---|
| how it attaches | a composition row + a `hooks.json` | `ctx.on('tools/post-execute', …)` |
| sees a structured exit code | **no** | **yes** — `result.value.exitCode` |
| sees the tool call id | yes (`tool_use_id`) | yes (`exec.callId`) |
| can deny before the call | yes on paper; **unreachable on this build** | yes, and more precisely |
| can undo a side effect | no | no |
| needs host privileges | no | yes |
| mounted on this machine | **no** | `adapters/dsh/plugin.mjs` — runtime-verified |

The bridge is installed but **not mounted** on the investigated machine: no `hooks.json`
exists and no composition row references it. A package being present is not a row being
composed, and conflating the two is how a "supported" claim gets made about something that
never runs. That is why the doctor reports `not_mounted` rather than "installed".

The programmatic path is no longer hypothetical: `adapters/dsh/plugin.mjs` is the native Cordis
adapter, and it is runtime-verified for the tool pipeline, the guard surface and the Stop
handler (limits in "The supported path" below). For anything that depends on a tool's **exit
code**, this is also the only path that works — the bridge's payload carries the rendered tool
response as text only (`dsh-hooks-claude-code/lib/index.js:375-383`), while the Cordis event
carries the structured result (`dsh-tool-pwsh/lib/index.js:157-179`).

---

## What the bridge can and cannot do

### The protocol can deny — the shipped bridge cannot reach it

**Correction: an earlier root cause on this page is retracted.** This page first blamed a
missing `sandboxPolicy` injection in `@deepseek-ai/dsh-hooks-claude-code`, quoting
`cannot get property "sandboxPolicy" without inject`. That causal claim is **withdrawn as an
instrumentation artifact**. The string was produced by a diagnostic wrapper that re-entered
`ctx.shell` through a JavaScript `Proxy`. A Cordis service accessor is context-bound, so going
through a proxy makes the service resolve against the wrong context and throw an error the
uninstrumented code never hits. A probe that touched nothing reproduced the real message:
`cannot get required service "sandboxPolicy" in inactive context`. The old cause is retracted
explicitly, because a wrong root cause left standing is worse than no root cause.

**The real, measured cause.** On the composed profiles of this build the mounted `shell` service
is `SandboxPwshExecutor` (Windows) or `SandboxBashExecutor` (elsewhere). Its `resolve()` reads
`this.ctx.sandboxPolicy` (`dsh-pwsh-sandbox/lib/index.js:148`,
`dsh-bash-sandbox/lib/index.js:141`), and `this.ctx` resolves to the **calling** context — the
caller's `inject` set appears first in the chain. A caller that does not inject `sandboxPolicy`
therefore cannot use the executor at all. Measured, with no proxy:

| probe | result |
|---|---|
| `ctx.get('shell').ctx.fiber` | the **caller's** fiber, not the service's own |
| `shell.run(shell.resolve('node --version'))` | `{exitCode: 1, stdout: "", stderr: ""}` — a silent failure, no exception |
| `shell.run(shell.resolve(<write a file>))` | throws `cannot get required service "sandboxPolicy" in inactive context` |
| `runHook(ctx.shell, {command})` | stderr carries that text and **no hook process is ever spawned**; no marker file is written |

The same holds under `DSH_PERMISSION_MODE=workspace-write` and `danger-full-access`. The shipped
bridge injects only `["shell","sessionProjections"]`
(`dsh-hooks-claude-code/lib/index.js:114`), so on these profiles it cannot launch a hook — and
`runHook` turns the failure into an outcome with **no exit code and no decision**, the merge
yields `allow`, and the tool runs. Nothing reports it: a hook that cannot launch and a gate that
chose to stay silent produce byte-identical behaviour.

**Consequence.** `PreToolUse` enforcement through the **shipped bridge** is conditional and must
not be claimed as verified because a hook is registered. The adapter's `doctor` reports it as
`conditional`, and `docs/HARNESSES.md` carries the same caution. The reason is the unusable
executor, not a missing injection in the bridge.

### The supported path: the native Cordis adapter

`adapters/dsh/plugin.mjs` is a native Cordis plugin. It uses only documented harness interfaces
and needs **no `shell` service**, so the broken executor cannot affect it. It registers four
points:

- `ctx.tools.guard(fn)` — monotonic denial, cannot be force-allowed downstream
  (`dsh-tools/lib/index.js:2816`, contract at `lib/types/index.d.ts:610-620`);
- `tools/pre-execute` — waterfall `(exec, next)`; `next()` is **required** for pass-through, and
  returning `undefined` without it makes the registry throw rather than silently allow
  (`dsh-tools/lib/index.js:3116-3148`);
- `tools/post-execute` — `(exec, result, next)`;
- `agent/turn-stopping` — **serial, no `next`, and its return value is DISCARDED**: it cannot
  veto a stop (`dsh-agent-loop/lib/index.js:967`). The only lever is `agent.steer(message)`,
  which enqueues another step inside the same turn.

**Acceptance:** `node scripts/jev-dsh-acceptance.mjs` boots a throwaway `DSH_HOME` built from
`--from-default-profile headless` plus a `--patch` overlay, mounts the adapter beside
`adapters/dsh/scenarios.mjs`, and drives `ctx.tools.execute` — the same entry point the agent
loop uses — against a safe marker tool that only writes a file. Result: **verdict HELD, exit 0,
5 scenario sets, 24 checks, 0 failures**, ~2–3 s per set, harness `0.1.5-rc.2` on Node
`v24.14.0`. In the `enforce` set the marker tool does **not** run, no marker is written, and the
reason names `jev-gates`; an ordinary tool still runs, and a foreign guard's deny is not
weakened.

Runner failure classes, none of which is a pass: `boot-timeout`, `harness-not-driven`,
`listener-not-attached`, `tool-not-invoked`, `assertion-failed`. Exit codes: `0` held, `1`
not-held, `3` not-driven.

**What the acceptance does not prove** — these four limits travel with the result:

1. **No model is involved.** The tool calls come from the scenario plugin, not from an assistant
   turn: a model would need a paid API and a credential this work is not authorised to spend.
   The acceptance is about the tool pipeline, the guard surface and the Stop handler — not about
   model behaviour.
2. **The Stop checks drive `agent/turn-stopping` with a stub agent** that records `steer()`
   calls. That verifies this adapter's handler; it does not verify that the real agent loop
   accepts the message shape, which needs a live turn.
3. **The acceptance runs agent-less tool calls.** The `ask` path is therefore exercised only in
   its "cannot be routed" form, which this adapter turns into `authorization_unavailable`. A real
   session with an agent would route the question instead.
4. **The active DSH profile was never read or written, and the global `node_modules` was never
   edited.** The shipped bridge remains unusable here; this adapter is a replacement, not a
   repair.

### It can deny

Two mechanisms work:

- **exit 2** → `output.decision = "block"`, with stderr as the reason
  (`dsh-hook-protocol/lib/index.js:105-108`).
- **`hookSpecificOutput.permissionDecision: "deny"`** with `hookEventName: "PreToolUse"`
  (`dsh-hook-protocol/lib/index.js:150-151`).

### It can ask

`permissionDecision: "ask"` routes the decision to the human
(`dsh-hooks-claude-code/lib/index.js:248-264`).

### The traps, and how this adapter avoids them

| trap | evidence | what the adapter does |
|---|---|---|
| A top-level `{"decision":"deny"}` is **silently ignored** — the top-level vocabulary is `approve`/`block` only | `dsh-hook-protocol/lib/index.js:77-89, 181-183` | it only ever emits `hookSpecificOutput.permissionDecision` |
| A `hookSpecificOutput` whose `hookEventName` does not match the firing point has **all** its fields discarded | `dsh-hook-protocol/lib/index.js:148-149` | it always names the event |
| `systemMessage` is logged as a warning and **not surfaced** | `dsh-hooks-claude-code/lib/index.js:193` | it never sends one; shadow mode writes nothing at all |
| `updatedInput` is parsed but **not honoured** | `dsh-hooks-claude-code/lib/index.js:192` | it never sends one |
| `{"continue": false}` alone does **not** block a turn | `dsh-hook-protocol/lib/index.js:264-267, 272-279` | it uses `decision: "block"` for Stop |
| Only exit 0 parses stdout, and only when it starts with `{` | `dsh-hook-protocol/lib/index.js:109-119` | stdout carries the JSON and nothing else; diagnostics go to stderr |

### It cannot see a structured exit code

`PostToolUse` runs **after** the tool and cannot undo the side effect. Its payload carries
`tool_use_id` and `tool_response` text, with no exit-code, stdout or error field
(`dsh-hooks-claude-code/lib/index.js:375-383`).

The adapter therefore reads a `[exit code: N]` marker out of the rendered text and labels the
result honestly:

```json
{ "exit": 0, "exitSource": "text_inference", "coverage": "partial",
  "note": "PostToolUse carries no structured exit code in this build; the value is inferred from rendered text" }
```

Partial coverage cannot confirm a criterion. A wrong inference can therefore never produce a
false `done` — it can only fail to confirm.

### It cannot veto a turn

`Stop` is a **serial listener that steers**, not a veto
(`dsh-hooks-claude-code/lib/index.js:292-308` → `dsh-agent-loop/lib/index.js:966-973`):

- the dispatch is skipped entirely when the next-step inbox is already non-empty;
- an aborted turn skips its effect;
- if the handler throws, nothing steers;
- the effect is one more step, and the turn closes as soon as the inbox drains.

`stop_hook_active` exists in the payload but is **hardcoded `false`** and never read from the
hook's output (`dsh-hooks-claude-code/lib/index.js:384-389`). There is no loop guard in the
build, so a Stop hook that always blocks would steer forever.

The adapter supplies the missing bound itself: after `JEV_DSH_MAX_STEERS` (default 2) it goes
quiet and records `incomplete: true` in its state. **It never claims to have vetoed a run.**

---

## Asking the human when approval is disabled

Under `approval policy = never` the harness returns `"rejected"` **before** the answerer
waterfall (`dsh-user-approval/lib/index.js:178`). An `ask` becomes an automatic **deny** with
the misleading reason `the user rejected tool "<name>"`.

Neither automatic answer is acceptable here:

- auto-allow would invent a permission nobody gave;
- auto-deny would be a silent block, which is the exact failure mode this project exists to
  remove.

So under `never` the adapter emits **no permission decision** and reports the real situation
through `additionalContext`, which this build does surface:

```
jev-gates: authorization_unavailable — approval policy is "never": an ask would become an
automatic deny, so no decision is emitted. The action was NOT authorised and NOT denied by
this gate.
```

The decision stays with the harness. The human still learns that authorisation was
unavailable. The state file records it.

---

## Configuration

| variable | values | default |
|---|---|---|
| `JEV_DSH_MODE` | `shadow` \| `enforce` | `shadow` |
| `JEV_DSH_POLICY` | `never` \| `ask` \| `unknown` | `unknown` |
| `JEV_DSH_STATE` | directory | `$JEV_GATES_HOME/dsh-state` |
| `JEV_DSH_MAX_STEERS` | integer | `2` |

**Shadow is the default on purpose.** It computes and records the decision it *would* have
made and enforces nothing, so the rules can be reviewed against real traffic before they are
allowed to interrupt anything.

The adapter is **narrow by design**: it speaks only about actions it recognises as
irreversible (`adapters/dsh/classify.mjs`). Silence means "this gate has nothing to say", so
another guard's deny stays in force — the harness folds decisions as `deny > ask > allow`
(`dsh-hook-protocol/lib/index.js:214-240`). A gate that questions every tool call is
unmounted within a day, and then it protects nothing.

State lives per session:

```
<state>/<session_id>.json                  counters, decisions, steer budget
<state>/<session_id>.observations.jsonl    one observation per PostToolUse
<state>/<session_id>.pending-claim         written by the caller: what is still unconfirmed
```

A session id that is not filesystem-safe is sanitised, so it cannot escape the state
directory.

---

## Installing the bridge

```bash
node adapters/dsh/install.mjs plan                 # dry run: shows the exact block
node adapters/dsh/install.mjs install --apply      # writes, after backing up
node adapters/dsh/install.mjs uninstall --apply
```

`--apply` is required. Without it nothing is written, because an installer that edits a live
harness configuration as a side effect of being run is an installer nobody should run.

The adapter owns a marked block (`# >>> jev-gates dsh adapter >>>` … `# <<< … <<<`) inside
`cordis.patch.yml`. Only that block is inserted or removed; the rest of the file — including
your formatting and other rows — is never rewritten. A backup is written **once** and never
overwritten, because the first backup is the only one that describes your original file.

Uninstall compares the file against the backup before restoring. If the file changed after
installation, the backup is **not** restored — that would silently discard your later edits.
Instead the installer removes only its own block and prints the differing lines.

---

## Enabling real enforcement

The bridge is not mounted by default and shadow mode is the default. To make the adapter
blocking on a machine where the build supports it:

1. `node adapters/dsh/doctor.mjs --policy <your real policy>` and read every capability row.
2. `node adapters/dsh/install.mjs plan` and read the block.
3. `install --apply`.
4. Watch it in shadow mode for a while; read `<state>/<session_id>.json` to see what it would
   have done.
5. Only then set `JEV_DSH_MODE=enforce`.

For exit-code-dependent gates, mount a Cordis plugin on `tools/post-execute` instead — see
`_dsh-runtime-findings.md` §7 for the event contracts. On this build that is not an
alternative but the only working path: the shipped bridge cannot launch a hook here, so
`adapters/dsh/plugin.mjs` is the supported adapter, and the installer's bridge block is for
builds where the mounted executor can be driven.

---

## Limits, stated plainly

- **The shipped bridge enforces nothing here.** It is not mounted, and on this build it could
  not launch a hook even if it were. The **native adapter** is runtime-verified for the tool
  pipeline, the guard surface and the Stop handler — but only subject to the four limits in
  "The supported path" above.
- **`Stop` cannot veto.** `agent/turn-stopping` is serial, takes no `next`, and its return value
  is discarded (`dsh-agent-loop/lib/index.js:967`); the adapter steers, and the turn closes when
  the inbox drains.
- **No undo.** `PostToolUse` runs after the effect.
- **Textual exit codes through the bridge.** Partial coverage, never confirming on its own.
- **Misdeclaration defeats the approval rules.** An action described as safe but destructive
  passes the classifier. Describing the action honestly is part of the work.
- **Not a security boundary.** The adapter can be unmounted by anyone who can edit the
  composition, and its state files are ordinary files. See `docs/DESIGN.md`.

## Unresolved

Recorded rather than papered over:

- **No live-model acceptance was run.** The isolated acceptance drives the real tool pipeline
  with no model and no assistant turn, so two things stay unproven: whether the real agent loop
  accepts the `agent.steer` message shape the Stop handler emits, and whether `ask` routes to a
  human in a live session. Both need a paid credential this work was not authorised to spend.
- No live end-to-end run of the **bridge** inside a harness session was performed for this
  repository, and on this build none is possible: the mounted executor cannot be driven by a
  caller that does not inject `sandboxPolicy`. The bridge limitation is recorded as an
  unresolved limitation of the installed build, not of this repository.
- Whether anything bounds repeated `Stop` steering in the build itself was not established. The
  adapter supplies its own bound.
- The session's stored `approval/policy` event was not read — session logs were left untouched.
