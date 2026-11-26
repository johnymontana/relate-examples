# Third-party code, data and models in example 02

Each entry names what the example uses, where it comes from, the pinned version and the
licence, and whether it ships in the static site. `npm run build` copies this file into
`dist/` as `THIRD_PARTY.md`, and the page's footer links to it.

Shipped in `dist/` (what the GitHub Pages site serves for this example):

| Path in `dist/` | Component | Licence |
|---|---|---|
| `assets/relate-1.3.0/`: `relate.js`, `relate_bg.wasm`, `trap.js`, `snippets/relate-wasm-19215b5d5f97ddd6/js/opfs.js`, `LICENSE.txt` | Relate 1.3.0, WASM build (npm `@relate/relate-wasm`) | Apache-2.0 (`LICENSE.txt`: Relate's `LICENSE` at tag v1.3.0, sha256-pinned) |
| `assets/web-llm-0.2.89/`: `web-llm.js`, `LICENSE.txt` | WebLLM 0.2.89 (npm `@mlc-ai/web-llm`), minified into one module by `build.mjs`, with the runtimes it inlines (Apache TVM's WebGPU runtime, XGrammar, tokenizers-cpp) | Apache-2.0 |
| `assets/ontology-graph-spec-0.13.0/`: `ontology-graph-spec.js`, `LICENSE.txt`, `THIRD_PARTY.txt` | the Ontology Graph Spec SDK 0.13.0 (npm `@neo4j/ontology-graph-spec`), minified into one module, with the Kotlin libraries compiled into it (listed in `THIRD_PARTY.txt`) | Apache-2.0 (`LICENSE.txt`: neo4j/ontology-graph-spec's `LICENSE` at release/v0.13.0); the Kotlin libraries Apache-2.0 |
| `assets/nvl-2.0.0/`: `nvl.js`, `HierarchicalLayout.worker.js`, their `.LEGAL.txt`, the files those refer to (`base.mjs.LICENSE.txt`, `dagre.esm.js.LEGAL.txt`), `NVL-LICENSE.txt`, `THIRD_PARTY-npm.txt` and one `LICENSE-<package>-<version>.txt` per bundled npm package | NVL 2.0.0, the Neo4j Visualization Library, bundled from the same entry example 01 uses (only packages that put bytes into the bundle are shipped and listed) | proprietary, used with Neo4j's permission (confirmed by the repository owner on 2026-10-08); the dependencies MIT, ISC, Unlicense |
| `assets/js-yaml-4.3.2/`: `js-yaml.js`, `LICENSE.txt` | js-yaml 4.3.2 | MIT |
| `data/corporate-events.ontology.yaml`, `data/demo-graph.json`, `data/canned.json`, `data/SOURCE.md` | the ontology, the demo graph and the reference queries of the repository owner's ontospec-knowledge-graph-extraction project (`data/SOURCE.md`); the companies, people and events are fictional | this repository's licence |
| `app.js`, `engine.worker.js`, `llm.worker.js`, `index.html`, `style.css`, `favicon.svg` | this repository: `web/` and `lib/` bundled by esbuild; `briefing.js`, `validate.js`, `ddl.js`, `compare.js` and `canned.js` port the source project's Python | this repository's licence |

Fetched by the page at run time, never shipped:

| What | From | Licence |
|---|---|---|
| Qwen3.5 2B and Qwen3.5 4B, q4f16_1 MLC conversions (`mlc-ai/Qwen3.5-2B-q4f16_1-MLC` at `dd74e9c`, `mlc-ai/Qwen3.5-4B-q4f16_1-MLC` at `44b4246`) | the Hugging Face Hub, when the visitor loads a model; WebLLM checks the chat config and tokenizer against SRI hashes `web/llm.js` pins | Apache-2.0 (the base models `Qwen/Qwen3.5-2B` and `Qwen/Qwen3.5-4B`) |
| the WebGPU model libraries `Qwen3.5-2B-q4f16_1_cs1k-webgpu.wasm` and `Qwen3.5-4B-q4f16_1_cs1k-webgpu.wasm` | `mlc-ai/binary-mlc-llm-libs` at commit `5b7251f` (raw.githubusercontent.com), checked against SRI hashes | the repository carries no licence file, so the libraries are fetched from it and not redistributed here |

Not shipped:
- `data/reference/` (the Python originals the ports are held to);
- `data/LICENSE-*.txt` (they ship under `assets/`);
- the harnesses and the development tools.

## Development only

None of these is shipped:

- esbuild 0.28.2 (MIT): bundles the page's modules, WebLLM, the SDK and NVL;
- Playwright 1.63.0 (Apache-2.0) and its Chromium: the browser section. `harness/llm-eval.mjs`
  drives the system Chrome through it;
- the native Relate 1.3.0 `relate-db` Python binding (Apache-2.0), the repository's engine: the
  native section;
- Python with PyYAML and jsonschema, in a throwaway uv env: `harness/capture_reference.py`, run by
  hand against the source project.
