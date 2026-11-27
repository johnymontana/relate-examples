// @ts-check
/**
 * markdown.js: the little markdown the About drawer shows (a solution package's human_description.md
 * and NOTICE.md), read into a tree of blocks the page turns into elements with textContent only: no HTML
 * from the text ever reaches the page (the CSP allows no inline script, and this keeps it so). Pure,
 * for the page and the Node harness.
 *
 *   markdownBlocks(text) -> [{type: 'heading', level, inline} | {type: 'paragraph', inline} | {type: 'list', ordered, items: [inline]}
 *                            | {type: 'table', head: [inline], rows: [[inline]]} | {type: 'code', text} | {type: 'quote', inline} | {type: 'rule'}]
 *   inline: [{type: 'text'|'strong'|'em'|'code', text} | {type: 'link', text, href}]
 *
 * What it reads: ATX headings (#…######), paragraphs, `-`/`*`/`+` and `1.` lists (one level; a
 * continuation line joins its item), pipe tables with a delimiter row, fenced code, `>` quotes, `---`
 * rules; inline **strong**, *em* and _em_, `code` and [links](url). Anything else is text.
 */

/** @typedef {{type: 'text'|'strong'|'em'|'code', text: string} | {type: 'link', text: string, href: string}} Inline */

/**
 * Inline spans of one line or paragraph.
 * @param {string} s
 * @returns {Inline[]}
 */
export function inlineSpans(s) {
  /** @type {Inline[]} */
  const out = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|(?<![\p{L}\p{N}])_([^_\s][^_]*)_(?![\p{L}\p{N}])|\[([^\]]+)\]\(([^)\s]+)\)/gu;
  let at = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > at) out.push({ type: 'text', text: s.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ type: 'code', text: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ type: 'strong', text: m[2] ?? m[3] });
    else if (m[4] !== undefined || m[5] !== undefined) out.push({ type: 'em', text: m[4] ?? m[5] });
    else out.push({ type: 'link', text: m[6], href: m[7] });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ type: 'text', text: s.slice(at) });
  return out;
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/**
 * A markdown text as blocks (see the header).
 * @param {string} text
 */
export function markdownBlocks(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  /** @type {any[]} */
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push({ type: 'paragraph', inline: inlineSpans(para.join(' ')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const body = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      out.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const hm = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (hm) { flush(); out.push({ type: 'heading', level: hm[1].length, inline: inlineSpans(hm[2]) }); continue; }
    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) { flush(); out.push({ type: 'rule' }); continue; }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      flush();
      const head = cells(line).map(inlineSpans);
      const rows = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cells(lines[i]).map(inlineSpans));
      i--;
      out.push({ type: 'table', head, rows });
      continue;
    }
    const lm = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (lm) {
      flush();
      const ordered = lm[2] !== undefined;
      const items = [lm[3]];
      for (i++; i < lines.length; i++) {
        const n = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(lines[i]);
        if (n && (n[2] !== undefined) === ordered) items.push(n[3]);
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i])) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
      }
      i--;
      out.push({ type: 'list', ordered, items: items.map(inlineSpans) });
      continue;
    }
    const qm = /^\s*>\s?(.*)$/.exec(line);
    if (qm) { flush(); out.push({ type: 'quote', inline: inlineSpans(qm[1]) }); continue; }
    para.push(line.trim());
  }
  flush();
  return out;
}
