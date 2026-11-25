#!/usr/bin/env node
// @ts-check
/**
 * build.mjs: example 03's static site, dist/ (published by site/build.mjs on GitHub Pages).
 *
 *   npm run build                 # = node build.mjs: dist/ from web/, data/ and node_modules
 *   node build.mjs [--out <dir>]  # somewhere else
 *
 * dist/ is self-contained, deterministic (the same inputs give the same bytes: esbuild's output
 * depends on nothing but its inputs, and nothing time- or host-dependent is written) and runs from
 * any sub-path: every URL in it is relative. Layout:
 *
 *   index.html style.css favicon.svg   the page (web/)
 *   app.js engine.worker.js            the page's modules and its worker, each bundled by esbuild from
 *                                      web/ and lib/; Relate and NVL stay outside them, imported from
 *                                      the versioned directories below
 *   assets/relate-<ver>/               relate.js, relate_bg.wasm, trap.js and
 *                                      snippets/relate-wasm-<hash>/js/opfs.js from npm's @relate/relate-wasm
 *                                      (the lockfile's integrity is the pin; lib/relate_wasm.mjs check()
 *                                      refuses any other version), and LICENSE.txt
 *                                      (data/LICENSE-relate.txt, sha256-pinned)
 *   assets/nvl-<ver>/                  nvl.js and HierarchicalLayout.worker.js (web/vendor-entry.mjs, as
 *                                      examples 01 and 02 bundle them), their .LEGAL.txt, NVL-LICENSE.txt,
 *                                      each bundled npm package's licence and THIRD_PARTY-npm.txt
 *   assets/transformers-<ver>/         transformers.js (@huggingface/transformers, minified into one module with the
 *                                      onnxruntime-web glue it imports) and onnxruntime-web's WebAssembly
 *                                      build (ort-wasm-simd-threaded.mjs and .wasm), with both licences. Loaded
 *                                      only when the visitor types a text the page has no vector for.
 *   assets/public-sans-<ver>/          Public Sans (variable, latin) and its licence
 *   assets/ibm-plex-mono-<ver>/        IBM Plex Mono (400, 500, 600, latin) and its licence
 *   assets/relate-brand-<ver>/         Relate's logo, favicons and mascot (data/brand/), with the brand
 *                                      kit's README.txt
 *   data/scenarios/                    the scripted conversations, and data/SOURCE.md
 *   data/embeddings.json               the vector of every text the scripts use (harness/embed.mjs)
 *   THIRD_PARTY.md
 *
 * Directories under assets/ are versioned: a new version is a new URL, so GitHub Pages' 10-minute
 * cache never serves a stale one. The embedding model is not shipped: the page fetches its four
 * files from the Hugging Face Hub at the revision web/embed.js pins, each checked against its sha256.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as relateWasm from '../../lib/relate_wasm.mjs';

export const EX = path.dirname(fileURLToPath(import.meta.url));
export const RELATE = '1.2.0';
const MODULES = path.join(EX, 'node_modules');
/** Relate's LICENSE at tag v<RELATE> (https://github.com/relatedb/relate/blob/v1.2.0/LICENSE): its sha256 (as examples 01 and 02 pin it). */
const RELATE_LICENSE_SHA256 = 'ac87d12e27d69f09130a7b4178e48e995ab131e4b476aa188e58ffac7ed7fab3';
/** The page's entries (bundled), the modules they import, and its static files; any other web/ file is an error. */
const ENTRIES = ['app.js', 'engine.worker.js', 'embed.worker.js'];
const MODULES_IN = ['agent.js', 'embed.js', 'graph.js', 'memory.js'];
/** The MIT License text with onnxruntime-web's copyright line (its npm package ships no licence file): its sha256. */
const ORT_LICENSE_SHA256 = '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c';
/** onnxruntime-web's WebAssembly build: the files its `wasm` entry point loads. */
const ORT_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
const STATIC = ['index.html', 'style.css'];
const INPUTS = ['vendor-entry.mjs'];
/** The Relate brand kit this page uses (data/brand/README.txt names the version). */
export const BRAND = '1.0';
const BRAND_FILES = ['relate-logo-navy.svg', 'relate-logo-white.svg', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png',
  'archie-mascot.svg', 'archie-mascot-flair.svg', 'README.txt'];
/** The font files the page's @font-face rules name, by package. */
const FONTS = /** @type {Record<string, {dir: string, files: string[]}>} */ ({
  '@fontsource-variable/public-sans': { dir: 'public-sans', files: ['public-sans-latin-wght-normal.woff2'] },
  '@fontsource/ibm-plex-mono': { dir: 'ibm-plex-mono', files: ['ibm-plex-mono-latin-400-normal.woff2', 'ibm-plex-mono-latin-500-normal.woff2', 'ibm-plex-mono-latin-600-normal.woff2'] },
});
export const SCENARIOS = ['team', 'trip', 'code'];

export class BuildError extends Error {}

const sha256 = (/** @type {Buffer|string} */ b) => createHash('sha256').update(b).digest('hex');
const rel = (/** @type {string} */ p) => path.relative(process.cwd(), p) || '.';
/** @param {string} pkg */
function version(pkg) {
  const file = path.join(MODULES, pkg, 'package.json');
  if (!fs.existsSync(file)) throw new BuildError(`no node_modules/${pkg}: run npm ci --omit=peer`);
  return JSON.parse(fs.readFileSync(file, 'utf8')).version;
}

/** What the page needs that is not in the repository: [] when the build can run. */
export async function verifyInputs() {
  const problems = [];
  const info = await relateWasm.check(RELATE);
  if (!info.ok) problems.push(`Relate ${RELATE} WASM: ${info.reason}`);
  const lic = path.join(EX, 'data/LICENSE-relate.txt');
  if (!fs.existsSync(lic) || sha256(fs.readFileSync(lic)) !== RELATE_LICENSE_SHA256) problems.push(`${rel(lic)} is not Relate's LICENSE at v${RELATE}`);
  const ortLic = path.join(EX, 'data/LICENSE-onnxruntime.txt');
  if (!fs.existsSync(ortLic) || sha256(fs.readFileSync(ortLic)) !== ORT_LICENSE_SHA256) problems.push(`${rel(ortLic)} is not the pinned licence text`);
  const pins = JSON.parse(fs.readFileSync(path.join(EX, 'package.json'), 'utf8')).dependencies;
  for (const [pkg, want] of Object.entries(pins)) {
    let got;
    try { got = version(pkg); } catch { got = null; }
    if (got !== want) problems.push(`node_modules/${pkg} is ${got ?? 'missing'}, package.json pins ${want}: run npm ci --omit=peer`);
  }
  // the page's stylesheet declares the brand's colours as the brand kit gives them
  const css = fs.readFileSync(path.join(EX, 'web/style.css'), 'utf8');
  for (const [name, hex] of Object.entries(JSON.parse(fs.readFileSync(path.join(EX, 'data/brand/relate-colors.json'), 'utf8')))) {
    if (!new RegExp(`--relate-${name}:\\s*${hex};`, 'i').test(css)) problems.push(`web/style.css does not declare --relate-${name}: ${hex} (data/brand/relate-colors.json)`);
  }
  return problems;
}

/** The versioned asset directories, by component. */
export function assetDirs() {
  return {
    relate: `assets/relate-${RELATE}`,
    nvl: `assets/nvl-${version('@neo4j-nvl/base')}`,
    transformers: `assets/transformers-${version('@huggingface/transformers')}`,
    sans: `assets/public-sans-${version('@fontsource-variable/public-sans')}`,
    mono: `assets/ibm-plex-mono-${version('@fontsource/ibm-plex-mono')}`,
    brand: `assets/relate-brand-${BRAND}`,
  };
}

/**
 * The npm packages an esbuild bundle took code from (its metafile: inputs with bytes in an output), with their licence files:
 * [{name, version, licence: path | null}].
 * @param {any} meta
 */
function bundledPackages(meta) {
  const seen = new Map();
  // Only the packages that put bytes into an output: a tree-shaken package (NVL's Segment analytics) is neither shipped nor listed.
  const used = new Set();
  for (const o of Object.values(meta.outputs)) for (const [input, x] of Object.entries(/** @type {any} */ (o).inputs ?? {})) if (/** @type {any} */ (x).bytesInOutput > 0) used.add(input);
  for (const input of Object.keys(meta.inputs).filter((i) => used.has(i))) {
    const posix = input.split(path.sep).join('/');
    // the last node_modules/<package>/ in the path (a nested dependency is its own package)
    const all = [...posix.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//g)];
    const m = all[all.length - 1];
    if (!m) continue;
    const dir = path.join(EX, posix.slice(0, (m.index ?? 0) + m[0].length - 1));
    if (seen.has(dir)) continue;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const licence = fs.readdirSync(dir).filter((f) => /^(LICEN[CS]E|COPYING)(\.|$)/i.test(f)).sort()[0];
    seen.set(dir, { name: pkg.name, version: pkg.version, licenceName: pkg.license ?? null, licence: licence ? path.join(dir, licence) : null });
  }
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Relate's files in the npm package. */
function relateFiles() {
  const dir = path.join(MODULES, '@relate/relate-wasm');
  const snippets = fs.readdirSync(path.join(dir, 'snippets')).filter((d) => d.startsWith('relate-wasm-') && fs.existsSync(path.join(dir, 'snippets', d, 'js/opfs.js')));
  if (snippets.length !== 1) throw new BuildError(`node_modules/@relate/relate-wasm: expected one snippets/relate-wasm-<hash>/js/opfs.js, found ${snippets.length}`);
  return { dir, files: ['relate.js', 'relate_bg.wasm', 'trap.js', `snippets/${snippets[0]}/js/opfs.js`] };
}

/** @param {string} [out] @param {{staleVectors?: boolean}} [options]  staleVectors: do not refuse a data/embeddings.json made with another model (harness/embed.mjs) */
export async function build(out = path.join(EX, 'dist'), { staleVectors = false } = {}) {
  const problems = await verifyInputs();
  if (problems.length) throw new BuildError(`the page's inputs are not ready:\n  ${problems.join('\n  ')}`);
  const web = path.join(EX, 'web');
  const known = new Set([...ENTRIES, ...MODULES_IN, ...STATIC, ...INPUTS]);
  const extra = fs.readdirSync(web).filter((f) => !known.has(f));
  if (extra.length) throw new BuildError(`web/${extra[0]} is not listed in build.mjs: add it, or keep it out of web/`);
  const scenarioFiles = fs.readdirSync(path.join(EX, 'data/scenarios')).sort();
  const wanted = SCENARIOS.map((s) => `${s}.json`).sort();
  if (scenarioFiles.join() !== wanted.join()) throw new BuildError(`data/scenarios/ holds ${scenarioFiles.join(', ')}; build.mjs and web/app.js list ${wanted.join(', ')}`);
  const dirs = assetDirs();
  const relate = dirs.relate;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  /** @param {string} to @param {string|Buffer} data */
  const write = (to, data) => {
    const p = path.join(out, to);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  };
  /** @param {string} to @param {string} from */
  const copy = (to, from) => write(to, fs.readFileSync(from));

  const r = relateFiles();
  for (const f of r.files) copy(`${relate}/${f}`, path.join(r.dir, f));
  copy(`${relate}/LICENSE.txt`, path.join(EX, 'data/LICENSE-relate.txt'));

  const common = /** @type {const} */ ({ bundle: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent', charset: 'utf8' });
  // NVL, as examples 01 and 02 bundle it, with the notices its bundles need
  const metas = [];
  for (const [entry, name] of [[path.join(web, 'vendor-entry.mjs'), 'nvl.js'],
    [path.join(MODULES, '@neo4j-nvl/layout-workers/lib/hierarchical-layout/HierarchicalLayout.worker.js'), 'HierarchicalLayout.worker.js']]) {
    const res = await esbuild.build({ ...common, absWorkingDir: EX, entryPoints: [entry], minify: true, legalComments: 'external', metafile: true,
      outfile: path.join(out, dirs.nvl, name) });
    metas.push(res.metafile);
  }
  copy(`${dirs.nvl}/NVL-LICENSE.txt`, path.join(MODULES, '@neo4j-nvl/base/LICENSE.txt'));
  // The files the .LEGAL.txt notices refer to ("For license information please see X", next to the module
  // that says it), shipped beside them, following a chain of references (as example 01's build does).
  const REFERENCE = /For license information please see (\S+?)(?:\s*\*\/|$)/gm;
  const inputs = new Set(metas.flatMap((m) => Object.keys(m.inputs)).map((k) => k.split(path.sep).join('/')));
  /** @type {Set<string>} */ const shipped = new Set();
  for (const name of ['nvl.js', 'HierarchicalLayout.worker.js']) {
    const legal = fs.readFileSync(path.join(out, dirs.nvl, `${name}.LEGAL.txt`), 'utf8');
    /** @type {Array<[string, string]>} */ const sections = [];
    for (const line of legal.split('\n')) {
      const m = /^(\S.*):$/.exec(line);
      if (m && line !== 'Bundled license information:') sections.push([m[1], '']);
      else if (sections.length) sections[sections.length - 1][1] += `${line}\n`;
    }
    for (const [mod, body] of sections) {
      const input = [...inputs].find((k) => k === mod || k.endsWith(`/${mod}`));
      for (const ref of body.matchAll(REFERENCE)) {
        if (!input) throw new BuildError(`${name}.LEGAL.txt: ${mod} refers to ${ref[1]}, but the metafile lists no such module`);
        let from = path.join(EX, path.dirname(input), ref[1]);
        for (const seen = new Set(); !seen.has(from); ) {
          if (!fs.existsSync(from)) throw new BuildError(`${name}.LEGAL.txt: ${mod} refers to ${rel(from)}, which does not exist`);
          seen.add(from);
          if (!shipped.has(path.basename(from))) { copy(`${dirs.nvl}/${path.basename(from)}`, from); shipped.add(path.basename(from)); }
          const next = [...fs.readFileSync(from, 'utf8').matchAll(REFERENCE)][0]?.[1];
          if (!next) break;
          from = path.join(path.dirname(from), next);
        }
      }
    }
  }
  const pkgs = new Map();
  for (const m of metas) for (const p of bundledPackages(m)) pkgs.set(`${p.name}@${p.version}`, p);
  const lines = [`npm packages bundled into nvl.js and HierarchicalLayout.worker.js (NVL ${version('@neo4j-nvl/base')}), with their licences:`];
  for (const p of [...pkgs.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const file = p.licence ? `LICENSE-${p.name.replace(/^@/, '').replace(/\//g, '-')}-${p.version}.txt` : null;
    if (file && p.licence) copy(`${dirs.nvl}/${file}`, p.licence);
    lines.push(`  ${p.name} ${p.version} (${p.licenceName ?? 'see its licence file'})${file ? `: ${file}` : ''}`);
  }
  write(`${dirs.nvl}/THIRD_PARTY-npm.txt`, `${lines.join('\n')}\n`);
  // Transformers.js: one minified module. It imports onnxruntime-web's WebGPU entry point; the page
  // embeds on WebAssembly only, so the `wasm` entry point stands in for it and the smaller .wasm ships (T2).
  const tf = await esbuild.build({ ...common, absWorkingDir: EX, entryPoints: [path.join(MODULES, '@huggingface/transformers/dist/transformers.web.js')],
    minify: true, legalComments: 'none', metafile: true, alias: { 'onnxruntime-web/webgpu': 'onnxruntime-web/wasm' },
    outfile: path.join(out, dirs.transformers, 'transformers.js') });
  for (const f of ORT_FILES) copy(`${dirs.transformers}/${f}`, path.join(MODULES, 'onnxruntime-web/dist', f));
  copy(`${dirs.transformers}/LICENSE.txt`, path.join(MODULES, '@huggingface/transformers/LICENSE'));
  copy(`${dirs.transformers}/LICENSE-onnxruntime.txt`, path.join(EX, 'data/LICENSE-onnxruntime.txt'));
  const tfLines = [`npm packages bundled into transformers.js (Transformers.js ${version('@huggingface/transformers')}), with their licences:`];
  for (const pkg of bundledPackages(tf.metafile)) {
    const own = pkg.name === '@huggingface/transformers';
    const file = own ? 'LICENSE.txt' : pkg.name.startsWith('onnxruntime-') ? 'LICENSE-onnxruntime.txt'
      : pkg.licence ? `LICENSE-${pkg.name.replace(/^@/, '').replace(/\//g, '-')}-${pkg.version}.txt` : null;
    if (file && pkg.licence && !own && !pkg.name.startsWith('onnxruntime-')) copy(`${dirs.transformers}/${file}`, pkg.licence);
    tfLines.push(`  ${pkg.name} ${pkg.version} (${pkg.licenceName ?? 'see its licence file'})${file ? `: ${file}` : ''}`);
  }
  // the package's own build has its tokenizer and template libraries inlined: their notices ship too
  for (const dep of ['@huggingface/tokenizers', '@huggingface/jinja']) {
    const file = `LICENSE-${dep.replace(/^@/, '').replace(/\//g, '-')}-${version(dep)}.txt`;
    copy(`${dirs.transformers}/${file}`, path.join(MODULES, dep, 'LICENSE'));
    tfLines.push(`  ${dep} ${version(dep)} (${JSON.parse(fs.readFileSync(path.join(MODULES, dep, 'package.json'), 'utf8')).license}), inlined by the package's build: ${file}`);
  }
  tfLines.push(`${ORT_FILES.join(' and ')}: onnxruntime-web ${version('onnxruntime-web')} (MIT): LICENSE-onnxruntime.txt`);
  write(`${dirs.transformers}/THIRD_PARTY-npm.txt`, `${tfLines.join('\n')}\n`);
  // the brand's typefaces, each with its licence (SIL Open Font License 1.1)
  for (const [pkg, f] of Object.entries(FONTS)) {
    const to = `assets/${f.dir}-${version(pkg)}`;
    for (const file of f.files) copy(`${to}/${file}`, path.join(MODULES, pkg, 'files', file));
    copy(`${to}/LICENSE.txt`, path.join(MODULES, pkg, 'LICENSE'));
  }
  // the brand kit's files
  for (const f of BRAND_FILES) copy(`${dirs.brand}/${f}`, path.join(EX, 'data/brand', f));

  // the page's modules: NVL stays external, imported from its versioned directory; so do Node's own
  // modules (lib/relate_wasm.mjs imports them only when it runs in Node, so a browser never reaches them)
  await esbuild.build({
    ...common,
    absWorkingDir: EX,
    entryPoints: ENTRIES.map((f) => path.join(web, f)),
    outdir: out,
    legalComments: 'none',
    define: { __EX03_TRANSFORMERS_DIR__: JSON.stringify(`./${dirs.transformers}/`) },
    plugins: [{
      name: 'ex03-externals',
      setup(b) {
        b.onResolve({ filter: /^vendor:nvl$/ }, () => ({ path: `./${dirs.nvl}/nvl.js`, external: true }));
        b.onResolve({ filter: /^vendor:transformers$/ }, () => ({ path: `./${dirs.transformers}/transformers.js`, external: true }));
        b.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, external: true }));
      },
    }],
  });
  for (const f of STATIC) copy(f, path.join(web, f));
  // every assets/ path the page and its stylesheet name must be a file this build wrote
  for (const f of STATIC) {
    for (const m of fs.readFileSync(path.join(web, f), 'utf8').matchAll(/assets\/[A-Za-z0-9._/@-]+\.[a-z0-9]+/g)) {
      if (!fs.existsSync(path.join(out, m[0]))) throw new BuildError(`web/${f} names ${m[0]}, which the build does not write (a version moved?)`);
    }
  }
  for (const s of SCENARIOS) {
    // each scenario re-serialised, so the published file is JSON whatever the source's formatting
    write(`data/scenarios/${s}.json`, `${JSON.stringify(JSON.parse(fs.readFileSync(path.join(EX, 'data/scenarios', `${s}.json`), 'utf8')))}\n`);
  }
  copy('data/SOURCE.md', path.join(EX, 'data/SOURCE.md'));
  // the scripts' vectors, checked against the model this build expects and against the scripts
  const emb = JSON.parse(fs.readFileSync(path.join(EX, 'data/embeddings.json'), 'utf8'));
  const { precomputed } = await import('./web/embed.js');
  // (harness/embed.mjs builds with staleVectors: it is about to rewrite that file with this build's worker)
  try { precomputed(emb); } catch (e) { if (!staleVectors) throw new BuildError(e instanceof Error ? e.message : String(e)); }
  copy('data/embeddings.json', path.join(EX, 'data/embeddings.json'));
  copy('THIRD_PARTY.md', path.join(EX, 'THIRD_PARTY.md'));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');

  let files = 0;
  let bytes = 0;
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { files++; bytes += fs.statSync(p).size; }
    }
  };
  walk(out);
  return { files, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const out = i >= 0 ? path.resolve(args[i + 1]) : path.join(EX, 'dist');
  try {
    const { files, bytes } = await build(out);
    console.log(`build.mjs: wrote ${rel(out)}/: ${files} files, ${(bytes / 1e6).toFixed(1)} MB`);
  } catch (e) {
    console.error(`build.mjs: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}
