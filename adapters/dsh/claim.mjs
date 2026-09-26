#!/usr/bin/env node
/**
 * Record and clear the claim a session is working on.
 *
 * The Stop handler steers a turn only when a claim is outstanding, and until now
 * nothing wrote that claim — so Stop was silent by construction and the
 * completion gate was never actually connected to the end of a turn. This is the
 * producer.
 *
 * The claim is a small JSON file under the adapter state directory, keyed by
 * session id. It records what is being claimed and, optionally, the request the
 * gate should judge when the turn ends.
 *
 *   node adapters/dsh/claim.mjs set "the tests pass" --session <id> [--request req.json]
 *   node adapters/dsh/claim.mjs show --session <id>
 *   node adapters/dsh/claim.mjs clear --session <id>
 *
 * Exit codes: 0 written or cleared, 3 nothing to show, 2 usage error.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateDir } from './bridge.mjs';

export const CLAIM_VERSION = 1;

/** The claim file for one session. Kept beside the state, under the same rules. */
export function claimPath(sessionId, env = process.env) {
  const safe = String(sessionId ?? 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'unknown';
  return join(stateDir(env), `${safe}.pending-claim`);
}

export function writeClaim({ sessionId, claim, request = null, at = new Date().toISOString(), env = process.env, taskId = null, promptId = null, snapshotDigest = null, collect = null }) {
  const path = claimPath(sessionId, env);
  mkdirSync(stateDir(env), { recursive: true });
  // `taskId`, `promptId` and `snapshotDigest` are what the Stop handler's
  // anti-loop key is built from. Without them the key could only be a turn
  // number, and a repeat of the same unresolved condition in a later turn would
  // look like new information.
  const record = { claimVersion: CLAIM_VERSION, sessionId, claim, request, at, taskId, promptId, snapshotDigest, collect };
  writeFileSync(path, JSON.stringify(record, null, 2), 'utf8');
  return { path, record };
}

export function readClaim({ sessionId, env = process.env }) {
  const path = claimPath(sessionId, env);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    // A claim file written by hand as plain text is still a claim: the older
    // bridge read it as a bare string, and refusing it would silently disable
    // the gate for anyone who wrote one that way.
    if (typeof parsed === 'string') return { claim: parsed, request: null, at: null };
    return parsed;
  } catch {
    const text = readFileSync(path, 'utf8').trim();
    return text ? { claim: text, request: null, at: null } : null;
  }
}

export function clearClaim({ sessionId, env = process.env }) {
  const path = claimPath(sessionId, env);
  if (!existsSync(path)) return { path, cleared: false };
  rmSync(path, { force: true });
  return { path, cleared: true };
}

// --- CLI ---------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i > -1 ? argv[i + 1] ?? true : undefined;
  };
  const command = argv[0];
  const sessionId = flag('session') ?? process.env.DSH_SESSION_ID ?? process.env.JEV_DSH_SESSION ?? 'unknown';

  if (command === 'set') {
    const claim = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
    if (!claim) {
      console.log('usage: jev-dsh-claim.mjs set "<what is being claimed>" [--session <id>] [--request <file>]');
      process.exitCode = 2;
    } else {
      const { path, record } = writeClaim({ sessionId, claim, request: flag('request') ?? null });
      console.log(`claim recorded for session ${record.sessionId}`);
      console.log(`gate request: ${record.request ?? '(none — the Stop handler will steer without judging)'}`);
      console.log(`file: ${path}`);
    }
  } else if (command === 'show') {
    const record = readClaim({ sessionId });
    if (!record) {
      // Absence is not a pass, and it is not a failure either: it means the
      // session never said what it was working on, so the gate has nothing to judge.
      console.log(`no claim recorded for session ${sessionId}`);
      process.exitCode = 3;
    } else {
      console.log(JSON.stringify(record, null, 2));
    }
  } else if (command === 'clear') {
    const { path, cleared } = clearClaim({ sessionId });
    console.log(cleared ? `claim cleared: ${path}` : `nothing to clear: ${path}`);
  } else {
    console.log('commands: set <claim> [--request <file>] | show | clear   (all take --session <id>)');
    process.exitCode = 2;
  }
}
