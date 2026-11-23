# Example 01 extracts with GLiNER2.5 in WASM, in one worker that owns an OPFS store

Status: accepted · Decided: b26e6cd (01's D4, D6, D11, D13, D14) · Scope: example 01

Example 01 turns markdown into a knowledge graph entirely in the tab. The extraction model is
GLiNER2.5 (small-v1 by default), run by gliner-rs v0.3.1 compiled to WebAssembly (D4). It scores
every candidate span against the ontology's labels, and the page's cutoffs need exactly that: each
candidate goes to keep, review or drop. The model runs without WebGPU, and the weights (304 MB) are
fetched once and cached.

**The store** is Relate's WASM build on OPFS: one store per ontology (`ex01-kg-<slug>`, D14). It
persists across visits, and it downloads as a snapshot that native Relate opens (D17).

**One dedicated worker owns everything** (D6). It holds both synchronous WASM instances, Relate and
gliner-rs. Three facts force this shape:
- Pages gives no COOP/COEP, so there is no SharedArrayBuffer (ADR-0002);
- OPFS sync access is worker-only;
- OPFS allows one opener per store, read-only included (R11).

The read-only Cypher console therefore *borrows* the store, one statement per lease: the engine
calls `free()`, the console opens the store read-only and runs the statement, then the engine
reopens it (D11).

**The page's modules are served unbundled** (D13). `build.mjs` rewrites Node-style specifiers to
versioned asset paths. An import map is not an option: the CSP allows no inline script, and module
workers ignore import maps.

## Consequences

- WASM memory never shrinks (R13), so the worker is recycled every 10 extractions. A trap (R14)
  replaces it. Every reopen retries `storage locked`.
- Writes follow ADR-0006.
