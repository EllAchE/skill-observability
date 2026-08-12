#!/usr/bin/env node

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const USAGE = `Usage: memory-audit [memory-dir] [options]
  --project <dir>  derive the Claude memory store from this project (default: cwd)
  --today <date>   compare expiry against YYYY-MM-DD (default: today)
  --strict         exit nonzero for expired, invalid, missing, dangling, or orphaned entries
  --json           emit machine-readable JSON`;

const argv = process.argv.slice(2);
const options = { memoryDir: null, project: process.cwd(), today: new Date().toISOString().slice(0, 10), strict: false, json: false };

for (let index = 0; index < argv.length; index++) {
  const argument = argv[index];
  if (argument === "--project") options.project = argv[++index];
  else if (argument === "--today") options.today = argv[++index];
  else if (argument === "--strict") options.strict = true;
  else if (argument === "--json") options.json = true;
  else if (argument === "--help" || argument === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else if (argument.startsWith("-")) {
    console.error(`unknown option: ${argument}`);
    process.exit(2);
  } else if (options.memoryDir == null) options.memoryDir = argument;
  else {
    console.error(`unexpected argument: ${argument}`);
    process.exit(2);
  }
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

if (!validDate(options.today)) {
  console.error("--today must be a valid YYYY-MM-DD date");
  process.exit(2);
}

function defaultMemoryDir() {
  const configRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  let project = options.project;
  try {
    project = realpathSync(project);
  } catch {
    // The derived path remains useful when auditing a project that no longer exists.
  }
  return join(configRoot, "projects", project.replace(/[/.]/g, "-"), "memory");
}

const memoryDir = options.memoryDir ?? defaultMemoryDir();
const indexPath = join(memoryDir, "MEMORY.md");
let indexContent;
try {
  indexContent = readFileSync(indexPath, "utf8");
} catch {
  console.error(`no memory store at ${memoryDir}`);
  process.exit(2);
}

function expiryFromFrontmatter(content) {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === "---") break;
    const match = line.match(/^\s*(?:expires_at|expiresAt):\s*["']?([^"'\s#]+)["']?/);
    if (match) return match[1];
  }
  return null;
}

const linkedFiles = new Set();
for (const match of indexContent.matchAll(/\[[^\]]+\]\(([^)#?]+\.md)(?:[?#][^)]*)?\)/g)) {
  try {
    linkedFiles.add(decodeURIComponent(match[1]));
  } catch {
    linkedFiles.add(match[1]);
  }
}

const memoryFiles = readdirSync(memoryDir)
  .filter((name) => name.endsWith(".md") && name !== "MEMORY.md")
  .sort();
const memoryFileSet = new Set(memoryFiles);
const expired = [];
const invalid = [];
const missing = [];
const permanent = [];

for (const name of memoryFiles) {
  const expiry = expiryFromFrontmatter(readFileSync(join(memoryDir, name), "utf8"));
  if (expiry == null) missing.push(name);
  else if (!validDate(expiry)) invalid.push({ file: name, expiresAt: expiry });
  else if (expiry === "9999-12-31") permanent.push(name);
  else if (expiry <= options.today) expired.push({ file: name, expiresAt: expiry });
}

const dangling = [...linkedFiles].filter((name) => !memoryFileSet.has(name)).sort();
const orphaned = memoryFiles.filter((name) => !linkedFiles.has(name));
const report = {
  memoryDir,
  index: {
    bytes: Buffer.byteLength(indexContent),
    entries: [...indexContent.matchAll(/^- \[/gm)].length,
    linkedFiles: linkedFiles.size
  },
  files: memoryFiles.length,
  expired,
  invalid,
  missing,
  permanent,
  dangling,
  orphaned
};
const debt = expired.length + invalid.length + missing.length + dangling.length + orphaned.length;

if (options.json) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  console.log(`${memoryDir}`);
  console.log(`${report.index.entries} index entries · ${report.index.bytes} bytes · ${memoryFiles.length} memory files`);
  const sections = [
    ["expired", expired.map(({ file, expiresAt }) => `${file} (${expiresAt})`)],
    ["invalid expiry", invalid.map(({ file, expiresAt }) => `${file} (${expiresAt})`)],
    ["missing expiry", missing],
    ["dangling index links", dangling],
    ["orphaned files", orphaned],
    ["never expires", permanent]
  ];
  for (const [label, items] of sections) {
    if (!items.length) continue;
    console.log(`\n${label} (${items.length})`);
    for (const item of items) console.log(`  ${item}`);
  }
  console.log(`\nsummary: debt=${debt} expired=${expired.length} invalid=${invalid.length} missing=${missing.length} dangling=${dangling.length} orphaned=${orphaned.length}`);
}

if (options.strict && debt > 0) process.exitCode = 1;
