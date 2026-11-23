#!/usr/bin/env node
// @ts-check
/**
 * harness/drive.mjs: example 02's browser section. Headless Chromium (Playwright's) against dist/,
 * served as GitHub Pages serves it (lib/serve.mjs: the sub-path, no custom headers, the page's own
 * CSP <meta>), in canned mode (?llm=canned: CI has no GPU, and model output is not byte-stable).
 *
 *   node harness/drive.mjs [--out out/browser.txt]          (after npm run build)
 *   node harness/drive.mjs --smoke --base-url <deployed URL> (a deployed site: boots, asks, no CSP errors)
 *
 * What it checks, printed deterministically (no timings, ports or paths):
 *   - the page boots: Relate's version, the ontology through the SDK (its checks tab), the graph
 *     drawn by NVL, no console errors and no CSP violations;
 *   - every suggested question through the Ask path (window.ex02.answer, as the button runs it):
 *     both queries, their checks and rows, and the A/B notes; one through the real button and chip;
 *   - the rows equal the Node section's for the same queries (out/queries.json from harness/run.mjs);
 *   - the "Run your own Cypher" box: a read, a write the ontology check blocks, a syntax error
 *     Relate cannot plan, and a query with a name the ontology lacks (Relate's advisory notes);
 *   - without ?llm=canned, in a browser whose WebGPU cannot run the models (headless Chromium has no
 *     16-bit shaders), the page falls back to the canned answers and says why.
 * A check that fails prints `drive.mjs: FAIL: …` on stderr and exits 1, after writing the report.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { start } from '../../../lib/serve.mjs';

const EX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (/** @type {string} */ k, /** @type {string|null} */ d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const smoke = args.includes('--smoke');
const outFile = opt('--out', path.join(EX, 'out', 'browser.txt'));
const baseUrl = opt('--base-url', null);

const lines = [];
/** Lines for the report; no argument is an empty line. @param {...string} ss */
const say = (...ss) => lines.push(...(ss.length ? ss : ['']));
let failed = 0;
/** @param {boolean} ok @param {string} what */
function check(ok, what) {
  if (!ok) { failed++; process.stderr.write(`drive.mjs: FAIL: ${what}\n`); }
  return ok ? 'yes' : 'NO';
}
/** JSON with object keys sorted (harness/run.mjs canon). @param {unknown} v @returns {string} */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(/** @type {any} */ (v)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

const server = baseUrl ? null : await start({ example: '02-wasm-text2cypher' });
const writeReport = () => {
  const text = `${lines.join('\n')}\n`;
  if (smoke) process.stdout.write(text);
  else fs.writeFileSync(/** @type {string} */ (outFile), text);
};
const base = baseUrl ?? /** @type {any} */ (server).base;
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  /** @type {string[]} */ const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await page.goto(`${base}?llm=canned`);
  await page.waitForFunction(() => ['1', 'failed'].includes(document.body.dataset.ready ?? ''), null, { timeout: 120000 });
  const ready = await page.evaluate(() => document.body.dataset.ready);
  say('# Example 02 in headless Chromium (harness/drive.mjs): dist/ as GitHub Pages serves it, ?llm=canned');
  say('');
  say(`boots: ${check(ready === '1', 'the page boots')}; Relate ${await page.evaluate(() => document.body.dataset.relate)}; llm ${await page.evaluate(() => document.body.dataset.llm)}`);
  say(`header: ${await page.textContent('[data-testid="mode"]')}`);
  const nodes = await page.$$eval('#ontology details', (d) => d.length);
  say(`ontology browser: ${nodes} collapsible entries (nodes, relationships, cookbook)`);
  await page.click('[data-testid="tab-checks"]');
  const sets = await page.$$eval('#checks .set', (els) => els.map((e) => [...e.children].map((c) => c.textContent?.trim()).join(' ')));
  say(`checks tab (the Ontology Graph Spec SDK): ${sets.join('; ')}`);
  check(sets.includes('decode clean') && sets.includes('core clean'), 'the SDK reports decode and core clean');
  await page.waitForFunction(() => document.querySelectorAll('#graph canvas').length > 0, null, { timeout: 30000 }).catch(() => {});
  say(`the graph: NVL drew ${check((await page.$$eval('#graph canvas', (c) => c.length)) > 0, 'NVL draws the graph') === 'yes' ? 'it' : 'nothing'}`);
  const counts = await page.evaluate(async () => {
    const ex = /** @type {any} */ (window).ex02;
    const n = await ex.run('MATCH (n) RETURN count(n) AS n');
    const r = await ex.run('MATCH ()-[r]->() RETURN count(r) AS n');
    return [n.rows[0]?.n, r.rows[0]?.n];
  });
  say(`the store: ${counts[0]} nodes, ${counts[1]} relationships`);

  if (!smoke) {
    say('');
    say('## every suggested question, as the Ask button answers it (canned answers; rows sorted by canonical JSON)');
    const canned = JSON.parse(fs.readFileSync(path.join(EX, 'data', 'canned.json'), 'utf8'));
    const node = JSON.parse(fs.readFileSync(path.join(EX, 'out', 'queries.json'), 'utf8'));
    const byCypher = new Map(node.queries.map((/** @type {any} */ q) => [q.cypher, q.rows]));
    let same = 0;
    let compared = 0;
    for (const q of canned.suggested) {
      const res = await page.evaluate((question) => /** @type {any} */ (window).ex02.answer(question), q);
      say('', `### ${q}`);
      for (const [k, r] of /** @type {const} */ ([['grounded', res.with], ['bare', res.without]])) {
        const rows = r.rows.map(canon).sort();
        say(`${k}: ${r.cypher.replace(/\n\s*/g, ' ')}`);
        say(`  checks: ${r.issues.length ? `blocked: ${r.issues.join('; ')}` : 'pass'}${r.notes.length ? `; Relate: ${r.notes.join('; ')}` : ''}${r.error ? `; error: ${r.error}` : ''}`);
        say(`  ${rows.length} row(s)`);
        for (const row of rows) say(`    ${row}`);
        if (byCypher.has(r.cypher)) {
          compared++;
          if (canon(byCypher.get(r.cypher)) === canon(rows)) same++;
        }
      }
      say(`notes: ${res.notes.join(' | ')}`);
    }
    say('', `the rows equal the Node section's (out/queries.json) for the same query: ${check(same === compared && compared > 0, 'browser rows equal Node rows')} (${same} of ${compared})`);

    say('', '## the Ask button and a chip');
    await page.click('#chips .chip >> nth=3');
    await page.waitForFunction(() => document.body.dataset.busy === '0' && !(/** @type {HTMLElement} */ (document.querySelector('#compare'))).hidden, null, { timeout: 30000 });
    const q = await page.inputValue('[data-testid="question"]');
    const withText = (await page.textContent('[data-testid="card-with"]')) ?? '';
    const withoutText = (await page.textContent('[data-testid="card-without"]')) ?? '';
    say(`chip 4 asks ${JSON.stringify(q)}: the cards show both queries and their rows: ${check(withText.includes('WITH the ontology') && withoutText.includes('WITHOUT the ontology') && /row\(s\)/.test(withText), 'the cards render')}`);
    say(`comparison: ${(await page.$$eval('[data-testid="compare"] li', (li) => li.map((x) => x.textContent?.trim()))).join(' | ')}`);

    say('', '## run your own Cypher (the same checks, the same store)');
    await page.click('#own summary');
    for (const [label, cypher] of [
      ['a read', "MATCH (p:Person)-[:CEO_OF]->(c:Company) RETURN p.name AS ceo, c.name AS company ORDER BY company"],
      ['a write', "MATCH (c:Company {id: 'halcyon'}) DETACH DELETE c"],
      ['a syntax error', 'MATCH (c:Company RETURN c'],
      ['an unknown property', "MATCH (c:Company) WHERE c.revenue > 10 RETURN c.name"],
    ]) {
      await page.fill('[data-testid="own-cypher"]', cypher);
      await page.click('[data-testid="own-run"]');
      await page.waitForSelector('[data-testid="own-card"]:not([hidden])');
      await page.waitForTimeout(200);
      const card = await page.$eval('[data-testid="own-card"]', (el) => ({
        verdicts: [...el.querySelectorAll('.verdict')].map((v) => v.textContent?.trim()),
        exec: el.querySelector('.exec')?.textContent?.trim(),
        rows: [...el.querySelectorAll('table.rows tr')].slice(1).map((tr) => [...tr.children].map((td) => td.textContent).join(' / ')),
      }));
      say(`${label}: ${cypher}`);
      for (const v of card.verdicts) say(`  ${v}`);
      say(`  ${card.exec}`);
      for (const r of card.rows) say(`    ${r}`);
    }
    const after = await page.evaluate(async () => (await /** @type {any} */ (window).ex02.run('MATCH (n) RETURN count(n) AS n')).rows[0]?.n);
    say(`the store afterwards: ${after} nodes (unchanged: ${check(after === counts[0], 'the store is unchanged')})`);

    say('', '## without ?llm=canned, where WebGPU cannot run the models');
    const page2 = await ctx.newPage();
    page2.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    await page2.goto(base);
    await page2.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 120000 });
    await page2.waitForFunction(() => !/Checking/.test(document.querySelector('[data-testid="gpu"]')?.textContent ?? ''), null, { timeout: 30000 });
    const canCanned = await page2.evaluate(() => {
      const c = /** @type {HTMLInputElement} */ (document.querySelector('[data-testid="use-canned"]'));
      return { checked: c.checked, disabled: c.disabled, llm: document.body.dataset.llm, load: /** @type {HTMLButtonElement} */ (document.querySelector('[data-testid="load-model"]')).disabled };
    });
    const gpuText = (await page2.textContent('[data-testid="gpu"]')) ?? '';
    say(`the model panel says there is no usable WebGPU and the canned answers stand in: ${check(/^No usable WebGPU here/.test(gpuText) && canCanned.checked && canCanned.disabled && canCanned.load && canCanned.llm === 'canned', 'the no-WebGPU fallback')}`);
    await page2.close();
  }
  const csp = problems.filter((p) => /Content Security Policy|Refused to/.test(p));
  say('', `console errors: ${problems.length ? problems.join(' | ') : 'none'}; CSP violations: ${check(csp.length === 0, 'no CSP violations') === 'yes' ? 'none' : csp.length}`);
  check(problems.length === 0, 'no console or page errors');
} catch (e) {
  failed++;
  process.stderr.write(`drive.mjs: FAIL: ${String(/** @type {any} */ (e)?.message ?? e).split('\n')[0]}\n`);
} finally {
  await browser.close();
  await server?.close();
  writeReport();
}
process.exitCode = failed ? 1 : 0;
