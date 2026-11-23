// @ts-check
/**
 * names.js: edgextract's canonical entity names, ported to JavaScript (NOTES.md
 * E3, D5). The source is rust/edgextract/src/names.rs:33 (`normalize_entity_name`) at
 * edgextract commit 3f08b1d, Apache-2.0, (c) Raphael Mansuy; this port changes no rule.
 *
 *   normalizeEntityName('the Apache AGE')   -> 'APACHE_AGE'
 *   normalizeEntityName("Acme Inc.'s")      -> 'ACME_INC'
 *   normalizeEntityName('Zürich')           -> 'Z_RICH'   (non-ASCII letters are dropped, as upstream)
 *   normalizeEntityName('42')               -> ''         (opaque: rejected)
 *   entityKey('PERSON', 'Ada Lovelace')     -> 'PERSON:ADA_LOVELACE'   (D8's Entity key)
 *
 * The rules, in upstream's order:
 *   1. trim (Rust's White_Space set, which is not JavaScript's trim()), then NFC;
 *   2. drop possessives: "'s" (any case, also the long s "ſ") followed by a Unicode word
 *      boundary, where Rust's \b is Unicode-aware and JavaScript's is ASCII-only, so the
 *      boundary is spelt out as a lookahead over Rust's \w (Alphabetic, M, Nd, Pc, Join_Control);
 *   3. lower-case (full Unicode mapping, as Rust's to_lowercase);
 *   4. opaque ids give '': a UUID, 32 or more hex digits, or only decimal digits (Rust's \d
 *      is any Unicode Nd digit, so "٤٢" is opaque too), checked with ASCII spaces removed;
 *   5. split on [^0-9a-z]+ and drop empty tokens and the articles a, an, the;
 *   6. join with '_', check opacity again, upper-case.
 *
 * Step 5 keeps ASCII letters and digits only, so every other letter is dropped, exactly as
 * upstream does: "Zürich" -> Z_RICH, "Müller" -> M_LLER, "東京" -> '' (rejected), and two
 * names that differ only in non-ASCII letters share a key. That is edgextract's behaviour, kept
 * on purpose (its eval keyed gold labels the same way); the display name keeps the surface text.
 * An empty result means the name has no usable key and the mention is rejected.
 */

/** Rust's char::is_whitespace (Unicode White_Space): str::trim strips these. */
const RUST_WS = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const TRIM = new RegExp(`^[${RUST_WS}]+|[${RUST_WS}]+$`, 'g');

/** (?i)'s\b with Rust's Unicode word boundary. */
const POSSESSIVE = /'s(?![\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}])/giu;
/** (?i)^(?:uuid|[0-9a-f]{32,}|\d+)$ with Rust's Unicode \d. */
const OPAQUE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}|\p{Nd}+)$/iu;
const NON_ALNUM = /[^0-9a-z]+/u;
const ARTICLES = new Set(['a', 'an', 'the']);

/**
 * Rust's str::trim: strips Unicode White_Space (U+0085 included, U+FEFF not, unlike
 * String.prototype.trim).
 * @param {string} s
 */
export function rustTrim(s) {
  return s.replace(TRIM, '');
}

/**
 * edgextract's canonical name: NFC, no articles or possessives, UPPERCASE_UNDERSCORE; '' when
 * the name is opaque or keeps no ASCII letter or digit.
 * @param {string} raw  the surface text of a mention
 * @returns {string}
 */
export function normalizeEntityName(raw) {
  if (typeof raw !== 'string') throw new TypeError('normalizeEntityName: raw must be a string');
  let text = rustTrim(raw).normalize('NFC');
  if (text === '') return '';
  text = text.replace(POSSESSIVE, '');
  const lowered = text.toLowerCase();
  if (OPAQUE.test(lowered.replaceAll(' ', ''))) return '';
  const tokens = lowered.split(NON_ALNUM).filter((t) => t !== '' && !ARTICLES.has(t));
  if (tokens.length === 0) return '';
  const joined = tokens.join('_');
  if (OPAQUE.test(joined)) return '';
  return joined.toUpperCase();
}

/**
 * Titles and honorifics the entity key drops from the start of a name (entityName), lower case,
 * without the full stop: "Dr. Imani Okafor", "Dr Imani Okafor" and "Imani Okafor" are one entity.
 */
export const HONORIFICS = Object.freeze(['dr', 'mr', 'mrs', 'ms', 'mx', 'miss', 'prof', 'sir', 'dame', 'rev', 'fr', 'capt']);
const HONORIFIC_SET = new Set(HONORIFICS);
/** Lower-case words a proper name may carry between its capitalised ones ("Taberna do Tavik", "Bank of Leeds"). */
const PARTICLES = new Set(['de', 'da', 'do', 'dos', 'das', 'del', 'della', 'di', 'du', 'van', 'von', 'der', 'den', 'la', 'le', 'of', 'and', 'y', '&']);
const EDGE_PUNCT = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;
/** A word as the rules compare it: lower case, without its leading and trailing punctuation. */
const bare = (w) => w.replace(EDGE_PUNCT, '').toLowerCase();

/**
 * The words of a kind's label as entityName matches them: the label's lower-case words
 * ("work order" -> ['work', 'order']). A kind id is split at its capitals ('MaintenanceRecord').
 * @param {string} label  the label text the model is asked (ontology.js Kind.ask.label), or a kind id
 * @returns {string[]}
 */
export function kindWords(label) {
  return String(label ?? '').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * The name of an entity's key (this example's rule over edgextract's canonical name; D8): the
 * canonical name (normalizeEntityName) of the surface text after dropping, each only when what
 * remains still has a canonical name of its own,
 *   1. a leading article, then leading titles and honorifics (HONORIFICS, any case, with or
 *      without a full stop): "Dr. Imani Okafor" -> IMANI_OKAFOR, as "Imani Okafor";
 *   2. the kind's label, or one word of it (`words`: kindWords of the label), at the start or the
 *      end of the span, when the rest is code-like (it has a digit) or a proper name (every word
 *      capitalised, PARTICLES aside): with the kind Account "account ACC-2207" -> ACC_2207, as
 *      "ACC-2207"; with Layer "Hydrology layer" -> HYDROLOGY; with WorkOrder "Work order WO-5531"
 *      -> WO_5531. "billing agent" keeps its words (a common noun before the kind's word), and so
 *      does "Guest 4471" (the rest, 4471, would be an opaque number).
 * So the same thing written with and without a title or its kind's word is one entity, where
 * edgextract's names keep the words (harness/ontology.mjs pins the difference). The cost: a name
 * that starts with a title word, such as a drink called "Dr Pepper", loses it (PEPPER). The
 * display keeps the surface text (store.js publish). '' when the text has no canonical name.
 * @param {string} raw  the surface text
 * @param {string[]} [words]  the kind's label words (kindWords); none: only rule 1
 * @returns {string}
 */
export function entityName(raw, words = []) {
  const full = normalizeEntityName(raw);
  if (full === '') return '';
  let ws = rustTrim(raw).split(/\s+/u).filter((w) => w !== '');
  const named = (xs) => xs.length > 0 && normalizeEntityName(xs.join(' ')) !== '';
  if (ws.length > 1 && ['a', 'an', 'the'].includes(bare(ws[0]))) ws = ws.slice(1);
  while (ws.length > 1 && HONORIFIC_SET.has(bare(ws[0])) && named(ws.slice(1))) ws = ws.slice(1);
  const kw = new Set(words);
  const phrase = words.join(' ');
  const proper = (xs) => xs.length > 0 && /^\p{Lu}/u.test(xs[0]) &&
    xs.every((w) => /^[\p{Lu}\p{Nd}]/u.test(w.replace(EDGE_PUNCT, '')) || PARTICLES.has(bare(w)));
  const rest = (xs) => (xs.some((w) => /\p{Nd}/u.test(w)) || proper(xs)) && named(xs);
  if (kw.size) {
    // the label's words at the start, longest first: the whole label, else one of its words
    const n = words.length > 1 && ws.slice(0, words.length).map(bare).join(' ') === phrase ? words.length : kw.has(bare(ws[0])) ? 1 : 0;
    if (n && ws.length > n && rest(ws.slice(n))) ws = ws.slice(n);
    const m = words.length > 1 && ws.slice(-words.length).map(bare).join(' ') === phrase ? words.length : kw.has(bare(ws[ws.length - 1])) ? 1 : 0;
    if (m && ws.length > m && rest(ws.slice(0, -m))) ws = ws.slice(0, -m);
  }
  return normalizeEntityName(ws.join(' ')) || full;
}

/**
 * Words edgextract never turns into names (rust/edgextract/src/candidates.rs PRONOUNS at 3f08b1d,
 * Apache-2.0): a mention whose whole text is one of them gets no canonical name, so the gate drops
 * it (rule `no-name`). (Kept here with the name rules; pipeline.js re-exports it.)
 */
export const PRONOUNS = Object.freeze([
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'hers',
  'it', 'its', 'they', 'them', 'their', 'this', 'that', 'these', 'those',
]);

/**
 * A mention's name, its entity key's NAME: '' for a pronoun or a name with no canonical form,
 * else entityName with its kind's label words.
 * @param {string} text  the mention's surface text
 * @param {string[]} [words]  kindWords of the mention's kind's label
 */
export function mentionName(text, words = []) {
  return PRONOUNS.includes(text.trim().toLowerCase()) ? '' : entityName(text, words);
}

/**
 * D8's Entity key, `<KIND>:<NAME>`, or null when the name has no canonical form.
 * @param {string} kind  an ontology kind id (already validated by ontology.js)
 * @param {string} raw   the surface text
 * @returns {string|null}
 */
export function entityKey(kind, raw) {
  if (typeof kind !== 'string' || kind === '') throw new TypeError('entityKey: kind must be a non-empty string');
  const name = normalizeEntityName(raw);
  return name === '' ? null : `${kind}:${name}`;
}
