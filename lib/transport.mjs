/**
 * Transport seam (REQ-04, 8.3).
 *
 * Why a seam rather than a `fetch` call inside the client: the offline lane has
 * to exercise the retry policy, the deadline and the error classification
 * without a network. The fetch implementation, the clock and the sleep function
 * are all injected, so a test can drive a 429, a 503 and a hung socket in
 * microseconds and assert exactly how many attempts happened.
 *
 * Rules encoded here:
 *   - retryable: 408, 425, 429 and 5xx including 529; network errors; timeouts
 *   - terminal: every other 4xx, a malformed body, a schema failure
 *   - attempts and total time are both bounded, and a deadline stops the loop
 *     even when the server keeps inviting another try
 *   - Retry-After is honoured, but capped: a server asking for an hour does not
 *     get to freeze the caller
 */

export const RETRYABLE_STATUS = Object.freeze([408, 425, 429, 500, 502, 503, 504, 505, 507, 508, 510, 529]);
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_DEADLINE_MS = 20_000;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRY_AFTER_CAP_MS = 5_000;
export const DEFAULT_BASE_DELAY_MS = 250;

export const TRANSPORT_CODE = Object.freeze({
  ok: 'ok',
  httpTerminal: 'http_terminal',
  retryExhausted: 'retry_exhausted',
  networkError: 'network_error',
  timeout: 'timeout',
  deadlineExceeded: 'deadline_exceeded',
  invalidJson: 'invalid_json',
});

export function classifyStatus(status) {
  if (status >= 200 && status < 300) return 'success';
  if (RETRYABLE_STATUS.includes(status)) return 'retryable';
  return 'terminal';
}

/** `Retry-After` is seconds or an HTTP date. Anything unparseable is ignored. */
export function parseRetryAfter(headerValue, nowMs = Date.now()) {
  if (headerValue === undefined || headerValue === null || headerValue === '') return null;
  const text = String(headerValue).trim();
  if (/^\d+$/.test(text)) {
    const ms = Number(text) * 1000;
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  }
  const date = Date.parse(text);
  // Only a real HTTP date is considered. Without this shape check `Date.parse`
  // accepts things like "-3" as a year and returns a nonsense delay.
  if (!/^[A-Za-z]{3},\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+[A-Za-z]{3}$/.test(text)) return null;
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

/**
 * Build a transport with injected primitives.
 *
 * @param {object} options
 * @param {Function} [options.fetchImpl] fetch-compatible function
 * @param {Function} [options.now] returns epoch milliseconds
 * @param {Function} [options.sleep] awaits a delay in milliseconds
 */
export function createTransport({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  deadlineMs = DEFAULT_DEADLINE_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryAfterCapMs = DEFAULT_RETRY_AFTER_CAP_MS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  jitter = 0,
  random = Math.random,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createTransport needs a fetch implementation');
  }

  /** One POST with retries, deadline and classification. Never throws for HTTP. */
  async function postJson(url, body, { headers = {}, signal = null } = {}) {
    const startedAt = now();
    const deadlineAt = startedAt + deadlineMs;
    let attempts = 0;
    let lastCode = TRANSPORT_CODE.networkError;
    let lastStatus = null;

    while (attempts < maxAttempts) {
      const elapsed = now() - startedAt;
      if (elapsed >= deadlineMs) {
        return { ok: false, code: TRANSPORT_CODE.deadlineExceeded, attempts, durationMs: elapsed, status: lastStatus };
      }
      attempts += 1;

      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: typeof body === 'string' ? body : JSON.stringify(body),
          signal: signal ?? AbortSignal.timeout(Math.min(timeoutMs, deadlineAt - now())),
        });
      } catch (error) {
        lastCode = error?.name === 'TimeoutError' || error?.name === 'AbortError'
          ? TRANSPORT_CODE.timeout
          : TRANSPORT_CODE.networkError;
        if (attempts >= maxAttempts) break;
        await backoff(sleep, attempts, baseDelayMs, jitter, random, null, retryAfterCapMs);
        continue;
      }

      lastStatus = response.status;
      const kind = classifyStatus(response.status);

      if (kind === 'success') {
        let json;
        try {
          json = await response.json();
        } catch {
          return { ok: false, code: TRANSPORT_CODE.invalidJson, attempts, durationMs: now() - startedAt, status: response.status };
        }
        return { ok: true, code: TRANSPORT_CODE.ok, json, status: response.status, attempts, durationMs: now() - startedAt };
      }

      if (kind === 'terminal') {
        return { ok: false, code: TRANSPORT_CODE.httpTerminal, status: response.status, attempts, durationMs: now() - startedAt };
      }

      lastCode = TRANSPORT_CODE.retryExhausted;
      if (attempts >= maxAttempts) break;
      const retryAfter = parseRetryAfter(response.headers?.get?.('retry-after'), now());
      await backoff(sleep, attempts, baseDelayMs, jitter, random, retryAfter, retryAfterCapMs);
    }

    return {
      ok: false,
      code: lastCode,
      status: lastStatus,
      attempts,
      durationMs: now() - startedAt,
    };
  }

  return { postJson, config: { maxAttempts, deadlineMs, timeoutMs, retryAfterCapMs, baseDelayMs } };
}

/** Exponential backoff with optional jitter, and a cap on a server's request. */
async function backoff(sleep, attempt, baseDelayMs, jitter, random, retryAfterMs, capMs) {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const withJitter = jitter > 0 ? exponential * (1 - jitter + random() * jitter * 2) : exponential;
  const requested = retryAfterMs === null || retryAfterMs === undefined ? withJitter : Math.min(retryAfterMs, capMs);
  const delay = Math.max(withJitter, requested);
  if (delay > 0) await sleep(delay);
}
