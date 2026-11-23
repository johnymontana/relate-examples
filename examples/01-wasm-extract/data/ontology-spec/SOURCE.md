# Where `data/ontology-spec/` comes from

The JSON Schema of the **Neo4j Ontology Graph Specification 1.1.0** (`$id`
`https://neo4j.com/docs/ontology-graph-spec/1.1.0/schema.json`, JSON Schema draft 2020-12; the spec is
documented at <https://neo4j.com/docs/ontology-graph-spec/>), copied verbatim from
[neo4j/ontology-graph-spec](https://github.com/neo4j/ontology-graph-spec) at tag `release/v0.12.2`,
commit `30e9122cb035e58b8e0c51e090f1dad2c66a26f9` (`30e9122`, committed 2026-11-23, fetched
2026-11-23): the release of the official SDK this example pins (npm `@neo4j/ontology-graph-spec`
0.12.2). The file is byte for byte what <https://neo4j.com/docs/ontology-graph-spec/1.1.0/schema.json>
and <https://neo4j.com/docs/ontology-graph-spec/current/schema.json> served the same day (sha256
`c8fc0021c86b944a3090e7c5e084409970274fdabea79c8b715976fc09da78eb`).

**Licence:** Apache License 2.0. The licence text is in
[`LICENSE-graph-spec.txt`](LICENSE-graph-spec.txt), the repository's `LICENSE` copied unchanged
from the same commit (the same text, blob for blob, as the draft's repository had). The repository
ships no NOTICE file.

**Changes:** none.

| Here | Upstream at `30e9122` | Git blob |
|---|---|---|
| `ontology-graph-spec.schema.json` | `ontology-graph-spec.schema.json` | `0e0d79e72ec257d5bbd67a4a41c2344b6b6f0931` |
| `LICENSE-graph-spec.txt` | `LICENSE` | `261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64` |

**How this example uses it.** `web/ogs.js` carries the same schema as a JavaScript object and
validates documents with a small interpreter of the keywords the schema uses: the strict check,
which refuses fields the spec does not have. Then the SDK, through `lib/ogs.mjs`, decodes each
document and runs its core validation. `harness/ontology.mjs` pins three things
(`expected/ontology.txt`):
- the object equals this file;
- ajv 8 (a dev dependency) and `web/ogs.js` report the same errors on every bundled document and on
  a set of tampered ones;
- the SDK accepts every bundled document.

Earlier builds of this example vendored a draft of the spec instead (neo4j/graph-spec, branch
`oskar/ontology-spec-v1-jsonschema` at `35e74c0`, `$id`
`https://neo4j.com/ontology-graph-spec/1.0.0/schema.json`). A document in that draft is converted by
`lib/ogs.mjs` `fromDraft` (README, "Ontologies: the Ontology Graph Spec"). Two of that build's own
files are kept as fixtures in `harness/fixtures/`.
