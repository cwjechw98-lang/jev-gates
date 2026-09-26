# CLI reference

Every command in `scripts/` and `adapters/dsh/`. Each entry gives the purpose, the flags
that exist in the argv parser, the exit codes the process actually sets, one real example
with its real output, and what the command does not do.

All examples were run from the repository root on Node 24, offline, with no API key. Output
is copied verbatim, including the capitalised status words.

`--version` does not exist anywhere in this repository. There is no version command; the
version lives in `package.json`.

`--help` exists on `jev-gate` and `jev-replay` and exits `0`. The other commands answer with
a usage line when called with an unrecognised mode. Calling a command with no arguments at all
is never a help request: `node scripts/jev-gate.mjs` prints the missing-request message and
exits `3`, because "you did not tell me what to check" is an absence of evidence, not a
usage error.

---

## `scripts/jev-gate.mjs` — the completion gate

Turns a v2 request plus observations into one of four statuses. Code decides first from
collected facts; the model is asked only about criteria with no deterministic check.

### Flags

| Flag | Argument | Effect |
|---|---|---|
| `--request` | `<file\|->` | Read a v2 request. `-` reads stdin. |
| `--claims` | `<file\|->` | Read a v1 claims file. Same slot as `--request`; used only when `--request` is absent. |
| `--collect` | `<path[,path]>` | Measure each named artifact with the collector. Repeatable; comma-separated values are split. |
| `--answers` | `<file>` | Replay recorded answers instead of contacting the judge. |
| `--offline` | none | Never contact the judge. Also set by `JEV_GATES_OFFLINE=1`. |
| `--root` | `<path>` | Project root for scope resolution. Defaults to `request.projectRoot`. |
| `--max-age` | `<seconds>` | Treat an observation older than this as stale. Absent means no staleness check. |
| `--model` | `<id>` | Judge model. Defaults to `jev-1.13.0` (`DEFAULT_MODEL` in `lib/judge.mjs`). |
| `--no` | `<number>` | Lower threshold. Default `0.2`. |
| `--yes` | `<number>` | Upper threshold. Default `0.8`. Must be greater than `--no`. |
| `--calibrated` | none | Declare the thresholds calibrated. Default is uncalibrated. |
| `--json` | none | Print the machine contract instead of the human report. |
| `--dry` | none | Print the state, the questions and the computed facts. Forces exit `0`. |
| `--no-journal` | none | Do not append this decision to the journal. |
| `--help` | none | Print the flag surface and exit `0`. |

Every run writes one record to `$JEV_GATES_HOME/jev-decisions.jsonl` (default: the repository
root) carrying the rows, the questions and the thresholds, so the decision can be replayed
later with `jev-replay`. `--dry` writes nothing, because nothing was decided. `--no-journal`
suppresses the record; if the record cannot be written the verdict still stands and the report
says `journal: NOT WRITTEN`, because a decision that cannot be replayed is a fact the reader
needs.

### Exit codes

| Code | Status | Meaning |
|---|---|---|
| `0` | `done` | Every required criterion is supported by independent evidence. |
| `1` | `not_done` | A deterministic check failed, or the evidence contradicts the claim. |
| `2` | `review` | The evidence is not decisive; a human decides. |
| `3` | `unverified` | The claim is not confirmed. This is not a prohibition. |

`3` is also what a schema violation, an unreadable file, invalid JSON, missing thresholds,
and an absent `--request` produce. A failed request is never a crash: the message is printed
without a stack trace.

### A v2 request with recorded answers

```
$ node scripts/jev-gate.mjs --request examples/completion.example.json --answers examples/answers.example.json
VERDICT: CONFIRMED
reason: all 3 required criteria are supported by independent evidence; the thresholds were not calibrated on this task
reason codes: all_required_criteria_passed, thresholds_uncalibrated
evidence: {"criteriaTotal":3,"requiredTotal":3,"passed":3,"failed":0,"review":0,"unverified":0,"evidenceBacked":2,"judged":1,"deterministicFailures":[]}
source trust: collector_observed; calibrated: false; mode: completion

  test-green             pass              -     pass
  report-written         pass              -     pass
  fix-addresses-root-cause unknown          0.93   pass

judge: ok
limit: this gate checks that the evidence is consistent, not that it is true.
limit: local evidence has tamperResistance "none" — it can be altered by a process with the same write access.
```

Exit `0`. `--answers` makes this a replay: no network, no key.

### The `--offline` lane

Without `--answers`, `--offline` reports the judge as unavailable. The two flags are not
interchangeable: when `--answers` is present the replay branch wins and `--offline` changes
nothing about the verdict, because the judge is never reached in either case.

```
$ node scripts/jev-gate.mjs --request examples/completion.example.json --offline
VERDICT: UNVERIFIED
reason: fix-addresses-root-cause: no_answer; the thresholds were not calibrated on this task
reason codes: answer_invalid, thresholds_uncalibrated
evidence: {"criteriaTotal":3,"requiredTotal":3,"passed":2,"failed":0,"review":0,"unverified":1,"evidenceBacked":2,"judged":0,"deterministicFailures":[]}
source trust: collector_observed; calibrated: false; mode: completion

  test-green             pass              -     pass
  report-written         pass              -     pass
  fix-addresses-root-cause unknown           -     unverified

answers rejected by validation:
  fix-addresses-root-cause: no_answer

judge: unavailable (offline lane: the judge was not contacted)
this is NOT "done" and NOT "forbidden": nothing is confirmed, a human decides.
limit: this gate checks that the evidence is consistent, not that it is true.
limit: local evidence has tamperResistance "none" — it can be altered by a process with the same write access.
```

Exit `3`. `--offline` stops the judge call only; `--collect` still reads files.

### The legacy v1 path

A v1 claims file is accepted, downgraded to `self_reported` evidence, and never reaches the
judge. It exits `3` with reason code `legacy_untrusted`.

```
$ node scripts/jev-gate.mjs --claims examples/claims.example.json
VERDICT: UNVERIFIED
reason: a v1 claims file carries self-reported evidence only; legacy-1: no usable answer; the thresholds were not calibrated on this task
reason codes: legacy_untrusted, judge_abstained, thresholds_uncalibrated
evidence: {"criteriaTotal":3,"requiredTotal":3,"passed":0,"failed":0,"review":0,"unverified":3,"evidenceBacked":0,"judged":0,"deterministicFailures":[]}
source trust: null; calibrated: false; mode: consistency

  legacy-1               unknown           -     unverified
  legacy-2               unknown           -     unverified
  legacy-3               unknown           -     unverified

a v1 claims file is self-reported evidence: it cannot confirm anything on its own.
this is NOT "done" and NOT "forbidden": nothing is confirmed, a human decides.
limit: this gate checks that the evidence is consistent, not that it is true.
limit: local evidence has tamperResistance "none" — it can be altered by a process with the same write access.
```

`fixtures/claim-support.json` is a rubric fixture, not a claims file: it has a `cases` array
and no `criteria` field, so the v1 reader finds no criteria at all. Running it as a claim
file is still exit `3` with `legacy_untrusted`, but for a second reason — there is nothing to
evaluate.

```
$ node scripts/jev-gate.mjs --claims fixtures/claim-support.json
NOTHING TO CHECK: no applicable criteria carry evidence.
This is not "done" — it is the absence of evidence.
VERDICT: UNVERIFIED
reason: a v1 claims file carries self-reported evidence only; there is nothing to evaluate: no applicable criteria; the thresholds were not calibrated on this task
reason codes: legacy_untrusted, no_verifiable_criteria, thresholds_uncalibrated
evidence: {"criteriaTotal":0,"requiredTotal":0,"passed":0,"failed":0,"review":0,"unverified":0,"evidenceBacked":0,"judged":0,"deterministicFailures":[]}
source trust: null; calibrated: false; mode: consistency

a v1 claims file is self-reported evidence: it cannot confirm anything on its own.
this is NOT "done" and NOT "forbidden": nothing is confirmed, a human decides.
limit: this gate checks that the evidence is consistent, not that it is true.
limit: local evidence has tamperResistance "none" — it can be altered by a process with the same write access.
```

### `--dry`

Prints the state that would be sent to the judge, the questions that would be asked, and the
facts code computed, then exits `0` regardless of the verdict. This is how you inspect the
pipeline without a key.

```
$ node scripts/jev-gate.mjs --request examples/completion.example.json --offline --dry
-- STATE --
{
  taskId: 'fix-failing-test',
  runId: 'run-2026-09-22-01',
  mode: 'completion_check',
  instructions: 'Judge only the criterion given. Use the computed facts as ground truth. Do not evaluate anything that is not asked.',
  untrusted_claim: '<untrusted:claim>\n' +
    'the test is green and the report is written\n' +
    '</untrusted:claim>',
  untrusted_task: '<untrusted:task>\nfix the failing test in src/a.ts\n</untrusted:task>',
  computed_facts: [
    {
      criterionId: 'test-green',
      result: 'pass',
      reasonCode: 'command_exit_matched',
      sourceTrust: 'harness_observed',
      coverage: 'full'
    },
    ...
  ]
}

-- QUESTIONS --
{
  "fix-addresses-root-cause": {
    "type": "noul",
    "text": "Does the evidence support this criterion?\n<untrusted:criterion>\nthe change addresses the cause rather than the symptom\n</untrusted:criterion>",
    "options": [
      "yes",
      "no"
    ]
  }
}

-- COMPUTED FACTS --
[...]

computed by code: {"criteriaTotal":3,"requiredTotal":3,"passed":2,"failed":0,"review":0,"unverified":1,"evidenceBacked":2,"judged":0,"deterministicFailures":[]}
```

### `--json`

The machine contract. The exit code is repeated inside the payload as `exitCode`, and
`tamperResistance: "none"` is added to every record.

```
$ node scripts/jev-gate.mjs --request examples/completion.example.json --answers examples/answers.example.json --json
{
  "schemaVersion": 2,
  "kind": "completion",
  "policyVersion": "2.0.0",
  "status": "done",
  "exitCode": 0,
  ...
  "judgeStatus": "ok",
  "tamperResistance": "none"
}
```

### What it does not do

- It never executes a command. `--collect` reads and hashes files; a command named inside a
  claim is never run.
- It does not verify truth. It checks consistency between evidence and a claim.
- It does not block. `enforcement.canBlock` is `false`; the exit code is advice to the caller.
- It does not consult the judge for a v1 claims file, or for a deterministic criterion that
  code already decided.
- It does not prevent a human from proceeding on any status.

---

## `scripts/jev-gateway.mjs` — the approval gate

A deterministic rule table over flags. No model, no network, no file access.

### Commands and flags

| Invocation | Effect |
|---|---|
| `--rules` | Print the rule table and exit `0`. |
| `--json '<object>'` | Judge the flags in the JSON object. |
| `--action <name>` | Name the action. Overrides `action` from `--json` or stdin. |
| `--quiet` | Print one JSON line instead of the human report. |
| `--<flag>[=value]` | Set a boolean flag. The value `false` is false; a bare flag or any other value is true. |
| (stdin) | A JSON object merged into the flags. Ignored when stdin is a TTY. |

Recognised flag names: `external`, `public`, `destructive`, `credential`, `bulk`,
`reversible`, `declared`.

### Exit codes

| Code | Verdict | Meaning |
|---|---|---|
| `0` | `allow` | No rule fired. |
| `2` | `human` | At least one rule fired: ask a human. |

### Rules

```
$ node scripts/jev-gateway.mjs --rules
credential_out           a credential leaves the machine
destructive_irreversible destructive and irreversible
public_irreversible      published outward with no way back
external_irreversible    external action with no way back
bulk_irreversible        bulk operation with no way back
undeclared               the action is not described, so there is nothing to judge: ask the human
```

### Examples

```
$ node scripts/jev-gateway.mjs --action push_public --external --public --reversible=false
action: push_public
verdict: ASK A HUMAN
  reason: public_irreversible: published outward with no way back
  reason: external_irreversible: external action with no way back
(advice, not enforcement: this gate does nothing and blocks nothing)
```

Exit `2`.

```
$ node scripts/jev-gateway.mjs --json '{"action":"delete_backup","destructive":true,"reversible":false}'
action: delete_backup
verdict: ASK A HUMAN
  reason: destructive_irreversible: destructive and irreversible
(advice, not enforcement: this gate does nothing and blocks nothing)
```

Exit `2`.

```
$ node scripts/jev-gateway.mjs --action edit_readme --reversible=true
action: edit_readme
verdict: GO
  no stopping reason: no external, public, destructive, bulk or
  irreversible flag was declared
(advice, not enforcement: this gate does nothing and blocks nothing)
```

Exit `0`.

```
$ node scripts/jev-gateway.mjs --action git_push --external --reversible=false --quiet
{"action":"git_push","flags":{"external":true,"public":false,"destructive":false,"credential":false,"bulk":false,"reversible":false,"declared":true},"verdict":"human","reasons":["external_irreversible: external action with no way back"]}
```

### What it does not do

- It executes nothing and blocks nothing. It prints advice.
- It cannot catch mis-declared flags. An action described as safe while being destructive passes.
- It has no "undeclared" escape: an unnamed action fires the `undeclared` rule and exits `2`.
- It writes a decision record to the journal, but only after the verdict is computed.

---

## `scripts/jev-decisions.mjs` — the decision journal

### Commands

| Command | Effect |
|---|---|
| `summary` (default) | Counts by kind and verdict, token and cost totals, the last five records, and the journal path. Exit `0`. |
| `thresholds` | Print the thresholds as JSON. Exit `0`. |
| anything else | Print `commands: summary | thresholds`. Exit `0`. |

The journal path is `$JEV_GATES_HOME/jev-decisions.jsonl` when `JEV_GATES_HOME` is set, and
`scripts/jev-decisions.jsonl` otherwise.

```
$ node scripts/jev-decisions.mjs summary
decision records: 29
by kind:     {"gateway":21,"evals":1,"gate":7}
by verdict:  {"human":14,"allow":7,"ok":1,"done":5,"unverified":2}
input: 2436 tokens, cost: $0.00010

last decisions:
  2026-09-22T11:01  fix-failing-test                 done
  2026-09-22T11:01  fix-failing-test                 done
  2026-09-22T11:01  legacy-task                      unverified
  2026-09-22T11:01  fix-failing-test                 done
  2026-09-22T11:01  fix-failing-test                 unverified

journal: C:\Users\you\jev-gates\scripts\jev-decisions.jsonl
```

```
$ node scripts/jev-decisions.mjs thresholds
{"yes":0.8,"no":0.2,"calibrated":false}
```

### What it does not do

- It does not replay, re-render or re-ask anything. That is `jev-replay`, below.
- `summary` counts records, not runs: a record with no `verdict` field is counted in `total`
  and in neither verdict bucket.

---

## `scripts/jev-replay.mjs` — replay a recorded decision

Reads `jev-decisions.jsonl` and reproduces a decision from the record. The difference between
the modes is the point of the command.

| mode | what it does | costs |
|---|---|---|
| `list` | the records in the journal, newest last | nothing |
| `policy` | re-decides from the recorded probabilities | nothing |
| `sweep` | re-decides across a band of `yes` thresholds | nothing |
| `render` | reproduces the human report from the record alone | nothing |
| `model` | re-asks the judge | **money** — refused without `--allow-live` |

### Flags

| flag | meaning |
|---|---|
| `--journal <path>` | journal to read (default `$JEV_GATES_HOME/jev-decisions.jsonl`) |
| `--id <record>` | which record (default: the last one) |
| `--yes <n>` `--no <n>` | thresholds to replay with, instead of the recorded ones |
| `--steps <n>` | sweep resolution (default 9) |
| `--allow-live` | permit `model` mode. It is the only mode that can cost money. |

### Exit codes

`0` for a successful replay, `2` for an unrecognised mode, `3` when there is no record to
replay. **An absent record is not a pass** — it exits `3` and says so.

### Real output

A gate run writes one record, and the sweep then answers a question the verdict alone cannot:
was this decided by the evidence, or by the threshold?

```
$ node scripts/jev-replay.mjs sweep
record: fix-failing-test-muckh040
rows with a model probability: 1
no-threshold (fixed): 0.2

yes-threshold  per-row decisions
  0.5           yes
  0.556         yes
  0.611         yes
  0.667         yes
  0.722         yes
  0.778         yes
  0.833         yes
  0.889         yes
  0.944         review
  1             review

the verdict changes at: yes 0.889→0.944 — the threshold IS a deciding factor, so it must be calibrated before it is trusted.
```

A record written before the current policy version replays as `partial` and reports
`unverified`, not the verdict it once carried: a verdict that cannot be reproduced is not one
the tool will stand behind.

### What it does not do

- It does not re-verify the evidence. A record is a statement about the past, not a fresh
  measurement.
- It does not write. The only mode that contacts anything is `model`, and only with
  `--allow-live`.
- `render` reproduces the report; it does not re-run the policy. Use `policy` for that.

---

## `scripts/jev.mjs` — the raw Jev client

A thin client for the TypeSafe endpoint with an experience journal. It is the only script
here that talks to the model without the completion policy in front of it.

### Commands

| Command | Effect |
|---|---|
| `check` | One call asking whether a fixed sentence contains "yes". Prints `route: WORKING` and exits `0`, or `route: FAILED` and exits `1`. |
| `ask '<state>' '<questions-json>'` | One call. Prints the answers and the cost. |
| `note '<finding>' [--label <name>] [--verdict ok\|wrong\|unclear]` | Append one finding to `jev-journal.jsonl`. |
| `journal` | Counts, cost, and the last eight records. |
| (none) | Print `commands: check | ask | note | journal`. Exit `0`. |

`--model <id>` is read by `check` (default `jev-1.13.0`) and by `ask` (default `jev-latest`).

The key is read from `TYPESAFE_API_KEY`, then `$JEV_GATES_HOME/key`, then
`~/.dsh/.credentials.yaml`, then `~/.config/jev-gates/key`. It is never printed.

**Not verified here.** `check`, `ask` and `journal` need the network and a key, so no output
for them is reproduced in this file. Only the no-argument usage line was run:

```
$ node scripts/jev.mjs
commands: check | ask | note | journal
```

### What it does not do

- It does not apply a threshold. It returns probabilities; the caller decides. The gate and
  the rubric stand both use `lib/policy.mjs` for that.
- It does not retry a terminal 4xx. `429`, `529` and `5xx` are retried with backoff; any other
  non-2xx throws immediately.
- It does not use the transport seam in `lib/transport.mjs`. Its own retry loop is separate,
  and the deadline behaviour of the two differs.

---

## `scripts/jev-evals.mjs` — the rubric stand

### Commands and flags

| Command | Effect |
|---|---|
| `run <fixture.json>` | Run the three gates over a fixture. |
| `template` | Print a filled example fixture as JSON. Exit `0`. |
| (none) or unknown | Print `commands: run <fixtures.json> | template`. Exit `0`. |

| Flag | Default | Effect |
|---|---|---|
| `--model` | fixture `model`, else `jev-1.13.0` | Judge model. |
| `--target` | fixture `target_accuracy`, else `0.9` | Minimum accuracy for gate 1. |
| `--max-drift` | `0.2` | Maximum tolerated drift in gate 2. |
| `--no-stability` | off | Skip gate 2. |
| `--no-control` | off | Skip gate 3. |
| `--shuffle` | off | Shuffle instead of reversing the case order for gate 2. |
| `--seed` | `1` | Seed for `--shuffle`. |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | All gates that ran passed. |
| `1` | The rubric failed, the fixture was unreadable, the fixture had no cases, or no fixture was named. |

```
$ node scripts/jev-evals.mjs
need a fixture file: node scripts/jev-evals.mjs run fixtures/<name>.json
```

Exit `1`. Gate 1 failing stops the run before stability is computed.

### What it does not do

- It needs the network and a key. `run` was not executed here; see the README for a recorded
  run of `fixtures/claim-support.json`.
- It does not compute stability when gate 1 fails, and it says so instead of printing a
  meaningless 100%.
- `--no-stability` and `--no-control` do not count as passes: a skipped gate is reported as
  skipped and is excluded from the pass condition.

---

## `adapters/dsh/doctor.mjs` — what this installation can guarantee

Reads the installed harness and reports a capability matrix. It writes nothing and starts
nothing.

### Flags

| Flag | Effect |
|---|---|
| `--json` | Print the report as JSON. |
| `--policy <never\|ask\|unknown>` | State the approval policy instead of reading it from `settings.yaml`. |

### Exit codes

| Code | Status | Meaning |
|---|---|---|
| `0` | `healthy` | Every capability is verified. |
| `1` | `degraded` | The adapter works, with at least one capability `unavailable` or `not_mounted`. |
| `2` | `misconfigured` | No `@deepseek-ai/dsh` installation was found. |

### Real output

```
$ node adapters/dsh/doctor.mjs
jev-gates × DeepSeek Harness — doctor

DSH install:  C:\Users\you\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh
DSH version:  0.1.5-rc.2
DSH home:     C:\Users\you\.dsh
profile:      web
policy:       unknown (no approval policy key in settings.yaml)
bridge:       installed but NOT mounted
  checked: C:\Users\you\.dsh\settings.yaml
  checked: C:\Users\you\.dsh\profiles\web\cordis.yml
  checked: C:\Users\you\.dsh\profiles\web\cordis.patch.yml

capabilities:
  [verified    ] PreToolUse deny
                 the adapter can stop a tool call
                 evidence: dsh-hook-protocol/lib/index.js:110-113 (exit 2), :150-151 (permissionDecision)
  [conditional ] PreToolUse ask
                 the policy could not be read from the configuration; if it is "never" an ask silently becomes a deny — pass --policy to state it
                 evidence: dsh-hooks-claude-code/lib/index.js:248-264 + dsh-user-approval/lib/index.js:178
  [unavailable ] PostToolUse structured exit code
                 observations from this path are partial coverage and cannot confirm a criterion alone
                 evidence: dsh-hooks-claude-code/lib/index.js:375-383 (payload has tool_response text only)
  [unavailable ] PostToolUse rollback
                 the adapter records, it does not undo
                 evidence: dsh-tools/lib/index.js:3379-3388 (block re-labels a finished result)
  [unavailable ] Stop veto
                 Stop is a bounded steer; a run that exhausts the budget ends as incomplete, not as confirmed
                 evidence: dsh-hooks-claude-code/lib/index.js:292-308 + dsh-agent-loop/lib/index.js:966-973 (steer, not veto)
  [verified    ] programmatic tool events
                 a Cordis plugin can read exec.callId and result.value, including a structured exit code
                 evidence: dsh-tool-cordis/lib/index.js:4915-5720 (event catalog) — strictly more capable than the bridge
  [not_mounted ] hook bridge mounted
                 the bridge is installed but no composition row mounts it, so the adapter is advisory until it is mounted
                 evidence: no composition row found
  [verified    ] install present
                 the citations above are readable on this machine
                 evidence: C:\Users\you\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh

status: degraded (exit 1)
enforcement: advisory / completion advisory

honest summary: this adapter is advisory on this machine. It records what happened and
it can ask or deny where the build supports it; it cannot veto a turn, it cannot undo a
side effect, and it cannot see a structured exit code through the hook payload.
```

### What it does not do

- It does not claim a mount it cannot see: a package being installed is not a composition row.
- It does not guess the approval policy. An unreadable policy is reported as `unknown`.
- It does not start, restart or reconfigure the harness.

---

## `adapters/dsh/install.mjs` — mount or remove the hook row

### Commands and flags

| Command | Effect |
|---|---|
| `plan` (default) | Dry run. Print the target, the block and the resolved paths. Writes nothing. |
| `install [--apply]` | Same as `plan`; writes only with `--apply`. |
| `uninstall [--apply]` | Remove the adapter block. Writes only with `--apply`. |

| Flag | Default | Effect |
|---|---|---|
| `--mode shadow\|enforce` | `shadow` | Mode written into the hook environment. |
| `--policy never\|ask\|unknown` | `unknown` | Policy written into the hook environment. |
| `--max-steers N` | `2` | Stop-steering budget written into the hook environment. |

Exit `2` when `--apply` is given but no harness installation exists; `0` in every other case,
including an unrecognised command.

```
$ node adapters/dsh/install.mjs plan
DRY RUN — nothing was written

target:      C:\Users\you\.dsh\profiles\web\cordis.patch.yml
action:      appended
hooks file:  C:\Users\you\jev-gates\.dsh-state\hooks.json
bridge:      C:\Users\you\jev-gates\adapters\dsh\bridge.mjs
mode:        shadow   policy: unknown   max steers: 2

block to insert:
# >>> jev-gates dsh adapter >>>
- name: '@deepseek-ai/dsh-hooks-claude-code'
  config:
    configPath: C:\Users\you\jev-gates\.dsh-state\hooks.json
    pluginRoot: jev-gates
    projectDir: .
# <<< jev-gates dsh adapter <<<

run again with --apply to write it. A backup is written first.
```

### What it does not do

- It never touches the installed `node_modules` or an agent preset. The target is always a
  `cordis.patch.yml` under `DSH_HOME/profiles/<profile>/`.
- It never overwrites a later user edit on uninstall. When the file no longer matches the
  backup, it reports the difference and removes only its own block.
- It does not verify that the harness honours the row it writes. That is the doctor's job.

---

## `adapters/dsh/bridge.mjs` — the hook command

Reads one hook payload from stdin and writes one JSON object to stdout. Exit code is always
`0`: the decision travels in JSON, because exit `2` would discard stdout and hand the model a
raw stderr string.

### Flags and environment

| Flag | Environment | Default | Effect |
|---|---|---|---|
| `--mode shadow\|enforce` | `JEV_DSH_MODE` | `shadow` | Shadow computes and records without emitting a decision. |
| `--policy never\|ask\|unknown` | `JEV_DSH_POLICY` | `unknown` | Under `never`, an ask is not emitted at all. |
| `--max-steers N` | `JEV_DSH_MAX_STEERS` | `2` | Stop-steering budget per session. |
| — | `JEV_DSH_STATE` | `$JEV_GATES_HOME/dsh-state`, else `<repo>/.dsh-state` | Where per-session state and observations are written. |

### Handled events

`PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`. Any other event name is reported on
stderr and ignored. An unparseable payload is reported on stderr; stdout stays empty so the
protocol parser sees no JSON at all.

```
$ '{"hook_event_name":"PreToolUse","session_id":"s1","tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' | node adapters/dsh/bridge.mjs --mode enforce --policy ask
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"jev-gates: \"git_push\" looks irreversible (external_irreversible, public_irreversible, destructive_irreversible); a human should decide"}}
```

### What it does not do

- It cannot veto a turn. `Stop` steers a bounded number of times, then goes quiet and records
  the run as incomplete.
- It cannot undo a side effect: `PostToolUse` runs after the effect.
- It cannot see a structured exit code. The exit code is inferred from rendered text, the
  observation is marked `coverage: "partial"` with `exitSource: "text_inference"`, and a
  partial observation can never confirm a criterion on its own.
- It stays silent about actions it does not recognise as irreversible. Silence is not a
  permission: it preserves another guard's deny.

---

## `adapters/dsh/plugin.mjs` — the native adapter

The shipped hook bridge cannot launch a hook on this build: the mounted sandboxed
executor's `resolve()` reads `this.ctx.sandboxPolicy`, `this.ctx` resolves to the **calling**
context, and the bridge does not inject it — so `runHook` yields an outcome with no decision
and no process is ever spawned. See `docs/DSH.md` and `docs/_dsh-runtime-findings.md` §13.

This adapter replaces it. It is a plain Cordis plugin and needs no `shell` service at all, so
the broken executor cannot affect it. It registers on four documented extension points:
`ctx.tools.guard()` (monotonic — no later listener can force-allow a denial),
`tools/pre-execute`, `tools/post-execute`, and `agent/turn-stopping`.

### Row configuration

```yaml
- insert:
    - id: jev-adapter
      name: 'file:///…/jev-gates/adapters/dsh/plugin.mjs'
      config:
        mode: shadow            # off | shadow | enforce
        policy: ask             # ask | never | unknown
        maxSteers: 2
        gateTimeoutMs: 20000
        rules:                  # optional; replaces the built-in command rules
          - name: requires_authorization
            tool: '^my_dangerous_tool$'
            flags: ['authorization_required']
        logPath: /path/to/adapter.log
```

A rule matches either the command **text** (`test`) or the **tool name** (`tool`). A tool rule
is what lets a session say "this tool always needs authorisation" when its arguments carry no
command to read.

### Modes

| Mode | What it does |
|---|---|
| `off` | Registers nothing at all. |
| `shadow` | Computes and records the decision, registers no guard, and never blocks. |
| `enforce` | Registers the monotonic guard and denies. |

### Failure policy

The classification runs first and is pure. Everything after it can fail, and what happens
then depends on whether the call needs authorisation:

- **needs authorisation** — the check was mandatory, so a failure **denies**, naming the failure;
- **ordinary action** — the check had no opinion, so a failure **passes**.

That is fail-closed without being a blanket block, and both directions are tested.

`ask` is only raised when somebody can actually be asked. With `policy: never`, with no
approval service mounted, or on a call that carries no agent to route the question through,
the adapter denies with `authorization_unavailable` instead — asking a human who cannot be
asked is not a decision.

### What it does not do

- It cannot veto a turn. `agent/turn-stopping` is serial, has no `next`, and its return value
  is discarded; the only lever is `agent.steer()`, which adds one step inside the same turn.
- It does not undo a side effect.
- It does not classify arbitrary shell safely. It matches explicit, auditable patterns.

---

## `scripts/jev-dsh-acceptance.mjs` — the runtime acceptance

```bash
node scripts/jev-dsh-acceptance.mjs [--json] [--set shadow|enforce|never|failure|stop|all]
                                    [--timeout-ms 120000] [--keep]
```

Builds a throwaway `DSH_HOME` from `--from-default-profile headless` plus a `--patch`
overlay, mounts `plugin.mjs` beside `adapters/dsh/scenarios.mjs`, boots the real harness, and
drives `ctx.tools.execute` — the same entry point the agent loop uses — against a safe marker
tool that only writes a file. The active profile is never read or written.

Failure classes are kept apart, and **none of them is a pass**:

| Class | Meaning |
|---|---|
| `boot-timeout` | the harness did not finish starting |
| `harness-not-driven` | it started but wrote no result |
| `listener-not-attached` | the adapter produced no decision record |
| `tool-not-invoked` | neither the body ran nor a decision was recorded |
| `assertion-failed` | the observation contradicted the expectation |

Exit codes: 0 every scenario held, 1 a scenario failed, 3 the run was not driven.

### What it does not do

- It uses no model. The tool calls come from the scenario plugin rather than from an assistant
  turn, so this is evidence about the tool pipeline, the guard surface and the Stop handler —
  not about model behaviour.
- The Stop checks drive `agent/turn-stopping` with a stub agent that records `steer()` calls.
  That verifies this adapter's handler; it does not verify that the real loop accepts the
  message shape, which needs a live turn.
- The calls are agent-less, so the `ask` path is exercised only in its "cannot be routed" form.

---

## `adapters/dsh/claim.mjs` — record what the session is claiming

```bash
node adapters/dsh/claim.mjs set "<what is being claimed>" --session <id> [--request req.json]
node adapters/dsh/claim.mjs show --session <id>
node adapters/dsh/claim.mjs clear --session <id>
```

The Stop handler steers a turn only when a claim is outstanding. This is the producer: without
it the completion gate is never connected to the end of a turn. Exit codes: 0 written or
cleared, 3 nothing to show, 2 usage error.

A claim may carry `request` (the gate request to judge), `collect` (artifact paths for the
gate to read), and `taskId`/`promptId`/`snapshotDigest` — the last three are what the
anti-loop key is built from, so a repeat of the same unresolved condition is recognised as
"no new evidence" rather than as a fresh turn.

---

## Environment variables

| Variable | Read by | Effect |
|---|---|---|
| `JEV_GATES_OFFLINE` | `jev-gate.mjs` | `1` is the same as `--offline`. |
| `JEV_GATES_HOME` | `jev-gate.mjs`, `jev-decisions.mjs`, `jev.mjs`, `bridge.mjs`, `install.mjs` | Where journals and adapter state live. Created if absent. |
| `TYPESAFE_API_KEY` | `lib/credentials.mjs`, `jev.mjs` | The judge key. Never logged. |
| `JEV_DSH_MODE`, `JEV_DSH_POLICY`, `JEV_DSH_MAX_STEERS`, `JEV_DSH_STATE` | `bridge.mjs`, `plugin.mjs` | Adapter configuration; each is overridden by the matching row `config` key. |
| `JEV_DSH_GATE_ARGS` | `bridge.mjs` | Extra arguments for the completion gate the Stop handler runs. Default `--offline --no-journal`. |
| `JEV_DSH_ENTRY` | `jev-dsh-acceptance.mjs` | The harness entry to boot. Found automatically when unset. |
| `JEV_SCENARIO_SET`, `JEV_SCENARIO_DIR`, `JEV_SCENARIO_OUT` | `scenarios.mjs` | Which acceptance set to run and where to report. Set by the runner; not for hand use. |
| `DSH_HOME`, `DSH_PROFILE`, `DSH_WEB_URL`, `DSH_TUI`, `DSH_INSTALL` | `adapters/dsh/*` | Locate the harness and its profile. |

See `docs/PRIVACY.md` for what leaves the machine.
