#!/usr/bin/env node
// Attribute Claude Code token spend across transcripts: cost-weighted, grouped by
// skill (with a "(no skill — base conversation)" bucket) and by model. Streams the
// JSONL transcripts the harness already writes — no telemetry/collector needed.
//
// Token usage lives on every `assistant` entry under `message.usage`. We de-dupe by
// response id (one usage record per model response) exactly like skill-perf.mjs, then
// weight each component (fresh input / cache-write / cache-read / output) by the
// per-model rate so the ranking reflects DOLLARS, not raw token volume (cache-read is
// ~10x cheaper than fresh input and ~50x cheaper than output, so a raw-token ranking
// is dominated by cheap cache reads and misleads).
//
// Run with --help for usage.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const USAGE = `Usage: skill-cost [options]
  --project <dir>    one project transcript dir (default: derived from cwd)
  --all-projects     scan every project under ~/.claude/projects (true total spend)
  --since <ISO>      only count responses at/after this timestamp (e.g. 2026-06-16)
  --skill <name>     substring-match skill names (use "(no skill" for the base bucket)
  --top N            rows to print (default: all)
  --include-sidechain include assistant entries marked isSidechain (default)
  --exclude-sidechain skip assistant entries marked isSidechain
  --sidechain-only    count only assistant entries marked isSidechain
  --agent-report N    print parent-skill totals from Agent <usage> tool results (default: 10)
  --base-sessions N   print costly base-conversation session hotspots (default: 5)
  --guardrail         apply the standard 80k avg-read and 50% base-cost limits
  --max-avg-read-k N  exit nonzero when avg cache-read per response exceeds N thousand tokens
  --max-base-pct N    exit nonzero when base-conversation cost share exceeds N percent
  --json             emit raw JSON instead of the table
Rates are approximate standard-tier USD/MTok; the >200k 1M-context premium is NOT
modeled, so dollar figures are a FLOOR. Override via env, e.g. OPUS_OUTPUT=25.`;

const argv = process.argv.slice(2);
const opts = {
  project: null,
  allProjects: false,
  since: null,
  skill: null,
  top: Infinity,
  json: false,
  includeSidechain: true,
  sidechainOnly: false,
  agentReport: 10,
  baseSessions: 5,
  guardrail: false,
  maxAvgReadK: null,
  maxBasePct: null
};
const seenSidechainMode = { exclude: false, only: false };
function rejectIncompatibleSidechainModes() {
  if (seenSidechainMode.exclude && seenSidechainMode.only) {
    console.error("--exclude-sidechain and --sidechain-only are mutually exclusive");
    process.exit(2);
  }
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--project") opts.project = argv[++i];
  else if (a === "--all-projects") opts.allProjects = true;
  else if (a === "--include-sidechain") opts.includeSidechain = true;
  else if (a === "--exclude-sidechain") {
    seenSidechainMode.exclude = true;
    rejectIncompatibleSidechainModes();
    opts.includeSidechain = false;
  } else if (a === "--sidechain-only") {
    seenSidechainMode.only = true;
    rejectIncompatibleSidechainModes();
    opts.sidechainOnly = true;
  } else if (a === "--since") {
    opts.since = Date.parse(argv[++i]);
    if (Number.isNaN(opts.since)) {
      console.error("--since: invalid date");
      process.exit(2);
    }
  } else if (a === "--skill") opts.skill = argv[++i];
  else if (a === "--top") {
    opts.top = Number(argv[++i]);
    if (Number.isNaN(opts.top)) {
      console.error("--top: invalid number");
      process.exit(2);
    }
  } else if (a === "--agent-report") {
    opts.agentReport = Number(argv[++i]);
    if (Number.isNaN(opts.agentReport) || opts.agentReport < 0) {
      console.error("--agent-report: invalid number");
      process.exit(2);
    }
  } else if (a === "--base-sessions") {
    opts.baseSessions = Number(argv[++i]);
    if (Number.isNaN(opts.baseSessions) || opts.baseSessions < 0) {
      console.error("--base-sessions: invalid number");
      process.exit(2);
    }
  } else if (a === "--guardrail") opts.guardrail = true;
  else if (a === "--max-avg-read-k") {
    opts.maxAvgReadK = Number(argv[++i]);
    if (Number.isNaN(opts.maxAvgReadK) || opts.maxAvgReadK < 0) {
      console.error("--max-avg-read-k: invalid number");
      process.exit(2);
    }
  } else if (a === "--max-base-pct") {
    opts.maxBasePct = Number(argv[++i]);
    if (Number.isNaN(opts.maxBasePct) || opts.maxBasePct < 0) {
      console.error("--max-base-pct: invalid number");
      process.exit(2);
    }
  } else if (a === "--json") opts.json = true;
  else if (a === "--help" || a === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else {
    console.error(`unknown arg: ${a}`);
    process.exit(2);
  }
}

if (opts.guardrail && opts.skill) {
  console.error("--guardrail cannot be combined with --skill");
  process.exit(2);
}
if (opts.guardrail) {
  opts.maxAvgReadK ??= 80;
  opts.maxBasePct ??= 50;
}

const num = (envKey, dflt) => Number(process.env[envKey] ?? dflt);
// Per-million-token USD, standard tier; override any cell via env.
// Prompt caching uses the published 1.25× input rate for 5m writes,
// 2× for 1h writes, and 0.1× for reads.
const RATES = {
  opus: {
    input: num("OPUS_INPUT", 5),
    output: num("OPUS_OUTPUT", 25),
    write: num("OPUS_WRITE", 6.25),
    write1h: num("OPUS_WRITE_1H", 10),
    read: num("OPUS_READ", 0.5)
  },
  sonnet: {
    input: num("SONNET_INPUT", 3),
    output: num("SONNET_OUTPUT", 15),
    write: num("SONNET_WRITE", 3.75),
    write1h: num("SONNET_WRITE_1H", 6),
    read: num("SONNET_READ", 0.3)
  },
  haiku: {
    input: num("HAIKU_INPUT", 1),
    output: num("HAIKU_OUTPUT", 5),
    write: num("HAIKU_WRITE", 1.25),
    write1h: num("HAIKU_WRITE_1H", 2),
    read: num("HAIKU_READ", 0.1)
  }
};
RATES.unknown = RATES.opus; // unlabeled responses assumed Opus (the default model)
// WHY order matters: 3-5-haiku must match before 3-haiku; opus-4-[01] (legacy 4.0/4.1) before 3-opus.
// Rates are public standard-tier USD/MTok; write/write1h/read derived at 1.25×/2×/0.1× of input.
const MODEL_RATES = [
  [/claude-opus-4-[01]\b|claude-opus-4-20/i, { input: 15, output: 75, write: 18.75, write1h: 30, read: 1.5 }],
  [/claude-3-opus/i, { input: 15, output: 75, write: 18.75, write1h: 30, read: 1.5 }],
  [/claude-3-5-haiku/i, { input: 0.8, output: 4, write: 1, write1h: 1.6, read: 0.08 }],
  [/claude-3-haiku/i, { input: 0.25, output: 1.25, write: 0.313, write1h: 0.5, read: 0.025 }]
];
const modelRates = (model) => {
  if (model) for (const [re, r] of MODEL_RATES) if (re.test(model)) return r;
  const fam = !model
    ? "unknown"
    : /opus/i.test(model)
      ? "opus"
      : /sonnet/i.test(model)
        ? "sonnet"
        : /haiku/i.test(model)
          ? "haiku"
          : "unknown";
  return RATES[fam];
};

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}
function projectsRoot() {
  return join(configDir(), "projects");
}
function defaultProjectDir() {
  return join(projectsRoot(), process.cwd().replace(/[/.]/g, "-"));
}
function resolveDirs() {
  if (opts.project) return [opts.project];
  if (opts.allProjects) {
    const root = projectsRoot();
    return readdirSync(root)
      .map((d) => join(root, d))
      .filter((d) => {
        try {
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      });
  }
  return [defaultProjectDir()];
}

// Token counts plus the dollar cost each component contributed (real per-model
// rate, summed at accumulation time) so the component breakdown matches the
// per-skill totals instead of re-deriving them under a single assumed model.
const empty = () => ({
  input: 0,
  output: 0,
  write: 0,
  read: 0,
  cInput: 0,
  cOutput: 0,
  cWrite: 0,
  cRead: 0,
  cost: 0,
  n: 0,
  sidechainN: 0,
  sidechainCost: 0,
  sidechainRead: 0
});
const BASE = "(no skill — base conversation)";
const SIDECHAIN_BASE = "(sidechain — no skill)";

function accumulate(agg, usage, rates, isSidechain = false) {
  agg.input += usage.input;
  agg.output += usage.output;
  agg.write += usage.write;
  agg.read += usage.read;
  agg.n++;
  const r = rates;
  const cInput = (usage.input * r.input) / 1e6;
  const cOutput = (usage.output * r.output) / 1e6;
  const cWrite = (usage.write5m * r.write) / 1e6 + (usage.write1h * r.write1h) / 1e6;
  const cRead = (usage.read * r.read) / 1e6;
  const cost = cInput + cOutput + cWrite + cRead;
  agg.cInput += cInput;
  agg.cOutput += cOutput;
  agg.cWrite += cWrite;
  agg.cRead += cRead;
  agg.cost = agg.cInput + agg.cOutput + agg.cWrite + agg.cRead;
  if (isSidechain) {
    agg.sidechainN++;
    agg.sidechainCost += cost;
    agg.sidechainRead += usage.read;
  }
}

function addAgentAgg(map, key, result) {
  if (!map.has(key)) map.set(key, { key, calls: 0, tokens: 0, toolUses: 0, durationMs: 0 });
  const agg = map.get(key);
  agg.calls++;
  agg.tokens += result.tokens;
  agg.toolUses += result.toolUses;
  agg.durationMs += result.durationMs;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join("\n");
}

const bySkill = new Map();
const baseBySession = new Map();
const agentCalls = new Map();
const agentResultKeys = new Set();
const agentBySkill = new Map();
const agentByDescription = new Map();
const total = empty();
// Keyed entries buffered so a later copy with attributionSkill upgrades one without.
// Null-keyed entries (no requestId/message.id/uuid) are undeduplicable and counted immediately.
const pending = new Map(); // key → {skill, usage, rates, isSidechain, sessionKey}
// Agent results buffered until every file is scanned, so a later duplicate Agent tool_use
// carrying the real attributionSkill upgrades agentCalls before the result is bucketed.
const pendingAgentResults = new Map(); // resultKey → {tokens, toolUses, durationMs}
let sessions = 0,
  scannedDirs = 0;

for (const dir of resolveDirs()) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    continue;
  }
  if (files.length) scannedDirs++;
  const projectName = dir.split("/").pop() || dir;
  for (const f of files) {
    sessions++;
    const sessionKey = `${projectName}/${f}`;
    let content;
    try {
      content = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const messageContent = entry.message?.content;
      if (entry.type === "assistant" && Array.isArray(messageContent)) {
        for (const part of messageContent) {
          if (part?.type !== "tool_use" || part.name !== "Agent") continue;
          const existingCall = agentCalls.get(part.id);
          if (existingCall && (existingCall.skill !== BASE || entry.attributionSkill == null)) continue;
          agentCalls.set(part.id, {
            skill: entry.attributionSkill ?? BASE,
            description: part.input?.description ?? "(no description)",
            subagentType: part.input?.subagent_type ?? "general"
          });
        }
      }
      if (entry.type === "user" && Array.isArray(entry.message?.content)) {
        if (opts.since != null) {
          const ts = Date.parse(entry.timestamp);
          if (!(ts >= opts.since)) continue;
        }
        for (const part of entry.message.content) {
          if (part?.type !== "tool_result" || !part.tool_use_id) continue;
          const resultKey = part.tool_use_id;
          if (agentResultKeys.has(resultKey)) continue;
          const text = textFromContent(part.content);
          const tokens = Number((text.match(/subagent_tokens:\s*([0-9,]+)/) ?? [])[1]?.replaceAll(",", "") ?? 0);
          if (!tokens) continue;
          const toolUses = Number((text.match(/tool_uses:\s*([0-9,]+)/) ?? [])[1]?.replaceAll(",", "") ?? 0);
          const durationMs = Number((text.match(/duration_ms:\s*([0-9,]+)/) ?? [])[1]?.replaceAll(",", "") ?? 0);
          pendingAgentResults.set(resultKey, { tokens, toolUses, durationMs });
          agentResultKeys.add(resultKey);
        }
      }
      if (entry.type !== "assistant") continue;
      const isSidechain = entry.isSidechain === true;
      if (opts.sidechainOnly && !isSidechain) continue;
      if (!opts.includeSidechain && isSidechain) continue;
      const rawUsage = entry.message?.usage;
      if (!rawUsage) continue;
      if (opts.since != null) {
        const ts = Date.parse(entry.timestamp);
        if (!(ts >= opts.since)) continue;
      }
      const eph5m = rawUsage.cache_creation?.ephemeral_5m_input_tokens;
      const eph1h = rawUsage.cache_creation?.ephemeral_1h_input_tokens;
      const hasTTLBreakdown = eph5m !== undefined || eph1h !== undefined;
      const write5m = hasTTLBreakdown ? Number(eph5m ?? 0) : Number(rawUsage.cache_creation_input_tokens ?? 0);
      const write1h = hasTTLBreakdown ? Number(eph1h ?? 0) : 0;
      const usage = {
        input: Number(rawUsage.input_tokens ?? 0),
        output: Number(rawUsage.output_tokens ?? 0),
        write: write5m + write1h,
        write5m,
        write1h,
        read: Number(rawUsage.cache_read_input_tokens ?? 0)
      };
      if (!(usage.input + usage.output + usage.write + usage.read)) continue;
      const rawKey = entry.requestId ?? entry.message?.id ?? entry.uuid;
      const key = rawKey == null ? null : `${isSidechain ? "side" : "main"}:${rawKey}`;
      const skill = entry.attributionSkill ?? (isSidechain ? SIDECHAIN_BASE : BASE);
      const rates = modelRates(entry.message?.model);
      if (key == null) {
        if (!bySkill.has(skill)) bySkill.set(skill, empty());
        accumulate(bySkill.get(skill), usage, rates, isSidechain);
        accumulate(total, usage, rates, isSidechain);
        if (skill === BASE) {
          if (!baseBySession.has(sessionKey)) baseBySession.set(sessionKey, empty());
          accumulate(baseBySession.get(sessionKey), usage, rates, false);
        }
      } else if (!pending.has(key)) {
        pending.set(key, { skill, usage, rates, isSidechain, sessionKey });
      } else {
        const prev = pending.get(key);
        const prevIsBase = prev.skill === BASE || prev.skill === SIDECHAIN_BASE;
        const skillIsReal = skill !== BASE && skill !== SIDECHAIN_BASE;
        if (prevIsBase && skillIsReal) prev.skill = skill;
      }
    }
  }
}

// Aggregate Agent results now that agentCalls has settled — every duplicate tool_use
// has been seen, so the lookup reflects the real attributionSkill when one exists.
for (const [resultKey, result] of pendingAgentResults) {
  const call = agentCalls.get(resultKey) ?? { skill: BASE, description: "(unknown Agent call)", subagentType: "unknown" };
  addAgentAgg(agentBySkill, call.skill, result);
  addAgentAgg(agentByDescription, `${call.skill} / ${call.subagentType}: ${call.description}`, result);
}

for (const { skill, usage, rates, isSidechain, sessionKey } of pending.values()) {
  if (!bySkill.has(skill)) bySkill.set(skill, empty());
  accumulate(bySkill.get(skill), usage, rates, isSidechain);
  accumulate(total, usage, rates, isSidechain);
  if (skill === BASE) {
    if (!baseBySession.has(sessionKey)) baseBySession.set(sessionKey, empty());
    accumulate(baseBySession.get(sessionKey), usage, rates, false);
  }
}

let rows = [...bySkill.entries()].map(([skill, a]) => ({ skill, ...a }));
if (opts.skill) rows = rows.filter((r) => r.skill.includes(opts.skill));
rows.sort((a, b) => b.cost - a.cost);

const displayTotal = opts.skill
  ? rows.reduce((acc, r) => {
      acc.input += r.input;
      acc.output += r.output;
      acc.write += r.write;
      acc.read += r.read;
      acc.cInput += r.cInput;
      acc.cOutput += r.cOutput;
      acc.cWrite += r.cWrite;
      acc.cRead += r.cRead;
      acc.cost += r.cost;
      acc.n += r.n;
      acc.sidechainN += r.sidechainN;
      acc.sidechainCost += r.sidechainCost;
      acc.sidechainRead += r.sidechainRead;
      return acc;
    }, empty())
  : total;

let agentRows = [...agentBySkill.values()];
let agentDescriptionRows = [...agentByDescription.values()];
if (opts.skill) {
  agentRows = agentRows.filter((r) => r.key.includes(opts.skill));
  agentDescriptionRows = agentDescriptionRows.filter((r) => r.key.includes(opts.skill));
}
agentRows.sort((a, b) => b.tokens - a.tokens);
agentDescriptionRows.sort((a, b) => b.tokens - a.tokens);
const baseSessionRows = [...baseBySession.entries()].map(([session, a]) => ({ session, ...a })).sort((a, b) => b.cost - a.cost);

const avgReadK = displayTotal.read / Math.max(1, displayTotal.n) / 1000;
const baseRow = rows.find((r) => r.skill === BASE);
const basePct = baseRow && displayTotal.cost ? (baseRow.cost / displayTotal.cost) * 100 : 0;
const thresholdFailures = [];
if (opts.maxAvgReadK != null && avgReadK > opts.maxAvgReadK) {
  thresholdFailures.push(`avg context re-read ${avgReadK.toFixed(0)}k > ${opts.maxAvgReadK}k`);
}
if (opts.maxBasePct != null && basePct > opts.maxBasePct) {
  thresholdFailures.push(`base-conversation cost ${basePct.toFixed(0)}% > ${opts.maxBasePct}%`);
}

if (opts.json) {
  if (
    !process.stdout.write(
      JSON.stringify(
        {
          total: displayTotal,
          sessions,
          scannedDirs,
          includeSidechain: opts.includeSidechain,
          sidechainOnly: opts.sidechainOnly,
          basePct,
          thresholdFailures,
          rows,
          baseSessions: baseSessionRows,
          agentRows,
          agentDescriptionRows
        },
        null,
        2
      ) + "\n"
    )
  ) {
    await new Promise((r) => process.stdout.once("drain", r));
  }
  process.exit(thresholdFailures.length ? 1 : 0);
}

const fmtT = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
const fmt$ = (n) => "$" + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
const tokTotal = (t) => t.input + t.output + t.write + t.read;
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(0) + "%" : "0%");

console.log(
  `scanned ${scannedDirs} project dir(s), ${sessions} sessions, ${total.n} unique responses` +
    (opts.since ? ` since ${new Date(opts.since).toISOString().slice(0, 10)}` : "") +
    (opts.sidechainOnly ? " (sidechain only)" : opts.includeSidechain ? " (sidechain included)" : " (sidechain excluded)")
);
console.log(`\nTOTAL est cost ${fmt$(displayTotal.cost)}  (FLOOR — 1M-context >200k premium not modeled)`);
console.log(
  `  tokens: read ${fmtT(displayTotal.read)} (${pct(displayTotal.read, tokTotal(displayTotal))}) · write ${fmtT(displayTotal.write)} · output ${fmtT(displayTotal.output)} · input ${fmtT(displayTotal.input)}`
);
console.log(
  `  cost by component: cache-read ${pct(displayTotal.cRead, displayTotal.cost)} · cache-write ${pct(displayTotal.cWrite, displayTotal.cost)} · output ${pct(displayTotal.cOutput, displayTotal.cost)} · input ${pct(displayTotal.cInput, displayTotal.cost)}`
);
console.log(`  avg context re-read per response: ${Math.round(avgReadK)}k tokens — the per-turn multiplier on every cost above`);
if (opts.guardrail) {
  console.log(`  guardrail: avg context re-read ≤ ${opts.maxAvgReadK}k · base conversation ≤ ${opts.maxBasePct}%`);
}
if (displayTotal.sidechainN) {
  console.log(
    `  sidechain: ${displayTotal.sidechainN} responses · ${fmt$(displayTotal.sidechainCost)} · ${fmtT(displayTotal.sidechainRead)} cache-read tokens`
  );
}
if (!opts.skill && basePct >= 50) {
  console.log(
    `  trim target: base conversation is ${basePct.toFixed(0)}% of displayed cost; use --base-sessions and threshold flags to automate split/trim alerts`
  );
} else if (avgReadK >= 80) {
  console.log(`  trim target: avg context re-read is high; trim always-loaded context or split long sessions`);
}

console.log(
  `\n${"skill".padEnd(40)}${"cost".padStart(9)}${"%".padStart(5)}${"output".padStart(9)}${"cwrite".padStart(9)}${"cread".padStart(9)}${"nResp".padStart(8)}${"side".padStart(7)}`
);
for (const r of rows.slice(0, opts.top)) {
  console.log(
    r.skill.slice(0, 39).padEnd(40) +
      fmt$(r.cost).padStart(9) +
      pct(r.cost, displayTotal.cost).padStart(5) +
      fmtT(r.output).padStart(9) +
      fmtT(r.write).padStart(9) +
      fmtT(r.read).padStart(9) +
      String(r.n).padStart(8) +
      String(r.sidechainN).padStart(7)
  );
}

if (!opts.skill && opts.baseSessions > 0 && baseSessionRows.length) {
  console.log(`\nbase conversation hotspots`);
  console.log(`${"session".padEnd(64)}${"cost".padStart(9)}${"avgRead".padStart(9)}${"nResp".padStart(8)}`);
  for (const r of baseSessionRows.slice(0, opts.baseSessions)) {
    console.log(
      r.session.slice(0, 63).padEnd(64) + fmt$(r.cost).padStart(9) + fmtT(r.read / Math.max(1, r.n)).padStart(9) + String(r.n).padStart(8)
    );
  }
}

if (opts.agentReport > 0 && agentRows.length) {
  console.log(`\nAgent-reported subagent usage (tokens only; not included in dollar totals)`);
  console.log(`${"parent skill".padEnd(40)}${"calls".padStart(7)}${"tokens".padStart(10)}${"tools".padStart(8)}${"avgSec".padStart(8)}`);
  for (const r of agentRows.slice(0, opts.agentReport)) {
    console.log(
      r.key.slice(0, 39).padEnd(40) +
        String(r.calls).padStart(7) +
        fmtT(r.tokens).padStart(10) +
        String(r.toolUses).padStart(8) +
        String(Math.round(r.durationMs / Math.max(1, r.calls) / 1000)).padStart(8)
    );
  }
}

if (thresholdFailures.length) {
  console.log(`\nthreshold failures: ${thresholdFailures.join("; ")}`);
  process.exitCode = 1;
}
