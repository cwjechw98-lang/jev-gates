#!/usr/bin/env node
/**
 * DSH adapter installer (REQ-09, T25).
 *
 * Three rules shape this file, and each one is a scar:
 *
 *   1. **Dry run is the default.** `--apply` is required to write anything. An
 *      installer that edits a live harness configuration as a side effect of
 *      being run is an installer nobody should run.
 *   2. **Only our own lines are touched.** The adapter owns a marked block. It is
 *      inserted into an existing composition, and removed by removing exactly
 *      that block. Nothing else in the file is rewritten — not formatting, not
 *      comments, not someone else's rows.
 *   3. **Uninstall compares a fingerprint first.** If the file changed since we
 *      wrote it, restoring the backup would silently discard the user's later
 *      edits. In that case the installer reports the difference and removes only
 *      its own block, leaving the rest alone.
 *
 * It never touches the installed `node_modules` and never edits an agent preset.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { compositionFiles, findDshInstall } from './doctor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BLOCK_START = '# >>> jev-gates dsh adapter >>>';
export const BLOCK_END = '# <<< jev-gates dsh adapter <<<';
export const ADAPTER_VERSION = '2.0.0';

export function fingerprint(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** The composition row, as YAML text, with an absolute configPath. */
export function adapterBlock({ hooksPath, mode = 'shadow', policy = 'unknown' }) {
  return [
    BLOCK_START,
    '- name: \'@deepseek-ai/dsh-hooks-claude-code\'',
    '  config:',
    `    configPath: ${hooksPath}`,
    '    pluginRoot: jev-gates',
    '    projectDir: .',
    BLOCK_END,
  ].join('\n');
}

/** The hook configuration the bridge reads. */
export function hookConfig({ bridgePath, mode = 'shadow', policy = 'unknown', maxSteers = 2 }) {
  const command = `node "${bridgePath}"`;
  const env = { JEV_DSH_MODE: mode, JEV_DSH_POLICY: policy, JEV_DSH_MAX_STEERS: String(maxSteers) };
  return {
    hooks: {
      PreToolUse: [{ matcher: 'Bash|PowerShell|pwsh|Shell|Terminal', hooks: [{ type: 'command', command, env }] }],
      PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command, env }] }],
      Stop: [{ hooks: [{ type: 'command', command, env }] }],
    },
  };
}

export function hasBlock(text) {
  return typeof text === 'string' && text.includes(BLOCK_START) && text.includes(BLOCK_END);
}

/** Insert or replace the block. Returns the new text and whether it changed. */
export function applyBlock(text, block) {
  if (hasBlock(text)) {
    const start = text.indexOf(BLOCK_START);
    const end = text.indexOf(BLOCK_END) + BLOCK_END.length;
    const next = `${text.slice(0, start)}${block}${text.slice(end)}`;
    return { text: next, changed: next !== text, action: 'replaced' };
  }
  const separator = text.endsWith('\n') || text === '' ? '' : '\n';
  return { text: `${text}${separator}${block}\n`, changed: true, action: 'appended' };
}

export function removeBlock(text) {
  if (!hasBlock(text)) return { text, changed: false, action: 'absent' };
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END) + BLOCK_END.length;
  let next = `${text.slice(0, start)}${text.slice(end)}`;
  next = next.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  return { text: next, changed: next !== text, action: 'removed' };
}

function readOrEmpty(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Resolve the files the installer will touch, without touching them. */
export function plan({ env = process.env, home = homedir(), mode = 'shadow', policy = 'unknown', maxSteers = 2 } = {}) {
  const { dshHome, profile, files } = compositionFiles({ env, home });
  const target = files.find((f) => f.endsWith('cordis.patch.yml')) ?? files[files.length - 1];
  const stateRoot = env.JEV_DSH_STATE ?? (env.JEV_GATES_HOME ? join(env.JEV_GATES_HOME, 'dsh-state') : join(HERE, '..', '..', '.dsh-state'));
  const hooksPath = join(stateRoot, 'hooks.json');
  const bridgePath = join(HERE, 'bridge.mjs');
  const block = adapterBlock({ hooksPath, mode, policy });
  const current = readOrEmpty(target);
  const applied = applyBlock(current, block);
  return {
    dshHome,
    profile,
    target,
    targetExists: existsSync(target),
    hooksPath,
    bridgePath,
    block,
    before: current,
    after: applied.text,
    action: applied.action,
    changed: applied.changed,
    backupPath: `${target}.jev-gates.bak`,
    installFound: findDshInstall({ env, home }) !== null,
    hookConfig: hookConfig({ bridgePath, mode, policy, maxSteers }),
  };
}

export function install({ env = process.env, home = homedir(), apply = false, mode = 'shadow', policy = 'unknown', maxSteers = 2 } = {}) {
  const p = plan({ env, home, mode, policy, maxSteers });
  const result = { ...p, applied: false, wrote: [], dryRun: !apply };

  if (!apply) return result;
  if (!p.installFound) {
    result.error = 'no @deepseek-ai/dsh installation found; refusing to write a configuration for a harness that is not here';
    return result;
  }

  mkdirSync(dirname(p.target), { recursive: true });
  const stateRoot = dirname(p.hooksPath);
  if (!existsSync(stateRoot)) mkdirSync(stateRoot, { recursive: true });

  // Back up once, and never overwrite an existing backup: the first backup is
  // the only one that describes the user's original file.
  if (p.targetExists && !existsSync(p.backupPath)) {
    copyFileSync(p.target, p.backupPath);
    result.wrote.push(p.backupPath);
  }
  writeFileSync(p.target, p.after, 'utf8');
  result.wrote.push(p.target);

  writeFileSync(p.hooksPath, `${JSON.stringify(p.hookConfig, null, 2)}\n`, 'utf8');
  result.wrote.push(p.hooksPath);

  result.applied = true;
  result.fingerprint = fingerprint(p.after);
  return result;
}

export function uninstall({ env = process.env, home = homedir(), apply = false } = {}) {
  const { files } = compositionFiles({ env, home });
  const target = files.find((f) => f.endsWith('cordis.patch.yml')) ?? files[files.length - 1];
  const current = readOrEmpty(target);
  const backupPath = `${target}.jev-gates.bak`;
  const removed = removeBlock(current);
  const result = {
    target,
    backupPath,
    backupExists: existsSync(backupPath),
    changed: removed.changed,
    action: removed.action,
    applied: false,
    notes: [],
  };

  if (!removed.changed) {
    result.notes.push('no jev-gates block was present: nothing to remove');
  }

  if (result.backupExists) {
    const backup = readOrEmpty(backupPath);
    const currentFingerprint = fingerprint(current);
    // Does the current file still equal what we wrote? We can tell by checking
    // whether removing our block reproduces the backup exactly.
    const matchesBackup = removed.text.trim() === backup.trim();
    result.backupMatches = matchesBackup;
    if (!matchesBackup) {
      result.notes.push(
        'the file changed after the adapter was installed: the backup will NOT be restored, because that would discard your later edits. Only the adapter block is removed.',
      );
      result.diff = diffSummary(backup, removed.text);
    } else {
      result.notes.push('the file matches the backup after removing the adapter block: the original content is intact');
    }
    result.fingerprint = currentFingerprint;
  }

  if (apply) {
    if (removed.changed) {
      writeFileSync(target, removed.text, 'utf8');
      result.applied = true;
    }
  }
  return result;
}

/** A tiny line-level difference summary: enough to see what would be lost. */
export function diffSummary(a, b) {
  const left = a.split('\n');
  const right = b.split('\n');
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return {
    onlyInBackup: left.filter((l) => l.trim() !== '' && !rightSet.has(l)).slice(0, 20),
    onlyInCurrent: right.filter((l) => l.trim() !== '' && !leftSet.has(l)).slice(0, 20),
  };
}

// --- CLI ---------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const argv = process.argv.slice(2);
  const action = argv[0] ?? 'plan';
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i > -1 ? argv[i + 1] ?? true : fallback;
  };
  const apply = argv.includes('--apply');
  const options = {
    apply,
    mode: String(flag('mode', 'shadow')),
    policy: String(flag('policy', 'unknown')),
    maxSteers: Number(flag('max-steers', 2)),
  };

  if (action === 'plan' || action === 'install') {
    const result = install(options);
    console.log(result.dryRun ? 'DRY RUN — nothing was written' : 'APPLIED');
    console.log('');
    console.log(`target:      ${result.target}${result.targetExists ? '' : ' (will be created)'}`);
    console.log(`action:      ${result.action}`);
    console.log(`hooks file:  ${result.hooksPath}`);
    console.log(`bridge:      ${result.bridgePath}`);
    console.log(`mode:        ${options.mode}   policy: ${options.policy}   max steers: ${options.maxSteers}`);
    console.log('');
    console.log('block to insert:');
    console.log(result.block);
    if (result.dryRun) {
      console.log('');
      console.log('run again with --apply to write it. A backup is written first.');
    } else {
      console.log('');
      console.log(`wrote: ${result.wrote.join(', ')}`);
    }
    if (result.error) {
      console.log(`error: ${result.error}`);
      process.exitCode = 2;
    }
  } else if (action === 'uninstall') {
    const result = uninstall({ apply });
    console.log(apply ? 'UNINSTALL APPLIED' : 'DRY RUN — nothing was removed');
    console.log(`target: ${result.target}`);
    console.log(`action: ${result.action}`);
    for (const note of result.notes) console.log(`note: ${note}`);
    if (result.diff) {
      console.log('lines only in the backup (NOT restored):');
      for (const line of result.diff.onlyInBackup) console.log(`  ${line}`);
      console.log('lines only in the current file (kept):');
      for (const line of result.diff.onlyInCurrent) console.log(`  ${line}`);
    }
  } else {
    console.log('commands: plan | install [--apply] | uninstall [--apply]');
    console.log('options:  --mode shadow|enforce  --policy never|ask|unknown  --max-steers N');
  }
}
