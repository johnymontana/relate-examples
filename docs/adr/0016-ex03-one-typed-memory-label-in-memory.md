# Example 03's memory is one typed label, in a store that lives in memory

Status: accepted · Decided: 2026-11-24 (03's D2, D4; M1, M2) · Scope: example 03

Example 03's memory model follows Relate's own agent-memory recipes: messages in sessions, the
entities they mention, and facts and decisions drawn from messages, where a newer one supersedes
the older one in its slot and nothing is deleted. Two things differ here, and both are deliberate.

**One `:Memory` label, with a `kind`** (D2). The recipes use two labels, `:Fact` and `:Decision`.
A graph type allows one source label and one target label per relationship type (01's R16), so
`ABOUT`, `FROM` and `SUPERSEDES` cannot start from both. With one label, a graph type can hold the
whole model: four labels and five relationship types, every property typed, the vector included
(`VECTOR<FLOAT32>(256) NOT NULL`). The engine then refuses a malformed memory on every write (M1),
which matters when the writer is an agent. A `current` flag sits beside `SUPERSEDES`, so recall
filters on a property instead of a missing edge.

**The store is in memory, rebuilt when a conversation starts** (D4), as example 02's is (ADR-0013).
The conversations are scripted and small, so there is nothing to keep, and an in-memory store has no
lock between tabs (R11) and no layout to migrate. What the page calls a new session is a divider in
one conversation on one store, not a new process: the README says so.

Writes follow ADR-0006: remember is three statements of `MERGE`s, and running them again changes
nothing (`expected/scenarios.txt` replays every one). There is no completion marker, because nothing
reads a half-written store: a worker that traps takes the store with it, and the page says so and
starts again.

## Considered options

- **An OPFS store, so the memory survives a reload**: that is what agent memory is for, and it would
  make the point without a divider. It also brings one opener per store across tabs, a store written
  by an older build of the page to migrate, and a scripted conversation to reconcile with whatever
  the store already holds. Left out of this version.
- **Two labels and no endpoints in the graph type**: closer to the recipes, but the engine would
  then accept an `ABOUT` edge between any two nodes. Rejected.
- **No graph type**: the page would still work. It would no longer show that the shape of a memory
  is something the database enforces. Rejected.
