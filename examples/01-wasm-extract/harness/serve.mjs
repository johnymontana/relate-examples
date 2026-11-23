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
 *       dist/ (npm run build) as GitHub Pages serves this project site (lib/serve.mjs, shared with
 *       the other browser examples): under the repository's
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
import { MIME, start as startPages } from '../../../lib/serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EX = path.resolve(HERE, '..');

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
  // --site is lib/serve.mjs, the Pages emulator every browser example shares; --local-models adds /models/.
  if (mode === 'site') {
    return startPages({ example: path.basename(EX), dist, port, host, base: PAGES_BASE, routes: localModels ? { 'models/': inputDirs().models } : {}, log });
  }
  const prefix = '/';
  const modelsDir = inputDirs().models;
  const problems = await verifyInputs();
  if (problems.length) throw new Error(`serve.mjs --dev: the page's inputs are not ready:\n  ${problems.join('\n  ')}`);

  /** Only what a static host sends; the dev server never caches. */
  /** @param {http.ServerResponse} res @param {string} _pathname @param {number} status @param {Record<string, string|number>} [extra] */
  const head = (res, _pathname, status, extra = {}) => {
    res.writeHead(status, { 'Cache-Control': 'no-store', ...extra });
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
    const inner = pathname.slice(prefix.length);
    if (localModels && inner.startsWith('models/')) return sendFile(req, res, pathname, modelsDir, inner.slice('models/'.length));
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
