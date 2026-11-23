// @ts-check
/**
 * validate.js: the checks a generated query passes before it runs, and the engine's own advice.
 *
 *   validateCypher(query, doc)   static checks against the ontology that no prompt can guarantee:
 *                                read-only, known labels and relationship types, legal endpoints.
 *                                A byte for byte port of the source app's text2cypher.validate_cypher
 *                                (its regular expressions and its issue strings, Python's repr of the
 *                                allowed pairs included; data/reference/validate.json pins it).
 *                                [] means the query may run.
 *   engineNotes(envelope)        Relate's EXPLAIN notifications as advisory lines: an unknown label,
 *                                relationship type or property key in the store. Advisory only: a
 *                                property the ontology declares can be absent from the data.
 *   wroteSomething(stats)        true when any counter of a result's stats moved: the store was
 *                                written, and the engine worker reloads the graph (Relate's WASM
 *                                build has no transactions to roll back, and a read-only handle on an
 *                                in-memory store starts empty; NOTES.md).
 *
 * Shared by the page, the engine worker and the Node harness.
 */
import { legalRelationships, nodeLabel } from './ontology.js';
import { reprPairs, WORD } from './py.js';

const W = WORD;
export const READ_ONLY_VIOLATIONS = /\b(CREATE|MERGE|DELETE|DETACH|DROP|SET|REMOVE|CALL\s+dbms|LOAD\s+CSV)\b/iu;
const NODE_RE = new RegExp(`\\(\\s*(${W}+)?\\s*(?::\\s*\`?(${W}+)\`?)\\s*`, 'gu');
const REL_RE = new RegExp(
  `\\(\\s*${W}*\\s*(?::\\s*\`?(${W}+)\`?)?\\s*\\)` // (a:Label)
  + `\\s*-\\s*\\[\\s*${W}*\\s*(?::\\s*\`?(${W}+)\`?)?\\s*\\]\\s*` // -[r:TYPE]-
  + '(->|<-|-)\\s*'
  + `\\(\\s*${W}*\\s*(?::\\s*\`?(${W}+)\`?)?\\s*\\)`,
  'gu',
);

/** @param {unknown} m @returns {Record<string, any>} */
const map = (m) => (m && typeof m === 'object' && !Array.isArray(m) ? /** @type {Record<string, any>} */ (m) : {});

/**
 * Static checks against the ontology. Returns a list of issues ([] = ok).
 * @param {string} query @param {Record<string, any>} doc
 * @returns {string[]}
 */
export function validateCypher(query, doc) {
  /** @type {string[]} */
  const issues = [];
  if (READ_ONLY_VIOLATIONS.test(query)) issues.push('write/clause violation: query must be read-only');

  const labels = new Set(Object.values(map(doc.nodes)).map((n) => nodeLabel(n)));
  /** @type {Map<string, Map<string, [string, string]>>} */
  const legal = new Map();
  for (const sig of Object.values(legalRelationships(doc))) {
    if (!legal.has(sig.type)) legal.set(sig.type, new Map());
    /** @type {Map<string, [string, string]>} */ (legal.get(sig.type)).set(`${sig.from}\u0000${sig.to}`, [sig.from, sig.to]);
  }

  for (const m of query.matchAll(NODE_RE)) {
    if (m[2] && !labels.has(m[2])) issues.push(`unknown label :${m[2]}`);
  }

  for (const m of query.matchAll(REL_RE)) {
    const [, fromLabel, rtype, direction, toLabel] = m;
    if (rtype && !legal.has(rtype)) {
      issues.push(`unknown relationship type :${rtype}`);
      continue;
    }
    if (!(rtype && fromLabel && toLabel)) continue;
    const pairs = /** @type {Map<string, [string, string]>} */ (legal.get(rtype));
    const has = (/** @type {string} */ a, /** @type {string} */ b) => pairs.has(`${a}\u0000${b}`);
    let ok;
    if (direction === '->') ok = has(fromLabel, toLabel);
    else if (direction === '<-') ok = has(toLabel, fromLabel);
    else ok = has(fromLabel, toLabel) || has(toLabel, fromLabel);
    if (!ok) {
      issues.push(`illegal endpoints: (:${fromLabel})-[:${rtype}]-(:${toLabel}); allowed: ${reprPairs(pairs.values())}`);
    }
  }
  return issues;
}

/** The EXPLAIN notification codes worth showing, and how each reads. */
const NOTE_KINDS = Object.freeze({
  'Neo.ClientNotification.Statement.UnknownLabelWarning': 'unknown label',
  'Neo.ClientNotification.Statement.UnknownRelationshipTypeWarning': 'unknown relationship type',
  'Neo.ClientNotification.Statement.UnknownPropertyKeyWarning': 'unknown property key',
});

/**
 * Relate's EXPLAIN notifications as advisory lines, e.g. "engine: unknown label (…)". The
 * description names the offending name; anything else (a missing index, a cartesian product) is left
 * out: those concern speed, not meaning.
 * @param {{notifications?: Array<Record<string, any>>}} envelope  a wire envelope (JSON.parse of execute)
 * @returns {string[]}
 */
export function engineNotes(envelope) {
  /** @type {string[]} */
  const out = [];
  for (const n of envelope.notifications ?? []) {
    const kind = NOTE_KINDS[/** @type {keyof typeof NOTE_KINDS} */ (n.code)];
    if (!kind) continue;
    const desc = String(n.description ?? '').split('\n')[0].trim();
    out.push(`engine: ${kind}${desc ? ` (${desc})` : ''}`);
  }
  return out;
}

/** Did a statement write? Any stats counter above zero. @param {Record<string, number>|undefined} stats */
export function wroteSomething(stats) {
  return Object.values(stats ?? {}).some((v) => typeof v === 'number' && v > 0);
}
