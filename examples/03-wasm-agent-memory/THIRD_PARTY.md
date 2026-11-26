# Third-party code, fonts, brand assets and data in example 03

Each entry names what the example uses, where it comes from, the pinned version and the licence,
and whether it ships in the static site. `npm run build` copies this file into `dist/` as
`THIRD_PARTY.md`, and the page's footer links to it.

Shipped in `dist/` (what the GitHub Pages site serves for this example):

| Path in `dist/` | Component | Licence |
|---|---|---|
| `assets/relate-1.2.0/`: `relate.js`, `relate_bg.wasm`, `trap.js`, `snippets/relate-wasm-dd0c6225f894802b/js/opfs.js`, `LICENSE.txt` | Relate 1.2.0, WASM build (npm `@relate/relate-wasm`) | Apache-2.0 (`LICENSE.txt`: Relate's `LICENSE` at tag v1.2.0, sha256-pinned) |
| `assets/nvl-2.0.0/`: `nvl.js`, `HierarchicalLayout.worker.js`, their `.LEGAL.txt`, the files those refer to (`base.mjs.LICENSE.txt`, `dagre.esm.js.LEGAL.txt`), `NVL-LICENSE.txt`, `THIRD_PARTY-npm.txt` and one `LICENSE-<package>-<version>.txt` per bundled npm package | NVL 2.0.0, the Neo4j Visualization Library, bundled from the same entry examples 01 and 02 use (only packages that put bytes into the bundle are shipped and listed) | proprietary, used with Neo4j's permission (confirmed by the repository owner on 2026-10-08); the dependencies MIT, ISC, Unlicense |
| `assets/transformers-4.3.2/`: `transformers.js`, `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm`, `LICENSE.txt`, `LICENSE-onnxruntime.txt`, `LICENSE-huggingface-tokenizers-0.2.0.txt`, `LICENSE-huggingface-jinja-0.5.13.txt`, `THIRD_PARTY-npm.txt` | Transformers.js 4.3.2 (npm `@huggingface/transformers`), minified into one module with the onnxruntime-web glue it imports (onnxruntime-web 1.31.0-dev.20260914-8d85527a0 and onnxruntime-common, the versions Transformers.js pins) and the tokenizer and template libraries its own build inlines; and onnxruntime-web's WebAssembly build, unmodified. Loaded only when the visitor types a text the page has no vector for | Transformers.js, `@huggingface/tokenizers` and `@huggingface/jinja`: Apache-2.0 and MIT, each package's own `LICENSE`. onnxruntime: MIT. Its npm packages ship no licence file, so `LICENSE-onnxruntime.txt` is the MIT License with the copyright line of the packages' source headers (NOTES.md T4) |
| `assets/public-sans-5.3.0/`: `public-sans-latin-wght-normal.woff2`, `LICENSE.txt` | Public Sans (variable, latin subset), from npm `@fontsource-variable/public-sans` 5.3.0 | SIL Open Font License 1.1 |
| `assets/ibm-plex-mono-5.3.0/`: `ibm-plex-mono-latin-{400,500,600}-normal.woff2`, `LICENSE.txt` | IBM Plex Mono (latin subset), from npm `@fontsource/ibm-plex-mono` 5.3.0 | SIL Open Font License 1.1 |
| `assets/relate-brand-1.0/`: `relate-logo-navy.svg`, `relate-logo-white.svg`, `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `archie-mascot.svg`, `archie-mascot-flair.svg`, `README.txt` | the Relate logo, favicon and mascot, from the Relate brand kit v1.0 (November 2026), supplied by the repository owner (`data/brand/`), unmodified, with the kit's own README | Relate's trademarks, used as the kit's rules say (`README.txt`). They are not under this repository's licence: do not reuse them outside the kit's rules. |
| `data/scenarios/team.json`, `trip.json`, `code.json`, `data/SOURCE.md` | the scripted conversations, written for this example; the people and projects are invented | this repository's licence |
| `data/embeddings.json` | the vectors of the scripts' texts, computed with all-MiniLM-L6-v2 (below) by `harness/embed.mjs` | this repository's licence (the texts are its own; the model is Apache-2.0) |
| `data/agent-memory.ontology.json` | the memory model as a document of the Neo4j Ontology Graph Specification 1.1.0, written for this example (`data/SOURCE.md`). It names the specification's JSON Schema by its URL and carries none of it | this repository's licence (the specification is Apache-2.0) |
| `app.js`, `engine.worker.js`, `embed.worker.js`, `index.html`, `style.css` | this repository: `web/` and `lib/relate_wasm.mjs`, bundled by esbuild | this repository's licence |

Fetched at run time, never shipped, and only when the visitor types a text the page has no vector
for (the page's `connect-src` allows `https://huggingface.co` and `https://*.hf.co` for this alone):

| What | From | Licence |
|---|---|---|
| all-MiniLM-L6-v2, as the ONNX conversion `Xenova/all-MiniLM-L6-v2`, 8-bit quantised: `config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model_quantized.onnx` (23 MB) | the Hugging Face Hub, at revision `751bff37182d3f1213fa05d7196b954e230abad9`; each file is checked against the sha256 pinned in `web/embed.js` before it is used | Apache-2.0 (the model, by the sentence-transformers project, and the conversion) |

The memory model and the shape of the recall statement follow Relate's cookbook recipes on agent
memory and hybrid recall (<https://relatedb.ai/cookbook/>, Apache-2.0). No text, data or statement
is copied from them (`data/SOURCE.md`).

The page's colours are the brand kit's (`data/brand/relate-colors.json`).

## Development only

None of these is shipped:

- esbuild 0.28.2 (MIT): bundles the page's modules and NVL;
- the Neo4j Ontology Graph Spec SDK 0.12.2 (npm `@neo4j/ontology-graph-spec`, Apache-2.0):
  `harness/run.mjs` validates `data/agent-memory.ontology.json` with it;
- Playwright 1.63.0 (Apache-2.0) and its Chromium: the browser section, and `harness/embed.mjs`;
- onnxruntime-node and sharp, which npm installs as dependencies of Transformers.js: nothing here
  loads them;
- the native Relate 1.2.0 `relate-db` Python binding (Apache-2.0), the repository's engine: the
  native section.
