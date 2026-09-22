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
| can deny before the call | yes | yes, and more precisely |
| can undo a side effect | no | no |
| needs host privileges | no | yes |
| mounted on this machine | **no** | n/a |

The bridge is installed but **not mounted** on the investigated machine: no `hooks.json`
exists and no composition row references it. A package being present is not a row being
composed, and conflating the two is how a "supported" claim gets made about something that
never runs. That is why the doctor reports `not_mounted` rather than "installed".

For anything that depends on a tool's **exit code**, the programmatic path is the right one.
The bridge's payload carries the rendered tool response as text only
(`dsh-hooks-claude-code/lib/index.js:375-383`), while the Cordis event carries the structured
result (`dsh-tool-pwsh/lib/index.js:157-179`).

---

## What the bridge can and cannot do

### The protocol can deny — the bridge may not be able to reach it

The protocol supports a denial, and the adapter emits one. Whether the bridge can
**deliver** it depends on the `shell` service it injects, and on the shipped
profiles it cannot:

```
shell.resolve THREW: cannot get property "sandboxPolicy" without inject
```

`dsh-hooks-claude-code/lib/index.js:119` injects `["shell", "sessionProjections"]`
and calls `shell.resolve(...)` for every hook. On Windows the profile mounts
`dsh-pwsh-sandbox` as `shell` (elsewhere `dsh-bash-sandbox`); its `resolve()`
reads `this.ctx.sandboxPolicy`, which the bridge never injected. `runHook`
catches the throw and returns an outcome with **no exit code and no decision**
(`dsh-hook-protocol/lib/index.js`, `runHook`), the merge yields `allow`, and the
tool runs.

Nothing reports this. A hook that cannot launch and a gate that chose to stay
silent produce byte-identical behaviour.

Measured, not inferred — `node scripts/jev-dsh-acceptance.mjs` drives the real
harness in a throwaway `DSH_HOME` with no model:

| run | forbidden command `git push --force` | marker file |
|---|---|---|
| shipped `headless` profile | `{ kind: "allow" }` | **created — the command ran** |
| the same profile with `shell` swapped for `dsh-pwsh-local` | — | the executor then resolves, which is what isolates the cause |

The adapter's `doctor` therefore reports `PreToolUse deny` as **conditional**, not
verified, and `docs/HARNESSES.md` carries the same caution.

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
`_dsh-runtime-findings.md` §7 for the event contracts.

---

## Limits, stated plainly

- **Advisory on this build, as configured.** The bridge is not mounted here, and `Stop` cannot
  veto. The adapter records and recommends; it does not guarantee anything.
- **No undo.** `PostToolUse` runs after the effect.
- **Textual exit codes.** Partial coverage, never confirming on its own.
- **Misdeclaration defeats the approval rules.** An action described as safe but destructive
  passes the classifier. Describing the action honestly is part of the work.
- **Not a security boundary.** The adapter can be unmounted by anyone who can edit the
  composition, and its state files are ordinary files. See `docs/DESIGN.md`.

## Unresolved

Recorded rather than papered over:

- No live end-to-end run of the bridge inside a harness session was performed for this
  repository. The protocol half is verified by driving the harness's own parser
  (`test/dsh-adapter.test.mjs`); the wiring half is verified by reading the composition.
- Whether anything bounds repeated `Stop` steering in the build itself was not established.
- The session's stored `approval/policy` event was not read — session logs were left untouched.
