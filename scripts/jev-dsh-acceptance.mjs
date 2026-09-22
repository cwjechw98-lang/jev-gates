#!/usr/bin/env node
/**
 * Runtime acceptance for the native DSH adapter.
 *
 * What this proves and what it does not
 * -------------------------------------
 * It builds a throwaway `DSH_HOME`, mounts `adapters/dsh/plugin.mjs` in it beside
 * a scenario driver, boots the real harness, and drives `ctx.tools.execute` — the
 * same entry point the agent loop uses. The active profile is never read or
 * written; nothing here touches the global `node_modules`.
 *
 * It does NOT exercise a model. The tool calls come from the scenario plugin
 * rather than from an assistant turn, because using a model would need a paid
 * API and a credential this work is not authorised to spend. Every claim below
 * is therefore about the tool pipeline, the guard surface, and the Stop handler —
 * not about model behaviour.
 *
 * Failure classes are kept apart on purpose. A boot that times out, a run that
 * produced no result, an adapter that never attached a listener, and a scenario
 * whose tool never ran are four different things, and none of them is a pass:
 *
 *   boot-timeout           the harness did not finish starting
 *   harness-not-driven     it started but wrote no result
 *   listener-not-attached  the adapter produced no decision record
 *   tool-not-invoked       neither the body ran nor a decision was recorded
 *   assertion-failed       the observation contradicted the expectation
 *
 * Usage:
 *   node scripts/jev-dsh-acceptance.mjs [--json] [--set shadow|enforce|never|failure|stop|all]
 *                                       [--timeout-ms 120000] [--keep]
 *
 * Exit codes: 0 every scenario held, 1 a scenario failed, 3 the run was not driven.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const ADAPTERS = join(REPO, 'adapters', 'dsh');

/** The tool that requires authorisation in every scenario set. */
const MARKER_TOOL = 'jev_marker';
const BENIGN_TOOL = 'jev_benign';
const FOREIGN_TOOL = 'jev_foreign';

const RULES = [{ name: 'requires_authorization', tool: '^jev_marker$', flags: ['authorization_required'] }];

const SETS = {
  shadow: {
    adapter: { mode: 'shadow', policy: 'ask' },
    check: (obs, log) => {
      const marker = obs['shadow:marker-tool'];
      const benign = obs['shadow:benign-tool'];
      return [
        expect('shadow: the marker tool runs', marker?.markerExists === true && marker?.isError === false, marker),
        expect('shadow: the benign tool runs', benign?.markerExists === true, benign),
        expect(
          'shadow: the proposed denial is recorded',
          log.some((e) => e.kind === 'pre.decision' && e.tool === MARKER_TOOL && e.mode === 'shadow' && e.decision === null),
          log.filter((e) => e.kind === 'pre.decision'),
        ),
      ];
    },
  },
  enforce: {
    adapter: { mode: 'enforce', policy: 'ask' },
    check: (obs, log) => {
      const marker = obs['enforce:marker-tool'];
      const benign = obs['enforce:benign-tool'];
      const foreign = obs['enforce:foreign-guard'];
      return [
        expect('enforce: the marker tool does not run', marker?.markerExists === false, marker),
        expect('enforce: the call fails with a visible reason', marker?.isError === true && /jev-gates/.test(String(marker?.reason)), marker),
        expect('enforce: an ordinary tool still runs', benign?.markerExists === true && benign?.isError === false, benign),
        expect('enforce: another guard is not weakened', foreign?.isError === true && /foreign-guard/.test(String(foreign?.reason)), foreign),
        expect('enforce: the foreign marker was not written', obs['enforce:foreign-marker-exists']?.value === false, obs['enforce:foreign-marker-exists']),
        expect('enforce: a decision was recorded', log.some((e) => e.tool === MARKER_TOOL), log.filter((e) => e.tool === MARKER_TOOL)),
      ];
    },
  },
  never: {
    adapter: { mode: 'enforce', policy: 'never' },
    check: (obs) => {
      const marker = obs['never:marker-tool'];
      const benign = obs['never:benign-tool'];
      return [
        expect('never: the marker tool does not run', marker?.markerExists === false, marker),
        expect('never: the reason is authorization_unavailable', /authorization_unavailable/.test(String(marker?.reason)), marker),
        expect('never: an ordinary tool still runs', benign?.markerExists === true && benign?.isError === false, benign),
      ];
    },
  },
  failure: {
    adapter: { mode: 'enforce', policy: 'ask', failDecision: true },
    check: (obs, log) => {
      const marker = obs['failure:marker-tool'];
      const benign = obs['failure:benign-tool'];
      return [
        expect('failure: a mandatory check that fails denies', marker?.markerExists === false && marker?.isError === true, marker),
        expect('failure: the failure is named, not silent', /authorisation check failed/.test(String(marker?.reason)), marker),
        expect('failure: ordinary tools are not blanket-blocked', benign?.markerExists === true && benign?.isError === false, benign),
        expect(
          'failure: the failure was recorded explicitly',
          log.some((e) => (e.kind === 'guard.failure' || e.kind === 'pre.failure') && e.verdict === 'deny'),
          log.filter((e) => e.kind === 'guard.failure' || e.kind === 'pre.failure'),
        ),
      ];
    },
  },
  stop: {
    adapter: { mode: 'enforce', policy: 'ask' },
    check: (obs) => {
      const first = obs['stop:first'];
      const repeat = obs['stop:repeat-same-key'];
      const cancelled = obs['stop:cancelled'];
      const fresh = obs['stop:new-evidence'];
      const other = obs['stop:other-session'];
      const confirmed = obs['stop:confirmed'];
      const none = obs['stop:no-claim'];
      return [
        expect('stop: the pending claim produces one steering message', first?.steers === 1 && first?.dispatched === true, first),
        expect('stop: the message names the unconfirmed claim', /unconfirmed/.test(String(first?.message)), first),
        expect('stop: a repeat with no new evidence does not steer again', repeat?.steers === 0, repeat),
        expect('stop: a cancelled turn does not steer', cancelled?.steers === 0, cancelled),
        expect('stop: new evidence does steer', fresh?.steers === 1, fresh),
        expect('stop: a second session keeps its own budget', other?.steers === 1, other),
        expect('stop: a confirmed claim is cleared without steering', confirmed?.steers === 0 && confirmed?.claimStillPending === false, confirmed),
        expect('stop: a session with no claim is not steered', none?.steers === 0, none),
      ];
    },
  },
};

function expect(name, ok, observed) {
  return { name, ok: ok === true, observed };
}

// --- environment -------------------------------------------------------------

function findDshEntry() {
  const explicit = process.env.JEV_DSH_ENTRY;
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return null;
}

function harnessFacts(entry) {
  const root = resolve(dirname(entry), '..');
  const facts = { entry, root, version: null, node: process.version, hashes: {} };
  try {
    facts.version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  } catch {
    /* version stays null and the report says so */
  }
  for (const rel of [
    join('node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
    join('node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
    join('node_modules', '@deepseek-ai', 'dsh-hooks-claude-code', 'lib', 'index.js'),
    join('node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox', 'lib', 'index.js'),
  ]) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    facts.hashes[rel] = createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
  }
  return facts;
}

// --- one boot ----------------------------------------------------------------

function yamlRow(id, name, config) {
  const lines = [`    - id: ${id}`, `      name: '${name}'`];
  if (config && Object.keys(config).length > 0) {
    lines.push('      config:');
    for (const [key, value] of Object.entries(config)) {
      if (Array.isArray(value)) {
        lines.push(`        ${key}:`);
        for (const item of value) {
          const entries = Object.entries(item);
          lines.push(`          - ${entries[0][0]}: ${JSON.stringify(entries[0][1])}`);
          for (const [k, v] of entries.slice(1)) lines.push(`            ${k}: ${JSON.stringify(v)}`);
        }
      } else {
        lines.push(`        ${key}: ${JSON.stringify(value)}`);
      }
    }
  }
  return lines.join('\n');
}

function runSet(setName, spec, options) {
  const scratch = join(options.root, `run-${setName}`);
  const project = join(scratch, 'project');
  const home = join(options.root, 'dsh-home');
  mkdirSync(project, { recursive: true });

  const adapterLog = join(scratch, 'adapter.log');
  const scenarioOut = join(scratch, 'scenario.json');
  const overlay = join(scratch, 'overlay.yml');

  writeFileSync(
    overlay,
    [
      '- insert:',
      yamlRow('jev-adapter', pathToFileURL(join(ADAPTERS, 'plugin.mjs')).href, {
        ...spec.adapter,
        logPath: adapterLog,
        maxSteers: 2,
        rules: RULES,
      }),
      yamlRow('jev-scenarios', pathToFileURL(join(ADAPTERS, 'scenarios.mjs')).href, {}),
      '',
    ].join('\n'),
    'utf8',
  );

  const env = {
    ...process.env,
    DSH_HOME: home,
    JEV_SCENARIO_DIR: project,
    JEV_SCENARIO_OUT: scenarioOut,
    JEV_SCENARIO_SET: setName,
    JEV_HARNESS_VERSION: options.facts.version ?? '',
    // Keep every set's state apart, so a scenario cannot pass on another
    // scenario's leftovers. `bridge.mjs` reads `JEV_DSH_STATE`.
    JEV_DSH_STATE: join(scratch, 'state'),
  };

  const started = Date.now();
  return runBoot(options.entry, ['--profile', 'jev-iso', '--patch', overlay, 'probe'], {
    env,
    cwd: project,
    timeoutMs: options.timeoutMs,
  }).then((boot) => {
    const result = {
      set: setName,
      durationMs: Date.now() - started,
      bootTimedOut: boot.timedOut,
      bootExit: boot.exitCode,
      bootStderrTail: boot.stderr.slice(-600),
      scenarioWritten: existsSync(scenarioOut),
      logWritten: existsSync(adapterLog),
      failures: [],
    };
    if (boot.timedOut) {
      result.class = 'boot-timeout';
      return result;
    }
    if (!existsSync(scenarioOut)) {
      result.class = 'harness-not-driven';
      return result;
    }

    let payload;
    try {
      payload = JSON.parse(readFileSync(scenarioOut, 'utf8'));
    } catch (error) {
      result.class = 'harness-not-driven';
      result.parseError = String(error?.message ?? error);
      return result;
    }
    result.observations = payload.observations ?? [];

    const log = existsSync(adapterLog)
      ? readFileSync(adapterLog, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return { kind: 'unparsed' };
            }
          })
      : [];
    result.logEntries = log.length;

    const obs = Object.fromEntries((payload.observations ?? []).map((entry) => [entry.name, entry]));

    if (setName !== 'stop' && log.length === 0) {
      result.class = 'listener-not-attached';
      result.failures = [expect('the adapter attached a listener and recorded a decision', false, { logEntries: 0 })];
      return result;
    }

    const markerKey = Object.keys(obs).find((key) => key.endsWith('marker-tool'));
    if (markerKey) {
      const marker = obs[markerKey];
      const invoked = marker?.markerExists === true || marker?.isError === true;
      if (!invoked) {
        result.class = 'tool-not-invoked';
        result.failures = [expect('the marker tool was actually invoked', false, marker)];
        return result;
      }
    }

    const checks = spec.check(obs, log);
    result.checks = checks;
    result.failures = checks.filter((check) => !check.ok);
    result.class = result.failures.length === 0 ? 'held' : 'assertion-failed';
    return result;
  });
}

/** Boot the harness, bounded, and make sure nothing survives the bound. */
function runBoot(entry, args, { env, cwd, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      // The harness starts child processes of its own; kill the tree, or the
      // next set inherits a port, a lock, or a stale sandbox runner.
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

    const settle = (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({ exitCode, signal, stdout, stderr, timedOut });
    };
    child.on('error', (error) => {
      stderr += `\nspawn error: ${String(error?.message ?? error)}`;
      settle(null, null);
    });
    child.on('close', (exitCode, signal) => settle(exitCode, signal));
  });
}

// --- main --------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i > -1 ? argv[i + 1] ?? true : fallback;
  };
  const asJson = argv.includes('--json');
  const keep = argv.includes('--keep');
  const only = flag('set', 'all');
  const timeoutMs = Number(flag('timeout-ms', 120_000));

  const entry = findDshEntry();
  if (!entry) {
    const report = { verdict: 'not-driven', class: 'harness-not-found', exitCode: 3 };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 3;
    return;
  }

  const facts = harnessFacts(entry);
  const root = keep ? join(REPO, '.acceptance', `run-${Date.now()}`) : mkdtempSync(join(tmpdir(), 'jev-dsh-acc-'));
  mkdirSync(root, { recursive: true });

  // The profile is built once and shared: it is the composition under test, not
  // a per-scenario variable.
  const home = join(root, 'dsh-home');
  const profileBuild = await runBoot(entry, ['--profile', 'jev-iso', '--from-default-profile', 'headless', '--dump-config'], {
    env: { ...process.env, DSH_HOME: home },
    cwd: root,
    timeoutMs,
  });
  if (!existsSync(join(home, 'profiles', 'jev-iso', 'cordis.yml'))) {
    const report = {
      verdict: 'not-driven',
      class: 'profile-not-created',
      exitCode: 3,
      bootExit: profileBuild.exitCode,
      stderrTail: profileBuild.stderr.slice(-600),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 3;
    return;
  }

  const names = only === 'all' ? Object.keys(SETS) : [only].filter((n) => n in SETS);
  const results = [];
  for (const name of names) {
    results.push(await runSet(name, SETS[name], { root, entry, timeoutMs, facts }));
  }

  const held = results.filter((r) => r.class === 'held').length;
  const notDriven = results.filter((r) => ['boot-timeout', 'harness-not-driven', 'listener-not-attached', 'tool-not-invoked'].includes(r.class)).length;
  const failed = results.length - held - notDriven;
  const verdict = notDriven > 0 ? 'not-driven' : failed > 0 ? 'not-held' : 'held';
  const report = {
    verdict,
    exitCode: verdict === 'held' ? 0 : verdict === 'not-held' ? 1 : 3,
    harness: { version: facts.version, node: facts.node, entry: facts.entry, hashes: facts.hashes },
    scenarios: results.map((r) => ({
      set: r.set,
      class: r.class,
      durationMs: r.durationMs,
      bootTimedOut: r.bootTimedOut,
      bootExit: r.bootExit,
      logEntries: r.logEntries,
      failures: r.failures,
      checks: r.checks,
      observations: r.observations,
      bootStderrTail: r.class === 'held' ? undefined : r.bootStderrTail,
    })),
    scratch: root,
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const lines = [];
    lines.push(`jev-gates DSH runtime acceptance — ${verdict.toUpperCase()}`);
    lines.push(`harness ${facts.version ?? '(unknown version)'} on node ${facts.node}`);
    lines.push('');
    for (const r of report.scenarios) {
      const mark = r.class === 'held' ? 'PASS' : r.class === 'assertion-failed' ? 'FAIL' : 'NOT DRIVEN';
      lines.push(`[${mark}] ${r.set} (${r.class}, ${r.durationMs} ms)`);
      for (const c of r.checks ?? []) lines.push(`    ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`);
      for (const f of r.failures ?? []) if (!(r.checks ?? []).includes(f)) lines.push(`    FAIL ${f.name}`);
      if (r.class !== 'held' && r.class !== 'assertion-failed') lines.push(`    class=${r.class} bootExit=${r.bootExit} logEntries=${r.logEntries}`);
    }
    lines.push('');
    lines.push(`scratch: ${root}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  if (!keep) rmSync(root, { recursive: true, force: true });
  process.exitCode = report.exitCode;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ verdict: 'not-driven', class: 'runner-crashed', error: String(error?.stack ?? error), exitCode: 3 }, null, 2)}\n`);
  process.exitCode = 3;
});
