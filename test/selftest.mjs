/**
 * Self-test: runs with no API key and no network. It covers the parts that must
 * work offline — the deterministic gate, the evidence collector, the CLI
 * contract and the fail-open path. The model-backed paths are exercised by the
 * fixtures in fixtures/ (see README, "Verify it works").
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gate } from '../scripts/jev-gateway.mjs';
import { buildState, buildQuestions, verdictOf } from '../scripts/jev-gate.mjs';
import { decide } from '../scripts/jev-decisions.mjs';
import { matches } from '../scripts/jev-evals.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const script = (name) => join(ROOT, 'scripts', name);

/** Run a CLI script and capture exit code + output, whatever the exit code is. */
function run(file, args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [script(file), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'jev-gates-'));

// --- approval gate: the rule table -------------------------------------------

test('approval gate: a public irreversible action asks for a human', () => {
  const r = gate({ action: 'push_public', external: true, public: true, reversible: false });
  assert.equal(r.verdict, 'human');
  assert.ok(r.reasons.some((x) => x.startsWith('public_irreversible')));
});

test('approval gate: a local reversible edit passes', () => {
  const r = gate({ action: 'edit_readme', reversible: true });
  assert.equal(r.verdict, 'allow');
  assert.deepEqual(r.reasons, []);
});

test('approval gate: an undeclared action asks for a human', () => {
  assert.equal(gate({}).verdict, 'human');
});

test('approval gate: a credential leaving the machine asks for a human', () => {
  const r = gate({ action: 'send_token', credential: true, external: true, reversible: true });
  assert.equal(r.verdict, 'human');
  assert.ok(r.reasons.some((x) => x.startsWith('credential_out')));
});

test('approval gate: reversible is assumed unless irreversibility is declared', () => {
  assert.equal(gate({ action: 'rm_tmp', destructive: true }).verdict, 'allow');
  assert.equal(gate({ action: 'rm_tmp', destructive: true, reversible: false }).verdict, 'human');
});

// --- approval gate: the CLI contract -----------------------------------------

test('CLI: exit 2 for a human, exit 0 for a go', () => {
  const human = run('jev-gateway.mjs', ['--action', 'push_public', '--public', '--reversible=false']);
  assert.equal(human.code, 2);
  assert.match(human.out, /ASK A HUMAN/);

  const go = run('jev-gateway.mjs', ['--action', 'edit_readme', '--reversible=true', '--quiet']);
  assert.equal(go.code, 0);
  assert.equal(JSON.parse(go.out).verdict, 'allow');
});

test('CLI: the approval gate reads JSON from stdin', () => {
  const r = run('jev-gateway.mjs', ['--quiet'], {});
  assert.equal(r.code, 2, 'no arguments and no stdin means the action is undeclared');
});

// --- completion gate: evidence collection ------------------------------------

test('evidence is computed by code, not by a model', () => {
  const { state, stats } = buildState({
    task: 't',
    criteria: ['a', 'b'],
    evidence: {
      writes: [
        { path: 'a.ts', bytes: 10, read_after: true },
        { path: 'b.ts', bytes: 5, read_after: false },
      ],
      commands: [
        { cmd: 'ok', exit: 0, expect_exit: 0 },
        { cmd: 'expected-failure', exit: 2, expect_exit: 2 },
        { cmd: 'mismatch', exit: 1, expect_exit: 0 },
      ],
      artifacts: [
        { path: 'r.md', bytes: 3, exists: true },
        { path: 'empty.md', bytes: 0, exists: true },
      ],
    },
  });
  assert.equal(stats.writes, 2);
  assert.equal(stats.writesRead, 1);
  assert.equal(stats.commands, 3);
  assert.equal(stats.cmdsOk, 2, 'a non-zero exit code is fine when it is the expected one');
  assert.equal(stats.artsOk, 1);
  assert.match(state, /read AFTER the last write: 1 of 2/);
  assert.match(state, /\(MISMATCH\)/);
});

test('one question per criterion, each describing a situation', () => {
  const q = buildQuestions(['the test passes']);
  assert.equal(Object.keys(q).length, 4);
  assert.equal(q.criterion_1.type, 'noul');
  assert.ok(q.criterion_1.criteria.true.includes('directly closes'));
});

test('verdict: three outcomes plus unverified', () => {
  const applicable = ['a', 'b'];
  assert.equal(verdictOf({ a: { value: 0.95 }, b: { value: 0.9 } }, applicable).verdict, 'done');
  assert.equal(verdictOf({ a: { value: 0.95 }, b: { value: 0.05 } }, applicable).verdict, 'not_done');
  assert.equal(verdictOf({ a: { value: 0.95 }, b: { value: 0.5 } }, applicable).verdict, 'review');
  assert.equal(verdictOf({ a: { value: 0.95 } }, applicable).verdict, 'unverified');
  assert.equal(decide(0.8), 'yes');
  assert.equal(decide(0.2), 'no');
  assert.equal(decide(0.5), 'review');
});

test('CLI: --dry prints state and questions without calling the model', () => {
  const r = run('jev-gate.mjs', ['--claims', join(ROOT, 'examples', 'claims.example.json'), '--dry']);
  assert.equal(r.code, 0);
  assert.match(r.out, /EVIDENCE - COMPUTED BY CODE/);
  assert.match(r.out, /read AFTER the last write: 1 of 1/);
  assert.match(r.out, /exit code matched the expected one: 3/);
});

test('CLI: no evidence at all is exit 3, not "done"', () => {
  const file = join(tmp, 'empty-claims.json');
  writeFileSync(file, JSON.stringify({ task: 'nothing', evidence: {} }));
  const r = run('jev-gate.mjs', ['--claims', file]);
  assert.equal(r.code, 3);
  assert.match(r.out, /NOTHING TO CHECK/);
});

test('CLI: a broken judge is UNVERIFIED (exit 3), never a silent block', () => {
  const r = run('jev-gate.mjs', ['--claims', join(ROOT, 'examples', 'claims.example.json')], {
    TYPESAFE_API_KEY: 'definitely-not-a-valid-key',
    JEV_GATES_HOME: tmp,
  });
  assert.equal(r.code, 3);
  assert.match(r.out, /UNVERIFIED/);
  assert.match(r.out, /NOT "done" and NOT "forbidden"/);
});

// --- rubric stand -------------------------------------------------------------

test('expectation matching understands ranges and labels', () => {
  assert.deepEqual(matches({ q: { value: 0.9 } }, { q: { at_least: 0.8 } }), []);
  assert.equal(matches({ q: { value: 0.9 } }, { q: { at_most: 0.2 } }).length, 1);
  assert.deepEqual(matches({ q: { value: 'billing' } }, { q: { equals: 'billing' } }), []);
  assert.equal(matches({}, { q: { at_least: 0.8 } }).length, 1);
});

test('CLI: the fixture template is valid JSON with cases', () => {
  const r = run('jev-evals.mjs', ['template']);
  assert.equal(r.code, 0);
  const tpl = JSON.parse(r.out);
  assert.ok(Array.isArray(tpl.cases) && tpl.cases.length >= 2);
  assert.ok(tpl.cases.some((c) => c.control), 'the template must show an instrument control');
});

test('CLI: a missing fixture is a clean failure, not a stack trace', () => {
  const r = run('jev-evals.mjs', ['run', join(tmp, 'does-not-exist.json')]);
  assert.equal(r.code, 1);
  assert.match(r.out, /cannot read fixture/);
  assert.doesNotMatch(r.out, /at file:/);
});

test('CLI: a missing claims file is a clean failure, not a stack trace', () => {
  const r = run('jev-gate.mjs', ['--claims', join(tmp, 'does-not-exist.json')]);
  assert.equal(r.code, 3);
  assert.match(r.out, /cannot read claims/);
  assert.doesNotMatch(r.out, /at file:/);
});

// --- decision journal ---------------------------------------------------------

test('CLI: the decision journal writes into JEV_GATES_HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'jev-gates-home-'));
  const r = run('jev-gateway.mjs', ['--action', 'edit_readme', '--reversible=true', '--quiet'], {
    JEV_GATES_HOME: home,
  });
  assert.equal(r.code, 0);

  const summary = run('jev-decisions.mjs', ['summary'], { JEV_GATES_HOME: home });
  assert.equal(summary.code, 0);
  assert.match(summary.out, /decision records: 1/);
  assert.match(summary.out, /"allow":1/);
});
