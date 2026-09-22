---
name: jev-approval-gate
description: Decide whether an action needs a human before it happens — public pushes, deletes, publishing, sending data outward, mass rewrites. Deterministic and free: no model, no network, no latency. Use before any irreversible action, and as the compensating control when approval prompts are disabled.
whenToUse: About to run something that cannot be undone, or to publish or send anything outward. Also when approval prompts are turned off and something has to stand in for them.
---

# Approval gate — before the irreversible step

**A recommendation, not an enforcement.** The gate decides; the caller obeys. It does
nothing on its own and blocks nothing.

```bash
node scripts/jev-gateway.mjs --action push_public --external --public --reversible=false
node scripts/jev-gateway.mjs --rules                 # the whole rule table on one screen
echo '{"action":"edit_readme","reversible":true}' | node scripts/jev-gateway.mjs --quiet
```

| exit | verdict | meaning |
|---|---|---|
| 0 | `allow` | go ahead |
| 2 | `human` | stop and ask a human first |

## Rules are data, not branches

| rule | fires when |
|---|---|
| `credential_out` | credentials leave the machine |
| `destructive_irreversible` | destructive with no way back |
| `public_irreversible` | published outward with no way back |
| `external_irreversible` | an external action with no way back |
| `bulk_irreversible` | a bulk operation with no way back |
| `undeclared` | the action was not described — there is nothing to judge |

Irreversibility is only what you declare: `--reversible=false`. Everything else defaults to
reversible, because a gate that interrupts routine work is switched off the same day.

## Use it in a hook

```sh
#!/bin/sh
node /path/to/jev-gates/scripts/jev-gateway.mjs \
  --action "git push" --external --public --reversible=false || {
  echo "this push needs a human decision first"; exit 1; }
```

## Limits

- It cannot catch a **misdeclared** flag. An action described as safe but destructive passes.
  Describing the action honestly is part of the work, not paperwork.
- It does not know your project's rules. Add them as rules rather than as exceptions in
  someone's memory.
- Under an approval policy of `never`, an "ask" from a harness hook becomes an automatic
  **deny** with a misleading reason. See the `jev-dsh-adapter` documentation before wiring
  this into one.
