# Wiring jev-gates into an agent harness

`jev-gates` is three dependency-free Node 18+ CLIs. Each asks the TypeSafe Jev decision
model (System One) for a narrow yes/no judgment with a probability, and the threshold is
applied in code. A gate is an ordinary process: it reads its input, prints a verdict, and
exits with a code. Any harness that can run a shell command and read that code can host one.
Each integration below is marked **verified** against vendor documentation or **contract only**.

## 1. The contract

A harness can host a gate if its hook mechanism provides all four of the following.

| Requirement | Why |
| --- | --- |
| Run a shell command | The gate is `node scripts/jev-gateway.mjs …`. |
| Read the command's exit code | The verdict is the exit code. Nothing else is authoritative. |
| Pass JSON on stdin, or a path to a JSON file | The completion gate takes `--claims <file>`; `--claims -` reads stdin. |
| No Node dependencies beyond Node 18+ | The scripts import nothing. Node 18+ must be on `PATH`. |

- `TYPESAFE_API_KEY` is required by gates 2 (completion) and 3 (Jevals). Gate 1 (approval)
  never touches the network and works without a key at all.
- The decision journal is written as JSONL next to the scripts. `JEV_GATES_HOME` overrides
  that location, which matters when a hook runs with a different working directory.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Allow (approval) / confirmed (completion) / rubric passed all gates (Jevals) |
| `1` | Not done (completion) / rubric failed (Jevals) |
| `2` | Ask the human (approval) / human review (completion) |
| `3` | Unverified — the judge was unavailable, **or** the input could not be trusted. This is **not** a prohibition. |

Since v2, a v1 claims file always exits `3`: it carries self-reported evidence, and self-report
cannot raise the evidence level. See [`MIGRATION.md`](MIGRATION.md).

### The fail-open rule

A hook must treat code `3` and every unexpected code as **not confirmed**, never as a
prohibition. A gate that cannot answer must say so and let the pipeline continue. A gate
that silently stops the pipeline is worse than no gate: it converts an outage of the judge
into a hard block, discovered by whoever is trying to work.

This rule has teeth because harness exit-code conventions do not match the gate's. Most
harnesses treat "non-zero" as "failure", so a naive `exit $?` maps the gate's `1` and `3`
onto whatever that harness does with a generic failure — block, or log and continue. Every
adapter below maps the four codes explicitly. The completion gate's order of operations is
fixed: act → read the target → collect evidence → judge. It reads evidence, it does not collect it.

## 2. Recipes

### Claude Code (verified)

Sources: the [hooks reference](https://code.claude.com/docs/en/hooks) and the
[hooks guide](https://code.claude.com/docs/en/hooks-guide).

Hooks live in `.claude/settings.json` (project scope, committable), `~/.claude/settings.json`,
`.claude/settings.local.json`, or plugin and skill frontmatter. The schema nests three levels:
hook event → matcher group → handler. A handler is `{"type": "command", "command": "…"}`, and
its optional `if` field uses permission-rule syntax: `"Bash(git push *)"` matches subcommands.

**Input.** Tool events carry `tool_name` and `tool_input`; the documented example is
`{ "tool_name": "Bash", "tool_input": { "command": "rm -rf /tmp/build" }, … }`, plus
`session_id`, `cwd`, and `transcript_path`. `Stop` is *documented* to add `stop_hook_active`,
"true when this stop already exists because a previous stop hook blocked".

> [!WARNING]
> On DeepSeek Harness `0.1.5-rc.2` that field is **hardcoded `false` and never read back from
> the hook's output**, so a loop guard written against it never fires. Bound the steering with
> your own counter. Verified in [`DSH.md`](DSH.md).

**Output.** Exit `0` means no decision — the normal permission flow applies, so staying
silent does not approve anything. Exit `2` blocks, and stderr is shown to the model. Every
other code, including `1`, is a non-blocking error: the hook is considered to have failed
and the action proceeds. For structured control, print JSON on stdout instead.
`permissionDecision` accepts `allow`, `deny`, `ask`, `defer`; the most restrictive answer
wins in the order `deny`, `defer`, `ask`, `allow`.

> [!IMPORTANT]
> **This is the dialect, not every implementation of it.** DeepSeek Harness `0.1.5-rc.2`
> accepts only `allow`, `deny` and `ask`, drops `defer`, silently ignores a **top-level**
> `{"decision":"deny"}`, and discards the whole `hookSpecificOutput` block if
> `hookEventName` does not match the firing point. It also does not honour `updatedInput`.
> Write to the intersection unless you know which build you are on — the per-build facts and
> their citations are in [`DSH.md`](DSH.md).

> [!CAUTION]
> **A hook that cannot launch looks exactly like a gate that chose to stay silent.**
> On DeepSeek Harness the bridge injects `shell` and calls `shell.resolve()` for every
> hook. The shipped sandboxed executors (`dsh-pwsh-sandbox` on Windows, `dsh-bash-sandbox`
> elsewhere) need `sandboxPolicy`, which the bridge does not inject, so `resolve()` throws
> `cannot get property "sandboxPolicy" without inject`. `runHook` catches that and returns
> an outcome with **no decision**, the merge yields `allow`, and the tool runs.
>
> Measured, not inferred: `node scripts/jev-dsh-acceptance.mjs` drives the real harness in
> a throwaway `DSH_HOME` with no model and reports whether a denied command actually stayed
> unrun. On the shipped profiles it does **not** — the forbidden command executes. Treat
> PreToolUse enforcement on this harness as **conditional on a `shell` service the bridge
> can drive**, and never as a control you have verified because the hook is registered.
> The adapter's `doctor` reports exactly this instead of claiming the capability.


Both hooks in `.claude/settings.json`. `Stop` has no matcher support and fires every turn.
```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [
      { "type": "command", "if": "Bash(git push *)", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/jev-approval.sh" }]}],
    "Stop": [{ "hooks": [
      { "type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/jev-completion.sh" }]}]
  }
}
```

**Approval gate.** `.claude/hooks/jev-approval.sh` — no API key required:
```sh
#!/bin/sh
set -u
node "${CLAUDE_PROJECT_DIR}/scripts/jev-gateway.mjs" --action push_public --external --public --reversible=false
rc=$?
case "$rc" in
  0) exit 0 ;;   # allow: no decision, normal permission flow continues
  2) printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"jev approval gate: public push needs a human"}}'; exit 0 ;;
  *) printf 'jev approval gate: unexpected code %s, not blocking\n' "$rc" >&2; exit 0 ;;
esac
```
The gateway's `2` means "ask the human", but a hook exit `2` means "deny": the decision
travels as JSON and the process exits `0`.

**Completion gate.** `.claude/hooks/jev-completion.sh` — requires `TYPESAFE_API_KEY`:
```sh
#!/bin/sh
set -u
# Anti-loop. On DeepSeek Harness this MUST be a real counter: the payload field
# `stop_hook_active` is hardcoded to false and never read back, so a guard written
# against it never fires and the session can be steered forever.
STATE="${TMPDIR:-/tmp}/jev-stop-$$"
COUNT=$(cat "$STATE" 2>/dev/null || echo 0)
[ "$COUNT" -ge 2 ] && exit 0
echo $((COUNT + 1)) > "$STATE"

# A v1 claims file is self-reported, so it can only ever exit 3 — use a v2 request.
node "${CLAUDE_PROJECT_DIR}/scripts/jev-gate.mjs" --request "${CLAUDE_PROJECT_DIR}/request.json"
rc=$?
case "$rc" in
  0) exit 0 ;;   # confirmed: let the turn end
  1) printf '%s\n' '{"decision":"block","reason":"jev completion gate: not done - evidence does not confirm the claim."}'; exit 0 ;;
  2) printf '%s\n' '{"decision":"block","reason":"jev completion gate: human review required."}'; exit 0 ;;
  3) printf 'jev completion gate: unverified (judge unavailable), not blocking\n' >&2; exit 0 ;;
  *) printf 'jev completion gate: unexpected code %s, not blocking\n' "$rc" >&2; exit 0 ;;
esac
```

The decision travels as JSON and the process exits `0`; a hook exit `2` would discard stdout and
hand the model a bare stderr string instead of a reason.

**Stop is a steer, not a veto.** On DeepSeek Harness a Stop hook requests one more step and the
turn closes as soon as the inbox drains; the dispatch is even skipped when the inbox is already
non-empty. `{"continue": false}` alone does **not** block anything in that build. Bound the
steering yourself, as above, and never describe this as enforcement. See
[`DSH.md`](DSH.md) for the citations.
The documented block form is `{"decision": "block", "reason": "…"}` on stdout, or exit `2`
with the reason on stderr; the adapter emits both. Add `--dry` to print state and questions
without calling the model.

### GitHub Actions (verified)

Sources: the [contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)
and [job conditions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions).

The approval gate has no place in CI — no human to ask, no irreversible local action to
guard. The completion gate and Jevals run as ordinary steps.

The one real constraint: the `secrets` context is **not** available in `jobs.<job_id>.if`
or `jobs.<job_id>.steps.if`; the availability table allows only `github`, `needs`, `vars`,
`inputs`, `env`, `steps`, `strategy`, `matrix`, `job`, and `runner` there. `secrets` *is*
allowed in `env`, so carry the secret into `env` first and test `env` in the step condition.
```yaml
on: [push, pull_request]
jobs:
  completion:
    runs-on: ubuntu-latest
    env:
      # Job-level env may reference secrets; a step-level `if` may not.
      TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
    steps:
      - uses: actions/checkout@v7
      - name: Completion gate
        if: ${{ env.TYPESAFE_API_KEY != '' }}
        run: node scripts/jev-gate.mjs --request request.json
      - name: Rubric regression stand
        if: ${{ env.TYPESAFE_API_KEY != '' }}
        run: node scripts/jev-evals.mjs run fixtures/claim-support.json
      - name: Gates skipped
        if: ${{ env.TYPESAFE_API_KEY == '' }}
        run: echo "TYPESAFE_API_KEY is not set; gates skipped."
```
Without a key the gated steps are skipped, not failed, and the final step keeps the skip
visible instead of letting it look like a pass. Add `actions/setup-node` if the runner's
preinstalled Node is older than 18. Pin actions to a major version rather than a branch:
`actions/checkout@v7` and `actions/setup-node@v7` are current at the time of writing.

### AGENTS.md-based harnesses — contract only — verify your harness's hook API

This covers DeepSeek Harness (DSH), OpenAI Codex, and any agent that reads repository
instructions rather than exposing a blocking hook. DSH invokes the gate as a plain command
from a rule and from the skill governing completion; Codex and compatible agents treat it as
a mandatory step before declaring the task done. The rule body is the same:
```markdown
## Before reporting completion

The order is act → read the target → collect evidence → judge. Never report a task as done
on the strength of memory.

    node scripts/jev-gate.mjs --request request.json

Read the exit code: 0 confirmed, 1 not done, 2 human review, 3 unverified. Report 1 as not
done. On 3, say plainly that the judge was unavailable; 3 is not a prohibition.
```
Put it in the skill as well as the rule file, so it is in context when the work happens
rather than in a file that may not be read. An instruction is not enforcement: it holds near
the top of the context and weakens over a long session. DSH exposes plugin events, but
whether they can block a turn the way a `Stop` hook does is a property of the harness, not
of the gate — check the hook API before relying on enforcement.

### Plain shell and git hooks — contract only — verify your harness's hook API

A `pre-push` hook is a shell command whose non-zero exit aborts the push — the natural home
for the approval gate. `.git/hooks/pre-push`:
```sh
#!/bin/sh
node scripts/jev-gateway.mjs --action push_public --external --public --reversible=false
rc=$?
if [ "$rc" -eq 2 ] && [ "${JEV_APPROVED:-0}" != "1" ]; then
  echo "jev approval gate: this push needs a human decision. Review it, then re-run with JEV_APPROVED=1." >&2
  exit 1
fi
exit 0   # 0 allows; anything unexpected is fail-open
```
The override flag is deliberate: git has no "ask" state, so the gate's `2` becomes an abort
a human can clear after reviewing. Every other code lets the push through.

### Other harnesses (Cursor, opencode, Hermes, Aider, and anything else) — contract only

Each of these must have its hook API checked against its own documentation. Do not assume
any of them accepts the JSON shapes above, or that any blocks on a particular exit code.
What is portable is the wrapper: it calls the gate, prints one verdict line, and exits with
a code from the closed set `{0,1,2,3}` so the caller maps only four cases.

`scripts/jev-any-harness.sh`:
```sh
#!/bin/sh
# One verdict line; normalized exit code from {0,1,2,3}.
set -u
mode="${1:-approval}"; [ $# -gt 0 ] && shift
case "$mode" in
  approval)   node scripts/jev-gateway.mjs "$@" ;;
  completion) node scripts/jev-gate.mjs "$@" ;;
  *) echo "jev: unknown mode '$mode'" >&2; exit 3 ;;
esac
rc=$?
case "$rc" in
  0) v="allow/confirmed" ;;  1) v="not done" ;;  2) v="human review required" ;;
  3) v="unverified - judge unavailable (not a prohibition)" ;;
  *) v="unexpected code $rc - treated as unverified"; rc=3 ;;
esac
echo "jev: $v"; exit "$rc"
```
The caller's mapping rule is the fail-open rule: `0` is the only confirmation, `1` and `2`
are handled according to what your harness can do about them, and `3` is "not confirmed,
not forbidden" — report it and continue.

## 3. Harness support matrix

| Harness | Verified? | Where the gate runs |
| --- | --- | --- |
| Claude Code | verified — [hooks reference](https://code.claude.com/docs/en/hooks), [hooks guide](https://code.claude.com/docs/en/hooks-guide) | `PreToolUse` for approval (scoped to `Bash(git push *)`), `Stop` for completion; configured in `.claude/settings.json` |
| GitHub Actions | verified — [contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts), [job conditions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions) | Ordinary workflow steps; no approval gate in CI; secret carried through job-level `env`, tested with `env.*` in the step condition |
| DeepSeek Harness (DSH) | protocol-tested, runtime-unverified as an enforcement point — see the caution above and `scripts/jev-dsh-acceptance.mjs` | `PreToolUse` via the harness's Claude Code bridge, `Stop` for completion; on the shipped profiles the bridge cannot launch a hook at all, so treat the gate as advisory until the acceptance script says otherwise |
| OpenAI Codex / AGENTS.md-compatible | contract only — verify your harness's hook API | Instruction file; gate as a mandatory step before the agent declares the task done |
| Plain shell / git hooks | contract only — verify your harness's hook API | `.git/hooks/pre-push`; non-zero exit aborts the push |
| Cursor, opencode, Hermes, Aider, others | contract only — verify your harness's hook API | Wherever the harness can run a command; call `scripts/jev-any-harness.sh` and map the four codes |

## 4. What the gate does NOT do

- **It does not block or execute anything.** A gate prints a verdict and exits; whether that
  verdict stops a pipeline is decided entirely by the harness, not by the gate.
- **The completion gate checks that evidence is consistent, not that it is true.** It reads
  files re-read after the write, commands with their expected exit codes, artifacts that
  exist. Fabricated evidence that is internally consistent will pass.
- **The approval gate is deterministic and does not call a model.** It answers one question
  from the flags it is given, so flags that are wrong in good faith produce a wrong answer
  the gate cannot notice. `--reversible=false` on a reversible action is not detected.
- **It does not decide for you.** Exit `2` means "ask the human", not "the human said no".
  Exit `3` means the judge was unavailable and the claim is unverified — not that the work is
  wrong. Reporting either as a prohibition misstates what the gate said.
