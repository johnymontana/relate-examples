"""lib/replay.mjs against lib/replay.py: the same dump format, byte for byte, in both directions.

The browser downloads dump.json from Relate's WASM build, and native Relate loads it with
lib/replay.py (and the other way round), both on the project engine's release (the relate-db
version the project env holds, pyproject's pin), so the two must agree on every byte of the
canonical JSON: node numbering, business keys, [key, value] pairs, floats written as Python's
repr, code-point ordering, schema rows and the graph type. These tests build one graph with the
same statements on that release's WASM bundle (lib/relate_wasm.mjs loadNode, in Node) and on the
project env's wheel (this interpreter, in a subprocess), and check:
- the two dumps are equal after canonical JSON;
- the JS dump loads with lib/replay.py into a fresh .rl whose content_digest is
  the dump's digest (and the JS digest), whose Python dump equals the JS dump,
  and whose graph type still refuses an illegal edge;
- the Python dump loads with lib/replay.mjs into a fresh WASM store that dumps
  back to the same bytes;
- the JS JSON layer (parse, canon, pyFloat, cmp, sha256) matches Python's json,
  repr(), sorted() and hashlib on edge cases and 2,000 random floats;
- the JS port refuses what it does not handle, naming the property, and refuses
  bad dumps before its first write.
Prerequisites (each test SKIPs without its own): node on PATH; the pinned release's
@relate/relate-wasm package, installed by `npm ci --omit=peer` in examples/01-wasm-extract
(or $RELATE_WASM_DIR), where loadNode checks it and fails a test on a package that is there
but not the pinned one.
"""

import hashlib
import json
import math
import os
import random
import shutil
import struct
import subprocess
import sys
from importlib import metadata
from pathlib import Path

import pytest

import replay

REPO = Path(__file__).resolve().parents[2]
REPLAY_MJS = REPO / "lib" / "replay.mjs"
RELATE_WASM_MJS = REPO / "lib" / "relate_wasm.mjs"
NODE = shutil.which("node")
PIN = metadata.version("relate-db")  # the project engine: pyproject's pin, as the project env holds it
# where lib/relate_wasm.mjs find(PIN) looks when run from examples/01-wasm-extract: $RELATE_WASM_DIR, else npm's copy
EX01 = REPO / "examples" / "01-wasm-extract"
WASM = Path(os.environ.get("RELATE_WASM_DIR") or EX01 / "node_modules" / "@relate" / "relate-wasm")

needs_node = pytest.mark.skipif(NODE is None, reason="node is not on PATH")
needs_wasm = pytest.mark.skipif(not (WASM / "relate_bg.wasm").exists() or not (WASM / "relate.js").exists(),
                                reason=f"no Relate {PIN} WASM bundle in {WASM} (npm ci --omit=peer in examples/01-wasm-extract)")

# One graph, built with the same statements on both engines: a graph type, a UNIQUE constraint
# (whose backing index serves its key), every index kind lib/replay rebuilds, a NODE KEY, a relationship type constraint, and the
# values the JS port has to keep exact (integral floats, NaN, -Infinity, an integer above 2^53).
BUILD = [
    "ALTER CURRENT GRAPH TYPE SET { (:PERSON => {name :: STRING NOT NULL}), (:COMPANY => {name :: STRING NOT NULL}), "
    "(:`ÄRZTE` => {name :: STRING NOT NULL}), (:PERSON)-[:FOUNDED => {p :: FLOAT}]->(:COMPANY) }",
    "CREATE CONSTRAINT kind_id FOR (k:Kind) REQUIRE k.id IS UNIQUE",
    "CREATE FULLTEXT INDEX kind_desc FOR (k:Kind) ON EACH [k.description, k.id]",
    "CREATE VECTOR INDEX kind_vec FOR (k:Kind) ON (k.e) "
    "OPTIONS {indexConfig: {`vector.dimensions`: 3, `vector.similarity_function`: 'cosine'}}",
    "CREATE INDEX sent_doc_idx FOR (s:Sentence) ON (s.doc, s.text)",  # not (doc, idx): sent_key's key
    "CREATE TEXT INDEX sent_text FOR (s:Sentence) ON (s.text)",
    "CREATE LOOKUP INDEX rel_types FOR ()-[r]-() ON EACH type(r)",
    "CREATE CONSTRAINT sent_key FOR (s:Sentence) REQUIRE (s.doc, s.idx) IS NODE KEY",
    "CREATE CONSTRAINT evidence_p FOR ()-[r:EVIDENCE]-() REQUIRE r.p IS :: FLOAT",
    "CREATE (:PERSON:Entity {name: 'Ada', score: 1.0, big: 9007199254740993, l: [1.0, 2.5], nan: toFloat('NaN'), "
    "inf: toFloat('-Infinity'), e: [], s: 'é\\n\"😀', b: true, tags: ['x', 'y']})"
    "-[:FOUNDED {p: 0.9, n: 2}]->(:COMPANY {name: 'Acme', tiny: 1.5e-7, huge: 1e16, neg: -0.0})",
    "CREATE (:Kind {id: 'PERSON', description: 'A named person.'}), (:Kind {id: 'COMPANY', description: 'A company.'}), "
    "(:`ÄRZTE` {name: 'Dr'}), ({plain: 2}), (:Anon {v: 1}), (:Anon {v: 1})",
    "CREATE (:Sentence {doc: 'd1', idx: 0, text: 'x'})-[:EVIDENCE {p: 0.5}]->(:Sentence {doc: 'd1', idx: 1, text: 'y'})",
    "MATCH (a:Anon) WITH collect(a) AS two WITH two[0] AS x, two[1] AS y CREATE (x)-[:SAME]->(y)",
]

NODE_SCRIPT = r"""
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [mode, input, output, replayPath, relateWasmPath, ver] = process.argv.slice(2);
const R = await import(pathToFileURL(replayPath).href);
const out = {};
const engine = async () => {
  const W = await import(pathToFileURL(relateWasmPath).href);
  return (await W.loadNode(ver)).RelateDb;  // the pinned bundle, checked, reporting <ver>
};
const exec = (db, q) => { const e = JSON.parse(db.execute(q, null)); if (e.error) throw new Error(`${q}: ${e.error}`); return e.rows; };
const refusal = (fn) => { try { fn(); return null; } catch (e) { return `${e.name}: ${e.message}`; } };
if (mode === 'units') {
  const u = JSON.parse(readFileSync(input, 'utf8'));
  const floats = R.parse(u.floats);
  out.floatsCanon = R.canon(floats);
  out.reprs = floats.map((f) => R.pyFloat(f.value));
  out.allFloat = floats.every((f) => f instanceof R.Float);
  out.ints = R.canon(R.parse(u.ints));
  out.intTypes = R.parse(u.ints).map((x) => typeof x);
  out.mixed = R.canon(R.parse(u.mixed));
  out.sorted = [...u.strings].sort(R.cmp);
  out.sha = u.strings.map((s) => R.sha256(s));
  out.badJson = u.bad.map((t) => refusal(() => R.parse(t)));
  out.stringify = refusal(() => JSON.stringify({ x: new R.Float(1) }));
} else if (mode === 'build') {
  const RelateDb = await engine();
  const db = new RelateDb();
  for (const q of JSON.parse(readFileSync(input, 'utf8'))) exec(db, q);
  const d = R.dump(db);
  out.text = R.canon(d);
  out.digest = R.digest(d);
  out.contentDigest = R.contentDigest(db);
  const again = new RelateDb();
  out.made = R.load(again, R.parse(out.text));
  out.roundTrip = R.canon(R.dump(again)) === out.text;
  out.illegal = JSON.parse(again.execute("MATCH (c:COMPANY) CREATE (:Kind {id: 'x'})-[:FOUNDED]->(c)", null)).error;
} else if (mode === 'load') {
  const RelateDb = await engine();
  const db = new RelateDb();
  out.made = R.load(db, R.parse(readFileSync(input, 'utf8')));
  out.text = R.canon(R.dump(db));
  out.contentDigest = R.contentDigest(db);
} else if (mode === 'refusals') {
  const RelateDb = await engine();
  const cases = JSON.parse(readFileSync(input, 'utf8'));
  out.dump = cases.dump.map((q) => { const db = new RelateDb(); exec(db, q); return refusal(() => R.dump(db)); });
  out.load = cases.load.map((text) => {
    const db = new RelateDb();
    exec(db, 'CREATE CONSTRAINT mine FOR (m:Mine) REQUIRE m.id IS UNIQUE');
    const why = refusal(() => R.load(db, R.parse(text)));
    const n = exec(db, 'MATCH (n) RETURN count(n) AS c')[0].c;
    const c = exec(db, 'SHOW CONSTRAINTS YIELD name RETURN collect(name) AS n')[0].n;
    return { why, untouched: n === 0 && c.length === 1 };
  });
}
writeFileSync(output, JSON.stringify(out));
"""

PY_SCRIPT = r"""
import json, os, sys, tempfile
sys.path.insert(0, sys.argv[1])
from importlib import metadata
import relate, replay
assert metadata.version("relate-db") == sys.argv[4], (metadata.version("relate-db"), sys.argv[4])
mode, src = sys.argv[2], sys.argv[3]
spec = lambda c: c.execute("SHOW CURRENT GRAPH TYPE YIELD specification RETURN specification").fetchone()["specification"]
if mode == "build":
    conn = relate.connect(":memory:")
    for s in json.loads(open(src, encoding="utf-8").read()):
        conn.execute(s)
    print(json.dumps({"text": replay._canon(replay.dump(conn)), "spec": spec(conn)}))
else:
    text = open(src, encoding="utf-8").read()
    d = json.loads(text)
    path = os.path.join(tempfile.mkdtemp(), "from-js.rl")
    conn = relate.connect(path)
    made = replay.load(conn, d)
    conn.close()
    conn = relate.connect(path, read_only=True)  # leaves the .rl as it is (NOTES.md R15)
    out = {"canon_of_parsed": replay._canon(d) == text, "made": made, "digest": replay.digest(d),
           "content_digest": replay.content_digest(conn), "text": replay._canon(replay.dump(conn)), "spec": spec(conn)}
    conn.close()
    target = relate.connect(":memory:")
    replay.load(target, d)
    try:
        target.execute("MATCH (c:COMPANY) CREATE (:Kind {id: 'x'})-[:FOUNDED]->(c)")
        out["illegal"] = None
    except relate.Error as e:
        out["illegal"] = str(e).splitlines()[0]
    print(json.dumps(out))
"""


def node(tmp_path: Path, mode: str, payload) -> dict:
    script, src, dst = tmp_path / "run.mjs", tmp_path / f"{mode}.in.json", tmp_path / f"{mode}.out.json"
    script.write_text(NODE_SCRIPT)
    src.write_text(payload if isinstance(payload, str) else json.dumps(payload), encoding="utf-8")
    done = subprocess.run([NODE, str(script), mode, str(src), str(dst), str(REPLAY_MJS), str(RELATE_WASM_MJS), PIN],
                          capture_output=True, text=True, timeout=300)
    assert done.returncode == 0, done.stderr
    return json.loads(dst.read_text(encoding="utf-8"))


def native(tmp_path: Path, mode: str, payload: str) -> dict:
    """PY_SCRIPT on the project env's wheel: this interpreter, isolated (-I), in a subprocess."""
    src = tmp_path / f"py-{mode}.in.json"
    src.write_text(payload, encoding="utf-8")
    done = subprocess.run([sys.executable, "-I", "-c", PY_SCRIPT, str(REPO / "lib"), mode, str(src), PIN],
                          capture_output=True, text=True, timeout=300,
                          env={**os.environ, "RELATE_TELEMETRY": "off"})
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


# --- the JSON layer, against Python's json, repr, sorted and hashlib --------------------------

def _floats() -> list[float]:
    rng = random.Random(33)
    edge = [0.0, -0.0, 1.0, -1.0, 0.1, 0.5, 1.5, 100.0, 1e16, 1e15, 1234567890123456.0, 12345678901234567.0, 1e-4,
            1e-5, 0.0001234, 1.5e-7, 5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, 1e21, 1e22, 0.3,
            0.1 + 0.2, 2.0 ** 53, 2.0 ** 63, 123456.789, float("nan"), float("inf"), float("-inf")]
    rand = [struct.unpack("<d", rng.getrandbits(64).to_bytes(8, "little"))[0] for _ in range(1000)]
    rand += [rng.uniform(-1e6, 1e6) for _ in range(500)] + [rng.random() * 10 ** rng.randint(-30, 30) for _ in range(500)]
    return edge + [x for x in rand if math.isfinite(x)]


STRINGS = ["b", "a", "é", "z", "\U0001F600", "\uFFFD", "\uE000", "A", "", "ab", "a\U0001F600", "a\uFFFF", "日本", "\x7f"]


@needs_node
def test_json_layer_matches_python(tmp_path):
    floats = _floats()
    ints = [0, -0, 1, -1, 2 ** 53 - 1, 2 ** 53, 2 ** 53 + 1, -(2 ** 63), 2 ** 63 - 1]
    mixed = {"z": [1, 1.0, "1.0", True, None, {"é": [], "a": {}}], "\U0001F600": "x\n\"\\\t\x01\u2028", "a": -0.0}
    bad = ["{\"a\":1,}", "[1,]", "01", "1.", "\"\\x\"", "{\"a\" 1}", "[1] 2", "\"\u0001\""]
    got = node(tmp_path, "units", {"floats": json.dumps(floats), "ints": json.dumps(ints),
                                   "mixed": json.dumps(mixed), "strings": STRINGS, "bad": bad})
    assert got["allFloat"] and got["reprs"] == [repr(f).replace("nan", "NaN").replace("inf", "Infinity") for f in floats]
    assert got["floatsCanon"] == replay._canon(floats)
    assert got["ints"] == replay._canon(ints) and got["intTypes"][:5] == ["number"] * 5
    assert got["intTypes"][6:] == ["bigint"] * 3  # beyond 2^53 a BigInt, never a rounded number (NOTES.md R4)
    assert got["mixed"] == replay._canon(mixed)
    assert got["sorted"] == sorted(STRINGS)  # code-point order, not UTF-16 order
    assert got["sha"] == [hashlib.sha256(s.encode()).hexdigest() for s in STRINGS]
    assert all(why and why.startswith("ReplayError: JSON: ") for why in got["badJson"]), got["badJson"]
    assert got["stringify"].startswith("ReplayError: a Float cannot go through JSON.stringify")


# --- one graph on both engines ----------------------------------------------------------------

@pytest.fixture(scope="module")
def built(tmp_path_factory):
    if NODE is None or not (WASM / "relate_bg.wasm").exists():
        pytest.skip(f"needs node and the Relate {PIN} WASM bundle")
    tmp = tmp_path_factory.mktemp("replay-js")
    js = node(tmp, "build", BUILD)
    py = native(tmp, "build", json.dumps(BUILD))
    return tmp, js, py


@needs_node
@needs_wasm
def test_same_statements_give_the_same_dump_on_both_engines(built):
    _, js, py = built
    assert js["text"] == py["text"]
    d = json.loads(js["text"])
    assert d["engine"] == PIN and d["graph_type"] == replay.render_graph_type(replay.split_graph_type(py["spec"])[0])
    assert [c["name"] for c in d["constraints"]] == ["evidence_p", "kind_id", "sent_key"]
    # every store starts with two LOOKUP indexes under fixed names (NOTES.md R9): index_*
    assert [i["name"] for i in d["indexes"]] == ["index_1b9dcc97", "index_460996c0", "kind_desc", "kind_vec",
                                                 "rel_types", "sent_doc_idx", "sent_text"]
    assert js["digest"] == js["contentDigest"] == replay.digest(d)
    assert js["roundTrip"] and js["made"] == {"nodes": 10, "relationships": 3, "constraints": 3, "indexes": 7}
    assert js["illegal"].startswith("ConstraintValidationFailed: endpoint label presence verification failed")


@needs_node
@needs_wasm
def test_js_dump_loads_natively(built):
    tmp, js, py = built
    got = native(tmp, "load", js["text"])
    assert got["canon_of_parsed"]  # json.loads keeps every type the JS canon() wrote
    assert got["made"] == {"nodes": 10, "relationships": 3, "constraints": 3, "indexes": 7}
    assert got["content_digest"] == got["digest"] == js["digest"]
    assert got["text"] == js["text"]  # Python's dump of the loaded .rl is the JS dump, byte for byte
    assert got["spec"] == py["spec"]  # graph type and constraints as built
    assert got["illegal"].startswith("ConstraintValidationFailed: endpoint label presence verification failed")


@needs_node
@needs_wasm
def test_python_dump_loads_in_wasm(built):
    tmp, js, py = built
    got = node(tmp, "load", py["text"])
    assert got["made"] == {"nodes": 10, "relationships": 3, "constraints": 3, "indexes": 7}
    assert got["text"] == py["text"] and got["contentDigest"] == js["digest"]


# --- refusals ---------------------------------------------------------------------------------

def _dump_with(**node0) -> str:
    d = {"format": 1, "engine": PIN, "constraints": [], "indexes": [], "graph_type": "{}", "relationships": [],
         "nodes": [{"k": 0, "labels": ["N"], "key": None, "props": {"a": 1}, "vecs": [], "typed": [], **node0}]}
    return json.dumps(d)


@needs_node
@needs_wasm
def test_js_refuses_what_it_does_not_handle(tmp_path):
    good = json.loads(_dump_with())
    dangling = dict(good, relationships=[{"s": 0, "e": 9, "type": "R", "props": {}, "vecs": [], "typed": []}])
    typed_gt = dict(good, graph_type="{\n  (:`N` => {`a` :: INTEGER})\n}")
    cases = {
        "dump": ["CREATE (:T {when: date('2026-10-08')})", "CREATE (:T {at: point({x: 1.0, y: 2.0})})",
                 "CREATE (:T {e: vector([0.1, 0.2], 2, FLOAT32)})", "CREATE (:T {d: duration('P1D')})",
                 "CREATE (:__Mig {__k: 0})"],
        "load": [_dump_with(vecs=[{"k": "e", "dim": 2, "type": "FLOAT32", "values": [0.1, 0.2]}]),
                 _dump_with(typed=[{"k": "when", "type": "DATE", "list": False, "values": ["2026-10-08"]}]),
                 _dump_with(props={"m": {"nested": 1}}), json.dumps(dangling), json.dumps(typed_gt),
                 json.dumps(dict(good, format=2)), json.dumps(dict(good, graph_type="{ CONSTRAINT `c` FOR (`n`:`N`) "
                                                                    "REQUIRE (`n`.`a`) IS UNIQUE }"))],
    }
    got = node(tmp_path, "refusals", cases)
    assert [why.split(": ", 2)[-1] for why in got["dump"]] == [
        "property 'when' has type DATE NOT NULL, which replay.mjs does not handle (temporal, POINT, DURATION and "
        "VECTOR values need lib/replay.py)",
        "property 'at' has type POINT NOT NULL, which replay.mjs does not handle (temporal, POINT, DURATION and "
        "VECTOR values need lib/replay.py)",
        "property 'e' has type VECTOR<FLOAT32 NOT NULL>(2) NOT NULL, which replay.mjs does not handle (temporal, "
        "POINT, DURATION and VECTOR values need lib/replay.py)",
        "property 'd' has type DURATION NOT NULL, which replay.mjs does not handle (temporal, POINT, DURATION and "
        "VECTOR values need lib/replay.py)",
        "node :__Mig carries __Mig/__k, the scratch names load() uses; is this the target of an interrupted load?"]
    assert all(why.startswith("ReplayError: node :T: ") for why in got["dump"][:4])
    whys = [case["why"] for case in got["load"]]
    assert whys == [
        "ReplayError: node 0: VECTOR property 'e' needs lib/replay.py",
        "ReplayError: node 0: DATE property 'when' needs lib/replay.py",
        "ReplayError: node 0: property 'm' holds a map, which replay.mjs does not handle",
        "ReplayError: relationship 0 :R points at node 0 -> 9, which the dump does not contain",
        "ReplayError: the target already has constraints (mine), which ALTER CURRENT GRAPH TYPE SET would drop; "
        "load into a fresh database",
        "ReplayError: dump format 2, expected 1",
        "ReplayError: graph_type holds CONSTRAINT entries ('CONSTRAINT `c` FOR (`n`:`N`) REQUIRE (`n`.`a`) IS UNIQUE', "
        "...); constraints belong in dump.constraints"]
    assert all(case["untouched"] for case in got["load"])  # refused before the first write
