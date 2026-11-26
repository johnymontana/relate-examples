// @ts-check
/**
 * console.js: the console worker (NOTES.md D6, D11; R2, R4, R5, R11, R14, R15), and the checks the page applies to the ontology's tools before the console
 * runs one (exported below; the page and harness/run.mjs import this module, which then starts no
 * worker loop).
 *
 * It has its own Relate instance and holds a database handle only while the engine worker
 * has lent it the store (one opener per store, read-only included: R11): per query it opens
 * `opfs://<store>` read-only (R15), runs one statement, and frees the handle. The engine refuses
 * every write the statement would perform (`semantic error: WriteOnReadOnlyAccessDatabase: ...`),
 * so the console needs no write detection of its own; a statement that matches nothing writes
 * nothing and is not refused (R15: a read-only handle refuses only writes that occur). There is
 * no transaction to roll back (R2): the read-only handle is the only guard.
 *
 * The page does the lease (app.js): `lend` to the engine worker, this worker's query, then
 * `reclaim`. A query has no cancel API, so the page's watchdog terminates this worker after 10 s,
 * which releases the store's lock (at once when idle, a moment later when the worker is inside the
 * query: R11; the engine's reclaim waits that out), and starts a fresh one.
 *
 * Messages (page -> worker -> page):
 *   {id, kind: 'init'}                          -> {id, ok, data: {version, procedures}}
 *                                                  procedures: SHOW PROCEDURES's names, from an in-memory
 *                                                  database (no store, no lease), for the tools' notes
 *   {id, kind: 'query', uri, query, params, strict?}
 *                                               -> {id, ok, data: {columns, rows, stats, ontologyIds, ms}}
 *                                                  ontologyIds: the ids of the store's ontology-layer nodes
 *                                                  (ONTOLOGY_LABELS) when the rows hold an _IN or _OF
 *                                                  relationship, else null: whether such a relationship is the
 *                                                  ontology's or bookkeeping depends on its ends, which the rows
 *                                                  may not hold. The page draws the graph itself (consoleResult:
 *                                                  the bookkeeping left out first, then capped, tonvl.js capGraph)
 *   errors                                       -> {id, ok: false, error: {code, category, message, detail}}
 * code is 'engine' (an error envelope; category from lib/relate_wasm.mjs: readonly, syntax, semantic,
 * constraint, type, locked, other), 'trap' (the instance is gone: terminate this worker),
 * 'usage' or 'error'. A trap (R14) leaves the handle unusable and unfreeable, so the page ends
 * this worker. Parameters: the page passes the values typed for the query's $names. For a query
 * typed into the console a null one is allowed through (it matches nothing in a property map, R3,
 * and the engine refuses a missing one as ParameterMissing); an ontology tool's run sends
 * `strict: true`, and lib/relate_wasm.mjs then refuses a null, missing, undefined or NaN parameter
 * as well, after the page's own checks (toolArgs, below) refused it first. They travel as JSON text
 * (R5: a typed 3.0 binds as INTEGER 3).
 *
 * The tools (the ontology's `tools` custom extension, ontology.js o.tools; README "The ontology's tools"):
 *   readQuery(cypher)            the query read statically: its MATCH parts (required, optional or in
 *                                a subquery), node and relationship patterns with labels, types, map
 *                                keys and hop bounds, the properties read per variable, procedure
 *                                calls with an index name, the $parameters
 *   toolCompat(tool, ctx)        {predict, reasons, details, text}: what the query can do on a graph this
 *                                example extracted (Predict, below). ctx: {kinds: [{id, ask}], links: [{id}],
 *                                procedures: string[]|null, indexes: string[]|null}. 'empty' when a required
 *                                MATCH needs a label or type the ontology lacks, a kind the model is never
 *                                asked, or a property the extractor never writes (in its map, or in every
 *                                branch of its WHERE); 'error' when it calls a procedure SHOW PROCEDURES does
 *                                not list, when an ORDER BY after an aggregating or DISTINCT WITH/RETURN reads a
 *                                variable the projection drops (unprojectedOrderBy, R20), or an index procedure on an index the store lacks (IndexDoesNotExist)
 *                                that the query certainly reaches; 'empty' instead when a
 *                                required MATCH before the call is itself empty ("it would error if reached"),
 *                                or when its query vector is never written (a null vector returns no rows even
 *                                on a missing index); 'error if reached' when a clause before the call can
 *                                leave no rows; 'checked at run' when the index is named by a parameter. It
 *                                also notes a parameter compared only in an OPTIONAL MATCH or a subquery.
 *                                text is the page's one line.
 *   toolParams(tool)             each parameter: {name, type, description, required, default, oneOf,
 *                                hint, emptyOk, integer, nonNegative}
 *   toolArgs(tool, raw)          {ok, params, problems}: the typed values from the text typed for each
 *                                parameter, coerced by its type token; an empty one takes its default
 *                                (through the same rules), else is refused (R3: this page never sends a
 *                                missing or null one)
 *   prefillChoice(tool, kind)    {param, rule, why}: which parameter the graph tab's side panel fills
 *                                with a clicked entity's name (rules below), or none
 *   prefillFor(tool, name, kind) {[param]: name}, or {} when prefillChoice chose none
 *   prefillPlan(tool, name, kind)  {fill, run, choice, missing, values, kindLevel}: the side panel's
 *                                button (run at once, or open the card and ask for the empty parameters)
 *   consoleResult(rows, {hide, ontologyIds}), hideBookkeeping(rows), hiddenNote(r), capNote(graph)
 *                                what the console shows: the rows without the extraction's bookkeeping
 *                                (BOOKKEEPING_LABELS, BOOKKEEPING_TYPES; the ontology layer and the
 *                                entities are content) when "Hide the example's bookkeeping" is checked
 *                                (unchecked by default: every row shows), and the graph drawn from those
 *                                rows, capped after the filter
 *   storeIndexNames(lookups, ddl)  the index names SHOW INDEXES lists on a store this example made
 */
import * as cl from '../../../lib/relate_wasm.mjs';
import { MAX_DRAWN_NODES, MAX_DRAWN_RELS, capGraph, collectGraph, isNode, isRel } from './tonvl.js';
import { paramBindings, paramComparisons } from './convert.js';

const ASSETS = new URL('./assets/', import.meta.url);
const GLUE = 'relate-1.3.0/relate.js';
const VERSION = '1.3.0';
/** The only stores this worker opens: the engine's (D14 names), never another: a read-only open of a missing store leaves an empty one behind (R15). */
const STORE_URI = /^opfs:\/\/ex01-kg-[A-Za-z0-9_-]{1,56}$/;

/** @type {any} */
let mod = null;
let crashed = false;
/** SHOW PROCEDURES's names on this instance (the same for every store): the tools' notes read them. @type {string[]} */
let procedures = [];

async function ensure() {
  if (mod) return mod;
  const m = await import(new URL(GLUE, ASSETS).href);
  await m.default();
  const probe = new m.RelateDb();
  let v;
  try {
    v = cl.version(probe);
    procedures = cl.exec(probe, 'SHOW PROCEDURES YIELD name RETURN name ORDER BY name').rows.map((r) => String(r.name));
  } finally { probe.free(); }
  if (v !== VERSION) throw Object.assign(new Error(`the bundled Relate reports ${v}, not ${VERSION}`), { code: 'version' });
  mod = m;
  return mod;
}

/** @param {unknown} e */
function serialize(e) {
  if (cl.isTrap(e)) {
    crashed = true;
    return { code: 'trap', message: `The console's engine crashed (${e instanceof Error ? e.message : String(e)}); it is restarted.` };
  }
  if (e instanceof cl.RelateWasmError) return { code: 'engine', category: e.category, message: e.message, detail: e.detail };
  const message = e instanceof Error ? e.message : String(e);
  const category = cl.classify(message);
  if (category === 'locked') return { code: 'engine', category, message: message.split('\n')[0], detail: message };
  return { code: /** @type {any} */ (e)?.code ?? 'error', message };
}

/**
 * @param {{uri: string, query: string, params?: Record<string, any>|null, strict?: boolean}} m
 *   strict: an ontology tool's run: lib/relate_wasm.mjs refuses a null, missing or NaN parameter (R3)
 */
async function query({ uri, query, params, strict = false }) {
  if (typeof uri !== 'string' || !STORE_URI.test(uri)) throw Object.assign(new Error(`not a store this page made: ${uri}`), { code: 'usage' });
  if (typeof query !== 'string' || !query.trim()) throw Object.assign(new Error('an empty query'), { code: 'usage' });
  const m = await ensure();
  const t0 = performance.now();
  const db = await m.RelateDb.open(uri, true);
  try {
    const r = cl.exec(db, query, params ?? null, { allowNull: strict !== true });
    const ms = Math.round(performance.now() - t0);
    // An _IN or _OF relationship is the ontology's when both its ends are ontology-layer nodes, which
    // the rows may not hold: the page classifies it by the store's ontology node ids (a few hundred at most).
    const shared = [...collectGraph(r.rows).rels.values()].some((x) => SHARED_TYPES.includes(x.type));
    const ontologyIds = shared ? cl.exec(db, ONTOLOGY_NODE_IDS).rows.map((x) => x.id) : null;
    return { columns: r.columns, rows: r.rows, stats: r.stats, ontologyIds, ms };
  } finally {
    try { db.free(); } catch { /* a trapped handle cannot be freed; the page replaces this worker */ }
  }
}

/** @param {MessageEvent} ev */
async function onMessage(ev) {
  const m = ev.data ?? {};
  const reply = (/** @type {object} */ x) => self.postMessage({ id: m.id, ...x });
  if (crashed) return reply({ ok: false, error: { code: 'trap', message: 'this console worker crashed earlier; the page replaces it' } });
  try {
    if (m.kind === 'init') {
      await ensure();
      return reply({ ok: true, data: { version: VERSION, procedures } });
    }
    if (m.kind === 'query') return reply({ ok: true, data: await query(m) });
    return reply({ ok: false, error: { code: 'usage', message: `unknown kind ${JSON.stringify(m.kind)}` } });
  } catch (e) {
    return reply({ ok: false, error: serialize(e) });
  }
}
// The worker loop runs only in a worker: the page (app.js) and harness/run.mjs import this module for the tools' checks.
// @ts-ignore: WorkerGlobalScope exists in workers only
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) self.onmessage = onMessage;

// ---- the ontology's tools: read statically, their arguments checked (README "The ontology's tools") ----

/** What the extractor writes on a published entity (store.js publish), and on a typed relationship. */
export const ENTITY_PROPERTIES = Object.freeze(['key', 'kind', 'norm', 'name', 'display', 'docs', 'mentions', 'generation']);
export const RELATIONSHIP_PROPERTIES = Object.freeze(['generation', 'p', 'claims', 'sentences', 'docs']);
/** A variable-length pattern stays at 4 hops or fewer: an enumerating pattern grows with its bound, and the engine has no cancel. */
export const MAX_HOPS = 4;

const IDENT = String.raw`(?:\x60(?:[^\x60]|\x60\x60)+\x60|[\p{L}_][\p{L}\p{M}\p{N}_]*)`;
const unquote = (/** @type {string} */ s) => (s.startsWith('`') ? s.slice(1, -1).replaceAll('``', '`') : s);
/** The clause keywords a query is cut at (WITH after STARTS or ENDS is an operator, skipped). */
const CLAUSE = /\b(OPTIONAL\s+MATCH|MATCH|WHERE|WITH|RETURN|UNWIND|CALL|ORDER\s+BY|LIMIT|SKIP|YIELD|UNION|SET|DELETE|DETACH|MERGE|CREATE|REMOVE|FOREACH|SEARCH|USE|LOAD|FINISH)\b/giu;
const NODE = new RegExp(String.raw`\(\s*(${IDENT})?\s*((?::\s*${IDENT}\s*)(?:(?::|\|\s*:?|&)\s*${IDENT}\s*)*)?(\{[^{}]*\})?\s*\)`, 'gu');
const REL = new RegExp(String.raw`\[\s*(${IDENT})?\s*((?::\s*${IDENT}\s*)(?:\|\s*:?\s*${IDENT}\s*)*)?(\*\s*(\d*)\s*(\.\.)?\s*(\d*))?\s*(\{[^{}]*\})?\s*\]`, 'gu');
const BARE_REL = /\)\s*<?-\s*-\s*>?\s*\(/u;
const MAP_KEY = new RegExp(String.raw`(?:\{|,)\s*(${IDENT})\s*:`, 'gu');
const READ = new RegExp(String.raw`(?<![\p{L}\p{N}_.$\x60])(${IDENT})\s*\.\s*(${IDENT})`, 'gu');
const LABEL_TEST = new RegExp(String.raw`(?<![\p{L}\p{N}_.$\x60])(${IDENT})\s*:\s*(${IDENT})`, 'gu');
const PROC = new RegExp(String.raw`\bCALL\s+(${IDENT}(?:\s*\.\s*${IDENT})*)\s*\(`, 'gu');

/** The query with string literals and comments blanked (same length, quotes kept), so nothing is found inside them. @param {string} text */
export function blankCypher(text) {
  const q = String(text ?? '');
  let out = '';
  for (let i = 0; i < q.length;) {
    const c = q[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < q.length && q[j] !== c) j += q[j] === '\\' ? 2 : 1;
      out += c + ' '.repeat(Math.max(0, Math.min(j, q.length) - i - 1)) + (j < q.length ? c : '');
      i = j + 1;
    } else if (c === '/' && q[i + 1] === '/') {
      const j = q.indexOf('\n', i);
      const end = j < 0 ? q.length : j;
      out += ' '.repeat(end - i);
      i = end;
    } else if (c === '/' && q[i + 1] === '*') {
      const j = q.indexOf('*/', i + 2);
      const end = j < 0 ? q.length : j + 2;
      out += ' '.repeat(end - i);
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The $names a query reads, in order, outside strings, comments and backticks (as lib/relate_wasm.mjs scans them). @param {string} text */
export function cypherParams(text) {
  const s = String(text ?? '');
  /** @type {string[]} */
  const names = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"') { for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++; }
    else if (c === '`') { i = s.indexOf('`', i + 1); if (i < 0) break; }
    else if (c === '/' && s[i + 1] === '/') { i = s.indexOf('\n', i); if (i < 0) break; }
    else if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i + 2); if (i < 0) break; i++; }
    else if (c === '$') {
      const m = /^[\p{L}\p{N}_]+/u.exec(s.slice(i + 1));
      if (m && !names.includes(m[0])) names.push(m[0]);
      if (m) i += m[0].length;
    }
  }
  return names;
}

/** The keys of a pattern's property map (`{k: v, ...}`, blanked), or []. @param {string|undefined} map */
const mapKeys = (map) => (map ? [...map.matchAll(MAP_KEY)].map((m) => unquote(m[1])) : []);

/**
 * @typedef {{v: string|null, labels: string[], any: boolean, keys: string[], open: boolean}} NodePattern
 * @typedef {{v: string|null, types: string[], keys: string[], hops: number|null}} RelPattern
 * @typedef {{v: string, prop: string, on: 'node'|'rel'}} Read
 * @typedef {{optional: boolean, nested: boolean, nodes: NodePattern[], rels: RelPattern[], where: string, whereReads: Read[], untyped: boolean, at: number}} MatchPart
 * @typedef {{name: string, index: string|null, at: number, args: string[]}} ProcCall
 *   args: the call's arguments as written (strings blanked), split at top-level commas
 * @typedef {{params: string[], labels: string[], types: string[], reads: Read[], procedures: ProcCall[],
 *   hops: number[], bookkeeping: boolean, matches: MatchPart[], readsIn: (text: string) => Read[],
 *   clauses: Array<{kw: string, at: number, depth: number}>}} QueryReading
 */

/** A call's arguments in the blanked query, from just after its opening parenthesis: split at top-level commas, trimmed. @param {string} q @param {number} from */
function callArgs(q, from) {
  const out = [];
  let depth = 0;
  let last = from;
  for (let i = from; i < q.length; i++) {
    const c = q[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        out.push(q.slice(last, i).trim());
        return out.filter((x, k) => x !== '' || k > 0);
      }
      depth--;
    } else if (c === ',' && depth === 0) {
      out.push(q.slice(last, i).trim());
      last = i + 1;
    }
  }
  return out;
}

/**
 * A query read statically, without the engine: strings and comments blanked, cut at its clause
 * keywords; a MATCH inside braces (EXISTS { }, COUNT { }, CALL { }) is `nested`. A node pattern's
 * labels are all required (`:A:B`) or alternatives (`:A|B`, `any`); `open` when it has no label and
 * its variable never has one, so it can be any node, the example's own bookkeeping included. A
 * relationship pattern's `hops` is its upper bound (Infinity when unbounded), null when it is not
 * variable-length. Reads are `var.prop` on a variable some node or relationship pattern binds.
 * @param {string} cypher
 * @returns {QueryReading}
 */
export function readQuery(cypher) {
  const src = String(cypher ?? '');
  const q = blankCypher(src);
  /** @type {number[]} brace depth before each character */
  const depthAt = [];
  let d = 0;
  for (let i = 0; i < q.length; i++) {
    depthAt.push(d);
    if (q[i] === '{') d++;
    else if (q[i] === '}') d = Math.max(0, d - 1);
  }
  depthAt.push(d);
  const marks = [];
  for (const m of q.matchAll(CLAUSE)) {
    const kw = m[1].toUpperCase().replace(/\s+/g, ' ');
    if (kw === 'WITH' && /\b(?:STARTS|ENDS)\s*$/iu.test(q.slice(0, m.index))) continue;
    marks.push({ kw, at: m.index, body: m.index + m[0].length, depth: depthAt[m.index] });
  }
  const clauses = marks.map((mk, i) => ({ ...mk, text: q.slice(mk.body, i + 1 < marks.length ? marks[i + 1].at : q.length) }));

  /** @type {Array<{optional: boolean, nested: boolean, nodes: NodePattern[], rels: RelPattern[], where: string, untyped: boolean, at: number}>} */
  const parts = [];
  for (let i = 0; i < clauses.length; i++) {
    const c = clauses[i];
    if (c.kw !== 'MATCH' && c.kw !== 'OPTIONAL MATCH') continue;
    const next = clauses[i + 1];
    const where = next && next.kw === 'WHERE' && next.depth === c.depth ? next.text : '';
    const nodes = [...c.text.matchAll(NODE)].map((m) => {
      const part = m[2] ?? '';
      return { v: m[1] ? unquote(m[1]) : null, labels: part.split(/[:|&]/u).map((x) => x.trim()).filter(Boolean).map(unquote), any: /\|/u.test(part), keys: mapKeys(m[3]), open: false };
    });
    const rels = [...c.text.matchAll(REL)].map((m) => {
      const star = m[3] !== undefined;
      const hops = !star ? null : m[5] ? (m[6] ? Number(m[6]) : Infinity) : (m[4] ? Number(m[4]) : Infinity);
      return { v: m[1] ? unquote(m[1]) : null, types: (m[2] ?? '').split('|').map((x) => x.replace(/^\s*:?\s*/u, '').trim()).filter(Boolean).map(unquote), keys: mapKeys(m[7]), hops };
    });
    const untyped = rels.some((r) => !r.types.length) || BARE_REL.test(c.text);
    parts.push({ optional: c.kw !== 'MATCH', nested: c.depth > 0, nodes, rels, where, untyped, at: c.at });
  }
  const nodeVars = new Set(parts.flatMap((p) => p.nodes.map((n) => n.v)).filter((v) => v !== null));
  const relVars = new Set(parts.flatMap((p) => p.rels.map((r) => r.v)).filter((v) => v !== null));
  // A WITH that renames a variable (`WITH p AS q`) keeps what it is: q.embedding reads a node's property too.
  for (const c of clauses.filter((x) => x.kw === 'WITH')) {
    for (const m of c.text.matchAll(new RegExp(String.raw`(?<![\p{L}\p{N}_.$\x60])(${IDENT})\s+AS\s+(${IDENT})`, 'giu'))) {
      const [from, to] = [unquote(m[1]), unquote(m[2])];
      if (nodeVars.has(from)) nodeVars.add(to);
      else if (relVars.has(from)) relVars.add(to);
    }
  }
  const labelled = new Set(parts.flatMap((p) => p.nodes.filter((n) => n.labels.length).map((n) => n.v)).filter((v) => v !== null));
  for (const p of parts) for (const n of p.nodes) n.open = !n.labels.length && !(n.v !== null && labelled.has(n.v));

  /** @param {string} text @returns {Read[]} */
  const readsIn = (text) => {
    /** @type {Read[]} */
    const out = [];
    for (const m of text.matchAll(READ)) {
      const v = unquote(m[1]);
      const on = nodeVars.has(v) ? 'node' : relVars.has(v) ? 'rel' : null;
      if (on && !out.some((r) => r.v === v && r.prop === unquote(m[2]))) out.push({ v, prop: unquote(m[2]), on });
    }
    return out;
  };
  const labels = [];
  const types = [];
  const add = (/** @type {string[]} */ list, /** @type {string} */ x) => { if (!list.includes(x)) list.push(x); };
  for (const p of parts) {
    for (const n of p.nodes) for (const l of n.labels) add(labels, l);
    for (const r of p.rels) for (const t of r.types) add(types, t);
  }
  for (const c of clauses.filter((x) => x.kw === 'WHERE')) {
    for (const m of c.text.matchAll(LABEL_TEST)) if (nodeVars.has(unquote(m[1]))) add(labels, unquote(m[2]));
  }
  const procedures = [...q.matchAll(PROC)].map((m) => {
    const from = /** @type {number} */ (m.index) + m[0].length;
    const arg = /^\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/u.exec(src.slice(from));
    const name = m[1].split('.').map((x) => unquote(x.trim())).join('.');
    return { name, index: /^db\.index\./u.test(name) && arg ? arg[2] : null, at: /** @type {number} */ (m.index), args: callArgs(q, from) };
  });
  const matches = parts.map((p) => ({ ...p, whereReads: readsIn(p.where) }));
  return {
    readsIn,
    params: cypherParams(src),
    labels,
    types,
    reads: readsIn(q),
    procedures,
    hops: parts.flatMap((p) => p.rels.map((r) => r.hops)).filter((h) => h !== null),
    bookkeeping: parts.some((p) => p.untyped && (p.nodes.some((n) => n.open) || p.rels.some((r) => !r.types.length && r.hops !== null))),
    matches,
    clauses: clauses.map((c) => ({ kw: c.kw, at: c.at, depth: c.depth })),
  };
}

/**
 * The clauses that never leave a query with no rows when it had one: an OPTIONAL MATCH (and its
 * WHERE), a WITH without a WHERE, ORDER BY, USE. Anything else before a procedure call (a MATCH, an
 * UNWIND, a WHERE, another CALL, LIMIT, SKIP, ...) can end the query before the call is reached.
 */
const KEEPS_ROWS = new Set(['OPTIONAL MATCH', 'WITH', 'ORDER BY', 'USE']);

/**
 * Whether a query certainly reaches the procedure call at offset `at`: every clause before it keeps
 * its row (KEEPS_ROWS; a WHERE only as an OPTIONAL MATCH's), so the query starts with one row and
 * still has it at the call.
 * @param {QueryReading} a @param {number} at
 */
function certainlyReached(a, at) {
  let owner = '';
  for (const c of a.clauses.filter((x) => x.at < at)) {
    if (c.kw === 'WHERE') {
      if (owner !== 'OPTIONAL MATCH') return false;
      continue;
    }
    if (!KEEPS_ROWS.has(c.kw)) return false;
    owner = c.kw;
  }
  return true;
}

/** A blanked expression cut at a keyword (OR, AND) outside parentheses, brackets and braces. @param {string} text @param {string} word */
function splitTop(text, word) {
  const out = [];
  let depth = 0;
  let last = 0;
  const re = new RegExp(String.raw`\b${word}\b`, 'iuy');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (i === 0 || !/[\p{L}\p{N}_$]/u.test(text[i - 1]))) {
      re.lastIndex = i;
      if (re.test(text)) {
        out.push(text.slice(last, i));
        last = i + word.length;
        i = last - 1;
      }
    }
  }
  out.push(text.slice(last));
  return out;
}

/**
 * The never-written properties that make a WHERE false or null on every row, or null when some
 * branch can hold: cut at top-level OR, each branch at top-level AND; a test that reads only
 * properties the extractor never writes (and is no IS NULL test) never holds, so a branch with
 * one never holds, and a WHERE whose branches all never hold matches nothing. A branch that reads
 * no property (`$p = ''`) can hold. A coalesce() or CASE can turn null into a value that holds, so
 * a test with one counts only in the search idiom, `coalesce(x.p, '') CONTAINS $q` (or STARTS
 * WITH, ENDS WITH), false for the non-empty value a run must have. XOR is left alone.
 * @param {string} where  blanked @param {(r: Read) => boolean} unwritten @param {(text: string) => Read[]} readsIn
 */
function deadWhere(where, unwritten, readsIn) {
  if (!where.trim() || /\bXOR\b/iu.test(where)) return null;
  /** @type {string[]} */
  const props = [];
  for (const branch of splitTop(where, 'OR')) {
    let dead = false;
    for (const test of splitTop(branch, 'AND')) {
      const reads = readsIn(test);
      const isNull = /\bIS\s+NULL\b/iu.test(test.replace(/\bIS\s+NOT\s+NULL\b/giu, ' '));
      const fallback = /\b(?:coalesce\s*\(|CASE\b)/iu.test(test) && !(/\b(?:CONTAINS|STARTS\s+WITH|ENDS\s+WITH)\b/iu.test(test) && /\$/u.test(test) && !/\bCASE\b/iu.test(test));
      if (reads.length && !isNull && !fallback && reads.every(unwritten)) {
        dead = true;
        for (const r of reads) if (!props.includes(r.prop)) props.push(r.prop);
        break;
      }
    }
    if (!dead) return null;
  }
  return props;
}

/**
 * A vector procedure's query vector when it is null on an extracted graph: the literal null, or a
 * property the extractor never writes (`d.embedding`); else null.
 * @param {string} arg  the argument, blanked @param {QueryReading} a @param {(r: Read) => boolean} unwritten
 * @returns {{text: string, props: string[]}|null}
 */
function nullVector(arg, a, unwritten) {
  if (/^null$/iu.test(arg)) return { text: 'is null', props: [] };
  const reads = a.readsIn(arg);
  const whole = new RegExp(String.raw`^${IDENT}\s*\.\s*${IDENT}$`, 'u').test(arg);
  return whole && reads.length === 1 && unwritten(reads[0]) ? { text: `${arg.replace(/\s+/gu, '')} is never written (null)`, props: [reads[0].prop] } : null;
}

/**
 * What a tool can do on a graph this example extracted (see the header). Deterministic and
 * cheap: it never runs the query. A required MATCH is a top-level MATCH (not OPTIONAL, not in a
 * subquery); what it cannot match leaves the query with no rows.
 * @param {{type?: string, cypher?: string|null, url?: string|null}} tool
 * @param {{kinds?: Array<{id: string, ask?: any}>, links?: Array<{id: string}>, procedures?: string[]|null, indexes?: string[]|null}} [ctx]
 * @returns {{predict: Predict, reasons: Array<{predict: string, text: string}>, details: string[], text: string, reading: QueryReading|null}}
 */
const CLAUSE_START = /^(?:MATCH|OPTIONAL|WITH|RETURN|UNWIND|CALL|CREATE|MERGE|SET|DELETE|DETACH|REMOVE|FOREACH|UNION|LOAD|USE|FINISH)\b/iu;
const AGGREGATE = /\b(?:count|collect|sum|avg|min|max|stDev|stDevP|percentileCont|percentileDisc)\s*\(/iu;
const NOT_A_VARIABLE = new Set(['AND', 'OR', 'XOR', 'NOT', 'IS', 'NULL', 'TRUE', 'FALSE', 'IN', 'CASE', 'WHEN', 'THEN', 'ELSE',
  'END', 'STARTS', 'ENDS', 'WITH', 'CONTAINS', 'ASC', 'DESC', 'ASCENDING', 'DESCENDING', 'NAN', 'INFINITY']);

/**
 * The top-level pieces of a clause body split at `sep` (commas, or a keyword regexp's first match),
 * outside brackets, braces and parentheses. @param {string} s
 */
function topLevelCommas(s) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(from, i)); from = i + 1; }
  }
  out.push(s.slice(from));
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * An ORDER BY after an aggregating (or DISTINCT) WITH or RETURN that reads a variable the projection
 * does not keep: Relate refuses the statement before it runs, on any data (NOTES.md R20; Neo4j's rule:
 * such an ORDER BY may use only the projected names, or an expression the projection lists).
 * @param {string} cypher
 * @returns {{at: number, variable: string, clause: string} | null}
 */
export function unprojectedOrderBy(cypher) {
  const q = blankCypher(cypher);
  /** depth-0 offsets of each word start */
  const starts = [];
  let depth = 0;
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && /[A-Za-z]/u.test(c) && (i === 0 || !/[\w$.`]/u.test(q[i - 1]))) starts.push(i);
  }
  const at = (/** @type {RegExp} */ re) => starts.filter((i) => re.test(q.slice(i)));
  const clauses = at(CLAUSE_START);
  for (const k of at(/^(?:WITH|RETURN)\b/iu)) {
    const end = clauses.find((i) => i > k) ?? q.length;
    const word = /^(WITH|RETURN)/iu.exec(q.slice(k))?.[1] ?? '';
    const inside = starts.filter((i) => i > k && i < end);
    const find = (/** @type {RegExp} */ re) => inside.find((i) => re.test(q.slice(i)));
    const order = find(/^ORDER\s+BY\b/iu);
    if (order === undefined) continue;
    const projEnd = find(/^(?:ORDER\s+BY|WHERE|SKIP|LIMIT)\b/iu) ?? end;
    let proj = q.slice(k + word.length, projEnd).trim();
    const distinct = /^DISTINCT\b/iu.test(proj);
    if (distinct) proj = proj.replace(/^DISTINCT\b/iu, '');
    const items = topLevelCommas(proj);
    if (items.includes('*') || !(distinct || items.some((x) => AGGREGATE.test(x)))) continue;
    const norm = (/** @type {string} */ x) => x.replace(/\s+/gu, ' ').trim();
    const names = new Set();
    const exprs = new Set();
    for (const item of items) {
      const m = /^([\s\S]*?)\s+AS\s+(`[^`]+`|[A-Za-z_]\w*)$/iu.exec(item);
      if (m) { names.add(m[2].replace(/`/gu, '')); exprs.add(norm(m[1])); } else { exprs.add(norm(item)); if (/^[A-Za-z_]\w*$/u.test(item)) names.add(item); }
    }
    const orderEnd = inside.find((i) => i > order && /^(?:SKIP|LIMIT|WHERE)\b/iu.test(q.slice(i))) ?? end;
    for (let o of topLevelCommas(q.slice(order, orderEnd).replace(/^ORDER\s+BY/iu, ''))) {
      o = o.replace(/\s+(?:ASC|DESC|ASCENDING|DESCENDING)$/iu, '');
      if (exprs.has(norm(o)) || names.has(norm(o))) continue;
      for (const v of o.matchAll(/(?<![\w$.`])([A-Za-z_]\w*)\b(?!\s*\()(\s*\.\s*[A-Za-z_]\w*)?/gu)) {
        if (NOT_A_VARIABLE.has(v[1].toUpperCase()) || names.has(v[1])) continue;
        // v.p is allowed when the projection lists that very expression (`RETURN v.p, count(*) ORDER BY v.p`)
        if (v[2] && exprs.has(norm(`${v[1]}.${v[2].replace(/[\s.]/gu, '')}`))) continue;
        return { at: order, variable: v[1], clause: word.toUpperCase() };
      }
    }
  }
  return null;
}

export function toolCompat(tool, { kinds = [], links = [], procedures = null, indexes = null } = {}) {
  if (tool.type !== 'canonicalQuery' || typeof tool.cypher !== 'string' || !tool.cypher.trim()) {
    return { predict: 'not run', reasons: [], details: [], reading: null,
      text: `${tool.type ?? 'This'} tool${tool.url ? ` (${tool.url})` : ''}: not run by this page, which makes no network calls.` };
  }
  const a = readQuery(tool.cypher);
  const kindIds = new Set(kinds.map((k) => k.id));
  const asked = new Set(kinds.filter((k) => k.ask !== null).map((k) => k.id));
  const linkIds = new Set(links.map((l) => l.id));
  const own = (/** @type {string} */ x) => x.startsWith('_');
  const known = (/** @type {string} */ l) => own(l) || asked.has(l);
  const unwritten = (/** @type {Read} */ r) => !(r.on === 'rel' ? RELATIONSHIP_PROPERTIES : ENTITY_PROPERTIES).includes(r.prop);
  /** @type {Array<{predict: string, text: string, at?: number, prop?: string, props?: string[], covers?: string[]}>} */
  const reasons = [];
  if (procedures) {
    for (const p of a.procedures) if (!procedures.includes(p.name)) reasons.push({ predict: 'error', text: `it calls ${p.name}, which SHOW PROCEDURES does not list` });
  }
  const order = unprojectedOrderBy(tool.cypher);
  if (order) {
    reasons.push({ predict: 'error', at: order.at, text: `its ORDER BY reads ${order.variable}, which its aggregating ${order.clause} does not ` +
      'project: refused before it runs, on any data (R20)' });
  }
  /** where each required MATCH that can match nothing starts */
  const emptyAt = [];
  for (const m of a.matches.filter((x) => !x.optional && !x.nested)) {
    const before = reasons.length;
    for (const n of m.nodes) {
      const ok = n.labels.filter(known);
      if (n.labels.length && (n.any ? !ok.length : ok.length < n.labels.length)) {
        const bad = /** @type {string} */ (n.labels.find((l) => !known(l)));
        reasons.push({ predict: 'empty', at: m.at, text: kindIds.has(bad) ? `it needs ${bad}, a kind the model is never asked` : `it needs the label ${bad}, which this ontology does not have` });
      }
      for (const k of n.keys) if (!ENTITY_PROPERTIES.includes(k)) reasons.push({ predict: 'empty', at: m.at, prop: k, text: `it matches on ${k}, which the extractor never writes` });
    }
    for (const r of m.rels) {
      if (r.types.length && !r.types.some((t) => own(t) || linkIds.has(t))) reasons.push({ predict: 'empty', at: m.at, text: `it needs the relationship type ${r.types[0]}, which this ontology does not have` });
      for (const k of r.keys) if (!RELATIONSHIP_PROPERTIES.includes(k)) reasons.push({ predict: 'empty', at: m.at, prop: k, text: `it matches on ${k}, which the extractor never writes on a relationship` });
    }
    const dead = deadWhere(m.where, unwritten, a.readsIn);
    if (dead) {
      reasons.push({ predict: 'empty', at: m.at, props: dead, text: `its WHERE ${dead.length === 1 ? 'needs' : 'tests only'} ${dead.join(', ')}, which the extractor never writes` });
    }
    if (reasons.length > before) emptyAt.push(m.at);
  }
  // An index procedure on an index the store lacks errors when the query reaches it (IndexDoesNotExist), not
  // before. A null query vector returns no rows even on a missing index: no rows either way. A required MATCH before the call that matches nothing ends
  // the query first: no rows. Otherwise the note says 'an error' only when the call is certainly reached
  // (nothing before it can leave the query with no rows); when something can, 'an error if reached', since
  // the static reading cannot tell whether that clause finds rows. An index named by a parameter (or any
  // other expression) is 'checked at run': whether that index exists is known only then.
  for (const p of a.procedures) {
    if (!/^db\.index\./u.test(p.name)) continue;
    if (p.index === null) {
      const arg = (p.args[0] ?? '').trim();
      if (arg && !/^['"]/u.test(arg) && indexes) {
        reasons.push({ predict: 'checked at run', at: p.at, text: `${p.name} takes its index from ${arg.replace(/\s+/gu, ' ')}, so whether that index exists is checked at run (an error when it does not)` });
      }
      continue;
    }
    if (!indexes || indexes.includes(p.index)) continue;
    const what = `${p.name} needs the index '${p.index}', which this store does not have`;
    const vector = /^db\.index\.vector\.query/u.test(p.name) ? nullVector(p.args[2] ?? '', a, unwritten) : null;
    if (vector) reasons.push({ predict: 'empty', at: p.at, covers: vector.props, text: `${what}, but its query vector ${vector.text}, and a null query vector returns no rows even on a missing index` });
    else if (emptyAt.some((at) => at < p.at)) reasons.push({ predict: 'empty', at: p.at, text: `${what}: it would error if reached` });
    else if (certainlyReached(a, p.at)) reasons.push({ predict: 'error', at: p.at, text: `${what}: the call errors` });
    else reasons.push({ predict: 'error if reached', at: p.at, text: `${what}: the call errors if the query reaches it (a clause before it can leave no rows)` });
  }
  // A required MATCH that matches nothing makes the query empty only when no call that may error comes before
  // it: `MATCH (p) CALL <missing index> ... MATCH (x:Nope)` errors as soon as a p reaches the call.
  const unsure = reasons.filter((r) => r.predict === 'error if reached' || r.predict === 'checked at run');
  for (const r of reasons) {
    if (r.predict === 'empty' && unsure.some((u) => /** @type {number} */ (u.at) < /** @type {number} */ (r.at ?? -1))) r.predict = 'empty after a call';
  }
  const predict = /** @type {Predict} */ (PREDICTS.find((x) => reasons.some((r) => r.predict === x)) ?? 'rows');
  const lead = reasons.find((r) => r.predict === predict);
  /** @type {string[]} */
  const details = [];
  // The other reasons that are not a property (the properties are listed next), each once.
  for (const r of reasons) {
    const t = r.predict === 'empty after a call' ? `after the call, ${r.text}` : `also ${r.text}`;
    if (r !== lead && ((r.prop === undefined && r.props === undefined) || r.predict === 'empty after a call') && !details.includes(t)) details.push(t);
  }
  // A parameter compared only where it cannot pick the rows (convert.js paramComparisons' scope).
  const comparisons = paramComparisons(tool.cypher);
  for (const p of a.params) {
    const cs = comparisons.filter((c) => c.param === p);
    if (!cs.length || cs.some((c) => c.scope === 'match')) continue;
    if (cs.some((c) => c.scope === 'optional')) details.push(`$${p} only filters an OPTIONAL MATCH: rows without a match still come back`);
    else if (cs.some((c) => c.scope === 'subquery')) details.push(`$${p} is compared only inside a subquery (EXISTS, COUNT, COLLECT or CALL { }), never with the nodes the query returns`);
  }
  const named = new Set([lead?.prop, ...(lead?.props ?? []), ...reasons.flatMap((r) => r.covers ?? [])]);
  const props = [...new Set(a.reads.filter(unwritten).map((r) => r.prop))].filter((x) => !named.has(x));
  if (props.length) details.push(`${props.join(', ')} ${props.length === 1 ? 'is' : 'are'} never written (null)`);
  const hops = Math.max(-1, ...a.hops);
  if (hops > MAX_HOPS) {
    details.push(hops === Infinity ? 'an unbounded variable-length pattern (the engine has no cancel: bound it, e.g. *1..4)' : `a variable-length pattern of up to ${hops} hops, over this page's bound of ${MAX_HOPS}`);
  }
  const elsewhere = [...a.labels.filter((l) => !kindIds.has(l) && !own(l)), ...a.types.filter((t) => !linkIds.has(t) && !own(t))]
    .filter((x) => !reasons.some((r) => r.text.includes(` ${x},`)));
  if (elsewhere.length) details.push(`it also names ${elsewhere.join(', ')}, which this ontology does not have`);
  if (a.bookkeeping) details.push('an untyped relationship also reaches the store\'s bookkeeping (_Mention -[:_OF]-> each entity), which the console\'s "Hide the example\'s bookkeeping" leaves out');
  const head = predict === 'rows' ? 'can return rows' : `${PREDICT_HEAD[predict]} (${lead?.text})`;
  return { predict, reasons, details, reading: a, text: `On an extracted graph: ${head}${details.length ? `; ${details.join('; ')}` : ''}.` };
}

/**
 * @typedef {'rows'|'empty'|'error'|'error if reached'|'checked at run'|'not run'} Predict
 *   what toolCompat says a tool can do on an extracted graph, and the outcomes each allows:
 *   rows {rows, empty} ("can return rows": rows, got none, is no miss); empty {empty}; error {error};
 *   error if reached {error, empty}; checked at run {rows, empty, error}
 */
/** The predictions in precedence order: the first a reason makes is the note's (certain before uncertain). */
export const PREDICTS = Object.freeze(/** @type {Predict[]} */ (['error', 'empty', 'error if reached', 'checked at run']));
/** The outcomes of a run (rows, empty, error) each prediction allows. */
export const PREDICT_ALLOWS = Object.freeze({
  rows: ['rows', 'empty'], empty: ['empty'], error: ['error'], 'error if reached': ['error', 'empty'], 'checked at run': ['rows', 'empty', 'error'], 'not run': [],
});
const PREDICT_HEAD = { empty: 'no rows', error: 'an error', 'error if reached': 'an error if reached', 'checked at run': 'checked at run' };

/**
 * How a query uses one $parameter (strings and comments blanked): `uses` its occurrences;
 * `toInteger` those written `toInteger($p)`; `limit` whether it is a LIMIT or SKIP count, directly
 * or through toInteger().
 * @param {string} cypher @param {string} name
 */
export function paramUse(cypher, name) {
  const q = blankCypher(cypher);
  const esc = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const end = String.raw`(?![\p{L}\p{N}_])`;
  const count = (/** @type {string} */ re) => [...q.matchAll(new RegExp(re, 'giu'))].length;
  return {
    uses: count(String.raw`\$${esc}${end}`),
    toInteger: count(String.raw`\btoInteger\s*\(\s*\$${esc}\s*\)`),
    limit: count(String.raw`\b(?:LIMIT|SKIP)\s+(?:toInteger\s*\(\s*)?\$${esc}${end}`) > 0,
  };
}

/**
 * A tool's parameters as the page shows and checks them. Every parameter without a default is
 * required: a missing one is refused and a null one matches nothing in a property map (R3), so
 * the page never sends one. `hint` is a value the description suggests ("(default: 10)"; create-context-
 * graph writes defaults there), prefilled but not applied; `emptyOk` when the query tests `$p = ''`
 * itself (an empty STRING means "all" there). `integer`: a STRING the query reads only through
 * toInteger() (create-context-graph's `LIMIT toInteger($limit)`), which the page takes as a whole
 * number and sends as its digits, the STRING the tool declares (toInteger("2.7") would cut it to 2,
 * and "abc" would reach LIMIT as null). `nonNegative`: a LIMIT or SKIP count (a negative one is an
 * engine error).
 * @param {{cypher?: string|null, parameters?: any[]}} tool
 * @returns {Array<{name: string, type: string, description: string, required: boolean, default: any, oneOf: any[]|null, hint: string|null, emptyOk: boolean,
 *   integer: boolean, nonNegative: boolean}>}
 */
export function toolParams(tool) {
  const cy = typeof tool.cypher === 'string' ? tool.cypher : '';
  return (Array.isArray(tool.parameters) ? tool.parameters : []).filter((p) => p && typeof p.name === 'string' && p.name).map((p) => {
    const type = typeof p.type === 'string' && p.type.trim() ? p.type.trim().toUpperCase().replace(/\s+/gu, ' ') : 'ANY';
    const hasDefault = Object.hasOwn(p, 'default') && p.default !== null && p.default !== undefined;
    const description = typeof p.description === 'string' ? p.description : '';
    const hint = /\(default:?\s*([^)]+?)\s*\)/iu.exec(description)?.[1] ?? null;
    const esc = p.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const use = paramUse(cy, p.name);
    return {
      name: p.name, type, description, required: !hasDefault, default: hasDefault ? p.default : undefined,
      oneOf: Array.isArray(p.one_of) && p.one_of.length ? p.one_of : null, hint,
      emptyOk: type === 'STRING' && new RegExp(String.raw`\$${esc}\s*=\s*(?:''|"")|(?:''|"")\s*=\s*\$${esc}(?![\p{L}\p{N}_])`, 'u').test(cy),
      integer: type === 'STRING' && use.uses > 0 && use.toInteger === use.uses,
      nonNegative: use.limit,
    };
  });
}

const INT = /^[+-]?\d+$/u;
const NUM = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/u;

/**
 * One value typed as text, by a type token: {ok, value} or {ok: false, message}. STRING as typed;
 * INTEGER a whole number in JavaScript's safe range; FLOAT a decimal number (R5: an integral one binds
 * as INTEGER, which every comparison accepts); BOOLEAN true or false; DATE and DATETIME ISO text (JSON
 * has no temporal type: the query converts it); LIST<T> a JSON array or comma-separated values, each a
 * T; anything else JSON, else the text.
 * @param {string} type @param {string} text
 * @returns {{ok: true, value: any} | {ok: false, message: string}}
 */
export function typedValue(type, text) {
  const t = String(text);
  const v = t.trim();
  const list = /^LIST\s*<\s*(.+)\s*>$/u.exec(type);
  if (list) {
    /** @type {any[]} */
    let items;
    if (v.startsWith('[')) {
      try { items = JSON.parse(v); } catch { return { ok: false, message: 'not a JSON list' }; }
      if (!Array.isArray(items)) return { ok: false, message: 'not a JSON list' };
    } else items = v.split(',').map((x) => x.trim()).filter((x) => x !== '');
    if (!items.length) return { ok: false, message: 'an empty list' };
    const out = [];
    for (const x of items) {
      if (x === null) return { ok: false, message: 'a null in the list (a null matches nothing, R3)' };
      const r = typeof x === 'string' ? typedValue(list[1], x) : { ok: true, value: x };
      if (!r.ok) return { ok: false, message: `${JSON.stringify(x)}: ${/** @type {any} */ (r).message}` };
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  switch (type) {
    case 'STRING': return { ok: true, value: t };
    case 'INTEGER': case 'INT':
      return INT.test(v) && Number.isSafeInteger(Number(v)) ? { ok: true, value: Number(v) } : { ok: false, message: `${JSON.stringify(t)} is not a whole number` };
    case 'FLOAT':
      return NUM.test(v) && Number.isFinite(Number(v)) ? { ok: true, value: Number(v) } : { ok: false, message: `${JSON.stringify(t)} is not a number` };
    case 'BOOLEAN': case 'BOOL':
      return /^(?:true|false)$/iu.test(v) ? { ok: true, value: v.toLowerCase() === 'true' } : { ok: false, message: `${JSON.stringify(t)} is not true or false` };
    case 'DATE':
      return DATE.test(v) ? { ok: true, value: v } : { ok: false, message: `${JSON.stringify(t)} is not a date (YYYY-MM-DD)` };
    case 'DATETIME': case 'LOCAL DATETIME': case 'ZONED DATETIME': case 'LOCALDATETIME':
      return DATETIME.test(v) ? { ok: true, value: v } : { ok: false, message: `${JSON.stringify(t)} is not an ISO date and time` };
    default:
      try { return { ok: true, value: JSON.parse(v) }; } catch { return { ok: true, value: t }; }
  }
}

/**
 * The typed arguments for a tool run, from the text typed for each parameter (raw: {name: text}).
 * An empty value takes the parameter's default, or stays '' where the query tests `$p = ''`
 * itself; otherwise it is refused, as is a value its type token or one_of refuses, and a $name the
 * query reads that the tool does not declare. Never null (R3).
 * @param {{cypher?: string|null, parameters?: any[]}} tool @param {Record<string, string|null|undefined>} [raw]
 * @returns {{ok: boolean, params: Record<string, any>, problems: Array<{name: string, message: string}>}}
 */
export function toolArgs(tool, raw = {}) {
  const specs = toolParams(tool);
  /** @type {Record<string, any>} */
  const params = {};
  /** @type {Array<{name: string, message: string}>} */
  const problems = [];
  for (const s of specs) {
    const text = raw[s.name] === undefined || raw[s.name] === null ? '' : String(raw[s.name]);
    /** @type {{ok: true, value: any} | {ok: false, message: string}} */
    let r;
    // An empty input takes the declared default, through the same rules as a typed value; a message then names
    // the default ("the default \"abc\" is not a whole number"), never the empty input.
    const fromDefault = text.trim() === '' && s.default !== undefined;
    const d = s.default;
    const shown = fromDefault ? `the default ${JSON.stringify(d)}` : JSON.stringify(text);
    /** A typedValue message about `t`, said of the default when the value is the default. @param {string} msg @param {string} t */
    const named = (msg, t) => (fromDefault && msg.startsWith(JSON.stringify(t)) ? `${shown}${msg.slice(JSON.stringify(t).length)}` : fromDefault ? `${shown}: ${msg}` : msg);
    const NOT_WHOLE = 'is not a whole number (the query reads it through toInteger(), which would cut 2.7 to 2 and make "abc" null)';
    if (text.trim() === '' && !fromDefault) {
      if (s.emptyOk) r = { ok: true, value: '' };
      else {
        problems.push({ name: s.name, message: `$${s.name} needs a value: a missing or empty parameter is refused (a null one would match nothing, R3).` });
        continue;
      }
    } else if (s.integer) {
      // A STRING read only through toInteger(): a whole number, sent as its digits (the declared STRING), a default too.
      const t = fromDefault ? (typeof d === 'string' ? d : typeof d === 'number' ? String(d) : null) : text;
      const r1 = t === null ? null : typedValue('INTEGER', t);
      r = r1?.ok ? { ok: true, value: String(r1.value) } : { ok: false, message: `${shown} ${NOT_WHOLE}` };
    } else if (fromDefault) {
      const needsText = typeof d === 'string' || (s.type === 'INTEGER' && !Number.isSafeInteger(d)) || (s.type === 'FLOAT' && typeof d !== 'number') ||
        (s.type === 'BOOLEAN' && typeof d !== 'boolean') || (s.type.startsWith('LIST') && !Array.isArray(d));
      const t = typeof d === 'string' ? d : JSON.stringify(d);
      if (s.type === 'STRING') r = { ok: true, value: typeof d === 'string' ? d : typeof d === 'number' || typeof d === 'boolean' ? String(d) : t };
      else if (needsText) {
        const r1 = typedValue(s.type, t);
        r = r1.ok ? r1 : { ok: false, message: named(/** @type {any} */ (r1).message, t) };
      } else r = { ok: true, value: d };
    } else r = typedValue(s.type, text);
    if (r.ok && s.nonNegative && Number(r.value) < 0) r = { ok: false, message: `${fromDefault ? shown : JSON.stringify(text.trim())} is negative; a LIMIT or SKIP count is 0 or more` };
    if (!r.ok) {
      problems.push({ name: s.name, message: `$${s.name} (${s.integer ? 'STRING, a whole number' : s.type}): ${/** @type {any} */ (r).message}.` });
      continue;
    }
    if (s.oneOf && !s.oneOf.some((o) => JSON.stringify(o) === JSON.stringify(r.value))) {
      problems.push({ name: s.name, message: `$${s.name} must be one of ${s.oneOf.map((o) => JSON.stringify(o)).join(', ')}.` });
      continue;
    }
    params[s.name] = r.value;
  }
  for (const n of cypherParams(tool.cypher ?? '')) {
    if (!specs.some((s) => s.name === n)) problems.push({ name: n, message: `The query reads $${n}, which the tool does not declare, so it has no value (R3).` });
  }
  return { ok: !problems.length, params, problems };
}

/** A property that holds an entity's name: name, title, username, headline, address, or *_name, *_title. */
export const NAME_PROPERTY = /^(?:name|title|username|headline|address)$|_(?:name|title)$/u;
/** A parameter named like a name or a search: name, query, term, title, search, keyword, q, or *_name, *_query, ... */
export const NAME_PARAMETER = /^(?:name|query|term|title|search|keyword|q)$|_(?:name|query|term|title|search|keyword)$/u;
/** An identifier or a code, never an entity's name: id, status, quarter, ticker, doi, key, or *_id, *_type, *_code, *_number, *_status, *_key. */
export const ID_LIKE = /^(?:id|status|quarter|ticker|doi|key)$|_(?:id|type|code|number|status|key)$/u;

/**
 * Which parameter the graph tab's side panel fills with a clicked entity's name, for an entity of
 * `kind` (the tool's own node by default). Only a STRING parameter that is neither a whole number
 * (toolParams' `integer`, read through toInteger()), a LIMIT or SKIP count, nor limited to one_of:
 *   'property'  the first the query compares with a name-like property (NAME_PROPERTY) of a variable
 *               of that kind, in a property map or a WHERE that filters the rows it returns
 *               (convert.js paramBindings with scope 'match': `{name: $x}`, `v.name = $x`,
 *               `toLower(v.name) = toLower($x)`, `toLower(v.title) CONTAINS toLower($x)`; not in an
 *               OPTIONAL MATCH or a subquery, which pick no rows), whatever the parameter's own name
 *               (legal's `$case_number`, compared with `c.title` too);
 *   'name'      else the first named like a name or a search (NAME_PARAMETER), unless its name is
 *               id-like (ID_LIKE), or the query compares it (any comparison: convert.js
 *               paramComparisons, `<>`, `<`, `=~ '…' + $q`, function-wrapped, an OPTIONAL MATCH's
 *               included) with an id-like property, or with a property of a variable that is not of
 *               that kind (an unlabelled one included);
 *   null        else none: the side panel runs the tool only when every parameter has a value without
 *               the name (prefillPlan), and otherwise asks for them (`get_account_by_id` has only `$id`).
 * @param {{cypher?: string|null, parameters?: any[], anchor?: {label?: string}}} tool @param {string|undefined} [kind]
 * @returns {{param: string|null, rule: 'property'|'name'|null, why: string}}
 */
export function prefillChoice(tool, kind = tool.anchor?.label) {
  const specs = toolParams(tool);
  if (!specs.length) return { param: null, rule: null, why: 'no parameters' };
  const strings = specs.filter((s) => s.type === 'STRING' && !s.integer && !s.nonNegative && !s.oneOf);
  if (!strings.length) return { param: null, rule: null, why: 'no text parameter for a name' };
  const cypher = typeof tool.cypher === 'string' ? tool.cypher : '';
  // Only a binding that filters the rows the query returns: one in an OPTIONAL MATCH or a subquery picks nothing.
  const bindings = paramBindings(cypher).filter((b) => b.scope === 'match');
  const comparisons = paramComparisons(cypher);
  const ofKind = (/** @type {{labels: string[]}} */ x) => kind !== undefined && x.labels.includes(kind);
  for (const s of strings) {
    const b = bindings.find((x) => x.param === s.name && ofKind(x) && x.props.some((p) => NAME_PROPERTY.test(p)));
    if (b) return { param: s.name, rule: 'property', why: `compared with ${b.v}.${b.props.find((p) => NAME_PROPERTY.test(p))} of (${b.v}:${kind}) (${b.op === 'map' ? 'in a property map' : b.op})` };
  }
  for (const s of strings) {
    if (!NAME_PARAMETER.test(s.name) || ID_LIKE.test(s.name)) continue;
    const own = comparisons.filter((x) => x.param === s.name);
    if (own.some((x) => x.props.every((p) => ID_LIKE.test(p)))) continue;
    if (own.some((x) => !ofKind(x))) continue;
    return { param: s.name, rule: 'name', why: `named like a name or a search${own.length ? '' : ', compared with no property'}` };
  }
  return { param: null, rule: null, why: 'no parameter takes a name' };
}

/**
 * The values the graph tab's side panel fills in for a clicked entity of `kind` named `name`
 * (prefillChoice), or {} when no parameter takes it.
 * @param {{cypher?: string|null, parameters?: any[], anchor?: {label?: string}}} tool @param {string} name @param {string} [kind]
 * @returns {Record<string, string>}
 */
export function prefillFor(tool, name, kind) {
  const c = prefillChoice(tool, kind);
  return c.param ? { [c.param]: name } : {};
}

/**
 * The value a tool card's input starts with, as text, or null when it starts empty: the default, the
 * value its description suggests ("(default: 10)"), a one_of's or a BOOLEAN's first option, or ''
 * where the query tests `$p = ''` itself (a value: empty means all there).
 * @param {ReturnType<typeof toolParams>[number]} s @returns {string|null}
 */
export function startValue(s) {
  if (s.default !== undefined) return typeof s.default === 'string' ? s.default : JSON.stringify(s.default);
  if (s.hint !== null) return s.hint;
  if (s.oneOf) return typeof s.oneOf[0] === 'string' ? s.oneOf[0] : JSON.stringify(s.oneOf[0]);
  if (s.type === 'BOOLEAN' || s.type === 'BOOL') return 'true';
  if (s.emptyOk) return '';
  return null;
}

/**
 * What the side panel's button does for a clicked entity: {fill, run, choice, missing, values,
 * kindLevel}. It asks only when a parameter has no value: not the entity's name (prefillChoice), no
 * declared default, no value its description suggests, no first option (startValue). Then it opens
 * the tool's card with the inputs as they start and asks for `missing`, those empty ones only; nothing
 * runs. Otherwise it runs at once, with `values` (the name where it goes, every other parameter at its
 * start). `kindLevel`: it runs with no parameter bound to the entity (no parameters, or all at their
 * start), as a tool about the kind, like a parameterless one.
 * @param {{cypher?: string|null, parameters?: any[], anchor?: {label?: string}}} tool @param {string} name @param {string} [kind]
 */
export function prefillPlan(tool, name, kind) {
  const specs = toolParams(tool);
  const choice = prefillChoice(tool, kind);
  /** @type {Record<string, string>} */
  const fill = choice.param && name ? { [choice.param]: name } : {};
  /** @type {Record<string, string|null>} */
  const values = Object.fromEntries(specs.map((s) => [s.name, Object.hasOwn(fill, s.name) ? fill[s.name] : startValue(s)]));
  const missing = specs.filter((s) => values[s.name] === null).map((s) => s.name);
  const run = missing.length === 0;
  return { fill, run, choice, missing, values, kindLevel: run && Object.keys(fill).length === 0 };
}

// ---- the example's bookkeeping in a result (the console's "Hide the example's bookkeeping") ----

/**
 * The labels of the extraction's own records (store.js: the documents, sections and sentences read,
 * the model's answers, mentions, claims, runs, verdicts, gold rows): bookkeeping, hidden when the
 * console's "Hide the example's bookkeeping" is checked (it starts unchecked).
 * An allowlist: a `_` label not listed here (a later build's) shows, and audit.txt fails unless every
 * internal label (ontology.js INTERNAL_LABELS) is either this, the ontology layer or `_Entity`.
 */
export const BOOKKEEPING_LABELS = Object.freeze(['_Document', '_Section', '_Sentence', '_Inference', '_InferencePart', '_Mention', '_Claim', '_Run',
  '_Verdict', '_Gold']);
/** The ontology layer (ontology.js): the stored document and the kinds, links and aliases derived from it. Content: shown. */
export const ONTOLOGY_LABELS = Object.freeze(['_Ontology', '_Kind', '_LinkType', '_Alias']);
/** The published entities (`_Entity` beside its kind): the knowledge graph. Shown. */
export const ENTITY_LABEL = '_Entity';
/** Relationship types only the extraction's records use (store.js): bookkeeping. */
export const BOOKKEEPING_TYPES = Object.freeze(['_HEAD', '_TAIL', '_EVIDENCE', '_READ', '_ON', '_INFERRED']);
/** Relationship types only the ontology layer uses (_LinkType -> _Kind): shown. */
export const ONTOLOGY_TYPES = Object.freeze(['_DOMAIN', '_RANGE']);
/** Types both use: the ontology's when both ends are ontology-layer nodes (_Kind -[:_IN]-> _Ontology, _Alias -[:_OF]-> _Kind), else bookkeeping. */
export const SHARED_TYPES = Object.freeze(['_IN', '_OF']);
/** The ids of a store's ontology-layer nodes (the console worker runs it when the rows hold an _IN or _OF relationship). */
export const ONTOLOGY_NODE_IDS = ONTOLOGY_LABELS.map((l) => `MATCH (n:${l}) RETURN id(n) AS id`).join(' UNION ALL ');

/** A node of the extraction's records: a BOOKKEEPING_LABELS label, and no `_Entity`. @param {any} n */
export const isBookkeepingNode = (n) => isNode(n) && !n.labels.includes(ENTITY_LABEL) && n.labels.some((/** @type {string} */ l) => BOOKKEEPING_LABELS.includes(l));

/**
 * A relationship of the extraction's records: a BOOKKEEPING_TYPES type, or an _IN or _OF one whose
 * ends are not both ontology-layer nodes (`ontologyIds`, node ids as strings).
 * @param {any} r @param {Set<string>} ontologyIds
 */
export function isBookkeepingRel(r, ontologyIds) {
  if (!isRel(r)) return false;
  if (BOOKKEEPING_TYPES.includes(r.type)) return true;
  if (!SHARED_TYPES.includes(r.type)) return false;
  return !(ontologyIds.has(String(r.start_node)) && ontologyIds.has(String(r.end_node)));
}

/**
 * A path as the engine returns it (R4: a flat list, node, relationship, node, ...), each relationship
 * joining its neighbours. A one-node list is not taken for a path (a zero-length path and `[m]` look
 * alike): it is a list. @param {unknown} v @returns {v is any[]}
 */
export function isPath(v) {
  if (!Array.isArray(v) || v.length < 3 || v.length % 2 === 0) return false;
  for (let i = 0; i < v.length; i++) if (i % 2 ? !isRel(v[i]) : !isNode(v[i])) return false;
  for (let i = 1; i < v.length; i += 2) {
    const ends = [String(v[i].start_node), String(v[i].end_node)];
    if (!ends.includes(String(v[i - 1].id)) || !ends.includes(String(v[i + 1].id))) return false;
  }
  return true;
}

/**
 * Rows without the extraction's bookkeeping. A row is left out when a top-level column is a
 * bookkeeping node or relationship, or a path through one; inside a list or a map (`collect(m)`,
 * `{mention: m}`) the bookkeeping values are dropped and the row stays. {rows, hidden, removed}:
 * the rows shown (a row with nothing dropped is the same object), how many were left out, and how
 * many values were dropped inside lists and maps. `ontologyIds`: the store's ontology-layer node ids
 * (the console worker's ONTOLOGY_NODE_IDS); without them, those in the rows.
 * @param {any[]} rows @param {{ontologyIds?: Array<string|number>|null}} [opts]
 */
export function hideBookkeeping(rows, { ontologyIds = null } = {}) {
  const ids = new Set(ontologyIds ? ontologyIds.map(String)
    : [...collectGraph(rows).nodes.values()].filter((n) => n.labels.some((l) => ONTOLOGY_LABELS.includes(l))).map((n) => String(n.id)));
  const bk = (/** @type {any} */ x) => (isNode(x) ? isBookkeepingNode(x) : isRel(x) ? isBookkeepingRel(x, ids)
    : isPath(x) ? x.some((e) => (isNode(e) ? isBookkeepingNode(e) : isBookkeepingRel(e, ids))) : false);
  let removed = 0;
  /** @param {any} v @returns {any} */
  const strip = (v) => {
    if (Array.isArray(v)) {
      const out = [];
      for (const x of v) {
        if (bk(x)) removed++;
        else out.push(strip(x));
      }
      return out;
    }
    if (!v || typeof v !== 'object' || isNode(v) || isRel(v)) return v;
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (bk(x)) removed++;
      else out[k] = strip(x);
    }
    return out;
  };
  const shown = [];
  let hidden = 0;
  for (const row of rows) {
    if (Object.values(row ?? {}).some(bk)) {
      hidden++;
      continue;
    }
    const before = removed;
    const out = strip(row);
    shown.push(removed === before ? row : out);
  }
  return { rows: shown, hidden, removed };
}

/**
 * What the console shows of a result: the rows (without the bookkeeping when `hide`, hideBookkeeping)
 * and the graph NVL draws, collected from those rows only (an entity in a hidden row is never drawn),
 * then capped (tonvl.js capGraph: the first MAX_DRAWN_NODES nodes in result order and the
 * relationships among them), so the cap applies to what is drawn.
 * @param {any[]} rows @param {{hide?: boolean, ontologyIds?: Array<string|number>|null, maxNodes?: number, maxRels?: number}} [opts]
 */
export function consoleResult(rows, { hide = false, ontologyIds = null, maxNodes = MAX_DRAWN_NODES, maxRels = MAX_DRAWN_RELS } = {}) {
  const f = hide ? hideBookkeeping(rows, { ontologyIds }) : { rows, hidden: 0, removed: 0 };
  return { ...f, total: rows.length, graph: capGraph(collectGraph(f.rows), { maxNodes, maxRels }) };
}

/**
 * The line beside the toggle: "N of M rows hidden (bookkeeping)." and ", and K values inside
 * lists/maps" when values were dropped inside lists or maps; '' when nothing was left out.
 * @param {{hidden: number, removed: number, total: number}} r
 */
export function hiddenNote({ hidden, removed, total }) {
  const n = (/** @type {number} */ x) => x.toLocaleString('en');
  const values = `${n(removed)} value${removed === 1 ? '' : 's'} inside lists/maps`;
  if (hidden) return `${n(hidden)} of ${n(total)} row${total === 1 ? '' : 's'} hidden (bookkeeping)${removed ? `, and ${values}` : ''}.`;
  return removed ? `${values} hidden (bookkeeping).` : '';
}

/**
 * The status line's sentence on the graph cap, from the graph drawn (consoleResult's, after the
 * bookkeeping is left out), or '' when nothing was cut.
 * @param {{nodes: any[], rels: any[], total: {nodes: number, rels: number}, capped: boolean}} g
 */
export function capNote(g) {
  if (!g.capped) return '';
  const n = (/** @type {number} */ x) => x.toLocaleString('en');
  const shown = [
    g.total.nodes ? `${n(g.nodes.length)} of ${n(g.total.nodes)} nodes` : '',
    g.total.rels ? `${n(g.rels.length)} of ${n(g.total.rels)} relationships` : '',
  ].filter(Boolean).join(' and ');
  return `The graph shows the first ${shown}: the console draws at most ${n(MAX_DRAWN_NODES)} nodes (relationship ends included) and ${n(MAX_DRAWN_RELS)} relationships.`;
}

/** The two LOOKUP indexes (labels, relationship types) every store starts with, under fixed names (NOTES.md R9). */
export const ENGINE_INDEXES = Object.freeze(['index_1b9dcc97', 'index_460996c0']);

/**
 * The index names SHOW INDEXES lists on a store this example made: the engine's built-in LOOKUP
 * indexes, its lookup indexes and the index behind each UNIQUE constraint and full-text index
 * (store.js, ontology.js), sorted.
 * @param {readonly string[]} lookups  index names @param {readonly string[]} ddl  CREATE CONSTRAINT / CREATE ... INDEX statements
 */
export function storeIndexNames(lookups, ddl) {
  const names = new Set([...ENGINE_INDEXES, ...lookups]);
  for (const s of ddl) {
    const m = /^CREATE\s+(?:[A-Z]+\s+)?(?:INDEX|CONSTRAINT)\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(s);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}
