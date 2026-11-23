# Ontologies are Ontology Graph Spec 1.1 documents, read through the official SDK

Status: accepted · Decided: 2026-11-23 · Scope: repository (examples 01 and 02)

Example 01 was built on a draft of the Ontology Graph Spec. It had its own schema interpreter and
its own document format. The spec has since been published (1.1.0, neo4j.com/docs/ontology-graph-spec)
with an official SDK, npm `@neo4j/ontology-graph-spec`. Both examples now read and write the
published format through that SDK (pinned at 0.12.2), via the shared `lib/ogs.mjs`.

The SDK is used where it is sound and worked around where it is not. Each workaround is pinned by a
test:

- **Y1:** its YAML decoder misreads plain YAML. That includes all 27 bundled documents. So YAML is
  always parsed with js-yaml and then decoded from JSON (`GraphSpec.Json`).
- **Y2:** its decoder ignores fields the spec does not have. Example 01 takes documents from its
  users, so it runs the published JSON Schema first, vendored from the SDK's release tag in
  `data/ontology-spec/`. That check is strict.

Draft-format documents are not refused. `lib/ogs.mjs` `fromDraft` converts them losslessly, and
example 01 converts a stored draft when it opens it (01's NOTES O7).

## Consequences

- An SDK upgrade also moves example 01's `SDK_VERSION`, its `OGS_SDK_VERSION` and its vendored schema
  (AGENTS.md, "Engine pins move together").
- Converting a stored draft changes the document's sha256. The store is gated once more, and the
  inference cache misses on its next extraction (O7).

## Considered options

- **Keeping 01's draft interpreter**: this means owning a divergent dialect of a published spec.
  Rejected; the user asked for the official tooling and format.
- **Using the SDK alone**: this would mean trusting its YAML decoder (Y1) and its lenient decoder
  (Y2). Rejected for documents that users supply.
