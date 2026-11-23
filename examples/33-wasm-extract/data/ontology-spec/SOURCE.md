# Where `data/ontology-spec/` comes from

The JSON Schema of the **Neo4j Ontology Graph Specification v1** (`$id`
`https://neo4j.com/ontology-graph-spec/1.0.0/schema.json`, JSON Schema draft 2020-12), copied
verbatim from [neo4j/graph-spec](https://github.com/neo4j/graph-spec), branch
`oskar/ontology-spec-v1-jsonschema`, at commit `35e74c06a7c400ba6aff336935a42ff28725631b`
(`35e74c0`, committed 2026-10-02, fetched 2026-10-09). The spec is a draft; its prose is
`docs/ontology-graph-spec-v1-proposal.md` at the same commit (changelog up to 2026-10-02:
the "Ontology Graph Spec" rename, ADR-0009, and non-empty property names, ADR-0010).

**Licence:** Apache License 2.0. The licence text is in
[`LICENSE-graph-spec.txt`](LICENSE-graph-spec.txt), the repository's `LICENSE` copied unchanged
from the same commit. The repository ships no NOTICE file.

**Changes:** none.

| Here | Upstream at `35e74c0` | Git blob |
|---|---|---|
| `ontology-graph-spec.schema.json` | `ontology-graph-spec.schema.json` | `ad9e11077e7587627603ffe75c8a846814cffd3b` |
| `LICENSE-graph-spec.txt` | `LICENSE` | `261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64` |

**How this example uses it.** `web/ogs.js` carries the same schema as a JavaScript object and
validates documents with a small interpreter of the keywords the schema uses;
`harness/ontology.mjs` pins that the object equals this file, and that ajv 8 (with
ajv-formats, a dev dependency) and `web/ogs.js` report the same errors on every bundled document
and on a set of tampered ones (`expected/ontology.txt`).
