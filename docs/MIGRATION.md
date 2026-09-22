# Migration: v1 claims to v2 requests

## The breaking change

In v1, `node scripts/jev-gate.mjs --claims claims.json` read the evidence **out of the
claims file**. `claims.evidence.commands[].exit`, `claims.evidence.writes[].bytes` and
`claims.evidence.artifacts[].exists` were copied into the state and the numbers were computed
from them. A confident file could therefore reach `done`.

In v2 those fields are not evidence. A v1 claims file is accepted, marked `legacy-untrusted`,
and every criterion it implies is `self_reported`. `decideCompletion` refuses a pass on
self-reported evidence, so the best a v1 file can produce is `unverified` with reason code
`legacy_untrusted`. The judge is not consulted at all.

The reason is the one v1 stated about itself and then violated: a claim written by the agent
is not an observation. Self-reporting cannot raise the level of evidence. Only a collector
that measured a file, or a harness that reported how a command ended, can.

Verified:

```
$ node scripts/jev-gate.mjs --claims examples/claims.example.json
VERDICT: UNVERIFIED
reason codes: legacy_untrusted, judge_abstained, thresholds_uncalibrated
...
a v1 claims file is self-reported evidence: it cannot confirm anything on its own.
```

Exit `3`. It is still not a refusal — a human decides. See `docs/CLI.md` for the full output.

## The v2 request shape

`SCHEMA_VERSION` is `2`. A request with no `schemaVersion` is read as v1. The supported
versions are `[1, 2]`; anything else is refused as `unsupported_version`.

| Field | Required | Notes |
|---|---|---|
| `schemaVersion` | yes for v2 | `2`. Absent means v1. |
| `taskId` | yes | Non-empty string, at most 4096 characters. |
| `runId` | yes | Non-empty string. |
| `projectRoot` | no | Base for scope resolution. |
| `planHash` | no | A hex digest, 8 to 128 characters. |
| `mode` | no | `consistency` or anything else for `completion`. |
| `criteria` | yes | An array. A missing or non-array value is `missing_field` or `bad_type`. |
| `observations` | no | Inline observations. The collector normally writes them separately. |
| `claims` | no | Carried for the report and for the judge's context. Never feeds a decision. |

A criterion carries `id`, `text`, `kind` (`deterministic` or `semantic`), `required`
(default `true`), `verificationScope`, `evidenceRefs`, and — for a deterministic criterion —
a `check`. A deterministic criterion without a check is `missing_field`; duplicate criterion
ids are `duplicate_id`.

A `check` has a `type` from `CHECK_TYPES`, an optional `ref`, an optional `expectExit`, and an
optional `digest`. The five types are `artifact_exists`, `artifact_nonempty`,
`artifact_digest`, `command_exit`, and `read_after_write`. Each one, and what it can and
cannot prove, is in `docs/EVIDENCE.md`.

An observation carries `observationId`, `kind` (`artifact` or `command`), `runId`, `taskId`,
and `sourceTrust` from `SOURCE_TRUST`. A `completed` command **must** carry an integer `exit`:
absent is `missing_field`, not zero. `existence: null` on an artifact means unknown and is
never read as true. Duplicate observation ids are `duplicate_id`.

Validation errors are reported as a JSON path plus a reason code and never as field content.
The codes are `missing_field`, `bad_type`, `bad_value`, `out_of_range`, `unknown_enum`,
`duplicate_id`, `unsupported_version`, and — from the parse stage — `invalid_json`.

## Converting a v1 claims file

The before file is `examples/claims.example.json`. It states three criteria and asserts the
evidence inside itself:

```json
{
  "task": "fix the failing test in src/a.ts and prove the other gates still pass",
  "claimed": "the test is green, the type check and the linter are green too",
  "criteria": [
    "the previously failing test passes",
    "the type check and the linter still pass",
    "the changed file was read back after writing"
  ],
  "evidence": {
    "writes": [{ "path": "src/a.ts", "bytes": 1204, "read_after": true }],
    "commands": [
      { "cmd": "npx vitest run src/a.test.ts", "exit": 0, "expect_exit": 0, "tail": "Tests 3 passed" },
      { "cmd": "npx tsc --noEmit", "exit": 0, "expect_exit": 0 },
      { "cmd": "npx eslint src/", "exit": 0, "expect_exit": 0 }
    ],
    "artifacts": [{ "path": "reports/test-fix.md", "bytes": 812, "exists": true }],
    "notes": "Evidence was collected by code: ..."
  },
  "evidence_ref": "reports/test-fix.md"
}
```

The after file is a v2 request. It is not a rewrite of the same JSON: the asserted evidence is
dropped and replaced with observations produced by something that actually measured. A
mechanical conversion has four steps.

1. **Turn each criterion string into a criterion object with a check.** Decide what fact would
   settle it and pick the check type that reads that fact.
2. **Move the assertion into a claim, not into the evidence.** The old `evidence.commands`
   array becomes prose in `claims.claimed`, or is deleted. It is context for the judge, not
   proof for the policy.
3. **Collect real observations.** `--collect <path>` measures an artifact now: it stats it,
   hashes it, reads it twice, and records `sourceTrust: collector_observed`. For commands, the
   observations must come from the harness or from `observationsFromEvents`; the collector
   never runs a command.
4. **Reference the observations from the criteria** with `evidenceRefs` and `check.ref`.

The result is `examples/completion.example.json`. Three criteria, three observations:

```json
{
  "schemaVersion": 2,
  "taskId": "fix-failing-test",
  "runId": "run-2026-09-22-01",
  "projectRoot": "C:/work/project",
  "mode": "completion",
  "criteria": [
    { "id": "test-green", "text": "the previously failing test passes", "kind": "deterministic",
      "required": true, "verificationScope": ["src/a.test.ts"], "evidenceRefs": ["cmd-1"],
      "check": { "type": "command_exit", "ref": "cmd-1", "expectExit": 0 } },
    { "id": "report-written", "text": "a report was written and is not empty", "kind": "deterministic",
      "required": true, "verificationScope": ["reports/test-fix.md"], "evidenceRefs": ["obs-1"],
      "check": { "type": "artifact_nonempty", "ref": "obs-1" } },
    { "id": "fix-addresses-root-cause", "text": "the change addresses the cause rather than the symptom",
      "kind": "semantic", "required": true, "verificationScope": ["src/a.ts"], "evidenceRefs": ["obs-2"] }
  ],
  "claims": { "task": "fix the failing test in src/a.ts", "claimed": "the test is green and the report is written" },
  "observations": [ ... ]
}
```

What changed, concretely:

| v1 | v2 |
|---|---|
| `criteria: ["the test passes"]` | `criteria: [{ id, text, kind, check, evidenceRefs }]` |
| `evidence.commands[].exit` | A `command` observation with `status` and `exit` |
| `evidence.writes[].bytes` | An `artifact` observation with `existence` and `bytes` |
| `evidence.artifacts[].exists` | An `artifact` observation with `existence` |
| `evidence_ref: "reports/test-fix.md"` | `verificationScope` on the criterion |
| Trust implied by the file | `sourceTrust` on each observation |
| `task` / `claimed` at the top | Under `claims`, where they never feed the decision |

`examples/answers.example.json` holds the recorded answer for the one semantic criterion:

```json
{ "fix-addresses-root-cause": { "noul": 0.93 } }
```

The old file still runs. It just cannot say `done` any more.

## The four statuses

| Status | Exit | Meaning |
|---|---|---|
| `done` | `0` | Every required criterion is supported by independent evidence. |
| `not_done` | `1` | A deterministic check failed, or the evidence contradicts the claim. |
| `review` | `2` | The evidence is not decisive; a human decides. |
| `unverified` | `3` | The claim is not confirmed. This is not a prohibition. |

The change that matters is what reaches each one. A `done` now requires `collector_observed`
or `harness_observed` trust, `full` coverage, and — when a staleness window is set — a fresh
observation. A deterministic failure is final: the model is not asked about it, and a model
"yes" for another criterion cannot lift it. `unverified` is where a missing answer, a missing
observation, an unknown existence, a partial coverage, a stale observation, an unstable
observation, an out-of-scope observation, and an unreachable judge all land. It is the
fail-open answer, and it is deliberately the largest bucket.

An empty criterion list is `unverified` with `no_verifiable_criteria`, never `done`.

## Rollback plan

Returning to v1 behaviour is possible, and it costs exactly the property the change was made
to obtain.

There is no v1 tag in this repository, so "roll back" cannot mean `git checkout <tag>`. The
v1 gate is the first commit's `scripts/jev-gate.mjs`. The steps:

1. Pin the checkout to the commit that still contains the v1 gate:
   `git checkout 2815fa1 -- scripts/jev-gate.mjs scripts/jev-decisions.mjs`.
2. Keep `lib/` out of the import graph of that file, or delete the import. The v1 gate
   imports only `scripts/jev.mjs` and `scripts/jev-decisions.mjs`.
3. Restore the v1 CLI surface: `--claims <file>` and `--dry`, with `--claims -` reading stdin.
4. Expect the v1 key resolution. `scripts/jev.mjs` matches a YAML line itself and, on failure,
   falls back to the whole file. If you keep that file, also keep `lib/credentials.mjs` out of
   the path — the two resolvers disagree on purpose.
5. Re-run `node scripts/jev-gate.mjs --claims examples/claims.example.json` and confirm it no
   longer prints `legacy_untrusted`.

What is lost:

- **A confident claims file can reach `done` again.** The gate is back to judging the agent's
  own record of its work. The v1 gate's own comment says it checks consistency, not truth; the
  v2 change is what stopped the file from being both the claim and the evidence.
- **A completed command without an exit code is accepted again.** v2 treats the missing exit as
  `missing_field`; v1's `num()` coerces it to `0`, which is a silent success.
- **`exists: null`, partial coverage, staleness and instability stop being reasons.** v2 refuses
  to confirm any of them. v1 has no equivalent.
- **The four statuses keep their names but change their meaning.** The exit codes are
  unchanged, so a caller that reads only the exit code will not notice the difference — which
  is the hazard of this rollback, not an argument against it.
- **The evidence model in `docs/EVIDENCE.md` no longer describes what runs.** Rollback is a
  change of contract, so the docs must be rolled back with the code or they become wrong.

A narrower rollback is usually the better one: keep v2 and treat `unverified` with
`legacy_untrusted` as "the caller decides", which is what a v1 caller that reads exit `3`
already does. Nothing in the code needs to change for that.

## The `calibrated: false` caveat

`DEFAULT_THRESHOLDS` is `{ no: 0.2, yes: 0.8, calibrated: false }`. The flag is not
decoration. It records that nobody measured those two numbers on this task.

Every decision carries it through: the record has `calibrated`, the human report prints
`calibrated: false`, and `thresholds_uncalibrated` is appended to the reason codes whenever
the flag is not exactly `true`. `--calibrated` is the only way to set it, and setting it
asserts something the code cannot check.

What it means for a migration:

- A `done` produced with uncalibrated thresholds is a `done` under thresholds chosen by
  default, not derived from a labelled set. It is still a `done`, because the deterministic
  criteria were decided by code — but a semantic criterion decided at `0.81` sits one
  hundredth above a line nobody drew for this task.
- To calibrate, run the rubric stand over a fixture of cases whose answers you know
  (`node scripts/jev-evals.mjs run <fixture>`), then pass the thresholds you derived with
  `--no` and `--yes` and add `--calibrated`.
- Do not set `--calibrated` to silence the reason code. The code is the honest part.

`decideFromProbability` treats anything that is not a finite number in `[0, 1]` as
`unverified`. `NaN`, `Infinity`, `2`, `-1`, `"0.9"` and `null` all decide nothing — the v1
defect where `2` read as a confident yes is pinned by a regression test.
