# Product completion status

What the product promises, what already existed, what had to be built, and how far
each piece is actually proven. The status vocabulary is deliberately narrow, and a
piece never claims a rung it did not reach:

| label | means |
|---|---|
| `implemented` | the code exists and is wired |
| `offline-tested` | its logic is covered by tests that run without DSH |
| `runtime-tested` | a real DSH process exercised it |
| `live-validated` | a real model drove it and the outcome was checked |
| `not-supported` | the interface to do it does not exist; we say so instead of faking it |

A scripted test provider can reach `runtime-tested` and **never** `live-validated`.
That distinction is the whole point of the column.

## Capabilities

| # | capability | existing component | gap found | work done | depends on | check | status |
|---|---|---|---|---|---|---|---|
| C1 | `jev_verify_completion` | `lib/contracts`, `lib/evidence`, `lib/policy`, `scripts/jev-gate.mjs` | no shared envelope; observations could not come from real tool executions; the snapshot did not include artifact digests, so INV-07 was unenforceable | `lib/verify.mjs`, `lib/capability.mjs`, `lib/toolspec.mjs`, `adapters/dsh/tools.mjs` | tool registry, `ctx.effect` | `test/capabilities-c1.test.mjs` (13) | `offline-tested` |
| C2 | `jev_route_skill` | `lib/skills.mjs` (new this round) | routing existed only as a skill document, not as code; no authority order, no exclusion of unrunnable skills | `lib/route.mjs`, `adapters/dsh/tools.mjs` | skill catalog, judge | `test/capabilities-c2-c4.test.mjs` (37) | `offline-tested` |
| C3 | `jev_check_progress` | `adapters/dsh/plugin.mjs` stop rule | the stop rule lived inside the adapter and could not be reasoned about alone; no budget handoff | `lib/progress.mjs` | tool registry | `test/capabilities-c3-c5.test.mjs` (51) | `offline-tested` |
| C4 | `jev_review_scope` | — | no bounded review at all; a truncated or missing material could have been reported as a pass | `lib/review.mjs` | judge, pinned material | `test/capabilities-c2-c4.test.mjs` (37) | `offline-tested` |
| C5 | `jev_context_plan` | — | nothing planned context reduction; dropping a live authorisation or the goal would have been silent | `lib/context-plan.mjs` | — | `test/capabilities-c3-c5.test.mjs` (51) | `offline-tested` |
| — | `jev_diagnose` | `skills/jev-diagnose` | diagnosis was prose; the tool returns one named next experiment | `adapters/dsh/tools.mjs` | — | `test/dsh-native-adapter.test.mjs` (23) | `offline-tested` |
| — | `jev_approval_gate` | `lib/policy`, `adapters/dsh/plugin.mjs` | — | unchanged | — | `test/dsh-adapter.test.mjs` (26) | `offline-tested` |

## Cross-cutting requirements (spec §4)

| requirement | how it is met | status |
|---|---|---|
| one shared core, no second dialect | `lib/capability.mjs` re-exports `REASON` from `lib/policy.mjs` and `EVIDENCE_REASON` from `lib/evidence.mjs`; `ALL_REASON_CODES` is their union (54 codes) | `offline-tested` |
| versioned I/O with `taskId`/`runId` and snapshot identity | every envelope carries `envelopeVersion`, `capabilityVersion`, `taskId`, `runId`, `snapshot` | `offline-tested` |
| statuses never mixed with authorisation | `actionAuthority` is always `'none'`; asserted in C1 tests and in the envelope builder | `offline-tested` |
| `off` / `advisory` / `shadow` modes | `CAPABILITY_MODE`, `resolveMode`; each tool can be disabled per row | `offline-tested` |
| timeout / cancellation / budget | `withBudget` wraps every model call; a timeout is its own reason code | `offline-tested` |
| CLI **and** real registration in an isolated DSH | `adapters/dsh/tools.mjs` registers six tools via `ctx.tools.register`; `adapters/dsh/catalog-probe.mjs` reads the catalog back | registration `runtime-tested`; catalog read pending the agent set |
| one skill per capability | `skills/jev-completion-gate`, `jev-skill-route`, `jev-progress-review`, `jev-review-scope`, `jev-context-plan`, `jev-diagnose` | `implemented` |
| journal sufficient for replay | `lib/journal.mjs` (`JOURNAL_VERSION=2`, `REPLAY_MODE`) unchanged and still covered | `offline-tested` |
| one success, one indeterminate, one error example | `docs/CLI.md`, and the C1 tests carry all three paths | `offline-tested` |

## Stage H

Stage H is C2–C5 (spec §14 = REQ-10). C1 is core, not experimental.

| item | state |
|---|---|
| C2, C3, C4, C5 implemented as tools + skills | yes |
| each registered in the harness | via `adapters/dsh/tools.mjs` |
| each with a skill | yes |
| runtime exercise in an isolated DSH | native set held; agent set pending |
| honest limit carried in every envelope | yes |

## Deliberately not done

These are not gaps to close; they are limits we chose to state rather than paper over.

- **C5 does not compact a live request.** The spec (§14.4) says wiring a candidate
  context into the real pipeline "требует отдельной проверки DSH interface", and this
  work did not establish that interface. C5 ships as a preview plus a restore map and
  says so in every envelope.
- **C4 does not run syntax, type or test checks.** Those are deterministic and belong
  to the completion gate. C4 says so in `limits` rather than pretending to be a linter.
- **The guard surface is not a security boundary.** It is a policy control. `docs/SOURCE-TRACEABILITY.md`
  records what the source actually guarantees.
- **No paid JEV call was made.** The `choice` lane of the judge is exercised offline
  against a fake; its live wire shape is taken from the skill document and is not
  confirmed. A partial distribution is rejected rather than argmaxed, so an unexpected
  live shape produces `abstain`, not a guess.
- **A scripted provider is not model quality.** It proves the mechanism end to end and
  nothing about whether a JEV judgement is any good.

## Incidents

- **2026-09-22 — the acceptance wrote into the live DSH home.** A first version of the
  install set passed the real `$DSH_HOME` as `--home` while overriding `DSH_HOME` in the
  child's environment. The installer compares those two to decide whether it is looking
  at the active home, so the mismatch defeated the guard and the install landed in
  `C:\Users\katoc\.dsh`. It created eight skill files, one profile directory and a
  manifest; nothing was overwritten (every backup field was `null`). It was reverted
  with the installer's own `--uninstall`, which removed exactly what it had written,
  and the skill catalog returned to its prior state. The active `web` profile was never
  touched. The test now fakes **both** paths and carries a read-only witness that fails
  the set if the real home changes at all.
