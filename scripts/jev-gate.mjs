#!/usr/bin/env node
/**
 * Completion gate: "done" is confirmed by evidence, not by the agent's word.
 *
 * The order is fixed and must not be rearranged (cases 436 and 214):
 *   do the work -> READ THE TARGET -> collect evidence -> judge.
 * Judging a success message without reading the target adds one more opinion,
 * not proof.
 *
 * Code computes the numbers: file counts and sizes, exit codes, artifact
 * existence. The model receives ready values and answers yes/no questions.
 *
 * HONEST LIMIT that cannot be papered over: this gate checks whether the
 * evidence is CONSISTENT with the claim, not whether it is TRUE. If the agent
 * invented the facts, the gate will not see it — it only sees that the
 * invention is coherent. That is why evidence is collected by code (files,
 * commands, artifacts) and not by prose.
 *
 * CLI:
 *   node scripts/jev-gate.mjs --claims claims.json
 *   node scripts/jev-gate.mjs --claims claims.json --dry   state and questions, no model call
 *   node scripts/jev-gate.mjs --claims -                   read the JSON from stdin
 *
 * Exit code: 0 confirmed, 1 not done, 2 human review, 3 unverified.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ask } from './jev.mjs';
import { THRESHOLDS, decide, digest, flattenAnswers, logDecision } from './jev-decisions.mjs';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Computes what code should compute, and assembles the textual state. */
export function buildState(claims) {
  const ev = claims.evidence ?? {};
  const writes = Array.isArray(ev.writes) ? ev.writes : [];
  const commands = Array.isArray(ev.commands) ? ev.commands : [];
  const artifacts = Array.isArray(ev.artifacts) ? ev.artifacts : [];
  const criteria = Array.isArray(claims.criteria) ? claims.criteria : [];

  const writesRead = writes.filter((w) => w.read_after === true).length;
  const cmdsOk = commands.filter((c) => num(c.exit) === num(c.expect_exit ?? 0)).length;
  const artsOk = artifacts.filter((a) => a.exists !== false && num(a.bytes) > 0).length;

  const lines = [];
  lines.push(`TASK: ${claims.task ?? '(not stated)'}`);
  lines.push('');
  lines.push(`WHAT WAS CLAIMED AS DONE: ${claims.claimed ?? '(no separate statement)'}`);
  lines.push('');
  lines.push('ACCEPTANCE CRITERIA (stated by the human):');
  if (criteria.length) criteria.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
  else lines.push('  (no criteria given)');
  lines.push('');
  lines.push('EVIDENCE - COMPUTED BY CODE, NOT BY A MODEL:');
  lines.push(
    `Files changed: ${writes.length}, ${writes.reduce((s, w) => s + num(w.bytes), 0)} bytes total;` +
      ` read AFTER the last write: ${writesRead} of ${writes.length}.`,
  );
  for (const w of writes) {
    lines.push(`  - ${w.path ?? '(no path)'} - ${num(w.bytes)} bytes, read after write: ${w.read_after === true ? 'yes' : 'no'}`);
  }
  lines.push(`Commands run: ${commands.length}; exit code matched the expected one: ${cmdsOk}.`);
  for (const c of commands) {
    const tail = (c.tail ?? '').toString().replace(/\s+/g, ' ').slice(0, 200);
    const exp = num(c.expect_exit ?? 0);
    lines.push(
      `  - ${c.cmd ?? '(no command)'} - exit code ${num(c.exit)}, expected ${exp}` +
        `${num(c.exit) === exp ? '' : ' (MISMATCH)'}${tail ? `; last output lines: ${tail}` : ''}`,
    );
  }
  lines.push(`Artifacts: ${artifacts.length}; exist and non-empty: ${artsOk}.`);
  for (const a of artifacts) {
    lines.push(`  - ${a.path ?? '(no path)'} - ${num(a.bytes)} bytes, exists: ${a.exists === false ? 'no' : 'yes'}`);
  }
  if (ev.notes) {
    lines.push('');
    lines.push(`WHAT THE AGENT SAYS (explanation, not evidence): ${ev.notes}`);
  }
  if (claims.evidence_ref) {
    lines.push('');
    lines.push(`FULL DOSSIER: ${claims.evidence_ref}`);
  }

  return {
    state: lines.join('\n'),
    stats: {
      writes: writes.length,
      writesRead,
      commands: commands.length,
      cmdsOk,
      artifacts: artifacts.length,
      artsOk,
      criteria: criteria.length,
    },
    criteria,
    has: { writes: writes.length > 0, commands: commands.length > 0, artifacts: artifacts.length > 0 },
  };
}

/**
 * Questions. One narrow axis each. Criteria describe SITUATIONS rather than
 * degrees ("a fact that closes the criterion exists" / "no such fact"), because
 * abstract degrees push the model to the middle of the scale.
 */
export function buildQuestions(criteria) {
  const q = {
    read_after_write: {
      type: 'noul',
      instructions: 'Was every changed file read AFTER the last write to it?',
      criteria: {
        true: 'every changed file carries the note "read after write: yes"',
        false: 'at least one changed file carries "read after write: no"',
      },
    },
    reproduced: {
      type: 'noul',
      instructions: 'Did every command return the exit code that was expected of it?',
      criteria: {
        true: 'each listed command has an exit code equal to its expected code',
        false: 'at least one command has an exit code different from its expected code',
      },
    },
    artifacts_present: {
      type: 'noul',
      instructions: 'Do all claimed artifacts exist and are they non-empty?',
      criteria: {
        true: 'every artifact is marked as existing with a size greater than zero',
        false: 'at least one artifact is missing or has zero size',
      },
    },
  };
  criteria.forEach((c, i) => {
    q[`criterion_${i + 1}`] = {
      type: 'noul',
      instructions: `Is this acceptance criterion satisfied by the evidence above: ${c}`,
      criteria: {
        true: 'the evidence contains a concrete fact (a file, a command, an artifact) that directly closes this criterion',
        false: 'the evidence contains no fact that would close this criterion',
      },
    };
  });
  return q;
}

/** Verdict from probabilities. Thresholds live in code; the middle goes to a human. */
export function verdictOf(flat, applicable) {
  const missing = applicable.filter((id) => !flat[id] || typeof flat[id].value !== 'number');
  if (missing.length) {
    return { verdict: 'unverified', reason: `no answer for: ${missing.join(', ')}` };
  }
  const rows = applicable.map((id) => ({ id, p: flat[id].value, verdict: decide(flat[id].value) }));
  const failed = rows.filter((r) => r.verdict === 'no');
  const unsure = rows.filter((r) => r.verdict === 'review');
  if (failed.length) {
    return {
      verdict: 'not_done',
      reason: `not confirmed: ${failed.map((r) => `${r.id}=${r.p.toFixed(2)}`).join(', ')}`,
      rows,
    };
  }
  if (unsure.length) {
    return {
      verdict: 'review',
      reason: `human review: ${unsure.map((r) => `${r.id}=${r.p.toFixed(2)}`).join(', ')}`,
      rows,
    };
  }
  return { verdict: 'done', reason: `all ${rows.length} questions passed`, rows };
}

const EXIT = { done: 0, not_done: 1, review: 2, unverified: 3 };
const WORD = { done: 'CONFIRMED', not_done: 'NOT DONE', review: 'HUMAN REVIEW', unverified: 'UNVERIFIED' };

// --- CLI ---------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

/** Read a claims file (or stdin with "-"), or report the reason and exit cleanly. */
function readClaims(path) {
  try {
    return JSON.parse(path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8'));
  } catch (error) {
    console.log(`cannot read claims from ${path === '-' ? 'stdin' : path}: ${error.message}`);
    process.exitCode = EXIT.unverified;
    return null;
  }
}

if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i > -1 ? (argv[i + 1]?.startsWith('--') ? true : argv[i + 1] ?? true) : undefined;
  };
  const path = flag('claims');
  let claims = null;
  if (!path) {
    console.log('need --claims <file|->; the format is described in the header of this file');
    process.exitCode = EXIT.unverified;
  } else if (!(claims = readClaims(path))) {
    // readClaims already reported the reason and set the exit code
  } else {
    const { state, stats, criteria, has } = buildState(claims);
    const questions = buildQuestions(criteria);

    // Questions that cannot apply are not asked: with no records there is nothing to ask about.
    const applicable = [];
    if (has.writes) applicable.push('read_after_write');
    if (has.commands) applicable.push('reproduced');
    if (has.artifacts) applicable.push('artifacts_present');
    criteria.forEach((_, i) => applicable.push(`criterion_${i + 1}`));

    if (!applicable.length) {
      console.log('NOTHING TO CHECK: no changed files, no commands, no artifacts, no criteria.');
      console.log('This is not "done" — it is the absence of evidence.');
      process.exitCode = 3;
    } else if (flag('dry')) {
      console.log('-- STATE --');
      console.log(state);
      console.log('\n-- QUESTIONS --');
      console.log(JSON.stringify(Object.fromEntries(applicable.map((id) => [id, questions[id]])), null, 2));
      console.log(`\napplicable questions: ${applicable.length}; computed by code: ${JSON.stringify(stats)}`);
    } else {
      const only = Object.fromEntries(applicable.map((id) => [id, questions[id]]));
      const model = flag('model') ?? 'jev-1.13.0';
      let res;
      try {
        res = await ask(state, only, { model });
      } catch (error) {
        // Fail-open: a missing judgment means "not confirmed", never "forbidden".
        console.log(`VERDICT: ${WORD.unverified}`);
        console.log(`reason: the judge is unreachable (${error.message})`);
        console.log('this is NOT "done" and NOT "forbidden": nothing is confirmed, a human decides.');
        logDecision({
          kind: 'gate',
          label: claims.task ?? 'unnamed',
          verdict: 'unverified',
          reason: `judge unreachable: ${error.message}`,
          stateDigest: digest(state),
          questionDigest: digest(JSON.stringify(only)),
          costUsd: 0,
        });
        process.exitCode = EXIT.unverified;
      }
      if (res) {
        const flat = flattenAnswers(res.answers);
        const v = verdictOf(flat, applicable);
        console.log(`VERDICT: ${WORD[v.verdict]}`);
        console.log(`reason: ${v.reason}`);
        console.log(`evidence: ${JSON.stringify(stats)}`);
        console.log('');
        for (const id of applicable) {
          const a = flat[id];
          console.log(`  ${id.padEnd(20)} ${a ? a.value.toFixed(2) : '-'}   ${a ? decide(a.value) : 'no answer'}`);
        }
        console.log('');
        console.log(`model ${res.model}, input ${res.inputTokens} tokens, $${res.costUsd.toFixed(6)}`);
        console.log('limit: this gate checks that the evidence is consistent, not that it is true.');

        logDecision({
          kind: 'gate',
          label: claims.task ?? 'unnamed',
          model: res.model,
          verdict: v.verdict,
          reason: v.reason,
          thresholds: THRESHOLDS,
          stateDigest: digest(state),
          questionDigest: digest(JSON.stringify(only)),
          answers: flat,
          stats,
          inputTokens: res.inputTokens,
          costUsd: Number(res.costUsd.toFixed(6)),
        });
        process.exitCode = EXIT[v.verdict];
      }
    }
  }
}
