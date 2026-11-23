// @ts-check
/**
 * briefing.js: the Text2Cypher schema briefing, rendered from the ontology document. A byte for
 * byte port of the source app's text2cypher.build_schema_prompt (harness/run.mjs checks it against
 * data/reference/briefing-*.txt on every run).
 *
 * Schema introspection tells a model what the graph contains; the ontology tells it what the graph
 * means: property types and descriptions, `one_of` vocabularies, which relationship types are legal
 * between which labels, and that every relationship carries judgment properties (`assertion`,
 * `supported`, `evidence`) to filter on.
 *
 *   buildBriefing(doc)                 the grounded briefing: descriptions, vocabularies, judgment guidance, cookbook
 *   buildBriefing(doc, {bare: true})   what schema introspection alone gives: labels, types, endpoints, property names
 *
 * The A/B comparison on the page runs the same question through both.
 */
import { legalRelationships, nodeLabel } from './ontology.js';
import { truthy } from './py.js';

export const DIRECTION_NOTE = `Every relationship in this graph carries judgment properties from the extraction
pipeline: \`assertion\` ('asserted' | 'hypothetical' | 'negated' | 'forward_looking'),
\`supported\` (0..1 probability), and \`evidence\` (source span). Unless the question
asks about speculation or rumours, filter to asserted facts:
\`WHERE r.assertion = 'asserted' AND r.supported >= 0.8\`.

## Query guidance
- Questions about whether a connection is real, rumored, denied, or merely
  projected → filter the relationship's judgment properties, e.g.
    MATCH (a)-[r]->(b) WHERE r.assertion IN ['hypothetical', 'forward_looking']
    RETURN a.name, type(r), b.name, r.evidence
  Prefer this over matching event-style nodes: the graph may contain no such
  nodes, and the relationship properties always carry the answer.
- Match entity nodes by their canonical \`name\`; use \`aliases\` only if needed.
- Names in user questions may be aliases or short forms — match BOTH the
  canonical name and the alias list:
  \`WHERE (c.name = 'Full Name' OR 'ShortName' IN c.aliases)\`. Entity resolution
  has already merged duplicates, so match within one node, never across nodes.
- Return relationship properties (assertion, supported, evidence) when the
  question concerns how well-supported a fact is.`;

/** @param {unknown} m @returns {Record<string, any>} */
const map = (m) => (m && typeof m === 'object' && !Array.isArray(m) ? /** @type {Record<string, any>} */ (m) : {});

/**
 * @param {Record<string, any>} doc
 * @param {{bare?: boolean}} [opts]
 * @returns {string}
 */
export function buildBriefing(doc, { bare = false } = {}) {
  if (bare) {
    const lines = [
      'You are a Cypher expert. Generate a single read-only Cypher query for',
      "the user's question, using only these labels and relationship types.",
      'Return ONLY the query, no prose.',
      '',
      '## Node labels',
    ];
    for (const node of Object.values(map(doc.nodes))) {
      const props = Object.keys(map(node.properties)).join(', ');
      lines.push(`- :${nodeLabel(node)} (${props})`);
    }
    lines.push('');
    lines.push('## Relationship types');
    for (const sig of Object.values(legalRelationships(doc))) {
      lines.push(`- (:${sig.from})-[:${sig.type}]->(:${sig.to})`);
    }
    return lines.join('\n');
  }

  const lines = [
    'You are a Cypher expert. Generate a single read-only Cypher query for the',
    "user's question, using ONLY the labels, relationship types and properties",
    'defined in this ontology. Return ONLY the query, no prose.',
    '',
    `# Ontology: ${truthy(doc.name) ? doc.name : doc.id}`,
  ];
  if (truthy(doc.description)) lines.push(String(doc.description ?? '').trim().split('\n')[0]);
  lines.push('');
  lines.push('## Node labels');
  for (const node of Object.values(map(doc.nodes))) {
    const label = nodeLabel(node);
    lines.push(`\n### :${label}` + (truthy(node.description) ? ` — ${node.description}` : ''));
    for (const [pid, prop] of Object.entries(map(node.properties))) {
      const bits = [prop.type];
      if (truthy(prop.key)) bits.push('key');
      else if (truthy(prop.unique)) bits.push('unique');
      if (truthy(prop.must_exist)) bits.push('required');
      if (truthy(prop.one_of)) bits.push('one of ' + prop.one_of.join('/'));
      const desc = truthy(prop.description) ? ` — ${prop.description}` : '';
      lines.push(`- ${pid}: ${bits.join('; ')}${desc}`);
    }
  }
  lines.push('');
  lines.push('## Relationship types (from -> to; use exactly these endpoints)');
  for (const sig of Object.values(legalRelationships(doc))) {
    lines.push(`- (:${sig.from})-[:${sig.type}]->(:${sig.to})` + (truthy(sig.description) ? ` — ${sig.description}` : ''));
  }
  // judgment properties live on relationships in this ontology
  /** @type {Map<string, string>} */
  const relProps = new Map();
  for (const rel of Object.values(map(doc.relationships))) {
    for (const [pid, prop] of Object.entries(map(rel.properties))) {
      if (truthy(prop.one_of)) relProps.set(pid, 'one of ' + prop.one_of.join('/'));
      else if (truthy(prop.description)) relProps.set(pid, prop.description);
    }
  }
  if (relProps.size) {
    lines.push('');
    lines.push('## Relationship properties');
    for (const [pid, note] of relProps) lines.push(`- ${pid}: ${note}`);
  }
  lines.push('', DIRECTION_NOTE);
  // Few-shot examples from the ontology's own custom extensions: the query cookbook lives in the
  // ontology document, next to the schema it queries.
  const examples = map(map(doc.extensions).custom).query_examples;
  if (truthy(examples)) {
    lines.push('');
    lines.push('## Examples (question → query; follow these patterns)');
    for (const ex of examples) lines.push(`\nQ: ${ex.question}\n${String(ex.cypher).trim()}`);
  }
  return lines.join('\n');
}
