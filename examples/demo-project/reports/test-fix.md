# Fix report: `src/a.test.ts` timeouts

## Symptom

`npx vitest run src/a.test.ts` failed on `renders the empty state` with a 5 s timeout.
The assertion itself was never reached.

## Cause

`src/a.ts` awaited `loadConfig()` inside the render path. `loadConfig()` reads the
environment once and caches the result, but the cache was keyed on `process.pid`,
so every worker in the pool missed it and re-read the environment on the first
render. Under the test pool that read competed with the fixture setup and the
first render exceeded the timeout.

The timeout was a symptom: the assertion was slow because the render was slow,
and the render was slow because a per-process cache was being used as a
per-worker cache.

## Change

`src/a.ts` now resolves the configuration once at module load and passes it down,
instead of calling `loadConfig()` from inside `render()`. The cache key is gone
because there is no longer a cache to key.

## Verification

`npx vitest run src/a.test.ts` passes, 14 tests, 0 failures, 1.2 s.
