# Where `data/` comes from

Everything here except this file is taken from the author's ontospec-knowledge-graph-extraction
project: an ontology-driven Text2Cypher web app (FastAPI, OpenAI, Neo4j), which this example ports
to a browser tab with no backend. That project is the repository owner's own work and is not
published; the owner moved these files here, and they carry this repository's terms.

| Here | From the source project | How |
|---|---|---|
| `corporate-events.ontology.yaml` | `ontologies/corporate-events.ontology.yaml` | copied, then the three changes below |
| `demo-graph.json` | `ontospec_kg/demo_graph.py` `NODES` and `EDGES` (the judged, entity-resolved demo graph) | `harness/capture_reference.py` |
| `canned.json` | `app/main.py` `CANNED`, `FALLBACK` and `SUGGESTED` (the offline answers) | `harness/capture_reference.py` |
| `reference/briefing-grounded.txt`, `reference/briefing-bare.txt` | `ontospec_kg/text2cypher.py` `build_schema_prompt(doc)` and `build_schema_prompt(doc, bare=True)` | `harness/capture_reference.py` |
| `reference/ddl.cypher` | `ontospec_kg/cypher.py` `all_statements(doc)`, one statement per line | `harness/capture_reference.py` |
| `reference/validate.json` | `ontospec_kg/text2cypher.py` `validate_cypher` on the script's `VALIDATE_CASES` | `harness/capture_reference.py` |
| `reference/compare.json` | `app/main.py` `_compare` on the script's `COMPARE_CASES` | `harness/capture_reference.py` |

**Changes to the ontology** (the document otherwise parses to the source's object; the capture
script checks that, ignoring `schema`):

1. `schema` points at the current published spec: `https://neo4j.com/docs/ontology-graph-spec/1.1.0/schema.json`
   instead of `…/1.0.0/schema.json`. 1.1.0 only adds optional `aliases` on properties, so the
   document needs nothing else.
2. The three type tokens with angle brackets are quoted: `type: "LIST<STRING>"` (twice) and
   `type: "VECTOR<FLOAT32>"`. Unquoted they are valid YAML, but the Ontology Graph Spec SDK's own
   YAML decoder (`@neo4j/ontology-graph-spec` 0.12.2) misreads them and refuses the document
   (`Neo4jType does not contain element with name ''`). The example never uses that decoder
   (lib/ogs.mjs parses YAML with js-yaml and hands the SDK JSON), but quoting keeps the file
   readable by the SDK's YAML decoder as well (checked: it reads this file).
3. The comment on line 9 names how this example validates the document instead of the source
   project's validation script.

**The ports must reproduce the reference files.** `web/briefing.js`, `web/ddl.js`,
`web/validate.js` and `web/compare.js` port the Python byte for byte; `harness/run.mjs` compares
them with `reference/` on every run and fails (`PIN: … changed`) when one stops matching.

**Re-capturing** (only after a change to the source project, never in `run.sh`):

```bash
uv run --no-project --with pyyaml==6.0.3 --with jsonschema==4.25.1 \
    python -I harness/capture_reference.py --source <ontospec-knowledge-graph-extraction checkout>
```

It refuses to write anything when `corporate-events.ontology.yaml` no longer parses to the source's
document; copy it again and re-apply the changes above first.
