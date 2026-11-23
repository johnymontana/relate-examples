// @ts-check
/**
 * split.js: edgextract's markdown sentence splitter, ported to JavaScript (NOTES.md
 * E2, D5, D8). The source is rust/edgextract/src/markdown.rs (`split_sentences`, line 83) at
 * edgextract commit 3f08b1d, Apache-2.0, (c) Raphael Mansuy. The rules are upstream's, unchanged;
 * only the offsets differ (see below). harness/ontology.mjs checks the port against
 * edgextract 0.1.0's own WASM on every sample, the harness's fixtures and stress documents (ontology.txt).
 *
 *   splitSentences('# Northwind\n\nAda founded Northwind. It grew.\n')
 *   // [{idx: 0, text: 'Ada founded Northwind.', start: 13, end: 35, heading: ['Northwind']},
 *   //  {idx: 1, text: 'It grew.', start: 36, end: 44, heading: ['Northwind']}]
 *
 * The rules:
 *   - YAML frontmatter (`---` ... `---` at the very start) is skipped; offsets still count it.
 *   - Fenced code (a line starting ``` up to the next such line, or the end) is skipped.
 *   - A heading line (1-6 `#`, whitespace, a title) is not a sentence; it sets the heading path
 *     of what follows (a level-n heading replaces those at level n and deeper).
 *   - Blank lines end a paragraph. In a paragraph every list item (`- `, `* `, `+ `, `1. `,
 *     `1) `), table row (`|`) and quote line (`>`) starts its own unit; other lines continue
 *     the unit above.
 *   - A unit splits after `.`, `!` or `?` (plus any closing `.!?"')`) followed by ASCII
 *     whitespace or the end, unless the word before is an abbreviation (Mr, Dr, Inc, etc,
 *     e.g, ...: ABBREVIATIONS; only the letters right before the dot count, so "e.g." itself
 *     still splits, as upstream).
 *   - A sentence longer than 500 UTF-8 bytes is cut into pieces of at most 500 bytes, at the
 *     last line end, else `;` or `|`, else `,` or `:`, else space or tab, found in the second
 *     half of the window (the half-limit rule); with none of them, at the 500-byte boundary
 *     (backed off to a character boundary). Pieces are trimmed.
 *   - Trimming uses Rust's White_Space set (U+0085 yes, U+FEFF no), not String.trim().
 *
 * Offsets (D8): upstream reports UTF-8 byte offsets; this port reports Unicode code points,
 * the unit gliner-rs and Python report spans in (G11) and the store keeps (D8). The 500-byte
 * limit is still measured in UTF-8 bytes, so the cuts land where upstream's do. JavaScript
 * strings index by UTF-16 units, so slice with offsetMap(text).cpToUtf16() (or sliceCp), never
 * text.slice(start, end), when the text holds anything outside the BMP (emoji, some CJK).
 *
 * Each sentence: {idx, text, start, end, heading}, where heading is the heading path (an
 * array of titles, outermost first; [] before the first heading) and text equals the code
 * points [start, end) of the input. headingContext(s) joins the path as upstream does.
 */

/** No piece is longer than this many UTF-8 bytes (markdown.rs MAX_SENTENCE_CHARS). */
export const MAX_SENTENCE_BYTES = 500;

/** Words a following '.' does not end a sentence after (markdown.rs ABBREV), lower case. */
export const ABBREVIATIONS = Object.freeze([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'vs', 'etc', 'e.g', 'i.e', 'inc', 'ltd', 'co',
  'fig', 'eq', 'no', 'vol', 'pp', 'al', 'st', 'ave',
]);
const ABBREV = new Set(ABBREVIATIONS);

const NL = 0x0a;
const CR = 0x0d;
const HASH = 0x23;
const BACKTICK = 0x60;
/** The four break sets bound_ranges tries, in order: line end; ; |; , :; space, tab. */
const BREAKS = [new Set([NL]), new Set([0x3b, 0x7c]), new Set([0x2c, 0x3a]), new Set([0x20, 0x09])];
const CLOSERS = new Set([0x2e, 0x21, 0x3f, 0x22, 0x27, 0x29]); // . ! ? " ' )

/** Rust's char::is_whitespace (Unicode White_Space). */
function isWs(cp) {
  return cp === 0x20 || (cp >= 0x09 && cp <= 0x0d) ||
    (cp > 0x7f && (cp === 0x85 || cp === 0xa0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) ||
      cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000));
}

/**
 * Whitespace as upstream's byte loop sees it after a sentence end: `bytes[j] as char` there
 * is always ASCII or a UTF-8 lead byte (never whitespace), so only ASCII whitespace counts.
 */
function isAsciiWs(cp) {
  return cp === 0x20 || (cp >= 0x09 && cp <= 0x0d);
}

/** UTF-8 length of one code point; a lone surrogate counts as U+FFFD (3), as TextEncoder writes it. */
function utf8Len(cp) {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

const isAsciiAlpha = (cp) => (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
const isAsciiDigit = (cp) => cp >= 0x30 && cp <= 0x39;

/** @param {string} text @returns {number[]} its code points */
function codePointsOf(text) {
  const out = [];
  for (const ch of text) out.push(/** @type {number} */ (ch.codePointAt(0)));
  return out;
}

/** @param {number[]} cps @param {number} a @param {number} b */
function str(cps, a, b) {
  let s = '';
  for (let i = a; i < b; i++) s += String.fromCodePoint(cps[i]);
  return s;
}

/** True when cps[a, b) is all whitespace (Rust's trim() leaves it empty). */
function blank(cps, a, b) {
  for (let i = a; i < b; i++) if (!isWs(cps[i])) return false;
  return true;
}

/** [a', b') of cps[a, b) trimmed as Rust's str::trim does. */
function trimRange(cps, a, b) {
  while (a < b && isWs(cps[a])) a++;
  while (b > a && isWs(cps[b - 1])) b--;
  return [a, b];
}

/** markdown.rs looks_abbrev: the ASCII letters right before the punctuation at i. */
function looksAbbrev(cps, lo, i) {
  let k = i;
  while (k > lo && isAsciiAlpha(cps[k - 1])) k--;
  return ABBREV.has(str(cps, k, i).toLowerCase());
}

/** markdown.rs is_block_start, on the line cps[a, b) (its newline included). */
function isBlockStart(cps, a, b) {
  while (a < b && isWs(cps[a])) a++;
  if (a >= b) return false;
  const c = cps[a];
  if (c === 0x2d || c === 0x2a || c === 0x2b) return a + 1 < b && (cps[a + 1] === 0x20 || cps[a + 1] === 0x09);
  if (c === 0x7c || c === 0x3e) return true;
  if (isAsciiDigit(c)) {
    let k = a;
    while (k < b && isAsciiDigit(cps[k])) k++;
    return k < b && (cps[k] === 0x2e || cps[k] === 0x29) && k + 1 < b && cps[k + 1] === 0x20;
  }
  return false;
}

/** markdown.rs sentences_in, on the unit cps[lo, hi): [start, end) ranges, untrimmed. */
function sentencesIn(cps, lo, hi) {
  const out = [];
  let start = lo;
  let i = lo;
  while (i < hi) {
    const ch = cps[i];
    if ((ch === 0x2e || ch === 0x21 || ch === 0x3f) && !looksAbbrev(cps, lo, i)) {
      let j = i + 1;
      while (j < hi && CLOSERS.has(cps[j])) j++;
      if (j >= hi || isAsciiWs(cps[j])) {
        if (!blank(cps, start, j)) out.push([start, j]);
        while (j < hi && isAsciiWs(cps[j])) j++;
        start = j;
        i = j;
        continue;
      }
    }
    i++;
  }
  if (start < hi && !blank(cps, start, hi)) out.push([start, hi]);
  return out;
}

/**
 * markdown.rs bound_ranges: cps[lo, hi) (a trimmed sentence) as pieces of at most `max`
 * UTF-8 bytes, each trimmed; returns absolute [start, end) ranges.
 */
function boundRanges(cps, lo, hi, max = MAX_SENTENCE_BYTES) {
  const bytes = new Array(hi - lo + 1); // bytes[k] = UTF-8 bytes of cps[lo, lo + k)
  bytes[0] = 0;
  for (let k = lo; k < hi; k++) bytes[k - lo + 1] = bytes[k - lo] + utf8Len(cps[k]);
  const at = (k) => bytes[k - lo];
  const floor = Math.floor(max / 2);
  const out = [];
  const push = (a, b) => {
    const [x, y] = trimRange(cps, a, b);
    if (x < y) out.push([x, y]);
  };
  let pos = lo;
  while (pos < hi) {
    if (at(hi) - at(pos) <= max) {
      push(pos, hi);
      break;
    }
    let limit = pos; // the largest char boundary within max bytes of pos
    while (limit < hi && at(limit + 1) - at(pos) <= max) limit++;
    let cut = -1;
    for (const set of BREAKS) {
      for (let k = limit - 1; k >= pos && at(k) - at(pos) >= floor; k--) {
        if (set.has(cps[k])) {
          cut = k + 1;
          break;
        }
      }
      if (cut >= 0) break;
    }
    if (cut < 0) cut = limit;
    push(pos, cut);
    pos = cut;
  }
  return out;
}

/** Start of the YAML frontmatter's end, in code points (0 without one). */
function frontmatterEnd(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return m ? codePointsOf(m[0]).length : 0;
}

/**
 * markdown.rs fence_regions: (?m)^```.*$ matches, paired; an unclosed fence runs to the end.
 * Only '\n' starts a line (Rust's multi-line ^), and '.' is anything but '\n'.
 */
function fenceRegions(cps, lo, hi) {
  const regions = [];
  let open = -1;
  for (let p = lo; p <= hi; p++) {
    if (p !== lo && cps[p - 1] !== NL) continue;
    if (p + 2 < hi && cps[p] === BACKTICK && cps[p + 1] === BACKTICK && cps[p + 2] === BACKTICK) {
      let e = p;
      while (e < hi && cps[e] !== NL) e++;
      if (open < 0) open = p;
      else {
        regions.push([open, e]);
        open = -1;
      }
    }
  }
  if (open >= 0) regions.push([open, hi]);
  return regions;
}

/** markdown.rs heading(): ^(#{1,6})\s+(.*)$ on a line without its line end -> [level, title] or null. */
function headingOf(cps, a, b) {
  let n = 0;
  while (a + n < b && cps[a + n] === HASH) n++;
  if (n < 1 || n > 6 || a + n >= b || !isWs(cps[a + n])) return null;
  const [x, y] = trimRange(cps, a + n, b);
  return [n, str(cps, x, y)];
}

/**
 * @typedef {{idx: number, text: string, start: number, end: number, heading: string[]}} Sentence
 */

/**
 * edgextract's sentences, with code-point offsets.
 * @param {string} text  a markdown document
 * @returns {Sentence[]}
 */
export function splitSentences(text) {
  if (typeof text !== 'string') throw new TypeError('splitSentences: text must be a string');
  const cps = codePointsOf(text);
  const n = cps.length;
  const body = frontmatterEnd(text);
  const fences = fenceRegions(cps, body, n);
  const inFence = (p) => fences.some(([s, e]) => s <= p && p < e);
  /** @type {Array<[number, string]>} */
  let stack = [];
  /** @type {Sentence[]} */
  const sentences = [];
  /** @type {Array<[number, number]>} */
  let para = [];

  const flush = () => {
    if (para.length === 0) return;
    const path = stack.map((h) => h[1]);
    /** @type {Array<[number, number]>} */
    const blocks = [];
    para.forEach(([a, b], i) => {
      if (i === 0 || isBlockStart(cps, a, b)) blocks.push([a, b]);
      else blocks[blocks.length - 1][1] = b; // lines are contiguous: extend the unit
    });
    for (const [ba, bb] of blocks) {
      for (const [sa, sb] of sentencesIn(cps, ba, bb)) {
        const [ta, tb] = trimRange(cps, sa, sb);
        if (ta >= tb) continue;
        for (const [a, b] of boundRanges(cps, ta, tb)) {
          sentences.push({ idx: sentences.length, text: str(cps, a, b), start: a, end: b, heading: [...path] });
        }
      }
    }
    para = [];
  };

  let pos = body;
  while (pos < n) {
    let end = pos;
    while (end < n && cps[end] !== NL) end++;
    const lineEnd = end < n ? end + 1 : n; // the line with its '\n'
    const lineStart = pos;
    pos = lineEnd;
    if (inFence(lineStart)) {
      flush();
      continue;
    }
    let stripped = lineEnd; // without trailing '\n' and '\r'
    while (stripped > lineStart && (cps[stripped - 1] === NL || cps[stripped - 1] === CR)) stripped--;
    const h = headingOf(cps, lineStart, stripped);
    if (h) {
      flush();
      stack = stack.filter(([level]) => level < h[0]);
      stack.push(h);
      continue;
    }
    if (blank(cps, lineStart, stripped)) {
      flush();
      continue;
    }
    para.push([lineStart, lineEnd]);
  }
  flush();
  return sentences;
}

/**
 * Upstream's heading context: the path joined with ' > '.
 * @param {{heading: string[]}} sentence
 */
export function headingContext(sentence) {
  return sentence.heading.join(' > ');
}

/**
 * Offsets in one text, converted between Unicode code points (what this module, gliner-rs
 * and the store use), UTF-8 bytes (edgextract's unit) and UTF-16 units (JavaScript's string
 * index). Every conversion takes and returns a boundary; a value inside a character, or out
 * of range, throws RangeError.
 * @param {string} text
 */
export function offsetMap(text) {
  const cpU16 = [0];
  const cpByte = [0];
  for (const ch of text) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    cpU16.push(cpU16[cpU16.length - 1] + ch.length);
    cpByte.push(cpByte[cpByte.length - 1] + utf8Len(cp));
  }
  const inverse = (table) => {
    const m = new Map();
    table.forEach((v, i) => m.set(v, i));
    return m;
  };
  let u16Cp = null;
  let byteCp = null;
  const check = (table, i, what) => {
    if (!Number.isInteger(i) || i < 0 || i >= table.length) throw new RangeError(`${what} ${i} is out of range`);
    return table[i];
  };
  const back = (map, i, what) => {
    const v = map.get(i);
    if (v === undefined) throw new RangeError(`${what} ${i} is not a character boundary`);
    return v;
  };
  return {
    /** Number of code points. */
    length: cpU16.length - 1,
    /** @param {number} cp */
    cpToUtf16: (cp) => check(cpU16, cp, 'code point offset'),
    /** @param {number} cp */
    cpToByte: (cp) => check(cpByte, cp, 'code point offset'),
    /** @param {number} u */
    utf16ToCp: (u) => back(u16Cp ??= inverse(cpU16), u, 'UTF-16 offset'),
    /** @param {number} b */
    byteToCp: (b) => back(byteCp ??= inverse(cpByte), b, 'UTF-8 offset'),
  };
}

/**
 * text's code points [start, end), as a string.
 * @param {string} text @param {number} start @param {number} end
 */
export function sliceCp(text, start, end) {
  const m = offsetMap(text);
  return text.slice(m.cpToUtf16(start), m.cpToUtf16(end));
}

/**
 * Number of UTF-8 bytes in a string (a lone surrogate counts 3, as U+FFFD).
 * @param {string} text
 */
export function utf8Length(text) {
  let n = 0;
  for (const ch of text) n += utf8Len(/** @type {number} */ (ch.codePointAt(0)));
  return n;
}
