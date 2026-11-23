# Where `data/ontologies/ogs/` comes from

The 27 bundled ontologies as Ontology Graph Spec v1 documents
([`../../ontology-spec/`](../../ontology-spec/)), which the page's picker and the harnesses load.
They are generated, not written by hand: `node harness/convert.mjs` converts each original with
`web/convert.js` and writes it with `web/ogs.js` `toYaml`, and every run of `run.sh` checks
(`harness/ontology.mjs`, `expected/ontology.txt`) that each file is byte for byte a fresh
conversion of its original. Edit the original and convert again; never edit these.

| Here | Converted from | Licence of the content |
|---|---|---|
| `ccg/<domain>.ontology.yaml` (27) | [`../ccg/<domain>.yaml`](../ccg/) with [`../ccg/_base.yaml`](../ccg/_base.yaml) merged in, neo4j-labs/create-context-graph at `707b168` | Apache-2.0, [`../ccg/LICENSE-create-context-graph.txt`](../ccg/LICENSE-create-context-graph.txt) |

**Changes:** the format. Every value create-context-graph's model reads is carried (the
example's README, "The ontology format", has the mapping; `harness/ontology.mjs` reads each
document back into create-context-graph's shape and compares). The kind descriptions of the create-context-graph
documents ("financial account (object)") are derived from `pole_type` and `subtype`, which the
documents also carry.
