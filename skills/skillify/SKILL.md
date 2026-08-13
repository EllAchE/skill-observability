---
name: skillify
description: Turn one previous Claude Code or Codex session into a focused reusable skill. Use when the user provides a transcript, session ID, or remembered task and asks to capture, extract, or skillify the repeatable workflow.
---

# Skillify

Produce an operating guide, not a transcript recap or a skill for a one-off result.

## Workflow

1. Require a concrete transcript path, session ID, or remembered description. Do not
   search or write when the reference is empty.
2. Find one source session in the local Claude or Codex transcript store. Widen a
   text search only when needed. If multiple candidates remain plausible, show their
   source, ID, project, time, and matching evidence, then ask the user to choose.
3. Read the selected transcript without resuming or modifying it. Never merge separate
   sessions into one source workflow.
4. Extract the durable goal, inputs, decisions, ordered actions, outputs, validation,
   corrections, failure paths, tools, and human checkpoints. Treat later user
   corrections as authoritative over earlier behavior.
5. Remove secrets, ephemeral identifiers, local-only values, dated status, and
   incidental conversation. Mark any unsupported inference as an assumption.
6. Stop if the session only records a one-off action. Explain why it does not merit a
   skill.
7. Infer a name, triggers, arguments, and destination only when unambiguous. Resolve
   material gaps with concise questions.
8. Draft the complete proposed `SKILL.md` and any genuinely reusable resources. Show
   the exact artifact and destination before writing.
9. After approval, route the artifact through `create-skill`, including its inventory
   check, script tests, and structural audit.
10. Report the source session ID, saved path, invocation examples, validation result,
    and transcript-unsupported assumptions.

Do not infer authority for publishing, messaging, deployment, production writes, or
spending from the source session. Encode a fresh approval checkpoint instead.
