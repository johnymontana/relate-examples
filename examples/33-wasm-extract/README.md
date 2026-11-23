# 33 · Markdown to a knowledge graph in a browser tab: GLiNER2.5, Relate WASM and NVL

Paste or load a markdown document and get a knowledge graph back, with nothing running on a server.
The model, the database and the page all live in one browser tab.

- An **ontology** decides which kinds of entity and which links are legal: one of
  [create-context-graph](https://github.com/neo4j-labs/create-context-graph)'s 27 domain ontologies
  (each with a synthetic sample document; the page opens on Financial Services), or one you write.
  Every ontology is a [Neo4j Ontology Graph Specification v1](https://github.com/neo4j/graph-spec)
  document.
- **GLiNER2.5** scores every candidate entity and relation, through
  [gliner-rs](https://github.com/apiplant/gliner-rs) compiled to WebAssembly.
- **Cutoffs you own** sort each answer into keep, review or drop. The approach (an ontology, a
  probability for every answer, keep/review/drop cutoffs), the sentence splitter and the name rules
  come from [edgextract](https://github.com/raphaelmansuy/edgextract), ported to JavaScript.
- **Relate 1.2.0**, compiled to WebAssembly (npm `@relate/relate-wasm`) and persisted in the
  browser's OPFS, holds all of it: the ontology with a graph type derived from it that the engine
  enforces, the inference cache, every candidate with its score, the gate and its review queue, and
  the extracted knowledge graph, accumulated across documents.
- A **Cypher console** queries the live store through a read-only handle, **NVL** (the Neo4j
  Visualization Library) draws the graphs, and the database **downloads** as a snapshot that native
  Relate opens.

Live: <https://johnymontana.github.io/relate-examples/33-wasm-extract/> (once the repository is
pushed and GitHub Pages is enabled with "GitHub Actions" as its source).

The ids cited below are defined in [NOTES.md](NOTES.md): `R1`… are the Relate 1.2.0 behaviours the
example depends on or pins (each with a minimal repro), and the D, E, G, O, V and X ids are the
example's design decisions and findings.

```bash
./run.sh              # offline, about 8-10 minutes: Node, then Chromium, then native Relate; diffed against expected/
./run.sh --site       # build dist/ and serve it at http://127.0.0.1:8733/relate-examples/33-wasm-extract/ as Pages would
./run.sh --update     # accept this run's output as expected/
```

## Using the page

Three numbered steps on the left, six tabs on the right.

| Step | What it does |
|---|---|
| 1 Domain | Picks one of the 27 bundled ontologies. Each has its own store, `opfs://ex33-kg-<slug>` (D14), and its sample goes into the Document box. |
| 2 Model | GLiNER2.5-small-v1 (the default, 304 MB once) or base-v1 (783 MB). The weights download from the Hugging Face Hub, are checked against pinned sha256s, and are cached in the browser; a cached model loads by itself and is hashed again on every load. |
| 3 Extract | Extracts the sample, a loaded `.md`/`.txt` file (up to 2 MB) or pasted text, section by section, showing each model call. **Stop** and **Continue** work between sections. When the store already holds a document with the same title and other text, it asks: **Replace it**, **Keep both** or **Cancel**. |

| Tab | What it does |
|---|---|
| Graph | The typed knowledge graph in NVL, for this document or all of them, coloured by kind. Review candidates are drawn faded (toggle **Show review candidates**). Clicking an entity shows its kind, the sentences behind it with the words marked, the rule that kept it, and the ontology's tools on its kind; clicking a review candidate offers **Accept** / **Reject**. |
| Review | Claims and mentions in the review band, each with one sentence on why it is there. Verdicts survive re-gating and re-extraction; the latest one wins. |
| Ontology | The ontology as a picture (kinds as nodes, links between the kinds they may join) and its v1 document in an editor, validated live. Paste or load a v1 document (YAML or JSON) or a create-context-graph file (converted to v1), then **Apply**. When existing data breaks the new graph type, **Rebuild the graph with it** appears. A store whose document differs from the bundled one of the same id offers **Re-apply the bundled one**. |
| Cutoffs | Keep/drop cutoffs per kind and per link, and the type, relation and pole margins. Each change re-runs the gate in Cypher over the stored candidates; the model is never called again. A pair you move is marked **set by you**; **Reset to the defaults** undoes that. |
| Console | Cypher against the live store, read-only, with the saved queries from `queries/`, a field per `$parameter`, results as a table (first 1,000 rows) and as an NVL graph (at most 1,000 nodes and 3,000 relationships). **Hide the example's bookkeeping** leaves out the extraction's own records. **Ontology tools** lists and runs the ontology's example queries. A query still running after 10 s is stopped. |
| Store | Every store in this browser, storage use, the documents in the open store (each with **Forget**), **Download database (.relate.tar)**, **Download dump.json**, restore from a `.tar`, the native commands for the download, and **Empty this store**. |

Banners: **Lock** (another tab holds the store; **Move it to this tab** hands it over through a
`BroadcastChannel`), **Crash** (the engine worker died; the page restarts it and reopens the store),
**Earlier build** (a store an earlier build of this page wrote in a layout this one cannot read; the
banner offers to empty or delete it) and **Capability** (the browser lacks OPFS sync access handles
in workers).

Development URL parameters: `?models=local` (weights from `./models/`, which `harness/serve.mjs`
maps to `.cache/gliner/`), `?test=1` (the deterministic `d3Force` layout, V6), `?watchdog=<ms>` (the
console's 10 s watchdog), `?recycle=<n>` (recycle the engine after n extractions instead of 10).

## Setup

From the repository root:

```bash
curl -sSfL https://relatedb.ai/install.sh | bash   # the relate CLI (native section); `relate --version` must say v1.2.0
uv sync                                             # the project env: relate-db 1.2.0 (the Python binding) and pytest
rustup toolchain install 1.97.1 --profile minimal --target wasm32-unknown-unknown
scripts/build-gliner-wasm.sh                        # gliner-rs v0.3.1 (4fa741e) built to WASM into .cache/gliner-wasm/
scripts/fetch-gliner.sh small                       # GLiNER2.5-small-v1 @ 7132dc4 into .cache/gliner/, checked against ci/gliner2.5-small-v1.sha256
cd examples/33-wasm-extract
npm ci --omit=peer                                  # exact pins, @relate/relate-wasm 1.2.0 among them; --omit=peer skips NVL's unused neo4j-driver peer
npm run vendor                                      # esbuild: NVL into web/vendor/ (gitignored), with the metafiles build.mjs reads for licence notices
npx playwright install chromium                     # Playwright 1.63.0's Chromium, for the browser section
./run.sh
```

- `build-gliner-wasm.sh` installs wasm-pack 0.15.0 (when `PATH` has no such version) and
  wasm-bindgen-cli 0.2.128 into `.cache/wasm-tools/` with `cargo install --locked`. It needs the
  network once; `--check` verifies a cached build without building, `--force` rebuilds.
- `fetch-gliner.sh base` fetches base-v1 (for `--model base`); `--check` verifies the cache offline.
- **Pins.** The Relate WASM bundle is pinned by its npm integrity in `package-lock.json`, and
  `lib/relate_wasm.mjs` also refuses a bundle whose `dbms.components()` does not report Relate
  1.2.0 (R1). The weights are pinned by sha256. The gliner-rs `.wasm` differs by build host, so its
  behaviour is pinned instead (`model.txt`).
- **A new Relate release.** Bump `@relate/relate-wasm` (`package.json` and `package-lock.json`),
  `relate-db` in `pyproject.toml`, `ci/relate-<ver>.sha256` and `RELATE_VERSION` in
  `.github/workflows/examples.yml`, `ver` in `run.sh` and `VERIFIED` in `lib/opfsfmt.py` together,
  then re-run the probes and re-check every NOTES.md row.
- **Node** 20 or later (CI uses 22).
- **Time and memory.** The Node pipeline asks gliner-rs about 1,000 questions. `harness/infer.mjs`
  asks them all first on up to 6 worker threads, each holding the model (about 700 MB of WASM
  memory); `EX33_INFER_THREADS` sets the count. Keep a laptop awake for a full run
  (`caffeinate -i ./run.sh` on macOS). Never run two `run.sh` in this directory at once: each starts
  by deleting `out/` and `work/`.

## `run.sh`

| Mode | Does |
|---|---|
| *(none)* | Offline: the Node sections, then the browser section, then the native section; diffs `out/` against `expected/`. |
| `--update` | Rewrites `expected/` with the files of the sections that ran. Read the diff first. |
| `--reference` | Re-records `data/reference/gliner2-small.json` (the fixture `model.txt` holds gliner-rs to) through Python `gliner2` 2.0.0 on torch, in a pinned uv env under `.cache/gliner-ref-env/`; needs python3, uv and the small weights, not Node. `--reference --check` records afresh and compares, writing nothing. |
| `--model base` | The samples on GLiNER2.5-base-v1, printed into `out/base/`, never diffed. |
| `--serve` | Development: serves `web/` in `dist/`'s URL layout with imports rewritten as the build rewrites them. |
| `--site` | `npm run build`, then serves `dist/` at `/relate-examples/33-wasm-extract/` as GitHub Pages does (below). |

`--serve` and `--site` listen on `EX33_PORT` (default 8733; 0 picks a free port).

**`EXAMPLES_REQUIRE` keys.** Without a key a missing piece prints `SKIP:` with the fix and exits 0;
when `EXAMPLES_REQUIRE` names the key it fails (CI names all three).

| Key | Needs | Without it |
|---|---|---|
| `wasm` | Node 20+, the Relate bundle in `node_modules` reporting 1.2.0, `node_modules` at `package.json`'s pins, the NVL vendor bundle, a verified gliner-rs build | the whole example SKIPs |
| `gliner` | the small-v1 weights (`fetch-gliner.sh small --check`) | the whole example SKIPs |
| `browser` | Playwright's Chromium launches headless | only the browser section is skipped (a note on stderr) |

The native section has no key: it needs `relate` 1.2.0 on `PATH` and the project env's `relate-db`
1.2.0 (another version fails the run at once; no `relate` skips the section with a note).

### What the run checks

Eleven diffed files. A pinned behaviour that stops reproducing fails the run with a `PIN:` line on
stderr naming its row; stderr goes to `out/*.err`, never into a diff. The native section reads the
dump and the download the browser section saved in `work/browser/`, or makes equivalent inputs when
that section was skipped, so `native.txt` is the same either way.

| File | From | What it checks |
|---|---|---|
| `probes.txt` | `harness/probes.mjs` | The Relate WASM surface the example relies on, one section per NOTES.md row R1-R19: the version, no transaction control, null and missing parameters, the result envelope, number binding, column names, dynamic labels, what is compiled out, indexes and plans, traps, read-only refusals, `timestamp()`. |
| `model.txt` | `harness/model.mjs` | gliner-rs against the Python reference on 8 cases (same span and edge sets, scores within 1e-5, G7), a repeated call byte-identical, code-point offsets and one span under two labels (G11), and the long-input collapse (24 of 64 at 736 tokens, G10: a pin that fails once fixed). |
| `ontology.txt` | `harness/ontology.mjs` | The Ontology Graph Spec v1 reader against ajv on the 27 bundled documents and 42 tampered or edge-case ones; each bundled document byte for byte a fresh conversion of its original, and the conversion lossless; where each of the 220 tools lands; what each domain is asked; graph types and their refusals (R16); a generic v1 document end to end; the example's 17 limits; the `db.ontology.*` canary (R17); the ported splitter (57 of 57 documents) and names (677 of 677) against edgextract's own WASM. |
| `extract.txt` | `harness/run.mjs` | Every mention and claim with its band, rule and score: the 12 edge-case fixtures (`harness/fixtures.mjs`) and the 27 samples, each in its domain's store; the published graphs; a second pass with 0 inferences; stop, crash and resume (D9). |
| `gate.txt` | `harness/run.mjs` | The floor invariant (the store thresholded at t equals a fresh model call at t for 289 of 304 pairs; the 15 exceptions are the model's own decoding); the Cypher gate equal to a plain-JS gate on every store under every rule configuration; a scripted model for the rules' exact boundaries. |
| `audit.txt` | `harness/run.mjs` | Six 0-row audits (`queries/audit-*.cypher`) on every store; an illegal publish refused by the graph type; saved-query row counts; dumps reloaded with equal content digests; every ontology tool run on its domain's sample store against the page's prediction; the console's bookkeeping filter. |
| `review.txt` | `harness/run.mjs` | Verdicts surviving re-gating, re-extraction and re-publishing, and what an accepted or rejected claim does to its ends. |
| `score.txt` | `harness/run.mjs` | Precision, recall and F1 against the samples' gold and the held-out set, computed in Cypher, with per-domain rows, the distractors, ablations and the grids that set the defaults. |
| `graph.cypher` | `harness/run.mjs` | Two stores' typed graphs exported as Cypher (`store.exportCypher`). |
| `browser.txt` | `harness/drive.mjs` | Headless Chromium against the built `dist/` served as Pages serves it: the first visit, the model from page-routed Hub URLs and then from Cache Storage, extraction equal to Node's, reload, download and restore (also of a natively made tar), the console's read-only lease (the lent store's 65 OPFS files byte-identical) and watchdog, NVL, review from the graph, the ontology's tools, two tabs and the handover, re-applying a bundled ontology, a crash mid-section, the pasted-document flow, `reset()`. Fails on any CSP violation, console error or request to another origin. |
| `native.txt` | `harness/native.py` | Native Relate 1.2.0: the page's `dump.json` through `lib/replay.py` (equal digest, graph type, and Python's dump byte for byte the JS dump); `queries/*.cypher` giving the same rows on WASM and natively; the download route exactly as the page prints it; R22's adoption rules; the native-to-browser route (X4); a generic document's store. |

`uv run pytest -q` (from the root) adds `lib/tests/`: the format guard on good and tampered tars
(`test_opfsfmt.py`), JS and Python dumps in both directions (`test_replay_js.py`, `test_replay.py`)
and the site build (`test_site_build.py`).

## Architecture

```
page: index.html, app.js                       no database or model handle; ex33.* names in localStorage
  ├─ graphview.js ─ NVL: the graph tab, the ontology picture, the console's results
  │   postMessage {id, kind, ...}; progress events
  ▼
engine worker: worker.js                       the only writable opener of opfs://ex33-kg-<slug> (D6, D14)
  ├─ ontology.js   v1 document (ogs.js; convert.js for create-context-graph files) → (:_Ontology) + derived layer + graph type
  ├─ pipeline.js   split.js → sections → per sentence: cache hit, or gliner-rs at the 0.10 floor → store (D7, D9)
  ├─ gliner.js     gliner-rs WasmModel (synchronous; small-v1 about 680 MB of WASM memory, G8)
  ├─ store.js      the gate (D10) → publish the typed graph (D16)
  ├─ export.js     free → read the catalog-listed files → snapshot tar → reopen; restore into a fresh name (D17)
  └─ lend/reclaim  free → (the console's query) → reopen (D11)
                        │
console worker: console.js                     RelateDb.open(uri, readOnly = true), one statement per lease
```

- **One worker owns everything** (D6). Relate and gliner-rs are two synchronous WASM instances in
  one dedicated worker; there is no SharedArrayBuffer and no COOP/COEP. Jobs run one at a time;
  `stop`, `lend` and `reclaim` are handled on arrival. OPFS is worker-only anyway (R11).
- **The console lease** (D11). OPFS takes one opener per store, read-only included (R11), so the
  store is lent one statement at a time: the engine worker finishes its section and calls `free()`
  (which checkpoints), the console worker opens the store read-only, runs one statement and frees
  it, and the engine reopens it. Extractions, verdicts and cutoff moves queue behind the lease. The
  read-only handle refuses every write it would perform (R15).
- **The watchdog.** Relate has no cancel. A console query still running after 10 s gets its worker
  terminated. A worker terminated inside a WASM call can hold the store's handles for a moment, so
  every reopen (reclaim, download, crash restart, recycle) retries `storage locked` every 200 ms for
  up to 6 s (R11). A trap (R14) is handled the same way: the trapped worker is replaced.
- **Memory recycling** (R13). WebAssembly memory never shrinks, so after every 10 extractions the
  page waits until the engine worker is idle, has it `free()` the store (the checkpoint, R12),
  terminates it and starts a fresh worker, which reopens the checkpointed store and reloads the
  model from Cache Storage. The checkpoint matters: without it the fresh worker replays the whole
  WAL into memory and the recycle gives back little.
- **Crashes.** A dead engine worker is restarted at most three times per page load. A section a crash
  cut short stays `complete = false`, and **Continue** re-applies it: writes are idempotent `MERGE`s
  with a completion marker written last, because WASM has no transactions (R2, D9).
- **NVL** (D16). `graphview.js` is the only module that imports it: one reused instance per view,
  new elements added with existing nodes pinned, the canvas renderer (WebGL above 300 nodes),
  telemetry off. It draws node and relationship labels itself as HTML over the canvas, because NVL
  shows a caption only inside a circle at least 32 px across. `tonvl.js` stubs missing endpoints,
  which NVL would otherwise drop.
- **The weights** (D4). The page fetches the four files gliner-rs loads from
  `https://huggingface.co/<repo>/resolve/<rev>/<file>` (the large file redirects to `*.hf.co`), in
  32 MiB `Range` requests retried twice each, checks size and sha256 against the pins `build.mjs`
  embeds from `ci/gliner2.5-*.sha256`, and stores them in Cache Storage `ex33-models-v1`. Every cache
  hit is hashed again before use, because Cache Storage is shared by the whole origin. The weights
  are never mirrored on the site.
- **Per-origin names.** Every example on the site shares the `johnymontana.github.io` origin, so all
  of 33's names carry its prefix: stores `ex33-kg-…`, the cache `ex33-models-v1`, `localStorage`
  keys `ex33.*`, the channel `ex33-stores`.
- **The build** (`build.mjs`, D13). `dist/` is deterministic, uses relative URLs only, and serves
  fixed bytes under versioned directories: `assets/relate-1.2.0/`, `assets/gliner-rs-4fa741e/`,
  `assets/nvl-2.0.0/`, `assets/js-yaml-4.3.2/` and `assets/lib-<sha8>/` (`lib/replay.mjs`,
  `lib/relate_wasm.mjs`). The modules keep Node-style import specifiers, which `build.mjs` rewrites
  to those paths; an import map is not an option, because the CSP allows no inline script and
  module workers ignore import maps.
- **The harness's model pool.** Only in Node, `harness/infer.mjs` answers every model question on
  worker threads before the pipeline runs (three are asked again on the main thread and must be
  byte-identical, G7). The page has one model in its worker.

## The graph model

`web/ontology.js` writes the ontology layer and `web/store.js` the rest. Every label and type the
example writes for itself starts with `_`, which no ontology id may (D8), so a kind may be called
Entity or Claim without touching anything internal.

```
# ontology (D15): the v1 document is the source of truth; the rest is derived from it, in document order
(:_Ontology {id, version, title, format, spec, doc, sha, converted_from, source_sha, graph_type})
(:_Kind {key, id, description, color, aliases, implied, pole, origin, ord, keep, drop, cut_init, cut_src})-[:_IN]->(:_Ontology)
(:_LinkType {key, id, phrase, description, symmetric, pairs, typed, untyped_reason, ord, keep, drop, cut_init, cut_src})-[:_DOMAIN|_RANGE]->(:_Kind)
(:_Alias {name, ord})-[:_OF]->(:_Kind)                               the gazetteer (an edgextract:gazetteer extension)

# the trace
(:_Document {id: sha256(text), title, chars})
(:_Section {key, n, doc, complete})-[:_OF]->(:_Document)              complete = true written last (D9)
(:_Sentence {key, idx, doc, start, end, text, heading})-[:_IN]->(:_Section)
(:_Inference {key, model, rev, weights, build, floor, schema, parts})<-[:_INFERRED]-(:_Sentence)
(:_InferencePart {key, n, text})-[:_OF]->(:_Inference)               the raw model JSON, in parts of at most 16,000 characters
(:_Mention {key, doc, sentence, start, end, text, label, name, p, source, band, rule})-[:_IN]->(:_Sentence)
(:_Claim {key, doc, sentence, rel, p, band, rule, ...})-[:_EVIDENCE]->(:_Sentence)
(:_Claim)-[:_HEAD]->(:_Mention), -[:_TAIL]->(:_Mention)              written by the gate
(:_Run {id, doc, model, rev, floor, sections, sentences, inferences, hits, status, ts})-[:_READ]->(:_Section)
(:_Verdict {key, target, kind, value, ts, seq})-[:_ON]->(:_Claim|:_Mention)

# the extracted knowledge graph (D16)
(:_Entity:Person {key: 'Person:DANA_WHITLOCK', kind, norm, name, display, docs, mentions, generation})<-[:_OF]-(:_Mention)
(:_Entity:Person)-[:WORKS_FOR {p, claims, sentences, docs, generation}]->(:_Entity:Organization)

# scoring only
(:_Gold {key, kind: 'doc'|'entity'|'relation', doc, title, src, rel, tgt})
```

- **The inference cache key** (D7) is the sha256 of the model repository, revision, weights, the
  gliner-rs build, the schema asked, the floor and the sentence text. A sentence seen under that key
  never reaches the model again; changing what an ontology is asked changes the key.
- **Offsets** are Unicode code points, as gliner-rs reports them (G11).
- **Scores** go through `toFloat()` (R5); `ts` comes from `timestamp()` with `seq` as tie-break (R19).
- **Entity keys** are `KIND:NAME`, NAME being edgextract's canonical name (E3) of the surface text
  after leading titles (Dr, Mr, Prof, …) and the kind's own label word are dropped, when what remains
  still names something (`names.js` `entityName`). So "Dr. Imani Okafor" and "Imani Okafor" are one
  entity, and so are "account ACC-2207" and "ACC-2207".
- **Publish** is idempotent by generation: kept entities gain their kind label, each
  `(head, REL, tail)` becomes one relationship with the best score and its evidence (a symmetric link
  once), older generations go, and entities no longer kept lose their label. Every dynamic label and
  type is checked against the stored ontology first (R7).
- **Constraints and indexes.** Every lookup key but one has a UNIQUE constraint whose backing index
  serves it (R9; `store.js` `KEYS`); `_Verdict.target` has a plain index, and `_Sentence.text` a
  full-text index for the console. The store re-creates its constraints after every graph-type
  change (R16).

## The gate

`store.gateStatements` is the gate as one list of idempotent Cypher statements (D10), run over
complete sections only. It rewrites every mention's and claim's `band` (`keep`, `review`, `drop`) and
`rule`, in this order:

| # | Rule (`rule`) | What it does |
|---|---|---|
| 0 | `no-name` | A mention with no canonical name (a pronoun, a name with no ASCII letter or digit) drops; no verdict overrides it. |
| 1 | `gazetteer` | Listed names (the `edgextract:gazetteer` extension) are kept at p = 1.0; overlapping model mentions drop. |
| 2 | `one-kind`, `type-margin`, `pole-specific` | One span, one kind. A create-context-graph domain kind that specialises the winning base kind (its POLE+O pole) and scores within the pole margin wins instead. A runner-up within the type margin sends the winner to review. |
| 5 | `band` (mentions) | Keep at p ≥ the kind's keep cutoff, drop at p ≤ its drop cutoff, review between. |
| 2b | `other-kind` | One kind per name across the store: a domain kind over a base kind, else the highest score. The other kinds' kept mentions go to review. |
| 7 | `verdict` (mentions) | Mention verdicts override every rule but 0; the latest wins. |
| 3 | `unanchored`, `end-in-review` | Each claim end joins the kept mention with its span (punctuation trimmed), else the smallest one containing it, else by entity key within the sentence; then the same among mentions in review. An end that joins nothing drops the claim; a claim joined to a mention in review waits with it. Rejecting the mention a claim joined unanchors the claim. |
| 7 | `claim-verdict` (mentions) | An accepted claim keeps the two mentions it joined, when both anchor, the pair is legal and they are two entities. |
| 4 | `illegal`, `self-loop` | The (head kind, tail kind) pair must be one of the link's exact legal pairs (either way round for a symmetric link); this also covers the links a graph type cannot express (R16). A claim whose ends are one entity drops. |
| 5 | `band`, `hedged` (claims) | The band per link; then **the hedge cap**: a kept claim whose sentence holds a hedge or negation cue (`store.HEDGE_CUES`: not, never, may, might, unclear, whether, …) before its later end goes to review. |
| 6 | `ambiguous`, `reversed` | One link per ordered pair per sentence: weaker links go to review (the best one too when another scored within the relation margin), and so do A→B and B→A of a one-way link. |
| 7 | `verdict` (claims) | Claim verdicts override the band, the hedge cap, rule 3's cap and rule 6, never rule 3's join or rule 4. |

The Review tab and the graph's side panel explain each item by its rule (`app.js` `explain`).

**Defaults** (`store.defaultGate`), the same for every ontology:

| | small-v1 | base-v1 |
|---|---|---|
| Entity keep / drop | 0.50 / 0.30 | 0.50 / 0.30 |
| Relation keep / drop | 0.35 / 0.20 | 0.50 / 0.20 |
| Type, relation, pole margin | 0.05, 0.05, 0.25 | the same |

They were calibrated on a 0.05 grid on the bundled samples, which are written in short declarative
sentences, and checked on six held-out documents written the same way (`score.txt` has the grids).
**For dense pasted prose, raise them** on the Cutoffs tab. Each kind's and link's pair records
`cut_src`: `default` follows the defaults of the model in use, `user` stays where you put it.

**Every candidate at p ≥ 0.10 (the floor) is stored**, so moving a cutoff, a margin or a verdict
re-runs the gate over stored rows and never calls the model. A stored cutoff is not exactly a fresh
call at that threshold for 15 of 304 (sentence, threshold) pairs, because the model's decoding can
pick a longer overlapping span once lower-scoring candidates are gone (`gate.txt`).

## What the model is asked

GLiNER2.5 reads each kind as `label:description` and each relation as a name, one sentence at a time
(gliner-rs binds no relation description, G5). `pipeline.modelSchema` derives the question from the
ontology and maps the answers back to the ontology's ids (`kindOf`, `relOf`) before anything is
stored.

| | Asked as | For example |
|---|---|---|
| A kind | its label as lower-case text | `MaintenanceRecord` → "maintenance record" |
| A create-context-graph domain kind | with "<subtype> in <domain>" | "account: financial account in financial services" |
| A base kind (Person, Organization, …) | bare | "person" |
| A base kind no link names, whose pole a domain kind shares | not asked (it stays a kind and a node type) | Object in every domain |
| A link | its phrase between its endpoints' label texts, one per legal pair, joined by " or " | OWNS → "person owns account" |

Any other v1 document is asked the same way, with each node's own `description` when it has one.
On the samples this schema at the defaults scores entity F1 0.950 and relation F1 0.926, against
0.663 and 0.191 for asking each kind by its id with a "<subtype> (<pole type>)" description and
each link as a bare phrase, with cutoffs of 0.85/0.70
(`score.txt` compares the two, with a paired bootstrap).

## The samples and what they score

`data/samples/ccg/` holds 27 synthetic documents, one per domain, written for this example from each
domain's own document templates. The people, organisations, identifiers, events and sites are
fictional; the cities and regions are real. Each has gold labels (340 entities and 303 relations in
all, every relation legal for its ontology: `score.txt` checks) and one **distractor**: a hedged or
negated claim left out of the gold on purpose (`distractors.json`). They are written to suit the
model: short declarative sentences, one fact each, explicit names, never a pronoun.

`score.txt` scores the gate's kept facts in Cypher (`store.scoreAgainstGold`) as edgextract's eval
does (entities as (NAME, TYPE), relations as (SOURCE, TARGET, TYPE), micro-averaged; review and drop
count as not predicted). At the defaults on small-v1:

| | P | R | F1 |
|---|---|---|---|
| Entities | 0.950 | 0.950 | 0.950 (323 of 340) |
| Relations | 1.000 | 0.861 | 0.926 (261 of 303) |
| Held-out entities (6 documents) | 0.919 | 0.907 | 0.913 |
| Held-out relations | 0.979 | 0.723 | 0.832 |

No distractor is kept (0 of 27, and 0 of 6 held out). The model scores them like facts (25 are
proposed in their own sentences, 13 at the relation keep or above); the hedge cap, rule 4 and rule 3
keep them out, not the cutoff. At the defaults the samples leave 95 mentions and 51 claims in review.
`data/samples/heldout/` is never listed in the page and was never used to set a default or a rule.
These are small synthetic documents: treat per-domain rows as anecdotes and the totals as the signal.

## Ontologies: the Ontology Graph Spec v1

Every ontology is a Neo4j Ontology Graph Specification v1 document
([neo4j/graph-spec](https://github.com/neo4j/graph-spec) at `35e74c0`, a draft; its JSON Schema is
vendored in [`data/ontology-spec/`](data/ontology-spec/)): `nodes` and `relationships` keyed by local
ids, with labels, descriptions, properties, constraints, `tools` and `extensions`; a relationship
type with several endpoint pairs is one entry per pair.

- **The page takes** a v1 document in YAML or JSON, or a create-context-graph file, which
  `web/convert.js` converts to v1 (the editor says so, and **Show as v1** shows the result). The v1
  document is what is stored. edgextract's own ontology YAML is refused with a note on how to write
  it as v1.
- **The bundled 27** are conversions committed in [`data/ontologies/ogs/ccg/`](data/ontologies/ogs/),
  written by `node harness/convert.mjs` from the originals kept verbatim in `data/ontologies/ccg/`
  (with `_base.yaml`, merged first as create-context-graph's `ontology.py` `_merge_base` does). The
  conversion is lossless: properties, tools, templates and the rest ride v1 fields and
  `createContextGraph:*` extensions. Every run fails on a stale conversion, naming it;
  `node harness/convert.mjs --check` compares without writing.
- **Checks** (`web/ogs.js`): the spec's JSON Schema through a small interpreter (pinned error for
  error against ajv 8.20.0 with ajv-formats), the rules the schema cannot express (labels, endpoints,
  constraint properties, `key` with `mustExist`, …), then this example's: the exact `$schema` URL,
  the id rule below, one node per identifier label, one entry per (type, from, to). Then the
  example's limits (`web/ontology.js`): 2 to 50 kinds, at most 100 legal pairs, at most 25 links per
  kind pair, no two kinds or links that read alike. A refused document's problems show one per line
  with their path.
- **The id rule** (`isOntologyId`): Unicode letters with combining marks, digits and `_`, NFC, at
  most 64 code points, at least one letter or digit, never a leading `_`. `ÄRZTE` and keyword ids
  such as `MATCH` are fine; an emoji, `-` or `:` is refused.
- **What is enforced.** Each node's identifier label is a node type of the store's graph type (with
  `name :: STRING NOT NULL`, the example's own requirement), and a published entity carries it with
  its implied labels. A link with exactly one legal pair is an edge type of the graph type; a graph
  type allows one source and one target label per relationship type (R16), so a link with several
  pairs is checked by the gate only (Financial Services: 12 links enforced by the graph type, 0
  gate-only; Legal: 16 and 1). Other declared properties, cardinalities and constraint objects stay
  descriptive: the extractor writes only `name`, `display`, `key` and its own bookkeeping.
- **Extensions it reads:** `neo4j:display` (the kind's colour), `createContextGraph:pole` (rule 2
  and what the model is asked), `createContextGraph:domain` (the picker's emoji and tagline; marks a
  create-context-graph document), `createContextGraph:origin`, and two that keep edgextract's
  feature names, `edgextract:symmetric` and `edgextract:gazetteer` (no bundled ontology has them;
  `gate.txt` runs both on a generic test document). Other custom envelopes are carried untouched.

**Where it lives** (D15). Relate 1.2.0 has no `system_ontologies` database, and its `db.ontology.*`
procedures are a preview feature the WASM build cannot enable (R17). So the document lives in `neo4j`:
`(:_Ontology)` holds it as canonical JSON with its sha256, the `_Kind`/`_LinkType`/`_Alias` layer is
derived from it, and the graph type is applied with `ALTER CURRENT GRAPH TYPE SET` and read back from
`SHOW CURRENT GRAPH TYPE`. A successful SET drops every other constraint (R16), so the store
re-creates its UNIQUE constraints after each one. **The canary**: every open runs
`SHOW PROCEDURES YIELD name WHERE name STARTS WITH 'db.ontology.'`; `ontology.txt` and
`queries/07-ontology-canary.cypher` pin it empty, and a release that exposes the procedures in WASM
fails the run, which is the signal to move the document into them.

**One store per ontology** (D14). A store has one graph type, so each ontology gets
`opfs://ex33-kg-<slug>`: the id when it fits OPFS's name rule, else an ASCII fold plus 8 hex
characters of its sha256 (`ex33-kg-arzte_netz-51a55e35`). An edit the existing data breaks is
refused by the engine and leaves the store as it was; **Rebuild the graph with it** drops the typed
projection, applies the edit and re-gates from the trace.

## The ontology's tools

create-context-graph's 193 agent tools and 27 default views become 220 `canonicalQuery` tools in the
v1 documents, each on the node it is about: the node its first parameter is compared with where that
comparison filters the rows (153 tools), else the first labelled node of its first `MATCH` (67)
(`web/convert.js` `toolAnchor`).

- **The Console tab** lists the open store's tools by element (Financial Services: Person 3,
  Account 3, Decision 2), each with its description, Cypher (**Copy**, **Load into editor**),
  parameter inputs and **Run**. Only `canonicalQuery` tools run.
- **The graph's side panel** lists the tools on a clicked entity's kind. The entity's name goes into
  at most one parameter, one the query compares with a name-like property of that kind
  (`console.js` `prefillChoice`); a tool whose parameters then all have a value runs (**Run with
  $query = "Dana Whitlock"**), and one with an empty parameter opens its card and asks
  (**Open: fill $id**).
- **Before running** (`toolArgs`): every parameter without a default is required (a missing or empty
  value is refused, never sent as null: R3), values are typed by their token (a STRING read only
  through `toInteger()` must be a whole number), `one_of` must hold, and an undeclared `$name` is
  refused. Then it runs on the read-only lease like any console query.
- **The note** (`toolCompat`), computed from the query text without running it, says what the tool
  can do on an extracted graph: *can return rows*, *no rows here* (it needs a label, type or property
  the extractor never writes), *errors here* or *errors if reached* (a procedure or index the store
  lacks), or *checked at run*. It also flags unbounded variable-length patterns and untyped
  relationships that reach the bookkeeping. It never blocks Run.

On the extracted samples (`audit.txt`): of 220 tools, 106 return rows, 113 none and 1 errors. The
error is legal's `expiring_contracts`, whose verbatim upstream query orders an aggregating `RETURN` by
an expression it does not project, which Relate refuses (R20); the note predicted no rows for it, the
audit's one miss. Tools keyed on names and on the relationships the gate kept work; those keyed on
identifiers or rich properties find nothing, as their notes say. No tool wrote.

**The bookkeeping filter.** The console shows every row by default. **Hide the example's
bookkeeping** (remembered as `ex33.consoleHideBookkeeping`) leaves out rows whose columns are the
extraction's own records (`_Document`, `_Section`, `_Sentence`, `_Inference`, `_InferencePart`,
`_Mention`, `_Claim`, `_Run`, `_Verdict`, `_Gold` and their relationship types), and drops such values
inside lists and maps. The ontology layer and the entities always show. NVL draws only the shown rows,
capped after the filter.

## Download and restore

**Download** (D17, X1). The engine worker calls `free()`, which checkpoints the store; reads the OPFS
`catalog` and only the slots it lists (freed slots keep stale bytes, R10); checks the files strictly
(`web/opfs.js`, the same rules as `lib/opfsfmt.py`, X5); writes `<store>.relate.tar`, a **snapshot**
holding `graph.json` and `manifest.json` only, refused if the WAL still held a record past the
checkpoint (it never does right after `free()`); and reopens the store.

Native Relate 1.2.0 opens it as a directory database. The first writable open adopts the directory
(writes the engine's own side files and a WAL); a read-only open or `relate clone` refuses it until
then (R22):

```bash
python3 -I lib/opfsfmt.py check --snapshot ex33-kg-financial-services.relate.tar   # optional: the strict guard
mkdir db && tar -xf ex33-kg-financial-services.relate.tar -C db
relate --mode jsonl -d db 'MATCH (e:_Entity) RETURN e.kind AS kind, count(*) AS n'
relate clone db kg-financial-services.rl                                           # optional: a single-file bundle
```

`native.txt` runs exactly these, then opens the `.rl` with `read_only=True` and checks the content
digest and graph type against the dump.

**Restore.** Upload a `.tar` on the Store tab. It accepts a download from this page, a tar of any
JSON-codec directory database (WAL segments allowed), or a raw tar of an OPFS store directory
(`catalog` plus `slot-NN`). Paths with a part starting with `.` (the engine's side files) are skipped
by that one rule. The input is checked strictly and written into a fresh name,
`ex33-kg-<slug>-restored-<n>`, slots in path order and the catalog last (X2); a restore never
overwrites a store. A snapshot without a WAL is adopted by one writable open (R22); then the store is
opened read-only to compare counts, graph type and content digest before it is selected.

**From native Relate into the browser** (X4):

```bash
relate clone --to-snapshot-format json kg.rl dir && python3 -I lib/opfsfmt.py to-tar dir kg.tar
```

`to-tar` skips the dot entries and refuses a tree whose dot file a running process holds locked (exit
1: close that process first). `browser.txt` restores a tar made this way.

**`dump.json`** is the engine- and format-independent copy (the `lib/replay` format, graph type
included). `lib/replay.py` loads it natively and `lib/replay.mjs` into WASM. Never pass a dump
through `JSON.parse`, `JSON.stringify` or `postMessage`: integers above 2^53 and floats would not
survive (R4, R5); send `canon(d)` text and `parse()` it on the other side.

**The formats are internal** and pinned to Relate 1.2.0 (X5): the catalog `MDBOPF01` v1 with its
CRC32, at most 64 slots, the JSON codec, `value_encoding` 2, `MDBWAL01`. Both guards refuse any
other version, integers written with a fraction or exponent, `-0`, JSON naming one key twice (which
`JSON.parse` and Python's `json` would silently accept, keeping the last value), a crc-valid WAL
frame that does not decode, and a tar without its end-of-archive marker. Only a final WAL frame cut
short or failing its crc32 counts as a torn append.

## The GitHub Pages site

The page is the first entry of the repository's static site for browser examples (D19,
[`site/README.md`](../../site/README.md)), at `https://johnymontana.github.io/relate-examples/33-wasm-extract/`.
`site.json` declares its title, description, `path: "33-wasm-extract"`, `build: "npm run build"`,
`dist: "dist"` and the origins it fetches from (`https://huggingface.co`, `https://*.hf.co`: the Hub
picks its CDN host by region).

Pages sets no response headers, so:

- **The CSP is a `<meta http-equiv>`** in `web/index.html`, before any script, and `site/build.mjs`
  fails when a `connect` origin is outside it:

  ```
  default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self';
  connect-src 'self' https://huggingface.co https://*.hf.co; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; base-uri 'self'; object-src 'none'
  ```

  The referrer policy is a `<meta name="referrer">` (`strict-origin-when-cross-origin`).
- **What Pages cannot do:** `frame-ancestors` (a meta policy ignores it, so it is left out and the
  page can be framed), `X-Content-Type-Options: nosniff`, immutable caching (Pages sends
  `Cache-Control: max-age=600` on every file, so the versioned `assets/<name>-<version>/` directories
  are what keep a stale file from being served), and a policy for workers: a worker's CSP comes only
  from its own response headers, so the module workers loaded from the site run with none.
- **The origin is shared.** A project site is served from `https://johnymontana.github.io`, the origin
  every other Pages site of that account shares. Storage is per origin, so any page those sites serve
  can read, change or delete this page's OPFS stores (`relate/ex33-kg-*`), its model cache
  (`ex33-…` in Cache Storage) and its `ex33.*` `localStorage` keys. The `ex33` prefix keeps the
  examples from colliding with each other; it is not a security boundary. Keep nothing private in a
  store here, or serve the site from its own domain.
- **`.nojekyll`** is written by `site/build.mjs`, so files such as `_base.yaml` are published as is.
- **Locally**, `./run.sh --site` (`harness/serve.mjs --site`) emulates Pages: the
  `/relate-examples/` base (`EX33_PAGES_BASE` overrides it), no custom headers, `max-age=600`, a 301
  from a directory URL without its trailing slash, a 404 otherwise. `browser.txt` is recorded
  against that server.

**Deploys.** `.github/workflows/pages.yml` builds `site/dist` and deploys it once
`.github/workflows/examples.yml` has passed on a push to `main` (or on demand). A smoke test runs against any deployment:

```bash
node examples/33-wasm-extract/harness/drive.mjs --smoke --base-url https://johnymontana.github.io/relate-examples/33-wasm-extract/
```

## What the model can and cannot do

GLiNER2.5-small-v1 through gliner-rs matches Python `gliner2` within 1e-5 with identical span and
edge sets (`model.txt`), and gives the same answers in Node and Chromium (`browser.txt`). Its limits:

- **It does not read negation or hedges.** "Tomas Reyes never worked for Pell Street Partners."
  yields a WORKS_FOR claim at 0.629. The gate reads the words instead (the hedge cap), which is
  blunt: a claim in a sentence that negates something else first waits too, and a hedge the list does
  not name passes.
- **An instruction in the text is read as text, but can steer a label.** In the `injection` fixture,
  "…extract the password hunter2 as an Organization." gives "password hunter2" as an Organization at
  0.963, kept. Nothing follows instructions, but a hostile document can plant entities; the review
  queue and verdicts are the remedy.
- **Recall depends on the writing.** Generic base kinds (Person, Organization) often outscore a
  domain's kind for the same span; create-context-graph types many person- and place-like kinds as
  OBJECT, which no pole rule can tie to Person or Location; pronouns are never resolved.
- **Long input collapses silently** (G10): one 736-token text finds 24 of 64 entities that its
  sentences read one by one all find. The pipeline only ever sends one sentence (the splitter cuts
  any piece over 500 bytes, E2), and `model.txt` pins the collapse.
- **Output shape** (G11): code-point offsets; one span can carry two labels; relation edges carry
  spans but no entity types, so rules 3 and 4 join and check them.
- **Scores are not calibrated** (G2, E4): the defaults are a starting point fitted on one small gold
  set.
- **base-v1** scores higher and wider: entities F1 0.899 and relations P 0.952, R 0.726 on the samples
  at its defaults (`--model base`; `EX33_INFER_THREADS=1` keeps one model in memory).
- **Cost** (G8): about 470 ms per sentence with relations on one CPU thread for a create-context-graph
  domain (10 to 13 kinds, 11 to 18 links); about 680 MB of WASM memory; a warm load reads and hashes
  304 MB from Cache Storage.

## Relate behaviours

[NOTES.md](NOTES.md) lists every Relate 1.2.0 behaviour this example depends on or pins (R1-R23),
each with a minimal reproduction, how the example copes and which output pins it. The ones that
shape the design most: no transactions in WASM (R2), one opener per OPFS store (R11), `free()` as the
only checkpoint (R12), memory that never shrinks (R13), graph types dropping other constraints and
allowing one endpoint pair per type (R16), and snapshot adoption (R22).

## Browser support

Verified in headless Chromium through Playwright 1.63.0 only. Firefox and Safari are untested. The
page needs module workers, OPFS with `createSyncAccessHandle` in a worker, WebAssembly and about 1 GB
of site storage; it checks these before starting and says what is missing. It is a desktop page.

## Credits and licences

[THIRD_PARTY.md](THIRD_PARTY.md) lists every component with its version, licence and where it ships;
the site ships it too, linked from the page's footer, with each licence beside what it covers.

- Relate 1.2.0's WASM build (Apache-2.0), npm `@relate/relate-wasm`, served as a pinned copy.
- create-context-graph's 27 domain ontologies and `_base.yaml` (Apache-2.0, commit `707b168`,
  verbatim, with their licence in `data/ontologies/ccg/`); the 27 samples are written for this
  example.
- edgextract's approach and the rules this example ports (Apache-2.0, `data/LICENSE-edgextract.txt`;
  none of its data is bundled).
- The GLiNER2.5 weights (Apache-2.0, Fastino), fetched from the Hub, never redistributed; gliner-rs
  v0.3.1 (Apache-2.0), with the Rust crates linked into its `.wasm` listed beside it.
- The Ontology Graph Specification v1 schema (Apache-2.0); js-yaml 4.3.2 (MIT).
- **NVL 2.0.0 is proprietary.** Its licence allows use only with Neo4j Aura or Neo4j's commercial
  products under a subscription. In this repository and its public site, with Relate, NVL is used
  with Neo4j's permission (confirmed by the repository owner on 2026-10-08). The licence ships beside
  the bundle as `assets/nvl-2.0.0/NVL-LICENSE.txt`.

## Files

| Path | Role |
|---|---|
| `run.sh` | the sections, modes and diffs |
| `NOTES.md` | the Relate 1.2.0 behaviours (R1-R23) and the design ids |
| `web/` | the page: `index.html`, `style.css`, `app.js`; `worker.js` (engine worker); `console.js` (console worker, and the tools' checks and the bookkeeping filter); `pipeline.js`, `store.js` (the gate), `ontology.js`, `ogs.js` (the v1 reader and writer), `convert.js` (create-context-graph to v1, tool placement), `split.js` and `names.js` (edgextract's rules), `gliner.js`, `models.js`, `graphview.js`, `tonvl.js`, `export.js`, `opfs.js`, `tar.js`; `vendor-entry.mjs` (the NVL bundle's entry) |
| `build.mjs`, `site.json` | `npm run build` → `dist/`; the site contract |
| `harness/` | `probes.mjs`, `model.mjs`, `ontology.mjs`, `run.mjs` (the Node sections), `infer.mjs` (the model pool), `fixtures.mjs` (edge-case documents and the generic v1 document); `convert.mjs` (writes `data/ontologies/ogs/`, `--check`); `drive.mjs` (Chromium, `--smoke`); `native.py`; `serve.mjs` (`--dev`, `--site`); `reference.py` (`--reference`) |
| `queries/` | `01`-`08` the console's saved queries; `audit-1`…`audit-6` the 0-row audits; `report-keys-displays` a report for `audit.txt`. Each documents its parameters as `// @param name TYPE <json example> description`. |
| `data/ontologies/ogs/` | the 27 bundled ontologies as v1 documents (generated) |
| `data/ontologies/ccg/` | create-context-graph's originals and `_base.yaml`, verbatim, with `SOURCE.md` and the licence |
| `data/ontology-spec/` | the spec's JSON Schema, verbatim, with its licence |
| `data/samples/` | `samples.json` (the sample per domain), `ccg/` (the 27 samples, their gold and `distractors.json`), `heldout/` (six more, scored only) |
| `data/reference/gliner2-small.json` | Python gliner2's output, for `model.txt` |
| `expected/` | the eleven diffed files |
| `THIRD_PARTY.md` | every third-party component, version and licence |

Shared code outside this directory: `lib/relate_wasm.mjs` (find, check and load the bundle; `exec`
with its null-parameter refusal and error categories; `isTrap`), `lib/replay.mjs` and
`lib/replay.py` (dump, load and digest), `lib/opfsfmt.py` (the strict guard, `to-dir`, `to-tar`),
`scripts/build-gliner-wasm.sh`, `scripts/fetch-gliner.sh`, `site/` and `.github/workflows/`.
`out/`, `work/`, `dist/`, `web/vendor/` and `node_modules/` are gitignored.
