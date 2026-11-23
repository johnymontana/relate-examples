"""lib/replay.py: the typed round trip, run in CI.

Example 01 dumps its browser store with lib/replay.mjs and loads that dump natively with
lib/replay.py (harness/native.py). These tests keep every typed path covered: FLOAT32, FLOAT64
and INT8 vectors; a ZONED DATETIME with a named zone and nanoseconds; DURATIONs with and
without months; 2D, 3D, cartesian and geographic POINTs; typed and plain lists; a node and a
relationship whose plain properties hold an integer srid beside x/y; and a two-property
FULLTEXT index. Graph types are covered in-process and, for a .rl reopened read-only after a
load over 2,000 keyed nodes, in a subprocess of this interpreter pinned to the project's
relate-db version. Everything runs on :memory: except that subprocess case.
lib/tests/test_replay_js.py covers lib/replay.mjs.

Tests named test_pin_* assert today's engine behaviour (examples/01-wasm-extract/NOTES.md
names the row). When one fails, the engine has changed: update the row and the lib/replay
docstring.
"""

import importlib.metadata
import json
import os
import subprocess
import sys
from pathlib import Path

import relate
import pytest

import replay

MEMORY = ":memory:"

SCHEMA = [
    "CREATE CONSTRAINT user_key FOR (u:User) REQUIRE u.key IS UNIQUE",
    "CREATE CONSTRAINT ep_key FOR (e:Episode) REQUIRE (e.id, e.ts) IS NODE KEY",
    "CREATE CONSTRAINT ep_ts FOR (e:Episode) REQUIRE e.ts IS :: INTEGER",
    "CREATE CONSTRAINT said_ts FOR ()-[r:SAID]-() REQUIRE r.ts IS NOT NULL",
    "CREATE FULLTEXT INDEX fact_two FOR (f:Fact|Note) ON EACH [f.text, f.title]",
    ("CREATE VECTOR INDEX fact_e FOR (f:Fact) ON (f.e) "
     "OPTIONS {indexConfig: {`vector.dimensions`: 3, `vector.similarity_function`: 'cosine'}}"),
    "CREATE INDEX ep_ab FOR (e:Episode) ON (e.a, e.b)",
    "CREATE POINT INDEX place_loc FOR (p:Place) ON (p.loc)",
    "CREATE TEXT INDEX user_name FOR (u:User) ON (u.name)",
    "CREATE LOOKUP INDEX node_labels FOR (n) ON EACH labels(n)",
]
DATA = """
CREATE (mara:User:Person {key: 'u:mara', name: 'Mara Okafor', tags: ['a', 'b'], scores: [1.5, 2.5],
        flags: [true, false], none: []})
CREATE (li:User {key: 'u:li', name: 'Li Wei'})
CREATE (f1:Fact {id: 'f1', text: 'alpha standup', title: 'bravo', e: vector([0.1, 0.2, 0.3], 3, FLOAT32),
        at: datetime('2026-09-28T10:15:30.123456789+02:00[Europe/Berlin]'),
        span: duration('P1Y2M3DT4H5M6.007S'), lag: duration('P1D'), day: date('2026-09-28'),
        wall: localdatetime('2026-09-28T10:15:30.5'), t: time('10:15:30.000000001+01:00'),
        lt: localtime('23:59:59'), days: [date('2026-01-01'), date('2026-01-02')],
        stamps: [datetime('2026-01-01T00:00:00Z')]})
CREATE (f2:Fact:Note {id: 'f2', text: 'charlie', title: 'delta', e: vector([0.3, 0.2, 0.1], 3, FLOAT32),
        e64: vector([1.0, 2.0], 2, FLOAT64), i8: vector([1, -2], 2, INT8)})
CREATE (e1:Episode {id: 'e1', ts: 1790000000000, a: 1, b: 'x'})
CREATE (pl:Place {name: 'office', srid: 7203, x: 1.0, y: 2.0, loc: point({longitude: 13.4, latitude: 52.5}),
        loc3: point({x: 1.0, y: 2.0, z: 3.0}), path: [point({x: 0.0, y: 0.0}), point({x: 1.0, y: 1.0})]})
CREATE (anon {note: 'no label'})
CREATE (f1)-[:ABOUT {w: 0.5}]->(mara)
CREATE (f1)-[:DERIVED_FROM]->(e1)
CREATE (mara)-[:SAID {ts: 1790000000001, took: duration('PT1.5S'), e: vector([1, 2], 2, INT8),
        `where`: point({x: 1.0, y: 2.0})}]->(li)
CREATE (mara)-[:SAID {ts: 1790000000002}]->(li)
CREATE (li)-[:KNOWS]->(li)
CREATE (anon)-[:NEAR {srid: 4326, x: 13.4, y: 52.5}]->(pl)
"""
COUNTS = {"nodes": 7, "relationships": 6, "constraints": 4, "indexes": 8}  # 6 + the two built-in LOOKUP indexes

# Every property as [key, valueType, toString] (toString is exact for temporals, which
# Python reads lossily) plus the Python value for lists and vectors, which toString rejects.
_PROPS = """[k IN keys({v}) | [k, valueType({v}[k]), CASE
    WHEN valueType({v}[k]) STARTS WITH 'LIST' OR valueType({v}[k]) STARTS WITH 'VECTOR' THEN null
    ELSE toString({v}[k]) END]] AS types, properties({v}) AS props"""
_NAME = "coalesce({v}.key, {v}.id, {v}.name, {v}.note)"


def census(conn):
    """The graph as sorted strings: labels, types, exact values and endpoints, no elementIds."""
    nodes = conn.execute("MATCH (n) RETURN labels(n) AS labels, " + _PROPS.format(v="n")).fetchall()
    rels = conn.execute(f"MATCH (a)-[r]->(b) RETURN type(r) AS type, {_NAME.format(v='a')} AS s, "
                        f"{_NAME.format(v='b')} AS e, " + _PROPS.format(v="r")).fetchall()
    for row in nodes + rels:
        row["types"], row["props"] = sorted(row["types"]), sorted(row["props"].items())
        if "labels" in row:
            row["labels"] = sorted(row["labels"])
    return sorted(repr(sorted(r.items())) for r in nodes + rels)


def build(conn):
    for s in SCHEMA:
        conn.execute(s)
    conn.execute(DATA)
    return conn


@pytest.fixture
def source():
    conn = build(relate.connect(MEMORY))
    yield conn
    conn.close()


def schema(conn):
    """SHOW rows reduced to what a replay must keep (ids and timestamps dropped)."""
    cons = conn.execute("SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties, "
                        "propertyType RETURN * ORDER BY name").fetchall()
    idx = conn.execute("SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, options, "
                       "owningConstraint RETURN * ORDER BY name").fetchall()
    return cons, idx


# --- the typed round trip ----------------------------------------------------

def test_round_trip_through_json_is_exact(source):
    d = replay.dump(source)
    d = json.loads(json.dumps(d))  # the dump is plain JSON: it can cross processes and versions
    target = relate.connect(MEMORY)
    assert replay.load(target, d) == COUNTS
    assert census(target) == census(source)
    assert schema(target) == schema(source)
    assert replay.content_digest(target) == replay.content_digest(source) == replay.digest(d)
    labels = target.execute("CALL db.labels() YIELD label RETURN collect(label) AS l").fetchone()["l"]
    assert replay.MIG_LABEL not in labels


def test_typed_values_keep_their_types(source):
    target = relate.connect(MEMORY)
    replay.load(target, replay.dump(source))
    f1 = target.execute("MATCH (f:Fact {id: 'f1'}) RETURN valueType(f.e) AS e, toString(f.at) AS at, "
                        "toString(f.span) AS span, valueType(f.lag) AS lag, toString(f.t) AS t, "
                        "valueType(f.days) AS days").fetchone()
    assert f1 == {"e": "VECTOR<FLOAT32 NOT NULL>(3) NOT NULL",
                  "at": "2026-09-28T10:15:30.123456789+02:00[Europe/Berlin]",
                  "span": "P1Y2M3DT4H5M6.007S", "lag": "DURATION NOT NULL",
                  "t": "10:15:30.000000001+01:00", "days": "LIST<DATE NOT NULL> NOT NULL"}
    place = target.execute("MATCH (p:Place) RETURN p.srid AS srid, p.x AS x, p.name AS name, "
                           "toString(p.loc) AS loc, valueType(p.path) AS path").fetchone()
    assert place == {"srid": 7203, "x": 1.0, "name": "office",
                     "loc": "point({x: 13.4, y: 52.5, crs: 'wgs-84'})", "path": "LIST<POINT NOT NULL> NOT NULL"}


def test_search_indexes_answer_after_load(source):
    target = relate.connect(MEMORY)
    replay.load(target, replay.dump(source))
    # 'delta' is only in f2.title, the SECOND property of fact_two: an index narrowed to one property misses it.
    hit = target.execute("MATCH (f) SEARCH f IN (FULLTEXT INDEX fact_two FOR 'delta' LIMIT 3) SCORE AS s "
                         "RETURN f.id AS id").fetchall()
    assert hit == [{"id": "f2"}]
    top = target.execute("MATCH (f:Fact) SEARCH f IN (VECTOR INDEX fact_e FOR vector([0.3, 0.2, 0.1], 3, FLOAT32) "
                         "LIMIT 1) SCORE AS s RETURN f.id AS id").fetchall()
    assert top == [{"id": "f2"}]


def test_dump_is_canonical_and_keyed(source):
    d = replay.dump(source)
    assert d["format"] == replay.FORMAT and [n["k"] for n in d["nodes"]] == list(range(COUNTS["nodes"]))
    keys = sorted(json.dumps(n["key"], sort_keys=True) for n in d["nodes"] if n["key"])
    assert keys == ['{"label": "Episode", "props": {"id": "e1", "ts": 1790000000000}}',
                    '{"label": "User", "props": {"key": "u:li"}}',
                    '{"label": "User", "props": {"key": "u:mara"}}']
    fact = next(n for n in d["nodes"] if n["props"].get("id") == "f1")
    assert {v["k"]: (v["type"], v["dim"]) for v in fact["vecs"]} == {"e": ("FLOAT32", 3)}
    assert {t["k"]: t["type"] for t in fact["typed"]}["span"] == "DURATION"
    assert replay.dump(source) == d  # a second dump of the same graph is identical


# --- the digest --------------------------------------------------------------

def test_digest_ignores_order_and_element_ids():
    a = relate.connect(MEMORY)
    a.execute("CREATE CONSTRAINT k FOR (n:N) REQUIRE n.k IS UNIQUE")
    a.execute("CREATE (:N {k: 1, z: 'x', at: date('2026-01-01'), e: vector([1.0], 1, FLOAT32)})-[:R {w: 1}]->(:N {k: 2})")
    b = relate.connect(MEMORY)
    b.execute("CREATE CONSTRAINT k FOR (n:N) REQUIRE n.k IS UNIQUE")
    b.execute("UNWIND range(1, 5) AS i CREATE (:Filler {i: i})")  # shift b's elementIds
    b.execute("MATCH (f:Filler) DELETE f")
    b.execute("CREATE (:N {k: 2})")
    b.execute("CREATE (:N {e: vector([1.0], 1, FLOAT32), at: date('2026-01-01'), z: 'x', k: 1})")
    b.execute("MATCH (x:N {k: 1}), (y:N {k: 2}) CREATE (x)-[:R {w: 1}]->(y)")
    assert replay.content_digest(a) == replay.content_digest(b)
    assert json.dumps(replay.dump(a)) == json.dumps(replay.dump(b))  # canonical without sort_keys too
    b.execute("MATCH ()-[r:R]->() SET r.w = 1.0")  # INTEGER 1 -> FLOAT 1.0 is a change
    assert replay.content_digest(a) != replay.content_digest(b)


# --- pins: why the module does what it does -------------------------------------

def test_fulltext_create_statement_replays_verbatim(source):
    """A FULLTEXT index's createStatement says ON EACH [...] with its OPTIONS, and replays as is;
    index_ddl() builds the same index from the SHOW columns (what load() runs)."""
    row = next(i for i in replay.dump(source)["indexes"] if i["name"] == "fact_two")
    assert row["properties"] == ["text", "title"]
    verbatim = relate.connect(MEMORY)
    verbatim.execute(row["createStatement"])
    kept = verbatim.execute("SHOW INDEXES YIELD name, properties WHERE name = 'fact_two' RETURN properties").fetchone()
    assert kept == {"properties": ["text", "title"]}
    assert replay.index_ddl(row).startswith(
        "CREATE FULLTEXT INDEX `fact_two` FOR (n:`Fact`|`Note`) ON EACH [n.`text`, n.`title`] OPTIONS {")


def test_pin_composite_range_and_lookup_create_statements(source):
    """A composite RANGE createStatement keeps both properties and a LOOKUP one replays verbatim;
    index_ddl() builds them from the columns either way."""
    rows = {i["name"]: i for i in replay.dump(source)["indexes"]}
    verbatim = relate.connect(MEMORY)
    verbatim.execute(rows["ep_ab"]["createStatement"])
    kept = verbatim.execute("SHOW INDEXES YIELD name, properties WHERE name = 'ep_ab' RETURN properties").fetchone()
    assert kept == {"properties": ["a", "b"]}, "the composite RANGE createStatement narrowed"
    verbatim.execute(rows["node_labels"]["createStatement"])
    lookup = verbatim.execute("SHOW INDEXES YIELD name, type, entityType WHERE name = 'node_labels' "
                              "RETURN type, entityType").fetchone()
    assert lookup == {"type": "LOOKUP", "entityType": "NODE"}
    assert replay.index_ddl(rows["ep_ab"]) == "CREATE INDEX `ep_ab` FOR (n:`Episode`) ON (n.`a`, n.`b`)"
    assert replay.index_ddl(rows["node_labels"]) == "CREATE LOOKUP INDEX `node_labels` FOR (n) ON EACH labels(n)"


def test_pin_index_provider_option_is_refused():
    """NOTES.md R9: OPTIONS {indexProvider: ...} is a syntax error (only indexConfig is accepted), and
    SHOW INDEXES reports the provider in its own column. index_ddl() leaves indexProvider out, so a
    dump that an older engine wrote with {indexProvider: 'range-1.0'} still loads, and builds."""
    conn = relate.connect(MEMORY)
    with pytest.raises(relate.ProgrammingError, match="Expected 'indexConfig'"):
        conn.execute("CREATE INDEX kind_key FOR (k:Kind) ON (k.id) OPTIONS {indexProvider: 'range-1.0'}")
    old = {"name": "kind_key", "type": "RANGE", "entityType": "NODE", "labelsOrTypes": ["Kind"],
           "properties": ["id"], "options": {"indexProvider": "range-1.0", "indexConfig": {}}}
    assert replay.index_ddl(old) == "CREATE INDEX `kind_key` FOR (n:`Kind`) ON (n.`id`)"
    conn.execute(replay.index_ddl(old))
    row = conn.execute("SHOW INDEXES YIELD name, indexProvider, options, createStatement WHERE name = 'kind_key' "
                       "RETURN indexProvider, options, createStatement IS NOT NULL AS built").fetchone()
    assert row == {"indexProvider": "range-1.0", "options": {"indexConfig": {}}, "built": True}
    assert replay._index_mismatch({**old, "options": row["options"]}, old) is None


def test_srid_map_is_set_as_a_map():
    """A dict with an integer srid beside x/y stays a MAP when bound (older bindings turned it into
    a POINT and dropped its other keys), and load() writes such properties as they were."""
    conn = relate.connect(MEMORY)
    props = {"srid": 7203, "x": 1.0, "y": 2.0, "name": "office"}
    conn.execute("CREATE (m:Place) SET m = $props", {"props": props})
    assert conn.execute("MATCH (m:Place) RETURN properties(m) AS p").fetchone()["p"] == props
    conn.execute("MATCH (m:Place) DETACH DELETE m")
    replay.load(conn, {"format": replay.FORMAT, "constraints": [], "indexes": [], "relationships": [],
                       "nodes": [{"k": 0, "labels": ["Place"], "key": None, "props": props, "vecs": [], "typed": []}]})
    assert conn.execute("MATCH (m:Place) RETURN properties(m) AS p").fetchone()["p"] == props


def test_pin_python_reads_temporals_as_objects():
    """Why dump() takes temporals from toString() in Cypher: the binding returns its own objects for
    them (Duration, Temporal), which are not plain JSON."""
    conn = relate.connect(MEMORY)
    conn.execute("CREATE (:T {m: duration('P1M'), z: datetime('2026-09-28T10:15:30.123456789+02:00[Europe/Berlin]')})")
    p = conn.execute("MATCH (t:T) RETURN properties(t) AS p").fetchone()["p"]
    assert type(p["m"]).__name__ == "Duration" and p["m"].months == 1, "a DURATION now reads back as another type"
    assert type(p["z"]).__name__ == "Temporal" and p["z"].text == "2026-09-28T10:15:30.123456789+02:00[Europe/Berlin]"
    with pytest.raises(TypeError):
        json.dumps(p["m"])


# --- refusals: validated before the first write ---------------------------------

def _empty(conn):
    n = conn.execute("MATCH (n) RETURN count(n) AS c").fetchone()["c"]
    c = conn.execute("SHOW CONSTRAINTS YIELD name RETURN count(name) AS c").fetchone()["c"]
    return n == 0 and c == 0


@pytest.mark.parametrize("damage, message", [
    (lambda d: d["constraints"].append(dict(d["constraints"][0], name="gt", type="NODE_LABEL_EXISTENCE")),
     "kind 'NODE_LABEL_EXISTENCE'"),
    (lambda d: d["indexes"].append(dict(d["indexes"][0], name="odd", type="SPATIAL")), "kind 'SPATIAL'"),
    (lambda d: d["relationships"].append({"s": 0, "e": 99, "type": "R", "props": {}, "vecs": [], "typed": []}),
     "does not contain"),
    (lambda d: d["relationships"].append({"s": None, "e": 0, "type": "R", "props": {}, "vecs": [], "typed": []}),
     "does not contain"),
    (lambda d: next(n for n in d["nodes"] if n["vecs"])["vecs"][0].update(type="BFLOAT16"), "vector coordinate"),
    (lambda d: d.update(format=0), "dump format"),
])
def test_load_refuses_before_writing(source, damage, message):
    d = replay.dump(source)
    damage(d)
    target = relate.connect(MEMORY)
    with pytest.raises(replay.ReplayError, match=message):
        replay.load(target, d)
    assert _empty(target)


def test_dump_refuses_scratch_names():
    conn = relate.connect(MEMORY)
    conn.execute(f"CREATE (:{replay.MIG_LABEL} {{{replay.MIG_KEY}: 0}})")
    with pytest.raises(replay.ReplayError, match="interrupted load"):
        replay.dump(conn)


# --- graph types -----------------------------------------------------------------------

GRAPH_TYPE = ("ALTER CURRENT GRAPH TYPE SET { (:PERSON => {name :: STRING NOT NULL}), "
              "(:COMPANY => {name :: STRING NOT NULL}), (:`ÄRZTE, Inc` => {name :: STRING NOT NULL}), "
              "(:PERSON)-[:FOUNDED => {p :: FLOAT}]->(:COMPANY), (p:Tag => :Label {name :: STRING NOT NULL}) "
              "REQUIRE (p.name) IS KEY }")
GT_SCHEMA = [  # after the ALTER: SET drops every constraint that exists (NOTES.md R16)
    "CREATE CONSTRAINT kind_id FOR (k:Kind) REQUIRE k.id IS UNIQUE",
    "CREATE CONSTRAINT person_name FOR (p:PERSON) REQUIRE p.name IS UNIQUE",
    "CREATE FULLTEXT INDEX kind_desc FOR (k:Kind) ON EACH [k.description]",
]
GT_DATA = ("CREATE (:PERSON {name: 'Ada', score: 1.0})-[:FOUNDED {p: 0.9}]->(:COMPANY {name: 'Acme'}), "
           "(:Kind {id: 'PERSON', description: 'A named person.'}), (:`ÄRZTE, Inc` {name: 'Dr'}), "
           "(:Tag:Label {name: 't'})")
ELEMENTS = [
    "(:`COMPANY` => {`name` :: STRING NOT NULL})",
    "(:`PERSON` => {`name` :: STRING NOT NULL})",
    "(:`Tag` => :`Label` {`name` :: STRING NOT NULL})",
    "(:`ÄRZTE, Inc` => {`name` :: STRING NOT NULL})",
    "(:`PERSON` =>)-[:`FOUNDED` => {`p` :: FLOAT}]->(:`COMPANY` =>)",
]


def graph_typed(conn):
    conn.execute(GRAPH_TYPE)
    for s in GT_SCHEMA:
        conn.execute(s)
    conn.execute(GT_DATA)
    return conn


def spec(conn):
    return conn.execute("SHOW CURRENT GRAPH TYPE YIELD specification RETURN specification").fetchone()["specification"]


def all_constraints(conn):
    return conn.execute("SHOW CONSTRAINTS YIELD name, type, classification, labelsOrTypes, properties, "
                        "propertyType, enforcedLabel RETURN * ORDER BY name").fetchall()


def test_graph_type_round_trip():
    src = graph_typed(relate.connect(MEMORY))
    d = json.loads(json.dumps(replay.dump(src)))
    assert d["graph_type"] == replay.render_graph_type(ELEMENTS)  # the engine's own layout, no CONSTRAINT entries
    names = [c["name"] for c in d["constraints"]]
    assert len(names) == 3 and names[0].startswith("constraint_") and names[1:] == ["kind_id", "person_name"]
    assert [i["name"] for i in d["indexes"] if i["type"] != "LOOKUP"] == ["kind_desc"]
    target = relate.connect(MEMORY)
    assert replay.load(target, d) == {"nodes": 5, "relationships": 1, "constraints": 3, "indexes": 3}
    assert spec(target) == spec(src)  # CONSTRAINT entries included: same constraints, same layout
    assert all_constraints(target) == all_constraints(src)  # the dependent ones came back through the ALTER
    assert schema(target) == schema(src)
    assert replay.content_digest(target) == replay.digest(d) == replay.content_digest(src)
    with pytest.raises(relate.IntegrityError, match="endpoint label presence verification failed"):
        target.execute("MATCH (c:COMPANY) CREATE (:Kind {id: 'x'})-[:FOUNDED]->(c)")


def test_graph_type_digest_is_data_only():
    """The schema is not in the digest: a graph keeps its digest with or without a graph type.

    (A graph type's `REQUIRE ... IS KEY` is a NODE KEY constraint, though, and key
    constraints decide node identities, so that part would change it.)
    """
    plain, typed = relate.connect(MEMORY), relate.connect(MEMORY)
    typed.execute(GRAPH_TYPE.replace(" REQUIRE (p.name) IS KEY", ""))
    for conn in (plain, typed):
        conn.execute(GT_DATA)
    assert replay.dump(plain)["graph_type"] == "{}"
    assert replay.content_digest(plain) == replay.content_digest(typed)


def test_digest_is_unchanged_for_a_fixed_graph():
    """Pinned before graph types were added: lib/replay must not change what it hashes."""
    conn = relate.connect(MEMORY)
    conn.execute("CREATE CONSTRAINT k FOR (n:N) REQUIRE n.k IS UNIQUE")
    conn.execute("CREATE (:N {k: 1, f: 1.0, s: 'é', l: [0.5, 2.0]})-[:R {w: 3}]->(:N {k: 2}), (:Anon {x: true})")
    assert replay.content_digest(conn) == "666e48fe28f9dd0edb4544362c61d568918d8c8eab1a977f4df9be23f9be45ae"


def test_dump_without_graph_type_loads_as_before(source):
    d = replay.dump(source)
    del d["graph_type"]  # a dump made before graph types
    target = relate.connect(MEMORY)
    assert replay.load(target, d) == COUNTS
    assert spec(target) == spec(source)
    assert replay.graph_type_ddl(d) is None


@pytest.mark.parametrize("value, message", [
    ("{\n  CONSTRAINT `u` FOR (`n`:`N`) REQUIRE (`n`.`k`) IS UNIQUE\n}", "CONSTRAINT entries"),
    ("(:A => {name :: STRING})", "not a {...} specification"),
    ("{ (:`A => {name :: STRING}) }", "unbalanced"),
    ("{ (:A => {name :: STRING}), }", "empty item"),
])
def test_load_refuses_a_bad_graph_type_before_writing(source, value, message):
    d = replay.dump(source)
    d["graph_type"] = value
    target = relate.connect(MEMORY)
    with pytest.raises(replay.ReplayError, match=message):
        replay.load(target, d)
    assert _empty(target)


def test_load_refuses_a_target_with_constraints_before_writing():
    d = replay.dump(graph_typed(relate.connect(MEMORY)))
    target = relate.connect(MEMORY)
    target.execute("CREATE CONSTRAINT mine FOR (m:Mine) REQUIRE m.id IS UNIQUE")
    with pytest.raises(replay.ReplayError, match=r"already has constraints \(mine\)"):
        replay.load(target, d)
    assert target.execute("MATCH (n) RETURN count(n) AS c").fetchone()["c"] == 0


def test_split_graph_type():
    assert replay.split_graph_type("{}") == ([], [])
    text = ("{\n  (:`a,b` => {`x}` :: STRING}),\n  (:`we``ird` =>)-[:`R` =>]->(:`a,b` =>),\n"
            "  CONSTRAINT `u` FOR (`n`:`a,b` =>) REQUIRE (`n`.`x}`) IS UNIQUE\n}")
    elements, constraints = replay.split_graph_type(text)
    assert elements == ["(:`a,b` => {`x}` :: STRING})", "(:`we``ird` =>)-[:`R` =>]->(:`a,b` =>)"]
    assert constraints == ["CONSTRAINT `u` FOR (`n`:`a,b` =>) REQUIRE (`n`.`x}`) IS UNIQUE"]
    assert replay.render_graph_type(elements) == text.split(",\n  CONSTRAINT")[0] + "\n}"


def test_pin_alter_set_drops_existing_constraints():
    """NOTES.md R16: why load() runs the ALTER before the schema DDL and refuses a target with constraints."""
    conn = relate.connect(MEMORY)
    conn.execute("CREATE CONSTRAINT mine FOR (m:Mine) REQUIRE m.id IS UNIQUE")
    conn.execute("ALTER CURRENT GRAPH TYPE SET { (:P => {name :: STRING}) }")
    names = conn.execute("SHOW CONSTRAINTS YIELD name RETURN collect(name) AS n").fetchone()["n"]
    assert "mine" not in names and len(names) == 1, "ALTER ... SET now keeps other constraints"


def test_pin_unique_and_index_on_one_key_refuse_each_other():
    """NOTES.md R9: a UNIQUE constraint's backing index serves its key, and a plain index on the same
    key is refused in either order (EquivalentSchemaRuleAlreadyExists with the constraint first,
    `AlreadyExists: there already exists an index` with the index first). A dump an older engine made
    can carry such an index beside its UNIQUE: load() drops it (_shadowed_indexes)."""
    conn = relate.connect(MEMORY)
    conn.execute("CREATE CONSTRAINT kind_id FOR (k:Kind) REQUIRE k.id IS UNIQUE")
    with pytest.raises(relate.OperationalError, match="EquivalentSchemaRuleAlreadyExists"):
        conn.execute("CREATE INDEX kind_key FOR (k:Kind) ON (k.id)")
    other = relate.connect(MEMORY)
    other.execute("CREATE INDEX kind_key FOR (k:Kind) ON (k.id)")
    with pytest.raises(relate.OperationalError, match="AlreadyExists: there already exists an index"):
        other.execute("CREATE CONSTRAINT kind_id FOR (k:Kind) REQUIRE k.id IS UNIQUE")
    d = {"constraints": [{"name": "c", "type": "NODE_PROPERTY_UNIQUENESS", "entityType": "NODE",
                          "labelsOrTypes": ["K"], "properties": ["id"], "propertyType": None}],
         "indexes": [{"name": "i", "type": "RANGE", "entityType": "NODE", "labelsOrTypes": ["K"],
                      "properties": ["id"], "options": {"indexProvider": "range-1.0"}}]}
    assert replay._shadowed_indexes(d) == {"i"}
    assert replay.ddl({**d, "indexes": [i for i in d["indexes"] if i["name"] not in {"i"}]}) == [
        "CREATE CONSTRAINT `c` FOR (n:`K`) REQUIRE (n.`id`) IS UNIQUE"]


# --- a graph-typed .rl through dump/load on the project engine, in a subprocess -----------
# (A fresh interpreter, so the .rl is written, closed and reopened read-only by one engine
# whose version is asserted: the project env's relate-db, the pin in pyproject.toml.)

REPO = Path(__file__).resolve().parents[2]
try:
    PIN = importlib.metadata.version("relate-db")
except importlib.metadata.PackageNotFoundError:
    PIN = None
_ON_PIN = r"""
import json, sys, tempfile, time
sys.path.insert(0, sys.argv[1])
import relate, replay
assert relate.__version__ == sys.argv[3], (relate.__version__, sys.argv[3])
statements = json.loads(sys.argv[2])
spec = lambda c: c.execute("SHOW CURRENT GRAPH TYPE YIELD specification RETURN specification").fetchone()["specification"]
all_constraints = lambda c: c.execute("SHOW CONSTRAINTS YIELD name, type, classification, labelsOrTypes, "
                                      "properties, propertyType, enforcedLabel RETURN * ORDER BY name").fetchall()
src = relate.connect(":memory:")
for s in statements:
    src.execute(s)
src.execute("UNWIND range(1, 2000) AS i CREATE (:Kind {id: 'k' + toString(i)})")
src.execute("MATCH (a:Kind) WHERE a.id STARTS WITH 'k' "  # two MATCH clauses: a map that names a variable of
            "MATCH (b:Kind {id: 'k' + toString(toInteger(substring(a.id, 1)) % 2000 + 1)}) "  # the same MATCH matches all
            "CREATE (a)-[:NEXT]->(b)")
d = json.loads(json.dumps(replay.dump(src)))
path = tempfile.mkdtemp() + "/gt.rl"
conn = relate.connect(path)
t = time.monotonic()
made = replay.load(conn, d)
took = time.monotonic() - t
conn.close()
conn = relate.connect(path, read_only=True)
print(json.dumps({"made": made, "fast": took < 20, "spec": spec(conn) == spec(src),
                  "constraints": all_constraints(conn) == all_constraints(src),
                  "digest": replay.content_digest(conn) == replay.digest(d)}, sort_keys=True))
"""


@pytest.mark.skipif(PIN is None, reason="relate-db is not installed in this env (uv sync)")
def test_graph_type_round_trip_on_pinned_wheel():
    """A graph-typed .rl through dump/load on the pinned wheel (the scratch key's lookups must be served)."""
    statements = json.dumps([GRAPH_TYPE, *GT_SCHEMA, GT_DATA])
    out = subprocess.run([sys.executable, "-I", "-c", _ON_PIN, str(REPO / "lib"), statements, PIN],
                         capture_output=True, text=True, timeout=600, env={**os.environ, "RELATE_TELEMETRY": "off"})
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout) == {"made": {"nodes": 2005, "relationships": 2001, "constraints": 3, "indexes": 3},
                                      "fast": True, "spec": True, "constraints": True, "digest": True}
