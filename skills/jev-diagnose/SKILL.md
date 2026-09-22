---
name: jev-diagnose
description: Work out why a gate returned unverified, unavailable or a protocol error, and pick one new experiment instead of retrying the same call. Use when a gate fails without explaining itself, when a hook does not fire, or when a verdict contradicts what you can see.
whenToUse: A gate returned unverified, unavailable or a protocol error. A hook did not fire. A verdict contradicts observable reality. Also before repeating a failed call.
---

# Diagnose — one new experiment, not another retry

A second identical failure is a systemic cause, not bad luck. The rule here is strict: **do
not repeat the same call without a new reason.** "Identical" means the same input, the same
environment and the same method.

## 1. Ask the environment first

```bash
node adapters/dsh/doctor.mjs          # what can the adapter actually guarantee here?
node adapters/dsh/doctor.mjs --json
```

| exit | status | meaning |
|---|---|---|
| 0 | `healthy` | everything the adapter claims is available |
| 1 | `degraded` | it works, with reduced effect — read the capability rows |
| 2 | `misconfigured` | it cannot run at all — the harness was not found |

Every capability row carries `verdict`, `consequence` and an `evidence` citation with a file
and line. If a row says `unavailable`, the feature is not missing from your configuration —
it is missing from the build.

## 2. Classify the failure before reacting

| symptom | likely cause | the one useful next experiment |
|---|---|---|
| `judge_unavailable` | key absent, or the API is down | `node scripts/jev.mjs check` — one call, then read the reason code |
| `unverified` with `no_verifiable_criteria` | the criteria cannot be checked by code | rewrite a criterion so it has a `check` |
| `unverified` with `evidence_partial_coverage` | the observation is incomplete | measure through a path that reports fully |
| `unverified` with `evidence_scope_mismatch` | the evidence is outside the declared scope | fix the scope or collect inside it |
| exit 2 from the gateway | an irreversible action was declared | confirm the declaration is accurate before overriding |
| a hook that never fires | the bridge is not mounted | `node adapters/dsh/doctor.mjs` — look for `not_mounted` |
| a decision that is silently ignored | the wrong output field | the harness reads `hookSpecificOutput.permissionDecision`, not a top-level `decision: deny` |

## 3. Check the measuring instrument before blaming the work

The instrument starts as a suspect with a record. Before concluding that the work is wrong,
confirm that the check can produce a *different* answer: run the same question against a case
whose answer you know.

```bash
node scripts/jev-evals.mjs run fixtures/claim-support.json
```

If gate 1 (known answers) is red, the instrument is the problem — not the thing it judged.

## 4. Read the journal

```bash
node scripts/jev-decisions.mjs summary
```

A `partial replay` note means the record predates the policy version and carries no basis.
That is a statement about the record, not a verdict about the work.

## 5. Stop conditions

- Two identical deterministic failures → stop and change the method, not the retry count.
- A journal line that will not parse → the journal is marked incomplete; do not present it as
  the whole audit trail.
- A gate that cannot answer → `unverified`. It is never a block and never a confirmation.
