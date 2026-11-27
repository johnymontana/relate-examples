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
import { parseValue } from './values.js';
import { firstSentence } from './ontology.js';
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
  // A link the ontology does not ask (ontology.js: ask null) is left out, under both ways of asking.
  const rels = o.relations.filter((r) => r.ask !== null)
    .map((r) => ({ id: r.id, ask: asked === 'ids' ? relationPhrase(r.id) : r.ask ?? relationPhrase(r.id) }));
  const relations = rels.map((r) => r.ask);
  // D27: a kind with extracted properties is a structure named by its label text: the anchor field, named by the
  // label too and described by the kind's ask's first sentence, then one field per property (a choice field for a
  // vocabulary or a BOOLEAN). Not under asked 'ids' (experiment B's schema).
  const structured = asked === 'ids' ? [] : o.types.filter((t) => t.ask && (t.attributes ?? []).length);
  const plain = (/** @type {string|null} */ d) => (d ? firstSentence(d).replace(/[;=|[\]]|::/g, ',').trim() : '');
  const structures = structured.map((t) => ({
    name: /** @type {any} */ (t.ask).label,
    fields: [
      { name: /** @type {any} */ (t.ask).label, ...(plain(/** @type {any} */ (t.ask).description) ? { description: plain(/** @type {any} */ (t.ask).description) } : {}) },
      ...t.attributes.map((a) => ({
        name: a.field,
        ...(a.type === 'BOOLEAN' ? { choices: ['yes', 'no'] } : a.type === 'STRING' && a.oneOf ? { choices: a.oneOf.map(String) } : {}),
        ...(a.ask ? { description: a.ask } : {}),
      })),
    ],
  }));
  return {
    schema: {
      entities: kinds.map((t) => ({ id: /** @type {any} */ (t.ask).label, description: /** @type {any} */ (t.ask).description })),
      relations,
      threshold,
    },
    // D27: the values are a second call of structures alone, so the first call (and its cache key) is the one a
    // document without extracted properties makes: asked together, the structures shift the model's entities and
    // relations (G12).
    valueSchema: structures.length ? { entities: [], relations: [], structures, threshold } : null,
    kindOf: new Map(kinds.map((t) => [/** @type {any} */ (t.ask).label, t.id])),
    relOf: new Map(rels.map((r) => [r.ask, r.id])),
    /** structure name -> {kind, fields: field name -> the property as the kind declares it} */
    structOf: new Map(structured.map((t) => [/** @type {any} */ (t.ask).label, { kind: t.id, anchor: /** @type {any} */ (t.ask).label, fields: new Map(t.attributes.map((a) => [a.field, a])) }])),
  };
}

/** Rust's char::is_alphanumeric. */
const ALNUM = /[\p{Alphabetic}\p{N}]/u;
/** A capital letter or a digit: what a proper name or an identifier holds (D26). */
const CASED = /[\p{Lu}\p{Lt}\p{Nd}]/u;

/**
 * The kinds whose key pattern proposes identifiers (relate-examples propose, D26), as [kind, RegExp]
 * in document order; a pattern JavaScript does not compile is left out (ontology.js keyPropertyOf).
 * @param {import('./ontology.js').Ontology} o
 * @returns {Array<[string, RegExp]>}
 */
export function proposedPatterns(o) {
  return o.types.filter((t) => t.propose && t.keyPattern).map((t) => [t.id, new RegExp(t.keyPattern, 'u')]);
}

/**
 * The identifiers in a sentence that a kind's key pattern matches whole (D26): each whitespace-separated
 * token, trimmed of the punctuation around it, tested against every proposing kind's pattern in document
 * order; the first that matches wins. Offsets are code points into the sentence, as gazetteerMentions'.
 * @param {string} text  the sentence
 * @param {Array<[string, RegExp]>} patterns  proposedPatterns
 * @returns {Array<{start: number, end: number, text: string, label: string}>}
 */
export function patternMentions(text, patterns) {
  if (!patterns.length) return [];
  const cps = Array.from(text);
  const out = [];
  let i = 0;
  while (i < cps.length) {
    while (i < cps.length && /\s/u.test(cps[i])) i++;
    let j = i;
    while (j < cps.length && !/\s/u.test(cps[j])) j++;
    let a = i;
    let b = j;
    while (a < b && /[\p{P}\p{S}]/u.test(cps[a])) a++;
    while (b > a && /[\p{P}\p{S}]/u.test(cps[b - 1])) b--;
    const token = cps.slice(a, b).join('');
    if (token) {
      for (const [label, re] of patterns) {
        const m = re.exec(token);
        if (m && m.index === 0 && m[0].length === token.length) {
          out.push({ start: a, end: b, text: token, label });
          break;
        }
      }
    }
    i = j;
  }
  return out;
}

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

/**
 * D27: whether a sentence could state a value of an extracted property, so the second call (structures) is
 * worth making: it has a digit and a property is a number or a date, or it holds a word of a property's
 * vocabulary (case-insensitive, whole words), or a property is free text. A value the model reads needs a
 * span in the sentence, so a sentence with none of these has no value to give.
 * @param {string} text @param {import('./ontology.js').Ontology} o
 */
export function valueCue(text, o) {
  const attrs = o.types.filter((t) => t.ask).flatMap((t) => t.attributes ?? []);
  if (!attrs.length) return false;
  if (attrs.some((a) => a.parse === 'STRING' && !a.oneOf)) return true;
  if (/\p{Nd}/u.test(text) && attrs.some((a) => ['INTEGER', 'FLOAT', 'DATE', 'STRING-AS-DATE'].includes(a.parse))) return true;
  const words = new Set(text.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter(Boolean));
  const lower = text.toLowerCase();
  return attrs.some((a) => (a.type === 'BOOLEAN' ? ['yes', 'no'] : (a.oneOf ?? []).map((x) => String(x).toLowerCase()))
    .some((v) => (v.includes(' ') ? lower.includes(v) : words.has(v))));
}

/**
 * Every model call extractDocument makes for a text, as {text, schema}: the first call for each sentence, and
 * the second (D27's values) for each sentence valueCue lets through. The harnesses answer these up front.
 * @param {import('./ontology.js').Ontology} o @param {string} text @param {{asked?: 'ontology'|'ids', threshold?: number}} [opts]
 */
export function modelRequests(o, text, opts = {}) {
  const { schema, valueSchema } = modelSchema(o, opts);
  return splitSentences(text).flatMap((s) => [
    { text: s.text, schema },
    ...(valueSchema && valueCue(s.text, o) ? [{ text: s.text, schema: valueSchema }] : []),
  ]);
}

/**
 * The model's answer for one sentence with every span inside the sentence: gliner-rs reads a unit that
 * has no final punctuation with a full stop after it, and a span can end on that stop, one code point
 * past the text (an entity '.', a tail ending in 'Chair).'). Such an end is moved back to the text's
 * end, and a span left empty is dropped (an entity; a relation with an empty end; a structure field).
 * The run's plain-JS gate calls it too, so both read the same spans.
 * @param {{entities: any[], relations: any[], structures?: any[]}} out @param {string} text
 */
export function clampToSentence(out, text) {
  const n = Array.from(text).length;
  const fix = (/** @type {any} */ x) => (x && x.end !== null && x.end > n ? { ...x, end: n } : x);
  const ok = (/** @type {any} */ x) => x && x.start !== null && x.end !== null && x.start < x.end;
  const entities = out.entities.map(fix).filter(ok);
  const relations = out.relations.map((r) => ({ ...r, head: fix(r.head), tail: fix(r.tail) })).filter((r) => ok(r.head) && ok(r.tail));
  const structures = (out.structures ?? []).map((st) => ({
    ...st,
    instances: st.instances.map((/** @type {any} */ inst) => Object.fromEntries(Object.entries(inst).map(([k, v]) => {
      if (!v || v.start === null || v.end === null) return [k, v];
      const w = fix(v);
      return [k, w.start < w.end ? w : null];
    }))),
  }));
  return { ...out, entities, relations, structures };
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
  const { schema, valueSchema, kindOf, relOf, structOf } = modelSchema(ontology, { asked });
  const valueSchemaText = valueSchema ? JSON.stringify(valueSchema) : null;
  const words = kindWordsOf(ontology);
  const proper = new Set(ontology.types.filter((t) => t.proper).map((t) => t.id));
  const patterns = proposedPatterns(ontology);
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
      const w = { doc, run, section: { key, n }, sentences: [], parts: [], inferences: [], inferred: [], mentions: [], claims: [], attributes: [] };
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
        const out = clampToSentence(normalize(raw, schema), s.text);
        // D27: the second call, for the values (an inference of its own, task 'values', cached the same way)
        /** @type {import('./gliner.js').StructureResult[]} */
        let structures = [];
        if (valueSchema && valueCue(s.text, ontology)) {
          const vkey = store.cacheKey({ model: modelInfo, schema: valueSchema, floor: FLOOR, text: s.text });
          let vraw = fresh.get(vkey) ?? store.readInference(db, cl, vkey);
          if (vraw === null) {
            vraw = extractRaw(model, s.text, valueSchema);
            c.inferences++;
            fresh.set(vkey, vraw);
            const parts = store.splitParts(vraw);
            w.inferences.push({ key: vkey, task: 'values', model: modelInfo.repo, rev: modelInfo.rev, weights: modelInfo.weights, build: modelInfo.build, floor: FLOOR, schema: valueSchemaText, parts: parts.length });
            parts.forEach((t, i) => w.parts.push({ key: `${vkey}#${i}`, inference: vkey, n: i, text: t }));
          } else {
            c.hits++;
          }
          w.inferred.push({ sentence: skey, inference: vkey });
          structures = clampToSentence(normalize(vraw, valueSchema), s.text).structures;
        }
        const slice = (x, y) => s.text.slice(utf16Index(s.text, x), utf16Index(s.text, y));
        const mentions = new Map();
        for (const e of out.entities) {
          const label = kindOf.get(e.label);
          if (!label) throw new Error(`pipeline: the model returned the label ${JSON.stringify(e.label)}, which was not asked`);
          const surface = slice(e.start, e.end);
          if (surface !== e.text) c.offsetMismatches++;
          const mkey = `${skey}|m|${label}|${s.start + e.start}-${s.start + e.end}`;
          // A kind of proper names (relate-examples proper, D26): a mention with no capital letter and no
          // digit ("the claimant", "two other cars") names none, so it gets no canonical name and rule 0 drops it.
          const named = !proper.has(label) || CASED.test(surface);
          mentions.set(mkey, { key: mkey, sentence: skey, doc, start: s.start + e.start, end: s.start + e.end, text: surface, label, name: named ? mentionName(surface, words.get(label)) : '', plain: mentionName(surface), p: e.score, source: 'model' });
        }
        for (const g of gazetteerMentions(s.text, ontology.names)) {
          const mkey = `${skey}|g|${g.label}|${s.start + g.start}-${s.start + g.end}`;
          mentions.set(mkey, { key: mkey, sentence: skey, doc, start: s.start + g.start, end: s.start + g.end, text: g.text, label: g.label, name: mentionName(g.text, words.get(g.label)), plain: mentionName(g.text), p: 1, source: 'gazetteer' });
        }
        // Identifiers a kind's key pattern proposes (relate-examples propose, D26) are listed names too:
        // rule 1 keeps them at p = 1.0 and drops the model mentions they overlap.
        for (const g of patternMentions(s.text, patterns)) {
          const mkey = `${skey}|p|${g.label}|${s.start + g.start}-${s.start + g.end}`;
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
        // D27: a value of an extracted property, one candidate per field the model gave a span in the sentence (a
        // choice it did not read in the text has none), scored by the value's own confidence: the model reads values
        // well and anchors them poorly (G12), so the gate's rule 8 joins the value to an entity by the mentions,
        // not by the anchor alone. The anchor's span, when there is one, goes with it; one candidate per property and
        // value span (the instance with the best anchor), its value parsed by the property's type.
        for (const st of structures) {
          const sx = structOf.get(st.name);
          if (!sx) throw new Error(`pipeline: the model returned the structure ${JSON.stringify(st.name)}, which was not asked`);
          /** @type {Map<string, any>} */
          const best = new Map();
          for (const inst of st.instances) {
            const anchor = inst[sx.anchor];
            const spanned = Boolean(anchor && anchor.start !== null && anchor.end !== null);
            for (const [field, a] of sx.fields) {
              const v = inst[field];
              if (!v || v.start === null || v.end === null || !(v.score >= FLOOR)) continue;
              const id = `${a.prop}|${v.start}-${v.end}`;
              const ap = spanned ? /** @type {any} */ (anchor).score : -1;
              if (best.has(id) && best.get(id).ap >= ap) continue;
              best.set(id, { a, v, anchor: spanned ? anchor : null, ap });
            }
          }
          for (const { a, v, anchor } of [...best.values()].sort((x, y) => x.v.start - y.v.start || x.v.end - y.v.end || (x.a.prop < y.a.prop ? -1 : x.a.prop > y.a.prop ? 1 : 0))) {
            const text = slice(v.start, v.end);
            const atext = anchor ? slice(anchor.start, anchor.end) : null;
            const named = atext !== null && (!proper.has(sx.kind) || CASED.test(atext));
            const parsed = parseValue(text, { type: a.parse ?? a.type, one_of: a.oneOf ?? undefined, pattern: a.pattern ?? undefined, form: a.form ?? null });
            const [vs, ve] = [v.start, v.end].map((x) => s.start + x);
            const [as, ae] = anchor ? [anchor.start, anchor.end].map((x) => s.start + x) : [null, null];
            w.attributes.push({
              key: `${skey}|a|${sx.kind}|${a.prop}|${vs}-${ve}`, sentence: skey, doc, kind: sx.kind, prop: a.prop, vtype: a.type,
              anchor: atext, aname: named ? mentionName(/** @type {string} */ (atext), words.get(sx.kind)) : '', astart: as, aend: ae, ap: anchor ? anchor.score : null,
              text, start: vs, end: ve, p: v.score, valid: parsed.ok, value: parsed.ok ? parsed.value : null, why: parsed.ok ? null : parsed.why,
            });
          }
        }
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
