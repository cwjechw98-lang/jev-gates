---
name: jev-progress-review
description: Notice that a run is repeating itself without producing new information, and choose a new experiment or a handoff instead of another attempt. Advisory only — it never kills a process, reverts a change or switches a model. Use when the same failure keeps returning, or when a plan needs re-examining.
whenToUse: The same failure has returned, the same file has been edited repeatedly with no change in results, or a human asks whether the current plan still makes sense.
---

# Progress review — a repeated call is a signal, not a schedule

**Advisory.** This procedure produces a recommendation. It does not kill processes, revert
edits, or change the model as a side effect of a score. Those are decisions, not verdicts.

## What counts as a signal

| signal | why it is a signal |
|---|---|
| the same call signature twice with the same error fingerprint | the method is not converging |
| the same test failing with the same output | the fix is not addressing the cause |
| edits whose diff size is unchanged | activity without progress |
| a new observation absent from the last window | the loop is closed |

**What is NOT a signal:** a diff of the same size. Progressive refactoring, a long build, and
a test suite that reports the same count while the code underneath changes all look like
"no progress" from a distance. Treating diff size as stagnation is how a working run gets
interrupted.

## The procedure

1. **Read the event window** — action signatures, error fingerprints, test results, new
   observations, pending I/O. Normalize before judging: the same command with a different
   temporary path is the same action.
2. **Name the hypothesis that was disproved.** If nothing was disproved, the run is not stuck;
   it is early. Say so and continue.
3. **Choose one of four outcomes:**

   | outcome | when |
   |---|---|
   | `continue` | new information arrived since the last review |
   | `reobserve` | the evidence is stale or incomplete — measure again before deciding |
   | `replan` | a hypothesis was disproved and the current plan depends on it |
   | `handoff` | two identical deterministic failures, or a budget is exhausted |

4. **Write down what the next attempt will change.** An attempt that changes nothing is a
   repeat, and repeats are what this procedure exists to stop.

## Anti-loop rule

The check must not loop on itself. Count your own invocations and cool down between them: a
progress check that runs after every step becomes the thing that is stuck.

## Limits

- This is a judgment about *novelty*, and novelty is not the same as value. A run can produce
  new information that is useless, and repeat a step that is essential.
- It cannot see why a step repeated. Read the transcript before concluding.
- No automatic escalation. A recommendation to change the executor is a recommendation.
