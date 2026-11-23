#!/usr/bin/env node
// @ts-check
/**
 * harness/llm-eval.mjs: the in-browser models on the page's questions, measured. Local and opt-in:
 * it needs a WebGPU-capable Chrome (Playwright's `chrome` channel: the system Chrome, which reaches
 * the real GPU even headless; Playwright's own Chromium falls back to SwiftShader without 16-bit
 * shaders) and downloads the models once into a persistent profile under .cache/ex02-chrome/, served
 * on a fixed port (EX02_EVAL_PORT, default 8712) because the browser's caches are per origin.
 * run.sh never runs it and nothing it writes is diffed: model output depends on the GPU.
 *
 *   node harness/llm-eval.mjs [--model <id>|all] [--repair] [--out out/llm] [--headed]
 *
 * For each model: load it in the page (dist/, served as Pages would), then ask every suggested
 * question and every ontology cookbook question through window.ex02.answer, exactly as the Ask
 * button does (grounded query, then bare). Each query is scored against a reference query for that
 * question, run on the same store: the ontology's cookbook query when the question is one of its
 * six (an exact answer), else the canned entry the question routes to (a keyword match, often
 * broader than the question):
 *   valid      the ontology check passed (validate.js)
 *   ran        Relate planned and ran it without an error
 *   covers     as many rows as the reference, and each reference row's values found in a row of its
 *              own (extra columns allowed)
 *   rows       its rows equal the reference's exactly (values only: column names and row order ignored)
 * and the time to write it. --repair ticks the page's "repair once" option (a refused or failed query
 * goes back to the model once, with what was wrong). out/llm/<model>[-repair].txt holds the table and
 * every query; stdout a summary.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { start } from '../../../lib/serve.mjs';
import { MODELS } from '../web/llm.js';

const EX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(EX, '../..');
const args = process.argv.slice(2);
const opt = (/** @type {string} */ k, /** @type {string} */ d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const which = opt('--model', MODELS[0].id);
const outDir = path.resolve(opt('--out', path.join(EX, 'out', 'llm')));
const headed = args.includes('--headed');
const repair = args.includes('--repair');
const models = which === 'all' ? MODELS.map((m) => m.id) : [which];

if (!fs.existsSync(path.join(EX, 'dist', 'index.html'))) {
  console.error('llm-eval.mjs: no dist/: run npm run build first');
  process.exit(2);
}
const canned = JSON.parse(fs.readFileSync(path.join(EX, 'data', 'canned.json'), 'utf8'));
const yamlText = fs.readFileSync(path.join(EX, 'data', 'corporate-events.ontology.yaml'), 'utf8');
const cookbook = [...yamlText.matchAll(/^\s+- question: (.+)$/gm)].map((m) => m[1].trim());
/** The cookbook's exact reference query per question (the YAML's literal blocks under each question). */
const cookbookCypher = new Map([...yamlText.matchAll(/^\s+- question: (.+)\n\s+cypher: \|\n((?:\s{10,}.*\n)+)/gm)]
  .map((m) => [m[1].trim(), m[2].split('\n').map((l) => l.trim()).filter(Boolean).join('\n')]));
const questions = [...new Set([...canned.suggested, ...cookbook])];

/**
 * Does `got` cover `ref`: the same number of rows, and a one-to-one matching in which each reference
 * row's values all appear in its partner (extra columns allowed)? Greedy, on these small results.
 * @param {any[]} got @param {any[]} ref
 */
function covers(got, ref) {
  if ((got ?? []).length !== (ref ?? []).length) return false;
  const vals = (/** @type {any} */ r) => Object.values(r).map((v) => JSON.stringify(v));
  const pool = got.map(vals);
  for (const r of ref.map(vals)) {
    const i = pool.findIndex((g) => r.every((v) => g.includes(v)));
    if (i < 0) return false;
    pool.splice(i, 1);
  }
  return true;
}

/** Rows as a multiset of value tuples (column names and order ignored). @param {any[]} rows */
const bag = (rows) => JSON.stringify((rows ?? []).map((r) => Object.values(r).map((v) => JSON.stringify(v)).sort()).map((x) => JSON.stringify(x)).sort());

fs.mkdirSync(outDir, { recursive: true });
// A fixed port: Cache Storage is per origin, so the downloaded models are reused only on the same one.
const server = await start({ example: '02-wasm-text2cypher', port: Number(process.env.EX02_EVAL_PORT ?? 8712) });
const ctx = await chromium.launchPersistentContext(path.join(ROOT, '.cache', 'ex02-chrome'), { channel: 'chrome', headless: !headed });
try {
  for (const id of models) {
    const page = await ctx.newPage();
    page.setDefaultTimeout(0);
    await page.goto(`${server.base}?model=${encodeURIComponent(id)}`);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 120000 });
    const gpu = await page.textContent('[data-testid="gpu"]');
    console.log(`${id}: ${gpu?.trim()}`);
    // A cached model loads by itself; otherwise press Load.
    await page.waitForFunction(() => document.querySelector('[data-testid="load-model"]')?.hasAttribute('disabled') === false || ['ready', 'loading'].includes(document.body.dataset.llm ?? ''), null, { timeout: 120000 });
    if (!['ready', 'loading'].includes(await page.evaluate(() => document.body.dataset.llm ?? ''))) await page.click('[data-testid="load-model"]');
    const t0 = Date.now();
    let last = '';
    while (!['ready', 'failed'].includes(await page.evaluate(() => document.body.dataset.llm ?? ''))) {
      const p = (await page.textContent('.progress .ptext'))?.trim() ?? '';
      if (p && p !== last && Date.now() - t0 > 2000) { console.log(`  ${p}`); last = p; }
      await page.waitForTimeout(5000);
    }
    const loadSecs = (Date.now() - t0) / 1000;
    if ((await page.evaluate(() => document.body.dataset.llm)) === 'failed') {
      console.log(`${id}: FAILED to load: ${await page.textContent('[data-testid="model-note"]')}`);
      await page.close();
      continue;
    }
    console.log(`${id}: loaded in ${loadSecs.toFixed(0)} s${repair ? '; repair once: on' : ''}`);
    if (repair) await page.check('[data-testid="repair"]');
    const lines = [`# ${id} on ${questions.length} questions${repair ? ', repair once on' : ''} (harness/llm-eval.mjs; not diffed)`, `GPU: ${gpu?.trim()}`, `load: ${loadSecs.toFixed(0)} s`, ''];
    const tally = { grounded: { valid: 0, ran: 0, covers: 0, rows: 0, secs: 0 }, bare: { valid: 0, ran: 0, covers: 0, rows: 0, secs: 0 } };
    const table = ['| question | reference | grounded valid/ran/covers/rows | bare valid/ran/covers/rows | s (grounded, bare) |', '|---|---|---|---|---|'];
    for (const q of questions) {
      const res = await page.evaluate(async (question) => {
        const ex = /** @type {any} */ (window).ex02;
        const r = await ex.answer(question);
        return r;
      }, q);
      const ref = await page.evaluate(async ([question, exact]) => {
        const ex = /** @type {any} */ (window).ex02;
        const c = /** @type {any} */ (ex.state.canned);
        const kw = c.canned.find((/** @type {any} */ e) => e.keywords.some((/** @type {string} */ k) => question.toLowerCase().includes(k))) ?? c.fallback;
        return { with: await ex.run(exact ?? kw.cypher), without: await ex.run(kw.bare), kind: exact ? 'cookbook' : 'canned' };
      }, [q, cookbookCypher.get(q) ?? null]);
      const score = (/** @type {any} */ r, /** @type {any} */ refR) => {
        const valid = r.issues.length === 0;
        const ran = valid && !r.error;
        const rows = ran && bag(r.rows) === bag(refR.rows);
        return { valid, ran, covers: ran && covers(r.rows, refR.rows), rows };
      };
      const g = score(res.with, ref.with);
      const b = score(res.without, ref.without);
      const gs = res.generation.grounded.seconds;
      const bs = res.generation.bare.seconds;
      for (const [k, s, secs] of /** @type {const} */ ([['grounded', g, gs], ['bare', b, bs]])) {
        tally[k].valid += Number(s.valid); tally[k].ran += Number(s.ran); tally[k].covers += Number(s.covers); tally[k].rows += Number(s.rows); tally[k].secs += secs;
      }
      const mark = (/** @type {any} */ s) => `${s.valid ? 'y' : 'n'}/${s.ran ? 'y' : 'n'}/${s.covers ? 'y' : 'n'}/${s.rows ? 'y' : 'n'}`;
      table.push(`| ${q} | ${ref.kind} | ${mark(g)} | ${mark(b)} | ${gs.toFixed(1)}, ${bs.toFixed(1)} |`);
      const rep = (/** @type {any} */ x) => (x.repaired ? `  (repaired once; the first query: ${x.repaired.first.replace(/\n\s*/g, ' ')} -- ${x.repaired.problem})` : '');
      lines.push(`## ${q}`, '', 'grounded:', res.with.cypher, ...(rep(res.generation.grounded) ? [rep(res.generation.grounded)] : []), `  issues: ${res.with.issues.join('; ') || 'none'}; notes: ${res.with.notes.join('; ') || 'none'}; error: ${res.with.error ?? 'none'}; rows ${res.with.rows.length} (reference ${ref.with.rows.length})`,
        'bare:', res.without.cypher, `  issues: ${res.without.issues.join('; ') || 'none'}; notes: ${res.without.notes.join('; ') || 'none'}; error: ${res.without.error ?? 'none'}; rows ${res.without.rows.length} (reference ${ref.without.rows.length})`,
        `comparison: ${res.notes.join(' | ')}`, '');
      console.log(`  ${mark(g)} ${mark(b)}  ${gs.toFixed(1)}s ${bs.toFixed(1)}s  ${q} (${ref.kind})`);
    }
    const n = questions.length;
    const sum = (/** @type {any} */ t) => `valid ${t.valid}/${n}, ran ${t.ran}/${n}, covers the reference ${t.covers}/${n}, the reference's rows exactly ${t.rows}/${n}, mean ${(t.secs / n).toFixed(1)} s per query`;
    const summary = [`grounded: ${sum(tally.grounded)}`, `bare:     ${sum(tally.bare)}`];
    fs.mkdirSync(outDir, { recursive: true });
    const name = `${id}${repair ? '-repair' : ''}.txt`;
    fs.writeFileSync(path.join(outDir, name), [...lines.slice(0, 4), ...summary, '', ...table, '', ...lines.slice(4)].join('\n'));
    console.log(`${id}:\n  ${summary.join('\n  ')}\n  -> ${path.relative(process.cwd(), path.join(outDir, name))}`);
    await page.close();
  }
} finally {
  await ctx.close();
  await server.close();
}
