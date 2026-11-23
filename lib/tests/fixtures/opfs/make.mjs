// Regenerate lib/tests/fixtures/opfs/{clean,dirty}.tar: raw OPFS exports of a Relate WASM
// store (relate/<name>/catalog + slot-00..slot-63), made in headless Chromium with the
// @relate/relate-wasm bundle the pinned engine's version names (the relate-db==<ver> pin in
// pyproject.toml), found and checked as lib/relate_wasm.mjs find(ver) and check(ver) do
// (examples/01-wasm-extract: npm ci --omit=peer). Also needs Playwright 1.63.0's cached Chromium
// (the same npm ci), or PLAYWRIGHT_CORE=<dir>.
//
//   node lib/tests/fixtures/opfs/make.mjs        # from the repo root
//
// clean.tar is read after free() (the WAL holds no record past the checkpoint); dirty.tar after
// more writes and a terminate() without free(), so its WAL holds committed frames the snapshot
// does not. The store has a graph type, a UNIQUE constraint, a FULLTEXT index, and FLOAT,
// INTEGER, STRING and list properties. Re-run lib/tests/test_opfsfmt.py after regenerating.
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { find as findWasm, check as checkWasm } from '../../../relate_wasm.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const pin = /"relate-db==([0-9]+\.[0-9]+\.[0-9]+)"/.exec(readFileSync(join(repo, 'pyproject.toml'), 'utf8'));
if (!pin) throw new Error('pyproject.toml pins no relate-db==<ver>');
process.chdir(join(repo, 'examples/01-wasm-extract')); // find() looks for node_modules from here
const verified = await checkWasm(pin[1]);
if (!verified.ok) throw new Error(`Relate ${pin[1]} WASM bundle: ${verified.reason}`);
const wasm = await findWasm(pin[1]);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE
  || join(repo, 'examples/01-wasm-extract/node_modules/playwright-core'));

const WORKER = `
import init, { RelateDb } from '/wasm/relate.js';
const step = new URL(self.location.href).searchParams.get('step');
await init();
const db = await RelateDb.open('opfs://fixture');
const x = (q) => { const e = JSON.parse(db.execute(q, null)); if (e.error) throw new Error(q + ': ' + e.error); return e; };
try {
  if (step === 'build') {
    x("ALTER CURRENT GRAPH TYPE SET { (:PERSON => {name :: STRING NOT NULL}), (:COMPANY => {name :: STRING NOT NULL}), (:PERSON)-[:FOUNDED =>]->(:COMPANY) }");
    x("CREATE CONSTRAINT kind_id FOR (k:Kind) REQUIRE k.id IS UNIQUE");
    x("CREATE FULLTEXT INDEX kind_desc FOR (k:Kind) ON EACH [k.description]");
    x("UNWIND [['PERSON', 'A named person.'], ['COMPANY', 'A named company.']] AS r CREATE (:Kind {id: r[0], description: r[1]})");
    x("CREATE (:PERSON {name: 'Ada Lovelace', p: 0.9, n: 3, tags: ['a', 'b']})-[:FOUNDED {p: 0.95, claims: ['c1']}]->(:COMPANY {name: 'Acme Inc', scores: [1.0, 0.5]})");
    db.free();
    self.postMessage({ ok: true });
  } else {
    x("UNWIND range(1, 3) AS i CREATE (:Extra {i: i, f: toFloat(i) / 2})");
    self.postMessage({ ok: true }); // no free(): the page terminates this worker
  }
} catch (e) { self.postMessage({ ok: false, message: String(e.message ?? e) }); }
`;

const PAGE = `<!doctype html><meta charset="utf-8"><title>opfs fixture</title><script type="module">
function concat(parts) { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
function tar(files) { // minimal ustar, fixed mtime 0, mode 0644
  const te = new TextEncoder(); const blocks = [];
  for (const { path, bytes } of files) {
    const h = new Uint8Array(512); const put = (s, off, len) => h.set(te.encode(s).slice(0, len), off);
    const oct = (v, len) => v.toString(8).padStart(len - 1, '0') + '\\0';
    put(path, 0, 100); put(oct(0o644, 8), 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);
    put(oct(bytes.length, 12), 124, 12); put(oct(0, 12), 136, 12); put('        ', 148, 8); put('0', 156, 1);
    put('ustar\\0', 257, 6); put('00', 263, 2);
    let sum = 0; for (const b of h) sum += b; put(sum.toString(8).padStart(6, '0') + '\\0 ', 148, 8);
    blocks.push(h, bytes, new Uint8Array((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024)); return concat(blocks);
}
window.step = (step) => new Promise((resolve) => {
  const w = new Worker('/worker.js?step=' + step, { type: 'module' });
  w.onmessage = (e) => { w.terminate(); resolve(e.data); };
  w.onerror = (e) => { w.terminate(); resolve({ ok: false, message: e.message }); };
});
window.exportRaw = async () => {
  const root = await navigator.storage.getDirectory();
  const dir = await (await root.getDirectoryHandle('relate')).getDirectoryHandle('fixture');
  const files = [];
  for await (const [name, h] of dir.entries()) files.push({ path: name, bytes: new Uint8Array(await (await h.getFile()).arrayBuffer()) });
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const t = tar(files); let s = ''; for (let i = 0; i < t.length; i += 0x8000) s += String.fromCharCode(...t.subarray(i, i + 0x8000));
  return btoa(s);
};
window.ready = true;
</script>`;

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const send = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
  if (p === '/') return send('text/html', PAGE);
  if (p === '/worker.js') return send('text/javascript', WORKER);
  const file = join(wasm, p.replace(/^\/wasm\//, ''));
  if (!p.startsWith('/wasm/') || !existsSync(file)) { res.writeHead(404); return res.end(); }
  return send(p.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const profile = mkdtempSync(join(tmpdir(), 'opfs-fixture-'));
let ctx;
try {
  ctx = await chromium.launchPersistentContext(profile, { headless: true });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.waitForFunction(() => window.ready === true);
  for (const [step, out] of [['build', 'clean.tar'], ['dirty', 'dirty.tar']]) {
    const r = await page.evaluate((s) => window.step(s), step);
    if (!r.ok) throw new Error(`${step}: ${r.message}`);
    await page.waitForTimeout(200); // let terminate() release the sync access handles
    writeFileSync(join(here, out), Buffer.from(await page.evaluate(() => window.exportRaw()), 'base64'));
    console.log(`wrote ${out}`);
  }
} finally {
  await ctx?.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
