// @ts-check
/**
 * harness/corpus.mjs: the corpus and the ontologies held to their bars (D20, D23), shared by
 * harness/domain.mjs (one domain, while writing it) and harness/run.mjs (every domain, diffed).
 * Pure apart from reading files under data/ and the inference cache under .cache/ex01-infer/.
 *
 *   loadIndex()                    data/samples/samples.json, every document with its text and gold (gold v2)
 *   loadOntologies()               the bundled ontologies: data/ontologies/domains/*.ontology.yaml (curated) and
 *                                  data/ontologies/ogs/studio/*.ontology.yaml (the packages, converted)
 *   goldKeys(o, gold)              gold names keyed as the store keys entities (names.js entityName)
 *   lintDocument(o, doc)           [problem]: the corpus rules (below) for one document
 *   lintCoverage(o, docs)          [problem]: every asked kind and link has gold in the domain's documents
 *   lintBar(o)                     [problem]: the ontology bar for a curated document, or the overlay's for a package
 *   breakdown(score, o, docs)      gold v2's views of a scoreAgainstGold result: aliases, recall by `how`
 *   cachedAnswers(requests, model) the model's answers from .cache/ex01-infer/, asking the model for the misses
 *
 * Gold v2 (data/samples/**\/*.gold.json):
 *   {entities: [{name, type, aliases?}], relations: [{source, target, type, how?}], distractors?: [{source, target, type, family}]}
 *   `how` says how the text states the fact (HOW); without it, 'plain'. A relation's source and target
 *   are entities' names. An entity's aliases are other names the text gives it ("HPP"); a predicted
 *   entity or end named by an alias counts as the entity. Distractors are claims the text makes but
 *   does not assert (FAMILIES): never in the gold, scored by where the gate leaves them.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOntology, MAX_TYPES } from '../web/ontology.js';
import { MAX_ASK_CHARS } from '../web/ogs.js';
import { entityName } from '../web/names.js';
import { splitSentences } from '../web/split.js';
import { parseValue } from '../web/values.js';
import * as store from '../web/store.js';
import { extractRaw } from '../web/gliner.js';
import { requestKey } from './infer.mjs';

export const EX = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(EX, 'data');
const ROOT = join(EX, '../..');

/** How a text states a fact (gold v2 `how`), and whether a sentence-level model can reach it. */
export const HOW = Object.freeze({
  plain: true, passive: true, apposition: true, list: true, table: true, alias: true, nominal: true,
  'cross-sentence': false, coreference: false,
});
/** The kinds of claim a text makes without asserting it (gold v2 distractor `family`). */
export const FAMILIES = Object.freeze(['negation', 'hedge', 'conditional', 'future', 'alleged', 'retracted']);
/** The tools' categories in a curated ontology (D22), in the order the page lists them. */
export const CATEGORIES = Object.freeze(['lookup', 'neighbourhood', 'path', 'aggregation', 'evidence', 'review', 'cross-document']);
/** A document's length in words, by its role. */
export const LENGTH = Object.freeze({ primary: [600, 1300], companion: [250, 700], heldout: [400, 1000] });

// ---- files -----------------------------------------------------------------------------------------

/** The front matter of a markdown document as a map of its `key: value` lines (strings), or {}. @param {string} text */
export function frontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return {};
  return Object.fromEntries(m[1].split('\n').map((l) => /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(l)).filter(Boolean)
    .map((x) => [/** @type {RegExpExecArray} */ (x)[1], /** @type {RegExpExecArray} */ (x)[2].trim()]));
}
/** A text without its front matter (offsets are not kept: for word counts and name lookups). @param {string} text */
export const bodyOf = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, '');
/** Words in a text's body: runs of letters, digits and joiners. @param {string} text */
export const words = (text) => (bodyOf(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) ?? []).length;

/**
 * The bundled ontologies, parsed: {id -> {o, file, group}}. Curated documents first (`domains`),
 * then the packages (`studio`), each group in file order.
 */
export function loadOntologies() {
  /** @type {Map<string, {o: any, file: string, group: 'domains'|'studio'}> & {errors?: Map<string, string>}} */
  const out = new Map();
  // A document that does not parse is not thrown: it is listed in out.errors by its file's id, so one broken
  // document never stops the others (domain.mjs reports its own; run.mjs fails on any).
  /** @type {Map<string, string>} */
  const errors = new Map();
  for (const [group, dir] of /** @type {const} */ ([['domains', 'ontologies/domains'], ['studio', 'ontologies/ogs/studio']])) {
    const abs = join(DATA, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs).filter((x) => x.endsWith('.ontology.yaml')).sort()) {
      let o;
      try {
        o = parseOntology(readFileSync(join(abs, f), 'utf8'));
      } catch (e) {
        errors.set(f.replace(/\.ontology\.yaml$/, ''), `data/${dir}/${f}: ${String(/** @type {any} */ (e)?.message ?? e)}`);
        continue;
      }
      if (out.has(o.id)) throw new Error(`corpus: two bundled ontologies have the id ${o.id}`);
      out.set(o.id, { o, file: `data/${dir}/${f}`, group });
    }
  }
  out.errors = errors;
  return out;
}

/**
 * data/samples/samples.json, every entry with its text and gold, and the held-out documents
 * (data/samples/heldout/<ontology>.md, never listed in the page) after them, role 'heldout'.
 * @returns {Array<{id: string, ontology: string, group: string, role: 'primary'|'companion'|'heldout', case: string|null,
 *   file: string, text: string, gold: any, entry: any}>}
 */
export function loadIndex() {
  const list = JSON.parse(readFileSync(join(DATA, 'samples/samples.json'), 'utf8'));
  // A domain being written keeps its entries in data/samples/<group>/<id>/entries.json until they are
  // merged into samples.json (harness/corpus.mjs --merge), so parallel writers never edit one file.
  for (const group of ['domains', 'studio']) {
    const gdir = join(DATA, 'samples', group);
    if (!existsSync(gdir)) continue;
    for (const id of readdirSync(gdir).sort()) {
      const f = join(gdir, id, 'entries.json');
      if (!existsSync(f)) continue;
      for (const e of JSON.parse(readFileSync(f, 'utf8'))) if (!list.some((x) => x.id === e.id)) list.push(e);
    }
  }
  const docs = list.map((s) => ({
    id: s.id, ontology: s.ontology, group: s.group, role: s.role ?? 'primary', case: s.case ?? null, file: `data/samples/${s.file}`,
    text: readFileSync(join(DATA, 'samples', s.file), 'utf8'), gold: s.gold ? JSON.parse(readFileSync(join(DATA, 'samples', s.gold), 'utf8')) : null, entry: s,
  }));
  const held = join(DATA, 'samples/heldout');
  if (existsSync(held)) {
    for (const f of readdirSync(held).filter((x) => x.endsWith('.md')).sort()) {
      const oid = f.slice(0, -3);
      const gf = join(held, `${oid}.gold.json`);
      docs.push({
        id: `heldout/${oid}`, ontology: oid, group: 'heldout', role: 'heldout', case: null, file: `data/samples/heldout/${f}`,
        text: readFileSync(join(held, f), 'utf8'), gold: existsSync(gf) ? JSON.parse(readFileSync(gf, 'utf8')) : null, entry: null,
      });
    }
  }
  return docs;
}

// ---- gold ------------------------------------------------------------------------------------------

/**
 * A gold file's names as the store keys its entities (names.js entityName with the kind's label
 * words, as mentionName does), aliases included: {key(name, kind), entities, relations, alias: Map
 * alias key -> entity key, how: Map relation key -> how, distractors: [{key, family}]}.
 * @param {any} o  the parsed ontology
 * @param {any} gold  gold v2
 */
export function goldKeys(o, gold) {
  const wordsOf = store.kindWordsOf(o);
  const kindOf = new Map(gold.entities.map((e) => [e.name, e.type]));
  const key = (name, kind) => entityName(name, wordsOf.get(kind) ?? []);
  /** @type {Map<string, string>} */
  const alias = new Map();
  for (const e of gold.entities) for (const a of e.aliases ?? []) alias.set(`${key(a, e.type)}|${e.type}`, `${key(e.name, e.type)}|${e.type}`);
  const relKey = (r) => `${key(r.source, kindOf.get(r.source))}|${key(r.target, kindOf.get(r.target))}|${r.type}`;
  return {
    key,
    kindOf,
    alias,
    entities: gold.entities.map((e) => ({ name: key(e.name, e.type), type: e.type })),
    relations: gold.relations.map((r) => ({ src: key(r.source, kindOf.get(r.source)), rel: r.type, tgt: key(r.target, kindOf.get(r.target)) })),
    how: new Map(gold.relations.map((r) => [relKey(r), r.how ?? 'plain'])),
    distractors: (gold.distractors ?? []).map((d) => ({
      key: `${key(d.source, kindOf.get(d.source) ?? '')}|${key(d.target, kindOf.get(d.target) ?? '')}|${d.type}`, family: d.family, d,
    })),
    /** D27: entity key (KIND:NAME, as publish keys it) + property -> the value the text states */
    properties: (gold.properties ?? []).map((p) => ({
      entity: `${kindOf.get(p.entity)}:${key(p.entity, kindOf.get(p.entity))}`, prop: p.property, value: p.value, text: p.text, how: p.how ?? 'plain',
    })),
  };
}

/**
 * D27: one document's property values against its gold. What counts is what publish writes: the best
 * kept value per entity and property (readGate's attributes, kept, in p order). A value is right when it
 * equals the gold's on the gold's entity; a kept value for an entity or property the gold has no value
 * for, or a different value, is a false positive; a gold value with no right one kept is missed.
 * @param {Array<{doc: string, entity: string|null, prop: string, value: any, p: number, key: string, band: string}>} attributes
 * @param {ReturnType<typeof goldKeys>} g @param {string} docKey
 */
export function scoreProperties(attributes, g, docKey) {
  const best = new Map();
  for (const a of attributes.filter((x) => x.doc === docKey && x.band === 'keep' && x.entity).sort((x, y) => y.p - x.p || (x.key < y.key ? -1 : 1))) {
    const k = `${a.entity}|${a.prop}`;
    if (!best.has(k)) best.set(k, a.value);
  }
  const gold = new Map(g.properties.map((p) => [`${p.entity}|${p.prop}`, p.value]));
  let tp = 0;
  const fp = [];
  const missed = [];
  for (const [k, v] of best) {
    if (gold.has(k) && gold.get(k) === v) tp += 1;
    else fp.push(`${k}=${JSON.stringify(v)}${gold.has(k) ? ` (gold ${JSON.stringify(gold.get(k))})` : ''}`);
  }
  for (const [k, v] of gold) if (best.get(k) !== v) missed.push(`${k}=${JSON.stringify(v)}`);
  /** recall by how the text states the value (gold v2 how, as relations have it) */
  const byHow = {};
  for (const p of g.properties) {
    const h = (byHow[p.how] ??= { gold: 0, found: 0 });
    h.gold += 1;
    if (best.get(`${p.entity}|${p.prop}`) === p.value) h.found += 1;
  }
  const precision = tp + fp.length ? tp / (tp + fp.length) : 0;
  const recall = gold.size ? tp / gold.size : 0;
  return { tp, fp, missed, gold: gold.size, byHow, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
}

/**
 * gold v2's views of one document's score (store.scoreAgainstGold's row for it): a false positive
 * named by a gold entity's alias is the entity (found through its alias when the entity was missed,
 * else a duplicate, neither right nor wrong); relations the same, end by end. Then recall by `how`,
 * and reachable recall (the hows a sentence-level model can reach).
 * @param {{entities: any, relations: any}} row  {entities: the document's entity row, relations: its relation row}
 * @param {ReturnType<typeof goldKeys>} g
 */
export function breakdown(row, g) {
  const fix = (r, mapKey) => {
    const missed = new Set(r.missed);
    let tp = Number(r.tp);
    let dup = 0;
    const fp = [];
    for (const k of r.false_pos) {
      const m = mapKey(k);
      if (m === k) fp.push(k);
      else if (missed.has(m)) {
        missed.delete(m);
        tp += 1;
      } else dup += 1;
    }
    const p = tp + fp.length > 0 ? tp / (tp + fp.length) : 0;
    const gold = tp + missed.size;
    const rc = gold > 0 ? tp / gold : 0;
    return { tp, fp: fp.length, fn: missed.size, dup, precision: p, recall: rc, f1: p + rc > 0 ? (2 * p * rc) / (p + rc) : 0, false_pos: fp, missed: [...missed].sort() };
  };
  const entKey = (k) => g.alias.get(k) ?? k;
  const relKey = (k) => {
    const [s, t, rel] = k.split('|');
    const kinds = [...g.kindOf.values()];
    const a = kinds.map((kind) => g.alias.get(`${s}|${kind}`)).find(Boolean)?.split('|')[0] ?? s;
    const b = kinds.map((kind) => g.alias.get(`${t}|${kind}`)).find(Boolean)?.split('|')[0] ?? t;
    return `${a}|${b}|${rel}`;
  };
  const entities = fix(row.entities, entKey);
  const relations = fix(row.relations, relKey);
  /** @type {Record<string, {gold: number, found: number}>} */
  const byHow = {};
  for (const [k, how] of g.how) {
    const b = (byHow[how] ??= { gold: 0, found: 0 });
    b.gold += 1;
    if (!relations.missed.includes(k)) b.found += 1;
  }
  const reach = Object.entries(byHow).filter(([h]) => HOW[h]).reduce((a, [, b]) => ({ gold: a.gold + b.gold, found: a.found + b.found }), { gold: 0, found: 0 });
  return { entities, relations, byHow, reachable: reach };
}

// ---- the corpus lint (D23) -------------------------------------------------------------------------

const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
const DOC_BLOCKS = ['192.0.2.', '198.51.100.', '203.0.113.'];
const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const RESERVED_DOMAIN = /(^|\.)example\.(com|org|net)$|\.(example|test|invalid)$/i;
const SSN = /\b(\d{3})-(\d{2})-(\d{4})\b/g;

/**
 * The corpus rules for one document (D23): [problem, …], empty when it holds.
 * @param {any} o  its ontology, parsed
 * @param {{id: string, role: string, text: string, gold: any, ontology: string}} doc
 */
export function lintDocument(o, doc) {
  const p = [];
  const say = (s) => p.push(`${doc.id}: ${s}`);
  const fm = frontMatter(doc.text);
  if (fm.domain !== o.id) say(`front matter domain is ${JSON.stringify(fm.domain)}, not ${o.id}`);
  if (fm.synthetic !== 'true') say('front matter needs synthetic: true');
  if (!fm.genre) say('front matter needs genre: (what kind of document this is)');
  if (!fm.note) say('front matter needs note: (what it was written from, and that it is synthetic)');
  const [lo, hi] = LENGTH[/** @type {keyof typeof LENGTH} */ (doc.role)] ?? [0, Infinity];
  const n = words(doc.text);
  if (n < lo || n > hi) say(`${n} words; a ${doc.role} document has ${lo} to ${hi}`);
  const body = bodyOf(doc.text);
  for (const m of body.matchAll(IPV4)) if (!DOC_BLOCKS.some((b) => m[0].startsWith(b))) say(`IP address ${m[0]} is outside the documentation blocks (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24)`);
  for (const m of body.matchAll(EMAIL)) if (!RESERVED_DOMAIN.test(m[1])) say(`e-mail ${m[0]} is not at a reserved domain (example.com, .org, .net)`);
  for (const m of body.matchAll(SSN)) if (!(m[1] === '000' || m[1] === '666' || m[1].startsWith('9'))) say(`${m[0]} looks like an issued SSN (use area 000, 666 or 9xx)`);
  const g = doc.gold;
  if (!g) {
    say('has no gold');
    return p;
  }
  const kinds = new Set(o.types.map((t) => t.id));
  const byName = new Map();
  for (const e of g.entities) {
    if (!kinds.has(e.type)) say(`gold entity ${JSON.stringify(e.name)} has the kind ${e.type}, which ${o.id} does not have`);
    if (byName.has(e.name)) say(`gold entity ${JSON.stringify(e.name)} is listed twice (one kind per name in a document)`);
    byName.set(e.name, e);
    for (const nm of [e.name, ...(e.aliases ?? [])]) if (!body.includes(nm)) say(`gold name ${JSON.stringify(nm)} does not occur in the text as written`);
  }
  const units = splitSentences(doc.text).map((s) => s.text);
  const names = (e) => [e.name, ...(e.aliases ?? [])];
  const together = (a, b) => units.some((u) => names(a).some((x) => u.includes(x)) && names(b).some((y) => u.includes(y)));
  const legal = (type, a, b) => {
    const l = o.relations.find((r) => r.id === type);
    return Boolean(l) && l.pairs.some(([s, t]) => (s === a && t === b) || (l.symmetric && s === b && t === a));
  };
  const seen = new Set();
  for (const r of g.relations) {
    const what = `${r.source} -[${r.type}]-> ${r.target}`;
    const a = byName.get(r.source);
    const b = byName.get(r.target);
    if (!a || !b) {
      say(`gold relation ${what}: both ends must be gold entities' names`);
      continue;
    }
    if (!legal(r.type, a.type, b.type)) say(`gold relation ${what}: ${a.type} -[${r.type}]-> ${b.type} is not a legal pair of ${o.id}`);
    const how = r.how ?? 'plain';
    if (!Object.hasOwn(HOW, how)) say(`gold relation ${what}: how is ${JSON.stringify(how)}, not one of ${Object.keys(HOW).join(', ')}`);
    else if (HOW[/** @type {keyof typeof HOW} */ (how)] && !together(a, b)) say(`gold relation ${what}: tagged ${how}, but no sentence holds both ends (tag it cross-sentence or coreference)`);
    else if (!HOW[/** @type {keyof typeof HOW} */ (how)] && together(a, b)) say(`gold relation ${what}: tagged ${how}, but one sentence holds both ends by name`);
    const k = `${r.source}|${r.type}|${r.target}`;
    if (seen.has(k)) say(`gold relation ${what} is listed twice`);
    seen.add(k);
  }
  for (const d of g.distractors ?? []) {
    const what = `${d.source} -[${d.type}]-> ${d.target}`;
    if (!FAMILIES.includes(d.family)) say(`distractor ${what}: family ${JSON.stringify(d.family)} is not one of ${FAMILIES.join(', ')}`);
    if (seen.has(`${d.source}|${d.type}|${d.target}`)) say(`distractor ${what} is also in the gold`);
    const a = byName.get(d.source);
    const b = byName.get(d.target);
    if (!a || !b) say(`distractor ${what}: both ends must be gold entities' names`);
    else {
      if (!legal(d.type, a.type, b.type)) say(`distractor ${what}: not a legal pair, so it tests nothing`);
      if (!together(a, b)) say(`distractor ${what}: no sentence holds both ends, so the model never sees it`);
    }
  }
  if (doc.role !== 'heldout' && (g.distractors ?? []).length < 3) say(`${(g.distractors ?? []).length} distractors; a document has at least 3`);
  // D27: each gold property value names a gold entity and an extracted property of its kind, and its text
  // occurs in the document and parses to the value (web/values.js), as the page would read it.
  const pseen = new Set();
  for (const pv of g.properties ?? []) {
    const what = `gold property ${pv.entity}.${pv.property}`;
    const e = byName.get(pv.entity);
    if (!e) { say(`${what}: the entity is not a gold entity's name`); continue; }
    const a = o.types.find((t) => t.id === e.type)?.attributes?.find((x) => x.prop === pv.property);
    if (!a) { say(`${what}: ${e.type} has no extracted property ${pv.property} (mark it relate-examples extract: true)`); continue; }
    if (typeof pv.text !== 'string' || !body.includes(pv.text)) say(`${what}: text ${JSON.stringify(pv.text)} does not occur in the document as written`);
    const parsed = parseValue(pv.text, { type: a.parse, one_of: a.oneOf ?? undefined, pattern: a.pattern ?? undefined, form: a.form ?? null });
    if (!parsed.ok) say(`${what}: text ${JSON.stringify(pv.text)} does not parse (${parsed.why})`);
    else if (parsed.value !== pv.value) say(`${what}: text ${JSON.stringify(pv.text)} parses to ${JSON.stringify(parsed.value)}, not ${JSON.stringify(pv.value)}`);
    if (pv.how !== undefined && !Object.hasOwn(HOW, pv.how)) say(`${what}: how is ${JSON.stringify(pv.how)}, not one of ${Object.keys(HOW).join(', ')}`);
    if (pseen.has(`${pv.entity}|${pv.property}`)) say(`${what} is listed twice (one value per entity and property in a document)`);
    pseen.add(`${pv.entity}|${pv.property}`);
  }
  // A kind whose pattern proposes identifiers (D26) must propose only the gold's: every token the
  // pattern matches is a gold name or alias of that kind.
  for (const t of o.types.filter((x) => x.propose && x.keyPattern)) {
    const re = new RegExp(t.keyPattern, 'u');
    const listed = new Set(g.entities.filter((e) => e.type === t.id).flatMap((e) => [e.name, ...(e.aliases ?? [])]));
    for (const w of new Set(body.split(/\s+/u).map((x) => x.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '')))) {
      const m = re.exec(w);
      if (w && m && m.index === 0 && m[0].length === w.length && !listed.has(w)) say(`the pattern of ${t.id} proposes ${JSON.stringify(w)}, which the gold does not list as a ${t.id} (list it, or narrow the pattern)`);
    }
  }
  return p;
}

/**
 * Every kind and link the model is asked has gold in the domain's own documents (primary and
 * companions; the held-out set is not counted).
 * @param {any} o @param {Array<{role: string, gold: any}>} docs
 */
export function lintCoverage(o, docs) {
  const mine = docs.filter((d) => d.role !== 'heldout' && d.gold);
  const kinds = new Set(mine.flatMap((d) => d.gold.entities.map((e) => e.type)));
  const links = new Set(mine.flatMap((d) => d.gold.relations.map((r) => r.type)));
  const p = [];
  for (const t of o.types) if (t.ask && !kinds.has(t.id)) p.push(`${o.id}: the kind ${t.id} is asked but no document's gold has one`);
  for (const r of o.relations) if (r.ask && !links.has(r.id)) p.push(`${o.id}: the link ${r.id} is asked but no document's gold has one`);
  return p;
}

// ---- the ontology bar (D20) ------------------------------------------------------------------------

const sentences = (s) => (String(s ?? '').match(/[^.!?]+[.!?]+/g) ?? []).length;
const wordCount = (s) => (String(s ?? '').match(/\S+/g) ?? []).length;

/** The labels and types a query names (`:Label`, `:TYPE`), blanking strings and comments first. @param {string} cypher */
export function namesIn(cypher) {
  const q = cypher.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "''");
  return new Set([...q.matchAll(/:\s*`?([\p{L}_][\p{L}\p{N}_]*)`?/gu)].map((m) => m[1]));
}

/**
 * The ontology bar (D20): [problem, …]. A curated document (relate-examples family 'domains') is held
 * to all of it; a converted package ('studio') to what its overlay owns (cues, phrases, colours,
 * card, industry, the schema budget).
 * @param {any} o  the parsed ontology
 */
export function lintBar(o) {
  const p = [];
  const say = (s) => p.push(`${o.id}: ${s}`);
  const repo = o.about ?? {};
  const family = repo.family;
  const doc = o.doc;
  if (family !== 'domains' && family !== 'studio') say(`relate-examples.family is ${JSON.stringify(family)}, not domains or studio`);
  if (!repo.industry) say('relate-examples.industry is missing');
  for (const t of o.types) {
    if (t.ask && t.askMode !== 'cue') say(`the kind ${t.id} has no relate-examples ask (every asked kind carries its own, at most ${MAX_ASK_CHARS} characters)`);
    if (!/^#[0-9a-f]{6}$/i.test(t.color) || t.color === '#64748b') say(`the kind ${t.id} has no display colour of its own`);
  }
  for (const r of o.relations) if (r.ask && !doc.relationships[r.keys[0]]?.extensions?.custom?.['relate-examples']?.phrase) say(`the link ${r.id} has no relate-examples phrase`);
  if (family !== 'domains') return p;

  // The curated documents: all of the bar.
  if (doc.version !== '2') say(`version is ${JSON.stringify(doc.version)}; a curated document is version "2"`);
  const dw = wordCount(doc.description);
  if (dw < 80 || dw > 200) say(`the description has ${dw} words (80 to 200)`);
  if (!repo.source?.derived_from) say('relate-examples.source.derived_from (the lineage) is missing');
  if (!repo.card?.description) say('relate-examples.card.description is missing');
  if (o.types.length < 6 || o.types.length > Math.min(14, MAX_TYPES)) say(`${o.types.length} kinds (6 to 14)`);
  if (o.relations.length > 20) say(`${o.relations.length} links (at most 20)`);
  for (const [key, n] of Object.entries(doc.nodes)) {
    const id = n.label ?? n.labels?.identifier;
    const s = sentences(n.description);
    if (s < 1 || s > 3) say(`${id}: the description has ${s} sentences (1 to 3)`);
    if (!(n.aliases ?? []).length) say(`${id}: no aliases`);
    const props = Object.entries(n.properties ?? {});
    if (!props.some(([, x]) => x.key === true)) say(`${id}: no key property`);
    if (!props.some(([name]) => name === 'name')) say(`${id}: no name property (the extractor writes name)`);
    for (const [pn, x] of props) if (!x.description) say(`${id}.${pn}: no description`);
    if (!Number.isFinite(n.extensions?.display?.x) || !Number.isFinite(n.extensions?.display?.y)) say(`${id}: display needs x and y`);
    if (Object.keys(n.extensions?.custom ?? {}).some((k) => k.startsWith('createContextGraph:'))) say(`${key}: a createContextGraph extension (curated documents carry none)`);
  }
  for (const [key, r] of Object.entries(doc.relationships)) {
    if (wordCount(r.description) < 8) say(`${key} (${r.type}): the description is too short to say direction and cardinality`);
    if (!(r.aliases ?? []).length) say(`${key} (${r.type}): no aliases`);
  }
  const tools = o.tools;
  if (tools.length < 8 || tools.length > 15) say(`${tools.length} tools (8 to 15)`);
  const used = new Set();
  for (const t of tools) {
    const at = `tool ${t.name}`;
    if (t.type !== 'canonicalQuery' || !t.cypher) say(`${at}: a canonicalQuery with cypher`);
    if (!t.question) say(`${at}: no question`);
    if (!t.description) say(`${at}: no description`);
    if (!t.teaches) say(`${at}: no teaches`);
    if (!CATEGORIES.includes(t.category)) say(`${at}: category ${JSON.stringify(t.category)} is not one of ${CATEGORIES.join(', ')}`);
    if (t.requires.length) say(`${at}: requires ${t.requires.join(', ')} (a curated tool runs on the page's engine, read-only)`);
    for (const prm of t.parameters) {
      if (!prm.type) say(`${at}: parameter ${prm.name} has no type`);
      if (prm.example === undefined) say(`${at}: parameter ${prm.name} has no example (the page prefills it, the audit runs with it)`);
    }
    for (const nm of namesIn(t.cypher ?? '')) used.add(nm);
  }
  for (const t of o.types) if (!used.has(t.id)) say(`the kind ${t.id} is used by no tool (no orphan kinds)`);
  for (const r of o.relations) if (!used.has(r.id)) say(`the link ${r.id} is used by no tool (no orphan links)`);
  const cats = new Set(tools.map((t) => t.category));
  for (const c of ['lookup', 'neighbourhood', 'path', 'aggregation', 'evidence']) if (!cats.has(c)) say(`no ${c} tool`);
  return p;
}

// ---- the gold graph --------------------------------------------------------------------------------

/**
 * The typed graph the gold describes, written into a store openStore has prepared as publish writes
 * an extracted one (D16: (:_Entity:KIND {key, kind, norm, name, display, docs}) and one typed
 * relationship per gold relation, p 1.0), without the trace: what the ontology's tools would find if
 * extraction were perfect. Tools over the trace (_Sentence, _Claim) find nothing here.
 * @param {any} db @param {any} cl @param {any} o @param {Array<{id: string, gold: any}>} docs
 */
export function goldGraph(db, cl, o, docs) {
  const ents = new Map();
  const rels = new Map();
  for (const d of docs) {
    const g = goldKeys(o, d.gold);
    for (const e of d.gold.entities) {
      const k = `${e.type}:${g.key(e.name, e.type)}`;
      const t = o.types.find((x) => x.id === e.type);
      const props = t?.keyProp ? { [t.keyProp]: store.keyValue([e.name, ...(e.aliases ?? [])], t.keyPattern) } : {};
      const x = ents.get(k) ?? { key: k, kind: e.type, norm: g.key(e.name, e.type), name: e.name, docs: [], props };
      x.docs.push(d.id);
      ents.set(k, x);
    }
    for (const r of d.gold.relations) {
      const a = `${g.kindOf.get(r.source)}:${g.key(r.source, g.kindOf.get(r.source))}`;
      const b = `${g.kindOf.get(r.target)}:${g.key(r.target, g.kindOf.get(r.target))}`;
      const k = `${a}\u0000${r.type}\u0000${b}`;
      const x = rels.get(k) ?? { a, b, rel: r.type, docs: [] };
      x.docs.push(d.id);
      rels.set(k, x);
    }
  }
  const rows = [...ents.values()];
  cl.exec(db, `UNWIND $rows AS r MERGE (e:_Entity {key: r.key})
SET e.kind = r.kind, e.norm = r.norm, e.name = r.name, e.display = r.name, e.docs = r.docs, e.mentions = 1, e.generation = 1
SET e += r.props`, { rows });
  for (const t of o.types) {
    cl.exec(db, 'MATCH (e:_Entity) WHERE e.kind = $k SET e:$($k)', { k: t.id });
    for (const l of t.implied) cl.exec(db, 'MATCH (e:_Entity) WHERE e.kind = $k SET e:$($l)', { k: t.id, l });
  }
  for (const r of rels.values()) {
    cl.exec(db, `MATCH (a:_Entity {key: $a}), (b:_Entity {key: $b}) MERGE (a)-[x:$($rel)]->(b)
SET x.p = 1.0, x.docs = $docs, x.claims = [], x.sentences = [], x.generation = 1`, { a: r.a, b: r.b, rel: r.rel, docs: r.docs });
  }
  return { entities: ents.size, relationships: rels.size };
}

// ---- the model -------------------------------------------------------------------------------------

export const GLINER_REV = '4fa741eec466660daf4adc8703210138295e0b1b';
export const MODELS = Object.freeze({
  small: { repo: 'fastino/gliner2.5-small-v1', rev: '7132dc4561c3f94563c6147e75ffa8ef34c4964a', env: 'GLINER_SMALL_DIR', name: 'gliner2.5-small-v1' },
  base: { repo: 'fastino/gliner2.5-base-v1', rev: 'ca906247640776a07753514055be9726f9080ead', env: 'GLINER_BASE_DIR', name: 'gliner2.5-base-v1' },
});

/**
 * Where a model's files are and how to load it, as harness/run.mjs finds them: {M, wasmDir, modelDir,
 * info (pipeline.run's modelInfo), scope (the inference cache's directory), load()}.
 * @param {'small'|'base'} which @param {string} build  pipeline.BUILD
 */
export function modelSetup(which, build) {
  const M = MODELS[which];
  const wasmDir = process.env.GLINER_WASM_DIR || join(ROOT, '.cache/gliner-wasm', GLINER_REV.slice(0, 7));
  const modelDir = process.env[M.env] || join(ROOT, '.cache/gliner', `${M.name}@${M.rev.slice(0, 7)}`);
  const pin = readFileSync(join(ROOT, 'ci', `${M.name}.sha256`), 'utf8');
  const weights = new Map(pin.trim().split('\n').map((l) => l.split(/\s+/)).map(([s, p]) => [p, s])).get('model.safetensors');
  const builtSums = readFileSync(join(wasmDir, '.built'), 'utf8').split('\n---\n')[1] ?? '';
  const wasmSha = new Map(builtSums.trim().split('\n').filter(Boolean).map((l) => l.split(/\s+/)).map(([s, p]) => [p, s])).get('gliner_rs_bg.wasm') ?? 'unknown';
  return {
    M, wasmDir, modelDir,
    info: { repo: M.repo, rev: M.rev, weights, build },
    scope: `${M.name}@${M.rev.slice(0, 7)}-${String(weights).slice(0, 12)}-wasm-${wasmSha.slice(0, 12)}`,
    async load() {
      const { MODEL_FILES, loadModel } = await import('../web/gliner.js');
      const { pathToFileURL } = await import('node:url');
      const glue = await import(pathToFileURL(join(wasmDir, 'gliner_rs.js')).href);
      return loadModel({
        glue, wasmBytes: readFileSync(join(wasmDir, 'gliner_rs_bg.wasm')),
        ...Object.fromEntries(Object.entries(MODEL_FILES).map(([arg, f]) => [arg, readFileSync(join(modelDir, f))])),
      });
    },
  };
}

// ---- the model's answers, cached on disk (D24) ------------------------------------------------------

const CACHE = join(ROOT, '.cache/ex01-infer');

/**
 * The model's raw answer for every request, from .cache/ex01-infer/ (keyed by the sha256 of
 * infer.mjs requestKey: the text, the schema and the threshold; one directory per model build and
 * weights, `scope`), asking `model()` (loaded only when something is missing) for the rest and
 * writing them back. A cached answer is the string gliner-rs gives (G7: a call is deterministic).
 * @param {Array<{text: string, schema: any}>} requests
 * @param {{scope: string, model: () => Promise<any>, off?: boolean}} opts
 * @returns {Promise<{answers: Map<string, string>, hits: number, misses: number, model: any}>}
 */
export async function cachedAnswers(requests, { scope, model, off = false }) {
  const dir = join(CACHE, scope);
  mkdirSync(dir, { recursive: true });
  const answers = new Map();
  let hits = 0;
  let misses = 0;
  let m = null;
  for (const r of requests) {
    const k = requestKey(r.text, r.schema);
    if (answers.has(k)) continue;
    const f = join(dir, `${createHash('sha256').update(k).digest('hex')}.json`);
    if (!off && existsSync(f)) {
      answers.set(k, readFileSync(f, 'utf8'));
      hits += 1;
      continue;
    }
    m ??= await model();
    const raw = extractRaw(m, r.text, r.schema);
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, raw);
    renameSync(tmp, f);
    answers.set(k, raw);
    misses += 1;
  }
  return { answers, hits, misses, model: m };
}
