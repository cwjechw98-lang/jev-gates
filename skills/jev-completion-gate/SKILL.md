---
name: jev-completion-gate
description: Confirm that work is actually finished before reporting it as done. Collects code-measured evidence (files re-read after write, command exit codes, artifact digests), then judges only what code cannot decide. Use before saying "done", "fixed", "green", "all tests pass", or before handing work to a human for review.
whenToUse: The agent is about to claim completion, or a task asks for proof that a change works. Also when a previous "done" turned out to be wrong and the reason needs to be found.
---

# Completion gate — evidence before the word "done"

**This skill is a procedure, not an enforcement mechanism.** It cannot stop you. The exit
code is only as strong as your willingness to read it.

The order is fixed and must not be rearranged:

```
do the work  →  READ THE TARGET  →  collect evidence  →  judge
```

Judging a summary of your own work without reading the target adds one more opinion, not
proof.

## 1. Write the request

A request names the criteria and carries the observations that code measured. Minimum:

```json
{
  "schemaVersion": 2,
  "taskId": "fix-failing-test",
  "runId": "run-1",
  "projectRoot": "C:/work/project",
  "criteria": [
    { "id": "test-green", "text": "the failing test passes", "kind": "deterministic", "required": true,
      "verificationScope": ["src/a.test.ts"], "evidenceRefs": ["cmd-1"],
      "check": { "type": "command_exit", "ref": "cmd-1", "expectExit": 0 } },
    { "id": "root-cause", "text": "the change addresses the cause, not the symptom", "kind": "semantic", "required": true }
  ],
  "observations": [ /* produced by the collector, not by hand */ ]
}
```

`kind: "deterministic"` means **code decides it** and the model is never asked.
`kind: "semantic"` is the only kind that becomes a question.

Check types: `artifact_exists`, `artifact_nonempty`, `artifact_digest`, `command_exit`,
`read_after_write`.

## 2. Let the collector measure

```bash
node scripts/jev-gate.mjs --request request.json --collect reports/out.md
```

`--collect` reads the named artifacts and records size, digest and stability. It never runs
a command: a verifier that executes things is a verifier that causes side effects.

## 3. Read the verdict

```bash
node scripts/jev-gate.mjs --request request.json          # human report
node scripts/jev-gate.mjs --request request.json --json   # machine contract
```

| exit | status | what to do |
|---|---|---|
| 0 | `done` | every required criterion is supported by independent evidence — report completion |
| 1 | `not_done` | a check failed or the evidence contradicts the claim — **do not report completion** |
| 2 | `review` | the evidence is not decisive — hand it to a human with the reason codes |
| 3 | `unverified` | nothing is confirmed — this is not a prohibition; a human decides |

## 4. Act on the reason codes

| reason code | meaning | what fixes it |
|---|---|---|
| `required_criterion_failed` | a deterministic check failed | fix the work |
| `required_criterion_unknown` | no usable evidence | collect it — do not restate the claim |
| `evidence_scope_mismatch` | the evidence is outside the criterion's scope | collect evidence for the declared scope |
| `evidence_stale` | the observation predates the last write | re-measure |
| `evidence_partial_coverage` | the observation is incomplete | use a path that measures fully |
| `self_reported_only` | only your own word backs the criterion | replace it with a measurement |
| `judge_unavailable` | the judge could not be reached | not a block: report `unverified` |
| `no_verifiable_criteria` | nothing to evaluate | write criteria that code can check |
| `thresholds_uncalibrated` | the thresholds were never calibrated here | treat the verdict as advisory |
| `deterministic_conflict_with_claim` | the judge approved while code found a failure | code wins |

## 5. What this gate does not do

- It checks that the evidence is **consistent** with the claim, not that it is **true**.
  Invented but coherent facts pass.
- Local evidence has `tamperResistance: "none"`. A process with write access to the same
  storage can alter it. Nothing here defends against that.
- It never executes a command written in a claim.
- A `done` requires independent evidence. A v1 claims file is self-reported by definition,
  so it can only ever reach `unverified` — that is deliberate.

## Offline and replay

```bash
node scripts/jev-gate.mjs --request request.json --offline           # never contact the judge
node scripts/jev-gate.mjs --request request.json --answers rec.json  # replay recorded answers
```

`--offline` is how you check the deterministic half of a request without spending anything.
