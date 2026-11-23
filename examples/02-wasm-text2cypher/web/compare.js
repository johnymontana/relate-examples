// @ts-check
/**
 * compare.js: the A/B takeaways, in words, for one question answered twice: once through the
 * ontology-grounded briefing and once through the bare one. A byte for byte port of the source
 * app's main._compare (data/reference/compare.json pins it).
 *
 *   compare(withO, withoutO)   string[]: why the two differ, or that they did not this time
 *
 * A report is {cypher, issues, rows, ...}: what the engine worker returns for each variant.
 * Shared by the page and the Node harness: no imports.
 */

/**
 * @param {{cypher: string, issues: string[], rows: unknown[]}} withO
 * @param {{cypher: string, issues: string[], rows: unknown[]}} withoutO
 * @returns {string[]}
 */
export function compare(withO, withoutO) {
  const notes = [];
  const wc = withO.cypher;
  const bc = withoutO.cypher;
  if (withoutO.issues.length) notes.push('bare query blocked by ontology validation: ' + withoutO.issues.join('; '));
  if (wc.includes('assertion') && !bc.includes('assertion')) {
    notes.push('bare query omits the assertion filter — rumors, denials and '
      + 'speculation come back indistinguishable from facts');
  }
  if (wc.includes('supported') && !bc.includes('supported')) notes.push('bare query omits the support-probability threshold');
  if (wc.includes('aliases') && !bc.includes('aliases')) {
    notes.push('bare query matches only the canonical name — alias mentions '
      + '(tickers, short forms) silently miss');
  }
  if (!withoutO.issues.length) {
    const dw = withO.rows.length;
    const db = withoutO.rows.length;
    if (dw !== db) notes.push(`row counts differ: ontology ${dw} vs bare ${db}`);
  }
  if (!notes.length) {
    notes.push('same shape this time — the ontology earns its keep on the '
      + 'questions where meaning, not structure, is the answer');
  }
  return notes;
}
