#!/usr/bin/env bash
set -euo pipefail

delete=0
memory_dir=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --delete) delete=1 ;;
    --dry-run) delete=0 ;;
    -h|--help)
      echo "usage: memory-prune [--dry-run|--delete] [memory-dir]"
      echo "default: dry-run"
      exit 0
      ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *)
      [ -z "$memory_dir" ] || { echo "unexpected argument: $1" >&2; exit 2; }
      memory_dir="$1"
      ;;
  esac
  shift
done

if [ -z "$memory_dir" ]; then
  project_path="$(pwd -P)"
  memory_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/${project_path//\//-}/memory"
fi
index="$memory_dir/MEMORY.md"
today="${MEMORY_PRUNE_TODAY:-$(date +%Y-%m-%d)}"

[ "$memory_dir" != "/" ] || { echo "refusing to use / as the memory directory" >&2; exit 2; }
if [ ! -f "$index" ]; then
  echo "no memory store at $memory_dir"
  exit 0
fi

expired=()
invalid=()
missing=()

for file in "$memory_dir"/*.md; do
  [ -e "$file" ] || continue
  [ "$(basename "$file")" != "MEMORY.md" ] || continue

  expires_at="$(
    awk '
      NR == 1 && $0 == "---" { frontmatter = 1; next }
      frontmatter && $0 == "---" { exit }
      frontmatter && $0 ~ /^[[:space:]]*(expires_at|expiresAt):[[:space:]]*/ {
        line = $0
        sub(/^[[:space:]]*(expires_at|expiresAt):[[:space:]]*/, "", line)
        gsub(/["'\'' ]/, "", line)
        print line
        exit
      }
    ' "$file"
  )"

  if [ -z "$expires_at" ]; then
    missing+=("$(basename "$file")")
  elif [[ ! "$expires_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    invalid+=("$(basename "$file"):$expires_at")
  elif [[ "$expires_at" < "$today" || "$expires_at" = "$today" ]]; then
    expired+=("$file")
  fi
done

if [ "${#expired[@]}" -gt 0 ] && [ "$delete" -eq 1 ]; then
  temporary_index="$(mktemp "$memory_dir/MEMORY.md.XXXXXX")"
  expired_names="$(for file in "${expired[@]}"; do basename "$file"; done | tr '\n' '|')"
  awk -v files="$expired_names" '
    BEGIN {
      split(files, names, "|")
      for (i in names) if (names[i] != "") expired[names[i]] = 1
    }
    {
      keep = 1
      for (name in expired) if (index($0, "(" name ")") > 0) keep = 0
      if (keep) print
    }
  ' "$index" > "$temporary_index"
  mv "$temporary_index" "$index"
  for file in "${expired[@]}"; do rm -- "$file"; done
fi

if [ "${#expired[@]}" -gt 0 ]; then
  if [ "$delete" -eq 1 ]; then action="deleted"; else action="found"; fi
  printf 'expired memories %s:\n' "$action"
  printf '  %s\n' "${expired[@]##*/}"
fi
if [ "${#invalid[@]}" -gt 0 ]; then
  printf 'invalid expiry metadata, kept for audit:\n'
  printf '  %s\n' "${invalid[@]}"
fi
if [ "${#missing[@]}" -gt 0 ]; then
  printf 'missing expiry metadata, backfill required:\n'
  printf '  %s\n' "${missing[@]}"
fi

echo "summary: mode=$([ "$delete" -eq 1 ] && printf delete || printf dry-run) expired=${#expired[@]} invalid=${#invalid[@]} missing=${#missing[@]}"
