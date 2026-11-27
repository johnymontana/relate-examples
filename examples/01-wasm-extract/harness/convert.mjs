#!/usr/bin/env node
// @ts-check
// The bundled ontologies as Ontology Graph Spec 1.1 documents (web/convert.js, web/ogs.js):
// data/ontologies/ogs/ccg/<domain>.ontology.yaml from create-context-graph's 27 domain files (with
// _base.yaml). The originals stay where they are (data/ontologies/ccg/) for provenance; the page and
// the harnesses load the documents.
//   node harness/convert.mjs           write data/ontologies/ogs/ (only files that changed)
//   node harness/convert.mjs --check   write nothing; exit 1 naming every committed document that is
//                                      not byte for byte a fresh conversion of its original, and any file
//                                      under data/ontologies/ogs/ that has no original
// harness/ontology.mjs makes the same check in every run (ontology.txt), and also checks the
// conversion back (toCreateContextGraph, below): every key of the 27 files comes back from the
// document, so the conversion loses nothing create-context-graph's model reads.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXTENSIONS, custom, isMap, loadText, toolsOf } from '../web/ogs.js';
import { CCG_DEFAULT_COLOR, CCG_DEFAULT_ICON, CCG_DISPLAY, PROPERTY_TYPES } from '../web/convert.js';
import { fromDocument, parseOntology } from '../web/ontology.js';
import { fromStudioPackage } from '../web/studio.js';

export const EX = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ONTOLOGIES = join(EX, 'data', 'ontologies');

/**
 * Every bundled ontology, converted afresh: {group, source, file, text, o}, create-context-graph's
 * in file order. source and file are relative to data/ontologies/.
 */
export function conversions() {
  const out = [];
  if (existsSync(join(ONTOLOGIES, 'ogs', 'ccg'))) out.push(...ccgConversions());
  out.push(...studioConversions());
  return out;
}

/** create-context-graph's 27 domain files converted (with _base.yaml): the converter's test corpus (D20). */
export function ccgConversions() {
  const bases = { _base: readFileSync(join(ONTOLOGIES, 'ccg', '_base.yaml'), 'utf8') };
  const out = [];
  for (const f of readdirSync(join(ONTOLOGIES, 'ccg')).filter((x) => x.endsWith('.yaml') && !x.startsWith('_')).sort()) {
    const source = `ccg/${f}`;
    const o = parseOntology(readFileSync(join(ONTOLOGIES, source), 'utf8'), { bases });
    if (`${o.id}.yaml` !== f) throw new Error(`convert.mjs: ${source} holds the ontology ${o.id}; the file is named after its id`);
    out.push({ group: 'ccg', source, file: `ogs/ccg/${o.id}.ontology.yaml`, text: o.yaml, o });
  }
  return out;
}

/**
 * Neo4j's solution packages (data/ontologies/studio/<package>/, vendored by harness/vendor-studio.mjs),
 * each with its overlay (<package>.overlay.yaml), converted by web/studio.js (D21): {group: 'studio',
 * source, file, text, o, report, upstream, overlay}. A package without an overlay is not bundled.
 */
export function studioConversions() {
  const dir = join(ONTOLOGIES, 'studio');
  if (!existsSync(join(dir, 'manifest.json'))) return [];
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  /** @type {any[] & {errors?: Map<string, string>}} */
  const out = [];
  // A package whose overlay does not convert is not thrown: it is listed in out.errors, so one broken overlay
  // never stops the others (the command line and domain.mjs report it; harness/ontology.mjs fails on any).
  const errors = new Map();
  for (const pkg of [...new Set(Object.keys(m.files).map((f) => f.split('/')[0]))].sort()) {
    const ovFile = join(dir, `${pkg}.overlay.yaml`);
    if (!existsSync(ovFile)) continue;
    try {
      const overlay = loadText(readFileSync(ovFile, 'utf8'), `studio/${pkg}.overlay.yaml`);
      const ontology = readFileSync(join(dir, pkg, 'ONTOLOGY.json'), 'utf8');
      const queries = readFileSync(join(dir, pkg, 'QUERIES.md'), 'utf8');
      const files = Object.keys(m.files).filter((f) => f.startsWith(`${pkg}/`)).map((f) => f.slice(pkg.length + 1));
      const { doc, report } = fromStudioPackage({ ontology, queries, overlay, source: { repository: m.repository, commit: m.commit, package: pkg, files } });
      const o = fromDocument(doc);
      if (o.id !== pkg) throw new Error(`studio/${pkg} holds the ontology ${o.id}; the package is named after its id`);
      out.push({ group: 'studio', source: `studio/${pkg}/ONTOLOGY.json`, file: `ogs/studio/${pkg}.ontology.yaml`, text: o.yaml, o, report, upstream: JSON.parse(ontology), overlay });
    } catch (e) {
      errors.set(pkg, `data/ontologies/studio/${pkg}.overlay.yaml: ${String(/** @type {any} */ (e)?.message ?? e)}`);
    }
  }
  out.errors = errors;
  return out;
}

/** The committed documents that are not a fresh conversion: [{file, why}]. */
export function stale() {
  const want = conversions();
  const bad = [];
  for (const c of want) {
    const path = join(ONTOLOGIES, c.file);
    if (!existsSync(path)) bad.push({ file: c.file, why: 'missing' });
    else if (readFileSync(path, 'utf8') !== c.text) bad.push({ file: c.file, why: `differs from a fresh conversion of ${c.source}` });
  }
  // Every directory under ogs/ (a group left behind, such as an earlier build's ogs/edgextract/, included).
  for (const group of readdirSync(join(ONTOLOGIES, 'ogs'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    for (const f of readdirSync(join(ONTOLOGIES, 'ogs', group))) {
      if (!want.some((c) => c.file === `ogs/${group}/${f}`)) bad.push({ file: `ogs/${group}/${f}`, why: 'has no original' });
    }
  }
  return bad;
}

// ---- the conversion back (the lossless check) ------------------------------------------------------

const TYPE_BACK = Object.fromEntries(['string', 'integer', 'float', 'boolean', 'date', 'datetime', 'time', 'localtime',
  'localdatetime', 'duration', 'point', 'list'].map((t) => [PROPERTY_TYPES[t], t]));

/** A PropertyDef with create-context-graph's defaults filled in (ontology.py PropertyDef). */
function fullProperty(p) {
  return {
    name: p.name, type: p.type ?? 'string', required: p.required ?? false, unique: p.unique ?? false,
    enum: p.enum ?? null, default: p.default ?? null, description: p.description ?? '',
  };
}

/**
 * create-context-graph's domain file flattened as ontology.py `_merge_base` flattens it, with its
 * model's defaults filled in (written here independently of web/convert.js).
 * @param {string} text @param {string} baseText
 */
export function flattenCreateContextGraph(text, baseText) {
  const d = loadText(text);
  const b = loadText(baseText);
  const labels = new Set((d.entity_types ?? []).map((e) => e.label));
  const types = new Set((d.relationships ?? []).map((r) => r.type));
  const entity = (e) => ({
    label: e.label, pole_type: e.pole_type, subtype: e.subtype ?? null, color: e.color ?? CCG_DEFAULT_COLOR, icon: e.icon ?? CCG_DEFAULT_ICON,
    properties: (e.properties ?? []).map(fullProperty),
  });
  const entityTypes = [
    ...Object.entries(b.base_entity_types ?? {}).filter(([l]) => !labels.has(l)).map(([label, x]) => entity({
      label, pole_type: x.pole_type ?? 'OBJECT', color: x.color, icon: x.icon, properties: x.base_properties,
    })),
    ...(d.entity_types ?? []).map(entity),
  ];
  const seen = new Set();
  const relationships = [
    ...Object.entries(b.base_relationships ?? {}).filter(([t]) => !types.has(t)).map(([type, x]) => ({ type, source: x.source ?? '*', target: x.target ?? '*', properties: x.properties ?? [] })),
    ...(d.relationships ?? []).map((r) => ({ type: r.type, source: r.source, target: r.target, properties: r.properties ?? [] })),
  ].filter((r) => {
    const k = `${r.type}|${r.source}|${r.target}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map((r) => ({ ...r, properties: r.properties.map(fullProperty) }));
  return {
    domain: d.domain, inherits: d.inherits ?? d.domain?.inherits ?? null, entity_types: entityTypes, relationships,
    agent_tools: (d.agent_tools ?? []).map((t) => ({ name: t.name, description: t.description, cypher: t.cypher ?? '', parameters: (t.parameters ?? []).map(fullProperty) })),
    document_templates: d.document_templates ?? [], decision_traces: d.decision_traces ?? [], demo_scenarios: d.demo_scenarios ?? [],
    system_prompt: d.system_prompt ?? '', visualization: d.visualization ?? null,
  };
}

/**
 * A document converted from create-context-graph's format, read back into the shape
 * flattenCreateContextGraph gives: every value the conversion carried, from where it put it.
 * @param {any} doc
 */
export function toCreateContextGraph(doc) {
  const propBack = (name, p) => fullProperty({
    name,
    type: custom(p.extensions, 'createContextGraph:type') ?? TYPE_BACK[p.type] ?? p.type,
    required: p.must_exist, unique: p.unique, enum: p.one_of, default: custom(p.extensions, 'createContextGraph:default'), description: p.description,
  });
  const props = (m) => Object.entries(m ?? {}).map(([name, p]) => propBack(name, p));
  const domainExt = { ...custom(doc.extensions, EXTENSIONS.domain) };
  const inherits = domainExt.inherits ?? null;
  delete domainExt.inherits;
  const tools = [];
  for (const el of [...Object.values(doc.nodes ?? {}), ...Object.values(doc.relationships ?? {})]) {
    for (const t of toolsOf(el)) if (t.name !== 'defaultView') tools.push(t);
  }
  return {
    domain: { id: doc.id, name: doc.name, ...(doc.description !== undefined ? { description: doc.description } : {}), ...domainExt },
    inherits,
    entity_types: Object.values(doc.nodes).map((n) => {
      const pole = custom(n.extensions, EXTENSIONS.pole);
      const display = n.extensions?.display ?? {};
      const looks = custom(n.extensions, CCG_DISPLAY) ?? {};
      return { label: n.label, pole_type: pole.pole_type, subtype: pole.subtype ?? null, color: display.colour, icon: looks.icon, properties: props(n.properties) };
    }),
    relationships: Object.values(doc.relationships ?? {}).map((r) => ({ type: r.type, source: r.from.node, target: r.to.node, properties: props(r.properties) })),
    agent_tools: tools.map((t) => ({
      name: t.name, description: t.description, cypher: t.cypher ?? '',
      parameters: (t.parameters ?? []).map((p) => fullProperty({ name: p.name, type: TYPE_BACK[p.type] ?? p.type, required: p.required, enum: p.one_of, default: p.default, description: p.description })),
    })),
    document_templates: custom(doc.extensions, 'createContextGraph:documentTemplates') ?? [],
    decision_traces: custom(doc.extensions, 'createContextGraph:decisionTraces') ?? [],
    demo_scenarios: custom(doc.extensions, 'createContextGraph:demoScenarios') ?? [],
    system_prompt: custom(doc.extensions, 'createContextGraph:systemPrompt') ?? '',
    visualization: custom(doc.extensions, 'createContextGraph:visualization') ?? null,
  };
}

/** JSON with object keys sorted, for comparing values whose key order does not matter. */
export function canonJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonJson).join(',')}]`;
  if (isMap(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/**
 * The lossless check for one create-context-graph file: [] when every value comes back, else the
 * parts that differ. agent_tools are compared as a set (the document lists them by element).
 * @param {string} text @param {string} baseText @param {any} doc
 */
export function losses(text, baseText, doc) {
  const a = flattenCreateContextGraph(text, baseText);
  const b = toCreateContextGraph(doc);
  const bad = [];
  for (const k of Object.keys(a)) {
    const x = k === 'agent_tools' ? a[k].map(canonJson).sort().join('\n') : canonJson(a[k]);
    const y = k === 'agent_tools' ? b[k].map(canonJson).sort().join('\n') : canonJson(b[k]);
    if (x !== y) bad.push(k);
  }
  return bad;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  if (check) {
    const bad = stale();
    for (const b of bad) console.error(`convert.mjs: data/ontologies/${b.file} ${b.why}`);
    if (bad.length) {
      console.error('convert.mjs: run `node harness/convert.mjs` to write the converted documents');
      process.exit(1);
    }
    console.log(`convert.mjs: the ${conversions().length} documents in data/ontologies/ogs/ are fresh conversions`);
  } else {
    // --only <id>: write that package's or domain's document alone (parallel writers each touch their own)
    const oi = process.argv.indexOf('--only');
    const only = oi > 0 ? process.argv[oi + 1] : null;
    const mine = (/** @type {{file: string}} */ c) => !only || c.file.endsWith(`/${only}.ontology.yaml`);
    let wrote = 0;
    for (const [pkg, why] of studioConversions().errors ?? []) if (!only || pkg === only) console.error(`convert.mjs: ${pkg} not converted: ${why}`);
    for (const c of conversions().filter(mine)) {
      const path = join(ONTOLOGIES, c.file);
      if (existsSync(path) && readFileSync(path, 'utf8') === c.text) continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, c.text);
      wrote++;
      console.log(`wrote data/ontologies/${c.file}`);
    }
    console.log(`convert.mjs: ${wrote} written, ${conversions().filter(mine).length - wrote} unchanged`);
  }
}
