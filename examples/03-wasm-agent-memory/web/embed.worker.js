// @ts-check
/**
 * embed.worker.js: the embedding model in the tab (NOTES.md D3, T1-T5; ADR-0017). Started the first
 * time the visitor types a text the page has no vector for; the scripted conversations never need it.
 *
 * all-MiniLM-L6-v2 (web/embed.js MODEL) runs through Transformers.js on onnxruntime-web's WebAssembly
 * build, one thread (GitHub Pages sends no COOP/COEP headers, so there is no SharedArrayBuffer:
 * ADR-0002). Both ship with the page under assets/; only the model's four files come from elsewhere.
 *
 * The model's files are fetched here, not by the library: each from the Hugging Face Hub at the
 * pinned revision, checked against its pinned sha256, and put in the Cache API under this example's
 * own name (ex03-models: ADR-0003) at the URL the library will ask for. The library then finds every
 * file in that cache and fetches nothing itself. A file that does not match is refused.
 *
 * Messages, each {id, op, ...} answered by {id, ok: true, result} or {id, ok: false, error}:
 *   load              fetch (or find cached) and start the model: {cached: boolean}
 *   embed {texts}     one vector per text: mean-pooled, normalised, rounded as data/embeddings.json is
 * While loading it also posts {progress: {loaded, total}} (bytes of the model's files).
 */
import { env, pipeline } from 'vendor:transformers';
import { MODEL } from './embed.js';

/** Where build.mjs put Transformers.js and onnxruntime-web's .mjs and .wasm (a versioned directory). */
const RUNTIME = new URL(/** @type {string} */ (/** @type {any} */ (globalThis).__EX03_TRANSFORMERS_DIR__ ?? __EX03_TRANSFORMERS_DIR__), import.meta.url).href;
const CACHE = 'ex03-models';
const fileUrl = (/** @type {string} */ name) => `https://huggingface.co/${MODEL.id}/resolve/${MODEL.revision}/${name}`;

env.allowLocalModels = false;
// every request the library makes names the pinned revision, whatever revision it was about to ask
// for (it asks for some configuration files at "main": T3), so each one is answered from the cache
env.remotePathTemplate = `{model}/resolve/${MODEL.revision}/`;
env.useBrowserCache = true;
env.cacheKey = CACHE;          // the library's own cache name would be shared with every site on this origin
env.useWasmCache = false;      // the runtime's files are this site's own: the HTTP cache has them
/** @type {any} */ (env.backends.onnx).wasm.wasmPaths = RUNTIME;
/** @type {any} */ (env.backends.onnx).wasm.numThreads = 1;

const hex = (/** @type {ArrayBuffer} */ b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Make sure every file of the model is in the cache, verified. @returns {Promise<boolean>} whether all were already there */
async function fetchModel() {
  const cache = await caches.open(CACHE);
  const total = Object.values(MODEL.files).reduce((n, f) => n + f.bytes, 0);
  let loaded = 0;
  let cached = true;
  for (const [name, want] of Object.entries(MODEL.files)) {
    const url = fileUrl(name);
    if (await cache.match(url)) { loaded += want.bytes; continue; }
    cached = false;
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`${name}: the Hub answered ${res.status}`);
    const chunks = [];
    for (const reader = res.body.getReader(); ;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      self.postMessage({ progress: { loaded: Math.min(loaded, total), total } });
    }
    const bytes = await new Blob(chunks).arrayBuffer();
    const got = hex(await crypto.subtle.digest('SHA-256', bytes));
    if (got !== want.sha256) throw new Error(`${name} is not the pinned file (sha256 ${got.slice(0, 12)}…, expected ${want.sha256.slice(0, 12)}…)`);
    await cache.put(url, new Response(bytes, { headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream', 'content-length': String(bytes.byteLength) } }));
  }
  return cached;
}

/** @type {any} */ let extract = null;

/** @type {Record<string, (m: any) => Promise<any>>} */
const OPS = {
  async load() {
    if (extract) return { cached: true };
    const cached = await fetchModel();
    self.postMessage({ phase: 'initializing' });
    extract = await pipeline('feature-extraction', MODEL.id, { revision: MODEL.revision, dtype: /** @type {any} */ (MODEL.dtype), device: 'wasm' });
    return { cached };
  },
  async embed(m) {
    if (!extract) await OPS.load({});
    // one text at a time, as harness/embed.mjs does: in a batch, a text's vector shifts with its neighbours (T5)
    const out = [];
    for (const text of m.texts) {
      const [v] = /** @type {number[][]} */ ((await extract([text], { pooling: 'mean', normalize: true })).tolist());
      out.push(v.map((x) => Math.round(x * 1e5) / 1e5));
    }
    return out;
  },
};

self.onmessage = async (/** @type {MessageEvent} */ e) => {
  const { id, op } = e.data ?? {};
  try {
    const fn = OPS[op];
    if (!fn) throw new Error(`unknown op ${op}`);
    self.postMessage({ id, ok: true, result: await fn(e.data) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(/** @type {any} */ (err)?.message ?? err).split('\n')[0] });
  }
};
