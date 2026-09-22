# Implementation status — jev-gates × DeepSeek Harness

Living document. Updated at the end of every stage. Written so the work can be resumed
after a context compaction: each stage records what is done, what was verified, and where
the next step starts.

Spec: `C:\Users\katoc\Documents\Codex\2026-09-22\x20\outputs\JEV_DSH_TECHNICAL_SPEC.md` (v1.0).
Prompt: `IMPLEMENTATION_PROMPT.md`. Corrections: `RESEARCH_REVIEW.md` (overrides both
research documents).

**Verification command for the whole offline suite:** `JEV_GATES_OFFLINE=1 node --test` →
**163 tests, 163 pass, 0 fail, 0 skipped**, no API key, no network.

Not every requirement is closed by a test. Where a claim rests on a runtime run rather than a
test, the run is named in "External review of v0.2.0" below, together with the limit of the
check.

---

## Stage A — preflight ✅ COMPLETE

| Item | Value |
|---|---|
| Working checkout | `C:\Users\katoc\jev-gates` |
| Commit at start | `ad5851e` — **matches the spec snapshot exactly** |
| Working tree | clean at start; no uncommitted user changes needed preserving |
| Branch / remote | `main` / `origin https://github.com/cwjechw98-lang/jev-gates.git` |
| Node | v24.14.0 (project declares `>=18`) |
| DSH installed | `0.1.5-rc.2` at `C:\Users\katoc\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` — matches the researched version |
| DSH_HOME | `C:\Users\katoc\.dsh` |
| Active profile | `web`; `profiles/web/cordis.yml` is `[]` |
| Active preset | `orchestrator-lean` |
| Active AGENTS.md | `C:\Users\katoc\.dsh\AGENTS.md` — read; carries the three-gate rule |
| Spec applicability | **applicable as written**: commit and DSH version both match |

### Authorisation boundaries in force for this session

- No live TypeSafe API calls. No paid API. The model lane stays unexecuted.
- No change to the active DSH profile, to the global `node_modules`, or to any agent preset.
- No push, no publication, no PR without a separate explicit permission.
- Local implementation, offline tests and isolated runtime smoke are authorised.

---

## Stage B — P0 core ✅ COMPLETE

Target met: `V01–V06` are regression tests, `T01–T05`, `T11`, `T24` are green, zero network.

| ID | Requirement | State | Evidence |
|---|---|---|---|
| REQ-01 | `schemaVersion: 2` contracts + v1 legacy path | ✅ | `lib/contracts.mjs` — `validateRequest`, `parseAndValidate`, `validateLegacy`; v1 short-circuits to `unverified` **without calling the model** |
| REQ-02 | pure deterministic completion policy | ✅ | `lib/policy.mjs` — `decideFromProbability`, `decideCompletion`, `STATUS_EXIT`, ~20 `REASON` codes |
| REQ-04 §8.1 | credential parser split (P0) | ✅ | `lib/credentials.mjs` — YAML only on a real `key:` mapping line, never a whole-file fallback |
| REQ-04 §8.3 | offline transport seam | ✅ | `lib/transport.mjs` — injected `fetch`/`now`/`sleep`; `test/transport.test.mjs` |
| V01–V06 | defect regressions | ✅ | `test/regressions.mjs` — V01/V01a/V01c, V01b, V02–V02c, V03–V03c, V04/V04b, V05/V05b, V06/V06b–V06i |
| T01–T05, T11, T24 | acceptance | ✅ | `test/selftest.mjs` (T24 canary: a command written in a claim is never executed; net-guard + fetch spy = 0 calls) |

Two real defects were found by running the v2 example rather than by reading it:

1. Command observations never read `coverage` — it was read for artifacts only — so every
   command reported `coverage: "unknown"` and the gate could not confirm anything. Fixed by
   moving `coverage`/`unstable` into the shared section of `validateObservation`.
2. `evidence_scope_mismatch` fired on a relative scope against an absolute observation path.
   Fixed by resolving **both** sides through `joinPath(projectRoot, …)`.

A third defect was found in the report itself: `sourceTrust` reported `self_reported` even
when every observation was harness- or collector-observed, because a semantic criterion
decided by the judge has no observation and was ranking as rank 0. Fixed by aggregating only
over passing rows that actually carry a `sourceTrust`, else `null`.

---

## Stage C — evidence model ✅ COMPLETE

| ID | Requirement | State | Evidence |
|---|---|---|---|
| REQ-03 | evidence resolution, trust, scope, freshness | ✅ | `lib/evidence.mjs`, `lib/collector.mjs` |
| REQ-05 | migration and legacy semantics | ✅ | `validateLegacy`, `docs/MIGRATION.md` |
| T06–T10 | acceptance | ✅ | `test/evidence.test.mjs` — 26 tests |

Invariants held by named tests: INV-05 (missing evidence ≠ pass), INV-06 (empty checks ≠
done), INV-07 (missing answer ≠ success), INV-08 (self-report does not raise the evidence
level), INV-01 (a factual failure is never `done`).

`tamperResistance: "none"` is stated in the code, the report output and the docs. No sandbox
claim is made anywhere.

---

## Stage D — transport, journal, replay ✅ COMPLETE (offline lanes)

| ID | Requirement | State | Evidence |
|---|---|---|---|
| REQ-04 | retry, backoff, deadlines, `Retry-After` | ✅ | `lib/transport.mjs`; T12 in `test/transport.test.mjs` |
| REQ-06 | journal, replay, threshold sensitivity | ✅ | `lib/journal.mjs` + `scripts/jev-replay.mjs`; `test/replay.test.mjs` (12 tests), T15/T23 in `test/selftest.mjs` |
| REQ-08 | evals lanes (template, fixture, missing fixture) | ✅ | `test/selftest.mjs` |
| — | replay CLI surface | ✅ | `jev-replay list\|policy\|sweep\|render\|model`; `model` refuses without `--allow-live` |

The gate now writes a **replayable** record: rows, questions and thresholds, not just a
verdict. Building the replay surface immediately exposed three defects that reading could not:

1. `STATUS_EXIT` was used in the replay before it was imported — the sweep and policy modes
   threw `ReferenceError` on every real invocation.
2. The sweep renderer read `row.status`, a field that does not exist; every row printed
   `undefined`. The real shape is `{ yes, no, decisions[] }`.
3. The replay printed the **recorded** exit code next to a re-decided status, so overriding the
   thresholds produced `status: review (exit 0)` — a contradiction in the one place a reader is
   least likely to question it. The exit code is now derived from the current policy, and a
   divergence from the recorded value is stated explicitly.

A fourth finding is a deliberate behaviour, not a defect: a record written before the current
policy version replays as `partial` and reports `unverified` rather than echoing the verdict it
once carried. A verdict that cannot be reproduced is not one the tool will stand behind.

The model-backed rubric lane remains **unexecuted** by authorisation. It is not skipped
silently: the CI job prints why, and an unreachable judge yields `unverified`, never a
blocked pipeline.

---

## Stage E — DSH adapter ✅ COMPLETE (isolated runtime verification)

Target met: the adapter is implemented, and the harness half is verified by driving the
**harness's own protocol parser** rather than by trusting documentation.

| ID | Requirement | State | Evidence |
|---|---|---|---|
| REQ-07 | doctor + capability matrix | ✅ | `adapters/dsh/doctor.mjs` — reads the install, reports `verified`/`unavailable`/`not_mounted`/`conditional` with a file:line citation per row |
| REQ-07 | hook bridge | ✅ | `adapters/dsh/bridge.mjs` + `adapters/dsh/classify.mjs` |
| REQ-09 | installer, dry-run, rollback | ✅ | `adapters/dsh/install.mjs` |
| T16 | shadow vs enforce deny | ✅ | `test/dsh-adapter.test.mjs` |
| T17 | a foreign guard's deny survives our silence | ✅ | merged through the real `mergeHookOutputs` |
| T18 | `policy = never` → `authorization_unavailable` | ✅ | no ask, no allow, no deny |
| T19 | bounded Stop steering | ✅ | budget exhausted → silence + `incomplete: true` |
| T20 | concurrent sessions do not mix | ✅ | per-session state files; unsafe ids sanitised |
| T25 | install / uninstall / reinstall | ✅ | `test/acceptance.test.mjs` — foreign lines preserved, backup never overwritten, a later user edit never discarded |

### What the runtime investigation established (all cited in `docs/DSH.md`)

- `PreToolUse` **can** deny and **can** ask. A top-level `{"decision":"deny"}` is silently
  ignored; the decision must be `hookSpecificOutput.permissionDecision`, and `hookEventName`
  must match or the whole block is discarded.
- Under `approval policy = never` an ask becomes an **automatic deny** with a reason that
  blames the user. The adapter therefore reports `authorization_unavailable` instead of
  asking, and does not auto-allow either.
- `PostToolUse` runs after the side effect, cannot undo it, and its payload carries **no
  structured exit code** — only rendered text. Observations from this path are
  `coverage: "partial"` and can never confirm a criterion alone.
- `Stop` is **not a veto**: it steers one extra step, and the dispatch can be skipped
  entirely. `stop_hook_active` is hardcoded `false` and never read. The adapter supplies its
  own bound and never claims to have vetoed anything.
- The hook bridge is **installed but not mounted**: no `hooks.json` and no composition row
  exists. A package being present is not a row being composed.
- Programmatic Cordis events are **strictly more capable** than the file bridge: they carry
  `exec.callId` and the structured `result.value`. For exit-code-dependent gates that is the
  correct integration path.

### What was deliberately NOT done

- **The active DSH profile was not touched.** No composition row was added, no preset edited,
  nothing mounted. The installer is exercised against a synthetic `DSH_HOME` in a temp
  directory, which is a real runtime check of our artifact with zero blast radius.
- **No live harness session was run.** Driving the real parser turns "the docs say the
  harness reads this field" into "this build reads this field", but it does not prove the
  wiring inside a running session. That gap is recorded in `docs/DSH.md` §Unresolved rather
  than papered over.

---

## Stage F — skills, docs, packaging ✅ COMPLETE

| ID | Requirement | State | Evidence |
|---|---|---|---|
| REQ-09 | six skills | ✅ | `skills/{jev-completion-gate,jev-approval-gate,jev-rubric-eval,jev-diagnose,jev-progress-review,jev-skill-route}/SKILL.md` |
| T26 | skills reference only real commands | ✅ | `test/acceptance.test.mjs` resolves every `node <path>` in every skill and checks the exit-code tables against the code |
| — | documentation set | ✅ | `docs/{DSH,CLI,MIGRATION,EVIDENCE,PRIVACY,DESIGN,RELEASE-NOTES-v2}.md` |
| T13 | injection cannot overturn a hard failure | ✅ | `test/acceptance.test.mjs` — five injection payloads across every text channel |
| T14 | oversized input and a missing answer in a batch | ✅ | refused by field path; truncation recorded; one unanswered criterion is enough for `unverified` |
| — | READMEs updated for v2 | ✅ | the v1 demo output was replaced with real v2 output, including the `legacy_untrusted` exit-3 case |
| — | CI covers the new suites | ✅ | `.github/workflows/ci.yml` now runs bare `node --test` (naming one file is how a suite silently stops covering new cases) |

---

## Stage G — live pilot ⛔ BLOCKED BY AUTHORISATION

Not started, by instruction: no paid API call is permitted in this session. Everything that
would need it is offline-tested against an injected judge and marked `live-validated: no`.

## Stage H — experimental tools ⏳ NOT STARTED

`jev-progress-review` and `jev-skill-route` exist as **advisory procedure skills only**. No
runtime implementation, and neither is wired into anything that could act on its own. The
spec marks this stage experimental; leaving it as procedure text is the honest stopping point.

---

## External review of v0.2.0 — R1–R7 (2026-09-22)

The review rejected the earlier claim that stages A–F were "fully closed" and, correctly,
refused to accept a test count as acceptance. Each finding below names the reproducible
scenario, the expected behaviour, and the limit of the check.

### R1 — provenance is a property of the channel, not of the field

**Was:** an observation written inline in a request body could declare
`sourceTrust: "collector_observed"` and be believed.

**Now:** `markInlineOrigin()` in `lib/contracts.mjs` rewrites any observation that arrives
inline to `sourceTrust: "self_reported"`, keeps the claim in `declaredSourceTrust` and sets
`trustDowngraded: true`. `runGate` applies it itself, so a caller cannot forget.

**Scenario:** build a request whose `observations` claim `collector_observed`; run the gate.
**Expected:** `unverified`, with reason `provenance_not_self_assignable`.
**Limit:** only the inline path is forced. A caller that writes the observation into the
collector's own file is out of scope — the file is the channel.

### R2 — no material, no question, no pass

**Was:** a semantic criterion answered `yes` could reach `done` with no observation behind it.

**Now:** `resolveCriterion` reports `supported: false` and `material: null` when no bound,
resolvable observation exists; `buildQuestions` skips unsupported criteria entirely; policy
checks `fact.supported !== true` **first**, so an answer to a question that was never built
cannot pass anything.

**Scenario:** semantic criterion, no `evidenceRefs`, judge answers `yes`.
**Expected:** `unverified`, `unsupported_by_evidence`, and the judge is never asked.
**Limit:** "resolvable" means the referenced path exists and hashes; it does not mean the
content is true.

### R3 — the judge contract

**Was:** the request body did not match the documented API.

**Now:** `buildRequest()` emits `{state, model, questions}`; each question is
`{type: 'noul', instructions: {...}, criteria: {true, false}}`; the answer is
`{type: 'noul', noul: number}`. A malformed body throws `invalid_request_shape` and is
**never sent** — the gate returns `unverified` instead.

**Scenario:** stub the transport; assert the bytes sent satisfy the documented shape; then
corrupt a question and assert zero calls.
**Limit:** verified against the published documentation, not against a live call. The live
lane stays unexecuted by authorisation.

### R4 — credential parsing

**Was:** a regex over `settings.yaml` could return the whole file as the key.

**Now:** `resolveApiKey()` in `lib/credentials.mjs` is the only reader; the legacy path is
gone. `scripts/jev.mjs` imports it.

**Scenario:** an isolated home whose YAML has no `TYPESAFE_API_KEY`, plus an isolated user
home. **Expected:** `ok: false`, `no_credential_found`, length 0.
**Limit:** the static assertion in `test/invariants.test.mjs` is scoped to the `apiKey`
function body, because `readJournal()` legitimately reads a different file.

### R5 — `enforce` + `policy: never` must deny, not stay silent

**Was:** the adapter returned `decision: null`. The PreToolUse listener calls `next()` when
neither `deny` nor `ask` is present, so the irreversible action **proceeded**. The old test
pinned that silence as correct.

**Now:** enforce mode returns `decision: "deny"` with `authorization: "authorization_unavailable"`
and a reason that says the policy made authorisation impossible. Shadow mode stays
observational.

**Scenario:** `decidePreTool({mode:'enforce', policy:'never'})` on `git push --force`, then
the real subprocess, then `parseHookOutput` from the installed `dsh-hook-protocol`.
**Expected:** `deny` at every stage. **Limit:** the harness cannot tell the hook whether the
human already approved, so in enforce mode this denies even a pre-approved action; that is
the deliberate cost of the mode and is stated in `docs/DSH.md`.

### R6 — the model lane

**Now:** a hard deterministic failure short-circuits before any judge selection; `--dry` makes
no network call, reads no credential and writes no journal record; nothing semantic means no
call at all.

**Scenario:** a failing command criterion with a stub transport that records calls.
**Expected:** exit 1, zero transport calls, zero journal records.

### R7 — isolated DSH runtime acceptance: **the gate does not hold, and says nothing**

The requested positive acceptance was attempted and produced the opposite result, which is
the more important finding.

An isolated `DSH_HOME` was built with `--from-default-profile headless` plus a `--patch`
overlay — the active profile was never read or written. The overlay mounted the harness's own
`@deepseek-ai/dsh-hooks-claude-code` against a `hooks.json` that runs the jev-gates bridge in
enforce mode, and a probe drove the real `tools/pre-execute` waterfall. No model, no cost.

**Measured:** the bridge mounts, its listener fires, and then
`shell.resolve THREW: cannot get property "sandboxPolicy" without inject`. `runHook` converts
that into an outcome with **no decision**, the merge yields `allow`, and the forbidden
`git push --force` **executes**. A hook that cannot launch is behaviourally identical to a
gate that chose to stay silent.

**Consequences applied:**
- `adapters/dsh/doctor.mjs` reports `PreToolUse deny` as **conditional**, with this evidence,
  instead of `verified`. Pinned by a test.
- `docs/DSH.md` and `docs/HARNESSES.md` carry the caution; `docs/_dsh-runtime-findings.md`
  §13 records the chain with file and line references.
- `scripts/jev-dsh-acceptance.mjs` is the reproducer. **Its own status is
  `runtime-unverified`**: it currently times out and reports `harness-not-driven` (exit 3),
  which is not a pass. The finding rests on the manual probe runs.
- `adapters/dsh/claim.mjs` supplies the missing producer for `<session>.pending-claim`, and
  the Stop handler now runs the gate for the claim instead of steering merely because a file
  exists.

**Limit:** the acceptance proves the negative on this machine and build. It does not prove
that a profile with a drivable `shell` would enforce correctly — that positive case was
attempted (swapping in `dsh-pwsh-local`) and the boot did not complete.

### Status vocabulary used from here on

| Term | Meaning |
|---|---|
| `implemented` | the code exists and the offline suite covers it |
| `protocol-tested` | the behaviour is verified against the documented API or the installed package's own parser |
| `runtime-unverified` | a real harness run has not confirmed it, or confirmed the opposite |

Stages A–F are **implemented** and **protocol-tested**. The DSH adapter as an enforcement
point is **runtime-unverified** in the sense above — a runtime run showed it does not
enforce. Stage G stays blocked by authorisation; stage H stays deprioritised.

---

## Known limitations recorded up front — still true

1. **The live model lane was not executed.** Everything model-dependent is offline-tested
   with an injected judge and marked `live-validated: no`.
2. **`tamperResistance` is `none` for local evidence.** The agent process can write to the
   same storage. No sandbox claim is made anywhere in the code or docs.
3. **The adapter is advisory on the target build.** It cannot veto a turn, cannot undo a side
   effect, and cannot see a structured exit code through the hook payload.
4. **The gate checks consistency, not truth.** Coherently invented facts pass. This is why the
   evidence must be collected by code rather than written as prose.
5. **Not a security boundary.** Stated verbatim in `docs/DESIGN.md` and `docs/DSH.md`.

---

## Repository inventory (new and changed in this work)

New: `scripts/jev-replay.mjs`, `scripts/jev-dsh-acceptance.mjs`, `lib/contracts.mjs`, `lib/policy.mjs`, `lib/answers.mjs`, `lib/credentials.mjs`,
`lib/transport.mjs`, `lib/evidence.mjs`, `lib/collector.mjs`, `lib/judge.mjs`,
`lib/journal.mjs`, `adapters/dsh/{bridge,classify,doctor,install,claim}.mjs`,
`adapters/dsh/iso-acceptance.mjs`, `test/{regressions,transport,evidence,dsh-adapter,acceptance,replay,invariants}.test.mjs`, `test/net-guard.mjs`,
`skills/*` (6), `docs/{DSH,CLI,MIGRATION,EVIDENCE,PRIVACY,RELEASE-NOTES-v2}.md`,
`docs/_dsh-runtime-findings.md`, `examples/{completion,answers}.example.json`,
`examples/demo-project/reports/test-fix.md`, `IMPLEMENTATION_STATUS.md`.

Changed: `scripts/jev-gate.mjs` (rewritten), `scripts/jev.mjs` (R4 credential path, pinned
model), `scripts/jev-decisions.mjs`, `test/selftest.mjs` (rewritten), `docs/DESIGN.md`,
`docs/HARNESSES.md`, `README.md`, `README.ru.md`, `package.json`,
`.github/workflows/ci.yml`, `.gitignore`.

Untouched by design: `scripts/jev-gateway.mjs`, `scripts/jev-evals.mjs`,
`fixtures/claim-support.json`, and everything under `C:\Users\katoc\.dsh`.

---

## Next step, if the work resumes

1. Stage H, only if wanted: a runtime implementation for progress review — and it must stay
   advisory, never killing a process or switching a model as a side effect of a score.
2. Stage G, only with explicit authorisation: one live pilot call, then compare the recorded
   answer against the offline replay for the same request — `jev-replay policy` and
   `jev-replay sweep` are the tools for that comparison, and they cost nothing.
