/**
 * Transport policy tests (T12).
 *
 * The network is never touched: fetch, the clock and sleep are all injected, so
 * a hung socket, a 429 storm and a deadline all happen in microseconds and the
 * assertions are about the retry policy rather than about the weather.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatus, createTransport, parseRetryAfter, TRANSPORT_CODE } from '../lib/transport.mjs';

/** A fake clock: sleep advances time instead of waiting. */
function fakeClock() {
  let t = 1_000_000;
  const delays = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      delays.push(ms);
      t += ms;
    },
    delays,
  };
}

const okResponse = (body = { ok: true }) => ({
  status: 200,
  headers: { get: () => null },
  json: async () => body,
});

const statusResponse = (status, headers = {}) => ({
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => ({}),
});

function transportWith(responses, options = {}) {
  const clock = fakeClock();
  const calls = [];
  const tx = createTransport({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (typeof next === 'function') return next(calls.length);
      if (next instanceof Error) throw next;
      return next;
    },
    now: clock.now,
    sleep: clock.sleep,
    baseDelayMs: 100,
    ...options,
  });
  return { tx, calls, clock };
}

test('T12: a 408 is retried and can still succeed', async () => {
  const { tx, calls } = transportWith([statusResponse(408), okResponse()]);
  const result = await tx.postJson('https://example.invalid', {});
  assert.equal(result.ok, true);
  assert.equal(result.code, TRANSPORT_CODE.ok);
  assert.equal(calls.length, 2, 'exactly one retry');
});

test('T12: 429 and 529 are retryable, 401 and 422 are not', async () => {
  assert.equal(classifyStatus(429), 'retryable');
  assert.equal(classifyStatus(529), 'retryable');
  assert.equal(classifyStatus(503), 'retryable');
  assert.equal(classifyStatus(401), 'terminal');
  assert.equal(classifyStatus(422), 'terminal');
  assert.equal(classifyStatus(400), 'terminal');
  assert.equal(classifyStatus(200), 'success');

  const unauthorized = transportWith([statusResponse(401)]);
  const first = await unauthorized.tx.postJson('https://example.invalid', {});
  assert.equal(first.ok, false);
  assert.equal(first.code, TRANSPORT_CODE.httpTerminal);
  assert.equal(first.status, 401);
  assert.equal(unauthorized.calls.length, 1, 'a terminal status is not retried');

  const retried = transportWith([statusResponse(429), statusResponse(429), okResponse()]);
  const second = await retried.tx.postJson('https://example.invalid', {});
  assert.equal(second.ok, true);
  assert.equal(retried.calls.length, 3);
});

test('T12: attempts are bounded when the server keeps failing', async () => {
  const { tx, calls } = transportWith([statusResponse(503)], { maxAttempts: 3 });
  const result = await tx.postJson('https://example.invalid', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, TRANSPORT_CODE.retryExhausted);
  assert.equal(result.attempts, 3);
  assert.equal(calls.length, 3, 'no more than maxAttempts requests are made');
});

test('T12: a network error is retried and then reported as a network error', async () => {
  const { tx, calls } = transportWith([new TypeError('fetch failed')], { maxAttempts: 2 });
  const result = await tx.postJson('https://example.invalid', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, TRANSPORT_CODE.networkError);
  assert.equal(calls.length, 2);
});

test('T12: a timeout is its own reason code, not a network error', async () => {
  const abort = new Error('aborted');
  abort.name = 'TimeoutError';
  const { tx } = transportWith([abort], { maxAttempts: 1 });
  const result = await tx.postJson('https://example.invalid', {});
  assert.equal(result.code, TRANSPORT_CODE.timeout);
});

test('T12: the total deadline stops the loop even when the server invites a retry', async () => {
  const { tx, calls, clock } = transportWith([statusResponse(503)], {
    maxAttempts: 10,
    deadlineMs: 1_000,
    baseDelayMs: 600,
  });
  const result = await tx.postJson('https://example.invalid', {});
  assert.equal(result.code, TRANSPORT_CODE.deadlineExceeded);
  assert.ok(calls.length < 10, `the deadline stopped the loop after ${calls.length} attempts`);
  assert.ok(clock.delays.length >= 1);
});

test('T12: Retry-After is honoured but capped', async () => {
  const capped = transportWith([statusResponse(429, { 'retry-after': '3600' }), okResponse()], { retryAfterCapMs: 5_000 });
  await capped.tx.postJson('https://example.invalid', {});
  assert.ok(
    capped.clock.delays[0] <= 5_000,
    `a server asking for an hour must not freeze the caller, waited ${capped.clock.delays[0]}ms`,
  );

  const seconds = transportWith([statusResponse(429, { 'retry-after': '3' }), okResponse()], { retryAfterCapMs: 60_000 });
  await seconds.tx.postJson('https://example.invalid', {});
  assert.ok(seconds.clock.delays[0] >= 3_000, 'a short Retry-After is respected');
});

test('T12: a malformed 200 body is a failure, not a success', async () => {
  const { tx } = transportWith([
    {
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError('unexpected token');
      },
    },
  ]);
  const result = await tx.postJson('https://example.invalid', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, TRANSPORT_CODE.invalidJson);
  assert.equal(result.status, 200);
});

test('Retry-After parsing handles seconds, dates and nonsense', () => {
  const now = Date.parse('2026-09-22T12:00:00.000Z');
  assert.equal(parseRetryAfter('5', now), 5_000);
  assert.equal(parseRetryAfter('Wed, 22 Sep 2026 12:00:10 GMT', now), 10_000);
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter('', now), null);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter('-3', now), null);
});

test('T12: the transport never throws for an HTTP outcome', async () => {
  const { tx } = transportWith([statusResponse(500), new Error('boom'), okResponse()]);
  const result = await tx.postJson('https://example.invalid', {});
  assert.equal(result.ok, true, 'a later success is still a success');
});
