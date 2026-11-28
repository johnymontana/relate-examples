#!/usr/bin/env node
// @ts-check
/**
 * harness/run.mjs: example 02's Node sections. From the example's directory:
 *
 *   node harness/run.mjs [--out out] [--only ontology,briefing,ddl,queries,validate,probes]
 *
 * Each section writes one deterministic report into --out (no timestamps, paths or timings), which
 * run.sh diffs against expected/:
 *
 *   ontology.txt   the Ontology Graph Spec SDK on data/corporate-events.ontology.yaml: decode, the
 *                  issue count per validation set, the core issues, the legal relationships
 *   briefing.txt   both briefings (web/briefing.js), each checked against data/reference/
 *   ddl.cypher     the graph type and the DDL (web/ddl.js); the DDL is checked against data/reference/
 *   queries.txt    Relate 1.3.0 WASM: schema + demo graph loaded (web/load.js), then every canned query
 *                  (both variants, with the A/B notes), the fallback and the ontology's cookbook,
 *                  validated (web/validate.js) and run; the graph type read back; the suggested
 *                  questions routed to their canned entries
 *   validate.txt   the validator on data/reference/validate.json's cases, checked against the Python
 *                  issues; the A/B notes on data/reference/compare.json's cases; engine notes from EXPLAIN
 *   probes.txt     P1…: the Relate 1.3.0 behaviours the example depends on, each a minimal repro
 *                  (NOTES.md has one row per probe)
 *
 * A port that stops reproducing its data/reference/ file, or a probe that stops reproducing, prints
 * `PIN: <what> changed` on stderr and the run exits 1 (after writing every report, so the diff shows
 * what moved).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import * as sdk from '@neo4j/ontology-graph-spec';
import { createOgs } from '../../../lib/ogs.mjs';
import * as rw from '../../../lib/relate_wasm.mjs';
import { buildBriefing } from '../web/briefing.js';
import { cannedCypher } from '../web/canned.js';
import { compare } from '../web/compare.js';
import { allStatements, graphTypeElements, graphTypeStatement, readbackElements, schemaStatements } from '../web/ddl.js';
import { graphPayload, loadGraph } from '../web/load.js';
import { legalRelationships, loadOntology, queryExamples, SETS } from '../web/ontology.js';
import { engineNotes, validateCypher, wroteSomething } from '../web/validate.js';
import { runVariant } from '../web/run.js';
import { parseReply } from '../web/llm.js';

const EX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELATE = '1.3.0';
const SECTIONS = ['ontology', 'briefing', 'ddl', 'queries', 'validate', 'probes'];

let failed = false;
/** @param {string} what */
const pin = (what) => {
  failed = true;
  process.stderr.write(`PIN: ${what} changed\n`);
};
const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(EX, rel), 'utf8');
const readJson = (/** @type {string} */ rel) => JSON.parse(read(rel));

/** Canonical JSON: object keys sorted (rows arrive in RETURN order, 01's R4; sorting makes the output independent of that order). */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const sortedRows = (/** @type {any[]} */ rows) => rows.map(canon).sort();
/** Every query the queries section ran, for the native section (out/queries.json, not diffed). @type {Array<{label: string, cypher: string, rows: string[]}>} */
const QUERY_LOG = [];
/** @param {string} label @param {{cypher: string, issues: string[], error: string|null, rows: any[]}} r */
function logQuery(label, r) {
  if (!r.issues.length && !r.error) QUERY_LOG.push({ label, cypher: r.cypher, rows: sortedRows(r.rows) });
  return r;
}
const indent = (/** @type {string} */ s, pad = '    ') => s.split('\n').map((l) => pad + l).join('\n');
/** An engine message's first line, with the engine's generated constraint names masked. */
const firstLine = (/** @type {unknown} */ e) => String(/** @type {any} */ (e)?.message ?? e).split('\n')[0]
  .replace(/`constraint_[0-9a-f]+`/g, '`constraint_<generated>`');

function args(argv) {
  const opts = { out: path.join(EX, 'out'), only: SECTIONS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') opts.out = path.resolve(argv[++i]);
    else if (argv[i] === '--only') opts.only = argv[++i].split(',');
    else throw new Error(`run.mjs: unknown argument ${argv[i]}\nusage: node harness/run.mjs [--out DIR] [--only ${SECTIONS.join(',')}]`);
  }
  for (const s of opts.only) if (!SECTIONS.includes(s)) throw new Error(`run.mjs: unknown section ${s}`);
  return opts;
}

const SDK_VERSION = JSON.parse(fs.readFileSync(path.join(EX, 'node_modules/@neo4j/ontology-graph-spec/package.json'), 'utf8')).version;
const ogs = createOgs({ yaml, sdk, sdkVersion: SDK_VERSION });
const ONTOLOGY_TEXT = read('data/corporate-events.ontology.yaml');
const ONT = loadOntology(ONTOLOGY_TEXT, { ogs });
const DOC = ONT.doc;

// ---- ontology ------------------------------------------------------------------------------------

function ontologySection() {
  const L = ['# The ontology through the Ontology Graph Spec SDK', ''];
  L.push(`document: data/corporate-events.ontology.yaml (id ${DOC.id}, version ${JSON.stringify(DOC.version)})`);
  L.push(`schema: ${DOC.schema}`);
  L.push(`SDK: @neo4j/ontology-graph-spec ${ogs.sdkVersion}`);
  L.push(`decoded: ${ONT.counts.decode === 0 ? 'yes' : 'NO'}; usable (no decode or core issue): ${ONT.ok ? 'yes' : 'NO'}`);
  if (!ONT.ok) pin('the ontology no longer passes the SDK core validation (ontology)');
  L.push('', '## Issues per validation set');
  for (const s of SETS) L.push(`${s.padEnd(18)} ${ONT.counts[s]}`);
  /** @type {Record<string, Record<string, number>>} */
  const byCode = {};
  for (const i of ONT.issues) ((byCode[i.set] ??= {})[i.code] = (byCode[i.set]?.[i.code] ?? 0) + 1);
  L.push('', '## Issue codes per set');
  for (const s of SETS) if (byCode[s]) L.push(`${s}: ${Object.entries(byCode[s]).sort().map(([c, n]) => `${c} ${n}`).join(', ')}`);
  const core = ONT.issues.filter((i) => i.set === 'core' || i.set === 'decode');
  L.push('', '## Core and decode issues', ...(core.length ? core.map((i) => `${i.set} ${i.code} ${i.path}: ${i.message}`) : ['none']));
  const consistent = ONT.issues.filter((i) => i.set === 'consistentSchema' && i.code !== 'missing_property_name');
  L.push('', '## consistentSchema issues other than missing_property_name', ...(consistent.length ? consistent.map((i) => `${i.code} ${i.path}: ${i.message}`) : ['none']));
  L.push('', `## Nodes (${Object.keys(DOC.nodes).length}) and relationships (${Object.keys(DOC.relationships).length})`);
  for (const sig of Object.values(legalRelationships(DOC))) L.push(`(:${sig.from})-[:${sig.type}]->(:${sig.to})`);
  L.push('', `query cookbook: ${queryExamples(DOC).length} examples (extensions.custom.query_examples)`);
  return L.join('\n') + '\n';
}

// ---- briefing ------------------------------------------------------------------------------------

function briefingSection() {
  const L = ['# The schema briefings (web/briefing.js)', ''];
  for (const [name, bare] of [['grounded', false], ['bare', true]]) {
    const text = buildBriefing(DOC, { bare: /** @type {boolean} */ (bare) });
    const ref = read(`data/reference/briefing-${name}.txt`);
    const same = text + '\n' === ref;
    if (!same) pin(`the ${name} briefing no longer equals data/reference/briefing-${name}.txt (briefing)`);
    L.push(`## ${name}: ${text.split('\n').length} lines; equals the Python's (data/reference/briefing-${name}.txt): ${same ? 'yes' : 'NO'}`, '', text, '');
  }
  return L.join('\n');
}

// ---- ddl -----------------------------------------------------------------------------------------

function ddlSection() {
  const ddl = allStatements(DOC);
  const ref = read('data/reference/ddl.cypher');
  const same = ddl.map((s) => s + '\n').join('') === ref;
  if (!same) pin('the DDL no longer equals data/reference/ddl.cypher (ddl)');
  return [
    '// The ontology as schema statements (web/ddl.js schemaStatements), in the order the store applies them.',
    '// 1. The graph type: node labels with typed properties (NOT NULL from key and must_exist),',
    '//    relationship types with their endpoints and typed properties.',
    graphTypeStatement(DOC) + ';',
    `// 2. The source app's DDL (cypher.py); equals data/reference/ddl.cypher: ${same ? 'yes' : 'NO'}`,
    ...ddl.map((s) => s + ';'),
    '',
  ].join('\n');
}

// ---- queries -------------------------------------------------------------------------------------

/** A loaded store: Relate 1.3.0 WASM, the schema and the demo graph. */
async function loadedStore() {
  const R = await rw.loadNode(RELATE);
  const db = new R.RelateDb();
  const graph = readJson('data/demo-graph.json');
  const counts = loadGraph(db, rw.exec, graph, DOC);
  return { R, db, graph, counts };
}

/**
 * One query through web/run.js runVariant, the function the engine worker runs: the ontology check,
 * EXPLAIN, the run, and the rebuild should it write. @param {any} db @param {string} cypher
 */
function runQuery(db, cypher) {
  return runVariant(db, rw, DOC, cypher, {
    reload: () => { throw new Error(`the query wrote to the store: ${cypher}`); },
    rowCap: 10000,
  });
}

/** @param {ReturnType<typeof runQuery>} r */
function showRun(r) {
  const L = [indent(r.cypher)];
  if (r.issues.length) L.push(`  blocked by validation: ${r.issues.join('; ')}`);
  for (const n of r.notes) L.push(`  ${n}`);
  if (r.error) L.push(`  engine error: ${r.error} (${r.execution})`);
  if (r.wrote) L.push('  WROTE TO THE STORE');
  if (!r.issues.length && !r.error) {
    L.push(`  ${r.rows.length} row(s)${r.rows.length ? ' (sorted by canonical JSON):' : ''}`);
    for (const row of sortedRows(r.rows)) L.push(`    ${row}`);
  }
  return L.join('\n');
}

async function queriesSection() {
  const { db, graph, counts } = await loadedStore();
  const canned = readJson('data/canned.json');
  const L = ['# Relate 1.3.0 WASM: the demo graph and every reference query', ''];
  L.push(`engine: ${rw.version(db)}`);
  L.push(`loaded: ${counts.statements} schema statements, ${counts.nodes} nodes, ${counts.relationships} relationships (data/demo-graph.json: ${graph.nodes.length}, ${graph.edges.length})`);
  const n = rw.exec(db, 'MATCH (n) RETURN count(n) AS n').rows[0].n;
  const m = rw.exec(db, 'MATCH ()-[r]->() RETURN count(r) AS n').rows[0].n;
  L.push(`store: ${n} nodes, ${m} relationships`);
  if (n !== graph.nodes.length || m !== graph.edges.length) pin('the loaded graph no longer matches data/demo-graph.json (queries)');
  const spec = rw.exec(db, 'SHOW CURRENT GRAPH TYPE YIELD specification RETURN specification AS s').rows[0].s;
  const back = readbackElements(spec);
  const specSame = back.elements.join('\n') === graphTypeElements(DOC).join('\n');
  if (!specSame) pin('SHOW CURRENT GRAPH TYPE no longer reads back the derived graph type (queries)');
  L.push(`graph type elements read back equal the derived ones: ${specSame ? 'yes' : 'NO'} (${back.elements.length} elements)`);
  if (!specSame) L.push(indent(spec));
  L.push(`CONSTRAINT items in the readback (the DDL's key and unique constraints): ${back.constraints.length}`);
  for (const c of back.constraints) L.push(`  ${c}`);
  const cons = rw.exec(db, 'SHOW CONSTRAINTS YIELD name, type RETURN type, count(*) AS n ORDER BY type').rows;
  L.push(`constraints: ${cons.map((r) => `${r.type} ${r.n}`).join(', ')}`);
  const idx = rw.exec(db, 'SHOW INDEXES YIELD name, type RETURN type, count(*) AS n ORDER BY type').rows;
  L.push(`indexes: ${idx.map((r) => `${r.type} ${r.n}`).join(', ')}`);
  const types = rw.exec(db, 'MATCH ()-[r]->() RETURN DISTINCT valueType(r.supported) AS t ORDER BY t').rows.map((r) => r.t);
  L.push(`valueType(r.supported): ${types.join(', ')}`);
  const payload = graphPayload(db, rw.exec, DOC);
  L.push(`graph payload: ${payload.nodes.length} nodes, ${payload.edges.length} edges; colours by group: ${
    [...new Map(payload.nodes.map((x) => [x.group, x.color])).entries()].sort().map(([g, c]) => `${g} ${c}`).join(', ')}`);

  L.push('', '## Canned answers (data/canned.json): grounded, then bare, then the A/B notes');
  for (const e of canned.canned) {
    const w = logQuery(`canned ${e.keywords[0]}: grounded`, runQuery(db, e.cypher));
    const b = logQuery(`canned ${e.keywords[0]}: bare`, runQuery(db, e.bare));
    L.push('', `### keywords: ${e.keywords.join(', ')}`, 'grounded:', showRun(w), 'bare:', showRun(b), 'notes:', ...compare(w, b).map((x) => `  - ${x}`));
  }
  {
    const w = logQuery('fallback: grounded', runQuery(db, canned.fallback.cypher));
    const b = logQuery('fallback: bare', runQuery(db, canned.fallback.bare));
    L.push('', '### fallback', 'grounded:', showRun(w), 'bare:', showRun(b), 'notes:', ...compare(w, b).map((x) => `  - ${x}`));
  }
  L.push('', '## The ontology\'s query cookbook (extensions.custom.query_examples)');
  for (const ex of queryExamples(DOC)) L.push('', `Q: ${ex.question}`, showRun(logQuery(`cookbook: ${ex.question}`, runQuery(db, ex.cypher))));
  L.push('', '## Suggested questions and the canned entry each routes to (offline mode)');
  for (const q of canned.suggested) {
    const c = cannedCypher(q, canned);
    const i = canned.canned.findIndex((e) => e.cypher === c.with);
    L.push(`${q}  ->  ${i < 0 ? 'fallback' : `entry ${i + 1} (${canned.canned[i].keywords[0]})`}`);
  }
  const wrote = rw.exec(db, 'MATCH (n) RETURN count(n) AS n').rows[0].n;
  L.push('', `store after every query: ${wrote} nodes (unchanged: ${wrote === n ? 'yes' : 'NO'})`);
  db.free();
  return L.join('\n') + '\n';
}

// ---- validate ------------------------------------------------------------------------------------

async function validateSection() {
  const L = ['# The validator (web/validate.js) against the Python\'s', ''];
  let all = true;
  for (const c of readJson('data/reference/validate.json')) {
    const got = validateCypher(c.cypher, DOC);
    const same = canon(got) === canon(c.issues);
    all &&= same;
    L.push(`${same ? 'same' : 'DIFFERENT'}: ${c.cypher}`);
    for (const i of got) L.push(`  - ${i}`);
    if (!same) for (const i of c.issues) L.push(`  python: ${i}`);
  }
  if (!all) pin('the validator no longer reproduces data/reference/validate.json (validate)');
  L.push('', '# The A/B notes (web/compare.js) against the Python\'s', '');
  let allCmp = true;
  for (const [i, c] of readJson('data/reference/compare.json').entries()) {
    const got = compare(c.with, c.without);
    const same = canon(got) === canon(c.notes);
    allCmp &&= same;
    L.push(`case ${i + 1}: ${same ? 'same' : 'DIFFERENT'}`, ...got.map((x) => `  - ${x}`));
  }
  if (!allCmp) pin('compare() no longer reproduces data/reference/compare.json (validate)');
  L.push('', '# The model\'s reply to a query (web/llm.js parseReply)', '');
  for (const [reply, want] of [
    ['{"cypher": "MATCH (n:Company) RETURN n.name"}', 'MATCH (n:Company) RETURN n.name'],
    ['<think>\n\n</think>\n\n{"cypher": "MATCH (n:Company) RETURN n.name"}', 'MATCH (n:Company) RETURN n.name'],
    ['<think>\nsome thought\n</think>\nHere it is: {"cypher": "RETURN 1;"} done', 'RETURN 1'],
    ['```cypher\nMATCH (p:Person) RETURN p.name;\n```', 'MATCH (p:Person) RETURN p.name'],
    ['MATCH (p:Person) RETURN p.name', 'MATCH (p:Person) RETURN p.name'],
  ]) {
    const got = parseReply(reply);
    if (got !== want) pin(`parseReply(${JSON.stringify(reply)}) (validate)`);
    L.push(`${JSON.stringify(reply)}  ->  ${JSON.stringify(got)}`);
  }
  const { db } = await loadedStore();
  L.push('', '# Engine notes: EXPLAIN on the loaded store (advisory, never blocking)', '');
  for (const q of [
    'MATCH (a:Corporation)-[:BUYS]->(b) RETURN b.nme',
    "MATCH (c:Company) WHERE c.nmae = 'Halcyon' RETURN c.name",
    "MATCH (c:Company) WHERE c.country = 'US' RETURN c.name",
    "MATCH (c:Company)-[r:ACQUIRES]->(t:Company) WHERE r.assertion = 'asserted' RETURN t.name",
  ]) {
    const notes = engineNotes(JSON.parse(db.execute(`EXPLAIN ${q}`, null)));
    L.push(q, ...(notes.length ? notes.map((x) => `  ${x}`) : ['  (none)']));
  }
  db.free();
  return L.join('\n') + '\n';
}

// ---- probes --------------------------------------------------------------------------------------

async function probesSection() {
  const R = await rw.loadNode(RELATE);
  const L = ['# Relate 1.3.0 behaviours example 02 depends on (NOTES.md has one row per probe)', ''];
  /** @param {any} db @param {string} q */
  const env = (db, q) => JSON.parse(db.execute(q, null));
  /** @param {any} db @param {string} q */
  const outcome = (db, q) => {
    const e = env(db, q);
    return e.error == null ? 'ok' : `error: ${firstLine(e.error)}`;
  };
  const fresh = () => new R.RelateDb();
  /** @param {string} id @param {string} title @param {string[]} lines @param {boolean} holds */
  const probe = (id, title, lines, holds) => {
    if (!holds) pin(`probe ${id} (${title})`);
    L.push(`## ${id} ${title}: ${holds ? 'holds' : 'DOES NOT HOLD'}`, ...lines.map((x) => `  ${x}`), '');
  };

  {
    const db = fresh();
    const a = outcome(db, 'ALTER CURRENT GRAPH TYPE SET { (:A => {name :: STRING}) }');
    const b = outcome(db, 'CREATE CONSTRAINT a_name_exists IF NOT EXISTS FOR (n:A) REQUIRE n.name IS NOT NULL');
    const db2 = fresh();
    const c = outcome(db2, 'ALTER CURRENT GRAPH TYPE SET { (:A => {name :: STRING NOT NULL}) }');
    const d = outcome(db2, 'CREATE CONSTRAINT a_name_exists IF NOT EXISTS FOR (n:A) REQUIRE n.name IS NOT NULL');
    probe('P1', 'an existence constraint on a graph-typed label must come from the graph type',
      [`graph type {name :: STRING}, then CREATE CONSTRAINT … IS NOT NULL: ${b}`,
        `graph type {name :: STRING NOT NULL}, then the same CREATE CONSTRAINT IF NOT EXISTS: ${d}`],
      a === 'ok' && b.includes('IncompatibleGraphTypeDependence') && c === 'ok' && d === 'ok');
    db.free(); db2.free();
  }
  {
    const db = fresh();
    outcome(db, 'CREATE CONSTRAINT b_id IF NOT EXISTS FOR (n:B) REQUIRE n.id IS UNIQUE');
    const before = env(db, 'SHOW CONSTRAINTS YIELD name RETURN count(*) AS n').rows[0].n;
    outcome(db, 'ALTER CURRENT GRAPH TYPE SET { (:A => {name :: STRING}) }');
    const after = env(db, "SHOW CONSTRAINTS YIELD name WHERE name = 'b_id' RETURN count(*) AS n").rows[0].n;
    probe('P2', 'ALTER CURRENT GRAPH TYPE SET drops the constraints the store had',
      [`a UNIQUE constraint before: ${before}; b_id after the ALTER: ${after}`], before === 1 && after === 0);
    db.free();
  }
  {
    const db = fresh();
    outcome(db, 'ALTER CURRENT GRAPH TYPE SET { (:A => {name :: STRING NOT NULL, n :: FLOAT}), (:B => {name :: STRING NOT NULL}), (:A =>)-[:T => {w :: FLOAT}]->(:B =>) }');
    outcome(db, "CREATE (:A {name: 'a'}), (:B {name: 'b'})");
    const typed = outcome(db, "MATCH (a:A) SET a.name = 5");
    const missing = outcome(db, 'CREATE (:A {n: 1.5})');
    const endpoint = outcome(db, 'MATCH (a:A), (b:B) CREATE (b)-[:T]->(a)');
    const good = outcome(db, 'MATCH (a:A), (b:B) CREATE (a)-[:T {w: 0.5}]->(b)');
    const relTyped = outcome(db, "MATCH (a:A), (b:B) CREATE (a)-[:T {w: 'x'}]->(b)");
    const extra = outcome(db, "MATCH (a:A) SET a.undeclared = 'x'");
    const dyn = outcome(db, "MERGE (n:$($l) {name: $l})".replaceAll('$l', "'A'").replace("$($", '$('));
    probe('P3', 'the graph type refuses what the ontology forbids, and allows undeclared properties',
      [`a STRING property set to 5: ${typed}`, `a NOT NULL property missing: ${missing}`,
        `a relationship from the wrong label: ${endpoint}`, `a well-typed relationship: ${good}`,
        `a FLOAT relationship property set to a string: ${relTyped}`, `a property the graph type does not declare: ${extra}`,
        `a dynamic label MERGE on a typed label: ${dyn}`],
      typed.includes('ConstraintValidationFailed') && missing.startsWith('error') && endpoint.includes('ConstraintValidationFailed')
        && good === 'ok' && relTyped.startsWith('error') && extra === 'ok' && dyn === 'ok');
    db.free();
  }
  {
    const accepted = [];
    const refused = [];
    for (const t of ['STRING', 'INTEGER', 'FLOAT', 'BOOLEAN', 'DATE', 'DURATION', 'POINT', 'LOCAL DATETIME', 'LOCAL TIME',
      'ZONED DATETIME', 'ZONED TIME', 'UUID', 'LIST<STRING NOT NULL>', 'VECTOR<FLOAT32>(3)', 'VECTOR<INTEGER8>(3)',
      'ANY', 'LIST<ANY>', 'LIST<STRING>', 'FLOAT32', 'INTEGER8', 'INTEGER16', 'INTEGER32']) {
      const db = fresh();
      (outcome(db, `ALTER CURRENT GRAPH TYPE SET { (:A => {p :: ${t}}) }`) === 'ok' ? accepted : refused).push(t);
      db.free();
    }
    probe('P4', 'the property types a graph type accepts',
      [`accepted: ${accepted.join(', ')}`, `refused: ${refused.join(', ')}`],
      refused.join(',') === 'ANY,LIST<ANY>,LIST<STRING>,FLOAT32,INTEGER8,INTEGER16,INTEGER32');
  }
  {
    const db = fresh();
    outcome(db, "CREATE (:Company {name: 'x'})-[:ACQUIRES]->(:Company {name: 'y'})");
    const e = env(db, 'EXPLAIN MATCH (a:Corporation)-[:BUYS]->(b:Company) RETURN b.nme');
    const codes = e.notifications.map((/** @type {any} */ x) => x.code).sort();
    const w = env(db, 'EXPLAIN MATCH (n:Company) DETACH DELETE n');
    const p = env(db, 'EXPLAIN MATCH (n:Company {name: $who}) RETURN n');
    probe('P5', 'EXPLAIN names unknown labels, types and property keys, but returns no plan rows and flags no writes',
      [`notification codes: ${codes.join(', ')}`, `EXPLAIN rows: ${e.rows.length}, columns: ${e.columns.length}`,
        `EXPLAIN of a DETACH DELETE: error ${w.error ?? 'none'}, ${w.notifications.length} notifications, ${w.rows.length} rows`,
        `EXPLAIN with a parameter not supplied: error ${p.error ?? 'none'}`,
        `the store after both EXPLAINs: ${env(db, 'MATCH (n) RETURN count(n) AS n').rows[0].n} nodes`],
      codes.join(',') === ['Neo.ClientNotification.Statement.UnknownLabelWarning', 'Neo.ClientNotification.Statement.UnknownPropertyKeyWarning',
        'Neo.ClientNotification.Statement.UnknownRelationshipTypeWarning'].join(',')
        && e.rows.length === 0 && w.error == null && w.notifications.length === 0 && w.rows.length === 0 && p.error == null
        && env(db, 'MATCH (n) RETURN count(n) AS n').rows[0].n === 2);
    db.free();
  }
  {
    const ro = new R.RelateDb(true);
    const count = env(ro, 'MATCH (n) RETURN count(n) AS n').rows[0].n;
    const write = outcome(ro, 'CREATE (:X)');
    probe('P6', 'a read-only in-memory handle starts empty and refuses writes',
      [`nodes: ${count}`, `CREATE: ${write}`], count === 0 && write.includes('WriteOnReadOnlyAccessDatabase'));
    ro.free();
  }
  {
    const db = fresh();
    outcome(db, "CREATE (:Company {name: 'x'})");
    const noop = env(db, 'MATCH (n:Nothing) DETACH DELETE n').stats;
    const tmp = env(db, 'CREATE (n:Tmp) DELETE n').stats;
    const set = env(db, "MATCH (n:Company) SET n.name = 'z'").stats;
    const read = env(db, 'MATCH (n) RETURN count(n) AS n').stats;
    const moved = (/** @type {Record<string, number>} */ s) => Object.entries(s).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
    probe('P7', 'stats counters show a write; a read and a write that matches nothing move none',
      [`read: ${moved(read)}`, `DETACH DELETE matching nothing: ${moved(noop)}`, `CREATE (n:Tmp) DELETE n: ${moved(tmp)}`,
        `SET on a match: ${moved(set)}`],
      !wroteSomething(read) && !wroteSomething(noop) && wroteSomething(tmp) && wroteSomething(set));
    db.free();
  }
  {
    const db = fresh();
    const r = rw.exec(db, 'RETURN $x AS x, valueType($x) AS t, valueType(toFloat($x)) AS f', { x: 1 });
    probe('P8', 'an integral JS number binds as INTEGER; toFloat() makes it FLOAT',
      [`$x = 1: ${r.rows[0].t}; toFloat($x): ${r.rows[0].f}`], r.rows[0].t.startsWith('INTEGER') && r.rows[0].f.startsWith('FLOAT'));
    db.free();
  }
  {
    const db = fresh();
    outcome(db, 'ALTER CURRENT GRAPH TYPE SET { (:A => {id :: STRING NOT NULL, e :: VECTOR<FLOAT32 NOT NULL>(3)}), (:A =>)-[:T =>]->(:A =>) }');
    outcome(db, 'CREATE CONSTRAINT a_id_key IF NOT EXISTS FOR (n:A) REQUIRE n.id IS NODE KEY');
    const spec = env(db, 'SHOW CURRENT GRAPH TYPE YIELD specification RETURN specification AS s').rows[0].s;
    const back = readbackElements(spec);
    const named = env(db, "SHOW CONSTRAINTS YIELD name, type WHERE name = 'a_id_key' RETURN type").rows.map((/** @type {any} */ r) => r.type);
    probe('P9', 'SHOW CURRENT GRAPH TYPE prints properties sorted, vector coordinates NOT NULL, no {} for none, and folds later key/unique constraints in as CONSTRAINT items',
      spec.split('\n'), back.elements.join('|') === '(:`A` => {`e` :: VECTOR<FLOAT32 NOT NULL>(3), `id` :: STRING NOT NULL})|(:`A` =>)-[:`T` =>]->(:`A` =>)'
        && back.constraints.length === 1 && named.length === 1);
    db.free();
  }
  return L.join('\n');
}

// ---- main ----------------------------------------------------------------------------------------

async function main() {
  const opts = args(process.argv.slice(2));
  fs.mkdirSync(opts.out, { recursive: true });
  /** @type {Record<string, [string, () => string | Promise<string>]>} */
  const plan = {
    ontology: ['ontology.txt', ontologySection],
    briefing: ['briefing.txt', briefingSection],
    ddl: ['ddl.cypher', ddlSection],
    queries: ['queries.txt', queriesSection],
    validate: ['validate.txt', validateSection],
    probes: ['probes.txt', probesSection],
  };
  for (const s of opts.only) {
    const [file, fn] = plan[s];
    fs.writeFileSync(path.join(opts.out, file), await fn());
    process.stderr.write(`run.mjs: wrote ${file}\n`);
  }
  if (QUERY_LOG.length) fs.writeFileSync(path.join(opts.out, 'queries.json'), `${JSON.stringify({ relate: RELATE, queries: QUERY_LOG }, null, 1)}\n`);
  if (schemaStatements(DOC).length !== allStatements(DOC).length + 1) pin('schemaStatements');
  process.exitCode = failed ? 1 : 0;
}

await main();
