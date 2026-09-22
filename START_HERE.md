# Start here

JEV gates for DeepSeek Harness: local checks that answer narrow questions with
evidence instead of confidence, plus the tools and skills that make them callable
from a real session.

## What this is

Six capabilities, each a real DSH tool with a skill that teaches the agent when to
reach for it:

| tool | the question it answers |
|---|---|
| `jev_verify_completion` | is this task actually finished? |
| `jev_route_skill` | which existing skill fits this task? |
| `jev_check_progress` | is this run repeating itself without new information? |
| `jev_review_scope` | does this change meet a narrow rubric? |
| `jev_context_plan` | what can be dropped from this history, safely? |
| `jev_diagnose` | why did that gate answer that, and what should change? |

Every one of them is **advisory**. None of them authorises an action, none of them
executes a command, and none of them can widen a permission another guard denied.

## The three ideas that hold it together

**Trust comes from how evidence was acquired, never from what a request claims.**
An observation is `harness_observed` because the harness watched the call,
`collector_observed` because this process read the file, `self_reported` because
someone asserted it. A request cannot promote itself.

**A missing observation is not a pass.** Evidence is resolved before any model is
consulted, and a required criterion with no observation stays `unverified` whatever
a judge says. An unavailable judge implies neither completion nor permission.

**A deterministic answer never pays for a model.** If every required criterion can be
computed, the verdict is computed and the judge is not called.

## Try it

```bash
# the whole offline suite
node --test

# the single end-to-end acceptance (writes PRODUCT_ACCEPTANCE.json)
node scripts/jev-product-acceptance.mjs

# install into a throwaway home and read the report
node scripts/jev-install.mjs --home /tmp/jev-home --dry-run
```

## Where to read next

| document | for |
|---|---|
| `PRODUCT_COMPLETION_STATUS.md` | what is promised, what is proven, and what is deliberately not done |
| `LIVE_PILOT_PLAN.md` | the one concrete plan to activate this on a live profile |
| `docs/SOURCE-TRACEABILITY.md` | every DSH mechanism we rely on, with its file, its limit, and our check |
| `docs/DSH.md` | how the DSH integration works |
| `docs/CLI.md` | the command surface |
| `IMPLEMENTATION_STATUS.md` | the running build log, including the R7 history |
| `docs/_dsh-runtime-findings.md` | what the harness actually does, including a retracted earlier claim |

## Two things to know before you trust a number here

**A test count is not acceptance.** `PRODUCT_ACCEPTANCE.json` reports each capability
separately, with the tests that covered it and how far it was actually exercised. A
capability that only ran offline says `offline-tested`.

**The agent lane uses a scripted provider.** It drives the real agent loop with a
deterministic scripted model, which proves the mechanism — real turns, real steering,
real tool dispatch — and says nothing about whether a JEV judgement is any good. No
paid JEV call was made anywhere in this repository's acceptance.

## Installing it for real

Do not install into your active DSH home without reading `LIVE_PILOT_PLAN.md`. The
installer refuses that path by default and needs `--allow-active-home` to do it, which
is deliberate: activation is a decision, not a side effect of running a script.
