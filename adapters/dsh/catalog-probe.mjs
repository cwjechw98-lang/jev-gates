/**
 * Report the harness's own tool catalog — the **global** view.
 *
 * This exists because "the tool is registered" is a claim about the *catalog the
 * model sees*, not about a function existing in a module. A plugin can export a
 * perfect `apply` and still contribute nothing — a failed row, a wrong `inject`,
 * a registration that threw — and no unit test can tell the difference. The only
 * honest check is to boot the harness and read what it ended up with.
 *
 * **Its limit, measured rather than assumed.** Tool definitions are visible per
 * agent scope: `schemas(scope?)` and `get(name, scope?)` take the viewing agent,
 * and omitting the scope gives the global view. A bare `probe` boot creates no
 * agent, so this probe reports an empty catalog — and not only of our tools:
 * `get('pwsh')` and `get('read')` are `undefined` too. That emptiness is the
 * instrument, not the product, and it is why this file cannot by itself prove
 * the six tools reach a model.
 *
 * The authoritative catalog check therefore lives in the agent lane:
 * `adapters/dsh/agent-scenarios.mjs` reads `ctx.tools.schemas(agent)` inside
 * `agent/created`, driven by `scripts/jev-agent-acceptance.mjs`. This probe
 * remains useful for the global view and for confirming that a boot reaches the
 * point where services resolve at all.
 *
 * It is a separate row from the tools it observes, so the probe cannot be the
 * thing under test, and it declares `loader` so it can wait until every row has
 * finished mounting. Without that wait it would race the registration it is
 * meant to verify.
 */
import { writeFileSync } from 'node:fs';

/** Plugin name, as the loader reports it. */
export const name = 'jev-catalog-probe';

/** `loader` is what makes the wait below possible. */
export const inject = ['tools', 'loader'];

/** The tools the product promises. A missing one is a delivery failure, not a warning. */
const EXPECTED = [
  'jev_verify_completion',
  'jev_route_skill',
  'jev_check_progress',
  'jev_review_scope',
  'jev_context_plan',
  'jev_diagnose',
];

/**
 * @param {object} ctx - the Cordis context.
 */
export function apply(ctx) {
  const out = process.env.JEV_CATALOG_OUT ?? null;

  // The whole body runs inside `ctx.effect`, and that is not a style choice.
  // A Cordis service accessor is context-bound: `ctx.tools` resolves against the
  // fiber that is currently active. A detached promise chain — `Promise.resolve()
  // .then(...)`, or any await that leaves the effect — runs with no active fiber,
  // and `ctx.tools` then throws `cannot get required service "tools" in inactive
  // context`. `ctx.effect` keeps the fiber active across awaits, so the service
  // stays reachable. Getting this wrong looks exactly like a missing service.
  ctx.effect(async () => {
    let payload;
    try {
      await ctx.loader?.await?.();
      // One more turn of the event loop: `await()` resolves when the loader is
      // done, and a row that registered in its own microtask may still be settling.
      await new Promise((resolve) => setTimeout(resolve, 250));

      const schemas = ctx.tools.schemas();
      const names = (schemas ?? []).map((schema) => schema?.name).filter((n) => typeof n === 'string');
      const present = EXPECTED.filter((n) => names.includes(n));
      const missing = EXPECTED.filter((n) => !names.includes(n));
      // Descriptions are checked too: a tool the model cannot understand is
      // registered but not usable, and that distinction is worth recording.
      const described = (schemas ?? [])
        .filter((schema) => EXPECTED.includes(schema?.name))
        .filter((schema) => typeof schema.description === 'string' && schema.description.length > 40)
        .map((schema) => schema.name);
      const withParameters = (schemas ?? [])
        .filter((schema) => EXPECTED.includes(schema?.name))
        .filter((schema) => schema?.parameters?.type === 'object')
        .map((schema) => schema.name);

      payload = {
        catalogSize: names.length,
        expected: EXPECTED,
        present,
        missing,
        described,
        withParameters,
        allPresent: missing.length === 0,
        allDescribed: described.length === EXPECTED.length,
        allWithParameters: withParameters.length === EXPECTED.length,
        sample: names.slice(0, 40),
      };
    } catch (error) {
      payload = { error: String(error?.message ?? error), stack: String(error?.stack ?? '').split('\n').slice(0, 6) };
    }
    if (out) writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
    process.exit(0);
  });
}
