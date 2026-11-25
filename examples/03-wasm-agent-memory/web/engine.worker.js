// @ts-check
/**
 * engine.worker.js: Relate 1.2.0 (WebAssembly) in a dedicated module worker, holding the agent's
 * memory in memory (`new RelateDb()`), rebuilt whenever a conversation starts (NOTES.md D4).
 *
 * Messages, each {id, op, ...} answered by {id, ok: true, result} or {id, ok: false, error, trap}:
 *   init            load the WASM and check the version: {version}
 *   open            a fresh store with the memory schema: {graphType, calls, snapshot}
 *   tool {tool, args}   a memory tool (memory.js: remember, correct, recall, connect, trace, entitiesNamed):
 *                   {result, calls, snapshot}
 *   query {cypher}  any statement, from the "Under the hood" console: {columns, rows, stats,
 *                   error, calls, snapshot}; an engine error is a result, not a failure
 *
 * `calls` is every statement the op ran: {tool, write, statement, params (vectors summarised),
 * stats, rows (a count), error, ms}. `ms` is wall-clock time around the engine call, for the page only.
 * `snapshot` is the whole store after the op (memory.js snapshot), which is what the page draws.
 *
 * The bundle is served from ./assets/relate-1.2.0/ (build.mjs), so its .wasm is fetched next to it.
 * A WebAssembly trap leaves the handle unusable (example 01's NOTES.md R14): the worker reports it
 * and the page starts a new worker.
 */
import * as rw from '../../../lib/relate_wasm.mjs';
import { createMemory, displayParams, RELATE } from './memory.js';

const GLUE = new URL(`./assets/relate-${RELATE}/relate.js`, import.meta.url);

/** @type {any} */ let glue = null;
/** @type {any} */ let db = null;
/** @type {ReturnType<typeof createMemory> | null} */ let memory = null;
/** @type {any[]} */ let calls = [];

/** exec, timed: the page shows how long each statement took. @type {typeof rw.exec} */
const timed = (handle, query, params, opts) => {
  const t0 = performance.now();
  try {
    return rw.exec(handle, query, params, opts);
  } finally {
    lastMs = performance.now() - t0;
  }
};
let lastMs = 0;

/** A fresh store under the memory schema. */
function open() {
  if (db) { try { db.free(); } catch { /* a trapped handle */ } }
  db = new glue.RelateDb();
  calls = [];
  memory = createMemory(db, timed, {
    onCall: (c) => calls.push({
      tool: c.tool, write: c.write, statement: c.statement, params: displayParams(c.params),
      stats: Object.fromEntries(Object.entries(c.stats ?? {}).filter(([, n]) => n > 0)), rows: c.rows.length, error: c.error, ms: lastMs,
    }),
  });
  memory.schema();
  const graphType = rw.exec(db, 'SHOW CURRENT GRAPH TYPE YIELD specification RETURN specification AS s').rows[0]?.s ?? '';
  return { graphType };
}

/** The statements since the last take. */
const take = () => calls.splice(0);
const mem = () => {
  if (!memory) throw new Error('no store is open');
  return memory;
};

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
  open() {
    const { graphType } = open();
    return { graphType, calls: take(), snapshot: mem().snapshot() };
  },
  tool(m) {
    const fn = /** @type {any} */ (mem())[m.tool];
    if (typeof fn !== 'function' || ['schema', 'snapshot', 'query'].includes(m.tool)) throw new Error(`unknown tool ${m.tool}`);
    const result = fn(m.args);
    return { result, calls: take(), snapshot: mem().snapshot() };
  },
  query(m) {
    let out;
    try {
      const res = mem().query(String(m.cypher ?? ''));
      out = { columns: res.columns, rows: res.rows, stats: res.stats, error: null };
    } catch (err) {
      if (!(err instanceof rw.RelateWasmError)) throw err;
      out = { columns: [], rows: [], stats: {}, error: err.detail };
    }
    return { ...out, calls: take(), snapshot: mem().snapshot() };
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
