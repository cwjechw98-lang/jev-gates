---
name: jev-review-scope
description: Review a pinned diff or file set against a narrow rubric, with the material handed over in full and every finding tied to evidence. Use when a change needs a second opinion on a stated criterion — naming, error handling, an API contract — and the judgement should be a signal you verify rather than a verdict you paste.
whenToUse: A diff or file set is complete enough to review, the criteria can be written down one per line, and you want a bounded answer instead of an open-ended critique. Also when a previous review produced confident findings you could not trace back to the source.
---

# Review scope — a bounded judgement you can check

`jev_review_scope` answers a narrow question: **does this pinned material meet these stated criteria?**
It is not a code reviewer, not a linter, and not a substitute for running the tests.

## What it does

1. Pins the material — a diff, or the contents of named files — and records its digest.
2. Drops anything outside the declared scope, and says so.
3. Hands the material to the judge **in full**, up to a stated character limit.
4. Returns one finding per rubric criterion, each carrying evidence refs and a quoted fragment.

## The rules that matter

**A truncated review cannot pass.** If required material was dropped or cut off at the
limit, the answer is `unverified`, never `success`. The same holds when the material is
absent or the snapshot no longer matches what was pinned. This is deliberate: a review of
half a diff is not a weaker review, it is a different and wrong one.

**No invented line numbers.** The tool never synthesises a `line` or `lineNumber`. A
finding carries a file path and a quoted fragment, so you can find the spot yourself. If
you need line numbers, get them from the file.

**No autopatches.** It never edits anything and never proposes a diff to apply blindly.

**A finding with no evidence is not a finding.** Every verdict is tied to the material it
came from.

## How to use it

Write the rubric narrow — one thing per criterion, in the words of the requirement, not
"is this good code":

```json
[
  { "id": "errors-named", "text": "every thrown error carries a stable machine-readable code", "required": true },
  { "id": "no-any", "text": "no new use of the any type in exported signatures", "required": true }
]
```

Then pass the files, or the diff, plus the snapshot you pinned at:

```
jev_review_scope {
  taskId, runId,
  rubric: [...],
  files: ["lib/foo.mjs"],
  snapshot: "<the digest you pinned>",
  scope: ["lib/"]
}
```

## What it does NOT do

- It does not run the tests, the type checker or a syntax pass. Those are deterministic
  checks and they belong in the completion gate, not here.
- It does not prove the material is correct. It reports what a judge saw in the text it
  was given.
- It does not know your architecture. A criterion it cannot see in the pinned material is
  a criterion it cannot judge — pin the file that shows it, or leave it out.

## Treat the result as a signal

The judgement is an input to your own reading of the source, not a replacement for it.
Before you report a defect to the user, open the file and confirm the quoted fragment is
really there. A judge that was handed the wrong file will be confidently wrong, and the
quote is what lets you catch that in one step.
