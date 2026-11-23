# All examples share one origin, so every storage name carries the example's prefix

Status: accepted · Decided: b26e6cd; the library exception 2026-11-23 · Scope: repository

Every example on the site is served from `johnymontana.github.io` (ADR-0002), so every example
shares one browser origin. OPFS, Cache Storage, IndexedDB, `localStorage` and `BroadcastChannel`
are all per origin. Without a convention, one example could open, overwrite or lock another's store,
or evict its cache.

Every name an example creates in per-origin storage therefore starts with the example's prefix:
`ex01-kg-<slug>` and `ex01-models-v1`, `localStorage` keys `ex01.*`, and so on. Environment
variables follow the same scheme (`EX01_PORT`, `EX02_PORT`).

**The one exception** is a library that names its own storage and has no option to rename it.
WebLLM 0.2.89 in example 02 caches under `webllm/model`, `webllm/config` and `webllm/wasm` (02's
NOTES W1). These caches are keyed by the model's URL, so two examples that pinned the same model
would share one download, which is harmless. The example's `NOTES.md` must record every such name,
and `site/README.md` lists them.

## Considered options

- **One subdomain or repository per example**: this would give each example its own origin, but it
  would split the one site and its one CI.
- **Patching WebLLM's cache names**: this would mean maintaining a fork of a minified bundle.
  Rejected; the exception is documented instead.
