#!/usr/bin/env node
// @ts-check
/**
 * harness/drive.mjs: example 03's browser section. Headless Chromium (Playwright's) against dist/,
 * served as GitHub Pages serves it (lib/serve.mjs: the sub-path, no custom headers, the page's own
 * CSP <meta>), with ?test=1 (no animation and no pacing, so every wait is for the engine).
 *
 *   node harness/drive.mjs [--out out/browser.txt]          (after npm run build)
 *   node harness/drive.mjs --smoke --base-url <deployed URL> (a deployed site: boots, remembers, recalls, no CSP errors)
 *   node harness/drive.mjs --smoke --screenshot screenshot.png   (after npm run build: also retake the picture
 *                                                                 the site's index page shows, 1280x800, dark theme)
 *
 * What it checks, printed deterministically (no timings, ports, paths or engine ids):
 *   - the page boots: Relate's version, the three conversations, an empty memory;
 *   - every scripted turn of every conversation, through the page's own code path (window.ex03.next,
 *     what the "Send the next message" button calls): each turn's tools, rows and reply equal the Node
 *     section's (out/replay.json from harness/run.mjs); what NVL holds equals what is stored; and
 *     what NVL has selected equals the paths the engine returned, with everything off them disabled.
 *     NVL draws to a canvas, so these read NVL's own state back (getNodes, getRelationships: web/graph.js
 *     stats), not pixels;
 *   - the buttons: the next-message button, Play, a citation, the scenario switch, Restart;
 *   - typed turns through the input box: a question, a note, a question about the note, two
 *     entities to connect;
 *   - the other two tabs: the list of what the agent knows, and the console (a read, two writes the
 *     graph type refuses, a result with paths, which the graph highlights);
 *   - the provenance toggle, the theme toggle (the one storage key the page writes carries the
 *     example's prefix), no console errors and no CSP violations.
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
const shot = opt('--screenshot', null);
const SCENARIOS = ['team', 'trip', 'code'];

const lines = [];
/** Lines for the report; no argument is an empty line. @param {...string} ss */
const say = (...ss) => lines.push(...(ss.length ? ss : ['']));
let failed = 0;
/** @param {boolean} ok @param {string} what */
function check(ok, what) {
  if (!ok) { failed++; process.stderr.write(`drive.mjs: FAIL: ${what}\n`); }
  return ok ? 'yes' : 'NO';
}

/** In the page: one scripted turn, summarised as harness/run.mjs summarises it, with what the DOM shows. */
const TURN = async () => {
  const ex = /** @type {any} */ (window).ex03;
  const res = await ex.next();
  if (!res) return null;
  const s = ex.state();
  return {
    reply: res.reply.parts.map((/** @type {any} */ p) => (p.text !== undefined ? p.text : ` [${p.n}]`)).join(''),
    tools: res.steps.map((/** @type {any} */ st) => ({ tool: st.tool, ids: st.rows ? st.rows.map((/** @type {any} */ r) => `${r.id}/${r.via ?? ''}`) : st.row ? st.row.trail : [] })),
    lit: [s.lit.strong.nodes.length, s.lit.strong.rels.length, s.lit.soft.nodes.length, s.lit.soft.rels.length],
    problems: res.problems,
    drawn: s.drawn,
    stored: s.stored,
    store: s.store,
    cards: document.querySelectorAll('#transcript .tool').length,
  };
};

/** In the page: the last reply as text, citations as [n], without the agent's label. */
const LAST_REPLY = () => {
  const el = [...document.querySelectorAll('#transcript .msg.agent')].at(-1);
  if (!el) return '';
  return [...el.childNodes].map((n) => (n instanceof HTMLElement ? (n.classList.contains('cite') ? ` [${n.textContent}]` : '') : n.textContent)).join('').replace(/\n/g, ' / ');
};

const server = baseUrl ? null : await start({ example: '03-wasm-agent-memory' });
const writeReport = () => {
  const text = `${lines.join('\n')}\n`;
  if (smoke) process.stdout.write(text);
  else fs.writeFileSync(/** @type {string} */ (outFile), text);
};
const base = baseUrl ?? /** @type {any} */ (server).base;
const browser = await chromium.launch();
try {
  // the index page's picture is taken in the dark theme, the brand's navy; every check runs in the default (light)
  const ctx = await browser.newContext(shot ? { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' } : { viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  /** @type {string[]} */ const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  const ready = async (/** @type {import('playwright').Page} */ p) => {
    await p.waitForFunction(() => ['1', 'failed'].includes(document.body.dataset.ready ?? ''), null, { timeout: 120000 });
    return p.evaluate(() => document.body.dataset.ready);
  };
  const idle = () => page.waitForFunction(() => document.body.dataset.busy === '0', null, { timeout: 30000 });
  const state = () => page.evaluate(() => /** @type {any} */ (window).ex03.state());

  // the picture is taken of the page as a visitor sees it: animated, each turn at its own pace
  await page.goto(`${base}?scenario=team${shot ? '' : '&test=1'}`);
  say(`# Example 03 in headless Chromium (harness/drive.mjs): dist/ as GitHub Pages serves it${shot ? '' : ', ?test=1'}`);
  say('');
  say(`boots: ${check((await ready(page)) === '1', 'the page boots')}; Relate ${await page.evaluate(() => document.body.dataset.relate)}`);
  say(`header: ${await page.textContent('[data-testid="engine"]')}`);
  const titles = await page.$$eval('[data-testid="scenarios"] button', (bs) => bs.map((b) => b.textContent));
  say(`conversations: ${titles.join(' | ')}`);
  const s0 = await state();
  say(`the memory starts empty: ${check(s0.store.nodes === 0 && s0.drawn.entities === 0, 'the memory starts empty')}; schema statements run: ${s0.calls}`);
  const brand = await page.evaluate(async () => {
    await document.fonts.ready;
    const logos = [...document.querySelectorAll('.brand .logo')].map((i) => /** @type {HTMLImageElement} */ (i));
    const shown = logos.filter((i) => getComputedStyle(i).display !== 'none');
    return {
      logo: shown.map((i) => `${i.getAttribute('src')?.split('/').pop()}, ${Math.round(i.getBoundingClientRect().width)}px wide, ${i.naturalWidth > 0 ? 'loaded' : 'NOT loaded'}`),
      fonts: ['600 16px "Public Sans"', '400 12px "IBM Plex Mono"'].map((f) => `${f.split('"')[1]}: ${document.fonts.check(f) ? 'loaded' : 'NOT loaded'}`),
      body: getComputedStyle(document.body).fontFamily.split(',')[0].replace(/"/g, ''),
    };
  });
  say(`brand: the logo is ${brand.logo.join('; ')}; text in ${brand.body}; ${brand.fonts.join(', ')}: ${check(brand.logo.length === 1 && /, loaded$/.test(brand.logo[0]) && parseInt(brand.logo[0].split(', ')[1], 10) >= 120 && brand.fonts.every((f) => f.endsWith(': loaded')) && brand.body === 'Public Sans', 'the brand assets load')}`);
  const gt = (await page.textContent('[data-testid="graphtype"]')) ?? '';
  say(`the graph type read back from the engine names ${['Session', 'Message', 'Entity', 'Memory'].filter((l) => gt.includes(`(:\`${l}\` =>`)).length} of 4 labels and ${['IN_SESSION', 'MENTIONS', 'FROM', 'ABOUT', 'SUPERSEDES'].filter((t) => gt.includes(`[:\`${t}\``)).length} of 5 relationship types`);

  if (smoke) {
    for (let i = 0; i < 4; i++) await page.evaluate(TURN);
    const s = await state();
    const rows = s.last.steps.find((/** @type {any} */ x) => x.tool === 'recall')?.rows.length ?? 0;
    say(`after four turns: ${s.drawn.entities} entities and ${s.drawn.memories} memories drawn; the fourth turn recalled ${rows} memories: ${check(s.drawn.memories === 6 && rows > 0, 'the deployed page remembers and recalls')}`);
    if (shot) {
      // on to the seventh turn, where recall reaches people nobody linked to the question
      for (let i = 0; i < 3; i++) await page.evaluate(TURN);
      await page.waitForTimeout(4000);   // the path has finished lighting and the layout is at rest
      await page.screenshot({ path: path.resolve(shot) });
      say(`screenshot: ${shot}`);
    }
  } else {
    const node = JSON.parse(fs.readFileSync(path.join(EX, 'out', 'replay.json'), 'utf8'));
    say('', '## every scripted turn, as the page runs it');
    for (const id of SCENARIOS) {
      if (id !== 'team') {
        await page.click(`[data-testid="scenarios"] button[data-id="${id}"]`);
        await page.waitForFunction((want) => document.body.dataset.scenario === want && document.body.dataset.cursor === '0', id);
      }
      const want = node.turns[id];
      let same = 0;
      let drawnOk = 0;
      let litOk = 0;
      let n = 0;
      /** @type {any} */ let last = null;
      for (;;) {
        const t = await page.evaluate(TURN);
        if (!t) break;
        const w = want[n++];
        if (w && t.reply === w.reply && JSON.stringify(t.tools) === JSON.stringify(w.tools) && JSON.stringify(t.lit) === JSON.stringify(w.lit) && t.problems.length === 0) same++;
        else process.stderr.write(`drive.mjs: ${id} turn ${n} differs from the Node section\n`);
        // what NVL holds is what is stored: every entity and memory, and their ABOUT and SUPERSEDES
        // relationships (messages and sessions stay hidden unless a path runs through them)
        const d = t.drawn;
        const provenance = d.messages + d.sessions;
        if (d.entities === t.stored.entities && d.memories === t.stored.memories && d.superseded === t.stored.superseded
          && (provenance > 0 ? d.edges >= t.stored.about + t.stored.supersedes : d.edges === t.stored.about + t.stored.supersedes) && d.canvases > 0) drawnOk++;
        // what NVL has selected is what the engine returned; with a highlight on, everything on no path is disabled
        const total = d.entities + d.memories + provenance;
        const lit = t.lit[0] + t.lit[2] > 0;
        if (d.selected.nodes === t.lit[0] && d.selected.rels === t.lit[1]
          && d.disabled.nodes === (lit ? total - t.lit[0] - t.lit[2] : 0) && d.disabled.rels === (lit ? d.edges - t.lit[1] - t.lit[3] : 0)) litOk++;
        last = t;
      }
      say('', `### ${titles[SCENARIOS.indexOf(id)]} (${id}): ${n} turns`);
      say(`each turn's tools, rows, reply and highlight equal the Node section's: ${check(same === n && n === want.length, `${id}: the page's turns equal Node's`)} (${same} of ${want.length})`);
      say(`after each turn, NVL holds the store's entities, memories and their relationships: ${check(drawnOk === n, `${id}: drawn equals stored`)} (${drawnOk} of ${n})`);
      say(`after each turn, NVL's selected elements are the returned paths', and the rest are disabled: ${check(litOk === n, `${id}: lit equals returned`)} (${litOk} of ${n})`);
      if (id === 'team') say(`NVL draws to ${last.drawn.canvases} canvases and adds no element per node`);
      // the camera: once the layout rests, every node is inside the panel (web/graph.js frame)
      await page.waitForTimeout(1600);
      const fits = await page.evaluate(() => {
        const v = /** @type {any} */ (window).ex03.view();
        const out = v.nodes.filter((/** @type {any} */ n) => {
          const r = n.size * v.scale;
          return n.client.x - r < -1 || n.client.y - r < -1 || n.client.x + r > v.width + 1 || n.client.y + r > v.height + 1;
        });
        return { nodes: v.nodes.length, outside: out.length };
      });
      say(`the camera keeps the whole graph in the panel: ${check(fits.outside === 0 && fits.nodes > 0, `${id}: the graph fits the panel`)} (${fits.nodes} nodes drawn, ${fits.outside} outside)`);
      say(`at the end: ${last.store.nodes} nodes and ${last.store.rels} relationships stored; drawn: ${last.drawn.entities} entities, ${last.drawn.memories} memories (${last.drawn.superseded} replaced), ${last.drawn.messages} messages, ${last.drawn.sessions} sessions; ${last.cards} tool cards in the conversation`);
    }

    say('', '## the buttons');
    await page.click('[data-testid="scenarios"] button[data-id="team"]');
    await page.waitForFunction(() => document.body.dataset.scenario === 'team' && document.body.dataset.cursor === '0');
    say(`switching conversation empties the memory: ${check((await state()).store.nodes === 0, 'a switch empties the memory')}`);
    const nextText = await page.textContent('#next-text');
    await page.click('[data-testid="next"]');
    await idle();
    const first = { ...(await page.evaluate(() => ({
      user: document.querySelector('#transcript .msg.user')?.textContent,
      tool: document.querySelector('#transcript .tool .tool-name')?.textContent,
      sum: document.querySelector('#transcript .tool .tool-sum')?.textContent,
    }))), reply: await page.evaluate(LAST_REPLY) };
    say(`the next-message button sends ${JSON.stringify(nextText)}: ${check(first.user === nextText && first.tool === 'remember', 'the next-message button runs a turn')}`);
    say(`  the card: ${first.tool}: ${first.sum}`);
    say(`  the reply: ${first.reply}`);
    await page.click('[data-testid="play"]');
    await page.waitForFunction(() => document.body.dataset.cursor === '9' && document.body.dataset.busy === '0', null, { timeout: 60000 });
    const done = await page.evaluate(() => ({ next: /** @type {HTMLElement} */ (document.querySelector('#next')).hidden, chips: [...document.querySelectorAll('#chips button')].map((b) => b.textContent), caption: document.querySelector('#caption-text')?.textContent }));
    say(`Play runs the rest: ${check(done.next && done.chips.length === 4, 'Play runs to the end and offers the chips')}; the caption: ${done.caption}`);
    say(`then the page offers: ${done.chips.join(' | ')}`);
    await page.click('#transcript .msg.agent:last-of-type .cite >> nth=0');
    const one = (await state()).drawn.selectedMemories;
    say(`clicking a citation selects that memory alone: ${check(one.length === 1, 'a citation lights its memory')} (${one.join(', ')})`);

    say('', '## typed turns (no script: web/agent.js freeTurn)');
    for (const text of ['Who owns the payments service?', 'Dana is on holiday in August', 'What is Dana doing in August?', 'How are Priya and Dana connected?']) {
      await page.fill('[data-testid="input"]', text);
      await page.click('[data-testid="send"]');
      await page.waitForFunction((t) => document.body.dataset.busy === '0' && [...document.querySelectorAll('#transcript .msg.user')].at(-1)?.textContent === t, text);
      const got = await page.evaluate(() => ({
        tool: [...document.querySelectorAll('#transcript .tool')].at(-1)?.querySelector('.tool-name')?.textContent,
        sum: [...document.querySelectorAll('#transcript .tool')].at(-1)?.querySelector('.tool-sum')?.textContent,
      }));
      const lit = (await state()).drawn.selected;
      say(`${JSON.stringify(text)}`, `  ${got.tool}: ${got.sum}`, `  reply: ${await page.evaluate(LAST_REPLY)}`, `  selected in NVL: ${lit.nodes} nodes, ${lit.rels} relationships`);
    }
    const typed = await state();
    say(`the note is in the store and drawn: ${check(typed.drawn.memories === 8, 'a typed note is stored and drawn')} (${typed.drawn.memories} memories)`);

    say('', '## What it knows');
    await page.click('[data-testid="tab-ledger"]');
    const ledger = await page.$$eval('[data-testid="ledger"] .ent', (es) => es.map((e) => `${e.querySelector('.ent-name')?.textContent}: ${e.querySelectorAll('.mem:not(.old)').length} current, ${e.querySelectorAll('.mem.old').length} replaced`));
    for (const l of ledger) say(l);
    check(ledger.length === 8, 'the list has every entity');

    say('', '## Under the hood');
    await page.click('[data-testid="tab-hood"]');
    say(`statements listed: ${await page.$$eval('[data-testid="calls"] li', (l) => l.length)} (the count on the tab: ${await page.textContent('#calls-count')})`);
    for (const [label, cypher] of [
      ['a read', 'MATCH (now:Memory)-[:SUPERSEDES]->(was:Memory) RETURN was.text AS was, now.text AS now, now.rationale AS because'],
      ['a memory without its kind or vector', "CREATE (:Memory {id: 'oops', text: 'no kind, no vector'})"],
      ['an edge between two entities', 'MATCH (a:Entity), (b:Entity) WHERE a <> b WITH a, b ORDER BY a.key, b.key LIMIT 1 CREATE (a)-[:ABOUT]->(b)'],
      ['a result with paths', "MATCH p = (:Entity {key: 'dana'})<-[:ABOUT]-(:Memory)-[:ABOUT]->(:Entity) RETURN p"],
    ]) {
      await page.fill('[data-testid="cypher"]', cypher);
      const before = await page.evaluate(() => /** @type {any} */ (window).ex03.state().calls);
      await page.click('[data-testid="run"]');
      await page.waitForFunction((n) => /** @type {any} */ (window).ex03.state().calls > n, before);
      await page.waitForTimeout(100);
      const got = await page.$eval('[data-testid="result"]', (el) => ({
        state: /** @type {HTMLElement} */ (el).dataset.state,
        error: el.querySelector('.result-error')?.textContent?.split('\n')[0].replace(/`constraint_[0-9a-f]+`/g, '`constraint_<generated>`'),
        meta: el.querySelector('.result-meta')?.textContent,
        rows: [...el.querySelectorAll('table.rows tr')].slice(1).map((tr) => [...tr.children].map((td) => td.textContent).join(' | ')),
      }));
      say(`${label}: ${cypher}`);
      say(got.state === 'error' ? `  refused: ${got.error}` : `  ${got.meta}`);
      for (const r of got.rows) say(`    ${r.length > 200 ? `${r.slice(0, 200)}…` : r}`);
    }
    const afterConsole = await state();
    say(`the refused writes left the store as it was: ${check(afterConsole.store.nodes === typed.store.nodes && afterConsole.store.rels === typed.store.rels, 'refused writes change nothing')} (${afterConsole.store.nodes} nodes, ${afterConsole.store.rels} relationships)`);
    await page.click('[data-testid="tab-graph"]');
    const shown = { strong: (await state()).drawn.selected.nodes, caption: await page.textContent('#caption-text') };
    say(`the paths in the last result are selected in the graph: ${check(shown.strong === 3, 'a console result with paths is highlighted')} (${shown.strong} nodes; "${shown.caption}")`);

    say('', '## toggles');
    const before = await state();
    await page.check('[data-testid="provenance"]');
    const prov = await state();
    say(`"messages and sessions" draws the provenance: ${check(prov.drawn.messages === 5 && prov.drawn.sessions === 3 && before.drawn.messages === 0, 'the provenance toggle')} (${prov.drawn.messages} messages, ${prov.drawn.sessions} sessions, where there were ${before.drawn.messages})`);
    await page.click('#theme');
    const theme = await page.evaluate(() => ({ attr: document.documentElement.dataset.theme, keys: Object.keys(localStorage) }));
    say(`the theme button sets the theme (${theme.attr}) and the page's only storage key: ${theme.keys.join(', ')}: ${check(theme.keys.length === 1 && theme.keys[0].startsWith('ex03.'), 'storage keys carry the ex03 prefix')}`);
    const rethemed = await state();
    say(`NVL redraws in the new theme and keeps the graph: ${check(rethemed.drawn.memories === prov.drawn.memories && rethemed.drawn.messages === prov.drawn.messages, 'the graph survives a theme change')} (${rethemed.drawn.entities} entities, ${rethemed.drawn.memories} memories, ${rethemed.drawn.messages} messages)`);
    await page.click('[data-testid="restart"]');
    await page.waitForFunction(() => document.body.dataset.cursor === '0' && /** @type {any} */ (window).ex03.state().store.nodes === 0);
    const restarted = await page.evaluate(() => ({ intro: !!document.querySelector('#transcript .intro'), nodes: /** @type {any} */ (window).ex03.state().drawn.entities + /** @type {any} */ (window).ex03.state().drawn.memories, next: document.querySelector('#next-text')?.textContent }));
    say(`Restart empties the memory and the conversation: ${check(restarted.intro && restarted.nodes === 0, 'Restart')}; the next message is again ${JSON.stringify(restarted.next)}`);
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
