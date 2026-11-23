# Example 02's store lives in memory, under a graph type derived from the ontology

Status: accepted · Decided: 2026-11-23 (02's D2; P1, P3, P6, P7) · Scope: example 02

Example 02's graph is a fixed demo: 38 nodes and 43 relationships. It loads in milliseconds, so the
store is **in memory and rebuilt on every visit** (D2). There is no OPFS store. That means no lock
between tabs (R11), no store layout to migrate, and no state a visitor could corrupt.

**The ontology is the engine's contract, not only the prompt's.** `web/ddl.js` derives a typed
graph type from the ontology and applies it first. Every declared property gets its type, plus
`NOT NULL` for `key` and `must_exist`. Every relationship type gets its single source and target
label. The source app's DDL then runs unchanged, followed by the graph. Relate refuses every write
the ontology forbids (P3). The order is forced: the graph type owns the existence constraints on its
labels (P1), and an `ALTER` drops the constraints already there (P2).

**Generated queries run on the writable store**, behind two guards:
- the ontology check refuses every write clause;
- a run whose stats counters move (P7) triggers a rebuild from the demo graph before anything else
  reads the store.

A read-only in-memory handle cannot be used, because it starts empty and cannot be loaded (P6).

## Considered options

- **An OPFS store, as in example 01**: this persists something that never changes, and it brings
  locks and migrations. Rejected.
- **A graph type with only the endpoints**: it conflicts with the source DDL's existence constraints
  (P1). Rejected for the fully typed graph type.
