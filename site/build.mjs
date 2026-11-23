#!/usr/bin/env node
// @ts-check
/**
 * site/build.mjs: the static site for this repo's browser examples, published on GitHub Pages.
 *
 *   node site/build.mjs                 run each example's `build`, then collect it into site/dist/
 *   node site/build.mjs --no-build      collect each example's existing dist/ only (SITE_PREBUILT=1 does the same)
 *   node site/build.mjs --out <dir>     write the site there instead of site/dist/
 *   node site/build.mjs --root <dir>    look for examples/<name>/site.json under <dir> (tests)
 *
 * The contract a browser example signs up to (site/README.md): an `examples/<name>/site.json`
 *   {title, description, path, build, dist, connect: [origins], requires: [EXAMPLES_REQUIRE keys]}
 * plus two optional fields, `browser` (what a visitor's browser needs, one sentence) and
 * `credits` (third-party software the page ships, one line each), and a `dist` that runs from
 * a sub-path with relative URLs only. GitHub Pages serves a project site from
 * https://<owner>.github.io/<repo>/, so the whole site, and each example under it, runs from a
 * sub-path; and Pages sets no custom response headers, so every page carries its own
 * Content-Security-Policy in a <meta http-equiv> element.
 *
 * Steps, failing (exit 1, every problem on stderr, no site left behind) on any problem:
 *   1. find examples/<name>/site.json (sorted) and validate each strictly; `path` is one URL-safe
 *      segment, unique across examples;
 *   2. unless --no-build / SITE_PREBUILT=1, run each `build` command (shell) in the example's directory;
 *   3. copy <example>/<dist>/ to <out>/<path>/ (regular files only; a symlink is refused); check
 *      that every HTML page carries one <meta http-equiv="Content-Security-Policy"> in its
 *      <head>, before any script, without the directives a meta policy ignores (frame-ancestors,
 *      report-uri, report-to, sandbox), and that its connect-src (else default-src) allows each
 *      of the example's `connect` origins; and scan its HTML, JS and CSS for root-absolute ("/x")
 *      or protocol-relative ("//x") references outside comments: imports, workers, fetch(),
 *      new URL(..., location), src/href/srcset, import maps, CSS url() and @import;
 *   4. write <out>/index.html from site/index.template.html, plus site.css, favicon.svg and an
 *      empty .nojekyll (so Pages publishes the files as they are, with no Jekyll pass).
 * The output depends only on the inputs: examples are sorted by path, files are copied in
 * sorted order, and nothing time- or host-dependent is written.
 *
 * Exports, for tests and for an example's local server: metaCsp, parseCsp, cspAllows,
 * parseOrigin, validateSiteJson, scanText, scanTree, buildSite.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SITE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SITE_DIR);
const TEMPLATE = path.join(SITE_DIR, 'index.template.html');
const STATIC_FILES = ['site.css', 'favicon.svg']; // copied from site/ next to index.html
/** Directives a policy delivered in a <meta> element ignores (CSP3 section 3.3). */
const META_IGNORED = ['frame-ancestors', 'report-uri', 'report-to', 'sandbox'];

const SITE_KEYS = ['title', 'description', 'path', 'build', 'dist', 'connect', 'requires'];
const OPTIONAL_KEYS = ['browser', 'credits'];
const PATH_RE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const REQUIRE_RE = /^[a-z][a-z0-9]{0,31}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

class SiteError extends Error {}

// ---------------------------------------------------------------------------------------------
// Content-Security-Policy: parsing and whether a source list allows an origin (CSP Level 3)
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} policy  one serialized policy
 * @returns {Map<string, string[]>}  directive name (lower case) -> source expressions (first occurrence wins)
 */
export function parseCsp(policy) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = tokens[0].toLowerCase();
    if (!out.has(name)) out.set(name, tokens.slice(1));
  }
  return out;
}

/**
 * The policies a page delivers in <meta http-equiv="Content-Security-Policy" content="...">
 * elements (comments blanked), with where each sits: whether it is inside <head> and before
 * every <script>. Attribute values may use either quote; character references in them are not
 * decoded (a policy needs none).
 * @param {string} html
 * @returns {{policy: string, inHead: boolean, beforeScripts: boolean}[]}
 */
export function metaCsp(html) {
  const src = blankHtmlComments(html);
  const headEnd = (() => { const m = /<\/head\s*>|<body\b/i.exec(src); return m ? m.index : -1; })();
  const firstScript = (() => { const m = /<script\b/i.exec(src); return m ? m.index : Infinity; })();
  const out = [];
  for (const m of src.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = m[1];
    const equiv = /\shttp-equiv\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
    if (!equiv || (equiv[1] ?? equiv[2] ?? equiv[3] ?? '').trim().toLowerCase() !== 'content-security-policy') continue;
    const content = /\scontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
    const at = /** @type {number} */ (m.index);
    out.push({ policy: content ? (content[1] ?? content[2] ?? content[3] ?? '') : '', inHead: headEnd < 0 || at < headEnd, beforeScripts: at < firstScript });
  }
  return out;
}

const DEFAULT_PORT = /** @type {Record<string, number>} */ ({ http: 80, https: 443, ws: 80, wss: 443 });

/**
 * Parse an origin as site.json's `connect` writes it: https:// or wss://, a lower-case host
 * whose first label may be `*` (any subdomain, at any depth), an optional port, nothing else.
 * @param {string} s
 * @returns {{scheme: string, host: string, wildcard: boolean, port: number} | null}
 */
export function parseOrigin(s) {
  const m = /^(https|wss):\/\/(\*\.)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::(\d{1,5}))?$/.exec(s);
  if (!m) return null;
  const port = m[4] === undefined ? DEFAULT_PORT[m[1]] : Number(m[4]);
  if (!(port > 0 && port < 65536)) return null;
  if (m[2] && !m[3].includes('.')) return null; // "*.co" style: too broad to mean anything
  return { scheme: m[1], host: m[3], wildcard: Boolean(m[2]), port };
}

/** CSP3 "scheme-part match": may an expression's scheme load a URL with this scheme? */
function schemeMatches(expr, scheme) {
  if (expr === scheme) return true;
  if (expr === 'http') return scheme === 'https';
  if (expr === 'ws') return ['wss', 'http', 'https'].includes(scheme);
  if (expr === 'wss') return scheme === 'https';
  return false;
}

/**
 * Does a CSP source list allow every URL of `origin` (from parseOrigin)? The site is served
 * over HTTPS, so a scheme-less host-source means https. 'self' never covers an external origin.
 * @param {string[]} sources
 * @param {{scheme: string, host: string, wildcard: boolean, port: number}} origin
 * @returns {string | null}  the expression that allows it, or null
 */
export function cspAllows(sources, origin) {
  for (const src of sources) {
    const s = src.toLowerCase();
    if (s === '*') {
      if (['http', 'https', 'ws', 'wss'].includes(origin.scheme)) return src;
      continue;
    }
    if (s.startsWith("'")) continue; // 'self', 'none', nonces, hashes, keywords
    const scheme = /^([a-z][a-z0-9+.-]*):$/.exec(s);
    if (scheme) {
      if (schemeMatches(scheme[1], origin.scheme)) return src;
      continue;
    }
    const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|\*\.[^:/]+|[^:/*]+)(?::(\d+|\*))?(\/.*)?$/.exec(s);
    if (!m) continue;
    const [, eScheme, eHost, ePort, ePath] = m;
    if (eScheme ? !schemeMatches(eScheme, origin.scheme) : origin.scheme !== 'https') continue;
    if (ePath && ePath !== '/') continue; // a path-restricted source does not allow a whole origin
    let hostOk;
    if (eHost === '*') hostOk = true;
    else if (eHost.startsWith('*.')) {
      const suffix = eHost.slice(1); // ".hf.co"
      hostOk = origin.host.endsWith(suffix) || (origin.wildcard && origin.host === eHost.slice(2));
    } else hostOk = !origin.wildcard && origin.host === eHost;
    if (!hostOk) continue;
    if (ePort === '*') return src;
    const want = ePort === undefined ? DEFAULT_PORT[eScheme ?? 'https'] : Number(ePort);
    if (origin.port === want) return src;
    if (ePort === undefined && eScheme === 'http' && origin.port === 443) return src; // http: upgrades to https
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// site.json
// ---------------------------------------------------------------------------------------------

/**
 * Validate one parsed site.json. Returns a list of problems (empty when valid).
 * @param {any} j
 * @returns {string[]}
 */
export function validateSiteJson(j) {
  const p = [];
  if (!j || typeof j !== 'object' || Array.isArray(j)) return ['must be a JSON object'];
  for (const k of Object.keys(j)) {
    if (!SITE_KEYS.includes(k) && !OPTIONAL_KEYS.includes(k)) p.push(`unknown field "${k}" (allowed: ${[...SITE_KEYS, ...OPTIONAL_KEYS].join(', ')})`);
  }
  for (const k of SITE_KEYS) if (!(k in j)) p.push(`missing field "${k}"`);
  const text = (k, max) => {
    if (!(k in j)) return;
    const v = j[k];
    if (typeof v !== 'string' || v.trim() === '') p.push(`"${k}" must be a non-empty string`);
    else if (v !== v.trim()) p.push(`"${k}" has leading or trailing space`);
    else if (v.length > max) p.push(`"${k}" is longer than ${max} characters`);
    else if (CONTROL_RE.test(v)) p.push(`"${k}" contains a control character`);
  };
  text('title', 120);
  text('description', 800);
  text('build', 500);
  if ('browser' in j) text('browser', 400);
  if ('path' in j) {
    if (typeof j.path !== 'string' || !PATH_RE.test(j.path)) {
      p.push(`"path" must be one URL segment of 1-63 characters from [a-z0-9-], not starting with "-" (got ${JSON.stringify(j.path)})`);
    }
  }
  if ('dist' in j) {
    const d = j.dist;
    if (typeof d !== 'string' || d === '' || path.posix.isAbsolute(d) || path.win32.isAbsolute(d) || d.includes('\\')
        || d.split('/').some((s) => s === '..' || s === '' || s === '.') || CONTROL_RE.test(d)) {
      p.push(`"dist" must be a relative path inside the example, without "..", "." or empty segments (got ${JSON.stringify(d)})`);
    }
  }
  if ('connect' in j) {
    if (!Array.isArray(j.connect)) p.push('"connect" must be an array of origins');
    else {
      const seen = new Set();
      for (const o of j.connect) {
        if (typeof o !== 'string' || !parseOrigin(o)) {
          p.push(`"connect" entry ${JSON.stringify(o)} is not an origin like "https://host", "https://*.host" or "https://host:8443" (https or wss, lower case, no path)`);
        } else if (seen.has(o)) p.push(`"connect" lists ${o} twice`);
        seen.add(o);
      }
    }
  }
  if ('requires' in j) {
    if (!Array.isArray(j.requires)) p.push('"requires" must be an array of EXAMPLES_REQUIRE keys');
    else {
      const seen = new Set();
      for (const r of j.requires) {
        if (typeof r !== 'string' || !REQUIRE_RE.test(r)) p.push(`"requires" entry ${JSON.stringify(r)} is not an EXAMPLES_REQUIRE key ([a-z][a-z0-9]*)`);
        else if (seen.has(r)) p.push(`"requires" lists ${r} twice`);
        seen.add(r);
      }
    }
  }
  if ('credits' in j) {
    if (!Array.isArray(j.credits) || j.credits.length === 0) p.push('"credits" must be a non-empty array of strings when present');
    else {
      for (const c of j.credits) {
        if (typeof c !== 'string' || c.trim() === '' || c !== c.trim() || c.length > 300 || CONTROL_RE.test(c)) {
          p.push(`"credits" entry ${JSON.stringify(c)} must be a trimmed, non-empty string of at most 300 characters`);
        }
      }
    }
  }
  return p;
}

/**
 * Find and validate every examples/<name>/site.json under root, sorted by `path`.
 * @param {string} root
 * @returns {{examples: {name: string, dir: string, rel: string, site: any}[], problems: string[]}}
 */
function findExamples(root) {
  const exRoot = path.join(root, 'examples');
  const problems = [];
  const examples = [];
  let names = [];
  try {
    names = fs.readdirSync(exRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return { examples, problems: [`no examples/ directory under ${root}`] };
  }
  for (const name of names) {
    const file = path.join(exRoot, name, 'site.json');
    if (!fs.existsSync(file)) continue;
    const rel = `examples/${name}/site.json`;
    let site;
    try {
      site = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      problems.push(`${rel}: not valid JSON (${e instanceof Error ? e.message : e})`);
      continue;
    }
    const p = validateSiteJson(site);
    if (p.length) {
      for (const x of p) problems.push(`${rel}: ${x}`);
      continue;
    }
    examples.push({ name, dir: path.join(exRoot, name), rel, site });
  }
  const byPath = new Map();
  for (const ex of examples) {
    const other = byPath.get(ex.site.path);
    if (other) problems.push(`${ex.rel}: "path" ${ex.site.path} is already used by ${other.rel}`);
    else byPath.set(ex.site.path, ex);
  }
  examples.sort((a, b) => (a.site.path < b.site.path ? -1 : a.site.path > b.site.path ? 1 : 0));
  return { examples, problems };
}

/**
 * Check one HTML page's meta Content-Security-Policy, and the example's `connect` origins against it.
 * @param {string} html
 * @param {string} where  the page, for messages
 * @param {{rel: string, site: any}} ex
 * @returns {string[]} problems
 */
function checkPageCsp(html, where, ex) {
  const metas = metaCsp(html);
  if (metas.length === 0) {
    return [`${where}: no <meta http-equiv="Content-Security-Policy"> (GitHub Pages sets no headers, so each page carries its own policy)`];
  }
  if (metas.length > 1) return [`${where}: ${metas.length} Content-Security-Policy <meta> elements; use one`];
  const [{ policy, inHead, beforeScripts }] = metas;
  const problems = [];
  if (!inHead) problems.push(`${where}: the Content-Security-Policy <meta> must be inside <head>`);
  if (!beforeScripts) problems.push(`${where}: the Content-Security-Policy <meta> must come before every <script>`);
  const directives = parseCsp(policy);
  if (directives.size === 0) problems.push(`${where}: an empty Content-Security-Policy`);
  for (const d of META_IGNORED) {
    if (directives.has(d)) problems.push(`${where}: "${d}" is ignored in a <meta> policy; leave it out`);
  }
  const name = directives.has('connect-src') ? 'connect-src' : directives.has('default-src') ? 'default-src' : null;
  if (!name) return problems; // neither connect-src nor default-src: the CSP does not restrict connections
  const sources = /** @type {string[]} */ (directives.get(name));
  for (const o of ex.site.connect) {
    const origin = /** @type {NonNullable<ReturnType<typeof parseOrigin>>} */ (parseOrigin(o));
    if (!cspAllows(sources, origin)) {
      problems.push(`${ex.rel}: connect origin ${o} is not allowed by the ${name} of ${where} (${sources.join(' ')}); `
        + 'add it to the page\'s Content-Security-Policy <meta>');
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Relative-URL scan: root-absolute ("/x") or protocol-relative ("//x") references in a dist
// ---------------------------------------------------------------------------------------------

/**
 * Blank out JS comments (keeping newlines, so offsets and line numbers hold). Strings,
 * template literals and regex literals are skipped by the usual heuristic: a "/" starts a
 * regex where an expression may start.
 * @param {string} src
 */
export function blankJsComments(src) {
  const out = src.split('');
  let i = 0;
  let prev = ''; // last significant character outside comments
  const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let stop = src.indexOf('\n', i);
      if (stop < 0) stop = n;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c !== '`' && src[j] === '\n') break; // an unterminated quote ends at the line
        j++;
      }
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || /\b(?:return|typeof|case|do|else|in|of|void|yield|await)$/.test(src.slice(Math.max(0, i - 8), i).trimEnd()))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      i = j + 1;
      prev = '/';
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}

/** @param {string} src */
function blankCssComments(src) {
  return src.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** @param {string} src */
function blankHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => m.replace(/[^\n]/g, ' '));
}

const Q = `(['"\`])`; // an opening quote, matched again by \\1 at the end of the string
const JS_RULES = [
  ['import()', new RegExp(`\\bimport\\s*\\(\\s*${Q}(\\/[^'"\`]*)\\1`, 'g')],
  ['import ... from', new RegExp(`\\b(?:import|export)\\b[^'"\`;]*?\\bfrom\\s*${Q}(\\/[^'"\`]*)\\1`, 'g')],
  ['import', new RegExp(`\\bimport\\s*${Q}(\\/[^'"\`]*)\\1`, 'g')],
  ['importScripts()', new RegExp(`\\bimportScripts\\s*\\(\\s*${Q}(\\/[^'"\`]*)\\1`, 'g')],
  ['new Worker()', new RegExp(`\\bnew\\s+(?:Shared)?Worker\\s*\\(\\s*${Q}(\\/[^'"\`]*)\\1`, 'g')],
  ['fetch()', new RegExp(`\\bfetch\\s*\\(\\s*${Q}(\\/[^'"\`]*)\\1`, 'g')],
  ['register()', new RegExp(`\\.register\\s*\\(\\s*${Q}(\\/[^'"\`]*)\\1`, 'g')],
  // new URL("/x", base) is root-absolute only against this site: flag it when the base is the
  // page or module (import.meta.url, location, document.baseURI); an absolute base is fine.
  ['new URL()', new RegExp(`\\bnew\\s+URL\\s*\\(\\s*${Q}(\\/[^'"\`]*)\\1\\s*(?:\\)|,\\s*(?:import\\.meta\\.url|(?:self\\.|window\\.|globalThis\\.)?location\\b|document\\.(?:baseURI|URL)\\b))`, 'g')],
];
const CSS_RULES = [
  ['url()', /\burl\(\s*(['"]?)(\/[^'")\s]*)\1\s*\)/g],
  ['@import', /@import\s+(['"])(\/[^'"]*)\1/g],
];
const ATTR_RE = /\s(src|href|action|formaction|poster|data|manifest|background)\s*=\s*(?:"\s*([^"]*)"|'\s*([^']*)'|([^\s"'>]+))/gi;
const SRCSET_RE = /\s(srcset|imagesrcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const REFRESH_RE = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*content\s*=\s*["'][^"']*url\s*=\s*(\/[^"'\s]*)/gi;

/** @param {string} u */
function kindOf(u) {
  return u.startsWith('//') ? 'protocol-relative' : 'root-absolute';
}

/**
 * @param {string} text
 * @param {number} index
 */
function lineAt(text, index) {
  let line = 1;
  for (let k = 0; k < index; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

/**
 * Scan one file's text for references that are not relative.
 * @param {string} text
 * @param {'html'|'js'|'css'} type
 * @param {number} [lineOffset]  added to reported lines (for inline blocks)
 * @returns {{line: number, url: string, what: string, kind: string}[]}
 */
export function scanText(text, type, lineOffset = 0) {
  /** @type {{line: number, url: string, what: string, kind: string, at: number}[]} */
  const hits = [];
  const add = (src, at, url, what) => {
    const u = url.trim();
    if (!u.startsWith('/')) return;
    hits.push({ at, line: lineAt(src, at) + lineOffset, url: u, what, kind: kindOf(u) });
  };
  if (type === 'js') {
    const src = blankJsComments(text);
    for (const [what, re] of JS_RULES) for (const m of src.matchAll(/** @type {RegExp} */ (re))) add(src, /** @type {number} */ (m.index), m[2], what);
  } else if (type === 'css') {
    const src = blankCssComments(text);
    for (const [what, re] of CSS_RULES) for (const m of src.matchAll(/** @type {RegExp} */ (re))) add(src, /** @type {number} */ (m.index), m[2], what);
  } else {
    let src = blankHtmlComments(text);
    // Inline <script> and <style> bodies are scanned with their own rules, then blanked.
    src = src.replace(/(<script\b([^>]*)>)([\s\S]*?)(<\/script\s*>)/gi, (whole, open, attrs, body, close, offset) => {
      const startLine = lineAt(src, offset + open.length) - 1;
      if (/\btype\s*=\s*["']?importmap/i.test(attrs)) {
        let map = null;
        try { map = JSON.parse(body); } catch { hits.push({ at: offset, line: startLine + 1 + lineOffset, url: '(unparsable import map)', what: 'importmap', kind: 'invalid' }); }
        if (map && typeof map === 'object') {
          const walk = (v) => {
            if (typeof v === 'string') { if (v.startsWith('/')) hits.push({ at: offset, line: startLine + 1 + lineOffset, url: v, what: 'importmap', kind: kindOf(v) }); }
            else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k.startsWith('/')) hits.push({ at: offset, line: startLine + 1 + lineOffset, url: k, what: 'importmap key', kind: kindOf(k) }); walk(x); }
          };
          walk(map);
        }
      } else if (!/\btype\s*=\s*["']?(?:text\/(?:template|html|plain)|application\/(?:ld\+)?json)/i.test(attrs)) {
        for (const h of scanText(body, 'js', startLine + lineOffset)) hits.push({ ...h, at: offset });
      }
      return open + body.replace(/[^\n]/g, ' ') + close;
    });
    src = src.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (whole, open, body, close, offset) => {
      const startLine = lineAt(src, offset + open.length) - 1;
      for (const h of scanText(body, 'css', startLine + lineOffset)) hits.push({ ...h, at: offset });
      return open + body.replace(/[^\n]/g, ' ') + close;
    });
    for (const m of src.matchAll(ATTR_RE)) add(src, /** @type {number} */ (m.index), m[2] ?? m[3] ?? m[4] ?? '', `${m[1].toLowerCase()}=`);
    for (const m of src.matchAll(SRCSET_RE)) {
      for (const cand of (m[2] ?? m[3] ?? '').split(',')) add(src, /** @type {number} */ (m.index), cand.trim().split(/\s+/)[0] ?? '', `${m[1].toLowerCase()}=`);
    }
    for (const m of src.matchAll(REFRESH_RE)) add(src, /** @type {number} */ (m.index), m[1], 'meta refresh');
    for (const m of src.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      for (const h of scanText(m[1] ?? m[2] ?? '', 'css', lineAt(src, /** @type {number} */ (m.index)) - 1 + lineOffset)) hits.push({ ...h, at: /** @type {number} */ (m.index) });
    }
  }
  hits.sort((a, b) => a.line - b.line || a.at - b.at || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return hits.map(({ line, url, what, kind }) => ({ line, url, what, kind }));
}

const SCAN_TYPES = /** @type {Record<string, 'html'|'js'|'css'>} */ ({ '.html': 'html', '.htm': 'html', '.js': 'js', '.mjs': 'js', '.css': 'css' });

/**
 * List a directory's regular files, recursively, sorted (POSIX relative paths). Throws on a
 * symlink or any other non-regular entry.
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    const entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new SiteError(`${path.join(dir, r)} is a symlink; a dist must hold regular files only`);
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) { if (e.name !== '.DS_Store') out.push(r); }
      else throw new SiteError(`${path.join(dir, r)} is not a regular file`);
    }
  };
  walk('');
  return out;
}

/**
 * Scan a directory tree's HTML, JS and CSS files for references that are not relative.
 * @param {string} dir
 * @returns {{file: string, line: number, url: string, what: string, kind: string}[]}
 */
export function scanTree(dir) {
  const hits = [];
  for (const rel of listFiles(dir)) {
    const type = SCAN_TYPES[path.extname(rel).toLowerCase()];
    if (!type) continue;
    for (const h of scanText(fs.readFileSync(path.join(dir, rel), 'utf8'), type)) hits.push({ file: rel, ...h });
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
// The index page
// ---------------------------------------------------------------------------------------------

/** A path for log lines: relative to the working directory when inside it. */
function show(p) {
  const r = path.relative(process.cwd(), p);
  return r === '' ? '.' : r.startsWith('..') || path.isAbsolute(r) ? p : r;
}

/** @param {string} s */
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * @param {string} template
 * @param {{site: any}[]} examples  sorted
 */
function renderIndex(template, examples) {
  const marker = '{{EXAMPLES}}';
  const count = template.split(marker).length - 1;
  if (count !== 1) throw new SiteError(`${TEMPLATE}: must contain ${marker} exactly once (found ${count})`);
  const items = examples.map(({ site }) => {
    const hosts = site.connect.map((o) => o.replace(/^https:\/\//, ''));
    const net = hosts.length
      ? `Besides this site, the page connects only to ${hosts.map((h) => `<code>${esc(h)}</code>`).join(', ')}.`
      : 'The page connects to this site only.';
    const lines = [
      '      <li class="example">',
      `        <h2><a href="${esc(site.path)}/">${esc(site.title)}</a></h2>`,
      `        <p>${esc(site.description)}</p>`,
      `        <p class="needs">${site.browser ? `${esc(site.browser)} ` : ''}${net}</p>`,
    ];
    if (site.credits) {
      lines.push('        <details class="credits">', '          <summary>Third-party software and models</summary>', '          <ul>');
      for (const c of site.credits) lines.push(`            <li>${esc(c)}</li>`);
      lines.push('          </ul>', '        </details>');
    }
    lines.push('      </li>');
    return lines.join('\n');
  });
  const html = template.replace(marker, items.join('\n'));
  const left = /\{\{[A-Z_]+\}\}/.exec(html);
  if (left) throw new SiteError(`${TEMPLATE}: unknown placeholder ${left[0]}`);
  return html;
}

// ---------------------------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------------------------

/**
 * Refuse an output directory whose removal would take something else with it.
 * @param {string} out
 * @param {string} root
 */
function checkOut(out, root) {
  const inside = (child, parent) => {
    const r = path.relative(parent, child);
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  };
  for (const keep of [root, SITE_DIR, path.join(root, 'examples'), os.homedir(), path.parse(out).root]) {
    if (inside(keep, out)) throw new SiteError(`refusing to use ${out} as the output directory: it contains ${keep}`);
  }
  if (inside(out, path.join(root, 'examples'))) throw new SiteError(`refusing to write the site inside ${path.join(root, 'examples')}`);
}

/**
 * Build the site. Throws SiteError with every problem found; leaves no output on failure.
 * @param {{root?: string, out?: string, build?: boolean, log?: (s: string) => void}} [opts]
 * @returns {{out: string, examples: {path: string, files: number, bytes: number}[]}}
 */
export function buildSite(opts = {}) {
  const root = path.resolve(opts.root ?? REPO_ROOT);
  const out = path.resolve(opts.out ?? path.join(SITE_DIR, 'dist'));
  const doBuild = opts.build ?? true;
  const log = opts.log ?? ((s) => process.stderr.write(`site/build.mjs: ${s}\n`));
  checkOut(out, root);
  try {
    return build(root, out, doBuild, log);
  } catch (e) {
    fs.rmSync(out, { recursive: true, force: true }); // no stale or partial site survives a failure
    throw e;
  }
}

/**
 * @param {string} root
 * @param {string} out
 * @param {boolean} doBuild
 * @param {(s: string) => void} log
 */
function build(root, out, doBuild, log) {
  const { examples, problems } = findExamples(root);
  if (!problems.length && examples.length === 0) problems.push(`no examples/*/site.json under ${root}: nothing to publish`);
  if (problems.length) throw new SiteError(problems.join('\n'));

  if (doBuild) {
    for (const ex of examples) {
      log(`building ${ex.site.path}: (cd examples/${ex.name} && ${ex.site.build})`);
      const r = spawnSync(ex.site.build, { cwd: ex.dir, shell: true, stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
      if (r.error) throw new SiteError(`examples/${ex.name}: cannot run "${ex.site.build}": ${r.error.message}`);
      if (r.status !== 0) throw new SiteError(`examples/${ex.name}: "${ex.site.build}" exited ${r.status ?? r.signal}`);
    }
  }

  const template = fs.readFileSync(TEMPLATE, 'utf8');
  fs.rmSync(out, { recursive: true, force: true });
  const summary = [];
  fs.mkdirSync(out, { recursive: true });
  for (const ex of examples) {
    const src = path.join(ex.dir, ex.site.dist);
    const relSrc = `examples/${ex.name}/${ex.site.dist}`;
    if (!fs.statSync(src, { throwIfNoEntry: false })?.isDirectory()) {
      problems.push(`${relSrc} does not exist: ${doBuild ? `"${ex.site.build}" did not write it` : `run "${ex.site.build}" in examples/${ex.name} first, or drop --no-build / SITE_PREBUILT`}`);
      continue;
    }
    let files;
    try {
      files = listFiles(src);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    if (!files.includes('index.html')) problems.push(`${relSrc}/index.html is missing: a dist is served from <site>/${ex.site.path}/`);
    for (const rel of files) {
      if (SCAN_TYPES[path.extname(rel).toLowerCase()] === 'html') {
        problems.push(...checkPageCsp(fs.readFileSync(path.join(src, ...rel.split('/')), 'utf8'), `${relSrc}/${rel}`, ex));
      }
    }
    for (const h of scanTree(src)) {
      problems.push(`${relSrc}/${h.file}:${h.line}: ${h.kind} URL ${JSON.stringify(h.url)} (${h.what}); `
        + `a dist must use relative URLs so it runs at <site>/${ex.site.path}/`);
    }
    let bytes = 0;
    for (const rel of files) {
      const dest = path.join(out, ex.site.path, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(src, ...rel.split('/')), dest);
      bytes += fs.statSync(dest).size;
    }
    summary.push({ path: ex.site.path, files: files.length, bytes });
    log(`collected ${relSrc} -> ${show(path.join(out, ex.site.path))}/ `
      + `(${files.length} file${files.length === 1 ? '' : 's'}, ${(bytes / 1e6).toFixed(1)} MB; requires ${ex.site.requires.join(',') || 'nothing'})`);
  }
  if (problems.length) throw new SiteError(problems.join('\n'));
  fs.writeFileSync(path.join(out, 'index.html'), renderIndex(template, examples));
  for (const f of STATIC_FILES) fs.copyFileSync(path.join(SITE_DIR, f), path.join(out, f));
  fs.writeFileSync(path.join(out, '.nojekyll'), ''); // Pages: publish the files as they are, no Jekyll
  log(`wrote ${show(out)}/ (${examples.length} example${examples.length === 1 ? '' : 's'})`);
  return { out, examples: summary };
}

function usage() {
  return [
    'usage: node site/build.mjs [--no-build] [--out <dir>] [--root <dir>]',
    '  --no-build    collect each example\'s existing dist/ (also when SITE_PREBUILT=1)',
    '  --out <dir>   output directory (default site/dist)',
    '  --root <dir>  directory holding examples/ (default: the repo)',
  ].join('\n');
}

function main(argv) {
  const opts = { build: !['1', 'true', 'yes'].includes(String(process.env.SITE_PREBUILT ?? '').toLowerCase()) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-build') opts.build = false;
    else if (a === '--out' || a === '--root') {
      const v = argv[++i];
      if (!v) { console.error(`site/build.mjs: ${a} needs a directory\n${usage()}`); return 2; }
      opts[a.slice(2)] = v;
    } else if (a === '-h' || a === '--help') { console.log(usage()); return 0; }
    else { console.error(`site/build.mjs: unknown argument ${a}\n${usage()}`); return 2; }
  }
  try {
    buildSite(opts);
    return 0;
  } catch (e) {
    if (!(e instanceof SiteError)) throw e;
    for (const line of e.message.split('\n')) console.error(`site/build.mjs: ${line}`);
    console.error('site/build.mjs: FAILED; no site was written');
    return 1;
  }
}

/** Is this module the entry point? (Node gives an ESM entry its real path.) */
function isMain() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
