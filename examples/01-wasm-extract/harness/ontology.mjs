#!/usr/bin/env node
// Ontologies in Relate WASM, pinned (ontology.txt; D5, D8, D14, D15; findings E1-E3, O1-O6;
// NOTES.md R7, R9, R16, R17). In memory, in Node, on npm's @relate/relate-wasm as package-lock.json
// pins it, and the ported splitter and names against edgextract 0.1.0's own WASM (the dev dependency).
//   node harness/ontology.mjs <ver> > out/ontology.txt 2> out/ontology.err
// stdout is diffed: no timings, ids, paths or hashes of unpinned things. A pin that stops
// reproducing, or a parity mismatch nobody explained, prints `PIN: <row> ...` on stderr and
// exits 1 after printing everything else.
//
// Sections: the Ontology Graph Spec 1.1 (data/ontology-spec/: the vendored schema; the 27 bundled documents in
// data/ontologies/ogs/ccg/ equal to a fresh conversion of their originals, read back losslessly; property types and
// tool placement; ajv and web/ogs.js agreeing on every document and on tampered ones; the rules ogs.js adds);
// create-context-graph's 27 domains (their documents, converted from data/ontologies/ccg/ with _base.yaml: counts with
// the base, typed and untyped links with the reason, the graph type read back, the stored document
// and its base, a no-op re-apply; _merge_base; three of them through the gate and publish without
// the model: exact-pair legality, Person OWNS Account, kinds named Entity and Claim); the id rule
// (no leading _: the example's own labels) and the format's refusals; a store an earlier build wrote;
// then a generic document (harness/fixtures.mjs GENERIC_YAML: asked by label text, the same defaults),
// edgextract's YAML refused, and the stores earlier builds made for edgextract's ontologies; the
// graph-type pins on the generic document (O4, O5, R16, data blocking an ALTER, Unicode and keyword ids
// end to end); system_ontologies, which does not exist (O3, R17); the D15 canary; store names (D14); the example's limits
// on a document; parity with edgextract (the splitter on every sample and fixture, names).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as cl from '../../../lib/relate_wasm.mjs';
import { conversions, losses, stale } from './convert.mjs';
import { PROPERTY_TYPES, paramBindings, toolAnchor } from '../web/convert.js';
import yaml from 'js-yaml';
import * as sdk from '@neo4j/ontology-graph-spec';
import { createOgs, DRAFT_MAPPING, VALIDATION_SETS } from '../../../lib/ogs.mjs';
import {
  SCHEMA, SCHEMA_ID, SDK_VERSION, SPEC_VERSION, checkDocument, fromDraft, isDraft, parseDocument, toCanonicalJson, toYaml, validateSchema, validateSpec,
} from '../web/ogs.js';
import * as replay from '../../../lib/replay.mjs';
import { checkSchema, relationPhrase } from '../web/gliner.js';
import { entityName, kindWords, normalizeEntityName } from '../web/names.js';
import {
  applyOntology, currentGraphType, DRAFT_FORMAT, graphTypeSpec, INTERNAL_LABELS, INTERNAL_TYPES, isOntologyId, kindDescription,
  labelText, MAX_ID_CHARS, MAX_TYPES, MIN_TYPES, ONTOLOGY_CONSTRAINTS, ontologyCanary, OntologyApplyError, OntologyError, ontologyFromStored,
  ontologySha, parseOntology, readOntology, RESERVED_PREFIX, storeName,
} from '../web/ontology.js';
import { sha256 } from '../../../lib/replay.mjs';
import { mentionName, modelSchema } from '../web/pipeline.js';
import { offsetMap, splitSentences } from '../web/split.js';
import * as store from '../web/store.js';
import { FIXTURES, GENERIC_TEXT, GENERIC_YAML } from './fixtures.mjs';

const VER = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(VER ?? '')) {
  console.error('usage: node harness/ontology.mjs <ver>');
  process.exit(2);
}
const EX = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(EX, 'data');
const pins = [];
/** A pin: when `ok` is false, the behaviour named by `row` changed. */
function pin(row, ok, expected, got) {
  if (!ok) pins.push(`PIN: ${row} changed: expected ${expected}, got ${got}`);
}
const say = (s = '') => console.log(s);
const section = (s) => say(`\n## ${s}`);
const sub = (s) => say(`\n### ${s}`);
const indent = (text, by = '  ') => text.split('\n').map((l) => by + l).join('\n');
/** An error as one deterministic line. */
function describe(e) {
  if (e instanceof cl.RelateWasmError) return `${e.category}: ${e.message}`;
  if (e instanceof OntologyApplyError) return `OntologyApplyError ${e.code}: ${e.message}`;
  if (e instanceof OntologyError) return `OntologyError: ${e.message}`;
  if (e instanceof store.StoreError) return `StoreError ${e.code}: ${e.message}`;
  return `threw ${e?.constructor?.name ?? typeof e}: ${String(e?.message ?? e).split('\n')[0]}`;
}
/** Run one statement and say what happened; returns the result or the error. */
function show(db, label, q, params = null) {
  try {
    const r = cl.exec(db, q, params);
    say(`${label} -> ${r.columns.length ? JSON.stringify(r.rows) : 'ok'}`);
    return r;
  } catch (e) {
    say(`${label} -> ${describe(e)}`);
    return e;
  }
}
const isErr = (r, pred) => r instanceof Error && pred(r);
const errText = (r) => (r instanceof Error ? describe(r) : `rows ${JSON.stringify(r.rows)}`);
/** JSON with object keys sorted, for comparing two descriptions. */
function canonJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// ---- the engines ----------------------------------------------------------------------------------
const info = await cl.check(VER);
if (!info.ok) {
  console.error(`ontology: ${info.reason}`);
  process.exit(1);
}
const mod = await cl.loadNode(VER);
const fresh = () => new mod.RelateDb();

/** edgextract 0.1.0 (npm, bundler target), instantiated by hand in Node. */
async function loadEdgextract() {
  const dir = join(EX, 'node_modules', '@raphael.mansuy', 'edgextract');
  const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  const bg = await import(pathToFileURL(join(dir, 'edgextract_bg.js')).href);
  const { instance } = await WebAssembly.instantiate(readFileSync(join(dir, 'edgextract_bg.wasm')), { './edgextract_bg.js': bg });
  bg.__wbg_set_wasm(instance.exports);
  instance.exports.__wbindgen_start?.();
  return { bg, version };
}
const ex = await loadEdgextract();

/** A well-formed System One answer to every question: no, NONE / NOT_ENTITY, score 0. */
function zeroModel(_path, body) {
  const answers = {};
  for (const [qid, q] of Object.entries(JSON.parse(body).questions)) {
    if (q.type === 'noul') answers[qid] = { type: 'noul', noul: 0 };
    else if (q.type === 'score') answers[qid] = { type: 'score', score: 0 };
    else {
      const keys = Object.keys(q.criteria);
      const pick = keys.find((k) => k === 'NONE' || k === 'NOT_ENTITY') ?? keys[0];
      answers[qid] = { type: 'choice', choice: pick, probabilities: Object.fromEntries(keys.map((k) => [k, k === pick ? 1 : 0])) };
    }
  }
  return JSON.stringify({ model: 'zero', answers, usage: {} });
}
/** edgextract's finished run of one document: its sentences, mentions and entities. */
function exRun(text, ontologyYaml) {
  const engine = new ex.bg.Engine();
  try {
    const job = engine.start(JSON.stringify({ text, ontology_yaml: ontologyYaml, document_id: 'doc' }), zeroModel);
    try {
      while (!job.done()) job.step();
      return JSON.parse(job.finish());
    } finally {
      job.free();
    }
  } finally {
    engine.free();
  }
}

// ---- store inspection ------------------------------------------------------------------------------
const one = (db, q) => cl.exec(db, q).rows[0].n;
function layer(db) {
  const c = {};
  for (const l of ['_Ontology', '_Kind', '_LinkType', '_Alias']) c[l] = one(db, `MATCH (x:${l}) RETURN count(x) AS n`);
  c._IN = one(db, 'MATCH ()-[r:_IN]->(:_Ontology) RETURN count(r) AS n');
  c._DOMAIN = one(db, 'MATCH (:_LinkType)-[r:_DOMAIN]->(:_Kind) RETURN count(r) AS n');
  c._RANGE = one(db, 'MATCH (:_LinkType)-[r:_RANGE]->(:_Kind) RETURN count(r) AS n');
  c._OF = one(db, 'MATCH (:_Alias)-[r:_OF]->(:_Kind) RETURN count(r) AS n');
  return c;
}
const layerText = (c) => `_Ontology ${c._Ontology}, _Kind ${c._Kind}, _LinkType ${c._LinkType}, _Alias ${c._Alias}; ` +
  `_IN ${c._IN}, _DOMAIN ${c._DOMAIN}, _RANGE ${c._RANGE}, _OF ${c._OF}`;
function constraints(db) {
  const rows = cl.exec(db, 'SHOW CONSTRAINTS YIELD name, type, classification RETURN name, type, classification ORDER BY name').rows;
  return {
    own: rows.filter((r) => r.classification !== 'dependent').map((r) => r.name),
    dependent: rows.filter((r) => r.classification === 'dependent').length,
  };
}
function lookupIndexes(db) {
  // the two built-in LOOKUP indexes every store has (NOTES.md R9) are left out
  return cl.exec(db, "SHOW INDEXES YIELD name, type, indexProvider, owningConstraint WHERE owningConstraint IS NULL AND type <> 'LOOKUP' " +
    'RETURN name, indexProvider ORDER BY name').rows.map((r) => `${r.name} (${r.indexProvider})`);
}
/** The constraint-owned backing indexes, name (provider), `NOT BUILT` when createStatement is null. */
function backingIndexes(db) {
  return cl.exec(db, 'SHOW INDEXES YIELD name, indexProvider, owningConstraint, createStatement WHERE owningConstraint IS NOT NULL ' +
    'RETURN name, indexProvider, createStatement ORDER BY name').rows
    .map((r) => `${r.name} (${r.indexProvider})${r.createStatement == null ? ' NOT BUILT' : ''}`);
}
/** The 4 UNIQUE constraints hold, with no standalone lookup index and every backing index built (R9). */
function keysBuilt(db) {
  const backing = backingIndexes(db);
  return lookupIndexes(db).length === 0 && backing.length === UNIQUES.length && backing.every((b) => !b.endsWith('NOT BUILT')) &&
    UNIQUES.every((u, i) => backing[i].startsWith(`${u} (`));
}
const UNIQUES = ONTOLOGY_CONSTRAINTS.map((s) => /CONSTRAINT (\S+)/.exec(s)[1]).sort();

say(`# Ontologies in Relate WASM ${VER} (harness/ontology.mjs)`);
say('Every ontology is an Ontology Graph Spec 1.1 document (web/ogs.js): parsed by web/ontology.js, kept in an in-memory');
say('store by applyOntology (the D8 layer and a CIP-176 graph type, D15) and read back. The 27 bundled ones are converted');
say('(web/convert.js) from create-context-graph\'s domain files (data/ontologies/ccg/); the page and the harnesses load the');
say('converted documents (data/ontologies/ogs/ccg/), and a create-context-graph file is converted on load. edgextract 0.1.0 (npm,');
say('its own WASM) is the parity oracle for the ported splitter and names.');
say('The example\'s own labels and relationship types all start with _ (_Entity, _Claim, _IN, ...); an ontology id may not.');

// ---- 0. the Ontology Graph Spec 1.1 ------------------------------------------------------------------------
const SPEC_DIR = join(DATA, 'ontology-spec');
const OGS_DIR = join(DATA, 'ontologies', 'ogs');
const BASE_TEXT = readFileSync(join(DATA, 'ontologies', 'ccg', '_base.yaml'), 'utf8');
const DRAFT_FIXTURES = join(EX, 'harness', 'fixtures');
/** ajv 8 (draft 2020-12), the cross-check of web/ogs.js's validator. */
const ajvValidate = (() => {
  const require = createRequire(join(EX, 'package.json'));
  const Ajv2020 = require('ajv/dist/2020').default;
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictNumbers: true });
  return ajv.compile(JSON.parse(readFileSync(join(SPEC_DIR, 'ontology-graph-spec.schema.json'), 'utf8')));
})();
const ajvPkg = (name) => JSON.parse(readFileSync(join(EX, 'node_modules', name, 'package.json'), 'utf8')).version;
/** Both validators on one document: {same, ajv, ogs} with each error as 'path keyword', sorted. */
function bothValidate(doc) {
  ajvValidate(doc);
  const theirs = (ajvValidate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.keyword}`).sort();
  const mine = validateSchema(doc).map((e) => `${e.path || '/'} ${e.keyword}`).sort();
  return { same: canonJson(theirs) === canonJson(mine), ajv: theirs, ogs: mine };
}
section(`the Ontology Graph Spec ${SPEC_VERSION} (data/ontology-spec/: neo4j/ontology-graph-spec release/v0.12.2, Apache-2.0)`);
{
  const file = JSON.parse(readFileSync(join(SPEC_DIR, 'ontology-graph-spec.schema.json'), 'utf8'));
  const keywords = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keywords.add(k); if (!['properties', '$defs'].includes(k)) walk(x); else for (const y of Object.values(x)) walk(y); }
  };
  walk(file);
  say(`schema: ${file.$id} (draft 2020-12; ${Object.keys(file.$defs).length} definitions)`);
  say(`web/ogs.js SCHEMA equals the vendored file: ${canonJson(SCHEMA) === canonJson(file) ? 'yes' : 'NO'}; SCHEMA_ID is its $id: ${SCHEMA_ID === file.$id ? 'yes' : 'NO'}`);
  pin('the vendored schema (web/ogs.js SCHEMA = data/ontology-spec/ontology-graph-spec.schema.json)', canonJson(SCHEMA) === canonJson(file) && SCHEMA_ID === file.$id, 'equal', 'different');
  say(`keywords it uses (the ones web/ogs.js interprets, annotations aside): ${[...keywords].filter((k) => ['$ref', 'type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'const', 'oneOf'].includes(k)).sort().join(', ')}`);
  const sdkPkg = ajvPkg('@neo4j/ontology-graph-spec');
  say(`the SDK: npm @neo4j/ontology-graph-spec ${sdkPkg} (web/ogs.js SDK_VERSION ${SDK_VERSION}), through lib/ogs.mjs`);
  pin('the SDK pin (package.json = web/ogs.js SDK_VERSION)', sdkPkg === SDK_VERSION, SDK_VERSION, sdkPkg);
}
/** @type {Array<{group: string, source: string, file: string, text: string, o: any}>} */
const CONVERTED = conversions();
{
  sub('the bundled documents (data/ontologies/ogs/, harness/convert.mjs): fresh conversions of their originals');
  const bad = stale();
  say(`documents: ${CONVERTED.length}, from create-context-graph (with _base.yaml)`);
  say(`each byte for byte a fresh conversion of its original: ${bad.length ? `NO (${bad.map((b) => `${b.file} ${b.why}`).join('; ')})` : 'yes'}`);
  for (const b of bad) pins.push(`PIN: data/ontologies/${b.file} ${b.why}: run node harness/convert.mjs`);
  let same = 0;
  let trips = 0;
  for (const c of CONVERTED) {
    const text = readFileSync(join(DATA, 'ontologies', c.file), 'utf8');
    const loaded = parseOntology(text);
    // the document as the page loads it gives the ontology its original gives (kinds, links, asks, the graph type)
    const key = (o) => canonJson({
      types: o.types.map((t) => [t.id, t.description, t.aliases, t.color, t.pole, t.subtype, t.origin, t.ask]),
      relations: o.relations.map((r) => [r.id, r.description, r.pairs, r.symmetric, r.phrase, r.origin, r.ask]),
      names: o.names, pairs: o.pairs, format: o.format, id: o.id, version: o.version, title: o.title, meta: o.meta, spec: graphTypeSpec(o).spec,
      schema: modelSchema(o).schema, tools: o.tools,
    });
    if (key(loaded) === key(c.o) && loaded.sha === c.o.sha && loaded.convertedFrom === null && c.o.convertedFrom === c.group.replace('ccg', 'create-context-graph')) same++;
    else pins.push(`PIN: ${c.file}: the document and its original give different ontologies`);
    // YAML and canonical JSON both read back to the same document
    const doc = parseDocument(text);
    if (toYaml(doc) === text && toCanonicalJson(JSON.parse(toCanonicalJson(doc))) === toCanonicalJson(doc) && loaded.sha === sha256(toCanonicalJson(doc))) trips++;
    else pins.push(`PIN: ${c.file}: toYaml or toCanonicalJson does not read back`);
  }
  say(`each gives the ontology its original gives (kinds, links, legal pairs, asks, the graph type, the model's schema, the tools): ${same} of ${CONVERTED.length}`);
  say(`each reads back from toYaml and from toCanonicalJson to the same document, its sha256 taken over the canonical JSON: ${trips} of ${CONVERTED.length}`);
  const lossy = [];
  for (const c of CONVERTED.filter((x) => x.group === 'ccg')) {
    const l = losses(readFileSync(join(DATA, 'ontologies', c.source), 'utf8'), BASE_TEXT, c.o.doc);
    if (l.length) lossy.push(`${c.o.id} (${l.join(', ')})`);
  }
  say('create-context-graph, read back from each document into its own model (domain, inherits, entity types with their');
  say('properties, colours and icons, relationships, agent tools, document templates, decision traces, demo scenarios, system');
  say(`prompt, visualization; harness/convert.mjs toCreateContextGraph) and compared with the file flattened by _merge_base: ${lossy.length ? `LOSSES in ${lossy.join('; ')}` : `nothing lost in ${CONVERTED.filter((x) => x.group === 'ccg').length} of 27`}`);
  pin('the create-context-graph conversion is lossless', lossy.length === 0, 'nothing lost', lossy.join('; '));
  const dropped = CONVERTED.flatMap((c) => (c.o.report?.dropped ?? []).map((d) => `${c.source}: ${d}`));
  say(`keys a conversion dropped (keys the format's own reader ignores): ${dropped.length ? dropped.join('; ') : 'none'}`);
}
{
  sub('the SDK on the bundled documents (lib/ogs.mjs: GraphSpec.Json decodes the js-yaml reading; the SDK\'s validation sets)');
  const ogs = createOgs({ yaml, sdk, sdkVersion: SDK_VERSION });
  /** @type {Map<string, number>} 'set code' -> count */
  const counts = new Map();
  let decoded = 0;
  for (const c of CONVERTED) {
    const text = readFileSync(join(DATA, 'ontologies', c.file), 'utf8');
    const v = ogs.validate(parseDocument(text), VALIDATION_SETS);
    if (!v.issues.some((i) => i.set === 'decode' || i.set === 'core')) decoded++;
    else pins.push(`PIN: ${c.file}: the SDK refuses it (${v.issues.filter((i) => i.set === 'decode' || i.set === 'core').map((i) => i.message).join('; ')})`);
    for (const i of v.issues) counts.set(`${i.set} ${i.code}`, (counts.get(`${i.set} ${i.code}`) ?? 0) + 1);
  }
  say(`decoded, with no core issue: ${decoded} of ${CONVERTED.length}`);
  say(`the other validation sets (informational: the page checks core): ${counts.size ? [...counts].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, n]) => `${k} ${n}`).join(', ') : 'no issues'}`);
  pin('the SDK accepts every bundled document', decoded === CONVERTED.length, 'all', `${decoded} decoded`);
  // Y1: the SDK's own YAML decoder misreads plain YAML: a plain <…> scalar, and a plain URL before a single-quoted
  // scalar (and more: js-yaml's output of the bundled documents fails in it at other places too)
  const tryYaml = (t) => { try { sdk.GraphSpec.Yaml.decodeFromString(t); return 'decoded'; } catch (e) { return `refused: ${String(e?.message ?? e).split('\n')[0]}`; } };
  const q = `schema: "${SCHEMA_ID}"\nversion: "1"\nid: y\nnodes:\n  a:\n    label: A\n    properties:\n      tags:\n        type: `;
  const plain = tryYaml(`${q}LIST<STRING>\n`);
  const quoted = tryYaml(`${q}"LIST<STRING>"\n`);
  const url = tryYaml(`schema: ${SCHEMA_ID}\nversion: '1'\nid: y\nnodes:\n  a:\n    label: A\n`);
  const urlQuoted = tryYaml(`schema: "${SCHEMA_ID}"\nversion: '1'\nid: y\nnodes:\n  a:\n    label: A\n`);
  const viaJson = (() => { try { ogs.decode(parseDocument(`${q}LIST<STRING>\n`)); return 'decoded'; } catch (e) { return describe(e); } })();
  const bundled = CONVERTED.filter((c) => tryYaml(readFileSync(join(DATA, 'ontologies', c.file), 'utf8')) === 'decoded').length;
  say(`Y1: through the SDK's YAML decoder: type: LIST<STRING> -> ${plain}; quoted -> ${quoted}`);
  say(`    schema: <a plain URL> then version: '1' -> ${url}; the URL quoted -> ${urlQuoted}`);
  say(`    the bundled documents (js-yaml's YAML) -> ${bundled} of ${CONVERTED.length} decoded; through js-yaml and GraphSpec.Json (lib/ogs.mjs) -> ${viaJson}, and all ${decoded} above`);
  pin('Y1 (the SDK\'s YAML decoder misreads plain YAML)', plain.startsWith("refused: Neo4jType does not contain element with name ''") && quoted === 'decoded' &&
    url.startsWith('refused: Top-level decoder') && urlQuoted === 'decoded' && viaJson === 'decoded', 'plain refused, quoted and JSON decoded', `${plain} / ${quoted} / ${url} / ${urlQuoted} / ${viaJson}`);
  // Y2: the decoder is lenient where the schema is strict
  const lenient = { ...parseDocument(readFileSync(join(DATA, 'ontologies', CONVERTED[0].file), 'utf8')), version: 1, extra_field: true };
  const lv = ogs.validate(lenient, ['core']);
  say(`Y2: a document with an integer version and an unknown field: the SDK -> ${lv.ok ? 'accepted' : lv.issues.map((i) => i.code).join(', ')}; ` +
    `the JSON Schema -> ${validateSchema(lenient).map((e) => `${e.path || '/'} ${e.keyword}`).join(', ')}`);
  pin('Y2 (the SDK\'s decoder ignores unknown fields; the schema refuses them)', lv.ok && validateSchema(lenient).length === 2, 'SDK accepts, schema refuses', JSON.stringify(lv));
}
{
  sub('the draft format earlier builds shipped (lib/ogs.mjs fromDraft; harness/fixtures/*.draft.ontology.yaml: the last draft build\'s own files)');
  for (const [from, to] of DRAFT_MAPPING) say(`  ${from}  ->  ${to}`);
  const fin = CONVERTED.find((c) => c.o.id === 'financial-services').o;
  const draftText = readFileSync(join(DRAFT_FIXTURES, 'financial-services.draft.ontology.yaml'), 'utf8');
  const draft = parseDocument(draftText);
  const converted = fromDraft(draft);
  const sameDoc = toCanonicalJson(converted) === toCanonicalJson(fin.doc);
  say(`financial-services as the last draft build bundled it: isDraft ${isDraft(draft)}; fromDraft gives the bundled document: ${sameDoc ? 'yes' : 'NO'}`);
  const pasted = parseOntology(draftText);
  say(`pasted into the page (parseOntology): converted from ${pasted.convertedFrom}; the same kinds, links, asks and sha as the bundled one: ${canonJson(modelSchema(pasted)) === canonJson(modelSchema(fin)) && pasted.sha === fin.sha ? 'yes' : 'NO'}`);
  const genericDraft = parseDocument(readFileSync(join(DRAFT_FIXTURES, 'edge-cases.draft.ontology.yaml'), 'utf8'));
  const genericSame = toCanonicalJson(fromDraft(genericDraft)) === toCanonicalJson(parseDocument(GENERIC_YAML));
  say(`the generic document (harness/fixtures.mjs GENERIC_YAML) as the last draft build had it: fromDraft gives it: ${genericSame ? 'yes' : 'NO'}`);
  pin('fromDraft (the last draft build\'s documents convert to this build\'s)', sameDoc && genericSame && pasted.convertedFrom === DRAFT_FORMAT && pasted.sha === fin.sha,
    'equal', `${sameDoc} ${genericSame} ${pasted.convertedFrom}`);
  const refusals = [
    ['a BYTES property', (() => { const d = structuredClone(genericDraft); d.nodes.person.properties = { photo: { type: 'BYTES' } }; return d; })()],
    ['two custom envelopes of one type', (() => { const d = structuredClone(genericDraft); d.extensions.custom.push(structuredClone(d.extensions.custom[0])); return d; })()],
    ['a constraint of an unknown kind', (() => { const d = structuredClone(genericDraft); d.nodes.person.properties = { id: { type: 'STRING' } }; d.nodes.person.constraints = [{ constraint_type: 'exists', properties: ['id'] }]; return d; })()],
  ];
  for (const [name, d] of refusals) {
    let got;
    try { fromDraft(d); got = 'converted'; } catch (e) { got = describe(e); }
    say(`fromDraft on ${name}: ${got}`);
    if (!got.startsWith('OntologyError')) pins.push(`PIN: fromDraft accepts ${name}`);
  }
}
{
  sub('create-context-graph property types as type tokens (web/convert.js PROPERTY_TYPES), over the 27 files and _base.yaml');
  /** @type {Map<string, {n: number, base: number}>} */
  const seen = new Map();
  const count = (t, base) => {
    const k = String(t ?? 'string');
    const c = seen.get(k) ?? { n: 0, base: 0 };
    c.n++;
    if (base) c.base++;
    seen.set(k, c);
  };
  for (const c of CONVERTED.filter((x) => x.group === 'ccg')) {
    const d = parseDocument(readFileSync(join(DATA, 'ontologies', c.source), 'utf8'));
    for (const e of d.entity_types ?? []) for (const p of e.properties ?? []) count(p.type, false);
    for (const r of d.relationships ?? []) for (const p of r.properties ?? []) count(p.type, false);
  }
  for (const b of Object.values(parseDocument(BASE_TEXT).base_entity_types ?? {})) for (const p of b.base_properties ?? []) count(p.type, true);
  const unknown = [];
  for (const [t, c] of [...seen].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))) {
    const token = PROPERTY_TYPES[t.trim().toLowerCase()];
    if (!token) unknown.push(t);
    say(`  ${t.padEnd(9)} -> ${(token ?? 'ANY (unknown, kept in a createContextGraph:type extension)').padEnd(14)} ${String(c.n).padStart(4)} properties${c.base ? ` (${c.base} in _base.yaml)` : ''}`);
  }
  const reported = CONVERTED.flatMap((c) => c.o.report?.types ?? []);
  say(`types with no token (ANY): ${unknown.length ? unknown.join(', ') : 'none'}; reported by the conversions: ${reported.length}`);
  pin('every property type of the 27 domains has a token', unknown.length === 0 && reported.length === 0, 'all mapped', unknown.join(', '));
  const tokens = new Map();
  for (const c of CONVERTED.filter((x) => x.group === 'ccg')) {
    for (const el of [...Object.values(c.o.doc.nodes), ...Object.values(c.o.doc.relationships ?? {})]) {
      for (const p of Object.values(el.properties ?? {})) tokens.set(p.type, (tokens.get(p.type) ?? 0) + 1);
    }
  }
  say(`in the 27 documents (the base's properties on every domain that keeps its kind): ${[...tokens].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ')}`);
  say('flags: required -> must_exist: true, unique -> unique: true, enum -> one_of, default -> a createContextGraph:default extension');
  say('(the spec has no default field), description -> description; tool parameters get the same type tokens.');
}
{
  sub('create-context-graph\'s agent_tools and visualization.default_cypher as canonicalQuery tools (web/convert.js toolAnchor)');
  say('Each tool sits on (1) the node its first parameter binds: of its parameters in declared order, the first the query');
  say('compares with a property of a node variable (in a property map, or a WHERE =, =~, CONTAINS, STARTS WITH, ENDS WITH or');
  say('IN; web/convert.js paramBindings) where the comparison filters the rows it returns (a MATCH\'s pattern, or the WHERE of');
  say('a MATCH or WITH; not an OPTIONAL MATCH, whose rows come back without a match, nor a subquery), on that variable\'s first');
  say('label that is a node of the ontology; else on the element its query starts from: (2) the first labelled node pattern in');
  say('the first MATCH, when the label is a node of the ontology; else (3) the first relationship type of that pattern that the');
  say('ontology has; else (4) the first label test (n:Label) in that MATCH\'s WHERE naming a node; else (5) the ontology\'s first');
  say('node.');
  const rules = new Map();
  const moved = [];
  const unbound = [];
  const notFiltering = [];
  let total = 0;
  let wrong = 0;
  for (const c of CONVERTED.filter((x) => x.group === 'ccg')) {
    const t = c.o.report.tools;
    total += t.length;
    for (const x of t) rules.set(x.rule, (rules.get(x.rule) ?? 0) + 1);
    const nodeList = Object.entries(c.o.doc.nodes).map(([k, n]) => [k, n.label]);
    const relList = Object.entries(c.o.doc.relationships ?? {}).map(([k, r]) => [k, r.type]);
    for (const tool of c.o.tools) {
      const start = toolAnchor(tool.cypher, nodeList, relList);
      const names = tool.parameters.map((p) => p.name);
      if (tool.anchor.key !== start.key) moved.push(`${c.o.id} ${tool.name} (${start.key} -> ${tool.anchor.key})`);
      if (names.length && !t.some((x) => x.name === tool.name && x.rule === 'parameter')) {
        // Compared with a node's property, but only where that cannot filter the rows (an OPTIONAL MATCH, a subquery).
        const elsewhere = names.filter((n) => paramBindings(tool.cypher).some((b) => b.param === n && b.scope !== 'match'));
        (elsewhere.length ? notFiltering : unbound).push(`${c.o.id} ${tool.name}${elsewhere.length ? ` (${elsewhere.map((n) => `$${n}`).join(', ')} in ` +
          `${[...new Set(paramBindings(tool.cypher).filter((b) => elsewhere.includes(b.param)).map((b) => (b.scope === 'optional' ? 'an OPTIONAL MATCH' : `a ${b.scope}`)))].join(', ')})` : ''}`);
      }
      // The node the first bound parameter compares where it filters the rows, independently of toolAnchor's loop.
      const first = names.map((n) => paramBindings(tool.cypher).find((b) => b.param === n && b.scope === 'match' && b.labels.some((l) => c.o.doc.nodes[l])))
        .find((b) => b !== undefined);
      if (first && first.labels.find((l) => c.o.doc.nodes[l]) !== tool.anchor.label) wrong++;
    }
    const nodes = t.filter((x) => x.anchor === 'node');
    const byNode = new Map();
    for (const x of nodes) byNode.set(x.element, (byNode.get(x.element) ?? 0) + 1);
    say(`${c.o.id}: ${t.length} tools, ${nodes.length} on nodes (${[...byNode].map(([k, n]) => `${k} ${n}`).join(', ')}), ${t.length - nodes.length} on relationships`);
  }
  say(`=> ${total} tools (${total - 27} agent tools and 27 defaultView): ${[...rules].map(([r, n]) => `${r} ${n}`).join(', ')}`);
  say(`on another node than the query's first labelled node pattern (rule 2 alone), by the parameter they bind: ${moved.length ? moved.join('; ') : 'none'}`);
  const lists = unbound.filter((x) => / list_\w+$/.test(x));
  say(`with parameters, none of them compared with a node property (placed by rules 2-5): ${unbound.length}, ${lists.length} list_* tools (\$limit only) and ` +
    `${unbound.filter((x) => !lists.includes(x)).join(', ') || 'none'}`);
  say(`with parameters compared with a node property only where that cannot filter the rows (placed by rules 2-5): ${notFiltering.length}: ${notFiltering.join('; ') || 'none'}`);
  say(`a tool on another node than the one its first bound parameter compares: ${wrong}`);
  const tools = CONVERTED.filter((x) => x.group === 'ccg').reduce((n, c) => n + c.o.tools.length, 0);
  pin('every tool lands on an element (o.tools)', tools === total && (rules.get('first-node') ?? 0) === 0 && wrong === 0,
    `${total} tools, no fallback to the first node, each on the node its first bound parameter compares`, `${tools}, ${rules.get('first-node') ?? 0} fallbacks, ${wrong} elsewhere`);
  const fin = CONVERTED.find((c) => c.o.id === 'financial-services').o.tools;
  say(`o.tools (financial-services, the interface the page's tools view reads): ${fin.length}; the first: ${JSON.stringify({ ...fin[0], cypher: `${fin[0].cypher.split('\n')[0]} …` })}`);
}
{
  sub(`the checks: ajv ${ajvPkg('ajv')} and web/ogs.js validateSchema (the JSON Schema), the SDK (validateSpec), the rules (checkDocument)`);
  say('The two schema validators are compared error for error, as (instance path, keyword) pairs; ajv runs with allErrors, strict');
  say('mode (strictTypes off) and strictNumbers. A document the schema accepts goes to the SDK (decode, Validations.core), and one');
  say('the SDK accepts to the rules web/ogs.js adds, which neither can say.');
  let agree = 0;
  for (const c of CONVERTED) {
    const doc = parseDocument(readFileSync(join(DATA, 'ontologies', c.file), 'utf8'));
    const v = bothValidate(doc);
    const spec = validateSpec(doc);
    const rules = checkDocument(doc);
    if (v.same && v.ajv.length === 0 && spec.length === 0 && rules.length === 0) agree++;
    else pins.push(`PIN: ${c.file}: ajv ${v.ajv.join(', ') || 'valid'}, ogs.js ${v.ogs.join(', ') || 'valid'}, SDK ${spec.map((r) => r.keyword).join(', ') || 'valid'}, rules ${rules.map((r) => r.message).join('; ') || 'none'}`);
  }
  say(`the ${CONVERTED.length} bundled documents: valid for both validators and the SDK, no rule broken: ${agree} of ${CONVERTED.length}`);
  const base = () => structuredClone(CONVERTED.find((c) => c.o.id === 'financial-services').o.doc);
  const small = () => ({
    schema: SCHEMA_ID, version: '2', id: 'staff', name: 'Staff',
    nodes: {
      person: { label: 'Person', properties: { name: { type: 'STRING', must_exist: true }, id: { type: 'STRING', key: true } } },
      employee: {
        labels: { identifier: 'Employee', implied: ['Person'], optional: ['Contractor'] },
        properties: { employee_id: { type: 'STRING' }, embedding: { type: 'VECTOR<FLOAT>', dimension: 384 }, grade: { type: 'STRING', pattern: '^[ab]$' }, level: { type: 'STRING', one_of: ['junior', 'senior'] } },
        constraints: { employee_id: { type: 'UNIQUE', properties: ['employee_id'], name: 'employee_id' } },
        extensions: { custom: { tools: [{ type: 'externalRequest', name: 'hr', description: 'HR record', url: 'https://example.com/hr' }] } },
        reference: 'https://example.com/Employee',
      },
      team: { label: 'Team', aliases: ['squad'] },
    },
    relationships: {
      MEMBER_OF: { type: 'MEMBER_OF', from: { node: 'employee', min_count: 1 }, to: { node: 'team', max_count: 3 }, properties: { since: { type: 'DATE' } } },
      KNOWS: { type: 'KNOWS', from: { node: 'person' }, to: { node: 'person' }, extensions: { custom: { 'edgextract:symmetric': {} } } },
    },
  });
  /** [name, document, 'schema'|'sdk'|'rules'|'valid'] */
  const CASES = [
    ['valid: implied and optional labels, a constraint, a VECTOR with its dimension, cardinalities, an externalRequest tool', small(), 'valid'],
    ['no schema', (({ schema, ...r }) => r)(base()), 'schema'],
    ['schema a number', { ...base(), schema: 1 }, 'schema'],
    ['version 1 (an integer, as the draft had it)', { ...base(), version: 1 }, 'schema'],
    ['$schema beside schema (the draft\'s marker)', { ...base(), $schema: SCHEMA_ID }, 'schema'],
    ['an unknown top-level field (types)', { ...base(), types: [] }, 'schema'],
    ['nodes as a list', { ...base(), nodes: [] }, 'schema'],
    ['a node that is text', (() => { const d = base(); d.nodes.Person = 'Person'; return d; })(), 'schema'],
    ['an extra field on a node (colour)', (() => { const d = base(); d.nodes.Account.colour = 'blue'; return d; })(), 'schema'],
    ['a draft field on a property (mustExist)', (() => { const d = small(); d.nodes.person.properties.name.mustExist = true; return d; })(), 'schema'],
    ['a draft field on a node (tools)', (() => { const d = small(); d.nodes.team.tools = []; return d; })(), 'schema'],
    ['a bad type token (TEXT)', (() => { const d = base(); d.nodes.Account.properties.balance.type = 'TEXT'; return d; })(), 'schema'],
    ['a draft type token (DATETIME)', (() => { const d = base(); d.nodes.Account.properties.balance.type = 'DATETIME'; return d; })(), 'schema'],
    ['a nested list token (LIST<LIST<STRING>>)', (() => { const d = base(); d.nodes.Account.properties.balance.type = 'LIST<LIST<STRING>>'; return d; })(), 'schema'],
    ['one_of that is not a list', (() => { const d = base(); d.nodes.Account.properties.status.one_of = 'active'; return d; })(), 'schema'],
    ['dimension 1.5', (() => { const d = small(); d.nodes.employee.properties.embedding.dimension = 1.5; return d; })(), 'schema'],
    ['a constraint of an unknown kind', (() => { const d = small(); d.nodes.employee.constraints.employee_id.type = 'exists'; return d; })(), 'schema'],
    ['constraints as a list (the draft\'s form)', (() => { const d = small(); d.nodes.employee.constraints = [{ type: 'UNIQUE', properties: ['employee_id'] }]; return d; })(), 'schema'],
    ['an implied label that is a number', (() => { const d = small(); d.nodes.employee.labels.implied = ['Person', 3]; return d; })(), 'schema'],
    ['a relationship without `to`', (() => { const d = base(); delete d.relationships.OWNS.to; return d; })(), 'schema'],
    ['an endpoint with an extra field (labels)', (() => { const d = base(); d.relationships.OWNS.to = { node: 'Account', labels: ['Account'] }; return d; })(), 'schema'],
    ['custom extensions as a list (the draft\'s form)', (() => { const d = base(); d.nodes.Account.extensions.custom = [{ type: 'x' }]; return d; })(), 'schema'],
    ['display without x and y', (() => { const d = base(); d.nodes.Account.extensions.display = { colour: '#123456' }; return d; })(), 'schema'],
    ['display on a relationship', (() => { const d = base(); d.relationships.OWNS.extensions.display = { x: 0, y: 0 }; return d; })(), 'schema'],
    ['the document a list', [base()], 'schema'],
    ['an endpoint to an unknown node', (() => { const d = base(); d.relationships.OWNS.to.node = 'Acount'; return d; })(), 'sdk'],
    ['a constraint naming a property the node does not have', (() => { const d = small(); d.nodes.employee.constraints.employee_id.properties = ['employee_number']; return d; })(), 'sdk'],
    ['count with min_count', (() => { const d = small(); d.relationships.MEMBER_OF.to = { node: 'team', count: 1, min_count: 1 }; return d; })(), 'sdk'],
    ['min_count above max_count', (() => { const d = small(); d.relationships.MEMBER_OF.to = { node: 'team', min_count: 4, max_count: 3 }; return d; })(), 'sdk'],
    ['pattern with one_of on one property', (() => { const d = small(); d.nodes.employee.properties.grade.one_of = ['a', 'b']; return d; })(), 'sdk'],
    ['a null custom extension', (() => { const d = small(); d.relationships.KNOWS.extensions.custom['edgextract:symmetric'] = null; return d; })(), 'sdk'],
    ['a node with no label', (() => { const d = base(); delete d.nodes.Policy.label; return d; })(), 'rules'],
    ['label and labels.identifier disagree', (() => { const d = small(); d.nodes.employee.label = 'Worker'; return d; })(), 'rules'],
    ['two nodes with one label', (() => { const d = base(); d.nodes.Policy.label = 'Account'; return d; })(), 'rules'],
    ['a label with a leading _', (() => { const d = base(); d.nodes.Policy.label = '_Policy'; return d; })(), 'rules'],
    ['a relationship type with a hyphen', (() => { const d = base(); d.relationships.OWNS.type = 'OWNS-ACCOUNT'; return d; })(), 'rules'],
    ['an implied label equal to the identifier', (() => { const d = small(); d.nodes.employee.labels.implied = ['Employee']; return d; })(), 'rules'],
    ['dimension on a STRING', (() => { const d = small(); d.nodes.employee.properties.grade.dimension = 3; return d; })(), 'rules'],
    ['key with must_exist: false', (() => { const d = small(); d.nodes.person.properties.id.must_exist = false; return d; })(), 'rules'],
    ['the same type between the same nodes twice', (() => { const d = base(); d.relationships.OWNS_AGAIN = structuredClone(d.relationships.OWNS); return d; })(), 'rules'],
    ['edgextract:symmetric on one entry of a type only', (() => { const d = small(); d.relationships.KNOWS_TEAM = { type: 'KNOWS', from: { node: 'team' }, to: { node: 'team' } }; return d; })(), 'rules'],
    ['schema naming spec 1.0.0', { ...base(), schema: 'https://neo4j.com/docs/ontology-graph-spec/1.0.0/schema.json' }, 'rules'],
    ['a create-context-graph document with a node lacking createContextGraph:pole', (() => { const d = base(); delete d.nodes.Policy.extensions.custom['createContextGraph:pole']; return d; })(), 'rules'],
    ['a gazetteer naming a node the document does not have', (() => { const d = small(); d.extensions = { custom: { 'edgextract:gazetteer': { 'Ada Lovelace': 'manager' } } }; return d; })(), 'rules'],
    ['tools that are not a list', (() => { const d = small(); d.nodes.team.extensions = { custom: { tools: { type: 'canonicalQuery' } } }; return d; })(), 'rules'],
    ['two tools with one name', (() => { const d = small(); const t = d.nodes.employee.extensions.custom.tools; t.push({ ...t[0] }); return d; })(), 'rules'],
  ];
  let schemaAgree = 0;
  let asDesigned = 0;
  for (const [name, doc, want] of CASES) {
    const v = bothValidate(doc);
    const spec = v.ajv.length === 0 ? validateSpec(doc) : [];
    const rules = v.ajv.length === 0 && spec.length === 0 ? checkDocument(doc) : [];
    const got = v.ajv.length ? 'schema' : spec.length ? 'sdk' : rules.length ? 'rules' : 'valid';
    if (v.same) schemaAgree++;
    else pins.push(`PIN: validators disagree (${name}): ajv ${v.ajv.join(', ')} | ogs.js ${v.ogs.join(', ')}`);
    if (got === want) asDesigned++;
    else pins.push(`PIN: tampered document (${name}): expected ${want}, got ${got}`);
    const what = v.ajv.length ? `both validators refuse: ${v.ajv.join('; ')}`
      : spec.length ? `schema-valid; the SDK: ${spec.map((r) => `${r.path || '/'} ${r.keyword}: ${r.message}`).join('; ')}`
        : rules.length ? `schema- and SDK-valid; the rules: ${rules.map((r) => `${r.path} ${r.message}`).join('; ')}` : 'valid for all three, no rule broken';
    say(`${name}: ${v.same ? '' : 'MISMATCH '}${what}`);
  }
  say(`=> the two validators report the same errors on ${schemaAgree} of ${CASES.length} documents; ${asDesigned} of ${CASES.length} refused (or accepted) where designed`);
  say(`ajv and web/ogs.js agree on all ${CONVERTED.length + CASES.length} documents: ${schemaAgree === CASES.length && agree === CONVERTED.length ? 'yes' : 'NO'}`);
  // What parseOntology tells the person who wrote it, for one of each.
  const tell = (text) => { try { parseOntology(text); return 'accepted'; } catch (e) { return describe(e); } };
  say(`parseOntology on the bad type token: ${tell(JSON.stringify(CASES.find((c) => c[0].startsWith('a bad type token'))[1]))}`);
  say(`parseOntology on the endpoint to an unknown node: ${tell(JSON.stringify(CASES.find((c) => c[0].startsWith('an endpoint to an unknown'))[1]))}`);
  const okSmall = parseOntology(toYaml(small()));
  say(`parseOntology on the valid one: kinds ${okSmall.types.map((t) => `${t.id}${t.implied.length ? ` (implied ${t.implied.join(', ')})` : ''}`).join(', ')}; links ${okSmall.relations.map((r) => `${r.id}${r.symmetric ? ' (symmetric)' : ''}`).join(', ')}; ` +
    `asked as ${okSmall.format}; tools ${okSmall.tools.map((t) => `${t.name} on ${t.anchor.kind} ${t.anchor.key}`).join(', ')}`);
  const json = parseOntology(JSON.stringify(small()));
  say(`the same document as JSON: the same ontology and sha: ${json.sha === okSmall.sha && json.yaml === okSmall.yaml ? 'yes' : 'NO'}`);
  pin('a document in YAML or JSON', json.sha === okSmall.sha && json.yaml === okSmall.yaml, 'the same', 'different');
  let mixed;
  try { parseOntology(`schema: ${SCHEMA_ID}\nversion: '1'\nid: x\ndomain: {id: x, name: X}\n`); mixed = 'accepted'; } catch (e) { mixed = describe(e); }
  say(`a file with schema and domain: ${mixed}`);
}

// ---- 1. create-context-graph's domains ------------------------------------------------------------------
const CCG_DIR = join(DATA, 'ontologies', 'ccg');
const baseText = readFileSync(join(CCG_DIR, '_base.yaml'), 'utf8');
const BASES = { _base: baseText };
const ccgFiles = readdirSync(CCG_DIR).filter((f) => f.endsWith('.yaml') && !f.startsWith('_')).sort();
/** @type {Map<string, {o: any, text: string, src: string, file: string}>} text: the document; src: the original */
const ccg = new Map();
const ccgOf = (id) => /** @type {any} */ (ccg.get(id)).o;
const typedLine = (o, gt) => `typed (${gt.typed.length}): ${gt.typed.map((id) => {
  const r = o.relations.find((x) => x.id === id);
  return `${id} (${r.pairs[0][0]} -> ${r.pairs[0][1]})`;
}).join(', ') || 'none'}`;
section(`create-context-graph's domains (data/ontologies/ccg/, neo4j-labs/create-context-graph 707b168): ${ccgFiles.length}, each inheriting _base.yaml`);
say('Each is loaded as the page loads it, its document (data/ontologies/ogs/ccg/), converted from the file and _base.yaml.');
say('Labels and relationship types are the files\' own, verbatim. _base.yaml is merged as ontology.py _merge_base does: the');
say('base\'s entity types and relationships first, unless the domain declares that label or relationship type itself. Entries');
say('sharing a relationship type are one link with several legal (source, target) pairs, which is what the gate checks; a link');
say('is typed in the graph type only when it has exactly one pair (R16). A kind\'s description (the page\'s, _Kind.description) is');
say('derived: "<subtype> (<pole type>)", lower case with _ as spaces, or the pole type alone (ontology.js kindDescription).');
say('The model is asked otherwise (pipeline.modelSchema, from each kind\'s and link\'s ask): a kind by its label as text');
say('(ontology.js labelText), with "<subtype> in <domain name>" for a domain kind with a subtype and nothing for a base kind;');
say('a base kind that no link names and whose pole a domain kind shares is not asked; a link as its phrase between its');
say('endpoints\' label texts, one per legal pair, joined by " or ".');
{
  const base = parseOntology('inherits: _base\ndomain: {id: base-only, name: _base alone}\n', { bases: BASES });
  sub('_base.yaml (POLE+O), as a domain with nothing of its own sees it');
  say(`kinds ${base.types.length}: ${base.types.map((t) => `${t.id} ("${t.description}")`).join(', ')}`);
  say(`links ${base.relations.length}: ${base.relations.map((r) => `${r.id} (${r.pairs.map(([s, t]) => `${s} -> ${t}`).join(', ')})`).join(', ')}`);
  const examples = [['OBJECT', 'FINANCIAL_ACCOUNT', 'financial account (object)'], ['EVENT', 'DECISION', 'decision (event)'],
    ['PERSON', null, 'person'], ['PERSON', 'PERSON', 'person'], ['ORGANIZATION', 'THREAT_ACTOR', 'threat actor (organization)']];
  const got = examples.map(([p, s]) => kindDescription(/** @type {string} */ (p), s));
  say(`kindDescription: ${examples.map(([p, s], i) => `(${p}, ${s ?? 'no subtype'}) -> "${got[i]}"`).join('; ')}`);
  pin('D8 (the description rule)', examples.every((x, i) => x[2] === got[i]), examples.map((x) => x[2]).join(' | '), got.join(' | '));
  const texts = [['Person', 'person'], ['PERSON', 'person'], ['MaintenanceRecord', 'maintenance record'], ['ThreatActor', 'threat actor'],
    ['GLAccount', 'gl account'], ['ToolCall', 'tool call'], ['Form_W2', 'form w2'], ['Ärztin', 'ärztin']];
  const gotText = texts.map(([id]) => labelText(id));
  say(`labelText: ${texts.map(([id], i) => `${id} -> "${gotText[i]}"`).join('; ')}`);
  pin('the label-text rule (labelText)', texts.every((x, i) => x[1] === gotText[i]), texts.map((x) => x[1]).join(' | '), gotText.join(' | '));
  const bs = modelSchema(base).schema;
  say(`asked, the base alone: ${bs.entities.map((e) => `"${e.id}"`).join(', ')}; ${bs.relations.map((r) => `"${r}"`).join(', ')}`);
  // Two kinds that read alike, and two links, are refused; a base kind is not asked when a domain kind covers its pole and no link names it.
  const alike = (() => {
    try { parseOntology('inherits: _base\ndomain: {id: alike, name: Alike}\nentity_types:\n  - {label: TaxForm, pole_type: OBJECT}\n  - {label: Tax_Form, pole_type: OBJECT}\n', { bases: BASES }); return 'accepted'; } catch (e) { return describe(e); }
  })();
  say(`two kinds that read alike (TaxForm, Tax_Form) -> ${alike}`);
  pin('two kinds one label text', alike.startsWith('OntologyError: The entity types TaxForm and Tax_Form both read as "tax form"'), 'refused', alike);
  const cover = parseOntology('inherits: _base\ndomain: {id: cover, name: Cover Test}\nentity_types:\n  - {label: Gadget, pole_type: OBJECT, subtype: SMALL_DEVICE}\n' +
    '  - {label: Gala, pole_type: EVENT}\nrelationships:\n  - {type: ATTENDED, source: Person, target: Event}\n', { bases: BASES });
  const cs = modelSchema(cover).schema;
  say(`a domain kind for OBJECT and one for EVENT, a link naming Event: asked ${cs.entities.map((e) => (e.description ? `"${e.id}: ${e.description}"` : `"${e.id}"`)).join(', ')}; ` +
    `not asked ${cover.types.filter((t) => t.ask === null).map((t) => t.id).join(', ')}`);
  pin('a base kind a domain kind covers and no link names is not asked', cover.types.filter((t) => t.ask === null).map((t) => t.id).join() === 'Object' &&
    cs.entities.some((e) => e.id === 'gadget' && e.description === 'small device in cover test'), 'Object only; "gadget: small device in cover test"', JSON.stringify(cs.entities));
}
/** @type {Array<{id: string, kinds: number, own: number, links: number, baseLinks: number, pairs: number, typed: number, untyped: Array<{id: string, reason: string}>}>} */
const ccgRows = [];
const baseTypes = ['WORKS_FOR', 'LOCATED_AT', 'PARTICIPATED_IN'];
for (const file of ccgFiles) {
  const src = readFileSync(join(CCG_DIR, file), 'utf8');
  const v1File = `ogs/ccg/${file.replace(/\.yaml$/, '.ontology.yaml')}`;
  const text = readFileSync(join(DATA, 'ontologies', v1File), 'utf8');
  const o = parseOntology(text);
  ccg.set(o.id, { o, text, src, file });
  const gt = graphTypeSpec(o);
  sub(`${o.id} (${v1File}, from ${file}): ${o.meta.emoji} ${o.title}`);
  const conv = parseOntology(src, { bases: BASES });
  pin(`D8 Ontology.sha (${v1File})`, o.format === 'create-context-graph' && o.convertedFrom === null && o.sha === sha256(toCanonicalJson(o.doc)) && o.yaml === text &&
    conv.yaml === text && conv.convertedFrom === 'create-context-graph' && conv.sourceSha === ontologySha(src, '_base', baseText),
  'sha256 of the canonical JSON; the document a fresh conversion of the file with _base.yaml', o.sha);
  say(`${o.meta.description}; store ${storeName(o)}`);
  const own = o.types.filter((t) => t.origin === 'own');
  const fromBase = o.types.filter((t) => t.origin === 'base');
  say(`kinds ${o.types.length} (${fromBase.length} from _base): ${o.types.map((t) => t.id).join(', ')}`);
  say(`described: ${own.map((t) => `${t.id} "${t.description}"`).join(', ')}`);
  const linksFromBase = o.relations.filter((r) => r.origin === 'base').map((r) => r.id);
  const replaced = baseTypes.filter((t) => !linksFromBase.includes(t) && o.relations.some((r) => r.id === t));
  const legalPairs = o.relations.reduce((n, r) => n + r.pairs.length, 0);
  say(`links ${o.relations.length} (${linksFromBase.length} from _base${replaced.length ? `; its own ${replaced.join(', ')} replaces the base's` : ''}), ` +
    `legal kind pairs ${legalPairs}`);
  say(typedLine(o, gt));
  say(`untyped (${gt.untyped.length}):${gt.untyped.length ? '' : ' none'}`);
  for (const u of gt.untyped) say(`  ${u.id}: ${u.reason}`);
  const ms = modelSchema(o);
  const schema = checkSchema(ms.schema);
  const unasked = o.types.filter((t) => t.ask === null).map((t) => t.id);
  say(`asked (gliner.js "label:description"): ${schema.entities.map((e) => (e.description ? `${e.id}:${e.description}` : e.id)).join(', ')}; not asked: ${unasked.join(', ') || 'none'}`);
  say(`links asked: ${schema.relations.map((r) => `"${r}"`).join(', ')}`);
  pin(`gliner schema (${o.id})`, schema.entities.length === o.types.length - unasked.length && schema.relations.length === o.relations.length &&
    o.types.every((t) => t.ask === null || ms.kindOf.get(t.ask.label) === t.id) && o.relations.every((r) => ms.relOf.get(r.ask) === r.id),
  'one label per asked kind, one name per link, both mapping back', JSON.stringify(schema).slice(0, 80));
  pin(`unasked kinds (${o.id})`, unasked.every((id) => o.types.find((t) => t.id === id)?.origin === 'base'), 'base kinds only', unasked.join());

  const db = fresh();
  const res = applyOntology(db, o, cl);
  const back = currentGraphType(db, cl);
  const elements = replay.splitGraphType(back).elements;
  const edgeTypes = elements.filter((e) => e.includes(')-[')).length;
  say(`applyOntology: altered ${res.altered}; graph type read back: ${elements.length - edgeTypes} node types and ${edgeTypes} edge types, ` +
    `equal to graphTypeSpec(o).spec: ${back === gt.spec ? 'yes' : 'NO'}`);
  pin(`O4/D15 graph type round trip (${o.id})`, back === gt.spec && edgeTypes === gt.typed.length, 'the derived spec back', back);
  const c1 = layer(db);
  const k1 = constraints(db);
  say(`layer: ${layerText(c1)}`);
  const stored = readOntology(db, cl);
  const linkRows = cl.exec(db, 'MATCH (l:_LinkType) RETURN l.id AS id, l.typed AS typed, l.pairs AS pairs ORDER BY l.ord').rows;
  const okStored = stored.sha === o.sha && stored.doc === toCanonicalJson(o.doc) && stored.spec === SPEC_VERSION && stored.converted_from === null &&
    stored.yaml === null && stored.base_yaml === null && stored.inherits === null &&
    stored.format === 'create-context-graph' && stored.graph_type === gt.spec &&
    canonJson(linkRows.map((r) => [r.id, r.typed, r.pairs])) === canonJson(o.relations.map((r) => [r.id, gt.typed.includes(r.id), r.pairs.map(([s, t]) => `${s}|${t}`)])) &&
    ontologyFromStored(stored).sha === o.sha && ontologyFromStored(stored).yaml === text;
  say(`stored _Ontology: the document (canonical JSON), spec ${SPEC_VERSION}, its sha and graph_type; _LinkType.typed and .pairs as derived; parsed again alone: ${okStored ? 'yes' : 'NO'}`);
  pin(`D8 stored ontology (${o.id})`, okStored, 'the document, its sha, spec and pairs', JSON.stringify({ ...stored, doc: stored.doc?.slice(0, 40) }).slice(0, 160));
  const d1 = replay.contentDigest(db);
  const res2 = applyOntology(db, o, cl);
  const same = canonJson(layer(db)) === canonJson(c1) && replay.contentDigest(db) === d1 && canonJson(constraints(db)) === canonJson(k1);
  pin(`D9 idempotent apply (${o.id})`, !res2.altered && same, 'no ALTER and no change', `altered ${res2.altered}, same ${same}`);
  pin(`R9 lookup keys (${o.id})`, keysBuilt(db) && k1.own.join() === UNIQUES.join(),
    '4 UNIQUE, their backing indexes built, no standalone index', `${lookupIndexes(db)} / ${backingIndexes(db)} / ${k1.own}`);
  db.free();
  ccgRows.push({ id: o.id, kinds: o.types.length, own: own.length, links: o.relations.length, baseLinks: linksFromBase.length, pairs: legalPairs, typed: gt.typed.length, untyped: gt.untyped });
}
{
  sub(`the ${ccgRows.length} domains at a glance (each applied again: no ALTER, nothing changed; 4 UNIQUE each, their backing indexes built)`);
  say(`${'domain'.padEnd(22)} ${'kinds (own + _base)'.padEnd(20)} ${'links (from _base)'.padEnd(19)} ${'pairs'.padEnd(6)} ${'typed'.padEnd(6)} untyped`);
  for (const r of ccgRows) {
    say(`${r.id.padEnd(22)} ${`${r.kinds} (${r.own} + ${r.kinds - r.own})`.padEnd(20)} ${`${r.links} (${r.baseLinks})`.padEnd(19)} ` +
      `${String(r.pairs).padEnd(6)} ${String(r.typed).padEnd(6)} ${r.untyped.map((u) => u.id).join(', ') || '0'}`);
  }
  const untyped = ccgRows.flatMap((r) => r.untyped.map((u) => `${r.id} ${u.id}`));
  const totalLinks = ccgRows.reduce((n, r) => n + r.links, 0);
  say(`=> ${totalLinks} links in ${ccgRows.length} domains: ${totalLinks - untyped.length} typed, ${untyped.length} untyped (${untyped.join(', ')}): ` +
    'the two relationship types declared for two kind pairs each');
  pin('R16 (exactly the multi-pair links are untyped)', untyped.join() === 'government ELIGIBLE_FOR,legal PARTY_TO', 'government ELIGIBLE_FOR, legal PARTY_TO', untyped.join());
  // ontology.py _merge_base: a domain that declares a base relationship type keeps only its own pairs.
  const replacedAll = [];
  for (const [id, { o }] of ccg) {
    for (const t of baseTypes) {
      const r = o.relations.find((x) => x.id === t);
      if (r && r.origin === 'own') replacedAll.push(`${id} ${t} (${r.pairs.map(([s, x]) => `${s} -> ${x}`).join(', ')})`);
    }
  }
  say(`base relationships a domain declares itself, so the base's pair is not merged (ontology.py _merge_base): ${replacedAll.join('; ')}`);
  pin('_merge_base (a domain\'s own relationship type replaces the base\'s)', replacedAll.join('; ') ===
    'agent-memory PARTICIPATED_IN (Agent -> Conversation); conservation LOCATED_AT (Monitoring -> Site); vacation-industry PARTICIPATED_IN (Guest -> Activity)',
  'agent-memory PARTICIPATED_IN, conservation LOCATED_AT, vacation-industry PARTICIPATED_IN, one pair each', replacedAll.join('; '));
  const ids = [...ccg.keys()];
  pin('D14 (every domain id is its own store slug)', ids.every((id) => storeName({ id }) === `ex01-kg-${id}`), 'ex01-kg-<domain id>', ids.filter((id) => storeName({ id }) !== `ex01-kg-${id}`).join(', '));
  say(`store names: every domain id is its own slug (ex01-kg-<domain id>): ${ids.every((id) => storeName({ id }) === `ex01-kg-${id}`) ? 'yes' : 'NO'}`);
}

/**
 * A document's trace written by hand as web/pipeline.js writes it after the model (no model call): one
 * section of sentences with their mentions [surface, kind, p] and claims [head surface, link, tail surface, p];
 * then the gate and publish, at the defaults.
 */
function handTrace(db, title, sentences) {
  const text = sentences.map((s) => s.text).join(' ');
  const doc = replay.sha256(text);
  store.writeDocument(db, cl, { id: doc, title, chars: [...text].length });
  const run = store.startRun(db, cl, { doc, model: { repo: 'by-hand', rev: 'none' }, floor: 0.1, sections: 1, sentences: sentences.length });
  const w = { doc, run, section: { key: `${doc}#s0`, n: 0 }, sentences: [], parts: [], inferences: [], inferred: [], mentions: [], claims: [] };
  let at = 0;
  sentences.forEach((s, idx) => {
    const key = `${doc}#${idx}`;
    const len = [...s.text].length;
    w.sentences.push({ key, idx, doc, start: at, end: at + len, text: s.text, heading: [] });
    const span = (surface) => {
      const i = s.text.indexOf(surface);
      if (i < 0) throw new Error(`handTrace: ${surface} is not in ${s.text}`);
      const a = at + [...s.text.slice(0, i)].length;
      return [a, a + [...surface].length];
    };
    for (const [surface, label, p] of s.mentions) {
      const [a, b] = span(surface);
      w.mentions.push({ key: `${key}|m|${label}|${a}-${b}`, sentence: key, doc, start: a, end: b, text: surface, label, name: mentionName(surface), p, source: 'model' });
    }
    for (const [h, rel, t, p] of s.claims) {
      const [hs, he] = span(h);
      const [ts, te] = span(t);
      w.claims.push({ key: `${key}|c|${rel}|${hs}-${he}|${ts}-${te}`, sentence: key, doc, rel, p, hs, he, ts, te, htext: h, ttext: t });
    }
    at += len + 1;
  });
  store.writeSection(db, cl, w);
  const g = store.gate(db, cl);
  const p = store.publish(db, cl);
  return { g, p };
}
const claimText = (c) => `${c.band} by ${c.rule}: "${c.htext}" -[${c.rel}]-> "${c.ttext}"`;
const AUDITS = readdirSync(join(EX, 'queries')).filter((f) => /^audit-.*\.cypher$/.test(f)).sort();
/** Every audit (queries/audit-*.cypher) on a store: the ones with rows. */
const auditRows = (db) => AUDITS.filter((f) => cl.exec(db, readFileSync(join(EX, 'queries', f), 'utf8')).rows.length);
/** The published typed graph, as (:_Entity:<Kind> {key})-[:TYPE]->(...) lines. */
const published = (db) => cl.exec(db, `MATCH (a:_Entity)-[r]->(b:_Entity)
RETURN a.key AS a, [l IN labels(a) WHERE l <> '_Entity'] AS la, type(r) AS rel, b.key AS b, [l IN labels(b) WHERE l <> '_Entity'] AS lb
ORDER BY a, rel, b`).rows.map((r) => `(:_Entity:${r.la.join(':')} {key: '${r.a}'})-[:${r.rel}]->(:_Entity:${r.lb.join(':')} {key: '${r.b}'})`);

section('create-context-graph domains through the gate and publish, without the model (D10 rule 4, D16)');
say('Each store gets a hand-written trace, as the pipeline writes one after the model: mentions and claims with scores above');
say('the default cutoffs. The gate and publish run as in the page; the audits (queries/audit-*.cypher) must find nothing.');
{
  sub('financial-services: (:_Entity:Person)-[:OWNS]->(:_Entity:Account)');
  const db = fresh();
  store.openStore(db, cl, ccgOf('financial-services'));
  const { g, p } = handTrace(db, 'by hand', [
    { text: 'Ada Lovelace owns the Northwind Savings account.', mentions: [['Ada Lovelace', 'Person', 0.95], ['Northwind Savings', 'Account', 0.92]],
      claims: [['Ada Lovelace', 'OWNS', 'Northwind Savings', 0.9], ['Northwind Savings', 'OWNS', 'Ada Lovelace', 0.88]] },
  ]);
  for (const c of g.claims) say(`claim ${claimText(c)}`);
  say(`publish: ${p.entities} entities, ${p.relationships} relationship`);
  for (const l of published(db)) say(`  ${l}`);
  const owns = cl.exec(db, 'MATCH (a:_Entity:Person)-[r:OWNS]->(b:_Entity:Account) RETURN a.name AS a, b.name AS b').rows;
  pin('D16 (financial-services publishes Person OWNS Account)', owns.length === 1 && owns[0].a === 'Ada Lovelace' &&
    g.claims.some((c) => c.htext === 'Northwind Savings' && c.rule === 'illegal'), 'one OWNS edge; the reversed claim illegal', JSON.stringify(owns));
  let refused;
  try {
    refused = `written (${store.writeTypedEdges(db, cl, 'OWNS', [{ a: 'Account:NORTHWIND_SAVINGS', b: 'Person:ADA_LOVELACE', p: 0.99, claims: [], sentences: [], docs: [] }], 999)})`;
  } catch (e) {
    refused = describe(e);
  }
  say(`the backstop: publishing Account -[OWNS]-> Person through store.writeTypedEdges -> ${refused}`);
  pin('O4 (the graph type refuses a reversed typed edge)', /^constraint: ConstraintValidationFailed: endpoint label presence verification failed: expected Person/.test(refused),
    'ConstraintValidationFailed ... expected Person', refused);
  const bad = auditRows(db);
  say(`audits: ${bad.length ? `rows in ${bad.join(', ')}` : '0 rows each'}`);
  pin('audits (financial-services)', bad.length === 0, '0 rows', bad.join(', '));
  // Every label and relationship type in the store is the example's own (with the prefix) or the ontology's.
  const k = store.counts(db, cl);
  const o = ccgOf('financial-services');
  const strays = [...k.labels.map((x) => x.name).filter((l) => !INTERNAL_LABELS.includes(l) && !o.types.some((t) => t.id === l)),
    ...k.types.map((x) => x.name).filter((t) => !INTERNAL_TYPES.includes(t) && !o.relations.some((r) => r.id === t))];
  say(`labels in the store: ${k.labels.map((x) => x.name).join(', ')}`);
  say(`relationship types: ${k.types.map((x) => x.name).join(', ')}`);
  say(`each is the example's own (INTERNAL_LABELS, INTERNAL_TYPES) or the ontology's: ${strays.length ? `NO (${strays.join(', ')})` : 'yes'}`);
  pin('D8 (every internal name has the prefix)', strays.length === 0, 'no stray label or type', strays.join(', '));
  db.free();
}
{
  sub('legal: PARTY_TO is Person -> Case and Organization -> Contract, exactly; never Person -> Contract');
  const db = fresh();
  const opened = store.openStore(db, cl, ccgOf('legal'));
  say(`untyped, so only the gate checks it: ${opened.ontology.untyped.map((u) => u.id).join(', ')}`);
  const { g, p } = handTrace(db, 'by hand', [
    { text: 'Jane Roe is a party to Roe v. Initech.', mentions: [['Jane Roe', 'Person', 0.95], ['Roe v. Initech', 'Case', 0.93]],
      claims: [['Jane Roe', 'PARTY_TO', 'Roe v. Initech', 0.9]] },
    { text: 'Jane Roe signed the Supply Agreement.', mentions: [['Jane Roe', 'Person', 0.95], ['Supply Agreement', 'Contract', 0.93]],
      claims: [['Jane Roe', 'PARTY_TO', 'Supply Agreement', 0.9]] },
    { text: 'Acme Corp is a party to the Supply Agreement.', mentions: [['Acme Corp', 'Organization', 0.95], ['Supply Agreement', 'Contract', 0.93]],
      claims: [['Acme Corp', 'PARTY_TO', 'Supply Agreement', 0.9]] },
  ]);
  for (const c of g.claims) say(`claim ${claimText(c)}`);
  say(`publish: ${p.entities} entities, ${p.relationships} relationships`);
  for (const l of published(db)) say(`  ${l}`);
  const rules = g.claims.map((c) => `${c.htext}>${c.ttext}:${c.rule}`).sort().join(', ');
  pin('D10 rule 4 (legality is the exact pairs)', rules === 'Acme Corp>Supply Agreement:band, Jane Roe>Roe v. Initech:band, Jane Roe>Supply Agreement:illegal',
    'Person -> Contract illegal, the two declared pairs kept', rules);
  const bad = auditRows(db);
  say(`audits: ${bad.length ? `rows in ${bad.join(', ')}` : '0 rows each'}`);
  pin('audits (legal)', bad.length === 0, '0 rows', bad.join(', '));
  db.free();
}
{
  sub('kinds named Entity (agent-memory) and Claim (data-journalism) publish beside the internal _Entity and _Claim');
  for (const [id, title, s] of [
    ['agent-memory', 'Entity', { text: 'The agent Scout reasoned about Acme Corp.', mentions: [['Scout', 'Agent', 0.95], ['Acme Corp', 'Entity', 0.93]],
      claims: [['Scout', 'REASONED_ABOUT', 'Acme Corp', 0.9]] }],
    ['data-journalism', 'Claim', { text: 'The Census Dataset supports the Rent Claim.', mentions: [['Census Dataset', 'Dataset', 0.95], ['Rent Claim', 'Claim', 0.93]],
      claims: [['Census Dataset', 'SUPPORTS', 'Rent Claim', 0.9]] }],
  ]) {
    const db = fresh();
    store.openStore(db, cl, ccgOf(id));
    const { g, p } = handTrace(db, 'by hand', [s]);
    for (const c of g.claims) say(`${id}: claim ${claimText(c)}`);
    for (const l of published(db)) say(`  ${l}`);
    const n = (q) => cl.exec(db, q).rows[0].n;
    const kindNodes = n(`MATCH (x:${title}) RETURN count(x) AS n`);
    const kindNotEntity = n(`MATCH (x:${title}) WHERE NOT x:_Entity RETURN count(x) AS n`);
    const internal = n(`MATCH (x:_${title}) RETURN count(x) AS n`);
    const internalWithKind = n(`MATCH (x:_${title}) WHERE x:${title} RETURN count(x) AS n`);
    // An Entity-kind node is an _Entity by design (the published graph); no _Claim is ever a Claim.
    const wantWithKind = title === 'Entity' ? 1 : 0;
    say(`  (:${title}) nodes ${kindNodes}, each an _Entity: ${kindNotEntity === 0 ? 'yes' : 'NO'}; (:_${title}) nodes ${internal}, ` +
      `labelled ${title}: ${internalWithKind}${title === 'Entity' ? ' (the published Entity kind itself)' : ''}`);
    const bad = auditRows(db);
    say(`  audits: ${bad.length ? `rows in ${bad.join(', ')}` : '0 rows each'}`);
    pin(`D8 (a kind named ${title} touches nothing internal, ${id})`, p.relationships === 1 && kindNodes === 1 && kindNotEntity === 0 &&
      internal === (title === 'Claim' ? 1 : 2) && internalWithKind === wantWithKind && bad.length === 0,
    `1 relationship, 1 (:${title}) that is an _Entity, the internal nodes untouched, 0 audit rows`, `${p.relationships} ${kindNodes} ${kindNotEntity} ${internal} ${internalWithKind} ${bad}`);
    db.free();
  }
}

{
  sub('implied labels (labels.implied, none in the bundled ontologies): published entities carry them beside their kind');
  const text = [`schema: ${SCHEMA_ID}`, "version: '1'", 'id: implied', 'name: Implied labels', 'nodes:',
    '  person:', '    label: Person', '  employee:', '    labels:', '      identifier: Employee', '      implied: [Person, Staff]',
    '  company:', '    label: Company', 'relationships:',
    '  WORKS_AT:', '    type: WORKS_AT', '    from: {node: employee}', '    to: {node: company}', ''].join('\n');
  const o = parseOntology(text);
  const db = fresh();
  store.openStore(db, cl, o);
  say(`kinds ${o.types.map((t) => `${t.id}${t.implied.length ? ` (implied ${t.implied.join(', ')})` : ''}`).join(', ')}; graph type node types: ` +
    `${replay.splitGraphType(currentGraphType(db, cl)).elements.filter((e) => !e.includes(')-[')).length} (the kinds only)`);
  const { g, p } = handTrace(db, 'by hand', [
    { text: 'Ann Lee works at Acme Labs.', mentions: [['Ann Lee', 'Employee', 0.95], ['Acme Labs', 'Company', 0.95]], claims: [['Ann Lee', 'WORKS_AT', 'Acme Labs', 0.9]] },
  ]);
  for (const c of g.claims) say(`claim ${claimText(c)}`);
  say(`publish: ${p.entities} entities, ${p.relationships} relationship`);
  for (const l of published(db)) say(`  ${l}`);
  const exported = store.exportCypher(db, cl).split('\n').filter((l) => l.startsWith('SET e:')).join(' | ');
  say(`exportCypher: ${exported}`);
  // The labels follow the document: the same ontology re-applied without the implied labels takes them off the
  // entities (the page's open-store re-gates and publishes when the ontology's sha changes; worker.js).
  /** The published entities' labels three ways: the graph, the dump (lib/replay.mjs), exportCypher's SET lines. */
  const labelsNow = () => {
    const graph = cl.exec(db, 'MATCH (e:_Entity) RETURN e.key AS key, labels(e) AS labels ORDER BY key').rows.map((r) => `${r.key} ${[...r.labels].sort().join(':')}`);
    const dumped = replay.dump(db).nodes.filter((x) => x.labels.includes('_Entity')).map((x) => `${x.props.key} ${[...x.labels].sort().join(':')}`).sort();
    const sets = store.exportCypher(db, cl).split('\n').filter((l) => l.startsWith('SET e:')).map((l) => l.split(',')[0]).join(' | ');
    return { graph, same: JSON.stringify(graph) === JSON.stringify(dumped), sets };
  };
  const plain = parseOntology(text.replace('    labels:\n      identifier: Employee\n      implied: [Person, Staff]\n', '    label: Employee\n'));
  store.openStore(db, cl, plain);
  store.gate(db, cl);
  const pPlain = store.publish(db, cl);
  const lPlain = labelsNow();
  const strayLeft = cl.exec(db, 'MATCH (e:_Entity) WHERE e:Staff OR (e:Employee AND e:Person) RETURN count(e) AS n').rows[0].n;
  say(`re-applied without the implied labels (Employee has none now), gated and published: ${pPlain.relabelled} labels removed; entities ${lPlain.graph.join(', ')}; ` +
    `the dump says the same: ${lPlain.same ? 'yes' : 'NO'}; exportCypher: ${lPlain.sets}`);
  const back = parseOntology(text);
  store.openStore(db, cl, back);
  store.gate(db, cl);
  const pBack = store.publish(db, cl);
  const lBack = labelsNow();
  say(`re-applied with them again: ${pBack.relabelled} labels removed; entities ${lBack.graph.join(', ')}; the dump says the same: ${lBack.same ? 'yes' : 'NO'}; exportCypher: ${lBack.sets}`);
  pin('implied labels follow the document (removed when it no longer implies them)', strayLeft === 0 && pPlain.relabelled === 2 && lPlain.same && lBack.same &&
    lPlain.graph.includes('Employee:ANN_LEE Employee:_Entity') && lBack.graph.includes('Employee:ANN_LEE Employee:Person:Staff:_Entity') &&
    !lPlain.sets.includes('Person') && lBack.sets.includes('SET e:`Employee`:`Person`:`Staff`'),
  'Employee only, then Employee:Person:Staff, the dump and exportCypher agreeing', `${strayLeft} ${pPlain.relabelled} ${lPlain.graph} | ${lBack.graph}`);
  const ann = g.mentions.find((m) => m.text === 'Ann Lee');
  store.addVerdict(db, cl, { target: ann.key, value: 'reject' });
  store.gate(db, cl);
  const p2 = store.publish(db, cl);
  const left = cl.exec(db, 'MATCH (e) WHERE e:Employee OR e:Staff OR e:Person RETURN count(e) AS n').rows[0].n;
  say(`Ann Lee rejected, published again: ${p2.entities} entities, ${p2.relationships} relationships; nodes still labelled Employee, Person or Staff: ${left}`);
  const bad = auditRows(db);
  say(`audits: ${bad.length ? `rows in ${bad.join(', ')}` : '0 rows each'}`);
  pin('implied labels (labels.implied) on published entities', published(db).length === 0 && p.relationships === 1 && left === 0 && bad.length === 0 &&
    exported.includes('SET e:`Employee`:`Person`:`Staff`'), 'Employee:Person:Staff, then gone', exported);
  const before = cl.exec(db, "MATCH (k:_Kind) RETURN k.id AS id, k.implied AS implied ORDER BY k.ord").rows;
  say(`_Kind.implied: ${before.map((r) => `${r.id} ${JSON.stringify(r.implied)}`).join(', ')}`);
  db.free();
}
{
  sub('a store an earlier build of this page wrote: its ontology as YAML (with its base), no document');
  const db = fresh();
  const o = ccgOf('financial-services');
  store.openStore(db, cl, o);
  const src = ccg.get('financial-services').src;
  const oldSha = ontologySha(src, '_base', baseText);
  cl.exec(db, `MATCH (x:_Ontology) SET x.yaml = $yaml, x.inherits = '_base', x.base_yaml = $base, x.sha = $sha
REMOVE x.doc, x.spec, x.converted_from, x.source_sha RETURN count(x) AS n`, { yaml: src, base: baseText, sha: oldSha });
  const row = readOntology(db, cl);
  const back = ontologyFromStored(row);
  say(`readOntology: doc ${row.doc === null ? 'none' : 'set'}, yaml ${typeof row.yaml === 'string' ? 'set' : 'none'}, inherits ${row.inherits}; ontologyFromStored converts it ` +
    `(from ${back.convertedFrom}): the same kinds, links and asks as the bundled document: ${canonJson(modelSchema(back)) === canonJson(modelSchema(o)) && back.sha === o.sha ? 'yes' : 'NO'}`);
  const res = store.openStore(db, cl, back);
  const after = readOntology(db, cl);
  say(`opened with it: previous sha the YAML's ${res.ontology.previousSha === oldSha ? 'yes' : 'NO'}, altered ${res.ontology.altered}; now stored: the document ` +
    `${after.doc === toCanonicalJson(o.doc) ? 'yes' : 'NO'}, yaml, inherits and base_yaml gone ${after.yaml === null && after.inherits === null && after.base_yaml === null ? 'yes' : 'NO'}, ` +
    `converted_from ${after.converted_from}`);
  pin('an earlier build\'s stored YAML opens and is replaced by the document', back.sha === o.sha && res.ontology.previousSha === oldSha && !res.ontology.altered &&
    after.doc === toCanonicalJson(o.doc) && after.yaml === null && after.converted_from === 'create-context-graph', 'converted, then stored as a document', JSON.stringify({ ...after, doc: null }).slice(0, 120));
  db.free();
}

{
  sub('a store the last draft build wrote: its document in the draft format (the live site before this build), converted on open');
  const db = fresh();
  const o = ccgOf('financial-services');
  store.openStore(db, cl, o);
  // What that build stored: its draft document as JSON (harness/fixtures/financial-services.draft.ontology.yaml is its
  // bundled file), its spec 1.0.0 and a sha of its own.
  const draftDoc = parseDocument(readFileSync(join(DRAFT_FIXTURES, 'financial-services.draft.ontology.yaml'), 'utf8'));
  const oldSha = sha256(JSON.stringify(draftDoc));
  cl.exec(db, "MATCH (x:_Ontology) SET x.doc = $doc, x.spec = '1.0.0', x.sha = $sha RETURN count(x) AS n", { doc: JSON.stringify(draftDoc), sha: oldSha });
  const row = readOntology(db, cl);
  const back = ontologyFromStored(row);
  say(`readOntology: a draft document (isDraft ${isDraft(JSON.parse(row.doc))}), spec ${row.spec}; ontologyFromStored converts it: the same kinds, links, asks and sha as the bundled document: ` +
    `${canonJson(modelSchema(back)) === canonJson(modelSchema(o)) && back.sha === o.sha ? 'yes' : 'NO'}`);
  const res = store.openStore(db, cl, back);
  const after = readOntology(db, cl);
  say(`opened with it: previous sha the draft's ${res.ontology.previousSha === oldSha ? 'yes' : 'NO'}, altered ${res.ontology.altered}; now stored: the published document ` +
    `${after.doc === toCanonicalJson(o.doc) ? 'yes' : 'NO'}, spec ${after.spec}, sha the bundled one's ${after.sha === o.sha ? 'yes' : 'NO'}`);
  pin('a draft build\'s store opens and its document is stored again in the published format', back.sha === o.sha && res.ontology.previousSha === oldSha && !res.ontology.altered &&
    after.doc === toCanonicalJson(o.doc) && after.spec === SPEC_VERSION && after.sha === o.sha, 'converted, stored as 1.1', JSON.stringify({ ...after, doc: null }).slice(0, 160));
  db.free();
}

section('the id rule and the create-context-graph format\'s refusals (D8)');
{
  const ccgDoc = (types, rels, extra = '') => `${extra}domain: {id: t, name: T}\nentity_types:\n${types.map((l) => `  - {label: ${l}, pole_type: OBJECT}`).join('\n')}\n` +
    `relationships:\n${rels.map(([t, s, x]) => `  - {type: ${t}, source: ${s}, target: ${x}}`).join('\n')}\n`;
  const v1 = (labels, rels) => `schema: ${SCHEMA_ID}\nversion: '1'\nid: t\nnodes:\n${labels.map((l) => `  ${l}:\n    label: ${l}`).join('\n')}\n` +
    `relationships:\n${rels.map(([t, s, x]) => `  ${t}:\n    type: ${t}\n    from: {node: ${s}}\n    to: {node: ${x}}`).join('\n')}\n`;
  const cases = [
    ['an entity type label with a leading _ (create-context-graph)', ccgDoc(['_Secret', 'Account'], [['OWNS', '_Secret', 'Account']]), false],
    ['a relationship type with a leading _ (create-context-graph)', ccgDoc(['Person', 'Account'], [['_OWNS', 'Person', 'Account']]), false],
    ['a node label with a leading _ (Ontology Graph Spec)', v1(['_Private', 'Account'], [['OWNS', '_Private', 'Account']]), false],
    ['a relationship type with a leading _ (Ontology Graph Spec)', v1(['Person', 'Account'], [['_OWNS', 'Person', 'Account']]), false],
    ['kinds named Entity and Claim, a link named IN (no longer reserved)', ccgDoc(['Entity', 'Claim'], [['IN', 'Claim', 'Entity']]), true],
    ['a relationship to an undeclared label', ccgDoc(['Person', 'Account'], [['OWNS', 'Person', 'Acount']]), false],
    ['an unknown base', ccgDoc(['Person', 'Account'], [['OWNS', 'Person', 'Account']], 'inherits: _other\n'), false],
    ['inherits under domain (ontology.py reads both)', ccgDoc(['Account', 'Card'], [['OWNS', 'Person', 'Account']]).replace('domain: {id: t, name: T}', 'domain: {id: t, name: T, inherits: _base}'), true],
    ['two entity types with one label', ccgDoc(['Person', 'Person'], []), false],
    ['a label not in NFC form', ccgDoc(['Ärzte'.normalize('NFD'), 'Klinik'], []), false],
  ];
  let held = 0;
  for (const [name, text, want] of cases) {
    let got;
    try {
      const o = parseOntology(text, { bases: BASES });
      got = { ok: true, text: `accepted: kinds ${o.types.map((t) => t.id).join(', ')}; links ${o.relations.map((r) => r.id).join(', ') || 'none'}` };
    } catch (e) {
      if (!(e instanceof OntologyError)) throw e;
      got = { ok: false, text: `refused: ${e.message}` };
    }
    if (got.ok === want) held++;
    else pins.push(`PIN: D8 id rule (${name}): expected ${want ? 'accept' : 'refuse'}, got ${got.text}`);
    say(`${name}: ${got.text}`);
  }
  let noBase;
  try { parseOntology(ccg.get('financial-services').src); noBase = 'accepted'; } catch (e) { noBase = `refused: ${e.message}`; }
  say(`financial-services.yaml with no base loaded: ${noBase}`);
  pin('inherits (a missing base is an error)', noBase.startsWith('refused: This file inherits _base, but no base of that name is loaded'), 'refused', noBase);
  let identInternal;
  try { store.ident('_Entity'); identInternal = 'takes it'; } catch (e) { identInternal = describe(e); }
  say(`isOntologyId('_Entity') ${isOntologyId('_Entity')}; isOntologyId('Entity') ${isOntologyId('Entity')}; store.js ident('_Entity') -> ${identInternal}`);
  say(`the example's own labels: ${INTERNAL_LABELS.join(', ')}; relationship types: ${INTERNAL_TYPES.join(', ')}`);
  pin('D8 (the reserved prefix)', held === cases.length && !isOntologyId('_Entity') && isOntologyId('Entity') && identInternal.startsWith('StoreError ident') &&
    [...INTERNAL_LABELS, ...INTERNAL_TYPES].every((x) => x.startsWith(RESERVED_PREFIX)), `${cases.length} cases as designed`, `${held}, ${identInternal}`);
}
{
  sub('a store an earlier build wrote, with unprefixed labels, is refused before anything is written');
  const db = fresh();
  cl.exec(db, 'CREATE INDEX document_id IF NOT EXISTS FOR (n:Document) ON (n.id)');
  cl.exec(db, 'CREATE (:Document {id: $id})', { id: 'old' });
  const before = replay.contentDigest(db);
  let err;
  try {
    store.openStore(db, cl, ccgOf('financial-services'));
    err = 'opened';
  } catch (e) {
    err = describe(e);
  }
  const indexes = cl.exec(db, "SHOW INDEXES YIELD name, type WHERE type <> 'LOOKUP' RETURN name ORDER BY name").rows.map((r) => r.name);
  say(`store.openStore on it -> ${err}`);
  say(`afterwards: content unchanged ${replay.contentDigest(db) === before ? 'yes' : 'NO'}; indexes ${indexes.join(', ')}`);
  pin('legacy store refused', err.startsWith('StoreError legacy: this store was written by an earlier build') && replay.contentDigest(db) === before &&
    indexes.join() === 'document_id', 'StoreError legacy, nothing written', err);
  db.free();
}

// ---- 2. a generic document (no createContextGraph extension) ------------------------------------------
/**
 * A document as an object: nodes keyed by label ([label, description?]), relationship entries
 * keyed by type, or TYPE__FROM__TO when a type has several pairs ([type, from, to, extra?]).
 * @param {string} id @param {Array<[string, string?]>} kinds @param {Array<[string, string, string, any?]>} [links] @param {any} [extra]
 */
function v1doc(id, kinds, links = [], extra = {}) {
  const nodes = {};
  for (const [label, description] of kinds) nodes[label] = description === undefined ? { label } : { label, description };
  const relationships = {};
  const pairsOf = (type) => links.filter((l) => l[0] === type).length;
  for (const [type, from, to, more] of links) {
    relationships[pairsOf(type) > 1 ? `${type}__${from}__${to}` : type] = { type, from: { node: from }, to: { node: to }, ...(more ?? {}) };
  }
  return { schema: SCHEMA_ID, version: '1', id, ...extra, nodes, ...(links.length ? { relationships } : {}) };
}
/** parseOntology on a document object: {ok, o} or {ok: false, error}. @param {any} doc */
function ours(doc) {
  try {
    return { ok: true, o: parseOntology(JSON.stringify(doc)) };
  } catch (e) {
    if (!(e instanceof OntologyError)) throw e;
    return { ok: false, error: e.message };
  }
}
const generic = parseOntology(GENERIC_YAML);
/** GENERIC_YAML as an object, for the edits below. */
const genericDoc = () => structuredClone(generic.doc);
section(`a generic Ontology Graph Spec 1.1 document: no createContextGraph extension (harness/fixtures.mjs GENERIC_YAML, ${generic.id})`);
say('Any valid document without the createContextGraph:domain extension is read as it is and asked as create-context-graph\'s');
say('documents are, but for descriptions: each kind by its label as text with the node\'s own description (none when it has none),');
say('each link as its phrase between its endpoints\' label texts. It takes the same default cutoffs (store.defaultGate). It may');
say('carry the two extensions that keep edgextract\'s names: edgextract:gazetteer (rule 1\'s listed names) and edgextract:symmetric.');
{
  const o = generic;
  const gt = graphTypeSpec(o);
  const ms = modelSchema(o);
  const schema = checkSchema(ms.schema);
  say(`format ${o.format}; store ${storeName(o)}; kinds ${o.types.map((t) => t.id).join(', ')}; links ${o.relations.map((r) => `${r.id}${r.symmetric ? ' (symmetric)' : ''}`).join(', ')}`);
  say(`asked (gliner.js "label:description"): ${schema.entities.map((e) => (e.description ? `${e.id}:${e.description}` : e.id)).join(', ')}`);
  say(`links asked: ${schema.relations.map((r) => `"${r}"`).join(', ')}`);
  say(`gazetteer: ${o.names.map(([n, k]) => `${n} (${k})`).join(', ')}`);
  say(typedLine(o, gt));
  say(`untyped (${gt.untyped.length}):${gt.untyped.length ? '' : ' none'}`);
  for (const u of gt.untyped) say(`  ${u.id}: ${u.reason}`);
  const asked = o.types.map((t) => `${t.ask.label}:${t.ask.description ?? ''}`).join('|');
  pin('a generic document is asked by label text with its own descriptions', o.format === 'generic' &&
    asked === 'person:A named person.|company:A named company or business.|location:' &&
    o.relations.find((r) => r.id === 'INVESTED_IN')?.ask === 'person invested in company or company invested in company' &&
    o.types.every((t) => ms.kindOf.get(t.ask.label) === t.id) && o.relations.every((r) => ms.relOf.get(r.ask) === r.id),
  'person, company (with descriptions), location (none); links between their endpoints; mapping back', `${o.format} ${asked}`);
  const defaults = store.defaultGate(o.format, 'small');
  say(`default cutoffs (store.defaultGate('${o.format}', 'small')): kinds keep ${defaults.entKeep.toFixed(2)}, links keep ${defaults.relKeep.toFixed(2)}; ` +
    `the same as create-context-graph's: ${JSON.stringify(defaults) === JSON.stringify(store.defaultGate('create-context-graph', 'small')) ? 'yes' : 'NO'}` +
    `; base-v1's the same too: ${JSON.stringify(store.defaultGate(o.format, 'base')) === JSON.stringify(store.defaultGate('create-context-graph', 'base')) ? 'yes' : 'NO'}`);
  pin('a generic document takes create-context-graph\'s defaults', ['small', 'base'].every((m) => JSON.stringify(store.defaultGate(o.format, m)) ===
    JSON.stringify(store.defaultGate('create-context-graph', m))), 'equal', JSON.stringify(defaults));

  const db = fresh();
  const res = applyOntology(db, o, cl);
  const back = currentGraphType(db, cl);
  say(`applyOntology: altered ${res.altered}, previous sha ${res.previousSha === null ? 'none' : 'set'}`);
  say('graph type read back (SHOW CURRENT GRAPH TYPE, CONSTRAINT entries aside):');
  say(indent(back));
  say(`read back = graphTypeSpec(o).spec: ${back === gt.spec ? 'yes' : 'NO'}`);
  pin(`O4/D15 graph type round trip (${o.id})`, back === gt.spec, 'the derived spec back', back);
  const c1 = layer(db);
  const k1 = constraints(db);
  say(`layer: ${layerText(c1)}`);
  say(`constraints: UNIQUE ${k1.own.join(', ')}; dependent (graph type) ${k1.dependent}`);
  say(`lookup indexes: ${lookupIndexes(db).join(', ') || 'none (the constraints\' backing indexes serve the lookups)'}`);
  const stored = readOntology(db, cl);
  const linkRows = cl.exec(db, 'MATCH (l:_LinkType) RETURN l.id AS id, l.typed AS typed, l.pairs AS pairs ORDER BY l.ord').rows;
  const okStored = stored.sha === o.sha && stored.doc === toCanonicalJson(o.doc) && stored.spec === SPEC_VERSION && stored.graph_type === gt.spec &&
    stored.format === 'generic' && stored.converted_from === null && stored.yaml === null &&
    canonJson(linkRows.map((r) => [r.id, r.typed, r.pairs])) === canonJson(o.relations.map((r) => [r.id, gt.typed.includes(r.id), r.pairs.map(([x, y]) => `${x}|${y}`)])) &&
    ontologyFromStored(stored).sha === o.sha;
  say(`stored _Ontology: the document (canonical JSON), its sha and graph_type, format generic; _LinkType.typed and .pairs as derived: ${okStored ? 'yes' : 'NO'}`);
  pin(`D8 stored ontology (${o.id})`, okStored, 'the document, its sha and spec', JSON.stringify({ ...stored, doc: null }).slice(0, 120));
  const d1 = replay.contentDigest(db);
  const res2 = applyOntology(db, o, cl);
  const same = canonJson(layer(db)) === canonJson(c1) && replay.contentDigest(db) === d1 && canonJson(constraints(db)) === canonJson(k1);
  say(`applied again: altered ${res2.altered}, store content and constraints unchanged: ${same ? 'yes' : 'NO'}`);
  pin(`D9 idempotent apply (${o.id})`, !res2.altered && same, 'no ALTER and no change', `altered ${res2.altered}, same ${same}`);
  pin(`R9 lookup keys (${o.id})`, keysBuilt(db) && k1.own.join() === UNIQUES.join(),
    '4 UNIQUE, their backing indexes built, no standalone index', `${lookupIndexes(db)} / ${backingIndexes(db)} / ${k1.own}`);
  db.free();

  // Through the gate and publish without the model: a typed link, the symmetric one both ways (one edge), and the
  // two-pair INVESTED_IN, which only the gate checks.
  const g2 = fresh();
  store.openStore(g2, cl, o);
  const { g, p } = handTrace(g2, 'by hand', [
    { text: 'Ada Lovelace founded Northwind.', mentions: [['Ada Lovelace', 'Person', 0.95], ['Northwind', 'Company', 0.93]],
      claims: [['Ada Lovelace', 'FOUNDED', 'Northwind', 0.9]] },
    { text: 'Acme Inc partners with Northwind, and Northwind partners with Acme Inc.', mentions: [['Acme Inc', 'Company', 0.95], ['Northwind', 'Company', 0.93]],
      claims: [['Acme Inc', 'PARTNER_OF', 'Northwind', 0.9], ['Northwind', 'PARTNER_OF', 'Acme Inc', 0.88]] },
    { text: 'Acme Inc invested in Northwind, and so did Ada Lovelace, though Paris did not.', mentions: [['Acme Inc', 'Company', 0.95], ['Northwind', 'Company', 0.93],
      ['Ada Lovelace', 'Person', 0.95], ['Paris', 'Location', 0.9]],
    claims: [['Acme Inc', 'INVESTED_IN', 'Northwind', 0.9], ['Ada Lovelace', 'INVESTED_IN', 'Northwind', 0.9], ['Paris', 'INVESTED_IN', 'Northwind', 0.9]] },
  ]);
  for (const c of g.claims) say(`claim ${claimText(c)}`);
  say(`publish: ${p.entities} entities, ${p.relationships} relationships`);
  for (const l of published(g2)) say(`  ${l}`);
  const rules = g.claims.map((c) => `${c.htext}>${c.rel}>${c.ttext}:${c.rule}`).sort().join(', ');
  const partners = cl.exec(g2, 'MATCH (:_Entity)-[r:PARTNER_OF]->(:_Entity) RETURN count(r) AS n').rows[0].n;
  pin('a generic document through the gate (symmetric once, two-pair legality)', partners === 1 && rules.includes('Paris>INVESTED_IN>Northwind:illegal') &&
    rules.includes('Ada Lovelace>INVESTED_IN>Northwind:band') && rules.includes('Acme Inc>INVESTED_IN>Northwind:band'), 'one PARTNER_OF edge; Location -> Company illegal', rules);
  const bad = auditRows(g2);
  say(`audits: ${bad.length ? `rows in ${bad.join(', ')}` : '0 rows each'}`);
  pin('audits (a generic document)', bad.length === 0, '0 rows', bad.join(', '));
  g2.free();
}
{
  sub("edgextract's ontology YAML, which earlier builds converted, is refused; stores an earlier build made for edgextract's ontologies");
  const old = 'id: company_news\nversion: 1\ntitle: Company news\ntypes:\n  - id: PERSON\n    description: A named person.\n' +
    '  - id: COMPANY\n    description: A named company.\nrelations:\n  - id: WORKS_FOR\n    description: The person works for the company.\n' +
    '    domain: [PERSON]\n    range: [COMPANY]\ngazetteer:\n  Jane Doe: PERSON\n';
  let pasted;
  try { parseOntology(old); pasted = 'accepted'; } catch (e) { pasted = `${describe(e)} [legacyFormat ${e.legacyFormat ?? 'none'}]`; }
  say(`edgextract's YAML pasted or loaded -> ${pasted}`);
  pin('edgextract\'s YAML is no longer read', pasted.startsWith('OntologyError: This looks like edgextract\'s ontology YAML') && pasted.endsWith('[legacyFormat edgextract]'),
    'refused, marked legacyFormat', pasted);
  let other;
  try { parseOntology('id: x\nkinds: [A, B]\n'); other = 'accepted'; } catch (e) { other = describe(e); }
  say(`a file of neither format -> ${other}`);

  // A store an earlier build made for an edgextract ontology, after the documents: it holds the document that build
  // converted from edgextract's YAML (converted_from 'edgextract', its format 'edgextract', kinds and links at the
  // cutoffs that build gave edgextract's format, 0.85/0.70, following the defaults). It opens with that document.
  const conv = v1doc('company_news', [['PERSON', 'A named person.'], ['COMPANY', 'A named company.']], [['WORKS_FOR', 'PERSON', 'COMPANY', { description: 'The person works for the company.' }]],
    { name: 'Company news', extensions: { custom: { 'edgextract:gazetteer': { 'Jane Doe': 'PERSON' } } } });
  const db = fresh();
  const first = parseOntology(JSON.stringify(conv));
  store.openStore(db, cl, first, {}, { model: 'small' });
  handTrace(db, 'by hand', [{ text: 'Jane Doe works for Acme Inc.', mentions: [['Jane Doe', 'PERSON', 0.8], ['Acme Inc', 'COMPANY', 0.8]], claims: [['Jane Doe', 'WORKS_FOR', 'Acme Inc', 0.65]] }]);
  cl.exec(db, "MATCH (o:_Ontology) SET o.format = 'edgextract', o.converted_from = 'edgextract', o.source_sha = $sha RETURN count(o) AS n", { sha: sha256(old) });
  cl.exec(db, "MATCH (k:_Kind) SET k.keep = 0.85, k.drop = 0.2, k.cut_src = 'default' RETURN count(k) AS n");
  cl.exec(db, "MATCH (l:_LinkType) SET l.keep = 0.7, l.drop = 0.2, l.cut_src = 'default' RETURN count(l) AS n");
  store.gate(db, cl);
  store.publish(db, cl);
  const before = store.readGate(db, cl);
  const row = readOntology(db, cl);
  const back = ontologyFromStored(row);
  const opened = store.openStore(db, cl, back, {}, { model: 'small' });
  const cut = cl.exec(db, 'MATCH (k:_Kind) RETURN k.keep AS keep ORDER BY k.ord').rows.map((r) => r.keep).join('/');
  const after = store.gate(db, cl);
  store.publish(db, cl);
  const now = readOntology(db, cl);
  const band = (gg) => gg.claims.map((c) => `${c.band} by ${c.rule}`).join(', ');
  say(`an earlier build's store for edgextract's company_news (its document, converted_from ${row.converted_from}, format ${row.format}): ` +
    `ontologyFromStored reads it as ${back.format} (converted from ${back.convertedFrom}); asked ${modelSchema(back).schema.entities.map((e) => `"${e.id}"`).join(', ')}`);
  say(`  open: the default cutoffs move from that build's 0.85/0.70 to ${store.defaultGate(back.format, 'small').entKeep.toFixed(2)}/${store.defaultGate(back.format, 'small').relKeep.toFixed(2)} ` +
    `(${opened.ontology.cutoffs.moved} moved; kinds now ${cut}); the claim at 0.65: ${band(before)} -> ${band(after)}; stored format now ${now.format}`);
  pin('an earlier build\'s edgextract store opens with its own document', back.format === 'generic' && back.convertedFrom === 'edgextract' &&
    back.sha === first.sha && opened.ontology.cutoffs.moved > 0 && now.format === 'generic' && band(before) === 'review by band' && band(after) === 'keep by band',
  'generic, its own document, defaults moved, re-gated', `${back.format} ${opened.ontology.cutoffs.moved} ${now.format} ${band(after)}`);
  db.free();

  // Before the documents, a store kept edgextract's YAML itself: refused, marked, and the page offers to delete it.
  const pre = fresh();
  store.openStore(pre, cl, parseOntology(JSON.stringify(conv)), {}, { model: 'small' });
  cl.exec(pre, `MATCH (x:_Ontology) SET x.yaml = $yaml, x.sha = $sha
REMOVE x.doc, x.spec, x.converted_from, x.source_sha RETURN count(x) AS n`, { yaml: old, sha: sha256(old) });
  let refused;
  try { ontologyFromStored(readOntology(pre, cl)); refused = 'opened'; } catch (e) { refused = `${describe(e)} [legacyFormat ${e.legacyFormat ?? 'none'}]`; }
  say(`a store an earlier build made before the Ontology Graph Spec documents, holding edgextract's YAML -> ${refused}`);
  say('  (web/worker.js turns it into StoreError legacy-ontology: the earlier-build banner, whose button deletes the store, delete-store)');
  pin('a store holding edgextract\'s YAML is refused', refused.startsWith('OntologyError: this store was written by an earlier build of this page for an ontology in edgextract\'s format') &&
    refused.endsWith('[legacyFormat edgextract]'), 'refused, marked legacyFormat', refused);
  pre.free();
}
{
  const samples = JSON.parse(readFileSync(join(DATA, 'samples', 'samples.json'), 'utf8'));
  sub(`samples (data/samples/samples.json): ${samples.length}, each with its ontology`);
  const ccgWith = [...ccg.keys()].filter((id) => samples.some((s) => s.ontology === id));
  say(`create-context-graph domains with samples: ${ccgWith.length ? ccgWith.map((id) => `${id} (${samples.filter((s) => s.ontology === id).length})`).join(', ') : 'none'}`);
  const orphans = samples.filter((s) => !ccg.has(s.ontology) || s.group !== 'ccg').map((s) => s.id);
  pin('data (every sample names a bundled ontology, in the ccg group)', orphans.length === 0, 'none without', orphans.join(', '));
}

// ---- 3. the graph type enforces (O4) -------------------------------------------------------------------
section(`the graph type enforces endpoints and names (O4), on ${generic.id}`);
{
  const db = fresh();
  applyOntology(db, generic, cl);
  show(db, 'seed (dynamic labels)', 'UNWIND $rows AS r CREATE (n:_Entity:$(r.kind) {name: r.name}) RETURN count(n) AS n',
    { rows: [{ kind: 'Person', name: 'Ada Lovelace' }, { kind: 'Company', name: 'Northwind' }, { kind: 'Location', name: 'Paris' }] });
  const legal = show(db, 'legal (:Person)-[:FOUNDED]->(:Company)',
    'MATCH (a:Person {name: $a}) WHERE $a IS NOT NULL MATCH (c:Company {name: $c}) WHERE $c IS NOT NULL CREATE (a)-[:FOUNDED]->(c) RETURN 1 AS ok',
    { a: 'Ada Lovelace', c: 'Northwind' });
  pin('O4 (a legal typed edge)', !(legal instanceof Error), 'accepted', errText(legal));
  const endpoint = (r, want) => isErr(r, (e) => e.category === 'constraint' &&
    e.message.startsWith(`ConstraintValidationFailed: endpoint label presence verification failed: expected ${want}`));
  const bad = show(db, 'illegal (:Location)-[:FOUNDED]->(:Company), CREATE',
    'MATCH (l:Location {name: $l}) WHERE $l IS NOT NULL MATCH (c:Company {name: $c}) WHERE $c IS NOT NULL CREATE (l)-[:FOUNDED]->(c) RETURN 1 AS ok',
    { l: 'Paris', c: 'Northwind' });
  pin('O4 (an illegal edge refused)', endpoint(bad, 'Person'), 'ConstraintValidationFailed ... expected Person', errText(bad));
  const dyn = show(db, 'illegal, through a dynamic type $(t), CREATE',
    'MATCH (l:Location {name: $l}) WHERE $l IS NOT NULL MATCH (c:Company {name: $c}) WHERE $c IS NOT NULL CREATE (l)-[:$($t)]->(c) RETURN 1 AS ok',
    { l: 'Paris', c: 'Northwind', t: 'FOUNDED' });
  pin('O4 (an illegal edge through a dynamic type)', endpoint(dyn, 'Person'), 'ConstraintValidationFailed ... expected Person', errText(dyn));
  const dynMerge = show(db, 'illegal, through a dynamic type $(t), MERGE',
    'MATCH (l:Location {name: $l}) WHERE $l IS NOT NULL MATCH (c:Company {name: $c}) WHERE $c IS NOT NULL MERGE (l)-[:$($t)]->(c) RETURN 1 AS ok',
    { l: 'Paris', c: 'Northwind', t: 'FOUNDED' });
  pin('O4 (an illegal MERGE through a dynamic type)', endpoint(dynMerge, 'Person'), 'ConstraintValidationFailed ... expected Person', errText(dynMerge));
  const untyped = show(db, 'untyped INVESTED_IN from a Location (the gate\'s job, not the engine\'s)',
    'MATCH (l:Location {name: $l}) WHERE $l IS NOT NULL MATCH (c:Company {name: $c}) WHERE $c IS NOT NULL CREATE (l)-[:INVESTED_IN]->(c) RETURN 1 AS ok',
    { l: 'Paris', c: 'Northwind' });
  pin('O5 (an untyped link is not checked)', !(untyped instanceof Error), 'accepted', errText(untyped));
  const noName = show(db, 'a kind node without name', 'CREATE (n:Person {display: $d}) RETURN 1 AS ok', { d: 'Jane' });
  // The graph type's own constraints are named by hash (constraint_<hex>); a missing name breaks its
  // existence constraint ("requires properties"), a wrongly typed one its type constraint.
  pin('O4 (name :: STRING NOT NULL)', isErr(noName, (e) => e.category === 'constraint' &&
    /ConstraintValidationFailed: `constraint_[0-9a-f]+` requires properties/.test(e.message)),
  'ConstraintValidationFailed `constraint_<hex>` requires properties', errText(noName));
  const intName = show(db, 'a kind node with an integer name', 'CREATE (n:Person {name: 42}) RETURN 1 AS ok');
  pin('O4 (name must be a STRING)', isErr(intName, (e) => e.category === 'constraint'), 'ConstraintValidationFailed', errText(intName));
  const orphan = show(db, 'REMOVE a typed endpoint\'s kind label', 'MATCH (a:Person {name: $a}) WHERE $a IS NOT NULL REMOVE a:Person RETURN 1 AS ok', { a: 'Ada Lovelace' });
  pin('O4 (REMOVE that orphans an endpoint)', isErr(orphan, (e) => e.category === 'constraint'), 'ConstraintValidationFailed', errText(orphan));
  const unknown = show(db, 'an unknown label', 'CREATE (n:WIDGET {name: $n}) RETURN labels(n) AS labels', { n: 'w' });
  pin('O5 (open semantics: unknown labels)', !(unknown instanceof Error), 'accepted', errText(unknown));
  const unknownRel = show(db, 'an unknown relationship type',
    'MATCH (a:Person {name: $a}) WHERE $a IS NOT NULL MATCH (c:Company {name: $c}) WHERE $c IS NOT NULL CREATE (a)-[r:ADMIRES]->(c) RETURN type(r) AS type',
    { a: 'Ada Lovelace', c: 'Northwind' });
  pin('O5 (open semantics: unknown types)', !(unknownRel instanceof Error), 'accepted', errText(unknownRel));
  show(db, 'what the projection holds', "MATCH (a:_Entity)-[r]->(b:_Entity) RETURN [l IN labels(a) WHERE l <> '_Entity'][0] AS head, type(r) AS rel, [l IN labels(b) WHERE l <> '_Entity'][0] AS tail ORDER BY rel");
  db.free();
}

// ---- 4. graph-type limits (O5) and R16 ----------------------------------------------------------------
section('graph-type limits (O5) and what ALTER ... SET does to constraints (R16)');
{
  const db = fresh();
  const two = show(db, 'one type, two source kinds (INVESTED_IN from Company and Person)',
    'ALTER CURRENT GRAPH TYPE ADD { (:Company)-[:INVESTED_IN =>]->(:Company), (:Person)-[:INVESTED_IN =>]->(:Company) }');
  pin('O5 (one domain per relationship type)', isErr(two, (e) => e.message.includes('duplicate identifying label')), 'duplicate identifying label', errText(two));
  const alt = show(db, 'a label disjunction (:Company|Person)', 'ALTER CURRENT GRAPH TYPE ADD { (:Company|Person)-[:INVESTED_IN =>]->(:Company) }');
  pin('O5 ((:A|B) endpoints do not parse)', isErr(alt, (e) => e.category === 'syntax'), 'a syntax error', errText(alt));
  const after = currentGraphType(db, cl);
  say(`graph type after both: ${after}`);
  db.free();
}
{
  const db = fresh();
  const gt = graphTypeSpec(generic);
  for (const s of ONTOLOGY_CONSTRAINTS) cl.exec(db, s);
  say(`before: UNIQUE ${constraints(db).own.join(', ')}; backing indexes ${backingIndexes(db).join(', ')}; standalone ${lookupIndexes(db).length}`);
  show(db, `ALTER CURRENT GRAPH TYPE SET <${generic.id}>`, `ALTER CURRENT GRAPH TYPE SET ${gt.spec}`);
  const k = constraints(db);
  say(`after: UNIQUE ${k.own.join(', ') || 'none'}; dependent ${k.dependent}; backing indexes left: ${backingIndexes(db).join(', ') || 'none'}`);
  pin('R16 (ALTER CURRENT GRAPH TYPE SET drops every existing constraint)', k.own.length === 0,
    'no UNIQUE left', k.own.join(', '));
  pin('R16 (a dropped constraint\'s backing index goes with it)', backingIndexes(db).length === 0, 'no backing index left', backingIndexes(db).join(', '));
  const res = applyOntology(db, generic, cl);
  say(`applyOntology afterwards: altered ${res.altered} (the elements already match); UNIQUE ${constraints(db).own.join(', ')}`);
  pin('applyOntology re-creates its UNIQUE constraints', constraints(db).own.join() === UNIQUES.join() && keysBuilt(db), UNIQUES.join(), constraints(db).own.join());
  db.free();
}

// ---- 5. data blocking an ALTER (O5, D14) -----------------------------------------------------------------
section('editing an ontology over data that breaks it (O5, D14 "rebuild the graph")');
{
  const d = genericDoc();
  d.relationships.FOUNDED.from.node = 'company';
  d.relationships.FOUNDED.description = 'The company founded the company.';
  const edited = parseOntology(JSON.stringify(d));
  const db = fresh();
  const oldSpec = applyOntology(db, generic, cl).spec;
  cl.exec(db, 'UNWIND $rows AS r CREATE (n:_Entity:$(r.kind) {name: r.name})', { rows: [{ kind: 'Person', name: 'Ada Lovelace' }, { kind: 'Company', name: 'Northwind' }] });
  cl.exec(db, 'MATCH (a:Person {name: $a}) WHERE $a IS NOT NULL MATCH (c:Company {name: $c}) WHERE $c IS NOT NULL CREATE (a)-[:FOUNDED {p: toFloat($p)}]->(c)',
    { a: 'Ada Lovelace', c: 'Northwind', p: 0.9 });
  say('the store holds (:Person)-[:FOUNDED]->(:Company); the edit makes FOUNDED (:Company)-[:FOUNDED]->(:Company)');
  const raw = show(db, 'a raw ALTER CURRENT GRAPH TYPE SET <edited>', `ALTER CURRENT GRAPH TYPE SET ${graphTypeSpec(edited).spec}`);
  pin('O5 (existing data blocks the ALTER)', isErr(raw, (e) => e.category === 'constraint'), 'ConstraintValidationFailed', errText(raw));
  say(`after the refused ALTER: graph type unchanged ${currentGraphType(db, cl) === oldSpec ? 'yes' : 'NO'}; ` +
    `UNIQUE constraints left: ${constraints(db).own.join(', ') || 'none'}`);
  pin('O5 (a failed ALTER keeps the old type)', currentGraphType(db, cl) === oldSpec, 'the old spec', currentGraphType(db, cl));
  let err = null;
  try {
    applyOntology(db, edited, cl);
  } catch (e) {
    err = e;
  }
  say(`applyOntology(edited) -> ${err ? describe(err) : 'applied'}`);
  pin('D14 (a blocked apply is OntologyApplyError blocked)', err instanceof OntologyApplyError && err.code === 'blocked', 'code blocked', err ? describe(err) : 'applied');
  const kept = readOntology(db, cl);
  say(`then: graph type unchanged ${currentGraphType(db, cl) === oldSpec ? 'yes' : 'NO'}; stored sha still the old document's ${kept.sha === generic.sha ? 'yes' : 'NO'}; ` +
    `UNIQUE ${constraints(db).own.join(', ')}`);
  pin('D14 (nothing of a blocked apply is written)', kept.sha === generic.sha && currentGraphType(db, cl) === oldSpec &&
    constraints(db).own.join() === UNIQUES.join(), 'old sha, old spec, 4 UNIQUE', `${kept.sha === generic.sha}, ${constraints(db).own}`);
  show(db, 'rebuild: drop the projection\'s FOUNDED edges', 'MATCH ()-[r:FOUNDED]->() DELETE r RETURN count(*) AS deleted');
  const res = applyOntology(db, edited, cl);
  const back = currentGraphType(db, cl);
  say(`applyOntology(edited) -> altered ${res.altered}; read back = derived ${back === graphTypeSpec(edited).spec ? 'yes' : 'NO'}; ` +
    `stored sha the edited document's ${readOntology(db, cl).sha === edited.sha ? 'yes' : 'NO'}; UNIQUE ${constraints(db).own.join(', ')}`);
  pin('D14 (the edit applies after the rebuild)', res.altered && back === graphTypeSpec(edited).spec && readOntology(db, cl).sha === edited.sha,
    'altered, spec and sha of the edit', `${res.altered}`);
  show(db, 'FOUNDED now', 'MATCH (l:_LinkType {id: $id}) WHERE $id IS NOT NULL MATCH (l)-[:_DOMAIN]->(d:_Kind) MATCH (l)-[:_RANGE]->(r:_Kind) RETURN d.id AS domain, r.id AS range',
    { id: 'FOUNDED' });
  db.free();
}
section('editing an ontology: the derived layer follows the document; moved cutoffs stay (D10, D14)');
{
  const db = fresh();
  applyOntology(db, generic, cl);
  show(db, 'the gate moves FOUNDED\'s keep cutoff', 'MATCH (l:_LinkType {id: $id}) WHERE $id IS NOT NULL SET l.keep = toFloat($keep) RETURN l.keep AS keep',
    { id: 'FOUNDED', keep: 0.9 });
  const d = genericDoc();
  delete d.relationships.WORKS_FOR;
  const gaz = d.extensions.custom['edgextract:gazetteer'];
  delete gaz['東京'];
  gaz['Ada Lovelace'] = 'company';
  const edited = parseOntology(JSON.stringify(d));
  pin('the edit below applies to the generic document', edited.relations.length === 4 && edited.names.length === 3, '4 links and 3 names',
    `${edited.relations.length} and ${edited.names.length}`);
  say('edit: drop WORKS_FOR, drop the name 東京, move Ada Lovelace from Person to Company');
  const res = applyOntology(db, edited, cl);
  say(`applyOntology -> altered ${res.altered}; previous sha the old document's ${res.previousSha === generic.sha ? 'yes' : 'NO'}`);
  const links = show(db, 'links and cutoffs', 'MATCH (l:_LinkType) RETURN l.id AS id, l.keep AS keep, l.drop AS drop ORDER BY l.ord');
  show(db, 'names', 'MATCH (a:_Alias)-[:_OF]->(k:_Kind) RETURN a.name AS name, k.id AS kind ORDER BY a.ord');
  const c = layer(db);
  say(`layer: ${layerText(c)}`);
  pin('D14 (an edit replaces the derived layer)', c._LinkType === 4 && c._Alias === 3 && c._OF === 3 && c._DOMAIN === 5 && c._RANGE === 4,
    '_LinkType 4, _Alias 3, _OF 3, _DOMAIN 5, _RANGE 4', layerText(c));
  pin('D10 (a moved cutoff survives an edit)', !(links instanceof Error) && links.rows[0].keep === 0.9, 'FOUNDED keep 0.9', errText(links));
  let err = null;
  try {
    applyOntology(db, ccgOf('financial-services'), cl);
  } catch (e) {
    err = e;
  }
  say(`applyOntology(financial-services) on this store -> ${err ? describe(err) : 'applied'}`);
  pin('D14 (one ontology per store)', err instanceof OntologyApplyError && err.code === 'other-ontology', 'other-ontology', err ? describe(err) : 'applied');
  db.free();
}

// ---- 6. Unicode and keyword ids end to end (D8, R6, O4) ----------------------------------------------
section('a Unicode kind id end to end (D8; unquoted Unicode identifiers parse)');
{
  const doc = v1doc('ärzte_netz', [['ÄRZTE', 'Ärztinnen und Ärzte.'], ['KLINIK', 'Eine Klinik.']], [['ARBEITET_IN', 'ÄRZTE', 'KLINIK', { description: 'Die Ärztin arbeitet in der Klinik.' }]],
    { name: 'Ärzte und Kliniken', extensions: { custom: { 'edgextract:gazetteer': { 'Dr. Müller': 'ÄRZTE' } } } });
  const o = parseOntology(JSON.stringify(doc));
  say(`parseOntology: kinds ${o.types.map((t) => t.id).join(', ')}; link ${o.relations[0].id} ("${o.relations[0].phrase}"); asked ${modelSchema(o).schema.entities.map((e) => `"${e.id}"`).join(', ')}`);
  const nfd = JSON.stringify(doc).normalize('NFD');
  let decomposed;
  try { parseOntology(nfd); decomposed = 'accepted'; } catch (e) { decomposed = describe(e); }
  say(`the same document typed decomposed (A + U+0308): ${decomposed}`);
  pin('D8 (ids must be NFC)', decomposed.startsWith('OntologyError:'), 'refused', decomposed);
  const name = storeName(o);
  say(`store: ${name} (${name.length} characters; the id is not an OPFS name, so it is folded and hashed)`);
  const db = fresh();
  const res = applyOntology(db, o, cl);
  say('graph type read back:');
  say(indent(currentGraphType(db, cl)));
  pin('O4 (a Unicode graph type round trip)', currentGraphType(db, cl) === res.spec, res.spec, currentGraphType(db, cl));
  const w = show(db, 'write through dynamic labels and type',
    'CREATE (a:_Entity:$($d) {name: $an}) CREATE (b:_Entity:$($r) {name: $bn}) CREATE (a)-[x:$($t)]->(b) RETURN type(x) AS type',
    { d: 'ÄRZTE', r: 'KLINIK', t: 'ARBEITET_IN', an: 'Dr. Müller', bn: 'Charité' });
  pin('R7 (dynamic Unicode labels and types)', !(w instanceof Error), 'accepted', errText(w));
  const rev = show(db, 'the reverse direction',
    'MATCH (a:$($d) {name: $an}) WHERE $an IS NOT NULL MATCH (b:$($r) {name: $bn}) WHERE $bn IS NOT NULL CREATE (b)-[:$($t)]->(a) RETURN 1 AS ok',
    { d: 'ÄRZTE', r: 'KLINIK', t: 'ARBEITET_IN', an: 'Dr. Müller', bn: 'Charité' });
  pin('O4 (a Unicode endpoint refused)', isErr(rev, (e) => e.category === 'constraint' && e.message.includes('endpoint label presence verification failed')),
    'ConstraintValidationFailed: endpoint label presence verification failed', errText(rev));
  show(db, 'read back, unquoted', 'MATCH (a:ÄRZTE)-[:ARBEITET_IN]->(b:KLINIK) RETURN a.name AS arzt, b.name AS klinik');
  show(db, 'the derived layer', 'MATCH (l:_LinkType)-[:_DOMAIN]->(d:_Kind) MATCH (l)-[:_RANGE]->(r:_Kind) MATCH (a:_Alias)-[:_OF]->(d) RETURN l.id AS link, d.id AS domain, r.id AS range, a.name AS alias');
  db.free();
}
section(`combining marks and the length cap: one id rule from the document to the published graph (D8; ontology.js isOntologyId, at most ${MAX_ID_CHARS})`);
{
  // व्यक्ति ("person") is a letter, a virama, letters and vowel signs (\p{M}): the id rule takes marks
  // after the first character, store.js uses the same rule, and the engine takes the id as a label,
  // a dynamic label, a relationship type and in the graph type. Published here without the model:
  // a kept mention per kind and a kept claim, as the gate leaves them, then publish() and the export.
  const K = 'व्यक्ति';
  const o = parseOntology(JSON.stringify(v1doc('hindi', [[K, 'a person'], ['COMPANY', 'a company']], [[`${K}_SE`, K, K], ['WORKS_FOR', K, 'COMPANY']])));
  const marks = [...o.types[0].id].filter((c) => /\p{M}/u.test(c)).length;
  say(`parseOntology: kinds ${o.types.map((t) => t.id).join(', ')} (${[...o.types[0].id].length} code points, ${marks} of them combining marks); ` +
    `links ${o.relations.map((r) => r.id).join(', ')}`);
  say(`isOntologyId(${K}) ${isOntologyId(K)}; store.js ident() -> ${store.ident(K)}`);
  const db = fresh();
  const opened = store.openStore(db, cl, o);
  say(`store.openStore: typed ${opened.ontology.typed.join(', ')}; graph type read back:`);
  say(indent(currentGraphType(db, cl)));
  cl.exec(db, `UNWIND $rows AS r WITH r WHERE r.key IS NOT NULL
MERGE (m:_Mention {key: r.key}) SET m.label = r.label, m.name = r.name, m.text = r.text, m.doc = 'doc', m.band = 'keep'`, {
    rows: [
      { key: 'm1', label: K, name: 'ASHA_RAO', text: 'Asha Rao' },
      { key: 'm2', label: K, name: 'RAVI_DAS', text: 'Ravi Das' },
      { key: 'm3', label: 'COMPANY', name: 'ACME', text: 'Acme' },
    ],
  });
  cl.exec(db, `UNWIND $rows AS r WITH r WHERE r.key IS NOT NULL
MERGE (c:_Claim {key: r.key}) SET c.rel = r.rel, c.head = r.head, c.tail = r.tail, c.hk = r.hk, c.tk = r.tk, c.p = toFloat(r.p),
  c.sentence = 'doc#0', c.doc = 'doc', c.band = 'keep'`, {
    rows: [
      { key: 'c1', rel: `${K}_SE`, head: `${K}:ASHA_RAO`, tail: `${K}:RAVI_DAS`, hk: K, tk: K, p: 0.9 },
      { key: 'c2', rel: 'WORKS_FOR', head: `${K}:ASHA_RAO`, tail: 'COMPANY:ACME', hk: K, tk: 'COMPANY', p: 0.8 },
    ],
  });
  let pub;
  try {
    pub = store.publish(db, cl);
    say(`publish -> ${pub.entities} entities, ${pub.labelled} labelled, ${pub.relationships} relationships`);
  } catch (e) {
    pub = e;
    say(`publish -> ${describe(e)}`);
  }
  pin('D8 (a marked kind id publishes)', !(pub instanceof Error) && pub.relationships === 2, '2 relationships', pub instanceof Error ? describe(pub) : JSON.stringify(pub));
  show(db, 'read back by label and type', `MATCH (a:\`${K}\`)-[r]->(b:_Entity) RETURN a.name AS a, type(r) AS type, labels(b) AS b ORDER BY type`);
  let exported = '';
  try { exported = store.exportCypher(db, cl); } catch (e) { exported = describe(e); }
  const back = fresh();
  let replayed;
  try {
    cl.script(back, exported);
    replayed = cl.exec(back, `MATCH (a:\`${K}\`)-[r]->(b) RETURN type(r) AS type, count(*) AS n ORDER BY type`).rows;
  } catch (e) {
    replayed = e;
  }
  say(`exportCypher's graph.cypher, run in a fresh database -> ${replayed instanceof Error ? describe(replayed) : JSON.stringify(replayed)}`);
  pin('D8 (a marked id exports and replays)', !(replayed instanceof Error) && replayed.length === 2, '2 relationship types', replayed instanceof Error ? describe(replayed) : JSON.stringify(replayed));
  back.free();
  db.free();

  // The cap: 64 code points is this example's limit, not the engine's (it takes a 300-character label).
  const at = 'P'.repeat(MAX_ID_CHARS);
  const over = 'P'.repeat(MAX_ID_CHARS + 1);
  const capCase = (id) => v1doc('x', [[id], ['B']], [['R', id, 'B']]);
  const ok64 = ours(capCase(at));
  say(`a ${MAX_ID_CHARS}-character label: ${ok64.ok ? 'accepted' : `refused (${ok64.error})`}; store.js ident() ${(() => { try { store.ident(at); return 'takes it'; } catch (e) { return describe(e); } })()}`);
  const no65 = ours(capCase(over));
  say(`a ${MAX_ID_CHARS + 1}-character label: ${no65.ok ? 'accepted' : `refused (${no65.error})`}`);
  const link65 = ours(v1doc('x', [['A'], ['B']], [['R'.repeat(MAX_ID_CHARS + 1), 'A', 'B']]));
  say(`a ${MAX_ID_CHARS + 1}-character relationship type: ${link65.ok ? 'accepted' : `refused (${link65.error})`}`);
  let identOver;
  try { store.ident(over); identOver = 'takes it'; } catch (e) { identOver = describe(e); }
  say(`store.js ident() on ${MAX_ID_CHARS + 1} characters -> ${identOver}`);
  const raw = fresh();
  show(raw, 'the engine itself on a 300-character label', `CREATE (n:\`${'Q'.repeat(300)}\`) RETURN size(labels(n)[0]) AS chars`);
  raw.free();
  pin('D8 (the 64-character cap)', ok64.ok && !no65.ok && !link65.ok && identOver.startsWith('StoreError ident'),
    `${MAX_ID_CHARS} accepted, ${MAX_ID_CHARS + 1} refused by parseOntology and store.js`, `${ok64.ok} ${no65.ok} ${link65.ok} ${identOver}`);
}
section('keyword ids end to end (keywords work as labels and types: backticked in DDL, dynamic in writes)');
{
  const o = parseOntology(JSON.stringify(v1doc('keywords', [['MATCH'], ['BY'], ['ORDER']], [['RETURN', 'MATCH', 'BY'], ['WHERE', 'ORDER', 'MATCH']])));
  const db = fresh();
  const res = applyOntology(db, o, cl);
  say(`kinds ${o.types.map((t) => t.id).join(', ')}; links ${o.relations.map((r) => r.id).join(', ')}; typed ${res.typed.join(', ')}`);
  say('graph type read back:');
  say(indent(currentGraphType(db, cl)));
  const w = show(db, 'write (:MATCH)-[:RETURN]->(:BY) through dynamic labels and type',
    'CREATE (a:$($d) {name: $an}) CREATE (b:$($r) {name: $bn}) CREATE (a)-[x:$($t)]->(b) RETURN type(x) AS type',
    { d: 'MATCH', r: 'BY', t: 'RETURN', an: 'm', bn: 'b' });
  const bad = show(db, 'the reverse (:BY)-[:RETURN]->(:MATCH)',
    'MATCH (a:$($d)) MATCH (b:$($r)) CREATE (b)-[:$($t)]->(a) RETURN 1 AS ok', { d: 'MATCH', r: 'BY', t: 'RETURN' });
  pin('O4 (keyword ids as typed labels)', !(w instanceof Error) && isErr(bad, (e) => e.category === 'constraint'),
    'legal accepted, reverse refused', `${errText(w)} / ${errText(bad)}`);
  show(db, 'read back, backticked', 'MATCH (a:`MATCH`)-[:`RETURN`]->(b:`BY`) RETURN a.name AS a, b.name AS b');
  db.free();
}

// ---- 7. system_ontologies, the canary (O1-O3, D15) ------------------------------------------------
section('system_ontologies does not exist (R17)');
{
  const db = fresh();
  applyOntology(db, generic, cl);
  show(db, 'SHOW DATABASES', 'SHOW DATABASES YIELD name, access, type RETURN name, access, type ORDER BY name');
  say('A store has two databases, neo4j and system. Every statement that names system_ontologies is refused as a');
  say('missing graph, reads included, so the ontology lives in neo4j beside the data (D15):');
  const nf = (r) => isErr(r, (e) => e.category === 'semantic' && e.message.includes('DatabaseNotFound: Graph not found: system_ontologies'));
  const rs = [
    show(db, 'USE system_ontologies MATCH (n)', 'USE system_ontologies MATCH (n) RETURN count(n) AS c'),
    show(db, 'USE system_ontologies CREATE (:Kind)', 'USE system_ontologies CREATE (:Kind {id: $id})', { id: 'PERSON' }),
    show(db, 'USE system_ontologies ALTER CURRENT GRAPH TYPE SET', `USE system_ontologies ALTER CURRENT GRAPH TYPE SET ${graphTypeSpec(generic).spec}`),
    show(db, 'MATCH (n) ... UNION ALL USE system_ontologies MATCH (n) ... (a USE in one arm)',
      'MATCH (n) RETURN count(n) AS c UNION ALL USE system_ontologies MATCH (n) RETURN count(n) AS c'),
    show(db, 'MATCH (n) WHERE EXISTS { USE system_ontologies ... } (a USE in a subquery)',
      'MATCH (n) WHERE EXISTS { USE system_ontologies MATCH (m) } RETURN count(n) AS c'),
    show(db, 'USE system_ontologies CALL { MATCH (m) ... } RETURN k',
      'USE system_ontologies CALL { MATCH (m) RETURN count(m) AS k } RETURN k'),
  ];
  const here = one(db, 'MATCH (n) RETURN count(n) AS n');
  say(`(neo4j itself is unaffected: ${here} nodes, the ${generic.id} layer)`);
  pin('R17 (system_ontologies: reads, writes, a graph type and a USE in a part all refused alike)',
    rs.every(nf), 'six DatabaseNotFound refusals', rs.map(errText).join(' | '));
  const both = show(db, 'USE neo4j ... UNION ALL USE system_ontologies ...',
    'USE neo4j MATCH (n) RETURN count(n) AS c UNION ALL USE system_ontologies MATCH (n) RETURN count(n) AS c');
  pin('R17 (two graphs in one statement)', isErr(both, (x) => x.message.includes('Multiple graphs in the same query not allowed here')),
    'Multiple graphs in the same query not allowed here', errText(both));

  section('the D15 canary: db.ontology.* hidden behind the preview gate (R17)');
  say('db.ontology.* (document storage for an ontology) is a preview feature, enabled natively with');
  say('RELATE_PREVIEW=ontology. The WASM build reads no environment, so the gate cannot be opened here: SHOW');
  say('PROCEDURES hides the procedures (the canary stays empty) and every call is refused by the gate.');
  const canary = ontologyCanary(db, cl);
  say(`ontologyCanary -> ${JSON.stringify(canary)}`);
  if (canary.procedures.length) {
    pins.push(`PIN: D15 canary: db.ontology.* procedures usable (${canary.procedures.join(', ')}): the ontology could move into them (NOTES.md R17, D15)`);
  }
  const get = show(db, "CALL db.ontology.get('neo4j')", "CALL db.ontology.get('neo4j')");
  pin("R17 (db.ontology.get refused by the preview gate)", isErr(get, (x) => x.category === 'semantic' &&
    x.message.includes("preview feature 'ontology' is not enabled")), "the gate's refusal", errText(get));
  const set = show(db, "CALL db.ontology.set('neo4j', $doc)", "CALL db.ontology.set('neo4j', $doc)", { doc: '{}' });
  pin("R17 (db.ontology.set parses, and is gated too)",
    isErr(set, (x) => x.category === 'semantic' && x.message.includes("preview feature 'ontology' is not enabled")), "the gate's refusal", errText(set));
  db.free();
}

// ---- 8. store names (D14) ----------------------------------------------------------------------------------
section('store names (D14): ex01-kg-<slug>, at most 64 of [A-Za-z0-9_-]');
{
  /** What RelateDb.open says about a name in Node: past the name rule it needs a worker. */
  async function nameRule(name) {
    try {
      const h = await mod.RelateDb.open(`opfs://${name}`);
      h.free();
      return 'opened';
    } catch (e) {
      return String(e?.message ?? e).split('\n')[0];
    }
  }
  const WORKER = 'storage error: OPFS needs a dedicated worker';
  const ids = ['financial-services', generic.id, 'ärzte_netz', '東京の会社', 'x'.repeat(56), 'y'.repeat(57), 'a b:c/d'];
  for (const id of ids) {
    const name = storeName({ id });
    const rule = await nameRule(name);
    const ok = rule === WORKER && /^[A-Za-z0-9_-]{1,64}$/.test(name);
    say(`${JSON.stringify(id.length > 20 ? `${id.slice(0, 8)}...(${id.length})` : id)} -> ${name.length > 40 ? `${name.slice(0, 20)}...${name.slice(-12)}` : name} ` +
      `(${name.length}): ${ok ? 'the engine accepts the name' : rule}`);
    pin(`D14 store name for ${JSON.stringify(id)}`, ok, WORKER, rule);
  }
  const tooLong = await nameRule('z'.repeat(65));
  say(`a 65-character name -> ${tooLong}`);
  pin('D14 (the engine\'s OPFS name rule)', tooLong.startsWith('OPFS name must be 1-64 characters from [A-Za-z0-9_-]'), 'the 1-64 rule', tooLong);
}

// ---- 9. the example's limits on a document ----------------------------------------------------------------
section('the example\'s limits on a document (web/ontology.js, web/ogs.js): accepted or refused as designed');
{
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const kindsN = (n) => Array.from({ length: n }, (_, i) => [`T${String(i).padStart(2, '0')}`]);
  const AB = [['A'], ['B']];
  /** [name, document, accepted?, why] */
  const LIMITS = [
    ['one kind', v1doc('x', [['A']]), false, `${MIN_TYPES} to ${MAX_TYPES} kinds`],
    ['50 kinds', v1doc('x', kindsN(50)), true, `${MIN_TYPES} to ${MAX_TYPES} kinds`],
    ['51 kinds', v1doc('x', kindsN(51)), false, `${MIN_TYPES} to ${MAX_TYPES} kinds`],
    ['100 legal kind pairs', v1doc('x', kindsN(10), kindsN(10).flatMap(([a]) => kindsN(10).map(([b]) => ['R', a, b]))), true, 'at most 100 legal pairs'],
    ['110 legal kind pairs', v1doc('x', kindsN(11), kindsN(11).flatMap(([a]) => kindsN(10).map(([b]) => ['R', a, b]))), false, 'at most 100 legal pairs'],
    ['a 25-link kind pair', v1doc('x', AB, Array.from({ length: 25 }, (_, i) => [`R${letters[i]}`, 'A', 'B'])), true, 'at most 25 links per kind pair (26 choices with NONE, E1)'],
    ['a 26-link kind pair', v1doc('x', AB, Array.from({ length: 26 }, (_, i) => [`R${letters[i]}`, 'A', 'B'])), false, 'at most 25 links per kind pair, refused at load'],
    ['two links with one phrase (WORKS_FOR, WORKS__FOR)', v1doc('x', AB, [['WORKS_FOR', 'A', 'B'], ['WORKS__FOR', 'A', 'B']]), false, 'gliner.js: the model sees phrases, which must be unique'],
    ['two kinds that read alike (Person, PERSON)', v1doc('x', [['Person'], ['PERSON']]), false, 'the model would read both as "person"'],
    ['a Unicode label (ÄRZTE)', v1doc('x', [['ÄRZTE'], ['KLINIK']]), true, 'D8: ids may be any letters (the engine parses Unicode identifiers)'],
    ['a label with combining marks (व्यक्ति)', v1doc('x', [['व्यक्ति'], ['B']]), true, 'D8: letters keep their combining marks'],
    ['an emoji in a label', v1doc('x', [['ROCKET🚀'], ['B']]), false, 'D8: letters, marks, digits and _ only'],
    ['a colon in a label', v1doc('x', [['A:B'], ['C']]), false, 'D8: gliner-rs reads LABEL:description (G11)'],
    ['a label starting with a digit', v1doc('x', [['1ST'], ['B']]), true, 'D8: at least one letter or digit, any order'],
    ['a label of underscores', v1doc('x', [['___'], ['B']]), false, 'D8: a leading _ is the example\'s own'],
    ['a relationship type with a colon', v1doc('x', AB, [['R:1', 'A', 'B']]), false, 'D8: the same rule for relationship types'],
    ['keyword ids (MATCH, BY, RETURN)', v1doc('x', [['MATCH'], ['BY']], [['RETURN', 'MATCH', 'BY']]), true, 'Keywords work as labels and types: backticked in DDL, dynamic in writes'],
  ];
  let held = 0;
  for (const [name, doc, want, why] of LIMITS) {
    const a = ours(doc);
    if (a.ok === want) held++;
    else pins.push(`PIN: the example's limits (${name}): expected ${want ? 'accept' : 'refuse'}, got ${a.ok ? 'accept' : `refuse (${a.error})`}`);
    say(`${name}: ${a.ok ? 'accepted' : `refused (${a.error.length > 160 ? `${a.error.slice(0, 160)}…` : a.error})`}. ${why}`);
  }
  say(`=> ${held} of ${LIMITS.length} as designed`);
}

// ---- 10. parity with edgextract ------------------------------------------------------------------------------
section(`parity with edgextract ${ex.version} (its WASM, in Node): the ported splitter and names`);
say('edgextract\'s own engine runs each document with a zero model (every question answered no) and an ontology of its own YAML');
say('format, written here as the oracle\'s input; this example no longer reads that format (section 2).');
/** An ontology in edgextract's YAML for its engine: two kinds and a gazetteer of `names`. @param {string[]} names */
const oracleYaml = (names) => `id: oracle\ntypes: [THING, OTHER]\n${names.length ? `gazetteer:\n${names.map((n) => `  ${JSON.stringify(n)}: THING`).join('\n')}\n` : ''}`;

/** Splitter stress documents (inline, not data): every rule of markdown.rs, and Unicode. */
const STRESS = [
  ['frontmatter, CRLF, heading levels', '---\r\ntitle: t\r\n---\r\n# Top\r\n\r\nOne. Two!\r\n### Deep\r\nThree?\r\n## Mid #\r\nFour.\r\n'],
  ['empty frontmatter is not frontmatter', '---\n---\nText here.\n'],
  ['fences: language, unclosed', 'Before.\n\n```js\nNot. A sentence.\n```\nAfter the fence.\n\n```\nnever closed. Really.\n'],
  ['a fence opened mid-paragraph', 'Line one\n```\ncode\n```\nline two.\n'],
  ['lists, tables, quotes', '- one item. Two\n* star item\n+ plus item\n-no space continues\n1. first\n2) second\n10.5 is a number\n| a | b |\n|---|---|\n> quoted. Line\n  > indented quote\n'],
  ['abbreviations and closers', 'Dr. Smith met Mr. Jones at Acme Inc. on Monday. See e.g. this one. No? Yes! He said "Stop." (Then left.) End...\n'],
  ['a 600-character sentence', `${'alpha beta, gamma; delta '.repeat(24)}end.\n`],
  ['a long line with no break characters', `${'x'.repeat(1200)}\n`],
  ['multi-byte cut on a character boundary', `${'é'.repeat(700)}.\n`],
  ['CJK, emoji and offsets', '# 東京\n\n東京は日本の首都です。🚀 Rocket Labs moved to 東京. Zoë arrived. 😀 Done!\n'],
  ['CJK longer than 500 bytes', `${'漢字、'.repeat(70)}。\n`],
  ['emoji longer than 500 bytes', `${'🚀 '.repeat(130)}\n`],
  ['Unicode whitespace', '\ufeffBOM line. Next.\nend.\u00a0Not split. NEL\u0085 trims.\n\u3000\u3000\n\u2003Indented. Done.\n'],
  ['not headings', '#hashtag line.\n####### seven hashes.\n  # indented hash.\n#\tTabbed heading\nBody.\n'],
  ['lone CR line ends', 'First.\rSecond.\rThird\n'],
  ['only whitespace', '   \n\n\t\n'],
  ['no trailing newline', 'Last line has no newline. Really'],
];

{
  sub('the splitter (markdown.rs split_sentences): text, offsets (bytes -> code points), heading path, index');
  const docs = [];
  const samples = JSON.parse(readFileSync(join(DATA, 'samples', 'samples.json'), 'utf8'));
  for (const s of samples) docs.push([`samples/${s.file}`, readFileSync(join(DATA, 'samples', s.file), 'utf8')]);
  for (const f of FIXTURES) docs.push([`fixtures: ${f.name}`, f.text]);
  docs.push(['fixtures: the generic document\'s text', GENERIC_TEXT]);
  for (const [name, text] of STRESS) docs.push([`stress: ${name}`, text]);
  let same = 0;
  let total = 0;
  for (const [name, text] of docs) {
    const mine = splitSentences(text);
    const theirs = exRun(text, oracleYaml([])).sentences;
    const m = offsetMap(text);
    const diffs = [];
    if (mine.length !== theirs.length) diffs.push(`${mine.length} vs ${theirs.length} sentences`);
    for (let i = 0; i < Math.min(mine.length, theirs.length); i++) {
      const a = mine[i];
      const b = theirs[i];
      let bs;
      let be;
      try {
        bs = m.byteToCp(b.start);
        be = m.byteToCp(b.end);
      } catch {
        bs = be = -1;
      }
      if (a.text !== b.text || a.start !== bs || a.end !== be || a.idx !== b.index || canonJson(a.heading) !== canonJson(b.heading_path)) {
        diffs.push(`#${i}: ${JSON.stringify([a.text.slice(0, 40), a.start, a.end, a.heading])} vs ${JSON.stringify([b.text.slice(0, 40), bs, be, b.heading_path])}`);
      }
    }
    for (const a of mine) if ([...text].slice(a.start, a.end).join('') !== a.text) diffs.push(`#${a.idx}: text is not the code points [start, end)`);
    total += mine.length;
    const maxBytes = Math.max(0, ...mine.map((a) => new TextEncoder().encode(a.text).length));
    if (diffs.length === 0) same++;
    else pins.push(`PIN: splitter parity (${name}): ${diffs.slice(0, 3).join('; ')}`);
    say(`${name}: ${mine.length} sentences${maxBytes > 300 ? `, longest ${maxBytes} bytes` : ''}, ${diffs.length ? `MISMATCH ${diffs.slice(0, 3).join('; ')}` : 'same'}`);
  }
  say(`=> ${same} of ${docs.length} documents split identically (${total} sentences)`);
}

{
  sub('names (names.rs normalize_entity_name): every accepted gazetteer mention, through edgextract\'s entities');
  say('The names document lists awkward names; then each sample\'s text with every gold entity name of the 27 samples listed.');
  const NAMES = ['Zürich', 'the Apache AGE', 'Acme Inc.', "O'Brien's", 'Müller GmbH', 'A.B.C', 'The The', 'An Apple',
    '42', 'deadbeefdeadbeefdeadbeefdeadbeef', '123e4567-e89b-12d3-a456-426614174000', '東京', '٤٢ Street', 'ÆON Labs',
    'Kelvin \u216b', 'St. Mary\'s', 'Jane Doe', 'R2-D2', 'ſtraße'];
  const doc = `# Names\n\n${NAMES.map((n) => `We met ${n} today.`).join('\n')}\n`;
  const samples = JSON.parse(readFileSync(join(DATA, 'samples', 'samples.json'), 'utf8'));
  const goldNames = [...new Set(samples.flatMap((s) => JSON.parse(readFileSync(join(DATA, 'samples', s.gold), 'utf8')).entities.map((e) => e.name)))]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const runs = [['the names document', doc, oracleYaml(NAMES)],
    ...samples.map((s) => [`samples/${s.file}`, readFileSync(join(DATA, 'samples', s.file), 'utf8'), oracleYaml(goldNames)])];
  let checked = 0;
  let agree = 0;
  let sampleMentions = 0;
  const shown = [];
  for (const [name, text, yamlText] of runs) {
    const out = exRun(text, yamlText);
    const bySpan = new Map();
    for (const e of out.result.entities) for (const s of e.source_spans) bySpan.set(s, e.name);
    let n = 0;
    for (const m of out.result.mentions.filter((x) => x.band === 'ACCEPT')) {
      const want = normalizeEntityName(m.mention.text);
      const got = bySpan.get(m.mention.text) ?? '';
      checked++;
      n++;
      if (want === got) agree++;
      else pins.push(`PIN: names parity (${name}): ${JSON.stringify(m.mention.text)} -> ours ${JSON.stringify(want)}, edgextract ${JSON.stringify(got)}`);
      if (name === 'the names document') shown.push(`${JSON.stringify(m.mention.text)} -> ${want === '' ? "'' (rejected)" : want}${want === got ? '' : ` (edgextract: ${got})`}`);
    }
    if (name === 'the names document') say(`${name}: ${n} accepted mentions`);
    else sampleMentions += n;
  }
  for (const line of shown) say(`  ${line}`);
  say(`the ${samples.length} samples, with the ${goldNames.length} gold entity names listed: ${sampleMentions} accepted mentions`);
  say(`=> ${agree} of ${checked} names agree`);
}

{
  sub('the entity key (names.js entityName): a pinned difference from edgextract\'s names, not a parity failure');
  say('An entity\'s key takes edgextract\'s canonical name (above) after dropping leading titles (names.js HONORIFICS) and the');
  say('kind\'s label, or one word of it, at either end of the span when the rest is code-like or a proper name, so one thing');
  say('written with and without them is one entity (the example\'s README, "The graph model"). Pinned cases, with the kind\'s label:');
  const cases = [
    ['Dr. Imani Okafor', null, 'IMANI_OKAFOR'], ['Prof Ada Lund', null, 'ADA_LUND'], ['Dr.', null, 'DR'], ['Dr Pepper', 'organization', 'PEPPER'],
    ['account ACC-2207', 'account', 'ACC_2207'], ['Decision D-118', 'decision', 'D_118'], ['Work order WO-5531', 'work order', 'WO_5531'],
    ['Hydrology layer', 'layer', 'HYDROLOGY'], ['the Quillon agent', 'agent', 'QUILLON'], ['Guest 4471', 'guest', 'GUEST_4471'],
    ['billing agent', 'agent', 'BILLING_AGENT'], ['Taberna do Tavik restaurant', 'restaurant', 'TABERNA_DO_TAVIK'], ['Issue #4470', 'issue', 'ISSUE_4470'],
  ];
  for (const [raw, label, want] of cases) {
    const got = entityName(raw, label ? kindWords(label) : []);
    say(`  ${JSON.stringify(raw)}${label ? ` (${label})` : ''} -> ${got}${got === normalizeEntityName(raw) ? ' (as edgextract)' : ` (edgextract: ${normalizeEntityName(raw)})`}`);
    pin(`the entity key of ${JSON.stringify(raw)}`, got === want, want, got);
  }
  const samples = JSON.parse(readFileSync(join(DATA, 'samples', 'samples.json'), 'utf8'));
  let n = 0;
  const differ = [];
  for (const s of samples) {
    const o = parseOntology(readFileSync(join(DATA, 'ontologies/ogs/ccg', `${s.ontology}.ontology.yaml`), 'utf8'));
    const label = new Map(o.types.map((k) => [k.id, k.ask?.label ?? k.id]));
    for (const e of JSON.parse(readFileSync(join(DATA, 'samples', s.gold), 'utf8')).entities) {
      n++;
      const key = entityName(e.name, kindWords(label.get(e.type) ?? e.type));
      if (key !== normalizeEntityName(e.name)) differ.push(`${e.name} (${e.type}) ${key}`);
    }
  }
  say(`the samples' ${n} gold entities: ${differ.length} keyed apart from edgextract's name, e.g. ${differ.slice(0, 4).join('; ')}`);
}

if (pins.length) {
  for (const p of pins) console.error(p);
  process.exit(1);
}
