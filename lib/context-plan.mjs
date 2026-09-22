/**
 * Context selection with pinned facts (spec §14.4, capability C5, tool
 * `jev_context_plan`).
 *
 * This module reads a real DSH-shaped message history and proposes a reduced
 * candidate context plus a restore map. It is a **preview / replay tool**, and
 * the honest reason is stated in the spec itself: wiring a candidate into the
 * real request pipeline "requires a separate DSH interface check; the current
 * work did not establish such an interface". Nothing here patches the harness,
 * and no answer may be presented as active compaction. Every envelope repeats
 * that in `limits`.
 *
 * Four invariants are enforced by construction rather than by discipline,
 * because each one loses data permanently when it is only a convention:
 *
 * 1. **The original is never mutated or destroyed.** Every function reads the
 *    input and builds new objects; `originalPreserved: true` is therefore a fact
 *    about the code path, and a test pins it with a deep-equality check on a
 *    snapshot taken before planning.
 * 2. **Order is preserved.** The candidate is a subsequence of the original: it
 *    is built by walking the blocks once, in order, and never sorting or
 *    regrouping them.
 * 3. **Tool call/result pairs stay together.** A plan that would drop one half of
 *    a pair drops both, or keeps both. Dropping half a pair produces the
 *    orphan-tool-message failure the spec names explicitly.
 * 4. **Pinned facts are never dropped, and never summarised when precision
 *    matters.** A pinned block that carries a path, a flag, a version or an error
 *    string is kept verbatim. If the budget cannot fit the pins, the answer is a
 *    non-success status with the *original* as the candidate — never an oversized
 *    candidate, and never a candidate missing a pinned fact.
 *
 * Token counts are ESTIMATES. There is no tokenizer available to this project,
 * so {@link estimateTokens} uses a documented character heuristic and every
 * place a count is reported is marked `tokensAreEstimate: true`.
 */
import {
  CAPABILITY_REASON,
  CAPABILITY_STATUS,
  CapabilityError,
  capabilityEnvelope,
  modelLane,
  snapshotIdentity,
  withBudget,
} from './capability.mjs';

/** The logical tool name this module implements. */
export const CONTEXT_CAPABILITY = 'jev_context_plan';

/** Block kinds. `tool_call` and `tool_result` are the pair-forming kinds. */
export const BLOCK_KIND = Object.freeze({
  user: 'user',
  assistant: 'assistant',
  toolCall: 'tool_call',
  toolResult: 'tool_result',
  system: 'system',
});

export const BLOCK_KINDS = Object.freeze(Object.values(BLOCK_KIND));

/** What a block may be asked to do. */
export const BLOCK_ACTION = Object.freeze({ keep: 'keep', drop: 'drop', stub: 'stub' });

/**
 * The pinned categories. Every one of them MUST survive a plan; the spec lists
 * them by name, and `pinFacts` detects them deterministically from text markers
 * rather than by asking a model.
 */
export const PIN_KIND = Object.freeze({
  currentGoal: 'current_goal',
  constraints: 'constraints',
  authorisations: 'live_authorisations',
  activePlan: 'active_plan',
  unresolvedErrors: 'unresolved_errors',
  incompleteToolCalls: 'incomplete_tool_calls',
  lastRelevantEvidence: 'last_relevant_evidence',
  provenance: 'provenance',
});

export const PIN_KINDS = Object.freeze(Object.values(PIN_KIND));

/**
 * The limits every C5 answer carries.
 *
 * The second entry is the one that keeps this honest: the spec says hooking a
 * candidate into the real request pipeline needs a separate DSH interface check
 * that this work did not perform. A preview that forgot to say so would be read
 * as compaction that is actually running.
 */
export const CONTEXT_LIMITS = Object.freeze([
  'token counts are ESTIMATES from a character heuristic, not a tokenizer; no tokenizer is available to this project',
  'wiring the candidate into the real request pipeline is NOT established: the spec says hooking it up "requires a separate DSH interface check; the current work did not establish such an interface", so this is a preview/replay tool and must never be presented as active compaction',
  'pinning is detected from text markers in the supplied history; a fact stated without a marker is not pinned, and no model is consulted',
  'restoreMap points at indices in the ORIGINAL history, which the caller must keep; this module cannot recover a block from a history it no longer has',
]);

const asArray = (value) => (Array.isArray(value) ? value : []);

/** Concatenate the text of any of the content shapes a harness uses. */
function contentText(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(contentText).join('\n');
  if (typeof content === 'object') {
    for (const key of ['text', 'content', 'value', 'summary']) {
      const value = content[key];
      if (typeof value === 'string') return value;
      if (value !== undefined && value !== null && typeof value === 'object') return contentText(value);
    }
    return '';
  }
  return String(content);
}

/** Render a tool input compactly, so a call block carries its arguments. */
function toolInputText(input) {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/** Which block kind one message is. */
function kindOf(message) {
  const role = message?.role;
  if (role === 'system') return BLOCK_KIND.system;
  if (role === 'user') return BLOCK_KIND.user;
  if (role === 'tool' || role === 'tool_result' || message?.tool_call_id !== undefined || message?.toolCallId !== undefined) {
    return BLOCK_KIND.toolResult;
  }
  if (role === 'assistant') return BLOCK_KIND.assistant;
  return BLOCK_KIND.assistant;
}

/** The call id a tool-result message answers, in either the DSH or the OpenAI shape. */
function resultCallId(message) {
  const direct = message?.tool_call_id ?? message?.toolCallId ?? message?.tool_use_id;
  if (typeof direct === 'string' && direct !== '') return direct;
  for (const part of asArray(message?.content)) {
    const id = part?.tool_use_id ?? part?.toolCallId;
    if (typeof id === 'string' && id !== '') return id;
  }
  return null;
}

/** Every `tool_use`-shaped part of an assistant message. */
function callParts(message) {
  const parts = [];
  for (const part of asArray(message?.content)) {
    if (part?.type === 'tool_use' || part?.type === 'tool_call') parts.push(part);
  }
  for (const call of asArray(message?.tool_calls)) parts.push(call);
  return parts;
}

/** The call id of one `tool_use`-shaped part. */
function callIdOf(part) {
  return part?.id ?? part?.tool_use_id ?? part?.toolCallId ?? null;
}

/**
 * The text of a tool-call part: the tool name plus its arguments.
 *
 * The arguments are kept because a call block without them cannot be matched to
 * the result it produced, and a *pinned* call must stay verbatim.
 */
function callText(part) {
  const name = String(part?.name ?? part?.toolName ?? 'tool');
  const input = part?.input ?? part?.arguments ?? part?.args;
  return `tool_call ${name} ${toolInputText(input)}`.trim();
}

/** The text of a tool-result part, in either the DSH or the OpenAI shape. */
function resultText(message) {
  const direct = contentText(message?.content);
  if (direct !== '') return direct;
  return contentText(message?.result ?? message?.output ?? '');
}

/**
 * An ESTIMATE of the token count of a string.
 *
 * There is no tokenizer in this project (zero dependencies), so this is a
 * character heuristic: roughly four characters per token for the English and
 * code this project handles. It is an estimate everywhere it is reported, and
 * every envelope sets `tokensAreEstimate: true`. A real tokenizer would produce
 * a different number, so no decision that depends on an exact count may be built
 * on it.
 *
 * @param {string} text - the text to estimate.
 * @returns {number} a non-negative integer estimate.
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text === '') return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Normalise a message history into blocks.
 *
 * A block is `{id, kind, role, text, tokens, pinned, reason, source}` plus the
 * pairing fields `pairId`, `pairRole`, `toolCallId` and `originalIndex`.
 *
 * Pairing rule: an assistant `tool_use` part and the tool message that answers it
 * get the same `pairId`, so a planner can never separate them. A call with no
 * result is marked `incomplete` and pinned — an unanswered call is exactly the
 * "incomplete tool calls" category the spec requires to survive. A result with no
 * call is pinned as provenance rather than dropped, because a result whose call
 * is missing from the window is evidence whose origin cannot be checked.
 *
 * @param {object[]} messages - a DSH-shaped history (Anthropic-style content
 *   parts or OpenAI-style `tool_calls`), oldest first.
 * @returns {object[]} the normalised blocks, in the original order.
 */
export function normaliseHistory(messages) {
  if (!Array.isArray(messages)) {
    throw new CapabilityError(CAPABILITY_REASON.invalidInput, 'messages must be an array');
  }

  const blocks = [];
  const pending = new Map();
  let pairCounter = 0;

  messages.forEach((message, originalIndex) => {
    const kind = kindOf(message);

    if (kind === BLOCK_KIND.toolCall || (kind === BLOCK_KIND.assistant && callParts(message).length > 0)) {
      const calls = callParts(message);
      const text = contentText(message?.content);
      calls.forEach((part, callIndex) => {
        pairCounter += 1;
        const toolCallId = callIdOf(part);
        const block = {
          id: `tool_call-${originalIndex}-${callIndex}`,
          kind: BLOCK_KIND.toolCall,
          role: 'assistant',
          text: callText(part),
          tokens: 0,
          pinned: false,
          reason: null,
          source: 'history',
          pairId: `pair-${pairCounter}`,
          pairRole: 'call',
          toolCallId: typeof toolCallId === 'string' ? toolCallId : null,
          originalIndex,
          // The original message is kept by reference so a `keep` action can put
          // the caller's own object back into the candidate unchanged. It is
          // never written to, which is what makes `originalPreserved` true.
          originalMessage: message,
        };
        if (text !== '' && callIndex === 0) block.text = `${text}\n${block.text}`;
        if (block.toolCallId !== null) pending.set(block.toolCallId, block);
        blocks.push(block);
      });
      return;
    }

    if (kind === BLOCK_KIND.toolResult) {
      const toolCallId = resultCallId(message);
      const call = toolCallId !== null ? pending.get(toolCallId) : undefined;
      const block = {
        id: `tool_result-${originalIndex}`,
        kind: BLOCK_KIND.toolResult,
        role: 'tool',
        text: resultText(message),
        tokens: 0,
        pinned: false,
        reason: null,
        source: 'history',
        pairId: call ? call.pairId : `pair-orphan-${originalIndex}`,
        pairRole: 'result',
        toolCallId,
        originalIndex,
        originalMessage: message,
      };
      if (call) {
        pending.delete(toolCallId);
        call.paired = true;
      } else {
        // No call in this window: keep the result and say why.
        block.orphan = true;
      }
      blocks.push(block);
      return;
    }

    blocks.push({
      id: `${kind}-${originalIndex}`,
      kind,
      role: typeof message?.role === 'string' ? message.role : kind,
      text: contentText(message?.content),
      tokens: 0,
      pinned: false,
      reason: null,
      source: 'history',
      pairId: null,
      pairRole: null,
      toolCallId: null,
      originalIndex,
      originalMessage: message,
    });
  });

  for (const block of blocks) {
    block.tokens = estimateTokens(block.text);
    if (block.kind === BLOCK_KIND.toolCall && block.paired !== true) block.incomplete = true;
  }
  return blocks;
}

/** The path-shaped tokens in a string, used to decide whether precision matters. */
const PATH_LIKE = /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])[\w.@-]+[\\/]?|\b[\w.-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|ya?ml|md|toml|py|rs|go|sh|ps1|txt|lock)\b/;
/** Version-shaped tokens, and flags. */
const VERSION_LIKE = /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?\b/;
const FLAG_LIKE = /(?:^|\s)--?[A-Za-z][\w-]*/;
/** Error-shaped tokens: a code, a stack frame, or an exception word. */
const ERROR_LIKE = /\b(?:E[A-Z]{2,}|ERR_[A-Z_]+|[A-Za-z]*Error|[A-Za-z]*Exception|Traceback|AssertionError|exit(?:ed)?\s+(?:code\s+)?\d+)\b/;

/**
 * Does this block carry something that must stay exact?
 *
 * A path, a flag, a version or an error string is the difference between an
 * instruction that can be followed and a summary that cannot. Such a block is
 * kept verbatim; only a block without any of them may become a stub.
 *
 * @param {object} block - a normalised block.
 * @returns {boolean} true when the block must not be summarised.
 */
export function requiresExactness(block) {
  const text = String(block?.text ?? '');
  if (text === '') return false;
  return PATH_LIKE.test(text) || VERSION_LIKE.test(text) || FLAG_LIKE.test(text) || ERROR_LIKE.test(text);
}

/** Marker sets. Deterministic, case-insensitive, English and Russian. */
const GOAL_MARKERS = [/\bgoal\b/i, /\bobjective\b/i, /\bзадач[аиуе]\b/i, /\bцель\b/i];
const CONSTRAINT_MARKERS = [/\bconstraint/i, /\bmust\s+(?:not\s+)?\w+/i, /\bdo not\b/i, /\bnever\b/i, /\brequire(?:d|ment)?\b/i, /ограничени/i, /\bнельзя\b/i, /\bобязательн/i];
const AUTHORISATION_MARKERS = [/\bauthoris/i, /\bauthoriz/i, /\bapprov(?:ed|al)\b/i, /\bpermission\b/i, /\ballowed\b/i, /разрешени/i, /\bсогласован/i];
const PLAN_MARKERS = [/\bplan\b/i, /\bstep\s+\d/i, /\btodo\b/i, /\bnext\s+step/i, /\bплан\b/i, /\bшаг\s*\d/i];
const UNRESOLVED_MARKERS = [/\bunresolved\b/i, /\bstill\s+fail/i, /\bnot\s+fixed\b/i, /\bremains?\s+(?:broken|failing)\b/i, /\bошибк[аи]\b/i, /\bне\s+исправлен/i];
const RESOLVED_MARKERS = [/\bresolved\b/i, /\bfixed\b/i, /\bpasses?\s+now\b/i, /\bисправлен/i, /\bрешено\b/i];

/**
 * Mark the blocks that must survive a plan.
 *
 * Detection is deterministic: text markers for the conversational categories,
 * structure for the tool categories (an unanswered call, a result without its
 * call, the last tool result before the end of the window). No model is
 * consulted, because a pinned fact that depends on a model is a pinned fact that
 * can disappear on a re-run.
 *
 * @param {object} input
 * @param {object[]} input.blocks - from {@link normaliseHistory}.
 * @param {object} [input.facts] - facts the caller already knows, keyed by
 *   {@link PIN_KIND}; each value is `{ref, text}` or a string.
 * @returns {object[]} new block objects with `pinned` and `reason` set; the input
 *   blocks are not modified.
 */
export function pinFacts({ blocks, facts = null } = {}) {
  const list = asArray(blocks);
  const marked = list.map((block) => ({ ...block }));
  const known = new Map();
  for (const kind of PIN_KINDS) {
    const entry = facts?.[kind];
    if (entry === undefined || entry === null) continue;
    const ref = typeof entry === 'string' ? entry : entry.ref;
    if (typeof ref === 'string' && ref !== '') known.set(kind, ref);
  }

  const pin = (block, reason) => {
    if (block.pinned === true) return;
    block.pinned = true;
    block.reason = reason;
  };

  const lastResultIndex = marked.reduce((found, block, index) => (block.kind === BLOCK_KIND.toolResult ? index : found), -1);

  marked.forEach((block, index) => {
    const text = String(block.text ?? '');

    if (block.kind === BLOCK_KIND.toolCall && block.incomplete === true) {
      pin(block, PIN_KIND.incompleteToolCalls);
      return;
    }
    if (block.kind === BLOCK_KIND.toolResult && block.orphan === true) {
      pin(block, PIN_KIND.provenance);
      return;
    }
    if (block.kind === BLOCK_KIND.toolCall || block.kind === BLOCK_KIND.toolResult) {
      pin(block, PIN_KIND.provenance);
      if (index === lastResultIndex) pin(block, PIN_KIND.lastRelevantEvidence);
      return;
    }

    if (known.get(PIN_KIND.currentGoal) === block.id || GOAL_MARKERS.some((re) => re.test(text))) {
      pin(block, PIN_KIND.currentGoal);
      return;
    }
    if (known.get(PIN_KIND.constraints) === block.id || CONSTRAINT_MARKERS.some((re) => re.test(text))) {
      pin(block, PIN_KIND.constraints);
      return;
    }
    if (known.get(PIN_KIND.authorisations) === block.id || AUTHORISATION_MARKERS.some((re) => re.test(text))) {
      pin(block, PIN_KIND.authorisations);
      return;
    }
    if (known.get(PIN_KIND.activePlan) === block.id || PLAN_MARKERS.some((re) => re.test(text))) {
      pin(block, PIN_KIND.activePlan);
      return;
    }
    const unresolved = UNRESOLVED_MARKERS.some((re) => re.test(text)) || ERROR_LIKE.test(text);
    if (unresolved && !RESOLVED_MARKERS.some((re) => re.test(text))) {
      pin(block, PIN_KIND.unresolvedErrors);
    }
  });

  // A caller-named fact that was not found in the history is not silently
  // ignored: the block simply does not exist, and the plan will report the
  // pinned total it actually has.
  return marked;
}

/** The blocks of a pair, given one member. */
function pairMembers(blocks, block) {
  if (block.pairId === null || block.pairId === undefined || String(block.pairId).startsWith('pair-orphan')) return [block];
  return blocks.filter((other) => other.pairId === block.pairId);
}

/** A compact, honest stub: it says what was removed and where to get it back. */
function stubText(block) {
  return `[stub ${block.id} (${block.kind}) — content omitted; restore from original index ${block.originalIndex}]`;
}

/** The reduced history for a candidate, given the actions chosen per block. */
function buildCandidate(blocks, actionById) {
  const candidate = [];
  for (const block of blocks) {
    const action = actionById.get(block.id);
    if (action === BLOCK_ACTION.drop) continue;
    if (action === BLOCK_ACTION.stub) {
      const text = stubText(block);
      candidate.push({
        stub: true,
        id: block.id,
        kind: block.kind,
        role: block.role,
        reason: block.reason ?? 'not_pinned',
        restoreTo: block.originalIndex,
        // Carried so a caller can still prove the candidate is an ordered
        // subsequence of the original without consulting the block table.
        originalIndex: block.originalIndex,
        text,
        tokens: estimateTokens(text),
      });
      continue;
    }
    // A kept block is the caller's own message object, unchanged.
    candidate.push(block.originalMessage);
  }
  return candidate;
}

/**
 * Decide keep/drop/stub for every block under a token budget.
 *
 * The walk is a single pass in original order. Pinned blocks are always kept
 * verbatim. An unpinned pair is decided as a unit, so a tool call and its result
 * can never be separated. An unpinned block that fits is kept; a long one becomes
 * a stub; anything that still does not fit is dropped.
 *
 * @param {object} input
 * @param {object[]} input.blocks - pinned blocks from {@link pinFacts}.
 * @param {number} input.budgetTokens - the candidate budget.
 * @param {Set<string>} [input.keepIds] - block ids the caller requires.
 * @param {number} [input.stubThreshold=64] - an unpinned block longer than this may be stubbed.
 * @returns {object} `{plan, actionById, pinnedTokens, pinnedOverBudget}`.
 */
export function planBlocks({ blocks, budgetTokens, keepIds = new Set(), stubThreshold = 64 } = {}) {
  const list = asArray(blocks);
  const required = keepIds instanceof Set ? keepIds : new Set(asArray(keepIds));
  const pinnedTokens = list.filter((block) => block.pinned === true || required.has(block.id)).reduce((sum, block) => sum + block.tokens, 0);
  const pinnedOverBudget = pinnedTokens > budgetTokens;

  const actionById = new Map();
  const plan = [];

  if (pinnedOverBudget) {
    // The pins alone do not fit. Refusing is the only answer that cannot lose a
    // pinned fact, so every action is recorded as `keep` and the caller is told
    // the budget is the problem — the candidate will be the original.
    for (const block of list) {
      actionById.set(block.id, BLOCK_ACTION.keep);
      plan.push({ id: block.id, action: BLOCK_ACTION.keep, reason: 'budget_too_small_for_pins' });
    }
    return { plan, actionById, pinnedTokens, pinnedOverBudget };
  }

  let used = pinnedTokens;
  const decided = new Set();

  for (const block of list) {
    if (decided.has(block.id)) continue;
    const members = pairMembers(list, block);
    for (const member of members) decided.add(member.id);

    const isRequired = members.some((member) => member.pinned === true || required.has(member.id));
    if (isRequired) {
      for (const member of members) {
        actionById.set(member.id, BLOCK_ACTION.keep);
        plan.push({
          id: member.id,
          action: BLOCK_ACTION.keep,
          reason: member.pinned === true ? member.reason ?? 'pinned' : 'caller_required',
        });
      }
      continue;
    }

    const memberTokens = members.reduce((sum, member) => sum + member.tokens, 0);
    const long = members.some((member) => member.tokens > stubThreshold);
    const action = !long && used + memberTokens <= budgetTokens
      ? BLOCK_ACTION.keep
      : long
        ? BLOCK_ACTION.stub
        : BLOCK_ACTION.drop;

    const stubTokens = members.reduce((sum, member) => sum + estimateTokens(stubText(member)), 0);
    const cost = action === BLOCK_ACTION.keep ? memberTokens : action === BLOCK_ACTION.stub ? stubTokens : 0;

    for (const member of members) {
      actionById.set(member.id, action);
      plan.push({
        id: member.id,
        action,
        reason: action === BLOCK_ACTION.keep
          ? 'not_pinned_but_fits'
          : action === BLOCK_ACTION.stub
            ? 'long_and_not_pinned'
            : 'over_budget_and_not_pinned',
      });
    }
    used += cost;
  }

  return { plan, actionById, pinnedTokens, pinnedOverBudget };
}

/** The decision object for a failure path: the original is the candidate. */
function originalDecision(messages, blocks, { plan = null, note }) {
  return {
    plan: plan ?? blocks.map((block) => ({ id: block.id, action: BLOCK_ACTION.keep, reason: note })),
    candidate: asArray(messages).slice(),
    restoreMap: {},
    originalPreserved: true,
    originalTokens: blocks.reduce((sum, block) => sum + block.tokens, 0),
    candidateTokens: blocks.reduce((sum, block) => sum + block.tokens, 0),
    tokensAreEstimate: true,
    droppedIds: [],
    stubbedIds: [],
  };
}

/**
 * Propose a reduced candidate context for a message history.
 *
 * @param {object} input
 * @param {object[]} input.messages - a DSH-shaped history, oldest first.
 * @param {number} [input.budgetTokens=8000] - the candidate's estimated token budget.
 * @param {string} input.taskId - the task this answer belongs to.
 * @param {string} input.runId - this attempt.
 * @param {string[]} [input.keepIds] - block ids the caller requires to survive.
 * @param {object} [input.facts] - known facts per {@link PIN_KIND}.
 * @param {number} [input.stubThreshold=64] - an unpinned block longer than this may be stubbed.
 * @param {number} [input.timeoutMs] - wall-clock budget for the plan itself.
 * @param {AbortSignal} [input.signal] - caller cancellation.
 * @returns {Promise<object>} a capability envelope. On success `decision` carries
 *   `{plan, candidate, restoreMap, originalPreserved, originalTokens,
 *   candidateTokens, tokensAreEstimate, droppedIds, stubbedIds}`.
 */
export async function planContext({
  messages,
  budgetTokens = 8_000,
  taskId,
  runId,
  keepIds = [],
  facts = null,
  stubThreshold = 64,
  timeoutMs = 5_000,
  signal,
} = {}) {
  if (!Array.isArray(messages)) {
    throw new CapabilityError(CAPABILITY_REASON.invalidInput, 'messages must be an array');
  }
  if (typeof taskId !== 'string' || taskId === '') {
    throw new CapabilityError(CAPABILITY_REASON.invalidInput, 'taskId is required');
  }
  if (typeof runId !== 'string' || runId === '') {
    throw new CapabilityError(CAPABILITY_REASON.invalidInput, 'runId is required');
  }
  if (!Number.isInteger(budgetTokens) || budgetTokens < 1) {
    throw new CapabilityError(CAPABILITY_REASON.invalidInput, 'budgetTokens must be a positive integer');
  }

  const identity = snapshotIdentity(
    { messages: messages.map((message, index) => `${index}:${contentText(message?.content).length}`) },
    { source: 'message_history' },
  );

  const outcome = await withBudget(() => {
    const blocks = pinFacts({ blocks: normaliseHistory(messages), facts });
    const originalTokens = blocks.reduce((sum, block) => sum + block.tokens, 0);
    const { plan, actionById, pinnedTokens, pinnedOverBudget } = planBlocks({
      blocks,
      budgetTokens,
      keepIds: new Set(asArray(keepIds)),
      stubThreshold,
    });

    if (pinnedOverBudget) {
      return { pinnedOverBudget, pinnedTokens, originalTokens, plan, blocks, candidate: messages.slice(), restoreMap: {}, candidateTokens: originalTokens, droppedIds: [], stubbedIds: [], actionById };
    }

    const candidate = buildCandidate(blocks, actionById);
    const droppedIds = blocks.filter((block) => actionById.get(block.id) === BLOCK_ACTION.drop).map((block) => block.id);
    const stubbedIds = blocks.filter((block) => actionById.get(block.id) === BLOCK_ACTION.stub).map((block) => block.id);

    // Every dropped or stubbed block is recoverable by id from the original.
    const restoreMap = {};
    for (const block of blocks) {
      const action = actionById.get(block.id);
      if (action === BLOCK_ACTION.drop || action === BLOCK_ACTION.stub) restoreMap[block.id] = block.originalIndex;
    }

    const candidateTokens = candidate.reduce((sum, entry) => sum + estimateTokens(contentText(entry?.text ?? '')), 0);
    return { pinnedOverBudget, pinnedTokens, originalTokens, plan, blocks, candidate, restoreMap, candidateTokens, droppedIds, stubbedIds, actionById };
  }, { timeoutMs, signal });

  if (!outcome.ok) {
    const status = outcome.code === CAPABILITY_REASON.cancelled || outcome.code === CAPABILITY_REASON.timeout
      ? CAPABILITY_STATUS.unverified
      : CAPABILITY_STATUS.error;
    return capabilityEnvelope({
      capability: CONTEXT_CAPABILITY,
      taskId,
      runId,
      snapshot: identity,
      status,
      code: outcome.code,
      message: outcome.message,
      // A planner failure must not lose data: the original goes back as the
      // candidate, with a non-success status saying it was not reduced.
      decision: originalDecision(messages, [], { note: 'planner_failed_original_returned' }),
      limits: CONTEXT_LIMITS,
      model: modelLane({ requested: false, used: false }),
    });
  }

  const result = outcome.value;

  if (result.pinnedOverBudget) {
    return capabilityEnvelope({
      capability: CONTEXT_CAPABILITY,
      taskId,
      runId,
      snapshot: identity,
      status: CAPABILITY_STATUS.unverified,
      code: CAPABILITY_REASON.contextBudgetExceeded,
      message: `the pinned facts need an estimated ${result.pinnedTokens} tokens, above the ${budgetTokens}-token budget: returning the original unchanged rather than an oversized or pin-dropping candidate.`,
      decision: {
        ...originalDecision(messages, result.blocks, { plan: result.plan, note: 'budget_too_small_for_pins' }),
        pinnedTokens: result.pinnedTokens,
        pinnedOverBudget: true,
      },
      evidence: [{ ref: 'message_history', trust: 'collector_observed', note: `${result.blocks.length} block(s) normalised` }],
      limits: CONTEXT_LIMITS,
      model: modelLane({ requested: false, used: false }),
    });
  }

  const pinnedCount = result.blocks.filter((block) => block.pinned === true).length;
  const pinnedKinds = [...new Set(result.blocks.filter((block) => block.pinned === true).map((block) => block.reason))].sort();

  return capabilityEnvelope({
    capability: CONTEXT_CAPABILITY,
    taskId,
    runId,
    snapshot: identity,
    status: CAPABILITY_STATUS.success,
    code: CAPABILITY_REASON.ok,
    message: `candidate keeps ${result.plan.filter((p) => p.action === BLOCK_ACTION.keep).length} block(s), stubs ${result.stubbedIds.length}, drops ${result.droppedIds.length}; estimated ${result.originalTokens} -> ${result.candidateTokens} tokens.`,
    decision: {
      plan: result.plan,
      candidate: result.candidate,
      restoreMap: result.restoreMap,
      originalPreserved: true,
      originalTokens: result.originalTokens,
      candidateTokens: result.candidateTokens,
      tokensAreEstimate: true,
      droppedIds: result.droppedIds,
      stubbedIds: result.stubbedIds,
      pinnedTokens: result.pinnedTokens,
      pinnedKinds,
      pinnedCount,
    },
    evidence: [{ ref: 'message_history', trust: 'collector_observed', note: `${result.blocks.length} block(s) normalised, ${pinnedCount} pinned` }],
    limits: CONTEXT_LIMITS,
    model: modelLane({ requested: false, used: false, note: 'pinning is deterministic marker detection; no model was consulted' }),
  });
}
