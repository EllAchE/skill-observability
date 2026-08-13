---
name: prune-memory
description: Audit and prune a Claude Code project memory store. Use when the user asks to inspect MEMORY.md, remove expired or stale memories, fix expiry coverage, or reduce always-loaded memory context without promoting policy into shared documentation.
---

# Prune Memory

Keep this workflow focused on the personal memory store. Route durable policy that
should move into version-controlled documentation through `share-memory`.

## Workflow

1. Resolve the memory directory. Use the explicit path when supplied; otherwise
   derive `~/.claude/projects/<munged-project-path>/memory` from the current project.
2. Exit without changes when `MEMORY.md` is absent.
3. Record the `MEMORY.md` byte size and entry count, then run
   `memory-prune <memory-dir>`. Its default mode is a dry run that reports expired
   files and invalid or missing expiry metadata.
4. Backfill missing expiry metadata without deleting content. Choose dates by how
   quickly the fact decays:
   - machine, path, version, or tooling state: about six months;
   - in-flight work: its expected completion date, or one month;
   - already codified policy: one month;
   - genuinely permanent facts only: `9999-12-31`.
5. Re-run the dry-run sweep. Treat missing or invalid expiry as audit debt, not
   permanence.
6. For stale index rows that are not expiry-driven, re-read live `MEMORY.md` with
   line numbers immediately before proposing edits. Identify each row by title and
   reason, highest line number first.
7. Remove index rows only when the user asked for edits. Explain that removing an
   index row changes startup context while deleting its backing file is stronger.
8. Delete expired memory files only after explicit approval of the exact set. Run
   `memory-prune --delete <memory-dir>`; its default mode is a dry run.
9. Re-run `memory-prune`, then report before/after bytes, entries, files, and every
   deleted or retained item.

Keep active private preferences, necessary local machine facts, and current work
that has no better tracker. Prune resolved status breadcrumbs, duplicated rules,
transient tool facts, and memories already represented more accurately elsewhere.
