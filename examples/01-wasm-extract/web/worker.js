// @ts-check
/**
 * worker.js: the engine worker (NOTES.md D6, D7, D9-D11, D14-D17). It is
 * the only writable owner of the open store `opfs://ex01-kg-<slug>` (ontology.js storeName) and
 * holds the gliner-rs model: two synchronous WASM instances in one dedicated module worker, no
 * SharedArrayBuffer. The page holds no database or model handle.
 *
 * Protocol. The page posts {...args, id, kind} (no argument is named id or kind); the worker
 * answers {id, ok: true, data} or
 * {id, ok: false, error: {code, message, detail?, category?, ...}}, and posts progress events
 * {event, job?, ...} with no id. Jobs run one at a time in arrival order; `stop`, `lend` and
 * `reclaim` are signals handled on arrival.
 *
 *   init           {}                        -> {version, opfs, syncAccessHandle, memoryMiB}
 *   open-store     {yaml, bases?} | {name}   -> describe() + {regated, regatedBecause}: opens (creates) the ontology's store,
 *                                               (yaml: the ontology's text, an Ontology Graph Spec 1.1 document in YAML
 *                                               or JSON, or a create-context-graph file, converted by
 *                                               ontology.js parseOntology; the converted document is what is stored)
 *                  [cutoffs, gate, model,       or an existing store by name with the ontology it holds; applies
 *                   retryLocked,                the ontology (store.openStore: R9 indexes, R16 repair, D15) and
 *                   discardLegacy]              the default cutoffs of its format and model (the loaded model's,
 *                                               else `model`, 'small' or 'base'; only cutoffs nobody moved). On
 *                                               the store already open, {yaml} edits its ontology in place, and
 *                                               a changed ontology, or moved default cutoffs, over data is gated
 *                                               and published again (regatedBecause 'ontology' or 'cutoffs').
 *                                               bases: create-context-graph base ontologies by name ({_base: text}),
 *                                               for a create-context-graph file; a stored ontology is a document
 *                                               (ontologyFromStored; an earlier build's stored YAML is converted).
 *                                               retryLocked: retry `storage locked` for LOCK_WAIT_MS (the page's
 *                                               reopen after a crash or a recycle; R11). A store an earlier
 *                                               build wrote with unprefixed labels is refused (store, reason
 *                                               legacy) unless discardLegacy: true, which empties it (reset())
 *                                               and applies the given ontology, or the one it held. A store
 *                                               whose ontology an earlier build kept as edgextract's YAML, which
 *                                               this build no longer reads, is refused (store, reason
 *                                               legacy-ontology) when opened by name: delete-store removes it
 *   delete-store   {name}                    -> {deleted}: closes the store if it is the open one, checks no other
 *                                               tab holds it (a writable open, freed), and removes its OPFS
 *                                               directory: the earlier-build banner's answer to legacy-ontology
 *   close          {}                        -> {closed}: free the store, which checkpoints it (R12): another
 *                                               tab takes it over, or the page's recycle ends this worker next
 *   load-model     {which, info: {repo, rev, weights}, files: {weights, tokenizer, config,
 *                  encoderConfig} (ArrayBuffers, transferred), gate?}  -> {which, memoryMiB, ms, defaults, regated}:
 *                                               with a store open, its default cutoffs move to the model's
 *                                               (store.applyDefaultCutoffs) and, when any moved, it is gated and
 *                                               published again (regated, else null)
 *   plan           {text, info?}             -> {doc, sentences, sections, complete, pending, needInference, cached}
 *   extract        {text, title, gate?}      -> {counters, gate, published, ms, extractions}; events
 *                                               {event: 'inference', job, n} before the run's n-th model
 *                                               call (the page's progress: n of plan's needInference) and
 *                                               {event: 'section', job, section, sections, counters}
 *   stop           {}                        -> {stopping}: the running extraction stops after its section
 *   regate         {gate?}                   -> {gate, published}   (D10, D16: never the model)
 *   publish        {}                        -> {published}
 *   verdict        {target, value, gate?}    -> {verdict, gate, published}
 *   cutoffs        {what, name, keep, drop, gate?} -> {gate, published, belowFloor}  (name: the kind's or link's id;
 *                                               the pair is the user's from now on)
 *   reset-cutoffs  {gate?}                   -> {gate, published, defaults}: every cutoff back to the defaults of the
 *                                               store's format and the model, following them again
 *   forget         {doc, gate?}              -> {deleted, gate, published}
 *   rebuild        {yaml, bases?, gate?}     -> describe(): drop the typed graph, apply the edited ontology,
 *                                               re-publish from the trace (D14, when an edit was 'blocked')
 *   lend           {}                        -> {name, uri}: the store is freed for the console (D11); during an
 *                                               extraction this answers between sections
 *   reclaim        {}                        -> {name, reopened}: reopen after the console's query
 *   dump           {}                        -> {text, fileName}: dump.json (lib/replay format, canon text)
 *   download       {}                        -> {bytes (transferred), fileName, summary} (D17)
 *   restore        {bytes, fileName}         -> {name, summary, ontology, counts, spec, digest, compare, legacy}
 *   reset          {}                        -> describe(): db.reset(), then the ontology again
 *   stats          {}                        -> stats()
 *   graph          {doc?, candidates?}       -> {nodes, rels, candidates, labelOrder, colors}: the typed graph for NVL;
 *                                               candidates: true adds the review candidates ({nodes, rels}, each
 *                                               marked candidate: true), else candidates is null
 *   review         {}                        -> {claims, mentions}: review-band and decided claims and mentions
 *                                               (reviewItems: with what each one's explanation needs)
 *   details        {node} | {rel: {a, type, b}} -> {title, properties, evidence}
 *                  {candidate: {node} | {rel: {a, type, b}}} -> {what: 'candidate', title, claims, mentions}: a review
 *                                               candidate's claims or mentions in review (reviewItems rows)
 *   digest         {}                        -> {digest}: lib/replay contentDigest of the store
 * Error codes: no-store, no-model, locked (R11: another tab holds the store; the page offers
 * the handover), trap (the instance is gone, R14: the page replaces this worker, committed data
 * survives, R24), blocked (an ontology edit the data breaks, O5), ontology (invalid YAML), format
 * (a restore input that is not Relate 1.3.0's, or that 1.3.0 cannot open, X5), engine (an error
 * envelope), lent, busy, usage, error.
 *
 * Engine facts this worker leans on: no transaction control (R2), so every write is an idempotent
 * MERGE with a completion marker last (D9, store.js); one opener per OPFS store, read-only
 * included, refused with an Error named RelateLocked (R11), matched by its `storage locked: opfs://`
 * text; no file surface (R12: no export, import or callable db.checkpoint), so a download frees the
 * handle and tars the store's snapshot itself (export.js), and free() is the only checkpoint.
 * Every reopen (reclaim, download, a page restart) retries `storage locked` for LOCK_WAIT_MS: a
 * worker ended inside a WASM call keeps its handles a moment (about 2 s in Chromium; R11).
 *
 * Memory (R13): WASM memory never shrinks, not even after free() or reset(), so this worker
 * does not recycle itself. After every 10 extractions the page checkpoints the store (`close`:
 * free(), the only checkpoint, R12), then ends this worker and starts a fresh one (app.js
 * recycleEngine), which reopens the checkpointed store (no WAL to replay into memory) and reloads
 * the model from Cache Storage.
 */
import * as cl from '../../../lib/relate_wasm.mjs';
import * as replay from '../../../lib/replay.mjs';
import { exportTar, parseRestoreTar, restoreName } from './export.js';
import { freeModel, loadModel, memoryBytes } from './gliner.js';
import {
  LEGACY_FORMAT, OntologyApplyError, OntologyError, currentGraphType, ontologyCanary, ontologyFromStored, parseOntology, readOntology, storeName,
} from './ontology.js';
import * as opfs from './opfs.js';
import * as pipeline from './pipeline.js';
import { splitSentences } from './split.js';
import * as store from './store.js';

const ASSETS = new URL('./assets/', import.meta.url);
const RELATE = '1.3.0';
const GLUE = 'relate-1.3.0/relate.js';
const GLINER_GLUE = 'gliner-rs-4fa741e/gliner_rs.js';
const GLINER_WASM = 'gliner-rs-4fa741e/gliner_rs_bg.wasm';
/** How long a reopen retries `storage locked` (R11: about 2 s in Chromium after a terminate mid-call). */
const LOCK_WAIT_MS = 6000;
const LOCK_RETRY_MS = 200;
const STORE_NAME = /^ex01-kg-[A-Za-z0-9_-]{1,56}$/;
const LOCKED = /(?:^|: )storage locked: opfs:\/\//;

/** A refusal the page shows as is. */
class WorkerError extends Error {
  /** @param {string} code @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'WorkerError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---- state ----------------------------------------------------------------------------------------

/** @type {any} the Relate glue module */
let mod = null;
/** @type {any} its WASM exports (memory) */
let engineExports = null;
/** @type {any} the writable RelateDb on the open store */
let real = null;
/** @type {{name: string, ontology: import('./ontology.js').Ontology} | null} */
let current = null;
/** @type {import('./gliner.js').ModelHandle | null} */
let model = null;
/** @type {store.ModelInfo | null} */
let modelInfo = null;
let modelWhich = '';
/** The model whose default cutoffs the open store follows: the loaded one, else the page's choice ('small' or 'base'). */
let defaultsModel = store.DEFAULT_MODEL;
/** @type {any} */
let glinerGlue = null;
/** @type {WebAssembly.Module | null} */
let glinerModule = null;
let extractions = 0;
/** @type {object | null} */
let crashed = null;
let stopRequested = false;
/** @type {string | null} */
let running = null;
/** @type {any} a lend that arrived during an extraction, honoured between sections */
let pendingLend = null;
/** @type {{release: (m: any) => void, name: string} | null} */
let lendState = null;

/** The handle store.js, ontology.js and lib/replay.mjs use: it follows `real` across reopens. */
const db = {
  execute: (/** @type {string} */ q, /** @type {string|null} */ p) => handle().execute(q, p),
  executeScript: (/** @type {string} */ s, /** @type {string|null} */ p) => handle().executeScript(s, p),
};
function handle() {
  if (real) return real;
  if (lendState) throw new WorkerError('lent', 'the store is lent to the console right now');
  throw new WorkerError('no-store', 'no store is open');
}
/** @param {any} h */
const proxy = (h) => ({ execute: (/** @type {string} */ q, /** @type {any} */ p) => h.execute(q, p), executeScript: (/** @type {string} */ s, /** @type {any} */ p) => h.executeScript(s, p) });

const post = (/** @type {object} */ msg, /** @type {Transferable[]} */ transfer = []) => self.postMessage(msg, { transfer });
const q = (/** @type {string} */ text, /** @type {object|null} */ params = null) => cl.exec(db, text, params, { allowNull: true }).rows;

// ---- the engine -----------------------------------------------------------------------------------

async function ensureEngine() {
  if (mod) return mod;
  const m = await import(new URL(GLUE, ASSETS).href);
  engineExports = await m.default();
  const probe = new m.RelateDb();
  let v;
  try { v = cl.version(probe); } finally { probe.free(); }
  if (v !== RELATE) throw new WorkerError('version', `the bundled Relate reports ${v}, not ${RELATE}`);
  mod = m;
  return mod;
}

/**
 * Open a store writable. A lock held elsewhere (R11: an Error named RelateLocked, told by its text) is retried
 * every LOCK_RETRY_MS for `waitMs`, then becomes WorkerError('locked').
 * @param {string} name @param {{waitMs?: number}} [opts]
 */
async function openWritable(name, { waitMs = 0 } = {}) {
  await ensureEngine();
  const t0 = performance.now();
  for (;;) {
    try {
      return await mod.RelateDb.open(`opfs://${name}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!LOCKED.test(message)) throw e;
      if (performance.now() - t0 >= waitMs) {
        throw new WorkerError('locked', `${name} is open in another tab or window (storage locked: opfs://${name}); only one may hold a store (R11)`, { name });
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

function needStore() {
  handle();
  if (!current) throw new WorkerError('no-store', 'no store is open');
  return current;
}

function needModel() {
  if (!model || !modelInfo) throw new WorkerError('no-model', 'load the model first');
  return model;
}

// ---- views of the store ---------------------------------------------------------------------------

const BANDS = /** @type {const} */ (['keep', 'review', 'drop']);
/** A sentence key '<doc>#<idx>' -> idx. @param {string} key */
const idxOf = (key) => Number(String(key).split('#').pop());

/** Band counts of a gate result, overall and for one document. */
function summarize(g, doc = null) {
  const count = (/** @type {any[]} */ xs) => Object.fromEntries(BANDS.map((b) => [b, xs.filter((x) => x.band === b).length]));
  const out = { mentions: count(g.mentions), claims: count(g.claims) };
  if (doc) {
    return {
      ...out,
      doc: {
        mentions: count(g.mentions.filter((m) => m.doc === doc)),
        claims: count(g.claims.filter((c) => c.doc === doc)),
        kept: g.claims.filter((c) => c.doc === doc && c.band === 'keep')
          .map((c) => ({ head: c.htext, rel: c.rel, tail: c.ttext, p: c.p, rule: c.rule, sentence: c.sentence }))
          .sort((a, b) => idxOf(a.sentence) - idxOf(b.sentence) || replay.cmp(a.head, b.head) || replay.cmp(a.rel, b.rel) || replay.cmp(a.tail, b.tail)),
      },
    };
  }
  return out;
}

/** @param {any} [opts] */
function gateOpts(opts) {
  const o = opts ?? {};
  const num = (/** @type {any} */ v, /** @type {number} */ d) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : d);
  return {
    typeMargin: num(o.typeMargin, store.DEFAULT_GATE.typeMargin),
    relMargin: num(o.relMargin, store.DEFAULT_GATE.relMargin),
    poleMargin: num(o.poleMargin, store.DEFAULT_GATE.poleMargin),
    off: Array.isArray(o.off) ? o.off.filter((/** @type {any} */ r) => store.RULES.includes(r)) : [],
  };
}

/** gate (D10) and publish (D16): what every change to cutoffs, verdicts or documents ends with. */
function regateAndPublish(opts, doc = null) {
  const g = store.gate(db, cl, gateOpts(opts));
  const published = store.publish(db, cl);
  return { gate: summarize(g, doc), published };
}

/** Kinds' colours as the ontology sets them (ontology.js DEFAULT_COLOR means none). */
function kindColors(o) {
  /** @type {Record<string, string>} */
  const colors = {};
  for (const t of o.types) if (t.color && t.color.toLowerCase() !== '#64748b') colors[t.id] = t.color;
  return colors;
}

function stats() {
  const c = needStore();
  const onto = store.storedOntology(db, cl);
  const counts = store.counts(db, cl);
  const documents = q(`MATCH (d:_Document)
OPTIONAL MATCH (sec:_Section)-[:_OF]->(d)
WITH d, count(sec) AS sections, sum(CASE WHEN sec.complete = true THEN 1 ELSE 0 END) AS complete
RETURN d.id AS id, d.title AS title, d.chars AS chars, sections, complete ORDER BY title, id`);
  const one = (/** @type {string} */ text) => Number(q(text)[0]?.n ?? 0);
  const kinds = new Map(c.ontology.types.map((t) => [t.id, t]));
  const links = new Map(c.ontology.relations.map((r) => [r.id, r]));
  // Sentences whose stored inferences were all made under another schema than the one the ontology
  // asks now (an earlier build, or an edited ontology): their mentions stay as they were until the
  // document is forgotten and extracted again (complete sections are skipped, D9).
  const schema = JSON.stringify(pipeline.modelSchema(c.ontology).schema);
  const stale = new Map(q(`MATCH (s:_Sentence)-[:_INFERRED]->(:_Inference)
WITH DISTINCT s
WHERE $schema IS NOT NULL AND NOT EXISTS { MATCH (s)-[:_INFERRED]->(j:_Inference) WHERE j.schema = $schema }
RETURN s.doc AS doc, count(s) AS n`, { schema }).map((r) => [r.doc, Number(r.n)]));
  return {
    name: c.name,
    ontology: {
      id: onto.oid,
      title: c.ontology.title || c.ontology.id,
      format: c.ontology.format,
      meta: c.ontology.meta,
      sha: c.ontology.sha,
      spec: c.ontology.spec,
      convertedFrom: c.ontology.convertedFrom,
      yaml: c.ontology.yaml,
      tools: c.ontology.tools,
      kinds: onto.kinds.map((k) => ({
        ...k, description: kinds.get(k.id)?.description ?? '', color: kinds.get(k.id)?.color ?? null,
        pole: kinds.get(k.id)?.pole ?? null, origin: kinds.get(k.id)?.origin ?? 'own', ask: kinds.get(k.id)?.ask ?? null,
        unasked: kinds.get(k.id)?.unasked ?? null, askMode: kinds.get(k.id)?.askMode ?? null, proper: kinds.get(k.id)?.proper ?? false,
        propose: kinds.get(k.id)?.propose ?? false, keyProp: kinds.get(k.id)?.keyProp ?? null,
        attributes: (kinds.get(k.id)?.attributes ?? []).map((a) => a.prop),
      })),
      links: onto.links.map((l) => ({ ...l, ask: links.get(l.id)?.ask ?? l.phrase })),
      colors: kindColors(c.ontology),
    },
    counts,
    documents: documents.map((d) => ({ ...d, staleSentences: stale.get(d.id) ?? 0 })),
    inferences: one('MATCH (i:_Inference) WHERE i.parts IS NOT NULL RETURN count(i) AS n'),
    inferredSentences: one('MATCH (s:_Sentence)-[:_INFERRED]->(:_Inference) RETURN count(DISTINCT s) AS n'),
    verdicts: one('MATCH (v:_Verdict) RETURN count(v) AS n'),
    entities: one('MATCH (e:_Entity) RETURN count(e) AS n'),
    facts: one('MATCH (:_Entity)-[r]->(:_Entity) RETURN count(r) AS n'),
    floor: pipeline.FLOOR,
    defaults: store.defaultGate(c.ontology.format, defaultsModel),
    defaultsModel,
    model: modelInfo ? { which: modelWhich, ...modelInfo } : null,
    extractions,
    memory: {
      relateMiB: engineExports ? engineExports.memory.buffer.byteLength >> 20 : 0,
      glinerMiB: model ? memoryBytes(model) >> 20 : 0,
    },
  };
}

/** What open-store, rebuild and reset answer. */
function describe(applied) {
  const c = needStore();
  return {
    name: c.name,
    applied: applied ? { altered: applied.ontology.altered, previousSha: applied.ontology.previousSha, typed: applied.ontology.typed, untyped: applied.ontology.untyped } : null,
    canary: ontologyCanary(db, cl),
    spec: currentGraphType(db, cl),
    stats: stats(),
  };
}

// ---- review items: the Review tab and the graph tab's candidates ------------------------------------

/**
 * Claims and mentions as the Review tab and the graph tab's candidate panel show them, with what the
 * page needs to say in one sentence why each is where it is (app.js explain): a claim's link cutoffs
 * and its ends' bands, a mention's kind cutoffs and the other kinds that scored on its words (the base
 * kind a pole-specific one beat, the runner-up of a type-margin one), and the latest verdict.
 * `claimWhere` and `mentionWhere` select the rows (Cypher over c and m; parameters in `params`).
 * @param {string|null} claimWhere @param {string|null} mentionWhere @param {Record<string, any>} params
 */
function reviewItems(claimWhere, mentionWhere, params) {
  const claims = claimWhere ? q(`MATCH (c:_Claim)-[:_EVIDENCE]->(s:_Sentence)
WHERE ${claimWhere}
OPTIONAL MATCH (d:_Document {id: c.doc})
OPTIONAL MATCH (l:_LinkType) WHERE l.id = c.rel
OPTIONAL MATCH (c)-[:_HEAD]->(hm:_Mention)
OPTIONAL MATCH (c)-[:_TAIL]->(tm:_Mention)
RETURN c.key AS key, c.rel AS rel, c.htext AS head, c.ttext AS tail, c.p AS p, c.band AS band, c.rule AS rule, c.cue AS cue,
       c.hk AS hk, c.tk AS tk, c.head AS headKey, c.tail AS tailKey,
       c.hs - s.start AS hs, c.he - s.start AS he, c.ts - s.start AS ts, c.te - s.start AS te,
       s.text AS sentence, s.idx AS idx, d.title AS document, l.keep AS keep, l.drop AS drop,
       hm.band AS hband, hm.text AS hmtext, hm.label AS hmlabel, tm.band AS tband, tm.text AS tmtext, tm.label AS tmlabel
ORDER BY document, idx, key
LIMIT 1000`, params) : [];
  const mentions = mentionWhere ? q(`MATCH (m:_Mention)-[:_IN]->(s:_Sentence)
WHERE ${mentionWhere}
OPTIONAL MATCH (d:_Document {id: m.doc})
OPTIONAL MATCH (k:_Kind) WHERE k.id = m.label
OPTIONAL MATCH (o:_Mention)-[:_IN]->(s) WHERE o.start = m.start AND o.end = m.end AND o.key <> m.key AND o.source = 'model'
WITH m, s, d, k, o ORDER BY o.p DESC, o.label ASC
WITH m, s, d, k, collect(o) AS os
RETURN m.key AS key, m.text AS text, m.label AS label, m.name AS name, m.p AS p, m.band AS band, m.rule AS rule, m.prior AS prior, m.alt AS alt,
       m.start - s.start AS ms, m.end - s.start AS me, s.text AS sentence, s.idx AS idx, d.title AS document,
       k.keep AS keep, k.drop AS drop, [x IN os | [x.label, x.p]] AS others
ORDER BY document, idx, key
LIMIT 1000`, params) : [];
  /** @type {Map<string, string>} latest verdict per target (ts, then seq: verdicts within one statement share a ts) */
  const latest = new Map();
  for (const v of store.listVerdicts(db, cl)) latest.set(v.target, v.value);
  return {
    claims: claims.map((c) => ({ item: 'claim', ...c, verdict: latest.get(c.key) ?? null })),
    mentions: mentions.map((x) => ({ item: 'mention', ...x, others: (x.others ?? []).map((/** @type {any[]} */ [label, p]) => ({ label, p })), verdict: latest.get(x.key) ?? null })),
  };
}

/**
 * The graph tab's review candidates (drawn faded beside the kept graph): claims in the review band
 * whose two ends are kept or in review, and the mentions in review on them. A mention in review is
 * drawn as the entity it would become (`KIND:NAME`), unless that entity is kept already; a claim as one
 * relationship per (head, link, tail) not already published. Ids are prefixed so they never meet a
 * kept relationship's. `kept` holds the drawn kept entities' keys and relationship ids.
 * @param {string|null} doc @param {{nodes: Set<string>, rels: Set<string>}} kept
 */
function reviewCandidates(doc, kept) {
  const rows = q(`MATCH (c:_Claim) WHERE c.band = 'review' AND ($doc IS NULL OR c.doc = $doc)
MATCH (c)-[:_HEAD]->(h:_Mention)
MATCH (c)-[:_TAIL]->(t:_Mention)
WITH c, h, t WHERE h.band IN ['keep', 'review'] AND t.band IN ['keep', 'review']
RETURN c.key AS key, c.rel AS rel, c.head AS head, c.tail AS tail, c.p AS p, c.rule AS rule,
       h.band AS hband, h.label AS hlabel, h.name AS hname, h.text AS htext,
       t.band AS tband, t.label AS tlabel, t.name AS tname, t.text AS ttext
ORDER BY key`, { doc });
  const symmetric = new Set((current?.ontology.relations ?? []).filter((r) => r.symmetric).map((r) => r.id));
  /** @type {Map<string, {key: string, kind: string, texts: string[], mentions: number}>} */
  const nodes = new Map();
  /** @type {Map<string, {a: string, type: string, b: string, p: number, claims: number, rules: Set<string>}>} */
  const rels = new Map();
  for (const r of rows) {
    const ends = [[r.head, r.hband, r.hlabel, r.htext], [r.tail, r.tband, r.tlabel, r.ttext]];
    // A kept end is a drawn kept entity; one in review is a candidate entity unless that entity is kept.
    if (ends.some(([key, band]) => band === 'keep' && !kept.nodes.has(key))) continue;
    if (kept.rels.has(`${r.head}|${r.rel}|${r.tail}`) || (symmetric.has(r.rel) && kept.rels.has(`${r.tail}|${r.rel}|${r.head}`))) continue;
    for (const [key, band, label, text] of ends) {
      if (band !== 'review' || kept.nodes.has(key)) continue;
      const n = nodes.get(key) ?? { key, kind: label, texts: [], mentions: 0 };
      n.texts.push(text);
      n.mentions++;
      nodes.set(key, n);
    }
    const id = `review:${r.head}|${r.rel}|${r.tail}`;
    const x = rels.get(id) ?? { a: r.head, type: r.rel, b: r.tail, p: -1, claims: 0, rules: new Set() };
    x.p = Math.max(x.p, r.p);
    x.claims++;
    x.rules.add(r.rule);
    rels.set(id, x);
  }
  const display = (/** @type {string[]} */ texts) => {
    const counts = new Map();
    for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || replay.cmp(a[0], b[0]))[0][0];
  };
  return {
    nodes: [...nodes.values()].sort((a, b) => replay.cmp(a.key, b.key)).map((n) => ({
      id: n.key, labels: ['_Entity', n.kind], candidate: true,
      properties: { name: display(n.texts), key: n.key, kind: n.kind, band: 'review', mentions: n.mentions },
    })),
    rels: [...rels].sort((a, b) => replay.cmp(a[0], b[0])).map(([id, x]) => ({
      id, type: x.type, start_node: x.a, end_node: x.b, candidate: true,
      properties: { p: x.p, claims: x.claims, band: 'review', rules: [...x.rules].sort(replay.cmp) },
    })),
  };
}

/**
 * The ontology an earlier build kept in a store, parsed; an ontology this build no longer reads
 * (edgextract's YAML: ontology.js LEGACY_FORMAT) refuses the store as StoreError('legacy-ontology'),
 * which the page answers with the earlier-build banner and its Delete button (delete-store).
 * @param {string} name @param {() => import('./ontology.js').Ontology} parse
 */
function keptOntology(name, parse) {
  try {
    return parse();
  } catch (e) {
    if (!(e instanceof OntologyError) || /** @type {any} */ (e).legacyFormat !== LEGACY_FORMAT) throw e;
    throw new store.StoreError('legacy-ontology', `${name} was written by an earlier build of this page for an ontology in ` +
      'edgextract\'s format, which this page no longer reads; delete it to free its space, or open another store');
  }
}

// ---- jobs -----------------------------------------------------------------------------------------

/** @type {Record<string, (m: any) => Promise<any>>} */
const JOBS = {
  async init() {
    await ensureEngine();
    const syncAccessHandle = typeof FileSystemFileHandle !== 'undefined' &&
      typeof FileSystemFileHandle.prototype.createSyncAccessHandle === 'function';
    return {
      version: RELATE,
      opfs: Boolean(navigator.storage?.getDirectory),
      syncAccessHandle,
      memoryMiB: engineExports.memory.buffer.byteLength >> 20,
    };
  },

  async 'open-store'(m) {
    await ensureEngine();
    /** @type {import('./ontology.js').Ontology | null} */
    let o = null;
    let name;
    if (typeof m.yaml === 'string') {
      o = parseOntology(m.yaml, { bases: m.bases ?? {} });
      name = storeName(o);
    } else if (typeof m.name === 'string') {
      name = m.name;
    } else throw new WorkerError('usage', 'open-store takes {yaml} or {name}');
    if (!STORE_NAME.test(name)) throw new WorkerError('usage', `${JSON.stringify(name)} is not one of this example's store names (ex01-kg-*)`);
    const reused = Boolean(current && real && current.name === name);
    const h = reused ? real : await openWritable(name, { waitMs: m.retryLocked === true ? LOCK_WAIT_MS : 0 });
    const hdb = proxy(h);
    try {
      // A store an earlier build wrote (unprefixed labels) is refused before anything else, even by
      // name (it has no _Ontology), unless the page asked to empty it (discardLegacy).
      try {
        store.refuseLegacyStore(hdb, cl);
      } catch (e) {
        if (!(e instanceof store.StoreError && e.code === 'legacy')) throw e;
        let kept = o;
        if (!kept) {
          // The ontology the earlier build kept, under its unprefixed label: edgextract's YAML then, which
          // this build no longer reads (the store is offered for deletion instead), or none at all.
          const row = cl.exec(hdb, 'MATCH (o:Ontology) WHERE o.yaml IS NOT NULL RETURN o.yaml AS yaml ORDER BY o.id LIMIT 1').rows[0];
          if (row) kept = keptOntology(name, () => parseOntology(row.yaml, { bases: m.bases ?? {} }));
        }
        if (m.discardLegacy !== true) throw e;
        if (!kept) throw new WorkerError('no-ontology', `${name} holds no ontology this page can read: open another one from the ontology picker`);
        o = kept;
        h.reset();
      }
      if (!o) {
        // The stored document, or the YAML an earlier build stored (converted, then replaced by the
        // document when openStore applies it: its sha changes, so it is gated and published again once).
        // A document an earlier build converted from edgextract's YAML opens as any document; a store
        // that kept edgextract's YAML itself is refused (legacy-ontology), and the page offers to delete it.
        const row = readOntology(hdb, cl);
        if (!row || (typeof row.doc !== 'string' && typeof row.yaml !== 'string')) {
          throw new WorkerError('no-ontology', `${name} holds no ontology (it is empty, or was reset): open it from the ontology picker`);
        }
        o = keptOntology(name, () => ontologyFromStored(row));
      }
      if (!modelInfo && typeof m.model === 'string' && ['small', 'base'].includes(m.model)) defaultsModel = m.model;
      const applied = store.openStore(hdb, cl, o, m.cutoffs ?? {}, { model: defaultsModel });
      if (!reused) {
        if (real) { try { real.free(); } catch { /* already gone */ } }
        real = h;
      }
      current = { name, ontology: o };
      // A changed ontology changes legality (D10 rule 4) and the kinds, and moved default cutoffs (another
      // model, or a build with other defaults) change the bands: gate and publish again.
      let regated = null;
      const ontologyChanged = applied.ontology.previousSha !== null && applied.ontology.previousSha !== o.sha;
      const changed = ontologyChanged || applied.ontology.cutoffs.moved > 0;
      // Mentions, not claims: a store of names with no claim between them is banded by these cutoffs too.
      if (changed && Number(q('MATCH (x:_Mention) RETURN count(x) AS n')[0]?.n ?? 0) > 0) regated = regateAndPublish(m.gate);
      return { ...describe(applied), regated, regatedBecause: regated ? (ontologyChanged ? 'ontology' : 'cutoffs') : null };
    } catch (e) {
      if (!reused) { try { h.free(); } catch { /* ignore */ } }
      throw e;
    }
  },

  async 'delete-store'(m) {
    await ensureEngine();
    const name = String(m.name ?? '');
    if (!STORE_NAME.test(name)) throw new WorkerError('usage', `${JSON.stringify(name)} is not one of this example's store names (ex01-kg-*)`);
    if (current && current.name === name) {
      if (real) { try { real.free(); } catch { /* already gone */ } }
      real = null;
      current = null;
    }
    // A writable open first: another tab holding the store refuses it (storage locked), and nothing is removed.
    const h = await openWritable(name, { waitMs: LOCK_WAIT_MS });
    h.free();
    return { deleted: (await opfs.removeStore(name)) ? name : null };
  },

  async close() {
    const name = current?.name ?? null;
    if (real) real.free();
    real = null;
    current = null;
    return { closed: name };
  },

  async 'load-model'(m) {
    const t0 = performance.now();
    const f = m.files ?? {};
    for (const k of ['weights', 'tokenizer', 'config', 'encoderConfig']) {
      if (!(f[k] instanceof ArrayBuffer)) throw new WorkerError('usage', `load-model: files.${k} must be an ArrayBuffer`);
    }
    const info = m.info ?? {};
    for (const k of ['repo', 'rev', 'weights']) if (typeof info[k] !== 'string' || !info[k]) throw new WorkerError('usage', `load-model: info.${k} is missing`);
    if (!glinerGlue) glinerGlue = await import(new URL(GLINER_GLUE, ASSETS).href);
    if (!glinerModule) {
      const res = await fetch(new URL(GLINER_WASM, ASSETS));
      if (!res.ok) throw new WorkerError('assets', `gliner-rs: ${res.status} for ${GLINER_WASM}`);
      glinerModule = await WebAssembly.compile(await res.arrayBuffer());
    }
    if (model) {
      freeModel(model);
      model = null;
      modelInfo = null;
    }
    model = loadModel({ glue: glinerGlue, wasmBytes: glinerModule, weights: f.weights, tokenizer: f.tokenizer, config: f.config, encoderConfig: f.encoderConfig });
    modelInfo = { repo: info.repo, rev: info.rev, weights: info.weights, build: pipeline.BUILD };
    modelWhich = String(m.which ?? '');
    // The open store's default cutoffs follow the loaded model; cutoffs the user moved stay.
    if (['small', 'base'].includes(modelWhich)) defaultsModel = modelWhich;
    let defaults = null;
    let regated = null;
    if (current && real) {
      const moved = store.applyDefaultCutoffs(db, cl, current.ontology.format, defaultsModel);
      defaults = store.defaultGate(current.ontology.format, defaultsModel);
      if (moved.moved > 0 && Number(q('MATCH (x:_Mention) RETURN count(x) AS n')[0]?.n ?? 0) > 0) regated = regateAndPublish(m.gate);
    }
    return { which: modelWhich, memoryMiB: memoryBytes(model) >> 20, ms: Math.round(performance.now() - t0), info: modelInfo, defaults, regated };
  },

  async plan(m) {
    const c = needStore();
    if (typeof m.text !== 'string') throw new WorkerError('usage', 'plan: text');
    const info = modelInfo ?? (m.info ? { ...m.info, build: pipeline.BUILD } : null);
    if (!info) throw new WorkerError('no-model', 'plan: no model chosen');
    const sentences = splitSentences(m.text);
    const sections = pipeline.planSections(sentences);
    const doc = replay.sha256(m.text);
    const done = store.completeSections(db, cl, doc);
    const { schema } = pipeline.modelSchema(c.ontology);
    const pending = [];
    sections.forEach(([a, b], n) => {
      if (!done.has(`${doc}#s${n}`)) pending.push(...sentences.slice(a, b));
    });
    const keys = [...new Set(pending.map((s) => store.cacheKey({ model: info, schema, floor: pipeline.FLOOR, text: s.text })))];
    const cached = keys.length ? Number(q(`UNWIND $keys AS k
WITH k WHERE k IS NOT NULL
MATCH (i:_Inference {key: k}) WHERE i.parts IS NOT NULL
RETURN count(i) AS n`, { keys })[0]?.n ?? 0) : 0;
    return {
      doc, sentences: sentences.length, sections: sections.length, complete: done.size,
      pending: pending.length, needInference: keys.length - cached, cached,
    };
  },

  async extract(m) {
    const c = needStore();
    const mh = needModel();
    if (typeof m.text !== 'string' || !m.text.trim()) throw new WorkerError('usage', 'extract: an empty document');
    const title = typeof m.title === 'string' && m.title.trim() ? m.title.trim() : 'untitled';
    stopRequested = false;
    const t0 = performance.now();
    // The page's progress line counts the model calls (a sentence the inference cache does not hold):
    // the handle pipeline.run gets announces each call before making it. Nothing else changes.
    let asked = 0;
    const counted = { ...mh, model: { extractCli: (/** @type {any[]} */ ...a) => {
      post({ event: 'inference', job: m.id, n: ++asked });
      return mh.model.extractCli(...a);
    } } };
    const r = await pipeline.run({
      db, cl, model: /** @type {any} */ (counted), modelInfo: /** @type {store.ModelInfo} */ (modelInfo), ontology: c.ontology, text: m.text, title,
      gate: gateOpts(m.gate),
      onSection: async ({ section, sections, counters }) => {
        post({ event: 'section', job: m.id, section, sections, counters });
        // A section runs synchronously and awaiting resolves through microtasks only, so without a
        // macrotask turn here the worker never reads `stop` or `lend` until the whole document is done.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (pendingLend) {
          const lend = pendingLend;
          pendingLend = null;
          lend.honoured = true;
          await doLend(lend);
        }
        return stopRequested ? 'stop' : undefined;
      },
    });
    extractions++;
    // No recycling here: freeing and reopening the handle returns no memory (R13). After enough
    // extractions the page checkpoints the store (close: free()), then ends this worker (app.js recycleEngine).
    return {
      counters: r.counters,
      gate: r.gate ? summarize(r.gate, r.counters.doc) : null,
      published: r.published,
      ms: Math.round(performance.now() - t0),
      extractions,
    };
  },

  async regate(m) {
    needStore();
    return regateAndPublish(m.gate);
  },

  async publish() {
    needStore();
    return { published: store.publish(db, cl) };
  },

  async verdict(m) {
    needStore();
    const verdict = store.addVerdict(db, cl, { target: m.target, value: m.value });
    return { verdict, ...regateAndPublish(m.gate) };
  },

  async cutoffs(m) {
    needStore();
    store.setCutoffs(db, cl, { what: m.what, id: m.name, keep: Number(m.keep), drop: Number(m.drop) });
    const out = regateAndPublish(m.gate);
    const cut = Math.min(Number(m.keep), Number(m.drop));
    const below = cut < pipeline.FLOOR
      ? Number(q(`MATCH (s:_Sentence)-[:_INFERRED]->(i:_Inference) WHERE $cut IS NOT NULL AND i.floor > toFloat($cut)
RETURN count(DISTINCT s) AS n`, { cut })[0]?.n ?? 0)
      : 0;
    return { ...out, belowFloor: { cut, floor: pipeline.FLOOR, sentences: below } };
  },

  async 'reset-cutoffs'(m) {
    const c = needStore();
    store.resetCutoffs(db, cl, c.ontology.format, defaultsModel);
    return { ...regateAndPublish(m.gate), defaults: store.defaultGate(c.ontology.format, defaultsModel) };
  },

  async forget(m) {
    needStore();
    if (typeof m.doc !== 'string' || !m.doc) throw new WorkerError('usage', 'forget: doc');
    const deleted = store.forgetDocument(db, cl, m.doc);
    return { deleted, ...regateAndPublish(m.gate) };
  },

  async rebuild(m) {
    const c = needStore();
    const o = parseOntology(String(m.yaml ?? ''), { bases: m.bases ?? {} });
    if (o.id !== c.ontology.id) throw new WorkerError('usage', `rebuild keeps the store's ontology id ${c.ontology.id}; ${o.id} has its own store`);
    q('MATCH (e:_Entity) DETACH DELETE e');
    const applied = store.openStore(db, cl, o, {}, { model: defaultsModel });
    current = { name: c.name, ontology: o };
    regateAndPublish(m.gate);
    return describe(applied);
  },

  async dump() {
    const c = needStore();
    return { text: store.dumpStore(db), fileName: `${c.name}.dump.json` };
  },

  async download() {
    const c = needStore();
    // R12: no export call and no callable db.checkpoint; free() checkpoints, then the files are read (X1).
    // While the store is free another tab may open it (R11: nothing but the engine's own handles keeps it
    // here). So the read is trusted only when this worker gets the store back and its content digest is
    // the one it had before the free; otherwise the download is discarded and the error says why.
    const before = replay.contentDigest(db);
    real.free();
    real = null;
    /** @type {Awaited<ReturnType<typeof exportTar>> | null} */
    let r = null;
    let readError = null;
    try {
      r = await exportTar(c.name);
    } catch (e) {
      readError = e;
    }
    try {
      real = await openWritable(c.name, { waitMs: LOCK_WAIT_MS });
    } catch (e) {
      // Another tab holds it now: this tab no longer has a store open (needStore says so to every later
      // job), and the page shows the lock banner with its handover.
      current = null;
      const why = e instanceof Error ? e.message.split('\n')[0] : String(e);
      throw new WorkerError('locked', `Another tab or window of this site opened ${c.name} while this tab was reading it for the download, ` +
        `so the download was discarded (it may not be a consistent snapshot) and this tab no longer holds the store (${why}); ` +
        'download it from the tab that holds it, or move it back here', { name: c.name, released: true });
    }
    if (readError) throw readError;
    if (replay.contentDigest(db) !== before) {
      throw new WorkerError('error', `${c.name} changed while it was read for the download (another tab wrote to it), so the download ` +
        'was discarded; download it again');
    }
    const done = /** @type {NonNullable<typeof r>} */ (r);
    return { bytes: done.bytes, fileName: done.fileName, summary: done.summary, [TRANSFER]: [done.bytes.buffer] };
  },

  async restore(m) {
    await ensureEngine();
    if (!(m.bytes instanceof ArrayBuffer)) throw new WorkerError('usage', 'restore: bytes (an ArrayBuffer)');
    const fileName = String(m.fileName ?? 'upload.tar');
    const input = parseRestoreTar(new Uint8Array(m.bytes), fileName);
    const taken = (await opfs.listStores('')).map((s) => s.name);
    const name = restoreName(fileName, taken);
    await opfs.writeStore(name, input.tree);
    /** @type {any} */
    let ro = null;
    let failed = true;
    try {
      try {
        // A snapshot (graph.json and manifest.json, no WAL: the page's download, X4's tar) is adopted
        // by one writable open, as natively, before a read-only open can take it (R22): open it
        // writable and free it at once (free() checkpoints), then check it read-only.
        if (![...input.tree.keys()].some((p) => p.startsWith('wal/'))) (await mod.RelateDb.open(`opfs://${name}`)).free();
        ro = await mod.RelateDb.open(`opfs://${name}`, true);
      } catch (e) {
        // The guard checks the files' framing (X5), not every byte: a snapshot that passes it and
        // still fails to open is not Relate 1.3.0's, or is damaged. The leftover store goes (finally).
        const text = e instanceof Error ? e.message : String(e);
        if (LOCKED.test(text) || cl.isTrap(e)) throw e;
        throw new WorkerError('format', `${fileName} passed the format check, but Relate ${RELATE} could not open it ` +
          `(${text.split('\n')[0]}): this store was written by a Relate other than ${RELATE}, or is damaged (X5)`, { detail: text });
      }
      const rdb = proxy(ro);
      // A store an earlier build of this example wrote (unprefixed labels): listed, and opening it
      // offers to empty it (the earlier-build banner); this build cannot read its data.
      let legacy = false;
      try {
        store.refuseLegacyStore(rdb, cl);
      } catch (e) {
        if (!(e instanceof store.StoreError && e.code === 'legacy')) throw e;
        legacy = true;
      }
      const onto = legacy ? null : readOntology(rdb, cl);
      const counts = store.counts(rdb, cl);
      const spec = currentGraphType(rdb, cl);
      const digest = replay.contentDigest(rdb);
      let compare = null;
      if (current && real && onto && onto.id === current.ontology.id) {
        const mine = { counts: store.counts(db, cl), spec: currentGraphType(db, cl), digest: replay.contentDigest(db) };
        compare = {
          store: current.name,
          counts: JSON.stringify(mine.counts) === JSON.stringify(counts),
          spec: mine.spec === spec,
          digest: mine.digest === digest,
        };
      }
      failed = false;
      return {
        name, summary: input.summary, counts, spec, digest, compare, legacy,
        ontology: onto ? { id: onto.id, title: onto.title, sha: onto.sha } : null,
      };
    } finally {
      if (ro) { try { ro.free(); } catch { /* ignore */ } }
      if (failed) await opfs.removeStore(name).catch(() => {});
    }
  },

  async reset() {
    const c = needStore();
    real.reset();
    const applied = store.openStore(db, cl, c.ontology, {}, { model: defaultsModel });
    return describe(applied);
  },

  async stats() {
    return stats();
  },

  async graph(m) {
    const c = needStore();
    const doc = typeof m.doc === 'string' && m.doc ? m.doc : null;
    const titles = new Map(q('MATCH (d:_Document) RETURN d.id AS id, d.title AS title').map((r) => [r.id, r.title]));
    const named = (/** @type {string[]} */ ids) => (ids ?? []).map((d) => titles.get(d) ?? d);
    const rels = q(`MATCH (a:_Entity)-[r]->(b:_Entity) WHERE $doc IS NULL OR $doc IN r.docs
RETURN a.key AS a, type(r) AS type, b.key AS b, r.p AS p, size(r.claims) AS claims, r.docs AS docs
ORDER BY a, type, b`, { doc });
    const ends = new Set(rels.flatMap((r) => [r.a, r.b]));
    const ents = q(`MATCH (e:_Entity) WHERE e.kind IS NOT NULL
RETURN e.key AS key, e.kind AS kind, e.name AS name, e.display AS display, e.docs AS docs, e.mentions AS mentions
ORDER BY key`).filter((e) => !doc || (e.docs ?? []).includes(doc) || ends.has(e.key));
    const nodes = ents.map((e) => ({ id: e.key, labels: ['_Entity', e.kind], properties: { name: e.name, key: e.key, kind: e.kind, docs: named(e.docs), mentions: e.mentions } }));
    const edges = rels.map((r) => ({ id: `${r.a}|${r.type}|${r.b}`, type: r.type, start_node: r.a, end_node: r.b, properties: { p: r.p, claims: r.claims, docs: named(r.docs) } }));
    return {
      nodes,
      rels: edges,
      candidates: m.candidates === true ? reviewCandidates(doc, { nodes: new Set(nodes.map((n) => n.id)), rels: new Set(edges.map((r) => r.id)) }) : null,
      labelOrder: c.ontology.types.map((t) => t.id),
      colors: kindColors(c.ontology),
    };
  },

  async review() {
    needStore();
    return reviewItems("c.band = 'review' OR c.rule = 'verdict'", "m.band = 'review' OR m.rule IN ['verdict', 'claim-verdict']", {});
  },

  async details(m) {
    needStore();
    if (m.candidate && typeof m.candidate === 'object') {
      const cnd = m.candidate;
      if (typeof cnd.node === 'string' && cnd.node.includes(':')) {
        const i = cnd.node.indexOf(':');
        const items = reviewItems(null, "m.band = 'review' AND $label IS NOT NULL AND $name IS NOT NULL AND m.label = $label AND m.name = $name",
          { label: cnd.node.slice(0, i), name: cnd.node.slice(i + 1) });
        return { what: 'candidate', title: `${items.mentions[0]?.text ?? cnd.node} (${cnd.node.slice(0, i)}, in review)`, ...items };
      }
      const r = cnd.rel ?? {};
      if (typeof r.a !== 'string' || typeof r.b !== 'string' || typeof r.type !== 'string') throw new WorkerError('usage', 'details: {candidate: {node} | {rel: {a, type, b}}}');
      const items = reviewItems("c.band = 'review' AND $a IS NOT NULL AND $b IS NOT NULL AND $type IS NOT NULL AND c.head = $a AND c.rel = $type AND c.tail = $b", null,
        { a: r.a, b: r.b, type: r.type });
      return { what: 'candidate', title: `${r.a} -[${r.type}]-> ${r.b} (in review)`, ...items };
    }
    const titles = new Map(q('MATCH (d:_Document) RETURN d.id AS id, d.title AS title').map((r) => [r.id, r.title]));
    const named = (/** @type {string[]|null} */ ids) => (ids ?? []).map((d) => titles.get(d) ?? d);
    if (typeof m.node === 'string' && m.node) {
      const e = q(`MATCH (e:_Entity {key: $key}) WHERE $key IS NOT NULL
RETURN e.key AS key, e.kind AS kind, e.name AS name, e.display AS display, e.docs AS docs, e.mentions AS mentions,
       e.generation AS generation`, { key: m.node })[0];
      if (!e) throw new WorkerError('usage', `no entity ${m.node}`);
      const evidence = q(`MATCH (e:_Entity {key: $key}) WHERE $key IS NOT NULL
MATCH (m:_Mention)-[:_OF]->(e)
MATCH (m)-[:_IN]->(s:_Sentence)
OPTIONAL MATCH (d:_Document {id: m.doc})
RETURN d.title AS document, s.idx AS idx, s.text AS sentence, m.text AS text, m.p AS p, m.rule AS rule, m.source AS source,
       m.start - s.start AS start, m.end - s.start AS end
ORDER BY document, idx, start
LIMIT 200`, { key: m.node });
      // D27: the values read from the text for the entity: the kept ones publish wrote (_OF), each with its sentence,
      // and the property as the entity now carries it (the best kept value, typed).
      const values = q(`MATCH (a:_Attribute)-[:_OF]->(e:_Entity {key: $key}) WHERE $key IS NOT NULL
MATCH (a)-[:_IN]->(s:_Sentence)
OPTIONAL MATCH (d:_Document {id: a.doc})
RETURN a.prop AS prop, a.text AS text, a.p AS p, a.via AS via, toString(properties(e)[a.prop]) AS stored, toString(a.value) AS value,
       d.title AS document, s.idx AS idx, s.text AS sentence, a.start - s.start AS start, a.end - s.start AS end
ORDER BY prop, p DESC, document, idx`, { key: m.node });
      return {
        what: 'node', title: `${e.name} (${e.kind})`, properties: { ...e, docs: named(e.docs) },
        evidence: evidence.map((x) => ({ ...x, spans: [[x.start, x.end]] })),
        values: values.map((x) => ({ ...x, spans: [[x.start, x.end]] })),
      };
    }
    const r = m.rel ?? {};
    if (typeof r.a !== 'string' || typeof r.b !== 'string' || typeof r.type !== 'string') throw new WorkerError('usage', 'details: {node} or {rel: {a, type, b}}');
    const rel = q(`MATCH (a:_Entity {key: $a})-[r]->(b:_Entity {key: $b})
WHERE $a IS NOT NULL AND $b IS NOT NULL AND $type IS NOT NULL AND type(r) = $type
RETURN r.p AS p, r.claims AS claims, r.docs AS docs, r.generation AS generation`, { a: r.a, b: r.b, type: r.type })[0];
    if (!rel) throw new WorkerError('usage', `no ${r.a} -[${r.type}]-> ${r.b}`);
    const evidence = q(`UNWIND $claims AS k
WITH k WHERE k IS NOT NULL
MATCH (c:_Claim {key: k})-[:_EVIDENCE]->(s:_Sentence)
OPTIONAL MATCH (d:_Document {id: c.doc})
RETURN d.title AS document, s.idx AS idx, s.text AS sentence, c.htext AS head, c.ttext AS tail, c.p AS p, c.band AS band, c.rule AS rule,
       c.hs - s.start AS hs, c.he - s.start AS he, c.ts - s.start AS ts, c.te - s.start AS te
ORDER BY document, idx, p DESC`, { claims: rel.claims ?? [] });
    return {
      what: 'rel', title: `${r.a} -[${r.type}]-> ${r.b}`, properties: { ...rel, docs: named(rel.docs), type: r.type, head: r.a, tail: r.b },
      evidence: evidence.map((x) => ({ ...x, spans: [[x.hs, x.he], [x.ts, x.te]] })),
    };
  },

  async digest() {
    needStore();
    return { digest: replay.contentDigest(db) };
  },
};

const TRANSFER = Symbol('transfer');

// ---- the console lease (D11) ----------------------------------------------------------------------

/** Free the store for the console and wait for reclaim; reopen then. @param {any} m the lend message */
async function doLend(m) {
  if (!current || !real) {
    post({ id: m.id, ok: false, error: { code: 'no-store', message: 'no store is open to lend' } });
    return;
  }
  const name = current.name;
  real.free();
  real = null;
  /** @type {(r: any) => void} */
  let release = () => {};
  const reclaimed = new Promise((resolve) => { release = resolve; });
  lendState = { release, name };
  post({ id: m.id, ok: true, data: { name, uri: `opfs://${name}` } });
  const r = await reclaimed;
  try {
    // A console worker the page ended mid-query (the watchdog) holds the store about 2 s more (R11).
    real = await openWritable(name, { waitMs: LOCK_WAIT_MS });
    post({ id: r.id, ok: true, data: { name, reopened: true } });
  } catch (e) {
    post({ id: r.id, ok: false, error: serialize(e) });
  } finally {
    lendState = null;
  }
}

// ---- dispatch -------------------------------------------------------------------------------------

/** @param {unknown} e */
function serialize(e) {
  const message = e instanceof Error ? e.message : String(e);
  if (cl.isTrap(e)) {
    return { code: 'trap', message: `The engine crashed (${message.split('\n')[0]}). The page restarts it; everything committed is kept (R24).` };
  }
  if (e instanceof WorkerError) return { ...e, code: e.code, message };
  if (e instanceof cl.RelateWasmError) {
    return { code: e.category === 'locked' ? 'locked' : 'engine', category: e.category, message, detail: e.detail };
  }
  if (e instanceof OntologyError) return { code: 'ontology', message };
  if (e instanceof OntologyApplyError) return { code: e.code === 'blocked' ? 'blocked' : 'ontology-apply', reason: e.code, message, detail: e.detail };
  if (e instanceof store.StoreError) return { code: 'store', reason: e.code, message };
  if (e instanceof opfs.FormatError || (e instanceof Error && e.name === 'TarError')) return { code: 'format', message };
  if (LOCKED.test(message)) return { code: 'locked', message };
  if (e instanceof replay.EngineError) return { code: 'engine', category: cl.classify(message), message: message.split('\n')[0], detail: message };
  return { code: 'error', message };
}

/** @type {any[]} */
const queue = [];
let pumping = false;

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) await run(queue.shift());
  } finally {
    pumping = false;
  }
}

/** @param {any} m */
async function run(m) {
  if (m.kind === 'lend') {
    pendingLend = null;
    if (!m.honoured) await doLend(m);
    return;
  }
  if (crashed) return post({ id: m.id, ok: false, error: crashed });
  const job = JOBS[m.kind];
  if (!job) return post({ id: m.id, ok: false, error: { code: 'usage', message: `unknown kind ${JSON.stringify(m.kind)}` } });
  running = m.kind;
  try {
    const data = await job(m);
    const transfer = data?.[TRANSFER] ?? [];
    if (data && TRANSFER in data) delete data[TRANSFER];
    post({ id: m.id, ok: true, data }, transfer);
  } catch (e) {
    const error = serialize(e);
    if (error.code === 'trap') crashed = error;
    post({ id: m.id, ok: false, error });
  } finally {
    running = null;
  }
}

self.onmessage = (/** @type {MessageEvent} */ ev) => {
  const m = ev.data ?? {};
  if (m.kind === 'stop') {
    stopRequested = true;
    post({ id: m.id, ok: true, data: { stopping: running === 'extract' } });
    return;
  }
  if (m.kind === 'reclaim') {
    if (lendState) lendState.release(m);
    else post({ id: m.id, ok: true, data: { name: current?.name ?? null, reopened: false } });
    return;
  }
  if (m.kind === 'lend') {
    if (lendState || pendingLend) {
      post({ id: m.id, ok: false, error: { code: 'lent', message: 'the store is already lent' } });
      return;
    }
    if (crashed) {
      post({ id: m.id, ok: false, error: crashed });
      return;
    }
    if (running === 'extract') pendingLend = m; // honoured between sections (D11)
    queue.unshift(m); // ahead of queued work: extractions, verdicts and cutoffs queue behind the lease
    pump();
    return;
  }
  queue.push(m);
  pump();
};
