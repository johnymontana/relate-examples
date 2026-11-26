#!/usr/bin/env node
// The pipeline in Node: GLiNER2.5 through gliner-rs WASM, Relate 1.3.0 WASM in memory, one store
// per ontology (D14), web/pipeline.js and web/store.js exactly as the page's worker runs them
// (D7-D11, D14, D16; score.txt also holds the evidence the default cutoffs were settled on).
//   node harness/run.mjs <ver> [--out <dir>] [--model small|base]
// Writes <dir>/extract.txt, gate.txt, audit.txt, review.txt, score.txt and graph.cypher (default
// out/); timings and notes go to stderr. Every written file is diffed by run.sh: no timings, ids,
// paths, pids or hashes of unpinned things; scores to 3 decimals.
//   extract.txt  per document: sentences, sections, inferences, cache hits; mentions and claims by
//                band and deciding rule (the harness's fixtures in full; create-context-graph's samples:
//                kept and review items, drops counted by rule); a second pass over the same stores
//                (0 inferences); stop, a crash mid-section and resume (D9)
//   gate.txt     the floor invariant (stored candidates at t = gliner-rs at t) and the rule invariant
//                (the Cypher gate = a plain-JS gate over the raw JSON, on every store); differences are
//                rows; a generic document's edge cases; a scripted model on the rules' boundaries
//   audit.txt    queries/audit-*.cypher (0 rows each), an illegal publish refused by the graph type,
//                entities across documents, keys with more than one display, the saved queries, dump.json,
//                the ontologies' tools, the console's bookkeeping filter
//   review.txt   verdicts survive re-gating, re-extraction and re-publishing; the latest wins
//   score.txt    P/R/F1 in Cypher against the 27 create-context-graph samples' gold (per domain; the
//                distractor per document; where relations and entities are lost); each rule off in turn;
//                the evidence for the defaults (how the model is asked, cutoff and margin grids,
//                scores of true and false facts)
//   graph.cypher exportCypher of the Financial Services sample's typed graph and of the fixtures' store
// The stores: every create-context-graph domain with a sample (data/samples/ccg/, its gold beside it),
// each ontology the Ontology Graph Spec 1.1 document the page loads (data/ontologies/ogs/ccg/), and one
// more with Financial Services' ontology for the harness's fixtures (harness/fixtures.mjs: the edge
// cases edgextract's golden set covered, written for that domain).
// gliner-rs runs on a pool of worker threads first (harness/infer.mjs): every question this run asks the
// model is asked once up front, and the pipeline's model calls are answered from those answers.
// Exit 0 when everything holds; 1 when an audit finds rows, an engine refusal is not the pinned one,
// or anything throws; 2 when an input is missing. --model base runs extract and score only, on
// GLiNER2.5-base-v1, into <dir> (run.sh --model base prints them; nothing is diffed).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as cl from '../../../lib/relate_wasm.mjs';
import * as replay from '../../../lib/replay.mjs';
import { MODEL_FILES, extractRaw, loadModel, memoryBytes, normalize } from '../web/gliner.js';
import { entityName } from '../web/names.js';
import {
  BOOKKEEPING_LABELS, BOOKKEEPING_TYPES, ENTITY_LABEL, ID_LIKE, ONTOLOGY_LABELS, ONTOLOGY_NODE_IDS, ONTOLOGY_TYPES, PREDICT_ALLOWS, SHARED_TYPES, capNote,
  consoleResult, hiddenNote, prefillChoice, prefillPlan, storeIndexNames, toolArgs, toolCompat, toolParams,
} from '../web/console.js';
import { INTERNAL_LABELS, INTERNAL_TYPES, ONTOLOGY_CONSTRAINTS, applyOntology, parseOntology } from '../web/ontology.js';
import * as pipeline from '../web/pipeline.js';
import { splitSentences } from '../web/split.js';
import * as store from '../web/store.js';
import { FIXTURES, FIXTURE_ONTOLOGY, GENERIC_TEXT, GENERIC_YAML } from './fixtures.mjs';
import { cachedModel, precompute, requestKey, threadCount } from './infer.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EX = resolve(HERE, '..');
const ROOT = resolve(EX, '../..');
const DATA = join(EX, 'data');
/** A separator no name or key holds, for composite JS map keys. */
const SEP = String.fromCharCode(0);

// ---- arguments ------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const VER = argv[0];
if (!/^\d+\.\d+\.\d+$/.test(VER ?? '')) {
  console.error('usage: node harness/run.mjs <ver> [--out <dir>] [--model small|base]');
  process.exit(2);
}
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i > 0 ? argv[i + 1] : dflt;
};
const OUT = resolve(opt('--out', join(EX, 'out')));
const WHICH = opt('--model', 'small');
if (!['small', 'base'].includes(WHICH)) {
  console.error('run.mjs: --model takes small or base');
  process.exit(2);
}
const FULL = WHICH === 'small';

const t0 = performance.now();
const note = (msg) => process.stderr.write(`run.mjs: ${msg}\n`);
const secs = () => `${((performance.now() - t0) / 1000).toFixed(1)} s`;
const failures = [];
const fail = (msg) => { failures.push(msg); note(`FAIL: ${msg}`); };
const f3 = (x) => Number(x).toFixed(3);
const cmp = replay.cmp;

// ---- inputs: the gliner-rs build and the weights, checked as harness/model.mjs checks them ----------
const GLINER_REV = '4fa741eec466660daf4adc8703210138295e0b1b';
const MODELS = {
  small: { repo: 'fastino/gliner2.5-small-v1', rev: '7132dc4561c3f94563c6147e75ffa8ef34c4964a', env: 'GLINER_SMALL_DIR', name: 'gliner2.5-small-v1', fix: 'scripts/fetch-gliner.sh small', bytesPerThread: 2e9 },
  base: { repo: 'fastino/gliner2.5-base-v1', rev: 'ca906247640776a07753514055be9726f9080ead', env: 'GLINER_BASE_DIR', name: 'gliner2.5-base-v1', fix: 'scripts/fetch-gliner.sh base', bytesPerThread: 4e9 },
};
const M = MODELS[WHICH];
const WASM_DIR = process.env.GLINER_WASM_DIR || join(ROOT, '.cache/gliner-wasm', GLINER_REV.slice(0, 7));
const MODEL_DIR = process.env[M.env] || join(ROOT, '.cache/gliner', `${M.name}@${M.rev.slice(0, 7)}`);
const MODEL_PIN = join(ROOT, 'ci', `${M.name}.sha256`);
const rel = (p) => (p.startsWith(`${ROOT}/`) ? p.slice(ROOT.length + 1) : p);
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const missing = (msg) => { note(msg); process.exit(2); };
const parseSums = (text) => new Map(text.trim().split('\n').filter(Boolean).map((l) => l.split(/\s+/)).map(([s, p]) => [p, s]));

const builtPath = join(WASM_DIR, '.built');
if (!existsSync(builtPath)) missing(`no gliner-rs build in ${rel(WASM_DIR)}; fix: scripts/build-gliner-wasm.sh`);
const built = readFileSync(builtPath, 'utf8');
if (!built.split('\n').includes(`gliner-rs ${GLINER_REV}`)) missing(`${rel(builtPath)} is not a build of ${GLINER_REV.slice(0, 7)}`);
const builtSums = parseSums(built.split('\n---\n')[1] ?? '');
for (const f of ['gliner_rs.js', 'gliner_rs_bg.wasm']) {
  if (sha256File(join(WASM_DIR, f)) !== builtSums.get(f)) missing(`${rel(join(WASM_DIR, f))} does not match its .built; fix: scripts/build-gliner-wasm.sh --force`);
}
const verified = join(MODEL_DIR, '.verified');
if (!existsSync(verified) || !readFileSync(verified).equals(readFileSync(MODEL_PIN))) missing(`no verified weights in ${rel(MODEL_DIR)}; fix: ${M.fix}`);
const MODEL_INFO = {
  repo: M.repo, rev: M.rev, weights: parseSums(readFileSync(MODEL_PIN, 'utf8')).get('model.safetensors'), build: pipeline.BUILD,
};

// ---- engines ---------------------------------------------------------------------------------------
const info = await cl.check(VER);
if (!info.ok) missing(`run.mjs: ${info.reason}`);
const mod = await cl.loadNode(VER);
const glue = await import(pathToFileURL(join(WASM_DIR, 'gliner_rs.js')).href);
let t = performance.now();
const realModel = loadModel({
  glue, wasmBytes: readFileSync(join(WASM_DIR, 'gliner_rs_bg.wasm')),
  ...Object.fromEntries(Object.entries(MODEL_FILES).map(([arg, f]) => [arg, readFileSync(join(MODEL_DIR, f))])),
});
note(`${M.name} loaded in ${Math.round(performance.now() - t)} ms, ${memoryBytes(realModel) >> 20} MiB of WASM memory`);
const freshDb = () => new mod.RelateDb();

// ---- data ------------------------------------------------------------------------------------------
// The bundled ontologies as the page loads them, Ontology Graph Spec 1.1 documents (data/ontologies/ogs/ccg/,
// harness/convert.mjs): every create-context-graph domain that has a sample. The base, _base.yaml, is for the
// scripted ontology below (create-context-graph's format, converted as the page converts a pasted file).
// `ontologies` and `stores` are keyed by store: a domain's id, and FIX, the fixtures' store, which reads
// Financial Services' ontology (the same parsed object).
const ontologies = new Map();
/** each store's group: 'ccg' or 'fixtures' */
const groupOf = new Map();
const OGS = join(DATA, 'ontologies/ogs');
const bases = { _base: readFileSync(join(DATA, 'ontologies/ccg/_base.yaml'), 'utf8') };
const sampleList = JSON.parse(readFileSync(join(DATA, 'samples/samples.json'), 'utf8'));
const ccgWanted = new Set(sampleList.filter((s) => s.group === 'ccg').map((s) => s.ontology));
for (const f of readdirSync(join(OGS, 'ccg')).filter((x) => x.endsWith('.ontology.yaml')).sort()) {
  const o = parseOntology(readFileSync(join(OGS, 'ccg', f), 'utf8'));
  if (!ccgWanted.has(o.id)) continue;
  ontologies.set(o.id, o);
  groupOf.set(o.id, 'ccg');
}
/** The fixtures' store key (harness/fixtures.mjs): Financial Services' ontology, a store of its own. */
const FIX = 'fixtures';
if (!ontologies.has(FIXTURE_ONTOLOGY)) missing(`harness/fixtures.mjs: the fixtures' ontology ${FIXTURE_ONTOLOGY} has no sample, so it is not loaded`);
ontologies.set(FIX, ontologies.get(FIXTURE_ONTOLOGY));
groupOf.set(FIX, 'fixtures');
const samples = sampleList.map((s) => ({
  name: s.id, file: `data/samples/${s.file}`, ontology: s.ontology, group: s.group, about: null,
  text: readFileSync(join(DATA, 'samples', s.file), 'utf8'),
  gold: s.gold ? JSON.parse(readFileSync(join(DATA, 'samples', s.gold), 'utf8')) : null,
}));
for (const s of samples) {
  if (s.group !== 'ccg') missing(`data/samples/samples.json: ${s.name} is in the group ${JSON.stringify(s.group)}; every sample is create-context-graph's (ccg)`);
  if (!ontologies.has(s.ontology)) missing(`data/samples/samples.json: ${s.name} names the ontology ${s.ontology}, which is not bundled`);
}
const ccgSamples = samples;
const ccgOids = [...new Set(ccgSamples.map((s) => s.ontology))].sort(cmp);
for (const oid of ccgOids) if (ccgSamples.filter((s) => s.ontology === oid).length !== 1) missing(`data/samples/samples.json: ${oid} needs exactly one create-context-graph sample`);
for (const s of ccgSamples) if (!s.gold) missing(`data/samples/samples.json: ${s.name} has no gold file`);
const distractors = JSON.parse(readFileSync(join(DATA, 'samples/ccg/distractors.json'), 'utf8'));
for (const oid of ccgOids) if (!distractors[oid]) missing(`data/samples/ccg/distractors.json: no distractor for ${oid}`);
/** The harness's fixtures (harness/fixtures.mjs), all in the FIX store. */
const fixtureDocs = FIXTURES.map((f) => ({
  name: f.name, file: `harness/fixtures.mjs ${f.name}`, ontology: FIX, group: 'fixtures', about: f.about, text: f.text, gold: null,
}));
const docId = (text) => replay.sha256(text);
/**
 * A gold file's names as the store keys its entities (names.js entityName with the kind's label words, as
 * mentionName does): each entity by its own kind, a relation's ends by the kinds of the gold entities of those names.
 * `key(name, kind)` keys any name.
 */
function goldKeys(o, gold) {
  const words = store.kindWordsOf(o);
  const kindOf = new Map(gold.entities.map((e) => [e.name, e.type]));
  const key = (name, kind) => entityName(name, words.get(kind) ?? []);
  return {
    key, kindOf,
    entities: gold.entities.map((e) => ({ name: key(e.name, e.type), type: e.type })),
    relations: gold.relations.map((r) => ({ src: key(r.source, kindOf.get(r.source)), rel: r.type, tgt: key(r.target, kindOf.get(r.target)) })),
  };
}
/** (:_Gold) rows for one create-context-graph store: names keyed as the store keys them, labels and types verbatim. */
function ccgGoldFor(oid) {
  return ccgSamples.filter((s) => s.ontology === oid).map((s) => {
    const g = goldKeys(ontologies.get(oid), s.gold);
    return { doc: docId(s.text), title: s.name, entities: g.entities, relations: g.relations };
  });
}
/**
 * The gold relations of one labelled document that its ontology cannot hold: the (source kind, target kind)
 * pair, the kinds read from the same file's entities, is not one of the link's legal pairs (either way round
 * for a symmetric link). A gold relation the gate can never keep would only lower recall; the samples'
 * gold holds none (checked below, a failure otherwise).
 * @returns {{n: number, illegal: string[]}}
 */
function illegalGold(o, gold) {
  const kindOf = (name) => gold.entities.find((e) => e.name === name)?.type;
  const illegal = [];
  for (const r of gold.relations) {
    const l = o.relations.find((x) => x.id === r.type);
    const [a, b] = [kindOf(r.source), kindOf(r.target)];
    const legal = Boolean(l) && l.pairs.some(([s, t]) => (s === a && t === b) || (l.symmetric && s === b && t === a));
    if (!legal) illegal.push(`${r.source} (${a ?? 'no kind'}) -[${r.type}]-> ${r.target} (${b ?? 'no kind'})`);
  }
  return { n: gold.relations.length, illegal };
}
const goldLegality = { n: 0, illegal: /** @type {string[]} */ ([]) };
for (const s of ccgSamples) {
  const r = illegalGold(ontologies.get(s.ontology), s.gold);
  goldLegality.n += r.n;
  goldLegality.illegal.push(...r.illegal.map((x) => `${s.ontology}: ${x}`));
}
for (const x of goldLegality.illegal) fail(`data/samples/ccg gold relation outside its domain's legal pairs: ${x}`);
/**
 * The held-out set (data/samples/heldout/): documents written like the samples, never listed in the page
 * (samples.json does not name them) and never used to set a default or a rule; score.txt scores them beside the samples.
 * <domain>.md and <domain>.gold.json per document, one per domain, and distractors.json.
 */
const HELD = join(DATA, 'samples/heldout');
const heldDistractors = existsSync(join(HELD, 'distractors.json')) ? JSON.parse(readFileSync(join(HELD, 'distractors.json'), 'utf8')) : {};
const heldout = existsSync(HELD) ? readdirSync(HELD).filter((f) => f.endsWith('.md')).sort(cmp).map((f) => {
  const oid = f.slice(0, -'.md'.length);
  const goldFile = join(HELD, `${oid}.gold.json`);
  if (!existsSync(goldFile)) missing(`data/samples/heldout/${oid}.gold.json`);
  return { name: `heldout/${oid}`, ontology: oid, text: readFileSync(join(HELD, f), 'utf8'), gold: JSON.parse(readFileSync(goldFile, 'utf8')) };
}) : [];
if (!heldout.length) missing('data/samples/heldout/: no held-out documents');
for (const h of heldout) {
  if (!ontologies.has(h.ontology)) missing(`data/samples/heldout/${h.ontology}.md: no bundled ontology ${h.ontology} with a sample`);
  if (!heldDistractors[h.ontology]) missing(`data/samples/heldout/distractors.json: no distractor for ${h.ontology}`);
  for (const x of illegalGold(ontologies.get(h.ontology), h.gold).illegal) fail(`data/samples/heldout gold relation outside its domain's legal pairs: ${h.ontology}: ${x}`);
}

/** One store per ontology (D14), opened as the worker opens it, with the defaults of this run's model. */
function newStore(key, cutoffs = {}) {
  const db = freshDb();
  const opened = store.openStore(db, cl, ontologies.get(key), cutoffs, { model: WHICH });
  return { db, oid: key, opened };
}
/** The gate's defaults for this run's model (store.defaultGate: the same for every format). */
const DEF = store.defaultGate('create-context-graph', WHICH);
if (JSON.stringify(store.defaultGate('generic', WHICH)) !== JSON.stringify(DEF)) fail('store.defaultGate gives a generic document other defaults than create-context-graph\'s');

const lines = { extract: [], gate: [], audit: [], review: [], score: [] };
const sayTo = (file) => (s = '') => lines[file].push(s);

// ---- the model, on worker threads (harness/infer.mjs) ---------------------------------------------------
const docs = [...(FULL ? fixtureDocs : []), ...ccgSamples];
const SWEEP = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
/** The floor invariant's sentences: the first of every fixture that has one and of every sample, with its store. */
const floorSentences = docs.map((d) => ({ d, s: splitSentences(d.text)[0] })).filter((x) => x.s);
const genericOntology = parseOntology(GENERIC_YAML);
const requests = [];
for (const d of docs) {
  const { schema } = pipeline.modelSchema(ontologies.get(d.ontology));
  for (const s of splitSentences(d.text)) requests.push({ text: s.text, schema });
}
// score.txt's held-out set, at every model.
for (const d of heldout) {
  const { schema } = pipeline.modelSchema(ontologies.get(d.ontology));
  for (const s of splitSentences(d.text)) requests.push({ text: s.text, schema });
}
if (FULL) {
  for (const { d, s } of floorSentences) {
    const o = ontologies.get(d.ontology);
    for (const th of SWEEP) requests.push({ text: s.text, schema: pipeline.modelSchema(o, { threshold: th }).schema });
  }
  // gate.txt's generic document, on its own text.
  for (const s of splitSentences(GENERIC_TEXT)) requests.push({ text: s.text, schema: pipeline.modelSchema(genericOntology).schema });
  // score.txt's comparison: the create-context-graph samples asked as before experiment B (ids and descriptions).
  for (const d of ccgSamples) {
    const { schema } = pipeline.modelSchema(ontologies.get(d.ontology), { asked: 'ids' });
    for (const s of splitSentences(d.text)) requests.push({ text: s.text, schema });
  }
}
t = performance.now();
const threads = threadCount(M.bytesPerThread);
const answers = await precompute(requests, { wasmDir: WASM_DIR, modelDir: MODEL_DIR, threads });
note(`${answers.size} model calls on ${threads} worker thread(s) in ${((performance.now() - t) / 1000).toFixed(1)} s (${secs()})`);
const { handle: model, stats: modelStats } = cachedModel(realModel, answers);
// Three of the answers asked again on this thread's model: a worker's answer is gliner-rs's own.
const byKey = new Map(requests.map((r) => [requestKey(r.text, r.schema), r]));
const keys = [...answers.keys()].sort(cmp);
const spot = [...new Set([0, keys.length >> 1, keys.length - 1])].map((i) => keys[i]);
const spotSame = spot.every((k) => extractRaw(realModel, byKey.get(k).text, byKey.get(k).schema) === answers.get(k));
if (!spotSame) fail('a worker thread\'s gliner-rs answer differs from this thread\'s');

// ==== extract.txt ===================================================================================
const say = sayTo('extract');
const D = store.DEFAULT_GATE;
say(`# Extraction in Node (harness/run.mjs): ${M.name} through gliner-rs, Relate ${VER} WASM in memory`);
say(`model ${M.repo} @ ${M.rev.slice(0, 7)}, ${pipeline.BUILD}; every candidate at p >= ${pipeline.FLOOR.toFixed(2)} is cached and stored (D7)`);
say('create-context-graph\'s ontologies are asked by label text ("maintenance record"), "<subtype> in <domain>" for a domain kind,');
say('base kinds bare, a base kind no link names and a domain kind covers not asked, links between their endpoints ("person works');
say(`for organization"); sections of about ${pipeline.SECTION_CHARS} bytes`);
say(`gliner-rs ran on worker threads first, each question once (harness/infer.mjs); three answers asked again on this thread: ${spotSame ? 'identical' : 'DIFFERENT'}`);
say(`one store per ontology (D14): the ${ccgOids.length} create-context-graph domains with a sample, and one for the harness's ${FULL ? fixtureDocs.length : 0} fixtures`);
say(`(harness/fixtures.mjs: edge cases, with the ${FIXTURE_ONTOLOGY} ontology); the fixtures, then the samples (samples.json order); each`);
say('document is extracted, gated and published');
const cutsLine = (x) => `entity keep ${f3(x.entKeep)} drop ${f3(x.entDrop)}; relation keep ${f3(x.relKeep)} drop ${f3(x.relDrop)}`;
say(`default gate (store.defaultGate, ${M.name}; every ontology): ${cutsLine(DEF)};`);
say(`  type margin ${f3(D.typeMargin)}; relation margin ${f3(D.relMargin)}; pole margin ${f3(D.poleMargin)}`);
say('rules: 0 no-name (a pronoun or no canonical name), 1 gazetteer, 2 one-kind / type-margin / pole-specific, 2b other-kind,');
say('       3 unanchored / end-in-review, 4 illegal / self-loop, 5 band / hedged, 6 ambiguous / reversed, 7 verdict / claim-verdict.');
say('       A line: band, rule, sentence (s<idx>), then');
say('       "text" (KIND) p or "head" -[REL]-> "tail" p');
say('Each document is listed as the gate leaves its store after the last document (the gate runs per store).');

const stores = new Map();
for (const oid of [...ontologies.keys()]) stores.set(oid, newStore(oid));
const seen = new Map(); // doc id -> the input that first brought it
const perDoc = [];
for (const d of docs) {
  const s = stores.get(d.ontology);
  const id = docId(d.text);
  t = performance.now();
  const r = await pipeline.run({ db: s.db, cl, model, modelInfo: MODEL_INFO, ontology: ontologies.get(d.ontology), text: d.text, title: d.name });
  note(`${d.ontology}/${d.name}: ${r.counters.inferences} inferences, ${r.counters.hits} hits, ${Math.round(performance.now() - t)} ms`);
  if (r.counters.offsetMismatches) fail(`${d.name}: ${r.counters.offsetMismatches} mention texts differ from their code-point offsets`);
  perDoc.push({ d, r, id, first: seen.get(id) ?? null });
  if (!seen.has(id)) seen.set(id, d);
}
note(`first pass done (${secs()}); model calls answered by the pool ${modelStats.hits}, by this thread ${modelStats.misses}`);

const BAND_ORDER = ['keep', 'review', 'drop'];
const sIdx = (key) => Number(key.slice(key.lastIndexOf('#') + 1));
const mentionLine = (m) => `${m.band.padEnd(6)} ${m.rule.padEnd(11)} s${sIdx(m.sentence)} ${JSON.stringify(m.text)} (${m.label}) ${f3(m.p)}`;
const claimLine = (c) => `${c.band.padEnd(6)} ${c.rule.padEnd(11)} s${sIdx(c.sentence)} ${JSON.stringify(c.htext)} -[${c.rel}]-> ${JSON.stringify(c.ttext)} ${f3(c.p)}`;
const byBand = (a, b) => BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band) || cmp(a.rule, b.rule) ||
  sIdx(a.sentence) - sIdx(b.sentence);
/** Mentions and claims of one document, in the gate's final state for its store. */
function docReport(oid, id) {
  const g = store.readGate(stores.get(oid).db, cl);
  return { mentions: g.mentions.filter((m) => m.doc === id), claims: g.claims.filter((c) => c.doc === id) };
}
const countBy = (rows, f) => {
  const m = new Map();
  for (const r of rows) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
  return [...m].sort((a, b) => cmp(a[0], b[0])).map(([k, v]) => `${k} ${v}`).join(', ');
};
let heading = '';
for (const { d, r, id, first } of perDoc) {
  const c = r.counters;
  const isCcg = d.group === 'ccg';
  if (d.group !== heading) {
    heading = d.group;
    say();
    if (isCcg) {
      say(`# create-context-graph's samples: one synthetic document per domain, each in its domain's store (data/samples/ccg/)`);
      say("Labels and links are the domain's own (Person, Account, WORKS_FOR). Listed: kept mentions, and kept and review claims;");
      say('the rest are counted by band and rule (gate.txt holds every candidate to the JS gate).');
    } else {
      say(`# The harness's fixtures: edge cases, each a document in the fixtures' store, with the ${FIXTURE_ONTOLOGY} ontology (harness/fixtures.mjs)`);
      say("They follow the cases edgextract's golden set covered, written for this domain; no gold. Listed: every mention and claim.");
    }
  }
  say();
  say(`## ${isCcg ? d.ontology : 'fixtures'}: ${d.name} (${d.file})`);
  if (d.about) say(d.about);
  say(`${c.sentences} sentences, ${c.sections} section${c.sections === 1 ? '' : 's'}; ${c.inferences} inferences, ${c.hits} cache hits` +
    (c.skipped ? `; ${c.skipped} section${c.skipped === 1 ? '' : 's'} already complete, skipped` : ''));
  if (d.name === 'fence' && d.group === 'fixtures') {
    // The splitter skips a fenced block: none of its lines may reach a sentence (E2).
    const fenced = (/```[^\n]*\n([\s\S]*?)```/.exec(d.text)?.[1] ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    const leaked = splitSentences(d.text).filter((x) => fenced.some((l) => x.text.includes(l)));
    say(`lines inside the fence (${fenced.length}) found in a sentence: ${leaked.length ? leaked.map((x) => JSON.stringify(x.text)).join(', ') : 'none'}`);
    if (!fenced.length || leaked.length) fail('fixtures fence: a fenced line reached a sentence, or the fixture has no fence');
  }
  if (first) {
    say(`the same text as ${first.name}: one document (its id is the text's sha256), already extracted; see ${first.name}`);
    continue;
  }
  const rep = docReport(d.ontology, id);
  const mm = rep.mentions.map((m) => ({ ...m, line: mentionLine(m) })).sort((a, b) => byBand(a, b) || cmp(a.line, b.line));
  const cc = rep.claims.map((x) => ({ ...x, line: claimLine(x) })).sort((a, b) => byBand(a, b) || cmp(a.line, b.line));
  const summary = (rows) => `${BAND_ORDER.map((b) => `${b} ${rows.filter((x) => x.band === b).length}`).join(', ')}` +
    ` (dropped by ${countBy(rows.filter((x) => x.band === 'drop'), (x) => x.rule) || 'none'})`;
  say(`mentions: ${summary(mm)}`);
  if (isCcg) say(`  in review by ${countBy(mm.filter((x) => x.band === 'review'), (x) => x.rule) || 'none'}`);
  for (const m of isCcg ? mm.filter((x) => x.band === 'keep') : mm) say(`  ${m.line}`);
  say(`claims: ${summary(cc)}`);
  for (const x of isCcg ? cc.filter((y) => y.band !== 'drop') : cc) say(`  ${x.line}`);
}

say();
say('## the stores after the first pass (published typed graph)');
for (const [oid, s] of stores) {
  const k = store.counts(s.db, cl);
  const kinds = new Set(ontologies.get(oid).types.map((x) => x.id));
  const links = new Set(ontologies.get(oid).relations.map((x) => x.id));
  const ents = k.labels.filter((l) => kinds.has(l.name)).map((l) => `${l.name} ${l.n}`).join(', ') || 'none';
  const rels = k.types.filter((l) => links.has(l.name)).map((l) => `${l.name} ${l.n}`).join(', ') || 'none';
  say(`${oid}: entities ${ents}; relationships ${rels}`);
}

// A second pass re-applies every section (no skipping): every sentence is a cache hit.
say();
say('## a second pass over the same stores: every section re-applied, every sentence from the cache (D7, D9)');
let secondInferences = 0;
let secondHits = 0;
const before = new Map([...stores].map(([oid, s]) => [oid, gateFingerprint(s.db)]));
for (const d of docs) {
  if (perDoc.find((p) => p.d === d).first) continue;
  const s = stores.get(d.ontology);
  const r = await pipeline.run({ db: s.db, cl, model, modelInfo: MODEL_INFO, ontology: ontologies.get(d.ontology), text: d.text, title: d.name, skipComplete: false });
  secondInferences += r.counters.inferences;
  secondHits += r.counters.hits;
}
const unchanged = [...stores].every(([oid, s]) => gateFingerprint(s.db) === before.get(oid));
say(`${seen.size} distinct documents: ${secondInferences} inferences, ${secondHits} cache hits; bands and the typed graph unchanged: ${unchanged ? 'yes' : 'NO'}`);
if (secondInferences !== 0) fail(`the second pass ran ${secondInferences} inferences`);
if (!unchanged) fail('the second pass changed the gate or the typed graph');
note(`second pass done (${secs()})`);

/** Everything the gate and publish decide, as one string (Run nodes and timestamps left out). */
function gateFingerprint(db) {
  const g = store.readGate(db, cl);
  const edges = cl.exec(db, `MATCH (a:_Entity)-[r]->(b:_Entity)
RETURN a.key AS a, type(r) AS rel, b.key AS b, r.p AS p, r.claims AS claims, labels(a) AS la, labels(b) AS lb ORDER BY a, rel, b`).rows;
  const ents = cl.exec(db, 'MATCH (e:_Entity) RETURN e.key AS key, labels(e) AS labels, e.name AS name, e.docs AS docs ORDER BY key').rows;
  return JSON.stringify([
    g.mentions.map((m) => [m.key, m.band, m.rule]), g.claims.map((c) => [c.key, c.band, c.rule, c.head, c.tail]),
    edges, ents.map((e) => ({ ...e, labels: [...e.labels].sort() })),
  ]);
}

// Stop, a crash mid-section, and resume (D9), on a store of its own with small sections.
if (FULL) {
  say();
  say(`## stop, a crash mid-section, and resume (D9), on a fresh ${FIXTURE_ONTOLOGY} store with sections of about 120 bytes (its sample)`);
  const d = samples.find((x) => x.name === FIXTURE_ONTOLOGY);
  const o = ontologies.get(d.ontology);
  const a = newStore(d.ontology);
  const job = { db: a.db, cl, model, modelInfo: MODEL_INFO, ontology: o, text: d.text, title: d.name, sectionChars: 120 };
  const r1 = await pipeline.extractDocument({ ...job, onSection: ({ section }) => (section === 0 ? 'stop' : undefined) });
  say(`stop after the first section: status ${r1.status}, ${r1.written} of ${r1.sections} sections written, ${r1.inferences} inferences`);
  let crashed = '';
  try {
    await pipeline.extractDocument({ ...job, onStep: (step, n) => { if (n === 1 && step === 'mentions') throw new Error('killed after the mentions of section 1'); } });
  } catch (e) {
    crashed = e.message;
  }
  const state = cl.exec(a.db, `MATCH (sec:_Section)
RETURN sec.n AS n, sec.complete AS complete, COUNT { MATCH (sec)<-[:_IN]-(:_Sentence)<-[:_IN]-(:_Mention) } AS mentions,
       COUNT { MATCH (sec)<-[:_IN]-(:_Sentence)<-[:_EVIDENCE]-(:_Claim) } AS claims ORDER BY n`).rows;
  say(`resume, killed mid-section: ${crashed || 'NOT killed'}`);
  say(`  sections now: ${state.map((x) => `${x.n} ${x.complete ? 'complete' : 'incomplete'} (${x.mentions} mentions, ${x.claims} claims)`).join('; ')}`);
  store.gate(a.db, cl);
  const incompleteBanded = cl.exec(a.db, `MATCH (sec:_Section)<-[:_IN]-(:_Sentence)<-[:_IN]-(m:_Mention) WHERE sec.complete = false AND m.band IS NOT NULL
RETURN count(m) AS n`).rows[0].n;
  say(`  the gate reads complete sections only: mentions of the incomplete section with a band: ${incompleteBanded}`);
  if (incompleteBanded !== 0) fail('the gate banded mentions of an incomplete section');
  const r3 = await pipeline.extractDocument(job);
  say(`resume: status ${r3.status}; ${r3.skipped} complete sections skipped, ${r3.written} written (the incomplete one re-applied); ${r3.inferences} inferences, ${r3.hits} cache hits`);
  store.gate(a.db, cl);
  store.publish(a.db, cl);
  const b = newStore(d.ontology);
  await pipeline.extractDocument({ ...job, db: b.db });
  store.gate(b.db, cl);
  store.publish(b.db, cl);
  const same = gateFingerprint(a.db) === gateFingerprint(b.db);
  say(`the resumed store's bands and typed graph equal an uninterrupted run's (sections of 120 bytes): ${same ? 'yes' : 'NO'}`);
  if (!same) fail('stop/crash/resume differs from an uninterrupted run');
  const runs = cl.exec(a.db, 'MATCH (r:_Run) RETURN r.id AS id, r.status AS status, r.read AS read, r.inferences AS inferences, r.hits AS hits ORDER BY id').rows;
  say(`  runs: ${runs.map((x) => `${x.status} (read ${x.read}, ${x.inferences} inferences, ${x.hits} hits)`).join('; ')}`);
  a.db.free();
  b.db.free();
}

// ==== the JS gate (the rule invariant's oracle) =====================================================
/**
 * D10 rules 1-7 in plain JavaScript over the raw JSON in the cache: an independent implementation
 * of what store.gateStatements() does in Cypher, for the rule invariant.
 */
function jsGate(db, oid, { typeMargin = D.typeMargin, relMargin = D.relMargin, poleMargin = D.poleMargin, off = [] } = {}) {
  const on = (r) => !off.includes(r);
  const o = ontologies.get(oid);
  const so = store.storedOntology(db, cl);
  const kinds = new Map(so.kinds.map((k) => [k.id, k]));
  // POLE+O from the parsed YAML (not the _Kind.pole and _Kind.origin the Cypher gate reads).
  const poleOf = new Map(o.types.map((k) => [k.id, { pole: k.pole ?? null, base: k.origin === 'base' }]));
  const pole = poleMargin != null;
  // Legal pairs from the parsed YAML (not the _LinkType.pairs the Cypher gate reads); cutoffs from the store.
  const cut = new Map(so.links.map((l) => [l.id, l]));
  const links = new Map(o.relations.map((r) => [r.id, {
    symmetric: r.symmetric, pairs: new Set(r.pairs.map(([s, tt]) => `${s}${SEP}${tt}`)), keep: cut.get(r.id).keep, drop: cut.get(r.id).drop,
  }]));
  const { schema, kindOf, relOf } = pipeline.modelSchema(o);
  const words = store.kindWordsOf(o);
  const sentences = cl.exec(db, `MATCH (sec:_Section {complete: true})<-[:_IN]-(s:_Sentence)-[:_INFERRED]->(i:_Inference)
RETURN s.key AS key, s.doc AS doc, s.start AS start, s.text AS text, i.key AS inference ORDER BY key`).rows;
  const verdicts = cl.exec(db, 'MATCH (v:_Verdict) RETURN v.target AS target, v.value AS value, v.ts AS ts, v.seq AS seq').rows;
  const latest = new Map();
  for (const v of verdicts) {
    const cur = latest.get(v.target);
    if (!cur || v.ts > cur.ts || (v.ts === cur.ts && v.seq > cur.seq)) latest.set(v.target, v);
  }
  const mentions = [];
  const claims = [];
  for (const s of sentences) {
    const raw = store.readInference(db, cl, s.inference);
    const out = normalize(raw, schema);
    const cp = Array.from(s.text);
    for (const e of out.entities) {
      const text = cp.slice(e.start, e.end).join('');
      const label = kindOf.get(e.label); // the model's label text -> the kind's id
      if (!label) throw new Error(`jsGate: the model's label ${JSON.stringify(e.label)} is not asked on ${oid}`);
      mentions.push({ key: `${s.key}|m|${label}|${s.start + e.start}-${s.start + e.end}`, sentence: s.key, start: s.start + e.start, end: s.start + e.end, label, name: pipeline.mentionName(text, words.get(label)), plain: pipeline.mentionName(text), p: e.score, source: 'model' });
    }
    for (const g of pipeline.gazetteerMentions(s.text, o.names)) {
      mentions.push({ key: `${s.key}|g|${g.label}|${s.start + g.start}-${s.start + g.end}`, sentence: s.key, start: s.start + g.start, end: s.start + g.end, label: g.label, name: pipeline.mentionName(g.text, words.get(g.label)), plain: pipeline.mentionName(g.text), p: 1, source: 'gazetteer' });
    }
    const seenClaims = new Map();
    for (const r of out.relations) {
      const relId = relOf.get(r.relation);
      const [hs, he, ts, te] = [r.head.start, r.head.end, r.tail.start, r.tail.end].map((x) => s.start + x);
      const key = `${s.key}|c|${relId}|${hs}-${he}|${ts}-${te}`;
      if (seenClaims.has(key) && seenClaims.get(key).p >= r.score) continue;
      const htext = cp.slice(r.head.start, r.head.end).join('');
      const ttext = cp.slice(r.tail.start, r.tail.end).join('');
      seenClaims.set(key, {
        key, sentence: s.key, sstart: s.start, stext: s.text, rel: relId, p: r.score, hs, he, ts, te,
        htext, ttext, hkeys: store.claimEndKeys(htext, words), tkeys: store.claimEndKeys(ttext, words),
      });
    }
    claims.push(...seenClaims.values());
  }
  const FINAL = ['no-name', 'off'];
  const set = (x, band, rule) => { x.band = band; x.rule = rule; };
  // rule 0 and 1
  for (const m of mentions) if (m.name === '') set(m, 'drop', 'no-name');
  const gaz = mentions.filter((m) => m.source === 'gazetteer');
  if (on('gazetteer')) {
    for (const m of gaz) if (!m.band) set(m, 'keep', 'gazetteer');
    const keptGaz = gaz.filter((g) => g.band === 'keep');
    for (const m of mentions) {
      if (m.source === 'model' && !m.band && keptGaz.some((g) => g.sentence === m.sentence && g.start < m.end && m.start < g.end)) set(m, 'drop', 'gazetteer');
    }
  } else {
    for (const m of gaz) if (!m.band) set(m, 'drop', 'off');
  }
  // 2
  if (on('one-kind')) {
    const spans = new Map();
    for (const m of mentions) {
      if (m.band || m.source !== 'model') continue;
      const k = `${m.sentence}|${m.start}|${m.end}`;
      spans.set(k, [...(spans.get(k) ?? []), m]);
    }
    for (const ms of spans.values()) {
      ms.sort((a, b) => b.p - a.p || cmp(a.label, b.label));
      const top = ms[0];
      const tp = poleOf.get(top.label);
      // A domain kind of the base kind's pole, within the pole margin and above its own drop cutoff, wins.
      const spec = !pole || !tp?.base || tp.pole == null ? undefined : ms.find((m) => {
        const mp = poleOf.get(m.label);
        const k = kinds.get(m.label);
        return mp && !mp.base && mp.pole === tp.pole && m.p >= top.p - poleMargin && (!on('band') || (k && m.p > k.drop));
      });
      const best = spec ?? top;
      const bp = poleOf.get(best.label);
      // A base kind and its own specialisation are never runners-up to each other.
      const related = (m) => pole && bp?.pole != null && poleOf.get(m.label)?.pole === bp.pole && poleOf.get(m.label)?.base !== bp.base;
      const second = ms.find((m) => m !== best && !related(m));
      for (const m of ms) if (m !== best) set(m, 'drop', 'one-kind');
      const k = kinds.get(best.label);
      if (second && second.p >= best.p - typeMargin && (!on('band') || (k && best.p > k.drop))) set(best, 'review', 'type-margin');
      else if (spec) best.rule = 'pole-specific';
    }
  }
  // 5 (mentions); a pole-specific winner keeps its rule
  for (const m of mentions) {
    if (m.band) continue;
    if (!on('band')) { set(m, 'keep', m.rule ?? 'floor'); continue; }
    const k = kinds.get(m.label);
    if (!k) continue;
    set(m, m.p >= k.keep ? 'keep' : m.p <= k.drop ? 'drop' : 'review', m.rule ?? 'band');
  }
  // 2b: one kind per name (the key's name, then the plain name); a domain kind over a base kind, else the highest
  // score, the most mentions, the id
  if (on('name-kind')) {
    for (const by of ['name', 'plain']) {
      const byName = new Map();
      for (const m of mentions) if (m.band === 'keep' && m[by]) byName.set(m[by], [...(byName.get(m[by]) ?? []), m]);
      for (const ms of byName.values()) {
        const ks = new Map();
        for (const m of ms) {
          const k = ks.get(m.label) ?? { label: m.label, p: -1, n: 0, pole: poleOf.get(m.label)?.pole ?? null, base: poleOf.get(m.label)?.base ?? false };
          k.p = Math.max(k.p, m.p);
          k.n++;
          ks.set(m.label, k);
        }
        if (ks.size < 2) continue;
        const all = [...ks.values()];
        const cand = all.filter((x) => !(pole && x.base && all.some((y) => !y.base)));
        const win = cand.sort((a, b) => b.p - a.p || b.n - a.n || cmp(a.label, b.label))[0];
        const keptWin = ms.filter((w) => w.label === win.label);
        for (const m of ms) {
          if (m.label === win.label) continue;
          const over = keptWin.some((w) => w.sentence === m.sentence && w.start < m.end && m.start < w.end);
          set(m, over ? 'drop' : 'review', 'other-kind');
          m.alt = win.label;
        }
      }
    }
  }
  // 7 (mentions); `prior` remembers the band rules 0-5 gave, for rule 3
  if (on('verdicts')) {
    for (const m of mentions) {
      const v = latest.get(m.key);
      if (v && m.band && !FINAL.includes(m.rule)) {
        m.prior = m.band;
        set(m, v.value === 'accept' ? 'keep' : 'drop', 'verdict');
      }
    }
  }
  // 3
  const bySentence = new Map();
  for (const m of mentions) bySentence.set(m.sentence, [...(bySentence.get(m.sentence) ?? []), m]);
  // Rule 3 joins each end without its leading and trailing punctuation and whitespace.
  const trimmed = (a, b, text) => {
    const cps = [...text];
    let i = 0;
    let j = cps.length;
    while (i < j && /^[\p{P}\p{White_Space}]$/u.test(cps[i])) i++;
    while (j > i && /^[\p{P}\p{White_Space}]$/u.test(cps[j - 1])) j--;
    return i < j ? [a + i, a + j] : [a, b];
  };
  // On: a kept mention first, else one in review (never a dropped one); a mention a verdict rejected
  // keeps its place by the band it had before (prior), and an end that picks it does not anchor.
  // Off: any banded mention, smallest first.
  const isRejected = (x) => x.band === 'drop' && x.rule === 'verdict' && (x.prior === 'keep' || x.prior === 'review');
  const anchorOk = (x) => (on('span-join') ? x.band === 'keep' || x.band === 'review' || isRejected(x) : x.band && !FINAL.includes(x.rule));
  const rank = (x) => (on('span-join') && (isRejected(x) ? x.prior : x.band) !== 'keep' ? 1 : 0);
  const order = (y, z) => rank(y) - rank(z) || (y.end - y.start) - (z.end - z.start) || z.p - y.p || cmp(y.label, z.label) || cmp(y.key, z.key);
  // An end no anchoring mention contains joins one whose KIND|NAME is among the end's keys, in the same order
  // (rule 3 on only).
  const anchor = (sk, a, b, keys) => {
    const ms = (bySentence.get(sk) ?? []).filter(anchorOk);
    let x = ms.filter((y) => y.start <= a && b <= y.end).sort(order)[0] ?? null;
    if (!x && on('span-join')) x = ms.filter((y) => keys.includes(`${y.label}|${y.name}`)).sort(order)[0] ?? null;
    return x && on('span-join') && isRejected(x) ? null : x;
  };
  for (const c of claims) {
    const hm = anchor(c.sentence, ...trimmed(c.hs, c.he, c.htext), c.hkeys);
    const tm = anchor(c.sentence, ...trimmed(c.ts, c.te, c.ttext), c.tkeys);
    c.hm = hm;
    c.tm = tm;
    c.head = hm ? `${hm.label}:${hm.name}` : null;
    c.tail = tm ? `${tm.label}:${tm.name}` : null;
    c.hk = hm?.label;
    c.tk = tm?.label;
    c.anchored = Boolean(hm && tm);
    if (!c.anchored) set(c, 'drop', 'unanchored');
  }
  const legalPair = (c) => {
    const l = links.get(c.rel);
    return Boolean(l) && (l.pairs.has(`${c.hk}${SEP}${c.tk}`) || (l.symmetric === true && l.pairs.has(`${c.tk}${SEP}${c.hk}`)));
  };
  // 7 (claims accepted, for their ends): after the join, an accepted claim keeps the two mentions it
  // joined when both anchor, the pair is legal and the ends are two entities (rule 4 off: no legality).
  if (on('verdicts') && on('span-join')) {
    const promote = [];
    for (const c of claims) {
      if (latest.get(c.key)?.value !== 'accept' || !c.anchored) continue;
      if (on('legality') && (!legalPair(c) || c.head === c.tail)) continue;
      for (const m of [c.hm, c.tm]) if (m.band === 'review') promote.push(m);
    }
    for (const m of promote) set(m, 'keep', 'claim-verdict');
  }
  // 4
  if (on('legality')) {
    for (const c of claims) {
      if (c.band || !c.anchored) continue;
      if (!legalPair(c)) set(c, 'drop', 'illegal');
      else if (c.head === c.tail) set(c, 'drop', 'self-loop');
    }
  }
  // 5
  for (const c of claims) {
    if (c.band || !c.anchored) continue;
    if (!on('band')) { set(c, 'keep', 'floor'); continue; }
    const l = links.get(c.rel);
    if (!l) continue;
    set(c, c.p >= l.keep ? 'keep' : c.p <= l.drop ? 'drop' : 'review', 'band');
  }
  // 5's hedge cap: a kept claim whose sentence, up to the end of its later span, holds a cue goes to review
  if (on('hedge')) {
    const cues = store.hedgeCueRegExps();
    for (const c of claims) {
      if (c.band !== 'keep') continue;
      const upto = Array.from(c.stext).slice(0, Math.max(c.he, c.te) - c.sstart).join('');
      const hit = cues.find(([, re]) => re.test(upto));
      if (hit) { set(c, 'review', 'hedged'); c.cue = hit[0]; }
    }
  }
  // 3's cap: a claim the band would keep goes to review while an end is in review (after the promotions)
  if (on('span-join')) for (const c of claims) if (c.band === 'keep' && (c.hm?.band === 'review' || c.tm?.band === 'review')) set(c, 'review', 'end-in-review');
  // 6
  if (on('ambiguity')) {
    const kept = claims.filter((c) => c.band === 'keep');
    const groups = new Map();
    for (const c of kept) {
      const k = `${c.sentence}${SEP}${c.head}${SEP}${c.tail}`;
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    const amb = new Set();
    const rev = new Set();
    // One link per ordered pair per sentence: the best-scoring claim's link stays (unless another link is within the
    // relation margin of it); every claim of another link goes to review.
    for (const cs of groups.values()) {
      const best = [...cs].sort((a, b) => b.p - a.p || cmp(a.rel, b.rel) || cmp(a.key, b.key))[0];
      const others = cs.filter((c) => c.rel !== best.rel);
      if (!others.length) continue;
      const close = others.some((c) => c.p >= best.p - relMargin);
      for (const c of cs) if (c.rel !== best.rel || close) amb.add(c);
    }
    for (const c of kept) {
      if (kept.some((d) => d !== c && d.sentence === c.sentence && d.rel === c.rel && d.head === c.tail && d.tail === c.head) &&
          links.get(c.rel)?.symmetric === false) rev.add(c);
    }
    for (const c of kept) {
      if (amb.has(c)) set(c, 'review', 'ambiguous');
      else if (rev.has(c)) set(c, 'review', 'reversed');
    }
  }
  // 7
  if (on('verdicts')) {
    for (const c of claims) {
      const v = latest.get(c.key);
      if (v && ['band', 'floor', 'hedged', 'end-in-review', 'ambiguous', 'reversed'].includes(c.rule)) set(c, v.value === 'accept' ? 'keep' : 'drop', 'verdict');
    }
  }
  return { mentions: mentions.filter((m) => m.band), claims: claims.filter((c) => c.band) };
}

/** The rule invariant's gate settings: the defaults, each rule off, and rule 2's POLE preference off. */
const INVARIANT_CONFIGS = [
  { label: 'defaults', opts: {} },
  ...store.RULES.map((r) => ({ label: `${r} off`, opts: { off: [r] } })),
  { label: 'pole off', opts: { poleMargin: null } },
];

/** Compare the Cypher gate with the JS one: [] when they agree, else the differing keys as rows. */
function compareGates(cy, js) {
  const diffs = [];
  const cmpSet = (what, a, b, f) => {
    const ma = new Map(a.map((x) => [x.key, f(x)]));
    const mb = new Map(b.map((x) => [x.key, f(x)]));
    for (const k of new Set([...ma.keys(), ...mb.keys()])) {
      if (ma.get(k) !== mb.get(k)) diffs.push(`${what} ${k.replace(/^[0-9a-f]{64}/, (h) => h.slice(0, 8))}: cypher ${ma.get(k) ?? 'none'}, js ${mb.get(k) ?? 'none'}`);
    }
  };
  cmpSet('mention', cy.mentions, js.mentions, (m) => `${m.band}/${m.rule}${m.rule === 'other-kind' ? `/${m.alt}` : ''}`);
  cmpSet('claim', cy.claims, js.claims, (c) => `${c.band}/${c.rule}/${c.head}/${c.tail}${c.rule === 'hedged' ? `/${c.cue}` : ''}`);
  return diffs.sort(cmp);
}

// ==== a scripted model (gate.txt's and review.txt's boundary cases) ==================================
/**
 * An ontology of its own on create-context-graph's base and a model that answers from a script: the
 * spans and scores sit on the rules' boundaries, which the real model's answers never reach exactly.
 * script[prefix of a sentence] = {ents: [[text, label, p]], rels: [[LINK, head, hp, tail, tp]]}; a relation's
 * score is the lower of hp and tp (gliner.js normalize).
 */
const SCRIPTED = {
  id: 'scripted',
  yaml: ['domain:', '  id: scripted', '  name: Scripted boundaries', 'inherits: _base', 'entity_types:',
    '  - label: Patient', '    pole_type: PERSON', '    subtype: PATIENT',
    '  - label: Clinic', '    pole_type: ORGANIZATION', '    subtype: CLINIC',
    '  - label: Venue', '    pole_type: LOCATION',
    '  - label: Device', '    pole_type: OBJECT',
    '  - label: Visitor', '    pole_type: PERSON', '    subtype: VISITOR',
    'relationships:',
    '  - type: TREATED_AT', '    source: Patient', '    target: Clinic',
    '  - type: USES', '    source: Patient', '    target: Device',
    '  - type: USES', '    source: Clinic', '    target: Device',
    '  - type: VISITED', '    source: Patient', '    target: Clinic',
    '  - type: VISITED', '    source: Event', '    target: Venue',
    '  - type: REFERRED', '    source: Patient', '    target: Patient', ''].join('\n'),
  text: '# Scripted boundaries\n\nAna Ruiz was treated at Harbor Clinic.\n\nMira Holt uses the Pulse Monitor daily.\n\n' +
    'Dr. Ida Lund uses the Heart Pump.\n\nKai Moss works for Bay Labs.\n\nOla Berg sees Per Vik weekly.\n\n' +
    'Rosa Vint visited Pier Six.\n\nEva Sund referred Eva Sund.\n\nLia Dorn met Noor Vale today.\n\n' +
    'Bo Ek visited Bay Clinic.\n\nFay Orr visited Elm Clinic.\n\nCy Lam referred Dee Moe, and Dee Moe referred Cy Lam.\n\n' +
    'Gus Hale never visited Oak Clinic.\n\nLou Pak may visit Fen Clinic.\n\nNed Ash could not visit Fen Clinic.\n\n' +
    'Ivy Roe was treated at Oak Clinic, not at home.\n\n' +
    'In May, Jon Bly was treated at Fen Clinic.\n\nTod Fry was treated at the Ash Clinic.\n\nWes Pell was treated at the Birch Clinic.\n\n' +
    'Uma Lee was treated at the Pine Clinic ward.\n\nDov Kim was referred by Zed Pry.\n\n' +
    'Rae Holm visited Elm Clinic.\n\nRae Holm works for Bay Labs.\n\nKit Moor is busy.\n\nWe drove to Kit Moor.\n\n' +
    'Ivo Lea met at the Gull Rock venue.\n\nGull Rock venue opened.\n\nLin Ash uses device D-77.\n\nLin Ash uses D-77 daily.\n\n' +
    'Dr. Una Pike rests.\n',
  script: {
    // Clinic takes its span from Organization (pole-specific: 0.45 is within the pole margin of 0.65 and above the drop
    // cutoff, 0.30) and waits in review below the entity keep (0.50 at the defaults): a claim held by its tail alone
    // (end-in-review)
    'Ana Ruiz was treated': { ents: [['Ana Ruiz', 'Person', 0.9], ['Ana Ruiz', 'Patient', 0.9], ['Harbor Clinic', 'Organization', 0.65], ['Harbor Clinic', 'Clinic', 0.45]],
      rels: [['TREATED_AT', 'Ana Ruiz', 0.9, 'Harbor Clinic', 0.95]] },
    // both ends in review (rule 5): the orphan case. (The base's Object is not asked here, as in every
    // create-context-graph domain: no link names it and Device covers its pole, so the script never answers it.)
    'Mira Holt uses': { ents: [['Mira Holt', 'Patient', 0.45], ['Mira Holt', 'Person', 0.35], ['Pulse Monitor', 'Device', 0.45]],
      rels: [['USES', 'Mira Holt', 0.95, 'Pulse Monitor', 0.95]] },
    // the head end inside two mentions in review, "Ida Lund" (joined, the smaller) and "Dr. Ida Lund"
    'Dr. Ida Lund uses': { ents: [['Ida Lund', 'Patient', 0.45], ['Dr. Ida Lund', 'Patient', 0.42], ['Heart Pump', 'Device', 0.95]],
      rels: [['USES', 'Ida Lund', 0.9, 'Heart Pump', 0.95]] },
    // a Patient (in review, pole-specific) working for an Organization: illegal (WORKS_FOR is Person -> Organization)
    'Kai Moss works': { ents: [['Kai Moss', 'Person', 0.48], ['Kai Moss', 'Patient', 0.46], ['Bay Labs', 'Organization', 0.9]],
      rels: [['WORKS_FOR', 'Kai Moss', 0.9, 'Bay Labs', 0.9]] },
    // rule 2's pole margin: Patient exactly 0.25 below Person (0.75 - 0.25 = 0.5, exact in binary), and 0.26 below
    'Ola Berg sees': { ents: [['Ola Berg', 'Person', 0.75], ['Ola Berg', 'Patient', 0.5], ['Per Vik', 'Person', 0.75], ['Per Vik', 'Patient', 0.49]], rels: [] },
    // Patient -> Venue: in VISITED's domain x range, not among its pairs
    'Rosa Vint visited': { ents: [['Rosa Vint', 'Patient', 0.9], ['Pier Six', 'Venue', 0.9]], rels: [['VISITED', 'Rosa Vint', 0.9, 'Pier Six', 0.9]] },
    // both ends join one mention in review: a self-loop
    'Eva Sund referred': { ents: [['Eva Sund', 'Patient', 0.45]], rels: [['REFERRED', 'Eva Sund', 0.9, 'Eva Sund', 0.9]] },
    // rule 2: two specialisations within the margin (the better one wins), and one at or under its drop cutoff (it never does)
    'Lia Dorn met': { ents: [['Lia Dorn', 'Person', 0.8], ['Lia Dorn', 'Patient', 0.7], ['Lia Dorn', 'Visitor', 0.6], ['Noor Vale', 'Person', 0.4], ['Noor Vale', 'Patient', 0.18]], rels: [] },
    // rule 6: two links for one pair within the relation margin (0.90 and 0.88: both ambiguous), and outside it (0.90 and 0.84:
    // the better kept, the weaker ambiguous: one link per pair per sentence); then A -> B and B -> A of a one-way link (reversed)
    'Bo Ek visited': { ents: [['Bo Ek', 'Patient', 0.9], ['Bay Clinic', 'Clinic', 0.9]],
      rels: [['TREATED_AT', 'Bo Ek', 0.9, 'Bay Clinic', 0.9], ['VISITED', 'Bo Ek', 0.88, 'Bay Clinic', 0.88]] },
    'Fay Orr visited': { ents: [['Fay Orr', 'Patient', 0.9], ['Elm Clinic', 'Clinic', 0.9]],
      rels: [['TREATED_AT', 'Fay Orr', 0.9, 'Elm Clinic', 0.9], ['VISITED', 'Fay Orr', 0.84, 'Elm Clinic', 0.84]] },
    'Cy Lam referred': { ents: [['Cy Lam', 'Patient', 0.9], ['Dee Moe', 'Patient', 0.9]],
      rels: [['REFERRED', 'Cy Lam', 0.9, 'Dee Moe', 0.9], ['REFERRED', 'Dee Moe', 0.85, 'Cy Lam', 0.85]] },
    // rule 5's hedge cap: a cue between the spans ("never", "may": hedged), one after both spans ("not": kept), and "May" the
    // month before them ("may" is a cue in lower case only: kept)
    'Gus Hale never': { ents: [['Gus Hale', 'Patient', 0.9], ['Oak Clinic', 'Clinic', 0.9]], rels: [['VISITED', 'Gus Hale', 0.9, 'Oak Clinic', 0.9]] },
    'Lou Pak may': { ents: [['Lou Pak', 'Patient', 0.9], ['Fen Clinic', 'Clinic', 0.9]], rels: [['VISITED', 'Lou Pak', 0.9, 'Fen Clinic', 0.9]] },
    // two cues: the first in HEDGE_CUES' order ("not") is the one recorded
    'Ned Ash could': { ents: [['Ned Ash', 'Patient', 0.9], ['Fen Clinic', 'Clinic', 0.9]], rels: [['VISITED', 'Ned Ash', 0.9, 'Fen Clinic', 0.9]] },
    'Ivy Roe was': { ents: [['Ivy Roe', 'Patient', 0.9], ['Oak Clinic', 'Clinic', 0.9]], rels: [['TREATED_AT', 'Ivy Roe', 0.9, 'Oak Clinic', 0.9]] },
    'Jon Bly was': { ents: [['Jon Bly', 'Patient', 0.9], ['Fen Clinic', 'Clinic', 0.9]], rels: [['TREATED_AT', 'Jon Bly', 0.9, 'Fen Clinic', 0.9]] },
    // rule 3's name join: no mention contains the tail "the Ash Clinic", whose canonical name is the mention "Ash Clinic"'s
    // (joined), nor "at the Birch Clinic" (a leading preposition dropped: joined); "the Pine Clinic ward" names no mention
    // (unanchored)
    'Tod Fry was': { ents: [['Tod Fry', 'Patient', 0.9], ['Ash Clinic', 'Clinic', 0.9]], rels: [['TREATED_AT', 'Tod Fry', 0.9, 'the Ash Clinic', 0.9]] },
    'Wes Pell was': { ents: [['Wes Pell', 'Patient', 0.9], ['Birch Clinic', 'Clinic', 0.9]], rels: [['TREATED_AT', 'Wes Pell', 0.9, 'at the Birch Clinic', 0.9]] },
    // and the name join takes the mention rule 2 left in review ("Zed Pry" Patient, pole-specific at 0.45), never the
    // higher-scoring Person it dropped
    'Dov Kim was': { ents: [['Dov Kim', 'Patient', 0.9], ['Zed Pry', 'Person', 0.6], ['Zed Pry', 'Patient', 0.45]], rels: [['REFERRED', 'by Zed Pry', 0.9, 'Dov Kim', 0.9]] },
    // rule 2b, one kind per name in the store: Rae Holm kept as Patient and as Person (the domain kind stays, though
    // Person scores higher); Kit Moor as two base kinds (the higher score stays); "Gull Rock venue" as Venue (key GULL_ROCK)
    // and as Location (key GULL_ROCK_VENUE): one plain name
    'Rae Holm visited': { ents: [['Rae Holm', 'Patient', 0.9], ['Elm Clinic', 'Clinic', 0.9]], rels: [['VISITED', 'Rae Holm', 0.9, 'Elm Clinic', 0.9]] },
    'Rae Holm works': { ents: [['Rae Holm', 'Person', 0.95], ['Bay Labs', 'Organization', 0.9]], rels: [['WORKS_FOR', 'Rae Holm', 0.9, 'Bay Labs', 0.9]] },
    'Kit Moor is': { ents: [['Kit Moor', 'Organization', 0.8]], rels: [] },
    'drove to Kit Moor': { ents: [['Kit Moor', 'Location', 0.7]], rels: [] },
    'Ivo Lea met': { ents: [['Gull Rock venue', 'Venue', 0.8]], rels: [] },
    'Gull Rock venue opened': { ents: [['Gull Rock venue', 'Location', 0.9]], rels: [] },
    // "Una Pike" as Person inside "Dr. Una Pike" as Patient, one key: the Person mention drops (the same words read twice)
    'Dr. Una Pike rests': { ents: [['Dr. Una Pike', 'Patient', 0.9], ['Una Pike', 'Person', 0.95]], rels: [] },
    // the entity key: "device D-77" and "D-77" (Device) are one entity, Device:D_77
    'Lin Ash uses device': { ents: [['Lin Ash', 'Patient', 0.9], ['device D-77', 'Device', 0.9]], rels: [['USES', 'Lin Ash', 0.9, 'device D-77', 0.9]] },
    'Lin Ash uses D-77': { ents: [['Lin Ash', 'Patient', 0.9], ['D-77', 'Device', 0.9]], rels: [['USES', 'Lin Ash', 0.9, 'D-77', 0.9]] },
    'Uma Lee was': { ents: [['Uma Lee', 'Patient', 0.9], ['Pine Clinic', 'Clinic', 0.9]], rels: [['TREATED_AT', 'Uma Lee', 0.9, 'the Pine Clinic ward', 0.9]] },
  },
};
/**
 * A model handle (gliner.js extractRaw calls handle.model.extractCli) that answers from SCRIPTED.script,
 * which names kinds and links by their ids: each is answered under the label text or relation name the
 * pipeline asked for it (ontology.js asks); a kind or link the schema does not ask is a script error.
 */
const scriptedModel = {
  exports: {},
  model: {
    extractCli(text, ents, relations) {
      const key = Object.keys(SCRIPTED.script).find((k) => text.includes(k));
      const out = { entities: Object.fromEntries(ents.map((e) => [e.split(':')[0], []])), relation_extraction: Object.fromEntries(relations.map((r) => [r, []])) };
      if (!key) return JSON.stringify(out);
      const so = ontologies.get(SCRIPTED.id);
      const labelOf = (kind) => {
        const t = so.types.find((x) => x.id === kind);
        if (!t?.ask || !Object.hasOwn(out.entities, t.ask.label)) throw new Error(`SCRIPTED: the kind ${kind} is not asked`);
        return t.ask.label;
      };
      const at = (t) => {
        const i = text.indexOf(t); // ASCII text: UTF-16 and code-point offsets agree
        if (i < 0) throw new Error(`SCRIPTED: no ${JSON.stringify(t)} in ${JSON.stringify(text)}`);
        return { text: t, start: i, end: i + t.length };
      };
      const s = SCRIPTED.script[key];
      for (const [t, kind, p] of s.ents) out.entities[labelOf(kind)].push({ ...at(t), confidence: p });
      for (const [link, h, hp, t, tp] of s.rels) {
        const name = so.relations.find((x) => x.id === link)?.ask;
        if (!name || !relations.includes(name)) throw new Error(`SCRIPTED: the link ${link} is not asked`);
        out.relation_extraction[name].push({ head: { ...at(h), confidence: hp }, tail: { ...at(t), confidence: tp } });
      }
      return JSON.stringify(out);
    },
  },
};
/** The scripted store, extracted, gated and published at the defaults; its ontology joins `ontologies` (jsGate reads it). */
async function scriptedStore() {
  const o = parseOntology(SCRIPTED.yaml, { bases });
  if (o.id !== SCRIPTED.id) throw new Error(`SCRIPTED: the ontology id is ${o.id}`);
  ontologies.set(o.id, o);
  const db = freshDb();
  store.openStore(db, cl, o, {}, { model: WHICH });
  const info = { repo: 'scripted/none', rev: '0'.repeat(40), weights: '0'.repeat(64), build: pipeline.BUILD };
  await pipeline.run({ db, cl, model: scriptedModel, modelInfo: info, ontology: o, text: SCRIPTED.text, title: 'scripted' });
  return { db, oid: o.id };
}
/** @type {{db: any, oid: string} | null} the scripted store, from gate.txt's edge cases to review.txt */
let scripted = null;

// ==== gate.txt ======================================================================================
if (FULL) {
  const g = sayTo('gate');
  g('# The gate in Cypher, held to two invariants (D10; harness/run.mjs)');
  g();
  g('## the floor invariant: cutoffs never need the model (D7)');
  g(`Every candidate at p >= ${pipeline.FLOOR.toFixed(2)} is stored. For each threshold t, the stored candidates with p >= t (a Cypher`);
  g('query on the store) must equal what gliner-rs returns when run at threshold t on the same sentence:');
  g('entity spans with their labels, and relation edges with their spans. A difference is a row below.');
  g('Sentences: the first sentence of every fixture that has one and of every sample (a fixed subset, for runtime), with its');
  g(`ontology. Thresholds: ${SWEEP.map((x) => x.toFixed(2)).join(', ')}.`);
  let pairs = 0;
  let equal = 0;
  const rows = [];
  for (const { d: gd, s: sent } of floorSentences) {
    const s = stores.get(gd.ontology);
    const o = ontologies.get(gd.ontology);
    const id = docId(gd.text);
    const key = `${id}#${sent.idx}`;
    for (const th of SWEEP) {
      const { schema, kindOf, relOf } = pipeline.modelSchema(o, { threshold: th });
      const live = normalize(extractRaw(model, sent.text, schema), schema);
      const mine = new Set([
        ...live.entities.map((e) => `E ${kindOf.get(e.label)} ${e.start}-${e.end}`),
        ...live.relations.map((r) => `R ${relOf.get(r.relation)} ${r.head.start}-${r.head.end} ${r.tail.start}-${r.tail.end}`),
      ]);
      const stored = new Set([
        ...cl.exec(s.db, `MATCH (s:_Sentence {key: $key})<-[:_IN]-(m:_Mention)
WHERE $key IS NOT NULL AND $t IS NOT NULL AND m.source = 'model' AND m.p >= toFloat($t)
RETURN m.label AS label, m.start - s.start AS a, m.end - s.start AS b`, { key, t: th }).rows.map((r) => `E ${r.label} ${r.a}-${r.b}`),
        ...cl.exec(s.db, `MATCH (s:_Sentence {key: $key})<-[:_EVIDENCE]-(c:_Claim)
WHERE $key IS NOT NULL AND $t IS NOT NULL AND c.p >= toFloat($t)
RETURN c.rel AS rel, c.hs - s.start AS hs, c.he - s.start AS he, c.ts - s.start AS ts, c.te - s.start AS te`, { key, t: th }).rows
          .map((r) => `R ${r.rel} ${r.hs}-${r.he} ${r.ts}-${r.te}`),
      ]);
      pairs++;
      const onlyStored = [...stored].filter((x) => !mine.has(x)).sort(cmp);
      const onlyLive = [...mine].filter((x) => !stored.has(x)).sort(cmp);
      if (!onlyStored.length && !onlyLive.length) { equal++; continue; }
      for (const x of onlyStored) rows.push(`${gd.name} t=${th.toFixed(2)}: stored only: ${x}`);
      for (const x of onlyLive) rows.push(`${gd.name} t=${th.toFixed(2)}: gliner-rs only: ${x}`);
    }
  }
  g(`${equal} of ${pairs} (sentence, threshold) pairs equal`);
  for (const r of rows) g(`  ${r}`);
  if (rows.length) {
    g('The differences are gliner-rs decoding, not storage: with the flat overlap policy an entity span picked at');
    g('the floor can give way to a longer overlapping one once the lower-scoring candidates are gone, and a');
    g("relation's head or tail span is picked per threshold (under every overlap policy). A cutoff in the store");
    g('filters what the floor found and never re-decodes, so these spans differ from a fresh call at that threshold.');
  }
  note(`floor invariant done (${secs()})`);

  g();
  g('## the rule invariant: the Cypher gate equals a plain-JS gate over the raw JSON (D10)');
  g('Each store\'s gate (store.gateStatements, rules 1-7 in Cypher) against jsGate in harness/run.mjs, which');
  g('reads only the cached raw JSON, the ontology (its kinds\' poles from the parsed YAML) and the verdicts. Compared:');
  g('every mention\'s band and rule, every claim\'s band, rule, joined entity keys and hedge cue. Run at the defaults, with each');
  g("rule switched off, and with rule 2's POLE preference off (pole margin null), on every create-context-graph store and");
  g("on the fixtures' store.");
  for (const [oid, s] of stores) {
    const res = [];
    for (const { label, opts } of INVARIANT_CONFIGS) {
      const cy = store.gate(s.db, cl, opts);
      const js = jsGate(s.db, oid, opts);
      const diffs = compareGates(cy, js);
      res.push(`${label} ${diffs.length ? `${diffs.length} DIFFERENT` : 'equal'}`);
      if (label === 'defaults') g(`${oid}: ${cy.mentions.length} mentions, ${cy.claims.length} claims, ${cy.mentions.filter((m) => m.rule === 'pole-specific').length} pole-specific, ${cy.claims.filter((c) => c.rule === 'end-in-review').length} end-in-review`);
      if (diffs.length) for (const x of diffs) g(`  ${oid} ${label}: ${x}`);
      if (diffs.length) fail(`the Cypher gate differs from the JS gate on ${oid} (${label})`);
    }
    g(`  ${res.join('; ')}`);
    store.gate(s.db, cl); // back to the defaults
  }
  note(`rule invariant done (${secs()})`);

  g();
  g('## edge cases the bundled data does not reach, under the same invariant');
  g('A generic Ontology Graph Spec 1.1 document (harness/fixtures.mjs GENERIC_YAML: no createContextGraph extension, so its kinds are');
  g("asked by label text with each node's own description and its links between their endpoints, at the same defaults): a");
  g('symmetric link (PARTNER_OF, Company to Company) and a listed name with no canonical form (東京: names.js keeps ASCII letters');
  g("and digits only, E3), through the edgextract:symmetric and edgextract:gazetteer extensions; a pronoun the model may type as Person.");
  const eo = genericOntology;
  ontologies.set(eo.id, eo);
  const ex = newStore(eo.id);
  g(`format ${eo.format}; asked (pipeline.modelSchema): ${pipeline.modelSchema(eo).schema.entities.map((e) => (e.description ? `"${e.id}: ${e.description}"` : `"${e.id}"`)).join(', ')};`);
  g(`  ${pipeline.modelSchema(eo).schema.relations.map((r) => `"${r}"`).join(', ')}`);
  const edgeText = GENERIC_TEXT;
  const er = await pipeline.run({ db: ex.db, cl, model, modelInfo: MODEL_INFO, ontology: eo, text: edgeText, title: 'edge_cases' });
  g(`${er.counters.sentences} sentences, ${er.counters.inferences} inferences`);
  const eg = store.readGate(ex.db, cl);
  for (const m of eg.mentions.filter((x) => x.rule === 'no-name')) g(`  mention ${mentionLine(m)}`);
  for (const c of eg.claims.filter((x) => x.rel === 'PARTNER_OF')) g(`  claim ${claimLine(c)}`);
  const partners = () => cl.exec(ex.db, 'MATCH (a:_Entity)-[r:PARTNER_OF]->(b:_Entity) RETURN a.key AS a, b.key AS b, size(r.claims) AS claims ORDER BY a, b').rows
    .map((r) => `${r.a} -> ${r.b} (${r.claims} claim${r.claims === 1 ? '' : 's'})`).join('; ') || 'none';
  g(`published PARTNER_OF (symmetric: one edge per pair, the smaller key first): ${partners()}`);
  for (const c of eg.claims.filter((x) => x.rel === 'PARTNER_OF' && x.band === 'review')) store.addVerdict(ex.db, cl, { target: c.key, value: 'accept' });
  store.gate(ex.db, cl);
  store.publish(ex.db, cl);
  g(`after accepting the PARTNER_OF claims in review: ${partners()}`);
  const ediffs = [];
  for (const { opts } of INVARIANT_CONFIGS) ediffs.push(...compareGates(store.gate(ex.db, cl, opts), jsGate(ex.db, eo.id, opts)));
  g(`the Cypher gate equals the JS gate, at the defaults, with each rule off and with the POLE preference off: ${ediffs.length ? `NO (${ediffs.length})` : 'yes'}`);
  for (const x of ediffs) g(`  ${x}`);
  const audits = readdirSync(join(EX, 'queries')).filter((f) => /^audit-.*\.cypher$/.test(f)).sort();
  store.gate(ex.db, cl);
  store.publish(ex.db, cl);
  const bad = audits.filter((f) => cl.exec(ex.db, readFileSync(join(EX, 'queries', f), 'utf8')).rows.length);
  g(`the audits (queries/audit-*.cypher) on this store: ${bad.length ? `rows in ${bad.join(', ')}` : '0 rows each'}`);
  if (bad.length) fail(`audits on the edge-case store: ${bad.join(', ')}`);
  ex.db.free();
  ontologies.delete(eo.id);

  // A scripted model (no gliner-rs): spans and scores chosen to sit on a rule's boundary.
  g();
  g('## a scripted model: boundaries the real model does not reach, under the same invariant');
  g(`A create-context-graph ontology of its own on _base.yaml (${SCRIPTED.id}: Patient and Visitor specialise Person, Clinic`);
  g('Organization, Venue Location; USES and VISITED have two legal pairs each, TREATED_AT and VISITED share Patient -> Clinic),');
  g('and a model that answers each sentence from a script (harness/run.mjs SCRIPTED), at the create-context-graph defaults.');
  g('review.txt puts verdicts on the same store.');
  const sx = await scriptedStore();
  const so = ontologies.get(SCRIPTED.id);
  g(`asked as (pipeline.modelSchema): ${so.types.filter((k) => k.ask).map((k) => `${k.id} "${k.ask.label}"`).join(', ')}; not asked: ` +
    `${so.types.filter((k) => !k.ask).map((k) => k.id).join(', ') || 'none'}`);
  const sg = store.readGate(sx.db, cl);
  const mOf = (text, label) => sg.mentions.find((m) => m.text === text && m.label === label);
  const pm = D.poleMargin;
  for (const [name, base, spec] of [['Ola Berg', 0.75, 0.5], ['Per Vik', 0.75, 0.49]]) {
    const won = sg.mentions.find((m) => m.text === name && m.rule !== 'one-kind');
    g(`rule 2 at the pole margin ${f3(pm)}: "${name}" Person ${f3(mOf(name, 'Person').p)}, Patient ${f3(mOf(name, 'Patient').p)} ` +
      `(${spec >= base - pm ? 'exactly at' : 'just past'} the margin): ${won.label} wins, ${won.band} by ${won.rule}`);
  }
  const lia = sg.mentions.find((m) => m.text === 'Lia Dorn' && m.rule !== 'one-kind');
  g(`rule 2 with two specialisations within the margin: "Lia Dorn" Person ${f3(mOf('Lia Dorn', 'Person').p)}, Patient ${f3(mOf('Lia Dorn', 'Patient').p)}, ` +
    `Visitor ${f3(mOf('Lia Dorn', 'Visitor').p)}: ${lia.label} wins, ${lia.band} by ${lia.rule}`);
  const noor = sg.mentions.find((m) => m.text === 'Noor Vale' && m.rule !== 'one-kind');
  g(`rule 2 never gives the words to a specialisation at or under its drop cutoff (${f3(DEF.entDrop)}): "Noor Vale" Person ${f3(mOf('Noor Vale', 'Person').p)}, ` +
    `Patient ${f3(mOf('Noor Vale', 'Patient').p)}: ${noor.label} wins, ${noor.band} by ${noor.rule}`);
  const visited = sg.claims.find((c) => c.rel === 'VISITED' && c.htext === 'Rosa Vint');
  g(`rule 4 by exact pairs: VISITED is Patient -> Clinic and Event -> Venue; ${JSON.stringify(visited.htext)} (${visited.head.split(':')[0]}) ` +
    `-[VISITED]-> ${JSON.stringify(visited.ttext)} (${visited.tail.split(':')[0]}): ${visited.band} by ${visited.rule} (domain x range would allow it)`);
  const claimsOf = (head) => sg.claims.filter((c) => c.htext === head).sort((a, b) => b.p - a.p || cmp(a.key, b.key))
    .map((c) => `${c.rel} ${f3(c.p)} ${c.band} by ${c.rule}`).join(', ');
  g(`rule 6 at the relation margin ${f3(D.relMargin)}: "Bo Ek" -> "Bay Clinic", two links 0.02 apart: ${claimsOf('Bo Ek')}`);
  g(`  "Fay Orr" -> "Elm Clinic", 0.06 apart: ${claimsOf('Fay Orr')}`);
  g(`rule 6, one way and back: REFERRED is one-way; "Cy Lam" -> "Dee Moe" and back: ${['Cy Lam', 'Dee Moe'].map((h) => `${h}: ${claimsOf(h)}`).join('; ')}`);
  const hedgeOf = (head) => sg.claims.filter((c) => c.htext === head).map((c) => `${c.rel} ${f3(c.p)} ${c.band} by ${c.rule}${c.cue ? ` (cue "${c.cue}")` : ''}`).join(', ');
  g(`rule 5's hedge cap (a cue from the sentence's start to the end of the later span): "Gus Hale never visited Oak Clinic.": ${hedgeOf('Gus Hale')};`);
  g(`  "Lou Pak may visit Fen Clinic.": ${hedgeOf('Lou Pak')}; "Ned Ash could not visit Fen Clinic." (two cues, the first in HEDGE_CUES' order kept): ${hedgeOf('Ned Ash')};`);
  g(`  "Ivy Roe was treated at Oak Clinic, not at home." (after both spans): ${hedgeOf('Ivy Roe')};`);
  g(`  "In May, Jon Bly was treated at Fen Clinic." ("may" and "no" are cues in lower case only): ${hedgeOf('Jon Bly')}`);
  const joinOf = (head) => sg.claims.filter((c) => c.htext === head).map((c) => `${JSON.stringify(c.ttext)} -> ${c.tail ?? 'nothing'}: ${c.band} by ${c.rule}`).join(', ');
  g(`rule 3's name join (no mention contains the end; one of its sentence has its canonical name): "Tod Fry" -[TREATED_AT]-> ${joinOf('Tod Fry')};`);
  g(`  "Wes Pell" -[TREATED_AT]-> ${joinOf('Wes Pell')} (a leading preposition dropped); "Uma Lee" -[TREATED_AT]-> ${joinOf('Uma Lee')}`);
  const zed = sg.claims.find((c) => c.htext === 'by Zed Pry');
  g(`  "by Zed Pry" -[REFERRED]-> "Dov Kim" (Zed Pry: Person ${f3(mOf('Zed Pry', 'Person').p)} dropped by one-kind, Patient ${f3(mOf('Zed Pry', 'Patient').p)} ` +
    `${mOf('Zed Pry', 'Patient').band} by ${mOf('Zed Pry', 'Patient').rule}): head ${zed.head ?? 'nothing'}, ${zed.band} by ${zed.rule}`);
  const kindsOf = (text) => sg.mentions.filter((m) => m.text === text).sort((a, b) => cmp(a.key, b.key))
    .map((m) => `${m.label} ${f3(m.p)} (key ${m.label}:${m.name}) ${m.band} by ${m.rule}${m.alt ? ` (kept as ${m.alt})` : ''}`).join(', ');
  g(`rule 2b, one kind per name in the store: "Rae Holm": ${kindsOf('Rae Holm')};`);
  g(`  its claims: ${sg.claims.filter((c) => c.htext === 'Rae Holm').map((c) => `${c.rel} ${c.band} by ${c.rule}`).join(', ')}`);
  g(`  "Kit Moor", two base kinds: ${kindsOf('Kit Moor')}`);
  g(`  "Gull Rock venue", one plain name under two keys: ${kindsOf('Gull Rock venue')}`);
  g(`  "Una Pike" inside "Dr. Una Pike", one key: ${kindsOf('Dr. Una Pike')}; ${kindsOf('Una Pike')}`);
  store.publish(sx.db, cl);
  const entOf = (kind, name) => cl.exec(sx.db, 'MATCH (e:_Entity {key: $k}) WHERE $k IS NOT NULL RETURN e.display AS d, e.mentions AS n', { k: `${kind}:${name}` }).rows
    .map((r) => `${kind}:${name} (display ${JSON.stringify(r.d)}, ${r.n} mentions)`).join('') || `${kind}:${name} not published`;
  g(`the entity key (names.js entityName): "device D-77" and "D-77" (Device): ${kindsOf('device D-77')}; ${kindsOf('D-77')}; published as ${entOf('Device', 'D_77')}`);
  g(`  "Dr. Ida Lund" and "Ida Lund" (Patient): keys ${['Dr. Ida Lund', 'Ida Lund'].map((t) => sg.mentions.filter((m) => m.text === t).map((m) => `${m.label}:${m.name}`).join()).join(' and ')}`);
  const sdiffs = [];
  for (const { opts } of INVARIANT_CONFIGS) sdiffs.push(...compareGates(store.gate(sx.db, cl, opts), jsGate(sx.db, SCRIPTED.id, opts)));
  g(`the Cypher gate equals the JS gate, at the defaults, with each rule off and with the POLE preference off: ${sdiffs.length ? `NO (${sdiffs.length})` : 'yes'}`);
  for (const x of sdiffs) g(`  ${x}`);
  if (sdiffs.length) fail('the Cypher gate differs from the JS gate on the scripted store');
  store.gate(sx.db, cl);
  store.publish(sx.db, cl);
  const sbad = audits.filter((f) => cl.exec(sx.db, readFileSync(join(EX, 'queries', f), 'utf8')).rows.length);
  g(`the audits on this store: ${sbad.length ? `rows in ${sbad.join(', ')}` : '0 rows each'}`);
  if (sbad.length) fail(`audits on the scripted store: ${sbad.join(', ')}`);
  scripted = sx;
}

// ==== audit.txt =====================================================================================
const QUERIES = join(EX, 'queries');
/** A queries/*.cypher file: its text and the example values of its documented parameters. */
function queryFile(name) {
  const text = readFileSync(join(QUERIES, name), 'utf8');
  const params = {};
  for (const m of text.matchAll(/^\/\/ @param (\w+) \S+ (.+?)(?:\s{2,}.*)?$/gm)) params[m[1]] = JSON.parse(m[2]);
  const title = (/^\/\/ (.+)$/m.exec(text) ?? [, name])[1];
  return { name, text, params, title };
}
const ccgStores = () => [...stores].filter(([oid]) => groupOf.get(oid) === 'ccg');
if (FULL) {
  const a = sayTo('audit');
  a('# Audits of the stores after the first pass (harness/run.mjs; queries/audit-*.cypher)');
  a("Each audit is a query that must return 0 rows, on every store, at the default gate after publish: the fixtures' store");
  a(`(listed) and the ${ccgStores().length} create-context-graph stores (counted).`);
  const audits = readdirSync(QUERIES).filter((f) => /^audit-.*\.cypher$/.test(f)).sort().map(queryFile);
  for (const qf of audits) {
    const got = [];
    const ccgRows = [];
    for (const [oid, s] of stores) {
      const rows = cl.exec(s.db, qf.text, qf.params).rows;
      if (groupOf.get(oid) === 'fixtures') got.push(`${oid} ${rows.length}`);
      else if (rows.length) ccgRows.push(`${oid} ${rows.length}`);
      for (const r of rows.slice(0, 10)) a(`  ROW ${oid}: ${JSON.stringify(r)}`);
      if (rows.length) fail(`${qf.name} found ${rows.length} rows on ${oid}`);
    }
    a(`${qf.name}: ${qf.title.replace(/^Audit: /, '')}`);
    a(`  rows: ${got.join(', ')}; create-context-graph: ${ccgRows.length ? ccgRows.join(', ') : `0 on each of ${ccgStores().length}`}`);
  }

  a();
  a('## the graph type is the backstop: a deliberately illegal publish is refused (O4, D16)');
  {
    const s = stores.get(FIXTURE_ONTOLOGY);
    const ents = cl.exec(s.db, "MATCH (e:_Entity) WHERE e.kind IN ['Location', 'Organization'] RETURN e.kind AS kind, e.key AS key ORDER BY kind, key").rows;
    const loc = ents.find((e) => e.kind === 'Location');
    const org = ents.find((e) => e.kind === 'Organization');
    a(`${FIXTURE_ONTOLOGY}: WORKS_FOR is typed (:Person)-[:WORKS_FOR]->(:Organization); publish ${loc?.key} -[WORKS_FOR]-> ${org?.key} through store.writeTypedEdges`);
    let res;
    try {
      res = `written (${store.writeTypedEdges(s.db, cl, 'WORKS_FOR', [{ a: loc.key, b: org.key, p: 0.99, claims: [], sentences: [], docs: [] }], 999)})`;
    } catch (e) {
      res = e instanceof cl.RelateWasmError ? `${e.category}: ${e.message}` : `threw ${e.message}`;
    }
    a(`  -> ${res}`);
    if (!/^constraint: ConstraintValidationFailed: endpoint label presence verification failed/.test(res)) fail(`the illegal publish was not refused by the graph type: ${res}`);
    const left = cl.exec(s.db, 'MATCH (:Location)-[r:WORKS_FOR]->() RETURN count(r) AS n').rows[0].n;
    a(`  WORKS_FOR edges from a Location afterwards: ${left}`);
    let res2;
    try {
      res2 = `written (${store.writeTypedEdges(s.db, cl, 'FOUNDED', [], 999)})`;
    } catch (e) {
      res2 = `${e.name}: ${e.message}`;
    }
    a(`a link the ontology does not have (FOUNDED) -> ${res2}`);
  }

  a();
  a('## R16: an ontology edit (ALTER CURRENT GRAPH TYPE SET) drops every UNIQUE constraint; the store puts its own back');
  {
    const o = ontologies.get(FIXTURE_ONTOLOGY);
    // one more kind, first: a node Product at the top of the document's nodes
    if (!o.yaml.includes('\nnodes:\n')) throw new Error(`${FIXTURE_ONTOLOGY}: the document has no nodes map to edit`);
    const edited = parseOntology(o.yaml.replace('\nnodes:\n', '\nnodes:\n  Product:\n    label: Product\n    description: A named product.\n' +
      '    extensions:\n      custom:\n        createContextGraph:pole:\n          pole_type: OBJECT\n          origin: domain\n'));
    const names = store.STORE_CONSTRAINTS.map((x) => /^CREATE CONSTRAINT (\S+) /.exec(x)[1]);
    const have = (db) => {
      const got = new Set(cl.exec(db, 'SHOW CONSTRAINTS YIELD name, type RETURN name, type').rows
        .filter((r) => r.type === 'NODE_PROPERTY_UNIQUENESS').map((r) => r.name));
      return `${names.filter((x) => got.has(x)).length} of ${names.length}`;
    };
    const x = newStore(FIXTURE_ONTOLOGY);
    a(`a fresh ${FIXTURE_ONTOLOGY} store: its UNIQUE constraints ${have(x.db)}`);
    const r1 = applyOntology(x.db, edited, cl);
    a(`ontology.js applyOntology(${FIXTURE_ONTOLOGY} + Product): altered ${r1.altered}; the store's UNIQUE constraints ${have(x.db)}`);
    store.ensureConstraints(x.db, cl);
    a(`store.ensureConstraints: ${have(x.db)}; the lookup-index check passes (R9): ${store.checkLookupIndexes(x.db, cl).length} lookup indexes built`);
    const y = newStore(FIXTURE_ONTOLOGY);
    const r2 = store.applyOntologyToStore(y.db, cl, edited);
    a(`store.applyOntologyToStore(${FIXTURE_ONTOLOGY} + Product) on another fresh store: altered ${r2.altered}; the store's UNIQUE constraints ${have(y.db)}`);
    x.db.free();
    y.db.free();
  }

  a();
  a('## entities across documents (queries/03-entities-across-documents.cypher)');
  {
    const qf = queryFile('03-entities-across-documents.cypher');
    for (const [oid, s] of stores) {
      const rows = cl.exec(s.db, qf.text, qf.params).rows;
      if (!rows.length) continue;
      a(`${oid}:`);
      for (const r of rows) a(`  ${r.entity} (${r.kind}): ${r.documents.join(', ')}`);
    }
  }
  a();
  a('## entity keys with more than one display (the surface texts behind one KIND:NAME key, E3)');
  {
    const qf = queryFile('report-keys-displays.cypher');
    let any = false;
    for (const [oid, s] of stores) {
      for (const r of cl.exec(s.db, qf.text, qf.params).rows) {
        any = true;
        a(`${oid}: ${r.entity} shown as ${r.displays.map((x) => JSON.stringify(x)).join(', ')}; name ${JSON.stringify(r.name)}`);
      }
    }
    if (!any) a('none');
  }

  a();
  a('## the saved console queries (queries/[0-9]*.cypher, D11): rows on each store');
  a("The fixtures' store alone; the create-context-graph stores as a total and the stores with rows.");
  for (const qf of readdirSync(QUERIES).filter((f) => /^\d.*\.cypher$/.test(f)).sort().map(queryFile)) {
    const got = [];
    let total = 0;
    let withRows = 0;
    for (const [oid, s] of stores) {
      try {
        const r = cl.exec(s.db, qf.text, qf.params);
        if (groupOf.get(oid) === 'fixtures') got.push(`${oid} ${r.rows.length}`);
        else {
          total += r.rows.length;
          if (r.rows.length) withRows++;
        }
      } catch (e) {
        got.push(`${oid} ERROR ${e.message}`);
        fail(`${qf.name} on ${oid}: ${e.message}`);
      }
    }
    const ps = Object.entries(qf.params).map(([k, v]) => `$${k}=${JSON.stringify(v)}`).join(' ');
    a(`${qf.name}${ps ? ` (${ps})` : ''}: ${got.join(', ')}; create-context-graph: ${total} rows, from ${withRows} of ${ccgStores().length} stores`);
  }

  a();
  a('## dump.json (D17): store.dumpStore, loaded into a fresh store by lib/replay.mjs');
  for (const [oid, s] of stores) {
    const text = store.dumpStore(s.db);
    const d = replay.parse(text);
    const fresh = freshDb();
    const loaded = replay.load(fresh, d);
    const same = replay.contentDigest(fresh) === replay.digest(d);
    const again = store.dumpStore(fresh) === text;
    a(`${oid}: ${loaded.nodes} nodes, ${loaded.relationships} relationships, ${loaded.constraints} constraints, ${loaded.indexes} indexes; ` +
      `content digest equal ${same ? 'yes' : 'NO'}; dumped again byte-identical ${again ? 'yes' : 'NO'}`);
    if (!same || !again) fail(`dump.json round trip on ${oid}`);
    fresh.free();
  }

  a();
  toolsAudit(a);
  note(`audits done (${secs()})`);
}

/**
 * The raw text a tool run gets for each parameter (as typed into the page): a value its one_of
 * allows first, else '' when it has a default (the default applies), else the value its description
 * suggests ("(default: 10)"), else 10 for a number, true, 2024-01-01, a one-item list, and `name` for
 * any other STRING. web/console.js toolArgs then checks and types it, as the page does.
 * @param {any} tool @param {string} name
 */
function sampleArgs(tool, name) {
  /** @type {Record<string, string>} */
  const raw = {};
  for (const s of toolParams(tool)) {
    if (s.oneOf) raw[s.name] = typeof s.oneOf[0] === 'string' ? s.oneOf[0] : JSON.stringify(s.oneOf[0]);
    else if (s.default !== undefined) raw[s.name] = '';
    else if (s.hint !== null) raw[s.name] = s.hint;
    else if (/^(?:INTEGER|INT|FLOAT)$/.test(s.type)) raw[s.name] = '10';
    else if (/^(?:BOOLEAN|BOOL)$/.test(s.type)) raw[s.name] = 'true';
    else if (s.type === 'DATE') raw[s.name] = '2024-01-01';
    else if (/DATETIME/.test(s.type)) raw[s.name] = '2024-01-01T00:00:00Z';
    else if (s.type.startsWith('LIST')) raw[s.name] = JSON.stringify([/^LIST\s*<\s*(?:INTEGER|INT|FLOAT)\s*>$/.test(s.type) ? 10 : name]);
    else raw[s.name] = name;
  }
  return raw;
}

/**
 * audit.txt's last section: every canonicalQuery tool of each create-context-graph domain (the
 * the `tools` custom extension, ontology.js o.tools) run on a copy of that domain's store, with
 * the page's argument checks (web/console.js toolArgs) and its note's prediction (toolCompat) beside
 * the outcome. Read-only: a copy loaded from store.dumpStore, whose content digest must not move.
 * @param {(s?: string) => void} a
 */
function toolsAudit(a) {
  const ccg = ccgStores().sort((x, y) => cmp(x[0], y[0]));
  const indexes = storeIndexNames(store.LOOKUP_INDEXES, [...store.STORE_CONSTRAINTS, ...ONTOLOGY_CONSTRAINTS, store.STORE_FULLTEXT]);
  const procedures = cl.exec(ccg[0][1].db, 'SHOW PROCEDURES YIELD name RETURN name ORDER BY name').rows.map((r) => String(r.name));
  a("## the ontologies' example queries (the `tools` custom extension) on the create-context-graph stores");
  a("create-context-graph's agent tools and default views, written for its full Neo4j graphs, run on the graphs this example");
  a('extracts from the samples: every canonicalQuery tool of each domain, on a copy of its store (store.dumpStore loaded by');
  a('lib/replay.mjs into a fresh in-memory database), with its arguments checked and typed as the page checks them');
  a('(web/console.js toolArgs: never a missing or null parameter, R3). Arguments: a STRING gets the name of the store\'s');
  a('first kept entity of the tool\'s kind (else its first kept entity, else "x"); a parameter whose description suggests a');
  a('value ("(default: 10)") that value; a default its default; numbers 10, booleans true, dates 2024-01-01, lists one name.');
  a('Outcome: rows (1 or more), empty (0 rows), or error (the first line of the engine\'s message). Beside it, what the');
  a("page's note on the tool (web/console.js toolCompat, which never runs the query) predicted: rows, empty, error, an error if");
  a('reached (a clause before a call on a missing index can leave no rows) or checked at run (an index named by a parameter).');
  const idxSame = ccg.filter(([, s]) => JSON.stringify(cl.exec(s.db, 'SHOW INDEXES YIELD name RETURN name ORDER BY name').rows.map((r) => r.name)) === JSON.stringify(indexes)).length;
  a(`SHOW PROCEDURES lists ${procedures.length} procedures; SHOW INDEXES on each store equals the page's list of a store's ${indexes.length} indexes: ` +
    `${idxSame} of ${ccg.length} stores`);
  if (idxSame !== ccg.length) fail(`SHOW INDEXES differs from storeIndexNames on ${ccg.length - idxSame} create-context-graph stores`);
  const pad = (x, n) => String(x).padEnd(n);
  const lpad = (x, n) => String(x).padStart(n);
  a();
  a(`${pad('domain', 22)} ${lpad('tools', 5)} ${lpad('rows', 5)} ${lpad('empty', 5)} ${lpad('error', 5)}   predicted rows/empty/error/if reached/at run`);
  const OUT = ['rows', 'empty', 'error'];
  const PRED = ['rows', 'empty', 'error', 'error if reached', 'checked at run'];
  const zero = () => Object.fromEntries(PRED.map((p) => [p, 0]));
  const total = { tools: 0, rows: 0, empty: 0, error: 0, predicted: zero() };
  /** predicted -> outcome -> count */
  const matrix = Object.fromEntries(PRED.map((p) => [p, Object.fromEntries(OUT.map((o) => [o, 0]))]));
  const errors = [];
  const wrong = [];
  const withRows = [];
  const refused = [];
  /** predicted rows, got empty: on a store with no entity of the tool's kind, or with one */
  const emptyWhy = { noKind: 0, kind: 0, /** @type {string[]} */ withKind: [] };
  /** (domain, kind) pairs that carry tools, and those whose store holds an entity of the kind */
  const kindPairs = { all: 0, withEntity: 0 };
  let unchanged = 0;
  for (const [oid, s] of ccg) {
    const o = ontologies.get(oid);
    const d = replay.parse(store.dumpStore(s.db));
    const copy = freshDb();
    replay.load(copy, d);
    const before = replay.digest(d);
    const ents = cl.exec(copy, 'MATCH (e:_Entity) WHERE e.kind IS NOT NULL RETURN e.kind AS kind, e.name AS name ORDER BY e.key').rows;
    const nameFor = (tool) => (tool.anchor.kind === 'node' ? ents.find((e) => e.kind === tool.anchor.label)?.name : undefined) ?? ents[0]?.name ?? 'x';
    for (const k of new Set(o.tools.filter((t) => t.anchor.kind === 'node').map((t) => t.anchor.label))) {
      kindPairs.all++;
      if (ents.some((e) => e.kind === k)) kindPairs.withEntity++;
    }
    const row = { tools: 0, rows: 0, empty: 0, error: 0, predicted: zero() };
    const got = [];
    for (const tool of o.tools.filter((t) => t.type === 'canonicalQuery' && t.cypher)) {
      row.tools++;
      const note = toolCompat(tool, { kinds: o.types, links: o.relations, procedures, indexes });
      const args = toolArgs(tool, sampleArgs(tool, nameFor(tool)));
      if (!args.ok) {
        refused.push(`${oid} ${tool.name}: ${args.problems.map((p) => p.message).join(' ')}`);
        continue;
      }
      let outcome;
      let n = 0;
      try {
        n = cl.exec(copy, tool.cypher, args.params).rows.length;
        outcome = n ? 'rows' : 'empty';
      } catch (e) {
        if (!(e instanceof cl.RelateWasmError)) throw e;
        outcome = 'error';
        const first = e.message.split('\n')[0];
        const cat = /procedure/i.test(first) ? 'procedure' : ['syntax', 'semantic', 'type'].includes(e.category) ? e.category : 'other';
        errors.push({ cat, line: `${oid} ${tool.name}: ${first.length > 140 ? `${first.slice(0, 140)}...` : first}` });
      }
      row[outcome]++;
      row.predicted[note.predict]++;
      matrix[note.predict][outcome]++;
      if (outcome === 'rows') got.push(`${tool.name} ${n}`);
      if (note.predict === 'rows' && outcome === 'empty') {
        if (tool.anchor.kind === 'node' && !ents.some((e) => e.kind === tool.anchor.label)) emptyWhy.noKind++;
        else {
          emptyWhy.kind++;
          emptyWhy.withKind.push(`${oid} ${tool.name}`);
        }
      }
      if (!PREDICT_ALLOWS[note.predict].includes(outcome)) wrong.push(`${oid} ${tool.name}: predicted ${note.predict}, got ${outcome}`);
    }
    if (replay.contentDigest(copy) === before) unchanged++;
    else fail(`a tool changed the copy of ${oid}`);
    copy.free();
    for (const k of ['tools', ...OUT]) total[k] += row[k];
    for (const k of PRED) total.predicted[k] += row.predicted[k];
    a(`${pad(oid, 22)} ${lpad(row.tools, 5)} ${lpad(row.rows, 5)} ${lpad(row.empty, 5)} ${lpad(row.error, 5)}   ${PRED.map((k) => row.predicted[k]).join('/')}`);
    withRows.push(`${oid}: ${got.length ? got.join(', ') : 'none'}`);
  }
  a(`${pad('all', 22)} ${lpad(total.tools, 5)} ${lpad(total.rows, 5)} ${lpad(total.empty, 5)} ${lpad(total.error, 5)}   ${PRED.map((k) => total.predicted[k]).join('/')}`);
  a();
  a('the note\'s prediction against the outcome ("rows" only says a query can return rows, so "rows, got empty" is no miss;');
  a('"an error if reached" allows error or empty; "checked at run" allows any):');
  for (const p of PRED) a(`  predicted ${pad(p, 16)} (${lpad(OUT.reduce((x, o) => x + matrix[p][o], 0), 3)}): ${OUT.map((o) => `${o} ${matrix[p][o]}`).join(', ')}`);
  a(`  of the ${emptyWhy.noKind + emptyWhy.kind} predicted rows that got none, ${emptyWhy.noKind} ran on a store with no entity of the tool's kind ` +
    `(its first entity's name was the argument), ${emptyWhy.kind} on a store with one:`);
  a(`    ${emptyWhy.withKind.join(', ')}`);
  a(`  the (domain, kind) pairs that carry tools: ${kindPairs.all}, of which ${kindPairs.withEntity} have an entity of the kind in their store`);
  a(`  misses: ${wrong.length ? '' : 'none'}`);
  for (const w of wrong) a(`    ${w}`);
  a(`refused by the page's checks before running: ${refused.length ? '' : 'none'}`);
  for (const r of refused) a(`  ${r}`);
  if (refused.length) fail(`${refused.length} tool runs refused by toolArgs on sampleArgs`);
  a(`errors, by category: ${errors.length ? [...new Set(errors.map((e) => e.cat))].sort(cmp).map((c) => `${c} ${errors.filter((e) => e.cat === c).length}`).join(', ') : 'none'}`);
  for (const e of errors.sort((x, y) => cmp(x.cat, y.cat))) a(`  ${e.cat}: ${e.line}`);
  a('the tools that returned rows, with their row counts:');
  for (const w of withRows) a(`  ${w}`);
  a(`each copy's content digest after its tools ran: unchanged on ${unchanged} of ${ccg.length} (no tool wrote)`);

  // The note on index procedures: a missing index errors only when the query reaches the call (a null query
  // vector hides it: it returns no rows, even on a missing index), and the note says "an error" only when nothing
  // before the call can leave no rows.
  a();
  a("the note on index procedures (toolCompat) against the engine. A missing index errors once the query reaches the call");
  a("(IndexDoesNotExist, for both index kinds); a null query vector returns no rows even then (R23). The note says no rows when a");
  a("required MATCH before the call matches nothing or the vector is never written, an error when the call is certainly");
  a("reached, an error if reached when a clause before it can leave no rows (a MATCH, an UNWIND, a subquery, ...), and");
  a("checked at run for an index named by a parameter. Each case: predicted, the outcome, and whether the outcome is one the");
  a("prediction allows (rows also allows empty; an error if reached allows error or empty; checked at run allows any).");
  /** @param {string} label @param {any} db @param {any} o @param {string} cypher @param {Record<string, any>|null} params @param {boolean} [premise] */
  const indexCase = (label, db, o, cypher, params, premise = true) => {
    const idx = cl.exec(db, 'SHOW INDEXES YIELD name RETURN name ORDER BY name').rows.map((r) => String(r.name));
    const note = toolCompat({ type: 'canonicalQuery', cypher }, { kinds: o.types, links: o.relations, procedures, indexes: idx });
    let outcome;
    try {
      outcome = cl.exec(db, cypher, params).rows.length ? 'rows' : 'empty';
    } catch (e) {
      if (!(e instanceof cl.RelateWasmError)) throw e;
      outcome = `error (${e.message.split('\n')[0]})`;
    }
    const ok = PREDICT_ALLOWS[note.predict].includes(outcome.split(' ')[0]);
    const why = note.predict === 'rows' ? '' : ` (${note.reasons.find((r) => r.predict === note.predict)?.text ?? ''})`;
    a(`  ${label}: ${cypher.replace(/\s+/g, ' ').trim()}`);
    a(`    predicted ${note.predict}${why}; got ${outcome}: ${ok ? 'allowed' : premise ? 'MISS' : 'outside the note\'s premise'}`);
    if (!ok && premise) fail(`toolCompat predicted ${note.predict} for ${label}, which gave ${outcome}`);
    return ok;
  };
  // The two bundled vector tools on four stores: extracted (no decision_id, no embedding) with and without the
  // index; then with both properties written by hand, which an extracted graph never has (the note's premise).
  for (const [oid, toolName, kind, index, idProp] of [['financial-services', 'find_similar_decisions', 'Decision', 'decision_embeddings', 'decision_id'],
    ['software-engineering', 'find_similar_incidents', 'Incident', 'incident_embeddings', 'incident_id']]) {
    const o = ontologies.get(oid);
    const tool = o.tools.find((t) => t.name === toolName);
    for (const shape of ['extracted, no index', 'extracted, with the index', `${idProp} and embedding written by hand, no index`, `${idProp} and embedding written by hand, with the index`]) {
      const db = freshDb();
      store.openStore(db, cl, o, {}, { model: 'small' });
      if (shape.startsWith('extracted')) cl.exec(db, `CREATE (:_Entity:${kind} {key: '${kind}:X', kind: '${kind}', name: 'X'})`);
      else {
        cl.exec(db, `CREATE (:_Entity:${kind} {key: '${kind}:X', kind: '${kind}', name: 'X', ${idProp}: 'D1', embedding: [1.0, 0.0, 0.0]}), ` +
          `(:_Entity:${kind} {key: '${kind}:Y', kind: '${kind}', name: 'Y', ${idProp}: 'D2', embedding: [0.9, 0.1, 0.0]})`);
      }
      if (shape.endsWith('with the index')) {
        cl.exec(db, `CREATE VECTOR INDEX ${index} IF NOT EXISTS FOR (n:${kind}) ON (n.embedding) OPTIONS {indexConfig: {\`vector.dimensions\`: 3, \`vector.similarity_function\`: 'cosine'}}`);
      }
      indexCase(`${oid} ${toolName}, ${shape}`, db, o, tool.cypher, { [idProp]: 'D1' }, shape.startsWith('extracted'));
      db.free();
    }
  }
  // Queries on a copy of the financial-services sample store (Person, Decision and _Sentence nodes; no index 'nope').
  const fsCopy = freshDb();
  replay.load(fsCopy, replay.parse(store.dumpStore(ccg.find(([id]) => id === 'financial-services')[1].db)));
  const fo = ontologies.get('financial-services');
  for (const [label, cypher, params] of /** @type {Array<[string, string, Record<string, any>|undefined]>} */ ([
    ['a full-text index the store has', "MATCH (s:_Sentence) WITH s LIMIT 1 CALL db.index.fulltext.queryNodes('sentence_text', 'Whitlock') YIELD node RETURN node"],
    ['the call first, then a MATCH that finds nothing', "CALL db.index.fulltext.queryNodes('nope', 'x') YIELD node MATCH (n:Nope) RETURN n"],
    ['a MATCH on a label the ontology lacks before the call', "MATCH (d:Nope) CALL db.index.fulltext.queryNodes('nope', 'x') YIELD node RETURN node"],
    ['a MATCH on a kind before the call', "MATCH (d:Decision) CALL db.index.fulltext.queryNodes('nope', 'x') YIELD node RETURN node"],
    ['a required MATCH on a never-written property before the call', "MATCH (p:Person {person_id: 'P-1'}) CALL db.index.fulltext.queryNodes('nope', 'x') YIELD node RETURN node"],
    ['an OPTIONAL MATCH, then a never-written vector', "OPTIONAL MATCH (d:Decision {decision_id: 'x'}) CALL db.index.vector.queryNodes('nope', 5, d.embedding) YIELD node RETURN node"],
    ['a literal null vector', "MATCH (p:Person) WITH p LIMIT 1 CALL db.index.vector.queryNodes('nope', 5, null) YIELD node RETURN node"],
    ['a literal vector after a MATCH', "MATCH (p:Person) WITH p LIMIT 1 CALL db.index.vector.queryNodes('nope', 5, [1.0, 0.0, 0.0]) YIELD node RETURN node"],
    ['a vector parameter after a MATCH', "MATCH (p:Person) WITH p LIMIT 1 CALL db.index.vector.queryNodes('nope', 5, $v) YIELD node RETURN node", { v: [1.0, 0.5] }],
    ['an empty UNWIND before the call', "UNWIND [] AS x CALL db.index.fulltext.queryNodes('nope', 'x') YIELD node RETURN node"],
    ['a WHERE on a never-written property before the call', "MATCH (p:Person) WHERE p.ssn = 'x' CALL db.index.fulltext.queryNodes('nope', 'x') YIELD node RETURN node"],
    ['a coalesce() vector', "MATCH (p:Person) WITH p LIMIT 1 CALL db.index.vector.queryNodes('nope', 5, coalesce(p.embedding, [1.0, 0.0])) YIELD node RETURN node"],
    ['the call alone', "CALL db.index.vector.queryNodes('nope', 5, [1.0, 0.0]) YIELD node RETURN node"],
    ['the call alone, the name in double quotes', 'CALL db.index.fulltext.queryNodes("nope", "x") YIELD node RETURN node'],
    ['the index named by a parameter', "CALL db.index.fulltext.queryNodes($i, 'x') YIELD node RETURN node", { i: 'nope' }],
    ['the index named by a parameter, one the store has', "CALL db.index.fulltext.queryNodes($i, 'Whitlock') YIELD node RETURN node", { i: 'sentence_text' }],
    ['queryRelationships alone', "CALL db.index.vector.queryRelationships('nope', 5, [1.0, 0.0]) YIELD relationship RETURN relationship"],
    ['a never-written vector, spaced', "MATCH (p:Person) WITH p LIMIT 1 CALL db.index.vector.queryNodes('nope', 5, p . embedding) YIELD node RETURN node"],
    ['a never-written vector on a WITH alias', "MATCH (p:Person) WITH p AS q LIMIT 1 CALL db.index.vector.queryNodes('nope', 5, q.embedding) YIELD node RETURN node"],
    ['a STRING property as the vector', "MATCH (p:Person) WITH p LIMIT 1 CALL db.index.vector.queryNodes('nope', 5, p.name) YIELD node RETURN node"],
    ['an empty MATCH after a WITH, before the call', "MATCH (p:Person) WITH p MATCH (d:Nope) CALL db.index.fulltext.queryNodes('nope', 'x') YIELD node RETURN node"],
    ['a subquery that finds nothing before the call', "CALL { MATCH (d:Nope) RETURN d } CALL db.index.fulltext.queryNodes('nope', 'x') YIELD node RETURN node"],
    ['a MATCH that finds nothing after a call a clause may not reach', "MATCH (p:Person) WITH p LIMIT 1 CALL db.index.fulltext.queryNodes('nope', 'x') YIELD node MATCH (x:Nope) RETURN x"],
  ])) indexCase(label, fsCopy, fo, cypher, params ?? null);
  fsCopy.free();

  // toolArgs on a declared default: the same rules as a typed value, and a refusal names the default.
  a();
  a('toolArgs on an empty input with a declared default (a STRING read only through toInteger(), LIMIT toInteger($limit)):');
  for (const d of [10, '7', 'abc', '-3', 2.5]) {
    const t = { cypher: 'MATCH (a:Asset) RETURN a.name AS n LIMIT toInteger($limit)', parameters: [{ name: 'limit', type: 'STRING', default: d }] };
    const r = toolArgs(t, { limit: '' });
    a(`  default ${JSON.stringify(d)}: ${r.ok ? `sent ${JSON.stringify(r.params)}` : `refused: ${r.problems.map((x) => x.message).join(' ')}`}`);
    const want = typeof d === 'number' ? Number.isInteger(d) : /^\d+$/.test(d);
    if (r.ok !== want || (r.ok && typeof r.params.limit !== 'string') || (!r.ok && !r.problems[0].message.includes(`the default ${JSON.stringify(d)}`))) {
      fail(`toolArgs on the default ${JSON.stringify(d)} of a whole-number STRING: ${JSON.stringify(r)}`);
    }
  }

  prefillAudit(a, ccg);
  bookkeepingAudit(a, ccg);
}

/**
 * audit.txt: which parameter the graph tab's side panel fills with a clicked entity's name
 * (web/console.js prefillChoice, prefillPlan), for every tool as if an entity of the kind it sits on
 * were clicked. Fails when a prefilled parameter is a whole number read through toInteger(), a LIMIT
 * or SKIP count, or an id-like one that no name-like property of that kind is compared with.
 * @param {(s?: string) => void} a @param {Array<[string, any]>} ccg
 */
function prefillAudit(a, ccg) {
  a();
  a("the graph tab's prefill (web/console.js prefillChoice, prefillPlan): for every tool, as if an entity of the kind it sits");
  a("on were clicked, the parameter that gets the entity's name. 'property': the query compares it with a name-like property");
  a("of a variable of that kind (name, title, common_name, ...); 'name': else it is named like a name or a search; 'none':");
  a('else no parameter takes a name. Only a comparison that filters the rows counts for \'property\' (not one in an OPTIONAL');
  a('MATCH or a subquery), and any comparison with a property of another kind\'s variable rules out \'name\'. The side panel');
  a('runs a tool whose parameters all have a value (the name, a default, a value its description suggests, a first option),');
  a('as a tool about the kind when the name goes nowhere, and asks for the ones with no value otherwise.');
  /** @type {Record<string, number>} */
  const by = { 'no parameters': 0, property: 0, name: 0, none: 0 };
  /** @type {Map<string, number>} */
  const filled = new Map();
  /** @type {Map<string, number>} */
  const left = new Map();
  const runs = { none: 0, name: 0, kind: 0 };
  let asks = 0;
  const bad = [];
  const named = [];
  for (const [oid] of ccg) {
    for (const tool of ontologies.get(oid).tools.filter((t) => t.type === 'canonicalQuery' && t.cypher)) {
      const specs = toolParams(tool);
      const c = prefillChoice(tool);
      const plan = prefillPlan(tool, 'Some Name');
      if (!plan.run) asks++;
      else if (!specs.length) runs.none++;
      else if (plan.kindLevel) runs.kind++;
      else runs.name++;
      if (!specs.length) { by['no parameters']++; continue; }
      if (!c.param) {
        by.none++;
        for (const sp of specs) left.set(sp.name, (left.get(sp.name) ?? 0) + 1);
        continue;
      }
      by[/** @type {'property'|'name'} */ (c.rule)]++;
      filled.set(c.param, (filled.get(c.param) ?? 0) + 1);
      if (c.rule === 'name') named.push(`${oid} ${tool.name} $${c.param}`);
      const sp = specs.find((x) => x.name === c.param);
      if (!sp || sp.integer || sp.nonNegative || (c.rule !== 'property' && ID_LIKE.test(c.param))) bad.push(`${oid} ${tool.name} $${c.param}`);
    }
  }
  const total = Object.values(by).reduce((x, y) => x + y, 0);
  const list = (/** @type {Map<string, number>} */ m) => [...m].sort((x, y) => y[1] - x[1] || cmp(x[0], y[0])).map(([k, n]) => `${k} ${n}`).join(', ');
  a(`  ${total} tools: ${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  a(`  the side panel's button: runs at once for ${runs.none + runs.name + runs.kind} (${runs.none} without parameters, ${runs.name} with the name and the rest ` +
    `with a value, ${runs.kind} with every parameter at its start, as a tool about the kind), asks for the parameters that have no value for ${asks}`);
  a(`  prefilled, by parameter: ${list(filled)}`);
  a(`  by its name alone: ${named.join('; ') || 'none'}`);
  a(`  tools with none, by parameter: ${list(left)}`);
  const dt = ontologies.get('digital-twin').tools.find((t) => t.name === 'list_assets');
  const dtPlan = prefillPlan(dt, 'pump P-12');
  a(`  digital-twin list_assets on an Asset named "pump P-12" (only $limit, read through toInteger()): fills ${JSON.stringify(dtPlan.fill)}, ` +
    `${dtPlan.run ? `runs with ${JSON.stringify(dtPlan.values)}${dtPlan.kindLevel ? ', as a tool about the kind' : ''}` : `asks for ${dtPlan.missing.map((x) => `$${x}`).join(', ')}`}`);
  const fsTools = ontologies.get('financial-services').tools;
  for (const name of ['list_accounts', 'get_account_by_id']) {
    const plan = prefillPlan(fsTools.find((t) => t.name === name), 'ACC-2207', 'Account');
    a(`  financial-services ${name} on the Account "ACC-2207": ${plan.run ? `runs with ${JSON.stringify(plan.values)}${plan.kindLevel ? ', as a tool about the kind' : ''}` : `asks for ${plan.missing.map((x) => `$${x}`).join(', ')}`}`);
  }
  // Synthetic tools for the edges of the rules (none of the 220 has these shapes; function-wrapped equality none either).
  a('  synthetic tools, on a Person:');
  for (const [label, cypher, params, want] of /** @type {Array<[string, string, string[], string]>} */ ([
    ['function-wrapped equality on its name', 'MATCH (p:Person) WHERE toLower(p.name) = toLower($q) RETURN p', ['q'], 'q/property'],
    ['a regular expression built around the parameter', "MATCH (p:Person) WHERE p.name =~ '(?i).*' + $query + '.*' RETURN p", ['query'], 'query/name'],
    ['<> on another kind\'s name', 'MATCH (p:Person) MATCH (o:Organization) WHERE o.name <> $name RETURN p, o', ['name'], '-/-'],
    ['=~ with concatenation on another kind\'s name', "MATCH (p:Person) MATCH (o:Organization) WHERE o.name =~ '(?i).*' + $query + '.*' RETURN p", ['query'], '-/-'],
    ['an OPTIONAL MATCH on its own name', 'MATCH (p:Person) OPTIONAL MATCH (p)-[:WORKS_FOR]->(o:Organization) WHERE p.name CONTAINS $name RETURN p, o', ['name'], 'name/name'],
    ['an OPTIONAL MATCH on another kind\'s name', 'MATCH (p:Person) OPTIONAL MATCH (p)-[:WORKS_FOR]->(o:Organization) WHERE o.name CONTAINS $query RETURN p, o', ['query'], '-/-'],
    ['a subquery on another kind\'s name', 'MATCH (p:Person) WHERE EXISTS { MATCH (p)-[:WORKS_FOR]->(o:Organization) WHERE o.name = $name } RETURN p', ['name'], '-/-'],
    ['an unlabelled neighbour\'s name', 'MATCH (p:Person)-[]-(n) WHERE n.name < $name RETURN p', ['name'], '-/-'],
  ])) {
    const tool = { type: 'canonicalQuery', cypher, parameters: params.map((n) => ({ name: n, type: 'STRING' })), anchor: { kind: 'node', label: 'Person' } };
    const c = prefillChoice(tool);
    const got = `${c.param ?? '-'}/${c.rule ?? '-'}`;
    a(`    ${label}: ${got}${c.param ? ` (${c.why})` : ''}`);
    if (got !== want) fail(`prefillChoice on a synthetic tool (${label}): ${got}, not ${want}`);
  }
  a(`  a prefilled parameter that is a whole number, a LIMIT or SKIP count, or id-like with no name-like property: ${bad.length ? bad.join('; ') : 'none'}`);
  if (bad.length) fail(`the side panel would prefill ${bad.join('; ')}`);
  if (Object.keys(dtPlan.fill).length || !dtPlan.kindLevel) fail(`digital-twin list_assets: the side panel fills ${JSON.stringify(dtPlan.fill)} (kind level: ${dtPlan.kindLevel})`);
}

/**
 * audit.txt: the console's "Hide the example's bookkeeping" (web/console.js consoleResult), on copies of
 * sample stores, as the page computes it from a console worker's rows: which internal labels and types
 * are the extraction's records, which rows and values it leaves out, and the graph NVL draws (capped
 * after the filter). Fails when the classification does not cover ontology.js's internal labels and
 * types exactly, or when a pinned case comes out otherwise.
 * @param {(s?: string) => void} a @param {Array<[string, any]>} ccg
 */
function bookkeepingAudit(a, ccg) {
  a();
  a("## the console's bookkeeping filter (web/console.js consoleResult: \"Hide the example's bookkeeping\", off by default)");
  a('The extraction\'s own records are bookkeeping; the ontology layer and the published entities are content. A row is left');
  a('out when a top-level column is a bookkeeping node or relationship, or a path through one; inside lists and maps those');
  a('values are dropped and the row stays. NVL draws only what the shown rows hold, capped after the filter (1,000 nodes,');
  a('3,000 relationships). _IN and _OF are the ontology\'s between two ontology-layer nodes and bookkeeping otherwise; the');
  a('console worker sends the store\'s ontology node ids (ONTOLOGY_NODE_IDS) whenever the rows hold one.');
  a(`  bookkeeping labels: ${BOOKKEEPING_LABELS.join(', ')}`);
  a(`  content labels: ${[...ONTOLOGY_LABELS, ENTITY_LABEL].join(', ')} (and every ontology label)`);
  a(`  bookkeeping types: ${BOOKKEEPING_TYPES.join(', ')}; content: ${ONTOLOGY_TYPES.join(', ')} (and every ontology type); by their ends: ${SHARED_TYPES.join(', ')}`);
  const labels = [...BOOKKEEPING_LABELS, ...ONTOLOGY_LABELS, ENTITY_LABEL].sort(cmp);
  const types = [...BOOKKEEPING_TYPES, ...ONTOLOGY_TYPES, ...SHARED_TYPES].sort(cmp);
  const same = (x, y) => JSON.stringify(x) === JSON.stringify([...y].sort(cmp));
  a(`  ontology.js's internal labels (${INTERNAL_LABELS.length}) and types (${INTERNAL_TYPES.length}) each classified exactly once: ` +
    `${same(labels, INTERNAL_LABELS) && new Set(labels).size === labels.length ? 'yes' : 'NO'}, ${same(types, INTERNAL_TYPES) && new Set(types).size === types.length ? 'yes' : 'NO'}`);
  if (!same(labels, INTERNAL_LABELS) || !same(types, INTERNAL_TYPES)) fail('the console\'s bookkeeping classification does not cover ontology.js INTERNAL_LABELS/INTERNAL_TYPES exactly');
  /** @param {string} label @param {any} db @param {string} cypher @param {string} want  "shown/hidden/removed graph-nodes/graph-rels" with the filter on */
  const row = (label, db, cypher, want) => {
    const r = cl.exec(db, cypher);
    const ids = cl.exec(db, ONTOLOGY_NODE_IDS).rows.map((x) => x.id);
    const on = consoleResult(r.rows, { hide: true, ontologyIds: ids });
    const off = consoleResult(r.rows, { hide: false });
    const got = `${on.rows.length}/${on.hidden}/${on.removed} ${on.graph.nodes.length}/${on.graph.rels.length}`;
    a(`  ${label}: ${r.rows.length} rows; on: ${on.rows.length} shown, ${JSON.stringify(hiddenNote(on))}, NVL ${on.graph.nodes.length} nodes and ` +
      `${on.graph.rels.length} relationships${on.graph.capped ? ' (capped)' : ''}; off: NVL ${off.graph.nodes.length} and ${off.graph.rels.length}${off.graph.capped ? ' (capped)' : ''}`);
    if (want && got !== want) fail(`the bookkeeping filter on ${label}: ${got}, not ${want}`);
    return on;
  };
  const copy = (oid) => {
    const db = freshDb();
    replay.load(db, replay.parse(store.dumpStore(ccg.find(([id]) => id === oid)?.[1].db ?? stores.get(oid).db)));
    return db;
  };
  a('on a copy of the financial-services store:');
  const fs = copy('financial-services');
  const saved = (f) => readFileSync(join(EX, 'queries', f), 'utf8');
  const n = (q) => Number(cl.exec(fs, q).rows[0].n);
  const nEnt = n('MATCH (e:_Entity) RETURN count(e) AS n');
  const nMen = n('MATCH (m:_Mention)-[:_OF]->(:_Entity) RETURN count(m) AS n');
  const nRows05 = n('MATCH (l:_LinkType)-[x:_DOMAIN|_RANGE]->(k:_Kind) RETURN count(x) AS n');
  row('queries/05-ontology-graph.cypher', fs, saved('05-ontology-graph.cypher'), `${nRows05}/0/0 ${n('MATCH (l:_LinkType)-[:_DOMAIN|_RANGE]->(k:_Kind) UNWIND [l, k] AS x RETURN count(DISTINCT x) AS n')}/${nRows05}`);
  row('queries/01-typed-graph.cypher', fs, saved('01-typed-graph.cypher'), '');
  row('each kind -[:_IN]-> the ontology, the relationships alone', fs, 'MATCH ()-[r:_IN]->(:_Ontology) RETURN r', '');
  row('each sentence -[:_IN]-> its section, the relationships alone', fs, 'MATCH ()-[r:_IN]->(:_Section) RETURN r', '');
  row('mentions, their _OF and entities', fs, 'MATCH (m:_Mention)-[r:_OF]->(e:_Entity) RETURN m, r, e', `0/${nMen}/0 0/0`);
  row('paths through _OF', fs, 'MATCH p = (m:_Mention)-[:_OF]->(e:_Entity) RETURN p', `0/${nMen}/0 0/0`);
  row('each entity\'s key and collect() of its mentions', fs, 'MATCH (e:_Entity) OPTIONAL MATCH (m:_Mention)-[:_OF]->(e) RETURN e.key AS key, collect(m) AS mentions ORDER BY key',
    `${nEnt}/0/${nMen} 0/0`);
  row('a map of a mention and its entity', fs, 'MATCH (m:_Mention)-[:_OF]->(e:_Entity) RETURN {mention: m, entity: e} AS x', `${nMen}/0/${nMen} ${nEnt}/0`);
  row('the persons\' untyped neighbours (financial-services\' defaultView)', fs, 'MATCH (p:Person)-[r]-(n) RETURN p, r, n LIMIT 100', '');
  row('every node', fs, 'MATCH (n) RETURN n', '');
  fs.free();
  a('on a store of the generic document (harness/fixtures.mjs GENERIC_YAML, with a gazetteer), its ontology applied:');
  const cn = freshDb();
  store.openStore(cn, cl, genericOntology, {}, { model: WHICH });
  const nAl = Number(cl.exec(cn, 'MATCH (x:_Alias)-[r:_OF]->(:_Kind) RETURN count(r) AS n').rows[0].n);
  row('the gazetteer: _Alias -[:_OF]-> _Kind', cn, 'MATCH (x:_Alias)-[r:_OF]->(k:_Kind) RETURN x, r, k', `${nAl}/0/0 ${Number(cl.exec(cn, 'MATCH (x:_Alias)-[:_OF]->(k:_Kind) UNWIND [x, k] AS y RETURN count(DISTINCT y) AS n').rows[0].n)}/${nAl}`);
  row('the gazetteer\'s _OF relationships alone', cn, 'MATCH (:_Alias)-[r:_OF]->(:_Kind) RETURN r', `${nAl}/0/0 0/${nAl}`);
  cn.free();
  // The cap applies to what is drawn: 1,200 sentences before 300 entities in result order.
  a('the cap after the filter: 1,200 _Sentence nodes created before 300 (:_Entity:Person) nodes, MATCH (n) RETURN n:');
  const cap = freshDb();
  cl.exec(cap, "UNWIND range(1, 1200) AS i CREATE (:_Sentence {key: 's' + toString(i), text: 'x'})");
  cl.exec(cap, "UNWIND range(1, 300) AS i CREATE (:_Entity:Person {key: 'Person:P' + toString(i), kind: 'Person', name: 'P' + toString(i)})");
  const all = cl.exec(cap, 'MATCH (n) RETURN n').rows;
  for (const hide of [true, false]) {
    const v = consoleResult(all, { hide, ontologyIds: [] });
    const entities = v.graph.nodes.filter((x) => x.labels.includes('_Entity')).length;
    const n = (/** @type {number} */ x) => x.toLocaleString('en');
    a(`  ${hide ? 'on' : 'off'}: the table ${n(v.rows.length)} rows (${JSON.stringify(hiddenNote(v))}); NVL ${n(v.graph.nodes.length)} nodes, ${n(entities)} of them entities; ` +
      `status: ${JSON.stringify(capNote(v.graph))}`);
    if (hide && (v.rows.length !== 300 || v.graph.nodes.length !== 300 || entities !== 300 || v.graph.capped)) fail(`the console's cap with the filter on: ${v.rows.length} rows, ${v.graph.nodes.length} nodes`);
    if (!hide && (v.rows.length !== 1500 || v.graph.nodes.length !== 1000 || entities !== 0 || !v.graph.capped)) fail(`the console's cap with the filter off: ${v.rows.length} rows, ${v.graph.nodes.length} nodes`);
  }
  cap.free();
}

// ==== review.txt ====================================================================================
if (FULL) {
  const v = sayTo('review');
  const s = stores.get(FIXTURE_ONTOLOGY);
  const o = ontologies.get(FIXTURE_ONTOLOGY);
  const doc = ccgSamples.find((x) => x.ontology === FIXTURE_ONTOLOGY);
  const id = docId(doc.text);
  v('# Review: verdicts are graph state, latest wins (D10 rule 7; harness/run.mjs)');
  v(`On the ${FIXTURE_ONTOLOGY} store, its sample. A verdict names its target by key, so it outlives the`);
  v('target node; the gate takes the latest per target (ORDER BY ts DESC, seq DESC, then head(collect())).');
  const claimsOf = () => store.readGate(s.db, cl).claims.filter((c) => c.doc === id);
  const show = (c) => `${JSON.stringify(c.htext)} -[${c.rel}]-> ${JSON.stringify(c.ttext)} ${f3(c.p)}`;
  const edge = (c) => cl.exec(s.db, `MATCH (a:_Entity)-[r]->(b:_Entity) WHERE $k IS NOT NULL AND $k IN r.claims RETURN a.name AS a, type(r) AS rel, b.name AS b`, { k: c.key }).rows
    .map((r) => `(${r.a})-[:${r.rel}]->(${r.b})`).join(' ') || 'no typed edge';
  const state = (label, c) => {
    const now = claimsOf().find((x) => x.key === c.key);
    v(`  ${label}: ${now ? `${now.band} by ${now.rule}` : 'not banded'}; ${edge(c)}`);
  };
  const beforeV = claimsOf();
  const review = beforeV.filter((c) => c.band === 'review').sort((a, b) => b.p - a.p || cmp(a.key, b.key))[0];
  const kept = beforeV.filter((c) => c.band === 'keep').sort((a, b) => a.p - b.p || cmp(a.key, b.key))[0];
  v();
  v('## before: the gate at the defaults');
  v(`review item (the highest-scoring): ${show(review)}, ${review.band} by ${review.rule}`);
  v(`kept claim (the lowest-scoring):   ${show(kept)}, ${kept.band} by ${kept.rule}`);
  state('review item', review);
  state('kept claim', kept);

  v();
  v('## accept the review item, reject the kept claim; re-gate; re-publish');
  const v1 = store.addVerdict(s.db, cl, { target: review.key, value: 'accept' });
  const v2 = store.addVerdict(s.db, cl, { target: kept.key, value: 'reject' });
  v(`verdicts ${v1.key} (${v1.kind}, accept) and ${v2.key} (${v2.kind}, reject)`);
  store.gate(s.db, cl);
  let p = store.publish(s.db, cl);
  state('review item', review);
  state('kept claim', kept);
  v(`  published generation ${p.generation}: ${p.relationships} relationships`);

  v();
  v('## re-extract the document: its trace is deleted and extracted again (the cache answers)');
  const title = cl.exec(s.db, 'MATCH (d:_Document {id: $id}) WHERE $id IS NOT NULL RETURN d.title AS title', { id }).rows[0].title;
  const forgot = store.forgetDocument(s.db, cl, id);
  v(`forgetDocument: ${forgot.claims} claims, ${forgot.mentions} mentions, ${forgot.sentences} sentences, ${forgot.sections} sections, ${forgot.runs} runs deleted; verdicts left: ${store.listVerdicts(s.db, cl).length}`);
  const r = await pipeline.run({ db: s.db, cl, model, modelInfo: MODEL_INFO, ontology: o, text: doc.text, title });
  p = r.published;
  v(`extracted again: ${r.counters.inferences} inferences, ${r.counters.hits} cache hits; gated and published (generation ${p.generation})`);
  const onEdges = cl.exec(s.db, 'MATCH (x:_Verdict)-[:_ON]->(t) RETURN count(x) AS n').rows[0].n;
  v(`verdicts re-attached to the new nodes (ON edges): ${onEdges} of ${store.listVerdicts(s.db, cl).length}`);
  state('review item', review);
  state('kept claim', kept);

  v();
  v('## the latest verdict wins');
  const v3 = store.addVerdict(s.db, cl, { target: review.key, value: 'reject' });
  store.gate(s.db, cl);
  store.publish(s.db, cl);
  v(`${v3.key}: reject the item accepted by ${v1.key}`);
  state('review item', review);
  const v4 = store.addVerdict(s.db, cl, { target: review.key, value: 'accept' });
  store.gate(s.db, cl);
  store.publish(s.db, cl);
  v(`${v4.key}: accept it again`);
  state('review item', review);
  v(`verdicts on it, oldest first: ${store.listVerdicts(s.db, cl).filter((x) => x.target === review.key).map((x) => `${x.key} ${x.value}`).join(', ')}`);

  v();
  v('## a verdict on a mention: rejecting a kept name unanchors the claims that joined it (rule 3)');
  const mentions = store.readGate(s.db, cl).mentions.filter((m) => m.doc === id);
  const target = mentions.filter((m) => m.band === 'keep' && m.source === 'model').sort((a, b) => a.p - b.p || cmp(a.key, b.key))[0] ??
    mentions.filter((m) => m.band === 'keep').sort((a, b) => cmp(a.key, b.key))[0];
  const joined = () => cl.exec(s.db, `MATCH (c:_Claim)-[:_HEAD|_TAIL]->(m:_Mention {key: $k}) WHERE $k IS NOT NULL RETURN count(DISTINCT c) AS n`, { k: target.key }).rows[0].n;
  const unanchored = () => claimsOf().filter((c) => c.rule === 'unanchored').length;
  v(`mention ${JSON.stringify(target.text)} (${target.label}) ${f3(target.p)}, ${target.band} by ${target.rule}: ${joined()} claims join it; unanchored claims in the document: ${unanchored()}`);
  const v5 = store.addVerdict(s.db, cl, { target: target.key, value: 'reject' });
  store.gate(s.db, cl);
  p = store.publish(s.db, cl);
  const after = store.readGate(s.db, cl).mentions.find((m) => m.key === target.key);
  v(`${v5.key} (${v5.kind}, reject): the mention is ${after.band} by ${after.rule}; ${joined()} claims join it; unanchored claims: ${unanchored()}`);
  v(`  published generation ${p.generation}: ${p.entities} entities, ${p.relationships} relationships`);

  v();
  v('## the rule invariant holds with verdicts in the store');
  const diffs = compareGates(store.gate(s.db, cl), jsGate(s.db, FIXTURE_ONTOLOGY));
  v(diffs.length ? `${diffs.length} DIFFERENT` : 'the Cypher gate equals the JS gate: yes');
  for (const x of diffs) v(`  ${x}`);
  // Put the store back as the defaults leave it, for score.txt and graph.cypher.
  store.addVerdict(s.db, cl, { target: target.key, value: 'accept' });
  for (const k of [review.key, kept.key]) {
    const orig = beforeV.find((c) => c.key === k);
    store.addVerdict(s.db, cl, { target: k, value: orig.band === 'keep' ? 'accept' : 'reject' });
  }
  cl.exec(s.db, 'MATCH (x:_Verdict) DETACH DELETE x');
  store.gate(s.db, cl);
  store.publish(s.db, cl);

  // Rule 3's cap on a create-context-graph store: the highest-scoring claim decided by end-in-review.
  v();
  v("## rule 3's cap: a claim with an end in review waits in review; a verdict on that end, or on the claim, lifts it");
  let cap = null;
  for (const oid of ccgOids) {
    const rows = cl.exec(stores.get(oid).db, `MATCH (c:_Claim) WHERE c.rule = 'end-in-review'
MATCH (c)-[:_HEAD|_TAIL]->(m:_Mention) WHERE m.band = 'review'
RETURN c.key AS claim, m.key AS mention, c.p AS p ORDER BY p DESC, claim, mention LIMIT 1`).rows;
    if (rows.length) { cap = { oid, ...rows[0] }; break; }
  }
  if (!cap) {
    v('no claim is decided by end-in-review at the defaults on any create-context-graph store');
    fail('review.txt: no end-in-review claim to exercise rule 3\'s cap');
  } else {
    const cs = stores.get(cap.oid);
    const capAudits = readdirSync(QUERIES).filter((f) => /^audit-.*\.cypher$/.test(f)).sort();
    const now = () => {
      const g = store.readGate(cs.db, cl);
      return { c: g.claims.find((x) => x.key === cap.claim), m: g.mentions.find((x) => x.key === cap.mention) };
    };
    const edgeOf = () => cl.exec(cs.db, `MATCH (a:_Entity)-[r]->(b:_Entity) WHERE $k IS NOT NULL AND $k IN r.claims
RETURN a.name AS a, type(r) AS rel, b.name AS b, labels(a) AS la, labels(b) AS lb`, { k: cap.claim }).rows
      .map((r) => `(${r.a}:${r.la.filter((l) => l !== '_Entity').join(':')})-[:${r.rel}]->(${r.b}:${r.lb.filter((l) => l !== '_Entity').join(':')})`).join(' ') || 'no typed edge';
    const checkAll = (label) => {
      const diffs = compareGates(store.gate(cs.db, cl), jsGate(cs.db, cap.oid));
      store.publish(cs.db, cl);
      const bad = capAudits.filter((f) => cl.exec(cs.db, readFileSync(join(QUERIES, f), 'utf8')).rows.length);
      v(`  the Cypher gate equals the JS gate: ${diffs.length ? `NO (${diffs.length})` : 'yes'}; audits: ${bad.length ? `rows in ${bad.join(', ')}` : '0 rows each'}`);
      for (const x of diffs) v(`    ${x}`);
      if (diffs.length) fail(`review.txt (${label}): the Cypher gate differs from the JS gate on ${cap.oid}`);
      if (bad.length) fail(`review.txt (${label}): audits on ${cap.oid}: ${bad.join(', ')}`);
    };
    const state = () => {
      const { c, m } = now();
      v(`  claim ${JSON.stringify(c.htext)} -[${c.rel}]-> ${JSON.stringify(c.ttext)} ${f3(c.p)}: ${c.band} by ${c.rule}; ${edgeOf()}`);
      v(`  its end ${JSON.stringify(m.text)} (${m.label}) ${f3(m.p)}: ${m.band} by ${m.rule}`);
    };
    const clear = () => {
      cl.exec(cs.db, 'MATCH (x:_Verdict) DETACH DELETE x');
      store.gate(cs.db, cl);
      store.publish(cs.db, cl);
    };
    v(`On the ${cap.oid} store (create-context-graph): the highest-scoring claim decided by end-in-review, and its end in review.`);
    v('at the defaults:');
    state();
    v('accept the end (a mention verdict): the claim joins a kept mention and the band decides it:');
    store.addVerdict(cs.db, cl, { target: cap.mention, value: 'accept' });
    checkAll('mention accepted');
    state();
    clear();
    v('instead, accept the claim: the end in review it joined is kept with it (claim-verdict):');
    store.addVerdict(cs.db, cl, { target: cap.claim, value: 'accept' });
    checkAll('claim accepted');
    state();
    v("then reject the end: the mention's own verdict wins, the claim is unanchored (rule 3) and keeps nothing:");
    store.addVerdict(cs.db, cl, { target: cap.mention, value: 'reject' });
    checkAll('end rejected');
    state();
    clear();
    v('the verdicts deleted and the store re-gated: back to the defaults:');
    state();
  }

  // An accepted claim keeps only the mentions it joined, on the scripted store (gate.txt's last edge cases).
  v();
  v('## an accepted claim keeps the two mentions it joined, and nothing else (claim-verdict)');
  v(`On the scripted store (gate.txt). An accepted claim keeps its ends in review only when both anchor, the pair is legal and`);
  v('the ends are two entities; rejecting an end it joined unanchors it, and no other mention is kept in that end\'s place.');
  v('After each step: the rule invariant (every configuration), the audits, and the mentions kept by claim-verdict that no kept');
  v('claim joins (a published entity without its edge).');
  if (!scripted) fail('review.txt: the scripted store is missing (gate.txt makes it)');
  else {
    const sx = scripted;
    const sGate = () => store.readGate(sx.db, cl);
    const claimBy = (head, rel) => sGate().claims.find((c) => c.htext === head && c.rel === rel);
    const mentionBy = (text, label) => sGate().mentions.find((m) => m.text === text && m.label === label);
    const sAudits = readdirSync(QUERIES).filter((f) => /^audit-.*\.cypher$/.test(f)).sort();
    const step = (label) => {
      const diffs = [];
      for (const { opts } of INVARIANT_CONFIGS) diffs.push(...compareGates(store.gate(sx.db, cl, opts), jsGate(sx.db, sx.oid, opts)));
      store.gate(sx.db, cl);
      store.publish(sx.db, cl);
      const bad = sAudits.filter((f) => cl.exec(sx.db, readFileSync(join(QUERIES, f), 'utf8')).rows.length);
      const orphans = cl.exec(sx.db, `MATCH (m:_Mention) WHERE m.rule = 'claim-verdict'
AND NOT EXISTS { MATCH (c:_Claim)-[:_HEAD|_TAIL]->(m) WHERE c.band = 'keep' } RETURN count(m) AS n`).rows[0].n;
      v(`  the Cypher gate equals the JS gate: ${diffs.length ? `NO (${diffs.length})` : 'yes'}; audits: ${bad.length ? `rows in ${bad.join(', ')}` : '0 rows each'}; ` +
        `claim-verdict mentions no kept claim joins: ${orphans}`);
      for (const x of diffs) v(`    ${x}`);
      if (diffs.length) fail(`review.txt (${label}): the Cypher gate differs from the JS gate on the scripted store`);
      if (bad.length) fail(`review.txt (${label}): audits on the scripted store: ${bad.join(', ')}`);
      if (orphans) fail(`review.txt (${label}): ${orphans} mention(s) kept by claim-verdict with no kept claim`);
    };
    const claimState = (c0) => {
      const c = sGate().claims.find((x) => x.key === c0.key);
      const edge = cl.exec(sx.db, `MATCH (a:_Entity)-[r]->(b:_Entity) WHERE $k IS NOT NULL AND $k IN r.claims RETURN a.key AS a, type(r) AS rel, b.key AS b`, { k: c.key }).rows
        .map((r) => `(${r.a})-[:${r.rel}]->(${r.b})`).join(' ') || 'no typed edge';
      return `${JSON.stringify(c.htext)} -[${c.rel}]-> ${JSON.stringify(c.ttext)} ${f3(c.p)}: ${c.band} by ${c.rule}; ${edge}`;
    };
    const mentionState = (m0) => {
      const m = sGate().mentions.find((x) => x.key === m0.key);
      const ent = cl.exec(sx.db, 'MATCH (e:_Entity {key: $k}) WHERE $k IS NOT NULL RETURN count(e) AS n', { k: `${m.label}:${m.name}` }).rows[0].n;
      return `${JSON.stringify(m.text)} (${m.label}) ${f3(m.p)}: ${m.band} by ${m.rule}; entity ${m.label}:${m.name} ${ent ? 'published' : 'not published'}`;
    };
    const clearAll = () => {
      cl.exec(sx.db, 'MATCH (x:_Verdict) DETACH DELETE x');
      store.gate(sx.db, cl);
      store.publish(sx.db, cl);
    };
    // 1. Both ends in review; then one rejected (a review once found an orphan entity here).
    const uses = claimBy('Mira Holt', 'USES');
    const mira = mentionBy('Mira Holt', 'Patient');
    const pulse = mentionBy('Pulse Monitor', 'Device');
    v();
    v('both ends in review:');
    v(`  claim ${claimState(uses)}`);
    v(`  ends ${mentionState(mira)}; ${mentionState(pulse)}`);
    store.addVerdict(sx.db, cl, { target: uses.key, value: 'accept' });
    v('accept the claim: both ends are kept with it, and its edge is published:');
    step('accept, both ends in review');
    v(`  claim ${claimState(uses)}`);
    v(`  ends ${mentionState(mira)}; ${mentionState(pulse)}`);
    store.addVerdict(sx.db, cl, { target: mira.key, value: 'reject' });
    v('then reject its head: the claim is unanchored, and its tail goes back to review (no entity without the edge):');
    step('then reject the head');
    v(`  claim ${claimState(uses)}`);
    v(`  ends ${mentionState(mira)}; ${mentionState(pulse)}`);
    clearAll();
    // 2. The end inside two mentions in review; the joined one rejected (a review once found a rejection bypass here).
    const ida = claimBy('Ida Lund', 'USES');
    const small = mentionBy('Ida Lund', 'Patient');
    const large = mentionBy('Dr. Ida Lund', 'Patient');
    v();
    v('an end inside two mentions in review, "Ida Lund" (the smaller, which it joins) and "Dr. Ida Lund":');
    store.addVerdict(sx.db, cl, { target: ida.key, value: 'accept' });
    v('accept the claim: the mention it joined is kept with it:');
    step('accept, nested ends');
    v(`  claim ${claimState(ida)}`);
    v(`  ${mentionState(small)}; ${mentionState(large)}`);
    store.addVerdict(sx.db, cl, { target: small.key, value: 'reject' });
    v('then reject "Ida Lund": the claim is unanchored, and "Dr. Ida Lund" is not kept in its place:');
    step('then reject the joined end');
    v(`  claim ${claimState(ida)}`);
    v(`  ${mentionState(small)}; ${mentionState(large)}`);
    clearAll();
    // 3. Accepted claims rule 4 drops keep nothing.
    v();
    v('an accepted claim that rule 4 drops keeps neither end:');
    for (const [head, rel, endText, endLabel] of [['Kai Moss', 'WORKS_FOR', 'Kai Moss', 'Patient'], ['Eva Sund', 'REFERRED', 'Eva Sund', 'Patient']]) {
      const c = claimBy(head, rel);
      store.addVerdict(sx.db, cl, { target: c.key, value: 'accept' });
      v(`accept ${JSON.stringify(c.htext)} -[${rel}]-> ${JSON.stringify(c.ttext)}:`);
      step(`accept ${rel}`);
      v(`  claim ${claimState(c)}`);
      v(`  its end ${mentionState(mentionBy(endText, endLabel))}`);
    }
    clearAll();
    // 4. The hedge cap and rule 3's name join under verdicts.
    v();
    v('a hedged claim waits for a verdict like any claim in review; accepting it publishes its edge, rejecting it drops it:');
    const gus = claimBy('Gus Hale', 'VISITED');
    v(`  claim ${claimState(gus)}`);
    store.addVerdict(sx.db, cl, { target: gus.key, value: 'accept' });
    v('accept it:');
    step('accept the hedged claim');
    v(`  claim ${claimState(gus)}`);
    store.addVerdict(sx.db, cl, { target: gus.key, value: 'reject' });
    v('then reject it (the latest verdict wins):');
    step('reject the hedged claim');
    v(`  claim ${claimState(gus)}`);
    clearAll();
    v();
    const tod = claimBy('Tod Fry', 'TREATED_AT');
    const todTail = cl.exec(sx.db, 'MATCH (c:_Claim {key: $k})-[:_TAIL]->(m:_Mention) WHERE $k IS NOT NULL RETURN m.key AS key', { k: tod.key }).rows[0];
    v('a claim joined by name: rejecting the mention it joined unanchors it, as rejecting a containing mention does:');
    v(`  claim ${claimState(tod)}`);
    v(`  its tail ${mentionState(todTail)}`);
    store.addVerdict(sx.db, cl, { target: todTail.key, value: 'reject' });
    step('reject the name-joined end');
    v(`  claim ${claimState(tod)}`);
    v(`  its tail ${mentionState(todTail)}`);
    clearAll();
    // 5. Rule 2b: accepting the mention it sent to review keeps both kinds (two entities), and lifts its claim's cap.
    v();
    v('a name kept as two kinds (rule 2b): accepting the mention sent to review keeps both, as two entities:');
    const rae = mentionBy('Rae Holm', 'Person');
    const raeWorks = claimBy('Rae Holm', 'WORKS_FOR');
    v(`  ${mentionState(rae)}; ${mentionState(mentionBy('Rae Holm', 'Patient'))}`);
    v(`  claim ${claimState(raeWorks)}`);
    store.addVerdict(sx.db, cl, { target: rae.key, value: 'accept' });
    step('accept the other kind');
    v(`  ${mentionState(rae)}; ${mentionState(mentionBy('Rae Holm', 'Patient'))}`);
    v(`  claim ${claimState(raeWorks)}`);
    clearAll();
    sx.db.free();
    ontologies.delete(sx.oid);
    scripted = null;
  }
  note(`review done (${secs()})`);
}

// ==== score.txt =====================================================================================
{
  const sc = sayTo('score');
  sc(`# Scores against the samples' gold, in Cypher (store.scoreAgainstGold; harness/run.mjs, ${M.name})`);
  sc(`create-context-graph's samples (${ccgOids.length}): one synthetic document per domain, written for this example, each scored on its`);
  sc('domain\'s store against data/samples/ccg/<domain>.gold.json, which leaves out one hedged or negated claim per document on');
  sc('purpose (data/samples/ccg/distractors.json).');
  sc('As edgextract\'s eval: entities are (NAME, TYPE), relations (SOURCE, TARGET, TYPE), names canonical (names.js);');
  sc('micro-averaged over the documents. Predictions are the kept band; review and drop count as not predicted.');
  sc('A leading honorific is ignored as well, on both sides (store.withoutHonorific: Dr., Mr., Mrs., Ms., Prof., the first token');
  sc('of a canonical name): the text writes "Dr. Imani Okafor", the gold "Imani Okafor".');
  sc('Kinds and links are compared as written: create-context-graph\'s own labels (Person, Account) and types (WORKS_FOR).');
  sc(`The samples' gold holds only relations their domain's ontology can hold: ${goldLegality.n - goldLegality.illegal.length} of ` +
    `${goldLegality.n} legal for their (source kind, target kind) pair${goldLegality.illegal.length ? ` (ILLEGAL: ${goldLegality.illegal.join('; ')})` : ''}.`);
  for (const oid of ccgOids) store.loadGold(stores.get(oid).db, cl, ccgGoldFor(oid));
  const fmt = (x) => `P ${f3(x.precision)} R ${f3(x.recall)} F1 ${f3(x.f1)} (tp ${x.tp}, fp ${x.fp}, fn ${x.fn})`;
  /** Micro-average stores' totals. */
  const total = (scores, what) => {
    const tp = scores.reduce((s, x) => s + x[what].total.tp, 0);
    const fp = scores.reduce((s, x) => s + x[what].total.fp, 0);
    const fn = scores.reduce((s, x) => s + x[what].total.fn, 0);
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    return { tp, fp, fn, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
  };
  /** The gold set: its stores and how names are matched. */
  const SETS = {
    ccg: { oids: ccgOids, names: 'honorific', docs: (oid) => ccgGoldFor(oid).map((g) => g.doc), D: DEF },
  };
  const scoreSet = (set, opts = {}) => set.oids.map((oid) => store.scoreAgainstGold(stores.get(oid).db, cl, undefined, { ...opts, names: set.names }));
  const totals = (set, opts = {}) => {
    const s = scoreSet(set, opts);
    return { entities: total(s, 'entities'), relations: total(s, 'relations') };
  };
  const regate = (set, opts = {}) => { for (const oid of set.oids) store.gate(stores.get(oid).db, cl, opts); };
  const setAll = (set, c, src = 'user') => { for (const oid of set.oids) store.setAllCutoffs(stores.get(oid).db, cl, c, { src }); };
  /** Every cutoff of the set's stores back to the defaults, following them again. */
  const resetCutoffs = (set) => setAll(set, set.D, 'default');
  const restore = (set) => { resetCutoffs(set); regate(set); };
  /** How many mentions or claims of the set's gold documents have this band or rule. */
  const inGold = (set, label, what) => set.oids.reduce((acc, oid) => acc + cl.exec(stores.get(oid).db,
    `MATCH (x:${label}) WHERE (x.band = $what OR x.rule = $what) AND x.doc IN $docs RETURN count(x) AS n`, { what, docs: set.docs(oid) }).rows[0].n, 0);

  // ---- create-context-graph's samples ----
  regate(SETS.ccg);
  const ccgGate = scoreSet(SETS.ccg);
  const ccgGraph = scoreSet(SETS.ccg, { from: 'graph' });
  sc();
  sc(`## create-context-graph's samples (${ccgOids.length} domains), at the default cutoffs (${cutsLine(DEF)})`);
  for (const what of ['entities', 'relations']) {
    sc(`${what}: ${fmt(total(ccgGate, what))}`);
    const g2 = total(ccgGraph, what);
    const same = JSON.stringify(total(ccgGate, what)) === JSON.stringify(g2);
    sc(`  scored from the published typed graph instead of the gate: ${same ? 'the same' : `DIFFERENT: ${fmt(g2)}`}`);
    if (!same) fail(`create-context-graph: score from the graph differs from the gate's (${what})`);
  }
  const plain = ccgOids.map((oid) => store.scoreAgainstGold(stores.get(oid).db, cl, undefined, { names: 'canonical' }));
  sc(`without the honorific rule (names canonical only): entities ${fmt(total(plain, 'entities'))}; relations ${fmt(total(plain, 'relations'))}`);
  // The demos' floor: at small-v1's defaults the samples' kept relations keep precision 0.90 or more and
  // recall 0.50 or more, and the page's default sample publishes at least 10 entities and 8 relationships, none of
  // them outside its gold. A rewrite of the samples or a change of the defaults that drops below it fails the run.
  if (FULL) {
    const DEMO = 'financial-services'; // web/app.js DEFAULT_SAMPLE
    const rel = total(ccgGate, 'relations');
    const fsAt = ccgOids.indexOf(DEMO);
    const fsE = ccgGate[fsAt].entities.total;
    const fsR = ccgGate[fsAt].relations.total;
    sc(`the demos' floor: relations P ${f3(rel.precision)} (at least 0.900) and R ${f3(rel.recall)} (at least 0.500); ${DEMO}, ` +
      `the page's default sample, keeps ${fsE.tp + fsE.fp} entities (at least 10) and ${fsR.tp + fsR.fp} relationships (at least 8), ` +
      `${fsE.fp + fsR.fp} of them outside its gold (0)`);
    if (rel.precision < 0.9 || rel.recall < 0.5) fail(`the samples' relations at the defaults: P ${f3(rel.precision)}, R ${f3(rel.recall)} (the floor is 0.900 and 0.500)`);
    if (fsE.tp + fsE.fp < 10 || fsR.tp + fsR.fp < 8 || fsE.fp + fsR.fp > 0) fail(`${DEMO}'s sample at the defaults: ${fsE.tp + fsE.fp} entities, ${fsR.tp + fsR.fp} relationships, ${fsE.fp + fsR.fp} outside its gold`);
  }
  sc();
  sc('## per domain (entities; relations)');
  sc(`${'domain'.padEnd(21)} ${'entities'.padEnd(46)} relations`);
  ccgOids.forEach((oid, i) => sc(`${oid.padEnd(21)} ${fmt(ccgGate[i].entities.total).padEnd(46)} ${fmt(ccgGate[i].relations.total)}`));
  sc();
  sc('## per domain: what was missed and what was kept wrongly (names as matched: canonical, no honorific)');
  ccgOids.forEach((oid, i) => {
    const e = ccgGate[i].entities.docs[0];
    const r = ccgGate[i].relations.docs[0];
    sc(`${oid}:`);
    if (e.false_pos.length) sc(`  entities false: ${e.false_pos.join('; ')}`);
    if (e.missed.length) sc(`  entities missed: ${e.missed.join('; ')}`);
    if (r.false_pos.length) sc(`  relations false: ${r.false_pos.join('; ')}`);
    if (r.missed.length) sc(`  relations missed: ${r.missed.join('; ')}`);
  });

  sc();
  sc('## each rule switched off in turn, on the create-context-graph samples');
  sc(`${'rule off'.padEnd(12)} ${'entities'.padEnd(52)} relations`);
  for (const r of ['none', ...store.RULES]) {
    regate(SETS.ccg, { off: r === 'none' ? [] : [r] });
    const s = totals(SETS.ccg);
    sc(`${r.padEnd(12)} ${fmt(s.entities).padEnd(52)} ${fmt(s.relations)}`);
  }
  regate(SETS.ccg);
  sc('(no gazetteer in create-context-graph\'s format and no verdicts here, so rules 1 and 7 change nothing; gate.txt and review.txt');
  sc('exercise them)');

  // The distractors, and where the relations are lost: at the defaults.
  /** Every claim of a store with its band, joined ends (and their mentions' bands) and span texts. */
  const allClaims = (oid) => cl.exec(stores.get(oid).db, `MATCH (c:_Claim)
OPTIONAL MATCH (c)-[:_HEAD]->(h:_Mention)
OPTIONAL MATCH (c)-[:_TAIL]->(t:_Mention)
RETURN c.rel AS rel, c.hn AS hn, c.tn AS tn, c.htext AS htext, c.ttext AS ttext,
       c.p AS p, c.band AS band, c.rule AS rule, c.key AS key, h.band AS hb, t.band AS tb ORDER BY c.p DESC, c.key`).rows;
  const joinedTo = (c, src, tgt) => c.hn != null && c.tn != null && store.withoutHonorific(c.hn) === src && store.withoutHonorific(c.tn) === tgt;
  const textTo = (c, src, tgt, key) => key(c.htext) === src && key(c.ttext) === tgt;
  /**
   * A domain's distractor, found in its own sentence: the one sentence of the sample that names both
   * ends (case-insensitive) and hedges or negates (HEDGE); a sentence elsewhere that states the same
   * pair plainly is not the distractor (education's s4: "Tomas Ferreira passed it last spring" is
   * true). Its claims are those of the distractor's link in that sentence whose head and tail span
   * texts each contain the end's name or are contained in it ("ALM-4402" for "alert ALM-4402",
   * "Dr. Samuel Whitcombe" for "Samuel Whitcombe"). The one reported: kept first, then review, then
   * the highest score. Exactly one such sentence per domain, or the run fails.
   */
  const HEDGE = /\b(?:not|no|never|unclear|may|might|probably|suspected)\b/i;
  const low = (x) => String(x ?? '').trim().toLowerCase();
  const contains = (span, name) => low(span) !== '' && (low(span).includes(low(name)) || low(name).includes(low(span)));
  const distractorSentence = new Map(ccgOids.map((oid) => {
    const x = distractors[oid];
    const sample = ccgSamples.find((d) => d.ontology === oid);
    const hits = splitSentences(sample.text).filter((t) => low(t.text).includes(low(x.source)) && low(t.text).includes(low(x.target)) && HEDGE.test(t.text));
    if (hits.length !== 1) fail(`data/samples/ccg/distractors.json: ${oid}: ${hits.length} hedged or negated sentences name both ${JSON.stringify(x.source)} and ${JSON.stringify(x.target)} (want 1)`);
    return [oid, hits.length ? { key: `${docId(sample.text)}#${hits[0].idx}`, idx: hits[0].idx, text: hits[0].text } : null];
  }));
  const BAND_RANK = { keep: 0, review: 1, drop: 2 };
  const distractorClaim = (oid, which = stores) => {
    const x = distractors[oid];
    const sent = distractorSentence.get(oid);
    if (!sent) return null;
    const cs = cl.exec(which.get(oid).db, `MATCH (c:_Claim)-[:_EVIDENCE]->(s:_Sentence {key: $key}) WHERE $key IS NOT NULL AND $rel IS NOT NULL AND c.rel = $rel
RETURN c.key AS key, c.htext AS htext, c.ttext AS ttext, c.p AS p, c.band AS band, c.rule AS rule`, { key: sent.key, rel: x.type }).rows
      .filter((c) => contains(c.htext, x.source) && contains(c.ttext, x.target))
      .sort((a, b) => (BAND_RANK[a.band] ?? 3) - (BAND_RANK[b.band] ?? 3) || b.p - a.p || cmp(a.key, b.key));
    return cs[0] ?? null;
  };
  const keptDistractors = (which = stores) => ccgOids.filter((oid) => distractorClaim(oid, which)?.band === 'keep').length;
  /** The kinds' poles of a create-context-graph store, from its parsed YAML: id -> {pole, base}. */
  const polesOf = (oid) => new Map(ontologies.get(oid).types.map((k) => [k.id, { pole: k.pole, base: k.origin === 'base' }]));
  const BAND_RULES = ['band', 'pole-specific'];
  const OUTCOMES = ['kept', 'review by the band', 'review by the type margin', 'another kind won its span', 'drop by the band'];
  /** Each gold entity's best outcome: the model's mentions of it with its gold kind (canonical name, no honorific). */
  const entityOutcomes = () => {
    const out = [];
    for (const oid of ccgOids) {
      const sample = ccgSamples.find((x) => x.ontology === oid);
      const ms = cl.exec(stores.get(oid).db, "MATCH (m:_Mention) WHERE m.source = 'model' RETURN m.sentence AS sentence, m.start AS start, m.end AS end, m.name AS name, m.label AS label, m.band AS band, m.rule AS rule, m.p AS p").rows;
      const gk = goldKeys(ontologies.get(oid), sample.gold);
      for (const g of sample.gold.entities) {
        const name = gk.key(g.name, g.type);
        const named = ms.filter((m) => store.withoutHonorific(m.name) === name);
        const mine = named.filter((m) => m.label === g.type);
        const rank = (m) => (m.band === 'keep' ? 0 : m.band === 'review' && BAND_RULES.includes(m.rule) ? 1 : m.band === 'review' && m.rule === 'type-margin' ? 2 :
          m.rule === 'one-kind' ? 3 : BAND_RULES.includes(m.rule) ? 4 : 5);
        const best = Math.min(5, ...mine.map(rank));
        const why = best < 5 ? OUTCOMES[best] : named.length ? 'found only as another kind' : 'not found';
        const chosen = best <= 1 && mine.some((m) => rank(m) === best && m.rule === 'pole-specific');
        // the kind that won: the mention of the same span that rule 2 did not drop
        const lost = best === 3 ? mine.find((m) => rank(m) === 3) : null;
        const winner = lost ? ms.find((x) => x.sentence === lost.sentence && x.start === lost.start && x.end === lost.end && x.rule !== 'one-kind') ?? null : null;
        out.push({ oid, g, why, chosen, winner });
      }
    }
    return out;
  };
  sc();
  sc('## the distractors: one hedged or negated claim per document, left out of the gold on purpose');
  sc(`Each must not be kept at the defaults (relation keep ${f3(DEF.relKeep)}). Each is looked for in its own sentence (the one that names both ends and hedges`);
  sc('or negates): a claim of its link there whose span texts contain the two names or are contained in them, kept first, then');
  sc('review, then the highest score. Shown: the sentence, then the claim\'s score, band and deciding rule, or "no claim".');
  const distractorClaims = [];
  for (const oid of ccgOids) {
    const x = distractors[oid];
    const sent = distractorSentence.get(oid);
    const best = distractorClaim(oid);
    if (best) distractorClaims.push({ oid, p: best.p, band: best.band, rule: best.rule });
    const kept = best?.band === 'keep';
    sc(`${oid}: ${JSON.stringify(x.source)} -[${x.type}]-> ${JSON.stringify(x.target)}, s${sent?.idx ?? '?'}: ` +
      `${best ? `claim ${f3(best.p)}, ${best.band} by ${best.rule}${kept ? ' (KEPT: a distractor the gate publishes)' : ''}` : 'no claim'}`);
    sc(`  ${JSON.stringify(sent?.text ?? '')}`);
  }
  const nKeptDistractors = keptDistractors();
  const dps = distractorClaims.map((x) => x.p);
  sc(`=> kept at the defaults: ${nKeptDistractors} of ${ccgOids.length}; a claim in the distractor's sentence: ${distractorClaims.length}, ` +
    `scoring ${dps.length ? `${f3(Math.min(...dps))} to ${f3(Math.max(...dps))}` : '-'}; ${dps.filter((p) => p >= 0.55).length} at 0.55 or more, ` +
    `${dps.filter((p) => p >= DEF.relKeep).length} at the relation keep ${f3(DEF.relKeep)} or more`);
  sc(`   decided by: ${countBy(distractorClaims, (x) => `${x.band} by ${x.rule}`) || 'none'}`);
  const atKeep = distractorClaims.filter((x) => x.p >= DEF.relKeep);
  sc(`   of those at the keep cutoff or more (the band alone would keep them): ${atKeep.length ? countBy(atKeep, (x) => `${x.band} by ${x.rule}`) : 'none'}`);
  if (nKeptDistractors) note(`finding: ${nKeptDistractors} distractor claim(s) kept at the defaults (score.txt)`);

  // ---- the held-out set, beside the samples ----
  sc();
  sc(`## the held-out set (data/samples/heldout: ${heldout.length} documents), at the default cutoffs (${cutsLine(DEF)})`);
  sc('Written like the samples, never listed in the page and never used to set a default or a rule (the defaults and the gate');
  sc('were settled on the samples alone). Each document on a fresh store of its domain, extracted, gated and published as the page');
  sc('does, and scored as the samples are; its distractor (data/samples/heldout/distractors.json) is looked for as theirs are.');
  const held = [];
  for (const d of heldout) {
    const hs = newStore(d.ontology);
    await pipeline.run({ db: hs.db, cl, model, modelInfo: MODEL_INFO, ontology: ontologies.get(d.ontology), text: d.text, title: d.name });
    const id = docId(d.text);
    const hg = goldKeys(ontologies.get(d.ontology), d.gold);
    store.loadGold(hs.db, cl, [{ doc: id, title: d.name, entities: hg.entities, relations: hg.relations }]);
    const s = store.scoreAgainstGold(hs.db, cl, undefined, { names: 'honorific' });
    const x = heldDistractors[d.ontology];
    const hits = splitSentences(d.text).filter((t) => low(t.text).includes(low(x.source)) && low(t.text).includes(low(x.target)) && HEDGE.test(t.text));
    if (hits.length !== 1) fail(`data/samples/heldout/distractors.json: ${d.ontology}: ${hits.length} hedged or negated sentences name both ${JSON.stringify(x.source)} and ${JSON.stringify(x.target)} (want 1)`);
    const best = hits.length !== 1 ? null : cl.exec(hs.db, `MATCH (c:_Claim)-[:_EVIDENCE]->(t:_Sentence {key: $key}) WHERE $key IS NOT NULL AND $rel IS NOT NULL AND c.rel = $rel
RETURN c.key AS key, c.htext AS htext, c.ttext AS ttext, c.p AS p, c.band AS band, c.rule AS rule`, { key: `${id}#${hits[0].idx}`, rel: x.type }).rows
      .filter((c) => contains(c.htext, x.source) && contains(c.ttext, x.target))
      .sort((a, b) => (BAND_RANK[a.band] ?? 3) - (BAND_RANK[b.band] ?? 3) || b.p - a.p || cmp(a.key, b.key))[0] ?? null;
    const review = cl.exec(hs.db, "MATCH (x) WHERE (x:_Mention OR x:_Claim) AND x.band = 'review' RETURN count(x) AS n").rows[0].n;
    held.push({ d, s, best, review });
    hs.db.free();
  }
  for (const what of ['entities', 'relations']) sc(`${what}: ${fmt(total(held.map((h) => h.s), what))}`);
  const heldKept = held.filter((h) => h.best?.band === 'keep');
  sc(`distractors kept: ${heldKept.length} of ${held.length}${heldKept.length ? ` (${heldKept.map((h) => h.d.ontology).join(', ')})` : ''}; ` +
    `review items per document: ${held.map((h) => h.review).join(', ')}`);
  for (const h of held) {
    const rk = h.s.relations.total;
    sc(`${h.d.ontology.padEnd(21)} entities ${fmt(h.s.entities.total)}`);
    sc(`${''.padEnd(21)} relations ${fmt(rk)}; distractor ${JSON.stringify(heldDistractors[h.d.ontology].source)} -[${heldDistractors[h.d.ontology].type}]-> ` +
      `${JSON.stringify(heldDistractors[h.d.ontology].target)}: ${h.best ? `claim ${f3(h.best.p)}, ${h.best.band} by ${h.best.rule}` : 'no claim'}`);
  }
  note(`held-out set scored (${secs()})`);

  sc();
  sc('## where the create-context-graph relations are lost (at the defaults)');
  sc('For each gold relation, the best claim of its link whose span texts name its two ends (canonical, no honorific):');
  sc('kept; in review by the band; in review because an end is in review (rule 3\'s cap: end-in-review); dropped by the');
  sc('band; dropped as unanchored (an end joins no kept mention and none in review: rule 3); dropped as illegal (an end joins');
  sc('a mention of another kind: rule 4); or no such claim (the model did not pair them in one sentence).');
  const reasons = new Map();
  const byLink = new Map();
  let illegalOnReview = 0;
  let illegal = 0;
  for (const oid of ccgOids) {
    const sample = ccgSamples.find((s) => s.ontology === oid);
    const cs = allClaims(oid);
    const gk = goldKeys(ontologies.get(oid), sample.gold);
    for (const g of sample.gold.relations) {
      const src = gk.key(g.source, gk.kindOf.get(g.source));
      const tgt = gk.key(g.target, gk.kindOf.get(g.target));
      const mine = cs.filter((c) => c.rel === g.type && (joinedTo(c, src, tgt) || textTo(c, src, tgt, (t) => entityName(t))));
      const best = mine.find((c) => c.band === 'keep') ?? mine.find((c) => c.band === 'review') ?? mine.find((c) => c.rule === 'band') ?? mine[0] ?? null;
      const why = !best ? 'no claim' : best.band === 'keep' ? 'kept' : best.rule === 'band' ? `${best.band} by the band` :
        best.rule === 'end-in-review' ? 'review: an end in review' : `${best.band === 'review' ? 'review' : 'dropped'} as ${best.rule}`;
      reasons.set(why, (reasons.get(why) ?? 0) + 1);
      if (best?.rule === 'illegal') {
        illegal++;
        if (best.hb === 'review' || best.tb === 'review') illegalOnReview++;
      }
      const l = byLink.get(g.type) ?? { n: 0, kept: 0 };
      l.n++;
      if (why === 'kept') l.kept++;
      byLink.set(g.type, l);
    }
  }
  const nGold = [...reasons.values()].reduce((a, b) => a + b, 0);
  sc(`${nGold} gold relations: ${[...reasons].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  sc(`of those dropped as illegal, an end joined a mention in review for ${illegalOnReview} of ${illegal} (rule 3 anchors on review, rule 4 then checks its kind)`);
  sc(`kept, by link (links with a gold relation kept): ${[...byLink].filter(([, l]) => l.kept).sort((a, b) => b[1].kept - a[1].kept || cmp(a[0], b[0])).map(([k, l]) => `${k} ${l.kept} of ${l.n}`).join(', ')}`);
  sc(`links with gold relations and none kept: ${[...byLink].filter(([, l]) => !l.kept).length} of ${byLink.size}`);
  sc();
  sc('## where the create-context-graph entities are lost (at the defaults)');
  sc('For each gold entity, the best outcome of the model\'s mentions of it with its gold kind (canonical name, no honorific):');
  sc('kept; in review by the band or by the type margin (rule 2); dropped because another kind won the same span (rule 2,');
  sc('one-kind); dropped by the band; found only under another kind; or not found at all. A kind rule 2\'s POLE preference');
  sc('chose (pole-specific) counts by its band.');
  const eo = entityOutcomes();
  const eReasons = new Map();
  for (const x of eo) eReasons.set(x.why, (eReasons.get(x.why) ?? 0) + 1);
  sc(`${eo.length} gold entities: ${[...eReasons].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const chosen = eo.filter((x) => x.chosen);
  sc(`kept or in review with the kind the POLE preference chose: ${chosen.length} (kept ${chosen.filter((x) => x.why === 'kept').length}): ` +
    `${countBy(chosen, (x) => x.g.type) || 'none'}`);
  const won = eo.filter((x) => x.why === 'another kind won its span');
  const winners = new Map();
  let samePole = 0;
  for (const x of won) {
    const k = `${x.g.type} lost to ${x.winner?.label ?? '?'}`;
    winners.set(k, (winners.get(k) ?? 0) + 1);
    const poles = polesOf(x.oid);
    if (x.winner && poles.get(x.g.type)?.pole === poles.get(x.winner.label)?.pole) samePole++;
  }
  const baseKinds = new Set(['Person', 'Organization', 'Location', 'Event', 'Object']);
  const toBase = [...winners].filter(([k]) => baseKinds.has(k.split(' lost to ')[1])).reduce((a, [, v]) => a + v, 0);
  sc(`of those another kind won, the winner is one of the base's five kinds (Person, Organization, Location, Event, Object) for ${toBase};`);
  sc(`  the winner has the lost kind's pole for ${samePole} (the POLE preference needs it within the pole margin and above the drop cutoff),`);
  sc(`  another pole for ${won.length - samePole} (create-context-graph types Player, Agent, Guest, Customer, Researcher and more as OBJECT);`);
  sc(`  the most frequent: ${[...winners].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  note(`create-context-graph scores done (${secs()})`);

  if (!FULL) {
    // --model base (printed, not diffed): this model's defaults (store.MODEL_GATES) against small-v1's.
    sc();
    sc(`## ${M.name}'s defaults (store.MODEL_GATES) against small-v1's`);
    const small = { ccg: store.defaultGate('create-context-graph', 'small') };
    const keptWhere = () => ccgOids.filter((oid) => distractorClaim(oid)?.band === 'keep');
    for (const [label, c] of [["small-v1's", small.ccg], [`${M.name}'s`, SETS.ccg.D]]) {
      setAll(SETS.ccg, c);
      regate(SETS.ccg);
      const x = totals(SETS.ccg);
      const kw = keptWhere();
      sc(`the samples at ${label} defaults (${cutsLine(c)}): entities ${fmt(x.entities)}; relations ${fmt(x.relations)}; ` +
        `distractors kept ${kw.length}${kw.length ? ` (${kw.map((oid) => `${oid} ${distractors[oid].type} ${f3(distractorClaim(oid).p)}`).join(', ')})` : ''}`);
    }
    sc('distractors kept on the samples by entity keep (rows) and relation keep (columns), 0.40 to 0.95:');
    const GRID = Array.from({ length: 12 }, (_, i) => Math.round((0.4 + 0.05 * i) * 100) / 100);
    sc(`${'keep'.padEnd(6)} ${GRID.map((k) => k.toFixed(2).padEnd(5)).join(' ').trimEnd()}`);
    let zero = 0;
    for (const e of GRID) {
      sc(`${e.toFixed(2).padEnd(6)} ${GRID.map((k) => {
        setAll(SETS.ccg, { entKeep: e, entDrop: Math.min(SETS.ccg.D.entDrop, e), relKeep: k, relDrop: Math.min(SETS.ccg.D.relDrop, k) });
        regate(SETS.ccg);
        const n = keptDistractors();
        if (n === 0) zero++;
        return String(n).padEnd(5);
      }).join(' ').trimEnd()}`);
    }
    sc(`cutoff pairs that keep no distractor: ${zero} of ${GRID.length * GRID.length}`);
    restore(SETS.ccg);
    note(`--model base comparison done (${secs()})`);
  }

  if (FULL) {
    sc();
    sc('## settling the defaults, on the samples');
    sc('Grids over the samples\' gold; values on a 0.05 grid, chosen for a good F1 without chasing the last point. Each grid moves one');
    sc('setting with the others at the defaults (store.defaultGate, the same for every ontology); cutoffs move for every kind or');
    sc('link at once. (Earlier builds also set the defaults of edgextract\'s format on edgextract\'s golden set: 0.85/0.70.)');
    const fmt2 = (x) => `${f3(x.precision)}/${f3(x.recall)}/${f3(x.f1)} (${x.tp}/${x.fp}/${x.fn})`;

    // 0. how create-context-graph's kinds and links are asked (experiment B), on the samples, on the real gate
    sc();
    sc("### how create-context-graph's kinds and links are put to the model (experiment B), on the samples");
    sc('"ids": every kind by its label with the description ontology.js derives ("financial account (object)"), every link as');
    sc('its phrase ("owns"): what this example asked before. "labels": what it asks now (pipeline.modelSchema): each kind\'s label');
    sc('as text ("account"), "<subtype> in <domain>" for a domain kind ("financial account in financial services"), the base');
    sc('kinds bare, a base kind no link names and a domain kind covers not asked (Object in all 27, Event in agent-memory and');
    sc('vacation-industry), and each link between its endpoints ("person owns account"); a generic document is asked the same');
    sc('way. Both on a fresh store per domain, gated by the Cypher gate; P/R/F1 (tp/fp/fn), the distractors kept, and the review');
    sc('queue (mentions, claims).');
    const idsStores = new Map(ccgOids.map((oid) => [oid, newStore(oid)]));
    for (const d of ccgSamples) {
      const x = idsStores.get(d.ontology);
      await pipeline.run({ db: x.db, cl, model, modelInfo: MODEL_INFO, ontology: ontologies.get(d.ontology), text: d.text, title: d.name, asked: 'ids' });
      store.loadGold(x.db, cl, ccgGoldFor(d.ontology));
    }
    /** The samples at keep cutoffs (ek, rk) on one set of stores: scores, per-document totals, distractors kept, review queue. */
    const ccgAt = (which, ek, rk) => {
      for (const oid of ccgOids) {
        const db = which.get(oid).db;
        store.setAllCutoffs(db, cl, { entKeep: ek, entDrop: Math.min(DEF.entDrop, ek), relKeep: rk, relDrop: Math.min(DEF.relDrop, rk) });
        store.gate(db, cl);
      }
      const per = ccgOids.map((oid) => store.scoreAgainstGold(which.get(oid).db, cl, undefined, { names: 'honorific' }));
      const queue = (label) => ccgOids.reduce((acc, oid) => acc + cl.exec(which.get(oid).db, `MATCH (x:${label}) WHERE x.band = 'review' RETURN count(x) AS n`).rows[0].n, 0);
      return {
        e: total(per, 'entities'), r: total(per, 'relations'), docs: per.map((x) => ({ entities: x.entities.total, relations: x.relations.total })),
        kept: keptDistractors(which), revM: queue('_Mention'), revC: queue('_Claim'),
      };
    };
    const PREV = { ek: 0.85, rk: 0.7 };
    const NOW = { ek: DEF.entKeep, rk: DEF.relKeep };
    /** The previous defaults (0.75/0.60), on the same samples. */
    const PREV_Q = { ek: 0.75, rk: 0.6 };
    const cmpRows = [
      ['ids', idsStores, PREV], ['ids', idsStores, NOW], ['labels', stores, PREV], ['labels', stores, NOW], ['labels', stores, PREV_Q],
    ].map(([what, which, c]) => ({ what, c, ...ccgAt(which, c.ek, c.rk) }));
    sc(`${'asked'.padEnd(7)} ${'keep'.padEnd(10)} ${'entities'.padEnd(32)} ${'relations'.padEnd(29)} ${'distractors kept'.padEnd(17)} review m, c`);
    for (const x of cmpRows) {
      sc(`${x.what.padEnd(7)} ${`${x.c.ek.toFixed(2)}/${x.c.rk.toFixed(2)}`.padEnd(10)} ${fmt2(x.e).padEnd(32)} ${fmt2(x.r).padEnd(29)} ${String(x.kept).padEnd(17)} ${x.revM}, ${x.revC}`);
    }
    if (cmpRows[3].kept) fail(`the create-context-graph defaults keep ${cmpRows[3].kept} distractor(s)`);
    /**
     * A paired bootstrap over the samples' documents (one per domain) of the difference B - A in micro
     * F1: 2,000 resamples with replacement, a fixed 32-bit LCG seed, the 2.5th and 97.5th percentiles.
     */
    const bootstrap = (A, B) => {
      let seed = 12345;
      const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
      const microF1 = (rows) => {
        const tp = rows.reduce((a, x) => a + x.tp, 0);
        const fp = rows.reduce((a, x) => a + x.fp, 0);
        const fn = rows.reduce((a, x) => a + x.fn, 0);
        return tp ? (2 * tp) / (2 * tp + fp + fn) : 0;
      };
      const n = A.docs.length;
      const d = { entities: [], relations: [] };
      for (let it = 0; it < 2000; it++) {
        const idx = Array.from({ length: n }, () => Math.floor(rnd() * n));
        for (const what of ['entities', 'relations']) d[what].push(microF1(idx.map((i) => B.docs[i][what])) - microF1(idx.map((i) => A.docs[i][what])));
      }
      const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];
      const sgn = (x) => `${x >= 0 ? '+' : ''}${f3(x)}`;
      return ['entities', 'relations'].map((what) => `${what === 'entities' ? 'entity' : 'relation'} F1 ${sgn(B[what === 'entities' ? 'e' : 'r'].f1 - A[what === 'entities' ? 'e' : 'r'].f1)} ` +
        `[95% ${sgn(q(d[what], 0.025))}, ${sgn(q(d[what], 0.975))}], ahead in ${f3(d[what].filter((x) => x > 0).length / d[what].length)} of resamples`).join('; ');
    };
    sc('paired bootstrap over the 27 documents (2,000 resamples, seeded), the difference in micro F1 with its 95% interval:');
    sc(`  labels at ${NOW.ek.toFixed(2)}/${NOW.rk.toFixed(2)} against ids at ${PREV.ek.toFixed(2)}/${PREV.rk.toFixed(2)} (the change): ${bootstrap(cmpRows[0], cmpRows[3])}`);
    sc(`  labels against ids, both at ${PREV.ek.toFixed(2)}/${PREV.rk.toFixed(2)} (the schema alone): ${bootstrap(cmpRows[0], cmpRows[2])}`);
    sc(`  labels at ${NOW.ek.toFixed(2)}/${NOW.rk.toFixed(2)} against labels at ${PREV.ek.toFixed(2)}/${PREV.rk.toFixed(2)} (the cutoffs alone): ${bootstrap(cmpRows[2], cmpRows[3])}`);
    sc(`  labels at ${NOW.ek.toFixed(2)}/${NOW.rk.toFixed(2)} against labels at ${PREV_Q.ek.toFixed(2)}/${PREV_Q.rk.toFixed(2)}, the previous defaults: ${bootstrap(cmpRows[4], cmpRows[3])}`);
    for (const x of idsStores.values()) x.db.free();
    sc('the "labels" schema by entity keep (rows) and relation keep (columns): entity F1, relation F1 (tp/fp), distractors kept');
    const EK = [0.4, 0.5, 0.6, 0.7, 0.75];
    const RK = [0.25, 0.3, 0.35, 0.4, 0.5, 0.6];
    sc(`${'keep'.padEnd(6)} ${RK.map((k) => k.toFixed(2).padEnd(22)).join(' ').trimEnd()}`);
    for (const e of EK) {
      sc(`${e.toFixed(2).padEnd(6)} ${RK.map((k) => {
        const x = ccgAt(stores, e, k);
        return `${f3(x.e.f1)} ${f3(x.r.f1)} (${x.r.tp}/${x.r.fp}) d${x.kept}`.padEnd(22);
      }).join(' ').trimEnd()}`);
    }
    restore(SETS.ccg);
    note(`asked-as comparison done (${secs()})`);

    // 1. the relation keep cutoff
    sc();
    sc('### relation keep cutoff (rule 5, every link), entities at the defaults: relations P/R/F1 (tp/fp/fn)');
    sc(`${'keep'.padEnd(6)} ccg`);
    for (const k of [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) {
      setAll(SETS.ccg, { relKeep: k, relDrop: Math.min(SETS.ccg.D.relDrop, k) });
      regate(SETS.ccg);
      sc(`${k.toFixed(2).padEnd(6)} ${fmt2(totals(SETS.ccg).relations)}`);
    }
    resetCutoffs(SETS.ccg);
    note(`relation keep grid done (${secs()})`);

    // 2. the entity keep cutoff
    sc();
    sc('### entity keep cutoff (rule 5, every kind), relations at the defaults');
    sc("create-context-graph's format has no gazetteer: this is the model alone, and the relations move with it (rule 3 joins a");
    sc('claim to a kept mention first, else to one in review, and a claim joined to one in review waits in review: end-in-review).');
    sc(`${'keep'.padEnd(6)} ${'ccg entities'.padEnd(34)} ccg relations`);
    for (const k of [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.85]) {
      setAll(SETS.ccg, { entKeep: k, entDrop: Math.min(SETS.ccg.D.entDrop, k) });
      regate(SETS.ccg);
      const c = totals(SETS.ccg);
      sc(`${k.toFixed(2).padEnd(6)} ${fmt2(c.entities).padEnd(34)} ${fmt2(c.relations)}`);
    }
    resetCutoffs(SETS.ccg);
    note(`entity keep grid done (${secs()})`);

    // 3. drop cutoffs: what the drop band would lose (it never reaches review), and what review would hold
    sc();
    sc('### drop cutoffs: gold facts lost to the drop band, and the review queue (gold documents only)');
    sc('A gold relation is lost at drop cutoff d when its best claim that the gate could keep (anchored, legal) scores <= d;');
    sc("a gold entity when the model's best mention of it (its gold kind) scores <= d. The review queue is counted with");
    sc('the keep cutoffs at their defaults and every kind and link at drop d.');
    const losses = (set) => {
      regate(set, { off: ['band', 'ambiguity'] });
      const lossRel = [];
      const lossEnt = [];
      for (const oid of set.oids) {
        const db = stores.get(oid).db;
        const claims = cl.exec(db, "MATCH (c:_Claim) WHERE c.band = 'keep' RETURN c.doc AS doc, c.hn AS hn, c.tn AS tn, c.rel AS rel, c.p AS p").rows;
        const ms = cl.exec(db, "MATCH (m:_Mention) WHERE m.source = 'model' RETURN m.doc AS doc, m.name AS name, m.label AS label, m.p AS p").rows;
        const key = (x) => (set.names === 'honorific' ? store.withoutHonorific(x) : x);
        for (const g of cl.exec(db, "MATCH (g:_Gold {kind: 'relation'}) RETURN g.doc AS doc, g.title AS title, g.src AS src, g.rel AS rel, g.tgt AS tgt ORDER BY title, src, rel, tgt").rows) {
          const ps = claims.filter((c) => c.doc === g.doc && key(c.hn) === key(g.src) && key(c.tn) === key(g.tgt) && c.rel === g.rel).map((c) => c.p);
          lossRel.push({ ...g, p: ps.length ? Math.max(...ps) : null });
        }
        for (const g of cl.exec(db, "MATCH (g:_Gold {kind: 'entity'}) RETURN g.doc AS doc, g.title AS title, g.src AS name, g.rel AS kind ORDER BY title, name, kind").rows) {
          const ps = ms.filter((m) => m.doc === g.doc && key(m.name) === key(g.name) && m.label === g.kind).map((m) => m.p);
          lossEnt.push({ ...g, p: ps.length ? Math.max(...ps) : null });
        }
      }
      return { lossRel, lossEnt };
    };
    const found = (xs) => xs.filter((x) => x.p != null);
    const L = { ccg: losses(SETS.ccg) };
    sc(`gold relations with such a claim: ccg ${found(L.ccg.lossRel).length} of ${L.ccg.lossRel.length}` +
      ' (the rest need another sentence, a pronoun resolved, or an end the gate keeps);');
    sc(`gold entities the model finds with their gold kind: ccg ${found(L.ccg.lossEnt).length} of ${L.ccg.lossEnt.length}`);
    sc(`${'drop'.padEnd(6)} ccg: relations lost, claims in review; entities lost, mentions in review`);
    for (const d of [0.1, 0.15, 0.2, 0.25, 0.3, 0.35]) {
      const set = SETS.ccg;
      setAll(set, { entKeep: set.D.entKeep, entDrop: d, relKeep: set.D.relKeep, relDrop: d });
      regate(set);
      sc(`${d.toFixed(2).padEnd(6)} ${found(L.ccg.lossRel).filter((x) => x.p <= d).length}, ${inGold(set, '_Claim', 'review')}; ` +
        `${found(L.ccg.lossEnt).filter((x) => x.p <= d).length}, ${inGold(set, '_Mention', 'review')}`);
    }
    {
      const low = found(L.ccg.lossRel).sort((a, b) => a.p - b.p || cmp(a.title, b.title)).slice(0, 3);
      sc(`lowest-scoring gold relations, ccg: ${low.map((x) => `${x.src} -[${x.rel}]-> ${x.tgt} ${f3(x.p)}`).join('; ')}`);
      const lowE = found(L.ccg.lossEnt).sort((a, b) => a.p - b.p || cmp(a.name, b.name)).slice(0, 3);
      sc(`lowest-scoring gold entities (the model alone), ccg: ${lowE.map((x) => `${x.name} (${x.kind}) ${f3(x.p)}`).join('; ')}`);
    }
    resetCutoffs(SETS.ccg);
    note(`drop grid done (${secs()})`);

    // 4. margins
    sc();
    sc('### margins: rule 2 (type margin) and rule 6 (relation margin)');
    sc(`${'type margin'.padEnd(12)} ccg entities; sent to review by it`);
    for (const m of [0, 0.025, 0.05, 0.1, 0.15]) {
      regate(SETS.ccg, { typeMargin: m });
      sc(`${m.toFixed(3).padEnd(12)} ${fmt2(totals(SETS.ccg).entities)}; ${inGold(SETS.ccg, '_Mention', 'type-margin')}`);
    }
    sc(`${'rel margin'.padEnd(12)} ccg relations; sent to review as ambiguous`);
    for (const m of [0, 0.05, 0.15]) {
      regate(SETS.ccg, { relMargin: m });
      sc(`${m.toFixed(3).padEnd(12)} ${fmt2(totals(SETS.ccg).relations)}; ${inGold(SETS.ccg, '_Claim', 'ambiguous')}`);
    }

    // 5. rule 2's POLE preference: the pole margin (create-context-graph's poles; a generic document's kinds have none)
    sc();
    sc("### rule 2's POLE preference: the pole margin (create-context-graph's samples; a generic document's kinds have no pole)");
    sc('When a span\'s best label is a base kind, a domain kind of its pole that scored within the pole margin of it, and above');
    sc('its own drop cutoff, wins the span ("off": no preference). Columns: the samples\' entities and relations, P/R/F1');
    sc('(tp/fp/fn); the gold entities kept or in review with their gold kind ("in reach"); the mentions the preference chose');
    sc('(kept); the review queue (mentions, claims); the distractors kept.');
    const PM = [null, 0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1];
    const perDomain = new Map();
    sc(`${'margin'.padEnd(7)} ${'ccg entities'.padEnd(32)} ${'ccg relations'.padEnd(29)} ${'in reach'.padEnd(9)} ${'chosen (kept)'.padEnd(14)} ${'review m, c'.padEnd(12)} distractors kept`);
    for (const pm of PM) {
      regate(SETS.ccg, { poleMargin: pm });
      const t = totals(SETS.ccg);
      const reach = entityOutcomes().filter((x) => x.why === 'kept' || x.why.startsWith('review')).length;
      const ch = inGold(SETS.ccg, '_Mention', 'pole-specific');
      const chKept = SETS.ccg.oids.reduce((acc, oid) => acc + cl.exec(stores.get(oid).db, "MATCH (m:_Mention) WHERE m.rule = 'pole-specific' AND m.band = 'keep' RETURN count(m) AS n").rows[0].n, 0);
      if (pm === null || pm === D.poleMargin) perDomain.set(pm, scoreSet(SETS.ccg).map((x) => [x.entities.total, x.relations.total]));
      sc(`${(pm === null ? 'off' : pm.toFixed(2)).padEnd(7)} ${fmt2(t.entities).padEnd(32)} ${fmt2(t.relations).padEnd(29)} ${String(reach).padEnd(9)} ` +
        `${`${ch} (${chKept})`.padEnd(14)} ${`${inGold(SETS.ccg, '_Mention', 'review')}, ${inGold(SETS.ccg, '_Claim', 'review')}`.padEnd(12)} ${keptDistractors()}`);
    }
    sc(`per domain, with the preference off and at the default pole margin ${f3(D.poleMargin)} (entity F1; relation F1), where either moves:`);
    const moved = ccgOids.map((oid, i) => [oid, perDomain.get(null)[i], perDomain.get(D.poleMargin)[i]])
      .filter(([, a, b]) => f3(a[0].f1) !== f3(b[0].f1) || f3(a[1].f1) !== f3(b[1].f1));
    for (const [oid, a, b] of moved) sc(`  ${oid.padEnd(21)} entities ${f3(a[0].f1)} -> ${f3(b[0].f1)} (tp ${a[0].tp} -> ${b[0].tp}, fp ${a[0].fp} -> ${b[0].fp}); relations ${f3(a[1].f1)} -> ${f3(b[1].f1)}`);
    if (!moved.length) sc('  none');
    regate(SETS.ccg);
    note(`pole margin grid done (${secs()})`);

    // 6. true and false facts by score: what a lower relation keep would admit
    sc();
    sc('### the facts the relation keep cutoff decides, by score: true (in the gold) and false (gold documents only)');
    sc('Each fact the gate could keep (anchored, legal; rules 5 and 6 off) once, at its best claim\'s score, in bands of 0.05,');
    sc('entities at the defaults. Below the keep cutoff a fact waits in review; above it, it is published without one.');
    const facts = (set) => {
      regate(set, { off: ['band', 'ambiguity'] });
      const out = [];
      for (const oid of set.oids) {
        const db = stores.get(oid).db;
        const docs = new Set(set.docs(oid));
        const key = (x) => (set.names === 'honorific' ? store.withoutHonorific(x) : x);
        const gold = new Set(cl.exec(db, "MATCH (g:_Gold {kind: 'relation'}) RETURN g.doc AS doc, g.src AS src, g.tgt AS tgt, g.rel AS rel").rows
          .map((g) => [g.doc, key(g.src), key(g.tgt), g.rel].join(SEP)));
        const bestBy = new Map();
        for (const c of cl.exec(db, "MATCH (c:_Claim) WHERE c.band = 'keep' RETURN c.doc AS doc, c.hn AS hn, c.tn AS tn, c.rel AS rel, c.p AS p").rows) {
          if (!docs.has(c.doc)) continue;
          const k = [c.doc, key(c.hn), key(c.tn), c.rel].join(SEP);
          bestBy.set(k, Math.max(bestBy.get(k) ?? 0, c.p));
        }
        for (const [k, p] of bestBy) out.push({ p, ok: gold.has(k), rel: k.split(SEP)[3] });
      }
      return out;
    };
    const F = { ccg: facts(SETS.ccg) };
    sc(`${'score'.padEnd(12)} ccg true, false`);
    for (let b = 20; b < 100; b += 5) {
      const lo = b / 100;
      const hi = (b + 5) / 100;
      const cell = (xs) => {
        const inb = xs.filter((x) => x.p >= lo && x.p < hi);
        return `${inb.filter((x) => x.ok).length}, ${inb.filter((x) => !x.ok).length}`;
      };
      sc(`${`${lo.toFixed(2)}-${hi.toFixed(2)}`.padEnd(12)} ${cell(F.ccg)}`);
    }
    const within = (xs, lo, hi) => xs.filter((x) => x.p >= lo && x.p < hi);
    const band = (xs, lo, hi) => `${within(xs, lo, hi).filter((x) => x.ok).length} true and ${within(xs, lo, hi).filter((x) => !x.ok).length} false`;
    const PREV_RK = 0.6;
    sc(`from 0.20 up to the default keep ${f3(SETS.ccg.D.relKeep)} (in review at the defaults): ccg ${band(F.ccg, 0.2, SETS.ccg.D.relKeep)}`);
    sc(`from the default keep ${f3(SETS.ccg.D.relKeep)} up to ${f3(PREV_RK)}, the previous one (kept now, in review before): ccg ${band(F.ccg, SETS.ccg.D.relKeep, PREV_RK)}`);
    const wf = F.ccg.filter((x) => x.ok && x.rel === 'WORKS_FOR').map((x) => x.p).sort((a, b) => a - b);
    sc(`true WORKS_FOR facts on the ccg samples: ${wf.length}, scoring ${wf.map(f3).join(', ')}; below ${f3(SETS.ccg.D.relKeep)} (in review at the default): ` +
      `${wf.filter((p) => p < SETS.ccg.D.relKeep).length}`);
    const dp = distractorClaims.map((x) => x.p).sort((a, b) => b - a);
    sc(`the distractors' claims (above, in their own sentences, any anchoring) score ${dp.map(f3).join(', ')}: ${dp.filter((p) => p >= 0.55).length} at 0.55 or more, ` +
      `${dp.filter((p) => p >= SETS.ccg.D.relKeep).length} at the default keep ${f3(SETS.ccg.D.relKeep)} or more`);
    restore(SETS.ccg);
    sc();
    sc(`chosen (store.defaultGate, ${M.name}; every ontology): ${cutsLine(SETS.ccg.D)};`);
    sc(`  type margin ${f3(D.typeMargin)}; relation margin ${f3(D.relMargin)}; pole margin ${f3(D.poleMargin)}`);
    note(`the defaults' grids done (${secs()})`);
  }
}

// ==== graph.cypher ==================================================================================
let graphText = '';
if (FULL) {
  const parts = [];
  // The Financial Services sample's store (after review.txt, which leaves it as the defaults do) and the fixtures' store.
  for (const key of [FIXTURE_ONTOLOGY, FIX]) parts.push(store.exportCypher(stores.get(key).db, cl));
  graphText = `// graph.cypher: the typed knowledge graphs of the ${FIXTURE_ONTOLOGY} sample and of the harness's fixtures, which read the\n` +
    '// same ontology (expected/graph.cypher, harness/run.mjs). Each part runs on its own database.\n' + parts.join('');
}

// ==== write ========================================================================================
mkdirSync(OUT, { recursive: true });
const files = FULL ? ['extract', 'gate', 'audit', 'review', 'score'] : ['extract', 'score'];
for (const f of files) writeFileSync(join(OUT, `${f}.txt`), lines[f].join('\n') + '\n');
if (FULL) writeFileSync(join(OUT, 'graph.cypher'), graphText);
for (const s of stores.values()) s.db.free();
note(`done in ${secs()}; model calls answered by the pool ${modelStats.hits}, by this thread ${modelStats.misses}`);
if (failures.length) {
  note(`${failures.length} failure(s): ${failures.join('; ')}`);
  process.exit(1);
}
