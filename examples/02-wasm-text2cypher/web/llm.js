// @ts-check
/**
 * llm.js: the in-browser model's pure parts: which models, pinned where, and how one question
 * becomes one request and one reply becomes one query. The engine itself is WebLLM
 * (@mlc-ai/web-llm, pinned in package.json) in llm.worker.js; this module never imports it, so the
 * Node harness reads it too.
 *
 *   MODELS               the two models the page offers, default first: weights on the Hugging Face Hub
 *                        at a pinned revision, the WebGPU model library at a pinned commit of
 *                        mlc-ai/binary-mlc-llm-libs, and SRI hashes WebLLM checks for the library,
 *                        the chat config and the tokenizer
 *   DEFAULT_MODEL        MODELS[0].id
 *   appConfig(models)    WebLLM's AppConfig for them (model_list of ModelRecords)
 *   RESPONSE_SCHEMA      the reply's JSON Schema: {"cypher": "<one query>"}
 *   request(briefing, question)   the chat.completions request body
 *   repairRequest(briefing, question, reply, problem)   one more turn: what was wrong, fix it
 *   parseReply(text)     the query in a reply (JSON first; a fenced or bare query as a fallback)
 *   webgpuStatus(nav)    {ok, reason, adapter}: whether this browser can run the models
 *
 * The briefing (briefing.js) stays byte-identical to the source app's prompt: it is the system
 * message as written. WebLLM's JSON mode needs the model told to answer in JSON, so that one line
 * goes in the user message, after the question.
 */

const HF = 'https://huggingface.co/mlc-ai';
/** mlc-ai/binary-mlc-llm-libs at a pinned commit (2026-11-16), the v0_2_87 libraries WebLLM 0.2.89 uses. */
export const MODEL_LIB_BASE = 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/5b7251f3bdce957be2a7bf73a6f6c560d9874df4/web-llm-models/v0_2_87/base/';

/** The context the briefing needs: the grounded briefing is about 3k tokens, WebLLM's default 4096. */
export const CONTEXT_WINDOW = 8192;

/**
 * @typedef {{
 *   id: string, label: string, repo: string, revision: string, lib: string, bytes: number,
 *   vramMB: number, licence: string, base: string,
 *   integrity: {config: string, model_lib: string, tokenizer: Record<string, string>}
 * }} ModelPin
 */

/** @type {readonly ModelPin[]} */
export const MODELS = Object.freeze([
  Object.freeze({
    id: 'Qwen3.5-2B-q4f16_1-MLC',
    label: 'Qwen3.5 2B (default, 1.08 GB)',
    repo: 'mlc-ai/Qwen3.5-2B-q4f16_1-MLC',
    revision: 'dd74e9c8a20c4546df85c844103bff87b6dcacad',
    lib: 'Qwen3.5-2B-q4f16_1_cs1k-webgpu.wasm',
    bytes: 1082564401,
    vramMB: 2245,
    licence: 'Apache-2.0',
    base: 'Qwen/Qwen3.5-2B',
    integrity: Object.freeze({
      config: 'sha256-Q1d7bemkxizw/pxe5XvFLrsvxIfGSiG/eNYkMRhrSwE=',
      model_lib: 'sha256-87PInFBA5gCYIyAwe/FUMdbbPytxnx1CJA34CKGAP9M=',
      tokenizer: Object.freeze({ 'tokenizer.json': 'sha256-X55NSQGpK5l+RjwfRgVQiLbMpcphplItG59kxLuBy0I=' }),
    }),
  }),
  Object.freeze({
    id: 'Qwen3.5-4B-q4f16_1-MLC',
    label: 'Qwen3.5 4B (better, 2.39 GB)',
    repo: 'mlc-ai/Qwen3.5-4B-q4f16_1-MLC',
    revision: '44b42469f9e192814bfd90440e3b377d89ba7a13',
    lib: 'Qwen3.5-4B-q4f16_1_cs1k-webgpu.wasm',
    bytes: 2390497405,
    vramMB: 3868,
    licence: 'Apache-2.0',
    base: 'Qwen/Qwen3.5-4B',
    integrity: Object.freeze({
      config: 'sha256-uU1Tv95bSW2NliOb9GhOJLU5QgnlrvkSeGbvpFQ5VlE=',
      model_lib: 'sha256-Z4sN4KWEAwEQNtMuroLIuBoQqH9qu5Yi7pfbRd+WRks=',
      tokenizer: Object.freeze({ 'tokenizer.json': 'sha256-X55NSQGpK5l+RjwfRgVQiLbMpcphplItG59kxLuBy0I=' }),
    }),
  }),
]);

export const DEFAULT_MODEL = MODELS[0].id;

/** @param {string} id */
export function modelById(id) {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`unknown model ${id}`);
  return m;
}

/**
 * WebLLM's AppConfig for the pinned models. The overrides follow WebLLM 0.2.89's own prebuilt
 * records for these models (max_history_size, the Qwen3.5 stop tokens), with the context raised
 * to CONTEXT_WINDOW. Weights are cached by WebLLM under its fixed Cache API names (webllm/model,
 * webllm/config, webllm/wasm; NOTES.md).
 * @param {readonly ModelPin[]} [models]
 */
export function appConfig(models = MODELS) {
  return {
    model_list: models.map((m) => ({
      model: `${HF}/${m.id}/resolve/${m.revision}/`,
      model_id: m.id,
      model_lib: MODEL_LIB_BASE + m.lib,
      vram_required_MB: m.vramMB,
      low_resource_required: false,
      required_features: ['shader-f16'],
      overrides: {
        context_window_size: CONTEXT_WINDOW,
        max_history_size: 1,
        conv_config: { stop_token_ids: [248046, 248044] },
      },
      integrity: { ...m.integrity, tokenizer: { ...m.integrity.tokenizer } },
    })),
  };
}

/** The reply's shape, enforced by WebLLM's grammar-constrained decoding (XGrammar). */
export const RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  properties: { cypher: { type: 'string' } },
  required: ['cypher'],
  additionalProperties: false,
});

/** The one line the user message adds so JSON mode has its instruction. */
export const JSON_INSTRUCTION = 'Answer with JSON only: {"cypher": "<the single read-only Cypher query>"}';

/** The token budget for a reply: one query. */
export const MAX_TOKENS = 512;

/**
 * The chat.completions request body for one question. In WebLLM 0.2.89 a JSON Schema goes in
 * response_format as {type: 'json_object', schema: '<the schema as a string>'}; extra_body
 * enable_thinking: false prefills an empty think block so a Qwen3.x model answers at once.
 * @param {string} briefing @param {string} question
 */
export function request(briefing, question) {
  return {
    messages: [
      { role: 'system', content: briefing },
      { role: 'user', content: `${question}\n\n${JSON_INSTRUCTION}` },
    ],
    temperature: 0,
    seed: 0,
    max_tokens: MAX_TOKENS,
    stream: false,
    response_format: { type: 'json_object', schema: JSON.stringify(RESPONSE_SCHEMA) },
    extra_body: { enable_thinking: false },
  };
}

/**
 * The request for one repair (the page's "repair once" option, off by default): the same
 * conversation, the model's first reply, and what was wrong with its query, the ontology check's
 * issues or Relate's error, verbatim. The page sends it at most once per query, and for both
 * variants alike, so the comparison stays fair.
 * @param {string} briefing @param {string} question @param {string} reply  the first reply's text
 * @param {string} problem
 */
export function repairRequest(briefing, question, reply, problem) {
  const body = request(briefing, question);
  return {
    ...body,
    messages: [
      ...body.messages,
      { role: 'assistant', content: reply },
      { role: 'user', content: `That query failed: ${problem}\nFix it. ${JSON_INSTRUCTION}` },
    ],
  };
}

/**
 * The query in a reply. A Qwen3.x reply opens with the empty `<think>…</think>` block that turning
 * thinking off prefills (NOTES.md W5): it is dropped first. Then JSON {"cypher": …}, the whole
 * text or its first {…} object; otherwise, like the source app's generate_cypher, the body of a
 * ``` fence or the whole text. A trailing `;` is dropped.
 * @param {string} text
 */
export function parseReply(text) {
  const t = String(text ?? '').replace(/^\s*(?:<think>[\s\S]*?<\/think>\s*)+/u, '').trim();
  let q = null;
  const brace = t.indexOf('{');
  for (const candidate of [t, brace >= 0 ? t.slice(brace, t.lastIndexOf('}') + 1) : '']) {
    if (q !== null || !candidate) continue;
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === 'object' && typeof v.cypher === 'string') q = v.cypher;
    } catch { /* not JSON: try the next form */ }
  }
  if (q === null) {
    const m = /```(?:cypher)?\s*([\s\S]*?)```/.exec(t);
    q = m ? m[1] : t;
  }
  q = q.trim();
  while (q.endsWith(';')) q = q.slice(0, -1).trimEnd();
  return q;
}

/**
 * Can this browser run the models? WebGPU with an adapter that has shader-f16 (the q4f16 weights).
 * @param {any} [nav] navigator (a page's or a worker's)
 * @returns {Promise<{ok: boolean, reason: string, adapter: string}>}
 */
export async function webgpuStatus(nav = globalThis.navigator) {
  if (!nav?.gpu) return { ok: false, reason: 'this browser has no WebGPU', adapter: '' };
  let adapter;
  try {
    adapter = await nav.gpu.requestAdapter();
  } catch (e) {
    return { ok: false, reason: `WebGPU refused an adapter: ${e instanceof Error ? e.message : e}`, adapter: '' };
  }
  if (!adapter) return { ok: false, reason: 'WebGPU has no adapter here (no usable GPU, or it is blocked)', adapter: '' };
  const info = adapter.info ?? {};
  const name = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ');
  if (!adapter.features?.has('shader-f16')) {
    return { ok: false, reason: 'the GPU adapter lacks shader-f16, which the models need', adapter: name };
  }
  return { ok: true, reason: '', adapter: name };
}
