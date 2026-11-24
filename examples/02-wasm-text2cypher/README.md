# 02 · Ontology-grounded Text2Cypher in a browser tab: Relate WASM, WebLLM and the Ontology Graph Spec

Ask a question in English and watch two Cypher queries get written for it:
- one from a bare schema (labels, relationship types, property names);
- one from an [Ontology Graph Spec](https://neo4j.com/docs/ontology-graph-spec/) document's
  descriptions, `one_of` vocabularies, judgment-property guidance and query cookbook.

Both are checked, run on the same knowledge graph, and compared. Nothing runs on a server.

- **The model** runs on your GPU through [WebLLM](https://github.com/mlc-ai/web-llm): Qwen3.5 2B by
  default, or Qwen3.5 4B. It is downloaded once from the Hugging Face Hub and cached by the browser.
  Without WebGPU, the page answers with the source app's reference queries, and everything else runs
  the same.
- **The ontology** (`data/corporate-events.ontology.yaml`) is read with the official Ontology Graph
  Spec SDK, npm `@neo4j/ontology-graph-spec`, through [`lib/ogs.mjs`](../../lib/ogs.mjs), shared with
  example 01. It produces the prompt, the static checks, and the store's schema.
- **Relate 1.2.0**, compiled to WebAssembly (npm `@relate/relate-wasm`), holds the graph in the tab.
  It enforces a graph type derived from the same ontology (endpoints and typed properties on every
  write), plus the ontology's constraints and indexes. It plans each generated query (`EXPLAIN`)
  before running it.

This example ports the repository owner's ontospec-knowledge-graph-extraction web app (FastAPI,
OpenAI, Neo4j or a toy in-memory evaluator) to a static page. The prompts, validator, DDL,
comparison, reference queries and demo graph come over unchanged; the harness holds the JavaScript
ports to the Python byte for byte.

Live: <https://johnymontana.github.io/relate-examples/02-wasm-text2cypher/> (deployed by the first
push to `main` that contains this example and passes CI).

The ids cited below are defined in [NOTES.md](NOTES.md):
- `P1`…: the Relate 1.2.0 behaviours this example pins;
- `Y`/`W`: the SDK's and WebLLM's behaviours;
- `D1`…: its design decisions.

The larger decisions are ADRs in [`docs/adr/`](../../docs/adr/README.md):
- this example's own:
  - ADR-0011: a port held to the source;
  - ADR-0012: WebLLM with a canned fallback;
  - ADR-0013: an in-memory store under the ontology's graph type;
- the repository's, which it follows: ADR-0002 to ADR-0009.

```bash
./run.sh              # offline, about a minute: Node, then Chromium (canned mode), then native Relate; diffed against expected/
./run.sh --site       # build dist/ and serve it at http://127.0.0.1:8702/relate-examples/02-wasm-text2cypher/ as Pages would
./run.sh --llm-eval   # both models on the page's questions in your system Chrome (WebGPU; downloads 3.5 GB once); never diffed
./run.sh --update     # accept this run's output as expected/
```

## Using the page

| Panel | What it does |
|---|---|
| Ontology | **Browser**: every node with its description, properties (type, flags, vocabularies), constraints and indexes, every relationship with its endpoints and cardinality, and the query cookbook from `extensions.custom`. **JSON document**: the document as the SDK read it. **Checks**: the SDK's verdict per validation set (the page needs `decode` and `core` clean), and the graph type Relate enforces (`SHOW CURRENT GRAPH TYPE`). |
| Knowledge graph | The demo graph (38 nodes, 43 relationships) drawn with NVL. Asserted edges are green, rumoured, denied and forward-looking ones orange. Clicking shows a node's properties or an edge's assertion, support probability and evidence. **Ontology (metamodel)** draws the ontology itself. |
| Model | Whether this browser has a usable WebGPU (with 16-bit shaders), the two models with size and licence, **Load model**, a progress bar, and **canned answers** to switch back to the reference queries. **repair once** (off by default) sends a refused or failed query back to the model once, with the check's issues or Relate's error, for both variants alike (D7). A model already in the browser's cache loads by itself. |
| Ask | A question (or one of the 11 suggested ones). **Generate & run** writes the ontology-grounded query first and shows it checked and run, then writes the bare one, then lists what the ontology changed. **What the model reads** shows both prompts. **Run your own Cypher** puts any query through the same checks on the same store. |

URL parameters: `?llm=canned` (the reference queries only; CI's mode), `?model=<id>`
(`Qwen3.5-2B-q4f16_1-MLC` or `Qwen3.5-4B-q4f16_1-MLC`).

## From the server app to the page

| The source app (server) | Here (in the tab) |
|---|---|
| `GET /api/ontology`, `/api/ontology/raw`: PyYAML plus a JSON Schema check | `lib/ogs.mjs`: js-yaml, then the SDK's `GraphSpec.Json` decode and its validation sets (`web/ontology.js`) |
| `text2cypher.build_schema_prompt` (grounded and bare) | `web/briefing.js`, byte for byte (`briefing.txt`) |
| one OpenAI call per variant (gpt-4o-mini) | WebLLM in a worker (`web/llm.worker.js`), the briefing as the system message, the reply constrained to `{"cypher": …}` by JSON-schema decoding (W2); or the canned reference queries |
| `validate_cypher`: read-only, known labels and types, legal endpoints | `web/validate.js`, byte for byte (`validate.txt`), plus Relate's `EXPLAIN` notifications (P5) |
| Neo4j via the Python driver, or `demo_graph.run`, a toy evaluator of one query shape | Relate 1.2.0 WASM in a worker (`web/engine.worker.js`), real Cypher: every query shape runs |
| `cypher.all_statements` applied to Neo4j by `load_demo.py` | `web/ddl.js`: a graph type derived from the ontology (P1, P3, P4), then the same DDL (`ddl.cypher`), then the graph (`web/load.js`) |
| `main._compare` | `web/compare.js`, byte for byte |
| the page's `/api/*` calls | `web/app.js`, which calls the modules directly |

`harness/capture_reference.py` captured the Python's outputs once into `data/reference/`
(data/SOURCE.md). `harness/run.mjs` fails a run whose port stops reproducing them.

## How a generated query is checked

`web/run.js` `runVariant` runs every query the same way, whether the model wrote it, it was canned,
or you typed it. The engine worker and the Node harness call the same function.

1. **The ontology check** (`web/validate.js`, the source app's rules): no write clause, only labels
   and relationship types the ontology declares, and each relationship between the endpoints it
   allows. A query that fails is shown with its reasons and not run.
2. **Relate plans it** (`EXPLAIN`). A query Relate cannot plan (a syntax error) is not run. Unknown
   labels, relationship types or property keys come back as advisory notes ("Relate: unknown
   property key"); they do not block, since a property the ontology declares but the demo data
   lacks is still a fair question (P5).
3. **Relate runs it** on the in-memory store. A write that got past step 1 would move the result's
   counters (P7): the store is then rebuilt from the demo graph, and the report says so. (A
   read-only in-memory handle cannot be loaded first, P6.)

## The ontology and the store

The page needs the SDK's `decode` and `core` clean. It shows the other validation sets for
information:
- `consistentSchema` reports 66 issues. In 65 of them a property lacks an explicit database `name`.
  The other is the existence constraint on `Company.name`, which the SDK reports as conflicting with
  a composite constraint on `Company`.
- `mappable` checks the import mappings, and reports 9 issues.

`web/ddl.js` turns the ontology into the store's schema, applied in this order (`ddl.cypher`):

1. **A graph type** (`ALTER CURRENT GRAPH TYPE SET`). Every node label comes with its declared
   properties and their types, `NOT NULL` for `key` and `must_exist`. Every relationship type comes
   with its one source and one target label and its typed properties. The spec's tokens map onto
   Relate's: `LIST<STRING>` becomes `LIST<STRING NOT NULL>`, and a `VECTOR<FLOAT32>` with
   `dimension: 1536` becomes `VECTOR<FLOAT32>(1536)` (P4).

   The graph type has to come first. It owns the existence constraints on its labels (P1), and an
   ALTER drops the constraints already there (P2).
2. **The source app's DDL**, unchanged: node keys, existence and uniqueness constraints, a
   composite unique constraint, a FULLTEXT index and a VECTOR index.
3. **The demo graph**, with the source app's `MERGE` statements. Dynamic labels and types are used,
   and `toFloat()` keeps `supported` a FLOAT (P8).

The engine then refuses every write the ontology forbids: an edge from a Product to a Person typed
`CEO_OF`, a number in a STRING property, a node without its `name` (P3). Native Relate refuses the
same (`native.txt`).

The store is in memory and rebuilt on every visit, in milliseconds (D2): no OPFS, no locks between
tabs, nothing to migrate.

## The models

| | Qwen3.5 2B (default) | Qwen3.5 4B |
|---|---|---|
| WebLLM model | `Qwen3.5-2B-q4f16_1-MLC` | `Qwen3.5-4B-q4f16_1-MLC` |
| weights | `mlc-ai/Qwen3.5-2B-q4f16_1-MLC` at `dd74e9c`, 1.08 GB | `mlc-ai/Qwen3.5-4B-q4f16_1-MLC` at `44b4246`, 2.39 GB |
| GPU memory (WebLLM's figure at 4k context; the page uses 8k) | about 2.2 GB | about 3.9 GB |
| licence | Apache-2.0 | Apache-2.0 |

`web/llm.js` pins everything WebLLM fetches:
- the weights at a Hugging Face commit;
- the WebGPU model library at a commit of `mlc-ai/binary-mlc-llm-libs`;
- SRI hashes for the library, the chat config and the tokenizer, which WebLLM checks (W3).

The context window is raised to 8192 tokens, because the grounded briefing is about 3k. Thinking is
off. Temperature is 0. Weights stay in the browser's cache under WebLLM's own names (W1); the page
asks for persistent storage.

**Why these two** (D5):
- Both are Apache-2.0, and WebLLM ships prebuilt libraries for them.
- Qwen2.5-Coder-3B was left out because its licence is not Apache-2.0.
- Neo4j's Text2Cypher fine-tune of Gemma 3 exists only as a community GGUF, which WebLLM cannot load.

**Without WebGPU**, the page uses the source app's canned reference queries (D4). That covers older
Safari, Firefox on Linux, many Linux Chrome setups, and a GPU without 16-bit shaders. The checks,
Relate and the comparison run as they would with a model.

## How well the models do

Measured with `harness/llm-eval.mjs` on 2026-11-23, on an Apple M4 Max (64 GB, Metal) in Chrome
through WebGPU. These are not in `expected/`: another GPU, driver or browser can give other numbers
(W4). There are 11 questions; each answer is scored against a reference query (below).

| | grounded: passes the check / runs / covers the reference | bare: passes / runs / covers | seconds per query (grounded, bare) |
|---|---|---|---|
| Qwen3.5 2B | 11 / 8 / 4 | 9 / 2 / 2 | 5.0, 2.7 |
| Qwen3.5 2B, repair once | 11 / 9 / 5 | 9 / 2 / 2 | 6.2, 5.6 |
| Qwen3.5 4B | 11 / 11 / 7 | 11 / 11 / 4 | 11.2, 2.5 |
| Qwen3.5 4B, repair once | 11 / 11 / 7 | 11 / 11 / 4 | 9.8, 2.2 |

How the scoring works:
- **Covers the reference** means as many rows as the reference query, with each reference row's
  values found in a row of its own. Extra columns are allowed.
- **The reference** is the ontology's cookbook query for the six cookbook questions, an exact
  answer. The grounded prompt shows the cookbook as examples, so those six are the easy case.
- For the other five questions, the reference is the canned entry the question routes to by
  keyword. Those entries are often broader than the question: "Who supplies Halcyon?" routes to
  every asserted supply edge. A correct, narrower query therefore does not cover them, and the
  numbers on those five understate both models.
- Loading a cached model takes 5 s (2B) or 10 s (4B). The first download takes minutes.

What the numbers show:
- **The 4B model** answers all six cookbook questions with exactly the reference rows. Every one of
  its queries, grounded or bare, passes the check and runs. The bare ones run but leave out what
  the ontology adds, as the comparison panel shows: the assertion and support filters, and the
  alias match.
- **The 2B model** writes grounded queries that all pass the ontology check. Three of the eleven
  fail in Relate. Two use a variable they never bound (a filter on `r`, or a `p` that only appears
  in a pattern predicate). One returns `r.evidence` twice, a column-name conflict. "Repair once"
  fixes that third one. Its bare queries are mostly not Cypher at all (SQL-style
  subqueries, `p:name` for `p.name`), which is the source app's argument made by a small model.
- Both prompts lean on the model's general Cypher. On this graph the 4B model is the reliable
  choice, at about 2.2 GB more download and twice the time per query.

The full queries, with every check's issues and Relate's errors, are in
`out/llm/<model>[-repair].txt` after a run.

## Setup

From the repository root, the shared setup (README.md): `uv sync` (the `relate-db` 1.2.0 binding,
for the native section). Then:

```bash
cd examples/02-wasm-text2cypher
npm ci --omit=peer                 # exact pins: @relate/relate-wasm 1.2.0, @mlc-ai/web-llm 0.2.89, @neo4j/ontology-graph-spec 0.12.2, NVL 2.0.0, js-yaml 4.3.2
npx playwright install chromium    # Playwright 1.63.0's Chromium, for the browser section (the same as example 01's)
./run.sh
```

- **Pins.**
  - The Relate WASM bundle is pinned by its npm integrity in `package-lock.json`, and
    `lib/relate_wasm.mjs` refuses one that does not report 1.2.0.
  - Every other package is pinned exactly in `package.json` and by integrity in the lockfile.
  - The models are pinned by revision and SRI hash (`web/llm.js`).
- **A new Relate release** moves with the repository's other pins (ADR-0005; AGENTS.md, "Engine
  pins move together"). Re-run `./run.sh` and re-check every NOTES.md row.
- **Node** 20 or later.

## `run.sh`

| Mode | Does |
|---|---|
| *(none)* | Offline: the Node sections, then the browser section, then the native section; diffs `out/` against `expected/`. |
| `--update` | Rewrites `expected/` from this run. Read the diff first. |
| `--site` | `npm run build`, then serves `dist/` at `/relate-examples/02-wasm-text2cypher/` as GitHub Pages does (`lib/serve.mjs`; `EX02_PORT`, default 8702). |
| `--llm-eval` | `npm run build`, then `harness/llm-eval.mjs --model all` in the system Chrome. Prints a summary and writes `out/llm/<model>.txt`; never diffed. |

**`EXAMPLES_REQUIRE` keys.** Without a key, a missing piece prints `SKIP:` with the fix and exits 0.
When `EXAMPLES_REQUIRE` names the key, it fails instead (CI names both).

| Key | Needs | Without it |
|---|---|---|
| `wasm` | Node 20+, the Relate bundle reporting 1.2.0, every npm package at its pin | the whole example SKIPs |
| `browser` | Playwright's Chromium | the browser section is skipped (a note on stderr) |

The native section needs the project env's `relate-db` 1.2.0 (`uv sync`); another version fails.

### What the run checks

| File | From | What |
|---|---|---|
| `ontology.txt` | `harness/run.mjs` | The SDK on the ontology: decode, issues per validation set, the core issues (none), the legal relationships. |
| `briefing.txt` | `harness/run.mjs` | Both prompts, each equal to the Python's (`data/reference/`). |
| `ddl.cypher` | `harness/run.mjs` | The graph type, then the DDL, equal to the Python's. |
| `queries.txt` | `harness/run.mjs` | The store built as the page builds it, the graph type read back, constraints and indexes. Every canned query (both variants, with the A/B notes), the fallback and the cookbook run through `web/run.js`; which canned entry each suggested question takes. |
| `validate.txt` | `harness/run.mjs` | The validator on 17 cases and `compare` on 3, each equal to the Python's; `parseReply` on five reply shapes (W5); Relate's `EXPLAIN` notes. |
| `probes.txt` | `harness/run.mjs` | P1–P9, each a minimal repro on Relate 1.2.0 WASM. |
| `browser.txt` | `harness/drive.mjs` | The page in headless Chromium against `dist/` at the Pages sub-path, with its production CSP: boot, the SDK's checks, NVL, every suggested question (its rows equal the Node section's), the Ask button, the own-query box (a read, a blocked write, a syntax error, an unknown property), the no-WebGPU fallback, and no console errors or CSP violations. |
| `native.txt` | `harness/native.py` | The same store built by native Relate 1.2.0 (the graph type refusing the same bad edge), and all 32 queries returning the same rows as WASM. |

## Testing the model

The models never run in `run.sh` or CI (D4). CI has no GPU: Playwright's Chromium gets SwiftShader,
without 16-bit shaders (W4). And a model's output depends on the GPU, so it could not be diffed
anyway. CI therefore tests everything around the model: the prompts are the source app's byte for
byte, every query path goes through the same checks, and the page falls back as designed.

`harness/llm-eval.mjs` (`./run.sh --llm-eval`) measures the models locally:
- It drives the system Chrome, which reaches the real GPU even headless.
- It keeps a persistent profile in `.cache/ex02-chrome/` and serves on a fixed port (8712), because
  the browser's caches are per origin.
- Each model downloads once.
- It asks the 11 suggested questions (the ontology's 6 cookbook questions are among them) exactly
  as the Ask button does, and scores each query against the canned reference: valid (passes the
  ontology check), ran (Relate planned and ran it), and the same rows (values compared; column names
  and order ignored).

## The GitHub Pages site

`dist/` follows the site contract (site/README.md, ADR-0002):
- One CSP `<meta>`: `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`, and
  `connect-src 'self' https://huggingface.co https://*.hf.co https://raw.githubusercontent.com` (the
  weights, and the pinned model libraries).
- Relative URLs only.
- Every dependency in a versioned `assets/<name>-<version>/` directory:
  - `relate-1.2.0`;
  - `web-llm-0.2.89`, 5.9 MB minified;
  - `ontology-graph-spec-0.12.2`, 0.6 MB;
  - `nvl-2.0.0`;
  - `js-yaml-4.3.2`.

`build.mjs` bundles the page and its two workers with esbuild, keeping those packages external, so a
code change never invalidates the 13 MB of versioned assets.

A module worker runs with no CSP of its own, because Pages sends no headers. The LLM worker fetches
the weights and libraries itself, so `connect-src` is what the page declares, not an enforced limit
on the worker. The origin is shared with every other Pages site of the account (example 01's
NOTES.md, "Changes the port made"): keep nothing private in it.

## Browser support

Everything except the model needs a current browser with module workers and WebAssembly; the
browser section runs it in Chromium.

The model needs WebGPU with `shader-f16`: Chrome or Edge on desktop (Windows, macOS, ChromeOS; Linux
on some GPUs), Safari 26, or Firefox on Windows or macOS. It also needs about 1.1 GB (2B) or 2.4 GB
(4B) of free site storage, and 3–5 GB of GPU memory at the 8k context.

## Credits and licences

[THIRD_PARTY.md](THIRD_PARTY.md) has every component. In short:
- Relate 1.2.0 (Apache-2.0).
- WebLLM 0.2.89 (Apache-2.0).
- Qwen3.5 2B and 4B (Apache-2.0), fetched from the Hugging Face Hub.
- The Ontology Graph Spec SDK 0.12.2 and its Kotlin runtime (Apache-2.0).
- NVL 2.0.0 (proprietary, used with Neo4j's permission).
- js-yaml 4.3.2 (MIT).
- The ontology, demo graph and reference queries: the repository owner's own project (data/SOURCE.md).

## Files

| Path | What |
|---|---|
| `web/` | the page: `index.html`, `style.css`, `app.js`. The workers: `engine.worker.js` (Relate) and `llm.worker.js` (WebLLM). The modules: `ontology.js`, `briefing.js`, `validate.js`, `ddl.js`, `load.js`, `run.js`, `canned.js`, `compare.js`, `llm.js` and `py.js` (Python's semantics the ports need). `vendor-entry.mjs` is NVL's bundle entry. |
| `data/` | the ontology, the demo graph, the canned answers, `reference/` (the Python's outputs) and `SOURCE.md` |
| `harness/` | `run.mjs` (the Node sections), `drive.mjs` (Chromium; `--smoke`, and `--smoke --screenshot screenshot.png` retakes the picture on the Pages index), `native.py`, `llm-eval.mjs` (local, WebGPU), `capture_reference.py` (by hand, against the source) |
| `build.mjs`, `site.json`, `run.sh` | the static site, its entry in the Pages site, the regression run |
| `expected/` | what `run.sh` diffs against |
| [`../../lib/ogs.mjs`](../../lib/ogs.mjs), [`../../lib/serve.mjs`](../../lib/serve.mjs), [`../../lib/relate_wasm.mjs`](../../lib/relate_wasm.mjs) | shared with example 01: the Ontology Graph Spec through the SDK, the Pages emulator, the Relate WASM helpers |
