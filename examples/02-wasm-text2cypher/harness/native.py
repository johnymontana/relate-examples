"""Example 02's native section: the page's store built by native Relate, and every query compared.

    uv run --project ../.. python -I harness/native.py > out/native.txt

Run by run.sh after the Node sections, with the project env's binding (`relate-db`, the
repository's engine; run.sh checks it is 1.2.0 like the WASM bundle). It builds the store the page
builds, natively: the statements of out/ddl.cypher (the ontology's graph type, then its constraints
and indexes, as web/ddl.js derives them), then data/demo-graph.json with web/load.js's MERGE
statements. Then it runs every query out/queries.json lists (the canned answers, both variants, the
fallback and the ontology's cookbook, as the Node section ran them on Relate's WASM build) and
compares the rows, as canonical JSON sorted, with what WASM returned. Stdout is diffed: no paths,
timings or ids.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import relate

HERE = Path(__file__).resolve().parents[1]
OUT = HERE / "out"

MERGE_NODE = "MERGE (n:$($label) {id: $id}) SET n += $props"
MERGE_EDGE = ("MATCH (a {id: $f}), (b {id: $t}) MERGE (a)-[r:$($type)]->(b) "
              "SET r += $props SET r.supported = toFloat($props.supported) RETURN count(r) AS n")


def canon(v) -> str:
    """JSON with object keys sorted, as harness/run.mjs's canon() writes it."""
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def plain(v):
    """A binding value as the WASM envelope carries it (floats, ints, strings, lists, maps)."""
    if isinstance(v, list):
        return [plain(x) for x in v]
    if isinstance(v, dict):
        return {k: plain(x) for k, x in v.items()}
    return v


def statements(cypher_file: Path) -> list[str]:
    """The statements of a .cypher file: `//` comment lines dropped, each ending in `;` at a line end."""
    text = "\n".join(l for l in cypher_file.read_text(encoding="utf-8").splitlines() if not l.startswith("//"))
    return [s.strip() for s in text.split(";\n") if s.strip().rstrip(";")]


def main() -> int:
    say = print
    if not (OUT / "ddl.cypher").exists() or not (OUT / "queries.json").exists():
        print("native.py: FAIL: out/ddl.cypher and out/queries.json come from harness/run.mjs; run it first", file=sys.stderr)
        return 1
    log = json.loads((OUT / "queries.json").read_text(encoding="utf-8"))
    graph = json.loads((HERE / "data" / "demo-graph.json").read_text(encoding="utf-8"))
    db = relate.connect(":memory:")
    say(f"# Native Relate {relate.__version__} (harness/native.py): the page's store, built natively, and every query compared with WASM")
    say("")
    ddl = [s.rstrip(";") for s in statements(OUT / "ddl.cypher")]
    for s in ddl:
        db.execute(s)
    say(f"schema: {len(ddl)} statements from out/ddl.cypher (the graph type first)")
    for n in graph["nodes"]:
        db.execute(MERGE_NODE, {"label": n["label"], "id": n["id"], "props": n["props"]})
    for e in graph["edges"]:
        got = list(db.execute(MERGE_EDGE, {"f": e["from"], "t": e["to"], "type": e["type"], "props": e["props"]}))
        if got[0]["n"] != 1:
            print(f"native.py: FAIL: edge {e['from']}-{e['type']}->{e['to']} found no end node", file=sys.stderr)
            return 1
    nodes = list(db.execute("MATCH (n) RETURN count(n) AS n"))[0]["n"]
    rels = list(db.execute("MATCH ()-[r]->() RETURN count(r) AS n"))[0]["n"]
    say(f"loaded: {nodes} nodes, {rels} relationships (data/demo-graph.json: {len(graph['nodes'])}, {len(graph['edges'])})")
    spec = list(db.execute("SHOW CURRENT GRAPH TYPE YIELD specification RETURN specification AS s"))[0]["s"]
    say(f"graph type: {sum(1 for l in spec.splitlines() if l.strip().startswith('(:'))} elements read back")
    types = sorted(r["t"] for r in db.execute("MATCH ()-[r]->() RETURN DISTINCT valueType(r.supported) AS t"))
    say(f"valueType(r.supported): {', '.join(types)}")
    try:
        db.execute("MATCH (q:Product {id: 'arm7'}), (p:Person {id: 'priya'}) CREATE (q)-[:CEO_OF]->(p)")
        refused = "accepted"
    except Exception as e:  # noqa: BLE001 - the engine's refusal, printed
        refused = f"refused ({type(e).__name__}: {str(e).splitlines()[0]})"
    say(f"a CEO_OF edge from a Product, against the graph type: {refused}")
    say("")
    say(f"## The {len(log['queries'])} queries the Node section ran on Relate {log['relate']} WASM, natively")
    same = 0
    for q in log["queries"]:
        rows = sorted(canon(plain(dict(r))) for r in db.execute(q["cypher"]))
        ok = rows == q["rows"]
        same += ok
        say(f"{'same' if ok else 'DIFFERENT'}: {q['label']} ({len(rows)} row{'' if len(rows) == 1 else 's'})")
        if not ok:
            for r in rows:
                say(f"  native: {r}")
            for r in q["rows"]:
                say(f"  wasm:   {r}")
    say("")
    say(f"=> the same rows natively and in WASM: {same} of {len(log['queries'])}")
    db.close()
    if same != len(log["queries"]):
        print("native.py: FAIL: native rows differ from WASM rows (see out/native.txt)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
