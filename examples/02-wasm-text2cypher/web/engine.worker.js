// @ts-check
/**
 * engine.worker.js: Relate 1.3.0 (WebAssembly) in a dedicated module worker, holding the page's
 * knowledge graph: the demo graph under the ontology's graph type, constraints and indexes, in
 * memory (`:memory:`), rebuilt on every visit (README, "The store").
 *
 * Messages, each {id, op, ...} answered by {id, ok: true, result} or {id, ok: false, error}:
 *   init                       load the WASM, check the version: {version}
 *   load {doc, graph}          the schema, then the graph: {statements, nodes, relationships, graphType, constraints, indexes}
 *   run {cypher}               run.js runVariant on the store: a report
 *   graph                      load.js graphPayload: the instance graph for NVL
 *
 * The bundle is served from ./assets/relate-1.3.0/ (build.mjs), so its .wasm is fetched next to it.
 * A WebAssembly trap leaves the handle unusable (NOTES.md R14 in example 01): the worker reports it
 * and the page starts a new worker.
 */
import * as rw from '../../../lib/relate_wasm.mjs';
import { loadGraph, graphPayload } from './load.js';
import { runVariant } from './run.js';

export const RELATE = '1.3.0';
const GLUE = new URL(`./assets/relate-${RELATE}/relate.js`, import.meta.url);

/** @type {any} */ let glue = null;
/** @type {any} */ let db = null;
/** @type {{doc: Record<string, any>, graph: any} | null} */ let loaded = null;

/** Build the store from scratch: a fresh in-memory database, the schema, the graph. */
function build() {
  if (!loaded) throw new Error('nothing loaded');
  if (db) { try { db.free(); } catch { /* a trapped handle */ } }
  db = new glue.RelateDb();
  return loadGraph(db, rw.exec, loaded.graph, loaded.doc);
}

/** @type {Record<string, (m: any) => Promise<any> | any>} */
const OPS = {
  async init() {
    if (!glue) {
      glue = await import(GLUE.href);
      await glue.default();
    }
    const probe = new glue.RelateDb();
    try {
      const v = rw.version(probe);
      if (v !== RELATE) throw new Error(`the Relate bundle reports ${v}, this page was built for ${RELATE}`);
      return { version: v };
    } finally {
      probe.free();
    }
  },
  load(m) {
    loaded = { doc: m.doc, graph: m.graph };
    const counts = build();
    const gt = rw.exec(db, 'SHOW CURRENT GRAPH TYPE YIELD specification RETURN specification AS s').rows[0]?.s ?? '';
    const constraints = rw.exec(db, 'SHOW CONSTRAINTS YIELD name RETURN count(*) AS n').rows[0]?.n ?? 0;
    const indexes = rw.exec(db, "SHOW INDEXES YIELD name, type WHERE type <> 'LOOKUP' RETURN count(*) AS n").rows[0]?.n ?? 0;
    return { ...counts, graphType: gt, constraints, indexes };
  },
  run(m) {
    if (!loaded) throw new Error('nothing loaded');
    return runVariant(db, rw, loaded.doc, String(m.cypher ?? ''), { reload: build, engine: `Relate ${RELATE} (WASM, in this tab)` });
  },
  graph() {
    if (!loaded) throw new Error('nothing loaded');
    return graphPayload(db, rw.exec, loaded.doc);
  },
};

self.onmessage = async (/** @type {MessageEvent} */ e) => {
  const { id, op } = e.data ?? {};
  try {
    const fn = OPS[op];
    if (!fn) throw new Error(`unknown op ${op}`);
    self.postMessage({ id, ok: true, result: await fn(e.data) });
  } catch (err) {
    const trap = rw.isTrap(err);
    self.postMessage({ id, ok: false, trap, error: String(/** @type {any} */ (err)?.message ?? err).split('\n')[0] });
  }
};
