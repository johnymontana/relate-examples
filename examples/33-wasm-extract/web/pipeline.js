// @ts-check
/**
 * pipeline.js: one document through the model into the store (NOTES.md D7, D9, D10,
 * D16).
 *
 *   markdown -> split.js sentences -> sections of about SECTION_CHARS -> per sentence: the inference
 *   cache (D7) or gliner-rs extractCli at FLOOR -> mentions (model and gazetteer) and claims, offsets
 *   in code points -> store.writeSection (D9) -> await onSection (the page's stop and lend point)
 *   -> store.gate (D10) -> store.publish (D16)
 *
 * Shared by the engine worker and the Node harness; synchronous inside a section, async between
 * sections. It imports no host API: the caller hands in the Relate handle and module (`db`,
 * `cl`, as store.js takes them) and a loaded gliner.js model.
 *
 *   const r = await extractDocument({db, cl, model, modelInfo, ontology, text, title,
 *                                    onSection: async (p) => (stopRequested ? 'stop' : undefined)});
 *   // r: {doc, status: 'done'|'stopped', sentences, sections, written, skipped, inferences, hits}
 *   store.gate(db, cl); store.publish(db, cl);       // or run(): extract, gate, publish in one call
 *
 * Stop and resume (D9): returning 'stop' from onSection ends the run after the section just
 * committed. There is no transaction to roll a section back (NOTES.md R2), so a section's writes are
 * idempotent MERGEs and its `complete` flag is written last. A section that was cut short (a killed worker, a throw in onStep) has
 * complete = false and is re-applied, as no-ops plus whatever was missing, when the same text is
 * extracted again; complete sections are skipped unless {skipComplete: false}.
 *
 * What the model is asked (modelSchema; ontology.js derives each kind's and link's `ask`): for a
 * create-context-graph document, each kind's label as text ("maintenance record") with
 * "<subtype> in <domain>" for a domain kind, the base kinds bare, a base kind no link names and a
 * domain kind covers not at all, and each link as its phrase between its endpoints ("transaction
 * transferred to account"), decided on the 27 samples (experiment B; README "What the model is
 * asked"); for any other v1 document, each kind's label as text with the node's own description,
 * and each link the same way. The model answers in those labels and names; kindOf and relOf map them back to kind and
 * link ids before anything is stored, so mention keys and labels are always the ontology's ids. All
 * at the cache's floor of 0.10: every candidate above it is stored, so moving a cutoff at or above
 * it never calls the model again (D7).
 */
import { extractRaw, normalize, relationPhrase, utf16Index } from './gliner.js';
import { mentionName, PRONOUNS } from './names.js';
import { splitSentences, utf8Length } from './split.js';
import * as store from './store.js';
import { sha256 } from '../../../lib/replay.mjs';

/** Every candidate scoring at least this is cached and stored (D7). */
export const FLOOR = 0.1;
/** Sections of about this many UTF-8 bytes (edgextract's plan_sections; its default, 3,000). */
export const SECTION_CHARS = 3000;
/** The gliner-rs build every cache key names (D4, D7). */
export const BUILD = 'gliner-rs@4fa741e';
/** names.js's pronoun list and mention names, here as before. */
export { PRONOUNS, mentionName };

/**
 * edgextract's plan_sections (rust/edgextract/src/pipeline.rs:260 at 3f08b1d): group sentences into
 * sections of about `target` UTF-8 bytes, closing one early where a new heading path begins once
 * it is half full.
 * @param {Array<{text: string, heading: string[]}>} sentences
 * @param {number} target
 * @returns {Array<[number, number]>} [start, end) sentence indexes
 */
export function planSections(sentences, target = SECTION_CHARS) {
  const t = Math.max(1, target);
  const out = [];
  let start = 0;
  let size = 0;
  for (let i = 0; i < sentences.length; i++) {
    const newHeading = i > start && sentences[i].heading.join('\u0000') !== sentences[i - 1].heading.join('\u0000');
    if (size > 0 && (size >= t || (newHeading && size * 2 >= t))) {
      out.push([start, i]);
      start = i;
      size = 0;
    }
    size += utf8Length(sentences[i].text);
  }
  if (start < sentences.length) out.push([start, sentences.length]);
  return /** @type {Array<[number, number]>} */ (out);
}

/**
 * How the harness may ask instead, for its comparisons (the page always asks 'ontology'):
 *   'ontology'  each kind's and link's `ask` (ontology.js), what the page asks;
 *   'ids'       every kind by its id with its description and every link as its phrase: what this
 *               example asked of every ontology before experiment B (score.txt compares the two on
 *               create-context-graph's samples).
 */
export const ASKED = Object.freeze(['ontology', 'ids']);

/**
 * The model's schema for an ontology (gliner.js Schema) at the floor: the kinds it is asked about,
 * each as its `ask` (label and description), and every link as its `ask`. Also the maps back from
 * what the model returns to the ontology's ids:
 * kindOf (model label -> kind id) and relOf (relation name -> link id).
 * @param {import('./ontology.js').Ontology} o
 * @param {{threshold?: number, asked?: 'ontology'|'ids'}} [opts]
 * @returns {{schema: import('./gliner.js').Schema, kindOf: Map<string, string>, relOf: Map<string, string>}}
 */
export function modelSchema(o, { threshold = FLOOR, asked = 'ontology' } = {}) {
  if (!ASKED.includes(asked)) throw new RangeError(`modelSchema: asked is one of ${ASKED.join(', ')}, not ${JSON.stringify(asked)}`);
  /** @type {(t: import('./ontology.js').Kind) => import('./ontology.js').KindAsk|null} */
  const askOf = (t) => {
    if (asked === 'ids') return { label: t.id, description: t.description };
    if (t.ask === undefined) throw new TypeError(`modelSchema: the kind ${t.id} has no ask (parse the ontology with ontology.js parseOntology)`);
    return t.ask;
  };
  const kinds = o.types.map((t) => ({ id: t.id, ask: askOf(t) })).filter((t) => t.ask !== null);
  const relations = o.relations.map((r) => (asked === 'ids' ? relationPhrase(r.id) : r.ask ?? relationPhrase(r.id)));
  return {
    schema: {
      entities: kinds.map((t) => ({ id: /** @type {any} */ (t.ask).label, description: /** @type {any} */ (t.ask).description })),
      relations,
      threshold,
    },
    kindOf: new Map(kinds.map((t) => [/** @type {any} */ (t.ask).label, t.id])),
    relOf: new Map(relations.map((a, i) => [a, o.relations[i].id])),
  };
}

/** Rust's char::is_alphanumeric. */
const ALNUM = /[\p{Alphabetic}\p{N}]/u;

/**
 * edgextract's GazetteerProposer (candidates.rs:48 at 3f08b1d): listed names found in a sentence,
 * case-insensitively, longest first, at token boundaries, never overlapping; then, as edgextract's
 * typing step does (ontology.rs gazetteer_type), only an occurrence spelt exactly as listed is a
 * p = 1.0 mention of the listed kind ("acme inc" is left to the model). Offsets are code points
 * into the sentence.
 * @param {string} text  the sentence
 * @param {Array<[string, string]>} names  ontology.names: [name, kind] in document order
 * @returns {Array<{start: number, end: number, text: string, label: string}>}
 */
export function gazetteerMentions(text, names) {
  const cps = Array.from(text);
  const lower = cps.map((c) => c.toLowerCase());
  const ordered = names.map(([name, kind], i) => ({ name, kind, i, len: utf8Length(name) }))
    .sort((a, b) => b.len - a.len || a.i - b.i);
  /** @type {Array<[number, number]>} */
  const occupied = [];
  const out = [];
  for (const { name, kind } of ordered) {
    const needle = Array.from(name).map((c) => c.toLowerCase());
    if (!needle.length) continue;
    for (let i = 0; i + needle.length <= cps.length; i++) {
      let hit = true;
      for (let k = 0; k < needle.length && hit; k++) hit = lower[i + k] === needle[k];
      if (!hit) continue;
      const j = i + needle.length;
      if (occupied.some(([a, b]) => !(j <= a || i >= b))) continue;
      const leftOk = i === 0 || !ALNUM.test(cps[i - 1]);
      const rightOk = j >= cps.length || !ALNUM.test(cps[j]);
      if (!leftOk || !rightOk) continue;
      occupied.push([i, j]);
      const surface = cps.slice(i, j).join('');
      if (surface === name) out.push({ start: i, end: j, text: surface, label: kind });
      i = j - 1;
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** store.kindWordsOf: each kind's label words, for its mentions' names. */
export const kindWordsOf = store.kindWordsOf;

/**
 * @typedef {{status: 'done'|'stopped', doc: string, run: string, sentences: number, sections: number,
 *   written: number, skipped: number, inferences: number, hits: number, offsetMismatches: number}} Counters
 */

/**
 * Extract one document into the store: the trace and the inference cache (D7, D9). It does not
 * gate or publish; run() does all three.
 * @param {{db: object, cl: typeof import('../../../lib/relate_wasm.mjs'), model: import('./gliner.js').ModelHandle,
 *   modelInfo: store.ModelInfo, ontology: import('./ontology.js').Ontology, text: string, title: string,
 *   onSection?: (p: {section: number, sections: number, counters: Counters}) => (void|'stop'|Promise<void|'stop'>),
 *   onStep?: (step: string, section: number) => void, sectionChars?: number, skipComplete?: boolean,
 *   asked?: 'ontology'|'ids'}} job
 * @returns {Promise<Counters>}
 */
export async function extractDocument(job) {
  const { db, cl, model, modelInfo, ontology, text, title } = job;
  const { onSection, onStep, sectionChars = SECTION_CHARS, skipComplete = true, asked = 'ontology' } = job;
  const sentences = splitSentences(text);
  const sections = planSections(sentences, sectionChars);
  const doc = sha256(text);
  const { schema, kindOf, relOf } = modelSchema(ontology, { asked });
  const words = kindWordsOf(ontology);
  store.writeDocument(db, cl, { id: doc, title, chars: Array.from(text).length });
  const run = store.startRun(db, cl, { doc, model: modelInfo, floor: FLOOR, sections: sections.length, sentences: sentences.length });
  const done = store.completeSections(db, cl, doc);
  /** @type {Counters} */
  const c = { status: 'done', doc, run, sentences: sentences.length, sections: sections.length, written: 0, skipped: 0, inferences: 0, hits: 0, offsetMismatches: 0 };
  const schemaText = JSON.stringify(schema);
  try {
    for (const [n, [a, b]] of sections.entries()) {
      const key = `${doc}#s${n}`;
      if (skipComplete && done.has(key)) {
        c.skipped++;
        continue;
      }
      const w = { doc, run, section: { key, n }, sentences: [], parts: [], inferences: [], inferred: [], mentions: [], claims: [] };
      /** @type {Map<string, string>} inferences made in this section, before they are written */
      const fresh = new Map();
      for (const s of sentences.slice(a, b)) {
        const skey = `${doc}#${s.idx}`;
        w.sentences.push({ key: skey, idx: s.idx, doc, start: s.start, end: s.end, text: s.text, heading: s.heading });
        const ckey = store.cacheKey({ model: modelInfo, schema, floor: FLOOR, text: s.text });
        let raw = fresh.get(ckey) ?? store.readInference(db, cl, ckey);
        if (raw === null) {
          raw = extractRaw(model, s.text, schema);
          c.inferences++;
          fresh.set(ckey, raw);
          const parts = store.splitParts(raw);
          w.inferences.push({ key: ckey, model: modelInfo.repo, rev: modelInfo.rev, weights: modelInfo.weights, build: modelInfo.build, floor: FLOOR, schema: schemaText, parts: parts.length });
          parts.forEach((t, i) => w.parts.push({ key: `${ckey}#${i}`, inference: ckey, n: i, text: t }));
        } else {
          c.hits++;
        }
        w.inferred.push({ sentence: skey, inference: ckey });
        const out = normalize(raw, schema);
        const slice = (x, y) => s.text.slice(utf16Index(s.text, x), utf16Index(s.text, y));
        const mentions = new Map();
        for (const e of out.entities) {
          const label = kindOf.get(e.label);
          if (!label) throw new Error(`pipeline: the model returned the label ${JSON.stringify(e.label)}, which was not asked`);
          const surface = slice(e.start, e.end);
          if (surface !== e.text) c.offsetMismatches++;
          const mkey = `${skey}|m|${label}|${s.start + e.start}-${s.start + e.end}`;
          mentions.set(mkey, { key: mkey, sentence: skey, doc, start: s.start + e.start, end: s.start + e.end, text: surface, label, name: mentionName(surface, words.get(label)), plain: mentionName(surface), p: e.score, source: 'model' });
        }
        for (const g of gazetteerMentions(s.text, ontology.names)) {
          const mkey = `${skey}|g|${g.label}|${s.start + g.start}-${s.start + g.end}`;
          mentions.set(mkey, { key: mkey, sentence: skey, doc, start: s.start + g.start, end: s.start + g.end, text: g.text, label: g.label, name: mentionName(g.text, words.get(g.label)), plain: mentionName(g.text), p: 1, source: 'gazetteer' });
        }
        w.mentions.push(...mentions.values());
        const claims = new Map();
        for (const r of out.relations) {
          const rel = relOf.get(r.relation);
          if (!rel) throw new Error(`pipeline: the model returned the relation ${JSON.stringify(r.relation)}, which was not asked`);
          const [hs, he, ts, te] = [r.head.start, r.head.end, r.tail.start, r.tail.end].map((x) => s.start + x);
          const ck = `${skey}|c|${rel}|${hs}-${he}|${ts}-${te}`;
          const prev = claims.get(ck);
          if (prev && prev.p >= r.score) continue;
          const htext = slice(r.head.start, r.head.end);
          const ttext = slice(r.tail.start, r.tail.end);
          claims.set(ck, { key: ck, sentence: skey, doc, rel, p: r.score, hs, he, ts, te, htext, ttext,
            hkeys: store.claimEndKeys(htext, words), tkeys: store.claimEndKeys(ttext, words) });
        }
        w.claims.push(...claims.values());
      }
      store.writeSection(db, cl, w, onStep ? (step) => onStep(step, n) : undefined);
      c.written++;
      store.updateRun(db, cl, run, { read: c.written + c.skipped, inferences: c.inferences, hits: c.hits, status: 'running' });
      const r = await onSection?.({ section: n, sections: sections.length, counters: { ...c } });
      if (r === 'stop' && n < sections.length - 1) {
        c.status = 'stopped';
        break;
      }
    }
  } catch (e) {
    try { store.updateRun(db, cl, run, { read: c.written + c.skipped, inferences: c.inferences, hits: c.hits, status: 'failed' }); } catch { /* the store may be gone */ }
    throw e;
  }
  store.updateRun(db, cl, run, { read: c.written + c.skipped, inferences: c.inferences, hits: c.hits, status: c.status });
  return c;
}

/**
 * Extract, gate and publish one document (section 4, "One extraction"); the gate and the
 * publish run only when the extraction finished.
 * @param {Parameters<typeof extractDocument>[0] & {gate?: Parameters<typeof store.gate>[2]}} job
 */
export async function run(job) {
  const counters = await extractDocument(job);
  if (counters.status !== 'done') return { counters, gate: null, published: null };
  const g = store.gate(job.db, job.cl, job.gate);
  const published = store.publish(job.db, job.cl);
  return { counters, gate: g, published };
}
