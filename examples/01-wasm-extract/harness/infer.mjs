// @ts-check
/**
 * harness/infer.mjs: gliner-rs on a pool of worker threads, for harness/run.mjs. gliner-rs is
 * synchronous and single-threaded, and run.mjs asks it about a thousand questions (every sentence of
 * every sample and fixture under its ontology's schema, the samples again as the example asked before
 * experiment B, and the floor invariant's sweep), so it asks them all up front, spread over worker threads that each load
 * the model, and then answers every model call from the results (cachedModel). The answers are
 * gliner-rs's own: each worker runs web/gliner.js extractRaw on the same build and weights, and a
 * call is deterministic (model.txt pins a repeated call byte-identical); run.mjs checks a sample of
 * them against its own thread's model. Nothing printed depends on how many threads ran.
 *
 *   const answers = await precompute(requests, {wasmDir, modelDir, threads});  // Map key -> raw JSON
 *   const model = cachedModel(realModel, answers);   // a gliner.js ModelHandle: hits from the map, misses on realModel
 *   requestKey(text, schema)                          // the map's key for one extractRaw(model, text, schema)
 *
 * As a worker (new Worker(this file, {workerData: {wasmDir, modelDir}})) it loads gliner-rs and the
 * weights, then answers {id, items: [{key, text, schema}]} with {id, results: [[key, raw]]}.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { MODEL_FILES, checkSchema, extractRaw, loadModel, structureSpec } from '../web/gliner.js';

/**
 * The key of one extractRaw(model, text, schema): what gliner-rs's extractCli is called with. The
 * structures (D27) join it only when there are any, so every other key is the one it always was.
 */
export function requestKey(text, schema) {
  const s = checkSchema(schema);
  const base = [text, s.entities.map((e) => [e.id, e.description]), s.relations, s.threshold, s.overlap];
  return JSON.stringify(s.structures.length ? [...base, s.structures.map(structureSpec)] : base);
}

/** extractCli's arguments as gliner.js extractRaw passes them -> the same key as requestKey. */
function callKey(text, ents, relations, structures, opts) {
  const o = JSON.parse(opts);
  const entities = ents.map((x) => {
    const i = x.indexOf(':');
    return i < 0 ? [x, null] : [x.slice(0, i), x.slice(i + 1)];
  });
  const base = [text, entities, relations, o.threshold, o.overlap ?? null];
  return JSON.stringify(structures?.length ? [...base, [...structures]] : base);
}

/**
 * A gliner.js ModelHandle that answers extractCli from `answers` (precompute's map) and falls back
 * to `real` for anything else; `stats` counts both.
 * @param {{model: any, exports: any}} real @param {Map<string, string>} answers
 */
export function cachedModel(real, answers) {
  const stats = { hits: 0, misses: 0 };
  const model = {
    extractCli(text, ents, relations, a, b, c, opts) {
      const hit = answers.get(callKey(text, ents, relations, a, opts));
      if (hit !== undefined) {
        stats.hits++;
        return hit;
      }
      stats.misses++;
      return real.model.extractCli(text, ents, relations, a, b, c, opts);
    },
  };
  return { handle: { model, exports: real.exports }, stats };
}

/**
 * How many worker threads: EX01_INFER_THREADS, else one per CPU, at most 6 and at most one per
 * `bytesPerThread` of RAM (small-v1 takes about 700 MB of WASM memory, base-v1 more than twice that).
 * @param {number} [bytesPerThread]
 */
export function threadCount(bytesPerThread = 2e9) {
  const env = Number(process.env.EX01_INFER_THREADS);
  if (Number.isInteger(env) && env >= 1) return env;
  const byMemory = Math.max(1, Math.floor(os.totalmem() / bytesPerThread));
  return Math.max(1, Math.min(6, os.availableParallelism(), byMemory));
}

/**
 * Ask gliner-rs every request on `threads` worker threads; returns key -> raw JSON (extractRaw's
 * compact JSON). Requests with the same key are asked once.
 * @param {Array<{text: string, schema: any}>} requests
 * @param {{wasmDir: string, modelDir: string, threads?: number, batch?: number}} opts
 * @returns {Promise<Map<string, string>>}
 */
export async function precompute(requests, { wasmDir, modelDir, threads = threadCount(), batch = 8 }) {
  /** @type {Map<string, {key: string, text: string, schema: any}>} */
  const todo = new Map();
  for (const r of requests) {
    const key = requestKey(r.text, r.schema);
    if (!todo.has(key)) todo.set(key, { key, text: r.text, schema: r.schema });
  }
  const items = [...todo.values()];
  /** @type {Map<string, string>} */
  const answers = new Map();
  if (!items.length) return answers;
  const n = Math.max(1, Math.min(threads, Math.ceil(items.length / batch)));
  let next = 0;
  const workers = [];
  for (let w = 0; w < n; w++) {
    workers.push(new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { wasmDir, modelDir } });
      let id = 0;
      const send = () => {
        if (next >= items.length) {
          worker.terminate().then(() => resolve(undefined), reject);
          return;
        }
        const part = items.slice(next, next + batch);
        next += part.length;
        worker.postMessage({ id: ++id, items: part });
      };
      worker.on('message', (m) => {
        if (m.ready) return send();
        if (m.error) {
          worker.terminate();
          reject(new Error(`infer.mjs worker: ${m.error}`));
          return;
        }
        for (const [key, raw] of m.results) answers.set(key, raw);
        send();
      });
      worker.on('error', reject);
      worker.on('exit', (code) => { if (code !== 0 && code !== 1) reject(new Error(`infer.mjs worker exited with ${code}`)); });
    }));
  }
  await Promise.all(workers);
  if (answers.size !== items.length) throw new Error(`infer.mjs: ${answers.size} of ${items.length} answers`);
  return answers;
}

// ---- the worker ----------------------------------------------------------------------------------
if (!isMainThread && parentPort && workerData?.wasmDir) {
  const port = parentPort;
  try {
    const glue = await import(pathToFileURL(join(workerData.wasmDir, 'gliner_rs.js')).href);
    const model = loadModel({
      glue, wasmBytes: readFileSync(join(workerData.wasmDir, 'gliner_rs_bg.wasm')),
      ...Object.fromEntries(Object.entries(MODEL_FILES).map(([arg, f]) => [arg, readFileSync(join(workerData.modelDir, f))])),
    });
    port.on('message', (m) => {
      try {
        port.postMessage({ id: m.id, results: m.items.map((it) => [it.key, extractRaw(model, it.text, it.schema)]) });
      } catch (e) {
        port.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) });
      }
    });
    port.postMessage({ ready: true });
  } catch (e) {
    port.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
}
