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
| C1 | `jev_verify_completion` | `lib/contracts`, `lib/evidence`, `lib/policy`, `scripts/jev-gate.mjs` | no shared envelope; observations could not come from real tool executions; the snapshot did not include artifact digests, so INV-07 was unenforceable | `lib/verify.mjs`, `lib/capability.mjs`, `lib/toolspec.mjs`, `adapters/dsh/tools.mjs` | tool registry, `ctx.effect` | `test/capabilities-c1.test.mjs` (16) | `offline-tested`, in a real agent's catalog |
| C2 | `jev_route_skill` | `lib/skills.mjs` (new this round) | routing existed only as a skill document, not as code; no authority order, no exclusion of unrunnable skills | `lib/route.mjs`, `adapters/dsh/tools.mjs` | skill catalog, judge | `test/capabilities-c2-c4.test.mjs` (37) + executed by a real harness registry in the agent set | **`runtime-tested`** |
| C3 | `jev_check_progress` | `adapters/dsh/plugin.mjs` stop rule | the stop rule lived inside the adapter and could not be reasoned about alone; no budget handoff | `lib/progress.mjs` | tool registry | `test/capabilities-c3-c5.test.mjs` (51) | `offline-tested`, in a real agent's catalog |
| C4 | `jev_review_scope` | — | no bounded review at all; a truncated or missing material could have been reported as a pass | `lib/review.mjs` | judge, pinned material | `test/capabilities-c2-c4.test.mjs` (37) | `offline-tested`, in a real agent's catalog |
| C5 | `jev_context_plan` | — | nothing planned context reduction; dropping a live authorisation or the goal would have been silent | `lib/context-plan.mjs` | — | `test/capabilities-c3-c5.test.mjs` (51) | `offline-tested`, in a real agent's catalog |
| — | `jev_diagnose` | `skills/jev-diagnose` | diagnosis was prose; the tool returns one named next experiment | `adapters/dsh/tools.mjs` | — | `test/dsh-native-adapter.test.mjs` (23) | `offline-tested`, in a real agent's catalog |
| — | `jev_approval_gate` | `lib/policy`, `adapters/dsh/plugin.mjs` | the adapter's Stop steer was malformed, so its decision never reached the model | `adapters/dsh/plugin.mjs` now steers a complete `UserMessage` | approval service | `test/dsh-adapter.test.mjs` (26) + agent set S3/S4 | `runtime-tested` |

Only C2 is `runtime-tested`, and the distinction is deliberate. All six tools were
observed in a real agent's model-facing catalog, which is real evidence they are
reachable. Only `jev_route_skill` was actually executed by the real registry. The
other five stay `offline-tested` with the catalog fact recorded alongside, because a
catalog proves a tool is reachable and not that it works. See `PRODUCT_ACCEPTANCE.json`
for the three separate fields: `registeredInHarness`, `executedInHarness`, `invokedByModel`.

## Cross-cutting requirements (spec §4)

| requirement | how it is met | status |
|---|---|---|
| one shared core, no second dialect | `lib/capability.mjs` re-exports `REASON` from `lib/policy.mjs` and `EVIDENCE_REASON` from `lib/evidence.mjs`; `ALL_REASON_CODES` is their union (54 codes) | `offline-tested` |
| versioned I/O with `taskId`/`runId` and snapshot identity | every envelope carries `envelopeVersion`, `capabilityVersion`, `taskId`, `runId`, `snapshot` | `offline-tested` |
| statuses never mixed with authorisation | `actionAuthority` is always `'none'`; asserted in C1 tests and in the envelope builder | `offline-tested` |
| `off` / `advisory` / `shadow` modes | `CAPABILITY_MODE`, `resolveMode`; each tool can be disabled per row | `offline-tested` |
| timeout / cancellation / budget | `withBudget` wraps every model call; a timeout is its own reason code | `offline-tested` |
| CLI **and** real registration in an isolated DSH | `adapters/dsh/tools.mjs` registers six tools via `ctx.tools.register`; `scripts/jev-install.mjs` writes the patch; the acceptance's `install:patch-appears-in-composition` asks the harness to dump its own composed tree and finds both rows there | `runtime-tested` (row mount) |
| the tools are in the catalog a model actually sees | read in **agent scope** (`schemas(scope?)`), because a bare boot has no agent and reports an empty global view — including `pwsh` and `read`. The agent set now records all six in a real agent's catalog, each with a description and `parameters.type === 'object'` | `runtime-tested` |
| a real turn reaches the tools and the approval service | the agent set drives a real DSH boot, a real agent and a real turn with a scripted provider: the loop calls the provider, executes the model-issued call, an agent-bound `ask` goes through the real `approval/request` service, and the real `ctx.skills` loads the skill the router named | `runtime-tested` (mechanism only) |
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
| runtime exercise in an isolated DSH | **held**: native set, install set and agent set all pass — `node scripts/jev-product-acceptance.mjs` → `held (exit 0)` |
| the adapter's Stop decision actually reaches the model | **yes, after a fix**: the steer was `{content}` and the loop requires a full `UserMessage`; found by the agent set's two-boot control, fixed, and now verified by the real loop |
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
  `<DSH_HOME>`. It created eight skill files, one profile directory and a
  manifest; nothing was overwritten (every backup field was `null`). It was reverted
  with the installer's own `--uninstall`, which removed exactly what it had written,
  and the skill catalog returned to its prior state. The active `web` profile was never
  touched. The test now fakes **both** paths and carries a read-only witness that fails
  the set if the real home changes at all. The guard was also re-aimed: it now protects
  the default home specifically rather than whatever `DSH_HOME` happens to be, because
  the old rule also blocked the documented pilot flow.
- **2026-09-22 — the adapter's Stop decision never reached the model.** `adapters/dsh/plugin.mjs`
  steered with `agent.steer({ content: [...] })`, but `steer` takes a `UserMessage`, which
  requires `id`, `role`, `content` and `source`. The loop's runtime-context projection
  dereferences `message.source.kind` on every `user/message`, so the missing `source` threw
  `Cannot read properties of undefined (reading 'kind')`, the turn ended as `error`, and the
  steering message never became a step. The gate decided correctly and the model never heard
  about it — every log line the adapter wrote was right. Found by the agent set's two-boot
  control, which isolated the message from the loop: the same `decideStop`, the same claim and
  the same gate with a well-formed message ran the extra step, suppressed the repeat and kept
  the claim pending. Fixed; S2 and S4 now pass through the real adapter.
- **2026-09-22 — a throwaway probe wrote to `<user home>`.** A `$home`/`$HOME` collision in
  a temporary probe made DSH resolve its home to the user directory rather than `.dsh`, creating
  `profiles`, `sessions` and `storages` there. They were removed and the active profile was
  verified byte-identical before and after a full run. The acceptance's scratch root is always
  outside the repository, including under `--keep`.
