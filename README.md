<div align="center">
  <img src="assets/hero.jpg" alt="Jev Gates — three glowing gates in cyan, violet and amber on a dark grid" width="100%">
</div>

<div align="center">

# Stop saying "done" without proof.

Three small gates between an AI coding agent and its consequences.
**No SDK. No dependencies. No server.** Plain Node 18+ scripts that any harness can run.

[![CI](https://github.com/cwjechw98-lang/jev-gates/actions/workflows/ci.yml/badge.svg)](https://github.com/cwjechw98-lang/jev-gates/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-3fb950?style=flat-square)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-%E2%89%A5%2018-339933?style=flat-square&logo=node.js&logoColor=white)](package.json)
[![Dependencies: 0](https://img.shields.io/badge/dependencies-0-22d3ee?style=flat-square)](package.json)
[![Cost per check](https://img.shields.io/badge/cost%20per%20check-%240.0001-fbbf24?style=flat-square)](#-cost)
[![Model calls](https://img.shields.io/badge/model%20calls-2%20of%203%20gates-a78bfa?style=flat-square)](#the-three-gates)

[Quick start](#-quick-start) · [The three gates](#the-three-gates) · [Any harness](#-works-with-any-harness) · [Design rules](docs/DESIGN.md) · [Русский](README.ru.md)

</div>

---

A coding agent reports success. It has three ways to be wrong, and each one needs a different
kind of check.

<table>
<tr>
<td width="33%" valign="top">

### 🔒 It acts when it should have asked

Approval prompts get switched off — for speed, for unattended runs, or because the harness
never had them. Then nothing stands between the agent and a force-push.

</td>
<td width="33%" valign="top">

### ✅ It says "done" without proof

Not usually lying: it read its own summary of what it did, and the summary was optimistic.
A stricter prompt does not fix this.

</td>
<td width="33%" valign="top">

### 🧪 It trusts a broken rubric

A new yes/no question looks reasonable, gets wired into a pipeline, and quietly answers "yes"
to everything. Nobody notices until someone checks the check.

</td>
</tr>
</table>

Each gate answers **one narrow question**. Everything a program can compute stays in the
program; only the judgment is asked for.

---

## The three gates

<table>
<tr>
<td align="center" width="33%">
<img src="assets/gate-approval.jpg" alt="A neon cyan gate with a raised hand and a padlock" width="230"><br><br>
<b>🔒 Approval</b><br>
<sub>before an irreversible action</sub><br><br>
<code>0</code> go &nbsp;·&nbsp; <code>2</code> ask the human<br>
<sub><b>no model, 0 ms, $0</b></sub>
</td>
<td align="center" width="33%">
<img src="assets/gate-completion.jpg" alt="A neon violet magnifier over documents with a checkmark" width="230"><br><br>
<b>✅ Completion</b><br>
<sub>before the word "done"</sub><br><br>
<code>0</code> confirmed &nbsp;·&nbsp; <code>1</code> not done<br>
<code>2</code> human &nbsp;·&nbsp; <code>3</code> unverified
</td>
<td align="center" width="33%">
<img src="assets/gate-rubric.jpg" alt="A neon amber gauge and a target" width="230"><br><br>
<b>🧪 Rubric</b><br>
<sub>before you trust a rubric</sub><br><br>
<code>0</code> passed &nbsp;·&nbsp; <code>1</code> failed<br>
<sub><b>three gates, in order</b></sub>
</td>
</tr>
</table>

<div align="center">
  <img src="assets/how-a-gate-decides.svg" alt="Diagram: code builds the state and questions, Jev returns probabilities, code applies the thresholds and produces four outcomes" width="100%">
</div>

The judgment comes from [TypeSafe Jev](https://www.typesafe.ai/) (System One): you send a
state and a typed question, you get back a **probability**. Not generated text — a number that
code can compare against a threshold.

---

## ⚡ Quick start

No install, no dependencies, Node 18+:

```bash
git clone https://github.com/cwjechw98-lang/jev-gates.git
cd jev-gates
node --test test/selftest.mjs          # 18 checks, no API key, no network
```

The approval gate needs **no key at all**:

```bash
node scripts/jev-gateway.mjs --action push_public --external --public --reversible=false
```

```
action: push_public
verdict: ASK A HUMAN
  reason: public_irreversible: published outward with no way back
  reason: external_irreversible: external action with no way back
(advice, not enforcement: this gate does nothing and blocks nothing)
```

Exit code `2`. The other two gates need a TypeSafe key, read from `TYPESAFE_API_KEY`, then
`$JEV_GATES_HOME/key`, then `~/.dsh/.credentials.yaml`, then `~/.config/jev-gates/key`:

```bash
export TYPESAFE_API_KEY=...
node scripts/jev.mjs check
# route: WORKING
# model: jev-1.13.0, yes probability: 0.9
# cost: $0.000012
```

---

## 🔒 Gate 1 — before an irreversible action

```bash
node scripts/jev-gateway.mjs --action delete_backup --destructive --reversible=false
echo '{"action":"edit_readme","reversible":true}' | node scripts/jev-gateway.mjs --quiet
node scripts/jev-gateway.mjs --rules        # the whole rule table, in one screen
```

Rules are **data, not branching**, so they can be read and argued with:

| Rule | Fires when |
|---|---|
| `credential_out` | a credential leaves the machine |
| `destructive_irreversible` | destructive with no way back |
| `public_irreversible` | published outward with no way back |
| `external_irreversible` | external action with no way back |
| `bulk_irreversible` | bulk operation with no way back |
| `undeclared` | the action is not described, so there is nothing to judge |

Irreversibility is assumed only when declared: `--reversible=false`. Everything else defaults
to reversible, because a gate that blocks routine work gets switched off within a day.

> [!WARNING]
> **It is advice, not enforcement.** The gate executes nothing and blocks nothing; it tells the
> caller whether to stop and ask. And it cannot catch mis-declared flags — an action described
> as safe while being destructive will pass. Describing the action honestly is part of the
> work, not paperwork.

---

## ✅ Gate 2 — before the word "done"

The order is fixed: **do the work → read the target → collect evidence → judge.** Judging a
success message without reading the target adds one more opinion, not proof.

Write down what you claim, and the proof code can verify:

```json
{
  "task": "fix the failing test in src/a.ts",
  "claimed": "the test is green, the type check and the linter are green too",
  "criteria": ["the previously failing test passes", "the changed file was read back after writing"],
  "evidence": {
    "writes": [{ "path": "src/a.ts", "bytes": 1204, "read_after": true }],
    "commands": [
      { "cmd": "npx vitest run src/a.test.ts", "exit": 0, "expect_exit": 0, "tail": "Tests 3 passed" },
      { "cmd": "npx tsc --noEmit", "exit": 0, "expect_exit": 0 }
    ],
    "artifacts": [{ "path": "reports/test-fix.md", "bytes": 812, "exists": true }]
  }
}
```

```bash
node scripts/jev-gate.mjs --claims examples/claims.example.json --dry   # what the model will see
node scripts/jev-gate.mjs --claims examples/claims.example.json
```

`--dry` prints the computed state and the questions and calls nothing — the cheapest way to see
whether your evidence is even worth judging.

The output separates what **code computed** from what the **model judged**:

```
VERDICT: CONFIRMED
reason: all 6 questions passed
evidence: {"writes":1,"writesRead":1,"commands":3,"cmdsOk":3,"artifacts":1,"artsOk":1,"criteria":3}

  read_after_write     0.98   yes
  reproduced           0.96   yes
  artifacts_present    0.96   yes
  criterion_1          0.94   yes
  criterion_2          0.97   yes
  criterion_3          0.98   yes

model jev-1.13.0, input 975 tokens, $0.000041
limit: this gate checks that the evidence is consistent, not that it is true.
```

Questions that cannot apply are **not asked**. With no files, no commands, no artifacts and no
criteria there is nothing to judge, and the gate exits `3` with "NOTHING TO CHECK" — that is
not "done", it is the absence of evidence.

> [!IMPORTANT]
> **What it does not do:** it checks that the evidence is *consistent* with the claim, not that
> it is *true*. Invent the facts coherently and the gate will not catch you. That is exactly
> why the evidence has to be collected by code — file sizes, exit codes, artifact existence —
> and not written as prose.

---

## 🧪 Gate 3 — before you trust a rubric

A rubric is an instrument, and an instrument starts as a suspect. `jev-evals` runs three gates
in a fixed order:

| # | Gate | Question |
|---|---|---|
| 1 | **Known answers** | Cases whose answer you know in advance. Does the rubric get them right? |
| 2 | **Stability** | The same cases in reverse order. Do the verdicts hold, or does position decide? |
| 3 | **Instrument control** | The same question against a state with the feature *removed*. Does the answer move? |

> [!CAUTION]
> If gate 1 fails, stability is **not computed**. A deterministically wrong answer reproduces
> perfectly, and "100% stable" on it means nothing. This is not hypothetical: 0.006 drift at
> 100% stability with every answer wrong has already happened.

```bash
node scripts/jev-evals.mjs run fixtures/claim-support.json
node scripts/jev-evals.mjs template > fixtures/my-rubric.json    # start from a filled example
```

```
rubric: claim-support, cases: 4, model: jev-1.13.0
gates: accuracy >= 0.9, drift <= 0.2, stability and control when data exists

1. known answers: 4/4 = 100%
2. stability (reverse order): flips 0, max drift 0.000
3. instrument control (feature removed): 1/1

main pass cost: 1461 tokens, $0.000061
RUBRIC PASSED ALL GATES
```

The fixture in this repository **is the rubric behind gate 2** — the gates are gated too.

---

## 📓 Where the decisions go

Every gate appends one line to a JSONL journal: model version, digests of the state and the
questions, the **full distribution**, the thresholds used, and the verdict.

```bash
node scripts/jev-decisions.mjs summary
```

```
decision records: 5
by kind:     {"gateway":2,"evals":1,"gate":2}
by verdict:  {"human":1,"allow":1,"ok":1,"not_done":1,"done":1}
input: 3946 tokens, cost: $0.00019
```

The full distribution matters. **"0.91 against 0.05" and "0.36 against 0.34" are different
news**, and a single winning label cannot tell them apart. The journal is also what makes the
thresholds arguable: with enough records you can derive a threshold from a target accuracy
instead of picking one by feel.

Journals are written next to the scripts, or into `$JEV_GATES_HOME` when set.

---

## 🔌 Works with any harness

The contract a harness has to meet is small: **run a command, read its exit code, optionally
pass JSON on stdin.** That is all.

| Harness | Status | Where the gate runs |
|---|---|---|
| **Claude Code** | ✅ verified against the [hooks reference](https://code.claude.com/docs/en/hooks) | `PreToolUse` for approval, `Stop` for completion, in `.claude/settings.json` |
| **GitHub Actions** | ✅ verified against the [contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts) | ordinary workflow steps; no approval gate in CI |
| **DeepSeek Harness, Codex, AGENTS.md agents** | 📄 contract only | a rule the agent must follow before declaring the task done |
| **git hooks, plain shell** | 📄 contract only | `.git/hooks/pre-push`; non-zero exit aborts the push |
| **Cursor, opencode, Hermes, Aider** | 📄 contract only | wherever the harness can run a command |

**→ [docs/HARNESSES.md](docs/HARNESSES.md)** has the recipes, including the subtlety that
matters: the approval gate's exit `2` means *ask the human*, while a Claude Code hook's exit `2`
means *deny* — so the decision travels as JSON and the process exits `0`.

Minimal pre-push hook:

```sh
#!/bin/sh
node /path/to/jev-gates/scripts/jev-gateway.mjs \
  --action "git push" --external --public --reversible=false || {
  echo "this push needs a human decision first"; exit 1; }
```

> [!IMPORTANT]
> **Fail-open is part of the contract.** Exit `3` and any unexpected exit code mean "not
> confirmed", never "forbidden". A gate that cannot answer must not silently stop a pipeline —
> that failure mode is worse than the one it was built to prevent.

---

## 💸 Cost

The approval gate is **free**: no model, no network. The other two are cheap because Jev is a
small typed-decision model — $0.042 per 1M input tokens, output free.

| Workload | Tokens | Cost |
|---|---:|---:|
| One completion gate over a 3-criterion dossier | 975 | **$0.000041** |
| One rubric fixture (4 cases, two passes plus a control) | 1 461 | **$0.000061** |
| Approval gate | 0 | **$0** |

Measured on the examples in this repository, not estimated.

> [!TIP]
> One review pass of the same material by a frontier chat model costs dollars, not fractions of
> a cent. The point is not only price: a probability plus a threshold in code is **auditable**
> in a way that a paragraph of prose is not.

---

## ⚠️ Honest limits

- **The gates advise; they do not enforce.** Exit codes are only as good as the caller that
  reads them.
- **Gate 2 checks consistency, not truth.** Invented but coherent evidence passes.
- **Gate 1 cannot catch mis-declared flags.** It judges the description, not the action.
- **Narrow judgments only.** These are yes/no questions with written criteria. Ask Jev to
  generate text, reason openly, or do arithmetic and it will answer confidently and wrongly.
- **It drifts between runs.** Run-to-run drift on borderline cases is around ±0.02, so a verdict
  sitting near the threshold should not be taken from a single run. Pin the model version
  (`jev-1.13.0`) rather than `jev-latest` when the result is going into a report.
- **The middle band goes to a human.** With the default thresholds (yes ≥ 0.8, no ≤ 0.2),
  everything between is `review`. That is deliberate: a gate that guesses in the middle is a
  gate that lies.

---

## 🧭 Design rules

The rules behind the shapes used here — why code computes the numbers, why score levels
describe situations instead of degrees, why the primitive has to follow the shape of the
answer, why the threshold belongs in code — are in **[docs/DESIGN.md](docs/DESIGN.md)**, each
one with the failure it prevents.

---

## 🧰 Verify it works

```bash
node --test test/selftest.mjs                                   # 18 checks, offline, no key
node scripts/jev-evals.mjs run fixtures/claim-support.json      # needs a key
```

The offline suite covers the deterministic gate, the evidence collector, the CLI contract
including exit codes, and the fail-open path. It is what CI runs on Node 18, 20 and 22.

---

## 🔗 Related projects

Other work in the same ecosystem, so you can pick the right tool:

- [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) —
  context compaction by scoring tool results with Jev.
- [NiazMorshed2007/jev-review](https://github.com/NiazMorshed2007/jev-review) — continuous code
  review for coding agents, as an MCP plugin.
- [kerpopule/hermes-jev-skills](https://github.com/kerpopule/hermes-jev-skills) — routing,
  memory, compaction and skill selection for Hermes, Claude Code and Codex.
- [typesafe-ai/skills](https://github.com/typesafe-ai/skills) — the official skills for building
  with the System One API.
- [yibie/awesome-jev](https://github.com/yibie/awesome-jev) — a curated index of the ecosystem.

---

<div align="center">

**MIT** — see [LICENSE](LICENSE). Built because a gate is cheaper than a bad push.

<sub>If this saved you a bad push, a ⭐ helps other people find it.</sub>

</div>
