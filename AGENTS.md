# AGENTS.md

Guidance for coding agents working in this repository. Claude Code reads it through `CLAUDE.md`,
which imports this file. Keep the guidance here, not in `CLAUDE.md`.

## What this repo is

Runnable examples for Relate, an embedded openCypher graph database (one binary; a database is a
directory, a single `.rl` file or `:memory:`). Everything targets **Relate 1.2.0**: the `relate` CLI
on `PATH` (`relate --version`'s first line is `Relate v1.2.0`), the `relate-db==1.2.0` Python binding
(root `pyproject.toml`, `uv.lock`; `import relate`), and the npm package `@relate/relate-wasm@1.2.0`
(pinned in each browser example's `package.json` and `package-lock.json`). Browser examples are
published as a static GitHub Pages project site, `https://johnymontana.github.io/relate-examples/`.

There are three examples, each with a `README.md` that describes it as built and a `NOTES.md` that
lists every behaviour it depends on or pins (each row with a minimal repro) plus the design ids the
code cites. Read both before changing an example.
- `examples/01-wasm-extract/`: markdown to a knowledge graph in a browser tab. GLiNER2.5 through
  gliner-rs WASM, Relate's WASM build in OPFS, NVL, and a read-only Cypher console. Rows `R1`…`R24`;
  design ids D, E, G, O, V, X, Y.
- `examples/02-wasm-text2cypher/`: ontology-grounded Text2Cypher in a browser tab. WebLLM (Qwen3.5)
  on WebGPU, or canned reference queries; Relate's WASM build in memory under a graph type derived
  from the ontology. Rows `P1`…`P9`; ids Y, W, D.
- `examples/03-wasm-agent-memory/`: the Relate playground as an agent's memory. A scripted chat
  (no language model on the page) writes memories into Relate's WASM build, in memory under a graph
  type, and recalls them with one statement (vector and full-text search, then graph hops); NVL
  draws the store and selects the returned paths, and the page follows the Relate brand kit
  (`data/brand/`). Vectors are real (all-MiniLM-L6-v2): precomputed for the scripts' texts in
  `data/embeddings.json`, and made in the tab with Transformers.js for typed text.
  Rows `M1`…`M7`, `N1`…`N6` and `T1`…`T5`; ids D.

Examples 01 and 02 read Ontology Graph Spec 1.1 documents through the official SDK (npm
`@neo4j/ontology-graph-spec` 0.12.2) via `lib/ogs.mjs`.

The decisions the repository is built on are ADRs in `docs/adr/` (see "Decisions" below). The
browser-site contract is in `site/README.md`, and CI's steps and pins are in `ci/README.md`.

## Decisions (ADRs)

- **Read before changing.** Read `docs/adr/README.md`'s index, then every ADR a change touches. The
  rules below name the ADR behind each one. A change that contradicts an accepted ADR is a new
  decision, so write a new ADR first.
- **When to write one.** Write an ADR when a decision is hard to reverse, would surprise a reader
  without context, and came from a real trade-off. If any of the three is missing, it is not an
  ADR. Engine and library behaviours go in the example's `NOTES.md` as a row with a minimal repro.
  Small design choices the code cites stay as `NOTES.md` design ids, and a design id that carries a
  repository-level decision points to its ADR.
- **How.** Use the next free number, `docs/adr/NNNN-short-slug.md`, with the title and one line:
  `Status: … · Decided: … · Scope: …`. Then write the context, the decision and why, in a few
  sentences. Add **Considered options** and **Consequences** only when they add something. Add the
  ADR to the index in `docs/adr/README.md`.
- **Changing one.** Never rewrite an accepted ADR's decision. Write a new ADR, set the old one's
  status to `superseded by ADR-NNNN`, and update the index. Fixing a typo or a link in place is fine.
- **Plans are not records.** A plan document may guide work in progress. When the work lands, every
  decision in it that meets the bar above becomes an ADR. Code and docs never cite the plan.
- Update the ADRs in the same change as the code: a reviewer should never find code that
  contradicts an accepted ADR.

## Setup and commands

```bash
curl -sSfL https://relatedb.ai/install.sh | bash   # relate CLI (installs the latest release: check it says v1.2.0)
uv sync                                             # relate-db 1.2.0 + pytest
rustup toolchain install 1.97.1 --profile minimal --target wasm32-unknown-unknown
scripts/build-gliner-wasm.sh [--check|--force]      # gliner-rs v0.3.1 (4fa741e) → .cache/gliner-wasm/; prints GLINER_WASM_DIR
scripts/fetch-gliner.sh small|base [--check|--pin]  # GLiNER2.5 weights → .cache/gliner/, checked against ci/gliner2.5-*.sha256
(cd examples/01-wasm-extract && npm ci --omit=peer && npm run vendor && npx playwright install chromium)
(cd examples/02-wasm-text2cypher && npm ci --omit=peer)
(cd examples/03-wasm-agent-memory && ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=peer)

uv run pytest -q                                    # lib/tests; testpaths = examples + lib/tests, so run from the root
examples/01-wasm-extract/run.sh                     # offline, ~8-10 min, diffed against expected/ (caffeinate -i on a laptop)
examples/01-wasm-extract/run.sh --update            # rewrite expected/ (only after reading the diff)
examples/01-wasm-extract/run.sh --site              # dist/ served as Pages serves it, on EX01_PORT (default 8701)
examples/01-wasm-extract/run.sh --serve             # development server from web/ (?models=local: weights from .cache/gliner)
node examples/01-wasm-extract/harness/convert.mjs [--check]   # regenerate (or compare) the bundled ontologies
examples/02-wasm-text2cypher/run.sh                 # offline, ~1 min: Node, Chromium (canned mode), native
examples/02-wasm-text2cypher/run.sh --site          # dist/ served as Pages serves it, on EX02_PORT (default 8702)
examples/02-wasm-text2cypher/run.sh --llm-eval      # local only: both models in the system Chrome (WebGPU), never diffed
examples/03-wasm-agent-memory/run.sh                # offline, a few seconds: Node, Chromium, native
examples/03-wasm-agent-memory/run.sh --site         # dist/ served as Pages serves it, on EX03_PORT (default 8703)
node examples/03-wasm-agent-memory/harness/embed.mjs [--check]   # by hand, after a scripted text changes: data/embeddings.json
node site/build.mjs [--no-build]                    # the Pages site into site/dist/
python3 -I lib/opfsfmt.py check|to-dir|to-tar ...   # strict guard for a store exported from OPFS
```

While iterating on 01, run one section's harness directly from the example's directory, after
`source ../../scripts/env.sh` (`node harness/probes.mjs 1.2.0 > out/probes.txt`,
`node harness/run.mjs 1.2.0 --out out`, `node harness/drive.mjs --out out/browser.txt`,
`uv run --project ../.. python -I harness/native.py`) instead of the whole `run.sh`. Example 03's
run is quick enough to run whole; one Node section alone is `node harness/run.mjs --only scenarios`
(or `statements`, `typed`, `probes`).

## The `run.sh` contract (ADR-0004)

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
- Each browser example's `screenshot.png` is the picture on its card on the Pages index
  (`site.json` `screenshot`; `summary` is the card's text). It is committed, never diffed, and
  retaken by hand after a visible change: `node harness/drive.mjs --smoke --screenshot screenshot.png`
  (01 also needs `--base-url` of a local `./run.sh --site`).
- `EXAMPLES_REQUIRE` (comma list): a missing optional dependency prints `SKIP:` and exits 0 unless
  its key is named, then it fails. 01's keys: `wasm` (Node 20+, the pinned bundle, npm pins, NVL
  vendor bundle, gliner-rs build), `gliner` (small-v1 weights), `browser` (Playwright's Chromium;
  only that section skips). 02's and 03's keys: `wasm` (Node 20+, the pinned bundle, npm pins) and
  `browser`. 01's native section needs `relate` 1.2.0 on `PATH` and the matching binding, 02's and
  03's the binding; a different version fails at once. 02's model never runs in `run.sh` (no GPU in
  CI; its output is not byte-stable): its browser section uses `?llm=canned`. 03's embedding model never
  runs in `run.sh` either: the scripts' vectors are committed, and its browser section uses
  `?test=1`, which turns off animation, pacing and the model in the tab.

## Shared code (ADR-0008)

- `lib/relate_wasm.mjs`: ESM for Node and the browser. `find`/`check`/`loadNode(ver)` locate the
  bundle (`node_modules/@relate/relate-wasm`, or `RELATE_WASM_DIR`) and refuse it unless
  `dbms.components()` reports that version; `exec`/`script` refuse a null, undefined, NaN or missing
  top-level parameter (unless `{allowNull: true}`) and throw `RelateWasmError` with a `category`;
  `classify`, `version`, `isTrap`.
- `lib/ogs.mjs`: the Ontology Graph Spec 1.1 through its official SDK. It imports nothing:
  `createOgs({yaml, sdk})` takes each example's pinned js-yaml and SDK. It provides `parse` (js-yaml),
  `decode` (`GraphSpec.Json`; never the SDK's YAML decoder, which misreads plain YAML: Y1),
  `validate(doc, sets)` and `encode`. Also `isDraft`/`fromDraft`/`DRAFT_MAPPING` (example 01's
  earlier draft format, converted losslessly) and `layoutPoint`.
- `lib/serve.mjs`: an example's `dist/` served as GitHub Pages serves it (`start({example, …})`, or
  `node lib/serve.mjs --example <name>`); 01's `harness/serve.mjs --site` delegates to it.
- `lib/replay.mjs` and `lib/replay.py`: `dump`/`load`/`digest`/`content_digest` in one JSON format
  that both write byte for byte alike, graph types included. The JS side has its own parser: never
  pass a dump through `JSON.parse`/`JSON.stringify`/`postMessage` (send `canon(d)` text).
- `lib/opfsfmt.py` (stdlib) and its browser twin `examples/01-wasm-extract/web/opfs.js`: the strict
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
- **Citations.** Cite engine behaviours by the example's `NOTES.md` row ids (`R1`…), and decisions
  by this repository's ADRs (`ADR-0002`). `ADR-NNNN` always means `docs/adr/`. Never cite another
  repository's issue rows, ADRs (Relate's own included) or plan documents, and never cite a plan
  document of this repository either. Add a `NOTES.md` row instead, re-verified on 1.2.0, with a
  minimal repro, or an ADR.
- **Hosting is GitHub Pages only** (ADR-0002). No custom headers: every HTML page carries one CSP
  `<meta http-equiv>` in `<head>` before any script (no `frame-ancestors`, `report-uri`,
  `report-to`, `sandbox`), relative URLs only (no `"/x"` or `"//x"`), unchanging files under
  versioned `assets/<name>-<version>/`, and `.nojekyll`. `site/build.mjs` enforces this.
  `lib/serve.mjs` emulates Pages (base `/relate-examples/`, no custom headers, `max-age=600`, 301
  to the trailing slash, 404 otherwise); keep it faithful.
- **Per-origin names** (ADR-0003) carry the example's prefix (`ex01-…`/`ex02-…` stores and caches,
  `ex01.*` and `ex03.*` `localStorage` keys, `EX01_*`/`EX02_*`/`EX03_*` env vars): every example
  shares one origin. The one exception is a library's own fixed names, recorded in that example's
  NOTES.md (02's W1: WebLLM's `webllm/*` caches). 03's model cache is `ex03-models` (its T1).
- **Engine pins move together** (ADR-0005, ADR-0007). A Relate upgrade bumps `@relate/relate-wasm` (package.json and
  lockfile), `relate-db` (pyproject and `uv.lock`), `ci/relate-<ver>.sha256`, `RELATE_VERSION` in
  `examples.yml`, `ver` in each `run.sh`, `RELATE` in each `build.mjs` and worker (03's is in
  `web/memory.js`), `VERIFIED` in `lib/opfsfmt.py`, then every `NOTES.md` row is re-checked. The Ontology Graph Spec SDK is pinned in each example's package.json; 01's
  `web/ogs.js` `SDK_VERSION` and `build.mjs` `OGS_SDK_VERSION` move with it, and so does 01's vendored
  schema (`data/ontology-spec/`, from the SDK's release tag).
- **Third-party code** (ADR-0009): ship only what may be redistributed, with its licence under
  `assets/<name>-<version>/`. Fetch everything else at run time, at a pinned revision. Every new
  component goes into the example's `THIRD_PARTY.md` and its `site.json` `credits`. Example 03
  also ships Relate's logo, favicon and mascot (ADR-0015, its NOTES D9): they are trademarks, used
  as `data/brand/README.txt` says (never retype or recolour the logo), not under this repository's
  licence.
- **Example 03's vectors** (ADR-0017, 03's D3, T5): a scripted text (a memory, a recalled question,
  a `try` chip, a typed turn in `harness/typed.mjs`) needs its vector in `data/embeddings.json`.
  After changing one, run `node examples/03-wasm-agent-memory/harness/embed.mjs` (Playwright's
  Chromium; online the first time, for the model), then re-record `expected/`. Never edit the file
  by hand, and never compute it with the library's Node backend: its vectors differ from the tab's.
- **CI** (ADR-0018, `ci/README.md`): a pull request runs only the examples whose inputs it changed
  (`ci/changed-examples.sh`); a push to `main` runs all of them. A green pull request therefore
  says nothing about an example it did not touch: run that example's `run.sh` yourself when a
  change could reach it. A new shared input needs no change (an unknown path runs everything); to
  exempt a path, add it to the script and to `lib/tests/test_changed_examples.py`.
- Every change must pass offline. Don't commit or push unless asked.

## Relate 1.2.0 rules for code here (details and repros in 01's NOTES.md)

- **CLI grammar:** `relate [flags] -d DB 'Q'`; a piped script needs the verb,
  `relate query [flags] -d DB < script`; read-only is `relate --read-only -d DB 'Q'`; also
  `relate info -d DB`, `relate clone SRC DEST`. Pass the output mode explicitly (`--mode jsonl`,
  `--json`). Single-file bundles end in `.rl`.
- **WASM has no transactions** (R2, ADR-0006): every `execute` autocommits; write idempotent `MERGE`s and a
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
- **Search** (03's M3, M4): `SEARCH n IN (VECTOR INDEX … FOR $v LIMIT k) SCORE AS s` needs the
  `LIMIT`, scores `(1 + cosine) / 2` and returns k rows however poor the match, so filter on the
  score; a full-text `SEARCH` ORs whole words with no stemming and takes no `WHERE`.
- **Paths** (03's M7): a returned path carries every node whole, vectors included. Return
  `[n IN nodes(p) | id(n)]` when ids are all the caller needs.
- **Snapshots** (R22): a directory with only `graph.json` + `manifest.json` is adopted by a plain
  writable open (`mkdir db && tar -xf <store>.relate.tar -C db && relate -d db 'Q'`); a read-only
  open or `relate clone` refuses it until then; a directory with `wal/` but no markers is refused.
- Set `RELATE_MAX_ROWS=0` and `RELATE_AGENT_MODE=0` for any script that pipes CLI output: under an
  agent harness the CLI otherwise switches piped output to toon and caps it at 100 rows.
