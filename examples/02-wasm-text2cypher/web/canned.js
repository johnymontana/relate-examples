// @ts-check
/**
 * canned.js: the offline answers. Without a model (no WebGPU, nothing loaded yet, or the browser
 * test) a question is matched by keyword against the source app's reference queries
 * (data/canned.json, captured from its main.py) and answered with that entry's two queries:
 * `cypher`, what the ontology-grounded prompt produces, and `bare`, what schema introspection alone
 * typically produces. A port of main.canned_cypher.
 *
 *   cannedCypher(question, canned)   {with, without}: the first entry with a keyword in the
 *                                    lower-cased question, else the fallback
 *
 * Shared by the page and the Node harness: no imports.
 */

/**
 * @typedef {{keywords: string[], cypher: string, bare: string}} CannedEntry
 * @typedef {{canned: CannedEntry[], fallback: {cypher: string, bare: string}, suggested: string[]}} Canned
 */

/** @param {string} question @param {Canned} canned @returns {{with: string, without: string}} */
export function cannedCypher(question, canned) {
  const q = question.toLowerCase();
  for (const entry of canned.canned) {
    if (entry.keywords.some((k) => q.includes(k))) return { with: entry.cypher, without: entry.bare };
  }
  return { with: canned.fallback.cypher, without: canned.fallback.bare };
}
