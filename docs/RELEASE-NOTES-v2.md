# Release notes: schema v2

## The headline breaking change

**A v1 claims file can no longer reach `done`.**

In v1 the gate read `claims.evidence.commands[].exit` and `claims.evidence.writes[].bytes` out
of the claims file and computed its numbers from them. The file was both the claim and the
evidence. In v2 those fields are not evidence: a v1 file is marked `legacy-untrusted`, its
criteria are `self_reported`, and the best it can produce is `unverified` with reason code
`legacy_untrusted`, exit `3`.

This was not a decision to be stricter. A self-report cannot raise the level of evidence, and
the v1 gate's own documentation said so while the code did the opposite.

Verified against the shipped example:

```
$ node scripts/jev-gate.mjs --claims examples/claims.example.json
VERDICT: UNVERIFIED
reason codes: legacy_untrusted, judge_abstained, thresholds_uncalibrated
```

`unverified` is not a block and not a refusal. A human still decides, and every integration is
told to treat exit `3` as "not confirmed".

## New capabilities

- **Deterministic criteria.** A criterion declares a `check` from a closed list of five types,
  and code decides it. The model is never asked about it. A model "yes" can no longer lift a
  criterion a check already failed.
- **Real observation collection.** `--collect <path>` measures an artifact now: stat, hash, and
  a second read to detect a file that changed under the collector.
- **Trust levels.** `self_reported`, `collector_observed`, `harness_observed`. The level is
  assigned by the collection path, never chosen by the caller, and only independent evidence can
  confirm a criterion. See `docs/EVIDENCE.md`.
- **Coverage, scope, staleness and instability as first-class facts.** A partial observation, an
  out-of-scope observation, a stale observation and an unstable observation each produce their
  own reason code instead of a pass.
- **An offline lane that proves it is offline.** `--offline` and `JEV_GATES_OFFLINE=1` make
  semantic criteria `unverified` without constructing a request.
- **Answer replay.** `--answers <file>` re-runs the pipeline on recorded answers, validated
  through the same path as live ones.
- **A machine contract.** `--json` emits the full decision, including `exitCode`, `basis`,
  per-criterion rows, `enforcement` and `tamperResistance`.
- **A decision journal with a basis.** Records carry the counted facts and the per-criterion
  rows, so `replayPolicy` can reproduce a verdict under different thresholds without a model.
- **A DSH adapter with an honest capability report.** `adapters/dsh/doctor.mjs` states what the
  installed build can and cannot do, per capability, with a citation.

## Known limits

- **The gate checks consistency, not truth.** Coherent invented evidence passes. The facts must
  come from a collector or a harness, and that is a convention the gate enforces structurally,
  not a proof.
- **`tamperResistance: "none"`.** A process with write access to the same storage can alter the
  evidence between measurement and judgement. This is stated on every payload and in every human
  report rather than hidden.
- **Not a security boundary and not a privilege boundary.** See `docs/DESIGN.md`.
- **The thresholds are uncalibrated by default.** `calibrated: false` is recorded on every
  decision and `thresholds_uncalibrated` is appended to the reason codes. `--calibrated` asserts
  something the code cannot check.
- **The middle band goes to a human.** With the defaults (`no <= 0.2`, `yes >= 0.8`), everything
  between is `review`.
- **The judge drifts between runs.** Pin `jev-1.13.0` rather than `jev-latest` for anything that
  goes into a report. A verdict near the threshold should not be taken from a single run.
- **An unreachable judge yields `unverified`.** That is fail-open by design; it is also less
  informative than a real answer.
- **The DSH adapter is advisory on the build it targets.** It cannot veto a turn, cannot undo a
  side effect, and cannot see a structured exit code through the hook payload. On the build
  checked here the bridge is also not mounted, so the doctor reports `degraded`.
- **`read_after_write` needs provenance most adapters do not report.** Without it the fact is
  `unknown`, never a pass.
- **The gate never executes a command.** A claim that a command ran is not evidence that it ran.

## Upgrade

The upgrade is a change to your request files, not an install step. There is no migration
command; conversion is manual, and `docs/MIGRATION.md` walks through it.

```bash
# 1. Check what the installed harness can actually do.
node adapters/dsh/doctor.mjs

# 2. Convert a v1 claims file into a v2 request.
#    See docs/MIGRATION.md for the four-step conversion.

# 3. Measure the artifacts the criteria name.
node scripts/jev-gate.mjs --request request.json --collect reports/out.md

# 4. Run the gate offline first: this shows what code decided, with no model call.
node scripts/jev-gate.mjs --request request.json --offline --dry

# 5. Run it for real, or replay recorded answers.
node scripts/jev-gate.mjs --request request.json
node scripts/jev-gate.mjs --request request.json --answers recorded.json

# 6. Confirm the exit code you are integrating against.
#    0 done, 1 not_done, 2 review, 3 unverified.
```

Keep the v1 file in the repository after converting. It still runs, it still exits `3`, and it
documents what was claimed before the change.
