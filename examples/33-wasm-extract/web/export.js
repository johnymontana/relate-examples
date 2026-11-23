// @ts-check
/**
 * export.js: download a store as a snapshot, and restore one from a file. WASM has no file surface
 * (NOTES.md R12: no export or import call, no .rl writer, no callable checkpoint procedure), so this
 * module reads and writes the OPFS files itself. Runs in the engine worker, which frees its handle
 * before exportTar and reopens after: only a freed store is a consistent snapshot, and free() is
 * the checkpoint, after which the WAL holds no record.
 *
 *   const {bytes, fileName, summary} = await exportTar('ex33-kg-financial-services');
 *     // <store>.relate.tar: graph.json and manifest.json, checked strictly, refused when the WAL
 *     // still holds a record past the checkpoint (it would be lost); tar.js writes it byte for
 *     // byte as lib/opfsfmt.py to-tar would. Natively (a writable open adopts the directory):
 *     //   mkdir db && tar -xf ex33-kg-financial-services.relate.tar -C db
 *     //   relate -d db 'MATCH (e:_Entity) RETURN e.kind AS kind, count(*) AS n'
 *     //   relate clone db kg-financial-services.rl      # a single-file bundle, after that first open
 *   const input = parseRestoreTar(bytes, 'kg.tar');  // {tree, summary}: throws FormatError / TarError
 *   const name = restoreName(fileName, existingNames);   // ex33-kg-<slug>-restored-<n>, never an existing one
 *   await opfs.writeStore(name, input.tree);              // slots in path order, the catalog last
 *
 * A restore takes three inputs: a download of this page; a tar of a native JSON-codec directory
 * database (`relate clone --to-snapshot-format json kg.rl dir`, then `python3 -I lib/opfsfmt.py
 * to-tar dir kg.tar`, or any tar of such a tree, WAL segments included); and a raw tar of an OPFS
 * store directory (catalog + slot-NN, as lib/opfsfmt.py reads it). Dot entries (the engine's side
 * files: role markers, leases, the .relate/schema/ mirror) are skipped by one rule and never written.
 */
import { FormatError, SLOTS, SNAPSHOT, checkSnapshot, checkTree, decodeCatalog, isDot, readStore, splitDots } from './opfs.js';
import { readTar, writeTar } from './tar.js';

/** Every store of this example is named ex33-kg-<slug>; restores add -restored-<n>. */
export const STORE_PREFIX = 'ex33-kg-';

/**
 * The download of a freed store: its snapshot (graph.json and manifest.json), checked, as a
 * deterministic ustar archive.
 * @param {string} name  the OPFS store name
 * @returns {Promise<{bytes: Uint8Array, fileName: string, summary: ReturnType<typeof checkTree> & {stale_slots: number, ignored: string[]}}>}
 */
export async function exportTar(name) {
  const { tree, ignored, stale } = await readStore(name);
  const summary = checkTree(tree, name);
  checkSnapshot(summary, name);
  const bytes = writeTar(new Map(SNAPSHOT.map((p) => [p, /** @type {Uint8Array} */ (tree.get(p))])));
  return { bytes, fileName: `${name}.relate.tar`, summary: { ...summary, stale_slots: stale, ignored } };
}

/**
 * Read an uploaded tar and check it strictly: a snapshot or directory-database tar (graph.json,
 * manifest.json, WAL segments; only wal/ and dot directories), or a raw OPFS store (catalog +
 * slot-NN). Dot entries are left out of the tree and named in summary.ignored.
 * @param {Uint8Array} bytes
 * @param {string} [where]  for messages: the file name
 * @returns {{tree: Map<string, Uint8Array>, summary: ReturnType<typeof checkTree> & {kind: 'snapshot'|'raw', ignored: string[]}}}
 */
export function parseRestoreTar(bytes, where = 'upload') {
  const { files, dirs } = readTar(bytes);
  if (files.has('catalog')) {
    if (dirs.size) throw new FormatError(where, `directory ${JSON.stringify([...dirs][0])} in a raw OPFS tar`, 'catalog and slot-NN files only');
    for (const name of files.keys()) {
      const m = /^slot-(\d\d)$/.exec(name);
      if (name !== 'catalog' && !(m && Number(m[1]) < SLOTS)) {
        throw new FormatError(where, `file ${JSON.stringify(name)} in a raw OPFS tar`, `catalog and slot-00 .. slot-${SLOTS - 1}`);
      }
    }
    const catalog = decodeCatalog(/** @type {Uint8Array} */ (files.get('catalog')), `${where}:catalog`);
    /** @type {Map<string, Uint8Array>} */
    const all = new Map();
    for (const [vpath, slot] of catalog) {
      const slotFile = `slot-${String(slot).padStart(2, '0')}`;
      const data = files.get(slotFile);
      if (!data) throw new FormatError(where, `no ${slotFile} for ${JSON.stringify(vpath)}`, 'every slot the catalog lists');
      all.set(vpath, data);
    }
    const { tree, ignored } = splitDots(all);
    return { tree, summary: { ...checkTree(tree, where), kind: 'raw', ignored } };
  }
  const extraDirs = [...dirs].filter((d) => d !== 'wal' && !isDot(d));
  if (extraDirs.length) throw new FormatError(where, `directory ${JSON.stringify(extraDirs[0])}`, 'only wal/ and dot entries');
  const { tree, ignored } = splitDots(files);
  return { tree, summary: { ...checkTree(tree, where), kind: 'snapshot', ignored } };
}

/**
 * A fresh store name for a restore: ex33-kg-<slug>-restored-<n> with the smallest n not taken.
 * The slug comes from the file name when it is one of this page's downloads
 * (ex33-kg-<slug>[-restored-<n>].relate.tar), else from the file name folded to
 * [A-Za-z0-9_-] ('upload' when nothing is left); it is cut so the name fits 64 characters.
 * @param {string} fileName
 * @param {Iterable<string>} taken  existing store names
 */
export function restoreName(fileName, taken) {
  const used = new Set(taken);
  const base = String(fileName ?? '').split(/[\\/]/).pop() ?? '';
  const ours = /^ex33-kg-([A-Za-z0-9_-]+?)(?:-restored-\d+)?\.relate\.tar$/.exec(base);
  let slug = ours ? ours[1] : base.replace(/\.(?:relate\.)?tar$/i, '').normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '');
  if (!slug) slug = 'upload';
  for (let n = 1; ; n++) {
    const suffix = `-restored-${n}`;
    const room = 64 - STORE_PREFIX.length - suffix.length;
    const name = `${STORE_PREFIX}${slug.slice(0, room).replace(/[_-]+$/, '') || 'upload'}${suffix}`;
    if (!used.has(name)) return name;
  }
}
