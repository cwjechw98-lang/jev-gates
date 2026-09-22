/**
 * Network guard for the offline lane (T24).
 *
 * Loaded with `node --import` in front of a CLI run. Any attempt to open a
 * socket is recorded in the canary file named by `JEV_NET_CANARY` and then
 * refused, so the test can assert that the offline lane made *zero* attempts
 * rather than merely failing fast.
 *
 * Harmless when executed as a test file: it only installs the guards.
 */
import { appendFileSync } from 'node:fs';

const canary = process.env.JEV_NET_CANARY;
const note = (api) => {
  try {
    if (canary) appendFileSync(canary, `${api}\n`);
  } catch {
    /* the canary is best-effort: it must not become a second failure mode */
  }
};

const refuse = (api) => {
  const error = new Error(`network disabled by the offline test lane (${api})`);
  error.code = 'JEV_NETWORK_DISABLED';
  return error;
};

globalThis.fetch = async (...args) => {
  note('fetch');
  throw refuse(`fetch ${String(args[0]).slice(0, 60)}`);
};

for (const moduleName of ['node:net', 'node:tls', 'node:http', 'node:https', 'node:dns']) {
  try {
    const mod = await import(moduleName);
    const target = mod.default ?? mod;
    if (typeof target.connect === 'function') {
      const original = target.connect;
      target.connect = (...args) => {
        note(`${moduleName}.connect`);
        throw refuse(moduleName);
      };
      target.connect.__original = original;
    }
    if (typeof target.request === 'function') {
      target.request = (...args) => {
        note(`${moduleName}.request`);
        throw refuse(moduleName);
      };
    }
    if (typeof target.lookup === 'function' && moduleName === 'node:dns') {
      target.lookup = (...args) => {
        note(`${moduleName}.lookup`);
        throw refuse(moduleName);
      };
    }
  } catch {
    /* a module that cannot be patched is not a reason to fail the run */
  }
}
