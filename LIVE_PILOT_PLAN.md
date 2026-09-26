# Live pilot and activation plan

One concrete plan. It has two stages, and the first one costs nothing.

The reason for two stages is that the two remaining unknowns are different in kind.
The first is *does the harness deliver what we think it delivers* — answerable for
free, in an isolated home, today. The second is *is a JEV judgement any good on our
tasks* — which needs paid calls and a real model, and which no amount of local
testing can substitute for.

Doing them in the other order would waste money measuring the second while the
first was still unproven.

> **What is already settled.** The mechanism is no longer the open question. The
> agent set in `scripts/jev-agent-acceptance.mjs` boots a real DSH, runs a real agent
> and a real turn, calls a real model provider, executes a model-issued tool call,
> takes an agent-bound `ask` through the real `approval/request` service, and loads a
> routed skill through the real `ctx.skills`. All six tools are present in a real
> agent's catalog, and `jev_route_skill` was executed by the real registry. That run
> found and fixed a defect in the adapter's Stop steer that nothing else could see.
>
> It also proves nothing about quality: the provider is a JSON file. So Stage 1 below
> is now a **confirmation on the real profile** rather than a first look, and its
> value is that it uses the installed kit, a real model route and the real skill
> roots — the parts the isolated run substitutes for. Stage 2 is where the only
> question that still matters gets asked.

---

## Stage 1 — isolated activation (free, no credentials, reversible)

**Goal:** prove that a real DSH session, in its own home, loads the kit, exposes the
six tools to a model, and that the agent can call them and get a sane answer back.

**Where:** a dedicated home, never the active one.

```
DSH_HOME=$HOME\.dsh-pilot
profile:  jev-pilot
```

**Why a separate home:** the active `web` profile stays exactly as it is. If anything
goes wrong, deleting one directory returns the machine to its current state.

### Steps

> **Order matters.** Create the profile **before** installing. `--from-default-profile`
> regenerates `cordis.patch.yml`, so installing first means the kit's rows are
> overwritten by an empty patch. This was found by running it, not by reading it.

1. **Create the pilot profile from the headless default.**
   ```powershell
   $env:DSH_HOME='$HOME\.dsh-pilot'
   node <dsh>\lib\bin.js --profile jev-pilot --from-default-profile headless --dump-config
   ```

2. **Install the kit into the pilot home.**
   ```powershell
   node $HOME\jev-gates\scripts\jev-install.mjs --home $HOME\.dsh-pilot --profile jev-pilot
   ```
   The installer refuses `~/.dsh` without `--allow-active-home`, so this command
   cannot reach the live home. Because `DSH_HOME` is already exported in this
   shell, it prints a warning that this is the shell's DSH_HOME — expected here,
   and the reason the warning exists rather than a refusal.

3. **Confirm the row is really in the composition.**
   ```powershell
   node <dsh>\lib\bin.js --profile jev-pilot --dump-config | Select-String 'jev-tools'
   ```
   Reading the patch file back only proves a file was written. The dump proves the
   loader applied it. Expected: the `jev-tools` and `jev-adapter` rows appear.

4. **Confirm the tools reach a model's catalog.**
   Boot a session and read the catalog **in agent scope**:
   ```powershell
   $env:JEV_CATALOG_OUT='$HOME\.dsh-pilot\catalog.json'
   node <dsh>\lib\bin.js --profile jev-pilot --patch <pilot>\overlay.yml probe
   ```
   A bare `probe` boot creates no agent, and tool definitions are visible per
   agent scope, so a bare boot reports an **empty catalog** — including `pwsh`
   and `read`. That is the instrument, not the product. The catalog must be read
   from `agent/created`; `scripts/jev-agent-acceptance.mjs` is the working
   example. Expected: all six `jev_*` tools present, each with a description and
   `parameters.type === 'object'`.

5. **Run one real session with a real model, in advisory mode only.**
   Use a free model route from `$DSH_HOME/settings.yaml` → `llm-pi-ai.providers`
   (any id ending in `:free`). Give it one task that should trigger a gate:
   *"Create `out.txt` with the text hello, then verify the task is complete using
   `jev_verify_completion` with the artifact `out.txt`."*

6. **Check the outcome by reading, not by asking.**
   - the tool appears in the session's tool list;
   - the call happens and returns an envelope;
   - the envelope's `decision.completionStatus` is `done` **and** `evidence` contains
     a `collector_observed` ref — not a `self_reported` one;
   - delete `out.txt` and re-run: the status must become `unverified`, never `done`.

7. **Exercise the approval boundary once, manually.**
   Ask the agent to run a command the adapter's rules flag. Expected: the call is
   denied or asks, and the reason names `authorization_unavailable` when there is no
   approval service. This is the one check that cannot be automated non-interactively
   on this build; it takes about a minute by hand.

### What Stage 1 proves

| claim | proven by |
|---|---|
| the kit's rows reach the harness composition | step 3 |
| the harness loads the kit and the tools reach the model | step 4 |
| a real model can call a tool and get a usable envelope | step 5 |
| trust is assigned by the acquisition path, not the request | step 6 |
| a missing artifact does not confirm completion | step 6 |
| the guard surface denies rather than staying silent | step 7 |

### What Stage 1 does NOT prove

- Nothing about JEV judgement quality. The model here is a free route and the judge
  may not even be reachable.
- Nothing about the `ask` path reaching a human — there is no approval service in a
  headless pilot, which is exactly why step 6 checks the *unavailable* form.

### Rollback

```powershell
node $HOME\jev-gates\scripts\jev-install.mjs --home $HOME\.dsh-pilot --uninstall
Remove-Item $HOME\.dsh-pilot -Recurse -Force
```

The uninstaller removes only files whose digest still matches what it wrote, and it
restores from backup anything it replaced. Nothing outside that directory was touched.

**Cost: zero. No credential needed for the offline sets; the free route needs only
whatever key it already uses.**

---

## Stage 2 — live JEV validation (paid, needs explicit authorisation)

**Goal:** establish whether a JEV judgement is actually worth acting on for the tasks
this product serves. This is the one question no local test can answer.

**Prerequisite:** Stage 1 held, and the user's explicit authorisation for paid calls.

### The minimum that answers the question

One call is not enough to say anything, and a hundred calls prove nothing without a
denominator. The smallest honest design:

1. **Pick one task where the answer is already known.** Take the C2 routing decision
   (`jev_route_skill`) — it has a ground truth (which skill a human would pick) and it
   is the cheapest primitive.
2. **Build a small fixed set with known answers** — 20 items is enough to see a gross
   error rate and to notice a broken rubric; it is not enough to quote a tight bound,
   and the report must say so.
3. **Run it once and record everything**: request, response, cost, latency.
4. **Run the instrument control**: repeat the same items with the discriminating
   feature removed. If the answers do not change, the rubric is reading something
   other than what it claims, and the result means nothing.
5. **Only then** compare against the known answers, and report the count with its
   denominator and an interval — never a bare percentage.

### Cost control

- Set a hard call cap before starting and stop at it.
- Record every call in the journal so the same request is never paid for twice.
- `jev-replay policy` and `jev-replay sweep` compare a recorded answer against an
  offline replay for free.

### What Stage 2 would establish

- whether the judge's live `choice` lane matches the wire shape the code assumes
  (currently taken from the skill document and **unconfirmed**);
- a first, honestly-bounded error rate on one narrow task;
- whether the rubric survives its own control.

### What Stage 2 would NOT establish

- that the judge is good in general — one task, one set;
- that any capability should be trusted unattended. Every tool here is advisory by
  construction and stays that way.

### Rollback

Stage 2 writes only to the journal and to a report file. There is nothing to revert.

---

## The decision this plan asks for

Two questions, and they can be answered separately:

1. **Run Stage 1?** Free, isolated, reversible. If yes, it can be done immediately
   and its result reported before anything else is decided.
2. **Authorise Stage 2?** Paid, bounded, and the only way to answer the quality
   question. If no, the product still stands — it just keeps saying
   `offline-tested` and `runtime-tested`, and never `live-validated`, which is the
   truthful label.

Activating the kit in the **active** `web` profile is a third, separate decision. It
is not part of this plan and should not be bundled with it: it changes the profile
this session is running on, and it needs its own explicit approval.
