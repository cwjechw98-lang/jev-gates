# User guide: installing JEV Gates into DeepSeek Harness

A step-by-step guide for someone seeing this project for the first time. Every command
below was actually run; the output shown is the output you will see.

**The rule this guide is built on: install into a separate home first, and touch your
working home only as its own deliberate decision.** The installer refuses to write into
your live home by default, on purpose — turning checks on is a decision, not a side
effect of running a script.

---

## What you need

| Requirement | Why |
|---|---|
| Node.js 18 or newer | the whole kit is plain scripts — no dependencies, no build step |
| DeepSeek Harness installed | version `0.1.5-rc.2` was tested; others are untested |
| This repository checked out | the commands below run **from its folder** |

There is nothing else to install. `npm install` is not needed: there are no third-party
packages.

---

## Step 1. A separate home

The harness home is `~/.dsh` (on Windows, `C:\Users\<you>\.dsh`). We will create a
**second, empty** home next to it and install there.

```powershell
$env:DSH_HOME = "$HOME\.dsh-pilot"
```

Why: your working profile stays exactly as it is. If anything goes wrong, deleting one
directory returns the machine to its current state — there is nothing to repair.

## Step 2. Create the profile — this must happen BEFORE the install

```powershell
node "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile jev-pilot --from-default-profile headless --dump-config
```

**The order is not a formality.** `--from-default-profile` regenerates
`cordis.patch.yml`. Install the kit first and create the profile second, and the kit's rows
are overwritten by an empty patch — silently, with no error at all. So the profile comes
first.

## Step 3. See what would happen (no writes)

```powershell
node scripts/jev-install.mjs --home $env:DSH_HOME --profile jev-pilot --dry-run
```

Output:

```
install (dry run) -> C:\Users\you\.dsh-pilot
wrote 9 file(s), backed up 0
manifest: C:\Users\you\.dsh-pilot\jev-install-manifest.json
```

Nothing is written at this step. It is a check.

## Step 4. Install

```powershell
node scripts/jev-install.mjs --home $env:DSH_HOME --profile jev-pilot
```

Same output, without the `dry run` marker. Nine files are written:

* `profiles/jev-pilot/cordis.patch.yml` — the two rows that mount the kit;
* `skills/<name>/SKILL.md` — eight skills;
* `jev-install-manifest.json` — the record of what was written, which the rollback uses.

If a file already existed, the installer **writes a backup first** — a sibling file with the
same name and a timestamp, such as `cordis.patch.yml.2026-09-26T12-00-00.bak`. A new file
gets no backup, because there is nothing to copy. An existing `SKILL.md` that is not ours
is skipped, never overwritten, so your own skills survive.

## Step 5. Verify

```powershell
node adapters/dsh/doctor.mjs
```

The doctor reports where the harness was found, its version, the profile, and — most
importantly — what is actually mounted. Read the `capabilities` section: each capability
carries `verified`, `conditional` or `unavailable`, together with the evidence for that
label. `verified` means the path was actually exercised, not merely described.

## Step 6. Roll back

```powershell
node scripts/jev-install.mjs --home $env:DSH_HOME --profile jev-pilot --uninstall
```

Output:

```
uninstall -> C:\Users\you\.dsh-pilot
removed 9, restored 0, kept 0
```

`removed 9` — exactly what was installed. `restored 0` — nothing had to be restored
(nothing was overwritten). `kept 0` — nothing was left behind. The home directory can
now be deleted entirely.

---

## What actually gets mounted

Two rows appear in `cordis.patch.yml`:

```yaml
- insert:
    - id: jev-tools
      name: 'file:///.../adapters/dsh/tools.mjs'
      config:
        mode: advisory
    - id: jev-adapter
      name: 'file:///.../adapters/dsh/plugin.mjs'
      config:
        mode: shadow
```

* `jev-tools` registers the six tools the model can see.
* `jev-adapter` is the **native adapter** — the part that actually checks calls before
  they run.

The eight skills teach the agent when to reach for those tools.

### What `mode` means

| Mode | Behaviour |
|---|---|
| `shadow` | the check is computed and journalled, but blocks nothing. The safe first run. |
| `enforce` | the check can **deny** a call. Turn this on deliberately, after reading the journal. |

The adapter installs as `shadow` by default: look first, deny later.

---

## What this guide deliberately leaves out

**The hooks bridge does not work.** A second installer exists,
`adapters/dsh/install.mjs`, which mounts a `@deepseek-ai/dsh-hooks-claude-code` row. With
the shipped sandboxed executors that path **cannot launch a single hook, and nothing
reports that** — the check silently does nothing. The doctor marks that capability
`conditional` and says plainly: use the native adapter, which needs no `shell` service.
That is why `scripts/jev-install.mjs` is the supported path.

**That second installer has no `--home`, and it does not protect your working home.** Even
its dry run aims straight at the live `profiles/web/cordis.patch.yml`. Isolation for it can
only be set through the `$env:DSH_HOME` and `$env:DSH_PROFILE` environment variables. If you
ever try it, set those first.

**Activating it on your working profile is a separate decision.** Installing into the
home you are running right now requires an explicit flag:

```powershell
node scripts/jev-install.mjs --home "$HOME\.dsh" --profile web --allow-active-home
```

Without `--allow-active-home` the installer refuses. That is not caution for its own sake:
such an install changes the profile the current session is running on, and the
consequences cannot be checked in advance.

**Judge quality is not measured here.** The kit verifies mechanism — that tools are
mounted, that the agent calls them, that a denial fires. It does **not** show that JEV
judgements are any good on your tasks: that needs real model calls, and this repository's
acceptance made none.

---

## When something does not work

| Symptom | Cause and what to do |
|---|---|
| `refusing to install into the live DSH home` | you pointed at your working home. That is the guard. Use a separate home, or add `--allow-active-home` if you truly mean it. |
| `doctor` says `bridge: installed but NOT mounted` | the row is not mounted in the profile. Expected if you installed via `adapters/dsh/install.mjs`; use `scripts/jev-install.mjs`. |
| The model cannot see the tools | confirm the profile you installed into is the one being loaded, and that the session was started with this `DSH_HOME`. |
| You need a diagnosis | `node adapters/dsh/doctor.mjs` lists what is proven and what is not, and does not present one as the other. |
