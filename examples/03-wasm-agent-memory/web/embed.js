// @ts-check
/**
 * embed.js: the stand-in for an embedding model (NOTES.md D3, ADR-0014).
 *
 * `embed(text)` hashes a text's content words and their character trigrams into DIMS buckets
 * (feature hashing, FNV-1a) and L2-normalises the result. Two texts that share words, or parts of
 * words ("decide", "decided"), get a high cosine similarity; two that share none get about zero. It
 * captures lexical overlap, not meaning. That is enough to run a real vector index and a real
 * similarity search in the tab with no model to download, and it is deterministic, so the same text
 * gives the same vector in Node, in the page and in CI.
 *
 * An application calls its embedding model here instead. Nothing else in the example changes: the
 * vector index, the SEARCH clause and the recall statement take whatever vectors they are given.
 *
 * `terms(text)` is the same content words as one string: the query the full-text search gets, so a
 * question's "what", "do" and "you" do not count as search terms.
 */

/** The vector length: the graph type and the vector index in memory.js declare the same number. */
export const DIMS = 256;

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

/** FNV-1a, 32 bits, over a string's UTF-16 code units (the features are ASCII). @param {string} s */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A text's vector: DIMS numbers, L2-normalised, rounded to six decimals (all zeros when the text has
 * no content words). Whole words weigh 1, character trigrams 0.5.
 * @param {string} text
 * @returns {number[]}
 */
export function embed(text) {
  const v = new Array(DIMS).fill(0);
  const add = (/** @type {string} */ feature, /** @type {number} */ weight) => {
    const h = fnv1a(feature);
    v[h % DIMS] += (h >>> 31 ? 1 : -1) * weight;
  };
  for (const w of contentWords(text)) {
    add(`w:${w}`, 1);
    for (let i = 0; i + 3 <= w.length; i++) add(`t:${w.slice(i, i + 3)}`, 0.5);
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return v;
  return v.map((x) => Math.round((x / norm) * 1e6) / 1e6);
}
