// @ts-check
/**
 * convert.js: create-context-graph's domain files, the format this example read before it read
 * Ontology Graph Spec v1 documents, converted one way into v1 (ogs.js), deterministically: the same
 * file gives the same document, byte for byte, through ogs.js toYaml. harness/convert.mjs writes
 * data/ontologies/ogs/ with it, and the page converts a pasted or uploaded file with it. (edgextract's
 * ontology YAML, which earlier builds also converted, is no longer read: README "The ontology format".)
 *
 *   fromCreateContextGraph(text, {bases})  // {doc, report}: create-context-graph's domain files
 *
 * It throws OntologyError (ogs.js) with the plain-English reasons the format's reader gave before
 * (harness/ontology.mjs pins them), in the same order: a converted document is one the old reader
 * accepted. The checks that are about the model (phrases, choices per kind pair, what the model is
 * asked) run on the v1 document, in ontology.js, for every document alike. `report` lists what the
 * conversion decided: {tools: [{name, anchor: 'node'|'relationship', element, rule}], types: [{at,
 * from, to}], dropped: [...]}.
 *
 * create-context-graph (neo4j-labs/create-context-graph 707b168, src/create_context_graph/domains/
 * and ontology.py; Apache-2.0) to v1. The file is flattened with its base first, exactly as
 * ontology.py `_merge_base` does: the base's entity types first, except a label the domain declares
 * itself, then the domain's; the base's relationships likewise, except a type the domain declares
 * itself. A base entity type is {label, pole_type (default OBJECT), color (default #6366f1), icon
 * (default circle), properties: its base_properties}, as `_merge_base` builds it. Then:
 *   `$schema` the spec's id; `id` domain.id; `version` 1; `name` domain.name; `description`
 *     domain.description (absent when empty).
 *   nodes, keyed by label, in that order: `label`; `description` derived as the page always showed
 *     it, "<subtype> (<pole type>)" (kindDescription); `properties` from the entity type's
 *     properties (below); `tools` (below); `extensions`: `neo4j:display` {color, caption: name} (what
 *     the spec's example shows), and the custom envelopes {type: createContextGraph:pole, definition:
 *     {pole_type, subtype?, origin: base|domain}} and {type: createContextGraph:display, definition:
 *     {icon, size? (from visualization.node_sizes)}}. No implied labels: they would add labels to the
 *     published graph.
 *   a property (PropertyDef: name, type, required, unique, enum, default, description): `type` by
 *     PROPERTY_TYPES (string STRING, integer INTEGER, float FLOAT, boolean BOOLEAN, date DATE,
 *     datetime DATETIME, ...; an unknown one ANY, with its text in a createContextGraph:type
 *     envelope and a line in the report); `mustExist: true` for required, `unique: true` for
 *     unique, `one_of` for enum, `description`; `default` in a createContextGraph:default envelope
 *     (v1 has no default field).
 *   relationships: one entry per (type, source, target), keyed by the type when the type has one
 *     pair, else TYPE__SOURCE__TARGET (with __2, __3, ... should a key be taken); each {type, from:
 *     {node}, to: {node}, properties?} with a createContextGraph:origin envelope {origin: base|domain}.
 *   agent_tools: each a canonicalQuery tool {type, name, description, cypher, parameters: [{name,
 *     type (a v1 token), description?, required?, default?, one_of?}]}, on the element its query
 *     starts from (toolAnchor); visualization.default_cypher likewise, as the tool `defaultView`.
 *   The rest, verbatim, in custom envelopes at the top level: createContextGraph:domain {tagline,
 *     emoji, ... (the domain map but its id, name and description), inherits?},
 *     createContextGraph:documentTemplates, :decisionTraces, :demoScenarios, :systemPrompt and
 *     :visualization (node_colors, node_sizes, default_cypher). Keys create-context-graph's model
 *     ignores are dropped and named in the report.
 *
 * Tool placement (toolAnchor), in order: (1) the node the tool's first parameter binds: of the
 * tool's parameters in their declared order, the first that the query compares with a property of a
 * node variable where the comparison filters the rows it returns (paramBindings with scope 'match':
 * in a property map of a MATCH's node pattern, or in the WHERE of a MATCH or WITH; not in an
 * OPTIONAL MATCH, whose rows come back without a match, nor in a subquery), on that
 * variable's first label that is a node of the ontology; else (2) the first node pattern with a
 * label in the query's first MATCH clause, when that label is a node of the ontology; else (3) the
 * first relationship type in that clause's pattern that is a relationship type of the ontology (its
 * first entry); else (4) the first label test (`n:Label`) in that clause's WHERE naming a node of
 * the ontology; else (5) the ontology's first node. Strings and comments are blanked first.
 */
import { EXTENSIONS, OntologyError, SCHEMA_ID, cmpCodePoints, idProblem, isMap, loadText, setOwn } from './ogs.js';
import { rustTrim } from './names.js';

export const MIN_TYPES = 2;
export const MAX_TYPES = 50;
export const MAX_RELATION_EDGES = 100;
export const DEFAULT_COLOR = '#64748b';
/** create-context-graph's colour for an entity type without one (ontology.py EntityTypeDef.color). */
export const CCG_DEFAULT_COLOR = '#6366f1';
/** create-context-graph's icon for an entity type without one (ontology.py EntityTypeDef.icon). */
export const CCG_DEFAULT_ICON = 'circle';
/**
 * The custom envelope that carries a create-context-graph entity type's icon and node size
 * ({icon, size?}): neo4j:display holds only what the spec's example shows (color, caption). The page
 * draws no icons and sizes nodes itself, so only the conversion back (harness/convert.mjs) reads it.
 */
export const CCG_DISPLAY = 'createContextGraph:display';

/**
 * create-context-graph's property types (ontology.py PropertyDef.type, free text, default
 * "string") as v1 type tokens. The 27 domains use the first six; the rest are the obvious
 * spellings. Anything else becomes ANY (with its text kept, and reported).
 */
export const PROPERTY_TYPES = Object.freeze({
  string: 'STRING', integer: 'INTEGER', float: 'FLOAT', boolean: 'BOOLEAN', date: 'DATE', datetime: 'DATETIME',
  str: 'STRING', text: 'STRING', int: 'INTEGER', bool: 'BOOLEAN', time: 'TIME', localtime: 'LOCALTIME',
  localdatetime: 'LOCALDATETIME', duration: 'DURATION', point: 'POINT', list: 'LIST<ANY>',
});

const show = (v) => (v === undefined ? 'nothing' : JSON.stringify(v));

function stringField(where, obj, key, { optional = false, fallback = '' } = {}) {
  if (!Object.hasOwn(obj, key)) {
    if (optional) return fallback;
    throw new OntologyError(`${where}: missing field \`${key}\``);
  }
  if (typeof obj[key] !== 'string') throw new OntologyError(`${where}: \`${key}\` must be text, not ${show(obj[key])}`);
  return obj[key];
}

const cmp = cmpCodePoints;
function dupes(ids) {
  const seen = new Set();
  const out = new Set();
  for (const id of ids) (seen.has(id) ? out : seen).add(id);
  return [...out].sort(cmp);
}
const uniq = (xs) => [...new Set(xs)];

/** Lower case, `_` as spaces: FINANCIAL_ACCOUNT -> "financial account". @param {string} x */
export function humanise(x) {
  return x.toLowerCase().replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A create-context-graph kind's description, derived (never invented): "<subtype> (<pole type>)"
 * lower-cased with `_` as spaces, or the pole type alone when there is no subtype or both read the
 * same. kindDescription('OBJECT', 'FINANCIAL_ACCOUNT') -> 'financial account (object)';
 * kindDescription('PERSON', null) -> 'person'.
 * @param {string} poleType @param {string|null|undefined} subtype
 */
export function kindDescription(poleType, subtype) {
  const pole = humanise(poleType);
  const sub = typeof subtype === 'string' ? humanise(subtype) : '';
  if (sub === '' || sub === pole) return pole || sub;
  return pole ? `${sub} (${pole})` : sub;
}

/** A map's entries as an object, keys set as own properties (`__proto__` included). @param {Iterable<[string, any]>} entries */
function obj(entries) {
  const o = {};
  for (const [k, v] of entries) if (v !== undefined) setOwn(o, k, v);
  return o;
}
/** `key` free in `taken`: key, key__2, key__3, ... @param {string} key @param {Set<string>} taken */
function freeKey(key, taken) {
  let k = key;
  for (let i = 2; taken.has(k); i++) k = `${key}__${i}`;
  taken.add(k);
  return k;
}

// ---- tool placement -----------------------------------------------------------------------------

const IDENT = String.raw`(?:\x60(?:[^\x60]|\x60\x60)+\x60|[\p{L}_][\p{L}\p{M}\p{N}_]*)`;
const unquote = (s) => (s.startsWith('`') ? s.slice(1, -1).replaceAll('``', '`') : s);
/** Clause keywords that end a MATCH clause (at the top level of the query). */
const CLAUSE_END = /\b(?:RETURN|(?<!\b(?:STARTS|ENDS)\s+)WITH|MATCH|OPTIONAL|UNWIND|CALL|ORDER|LIMIT|SKIP|SET|DELETE|DETACH|MERGE|CREATE|REMOVE|FOREACH|UNION|SEARCH|FINISH|USE|LOAD)\b/i;

/** The query with string literals and comments blanked (same length), so patterns are not found inside them. @param {string} q */
function blank(q) {
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

/** A function name and its opening parenthesis: `toLower(`, `coalesce (`. */
const FN_OPEN = String.raw`(?:[\p{L}_][\p{L}\p{N}_]*\s*\(\s*)`;
/** `v.prop`, wrapped in functions, with more arguments after it (`coalesce(a.title, a.name, '')`; strings are blanked). */
const PROP_EXPR = String.raw`(${FN_OPEN}*${IDENT}\s*\.\s*${IDENT}(?:\s*,\s*(?:${IDENT}\s*\.\s*${IDENT}|''|""))*(?:\s*\))*)`;
/** `$p`, wrapped in functions (`toLower($q)`). */
const PARAM_EXPR = String.raw`(${FN_OPEN}*\$([\p{L}\p{N}_]+)(?:\s*\))*)`;
/** The comparisons that bind a value to a property (not <>, <, >: those filter around it). */
const BIND_OP = String.raw`(=~|=|CONTAINS|STARTS\s+WITH|ENDS\s+WITH|IN)`;
const PROP_OP_PARAM = new RegExp(String.raw`${PROP_EXPR}\s*${BIND_OP}\s*${PARAM_EXPR}`, 'giu');
const PARAM_OP_PROP = new RegExp(String.raw`${PARAM_EXPR}\s*${BIND_OP}\s*${PROP_EXPR}`, 'giu');
/** A node pattern (not a function call's parenthesis): its variable, labels and property map. */
const NODE_PATTERN = new RegExp(String.raw`(?<![\p{L}\p{N}_\x60])\(\s*(${IDENT})?\s*((?::\s*${IDENT}\s*)(?:(?::|\|\s*:?|&)\s*${IDENT}\s*)*)?(\{[^{}]*\})?\s*\)`, 'gu');
const PROP_REF = new RegExp(String.raw`(${IDENT})\s*\.\s*(${IDENT})`, 'gu');
const LABEL_TEST_IN_WHERE = new RegExp(String.raw`(?<![\p{L}\p{N}_.$\x60])(${IDENT})\s*:\s*(${IDENT})`, 'gu');
const WHERE_BODY = /\bWHERE\b([\s\S]*?)(?=\b(?:RETURN|WITH|MATCH|OPTIONAL|UNWIND|CALL|ORDER|LIMIT|SKIP|SET|DELETE|DETACH|MERGE|CREATE|REMOVE|FOREACH|UNION|SEARCH|FINISH|USE|LOAD)\b|$)/giu;

/** The clause keywords a query is cut at (WITH after STARTS or ENDS is an operator, skipped). */
const CLAUSE_KW = /\b(OPTIONAL\s+MATCH|MATCH|WHERE|WITH|RETURN|UNWIND|CALL|ORDER\s+BY|LIMIT|SKIP|YIELD|UNION|SET|DELETE|DETACH|MERGE|CREATE|REMOVE|FOREACH|SEARCH|USE|LOAD|FINISH)\b/giu;
/** A subquery's opening brace: EXISTS {, COUNT {, COLLECT {, CALL {. */
const SUBQUERY_OPEN = /\b(?:EXISTS|COUNT|COLLECT|CALL)\s*\{/giu;

/**
 * @typedef {'match'|'optional'|'subquery'|'other'} Scope
 *   where a comparison sits, and so whether it can pick the rows a query returns: 'match' (a
 *   top-level MATCH's pattern, or the WHERE of a top-level MATCH, WITH or YIELD: it filters them),
 *   'optional' (an OPTIONAL MATCH's pattern or its WHERE: rows without a match still come back),
 *   'subquery' (inside EXISTS { }, COUNT { }, COLLECT { } or CALL { }: about the subquery's own
 *   variables), 'other' (RETURN, ORDER BY, a WITH's projection, UNWIND, a procedure's arguments, ...)
 */

/**
 * The clauses of a query (strings and comments blanked), for the scope of each offset in it:
 * {scopeAt(i), clauses: [{kw, at, end, scope, sub}], subqueries: [[open, close]]}. A clause inside a
 * subquery's braces has `sub` true and scope 'subquery'; a WHERE takes its scope from the clause it
 * belongs to (the last other clause before it in the same subquery or at the top).
 * @param {string} q  blanked
 */
export function queryScopes(q) {
  /** @type {Array<[number, number]>} each subquery's braces */
  const subqueries = [];
  for (const m of q.matchAll(SUBQUERY_OPEN)) {
    const open = /** @type {number} */ (m.index) + m[0].length - 1;
    let d = 0;
    let close = q.length;
    for (let i = open; i < q.length; i++) {
      if (q[i] === '{') d++;
      else if (q[i] === '}' && --d === 0) { close = i; break; }
    }
    subqueries.push([open, close]);
  }
  /** the innermost subquery holding offset i, or -1 */
  const subOf = (/** @type {number} */ i) => {
    let best = -1;
    subqueries.forEach(([a, b], k) => { if (i > a && i < b && (best < 0 || a > subqueries[best][0])) best = k; });
    return best;
  };
  /** @type {Array<{kw: string, at: number, end: number, scope: Scope, sub: boolean, container: number}>} */
  const clauses = [];
  for (const m of q.matchAll(CLAUSE_KW)) {
    const kw = m[1].toUpperCase().replace(/\s+/gu, ' ');
    if (kw === 'WITH' && /\b(?:STARTS|ENDS)\s*$/iu.test(q.slice(0, m.index))) continue;
    clauses.push({ kw, at: /** @type {number} */ (m.index), end: q.length, scope: 'other', sub: false, container: subOf(/** @type {number} */ (m.index)) });
  }
  /** @type {Map<number, string>} each container's last clause other than WHERE */
  const last = new Map();
  for (let k = 0; k < clauses.length; k++) {
    const c = clauses[k];
    const next = clauses.slice(k + 1).find((x) => x.container === c.container);
    c.end = next ? next.at : c.container >= 0 ? subqueries[c.container][1] : q.length;
    c.sub = c.container >= 0;
    const prev = last.get(c.container);
    if (c.sub) c.scope = 'subquery';
    else if (c.kw === 'MATCH') c.scope = 'match';
    else if (c.kw === 'OPTIONAL MATCH') c.scope = 'optional';
    else if (c.kw === 'WHERE') c.scope = prev === 'MATCH' || prev === 'WITH' || prev === 'YIELD' ? 'match' : prev === 'OPTIONAL MATCH' ? 'optional' : 'other';
    if (c.kw !== 'WHERE') last.set(c.container, c.kw);
  }
  /** @param {number} i @returns {Scope} */
  const scopeAt = (i) => {
    if (subOf(i) >= 0) return 'subquery';
    const c = clauses.filter((x) => !x.sub && x.at <= i).at(-1);
    return c ? c.scope : 'other';
  };
  return { scopeAt, clauses, subqueries };
}

/** A node variable's labels in a (blanked) query: its node patterns', then WHERE label tests (`a:Note OR a:Topic`). @param {string} q */
function variableLabels(q) {
  /** @type {Map<string, string[]>} */
  const labels = new Map();
  const addLabels = (/** @type {string} */ v, /** @type {string[]} */ ls) => {
    const have = labels.get(v) ?? [];
    for (const l of ls) if (!have.includes(l)) have.push(l);
    labels.set(v, have);
  };
  for (const m of q.matchAll(NODE_PATTERN)) {
    if (m[1]) addLabels(unquote(m[1]), (m[2] ?? '').split(/[:|&]/u).map((x) => x.trim()).filter(Boolean).map(unquote));
  }
  for (const w of q.matchAll(WHERE_BODY)) {
    for (const t of w[1].matchAll(LABEL_TEST_IN_WHERE)) if (labels.has(unquote(t[1]))) addLabels(unquote(t[1]), [unquote(t[2])]);
  }
  return labels;
}

/**
 * Where a query compares its parameters with node properties, in text order: [{param, v, props,
 * labels, op, at, scope}]. A binding is a property map entry `{key: $p}` on a node pattern (op 'map'),
 * or a comparison `v.prop OP $p` or `$p OP v.prop` anywhere in the query (OP is =, =~, CONTAINS,
 * STARTS WITH, ENDS WITH or IN; either side may be wrapped in functions, `toLower(coalesce(a.title,
 * a.name, '')) CONTAINS toLower($q)` or `toLower(p.name) = toLower($q)`), on a variable some node
 * pattern binds. `props` are the properties that side reads; `labels` the variable's labels in the
 * query (its node patterns', then WHERE label tests such as `a:Note OR a:Topic`); `at` is the
 * parameter's offset; `scope` where it sits (queryScopes): only a 'match' binding filters the rows
 * the query returns, so toolAnchor and console.js's prefill take only those (one in an OPTIONAL
 * MATCH, or in a subquery, picks nothing). Strings and comments are blanked first.
 * @param {string} cypher
 * @returns {Array<{param: string, v: string, props: string[], labels: string[], op: string, at: number, scope: Scope}>}
 */
export function paramBindings(cypher) {
  const q = blank(String(cypher ?? ''));
  const labels = variableLabels(q);
  const { scopeAt } = queryScopes(q);
  /** @type {Array<{param: string, v: string, props: string[], op: string, at: number}>} */
  const found = [];
  for (const m of q.matchAll(NODE_PATTERN)) {
    if (!m[1] || !m[3]) continue;
    const v = unquote(m[1]);
    const base = /** @type {number} */ (m.index) + m[0].indexOf(m[3]);
    for (const e of m[3].matchAll(new RegExp(String.raw`(?:\{|,)\s*(${IDENT})\s*:\s*\$([\p{L}\p{N}_]+)\s*(?=,|\})`, 'gu'))) {
      found.push({ param: e[2], v, props: [unquote(e[1])], op: 'map', at: base + /** @type {number} */ (e.index) + e[0].indexOf('$') });
    }
  }
  const fromProp = (text) => [...text.matchAll(PROP_REF)].map((r) => ({ v: unquote(r[1]), prop: unquote(r[2]) }));
  for (const m of q.matchAll(PROP_OP_PARAM)) {
    const refs = fromProp(m[1]);
    found.push({ param: m[4], v: refs[0].v, props: refs.filter((r) => r.v === refs[0].v).map((r) => r.prop), op: m[2].toUpperCase().replace(/\s+/gu, ' '),
      at: /** @type {number} */ (m.index) + m[0].lastIndexOf(`$${m[4]}`) });
  }
  for (const m of q.matchAll(PARAM_OP_PROP)) {
    const refs = fromProp(m[4]);
    found.push({ param: m[2], v: refs[0].v, props: refs.filter((r) => r.v === refs[0].v).map((r) => r.prop), op: m[3].toUpperCase().replace(/\s+/gu, ' '),
      at: /** @type {number} */ (m.index) + m[0].indexOf(`$${m[2]}`) });
  }
  return found.filter((b) => labels.has(b.v)).sort((a, b) => a.at - b.at).map((b) => ({ ...b, labels: labels.get(b.v) ?? [], scope: scopeAt(b.at) }));
}

/** The operator a comparison uses, by the first it holds in this order (blanked text). @param {string} t */
function comparisonOp(t) {
  for (const [re, op] of /** @type {Array<[RegExp, string]>} */ ([[/=~/u, '=~'], [/<>|!=/u, '<>'], [/<=/u, '<='], [/>=/u, '>='], [/(?<![-<])<(?![-=])/u, '<'],
    [/(?<![->=])>(?!=)/u, '>'], [/\bCONTAINS\b/iu, 'CONTAINS'], [/\bSTARTS\s+WITH\b/iu, 'STARTS WITH'], [/\bENDS\s+WITH\b/iu, 'ENDS WITH'], [/\bIN\b/iu, 'IN'], [/=/u, '=']])) {
    if (re.test(t)) return op;
  }
  return 'other';
}

/**
 * Every comparison of a parameter with a node property, whatever its operator: [{param, v, props,
 * labels, op, at, scope}], in text order. A WHERE (anywhere: an OPTIONAL MATCH's, a subquery's, a
 * pattern's own `(n WHERE ...)`) is cut at its top-level AND, OR, XOR and NOT, and each part that
 * holds a `$p` and reads `v.prop` of a node variable is a comparison of the two (`p.age > $min`,
 * `p.id <> $id`, `p.name =~ '(?i)' + $q`, `toLower(p.name) = toLower($q)`); so is a property map
 * entry whose value holds `$p` (op 'map'). Wider than paramBindings, which only takes the operators
 * that bind a value to a property: console.js's prefill reads this one to tell whether a parameter
 * is about another kind's nodes. Subqueries nested in a WHERE are read in their own place.
 * @param {string} cypher
 * @returns {Array<{param: string, v: string, props: string[], labels: string[], op: string, at: number, scope: Scope}>}
 */
export function paramComparisons(cypher) {
  const q = blank(String(cypher ?? ''));
  const labels = variableLabels(q);
  const { scopeAt, clauses, subqueries } = queryScopes(q);
  /** @type {Array<{param: string, v: string, props: string[], labels: string[], op: string, at: number, scope: Scope}>} */
  const out = [];
  const PARAM = /\$([\p{L}\p{N}_]+)/gu;
  /** @param {string} text @param {number} base @param {string|null} mapVar @param {string|null} mapKey */
  const add = (text, base, mapVar, mapKey) => {
    const params = [...text.matchAll(PARAM)];
    if (!params.length) return;
    /** @type {Map<string, string[]>} */
    const refs = new Map();
    if (mapVar !== null && mapKey !== null) refs.set(mapVar, [mapKey]);
    else {
      for (const r of text.matchAll(PROP_REF)) {
        const v = unquote(r[1]);
        if (!labels.has(v) || /[\p{L}\p{N}_.$\x60]/u.test(text[/** @type {number} */ (r.index) - 1] ?? '')) continue;
        refs.set(v, [...new Set([...(refs.get(v) ?? []), unquote(r[2])])]);
      }
    }
    const op = mapVar !== null ? 'map' : comparisonOp(text);
    for (const p of params) {
      const at = base + /** @type {number} */ (p.index);
      for (const [v, props] of refs) out.push({ param: p[1], v, props, labels: labels.get(v) ?? [], op, at, scope: scopeAt(at) });
    }
  };
  // Property maps on node patterns: each entry's value.
  for (const m of q.matchAll(NODE_PATTERN)) {
    if (!m[1] || !m[3]) continue;
    const v = unquote(m[1]);
    const base = /** @type {number} */ (m.index) + m[0].indexOf(m[3]);
    for (const e of m[3].matchAll(new RegExp(String.raw`(?:\{|,)\s*(${IDENT})\s*:([^,}]*)`, 'gu'))) {
      add(e[2], base + /** @type {number} */ (e.index) + e[0].length - e[2].length, v, unquote(e[1]));
    }
  }
  // Each WHERE: up to its clause's end or an unbalanced closing bracket, nested subqueries blanked.
  for (const c of clauses.filter((x) => x.kw === 'WHERE')) {
    const start = c.at + 'WHERE'.length;
    let depth = 0;
    let end = c.end;
    for (let i = start; i < c.end; i++) {
      const ch = q[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if ((ch === ')' || ch === ']' || ch === '}') && --depth < 0) { end = i; break; }
    }
    const nested = subqueries.filter(([a]) => a >= start && a < end);
    let body = '';
    for (let i = start; i < end; i++) body += nested.some(([a, b]) => i >= a && i <= b) ? ' ' : q[i];
    let from = 0;
    for (const part of splitTopWords(body, /\b(?:AND|OR|XOR|NOT)\b/iuy)) {
      add(part, start + from, null, null);
      from += part.length;
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * A blanked text cut before each top-level match of `word` (sticky regex), outside parentheses,
 * brackets and braces; the parts concatenate back to the text (each keeps its leading keyword).
 * @param {string} text @param {RegExp} word
 */
function splitTopWords(text, word) {
  const out = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && i > last && (i === 0 || !/[\p{L}\p{N}_$]/u.test(text[i - 1]))) {
      word.lastIndex = i;
      if (word.test(text)) {
        out.push(text.slice(last, i));
        last = i;
      }
    }
  }
  out.push(text.slice(last));
  return out;
}

/**
 * Where a query's tool goes (see the header): {kind: 'node'|'relationship', key, rule} with rule
 * 'parameter', 'node-pattern', 'relationship-type', 'where-label' or 'first-node'.
 * @param {string} cypher
 * @param {Array<[string, string]>} nodes  [node key, identifier label] in document order
 * @param {Array<[string, string]>} rels  [relationship key, type] in document order
 * @param {string[]} [params]  the tool's parameter names in their declared order (absent: none)
 * @returns {{kind: 'node'|'relationship', key: string, rule: string}}
 */
export function toolAnchor(cypher, nodes, rels, params = []) {
  const q = blank(String(cypher ?? ''));
  const nodeOf = (label) => nodes.find(([, l]) => l === label)?.[0];
  const relOf = (type) => rels.find(([, t]) => t === type)?.[0];
  if (params.length) {
    // Only a binding that filters the rows the query returns ('match'): one in an OPTIONAL MATCH or a subquery picks nothing.
    const bindings = paramBindings(cypher).filter((b) => b.scope === 'match');
    for (const p of params) {
      for (const b of bindings.filter((x) => x.param === p)) {
        const key = b.labels.map(nodeOf).find((k) => k !== undefined);
        if (key !== undefined) return { kind: 'node', key, rule: 'parameter' };
      }
    }
  }
  const m = /\bMATCH\b/i.exec(q);
  if (m) {
    const rest = q.slice(m.index + m[0].length);
    const end = CLAUSE_END.exec(rest);
    const clause = end ? rest.slice(0, end.index) : rest;
    const w = /\bWHERE\b/i.exec(clause);
    const pattern = w ? clause.slice(0, w.index) : clause;
    const where = w ? clause.slice(w.index) : '';
    const node = new RegExp(String.raw`\(\s*(?:${IDENT})?\s*:\s*(${IDENT})`, 'u').exec(pattern);
    if (node) {
      const key = nodeOf(unquote(node[1]));
      if (key !== undefined) return { kind: 'node', key, rule: 'node-pattern' };
    }
    for (const r of pattern.matchAll(new RegExp(String.raw`\[\s*(?:${IDENT})?\s*:\s*(${IDENT}(?:\s*\|\s*:?\s*${IDENT})*)`, 'gu'))) {
      for (const t of r[1].split('|').map((x) => unquote(x.replace(/^\s*:?\s*/, '').trim()))) {
        const key = relOf(t);
        if (key !== undefined) return { kind: 'relationship', key, rule: 'relationship-type' };
      }
    }
    for (const l of where.matchAll(new RegExp(String.raw`(?:^|[^\p{L}\p{N}_.$\x60])${IDENT}\s*:\s*(${IDENT})`, 'gu'))) {
      const key = nodeOf(unquote(l[1]));
      if (key !== undefined) return { kind: 'node', key, rule: 'where-label' };
    }
  }
  return { kind: 'node', key: nodes[0][0], rule: 'first-node' };
}

// ---- create-context-graph -----------------------------------------------------------------------

/**
 * One create-context-graph PropertyDef as a v1 property; `where` names it in errors.
 * @param {string} where @param {any} p @param {{types: any[]}} report
 * @returns {[string, any]}
 */
function ccgProperty(where, p, report) {
  if (!isMap(p)) throw new OntologyError(`${where}: a property is {name, type, ...}, not ${show(p)}`);
  const name = stringField(where, p, 'name');
  if (name === '') throw new OntologyError(`${where}: a property's name is empty`);
  const w = `${where} (${name})`;
  const raw = stringField(w, p, 'type', { optional: true, fallback: 'string' });
  const key = raw.trim().toLowerCase();
  let token = Object.hasOwn(PROPERTY_TYPES, key) ? PROPERTY_TYPES[key] : null;
  const list = /^list\s*[<[]\s*(\w+)\s*[>\]]$/.exec(key);
  if (!token && list && Object.hasOwn(PROPERTY_TYPES, list[1]) && !PROPERTY_TYPES[list[1]].startsWith('LIST')) token = `LIST<${PROPERTY_TYPES[list[1]]}>`;
  const custom = [];
  if (!token) {
    token = 'ANY';
    custom.push({ type: 'createContextGraph:type', definition: raw });
    report.types.push({ at: w, from: raw, to: 'ANY' });
  }
  for (const flag of ['required', 'unique']) {
    if (Object.hasOwn(p, flag) && typeof p[flag] !== 'boolean') throw new OntologyError(`${w}: \`${flag}\` must be true or false, not ${show(p[flag])}`);
  }
  let oneOf;
  if (Object.hasOwn(p, 'enum') && p.enum !== null) {
    if (!Array.isArray(p.enum)) throw new OntologyError(`${w}: \`enum\` must be a list, not ${show(p.enum)}`);
    if (p.enum.length) oneOf = p.enum.slice();
  }
  const description = stringField(w, p, 'description', { optional: true });
  if (Object.hasOwn(p, 'default') && p.default !== null) custom.push({ type: 'createContextGraph:default', definition: p.default });
  return [name, obj([
    ['type', token],
    ['mustExist', p.required === true ? true : undefined],
    ['unique', p.unique === true ? true : undefined],
    ['one_of', oneOf],
    ['description', description || undefined],
    ['extensions', custom.length ? { custom } : undefined],
  ])];
}

/** A list of PropertyDefs as a v1 properties map (absent when empty). @param {string} where @param {any} list @param {any} report */
function ccgProperties(where, list, report) {
  if (list === undefined || list === null) return undefined;
  if (!Array.isArray(list)) throw new OntologyError(`${where}: \`properties\` must be a list, not ${show(list)}`);
  const out = {};
  list.forEach((p, i) => {
    const [name, prop] = ccgProperty(`${where}, properties[${i}]`, p, report);
    if (Object.hasOwn(out, name)) throw new OntologyError(`${where}: two properties are named ${name}`);
    setOwn(out, name, prop);
  });
  return Object.keys(out).length ? out : undefined;
}

/** A tool's parameters (PropertyDefs) as owner-defined tool parameters. @param {string} where @param {any} list */
function toolParameters(where, list) {
  if (list === undefined || list === null) return undefined;
  if (!Array.isArray(list)) throw new OntologyError(`${where}: \`parameters\` must be a list, not ${show(list)}`);
  const out = list.map((p, i) => {
    const w = `${where}, parameters[${i}]`;
    if (!isMap(p)) throw new OntologyError(`${w}: a parameter is {name, type, description}, not ${show(p)}`);
    const name = stringField(w, p, 'name');
    const raw = stringField(`${w} (${name})`, p, 'type', { optional: true, fallback: 'string' });
    const key = raw.trim().toLowerCase();
    return obj([
      ['name', name],
      ['type', Object.hasOwn(PROPERTY_TYPES, key) ? PROPERTY_TYPES[key] : raw],
      ['description', stringField(`${w} (${name})`, p, 'description', { optional: true }) || undefined],
      ['required', p.required === true ? true : undefined],
      ['default', p.default ?? undefined],
      ['one_of', Array.isArray(p.enum) && p.enum.length ? p.enum.slice() : undefined],
    ]);
  });
  return out.length ? out : undefined;
}

/** The domain's own keys create-context-graph's model reads (ontology.py DomainOntology), and the base's. */
const CCG_KEYS = new Set(['domain', 'inherits', 'entity_types', 'relationships', 'document_templates', 'decision_traces',
  'demo_scenarios', 'agent_tools', 'visualization', 'system_prompt']);
const CCG_ENTITY_KEYS = new Set(['label', 'pole_type', 'subtype', 'color', 'icon', 'properties']);
const CCG_REL_KEYS = new Set(['type', 'source', 'target', 'properties']);
const CCG_TOOL_KEYS = new Set(['name', 'description', 'cypher', 'parameters']);

/**
 * create-context-graph's domain file as an Ontology Graph Spec v1 document (see the header).
 * @param {string} text  the domain YAML
 * @param {{bases?: Record<string, string>}} [opts]  bases: base ontologies by name, as `inherits` names them
 *   ({_base: <the text of data/ontologies/ccg/_base.yaml>})
 * @returns {{doc: any, report: {tools: any[], types: any[], dropped: string[]}, inherits: string|null, baseText: string|null}}
 */
export function fromCreateContextGraph(text, { bases = {} } = {}) {
  const data = loadText(text);
  if (!isMap(data)) throw new OntologyError('ontology YAML must be a mapping');
  /** @type {{tools: any[], types: any[], dropped: string[]}} */
  const report = { tools: [], types: [], dropped: [] };
  const dom = data.domain;
  if (!isMap(dom)) throw new OntologyError(`\`domain\` must be a mapping with an id and a name, not ${show(dom)}`);
  const id = stringField('domain', dom, 'id');
  if (rustTrim(id) === '') throw new OntologyError('domain: `id` is empty; it names the ontology and its store');
  const name = stringField('domain', dom, 'name');
  const description = stringField('domain', dom, 'description', { optional: true });
  stringField('domain', dom, 'tagline', { optional: true });
  stringField('domain', dom, 'emoji', { optional: true });
  // ontology.py reads `inherits` at the top level or under `domain`.
  const rawInherits = Object.hasOwn(data, 'inherits') && data.inherits !== null ? data.inherits
    : Object.hasOwn(dom, 'inherits') && dom.inherits !== null ? dom.inherits : null;
  if (rawInherits !== null && typeof rawInherits !== 'string') throw new OntologyError(`\`inherits\` must name a base, not ${show(rawInherits)}`);
  const inherits = /** @type {string|null} */ (rawInherits);

  /** @typedef {{label: string, pole: string, subtype: string|null, color: string, icon: string, properties: any, origin: 'base'|'domain', where: string}} K */
  /** @type {K[]} */
  let baseKinds = [];
  /** @type {Array<{type: string, source: string, target: string, properties: any, origin: 'base'|'domain', where: string}>} */
  let baseLinks = [];
  /** @type {string|null} */
  let baseText = null;
  if (inherits !== null) {
    if (!Object.hasOwn(bases, inherits) || typeof bases[inherits] !== 'string') {
      const known = Object.keys(bases).sort(cmp);
      throw new OntologyError(`This file inherits ${inherits}, but no base of that name is loaded ` +
        `(${known.length ? `known: ${known.join(', ')}` : 'none is'}). create-context-graph's domains inherit _base.`);
    }
    baseText = bases[inherits];
    const b = loadText(baseText, `The base ${inherits}`);
    if (!isMap(b)) throw new OntologyError(`The base ${inherits} must be a mapping`);
    const bt = b.base_entity_types ?? {};
    if (!isMap(bt)) throw new OntologyError(`The base ${inherits}: \`base_entity_types\` must map labels to types, not ${show(bt)}`);
    baseKinds = Object.entries(bt).map(([label, defn]) => {
      const where = `the base ${inherits}, entity type ${label}`;
      if (!isMap(defn)) throw new OntologyError(`${where}: must be a mapping, not ${show(defn)}`);
      return {
        label,
        pole: stringField(where, defn, 'pole_type', { optional: true, fallback: 'OBJECT' }),
        subtype: null,
        color: stringField(where, defn, 'color', { optional: true, fallback: CCG_DEFAULT_COLOR }),
        icon: stringField(where, defn, 'icon', { optional: true, fallback: CCG_DEFAULT_ICON }),
        properties: defn.base_properties,
        origin: /** @type {'base'} */ ('base'),
        where,
      };
    });
    const br = b.base_relationships ?? {};
    if (!isMap(br)) throw new OntologyError(`The base ${inherits}: \`base_relationships\` must map types to {source, target}, not ${show(br)}`);
    baseLinks = Object.entries(br).map(([type, defn]) => {
      const where = `the base ${inherits}, relationship ${type}`;
      if (!isMap(defn)) throw new OntologyError(`${where}: must be a mapping, not ${show(defn)}`);
      return {
        type,
        source: stringField(where, defn, 'source', { optional: true, fallback: '*' }),
        target: stringField(where, defn, 'target', { optional: true, fallback: '*' }),
        properties: defn.properties,
        origin: /** @type {'base'} */ ('base'),
        where,
      };
    });
  }

  const rawKinds = Object.hasOwn(data, 'entity_types') && data.entity_types !== null ? data.entity_types : [];
  if (!Array.isArray(rawKinds)) throw new OntologyError(`\`entity_types\` must be a list, not ${show(rawKinds)}`);
  /** @type {K[]} */
  const kinds = rawKinds.map((item, i) => {
    const where = `entity_types[${i}]`;
    if (!isMap(item)) throw new OntologyError(`${where}: an entity type is {label, pole_type, ...}, not ${show(item)}`);
    const label = stringField(where, item, 'label');
    const w = `${where} (${label})`;
    let subtype = null;
    if (Object.hasOwn(item, 'subtype') && item.subtype !== null) subtype = stringField(w, item, 'subtype');
    for (const k of Object.keys(item)) if (!CCG_ENTITY_KEYS.has(k)) report.dropped.push(`${w}.${k}`);
    return {
      label,
      pole: stringField(w, item, 'pole_type'),
      subtype,
      color: stringField(w, item, 'color', { optional: true, fallback: CCG_DEFAULT_COLOR }),
      icon: stringField(w, item, 'icon', { optional: true, fallback: CCG_DEFAULT_ICON }),
      properties: item.properties,
      origin: /** @type {'domain'} */ ('domain'),
      where: w,
    };
  });
  const rawLinks = Object.hasOwn(data, 'relationships') && data.relationships !== null ? data.relationships : [];
  if (!Array.isArray(rawLinks)) throw new OntologyError(`\`relationships\` must be a list, not ${show(rawLinks)}`);
  const links = rawLinks.map((item, i) => {
    const where = `relationships[${i}]`;
    if (!isMap(item)) throw new OntologyError(`${where}: a relationship is {type, source, target}, not ${show(item)}`);
    const type = stringField(where, item, 'type');
    const w = `${where} (${type})`;
    for (const k of Object.keys(item)) if (!CCG_REL_KEYS.has(k)) report.dropped.push(`${w}.${k}`);
    return {
      type, source: stringField(w, item, 'source'), target: stringField(w, item, 'target'),
      properties: item.properties, origin: /** @type {'domain'} */ ('domain'), where: w,
    };
  });

  // ontology.py _merge_base: the base's types and relationships first, unless the domain declares the label or type itself.
  const ownLabels = new Set(kinds.map((k) => k.label));
  const ownTypes = new Set(links.map((l) => l.type));
  const allKinds = [...baseKinds.filter((k) => !ownLabels.has(k.label)), ...kinds];
  const allLinks = [...baseLinks.filter((l) => !ownTypes.has(l.type)), ...links];

  const withBase = inherits === null ? '' : ` (with ${inherits})`;
  if (allKinds.length < MIN_TYPES || allKinds.length > MAX_TYPES) {
    throw new OntologyError(`An ontology needs between ${MIN_TYPES} and ${MAX_TYPES} kinds of name. ` +
      `This file lists ${allKinds.length}${withBase}. Add another entity type, or split a large list.`);
  }
  for (const k of allKinds) {
    const bad = idProblem('entity type', k.label);
    if (bad) throw new OntologyError(bad);
  }
  const kindDupes = dupes(kinds.map((k) => k.label));
  if (kindDupes.length) {
    throw new OntologyError(`Two entity types share the label ${kindDupes.join(', ')}. Give each one a unique label.`);
  }
  const kindIds = new Set(allKinds.map((k) => k.label));
  /** @type {Map<string, Array<{source: string, target: string, properties: any, origin: string, where: string}>>} */
  const byType = new Map();
  for (const l of allLinks) {
    const bad = idProblem('relationship type', l.type);
    if (bad) throw new OntologyError(bad);
    for (const [end, k] of /** @type {const} */ ([['source', l.source], ['target', l.target]])) {
      if (!kindIds.has(k)) {
        throw new OntologyError(`The relationship ${l.type} has the ${end} ${k}, which is not an entity type here${withBase}. ` +
          'Add that entity type, or fix the relationship.');
      }
    }
    const entries = byType.get(l.type) ?? [];
    // A repeated (type, source, target) is one legal pair, as before.
    if (!entries.some((e) => e.source === l.source && e.target === l.target)) entries.push(l);
    byType.set(l.type, entries);
  }
  const edges = [...byType.values()].reduce((n, e) => n + e.length, 0);
  if (edges > MAX_RELATION_EDGES) {
    throw new OntologyError(`This ontology allows ${edges} kind-to-kind pairs, above the limit of ` +
      `${MAX_RELATION_EDGES}. Remove some relationships.`);
  }

  for (const k of Object.keys(data)) if (!CCG_KEYS.has(k)) report.dropped.push(k);
  const vis = data.visualization;
  if (vis !== undefined && vis !== null && !isMap(vis)) throw new OntologyError(`\`visualization\` must be a mapping, not ${show(vis)}`);
  const sizes = isMap(vis) && isMap(vis.node_sizes) ? vis.node_sizes : {};

  // nodes (keyed by label) and relationship entries, without their tools yet
  const nodes = {};
  for (const k of allKinds) {
    // neo4j:display carries what the spec's example shows (color, caption); create-context-graph's icon and
    // node size, which neo4j:display does not define, ride a custom envelope of their own.
    const display = obj([['color', k.color], ['caption', 'name']]);
    const looks = obj([['icon', k.icon], ['size', Object.hasOwn(sizes, k.label) ? sizes[k.label] : undefined]]);
    const pole = obj([['pole_type', k.pole], ['subtype', k.subtype ?? undefined], ['origin', k.origin]]);
    setOwn(nodes, k.label, obj([
      ['label', k.label],
      ['description', kindDescription(k.pole, k.subtype) || undefined],
      ['properties', ccgProperties(k.where, k.properties, report)],
      ['extensions', obj([[EXTENSIONS.display, display], ['custom', [{ type: EXTENSIONS.pole, definition: pole }, { type: CCG_DISPLAY, definition: looks }]]])],
    ]));
  }
  const relationships = {};
  const taken = new Set();
  for (const [type, entries] of byType) {
    for (const e of entries) {
      const key = freeKey(entries.length === 1 ? type : `${type}__${e.source}__${e.target}`, taken);
      setOwn(relationships, key, obj([
        ['type', type],
        ['from', { node: e.source }],
        ['to', { node: e.target }],
        ['properties', ccgProperties(e.where, e.properties, report)],
        ['extensions', { custom: [{ type: EXTENSIONS.origin, definition: { origin: e.origin } }] }],
      ]));
    }
  }

  // tools: agent_tools, then visualization.default_cypher as defaultView, each on the element its query starts from
  const nodeList = /** @type {Array<[string, string]>} */ (allKinds.map((k) => [k.label, k.label]));
  const relList = /** @type {Array<[string, string]>} */ (Object.entries(relationships).map(([k, r]) => [k, r.type]));
  /** @type {Array<{tool: any, anchor: {kind: string, key: string, rule: string}}>} */
  const placed = [];
  const rawTools = Object.hasOwn(data, 'agent_tools') && data.agent_tools !== null ? data.agent_tools : [];
  if (!Array.isArray(rawTools)) throw new OntologyError(`\`agent_tools\` must be a list, not ${show(rawTools)}`);
  rawTools.forEach((t, i) => {
    const where = `agent_tools[${i}]`;
    if (!isMap(t)) throw new OntologyError(`${where}: a tool is {name, description, cypher, parameters}, not ${show(t)}`);
    const tname = stringField(where, t, 'name');
    const w = `${where} (${tname})`;
    for (const k of Object.keys(t)) if (!CCG_TOOL_KEYS.has(k)) report.dropped.push(`${w}.${k}`);
    const cypher = stringField(w, t, 'cypher', { optional: true });
    const tool = obj([
      ['type', 'canonicalQuery'],
      ['name', tname],
      ['description', stringField(w, t, 'description')],
      ['cypher', cypher || undefined],
      ['parameters', toolParameters(w, t.parameters)],
    ]);
    placed.push({ tool, anchor: toolAnchor(cypher, nodeList, relList, (tool.parameters ?? []).map((/** @type {any} */ x) => x.name)) });
  });
  if (isMap(vis) && Object.hasOwn(vis, 'default_cypher')) {
    const cypher = stringField('visualization', vis, 'default_cypher');
    placed.push({
      tool: { type: 'canonicalQuery', name: 'defaultView', description: "create-context-graph's default visualisation query", cypher },
      anchor: toolAnchor(cypher, nodeList, relList),
    });
  }
  for (const { tool, anchor } of placed) {
    const el = anchor.kind === 'node' ? nodes[anchor.key] : relationships[anchor.key];
    if (!el.tools) el.tools = []; // toYaml writes it before extensions, in the schema's order
    el.tools.push(tool);
    report.tools.push({ name: tool.name, anchor: anchor.kind, element: anchor.key, rule: anchor.rule });
  }

  // everything else create-context-graph carries, verbatim, at the top level
  const domainRest = obj(Object.entries(dom).filter(([k]) => !['id', 'name', 'description', 'inherits'].includes(k)));
  if (inherits !== null) setOwn(domainRest, 'inherits', inherits);
  const custom = [{ type: EXTENSIONS.domain, definition: domainRest }];
  const verbatim = [['document_templates', 'createContextGraph:documentTemplates'], ['decision_traces', 'createContextGraph:decisionTraces'],
    ['demo_scenarios', 'createContextGraph:demoScenarios'], ['system_prompt', 'createContextGraph:systemPrompt'], ['visualization', 'createContextGraph:visualization']];
  for (const [key, type] of verbatim) {
    const v = data[key];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (isMap(v) && Object.keys(v).length === 0)) continue;
    custom.push({ type, definition: v });
  }
  const doc = obj([
    ['$schema', SCHEMA_ID],
    ['id', id],
    ['version', 1],
    ['name', name],
    ['description', description || undefined],
    ['nodes', nodes],
    ['relationships', Object.keys(relationships).length ? relationships : undefined],
    ['extensions', { custom }],
  ]);
  return { doc, report, inherits, baseText };
}
