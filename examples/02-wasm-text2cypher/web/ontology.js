// @ts-check
/**
 * ontology.js: the example's ontology, a published Ontology Graph Spec document
 * (data/corporate-events.ontology.yaml), read as a plain object, plus the helpers the rest of the
 * example reads it through. The helpers port the source app's ontospec_kg/ontology.py over the
 * same plain object (shorthand flags read as written, not expanded by the SDK), so the briefing,
 * the DDL and the validator come out as the Python did.
 *
 *   loadOntology(text, {ogs})   {doc, ok, issues, counts}: lib/ogs.mjs parses the text and the SDK
 *                               validates it over every validation set; ok = no decode or core issue
 *   nodeLabel(node)             the identifying label (`label`, else `labels.identifier`)
 *   nodeLabelsAll(node)         identifier + implied + optional labels
 *   propertyConstraints(id, p)  the shorthand flags as constraints (key = KEY; else UNIQUE, EXISTS)
 *   iterConstraints(doc)        every constraint, shorthand expanded, named as the Python names them
 *   iterIndexes(doc)            every index declared under element extensions
 *   relationshipSignature(doc, relId)   [type, from label, to label]
 *   legalRelationships(doc)     {relId: {type, from, to, description}}
 *   nodeColours(doc)            {label: extensions.display.colour}
 *   queryExamples(doc)          extensions.custom.query_examples: [{question, cypher}]
 *
 * Shared by the page, the engine worker and the Node harness: it imports only py.js; lib/ogs.mjs
 * reaches it through loadOntology's `ogs` argument (createOgs({yaml, sdk}), built by the caller).
 */
import { truthy } from './py.js';

/** The SDK's validation sets a report lists, in order (lib/ogs.mjs VALIDATION_SETS). */
export const SETS = Object.freeze(['core', 'labelled', 'consistentSchema', 'mappable', 'bulkImportable', 'wellConstrained']);

/**
 * @typedef {{set: string, code: string, path: string, message: string}} Issue
 * @typedef {{type: string, element: 'node'|'relationship', elementId: string, labelOrType: string, properties: string[], name: string}} Constraint
 * @typedef {{type: string, element: 'node'|'relationship', labelOrType: string, properties: string[], name: string, options: Record<string, any>}} Index
 */

/**
 * The document in `text` (YAML or JSON), validated by the Ontology Graph Spec SDK.
 * Throws lib/ogs.mjs's OntologyError when the text does not parse.
 * @param {string} text
 * @param {{ogs: {parse: (t: string) => any, validate: (d: any, sets: readonly string[]) => {ok: boolean, issues: Issue[]}}}} deps
 */
export function loadOntology(text, { ogs }) {
  const doc = ogs.parse(text);
  const { issues } = ogs.validate(doc, SETS);
  /** @type {Record<string, number>} */
  const counts = {};
  for (const s of ['decode', ...SETS]) counts[s] = 0;
  for (const i of issues) counts[i.set] = (counts[i.set] ?? 0) + 1;
  const ok = counts.decode === 0 && counts.core === 0;
  return { doc, ok, issues, counts };
}

/** @param {Record<string, any>} node */
export function nodeLabel(node) {
  if (truthy(node.label)) return node.label;
  const labels = node.labels ?? {};
  if (truthy(labels.identifier)) return labels.identifier;
  throw new Error(`node has neither \`label\` nor \`labels.identifier\`: ${JSON.stringify(node)}`);
}

/** @param {Record<string, any>} node */
export function nodeLabelsAll(node) {
  const labels = node.labels ?? {};
  return [nodeLabel(node), ...(labels.implied ?? []), ...(labels.optional ?? [])];
}

/**
 * The shorthand flags of one property as constraints: key = KEY (unique + exists, Neo4j's key
 * semantics); otherwise unique = UNIQUE and must_exist = EXISTS.
 * @param {string} propId @param {Record<string, any>} prop
 * @returns {Array<{type: string, properties: string[]}>}
 */
export function propertyConstraints(propId, prop) {
  const out = [];
  if (truthy(prop.key)) out.push({ type: 'KEY', properties: [propId] });
  else {
    if (truthy(prop.unique)) out.push({ type: 'UNIQUE', properties: [propId] });
    if (truthy(prop.must_exist)) out.push({ type: 'EXISTS', properties: [propId] });
  }
  return out;
}

/** @param {unknown} m @returns {Record<string, any>} */
const map = (m) => (m && typeof m === 'object' && !Array.isArray(m) ? /** @type {Record<string, any>} */ (m) : {});

/** @param {Record<string, any>} doc @returns {Constraint[]} */
export function iterConstraints(doc) {
  /** @type {Constraint[]} */
  const out = [];
  for (const [nodeId, node] of Object.entries(map(doc.nodes))) {
    const label = nodeLabel(node);
    for (const [propId, prop] of Object.entries(map(node.properties))) {
      for (const c of propertyConstraints(propId, prop)) {
        out.push({ type: c.type, element: 'node', elementId: nodeId, labelOrType: label, properties: c.properties,
          name: `${label.toLowerCase()}_${c.properties.join('_')}_${c.type.toLowerCase()}` });
      }
    }
    for (const [cid, c] of Object.entries(map(node.constraints))) {
      out.push({ type: c.type, element: 'node', elementId: nodeId, labelOrType: label, properties: [...c.properties],
        name: truthy(c.name) ? c.name : cid });
    }
  }
  for (const [relId, rel] of Object.entries(map(doc.relationships))) {
    const rtype = rel.type;
    for (const [propId, prop] of Object.entries(map(rel.properties))) {
      for (const c of propertyConstraints(propId, prop)) {
        out.push({ type: c.type, element: 'relationship', elementId: relId, labelOrType: rtype, properties: c.properties,
          name: `${rtype.toLowerCase()}_${c.properties.join('_')}_${c.type.toLowerCase()}` });
      }
    }
    for (const [cid, c] of Object.entries(map(rel.constraints))) {
      out.push({ type: c.type, element: 'relationship', elementId: relId, labelOrType: rtype, properties: [...c.properties],
        name: truthy(c.name) ? c.name : cid });
    }
  }
  return out;
}

/** @param {Record<string, any>} doc @returns {Index[]} */
export function iterIndexes(doc) {
  /** @type {Index[]} */
  const out = [];
  for (const node of Object.values(map(doc.nodes))) {
    const label = nodeLabel(node);
    for (const [iid, idx] of Object.entries(map(map(node.extensions).indexes))) {
      out.push({ type: idx.type, element: 'node', labelOrType: label, properties: [...idx.properties],
        name: truthy(idx.name) ? idx.name : iid, options: truthy(idx.options) ? idx.options : {} });
    }
  }
  for (const rel of Object.values(map(doc.relationships))) {
    for (const [iid, idx] of Object.entries(map(map(rel.extensions).indexes))) {
      out.push({ type: idx.type, element: 'relationship', labelOrType: rel.type, properties: [...idx.properties],
        name: truthy(idx.name) ? idx.name : iid, options: truthy(idx.options) ? idx.options : {} });
    }
  }
  return out;
}

/** @param {Record<string, any>} doc @param {string} relId @returns {[string, string, string]} */
export function relationshipSignature(doc, relId) {
  const rel = doc.relationships[relId];
  const nodes = map(doc.nodes);
  /** @param {Record<string, any>} end */
  const endLabel = (end) => (truthy(end.label) ? end.label : nodeLabel(nodes[end.node]));
  return [rel.type, endLabel(rel.from), endLabel(rel.to)];
}

/**
 * The relations the ontology permits between entity types.
 * @param {Record<string, any>} doc
 * @returns {Record<string, {type: string, from: string, to: string, description: string}>}
 */
export function legalRelationships(doc) {
  /** @type {Record<string, {type: string, from: string, to: string, description: string}>} */
  const out = {};
  for (const [rid, rel] of Object.entries(map(doc.relationships))) {
    const [type, from, to] = relationshipSignature(doc, rid);
    out[rid] = { type, from, to, description: truthy(rel.description) ? rel.description : type };
  }
  return out;
}

/** {label: colour} from each node's extensions.display.colour (absent: no entry). @param {Record<string, any>} doc */
export function nodeColours(doc) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const node of Object.values(map(doc.nodes))) {
    const colour = map(map(node.extensions).display).colour;
    if (typeof colour === 'string') out[nodeLabel(node)] = colour;
  }
  return out;
}

/** The query cookbook the ontology carries in its custom extensions. @param {Record<string, any>} doc */
export function queryExamples(doc) {
  const list = map(map(doc.extensions).custom).query_examples;
  return Array.isArray(list) ? list.map((e) => ({ question: String(e.question), cypher: String(e.cypher).trim() })) : [];
}
