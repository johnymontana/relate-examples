# Example 02 is a port, held byte for byte to the source app's outputs

Status: accepted · Decided: 2026-11-23 (02's D1) · Scope: example 02

Example 02 brings the repository owner's ontospec-knowledge-graph-extraction app into the browser.
The original was a FastAPI server using OpenAI, with Neo4j or a toy evaluator. The point of the
example is to show the ontology's effect on Text2Cypher. Changing the prompts, the validator or the
comparison along the way would make the browser version a different experiment.

So the JavaScript ports the Python rather than redesigning it:
- the prompts (`build_schema_prompt`);
- the static validator (`validate_cypher`);
- the DDL (`cypher.all_statements`);
- the A/B comparison notes (`main._compare`);
- the canned queries and the demo graph.

`harness/capture_reference.py` ran the Python once and wrote its outputs to `data/reference/`.
Every `run.sh` fails if a port stops reproducing them byte for byte. The source repository is left
untouched; `data/SOURCE.md` records the provenance.

Only what the browser forces changed:
- WebLLM replaces OpenAI (ADR-0012);
- Relate replaces Neo4j and the toy evaluator (ADR-0013);
- the A/B pair runs one query after the other rather than in parallel (D3);
- an optional "repair once" pass, off by default, keeps the first-try comparison intact (D7).

## Considered options

- **A fresh design for the browser**: it might be tidier, but nothing would show it measures the
  same thing as the original. Rejected.
