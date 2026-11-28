#!/usr/bin/env node
// @ts-check
/**
 * build.mjs: example 01's static site, dist/ (published by site/build.mjs on GitHub Pages).
 *
 *   npm run build                 # = npm run vendor && node build.mjs: NVL's bundle, then dist/
 *   node build.mjs [--out <dir>]  # dist/ (default) from what is already built
 *
 * dist/ is self-contained, deterministic (the same inputs give the same bytes; nothing time- or
 * host-dependent is written) and runs from any sub-path: every URL in it is relative, and every
 * file is a regular file (site/build.mjs refuses anything else). Layout:
 *
 *   index.html style.css favicon.svg app.js ... worker.js console.js   the page and its modules (web/)
 *   assets/relate-1.3.0/            relate.js, relate_bg.wasm, trap.js and snippets/relate-wasm-<hash>/js/opfs.js from
 *                                   npm's @relate/relate-wasm (node_modules, npm ci: the lockfile's integrity is the
 *                                   pin), checked as lib/relate_wasm.mjs checks them, and LICENSE.txt (Relate's
 *                                   Apache-2.0 text from data/LICENSE-relate.txt, checked against its pin)
 *   assets/gliner-rs-4fa741e/       gliner_rs.js, gliner_rs_bg.wasm and LICENSE.txt (gliner-rs's LICENSE),
 *                                   from scripts/build-gliner-wasm.sh's output, checked against its .built;
 *                                   THIRD_PARTY-crates.txt (every crate linked into the .wasm) when the build has it
 *   assets/nvl-2.0.0/               nvl.js, HierarchicalLayout.worker.js, their .LEGAL.txt and NVL-LICENSE.txt
 *                                   (npm run vendor), plus the notices the bundles need (nvlNotices below):
 *                                   every file a .LEGAL.txt refers to ("For license information please see
 *                                   X", shipped as X), each bundled npm package's own licence file as
 *                                   LICENSE-<package>-<version>.txt, and THIRD_PARTY-npm.txt listing them,
 *                                   all from esbuild's metafiles (web/vendor/*.meta.json)
 *   assets/js-yaml-<ver>/           js-yaml.js (its ESM build) and LICENSE.txt
 *   assets/ontology-graph-spec-<ver>/  ontology-graph-spec.js (npm @neo4j/ontology-graph-spec, the Ontology Graph
 *                                   Spec SDK, bundled into one minified module by npm run vendor: the package is
 *                                   Kotlin/JS output spread over 13 modules), LICENSE.txt (the SDK repository's
 *                                   Apache-2.0 text, data/ontology-spec/LICENSE-graph-spec.txt) and
 *                                   THIRD_PARTY.txt (the Kotlin libraries compiled into it)
 *   assets/lib-<sha8>/              lib/replay.mjs, lib/relate_wasm.mjs and lib/ogs.mjs as replay.js, relate_wasm.js and ogs.js
 *   data/ontologies/domains/        the curated domains (D20), as written, and SOURCE.md
 *   data/ontologies/ogs/studio/     the solution packages with their overlays applied (D21, harness/convert.mjs),
 *                                   ogs/SOURCE.md; data/ontologies/studio/<package>/ human_description.md and
 *                                   NOTICE.md beside them, studio/SOURCE.md and manifest.json: what the picker loads
 *   data/ontologies/ccg/            _base.yaml (verbatim: a pasted or uploaded create-context-graph file inherits it),
 *                                   SOURCE.md and LICENSE-create-context-graph.txt; the 27 originals are not shipped
 *   data/ontologies/index.json      {bases: {_base: 'ccg/_base.yaml'}, groups: [{id: 'domains' | 'studio', label, files}]}:
 *                                   the picker's groups in order, files sorted
 *   data/ontology-spec/             the spec's JSON Schema, its LICENSE-graph-spec.txt and SOURCE.md
 *   data/samples/                   samples.json and the samples it lists (domains/<id>/<x>.md, studio/<id>/<x>.md);
 *                                   data/LICENSE-edgextract.txt and data/SOURCE.md (the ported splitter and name
 *                                   rules are edgextract's)
 *   THIRD_PARTY.md
 *
 * The page's modules keep the import specifiers that work in Node (`../../../lib/replay.mjs`,
 * `js-yaml`, `@neo4j/ontology-graph-spec`, `./vendor/nvl.js`); build.mjs rewrites them to the relative asset paths above, and
 * refuses any other bare or out-of-tree specifier. The page's CSP has no 'unsafe-inline' for
 * scripts, which also rules out an inline import map, and module workers ignore import maps,
 * so the rewrite is the only way. models.js gets the model pins (repository, revision, sha256
 * and size of each file) in place of its placeholder: the sha256 values come from
 * ci/gliner2.5-<model>.sha256, the revisions from scripts/fetch-gliner.sh, the sizes from
 * MODEL_SIZES below (checked against .cache/gliner when the files are there).
 * Directories under assets/ are versioned: a new version is a new URL, so no cache can serve a stale one.
 *
 * harness/serve.mjs --dev serves the same layout straight from the sources (plan()), so the
 * development page and dist/ load the same URLs.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as relateWasm from '../../lib/relate_wasm.mjs';
import { scanTree } from '../../site/build.mjs';
import { MODEL_FILES } from './web/gliner.js';

export const EX = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(EX, '../..');
export const RELATE = '1.3.0';
const GLINER_REV = '4fa741eec466660daf4adc8703210138295e0b1b';
const GLINER_DIR_NAME = `gliner-rs-${GLINER_REV.slice(0, 7)}`;
const NVL_VERSION = '2.0.0';
/** The Ontology Graph Spec SDK the page ships (package.json; web/ogs.js SDK_VERSION must agree). */
const OGS_SDK_VERSION = '0.13.0';
/**
 * The Kotlin libraries compiled into the SDK's modules (neo4j/ontology-graph-spec at release/v0.13.0,
 * gradle/libs.versions.toml and the module names in its npm package), for THIRD_PARTY.txt. Each is
 * Apache-2.0.
 */
const OGS_SDK_RUNTIME = [
  'Kotlin standard library 2.3.20 (JetBrains, Apache-2.0)',
  'kotlinx.serialization 1.10.0, core and JSON (JetBrains, Apache-2.0)',
  'kotlinx.coroutines and kotlinx-atomicfu (JetBrains, Apache-2.0)',
  'kotlin-wrappers kotlin-typescript and kotlin-js-plain-objects, with seskar (JetBrains and contributors, Apache-2.0)',
  'yamlkt 0.13.0 (Him188, Apache-2.0)',
];

/** The page's modules, in web/; every other web/*.js is an error (a module build.mjs forgot). */
const WEB_MODULES = ['app.js', 'console.js', 'convert.js', 'export.js', 'gliner.js', 'graphview.js', 'markdown.js', 'models.js', 'names.js',
  'ogs.js', 'ontology.js', 'opfs.js', 'pipeline.js', 'split.js', 'store.js', 'studio.js', 'tar.js', 'tonvl.js', 'values.js', 'worker.js'];
const WEB_STATIC = ['index.html', 'style.css', 'favicon.svg'];
/** The esbuild outputs of `npm run vendor` and their metafiles (the bundled npm packages are read from these). */
const VENDOR_BUNDLES = ['nvl.js', 'HierarchicalLayout.worker.js'];
/** web/ files that are build inputs, not part of the page. */
const WEB_INPUTS = new Set(['vendor-entry.mjs']);

/** Model checkpoints: the sizes of the four files the page loads, at the pinned revisions (G1). */
const MODEL_SIZES = {
  small: { 'config.json': 3152, 'encoder_config/config.json': 856, 'model.safetensors': 295567700, 'tokenizer.json': 8341713 },
  base: { 'config.json': 3150, 'encoder_config/config.json': 857, 'model.safetensors': 774366564, 'tokenizer.json': 8341713 },
};
const MODEL_LABELS = { small: 'GLiNER2.5 small v1', base: 'GLiNER2.5 base v1' };
/** Download order: the small files first, so an unreachable Hub fails fast. */
const MODEL_ORDER = ['config', 'encoderConfig', 'tokenizer', 'weights'];

class BuildError extends Error {}

const sha256 = (/** @type {Buffer|string} */ b) => createHash('sha256').update(b).digest('hex');
const read = (/** @type {string} */ p) => fs.readFileSync(p);
const rel = (/** @type {string} */ p) => path.relative(ROOT, p) || '.';

/** Python-style code-point order for paths. @param {string} a @param {string} b */
function cmp(a, b) {
  const x = Array.from(a, (c) => /** @type {number} */ (c.codePointAt(0)));
  const y = Array.from(b, (c) => /** @type {number} */ (c.codePointAt(0)));
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

// ---- inputs -----------------------------------------------------------------------------------------

/** Where the inputs live (environment overrides as the harnesses read them). */
export function inputDirs() {
  return {
    wasm: process.env.RELATE_WASM_DIR ? path.resolve(process.env.RELATE_WASM_DIR) : path.join(EX, 'node_modules/@relate/relate-wasm'),
    gliner: process.env.GLINER_WASM_DIR ? path.resolve(process.env.GLINER_WASM_DIR) : path.join(ROOT, '.cache/gliner-wasm', GLINER_REV.slice(0, 7)),
    models: process.env.GLINER_CACHE_DIR ? path.resolve(process.env.GLINER_CACHE_DIR) : path.join(ROOT, '.cache/gliner'),
    vendor: path.join(EX, 'web/vendor'),
    modules: path.join(EX, 'node_modules'),
  };
}

/**
 * The bundle files the page loads, from the npm package: the glue, the .wasm, trap.js and the OPFS
 * snippet the glue imports (its directory name carries a hash, so it is found, not named).
 * @param {string} dir
 */
function relateFiles(dir) {
  const snippets = path.join(dir, 'snippets');
  const found = fs.existsSync(snippets)
    ? fs.readdirSync(snippets).filter((d) => d.startsWith('relate-wasm-') && fs.existsSync(path.join(snippets, d, 'js/opfs.js')))
    : [];
  if (found.length !== 1) throw new BuildError(`${rel(dir)}: expected one snippets/relate-wasm-<hash>/js/opfs.js, found ${found.length}: run npm ci --omit=peer`);
  return ['relate.js', 'relate_bg.wasm', 'trap.js', `snippets/${found[0]}/js/opfs.js`].sort(cmp);
}

/** Relate's LICENSE at tag v<RELATE> (https://github.com/relatedb/relate/blob/v1.3.0/LICENSE): its sha256. */
const RELATE_LICENSE_SHA256 = 'ac87d12e27d69f09130a7b4178e48e995ab131e4b476aa188e58ffac7ed7fab3';

/** data/LICENSE-relate.txt, refused unless it is the pinned Apache-2.0 text. */
function relateLicense() {
  const file = path.join(EX, 'data/LICENSE-relate.txt');
  const bytes = fs.existsSync(file) ? read(file) : null;
  if (!bytes || sha256(bytes) !== RELATE_LICENSE_SHA256) {
    throw new BuildError(`${rel(file)} is ${bytes ? 'not' : 'missing, not'} Relate's LICENSE at v${RELATE} (sha256 ${RELATE_LICENSE_SHA256.slice(0, 12)}…): ` +
      `fetch https://raw.githubusercontent.com/relatedb/relate/v${RELATE}/LICENSE`);
  }
  return bytes;
}

/** {path: sha256} from a `<sha>  <path>` pin file. @param {string} file */
function pinFile(file) {
  const out = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/** The pinned repositories and revisions, from scripts/fetch-gliner.sh's model_of(). */
function modelRevisions() {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/fetch-gliner.sh'), 'utf8');
  /** @type {Record<string, {repo: string, rev: string}>} */
  const out = {};
  for (const m of src.matchAll(/^\s*(small|base)\)\s*echo "(\S+) ([0-9a-f]{40})"/gm)) out[m[1]] = { repo: m[2], rev: m[3] };
  for (const k of ['small', 'base']) if (!out[k]) throw new BuildError(`scripts/fetch-gliner.sh: no pinned revision for ${k}`);
  return out;
}

/** The model pins models.js embeds (see the header). */
export function modelPins() {
  const revs = modelRevisions();
  /** @type {Record<string, any>} */
  const pins = {};
  for (const key of ['small', 'base']) {
    const name = `gliner2.5-${key}-v1`;
    const pinPath = path.join(ROOT, 'ci', `${name}.sha256`);
    const sums = pinFile(pinPath);
    const files = MODEL_ORDER.map((arg) => {
      const file = /** @type {Record<string, string>} */ (MODEL_FILES)[arg];
      const sha = sums.get(file);
      if (!sha) throw new BuildError(`${rel(pinPath)} pins no ${file}`);
      const bytes = /** @type {Record<string, Record<string, number>>} */ (MODEL_SIZES)[key][file];
      return { name: file, arg, sha256: sha, bytes };
    });
    pins[key] = {
      key, label: /** @type {Record<string, string>} */ (MODEL_LABELS)[key], repo: revs[key].repo, rev: revs[key].rev,
      dir: `${name}@${revs[key].rev.slice(0, 7)}`, files, bytes: files.reduce((n, f) => n + f.bytes, 0),
    };
  }
  return pins;
}

/**
 * Check the big inputs (hashes against their pins). build runs it; serve.mjs --dev runs it once.
 * @returns {Promise<string[]>} problems, each with the command that fixes it
 */
export async function verifyInputs() {
  const dirs = inputDirs();
  const problems = [];
  const info = await relateWasm.check(RELATE);
  if (!info.ok) problems.push(`Relate ${RELATE} WASM: ${info.reason}`);
  try { relateLicense(); } catch (e) { problems.push(e instanceof Error ? e.message : String(e)); }
  const built = path.join(dirs.gliner, '.built');
  if (!fs.existsSync(built)) problems.push(`no gliner-rs build in ${rel(dirs.gliner)}: run scripts/build-gliner-wasm.sh`);
  else {
    const text = fs.readFileSync(built, 'utf8');
    if (!text.split('\n').includes(`gliner-rs ${GLINER_REV}`)) problems.push(`${rel(built)} is not a build of gliner-rs ${GLINER_REV.slice(0, 7)}: run scripts/build-gliner-wasm.sh --force`);
    const sums = new Map((text.split('\n---\n')[1] ?? '').trim().split('\n').filter(Boolean).map((l) => l.split(/\s+/)).map(([s, p]) => [p, s]));
    for (const f of ['gliner_rs.js', 'gliner_rs_bg.wasm', 'LICENSE']) {
      const p = path.join(dirs.gliner, f);
      if (!fs.existsSync(p) || sha256(read(p)) !== sums.get(f)) problems.push(`${rel(p)} does not match ${rel(built)}: run scripts/build-gliner-wasm.sh --force`);
    }
  }
  for (const f of [...VENDOR_BUNDLES.flatMap((b) => [b, `${b}.LEGAL.txt`, `${b}.meta.json`]), 'NVL-LICENSE.txt']) {
    if (!fs.existsSync(path.join(dirs.vendor, f))) problems.push(`no web/vendor/${f}: run npm run vendor (after npm ci --omit=peer)`);
  }
  if (!problems.some((p) => p.includes('web/vendor/'))) {
    try { nvlNotices(dirs); } catch (e) { problems.push(e instanceof Error ? e.message : String(e)); }
  }
  const crates = path.join(dirs.gliner, 'THIRD_PARTY-crates.txt');
  if (fs.existsSync(built) && fs.existsSync(crates)) {
    const listed = (fs.readFileSync(built, 'utf8').split('\n---\n')[1] ?? '').split('\n').map((l) => l.split(/\s+/)).find(([, f]) => f === 'THIRD_PARTY-crates.txt');
    if (listed && listed[0] !== sha256(read(crates))) problems.push(`${rel(crates)} does not match ${rel(built)}: run scripts/build-gliner-wasm.sh --force`);
  }
  for (const f of ['ontology-graph-spec.js', 'ontology-graph-spec.js.meta.json']) {
    if (!fs.existsSync(path.join(dirs.vendor, f))) problems.push(`no web/vendor/${f}: run npm run vendor (after npm ci --omit=peer)`);
  }
  for (const [pkg, want] of [['@neo4j-nvl/base', NVL_VERSION], ['@neo4j-nvl/interaction-handlers', NVL_VERSION], ['@neo4j/ontology-graph-spec', OGS_SDK_VERSION]]) {
    const got = readJson(path.join(dirs.modules, pkg, 'package.json'))?.version;
    if (got !== want) problems.push(`node_modules/${pkg} is ${got ?? 'missing'}, the page ships ${want}: run npm ci --omit=peer`);
  }
  // Model sizes against the cache, when it has the files (the pins come from ci/, the sizes from here).
  try {
    for (const [key, m] of Object.entries(modelPins())) {
      for (const f of m.files) {
        const p = path.join(dirs.models, m.dir, f.name);
        if (fs.existsSync(p) && fs.statSync(p).size !== f.bytes) problems.push(`${rel(p)} is ${fs.statSync(p).size} bytes; build.mjs MODEL_SIZES.${key} says ${f.bytes}`);
      }
    }
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  return problems;
}

/** @param {string} p */
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ---- the NVL bundles' notices ---------------------------------------------------------------------

/** A package's own licence or notice file: LICENSE, LICENCE, COPYING, NOTICE, with any extension. */
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-][^/]*)?$/i;
const REFERENCE = /For license information please see (\S+?)(?:\s*\*\/|\s|$)/g;
/** @type {{key: string, value: ReturnType<typeof collectNotices>} | null} */
let noticeCache = null;

/**
 * What assets/nvl-<ver>/ ships besides the bundles, so every licence the bundles carry or point
 * to is in dist/: {files: [[dist name, source path]], index: THIRD_PARTY-npm.txt's text}. Read from
 * esbuild's metafiles (`npm run vendor` writes them next to each bundle): the npm packages whose
 * modules went into a bundle, and the .LEGAL.txt files' "For license information please see X"
 * references, resolved next to the module they came from. Cached on the metafiles' mtimes, since
 * harness/serve.mjs --dev plans per request. Throws BuildError when a reference cannot be resolved.
 * @param {ReturnType<typeof inputDirs>} dirs
 */
export function nvlNotices(dirs) {
  const metas = VENDOR_BUNDLES.map((b) => path.join(dirs.vendor, `${b}.meta.json`));
  const key = metas.map((m) => `${m}:${fs.existsSync(m) ? fs.statSync(m).mtimeMs : 'none'}`).join('|');
  if (noticeCache?.key !== key) noticeCache = { key, value: collectNotices(dirs) };
  return noticeCache.value;
}

/** @param {ReturnType<typeof inputDirs>} dirs */
function collectNotices(dirs) {
  /** @type {Map<string, string>} dist name -> source */
  const files = new Map();
  const ship = (/** @type {string} */ name, /** @type {string} */ from) => {
    if (VENDOR_BUNDLES.some((b) => name === b || name === `${b}.LEGAL.txt`) || name === 'NVL-LICENSE.txt' || name === 'THIRD_PARTY-npm.txt') {
      throw new BuildError(`assets/nvl-${NVL_VERSION}/${name}: a notice would overwrite a file npm run vendor writes`);
    }
    const had = files.get(name);
    if (had && had !== from && !read(had).equals(read(from))) throw new BuildError(`assets/nvl-${NVL_VERSION}/${name}: two different notices (${rel(had)}, ${rel(from)})`);
    files.set(name, from);
  };
  /** @type {Set<string>} module paths (relative to this example) that went into a bundle */
  const inputs = new Set();
  for (const b of VENDOR_BUNDLES) {
    const meta = readJson(path.join(dirs.vendor, `${b}.meta.json`));
    if (!meta?.inputs || !meta?.outputs) throw new BuildError(`web/vendor/${b}.meta.json is missing or not an esbuild metafile: run npm run vendor`);
    // Only modules that put bytes into an output were bundled. meta.inputs also lists tree-shaken
    // modules: NVL's @segment/* analytics packages appear there (117 files) with 0 bytes in nvl.js.
    for (const out of Object.values(meta.outputs)) {
      for (const [k, v] of Object.entries(out.inputs ?? {})) if (v.bytesInOutput > 0) inputs.add(k);
    }
  }
  // 1. The files the legal comments refer to, shipped under the name the comment uses.
  for (const b of VENDOR_BUNDLES) {
    const legal = fs.readFileSync(path.join(dirs.vendor, `${b}.LEGAL.txt`), 'utf8');
    /** @type {Array<[string, string]>} [module, the text that follows its heading] */
    const sections = [];
    for (const line of legal.split('\n')) {
      const m = /^(\S.*):$/.exec(line);
      if (m && line !== 'Bundled license information:') sections.push([m[1], '']);
      else if (sections.length) sections[sections.length - 1][1] += `${line}\n`;
    }
    for (const [mod, body] of sections) {
      const input = [...inputs].find((k) => k === mod || k.endsWith(`/${mod}`));
      for (const ref of body.matchAll(REFERENCE)) {
        if (!input) throw new BuildError(`web/vendor/${b}.LEGAL.txt: ${mod} refers to ${ref[1]}, but the metafile lists no such module`);
        let from = path.join(EX, path.dirname(input), ref[1]);
        if (!fs.existsSync(from)) throw new BuildError(`web/vendor/${b}.LEGAL.txt: ${mod} refers to ${ref[1]}, and ${rel(from)} does not exist`);
        // A referenced file may refer on in turn: follow the chain (each file once).
        for (const seen = new Set(); !seen.has(from); ) {
          seen.add(from);
          ship(path.basename(from), from);
          const next = [...fs.readFileSync(from, 'utf8').matchAll(REFERENCE)][0]?.[1];
          if (!next) break;
          from = path.join(path.dirname(from), next);
          if (!fs.existsSync(from)) throw new BuildError(`${rel([...seen].pop() ?? from)} refers to ${next}, which does not exist`);
        }
      }
    }
  }
  // 2. Every bundled npm package's own licence file(s), and the index.
  /** @type {Map<string, string>} package root (relative) -> name */
  const roots = new Map();
  for (const k of inputs) {
    const i = k.lastIndexOf('node_modules/');
    if (i < 0) continue; // this example's own entry
    const parts = k.slice(i + 'node_modules/'.length).split('/');
    const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    roots.set(`${k.slice(0, i)}node_modules/${name}`, name);
  }
  const nvlLicense = path.join(dirs.vendor, 'NVL-LICENSE.txt');
  const lines = [
    `Third-party npm packages bundled into nvl.js and HierarchicalLayout.worker.js (NVL ${NVL_VERSION}, npm run vendor),`,
    'from esbuild\'s metafiles: package, version, the licence its package.json declares, and the file in this',
    'directory that holds its licence text. The bundles\' own legal comments are in nvl.js.LEGAL.txt and',
    'HierarchicalLayout.worker.js.LEGAL.txt; the files they refer to are here under the names they use.',
    '',
  ];
  for (const [root, name] of [...roots].sort((a, b) => cmp(a[1], b[1]) || cmp(a[0], b[0]))) {
    const dir = path.join(EX, root);
    const pkg = readJson(path.join(dir, 'package.json'));
    if (!pkg?.version) throw new BuildError(`${rel(path.join(dir, 'package.json'))} is missing: run npm ci --omit=peer`);
    const declared = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? null);
    const own = fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort(cmp);
    const shipped = [];
    for (const f of own) {
      const from = path.join(dir, f);
      if (fs.existsSync(nvlLicense) && read(from).equals(read(nvlLicense))) { shipped.push('NVL-LICENSE.txt'); continue; }
      const stem = f.replace(/\..*$/, '').toUpperCase();
      const to = `${stem}-${name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.txt`;
      ship(to, from);
      shipped.push(to);
    }
    lines.push(`${name} ${pkg.version}  ${declared}  ${shipped.length ? shipped.join(', ') : '(the package ships no licence file)'}`);
  }
  return { files: [...files].sort((a, b) => cmp(a[0], b[0])), index: `${lines.join('\n')}\n` };
}

// ---- the plan -------------------------------------------------------------------------------------

/**
 * @typedef {{from?: string, data?: () => Buffer}} Entry  a file of dist/: copied from `from`, or generated
 */

// ---- module syntax ---------------------------------------------------------------------------------

/** Keywords after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'instanceof', 'yield', 'await']);
/** Punctuators after which a `/` starts a regular expression. */
const REGEX_AFTER_PUNCT = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const LINE_END = /[\n\r\u2028\u2029]/;
/** Identifier characters (surrogate halves count, so an identifier with an astral letter stays one token). */
const ID_START = /[\p{ID_Start}$_\ud800-\udfff]/u;
const ID_PART = /[\p{ID_Continue}$\u200c\u200d\ud800-\udfff]/u;

/**
 * The tokens of a JavaScript module that module syntax is made of: names (identifiers and keywords),
 * string literals (with the offsets of their contents) and single punctuator characters. Comments,
 * template literals (their `${}` expressions are tokenised), regular-expression literals and
 * numbers are consumed and not returned, so nothing inside a string, a comment or a template is
 * ever read as an import. Throws BuildError on an unterminated string, template or comment.
 * @param {string} src
 * @returns {Array<{t: 'name'|'string'|'punct', v: string, start: number, end: number}>}
 *   for a string, v is its raw contents and start/end their offsets (inside the quotes)
 */
export function moduleTokens(src) {
  /** @type {Array<{t: 'name'|'string'|'punct', v: string, start: number, end: number}>} */
  const out = [];
  /** the last significant token (regex or division?): a name, a punctuator, or 'value' for a literal */
  let prev = /** @type {{t: string, v: string} | null} */ (null);
  /** brace depth per open template expression, innermost last */
  const templates = [];
  const n = src.length;
  let i = 0;
  const fail = (/** @type {string} */ what, /** @type {number} */ at) => {
    const line = src.slice(0, at).split('\n').length;
    throw new BuildError(`line ${line}: ${what}`);
  };
  /** Scan template text from i (after ` or after the } that closes a ${}) to its end or the next ${. */
  const templateText = () => {
    for (;;) {
      if (i >= n) fail('unterminated template literal', i);
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; prev = { t: 'value', v: '`' }; return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; templates.push(0); prev = { t: 'punct', v: '{' }; return; }
      i++;
    }
  };
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; } // \s: Unicode spaces, line terminators and the BOM
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && !LINE_END.test(src[i])) i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) fail('unterminated comment', i);
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i + 1;
      let j = start;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n' || src[j] === '\r') fail('unterminated string literal', i);
        j++;
      }
      if (j >= n) fail('unterminated string literal', i);
      out.push({ t: 'string', v: src.slice(start, j), start, end: j });
      prev = { t: 'value', v: c };
      i = j + 1;
      continue;
    }
    if (c === '`') { i++; templateText(); continue; }
    if (c === '/') {
      const regex = prev === null || (prev.t === 'punct' && REGEX_AFTER_PUNCT.has(prev.v)) || (prev.t === 'name' && REGEX_AFTER_WORD.has(prev.v));
      if (regex) {
        let j = i + 1;
        let inClass = false;
        for (;;) {
          if (j >= n || src[j] === '\n' || src[j] === '\r') fail('unterminated regular expression', i);
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) break;
          j++;
        }
        j++;
        while (j < n && /[A-Za-z]/.test(src[j])) j++; // flags
        i = j;
        prev = { t: 'value', v: '/' };
        continue;
      }
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(src[j])) j++;
      const v = src.slice(i, j);
      out.push({ t: 'name', v, start: i, end: j });
      prev = { t: 'name', v };
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j])) j++;
      i = j;
      prev = { t: 'value', v: '0' };
      continue;
    }
    // A punctuator, one character at a time; braces track template expressions.
    if (c === '{' && templates.length) templates[templates.length - 1]++;
    if (c === '}' && templates.length) {
      if (templates[templates.length - 1] === 0) {
        templates.pop();
        i++;
        templateText();
        continue;
      }
      templates[templates.length - 1]--;
    }
    out.push({ t: 'punct', v: c, start: i, end: i + 1 });
    prev = { t: 'punct', v: c };
    i++;
  }
  if (templates.length) fail('unterminated template expression', n);
  return out;
}

/**
 * The import specifiers of an ES module, read from its module syntax only (moduleTokens): a static
 * `import 'x'`, `import … from 'x'`, `export * from 'x'`, `export {…} from 'x'`, and a dynamic
 * `import('x')` whose argument is a lone string. Never `from` or `import` inside a string, a
 * comment, a template or a regular expression, and never `x.import`. A dynamic import of a
 * computed URL is left alone. Throws BuildError on an import or export statement it cannot read.
 * @param {string} src
 * @returns {Array<{spec: string, start: number, end: number, kind: 'static'|'export'|'dynamic'}>}
 */
export function importSpecifiers(src) {
  const tk = moduleTokens(src);
  /** @type {Array<{spec: string, start: number, end: number, kind: 'static'|'export'|'dynamic'}>} */
  const out = [];
  const at = (/** @type {number} */ k) => tk[k] ?? { t: 'eof', v: '', start: src.length, end: src.length };
  const is = (/** @type {number} */ k, /** @type {string} */ t, /** @type {string} */ v) => at(k).t === t && at(k).v === v;
  const line = (/** @type {number} */ k) => src.slice(0, at(k).start).split('\n').length;
  /** From k (just after `import` or `export`), the `from '<spec>'` that ends the clause. */
  const fromClause = (/** @type {number} */ k, /** @type {string} */ what) => {
    let depth = 0;
    for (; k < tk.length; k++) {
      const x = tk[k];
      if (x.t === 'punct' && x.v === '{') depth++;
      else if (x.t === 'punct' && x.v === '}') depth--;
      else if (depth === 0 && x.t === 'name' && x.v === 'from' && at(k + 1).t === 'string') return k + 1;
      else if (depth === 0 && x.t === 'punct' && x.v === ';') break;
      else if (x.t === 'string' && depth === 0) break;
    }
    throw new BuildError(`line ${line(k)}: ${what} with no \`from '…'\` build.mjs can read`);
  };
  for (let k = 0; k < tk.length; k++) {
    const x = tk[k];
    // `x.import`, `x?.import` and a key (`{import: 1}`) are not module syntax.
    if (x.t !== 'name' || (x.v !== 'import' && x.v !== 'export') || is(k - 1, 'punct', '.') || is(k + 1, 'punct', ':')) continue;
    if (x.v === 'import') {
      if (is(k + 1, 'punct', '.')) continue; // import.meta
      if (is(k + 1, 'punct', '(')) {
        const s = at(k + 2);
        if (s.t === 'string' && (is(k + 3, 'punct', ')') || is(k + 3, 'punct', ','))) out.push({ spec: s.v, start: s.start, end: s.end, kind: 'dynamic' });
        continue;
      }
      if (at(k + 1).t === 'string') {
        out.push({ spec: at(k + 1).v, start: at(k + 1).start, end: at(k + 1).end, kind: 'static' });
        continue;
      }
      const s = fromClause(k + 1, 'an import statement');
      out.push({ spec: tk[s].v, start: tk[s].start, end: tk[s].end, kind: 'static' });
      k = s;
      continue;
    }
    // export: only `export * …` and `export {…} from` name another module
    if (is(k + 1, 'punct', '*')) {
      const s = fromClause(k + 1, 'an export * statement');
      out.push({ spec: tk[s].v, start: tk[s].start, end: tk[s].end, kind: 'export' });
      k = s;
    } else if (is(k + 1, 'punct', '{')) {
      let depth = 0;
      let j = k + 1;
      for (; j < tk.length; j++) {
        if (is(j, 'punct', '{')) depth++;
        else if (is(j, 'punct', '}') && --depth === 0) break;
      }
      if (is(j + 1, 'name', 'from') && at(j + 2).t === 'string') {
        out.push({ spec: at(j + 2).v, start: at(j + 2).start, end: at(j + 2).end, kind: 'export' });
        k = j + 2;
      }
    }
  }
  return out;
}

/**
 * Rewrite one module's import specifiers to dist-relative paths. The specifiers are read from the
 * module's import and export statements (importSpecifiers), never by a text pattern, so a `from`
 * followed by a quote anywhere else (a string, a comment, ordinary code) is left alone.
 * @param {string} text  the module's source
 * @param {string} at    its path in dist/
 * @param {Map<string, string>} map   specifier as written -> dist path
 * @param {(p: string) => boolean} exists  whether a dist path is planned
 * @param {string} where  for messages
 */
export function rewriteImports(text, at, map, exists, where) {
  /** @type {Array<{spec: string, start: number, end: number}>} */
  let found;
  try {
    found = importSpecifiers(text);
  } catch (e) {
    if (e instanceof BuildError) throw new BuildError(`${where}: ${e.message}`);
    throw e;
  }
  /** @type {Array<[number, number, string]>} */
  const edits = [];
  for (const { spec, start } of found) {
    let target = map.get(spec);
    if (!target) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) throw new BuildError(`${where}: import ${JSON.stringify(spec)} is a bare specifier build.mjs does not map`);
      target = path.posix.normalize(path.posix.join(path.posix.dirname(at), spec));
      if (target.startsWith('../')) throw new BuildError(`${where}: import ${JSON.stringify(spec)} leaves dist/ and build.mjs does not map it`);
    }
    if (!exists(target)) throw new BuildError(`${where}: import ${JSON.stringify(spec)} resolves to ${target}, which is not in dist/`);
    let out = path.posix.relative(path.posix.dirname(at), target);
    if (!out.startsWith('.')) out = `./${out}`;
    if (out !== spec) edits.push([start, start + spec.length, out]);
  }
  let result = text;
  for (const [a, b, s] of edits.sort((x, y) => y[0] - x[0])) result = result.slice(0, a) + s + result.slice(b);
  return result;
}

/**
 * Every file of dist/ and where it comes from. Cheap: it reads only small files (the lib hash,
 * package versions, the listings), so harness/serve.mjs --dev can call it per request.
 * @returns {Map<string, Entry>}
 */
export function plan() {
  const dirs = inputDirs();
  /** @type {Map<string, Entry>} */
  const files = new Map();
  const add = (/** @type {string} */ to, /** @type {Entry} */ e) => {
    if (files.has(to)) throw new BuildError(`dist/${to} planned twice`);
    files.set(to, e);
  };

  // assets/ (versioned)
  for (const f of relateFiles(dirs.wasm)) add(`assets/relate-${RELATE}/${f}`, { from: path.join(dirs.wasm, f) });
  // The npm package ships no licence file: Relate's Apache-2.0 text, from relatedb/relate at tag v<RELATE>,
  // is committed as data/LICENSE-relate.txt and checked against its pin here.
  add(`assets/relate-${RELATE}/LICENSE.txt`, { data: () => relateLicense() });
  add(`assets/${GLINER_DIR_NAME}/gliner_rs.js`, { from: path.join(dirs.gliner, 'gliner_rs.js') });
  add(`assets/${GLINER_DIR_NAME}/gliner_rs_bg.wasm`, { from: path.join(dirs.gliner, 'gliner_rs_bg.wasm') });
  add(`assets/${GLINER_DIR_NAME}/LICENSE.txt`, { from: path.join(dirs.gliner, 'LICENSE') });
  // Every crate linked into the .wasm, when scripts/build-gliner-wasm.sh wrote the list (newer builds do).
  const crates = path.join(dirs.gliner, 'THIRD_PARTY-crates.txt');
  if (fs.existsSync(crates)) add(`assets/${GLINER_DIR_NAME}/THIRD_PARTY-crates.txt`, { from: crates });
  for (const f of [...VENDOR_BUNDLES.flatMap((b) => [b, `${b}.LEGAL.txt`]), 'NVL-LICENSE.txt']) {
    add(`assets/nvl-${NVL_VERSION}/${f}`, { from: path.join(dirs.vendor, f) });
  }
  const notices = nvlNotices(dirs);
  for (const [f, from] of notices.files) add(`assets/nvl-${NVL_VERSION}/${f}`, { from });
  add(`assets/nvl-${NVL_VERSION}/THIRD_PARTY-npm.txt`, { data: () => Buffer.from(notices.index) });
  const yamlPkg = readJson(path.join(dirs.modules, 'js-yaml/package.json'));
  if (!yamlPkg?.version) throw new BuildError('no node_modules/js-yaml: run npm ci --omit=peer');
  const yamlDir = `assets/js-yaml-${yamlPkg.version}`;
  add(`${yamlDir}/js-yaml.js`, { from: path.join(dirs.modules, 'js-yaml/dist/js-yaml.mjs') });
  add(`${yamlDir}/LICENSE.txt`, { from: path.join(dirs.modules, 'js-yaml/LICENSE') });
  const ogsDir = `assets/ontology-graph-spec-${OGS_SDK_VERSION}`;
  add(`${ogsDir}/ontology-graph-spec.js`, { from: path.join(dirs.vendor, 'ontology-graph-spec.js') });
  add(`${ogsDir}/LICENSE.txt`, { from: path.join(EX, 'data/ontology-spec/LICENSE-graph-spec.txt') });
  add(`${ogsDir}/THIRD_PARTY.txt`, {
    data: () => Buffer.from([
      `npm @neo4j/ontology-graph-spec ${OGS_SDK_VERSION} (neo4j/ontology-graph-spec, Apache-2.0: LICENSE.txt), bundled by npm run vendor.`,
      'Its modules are Kotlin/JS output, with these Kotlin libraries compiled in:',
      ...OGS_SDK_RUNTIME.map((x) => `  ${x}`),
      'The Apache License 2.0 text is LICENSE.txt.',
      '',
    ].join('\n')),
  });
  const libSrc = { 'replay.js': path.join(ROOT, 'lib/replay.mjs'), 'relate_wasm.js': path.join(ROOT, 'lib/relate_wasm.mjs'), 'ogs.js': path.join(ROOT, 'lib/ogs.mjs') };
  const libHash = sha256(Buffer.concat(Object.values(libSrc).flatMap((p) => [read(p), Buffer.from([0])]))).slice(0, 8);
  const libDir = `assets/lib-${libHash}`;

  /** specifiers the page's modules use -> dist paths */
  const map = new Map([
    ['../../../lib/replay.mjs', `${libDir}/replay.js`],
    ['../../../lib/relate_wasm.mjs', `${libDir}/relate_wasm.js`],
    ['../../../lib/ogs.mjs', `${libDir}/ogs.js`],
    ['js-yaml', `${yamlDir}/js-yaml.js`],
    ['@neo4j/ontology-graph-spec', `${ogsDir}/ontology-graph-spec.js`],
    ['./vendor/nvl.js', `assets/nvl-${NVL_VERSION}/nvl.js`],
  ]);
  const exists = (/** @type {string} */ p) => files.has(p) || [...WEB_MODULES, ...Object.keys(libSrc).map((f) => `${libDir}/${f}`)].includes(p);
  const transform = (/** @type {string} */ src, /** @type {string} */ at, /** @type {(t: string) => string} */ extra = (t) => t) =>
    () => Buffer.from(extra(rewriteImports(fs.readFileSync(src, 'utf8'), at, map, exists, rel(src))));
  for (const [f, src] of Object.entries(libSrc)) add(`${libDir}/${f}`, { data: transform(src, `${libDir}/${f}`) });

  // the page
  const webDir = path.join(EX, 'web');
  const extra = fs.readdirSync(webDir).filter((f) => /\.(m?js|html|css)$/.test(f) && !WEB_MODULES.includes(f) && !WEB_STATIC.includes(f) && !WEB_INPUTS.has(f));
  if (extra.length) throw new BuildError(`web/${extra[0]} is not in build.mjs's WEB_MODULES or WEB_STATIC: add it, or keep it out of web/`);
  const pinsJson = JSON.stringify(modelPins());
  for (const f of WEB_MODULES) {
    const src = path.join(webDir, f);
    if (f === 'models.js') {
      add(f, {
        data: transform(src, f, (t) => {
          const marker = '/*@ex01:model-pins*/null';
          if (t.split(marker).length !== 2) throw new BuildError(`web/models.js must contain ${marker} exactly once`);
          return t.replace(marker, () => `/*@ex01:model-pins*/${pinsJson}`);
        }),
      });
    } else add(f, { data: transform(src, f) });
  }
  for (const f of WEB_STATIC) add(f, { from: path.join(webDir, f) });

  // data and queries
  const dataDir = path.join(EX, 'data');
  // The ontologies, as Ontology Graph Spec 1.1 documents, in two families (index.json is the page's list):
  // the curated domains (data/ontologies/domains/, D20) and Neo4j's solution packages converted with this
  // repository's overlays (data/ontologies/ogs/studio/, harness/convert.mjs, D21). Each package's human
  // description ships for the page's About drawer, and its NOTICE (FIBO's copyright lines) with it. The base,
  // _base.yaml, ships for a create-context-graph file pasted or uploaded into the page (its `inherits: _base`).
  const docs = (/** @type {string} */ dir) => (fs.existsSync(path.join(dataDir, 'ontologies', dir))
    ? fs.readdirSync(path.join(dataDir, 'ontologies', dir)).filter((f) => f.endsWith('.ontology.yaml')).sort(cmp).map((f) => `${dir}/${f}`) : []);
  const curated = docs('domains');
  const studio = docs('ogs/studio');
  for (const f of [...curated, ...studio]) {
    if (!/^(?:domains|ogs\/studio)\/[A-Za-z0-9_-]+\.ontology\.yaml$/.test(f)) throw new BuildError(`data/ontologies/${f} is not a plain .ontology.yaml name`);
    add(`data/ontologies/${f}`, { from: path.join(dataDir, 'ontologies', f) });
  }
  if (!curated.length) throw new BuildError('data/ontologies/domains/ has no curated documents');
  if (!studio.length) throw new BuildError('data/ontologies/ogs/studio/ has no converted packages: run node harness/convert.mjs');
  for (const f of ['domains/SOURCE.md', 'ogs/SOURCE.md', 'studio/SOURCE.md', 'studio/manifest.json']) {
    if (fs.existsSync(path.join(dataDir, 'ontologies', f))) add(`data/ontologies/${f}`, { from: path.join(dataDir, 'ontologies', f) });
  }
  for (const f of studio) {
    const pkg = path.basename(f, '.ontology.yaml');
    for (const g of ['human_description.md', 'NOTICE.md']) {
      const src = path.join(dataDir, 'ontologies', 'studio', pkg, g);
      if (fs.existsSync(src)) add(`data/ontologies/studio/${pkg}/${g}`, { from: src });
    }
  }
  const bases = fs.readdirSync(path.join(dataDir, 'ontologies', 'ccg')).filter((f) => /^_[A-Za-z0-9_-]+\.yaml$/.test(f)).sort(cmp);
  if (!bases.includes('_base.yaml')) throw new BuildError('data/ontologies/ccg/_base.yaml is missing: a pasted create-context-graph file inherits it');
  for (const f of [...bases, 'SOURCE.md', 'LICENSE-create-context-graph.txt']) add(`data/ontologies/ccg/${f}`, { from: path.join(dataDir, 'ontologies/ccg', f) });
  for (const f of ['ontology-graph-spec.schema.json', 'LICENSE-graph-spec.txt', 'SOURCE.md']) add(`data/ontology-spec/${f}`, { from: path.join(dataDir, 'ontology-spec', f) });
  const index = {
    bases: Object.fromEntries(bases.map((f) => [f.replace(/\.yaml$/, ''), `ccg/${f}`])),
    groups: [
      { id: 'domains', label: 'Curated domains', files: curated },
      { id: 'studio', label: "Neo4j's solution packages", files: studio },
    ],
  };
  add('data/ontologies/index.json', { data: () => Buffer.from(`${JSON.stringify(index, null, 2)}\n`) });
  const samples = JSON.parse(fs.readFileSync(path.join(dataDir, 'samples/samples.json'), 'utf8'));
  add('data/samples/samples.json', { from: path.join(dataDir, 'samples/samples.json') });
  for (const s of [...samples].sort((a, b) => cmp(a.file, b.file))) {
    if (!/^(?:[A-Za-z0-9_-]+\/){0,2}[A-Za-z0-9_-]+\.md$/.test(s.file)) throw new BuildError(`data/samples/samples.json: ${JSON.stringify(s.file)} is not a plain .md name`);
    add(`data/samples/${s.file}`, { from: path.join(dataDir, 'samples', s.file) });
  }
  add('data/LICENSE-edgextract.txt', { from: path.join(dataDir, 'LICENSE-edgextract.txt') });
  add('data/SOURCE.md', { from: path.join(dataDir, 'SOURCE.md') });
  add('THIRD_PARTY.md', { from: path.join(EX, 'THIRD_PARTY.md') });
  return new Map([...files].sort((a, b) => cmp(a[0], b[0])));
}

/** The bytes of one planned file. @param {Entry} e */
export function contents(e) {
  if (e.data) return e.data();
  return read(/** @type {string} */ (e.from));
}

// ---- the build ------------------------------------------------------------------------------------

/**
 * Write dist/ (or `out`): checks first, writes into a sibling temporary directory, scans it as
 * site/build.mjs will, then swaps it in. Throws BuildError with every problem.
 * @param {{out?: string, log?: (s: string) => void}} [opts]
 */
export async function build({ out = path.join(EX, 'dist'), log = (s) => process.stderr.write(`build.mjs: ${s}\n`) } = {}) {
  const problems = await verifyInputs();
  if (problems.length) throw new BuildError(problems.join('\n'));
  const files = plan();
  const dest = path.resolve(out);
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  let bytes = 0;
  try {
    for (const [to, e] of files) {
      const target = path.join(tmp, ...to.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const data = contents(e);
      fs.writeFileSync(target, data, { mode: 0o644 });
      bytes += data.length;
    }
    const hits = scanTree(tmp);
    if (hits.length) {
      throw new BuildError(hits.map((x) => `dist/${x.file}:${x.line}: ${x.kind} URL ${JSON.stringify(x.url)} (${x.what})`).join('\n'));
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  log(`wrote ${rel(dest)}/: ${files.size} files, ${(bytes / 1e6).toFixed(1)} MB`);
  return { out: dest, files: files.size, bytes };
}

async function main(argv) {
  let out;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) out = path.resolve(argv[++i]);
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log('usage: node build.mjs [--out <dir>]   (npm run build runs npm run vendor first)');
      return 0;
    } else {
      console.error(`build.mjs: unknown argument ${argv[i]}`);
      return 2;
    }
  }
  try {
    await build({ out });
    return 0;
  } catch (e) {
    if (!(e instanceof BuildError)) throw e;
    for (const line of e.message.split('\n')) console.error(`build.mjs: ${line}`);
    console.error('build.mjs: FAILED; dist/ was not changed');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
