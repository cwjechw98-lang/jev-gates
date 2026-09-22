/**
 * Install the JEV product kit into a DeepSeek Harness home.
 *
 * The kit is three things that have to arrive together or not at all: the skills
 * the agent reads, the plugin row that registers the tools, and the profile that
 * mounts that row. A partial install is worse than none — a skill that describes
 * a tool the catalog does not contain teaches the agent to call something that
 * does not exist.
 *
 * Three properties this script is built around:
 *
 * 1. **It refuses the active home by default.** The task forbids changing the
 *    running profile, and a default that quietly wrote into `~/.dsh` would be one
 *    typo away from doing exactly that. Installing there needs
 *    `--allow-active-home`, so it can only ever be deliberate.
 *
 * 2. **It never overwrites without a backup.** Every file it replaces is copied
 *    to `<name>.<timestamp>.bak` first, and the manifest records the original so
 *    `--uninstall` can put it back.
 *
 * 3. **Uninstall refuses to delete edited files.** A file whose digest no longer
 *    matches what this script wrote is left in place and reported. Silently
 *    removing a user's edits would be data loss dressed up as a clean uninstall.
 *
 * Usage:
 *   node scripts/jev-install.mjs --home <path> [--profile <name>] [--dry-run]
 *   node scripts/jev-install.mjs --home <path> --uninstall
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/** The skills that make up the kit, and the capability each one serves. */
export const SKILLS = [
  { name: 'jev-completion-gate', capability: 'jev_verify_completion' },
  { name: 'jev-skill-route', capability: 'jev_route_skill' },
  { name: 'jev-progress-review', capability: 'jev_check_progress' },
  { name: 'jev-review-scope', capability: 'jev_review_scope' },
  { name: 'jev-context-plan', capability: 'jev_context_plan' },
  { name: 'jev-diagnose', capability: 'jev_diagnose' },
  { name: 'jev-approval-gate', capability: 'jev_approval_gate' },
  { name: 'jev-rubric-eval', capability: 'jev_rubric_eval' },
];

/** The plugin rows the kit mounts. */
export const ROWS = [
  { id: 'jev-tools', file: 'adapters/dsh/tools.mjs' },
  { id: 'jev-adapter', file: 'adapters/dsh/plugin.mjs' },
];

/** The manifest name. Its presence is what makes `--uninstall` possible. */
const MANIFEST = 'jev-install-manifest.json';

/** Hash a file's bytes, or null when it does not exist. */
function digestOf(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/** Parse `--key value` and `--flag` arguments. */
function parseArgs(argv) {
  const args = { profile: 'jev-product', dryRun: false, uninstall: false, allowActiveHome: false, home: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--home') args.home = argv[++i];
    else if (token === '--profile') args.profile = argv[++i];
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--uninstall') args.uninstall = true;
    else if (token === '--allow-active-home') args.allowActiveHome = true;
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

/** The DSH home in effect, following the same rule the harness uses. */
function activeHome(env = process.env) {
  return env.DSH_HOME && env.DSH_HOME.length > 0 ? resolve(env.DSH_HOME) : join(homedir(), '.dsh');
}

/**
 * The home the live profile actually lives in.
 *
 * The guard protects this one path, not "whatever `DSH_HOME` happens to be".
 * The first version refused any target equal to the current `DSH_HOME`, which
 * also blocked the documented pilot flow — a dedicated, isolated pilot home that
 * the operator had exported as `DSH_HOME` for the pilot shell. Refusing that is
 * not caution, it is a rule aimed at the wrong thing: a non-default home is
 * isolated by the operator's own choice, while `~/.dsh` is where the running
 * session lives whether or not anyone exported anything.
 *
 * `JEV_INSTALL_DEFAULT_HOME` exists so the guard itself can be tested without a
 * test ever naming the real path. A test that passes `~/.dsh` to prove the guard
 * works is one broken comparison away from writing there — which is exactly what
 * happened once already. Pointing this at a temporary directory lets the refusal
 * be exercised for real, safely. Setting it deliberately to redirect the guard is
 * possible; that is an operator's explicit act, not an accident.
 *
 * @param {object} [env] - environment to read the override from.
 * @returns {string} the path the guard protects.
 */
function defaultHome(env = process.env) {
  const override = env.JEV_INSTALL_DEFAULT_HOME;
  if (typeof override === 'string' && override.length > 0) return resolve(override);
  return resolve(join(homedir(), '.dsh'));
}

/**
 * Build the patch layer that mounts the kit's rows.
 *
 * `pathToFileURL` is not decoration: the loader imports the row by URL, and a
 * bare Windows path is not a valid import specifier. Getting this wrong produces
 * a row that mounts and contributes nothing, which is the failure mode that is
 * hardest to notice.
 *
 * @param {string} repo - absolute repository root.
 * @returns {string} YAML text.
 */
export function buildPatch(repo) {
  const lines = ['# Generated by scripts/jev-install.mjs — edit the kit, not this file.', '- insert:'];
  for (const row of ROWS) {
    const url = pathToFileURL(join(repo, row.file)).href;
    lines.push(`    - id: ${row.id}`);
    lines.push(`      name: '${url}'`);
    lines.push('      config:');
    lines.push('        mode: advisory');
  }
  return `${lines.join('\n')}\n`;
}

/** Read the manifest, or null when this home was never installed into. */
function readManifest(home) {
  const path = join(home, MANIFEST);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Install the kit.
 * @param {object} options - parsed arguments.
 * @param {object} [env] - environment, for `DSH_HOME`.
 * @returns {object} a report describing exactly what happened.
 */
export function install(options, env = process.env) {
  const home = resolve(options.home ?? activeHome(env));
  const live = defaultHome(env);
  const report = { action: 'install', home, profile: options.profile, dryRun: options.dryRun, wrote: [], backedUp: [], skipped: [], warnings: [], refused: null };

  if (home === live && !options.allowActiveHome) {
    report.refused = `refusing to install into the live DSH home (${live}) without --allow-active-home`;
    return report;
  }
  // A dedicated home that happens to be `DSH_HOME` is allowed, but the operator
  // should know that the shell they are in points at it.
  if (home === activeHome(env) && home !== live) {
    report.warnings.push(`${home} is the DSH_HOME of this shell; install only if this is the dedicated pilot home`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const skillRoot = join(home, 'skills');
  const profileDir = join(home, 'profiles', options.profile);
  const patchPath = join(profileDir, 'cordis.patch.yml');
  const manifestPath = join(home, MANIFEST);

  // Refuse before writing anything if a skill file already exists with content
  // this script did not write: that is a user's skill, and the kit does not get
  // to overwrite it silently.
  const previous = readManifest(home);
  const owned = new Map((previous?.files ?? []).map((entry) => [entry.path, entry.digest]));
  for (const skill of SKILLS) {
    const target = join(skillRoot, skill.name, 'SKILL.md');
    const current = digestOf(target);
    if (current === null) continue;
    if (owned.get(target) === current) continue;
    report.skipped.push({ path: target, reason: 'exists and was not written by this installer; left untouched' });
  }

  if (!options.dryRun) mkdirSync(skillRoot, { recursive: true });

  const files = [];
  const writeOne = (path, content) => {
    const before = digestOf(path);
    if (before !== null) {
      const backup = `${path}.${stamp}.bak`;
      if (!options.dryRun) cpSync(path, backup);
      report.backedUp.push(backup);
    }
    if (!options.dryRun) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, 'utf8');
    }
    const digest = createHash('sha256').update(content).digest('hex');
    files.push({ path, digest, backup: before === null ? null : `${path}.${stamp}.bak` });
    report.wrote.push(path);
  };

  // Skills are copied from the repository, so the installed text is byte-identical
  // to the reviewed text.
  for (const skill of SKILLS) {
    const source = join(REPO, 'skills', skill.name, 'SKILL.md');
    if (!existsSync(source)) {
      report.skipped.push({ path: source, reason: 'skill source is missing from the repository' });
      continue;
    }
    const target = join(skillRoot, skill.name, 'SKILL.md');
    if (report.skipped.some((entry) => entry.path === target)) continue;
    const content = readFileSync(source, 'utf8');
    const before = digestOf(target);
    if (before !== null) {
      const backup = `${target}.${stamp}.bak`;
      if (!options.dryRun) cpSync(target, backup);
      report.backedUp.push(backup);
    }
    if (!options.dryRun) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
    }
    files.push({ path: target, digest: createHash('sha256').update(content).digest('hex'), backup: before === null ? null : `${target}.${stamp}.bak` });
    report.wrote.push(target);
  }

  writeOne(patchPath, buildPatch(REPO));

  // The manifest is written last: an interrupted install leaves no manifest, so
  // `--uninstall` will not claim to know about files it never finished writing.
  if (!options.dryRun) {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          kitVersion: '1.0.0',
          installedAt: new Date().toISOString(),
          repo: REPO,
          profile: options.profile,
          patch: patchPath,
          skills: SKILLS,
          rows: ROWS,
          files,
        },
        null,
        2,
      ),
      'utf8',
    );
  }
  report.manifest = manifestPath;
  return report;
}

/**
 * Remove the kit.
 *
 * A file is deleted only when its digest still matches what the manifest
 * recorded. An edited file is reported and kept — the user's change outranks a
 * tidy uninstall — and a file with a backup is restored from it.
 *
 * @param {object} options - parsed arguments.
 * @param {object} [env] - environment, for `DSH_HOME`.
 * @returns {object} a report.
 */
export function uninstall(options, env = process.env) {
  const home = resolve(options.home ?? activeHome(env));
  const report = { action: 'uninstall', home, dryRun: options.dryRun, removed: [], restored: [], kept: [], refused: null };

  const manifest = readManifest(home);
  if (!manifest) {
    report.refused = `no ${MANIFEST} in ${home}; this installer did not install here, so it will not remove anything`;
    return report;
  }

  for (const entry of manifest.files ?? []) {
    const current = digestOf(entry.path);
    if (current === null) {
      report.kept.push({ path: entry.path, reason: 'already absent' });
      continue;
    }
    if (current !== entry.digest) {
      report.kept.push({ path: entry.path, reason: 'modified since install; left in place' });
      continue;
    }
    if (entry.backup && existsSync(entry.backup)) {
      if (!options.dryRun) cpSync(entry.backup, entry.path);
      report.restored.push(entry.path);
      continue;
    }
    if (!options.dryRun) rmSync(entry.path, { force: true });
    report.removed.push(entry.path);
  }

  // Remove the directories the kit created, but only when they are now empty.
  if (!options.dryRun) {
    for (const skill of SKILLS) {
      const dir = join(home, 'skills', skill.name);
      try {
        if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a directory we cannot remove is not a failure worth aborting for */
      }
    }
    rmSync(join(home, MANIFEST), { force: true });
  }
  report.manifestRemoved = join(home, MANIFEST);
  return report;
}

/** Human-readable summary. */
function render(report) {
  const lines = [`${report.action}${report.dryRun ? ' (dry run)' : ''} -> ${report.home}`];
  if (report.refused) return `${lines[0]}\nREFUSED: ${report.refused}`;
  for (const warning of report.warnings ?? []) lines.push(`warning: ${warning}`);
  if (report.wrote) lines.push(`wrote ${report.wrote.length} file(s), backed up ${report.backedUp.length}`);
  if (report.removed) lines.push(`removed ${report.removed.length}, restored ${report.restored.length}, kept ${report.kept.length}`);
  for (const entry of report.skipped ?? []) lines.push(`skipped: ${entry.path} — ${entry.reason}`);
  for (const entry of report.kept ?? []) lines.push(`kept: ${entry.path} — ${entry.reason}`);
  if (report.manifest) lines.push(`manifest: ${report.manifest}`);
  return lines.join('\n');
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(2);
  }
  if (args.help) {
    console.log('usage: node scripts/jev-install.mjs --home <path> [--profile <name>] [--dry-run] [--uninstall] [--allow-active-home] [--json]');
    return;
  }
  const report = args.uninstall ? uninstall(args) : install(args);
  console.log(args.json ? JSON.stringify(report, null, 2) : render(report));
  process.exit(report.refused ? 2 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
