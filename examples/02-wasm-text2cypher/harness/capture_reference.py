"""Capture example 02's reference data from the Python app it ports.

    uv run --no-project --with pyyaml==6.0.3 --with jsonschema==4.25.1 \
        python -I harness/capture_reference.py --source <ontospec-knowledge-graph-extraction checkout>

Run by hand, once per change to the source app; run.sh never runs it. It writes, under data/:

  demo-graph.json            demo_graph.NODES and EDGES (the judged, entity-resolved graph)
  canned.json                main.py's CANNED, FALLBACK and SUGGESTED (the offline answers)
  reference/briefing-grounded.txt   text2cypher.build_schema_prompt(doc)
  reference/briefing-bare.txt       text2cypher.build_schema_prompt(doc, bare=True)
  reference/ddl.cypher       cypher.all_statements(doc), one statement per line
  reference/validate.json    text2cypher.validate_cypher on every case in VALIDATE_CASES
  reference/compare.json     main._compare on fixed A/B reports (COMPARE_CASES)

The JavaScript ports (web/briefing.js, web/ddl.js, web/validate.js, web/compare.js) must
reproduce these byte for byte; harness/run.mjs checks that on every run. The ontology itself is
data/corporate-events.ontology.yaml, the source's document with the two changes data/SOURCE.md
lists; both parse to the same object apart from `schema`, which no output here reads.
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]

VALIDATE_CASES = [
    "MATCH (a:Company)-[r:ACQUIRES]->(b:Company) RETURN a.name, b.name",
    "MATCH (p:Person)-[r:CEO_OF]->(c:Company) RETURN p.name, c.name",
    "MATCH (c:Company)<-[r:CEO_OF]-(p:Person) RETURN p.name",
    "MATCH (c:Company)-[r:CEO_OF]->(p:Person) RETURN p.name",
    "MATCH (p:Person)-[:CEO_OF]-(c:Company) RETURN p.name",
    "MATCH (a:Corporation)-[:ACQUIRES]->(b:Company) RETURN a",
    "MATCH (a:Company)-[:BUYS]->(b:Company) RETURN a",
    "MATCH (f:InvestmentFund)-[:INVESTED_IN]->(p:Product) RETURN f",
    "MATCH (n:Company) DETACH DELETE n",
    "CREATE (n:Company {name: 'x'})",
    "MATCH (n:Company) SET n.name = 'x'",
    "MATCH (a)-[r]->(b) WHERE r.assertion = 'asserted' RETURN a.name, type(r), b.name",
    "MATCH (reg:Regulator)-[r]->(c:Company) WHERE r.assertion = 'negated' RETURN reg.name",
    "MATCH (c:`Company`)-[:`MAKES`]->(p:`Product`) RETURN p.name",
    "MATCH (e:Event)-[:EVENT_TARGET]->(c:Company) RETURN e, c",
    "LOAD CSV FROM 'x' AS row RETURN row",
    "CALL dbms.components() YIELD name RETURN name",
]


def report(cypher: str, issues: list[str], rows: list[dict]) -> dict:
    return {"cypher": cypher, "issues": issues, "rows": rows, "execution": "fixture"}


COMPARE_CASES = [
    # the bare variant is blocked by validation
    (report("MATCH (a:Company)-[r:ACQUIRES]->(b:Company) WHERE r.assertion = 'asserted' RETURN b.name", [], [{"b.name": "x"}]),
     report("MATCH (a:Corporation)-[:BUYS]->(b) RETURN b", ["unknown label :Corporation", "unknown relationship type :BUYS"], [])),
    # assertion, supported and aliases all missing from bare; row counts differ
    (report("MATCH (a:Company)-[r:ACQUIRES]->(b:Company) WHERE (a.name = 'N' OR 'N' IN a.aliases) "
            "AND r.assertion = 'asserted' AND r.supported >= 0.8 RETURN b.name", [], [{"b.name": "x"}]),
     report("MATCH (a:Company)-[r:ACQUIRES]->(b:Company) WHERE a.name = 'N' RETURN b.name", [], [])),
    # same shape
    (report("MATCH (c:Company)-[:OPERATES_IN]->(i:Industry) RETURN c.name, i.name", [], [{"c.name": "a", "i.name": "b"}]),
     report("MATCH (c:Company)-[:OPERATES_IN]->(i:Industry) RETURN c.name, i.name", [], [{"c.name": "a", "i.name": "b"}])),
]


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    print(f"wrote {path.relative_to(HERE)}")


def dump(value) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", required=True, type=Path, help="ontospec-knowledge-graph-extraction checkout")
    args = ap.parse_args()
    src = args.source.resolve()
    sys.path.insert(0, str(src))

    ontology = importlib.import_module("ontospec_kg.ontology")
    cypher = importlib.import_module("ontospec_kg.cypher")
    t2c = importlib.import_module("ontospec_kg.text2cypher")
    demo = importlib.import_module("ontospec_kg.demo_graph")

    # main.py builds a FastAPI app and reads .env at import; take its constants from its source
    # text instead of importing it.
    main_src = (src / "app" / "main.py").read_text(encoding="utf-8")
    ns: dict = {}
    start = main_src.index("CANNED: list[dict] = [")
    end = main_src.index("def canned_cypher")
    exec(main_src[start:end], ns)  # noqa: S102 - the source's own literal tables
    cmp_start = main_src.index("def _compare(")
    cmp_end = main_src.index("@app.post(\"/api/ask\")")
    exec(main_src[cmp_start:cmp_end], ns)  # noqa: S102

    doc = ontology.load_document(src / "ontologies" / "corporate-events.ontology.yaml")
    mine = ontology.load_document(HERE / "data" / "corporate-events.ontology.yaml")
    a = {k: v for k, v in doc.items() if k != "schema"}
    b = {k: v for k, v in mine.items() if k != "schema"}
    if a != b:
        print("data/corporate-events.ontology.yaml no longer parses to the source's document "
              "(apart from `schema`): copy it again and re-apply data/SOURCE.md's changes", file=sys.stderr)
        return 1

    write(HERE / "data" / "demo-graph.json", dump({"nodes": demo.NODES, "edges": demo.EDGES}))
    canned = {
        "canned": [{"keywords": list(e["keywords"]), "cypher": e["cypher"], "bare": e["bare"]} for e in ns["CANNED"]],
        "fallback": ns["FALLBACK"],
        "suggested": ns["SUGGESTED"],
    }
    write(HERE / "data" / "canned.json", dump(canned))
    ref = HERE / "data" / "reference"
    write(ref / "briefing-grounded.txt", t2c.build_schema_prompt(doc) + "\n")
    write(ref / "briefing-bare.txt", t2c.build_schema_prompt(doc, bare=True) + "\n")
    write(ref / "ddl.cypher", "".join(s + "\n" for s in cypher.all_statements(doc)))
    write(ref / "validate.json", dump([{"cypher": q, "issues": t2c.validate_cypher(q, doc)} for q in VALIDATE_CASES]))
    write(ref / "compare.json", dump([{"with": w, "without": wo, "notes": ns["_compare"](w, wo)} for w, wo in COMPARE_CASES]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
