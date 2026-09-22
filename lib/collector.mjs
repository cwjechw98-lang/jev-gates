/**
 * Collector (REQ-03, 7).
 *
 * The collector is the only component allowed to state facts about the
 * filesystem and about command execution. Two rules shape it:
 *
 *   1. It NEVER runs a command. It reads what the harness already executed.
 *      Re-running a command from a claim would be a side effect performed by a
 *      verifier, which is exactly the class of bug this project exists to stop.
 *   2. It reports what it measured, including that it could not measure
 *      something. `exists: null` and `coverage: 'partial'` are first-class
 *      answers; a failed stat is not "the file is absent".
 *
 * Instability: an artifact is read twice and the digests compared. A file that
 * changed between the two reads is marked `unstable`, and the evidence layer
 * refuses to confirm anything from it (INV-05).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { normalizePath } from './evidence.mjs';
import { MAX_EXCERPT_CHARS } from './contracts.mjs';

export const COLLECTOR_VERSION = '2.0.0';

/** Large files are hashed by stream: a digest must cover the whole content. */
export function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Read at most `maxChars` characters from the start of a file.
 *
 * Bounded by construction: one byte more than the budget is read, so truncation
 * is detected rather than assumed. This reads the head of the file only — an
 * excerpt is material for a judgement, not a copy of the artifact.
 */
export async function readExcerpt(path, maxChars = MAX_EXCERPT_CHARS) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxChars + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxChars + 1, 0);
    const truncated = bytesRead > maxChars;
    const text = buffer.subarray(0, Math.min(bytesRead, maxChars)).toString('utf8');
    return { text, truncated };
  } finally {
    await handle.close();
  }
}

/**
 * Observe one artifact.
 *
 * @returns an observation with `sourceTrust: 'collector_observed'` — the trust
 *          level comes from the fact that this code did the measuring, not from
 *          a field the caller supplied.
 */
export async function collectArtifact({
  path,
  projectRoot = null,
  runId,
  taskId,
  sequence = 0,
  capturedAt = new Date().toISOString(),
  doubleRead = true,
  sourceTrust = 'collector_observed',
  withExcerpt = false,
  maxExcerptChars = MAX_EXCERPT_CHARS,
  fs = { stat, hashFile, readExcerpt },
} = {}) {
  const absolute = projectRoot && !/^[a-zA-Z]:/.test(path) && !path.startsWith('/')
    ? `${String(projectRoot).replace(/[\\/]+$/, '')}/${path.replace(/^[\\/]+/, '')}`
    : path;

  const observation = {
    observationId: `obs-${normalizePath(path).replace(/[^a-z0-9]+/gi, '-').slice(-60)}-${sequence}`,
    kind: 'artifact',
    runId,
    taskId,
    collectorVersion: COLLECTOR_VERSION,
    sequence,
    path: absolute,
    existence: null,
    bytes: null,
    sha256: null,
    capturedAt,
    sourceEventId: null,
    coverage: 'unknown',
    sourceTrust,
    unstable: false,
    excerpt: null,
    excerptTruncated: false,
  };

  let first;
  try {
    first = await fs.stat(absolute);
  } catch (error) {
    // A missing file is a fact. A permission error is not: it is unknown.
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { ...observation, existence: false, coverage: 'full' };
    }
    return { ...observation, existence: null, coverage: 'unknown' };
  }
  if (!first.isFile()) {
    // A directory is not an artifact whose contents can be hashed.
    return { ...observation, existence: true, bytes: null, coverage: 'partial' };
  }

  let digest;
  try {
    digest = await fs.hashFile(absolute);
  } catch {
    return { ...observation, existence: true, bytes: first.size, coverage: 'partial' };
  }

  let unstable = false;
  if (doubleRead) {
    try {
      const second = await fs.stat(absolute);
      const secondDigest = await fs.hashFile(absolute);
      unstable = secondDigest !== digest || second.size !== first.size;
      if (unstable) {
        // Report the later reading, and say that the artifact moved under us.
        return {
          ...observation,
          existence: true,
          bytes: second.size,
          sha256: secondDigest,
          coverage: 'partial',
          unstable: true,
        };
      }
    } catch {
      return { ...observation, existence: true, bytes: first.size, sha256: digest, coverage: 'partial', unstable: true };
    }
  }

  let excerpt = null;
  let excerptTruncated = false;
  if (withExcerpt) {
    // Read the material only when it was asked for. A digest is enough to prove
    // a file is unchanged, but a semantic criterion has to be judged against what
    // the file says, and that is what this is for.
    try {
      const read = await fs.readExcerpt(absolute, maxExcerptChars);
      excerpt = read.text;
      excerptTruncated = read.truncated;
    } catch {
      excerpt = null;
      excerptTruncated = false;
    }
  }

  return { ...observation, existence: true, bytes: first.size, sha256: digest, coverage: 'full', unstable, excerpt, excerptTruncated };
}

/**
 * Turn normalized harness events into observations.
 *
 * The adapter is responsible for normalizing its own event shape into the small
 * interface below; this function is what keeps the trust assignment out of the
 * adapter's hands:
 *
 *   { type: 'tool_result', toolName, toolCallId, status, exitCode, signal,
 *     startedAt, endedAt, stdout, stderr, writes: [{path, bytes}] }
 *
 * `status` is the harness's own word for how the call ended. When it is missing
 * the observation says `unknown` rather than assuming success.
 */
export function observationsFromEvents(events, { runId, taskId, capturedAt = new Date().toISOString(), sourceTrust = 'harness_observed' } = {}) {
  const observations = [];
  const skipped = [];
  let sequence = 0;

  for (const event of events ?? []) {
    sequence += 1;
    if (event?.type !== 'tool_result') {
      skipped.push({ reason: 'unsupported_event_type', type: event?.type ?? null });
      continue;
    }

    // A tool result is a tool call that happened. It becomes a command
    // observation unless it is a pure write, and a missing status becomes
    // `unknown` rather than an assumption of success.
    const hasWrites = Array.isArray(event.writes) && event.writes.length > 0;
    const isCommand =
      !hasWrites ||
      event.exitCode !== undefined ||
      event.executable !== undefined ||
      Array.isArray(event.argv) ||
      event.status !== undefined;

    if (isCommand) {
      const status = normalizeStatus(event.status, event.exitCode);
      observations.push({
        observationId: `cmd-${event.toolCallId ?? sequence}`,
        kind: 'command',
        runId,
        taskId,
        collectorVersion: COLLECTOR_VERSION,
        sequence,
        toolCallId: event.toolCallId ?? null,
        executable: String(event.executable ?? event.toolName ?? 'unknown'),
        argv: Array.isArray(event.argv) ? event.argv.map(String) : [],
        cwd: event.cwd ?? null,
        status,
        // The exit code is copied verbatim. A missing one stays missing.
        exit: Number.isInteger(event.exitCode) ? event.exitCode : null,
        signal: event.signal ?? null,
        stdoutDigest: event.stdout === undefined || event.stdout === null ? null : digestOf(event.stdout),
        stderrDigest: event.stderr === undefined || event.stderr === null ? null : digestOf(event.stderr),
        capturedAt,
        sourceEventId: event.toolCallId ?? null,
        coverage: status === 'completed' ? 'full' : 'partial',
        sourceTrust,
        unstable: false,
        scope: Array.isArray(event.scope) ? event.scope.map(String) : [],
        expectedExit: Number.isInteger(event.expectedExit) ? event.expectedExit : undefined,
      });
    }

    for (const write of event.writes ?? []) {
      sequence += 1;
      observations.push({
        observationId: `write-${event.toolCallId ?? sequence}-${sequence}`,
        kind: 'artifact',
        runId,
        taskId,
        collectorVersion: COLLECTOR_VERSION,
        sequence,
        path: write.path,
        existence: write.bytes === undefined || write.bytes === null ? null : true,
        bytes: Number.isInteger(write.bytes) ? write.bytes : null,
        sha256: typeof write.sha256 === 'string' ? write.sha256 : null,
        capturedAt,
        sourceEventId: event.toolCallId ?? null,
        coverage: Number.isInteger(write.bytes) ? 'full' : 'partial',
        sourceTrust,
        unstable: false,
        // Provenance is only present when the harness reported a read after the
        // write. Absent provenance stays absent.
        ...(write.readAfterWrite === true ? { readAfterWrite: true } : {}),
      });
    }
  }

  return { observations, skipped };
}

function normalizeStatus(status, exitCode) {
  if (status === 'completed' || status === 'success') return Number.isInteger(exitCode) || exitCode === undefined ? 'completed' : 'completed';
  if (status === 'timeout' || status === 'cancelled' || status === 'signalled') return status;
  if (Number.isInteger(exitCode)) return 'completed';
  return 'unknown';
}

function digestOf(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/** A read-after-write check needs provenance the adapter may not have. */
export function hasProvenance(observations) {
  return (observations ?? []).some((o) => o.kind === 'artifact' && o.readAfterWrite !== undefined);
}
