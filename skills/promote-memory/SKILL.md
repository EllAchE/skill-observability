---
name: promote-memory
description: Promote durable facts and operating rules from a personal Claude Code memory store into the nearest version-controlled skill, AGENTS.md, documentation, or knowledge file, then remove only memories already verified as redundant on the repository's default branch. Use for sharing, raising, consolidating, or codifying memories.
---

# Promote Memory

Move durable guidance to its real source of truth without losing the only live copy.

## Preconditions

1. Resolve the project memory directory and exit when `MEMORY.md` is absent or empty.
2. Identify the target repository and read its instructions before proposing changes.
3. Run `memory-audit <memory-dir>` to establish index and expiry health.

## Classify Every Candidate

Inspect feedback, reference, and user-preference memories. Treat one-off project
status as pruning material unless it contains a reusable rule.

Assign one verdict per memory:

- `REDUNDANT`: fully represented in a tracked file on the default branch.
- `CODIFY`: durable and general, with no shared home yet.
- `PARTIAL`: represented, but the memory adds durable missing nuance.
- `KEEP`: private, machine-specific, transient, personal, or too narrow to share.

Verify every claim against live tracked files. Do not classify from titles alone.

## Promote

1. Route each `CODIFY` or `PARTIAL` item to the nearest owner:
   - repository-wide behavior needed in most sessions: `AGENTS.md`;
   - one repeatable workflow: its owning `SKILL.md`;
   - subsystem policy: the nearest subtree instruction or maintained documentation;
   - durable architecture, vendor, operations, or domain facts: the repository's
     knowledge or reference area.
2. Add the smallest durable rule. Do not paste investigation history or dated status.
3. Follow the target repository's branch, validation, and review process.
4. Never delete a memory promoted in the same run. Until the change lands on the
   default branch, the memory remains the only guaranteed copy.

## Remove Redundant Copies

For each `REDUNDANT` item, re-confirm the complete rule on the current default branch.
Only then, and only with explicit approval of the exact files, delete the backing
memory and its `MEMORY.md` row. If verification is incomplete, downgrade to `KEEP`.

Finish by running `memory-audit` again and reporting verdict counts, tracked changes,
deletions, and index size before/after. Promotion and deletion are intentionally a
two-pass process.
