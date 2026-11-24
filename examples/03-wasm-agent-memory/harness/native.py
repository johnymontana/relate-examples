"""Example 03's native section: the page's statements on native Relate, compared with WASM.

    uv run --project ../.. python -I harness/native.py > out/native.txt

Run by run.sh after the Node sections, with the project env's binding (`relate-db`, the
repository's engine; run.sh checks it is 1.2.0 like the WASM bundle). For each scripted conversation
it opens an in-memory database, applies the memory's schema, and replays every statement the Node
section ran on Relate's WASM build (out/replay.json: the remember writes with their vectors, the
recall, connect and trace reads), with the same parameters, in the same order. Every statement's
rows must equal WASM's: the same memories, reached the same way, with the same scores and paths.
The store an agent fills in a browser tab is the store a Python process would have filled.

Stdout is diffed: no paths, timings or ids.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import relate

HERE = Path(__file__).resolve().parents[1]
OUT = HERE / "out"

BAD_MEMORY = "CREATE (:Memory {id: 'oops', text: 'no kind'})"
BAD_EDGE = ("MATCH (a:Entity), (b:Entity) WHERE a <> b WITH a, b ORDER BY a.key, b.key LIMIT 1 "
            "CREATE (a)-[:ABOUT]->(b)")


def canon(v) -> str:
    """JSON with object keys sorted, as harness/run.mjs's canon() writes it."""
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def plain(v):
    """A binding value as the WASM envelope carries it: an integral float prints as JavaScript prints it."""
    if isinstance(v, list):
        return [plain(x) for x in v]
    if isinstance(v, dict):
        return {k: plain(x) for k, x in v.items()}
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def refusal(db, statement: str) -> str:
    try:
        db.execute(statement)
    except Exception as e:  # noqa: BLE001 - the engine's refusal, printed
        first = str(e).splitlines()[0]
        import re
        return re.sub(r"`constraint_[0-9a-f]+`", "`constraint_<generated>`", f"refused ({first})")
    return "accepted"


def main() -> int:
    say = print
    if not (OUT / "replay.json").exists():
        print("native.py: FAIL: out/replay.json comes from harness/run.mjs; run it first", file=sys.stderr)
        return 1
    log = json.loads((OUT / "replay.json").read_text(encoding="utf-8"))
    say(f"# Native Relate {relate.__version__} (harness/native.py): the page's statements, replayed natively and compared with WASM")
    scenarios = list(dict.fromkeys(q["scenario"] for q in log["queries"]))
    total = same_total = 0
    for sc in scenarios:
        db = relate.connect(":memory:")
        for s in log["schema"]:
            db.execute(s)
        queries = [q for q in log["queries"] if q["scenario"] == sc]
        say("")
        say(f"## {sc}: {len(log['schema'])} schema statements, then {len(queries)} statements in the order the page ran them")
        by_tool: dict[str, list[int]] = {}
        for i, q in enumerate(queries, 1):
            rows = [plain(dict(r)) for r in db.execute(q["statement"], q["params"])]
            ok = canon(rows) == canon(plain(q["rows"]))
            counts = by_tool.setdefault(q["tool"], [0, 0])
            counts[0] += ok
            counts[1] += 1
            if not ok:
                say(f"DIFFERENT: statement {i} ({q['tool']})")
                say(f"  native: {canon(rows)[:600]}")
                say(f"  wasm:   {canon(plain(q['rows']))[:600]}")
        for tool in sorted(by_tool):
            ok, n = by_tool[tool]
            say(f"{tool}: {ok} of {n} statements return the same rows as WASM")
            same_total += ok
            total += n
        nodes = list(db.execute("MATCH (n) RETURN labels(n)[0] AS l, count(*) AS n ORDER BY l"))
        rels = list(db.execute("MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS n ORDER BY t"))
        say("the store: " + ", ".join(f"{r['n']} {r['l']}" for r in nodes) + "; " + ", ".join(f"{r['n']} {r['t']}" for r in rels))
        say(f"a memory without its kind, against the graph type: {refusal(db, BAD_MEMORY)}")
        say(f"ABOUT between two entities, against the graph type: {refusal(db, BAD_EDGE)}")
        db.close()
    say("")
    say(f"=> the same rows natively and in WASM: {same_total} of {total} statements")
    if same_total != total:
        print("native.py: FAIL: native rows differ from WASM rows (see out/native.txt)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
