# Where `data/ontologies/ogs/` comes from

The page's documents for Neo4j's solution packages, as Ontology Graph Spec 1.1 documents
([`../../ontology-spec/`](../../ontology-spec/)), which the picker and the harnesses load beside the
curated domains (`../domains/`). They are generated, not written by hand: `node harness/convert.mjs`
(or `--only <package>`) applies each package's overlay with `web/studio.js` and writes the result with
`web/ogs.js` `toYaml`, and every run of `run.sh` checks (`harness/ontology.mjs`,
`expected/ontology.txt`) that each file is byte for byte a fresh conversion, and that stripping the
overlay gives the package's document back. Edit the overlay and convert again; never edit these.

| Here | Converted from | Licence of the content |
|---|---|---|
| `studio/<package>.ontology.yaml` (13) | [`../studio/<package>/ONTOLOGY.json`](../studio/) and its `QUERIES.md`, with [`../studio/<package>.overlay.yaml`](../studio/) applied; neo4j/studio-agent-use-cases at `b76f767` | the package: used with Neo4j's permission ([`../studio/SOURCE.md`](../studio/SOURCE.md)); the overlay: this repository's |

**Changes:** the overlay's additions only (colours, the descriptions the model reads, link phrases,
identifier patterns, properties read from the text and their vocabularies, example arguments), and
each package query as a tool: its question, category, parameters (typed from the package's own
bindings and descriptions) and prerequisites (gds, apoc, a write, or an index the package's setup
creates).

create-context-graph's domain files (`../ccg/`) are no longer bundled as documents: the editor still
reads a pasted or uploaded one, converting it on load with `../ccg/_base.yaml` (ADR-0019).
