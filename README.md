# Skill Observability

Measure agent skills from the local transcripts you already have. No collector,
database, API key, or model call is required.

The toolkit answers three different questions:

| Command | Question |
| --- | --- |
| `skill-perf` | Which Claude Code skills are slow, and is the time going to tools, model work, or user waits? |
| `skill-cost` | Which skills and base conversations drive estimated Claude token cost? |
| `agent-usage` | Where did recent Claude Code and Codex tokens go by source, model, project, and session? |

It also includes a Bash `SessionEnd` hook that refreshes performance reports on a
random sample of sessions. The default is one in twenty after the first run.

## What it measures

`skill-perf` reconstructs each attributed skill invocation from Claude Code JSONL:

- wall-clock time split into merged tool-busy time and model time;
- per-tool totals and the slowest individual calls;
- interactive user-wait time and unfinished or denied tool calls;
- fresh input, cache-write, cache-read, and output tokens;
- aggregate rankings by wall clock and cost-weighted token units.

`skill-cost` gives the spend lens:

- estimated standard-tier cost by attributed skill;
- a separate base-conversation bucket for unattributed turns;
- exact sidechain accounting when the transcript includes it;
- context re-read and base-conversation guardrails for automation;
- costly base-session hotspots and reported subagent usage.

`agent-usage` gives the cross-client lens:

- Claude Code and Codex token totals by source, model, project, and session;
- the latest backend-reported Codex plan windows found in local rollouts;
- streaming reads for large Codex rollout files.

## Requirements

- Node.js 20 or newer.
- Claude Code transcripts under `~/.claude/projects` for skill attribution.
- Codex rollouts under `~/.codex/sessions` for Codex usage and plan windows.
- Bash for the optional sampled hook.

`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honored when those stores live elsewhere.

## Install

Install directly from GitHub:

```bash
npm install --global github:EllAchE/skill-observability
```

Or clone the repository and expose its commands while developing:

```bash
git clone https://github.com/EllAchE/skill-observability.git
cd skill-observability
npm link
```

There are no runtime dependencies.

## Use

Profile the latest Claude Code session for the current project:

```bash
skill-perf
```

Compare one skill across the latest twenty sessions:

```bash
skill-perf --latest 20 --skill code-review
```

Generate one report per skill, sorted naturally by total wall time:

```bash
skill-perf --latest 20 --out-dir /tmp/claude/skill-perf
ls -r /tmp/claude/skill-perf
```

Audit estimated Claude cost across every local project:

```bash
skill-cost --all-projects
```

Fail an automation check when average context re-read or base-conversation share
crosses the built-in thresholds:

```bash
skill-cost --all-projects --guardrail
```

Inspect recent usage across Claude Code and Codex:

```bash
agent-usage --days 7 --top 20
```

Every command supports `--json` for machine-readable output and `--help` for its
full option list.

## Sample completed sessions

The optional hook always runs when no previous report exists. After that it rolls
one in twenty on each completed Claude Code session. Sampling invokes only the
local Node parser, so it adds no token or API spend.

Add this command hook to the `SessionEnd` list in your Claude Code settings. Use
the absolute path to your checkout:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/skill-observability/bin/sample-audit-hook.sh",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

The hook refreshes `/tmp/claude/skill-perf/` from the ten most recent sessions.
Set `SKILL_PERF_SAMPLE_RATE=1` to run every time, or set `SKILL_PERF_DIR` to use a
different report directory.

## How the timing split works

Claude Code records timestamps on tool calls and results. `skill-perf` merges
overlapping tool intervals so parallel work is counted once, then computes:

```text
wall clock = merged tool-busy time + model time
```

Model time therefore includes thinking, generation, skill-document processing,
API latency, and queue latency. Compare runs with each other rather than treating
it as pure inference time.

## Cost estimates

`skill-cost` weights input, output, five-minute cache writes, one-hour cache
writes, and cache reads separately. Defaults model standard Anthropic API rates;
they are estimates rather than billing records. Long-context premiums, service
tiers, and temporary promotions are not inferred.

Override any family rate with environment variables such as `OPUS_OUTPUT`,
`SONNET_READ`, or `HAIKU_INPUT`. Check current rates on the
[Anthropic pricing page](https://www.anthropic.com/pricing).

Codex subscription usage is intentionally not converted to dollars. `agent-usage`
reports the backend `rate_limits` snapshot recorded by Codex as the authoritative
plan-window view and uses local tokens only to explain where usage went.

## Privacy and caveats

- The tools read local transcript files and make no network requests.
- JSONL transcripts can contain prompts, tool inputs, paths, and other sensitive
  data. Human-readable performance reports include short slow-call summaries; do
  not publish reports without reviewing them.
- Skill timing and cost attribution require Claude Code's `attributionSkill`
  field. Unattributed responses remain visible in the base-conversation bucket.
- Transcript formats are owned by their respective clients and may change.
- A parent agent call includes the subagent's elapsed time, but the parent timing
  report excludes sidechain internals to avoid double-counting.
- The sampled hook uses Bash and is not supported natively on Windows.

## Development

```bash
npm test
```

The tests build temporary transcript stores and exercise all three CLIs plus the
sampled hook. No real transcripts are read.

## License

MIT
