// @ts-check
/**
 * embed.js: where a text's vector comes from, and the words a full-text search gets
 * (NOTES.md D3, ADR-0017).
 *
 * Vectors are real: every one comes from all-MiniLM-L6-v2 (384 dimensions, Apache-2.0), a small
 * sentence-embedding model, so two texts that mean similar things are close whatever their words.
 * There are two ways to get one, and both give the same vector for the same text:
 *
 *   ahead of time   data/embeddings.json holds the vector of every text the scripts use (each
 *                   memory, each scripted question, the suggested messages), computed with the
 *                   model by harness/embed.mjs. The page and the regression run read them from
 *                   there, so the scripted conversations need no model, start at once, and give
 *                   the same result everywhere.
 *   in the tab      a text the visitor types is embedded by the same model, in a worker
 *                   (web/embed.worker.js, Transformers.js on WebAssembly), fetched once from the
 *                   Hugging Face Hub at a pinned revision and kept in the browser's cache.
 *
 * createEmbedder joins the two: a known text is looked up, an unknown one goes to `live` when
 * there is one. Without a vector (no network, no model) a text is still stored and searched by
 * its words: recall's vector search then finds nothing and its full-text search carries on.
 *
 * `terms(text)` is a text's content words as one string: the query the full-text search gets, so
 * a question's "what", "do" and "you" do not count as search terms.
 */

/** The embedding model: what harness/embed.mjs and web/embed.worker.js load, and what data/embeddings.json must name. */
export const MODEL = Object.freeze({
  id: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  dtype: 'q8',
  dims: 384,
  /** The files the model needs, with their size and sha256 at that revision. */
  files: Object.freeze({
    'config.json': { bytes: 650, sha256: '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7' },
    'tokenizer.json': { bytes: 711661, sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0' },
    'tokenizer_config.json': { bytes: 366, sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3' },
    'onnx/model_quantized.onnx': { bytes: 22972370, sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1' },
  }),
});

/** The vector length: the graph type and the vector index in memory.js declare the same number. */
export const DIMS = MODEL.dims;

/** Words that carry no content in a question or a note. */
const STOP = new Set(`a about again all also am an and any are as at be been but by can could did do does
doing for from had has have having he her here hers him his how i if in into is it its just me might my
of on once one or our ours out over she should so some such than that the their theirs them then there
these they this those to too up us was we were what when where which while who whom whose why will with
would you your yours yes no not now please tell know remember remind recall anything something everything
thing things get got let lets us ok okay`.split(/\s+/));

/**
 * Lower-cased words of letters and digits, accents folded ("Tomás" -> "tomas").
 * @param {string} text
 * @returns {string[]}
 */
export function words(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) ?? [];
}

/**
 * The content words of a text, in order, each once.
 * @param {string} text
 * @returns {string[]}
 */
export function contentWords(text) {
  return [...new Set(words(text).filter((w) => !STOP.has(w) && w.length > 1))];
}

/**
 * The full-text query for a text: its content words, space-separated ('' when it has none).
 * @param {string} text
 */
export function terms(text) {
  return contentWords(text).join(' ');
}

/**
 * Check a precomputed file against the model this build expects; throws with what to run.
 * @param {any} file  data/embeddings.json, parsed
 * @returns {Map<string, number[]>} text -> vector
 */
export function precomputed(file) {
  const m = file?.model ?? {};
  if (m.id !== MODEL.id || m.revision !== MODEL.revision || m.dtype !== MODEL.dtype || m.dims !== MODEL.dims) {
    throw new Error(`data/embeddings.json was made with ${m.id}@${String(m.revision).slice(0, 7)} (${m.dtype}, ${m.dims}); this build expects ${MODEL.id}@${MODEL.revision.slice(0, 7)} (${MODEL.dtype}, ${MODEL.dims}): run node harness/embed.mjs`);
  }
  const map = new Map(Object.entries(file.vectors ?? {}));
  for (const [text, v] of map) if (!Array.isArray(v) || v.length !== MODEL.dims) throw new Error(`data/embeddings.json: the vector of ${JSON.stringify(text)} has ${v?.length} numbers, not ${MODEL.dims}`);
  return map;
}

/**
 * @param {{known: Map<string, number[]>, live?: ((texts: string[]) => Promise<number[][]>) | null}} sources
 *   known: the precomputed vectors; live: the model in the tab, when the page has one
 * @returns {{embed: (texts: string[]) => Promise<Array<number[]|null>>, source: (text: string) => 'ahead'|'live'|'none'}}
 */
export function createEmbedder({ known, live = null }) {
  /** Vectors the model produced in this tab, kept so a text is embedded once. @type {Map<string, number[]>} */
  const made = new Map();
  return {
    /** One vector per text, or null where there is none to be had. */
    async embed(texts) {
      const missing = [...new Set(texts.filter((t) => !known.has(t) && !made.has(t)))];
      if (missing.length && live) {
        try {
          const vectors = await live(missing);
          missing.forEach((t, i) => made.set(t, vectors[i]));
        } catch { /* no model: these texts go without a vector */ }
      }
      return texts.map((t) => known.get(t) ?? made.get(t) ?? null);
    },
    source: (text) => (known.has(text) ? 'ahead' : made.has(text) ? 'live' : 'none'),
  };
}
