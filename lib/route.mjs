/**
 * Skill routing — capability C2, `jev_route_skill` (spec §14.1).
 *
 * The router answers one question: *which skill that already exists fits this
 * task?* It is a recommendation, never a permission, and it never invents a
 * skill: every id it can return came out of the catalog it was handed.
 *
 * The order of authority is the whole design, and it is enforced by the shape of
 * the code rather than by discipline:
 *
 *   1. an explicit user choice — returned immediately, and the model lane is
 *      never even entered, so it cannot second-guess a human;
 *   2. the deterministic shortlist from `lib/skills.mjs` — a skill whose
 *      declared `requires` are absent is removed *before* any model sees the
 *      list, because a model cannot know what the session's tools are;
 *   3. a model verdict — and only when the shortlist has two or more candidates.
 *      With zero or one candidate there is nothing semantic to decide, and
 *      spending a call to obtain an opinion that cannot change the answer is
 *      how a router becomes slow and wrong at the same time.
 *
 * A judge that is unreachable must not take the skills away. That is why the
 * fallback to `source: 'deterministic'` is a hard requirement here and not a
 * nicety: routing is an optimisation over a catalog that remains fully usable
 * without it.
 */
import {
  CAPABILITY_REASON,
  CAPABILITY_STATUS,
  capabilityEnvelope,
  modelLane,
  snapshotIdentity,
  withBudget,
} from './capability.mjs';
import { digestJson, digestText, stableStringify } from './evidence.mjs';
import { buildRequest, buildState, JUDGE_STATUS, wrapUntrusted } from './judge.mjs';
import { readCatalog, shortlist } from './skills.mjs';

/** Per-capability implementation version, reported so a journal row can be reproduced. */
export const ROUTE_VERSION = '1.0.0';

/** Which stage actually produced the recommendation. */
export const ROUTE_SOURCE = Object.freeze({
  explicit: 'explicit',
  deterministic: 'deterministic',
  model: 'model',
  none: 'none',
});

/** The question id a route verdict is keyed by. One route question per call. */
export const ROUTE_QUESTION_ID = 'route';

/** The label that means "none of the shortlisted skills fits". Never a skill id. */
export const ROUTE_ABSTAIN_LABEL = 'none';

/**
 * Default confidence floor for a model verdict.
 *
 * Below it the router abstains instead of recommending. Uncalibrated on purpose:
 * `lib/policy.mjs` carries the same honest marker, and a router that pretended
 * to a measured threshold would be the more expensive lie.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.5;

/**
 * The task text, however it arrived.
 *
 * A caller may hand over a snapshot object (which is what the spec's "task
 * snapshot" means) or a plain string. Both are accepted, and the digest covers
 * the object's stable serialization, so a changed snapshot changes the digest.
 */
function taskText(task) {
  if (typeof task === 'string') return task;
  if (task && typeof task === 'object') {
    for (const key of ['text', 'task', 'goal', 'title', 'summary']) {
      if (typeof task[key] === 'string' && task[key].length > 0) return task[key];
    }
    return stableStringify(task);
  }
  return '';
}

/** Catalog skills as an array, tolerating the shapes a caller may pass. */
function catalogSkills(catalog) {
  if (Array.isArray(catalog)) return catalog;
  if (Array.isArray(catalog?.skills)) return catalog.skills;
  return [];
}

/**
 * Make one catalog entry safe to use without trusting its shape.
 *
 * `declared.requires` is defaulted to `[]` rather than `undefined` because
 * `shortlist()` reads it directly: an entry that arrives without it would throw
 * inside the filter, and a router that crashes on a malformed catalog is worse
 * than one that lists the entry and says nothing about its requirements.
 */
function normalizeSkill(skill) {
  const declared = skill?.declared && typeof skill.declared === 'object' ? skill.declared : {};
  return {
    id: typeof skill?.id === 'string' && skill.id.length > 0 ? skill.id : null,
    name: typeof skill?.name === 'string' ? skill.name : null,
    description: typeof skill?.description === 'string' ? skill.description : '',
    whenToUse: typeof skill?.whenToUse === 'string' ? skill.whenToUse : '',
    version: typeof skill?.version === 'string' ? skill.version : 'unversioned',
    digest: typeof skill?.digest === 'string' ? skill.digest : null,
    origin: typeof skill?.origin === 'string' ? skill.origin : 'unknown',
    path: typeof skill?.path === 'string' ? skill.path : null,
    declared: { ...declared, requires: Array.isArray(declared.requires) ? declared.requires : [] },
    inferred: skill?.inferred && typeof skill.inferred === 'object' ? skill.inferred : {},
    problems: Array.isArray(skill?.problems) ? skill.problems : [],
  };
}

/** The catalog, cleaned up and stripped of entries that cannot be named. */
export function normalizeCatalog(catalog) {
  const skills = catalogSkills(catalog)
    .map(normalizeSkill)
    .filter((skill) => skill.id !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    catalogVersion: typeof catalog?.catalogVersion === 'string' ? catalog.catalogVersion : null,
    version: typeof catalog?.version === 'string' ? catalog.version : null,
    skills,
  };
}

/**
 * The catalog digest, which is what makes a cached recommendation invalid.
 *
 * It is over the *content* a routing decision depended on — id, description,
 * declared requirements, per-skill digest — not over the whole entry, so an
 * irrelevant metadata change does not invalidate a recommendation and a
 * meaningful one always does.
 *
 * @param {object} catalog - from {@link readCatalog} or a caller's equivalent.
 * @returns {{ version: string|null, digest: string, skillCount: number, digestParts: object }}
 */
export function catalogIdentity(catalog) {
  const normalized = normalizeCatalog(catalog);
  const parts = normalized.skills.map((skill) => ({
    id: skill.id,
    description: skill.description,
    whenToUse: skill.whenToUse,
    version: skill.version,
    digest: skill.digest,
    requires: skill.declared.requires,
  }));
  const digest = `sha256:${digestJson({
    catalogVersion: normalized.catalogVersion,
    version: normalized.version,
    skills: parts,
  })}`;
  return {
    version: normalized.version ?? normalized.catalogVersion,
    digest,
    skillCount: parts.length,
    digestParts: parts,
  };
}

/**
 * What was resolved about one candidate, for the envelope's shortlist.
 *
 * A candidate carries its own digest so a reader can tell whether the entry
 * changed since the recommendation was made — the catalog digest alone says
 * "something moved", this says "this one did".
 */
function candidateRecord(entry) {
  const skill = entry?.declared ? entry : normalizeSkill(entry);
  const digest = skill.digest ?? `sha256:${digestText(`${skill.id}\u0000${skill.description}`)}`;
  return {
    id: skill.id,
    name: skill.name ?? skill.id,
    description: skill.description,
    whenToUse: skill.whenToUse,
    version: skill.version,
    origin: skill.origin,
    digest,
    requires: skill.declared.requires,
    keywordScore: Number.isFinite(entry?.keywordScore) ? entry.keywordScore : null,
  };
}

/** Why a candidate never reached the model. */
function exclusionRecord(excluded) {
  return {
    id: excluded?.id ?? null,
    code: excluded?.code ?? 'excluded',
    detail: excluded?.detail ?? null,
  };
}

/** The human-readable line that travels with every decision. */
function summaryFor(source, recommended, shortlist) {
  const candidates = shortlist.map((c) => c.id).join(', ');
  if (source === ROUTE_SOURCE.explicit) return `the user named ${recommended}; it is used as given`;
  if (source === ROUTE_SOURCE.model) return `the judge chose ${recommended} from ${shortlist.length} candidates (${candidates})`;
  if (source === ROUTE_SOURCE.deterministic) {
    return recommended
      ? `no model verdict was needed; ${recommended} is the only candidate the filter left`
      : 'the deterministic filter left no candidate';
  }
  return 'nothing was recommended';
}

/**
 * The decision body, built in one place so every return path has the same keys.
 * A reader must never have to ask "does this branch have `shortlist`?".
 */
function makeDecision({ source, recommended, shortlist, excluded, catalog, extra = {} }) {
  return {
    recommended,
    summary: summaryFor(source, recommended, shortlist),
    shortlist,
    excluded,
    source,
    catalogDigest: catalog.digest,
    catalogVersion: catalog.version,
    ...extra,
  };
}

/**
 * The evidence this capability stands on.
 *
 * The catalog is read from disk by code, so it is `harness_observed` — and that
 * is load-bearing rather than decorative: a model verdict about candidates is
 * only allowed to exist because an independently-acquired fact sits beside it
 * (`assertNoTrustLaundering`). The task text is the opposite case and is marked
 * accordingly.
 */
function routeEvidence(catalog, task) {
  return [
    {
      ref: `catalog:${catalog.version ?? 'unversioned'}`,
      trust: 'harness_observed',
      note: `${catalog.skillCount} skill(s) read from disk, digest ${catalog.digest}`,
    },
    { ref: 'task:snapshot', trust: 'self_reported', note: `the task as the session declared it (${task.length} chars)` },
  ];
}

/**
 * The judge request: one `choice` question over the shortlist.
 *
 * `instructions` is required by the endpoint for every question type, so it is
 * always present. The candidate ids travel as untrusted text inside the
 * criteria, because a skill description is written by whoever wrote the skill
 * and is data about a candidate, never an instruction to the router.
 *
 * @param {object} input
 * @param {object|string} input.task - the task snapshot or its text.
 * @param {object[]} input.shortlist - candidates, as the envelope records them.
 * @param {string} [input.requestedId] - the question id; defaults to {@link ROUTE_QUESTION_ID}.
 * @returns {Record<string, object>} a questions map, ready for `askJudge`.
 */
export function buildRouteQuestion({ task, shortlist, requestedId = ROUTE_QUESTION_ID } = {}) {
  const candidates = (shortlist ?? []).map((c) => (c?.declared ? candidateRecord(c) : c)).filter((c) => c?.id);
  const options = [...candidates.map((c) => c.id), ROUTE_ABSTAIN_LABEL];
  const criteria = {};
  for (const candidate of candidates) {
    const wrapped = wrapUntrusted(`candidate_${candidate.id}`, candidate.description ?? '');
    criteria[candidate.id] = `Fit this task: ${candidate.whenToUse || candidate.description || candidate.id}${wrapped[`untrusted_candidate_${candidate.id}`] ? `\n${wrapped[`untrusted_candidate_${candidate.id}`]}` : ''}`;
  }
  criteria[ROUTE_ABSTAIN_LABEL] = 'No shortlisted skill fits this task well enough to recommend it.';

  return {
    [requestedId]: {
      type: 'choice',
      instructions: {
        question: 'Which one of these existing skills fits the task best?',
        rules: [
          'Choose exactly one option from the list, or "none".',
          'Do not invent a skill that is not on the list.',
          'A choice means "this fits", not "this is allowed to run".',
        ],
        options,
        task: taskText(task),
      },
      criteria,
    },
  };
}

/** Read a probability out of whichever answer shape arrived. */
function probabilityOf(answer) {
  if (!answer || typeof answer !== 'object') return null;
  if (typeof answer.noul === 'number') return answer.noul;
  if (typeof answer.value === 'number') return answer.value;
  return null;
}

/**
 * Interpret a judge answer as one of the offered candidate ids.
 *
 * The documented shape for a `choice` is `.choice` (one label) plus optional
 * `.probabilities` and `.confidence`, and that is what is read first. A bare
 * label and a keyed object are also accepted because the judge's wire form is
 * not this module's to pin.
 *
 * A distribution is only consulted when it is a *complete* scoring of exactly
 * the offered options. A partial or extended distribution is rejected rather
 * than argmaxed: the argmax of an arbitrary map is a label the judge scored, not
 * a label the judge chose, and honouring it would turn a probability into a
 * decision the model never made.
 */
function interpretAnswer(answer, candidateIds) {
  if (typeof answer === 'string' && answer.length > 0) return { id: answer, confidence: null, shape: 'label' };
  if (!answer || typeof answer !== 'object') return null;
  if (typeof answer.choice === 'string' && answer.choice.length > 0) {
    return { id: answer.choice, confidence: Number.isFinite(answer.confidence) ? answer.confidence : null, shape: 'choice' };
  }
  for (const id of candidateIds) {
    if (typeof answer[id] === 'number') return { id, confidence: answer[id], shape: 'keyed' };
  }
  const distribution = answer.probabilities;
  if (distribution && typeof distribution === 'object' && !Array.isArray(distribution)) {
    const labels = Object.keys(distribution);
    const complete = labels.length === candidateIds.length && candidateIds.every((id) => labels.includes(id));
    if (!complete) return null;
    let best = null;
    for (const [label, value] of Object.entries(distribution)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      if (best === null || value > best.confidence) best = { id: label, confidence: value, shape: 'distribution' };
    }
    return best;
  }
  return null;
}

/**
 * Route a task to an existing skill.
 *
 * @param {object} input
 * @param {object|string} input.task - the task snapshot or its text.
 * @param {object} input.catalog - the skill catalog, with `version`/`digest` or the entries to derive one from.
 * @param {string|null} [input.explicitSkill] - a skill the user named. Wins unconditionally.
 * @param {string[]} [input.availableTools] - the tools this session actually has.
 * @param {object|null} [input.judge] - the model lane; `null` means no judge is configured.
 * @param {Function} [input.judge.ask] - async `{state, questions}` -> `{status, answers, ...}`.
 * @param {string} [input.model] - the model id, for the record.
 * @param {string} [input.taskId] - required by the envelope.
 * @param {string} [input.runId] - required by the envelope.
 * @param {number} [input.timeoutMs] - wall-clock budget for the judge.
 * @param {AbortSignal} [input.signal] - outer cancellation.
 * @param {number} [input.minConfidence] - below this the router abstains.
 * @returns {Promise<object>} a capability envelope; `decision.recommended` is an existing id or `null`.
 */
export async function routeSkill({
  task,
  catalog,
  explicitSkill = null,
  availableTools = [],
  judge = null,
  model = null,
  taskId = 'task',
  runId = 'run',
  timeoutMs = 20_000,
  signal,
  minConfidence = DEFAULT_MIN_CONFIDENCE,
} = {}) {
  const taskBody = taskText(task);
  const normalized = normalizeCatalog(catalog);
  const identity = catalogIdentity(catalog);
  const snapshot = snapshotIdentity(
    { catalogDigest: identity.digest, catalogVersion: identity.version ?? 'unknown', task: taskBody },
    { source: 'skills.readCatalog' },
  );
  const evidence = routeEvidence(identity, taskBody);
  const limits = [
    'a recommendation is not a permission: this envelope authorises nothing (actionAuthority is always none)',
    'routing judges fit, and fit is not correctness',
    'the deterministic filter is only as complete as the skills\' declared requires fields',
    'no skill outside the catalog it was given can be recommended',
  ];
  const base = { taskId, runId, snapshot, capabilityVersion: ROUTE_VERSION };

  // 1. An explicit user choice wins, always — including when it is wrong. The
  //    router does not get to overrule a human, and it does not get to stay
  //    silent either: an id that is not in the catalog is reported, never
  //    silently swapped for a lookalike.
  if (typeof explicitSkill === 'string' && explicitSkill.length > 0) {
    const match = normalized.skills.find((skill) => skill.id === explicitSkill) ?? null;
    if (match === null) {
      return capabilityEnvelope({
        ...base,
        capability: 'jev_route_skill',
        status: CAPABILITY_STATUS.abstain,
        code: CAPABILITY_REASON.noCandidate,
        message: `no skill named ${JSON.stringify(explicitSkill)} exists in this catalog`,
        decision: makeDecision({
          source: ROUTE_SOURCE.none,
          recommended: null,
          shortlist: [],
          excluded: [],
          catalog: identity,
          extra: { explicitSkill, explicitSkillExists: false },
        }),
        evidence,
        limits,
        model: modelLane({ requested: false, used: false, note: 'an explicit choice was named; the model lane was not entered' }),
      });
    }

    const candidate = candidateRecord(match);
    const available = new Set(availableTools);
    const missing = candidate.requires.filter((name) => available.size > 0 && !available.has(name));
    return capabilityEnvelope({
      ...base,
      capability: 'jev_route_skill',
      status: CAPABILITY_STATUS.success,
      code: CAPABILITY_REASON.explicitChoice,
      message: `the user named ${match.id}; it is recommended as given`,
      decision: makeDecision({
        source: ROUTE_SOURCE.explicit,
        recommended: match.id,
        shortlist: [candidate],
        excluded: [],
        catalog: identity,
        extra: {
          explicitSkill: match.id,
          explicitSkillExists: true,
          // Recorded, not acted on. Hiding it would let a recommendation read as
          // "this will run", which is exactly the confusion this module exists
          // to avoid; excluding it would override the user, which is worse.
          missingCapabilities: missing,
        },
      }),
      evidence,
      limits,
      model: modelLane({ requested: false, used: false, note: 'an explicit choice wins; the model lane was not entered' }),
    });
  }

  // 2. The deterministic filter. It removes what cannot work before any model
  //    sees the list. An empty catalog is its own outcome, not a filter result.
  if (normalized.skills.length === 0) {
    return capabilityEnvelope({
      ...base,
      capability: 'jev_route_skill',
      status: CAPABILITY_STATUS.abstain,
      code: CAPABILITY_REASON.noCandidate,
      message: 'the catalog is empty, so there is nothing to route to',
      decision: makeDecision({
        source: ROUTE_SOURCE.none,
        recommended: null,
        shortlist: [],
        excluded: [],
        catalog: identity,
        extra: { emptyCatalog: true },
      }),
      evidence,
      limits,
      model: modelLane({ requested: false, used: false, note: 'an empty catalog has nothing to judge' }),
    });
  }

  const filtered = shortlist({ task: taskBody, skills: normalized.skills, explicitSkill: null, availableTools });
  const candidates = filtered.shortlist.map(candidateRecord);
  const excluded = filtered.excluded.map(exclusionRecord);

  if (candidates.length === 0) {
    return capabilityEnvelope({
      ...base,
      capability: 'jev_route_skill',
      status: CAPABILITY_STATUS.abstain,
      code: CAPABILITY_REASON.noCandidate,
      message: `the filter left no candidate: ${filtered.excluded.length} skill(s) were excluded`,
      decision: makeDecision({
        source: ROUTE_SOURCE.none,
        recommended: null,
        shortlist: [],
        excluded,
        catalog: identity,
        extra: { filterProblems: filtered.problems },
      }),
      evidence,
      limits,
      model: modelLane({ requested: false, used: false, note: 'there was nothing to judge' }),
    });
  }

  // 3. With one candidate there is nothing semantic to decide. Returning here
  //    also means the model lane is never requested, so the envelope says so
  //    rather than leaving a reader to guess.
  if (candidates.length === 1) {
    return capabilityEnvelope({
      ...base,
      capability: 'jev_route_skill',
      status: CAPABILITY_STATUS.success,
      code: CAPABILITY_REASON.ok,
      message: `${candidates[0].id} is the only candidate the filter left`,
      decision: makeDecision({
        source: ROUTE_SOURCE.deterministic,
        recommended: candidates[0].id,
        shortlist: candidates,
        excluded,
        catalog: identity,
      }),
      evidence,
      limits,
      model: modelLane({ requested: false, used: false, note: 'one candidate is not a choice to judge' }),
    });
  }

  // 4. The judge is optional. Unreachable or absent, the catalog stays usable —
  //    that is the fallback the spec makes a hard requirement.
  if (typeof judge?.ask !== 'function') {
    return capabilityEnvelope({
      ...base,
      capability: 'jev_route_skill',
      status: CAPABILITY_STATUS.success,
      code: CAPABILITY_REASON.ok,
      message: `no judge is available; the deterministic shortlist is returned unchanged`,
      decision: makeDecision({
        source: ROUTE_SOURCE.deterministic,
        recommended: candidates[0].id,
        shortlist: candidates,
        excluded,
        catalog: identity,
      }),
      evidence,
      limits,
      model: modelLane({
        requested: true,
        used: false,
        status: JUDGE_STATUS.unavailable,
        note: 'no judge was configured; the catalog stays usable without it',
      }),
    });
  }

  const questions = buildRouteQuestion({ task: taskBody, shortlist: candidates });
  const state = buildState(
    { taskId, runId, mode: 'skill_route', claims: { task: taskBody } },
    [
      {
        criterionId: ROUTE_QUESTION_ID,
        result: 'unknown',
        reasonCode: CAPABILITY_REASON.ok,
        sourceTrust: 'harness_observed',
        coverage: 'full',
        supported: true,
      },
    ],
  );
  state.catalog = {
    version: identity.version,
    digest: identity.digest,
    candidates: candidates.map((c) => ({ id: c.id, description: c.description, whenToUse: c.whenToUse, requires: c.requires })),
    excluded,
  };

  let outcome;
  try {
    buildRequest({ state, model: model ?? undefined, questions });
    outcome = await withBudget(
      () => judge.ask({ state, questions, model: model ?? undefined }),
      { timeoutMs, signal },
    );
  } catch (error) {
    // A body this module cannot even build is this module's defect, and it must
    // not be laundered into a successful route. The deterministic answer stands.
    return capabilityEnvelope({
      ...base,
      capability: 'jev_route_skill',
      status: CAPABILITY_STATUS.success,
      code: CAPABILITY_REASON.ok,
      message: 'the judge request could not be built; the deterministic shortlist is returned unchanged',
      decision: makeDecision({
        source: ROUTE_SOURCE.deterministic,
        recommended: candidates[0].id,
        shortlist: candidates,
        excluded,
        catalog: identity,
        extra: { judgeProblem: String(error?.message ?? error) },
      }),
      evidence,
      limits,
      model: modelLane({ requested: true, used: false, status: JUDGE_STATUS.abstained, note: 'the request was malformed and was never sent' }),
    });
  }

  const answer = outcome.ok ? outcome.value : null;
  const status = answer?.status ?? (outcome.ok ? JUDGE_STATUS.abstained : null);
  const laneNote = outcome.ok ? null : `the judge lane failed: ${outcome.code}`;

  const fallback = (note) =>
    capabilityEnvelope({
      ...base,
      capability: 'jev_route_skill',
      status: CAPABILITY_STATUS.success,
      code: CAPABILITY_REASON.ok,
      message: 'no model verdict was used; the deterministic shortlist is returned unchanged',
      decision: makeDecision({
        source: ROUTE_SOURCE.deterministic,
        recommended: candidates[0].id,
        shortlist: candidates,
        excluded,
        catalog: identity,
      }),
      evidence,
      limits,
      model: modelLane({ requested: true, used: false, status, note }),
    });

  const abstain = (code, message, note, modelUsed = false) =>
    capabilityEnvelope({
      ...base,
      capability: 'jev_route_skill',
      status: CAPABILITY_STATUS.abstain,
      code,
      message,
      decision: makeDecision({
        source: ROUTE_SOURCE.none,
        recommended: null,
        shortlist: candidates,
        excluded,
        catalog: identity,
      }),
      evidence,
      limits,
      model: modelLane({ requested: true, used: modelUsed, status, model: modelUsed ? model : null, note }),
    });

  if (!outcome.ok) return fallback(laneNote);
  if (answer?.status === JUDGE_STATUS.unavailable) {
    // An unreachable judge is the documented fallback, not an abstention: the
    // catalog stays usable and the router does not pretend the model declined.
    return fallback(answer.reason ?? 'the judge was unreachable');
  }
  if (answer?.status === JUDGE_STATUS.abstained) {
    // A judge that was asked and did not answer is a different fact from one
    // that was never reachable. Both keep the catalog usable, but only this one
    // means the model actually declined.
    return abstain(
      CAPABILITY_REASON.abstained,
      `the judge did not answer: ${answer.reason ?? 'no reason given'}`,
      answer.reason ?? 'the judge abstained',
    );
  }
  if (answer?.status !== JUDGE_STATUS.ok) {
    return fallback(`the judge returned an unusable status: ${JSON.stringify(answer?.status)}`);
  }

  const ids = candidates.map((c) => c.id);
  const picked = interpretAnswer(answer.answers?.[ROUTE_QUESTION_ID], ids);
  if (picked === null) {
    return abstain(
      CAPABILITY_REASON.judgeAbstained,
      'the judge returned no readable choice, so nothing is recommended',
      'the verdict could not be read as one of the offered options',
    );
  }
  if (picked.id === ROUTE_ABSTAIN_LABEL) {
    return abstain(
      CAPABILITY_REASON.abstained,
      'the judge declined to recommend any of the candidates',
      'the judge answered "none"',
      true,
    );
  }
  if (!ids.includes(picked.id)) {
    // A label that was never offered is not a decision — it is a different
    // question, and honouring it would be inventing a skill id.
    return abstain(
      CAPABILITY_REASON.noCandidate,
      `the judge named ${JSON.stringify(picked.id)}, which is not a candidate in this shortlist`,
      'the verdict named something that was not on the list',
    );
  }
  if (picked.confidence !== null && picked.confidence < minConfidence) {
    return abstain(
      CAPABILITY_REASON.judgeLowConfidence,
      `the judge chose ${picked.id} at ${picked.confidence}, below the ${minConfidence} floor`,
      `confidence ${picked.confidence} is below the floor`,
      true,
    );
  }

  const confidence = picked.confidence;
  return capabilityEnvelope({
    ...base,
    capability: 'jev_route_skill',
    status: CAPABILITY_STATUS.success,
    code: CAPABILITY_REASON.ok,
    message: `the judge recommended ${picked.id} from ${candidates.length} candidates`,
    decision: makeDecision({
      source: ROUTE_SOURCE.model,
      recommended: picked.id,
      shortlist: candidates,
      excluded,
      catalog: identity,
      extra: {
        confidence,
        answerShape: picked.shape,
        // The deterministic order stays visible beside the model's choice, so a
        // reader can see the disagreement rather than only the winner.
        deterministicRanking: ids,
      },
    }),
    evidence,
    limits,
    model: modelLane({ requested: true, used: true, status: answer.status, model, note: null }),
  });
}

/**
 * Read the catalog from disk and route against it.
 *
 * A thin composition rather than a second implementation: the reading rules
 * (roots, shadowing, problems) belong to `lib/skills.mjs` and are not restated
 * here. It exists because the common call is "route against whatever skills are
 * installed", and making every caller repeat the read invites them to disagree.
 *
 * @param {object} input - every `routeSkill` input, plus `roots`/`env`/`home`/`repoRoot`.
 * @returns {Promise<object>} the envelope, with `catalogVersion` from the read.
 */
export async function routeFromDisk({ roots, env, home, repoRoot, ...rest } = {}) {
  const catalog = readCatalog({ roots, env, home, repoRoot });
  const envelope = await routeSkill({ ...rest, catalog });
  return { ...envelope, catalogProblems: catalog.problems, catalogRoots: catalog.roots };
}
