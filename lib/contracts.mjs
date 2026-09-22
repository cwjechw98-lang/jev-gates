/**
 * Input contracts for jev-gates v2 (REQ-01).
 *
 * Design rules taken from the spec:
 *   - JSON parsing and schema validation are two different stages (5).
 *   - Every violation is reported with a JSON path and a reason code, and never
 *     with the contents of a string field: a path or a token must not end up in
 *     a log just because it failed validation.
 *   - `null`, a string where a number belongs, a negative size, a non-integer
 *     exit code, a duplicate id and an unknown enum are all `invalid_input`.
 *   - A completed command MUST carry a factual exit code. There is no default
 *     for a missing one: absent is not zero (INV-02, 5).
 *   - `exists: null` means unknown and is never read as true.
 *
 * No dependencies: the project promises zero-dependency Node >= 18, and a
 * hand-written validator is auditable in a way a schema library is not.
 */

export const SCHEMA_VERSION = 2;
export const SUPPORTED_VERSIONS = [1, 2];

export const CRITERION_KINDS = ['deterministic', 'semantic'];
export const CHECK_TYPES = [
  'artifact_exists',
  'artifact_nonempty',
  'artifact_digest',
  'command_exit',
  'read_after_write',
];
export const OBSERVATION_KINDS = ['artifact', 'command'];
export const COMMAND_STATUSES = ['completed', 'timeout', 'cancelled', 'signalled', 'unknown'];
export const COVERAGE_LEVELS = ['full', 'partial', 'unknown'];
export const SOURCE_TRUST = ['self_reported', 'collector_observed', 'harness_observed'];
/**
 * How much of a file an observation may carry as material for a semantic
 * criterion. A digest proves a file is unchanged; it says nothing about what the
 * file says, and a semantic question about a digest is unanswerable.
 */
export const MAX_EXCERPT_CHARS = 8192;

/** A validation failure carries where and why, never what the value was. */
export class InputError {
  constructor(code, path, detail) {
    this.code = code;
    this.path = path;
    this.detail = detail;
  }
  toJSON() {
    return { code: this.code, path: this.path, detail: this.detail };
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v) && Number.isFinite(v);

// --- field helpers -----------------------------------------------------------

function requireString(errors, path, v, { required = true, nonEmpty = true, max = 4096 } = {}) {
  if (v === undefined || v === null) {
    if (required) errors.push(new InputError('missing_field', path, 'expected a string'));
    return null;
  }
  if (typeof v !== 'string') {
    errors.push(new InputError('bad_type', path, 'expected a string'));
    return null;
  }
  if (nonEmpty && v.trim() === '') {
    errors.push(new InputError('bad_value', path, 'expected a non-empty string'));
    return null;
  }
  if (v.length > max) {
    errors.push(new InputError('out_of_range', path, `string longer than ${max} characters`));
    return null;
  }
  return v;
}

function requireInt(errors, path, v, { required = true, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (v === undefined || v === null) {
    if (required) errors.push(new InputError('missing_field', path, 'expected an integer'));
    return null;
  }
  if (!isInt(v)) {
    errors.push(new InputError('bad_type', path, 'expected a finite integer'));
    return null;
  }
  if (v < min || v > max) {
    errors.push(new InputError('out_of_range', path, `expected ${min} <= value <= ${max}`));
    return null;
  }
  return v;
}

function requireBool(errors, path, v, { required = true } = {}) {
  if (v === undefined) {
    if (required) errors.push(new InputError('missing_field', path, 'expected a boolean'));
    return null;
  }
  if (typeof v !== 'boolean') {
    errors.push(new InputError('bad_type', path, 'expected a boolean'));
    return null;
  }
  return v;
}

function requireEnum(errors, path, v, allowed, { required = true } = {}) {
  if (v === undefined || v === null) {
    if (required) errors.push(new InputError('missing_field', path, `expected one of: ${allowed.join(', ')}`));
    return null;
  }
  if (typeof v !== 'string' || !allowed.includes(v)) {
    errors.push(new InputError('unknown_enum', path, `expected one of: ${allowed.join(', ')}`));
    return null;
  }
  return v;
}

function requireStringArray(errors, path, v, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) errors.push(new InputError('missing_field', path, 'expected an array of strings'));
    return [];
  }
  if (!Array.isArray(v)) {
    errors.push(new InputError('bad_type', path, 'expected an array of strings'));
    return [];
  }
  const out = [];
  v.forEach((item, i) => {
    const s = requireString(errors, `${path}[${i}]`, item);
    if (s !== null) out.push(s);
  });
  return out;
}

/** Digest fields are hex strings; a wrong shape must not become a comparison. */
function requireDigest(errors, path, v, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) errors.push(new InputError('missing_field', path, 'expected a hex digest'));
    return null;
  }
  if (typeof v !== 'string' || !/^[a-f0-9]{8,128}$/i.test(v)) {
    errors.push(new InputError('bad_value', path, 'expected a hex digest string'));
    return null;
  }
  return v;
}

// --- observations ------------------------------------------------------------

/**
 * One observation. The trust level is assigned by the collection path, not by a
 * field the agent chose: `sourceTrust` is validated against the allowed set and
 * `self_reported` is only ever produced by the legacy adapter.
 */
/**
 * Record that an observation arrived inside the request body.
 *
 * Exported because the rule has to hold at every entry point, not only where the
 * schema runs: `runGate` is a library function too, and a caller that hands it a
 * hand-built request must get the same treatment as one that parsed the JSON.
 * Provenance is a property of the path, so it is applied where the paths merge.
 */
export function markInlineOrigin(obs) {
  const declared = obs.declaredSourceTrust ?? obs.sourceTrust ?? 'self_reported';
  return {
    ...obs,
    sourceTrust: 'self_reported',
    declaredSourceTrust: declared,
    trustDowngraded: declared !== 'self_reported',
    origin: 'inline',
  };
}

export function validateObservation(errors, path, obs, { origin = 'channel' } = {}) {
  if (!isObject(obs)) {
    errors.push(new InputError('bad_type', path, 'expected an observation object'));
    return null;
  }
  const out = {};
  out.observationId = requireString(errors, `${path}.observationId`, obs.observationId);
  out.kind = requireEnum(errors, `${path}.kind`, obs.kind, OBSERVATION_KINDS);
  out.runId = requireString(errors, `${path}.runId`, obs.runId);
  out.taskId = requireString(errors, `${path}.taskId`, obs.taskId);
  out.collectorVersion = requireString(errors, `${path}.collectorVersion`, obs.collectorVersion, { required: false });
  out.sequence = requireInt(errors, `${path}.sequence`, obs.sequence, { required: false, min: 0 });
  out.capturedAt = requireString(errors, `${path}.capturedAt`, obs.capturedAt, { required: false });
  const declaredTrust = requireEnum(errors, `${path}.sourceTrust`, obs.sourceTrust, SOURCE_TRUST);
  // Provenance is a property of the PATH the observation arrived by, never of the
  // field inside it. An observation written into the request body is the claimant
  // speaking about itself, so it is self-reported no matter what it calls itself.
  // Only the out-of-band channel (the collector, the harness adapter) can confer
  // an independent level, because only there is the value produced by the code
  // that did the measuring.
  out.sourceTrust = origin === 'inline' ? 'self_reported' : declaredTrust;
  out.declaredSourceTrust = declaredTrust;
  out.trustDowngraded = origin === 'inline' && declaredTrust !== 'self_reported';
  out.origin = origin;
  out.sourceEventId = obs.sourceEventId === undefined || obs.sourceEventId === null
    ? null
    : requireString(errors, `${path}.sourceEventId`, obs.sourceEventId);
  // Coverage belongs to every observation kind: a command whose output was
  // truncated is partial evidence exactly like a half-read file.
  out.coverage = requireEnum(errors, `${path}.coverage`, obs.coverage, COVERAGE_LEVELS, { required: false });
  out.unstable = requireBool(errors, `${path}.unstable`, obs.unstable, { required: false }) ?? false;
  // An excerpt is the material a semantic criterion is judged against. It is
  // bounded on purpose: an excerpt is evidence for a human or a judge to read,
  // not a copy of the file.
  if (obs.excerpt === undefined || obs.excerpt === null) {
    out.excerpt = null;
    out.excerptTruncated = false;
  } else {
    out.excerpt = requireString(errors, `${path}.excerpt`, obs.excerpt, { required: false, max: MAX_EXCERPT_CHARS });
    out.excerptTruncated = requireBool(errors, `${path}.excerptTruncated`, obs.excerptTruncated, { required: false }) ?? false;
  }

  if (out.kind === 'artifact') {
    out.path = requireString(errors, `${path}.path`, obs.path);
    // existence unknown (null) is allowed and stays null: unknown is not true.
    if (obs.existence === undefined || obs.existence === null) out.existence = null;
    else out.existence = requireBool(errors, `${path}.existence`, obs.existence);
    out.bytes = requireInt(errors, `${path}.bytes`, obs.bytes, { required: false, min: 0 });
    out.sha256 = requireDigest(errors, `${path}.sha256`, obs.sha256);
  } else if (out.kind === 'command') {
    out.toolCallId = requireString(errors, `${path}.toolCallId`, obs.toolCallId, { required: false });
    out.executable = requireString(errors, `${path}.executable`, obs.executable);
    out.argv = requireStringArray(errors, `${path}.argv`, obs.argv);
    out.cwd = requireString(errors, `${path}.cwd`, obs.cwd, { required: false });
    out.status = requireEnum(errors, `${path}.status`, obs.status, COMMAND_STATUSES);
    // A completed command without a factual exit code is not a completed command.
    if (out.status === 'completed') {
      out.exit = requireInt(errors, `${path}.exit`, obs.exit, { required: true, min: -1073741824, max: 1073741824 });
    } else {
      out.exit = requireInt(errors, `${path}.exit`, obs.exit, { required: false, min: -1073741824, max: 1073741824 });
    }
    out.signal = obs.signal === undefined || obs.signal === null ? null : requireString(errors, `${path}.signal`, obs.signal);
    out.stdoutDigest = requireDigest(errors, `${path}.stdoutDigest`, obs.stdoutDigest);
    out.stderrDigest = requireDigest(errors, `${path}.stderrDigest`, obs.stderrDigest);
    out.expectedExit = requireInt(errors, `${path}.expectedExit`, obs.expectedExit, { required: false, min: -1073741824, max: 1073741824 });
    out.scope = requireStringArray(errors, `${path}.scope`, obs.scope);
  }
  return out;
}

// --- criteria ----------------------------------------------------------------

function validateCheck(errors, path, check, kind) {
  if (check === undefined || check === null) {
    if (kind === 'deterministic') {
      errors.push(new InputError('missing_field', path, 'a deterministic criterion needs a check'));
    }
    return null;
  }
  // A criterion cannot be both semantic and deterministically checked.
  //
  // `kind` and `check` select the verification route, and the routes are
  // exclusive: a semantic criterion is decided by a model against resolved
  // material, a deterministic one by code against an observation. When both were
  // supplied the code silently took the deterministic route — `check` present
  // means `evidence.mjs` returns a real `result`, which `decideCompletion`
  // consumes before it ever looks at `kind`. So an author who asked for a
  // semantic judgement got a file-existence check instead, and the declared
  // `kind` was discarded without a word. That is a false pass produced by an
  // ambiguity, which is the failure this product exists to prevent.
  //
  // Rejecting is the honest resolution: the author must say which route they
  // mean. Splitting one criterion into an existence check plus a semantic
  // criterion expresses "the file must exist AND its content must read well",
  // which is what such a specification almost always actually wants.
  if (kind === 'semantic') {
    errors.push(
      new InputError(
        'contradictory_criterion',
        path,
        'a semantic criterion must not carry a check: semantic criteria are decided by the judge, deterministic ones by code. Split it into a deterministic criterion for the check and a semantic criterion for the judgement',
      ),
    );
    return null;
  }
  if (!isObject(check)) {
    errors.push(new InputError('bad_type', path, 'expected a check object'));
    return null;
  }
  const out = {};
  out.type = requireEnum(errors, `${path}.type`, check.type, CHECK_TYPES);
  out.ref = requireString(errors, `${path}.ref`, check.ref, { required: false });
  if (check.expectExit !== undefined && check.expectExit !== null) {
    out.expectExit = requireInt(errors, `${path}.expectExit`, check.expectExit, { min: -1073741824, max: 1073741824 });
  }
  if (check.digest !== undefined && check.digest !== null) {
    out.digest = requireDigest(errors, `${path}.digest`, check.digest, { required: true });
  }
  return out;
}

export function validateCriterion(errors, path, criterion) {
  if (!isObject(criterion)) {
    errors.push(new InputError('bad_type', path, 'expected a criterion object'));
    return null;
  }
  const out = {};
  out.id = requireString(errors, `${path}.id`, criterion.id);
  out.text = requireString(errors, `${path}.text`, criterion.text);
  out.kind = requireEnum(errors, `${path}.kind`, criterion.kind, CRITERION_KINDS);
  out.required = requireBool(errors, `${path}.required`, criterion.required, { required: false });
  if (out.required === null) out.required = true;
  out.verificationScope = requireStringArray(errors, `${path}.verificationScope`, criterion.verificationScope);
  out.evidenceRefs = requireStringArray(errors, `${path}.evidenceRefs`, criterion.evidenceRefs);
  out.check = validateCheck(errors, `${path}.check`, criterion.check, out.kind);
  return out;
}

// --- top level ---------------------------------------------------------------

/**
 * Validate a completion request.
 *
 * Returns `{ ok, mode, value, errors }`. `mode` is `v2` for a current request and
 * `legacy-untrusted` for a v1 claims file: legacy input is accepted so old files
 * still run, but its fields never raise the trust level (5, migration).
 */
export function validateRequest(raw) {
  const errors = [];

  if (!isObject(raw)) {
    errors.push(new InputError('bad_type', '$', 'expected a request object'));
    return { ok: false, mode: null, value: null, errors };
  }

  const version = raw.schemaVersion === undefined ? 1 : raw.schemaVersion;
  if (!isInt(version)) {
    errors.push(new InputError('bad_type', '$.schemaVersion', 'expected an integer'));
    return { ok: false, mode: null, value: null, errors };
  }
  if (!SUPPORTED_VERSIONS.includes(version)) {
    errors.push(new InputError('unsupported_version', '$.schemaVersion', `supported: ${SUPPORTED_VERSIONS.join(', ')}`));
    return { ok: false, mode: null, value: null, errors };
  }

  if (version === 1) {
    return validateLegacy(raw, errors);
  }

  const value = { schemaVersion: SCHEMA_VERSION };
  value.taskId = requireString(errors, '$.taskId', raw.taskId);
  value.runId = requireString(errors, '$.runId', raw.runId);
  value.projectRoot = requireString(errors, '$.projectRoot', raw.projectRoot, { required: false });
  value.planHash = requireDigest(errors, '$.planHash', raw.planHash);
  value.mode = raw.mode === 'consistency' ? 'consistency' : 'completion';

  // criteria: an array is mandatory in v2, and ids must be unique.
  if (raw.criteria === undefined || raw.criteria === null) {
    errors.push(new InputError('missing_field', '$.criteria', 'expected an array of criteria'));
    value.criteria = [];
  } else if (!Array.isArray(raw.criteria)) {
    errors.push(new InputError('bad_type', '$.criteria', 'expected an array of criteria'));
    value.criteria = [];
  } else {
    value.criteria = [];
    const seen = new Set();
    raw.criteria.forEach((c, i) => {
      const parsed = validateCriterion(errors, `$.criteria[${i}]`, c);
      if (!parsed) return;
      if (parsed.id !== null) {
        if (seen.has(parsed.id)) {
          errors.push(new InputError('duplicate_id', `$.criteria[${i}].id`, 'duplicate criterion id'));
        } else {
          seen.add(parsed.id);
        }
      }
      value.criteria.push(parsed);
    });
  }

  // observations: optional inline; the collector usually writes them separately.
  value.observations = [];
  if (raw.observations !== undefined && raw.observations !== null) {
    if (!Array.isArray(raw.observations)) {
      errors.push(new InputError('bad_type', '$.observations', 'expected an array of observations'));
    } else {
      const seen = new Set();
      raw.observations.forEach((o, i) => {
        // Anything inside the request body is inline, and inline evidence cannot
        // confer its own trust level.
        const parsed = validateObservation(errors, `$.observations[${i}]`, o, { origin: 'inline' });
        if (!parsed) return;
        if (parsed.observationId !== null) {
          if (seen.has(parsed.observationId)) {
            errors.push(new InputError('duplicate_id', `$.observations[${i}].observationId`, 'duplicate observation id'));
          } else {
            seen.add(parsed.observationId);
          }
        }
        value.observations.push(parsed);
      });
    }
  }

  // claims are self-reported and never feed a decision; they are carried for the
  // consistency mode and the human-readable report only.
  value.claims = isObject(raw.claims) ? raw.claims : {};

  return { ok: errors.length === 0, mode: 'v2', value, errors };
}

/**
 * v1 claims are accepted but downgraded: every observation they imply is
 * `self_reported`, so the best they can support is consistency, never a
 * confirmation of real execution (INV-08, 5).
 */
function validateLegacy(raw, errors) {
  const value = {
    schemaVersion: 1,
    mode: 'consistency',
    legacy: true,
    taskId: typeof raw.taskId === 'string' && raw.taskId ? raw.taskId : 'legacy-task',
    runId: typeof raw.runId === 'string' && raw.runId ? raw.runId : 'legacy-run',
    projectRoot: typeof raw.projectRoot === 'string' ? raw.projectRoot : null,
    planHash: null,
    criteria: [],
    observations: [],
    claims: {},
  };
  if (raw.task !== undefined && typeof raw.task !== 'string') {
    errors.push(new InputError('bad_type', '$.task', 'expected a string'));
  }
  if (raw.claimed !== undefined && typeof raw.claimed !== 'string') {
    errors.push(new InputError('bad_type', '$.claimed', 'expected a string'));
  }
  const criteria = Array.isArray(raw.criteria) ? raw.criteria : [];
  criteria.forEach((c, i) => {
    const text = typeof c === 'string' ? c : c && typeof c.text === 'string' ? c.text : null;
    if (text === null) {
      errors.push(new InputError('bad_type', `$.criteria[${i}]`, 'expected a string or an object with a text field'));
      return;
    }
    value.criteria.push({
      id: `legacy-${i + 1}`,
      text,
      kind: 'semantic',
      required: true,
      verificationScope: [],
      evidenceRefs: [],
      check: null,
      legacy: true,
    });
  });
  value.claims = {
    task: typeof raw.task === 'string' ? raw.task : null,
    claimed: typeof raw.claimed === 'string' ? raw.claimed : null,
    evidence: isObject(raw.evidence) ? raw.evidence : {},
    evidenceRef: typeof raw.evidence_ref === 'string' ? raw.evidence_ref : null,
  };
  return { ok: errors.length === 0, mode: 'legacy-untrusted', value, errors };
}

/** Parse JSON and validate it, keeping the two failure kinds distinguishable. */
export function parseAndValidate(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      stage: 'parse',
      mode: null,
      value: null,
      errors: [new InputError('invalid_json', '$', error.message.slice(0, 120))],
    };
  }
  const result = validateRequest(raw);
  return { ...result, stage: result.ok ? 'ok' : 'schema' };
}
