// @ts-check
/**
 * py.js: the few Python semantics the ported modules need to reproduce the source app's output
 * byte for byte (briefing.js, validate.js, compare.js, ddl.js all port Python).
 *
 *   truthy(v)        Python truthiness: None, False, 0, '', [] and {} are false
 *   reprStr(s)       repr() of a str ('x', or "x'y" when the text holds a ' and no ")
 *   reprPairs(pairs) repr(sorted(pairs)) of a list of 2-tuples of str, e.g. [('Person', 'Company')]
 *   cmpStr(a, b)     Python's str order (code points), not UTF-16 order
 *   WORD             the class Python's \w matches in a str pattern (letters, digits, _), for a `u` RegExp
 *
 * Shared by the page, the engine worker and the Node harness: no imports.
 */

/** @param {unknown} v */
export function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(/** @type {object} */ (v)).length > 0;
  return Boolean(v);
}

/** @param {string} a @param {string} b */
export function cmpStr(a, b) {
  const x = Array.from(a, (c) => /** @type {number} */ (c.codePointAt(0)));
  const y = Array.from(b, (c) => /** @type {number} */ (c.codePointAt(0)));
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** @param {string} s */
export function reprStr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = '';
  for (const c of s) {
    if (c === '\\') out += '\\\\';
    else if (c === q) out += `\\${q}`;
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else out += c;
  }
  return q + out + q;
}

/** @param {Iterable<[string, string]>} pairs */
export function reprPairs(pairs) {
  const list = [...pairs].sort((a, b) => cmpStr(a[0], b[0]) || cmpStr(a[1], b[1]));
  return `[${list.map(([a, b]) => `(${reprStr(a)}, ${reprStr(b)})`).join(', ')}]`;
}

/** Python's \w in a str pattern, as a `u`-flag RegExp class body. */
export const WORD = '[\\p{L}\\p{N}_]';
