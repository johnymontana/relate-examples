#!/usr/bin/env node
// @ts-check
/**
 * harness/serve.mjs: a local static server for example 01.
 *
 *   node harness/serve.mjs --dev  [--port N] [--host H]
 *       The page from its sources, at /: the same URL layout dist/ has (build.mjs plan()), read
 *       from web/, lib/, node_modules and the caches on every request, with the imports rewritten
 *       as build.mjs rewrites them. /models/ serves .cache/gliner/ (GLINER_CACHE_DIR), so
 *       http://127.0.0.1:PORT/?models=local loads the weights without the Hugging Face Hub.
 *   node harness/serve.mjs --site [--dist <dir>] [--port N] [--host H] [--local-models]
 *       dist/ (npm run build) as GitHub Pages serves this project site: under the repository's
 *       sub-path, at <PAGES_BASE><site.json path>/ (/relate-examples/01-wasm-extract/; EX01_PAGES_BASE
 *       overrides the base), with no custom response headers (the Content-Security-Policy is the
 *       page's own <meta>), Pages' 10-minute Cache-Control on every file, a 301 from a directory
 *       URL without its trailing slash to the one with it, a 404 for anything else that is not a
 *       file, and a small index at the base. --local-models also serves .cache/gliner/ at
 *       <base><path>/models/ (not in production: there the page fetches from the Hub).
 *
 * Neither mode sends a CSP, COOP or COEP header (nothing needs SharedArrayBuffer), only the MIME
 * types a static host sends (.wasm as application/wasm, .js as text/javascript). The server runs
 * in the foreground and prints its URL; --port 0 picks a free port. start() is the same server for
 * scripts (harness/drive.mjs): it resolves to {url, base, server, close}.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contents, inputDirs, plan, verifyInputs } from '../build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EX = path.resolve(HERE, '..');

const MIME = /** @type {Record<string, string>} */ ({
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
});
const mime = (/** @type {string} */ p) => MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
/** The project site's sub-path on GitHub Pages: https://<owner>.github.io/relate-examples/. */
export const PAGES_BASE = process.env.EX01_PAGES_BASE ?? '/relate-examples/';
if (!/^\/(?:[A-Za-z0-9._-]+\/)*$/.test(PAGES_BASE)) throw new Error(`EX01_PAGES_BASE ${JSON.stringify(PAGES_BASE)} must start and end with "/"`);

/**
 * @param {{mode: 'dev'|'site', port?: number, host?: string, dist?: string, localModels?: boolean,
 *   log?: (s: string) => void}} opts
 * @returns {Promise<{url: string, base: string, server: http.Server, close: () => Promise<void>}>}
 */
export async function start({ mode, port = 0, host = '127.0.0.1', dist = path.join(EX, 'dist'), localModels = mode === 'dev', log = () => {} }) {
  const site = JSON.parse(fs.readFileSync(path.join(EX, 'site.json'), 'utf8'));
  const prefix = mode === 'site' ? `${PAGES_BASE}${site.path}/` : '/';
  const modelsDir = inputDirs().models;
  if (mode === 'dev') {
    const problems = await verifyInputs();
    if (problems.length) throw new Error(`serve.mjs --dev: the page's inputs are not ready:\n  ${problems.join('\n  ')}`);
  } else if (!fs.existsSync(path.join(dist, 'index.html'))) {
    throw new Error(`serve.mjs --site: no ${path.relative(process.cwd(), dist) || dist}/index.html: run npm run build first`);
  }

  /** Only what a static host sends: GitHub Pages caches every file for 10 minutes, the dev server never. */
  /** @param {http.ServerResponse} res @param {string} _pathname @param {number} status @param {Record<string, string|number>} [extra] */
  const head = (res, _pathname, status, extra = {}) => {
    res.writeHead(status, { 'Cache-Control': mode === 'dev' ? 'no-store' : 'max-age=600', ...extra });
  };
  /** @param {http.ServerResponse} res @param {string} pathname @param {number} status @param {string} text */
  const plain = (res, pathname, status, text) => {
    head(res, pathname, status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };
  /** Serve a file under a root, refusing anything outside it. */
  const sendFile = (/** @type {http.IncomingMessage} */ req, /** @type {http.ServerResponse} */ res, /** @type {string} */ pathname, /** @type {string} */ root, /** @type {string} */ relPath) => {
    const file = path.resolve(root, relPath);
    if (file !== root && !file.startsWith(root + path.sep)) return plain(res, pathname, 403, 'forbidden');
    let st;
    try { st = fs.statSync(file); } catch { return plain(res, pathname, 404, 'not found'); }
    if (!st.isFile()) return plain(res, pathname, 404, 'not found');
    head(res, pathname, 200, { 'Content-Type': mime(file), 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  };

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      return plain(res, '/', 400, 'bad request');
    }
    log(`${req.method} ${pathname}`);
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, pathname, 405, 'method not allowed');
    if (pathname.split('/').includes('..') || pathname.includes('\0')) return plain(res, pathname, 400, 'bad path');
    if (mode === 'site') {
      if (pathname === PAGES_BASE) {
        const html = `<!doctype html><meta charset="utf-8"><title>Browser examples (local)</title>\n<p><a href="${site.path}/">${site.title}</a></p>\n`;
        head(res, pathname, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        return res.end(req.method === 'HEAD' ? undefined : html);
      }
      // Pages: a directory URL without its trailing slash answers 301 to the one with it.
      if (pathname === PAGES_BASE.slice(0, -1) || pathname === prefix.slice(0, -1)) {
        head(res, pathname, 301, { Location: `${pathname}/` });
        return res.end();
      }
      if (!pathname.startsWith(prefix)) return plain(res, pathname, 404, 'not found');
    }
    const inner = pathname.slice(prefix.length);
    if (localModels && inner.startsWith('models/')) return sendFile(req, res, pathname, modelsDir, inner.slice('models/'.length));
    if (mode === 'site') {
      const root = path.resolve(dist);
      const target = path.resolve(root, inner);
      if (inner !== '' && !inner.endsWith('/') && (target === root || target.startsWith(root + path.sep))
          && fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
        head(res, pathname, 301, { Location: `${pathname}/` });
        return res.end();
      }
      return sendFile(req, res, pathname, root, inner === '' || inner.endsWith('/') ? `${inner}index.html` : inner);
    }
    const file = inner === '' || inner.endsWith('/') ? `${inner}index.html` : inner;
    let entry;
    try {
      entry = plan().get(file);
    } catch (e) {
      return plain(res, pathname, 500, `build.mjs plan(): ${e instanceof Error ? e.message : e}`);
    }
    if (!entry) return plain(res, pathname, 404, 'not found');
    let body;
    try {
      body = contents(entry);
    } catch (e) {
      return plain(res, pathname, 500, `${file}: ${e instanceof Error ? e.message : e}`);
    }
    head(res, pathname, 200, { 'Content-Type': mime(file), 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
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

async function main(argv) {
  /** @type {any} */
  const opts = { mode: null, port: 8701, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dev') opts.mode = 'dev';
    else if (a === '--site') opts.mode = 'site';
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--dist') opts.dist = path.resolve(argv[++i]);
    else if (a === '--local-models') opts.localModels = true;
    else if (a === '--verbose') opts.log = (/** @type {string} */ s) => process.stderr.write(`serve.mjs: ${s}\n`);
    else {
      console.error(`serve.mjs: unknown argument ${a}\nusage: node harness/serve.mjs --dev|--site [--port N] [--host H] [--dist DIR] [--local-models] [--verbose]`);
      return 2;
    }
  }
  if (!opts.mode || !Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    console.error('usage: node harness/serve.mjs --dev|--site [--port N] [--host H] [--dist DIR] [--local-models] [--verbose]');
    return 2;
  }
  let s;
  try {
    s = await start(opts);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  if (opts.mode === 'dev') {
    console.log(`serving web/ (development) at ${s.base}  (weights from .cache/gliner: ${s.base}?models=local)`);
  } else {
    console.log(`serving dist/ at ${s.base} as GitHub Pages would${opts.localModels ? `; weights from .cache/gliner: ${s.base}?models=local` : ''}`);
  }
  console.log('Ctrl-C stops it.');
  const stop = () => s.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const rc = await main(process.argv.slice(2));
  if (rc !== null) process.exitCode = rc;
}
