# CLAUDE.md

Guidance for Claude Code sessions in this repository.

## What this repo is

Runnable examples for Relate, an embedded openCypher graph database (one binary; a database is a
directory, a single `.rl` file or `:memory:`). Everything targets **Relate 1.2.0**: the `relate` CLI
on `PATH` (`relate --version`'s first line is `Relate v1.2.0`), the `relate-db==1.2.0` Python binding
(root `pyproject.toml`, `uv.lock`; `import relate`), and the npm package `@relate/relate-wasm@1.2.0`
(pinned in each browser example's `package.json` and `package-lock.json`). Browser examples are
published as a static GitHub Pages project site, `https://johnymontana.github.io/relate-examples/`.

There is one example so far: `examples/33-wasm-extract/` (markdown to a knowledge graph in a browser
tab: GLiNER2.5 through gliner-rs WASM, Relate's WASM build in OPFS, NVL, a read-only Cypher console).
Its `README.md` describes it as built, and its `NOTES.md` lists every Relate 1.2.0 behaviour it
depends on or pins (rows `R1`…`R23`, each with a minimal repro) plus the design ids (D, E, G, O, V,
X) the code cites. Read both before changing it.

## Setup and commands

```bash
curl -sSfL https://relatedb.ai/install.sh | bash   # relate CLI (installs the latest release: check it says v1.2.0)
uv sync                                             # relate-db 1.2.0 + pytest
rustup toolchain install 1.97.1 --profile minimal --target wasm32-unknown-unknown
scripts/build-gliner-wasm.sh [--check|--force]      # gliner-rs v0.3.1 (4fa741e) → .cache/gliner-wasm/; prints GLINER_WASM_DIR
scripts/fetch-gliner.sh small|base [--check|--pin]  # GLiNER2.5 weights → .cache/gliner/, checked against ci/gliner2.5-*.sha256
(cd examples/33-wasm-extract && npm ci --omit=peer && npm run vendor && npx playwright install chromium)

uv run pytest -q                                    # lib/tests; testpaths = examples + lib/tests, so run from the root
examples/33-wasm-extract/run.sh                     # offline, ~8-10 min, diffed against expected/ (caffeinate -i on a laptop)
examples/33-wasm-extract/run.sh --update            # rewrite expected/ (only after reading the diff)
examples/33-wasm-extract/run.sh --site              # dist/ served as Pages serves it, on EX33_PORT (default 8733)
examples/33-wasm-extract/run.sh --serve             # development server from web/ (?models=local: weights from .cache/gliner)
node examples/33-wasm-extract/harness/convert.mjs [--check]   # regenerate (or compare) the bundled v1 ontologies
node site/build.mjs [--no-build]                    # the Pages site into site/dist/
python3 -I lib/opfsfmt.py check|to-dir|to-tar ...   # strict guard for a store exported from OPFS
```

While iterating on 33, run one section's harness directly from the example's directory, after
`source ../../scripts/env.sh` (`node harness/probes.mjs 1.2.0 > out/probes.txt`,
`node harness/run.mjs 1.2.0 --out out`, `node harness/drive.mjs --out out/browser.txt`,
`uv run --project ../.. python -I harness/native.py`) instead of the whole `run.sh`.

## The `run.sh` contract

- `set -euo pipefail`, `cd` to its own directory, `source ../../scripts/env.sh` (loads the root
  `.env` without overriding shell variables; sets `RELATE_MAX_ROWS=0`, `RELATE_AGENT_MODE=0`,
  `RELATE_TELEMETRY=off`).
- It deletes `out/` and `work/`, writes its outputs to `out/`, then `diff -u`s each against
  `expected/`; `--update` copies them over instead. That diff is the regression test.
- Output is byte-identical across runs: no timestamps, pids, temp paths or timings in a diffed file;
  stderr (`out/*.err`) never goes into a diff. A pinned engine behaviour that stops reproducing fails
  the run with a `PIN: <row> changed` line on stderr: update the code, `NOTES.md`, `expected/` and
  the README together.
- Re-record `expected/` only after reading the diff and being able to classify every change
  (a rename or version string, a deliberate design change, or a Relate behaviour change recorded in
  `NOTES.md`). Extraction and score numbers should not move without a reason you can name.
- Never run two `run.sh` in one example directory at once (each deletes `out/` and `work/`). Check
  for leftover servers and Chromium processes after a browser run.
- `EXAMPLES_REQUIRE` (comma list): a missing optional dependency prints `SKIP:` and exits 0 unless
  its key is named, then it fails. 33's keys: `wasm` (Node 20+, the pinned bundle, npm pins, NVL
  vendor bundle, gliner-rs build), `gliner` (small-v1 weights), `browser` (Playwright's Chromium;
  only that section skips). The native section needs `relate` 1.2.0 on `PATH` and the matching
  binding; a different version fails at once.

## Shared code

- `lib/relate_wasm.mjs`: ESM for Node and the browser. `find`/`check`/`loadNode(ver)` locate the
  bundle (`node_modules/@relate/relate-wasm`, or `RELATE_WASM_DIR`) and refuse it unless
  `dbms.components()` reports that version; `exec`/`script` refuse a null, undefined, NaN or missing
  top-level parameter (unless `{allowNull: true}`) and throw `RelateWasmError` with a `category`;
  `classify`, `version`, `isTrap`.
- `lib/replay.mjs` and `lib/replay.py`: `dump`/`load`/`digest`/`content_digest` in one JSON format
  that both write byte for byte alike, graph types included. The JS side has its own parser: never
  pass a dump through `JSON.parse`/`JSON.stringify`/`postMessage` (send `canon(d)` text).
- `lib/opfsfmt.py` (stdlib) and its browser twin `examples/33-wasm-extract/web/opfs.js`: the strict
  format guard, pinned by `VERIFIED = "1.2.0"`; exit 3 on anything else.
- `lib/tests/`: `test_opfsfmt.py`, `test_replay.py`, `test_replay_js.py`, `test_site_build.py`
  (`conftest.py` puts `lib/` on `sys.path`; `lib/` is a plain directory, not a package).
- `scripts/env.sh`, `scripts/build-gliner-wasm.sh`, `scripts/fetch-gliner.sh` (each `--check` mode
  reads only the cache and prints an `export` line).

## Hard rules

- **Names.** The engine had an earlier product name; it must never appear in any tracked file (code,
  identifiers, comments, file names, outputs, sample documents, docs, package names). Check before
  finishing: `git ls-files -co --exclude-standard | xargs grep -il <that name>` and
  `git ls-files -co --exclude-standard | grep -i <that name>` both empty. Native directory databases
  still contain role-marker and lease dot files spelled with it, so code never names them: dot
  entries are skipped by one generic rule (any path part starting with `.`), and nothing here writes
  one into a store, a download or a restore (R10, R22).
- **Citations.** Cite engine behaviours by the example's `NOTES.md` row ids (`R1`…). Never cite
  another repository's issue rows, ADRs or plan documents; add a `NOTES.md` row instead, re-verified
  on 1.2.0, with a minimal repro.
- **Hosting is GitHub Pages only.** No custom headers: every HTML page carries one CSP
  `<meta http-equiv>` in `<head>` before any script (no `frame-ancestors`, `report-uri`,
  `report-to`, `sandbox`), relative URLs only (no `"/x"` or `"//x"`), unchanging files under
  versioned `assets/<name>-<version>/`, and `.nojekyll`. `site/build.mjs` enforces this.
  `harness/serve.mjs --site` emulates Pages (base `/relate-examples/`, no custom headers,
  `max-age=600`, 301 to the trailing slash, 404 otherwise); keep it faithful.
- **Per-origin names** carry the example's prefix (`ex33-…` stores and caches, `ex33.*`
  `localStorage` keys, `EX33_*` env vars): every example shares one origin.
- **Engine pins move together.** A Relate upgrade bumps `@relate/relate-wasm` (package.json and
  lockfile), `relate-db` (pyproject and `uv.lock`), `ci/relate-<ver>.sha256`, `RELATE_VERSION` in
  `examples.yml`, `ver` in `run.sh`, `VERIFIED` in `lib/opfsfmt.py`, then every `NOTES.md` row is
  re-checked.
- Every change must pass offline. Don't commit or push unless asked.

## Relate 1.2.0 rules for code here (details and repros in 33's NOTES.md)

- **CLI grammar:** `relate [flags] -d DB 'Q'`; a piped script needs the verb,
  `relate query [flags] -d DB < script`; read-only is `relate --read-only -d DB 'Q'`; also
  `relate info -d DB`, `relate clone SRC DEST`. Pass the output mode explicitly (`--mode jsonl`,
  `--json`). Single-file bundles end in `.rl`.
- **WASM has no transactions** (R2): every `execute` autocommits; write idempotent `MERGE`s and a
  completion marker last.
- **Parameters** (R3): a null parameter in a property map now matches nothing and a missing one is
  `ParameterMissing`, but keep refusing null/missing arguments (`relate_wasm.exec`) and guard on the
  parameter side (`WHERE $p IS NOT NULL`), so a forgotten value is loud.
- **Numbers** (R4, R5): `JSON.parse` loses integers above 2^53; an integral JS number binds as
  INTEGER, so `toFloat()` every float parameter. Alias every RETURN column you read (R6).
- **Indexes** (R9): every store has two built-in LOOKUP indexes; `OPTIONS {indexProvider: …}` is a
  syntax error; never create an index equivalent to a UNIQUE constraint (refused either order).
- **One opener per OPFS store**, read-only included, across tabs and workers (R11): retry
  `storage locked` on reopen. `free()` is the only checkpoint (R12). WASM memory never shrinks
  (R13): recycle workers. A trapped handle is unusable (R14): replace the worker.
- **Graph types** (R16): a successful `ALTER CURRENT GRAPH TYPE SET` drops every other constraint
  (re-create them), allows one source and one target label per relationship type, and is refused
  by existing data with `ConstraintCreationFailed`.
- **No `system_ontologies`**; `db.ontology.*` is preview-gated and unreachable from WASM (R17).
- After an aggregating `RETURN`, `ORDER BY` may use only projected expressions (R20).
- **Snapshots** (R22): a directory with only `graph.json` + `manifest.json` is adopted by a plain
  writable open (`mkdir db && tar -xf <store>.relate.tar -C db && relate -d db 'Q'`); a read-only
  open or `relate clone` refuses it until then; a directory with `wal/` but no markers is refused.
- Set `RELATE_MAX_ROWS=0` and `RELATE_AGENT_MODE=0` for any script that pipes CLI output: under an
  agent harness the CLI otherwise switches piped output to toon and caps it at 100 rows.
