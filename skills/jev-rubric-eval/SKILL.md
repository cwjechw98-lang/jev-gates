---
name: jev-rubric-eval
description: Check a rubric before trusting it — known answers first, then stability under reordering, then an instrument control with the feature removed. Use when a new or changed rubric starts making decisions, or when a verdict feels too confident to be true.
whenToUse: A rubric, classifier or judge is about to be relied on. Also when its answers look plausible but nobody has checked whether it can be wrong.
---

# Rubric stand — the instrument starts as a suspect

A rubric is an instrument. Instruments are wrong before they are right, and the expensive
failure is the one that looks fine.

```bash
node scripts/jev-evals.mjs run fixtures/claim-support.json
node scripts/jev-evals.mjs template > fixtures/my-rubric.json   # start from a filled example
```

## The three gates, in this order

| # | gate | question |
|---|---|---|
| 1 | **known answers** | Cases whose answer is known in advance. Does the rubric get them right? |
| 2 | **stability** | The same cases in reverse order. Do the verdicts hold, or does position decide? |
| 3 | **instrument control** | The same question against a state where the feature was **removed**. Did the answer move? |

**If gate 1 fails, stability is not computed.** A deterministically wrong answer reproduces
perfectly, and "100% stability" on it means nothing. This is not hypothetical: a drift of
0.006 at 100% stability with every answer wrong has already been observed.

| exit | meaning |
|---|---|
| 0 | the rubric passed every gate |
| 1 | it failed — do not use it for decisions yet |

## Building a fixture

```json
{
  "name": "claim-support",
  "target_accuracy": 0.9,
  "max_drift": 0.2,
  "cases": [
    { "id": "c1", "state": { "…": "…" }, "expect": { "q1": { "at_least": 0.8 } } },
    { "id": "c2", "state": { "…": "…" }, "expect": { "q1": { "at_most": 0.2 } } },
    { "id": "c3", "control": { "removed": "feature", "state": { "…": "…" } }, "expect": { "q1": { "at_most": 0.2 } } }
  ]
}
```

A `control` case is the one that catches a rubric reading a feature it should not. Without
one, gate 3 cannot run and the report says so.

## Limits

- Fixtures are small by nature. A rubric that passes four cases has survived four cases.
- The stand measures the rubric, not the task. A rubric can be stable, accurate on known
  answers and still useless for the decision you actually care about.
- Do not tune labels and thresholds against the final test set. Tune on a development set and
  keep the test set for the report.
