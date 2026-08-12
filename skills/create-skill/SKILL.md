---
name: create-skill
description: Create a focused agent skill with deterministic applicability, concise SKILL.md instructions, reusable scripts or references only when justified, and validation against the surrounding skill inventory. Use when the user asks to create, scaffold, add, or define a new skill.
---

# Create Skill

## Preconditions

Before writing, confirm all of the following:

1. The requested workflow is repeatable and carries non-obvious procedure, domain
   knowledge, or deterministic tooling. Put one-off prose in documentation instead.
2. The skill has a checkable applicability condition and a recognizable user goal.
3. The target skill root is known. Use the repository's local `skills/` directory
   when requested; otherwise ask before writing to a personal skill store.
4. No existing skill already owns the workflow. Run `skill-audit --root <skill-root>
   --repo <repository> --json` and inspect close names and descriptions.

## Author

1. Gather concrete trigger examples, expected inputs, successful outputs, stopping
   conditions, and actions that require approval.
2. Choose a short verb-led name using lowercase letters, digits, and hyphens. Keep
   it under 64 characters and make the folder name identical.
3. Plan only reusable resources:
   - `scripts/` for deterministic operations that would otherwise be rewritten;
   - `references/` for optional domain detail;
   - `assets/` for templates copied into outputs.
4. Create `skills/<name>/SKILL.md` with YAML frontmatter containing `name` and a
   description that says both what the skill does and when it triggers.
5. Keep the body imperative and concise. Start with a deterministic precondition,
   then state the ordered workflow, outputs, failure paths, safety boundaries, and
   explicit approval gates for destructive or externally visible actions.
6. Link every optional resource directly from `SKILL.md`. Avoid nested reference
   chains and duplicate prose.
7. Test every bundled script on synthetic or non-sensitive fixtures.
8. Run `skill-audit --root <skill-root> --repo <repository> --strict`. Fix structural
   errors, duplicate names, folder mismatches, and broken relative links.
9. Forward-test complex skills with a realistic raw task when safe. Do not give the
   tester the intended answer or diagnosis.
10. Follow the target repository's review and delivery conventions.

Do not create extra README, changelog, or installation files inside an individual
skill folder. The skill should stand on its `SKILL.md` and directly used resources.
