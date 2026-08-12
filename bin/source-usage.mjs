#!/usr/bin/env node
// Explain recent local model-token usage by source (Claude Code + Codex CLI),
// model, project, and session, and report the authoritative Codex plan windows.
//
// Plan windows come from the `rate_limits` snapshot the Codex CLI records with
// every `token_count` event in its session rollouts — the backend-reported
// percent-used per window. That snapshot is authoritative for "how much plan is
// left": plan metering happens server-side, so local token sums can only explain
// WHERE usage went, never what it counts against. This report therefore pairs
// the latest snapshot with token-count breakdowns and leaves dollar-weighting to
// usage-cost.mjs (Codex subscription plans meter percent-of-window, not USD).
//
// Run with --help for usage.

import { createReadStream, readFileSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const USAGE = `Usage: agent-usage [options]
  --days N           window size in days ending now (default: 7)
  --since <ISO>      explicit window start (overrides --days)
  --source <name>    only one source: claude | codex
  --top N            rows per project/session table (default: 10)
  --json             emit raw JSON instead of the tables
Token counts only; the dollar-weighted Claude cost audit is usage-cost.mjs.`;

const argv = process.argv.slice(2);
const opts = { days: 7, since: null, source: null, top: 10, json: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--days") {
    opts.days = Number(argv[++i]);
    if (Number.isNaN(opts.days) || opts.days <= 0) {
      console.error("--days: invalid number");
      process.exit(2);
    }
  } else if (a === "--since") {
    opts.since = Date.parse(argv[++i]);
    if (Number.isNaN(opts.since)) {
      console.error("--since: invalid date");
      process.exit(2);
    }
  } else if (a === "--source") {
    opts.source = argv[++i];
    if (opts.source !== "claude" && opts.source !== "codex") {
      console.error("--source: must be claude or codex");
      process.exit(2);
    }
  } else if (a === "--top") {
    opts.top = Number(argv[++i]);
    if (Number.isNaN(opts.top) || opts.top < 0) {
      console.error("--top: invalid number");
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
const sinceMs = opts.since ?? Date.now() - opts.days * 86_400_000;

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

const listDir = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

// Claude transcript dirs are named by munging the cwd; applying the same munge
// to the Codex cwd gives one checkout a single project label across sources.
const mungePath = (p) => p.replace(/[/.]/g, "-");

const dims = { source: new Map(), model: new Map(), project: new Map(), session: new Map() };
const empty = () => ({ fresh: 0, cached: 0, write: 0, output: 0, total: 0, n: 0 });

function add(source, model, project, session, u) {
  const total = u.fresh + u.cached + u.write + u.output;
  if (!total) return;
  const bump = (map, key) => {
    if (!map.has(key)) map.set(key, empty());
    const agg = map.get(key);
    agg.fresh += u.fresh;
    agg.cached += u.cached;
    agg.write += u.write;
    agg.output += u.output;
    agg.total += total;
    agg.n++;
  };
  bump(dims.source, source);
  bump(dims.model, `${source}: ${model}`);
  bump(dims.project, `${source}: ${project}`);
  bump(dims.session, `${source}: ${session}`);
}

// ---- Codex: sessions/YYYY/MM/DD/rollout-*.jsonl -------------------------------

// Rollouts are filed by session START date but long-lived sessions keep growing
// for days, so windowing must use mtime — a start-date cut silently drops the
// newest events (and the freshest rate-limit snapshot) of an old session.
function codexRollouts() {
  const root = join(codexHome, "sessions");
  const files = [];
  for (const y of listDir(root))
    for (const m of listDir(join(root, y)))
      for (const d of listDir(join(root, y, m)))
        for (const f of listDir(join(root, y, m, d))) {
          if (!f.endsWith(".jsonl")) continue;
          const path = join(root, y, m, d, f);
          try {
            files.push({ path, mtimeMs: statSync(path).mtimeMs });
          } catch {
            /* raced away */
          }
        }
  return files;
}

// Rollouts can reach multiple gigabytes, so a whole-file read can hit JSC/V8
// string caps. Substring triage also avoids parsing irrelevant lines.
async function* jsonlEntries(path, needles) {
  let rl;
  try {
    rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  } catch {
    return;
  }
  try {
    for await (const line of rl) {
      if (!needles.some((n) => line.includes(n))) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      yield entry;
    }
  } catch {
    /* stream error — keep what we have */
  }
}

// Codex reports several limit streams (e.g. "codex", "premium"); some snapshots
// are window-less placeholders, so keep the latest per stream and report only
// streams that carry actual windows.
const latestRateLimitsByStream = new Map(); // limit_id → { ts, rl }
const hasWindows = (rl) => rl.primary != null || rl.secondary != null;
function noteRateLimits(ts, rl) {
  const id = rl.limit_id ?? "(default)";
  const prev = latestRateLimitsByStream.get(id);
  if (!prev || ts > prev.ts) latestRateLimitsByStream.set(id, { ts, rl });
}

async function scanCodexFile(path) {
  let cwd = null;
  let model = "(unknown model)";
  const seenSnapshots = new Set();
  const session = basename(path, ".jsonl").replace(/^rollout-/, "");
  for await (const entry of jsonlEntries(path, ['"session_meta"', '"turn_context"', '"token_count"'])) {
    if (entry.type === "session_meta") {
      cwd = entry.payload?.cwd ?? cwd;
    } else if (entry.type === "turn_context") {
      model = entry.payload?.model ?? model;
      cwd = entry.payload?.cwd ?? cwd;
    } else if (entry.type === "event_msg" && entry.payload?.type === "token_count") {
      const ts = Date.parse(entry.timestamp);
      const rl = entry.payload.rate_limits;
      if (rl) noteRateLimits(ts, rl);
      const totals = entry.payload.info?.total_token_usage;
      const last = entry.payload.info?.last_token_usage;
      if (!last || !(ts >= sinceMs)) continue;
      // Per-response accounting must sum last_token_usage, not cumulative
      // deltas: parallel turn streams interleave their own cumulative counters
      // in one rollout, so deltas over the merged sequence are garbage. Resumes
      // re-emit an event with an identical cumulative snapshot, which is the
      // one way last_token_usage double-counts — dedupe on the snapshot.
      const key = `${totals?.total_tokens}|${totals?.input_tokens}|${totals?.cached_input_tokens}|${totals?.output_tokens}|${last.total_tokens}`;
      if (seenSnapshots.has(key)) continue;
      seenSnapshots.add(key);
      const cached = Number(last.cached_input_tokens ?? 0);
      add("codex", model, mungePath(cwd ?? "(unknown project)"), session, {
        fresh: Math.max(0, Number(last.input_tokens ?? 0) - cached),
        cached,
        write: Number(last.cache_write_input_tokens ?? 0),
        output: Number(last.output_tokens ?? 0)
      });
    }
  }
}

async function findOlderWindowedRateLimits(olderFiles) {
  for (const { path } of olderFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    let found = null;
    for await (const entry of jsonlEntries(path, ['"rate_limits"'])) {
      const rl = entry.payload?.rate_limits;
      if (rl && hasWindows(rl)) found = { ts: Date.parse(entry.timestamp), rl };
    }
    if (found) {
      noteRateLimits(found.ts, found.rl);
      return;
    }
  }
}

// ---- Claude: projects/<munged-cwd>/<session>.jsonl ----------------------------

const seenClaudeResponses = new Set();

function scanClaudeFile(path, project, session) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "assistant") continue;
    const rawUsage = entry.message?.usage;
    if (!rawUsage) continue;
    if (!(Date.parse(entry.timestamp) >= sinceMs)) continue;
    const key = entry.requestId ?? entry.message?.id ?? entry.uuid;
    if (key != null) {
      const dedupeKey = `${entry.isSidechain === true ? "side" : "main"}:${key}`;
      if (seenClaudeResponses.has(dedupeKey)) continue;
      seenClaudeResponses.add(dedupeKey);
    }
    const eph5m = rawUsage.cache_creation?.ephemeral_5m_input_tokens;
    const eph1h = rawUsage.cache_creation?.ephemeral_1h_input_tokens;
    const write =
      eph5m !== undefined || eph1h !== undefined
        ? Number(eph5m ?? 0) + Number(eph1h ?? 0)
        : Number(rawUsage.cache_creation_input_tokens ?? 0);
    add("claude", entry.message?.model ?? "(unknown model)", project, session, {
      fresh: Number(rawUsage.input_tokens ?? 0),
      cached: Number(rawUsage.cache_read_input_tokens ?? 0),
      write,
      output: Number(rawUsage.output_tokens ?? 0)
    });
  }
}

// ---- Scan --------------------------------------------------------------------

if (opts.source !== "claude") {
  const rollouts = codexRollouts();
  for (const { path, mtimeMs } of rollouts) if (mtimeMs >= sinceMs) await scanCodexFile(path);
  if (![...latestRateLimitsByStream.values()].some(({ rl }) => hasWindows(rl))) {
    await findOlderWindowedRateLimits(rollouts.filter((f) => f.mtimeMs < sinceMs));
  }
}

if (opts.source !== "codex") {
  const root = join(claudeConfigDir, "projects");
  for (const projDir of listDir(root)) {
    const dir = join(root, projDir);
    for (const f of listDir(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(dir, f);
      try {
        if (statSync(path).mtimeMs < sinceMs) continue; // no writes since window start ⇒ no events in window
      } catch {
        continue;
      }
      scanClaudeFile(path, projDir, `${projDir}/${basename(f, ".jsonl")}`);
    }
  }
}

// ---- Report ------------------------------------------------------------------

const rowsOf = (map) => [...map.entries()].map(([key, a]) => ({ key, ...a })).sort((a, b) => b.total - a.total);
const sessionCountBySource = new Map();
for (const key of dims.session.keys()) {
  const source = key.slice(0, key.indexOf(":"));
  sessionCountBySource.set(source, (sessionCountBySource.get(source) ?? 0) + 1);
}
const sourceRows = rowsOf(dims.source);
const modelRows = rowsOf(dims.model);
const projectRows = rowsOf(dims.project);
const sessionRows = rowsOf(dims.session);

function windowLabel(mins) {
  if (mins == null) return "window";
  if (mins % 10_080 === 0) return mins === 10_080 ? "weekly" : `${mins / 10_080}-week`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

function describeWindow(name, w, snapshotTs) {
  if (!w) return null;
  const resetMs = w.resets_at != null ? w.resets_at * 1000 : w.resets_in_seconds != null ? snapshotTs + w.resets_in_seconds * 1000 : null;
  return {
    name,
    label: windowLabel(w.window_minutes),
    usedPercent: w.used_percent,
    resetsAt: resetMs == null ? null : new Date(resetMs).toISOString()
  };
}

const planWindows = [...latestRateLimitsByStream.entries()]
  .filter(([, { rl }]) => hasWindows(rl))
  .map(([limitId, { ts, rl }]) => ({
    limitId,
    planType: rl.plan_type ?? null,
    snapshotAt: new Date(ts).toISOString(),
    snapshotAgeHours: Math.round((Date.now() - ts) / 3_600_000),
    windows: [describeWindow("primary", rl.primary, ts), describeWindow("secondary", rl.secondary, ts)].filter(Boolean),
    credits: rl.credits?.has_credits ? rl.credits : null
  }));

if (opts.json) {
  // process.exit before stdout drains truncates piped output; await the drain.
  const flushed = process.stdout.write(
    JSON.stringify(
      {
        since: new Date(sinceMs).toISOString(),
        planWindows,
        rawRateLimits: Object.fromEntries([...latestRateLimitsByStream].map(([id, { rl }]) => [id, rl])),
        sessionsBySource: Object.fromEntries(sessionCountBySource),
        bySource: sourceRows,
        byModel: modelRows,
        byProject: projectRows,
        bySession: sessionRows
      },
      null,
      2
    ) + "\n"
  );
  if (!flushed) await new Promise((r) => process.stdout.once("drain", r));
  process.exit(0);
}

const fmtT = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);

if (opts.source !== "claude") {
  if (planWindows.length) {
    console.log("Codex plan windows (authoritative — backend-reported)");
    for (const pw of planWindows) {
      console.log(
        `  ${pw.limitId}${pw.planType ? ` (plan ${pw.planType})` : ""} — snapshot ${pw.snapshotAt.slice(0, 16)}Z` +
          (pw.snapshotAgeHours > 24 ? ` · ${Math.round(pw.snapshotAgeHours / 24)}d old; run a Codex turn to refresh` : "")
      );
      for (const w of pw.windows) {
        console.log(`    ${w.name} (${w.label}): ${w.usedPercent}% used` + (w.resetsAt ? ` · resets ${w.resetsAt.slice(0, 16)}Z` : ""));
      }
      if (pw.credits) console.log(`    credits: balance ${pw.credits.balance}`);
    }
  } else {
    console.log("Codex plan windows: no rate-limit snapshot found under " + join(codexHome, "sessions"));
  }
  console.log();
}

const sessionCounts = [...sessionCountBySource].map(([s, n]) => `${n} ${s}`).join(" · ");
console.log(`local usage since ${new Date(sinceMs).toISOString().slice(0, 16)}Z (${sessionCounts || "no sessions"})`);

function printTable(title, rows, width, limit = Infinity) {
  if (!rows.length) return;
  console.log(`\n${title}`);
  console.log(
    `${"".padEnd(width)}${"total".padStart(9)}${"fresh".padStart(9)}${"cached".padStart(9)}${"write".padStart(9)}${"output".padStart(9)}${"nResp".padStart(8)}`
  );
  for (const r of rows.slice(0, limit)) {
    console.log(
      r.key.slice(0, width - 1).padEnd(width) +
        fmtT(r.total).padStart(9) +
        fmtT(r.fresh).padStart(9) +
        fmtT(r.cached).padStart(9) +
        fmtT(r.write).padStart(9) +
        fmtT(r.output).padStart(9) +
        String(r.n).padStart(8)
    );
  }
}

printTable("by source", sourceRows, 24);
printTable("by model", modelRows, 40);
printTable("top projects", projectRows, 56, opts.top);
printTable("top sessions", sessionRows, 72, opts.top);
