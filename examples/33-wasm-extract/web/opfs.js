// @ts-check
/**
 * opfs.js: Relate 1.2.0's OPFS store layout, read and written outside the engine, and the strict
 * format guard of lib/opfsfmt.py ported to JavaScript. WASM has no export or import call
 * (NOTES.md R12), so the page handles the files: export.js builds the download and the restore on
 * it; app.js lists the stores with it.
 *
 * The layout (NOTES.md R10): `relate/<name>/` in the origin's OPFS holds `catalog` and `slot-00`
 * .. `slot-63`. The catalog maps the virtual tree's paths to slots:
 *     "MDBOPF01" | version u32 LE = 1 | count u32 LE |
 *     count x (slot u32 LE | path length u32 LE | UTF-8 path) | crc32 u32 LE of every byte before it
 * (at most 1 MiB, no trailing bytes; no empty, "." or ".." part, no leading or trailing "/", no
 * NUL). Freed slots keep stale bytes, so only the catalog-listed slots are read.
 *
 * The virtual tree is a JSON-codec directory database: graph.json (starting
 * {"value_encoding":2,), manifest.json ({"codec": "json", "checkpoint_lsn": n, ...}), any number
 * of wal/NNNNNNNN.log segments (MDBWAL01, then frames crc32 | length | JSON {lsn, commit_ts,
 * ops}), and dot entries: any path with a part that starts with "." is the engine's own side file
 * (the .relate/schema/ mirror the engine rewrites from the snapshot at each checkpoint; in a
 * native tree also its role markers and writer leases). Dot entries are skipped by that one rule,
 * never by name, and never written into a store or a download: a copied mirror that does not match
 * its snapshot refuses the open (NOTES.md R10). A final WAL frame that is cut short or fails its
 * crc32 is a torn append, which the engine trims, so the read ends there; a frame that fails its
 * crc32 before the last is refused, and so is a frame whose crc32 matches but whose record does
 * not decode, wherever it is (the engine refuses it as an undecodable WAL record). The download is
 * a snapshot: graph.json and manifest.json only, taken right after the engine's checkpoint (free()),
 * so it refuses a tree whose WAL holds a record past checkpoint_lsn (checkSnapshot). A restore
 * takes a snapshot tar, a tar of any such tree (WAL segments included), or a raw tar of an OPFS
 * store directory. Anything else is refused with FormatError: these are internal formats, pinned
 * to the release verified on them (VERIFIED), exactly as lib/opfsfmt.py pins them (the same
 * accept/refuse on every input). JSON is strict: UTF-8 with no BOM (decoded with ignoreBOM, so a
 * BOM reaches JSON.parse and fails), no NaN or Infinity, as the engine reads it. The integers of the
 * format (manifest.json's checkpoint_lsn and optional commit_ts, a WAL record's lsn and commit_ts)
 * must be written as integers from 0 to 2^53 - 1: JSON text `1.0` or `1e0` is a float to the
 * engine's u64 and to Python's json, but JSON.parse makes it the integer 1, so this module checks
 * each number's own text (JSON numbers do not survive JavaScript's parse as they were written:
 * NOTES.md R4).
 *
 * No JSON object may name a key twice: JSON.parse, like Python's json, keeps the last value, so
 * {"lsn":7.0,"lsn":7} would read as the integer 7 while the engine refuses it (`duplicate field`).
 * Checked in manifest.json and in every WAL record at any depth (both small), so the guard is
 * stricter than the engine inside ops (a property map with a key twice, which the engine accepts,
 * is refused too). graph.json, which can be large, starts with {"value_encoding":2, and must be one
 * strict JSON object whose top-level keys are all different; scanJson walks it without building
 * it, and nested repeats are left to the engine.
 *
 * Format functions (pure, Node-safe): crc32, decodeCatalog, encodeCatalog, checkTree,
 * checkSnapshot, isDot, splitDots, scanJson (DuplicateKeyError), SNAPSHOT. OPFS functions (async;
 * the page thread or a worker, never while the engine holds the store, for a consistent read):
 * listStores, readStore, writeStore, storeExists, removeStore.
 */

export const VERIFIED = '1.2.0';
export const CATALOG_MAGIC = 'MDBOPF01';
export const CATALOG_VERSION = 1;
export const CATALOG_MAX = 1024 * 1024;
export const SLOTS = 64;
export const OPFS_DIR = 'relate';
const WAL_MAGIC = 'MDBWAL01';
const GRAPH_HEAD = '{"value_encoding":2,';
/** What a snapshot (the download) holds: the files a checkpoint wrote, nothing else. */
export const SNAPSHOT = Object.freeze(['graph.json', 'manifest.json']);
const SEGMENT = /^wal\/\d{8}\.log$/;
const te = new TextEncoder();

/** A tree or catalog that is not exactly Relate 1.2.0's formats; nothing was written. */
export class FormatError extends Error {
  /** @param {string} where @param {string} found @param {string} expected @param {string} [tail] */
  constructor(where, found, expected, tail) {
    super(`${where}: ${found}, expected ${expected}. ${tail ?? `This store was written by a Relate other than ${VERIFIED}, ` +
      `or it is not a Relate store: the page accepts only the formats of Relate ${VERIFIED}`}`);
    this.name = 'FormatError';
    this.where = where;
    this.found = found;
    this.expected = expected;
  }
}

// ---- CRC32 (IEEE, as crc32fast and Python's zlib.crc32) ----------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Uint8Array} buf @returns {number} */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const hex8 = (n) => n.toString(16).padStart(8, '0');
/** @param {Uint8Array} b */
const show = (b) => JSON.stringify(new TextDecoder('latin1').decode(b));

// ---- the catalog --------------------------------------------------------------------------------

/** @param {string} where @param {string} path */
function checkPath(where, path) {
  const parts = path.split('/');
  if (!path || path.includes('\0') || path.startsWith('/') || path.endsWith('/') || parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new FormatError(where, `catalog path ${JSON.stringify(path)}`, "a relative path without empty, '.' or '..' parts");
  }
}

/**
 * {virtual path: slot} from MDBOPF01 v1 catalog bytes, strictly.
 * @param {Uint8Array} buf
 * @param {string} [where]
 * @returns {Map<string, number>}
 */
export function decodeCatalog(buf, where = 'catalog') {
  if (buf.length > CATALOG_MAX) throw new FormatError(where, `a ${buf.length}-byte catalog`, `at most ${CATALOG_MAX} bytes`);
  const magic = new TextDecoder('latin1').decode(buf.subarray(0, 8));
  if (buf.length < 8 + 12 || magic !== CATALOG_MAGIC) {
    throw new FormatError(where, `magic ${show(buf.subarray(0, 8))} (${buf.length} bytes)`, `an ${CATALOG_MAGIC} catalog`);
  }
  const body = buf.subarray(0, buf.length - 4);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const crc = dv.getUint32(buf.length - 4, true);
  const got = crc32(body);
  if (got !== crc) throw new FormatError(where, `catalog crc32 ${hex8(crc)} over bytes that hash to ${hex8(got)}`, 'a matching crc32 (a torn or edited catalog)');
  const version = dv.getUint32(8, true);
  if (version !== CATALOG_VERSION) throw new FormatError(where, `catalog version ${version}`, `version ${CATALOG_VERSION}`);
  const count = dv.getUint32(12, true);
  let off = 16;
  /** @type {Map<string, number>} */
  const entries = new Map();
  const slots = new Set();
  const td = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < count; i++) {
    if (off + 8 > body.length) throw new FormatError(where, 'a catalog that ends inside an entry', `${count} whole entries`);
    const slot = dv.getUint32(off, true);
    const n = dv.getUint32(off + 4, true);
    if (off + 8 + n > body.length) throw new FormatError(where, 'a catalog that ends inside a path', `${count} whole entries`);
    let path;
    try {
      path = td.decode(body.subarray(off + 8, off + 8 + n));
    } catch {
      throw new FormatError(where, 'a catalog path that is not UTF-8', 'UTF-8 paths');
    }
    off += 8 + n;
    checkPath(where, path);
    if (slot >= SLOTS) throw new FormatError(where, `slot ${slot} for ${JSON.stringify(path)}`, `a slot below ${SLOTS}`);
    if (entries.has(path)) throw new FormatError(where, `path ${JSON.stringify(path)} listed twice`, 'each path once');
    if (slots.has(slot)) throw new FormatError(where, `slot ${slot} listed for two paths`, 'each slot once');
    entries.set(path, slot);
    slots.add(slot);
  }
  if (off !== body.length) throw new FormatError(where, `${body.length - off} bytes after the last catalog entry`, 'none');
  return entries;
}

/** Compare by UTF-8 bytes, as the engine's BTreeMap<String, _> orders paths. */
function cmpBytes(a, b) {
  const x = te.encode(a);
  const y = te.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/**
 * MDBOPF01 v1 catalog bytes, paths in byte order as the engine writes them.
 * @param {Map<string, number>} entries  path -> slot
 * @returns {Uint8Array}
 */
export function encodeCatalog(entries) {
  const sorted = [...entries].sort((a, b) => cmpBytes(a[0], b[0]));
  const parts = [te.encode(CATALOG_MAGIC), u32(CATALOG_VERSION), u32(sorted.length)];
  for (const [path, slot] of sorted) {
    const p = te.encode(path);
    parts.push(u32(slot), u32(p.length), p);
  }
  const body = concat(parts);
  return concat([body, u32(crc32(body))]);
}

/** @param {number} v */
function u32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, true);
  return b;
}

/** @param {Uint8Array[]} parts */
export function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---- the virtual tree ---------------------------------------------------------------------------

/**
 * The raw text of each top-level member's value of a JSON object, by key (the last wins, as in
 * JSON.parse). `text` must already have parsed: this walks it without re-checking the grammar.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function topLevelTokens(text) {
  /** @type {Map<string, string>} */
  const out = new Map();
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const skipString = () => { // text[i] is '"'
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
  };
  const skipValue = () => {
    if (text[i] === '"') { skipString(); return; }
    if (text[i] === '{' || text[i] === '[') {
      let depth = 0;
      do {
        const c = text[i];
        if (c === '"') { skipString(); continue; }
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') depth--;
        i++;
      } while (depth > 0 && i < text.length);
      return;
    }
    while (i < text.length && !',}] \t\n\r'.includes(text[i])) i++;
  };
  ws();
  if (text[i] !== '{') return out;
  i++;
  for (;;) {
    ws();
    if (i >= text.length || text[i] !== '"') break;
    const k0 = i;
    skipString();
    const key = JSON.parse(text.slice(k0, i));
    ws();
    i++; // ':'
    ws();
    const v0 = i;
    skipValue();
    out.set(key, text.slice(v0, i));
    ws();
    if (text[i] !== ',') break;
    i++;
  }
  return out;
}

/** A JSON object that names one key twice (where scanJson checks for it). */
export class DuplicateKeyError extends Error {
  /** @param {string} key */
  constructor(key) {
    super(`the key ${JSON.stringify(key)} twice`);
    this.name = 'DuplicateKeyError';
    this.key = key;
  }
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEX4 = /[0-9a-fA-F]{4}/y;

/**
 * Walk a JSON text strictly, without building it: RFC 8259 as serde_json, Python's json and
 * JSON.parse read it (whitespace is space, tab, LF and CR; no control character inside a string;
 * only the eight escapes and \uXXXX; no NaN, Infinity, leading zero, `+` or trailing comma), one
 * value and nothing after it. Throws DuplicateKeyError for an object that names a key twice (keys
 * compared after unescaping): in every object with `dups: 'all'`, in the top-level object only
 * with 'top'. Any other problem throws a SyntaxError naming the character offset. Iterative, so a
 * deep nesting cannot overflow the stack.
 * @param {string} text
 * @param {'all'|'top'} dups
 */
export function scanJson(text, dups) {
  const n = text.length;
  let i = 0;
  const fail = (/** @type {string} */ what) => { throw new SyntaxError(`${what} at character ${i}`); };
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      i++;
    }
  };
  /** Past one string (text[i] is '"'); its decoded value when `want`. @param {boolean} want */
  const string = (want) => {
    const s0 = i++;
    let escaped = false;
    for (;;) {
      if (i >= n) fail('an unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) break;
      if (c < 0x20) fail('a control character in a string');
      if (c === 0x5c) {
        escaped = true;
        const e = text[i + 1];
        if (e === 'u') {
          HEX4.lastIndex = i + 2;
          if (!HEX4.test(text)) fail('a bad \\u escape');
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else fail('a bad escape');
        continue;
      }
      i++;
    }
    i++;
    if (!want) return '';
    return escaped ? JSON.parse(text.slice(s0, i)) : text.slice(s0 + 1, i - 1);
  };
  /** The open containers, innermost last: {keys} for an object (a Set when its keys are checked, else null), {} for an array. */
  /** @type {Array<{keys?: Set<string>|null}>} */
  const stack = [];
  for (;;) {
    // one value; an object or an array that is not empty opens and goes on to its first member
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') i++; // {} is a whole value
      else {
        const keys = dups === 'all' || stack.length === 0 ? new Set() : null;
        stack.push({ keys });
        if (text[i] !== '"') fail('no key');
        const k = string(keys !== null);
        if (keys) keys.add(k);
        ws();
        if (text[i] !== ':') fail("no ':'");
        i++;
        continue;
      }
    } else if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') i++; // [] is a whole value
      else {
        stack.push({});
        continue;
      }
    } else if (c === '"') string(false);
    else if (text.startsWith('true', i)) i += 4;
    else if (text.startsWith('false', i)) i += 5;
    else if (text.startsWith('null', i)) i += 4;
    else {
      NUMBER.lastIndex = i;
      if (!NUMBER.test(text)) fail('no JSON value');
      i = NUMBER.lastIndex;
    }
    // after a value: close containers or go on to the next member
    for (;;) {
      if (!stack.length) {
        ws();
        if (i !== n) fail('text after the JSON value');
        return;
      }
      const top = stack[stack.length - 1];
      const isObject = 'keys' in top;
      ws();
      if (text[i] === ',') {
        i++;
        if (isObject) {
          ws();
          if (text[i] !== '"') fail('no key');
          const k = string(top.keys !== null);
          if (top.keys) {
            if (top.keys.has(k)) throw new DuplicateKeyError(k);
            top.keys.add(k);
          }
          ws();
          if (text[i] !== ':') fail("no ':'");
          i++;
        }
        break; // the next value
      }
      if (text[i] === (isObject ? '}' : ']')) {
        i++;
        stack.pop();
        continue; // the container was a value of its parent
      }
      fail(isObject ? "no ',' or '}'" : "no ',' or ']'");
    }
  }
}

/** The largest lsn, commit_ts or checkpoint_lsn accepted: the engine reads u64, the page checks exactly up to here. */
export const MAX_INT = Number.MAX_SAFE_INTEGER;
const INT_RULE = `an integer from 0 to ${MAX_INT} (no fraction or exponent)`;

/**
 * Strict JSON, as the engine's serde_json reads it: fatal UTF-8 with the BOM kept (so JSON.parse
 * refuses it); JSON.parse itself refuses NaN and Infinity; and no object names a key twice, at any
 * depth (DuplicateKeyError). Returns the value and its text.
 * @param {Uint8Array} bytes
 */
function strictJson(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const value = JSON.parse(text);
  scanJson(text, 'all');
  return { value, text };
}

/**
 * A member of a parsed top-level object that is an integer from 0 to MAX_INT as written: digits
 * only (no sign, fraction or exponent; `7e0` and `7.0` parse to 7 but are floats to the engine).
 * @param {any} obj @param {Map<string, string>} tokens @param {string} key
 */
function isUint(obj, tokens, key) {
  const v = obj[key];
  return Number.isInteger(v) && v >= 0 && v <= MAX_INT && /^\d+$/.test(tokens.get(key) ?? '');
}

/** The lsn of every whole frame of one WAL segment; a torn final frame ends it, other damage is refused. */
function walFrames(where, data) {
  const out = [];
  let pos = WAL_MAGIC.length;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  while (pos + 8 <= data.length) {
    const crc = dv.getUint32(pos, true);
    const n = dv.getUint32(pos + 4, true);
    const end = pos + 8 + n;
    if (end > data.length) break; // a torn payload
    const payload = data.subarray(pos + 8, end);
    if (crc32(payload) !== crc) {
      if (end === data.length) break; // a torn final append: the engine trims it
      throw new FormatError(where, `a WAL frame at byte ${pos} that fails its crc32, before the last frame`, 'whole MDBWAL01 frames');
    }
    // A matching crc32 is a whole frame, never a torn one: it must decode (the engine refuses it otherwise).
    let ok = false;
    let lsn = 0;
    try {
      const { value: rec, text } = strictJson(payload);
      if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
        const tokens = topLevelTokens(text);
        ok = isUint(rec, tokens, 'lsn') && isUint(rec, tokens, 'commit_ts') && Array.isArray(rec.ops);
        lsn = rec.lsn;
      }
    } catch (e) {
      // the engine: `undecodable WAL record ... (duplicate field `lsn` ...)`
      if (e instanceof DuplicateKeyError) throw new FormatError(where, `a WAL frame at byte ${pos} whose record names ${e.message}`, 'each key once in every object of a record');
      /* otherwise not strict JSON */
    }
    if (!ok) {
      throw new FormatError(where, `a WAL frame at byte ${pos} whose crc32 matches but whose record is not {lsn, commit_ts, ops} with integer lsn and commit_ts`,
        `a JSON object with lsn and commit_ts integers from 0 to ${MAX_INT} (no fraction or exponent) and a list ops`);
    }
    out.push(lsn);
    pos = end;
  }
  return out;
}

/**
 * graph.json is one strict JSON object whose top-level keys are all different (the engine:
 * `duplicate field`); nested values are walked for strict JSON, not for repeated keys.
 * @param {string} where @param {Uint8Array} bytes
 */
function checkGraph(where, bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new FormatError(where, 'a snapshot that is not UTF-8', 'strict JSON');
  }
  try {
    scanJson(text, 'top');
  } catch (e) {
    if (e instanceof DuplicateKeyError) throw new FormatError(where, `the top-level key ${JSON.stringify(e.key)} twice`, 'each key once (the engine: `duplicate field`)');
    throw new FormatError(where, `a snapshot that is not strict JSON (${e instanceof Error ? e.message : e})`, 'one JSON object');
  }
}

/** True for an engine side file: any part of the path starts with "." (the module comment). @param {string} path */
export function isDot(path) {
  return path.split('/').some((part) => part.startsWith('.'));
}

/**
 * A tree without its dot entries, and their paths (sorted).
 * @param {Map<string, Uint8Array>} files
 * @returns {{tree: Map<string, Uint8Array>, ignored: string[]}}
 */
export function splitDots(files) {
  const ignored = [...files.keys()].filter(isDot).sort(cmpBytes);
  return { tree: new Map([...files].filter(([p]) => !isDot(p))), ignored };
}

/**
 * Check a virtual tree (dot entries already split off) and summarise it, as opfsfmt.py check_tree does.
 * @param {Map<string, Uint8Array>} files
 * @param {string} [where]
 * @returns {{files: Record<string, number>, checkpoint_lsn: number, wal_frames: number, last_lsn: number, past_checkpoint: number}}
 */
export function checkTree(files, where = 'store') {
  const names = [...files.keys()];
  const extra = names.filter((p) => !SNAPSHOT.includes(p) && !SEGMENT.test(p)).sort(cmpBytes);
  if (extra.length) throw new FormatError(where, `unexpected file ${JSON.stringify(extra[0])}`, 'only graph.json, manifest.json, wal/NNNNNNNN.log and dot entries');
  const missing = SNAPSHOT.filter((p) => !files.has(p));
  const segments = names.filter((p) => SEGMENT.test(p)).sort(cmpBytes);
  if (missing.length) throw new FormatError(where, `no ${missing[0]}`, 'graph.json and manifest.json');
  let manifest;
  let manifestText;
  try {
    ({ value: manifest, text: manifestText } = strictJson(/** @type {Uint8Array} */ (files.get('manifest.json'))));
  } catch (e) {
    // the engine: `duplicate field `checkpoint_lsn``
    if (e instanceof DuplicateKeyError) throw new FormatError(`${where}/manifest.json`, e.message, 'each key once');
    throw new FormatError(where, 'a manifest.json that is not strict JSON', 'a JSON object');
  }
  const isObj = manifest && typeof manifest === 'object' && !Array.isArray(manifest);
  const codec = isObj ? manifest.codec : undefined;
  if (codec !== 'json') throw new FormatError(`${where}/manifest.json`, `codec ${JSON.stringify(codec ?? null)}`, '"json"');
  const tokens = topLevelTokens(manifestText);
  const lsn = manifest.checkpoint_lsn;
  if (!isUint(manifest, tokens, 'checkpoint_lsn')) {
    throw new FormatError(`${where}/manifest.json`, `checkpoint_lsn ${tokens.get('checkpoint_lsn') ?? 'null'}`, INT_RULE);
  }
  // Optional for the engine (it defaults it); a u64 when present. Other keys are accepted.
  if (Object.hasOwn(manifest, 'commit_ts') && !isUint(manifest, tokens, 'commit_ts')) {
    throw new FormatError(`${where}/manifest.json`, `commit_ts ${tokens.get('commit_ts') ?? 'null'}`, `${INT_RULE}, or no commit_ts`);
  }
  const graph = /** @type {Uint8Array} */ (files.get('graph.json'));
  const head = new TextDecoder('latin1').decode(graph.subarray(0, GRAPH_HEAD.length));
  if (head !== GRAPH_HEAD) throw new FormatError(`${where}/graph.json`, `a snapshot starting ${JSON.stringify(head)}`, `${JSON.stringify(GRAPH_HEAD)} (3 would be an ontology store)`);
  checkGraph(`${where}/graph.json`, graph);
  let frames = [];
  for (const seg of segments) {
    const data = /** @type {Uint8Array} */ (files.get(seg));
    const magic = new TextDecoder('latin1').decode(data.subarray(0, 8));
    if (magic !== WAL_MAGIC) throw new FormatError(`${where}/${seg}`, `WAL magic ${JSON.stringify(magic)}`, `"${WAL_MAGIC}"`);
    frames = frames.concat(walFrames(`${where}/${seg}`, data));
  }
  /** @type {Record<string, number>} */
  const sizes = {};
  for (const p of [...names].sort(cmpBytes)) sizes[p] = /** @type {Uint8Array} */ (files.get(p)).length;
  return { files: sizes, checkpoint_lsn: lsn, wal_frames: frames.length, last_lsn: Math.max(lsn, ...frames),
    past_checkpoint: frames.filter((f) => f > lsn).length };
}

/**
 * Refuse a tree whose WAL holds a record past the checkpoint: a snapshot (graph.json and
 * manifest.json alone) would lose it. As opfsfmt.py check_snapshot.
 * @param {{checkpoint_lsn: number, last_lsn: number, past_checkpoint: number}} summary
 * @param {string} where
 */
export function checkSnapshot(summary, where) {
  if (summary.past_checkpoint) {
    throw new FormatError(where, `${summary.past_checkpoint} WAL record(s) past checkpoint_lsn ${summary.checkpoint_lsn} ` +
      `(last lsn ${summary.last_lsn})`, 'none', 'A snapshot (graph.json and manifest.json alone) would lose them: free() the store first (the checkpoint), or restore it in the page (a restore keeps the WAL) and download it from there');
  }
}

// ---- OPFS ---------------------------------------------------------------------------------------

/** @param {boolean} [create] @returns {Promise<FileSystemDirectoryHandle|null>} */
async function relateDir(create = false) {
  const root = await navigator.storage.getDirectory();
  try {
    return await root.getDirectoryHandle(OPFS_DIR, { create });
  } catch (e) {
    if (!create && /** @type {Error} */ (e).name === 'NotFoundError') return null;
    throw e;
  }
}

/** @param {string} name @returns {Promise<FileSystemDirectoryHandle|null>} */
async function storeDir(name) {
  const base = await relateDir(false);
  if (!base) return null;
  try {
    return await base.getDirectoryHandle(name);
  } catch (e) {
    if (/** @type {Error} */ (e).name === 'NotFoundError') return null;
    throw e;
  }
}

/** @param {FileSystemDirectoryHandle} dir @param {string} file @returns {Promise<Uint8Array|null>} */
async function readFile(dir, file) {
  try {
    const h = await dir.getFileHandle(file);
    return new Uint8Array(await (await h.getFile()).arrayBuffer());
  } catch (e) {
    if (/** @type {Error} */ (e).name === 'NotFoundError') return null;
    throw e;
  }
}

const slotName = (i) => `slot-${String(i).padStart(2, '0')}`;

/**
 * The stores under relate/ whose names start with `prefix`, with their size on disk. A store
 * whose catalog is missing or empty (the leftover of a read-only open of a missing name, or a
 * store never written) has `empty: true`. Sizes may lag while a handle holds the store.
 * @param {string} [prefix]
 * @returns {Promise<Array<{name: string, bytes: number, empty: boolean}>>}
 */
export async function listStores(prefix = 'ex33-kg-') {
  const base = await relateDir(false);
  if (!base) return [];
  const out = [];
  // @ts-ignore: entries() is async-iterable in every browser with OPFS
  for await (const [name, handle] of base.entries()) {
    if (handle.kind !== 'directory' || !name.startsWith(prefix)) continue;
    let bytes = 0;
    let catalog = 0;
    // @ts-ignore
    for await (const [file, fh] of handle.entries()) {
      if (fh.kind !== 'file') continue;
      try {
        const size = (await fh.getFile()).size;
        bytes += size;
        if (file === 'catalog') catalog = size;
      } catch { /* held by a sync access handle in another context: size unknown */ }
    }
    out.push({ name, bytes, empty: catalog === 0 });
  }
  return out.sort((a, b) => cmpBytes(a.name, b.name));
}

/** @param {string} name */
export async function storeExists(name) {
  return (await storeDir(name)) !== null;
}

/**
 * Read a store's virtual tree: the catalog and only the slots it lists, dot entries left out
 * (their paths in `ignored`). Call it while no handle holds the store (the engine frees first), or
 * the bytes are not a consistent snapshot.
 * @param {string} name
 * @returns {Promise<{tree: Map<string, Uint8Array>, ignored: string[], catalog: Map<string, number>, stale: number}>}
 */
export async function readStore(name) {
  const dir = await storeDir(name);
  if (!dir) throw new Error(`no OPFS store ${name}`);
  const cat = await readFile(dir, 'catalog');
  if (!cat || cat.length === 0) throw new FormatError(`${name}/catalog`, 'no catalog', 'a store the engine has written');
  const catalog = decodeCatalog(cat, `${name}/catalog`);
  /** @type {Map<string, Uint8Array>} */
  const tree = new Map();
  const ignored = [];
  for (const [path, slot] of catalog) {
    if (isDot(path)) { ignored.push(path); continue; }
    const bytes = await readFile(dir, slotName(slot));
    if (!bytes) throw new FormatError(name, `no ${slotName(slot)} for ${JSON.stringify(path)}`, 'every slot the catalog lists');
    tree.set(path, bytes);
  }
  const listed = new Set([...catalog.values()]);
  let stale = 0;
  for (let i = 0; i < SLOTS; i++) {
    if (listed.has(i)) continue;
    const b = await readFile(dir, slotName(i));
    if (b && b.length) stale++;
  }
  return { tree, ignored: ignored.sort(cmpBytes), catalog, stale };
}

/**
 * Write a checked virtual tree into a new store `name`: the files into slot-00.. in path order,
 * every unused slot empty, the catalog last (it publishes the tree). Refuses a name that already
 * exists, more than 64 files and a dot entry (the engine writes its own side files).
 * @param {string} name
 * @param {Map<string, Uint8Array>} tree  without dot entries
 * @returns {Promise<Map<string, number>>} the catalog written
 */
export async function writeStore(name, tree) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(`${JSON.stringify(name)} is not an OPFS store name (1-64 of [A-Za-z0-9_-])`);
  if (tree.size > SLOTS) throw new FormatError(name, `${tree.size} files`, `at most ${SLOTS}`);
  const dot = [...tree.keys()].find(isDot);
  if (dot) throw new FormatError(name, `the dot entry ${JSON.stringify(dot)}`, 'none: the engine writes its own side files');
  const base = /** @type {FileSystemDirectoryHandle} */ (await relateDir(true));
  if (await storeDir(name)) throw new Error(`the OPFS store ${name} already exists; a restore writes a new store only`);
  const dir = await base.getDirectoryHandle(name, { create: true });
  const paths = [...tree.keys()].sort(cmpBytes);
  /** @type {Map<string, number>} */
  const catalog = new Map(paths.map((p, i) => [p, i]));
  const write = async (file, bytes) => {
    const w = await (await dir.getFileHandle(file, { create: true })).createWritable();
    await w.write(bytes);
    await w.close();
  };
  for (let i = 0; i < SLOTS; i++) await write(slotName(i), i < paths.length ? /** @type {Uint8Array} */ (tree.get(paths[i])) : new Uint8Array(0));
  await write('catalog', encodeCatalog(catalog));
  return catalog;
}

/** Delete a store's directory (a failed restore's leftovers). @param {string} name */
export async function removeStore(name) {
  const base = await relateDir(false);
  if (!base) return false;
  try {
    await base.removeEntry(name, { recursive: true });
    return true;
  } catch (e) {
    if (/** @type {Error} */ (e).name === 'NotFoundError') return false;
    throw e;
  }
}
