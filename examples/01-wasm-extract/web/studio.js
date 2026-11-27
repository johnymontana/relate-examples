// @ts-check
/**
 * studio.js: one of Neo4j's solution packages (github.com/neo4j/studio-agent-use-cases, vendored in
 * data/ontologies/studio/<package>/ by harness/vendor-studio.mjs) as the Ontology Graph Spec 1.1
 * document this example bundles (D21). Pure and shared: harness/convert.mjs writes the bundled
 * documents with it, and harness/ontology.mjs checks each is a fresh conversion and that the
 * conversion loses nothing.
 *
 *   const { doc, report } = fromStudioPackage({ ontology, queries, overlay, source });
 *   //   ontology: the package's ONTOLOGY.json text; queries: its QUERIES.md text;
 *   //   overlay: data/ontologies/studio/<package>.overlay.yaml, parsed; source: {repository, commit, package, files}
 *   stripStudio(doc, overlay)  // the package's own document back (what the conversion added taken away)
 *   parseQueries(text)         // [{heading, fields: {name, description, params, ...}, cypher}] from QUERIES.md
 *
 * What the conversion does, and nothing else:
 *   1. `schema` names 1.1.0 instead of 1.0.0 (ogs.js fromSpec10: 1.1.0 is 1.0.0 with property aliases added).
 *   2. The overlay, this repository's own text, adds per node `display.colour`, the model's cue
 *      (`relate-examples.ask`), `extract: false` where a kind is not asked, and a `pattern` on a key
 *      property the package left without one (D25); per relationship the link phrase
 *      (`relate-examples.phrase`); on the document `relate-examples` {family, source, card, industry, about}.
 *      An overlay may only add: it never replaces a field the package has (a refusal otherwise).
 *   3. Every query of QUERIES.md becomes a canonicalQuery tool on the element it is about
 *      (convert.js toolAnchor), its annotation block read into the tool's fields and the block itself
 *      left out of `cypher`. The overlay's `tools` entry for a query adds example arguments (`args`),
 *      which the audit and the page's prefill use, and nothing else.
 */
import { paramBindings, toolAnchor } from './convert.js';
import { EXTENSIONS, OntologyError, SPEC_1_0_URL, fromSpec10, isMap, isSpec10, nodeLabel } from './ogs.js';

/** The fields of a query's annotation block, as QUERIES.md writes them (`@name`, …). */
export const ANNOTATION_FIELDS = Object.freeze(['name', 'description', 'params', 'prerequisites', 'returns', 'usage', 'tags', 'sample']);

/** What a tool calls that the page's engine does not have, by the names its Cypher uses. */
const REQUIRES = Object.freeze([['gds', /\bgds\./u], ['apoc', /\bapoc\./u]]);
/** A clause that writes: the console's read-only lease refuses such a tool when it reaches the write (R15). */
const WRITES = /\b(?:CREATE|MERGE|SET|DELETE|REMOVE|DETACH)\b/u;
/** A schema statement only (the package's constraints for its import): the page's store has its own (R16). */
const SETUP = /^\s*CREATE\s+(?:CONSTRAINT|INDEX)\b/iu;

/**
 * The queries of a QUERIES.md: each ```cypher block with the `## ` heading above it and its
 * annotation block (`/* @name … *\/`) read into fields; continuation lines join their field with one space.
 * @param {string} text
 * @returns {Array<{heading: string, fields: Record<string, string>, cypher: string}>}
 */
export function parseQueries(text) {
  const out = [];
  let heading = '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const h = /^##\s+(.*)$/.exec(lines[i]);
    if (h) {
      heading = h[1].trim();
      continue;
    }
    if (!/^```cypher\s*$/.test(lines[i])) continue;
    const body = [];
    for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
    const block = body.join('\n');
    const m = /^\s*\/\*([\s\S]*?)\*\/\s*/.exec(block);
    /** @type {Record<string, string>} */
    const fields = {};
    if (m) {
      let cur = null;
      for (const raw of m[1].split('\n')) {
        const line = raw.replace(/^\s*\*\s?/, '');
        const f = /^@([a-z]+)\s*(.*)$/.exec(line.trim());
        if (f) {
          cur = f[1];
          fields[cur] = f[2].trim();
        } else if (cur !== null && line.trim() !== '') {
          fields[cur] = `${fields[cur]}\n${line.replace(/\s+$/, '')}`;
        }
      }
    }
    out.push({ heading, fields, cypher: (m ? block.slice(m[0].length) : block).trim() });
  }
  return out;
}

/** A field's text on one line: its continuation lines joined with single spaces. @param {string|undefined} s */
const oneLine = (s) => (s ?? '').split('\n').map((x) => x.trim()).filter(Boolean).join(' ');

/**
 * The parameters an `@params` field declares, in its order: `name - description` entries, each
 * continued by more deeply indented lines; `None` is none. @param {string|undefined} text
 * @returns {Array<{name: string, description: string}>}
 */
export function parseParams(text) {
  const t = (text ?? '').trim();
  if (t === '' || /^none\b/i.test(t)) return [];
  const out = [];
  for (const line of t.split('\n')) {
    const e = /^\s*\$?([A-Za-z_][A-Za-z0-9_]*)\s+-\s+(.*)$/.exec(line);
    if (e && (out.length === 0 || !/^\s{6,}/.test(line))) out.push({ name: e[1], description: e[2].trim() });
    else if (out.length) out[out.length - 1].description = `${out[out.length - 1].description} ${line.trim()}`.trim();
  }
  return out;
}

/** A query's name as a tool name: lower-case words joined by `-`. @param {string} s */
export const slug = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * The type of a parameter: the declared type of the property a binding compares it with
 * (convert.js paramBindings), else INTEGER for one used as a LIMIT, SKIP or a range bound in
 * `range(…)`, else STRING. @param {string} cypher @param {string} name @param {Map<string, any>} nodesByLabel
 */
function paramType(cypher, name, nodesByLabel) {
  for (const b of paramBindings(cypher).filter((x) => x.param === name)) {
    for (const l of b.labels) {
      const p = nodesByLabel.get(l)?.properties?.[b.props[0]];
      if (isMap(p) && typeof p.type === 'string') return p.type;
    }
  }
  if (new RegExp(String.raw`\b(?:LIMIT|SKIP)\s+\$${name}\b`, 'u').test(cypher)) return 'INTEGER';
  return 'STRING';
}

/** Which of the overlay's keys are not known. @param {any} x @param {string[]} known @param {string} where */
function onlyKnown(x, known, where) {
  for (const k of Object.keys(x ?? {})) if (!known.includes(k)) throw new OntologyError(`${where}: the overlay has no field ${JSON.stringify(k)} (it takes ${known.join(', ')})`);
}

/**
 * A solution package as this example's document (see the header).
 * @param {{ontology: string, queries: string, overlay: any, source: {repository: string, commit: string, package: string, files: string[]}}} input
 * @returns {{doc: any, report: {tools: Array<{name: string, anchor: string, rule: string, requires: string[], writes: boolean}>}}}
 */
export function fromStudioPackage({ ontology, queries, overlay, source }) {
  const up = JSON.parse(ontology);
  if (!isSpec10(up)) throw new OntologyError(`${source.package}: the package's document names ${JSON.stringify(up?.schema)}, not ${SPEC_1_0_URL}`);
  const doc = structuredClone(fromSpec10(up));
  const ov = overlay ?? {};
  onlyKnown(ov, ['package', 'card', 'industry', 'nodes', 'relationships', 'tools'], source.package);
  if (ov.package !== source.package) throw new OntologyError(`${source.package}: the overlay is for ${JSON.stringify(ov.package)}`);
  const custom = (el) => {
    el.extensions = el.extensions ?? {};
    el.extensions.custom = el.extensions.custom ?? {};
    if (Object.hasOwn(el.extensions.custom, EXTENSIONS.repo)) throw new OntologyError(`${source.package}: the package already has a ${EXTENSIONS.repo} extension`);
    return el.extensions.custom;
  };

  for (const [key, o] of Object.entries(ov.nodes ?? {})) {
    const where = `${source.package}: overlay nodes.${key}`;
    onlyKnown(o, ['colour', 'ask', 'extract', 'proper', 'propose', 'pattern', 'properties'], where);
    const n = doc.nodes?.[key];
    if (!isMap(n)) throw new OntologyError(`${where}: the package has no node ${key}`);
    if (o.colour !== undefined) {
      n.extensions = n.extensions ?? {};
      n.extensions.display = n.extensions.display ?? {};
      if (n.extensions.display.colour !== undefined) throw new OntologyError(`${where}: the package already gives a colour`);
      n.extensions.display.colour = o.colour;
    }
    const repo = {};
    for (const f of ['ask', 'extract', 'proper', 'propose']) if (o[f] !== undefined) repo[f] = o[f];
    if (Object.keys(repo).length) custom(n)[EXTENSIONS.repo] = repo;
    for (const [prop, pattern] of Object.entries(o.pattern ?? {})) {
      const p = n.properties?.[prop];
      if (!isMap(p)) throw new OntologyError(`${where}: the node has no property ${prop}`);
      if (p.pattern !== undefined) throw new OntologyError(`${where}: ${prop} already has a pattern`);
      p.pattern = pattern;
    }
    // D27: the properties the model reads values for (extract, its ask, and parse: DATE for a STRING that holds dates).
    for (const [prop, x] of Object.entries(o.properties ?? {})) {
      onlyKnown(x, ['extract', 'ask', 'parse'], `${where}.properties.${prop}`);
      const p = n.properties?.[prop];
      if (!isMap(p)) throw new OntologyError(`${where}: the node has no property ${prop}`);
      custom(p)[EXTENSIONS.repo] = { ...x };
    }
  }
  for (const [key, o] of Object.entries(ov.relationships ?? {})) {
    const where = `${source.package}: overlay relationships.${key}`;
    onlyKnown(o, ['phrase', 'extract'], where);
    const r = doc.relationships?.[key];
    if (!isMap(r)) throw new OntologyError(`${where}: the package has no relationship ${key}`);
    const repo = {};
    if (o.phrase !== undefined) repo.phrase = o.phrase;
    if (o.extract !== undefined) repo.extract = o.extract;
    if (Object.keys(repo).length) custom(r)[EXTENSIONS.repo] = repo;
  }

  // The queries, as tools on the element each is about.
  const nodes = Object.entries(doc.nodes ?? {}).map(([k, n]) => [k, nodeLabel(n)]);
  const rels = Object.entries(doc.relationships ?? {}).map(([k, r]) => [k, r.type]);
  const nodesByLabel = new Map(Object.values(doc.nodes ?? {}).map((n) => [nodeLabel(n), n]));
  const parsed = parseQueries(queries);
  const names = new Set();
  const report = { tools: /** @type {any[]} */ ([]) };
  for (const qd of parsed) {
    const question = oneLine(qd.fields.name) || qd.heading;
    let name = slug(question);
    for (let i = 2; names.has(name); i++) name = `${slug(question)}-${i}`;
    names.add(name);
    const fix = ov.tools?.[name] ?? {};
    onlyKnown(fix, ['args'], `${source.package}: overlay tools.${name}`);
    const declared = parseParams(qd.fields.params);
    const used = [...new Set([...qd.cypher.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/gu)].map((m) => m[1]))];
    const params = [...declared.map((p) => p.name), ...used.filter((u) => !declared.some((p) => p.name === u))];
    const parameters = params.map((p) => {
      const d = declared.find((x) => x.name === p);
      const ex = fix.args?.[p];
      const exType = typeof ex === 'number' ? (Number.isInteger(ex) ? 'INTEGER' : 'FLOAT') : typeof ex === 'boolean' ? 'BOOLEAN' : null;
      const out = { name: p, type: exType ?? paramType(qd.cypher, p, nodesByLabel), description: d?.description ?? '' };
      if (fix.args && Object.hasOwn(fix.args, p)) out.example = fix.args[p];
      return out;
    });
    const requires = REQUIRES.filter(([, re]) => re.test(qd.cypher)).map(([n]) => n);
    const writes = WRITES.test(qd.cypher.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\/\/[^\n]*/g, "''"));
    if (writes) requires.push('write');
    const tags = oneLine(qd.fields.tags).split(',').map((t) => t.trim()).filter(Boolean);
    const tool = {
      type: 'canonicalQuery',
      name,
      question,
      description: oneLine(qd.fields.description),
      cypher: qd.cypher,
      parameters,
      category: SETUP.test(qd.cypher) ? 'setup' : requires.includes('gds') ? 'graph data science' : writes ? 'writes'
        : tags.some((t) => /^visuali[sz]ation$/.test(t)) ? 'picture' : 'query',
      teaches: oneLine(qd.fields.usage),
      returns: oneLine(qd.fields.returns),
      prerequisites: oneLine(qd.fields.prerequisites),
      tags,
      requires,
      upstream: { file: 'QUERIES.md', heading: qd.heading, sample: oneLine(qd.fields.sample) },
    };
    for (const k of Object.keys(tool)) {
      const v = /** @type {any} */ (tool)[k];
      if (v === '' || (Array.isArray(v) && v.length === 0 && k !== 'parameters')) delete /** @type {any} */ (tool)[k];
    }
    const anchor = toolAnchor(qd.cypher, nodes, rels, params);
    const el = anchor.kind === 'node' ? doc.nodes[anchor.key] : doc.relationships[anchor.key];
    el.extensions = el.extensions ?? {};
    el.extensions.custom = el.extensions.custom ?? {};
    (el.extensions.custom[EXTENSIONS.tools] ??= []).push(tool);
    report.tools.push({ name, anchor: `${anchor.kind}:${anchor.key}`, rule: anchor.rule, requires, writes });
  }
  for (const name of Object.keys(ov.tools ?? {})) if (!names.has(name)) throw new OntologyError(`${source.package}: overlay tools.${name}: no query has that name`);

  doc.extensions = doc.extensions ?? {};
  doc.extensions.custom = doc.extensions.custom ?? {};
  if (Object.hasOwn(doc.extensions.custom, EXTENSIONS.repo)) throw new OntologyError(`${source.package}: the package already has a ${EXTENSIONS.repo} extension`);
  doc.extensions.custom[EXTENSIONS.repo] = {
    family: 'studio',
    source,
    ...(ov.card ? { card: ov.card } : {}),
    ...(ov.industry ? { industry: ov.industry } : {}),
    about: `data/ontologies/studio/${source.package}/human_description.md`,
  };
  return { doc, report };
}

/**
 * The package's own document back from a converted one (the losslessness check): `schema` names
 * 1.0.0 again, and what the overlay and the queries added goes. An extensions map or custom map left
 * empty goes too, unless the package had one.
 * @param {any} converted  fromStudioPackage's doc
 * @param {any} overlay
 * @param {any} upstream  the package's document as parsed (to know which maps it had)
 */
export function stripStudio(converted, overlay, upstream) {
  const doc = structuredClone(converted);
  doc.schema = SPEC_1_0_URL;
  const tidy = (el, had) => {
    if (isMap(el.extensions?.custom)) {
      delete el.extensions.custom[EXTENSIONS.repo];
      delete el.extensions.custom[EXTENSIONS.tools];
      if (Object.keys(el.extensions.custom).length === 0 && !isMap(had?.extensions?.custom)) delete el.extensions.custom;
    }
    if (isMap(el.extensions) && Object.keys(el.extensions).length === 0 && !isMap(had?.extensions)) delete el.extensions;
  };
  for (const [key, n] of Object.entries(doc.nodes ?? {})) {
    const o = overlay?.nodes?.[key] ?? {};
    if (o.colour !== undefined) delete n.extensions.display.colour;
    for (const prop of Object.keys(o.pattern ?? {})) delete n.properties[prop].pattern;
    for (const prop of Object.keys(o.properties ?? {})) tidy(n.properties[prop], upstream.nodes?.[key]?.properties?.[prop]);
    tidy(n, upstream.nodes?.[key]);
  }
  for (const [key, r] of Object.entries(doc.relationships ?? {})) tidy(r, upstream.relationships?.[key]);
  tidy(doc, upstream);
  return doc;
}
