#!/usr/bin/env bash
# The Relate playground as an agent's memory: a scripted chat, Relate 1.2.0 WASM, and the graph it fills (NVL).
#   ./run.sh               offline: the Node sections, then browser, then native; checked against expected/
#   ./run.sh --update      rewrite expected/ from this run
#   ./run.sh --site        build dist/ and serve it at /relate-examples/03-wasm-agent-memory/ as GitHub Pages would
#
# Setup (README.md): here `npm ci --omit=peer` (exact pins, @relate/relate-wasm 1.2.0 among them; --omit=peer
# skips NVL's unused neo4j-driver peer) and `npx playwright install chromium`.
# The native section runs on the repository's engine: the project env's binding (uv run python: relate-db),
# 1.2.0 like the WASM bundle; another version fails the run.
# EXAMPLES_REQUIRE keys: without `wasm` (Node >= 20, the pinned Relate bundle and npm packages) the whole
# example prints SKIP and exits 0; without `browser` (Playwright's Chromium) only that section is skipped,
# with a note on stderr. A key named in EXAMPLES_REQUIRE fails instead (CI names both).
set -euo pipefail
cd "$(dirname "$0")"
source ../../scripts/env.sh   # loads <repo>/.env; RELATE_TELEMETRY=off, RELATE_MAX_ROWS=0, RELATE_AGENT_MODE=0
root="$(cd ../.. && pwd)"
ver=1.2.0                     # Relate: the WASM bundle (package.json), and the release the native section checks the project engine is
py() { uv run --project "$root" --quiet python "$@"; }   # the project env: relate-db, the repository's binding

update=0 mode=run
while (( $# )); do
  case "$1" in
    --update) update=1 ;;
    --site) mode=site ;;
    -h|--help) sed -n '2,5p' run.sh | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "run.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

required() { [[ ",${EXAMPLES_REQUIRE:-}," == *",$1,"* ]]; }

skip() {  # <key> <reason> <fix>: SKIP the example (exit 0), or FAIL (exit 1) when EXAMPLES_REQUIRE names the key
  if required "$1"; then
    echo "FAIL: $2 (EXAMPLES_REQUIRE=$1)" >&2
    echo "  fix: $3" >&2
    exit 1
  fi
  echo "SKIP: $2"
  echo "  fix: $3"
  exit 0
}

skip_section() {  # <key> <section> <reason> <fix>: note on stderr and return 1, or FAIL when required
  if required "$1"; then
    echo "FAIL: the $2 section: $3 (EXAMPLES_REQUIRE=$1)" >&2
    echo "  fix: $4" >&2
    exit 1
  fi
  echo "run.sh: skipping the $2 section: $3 (fix: $4)" >&2
  return 1
}

check_wasm() {  # Node >= 20, the Relate bundle checked by lib/relate_wasm.mjs, every npm package at its pin
  local fix_npm="cd examples/03-wasm-agent-memory && npm ci --omit=peer" reason major
  command -v node >/dev/null 2>&1 || skip wasm "node not found: 03 needs Node >= 20" "install Node >= 20"
  major="$(node -p 'process.versions.node.split(".")[0]')"
  (( major >= 20 )) || skip wasm "node $(node --version) is too old: 03 needs Node >= 20" "install Node >= 20"
  if ! reason="$(node --input-type=module -e '
      const { pathToFileURL } = await import("node:url");
      const { check } = await import(pathToFileURL(process.argv[1]).href);
      const info = await check(process.argv[2]);
      console.log(info.reason);
      process.exit(info.ok ? 0 : 1);
    ' "$root/lib/relate_wasm.mjs" "$ver")"; then
    skip wasm "the Relate $ver WASM bundle: ${reason//examples\/01-wasm-extract/examples\/03-wasm-agent-memory}" "$fix_npm"
  fi
  if ! reason="$(node -e '
      const fs = require("fs");
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
      for (const [name, want] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
        let got = "missing";
        try { got = JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, "utf8")).version; } catch {}
        if (got !== want) { console.log(`node_modules/${name} is ${got}, package.json pins ${want}`); process.exit(1); }
      }')"; then
    skip wasm "$reason" "$fix_npm"
  fi
}

check_browser() {  # Playwright's Chromium launches headless
  local reason
  if ! reason="$(node --input-type=module -e '
      const { chromium } = await import("playwright");
      try { const b = await chromium.launch(); await b.close(); }
      catch (e) { console.log(e.message.split("\n")[0]); process.exit(1); }
    ' 2>&1)"; then
    skip_section browser browser "Chromium does not launch: $reason" "npx playwright install chromium (in examples/03-wasm-agent-memory)"
    return 1
  fi
}

check_native() {  # the project env's binding, $ver
  local w
  w="$(py -c 'import relate; print(relate.__version__)' 2>&1)" || true
  if [[ "$w" != "$ver" ]]; then
    if ! command -v uv >/dev/null 2>&1; then
      echo "run.sh: skipping the native section: no uv (fix: the repository's setup, README.md)" >&2
      return 1
    fi
    echo "FAIL: the native section needs Relate $ver: the project env's binding says '$w'" >&2
    echo "  fix: the repository's setup (README.md): uv sync (relate-db==$ver)" >&2
    exit 1
  fi
}

case "$mode" in
  site)
    # dist/ (npm run build) at /relate-examples/03-wasm-agent-memory/ as GitHub Pages serves it (lib/serve.mjs):
    # no custom headers (the page's CSP <meta> is the policy), the trailing-slash redirect. Foreground;
    # EX03_PORT picks the port (default 8703).
    check_wasm
    npm run --silent build >&2
    exec node "$root/lib/serve.mjs" --example 03-wasm-agent-memory --port "${EX03_PORT:-8703}" ;;
esac

check_wasm
native=1; check_native || native=0
rm -rf out work && mkdir -p out work
diffed=()

# ---- Node: the statements, every scripted conversation, typed turns, the probes ----------------------------
# harness/run.mjs on Relate's WASM build in memory, through the page's own modules (web/memory.js, web/agent.js,
# web/embed.js): the statements behind each tool; every turn of every conversation, with what each tool
# returned and the reply's citations checked against it; turns nobody scripted; the Relate behaviours the
# example depends on (NOTES.md M1-M7). A citation the engine did not return, or a probe that stops
# reproducing, prints `PIN: ...` on stderr and fails the run. It also writes out/replay.json for the browser
# and native sections.
if ! node harness/run.mjs --out out 2> out/run.err; then
  grep -h '^PIN:' out/run.err >&2 || tail -n 20 out/run.err >&2
  echo "FAIL: harness/run.mjs (stderr in out/run.err)" >&2
  exit 1
fi
diffed+=(statements.cypher scenarios.txt typed.txt probes.txt)

# ---- browser: headless Chromium against dist/ at the Pages sub-path, production CSP -> out/browser.txt ------
# npm run build, then harness/drive.mjs serves dist/ with lib/serve.mjs and drives the page with ?test=1: boot,
# the brand's logo and typefaces, every scripted turn (compared with out/replay.json; what NVL holds against
# what is stored; what NVL has selected against the returned paths), the buttons, typed turns, the list and
# the console (two refused writes among them), the toggles, and no console errors or CSP violations.
if check_browser; then
  if ! npm run --silent build > out/build.err 2>&1; then
    tail -n 20 out/build.err >&2
    echo "FAIL: npm run build (output in out/build.err)" >&2
    exit 1
  fi
  if ! node harness/drive.mjs --out out/browser.txt > out/browser.err 2>&1; then
    grep -h '^drive.mjs: FAIL' out/browser.err >&2 || tail -n 20 out/browser.err >&2
    echo "FAIL: harness/drive.mjs (stderr in out/browser.err)" >&2
    exit 1
  fi
  diffed+=(browser.txt)
fi

# ---- native 1.2.0: every statement the conversations ran, replayed natively and compared -> out/native.txt --
if (( native )); then
  if ! py -I harness/native.py > out/native.txt 2> out/native.err; then
    grep -h '^native.py: FAIL' out/native.err >&2 || tail -n 20 out/native.err >&2
    echo "FAIL: harness/native.py (stderr in out/native.err)" >&2
    exit 1
  fi
  diffed+=(native.txt)
fi

if (( update )); then
  mkdir -p expected
  for f in "${diffed[@]}"; do cp "out/$f" "expected/$f"; done
  echo "expected/ updated (${diffed[*]})"
else
  rc=0
  for f in "${diffed[@]}"; do diff -u "expected/$f" "out/$f" || rc=1; done
  (( rc == 0 )) || { echo "FAIL: out/ differs from expected/ (above)" >&2; exit 1; }
  echo "matches expected/ ✓ (${diffed[*]})"
fi
