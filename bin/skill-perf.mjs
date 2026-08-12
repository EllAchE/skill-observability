#!/usr/bin/env node
// Profile skill executions from Claude Code transcripts via the harness-recorded
// `timestamp` and `attributionSkill` fields. Run with --help for usage.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const USAGE = `Usage: skill-perf [transcript.jsonl ...] [options]
  --latest N        analyze the N most recent sessions of the current project (default 1 when no paths given)
  --all-sessions    analyze every session transcript of the current project
  --project <dir>   project transcript dir (default: derived from cwd)
  --skill <name>    only report invocations of this skill
  --top N           slowest individual calls to list per invocation (default 5)
  --min-ms N        hide invocations shorter than N ms (default 0)
  --out-dir <dir>   also write one report file per skill, named <total-seconds>s-<skill>.txt
  --json            emit raw JSON instead of the report`;

const argv = process.argv.slice(2);
const opts = { paths: [], latest: null, allSessions: false, project: null, skill: null, top: 5, minMs: 0, outDir: null, json: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--latest") opts.latest = Number(argv[++i]);
  else if (a === "--all-sessions") opts.allSessions = true;
  else if (a === "--project") opts.project = argv[++i];
  else if (a === "--skill") opts.skill = argv[++i];
  else if (a === "--top") opts.top = Number(argv[++i]);
  else if (a === "--min-ms") opts.minMs = Number(argv[++i]);
  else if (a === "--out-dir") opts.outDir = argv[++i];
  else if (a === "--json") opts.json = true;
  else if (a === "--help" || a === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else opts.paths.push(a);
}

function configDir() {
  // CLAUDE_CONFIG_DIR relocates the whole .claude tree (incl. transcripts), so
  // the default lookup must honor it or it misses sessions under that root.
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function projectDir() {
  if (opts.project) return opts.project;
  const slug = process.cwd().replace(/[/.]/g, "-");
  return join(configDir(), "projects", slug);
}

function resolveTranscripts() {
  if (opts.paths.length && !opts.latest && !opts.allSessions) return opts.paths;
  const dir = projectDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files.length) {
    console.error(`no transcripts found in ${dir}`);
    process.exit(1);
  }
  if (opts.allSessions) return files;
  return files.slice(0, opts.latest ?? 1);
}

function summarizeInput(name, input) {
  if (!input) return "";
  const s =
    name === "Bash"
      ? input.description || input.command
      : name === "Skill"
        ? `${input.skill}${input.args ? ` ${input.args}` : ""}`
        : name === "Agent"
          ? `${input.subagent_type || "general"}: ${input.description}`
          : name === "AskUserQuestion"
            ? input.questions?.[0]?.question
            : name === "Grep"
              ? input.pattern
              : name === "WebFetch" || name === "WebSearch"
                ? input.url || input.query
                : input.file_path || input.path || input.query || input.prompt;
  return String(s ?? JSON.stringify(input))
    .replace(/\s+/g, " ")
    .slice(0, 90);
}

function mergedBusyMs(intervals) {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let busy = 0,
    curS = null,
    curE = null;
  for (const [s, e] of sorted) {
    if (curE === null || s > curE) {
      busy += (curE ?? 0) - (curS ?? 0);
      curS = s;
      curE = e;
    } else curE = Math.max(curE, e);
  }
  if (curE !== null) busy += curE - curS;
  return busy;
}

function emptyTokenUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

function tokenUsageFromMessage(usage) {
  if (!usage) return null;
  return {
    inputTokens: Number(usage.input_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? 0),
    cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? 0),
    cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? 0)
  };
}

function addTokenUsage(a, b) {
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  a.cacheCreationInputTokens += b.cacheCreationInputTokens;
  a.cacheReadInputTokens += b.cacheReadInputTokens;
  return a;
}

function totalTokenUsage(usage) {
  return usage.inputTokens + usage.outputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}

// Raw token counts overstate cache-read cost and understate output cost — a
// 2M-token invocation that's 95% cache-read is far cheaper than one that's
// 95% fresh output. Weight by Anthropic's published per-token price ratios
// (Sonnet: input $3, cache-write $3.75, cache-read $0.30, output $15 per M)
// relative to base input, so "cost units" is proportional to actual $ spend
// regardless of which model mix was in play.
const COST_WEIGHTS = { inputTokens: 1, cacheCreationInputTokens: 1.25, cacheReadInputTokens: 0.1, outputTokens: 5 };
function costUnits(usage) {
  return Object.entries(COST_WEIGHTS).reduce((sum, [k, w]) => sum + usage[k] * w, 0);
}

function analyzeTranscript(path) {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* truncated tail line */
    }
  }

  const calls = new Map(); // tool_use_id -> call record
  const ordered = []; // calls in issue order
  const usageByResponse = new Map();
  for (const e of entries) {
    if (e.isSidechain) continue; // subagent-internal entries; their cost is the parent Agent call's duration
    const ts = Date.parse(e.timestamp);
    if (e.type === "assistant") {
      const responseKey = e.requestId || e.message?.id || e.uuid;
      const usage = tokenUsageFromMessage(e.message?.usage);
      if (responseKey && usage && totalTokenUsage(usage) > 0) {
        const existing = usageByResponse.get(responseKey);
        if (existing) {
          existing.ts = Math.min(existing.ts, ts);
          if (!existing.skill && e.attributionSkill) existing.skill = e.attributionSkill;
          if (!existing.model && e.message?.model) existing.model = e.message.model;
        } else {
          usageByResponse.set(responseKey, {
            ts,
            skill: e.attributionSkill ?? null,
            model: e.message?.model ?? "unknown",
            usage
          });
        }
      }
    }
    if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      let hadToolUse = false;
      for (const block of e.message.content) {
        if (block.type !== "tool_use") continue;
        hadToolUse = true;
        const call = {
          id: block.id,
          name: block.name,
          ts,
          endTs: null,
          skill: e.attributionSkill ?? null,
          summary: summarizeInput(block.name, block.input),
          skillArg: block.name === "Skill" ? block.input?.skill : null
        };
        calls.set(block.id, call);
        ordered.push(call);
      }
      // Marker keeps an attributed tool-less turn (final answer / doc-read skill)
      // costing model time and visible in the report instead of vanishing.
      if (!hadToolUse && e.attributionSkill) ordered.push({ marker: true, ts, skill: e.attributionSkill });
    } else if (e.type === "user") {
      const content = e.message?.content;
      const blocks = Array.isArray(content) ? content : [];
      let hadToolResult = false;
      for (const block of blocks) {
        if (block.type === "tool_result" && calls.has(block.tool_use_id)) {
          calls.get(block.tool_use_id).endTs = ts;
          hadToolResult = true;
        }
      }
      // Mark real user prompts as boundaries so two separately-prompted runs of the
      // same skill don't merge; meta and pure tool_result turns aren't boundaries.
      if (!hadToolResult && !e.isMeta) ordered.push({ userTurn: true, ts });
    }
  }
  const usageEvents = [...usageByResponse.values()].filter((e) => e.skill);

  // Group into invocations: a Skill tool_use opens one and same-skill calls join it;
  // attribution switch, a new Skill call, or a real user prompt closes the previous.
  const invocations = [];
  let current = null;
  // Triggering user turn for the next invocation — the only start signal for a
  // marker-only run, whose marker ts is the *end* of generation, not the start.
  let lastUserTurnTs = null;
  for (const call of ordered) {
    if (call.userTurn) {
      current = null;
      lastUserTurnTs = call.ts;
      continue;
    }
    if (call.skillArg) {
      current = { skill: call.skillArg, session: path, skillCall: call, calls: [], markerTimes: [], precedingUserTs: lastUserTurnTs };
      invocations.push(current);
      continue;
    }
    if (call.skill) {
      if (!current || current.skill !== call.skill) {
        current = { skill: call.skill, session: path, skillCall: null, calls: [], markerTimes: [], precedingUserTs: lastUserTurnTs };
        invocations.push(current);
      }
      // A text-only attributed turn extends the invocation's reach (so inv.end
      // covers the trailing generation) without adding a counted tool call.
      if (call.marker) current.markerTimes.push(call.ts);
      else current.calls.push(call);
    } else if (current) {
      current = null;
    }
  }

  for (const inv of invocations) {
    const timed = inv.calls.filter((c) => c.endTs !== null);
    // Anchor at the triggering user turn so pre-first-tool model overhead (skill-doc
    // load, thinking) is counted; explicit Skill call wins, else fall back to keep wallMs > 0.
    const anchor =
      inv.skillCall ?? (inv.precedingUserTs != null ? { ts: inv.precedingUserTs } : (inv.calls[0] ?? { ts: inv.markerTimes[0] }));
    inv.start = anchor.ts;
    inv.end = Math.max(
      inv.start,
      ...timed.map((c) => c.endTs),
      ...inv.calls.map((c) => c.ts),
      ...inv.markerTimes,
      inv.skillCall?.endTs ?? 0
    );
    inv.wallMs = inv.end - inv.start;
    inv.toolBusyMs = mergedBusyMs(timed.map((c) => [c.ts, c.endTs]));
    inv.modelMs = Math.max(0, inv.wallMs - inv.toolBusyMs);
    inv.byTool = {};
    for (const c of timed) {
      const t = (inv.byTool[c.name] ??= { count: 0, totalMs: 0, maxMs: 0 });
      t.count++;
      t.totalMs += c.endTs - c.ts;
      t.maxMs = Math.max(t.maxMs, c.endTs - c.ts);
    }
    inv.userWaitMs = inv.byTool.AskUserQuestion?.totalMs ?? 0;
    inv.slowest = timed
      .map((c) => ({ tool: c.name, ms: c.endTs - c.ts, summary: c.summary }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, opts.top);
    inv.unfinished = inv.calls.filter((c) => c.endTs === null).length;
    inv.tokenUsage = emptyTokenUsage();
    inv.byModel = {};
    for (const event of usageEvents.filter((e) => e.skill === inv.skill && e.ts >= inv.start && e.ts <= inv.end)) {
      addTokenUsage(inv.tokenUsage, event.usage);
      const model = (inv.byModel[event.model] ??= emptyTokenUsage());
      addTokenUsage(model, event.usage);
    }
  }
  return invocations;
}

const fmt = (ms) => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const totalS = Math.round(ms / 1000);
  return `${Math.floor(totalS / 60)}m${String(totalS % 60).padStart(2, "0")}s`;
};

const fmtTokens = (n) => {
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1000000).toFixed(n < 10000000 ? 1 : 0)}M`;
};

function formatTokenUsage(usage) {
  return `tokens ${fmtTokens(totalTokenUsage(usage))} = input ${fmtTokens(usage.inputTokens)} + cache-write ${fmtTokens(usage.cacheCreationInputTokens)} + cache-read ${fmtTokens(usage.cacheReadInputTokens)} + output ${fmtTokens(usage.outputTokens)}`;
}

const transcripts = resolveTranscripts();
let invocations = transcripts.flatMap(analyzeTranscript);
if (opts.skill) invocations = invocations.filter((i) => i.skill === opts.skill);
invocations = invocations.filter((i) => i.wallMs >= opts.minMs);

// process.stdout.write instead of console.log + process.exit: exiting doesn't
// flush piped stdout, which truncates large --json output at the pipe buffer.
if (opts.outDir) writePerSkillReports(invocations, opts.outDir);
if (opts.json) {
  process.stdout.write(JSON.stringify(invocations, null, 2) + "\n");
} else if (!invocations.length) {
  console.log(`No skill invocations found in ${transcripts.length} session(s)${opts.skill ? ` for skill "${opts.skill}"` : ""}.`);
} else {
  printReport(invocations);
}

function invocationReport(inv) {
  const session = inv.session.split("/").pop().replace(".jsonl", "").slice(0, 8);
  const lines = [];
  lines.push(`\n■ ${inv.skill}  [session ${session}, started ${new Date(inv.start).toISOString()}]`);
  lines.push(
    `  wall ${fmt(inv.wallMs)} = tools ${fmt(inv.toolBusyMs)} + model ${fmt(inv.modelMs)}${inv.userWaitMs ? `  (incl. user-wait ${fmt(inv.userWaitMs)} in AskUserQuestion)` : ""}`
  );
  if (totalTokenUsage(inv.tokenUsage) > 0) lines.push(`  ${formatTokenUsage(inv.tokenUsage)}`);
  const tools = Object.entries(inv.byTool).sort((a, b) => b[1].totalMs - a[1].totalMs);
  for (const [name, t] of tools)
    lines.push(`    ${name.padEnd(18)} ×${String(t.count).padEnd(4)} total ${fmt(t.totalMs).padEnd(8)} max ${fmt(t.maxMs)}`);
  if (inv.slowest.length) {
    lines.push(`  slowest calls:`);
    for (const c of inv.slowest) lines.push(`    ${fmt(c.ms).padStart(8)}  ${c.tool}  ${c.summary}`);
  }
  if (inv.unfinished) lines.push(`  ⚠ ${inv.unfinished} call(s) without a recorded result (interrupted, denied, or still running)`);
  return lines.join("\n");
}

// One file per skill, total wall-clock seconds zero-padded into the name so a
// plain `ls` of the dir reads as the optimization priority list.
function writePerSkillReports(invocations, dir) {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (/^\d+s-.+\.txt$/.test(f)) unlinkSync(join(dir, f));
  const bySkill = {};
  for (const inv of invocations) (bySkill[inv.skill] ??= []).push(inv);
  for (const [skill, invs] of Object.entries(bySkill)) {
    const wallMs = invs.reduce((sum, i) => sum + i.wallMs, 0);
    // 5-digit pad keeps lexicographic ls order numeric up to ~27h of wall-clock
    const seconds = String(Math.round(wallMs / 1000)).padStart(5, "0");
    const file = `${seconds}s-${skill.replace(/[^\w.-]+/g, "-")}.txt`;
    const header = `# ${skill} — total wall ${fmt(wallMs)} across ${invs.length} invocation(s), generated ${new Date().toISOString()} from ${process.cwd()}`;
    writeFileSync(join(dir, file), [header, ...invs.map(invocationReport)].join("\n") + "\n");
  }
}

function printReport(invocations) {
  for (const inv of invocations) console.log(invocationReport(inv));

  if (invocations.length > 1) {
    const bySkill = {};
    for (const inv of invocations) {
      const s = (bySkill[inv.skill] ??= { n: 0, wall: 0, tools: 0, model: 0, tokenUsage: emptyTokenUsage() });
      s.n++;
      s.wall += inv.wallMs;
      s.tools += inv.toolBusyMs;
      s.model += inv.modelMs;
      addTokenUsage(s.tokenUsage, inv.tokenUsage);
    }
    console.log(`\n— aggregate by wall-clock across ${invocations.length} invocations —`);
    for (const [skill, s] of Object.entries(bySkill).sort((a, b) => b[1].wall - a[1].wall)) {
      const tokens = totalTokenUsage(s.tokenUsage) > 0 ? `, ${formatTokenUsage(s.tokenUsage)}` : "";
      console.log(
        `  ${skill.padEnd(28)} ×${String(s.n).padEnd(3)} wall ${fmt(s.wall).padEnd(8)} avg ${fmt(Math.round(s.wall / s.n)).padEnd(8)} (tools ${fmt(s.tools)}, model ${fmt(s.model)}${tokens})`
      );
    }

    // Wall-clock ranking is dominated by human AskUserQuestion wait, which is
    // not a skill-efficiency signal. Cost-unit ranking (see costUnits) is the
    // $-proportional view: it can and often does reorder relative to wall.
    const withCost = Object.entries(bySkill).map(([skill, s]) => [skill, s, costUnits(s.tokenUsage)]);
    const totalCost = withCost.reduce((sum, [, , c]) => sum + c, 0) || 1;
    console.log(`\n— aggregate by token cost across ${invocations.length} invocations —`);
    for (const [skill, s, cost] of withCost.sort((a, b) => b[2] - a[2])) {
      const pct = ((cost / totalCost) * 100).toFixed(1);
      console.log(`  ${skill.padEnd(28)} ×${String(s.n).padEnd(3)} ${pct.padStart(5)}% of cost   ${formatTokenUsage(s.tokenUsage)}`);
    }
  }
}
