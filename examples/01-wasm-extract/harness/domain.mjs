#!/usr/bin/env node
// @ts-check
/**
 * harness/domain.mjs: one bundled ontology and its documents, end to end, while you write them
 * (D20, D23). From the example's directory:
 *
 *   node harness/domain.mjs <ontology id> [--lint] [--model small|base] [--no-cache] [--show]
 *
 * Prints, for the ontology: the bar (harness/corpus.mjs lintBar), what the model is asked and the
 * schema's size; for each of its documents (samples.json, then data/samples/heldout/<id>.md): the
 * corpus lint, then (unless --lint) the extraction through gliner-rs and the page's pipeline at the
 * defaults (web/pipeline.js, web/store.js), scored against the gold (gold v2: aliases folded in,
 * recall by how the text states a fact, the distractors' fate), what waits in review; then every
 * tool run on the extracted store and on the gold graph (corpus.mjs goldGraph), with its rows.
 * --show adds every kept, review and dropped mention and claim. The model's answers come from
 * .cache/ex01-infer/ when it has them (--no-cache asks again). Exit 1 when a lint fails, a tool of
 * a curated ontology returns no rows on the extracted store or errors, 2 on bad arguments.
 * Nothing here is diffed: harness/run.mjs prints the same checks for every domain into out/.
 */
import * as cl from '../../../lib/relate_wasm.mjs';
import * as pipeline from '../web/pipeline.js';
import * as store from '../web/store.js';
import { splitSentences } from '../web/split.js';
import { schemaChars } from '../web/ontology.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EX, HOW, breakdown, cachedAnswers, goldGraph, goldKeys, lintBar, lintCoverage, lintDocument, loadIndex, loadOntologies, modelSetup, scoreProperties,
} from './corpus.mjs';
import { studioConversions } from './convert.mjs';
import { cachedModel } from './infer.mjs';

const VER = '1.3.0';
const argv = process.argv.slice(2);
const id = argv.find((a) => !a.startsWith('--'));
const flag = (f) => argv.includes(f);
const opt = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
if (!id) {
  console.error('usage: node harness/domain.mjs <ontology id> [--lint] [--model small|base] [--no-cache] [--show]');
  process.exit(2);
}
const which = /** @type {'small'|'base'} */ (opt('--model', 'small'));
const f3 = (x) => Number(x).toFixed(3);
let failed = false;
/** @type {string[]} */
const verdict = [];
const out = (s = '') => process.stdout.write(`${s}\n`);
const problems = (title, ps) => {
  out(ps.length ? `${title}: ${ps.length} problem${ps.length === 1 ? '' : 's'}` : `${title}: holds`);
  for (const p of ps) out(`  - ${p}`);
  if (ps.length) failed = true;
};

// ---- the ontology ----------------------------------------------------------------------------------
const all = loadOntologies();
if (all.errors?.has(id)) {
  out(`# ${id}: the ontology does not load\n${all.errors.get(id)}\n\nVERDICT: not ready: the ontology does not load`);
  process.exit(1);
}
let entry = all.get(id);
const studio = studioConversions();
if (studio.errors?.has(id)) {
  out(`# ${id}: the overlay does not convert\n${studio.errors.get(id)}\n\nVERDICT: not ready: the overlay does not convert`);
  process.exit(1);
}
const fresh = studio.find((c) => c.o.id === id);
if (fresh) {
  const committed = entry ? readFileSync(join(EX, entry.file), 'utf8') : null;
  if (committed !== fresh.text) out(`NOTE: data/ontologies/ogs/studio/${id}.ontology.yaml is not a fresh conversion of its overlay; using the fresh one (run node harness/convert.mjs)`);
  entry = { o: fresh.o, file: `data/ontologies/${fresh.file}`, group: 'studio' };
}
if (!entry) {
  console.error(`domain.mjs: no bundled ontology ${id} (data/ontologies/domains/${id}.ontology.yaml, or a studio overlay)`);
  process.exit(2);
}
const o = entry.o;
out(`# ${o.title || o.id} (${o.id}, ${entry.group}): ${entry.file}`);
out(`${o.types.length} kinds, ${o.relations.length} links, ${o.tools.length} tools; the model reads ${schemaChars(new Map(o.types.map((t) => [t.id, t.ask])), o.relations)} characters of schema per sentence (budget 2000)`);
for (const t of o.types) out(`  kind ${t.id}: ${t.ask ? `"${t.ask.label}"${t.ask.description ? `: ${t.ask.description}` : ''} [${t.askMode}]` : `not asked (${t.unasked})`}${t.keyProp ? ` key ${t.keyProp} ~ /${t.keyPattern}/` : ''}`);
for (const r of o.relations) out(`  link ${r.id}: ${r.ask ? `"${r.ask}"` : 'not asked'}`);
problems('the bar', lintBar(o));

// ---- the documents ---------------------------------------------------------------------------------
const docs = loadIndex().filter((d) => d.ontology === id);
if (!docs.length) out('no documents name this ontology yet (data/samples/samples.json, data/samples/heldout/)');
for (const d of docs) problems(`${d.id} (${d.role}, ${d.file})`, lintDocument(o, d));
problems('coverage', lintCoverage(o, docs));
if (flag('--lint') || !docs.length) process.exit(failed ? 1 : 0);

// ---- extraction ------------------------------------------------------------------------------------
const setup = modelSetup(which, pipeline.BUILD);
const requests = docs.flatMap((d) => pipeline.modelRequests(o, d.text));
const t0 = performance.now();
const got = await cachedAnswers(requests, { scope: setup.scope, model: () => setup.load(), off: flag('--no-cache') });
out(`\nthe model (${setup.M.name}): ${requests.length} calls (${requests.filter((r) => r.schema.structures).length} of them for values), ${got.hits} from the cache, ${got.misses} asked, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
const model = cachedModel(got.model ?? { stub: true }, got.answers).handle;
const mod = await cl.loadNode(VER);

/** A store with the ontology and these documents extracted, gated and published at the defaults. */
async function extracted(list) {
  const db = new mod.RelateDb();
  store.openStore(db, cl, o, {}, { model: which });
  for (const d of list) await pipeline.run({ db, cl, model, modelInfo: setup.info, ontology: o, text: d.text, title: d.id });
  return db;
}
const own = docs.filter((d) => d.role !== 'heldout');
const held = docs.filter((d) => d.role === 'heldout');
const stores = [[own, own.length ? await extracted(own) : null], [held, held.length ? await extracted(held) : null]];

for (const [list, db] of stores) {
  if (!db) continue;
  const golds = list.map((d) => ({ d, g: goldKeys(o, d.gold) }));
  const rows = list.map((d) => {
    const g = goldKeys(o, d.gold);
    return { doc: cl.exec(db, 'MATCH (x:_Document {title: $t}) RETURN x.id AS id', { t: d.id }).rows[0]?.id, title: d.id, entities: g.entities, relations: g.relations };
  });
  const score = store.scoreAgainstGold(db, cl, rows, { from: 'gate' });
  for (const [i, d] of list.entries()) {
    const g = golds[i].g;
    const e = score.entities.docs.find((x) => x.title === d.id);
    const r = score.relations.docs.find((x) => x.title === d.id);
    const b = breakdown({ entities: e, relations: r }, g);
    out(`\n## ${d.id} (${d.role}): ${splitSentences(d.text).length} sentences`);
    out(`entities  P ${f3(b.entities.precision)} R ${f3(b.entities.recall)} F1 ${f3(b.entities.f1)}  (tp ${b.entities.tp}, fp ${b.entities.fp}, fn ${b.entities.fn}, alias duplicates ${b.entities.dup})`);
    out(`relations P ${f3(b.relations.precision)} R ${f3(b.relations.recall)} F1 ${f3(b.relations.f1)}  (tp ${b.relations.tp}, fp ${b.relations.fp}, fn ${b.relations.fn}); reachable recall ${b.reachable.found}/${b.reachable.gold}`);
    out(`by how: ${Object.entries(b.byHow).map(([h, x]) => `${h} ${x.found}/${x.gold}${HOW[/** @type {keyof typeof HOW} */ (h)] ? '' : ' (unreachable)'}`).join(', ')}`);
    const docKey = rows[i].doc;
    for (const x of g.distractors) {
      const [h, t, rel] = x.key.split('|');
      const c = cl.exec(db, 'MATCH (c:_Claim {doc: $doc}) WHERE c.hn = $h AND c.tn = $t AND c.rel = $rel RETURN c.band AS band, c.rule AS rule, c.p AS p ORDER BY p DESC',
        { doc: docKey, h, t, rel }).rows;
      out(`distractor (${x.family}) ${x.d.source} -[${x.d.type}]-> ${x.d.target}: ${c.length ? c.map((y) => `${y.band} by ${y.rule} at ${f3(y.p)}`).join('; ') : 'never proposed'}`);
      if (c.some((y) => y.band === 'keep')) out('  ^ KEPT: the gate kept a claim the text does not assert');
    }
    const review = cl.exec(db, `MATCH (m:_Mention {doc: $doc}) WHERE m.band = 'review' WITH count(m) AS m
OPTIONAL MATCH (c:_Claim {doc: $doc}) WHERE c.band = 'review' RETURN m, count(c) AS c`, { doc: docKey }).rows[0];
    out(`in review: ${review.m} mentions, ${review.c} claims`);
    // D27: the values of extracted properties, against the gold's
    if (o.types.some((t) => t.attributes.length)) {
      const attrs = store.readGate(db, cl).attributes;
      const ps = scoreProperties(attrs, g, docKey);
      const mine = attrs.filter((x) => x.doc === docKey);
      const bands = ['keep', 'review', 'drop'].map((b) => `${mine.filter((x) => x.band === b).length} ${b}`).join(', ');
      out(`properties P ${f3(ps.precision)} R ${f3(ps.recall)} F1 ${f3(ps.f1)}  (tp ${ps.tp}, fp ${ps.fp.length}, fn ${ps.missed.length}); candidates ${bands}`);
      out(`properties by how: ${Object.entries(ps.byHow).map(([h, x]) => `${h} ${x.found}/${x.gold}`).join(', ') || '(no gold values)'}`);
      if (ps.fp.length) out(`false positive properties: ${ps.fp.join(', ')}`);
      if (ps.missed.length) out(`missed properties: ${ps.missed.join(', ')}`);
      if (flag('--show')) for (const a of mine) out(`  a ${a.band.padEnd(6)} ${a.rule.padEnd(13)} ${JSON.stringify(a.anchor)}.${a.prop} = ${JSON.stringify(a.text)} -> ${JSON.stringify(a.value)} ${f3(a.p)} (${a.entity ?? 'no entity'})`);
    }
    if (b.entities.false_pos.length) out(`false positive entities: ${b.entities.false_pos.join(', ')}`);
    if (b.entities.missed.length) out(`missed entities: ${b.entities.missed.join(', ')}`);
    if (b.relations.false_pos.length) out(`false positive relations: ${b.relations.false_pos.join(', ')}`);
    if (b.relations.missed.length) out(`missed relations: ${b.relations.missed.map((k) => `${k} (${g.how.get(k)})`).join(', ')}`);
    if (flag('--show')) {
      const gs = store.readGate(db, cl);
      for (const m of gs.mentions.filter((x) => x.doc === docKey)) out(`  m ${m.band.padEnd(6)} ${m.rule.padEnd(12)} ${JSON.stringify(m.text)} (${m.label}) ${f3(m.p)}`);
      for (const c of gs.claims.filter((x) => x.doc === docKey)) out(`  c ${c.band.padEnd(6)} ${c.rule.padEnd(12)} ${JSON.stringify(c.htext)} -[${c.rel}]-> ${JSON.stringify(c.ttext)} ${f3(c.p)}`);
    }
  }
}

// ---- the tools -------------------------------------------------------------------------------------
const db = stores[0][1];
if (db) {
  const gdb = new mod.RelateDb();
  store.openStore(gdb, cl, o, {}, { model: which });
  const gg = goldGraph(gdb, cl, o, own);
  out(`\n## the tools (on the extracted store; on the gold graph: ${gg.entities} entities, ${gg.relationships} relationships)`);
  for (const t of o.tools) {
    const head = `${t.name} [${t.category || '-'}] on ${t.anchor.kind === 'node' ? t.anchor.label : t.anchor.type}`;
    if (t.type !== 'canonicalQuery' || !t.cypher) {
      out(`  ${head}: not a query`);
      continue;
    }
    if (t.requires.length) {
      out(`  ${head}: not run (requires ${t.requires.join(', ')})`);
      continue;
    }
    const params = {};
    const lacking = [];
    for (const p of t.parameters) {
      if (p.example !== undefined) params[p.name] = p.example;
      else if (p.default === undefined) lacking.push(p.name);
    }
    if (lacking.length) {
      out(`  ${head}: not run (no example for ${lacking.map((x) => `$${x}`).join(', ')})`);
      if (entry.group === 'domains') failed = true;
      continue;
    }
    const run = (x) => {
      try {
        return String(cl.exec(x, t.cypher, params, { allowNull: true }).rows.length);
      } catch (e) {
        return `ERROR ${/** @type {any} */ (e).category ?? ''}: ${String(/** @type {any} */ (e).message).split('\n')[0].slice(0, 160)}`;
      }
    };
    const a = run(db);
    const b = run(gdb);
    // A tool over the trace (evidence, review, cross-document) is judged on the extracted store, any other on
    // the gold graph: whether a query is right must not depend on what the model happened to find.
    const traced = ['evidence', 'review', 'cross-document'].includes(t.category);
    const judged = traced ? a : b;
    const bad = judged === '0' || judged.startsWith('ERROR') || a.startsWith('ERROR');
    out(`  ${head}: ${a} rows extracted, ${b} on the gold graph${bad && entry.group === 'domains' ? `  << ${judged.startsWith('ERROR') || a.startsWith('ERROR') ? 'errors' : `no rows on the ${traced ? 'extracted store' : 'gold graph'}`}` : ''}${t.question ? `  | ${t.question}` : ''}`);
    if (entry.group === 'domains' && bad) {
      failed = true;
      verdict.push(`tool ${t.name}: ${judged.startsWith('ERROR') || a.startsWith('ERROR') ? 'errors' : `no rows on the ${traced ? 'extracted store (choose an example the extraction finds)' : 'gold graph (the query or the gold is wrong)'}`}`);
    }
  }
}
out(`\nVERDICT: ${failed ? `not ready${verdict.length ? `: ${verdict.join('; ')}` : ' (see the problems above)'}` : 'ready'}`);
process.exit(failed ? 1 : 0);
