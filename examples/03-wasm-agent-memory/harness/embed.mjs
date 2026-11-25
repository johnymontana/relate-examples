#!/usr/bin/env node
// @ts-check
/**
 * harness/embed.mjs: the vectors of every text the scripts use, computed ahead of time with the
 * embedding model (web/embed.js MODEL: all-MiniLM-L6-v2, q8, at a pinned revision) and written to
 * data/embeddings.json. Run by hand after a scenario's text changes:
 *
 *   node harness/embed.mjs            rewrite data/embeddings.json
 *   node harness/embed.mjs --check    recompute and compare with the file (exit 1 on a missing,
 *                                     extra or different vector); writes nothing
 *
 * The texts: every memory's text and every recalled question of data/scenarios/*.json, each
 * scenario's suggested messages (`try`), and the turns the regression run types (harness/typed.mjs
 * TYPED).
 *
 * The vectors are made by the page's own worker (web/embed.worker.js: Transformers.js on
 * onnxruntime-web's WebAssembly build), in headless Chromium, not by the library's Node backend:
 * the model is quantised, and onnxruntime's native and WebAssembly kernels round it differently
 * (NOTES.md T5). Made this way, a text has the same vector in the file as in a visitor's tab, to
 * the last digit, and on any machine.
 *
 * Needs Playwright's Chromium, and the network the first time: the model's four files (23 MB) are
 * fetched from the Hugging Face Hub into <repo>/.cache/ex03-embedder/<revision>/ and checked
 * against the pinned sha256s; Chromium's requests for them are answered from there.
 *
 * run.sh never runs this: the regression run reads the file, and fails when a scripted text has no
 * vector in it (a scenario changed and this was not rerun).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { start } from '../../../lib/serve.mjs';
import { build } from '../build.mjs';
import { MODEL } from '../web/embed.js';
import { TYPED } from './typed.mjs';

const EX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(EX, '../..');
const FILE = path.join(EX, 'data', 'embeddings.json');
const CACHE = path.join(ROOT, '.cache', 'ex03-embedder', MODEL.revision);
const check = process.argv.includes('--check');
const hubUrl = (/** @type {string} */ name) => `https://huggingface.co/${MODEL.id}/resolve/${MODEL.revision}/${name}`;

/** Every text that needs a vector, each once, sorted. */
function texts() {
  const out = new Set(TYPED.map((t) => t.trim()));
  for (const f of fs.readdirSync(path.join(EX, 'data', 'scenarios')).sort()) {
    const sc = JSON.parse(fs.readFileSync(path.join(EX, 'data', 'scenarios', f), 'utf8'));
    for (const t of sc.try ?? []) out.add(t.trim());
    for (const session of sc.sessions) {
      for (const turn of session.turns) {
        for (const m of turn.remember?.memories ?? []) out.add(m.text);
        if (turn.recall) out.add(typeof turn.recall === 'object' && turn.recall.question ? turn.recall.question : turn.user);
      }
    }
  }
  return [...out].sort();
}

/** The model's files, in the cache and equal to the pinned ones; fetched when missing. @returns {Promise<Map<string, Buffer>>} url -> bytes */
async function modelFiles() {
  /** @type {Map<string, Buffer>} */ const out = new Map();
  for (const [name, want] of Object.entries(MODEL.files)) {
    const file = path.join(CACHE, name);
    if (!fs.existsSync(file)) {
      const res = await fetch(hubUrl(name));
      if (!res.ok) throw new Error(`${name}: the Hub answered ${res.status}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    const bytes = fs.readFileSync(file);
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== want.sha256) throw new Error(`${path.relative(ROOT, file)} has sha256 ${got.slice(0, 12)}…, not the pinned ${want.sha256.slice(0, 12)}… (delete it to fetch it again)`);
    out.set(hubUrl(name), bytes);
  }
  return out;
}

/** The page's worker, in headless Chromium, over every text. @param {string[]} list @returns {Promise<number[][]>} */
async function embedInTab(list) {
  const files = await modelFiles();
  // the page as built now, in a directory of its own: dist/ may be in use, and may be older than web/
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ex03-embed-'));
  await build(dist, { staleVectors: true });
  const server = await start({ example: '03-wasm-agent-memory', dist });
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    // the worker's requests to the Hub are answered from the cache; nothing else leaves the machine
    await ctx.route((url) => url.origin !== new URL(server.base).origin, (route) => {
      const body = files.get(route.request().url());
      return body ? route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body }) : route.abort();
    });
    const page = await ctx.newPage();
    await page.goto(`${server.base}?test=1`);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 120000 });
    return await page.evaluate(async (texts) => {
      const w = new Worker(new URL('embed.worker.js', location.href), { type: 'module' });
      try {
        return await new Promise((resolve, reject) => {
          w.onmessage = (e) => { if (e.data.id === 1) (e.data.ok ? resolve(e.data.result) : reject(new Error(e.data.error))); };
          w.onerror = (e) => reject(new Error(e.message || 'the worker failed to load'));
          w.postMessage({ id: 1, op: 'embed', texts });
        });
      } finally { w.terminate(); }
    }, list);
  } finally {
    await browser.close();
    await server.close();
    fs.rmSync(dist, { recursive: true, force: true });
  }
}

try {
  const list = texts();
  const made = await embedInTab(list);
  /** @type {Record<string, number[]>} */ const vectors = Object.fromEntries(list.map((t, i) => [t, made[i]]));

  if (check) {
    const file = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const have = file.vectors ?? {};
    const problems = [];
    if (file.model?.id !== MODEL.id || file.model?.revision !== MODEL.revision || file.model?.dtype !== MODEL.dtype) problems.push('made with another model');
    for (const t of list) {
      if (!have[t]) problems.push(`no vector for ${JSON.stringify(t)}`);
      else if (have[t].length !== vectors[t].length || have[t].some((/** @type {number} */ x, /** @type {number} */ k) => x !== vectors[t][k])) problems.push(`a different vector for ${JSON.stringify(t)}`);
    }
    for (const t of Object.keys(have)) if (!list.includes(t)) problems.push(`a vector nothing uses: ${JSON.stringify(t)}`);
    for (const p of problems) console.error(`embed.mjs: ${p}`);
    console.log(problems.length ? `data/embeddings.json is out of date (${problems.length} problems): run node harness/embed.mjs` : `data/embeddings.json matches the model: ${list.length} vectors`);
    process.exitCode = problems.length ? 1 : 0;
  } else {
    // one vector per line, texts sorted: a changed text is a one-line diff
    const lines = list.map((t, i) => `    ${JSON.stringify(t)}: [${vectors[t].join(',')}]${i < list.length - 1 ? ',' : ''}`);
    const head = { id: MODEL.id, revision: MODEL.revision, dtype: MODEL.dtype, dims: MODEL.dims, pooling: 'mean', normalized: true, runtime: 'onnxruntime-web (WebAssembly), one text at a time' };
    fs.writeFileSync(FILE, `{\n  "model": ${JSON.stringify(head)},\n  "vectors": {\n${lines.join('\n')}\n  }\n}\n`);
    console.log(`wrote data/embeddings.json: ${list.length} vectors of ${MODEL.dims} numbers (${(fs.statSync(FILE).size / 1e3).toFixed(0)} kB)`);
  }
} catch (e) {
  console.error(`embed.mjs: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
}
