#!/usr/bin/env node
/**
 * Jevals: a regression stand for rubrics. Gates for the questions themselves,
 * not for the work they judge (case 303: a local stand for noul/choice/score
 * with run-to-run comparison).
 *
 * The gate order is fixed and must not be rearranged:
 *   1. known answers      - examples whose answer is known in advance;
 *   2. stability          - the same set in reverse order;
 *   3. instrument control - the same question against a state with the feature REMOVED.
 *
 * If the first gate fails, stability is not computed: a deterministically wrong
 * answer reproduces perfectly, and "100% stable" on it means nothing. This has
 * already happened in practice — 0.006 drift at 100% stability with every answer
 * wrong.
 *
 * A rubric counts as usable only when it passes all three gates.
 *
 * CLI:
 *   node scripts/jev-evals.mjs run fixtures/<name>.json [--target 0.9] [--max-drift 0.15]
 *   node scripts/jev-evals.mjs run fixtures/<name>.json --no-stability --no-control
 *   node scripts/jev-evals.mjs template
 *
 * Exit code: 0 rubric passed, 1 rubric failed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ask } from './jev.mjs';
import { THRESHOLDS, decide, digest, flattenAnswers, logDecision } from './jev-decisions.mjs';

/** Compare one answer against an expectation. The caller sets expectations. */
export function matches(flat, expect) {
  const fails = [];
  for (const [id, want] of Object.entries(expect ?? {})) {
    const got = flat[id];
    if (!got) {
      fails.push(`${id}: no answer`);
      continue;
    }
    if (typeof want.at_least === 'number' && !(got.value >= want.at_least)) {
      fails.push(`${id}: ${got.value} < ${want.at_least}`);
    }
    if (typeof want.at_most === 'number' && !(got.value <= want.at_most)) {
      fails.push(`${id}: ${got.value} > ${want.at_most}`);
    }
    if (want.equals !== undefined && got.value !== want.equals) {
      fails.push(`${id}: "${got.value}" instead of "${want.equals}"`);
    }
  }
  return fails;
}

/** One pass over a case set. The caller sets the order — that is the drift test. */
async function runPass(cases, model) {
  const results = [];
  for (const c of cases) {
    const res = await ask(c.state, c.questions, { model });
    results.push({
      id: c.id,
      flat: flattenAnswers(res.answers),
      model: res.model,
      tokens: res.inputTokens,
      cost: res.costUsd,
    });
  }
  return results;
}

/** A flip is a threshold decision that changed. Probability drift alone is not a verdict. */
function comparePasses(a, b) {
  const byId = new Map(b.map((r) => [r.id, r]));
  let flips = 0;
  let maxDrift = 0;
  const details = [];
  for (const ra of a) {
    const rb = byId.get(ra.id);
    if (!rb) continue;
    for (const id of Object.keys(ra.flat)) {
      const pa = ra.flat[id]?.value;
      const pb = rb.flat[id]?.value;
      if (typeof pa !== 'number' || typeof pb !== 'number') continue;
      const drift = Math.abs(pa - pb);
      maxDrift = Math.max(maxDrift, drift);
      if (decide(pa) !== decide(pb)) {
        flips += 1;
        details.push(`${ra.id}.${id}: ${pa.toFixed(2)} -> ${pb.toFixed(2)}`);
      }
    }
  }
  return { flips, maxDrift, details };
}

function shuffled(list, seed) {
  const a = [...list];
  let s = seed || 1;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const TEMPLATE = {
  name: 'rubric-name',
  model: 'jev-1.13.0',
  target_accuracy: 0.9,
  notes: 'Expectations are set by a human. In control the feature must be REMOVED, otherwise it is not a control.',
  cases: [
    {
      id: 'c1-feature-present',
      state: 'REPLACE: a state in which the feature is certainly present. Code computes the numbers.',
      questions: {
        q: {
          type: 'noul',
          instructions: 'REPLACE: ask so that the answer is known in advance.',
          criteria: { true: 'the situation in which this is yes', false: 'the situation in which this is no' },
        },
      },
      expect: { q: { at_least: 0.8 } },
      control: {
        state: 'REPLACE: the same state with the feature REMOVED.',
        expect: { q: { at_most: 0.2 } },
      },
    },
    {
      id: 'c2-feature-absent',
      state: 'REPLACE: a state without the feature.',
      questions: { q: { type: 'noul', instructions: 'The same question as in c1.' } },
      expect: { q: { at_most: 0.2 } },
    },
  ],
};

// --- CLI ---------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

/** Read a fixture, or report the reason and set a clean exit code. */
function readFixture(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.log(`cannot read fixture ${path}: ${error.message}`);
    process.exitCode = 1;
    return null;
  }
}

if (isMain) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'run';
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    return v && !v.startsWith('--') ? v : true;
  };
  const has = (n) => argv.includes(`--${n}`);

  if (cmd === 'template') {
    console.log(JSON.stringify(TEMPLATE, null, 2));
  } else if (cmd === 'run') {
    const path = argv[1];
    let fx = null;
    if (!path || path.startsWith('--')) {
      console.log('need a fixture file: node scripts/jev-evals.mjs run fixtures/<name>.json');
      process.exitCode = 1;
    } else if (!(fx = readFixture(path))) {
      // readFixture already reported the reason and set the exit code
    } else {
      const model = flag('model') ?? fx.model ?? 'jev-1.13.0';
      const target = Number(flag('target') ?? fx.target_accuracy ?? 0.9);
      const maxDrift = Number(flag('max-drift') ?? 0.2);
      const cases = fx.cases ?? [];
      if (!cases.length) {
        console.log('the fixture has no cases');
        process.exitCode = 1;
      } else {
        const total = cases.length;
        console.log(`rubric: ${fx.name ?? '(unnamed)'}, cases: ${total}, model: ${model}`);
        console.log(`gates: accuracy >= ${target}, drift <= ${maxDrift}, stability and control when data exists\n`);

        // -- Gate 1: known answers ------------------------------------------
        const pass1 = await runPass(cases, model);
        let ok = 0;
        const failures = [];
        for (let i = 0; i < cases.length; i += 1) {
          const fails = matches(pass1[i].flat, cases[i].expect);
          if (fails.length) failures.push(`${cases[i].id}: ${fails.join('; ')}`);
          else ok += 1;
        }
        const accuracy = ok / total;
        console.log(`1. known answers: ${ok}/${total} = ${(accuracy * 100).toFixed(0)}%`);
        for (const f of failures) console.log(`   x ${f}`);

        let stability = null;
        let control = null;

        if (accuracy < target) {
          console.log('\nGATE FAILED at the first step.');
          console.log('Stability and control are not computed: a deterministically wrong answer');
          console.log('reproduces perfectly, so "stable" would mean nothing here.');
          console.log('Fix the rubric or the state representation — do not re-run and hope.');
        } else {
          // -- Gate 2: stability --------------------------------------------
          if (has('no-stability')) {
            console.log('2. stability: skipped (--no-stability)');
          } else {
            const order = has('shuffle') ? shuffled(cases, Number(flag('seed') ?? 1)) : [...cases].reverse();
            const pass2 = await runPass(order, model);
            stability = comparePasses(pass1, pass2);
            console.log(
              `2. stability (${has('shuffle') ? 'shuffled' : 'reverse order'}): ` +
                `flips ${stability.flips}, max drift ${stability.maxDrift.toFixed(3)}`,
            );
            for (const d of stability.details.slice(0, 10)) console.log(`   x ${d}`);
            if (stability.flips !== 0 || stability.maxDrift > maxDrift) {
              console.log('   a verdict near the threshold must not be taken from a single run');
            }
          }

          // -- Gate 3: instrument control -----------------------------------
          const controls = cases.filter((c) => c.control);
          if (has('no-control') || !controls.length) {
            console.log(`3. instrument control: ${controls.length ? 'skipped (--no-control)' : 'no control in the fixture'}`);
            if (!controls.length) console.log('   without a control, narrow probabilities prove nothing');
          } else {
            let cOk = 0;
            const cFails = [];
            for (const c of controls) {
              const res = await ask(c.control.state, c.questions, { model });
              const flat = flattenAnswers(res.answers);
              const fails = matches(flat, c.control.expect);
              if (fails.length) cFails.push(`${c.id}: ${fails.join('; ')}`);
              else cOk += 1;
            }
            control = { passed: cOk, total: controls.length };
            console.log(`3. instrument control (feature removed): ${cOk}/${controls.length}`);
            for (const f of cFails) console.log(`   x ${f}`);
            if (cOk < controls.length) console.log('   the instrument does not separate the feature — do not trust the rubric');
          }
        }

        const allCost = pass1.reduce((s, r) => s + (r.cost ?? 0), 0);
        const allTokens = pass1.reduce((s, r) => s + (r.tokens ?? 0), 0);
        console.log(`\nmain pass cost: ${allTokens} tokens, $${allCost.toFixed(6)}`);

        const passed =
          accuracy >= target &&
          (!stability || (stability.flips === 0 && stability.maxDrift <= maxDrift)) &&
          (!control || control.passed === control.total);
        console.log(passed ? '\nRUBRIC PASSED ALL GATES' : '\nRUBRIC FAILED');

        logDecision({
          kind: 'evals',
          label: fx.name ?? 'unnamed',
          model: pass1[0]?.model ?? model,
          verdict: passed ? 'ok' : 'wrong',
          target,
          accuracy: Number(accuracy.toFixed(3)),
          failures,
          stability,
          control,
          thresholds: THRESHOLDS,
          fixtureDigest: digest(JSON.stringify(fx.cases.map((c) => c.state))),
          answers: Object.fromEntries(pass1.map((r) => [r.id, r.flat])),
          inputTokens: allTokens,
          costUsd: Number(allCost.toFixed(6)),
        });

        process.exitCode = passed ? 0 : 1;
      }
    }
  } else {
    console.log('commands: run <fixtures.json> | template');
  }
}
