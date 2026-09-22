#!/usr/bin/env node
/**
 * Completion gate (REQ-02, REQ-03).
 *
 * "Done" is confirmed by evidence, not by the agent's word. The order is fixed:
 *   do the work -> READ THE TARGET -> collect evidence -> judge.
 * Judging a success message without reading the target adds one more opinion.
 *
 * What changed in v2, and why it matters more than any new flag:
 *   - code decides first, and a factual failure is final: a confident "yes" from
 *     the judge can no longer lift a criterion that a check already failed;
 *   - a missing exit code, a missing observation and an unknown existence are
 *     "unknown", never a pass and never a zero;
 *   - an empty list of checks is UNVERIFIED, not a completion;
 *   - a v1 claims file is accepted but downgraded to self-reported evidence, so
 *     it can no longer produce a confirmation on its own.
 *
 * HONEST LIMIT: the gate checks whether the evidence is CONSISTENT with the
 * claim, not whether it is TRUE, and local evidence can be altered by a process
 * with the same write access. That is why the facts come from the collector and
 * not from prose, and why `tamperResistance` is reported as `none`.
 *
 * CLI:
 *   node scripts/jev-gate.mjs --request request.json
 *   node scripts/jev-gate.mjs --request request.json --collect reports/out.md
 *   node scripts/jev-gate.mjs --request request.json --offline
 *   node scripts/jev-gate.mjs --request request.json --answers recorded.json
 *   node scripts/jev-gate.mjs --claims claims.json --dry
 *
 * Exit code: 0 confirmed, 1 not done, 2 human review, 3 unverified.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { markInlineOrigin, parseAndValidate } from '../lib/contracts.mjs';
import { resolveCriteria } from '../lib/evidence.mjs';
import { collectArtifact } from '../lib/collector.mjs';
import { askJudge, buildQuestions, buildState, JUDGE_STATUS } from '../lib/judge.mjs';
import { decideCompletion, ENFORCEMENT, normalizeThresholds, POLICY_VERSION, REASON, STATUS_EXIT, STATUS_MEANING, STATUS } from '../lib/policy.mjs';
import { validateAnswers } from '../lib/answers.mjs';
import { decisionsPath, digest, logDecision, THRESHOLDS } from './jev-decisions.mjs';

const USAGE = `jev-gate — the completion gate

  node scripts/jev-gate.mjs --request <file|-> [options]
  node scripts/jev-gate.mjs --claims  <file|-> [options]     a v1 file: always unverified

Input
  --request <path>   a schemaVersion 2 request (use - to read stdin)
  --claims  <path>   a v1 claims file; self-reported, so it cannot reach "done"
  --answers <path>   recorded judge answers, so no call is made
  --collect <path>   read an artifact and record size, digest and stability
--with-excerpt     also capture the head of each --collect artifact, as material
                   for semantic criteria (bounded, wrapped as untrusted)
                     (repeatable, or comma-separated). Never runs a command.
  --root <path>      projectRoot override, used to resolve evidence scope

Judging
  --offline          never contact the judge (also: JEV_GATES_OFFLINE=1)
  --model <id>       judge model override
  --yes <n> --no <n> thresholds (default 0.8 / 0.2)
  --calibrated       assert the thresholds were calibrated on this task
  --max-age <sec>    how old an observation may be before it counts as stale

Output
  --json             the machine contract on stdout
  --dry              print the state, the questions and the computed facts only
  --no-journal       do not append this decision to the journal
  --help             this text

Exit codes
  0 done   1 not_done   2 review   3 unverified
  An unreachable judge yields 3, never a silent block.`;

export { buildState, buildQuestions };

const WORD = { done: 'CONFIRMED', not_done: 'NOT DONE', review: 'HUMAN REVIEW', unverified: 'UNVERIFIED' };

/** Read JSON from a file or stdin. Returns a clean failure instead of a stack. */
export function readJson(path) {
  try {
    return { ok: true, text: path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8') };
  } catch (error) {
    return { ok: false, error: `cannot read request from ${path === '-' ? 'stdin' : path}: ${error.message}` };
  }
}

/**
 * Run the whole decision pipeline without touching the CLI.
 *
 * Exported so the offline tests can drive the real pipeline — collector,
 * evidence, policy — with an injected judge instead of a network.
 */
export async function runGate({
  request,
  observations = [],
  answers = null,
  answerSource = 'judge',
  thresholds = THRESHOLDS,
  projectRoot = null,
  now = Date.now(),
  maxAgeMs = null,
  model = null,
  judge = null,
  judgeStatus = null,
  judgeReason = null,
  enforcement = ENFORCEMENT.advisory,
  dryRun = false,
} = {}) {
  // Observations come from three places and describe one run: whatever the
  // request carried inline, whatever the collector just read, and whatever the
  // caller passed. Later entries win, so a fresh reading replaces a stale one.
  //
  // Inline observations were already downgraded to `self_reported` by the schema:
  // the request body is the claimant speaking, and it cannot confer its own
  // provenance. The out-of-band `observations` argument keeps what it declares,
  // because there the value was produced by the code that did the measuring.
  const merged = new Map();
  for (const obs of request.observations ?? []) {
    const inline = markInlineOrigin(obs);
    merged.set(inline.observationId, inline);
  }
  for (const obs of observations) merged.set(obs.observationId, obs);
  const collected = [...merged.values()];

  const facts = resolveCriteria(request.criteria ?? [], collected, {
    projectRoot: projectRoot ?? request.projectRoot,
    now,
    maxAgeMs,
    // Evidence gathered for another task or run is not evidence for this one.
    binding: { taskId: request.taskId ?? null, runId: request.runId ?? null },
  });

  const questions = buildQuestions(request.criteria ?? [], facts);
  const state = buildState(request, facts);
  const semanticCount = Object.keys(questions).length;

  // Short-circuit. A required criterion that code has already failed cannot be
  // rescued by a model opinion, so asking is pointless — and asking anyway spends
  // money and sends the state to a third party for a verdict that is already
  // determined. INV-01: a factual failure is never `done`.
  const hardFailure = facts.some((f) => f.result === 'fail' && (request.criteria ?? []).find((c) => c.id === f.criterionId)?.required !== false);

  let judgeResult;
  if (answers !== null) {
    // Replay lane: recorded answers, validated exactly like live ones.
    judgeResult = { status: JUDGE_STATUS.ok, answers, errors: [], usage: null, reason: null };
  } else if (dryRun) {
    // `--dry` builds and prints the request. It must not resolve credentials,
    // contact the transport, or write a journal entry.
    judgeResult = { status: JUDGE_STATUS.notRequested, answers: {}, errors: [], usage: null, reason: 'dry run: the judge was not consulted' };
  } else if (hardFailure) {
    judgeResult = { status: JUDGE_STATUS.notRequested, answers: {}, errors: [], usage: null, reason: 'a required criterion already failed; the model lane would change nothing' };
  } else if (semanticCount === 0) {
    judgeResult = { status: JUDGE_STATUS.notRequested, answers: {}, errors: [], usage: null, reason: 'no semantic criteria' };
  } else if (judgeStatus) {
    judgeResult = { status: judgeStatus, answers: {}, errors: [], usage: null, reason: judgeReason };
  } else if (judge) {
    judgeResult = await judge({ state, questions });
  } else {
    judgeResult = await askJudge({ state, questions, model: model ?? undefined });
  }

  const validation = validateAnswers(judgeResult.answers ?? {}, questions);
  const decision = decideCompletion({
    request,
    criterionFacts: facts,
    answers: validation.flat,
    // The raw answers are kept as well: an answer to a criterion that has no
    // material never becomes a question, and its opinion would otherwise be
    // dropped from the report by answer validation.
    rawAnswers: judgeResult.answers ?? {},
    observations: collected,
    answerErrors: validation.errors,
    thresholds,
    judgeStatus: judgeResult.status,
    judgeReason: judgeResult.reason,
    enforcement,
  });

  return {
    decision,
    facts,
    questions,
    state,
    validation,
    judge: judgeResult,
    answerSource,
    meta: {
      policyVersion: POLICY_VERSION,
      stateDigest: digest(state),
      questionDigest: digest(JSON.stringify(questions)),
      semanticQuestions: semanticCount,
      usage: judgeResult.usage ?? null,
      attempts: judgeResult.attempts ?? 0,
    },
  };
}

/** Collect artifacts named on the command line. Local reads only, never commands. */
async function collectPaths(paths, { request, sequenceStart = 0, withExcerpt = false }) {
  const observations = [];
  let sequence = sequenceStart;
  for (const path of paths) {
    sequence += 1;
    observations.push(
      await collectArtifact({
        path,
        projectRoot: request.projectRoot ?? null,
        runId: request.runId,
        taskId: request.taskId,
        sequence,
        // Only when asked for: an excerpt is the material a semantic criterion is
        // judged against, and a run with no semantic criterion does not need it.
        withExcerpt,
      }),
    );
  }
  return observations;
}

// --- CLI ---------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i > -1 ? (argv[i + 1]?.startsWith('--') ? true : argv[i + 1] ?? true) : undefined;
  };
  const allFlags = (n) => {
    const out = [];
    argv.forEach((a, i) => {
      if (a === `--${n}` && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]);
    });
    return out;
  };

  const path = flag('request') ?? flag('claims');
  const asJson = flag('json') === true;
  const noJournal = flag('no-journal') === true;
  const offline = flag('offline') === true || process.env.JEV_GATES_OFFLINE === '1';
  const thresholdInput = normalizeThresholds({
    no: flag('no') !== undefined ? Number(flag('no')) : undefined,
    yes: flag('yes') !== undefined ? Number(flag('yes')) : undefined,
    calibrated: flag('calibrated') === true,
  });

  if (flag('help') === true || argv.includes('-h')) {
    console.log(USAGE);
    process.exitCode = 0;
  } else if (!path) {
    console.log('need --request <file|-> (or --claims <file|-> for a v1 file)');
    console.log('run with --help for the full surface.');
    console.log('a v2 request needs schemaVersion, taskId, runId and criteria; see docs/CLI.md');
    process.exitCode = STATUS_EXIT.unverified;
  } else if (!thresholdInput.ok) {
    console.log(`invalid thresholds: ${thresholdInput.detail}`);
    process.exitCode = STATUS_EXIT.unverified;
  } else {
    const loaded = readJson(path);
    if (!loaded.ok) {
      console.log(loaded.error);
      process.exitCode = STATUS_EXIT.unverified;
    } else {
      const parsed = parseAndValidate(loaded.text);
      if (!parsed.ok) {
        // A schema failure is unverified, not a prohibition, and the path is
        // reported without echoing any field content.
        console.log(`the request does not satisfy the schema (stage: ${parsed.stage})`);
        for (const e of parsed.errors.slice(0, 12)) console.log(`  ${e.path}: ${e.code} - ${e.detail}`);
        process.exitCode = STATUS_EXIT.unverified;
      } else {
        const request = parsed.value;
        if (request.legacy) {
          // v1 claims are self-reported by definition: no confirmation is
          // possible, so the judge is not even consulted.
          const decision = decideCompletion({
            request,
            criterionFacts: (request.criteria ?? []).map((c) => ({
              criterionId: c.id,
              result: 'unknown',
              reasonCode: REASON.legacyUntrusted,
              refs: [],
              sourceTrust: 'self_reported',
              coverage: 'unknown',
              fresh: null,
            })),
            thresholds: thresholdInput.value,
          });
          decision.reasonCodes.unshift({ code: REASON.legacyUntrusted, detail: 'a v1 claims file carries self-reported evidence only' });
          report({ decision, meta: { policyVersion: POLICY_VERSION, stateDigest: null, questionDigest: null, semanticQuestions: 0 }, validation: { errors: [] }, judge: { status: JUDGE_STATUS.notRequested } }, { asJson, dry: flag('dry') === true, legacy: true });
        } else {
          const collectTargets = allFlags('collect').flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
          const answersPath = flag('answers');
          let answers = null;
          let answerSource = 'judge';
          let answersError = null;
          if (typeof answersPath === 'string') {
            const answersFile = readJson(answersPath);
            if (!answersFile.ok) answersError = answersFile.error;
            else {
              try {
                answers = JSON.parse(answersFile.text);
                answerSource = 'replay';
              } catch (error) {
                answersError = `cannot parse answers: ${error.message}`;
              }
            }
          }

          if (answersError) {
            console.log(answersError);
            process.exitCode = STATUS_EXIT.unverified;
          } else {
            // `--max-age` is in SECONDS; the policy works in milliseconds. The
            // help text said milliseconds while this line multiplied by 1000, so
            // a reader who trusted the help got a gate that was off by 1000x.
            const maxAgeFlag = flag('max-age');
            let maxAgeMs = null;
            let maxAgeError = null;
            if (maxAgeFlag !== undefined) {
              const seconds = Number(maxAgeFlag);
              if (!Number.isFinite(seconds) || seconds <= 0) {
                maxAgeError = `--max-age expects a positive number of seconds, got ${JSON.stringify(maxAgeFlag)}`;
              } else {
                maxAgeMs = seconds * 1000;
              }
            }

            if (maxAgeError) {
              console.log(maxAgeError);
              process.exitCode = STATUS_EXIT.unverified;
            } else {
              const dry = flag('dry') === true;
              const collected = await collectPaths(collectTargets, {
                request,
                withExcerpt: flag('with-excerpt') === true,
              });
              const observations = [...(request.observations ?? []), ...collected];
              const judgeMode = dry
                // `--dry` builds and prints the request. It must not resolve
                // credentials, contact the transport, or write a journal entry.
                ? { dryRun: true }
                : offline
                  ? { judgeStatus: JUDGE_STATUS.unavailable, judgeReason: 'offline lane: the judge was not contacted' }
                  : {};
              const result = await runGate({
                request,
                observations,
                answers,
                answerSource,
                thresholds: thresholdInput.value,
                projectRoot: flag('root') ?? request.projectRoot ?? null,
                maxAgeMs,
                model: typeof flag('model') === 'string' ? flag('model') : null,
                ...judgeMode,
              });
              report(result, { asJson, dry, legacy: false, journal: noJournal !== true });
            }
          }
        }
      }
    }
  }
}

/** Print the result and set the exit code. Machine output stays on stdout. */
function report(result, { asJson, dry, legacy, journal = true }) {
  const { decision, meta, validation, judge, facts, questions, state } = result;

  if (dry) {
    console.log('-- STATE --');
    console.log(state ?? '(a v1 file has no computed state)');
    console.log('\n-- QUESTIONS --');
    console.log(JSON.stringify(questions ?? {}, null, 2));
    console.log('\n-- COMPUTED FACTS --');
    console.log(JSON.stringify(facts ?? [], null, 2));
    console.log(`\ncomputed by code: ${JSON.stringify(decision.basis)}`);
    process.exitCode = 0;
    return;
  }

  // One entry per decision, in one file. `rows` and `questions` are stored so a
  // later replay can re-decide and re-ask from the record alone: a journal that
  // cannot be replayed is a log, not an audit trail.
  let journalNote = null;
  if (journal) {
    try {
      logDecision({
        schemaVersion: 2,
        kind: 'gate',
        id: `${decision.taskId ?? 'unnamed'}-${Date.now().toString(36)}`,
        policyVersion: meta?.policyVersion ?? POLICY_VERSION,
        label: decision.taskId ?? 'unnamed',
        runId: decision.runId ?? null,
        verdict: decision.status,
        status: decision.status,
        exitCode: decision.exitCode,
        reason: decision.reasonCodes.map((r) => r.code).join(', ') || 'none',
        reasonCodes: decision.reasonCodes,
        thresholds: decision.thresholds,
        calibrated: decision.calibrated,
        sourceTrust: decision.sourceTrust,
        mode: decision.mode,
        basis: decision.basis,
        stateDigest: meta?.stateDigest ?? null,
        questionDigest: meta?.questionDigest ?? null,
        answerSource: result.answerSource ?? null,
        judgeStatus: judge?.status ?? null,
        inputTokens: meta?.usage?.input_tokens ?? meta?.usage?.inputTokens ?? 0,
        costUsd: 0,
        // The replayable payload: without these two a replay can only report
        // "partial", and a partial replay cannot re-ask anything.
        rows: decision.rows ?? null,
        questions: questions ?? null,
        answers: validation?.flat ?? null,
      });
      journalNote = decisionsPath();
    } catch (error) {
      // The verdict is the product; the record is the trail. A trail that cannot
      // be written is reported, never silently swallowed, and never fatal.
      journalNote = `NOT WRITTEN: ${error.message}`;
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ ...decision, judgeStatus: judge?.status ?? null, tamperResistance: 'none' }, null, 2));
    process.exitCode = decision.exitCode;
    return;
  }

  const nothingToCheck = decision.reasonCodes.some((r) => r.code === REASON.noVerifiableCriteria);
  if (nothingToCheck) {
    console.log('NOTHING TO CHECK: no applicable criteria carry evidence.');
    console.log('This is not "done" — it is the absence of evidence.');
  }

  console.log(`VERDICT: ${WORD[decision.status]}`);
  // One line per distinct reason code: three criteria failing the same way is
  // one fact about the evidence, not three.
  const byCode = new Map();
  for (const r of decision.reasonCodes) if (!byCode.has(r.code)) byCode.set(r.code, r.detail);
  const reasonLine = [...byCode.values()].slice(0, 4).join('; ');
  console.log(`reason: ${reasonLine || STATUS_MEANING[decision.status]}`);
  console.log(`reason codes: ${[...byCode.keys()].join(', ') || 'none'}`);
  console.log(`evidence: ${JSON.stringify(decision.basis)}`);
  console.log(`source trust: ${decision.sourceTrust}; calibrated: ${decision.calibrated}; mode: ${decision.mode}`);

  if (decision.rows?.length) {
    console.log('');
    for (const row of decision.rows) {
      const model = row.modelProbability === null ? '   -  ' : row.modelProbability.toFixed(2).padStart(6);
      console.log(`  ${row.criterionId.padEnd(22)} ${String(row.deterministicResult).padEnd(14)} ${model}   ${row.decision}`);
    }
  }

  if (validation?.errors?.length) {
    console.log('');
    console.log('answers rejected by validation:');
    for (const e of validation.errors) console.log(`  ${e.id}: ${e.code}`);
  }

  console.log('');
  if (legacy) {
    console.log('a v1 claims file is self-reported evidence: it cannot confirm anything on its own.');
  } else {
    console.log(`judge: ${judge?.status ?? 'not consulted'}${judge?.reason ? ` (${judge.reason})` : ''}`);
  }
  if (decision.status === STATUS.unverified) {
    console.log('this is NOT "done" and NOT "forbidden": nothing is confirmed, a human decides.');
  }
  console.log('limit: this gate checks that the evidence is consistent, not that it is true.');
  console.log('limit: local evidence has tamperResistance "none" — it can be altered by a process with the same write access.');
  if (journalNote && journalNote.startsWith('NOT WRITTEN')) {
    console.log(`journal: ${journalNote}`);
    console.log('  the verdict stands, but this decision cannot be replayed later.');
  } else if (journalNote) {
    console.log(`journal: ${journalNote}  (replay it with: node scripts/jev-replay.mjs policy)`);
  } else if (!journal) {
    console.log('journal: not written (--no-journal)');
  }

  process.exitCode = decision.exitCode;
}
