#!/usr/bin/env node
/**
 * TypeSafe Jev (System One) client with an experience journal.
 *
 * Portable: no dependencies, no project coupling. Node 18+.
 *
 * Rules of form (established by live probing, see docs/DESIGN.md):
 *   - code computes the numbers, the model receives ready values;
 *   - state is a plain STRING, not a JSON object;
 *   - Noul (yes/no probability) instead of Score for judgments;
 *   - the caller's code applies the threshold.
 *
 * CLI:
 *   node scripts/jev.mjs check                                  is the route alive and the key valid
 *   node scripts/jev.mjs ask '<state>' '<questions-json>'       one call
 *   node scripts/jev.mjs journal                                accumulated experience
 *   node scripts/jev.mjs note '<finding>' --label x --verdict ok|wrong|unclear
 *
 * As a library:
 *   import { ask, logOutcome } from './jev.mjs';
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveApiKey } from '../lib/credentials.mjs';
import { buildRequest, DEFAULT_MODEL } from '../lib/judge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const PRICE_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/** Journals live in $JEV_GATES_HOME when set, otherwise next to the scripts. */
export function homeDir() {
  const custom = process.env.JEV_GATES_HOME;
  if (!custom) return HERE;
  if (!existsSync(custom)) mkdirSync(custom, { recursive: true });
  return custom;
}

export const journalPath = () => join(homeDir(), 'jev-journal.jsonl');

/**
 * API key, resolved by the one safe resolver.
 *
 * This function used to read the file itself and fall back to `raw` when its
 * YAML pattern did not match — so a whole credentials file could be returned as
 * the key. `resolveApiKey` classifies the file first and refuses to guess, which
 * is the fix; the point of routing every public entry through it is that the fix
 * only holds if there is no second path around it.
 *
 * Order: the environment, then the known credential files. Never logged.
 */
export function apiKey({ homeDir: gatesHome = homeDir(), userHome = undefined } = {}) {
  const resolved = resolveApiKey({ homeDir: gatesHome, ...(userHome ? { userHome } : {}) });
  if (!resolved.ok) {
    throw new Error(`no API key: ${resolved.code}. Set TYPESAFE_API_KEY, or write the key to ${join(gatesHome, 'key')}`);
  }
  return resolved.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One call. Retries 429/529 and network drops with backoff — that is
 * stochastic failure, and a retry is the fix, not grinding.
 */
export async function ask(state, questions, options = {}) {
  const { model = DEFAULT_MODEL, retries = 3, timeoutMs = 90_000 } = options;
  // The body is validated against the documented contract before it is sent: a
  // request the endpoint will reject costs a round trip and, on a paid lane, money.
  const body = buildRequest({ state, model, questions });
  const key = apiKey();
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status} (rate limit / overloaded / server error)`);
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        // Any other 4xx is a deterministic request error: retrying is pointless.
        const error = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        error.deterministic = true;
        throw error;
      }
      const json = JSON.parse(text);
      const inputTokens = json.usage?.input_tokens ?? 0;
      return {
        answers: json.answers,
        model: json.model,
        inputTokens,
        outputTokens: json.usage?.output_tokens ?? 0,
        costUsd: inputTokens * PRICE_PER_INPUT_TOKEN,
      };
    } catch (error) {
      if (error.deterministic) throw error;
      lastError = error;
    }
  }
  throw new Error(`Jev unreachable after ${retries + 1} attempts: ${lastError?.message}`);
}

/** Append one verified finding. A model's self-assessment never goes here. */
export function logOutcome(entry) {
  const record = { at: new Date().toISOString(), ...entry };
  appendFileSync(journalPath(), JSON.stringify(record) + '\n', 'utf8');
  return record;
}

export function readJournal() {
  const path = journalPath();
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

// --- CLI ---------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i > -1 ? rest[i + 1] : undefined;
  };

  if (cmd === 'check') {
    try {
      const res = await ask(
        'The word "yes" appears in this sentence. The sentence is: yes.',
        { alive: { type: 'noul', instructions: 'Does the state contain the word yes?' } },
        { model: flag('model') ?? DEFAULT_MODEL },
      );
      console.log('route: WORKING');
      console.log(`model: ${res.model}, yes probability: ${res.answers?.alive?.noul}`);
      console.log(`cost: $${res.costUsd.toFixed(6)}`);
    } catch (error) {
      console.log('route: FAILED');
      console.log(error.message);
      process.exitCode = 1;
    }
  } else if (cmd === 'ask') {
    const state = rest[0];
    const questions = JSON.parse(rest[1] ?? '{}');
    const res = await ask(state, questions, { model: flag('model') ?? DEFAULT_MODEL });
    console.log(JSON.stringify(res.answers, null, 2));
    console.log(`\nmodel ${res.model}, input ${res.inputTokens} tokens, $${res.costUsd.toFixed(6)}`);
  } else if (cmd === 'note') {
    const text = rest[0];
    if (!text) {
      console.log('usage: jev.mjs note \'<finding>\' [--label name] [--verdict ok|wrong|unclear]');
      process.exitCode = 1;
    } else {
      logOutcome({ label: flag('label'), verdict: flag('verdict'), note: text, costUsd: 0 });
      console.log('written to the experience journal');
    }
  } else if (cmd === 'journal') {
    const rows = readJournal();
    const byVerdict = {};
    for (const r of rows) if (r.verdict) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
    const cost = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    const tokens = rows.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
    console.log(`records: ${rows.length}`);
    console.log(`input tokens: ${tokens}, total cost: $${cost.toFixed(5)}`);
    console.log('verdicts:', JSON.stringify(byVerdict));
    console.log('\nlast 8:');
    for (const r of rows.slice(-8)) {
      const head = `${r.at.slice(0, 16)}  ${(r.label ?? '-').slice(0, 30).padEnd(32)}`;
      const tail = r.verdict ? `verdict: ${r.verdict}` : `input ${r.inputTokens ?? 0} tok.`;
      console.log(`  ${head}${tail}`);
    }
    console.log(`\njournal: ${journalPath()}`);
  } else {
    console.log('commands: check | ask | note | journal');
  }
}
