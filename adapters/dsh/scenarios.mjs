/**
 * Acceptance scenarios for the native DSH adapter.
 *
 * This plugin is the TEST, not the thing under test. It mounts beside
 * `plugin.mjs` in an isolated profile, registers a safe marker tool, and drives
 * `ctx.tools.execute` — the same entry point the agent loop uses. So a denial
 * observed here is a denial on the real path, not a parser agreeing with itself.
 *
 * Nothing dangerous is executed: the "irreversible" tool writes a marker file
 * and is declared to require authorisation by a test rule. No force-push, no
 * deletion, no network.
 *
 * Results are written as JSON for `scripts/jev-dsh-acceptance.mjs` to judge. The
 * scenario plugin never decides whether the run passed — it only reports what it
 * observed, because a test that grades itself is not a test.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { claimPath, writeClaim, clearClaim } from './claim.mjs';
import { readClaim } from './claim.mjs';

export const name = 'jev-scenarios';
export const inject = ['tools', 'loader'];

/** The tool that requires authorisation. Writes a marker; does nothing else. */
const MARKER = 'jev_marker';
/** An ordinary, reversible tool. Must never be blocked. */
const BENIGN = 'jev_benign';
/** A tool another guard owns. This adapter must not weaken that guard. */
const FOREIGN = 'jev_foreign';

export function apply(ctx) {
  const dir = process.env.JEV_SCENARIO_DIR;
  const out = process.env.JEV_SCENARIO_OUT;
  const set = process.env.JEV_SCENARIO_SET ?? 'shadow';
  const env = process.env;
  if (!dir || !out) return;

  ctx.effect(async () => {
    const observations = [];
    const note = (name, value) => observations.push({ name, ...value });
    const marker = (n) => `${dir}/${n}.marker`;

    try {
      await ctx.loader?.await();

      // ---- the tools under test -------------------------------------------
      const register = (toolName, body) => {
        try {
          ctx.tools.register({
            name: toolName,
            description: `Acceptance tool ${toolName}.`,
            parameters: { path: { type: 'string', required: true, description: 'marker path' } },
            output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
            execute: async (args) => body(String(args.path)),
          });
          return true;
        } catch (error) {
          note(`register:${toolName}`, { ok: false, error: String(error?.message ?? error) });
          return false;
        }
      };
      register(MARKER, (p) => {
        writeFileSync(p, 'marker', 'utf8');
        return `wrote ${p}`;
      });
      register(BENIGN, (p) => {
        writeFileSync(p, 'benign', 'utf8');
        return `wrote ${p}`;
      });
      register(FOREIGN, (p) => {
        writeFileSync(p, 'foreign', 'utf8');
        return `wrote ${p}`;
      });

      // A guard owned by "another system". Monotonic, exactly like ours, and the
      // point of the test is that our adapter does not cancel it.
      ctx.tools.guard((exec) => (exec.name === FOREIGN ? 'foreign-guard: this tool is reserved by another policy' : undefined));

      const call = async (toolName, path) => {
        if (existsSync(path)) rmSync(path);
        try {
          const result = await ctx.tools.execute({
            callId: `call-${toolName}-${observations.length}`,
            name: toolName,
            arguments: { path },
            signal: new AbortController().signal,
          });
          return {
            isError: result?.isError === true,
            reason: result?.error?.message ?? null,
            markerExists: existsSync(path),
            content: JSON.stringify(result?.content ?? null).slice(0, 200),
          };
        } catch (error) {
          return { threw: String(error?.message ?? error), markerExists: existsSync(path) };
        }
      };

      // ---- per-set scenarios ----------------------------------------------
      if (set === 'shadow') {
        note('shadow:marker-tool', await call(MARKER, marker('shadow-marker')));
        note('shadow:benign-tool', await call(BENIGN, marker('shadow-benign')));
      }

      if (set === 'enforce') {
        note('enforce:marker-tool', await call(MARKER, marker('enforce-marker')));
        note('enforce:benign-tool', await call(BENIGN, marker('enforce-benign')));
        note('enforce:foreign-guard', await call(FOREIGN, marker('enforce-foreign')));
        note('enforce:foreign-marker-exists', { value: existsSync(marker('enforce-foreign')) });
      }

      if (set === 'never') {
        note('never:marker-tool', await call(MARKER, marker('never-marker')));
        note('never:benign-tool', await call(BENIGN, marker('never-benign')));
      }

      if (set === 'failure') {
        note('failure:marker-tool', await call(MARKER, marker('failure-marker')));
        note('failure:benign-tool', await call(BENIGN, marker('failure-benign')));
      }

      if (set === 'stop') {
        // The claim and the request are written here so the Stop path is driven
        // by the same code a session would use, not by a hand-made file.
        const failingRequest = `${dir}/stop-fail.json`;
        const passingRequest = `${dir}/stop-pass.json`;
        const present = `${dir}/stop-present.txt`;
        writeFileSync(present, 'this artifact exists', 'utf8');
        writeFileSync(
          failingRequest,
          JSON.stringify({
            schemaVersion: 2,
            taskId: 'stop-task',
            runId: 'stop-run',
            mode: 'completion',
            criteria: [
              {
                id: 'artifact-present',
                text: 'the artifact exists',
                kind: 'deterministic',
                required: true,
                verificationScope: [`${dir}/stop-absent.txt`],
                check: { type: 'artifact_exists' },
              },
            ],
            claims: { task: 'stop scenario', claimed: 'the artifact is present' },
          }),
          'utf8',
        );
        writeFileSync(
          passingRequest,
          JSON.stringify({
            schemaVersion: 2,
            taskId: 'stop-task-ok',
            runId: 'stop-run-ok',
            mode: 'completion',
            criteria: [
              {
                id: 'artifact-present',
                text: 'the artifact exists',
                kind: 'deterministic',
                required: true,
                verificationScope: [present],
                check: { type: 'artifact_exists' },
              },
            ],
            claims: { task: 'stop scenario ok', claimed: 'the artifact is present' },
          }),
          'utf8',
        );

        const drive = async (sessionId, turn, { aborted = false, record = null } = {}) => {
          clearClaim({ sessionId, env });
          if (record) writeClaim({ sessionId, env, ...record });
          const steers = [];
          const agent = {
            id: `agent-${sessionId}`,
            session: { id: sessionId, append() {} },
            steer(message) {
              steers.push(message);
            },
          };
          const controller = new AbortController();
          if (aborted) controller.abort();
          try {
            await ctx.serial(null, 'agent/turn-stopping', { agent, turn, signal: controller.signal });
          } catch (error) {
            return { dispatched: false, error: String(error?.message ?? error), steers: steers.length };
          }
          return { dispatched: true, steers: steers.length, message: steers[0]?.content?.[0]?.text ?? null, claimStillPending: readClaim({ sessionId, env }) !== null };
        };

        // The claim is the STRING; the identity fields travel beside it, which is
        // what the anti-loop key is built from.
        const absent = `/stop-absent.txt`;
        const failRecord = { claim: 'the artifact is present', request: failingRequest, taskId: 'stop-task', promptId: 'p1', collect: [absent] };
        note('stop:first', await drive('session-stop-a', 1, { record: failRecord }));
        note('stop:repeat-same-key', await drive('session-stop-a', 1, { record: failRecord }));
        note('stop:cancelled', await drive('session-stop-a', 2, { aborted: true, record: failRecord }));
        note('stop:new-evidence', await drive('session-stop-a', 3, { record: { ...failRecord, snapshotDigest: 'new-snapshot' } }));
        note('stop:other-session', await drive('session-stop-b', 1, { record: failRecord }));
        note('stop:confirmed', await drive('session-stop-c', 1, { record: { claim: 'the artifact is present', request: passingRequest, taskId: 'stop-task-ok', promptId: 'p1', collect: [present] } }));
        note('stop:no-claim', await drive('session-stop-d', 1, {}));
        note('stop:claim-files', { value: ['session-stop-a', 'session-stop-b', 'session-stop-c', 'session-stop-d'].map((s) => ({ session: s, path: claimPath(s, env) })) });
      }
    } catch (error) {
      note('fatal', { error: String(error?.stack ?? error) });
    }

    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(out, JSON.stringify({ set, harnessVersion: process.env.JEV_HARNESS_VERSION ?? null, observations }, null, 2), 'utf8');
    } catch {
      /* the runner reports a missing result as its own failure */
    }
    process.exit(0);
  }, 'jev-scenarios');
}
