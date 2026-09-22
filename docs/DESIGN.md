# Design rules

Every rule here exists because breaking it produced a specific, observed failure. They are
written for anyone using Jev — or any typed-decision model — as a judge inside a program.
The gates in this repository are one application of them.

---

## 1. Code computes the numbers; the model only judges

Count the files, sum the bytes, compare the exit code, compute the delta. Then hand the model
finished values and ask it to judge them.

**The failure it prevents.** Asked to add up values, a decision model answers confidently and
wrongly. It looks like a broken model; it is a mis-stated task. Arithmetic is not a judgment,
and a judge is not a calculator.

This is also what makes the result auditable: the numbers in the journal came from code, so
they can be recomputed and disputed.

---

## 2. A level describes a situation, not a degree

Write criteria as situations that can be pointed at:

```
true:  "every changed file carries the note read after write: yes"
false: "at least one changed file carries read after write: no"
```

Not as degrees: "high confidence", "mostly done", "partially verified".

**The failure it prevents.** Abstract degree words pull the answer toward the middle of the
scale. The model cannot see your notion of "mostly", so it hedges, and a hedge lands in the
review band or, worse, just above the threshold. Concrete situations are checkable, and
checkable criteria are reproducible.

---

## 3. The primitive follows the shape of the answer

| The answer is | Use | Not |
|---|---|---|
| yes/no with a probability | `noul` | `score` |
| one of a list of options | `choice` | `noul` per option |
| a position on a genuine discrete scale | `score` | `noul` |

**The failure it prevents.** A scale used for a yes/no question invites the model to sit in
the middle, and the middle is where the decision gets handed back to a human for no reason.
Conversely, a forced yes/no on a question that is really "which of these six" throws away the
information you needed.

`choice` is relative: it distributes probability across the options you supplied, so the
answer only means something relative to that list. If you need to know whether *any* option
applies, ask a separate `noul` first.

---

## 4. The threshold lives in code

The model returns a probability. The program compares it against a threshold it owns.

Default: `yes >= 0.8`, `no <= 0.2`, everything between goes to a human. Three outcomes, not
two.

**The failure it prevents.** A threshold embedded in the wording of a question ("answer yes
only if you are very confident") is invisible, untestable, and cannot be tuned against a
measured error cost. In code it can be changed in one place, and the change can be evaluated.

The middle band is not indecision. It is the honest answer for cases the instrument cannot
separate, and routing those to a human is cheaper than being wrong confidently.

---

## 5. Derive the threshold; do not pick it by feel

Choose the accuracy you need, then find the threshold that delivers it on a labelled set.
With the gates here, that set is a fixture; the journal records every verdict, so the data
accumulates on its own.

**The failure it prevents.** A threshold chosen because 0.8 "feels strict" is a guess wearing
a number's clothes. Measured on a real task, moving the threshold changed automation from
62% of cases to 99% correct — the same model, the same rubric, one number in a config.

---

## 6. A missing answer is `unverified`, never `no`

If the judge is unreachable, returns a malformed answer, or was never asked, the result is
`unverified` — an explicit "not confirmed" that a human resolves.

**The failure it prevents.** A silent checker blocked an entire pipeline: no answer was read
as a refusal, and the work stopped with no explanation. "No answer" and "forbidden" are
different facts and must produce different outcomes. Every gate here exits `3` for
unverified, and every integration is told to treat `3` as "not confirmed", never as a block.

---

## 7. Ask only the questions that apply

Build the question set from what is actually present. No changed files means no
`read_after_write` question. No commands means no `reproduced` question. A question asked
against absent evidence produces a confident answer about nothing.

**The failure it prevents.** A gate that asks about artifacts when there are none returns a
plausible number, the number passes the threshold, and the verdict is "confirmed" on an empty
dossier. Absence of evidence must surface as absence, not as a passing grade.

---

## 8. Check the instrument before believing it

Before trusting a new rubric: known answers first, then stability, then a control with the
feature **removed** (and for classification, substituted with something else — a blanked
field is not enough when the names themselves leak the answer).

**The failure it prevents.** Two failures, both observed:

- A rubric that answered "yes" to everything scored 100% stable across runs. Stability is
  meaningless on a deterministically wrong answer, which is why the known-answers gate runs
  first and gates the rest.
- A judge passed a check by reading a field that happened to contain the answer. Removing the
  feature changed nothing, which is exactly what the control is for.

**The instrument starts as a suspect.** In one recorded stretch, an automated judge was wrong
six times on its own while the work it judged was blamed. When a check is red, check the
checker first.

---

## 9. Pin the version, and never take a borderline verdict from one run

Pin an exact model version (`jev-1.13.0`) for anything that goes into a report. Measure
run-to-run drift on your own cases; on borderline ones it is around ±0.02, which is wider
than the gap between two adjacent answers.

**The failure it prevents.** A verdict recorded at 0.79 in one run and 0.81 in the next is a
different decision, and a pipeline that reads only the label will not notice. The journal
stores the distribution for exactly this reason.

---

## 10. Compact by scoring, not by summarizing

When the context has to shrink, score each item for whether it is still needed and drop the
stale ones. Keep what survives verbatim.

**The failure it prevents.** A generated summary silently loses the exact strings that matter
— the path, the flag, the error code — while reading as a fluent account of work that never
happened that way. Scoring is cheap, auditable, and does not rewrite the record.

This is a use of the same instrument outside the gates; the repository next door doing it is
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction).

---

## The short version

```
Numbers come from code.        Judgments come from the model.
Criteria are situations.       Thresholds are code, and they are measured.
Missing is unverified.         Irrelevant questions are not asked.
The instrument is a suspect.   The version is pinned.
```

---

## Boundaries and failure modes (v2)

The rules above say how a gate should decide. This section says what a gate cannot do, so that
nobody reads the exit codes as a guarantee they were never meant to carry.

**The gate checks consistency between evidence and a claim, not truth.** It asks whether the
evidence that code collected supports the claim that was written down. Invent the facts
coherently and the gate will not catch it. This is why the evidence has to come from a
collector that measured a file or a harness that reported how a command ended, rather than from
prose the agent wrote about itself. The structural enforcement is real — a self-report cannot
confirm anything — but structure is not truth.

**Local evidence has `tamperResistance: "none"`, and a process with write access to the same
storage can alter it.** A file can change between the moment the collector hashes it and the
moment the policy reads the fact. An observation file can be edited. Nothing in this repository
detects that, and the value is printed on every report and every JSON payload rather than
omitted, because an absent field would read as a property the gate does not have.

**This is not a security boundary and not a privilege boundary.** The gate runs with the same
privileges as the work it judges. It cannot isolate a process, cannot restrict what an agent may
write, and cannot prove that an observation was produced honestly. It is a consistency check
with an audit trail, and calling it a boundary would invite exactly the trust it cannot repay.
Anything that must be enforced needs a real boundary underneath — a sandbox, a permission
system, a separate machine.

**Untrusted text is wrapped in `<untrusted:label>` tags as a reduction in surface, not as a
proof that prompt injection is impossible.** The claim, the task statement, the criterion
wording, paths, file names and command output all arrive at the judge inside those tags. That
reduces the chance that a line of untrusted text is read as an instruction. It does not remove
the risk, and no structure can, because a model reading a delimiter is still a model reading
text. What actually holds the line is elsewhere: a deterministic criterion is never turned into
a question, so the judge is never asked about a fact code already decided, and a confident "yes"
cannot lift a criterion a check already failed.

**Deterministic facts outrank model opinions, and when the two conflict the deterministic side
wins.** The order is deliberate. `decideCompletion` evaluates the code-computed fact first: a
`fail` is final, and the criterion never becomes a question. A `pass` needs independent trust,
full coverage and freshness; a model probability cannot supply any of those. The only place a
probability is allowed in is a semantic criterion with no deterministic check. When the judge
approves while code found a failure, the verdict is `not_done` and the disagreement is recorded
in the reason codes as `deterministic_conflict_with_claim` — recorded rather than hidden, since
a report that conceals the disagreement is useless for tuning the rubric.

**An unreachable judge yields `unverified`, which is never a silent block.** A missing answer, a
malformed answer, a timeout, an exhausted retry budget and an absent API key all leave their
criterion `unverified` and the run at exit `3`. That is the fail-open rule, and it exists because
the opposite failure has already happened in practice: a checker that could not answer was read
as a refusal, and an entire pipeline stopped with no explanation. "No answer" and "forbidden"
are different facts. Exit `3` means "not confirmed — a human decides", and every integration is
told to treat it that way. The gate never refuses on its own behalf.

**The DSH adapter is advisory on the harness build it targets, and that is a property of the
build, not a choice.** Three limits, each verified against the installed files and each reported
per capability by `adapters/dsh/doctor.mjs`:

- It cannot veto a turn. `Stop` is a bounded steer: the adapter asks for one more step, a fixed
  number of times, then goes quiet and records the run as incomplete. A run that exhausts the
  budget ends as incomplete, not as confirmed.
- It cannot undo a side effect. `PostToolUse` runs after the effect has happened, and the hook
  payload cannot roll it back.
- It cannot see a structured exit code through the hook payload. The payload carries rendered
  text only, so the exit code is inferred from a `[exit code: N]` marker in that text. The
  observation is labelled `coverage: "partial"` with `exitSource: "text_inference"`, and a
  partial observation can never confirm a criterion on its own.

The doctor exists so this is answered per installation rather than promised in a README. On the
build checked in this repository the bridge is not even mounted, and the doctor reports
`degraded`. A gate that is not mounted protects nothing, and saying so is the point.
