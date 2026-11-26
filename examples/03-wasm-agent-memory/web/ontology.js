// @ts-check
/**
 * ontology.js: the memory model as a document of the Neo4j Ontology Graph Specification 1.1
 * (data/agent-memory.ontology.json), read as written (NOTES.md D10, D11).
 *
 * memory.js SCHEMA is what the engine is given. The document says the same thing in a format other
 * tools read, and says more: what each label, property and relationship type means, and the rules
 * the engine does not enforce. Nothing here touches the DOM or the engine: the Ontology tab
 * (ontology-tab.js) and harness/run.mjs call the same functions, so what the tab shows is what the
 * regression run checks.
 *
 *   outline(doc)                 the document's parts, flat: what the tab lists, draws and searches
 *   graphType(doc)               the graph type the document describes, spelt as the engine prints its own
 *   engineSchema(doc)            the constraints and indexes the engine should then hold
 *   rules(doc)                   what the document says and the engine does not enforce: values, counts,
 *                                invariants, and that everything stored is declared; each rule with the
 *                                statements that find its violations
 *   judge(rules, results)        those rules against the rows their statements returned
 *   audit(doc, run)              both at once, for a caller that can run a statement and wait
 *   search(doc, text)            the parts that hold every word of the text, best first
 *   picture(doc, {expanded})     the labels and relationship types as a graph to draw, one label's
 *                                properties around it on request
 *   tally(doc, snapshot)         how many of each label and relationship type a store holds
 *   instances(doc, key, snapshot)  the stored nodes and relationships a part describes, as paths to light
 *   bind(doc, question, snapshot)  values for a question's parameters, from what the store holds
 *
 * A part's key is `<kind>:<id>`: node:memory, property:memory.kind, relationship:about,
 * index:memory.memory-embedding, question:what-changed, invariant:one-current-memory-per-slot.
 */
import { words } from './embed.js';

/** The key this repository's own data sits under in every `extensions.custom` of the document. */
export const NS = 'relate-examples';

/** @param {any} x  a node, relationship, property, constraint or the document @returns {Record<string, any>} */
export const own = (x) => x?.extensions?.custom?.[NS] ?? x?.custom?.[NS] ?? {};
/** A node's identifying label, written short (`label`) or long (`labels.identifier`). @param {any} node @returns {string} */
export const labelOf = (node) => node?.label ?? node?.labels?.identifier ?? '';
/** A property's name in the database. @param {string} pid @param {any} p @returns {string} */
const nameOf = (pid, p) => p?.name ?? pid;
/** An identifier as Cypher takes it. @param {string} s */
const ident = (s) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : `\`${s.replace(/`/g, '``')}\``);
const sorted = (/** @type {string[]} */ xs) => [...xs].sort();

/**
 * A node's constraints: the ones written out, and the ones its properties' shorthand stands for.
 * @param {any} node
 * @returns {Array<{id: string, type: string, properties: string[], name: string|null, def: any}>}
 */
export function constraintsOf(node) {
  const list = Object.entries(node?.constraints ?? {}).map(([id, c]) => ({ id, type: /** @type {any} */ (c).type, properties: /** @type {any} */ (c).properties ?? [], name: /** @type {any} */ (c).name ?? null, def: c }));
  for (const [pid, p] of Object.entries(node?.properties ?? {})) {
    for (const [flag, type] of /** @type {Array<[string, string]>} */ ([['must_exist', 'EXISTS'], ['unique', 'UNIQUE'], ['key', 'KEY']])) {
      if (/** @type {any} */ (p)[flag]) list.push({ id: `${pid}:${flag}`, type, properties: [pid], name: null, def: {} });
    }
  }
  return list;
}

/** What the document says of one property: required, unique, type-checked. @param {any} node @param {string} pid */
export function facts(node, pid) {
  const cs = constraintsOf(node).filter((c) => c.properties.includes(pid));
  const one = (/** @type {string} */ t) => cs.find((c) => c.type === t && c.properties.length === 1);
  return {
    required: cs.some((c) => c.type === 'EXISTS' || c.type === 'KEY'),
    unique: one('UNIQUE') ?? one('KEY') ?? null,
    typed: !!one('PROPERTY_TYPE'),
  };
}

/** The property that tells one node of this kind from another: the one its UNIQUE or KEY constraint covers. @param {any} node @returns {string|null} */
export function identity(node) {
  const c = constraintsOf(node).find((x) => (x.type === 'UNIQUE' || x.type === 'KEY') && x.properties.length === 1);
  return c ? c.properties[0] : null;
}

/** A property's type as Relate 1.3.0 prints it in a graph type. @param {any} p */
export function engineType(p) {
  return String(p.type).startsWith('VECTOR') ? `${String(p.type).replace('>', ' NOT NULL>')}(${p.dimension})` : String(p.type);
}

// ---- the parts -----------------------------------------------------------------------------------

/**
 * @typedef {{key: string, kind: 'node'|'property'|'relationship'|'index'|'question'|'invariant',
 *            id: string, owner?: string, title: string, def: any}} Part
 */

/** Every part of the document, in its order. @param {any} doc @returns {Part[]} */
export function outline(doc) {
  /** @type {Part[]} */ const parts = [];
  for (const [nid, n] of Object.entries(doc.nodes ?? {})) {
    parts.push({ key: `node:${nid}`, kind: 'node', id: nid, title: labelOf(n), def: n });
    for (const [pid, p] of Object.entries(/** @type {any} */ (n).properties ?? {})) {
      parts.push({ key: `property:${nid}.${pid}`, kind: 'property', id: pid, owner: nid, title: `${labelOf(n)}.${nameOf(pid, p)}`, def: p });
    }
    for (const [iid, i] of Object.entries(/** @type {any} */ (n).extensions?.indexes ?? {})) {
      parts.push({ key: `index:${nid}.${iid}`, kind: 'index', id: iid, owner: nid, title: /** @type {any} */ (i).name ?? iid, def: i });
    }
  }
  for (const [rid, r] of Object.entries(doc.relationships ?? {})) {
    parts.push({ key: `relationship:${rid}`, kind: 'relationship', id: rid, title: /** @type {any} */ (r).type, def: r });
  }
  for (const q of own(doc).questions ?? []) parts.push({ key: `question:${q.id}`, kind: 'question', id: q.id, title: q.question, def: q });
  for (const v of own(doc).invariants ?? []) parts.push({ key: `invariant:${v.id}`, kind: 'invariant', id: v.id, title: v.rule, def: v });
  return parts;
}

/**
 * How many relationships a node has at one end, in words and as the test that finds a breach:
 * null when the document sets no bound.
 * @param {any} end  a relationship's `from` or `to`
 * @returns {{words: string, breach: string}|null}
 */
export function bound(end) {
  if (end?.count !== undefined && end.count !== null) return { words: `exactly ${end.count}`, breach: `n <> ${end.count}` };
  const min = end?.min_count ?? 0;
  const max = end?.max_count ?? null;
  if (min > 0 && max !== null) return { words: `${min} to ${max}`, breach: `n < ${min} OR n > ${max}` };
  if (min > 0) return { words: `at least ${min}`, breach: `n < ${min}` };
  if (max !== null) return { words: `at most ${max}`, breach: `n > ${max}` };
  return null;
}

// ---- the document and the engine -----------------------------------------------------------------

/**
 * The graph type the document describes, spelt as Relate 1.3.0 prints the current one
 * (SHOW CURRENT GRAPH TYPE): labels, relationship types and constraints in name order, every name
 * in backticks. Equal text means the engine enforces exactly what the document declares.
 * @param {any} doc
 */
export function graphType(doc) {
  const q = (/** @type {string} */ s) => `\`${s}\``;
  const nodes = Object.values(doc.nodes ?? {}).sort((a, b) => (labelOf(a) < labelOf(b) ? -1 : 1));
  const lines = nodes.map((n) => {
    const props = Object.entries(n.properties ?? {}).map(([pid, p]) => ({ name: nameOf(pid, p), text: `${engineType(p)}${facts(n, pid).required ? ' NOT NULL' : ''}` }));
    props.sort((a, b) => (a.name < b.name ? -1 : 1));
    return `  (:${q(labelOf(n))} => {${props.map((p) => `${q(p.name)} :: ${p.text}`).join(', ')}})`;
  });
  const rels = Object.values(doc.relationships ?? {}).sort((a, b) => (a.type < b.type ? -1 : 1));
  for (const r of rels) lines.push(`  (:${q(labelOf(doc.nodes[r.from.node]))} =>)-[:${q(r.type)} =>]->(:${q(labelOf(doc.nodes[r.to.node]))} =>)`);
  const unique = nodes.flatMap((n) => constraintsOf(n).filter((c) => c.type === 'UNIQUE' && c.name).map((c) => ({ name: /** @type {string} */ (c.name), label: labelOf(n), props: c.properties.map((pid) => nameOf(pid, n.properties[pid])) })));
  unique.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const u of unique) lines.push(`  CONSTRAINT ${q(u.name)} FOR (${q('n')}:${q(u.label)} =>) REQUIRE (${u.props.map((p) => `${q('n')}.${q(p)}`).join(', ')}) IS UNIQUE`);
  return `{\n${lines.join(',\n')}\n}`;
}

/**
 * What the engine should hold once the schema is applied, as sorted lists of lines: one per
 * property type, existence and uniqueness constraint, per relationship end, and per index.
 * harness/run.mjs writes SHOW CONSTRAINTS and SHOW INDEXES the same way and compares.
 * @param {any} doc
 */
export function engineSchema(doc) {
  /** @type {Record<'types'|'exists'|'unique'|'sources'|'targets'|'indexes', string[]>} */
  const out = { types: [], exists: [], unique: [], sources: [], targets: [], indexes: [] };
  for (const n of Object.values(doc.nodes ?? {})) {
    const label = labelOf(n);
    const name = (/** @type {string} */ pid) => nameOf(pid, n.properties?.[pid]);
    for (const c of constraintsOf(n)) {
      if (c.type === 'PROPERTY_TYPE') out.types.push(`${label}.${name(c.properties[0])} :: ${engineType(n.properties[c.properties[0]])}`);
      if (c.type === 'EXISTS') out.exists.push(`${label}.${name(c.properties[0])}`);
      if (c.type === 'UNIQUE') out.unique.push(`${c.name} ${label}(${c.properties.map(name).join(', ')})`);
    }
    for (const i of Object.values(n.extensions?.indexes ?? {})) out.indexes.push(`${i.name} ${i.type} ${i.labels.join(', ')}(${i.properties.map(name).join(', ')})`);
  }
  for (const r of Object.values(doc.relationships ?? {})) {
    out.sources.push(`${r.type} ${labelOf(doc.nodes[r.from.node])}`);
    out.targets.push(`${r.type} ${labelOf(doc.nodes[r.to.node])}`);
  }
  for (const k of /** @type {Array<keyof typeof out>} */ (Object.keys(out))) out[k].sort();
  return out;
}

// ---- the rules the engine does not enforce -------------------------------------------------------

/**
 * @typedef {{id: string, group: 'values'|'counts'|'invariants'|'declared', part: string|null, says: string,
 *            statements: Array<{text: string, params: Record<string, any>}>,
 *            check: (results: any[][]) => string[]}} Rule
 *   part: the key of the part the rule belongs to. check: the rows of each statement -> one line
 *   per violation.
 */

/**
 * The rules, each with the statements that find its violations: the allowed values and patterns
 * of a property, the number of relationships at each end, the document's invariants, and that the
 * store holds nothing the document does not declare (the engine accepts an undeclared property).
 * @param {any} doc
 * @returns {Rule[]}
 */
export function rules(doc) {
  /** @type {Rule[]} */ const out = [];
  const nodes = doc.nodes ?? {};
  const rels = doc.relationships ?? {};
  const idOf = (/** @type {any} */ n, /** @type {string} */ v) => { const p = identity(n); return p ? `${v}.${ident(nameOf(p, n.properties[p]))}` : `toString(id(${v}))`; };
  for (const [nid, n] of Object.entries(nodes)) {
    const label = labelOf(n);
    for (const [pid, p] of Object.entries(/** @type {any} */ (n).properties ?? {})) {
      const name = nameOf(pid, p);
      /** @type {string[]|undefined} */ const oneOf = p.one_of;
      /** @type {string|undefined} */ const pattern = p.pattern;
      if (!oneOf && !pattern) continue;
      out.push({
        id: `${label}.${name}`,
        group: 'values',
        part: `property:${nid}.${pid}`,
        says: oneOf ? `${label}.${name} is one of: ${oneOf.join(', ')}` : `${label}.${name} matches ${pattern}`,
        statements: [{ text: `MATCH (n:${ident(label)})\nWHERE n.${ident(name)} IS NOT NULL\nRETURN ${idOf(n, 'n')} AS id, n.${ident(name)} AS value\nORDER BY id`, params: {} }],
        check: ([rows]) => rows
          .filter((r) => typeof r.value !== 'string' || (oneOf ? !oneOf.includes(r.value) : !new RegExp(/** @type {string} */ (pattern)).test(r.value)))
          .map((r) => `${r.id}: ${JSON.stringify(r.value)}`),
      });
    }
  }
  for (const [rid, r] of Object.entries(rels)) {
    for (const end of /** @type {Array<'from'|'to'>} */ (['from', 'to'])) {
      const b = bound(r[end]);
      const n = nodes[r[end].node];
      if (!b || !n) continue;
      const pattern = end === 'from' ? `(x)-[r:${ident(r.type)}]->()` : `(x)<-[r:${ident(r.type)}]-()`;
      out.push({
        id: `${r.type} ${end}`,
        group: 'counts',
        part: `relationship:${rid}`,
        says: `every ${labelOf(n)} has ${b.words} ${r.type} ${end === 'from' ? 'going out' : 'coming in'}`,
        statements: [{ text: `MATCH (x:${ident(labelOf(n))})\nOPTIONAL MATCH ${pattern}\nWITH x, count(r) AS n\nWHERE ${b.breach}\nRETURN ${idOf(n, 'x')} AS id, n\nORDER BY id`, params: {} }],
        check: ([rows]) => rows.map((row) => `${row.id}: ${row.n}`),
      });
    }
  }
  for (const v of own(doc).invariants ?? []) {
    out.push({
      id: v.id,
      group: 'invariants',
      part: `invariant:${v.id}`,
      says: v.rule,
      statements: [{ text: v.violations, params: {} }],
      check: ([rows]) => rows.map((row) => Object.entries(row).map(([k, x]) => `${k} ${JSON.stringify(x)}`).join(', ')),
    });
  }
  const byLabel = new Map(Object.values(nodes).map((n) => [labelOf(n), n]));
  const byType = new Map(Object.values(rels).map((r) => [r.type, r]));
  out.push({
    id: 'declared',
    group: 'declared',
    part: null,
    says: 'every node, relationship and property in the store is one the document declares',
    statements: [
      { text: 'MATCH (n)\nRETURN labels(n) AS labels, keys(n) AS keys, count(*) AS nodes', params: {} },
      { text: 'MATCH (a)-[r]->(b)\nRETURN type(r) AS type, labels(a) AS source, labels(b) AS target, keys(r) AS keys, count(*) AS relationships', params: {} },
    ],
    check: ([nodeRows, relRows]) => {
      const bad = new Set();
      for (const row of nodeRows) {
        const n = row.labels.length === 1 ? byLabel.get(row.labels[0]) : null;
        if (!n) { bad.add(`a node labelled ${row.labels.length ? `:${row.labels.join(':')}` : 'nothing'}`); continue; }
        const declared = Object.entries(n.properties ?? {}).map(([pid, p]) => ({ pid, name: nameOf(pid, p) }));
        for (const k of row.keys) if (!declared.some((d) => d.name === k)) bad.add(`:${row.labels[0]} has the undeclared property ${k}`);
        for (const d of declared) if (facts(n, d.pid).required && !row.keys.includes(d.name)) bad.add(`:${row.labels[0]} lacks ${d.name}`);
      }
      for (const row of relRows) {
        const r = byType.get(row.type);
        const shape = `(:${row.source.join(':')})-[:${row.type}]->(:${row.target.join(':')})`;
        if (!r) { bad.add(`${shape}, a type the document does not have`); continue; }
        if (row.source.join() !== labelOf(nodes[r.from.node]) || row.target.join() !== labelOf(nodes[r.to.node])) bad.add(`${shape}, between the wrong labels`);
        const declared = Object.entries(r.properties ?? {}).map(([pid, p]) => nameOf(pid, p));
        for (const k of row.keys) if (!declared.includes(k)) bad.add(`-[:${row.type}]-> has the undeclared property ${k}`);
      }
      return sorted([...bad]);
    },
  });
  return out;
}

/**
 * The rules against what their statements returned.
 * @param {Rule[]} list @param {any[][]} results  the rows of every statement, in the rules' order
 * @returns {Array<{id: string, group: string, part: string|null, says: string, statements: string[], violations: string[]}>}
 */
export function judge(list, results) {
  let i = 0;
  return list.map((r) => {
    const mine = results.slice(i, i + r.statements.length);
    i += r.statements.length;
    return { id: r.id, group: r.group, part: r.part, says: r.says, statements: r.statements.map((s) => s.text), violations: r.check(mine) };
  });
}

/**
 * Every rule against a store.
 * @param {any} doc @param {(statement: string, params: Record<string, any>) => any[]} run  one statement -> its rows
 */
export function audit(doc, run) {
  const list = rules(doc);
  return judge(list, list.flatMap((r) => r.statements.map((s) => run(s.text, s.params))));
}

// ---- search --------------------------------------------------------------------------------------

/** Every string inside a value, in order. @param {any} v @returns {string[]} */
function strings(v) {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => [k.replace(/_/g, ' '), ...strings(x)]);
  return [];
}

/**
 * What a search reads of a part: [weight, where the reader is told the match was, the text].
 * @param {Part} part @param {any} doc
 * @returns {Array<[number, string, string]>}
 */
function fields(part, doc) {
  const d = part.def;
  /** @type {Array<[number, string, string]>} */ const f = [];
  const common = () => {
    for (const a of d.aliases ?? []) f.push([8, `also called ${a}`, a]);
    if (d.description) f.push([2, 'its description', d.description]);
    if (d.reference) f.push([1, 'its reference', d.reference]);
  };
  if (part.kind === 'node') {
    f.push([10, 'the label', part.title], [6, 'its id', part.id]);
    common();
  } else if (part.kind === 'property') {
    const n = doc.nodes[/** @type {string} */ (part.owner)];
    const fact = facts(n, part.id);
    f.push([10, 'the property', nameOf(part.id, d)], [3, 'its label', labelOf(n)], [4, 'its type', String(d.type ?? '')]);
    for (const v of d.one_of ?? []) f.push([7, `the value ${v}`, v]);
    f.push([3, 'a rule', `${fact.required ? 'required' : 'optional'}${fact.unique ? ' unique' : ''}`]);
    if (fact.unique?.name) f.push([6, 'its constraint', fact.unique.name]);
    common();
    f.push([1, 'in this example', strings(own(d)).join(' ')]);
  } else if (part.kind === 'relationship') {
    f.push([10, 'the type', part.title], [3, 'its ends', `${labelOf(doc.nodes[d.from.node])} ${labelOf(doc.nodes[d.to.node])}`]);
    common();
  } else if (part.kind === 'index') {
    const kind = { VECTOR: 'vector search by meaning', FULLTEXT: 'fulltext full-text search by words' }[/** @type {string} */ (d.type)] ?? '';
    f.push([10, 'the index', part.title], [6, 'its kind', `${d.type} ${kind}`], [4, 'what it covers', `${d.labels.join(' ')} ${d.properties.join(' ')}`]);
    f.push([1, 'in this example', strings(own(d)).join(' ')]);
  } else if (part.kind === 'question') {
    f.push([6, 'the question', d.question], [1, 'its statement', d.cypher]);
  } else {
    f.push([6, 'the rule', d.rule], [4, 'its id', part.id], [1, 'its statement', d.violations]);
  }
  return f;
}

/**
 * The parts that hold every word of the text, best first. A word matches a word of a field whole,
 * or as its beginning for three quarters of the weight; names weigh more than aliases and values,
 * and those more than descriptions. Words are folded as entity keys are (embed.js words).
 * @param {any} doc @param {string} text
 * @returns {Array<{key: string, kind: string, title: string, score: number, where: string}>}
 */
export function search(doc, text) {
  const terms = [...new Set(words(text))];
  if (!terms.length) return [];
  const hits = [];
  for (const [at, part] of outline(doc).entries()) {
    const fs = fields(part, doc).map(([w, where, t]) => ({ w, where, ws: words(t) }));
    let score = 0;
    let best = { s: 0, where: '' };
    let all = true;
    for (const term of terms) {
      let top = { s: 0, where: '' };
      for (const f of fs) {
        const s = f.ws.includes(term) ? f.w : term.length > 1 && f.ws.some((w) => w.startsWith(term)) ? 0.75 * f.w : 0;
        if (s > top.s) top = { s, where: f.where };
      }
      if (!top.s) { all = false; break; }
      score += top.s;
      if (top.s > best.s) best = top;
    }
    if (all) hits.push({ key: part.key, kind: part.kind, title: part.title, score, where: best.where, at });
  }
  hits.sort((a, b) => b.score - a.score || a.at - b.at);
  return hits.map(({ at, ...h }) => h);
}

// ---- the picture ---------------------------------------------------------------------------------

/** The document's coordinates are a diagram's; the tab draws them closer together. */
const SPREAD = 0.6;
/** A label's radius and a property's, in CSS pixels at a scale of 1. */
export const RADIUS = Object.freeze({ node: 48, property: 28 });

/**
 * The model as a graph to draw: a node per label where the document places it, a relationship per
 * relationship type, and, when one label is expanded, its properties on an arc on its far side
 * from the others.
 * @param {any} doc @param {{expanded?: string|null}} [options]  expanded: a node id
 * @returns {{nodes: Array<{key: string, kind: 'node'|'property', caption: string, x: number, y: number, r: number, required?: boolean}>,
 *            rels: Array<{key: string, kind: 'relationship'|'has', from: string, to: string, caption: string}>}}
 */
export function picture(doc, { expanded = null } = {}) {
  /** @type {ReturnType<typeof picture>['nodes']} */ const nodes = [];
  /** @type {ReturnType<typeof picture>['rels']} */ const rels = [];
  const place = new Map();
  for (const [nid, n] of Object.entries(doc.nodes ?? {})) {
    const d = /** @type {any} */ (n).extensions?.display ?? { x: 0, y: 0 };
    place.set(nid, { x: Math.round(d.x * SPREAD), y: Math.round(d.y * SPREAD) });
    nodes.push({ key: `node:${nid}`, kind: 'node', caption: labelOf(n), ...place.get(nid), r: RADIUS.node });
  }
  for (const [rid, r] of Object.entries(doc.relationships ?? {})) {
    rels.push({ key: `relationship:${rid}`, kind: 'relationship', from: `node:${/** @type {any} */ (r).from.node}`, to: `node:${/** @type {any} */ (r).to.node}`, caption: /** @type {any} */ (r).type });
  }
  const n = expanded ? doc.nodes?.[expanded] : null;
  if (n && expanded) {
    const props = Object.entries(n.properties ?? {});
    const all = [...place.values()];
    const cx = all.reduce((s, p) => s + p.x, 0) / all.length;
    const cy = all.reduce((s, p) => s + p.y, 0) / all.length;
    const at = place.get(expanded);
    const away = Math.atan2(at.y - cy, at.x - cx);
    // an arc of at most 160 degrees, wide enough that neighbours do not touch
    const step = props.length > 1 ? Math.min(26, 160 / (props.length - 1)) * (Math.PI / 180) : 0;
    const gap = 2 * RADIUS.property + 4;
    const reach = Math.max(RADIUS.node + RADIUS.property + 48, step ? Math.ceil(gap / (2 * Math.sin(step / 2))) : 0);
    // the places on the arc, read as text is: left to right when the arc is above or below the
    // label, top to bottom when it is beside it; the properties take them in the document's order
    const across = Math.abs(Math.sin(away)) >= Math.abs(Math.cos(away));
    const places = props.map((_, i) => {
      const a = away + (i - (props.length - 1) / 2) * step;
      return { x: Math.round(at.x + reach * Math.cos(a)), y: Math.round(at.y + reach * Math.sin(a)) };
    }).sort((a, b) => (across ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x));
    props.forEach(([pid, p], i) => {
      const key = `property:${expanded}.${pid}`;
      nodes.push({ key, kind: 'property', caption: nameOf(pid, p), ...places[i], r: RADIUS.property, required: facts(n, pid).required });
      rels.push({ key: `has:${expanded}.${pid}`, kind: 'has', from: `node:${expanded}`, to: key, caption: '' });
    });
  }
  return { nodes, rels };
}

// ---- the document and a store --------------------------------------------------------------------

/**
 * @typedef {{nodes: Array<{id: number, label: string, props: Record<string, any>}>,
 *            rels: Array<{id: number, type: string, source: number, target: number}>}} Snapshot  memory.js snapshot()
 */

/** How many of each part a store holds: {part key -> count} for labels and relationship types. @param {any} doc @param {Snapshot} snapshot */
export function tally(doc, snapshot) {
  /** @type {Record<string, number>} */ const out = {};
  for (const [nid, n] of Object.entries(doc.nodes ?? {})) out[`node:${nid}`] = snapshot.nodes.filter((x) => x.label === labelOf(n)).length;
  for (const [rid, r] of Object.entries(doc.relationships ?? {})) out[`relationship:${rid}`] = snapshot.rels.filter((x) => x.type === /** @type {any} */ (r).type).length;
  return out;
}

/**
 * The stored nodes and relationships a part describes, as paths the Memory tab can light: every
 * node of a label, every relationship of a type with its two ends, every node that has a property.
 * A snapshot leaves vectors out and says `embedded` instead.
 * @param {any} doc @param {string} key @param {Snapshot} snapshot
 * @returns {Array<{nodes: number[], rels: number[], strong: boolean}>}
 */
export function instances(doc, key, snapshot) {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'relationship') {
    const type = doc.relationships?.[id]?.type;
    return snapshot.rels.filter((r) => r.type === type).map((r) => ({ nodes: [r.source, r.target], rels: [r.id], strong: true }));
  }
  const [nid, pid] = id.split('.');
  const n = doc.nodes?.[nid];
  if (!n || (kind !== 'node' && kind !== 'property')) return [];
  const name = pid ? nameOf(pid, n.properties?.[pid]) : null;
  const has = (/** @type {Record<string, any>} */ props) => name === null || (name === 'embedding' ? props.embedded === true : props[name] !== undefined && props[name] !== null);
  return snapshot.nodes.filter((x) => x.label === labelOf(n) && has(x.props)).map((x) => ({ nodes: [x.id], rels: [], strong: true }));
}

/**
 * Values for a question's parameters from what the store holds. Each parameter names the property
 * it takes a value of (`of`: `<node id>.<property id>`). The pick: the document's example when the
 * store has it; otherwise the best-connected node, and for a second parameter of the same kind,
 * the node that shares the most neighbours with the first, so that a question about two entities
 * starts on two that have something in common.
 * @param {any} doc @param {any} question @param {Snapshot} snapshot
 * @returns {{values: Record<string, any>, choices: Record<string, any[]>}}
 */
export function bind(doc, question, snapshot) {
  /** @type {Record<string, any>} */ const values = {};
  /** @type {Record<string, any[]>} */ const choices = {};
  const near = new Map(snapshot.nodes.map((n) => [n.id, new Set()]));
  for (const r of snapshot.rels) { near.get(r.source)?.add(r.target); near.get(r.target)?.add(r.source); }
  /** @type {Map<string, number[]>} */ const picked = new Map();
  for (const [name, spec] of Object.entries(/** @type {Record<string, any>} */ (question.parameters ?? {}))) {
    const [nid, pid] = String(spec.of).split('.');
    const n = doc.nodes?.[nid];
    const prop = nameOf(pid, n?.properties?.[pid]);
    const of = snapshot.nodes.filter((x) => x.label === labelOf(n) && x.props[prop] !== undefined && x.props[prop] !== null);
    choices[name] = sorted([...new Set(of.map((x) => String(x.props[prop])))]);
    const before = picked.get(spec.of) ?? [];
    const free = of.filter((x) => !before.includes(x.id));
    const shared = (/** @type {number} */ id) => before.reduce((s, b) => s + [...(near.get(id) ?? [])].filter((x) => near.get(b)?.has(x)).length, 0);
    const rank = (/** @type {any} */ a, /** @type {any} */ b) => shared(b.id) - shared(a.id) || (near.get(b.id)?.size ?? 0) - (near.get(a.id)?.size ?? 0) || (String(a.props[prop]) < String(b.props[prop]) ? -1 : 1);
    const pick = free.find((x) => x.props[prop] === spec.example) ?? [...free].sort(rank)[0] ?? null;
    if (pick) { values[name] = pick.props[prop]; picked.set(spec.of, [...before, pick.id]); } else values[name] = spec.example ?? '';
  }
  return { values, choices };
}
