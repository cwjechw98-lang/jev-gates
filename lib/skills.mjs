/**
 * Read the skill catalog a router can choose from.
 *
 * The router needs three things a directory listing cannot give it: an identity
 * that survives a rename, a description it can compare against a task, and an
 * honest account of what each skill *requires*. The last one is the difference
 * between a recommendation and a promise — a skill that needs a tool the session
 * does not have must be filtered out before any model sees it, not after.
 *
 * Two fields are kept apart on purpose:
 *
 * - `declared` — what the skill's own frontmatter states;
 * - `inferred` — what the body mentions, which is a hint and may be wrong.
 *
 * A router that conflated them would treat "the description mentions a browser"
 * as "this skill can drive a browser". The distinction is carried into the
 * envelope so a reader can see which one a filter used.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Catalog shape version. */
export const CATALOG_VERSION = '1.0.0';

/** Frontmatter keys this project recognises. Anything else is preserved verbatim. */
const KNOWN_KEYS = new Set(['name', 'description', 'whenToUse', 'version', 'capabilities', 'requires', 'tools', 'model']);

/**
 * Parse the small YAML subset a SKILL.md frontmatter uses.
 *
 * Deliberately not a YAML parser. It handles `key: value`, quoted values, and
 * inline `[a, b]` lists — the forms this project writes — and reports a line it
 * cannot read instead of guessing, because a silently dropped `requires:` would
 * turn an unavailable skill into a recommended one.
 *
 * @param {string} text - the whole file.
 * @returns {{ data: Record<string, unknown>, body: string, problems: string[] }}
 */
export function parseFrontmatter(text) {
  const problems = [];
  const normalized = text.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) return { data: {}, body: normalized, problems: ['no frontmatter block'] };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: normalized, problems: ['frontmatter block is not closed'] };

  const block = normalized.slice(normalized.indexOf('\n', 3) + 1, end + 1);
  const body = normalized.slice(end + 4).replace(/^\r?\n/, '');
  const data = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) {
      problems.push(`unreadable frontmatter line: ${JSON.stringify(rawLine)}`);
      continue;
    }
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((item) => unquote(item.trim()))
        .filter((item) => item.length > 0);
    } else {
      value = unquote(value);
    }
    data[key] = value;
    if (!KNOWN_KEYS.has(key)) problems.push(`unrecognised frontmatter key: ${key}`);
  }
  if (typeof data.name !== 'string' || data.name.length === 0) problems.push('frontmatter has no name');
  if (typeof data.description !== 'string' || data.description.length === 0) problems.push('frontmatter has no description');
  return { data, body, problems };
}

function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Normalise a frontmatter value into a list of non-empty strings. */
function asList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.length > 0);
  if (typeof value === 'string' && value.length > 0) {
    return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
  }
  return [];
}

/**
 * The roots to scan, in precedence order.
 *
 * A session-local skill shadows a user skill with the same name; the repository's
 * own skills come last. `roots` is returned with its origin so a catalog entry
 * can say where it came from — a recommendation the reader cannot locate is not
 * actionable.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] - environment, for `DSH_HOME`.
 * @param {string} [options.home] - user home.
 * @param {string} [options.repoRoot] - this checkout.
 * @returns {{ root: string, origin: string, rank: number }[]}
 */
export function skillRoots({ env = process.env, home = homedir(), repoRoot = null } = {}) {
  const dshHome = env.DSH_HOME && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(home, '.dsh');
  const roots = [
    { root: join(dshHome, 'skills'), origin: 'session', rank: 0 },
    { root: join(home, '.config', 'jev-gates', 'skills'), origin: 'user', rank: 1 },
  ];
  if (repoRoot) roots.push({ root: join(repoRoot, 'skills'), origin: 'package', rank: 2 });
  return roots;
}

/** Read one skill directory into a catalog entry. */
function readSkill(dir, { origin, root }) {
  const path = join(dir, 'SKILL.md');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { error: { path, origin, message: `cannot read SKILL.md: ${error.message}` } };
  }
  const { data, body, problems } = parseFrontmatter(text);
  const id = typeof data.name === 'string' && data.name.length > 0 ? data.name : dir.split(/[\\/]/).pop();
  const digest = `sha256:${createHash('sha256').update(text).digest('hex')}`;

  const declared = {
    capabilities: asList(data.capabilities),
    requires: asList(data.requires ?? data.tools),
    needsModel: data.model === 'true' || data.model === true,
    version: typeof data.version === 'string' ? data.version : null,
  };
  const inferred = inferFromBody(body);

  return {
    entry: {
      id,
      name: id,
      description: typeof data.description === 'string' ? data.description : '',
      whenToUse: typeof data.whenToUse === 'string' ? data.whenToUse : '',
      version: declared.version ?? 'unversioned',
      digest,
      path,
      origin,
      root,
      declared,
      inferred,
      // A skill that failed to parse is still listed, with the problem attached.
      // Dropping it would make the catalog disagree with the filesystem.
      problems,
    },
  };
}

/** What the body mentions. A hint for a shortlist, never a capability claim. */
function inferFromBody(body) {
  const tools = new Set();
  for (const match of body.matchAll(/`(jev[-_][a-z0-9_-]+)`/gi)) tools.add(match[1].toLowerCase());
  const needsModel = /\bJEV\b|\bjudge\b|semantic/i.test(body) && !/\bno model\b/i.test(body);
  const needsNetwork = /https?:\/\//.test(body) || /\bnetwork\b/i.test(body);
  return { tools: [...tools].sort(), needsModel, needsNetwork };
}

/**
 * Read every skill under every root.
 *
 * A missing root is not an error — most sessions have no `~/.dsh/skills` — but a
 * root that exists and cannot be listed is, because the catalog would silently
 * shrink.
 *
 * @param {object} [options]
 * @param {{root: string, origin: string, rank: number}[]} [options.roots]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.home]
 * @param {string} [options.repoRoot]
 * @returns {{ catalogVersion: string, skills: object[], problems: object[], roots: object[] }}
 */
export function readCatalog({ roots, env = process.env, home = homedir(), repoRoot = null } = {}) {
  const resolvedRoots = roots ?? skillRoots({ env, home, repoRoot });
  const problems = [];
  const byId = new Map();

  for (const { root, origin, rank } of resolvedRoots) {
    let names;
    try {
      names = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') problems.push({ root, origin, message: `cannot list root: ${error.message}` });
      continue;
    }
    for (const dirent of names) {
      if (!dirent.isDirectory()) continue;
      const dir = join(root, dirent.name);
      try {
        if (!statSync(join(dir, 'SKILL.md')).isFile()) continue;
      } catch {
        continue;
      }
      const { entry, error } = readSkill(dir, { origin, root });
      if (error) {
        problems.push(error);
        continue;
      }
      const existing = byId.get(entry.id);
      // First root wins: a session-local skill shadows a package one.
      if (existing && existing.rank <= rank) continue;
      byId.set(entry.id, { ...entry, rank });
    }
  }

  const skills = [...byId.values()]
    .map(({ rank, ...entry }) => entry)
    .sort((a, b) => a.id.localeCompare(b.id));

  return { catalogVersion: CATALOG_VERSION, skills, problems, roots: resolvedRoots };
}

/**
 * A deterministic, auditable shortlist.
 *
 * This runs BEFORE any model sees the catalog. It removes what cannot work, and
 * it can never remove the skill a human named — an explicit instruction is not a
 * candidate to be ranked, it is the answer.
 *
 * @param {object} input
 * @param {string} input.task - the task text, used only for keyword scoring.
 * @param {object[]} input.skills - from {@link readCatalog}.
 * @param {string} [input.explicitSkill] - a skill the user named.
 * @param {string[]} [input.availableTools] - tools the session actually has.
 * @param {number} [input.limit] - maximum shortlist size.
 * @returns {{ explicit: object|null, shortlist: object[], excluded: object[], problems: object[] }}
 */
export function shortlist({ task, skills, explicitSkill = null, availableTools = [], limit = 6 }) {
  const problems = [];
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const excluded = [];

  let explicit = null;
  if (explicitSkill !== null && explicitSkill !== undefined && explicitSkill !== '') {
    explicit = byId.get(explicitSkill) ?? null;
    if (explicit === null) {
      problems.push({ code: 'explicit_skill_unknown', message: `no skill named ${JSON.stringify(explicitSkill)} in the catalog` });
    } else {
      return { explicit, shortlist: [explicit], excluded, problems };
    }
  }

  const available = new Set(availableTools);
  const words = new Set(
    String(task ?? '')
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((word) => word.length > 3),
  );

  const scored = [];
  for (const skill of skills) {
    const requires = skill.declared.requires ?? [];
    const missing = requires.filter((name) => available.size > 0 && !available.has(name));
    if (missing.length > 0) {
      excluded.push({ id: skill.id, code: 'missing_capability', detail: `needs ${missing.join(', ')}` });
      continue;
    }
    const haystack = `${skill.id} ${skill.description} ${skill.whenToUse}`.toLowerCase();
    let score = 0;
    for (const word of words) if (haystack.includes(word)) score += 1;
    scored.push({ skill, score });
  }

  scored.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  const shortlistEntries = scored.slice(0, limit).map(({ skill, score }) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    version: skill.version,
    origin: skill.origin,
    digest: skill.digest,
    declared: skill.declared,
    keywordScore: score,
  }));
  return { explicit, shortlist: shortlistEntries, excluded, problems };
}
