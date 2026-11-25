# Architecture decision records

Each file here records one decision that shapes this repository: one that would be costly to
reverse, that a reader would find surprising without context, and that came from a real choice
between alternatives. If any of the three is missing, it is not an ADR. A behaviour of the engine or
of a library goes in the example's `NOTES.md` as a row with a minimal repro. A small design choice
the code cites goes there too, as a design id.

`ADR-NNNN` always means a file in this directory. Relate's own ADR numbers are never cited here
(AGENTS.md, "Citations").

## Index

| ADR | Decision | Scope |
|---|---|---|
| [0001](0001-record-decisions-as-adrs.md) | Record architectural decisions as ADRs | repository |
| [0002](0002-static-github-pages-no-backend.md) | Browser examples are static pages on GitHub Pages, with no backend | repository |
| [0003](0003-one-origin-prefixed-storage-names.md) | All examples share one origin, so every storage name carries the example's prefix | repository |
| [0004](0004-offline-byte-stable-runs.md) | Each example's regression test is an offline, byte-stable run diffed against `expected/` | repository |
| [0005](0005-one-relate-version-everywhere.md) | One Relate version across the CLI, the Python binding and the WASM build, upgraded together | repository |
| [0006](0006-idempotent-writes-without-transactions.md) | WASM writes are idempotent, with a completion marker written last | repository |
| [0007](0007-ontology-graph-spec-official-sdk.md) | Ontologies are Ontology Graph Spec 1.1 documents, read through the official SDK | repository |
| [0008](0008-shared-lib-examples-own-pins.md) | Shared code lives in a plain `lib/`, and each example owns its dependency pins | repository |
| [0009](0009-what-third-party-code-ships.md) | Ship only what may be redistributed, with its notices; fetch the rest at run time | repository |
| [0010](0010-ex01-extraction-in-one-worker-on-opfs.md) | Example 01 extracts with GLiNER2.5 in WASM, in one worker that owns an OPFS store | example 01 |
| [0011](0011-ex02-a-port-held-to-the-source.md) | Example 02 is a port, held byte for byte to the source app's outputs | example 02 |
| [0012](0012-ex02-webllm-qwen-canned-fallback.md) | Example 02 writes queries with WebLLM on WebGPU, and uses canned queries without it | example 02 |
| [0013](0013-ex02-in-memory-store-under-ontology-graph-type.md) | Example 02's store lives in memory, under a graph type derived from the ontology | example 02 |
| [0014](0014-ex03-scripted-agent-real-memory.md) | Example 03's agent is scripted, and its memory is real (superseded by ADR-0017) | example 03 |
| [0015](0015-ex03-nvl-in-relate-brand.md) | Example 03 draws the memory with NVL, in Relate's brand | example 03 |
| [0016](0016-ex03-one-typed-memory-label-in-memory.md) | Example 03's memory is one typed label, in a store that lives in memory | example 03 |
| [0017](0017-ex03-real-embeddings-scripted-agent.md) | Example 03's agent is scripted; its memory and its vectors are real | example 03 |
| [0018](0018-ci-runs-what-a-pull-request-changed.md) | On a pull request, CI runs the examples whose inputs changed; on `main`, all of them | repository |

## Writing one

- Number it one past the highest number here. Name it `NNNN-short-slug.md` and add it to the index.
- Start with the title, then one line: `Status: … · Decided: <date or commit> · Scope: …`. Write
  the context, the decision and the reason in a few sentences. Add **Considered options** or
  **Consequences** only when they tell a reader something the decision does not.
- The status is `accepted`, `superseded by ADR-NNNN` or `deprecated`. Never rewrite an accepted
  ADR's decision. To change it, write a new ADR and mark the old one superseded. Fixing a link or a
  typo is fine.
- Cite the evidence this repository holds: `NOTES.md` row ids (`R16`, `P1`, `W1`, `M1`), design ids
  (`D6`), files, commits.
