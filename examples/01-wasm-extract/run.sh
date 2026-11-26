#!/usr/bin/env bash
# edgextract's approach in a browser tab: GLiNER2.5 (gliner-rs WASM), Relate 1.3.0 WASM and NVL.
#   ./run.sh               offline: the Node sections, then browser, then native; checked against expected/
#   ./run.sh --update      rewrite expected/ from this run
#   ./run.sh --reference   re-record data/reference/gliner2-small.json from Python gliner2 (no Node; uv)
#   ./run.sh --reference --check   record it afresh and compare with the committed file; writes nothing
#   ./run.sh --model base  the Node pipeline on GLiNER2.5-base-v1 (the samples' gold): prints, never diffs
#   ./run.sh --serve       serve the page from web/ for development (?models=local: weights from .cache/gliner)
#   ./run.sh --site        build dist/ and serve it at /relate-examples/01-wasm-extract/ as GitHub Pages would
#
# Setup (README.md): scripts/build-gliner-wasm.sh; scripts/fetch-gliner.sh small; then here
# `npm ci --omit=peer && npm run vendor` (--omit=peer skips NVL's unused neo4j-driver peer; npm ci also
# installs @relate/relate-wasm, pinned with its integrity in package-lock.json).
# The native section runs on the repository's engine: `relate` on PATH and the project env's
# binding (uv run python: relate-db), both 1.3.0 like the WASM bundle; another version fails the run.
# EXAMPLES_REQUIRE keys: without `wasm` (Node >= 20, the pinned Relate bundle in node_modules, the
# gliner-rs build, npm ci, the NVL vendor bundle) or `gliner` (the small-v1 weights) the whole example
# prints SKIP and exits 0; without `browser` (Playwright's Chromium) only that section is skipped, with
# a note on stderr. A key named in EXAMPLES_REQUIRE fails instead (CI names all three). With no
# `relate` on PATH the native section is skipped with a note on stderr.
set -euo pipefail
cd "$(dirname "$0")"
source ../../scripts/env.sh   # loads <repo>/.env; RELATE_TELEMETRY=off, RELATE_MAX_ROWS=0, RELATE_AGENT_MODE=0
root="$(cd ../.. && pwd)"
ver=1.3.0                     # Relate: the WASM bundle (package.json), and the release the native section checks the project engine is
gliner_rev=4fa741e            # gliner-rs v0.3.1 (D4)
model=gliner2.5-small-v1      # the default checkpoint (D4), at revision 7132dc4
model_rev=7132dc4
py() { uv run --project "$root" --quiet python "$@"; }   # the project env: relate-db, the repository's binding

update=0 check=0 mode=run
while (( $# )); do
  case "$1" in
    --update) update=1 ;;
    --reference) mode=reference ;;
    --model) [[ "${2:-}" == base ]] || { echo "run.sh: --model takes 'base'" >&2; exit 2; }; mode="model-base"; shift ;;
    --serve) mode=serve ;;
    --site) mode=site ;;
    --check) check=1 ;;
    -h|--help) sed -n '2,9p' run.sh | sed 's/^# \{0,1\}//'; exit 0 ;;   # after the cd: from any cwd
    *) echo "run.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
if (( check )) && [[ "$mode" != reference ]]; then echo "run.sh: --check goes with --reference" >&2; exit 2; fi

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

script_reason() {  # <a --check script's output>: its last message, without the script's name and its own fix
  grep -v '^export ' <<<"$1" | tail -n 1 | sed -e 's/^[a-z-]*: //' -e 's/; fix: .*$//' -e "s|$root/||g"
}

check_wasm() {  # Node >= 20, npm ci's packages at their pins (the Relate bundle among them), the NVL vendor bundle
  local fix_npm="cd examples/01-wasm-extract && npm ci --omit=peer && npm run vendor" reason major
  command -v node >/dev/null 2>&1 || skip wasm "node not found: 01 needs Node >= 20" "install Node >= 20"
  major="$(node -p 'process.versions.node.split(".")[0]')"
  (( major >= 20 )) || skip wasm "node $(node --version) is too old: 01 needs Node >= 20" "install Node >= 20"
  if ! reason="$(node --input-type=module -e '
      const { pathToFileURL } = await import("node:url");
      const { check } = await import(pathToFileURL(process.argv[1]).href);
      const info = await check(process.argv[2]);
      console.log(info.reason);
      process.exit(info.ok ? 0 : 1);
    ' "$root/lib/relate_wasm.mjs" "$ver")"; then
    skip wasm "the Relate $ver WASM bundle: $reason" "$fix_npm"
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
  # The bundles and esbuild's metafiles, from which build.mjs ships the bundled packages' licences.
  [[ -f web/vendor/nvl.js && -f web/vendor/HierarchicalLayout.worker.js && -f web/vendor/nvl.js.meta.json && -f web/vendor/HierarchicalLayout.worker.js.meta.json ]] ||
    skip wasm "no NVL vendor bundle (with its metafiles) in web/vendor/" "$fix_npm"
  # The gliner-rs build (D4): --check re-hashes the cached build against its .built (and a pin,
  # should one appear) without building; it prints GLINER_WASM_DIR, which the harnesses read.
  local got
  if ! got="$("$root/scripts/build-gliner-wasm.sh" --check 2>&1)"; then
    skip wasm "no verified gliner-rs $gliner_rev build ($(script_reason "$got"))" "scripts/build-gliner-wasm.sh"
  fi
  eval "$(grep '^export ' <<<"$got")"
}

check_gliner() {  # <small|base>: the weights, re-hashed against ci/<model>.sha256 by fetch-gliner.sh --check
  # It reads only the cache (no network, no writes) and prints GLINER_SMALL_DIR (GLINER_BASE_DIR).
  local got
  if ! got="$("$root/scripts/fetch-gliner.sh" "$1" --check 2>&1)"; then
    skip gliner "no verified gliner2.5-$1-v1 weights ($(script_reason "$got"))" "scripts/fetch-gliner.sh $1"
  fi
  eval "$(grep '^export ' <<<"$got")"
}

check_browser() {  # Playwright 1.63.0's Chromium launches headless
  local reason
  if ! reason="$(node --input-type=module -e '
      const { chromium } = await import("playwright");
      try { const b = await chromium.launch(); await b.close(); }
      catch (e) { console.log(e.message.split("\n")[0]); process.exit(1); }
    ' 2>&1)"; then
    skip_section browser browser "Chromium does not launch: $reason" "npx playwright install chromium (in examples/01-wasm-extract)"
    return 1
  fi
}

check_native() {  # the repository's engine: `relate` on PATH and the project env's binding, both $ver (they share files)
  local v w
  if ! command -v relate >/dev/null 2>&1; then
    echo "run.sh: skipping the native section: no relate on PATH (fix: the repository's setup, README.md)" >&2
    return 1
  fi
  v="$(relate --version 2>&1 | head -1)" || true   # the first line is the version, the second the licence
  w="$(py -c 'import relate; print(relate.__version__)' 2>&1)" || true
  if [[ "$v" != "Relate v$ver" || "$w" != "$ver" ]]; then
    echo "FAIL: the native section needs Relate $ver: relate on PATH says '$v', the project env's binding '$w'" >&2
    echo "  fix: the repository's setup (README.md): the $ver CLI on PATH, uv sync (relate-db==$ver)" >&2
    exit 1
  fi
}

case "$mode" in
  reference)
    # data/reference/gliner2-small.json, the fixture harness/model.mjs holds gliner-rs to: GLiNER2.5-small-v1
    # through Python gliner2 2.0.0 on torch (CPU, one thread). harness/reference.py is stdlib-only under any
    # python3; it builds its own pinned uv env in .cache/gliner-ref-env once (a few minutes) and needs the
    # verified weights (scripts/fetch-gliner.sh small), but not Node, npm or the WASM bundles. The recording
    # itself runs offline and says whether it changed; --check writes nothing and exits 1 when a fresh recording is
    # not byte-identical to the committed one. Not part of a normal run.
    command -v python3 >/dev/null 2>&1 || { echo "FAIL: --reference needs python3 (and uv)" >&2; exit 1; }
    if (( check )); then exec python3 -I harness/reference.py --check; fi
    exec python3 -I harness/reference.py ;;
  model-base)
    # The create-context-graph samples through GLiNER2.5-base-v1: extract.txt and score.txt in out/base/,
    # printed, never diffed.
    check_wasm
    check_gliner base
    rm -rf out/base && mkdir -p out/base
    if ! node harness/run.mjs "$ver" --model base --out out/base 2> out/base/run.err; then
      tail -n 20 out/base/run.err >&2
      echo "FAIL: harness/run.mjs --model base (stderr in out/base/run.err)" >&2
      exit 1
    fi
    cat out/base/extract.txt out/base/score.txt
    echo "(--model base: printed, not diffed; files in out/base/)"
    exit 0 ;;
  serve)
    # Development (D13): web/ in dist/'s URL layout, imports rewritten as build.mjs rewrites them;
    # /models/ serves .cache/gliner, so <url>?models=local loads the weights without the Hub.
    # Foreground; EX01_PORT picks the port (default 8701, 0 = any free one).
    if [[ ! -f web/vendor/nvl.js.meta.json && -d node_modules/@neo4j-nvl/base ]]; then npm run --silent vendor >&2; fi
    check_wasm
    exec node harness/serve.mjs --dev --port "${EX01_PORT:-8701}" ;;
  site)
    # dist/ (npm run build) at /relate-examples/01-wasm-extract/ as GitHub Pages serves it: no custom
    # headers (the page's CSP <meta> is the policy), the trailing-slash redirect. The weights come from the
    # Hub, as in production.
    check_wasm
    npm run --silent build >&2
    exec node harness/serve.mjs --site --port "${EX01_PORT:-8701}" ;;
esac

check_wasm
check_gliner small
native=1; check_native || native=0   # before the long sections: a wrong engine fails in seconds
rm -rf out work && mkdir -p out work
diffed=()

# ---- probes: the Relate WASM surface (NOTES.md R1-R19), in memory ------------------------
# A pin that stops reproducing prints `PIN: <row> changed: ...` on stderr and fails the run.
if ! node harness/probes.mjs "$ver" > out/probes.txt 2> out/probes.err; then
  grep -h '^PIN:' out/probes.err >&2 || tail -n 20 out/probes.err >&2
  echo "FAIL: harness/probes.mjs (stderr in out/probes.err)" >&2
  exit 1
fi
diffed+=(probes.txt)

# ---- model: gliner-rs against data/reference/ (G5-G11) -> out/model.txt --------------------
# Parity with the Python gliner2 fixture, a repeated call bit-identical, code-point offsets, one span
# under two labels, and G10's long-input collapse (a pin: `PIN: G10 changed` when it recovers).
if ! node harness/model.mjs > out/model.txt 2> out/model.err; then
  grep -h '^model.mjs: PIN:' out/model.err >&2 || tail -n 20 out/model.err >&2
  echo "FAIL: harness/model.mjs (stderr in out/model.err)" >&2
  exit 1
fi
diffed+=(model.txt)

# ---- ontology: every bundled ontology, its graph type, the D15 canary -> out/ontology.txt ---
# web/ontology.js, split.js and names.js on the WASM bundle (in memory): create-context-graph's 27
# domains with _base.yaml (data/ontologies/ccg/), three of them through the gate and publish without
# the model, the id rule (no leading _), a generic document (harness/fixtures.mjs), edgextract's YAML
# refused and the stores earlier builds made for its ontologies, the example's limits, and the ported
# splitter and names checked against edgextract 0.1.0's own WASM (the dev dependency). A pin that stops
# reproducing, a parity mismatch, or the canary finding db.ontology.* prints `PIN: ...` on stderr and
# fails the run.
if ! node harness/ontology.mjs "$ver" > out/ontology.txt 2> out/ontology.err; then
  grep -h '^PIN:' out/ontology.err >&2 || tail -n 20 out/ontology.err >&2
  echo "FAIL: harness/ontology.mjs (stderr in out/ontology.err)" >&2
  exit 1
fi
diffed+=(ontology.txt)

# ---- the pipeline in Node: extract, gate, audit, review, score -> out/{extract,gate,audit,review,score}.txt, graph.cypher
# web/pipeline.js and web/store.js on the real model (small-v1) and the WASM bundle, one in-memory store
# per ontology (D14): create-context-graph's 27 synthetic samples, one per domain, and the harness's
# fixtures (harness/fixtures.mjs: edge cases, in a store of their own); the floor and rule invariants; the
# audits (queries/audit-*.cypher); verdicts; P/R/F1 against the samples' gold (per domain, with the
# distractor check) and phase C's grids; the typed graph exported as Cypher. gliner-rs answers every question first on a
# pool of worker threads (harness/infer.mjs; EX01_INFER_THREADS overrides the count, at most 6 by default).
# An audit with rows or a refusal that is not the pinned one prints `run.mjs: FAIL: ...` on stderr and
# fails the run.
if ! node harness/run.mjs "$ver" --out out 2> out/run.err; then
  grep -h '^run.mjs: FAIL' out/run.err >&2 || tail -n 20 out/run.err >&2
  echo "FAIL: harness/run.mjs (stderr in out/run.err)" >&2
  exit 1
fi
diffed+=(extract.txt gate.txt audit.txt review.txt score.txt graph.cypher)

# ---- browser: headless Chromium against dist/ at a sub-path, production CSP -> out/browser.txt
# harness/drive.mjs runs npm run build, serves dist/ with harness/serve.mjs --site (the Pages sub-path,
# no custom headers: the page's CSP <meta>) on a fixed port, and drives the page with a fresh profile in work/browser/: the model
# through page.route() from .cache/gliner, OPFS stores, reload, download and restore, the console's
# read-only lease and watchdog, NVL, two tabs, a crash mid-section, reset; the content is compared
# with web/pipeline.js and web/store.js run in Node. It runs before the native section, which reads
# the page's dump.json and database tar from work/browser/ (and makes equivalents when this section
# is skipped). Its X4 restore input is made by harness/native.py x4 with the project engine, or, without
# a 1.3.0 `relate` on PATH, is the download re-tarred by lib/opfsfmt.py (a note on stderr).
if check_browser; then
  if ! node harness/drive.mjs --out out/browser.txt > out/browser.err 2>&1; then
    grep -h '^drive.mjs: FAIL' out/browser.err >&2 || tail -n 20 out/browser.err >&2
    echo "FAIL: harness/drive.mjs (stderr in out/browser.err)" >&2
    exit 1
  fi
  diffed+=(browser.txt)
fi

# ---- native 1.3.0: lib/replay, queries/*.cypher, the download route -> out/native.txt ------
# harness/native.py with the project env's interpreter (-I) and `relate` from PATH: the page's dump
# through lib/replay.py, the saved queries on WASM (Node) and natively, the page's snapshot tar opened
# natively (a writable open adopts it) and cloned to a .rl, and a native .rl as a restore tar by the X4
# route the page documents, as written (relate clone --to-snapshot-format json, then lib/opfsfmt.py
# to-tar). Every subprocess it starts has a 300 s timeout. native.txt is the same with or without the
# browser section.
if (( native )); then
  if ! py -I harness/native.py > out/native.txt 2> out/native.err; then
    grep -h '^native.py: FAIL' out/native.err >&2 || tail -n 20 out/native.err >&2
    echo "FAIL: harness/native.py (stderr in out/native.err)" >&2
    exit 1
  fi
  diffed+=(native.txt)
fi

if (( update )); then
  for f in "${diffed[@]}"; do cp "out/$f" "expected/$f"; done
  echo "expected/ updated (${diffed[*]})"
else
  rc=0
  for f in "${diffed[@]}"; do diff -u "expected/$f" "out/$f" || rc=1; done
  (( rc == 0 )) || { echo "FAIL: out/ differs from expected/ (above)" >&2; exit 1; }
  echo "matches expected/ ✓ (${diffed[*]})"
fi
