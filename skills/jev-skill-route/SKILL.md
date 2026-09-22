---
name: jev-skill-route
description: Choose which skill or tool fits a task when the catalog is large or the choice is ambiguous. Explicit user instruction always wins; then a deterministic filter, then a recommendation with a source id. Use when several skills could apply, or when the catalog has grown past what can be read.
whenToUse: A task could be handled by more than one skill or tool, the catalog is too large to read, or the wrong skill was picked last time.
---

# Skill routing — narrow the list, then recommend

**A recommendation is not a permission.** Routing says which skill fits; it does not grant the
right to act, and it never overrides an explicit instruction.

## Order of authority

1. **An explicit user instruction wins, always.** If the user named a skill, it is used. The
   router does not second-guess it, hide it, or rank it lower.
2. **A deterministic filter** removes what cannot work: missing capabilities, unavailable
   tools, a scope that does not match.
3. **A recommendation** from the shortlist, with the reason and the source id of each
   candidate.

## The filter, before any judgment

| filter | removes |
|---|---|
| capability | skills whose required tools are not present |
| scope | skills whose declared domain does not include the task |
| availability | skills that failed to load |
| explicit exclusion | anything the user ruled out |

The filter is code, and it is auditable. It must never remove the user's explicit choice.

## Then, and only then, a judgment

Ask about the *fit* of each remaining candidate — one narrow question per candidate, not a
ranking of everything at once. If the judge is unavailable, fall back to the plain catalog:
**an unreachable judge must not take the skills away.**

Record what was recommended and what was chosen. A router that never checks its own accuracy
is a router that is confidently wrong.

## Measuring it

Do not measure whether the recommended *name* looks right. Measure:

- top-k recall on tasks whose correct skill is known independently
- the share of `none`/abstain answers, and the share of wrong routes
- whether the downstream task actually succeeded

Include the catalog hash in the cache key: a changed catalog invalidates every recommendation.

## Limits

- Routing is a judgment about fit, and fit is not correctness.
- A large catalog makes the shortlist stage more valuable than the judgment stage. Invest
  there first.
- Never let routing change permissions, and never let it silently substitute a skill the user
  asked for.
