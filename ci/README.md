# CI

Two workflows, both on `ubuntu-24.04`, with every action pinned by commit SHA (its version in a
comment). Both have run on GitHub since the first push (2026-11-23). `examples.yml` passed in 24–27
minutes, and `pages.yml` deployed example 01. Examples 02's and 03's steps run for the first time on
the push that adds them. The regression test they run is ADR-0004, and the pins are ADR-0005.

## `examples.yml`: tests and the examples

[`.github/workflows/examples.yml`](../.github/workflows/examples.yml) runs on every pull request,
on every push to `main` and on demand, with `EXAMPLES_REQUIRE=wasm,gliner,browser`, so a missing
dependency fails the run instead of printing `SKIP`.

### What runs when (ADR-0018)

| Started by | Examples run | Takes about |
|---|---|---|
| a push to `main`, or by hand (`workflow_dispatch`, on any branch) | every example | 19 minutes, 16.5 of them example 01 |
| a pull request that changes example 01, or anything shared | every example | 19 minutes |
| a pull request that changes only example 02 or 03 | that example | 3 minutes |
| a pull request that changes only docs, the site's page or `lib/tests/` | none; `pytest` only | 2 minutes |

The first two times are measured; the last two are estimates from the steps that remain, until
such a pull request has run.

A pull request's first step, "Which examples to run", gives the paths it changes to
[`ci/changed-examples.sh`](changed-examples.sh), which prints the examples to run: the example a
changed file belongs to, every example for a shared input (`lib/`, `scripts/`, the pins here,
`pyproject.toml`, `uv.lock`, the workflow, `site/build.mjs`) or for a path it does not know, and
none for a path no `run.sh` reads. The script's header has the full list and
`lib/tests/test_changed_examples.py` pins it. The steps below that only one example needs are
skipped with it: the gliner-rs build and the weights (01), each example's npm packages (02, 03),
and Chromium when no example runs. Example 01's npm packages are always installed, because
`lib/tests` reads the Relate WASM bundle from them. The job summary lists every example as run or
not run.

A push to a branch other than `main` starts nothing: a branch is tested through its pull request,
once per push instead of twice. To run every example on a branch, start the workflow by hand.

The workflow also sets `RELATE_TELEMETRY=off`, `RELATE_MAX_ROWS=0` and
`RELATE_AGENT_MODE=0` (as `scripts/env.sh` does), so the CLI's output never depends on who started
the run. No `.env` and no network beyond the downloads below.

1. **The relate CLI.** `relate-linux-amd64` from the public `v1.2.0` release, checked against
   `ci/relate-1.2.0.sha256`, installed on `PATH`, and its `--version` first line checked.
2. **The Python env.** `astral-sh/setup-uv` (uv 0.11.29, the version that wrote `uv.lock`; Python
   3.12), `uv sync --locked`, then a check that `relate.__version__` matches the CLI.
3. **Node 22** with npm's cache keyed on every example's `package-lock.json`
   (`examples/*/package-lock.json`).
4. **gliner-rs to WASM** (`scripts/build-gliner-wasm.sh`). The build in `.cache/gliner-wasm` and
   the tools in `.cache/wasm-tools` are cached, keyed on the gliner-rs revision and the script's
   hash. On a miss, Rust 1.97.1 with the `wasm32-unknown-unknown` target is installed (`dtolnay/rust-toolchain`
   pinned to the head of its `1.97.1` branch, whose `action.yml` fixes `toolchain: 1.97.1`) and the script
   builds; on a hit it only re-checks the cached build.
5. **The GLiNER2.5-small-v1 weights** (`scripts/fetch-gliner.sh small`), cached in `.cache/gliner`
   keyed on `ci/gliner2.5-*.sha256`; every file is re-hashed on each run.
6. **Example 01's npm packages** (`npm ci --omit=peer`, which installs `@relate/relate-wasm`
   pinned with its integrity in `package-lock.json`) and the NVL vendor bundle (`npm run vendor`).
7. **Playwright's Chromium**, the download cached, its system libraries installed on every run.
   All three examples pin the same Playwright (1.63.0), so one Chromium serves them all.
8. **Example 02's npm packages** (`npm ci --omit=peer`: `@relate/relate-wasm`, `@mlc-ai/web-llm`,
   `@neo4j/ontology-graph-spec`, NVL, js-yaml, esbuild and Playwright, each pinned with its integrity
   in its own `package-lock.json`). Its build bundles them itself. Its models never run in CI: no GPU,
   and its browser section drives the page in canned mode.
9. **Example 03's npm packages** (`npm ci --omit=peer`: `@relate/relate-wasm`, NVL, Transformers.js,
   the Public Sans and IBM Plex Mono font packages, esbuild and Playwright, each pinned with its
   integrity in its own `package-lock.json`). Its build bundles them itself. Its embedding model
   never runs in CI: the vectors of its scripted texts are committed (`data/embeddings.json`), and
   its browser section keeps the model in the tab off. The step sets `ONNXRUNTIME_NODE_INSTALL=skip`:
   Transformers.js depends on `onnxruntime-node`, which nothing here loads, and whose install
   script would otherwise fetch CUDA libraries on linux.
10. `uv run pytest -q`, `node examples/01-wasm-extract/harness/convert.mjs --check`, then the
   `run.sh` of each example this run needs ("What runs when"), with a per-example result table in
   the job summary; the job fails if any example fails.

The job has a 60-minute timeout. A cold cache adds the gliner-rs build, 304 MB of weights and
Chromium before example 01's own run, which takes about 10 minutes. Example 02 adds about a minute
and example 03 a few seconds.
The first two runs took 27 and 24 minutes. The linux CLI runs on ubuntu-24.04's glibc.

## `pages.yml`: the site

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) deploys only what CI passed: it is
triggered by `workflow_run` when `examples.yml` completes, and its build job runs only for a run whose
conclusion is `success`, whose event is `push` and whose branch is `main`; it checks out that run's
commit (`workflow_run.head_sha`), never a newer one. `workflow_dispatch` runs it by hand on the commit
it is started on. It builds gliner-rs (the same cache keys as `examples.yml`, so either workflow's build
serves the other), runs example 01's `npm ci --omit=peer` and `npm run vendor`, example 02's
`npm ci --omit=peer` and example 03's `npm ci --omit=peer`, then
`node site/build.mjs`, and uploads `site/dist` with `actions/upload-pages-artifact`
(`include-hidden-files`, so `.nojekyll` survives) for `actions/deploy-pages`. It needs no weights:
every example fetches its model from the Hugging Face Hub in the visitor's browser (example 03's only when the visitor types). Repository setting: Settings > Pages > Source:
GitHub Actions. See [site/README.md](../site/README.md).

## The pins in this directory

| File | What it pins |
|---|---|
| `relate-1.2.0.sha256` | The v1.2.0 release's own SHA256SUMS, every platform's CLI (CI uses `relate-linux-amd64`). |
| `changed-examples.sh` | Not a pin: which examples a pull request's changes need run (above). |
| `gliner2.5-small-v1.sha256`, `gliner2.5-base-v1.sha256` | Every file of the GLiNER2.5 weights at the pinned Hugging Face revisions, read by `scripts/fetch-gliner.sh` and embedded into example 01's page by its build. |

Some pins live elsewhere:
- the Relate WASM bundle: its integrity is in each browser example's `package-lock.json`;
- the `relate-db` binding: `uv.lock`;
- the gliner-rs `.wasm`: its bytes differ by build host, so example 01's `expected/model.txt` pins
  its behaviour instead.

A Relate upgrade bumps `ci/relate-<ver>.sha256`, `RELATE_VERSION` in `examples.yml`, `relate-db` in
`pyproject.toml` and `uv.lock`, and `@relate/relate-wasm` in every browser example, all together
(ADR-0005; the full list is in AGENTS.md, "Engine pins move together").
