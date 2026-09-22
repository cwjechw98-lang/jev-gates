/**
 * A deterministic, offline model provider for runtime acceptance.
 *
 * Why this exists
 * ---------------
 * The tool-pipeline acceptance (`scripts/jev-dsh-acceptance.mjs`) drives
 * `ctx.tools.execute` directly. That proves the pipeline, the guard surface and
 * the Stop handler in isolation, but it cannot prove three things the task asks
 * for:
 *
 *   - that `Stop` works inside a real turn,
 *   - that `agent.steer` is accepted by the real loop,
 *   - that an agent-bound `ask` routes through the real approval service.
 *
 * All three live in the agent loop, and the only way to reach the loop is to be
 * the model. This plugin is that model: it registers a provider route whose
 * `stream()` replays a script written by the scenario plugin.
 *
 * What it proves and what it does not
 * -----------------------------------
 * Every observation produced while this provider is mounted is labelled
 * `real-agent-loop/scripted-provider`. It proves the MECHANISM: the real loop
 * really called a provider, really executed the tool calls that came back,
 * really accepted the steering message and really ran another step. It proves
 * nothing about model quality — the "model" is a JSON file.
 *
 * Adapter contract
 * ----------------
 * `ctx.llm.registerAdapter(providers, adapter)` duck-types its argument: the
 * implementation in `@deepseek-ai/dsh-llm` only reads `providerInfo` and
 * `providerRetryPolicy` at registration time and calls the adapter's methods
 * later, with no `instanceof LlmAdapter` check anywhere (verified by reading
 * `LlmRuntime.prepareRoutes`). A plugin loaded from outside the harness install
 * tree cannot import `@deepseek-ai/*` anyway — that is why `lib/toolspec.mjs`
 * mirrors `defineTool` instead of importing it — so a plain object with the
 * documented defaults is both sufficient and the only option. The failure mode
 * this avoids is real: if registration had required a real subclass, the
 * runner would report `provider-not-called` with the registry's own error
 * rather than pretending the provider ran.
 *
 * Auxiliary calls are never scripted
 * ----------------------------------
 * The composed profile mounts `session-title-first-prompt-llm`, which makes a
 * model call with `purpose: 'session-title'` on the first prompt. That call
 * must not consume a scripted step, or every scenario would be off by one and
 * the count assertions would be measuring the title generator. Calls carrying a
 * `purpose` get a fixed acknowledgement and leave the step counter alone.
 *
 * The provider is a model, not an agent
 * -------------------------------------
 * It emits ordinary assistant messages carrying ordinary tool-call blocks, and
 * it never executes a tool, never touches the tool registry, and never calls
 * `agent.steer`. It also holds no reference to any agent or session. That is not
 * a style preference: a fixture that invoked tools itself would make every
 * "the real loop executed the tool call" assertion vacuous, because the loop
 * would not be the thing that did it.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const name = 'jev-scripted-provider';

/** The `llm` service owns the adapter registry; nothing else is needed. */
export const inject = ['llm'];

/** Provider route this adapter serves. Overridable so two runs cannot collide. */
export const PROVIDER_ID = 'jev-scripted';

/** Model id this route advertises. Advisory only — the adapter accepts anything. */
export const MODEL_ID = 'jev-scripted-1';

/** Text returned for an auxiliary (title/compaction) call. Never consumes a step. */
const AUX_TEXT = 'scripted';

/** Text returned once the script is exhausted. Keeps a runaway turn terminating. */
export const EXHAUSTED_TEXT = 'scripted provider: the response script is exhausted';

/** The empty script. A missing or unreadable script must not fabricate a step. */
export function emptyScript(provider = PROVIDER_ID, model = MODEL_ID) {
  return { provider, model, responses: [] };
}

/**
 * Normalise whatever was read from disk into the shape the streamer expects.
 * Pure. A malformed script yields an empty script rather than a half-applied
 * one, because a partially honoured script is worse than none: it makes the
 * provider look nondeterministic.
 * @param {unknown} raw - parsed script JSON.
 * @returns {{provider: string, model: string, responses: object[]}}
 */
export function normaliseScript(raw) {
  if (raw === null || typeof raw !== 'object') return emptyScript();
  const responses = Array.isArray(raw.responses) ? raw.responses.filter((r) => r && typeof r === 'object' && Array.isArray(r.blocks)) : [];
  return {
    provider: typeof raw.provider === 'string' && raw.provider.length > 0 ? raw.provider : PROVIDER_ID,
    model: typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : MODEL_ID,
    responses,
  };
}

/**
 * The response for one conversation step. Pure.
 *
 * It advances through the script and then stops: once the script is exhausted
 * the same terminal response is returned forever, so a loop that keeps asking
 * cannot be mistaken for a loop that keeps producing new content.
 * @param {{responses: object[]}} script - normalised script.
 * @param {number} index - zero-based conversation call index.
 * @returns {object} the response record for that step.
 */
export function pickResponse(script, index) {
  const responses = script?.responses ?? [];
  if (index >= 0 && index < responses.length) return responses[index];
  return { label: 'exhausted', stop: 'stop', blocks: [{ type: 'text', text: EXHAUSTED_TEXT }] };
}

/** Whether the script has a response for this index (i.e. the step is scripted). */
export function isScripted(script, index) {
  return index >= 0 && index < (script?.responses?.length ?? 0);
}

/** One block as the JSON argument string a provider would put on the wire. */
function argumentsOf(block) {
  const value = block.arguments ?? {};
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

/**
 * Expand one response record into the exact `StreamChunk` sequence for it. Pure.
 *
 * The emitted stream is deliberately ordinary: `block-start`, the deltas, the
 * closing `block-end` carrying the assembled block, then `usage`, then the
 * single terminal `finish`. The assembler treats `block-end` as authoritative
 * and tolerates delta-only streams, so this shape is well-formed on both paths.
 * A malformed stream would surface as a provider bug and make every downstream
 * assertion meaningless.
 * @param {object} response - one script response.
 * @returns {object[]} the chunk sequence.
 */
export function chunksForResponse(response) {
  const chunks = [];
  const blocks = Array.isArray(response?.blocks) ? response.blocks : [];
  blocks.forEach((block, index) => {
    if (block?.type === 'tool-call') {
      const callId = typeof block.id === 'string' && block.id.length > 0 ? block.id : `call-${index}`;
      const callName = typeof block.name === 'string' ? block.name : '';
      const raw = argumentsOf(block);
      chunks.push({ type: 'block-start', index, blockType: 'tool-call' });
      chunks.push({ type: 'tool-call-delta', index, id: callId, name: callName, argumentsDelta: raw });
      chunks.push({ type: 'block-end', index, block: { type: 'tool-call', id: callId, name: callName, arguments: raw } });
      return;
    }
    if (block?.type === 'reasoning') {
      const text = String(block.text ?? '');
      chunks.push({ type: 'block-start', index, blockType: 'reasoning' });
      chunks.push({ type: 'reasoning-delta', index, text });
      chunks.push({ type: 'block-end', index, block: { type: 'reasoning', text } });
      return;
    }
    const text = String(block?.text ?? '');
    chunks.push({ type: 'block-start', index, blockType: 'text' });
    chunks.push({ type: 'text-delta', index, text });
    chunks.push({ type: 'block-end', index, block: { type: 'text', text } });
  });
  chunks.push({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
  chunks.push({ type: 'finish', reason: { kind: response?.stop === 'tool-calls' ? 'tool-calls' : 'stop' } });
  return chunks;
}

/**
 * The assistant message an already-assembled response would produce. Pure.
 *
 * Used by the offline test to check the stream shape without a harness, and by
 * the provider to record what it claimed to emit, so a report can be compared
 * against the chunks instead of trusting them.
 * @param {object} response - one script response.
 * @returns {object[]} the content blocks.
 */
export function blocksForResponse(response) {
  const blocks = Array.isArray(response?.blocks) ? response.blocks : [];
  return blocks.map((block) =>
    block?.type === 'tool-call'
      ? { type: 'tool-call', id: block.id, name: block.name, arguments: argumentsOf(block) }
      : { type: 'text', text: String(block?.text ?? '') },
  );
}

/** Read the last user-role text in a request, truncated. Evidence, not a decision. */
export function lastUserText(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const text = (message.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('');
    if (text.length > 0) return text.slice(0, 300);
  }
  return null;
}

/**
 * Every user-role text in a request, truncated and bounded. Evidence, not a decision.
 *
 * `lastUserText` alone cannot answer "did the steering text reach the model":
 * the loop appends its own runtime-context and skill-catalog messages as
 * user-role turns, so the LAST user message is usually harness furniture rather
 * than the steer. The full bounded list is what makes the question decidable.
 *
 * @param {object[]} messages - the request messages.
 * @param {number} limit - how many trailing user messages to keep.
 * @returns {string[]}
 */
export function userTexts(messages, limit = 6) {
  if (!Array.isArray(messages)) return [];
  const texts = [];
  for (const message of messages) {
    if (message?.role !== 'user') continue;
    const text = (message.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('');
    if (text.length > 0) texts.push(text.slice(0, 300));
  }
  return texts.slice(-limit);
}

/** Append one JSON line, or do nothing. A log must never change the run. */
function appendJsonLine(path, record) {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    /* a log that cannot be written is not a failure of the thing under test */
  }
}

/**
 * The provider half. Plain object, not a subclass — see the module comment.
 * @param {object} state - mutable counters and sinks owned by the plugin fiber.
 * @returns {object} an adapter accepted by `ctx.llm.registerAdapter`.
 */
export function createAdapter(state) {
  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: 'JEV scripted test provider (offline)' };
    },
    providerRetryPolicy() {
      return undefined;
    },
    imageRequestPricing() {
      return undefined;
    },
    listModels() {
      return Promise.resolve([{ provider: state.provider, id: state.model, name: 'JEV scripted model' }]);
    },
    resolveModel(provider, model) {
      return Promise.resolve({ provider, id: model, name: 'JEV scripted model' });
    },
    async prepareCall(provider, model) {
      return { model: await adapter.resolveModel(provider, model), stream: (options) => adapter.stream(options) };
    },
    async *stream(options) {
      const script = state.script();
      const aux = typeof options?.purpose === 'string' && options.purpose.length > 0;
      const index = aux ? -1 : state.conversationCalls;

      const response = aux ? { label: `aux:${options.purpose}`, stop: 'stop', blocks: [{ type: 'text', text: AUX_TEXT }] } : pickResponse(script, index);
      if (aux) state.auxCalls += 1;
      else state.conversationCalls += 1;
      state.lastLabel = response.label;

      appendJsonLine(state.outPath, {
        at: new Date().toISOString(),
        provider: options?.provider ?? null,
        model: options?.model ?? null,
        purpose: options?.purpose ?? null,
        aux,
        conversationIndex: index,
        label: response.label,
        scripted: !aux && isScripted(script, index),
        messageCount: Array.isArray(options?.messages) ? options.messages.length : null,
        lastUserText: lastUserText(options?.messages),
        blocks: blocksForResponse(response),
      });
      if (!aux) {
        state.calls.push({
          index,
          label: response.label,
          scripted: isScripted(script, index),
          lastUserText: lastUserText(options?.messages),
          userTexts: userTexts(options?.messages),
          messageCount: Array.isArray(options?.messages) ? options.messages.length : null,
        });
      }
      state.writeSummary();

      for (const chunk of chunksForResponse(response)) yield chunk;
    },
  };
  return adapter;
}

/**
 * Mount the scripted provider.
 *
 * The script is read lazily on every call, not cached at mount: the scenario
 * plugin writes it during its own `apply()`, and the load order of two sibling
 * rows is not part of any contract. Reading per call removes that dependency
 * entirely and makes the provider's behaviour a function of the file on disk.
 * @param {object} ctx - Cordis context carrying `llm`.
 * @param {object} [config] - optional `{provider, model, scriptPath, outPath}`.
 */
export function apply(ctx, config = {}) {
  const env = process.env;
  const state = {
    provider: config.provider ?? env.JEV_PROVIDER_ID ?? PROVIDER_ID,
    model: config.model ?? env.JEV_MODEL_ID ?? MODEL_ID,
    scriptPath: config.scriptPath ?? env.JEV_SCRIPT_PATH ?? null,
    outPath: config.outPath ?? env.JEV_PROVIDER_OUT ?? null,
    conversationCalls: 0,
    auxCalls: 0,
    lastLabel: null,
    calls: [],
    script: () => {
      if (!state.scriptPath) return emptyScript(state.provider, state.model);
      try {
        return normaliseScript(JSON.parse(readFileSync(state.scriptPath, 'utf8')));
      } catch {
        return emptyScript(state.provider, state.model);
      }
    },
    writeSummary: () => {
      if (!state.outPath) return;
      try {
        mkdirSync(dirname(state.outPath), { recursive: true });
        writeFileSync(
          state.outPath,
          JSON.stringify(
            {
              mode: 'real-agent-loop/scripted-provider',
              provider: state.provider,
              model: state.model,
              scriptPath: state.scriptPath,
              conversationCalls: state.conversationCalls,
              auxCalls: state.auxCalls,
              lastLabel: state.lastLabel,
              calls: state.calls,
            },
            null,
            2,
          ),
          'utf8',
        );
      } catch {
        /* as above */
      }
    },
  };

  ctx.llm.registerAdapter([state.provider], createAdapter(state));
  state.writeSummary();
}
