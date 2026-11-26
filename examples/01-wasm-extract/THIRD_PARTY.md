# Third-party code, data and weights in example 01

Each entry names what the example uses, where it comes from, the pinned version and the
licence, and whether it ships in the static site. `npm run build` copies this file into
`dist/` as `THIRD_PARTY.md`, and the page's footer links to it.

Shipped in `dist/` (what the GitHub Pages site serves for this example):

| Path in `dist/` | Component | Licence |
|---|---|---|
| `assets/relate-1.3.0/`: `relate.js`, `relate_bg.wasm`, `trap.js`, `snippets/relate-wasm-19215b5d5f97ddd6/js/opfs.js`, `LICENSE.txt` | Relate 1.3.0, WASM build | Apache-2.0 (`LICENSE.txt`) |
| `assets/gliner-rs-4fa741e/`: `gliner_rs.js`, `gliner_rs_bg.wasm`, `LICENSE.txt`, `THIRD_PARTY-crates.txt` | gliner-rs v0.3.1, with the Rust crates it links (listed in `THIRD_PARTY-crates.txt`) | Apache-2.0; the crates MIT and/or Apache-2.0 for most, a few Unicode-3.0, Zlib, BSL-1.0, BSD-2-Clause or Unlicense (below) |
| `assets/nvl-2.0.0/`: `nvl.js`, `HierarchicalLayout.worker.js`, their `.LEGAL.txt`, `NVL-LICENSE.txt`, the files the `.LEGAL.txt` refer to (`base.mjs.LICENSE.txt`, `dagre.esm.js.LEGAL.txt`), `THIRD_PARTY-npm.txt` and one `LICENSE-<package>-<version>.txt` per bundled npm package | NVL 2.0.0, with its bundled dependencies (only packages that put bytes into the bundle: NVL's `@segment/*` analytics packages are tree-shaken out and are neither shipped nor listed) | proprietary, used with Neo4j's permission (confirmed by the repository owner on 2026-10-08); the dependencies MIT, ISC, Unlicense |
| `assets/js-yaml-4.3.2/`: `js-yaml.js`, `LICENSE.txt` | js-yaml 4.3.2 | MIT |
| `assets/ontology-graph-spec-0.13.0/`: `ontology-graph-spec.js`, `LICENSE.txt`, `THIRD_PARTY.txt` | the Ontology Graph Spec SDK 0.13.0 (npm `@neo4j/ontology-graph-spec`), bundled into one module with the Kotlin libraries compiled into it (listed in `THIRD_PARTY.txt`) | Apache-2.0, the Kotlin libraries Apache-2.0 |
| `data/LICENSE-edgextract.txt`, `data/SOURCE.md` | edgextract's licence, for the approach and the rules the page's modules port (below) | Apache-2.0 |
| `data/ontologies/ogs/ccg/*.ontology.yaml`, `data/ontologies/ogs/SOURCE.md`, `data/ontologies/ccg/_base.yaml`, `data/ontologies/ccg/LICENSE-create-context-graph.txt`, `data/ontologies/ccg/SOURCE.md` | create-context-graph's domain ontologies, converted to Ontology Graph Spec 1.1, and their base, verbatim | Apache-2.0 |
| `data/ontology-spec/`: `ontology-graph-spec.schema.json`, `LICENSE-graph-spec.txt`, `SOURCE.md` | the Neo4j Ontology Graph Specification 1.1.0's JSON Schema, verbatim (also carried in `ogs.js`) | Apache-2.0 |
| `data/samples/ccg/*.md` | 27 synthetic documents written for this example from create-context-graph's document templates; the people, organisations, identifiers, events and sites are fictional, the cities and regions real | this repository's licence |
| `data/ontologies/index.json`, `data/samples/samples.json` | the picker's lists (`build.mjs`, this repository) | this repository's licence |
| the page's modules (`app.js`, `worker.js`, …), `assets/lib-<sha8>/` (`lib/replay.mjs`, `lib/relate_wasm.mjs`, `lib/ogs.mjs`), `queries/` | this repository; `split.js`, `names.js` and parts of `pipeline.js` port edgextract's rules; `ogs.js` carries the spec's schema | this repository's licence; the ports keep edgextract's attribution |

Not shipped:
- the GLiNER2.5 weights, which the page fetches from the Hugging Face Hub;
- the harness's fixtures (`harness/fixtures.mjs`), edge cases written for this example after edgextract's golden set, and
  `harness/fixtures/*.draft.ontology.yaml`, two documents as the last draft-format build of this example had them;
- the create-context-graph samples' gold files and distractors (`data/samples/ccg/*.gold.json`,
  `distractors.json`), which only the Node harness reads;
- `data/reference/`;
- the development tools.

## edgextract

- **What:** the approach: an ontology, a probability for every answer, and keep, review and
  drop cutoffs. Its rules are ported to JavaScript:
  - the markdown sentence splitter (`web/split.js`);
  - the name rules (`web/names.js`);
  - the gazetteer proposer, the pronoun list and the section planning (`web/pipeline.js`).

  Each port names its upstream source file and commit in its header. The gazetteer and
  symmetric links keep edgextract's names as Ontology Graph Spec custom extensions
  (`edgextract:gazetteer`, `edgextract:symmetric`); no bundled ontology carries them.
- **Source:** [raphaelmansuy/edgextract](https://github.com/raphaelmansuy/edgextract) at
  commit `3f08b1dca84ebacffd5152cee37639a62df0fb93` (`3f08b1d`). The npm package
  `@raphael.mansuy/edgextract@0.1.0` is a dev-only dependency, used as the parity oracle in
  `harness/ontology.mjs` (the splitter and names, through its own WASM).
- **Data:** none of edgextract's data (its ontologies, golden documents or samples) is in the
  repository or ships ([`data/SOURCE.md`](data/SOURCE.md)). The harness's fixtures
  (`harness/fixtures.mjs`) follow the cases of its golden set in new text.
- **Licence:** Apache-2.0, © 2026 Raphael MANSUY. The licence text travels as
  `data/LICENSE-edgextract.txt`, in the repo and in `dist/`. edgextract has no NOTICE file.

## create-context-graph's domain ontologies (`data/ontologies/ccg/`)

- **What:** the 27 domain ontologies (`agent-memory.yaml` … `wildlife-management.yaml`) and
  their shared POLE+O base (`_base.yaml`: Person, Organization, Location, Event, Object;
  WORKS_FOR, LOCATED_AT, PARTICIPATED_IN), copied byte for byte. `web/convert.js` reads the
  format (`domain`, `entity_types`, `relationships`, `inherits: _base`), merges the base as
  create-context-graph's `ontology.py` `_merge_base` does (a reimplementation, not a copy), and
  converts each file to an Ontology Graph Spec 1.1 document that carries all of it: properties,
  agent tools, document templates, decision traces, demo scenarios, the system prompt and the
  visualization settings. `dist/` ships the 27 converted documents
  (`data/ontologies/ogs/ccg/`, derived works under the same licence) and `_base.yaml` (for a
  file pasted or loaded into the page), not the 27 originals.
- **Source:** [neo4j-labs/create-context-graph](https://github.com/neo4j-labs/create-context-graph),
  `src/create_context_graph/domains/`, at commit `707b168d9509cbf1b919b82940285d1df4c6810d`
  (`707b168`, 2026-09-04). [`data/ontologies/ccg/SOURCE.md`](data/ontologies/ccg/SOURCE.md) maps
  every file to its upstream path.
- **Licence:** Apache-2.0, neo4j-labs/create-context-graph contributors. The YAML files carry no
  copyright header, and the repository ships no NOTICE file; its `LICENSE` has the line
  "Copyright 2026 Neo4j Labs" after its terms and conditions. That `LICENSE`, copied unchanged from the commit, travels with the
  files as `data/ontologies/ccg/LICENSE-create-context-graph.txt`, in the repo and in `dist/`.

## The create-context-graph samples (`data/samples/ccg/`)

- **What:** 27 short markdown documents, one per domain, each with its gold labels
  (`<domain>.gold.json`, edgextract's golden-label format: `{entities: [{name, type}],
  relations: [{source, target, type}]}`), and `distractors.json`, the one hedged or negated
  claim per document that the gold leaves out on purpose.
- **Source:** written for this example, each from one of create-context-graph's document
  templates for its domain (the template's id is in the document's front matter, `template:`;
  its prompt is in the domain's YAML under `document_templates`). They are **synthetic**: the
  people, organisations, identifiers and events in them are fictional, and so are the sites they
  are set at (a reserve, a hotel, a well), while the cities and regions they mention are real
  (Edinburgh, Norwich, Porto, the Douro Valley, Laikipia, …). No text is copied from
  create-context-graph. Each front matter marks it `synthetic: true`, with a note (its "every name
  is fictional" means those people, organisations, identifiers, events and sites, not the cities
  and regions).
- **Licence:** this repository's. The templates they follow are create-context-graph's
  (Apache-2.0, above).

## GLiNER2.5 weights

- **What:**
  - `fastino/gliner2.5-small-v1`, the default, at revision
    `7132dc4561c3f94563c6147e75ffa8ef34c4964a`;
  - `fastino/gliner2.5-base-v1`, selectable, at revision
    `ca906247640776a07753514055be9726f9080ead`.

  The page loads four files of each: `model.safetensors`, `tokenizer.json`, `config.json` and
  `encoder_config/config.json`. `scripts/fetch-gliner.sh` also fetches `tokenizer_config.json`,
  which only Python `gliner2` reads.
- **Source:** the Hugging Face Hub. `scripts/fetch-gliner.sh` and the page fetch them at those
  revisions. Each file is checked against `ci/gliner2.5-small-v1.sha256` or
  `ci/gliner2.5-base-v1.sha256`; the page re-checks a cached copy on every use.
- **Licence:** Apache-2.0, © Fastino. They are not committed and not redistributed: the
  deployed page fetches them from the Hugging Face Hub into the visitor's browser.

## gliner-rs

- **What:** the GLiNER2 inference runtime, compiled to WASM (`gliner_rs.js` and
  `gliner_rs_bg.wasm`).
- **Source:** [apiplant/gliner-rs](https://github.com/apiplant/gliner-rs) v0.3.1, commit
  `4fa741eec466660daf4adc8703210138295e0b1b`. `scripts/build-gliner-wasm.sh` builds it from
  GitHub's source archive of that commit, with the commit's `Cargo.lock` (`--locked`).
  Nothing binary is committed.
- **The bytes are not pinned.** The build is byte-identical on one host but not across hosts,
  so there is no `ci/gliner-rs-*.sha256`. The script checks a cached build against its own
  `.built` record, and `expected/model.txt` pins the behaviour against the Python reference.
- **Licence:** Apache-2.0, © its authors. Its `LICENSE` ships as
  `assets/gliner-rs-4fa741e/LICENSE.txt`, renamed with a `.txt` extension so that it is served
  as text.
- **Linked Rust crates.** The `.wasm` statically links gliner-rs's Rust dependencies, and
  `scripts/build-gliner-wasm.sh` lists them in `THIRD_PARTY-crates.txt` (name, version,
  licence expression, repository; sorted), which ships beside the `.wasm`. For 4fa741e that is
  116 crates, gliner-rs included, plus the Rust standard library (MIT OR Apache-2.0). The list
  comes from `cargo metadata --filter-platform wasm32-unknown-unknown` on the built source
  tree: gliner-rs's normal dependency edges, transitively. It leaves out build- and
  dev-dependencies and the proc-macro crates (with what only they need), which run on the build
  host and are never linked. It also leaves out `onig` and `onig_sys`, which cargo metadata
  lists only because it unifies features across platforms (candle-core turns on tokenizers'
  `onig` elsewhere); `cargo tree -e normal,no-proc-macro --target wasm32-unknown-unknown` does
  not name them and the wasm32 build never compiles them. The file's header records each
  choice. Licences: 72 crates offer MIT or Apache-2.0 (5 more in the old `MIT/Apache-2.0` form),
  23 are MIT, 5 Apache-2.0, 2 Unicode-3.0 (`yoke`, `zerofrom`) and 1 Zlib (`foldhash`); 7
  offer MIT or Apache-2.0 among other choices (Zlib, BSD-2-Clause, BSL-1.0, the Unlicense),
  and `unicode-ident` is `(MIT OR Apache-2.0) AND Unicode-3.0`. The licence texts are in each
  crate's source as published on crates.io (`https://crates.io/crates/<name>/<version>`).

## Relate

- **What:** Relate 1.3.0's WASM bundle: `relate.js`, `relate_bg.wasm`, `trap.js`
  and `snippets/relate-wasm-<hash>/js/opfs.js`. The native 1.3.0 CLI and Python binding,
  the repository's engine, run the round trips in `harness/native.py`, and are not shipped.
- **Source:** npm's `@relate/relate-wasm@1.3.0` (provenance-signed), installed by `npm ci`
  from `package-lock.json`, whose sha512 integrity is the pin.
- **Licence:** Apache-2.0 (the package's `license` field). The package ships no licence file, so
  Relate's `LICENSE` at tag `v1.3.0` of [relatedb/relate](https://github.com/relatedb/relate) is
  committed as `data/LICENSE-relate.txt` (`build.mjs` checks its sha256) and served beside the
  bundle as `assets/relate-1.3.0/LICENSE.txt`. The deployed site serves a copy of the pinned bundle
  under `assets/relate-1.3.0/`.

## NVL (Neo4j Visualization Library) 2.0.0

- **What:** `@neo4j-nvl/base`, `@neo4j-nvl/interaction-handlers` and, through base,
  `@neo4j-nvl/layout-workers`, all 2.0.0. `npm run vendor` bundles them with esbuild 0.28.2
  into `web/vendor/nvl.js` and `web/vendor/HierarchicalLayout.worker.js`. Those files are
  gitignored, and `dist/` serves them under `assets/nvl-2.0.0/`.
- **Source:** npm, at exactly 2.0.0 (`package-lock.json`). `npm run vendor` copies NVL's
  `LICENSE.txt` beside the bundle as `NVL-LICENSE.txt`. esbuild writes the licence comments
  it found into `nvl.js.LEGAL.txt` and `HierarchicalLayout.worker.js.LEGAL.txt`.
- **Licence:** proprietary. NVL's `LICENSE.txt` allows use only with Neo4j Aura or with
  Neo4j's commercial products under a subscription agreement. **In this repository and its
  public demo site, with Relate, NVL is used with Neo4j's permission (confirmed by the
  repository owner on 2026-10-08).**
- **Bundled with it** (esbuild's metafile; Segment's analytics, which `@neo4j-nvl/base`
  imports, is tree-shaken out):

  | Package | Version | Licence |
  |---|---|---|
  | `@dagrejs/dagre` (also in the worker) | 3.1.1 | MIT, © Chris Pettitt |
  | `bin-pack` (also in the worker) | 1.0.2 | MIT, © Bryan Burgers |
  | `concaveman` | 1.2.1 | ISC, © Mapbox |
  | `lodash` | 4.18.1 | MIT, © OpenJS Foundation and other contributors |
  | `point-in-polygon` | 1.1.0 | MIT, © James Halliday |
  | `rbush` | 3.0.1 | MIT, © Vladimir Agafonkin |
  | `robust-predicates` | 2.0.4 | Unlicense |
  | `tinyqueue` | 2.0.3 | ISC, © Vladimir Agafonkin |

  `@neo4j-nvl/base`'s own `dist/base.mjs` bundles, according to its `base.mjs.LICENSE.txt`:
  - the browser `buffer` module (MIT, Feross Aboukhadijeh);
  - `ieee754` (BSD-3-Clause, Feross Aboukhadijeh);
  - `regenerator-runtime` (MIT, Facebook);
  - `safe-buffer` (MIT, Feross Aboukhadijeh);
  - lodash (MIT).

## The Ontology Graph Specification 1.1 schema (`data/ontology-spec/`)

- **What:** the JSON Schema (draft 2020-12) of the Neo4j Ontology Graph Specification 1.1.0, the
  format of every ontology here. Copied byte for byte as
  `data/ontology-spec/ontology-graph-spec.schema.json`. `web/ogs.js` carries the same schema as a
  JavaScript object (pinned equal to the file in `expected/ontology.txt`) and interprets it.
- **Source:** [neo4j/ontology-graph-spec](https://github.com/neo4j/ontology-graph-spec), tag
  `release/v0.13.0`, commit `d3b4ec6de7d570139e3ba3aef5d64990155440e4` (2026-11-26), the same bytes
  <https://neo4j.com/docs/ontology-graph-spec/1.1.0/schema.json> serves (and the same blobs as at the
  previous pin, `release/v0.12.2`: the schema did not change).
  [`data/ontology-spec/SOURCE.md`](data/ontology-spec/SOURCE.md) has the blob hashes.
- **Licence:** Apache-2.0. The repository's `LICENSE`, copied unchanged, travels with the schema
  as `data/ontology-spec/LICENSE-graph-spec.txt`, in the repo and in `dist/`. No NOTICE file.

## The Ontology Graph Spec SDK 0.13.0

- **What:** the spec's official library. Through `lib/ogs.mjs` it decodes every ontology document
  and runs its core validation, in the page, the worker and the Node harness.
- **Source:** npm, `@neo4j/ontology-graph-spec@0.13.0` (pinned in `package.json` and
  `package-lock.json`), built from [neo4j/ontology-graph-spec](https://github.com/neo4j/ontology-graph-spec)
  at tag `release/v0.13.0`. The package is Kotlin/JS output spread over 13 modules; `npm run vendor`
  bundles them with esbuild into `web/vendor/ontology-graph-spec.js`, which `dist/` serves as
  `assets/ontology-graph-spec-0.13.0/ontology-graph-spec.js`.
- **Licence:** Apache-2.0. The npm package ships no licence file and its metadata names none: the
  repository's `LICENSE` (the same text as `data/ontology-spec/LICENSE-graph-spec.txt`) travels as
  `LICENSE.txt` beside the bundle. The Kotlin libraries compiled into it are Apache-2.0:
  - the Kotlin standard library 2.3.20;
  - kotlinx.serialization 1.10.0;
  - kotlinx.coroutines and kotlinx-atomicfu;
  - kotlin-wrappers, with seskar;
  - yamlkt 0.13.0.

  `THIRD_PARTY.txt` beside the bundle lists them.

## js-yaml 4.3.2

- **What:** parses ontology documents (YAML, and JSON as YAML) and writes them as YAML, in the
  page and in the Node harness.
- **Source:** npm, `js-yaml@4.3.2`. `dist/` serves its ESM build as
  `assets/js-yaml-4.3.2/js-yaml.js` with its `LICENSE.txt`.
- **Licence:** MIT, © 2011-2015 Vitaly Puzrin.

## Development only

None of these is shipped:

- esbuild 0.28.2 (MIT): bundles NVL and the Ontology Graph Spec SDK;
- Playwright 1.63.0 (Apache-2.0) and its Chromium: the browser section and the smoke test;
- `@raphael.mansuy/edgextract` 0.1.0 (Apache-2.0): the parity oracle for the ported splitter and names;
- ajv 8.20.0 (MIT): the second JSON Schema validator `harness/ontology.mjs` checks `web/ogs.js`
  against;
- Python `gliner2` 2.0.0 (Apache-2.0) and torch: only in `harness/reference.py`'s uv side env
  (`./run.sh --reference`);
- the native Relate 1.3.0 CLI and the `relate-db` 1.3.0 Python binding (Apache-2.0), the
  repository's engine: the native section.
