"""harness/native.py: example 01's store on native Relate 1.3.0, the repository's engine (native.txt).

Run it with the project env's interpreter, isolated, from anywhere in the repository (run.sh does):

    uv run --quiet python -I examples/01-wasm-extract/harness/native.py   > native.txt
    uv run --quiet python -I examples/01-wasm-extract/harness/native.py x4 DOWNLOAD.tar OUT.tar

The CLI is `relate` from PATH and the binding is this interpreter's `relate` (relate-db): both must
report 1.3.0 (they share files here), or it exits 2 before doing anything. The CLI is called as
`relate --version`, `relate --mode jsonl -d DB 'Q'` and `relate clone [--to-snapshot-format F] SOURCE
DEST`. Node (for the WASM side) must be on PATH.

Inputs. The browser section (harness/drive.mjs) saves the page's dump.json and its database
download in work/browser/, taken at the same moment (the financial-services sample in
opfs://ex01-kg-financial-services, create-context-graph's format, after a reload). When they are not
there (the browser section was skipped), this script makes equivalents, and says so on stderr: the
dump with `node harness/drive.mjs node-dump` (web/pipeline.js and web/store.js in Node: the same
sample, the same store, so the same content but for the (:_Run) timestamps, which nothing here
prints), and the snapshot tar natively from that dump (lib/replay.py into a .rl, `relate clone
--to-snapshot-format json`, lib/opfsfmt.py to-tar: the download's form, written by native code
instead of OPFS). native.txt is the same either way. A second store, of a generic Ontology Graph
Spec 1.1 document (no createContextGraph extension; a gazetteer, a symmetric link and a two-pair link:
harness/fixtures.mjs GENERIC_YAML on GENERIC_TEXT), comes from Node only (`drive.mjs node-dump <out>
generic`) for one more lib/replay.py round trip.

What it prints (native.txt; no paths, timings, hashes, ids or the engine's side-file names):
  1. lib/replay.py loads the dump into a fresh .rl: content_digest == digest(dump), the graph type
     reads back element for element (its node types are create-context-graph's labels), and Python's
     dump of the result is the JS dump byte for byte. Then the same for the generic document's store.
  2. queries/*.cypher on WASM (Node: the dump loaded with lib/replay.mjs, by `drive.mjs wasm-queries`)
     and natively (the replayed .rl, and the .rl the download route makes, opened read_only=True):
     the same scalar rows (paths carry internal ids, so `path` columns are left out); differences listed.
  3. The download route, as the page writes it: lib/opfsfmt.py check --snapshot, `mkdir db && tar -xf
     <store>.relate.tar -C db`, then `relate --mode jsonl -d db '<the page's query>'` (a writable open,
     which adopts the snapshot: NOTES.md R22); the schema came back with it (SHOW INDEXES: every
     index of the page's store and every UNIQUE constraint's backing index, by name and type, all ONLINE;
     SHOW CONSTRAINTS: the page's, and the graph type's; a duplicate key refused; the full-text index
     answers), then `relate clone db kg.rl`, then read_only=True: the .rl
     stays byte-identical, counts, content digest and graph type equal the dump's, a write refused; on
     a writable copy an illegal typed edge refused by the graph type (O4). The pins of R22: before that
     first open, a read-only open and clone refuse the snapshot; after it, the same tree without the
     engine's dot entries (its role markers) but with its WAL is refused outright.
  4. X4, the other way, by the route the page documents (web/index.html), as written: `relate clone
     --to-snapshot-format json kg.rl dir && python3 -I lib/opfsfmt.py to-tar dir from-native.tar`
     (to-tar skips the clone's dot entries), which `opfsfmt check --snapshot` accepts (drive.mjs
     restores the same kind of tar in the page).
Every subprocess (the CLI, tar, node) has a TIMEOUT-second limit; one that hangs is killed and fails
the run, naming the command. Exit 0 when everything holds, 1 when a check fails or a step errors or
times out (`native.py: FAIL:` lines on stderr), 2 when an input is missing.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
EX = HERE.parent
ROOT = EX.parent.parent
VER = "1.3.0"
STORE = "ex01-kg-financial-services"
sys.path.insert(0, str(ROOT / "lib"))

import relate  # noqa: E402  (the project env's binding, relate-db)
import opfsfmt  # noqa: E402  (lib/opfsfmt.py)
import replay  # noqa: E402  (lib/replay.py)

CLI = shutil.which("relate")  # the project engine, from PATH (engine_problem() checks it is VER)
ENV = {**os.environ, "RELATE_TELEMETRY": "off", "RELATE_MAX_ROWS": "0", "RELATE_AGENT_MODE": "0"}
# The query the page's "Open the download with native Relate" commands run (web/app.js renderStoreFacts).
PAGE_QUERY = "MATCH (e:_Entity) RETURN e.kind AS kind, count(*) AS n"
# OWNS is typed (:Person)-[:OWNS]->(:Account) in financial-services' graph type, so this edge breaks it.
ILLEGAL = "CREATE (:Account {name: 'Probe'})-[:OWNS]->(:Person {name: 'Probe Person'})"
ILLEGAL_SHOWN = "(:Account)-[:OWNS]->(:Person)"
TIMEOUT = 300  # seconds per subprocess: generous (the slowest, `drive.mjs node-dump`, takes a few seconds), but finite

failures: list[str] = []


def note(msg: str) -> None:
    print(f"native.py: {msg}", file=sys.stderr, flush=True)


def yes(cond: bool, what: str) -> str:
    """`yes`/`NO` for a line; a FAIL on stderr when the check does not hold."""
    if not cond:
        failures.append(what)
        note(f"FAIL: {what}")
    return "yes" if cond else "NO"


def first_line(e: object) -> str:
    return str(e).strip().split("\n")[0].strip()


def shown(cmd: list[str]) -> str:
    """A command for a message: paths relative to the repo, at most five words."""
    words = [os.path.relpath(c, ROOT) if os.path.isabs(c) and c.startswith(str(ROOT)) else c for c in map(str, cmd)]
    return " ".join(words[:5]) + (" ..." if len(words) > 5 else "")


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    """subprocess.run, captured, with a finite timeout: a hung step is killed and fails the run, named."""
    try:
        return subprocess.run([str(c) for c in cmd], capture_output=True, text=True, timeout=TIMEOUT, **kw)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{shown(cmd)}: timed out after {TIMEOUT} s (killed)") from None


def cli(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    r = run([CLI, *args], env=ENV)
    if check and r.returncode != 0:
        raise RuntimeError(f"relate {' '.join(args[:2])}: exit {r.returncode}: {first_line(r.stderr or r.stdout)}")
    return r


def sha_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def jsonl(r: subprocess.CompletedProcess) -> list[dict]:
    """The rows a `relate --mode jsonl` run printed (split on newlines only: strings may hold U+2028)."""
    return [json.loads(line) for line in r.stdout.split("\n") if line.strip()]


def dot_files(root: Path) -> list[Path]:
    """The engine's side files in a directory database: every file under a path part that starts with "."."""
    return [p for p in sorted(root.rglob("*")) if p.is_file() and opfsfmt.is_dot(p.relative_to(root).as_posix())]


def sha_tree(root: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if p.is_file():
            h.update(p.relative_to(root).as_posix().encode() + b"\0" + p.read_bytes() + b"\0")
    return h.hexdigest()


def rows(conn, query: str, params: dict | None = None) -> list[dict]:
    return conn.execute(query, params).fetchall()


def counts(conn) -> tuple[str, str]:
    labels = rows(conn, "MATCH (x) UNWIND labels(x) AS l RETURN l AS name, count(*) AS n ORDER BY name")
    types = rows(conn, "MATCH ()-[r]->() RETURN type(r) AS name, count(*) AS n ORDER BY name")
    fmt = lambda rs: ", ".join(f"{r['name']} {r['n']}" for r in rs)  # noqa: E731
    return fmt(labels), fmt(types)


def graph_type_elements(conn) -> list[str]:
    spec = rows(conn, "SHOW CURRENT GRAPH TYPE YIELD specification RETURN specification")[0]["specification"]
    return replay.split_graph_type(spec)[0]


def dumped_elements(d: dict) -> list[str]:
    return replay.split_graph_type(d["graph_type"])[0] if d.get("graph_type") else []


def node_types(elements: list[str]) -> list[str]:
    """The labels of a graph type's node types, `(:`Person` => {...})` -> Person, sorted."""
    return sorted(e[3:e.index("`", 3)] for e in elements if e.startswith("(:`") and "]->" not in e)


def edge_types(elements: list[str]) -> list[str]:
    """`(:`S` =>)-[:`REL` =>]->(:`T` =>)` -> `S-REL->T`, sorted."""
    out = []
    for e in elements:
        if "]->" not in e:
            continue
        parts = [p for i, p in enumerate(e.split("`")) if i % 2]
        out.append(f"{parts[0]}-{parts[1]}->{parts[2]}" if len(parts) >= 3 else e)
    return sorted(out)


def round_trip(say, label: str, text: str, work: Path) -> None:
    """lib/replay.py loads a dump into a fresh .rl: digest, graph type, and Python's dump = the JS dump."""
    d = json.loads(text)
    elements = dumped_elements(d)
    path = work / f"{label}.rl"
    c = relate.connect(str(path))
    made = replay.load(c, d)
    say(f"dump.json: {len(d['nodes'])} nodes, {len(d['relationships'])} relationships, a graph type of {len(elements)} elements; "
        f"loaded: {made['nodes']} nodes, {made['relationships']} relationships, {made['constraints']} constraints, {made['indexes']} indexes")
    say(f"content_digest == digest(dump): {yes(replay.content_digest(c) == replay.digest(d), f'{label}: replay.py content_digest = digest(dump)')}; "
        f"the graph type reads back equal: {yes(graph_type_elements(c) == elements and len(elements) > 0, f'{label}: graph type intact after load')}; "
        f"Python's dump is the JS dump byte for byte: {yes(replay._canon(replay.dump(c)) == text.rstrip(chr(10)), f'{label}: Python dump = JS dump')}")
    say(f"  its node types: {', '.join(node_types(elements))}")
    labels, types = counts(c)
    say(f"  relationships by type: {types}")
    c.close()


# ---- the native steps of the download route ------------------------------------------------------

def extract_tar(tar: Path, dest: Path) -> None:
    """The page's `mkdir db && tar -xf <store>.relate.tar -C db`."""
    dest.mkdir(parents=True)
    r = run(["tar", "-xf", tar, "-C", dest])
    if r.returncode != 0:
        raise RuntimeError(f"tar -xf {tar.name}: exit {r.returncode}: {first_line(r.stderr)}")


def to_restore_tar(rl_file: Path, out_tar: Path, tmp: Path) -> dict:
    """X4: a native .rl as a browser restore input, by the route the page documents, as written:
    `relate clone --to-snapshot-format json kg.rl dir && python3 -I lib/opfsfmt.py to-tar dir out.tar`,
    with nothing removed by hand: to-tar skips the clone's dot entries."""
    jdir = tmp / "x4-json"
    cli("clone", "--to-snapshot-format", "json", str(rl_file), str(jdir))
    side = len(dot_files(jdir))
    r = run([sys.executable, "-I", ROOT / "lib" / "opfsfmt.py", "to-tar", "--json", jdir.name, out_tar], cwd=tmp)
    if r.returncode != 0:
        raise RuntimeError(f"lib/opfsfmt.py to-tar: exit {r.returncode}: {first_line(r.stderr)}")
    return {"side": side, "summary": json.loads(r.stdout)}


def engine_problem() -> str | None:
    """None when this interpreter's binding and `relate` on PATH both report VER, else what is wrong."""
    binding = getattr(relate, "__version__", "unknown")
    if binding != VER:
        return f"this interpreter's relate is {binding}, not {VER}: run it with the project env's python (uv run python -I)"
    if not CLI:
        return "no relate on PATH (the repository's setup installs it)"
    v = cli("--version").stdout.strip().split("\n", 1)[0]
    if v != f"Relate v{VER}":
        return f"relate on PATH ({CLI}) says {v!r}, not Relate v{VER}"
    return None


def x4_main(args: list[str]) -> int:
    """native.py x4 DOWNLOAD.tar OUT.tar: drive.mjs's X4 restore input, made natively from a download."""
    if len(args) != 2:
        print("usage: native.py x4 DOWNLOAD.tar OUT.tar", file=sys.stderr)
        return 2
    problem = engine_problem()
    if problem:
        note(problem)
        return 2
    src, out = Path(args[0]).resolve(), Path(args[1]).resolve()
    opfsfmt.check(src, snapshot=True)
    with tempfile.TemporaryDirectory(prefix="ex01-x4-") as t:
        tmp = Path(t)
        extract_tar(src, tmp / "db")
        cli("--mode", "jsonl", "-d", str(tmp / "db"), PAGE_QUERY)  # the writable open that adopts the snapshot
        cli("clone", str(tmp / "db"), str(tmp / "kg.rl"))
        to_restore_tar(tmp / "kg.rl", out, tmp)
    opfsfmt.check(out, snapshot=True)
    return 0


# ---- inputs ---------------------------------------------------------------------------------------

def inputs(work: Path) -> tuple[str, Path, str]:
    """(dump.json text, the download tar, where they came from)."""
    browser = EX / "work/browser"
    dump_file, tar_file = browser / f"{STORE}.dump.json", browser / f"{STORE}.relate.tar"
    if dump_file.is_file() and tar_file.is_file():
        note(f"inputs: the browser section's {dump_file.name} and {tar_file.name} (work/browser/)")
        return dump_file.read_text(encoding="utf-8"), tar_file, "browser"
    note("inputs: no browser artifacts in work/browser/ (the browser section was skipped): the dump from Node "
         "(drive.mjs node-dump: the same sample), the snapshot tar made natively from it (replay.py -> .rl -> "
         "clone --to-snapshot-format json -> opfsfmt to-tar)")
    node_dump = work / "node.dump.json"
    r = run(["node", HERE / "drive.mjs", "node-dump", node_dump], cwd=EX)
    if r.returncode != 0:
        note(f"drive.mjs node-dump failed (exit {r.returncode}): {r.stderr.strip()[-400:]}")
        sys.exit(2)
    text = node_dump.read_text(encoding="utf-8")
    tmp = work / "fallback"
    tmp.mkdir()
    conn = relate.connect(str(tmp / "from-dump.rl"))
    replay.load(conn, json.loads(text))
    conn.close()
    jdir = tmp / "json"
    cli("clone", "--to-snapshot-format", "json", str(tmp / "from-dump.rl"), str(jdir))
    tar = work / f"{STORE}.relate.tar"
    opfsfmt.to_tar(jdir, tar)  # the snapshot: graph.json and manifest.json (the clone's dot entries skipped)
    return text, tar, "fallback"


# ---- main -----------------------------------------------------------------------------------------

def main() -> int:
    problem = engine_problem()
    if problem:
        note(problem)
        return 2
    work = EX / "work/native"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    out: list[str] = []
    say = out.append

    say(f"# Native Relate {VER} (harness/native.py): the repository's engine, the CLI on PATH and the project env's binding")
    say("# The store is the browser section's opfs://ex01-kg-financial-services (create-context-graph's format) after the")
    say("# financial-services sample: its dump.json and its database download, taken at the same moment (made in Node and")
    say("# natively when the browser section is skipped, with the same content; stderr says which). Then a generic Ontology Graph Spec document's")
    say("# store (harness/fixtures.mjs GENERIC_YAML: a gazetteer, a symmetric link), made in Node. Paths are left out of `path` columns.")

    dump_text, tar_file, _source = inputs(work)
    d = json.loads(dump_text)
    elements = dumped_elements(d)

    # ---- 1. lib/replay.py ------------------------------------------------------------------------
    say("")
    say("## lib/replay.py loads the browser-format dump (D18)")
    say(f"dump.json: format {d['format']}, engine {d['engine']}; {len(d['nodes'])} nodes, {len(d['relationships'])} relationships, "
        f"{len(d['constraints'])} constraints, {len(d['indexes'])} indexes, a graph type of {len(elements)} elements")
    replayed = work / "replayed.rl"
    conn = relate.connect(str(replayed))
    made = replay.load(conn, d)
    say(f"load into a fresh .rl: {made['nodes']} nodes, {made['relationships']} relationships, {made['constraints']} constraints, "
        f"{made['indexes']} indexes")
    say(f"content_digest == digest(dump): {yes(replay.content_digest(conn) == replay.digest(d), 'replay.py content_digest = digest(dump)')}")
    got = graph_type_elements(conn)
    say(f"the graph type reads back: {len(got)} elements, equal to the dump's: {yes(got == elements and len(got) > 0, 'graph type intact after load')}")
    say(f"  its node types: {', '.join(node_types(got))}; edge types: {', '.join(edge_types(got))}")
    py_dump = replay._canon(replay.dump(conn))
    same_dump = py_dump == dump_text.rstrip("\n")
    say(f"Python's dump of the loaded store is the JS dump, byte for byte (canon): {yes(same_dump, 'Python dump = JS dump')}")
    if not same_dump:
        a, b = py_dump, dump_text.rstrip("\n")
        i = next((k for k in range(min(len(a), len(b))) if a[k] != b[k]), min(len(a), len(b)))
        say(f"  first difference at character {i}: python {a[max(0, i - 40):i + 40]!r} / js {b[max(0, i - 40):i + 40]!r}")
    labels, types = counts(conn)
    say(f"nodes by label: {labels}")
    say(f"relationships by type: {types}")

    # ---- 3 (first: section 2 compares against its .rl). The download route ------------------------
    tmp = work / "route"
    tmp.mkdir()
    route_lines: list[str] = []
    rsay = route_lines.append
    chk = opfsfmt.check(tar_file, snapshot=True)
    rsay(f"lib/opfsfmt.py check --snapshot: ok, a snapshot ({', '.join(chk['files'])}; codec json), "
         f"{chk['wal_frames']} WAL records, {len(chk.get('ignored', []))} dot entries")
    db_dir = tmp / "db"
    extract_tar(tar_file, db_dir)
    early = cli("--read-only", "--mode", "jsonl", "-d", str(db_dir), "RETURN 1 AS x", check=False)
    msg = first_line(early.stderr or early.stdout).replace(str(db_dir), "<db>")
    rsay(f"mkdir db && tar -xf <store>.relate.tar -C db; a read-only open first: exit {early.returncode}: "
         f"{msg[msg.find('read-only open'):] if 'read-only open' in msg else msg}")
    yes(early.returncode != 0 and "read-only open requires an existing database" in msg,
        "R22: a read-only open refuses a snapshot no writable open has adopted")
    early_clone = cli("clone", str(db_dir), str(tmp / "early.rl"), check=False)
    yes(early_clone.returncode != 0 and not (tmp / "early.rl").exists(), "R22: clone refuses a snapshot no writable open has adopted")
    rsay(f"  and clone: exit {early_clone.returncode} (nothing written: {'yes' if not (tmp / 'early.rl').exists() else 'NO'})")
    kinds = jsonl(cli("--mode", "jsonl", "-d", str(db_dir), PAGE_QUERY))
    by_kind: dict[str, int] = {}
    for n in d["nodes"]:
        if "_Entity" in n["labels"]:
            by_kind[n["props"].get("kind")] = by_kind.get(n["props"].get("kind"), 0) + 1
    got_kinds = {r["kind"]: r["n"] for r in kinds}
    rsay(f"relate --mode jsonl -d db '{PAGE_QUERY}' (the page's command, a writable open): "
         f"{', '.join(f'{k} {v}' for k, v in sorted(got_kinds.items()))}; the dump's _Entity kinds: "
         f"{yes(got_kinds == by_kind, 'the page native query answers as the dump')}")
    adopted = dot_files(db_dir)
    wal = sorted(p for p in db_dir.rglob("*.log") if p.is_file())
    rsay(f"  that open adopted the directory: the engine wrote its own side files ({len(adopted)} dot entries) and a WAL "
         f"({len(wal)} segment): {yes(bool(adopted) and bool(wal), 'R22: the writable open adopts the snapshot')}")
    # The schema came back with the snapshot: every index (the constraints' backing indexes among them)
    # and every constraint of the page's store, as its dump lists them, and they work.
    idx = jsonl(cli("--mode", "jsonl", "-d", str(db_dir), "SHOW INDEXES YIELD name, type, state RETURN name, type, state ORDER BY name"))
    uniques = [c for c in d["constraints"] if c["type"] in ("NODE_PROPERTY_UNIQUENESS", "NODE_KEY")]
    want_idx = sorted([(i["name"], i["type"]) for i in d["indexes"]] + [(c["name"], "RANGE") for c in uniques])
    got_idx = sorted((r["name"], r["type"]) for r in idx)
    online = all(r["state"] == "ONLINE" for r in idx)
    by_type: dict[str, int] = {}
    for _, t in got_idx:
        by_type[t] = by_type.get(t, 0) + 1
    rsay(f"  SHOW INDEXES: {len(idx)} ({', '.join(f'{t} {n}' for t, n in sorted(by_type.items()))}), every one ONLINE: "
         f"{yes(online, 'every index of the adopted snapshot is ONLINE')}; the page's indexes and one backing index per UNIQUE "
         f"constraint, by name and type: {yes(got_idx == want_idx, 'the snapshot carries every index of the page store')}")
    cons = jsonl(cli("--mode", "jsonl", "-d", str(db_dir), "SHOW CONSTRAINTS YIELD name, type, classification "
                     "RETURN name, type, classification ORDER BY name"))
    own = sorted((r["name"], r["type"]) for r in cons if r["classification"] != "dependent")
    dependent = sum(1 for r in cons if r["classification"] == "dependent")
    want_dep = sum(1 for r in rows(conn, "SHOW CONSTRAINTS YIELD classification RETURN classification")
                   if r["classification"] == "dependent")
    rsay(f"  SHOW CONSTRAINTS: {len(own)} of the store's own (UNIQUE {len(uniques)}), equal to the page's by name and type: "
         f"{yes(own == sorted((c['name'], c['type']) for c in d['constraints']), 'the snapshot carries every constraint of the page store')}; "
         f"{dependent} the graph type's, as many as the dump's graph type makes: {yes(dependent == want_dep and dependent > 0, 'graph-type constraints intact')}")
    dup = cli("--mode", "jsonl", "-d", str(db_dir), "MATCH (e:_Entity) WITH e ORDER BY e.key LIMIT 1 CREATE (:_Entity {key: e.key})",
              check=False)
    msg = first_line(dup.stdout + dup.stderr)
    rsay(f"  a second _Entity with an existing key: exit {dup.returncode}: "
         f"{msg[msg.find('ConstraintValidationFailed'):].split(':')[0] if 'ConstraintValidationFailed' in msg else msg}")
    yes(dup.returncode != 0 and "ConstraintValidationFailed" in msg, "the UNIQUE constraint refuses a duplicate key natively")
    ft = "CALL db.index.fulltext.queryNodes('sentence_text', 'Whitlock') YIELD node RETURN count(node) AS n"
    hits = jsonl(cli("--mode", "jsonl", "-d", str(db_dir), ft))[0]["n"]
    ref = rows(conn, ft)[0]["n"]
    rsay(f"  the full-text index answers: sentence_text for 'Whitlock': {hits} sentence(s), as on the replayed store: "
         f"{yes(hits == ref and hits > 0, 'the full-text index answers natively')}")
    before = sha_tree(db_dir)
    kg = tmp / "kg.rl"
    cli("clone", str(db_dir), str(kg))
    rsay(f"relate clone db kg.rl: ok; the directory is untouched: {yes(sha_tree(db_dir) == before, 'clone leaves its source untouched')}")
    kg_sha = sha_file(kg)
    ro = relate.connect(str(kg), read_only=True)
    rl, rt = counts(ro)
    rsay(f"read_only=True: nodes by label equal the dump's: {yes(rl == labels, 'download .rl labels = dump')}; "
         f"relationships by type: {yes(rt == types, 'download .rl types = dump')}")
    rsay(f"  content digest equal to the dump's: {yes(replay.content_digest(ro) == replay.digest(d), 'download .rl content = dump')}; "
         f"graph type equal: {yes(graph_type_elements(ro) == elements, 'download .rl graph type = dump')}")
    try:
        ro.execute("CREATE (:Probe {name: 'x'})")
        rsay("  a CREATE on the read-only handle: accepted (NO)")
        yes(False, "read_only=True refuses a CREATE")
    except Exception as e:  # noqa: BLE001  (the binding's error class is not the point)
        rsay(f"  a CREATE on the read-only handle: {type(e).__name__}: {first_line(e)}")
        yes("read-only" in str(e) or "ReadOnly" in str(e), "read_only=True refuses a CREATE")
    # section 2's native rows on the downloaded .rl come from this read-only handle
    route_conn = ro

    # ---- 2. queries/*.cypher ---------------------------------------------------------------------
    say("")
    say("## queries/*.cypher on WASM (Node, lib/replay.mjs) and natively (the replayed .rl; the downloaded .rl, read_only=True)")
    dump_file = work / "dump.json"
    dump_file.write_text(dump_text, encoding="utf-8")
    wasm_file = work / "wasm-queries.json"
    r = run(["node", HERE / "drive.mjs", "wasm-queries", dump_file, wasm_file], cwd=EX)
    if r.returncode != 0:
        note(f"drive.mjs wasm-queries failed (exit {r.returncode}): {r.stderr.strip()[-400:]}")
        return 2
    wasm = json.loads(wasm_file.read_text(encoding="utf-8"))
    differences = 0
    for file in sorted(wasm):
        w = wasm[file]
        src = (EX / "queries" / file).read_text(encoding="utf-8")
        sides = {}
        for name, c in (("native", conn), ("download", route_conn)):
            try:
                res = rows(c, src, w["params"] or None)
                cols = [k for k in (w.get("columns") or (list(res[0].keys()) if res else [])) if k != "path"]
                sides[name] = [replay._canon({k: row.get(k) for k in cols}) for row in res]
            except Exception as e:  # noqa: BLE001
                sides[name] = f"error: {first_line(e)}"
        if "error" in w:
            say(f"{file}: WASM error: {w['error']}; native: {sides['native'] if isinstance(sides['native'], str) else 'rows'}")
            differences += 1
            continue
        verdicts = []
        # Without ORDER BY the row order is the engine's storage order, which differs between a
        # replayed store and the original: such results are compared as multisets.
        ordered = "ORDER BY" in src.upper()
        for name in ("native", "download"):
            got_rows = sides[name]
            if isinstance(got_rows, str):
                verdicts.append(f"{name} {got_rows}")
                differences += 1
            elif (got_rows == w["rows"]) if ordered else (sorted(got_rows) == sorted(w["rows"])):
                verdicts.append("same")
            else:
                verdicts.append("DIFFERENT")
                differences += 1
                only_w = [x for x in w["rows"] if x not in got_rows][:3]
                only_n = [x for x in got_rows if x not in w["rows"]][:3]
                note(f"{file} ({name}): only on WASM {only_w}; only natively {only_n}")
        params = f" with {json.dumps(w['params'], sort_keys=True)}" if w["params"] else ""
        dropped = " (its path column left out)" if w.get("dropped") else ""
        n = len(w["rows"])
        how = "" if ordered else " (no ORDER BY: compared as multisets)"
        say(f"{file}{params}: {n} row{'' if n == 1 else 's'}{dropped}{how}; native (replayed): {verdicts[0]}; downloaded .rl: {verdicts[1]}")
    yes(differences == 0, "queries give the same scalar rows on WASM and natively")
    say(f"differences: {differences or 'none'}")

    # ---- 3 (printed). The download route ---------------------------------------------------------
    say("")
    say("## the download route (D17): the page's snapshot tar, opened natively, then a .rl")
    for line in route_lines:
        say(line)
    route_conn.close()
    say(f"  the .rl is byte-identical after the read-only open: {yes(sha_file(kg) == kg_sha, 'read_only=True leaves the .rl untouched')}")
    copy = tmp / "kg-writable.rl"
    shutil.copyfile(kg, copy)
    wc = relate.connect(str(copy))
    try:
        wc.execute(ILLEGAL)
        say(f"an illegal typed edge on a writable copy, {ILLEGAL_SHOWN}: accepted (NO)")
        yes(False, "the graph type refuses an illegal edge natively")
    except Exception as e:  # noqa: BLE001
        msg = first_line(e)
        say(f"an illegal typed edge on a writable copy, {ILLEGAL_SHOWN}: {msg[msg.find('ConstraintValidationFailed'):] if 'ConstraintValidationFailed' in msg else msg}")
        yes("ConstraintValidationFailed" in msg, "the graph type refuses an illegal edge natively (O4)")
    probes = rows(wc, "MATCH (n) WHERE n.name IN ['Probe', 'Probe Person'] RETURN count(n) AS n")[0]["n"]
    say(f"  nothing was written: {yes(probes == 0, 'the refused edge wrote nothing')}")
    wc.close()
    bare = tmp / "bare"
    shutil.copytree(db_dir, bare)
    for p in dot_files(bare):
        p.unlink()
    r = cli("--mode", "jsonl", "-d", str(bare), "RETURN 1 AS x", check=False)
    msg = first_line(r.stderr or r.stdout).replace(str(bare), "<db>")
    say(f"R22's pin, the adopted tree without the engine's dot entries but with its WAL: exit {r.returncode}: "
        f"{msg[msg.find('ambiguous'):] if 'ambiguous' in msg else msg}")
    yes(r.returncode != 0 and "ambiguous legacy storage role" in msg, "R22: a tree with wal/ and no role markers is refused")

    # ---- 4. X4 -----------------------------------------------------------------------------------
    say("")
    say("## the other way (X4): a native .rl as a browser restore input")
    x4 = work / "from-native.tar"
    res = to_restore_tar(kg, x4, tmp)
    say(f"relate clone --to-snapshot-format json kg.rl dir: ok; the engine's side files in it: {res['side']} dot entries")
    skipped = len(res["summary"].get("ignored", []))
    say(f"python3 -I lib/opfsfmt.py to-tar dir from-native.tar (the page's route, nothing removed by hand): "
        f"ok; it skipped them: {yes(skipped == res['side'] and skipped > 0, 'opfsfmt to-tar skips the dot entries (X4 route)')}")
    back = opfsfmt.check(x4, snapshot=True)
    say(f"lib/opfsfmt.py check --snapshot: ok ({', '.join(back['files'])}); harness/drive.mjs restores this form in the page")
    conn.close()

    # ---- 5. a generic Ontology Graph Spec document's store, made in Node ---------------------------------------------
    say("")
    say("## a generic Ontology Graph Spec 1.1 document too: its store (GENERIC_YAML on GENERIC_TEXT), made in Node, through lib/replay.py")
    gd = work / "generic.dump.json"
    r = run(["node", HERE / "drive.mjs", "node-dump", gd, "generic"], cwd=EX)
    if r.returncode != 0:
        note(f"drive.mjs node-dump generic failed (exit {r.returncode}): {r.stderr.strip()[-400:]}")
        return 2
    round_trip(say, "generic", gd.read_text(encoding="utf-8"), work)
    d2 = json.loads(gd.read_text(encoding="utf-8"))
    aliases = sum(1 for n in d2["nodes"] if "_Alias" in n["labels"])
    untyped = sorted(n["props"].get("id") for n in d2["nodes"] if "_LinkType" in n["labels"] and n["props"].get("typed") is False)
    say(f"  its gazetteer's _Alias nodes: {aliases}; links only the gate checks (untyped): {', '.join(untyped) or 'none'}")

    sys.stdout.write("\n".join(out) + "\n")
    note(f"{'every check holds' if not failures else f'{len(failures)} failure(s)'}")
    return 1 if failures else 0


if __name__ == "__main__":
    if sys.argv[1:] and sys.argv[1:2] != ["x4"]:
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        sys.exit(2)
    try:
        sys.exit(x4_main(sys.argv[2:]) if sys.argv[1:2] == ["x4"] else main())
    except (RuntimeError, opfsfmt.FormatError) as e:  # a step that errors or times out: named, exit 1
        note(f"FAIL: {e}")
        sys.exit(1)
