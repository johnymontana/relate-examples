#!/usr/bin/env node
// @ts-check
/**
 * build.mjs: example 02's static site, dist/ (published by site/build.mjs on GitHub Pages).
 *
 *   npm run build                 # = node build.mjs: dist/ from web/, data/ and node_modules
 *   node build.mjs [--out <dir>]  # somewhere else
 *
 * dist/ is self-contained, deterministic (the same inputs give the same bytes: esbuild's output
 * depends on nothing but its inputs, and nothing time- or host-dependent is written) and runs from
 * any sub-path: every URL in it is relative. Layout:
 *
 *   index.html style.css favicon.svg     the page (web/)
 *   app.js engine.worker.js llm.worker.js   the page's modules and its two workers, each bundled by esbuild
 *                                   from web/ and lib/; the heavy packages stay outside them (EXTERNAL),
 *                                   imported from the versioned directories below
 *   assets/relate-<ver>/            relate.js, relate_bg.wasm, trap.js and snippets/relate-wasm-<hash>/js/opfs.js from npm's
 *                                   @relate/relate-wasm (the lockfile's integrity is the pin; lib/relate_wasm.mjs check()
 *                                   refuses any other version), and LICENSE.txt (data/LICENSE-relate.txt, sha256-pinned)
 *   assets/web-llm-<ver>/           web-llm.js (@mlc-ai/web-llm, minified into one module) and LICENSE.txt
 *   assets/ontology-graph-spec-<ver>/  ontology-graph-spec.js (the SDK, minified into one module), LICENSE.txt and
 *                                   THIRD_PARTY.txt (the Kotlin libraries compiled into it)
 *   assets/nvl-<ver>/               nvl.js and HierarchicalLayout.worker.js (web/vendor-entry.mjs, as example 01 bundles them),
 *                                   their .LEGAL.txt, NVL-LICENSE.txt, each bundled npm package's licence and THIRD_PARTY-npm.txt
 *   assets/js-yaml-<ver>/           js-yaml.js (its ESM build) and LICENSE.txt
 *   data/                           corporate-events.ontology.yaml, demo-graph.json, canned.json, SOURCE.md
 *   THIRD_PARTY.md
 *
 * Directories under assets/ are versioned: a new version is a new URL, so GitHub Pages' 10-minute
 * cache never serves a stale one. The model weights are not shipped: WebLLM fetches them from the
 * Hugging Face Hub at the revisions web/llm.js pins, and the model libraries from GitHub at a pinned
 * commit, each checked against its SRI hash.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as relateWasm from '../../lib/relate_wasm.mjs';

export const EX = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(EX, '../..');
export const RELATE = '1.2.0';
const MODULES = path.join(EX, 'node_modules');
/** Relate's LICENSE at tag v<RELATE> (https://github.com/relatedb/relate/blob/v1.2.0/LICENSE): its sha256 (as example 01 pins it). */
const RELATE_LICENSE_SHA256 = 'ac87d12e27d69f09130a7b4178e48e995ab131e4b476aa188e58ffac7ed7fab3';
/** The page's modules (bundled) and static files; any other web/ file is an error. */
const ENTRIES = ['app.js', 'engine.worker.js', 'llm.worker.js'];
const MODULES_IN = ['briefing.js', 'canned.js', 'compare.js', 'ddl.js', 'llm.js', 'load.js', 'ontology.js', 'py.js', 'run.js', 'validate.js'];
const STATIC = ['index.html', 'style.css', 'favicon.svg'];
const INPUTS = ['vendor-entry.mjs'];
const DATA = ['corporate-events.ontology.yaml', 'demo-graph.json', 'canned.json', 'SOURCE.md'];
/** The Kotlin libraries compiled into the SDK (neo4j/ontology-graph-spec release/v0.12.2, gradle/libs.versions.toml). */
const OGS_SDK_RUNTIME = [
  'Kotlin standard library 2.3.20 (JetBrains, Apache-2.0)',
  'kotlinx.serialization 1.10.0, core and JSON (JetBrains, Apache-2.0)',
  'kotlinx.coroutines and kotlinx-atomicfu (JetBrains, Apache-2.0)',
  'kotlin-wrappers kotlin-typescript and kotlin-js-plain-objects, with seskar (JetBrains and contributors, Apache-2.0)',
  'yamlkt 0.13.0 (Him188, Apache-2.0)',
];

export class BuildError extends Error {}

const sha256 = (/** @type {Buffer|string} */ b) => createHash('sha256').update(b).digest('hex');
const rel = (/** @type {string} */ p) => path.relative(process.cwd(), p) || '.';
/** @param {string} pkg */
function version(pkg) {
  const file = path.join(MODULES, pkg, 'package.json');
  if (!fs.existsSync(file)) throw new BuildError(`no node_modules/${pkg}: run npm ci --omit=peer`);
  return JSON.parse(fs.readFileSync(file, 'utf8')).version;
}

/** The versioned asset directories, by package. */
export function assetDirs() {
  return {
    relate: `assets/relate-${RELATE}`,
    webllm: `assets/web-llm-${version('@mlc-ai/web-llm')}`,
    ogs: `assets/ontology-graph-spec-${version('@neo4j/ontology-graph-spec')}`,
    nvl: `assets/nvl-${version('@neo4j-nvl/base')}`,
    yaml: `assets/js-yaml-${version('js-yaml')}`,
  };
}

/** What the page needs that is not in the repository: [] when the build can run. */
export async function verifyInputs() {
  const problems = [];
  const info = await relateWasm.check(RELATE);
  if (!info.ok) problems.push(`Relate ${RELATE} WASM: ${info.reason}`);
  const lic = path.join(EX, 'data/LICENSE-relate.txt');
  if (!fs.existsSync(lic) || sha256(fs.readFileSync(lic)) !== RELATE_LICENSE_SHA256) problems.push(`${rel(lic)} is not Relate's LICENSE at v${RELATE}`);
  const pins = JSON.parse(fs.readFileSync(path.join(EX, 'package.json'), 'utf8')).dependencies;
  for (const [pkg, want] of Object.entries(pins)) {
    let got;
    try { got = version(pkg); } catch { got = null; }
    if (got !== want) problems.push(`node_modules/${pkg} is ${got ?? 'missing'}, package.json pins ${want}: run npm ci --omit=peer`);
  }
  return problems;
}

/** Relate's files in the npm package. */
function relateFiles() {
  const dir = path.join(MODULES, '@relate/relate-wasm');
  const snippets = fs.readdirSync(path.join(dir, 'snippets')).filter((d) => d.startsWith('relate-wasm-') && fs.existsSync(path.join(dir, 'snippets', d, 'js/opfs.js')));
  if (snippets.length !== 1) throw new BuildError(`node_modules/@relate/relate-wasm: expected one snippets/relate-wasm-<hash>/js/opfs.js, found ${snippets.length}`);
  return { dir, files: ['relate.js', 'relate_bg.wasm', 'trap.js', `snippets/${snippets[0]}/js/opfs.js`] };
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

/**
 * esbuild resolution for the page's bundles: the packages that live in assets/ stay external,
 * imported by their dist-relative path; Node's own modules (lib/relate_wasm.mjs imports them only
 * when it runs in Node) stay external too and are never reached in a browser.
 * @param {Record<string, string>} map  specifier -> dist path
 * @returns {esbuild.Plugin}
 */
function externals(map) {
  return {
    name: 'ex02-externals',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (Object.hasOwn(map, args.path)) return { path: `./${map[args.path]}`, external: true };
        if (args.path.startsWith('node:')) return { path: args.path, external: true };
        return undefined;
      });
    },
  };
}

/** @param {string} out */
export async function build(out = path.join(EX, 'dist')) {
  const problems = await verifyInputs();
  if (problems.length) throw new BuildError(`the page's inputs are not ready:\n  ${problems.join('\n  ')}`);
  const web = path.join(EX, 'web');
  const known = new Set([...ENTRIES, ...MODULES_IN, ...STATIC, ...INPUTS]);
  const extra = fs.readdirSync(web).filter((f) => !known.has(f));
  if (extra.length) throw new BuildError(`web/${extra[0]} is not listed in build.mjs: add it, or keep it out of web/`);
  const dirs = assetDirs();
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
  const common = /** @type {const} */ ({ bundle: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent', charset: 'utf8' });

  // Relate
  const r = relateFiles();
  for (const f of r.files) copy(`${dirs.relate}/${f}`, path.join(r.dir, f));
  copy(`${dirs.relate}/LICENSE.txt`, path.join(EX, 'data/LICENSE-relate.txt'));
  // WebLLM: one minified module (its own WASM runtimes are inlined in it)
  await esbuild.build({ ...common, entryPoints: [path.join(MODULES, '@mlc-ai/web-llm/lib/index.js')], minify: true, legalComments: 'none',
    outfile: path.join(out, dirs.webllm, 'web-llm.js') });
  copy(`${dirs.webllm}/LICENSE.txt`, path.join(MODULES, '@mlc-ai/web-llm/LICENSE'));
  // the Ontology Graph Spec SDK: one minified module
  await esbuild.build({ ...common, entryPoints: [path.join(MODULES, '@neo4j/ontology-graph-spec/ontology-graph-spec.mjs')], minify: true, legalComments: 'none',
    outfile: path.join(out, dirs.ogs, 'ontology-graph-spec.js') });
  copy(`${dirs.ogs}/LICENSE.txt`, path.join(EX, 'data/LICENSE-ontology-graph-spec.txt'));
  write(`${dirs.ogs}/THIRD_PARTY.txt`, [
    `npm @neo4j/ontology-graph-spec ${version('@neo4j/ontology-graph-spec')} (neo4j/ontology-graph-spec, Apache-2.0: LICENSE.txt), bundled by build.mjs.`,
    'Its modules are Kotlin/JS output, with these Kotlin libraries compiled in:',
    ...OGS_SDK_RUNTIME.map((x) => `  ${x}`),
    'The Apache License 2.0 text is LICENSE.txt.',
    '',
  ].join('\n'));
  // NVL, as example 01 bundles it, with the notices its bundles need
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
  // js-yaml
  copy(`${dirs.yaml}/js-yaml.js`, path.join(MODULES, 'js-yaml/dist/js-yaml.mjs'));
  copy(`${dirs.yaml}/LICENSE.txt`, path.join(MODULES, 'js-yaml/LICENSE'));

  // the page's modules
  await esbuild.build({
    ...common,
    absWorkingDir: EX,
    entryPoints: ENTRIES.map((f) => path.join(web, f)),
    outdir: out,
    legalComments: 'none',
    plugins: [externals({
      'js-yaml': `${dirs.yaml}/js-yaml.js`,
      '@neo4j/ontology-graph-spec': `${dirs.ogs}/ontology-graph-spec.js`,
      '@mlc-ai/web-llm': `${dirs.webllm}/web-llm.js`,
      'vendor:nvl': `${dirs.nvl}/nvl.js`,
    })],
  });
  for (const f of STATIC) copy(f, path.join(web, f));
  for (const f of DATA) copy(`data/${f}`, path.join(EX, 'data', f));
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
