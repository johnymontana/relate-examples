# WASM writes are idempotent, with a completion marker written last

Status: accepted · Decided: b26e6cd (example 01's D9) · Scope: repository

Relate's WASM build has no transactions: every `execute` autocommits (01's NOTES R2). Several other
things can stop a write partway through:
- a worker terminated by the watchdog;
- a WebAssembly trap, after which the handle is unusable (R14);
- a closed tab.

Code that writes to a store from WASM therefore writes only `MERGE`s and other idempotent
statements, so running the same unit again is safe. It writes a completion marker last, and readers
treat a unit without its marker as unfinished. Example 01 re-applies such a section on
**Continue**.

Example 02 has a different situation. Its store is in memory and rebuilt on every visit
(ADR-0013). It never writes after loading, and it detects an accidental write by the moved stats
counters (P7), then rebuilds.

## Considered options

- **Emulating transactions** with a staging label and a final swap: this doubles every write, and a
  trap can still interrupt the swap. Rejected.
