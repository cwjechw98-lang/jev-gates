/**
 * The single end-to-end product acceptance.
 *
 * This produces `PRODUCT_ACCEPTANCE.json`, and it exists because a test count is
 * not acceptance. The document is explicit about that, and it is right: 286 green
 * unit tests say nothing about whether the harness actually registers the tools,
 * whether a real turn stops when it should, or whether the install round-trips.
 *
 * So every set below measures a different thing, and each is reported with its
 * own verdict:
 *
 * | set | what it can prove | what it cannot |
 * |---|---|---|
 * | `offline` | the logic behaves as specified | anything about DSH |
 * | `install` | the kit lands, backs up, and reverses | that the harness loads it |
 * | `catalog` | the tools are in the catalog the model sees | that a model calls them well |
 * | `native` | the guard surface and the tool pipeline in a real harness | that a real turn drives it |
 * | `agent` | a real agent loop, real steer, real approval | model quality — the provider is scripted |
 *
 * Three rules hold the report honest:
 *
 * 1. **A set that did not run is `not-driven`, never `held`.** A missing file or a
 *    timeout is reported as a gap, not skipped.
 * 2. **A pass counter is not a verdict.** Each capability gets its own row with
 *    the tests that covered it, whether it is registered, and how far it was
 *    actually exercised.
 * 3. **A scripted provider proves mechanism, not judgement.** Any capability whose
 *    only runtime evidence comes from the scripted lane is labelled
 *    `runtime-tested`, never `live-validated`.
 *
 * Usage:
 *   node scripts/jev-product-acceptance.mjs [--json] [--out <path>] [--sets all|offline,install,...]
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/**
 * The product, as promised. One row per capability, each naming the tool, the
 * skill, and the test files that cover it. A capability with no test file is a
 * gap this table makes visible rather than hides.
 */
export const CAPABILITIES = [
  {
    id: 'C1',
    tool: 'jev_verify_completion',
    skill: 'jev-completion-gate',
    tests: ['test/capabilities-c1.test.mjs'],
    spec: '§14 / core — completion decided from evidence',
  },
  {
    id: 'C2',
    tool: 'jev_route_skill',
    skill: 'jev-skill-route',
    tests: ['test/capabilities-c2-c4.test.mjs'],
    spec: '§14.1 — route to an existing skill',
  },
  {
    id: 'C3',
    tool: 'jev_check_progress',
    skill: 'jev-progress-review',
    tests: ['test/capabilities-c3-c5.test.mjs'],
    spec: '§14.2 — repeated failure without progress',
  },
  {
    id: 'C4',
    tool: 'jev_review_scope',
    skill: 'jev-review-scope',
    tests: ['test/capabilities-c2-c4.test.mjs'],
    spec: '§14.3 — bounded review of pinned material',
  },
  {
    id: 'C5',
    tool: 'jev_context_plan',
    skill: 'jev-context-plan',
    tests: ['test/capabilities-c3-c5.test.mjs'],
    spec: '§14.4 — context reduction as preview',
  },
  {
    id: 'DIAG',
    tool: 'jev_diagnose',
    skill: 'jev-diagnose',
    tests: ['test/dsh-native-adapter.test.mjs'],
    spec: 'support — explain a gate result and name one next experiment',
  },
];

/** Everything the offline suite covers, including the shared core. */
const CORE_TESTS = [
  'test/acceptance.test.mjs',
  'test/evidence.test.mjs',
  'test/invariants.test.mjs',
  'test/replay.test.mjs',
  'test/transport.test.mjs',
  'test/dsh-adapter.test.mjs',
  'test/dsh-native-adapter.test.mjs',
  'test/dsh-tools.test.mjs',
];

/** Parse `--key value` and `--flag`. */
function parseArgs(argv) {
  const args = { json: false, out: join(REPO, 'PRODUCT_ACCEPTANCE.json'), sets: 'all', keep: false, timeoutMs: 600_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') args.json = true;
    else if (token === '--out') args.out = argv[++i];
    else if (token === '--sets') args.sets = argv[++i];
    else if (token === '--keep') args.keep = true;
    else if (token === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

/** Locate the harness entry point, the same way the native runner does. */
function findDshEntry() {
  const explicit = process.env.JEV_DSH_ENTRY;
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return null;
}

/** Read the harness version, or null when it cannot be read. */
function harnessVersion(entry) {
  if (!entry) return null;
  try {
    return JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

/**
 * Run one command and capture its outcome.
 *
 * Never throws for a non-zero exit: a failing set is data, and a runner that
 * aborted on the first red would hide everything after it.
 */
function run(command, args, { cwd = REPO, env = process.env, timeoutMs = 600_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: `${stderr}\n${String(error?.message ?? error)}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });
}

/** Count the node:test summary lines in a run's output. */
function parseTestCounts(stdout) {
  const counts = { tests: 0, pass: 0, fail: 0 };
  for (const line of stdout.split('\n')) {
    const match = /^ℹ (tests|pass|fail) (\d+)/.exec(line.trim());
    if (match) counts[match[1]] = Number(match[2]);
  }
  return counts;
}

// --- sets --------------------------------------------------------------------

/**
 * The offline suite, run per file so each capability can be attributed exactly.
 * Running the whole suite at once would give one number and no per-capability
 * evidence, which is the pass-counter failure this report exists to avoid.
 */
async function setOffline(options) {
  const checks = [];
  const perFile = {};
  const files = [...new Set([...CAPABILITIES.flatMap((c) => c.tests), ...CORE_TESTS])];

  for (const file of files) {
    if (!existsSync(join(REPO, file))) {
      perFile[file] = { tests: 0, pass: 0, fail: 0, missing: true };
      checks.push({ name: `offline:${file}`, ok: false, detail: 'test file is missing' });
      continue;
    }
    const result = await run(process.execPath, ['--test', file], { timeoutMs: options.timeoutMs });
    const counts = parseTestCounts(result.stdout);
    perFile[file] = { ...counts, missing: false, exitCode: result.code, timedOut: result.timedOut };
    checks.push({
      name: `offline:${file}`,
      ok: result.code === 0 && counts.fail === 0 && counts.tests > 0,
      detail: `${counts.pass}/${counts.tests} pass, ${counts.fail} fail${result.timedOut ? ' (timeout)' : ''}`,
    });
  }

  const total = Object.values(perFile).reduce((sum, f) => sum + f.tests, 0);
  const passed = Object.values(perFile).reduce((sum, f) => sum + f.pass, 0);
  const failed = Object.values(perFile).reduce((sum, f) => sum + f.fail, 0);
  return {
    set: 'offline',
    class: failed === 0 && total > 0 ? 'held' : 'assertion-failed',
    checks,
    perFile,
    totals: { tests: total, pass: passed, fail: failed },
  };
}

/** Install into a throwaway home, then reverse it, and check the guarantees. */
async function setInstall(options) {
  const checks = [];
  const home = mkdtempSync(join(tmpdir(), 'jev-install-'));
  const script = join(REPO, 'scripts', 'jev-install.mjs');

  // A read-only witness on the real active home.
  //
  // This is the check that would have caught the bug that wrote into the live
  // home: the test is not allowed to trust its own discipline, so it observes
  // the real home before and after and fails loudly if anything moved. It only
  // reads — a guard that writes to verify nothing was written is not a guard.
  const realHome = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? resolve(process.env.DSH_HOME) : null;
  const witness = () => {
    if (!realHome) return null;
    let profiles = [];
    try {
      profiles = readdirSync(join(realHome, 'profiles')).sort();
    } catch {
      profiles = [];
    }
    return { manifest: existsSync(join(realHome, 'jev-install-manifest.json')), profiles };
  };
  const before = witness();

  try {
    // The refusal check uses a FAKE active home, never the real one.
    //
    // The first version of this test passed the real `$DSH_HOME` as `--home`
    // while overriding `DSH_HOME` in the child's environment. The installer
    // compares the two to decide whether it is looking at the active home, so
    // the mismatch defeated the guard and the install landed in the live home.
    // Naming the real path in a test is the bug; a test must not be able to
    // write outside its sandbox even when the guard it is testing is broken.
    const fakeActive = join(home, 'fake-active');
    const refused = await run(process.execPath, [script, '--home', fakeActive, '--json'], {
      env: { ...process.env, DSH_HOME: fakeActive },
    });
    let refusedPayload = null;
    try {
      refusedPayload = JSON.parse(refused.stdout);
    } catch {
      /* reported as a failure below */
    }
    checks.push({
      name: 'install:refuses-active-home',
      ok: Boolean(refusedPayload?.refused) && !existsSync(join(fakeActive, 'jev-install-manifest.json')),
      detail: refusedPayload?.refused ?? 'no refusal reported',
    });

    const installed = await run(process.execPath, [script, '--home', home, '--json']);
    let installPayload = null;
    try {
      installPayload = JSON.parse(installed.stdout);
    } catch {
      /* reported below */
    }
    const wroteSkills = (installPayload?.wrote ?? []).filter((p) => p.includes('skills'));
    checks.push({
      name: 'install:writes-skills-and-patch',
      ok: installed.code === 0 && wroteSkills.length >= CAPABILITIES.length && existsSync(join(home, 'profiles', 'jev-product', 'cordis.patch.yml')),
      detail: `${wroteSkills.length} skill file(s), patch ${existsSync(join(home, 'profiles', 'jev-product', 'cordis.patch.yml')) ? 'present' : 'MISSING'}`,
    });

    // A user edit must survive an uninstall. This is the difference between an
    // uninstall and data loss.
    const victim = join(home, 'skills', 'jev-diagnose', 'SKILL.md');
    if (existsSync(victim)) writeFileSync(victim, `${readFileSync(victim, 'utf8')}\nUSER EDIT\n`, 'utf8');
    const removed = await run(process.execPath, [script, '--home', home, '--uninstall', '--json']);
    let uninstallPayload = null;
    try {
      uninstallPayload = JSON.parse(removed.stdout);
    } catch {
      /* reported below */
    }
    const keptEdited = (uninstallPayload?.kept ?? []).some((entry) => entry.path === victim);
    checks.push({
      name: 'install:uninstall-keeps-edited-files',
      ok: removed.code === 0 && keptEdited && existsSync(victim),
      detail: keptEdited ? 'the edited file was kept and reported' : 'an edited file was removed or unreported',
    });

    const noManifest = await run(process.execPath, [script, '--home', mkdtempSync(join(tmpdir(), 'jev-none-')), '--uninstall', '--json']);
    let nonePayload = null;
    try {
      nonePayload = JSON.parse(noManifest.stdout);
    } catch {
      /* reported below */
    }
    checks.push({ name: 'install:refuses-uninstall-without-manifest', ok: Boolean(nonePayload?.refused), detail: nonePayload?.refused ?? 'no refusal reported' });
  } finally {
    if (!options.keep) rmSync(home, { recursive: true, force: true });
  }

  // The witness verdict comes last, so a failure here cannot be hidden by an
  // earlier pass.
  if (before) {
    const after = witness();
    const untouched = after && before.manifest === after.manifest && before.profiles.join(',') === after.profiles.join(',');
    checks.push({
      name: 'install:active-home-untouched',
      ok: Boolean(untouched),
      detail: untouched
        ? `the real DSH home (${realHome}) is unchanged`
        : `the real DSH home changed: manifest ${before.manifest}->${after?.manifest}, profiles [${before.profiles.join(',')}] -> [${after?.profiles.join(',')}]`,
    });
  }

  return { set: 'install', class: checks.every((c) => c.ok) ? 'held' : 'assertion-failed', checks };
}

/** The native adapter acceptance, run as its own process. */
async function setNative(options, entry) {
  const script = join(REPO, 'scripts', 'jev-dsh-acceptance.mjs');
  if (!existsSync(script)) return { set: 'native', class: 'not-driven', checks: [{ name: 'native:runner', ok: false, detail: 'runner is missing' }] };
  if (!entry) return { set: 'native', class: 'not-driven', checks: [{ name: 'native:harness', ok: false, detail: 'DSH entry point not found' }] };

  const result = await run(process.execPath, [script, '--json'], { timeoutMs: options.timeoutMs, env: { ...process.env, JEV_DSH_ENTRY: entry } });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  } catch {
    return { set: 'native', class: 'harness-not-driven', checks: [{ name: 'native:parse', ok: false, detail: `could not parse the report: ${result.stderr.slice(-300)}` }] };
  }
  const checks = (payload.sets ?? []).map((s) => ({ name: `native:${s.set}`, ok: s.class === 'held', detail: s.class }));
  return { set: 'native', class: payload.verdict === 'held' ? 'held' : payload.verdict === 'not-driven' ? 'not-driven' : 'assertion-failed', checks, verdict: payload.verdict, exitCode: payload.exitCode };
}

/** The real agent-loop acceptance, when the runner exists. */
async function setAgent(options, entry) {
  const script = join(REPO, 'scripts', 'jev-agent-acceptance.mjs');
  if (!existsSync(script)) {
    return {
      set: 'agent',
      class: 'not-driven',
      checks: [{ name: 'agent:runner', ok: false, detail: 'runner is missing — a real agent loop is not yet exercised' }],
      limits: ['without this set, Stop/steer/approval in a real turn remain unverified'],
    };
  }
  if (!entry) return { set: 'agent', class: 'not-driven', checks: [{ name: 'agent:harness', ok: false, detail: 'DSH entry point not found' }] };

  const result = await run(process.execPath, [script, '--json'], { timeoutMs: options.timeoutMs, env: { ...process.env, JEV_DSH_ENTRY: entry } });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  } catch {
    return { set: 'agent', class: 'harness-not-driven', checks: [{ name: 'agent:parse', ok: false, detail: `could not parse the report: ${result.stderr.slice(-300)}` }] };
  }
  const checks = (payload.sets ?? []).map((s) => ({ name: `agent:${s.set}`, ok: s.class === 'held', detail: s.class }));
  return {
    set: 'agent',
    class: payload.verdict === 'held' ? 'held' : payload.verdict === 'not-driven' ? 'not-driven' : 'assertion-failed',
    mode: payload.mode ?? 'real-agent-loop/scripted-provider',
    checks,
    verdict: payload.verdict,
    catalog: payload.catalog ?? null,
  };
}

// --- per-capability rows ------------------------------------------------------

/**
 * Decide how far one capability was actually exercised.
 *
 * The ladder is the point: `implemented` means the file exists, `offline-tested`
 * means the logic is covered, `runtime-tested` means a real harness ran **that
 * tool**, and `live-validated` means a real model drove it. Nothing below claims a
 * rung it did not reach, and a scripted provider can never reach the last one.
 *
 * The native set is deliberately NOT accepted as runtime evidence for these
 * capabilities. It exercises the adapter's guard and stop machinery using its own
 * marker tools, so it proves the surrounding surface, not that `jev_verify_completion`
 * ever ran. Letting a set-level "held" lift every capability would be exactly the
 * pass-counter substitution this report exists to avoid.
 *
 * So `runtime-tested` needs two things at once: the tool was seen in a real
 * harness's catalog, and a real harness actually invoked it.
 */
function statusFor(capability, { offline, agent }) {
  const files = capability.tests.filter((f) => offline.perFile[f] && !offline.perFile[f].missing);
  const counts = files.map((f) => offline.perFile[f]);
  const covered = counts.length > 0 && counts.every((c) => c.fail === 0 && c.tests > 0);
  if (!covered) return 'implemented';

  const registered = agent?.catalog ? (agent.catalog.present ?? []).includes(capability.tool) : null;
  const invoked = (agent?.checks ?? []).some((c) => c.ok && typeof c.name === 'string' && c.name.includes(capability.tool));
  if (registered === true && invoked) return 'runtime-tested';

  // The agent lane is scripted, so even a full pass proves the mechanism and never
  // the judgement. `live-validated` is not reachable from this report at all.
  return 'offline-tested';
}

/** Build the report. */
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(2);
  }
  if (args.help) {
    console.log('usage: node scripts/jev-product-acceptance.mjs [--json] [--out <path>] [--sets all|offline,install,native,agent] [--keep]');
    return;
  }

  const wanted = args.sets === 'all' ? ['offline', 'install', 'native', 'agent'] : args.sets.split(',').map((s) => s.trim());
  const entry = findDshEntry();
  const started = Date.now();

  const offline = wanted.includes('offline') ? await setOffline(args) : { set: 'offline', class: 'not-driven', checks: [], perFile: {}, totals: { tests: 0, pass: 0, fail: 0 } };
  const install = wanted.includes('install') ? await setInstall(args) : { set: 'install', class: 'not-driven', checks: [] };
  const native = wanted.includes('native') ? await setNative(args, entry) : { set: 'native', class: 'not-driven', checks: [] };
  const agent = wanted.includes('agent') ? await setAgent(args, entry) : { set: 'agent', class: 'not-driven', checks: [] };

  const sets = [offline, install, native, agent];

  const capabilities = CAPABILITIES.map((capability) => {
    const files = capability.tests.filter((f) => offline.perFile[f] && !offline.perFile[f].missing);
    const counts = files.reduce((acc, f) => ({ tests: acc.tests + offline.perFile[f].tests, pass: acc.pass + offline.perFile[f].pass, fail: acc.fail + offline.perFile[f].fail }), { tests: 0, pass: 0, fail: 0 });
    const registered = agent?.catalog ? (agent.catalog.present ?? []).includes(capability.tool) : null;
    return {
      id: capability.id,
      tool: capability.tool,
      skill: capability.skill,
      spec: capability.spec,
      skillFileExists: existsSync(join(REPO, 'skills', capability.skill, 'SKILL.md')),
      testFiles: capability.tests,
      tests: counts.tests,
      pass: counts.pass,
      fail: counts.fail,
      registeredInHarness: registered,
      status: statusFor(capability, { offline, agent }),
    };
  });

  const held = sets.filter((s) => s.class === 'held').map((s) => s.set);
  const notDriven = sets.filter((s) => s.class === 'not-driven').map((s) => s.set);
  const failed = sets.filter((s) => !['held', 'not-driven'].includes(s.class)).map((s) => s.set);

  // Authority is reported from measurements, not from a promise.
  //
  // A self-declared "I did not touch the active profile" is precisely the kind of
  // claim this product exists to distrust, so the field is derived: the install
  // set's witness observes the real home before and after, and its verdict is what
  // decides the value. If that set did not run, the honest answer is `unknown`.
  const installSet = sets.find((s) => s.set === 'install');
  const witnessCheck = installSet?.checks?.find((c) => c.name === 'install:active-home-untouched');
  const activeProfileTouched = witnessCheck ? !witnessCheck.ok : 'unknown';

  let unpushed = null;
  try {
    const out = execFileSync('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    unpushed = Number(out);
  } catch {
    unpushed = null;
  }

  const verdict = failed.length > 0 ? 'not-held' : notDriven.length > 0 ? 'not-driven' : 'held';
  const exitCode = verdict === 'held' ? 0 : verdict === 'not-held' ? 1 : 3;

  const report = {
    report: 'PRODUCT_ACCEPTANCE',
    verdict,
    exitCode,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    harness: { entry, version: harnessVersion(entry), node: process.version, platform: process.platform },
    authority: {
      paidApiCalls: 0,
      // Measured by the install set's read-only witness, not asserted.
      activeProfileTouched,
      // Measured from git: how many local commits are not on the remote.
      unpushedCommits: unpushed,
      pushed: unpushed === 0,
      note: 'the acceptance installs into a throwaway home; activeProfileTouched comes from the install set witness, and pushed from git rev-list',
    },
    sets: sets.map((s) => ({ set: s.set, class: s.class, checks: s.checks, ...(s.mode ? { mode: s.mode } : {}), ...(s.limits ? { limits: s.limits } : {}) })),
    capabilities,
    offlineTotals: offline.totals ?? null,
    catalog: agent?.catalog ?? null,
    limits: [
      'the agent lane uses a scripted model provider: it proves the mechanism, never the quality of a JEV judgement',
      'no paid JEV/TypeSafe call was made anywhere in this run',
      'C5 is a preview and a restore map; wiring a candidate into a live request pipeline is not established',
      'local evidence has tamperResistance "none": a process with the same write access can alter it',
      ...(notDriven.length > 0 ? [`sets that did not run: ${notDriven.join(', ')}`] : []),
    ],
  };

  writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`PRODUCT ACCEPTANCE: ${verdict} (exit ${exitCode})`);
    for (const s of sets) console.log(`  ${s.set.padEnd(8)} ${s.class}`);
    console.log(`  offline: ${offline.totals?.pass ?? 0}/${offline.totals?.tests ?? 0} pass`);
    console.log('  capabilities:');
    for (const c of capabilities) console.log(`    ${c.id.padEnd(5)} ${c.tool.padEnd(24)} ${c.status.padEnd(16)} tests ${c.pass}/${c.tests}  registered ${c.registeredInHarness}`);
    console.log(`  report: ${args.out}`);
  }
  process.exit(exitCode);
}

main();
