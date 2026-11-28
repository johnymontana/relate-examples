# Where `data/ontology-spec/` comes from

The JSON Schema of the **Neo4j Ontology Graph Specification 1.1.0** (`$id`
`https://neo4j.com/docs/ontology-graph-spec/1.1.0/schema.json`, JSON Schema draft 2020-12; the spec is
documented at <https://neo4j.com/docs/ontology-graph-spec/>), copied verbatim from
[neo4j/ontology-graph-spec](https://github.com/neo4j/ontology-graph-spec) at tag `release/v0.13.0`,
commit `d3b4ec6de7d570139e3ba3aef5d64990155440e4` (`d3b4ec6`, committed 2026-11-26, fetched
2026-11-26): the release of the official SDK this example pins (npm `@neo4j/ontology-graph-spec`
0.13.0). The file is byte for byte what <https://neo4j.com/docs/ontology-graph-spec/1.1.0/schema.json>
and <https://neo4j.com/docs/ontology-graph-spec/current/schema.json> served the same day (sha256
`c8fc0021c86b944a3090e7c5e084409970274fdabea79c8b715976fc09da78eb`). Both files are the same blobs
as at the previous pin, tag `release/v0.12.2` (commit `30e9122`): the schema did not change
between the two SDK releases.

**Licence:** Apache License 2.0. The licence text is in
[`LICENSE-graph-spec.txt`](LICENSE-graph-spec.txt), the repository's `LICENSE` copied unchanged
from the same commit (the same text, blob for blob, as the draft's repository had). The repository
ships no NOTICE file.

**Changes:** none.

| Here | Upstream at `d3b4ec6` | Git blob |
|---|---|---|
| `ontology-graph-spec.schema.json` | `ontology-graph-spec.schema.json` | `0e0d79e72ec257d5bbd67a4a41c2344b6b6f0931` |
| `LICENSE-graph-spec.txt` | `LICENSE` | `261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64` |

**Spec 1.0.0, beside it.** `ontology-graph-spec-1.0.0.schema.json` is the JSON Schema of spec 1.0.0
(`$id` `https://neo4j.com/docs/ontology-graph-spec/1.0.0/schema.json`), copied verbatim from the
same repository at tag `release-spec/v1.0.0`, commit `9c0e3e8c2d511bf689bfc682a281c0a7cee37a09`
(`9c0e3e8`, committed 2026-10-21, fetched 2026-11-26), git blob
`b64392b28614951c5e47fd15998ae9cd3a46d677`, sha256
`56cd1364fa6d4f0222c24663c459521d2fb7edb45a9e229f0018cb4a1f797ca9`. The licence at that tag is the
same blob as `LICENSE-graph-spec.txt`. The example never validates against it: Neo4j's solution
packages (`../ontologies/studio/`) name 1.0.0, and `harness/ontology.mjs` pins that the 1.1.0 schema
is this one with exactly one field added (a property's `aliases`), so a 1.0.0 document is read as
1.1.0 by naming 1.1.0 (`web/ogs.js` `fromSpec10`, NOTES.md Y3).

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
