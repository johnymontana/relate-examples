// @ts-check
/**
 * run.js: one generated query, checked and run: the browser's counterpart of the source app's
 * `_run_variant` (app/main.py). The engine worker runs it on the page's store; harness/run.mjs runs
 * it in Node on the same store the page builds, so what queries.txt pins is what the page does.
 *
 *   runVariant(db, rw, doc, cypher, {reload, rowCap})  ->  {cypher, issues, notes, columns, rows,
 *                                                           truncated, execution, wrote, error}
 *
 * Three guards, in order (README, "How a generated query is checked"):
 *   1. validate.js validateCypher: the source app's static checks against the ontology (read-only,
 *      known labels and types, legal endpoints), byte for byte. A query that fails them is not run.
 *   2. EXPLAIN: Relate plans the query without running it; its notifications (unknown label,
 *      relationship type or property key) come back as advisory `notes`. A query Relate cannot plan
 *      (a syntax error) is not run either.
 *   3. The run itself, on an in-memory store with no transactions (NOTES.md P6): when the result's
 *      counters say it wrote anything (validate.js wroteSomething), the store is rebuilt from the
 *      demo graph (`reload`) before anything else reads it, and the report says so.
 *
 * `rw` is lib/relate_wasm.mjs (exec, classify); `db` a RelateDb. Shared by the engine worker and
 * the Node harness: no Node-only import.
 */
import { engineNotes, validateCypher, wroteSomething } from './validate.js';

/** Rows a report carries (the page shows them all; the source app had no cap). */
export const ROW_CAP = 200;

/**
 * @typedef {{cypher: string, issues: string[], notes: string[], columns: string[], rows: any[], truncated: boolean,
 *   execution: string, wrote: boolean, error: string | null}} Report
 */

/**
 * @param {any} db  a RelateDb
 * @param {typeof import('../../../lib/relate_wasm.mjs')} rw
 * @param {Record<string, any>} doc  the ontology document
 * @param {string} cypher
 * @param {{reload: () => void, rowCap?: number, engine?: string}} opts
 * @returns {Report}
 */
export function runVariant(db, rw, doc, cypher, { reload, rowCap = ROW_CAP, engine = 'Relate (WASM)' }) {
  /** @type {Report} */
  const report = { cypher, issues: validateCypher(cypher, doc), notes: [], columns: [], rows: [], truncated: false, execution: '', wrote: false, error: null };
  if (report.issues.length) {
    report.execution = 'not run: the ontology check refused it';
    return report;
  }
  const plan = JSON.parse(db.execute(`EXPLAIN ${cypher}`, null));
  if (plan.error) {
    report.error = String(plan.error).split('\n')[0];
    report.execution = `not run: ${engine} cannot plan it`;
    return report;
  }
  report.notes = engineNotes(plan);
  const env = JSON.parse(db.execute(cypher, null));
  if (env.error) {
    report.error = String(env.error).split('\n')[0];
    report.execution = `${engine}: error`;
  } else {
    report.columns = env.columns ?? [];
    const rows = env.rows ?? [];
    report.truncated = rows.length > rowCap;
    report.rows = rows.slice(0, rowCap);
    report.execution = engine;
  }
  if (wroteSomething(env.stats)) {
    report.wrote = true;
    reload();
    report.execution += '; it wrote to the store, which was rebuilt from the demo graph';
  }
  return report;
}

/**
 * A cell as text: graph values (R4: nodes {id, kind, labels, properties}, relationships {type, …})
 * by their name or type, lists joined, maps as JSON.
 * @param {unknown} v
 * @returns {string}
 */
export function cellText(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(cellText).join(', ');
  if (typeof v === 'object') {
    const o = /** @type {any} */ (v);
    if (o.kind === 'node' && o.properties) return `(:${(o.labels ?? []).join(':')} ${o.properties.name ?? o.properties.id ?? ''})`;
    if (o.kind === 'relationship' && o.type) return `[:${o.type}]`;
    return JSON.stringify(v);
  }
  return String(v);
}
