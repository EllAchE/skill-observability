---
name: retire-skill
description: Safely retire or remove an exact agent skill after checking recent transcript usage, callers, hooks, configuration, replacement coverage, and recovery options. Use when the user asks to remove, delete, archive, deprecate, or clean up a dead or unused skill.
---

# Retire Skill

Retirement is a separate decision from detection. Never delete a skill merely because
an audit did not observe it.

## Preconditions

1. Require an exact skill name and root. Confirm `<root>/<name>/SKILL.md` exists.
2. Run `skill-audit --root <root> --repo <repository> --json` and select the exact
   record. Stop when the name is ambiguous across roots.
3. Read the complete skill and identify what capability, scripts, references, assets,
   hooks, commands, and callers would disappear.

## Establish Retirement Safety

1. Inspect recent transcript evidence over an appropriate window. Check other known
   machines or transcript stores when local history is incomplete.
2. Search the full repository for the skill name, path, invocation syntax, bundled
   script paths, scheduled prompts, hooks, aliases, and dynamic dispatch tables.
3. Determine whether the capability is obsolete, duplicated, or replaced. Verify the
   replacement actually covers every live caller before rewriting references.
4. Classify the result:
   - `KEEP`: active, uniquely capable, or evidence is insufficient;
   - `DEPRECATE`: callers need a migration period;
   - `RETIRE`: no live need remains and callers are absent or safely migrated.
5. Present the verdict, evidence window, exact removal set, caller migrations, and
   recovery plan. Obtain explicit approval before deleting or moving any file.

## Execute An Approved Retirement

1. For a tracked repository, delete the skill and update callers in one reviewable
   change; version control is the recovery path. For an untracked personal store,
   move it outside the active skill root to a dated retirement directory unless the
   user explicitly requests irreversible deletion.
2. Do not leave a forwarding skill unless a migration period is intentional. A stale
   wrapper keeps consuming metadata and hides whether migration finished.
3. Re-run `skill-audit --strict`, repository tests, and any invocation-policy checks.
4. Search again for the retired name and path. Explain every intentional remaining
   historical or documentation reference.
5. Report removed files, migrated callers, validation, and the recovery location or
   version-control commit.

If evidence conflicts or a dynamic caller cannot be resolved, keep the skill and report
the blocker instead of guessing.
