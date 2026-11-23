// @ts-check
/**
 * models.js: the GLiNER2.5 checkpoint files, fetched in the page, checked and cached
 * (NOTES.md D4, D14, G1, G8). The engine worker gets the bytes
 * (transferred, not copied) and loads them with gliner.js loadModel.
 *
 *   const m = MODELS.small;                    // {repo, rev, files: [{name, arg, sha256, bytes}], bytes}
 *   const got = await fetchModel('small', {onProgress: (p) => ..., base: modelBase('small')});
 *   // got.files: {weights, tokenizer, config, encoderConfig} as ArrayBuffers; got.info: {repo, rev, weights}
 *
 * Where from: the Hugging Face Hub at the pinned revision,
 * https://huggingface.co/<repo>/resolve/<rev>/<file> (the page's CSP allows huggingface.co and
 * *.hf.co, where the large files redirect), or, for development, `?models=local`:
 * ./models/<model>@<rev7>/<file>, which harness/serve.mjs maps to .cache/gliner/ (D13). The pins
 * (repository, revision, each file's sha256 and size) are embedded by build.mjs from
 * ci/gliner2.5-*.sha256 and scripts/fetch-gliner.sh, where the placeholder below says; the page
 * refuses to run from an untransformed copy.
 *
 * Checks: every file is streamed into a buffer of its pinned size (more or fewer bytes fail),
 * then hashed with crypto.subtle (SHA-256) against its pin. Only then is it stored in Cache
 * Storage `ex33-models-v1` (the ex33- prefix, D14: every example on the site shares one origin),
 * after navigator.storage.persist() (G8: caching the 304 MB needs persistent storage, or the quota
 * may refuse it). A cached entry carries its sha256 in a header, but the header is only a label:
 * every cache hit is hashed again with crypto.subtle before it is used (anything on the origin can
 * write Cache Storage, and a disk can rot), and an entry whose bytes do not match the pin is
 * deleted and downloaded again, with a notice (fetchModel's `repaired`). That re-hash is the price
 * of a warm load: SHA-256 over the 304 MB of small-v1's four files (783 MB for base-v1) in the
 * page, on top of reading them (D4). A refused cache write (quota) is reported, and the model still loads.
 * cacheStatus() reads the header only: it labels the picker ("cached in this browser") and decides
 * whether to load at start-up, and the load checks the bytes.
 */

/** Cache Storage name: per origin, so prefixed (D14). */
export const CACHE = 'ex33-models-v1';

/**
 * @typedef {{name: string, arg: 'weights'|'tokenizer'|'config'|'encoderConfig', sha256: string, bytes: number}} PinnedFile
 * @typedef {{key: string, label: string, repo: string, rev: string, dir: string, files: PinnedFile[], bytes: number}} PinnedModel
 */

/** @type {Record<string, PinnedModel> | null} */
const PINS = /*@ex33:model-pins*/null;

/** The pinned models, by key ('small', 'base'). */
export const MODELS = /** @type {Record<string, PinnedModel>} */ (PINS ?? {});
/** The default model (D4). */
export const DEFAULT_MODEL = 'small';

/** True when build.mjs (or serve.mjs) embedded the pins. */
export function pinned() {
  return PINS !== null && Object.keys(PINS).length > 0;
}

/** A model failed to fetch or check; `code`: unreachable, http, size, sha256, pins. */
export class ModelError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
  }
}

/** @param {string} key */
function model(key) {
  if (!pinned()) throw new ModelError('pins', 'models.js has no embedded pins: serve the page through build.mjs (npm run build) or harness/serve.mjs');
  const m = MODELS[key];
  if (!m) throw new ModelError('pins', `no pinned model ${JSON.stringify(key)} (have: ${Object.keys(MODELS).join(', ')})`);
  return m;
}

/** The canonical URL of a file: the HF Hub at the pinned revision (also the Cache Storage key). */
export function hubUrl(key, file) {
  const m = model(key);
  return `https://huggingface.co/${m.repo}/resolve/${m.rev}/${file}`;
}

/**
 * Where the page fetches a model's files from: the HF Hub, or ./models/<model>@<rev7>/ when the
 * page's URL says ?models=local (harness/serve.mjs serves .cache/gliner/ there).
 * @param {string} key
 * @param {URLSearchParams} [params]
 * @returns {string} a base URL ending in '/'
 */
export function modelBase(key, params = new URLSearchParams(globalThis.location?.search ?? '')) {
  const m = model(key);
  if (params.get('models') === 'local') return new URL(`./models/${m.dir}/`, globalThis.location.href).href;
  return `https://huggingface.co/${m.repo}/resolve/${m.rev}/`;
}

/** Lower-case hex. @param {ArrayBuffer} buf */
function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Megabytes, for messages. @param {number} n */
export function mb(n) {
  return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
}

/**
 * Which of a model's files Cache Storage holds labelled with the pinned sha256 (the header only;
 * fetchModel hashes the bytes before it uses them).
 * @param {string} key
 * @returns {Promise<{cached: number, total: number, all: boolean}>}
 */
export async function cacheStatus(key) {
  const m = model(key);
  if (typeof caches === 'undefined') return { cached: 0, total: m.files.length, all: false };
  const cache = await caches.open(CACHE);
  let cached = 0;
  for (const f of m.files) {
    const r = await cache.match(hubUrl(key, f.name));
    if (r && r.headers.get('x-ex33-sha256') === f.sha256) cached++;
  }
  return { cached, total: m.files.length, all: cached === m.files.length };
}

/** Delete a model's cached files. @param {string} key */
export async function forget(key) {
  const m = model(key);
  const cache = await caches.open(CACHE);
  for (const f of m.files) await cache.delete(hubUrl(key, f.name));
}

/** Files above this size are fetched in byte ranges of this size (see download()). */
export const CHUNK = 32 * 1024 * 1024;
const RETRIES = 2;

/**
 * Fetch one file into a buffer of its pinned size. A file above CHUNK bytes is fetched as
 * consecutive `Range: bytes=a-b` requests (206 answers), each retried twice on a network error:
 * a dropped connection costs one chunk, not the 296 MB model.safetensors, and a test harness can answer every request
 * from a local copy (Playwright's route.fulfill serialises a body whole, and a 296 MB model.safetensors body exhausts
 * Node). A server that ignores Range (200 on the first request) is read whole instead.
 * @param {string} url @param {PinnedFile} f @param {(n: number) => void} onBytes @param {AbortSignal} [signal]
 */
async function download(url, f, onBytes, signal) {
  const out = new Uint8Array(f.bytes);
  const origin = new URL(url).origin;
  /** @param {number} from @param {number} to inclusive; -1: the whole file */
  const get = async (from, to) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetch(url, {
          mode: 'cors', credentials: 'omit', cache: 'no-store', signal,
          headers: to >= 0 ? { Range: `bytes=${from}-${to}` } : {},
        });
      } catch (e) {
        if (/** @type {Error} */ (e).name === 'AbortError') throw e;
        if (attempt < RETRIES) continue;
        throw new ModelError('unreachable', `Could not reach ${origin} for ${f.name} (${/** @type {Error} */ (e).message}). ` +
          'The model is fetched from the Hugging Face Hub: check the connection, or try again later.');
      }
    }
  };
  /** Stream a body into out at `at`, at most `max` bytes; returns the count. */
  const pour = async (/** @type {Response} */ res, /** @type {number} */ at, /** @type {number} */ max) => {
    if (!res.body) throw new ModelError('http', `${origin} sent no body for ${f.name}`);
    const reader = res.body.getReader();
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return n;
      if (n + value.length > max) {
        await reader.cancel();
        throw new ModelError('size', `${f.name}: more than the pinned ${f.bytes} bytes arrived`);
      }
      out.set(value, at + n);
      n += value.length;
      onBytes(value.length);
    }
  };
  const fail = (/** @type {Response} */ res) => new ModelError('http', `${origin} answered ${res.status} ${res.statusText} for ${f.name}` +
    (res.status === 429 ? ': the Hub is rate-limiting; try again in a few minutes' : ''));
  if (f.bytes <= CHUNK) {
    const res = await get(0, -1);
    if (!res.ok) throw fail(res);
    const n = await pour(res, 0, f.bytes);
    if (n !== f.bytes) throw new ModelError('size', `${f.name}: ${n} of the pinned ${f.bytes} bytes arrived`);
    return out.buffer;
  }
  for (let at = 0; at < f.bytes; at += CHUNK) {
    const to = Math.min(f.bytes, at + CHUNK) - 1;
    const res = await get(at, to);
    if (res.status === 200 && at === 0) { // the server ignored Range: take the whole file
      const n = await pour(res, 0, f.bytes);
      if (n !== f.bytes) throw new ModelError('size', `${f.name}: ${n} of the pinned ${f.bytes} bytes arrived`);
      return out.buffer;
    }
    if (res.status !== 206) throw fail(res);
    const n = await pour(res, at, to - at + 1);
    if (n !== to - at + 1) throw new ModelError('size', `${f.name}: bytes ${at}-${to} came back as ${n} bytes`);
  }
  return out.buffer;
}

/**
 * The four files of a model as ArrayBuffers (gliner.js MODEL_FILES), from Cache Storage or the
 * network, each hashed and checked against its pinned sha256 wherever it came from. A cached file
 * whose bytes fail the pin (whatever its header says) is deleted from the cache and downloaded
 * again; its name is in `repaired`, and `hashMs` is the time spent hashing cache hits.
 * @param {string} key  'small' or 'base'
 * @param {{base?: string, onProgress?: (p: {file: string, loaded: number, total: number, from: 'cache'|'network', stage: string}) => void,
 *          signal?: AbortSignal}} [opts]
 * @returns {Promise<{files: Record<string, ArrayBuffer>, info: {repo: string, rev: string, weights: string},
 *          from: 'cache'|'network'|'mixed', cacheWarning: string|null, persisted: boolean, repaired: string[], hashMs: number}>}
 */
export async function fetchModel(key, { base = modelBase(key), onProgress = () => {}, signal } = {}) {
  const m = model(key);
  let persisted = false;
  try { persisted = (await navigator.storage?.persist?.()) ?? false; } catch { /* not granted */ }
  const cache = typeof caches === 'undefined' ? null : await caches.open(CACHE);
  /** @type {Record<string, ArrayBuffer>} */
  const files = {};
  let loaded = 0;
  const froms = new Set();
  /** @type {string|null} */
  let cacheWarning = null;
  /** @type {string[]} */
  const repaired = [];
  let hashMs = 0;
  for (const f of m.files) {
    const key0 = hubUrl(key, f.name);
    const hit = cache ? await cache.match(key0) : undefined;
    if (hit) {
      // The header is a label anyone on this origin can write: hash the bytes themselves.
      const buf = await hit.arrayBuffer();
      onProgress({ file: f.name, loaded, total: m.bytes, from: 'cache', stage: 'checking-cache' });
      const t0 = performance.now();
      const sha = buf.byteLength === f.bytes ? hex(await crypto.subtle.digest('SHA-256', buf)) : null;
      hashMs += performance.now() - t0;
      if (sha === f.sha256) {
        files[f.arg] = buf;
        loaded += f.bytes;
        froms.add('cache');
        onProgress({ file: f.name, loaded, total: m.bytes, from: 'cache', stage: 'cached' });
        continue;
      }
      // Wrong bytes under the pinned URL: drop the entry and fetch the file again.
      repaired.push(f.name);
      try { await cache?.delete(key0); } catch { /* the download below overwrites it anyway */ }
    }
    const buf = await download(new URL(f.name, base).href, f, (n) => {
      loaded += n;
      onProgress({ file: f.name, loaded, total: m.bytes, from: 'network', stage: 'downloading' });
    }, signal);
    onProgress({ file: f.name, loaded, total: m.bytes, from: 'network', stage: 'checking' });
    const sha = hex(await crypto.subtle.digest('SHA-256', buf));
    if (sha !== f.sha256) {
      throw new ModelError('sha256', `${f.name} has sha256 ${sha.slice(0, 12)}…, the pin says ${f.sha256.slice(0, 12)}…: refusing it`);
    }
    froms.add('network');
    files[f.arg] = buf;
    if (cache) {
      try {
        // new Response(buf) copies the bytes, so buf stays usable for the worker.
        await cache.put(key0, new Response(buf, {
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(f.bytes), 'x-ex33-sha256': f.sha256 },
        }));
      } catch (e) {
        cacheWarning = `the browser did not cache ${f.name} (${/** @type {Error} */ (e).name}: storage quota?); the next visit downloads it again`;
      }
    }
  }
  const weights = /** @type {PinnedFile} */ (m.files.find((f) => f.arg === 'weights')).sha256;
  return {
    files,
    info: { repo: m.repo, rev: m.rev, weights },
    from: froms.size === 1 ? /** @type {'cache'|'network'} */ ([...froms][0]) : 'mixed',
    cacheWarning,
    persisted,
    repaired,
    hashMs: Math.round(hashMs),
  };
}
