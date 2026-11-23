// @ts-check
/**
 * gliner.js: GLiNER2.5 through gliner-rs's WASM build, the one model module (D4, D6).
 *
 * Shared by the engine worker (web/worker.js) and the Node harness (harness/model.mjs,
 * harness/run.mjs), so it imports nothing: the caller hands in the gliner-rs glue module
 * and the file bytes, fetched however its host fetches them.
 *
 *   const glue = await import('<dir>/gliner_rs.js');        // scripts/build-gliner-wasm.sh output
 *   const m = loadModel({ glue, wasmBytes, weights, tokenizer, config, encoderConfig });
 *   const out = extract(m, 'Ada Lovelace founded Northwind.', {
 *     entities: [{ id: 'PERSON', description: 'A named person.' }, { id: 'COMPANY' }],
 *     relations: ['founded'],                               // relationPhrase('FOUNDED')
 *     threshold: 0.1,
 *   });
 *   // out.entities  [{label, text, start, end, score}]
 *   // out.relations [{relation, head: {text, start, end}, tail: {text, start, end}, score}]
 *
 * Everything is synchronous: gliner-rs runs fp32 on the CPU, single-threaded (G5, G6).
 *
 * Offsets are Unicode code points, as gliner-rs and Python gliner2 report them (G11),
 * not the UTF-16 units JS strings index by: in "🚀 Zoë" the name starts at code point 2
 * and UTF-16 index 3. Convert with utf16Index() before slicing a JS string.
 *
 * The model sees:
 *   - entity labels as ontology type ids ("PERSON"), each with its description
 *     (gliner-rs's "LABEL:description" form, so an id cannot contain ':', G11);
 *   - relations as lower-case phrases derived from ids by relationPhrase()
 *     ("HEADQUARTERED_IN" -> "headquartered in"); gliner-rs binds no relation
 *     descriptions (G5). Output relations carry the phrase the caller passed.
 *   - the checkpoint's own overlap policy ("flat") unless `overlap` is given.
 *
 * Raw output: extractRaw() returns gliner-rs's extractCli JSON re-serialised compactly
 * (JSON.parse + JSON.stringify, which is lossless for its numbers), the string the
 * inference cache stores (D7); normalize() turns it into the shape above. extract() is both.
 * A repeated call returns the same string, bit for bit (G7).
 */

/** The checkpoint files loadModel() takes, by argument name (paths inside the HF repo). */
export const MODEL_FILES = Object.freeze({
  weights: 'model.safetensors',
  tokenizer: 'tokenizer.json',
  config: 'config.json',
  encoderConfig: 'encoder_config/config.json',
});

/** Overlap policies gliner-rs accepts (canonical names only, so cache keys stay canonical). */
export const OVERLAP_POLICIES = Object.freeze(['flat', 'nested', 'longest', 'allow']);

/**
 * The phrase the model is asked for a relation id: lower case, underscores as spaces.
 * @param {string} id  e.g. "HEADQUARTERED_IN"
 * @returns {string}   e.g. "headquartered in"
 */
export function relationPhrase(id) {
  if (typeof id !== 'string') throw new TypeError('relationPhrase: id must be a string');
  const phrase = id.toLowerCase().replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!phrase) throw new RangeError(`relationPhrase: ${JSON.stringify(id)} gives an empty phrase`);
  return phrase;
}

/**
 * @typedef {{id: string, description?: string}} EntityType
 * @typedef {{entities: EntityType[], relations?: string[], threshold: number, overlap?: string}} Schema
 * @typedef {{entities: {id: string, description: string|null}[], relations: string[], threshold: number, overlap: string|null}} CheckedSchema
 * @typedef {{model: any, exports: any}} ModelHandle
 * @typedef {{label: string, text: string, start: number, end: number, score: number}} Entity
 * @typedef {{text: string, start: number, end: number}} Span
 * @typedef {{relation: string, head: Span, tail: Span, score: number}} Relation
 */

/**
 * Validate a schema and return it in canonical form (trimmed, as gliner-rs trims).
 * @param {Schema} schema
 * @returns {CheckedSchema}
 */
export function checkSchema(schema) {
  if (!schema || typeof schema !== 'object') throw new TypeError('schema: an object');
  const { entities, relations = [], threshold, overlap } = schema;
  if (!Array.isArray(entities) || entities.length === 0) throw new TypeError('schema.entities: a non-empty array');
  const seen = new Set();
  const ents = entities.map((e, i) => {
    const id = typeof e === 'object' && e !== null ? e.id : undefined;
    if (typeof id !== 'string' || id.trim() !== id || id === '') {
      throw new TypeError(`schema.entities[${i}].id: a non-empty string without surrounding space`);
    }
    if (id.includes(':')) throw new RangeError(`schema.entities[${i}].id ${JSON.stringify(id)}: gliner-rs splits a label at ':' (G11)`);
    if (seen.has(id)) throw new RangeError(`schema.entities: duplicate id ${JSON.stringify(id)}`);
    seen.add(id);
    const d = e.description == null ? '' : String(e.description).trim();
    return { id, description: d === '' ? null : d };
  });
  if (!Array.isArray(relations)) throw new TypeError('schema.relations: an array of phrases');
  const rseen = new Set();
  const rels = relations.map((r, i) => {
    if (typeof r !== 'string' || r.trim() !== r || r === '') {
      throw new TypeError(`schema.relations[${i}]: a non-empty phrase without surrounding space`);
    }
    if (rseen.has(r)) throw new RangeError(`schema.relations: duplicate phrase ${JSON.stringify(r)}`);
    rseen.add(r);
    return r;
  });
  if (typeof threshold !== 'number' || !(threshold > 0 && threshold <= 1)) {
    throw new RangeError('schema.threshold: a number in (0, 1]');
  }
  if (overlap != null && !OVERLAP_POLICIES.includes(overlap)) {
    throw new RangeError(`schema.overlap: one of ${OVERLAP_POLICIES.join(', ')}, or omitted for the checkpoint's own`);
  }
  return { entities: ents, relations: rels, threshold, overlap: overlap ?? null };
}

/**
 * The canonical schema string for the inference cache key (D7): entity ids with their
 * descriptions, relation phrases and the options, in a fixed order. Two schemas give the
 * same string exactly when gliner-rs would be called with the same arguments. Hash it
 * together with the model revision, the weights' sha256, the gliner-rs build id and the
 * sentence text.
 * @param {Schema} schema
 * @returns {string}
 */
export function schemaKey(schema) {
  const s = checkSchema(schema);
  return JSON.stringify({
    v: 1,
    entities: s.entities.map((e) => [e.id, e.description]),
    relations: s.relations,
    threshold: s.threshold,
    overlap: s.overlap,
  });
}

/** @param {string | ArrayBuffer | ArrayBufferView} x */
function asText(x) {
  if (typeof x === 'string') return x;
  return new TextDecoder('utf-8', { fatal: true }).decode(x);
}

/** @param {ArrayBuffer | ArrayBufferView} x @returns {Uint8Array} */
function asBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TypeError('expected bytes (Uint8Array or ArrayBuffer)');
}

/** gliner-rs throws plain strings; give callers an Error. */
function glinerError(where, e) {
  if (e instanceof Error && e.name !== 'Error') return e; // e.g. RuntimeError: unreachable (a trap)
  const err = new Error(`gliner-rs ${where}: ${e instanceof Error ? e.message : String(e)}`);
  err.name = 'GlinerError';
  return err;
}

/**
 * Instantiate gliner-rs and load a checkpoint, synchronously (in a browser, call it from a
 * worker: a synchronous compile of a 4 MB module is refused on the page thread).
 * @param {{glue: any, wasmBytes: BufferSource | WebAssembly.Module, weights: ArrayBuffer | ArrayBufferView,
 *          tokenizer: ArrayBuffer | ArrayBufferView, config: string | ArrayBuffer | ArrayBufferView,
 *          encoderConfig: string | ArrayBuffer | ArrayBufferView}} files
 *   glue: the namespace of gliner_rs.js; wasmBytes: gliner_rs_bg.wasm (bytes or a compiled module);
 *   weights: model.safetensors; tokenizer: tokenizer.json; config: config.json;
 *   encoderConfig: encoder_config/config.json.
 * @returns {ModelHandle}
 */
export function loadModel({ glue, wasmBytes, weights, tokenizer, config, encoderConfig }) {
  if (!glue || typeof glue.initSync !== 'function' || typeof glue.WasmModel?.load !== 'function') {
    throw new TypeError('loadModel: glue must be the gliner_rs.js module namespace (wasm-pack --target web)');
  }
  const exports = glue.initSync({ module: wasmBytes });
  let model;
  try {
    model = glue.WasmModel.load(asBytes(weights), asBytes(tokenizer), asText(config), asText(encoderConfig));
  } catch (e) {
    throw glinerError('load', e);
  }
  return { model, exports };
}

/** Release the model's WASM memory (the memory itself never shrinks). @param {ModelHandle} handle */
export function freeModel(handle) {
  handle.model.free();
}

/** Bytes of WASM memory gliner-rs holds now. @param {ModelHandle} handle */
export function memoryBytes(handle) {
  return handle.exports.memory.buffer.byteLength;
}

/**
 * Run gliner-rs's extractCli on one text and return its JSON, compact.
 * @param {ModelHandle} handle
 * @param {string} text
 * @param {Schema} schema
 * @returns {string}
 */
export function extractRaw(handle, text, schema) {
  if (typeof text !== 'string') throw new TypeError('extract: text must be a string');
  const s = checkSchema(schema);
  const ents = s.entities.map((e) => (e.description === null ? e.id : `${e.id}:${e.description}`));
  /** @type {Record<string, unknown>} */
  const opts = { threshold: s.threshold, confidence: true, spans: true };
  if (s.overlap !== null) opts.overlap = s.overlap;
  let pretty;
  try {
    pretty = handle.model.extractCli(text, ents, s.relations, [], [], false, JSON.stringify(opts));
  } catch (e) {
    throw glinerError('extractCli', e);
  }
  return JSON.stringify(JSON.parse(pretty));
}

/** @param {any} x @param {string} what */
function span(x, what) {
  if (!x || typeof x.text !== 'string' || !Number.isInteger(x.start) || !Number.isInteger(x.end)) {
    throw new TypeError(`normalize: malformed ${what}`);
  }
  return { text: x.text, start: x.start, end: x.end };
}

/**
 * Turn extractCli JSON into flat, sorted lists. A relation's score is the lower of its
 * head and tail confidences (gliner-rs gives both the edge's score).
 * Order: entities by start, end, then schema order of the label; relations by schema
 * order, then head and tail offsets.
 * @param {string | object} raw  extractRaw()'s string (or its parsed object)
 * @param {Schema} schema        the schema of the call that produced it
 * @returns {{entities: Entity[], relations: Relation[]}}
 */
export function normalize(raw, schema) {
  const s = checkSchema(schema);
  const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!r || typeof r.entities !== 'object' || r.entities === null) throw new TypeError('normalize: no entities in the result');
  const labelRank = new Map(s.entities.map((e, i) => [e.id, i]));
  const relRank = new Map(s.relations.map((p, i) => [p, i]));
  /** @type {Entity[]} */
  const entities = [];
  for (const [label, items] of Object.entries(r.entities)) {
    if (!labelRank.has(label)) throw new RangeError(`normalize: label ${JSON.stringify(label)} is not in the schema`);
    for (const it of items ?? []) {
      const sp = span(it, `${label} entity`);
      entities.push({ label, ...sp, score: Number(it.confidence) });
    }
  }
  /** @type {Relation[]} */
  const relations = [];
  for (const [relation, items] of Object.entries(r.relation_extraction ?? {})) {
    if (!relRank.has(relation)) throw new RangeError(`normalize: relation ${JSON.stringify(relation)} is not in the schema`);
    for (const it of items ?? []) {
      const head = span(it.head, `${relation} head`), tail = span(it.tail, `${relation} tail`);
      relations.push({ relation, head, tail, score: Math.min(Number(it.head.confidence), Number(it.tail.confidence)) });
    }
  }
  const byNum = (/** @type {number[]} */ a, /** @type {number[]} */ b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  };
  entities.sort((a, b) => byNum([a.start, a.end, labelRank.get(a.label) ?? 0, -a.score], [b.start, b.end, labelRank.get(b.label) ?? 0, -b.score]));
  relations.sort((a, b) => byNum(
    [relRank.get(a.relation) ?? 0, a.head.start, a.head.end, a.tail.start, a.tail.end, -a.score],
    [relRank.get(b.relation) ?? 0, b.head.start, b.head.end, b.tail.start, b.tail.end, -b.score]));
  return { entities, relations };
}

/**
 * extractRaw() then normalize().
 * @param {ModelHandle} handle
 * @param {string} text
 * @param {Schema} schema
 */
export function extract(handle, text, schema) {
  return normalize(extractRaw(handle, text, schema), schema);
}

/**
 * The UTF-16 index of a code-point offset in text (for String.prototype.slice).
 * @param {string} text
 * @param {number} cp  a code-point offset, 0 <= cp <= the text's code-point length
 * @returns {number}
 */
export function utf16Index(text, cp) {
  if (!Number.isInteger(cp) || cp < 0) throw new RangeError('utf16Index: a non-negative integer offset');
  let i = 0;
  for (let n = 0; n < cp; n++) {
    if (i >= text.length) throw new RangeError(`utf16Index: offset ${cp} is past the end of the text`);
    i += /** @type {number} */ (text.codePointAt(i)) > 0xffff ? 2 : 1;
  }
  return i;
}
