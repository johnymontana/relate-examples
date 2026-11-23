"""Check a Relate WASM store exported from OPFS, and turn it into a native directory database.

Relate's WASM build keeps a database in the browser's OPFS and has no export or import API
and no .rl writer (examples/33-wasm-extract/NOTES.md R12). So the page reads the store's
files itself, and native Relate opens the snapshot they hold as a directory database. Both
ends depend on internal formats with no stability promise, so this guard is strict and pinned
to the release every rule below was verified on (VERIFIED): the two exports
lib/tests/fixtures/opfs/make.mjs makes with that release's bundle in Chromium pass `check`,
and the snapshot `to-dir` writes opens natively. Anything else raises UnsupportedFormat (exit
code 3), naming what was found and what was expected. A new release that changes any marker
fails here first; re-verify and bump VERIFIED.

Two inputs are accepted:

raw       A tar of relate/<name>/ as OPFS holds it: `catalog` plus slot-00 .. slot-63
          (NOTES.md R10). The catalog maps virtual paths to slots:
              "MDBOPF01" | version u32 LE = 1 | count u32 LE |
              count x (slot u32 LE | path length u32 LE | UTF-8 path) |
              crc32 u32 LE of every byte before it
          (at most 1 MiB, no trailing bytes; no empty, "." or ".." path part, no leading or
          trailing "/", no NUL). Each path names one slot below 64, and no slot or path
          appears twice. Slots the catalog does not list are ignored: freed slots keep stale
          bytes, so only listed slots are read.
snapshot  The page's download (<store>.relate.tar), or any tar or extracted directory of a
          JSON-codec directory database: the virtual tree below, with or without WAL
          segments.

The virtual tree, in every input: graph.json, manifest.json and any number of
wal/NNNNNNNN.log segments, and nothing else, except dot entries (below). manifest.json
is a JSON object with "codec": "json" (Parquet is compiled out of WASM), an integer
"checkpoint_lsn" and, if present, an integer "commit_ts". graph.json starts with
{"value_encoding":2,. Each WAL segment starts with "MDBWAL01", followed by frames of
crc32 | length | JSON {lsn, commit_ts, ops}. A final frame that is cut short or fails its
crc32 is a torn append, which the engine trims, so reading stops there; a bad frame before
it is refused. A frame whose crc32 matches is never torn: the engine refuses it unless it
decodes, wherever it is, so it must be a JSON object with integer "lsn" and "commit_ts" and
a list "ops". Integer means a JSON number written without a fraction or an exponent (1.0
and 1e0 are refused, as the engine's u64 refuses them), from 0 to 2^53 - 1, the largest the
browser's guard can check exactly. The same holds for the manifest's numbers. JSON is
strict UTF-8 with no BOM, NaN or Infinity, as the engine reads it.

No JSON object may name a key twice: Python's json, like JavaScript's JSON.parse, keeps
the last value, so {"lsn":7.0,"lsn":7} would read as the integer 7 while the engine refuses
it (`duplicate field`). Checked in manifest.json and in every WAL record at any depth (both
small), so the guard is stricter than the engine inside ops. graph.json, which can be large,
is checked at its top level only; its values are parsed for strict JSON but not searched
for repeated keys.

Dot entries. A path with any part that starts with "." is the engine's own side file: the
role markers and writer leases a native directory database carries, and the
.relate/schema/ mirror both builds write beside the snapshot and regenerate from it at the
next checkpoint (an edited or foreign mirror refuses the open, so a copy must never carry
one: NOTES.md R10, R22). They are skipped by that one rule, never by name, and reported as
ignored; nothing here writes one. In an extracted directory, a skipped file that a running
process holds locked (a writer lease) refuses the input with exit 1: close that process
first. (The rule cannot tell a lease from a marker or the mirror, so the old check that a
lease file is empty is gone; the lock check is what kept a live database from being copied.)

Snapshot only. The download, `to-dir` and `to-tar` carry graph.json and manifest.json and
nothing else, so they must not leave a committed WAL record behind: a tree whose WAL holds a
frame with an lsn past checkpoint_lsn is refused there (exit 3; `check --snapshot` says the
same). The page frees the store first (free() is the checkpoint, after which the WAL holds
no record), and a native `relate clone --to-snapshot-format json` writes a checkpointed
tree. A snapshot directory with no wal/ and no markers opens with a plain writable open,
which adopts it (writes its markers and WAL); a read-only open or `relate clone` refuses it
until then (NOTES.md R22):
    mkdir db && tar -xf <store>.relate.tar -C db && relate -d db 'MATCH (n) RETURN count(n)'
    relate clone db kg.rl
The other way, a native store as a restore input for the page:
    relate clone --to-snapshot-format json kg.rl dir && python3 -I lib/opfsfmt.py to-tar dir kg.tar

A tar may hold only regular files and directories: no links, devices, absolute paths or
"..". It must end with the two zero blocks of an end-of-archive marker, followed by nothing
but zero padding: Python's tarfile alone accepts a tar cut at a member boundary or one with
junk after its last member, so the guard checks the end itself.

CLI (stdlib only):
    python lib/opfsfmt.py check [--json] [--snapshot] PATH
        PATH: a raw OPFS tar, a snapshot tar or an extracted directory database.
        --snapshot: also refuse a WAL record past the checkpoint.
    python lib/opfsfmt.py to-dir [--json] TAR DIR
        TAR: a raw OPFS tar or a snapshot tar. Writes DIR (which must not exist) with
        graph.json and manifest.json only, then checks it.
    python lib/opfsfmt.py to-tar [--json] DIR TAR
        A snapshot tar of DIR (checked first): graph.json and manifest.json, mode 0644,
        mtime 0, as the page's download.
Exit 0 ok, 1 unreadable (missing path, DIR exists, a file held by a running process),
2 usage, 3 unsupported format.
"""

from __future__ import annotations

import errno
import io
import json
import os
import re
import sys
import tarfile
import zlib
from pathlib import Path

try:
    import fcntl
except ImportError:  # not POSIX: a held lease cannot be detected, only its emptiness
    fcntl = None

VERIFIED = "1.2.0"
CATALOG_MAGIC = b"MDBOPF01"
CATALOG_VERSION = 1
CATALOG_MAX = 1024 * 1024
SLOTS = 64
WAL_MAGIC = b"MDBWAL01"
GRAPH_HEAD = b'{"value_encoding":2,'
CODEC = "json"
SNAPSHOT = ("graph.json", "manifest.json")  # what the download, to-dir and to-tar carry
MAX_INT = 2 ** 53 - 1  # lsn, commit_ts, checkpoint_lsn: the engine reads u64; the browser checks safe integers
END_OF_ARCHIVE = 2 * 512
_SLOT = re.compile(r"^slot-(\d\d)$")
_SEGMENT = re.compile(r"^wal/\d{8}\.log$")
_FRAME_HEAD = 8  # crc32 u32 LE | payload length u32 LE


class FormatError(Exception):
    """A path that cannot be read at all, or a destination that is in the way."""

    exit_code = 1


class UnsupportedFormat(FormatError):
    """Not exactly the OPFS formats of Relate VERIFIED: refused before anything is written."""

    exit_code = 3


def _unsupported(where: object, found: str, expected: str) -> UnsupportedFormat:
    return UnsupportedFormat(f"{where}: {found}, expected {expected} "
                             f"(lib/opfsfmt accepts only the formats of Relate {VERIFIED})")


# ---- the catalog --------------------------------------------------------------------------

def _check_path(where: object, path: str) -> None:
    parts = path.split("/")
    if (not path or "\0" in path or path.startswith("/") or path.endswith("/")
            or any(part in ("", ".", "..") for part in parts)):
        raise _unsupported(where, f"catalog path {path!r}", "a relative path without empty, '.' or '..' parts")


def decode_catalog(buf: bytes, where: object = "catalog") -> dict[str, int]:
    """{virtual path: slot} from MDBOPF01 v1 catalog bytes; strict (see the module docstring)."""
    if len(buf) > CATALOG_MAX:
        raise _unsupported(where, f"a {len(buf)}-byte catalog", f"at most {CATALOG_MAX} bytes")
    if len(buf) < len(CATALOG_MAGIC) + 12 or not buf.startswith(CATALOG_MAGIC):
        raise _unsupported(where, f"magic {buf[:8]!r} ({len(buf)} bytes)", f"an {CATALOG_MAGIC.decode()} catalog")
    body, crc = buf[:-4], int.from_bytes(buf[-4:], "little")
    if zlib.crc32(body) != crc:
        raise _unsupported(where, f"catalog crc32 {crc:08x} over bytes that hash to {zlib.crc32(body):08x}",
                           "a matching crc32 (a torn or edited catalog)")
    version = int.from_bytes(body[8:12], "little")
    if version != CATALOG_VERSION:
        raise _unsupported(where, f"catalog version {version}", f"version {CATALOG_VERSION}")
    count, off, entries = int.from_bytes(body[12:16], "little"), 16, {}
    for _ in range(count):
        if off + 8 > len(body):
            raise _unsupported(where, "a catalog that ends inside an entry", f"{count} whole entries")
        slot = int.from_bytes(body[off:off + 4], "little")
        n = int.from_bytes(body[off + 4:off + 8], "little")
        if off + 8 + n > len(body):
            raise _unsupported(where, "a catalog that ends inside a path", f"{count} whole entries")
        try:
            path = body[off + 8:off + 8 + n].decode("utf-8")
        except UnicodeDecodeError:
            raise _unsupported(where, "a catalog path that is not UTF-8", "UTF-8 paths") from None
        off += 8 + n
        _check_path(where, path)
        if slot >= SLOTS:
            raise _unsupported(where, f"slot {slot} for {path!r}", f"a slot below {SLOTS}")
        if path in entries:
            raise _unsupported(where, f"path {path!r} listed twice", "each path once")
        if slot in entries.values():
            raise _unsupported(where, f"slot {slot} listed for two paths", "each slot once")
        entries[path] = slot
    if off != len(body):
        raise _unsupported(where, f"{len(body) - off} bytes after the last catalog entry", "none")
    return entries


def encode_catalog(entries: dict[str, int]) -> bytes:
    """MDBOPF01 v1 catalog bytes, paths in byte order as the engine's BTreeMap writes them."""
    body = bytearray(CATALOG_MAGIC + CATALOG_VERSION.to_bytes(4, "little") + len(entries).to_bytes(4, "little"))
    for path, slot in sorted(entries.items(), key=lambda kv: kv[0].encode()):
        raw = path.encode()
        body += slot.to_bytes(4, "little") + len(raw).to_bytes(4, "little") + raw
    return bytes(body) + zlib.crc32(body).to_bytes(4, "little")


# ---- the virtual tree ---------------------------------------------------------------------

def _no_constant(name: str):
    raise ValueError(f"{name} is not JSON")


class _NegZero(int):
    """The JSON token `-0`: refused where the format has integers, as web/opfs.js refuses it (digits only)."""


def _parse_int(token: str) -> int:
    return _NegZero(0) if token == "-0" else int(token)


class _DuplicateKey(ValueError):
    """A JSON object that names one key twice (see the module docstring)."""

    def __init__(self, key: str):
        super().__init__(f"the key {key!r} twice")
        self.key = key


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    """object_pairs_hook: a dict, unless a key repeats (json.loads would keep the last value)."""
    obj = dict(pairs)
    if len(obj) != len(pairs):
        seen = set()
        for key, _ in pairs:
            if key in seen:
                raise _DuplicateKey(key)
            seen.add(key)
    return obj


def _json(data: bytes):
    """Strict JSON, as the engine's serde_json reads it: UTF-8 without a BOM, no NaN or Infinity, and no
    object that names a key twice, at any depth."""
    return json.loads(data.decode("utf-8"), parse_constant=_no_constant, parse_int=_parse_int,  # a BOM raises
                      object_pairs_hook=_unique_object)


_GRAPH_VALUE = json.JSONDecoder(parse_constant=_no_constant)  # no hooks: the C scanner at full speed
_WS = re.compile(r"[ \t\n\r]*")


def _graph_top_level(where: str, data: bytes) -> None:
    """graph.json is one strict JSON object whose top-level keys are all different (module docstring).

    Walks the top level with json's own C scanner, one member at a time, and drops each value once
    parsed, so a large snapshot costs one json.loads and no Python call per nested object.
    """
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise _unsupported(where, "a snapshot that is not UTF-8", "strict JSON") from None
    seen, i = set(), 1  # the GRAPH_HEAD check put "{" at byte 0
    try:
        while True:
            i = _WS.match(text, i).end()
            if text[i:i + 1] != '"':
                raise ValueError(f"no key at character {i}")
            key, i = json.decoder.scanstring(text, i + 1, True)
            if key in seen:
                raise _unsupported(where, f"the top-level key {key!r} twice",
                                   "each key once (the engine: `duplicate field`)")
            seen.add(key)
            i = _WS.match(text, i).end()
            if text[i:i + 1] != ":":
                raise ValueError(f"no ':' at character {i}")
            _, i = _GRAPH_VALUE.raw_decode(text, _WS.match(text, i + 1).end())
            i = _WS.match(text, i).end()
            if text[i:i + 1] == "}":
                break
            if text[i:i + 1] != ",":
                raise ValueError(f"no ',' or '}}' at character {i}")
            i += 1
        if _WS.match(text, i + 1).end() != len(text):
            raise ValueError("text after the object")
    except ValueError as e:  # JSONDecodeError included
        raise _unsupported(where, f"a snapshot that is not strict JSON ({e})", "one JSON object") from None


def _is_int(v: object) -> bool:
    """A JSON integer the engine's u64 takes and the browser can check: 1.0 and 1e0 parse as float here."""
    return type(v) is int and 0 <= v <= MAX_INT  # excludes bool and the `-0` token (_NegZero)


def _wal_frames(where: str, data: bytes) -> list[int]:
    """The lsn of every whole frame of one WAL segment; a torn final frame ends it, other damage is refused."""
    out, pos = [], len(WAL_MAGIC)
    while pos + _FRAME_HEAD <= len(data):
        crc, n = int.from_bytes(data[pos:pos + 4], "little"), int.from_bytes(data[pos + 4:pos + 8], "little")
        end = pos + _FRAME_HEAD + n
        if end > len(data):
            break  # a torn payload
        payload = data[pos + _FRAME_HEAD:end]
        if zlib.crc32(payload) != crc:
            if end == len(data):
                break  # a torn final append: the engine trims it
            raise _unsupported(where, f"a WAL frame at byte {pos} that fails its crc32, before the last frame",
                               "whole MDBWAL01 frames")
        try:
            rec = _json(payload)
        except _DuplicateKey as e:  # the engine: `undecodable WAL record ... (duplicate field `lsn` ...)`
            raise _unsupported(where, f"a WAL frame at byte {pos} whose record names {e}",
                               "each key once in every object of a record") from None
        except ValueError:
            rec = None
        if not (isinstance(rec, dict) and _is_int(rec.get("lsn")) and _is_int(rec.get("commit_ts"))
                and isinstance(rec.get("ops"), list)):
            # a matching crc32 is a whole frame, never a torn one: the engine refuses it as undecodable
            raise _unsupported(where, f"a WAL frame at byte {pos} whose crc32 matches but whose record is not "
                               "{lsn, commit_ts, ops} with integer lsn and commit_ts",
                               f"a JSON object with lsn and commit_ts integers from 0 to {MAX_INT} "
                               "(no fraction or exponent) and a list ops")
        out.append(rec["lsn"])
        pos = end
    return out


def is_dot(path: str) -> bool:
    """True for an engine side file: any part of the path starts with "." (module docstring)."""
    return any(part.startswith(".") for part in path.split("/"))


def check_tree(files: dict[str, bytes], where: object = "store") -> dict:
    """Check a virtual tree {path: bytes} (dot entries already split off) and summarise it."""
    extra = sorted(p for p in files if p not in SNAPSHOT and not _SEGMENT.match(p))
    if extra:
        raise _unsupported(where, f"unexpected file {extra[0]!r}",
                           "only graph.json, manifest.json, wal/NNNNNNNN.log and dot entries")
    missing = [p for p in SNAPSHOT if p not in files]
    segments = sorted(p for p in files if _SEGMENT.match(p))
    if missing:
        raise _unsupported(where, f"no {missing[0]}", "graph.json and manifest.json")
    try:
        manifest = _json(files["manifest.json"])
    except _DuplicateKey as e:  # the engine: `duplicate field `checkpoint_lsn``
        raise _unsupported(f"{where}/manifest.json", f"{e}", "each key once") from None
    except ValueError:
        raise _unsupported(where, "a manifest.json that is not strict JSON", "a JSON object") from None
    codec = manifest.get("codec") if isinstance(manifest, dict) else None
    if codec != CODEC:
        raise _unsupported(f"{where}/manifest.json", f"codec {codec!r}", f"{CODEC!r}")
    lsn = manifest.get("checkpoint_lsn")
    if not _is_int(lsn):
        raise _unsupported(f"{where}/manifest.json", f"checkpoint_lsn {lsn!r}",
                           f"an integer from 0 to {MAX_INT} (no fraction or exponent)")
    if "commit_ts" in manifest and not _is_int(manifest["commit_ts"]):  # optional for the engine, a u64 when present
        raise _unsupported(f"{where}/manifest.json", f"commit_ts {manifest['commit_ts']!r}",
                           f"an integer from 0 to {MAX_INT} (no fraction or exponent), or no commit_ts")
    head = files["graph.json"][:len(GRAPH_HEAD)]
    if head != GRAPH_HEAD:
        raise _unsupported(f"{where}/graph.json", f"a snapshot starting {head!r}", f"{GRAPH_HEAD!r} (3 = an ontology store)")
    _graph_top_level(f"{where}/graph.json", files["graph.json"])
    frames = []
    for seg in segments:
        if files[seg][:len(WAL_MAGIC)] != WAL_MAGIC:
            raise _unsupported(f"{where}/{seg}", f"WAL magic {files[seg][:8]!r}", f"{WAL_MAGIC!r}")
        frames += _wal_frames(f"{where}/{seg}", files[seg])
    return {"files": {p: len(files[p]) for p in sorted(files)}, "checkpoint_lsn": lsn,
            "wal_frames": len(frames), "last_lsn": max([lsn, *frames]),
            "past_checkpoint": sum(1 for f in frames if f > lsn)}


def check_snapshot(summary: dict, where: object) -> None:
    """Refuse a tree whose WAL holds a record past the checkpoint: a snapshot-only copy would lose it."""
    if summary["past_checkpoint"]:
        raise UnsupportedFormat(f"{where}: {summary['past_checkpoint']} WAL record(s) past checkpoint_lsn "
                                f"{summary['checkpoint_lsn']} (last lsn {summary['last_lsn']}), which a snapshot "
                                "(graph.json and manifest.json alone) would lose: free() the store first (the "
                                "checkpoint), or restore this tar in the page (a restore keeps the WAL) and "
                                "download the store from there")


# ---- reading inputs -----------------------------------------------------------------------

def _tar_members(path: Path) -> tuple[dict[str, bytes], set[str]]:
    """({name: bytes} for regular files, {directory names}) of an uncompressed tar, strictly."""
    data = path.read_bytes()
    try:
        tar = tarfile.open(fileobj=io.BytesIO(data), mode="r:")
    except tarfile.TarError as e:
        raise _unsupported(path, f"not an uncompressed tar ({e})", "a tar") from None
    files, dirs = {}, set()
    with tar:
        try:
            members = tar.getmembers()
        except tarfile.TarError as e:
            raise _unsupported(path, f"a damaged tar ({e})", "a whole tar") from None
        # tarfile stops quietly at a zero block, a cut header or a bad one: what follows its last
        # member must be the end-of-archive marker (two zero blocks) and only zero padding.
        tail = data[tar.offset:]
        if len(tail) < END_OF_ARCHIVE or tail.count(0) != len(tail):
            junk = len(tail) - tail.count(0)
            found = ("no end-of-archive marker (the archive is truncated)" if not junk
                     else f"{junk} non-zero byte(s) after the last whole member (a truncated or damaged tar)")
            raise _unsupported(path, found, "two zero blocks at the end, then only zero padding")
        for m in members:
            name = m.name[2:] if m.name.startswith("./") else m.name
            name = name.rstrip("/") if m.isdir() else name
            if m.isdir() and name in ("", "."):
                continue
            if not (m.isreg() or m.isdir()):
                raise _unsupported(path, f"member {m.name!r} of tar type {m.type!r}", "regular files only")
            parts = name.split("/")
            if not name or name.startswith("/") or "\\" in name or any(p in ("", ".", "..") for p in parts):
                raise _unsupported(path, f"member name {m.name!r}", "a plain relative path")
            if name in files or name in dirs:
                raise _unsupported(path, f"member {name!r} twice", "each path once")
            if m.isdir():
                dirs.add(name)
            else:
                try:
                    files[name] = tar.extractfile(m).read()
                except tarfile.TarError as e:
                    raise _unsupported(path, f"member {name!r} cut short ({e})", "a whole tar") from None
    return files, dirs


def _held(path: Path) -> bool:
    """True when a running process holds this file locked (flock or POSIX lock), as a writer lease is."""
    if fcntl is None:
        return False
    fd = os.open(path, os.O_RDONLY)
    try:
        for lock in (fcntl.flock, fcntl.lockf):
            try:
                lock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except OSError as e:
                if e.errno in (errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK):
                    return True
                raise
            lock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


def _dir_files(root: Path) -> tuple[dict[str, bytes], list[str]]:
    """({name: bytes} of an extracted directory, [the dot entries skipped])."""
    files, ignored = {}, []
    for dirpath, dirnames, filenames in os.walk(root):
        rel = Path(dirpath).relative_to(root).as_posix()
        for d in dirnames:
            sub = Path(dirpath, d)
            if sub.is_symlink():
                raise _unsupported(root, f"{(Path(rel) / d).as_posix()!r} is a symbolic link", "regular files only")
        for f in filenames:
            full = Path(dirpath, f)
            name = f if rel == "." else f"{rel}/{f}"
            if full.is_symlink() or not full.is_file():
                raise _unsupported(root, f"{name!r} is not a regular file", "regular files only")
            if is_dot(name):
                if _held(full):
                    raise FormatError(f"{root}/{name}: a running process holds this database (the file is "
                                      "locked); close it and try again")
                ignored.append(name)
                continue
            files[name] = full.read_bytes()
    return files, sorted(ignored)


def read(path: str | Path) -> tuple[str, dict[str, bytes], dict]:
    """('raw' | 'snapshot', the virtual tree without dot entries, extra facts) without checking the tree yet."""
    where = Path(path)
    if not where.exists():
        raise FormatError(f"{where}: no such file or directory")
    if where.is_dir():
        files, ignored = _dir_files(where)
        return "snapshot", files, ({"ignored": ignored} if ignored else {})
    files, dirs = _tar_members(where)
    if "catalog" not in files:
        extra = sorted(d for d in dirs - {"wal"} if not is_dot(d))
        if extra:
            raise _unsupported(where, f"directory {extra[0]!r}", "only wal/ and dot entries")
        ignored = sorted(p for p in files if is_dot(p))
        tree = {p: b for p, b in files.items() if not is_dot(p)}
        return "snapshot", tree, ({"ignored": ignored} if ignored else {})
    if dirs:
        raise _unsupported(where, f"directory {sorted(dirs)[0]!r} in a raw OPFS tar", "catalog and slot-NN files only")
    for name in files:
        m = _SLOT.match(name)
        if name != "catalog" and not (m and int(m.group(1)) < SLOTS):
            raise _unsupported(where, f"file {name!r} in a raw OPFS tar", f"catalog and slot-00 .. slot-{SLOTS - 1:02d}")
    catalog = decode_catalog(files["catalog"], f"{where}:catalog")
    tree, ignored = {}, []
    for vpath, slot in catalog.items():
        name = f"slot-{slot:02d}"
        if name not in files:
            raise _unsupported(where, f"no {name} for {vpath!r}", "every slot the catalog lists")
        if is_dot(vpath):
            ignored.append(vpath)
        else:
            tree[vpath] = files[name]
    listed = {f"slot-{s:02d}" for s in catalog.values()}
    stale = sum(1 for name, data in files.items() if name != "catalog" and name not in listed and data)
    return "raw", tree, {"stale_slots": stale, **({"ignored": sorted(ignored)} if ignored else {})}


def check(path: str | Path, *, snapshot: bool = False) -> dict:
    """Check any accepted input (see the module docstring) and return its summary.

    snapshot: also refuse a WAL record past the checkpoint (what a snapshot-only copy needs).
    """
    kind, tree, extra = read(path)
    out = {"path": str(path), "kind": kind, "verified": VERIFIED, **check_tree(tree, path)}
    if snapshot:
        check_snapshot(out, path)
    out.update(extra)
    return out


# ---- writing ------------------------------------------------------------------------------

def to_dir(tar_path: str | Path, dest: str | Path) -> dict:
    """The snapshot of a raw OPFS tar (or a snapshot tar) as a new directory `dest`.

    Everything is checked before `dest` is created; `dest` must not exist. Only graph.json and
    manifest.json are written (no wal/, no markers), so a WAL record past the checkpoint is
    refused; a writable native open adopts the result.
    """
    if Path(tar_path).is_dir():
        raise FormatError(f"{tar_path}: a directory; to-dir takes a tar")
    kind, tree, _ = read(tar_path)
    check_snapshot(check_tree(tree, tar_path), tar_path)
    root = Path(dest)
    if root.exists() or root.is_symlink():
        raise FormatError(f"{root}: already exists; to-dir writes a new directory")
    root.mkdir(parents=True)
    for vpath in SNAPSHOT:
        fd = os.open(root / vpath, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(fd, "wb") as fh:
            fh.write(tree[vpath])
    out = check(root, snapshot=True)
    out["from"] = kind
    return out


def tar_bytes(files: dict[str, bytes]) -> bytes:
    """A deterministic ustar archive: sorted paths (a wal/ directory entry first when any path is
    under wal/), mode 0644, mtime 0, uid/gid 0. web/tar.js writeTar writes the same bytes."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        if any(p.startswith("wal/") for p in files):
            info = tarfile.TarInfo("wal")
            info.type, info.mode = tarfile.DIRTYPE, 0o755
            tar.addfile(info)
        for name in sorted(files):
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(files[name]), 0o644
            tar.addfile(info, io.BytesIO(files[name]))
    return buf.getvalue()


def to_tar(src: str | Path, dest: str | Path) -> dict:
    """Write the snapshot tar of the checked directory `src`: graph.json and manifest.json (see tar_bytes)."""
    if not Path(src).is_dir():
        raise FormatError(f"{src}: not a directory")
    tree, ignored = _dir_files(Path(src))
    out = {"path": str(src), "kind": "snapshot", "verified": VERIFIED, **check_tree(tree, src)}
    check_snapshot(out, src)
    Path(dest).write_bytes(tar_bytes({p: tree[p] for p in SNAPSHOT}))
    out["tar"] = str(dest)
    if ignored:
        out["ignored"] = ignored
    return out


# ---- CLI ----------------------------------------------------------------------------------

def _line(r: dict) -> str:
    wal = any(p.startswith("wal/") for p in r["files"])
    what = "raw OPFS export" if r["kind"] == "raw" else "directory tree with its WAL" if wal else "snapshot"
    files = ", ".join(f"{p} {n} B" for p, n in r["files"].items())
    tail = f", {r['stale_slots']} stale slot(s) ignored" if "stale_slots" in r else ""
    if r.get("ignored"):
        tail += f", {len(r['ignored'])} dot entr{'y' if len(r['ignored']) == 1 else 'ies'} ignored ({', '.join(r['ignored'])})"
    return (f"ok: {what} (Relate {r['verified']} formats), {len(r['files'])} files ({files}), "
            f"checkpoint_lsn {r['checkpoint_lsn']}, {r['wal_frames']} WAL frame(s), last lsn {r['last_lsn']}, "
            f"{r['past_checkpoint']} past the checkpoint{tail}")


USAGE = ("usage: opfsfmt.py check [--json] [--snapshot] PATH\n"
         "       opfsfmt.py to-dir [--json] TAR DIR\n"
         "       opfsfmt.py to-tar [--json] DIR TAR")


def main(argv: list[str] | None = None) -> int:
    """Exit 0 ok, 1 unreadable, 2 usage, 3 unsupported format."""
    args = list(sys.argv[1:] if argv is None else argv)
    as_json, snapshot = "--json" in args, "--snapshot" in args
    rest = [a for a in args if a not in {"--json", "--snapshot"}]
    command, paths = (rest[0], rest[1:]) if rest else (None, [])
    want = {"check": 1, "to-dir": 2, "to-tar": 2}.get(command)
    if (want is None or len(paths) != want or any(a.startswith("--") for a in paths)
            or (command != "check" and snapshot)):
        print(USAGE, file=sys.stderr)
        return 2
    try:
        if command == "check":
            result = check(paths[0], snapshot=snapshot)
        elif command == "to-dir":
            result = to_dir(*paths)
        else:
            result = to_tar(*paths)
    except FormatError as e:
        print(f"opfsfmt: {e}", file=sys.stderr)
        return e.exit_code
    except OSError as e:
        print(f"opfsfmt: {e}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True) if as_json else _line(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
