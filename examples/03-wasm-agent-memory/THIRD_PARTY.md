# Third-party code, fonts, brand assets and data in example 03

Each entry names what the example uses, where it comes from, the pinned version and the licence,
and whether it ships in the static site. `npm run build` copies this file into `dist/` as
`THIRD_PARTY.md`, and the page's footer links to it.

Shipped in `dist/` (what the GitHub Pages site serves for this example):

| Path in `dist/` | Component | Licence |
|---|---|---|
| `assets/relate-1.2.0/`: `relate.js`, `relate_bg.wasm`, `trap.js`, `snippets/relate-wasm-dd0c6225f894802b/js/opfs.js`, `LICENSE.txt` | Relate 1.2.0, WASM build (npm `@relate/relate-wasm`) | Apache-2.0 (`LICENSE.txt`: Relate's `LICENSE` at tag v1.2.0, sha256-pinned) |
| `assets/nvl-2.0.0/`: `nvl.js`, `HierarchicalLayout.worker.js`, their `.LEGAL.txt`, the files those refer to (`base.mjs.LICENSE.txt`, `dagre.esm.js.LEGAL.txt`), `NVL-LICENSE.txt`, `THIRD_PARTY-npm.txt` and one `LICENSE-<package>-<version>.txt` per bundled npm package | NVL 2.0.0, the Neo4j Visualization Library, bundled from the same entry examples 01 and 02 use (only packages that put bytes into the bundle are shipped and listed) | proprietary, used with Neo4j's permission (confirmed by the repository owner on 2026-10-08); the dependencies MIT, ISC, Unlicense |
| `assets/public-sans-5.3.0/`: `public-sans-latin-wght-normal.woff2`, `LICENSE.txt` | Public Sans (variable, latin subset), from npm `@fontsource-variable/public-sans` 5.3.0 | SIL Open Font License 1.1 |
| `assets/ibm-plex-mono-5.3.0/`: `ibm-plex-mono-latin-{400,500,600}-normal.woff2`, `LICENSE.txt` | IBM Plex Mono (latin subset), from npm `@fontsource/ibm-plex-mono` 5.3.0 | SIL Open Font License 1.1 |
| `assets/relate-brand-1.0/`: `relate-logo-navy.svg`, `relate-logo-white.svg`, `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `archie-mascot.svg`, `archie-mascot-flair.svg`, `README.txt` | the Relate logo, favicon and mascot, from the Relate brand kit v1.0 (November 2026), supplied by the repository owner (`data/brand/`), unmodified, with the kit's own README | Relate's trademarks, used as the kit's rules say (`README.txt`). They are not under this repository's licence: do not reuse them outside the kit's rules. |
| `data/scenarios/team.json`, `trip.json`, `code.json`, `data/SOURCE.md` | the scripted conversations, written for this example; the people and projects are invented | this repository's licence |
| `app.js`, `engine.worker.js`, `index.html`, `style.css` | this repository: `web/` and `lib/relate_wasm.mjs`, bundled by esbuild | this repository's licence |

Nothing is fetched at run time from another origin: the page's `connect-src` is `'self'`.

The memory model and the shape of the recall statement follow Relate's cookbook recipes on agent
memory and hybrid recall (<https://relatedb.ai/cookbook/>, Apache-2.0). No text, data or statement
is copied from them (`data/SOURCE.md`).

The page's colours are the brand kit's (`data/brand/relate-colors.json`).

## Development only

None of these is shipped:

- esbuild 0.28.2 (MIT): bundles the page's modules and NVL;
- Playwright 1.63.0 (Apache-2.0) and its Chromium: the browser section;
- the native Relate 1.2.0 `relate-db` Python binding (Apache-2.0), the repository's engine: the
  native section.
