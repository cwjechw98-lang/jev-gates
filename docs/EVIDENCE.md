# The evidence model

The evidence layer turns one criterion plus a set of observations into one fact: `pass`,
`fail`, `unknown` or `not_applicable`. It asks no model anything, and it never treats the
absence of a record as a value.

The completion gate then turns facts into a status. This file describes the first half. For
what the statuses mean see `docs/MIGRATION.md`; for the flags that produce observations see
`docs/CLI.md`.

## What counts as independent evidence

An observation is independent when a component other than the claimant produced it. The trust
level is assigned by the collection path, never chosen by the caller — `sourceTrust` is
validated against a fixed set, and a request cannot promote itself.

| `sourceTrust` | Produced by | Can confirm a criterion in completion mode |
|---|---|---|
| `self_reported` | The legacy v1 adapter, and nothing else | No |
| `collector_observed` | `collectArtifact` in `lib/collector.mjs` | Yes |
| `harness_observed` | `observationsFromEvents`, from normalized harness events | Yes |

`INDEPENDENT_TRUST` is `['collector_observed', 'harness_observed']`. A `pass` on anything else
becomes `unverified` with reason code `self_reported_only`. This is the rule that makes a v1
claims file unable to say `done`.

The collector is the only component allowed to state facts about the filesystem. It never runs
a command: re-running a command named in a claim would be a side effect performed by a
verifier. It reports what it measured, including that it could not measure something.

## How the reported trust level is computed

The decision reports one `sourceTrust`. It is not a maximum and not an average: it is the
**weakest** level among the criteria that passed *and* carried a trust level.

```
sourceTrust = the lowest rank among rows where decision === 'pass' && sourceTrust is set
ranks: self_reported 0, collector_observed 1, harness_observed 2
```

Only evidence-backed passing rows count. A semantic criterion that the judge approved has no
observation behind it, so it is excluded — letting it count as `self_reported` would understate
evidence that really was observed by the harness. With no such rows, the reported level is
`null`.

`aggregateTrust` in `lib/evidence.mjs` implements the same rule over facts and returns
`self_reported` for an empty set; the policy returns `null` instead, and the two are separate
functions for that reason.

## Coverage levels

| Level | Meaning |
|---|---|
| `full` | The measurement covers the whole object. |
| `partial` | The measurement covers part of it. |
| `unknown` | Coverage was not established. |

Coverage belongs to every observation kind: a command whose output was truncated is partial
evidence exactly like a half-read file. The evidence layer reports coverage and does not act on
it — it is the policy that refuses to confirm a `pass` with `partial` or `unknown` coverage
(`evidence_partial_coverage`). The split is deliberate: the evidence layer says what it saw,
the policy decides whether that is enough.

## Scope resolution, and why both sides are resolved against `projectRoot`

A criterion may declare `verificationScope`. Evidence outside that scope does not confirm the
criterion: the fact becomes `unknown` with reason code `evidence_scope_mismatch`.

The comparison resolves **both** the observation path and every scope entry against
`projectRoot` before comparing them. A scope written as `reports/out.md` and an observation
written as `C:/work/project/reports/out.md` describe the same file, and a comparison that
resolved only one side would call them different — or, worse, would call an absolute path
inside the scope a mismatch and hide a real pass.

Path handling has three properties that are load-bearing:

- **Lexical normalization.** `.` and `..` are resolved without touching the disk. Without it,
  `src/../../etc/passwd` starts with the string `src/` and passes a naive prefix check.
- **Boundary matching.** A prefix match is only accepted on a path boundary, so `src/a.ts` does
  not match `src/a.tsx`. A sibling file is not in scope.
- **Case folding on Windows.** `normalizePath` lowercases when `process.platform === 'win32'`,
  so `C:\Project\SRC\a.ts` and `c:/project/src` compare equal.

The scope also acts as a locator: when a criterion has no usable `evidenceRefs`, the scope
entries are tried as artifact paths. Nothing is guessed beyond that. No reference and no scope
means the evidence layer says it has nothing to look at (`no_observation`).

When several observations describe the same artifact, the latest one wins: sorted by
`sequence` descending, then by `capturedAt` descending. A later successful write supersedes an
earlier absence.

## Staleness

`capturedAt` is compared against `now` and an optional `maxAgeMs`. The flag that sets it is
`--max-age <seconds>`, and the default is no window at all.

`fresh` is `null` when there is no window or no parseable timestamp, `true` inside the window
and `false` outside it. A **stale observation cannot confirm a pass**: the fact becomes
`unknown` with reason code `evidence_stale`. Staleness is only applied to a pass. A failure
recorded an hour ago is still a failure; there is no reason to launder it into an unknown.

## Instability

The collector reads an artifact **twice** and compares the digests and sizes. A file that
changed between the two reads is marked `unstable: true` with `coverage: 'partial'`, and the
later reading is the one reported.

The evidence layer refuses to confirm anything from an unstable observation: the fact becomes
`unknown` with reason code `observation_unstable`. A second read that throws marks the
observation unstable too, because the artifact moved under the collector.

This is the cheapest available answer to a real race: the gate hashes a file that a running
agent may still be writing.

## `tamperResistance: "none"`

Local evidence has no tamper resistance. A process with write access to the same storage can
alter an artifact between the moment it is measured and the moment it is judged, and nothing
in this repository can detect that.

The value is stated rather than hidden, and it is stated in three places: it is a comment at
the top of `lib/evidence.mjs`, it is printed in the last line of every human report, and it is
a field on every `--json` payload. A gate that reported a reassuring absence of that field
would be claiming a property it does not have.

The design consequence: the facts must come from the collector rather than from prose, and the
gate checks consistency, not truth. See `docs/DESIGN.md`, section "Boundaries and failure
modes (v2)".

## The check types

`CHECK_TYPES` is a closed list of five. A check with any other `type` is `unknown_enum` at
validation time, and a criterion whose check is missing or untyped resolves to `unknown` with
`unsupported_check_type` — the evidence layer does not guess.

| Type | Decides | Can prove | Cannot prove |
|---|---|---|---|
| `artifact_exists` | `existence` is `true` → pass, `false` → fail | The path resolved to something, or did not resolve | That the content is correct, complete, or the right version |
| `artifact_nonempty` | `existence` and `bytes` | The object exists and has at least one byte | Anything about the content. A single newline passes |
| `artifact_digest` | `sha256` equals `check.digest` | The measured bytes are the bytes whose digest was declared | That those bytes are correct work. A recorded digest can be recorded from anything |
| `command_exit` | The recorded `exit` equals `expectExit` | That a command with this exit code was reported by a collector or a harness | That the command tested what the criterion says. The observation is not re-executed |
| `read_after_write` | The observation carries `readAfterWrite === true` | That the harness reported a read after a write | Anything, when the harness does not report provenance |

Detail per type:

- **`artifact_exists`.** `existence: null` is unknown, never true — the fact is `unknown` with
  `existence_unknown`. A failed stat with a code other than `ENOENT`/`ENOTDIR` is also
  `existence: null`, because "could not look" is not "not there".
- **`artifact_nonempty`.** An absent file fails (`artifact_missing`). A present file whose size
  was not measured is `unknown` with `existence_unknown` and the detail "size was not measured",
  not a pass.
- **`artifact_digest`.** Comparison is case-insensitive on hex. A missing digest on the
  observation is `unknown`, not a mismatch. A wrong-shape digest in the criterion is rejected
  at validation time as `bad_value`, so a malformed string never becomes a comparison.
- **`command_exit`.** The expected value is `check.expectExit` when it is an integer, otherwise
  the observation's own `expectedExit`, otherwise `0`. A command whose status is not
  `completed` did not succeed: when the expectation is `0` the fact is `fail`
  (`command_did_not_complete`); when a non-zero exit was expected, the outcome is simply
  `unknown`. A completed command with no integer exit is `unknown`, never a zero. An expected
  non-zero exit is a legitimate pass — a negative test that fails as designed is a pass.
- **`read_after_write`.** Provenance lives in the event stream. The collector opening a file to
  hash it is **not** read-after-write provenance, and the two are never substituted. Without an
  observation carrying `readAfterWrite`, the fact is `unknown` with
  `event_provenance_unavailable`. An adapter that cannot report reads must not be read as
  "it read".

## Reason codes from the evidence layer

`EVIDENCE_REASON` in `lib/evidence.mjs`:

| Code | Produced when |
|---|---|
| `artifact_exists` | An existence check passed. |
| `artifact_missing` | An existence check found the object absent, or a non-empty check found it absent. |
| `artifact_empty` | A non-empty check measured zero bytes. |
| `digest_matches` | The recorded digest equals the expected one. |
| `digest_mismatch` | The recorded digest differs from the expected one. |
| `command_exit_matched` | The recorded exit equals the expected exit. |
| `command_exit_mismatched` | The recorded exit differs from the expected exit. |
| `command_did_not_complete` | The status is not `completed`, or no integer exit was recorded. |
| `no_observation` | No observation matched the reference or the scope. |
| `existence_unknown` | Existence was `null`, or a size or digest needed by the check was not measured. |
| `evidence_scope_mismatch` | The observation is outside the criterion's verification scope. |
| `evidence_stale` | A would-be pass was outside the staleness window. |
| `observation_unstable` | The artifact changed between two reads. |
| `evidence_partial_coverage` | Declared in `EVIDENCE_REASON` but not produced by this module: coverage travels on the fact as `partial` or `unknown`, and the policy is what turns it into `unverified` under its own `evidence_partial_coverage` code. |
| `event_provenance_unavailable` | A `read_after_write` check had no provenance to read. |
| `unsupported_check_type` | The check is missing, untyped, or not in `CHECK_TYPES`. |

The evidence layer decides `pass`, `fail` and `unknown`. It never decides `unverified` — that
word belongs to the policy, which is the layer that knows what a status costs.
