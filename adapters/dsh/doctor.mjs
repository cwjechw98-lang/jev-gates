#!/usr/bin/env node
/**
 * DSH doctor (REQ-07).
 *
 * Answers one question: what can this adapter actually guarantee on *this*
 * installation? It reads, it does not write, and it never starts a harness.
 *
 * Why a doctor exists at all: the honest answer differs per build. On
 * 0.1.5-rc.2 the shipped hook bridge cannot launch a hook at all under the
 * sandboxed executors, cannot see a structured exit code, and cannot veto a
 * turn; the native adapter can deny on the real path. A README that promises
 * otherwise is a README that teaches people to trust a gate that is not there.
 * So the diagnosis is produced from the installed files and reported with the
 * citation, and every capability is labelled with what was actually measured —
 * `verified`, `conditional`, `unavailable` or `not_mounted` — and how.
 *
 * Exit codes: 0 healthy, 1 degraded (the adapter works but with reduced effect),
 * 2 misconfigured (the adapter cannot run at all).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Locate the installed DSH package without importing it. */
export function findDshInstall({ env = process.env, home = homedir() } = {}) {
  const candidates = [
    env.DSH_INSTALL,
    join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/usr/lib/node_modules/@deepseek-ai/dsh',
    join(home, '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Which profile is live. `DSH_WEB_URL` implies the web profile. */
export function activeProfile(env = process.env) {
  if (env.DSH_PROFILE) return env.DSH_PROFILE;
  if (env.DSH_WEB_URL) return 'web';
  if (env.DSH_TUI) return 'tui';
  return 'unknown';
}

/** Composition files that would carry a hook-bridge row. */
export function compositionFiles({ env = process.env, home = homedir() } = {}) {
  const dshHome = env.DSH_HOME ?? join(home, '.dsh');
  const profile = activeProfile(env);
  const files = [join(dshHome, 'settings.yaml')];
  if (profile !== 'unknown') {
    files.push(join(dshHome, 'profiles', profile, 'cordis.yml'));
    files.push(join(dshHome, 'profiles', profile, 'cordis.patch.yml'));
  }
  return { dshHome, profile, files };
}

/**
 * Is the hook bridge mounted? A package being installed is not the same as a row
 * being composed, and conflating the two is how a "supported" claim gets made
 * about something that never runs.
 */
export function hookBridgeMount({ env = process.env, home = homedir() } = {}) {
  const { dshHome, profile, files } = compositionFiles({ env, home });
  const hits = [];
  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    for (const pattern of [/hooks-claude-code/, /hooks-codex/, /hooks\.json/, /dsh-hook-protocol/]) {
      if (pattern.test(text)) hits.push({ file, pattern: String(pattern) });
    }
  }
  const presetsDir = join(dshHome, '.agent-presets');
  const presets = [];
  if (existsSync(presetsDir)) {
    for (const entry of readdirSync(presetsDir)) {
      const candidate = join(presetsDir, entry, 'agent.cordis.yml');
      const text = readText(candidate);
      if (text && /hooks-claude-code|hooks-codex/.test(text)) presets.push(candidate);
    }
  }
  return { mounted: hits.length > 0 || presets.length > 0, hits, presets, files, dshHome, profile };
}

/** The approval policy, if the configuration states it. Never guessed. */
export function approvalPolicy({ env = process.env, home = homedir() } = {}) {
  const { dshHome } = compositionFiles({ env, home });
  const text = readText(join(dshHome, 'settings.yaml'));
  if (text === null) return { policy: 'unknown', source: 'settings.yaml is absent' };
  const match = text.match(/^\s*approval[_-]?policy\s*:\s*["']?([a-zA-Z_-]+)/m) ?? text.match(/^\s*policy\s*:\s*["']?([a-zA-Z_-]+)/m);
  if (!match) return { policy: 'unknown', source: 'no approval policy key in settings.yaml' };
  return { policy: match[1], source: 'settings.yaml' };
}

/**
 * The capability matrix. Each row states what was verified, how, and what it
 * means for the adapter.
 */
export function capabilities({ install, bridgeMounted, policy }) {
  return [
    {
      capability: 'PreToolUse deny via the shipped hook bridge',
      // Not `verified`. The protocol supports it, but the bridge reaches the
      // protocol only through the `shell` service it injects, and on the composed
      // profiles the mounted sandboxed executor cannot be driven by a caller that
      // does not inject `sandboxPolicy`. The failure is silent, so the capability
      // is conditional on an executor the bridge can actually use.
      // See docs/HARNESSES.md and docs/_dsh-runtime-findings.md §13.
      verdict: 'conditional',
      evidence:
        'dsh-hook-protocol/lib/index.js:110-113 (exit 2), :150-151 (permissionDecision); ' +
        'dsh-hooks-claude-code/lib/index.js:114 (inject ["shell","sessionProjections"]), :148 (shell.resolve); ' +
        'dsh-pwsh-sandbox/lib/index.js:148 and dsh-bash-sandbox/lib/index.js:141 (resolve reads this.ctx.sandboxPolicy); ' +
        'measured: ctx.get("shell").ctx.fiber is the CALLER\'s fiber, so a caller that does not inject sandboxPolicy ' +
        'makes resolve() throw "cannot get required service \\"sandboxPolicy\\" in inactive context"; runHook turns that ' +
        'into an outcome with no decision and no spawned process',
      consequence:
        'with the shipped sandboxed executors the bridge cannot launch a single hook and nothing reports that; ' +
        'use the native adapter, which needs no `shell` service',
    },
    {
      capability: 'PreToolUse deny via the native adapter',
      // Runtime-verified, not merely protocol-tested: an isolated harness boot
      // drove the real tool pipeline and the guard surface.
      verdict: 'verified',
      evidence:
        'adapters/dsh/plugin.mjs (ctx.tools.guard + tools/pre-execute); ' +
        'dsh-tools/lib/index.js:2816 (guard), :3116-3148 (waterfall and guardReason), ' +
        'lib/types/index.d.ts:419-427 (PreToolDecision), :610-620 (guard cannot be force-allowed); ' +
        'measured: node scripts/jev-dsh-acceptance.mjs — verdict HELD, enforce set: the marker tool did not run, ' +
        'no marker file was written, and the reason named jev-gates',
      consequence:
        'a call that requires authorisation is denied on the real path; the guard is monotonic, so no later listener ' +
        'can force-allow it',
    },
    {
      capability: 'PreToolUse ask',
      verdict: policy.policy === 'never' ? 'unavailable' : policy.policy === 'unknown' ? 'conditional' : 'verified',
      evidence: 'adapters/dsh/plugin.mjs (the native adapter raises `ask` on the tools/pre-execute waterfall) + dsh-user-approval/lib/index.js:178; the shipped bridge cannot reach this point at all',
      consequence:
        policy.policy === 'never'
          ? 'policy is "never": an ask becomes an automatic deny, so enforce mode denies explicitly instead and says why'
          : policy.policy === 'unknown'
            ? 'the policy could not be read from the configuration; if it is "never" an ask silently becomes a deny — pass --policy to state it'
            : 'the adapter can route a decision to the human',
    },
    {
      capability: 'PostToolUse structured exit code',
      verdict: 'unavailable',
      evidence: 'dsh-hooks-claude-code/lib/index.js:375-383 (payload has tool_response text only)',
      consequence: 'observations from this path are partial coverage and cannot confirm a criterion alone',
    },
    {
      capability: 'PostToolUse rollback',
      verdict: 'unavailable',
      evidence: 'dsh-tools/lib/index.js:3379-3388 (block re-labels a finished result)',
      consequence: 'the adapter records, it does not undo',
    },
    {
      capability: 'Stop veto',
      verdict: 'unavailable',
      evidence: 'dsh-hooks-claude-code/lib/index.js:292-308 + dsh-agent-loop/lib/index.js:966-973 (steer, not veto)',
      consequence: 'Stop is a bounded steer; a run that exhausts the budget ends as incomplete, not as confirmed',
    },
    {
      capability: 'programmatic tool events',
      verdict: 'verified',
      evidence: 'dsh-tool-cordis/lib/index.js:4915-5720 (event catalog) — strictly more capable than the bridge',
      consequence: 'a Cordis plugin can read exec.callId and result.value, including a structured exit code',
    },
    {
      capability: 'hook bridge mounted',
      verdict: bridgeMounted.mounted ? 'verified' : 'not_mounted',
      evidence: bridgeMounted.mounted ? bridgeMounted.hits.map((h) => h.file).join(', ') : 'no composition row found',
      consequence: bridgeMounted.mounted
        ? 'the bridge dialect is active'
        : 'the bridge is installed but no composition row mounts it, so the adapter is advisory until it is mounted',
    },
    {
      capability: 'install present',
      verdict: install ? 'verified' : 'unavailable',
      evidence: install ?? 'no @deepseek-ai/dsh installation found',
      consequence: install ? 'the citations above are readable on this machine' : 'the citations could not be re-read here',
    },
  ];
}

export function diagnose({ env = process.env, home = homedir(), policyOverride = null } = {}) {
  const install = findDshInstall({ env, home });
  const pkg = install ? readJson(join(install, 'package.json')) : null;
  const bridgeMounted = hookBridgeMount({ env, home });
  const detected = approvalPolicy({ env, home });
  const policy = policyOverride
    ? { policy: policyOverride, source: 'stated on the command line' }
    : detected;
  const caps = capabilities({ install, bridgeMounted, policy });

  const degraded = caps.some((c) => c.verdict === 'not_mounted' || c.verdict === 'unavailable');
  const fatal = !install;
  return {
    dshVersion: pkg?.version ?? null,
    install,
    profile: bridgeMounted.profile,
    dshHome: bridgeMounted.dshHome,
    policy: policy.policy,
    policySource: policy.source,
    bridge: bridgeMounted,
    capabilities: caps,
    status: fatal ? 'misconfigured' : degraded ? 'degraded' : 'healthy',
    exitCode: fatal ? 2 : degraded ? 1 : 0,
    enforcement: {
      preToolUse: bridgeMounted.mounted && policy.policy !== 'never' ? 'blocking-available' : 'advisory',
      completion: 'advisory',
      note: 'the adapter reports; only a mounted bridge on a build that honours it can block',
    },
  };
}

// --- CLI ---------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const asJson = process.argv.includes('--json');
  const policyIndex = process.argv.indexOf('--policy');
  const policyOverride = policyIndex > -1 ? process.argv[policyIndex + 1] ?? null : null;
  const report = diagnose({ policyOverride });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('jev-gates × DeepSeek Harness — doctor');
    console.log('');
    console.log(`DSH install:  ${report.install ?? '(not found)'}`);
    console.log(`DSH version:  ${report.dshVersion ?? '(unknown)'}`);
    console.log(`DSH home:     ${report.dshHome}`);
    console.log(`profile:      ${report.profile}`);
    console.log(`policy:       ${report.policy} (${report.policySource})`);
    console.log(`bridge:       ${report.bridge.mounted ? 'mounted' : 'installed but NOT mounted'}`);
    if (!report.bridge.mounted) {
      for (const file of report.bridge.files) console.log(`  checked: ${file} ${existsSync(file) ? '' : '(absent)'}`);
    }
    console.log('');
    console.log('capabilities:');
    for (const cap of report.capabilities) {
      console.log(`  [${cap.verdict.padEnd(12)}] ${cap.capability}`);
      console.log(`                 ${cap.consequence}`);
      console.log(`                 evidence: ${cap.evidence}`);
    }
    console.log('');
    console.log(`status: ${report.status} (exit ${report.exitCode})`);
    console.log(`enforcement: ${report.enforcement.preToolUse} / completion ${report.enforcement.completion}`);
    console.log('');
    console.log('honest summary: this adapter is advisory on this machine. It records what happened and');
    console.log('it can ask or deny where the build supports it; it cannot veto a turn, it cannot undo a');
    console.log('side effect, and it cannot see a structured exit code through the hook payload.');
  }

  process.exitCode = report.exitCode;
}
