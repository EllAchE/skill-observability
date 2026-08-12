#!/usr/bin/env bash
# SessionEnd-hook sampler: always runs first time (no reports yet), then
# 1-in-N roll (default 20) keeps fresh per-skill audit reports without paying
# the analyzer cost on every session.
set -u

rate="${SKILL_PERF_SAMPLE_RATE:-20}"
case "$rate" in
  "" | *[!0-9]* | 0)
    echo "SKILL_PERF_SAMPLE_RATE must be a positive integer" >&2
    exit 2
    ;;
esac
# WHY the slash strip: a trailing slash would put the staging dir *inside*
# out_dir, so the swap's rm -rf would delete the just-written reports.
out_dir="${SKILL_PERF_DIR:-/tmp/claude/skill-perf}"; out_dir="${out_dir%/}"
# WHY: always run if the audit dir was never initialized; after that, even an
# empty successful audit returns to probabilistic sampling.
[ -n "$(ls -A "$out_dir" 2>/dev/null)" ] && [ "$((RANDOM % rate))" -ne 0 ] && exit 0

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Stage a sibling dir and swap only on a successful, non-empty run — a failed
# or invocation-less session must not clobber the last good reports.
tmp="${out_dir}.tmp.$$"
if node "$dir/skill-perf.mjs" --latest 10 --min-ms 1000 --out-dir "$tmp" >/dev/null 2>&1; then
  if [ -n "$(ls -A "$tmp" 2>/dev/null)" ]; then
    rm -rf "$out_dir" && mv "$tmp" "$out_dir"
  else
    mkdir -p "$out_dir" && : > "$out_dir/.last-empty-run"
    rm -rf "$tmp"
  fi
else
  rm -rf "$tmp"
fi
exit 0
