#!/usr/bin/env node
/**
 * Decision core: thresholds, the three-way verdict, and the decision journal.
 *
 * Why a separate file: the completion gate, the rubric stand and any future audit
 * must all decide the SAME way and write ONE journal. The threshold lives here,
 * in code — not in the wording of a question and not in the agent's head.
 *
 * Three outcomes, not two (TypeSafe's own recommendation, and the shape used by
 * the PR-review pipeline in case 40):
 *   p > yes  -> act
 *   p < no   -> do not act
 *   in between -> a human decides
 *
 * Fail-open rule (case 165: a silent checker blocked an entire pipeline):
 * "no answer" is NOT "forbidden". A missing judgment yields UNVERIFIED — an
 * explicit "not confirmed", never a silent block.
 *
 * The decision journal keeps the FULL distribution, not just the winning label:
 * "0.91 vs 0.05" and "0.36 vs 0.34" are different news, and one label cannot
 * tell them apart.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Journals live in $JEV_GATES_HOME when set, otherwise next to the scripts. */
export function homeDir() {
  const custom = process.env.JEV_GATES_HOME;
  if (!custom) return HERE;
  if (!existsSync(custom)) mkdirSync(custom, { recursive: true });
  return custom;
}

export const decisionsPath = () => join(homeDir(), 'jev-decisions.jsonl');

/** Default thresholds. Change them deliberately, against the cost of an error. */
export const THRESHOLDS = { yes: 0.8, no: 0.2 };

/** Decide from a probability. Code applies the threshold; the model only scores. */
export function decide(p, thresholds = THRESHOLDS) {
  if (typeof p !== 'number' || Number.isNaN(p)) return 'unverified';
  if (p >= thresholds.yes) return 'yes';
  if (p <= thresholds.no) return 'no';
  return 'review';
}

/** Short digest of a text: the journal needs a reference, not the whole state. */
export function digest(text, len = 12) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, len);
}

/**
 * Append one decision. Leaf fields only: model version, question and state
 * digests, the full distribution, the thresholds, and the action taken.
 */
export function logDecision(record) {
  const entry = { at: new Date().toISOString(), ...record };
  appendFileSync(decisionsPath(), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

/** Flatten a Jev answer into value + distribution + confidence. Invents nothing. */
export function flattenAnswers(answers = {}) {
  const out = {};
  for (const [id, a] of Object.entries(answers)) {
    if (!a || typeof a !== 'object') continue;
    if (typeof a.noul === 'number') {
      out[id] = { type: 'noul', value: a.noul };
    } else if (typeof a.choice === 'string') {
      out[id] = {
        type: 'choice',
        value: a.choice,
        probabilities: a.probabilities ?? null,
        confidence: a.confidence ?? null,
      };
    } else if (typeof a.score === 'number') {
      out[id] = {
        type: 'score',
        value: a.score,
        probabilities: a.probabilities ?? null,
        confidence: a.confidence ?? null,
      };
    }
  }
  return out;
}

export function readDecisions() {
  const path = decisionsPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function summarizeDecisions(rows = readDecisions()) {
  const byVerdict = {};
  const byKind = {};
  let cost = 0;
  let tokens = 0;
  for (const r of rows) {
    if (r.verdict) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
    if (r.kind) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    cost += r.costUsd ?? 0;
    tokens += r.inputTokens ?? 0;
  }
  return { total: rows.length, byVerdict, byKind, costUsd: cost, inputTokens: tokens };
}

// --- CLI ---------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const cmd = process.argv[2] ?? 'summary';
  if (cmd === 'summary') {
    const s = summarizeDecisions();
    console.log(`decision records: ${s.total}`);
    console.log(`by kind:     ${JSON.stringify(s.byKind)}`);
    console.log(`by verdict:  ${JSON.stringify(s.byVerdict)}`);
    console.log(`input: ${s.inputTokens} tokens, cost: $${s.costUsd.toFixed(5)}`);
    const rows = readDecisions().slice(-5);
    if (rows.length) {
      console.log('\nlast decisions:');
      for (const r of rows) {
        console.log(`  ${r.at.slice(0, 16)}  ${(r.label ?? '-').slice(0, 30).padEnd(32)} ${r.verdict ?? '-'}`);
      }
    }
    console.log(`\njournal: ${decisionsPath()}`);
  } else if (cmd === 'thresholds') {
    console.log(JSON.stringify(THRESHOLDS));
  } else {
    console.log('commands: summary | thresholds');
  }
}
