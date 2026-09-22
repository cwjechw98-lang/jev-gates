/**
 * Isolated runtime acceptance for the jev-gates DSH adapter.
 *
 * This is not a simulation of the harness. It is the harness: the real process,
 * the real plugin loader, the real `@deepseek-ai/dsh-hooks-claude-code` bridge,
 * the real `tools/pre-execute` waterfall, the real hook spawn and the real
 * protocol parser. What it removes is the model, which PreToolUse does not need.
 *
 * It drives two tool dispatches and writes what happened to a result file:
 *
 *   1. an irreversible command (`git push --force`) that the adapter must deny;
 *   2. a benign command (`git status`) that the adapter must leave alone.
 *
 * For the first, the marker command is executed ONLY if the decision was not a
 * denial — so a marker file appearing means the gate let it through.
 *
 * This probe registers no listener of its own. A waterfall listener that does
 * not call `next()` stops the chain, so an observant probe would silently
 * replace the thing it is measuring; that mistake was made here once and
 * produced a confident, wrong "allow".
 */
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const name = 'jev-iso-acceptance';
export const inject = [];

export function apply(ctx) {
  const resultPath = process.env.JEV_ISO_RESULT;
  const markerPath = process.env.JEV_ISO_MARKER;
  if (!resultPath || !markerPath) return;

  const finish = (payload) => {
    try {
      writeFileSync(resultPath, JSON.stringify(payload, null, 2), 'utf8');
    } catch {
      // A failed write must not leave the process hanging.
    }
    process.exit(0);
  };

  ctx.inject(['loader'], (c) => {
    c.effect(async () => {
      try {
        await c.loader?.await();

        // The dispatch the harness itself performs, on the event the bridge
        // listens to. `next` is what a listener calls when it has no opinion.
        const dispatch = (label, command) =>
          c.waterfall(
            'tools/pre-execute',
            { name: 'Bash', arguments: { command }, callId: `iso-${label}`, agent: undefined, signal: undefined },
            () => ({ kind: 'allow' }),
          );

        const forbidden = await dispatch('forbidden', 'git push --force origin main');
        const benign = await dispatch('benign', 'git status');

        // The bridge never surfaces a hook's stderr unless the hook belongs to an
        // open turn, so "the hook failed to launch" and "the gate chose to stay
        // silent" look identical from outside. Run one hook here and keep the raw
        // outcome, including whatever the executor said. The package URL comes
        // from the runner so no machine path lives in this file.
        let direct = null;
        try {
          const protocolUrl = process.env.JEV_DSH_HOOK_PROTOCOL;
          if (!protocolUrl) {
            direct = { skipped: 'JEV_DSH_HOOK_PROTOCOL was not set' };
          } else {
            const { runHook } = await import(protocolUrl);
            direct = await runHook(
              c.get('shell'),
              { command: `node -e "require('fs').appendFileSync('${markerPath}.direct','ran')"` },
              {
                payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } },
                defaultTimeoutMs: 30_000,
                trailingNewline: true,
                expectedEventName: 'PreToolUse',
              },
              () => Date.now(),
            );
          }
        } catch (error) {
          direct = { threw: String(error && error.stack ? error.stack : error) };
        }

        // Act on the decision exactly as the loop does: run the command only if
        // it was not denied. If this file appears, the gate did not hold.
        let markerRan = false;
        if (forbidden?.kind !== 'deny') {
          try {
            execFileSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'the denied command ran')`], { stdio: 'ignore' });
            markerRan = true;
          } catch {
            markerRan = false;
          }
        }

        finish({
          harnessVersion: process.env.JEV_ISO_DSH_VERSION ?? null,
          forbidden: forbidden ?? null,
          benign: benign ?? null,
          markerRan,
          directHook: direct,
          checkedAt: new Date().toISOString(),
        });
      } catch (error) {
        finish({ error: String(error && error.stack ? error.stack : error) });
      }
    }, 'jev-iso-acceptance');
  });
}
