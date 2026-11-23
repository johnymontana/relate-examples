# relate-examples

Runnable examples for [Relate](https://github.com/relatedb/relate), an embedded openCypher graph
database: one binary, and a database that is a directory, a single `.rl` file or `:memory:`. Every
example targets **Relate 1.2.0**: the `relate` CLI, the `relate-db` Python binding and the
`@relate/relate-wasm` npm package (the WebAssembly build). Each example runs offline and checks its
own output against committed `expected/` files.

Browser examples are also published as a static site on GitHub Pages:
<https://johnymontana.github.io/relate-examples/>. It goes live once the repository is pushed and
Pages is enabled with "GitHub Actions" as its source (Settings > Pages).

## Examples

| | Example | Live |
|---|---|---|
| 01 | [`examples/01-wasm-extract/`](examples/01-wasm-extract/): markdown to a knowledge graph entirely in a browser tab. An ontology (one of create-context-graph's 27 domains, or your own Ontology Graph Spec v1 document) decides what is legal, GLiNER2.5 (gliner-rs compiled to WebAssembly) scores every candidate, cutoffs you own sort them into keep, review or drop, and Relate's WASM build holds everything in the browser's OPFS. A read-only Cypher console, NVL graphs, and a download that native Relate opens. | <https://johnymontana.github.io/relate-examples/01-wasm-extract/> |

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
```

An optional `.env` at the root is loaded by every `run.sh` (shell variables win over it); offline
runs need nothing from it.

## Running

```bash
uv run pytest -q                                    # lib/tests (run from the root)
examples/01-wasm-extract/run.sh                     # one example, offline, diffed against its expected/
examples/01-wasm-extract/run.sh --update            # accept an intended output change
for r in examples/*/run.sh; do "$r"; done           # every example, as CI runs them
node site/build.mjs                                 # the Pages site into site/dist/
```

An example whose optional dependency is missing prints `SKIP: <reason>` with the fix and exits 0,
unless the comma list `EXAMPLES_REQUIRE` names that dependency's key (`wasm`, `gliner`,
`browser`), in which case it fails. Each example's README lists its keys and modes.

## CI and Pages

- [`.github/workflows/examples.yml`](.github/workflows/examples.yml), on every push and pull
  request: installs the pinned CLI and binding, builds or restores example 01's dependencies, runs
  `uv run pytest -q` and every `examples/*/run.sh` with `EXAMPLES_REQUIRE=wasm,gliner,browser`.
- [`.github/workflows/pages.yml`](.github/workflows/pages.yml), once `examples.yml` has passed on a push to `main` (or on demand):
  builds `site/dist` and deploys it to GitHub Pages.

[ci/README.md](ci/README.md) explains each step and pin; [site/README.md](site/README.md) is the
contract a browser example signs up to.

## Layout

| Path | What |
|---|---|
| `examples/NN-name/` | One example: `run.sh`, its code, `expected/`, a README, and `NOTES.md` for the Relate behaviours it depends on. |
| `lib/` | Shared helpers: `relate_wasm.mjs` (load and check the WASM bundle, run statements), `replay.mjs` and `replay.py` (engine-independent dump, load and digest), `opfsfmt.py` (the strict guard for a store exported from the browser), and `tests/`. |
| `scripts/` | `env.sh` (sourced by every `run.sh`), `build-gliner-wasm.sh`, `fetch-gliner.sh`. |
| `site/` | The Pages site's build and index page. |
| `ci/` | Pinned sha256 files for the CLI and the GLiNER weights. |
| `.cache/` | Downloads and builds (gitignored). |
