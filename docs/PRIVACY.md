# Privacy: what leaves the machine

Two components can open a socket: the completion gate (`scripts/jev-gate.mjs`) and the raw
client (`scripts/jev.mjs`). Both send to `https://api.typesafe.ai/v1/systemone`
(`JUDGE_ENDPOINT` in `lib/judge.mjs`). Nothing else here does network I/O. The approval gate,
the rubric stand's expectation matching, the doctor, the installer and the DSH bridge are all
local.

## What is sent to the judge

The request body is `{ model, state, questions }`. The `model` is `jev-1.13.0` unless
`--model` overrides it.

`state` is built by `buildState` and contains exactly these fields:

| Field | Source | Notes |
|---|---|---|
| `taskId` | The request | |
| `runId` | The request | |
| `mode` | Constant | `completion_check`. |
| `instructions` | Constant | A fixed sentence telling the judge to judge only the criterion given. |
| `untrusted_claim` | `request.claims.claimed` | Wrapped in `<untrusted:claim>` tags. Present only when the field is non-empty. |
| `untrusted_task` | `request.claims.task` | Wrapped in `<untrusted:task>` tags. Present only when the field is non-empty. |
| `untrusted_claim_truncated` / `untrusted_task_truncated` | Derived | `true` when the text was cut. |
| `computed_facts` | The evidence layer | One object per criterion: `criterionId`, `result`, `reasonCode`, `sourceTrust`, `coverage`. |

`questions` is built by `buildQuestions`: one entry per **semantic** criterion that code did
not already settle. Each entry is `{ type: 'noul', text, options: ['yes', 'no'] }`, and the
`text` embeds the criterion wording wrapped in `<untrusted:criterion>` tags.

Untrusted text is truncated at `DEFAULT_MAX_UNTRUSTED_CHARS` (4000) per field, and the
truncation is recorded in the state rather than silently dropped.

## What is withheld

- **Observation bodies.** No file content, no command stdout or stderr, no `argv`, no `cwd`,
  no `executable`, no observation ids. The judge sees `computed_facts`, which carries
  `criterionId`, `result`, `reasonCode`, `sourceTrust` and `coverage` — not paths and not
  digests.
- **Digests.** `sha256`, `stdoutDigest` and `stderrDigest` are computed locally and never sent.
  A `computed_facts` entry reports that a fact passed or failed; it does not report the hash.
- **The claim as a bare field.** `request.claims.claimed` is not copied into `state` under its
  own name. A regression test asserts `state.claimed` is `undefined`, so the claim can never be
  read as a top-level fact.
- **Deterministic criteria.** They are never turned into questions. Code decided them, and a
  probability would be a worse answer. This is a privacy property as well as a design one: a
  criterion with a check does not leave the machine at all.
- **Criteria that already failed a check.** `buildQuestions` skips a semantic criterion whose
  fact is already `fail`.
- **The API key.** It travels in the `Authorization` header and nowhere else.

## `--offline` and `JEV_GATES_OFFLINE`

`--offline` (or `JEV_GATES_OFFLINE=1`) sets the judge status to `unavailable` with the reason
`offline lane: the judge was not contacted`. No request is constructed and no socket is
opened. Semantic criteria then land on `unverified`, which is the honest answer rather than a
block.

Two things `--offline` does **not** do:

- It does not stop `--collect`. The collector still reads and hashes the named files; those
  reads are local.
- It changes nothing when `--answers` is present. The replay branch does not consult the judge
  in either mode, so `--offline --answers` and `--answers` produce the same verdict.

`--answers <file>` is itself an offline lane: recorded answers are validated through the same
`validateAnswers` path as live ones and then fed to the policy. No model call is made.

## The journal

Location: `$JEV_GATES_HOME/jev-decisions.jsonl` when `JEV_GATES_HOME` is set, otherwise
`scripts/jev-decisions.jsonl`. `JEV_GATES_HOME` is created if it does not exist.

Every completion-gate run, every approval-gate run, and every rubric run appends one JSON
line. A completion-gate record carries:

| Field | Content |
|---|---|
| `at` | ISO timestamp. |
| `schemaVersion`, `kind` | `2`, `gate`. |
| `policyVersion` | `2.0.0`. |
| `label`, `runId` | `taskId` and `runId` from the request. |
| `verdict` | The status. |
| `reason`, `reasonCodes` | The reason codes and their details. |
| `thresholds`, `calibrated` | The thresholds used and whether they were declared calibrated. |
| `sourceTrust`, `mode` | The aggregate trust level and the request mode. |
| `basis` | The counted facts: totals, passed, failed, review, unverified, evidence-backed, judged. |
| `stateDigest`, `questionDigest` | Twelve-character SHA-256 prefixes of the state and the questions. |
| `answerSource`, `judgeStatus` | Where the answers came from, and how the judge call ended. |
| `inputTokens`, `costUsd` | Usage, when the judge reported it. |

The digests are prefixes, not the state itself: the journal records a reference to what was
sent, not a copy of it. A gateway record is smaller — action label, verdict, reasons, the
normalized flags, and `costUsd: 0`.

The journal contains no API key, no observation bodies, no file contents, and no untrusted
text. It does contain your `taskId` and `runId`, which are your own labels; treat the file as
you would treat a build log.

`lib/journal.mjs` reads the same file. A corrupt line is counted and reported with its line
number and the reason `invalid_json`, and the journal is marked `complete: false` — a partial
journal is never presented as the whole audit trail.

## Where credentials are looked up

`lib/credentials.mjs` resolves the key in this order:

1. The `TYPESAFE_API_KEY` environment variable.
2. `$JEV_GATES_HOME/key` — a file holding nothing but the key.
3. `~/.dsh/.credentials.yaml` — a YAML mapping, matched by the key name `TYPESAFE_API_KEY`.
4. `~/.config/jev-gates/key` — a plain key file.

A plain key file must contain exactly one meaningful line; a second line means the file is not
a key file and it is refused as `plain_file_not_single_line`. A YAML file without the requested
key is refused as `yaml_key_missing` and **never** falls back to the whole file. Every candidate
value is checked before use: printable ASCII only, no whitespace or newlines, between 8 and 4096
characters. A failure returns a reason code and a file path, never file contents.

`scripts/jev.mjs` has its own resolver with the same locations but a weaker parser, kept for
backward compatibility. `lib/credentials.mjs` is the one the gate uses.

## The API key is never logged

This is a statement about the code, and it holds in four places:

- `resolveApiKey` returns the value in a `value` field and never includes it in a failure. A
  failed resolution reports `code`, `source` and `attempts`, each of which carries a source name
  and a reason code only.
- The key is passed straight into the `Authorization` header by `askJudge`. It is not assigned
  to a variable that reaches any record.
- No `logDecision` call in this repository has a key field. The journal record fields are
  enumerated above.
- The transport never logs. It classifies a response by status code and returns a code from
  `TRANSPORT_CODE`; a response body is not echoed into a message.

If a key does appear in a log, that is a defect, not a configuration choice.

## What is not a privacy boundary

The evidence model has `tamperResistance: "none"` and the gate is not a security boundary. See
`docs/DESIGN.md`, section "Boundaries and failure modes (v2)", for what that means. This file
describes what the code sends; it does not claim the code can prevent anything.
