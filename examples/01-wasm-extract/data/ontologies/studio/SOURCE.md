# Neo4j's solution packages (`data/ontologies/studio/`)

Each folder is one package of [neo4j/studio-agent-use-cases](https://github.com/neo4j/studio-agent-use-cases),
vendored verbatim at commit `b76f767e85c5853b7d70eb2bb3b10879d0e394a9` by `harness/vendor-studio.mjs`:
`ONTOLOGY.json` (its Ontology Graph Spec document), `QUERIES.md`, `human_description.md` and, where the
package has one, `NOTICE.md`. Nothing else from the repository is kept, and nothing is edited.
`manifest.json` lists every file with its sha256; `node harness/vendor-studio.mjs --check` compares the
folders with it, and refuses a file that holds the engine's earlier product name.

**Licence.** The upstream repository has no licence file. The packages are used with Neo4j's
permission, confirmed by the repository owner on 2026-11-26 (ADR-0020), as NVL is. The four packages
that draw on the EDM Council's FIBO (business-entities, loans-and-mortgages, retail-banking,
securities-reference-data) carry FIBO's MIT notices in their `NOTICE.md`, which ships with them.

**What is this repository's.** The `<package>.overlay.yaml` files beside the folders: colours, the
descriptions the model reads, link phrases, identifier patterns, the properties read from text and
example arguments for the package's queries (`web/studio.js`). `harness/convert.mjs` applies each overlay
to its package and writes the page's document to `data/ontologies/ogs/studio/<package>.ontology.yaml`.
