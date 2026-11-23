# The browser-examples site

One static GitHub Pages project site serves this repository's browser examples: an index page at
<https://johnymontana.github.io/relate-examples/> and each example under its own path (example 01
at `/relate-examples/01-wasm-extract/`). There is no server code: pages, WASM and data run in the
visitor's browser. The site goes live once the repository is pushed and Pages is enabled with
"GitHub Actions" as its source (Settings > Pages).

| File | Role |
|---|---|
| `site/build.mjs` | Collects every `examples/*/site.json` example into `site/dist/` and writes the index page and an empty `.nojekyll`. It runs each example's `build` first (`--no-build` or `SITE_PREBUILT=1` only collects existing `dist/` directories) and fails, writing no site, on any problem listed below. |
| `site/index.template.html`, `site.css`, `favicon.svg` | The index page, with its own CSP `<meta>`. `{{EXAMPLES}}` becomes one entry per example, sorted by `path`. |
| `.github/workflows/pages.yml` | Builds `site/dist` (the gliner-rs WASM build, `npm ci --omit=peer`, the NVL vendor bundle, `node site/build.mjs`) and deploys it with `actions/upload-pages-artifact` and `actions/deploy-pages` once `examples.yml` has passed on a push to `main` (`workflow_run`, building that run's commit), or on demand. |
| `lib/tests/test_site_build.py` | Tests `build.mjs` on fake example trees. |

```bash
node site/build.mjs                 # build every example, then collect them into site/dist/
node site/build.mjs --no-build      # collect existing dist/ directories only
node site/build.mjs --out <dir>     # write the site elsewhere
```

## The contract for a browser example

An example joins the site by adding `examples/<name>/site.json`; no site code changes:

```json
{
  "title": "…", "description": "…",
  "path": "01-wasm-extract",
  "build": "npm run build", "dist": "dist",
  "connect": ["https://huggingface.co", "https://*.hf.co"],
  "requires": ["wasm"],
  "browser": "optional: one sentence on what the visitor's browser needs or downloads",
  "credits": ["optional: one line per third-party component the page ships or fetches"]
}
```

- **Strict validation.** Unknown fields are refused. `path` is one URL segment of `[a-z0-9-]`,
  unique across examples. `dist` is a relative path inside the example. Each `connect` entry is an
  origin (`https://` or `wss://`, a lower-case host whose first label may be `*`, no path). Each
  `requires` entry is an `EXAMPLES_REQUIRE` key naming what `build` needs (01: `wasm`, the gliner-rs build and npm packages; not `gliner`, since the page fetches the weights itself); the build prints them and does not check them.
- **`build`** runs through the shell in the example's directory and must write `dist`
  deterministically.
- **`dist`** holds `index.html` at its root, regular files only, and must work from any sub-path:
  `build.mjs` fails on a root-absolute (`"/x"`) or protocol-relative (`"//x"`) reference outside
  comments (attributes, import maps, imports, workers, `fetch`, `new URL`, CSS). A link back to the
  index is `../`.
- **Every HTML page carries its own Content-Security-Policy `<meta>`**, inside `<head>` and before
  any script, because Pages sets no response headers. `build.mjs` refuses a page without one or with
  two, and a policy with a directive a meta policy ignores (`frame-ancestors`, `report-uri`,
  `report-to`, `sandbox`); and it checks that the policy's `connect-src` (else `default-src`) allows
  every `connect` origin.
- **Every per-origin storage name is prefixed** with the example's own prefix, because all examples
  share the `johnymontana.github.io` origin (OPFS, Cache Storage, `localStorage`, IndexedDB,
  `BroadcastChannel`); example 01 uses `ex01`.

## What GitHub Pages does and does not do

- It serves the files as they are, with no custom headers: no `frame-ancestors`, no
  `X-Content-Type-Options`, and no CSP for workers (a worker's policy comes only from its own
  response headers). The `<meta>` policy covers each page.
- It sends `Cache-Control: max-age=600` on every file and has no immutable caching, so unchanging
  files live under versioned directories (`assets/<name>-<version>/`): a new version is a new URL.
- It redirects a directory URL without its trailing slash (301) and answers 404 for anything else
  that is not a file.
- `.nojekyll` turns off the Jekyll pass, so files whose names start with `_` are published.

Locally, `examples/01-wasm-extract/harness/serve.mjs --site` (or that example's `./run.sh --site`)
serves its `dist/` the same way, under `/relate-examples/`, and its browser test runs against that
server. A deployed site has a smoke test:
`node examples/01-wasm-extract/harness/drive.mjs --smoke --base-url https://johnymontana.github.io/relate-examples/01-wasm-extract/`.
