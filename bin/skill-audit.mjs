#!/usr/bin/env node

import { createReadStream, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

const USAGE = `Usage: skill-audit [options]
  --root <dir>      skill root to scan; repeat for multiple roots
  --repo <dir>      repository to inspect for callers and references (default: cwd)
  --days N          recent transcript and age window (default: 90)
  --no-transcripts  skip local Claude transcript evidence
  --candidates      show retirement candidates only
  --strict          exit nonzero for structurally broken or duplicate skills
  --json            emit machine-readable JSON

Retirement is always a review decision. This command never deletes skills.`;

const argv = process.argv.slice(2);
const options = { roots: [], repo: process.cwd(), days: 90, transcripts: true, candidates: false, strict: false, json: false };
for (let index = 0; index < argv.length; index++) {
  const argument = argv[index];
  if (argument === "--root") options.roots.push(argv[++index]);
  else if (argument === "--repo") options.repo = argv[++index];
  else if (argument === "--days") options.days = Number(argv[++index]);
  else if (argument === "--no-transcripts") options.transcripts = false;
  else if (argument === "--candidates") options.candidates = true;
  else if (argument === "--strict") options.strict = true;
  else if (argument === "--json") options.json = true;
  else if (argument === "--help" || argument === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else {
    console.error(`unknown option: ${argument}`);
    process.exit(2);
  }
}

if (!Number.isFinite(options.days) || options.days <= 0) {
  console.error("--days must be a positive number");
  process.exit(2);
}

function existingDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function defaultRoots() {
  const local = join(options.repo, "skills");
  if (existingDirectory(local)) return [local];
  const candidates = [join(process.env.CODEX_HOME || join(homedir(), ".codex"), "skills"), join(homedir(), ".claude", "skills")];
  return candidates.filter(existingDirectory);
}

const roots = [...new Set((options.roots.length ? options.roots : defaultRoots()).map((path) => realpathSync(path)))];
if (!roots.length) {
  console.error("no skill roots found; pass --root <dir>");
  process.exit(2);
}
const repoRoot = realpathSync(options.repo);

const ignoredDirectories = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".cache"]);

function walkFiles(root, predicate = () => true, followSymlinks = false) {
  const files = [];
  const pending = [root];
  const visitedDirectories = new Set();
  while (pending.length) {
    const directory = pending.pop();
    let realDirectory;
    try {
      realDirectory = realpathSync(directory);
    } catch {
      continue;
    }
    if (visitedDirectories.has(realDirectory)) continue;
    visitedDirectories.add(realDirectory);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) pending.push(path);
      } else if (entry.isFile() && predicate(path)) files.push(path);
      else if (followSymlinks && entry.isSymbolicLink()) {
        try {
          const target = statSync(path);
          if (target.isDirectory() && !ignoredDirectories.has(entry.name)) pending.push(path);
          else if (target.isFile() && predicate(path)) files.push(path);
        } catch {
          continue;
        }
      }
    }
  }
  return files;
}

function lastChangedAt(path) {
  const fallback = statSync(path).mtime;
  const repoRelative = relative(repoRoot, path);
  if (repoRelative.startsWith("..")) return fallback;
  try {
    const value = execFileSync("git", ["-C", repoRoot, "log", "-1", "--format=%cI", "--", repoRelative], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const changed = new Date(value);
    return value && !Number.isNaN(changed.valueOf()) ? changed : fallback;
  } catch {
    return fallback;
  }
}

function frontmatter(content) {
  const lines = content.split("\n");
  const values = {};
  if (lines[0]?.trim() !== "---") return values;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === "---") break;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (raw === ">" || raw === "|") {
      const parts = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) parts.push(lines[++index].trim());
      values[key] = parts.join(raw === ">" ? " " : "\n");
    } else values[key] = raw.replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  return values;
}

function hasClosedFrontmatter(content) {
  const lines = content.split("\n");
  return lines[0]?.trim() === "---" && lines.slice(1).some((line) => line.trim() === "---");
}

function referencedPaths(content, skillDirectory) {
  const broken = [];
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split(/[?#]/)[0];
    if (!target || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(target.replace(/^<|>$/g, ""));
    } catch {
      decoded = target.replace(/^<|>$/g, "");
    }
    if (!statExists(resolve(skillDirectory, decoded))) broken.push(decoded);
  }
  return [...new Set(broken)].sort();
}

function statExists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

const skills = [];
for (const root of roots) {
  for (const file of walkFiles(root, (path) => basename(path) === "SKILL.md", true)) {
    const directory = dirname(file);
    const content = readFileSync(file, "utf8");
    const metadata = frontmatter(content);
    const errors = [];
    const name = metadata.name || basename(directory);
    if (!hasClosedFrontmatter(content)) errors.push("missing or unterminated frontmatter");
    if (!metadata.name) errors.push("missing name");
    if (!metadata.description) errors.push("missing description");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) errors.push("invalid name");
    if (basename(directory) !== name) errors.push("folder/name mismatch");
    const brokenLinks = referencedPaths(content, directory);
    if (brokenLinks.length) errors.push(`${brokenLinks.length} broken relative link(s)`);
    const modified = lastChangedAt(file);
    skills.push({
      name,
      root,
      directory,
      file,
      description: metadata.description ?? "",
      modifiedAt: modified.toISOString(),
      ageDays: Math.floor((Date.now() - modified.valueOf()) / 86_400_000),
      brokenLinks,
      errors,
      recentSessions: 0,
      references: [],
      strongReferences: []
    });
  }
}

const byName = new Map();
for (const skill of skills) {
  if (!byName.has(skill.name)) byName.set(skill.name, []);
  byName.get(skill.name).push(skill);
}
for (const group of byName.values()) {
  if (group.length > 1) for (const skill of group) skill.errors.push(`duplicate name across ${group.length} roots`);
}

const referenceFiles = walkFiles(repoRoot, (path) => {
  try {
    if (statSync(path).size > 2_000_000) return false;
    return true;
  } catch {
    return false;
  }
});

for (const path of referenceFiles) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  if (content.includes("\0")) continue;
  const repoRelative = relative(options.repo, path);
  const strong = /(^|\/)(?:\.claude|\.codex|hooks?|scripts?|commands?)(\/|$)|(^|\/)(?:AGENTS|CLAUDE)\.md$|\/SKILL\.md$/.test(repoRelative);
  for (const skill of skills) {
    if (`${realpathSync(path)}/`.startsWith(`${realpathSync(skill.directory)}/`)) continue;
    const exactName = new RegExp(`(^|[^a-z0-9-])${skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9-]|$)`, "i");
    if (!exactName.test(content)) continue;
    skill.references.push(repoRelative);
    if (strong) skill.strongReferences.push(repoRelative);
  }
}

const since = Date.now() - options.days * 86_400_000;
const claudeProjects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
const transcriptFiles = options.transcripts && existingDirectory(claudeProjects)
  ? walkFiles(claudeProjects, (path) => {
      try {
        return path.endsWith(".jsonl") && statSync(path).mtimeMs >= since;
      } catch {
        return false;
      }
    }, true)
  : [];

async function skillsSeenInTranscript(path) {
  const seen = new Set();
  const stream = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of stream) {
      if (!line.includes("attributionSkill") && !line.includes('"name":"Skill"') && !line.includes('"name": "Skill"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.attributionSkill) seen.add(entry.attributionSkill);
      for (const part of Array.isArray(entry.message?.content) ? entry.message.content : []) {
        if (part?.type === "tool_use" && part.name === "Skill" && part.input?.skill) seen.add(part.input.skill);
      }
    }
  } catch {
    return seen;
  }
  return seen;
}

for (const path of transcriptFiles) {
  const seen = await skillsSeenInTranscript(path);
  for (const skill of skills) if (seen.has(skill.name)) skill.recentSessions++;
}

for (const skill of skills) {
  skill.references = [...new Set(skill.references)].sort();
  skill.strongReferences = [...new Set(skill.strongReferences)].sort();
  skill.status = skill.errors.length
    ? "broken"
    : skill.recentSessions > 0
      ? "used"
      : skill.strongReferences.length > 0
        ? "referenced"
        : skill.ageDays < options.days
          ? "new-unobserved"
          : "retire-candidate";
}

const counts = Object.fromEntries(
  ["used", "referenced", "new-unobserved", "retire-candidate", "broken"].map((status) => [status, skills.filter((skill) => skill.status === status).length])
);
const visibleSkills = options.candidates ? skills.filter((skill) => skill.status === "retire-candidate") : skills;
const report = {
  roots,
  repo: repoRoot,
  days: options.days,
  transcriptEvidence: options.transcripts,
  transcriptFiles: transcriptFiles.length,
  counts,
  skills: visibleSkills
};

if (options.json) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  console.log(
    `scanned ${skills.length} skills across ${roots.length} root(s) · ${options.transcripts ? `${transcriptFiles.length} recent transcript(s)` : "transcript evidence skipped"}`
  );
  console.log(`used ${counts.used} · referenced ${counts.referenced} · new/unobserved ${counts["new-unobserved"]} · retire candidates ${counts["retire-candidate"]} · broken ${counts.broken}`);
  console.log(`\n${"status".padEnd(18)}${"skill".padEnd(34)}${"sessions".padStart(9)}${"callers".padStart(9)}${"age".padStart(7)}`);
  for (const skill of visibleSkills.sort((left, right) => left.status.localeCompare(right.status) || left.name.localeCompare(right.name))) {
    console.log(`${skill.status.padEnd(18)}${skill.name.slice(0, 33).padEnd(34)}${String(skill.recentSessions).padStart(9)}${String(skill.strongReferences.length).padStart(9)}${`${skill.ageDays}d`.padStart(7)}`);
    for (const error of skill.errors) console.log(`  ! ${error}`);
  }
  if (counts["retire-candidate"] > 0 && !options.candidates) console.log("\nRetirement candidates are evidence for review, not proof of disuse. Run with --candidates --json before removing anything.");
}

if (options.strict && skills.some((skill) => skill.errors.length)) process.exitCode = 1;
