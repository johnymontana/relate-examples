"""Dump a Relate graph to plain JSON and replay it into a fresh database.

Relate has no dump command. Example 33 needs one anyway: a store made in the browser (WASM, in
OPFS) has to load natively, and a native store in the browser, independently of the internal file
formats; replaying the live rows into a new store also leaves behind the stale bytes a deleted
value can keep in a file (examples/33-wasm-extract/NOTES.md R10). A generic replay runs into these
traps, and this module handles each one (the R-ids are NOTES.md's rows):

Schema  Every constraint and index is rebuilt from its SHOW columns, options included, never
        from createStatement, and load() checks the result against the dumped rows. The check
        allows the option keys the engine adds (the vector.hnsw.* and vector.quantization.*
        defaults) and compares vector.similarity_function case-insensitively ('cosine' reads back
        as 'COSINE'); a mismatch names each differing option and both values. Unknown kinds fail
        loudly before anything is written. An indexProvider in a dumped options map (an older
        engine wrote one) is left out of the OPTIONS written, which accept only indexConfig, and
        an index the target already holds by name (the two built-in LOOKUP indexes every store
        starts with) is not created again (R9).
Order   Indexes are created before constraints, and a dumped RANGE index on a UNIQUE or KEY
        constraint's key is dropped (_shadowed_indexes): the constraint's own backing index
        serves the key, and an equivalent index and constraint refuse each other (R9).
Graph   A CIP-176 graph type (ALTER CURRENT GRAPH TYPE SET {...}) creates `dependent`
types   constraints (NODE_PROPERTY_TYPE, RELATIONSHIP_SOURCE_LABEL, NODE_LABEL_EXISTENCE, ...)
        that CREATE CONSTRAINT cannot make or drop. So dump() skips constraints whose
        classification is 'dependent' and keeps the graph type as text instead, under
        "graph_type". SHOW CURRENT GRAPH TYPE also lists every other constraint as a CONSTRAINT
        entry; those are left out, since the constraint rows carry them. load() runs ALTER
        CURRENT GRAPH TYPE SET after the data (which it validates) and before the schema DDL,
        because SET drops every constraint that exists (R16); it refuses a target that already
        has constraints, and checks that the graph type reads back element for element. A dump
        without "graph_type" loads as before.
Maps    Properties travel as [key, value] pairs, and points as {srid, coords}: some bindings
        turn a dict parameter with an integer `srid` beside x/y into a POINT, and the pair form
        keeps a dump loadable there too.
Types   The binding returns its own objects for temporal, DURATION and VECTOR values (R21), and
        older bindings read some lossily (a DURATION with months as a str, a ZONED DATETIME
        without its zone id). So dump() reads temporal values with toString() in Cypher, and
        load() parses them with date(), datetime(), duration() and so on. Vectors are read from
        the binding's Vector (or a {dim, type, values} map) and rebuilt with one CASE branch per
        coordinate type, since vector() needs the coordinate type as a keyword.
Ids     elementIds do not carry over to another store. The dump numbers its nodes 0..n-1 in a
        canonical order, and relationships refer to those numbers. During load, a temporary
        :__Mig label with a UNIQUE __k maps the numbers to the new nodes (the constraint's
        backing index serves the lookups); both are removed at the end.
Nulls   The relationship rows are guarded on the parameter side (WHERE row.s IS NOT NULL AND
        row.e IS NOT NULL), dangling ids are refused before anything is written, and the
        created counts are checked. (A null in a MATCH property map matches nothing on Relate
        1.2.0, R3; the guard keeps the load correct on any engine.)

The dump is plain JSON (json.dumps works on it), so it can cross a process, a surface (the WASM
build writes the same format through lib/replay.mjs) or an engine version. Each node carries its
business key, taken from a UNIQUE or NODE KEY constraint on one of its labels. content_digest()
hashes a canonical dump that uses those keys, or a content fingerprint for nodes without a key.
Two stores that hold the same graph get the same digest, whatever their elementIds, insertion
order or page layout. The schema is not part of the digest; compare it with ddl(dump),
dump['constraints'] / dump['indexes'] and dump['graph_type']. Because identities come from the key
constraints, dropping one of them changes the digest.

    d = replay.dump(conn)            # a relate Connection, or an owner object with run(fn)
    new = relate.connect("work/copy.rl")
    replay.load(new, d)              # -> {'nodes': .., 'relationships': .., 'constraints': .., 'indexes': ..}
    assert replay.content_digest(new) == replay.digest(d)
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable, Iterator, Mapping, Sequence
from typing import Any, TypeVar

import relate

T = TypeVar("T")
FORMAT = 1
MIG_LABEL, MIG_KEY, MIG_CONSTRAINT, MIG_INDEX = "__Mig", "__k", "__mig_k", "__mig_k_range"

# valueType() base name -> the Cypher function that parses its toString() form.
_TEMPORAL = {
    "DATE": "date",
    "LOCAL TIME": "localtime",
    "ZONED TIME": "time",
    "LOCAL DATETIME": "localdatetime",
    "ZONED DATETIME": "datetime",
    "DURATION": "duration",
}
_PLAIN = {"BOOLEAN", "INTEGER", "FLOAT", "STRING", "NOTHING"}  # NOTHING: the empty list
# Vector coordinate type as valueType() reports it -> the keyword vector() takes.
_VECTOR = {
    "FLOAT32": "FLOAT32",
    "FLOAT": "FLOAT64",
    "INTEGER": "INT64",
    "INTEGER32": "INT32",
    "INTEGER16": "INT16",
    "INTEGER8": "INT8",
}
_VECTOR_ALIAS = {"FLOAT64": "FLOAT", "INT64": "INTEGER", "INTEGER64": "INTEGER",
                 "INT32": "INTEGER32", "INT16": "INTEGER16", "INT8": "INTEGER8"}

# SHOW CONSTRAINTS type -> (entityType, REQUIRE predicate).
_CONSTRAINTS = {
    "NODE_PROPERTY_UNIQUENESS": ("NODE", "IS UNIQUE"),
    "NODE_KEY": ("NODE", "IS NODE KEY"),
    "NODE_PROPERTY_EXISTENCE": ("NODE", "IS NOT NULL"),
    "NODE_PROPERTY_TYPE": ("NODE", "IS :: {propertyType}"),
    "RELATIONSHIP_PROPERTY_UNIQUENESS": ("RELATIONSHIP", "IS UNIQUE"),
    "RELATIONSHIP_KEY": ("RELATIONSHIP", "IS RELATIONSHIP KEY"),
    "RELATIONSHIP_PROPERTY_EXISTENCE": ("RELATIONSHIP", "IS NOT NULL"),
    "RELATIONSHIP_PROPERTY_TYPE": ("RELATIONSHIP", "IS :: {propertyType}"),
}
_KEY_KINDS = ("NODE_PROPERTY_UNIQUENESS", "NODE_KEY")
_INDEXES = ("RANGE", "TEXT", "POINT", "VECTOR", "FULLTEXT", "LOOKUP")
_C_COLS = ("name", "type", "entityType", "labelsOrTypes", "properties", "propertyType", "createStatement")
_I_COLS = ("name", "type", "entityType", "labelsOrTypes", "properties", "options", "createStatement")
# Index options whose string values the engine normalises: it reports the similarity function
# upper-cased, whatever the CREATE statement said.
_CASELESS_OPTIONS = frozenset({"vector.similarity_function"})


class ReplayError(RuntimeError):
    """A dump or load that would lose or invent data. Raised before any write when possible."""


# --- reading -----------------------------------------------------------------

# For each property: [key, valueType, toString form(s) when temporal]. CASE is lazy,
# so toString() never sees a list or a vector.
_TYPES = """[k IN keys({v}) | [k, valueType({v}[k]), CASE
    WHEN any(t IN $temporal WHERE valueType({v}[k]) STARTS WITH t) THEN [toString({v}[k])]
    WHEN any(t IN $temporal WHERE valueType({v}[k]) STARTS WITH 'LIST<' + t) THEN [x IN {v}[k] | toString(x)]
  END]]"""
_READ_NODES = ("MATCH (n) RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS props, "
               + _TYPES.format(v="n") + " AS types")
_READ_RELS = ("MATCH (a)-[r]->(b) RETURN elementId(a) AS s, elementId(b) AS e, type(r) AS type, "
              "properties(r) AS props, " + _TYPES.format(v="r") + " AS types")


def dump(conn: Any) -> dict:
    """The whole graph and its schema as plain JSON-able data (see the module docstring).

    `conn` is a relate Connection, or anything with run(fn) (an owner thread that holds the
    connection); the dump then runs as one owner job.
    """
    return _on(conn, _dump)


def _dump(conn: relate.Connection) -> dict:
    constraints = sorted((_project(r, _C_COLS) for r in _rows(conn, "SHOW CONSTRAINTS YIELD * RETURN *")
                          if r.get("classification") != "dependent"), key=lambda r: r["name"])
    graph_type = render_graph_type(split_graph_type(_current_graph_type(conn))[0])
    indexes = sorted((_project(r, _I_COLS) for r in _rows(conn, "SHOW INDEXES YIELD * RETURN *")
                      if r.get("owningConstraint") is None), key=lambda r: r["name"])
    keys = _key_constraints(constraints)
    temporal = {"temporal": list(_TEMPORAL)}
    raw = [_node(r, keys) for r in _rows(conn, _READ_NODES, temporal)]
    raw.sort(key=lambda n: _canon([_identity(n), n["labels"], _values(n)]))
    ordinal = {n.pop("id"): k for k, n in enumerate(raw)}
    nodes = [{"k": k, **n} for k, n in enumerate(raw)]
    rels = [_rel(r, ordinal) for r in _rows(conn, _READ_RELS, temporal)]
    rels.sort(key=lambda r: _canon([r["s"], r["e"], r["type"], _values(r)]))
    return {"format": FORMAT, "engine": getattr(relate, "__version__", "unknown"),
            "constraints": constraints, "indexes": indexes, "graph_type": graph_type,
            "nodes": nodes, "relationships": rels}


def _node(row: Mapping, keys: list[tuple[str, tuple[str, ...]]]) -> dict:
    labels = sorted(row["labels"])
    where = f"node :{':'.join(labels)}"
    if MIG_LABEL in labels or MIG_KEY in row["props"]:
        raise ReplayError(f"{where} carries {MIG_LABEL}/{MIG_KEY}, the scratch names load() uses; "
                          "is this the target of an interrupted load?")
    n = {"id": row["id"], "labels": labels, "key": None, **_split(row["props"], row["types"], where)}
    n["key"] = _business_key(labels, _values(n), keys)
    return n


def _rel(row: Mapping, ordinal: Mapping[str, int]) -> dict:
    where = f"relationship :{row['type']}"
    return {"s": ordinal[row["s"]], "e": ordinal[row["e"]], "type": row["type"],
            **_split(row["props"], row["types"], where)}


def _split(props: Mapping[str, Any], types: Sequence, where: str) -> dict:
    """Plain properties, plus the typed sidecar: vecs [{k, dim, type, values}] and
    typed [{k, type, list, values}], where values are toString() forms or {srid, coords}."""
    plain, vecs, typed = {}, [], []
    for key, value_type, strings in types:
        base, is_list = _base_type(value_type)
        value = props[key]
        if base in _PLAIN:
            plain[key] = value
        elif base in _TEMPORAL:
            typed.append({"k": key, "type": base, "list": is_list, "values": strings})
        elif base == "POINT":
            points = value if is_list else [value]
            typed.append({"k": key, "type": "POINT", "list": is_list, "values": [_point(p) for p in points]})
        elif base.startswith("VECTOR<") and not is_list:
            if isinstance(value, Mapping):  # a {dim, type, values} map
                dim, vtype, values = value["dim"], value["type"], value["values"]
            else:  # the binding's Vector object (coordinate_type, dimension, values)
                dim, vtype, values = value.dimension, value.coordinate_type, value.values
            vecs.append({"k": key, "dim": dim, "type": _vector_type(vtype, where), "values": list(values)})
        else:
            raise ReplayError(f"{where}: property {key!r} has type {value_type}, which replay does not handle")
    return {"props": dict(sorted(plain.items())), "vecs": sorted(vecs, key=_by_key),
            "typed": sorted(typed, key=_by_key)}


def _by_key(side: Mapping) -> str:
    return side["k"]


def _base_type(value_type: str) -> tuple[str, bool]:
    """'LIST<DATE NOT NULL> NOT NULL' -> ('DATE', True); 'POINT NOT NULL' -> ('POINT', False)."""
    t = value_type.removesuffix(" NOT NULL")
    if t.startswith("LIST<") and t.endswith(">"):
        return t[5:-1].removesuffix(" NOT NULL"), True
    return t, False


def _point(p: Any) -> dict:
    coords = [p.x, p.y] + ([p.z] if p.z is not None else [])
    return {"srid": p.srid, "coords": coords}  # no x/y keys: a binding may turn such a dict back into a POINT


def _vector_type(name: str, where: str) -> str:
    name = _VECTOR_ALIAS.get(name, name)
    if name not in _VECTOR:
        raise ReplayError(f"{where}: unknown vector coordinate type {name!r}")
    return name


# --- identity and digest -----------------------------------------------------

def _key_constraints(constraints: list[dict]) -> list[tuple[str, tuple[str, ...]]]:
    """(label, properties) of every node UNIQUE / NODE KEY constraint, in a fixed order."""
    return sorted((c["labelsOrTypes"][0], tuple(c["properties"])) for c in constraints
                  if c["type"] in _KEY_KINDS and c["entityType"] == "NODE")


def _business_key(labels: list[str], values: Mapping[str, Any], keys) -> dict | None:
    for label, props in keys:
        if label in labels and all(p in values for p in props):
            return {"label": label, "props": {p: values[p] for p in props}}
    return None


def _values(entry: Mapping) -> dict[str, Any]:
    """Every property of a dumped node or relationship; typed ones as their sidecar entry."""
    out = dict(entry["props"])
    for side in entry["vecs"] + entry["typed"]:
        out[side["k"]] = {k: v for k, v in side.items() if k != "k"}
    return out


def _identity(node: Mapping) -> Any:
    if node["key"] is not None:
        return node["key"]
    content = _canon([node["labels"], _values(node)])
    return {"content": hashlib.sha256(content.encode()).hexdigest()}


def _canon(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(d: Mapping) -> str:
    """sha256 over the canonical node and relationship lines of a dump (schema excluded)."""
    ident = {n["k"]: _identity(n) for n in d["nodes"]}
    nodes = sorted(_canon([ident[n["k"]], sorted(n["labels"]), _values(n)]) for n in d["nodes"])
    rels = sorted(_canon([r["type"], ident[r["s"]], ident[r["e"]], _values(r)]) for r in d["relationships"])
    h = hashlib.sha256()
    for line in ["nodes", *nodes, "relationships", *rels]:
        h.update(line.encode() + b"\n")
    return h.hexdigest()


def content_digest(conn: Any) -> str:
    """digest(dump(conn)): equal for two databases that hold the same graph."""
    return digest(dump(conn))


# --- schema DDL --------------------------------------------------------------

def _q(name: str) -> str:
    return "`" + name.replace("`", "``") + "`"


def _pattern(entity: str, names: Sequence[str]) -> str:
    alts = "|".join(_q(x) for x in names)
    return f"(n:{alts})" if entity == "NODE" else f"()-[n:{alts}]-()"


def _props(names: Sequence[str]) -> str:
    return ", ".join(f"n.{_q(p)}" for p in names)


def _literal(value: Any) -> str:
    """A Cypher literal for an OPTIONS map (bool before int: True is an int in Python)."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, str):
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"
    if isinstance(value, list):
        return "[" + ", ".join(_literal(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ", ".join(f"{_q(k)}: {_literal(v)}" for k, v in value.items()) + "}"
    raise ReplayError(f"cannot write {value!r} as a Cypher literal")


def constraint_ddl(row: Mapping) -> str:
    """CREATE CONSTRAINT for one dumped SHOW CONSTRAINTS row, built from its columns."""
    kind = row["type"]
    if kind not in _CONSTRAINTS:
        raise ReplayError(f"constraint {row['name']!r} has kind {row['type']!r}, which replay does not handle")
    entity, predicate = _CONSTRAINTS[kind]
    if row.get("entityType", entity) != entity:
        raise ReplayError(f"constraint {row['name']!r}: kind {kind} on a {row['entityType']}")
    predicate = predicate.format(propertyType=row.get("propertyType"))
    target = _pattern(entity, row["labelsOrTypes"])
    return f"CREATE CONSTRAINT {_q(row['name'])} FOR {target} REQUIRE ({_props(row['properties'])}) {predicate}"


def index_ddl(row: Mapping) -> str:
    """CREATE ... INDEX for one dumped SHOW INDEXES row, built from its columns (never createStatement)."""
    kind, name, entity = row["type"], _q(row["name"]), row["entityType"]
    if kind not in _INDEXES:
        raise ReplayError(f"index {row['name']!r} has kind {kind!r}, which replay does not handle")
    if kind == "LOOKUP":
        return (f"CREATE LOOKUP INDEX {name} FOR (n) ON EACH labels(n)" if entity == "NODE"
                else f"CREATE LOOKUP INDEX {name} FOR ()-[n]-() ON EACH type(n)")
    on = f"ON EACH [{_props(row['properties'])}]" if kind == "FULLTEXT" else f"ON ({_props(row['properties'])})"
    options = _ddl_options(row.get("options") or {})
    tail = f" OPTIONS {_literal(options)}" if options else ""
    keyword = "" if kind == "RANGE" else f"{kind} "
    return f"CREATE {keyword}INDEX {name} FOR {_pattern(entity, row['labelsOrTypes'])} {on}{tail}"


def _ddl_options(options: Mapping) -> dict:
    """The OPTIONS map to write: without indexProvider (the engine reports it in its own column and
    refuses it in OPTIONS: only indexConfig is accepted there), and none at all for an empty
    indexConfig. A dump made by an older engine can carry {indexProvider: 'range-1.0'}."""
    out = {k: v for k, v in options.items() if k != "indexProvider"}
    return {} if out in ({}, {"indexConfig": {}}) else out


def ddl(d: Mapping) -> list[str]:
    """The schema statements load() runs after the data and the graph type: indexes, then constraints.

    An index and a UNIQUE or KEY constraint on the same key refuse each other in either
    order (NOTES.md R9), so _load has already dropped a dumped index that shadows a
    constraint (_shadowed_indexes) and skips the indexes the target already holds by name.
    """
    return [index_ddl(i) for i in d["indexes"]] + [constraint_ddl(c) for c in d["constraints"]]


# --- graph types (D18) ---------------------------------------------------------

_CONSTRAINT_ITEM = re.compile(r"CONSTRAINT\s", re.IGNORECASE)


def split_graph_type(spec: str) -> tuple[list[str], list[str]]:
    """(elements, constraint entries) of a graph-type specification as SHOW CURRENT GRAPH TYPE prints it.

    '{}' -> ([], []). Items are split at top-level commas, so a backticked name
    holding a comma or a brace stays whole. Elements are the node and edge
    types; the other items start with CONSTRAINT and mirror SHOW CONSTRAINTS.
    """
    if not isinstance(spec, str) or not spec.strip().startswith("{") or not spec.strip().endswith("}"):
        raise ReplayError(f"graph type {spec!r} is not a {{...}} specification")
    body = spec.strip()[1:-1]
    items, depth, quote, start, i = [], 0, None, 0, 0
    while i < len(body):
        ch = body[i]
        if quote:
            if ch == "\\" and quote != "`":
                i += 1  # an escaped character inside a string literal
            elif ch == quote:
                quote = None  # a doubled backtick closes and reopens at once
        elif ch in "`'\"":
            quote = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if depth < 0:
                break
        elif ch == "," and depth == 0:
            items.append(body[start:i].strip())
            start = i + 1
        i += 1
    tail = body[start:].strip()
    if quote or depth or (items and not tail) or any(not item for item in items):
        raise ReplayError(f"graph type {spec!r}: unbalanced quotes or brackets, or an empty item")
    items += [tail] if tail else []
    constraints = [item for item in items if _CONSTRAINT_ITEM.match(item)]
    return [item for item in items if not _CONSTRAINT_ITEM.match(item)], constraints


def render_graph_type(elements: Sequence[str]) -> str:
    """A specification in the engine's own layout: '{}', or one element per line."""
    return "{\n  " + ",\n  ".join(elements) + "\n}" if elements else "{}"


def graph_type_ddl(d: Mapping) -> str | None:
    """ALTER CURRENT GRAPH TYPE SET for a dump's graph type, or None when it has none."""
    elements = _dumped_elements(d)
    return f"ALTER CURRENT GRAPH TYPE SET {render_graph_type(elements)}" if elements else None


def _dumped_elements(d: Mapping) -> list[str]:
    """The elements of d['graph_type']; [] when the key is absent (a dump made before graph types were kept)."""
    if d.get("graph_type") is None:
        return []
    elements, constraints = split_graph_type(d["graph_type"])
    if constraints:
        raise ReplayError(f"graph_type holds CONSTRAINT entries ({constraints[0]!r}, ...); "
                          "constraints belong in dump['constraints']")
    return elements


def _current_graph_type(conn: relate.Connection) -> str:
    return _rows(conn, "SHOW CURRENT GRAPH TYPE YIELD specification RETURN specification")[0]["specification"]


# --- writing -----------------------------------------------------------------

def _set_props(v: str) -> str:
    """FOREACH clauses that set a row's plain pairs, vectors and typed values on `v`."""
    vector = "CASE vec.type " + " ".join(
        f"WHEN '{t}' THEN vector(vec.values, vec.dim, {kw})" for t, kw in _VECTOR.items()) + " END"
    one = ("CASE t.type " + " ".join(f"WHEN '{t}' THEN {fn}(x)" for t, fn in _TEMPORAL.items())
           + " WHEN 'POINT' THEN point(CASE size(x.coords)"
           " WHEN 2 THEN {srid: x.srid, x: x.coords[0], y: x.coords[1]}"
           " ELSE {srid: x.srid, x: x.coords[0], y: x.coords[1], z: x.coords[2]} END) END")
    return (f"FOREACH (p IN row.props | SET {v}[p[0]] = p[1])\n"
            f"FOREACH (vec IN row.vecs | SET {v}[vec.k] = {vector})\n"
            f"FOREACH (t IN row.typed | SET {v}[t.k] = CASE WHEN t.list THEN [x IN t.values | {one}]"
            f" ELSE head([x IN t.values | {one}]) END)")


_LOAD_NODES = (f"UNWIND $rows AS row\nCREATE (m:{MIG_LABEL} {{{MIG_KEY}: row.k}})\nSET m:$(row.labels)\n"
               + _set_props("m"))
_LOAD_RELS = ("UNWIND $rows AS row\nWITH row WHERE row.s IS NOT NULL AND row.e IS NOT NULL\n"
              f"MATCH (a:{MIG_LABEL} {{{MIG_KEY}: row.s}}), (b:{MIG_LABEL} {{{MIG_KEY}: row.e}})\n"
              "CREATE (a)-[rel:$(row.type)]->(b)\n" + _set_props("rel"))


def load(conn: Any, d: Mapping, *, batch: int = 500) -> dict[str, int]:
    """Replay a dump into `conn` (normally a fresh file) and return what was created.

    Everything is validated before the first write: the format, the schema kinds,
    the graph type's shape, the vector types and the relationship endpoints. The
    data goes first, then the graph type (SET drops existing constraints: NOTES.md
    R16), then the indexes and constraints (UNIQUE after the bulk load, which is
    cheaper than checking it per row). The schema is then checked against the dump.
    On a ReplayError after the first write, throw the target away.
    """
    return _on(conn, lambda c: _load(c, d, batch))


replay = load  # an alias


def _shadowed_indexes(d: Mapping) -> set[str]:
    """Names of dumped RANGE indexes that duplicate a dumped UNIQUE constraint's
    key. The constraint's own backing index serves lookups, and a second index on
    its key is refused (NOTES.md R9): a dump an older engine made can carry such
    an index beside its UNIQUE (older engines needed one), and both must not be
    replayed (the constraint alone is)."""
    backed = {"NODE_PROPERTY_UNIQUENESS", "RELATIONSHIP_PROPERTY_UNIQUENESS", "NODE_KEY", "RELATIONSHIP_KEY"}
    unique_keys = {(c.get("entityType", "NODE"), tuple(c["labelsOrTypes"]), tuple(c["properties"]))
                   for c in d["constraints"] if c["type"] in backed}
    return {i["name"] for i in d["indexes"]
            if i["type"] == "RANGE" and not i.get("owningConstraint")
            and (i["entityType"], tuple(i["labelsOrTypes"]), tuple(i["properties"])) in unique_keys}


def _load(conn: relate.Connection, d: Mapping, batch: int) -> dict[str, int]:
    if d.get("format") != FORMAT:
        raise ReplayError(f"dump format {d.get('format')!r}, expected {FORMAT}")
    shadowed = _shadowed_indexes(d)
    if shadowed:
        d = {**d, "indexes": [i for i in d["indexes"] if i["name"] not in shadowed]}
    statements, alter = ddl(d), graph_type_ddl(d)
    nodes = [_row(n, f"node {n['k']}") | {"k": n["k"], "labels": list(n["labels"])} for n in d["nodes"]]
    rels = _rel_rows(d["relationships"], {n["k"] for n in d["nodes"]})
    if alter and (held := [r["name"] for r in _rows(conn, "SHOW CONSTRAINTS YIELD name RETURN name")]):
        raise ReplayError(f"the target already has constraints ({', '.join(sorted(held))}), which "
                          "ALTER CURRENT GRAPH TYPE SET would drop; load into a fresh database")
    # The UNIQUE's own backing index serves the __Mig key lookups (NOTES.md R9).
    _execute(conn, f"CREATE CONSTRAINT {MIG_CONSTRAINT} FOR (m:{MIG_LABEL}) REQUIRE m.{MIG_KEY} IS UNIQUE")
    made_nodes = _batched(conn, _LOAD_NODES, nodes, batch, "nodes_created")
    made_rels = _batched(conn, _LOAD_RELS, rels, batch, "relationships_created")
    if (made_nodes, made_rels) != (len(nodes), len(rels)):
        raise ReplayError(f"created {made_nodes}/{len(nodes)} nodes and {made_rels}/{len(rels)} relationships")
    _execute(conn, f"MATCH (m:{MIG_LABEL}) REMOVE m:{MIG_LABEL}, m.{MIG_KEY}")
    _execute(conn, f"DROP CONSTRAINT {MIG_CONSTRAINT}")
    if alter:
        _execute(conn, alter)  # validates the data just written; a violation raises here
        _check_graph_type(conn, d)
    # Every store starts with two LOOKUP indexes (one on labels, one on types) under fixed names, so
    # a dump lists them too: an index the target already holds by name is not created again (an
    # explicit CREATE of the same name would turn the built-in into a named index, and a later
    # equivalent LOOKUP index would then be refused as EquivalentSchemaRuleAlreadyExists).
    present = {r["name"] for r in _rows(conn, "SHOW INDEXES YIELD name RETURN name")}
    for statement in [index_ddl(i) for i in d["indexes"] if i["name"] not in present] + statements[len(d["indexes"]):]:
        _execute(conn, statement)
    _check_schema(conn, d)
    return {"nodes": made_nodes, "relationships": made_rels,
            "constraints": len(d["constraints"]), "indexes": len(d["indexes"])}


def _row(entry: Mapping, where: str) -> dict:
    """A node or relationship as load() binds it: props as [key, value] pairs (see Maps above)."""
    vecs = [dict(v, type=_vector_type(v["type"], where)) for v in entry.get("vecs", [])]
    for t in entry.get("typed", []):
        if t["type"] not in _TEMPORAL and t["type"] != "POINT":
            raise ReplayError(f"{where}: typed property {t['k']!r} has type {t['type']!r}")
    return {"props": [[k, v] for k, v in sorted(entry["props"].items())], "vecs": vecs,
            "typed": list(entry.get("typed", []))}


def _rel_rows(rels: Sequence[Mapping], known: set[int]) -> list[dict]:
    out = []
    for i, r in enumerate(rels):
        if r["s"] not in known or r["e"] not in known:
            raise ReplayError(f"relationship {i} :{r['type']} points at node {r['s']!r} -> {r['e']!r}, "
                              "which the dump does not contain")
        out.append(_row(r, f"relationship {i} :{r['type']}") | {"s": r["s"], "e": r["e"], "type": r["type"]})
    return out


def _check_schema(conn: relate.Connection, d: Mapping) -> None:
    """Every dumped constraint and index exists in `conn` with the same shape."""
    have_c = {r["name"]: r for r in _rows(conn, "SHOW CONSTRAINTS YIELD * RETURN *")}
    have_i = {r["name"]: r for r in _rows(conn, "SHOW INDEXES YIELD * RETURN *")
              if r.get("owningConstraint") is None}
    problems = [f"constraint {c['name']}: {_shape_c(have_c.get(c['name']))} != {_shape_c(c)}"
                for c in d["constraints"] if _shape_c(have_c.get(c["name"])) != _shape_c(c)]
    problems += [f"index {i['name']}: {why}" for i in d["indexes"]
                 if (why := _index_mismatch(have_i.get(i["name"]), i))]
    if MIG_CONSTRAINT in have_c:
        problems.append(f"the scratch constraint {MIG_CONSTRAINT} is still there")
    if MIG_INDEX in have_i:
        problems.append(f"the scratch index {MIG_INDEX} is still there")
    if problems:
        raise ReplayError("schema differs after load: " + "; ".join(problems))
    _check_graph_type(conn, d)


def _check_graph_type(conn: relate.Connection, d: Mapping) -> None:
    """The target's graph-type elements equal the dump's, text for text (skipped for a dump without one)."""
    if d.get("graph_type") is None:
        return
    have, want = split_graph_type(_current_graph_type(conn))[0], _dumped_elements(d)
    if have != want:
        raise ReplayError(f"graph type differs after load: {render_graph_type(have)!r} != "
                          f"{render_graph_type(want)!r}")


def _shape_c(r: Mapping | None) -> tuple | None:
    if r is None:
        return None
    return (r["type"], r["entityType"], sorted(r["labelsOrTypes"] or []),
            list(r["properties"] or []), r.get("propertyType"))


def _shape_i(r: Mapping | None) -> tuple | None:
    if r is None:
        return None
    return (r["type"], r["entityType"], sorted(r["labelsOrTypes"] or []), list(r["properties"] or []))


def _same_index(have: Mapping | None, want: Mapping) -> bool:
    return _index_mismatch(have, want) is None


def _index_mismatch(have: Mapping | None, want: Mapping) -> str | None:
    """Why the target's index `have` does not match the dumped row `want`, or None."""
    if have is None:
        return "missing after load"
    if _shape_i(have) != _shape_i(want):
        return f"{_shape_i(have)} != {_shape_i(want)}"
    diffs = _option_diffs(_ddl_options(want.get("options") or {}), have.get("options") or {})
    return "options differ: " + "; ".join(diffs) if diffs else None


def _subset(want: Any, have: Any) -> bool:
    """Every option the dump names has the same value in the target (defaults may add keys)."""
    return not _option_diffs(want, have)


def _option_diffs(want: Any, have: Any, path: str = "", key: str = "") -> list[str]:
    """'<path>: dump <value>, target <value>' for each option the dump names that the
    target lacks or holds with another value. Keys only the target has are engine
    defaults and pass; _CASELESS_OPTIONS compare strings case-insensitively."""
    if isinstance(want, dict):
        if not isinstance(have, dict):
            return [f"{path or 'options'}: dump {want!r}, target {have!r}"]
        out = []
        for k, v in want.items():
            where = f"{path}.{k}" if path else str(k)
            out += (_option_diffs(v, have[k], where, k) if k in have
                    else [f"{where}: dump {v!r}, target has no such option"])
        return out
    if key in _CASELESS_OPTIONS and isinstance(want, str) and isinstance(have, str):
        same = want.casefold() == have.casefold()
    else:
        same = want == have
    return [] if same else [f"{path or 'options'}: dump {want!r}, target {have!r}"]


# --- plumbing ----------------------------------------------------------------

def _on(conn: Any, fn: Callable[[relate.Connection], T]) -> T:
    """fn(conn) for a Connection; one run(fn) job for an Owner or DBThread."""
    if isinstance(conn, relate.Connection):
        return fn(conn)
    if callable(getattr(conn, "run", None)):
        return conn.run(fn)
    raise TypeError(f"expected a relate Connection or an owner with run(fn), got {type(conn).__name__}")


def _rows(conn: relate.Connection, cypher: str, params: dict | None = None) -> list[dict]:
    return conn.execute(cypher, params).fetchall()


def _execute(conn: relate.Connection, cypher: str, params: dict | None = None) -> dict[str, int]:
    return conn.execute(cypher, params).stats


def _chunks(rows: list, size: int) -> Iterator[list]:
    for i in range(0, len(rows), size):
        yield rows[i:i + size]


def _batched(conn: relate.Connection, cypher: str, rows: list, size: int, stat: str) -> int:
    return sum(_execute(conn, cypher, {"rows": chunk})[stat] for chunk in _chunks(rows, size))


def _project(row: Mapping, cols: Sequence[str]) -> dict:
    return {c: row.get(c) for c in cols}


__all__ = ["FORMAT", "ReplayError", "constraint_ddl", "content_digest", "ddl", "digest", "dump",
           "graph_type_ddl", "index_ddl", "load", "render_graph_type", "replay", "split_graph_type"]
