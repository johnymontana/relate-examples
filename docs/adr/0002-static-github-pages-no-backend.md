# Browser examples are static pages on GitHub Pages, with no backend

Status: accepted · Decided: b26e6cd (example 01's D19); 02 joined 2026-11-23 · Scope: repository

The browser examples show what Relate's WASM build can do on its own. A server would blur that
point, and it would also cost money and need looking after. So every browser example is a static
`dist/` served from one GitHub Pages project site
(<https://johnymontana.github.io/relate-examples/>). The database, the model and the data all run
in the visitor's tab. Anything the page fetches at run time comes from public hosts named in its
`site.json` `connect` list (model weights from the Hugging Face Hub, for example).

## Consequences

GitHub Pages sets no custom headers, and the following rules follow from that. `site/build.mjs`
enforces them and `site/README.md` lists them.

- Every page carries exactly one CSP `<meta>`, before any script. Directives a meta policy ignores
  are refused.
- No COOP/COEP headers means no SharedArrayBuffer. Example 01 keeps its database and its model in
  one worker (ADR-0010).
- Every file is served with `max-age=600` and nothing is cached as immutable. Unchanging files live
  under versioned `assets/<name>-<version>/` paths, so a new version gets a new URL.
- Every URL is relative, so a page works under any sub-path. A `.nojekyll` file turns off Jekyll.
- `lib/serve.mjs` emulates Pages locally (base `/relate-examples/`, a 301 to the trailing slash, 404
  otherwise). Every browser test runs against it, so it must stay faithful.
- A visitor's browser decides what works. Each example says what it needs (`site.json` `browser`)
  and degrades rather than failing. Example 02, for instance, uses canned queries without WebGPU
  (ADR-0012).

Deployment runs only after CI passes: `pages.yml` runs on `examples.yml`'s `workflow_run` and
builds the commit that passed.

## Considered options

GitHub Pages with no backend is a requirement from the repository owner, not a preference. It rules
out two alternatives:
- **A small server**, such as the FastAPI app example 02 was ported from.
- **A static host that sets custom headers.** Such a host would allow COOP/COEP and worker CSPs. A
  page that relied on them would break on Pages.
