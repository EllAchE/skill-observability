import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const binDirectory = join(repositoryRoot, "bin");

function runNode(script, args, options = {}) {
  const result = spawnSync(process.execPath, [join(binDirectory, script), ...args], {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env }
  });
  assert.equal(result.status, options.expectedStatus ?? 0, result.stderr || result.stdout);
  return result;
}

function writeJsonl(path, entries) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

function attributedTranscript(start = "2026-08-12T12:00:00.000Z") {
  const at = (offsetSeconds) => new Date(Date.parse(start) + offsetSeconds * 1000).toISOString();
  return [
    {
      type: "user",
      timestamp: at(0),
      message: { content: "Audit this skill" }
    },
    {
      type: "assistant",
      timestamp: at(1),
      requestId: "skill-start",
      message: {
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 2, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 },
        content: [{ type: "tool_use", id: "skill-call", name: "Skill", input: { skill: "example-skill" } }]
      }
    },
    {
      type: "user",
      timestamp: at(2),
      message: { content: [{ type: "tool_result", tool_use_id: "skill-call", content: "loaded" }] }
    },
    {
      type: "assistant",
      timestamp: at(3),
      requestId: "tool-start",
      attributionSkill: "example-skill",
      message: {
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 5, cache_read_input_tokens: 20 },
        content: [{ type: "tool_use", id: "bash-call", name: "Bash", input: { description: "Run the check" } }]
      }
    },
    {
      type: "user",
      timestamp: at(6),
      message: { content: [{ type: "tool_result", tool_use_id: "bash-call", content: "ok" }] }
    },
    {
      type: "assistant",
      timestamp: at(7),
      requestId: "skill-finish",
      attributionSkill: "example-skill",
      message: {
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 4, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 30 },
        content: [{ type: "text", text: "Done" }]
      }
    }
  ];
}

test("skill-perf reconstructs timing and attributed tokens", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-perf-test-"));
  const transcript = join(root, "session.jsonl");
  writeJsonl(transcript, attributedTranscript());

  const result = runNode("skill-perf.mjs", [transcript, "--json"]);
  const report = JSON.parse(result.stdout);

  assert.equal(report.length, 1);
  assert.equal(report[0].skill, "example-skill");
  assert.equal(report[0].wallMs, 6000);
  assert.equal(report[0].toolBusyMs, 3000);
  assert.equal(report[0].modelMs, 3000);
  assert.deepEqual(report[0].tokenUsage, {
    inputTokens: 7,
    outputTokens: 3,
    cacheCreationInputTokens: 5,
    cacheReadInputTokens: 50
  });
});

test("skill-cost deduplicates and upgrades attributed responses", () => {
  const project = mkdtempSync(join(tmpdir(), "skill-cost-test-"));
  const entries = attributedTranscript();
  entries.splice(5, 0, {
    ...entries[5],
    attributionSkill: undefined
  });
  writeJsonl(join(project, "session.jsonl"), entries);

  const result = runNode("usage-cost.mjs", ["--project", project, "--json", "--base-sessions", "0", "--agent-report", "0"]);
  const report = JSON.parse(result.stdout);
  const skill = report.rows.find((row) => row.skill === "example-skill");

  assert.equal(report.total.n, 3);
  assert.equal(skill.n, 2);
  assert.equal(skill.read, 50);
  assert.equal(skill.output, 3);
});

test("agent-usage reports Claude usage by source and model", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-usage-test-"));
  const claudeConfig = join(root, "claude");
  const codexHome = join(root, "codex");
  const now = new Date().toISOString();
  writeJsonl(join(claudeConfig, "projects", "-example-project", "session.jsonl"), [
    {
      type: "assistant",
      timestamp: now,
      requestId: "usage-1",
      message: {
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 20 }
      }
    }
  ]);

  const result = runNode("source-usage.mjs", ["--source", "claude", "--json"], {
    env: { CLAUDE_CONFIG_DIR: claudeConfig, CODEX_HOME: codexHome }
  });
  const report = JSON.parse(result.stdout);

  assert.equal(report.bySource[0].key, "claude");
  assert.equal(report.bySource[0].total, 30);
  assert.equal(report.byModel[0].key, "claude: claude-sonnet-4-6");
});

test(
  "sample hook writes a fresh per-skill report",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "sample-hook-test-"));
    const project = join(root, "project");
    const claudeConfig = join(root, "claude");
    const output = join(root, "reports");
    mkdirSync(project, { recursive: true });
    const projectSlug = realpathSync(project).replace(/[/.]/g, "-");
    writeJsonl(join(claudeConfig, "projects", projectSlug, "session.jsonl"), attributedTranscript());

    const result = spawnSync("bash", [join(binDirectory, "sample-audit-hook.sh")], {
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: claudeConfig,
        SKILL_PERF_DIR: output,
        SKILL_PERF_SAMPLE_RATE: "1"
      }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(readdirSync(output).some((name) => name.endsWith("s-example-skill.txt")));
  }
);

test(
  "memory-prune is dry-run by default and deletes only with an explicit flag",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "memory-prune-test-"));
    const index = join(root, "MEMORY.md");
    const expired = join(root, "expired.md");
    writeFileSync(index, "# Memory\n\n- [Expired](expired.md) — stale\n");
    writeFileSync(expired, "---\nexpires_at: 2026-01-01\n---\nExpired\n");
    const script = join(repositoryRoot, "skills", "prune-memory", "scripts", "prune-expired-memories.sh");
    const environment = { ...process.env, MEMORY_PRUNE_TODAY: "2026-08-12" };

    const dryRun = spawnSync("bash", [script, root], { encoding: "utf8", env: environment });
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    assert.ok(existsSync(expired));
    assert.match(dryRun.stdout, /mode=dry-run/);

    const deletion = spawnSync("bash", [script, "--delete", root], { encoding: "utf8", env: environment });
    assert.equal(deletion.status, 0, deletion.stderr || deletion.stdout);
    assert.equal(existsSync(expired), false);
    assert.doesNotMatch(readFileSync(index, "utf8"), /expired\.md/);
  }
);
