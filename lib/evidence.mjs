/**
 * Evidence layer (REQ-03, REQ-05).
 *
 * This module turns a criterion plus a set of observations into one fact:
 * `pass`, `fail`, `unknown` or `not_applicable`. It never asks a model anything,
 * and it never treats the absence of a record as a value.
 *
 * The rules it enforces:
 *   - `exists: null` is unknown, not true (5)
 *   - a completed command without an exit code is not a completed command
 *   - evidence outside the criterion's verification scope does not confirm it
 *   - a stale or unstable observation does not confirm anything
 *   - trust is carried from the observation, never chosen by the caller
 *
 * Honest limitation, stated once here and repeated in the docs: local evidence
 * has `tamperResistance: none`. An agent with write access to the same storage
 * can alter it. Nothing in this file claims otherwise.
 */
import { createHash } from 'node:crypto';

export const EVIDENCE_REASON = Object.freeze({
  artifactExists: 'artifact_exists',
  artifactMissing: 'artifact_missing',
  artifactEmpty: 'artifact_empty',
  digestMatches: 'digest_matches',
  digestMismatch: 'digest_mismatch',
  commandExitMatched: 'command_exit_matched',
  commandExitMismatched: 'command_exit_mismatched',
  commandDidNotComplete: 'command_did_not_complete',
  noObservation: 'no_observation',
  existenceUnknown: 'existence_unknown',
  scopeMismatch: 'evidence_scope_mismatch',
  stale: 'evidence_stale',
  unstable: 'observation_unstable',
  partialCoverage: 'evidence_partial_coverage',
  provenanceUnavailable: 'event_provenance_unavailable',
  unsupportedCheck: 'unsupported_check_type',
});

/**
 * Normalize a path for comparison. Windows compares case-insensitively.
 *
 * `.` and `..` are resolved lexically, without touching the disk. This is not a
 * formality: without it `src/../../etc/passwd` starts with the string `src/` and
 * would pass a naive scope check.
 */
export function normalizePath(p, { caseInsensitive = process.platform === 'win32' } = {}) {
  if (typeof p !== 'string' || p === '') return '';
  let out = p.replace(/\\/g, '/');
  const unc = out.startsWith('//');
  out = out.replace(/\/{2,}/g, '/');
  if (unc) out = `/${out}`;

  const drive = out.match(/^([a-zA-Z]:)(\/|$)/);
  const prefix = drive ? drive[1] : out.startsWith('/') ? '' : '';
  const rest = drive ? out.slice(drive[1].length) : out;
  const segments = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // Popping past the root is refused rather than silently dropped: a path
      // that escapes its own root must not normalize into something allowed.
      if (segments.length === 0) segments.push('..');
      else if (segments[segments.length - 1] === '..') segments.push('..');
      else segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join('/');
  out = drive ? `${prefix}${joined ? `/${joined}` : '/'}` : `${rest.startsWith('/') ? '/' : ''}${joined}`;
  return caseInsensitive ? out.toLowerCase() : out;
}

/** Resolve a possibly relative path against a root, without touching the disk. */
export function joinPath(root, p) {
  if (typeof p !== 'string') return '';
  if (!root) return p;
  if (/^[a-zA-Z]:/.test(p) || p.startsWith('/') || p.startsWith('\\')) return p;
  return `${String(root).replace(/[\\/]+$/, '')}/${p.replace(/^[\\/]+/, '')}`;
}

/**
 * Is `target` inside `scope`? A scope entry may be a file or a directory; a
 * prefix match is only accepted on a path boundary, so `src/a.ts` does not
 * match `src/a.tsx`.
 */
export function isWithinScope(target, scope, options = {}) {
  if (!scope || scope.length === 0) return true;
  const t = normalizePath(target, options);
  if (t === '') return false;
  return scope.some((entry) => {
    const s = normalizePath(entry, options);
    if (s === '') return false;
    return t === s || t.startsWith(`${s}/`);
  });
}

export function digestText(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

export function digestJson(value) {
  return digestText(stableStringify(value));
}

/** Deterministic serialization: key order must not change a digest. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function indexObservations(observations) {
  const byId = new Map();
  const byPath = new Map();
  const commands = [];
  for (const obs of observations ?? []) {
    if (obs?.observationId) byId.set(obs.observationId, obs);
    if (obs?.kind === 'artifact' && typeof obs.path === 'string') {
      const key = normalizePath(obs.path);
      const list = byPath.get(key) ?? [];
      list.push(obs);
      byPath.set(key, list);
    }
    if (obs?.kind === 'command') commands.push(obs);
  }
  return { byId, byPath, commands };
}

/** Latest observation wins when several describe the same thing. */
function latest(list) {
  if (!list || list.length === 0) return null;
  return [...list].sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0) || String(b.capturedAt ?? '').localeCompare(String(a.capturedAt ?? '')))[0];
}

function ageOf(observation, now) {
  if (!observation?.capturedAt) return null;
  const t = Date.parse(observation.capturedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, now - t);
}

/**
 * Freshness of one observation.
 *
 * `null` means "not checked", which is not the same as "fresh". An observation
 * with no timestamp cannot be shown to be current, so it is not fresh — but it is
 * also not stale, and collapsing the two would invent a fact.
 */
export function freshness(observation, now, maxAgeMs) {
  if (maxAgeMs === null || maxAgeMs === undefined) return null;
  const age = ageOf(observation, now);
  if (age === null) return null;
  return age <= maxAgeMs;
}

/**
 * Turn one criterion into a fact.
 *
 * @returns {{criterionId, result, reasonCode, refs, sourceTrust, coverage, fresh, detail}}
 */
export function resolveCriterion(criterion, observations, {
  projectRoot = null,
  now = Date.now(),
  maxAgeMs = null,
  caseInsensitive = process.platform === 'win32',
  binding = null,
} = {}) {
  const scope = [...(criterion.verificationScope ?? [])];
  const pathOptions = { caseInsensitive };

  // An observation produced for a different task or run is not evidence for this
  // one, however well-formed it is. Rejecting it here rather than in the caller
  // keeps the rule in one place and makes it visible in the fact.
  const foreign = [];
  const usable = binding
    ? (observations ?? []).filter((o) => {
        const taskMismatch = binding.taskId != null && o.taskId != null && o.taskId !== binding.taskId;
        const runMismatch = binding.runId != null && o.runId != null && o.runId !== binding.runId;
        if (taskMismatch || runMismatch) {
          foreign.push(o.observationId ?? '(no id)');
          return false;
        }
        return true;
      })
    : observations ?? [];

  const index = indexObservations(usable);

  const base = {
    criterionId: criterion.id,
    refs: [],
    sourceTrust: null,
    coverage: 'unknown',
    fresh: null,
    detail: null,
    foreignRefs: foreign,
    supported: false,
    material: null,
  };

  const explicitRefs = [...(criterion.evidenceRefs ?? [])];
  if (criterion.check?.ref) explicitRefs.push(criterion.check.ref);

  const byRef = explicitRefs.map((id) => index.byId.get(id)).filter(Boolean);
  const check = criterion.check;

  /**
   * What the criterion actually has to look at.
   *
   * A semantic criterion has no deterministic check, so before this existed the
   * judge was asked "is the root cause fixed?" with nothing attached to the
   * question — and its `yes` was recorded as a pass. `supported` is what makes
   * that impossible: no material, no pass, whatever the model says.
   */
  const findSupport = () => {
    if (byRef.length) return latest(byRef);
    for (const locator of scope) {
      const candidates = index.byPath.get(normalizePath(joinPath(projectRoot, locator), pathOptions)) ?? [];
      if (candidates.length) return latest(candidates);
    }
    // A criterion with no reference and no scope may still be about the commands
    // that were run: that is the only remaining thing it can be about.
    if (explicitRefs.length === 0 && scope.length === 0 && index.commands.length) return latest(index.commands);
    return null;
  };

  const describe = (observation) => {
    if (!observation) return null;
    const shared = {
      observationId: observation.observationId ?? null,
      kind: observation.kind ?? null,
      sourceTrust: observation.sourceTrust ?? null,
      declaredSourceTrust: observation.declaredSourceTrust ?? null,
      origin: observation.origin ?? null,
      coverage: observation.coverage ?? 'unknown',
      capturedAt: observation.capturedAt ?? null,
      // Excerpts are carried through verbatim so the judge can read the material
      // it is being asked about. They are wrapped as untrusted by the judge.
      excerpt: typeof observation.excerpt === 'string' ? observation.excerpt : null,
      excerptTruncated: observation.excerptTruncated === true,
    };
    if (observation.kind === 'artifact') {
      return { ...shared, path: observation.path ?? null, bytes: observation.bytes ?? null, sha256: observation.sha256 ?? null };
    }
    return {
      ...shared,
      executable: observation.executable ?? null,
      argv: observation.argv ?? [],
      exit: observation.exit ?? null,
      status: observation.status ?? null,
      stdoutDigest: observation.stdoutDigest ?? null,
      stderrDigest: observation.stderrDigest ?? null,
    };
  };

  if (!check || check.type === undefined) {
    // A semantic criterion has no deterministic check: code cannot decide it. But
    // code CAN say whether there is anything to decide it from, and it does.
    const support = findSupport();
    return {
      ...base,
      result: 'unknown',
      reasonCode: support ? EVIDENCE_REASON.unsupportedCheck : EVIDENCE_REASON.noObservation,
      supported: support !== null,
      material: describe(support),
      refs: support ? [support.observationId] : [],
      sourceTrust: support?.sourceTrust ?? null,
      coverage: support?.coverage ?? 'unknown',
      fresh: support ? freshness(support, now, maxAgeMs) : null,
    };
  }

  // An artifact is found by reference when one was given, and otherwise by the
  // scope the criterion declared: the scope names the file, so it is a legitimate
  // locator. Nothing is guessed beyond that — no reference and no scope means the
  // evidence layer says it has nothing to look at.
  const artifactLocators = [check.ref, ...scope].filter((v) => typeof v === 'string' && v !== '');
  const findArtifact = () => {
    const fromRefs = byRef.filter((o) => o.kind === 'artifact');
    if (fromRefs.length) return latest(fromRefs);
    for (const locator of artifactLocators) {
      const candidates = index.byPath.get(normalizePath(joinPath(projectRoot, locator), pathOptions)) ?? [];
      if (candidates.length) return latest(candidates);
    }
    return null;
  };
  const findCommand = () => {
    const fromRefs = byRef.filter((o) => o.kind === 'command');
    if (fromRefs.length) return latest(fromRefs);
    if (check.ref) return null;
    return latest(index.commands);
  };

  /** Shared post-processing: scope, staleness, coverage and trust. */
  const finish = (result, reasonCode, observation, detail = null) => {
    if (!observation) return { ...base, result: 'unknown', reasonCode, detail };
    const refs = [observation.observationId];
    const coverage = observation.coverage ?? 'unknown';
    const fresh = freshness(observation, now, maxAgeMs);

    // Out-of-scope evidence cannot confirm the criterion it was offered for.
    // Both sides are resolved against the project root first: a scope written as
    // `reports/out.md` and an observation written as an absolute path describe
    // the same file and must compare equal.
    if (scope.length > 0 && observation.kind === 'artifact') {
      const absolute = joinPath(projectRoot, observation.path);
      const scopeAbsolute = scope.map((entry) => joinPath(projectRoot, entry));
      if (!isWithinScope(absolute, scopeAbsolute, pathOptions)) {
        return { ...base, refs, result: 'unknown', reasonCode: EVIDENCE_REASON.scopeMismatch, sourceTrust: observation.sourceTrust ?? null, coverage, fresh };
      }
    }
    if (observation.unstable === true) {
      return { ...base, refs, result: 'unknown', reasonCode: EVIDENCE_REASON.unstable, sourceTrust: observation.sourceTrust ?? null, coverage, fresh };
    }
    if (result === 'pass' && fresh === false) {
      return { ...base, refs, result: 'unknown', reasonCode: EVIDENCE_REASON.stale, sourceTrust: observation.sourceTrust ?? null, coverage, fresh };
    }
    return {
      ...base,
      refs,
      result,
      reasonCode,
      sourceTrust: observation.sourceTrust ?? null,
      coverage,
      fresh,
      detail,
      // A deterministic check that reached a verdict necessarily had something to
      // look at, and that something is what a later semantic question may need.
      supported: true,
      material: describe(observation),
    };
  };

  switch (check.type) {
    case 'artifact_exists': {
      const obs = findArtifact();
      if (!obs) return { ...base, result: 'unknown', reasonCode: EVIDENCE_REASON.noObservation };
      if (obs.existence === null || obs.existence === undefined) {
        return finish('unknown', EVIDENCE_REASON.existenceUnknown, obs);
      }
      return finish(obs.existence === true ? 'pass' : 'fail', obs.existence === true ? EVIDENCE_REASON.artifactExists : EVIDENCE_REASON.artifactMissing, obs);
    }

    case 'artifact_nonempty': {
      const obs = findArtifact();
      if (!obs) return { ...base, result: 'unknown', reasonCode: EVIDENCE_REASON.noObservation };
      if (obs.existence === null || obs.existence === undefined) {
        return finish('unknown', EVIDENCE_REASON.existenceUnknown, obs);
      }
      if (obs.existence === false) return finish('fail', EVIDENCE_REASON.artifactMissing, obs);
      if (!Number.isInteger(obs.bytes)) return finish('unknown', EVIDENCE_REASON.existenceUnknown, obs, 'size was not measured');
      return finish(obs.bytes > 0 ? 'pass' : 'fail', obs.bytes > 0 ? EVIDENCE_REASON.artifactExists : EVIDENCE_REASON.artifactEmpty, obs);
    }

    case 'artifact_digest': {
      const obs = findArtifact();
      if (!obs) return { ...base, result: 'unknown', reasonCode: EVIDENCE_REASON.noObservation };
      if (typeof obs.sha256 !== 'string') return finish('unknown', EVIDENCE_REASON.existenceUnknown, obs, 'no digest was recorded');
      return finish(
        obs.sha256.toLowerCase() === String(check.digest).toLowerCase() ? 'pass' : 'fail',
        obs.sha256.toLowerCase() === String(check.digest).toLowerCase() ? EVIDENCE_REASON.digestMatches : EVIDENCE_REASON.digestMismatch,
        obs,
      );
    }

    case 'command_exit': {
      const obs = findCommand();
      if (!obs) return { ...base, result: 'unknown', reasonCode: EVIDENCE_REASON.noObservation };
      const expected = Number.isInteger(check.expectExit) ? check.expectExit : (Number.isInteger(obs.expectedExit) ? obs.expectedExit : 0);
      if (obs.status !== 'completed') {
        // A command that never completed did not succeed. When the criterion
        // expected a failure, the outcome is simply unknown.
        if (expected === 0) return finish('fail', EVIDENCE_REASON.commandDidNotComplete, obs, `status: ${obs.status}`);
        return finish('unknown', EVIDENCE_REASON.commandDidNotComplete, obs, `status: ${obs.status}`);
      }
      if (!Number.isInteger(obs.exit)) return finish('unknown', EVIDENCE_REASON.commandDidNotComplete, obs, 'no exit code was recorded');
      return finish(
        obs.exit === expected ? 'pass' : 'fail',
        obs.exit === expected ? EVIDENCE_REASON.commandExitMatched : EVIDENCE_REASON.commandExitMismatched,
        obs,
        `exit ${obs.exit}, expected ${expected}`,
      );
    }

    case 'read_after_write': {
      // Provenance lives in the event stream. Without it this stays unknown —
      // an adapter that cannot report reads must not be read as "it read".
      const obs = byRef.find((o) => o.kind === 'artifact' && o.readAfterWrite !== undefined) ?? null;
      if (!obs) return { ...base, result: 'unknown', reasonCode: EVIDENCE_REASON.provenanceUnavailable };
      return finish(obs.readAfterWrite === true ? 'pass' : 'fail', obs.readAfterWrite === true ? 'artifact_exists' : 'artifact_missing', obs);
    }

    default:
      return { ...base, result: 'unknown', reasonCode: EVIDENCE_REASON.unsupportedCheck };
  }
}

/** Resolve every criterion. The result feeds the pure policy unchanged. */
export function resolveCriteria(criteria, observations, options = {}) {
  return (criteria ?? []).map((c) => resolveCriterion(c, observations, options));
}

/** The weakest trust level among the observations that supported a pass. */
export function aggregateTrust(facts) {
  const order = ['self_reported', 'collector_observed', 'harness_observed'];
  const levels = facts.filter((f) => f.result === 'pass').map((f) => order.indexOf(f.sourceTrust ?? 'self_reported'));
  if (levels.length === 0) return 'self_reported';
  return order[Math.min(...levels)];
}
