// @ts-check
/**
 * tar.js: the ustar archive of the database download, and a strict reader for the restore
 * (NOTES.md D17, X2-X5). Pure: no DOM, no OPFS; it runs in the page, the engine
 * worker and Node.
 *
 *   const bytes = writeTar({'graph.json': u8, 'manifest.json': u8, 'wal/00000001.log': u8, ...});
 *   const {files, dirs} = readTar(bytes);     // throws TarError on anything but plain files and dirs
 *
 * writeTar is deterministic and byte-identical to lib/opfsfmt.py's tar_bytes() (Python 3.12's
 * tarfile, USTAR_FORMAT) for the same files: a `wal/` directory entry first (mode 0755) when any
 * path is under wal/, then every file in code-point order of its path, mode 0644, uid/gid 0,
 * mtime 0, empty user and group names, two zero blocks, padded to a 10,240-byte record. So a
 * downloaded tar and one opfsfmt.py to-tar writes from the extracted directory are the same bytes.
 *
 * readTar accepts what tar tools write for a directory of regular files: ustar and old-GNU
 * headers, pax extended headers (`x`, whose `path` overrides the member name; other keys are
 * ignored) and global pax headers (`g`, ignored), GNU long names (`L`), a leading "./" and
 * directory entries. It refuses links, devices, FIFOs, sparse files, absolute paths, "..", a
 * name given twice, a bad header checksum and a truncated archive, as opfsfmt.py's reader does.
 * The archive must end as a tar tool ends it: after the last member, the end-of-archive marker
 * (two zero blocks, 1,024 bytes) and nothing but zero padding; one zero block, a cut marker or a
 * non-zero byte after it is a truncated or damaged archive (opfsfmt.py checks the same, since
 * Python's tarfile alone stops quietly at the first zero block).
 */

const BLOCK = 512;
const RECORD = 20 * BLOCK;
/** The end-of-archive marker: two zero blocks. */
const END_OF_ARCHIVE = 2 * BLOCK;
const te = new TextEncoder();

/** A tar that is not a plain archive of regular files. */
export class TarError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'TarError';
  }
}

/** Compare strings by code point (Python's sort order), not by UTF-16 unit. */
export function cmpPaths(a, b) {
  const x = Array.from(a, (c) => /** @type {number} */ (c.codePointAt(0)));
  const y = Array.from(b, (c) => /** @type {number} */ (c.codePointAt(0)));
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** @param {Uint8Array} h @param {number} off @param {string} s @param {number} len */
function putString(h, off, s, len) {
  const b = te.encode(s);
  if (b.length > len) throw new TarError(`${JSON.stringify(s)} does not fit a ${len}-byte ustar field`);
  h.set(b, off);
}

/** Python's itn() for USTAR: (digits - 1) zero-padded octal digits and a NUL. */
function octal(n, digits) {
  const s = n.toString(8);
  if (s.length > digits - 1) throw new TarError(`${n} does not fit a ${digits}-byte ustar number`);
  return s.padStart(digits - 1, '0') + '\0';
}

/**
 * One 512-byte ustar header, field for field as Python 3.12's tarfile writes it.
 * @param {string} name @param {number} mode @param {number} size @param {'0'|'5'} type
 */
function header(name, mode, size, type) {
  const h = new Uint8Array(BLOCK);
  const nameBytes = te.encode(name);
  if (nameBytes.length > 100) throw new TarError(`${JSON.stringify(name)}: names over 100 bytes are not written`);
  h.set(nameBytes, 0);
  putString(h, 100, octal(mode, 8), 8);
  putString(h, 108, octal(0, 8), 8); // uid
  putString(h, 116, octal(0, 8), 8); // gid
  putString(h, 124, octal(size, 12), 12);
  putString(h, 136, octal(0, 12), 12); // mtime
  putString(h, 148, '        ', 8); // checksum, counted as spaces
  putString(h, 156, type, 1);
  putString(h, 257, 'ustar\u000000', 8); // magic and version
  // uname, gname, devmajor, devminor and prefix stay NUL, as Python 3.12 leaves them for files and dirs.
  let sum = 0;
  for (const b of h) sum += b;
  putString(h, 148, sum.toString(8).padStart(6, '0') + '\0', 7); // byte 155 keeps its space
  return h;
}

/**
 * A deterministic ustar archive of `files` (see the module comment).
 * @param {Map<string, Uint8Array> | Record<string, Uint8Array>} files  path -> bytes; paths are
 *   relative, '/'-separated, without '.' or '..' parts
 * @returns {Uint8Array}
 */
export function writeTar(files) {
  const entries = files instanceof Map ? [...files] : Object.entries(files);
  for (const [path] of entries) checkName(path, 'writeTar');
  entries.sort((a, b) => cmpPaths(a[0], b[0]));
  /** @type {Uint8Array[]} */
  const parts = [];
  if (entries.some(([p]) => p.startsWith('wal/'))) parts.push(header('wal/', 0o755, 0, '5'));
  for (const [path, bytes] of entries) {
    parts.push(header(path, 0o644, bytes.length, '0'), bytes);
    const pad = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
    if (pad) parts.push(new Uint8Array(pad));
  }
  let size = parts.reduce((n, p) => n + p.length, 0) + 2 * BLOCK;
  size += (RECORD - (size % RECORD)) % RECORD;
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** @param {string} name @param {string} where */
function checkName(name, where) {
  const parts = name.split('/');
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0') ||
      parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new TarError(`${where}: member name ${JSON.stringify(name)} is not a plain relative path`);
  }
}

/** @param {Uint8Array} b @param {number} off @param {number} len */
function cString(b, off, len) {
  const slice = b.subarray(off, off + len);
  const end = slice.indexOf(0);
  return new TextDecoder('utf-8', { fatal: true }).decode(end < 0 ? slice : slice.subarray(0, end));
}

/** A numeric header field: octal digits (NUL or space terminated), or GNU base-256. */
function number(b, off, len) {
  if (b[off] & 0x80) {
    let n = 0;
    for (let i = 1; i < len; i++) n = n * 256 + b[off + i];
    return n;
  }
  const s = cString(b, off, len).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError(`a header number ${JSON.stringify(s)} is not octal`);
  return parseInt(s, 8);
}

/**
 * pax records "<len> <key>=<value>\n" -> Map of key -> raw value bytes (values may be binary,
 * e.g. SCHILY.xattr.*, which macOS tar writes).
 */
function paxRecords(data) {
  /** @type {Map<string, Uint8Array>} */
  const out = new Map();
  let i = 0;
  const latin1 = new TextDecoder('latin1');
  while (i < data.length) {
    let j = i;
    while (j < data.length && data[j] !== 0x20) j++;
    const len = Number(latin1.decode(data.subarray(i, j)));
    if (!Number.isInteger(len) || len <= 0 || i + len > data.length || data[i + len - 1] !== 0x0a) throw new TarError('a malformed pax header');
    const rec = data.subarray(j + 1, i + len - 1);
    const eq = rec.indexOf(0x3d);
    if (eq < 0) throw new TarError('a malformed pax record');
    out.set(latin1.decode(rec.subarray(0, eq)), rec.subarray(eq + 1));
    i += len;
  }
  return out;
}

/**
 * Read an uncompressed tar strictly (see the module comment).
 * @param {Uint8Array} buf
 * @returns {{files: Map<string, Uint8Array>, dirs: Set<string>}}  names without "./" or a trailing "/"
 */
export function readTar(buf) {
  if (!(buf instanceof Uint8Array)) throw new TypeError('readTar: bytes (Uint8Array)');
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  /** @type {Set<string>} */
  const dirs = new Set();
  let off = 0;
  /** @type {string|null} */ let longName = null;
  /** @type {string|null} */ let paxPath = null;
  let sawEnd = false;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) {
      // The end: two zero blocks at least, and only zeros after them.
      const tail = buf.subarray(off);
      let junk = 0;
      for (const b of tail) if (b !== 0) junk++;
      if (junk) throw new TarError(`${junk} non-zero byte(s) after the last whole member (a truncated or damaged tar)`);
      if (tail.length < END_OF_ARCHIVE) throw new TarError('no end-of-archive marker: the archive is truncated');
      sawEnd = true;
      break;
    }
    const stored = number(h, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== stored) throw new TarError(`a header checksum fails at byte ${off} (not a tar, or a damaged one)`);
    const type = String.fromCharCode(h[156] || 0x30);
    const size = number(h, 124, 12);
    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new TarError('the archive ends inside a member');
    const data = buf.subarray(dataStart, dataEnd);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      const p = paxRecords(data).get('path');
      if (p) paxPath = cString(p, 0, p.length);
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') { longName = cString(data, 0, data.length); continue; }
    let name = cString(h, 0, 100);
    const magic = cString(h, 257, 6);
    if (magic === 'ustar') {
      const prefix = cString(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (longName !== null) name = longName;
    if (paxPath !== null) name = paxPath;
    longName = null;
    paxPath = null;
    const isDir = type === '5' || (type === '0' && name.endsWith('/'));
    if (type !== '0' && type !== '\0' && type !== '7' && !isDir) {
      const what = { 1: 'a hard link', 2: 'a symbolic link', 3: 'a character device', 4: 'a block device', 6: 'a FIFO', S: 'a sparse file' }[type] ?? `tar type ${JSON.stringify(type)}`;
      throw new TarError(`member ${JSON.stringify(name)} is ${what}; only regular files are accepted`);
    }
    if (name.startsWith('./')) name = name.slice(2);
    if (isDir) name = name.replace(/\/+$/, '');
    if (isDir && (name === '' || name === '.')) continue;
    checkName(name, 'readTar');
    if (files.has(name) || dirs.has(name)) throw new TarError(`member ${JSON.stringify(name)} appears twice`);
    if (isDir) dirs.add(name);
    else files.set(name, data.slice());
  }
  if (!sawEnd) throw new TarError('no end-of-archive marker: the archive is truncated');
  return { files, dirs };
}
