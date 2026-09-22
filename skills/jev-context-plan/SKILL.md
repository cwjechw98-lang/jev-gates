---
name: jev-context-plan
description: Plan what can be dropped from a long history without losing the goal, the constraints, live authorisations, unresolved errors or critical evidence. Use when a session has grown long, a context window is filling, or a handoff needs a smaller history that still carries everything that matters.
whenToUse: The history is long enough to be expensive or to risk the window, and something must be dropped. Also before a handoff, when the next agent needs the state but not the whole transcript.
---

# Context plan — drop what is spent, keep what is load-bearing

`jev_context_plan` returns a **candidate** reduced history plus a restore map, and leaves
the original untouched. It decides what may be dropped and, more importantly, what may not.

## What is never dropped

These are pinned by kind, not by position or recency:

- **The goal** — what the user actually asked for, in their words.
- **Constraints and prohibitions** — "do not push", "never touch the active profile",
  "no paid API". These are cheap to keep and catastrophic to lose.
- **Live authorisations** — a permission that is still in force. Dropping it silently
  changes what the agent may do.
- **Unresolved errors** — an error with no matching resolution. It is still true.
- **Critical evidence** — the artifact a completion claim rests on.
- **The most recent turns** — the immediate thread of the conversation.

## What is usually safe to drop

Superseded file reads, resolved errors, the middle of a long tool output, restatements of
a decision already recorded, and completed work whose evidence has been pinned elsewhere.

## The honest limits

**This is a preview, not compaction.** The tool does not wire a candidate into a live
request pipeline. DSH's interface for substituting a context at request time is not
established by this work, so nothing here silently rewrites what the model receives. You
get a candidate, a restore map and a token estimate; applying it is your decision and your
action.

**Token counts are estimates**, computed from characters. They are good enough to compare
two candidate histories and not good enough to quote as a measurement.

**A restore map is part of the answer.** Every dropped block keeps its id, its kind and
where it was, so the drop is reversible. A reduction you cannot reverse is a deletion.

## How to use it

```
jev_context_plan {
  taskId, runId,
  messages: [...],          // the history in order
  budgetTokens: 40000,      // optional target
  keepIds: ["..."]          // anything you know must survive
}
```

Read `decision.candidate` for the reduced history and `decision.restoreMap` for what moved
where. Compare `decision.estimatedTokens` before and after.

If the answer comes back `unverified` because the pinned facts alone exceed the budget, the
budget is the thing to raise — not the pinned set. Facts that cannot be dropped are the
floor of any reduction, and a plan that drops them to fit is not a plan, it is data loss.

## When not to use it

If the history fits comfortably, leave it alone. Reduction costs a step and introduces a
chance to lose something subtle; do it because the window demands it, not because it looks
tidy.
