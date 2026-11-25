#!/usr/bin/env bash
# ci/changed-examples.sh: which examples a change needs run (ADR-0018; ci/README.md, "What runs when").
#
#   git diff --name-only --no-renames BASE HEAD | ci/changed-examples.sh   the examples whose inputs changed
#   ci/changed-examples.sh --all                                           every example
#
# Reads changed paths on stdin, one per line (--no-renames, so a moved file counts at both ends), and
# prints the directory name of each example to run, one per line, sorted. Nothing printed: none.
#
#   examples/<name>/...        that example (any file of it: its README ships in its site)
#   docs/, lib/tests/, site/ other than site/build.mjs, ci/README.md, the root's *.md, .gitignore,
#   LICENSE*, .github/workflows/pages.yml
#                              no example: nothing a run.sh reads (pytest covers lib/tests and site/)
#   anything else              every example: lib/, scripts/, the pins in ci/, pyproject.toml, uv.lock,
#                              the examples workflow, this script, site/build.mjs (example 01's build
#                              imports it), and any path this list does not know
#
# The last rule is the safe side: a new kind of file runs everything until someone decides otherwise.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

all() {
  for r in "$root"/examples/*/run.sh; do
    if [[ -f "$r" ]]; then basename "$(dirname "$r")"; fi
  done | sort
}

if [[ "${1:-}" == --all ]]; then all; exit 0; fi
if (( $# > 0 )); then echo "usage: changed-examples.sh [--all] < changed paths" >&2; exit 2; fi

picked=""
while IFS= read -r path || [[ -n "$path" ]]; do
  case "$path" in
    "") ;;
    examples/*/*)
      name="${path#examples/}"; name="${name%%/*}"
      # an example that was removed has nothing to run
      if [[ -f "$root/examples/$name/run.sh" ]]; then picked+="$name"$'\n'; fi ;;
    site/build.mjs) all; exit 0 ;;
    docs/*|lib/tests/*|site/*|ci/README.md|.gitignore|LICENSE*|.github/workflows/pages.yml) ;;
    *.md) if [[ "$path" == */* ]]; then all; exit 0; fi ;;
    *) all; exit 0 ;;
  esac
done
printf '%s' "$picked" | sort -u
