<img src="assets/hero-v2.png" alt="JEV Gates — six connected tools for agent workflows" width="100%">

# JEV Gates

**Evidence before “done”. Six tools and eight skills for DeepSeek Harness, with a portable Node.js verification core.**

[Русский](README.ru.md) · [User guide](docs/USER_GUIDE.md) · [Implementation status](PRODUCT_COMPLETION_STATUS.md) · [MIT](LICENSE)

JEV Gates helps an agent check completion, choose a skill, notice repeated attempts, review a bounded change, plan context reduction, and explain uncertain results. Deterministic checks run in code. Where supported, a JEV judge answers narrow semantic questions. A model opinion does not turn missing evidence into a verified fact or grant permission to act.

## What it does

| DSH tool | Use it for | Boundary |
|---|---|---|
| `jev_verify_completion` | Check required criteria against collected evidence | A missing observation stays unverified |
| `jev_route_skill` | Select an applicable existing skill | It does not create skills or permissions |
| `jev_check_progress` | Detect repetition and suggest a next step | It needs meaningful run history |
| `jev_review_scope` | Review supplied material against a narrow rubric | It is not a full repository audit |
| `jev_context_plan` | Produce a reduction plan with a restore map | Preview only; no live context compaction |
| `jev_diagnose` | Explain a result and identify the next experiment | A diagnosis is a recommendation |

The six tools are advisory. A **separate native DSH adapter** controls approval checks and Stop steering. Its modes are `off`, `shadow`, and `enforce`; the tool plugin uses `off`, `advisory`, and `shadow`. Enforcement cannot override another guard's denial.

The original approval, completion, rubric evaluation, journal, and replay commands remain available. The eight skills teach the six tools plus approval and rubric workflows; they are not eight separate tools.

## Try it offline

Requires Node.js 18 or later. Run from the repository root; no API key or dependency installation is needed for this example.

```sh
git clone https://github.com/cwjechw98-lang/jev-gates.git
cd jev-gates
node scripts/jev-gate.mjs --request examples/quickstart.json --collect examples/demo-project/reports/test-fix.md --offline --no-journal --json
```

Expected: `done`, exit `0`. This proves only that the example report exists and is nonempty. It does not prove that a bug was fixed.

Run the same request without collecting the file:

```sh
node scripts/jev-gate.mjs --request examples/quickstart.json --offline --no-journal --json
```

Expected: `unverified`, exit `3`. A request naming a file is not evidence that the collector read it.

## Use it in DeepSeek Harness

The integration was exercised with DSH `0.1.5-rc.2` and Node.js `24.14.0`. Compatibility with other DSH versions needs checking.

Follow the [installation guide](docs/USER_GUIDE.md#installation-in-deepseek-harness) to create a dedicated profile, preview the install, and load the plugins. The product installer is `scripts/jev-install.mjs`; the older `adapters/dsh/install.mjs` handles a different integration path.

The installer copies skills and writes a profile patch. Plugin paths refer to this checkout: keep it in place. Initial modes are `advisory` for tools and `shadow` for the native adapter. Model/provider configuration is a separate step.

Example request after installation:

> Use jev_verify_completion to check whether the report file exists and is nonempty. Collect the file, use a deterministic criterion, and set allowModel=false. Show the evidence and any missing checks.

## Read results correctly

| Completion result | Meaning | CLI exit |
|---|---|---|
| `done` | Required criteria passed on the supplied evidence | 0 |
| `not_done` | A required criterion failed | 1 |
| `review` | Human review is needed | 2 |
| `unverified` | Evidence is insufficient | 3 |

DSH tools return an envelope: top-level `success` means a result was produced. For completion, inspect `decision.completionStatus`; also read evidence, reason codes, and model usage. `actionAuthority: none` means the tool grants no permission.

## What has been demonstrated

The recorded acceptance exercises a real DSH agent loop with a **scripted provider**, tool dispatch, approval handling, and Stop steering. All six tools were observed in the agent catalog; `jev_route_skill` was actually executed through that registry. The other five have offline coverage and catalog checks. This does **not** establish live JEV judgment quality.

See [the capability-by-capability status](PRODUCT_COMPLETION_STATUS.md) and [the optional live pilot](LIVE_PILOT_PLAN.md). Test counts describe a particular run, not a guarantee of correctness.

```sh
node --test
# Requires a locally installed compatible DSH; writes acceptance artifacts:
node scripts/jev-product-acceptance.mjs
```

## Limits

- Evidence checks are only as broad as the declared criteria and collected material.
- Local journals are useful for inspection and replay, not tamper-proof attestations.
- Stop steering is guidance to the agent, not an unconditional veto of termination.
- Context planning does not modify a live conversation.
- Live model access, credentials, availability, and cost depend on the selected provider. Offline acceptance does not require paid calls.
- The legacy shell-hook bridge has a documented limitation in the tested DSH build; the native adapter uses a different path.

## Documentation

- [User guide and troubleshooting](docs/USER_GUIDE.md)
- [Russian user guide](docs/USER_GUIDE.ru.md)
- [CLI reference](docs/CLI.md), [evidence model](docs/EVIDENCE.md), [migration](docs/MIGRATION.md)
- [DSH integration details](docs/DSH.md), [source traceability](docs/SOURCE-TRACEABILITY.md)
- [Product status](PRODUCT_COMPLETION_STATUS.md), [live pilot](LIVE_PILOT_PLAN.md)

Licensed under [MIT](LICENSE).
