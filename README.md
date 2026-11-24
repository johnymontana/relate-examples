# relate-examples

Runnable examples for [Relate](https://github.com/relatedb/relate), an embedded openCypher graph
database: one binary, and a database that is a directory, a single `.rl` file or `:memory:`. Every
example targets **Relate 1.2.0**: the `relate` CLI, the `relate-db` Python binding and the
`@relate/relate-wasm` npm package (the WebAssembly build). Each example runs offline and checks its
own output against committed `expected/` files.

Browser examples are also published as a static site on GitHub Pages:
<https://johnymontana.github.io/relate-examples/>. `pages.yml` deploys it after every push to `main`
that passes CI. Example 01 is live. Examples 02 and 03 go live with the first push that contains
them.

## Examples

| | Example | Live |
|---|---|---|
| 01 | [`examples/01-wasm-extract/`](examples/01-wasm-extract/): markdown to a knowledge graph entirely in a browser tab. An ontology (one of create-context-graph's 27 domains, or your own Ontology Graph Spec 1.1 document, read with the official SDK) decides what is legal, GLiNER2.5 (gliner-rs compiled to WebAssembly) scores every candidate, cutoffs you own sort them into keep, review or drop, and Relate's WASM build holds everything in the browser's OPFS. A read-only Cypher console, NVL graphs, and a download that native Relate opens. | <https://johnymontana.github.io/relate-examples/01-wasm-extract/> |
| 02 | [`examples/02-wasm-text2cypher/`](examples/02-wasm-text2cypher/): ontology-grounded Text2Cypher entirely in a browser tab. A language model on your own GPU (WebLLM, Qwen3.5 2B or 4B) writes two queries per question, one from a bare schema and one from an Ontology Graph Spec document's descriptions, vocabularies and cookbook. The ontology's static checks and Relate's planner vet them, and Relate's WASM build runs them on a graph held under a graph type derived from the same ontology; the page says what the ontology changed. Without WebGPU it uses reference queries. | <https://johnymontana.github.io/relate-examples/02-wasm-text2cypher/> |
| 03 | [`examples/03-wasm-agent-memory/`](examples/03-wasm-agent-memory/): the Relate playground as an agent's memory, in Relate's own brand. A scripted chat on one side, and on the other the memory it fills, drawn as a graph with NVL: the agent stores what it learns in Relate's WASM build, under a graph type that refuses a malformed memory, and recalls it in a later session with one statement that combines vector search, full-text search and graph hops. The page highlights the paths that statement returned. No model, nothing to download but the page; then type your own questions. | <https://johnymontana.github.io/relate-examples/03-wasm-agent-memory/> |

## Setup

macOS or Linux, with `curl`, [uv](https://docs.astral.sh/uv/), Node 20 or later and
[rustup](https://rustup.rs/).

```bash
curl -sSfL https://relatedb.ai/install.sh | bash   # the relate CLI; `relate --version`'s first line must be "Relate v1.2.0"
uv sync                                             # the project env: relate-db 1.2.0 and pytest (uv.lock)
rustup toolchain install 1.97.1 --profile minimal --target wasm32-unknown-unknown
scripts/build-gliner-wasm.sh                        # example 01: gliner-rs v0.3.1 built to WASM into .cache/gliner-wasm/
scripts/fetch-gliner.sh small                       # example 01: GLiNER2.5-small-v1 weights into .cache/gliner/ (304 MB)
(cd examples/01-wasm-extract && npm ci --omit=peer && npm run vendor && npx playwright install chromium)
(cd examples/02-wasm-text2cypher && npm ci --omit=peer)  # example 02: Relate WASM, WebLLM, the Ontology Graph Spec SDK, NVL
(cd examples/03-wasm-agent-memory && npm ci --omit=peer) # example 03: Relate WASM, NVL, the brand's two typefaces
```

An optional `.env` at the root is loaded by every `run.sh` (shell variables win over it); offline
runs need nothing from it.

## Running

```bash
uv run pytest -q                                    # lib/tests (run from the root)
examples/01-wasm-extract/run.sh                     # one example, offline, diffed against its expected/
examples/01-wasm-extract/run.sh --update            # accept an intended output change
examples/02-wasm-text2cypher/run.sh --llm-eval      # 02's models on your GPU (local only; never part of a run)
for r in examples/*/run.sh; do "$r"; done           # every example, as CI runs them
node site/build.mjs                                 # the Pages site into site/dist/
```

An example whose optional dependency is missing prints `SKIP: <reason>` with the fix and exits 0,
unless the comma list `EXAMPLES_REQUIRE` names that dependency's key (`wasm`, `gliner`,
`browser`), in which case it fails. Each example's README lists its keys and modes.

## CI and Pages

- [`.github/workflows/examples.yml`](.github/workflows/examples.yml), on every push and pull
  request: installs the pinned CLI and binding, builds or restores each example's dependencies, runs
  `uv run pytest -q` and every `examples/*/run.sh` with `EXAMPLES_REQUIRE=wasm,gliner,browser`.
- [`.github/workflows/pages.yml`](.github/workflows/pages.yml), once `examples.yml` has passed on a push to `main` (or on demand):
  builds `site/dist` and deploys it to GitHub Pages.

[ci/README.md](ci/README.md) explains each step and pin, and [site/README.md](site/README.md) is the
contract a browser example signs up to.

## Decisions and contributor guidance

- [`docs/adr/`](docs/adr/README.md): the architecture decision records. They cover:
  - static Pages hosting with no backend;
  - prefixed per-origin storage names;
  - byte-stable offline runs;
  - one Relate version everywhere;
  - idempotent writes;
  - the Ontology Graph Spec SDK;
  - the shared `lib/`;
  - what third-party code ships;
  - each example's own architecture.
- [`AGENTS.md`](AGENTS.md): the rules and commands for anyone changing the repository, human or
  agent. `CLAUDE.md` imports it for Claude Code.
- Each example's `NOTES.md` lists the engine and library behaviours it depends on, each with a
  minimal repro.

## Layout

| Path | What |
|---|---|
| `examples/NN-name/` | One example: `run.sh`, its code, `expected/`, a README, and `NOTES.md` for the Relate behaviours it depends on. |
| `lib/` | Shared helpers: `relate_wasm.mjs` (load and check the WASM bundle, run statements), `ogs.mjs` (the Ontology Graph Spec 1.1 through its official SDK, and the importer for example 01's earlier draft format), `serve.mjs` (serves an example's `dist/` as GitHub Pages does), `replay.mjs` and `replay.py` (engine-independent dump, load and digest), `opfsfmt.py` (the strict guard for a store exported from the browser), and `tests/`. |
| `scripts/` | `env.sh` (sourced by every `run.sh`), `build-gliner-wasm.sh`, `fetch-gliner.sh`. |
| `site/` | The Pages site's build and index page. |
| `docs/adr/` | Architecture decision records, with an index in its `README.md`. |
| `AGENTS.md`, `CLAUDE.md` | Guidance for coding agents. `CLAUDE.md` imports `AGENTS.md`. |
| `ci/` | Pinned sha256 files for the CLI and the GLiNER weights. |
| `.cache/` | Downloads and builds (gitignored). |
