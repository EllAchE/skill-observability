---
name: update-skill
description: Revise an existing agent skill while preserving its ownership boundary, invocation intent, progressive disclosure, safety gates, and reusable resources. Use when the user asks to improve, modernize, tighten, rename, or codify new guidance in an existing skill.
---

# Update Skill

## Preconditions

1. Resolve the exact target and confirm its `SKILL.md` exists. Route missing targets
   through `create-skill`.
2. Confirm the new information changes how the repeatable workflow triggers, decides,
   executes, validates, or stops. Keep one-off status outside the skill.
3. Read the entire `SKILL.md` and only the directly relevant bundled resources.

## Workflow

1. Read the source artifact for the requested change: user correction, memory,
   issue, trace, failure, documentation, or duplicated skill text.
2. Keep mechanics in the skill that performs the work. Other skills get a short
   routing pointer rather than a copied procedure.
3. Edit narrowly. Preserve correct instructions and remove contradictions,
   obsolete branches, redundant prose, and unused resources.
4. Keep metadata triggers precise. If the skill name changes, search callers,
   hooks, docs, configuration, and transcripts for the old name.
5. Maintain progressive disclosure: core decisions in `SKILL.md`, optional detail
   in one-level-deep references, deterministic repeated work in scripts.
6. Test changed scripts and realistic failure paths.
7. Run `skill-audit --root <skill-root> --repo <repository> --strict` and inspect the
   target's JSON record for structural errors and broken links.
8. Forward-test behavior-changing revisions when safe, using a raw representative
   task without leaking the desired result.
9. Treat an already-codified request as a valid no-op. Cite the existing section
   rather than churning prose.
10. Follow the repository's review and delivery conventions.

A rename is incomplete while any model-facing caller or hook still uses the old name.
