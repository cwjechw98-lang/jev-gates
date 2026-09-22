#!/usr/bin/env node
/**
 * Approval gate: a deterministic check that runs BEFORE an action. No model,
 * 0 ms, $0.
 *
 * Why: an agent harness may run with approval prompts switched off. When it
 * does, a local rule is the only control left, and the only question it needs
 * to answer is "does a human need to be in the loop here?".
 *
 * Why without a model: whatever can be decided by code should be decided by
 * code. Classifying an action by its flags is deterministic, so a model would
 * only add cost, latency and a new failure mode.
 *
 * HONEST LIMIT: this gate is advice. It executes nothing and blocks nothing —
 * it says whether to ask a human. It also cannot catch mis-declared flags: an
 * action described as safe while being destructive will pass. Describing the
 * action is part of the work, not paperwork.
 *
 * CLI:
 *   node scripts/jev-gateway.mjs --action push_public --external --public --reversible=false
 *   node scripts/jev-gateway.mjs --json '{"action":"delete_backup","destructive":true,"reversible":false}'
 *   echo '{"action":"edit_readme","reversible":true}' | node scripts/jev-gateway.mjs
 *   node scripts/jev-gateway.mjs --rules
 *
 * Exit code: 0 = go, 2 = ask the human. --quiet prints JSON only.
 */
import { fileURLToPath } from 'node:url';
import { logDecision } from './jev-decisions.mjs';

/**
 * The rule table is data, not branching: it can be read, argued with and
 * audited. Order sets the order of reasons; the verdict is a single "human"
 * if any rule fires.
 */
export const RULES = [
  {
    id: 'credential_out',
    when: (f) => f.credential && f.external,
    why: 'a credential leaves the machine',
  },
  {
    id: 'destructive_irreversible',
    when: (f) => f.destructive && !f.reversible,
    why: 'destructive and irreversible',
  },
  {
    id: 'public_irreversible',
    when: (f) => f.public && !f.reversible,
    why: 'published outward with no way back',
  },
  {
    id: 'external_irreversible',
    when: (f) => f.external && !f.reversible,
    why: 'external action with no way back',
  },
  {
    id: 'bulk_irreversible',
    when: (f) => f.bulk && !f.reversible,
    why: 'bulk operation with no way back',
  },
  {
    id: 'undeclared',
    when: (f) => !f.declared,
    why: 'the action is not described, so there is nothing to judge: ask the human',
  },
];

/** Verdict from flags. It always answers — a deterministic rule has no silence. */
export function gate(flags) {
  const f = {
    external: !!flags.external,
    public: !!flags.public,
    destructive: !!flags.destructive,
    credential: !!flags.credential,
    bulk: !!flags.bulk,
    reversible: flags.reversible !== false, // irreversibility must be declared
    declared: flags.declared !== false && !!(flags.action || flags.declared),
  };
  const hit = RULES.filter((r) => r.when(f));
  return {
    action: flags.action ?? null,
    flags: f,
    verdict: hit.length ? 'human' : 'allow',
    reasons: hit.map((r) => `${r.id}: ${r.why}`),
  };
}

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {};
  let action;
  let json;
  let quiet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') json = argv[++i];
    else if (a === '--action') action = argv[++i];
    else if (a === '--quiet') quiet = true;
    else if (a.startsWith('--')) {
      const [name, val] = a.slice(2).split('=');
      flags[name] = val === undefined ? true : val !== 'false';
    }
  }
  return { flags, action, json, quiet };
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--rules') {
    for (const r of RULES) console.log(`${r.id.padEnd(24)} ${r.why}`);
  } else {
    const { flags, action, json, quiet } = parseArgs(argv);
    let input = flags;
    if (json) {
      input = { ...JSON.parse(json) };
    } else {
      const stdin = await readStdin();
      if (stdin) input = { ...input, ...JSON.parse(stdin) };
    }
    if (action) input.action = action;

    const result = gate(input);
    logDecision({
      kind: 'gateway',
      label: result.action ?? 'unnamed',
      verdict: result.verdict,
      reasons: result.reasons,
      flags: result.flags,
      costUsd: 0,
    });

    if (quiet) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`action: ${result.action ?? '(unnamed)'}`);
      console.log(`verdict: ${result.verdict === 'human' ? 'ASK A HUMAN' : 'GO'}`);
      for (const r of result.reasons) console.log(`  reason: ${r}`);
      if (result.verdict === 'allow') {
        console.log('  no stopping reason: no external, public, destructive, bulk or');
        console.log('  irreversible flag was declared');
      }
      console.log('(advice, not enforcement: this gate does nothing and blocks nothing)');
    }
    process.exitCode = result.verdict === 'human' ? 2 : 0;
  }
}
