#!/usr/bin/env node
// @ts-check
/**
 * lib/serve.mjs: a local static server that serves an example's dist/ as GitHub Pages serves this
 * project site (site/README.md, "What GitHub Pages does and does not do"). Shared by the browser
 * examples: example 01's harness/serve.mjs uses it for its --site mode, example 02's run.sh and
 * harness/drive.mjs use it directly.
 *
 *   node lib/serve.mjs --example 02-wasm-text2cypher [--dist <dir>] [--port N] [--host H] [--verbose]
 *
 * The example is served under the repository's sub-path, at <PAGES_BASE><site.json path>/
 * (/relate-examples/02-wasm-text2cypher/; PAGES_BASE overrides the base), with no custom response
 * headers (each page's Content-Security-Policy is its own <meta>), Pages' 10-minute Cache-Control
 * on every file, a 301 from a directory URL without its trailing slash to the one with it, a 404
 * for anything else that is not a file, and a small index at the base. Only the MIME types a static
 * host sends (.wasm as application/wasm, .js as text/javascript); no CSP, COOP or COEP header.
 *
 * start() is the same server for scripts: {url, base, server, close}. `routes` adds extra
 * prefix -> directory mappings under the example (example 01's /models/ for local weights).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MIME = Object.freeze(/** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
}));
export const mime = (/** @type {string} */ p) => MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';

/** The project site's sub-path on GitHub Pages: https://<owner>.github.io/relate-examples/. */
export function pagesBase(env = process.env.PAGES_BASE) {
  const base = env ?? '/relate-examples/';
  if (!/^\/(?:[A-Za-z0-9._-]+\/)*$/.test(base)) throw new Error(`PAGES_BASE ${JSON.stringify(base)} must start and end with "/"`);
  return base;
}

/**
 * @param {{example: string, dist?: string, port?: number, host?: string, base?: string,
 *   routes?: Record<string, string>, log?: (s: string) => void}} opts
 *   example: the directory name under examples/; dist defaults to its dist/
 * @returns {Promise<{url: string, base: string, server: http.Server, close: () => Promise<void>}>}
 */
export async function start({ example, dist, port = 0, host = '127.0.0.1', base = pagesBase(), routes = {}, log = () => {} }) {
  const exDir = path.join(ROOT, 'examples', example);
  const site = JSON.parse(fs.readFileSync(path.join(exDir, 'site.json'), 'utf8'));
  const root = path.resolve(dist ?? path.join(exDir, 'dist'));
  if (!fs.existsSync(path.join(root, 'index.html'))) throw new Error(`serve.mjs: no ${path.relative(process.cwd(), root) || root}/index.html: build the example first`);
  const prefix = `${base}${site.path}/`;

  /** @param {http.ServerResponse} res @param {number} status @param {Record<string, string|number>} [extra] */
  const head = (res, status, extra = {}) => res.writeHead(status, { 'Cache-Control': 'max-age=600', ...extra });
  /** @param {http.ServerResponse} res @param {number} status @param {string} text */
  const plain = (res, status, text) => {
    head(res, status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };
  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} dir @param {string} relPath */
  const sendFile = (req, res, dir, relPath) => {
    const file = path.resolve(dir, relPath);
    if (file !== dir && !file.startsWith(dir + path.sep)) return plain(res, 403, 'forbidden');
    let st;
    try { st = fs.statSync(file); } catch { return plain(res, 404, 'not found'); }
    if (!st.isFile()) return plain(res, 404, 'not found');
    head(res, 200, { 'Content-Type': mime(file), 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  };

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      return plain(res, 400, 'bad request');
    }
    log(`${req.method} ${pathname}`);
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'method not allowed');
    if (pathname.split('/').includes('..') || pathname.includes('\0')) return plain(res, 400, 'bad path');
    if (pathname === base) {
      const html = `<!doctype html><meta charset="utf-8"><title>Browser examples (local)</title>\n<p><a href="${site.path}/">${site.title}</a></p>\n`;
      head(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    // Pages: a directory URL without its trailing slash answers 301 to the one with it.
    if (pathname === base.slice(0, -1) || pathname === prefix.slice(0, -1)) {
      head(res, 301, { Location: `${pathname}/` });
      return res.end();
    }
    if (!pathname.startsWith(prefix)) return plain(res, 404, 'not found');
    const inner = pathname.slice(prefix.length);
    for (const [route, dir] of Object.entries(routes)) {
      if (inner.startsWith(route)) return sendFile(req, res, path.resolve(dir), inner.slice(route.length));
    }
    const target = path.resolve(root, inner);
    if (inner !== '' && !inner.endsWith('/') && (target === root || target.startsWith(root + path.sep))
        && fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
      head(res, 301, { Location: `${pathname}/` });
      return res.end();
    }
    return sendFile(req, res, root, inner === '' || inner.endsWith('/') ? `${inner}index.html` : inner);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${addr.port}`;
  return {
    url,
    base: `${url}${prefix}`,
    server,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

const USAGE = 'usage: node lib/serve.mjs --example <name> [--dist DIR] [--port N] [--host H] [--verbose]';

/** @param {string[]} argv */
async function main(argv) {
  /** @type {any} */
  const opts = { port: 8702, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--example') opts.example = argv[++i];
    else if (a === '--dist') opts.dist = path.resolve(argv[++i]);
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--verbose') opts.log = (/** @type {string} */ s) => process.stderr.write(`serve.mjs: ${s}\n`);
    else { console.error(`serve.mjs: unknown argument ${a}\n${USAGE}`); return 2; }
  }
  if (!opts.example || !Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) { console.error(USAGE); return 2; }
  let s;
  try { s = await start(opts); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); return 1; }
  console.log(`serving ${opts.example}'s dist/ at ${s.base} as GitHub Pages would. Ctrl-C stops it.`);
  const stop = () => s.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const rc = await main(process.argv.slice(2));
  if (rc !== null) process.exitCode = rc;
}
