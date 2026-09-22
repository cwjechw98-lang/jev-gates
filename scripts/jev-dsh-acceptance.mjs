#!/usr/bin/env node
/**
 * Isolated runtime acceptance for the DSH adapter.
 *
 * This runs the REAL harness — real process, real plugin loader, real
 * `@deepseek-ai/dsh-hooks-claude-code` bridge, real `tools/pre-execute`
 * waterfall, real hook spawn, real protocol parser — in a throwaway `DSH_HOME`,
 * and asks one question: when a PreToolUse hook denies a command, does the
 * command actually not run?
 *
 * No model is involved, so this costs nothing and needs no credentials. The
 * active profile is never read or written: the profile is created with
 * `--from-default-profile` under a temporary home.
 *
 *   node scripts/jev-dsh-acceptance.mjs            run and report
 *   node scripts/jev-dsh-acceptance.mjs --keep     keep the scratch tree
 *   node scripts/jev-dsh-acceptance.mjs --json     machine-readable report
 *
 * Exit codes: 0 the gate held, 1 the gate did NOT hold, 3 the harness could not
 * be driven at all (which is not a pass).
 *
 * What this found, on Windows with the shipped profiles: the bridge's
 * `shell.resolve()` throws `cannot get property "sandboxPolicy" without inject`,
 * `runHook` turns that into an outcome with no decision, the merge yields
 * "allow", and the command runs. The gate is silently decorative. The adapter's
 * doctor reports that instead of claiming the capability is verified.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const ADAPTERS = join(REPO, 'adapters', 'dsh');

/** The DSH install to drive. Overridable so this is not tied to one machine. */
function dshEntry(env = process.env) {
  if (env.JEV_DSH_ENTRY) return env.JEV_DSH_ENTRY;
  const candidates = [
    join(env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(env.npm_config_prefix ?? '', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

/** The bridge package the harness must load. Resolved from the DSH install. */
function bridgePackage(entry) {
  return join(dirname(entry), '..', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-hooks-claude-code', 'lib', 'index.js');
}

/** The hook-protocol package, for the probe's own diagnostic run. */
function hookProtocolPackage(entry) {
  return join(dirname(entry), '..', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-hook-protocol', 'lib', 'index.js');
}

function buildScratch() {
  // Inside the repository, not under the system temp directory: the boot was
  // verified by hand with the scratch tree beside the checkout and hung when it
  // was moved to `%TEMP%`. `.acceptance/` is git-ignored and removed afterwards.
  const base = join(REPO, '.acceptance');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'run-'));
  const home = join(root, 'dsh-home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { root, home, project };
}

/**
 * Generate the observing wrapper around the real bridge.
 *
 * The bridge turns any executor failure into an outcome with no decision, so a
 * hook that cannot launch is indistinguishable from a gate that stayed silent.
 * The wrapper re-exports the real plugin unchanged and records what the shell
 * service does when the bridge asks it to run a hook. It is generated with a
 * concrete package path so the repository holds no machine-specific path.
 */
function writeBridgeProbe({ entry, path }) {
  const bridgeUrl = `file:///${bridgePackage(entry).replace(/\\/g, '/').replace(/^\//, '')}`;
  const source = `import { appendFileSync } from 'node:fs';
import { apply as realApply, Config, inject, name } from '${bridgeUrl}';

export { Config, inject, name };

const note = (line) => {
  const log = process.env.JEV_ISO_WATCH;
  if (!log) return;
  try { appendFileSync(log, line + '\\n', 'utf8'); } catch { /* nothing useful to do */ }
};

export function apply(ctx, config) {
  note('bridge apply called with ' + JSON.stringify(config));
  const shell = ctx.shell;
  note('bridge ctx.shell.run: ' + typeof shell?.run + '; ctx.shell.resolve: ' + typeof shell?.resolve);

  const proxied = new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop === 'shell' && shell !== undefined) {
        return new Proxy(shell, {
          get(shellTarget, shellProp, shellReceiver) {
            const value = Reflect.get(shellTarget, shellProp, shellReceiver);
            if (typeof value !== 'function') return value;
            return (...args) => {
              try {
                const result = value.apply(shellTarget, args);
                if (result && typeof result.then === 'function') {
                  return result.then(
                    (r) => r,
                    (e) => { note('shell.' + String(shellProp) + ' REJECTED: ' + String(e && e.message ? e.message : e)); throw e; },
                  );
                }
                return result;
              } catch (error) {
                note('shell.' + String(shellProp) + ' THREW: ' + String(error && error.message ? error.message : error));
                throw error;
              }
            };
          },
        });
      }
      if (prop !== 'on') return Reflect.get(target, prop, receiver);
      return (event, listener) => {
        if (event !== 'tools/pre-execute') return target.on(event, listener);
        return target.on(event, async (exec, next) => {
          note('bridge listener invoked: ' + String(exec?.name));
          const result = await listener(exec, next);
          note('bridge listener returned ' + JSON.stringify(result));
          return result;
        });
      };
    },
  });

  return realApply(proxied, config);
}
`;
  writeFileSync(path, source, 'utf8');
  return path;
}

/** The overlay is generated with concrete paths: `!!js` is not relied upon here. */
function writeOverlay({ project, path }) {
  // Rows are named relative to this file, which is how the configuration that
  // was verified by hand was written. Absolute `file:///` URLs were tried and
  // hung the boot instead; the loader resolves `./name.mjs` against the overlay's
  // own directory, so the probe files are written beside it.
  const yaml = `# Generated by scripts/jev-dsh-acceptance.mjs — do not edit in place.
#
# Two rows: the harness's own hook bridge, pointed at a hooks.json that calls the
# jev-gates bridge in enforce mode, and a probe that drives the real
# tools/pre-execute waterfall without a model.
- insert:
    - id: jev-gates-hooks
      name: './bridge-probe.mjs'
      config:
        configPath: '${join(project, 'hooks.json').replace(/\\/g, '/')}'
        pluginRoot: '${project.replace(/\\/g, '/')}'
        projectDir: '${project.replace(/\\/g, '/')}'

    - id: jev-iso-acceptance
      name: './iso-acceptance.mjs'
`;
  writeFileSync(path, yaml, 'utf8');
  return path;
}

function writeHooks({ bridge, project, path }) {
  const hooks = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `node "${join(ADAPTERS, 'bridge.mjs')}" --mode enforce --policy never` }],
        },
      ],
    },
  };
  writeFileSync(path, JSON.stringify(hooks, null, 2), 'utf8');
  return path;
}

function run() {
  const argv = process.argv.slice(2);
  const keep = argv.includes('--keep');
  const asJson = argv.includes('--json');

  const entry = dshEntry();
  if (!entry) {
    return { verdict: 'harness-not-found', detail: 'the DSH entry point could not be located; pass JEV_DSH_ENTRY', held: null };
  }

  const { root, home, project } = buildScratch();
  const overlay = join(root, 'overlay.yml');
  const resultPath = join(project, 'iso-result.json');
  const markerPath = join(project, 'MARKER-THE-DENIED-COMMAND-RAN.txt');
  const watchPath = join(project, 'watch.log');
  const profile = 'jev-acceptance';

  try {
    // A profile created from the shipped template, under the throwaway home.
    const env = {
      ...process.env,
      DSH_HOME: home,
      JEV_GATES_HOME: join(project, 'state'),
      JEV_ISO_RESULT: resultPath,
      JEV_ISO_MARKER: markerPath,
      JEV_ISO_WATCH: watchPath,
      JEV_DSH_HOOK_PROTOCOL: `file:///${hookProtocolPackage(entry).replace(/\\/g, '/').replace(/^\//, '')}`,
    };

    execFileSync(process.execPath, [entry, '--profile', profile, '--from-default-profile', 'headless', '--dump-config'], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 180_000,
    });

    writeHooks({ project, path: join(project, 'hooks.json') });
    // Both probe modules live beside the overlay so `./name.mjs` resolves.
    writeBridgeProbe({ entry, path: join(root, 'bridge-probe.mjs') });
    copyFileSync(join(ADAPTERS, 'iso-acceptance.mjs'), join(root, 'iso-acceptance.mjs'));
    writeOverlay({ project, path: overlay });

    let bootOutput = '';
    let bootTimedOut = false;
    try {
      bootOutput = execFileSync(process.execPath, [entry, '--profile', profile, '--patch', overlay, 'probe'], {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
    } catch (error) {
      // The boot ends with MISSING_CREDENTIAL once the probe has exited, which is
      // expected: the probe finishes before any model is needed. Only a missing
      // result file is a real failure.
      bootTimedOut = error?.killed === true || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT';
      bootOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }

    if (!existsSync(resultPath)) {
      return {
        verdict: 'harness-not-driven',
        detail: bootTimedOut
          ? 'the isolated boot did not finish within 120s: the plugin tree never reached the PreToolUse dispatch'
          : 'the probe never wrote a result: the harness did not reach the PreToolUse dispatch',
        held: null,
        bootTimedOut,
        bootOutput: bootOutput.slice(-2000),
        scratch: root,
      };
    }

    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    const watch = existsSync(watchPath) ? readFileSync(watchPath, 'utf8') : '';
    const shellFailure = /shell\.resolve THREW: (.+)/.exec(watch);
    const forbidden = result.forbidden;
    const markerRan = result.markerRan === true;
    const held = forbidden?.kind === 'deny' && !markerRan;

    return {
      verdict: held ? 'gate-held' : 'gate-did-not-hold',
      held,
      forbidden,
      benign: result.benign,
      markerRan,
      shellFailure: shellFailure ? shellFailure[1].trim() : null,
      resultPath,
      markerPath,
      scratch: root,
    };
  } finally {
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  let report;
  try {
    report = run();
  } catch (error) {
    report = { verdict: 'threw', detail: String(error && error.stack ? error.stack : error), held: null };
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('DSH adapter — isolated runtime acceptance');
    console.log(`  verdict: ${report.verdict}`);
    if (report.forbidden) console.log(`  the PreToolUse decision for "git push --force": ${JSON.stringify(report.forbidden)}`);
    if (report.benign) console.log(`  the PreToolUse decision for "git status":      ${JSON.stringify(report.benign)}`);
    if (report.markerRan !== undefined) {
      console.log(`  the denied command ran: ${report.markerRan ? 'YES — the gate did not hold' : 'no'}`);
    }
    if (report.shellFailure) console.log(`  executor failure: ${report.shellFailure}`);
    if (report.detail) console.log(`  detail: ${report.detail}`);
    if (report.bootOutput) console.log(`  boot output (tail):\n${report.bootOutput}`);
    if (report.scratch && process.argv.includes('--keep')) console.log(`  scratch kept at: ${report.scratch}`);
  }

  process.exitCode = report.held === true ? 0 : report.held === false ? 1 : 3;
}
