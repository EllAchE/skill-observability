---
name: audit-skills
description: Audit a repository or personal skill inventory for structural errors, duplicate names, broken links, recent transcript usage, external callers, and conservative retirement candidates. Use when the user asks what skills exist, which are broken or unused, or whether any skills may be dead.
---

# Audit Skills

## Workflow

1. Resolve the skill roots and repository. Exit when no `SKILL.md` files exist.
2. Run `skill-audit --root <root> --repo <repository> --json`, repeating `--root` for
   every inventory that should be compared.
3. Interpret status conservatively:
   - `used`: observed in a recent Claude transcript;
   - `referenced`: has a strong caller, hook, command, policy, or skill reference;
   - `new-unobserved`: not yet observed but younger than the audit window;
   - `retire-candidate`: no recent transcript evidence or strong caller and older
     than the window;
   - `broken`: invalid metadata, duplicate name, folder mismatch, or broken link.
4. Review every broken record and candidate's full JSON evidence. Search dynamic
   callers and alternate machines or transcript stores that the audit cannot see.
5. Report structural fixes separately from retirement candidates. Lack of local
   evidence is never proof that a skill is unused.
6. Route approved structural changes through `update-skill` and retirement through
   `retire-skill`.

This skill is read-only. Never delete, archive, or edit skills during the audit.
