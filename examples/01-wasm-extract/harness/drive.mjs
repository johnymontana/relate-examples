#!/usr/bin/env node
// @ts-check
/**
 * harness/drive.mjs: the page in headless Chromium (Playwright 1.63.0), against the built dist/
 * served the way GitHub Pages serves it (browser.txt; D11, D14, D17, D19; R10, R11, R15, R24, X1-X5, V6-V8).
 *
 *   node harness/drive.mjs [--out <file>] [--port N] [--no-build]
 *       run.sh's browser section: npm run build, then harness/serve.mjs --site on a fixed port
 *       (storage is per origin, port included; EX01_DRIVE_PORT, default 8735, or any free port when
 *       that one is taken) at /relate-examples/01-wasm-extract/ with no custom headers (the page's CSP
 *       is its own <meta>), a persistent profile in work/browser/profile (reset every run), ?test=1
 *       (d3Force layouts, V6) and ?watchdog=3000.
 *       The weights come from .cache/gliner through page.route() on their Hub URLs (206 answers to
 *       the page's Range requests). Writes browser.txt (default out/browser.txt): no timings, ids,
 *       paths or pids; content digests are compared, never printed. Saves the downloaded snapshot tar
 *       (<store>.relate.tar) and dump.json in work/browser/ for harness/native.py. Exit 1 when a check
 *       fails (each failure is a `drive.mjs: FAIL:` line on stderr), 2 when an input is missing.
 *   node harness/drive.mjs --smoke --base-url <url ending in /01-wasm-extract/>
 *       A smoke test of a deployed site (e.g. https://<owner>.github.io/relate-examples/01-wasm-extract/):
 *       no browser.txt, one ok/FAIL line per check on stdout, exit 1 on any failure. The weights come
 *       from GLINER_SMALL_DIR (default .cache/gliner) through page.route().
 *   node harness/drive.mjs node-dump <out.json> [main|generic]
 *       harness/native.py's inputs, built in Node with web/pipeline.js and web/store.js on the real
 *       model, as lib/replay.mjs canon text. `main` (the default): the store the browser section
 *       dumps when it did not run (financial-services, create-context-graph's domain, with its
 *       sample, titled by sample id as the page extracts it). `generic`: a generic Ontology Graph
 *       Spec v1 document's store (harness/fixtures.mjs GENERIC_YAML, with a gazetteer, a symmetric
 *       link and a two-pair link, on GENERIC_TEXT), for native.py's second round trip.
 *   node harness/drive.mjs wasm-queries <dump.json> <out.json>
 *       For harness/native.py: the dump loaded into Relate WASM (in memory, lib/replay.mjs), then
 *       every queries/*.cypher with its documented example parameters (`// @param name TYPE <json>
 *       text`); each row as canon text without its `path` columns (paths carry internal ids).
 *
 * The Node side (also used in-process by the browser run for its comparisons) is web/gliner.js,
 * web/pipeline.js and web/store.js on Relate 1.2.0 WASM in memory and GLiNER2.5-small-v1,
 * exactly as harness/run.mjs runs them, with the page's defaults (no cutoffs, DEFAULT_GATE).
 *
 * Content comparisons use lib/replay.mjs digests of a dump without its (:_Run) nodes: a Run records
 * when (timestamp(), R19) and how often a document was read, which a reload, a crash or a second
 * pass changes by design (harness/run.mjs's gateFingerprint leaves them out for the same reason).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as cl from '../../../lib/relate_wasm.mjs';
import * as replay from '../../../lib/replay.mjs';
import { MODEL_FILES, extractRaw, loadModel } from '../web/gliner.js';
import { storeIndexNames, toolCompat } from '../web/console.js';
import { parseDocument, toYaml } from '../web/ogs.js';
import { ONTOLOGY_CONSTRAINTS, parseOntology } from '../web/ontology.js';
import * as pipeline from '../web/pipeline.js';
import { splitSentences } from '../web/split.js';
import * as store from '../web/store.js';
import { CANDIDATE_SIZE, NODE_SIZE } from '../web/tonvl.js';
import { GENERIC_TEXT, GENERIC_YAML } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EX = path.resolve(HERE, '..');
const ROOT = path.resolve(EX, '../..');
const VER = '1.2.0';
const GLINER_REV = '4fa741eec466660daf4adc8703210138295e0b1b';
const SMALL = { repo: 'fastino/gliner2.5-small-v1', rev: '7132dc4561c3f94563c6147e75ffa8ef34c4964a', name: 'gliner2.5-small-v1' };
const WASM_DIR = process.env.GLINER_WASM_DIR || path.join(ROOT, '.cache/gliner-wasm', GLINER_REV.slice(0, 7));
const MODEL_DIR = process.env.GLINER_SMALL_DIR || path.join(ROOT, '.cache/gliner', `${SMALL.name}@${SMALL.rev.slice(0, 7)}`);
/** The browser section's store: the page's default ontology, create-context-graph's financial-services domain. */
const ONTOLOGY = 'financial-services';
const STORE = `ex01-kg-${ONTOLOGY}`;
/** The sample the browser section extracts there, and the Node side reproduces. */
const SAMPLE = 'financial-services';
/** The kept entity the graph tab clicks (its evidence must show). */
const CLICK = { id: 'Person:DANA_WHITLOCK', title: 'Dana Whitlock' };
/** An edge the financial-services graph type refuses: OWNS is typed (:Person)-[:OWNS]->(:Account). */
const ILLEGAL = { label: '(:Account)-[:OWNS]->(:Person)', query: "CREATE (:Account {name: 'Probe'})-[:OWNS]->(:Person {name: 'Probe Person'})" };
/** The ontology the picker opens next (D14: another store), and where the engine is terminated mid-section. */
const OTHER = 'software-engineering';
const WATCHDOG_MS = 3000;
/** Every child process gets a deadline, so a stuck one fails the run instead of hanging it (ms). */
const CHILD_TIMEOUT = { check: 60000, build: 300000, native: 300000 };
/** web/graphview.js REL_LABEL_AT (that module imports NVL's browser bundle, so the page is asked for it and must agree). */
const REL_LABEL_AT = 2;

const note = (/** @type {string} */ m) => process.stderr.write(`drive.mjs: ${m}\n`);
const rel = (/** @type {string} */ p) => (p.startsWith(`${ROOT}/`) ? p.slice(ROOT.length + 1) : p);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** A missing input: exit 2 with the fix. @param {string} m */
function missing(m) {
  note(m);
  process.exit(2);
}

// ==== the Node side ================================================================================

/** @type {Promise<any> | null} */
let nodeEnvP = null;
/** Relate WASM and GLiNER2.5-small-v1 in this process, loaded once. */
function nodeEnv() {
  nodeEnvP ??= (async () => {
    const info = await cl.check(VER);
    if (!info.ok) missing(`Relate ${VER} WASM: ${info.reason}; fix: npm ci --omit=peer (in examples/01-wasm-extract)`);
    for (const f of ['gliner_rs.js', 'gliner_rs_bg.wasm']) {
      if (!fs.existsSync(path.join(WASM_DIR, f))) missing(`no gliner-rs build in ${rel(WASM_DIR)}; fix: scripts/build-gliner-wasm.sh`);
    }
    const pin = path.join(ROOT, 'ci', `${SMALL.name}.sha256`);
    const verified = path.join(MODEL_DIR, '.verified');
    if (!fs.existsSync(verified) || !fs.readFileSync(verified).equals(fs.readFileSync(pin))) {
      missing(`no verified weights in ${rel(MODEL_DIR)}; fix: scripts/fetch-gliner.sh small`);
    }
    const sums = new Map(fs.readFileSync(pin, 'utf8').trim().split('\n').map((l) => l.split(/\s+/)).map(([s, p]) => [p, s]));
    const mod = await cl.loadNode(VER);
    const glue = await import(pathToFileURL(path.join(WASM_DIR, 'gliner_rs.js')).href);
    const model = loadModel({
      glue, wasmBytes: fs.readFileSync(path.join(WASM_DIR, 'gliner_rs_bg.wasm')),
      ...Object.fromEntries(Object.entries(MODEL_FILES).map(([arg, f]) => [arg, fs.readFileSync(path.join(MODEL_DIR, f))])),
    });
    const modelInfo = { repo: SMALL.repo, rev: SMALL.rev, weights: sums.get('model.safetensors'), build: pipeline.BUILD };
    /** @type {Map<string, any>} */
    const ontologies = new Map();
    // the bundled ontologies as the page's picker loads them: Ontology Graph Spec v1 documents (data/ontologies/ogs/ccg/),
    // and the generic document of native.py's second round trip
    const dir = path.join(EX, 'data/ontologies/ogs/ccg');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ontology.yaml')).sort()) {
      const o = parseOntology(fs.readFileSync(path.join(dir, f), 'utf8'));
      ontologies.set(o.id, o);
    }
    const generic = parseOntology(GENERIC_YAML);
    ontologies.set(generic.id, generic);
    const samples = new Map(JSON.parse(fs.readFileSync(path.join(EX, 'data/samples/samples.json'), 'utf8'))
      .map((/** @type {any} */ s) => [s.id, { ...s, text: fs.readFileSync(path.join(EX, 'data/samples', s.file), 'utf8') }]));
    return { mod, model, modelInfo, ontologies, samples };
  })();
  return nodeEnvP;
}

/**
 * A fresh in-memory store for one ontology, opened as the worker opens it, with documents
 * extracted, gated and published in order (pipeline.run, the page's defaults).
 * @param {string} oid @param {Array<{text: string, title: string}>} docs
 */
async function nodeStore(oid, docs) {
  const { mod, model, modelInfo, ontologies } = await nodeEnv();
  const o = ontologies.get(oid);
  const db = new mod.RelateDb();
  store.openStore(db, cl, o, {});
  for (const d of docs) await pipeline.run({ db, cl, model, modelInfo, ontology: o, text: d.text, title: d.title });
  return db;
}

/**
 * A store built in Node, as dump.json text: 'main' is the browser section's (the financial-services
 * sample in its domain's store), 'generic' the generic v1 document's (GENERIC_YAML on GENERIC_TEXT).
 * @param {'main'|'generic'} which
 */
async function nodeDump(which = 'main') {
  const { samples } = await nodeEnv();
  const db = which === 'generic'
    ? await nodeStore(parseOntology(GENERIC_YAML).id, [{ text: GENERIC_TEXT, title: 'edge_cases' }])
    : await nodeStore(ONTOLOGY, [{ text: samples.get(SAMPLE).text, title: SAMPLE }]);
  try {
    return store.dumpStore(db);
  } finally {
    db.free();
  }
}

/** A dump without its (:_Run) nodes and their relationships (see the header). @param {any} d */
function withoutRuns(d) {
  const runs = new Set(d.nodes.filter((/** @type {any} */ n) => n.labels.includes('_Run')).map((/** @type {any} */ n) => n.k));
  return {
    ...d,
    nodes: d.nodes.filter((/** @type {any} */ n) => !runs.has(n.k)),
    relationships: d.relationships.filter((/** @type {any} */ r) => !runs.has(r.s) && !runs.has(r.e)),
  };
}
/** @param {string} text dump.json */
const stableDigest = (text) => replay.digest(withoutRuns(replay.parse(text)));

/** gliner-rs's raw JSON for one sentence under an ontology's schema, in Node. */
async function nodeRaw(oid, sentence) {
  const { model, ontologies } = await nodeEnv();
  return extractRaw(model, sentence, pipeline.modelSchema(ontologies.get(oid)).schema);
}

/** Saved queries with their documented example parameters (as app.js parseQuery reads them). */
function savedQueries() {
  const dir = path.join(EX, 'queries');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.cypher')).sort().map((file) => {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    /** @type {Record<string, any>} */
    const params = {};
    for (const line of src.split('\n')) {
      if (!line.startsWith('//')) break;
      const m = /^\/\/ ?@param\s+(\w+)\s+(\w+)\s+(.*)$/.exec(line);
      if (!m) continue;
      for (let i = m[3].length; i > 0; i--) {
        try {
          params[m[1]] = JSON.parse(m[3].slice(0, i));
          break;
        } catch { /* shorter */ }
      }
    }
    return { file, src, params };
  });
}

/** drive.mjs wasm-queries: the dump in WASM, every saved query, rows as canon text. */
async function wasmQueries(dumpPath, outPath) {
  const mod = await cl.loadNode(VER);
  const db = new mod.RelateDb();
  try {
    replay.load(db, replay.parse(fs.readFileSync(dumpPath, 'utf8')));
    /** @type {Record<string, any>} */
    const out = {};
    for (const q of savedQueries()) {
      const env = replay.parse(db.execute(q.src, Object.keys(q.params).length ? JSON.stringify(q.params) : null));
      if (env.error != null) {
        out[q.file] = { params: q.params, error: String(env.error).split('\n')[0] };
        continue;
      }
      const columns = env.columns.filter((/** @type {string} */ c) => c !== 'path');
      const rows = env.rows.map((/** @type {any} */ r) => replay.canon(Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))));
      out[q.file] = { params: q.params, columns, dropped: env.columns.filter((/** @type {string} */ c) => c === 'path'), rows };
    }
    fs.writeFileSync(outPath, `${JSON.stringify(out, null, 1)}\n`);
  } finally {
    db.free();
  }
}

// ==== Playwright, the server, the weights ==========================================================

async function playwright() {
  try {
    return await import('playwright');
  } catch (e) {
    missing(`playwright is not installed: ${e instanceof Error ? e.message : e}; fix: cd examples/01-wasm-extract && npm ci --omit=peer`);
    throw e;
  }
}

/**
 * Answer the page's Hub requests for small-v1 from the local copy: 206 for `Range: bytes=a-b`
 * (models.js fetches files over 32 MiB in ranges; a whole 296 MB model.safetensors body through route.fulfill
 * exhausts Node), 200 otherwise. Anything else on the Hub gets a 404 and is recorded.
 * @param {any} ctx @param {string} modelDir
 */
async function routeHub(ctx, modelDir) {
  const counts = { files: 0, ranges: 0, other: /** @type {string[]} */ ([]) };
  const prefix = `/${SMALL.repo}/resolve/${SMALL.rev}/`;
  const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Range, Content-Length', 'content-type': 'application/octet-stream' };
  const handler = async (/** @type {any} */ route) => {
    const req = route.request();
    const u = new URL(req.url());
    const file = u.hostname === 'huggingface.co' && u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : null;
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': 'range', 'access-control-allow-methods': 'GET' } });
    }
    if (!file || !Object.values(MODEL_FILES).includes(file)) {
      counts.other.push(`${u.origin}${u.pathname}`);
      return route.fulfill({ status: 404, headers: cors, body: 'not routed by drive.mjs' });
    }
    counts.files++;
    const full = path.join(modelDir, file);
    const size = fs.statSync(full).size;
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers().range ?? '');
    if (!m) return route.fulfill({ status: 200, path: full, headers: cors });
    const a = Number(m[1]);
    const b = Math.min(Number(m[2]), size - 1);
    const buf = Buffer.alloc(b - a + 1);
    const fd = fs.openSync(full, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, a); } finally { fs.closeSync(fd); }
    counts.ranges++;
    return route.fulfill({ status: 206, body: buf, headers: { ...cors, 'content-range': `bytes ${a}-${b}/${size}` } });
  };
  await ctx.route('https://huggingface.co/**', handler);
  await ctx.route(/^https:\/\/([a-z0-9-]+\.)*hf\.co\//, handler);
  return counts;
}

/**
 * Watch a context for what must never happen: console errors (warnings are ignored: NVL's WebGL
 * logs "GPU stall due to ReadPixels"), page errors, CSP violations, and requests that leave the
 * page's origin other than the routed Hub.
 * @param {any} ctx @param {string} origin
 */
async function watch(ctx, origin) {
  const w = { errors: /** @type {string[]} */ ([]), external: /** @type {string[]} */ ([]), pages: /** @type {any[]} */ ([]) };
  await ctx.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      // @ts-ignore
      (window.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  const onPage = (/** @type {any} */ page) => {
    w.pages.push(page);
    page.on('console', (/** @type {any} */ m) => { if (m.type() === 'error') w.errors.push(`console.error: ${m.text()}`); });
    page.on('pageerror', (/** @type {any} */ e) => w.errors.push(`pageerror: ${e.message}`));
    page.on('worker', (/** @type {any} */ wk) => wk.on('console', (/** @type {any} */ m) => { if (m.type() === 'error') w.errors.push(`worker console.error: ${m.text()}`); }));
  };
  for (const p of ctx.pages()) onPage(p);
  ctx.on('page', onPage);
  ctx.on('request', (/** @type {any} */ r) => {
    const u = r.url();
    if (/^(blob|data|about):/.test(u)) return;
    const o = new URL(u).origin;
    if (o === origin || o === 'https://huggingface.co') return;
    w.external.push(u);
  });
  /** CSP violations seen by every page still open. */
  w.csp = async () => {
    const all = [];
    for (const p of w.pages) {
      if (p.isClosed()) continue;
      // @ts-ignore
      all.push(...await p.evaluate(() => window.__csp ?? []).catch(() => []));
    }
    return all;
  };
  return w;
}

const ds = (/** @type {any} */ page, /** @type {string} */ a) => page.evaluate((/** @type {string} */ x) => document.body.dataset[x] ?? '', a);
const waitDs = (/** @type {any} */ page, /** @type {string} */ a, /** @type {string[]} */ vals, timeout = 120000) =>
  page.waitForFunction(([x, v]) => v.includes(document.body.dataset[x] ?? ''), [a, vals], { timeout });
const tid = (/** @type {string} */ id) => `[data-testid="${id}"]`;
const text = async (/** @type {any} */ page, /** @type {string} */ id) => ((await page.textContent(tid(id))) ?? '').trim();

/**
 * The kept triples expected/extract.txt lists for one document of one store.
 * @param {string} oid e.g. 'financial-services' @param {string} section e.g. 'financial-services', '13_northwind'
 */
function expectedKept(oid, section) {
  const all = fs.readFileSync(path.join(EX, 'expected/extract.txt'), 'utf8');
  const part = all.split(`\n## ${oid}: ${section} `)[1]?.split('\n## ')[0] ?? '';
  return [...part.matchAll(/^ {2}keep\s+\S+\s+s\d+ (".+" -\[\w+\]-> ".+") (\d\.\d{3})$/gm)].map((m) => `${m[1]} ${m[2]}`).sort();
}

/**
 * Extract the open store's domain's sample (step 3; "Use the sample" first when the Document box holds
 * anything else), wait for the result. kept: the document's kept facts as extract.txt writes them.
 * @returns {Promise<{state: string, status: string, kept: string[], data: Record<string, string>}>}
 */
async function extractSample(page, id) {
  const isSample = () => page.evaluate((t) => {
    const ex = /** @type {any} */ (window).ex01;
    return ex.state.doc.sample?.id === t && /** @type {HTMLTextAreaElement} */ (document.querySelector('[data-testid="doc-text"]')).value === ex.state.doc.body;
  }, id);
  if (!await isSample()) {
    await page.$eval(tid('doc-details'), (e) => { /** @type {HTMLDetailsElement} */ (e).open = true; });
    await page.click(tid('use-sample'));
    await page.waitForFunction((t) => /** @type {any} */ (window).ex01.state.doc.sample?.id === t, id, { timeout: 30000 });
  }
  await waitDs(page, 'busy', ['0'], 60000);
  await page.click(tid('extract'));
  await page.waitForFunction(() => ['running', 'confirm', 'failed'].includes(document.body.dataset.extract ?? '') ||
    document.body.dataset.extract === 'done', null, { timeout: 60000 });
  await waitDs(page, 'extract', ['done', 'failed', 'stopped', 'confirm'], 300000);
  const kept = await page.$$eval(tid('kept-fact'), (els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.fact ?? ''));
  const data = await page.$eval(tid('extract-status'), (e) => ({ .../** @type {HTMLElement} */ (e).dataset }));
  return { state: await ds(page, 'extract'), status: await text(page, 'extract-status'), kept, data };
}

/** The graph view's last fit, once it is measured (graphview.js fit/measure): after `after` fits. */
async function fitted(page, view, after = 0) {
  await page.waitForFunction(([v, n]) => {
    const g = /** @type {any} */ (window).ex01[v];
    return g.fits > n && g.lastFit !== null;
  }, [view, after], { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(100);
  return page.evaluate((v) => {
    const g = /** @type {any} */ (window).ex01[v];
    const label = g.labelLayer.querySelector('.nvl-label');
    return { fits: g.fits, ...g.lastFit, font: label ? getComputedStyle(label).fontSize : '' };
  }, view);
}

/**
 * "every node inside, labelled": the pin on a fit (a fixed 11.5 px font; two thirds of the labels at least, the rest
 * covered); and every relationship label shown on its own edge's midpoint (its centre within REL_LABEL_AT px on
 * screen), over no node and no node label. How many relationship labels show depends on the host's
 * font metrics, so it is not printed.
 */
const fitOk = (/** @type {any} */ f) => f.nodes > 0 && f.inside === f.nodes && f.labels === f.nodes && f.labelled * 3 >= f.labels * 2 && f.font === '11.5px' &&
  f.relOff <= REL_LABEL_AT && f.relOver === 0;
/** The words fitOk's pin is printed with. */
const FIT_WORDS = `labelled under it at 11.5px (two thirds of the labels shown at least, the rest covered until a zoom); each relationship label shown on its edge's midpoint (within ${REL_LABEL_AT} px), over no node or node label`;

/**
 * The summary line over the graph after an extraction: its text, its buttons and data-*
 * (the store's totals and the document's share, as the page put them).
 */
async function summaryLine(page) {
  return page.$eval('[data-testid="graph-summary"]', (e) => ({
    shown: !/** @type {HTMLElement} */ (e).hidden, text: (e.querySelector('[data-testid="graph-summary-text"]')?.textContent ?? '').trim(),
    buttons: [...e.querySelectorAll('.summary-actions button')].filter((b) => !/** @type {HTMLElement} */ (b).hidden).map((b) => (b.textContent ?? '').trim()),
    .../** @type {HTMLElement} */ (e).dataset,
  }));
}

/** One console query through the UI (D11's lease): its status line, category, rows. */
async function consoleUi(page, query, { saved = '' } = {}) {
  await page.click(tid('tab-console'));
  if (saved) await page.selectOption(tid('saved-queries'), saved);
  else {
    await page.selectOption(tid('saved-queries'), '');
    await page.fill(tid('console-input'), query);
  }
  await page.$eval(tid('console-status'), (e) => { delete e.dataset.code; });
  await page.click(tid('console-run'));
  await page.waitForFunction(() => document.querySelector('[data-testid="console-status"]').dataset.code, null, { timeout: 60000 });
  return page.$eval(tid('console-status'), (e) => ({ code: e.dataset.code ?? '', category: e.dataset.category ?? '', rows: Number(e.dataset.rows ?? -1), text: (e.textContent ?? '').trim() }));
}

/** ex01.runConsole in the page: {ok, rows, code, category, message}. */
async function consoleCall(page, query, params = {}) {
  return page.evaluate(async ([q, p]) => {
    // @ts-ignore
    const r = await window.ex01.runConsole(q, p);
    return r.ok ? { ok: true, columns: r.data.columns, rows: r.data.rows } : { ok: false, code: r.error?.code ?? '', category: r.error?.category ?? '', message: String(r.error?.message ?? '').split('\n')[0] };
  }, [query, params]);
}

/** The first line of an engine message, its position excerpt dropped. @param {string} m */
const firstLine = (m) => String(m ?? '').split('\n')[0].trim();

/** Wait until NVL's node positions stop moving (d3Force settles; V6). */
async function settled(page, view) {
  let last = '';
  for (let i = 0; i < 40; i++) {
    const now = await page.evaluate((v) => {
      // @ts-ignore
      const nvl = window.ex01[v].nvl;
      if (!nvl || nvl.isLayoutMoving()) return '';
      return JSON.stringify(nvl.getNodes().map((n) => [n.id, Math.round(n.x ?? 0), Math.round(n.y ?? 0)]));
    }, view);
    if (now && now === last) return true;
    last = now;
    await sleep(250);
  }
  return false;
}

/**
 * The repository's engine for harness/native.py x4, when there: `relate` on PATH reporting VER,
 * and the project env's python through uv (native.py itself checks that its binding is VER too).
 * @returns {{cmd: string, args: string[]} | null}
 */
function nativeEngine() {
  const env = { ...process.env, RELATE_TELEMETRY: 'off', RELATE_AGENT_MODE: '0' };
  const v = spawnSync('relate', ['--version'], { encoding: 'utf8', env, timeout: CHILD_TIMEOUT.check });
  if (v.error || v.status !== 0 || v.stdout.trim().split("\n", 1)[0] !== `Relate v${VER}`) return null;
  const u = spawnSync('uv', ['--version'], { encoding: 'utf8', timeout: CHILD_TIMEOUT.check });
  if (u.error || u.status !== 0) return null;
  return { cmd: 'uv', args: ['run', '--project', ROOT, '--quiet', 'python', '-I'] };
}

/** lib/opfsfmt.py check --snapshot on a tar, with python3: {ok, line}. */
function opfsCheck(tar) {
  const r = spawnSync('python3', ['-I', 'lib/opfsfmt.py', 'check', '--json', '--snapshot', path.relative(ROOT, tar)], { cwd: ROOT, encoding: 'utf8', timeout: CHILD_TIMEOUT.check });
  if (r.error) return { ok: false, line: `lib/opfsfmt.py check: ${r.error.message}`, json: null };
  if (r.status !== 0) return { ok: false, line: firstLine(r.stderr || r.stdout || `exit ${r.status}`), json: null };
  return { ok: true, line: '', json: JSON.parse(r.stdout) };
}

// ==== the browser run (browser.txt) ================================================================

async function browserRun(argv) {
  const outFile = path.resolve(argv.out ?? path.join(EX, 'out/browser.txt'));
  const work = path.join(EX, 'work/browser');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  /** @type {string[]} */
  const lines = [];
  const say = (/** @type {string} */ s = '') => lines.push(s);
  /** @type {string[]} */
  const failures = [];
  /** A check: `yes`/`NO` in the line, a FAIL on stderr when it does not hold. */
  const yes = (/** @type {boolean} */ c, /** @type {string} */ what) => {
    if (!c) {
      failures.push(what);
      note(`FAIL: ${what}`);
    }
    return c ? 'yes' : 'NO';
  };
  const t0 = performance.now();
  const secs = () => `${((performance.now() - t0) / 1000).toFixed(1)} s`;

  if (!argv.noBuild) {
    note('npm run build (dist/)');
    execFileSync('npm', ['run', '--silent', 'build'], { cwd: EX, stdio: ['ignore', 'ignore', 'inherit'], timeout: CHILD_TIMEOUT.build });
  }
  const env = await nodeEnv(); // the Node side, loaded before the browser starts
  const { chromium } = await playwright();
  const { start } = await import(pathToFileURL(path.join(HERE, 'serve.mjs')).href);
  const wanted = Number(argv.port ?? process.env.EX01_DRIVE_PORT ?? 8735);
  let server;
  try {
    server = await start({ mode: 'site', port: wanted });
  } catch (e) {
    if (/** @type {any} */ (e)?.code !== 'EADDRINUSE') throw e;
    note(`port ${wanted} is taken; serving on a free port (the origin stays the same for the whole run)`);
    server = await start({ mode: 'site', port: 0 });
  }
  const base = server.base;
  const url = (/** @type {string} */ q = '') => `${base}?test=1&watchdog=${WATCHDOG_MS}${q}`;
  const ctx = await chromium.launchPersistentContext(path.join(work, 'profile'), { headless: true, acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const closeAll = async () => {
    await ctx.close().catch(() => {});
    await server.close().catch(() => {});
  };
  process.once('SIGINT', () => closeAll().then(() => process.exit(130)));
  process.once('SIGTERM', () => closeAll().then(() => process.exit(143)));
  const w = await watch(ctx, server.url);
  const hub = await routeHub(ctx, MODEL_DIR);
  let p1 = ctx.pages()[0] ?? await ctx.newPage();
  let page = p1;

  try {
    say(`# The page in headless Chromium (harness/drive.mjs): dist/ at ${new URL(base).pathname}, served as GitHub Pages serves it`);
    say(`# (no custom headers: the page's own Content-Security-Policy <meta>); Relate ${VER} WASM in OPFS, GLiNER2.5-small-v1 through gliner-rs; the weights from .cache/gliner through page.route()`);
    say(`# on their Hub URLs; graphs laid out with d3Force (?test=1, V6); the console's watchdog at ${WATCHDOG_MS / 1000} s`);
    say('# Content is compared through lib/replay.mjs digests of dumps without their (:_Run) nodes (when and how often a');
    say('# document was read); the Node side is web/pipeline.js and web/store.js in this process, as harness/run.mjs runs them.');

    // ---- start ---------------------------------------------------------------------------------------
    say();
    say('## start');
    const resp = await page.goto(url());
    const h = resp.headers();
    const csp = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '');
    say(`page: HTTP ${resp.status()}; no CSP header (as on Pages): ${yes(!h['content-security-policy'], 'no Content-Security-Policy header')}; ` +
      `the <meta> CSP has script-src 'self' 'wasm-unsafe-eval': ${yes(csp.includes("script-src 'self' 'wasm-unsafe-eval'"), 'the page has the production CSP')}; ` +
      `connect-src allows the Hub: ${yes(/connect-src [^;]*https:\/\/huggingface\.co/.test(csp), 'connect-src names huggingface.co')}; ` +
      `no frame-ancestors (ignored in a <meta>): ${yes(!/frame-ancestors/.test(csp), 'no frame-ancestors in the meta CSP')}; COOP/COEP: ${h['cross-origin-opener-policy'] || h['cross-origin-embedder-policy'] ? 'present' : 'none'}`);
    const asset = await page.request.get(`${base}assets/relate-${VER}/relate_bg.wasm`);
    const slashless = await page.request.get(base.replace(/\/$/, ''), { maxRedirects: 0 });
    say(`assets/ served as Pages serves every file (Cache-Control max-age=600, application/wasm): ` +
      `${yes(asset.headers()['cache-control'] === 'max-age=600' && asset.headers()['content-type'] === 'application/wasm', 'the .wasm is served as Pages serves it')}; ` +
      `the page's URL without its trailing slash: HTTP ${slashless.status()} to ${new URL(slashless.headers().location ?? '', base).pathname}: ` +
      `${yes(slashless.status() === 301 && new URL(slashless.headers().location ?? '', base).href === base, 'a 301 to the trailing slash')}`);
    await waitDs(page, 'engine', ['ready', 'failed']);
    say(`engine: ${await ds(page, 'engine')}`);
    await page.waitForFunction(() => document.body.dataset.store, null, { timeout: 60000 });
    say(`store opened: ${await ds(page, 'store')} (${(await text(page, 'store-info')).replace(/^[^:]*: /, '')})`);
    const pageThread = await page.evaluate(async (ver) => {
      const m = await import(new URL(`./assets/relate-${ver}/relate.js`, location.href).href);
      await m.default();
      let msg;
      try {
        const db = await m.RelateDb.open('opfs://ex01-kg-pagethread');
        db.free();
        msg = 'opened';
      } catch (e) {
        msg = String(e?.message ?? e);
      }
      const opfs = await import(new URL('./opfs.js', location.href).href);
      const left = (await opfs.listStores('ex01-kg-pagethread')).length;
      if (left) await opfs.removeStore('ex01-kg-pagethread');
      return { msg, left };
    }, VER);
    say(`OPFS from the page thread (R11): ${firstLine(pageThread.msg)}; store left behind: ${pageThread.left ? 'yes (removed)' : 'none'}`);
    yes(/OPFS needs a dedicated worker/.test(pageThread.msg), 'a page-thread OPFS open is refused (R11)');
    yes(await page.evaluate(async () => (await import(new URL('./graphview.js', location.href).href)).REL_LABEL_AT) === REL_LABEL_AT, 'drive.mjs REL_LABEL_AT = graphview.js REL_LABEL_AT');

    // ---- a first visit: the three steps and the empty graph tab -------------------------------
    say();
    say('## a first visit: the three steps, the empty graph tab, names and keys');
    await page.waitForFunction(() => (document.querySelector('[data-testid="doc-name"]')?.textContent ?? 'none') !== 'none' &&
      document.querySelector('[data-testid="graph-empty"]')?.getAttribute('data-state') === 'load-model', null, { timeout: 60000 }).catch(() => {});
    /** The steps and the graph tab's empty state as they are now. */
    const firstLook = () => page.evaluate(() => {
      const q = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.querySelector(`[data-testid="${id}"]`));
      const t = (/** @type {string} */ id) => (q(id)?.textContent ?? '').trim();
      const sel = /** @type {HTMLSelectElement} */ (q('domain-select'));
      return {
        domain: (sel.selectedOptions[0]?.textContent ?? '').trim(), domains: sel.querySelectorAll('option').length, about: t('domain-about'), status: t('domain-status'),
        load: t('load-model'), extract: t('extract'), extractOff: /** @type {HTMLButtonElement} */ (q('extract')).disabled, hint: t('extract-hint'), doc: t('doc-name'),
        empty: q('graph-empty').hidden ? 'hidden' : q('graph-empty').dataset.state ?? '', emptyTitle: t('graph-empty-title'), emptyText: t('graph-empty-text'),
        emptyButton: q('graph-empty-action').hidden ? '' : t('graph-empty-action'),
      };
    });
    const look0 = await firstLook();
    say(`step 1: ${JSON.stringify(look0.domain)} of ${look0.domains} domains, ${JSON.stringify(look0.about)}; ${JSON.stringify(look0.status)}`);
    say(`step 2: ${JSON.stringify(look0.load)}; step 3: ${JSON.stringify(look0.extract)} ${look0.extractOff ? 'disabled' : 'ENABLED'}, ${JSON.stringify(look0.hint)}; ` +
      `Document: ${JSON.stringify(look0.doc)}: ${yes(look0.extractOff && look0.domains === 27 && look0.doc === 'the Financial Services sample', 'step 3 waits for the model, with the sample ready')}`);
    say(`the graph tab's empty state (${look0.empty}): ${JSON.stringify(look0.emptyTitle)}, ${JSON.stringify(look0.emptyText)} [${look0.emptyButton}]: ` +
      `${yes(look0.empty === 'load-model' && look0.emptyButton === look0.load, 'the empty graph tab says to load the model, with its button')}`);
    const docBox = await page.evaluate(() => ({ box: /** @type {HTMLTextAreaElement} */ (document.querySelector('[data-testid="doc-text"]')).value, doc: /** @type {any} */ (window).ex01.currentDoc() }));
    const sampleText = env.samples.get(SAMPLE).text;
    say(`the Document box on start: ${JSON.stringify(docBox.doc.title)}; it shows the sample without its YAML front matter, which is extracted with it: ` +
      `${yes(!docBox.box.startsWith('---') && sampleText.endsWith(docBox.box) && docBox.doc.text === sampleText, 'the Document box holds the sample, its front matter kept out of sight')}`);
    // Every control has an accessible name (a label, aria-label or aria-labelledby, a button's text or a title).
    const unnamed = await page.evaluate(() => {
      const out = [];
      for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('button, input, select, textarea'))) {
        if (el.hasAttribute('hidden') || /** @type {HTMLInputElement} */ (el).type === 'hidden') continue;
        const by = el.getAttribute('aria-labelledby');
        const labels = /** @type {any} */ (el).labels ? [.../** @type {any} */ (el).labels].map((l) => (l.textContent ?? '').trim()).join(' ') : '';
        const name = el.getAttribute('aria-label') || (by ? (document.getElementById(by)?.textContent ?? '').trim() : '') || labels ||
          (el.tagName === 'BUTTON' ? (el.textContent ?? '').trim() : '') || el.getAttribute('title');
        if (!name) out.push(el.dataset.testid || el.id || el.tagName.toLowerCase());
      }
      return out;
    });
    say(`every control on the page has an accessible name: ${yes(unnamed.length === 0, 'every control is named')}${unnamed.length ? ` (not: ${unnamed.join(', ')})` : ''}`);
    await page.focus(tid('tab-graph'));
    await page.keyboard.press('ArrowRight');
    const keyTab = await page.evaluate(() => ({ selected: /** @type {HTMLElement} */ (document.querySelector('[role="tab"][aria-selected="true"]')).dataset.tab, focused: /** @type {HTMLElement} */ (document.activeElement).dataset.tab }));
    await page.keyboard.press('ArrowLeft');
    const keyBack = await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('[role="tab"][aria-selected="true"]')).dataset.tab);
    say(`the tab list's keys: ArrowRight on Graph selects and focuses ${keyTab.selected} (${keyTab.focused}), ArrowLeft goes back to ${keyBack}: ` +
      `${yes(keyTab.selected === 'review' && keyTab.focused === 'review' && keyBack === 'graph', 'the arrow keys move along the tabs')}`);

    // ---- the model -----------------------------------------------------------------------------------
    say();
    say('## the model (D4, G8)');
    await page.click(tid('load-model'));
    await waitDs(page, 'model', ['ready', 'failed'], 300000);
    say(`load small-v1: ${await ds(page, 'model')}; Hub requests answered from .cache/gliner: ${hub.files} (${hub.ranges} of them byte ranges); other Hub URLs: ${hub.other.length}`);
    yes((await ds(page, 'model')) === 'ready', 'the model loads');
    await page.waitForFunction(() => document.querySelector('[data-testid="graph-empty"]')?.getAttribute('data-state') === 'extract', null, { timeout: 30000 }).catch(() => {});
    const look1 = await firstLook();
    say(`step 2: ${JSON.stringify(look1.load)}; step 3: ${JSON.stringify(look1.extract)} ${look1.extractOff ? 'DISABLED' : 'enabled'}; the empty state (${look1.empty}): ${JSON.stringify(look1.emptyTitle)} [${look1.emptyButton}]: ` +
      `${yes(!look1.extractOff && look1.empty === 'extract' && look1.emptyButton === 'Extract the sample', 'with the model loaded, the empty graph tab offers the extraction')}`);
    note(`model loaded (${secs()})`);

    // ---- the sample -----------------------------------------------------------------------------------
    say();
    say(`## the store: the ${SAMPLE} sample, create-context-graph's format (D7, D9, D16)`);
    {
      const progress = /** @type {string[]} */ ([]);
      // The progress line over the graph while it runs (one per model call; their number is the plan's).
      const watching = page.evaluate(() => new Promise((resolve) => {
        const seen = new Set();
        const el = /** @type {HTMLElement} */ (document.querySelector('[data-testid="graph-progress-text"]'));
        const obs = new MutationObserver(() => { if (el.textContent) seen.add(el.textContent); });
        obs.observe(el, { childList: true, characterData: true, subtree: true });
        const done = () => { obs.disconnect(); resolve([...seen]); };
        const t = setInterval(() => { if (['done', 'failed', 'stopped'].includes(document.body.dataset.extract ?? '')) { clearInterval(t); done(); } }, 50);
      }));
      const r = await extractSample(page, SAMPLE);
      progress.push(.../** @type {string[]} */ (await watching));
      const asked = progress.filter((x) => /asking the model about sentence \d+ of \d+/.test(x));
      // Every progress line counts the sample's sentences as the splitter finds them (the plan asks the model once per sentence).
      const sampleMeta = JSON.parse(fs.readFileSync(path.join(EX, 'data/samples/samples.json'), 'utf8')).find((/** @type {any} */ s) => s.id === SAMPLE);
      const nSentences = splitSentences(fs.readFileSync(path.join(EX, 'data/samples', sampleMeta.file), 'utf8')).length;
      say(`while it ran, the graph tab showed ${JSON.stringify(progress.find((x) => /sentence 1 of/.test(x)) ?? progress[0] ?? '')}, and so on for each model call: ` +
        `${yes(asked.length > 1 && asked.every((x) => new RegExp(` of ${nSentences}\\b`).test(x)), 'the extraction shows its progress over the graph, sentence by sentence')}`);
      say(`${SAMPLE}: ${r.state}; ${r.status}`);
      for (const k of r.kept) say(`  kept ${k}`);
      const want = expectedKept(ONTOLOGY, SAMPLE);
      say(`  the kept facts equal expected/extract.txt's (Node): ${yes(JSON.stringify([...r.kept].sort()) === JSON.stringify(want), `${SAMPLE} kept facts = extract.txt`)}`);
      yes(r.state === 'done', `${SAMPLE} extracts`);
      // After it: the summary line over the graph (the document's share first: the store's only document here, so
      // all of it), and the graph fitted with every node inside and labelled.
      const sum = await summaryLine(page);
      const st0 = await page.evaluate(() => /** @type {any} */ (window).ex01.call('stats'));
      const badge = Number(await text(page, 'review-count') || 0);
      say(`the summary line: ${JSON.stringify(sum.text)} ${sum.buttons.map((b) => `[${b}]`).join(' ')}: ` +
        `${yes(sum.shown && Number(sum.entities) === st0.entities && Number(sum.rels) === st0.facts && Number(sum.review) === badge && badge > 0 &&
          st0.documents.length === 1 && Number(sum.docEntities) === st0.entities && Number(sum.docRels) === st0.facts && Number(sum.docReview) === badge &&
          sum.buttons.join('|') === `Show only this document|Review (${badge}) →`, 'after an extraction, a summary line gives the document\'s share, the graph and the review queue')}`);
      const f0 = await fitted(page, 'graphView');
      say(`the graph tab fitted the new graph: ${f0.nodes} nodes, every one inside the canvas and ${FIT_WORDS}: ` +
        `${yes(fitOk(f0), 'the graph is fitted after an extraction, its nodes and relationships labelled')}`);
    }
    const s0 = splitSentences(env.samples.get(SAMPLE).text)[1].text;
    const rawRows = await consoleCall(page, `MATCH (s:_Sentence)-[:_INFERRED]->(:_Inference)<-[:_OF]-(p:_InferencePart)
WHERE $text IS NOT NULL AND s.text = $text
RETURN p.n AS n, p.text AS text ORDER BY n`, { text: s0 });
    const workerRaw = rawRows.ok ? rawRows.rows.map((/** @type {any} */ r) => r.text).join('') : '';
    const nodeRaw0 = await nodeRaw(ONTOLOGY, s0);
    say(`gliner-rs's raw JSON for ${JSON.stringify(s0)}: the worker's (from the inference cache) is bit-identical to Node's: ` +
      `${yes(workerRaw !== '' && workerRaw === nodeRaw0, 'worker inference = Node inference (G7)')}`);
    note(`sample extracted (${secs()})`);

    // ---- reload ----------------------------------------------------------------------------------------
    say();
    say('## reload (R24, G8)');
    const hubBefore = hub.files;
    await page.reload();
    await waitDs(page, 'engine', ['ready', 'failed']);
    await page.waitForFunction(() => document.body.dataset.store && ['ready', 'failed'].includes(document.body.dataset.model ?? ''), null, { timeout: 120000 }).catch(() => {});
    say(`model: ${await ds(page, 'model')}, from Cache Storage (${yes(/from this browser's cache/.test(await text(page, 'model-status')), 'the model comes from Cache Storage after a reload')}); ` +
      `Hub requests: ${hub.files - hubBefore}`);
    yes(hub.files === hubBefore, 'no Hub request after the reload');
    say(`store reopened: ${await ds(page, 'store')}`);
    const dumpText = /** @type {string} */ ((await page.evaluate(() => /** @type {any} */ (window).ex01.call('dump'))).text);
    const nodeDumpText = await nodeDump('main');
    say(`the store's content equals the Node run's for the ${SAMPLE} sample: ${yes(stableDigest(dumpText) === stableDigest(nodeDumpText), 'browser store = Node store')}`);
    const counts = (/** @type {string} */ t) => {
      const d = replay.parse(t);
      const by = new Map();
      for (const n of d.nodes) for (const l of n.labels) by.set(l, (by.get(l) ?? 0) + 1);
      return [...by].sort((a, b) => replay.cmp(a[0], b[0])).map(([l, n]) => `${l} ${n}`).join(', ');
    };
    say(`  nodes by label: ${counts(dumpText)}`);

    // ---- download and restore -----------------------------------------------------------------------------
    say();
    say('## download and restore (D17, X1-X5)');
    await page.click(tid('tab-store'));
    const [dumpDl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click(tid('download-dump'))]);
    const dumpFile = path.join(work, dumpDl.suggestedFilename());
    await dumpDl.saveAs(dumpFile);
    say(`dump.json downloads: ${dumpDl.suggestedFilename()}; the same content: ${yes(stableDigest(fs.readFileSync(dumpFile, 'utf8')) === stableDigest(dumpText), 'the downloaded dump.json = the worker dump')}`);
    const [tarDl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click(tid('download-db'))]);
    const tarFile = path.join(work, tarDl.suggestedFilename());
    await tarDl.saveAs(tarFile);
    const chk = opfsCheck(tarFile);
    say(`database downloads: ${tarDl.suggestedFilename()}; lib/opfsfmt.py check --snapshot: ${chk.ok ? `ok (a snapshot: ${Object.keys(chk.json.files).join(', ')}, ` +
      `taken after free(), X1; ${(chk.json.ignored ?? []).length} dot entries)` : `FAILED: ${chk.line}`}`);
    yes(chk.ok && Object.keys(chk.json.files).join() === 'graph.json,manifest.json', 'opfsfmt check --snapshot passes on the download, graph.json and manifest.json only');
    const restore = async (/** @type {string} */ file) => {
      const before = await ds(page, 'store');
      await page.click(tid('tab-store'));
      await page.setInputFiles(tid('restore-file'), file);
      await page.waitForFunction((n) => document.body.dataset.store !== n && /-restored-/.test(document.body.dataset.store ?? ''), before, { timeout: 120000 }).catch(() => {});
      await waitDs(page, 'busy', ['0'], 60000);
      const f = await page.$eval(tid('restore-facts'), (e) => ({ name: e.dataset.name ?? '', compare: e.dataset.compare ?? '', text: e.textContent ?? '' })).catch(() => null);
      return { facts: f, store: await ds(page, 'store'), op: await text(page, 'store-op') };
    };
    const backTo = async (/** @type {string} */ name) => {
      await page.selectOption(tid('store-select'), name);
      await page.waitForFunction((n) => document.body.dataset.store === n, name, { timeout: 60000 });
      await waitDs(page, 'busy', ['0'], 60000);
    };
    const r1 = await restore(tarFile);
    say(`restore of the download: ${r1.facts?.name ?? 'none'} (adopted by one writable open, R22, then checked read-only, R15): counts, graph type and content digest against ${STORE}: ${r1.facts?.compare ?? r1.op}; now open: ${r1.store}`);
    yes(r1.facts?.compare === 'equal' && r1.store === r1.facts?.name, 'the restored download equals its source');
    const r1stats = await page.evaluate(() => /** @type {any} */ (window).ex01.call('stats'));
    say(`  the restored store opens writable: ${r1stats.documents.length} documents, ${r1stats.entities} entities, ${r1stats.facts} relationships`);
    await backTo(STORE);
    // X4: a native-made tar (relate clone --to-snapshot-format json, then opfsfmt to-tar: the engine's dot entries skipped).
    const x4 = path.join(work, 'from-native.tar');
    const eng = nativeEngine();
    let x4made = false;
    if (eng) {
      const r = spawnSync(eng.cmd, [...eng.args, path.join(HERE, 'native.py'), 'x4', tarFile, x4], { cwd: EX, encoding: 'utf8', env: { ...process.env, RELATE_TELEMETRY: 'off', RELATE_AGENT_MODE: '0' }, timeout: CHILD_TIMEOUT.native });
      if (r.status === 0) x4made = true;
      else note(`native.py x4 failed (${r.error ? r.error.message : `exit ${r.status}`}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
    }
    if (!x4made) {
      // No 1.2.0 CLI on PATH (or it failed, noted above): the download through opfsfmt to-dir and to-tar, the
      // same restore form X4 produces, but not written by native code. native.txt covers the native side.
      note(`no native clone for the X4 restore input${eng ? '' : ` (no relate on PATH reporting Relate v${VER}, or no uv)`}: using the download re-tarred by lib/opfsfmt.py`);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ex01-x4-'));
      try {
        execFileSync('python3', ['-I', 'lib/opfsfmt.py', 'to-dir', path.relative(ROOT, tarFile), path.join(tmp, 'db')], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], timeout: CHILD_TIMEOUT.check });
        execFileSync('python3', ['-I', 'lib/opfsfmt.py', 'to-tar', path.join(tmp, 'db'), x4], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], timeout: CHILD_TIMEOUT.check });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    const x4chk = opfsCheck(x4);
    yes(x4chk.ok, 'opfsfmt check --snapshot passes on the X4 tar');
    const r2 = await restore(x4);
    say(`restore of the download made native and back (X4: harness/native.py x4: a writable open, clone to .rl, clone ` +
      `--to-snapshot-format json, opfsfmt to-tar): ${r2.facts?.name ?? 'none'}: against ${STORE}: ${r2.facts?.compare ?? r2.op}`);
    yes(r2.facts?.compare === 'equal', 'the native-made tar restores equal');
    await backTo(STORE);
    note(`download and restore done (${secs()})`);

    // ---- re-extract ------------------------------------------------------------------------------------------
    say();
    say('## the same document again (D7, D9)');
    const again = await extractSample(page, SAMPLE);
    say(`${SAMPLE}: ${again.state}; ${again.status}`);
    yes(again.data.inferences === '0' && again.data.skipped === '1', 're-extracting runs 0 inferences');

    // ---- NVL -----------------------------------------------------------------------------------------------
    say();
    say('## the graph tab (NVL, D16, V5-V8)');
    await page.click(tid('tab-graph'));
    await page.click(tid('scope-all'));
    await page.waitForFunction(() => /** @type {any} */ (window).ex01.graphView.counts().nodes > 0 &&
      Number(document.querySelector('[data-testid="graph-counts"]').dataset.nodes) === /** @type {any} */ (window).ex01.graphView.counts().nodes, null, { timeout: 60000 });
    await settled(page, 'graphView');
    const gc = await page.evaluate(() => /** @type {any} */ (window).ex01.graphView.counts());
    const shown = await page.$eval(tid('graph-counts'), (e) => ({ n: Number(e.dataset.nodes), r: Number(e.dataset.rels) }));
    const st = await page.evaluate(() => /** @type {any} */ (window).ex01.call('stats'));
    // Two store switches (the restores and back) and an extraction since the last fit: the tab fitted again when shown.
    const f1 = await fitted(page, 'graphView', 1);
    say(`shown again after the restores and the re-extraction, the graph tab fitted the view (fit ${f1.fits > 1 ? 'again' : 'NOT again'}), every node inside and labelled, each relationship label shown on its midpoint: ` +
      `${yes(f1.fits > 1 && fitOk(f1), 'the graph is fitted again after a store switch')}`);
    say(`NVL holds ${gc.nodes} nodes and ${gc.rels} relationships (${gc.renderer} renderer); the store's typed graph: ${st.entities} entities, ${st.facts} relationships: ` +
      `${yes(gc.nodes === shown.n && gc.rels === shown.r && gc.nodes === st.entities && gc.rels === st.facts && gc.rels > 0, 'NVL counts = the typed graph')}`);
    const pos = await page.evaluate((id) => {
      const nvl = /** @type {any} */ (window).ex01.graphView.nvl;
      const n = nvl.getNodes().find((/** @type {any} */ x) => x.id === id);
      const r = document.querySelector('[data-testid="graph-canvas"]').getBoundingClientRect();
      return n && n.clientPosition ? { x: r.left + n.clientPosition.x, y: r.top + n.clientPosition.y } : null;
    }, CLICK.id);
    if (pos) await page.mouse.click(pos.x, pos.y);
    await page.waitForSelector(tid('evidence-item'), { timeout: 15000 }).catch(() => {});
    const side = await page.$eval(tid('side-panel'), (e) => (e.querySelector('[data-testid="side-title"]')?.textContent ?? '').trim()).catch(() => '');
    const ev = await page.$$eval(tid('evidence-item'), (els) => els.map((e) => (e.querySelector('.meta')?.textContent ?? '').trim()));
    const about = await page.$eval(tid('side-panel'), (e) => ({ kind: (e.querySelector('[data-testid="side-kind"]')?.textContent ?? '').trim(), line: (e.querySelector('.kind-line .hint')?.textContent ?? '').trim(),
      props: Boolean(e.querySelector('[data-testid="side-properties"]:not([open])')), keyShown: /** @type {HTMLElement} */ (e).innerText.includes('Person:DANA_WHITLOCK') }));
    say(`a click on ${CLICK.id} shows ${JSON.stringify(side)}, ${about.kind}, ${JSON.stringify(about.line)}, with ${ev.length} evidence sentence(s):`);
    for (const e of ev) say(`  ${e}`);
    yes(side.startsWith(CLICK.title) && ev.length > 0, 'a node click shows its evidence');
    say(`  its key, generation and document ids only under "Stored properties", collapsed: ${yes(about.kind === 'Person' && about.props && !about.keyShown, 'the side panel keeps the store\'s bookkeeping folded away')}`);
    // Relationship labels and the pointer: a selected node shows its relationships' labels; at a
    // zoom that leaves a kept relationship's line no room for its label, the label shows while the pointer is
    // over the line, on its midpoint, and goes when the pointer leaves.
    const relShown = (/** @type {string} */ id) => page.evaluate((i) => /** @type {any} */ (window).ex01.graphView.labels.get(`r:${i}`)?.el.dataset.shown ?? '', id);
    const selRels = await page.evaluate((id) => {
      const gv = /** @type {any} */ (window).ex01.graphView;
      return [...gv.labels.values()].filter((l) => l.kind === 'rel' && !l.candidate && (l.from === id || l.to === id)).map((l) => ({ type: gv.relData.get(l.id)?.type, shown: l.el.dataset.shown }));
    }, CLICK.id);
    say(`selected, ${CLICK.title}'s relationships show their labels: ${selRels.map((r) => r.type).join(', ') || 'none'}: ` +
      `${yes(selRels.length > 0 && selRels.every((r) => r.shown === '1' || r.shown === 'focus'), 'a selected node shows its relationships\' labels')}`);
    const blank = await page.evaluate(() => {
      const gv = /** @type {any} */ (window).ex01.graphView;
      const box = /** @type {HTMLElement} */ (document.querySelector('[data-testid="graph-canvas"]')).getBoundingClientRect();
      for (const [fx, fy] of [[0.02, 0.02], [0.98, 0.02], [0.02, 0.98], [0.98, 0.98], [0.5, 0.02]]) {
        const x = box.left + box.width * fx;
        const y = box.top + box.height * fy;
        const { nvlTargets } = gv.nvl.getHits(new MouseEvent('click', { clientX: x, clientY: y }));
        if (!nvlTargets.nodes.length && !nvlTargets.relationships.length) return { x, y };
      }
      return null;
    });
    if (blank) await page.mouse.click(blank.x, blank.y); // nothing selected
    await page.evaluate(() => { const nvl = /** @type {any} */ (window).ex01.graphView.nvl; nvl.setZoom(nvl.getScale() * 0.35); });
    await page.waitForTimeout(400);
    const short = await page.evaluate(() => {
      const gv = /** @type {any} */ (window).ex01.graphView;
      const nodes = new Map(gv.nvl.getNodes().map((/** @type {any} */ n) => [n.id, n]));
      const box = /** @type {HTMLElement} */ (document.querySelector('[data-testid="graph-canvas"]')).getBoundingClientRect();
      for (const l of gv.labels.values()) {
        if (l.kind !== 'rel' || l.candidate || l.from === l.to || l.el.dataset.shown !== '0') continue;
        const a = nodes.get(l.from)?.clientPosition;
        const b = nodes.get(l.to)?.clientPosition;
        if (!a || !b) continue;
        const x = box.left + (a.x + b.x) / 2;
        const y = box.top + (a.y + b.y) / 2;
        const { nvlTargets } = gv.nvl.getHits(new MouseEvent('click', { clientX: x, clientY: y }));
        if (!nvlTargets.nodes.length && nvlTargets.relationships[0]?.data.id === l.id) return { id: l.id, type: gv.relData.get(l.id)?.type, x, y, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      }
      return null;
    });
    let hoverOk = false;
    if (short) {
      await page.mouse.move(short.x, short.y);
      await page.waitForFunction((i) => /** @type {any} */ (window).ex01.graphView.labels.get(`r:${i}`)?.el.dataset.shown === 'focus', short.id, { timeout: 5000 }).catch(() => {});
      const on = await page.evaluate(([i, mx, my]) => {
        const gv = /** @type {any} */ (window).ex01.graphView;
        const el = gv.labels.get(`r:${i}`).el;
        const r = el.getBoundingClientRect();
        const o = gv.labelLayer.getBoundingClientRect();
        return { shown: el.dataset.shown, off: Math.hypot(r.left + r.width / 2 - o.left - mx, r.top + r.height / 2 - o.top - my) };
      }, [short.id, short.mx, short.my]);
      if (blank) await page.mouse.move(blank.x, blank.y);
      await page.waitForTimeout(200);
      const off = await relShown(short.id);
      hoverOk = on.shown === 'focus' && on.off <= REL_LABEL_AT && off === '0';
      say(`a kept relationship's label with no room on its line at a smaller zoom (${short.type}): hidden, shown on its midpoint while the pointer is over the line, hidden again when it leaves: ` +
        `${yes(hoverOk, 'a short edge\'s label shows on hover')}`);
    } else {
      say(`a kept relationship's label with no room on its line at a smaller zoom: NONE FOUND: ${yes(false, 'a short edge to hover')}`);
    }
    await page.evaluate(() => /** @type {any} */ (window).ex01.graphView.fit({ animated: false }));
    note(`NVL done (${secs()})`);

    // ---- the ontology tab -------------------------------------------------------------------------------------
    say();
    say('## the ontology tab: the ontology as a picture (NVL) and its v1 document');
    await page.click(tid('tab-ontology'));
    const fo = await fitted(page, 'ontologyView');
    await settled(page, 'ontologyView');
    const oc = await page.evaluate(() => /** @type {any} */ (window).ex01.ontologyView.counts());
    const oPairs = st.ontology.links.reduce((/** @type {number} */ n, /** @type {any} */ l) => n + (l.pairs ?? []).filter((/** @type {string} */ p, /** @type {number} */ i, /** @type {string[]} */ all) => {
      const [a, b] = p.split('|');
      return !(l.symmetric && all.slice(0, i).includes(`${b}|${a}`));
    }).length, 0);
    say(`NVL draws ${oc.nodes} kinds and ${oc.rels} relationships, the store's ${st.ontology.kinds.length} kinds and the ${oPairs} kind pairs its ${st.ontology.links.length} links may join: ` +
      `${yes(oc.nodes === st.ontology.kinds.length && oc.rels === oPairs && oc.rels > 0, 'the ontology tab draws the kinds and links')}; fitted, every kind inside and labelled: ${yes(fitOk(fo), 'the ontology picture is fitted and labelled')}`);
    const oPos = await page.evaluate(() => {
      const nvl = /** @type {any} */ (window).ex01.ontologyView.nvl;
      const n = nvl.getNodes().find((/** @type {any} */ x) => x.id === 'Person');
      const r = /** @type {HTMLElement} */ (document.querySelector('[data-testid="ontology-graph"]')).getBoundingClientRect();
      return n && n.clientPosition ? { x: r.left + n.clientPosition.x, y: r.top + n.clientPosition.y } : null;
    });
    if (oPos) await page.mouse.click(oPos.x, oPos.y);
    await page.waitForFunction(() => (document.querySelector('[data-testid="ontology-side"] [data-testid="side-title"]')?.textContent ?? '') === 'Person', null, { timeout: 15000 }).catch(() => {});
    const oSide = await page.$$eval(`${tid('ontology-side')} p`, (ps) => ps.map((x) => (x.textContent ?? '').trim()));
    say('a click on Person shows:');
    for (const l of oSide) say(`  ${l}`);
    yes(oSide.some((l) => /^Asked of the model as "person"/.test(l)) && oSide.some((l) => /^Its cutoffs: keeps at p ≥ /.test(l)), 'a kind click shows what it is asked and its cutoffs');

    // ---- the console ----------------------------------------------------------------------------------------
    say();
    say(`## the console: a read-only lease of the live store (D11, R15)`);
    const q1 = await consoleUi(page, '', { saved: '01-typed-graph.cypher' });
    await page.waitForFunction(() => /** @type {any} */ (window).ex01.consoleView.counts().nodes > 0, null, { timeout: 30000 }).catch(() => {});
    await settled(page, 'consoleView');
    const cv = await page.evaluate(() => /** @type {any} */ (window).ex01.consoleView.counts());
    // The paths' nodes are the relationships' ends: entities with no kept relationship are not in them.
    const ends = await consoleCall(page, 'MATCH (a:_Entity)-[]->(b:_Entity) UNWIND [a.key, b.key] AS k RETURN count(DISTINCT k) AS n');
    const nEnds = ends.ok ? ends.rows[0].n : -1;
    say(`01-typed-graph.cypher: ${q1.code}, ${q1.rows} rows; NVL draws ${cv.nodes} nodes and ${cv.rels} relationships from the paths ` +
      `(the typed graph's relationships and their ${nEnds} end entities): ` +
      `${yes(q1.code === 'ok' && q1.rows === st.facts && cv.rels === st.facts && cv.nodes === nEnds, 'the console query rows and NVL counts match the typed graph')}`);
    const table = await page.$$eval(`${tid('console-table')} tbody tr`, (trs) => trs.map((tr) => [...tr.querySelectorAll('td')].slice(1).map((td) => (td.textContent ?? '').trim()).join(' | ')));
    for (const r of table) say(`  ${r}`);
    // "Hide the example's bookkeeping" starts unchecked (every row shows). The ontology layer is content, not
    // bookkeeping: with the toggle checked, query 05's rows all still show, and NVL draws the ontology graph.
    const hideDefault = await page.$eval(tid('console-hide-bookkeeping'), (e) => /** @type {HTMLInputElement} */ (e).checked);
    const hideStored = await page.evaluate(() => { try { return localStorage.getItem('ex01.consoleHideBookkeeping'); } catch { return 'unreadable'; } });
    say(`"Hide the example's bookkeeping" on a first visit: ${hideDefault ? 'CHECKED' : 'unchecked'} (ex01.consoleHideBookkeeping ${hideStored === null ? 'absent' : `= ${hideStored}`}): ` +
      `${yes(!hideDefault && hideStored === null, "the console shows the example's bookkeeping by default")}`);
    const q5 = await consoleUi(page, '', { saved: '05-ontology-graph.cypher' });
    await page.waitForFunction(() => /** @type {any} */ (window).ex01.consoleView.counts().nodes > 0, null, { timeout: 30000 }).catch(() => {});
    await settled(page, 'consoleView');
    await page.click(tid('console-hide-bookkeeping'));
    await page.waitForFunction(() => /** @type {HTMLElement} */ (document.querySelector('[data-testid="console-hidden"]')).dataset.hidden !== undefined, null, { timeout: 10000 }).catch(() => {});
    await settled(page, 'consoleView');
    const cv5 = await page.evaluate(() => /** @type {any} */ (window).ex01.consoleView.counts());
    const h5 = await page.$eval(tid('console-hidden'), (e) => ({ n: Number(/** @type {HTMLElement} */ (e).dataset.hidden ?? -1), text: (e.textContent ?? '').trim() }));
    const shown5 = (await page.$$(`${tid('console-table')} tbody tr`)).length;
    const hide5 = await page.$eval(tid('console-hide-bookkeeping'), (e) => /** @type {HTMLInputElement} */ (e).checked);
    const layer = await consoleCall(page, 'MATCH (l:_LinkType)-[x:_DOMAIN|_RANGE]->(k:_Kind) UNWIND [l, k] AS y RETURN count(DISTINCT x) AS rels, count(DISTINCT y) AS nodes');
    const lay = layer.ok ? layer.rows[0] : { rels: -1, nodes: -1 };
    say(`05-ontology-graph.cypher with "Hide the example's bookkeeping" ${hide5 ? 'checked' : 'NOT CHECKED'}: ${q5.code}, ${q5.rows} rows; the table shows ${shown5} (${JSON.stringify(h5.text)}); ` +
      `NVL draws ${cv5.nodes} nodes and ${cv5.rels} relationships (the store's ${lay.nodes} _LinkType and _Kind nodes on a _DOMAIN or _RANGE edge, and its ${lay.rels} edges): ` +
      `${yes(hide5 && q5.code === 'ok' && q5.rows > 0 && shown5 === q5.rows && h5.n === 0 && cv5.nodes === lay.nodes && cv5.rels === lay.rels, "the ontology layer shows with the bookkeeping hidden")}`);
    await page.click(tid('console-hide-bookkeeping'));
    const hide5after = await page.$eval(tid('console-hide-bookkeeping'), (e) => /** @type {HTMLInputElement} */ (e).checked);
    yes(!hide5after, 'the toggle unchecked again after query 05');
    const d0 = (await page.evaluate(() => /** @type {any} */ (window).ex01.call('digest'))).digest;
    const qc = await consoleUi(page, "CREATE (:Probe {name: 'x'}) RETURN 1 AS one");
    const d1 = (await page.evaluate(() => /** @type {any} */ (window).ex01.call('digest'))).digest;
    say(`a CREATE typed into the console: ${qc.code}/${qc.category}: ${firstLine(qc.text).replace(/^readonly: /, '')}; the store's content digest unchanged: ${yes(d0 === d1, 'a refused console write leaves the store unchanged')}`);
    yes(qc.category === 'readonly' && /read.only/.test(qc.text), 'a console CREATE is refused as read-only');
    for (const [label, q] of [
      ['SET on matched entities', 'MATCH (e:_Entity) SET e.probe = 1 RETURN count(e) AS n'],
      ['DETACH DELETE of matched entities', 'MATCH (e:_Entity) DETACH DELETE e'],
      [`an illegal typed edge, ${ILLEGAL.label}`, ILLEGAL.query],
    ]) {
      const r = await consoleCall(page, q);
      say(`${label}: ${r.ok ? `ok, ${r.rows.length} rows` : `${r.category}: ${firstLine(r.message)}`}`);
    }
    const ill = await consoleCall(page, ILLEGAL.query);
    yes(!ill.ok && /ConstraintValidationFailed/.test(ill.message), 'the graph type refuses an illegal edge before the read-only check (R15)');
    const d2 = (await page.evaluate(() => /** @type {any} */ (window).ex01.call('digest'))).digest;
    say(`  the store's content digest unchanged after all three: ${yes(d0 === d2, 'refused writes leave the store unchanged')}`);
    // The read-only open itself writes nothing (R15), and a read-only handle and the writer exclude each other (R11).
    const ro = await page.evaluate(async () => {
      const name = document.body.dataset.store;
      const hex = (/** @type {ArrayBuffer} */ b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
      const files = async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await (await root.getDirectoryHandle('relate')).getDirectoryHandle(name);
        const out = [];
        // @ts-ignore
        for await (const [n, h] of dir.entries()) {
          if (h.kind === 'file') out.push(`${n} ${hex(await crypto.subtle.digest('SHA-256', await (await h.getFile()).arrayBuffer()))}`);
        }
        return out.sort();
      };
      const worker = () => {
        const wk = new Worker(new URL('./console.js', location.href), { type: 'module' });
        let id = 0;
        const ask = (/** @type {any} */ m) => new Promise((resolve) => { wk.onmessage = (e) => resolve(e.data); wk.postMessage({ id: ++id, ...m }); });
        return { ask, end: () => wk.terminate() };
      };
      const c1 = worker();
      await c1.ask({ kind: 'init' });
      const held = await c1.ask({ kind: 'query', uri: `opfs://${name}`, query: 'MATCH (n) RETURN count(n) AS n' });
      c1.end();
      // @ts-ignore
      const lease = await window.ex01.call('lend');
      let before = [];
      let after = [];
      let r = null;
      try {
        before = await files();
        const c2 = worker();
        await c2.ask({ kind: 'init' });
        r = await c2.ask({ kind: 'query', uri: lease.uri, query: 'MATCH (n) RETURN count(n) AS n' });
        c2.end();
        after = await files();
      } finally {
        // @ts-ignore
        await window.ex01.call('reclaim');
      }
      return { held: held.ok ? 'opened' : `${held.error.category}: ${String(held.error.message).split('\n')[0]}`, files: before.length, same: JSON.stringify(before) === JSON.stringify(after), ok: Boolean(r?.ok) };
    });
    say(`a read-only open while the engine holds the store: ${ro.held.replace(/opfs:\/\/\S+/, 'opfs://<store>')}`);
    yes(/storage locked: opfs:\/\//.test(ro.held), 'a read-only open is refused while the writer holds the store (R11, R15)');
    say(`a read-only open of the lent store leaves its ${ro.files} OPFS files byte-identical: ${yes(ro.ok && ro.same, 'a read-only open writes nothing (R15)')}`);
    // The watchdog, and an extraction queued behind the lease (D11).
    // Hedged ("may"), so its two claims wait in review (rule 5's hedge cap), each alone between two new entities: the
    // review candidate the graph tab clicks below (the sample's own candidates share their pair with a kept edge).
    const newSentence = 'Nadia Okoro may work for Halvorsen Pryce Wealth in Glasgow.';
    const wd = await page.evaluate(async ([slow, s, wait]) => {
      const ex = /** @type {any} */ (window).ex01;
      const order = [];
      const c = ex.runConsole(slow).then((/** @type {any} */ r) => { order.push(`console ${r.ok ? 'ok' : r.error?.code}`); return r; });
      await new Promise((r) => setTimeout(r, wait));
      const x = ex.call('extract', { text: s, title: 'queued' }).then((/** @type {any} */ r) => { order.push('extraction'); return r; });
      const [cr, xr] = await Promise.all([c, x]);
      return { order, console: String(cr.error?.message ?? ''), inferences: xr.counters.inferences, status: xr.counters.status };
    }, ['UNWIND range(1, 30000) AS a UNWIND range(1, 30000) AS b RETURN count(*) AS n', newSentence, 1000]);
    say(`an unbounded query: ${wd.order[0] ?? 'nothing'} (${wd.console.replace(/ after [\d.]+ s,/, ',')})`);
    say(`an extraction queued during that lease ran after it: ${yes(wd.order.join(',') === 'console watchdog,extraction', 'the queued extraction runs after the lease')} (${wd.status}, ${wd.inferences} inference)`);
    const after = await consoleCall(page, 'MATCH (d:_Document) RETURN count(d) AS n');
    say(`the engine took the store back and the console works again: ${yes(after.ok, 'the console works after the watchdog')} (${after.ok ? after.rows[0].n : '?'} documents)`);
    const qRaw = await consoleCall(page, `MATCH (s:_Sentence)-[:_INFERRED]->(:_Inference)<-[:_OF]-(p:_InferencePart)
WHERE $text IS NOT NULL AND s.text = $text
RETURN p.n AS n, p.text AS text ORDER BY n`, { text: newSentence });
    const raw2 = qRaw.ok ? qRaw.rows.map((/** @type {any} */ r) => r.text).join('') : '';
    say(`its inference (the model from Cache Storage) is bit-identical to Node's: ${yes(raw2 !== '' && raw2 === await nodeRaw(ONTOLOGY, newSentence), 'the reloaded model infers as Node does')}`);
    note(`console done (${secs()})`);

    // ---- review candidates in the graph tab ---------------------------------------------------------------------
    say();
    say('## review candidates in the graph tab: drawn faded beside the kept graph, decided from the side panel');
    await page.click(tid('tab-graph'));
    await page.click(tid('scope-all'));
    const candDefault = await page.isChecked(tid('show-candidates'));
    /** The graph tab shows what its counts line says, kept and candidates apart (graphview.js counts()). */
    const graphSync = () => page.waitForFunction(() => {
      const c = /** @type {any} */ (window).ex01.graphView.counts();
      const e = /** @type {HTMLElement} */ (document.querySelector('[data-testid="graph-counts"]')).dataset;
      return !c.pending && c.nodes === Number(e.nodes) && c.rels === Number(e.rels) &&
        c.candidates.nodes === Number(e.candidateNodes ?? -1) && c.candidates.rels === Number(e.candidateRels ?? -1);
    }, null, { timeout: 60000 });
    await page.evaluate(() => /** @type {any} */ (window).ex01.refreshGraph());
    await graphSync();
    await settled(page, 'graphView');
    const cg0 = await page.evaluate(() => /** @type {any} */ (window).ex01.graphView.counts());
    const cst0 = await page.evaluate(() => /** @type {any} */ (window).ex01.call('stats'));
    say(`"Show review candidates" is on by default: ${yes(candDefault, 'the candidates toggle defaults to on')}; NVL holds the typed graph's ${cg0.nodes} entities and ${cg0.rels} relationships ` +
      `(the store's: ${cst0.entities} and ${cst0.facts}: ${yes(cg0.nodes === cst0.entities && cg0.rels === cst0.facts, 'kept counts are the typed graph with candidates drawn')}) ` +
      `and review candidates: ${cg0.candidates.nodes} entities, ${cg0.candidates.rels} relationships`);
    yes(cg0.candidates.rels > 0, 'the financial-services sample has review candidates to draw');
    const look = await page.evaluate(([keptSize, candSize]) => {
      const gv = /** @type {any} */ (window).ex01.graphView;
      // The captions are the view's labels (graphview.js): `n:<id>` for a node, `r:<id>` for a relationship.
      const label = (/** @type {string} */ key) => gv.labels.get(key)?.el;
      const isC = (/** @type {any} */ map, /** @type {any} */ x) => map.get(x.id)?.candidate === true;
      const ns = gv.nvl.getNodes();
      const rs = gv.nvl.getRelationships();
      const labelled = [...ns.map((/** @type {any} */ n) => [`n:${n.id}`, isC(gv.nodeData, n)]), ...rs.filter((/** @type {any} */ r) => r.from !== r.to).map((/** @type {any} */ r) => [`r:${r.id}`, isC(gv.relData, r)])];
      const cr = rs.filter((/** @type {any} */ r) => isC(gv.relData, r));
      const kr = rs.filter((/** @type {any} */ r) => !isC(gv.relData, r));
      return {
        // A candidate's node label ends " (review)", its relationship's is the bare type; both italic.
        captions: labelled.every(([key, c]) => {
          const el = label(key);
          const t = el?.textContent ?? '';
          const italic = el ? getComputedStyle(el).fontStyle === 'italic' : false;
          const rel = key.startsWith('r:');
          return el && (c ? italic && (rel ? !t.endsWith(' (review)') && t === gv.relData.get(key.slice(2))?.type : t.endsWith(' (review)')) : !italic && !t.endsWith(' (review)'));
        }) && ns.every((/** @type {any} */ n) => !n.caption && !n.captions),
        rels: cr.every((/** @type {any} */ r) => kr.every((/** @type {any} */ k) => r.width < k.width && k.color !== r.color)),
        nodes: ns.every((/** @type {any} */ n) => n.size === (isC(gv.nodeData, n) ? candSize : keptSize)) && candSize < keptSize,
      };
    }, [NODE_SIZE, CANDIDATE_SIZE]);
    say(`candidates are drawn apart: italic labels, a node's ending " (review)" and a relationship's its bare type (kept ones upright; NVL draws no caption of its own): ${yes(look.captions, 'candidate captions')}; ` +
      `thinner, lighter relationships: ${yes(look.rels, 'candidate relationships thinner and lighter')}; smaller, faded nodes: ${yes(look.nodes, 'candidate nodes smaller')}`);
    // The highest-scoring candidate relationship alone between its two entities (a straight line), clicked
    // where NVL's own hit test finds it and no node.
    const target = await page.evaluate(() => {
      const gv = /** @type {any} */ (window).ex01.graphView;
      const rs = gv.nvl.getRelationships();
      const pair = (/** @type {any} */ r) => [r.from, r.to].sort().join('\u0000');
      const per = new Map();
      for (const r of rs) per.set(pair(r), (per.get(pair(r)) ?? 0) + 1);
      const c = rs.filter((/** @type {any} */ r) => gv.relData.get(r.id)?.candidate === true && r.from !== r.to && per.get(pair(r)) === 1)
        .map((/** @type {any} */ r) => ({ id: r.id, from: r.from, to: r.to, type: gv.relData.get(r.id).type, p: gv.relData.get(r.id).properties.p }))
        .sort((/** @type {any} */ a, /** @type {any} */ b) => b.p - a.p || (a.id < b.id ? -1 : 1));
      return c[0] ?? null;
    });
    const hit = target ? await page.evaluate((t) => {
      const nvl = /** @type {any} */ (window).ex01.graphView.nvl;
      const nodes = new Map(nvl.getNodes().map((/** @type {any} */ n) => [n.id, n]));
      const box = /** @type {HTMLElement} */ (document.querySelector('[data-testid="graph-canvas"]')).getBoundingClientRect();
      const a = nodes.get(t.from)?.clientPosition;
      const b = nodes.get(t.to)?.clientPosition;
      if (!a || !b) return null;
      for (const f of [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7]) {
        const x = box.left + a.x + (b.x - a.x) * f;
        const y = box.top + a.y + (b.y - a.y) * f;
        const { nvlTargets } = nvl.getHits(new MouseEvent('click', { clientX: x, clientY: y }));
        if (!nvlTargets.nodes.length && nvlTargets.relationships[0]?.data.id === t.id) return { x, y };
      }
      return null;
    }, target) : null;
    if (hit) await page.mouse.click(hit.x, hit.y);
    await page.waitForSelector(tid('candidate-item'), { timeout: 15000 }).catch(() => {});
    const item = await page.$eval(tid('candidate-item'), (e) => ({
      what: (e.querySelector('.what')?.firstChild?.textContent ?? '').trim(), band: e.dataset.band, rule: e.dataset.rule,
      why: (e.querySelector('[data-testid="why"]')?.textContent ?? '').trim(), sentence: (e.querySelector('.sentence')?.textContent ?? '').trim(),
      buttons: Boolean(e.querySelector('[data-testid="accept"]') && e.querySelector('[data-testid="reject"]')),
    })).catch(() => null);
    say(`a click on the candidate ${target ? `${target.from} -[${target.type}]-> ${target.to}` : 'NONE'} (the highest-scoring one alone between its two entities) shows: ` +
      `${item ? `${item.what}, ${item.band} by ${item.rule}` : 'NOTHING'}`);
    say(`  why: ${item?.why ?? ''}`);
    say(`  evidence: ${JSON.stringify(item?.sentence ?? '')}`);
    yes(Boolean(item && item.band === 'review' && item.why && item.sentence && item.buttons), 'a candidate click shows its band, rule, evidence, Accept and Reject');
    await page.click(`${tid('candidate-item')} ${tid('accept')}`).catch(() => {});
    await page.waitForSelector(tid('candidate-done'), { timeout: 60000 }).catch(() => {});
    await waitDs(page, 'busy', ['0'], 60000);
    await graphSync();
    await settled(page, 'graphView');
    const cg1 = await page.evaluate(() => /** @type {any} */ (window).ex01.graphView.counts());
    const cst1 = await page.evaluate(() => /** @type {any} */ (window).ex01.call('stats'));
    const pub = target ? await page.evaluate((t) => {
      const gv = /** @type {any} */ (window).ex01.graphView;
      return gv.nvl.getRelationships().some((/** @type {any} */ r) => r.id === `${t.from}|${t.type}|${t.to}` && gv.relData.get(r.id)?.candidate !== true);
    }, target) : false;
    const done = await page.$eval(tid('candidate-done'), (e) => (e.textContent ?? '').trim()).catch(() => '');
    say(`Accept: ${done || 'no answer'}`);
    say(`  drawn as a kept relationship, ${target ? `${target.from}|${target.type}|${target.to}` : '?'}: ${yes(pub, 'the accepted candidate is a published, kept edge')}`);
    say(`  the kept graph: ${cg0.nodes} -> ${cg1.nodes} entities, ${cg0.rels} -> ${cg1.rels} relationships (the store's: ${cst1.entities}, ${cst1.facts}); ` +
      `candidates: ${cg0.candidates.nodes} -> ${cg1.candidates.nodes} entities, ${cg0.candidates.rels} -> ${cg1.candidates.rels} relationships: ` +
      `${yes(cg1.rels === cg0.rels + 1 && cg1.nodes === cst1.entities && cg1.rels === cst1.facts && cg1.candidates.rels === cg0.candidates.rels - 1, 'accepting a candidate moves it to the kept counts')}`);
    /** The counts line after the toggle's redraw: its candidates are 0 (off) or not (on). @param {boolean} on */
    const toggled = (on) => page.waitForFunction((x) => {
      const e = /** @type {HTMLElement} */ (document.querySelector('[data-testid="graph-counts"]')).dataset;
      return x ? Number(e.candidateRels) > 0 : e.candidateRels === '0' && e.candidateNodes === '0';
    }, on, { timeout: 60000 });
    await page.click(tid('show-candidates'));
    await toggled(false);
    await graphSync();
    const cg2 = await page.evaluate(() => /** @type {any} */ (window).ex01.graphView.counts());
    const remembered = await page.evaluate(() => { try { return localStorage.getItem('ex01.graphCandidates'); } catch { return null; } });
    say(`"Show review candidates" off: candidates ${cg2.candidates.nodes} and ${cg2.candidates.rels}, the kept graph ${cg2.nodes} and ${cg2.rels}; remembered as ex01.graphCandidates = ${remembered}: ` +
      `${yes(cg2.candidates.nodes === 0 && cg2.candidates.rels === 0 && cg2.nodes === cg1.nodes && cg2.rels === cg1.rels && remembered === '0', 'the candidates toggle hides them and is remembered')}`);
    await page.click(tid('show-candidates'));
    await toggled(true);
    await graphSync();
    note(`graph candidates done (${secs()})`);

    // ---- the ontology's tools ------------------------------------------------------------------------------------
    say();
    say("## the ontology's tools in the console (Ontology Graph Spec v1 `tools`): listed with their notes, run, refused, run from the side panel");
    await page.click(tid('tab-console'));
    // "Ontology tools" sits under the results, collapsed: its summary counts them.
    const toolsShut = await page.$eval(tid('tools-box'), (e) => ({ open: /** @type {HTMLDetailsElement} */ (e).open, summary: (e.querySelector('summary')?.textContent ?? '').trim(),
      afterEditor: Boolean(document.querySelector('[data-testid="console-input"]')?.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) }));
    say(`the console tab: the editor first, "${toolsShut.summary}" ${toolsShut.open ? 'OPEN' : 'collapsed'} below the results: ${yes(!toolsShut.open && toolsShut.afterEditor, 'the ontology tools are collapsed under the editor')}`);
    await page.click(`${tid('tools-box')} > summary`);
    // The notes are drawn again once the console worker reports SHOW PROCEDURES (console.js init).
    await page.waitForFunction(() => /** @type {any} */ (window).ex01.state.procedures !== null && document.querySelectorAll('[data-testid="tool"]').length > 0, null, { timeout: 60000 });
    const tOnto = env.ontologies.get(ONTOLOGY);
    const tListed = await page.$$eval(tid('tool-group'), (gs) => gs.map((g) => ({
      anchor: /** @type {HTMLElement} */ (g).dataset.anchor ?? '',
      tools: [...g.querySelectorAll('[data-testid="tool"]')].map((t) => ({
        name: /** @type {HTMLElement} */ (t).dataset.tool ?? '', predict: /** @type {HTMLElement} */ (t).dataset.predict ?? '',
        note: (t.querySelector('[data-testid="tool-compat"]')?.textContent ?? '').trim(),
      })),
    })));
    const tFlat = tListed.flatMap((g) => g.tools.map((t) => ({ ...t, anchor: g.anchor })));
    const tDocTools = tOnto.tools.map((/** @type {any} */ t) => `${t.anchor.label}/${t.name}`);
    say(`the tools section lists ${tFlat.length} tools of the ${ONTOLOGY} document, by node: ${tListed.map((g) => `${g.anchor} (${g.tools.map((t) => t.name).join(', ')})`).join('; ')}: ` +
      `${yes(JSON.stringify(tFlat.map((t) => `${t.anchor}/${t.name}`)) === JSON.stringify(tDocTools), "the tools section lists the document's tools in order")}`);
    // The page's notes against web/console.js toolCompat in Node, with this engine's SHOW PROCEDURES.
    const tProbe = new env.mod.RelateDb();
    const tProcs = cl.exec(tProbe, 'SHOW PROCEDURES YIELD name RETURN name ORDER BY name').rows.map((/** @type {any} */ r) => String(r.name));
    tProbe.free();
    const tCtx = { kinds: tOnto.types, links: tOnto.relations, procedures: tProcs, indexes: storeIndexNames(store.LOOKUP_INDEXES, [...store.STORE_CONSTRAINTS, ...ONTOLOGY_CONSTRAINTS, store.STORE_FULLTEXT]) };
    for (const t of tFlat) say(`  ${t.anchor} ${t.name} [${t.predict}]: ${t.note}`);
    say(`  each note equals web/console.js toolCompat's in Node: ${yes(tFlat.every((t, i) => t.note === toolCompat(tOnto.tools[i], tCtx).text), "the page's tool notes = Node's")}`);
    /** One tool card, by anchor and name. @param {string} anchor @param {string} name */
    const tCard = (anchor, name) => `${tid('tool-group')}[data-anchor="${anchor}"] ${tid('tool')}[data-tool="${name}"]`;
    /** Open a card, run it with its inputs as they are, and wait for its status. */
    const tRunCard = async (/** @type {string} */ anchor, /** @type {string} */ name) => {
      await page.$eval(tCard(anchor, name), (e) => {
        /** @type {HTMLDetailsElement} */ (e).open = true;
        delete /** @type {HTMLElement} */ (e.querySelector('[data-testid="tool-status"]')).dataset.code;
      });
      await page.click(`${tCard(anchor, name)} ${tid('tool-run')}`);
      await page.waitForFunction((sel) => /** @type {HTMLElement} */ (document.querySelector(`${sel} [data-testid="tool-status"]`)).dataset.code, tCard(anchor, name), { timeout: 60000 });
      return page.$eval(`${tCard(anchor, name)} ${tid('tool-status')}`, (e) => ({ code: e.dataset.code ?? '', rows: Number(e.dataset.rows ?? -1), refused: e.dataset.refused ?? '', text: (e.textContent ?? '').trim() }));
    };
    const tDv = tOnto.tools.find((/** @type {any} */ t) => t.name === 'defaultView');
    const tHideBefore = await page.$eval(tid('console-hide-bookkeeping'), (e) => /** @type {HTMLInputElement} */ (e).checked);
    const tr0 = await tRunCard(tDv.anchor.label, 'defaultView');
    await page.waitForFunction(() => /** @type {any} */ (window).ex01.consoleView.counts().nodes > 0, null, { timeout: 30000 }).catch(() => {});
    await settled(page, 'consoleView');
    /** The console's table rows, the hidden-rows line and NVL's counts, as they are now. */
    const tShownNow = async () => ({
      rows: (await page.$$(`${tid('console-table')} tbody tr`)).length,
      hidden: await page.$eval(tid('console-hidden'), (e) => ({ n: Number(/** @type {HTMLElement} */ (e).dataset.hidden ?? -1), text: (e.textContent ?? '').trim() })),
      cv: await page.evaluate(() => /** @type {any} */ (window).ex01.consoleView.counts()),
    });
    const tOff = await tShownNow();
    const tEditor = await page.$eval(tid('console-input'), (e) => /** @type {HTMLTextAreaElement} */ (e).value);
    say(`Run ${tDv.anchor.label}'s defaultView, ${JSON.stringify(tDv.cypher.trim())}: ${tr0.code}, ${tr0.rows} rows (lease, read-only); the editor holds the tool's query: ` +
      `${yes(tr0.code === 'ok' && tr0.rows > 0 && tEditor === tDv.cypher.trim(), 'a tool run returns rows')}`);
    say(`  "Hide the example's bookkeeping" ${tHideBefore ? 'CHECKED' : 'unchecked'} (the default): the table shows ${tOff.rows} rows, ${JSON.stringify(tOff.hidden.text)}; NVL draws ${tOff.cv.nodes} nodes and ` +
      `${tOff.cv.rels} relationships: ${yes(!tHideBefore && tOff.rows === tr0.rows && tOff.hidden.n === 0 && tOff.cv.nodes > 0 && tOff.cv.rels > 0, "the console shows every row by default")}`);
    await page.click(tid('console-hide-bookkeeping'));
    await page.waitForFunction(() => /** @type {HTMLElement} */ (document.querySelector('[data-testid="console-hidden"]')).dataset.hidden !== '0', null, { timeout: 10000 }).catch(() => {});
    await settled(page, 'consoleView');
    const tOn = await tShownNow();
    const tRemembered = await page.evaluate(() => { try { return localStorage.getItem('ex01.consoleHideBookkeeping'); } catch { return null; } });
    say(`  checked: the table shows ${tOn.rows} rows, ${JSON.stringify(tOn.hidden.text)}; NVL draws ${tOn.cv.nodes} nodes and ${tOn.cv.rels} relationships; ` +
      `remembered as ex01.consoleHideBookkeeping = ${tRemembered}: ${yes(tOn.hidden.n > 0 && tOn.rows + tOn.hidden.n === tr0.rows && tOn.cv.nodes > 0 && tOn.cv.rels > 0 &&
        tOn.cv.nodes < tOff.cv.nodes && tOn.cv.rels < tOff.cv.rels && tRemembered === '1', "the toggle hides the example's bookkeeping, undrawn too, and is remembered")}`);
    await page.click(tid('console-hide-bookkeeping'));
    await page.waitForFunction(() => /** @type {HTMLElement} */ (document.querySelector('[data-testid="console-hidden"]')).dataset.hidden === '0', null, { timeout: 10000 }).catch(() => {});
    await settled(page, 'consoleView');
    const tCols = await page.$$eval(`${tid('console-table')} thead th`, (ths) => ths.map((x) => (x.textContent ?? '').trim()));
    say(`  the console's table columns: ${tCols.join(', ')}`);
    // The editor's line about the loaded tool holds only while the editor holds its query unchanged.
    const tDoc0 = await text(page, 'query-doc');
    await page.fill(tid('console-input'), `${tDv.cypher.trim()} `.replace('LIMIT 100', 'LIMIT 5'));
    const tDoc1 = await text(page, 'query-doc');
    await page.fill(tid('console-input'), tDv.cypher.trim());
    const tDoc2 = await text(page, 'query-doc');
    say(`the editor's line about the tool: ${JSON.stringify(tDoc0.slice(0, 40))}…; once the query is edited: ${JSON.stringify(tDoc1)}; edited back: the tool's line again: ` +
      `${yes(tDoc0.startsWith('Tool defaultView on Person') && tDoc1.startsWith('Edited from the tool defaultView') && tDoc2 === tDoc0, "an edited tool query loses the tool's description")}`);
    // A STRING parameter read only through toInteger() takes a whole number of 0 or more, checked before any query.
    const tLa = tOnto.tools.find((/** @type {any} */ t) => t.name === 'list_accounts');
    const tSentL = await page.evaluate(() => /** @type {any} */ (window).ex01.state.consoleQueries);
    const tLimits = [];
    for (const v of ['2.7', '-1']) {
      await page.$eval(`${tCard(tLa.anchor.label, 'list_accounts')} [data-name="limit"]`, (e, x) => { /** @type {HTMLInputElement} */ (e).value = x; }, v);
      const r = await tRunCard(tLa.anchor.label, 'list_accounts');
      tLimits.push(`${JSON.stringify(v)} ${r.code}: ${r.text}`);
    }
    const tSentL2 = await page.evaluate(() => /** @type {any} */ (window).ex01.state.consoleQueries);
    for (const l of tLimits) say(`Run list_accounts with $limit = ${l}`);
    await page.$eval(`${tCard(tLa.anchor.label, 'list_accounts')} [data-name="limit"]`, (e) => { /** @type {HTMLInputElement} */ (e).value = '10'; });
    say(`  queries sent to the console worker: ${tSentL2 - tSentL}: ${yes(tLimits.every((l) => / refused: /.test(l)) && tSentL2 === tSentL, 'a non-integer or negative $limit is refused before any query')}`);
    const tSent0 = await page.evaluate(() => /** @type {any} */ (window).ex01.state.consoleQueries);
    await page.$eval(`${tCard('Person', 'search_customer')} [data-name="query"]`, (e) => { /** @type {HTMLInputElement} */ (e).value = ''; });
    const tr1 = await tRunCard('Person', 'search_customer');
    const tSent1 = await page.evaluate(() => /** @type {any} */ (window).ex01.state.consoleQueries);
    say(`Run search_customer with $query empty: ${tr1.code} (${tr1.refused}): ${tr1.text}`);
    say(`  queries sent to the console worker: ${tSent1 - tSent0}: ${yes(tr1.code === 'refused' && tr1.refused === 'query' && tSent1 === tSent0, 'a tool run with a missing required parameter is refused before any query')}`);
    // The graph tab's side panel: a Person's tools, and a run prefilled with its name.
    await page.click(tid('tab-graph'));
    await settled(page, 'graphView');
    const tPos = await page.evaluate((id) => {
      const nvl = /** @type {any} */ (window).ex01.graphView.nvl;
      const n = nvl.getNodes().find((/** @type {any} */ x) => x.id === id);
      const r = document.querySelector('[data-testid="graph-canvas"]').getBoundingClientRect();
      return n && n.clientPosition ? { x: r.left + n.clientPosition.x, y: r.top + n.clientPosition.y } : null;
    }, CLICK.id);
    if (tPos) await page.mouse.click(tPos.x, tPos.y);
    await page.waitForSelector(tid('side-tools'), { timeout: 15000 }).catch(() => {});
    const tSide = await page.$$eval(tid('side-tool'), (els) => els.map((e) => ({
      name: /** @type {HTMLElement} */ (e).dataset.tool ?? '', run: (e.querySelector('[data-testid="side-tool-run"]')?.textContent ?? '').trim(),
    })));
    const tPerson = tOnto.tools.filter((/** @type {any} */ t) => t.anchor.label === 'Person').map((/** @type {any} */ t) => t.name);
    say(`a click on ${CLICK.id} lists Person's tools in the side panel: ${tSide.map((x) => `${x.name} [${x.run}]`).join(', ')}: ` +
      `${yes(JSON.stringify(tSide.map((x) => x.name)) === JSON.stringify(tPerson), "the side panel lists the clicked kind's tools")}`);
    await page.$eval(`${tCard('Person', 'search_customer')} ${tid('tool-status')}`, (e) => { delete /** @type {HTMLElement} */ (e).dataset.code; });
    await page.click(`${tid('side-tool')}[data-tool="search_customer"] ${tid('side-tool-run')}`);
    await page.waitForFunction((sel) => /** @type {HTMLElement} */ (document.querySelector(`${sel} [data-testid="tool-status"]`)).dataset.code, tCard('Person', 'search_customer'), { timeout: 60000 });
    const tr2 = await page.$eval(`${tCard('Person', 'search_customer')} ${tid('tool-status')}`, (e) => ({ code: e.dataset.code ?? '', rows: Number(e.dataset.rows ?? -1) }));
    const tFilled = await page.$eval(`${tCard('Person', 'search_customer')} [data-name="query"]`, (e) => /** @type {HTMLInputElement} */ (e).value);
    const tShown = await page.isVisible(tid('panel-console'));
    const tRows = await page.$$eval(`${tid('console-table')} tbody tr`, (trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').trim()).join(' | ')));
    say(`its Run prefilled $query = ${JSON.stringify(tFilled)} and opened the console tab (${tShown ? 'shown' : 'NOT shown'}): ${tr2.code}, ${tr2.rows} rows: ` +
      `${yes(tShown && tFilled === CLICK.title && tr2.code === 'ok' && tr2.rows > 0, 'a side-panel tool run is prefilled with the entity name and returns rows')}`);
    for (const r of [...tRows].sort(replay.cmp)) say(`  ${r}`);
    // A kind whose tools mostly take no name: the side panel asks for their parameters instead of running them.
    const ACCOUNT = 'Account:ACC_2207';
    await page.click(tid('tab-graph'));
    await settled(page, 'graphView');
    const tPosA = await page.evaluate((id) => {
      const nvl = /** @type {any} */ (window).ex01.graphView.nvl;
      const n = nvl.getNodes().find((/** @type {any} */ x) => x.id === id);
      const r = document.querySelector('[data-testid="graph-canvas"]').getBoundingClientRect();
      return n && n.clientPosition ? { x: r.left + n.clientPosition.x, y: r.top + n.clientPosition.y } : null;
    }, ACCOUNT);
    if (tPosA) await page.mouse.click(tPosA.x, tPosA.y);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="side-tool"]')].some((e) => /** @type {HTMLElement} */ (e).dataset.tool === 'list_accounts'), null, { timeout: 15000 }).catch(() => {});
    const tSideA = await page.$$eval(tid('side-tool'), (els) => els.map((e) => ({
      name: /** @type {HTMLElement} */ (e).dataset.tool ?? '', run: (e.querySelector('[data-testid="side-tool-run"]')?.textContent ?? '').trim(),
    })));
    say(`a click on ${ACCOUNT} lists Account's tools: ${tSideA.map((x) => `${x.name} [${x.run}]`).join(', ')}: ` +
      `${yes(tSideA.some((x) => x.name === 'list_accounts' && x.run === 'Run with $limit = "10"') && tSideA.some((x) => x.name === 'get_account_by_id' && x.run === 'Open: fill $id') &&
        tSideA.every((x) => !/ACC-2207/.test(x.run) || /\$query|\$name/.test(x.run)), "no $limit or $id is prefilled with the entity's name; a tool whose parameters all have a value runs")}`);
    // list_accounts: no parameter takes the name and $limit starts at 10 (its description's suggestion), so it runs as a tool about the kind.
    await page.$eval(`${tCard(tLa.anchor.label, 'list_accounts')} ${tid('tool-status')}`, (e) => { delete /** @type {HTMLElement} */ (e).dataset.code; });
    await page.click(`${tid('side-tool')}[data-tool="list_accounts"] ${tid('side-tool-run')}`);
    await page.waitForFunction((sel) => /** @type {HTMLElement} */ (document.querySelector(`${sel} [data-testid="tool-status"]`)).dataset.code, tCard(tLa.anchor.label, 'list_accounts'), { timeout: 60000 }).catch(() => {});
    const tKind = await page.$eval(`${tCard(tLa.anchor.label, 'list_accounts')} ${tid('tool-status')}`, (e) => ({ code: e.dataset.code ?? '', rows: Number(e.dataset.rows ?? -1) }));
    const tKindLimit = await page.$eval(`${tCard(tLa.anchor.label, 'list_accounts')} [data-name="limit"]`, (e) => /** @type {HTMLInputElement} */ (e).value);
    say(`its list_accounts button ran it in the console tab (${await page.isVisible(tid('panel-console')) ? 'shown' : 'NOT shown'}) with $limit = ${JSON.stringify(tKindLimit)}: ${tKind.code}, ${tKind.rows} row${tKind.rows === 1 ? '' : 's'}: ` +
      `${yes(tKind.code === 'ok' && tKind.rows > 0 && tKindLimit === '10', 'a tool about the kind runs from the side panel at its start values')}`);
    await page.click(tid('tab-graph'));
    await settled(page, 'graphView');
    const tPosA2 = await page.evaluate((id) => {
      const nvl = /** @type {any} */ (window).ex01.graphView.nvl;
      const n = nvl.getNodes().find((/** @type {any} */ x) => x.id === id);
      const r = document.querySelector('[data-testid="graph-canvas"]').getBoundingClientRect();
      return n && n.clientPosition ? { x: r.left + n.clientPosition.x, y: r.top + n.clientPosition.y } : null;
    }, ACCOUNT);
    if (tPosA2) await page.mouse.click(tPosA2.x, tPosA2.y);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="side-tool"]')].some((e) => /** @type {HTMLElement} */ (e).dataset.tool === 'get_account_by_id'), null, { timeout: 15000 }).catch(() => {});
    const tGa = tOnto.tools.find((/** @type {any} */ t) => t.name === 'get_account_by_id');
    const tSentA = await page.evaluate(() => /** @type {any} */ (window).ex01.state.consoleQueries);
    await page.click(`${tid('side-tool')}[data-tool="get_account_by_id"] ${tid('side-tool-run')}`);
    await page.waitForFunction((sel) => /** @type {HTMLElement} */ (document.querySelector(`${sel} [data-testid="tool-status"]`)).dataset.code === 'ask', tCard(tGa.anchor.label, 'get_account_by_id'), { timeout: 15000 }).catch(() => {});
    const tAsk = await page.$eval(`${tCard(tGa.anchor.label, 'get_account_by_id')} ${tid('tool-status')}`, (e) => ({ code: e.dataset.code ?? '', text: (e.textContent ?? '').trim() }));
    const tAskId = await page.$eval(`${tCard(tGa.anchor.label, 'get_account_by_id')} [data-name="id"]`, (e) => /** @type {HTMLInputElement} */ (e).value);
    const tSentA2 = await page.evaluate(() => /** @type {any} */ (window).ex01.state.consoleQueries);
    say(`its get_account_by_id button opened the console tab (${await page.isVisible(tid('panel-console')) ? 'shown' : 'NOT shown'}) and asks: ${JSON.stringify(tAsk.text)}; $id = ${JSON.stringify(tAskId)}; ` +
      `queries sent: ${tSentA2 - tSentA}: ${yes(tAsk.code === 'ask' && tAskId === '' && tSentA2 === tSentA, 'a tool with an empty parameter asks for it instead of running')}`);
    note(`tools done (${secs()})`);

    // ---- a second tab ---------------------------------------------------------------------------------------------
    say();
    say('## a second tab (R11)');
    const p2 = await ctx.newPage();
    await p2.goto(url());
    await waitDs(p2, 'engine', ['ready', 'failed']);
    await p2.waitForSelector(`${tid('lock-banner')}:visible`, { timeout: 60000 }).catch(() => {});
    const raw = await p2.evaluate((name) => /** @type {any} */ (window).ex01.call('open-store', { name }).then(() => 'opened', (e) => `${e.code}: ${e.message}`), STORE);
    say(`tab 2 sees: ${await p2.isVisible(tid('lock-banner')) ? 'the lock banner' : 'NO lock banner'}; the engine says ${raw.includes(`storage locked: opfs://${STORE}`) ? `storage locked: opfs://${STORE}` : JSON.stringify(raw)}`);
    yes(await p2.isVisible(tid('lock-banner')) && /storage locked: opfs:\/\//.test(raw), 'a second tab is refused the store');
    await p2.click(tid('handover'));
    await p2.waitForFunction((n) => document.body.dataset.store === n, STORE, { timeout: 60000 }).catch(() => {});
    say(`handover: tab 2 holds ${(await ds(p2, 'store')) || 'nothing'}; tab 1 holds ${(await ds(p1, 'store')) || 'nothing'} and says ${JSON.stringify(await text(p1, 'lock-text'))}`);
    yes((await ds(p2, 'store')) === STORE && (await ds(p1, 'store')) === '', 'the handover moves the store');
    await p1.close();
    page = p2;
    await page.waitForFunction(() => ['ready', 'failed'].includes(document.body.dataset.model ?? ''), null, { timeout: 120000 }).catch(() => {});
    say(`tab 2 loads the model from Cache Storage: ${await ds(page, 'model')}`);
    note(`second tab done (${secs()})`);

    // ---- a store that keeps another version of its bundled ontology ---------------------------------------------------
    say();
    say("## a store that keeps another version of its bundled ontology (an earlier build's conversion), and Re-apply");
    // The financial-services document as earlier builds converted it: create-context-graph's icon
    // and node size in neo4j:display, not in a createContextGraph:display envelope. Applied through the editor.
    const olderDoc = parseDocument(fs.readFileSync(path.join(EX, 'data/ontologies/ogs/ccg', `${ONTOLOGY}.ontology.yaml`), 'utf8'));
    let olderMoved = 0;
    for (const node of Object.values(olderDoc.nodes)) {
      const custom = node.extensions?.custom ?? [];
      const disp = custom.find((/** @type {any} */ c) => c.type === 'createContextGraph:display');
      if (!disp) continue;
      node.extensions['neo4j:display'] = { ...node.extensions['neo4j:display'], ...disp.definition };
      node.extensions.custom = custom.filter((/** @type {any} */ c) => c !== disp);
      if (!node.extensions.custom.length) delete node.extensions.custom;
      olderMoved++;
    }
    // A cutoff the user set (at its default value, small-v1's store.DEFAULT_GATE, so the graph does not move): it must
    // survive the re-apply.
    await page.evaluate(([keep, drop]) => /** @type {any} */ (window).ex01.call('cutoffs', { what: 'kind', name: 'Account', keep, drop, gate: /** @type {any} */ (window).ex01.state.gate }),
      [store.DEFAULT_GATE.entKeep, store.DEFAULT_GATE.entDrop]);
    /** The store's verdicts, the cutoffs set by the user, its typed graph and its document's sha. */
    const keeps = async () => {
      const v = await consoleCall(page, 'MATCH (v:_Verdict) RETURN count(v) AS n');
      const u = await consoleCall(page, "MATCH (k:_Kind) WHERE k.cut_src = 'user' RETURN k.id AS id, k.keep AS keep, k.drop AS drop ORDER BY id");
      const st = await page.evaluate(() => /** @type {any} */ (window).ex01.call('stats'));
      return { verdicts: v.ok ? v.rows[0].n : -1, user: u.ok ? u.rows.map((/** @type {any} */ r) => `${r.id} ${r.keep}/${r.drop}`).join(', ') : '?', entities: st.entities, facts: st.facts, sha: st.ontology.sha };
    };
    const keep0 = await keeps();
    await page.click(tid('tab-ontology'));
    await page.fill(tid('ontology-yaml'), toYaml(olderDoc));
    await page.waitForFunction(() => /** @type {HTMLElement} */ (document.querySelector('[data-testid="ontology-status"]')).dataset.valid === '1', null, { timeout: 15000 }).catch(() => {});
    await page.click(tid('apply-ontology'));
    await page.waitForSelector(tid('ontology-stale'), { state: 'visible', timeout: 60000 }).catch(() => {});
    await waitDs(page, 'busy', ['0'], 60000);
    const keep1 = await keeps();
    const staleText = ((await page.textContent('#ontology-stale-text')) ?? '').trim();
    const pick1 = await page.$eval(tid('domain-select'), (e) => /** @type {HTMLSelectElement} */ (e).selectedOptions[0]?.textContent ?? '');
    say(`applied through the editor: the ${ONTOLOGY} document with the icon and size of its ${olderMoved} nodes in neo4j:display; the page says: ${JSON.stringify(staleText)}; ` +
      `the picker shows ${JSON.stringify(pick1)}: ${yes(await page.isVisible(tid('ontology-stale')) && /an earlier build's conversion, or an edit/.test(staleText) && keep1.sha !== keep0.sha, 'a store with another version of a bundled ontology says so')}`);
    say(`  ${(await text(page, 'notice')) || 'no notice'}`);
    await page.click(tid('ontology-reapply'));
    await page.waitForSelector(tid('ontology-stale'), { state: 'hidden', timeout: 60000 }).catch(() => {});
    await waitDs(page, 'busy', ['0'], 60000);
    const keep2 = await keeps();
    const pick2 = await page.$eval(tid('domain-select'), (e) => /** @type {HTMLSelectElement} */ (e).value);
    say(`Re-apply the bundled one: the note is gone, the picker holds ${pick2}, the store's document is the bundled one again (its sha): ` +
      `${yes(!(await page.isVisible(tid('ontology-stale'))) && pick2 === `ogs/ccg/${ONTOLOGY}.ontology.yaml` && keep2.sha === keep0.sha, 'Re-apply brings the bundled document back')}`);
    say(`  ${(await text(page, 'notice')) || 'no notice'}`);
    say(`  kept: verdicts ${keep0.verdicts} -> ${keep2.verdicts}; cutoffs set by you: ${keep0.user} -> ${keep2.user}; the typed graph ${keep0.entities} entities and ${keep0.facts} relationships -> ` +
      `${keep2.entities} and ${keep2.facts}: ${yes(keep2.verdicts === keep0.verdicts && keep0.verdicts > 0 && keep2.user === keep0.user && keep0.user !== '' && keep2.entities === keep0.entities && keep2.facts === keep0.facts, 'Re-apply keeps verdicts, the cutoffs you set and the graph')}`);

    // ---- the ontology picker ------------------------------------------------------------------------------------------
    say();
    say('## the domain picker: one store per ontology (D14), with its sample');
    // A summary line, step 3's result and a selected entity in the side panel first (the sample again, all
    // of it from the inference cache): the switch must clear them.
    await page.click(tid('tab-graph'));
    const before = await extractSample(page, SAMPLE);
    const summaryBefore = await page.$eval(tid('graph-summary'), (e) => !/** @type {HTMLElement} */ (e).hidden);
    await settled(page, 'graphView');
    const pPos = await page.evaluate((id) => {
      const nvl = /** @type {any} */ (window).ex01.graphView.nvl;
      const n = nvl.getNodes().find((/** @type {any} */ x) => x.id === id);
      const r = document.querySelector('[data-testid="graph-canvas"]').getBoundingClientRect();
      return n && n.clientPosition ? { x: r.left + n.clientPosition.x, y: r.top + n.clientPosition.y } : null;
    }, CLICK.id);
    if (pPos) await page.mouse.click(pPos.x, pPos.y);
    await page.waitForSelector(`${tid('side-panel')} ${tid('side-title')}`, { timeout: 15000 }).catch(() => {});
    const sideBefore = await page.$eval(tid('side-panel'), (e) => (e.querySelector('[data-testid="side-title"]')?.textContent ?? '').trim()).catch(() => '');
    await page.selectOption(tid('domain-select'), `ogs/ccg/${OTHER}.ontology.yaml`);
    await page.waitForFunction((name) => document.body.dataset.store === name, `ex01-kg-${OTHER}`, { timeout: 60000 }).catch(() => {});
    await waitDs(page, 'busy', ['0'], 60000);
    await page.waitForFunction((t) => /** @type {any} */ (window).ex01.state.doc.sample?.id === t, OTHER, { timeout: 30000 }).catch(() => {});
    say(`${OTHER} opens ${await ds(page, 'store')} (${(await text(page, 'store-info')).replace(/^[^:]*: /, '')})`);
    const stores = await page.$$eval(`${tid('store-select')} option`, (os) => os.map((o) => o.value));
    say(`the store picker (Store tab) lists: ${stores.join(', ')}`);
    yes((await ds(page, 'store')) === `ex01-kg-${OTHER}` && stores.includes(STORE), 'two ontologies, two stores');
    const switched = await page.evaluate(() => {
      const q = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.querySelector(`[data-testid="${id}"]`));
      return {
        side: (q('side-panel').querySelector('[data-testid="side-title"]')?.textContent ?? '').trim(), hint: (q('side-panel').textContent ?? '').trim().slice(0, 40),
        doc: (q('doc-name').textContent ?? '').trim(), title: /** @type {HTMLInputElement} */ (q('doc-title')).value, about: (q('domain-about').textContent ?? '').trim(),
        summary: q('graph-summary').hidden, empty: q('graph-empty').hidden ? 'hidden' : q('graph-empty').dataset.state ?? '',
        status: (q('extract-status').textContent ?? '').trim(),
      };
    });
    say(`before it, the sample again (${before.data.inferences} model calls), its summary line ${summaryBefore ? 'shown' : 'NOT SHOWN'}, and the side panel showed ${JSON.stringify(sideBefore)}; after the switch: ${switched.side ? JSON.stringify(switched.side) : `the hint, ${JSON.stringify(`${switched.hint}…`)}`}; ` +
      `the summary line ${switched.summary ? 'gone' : 'STILL THERE'}, step 3's last result ${switched.status ? JSON.stringify(switched.status) : 'gone'}: ` +
      `${yes(before.state === 'done' && summaryBefore && sideBefore === CLICK.title && switched.side === '' && switched.summary && switched.status === '',
        'a store switch clears the side panel, the summary line and step 3\'s last result')}`);
    say(`the Document box holds ${JSON.stringify(switched.doc)} (${JSON.stringify(switched.title)}); step 1 says ${JSON.stringify(switched.about)}; the empty graph tab: ${switched.empty}: ` +
      `${yes(switched.doc === 'the Software Engineering sample' && switched.title === OTHER && switched.empty === 'extract', 'the domain picker opens the ontology, its store and its sample')}`);

    // ---- a crash mid-section ----------------------------------------------------------------------------------------------
    say();
    say('## the engine worker terminated mid-section, then resumed (R24, D9)');
    const crashDoc = crashDocument();
    await page.$eval(tid('doc-details'), (e) => { /** @type {HTMLDetailsElement} */ (e).open = true; });
    await page.fill(tid('doc-title'), 'crash-notes');
    await page.fill(tid('doc-text'), crashDoc);
    const crashLabel = await text(page, 'extract');
    await page.click(tid('extract'));
    await page.waitForFunction(() => /** @type {HTMLElement} */ (document.querySelector('[data-testid="extract-status"]')).dataset.sectionsDone === '1' ||
      ['done', 'failed', 'confirm'].includes(document.body.dataset.extract ?? ''), null, { timeout: 120000 });
    const at = await page.$eval(tid('extract-status'), (e) => ({ .../** @type {HTMLElement} */ (e).dataset }));
    await page.evaluate(() => /** @type {any} */ (window).ex01.crash());
    say(`step 3's button read ${JSON.stringify(crashLabel)}; killed after section ${at.sectionsDone ?? '?'} of ${at.sections ?? '?'}`);
    // The page restarts the engine and reopens the store by itself. A worker terminated while it
    // computes holds its OPFS handles until Chromium ends it by force, about 2 s later (R11), so
    // the page's reopen retries `storage locked` for 6 s and says "reopened" only when it was; the
    // crash banner's data-reopened is what the page claims. Nothing here reopens the store for it.
    await page.waitForFunction(() => document.body.dataset.engine === 'ready' && ['ready', 'failed'].includes(document.body.dataset.model ?? '') &&
      ['yes', 'no'].includes(/** @type {HTMLElement} */ (document.querySelector('[data-testid="crash-banner"]')).dataset.reopened ?? ''), null, { timeout: 120000 }).catch(() => {});
    const claimed = await page.$eval(tid('crash-banner'), (e) => /** @type {HTMLElement} */ (e).dataset.reopened ?? '');
    note(`crash: the page's banner: ${(await text(page, 'crash-text')).trim()}`);
    say(`the page restarts the engine and the model (${await ds(page, 'model')}, from Cache Storage); the store is open again: ` +
      `${yes((await ds(page, 'store')) === `ex01-kg-${OTHER}` && claimed === 'yes', 'the page reopens the store after the crash, and says so')}`);
    const secRows = await consoleCall(page, 'MATCH (sec:_Section) RETURN sec.n AS n, sec.complete AS complete ORDER BY n');
    say(`sections in the store after the crash: ${secRows.ok ? secRows.rows.map((/** @type {any} */ r) => `${r.n} ${r.complete ? 'complete' : 'incomplete'}`).join('; ') || 'none' : secRows.message}`);
    say(`the extraction: ${await ds(page, 'extract')}; Continue offered: ${await page.isVisible(tid('continue')) ? 'yes' : 'no'}`);
    await page.click(tid('continue'));
    await page.waitForFunction(() => document.body.dataset.extract === 'running', null, { timeout: 30000 }).catch(() => {});
    await waitDs(page, 'extract', ['done', 'failed', 'stopped'], 300000);
    say(`continue: ${await ds(page, 'extract')}; ${await text(page, 'extract-status')}`);
    const crashDump = /** @type {string} */ ((await page.evaluate(() => /** @type {any} */ (window).ex01.call('dump'))).text);
    const ref = await nodeStore(OTHER, [{ text: crashDoc, title: 'crash-notes' }]);
    const refDump = store.dumpStore(ref);
    ref.free();
    say(`the resumed store's content equals an uninterrupted run's (Node): ${yes(stableDigest(crashDump) === stableDigest(refDump), 'crash + resume = uninterrupted')}`);
    const runs = await consoleCall(page, 'MATCH (r:_Run) RETURN r.status AS status, r.inferences AS inferences, r.hits AS hits ORDER BY r.id');
    say(`  runs: ${runs.ok ? runs.rows.map((/** @type {any} */ r) => `${r.status} (${r.inferences} inferences, ${r.hits} hits)`).join('; ') : runs.message}`);
    note(`crash done (${secs()})`);

    // ---- a pasted document ---------------------------------------------------------------------------------
    say();
    say('## a pasted document: its title, the summary line, a title the store holds for other text');
    const docLook = () => page.evaluate(() => {
      const q = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (document.querySelector(`[data-testid="${id}"]`));
      return { title: q('doc-title').value, button: (q('extract').textContent ?? '').trim(), doc: (q('doc-name').textContent ?? '').trim() };
    });
    const sampleBack = async () => {
      await page.click(tid('use-sample'));
      await page.waitForFunction((t) => /** @type {any} */ (window).ex01.state.doc.sample?.id === t &&
        /** @type {HTMLTextAreaElement} */ (document.querySelector('[data-testid="doc-text"]')).value === /** @type {any} */ (window).ex01.state.doc.body, OTHER, { timeout: 30000 }).catch(() => {});
    };
    await page.click(tid('tab-graph'));
    await page.$eval(tid('doc-details'), (e) => { /** @type {HTMLDetailsElement} */ (e).open = true; });
    await sampleBack();
    const u0 = await docLook();
    await page.fill(tid('doc-text'), PASTED.plain);
    const u1 = await docLook();
    await page.fill(tid('doc-text'), PASTED.release[0]);
    const u2 = await docLook();
    await page.fill(tid('doc-title'), 'My notes');
    await page.fill(tid('doc-text'), PASTED.other);
    const u3 = await docLook();
    await sampleBack();
    const u4 = await docLook();
    say(`"Use the sample" (the crash test had typed "crash-notes"): ${JSON.stringify(u0.title)}; pasted text with no heading: ${JSON.stringify(u1.title)} [${u1.button}]; ` +
      `with a heading: ${JSON.stringify(u2.title)} [${u2.button}]; a title typed, then other text: ${JSON.stringify(u3.title)}; "Use the sample" again: ${JSON.stringify(u4.title)} [${u4.button}]: ` +
      `${yes(u0.title === OTHER && u1.title === 'pasted' && u1.button === 'Extract “pasted”' && u2.title === 'Release review' && u2.button === 'Extract “Release review”' &&
        u3.title === 'My notes' && u4.title === OTHER && u4.button === 'Extract the sample', 'the title follows the text; a typed one stays; the sample brings its own back')}`);
    /** Step 3's Extract on the Document box as it is: the state it settles in (done, or duplicate: the question). */
    const extractBox = async () => {
      await page.click(tid('extract'));
      await page.waitForFunction(() => ['running', 'confirm', 'duplicate', 'failed', 'done'].includes(document.body.dataset.extract ?? ''), null, { timeout: 60000 });
      await waitDs(page, 'extract', ['done', 'failed', 'stopped', 'confirm', 'duplicate'], 300000);
      return ds(page, 'extract');
    };
    /** The open store's documents (title and id), and the share of the document extracted last, counted by the console. */
    const docsNow = async () => (await page.evaluate(() => /** @type {any} */ (window).ex01.call('stats'))).documents.map((/** @type {any} */ d) => ({ title: d.title, id: d.id }));
    const share = async () => {
      const doc = await page.evaluate(() => /** @type {any} */ (window).ex01.state.lastDoc);
      const r = await consoleCall(page, `OPTIONAL MATCH (e:_Entity) WHERE $doc IS NOT NULL AND $doc IN e.docs
WITH count(e) AS entities
OPTIONAL MATCH (:_Entity)-[r]->(:_Entity) WHERE $doc IS NOT NULL AND $doc IN r.docs
WITH entities, count(r) AS rels
OPTIONAL MATCH (c:_Claim) WHERE $doc IS NOT NULL AND c.doc = $doc AND c.band = 'review'
WITH entities, rels, count(c) AS claims
OPTIONAL MATCH (m:_Mention) WHERE $doc IS NOT NULL AND m.doc = $doc AND m.band = 'review'
WITH entities, rels, claims, count(m) AS mentions
RETURN entities, rels, claims + mentions AS review`, { doc });
      return r.ok ? { doc, entities: Number(r.rows[0].entities), rels: Number(r.rows[0].rels), review: Number(r.rows[0].review) } : { doc, entities: -1, rels: -1, review: -1, error: r.message };
    };
    // The first extraction under that title: the summary line, this document's share against the store's.
    await page.fill(tid('doc-text'), PASTED.release[0]);
    const px1 = await extractBox();
    const sl1 = await summaryLine(page);
    const sh1 = await share();
    const st5 = await page.evaluate(() => /** @type {any} */ (window).ex01.call('stats'));
    const badge5 = Number(await text(page, 'review-count') || 0);
    say(`"Release review": ${px1}; the summary line: ${JSON.stringify(sl1.text)} ${sl1.buttons.map((b) => `[${b}]`).join(' ')}`);
    say(`  its share (the console: entities and relationships whose docs hold it, its claims and mentions in review): ${sh1.entities}, ${sh1.rels}, ${sh1.review}; ` +
      `the store's: ${st5.entities}, ${st5.facts}, ${badge5} in review: ${yes(px1 === 'done' && Number(sl1.docEntities) === sh1.entities && Number(sl1.docRels) === sh1.rels &&
        Number(sl1.docReview) === sh1.review && Number(sl1.entities) === st5.entities && Number(sl1.rels) === st5.facts && Number(sl1.review) === badge5 &&
        sh1.entities < st5.entities, 'the summary line gives this document\'s share from the store, then the store\'s totals')}`);
    /** The graph tab's counts as drawn, the scope chosen and the summary's scope button. */
    const scopeLook = async (/** @type {string} */ want) => {
      await page.waitForFunction((w) => {
        const c = /** @type {any} */ (window).ex01.graphView.counts();
        const e = /** @type {HTMLElement} */ (document.querySelector('[data-testid="graph-counts"]')).dataset;
        return e.scope === w && !c.pending && c.nodes === Number(e.nodes) && c.rels === Number(e.rels);
      }, want, { timeout: 60000 }).catch(() => {});
      return page.evaluate(() => ({
        nodes: Number(/** @type {HTMLElement} */ (document.querySelector('[data-testid="graph-counts"]')).dataset.nodes),
        rels: Number(/** @type {HTMLElement} */ (document.querySelector('[data-testid="graph-counts"]')).dataset.rels),
        scope: /** @type {HTMLInputElement} */ (document.querySelector('input[name="scope"]:checked')).value,
        button: (document.querySelector('[data-testid="graph-summary-scope"]')?.textContent ?? '').trim(),
      }));
    };
    await page.click(tid('graph-summary-scope'));
    const only = await scopeLook('doc');
    await page.click(tid('graph-summary-scope'));
    const back = await scopeLook('all');
    const pl = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many) => `${n} ${n === 1 ? one : many}`;
    say(`[Show only this document]: the graph tab draws its ${pl(only.nodes, 'entity', 'entities')} and ${pl(only.rels, 'relationship', 'relationships')} ("${only.scope}" chosen), ` +
      `the button then reads ${JSON.stringify(only.button)}; pressed, all ${back.nodes} and ${back.rels} again: ${yes(only.scope === 'doc' && only.nodes === sh1.entities && only.rels === sh1.rels && only.button === 'Show all documents' &&
        back.scope === 'all' && back.nodes === st5.entities && back.rels === st5.facts && back.button === 'Show only this document', 'the summary line switches the graph to this document and back')}`);
    // An edit under the same title: the page asks first; Replace forgets the earlier document (the Store tab's Forget).
    const firstId = sh1.doc;
    await page.fill(tid('doc-text'), PASTED.release[1]);
    const px2 = await extractBox();
    const dupText = await text(page, 'dup-text');
    const dupButtons = await page.$$eval(`${tid('dup')} button`, (bs) => bs.map((b) => (b.textContent ?? '').trim()));
    say(`the same title, other text: ${px2}: ${JSON.stringify(dupText)} ${dupButtons.map((b) => `[${b}]`).join(' ')}`);
    yes(px2 === 'duplicate', 'a title the store holds for other text is asked about before extracting');
    await page.click(tid('dup-replace'));
    await waitDs(page, 'extract', ['done', 'failed', 'stopped'], 300000);
    const sl2 = await summaryLine(page);
    const pd2 = await docsNow();
    const id2 = await page.evaluate(() => /** @type {any} */ (window).ex01.state.lastDoc);
    const rr = pd2.filter((d) => d.title === 'Release review');
    say(`[Replace it]: ${await ds(page, 'extract')}; ${JSON.stringify(sl2.text.split(': kept')[0])}; the store's documents: ${pd2.map((d) => d.title).join(', ')}: ` +
      `${yes(rr.length === 1 && rr[0].id === id2 && id2 !== firstId && !pd2.some((d) => d.id === firstId), 'Replace forgets the earlier document of that title and extracts this one')}`);
    // Again, and Keep both: two documents of one title, told apart in the Store tab.
    await page.fill(tid('doc-text'), PASTED.release[2]);
    const px3 = await extractBox();
    yes(px3 === 'duplicate', 'asked again for a third text of that title');
    await page.click(tid('dup-add'));
    await waitDs(page, 'extract', ['done', 'failed', 'stopped'], 300000);
    const pd3 = await docsNow();
    await page.click(tid('tab-store'));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="document"]').length >= 3, null, { timeout: 30000 }).catch(() => {});
    const lis = await page.$$eval(tid('document'), (els) => els.map((e) => ({ doc: /** @type {HTMLElement} */ (e).dataset.doc ?? '', text: (e.firstChild?.textContent ?? '').trim() })));
    const two = lis.filter((l) => l.text.startsWith('Release review'));
    const apart = two.length === 2 && two.every((l) => new RegExp(`^Release review \\(text ${l.doc.slice(0, 7)}\\) · `).test(l.text)) && two[0].text !== two[1].text;
    say(`[Keep both]: ${await ds(page, 'extract')}; ${pd3.filter((d) => d.title === 'Release review').length} documents titled "Release review"; the Store tab lists ` +
      `${two.map((l) => JSON.stringify(l.text.replace(/\(text [0-9a-f]{7}\)/, '(text <sha7>)'))).join(' and ')}, each with its text's sha256: ${yes(apart, 'the Store tab tells same-titled documents apart')}`);
    // "pasted" made unique against the store's titles.
    await page.click(tid('tab-graph'));
    await page.fill(tid('doc-text'), PASTED.plain);
    const u6 = await docLook();
    const px4 = await extractBox();
    await page.fill(tid('doc-text'), PASTED.other);
    const u7 = await docLook();
    say(`pasted text with no heading: ${JSON.stringify(u6.title)}, extracted (${px4}); then other pasted text: ${JSON.stringify(u7.title)} [${u7.button}]: ` +
      `${yes(u6.title === 'pasted' && px4 === 'done' && u7.title === 'pasted-2' && u7.button === 'Extract “pasted-2”', '"pasted" is made unique against the store\'s titles')}`);
    note(`pasted documents done (${secs()})`);

    // ---- reset ------------------------------------------------------------------------------------------------------------
    say();
    say('## reset');
    await page.click(tid('tab-store'));
    await page.click(tid('reset'));
    await page.click(tid('reset-confirm'));
    await page.waitForFunction(() => /empty again/.test(document.querySelector('[data-testid="store-op"]').textContent ?? ''), null, { timeout: 60000 }).catch(() => {});
    const s4 = await page.evaluate(() => /** @type {any} */ (window).ex01.call('stats'));
    say(`${await text(page, 'store-op')} ${s4.documents.length} documents, ${s4.inferences} inferences, ${s4.entities} entities; ontology ${s4.ontology.id} with ${s4.ontology.kinds.length} kinds`);
    yes(s4.documents.length === 0 && s4.inferences === 0 && s4.ontology.kinds.length > 0, 'reset empties the store and re-applies the ontology');
  } catch (e) {
    failures.push(`exception: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    note(`FAIL: exception: ${e instanceof Error ? e.stack : e}`);
    say(`EXCEPTION: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    await page.screenshot({ path: path.join(work, 'failure.png') }).catch(() => {});
  } finally {
    say();
    say('## hygiene (every page of the run)');
    const csp = await w.csp();
    say(`CSP violations: ${csp.length ? csp.join('; ') : 'none'}`);
    say(`console and page errors (warnings ignored): ${w.errors.length ? [...new Set(w.errors)].join(' | ') : 'none'}`);
    say(`requests outside the page's origin, the routed Hub aside: ${w.external.length ? [...new Set(w.external)].join(', ') : 'none'}`);
    if (csp.length) failures.push('CSP violations');
    if (w.errors.length) failures.push('console errors');
    if (w.external.length || hub.other.length) failures.push('requests outside the origin');
    await closeAll();
  }
  fs.writeFileSync(outFile, `${lines.join('\n')}\n`);
  note(`done in ${secs()}; ${failures.length ? `${failures.length} failure(s)` : 'every check holds'}`);
  return failures.length ? 1 : 0;
}

/**
 * The pasted-document test's texts, software-engineering sentences with fictional people,
 * firms, services and repositories: `release`, three versions of one document titled by its heading;
 * `plain` and `other`, two texts without a heading.
 */
const PASTED = (() => {
  const release = ['# Release review', '', 'Mira Holt works for Northgate Labs. The billing-api service depends on ledger-sync.',
    'Tomas Reyes authored PR #812 in the platform-core repository.', ''].join('\n');
  return {
    release: [release, `${release}Ingrid Sol reviewed PR #812.\n`, `${release}Ingrid Sol reviewed PR #812.\nPR #812 fixes BUG-77.\n`],
    plain: 'Pavel Orr works for Orion Labs. Pavel Orr is on call for the search-index service.\n',
    other: 'Ada Fenwick works for Linden Works in Oslo.\n',
  };
})();

/**
 * The crash test's document: two sections (planSections closes the first at the heading once it
 * holds 1,500 bytes) of software-engineering sentences (fictional people, firms, services and
 * repositories; real cities), 30 sentences in all, so the extraction stays under the page's
 * ask-first threshold of 40.
 */
function crashDocument() {
  const people = ['Mira Holt', 'Tomas Reyes', 'Ingrid Sol', 'Pavel Orr', 'Ada Fenwick'];
  const orgs = ['Calder Bay Capital', 'Pell Street Partners', 'Northgate Labs', 'Orion Labs', 'Linden Works'];
  const services = ['billing-api', 'auth-gateway', 'ledger-sync', 'report-worker', 'search-index'];
  const repos = ['platform-core', 'payments-ui', 'infra-config', 'data-pipeline', 'mobile-app'];
  const places = ['Leeds', 'Lisbon', 'Porto', 'Oslo', 'Lyon'];
  const a = ['# Platform notes', ''];
  for (let i = 0; i < 18; i++) {
    a.push(`${people[i % 5]} works for ${orgs[(i + 1) % 5]} in ${places[(i + 2) % 5]}, where the team runs the ${services[(i + 3) % 5]} service from the ${repos[(i + 4) % 5]} repository (note ${i + 1}).`);
  }
  a.push('', '## Deployment', '');
  for (let i = 0; i < 12; i++) {
    a.push(`The ${services[i % 5]} service depends on ${services[(i + 2) % 5]}, and ${people[(i + 3) % 5]} is on call for it in release ${i + 1}.`);
  }
  return `${a.join('\n')}\n`;
}

// ==== the smoke test (the deployed site) ======================================================================================

async function smoke(argv) {
  const baseUrl = argv.baseUrl;
  if (!baseUrl || !/^https?:\/\/[^/]+\/(.*\/)?$/.test(baseUrl)) missing('--smoke needs --base-url <url ending in />, e.g. https://<owner>.github.io/relate-examples/01-wasm-extract/');
  const origin = new URL(baseUrl).origin;
  let failed = 0;
  const ok = (/** @type {boolean} */ c, /** @type {string} */ m) => {
    console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`);
    if (!c) failed++;
    return c;
  };
  for (const f of Object.values(MODEL_FILES)) if (!fs.existsSync(path.join(MODEL_DIR, f))) missing(`no small-v1 weights in ${rel(MODEL_DIR)}; fix: scripts/fetch-gliner.sh small`);
  const { chromium } = await playwright();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ex01-smoke-'));
  const ctx = await chromium.launchPersistentContext(profile, { headless: true, acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const closeAll = async () => {
    await ctx.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  };
  process.once('SIGINT', () => closeAll().then(() => process.exit(130)));
  process.once('SIGTERM', () => closeAll().then(() => process.exit(143)));
  const w = await watch(ctx, origin);
  const hub = await routeHub(ctx, MODEL_DIR);
  const page = ctx.pages()[0] ?? await ctx.newPage();
  try {
    const resp = await page.goto(`${baseUrl}?test=1`);
    if (!ok(resp.status() === 200, `the page answers ${resp.status()}`)) throw new Error(`${baseUrl} answers ${resp.status()}`);
    const csp = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '');
    ok(csp.includes("script-src 'self' 'wasm-unsafe-eval'"), `the page's Content-Security-Policy <meta> has script-src 'self' 'wasm-unsafe-eval'${csp ? '' : ' (no CSP meta)'}`);
    ok(/connect-src [^;]*https:\/\/huggingface\.co/.test(csp), 'connect-src allows the Hugging Face Hub');
    const asset = await page.request.get(`${baseUrl}assets/relate-${VER}/relate_bg.wasm`);
    ok(asset.status() === 200 && asset.headers()['content-type'] === 'application/wasm', `the Relate .wasm is served as application/wasm (${asset.headers()['content-type'] ?? 'no Content-Type'})`);
    await waitDs(page, 'engine', ['ready', 'failed'], 120000);
    ok((await ds(page, 'engine')) === 'ready', `the engine starts (${await text(page, 'status')})`);
    await page.waitForFunction(() => document.body.dataset.store, null, { timeout: 60000 }).catch(() => {});
    ok((await ds(page, 'store')) === STORE, `the OPFS store opens: ${(await ds(page, 'store')) || 'none'}`);
    await page.click(tid('load-model'));
    await waitDs(page, 'model', ['ready', 'failed'], 300000);
    ok((await ds(page, 'model')) === 'ready' && hub.files > 0, `small-v1 loads (${hub.files} Hub requests answered locally, ${hub.ranges} byte ranges)`);
    const r = await extractSample(page, SAMPLE);
    const want = expectedKept(ONTOLOGY, SAMPLE);
    ok(r.state === 'done' && JSON.stringify([...r.kept].sort()) === JSON.stringify(want), `${SAMPLE}: the same ${want.length} kept triples as expected/extract.txt (${r.kept.length} kept)`);
    await page.click(tid('tab-graph'));
    await page.waitForFunction(() => /** @type {any} */ (window).ex01.graphView.counts().rels > 0, null, { timeout: 60000 }).catch(() => {});
    const gc = await page.evaluate(() => /** @type {any} */ (window).ex01.graphView.counts());
    const shown = await page.$eval(tid('graph-counts'), (e) => ({ n: Number(e.dataset.nodes), r: Number(e.dataset.rels) }));
    ok(gc.rels > 0 && gc.nodes === shown.n && gc.rels === shown.r, `NVL draws the graph: ${gc.nodes} nodes, ${gc.rels} relationships`);
    const qc = await consoleUi(page, "CREATE (:Probe {name: 'x'}) RETURN 1 AS one");
    ok(qc.category === 'readonly' && /WriteOnReadOnlyAccessDatabase/.test(qc.text), `a console CREATE is refused: ${firstLine(qc.text)}`);
    await page.click(tid('tab-store'));
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click(tid('download-db'))]);
    const tmp = path.join(profile, 'download.tar');
    await dl.saveAs(tmp);
    ok(dl.suggestedFilename() === `${STORE}.relate.tar` && fs.statSync(tmp).size > 1024, `the database download fires: ${dl.suggestedFilename()}`);
  } catch (e) {
    ok(false, `exception: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  } finally {
    const csp = await w.csp();
    ok(csp.length === 0, `no CSP violations${csp.length ? `: ${csp.join('; ')}` : ''}`);
    ok(w.errors.length === 0, `no console or page errors${w.errors.length ? `: ${[...new Set(w.errors)].join(' | ')}` : ''}`);
    ok(w.external.length === 0 && hub.other.length === 0, `no requests outside ${origin} but the routed weights${w.external.length + hub.other.length ? `: ${[...w.external, ...hub.other].join(', ')}` : ''}`);
    await closeAll();
  }
  console.log(failed ? `${failed} check(s) FAILED` : 'smoke test passed');
  return failed ? 1 : 0;
}

// ==== main ===================================================================================================

function parseArgs(args) {
  /** @type {any} */
  const a = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (x === '--smoke') a.smoke = true;
    else if (x === '--base-url') a.baseUrl = args[++i];
    else if (x === '--out') a.out = args[++i];
    else if (x === '--port') a.port = args[++i];
    else if (x === '--no-build') a.noBuild = true;
    else if (x === '-h' || x === '--help') a.help = true;
    else if (x.startsWith('--')) {
      console.error(`drive.mjs: unknown option ${x}`);
      process.exit(2);
    } else a._.push(x);
  }
  return a;
}

const USAGE = `usage: node harness/drive.mjs [--out FILE] [--port N] [--no-build]
       node harness/drive.mjs --smoke --base-url <url>/relate-examples/01-wasm-extract/
       node harness/drive.mjs node-dump <out.json> [main|generic]
       node harness/drive.mjs wasm-queries <dump.json> <out.json>`;

const argv = parseArgs(process.argv.slice(2));
let rc = 0;
if (argv.help) {
  console.log(USAGE);
} else if (argv._[0] === 'node-dump') {
  if (!argv._[1] || !['main', 'generic', undefined].includes(argv._[2])) missing(USAGE);
  fs.writeFileSync(argv._[1], await nodeDump(argv._[2] ?? 'main'));
} else if (argv._[0] === 'wasm-queries') {
  if (!argv._[1] || !argv._[2]) missing(USAGE);
  await wasmQueries(argv._[1], argv._[2]);
} else if (argv._.length) {
  console.error(USAGE);
  rc = 2;
} else if (argv.smoke) {
  rc = await smoke(argv);
} else {
  rc = await browserRun(argv);
}
// Let the event loop drain (Playwright, the server, pending writes) rather than cutting it short.
process.exitCode = rc;
