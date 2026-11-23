"""lib/opfsfmt.py: the strict guard for Relate's OPFS exports, and the native snapshot route.

The fixtures are raw OPFS exports of one small store made by the pinned release's WASM bundle
in headless Chromium (lib/tests/fixtures/opfs/make.mjs regenerates them): clean.tar after
free() (no WAL record past the checkpoint, one stale slot) and dirty.tar after three more nodes
and a terminate() without free() (one committed WAL frame the snapshot lacks). Both carry the
engine's .relate/schema/ mirror, a dot entry the guard skips. Every good form is derived from
them here, and so is every tampered one: each must exit 3 before anything is written.

The native tests run the snapshot route with the project engine's CLI: `relate` on PATH, and
only when its --version is the relate-db version the project env holds (pyproject's pin); they
SKIP, saying which, otherwise. Tests named test_pin_* assert today's engine behaviour
(examples/01-wasm-extract/NOTES.md names the row); when one fails, re-verify it and update
lib/opfsfmt's docstring.
"""

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import zlib
from importlib import metadata
from pathlib import Path

import pytest

import opfsfmt

REPO = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "opfs"
CLEAN, DIRTY = FIXTURES / "clean.tar", FIXTURES / "dirty.tar"
PIN = metadata.version("relate-db")  # the project engine: pyproject's pin, as the project env holds it
MIRROR = [".relate/schema/graph-type.cypher", ".relate/schema/schema.cypher"]  # the engine's dot entries in the fixtures
ENV = {**os.environ, "RELATE_TELEMETRY": "off", "RELATE_AGENT_MODE": "0", "RELATE_MAX_ROWS": "0"}


def _project_cli() -> tuple[Path | None, str]:
    """`relate` on PATH when it is the project engine, else (None, why not)."""
    fix = f"put Relate v{PIN} first on PATH (the repository's setup)"
    found = shutil.which("relate")
    if found is None:
        return None, f"no `relate` on PATH ({fix})"
    try:
        said = subprocess.run([found, "--version"], capture_output=True, text=True, timeout=30,
                              env=ENV).stdout.strip().split("\n", 1)[0]
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, f"`{found} --version` failed ({e}); {fix}"
    if said != f"Relate v{PIN}":
        return None, f"`relate` on PATH ({found}) says {said!r}, not the project engine Relate v{PIN}; {fix}"
    return Path(found), ""


CLI, NO_CLI = _project_cli()


def members(path: Path) -> dict[str, bytes]:
    with tarfile.open(path) as tar:
        return {m.name: tar.extractfile(m).read() for m in tar.getmembers() if m.isreg()}


def catalog_of(raw: dict[str, bytes]) -> dict[str, int]:
    return opfsfmt.decode_catalog(raw["catalog"])


def slot(raw: dict[str, bytes], vpath: str) -> str:
    return f"slot-{catalog_of(raw)[vpath]:02d}"


def write(tmp_path: Path, files: dict[str, bytes], name: str = "x.tar") -> Path:
    out = tmp_path / name
    out.write_bytes(opfsfmt.tar_bytes(files))
    return out


def run(*args: str) -> int:
    return opfsfmt.main([str(a) for a in args])


def raw_catalog(entries: list[tuple[int, str]], version: int = 1, trailing: bytes = b"") -> bytes:
    """Catalog bytes with a valid crc32, in any order and with any duplicates (encode_catalog sorts and dedups)."""
    body = bytearray(b"MDBOPF01" + version.to_bytes(4, "little") + len(entries).to_bytes(4, "little"))
    for s, path in entries:
        body += s.to_bytes(4, "little") + len(path.encode()).to_bytes(4, "little") + path.encode()
    body += trailing
    return bytes(body) + zlib.crc32(body).to_bytes(4, "little")


def _extract(tmp_path, files: dict[str, bytes], name: str = "extracted") -> Path:
    root = tmp_path / name
    for n, data in files.items():
        (root / n).parent.mkdir(parents=True, exist_ok=True)
        (root / n).write_bytes(data)
    return root


# --- the good forms --------------------------------------------------------------------------

def test_raw_exports_check(capsys):
    clean, dirty = opfsfmt.check(CLEAN), opfsfmt.check(DIRTY)
    assert clean["kind"] == dirty["kind"] == "raw"
    assert list(clean["files"]) == ["graph.json", "manifest.json", "wal/00000002.log"]
    assert clean["ignored"] == dirty["ignored"] == MIRROR  # the schema mirror: a dot entry, skipped
    assert (clean["checkpoint_lsn"], clean["wal_frames"], clean["last_lsn"], clean["past_checkpoint"],
            clean["stale_slots"]) == (5, 0, 5, 0, 1)
    assert (dirty["checkpoint_lsn"], dirty["wal_frames"], dirty["last_lsn"], dirty["past_checkpoint"]) == (5, 1, 6, 1)
    assert run("check", "--json", DIRTY) == 0
    assert json.loads(capsys.readouterr().out) == dirty
    assert run("check", "--snapshot", CLEAN) == 0
    assert run("check", "--snapshot", DIRTY) == 3  # its WAL record would be lost without wal/
    assert "past checkpoint_lsn 5" in capsys.readouterr().err


def test_catalog_round_trips_byte_for_byte():
    for path in (CLEAN, DIRTY):
        raw = members(path)["catalog"]
        assert opfsfmt.encode_catalog(opfsfmt.decode_catalog(raw)) == raw


def test_to_dir_then_to_tar(tmp_path, capsys):
    db = tmp_path / "db"
    made = opfsfmt.to_dir(CLEAN, db)
    assert made["from"] == "raw" and made["wal_frames"] == 0 and "ignored" not in made
    assert sorted(p.name for p in db.iterdir()) == ["graph.json", "manifest.json"]  # a snapshot: no wal/, no dot entry
    raw = members(CLEAN)
    for vpath in ("graph.json", "manifest.json"):
        assert (db / vpath).read_bytes() == raw[slot(raw, vpath)]
    assert run("check", "--snapshot", db) == 0
    assert capsys.readouterr().out.startswith("ok: snapshot (Relate 1.2.0 formats), 2 files")
    download = tmp_path / "db.tar"
    assert run("to-tar", db, download) == 0
    assert [m.name for m in tarfile.open(download).getmembers()] == ["graph.json", "manifest.json"]
    assert opfsfmt.check(download, snapshot=True)["files"] == made["files"]
    again = tmp_path / "again"
    assert opfsfmt.to_dir(download, again)["from"] == "snapshot"
    assert run("to-tar", again, tmp_path / "same.tar") == 0
    assert (tmp_path / "same.tar").read_bytes() == download.read_bytes()  # deterministic
    assert run("to-dir", DIRTY, tmp_path / "dirty") == 3  # a WAL record past the checkpoint: refused, nothing written
    assert not (tmp_path / "dirty").exists()


def test_a_tree_with_wal_segments_checks(tmp_path):
    """A snapshot tar may carry WAL segments (a native tree, a raw export's tree): check reads them;
    to-tar and to-dir keep the snapshot alone, so they refuse one whose WAL holds a later record."""
    kind, tree, _ = opfsfmt.read(DIRTY)
    with_wal = write(tmp_path, tree, "wal.tar")
    assert [m.name for m in tarfile.open(with_wal).getmembers()][:1] == ["wal"]
    got = opfsfmt.check(with_wal)
    assert (got["kind"], got["wal_frames"], got["past_checkpoint"]) == ("snapshot", 1, 1)
    assert run("check", "--snapshot", with_wal) == 3
    _, clean_tree, _ = opfsfmt.read(CLEAN)
    assert opfsfmt.to_dir(write(tmp_path, clean_tree, "clean-wal.tar"), tmp_path / "db")["wal_frames"] == 0


def test_dot_entries_are_skipped_by_one_rule(tmp_path, capsys):
    """Any path with a part that starts with "." is an engine side file: skipped in a tar and in a
    directory, and named in the summary; nothing else is let through."""
    _, tree, _ = opfsfmt.read(CLEAN)
    side = {".a": b"x", "wal/.b": b"", ".c/d/e.cypher": b"CREATE", "wal/.f/g": b"1234"}
    for path in (write(tmp_path, {**tree, **side}), _extract(tmp_path, {**tree, **side})):
        got = opfsfmt.check(path, snapshot=True)
        assert got["ignored"] == sorted(side) and list(got["files"]) == list(opfsfmt.check(CLEAN)["files"])
    assert run("check", _extract(tmp_path, {**tree, **side}, "x")) == 0
    assert capsys.readouterr().out.rstrip().endswith(f"4 dot entries ignored ({', '.join(sorted(side))})")
    root = _extract(tmp_path, {**tree, **side}, "y")
    restore = tmp_path / "restore.tar"
    assert opfsfmt.to_tar(root, restore)["ignored"] == sorted(side)
    assert sorted(members(restore)) == ["graph.json", "manifest.json"]  # left out of the tar
    assert run("check", _extract(tmp_path, {**tree, "notes.txt": b"x"}, "z")) == 3
    assert run("check", _extract(tmp_path, {**tree, "a/.b": b"x", "a/c": b"x"}, "w")) == 3


@pytest.mark.skipif(opfsfmt.fcntl is None, reason="no fcntl: a held file cannot be detected")
def test_a_held_dot_file_exits_1(tmp_path):
    """A dot file another open file holds locked (as a running native writer holds its lease) is
    refused before anything is written."""
    _, tree, _ = opfsfmt.read(CLEAN)
    root = _extract(tmp_path, {**tree, ".lease": b""})
    with open(root / ".lease", "rb") as held:
        opfsfmt.fcntl.flock(held, opfsfmt.fcntl.LOCK_EX | opfsfmt.fcntl.LOCK_NB)
        assert run("check", root) == 1
        assert run("to-tar", root, tmp_path / "x.tar") == 1
        assert not (tmp_path / "x.tar").exists()
    assert run("to-tar", root, tmp_path / "x.tar") == 0  # released


def test_torn_final_wal_frame_is_accepted(tmp_path):
    raw = members(DIRTY)
    wal = slot(raw, "wal/00000002.log")
    raw[wal] = raw[wal][:-5]  # a torn append: the engine trims it, so the guard stops there
    assert opfsfmt.check(write(tmp_path, raw))["wal_frames"] == 0


def test_cli_runs_standalone_in_isolated_mode(tmp_path):
    """stdlib only: `python3 -I lib/opfsfmt.py` needs no project env."""
    ok = subprocess.run([sys.executable, "-I", str(REPO / "lib" / "opfsfmt.py"), "check", "--json", str(CLEAN)],
                        capture_output=True, text=True)
    assert ok.returncode == 0 and json.loads(ok.stdout)["kind"] == "raw"
    bad = subprocess.run([sys.executable, "-I", str(REPO / "lib" / "opfsfmt.py"), "check", str(FIXTURES / "make.mjs")],
                         capture_output=True, text=True)
    assert bad.returncode == 3 and "accepts only the formats of Relate 1.2.0" in bad.stderr


# --- tampered raw exports: each exits 3 -----------------------------------------------------

def _graph(raw):
    return slot(raw, "graph.json")


def _manifest(raw):
    return slot(raw, "manifest.json")


def _wal(raw):
    return slot(raw, "wal/00000002.log")


def _entries(raw):
    return sorted((s, p) for p, s in catalog_of(raw).items())


def _dup_frame(raw):
    """A corrupt frame before a good one: corruption, not a torn tail."""
    seg = raw[_wal(raw)]
    frame = seg[8:]
    bad = frame[:20] + bytes([frame[20] ^ 0xFF]) + frame[21:]
    raw[_wal(raw)] = seg[:8] + bad + frame


RAW_DAMAGE = {
    "bad magic": lambda r: r.update(catalog=b"MDBOPF02" + r["catalog"][8:]),
    "bad crc": lambda r: r.update(catalog=r["catalog"][:-1] + bytes([r["catalog"][-1] ^ 1])),
    "catalog version 2": lambda r: r.update(catalog=raw_catalog(_entries(r), version=2)),
    "trailing catalog bytes": lambda r: r.update(catalog=raw_catalog(_entries(r), trailing=b"\0\0\0\0")),
    "duplicate slot": lambda r: r.update(catalog=raw_catalog([(s, p) for s, p in _entries(r)][:2]
                                                             + [(_entries(r)[0][0], "wal/00000002.log")])),
    "duplicate path": lambda r: r.update(catalog=raw_catalog(_entries(r) + [(5, "graph.json")])),
    "slot 64": lambda r: r.update({"catalog": raw_catalog(_entries(r) + [(64, "wal/00000003.log")])}),
    "path with ..": lambda r: r.update(catalog=raw_catalog(_entries(r) + [(5, "wal/../x.log")])),
    "absolute path": lambda r: r.update(catalog=raw_catalog(_entries(r) + [(5, "/graph.json")])),
    "missing listed slot": lambda r: r.pop(_graph(r)),
    "extra file in the tar": lambda r: r.update({"notes.txt": b"hi"}),
    "slot-64 file in the tar": lambda r: r.update({"slot-64": b""}),
    "extra file in the tree": lambda r: r.update(catalog=raw_catalog(_entries(r) + [(5, "extra.json")]),
                                                 **{"slot-05": b"{}"}),
    "no manifest": lambda r: r.update(catalog=raw_catalog([e for e in _entries(r) if e[1] != "manifest.json"])),
    "wrong codec": lambda r: r.update({_manifest(r): r[_manifest(r)].replace(b'"json"', b'"parquet"')}),
    "manifest not JSON": lambda r: r.update({_manifest(r): b"{codec"}),
    "negative checkpoint_lsn": lambda r: r.update({_manifest(r): b'{"codec": "json", "checkpoint_lsn": -1}'}),
    "wrong value_encoding": lambda r: r.update({_graph(r): r[_graph(r)].replace(b'{"value_encoding":2,',
                                                                              b'{"value_encoding":3,', 1)}),
    "wrong WAL magic": lambda r: r.update({_wal(r): b"MDBWAL02" + r[_wal(r)][8:]}),
    "corrupt WAL frame": _dup_frame,
}


@pytest.mark.parametrize("damage", list(RAW_DAMAGE))
def test_tampered_raw_export_exits_3(tmp_path, capsys, damage):
    raw = members(DIRTY)
    RAW_DAMAGE[damage](raw)
    bad = write(tmp_path, raw)
    assert run("check", bad) == 3
    assert "accepts only the formats of Relate 1.2.0" in capsys.readouterr().err
    assert run("to-dir", bad, tmp_path / "db") == 3
    assert not (tmp_path / "db").exists()  # refused before anything is written


# --- tampered snapshot forms: each exits 3 --------------------------------------------------

@pytest.fixture
def tree() -> dict[str, bytes]:
    """The dirty export's virtual tree as a snapshot tar holds it (with its WAL segment)."""
    return opfsfmt.read(DIRTY)[1]


DIR_DAMAGE = {
    "a stray file": lambda t: t.update({"wal/notes.txt": b"x"}),
    "a stray file at the root": lambda t: t.update({"notes.txt": b"x"}),
    "no manifest": lambda t: t.pop("manifest.json"),
    "no graph": lambda t: t.pop("graph.json"),
    "wrong codec": lambda t: t.update({"manifest.json": t["manifest.json"].replace(b'"json"', b'"parquet"')}),
    "wrong value_encoding": lambda t: t.update({"graph.json": t["graph.json"].replace(b'"value_encoding":2',
                                                                                    b'"value_encoding":3', 1)}),
    "wrong WAL magic": lambda t: t.update({"wal/00000002.log": b"MDBWAL02" + t["wal/00000002.log"][8:]}),
}


@pytest.mark.parametrize("damage", list(DIR_DAMAGE))
def test_tampered_snapshot_tar_exits_3(tmp_path, tree, damage):
    DIR_DAMAGE[damage](tree)
    bad = write(tmp_path, tree)
    assert run("check", bad) == 3
    assert run("to-dir", bad, tmp_path / "db") == 3
    assert not (tmp_path / "db").exists()


@pytest.mark.parametrize("damage", ["a stray file", "wrong codec"])
def test_tampered_extracted_directory_exits_3(tmp_path, tree, damage):
    DIR_DAMAGE[damage](tree)
    assert run("check", _extract(tmp_path, tree)) == 3


# --- the end of a tar: two zero blocks, then only zero padding ------------------------------

def _end_offset(data: bytes) -> int:
    """Where the last member ends: the end-of-archive marker starts here."""
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as tar:
        tar.getmembers()
        return tar.offset


TAR_ENDS = {  # name: (how the tail is cut or padded, accepted?)
    "two zero blocks": (lambda d, o: d[:o + 1024], True),
    "record padding": (lambda d, o: d, True),  # tarfile pads to 10240 bytes, as ustar allows
    "more zero padding": (lambda d, o: d + b"\0" * 777, True),
    "cut at a member boundary": (lambda d, o: d[:o], False),
    "one zero block": (lambda d, o: d[:o + 512], False),
    "1023 zero bytes": (lambda d, o: d[:o + 1023], False),
    "junk after the marker": (lambda d, o: d[:o + 1024] + b"junk" + b"\0" * 508, False),
    "junk after the last member": (lambda d, o: d[:o] + b"x" * 512 + d[o:], False),
    "a header cut short": (lambda d, o: d[:o] + d[:300], False),
    "a member cut short": (lambda d, o: d[:o - 100], False),
}


@pytest.mark.parametrize("case", list(TAR_ENDS))
def test_tar_end_of_archive(tmp_path, case):
    """Python's tarfile alone accepts the refused ones: the guard checks the end itself."""
    good = opfsfmt.tar_bytes(opfsfmt.read(CLEAN)[1])
    cut, accepted = TAR_ENDS[case]
    path = tmp_path / "end.tar"
    path.write_bytes(cut(good, _end_offset(good)))
    assert run("check", path) == (0 if accepted else 3)
    assert run("to-dir", path, tmp_path / "db") == (0 if accepted else 3)
    assert (tmp_path / "db").exists() == accepted


def test_raw_export_without_end_of_archive_exits_3(tmp_path):
    data = CLEAN.read_bytes()
    (tmp_path / "raw.tar").write_bytes(data[:_end_offset(data)])
    assert run("check", tmp_path / "raw.tar") == 3


# --- integers: no fraction, no exponent, 0 .. 2^53 - 1; strict JSON --------------------------

def _frame(payload: bytes) -> bytes:
    """One WAL frame whose crc32 matches: a whole frame, never a torn one."""
    return zlib.crc32(payload).to_bytes(4, "little") + len(payload).to_bytes(4, "little") + payload


def _record(edit):
    """Replace the dirty fixture's one (so final) WAL frame by an edited record, re-framed."""
    def damage(t):
        rec = t["wal/00000002.log"][16:]
        assert rec.startswith(b'{"lsn":6,"commit_ts":6,"ops":[')
        t["wal/00000002.log"] = b"MDBWAL01" + _frame(edit(rec))
    return damage


def _manifest_is(text: bytes):
    return lambda t: t.update({"manifest.json": text})


NUMBER_DAMAGE = {
    "lsn 7.0": _record(lambda r: r.replace(b'"lsn":6,', b'"lsn":7.0,', 1)),
    "lsn 7e0": _record(lambda r: r.replace(b'"lsn":6,', b'"lsn":7e0,', 1)),
    "lsn 7E+0": _record(lambda r: r.replace(b'"lsn":6,', b'"lsn":7E+0,', 1)),
    "lsn -7": _record(lambda r: r.replace(b'"lsn":6,', b'"lsn":-7,', 1)),
    "lsn -0": _record(lambda r: r.replace(b'"lsn":6,', b'"lsn":-0,', 1)),
    "lsn 2^53": _record(lambda r: r.replace(b'"lsn":6,', b'"lsn":9007199254740992,', 1)),
    "lsn NaN": _record(lambda r: r.replace(b'"lsn":6,', b'"lsn":NaN,', 1)),
    "lsn as a string": _record(lambda r: r.replace(b'"lsn":6,', b'"lsn":"6",', 1)),
    "commit_ts 6e0": _record(lambda r: r.replace(b'"commit_ts":6,', b'"commit_ts":6e0,', 1)),
    "commit_ts 6.5": _record(lambda r: r.replace(b'"commit_ts":6,', b'"commit_ts":6.5,', 1)),
    "no commit_ts": _record(lambda r: r.replace(b'"commit_ts":6,', b'', 1)),
    "ops not a list": _record(lambda r: json.dumps({**json.loads(r), "ops": {}}, separators=(",", ":")).encode()),
    "a record that is not JSON": _record(lambda r: b"not json"),
    "a record with a BOM": _record(lambda r: b"\xef\xbb\xbf" + r),
    "checkpoint_lsn 6.0": _manifest_is(b'{"codec": "json", "checkpoint_lsn": 6.0, "commit_ts": 6}'),
    "checkpoint_lsn 6e0": _manifest_is(b'{"codec": "json", "checkpoint_lsn": 6e0, "commit_ts": 6}'),
    "checkpoint_lsn -0": _manifest_is(b'{"codec": "json", "checkpoint_lsn": -0, "commit_ts": 6}'),
    "checkpoint_lsn Infinity": _manifest_is(b'{"codec": "json", "checkpoint_lsn": Infinity, "commit_ts": 6}'),
    "manifest commit_ts 6e0": _manifest_is(b'{"codec": "json", "checkpoint_lsn": 6, "commit_ts": 6e0}'),
    "manifest commit_ts as a string": _manifest_is(b'{"codec": "json", "checkpoint_lsn": 6, "commit_ts": "6"}'),
    "a manifest with a BOM": _manifest_is(b'\xef\xbb\xbf{"codec": "json", "checkpoint_lsn": 6, "commit_ts": 6}'),
    "a manifest with NaN": _manifest_is(b'{"codec": "json", "checkpoint_lsn": 6, "commit_ts": 6, "x": NaN}'),
}


@pytest.mark.parametrize("damage", list(NUMBER_DAMAGE))
def test_non_integers_and_lax_json_exit_3(tmp_path, tree, damage):
    """Each would be a whole final frame or a manifest that the engine refuses to decode."""
    NUMBER_DAMAGE[damage](tree)
    bad = write(tmp_path, tree)
    assert run("check", bad) == 3
    assert run("to-dir", bad, tmp_path / "db") == 3
    assert not (tmp_path / "db").exists()


def test_integer_bounds_and_optional_manifest_commit_ts(tmp_path, tree):
    assert opfsfmt._is_int(0) and opfsfmt._is_int(2 ** 53 - 1)
    assert not any(opfsfmt._is_int(v) for v in (-1, 2 ** 53, 1.0, True, "1", None))
    big = dict(tree)
    _record(lambda r: r.replace(b'"lsn":6,', b'"lsn":9007199254740991,', 1))(big)
    assert opfsfmt.check(write(tmp_path, big, "big.tar"))["last_lsn"] == 2 ** 53 - 1
    _manifest_is(b'{"codec": "json", "checkpoint_lsn": 6}')(tree)  # the engine defaults commit_ts
    assert opfsfmt.check(write(tmp_path, tree))["checkpoint_lsn"] == 6


# --- duplicate keys: manifest.json and WAL records at any depth, graph.json at its top level ---

def _graph_is(edit):
    return lambda t: t.update({"graph.json": edit(t["graph.json"])})


def _op_twice(old: bytes, new: bytes):
    return _record(lambda r: r.replace(old, new, 1) if old in r else pytest.fail(f"fixture changed: no {old!r}"))


# name: (damage, what the engine says when it clones the tree; None = it accepts it, the guard is stricter)
DUPLICATE_DAMAGE = {
    'lsn twice {"lsn":7,"lsn":7}': (_record(lambda r: r.replace(b'"lsn":6,', b'"lsn":6,"lsn":7,', 1)),
                                    "duplicate field `lsn`"),
    'a float, then an integer {"lsn":7.0,"lsn":7}': (_record(lambda r: r.replace(b'"lsn":6,', b'"lsn":7.0,"lsn":7,', 1)),
                                                     "invalid type: floating point `7.0`"),
    "ops twice": (_record(lambda r: r.replace(b'"ops":[', b'"ops":[],"ops":[', 1)), "duplicate field `ops`"),
    "an op's id twice, inside ops": (_op_twice(b'"op":"CreateNode","id":4,', b'"op":"CreateNode","id":4,"id":4,'),
                                     "duplicate field `id`"),
    "a property key twice, inside ops": (_op_twice(b'"properties":{"f":{"t":"float","v":0.5},',
                                                   b'"properties":{"f":{"t":"float","v":0.5},"f":{"t":"float","v":0.5},'),
                                         None),
    "checkpoint_lsn -0, then 6": (_manifest_is(b'{"codec": "json", "checkpoint_lsn": -0, "checkpoint_lsn": 6, '
                                               b'"commit_ts": 6}'), "invalid type: floating point `-0.0`"),
    "checkpoint_lsn twice": (_manifest_is(b'{"codec": "json", "checkpoint_lsn": 6, "checkpoint_lsn": 6, "commit_ts": 6}'),
                             "duplicate field `checkpoint_lsn`"),
    "graph.json read_only twice": (_graph_is(lambda g: g.rstrip()[:-1] + b',"read_only":false}'),
                                   "duplicate field `read_only`"),
    "graph.json value_encoding twice": (_graph_is(lambda g: g.replace(b'{"value_encoding":2,',
                                                                      b'{"value_encoding":2,"value_encoding":2,', 1)),
                                        "duplicate field `value_encoding`"),
}


@pytest.mark.parametrize("damage", list(DUPLICATE_DAMAGE))
def test_duplicate_keys_exit_3(tmp_path, tree, capsys, damage):
    """json.loads keeps the last value, so each of these would otherwise pass as the fixture."""
    DUPLICATE_DAMAGE[damage][0](tree)
    bad = write(tmp_path, tree)
    assert run("check", bad) == 3
    assert "twice" in capsys.readouterr().err
    assert run("to-dir", bad, tmp_path / "db") == 3
    assert not (tmp_path / "db").exists()


def test_graph_json_is_checked_at_its_top_level_only(tmp_path, tree):
    """A large snapshot is parsed once, with no per-object hook: a nested repeat is left to the engine."""
    nested = dict(tree)
    _graph_is(lambda g: g.replace(b'"properties":{"n":3,', b'"properties":{"n":3,"n":3,', 1))(nested)
    assert nested["graph.json"] != tree["graph.json"]
    assert opfsfmt.check(write(tmp_path, nested, "nested.tar"))["wal_frames"] == 1
    spaced = dict(tree)
    _graph_is(lambda g: g + b" \n")(spaced)
    assert opfsfmt.check(write(tmp_path, spaced, "spaced.tar"))["wal_frames"] == 1
    for name, edit in {"trailing text": lambda g: g + b"x", "cut short": lambda g: g.rstrip()[:-1],
                       "a NaN value": lambda g: g.replace(b'"p":0.9', b'"p":NaN', 1)}.items():
        bad = dict(tree)
        _graph_is(edit)(bad)
        assert bad["graph.json"] != tree["graph.json"], name
        assert run("check", write(tmp_path, bad, "bad.tar")) == 3, name


def _tar_with(tmp_path, tree, add) -> Path:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name in sorted(tree):
            info = tarfile.TarInfo(name)
            info.size = len(tree[name])
            tar.addfile(info, io.BytesIO(tree[name]))
        add(tar)
    out = tmp_path / "odd.tar"
    out.write_bytes(buf.getvalue())
    return out


def _link(tar):
    info = tarfile.TarInfo("wal/00000003.log")
    info.type, info.linkname = tarfile.SYMTYPE, "/etc/passwd"
    tar.addfile(info)


def _named(name):
    def add(tar):
        info = tarfile.TarInfo(name)
        info.size = 1
        tar.addfile(info, io.BytesIO(b"x"))
    return add


@pytest.mark.parametrize("add", [_link, _named("../escape.log"), _named("/abs.json"), _named("graph.json"),
                                 _named("db/graph.json")], ids=["symlink", "dotdot", "absolute", "twice", "subdir"])
def test_odd_tar_members_exit_3(tmp_path, tree, add):
    assert run("check", _tar_with(tmp_path, tree, add)) == 3


def test_other_exit_codes(tmp_path):
    assert run("check", tmp_path / "missing.tar") == 1
    (tmp_path / "taken").mkdir()
    assert run("to-dir", CLEAN, tmp_path / "taken") == 1
    gz = tmp_path / "x.tar.gz"
    with tarfile.open(gz, "w:gz") as tar:
        tar.add(CLEAN, arcname="catalog")
    assert run("check", gz) == 3  # only an uncompressed tar, as the browser writes it
    assert run("check") == 2
    assert run("to-dir", "--snapshot", CLEAN, tmp_path / "x") == 2
    assert run("frobnicate", DIRTY) == 2


# --- the native snapshot route on the project engine's CLI -----------------------------------

def cli(*args, check=True):
    out = subprocess.run([str(CLI), *map(str, args)], capture_output=True, text=True, env=ENV, timeout=120)
    if check:
        assert out.returncode == 0, out.stderr
    return out


def rows(*args):
    return [json.loads(line) for line in cli("--mode", "jsonl", *args).stdout.split("\n") if line.strip()]


def tree_hash(root: Path) -> dict[str, str]:
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob("*")) if p.is_file()}


def native_tree(tmp_path: Path, files: dict[str, bytes], name: str = "native") -> Path:
    """A directory database the engine created (its own role markers and leases kept), holding
    `files` instead of its own snapshot and WAL: how a test hands the engine a WAL segment without
    spelling its marker files. The engine's schema mirror (a dot directory) goes, since it would not
    match the new snapshot."""
    root = tmp_path / name
    cli("--snapshot-format", "json", "-d", root, "RETURN 1 AS x")
    for p in sorted(root.rglob("*"), reverse=True):
        rel = p.relative_to(root).as_posix()
        if p.is_dir() and p.name.startswith("."):
            shutil.rmtree(p)
        elif p.is_file() and not opfsfmt.is_dot(rel):
            p.unlink()
    for n, data in files.items():
        (root / n).parent.mkdir(parents=True, exist_ok=True)
        (root / n).write_bytes(data)
    return root


needs_cli = pytest.mark.skipif(CLI is None, reason=NO_CLI)


@needs_cli
def test_native_route_of_a_snapshot(tmp_path):
    """The page's route as written: mkdir db && tar -xf <store>.relate.tar -C db && relate -d db '<query>',
    then relate clone db kg.rl."""
    assert cli("--version").stdout.strip().split("\n", 1)[0] == f"Relate v{PIN}"
    download = tmp_path / "kg.relate.tar"
    opfsfmt.to_tar(opfsfmt.to_dir(CLEAN, tmp_path / "snap") and tmp_path / "snap", download)
    db = tmp_path / "db"
    db.mkdir()
    subprocess.run(["tar", "-xf", str(download), "-C", str(db)], check=True)
    labels = rows("-d", db, "MATCH (n) UNWIND labels(n) AS l RETURN l, count(*) AS c ORDER BY l")
    assert labels == [{"c": 1, "l": "COMPANY"}, {"c": 2, "l": "Kind"}, {"c": 1, "l": "PERSON"}]
    spec = rows("-d", db, "SHOW CURRENT GRAPH TYPE YIELD specification RETURN specification")
    assert "(:`PERSON` =>)-[:`FOUNDED` =>]->(:`COMPANY` =>)" in spec[0]["specification"]
    names = rows("-d", db, "SHOW CONSTRAINTS YIELD name WHERE name = 'kind_id' RETURN name")
    assert names == [{"name": "kind_id"}]
    illegal = cli("--mode", "jsonl", "-d", db, "MATCH (c:COMPANY) CREATE (:Kind {id: 'x'})-[:FOUNDED]->(c)", check=False)
    assert illegal.returncode == 1 and "endpoint label presence verification failed" in illegal.stdout + illegal.stderr
    before = tree_hash(db)
    cli("clone", db, tmp_path / "kg.rl")
    assert tree_hash(db) == before  # clone leaves its source untouched
    assert rows("--read-only", "-d", tmp_path / "kg.rl", "MATCH (k:Kind) RETURN count(k) AS c") == [{"c": 2}]


@needs_cli
def test_pin_a_snapshot_is_adopted_by_a_writable_open(tmp_path):
    """NOTES.md R22: a directory with graph.json and manifest.json only is refused by a read-only open
    and by clone, and opened by a writable open, which adopts it (its markers, leases and WAL appear);
    after that, read-only opens and clone work. A tree with wal/ but no markers is refused outright."""
    db = tmp_path / "db"
    opfsfmt.to_dir(CLEAN, db)
    ro = cli("--read-only", "--mode", "jsonl", "-d", db, "RETURN 1 AS x", check=False)
    assert ro.returncode != 0 and "read-only open requires an existing database" in ro.stderr, ro.stderr
    cl = cli("clone", db, tmp_path / "early.rl", check=False)
    assert cl.returncode != 0 and "read-only open requires an existing database" in cl.stderr, cl.stderr
    assert rows("-d", db, "MATCH (n) RETURN count(n) AS c") == [{"c": 4}]
    adopted = sorted(p.relative_to(db).as_posix() for p in db.rglob("*") if p.is_file())
    assert "graph.json" in adopted and any(p.startswith("wal/") and not opfsfmt.is_dot(p) for p in adopted)
    assert any(opfsfmt.is_dot(p) for p in adopted)  # the engine wrote its own side files
    assert rows("--read-only", "-d", db, "MATCH (n) RETURN count(n) AS c") == [{"c": 4}]
    cli("clone", db, tmp_path / "late.rl")
    wal_only = _extract(tmp_path, opfsfmt.read(DIRTY)[1], "walonly")
    out = cli("--mode", "jsonl", "-d", wal_only, "RETURN 1 AS x", check=False)
    assert out.returncode != 0 and "ambiguous legacy storage role" in out.stderr, out.stderr


@needs_cli
def test_pin_schema_mirror_is_derived(tmp_path):
    """NOTES.md R10: the .relate/schema/ mirror is rewritten from the snapshot; one that differs
    refuses the open, which is why no copy here ever carries one."""
    db = tmp_path / "db"
    opfsfmt.to_dir(CLEAN, db)
    rows("-d", db, "RETURN 1 AS x")
    mirrors = [p for p in db.rglob("*.cypher") if opfsfmt.is_dot(p.relative_to(db).as_posix())]
    assert mirrors, "the engine no longer writes a schema mirror"
    target = next(p for p in mirrors if "CONSTRAINT" in p.read_text())
    target.write_text(target.read_text() + "CREATE CONSTRAINT zz FOR (n:Z) REQUIRE n.id IS UNIQUE;\n")
    out = cli("--mode", "jsonl", "-d", db, "RETURN 1 AS x", check=False)
    assert out.returncode != 0 and "schema mirror" in out.stderr, out.stderr


def _native_clone(tmp_path) -> Path:
    """`relate clone --to-snapshot-format json` of a CLI-made .rl: what the documented route starts from."""
    x = tmp_path / "x.rl"
    cli("--mode", "jsonl", "-d", x, "CREATE (:A {id: 1})")
    tree_dir = tmp_path / "dir"
    cli("clone", "--to-snapshot-format", "json", x, tree_dir)
    return tree_dir


@needs_cli
def test_documented_native_to_browser_route(tmp_path):
    """The route as the page writes it:
    relate clone --to-snapshot-format json x.rl dir && python3 -I lib/opfsfmt.py to-tar dir kg.tar"""
    tree_dir = _native_clone(tmp_path)
    side = sorted(p.relative_to(tree_dir).as_posix() for p in tree_dir.rglob("*")
                  if p.is_file() and opfsfmt.is_dot(p.relative_to(tree_dir).as_posix()))
    assert side, "pin: a native clone no longer carries side files"
    out = subprocess.run([sys.executable, "-I", str(REPO / "lib" / "opfsfmt.py"), "to-tar", "dir", "kg.tar"],
                         cwd=tmp_path, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert out.stdout.rstrip().endswith(f"ignored ({', '.join(side)})")
    assert sorted(members(tmp_path / "kg.tar")) == ["graph.json", "manifest.json"]
    opfsfmt.to_dir(tmp_path / "kg.tar", tmp_path / "back")  # and back to native: the node is there
    assert rows("-d", tmp_path / "back", "MATCH (a:A) RETURN a.id AS id") == [{"id": 1}]


@needs_cli
def test_a_file_held_by_a_running_cli_exits_1(tmp_path):
    """A CLI shell on the directory holds its writer lease: check and to-tar refuse until it exits."""
    import time
    tree_dir = _native_clone(tmp_path)
    shell = subprocess.Popen([str(CLI), "query", "--mode", "jsonl", "-d", str(tree_dir)], stdin=subprocess.PIPE,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=ENV)
    try:
        deadline = time.monotonic() + 30
        while not (opfsfmt.fcntl and any(opfsfmt._held(p) for p in tree_dir.rglob(".*") if p.is_file())):
            assert time.monotonic() < deadline, "the CLI shell never took its writer lease"
            time.sleep(0.05)
        assert run("check", tree_dir) == 1
        assert run("to-tar", tree_dir, tmp_path / "kg.tar") == 1
        assert not (tmp_path / "kg.tar").exists()
    finally:
        shell.stdin.close()
        shell.wait(timeout=60)
    assert run("to-tar", tree_dir, tmp_path / "kg.tar") == 0


@needs_cli
def test_pin_a_whole_final_frame_that_does_not_decode_is_refused(tmp_path):
    """Why the guard trims only a torn final frame: the engine trims a cut-short or crc-failing one,
    and refuses one whose crc32 matches but whose record does not decode, wherever it is."""
    _, tree, _ = opfsfmt.read(DIRTY)
    seg = tree["wal/00000002.log"]
    for name, edit in (("short", lambda b: b[:-5]), ("crc", lambda b: b[:-3] + bytes([b[-3] ^ 1]) + b[-2:])):
        db = native_tree(tmp_path, {**tree, "wal/00000002.log": edit(seg)}, name)
        assert run("check", db) == 0
        cli("clone", db, tmp_path / f"{name}.rl")
        assert rows("--read-only", "-d", tmp_path / f"{name}.rl", "MATCH (e:Extra) RETURN count(e) AS c") == [{"c": 0}], \
            f"pin: the engine no longer trims a torn final frame ({name})"
    whole = native_tree(tmp_path, tree, "whole")
    cli("clone", whole, tmp_path / "whole.rl")
    assert rows("--read-only", "-d", tmp_path / "whole.rl", "MATCH (e:Extra) RETURN count(e) AS c") == [{"c": 3}]
    db = native_tree(tmp_path, {**tree, "wal/00000002.log": seg[:8] + _frame(seg[16:].replace(b'"lsn":6,', b'"lsn":"6",', 1))},
                     "string")
    assert run("check", db) == 3
    out = cli("clone", db, tmp_path / "string.rl", check=False)
    assert out.returncode != 0 and "undecodable WAL record" in out.stderr, \
        f"pin: the engine no longer refuses a whole final frame with a string lsn: {out.stderr}"


@needs_cli
@pytest.mark.parametrize("damage", list(DUPLICATE_DAMAGE))
def test_pin_duplicate_keys_natively(tmp_path, tree, damage):
    """Why the guard refuses repeated keys: the engine refuses each (`duplicate field`, or the first
    value's type), except a property map's key inside ops, where the last value wins; the guard
    refuses that too."""
    edit, says = DUPLICATE_DAMAGE[damage]
    edit(tree)
    out = cli("clone", native_tree(tmp_path, tree), tmp_path / "x.rl", check=False)
    if says is None:
        assert out.returncode == 0, f"pin: native {PIN} now refuses {damage}: {out.stderr}"
    else:
        assert out.returncode != 0 and says in out.stderr, f"pin: native {PIN} no longer says {says!r}: {out.stderr}"
