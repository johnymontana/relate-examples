# Where `data/ontologies/ccg/` comes from

The 27 domain ontologies and their shared base, copied verbatim from
[neo4j-labs/create-context-graph](https://github.com/neo4j-labs/create-context-graph),
path `src/create_context_graph/domains/`, at commit
`707b168d9509cbf1b919b82940285d1df4c6810d` (`707b168`, 2026-09-04).

**Licence:** Apache License 2.0, neo4j-labs/create-context-graph contributors. The YAML files
carry no copyright header and the repository ships no NOTICE file; its `LICENSE` has the
line "Copyright 2026 Neo4j Labs" after its terms and conditions. The licence text is in
[`LICENSE-create-context-graph.txt`](LICENSE-create-context-graph.txt), that `LICENSE` copied
unchanged from the same commit.

**Changes:** none. Every `.yaml` here is byte for byte the file at that commit (checked with
`gh api repos/neo4j-labs/create-context-graph/contents/src/create_context_graph/domains/<file>?ref=707b168d9509cbf1b919b82940285d1df4c6810d`).
This file and the licence copy are new.

| Here | Upstream at `707b168` |
|---|---|
| `_base.yaml` | `src/create_context_graph/domains/_base.yaml`: the POLE+O base (Person, Organization, Location, Event, Object; WORKS_FOR, LOCATED_AT, PARTICIPATED_IN) |
| `agent-memory.yaml` … `wildlife-management.yaml` (27) | `src/create_context_graph/domains/<the same name>` |
| `LICENSE-create-context-graph.txt` | `LICENSE` |

**How this example reads them:** it converts each one to an Ontology Graph Spec v1 document
(`web/convert.js`, written to [`../ogs/ccg/`](../ogs/ccg/) by `harness/convert.mjs`), and the page
and the harnesses load those. The conversion:

- merges `_base.yaml` as upstream's `ontology.py` `_merge_base` does: the base's entity types and
  relationships come first, except a label or a relationship type the domain declares itself;
- keeps labels and relationship types verbatim (`Person`, `Account`, `OWNS`), one relationship
  entry per (type, source, target), so a type with several pairs is legal for exactly those pairs;
- derives each kind's description from `subtype` and `pole_type` (`Account` → "financial account
  (object)"), and keeps both in a `createContextGraph:pole` extension;
- carries the properties, `agent_tools` (as `canonicalQuery` tools on the node or relationship
  each query starts from), colours, icons and node sizes, and, in top-level extensions,
  `document_templates`, `decision_traces`, `demo_scenarios`, `system_prompt` and `visualization`.

A domain file pasted or uploaded into the page is converted the same way, with this `_base.yaml`.

`_base.yaml` ships in `dist/` under its own name. GitHub Pages publishes a file whose name starts
with `_` because site/build.mjs writes `.nojekyll` at the site's root (a Jekyll build would skip it).

The documents this example extracts with these ontologies are not create-context-graph's: they
are 27 synthetic samples written for it, one per domain, in
[`../../samples/ccg/`](../../samples/ccg/) (see [`../../SOURCE.md`](../../SOURCE.md)).
