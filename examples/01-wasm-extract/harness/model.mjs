// harness/model.mjs: gliner-rs's WASM build in Node, held to the Python gliner2 reference.
// Prints expected/model.txt's content on stdout; timings and notes go to stderr.
//
//   node harness/model.mjs > out/model.txt 2> out/model.err
//
// Inputs, by the scripts' conventions (each overridable by its export line's variable):
//   GLINER_WASM_DIR   <repo>/.cache/gliner-wasm/4fa741e               scripts/build-gliner-wasm.sh
//   GLINER_SMALL_DIR  <repo>/.cache/gliner/gliner2.5-small-v1@7132dc4  scripts/fetch-gliner.sh small
//   data/reference/gliner2-small.json                                  harness/reference.py
// It checks the build against .built (and ci/gliner-rs-4fa741e.sha256 when present), the weights'
// .verified marker against ci/gliner2.5-small-v1.sha256, and the fixture against both.
//
// The fixture is recorded on the Financial Services sample under the schema the page asks for that
// domain; this checks it is still that schema (pipeline.modelSchema of its document), so the parity
// covers what the page asks: kinds by label text, some with a description and some bare.
// What it prints (G5-G11): per case, whether gliner-rs finds the reference's span and edge sets
// and how far the scores are apart; that a repeated call returns the same bytes; that offsets
// are code points (UTF-16 shown beside them); one span under two labels; and the long-input
// collapse, a pin: when recall recovers it prints `PIN: G10 changed ...` and exits 1.
// Exit 0 when everything holds, 1 on a parity failure or a pin change, 2 when an input is missing.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODEL_FILES, checkSchema, extractRaw, loadModel, memoryBytes, normalize, utf16Index } from '../web/gliner.js';
import { parseOntology } from '../web/ontology.js';
import { modelSchema } from '../web/pipeline.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = resolve(HERE, '..');
const ROOT = resolve(EXAMPLE, '../..');
const REV = '4fa741eec466660daf4adc8703210138295e0b1b';
const MODEL_REV = '7132dc4561c3f94563c6147e75ffa8ef34c4964a';
const WASM_DIR = process.env.GLINER_WASM_DIR || join(ROOT, '.cache/gliner-wasm', REV.slice(0, 7));
const MODEL_DIR = process.env.GLINER_SMALL_DIR || join(ROOT, '.cache/gliner', `gliner2.5-small-v1@${MODEL_REV.slice(0, 7)}`);
const BUILD_PIN = join(ROOT, 'ci', `gliner-rs-${REV.slice(0, 7)}.sha256`);
const MODEL_PIN = join(ROOT, 'ci', 'gliner2.5-small-v1.sha256');
const FIXTURE = join(EXAMPLE, 'data/reference/gliner2-small.json');

const t0 = performance.now();
const note = (msg) => process.stderr.write(`model.mjs: ${msg}\n`);
const missing = (msg) => { note(msg); process.exit(2); };
const out = [];
const say = (line = '') => out.push(line);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const f3 = (x) => x.toFixed(3);
const rel = (p) => p.startsWith(`${ROOT}/`) ? p.slice(ROOT.length + 1) : p;
const parseSums = (text) => new Map(text.trim().split('\n').map((l) => l.split(/\s+/)).map(([s, p]) => [p, s]));

// ---- inputs
const builtPath = join(WASM_DIR, '.built');
if (!existsSync(builtPath)) missing(`no gliner-rs build in ${rel(WASM_DIR)}; fix: scripts/build-gliner-wasm.sh`);
const built = readFileSync(builtPath, 'utf8');
if (!built.split('\n').includes(`gliner-rs ${REV}`)) missing(`${rel(builtPath)} is not a build of ${REV.slice(0, 7)}`);
const builtSums = parseSums(built.split('\n---\n')[1] ?? '');
for (const f of ['gliner_rs.js', 'gliner_rs_bg.wasm']) {
  if (sha256(readFileSync(join(WASM_DIR, f))) !== builtSums.get(f)) missing(`${rel(join(WASM_DIR, f))} does not match its .built; fix: scripts/build-gliner-wasm.sh --force`);
}
let buildLine = `gliner-rs ${REV.slice(0, 7)} (v0.3.1); its .wasm bytes depend on the build host, so this file pins its behaviour (D4)`;
if (existsSync(BUILD_PIN)) {
  const pin = parseSums(readFileSync(BUILD_PIN, 'utf8'));
  // The pin's files, not .built's: .built also lists files no pin covers (THIRD_PARTY-crates.txt).
  for (const [f, s] of pin) if (builtSums.get(f) !== s) missing(`${rel(WASM_DIR)}/${f} differs from ${rel(BUILD_PIN)}`);
  buildLine = `gliner-rs ${REV.slice(0, 7)} (v0.3.1), every file matches ${rel(BUILD_PIN)}`;
}
const verified = join(MODEL_DIR, '.verified');
if (!existsSync(verified) || !readFileSync(verified).equals(readFileSync(MODEL_PIN))) {
  missing(`no verified weights in ${rel(MODEL_DIR)}; fix: scripts/fetch-gliner.sh small`);
}
const modelPin = parseSums(readFileSync(MODEL_PIN, 'utf8'));
const ref = JSON.parse(readFileSync(FIXTURE, 'utf8'));
if (ref.model.revision !== MODEL_REV) missing(`${rel(FIXTURE)} was recorded at ${ref.model.revision}, not ${MODEL_REV}`);
for (const [f, s] of Object.entries(ref.model.sha256)) {
  if (modelPin.get(f) !== s) missing(`${rel(FIXTURE)} was recorded with another ${f}; re-record: python3 -I harness/reference.py`);
}

// ---- load
const glue = await import(pathToFileURL(join(WASM_DIR, 'gliner_rs.js')).href);
const read = (f) => readFileSync(join(MODEL_DIR, f));
let t = performance.now();
const model = loadModel({
  glue,
  wasmBytes: readFileSync(join(WASM_DIR, 'gliner_rs_bg.wasm')),
  ...Object.fromEntries(Object.entries(MODEL_FILES).map(([arg, f]) => [arg, read(f)])),
});
note(`loaded in ${Math.round(performance.now() - t)} ms, ${memoryBytes(model) >> 20} MiB of WASM memory`);

const schemaOf = (c) => ({
  entities: ref.schema.entities.map(([id, description]) => ({ id, description })),
  relations: c.with_relations ? ref.schema.relations : [],
  threshold: ref.options.threshold,
});

// ---- run every case twice
const runs = new Map();
for (const c of ref.cases) {
  t = performance.now();
  const a = extractRaw(model, c.text, schemaOf(c));
  const ms = performance.now() - t;
  const b = extractRaw(model, c.text, schemaOf(c));
  runs.set(c.id, { raw: a, same: a === b, got: normalize(a, schemaOf(c)) });
  note(`${c.id}: ${Math.round(ms)} ms`);
}

say('model.txt: gliner-rs\'s WASM build in Node, held to the Python gliner2 reference (G5-G11)');
say(`build      ${buildLine}`);
say(`weights    ${ref.model.repo} @ ${MODEL_REV.slice(0, 7)}, every file matches ${rel(MODEL_PIN)}`);
say(`reference  data/reference/gliner2-small.json: gliner2 ${ref.versions.gliner2}, torch ${ref.versions.torch} (CPU, ${ref.torch_threads} thread), the same weights`);
say(`schema     the page's for create-context-graph's Financial Services (pipeline.modelSchema): entities ${ref.schema.entities.map(([id, d]) => (d ? `${id} ("${d}")` : id)).join(', ')};`);
say(`           relations ${ref.schema.relations.map((r) => `"${r}"`).join(', ')}`);
const fsSchema = checkSchema(modelSchema(parseOntology(readFileSync(join(EXAMPLE, 'data/ontologies/ogs/ccg/financial-services.ontology.yaml'), 'utf8'))).schema);
const refSchema = checkSchema({ entities: ref.schema.entities.map(([id, description]) => ({ id, description })), relations: ref.schema.relations, threshold: ref.options.threshold });
const sameSchema = JSON.stringify(fsSchema) === JSON.stringify(refSchema);
say(`           the same as the page asks now: ${sameSchema ? 'yes' : 'NO: re-record the fixture (./run.sh --reference)'}`);
say(`options    threshold ${ref.options.threshold.toFixed(2)} (the inference cache's floor, D7); the checkpoint's overlap policy (flat)`);

// ---- parity (G7)
const bucket = (d) => (d < 1e-5 ? '< 1e-5' : d < 1e-4 ? '< 1e-4' : d < 1e-3 ? '< 1e-3' : '>= 1e-3');
const failures = [];
let maxDiff = 0;
say();
say('parity: the same span and edge sets as the reference; the largest score difference, bucketed (G7)');
say(`${'case'.padEnd(12)}${'tokens'.padStart(7)}${'spans'.padStart(7)}${'edges'.padStart(7)}  ${'sets'.padEnd(10)} max |score diff|`);
for (const c of ref.cases) {
  const { got } = runs.get(c.id);
  const mine = new Map(), theirs = new Map();
  for (const e of got.entities) mine.set(`E ${e.label} ${e.start}..${e.end} ${JSON.stringify(e.text)}`, e.score);
  for (const r of got.relations) mine.set(`R ${r.relation}: ${r.head.start}..${r.head.end} -> ${r.tail.start}..${r.tail.end}`, r.score);
  for (const [label, s, e, text, p] of c.entities) theirs.set(`E ${label} ${s}..${e} ${JSON.stringify(text)}`, p);
  for (const [r, [hs, he], [ts, te], p] of c.relations) theirs.set(`R ${r}: ${hs}..${he} -> ${ts}..${te}`, p);
  const onlyMine = [...mine.keys()].filter((k) => !theirs.has(k));
  const onlyTheirs = [...theirs.keys()].filter((k) => !mine.has(k));
  let d = 0;
  for (const [k, p] of mine) if (theirs.has(k)) d = Math.max(d, Math.abs(p - theirs.get(k)));
  const same = onlyMine.length === 0 && onlyTheirs.length === 0;
  say(`${c.id.padEnd(12)}${String(c.tokens).padStart(7)}${String(got.entities.length).padStart(7)}${String(got.relations.length).padStart(7)}  ${(same ? 'identical' : 'DIFFERENT').padEnd(10)} ${bucket(d)}`);
  for (const k of onlyMine) say(`  only gliner-rs: ${k}`);
  for (const k of onlyTheirs) say(`  only gliner2:   ${k}`);
  if (!same || d >= 1e-5) failures.push(c.id);
  maxDiff = Math.max(maxDiff, d);
}
note(`largest score difference from the reference over every case: ${maxDiff.toExponential(2)}`);

// ---- determinism (G7)
say();
say('repeat: a second call on the same model returns the same JSON string, byte for byte (G7)');
const same = ref.cases.filter((c) => runs.get(c.id).same).length;
say(`${same} of ${ref.cases.length} cases identical`);
if (same !== ref.cases.length) failures.push('repeat');

// ---- offsets (G11)
const off = ref.cases.find((c) => c.id === 'offsets');
say();
say('offsets: Unicode code points, not the UTF-16 units JS strings index by (G11)');
say(`text ${JSON.stringify(off.text)}: ${[...off.text].length} code points, ${off.text.length} UTF-16 units`);
let sliced = true;
for (const e of runs.get('offsets').got.entities) {
  const a = utf16Index(off.text, e.start), b = utf16Index(off.text, e.end);
  sliced &&= off.text.slice(a, b) === e.text;
  say(`${e.label.padEnd(9)}${JSON.stringify(e.text).padEnd(14)} code points ${e.start}..${e.end}, UTF-16 ${a}..${b}, p ${f3(e.score)}`);
}
say(`slicing the JS string at utf16Index(start)..utf16Index(end) gives each mention's text: ${sliced ? 'yes' : 'NO'}`);
if (!sliced) failures.push('offsets');

// ---- one span, two labels (G11)
say();
say('two labels on one span: gliner-rs scores each label on its own (G11)');
for (const id of ['two-labels', ...ref.cases.filter((c) => c.id.startsWith('sentence-')).map((c) => c.id)]) {
  const c = ref.cases.find((x) => x.id === id);
  const bySpan = new Map();
  for (const e of runs.get(id).got.entities) {
    const k = `${e.start}..${e.end} ${JSON.stringify(e.text)}`;
    bySpan.set(k, [...(bySpan.get(k) ?? []), e]);
  }
  for (const [k, es] of bySpan) {
    if (es.length < 2) continue;
    const labels = es.sort((x, y) => y.score - x.score).map((e) => `${e.label} ${f3(e.score)}`).join(', ');
    say(`${id.padEnd(11)} ${k}: ${labels} (${c.with_relations ? 'entities and relations' : 'entities only'})`);
  }
}

// ---- long input (G10), a pin
const long = ref.cases.find((c) => c.id === 'long');
const { unit, copies, separator } = long.repeat;
const unitLen = [...unit].length + [...separator].length;
const gold = new Map(ref.gold.map(([name, type]) => [name, type]));
const pairs = (entities, p) => {
  const found = new Set();
  for (const e of entities) {
    if (e.score < p || gold.get(e.text) !== e.label) continue;
    found.add(`${Math.floor(e.start / unitLen)} ${e.text}`);
  }
  return found.size;
};
const longGot = runs.get('long').got.entities;
const bodyGot = runs.get('body').got.entities;
const sentencesGot = ref.cases.filter((c) => c.id.startsWith('sentence-')).flatMap((c) => runs.get(c.id).got.entities);
const expected = copies * gold.size;
const found50 = pairs(longGot, 0.5), found10 = pairs(longGot, ref.options.threshold);
say();
say('long input collapses: gliner-rs\'s WASM API does not chunk (G10)');
say(`${copies} copies of the body, ${long.tokens} tokens, entities only; a (copy, gold entity) pair counts when found with its gold type`);
say(`pairs found at p >= 0.50: ${found50} of ${expected}`);
say(`pairs found at p >= ${ref.options.threshold.toFixed(2)}: ${found10} of ${expected}`);
say(`for comparison, at p >= 0.50 with relations in the schema: the four sentences one by one ${pairs(sentencesGot, 0.5)} of ${gold.size}, the body as one text ${pairs(bodyGot, 0.5)} of ${gold.size}`);
const collapsed = found10 * 2 <= expected;
say(`pin G10: ${collapsed ? 'holds, at most half the pairs are found' : 'CHANGED'}`);
if (!collapsed) {
  note(`PIN: G10 changed: ${found10} of ${expected} (copy, entity) pairs found on ${long.tokens} tokens (was 24); `
    + 'long inputs no longer collapse in gliner-rs: re-check G10 and the per-sentence design (D7), then update model.txt');
}

process.stdout.write(out.join('\n') + '\n');
note(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
if (failures.length) note(`parity or determinism failed: ${failures.join(', ')}`);
if (!sameSchema) note('the fixture was recorded under another schema than the page asks for Financial Services now: re-record it (./run.sh --reference)');
process.exit(failures.length || !collapsed || !sameSchema ? 1 : 0);
