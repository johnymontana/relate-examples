#!/usr/bin/env node
// The Relate WASM surface example 33 relies on, pinned (NOTES.md R1-R19; probes.txt). In memory,
// in Node, on npm's @relate/relate-wasm as package-lock.json pins it.
//   node harness/probes.mjs <ver> > out/probes.txt 2> out/probes.err
//   node harness/probes.mjs <ver> --trap <kind>    one trap probe, in its own process (internal)
//   node harness/probes.mjs <ver> --index-timing   opt-in diagnostic: time the index cases, on stderr only
//                                                  (exit 1 when a case does not scan or seek as expected)
// stdout is diffed: no timings, ids, paths or hashes. A pin that stops reproducing prints
// `PIN: <row> changed: ...` on stderr and exits 1, after printing everything else.
// The pins that need OPFS (a dedicated worker) are browser.txt's.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as cl from '../../../lib/relate_wasm.mjs';

const VER = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(VER ?? '')) {
  console.error('usage: node harness/probes.mjs <ver> [--trap <kind> | --index-timing]');
  process.exit(2);
}
const pins = [];
/** A pin: when `ok` is false, the behaviour named by `row` changed. */
function pin(row, ok, expected, got) {
  if (!ok) pins.push(`PIN: ${row} changed: expected ${expected}, got ${got}`);
}
const say = (s = '') => console.log(s);
const section = (s) => say(`\n## ${s}`);
/** An engine error as `<category>: <first line>`, or a refusal by relate_wasm. */
function describe(e) {
  if (e instanceof cl.RelateWasmError) return `${e.category}: ${e.message}`;
  if (e instanceof TypeError && /^relate_wasm: refused \(([^)]*)\)/.test(e.message)) {
    return `refused by relate_wasm (${/^relate_wasm: refused \(([^)]*)\)/.exec(e.message)[1]})`;
  }
  return `threw ${e.constructor.name}: ${e.message.split('\n')[0]}`;
}
/** Run one statement; `->` and its rows (or error) on one line. Returns the result or the error. */
function show(db, label, q, params = null, opts = {}) {
  try {
    const r = cl.exec(db, q, params, opts);
    say(`${label} -> ${r.columns.length ? JSON.stringify(r.rows) : 'ok'}`);
    return r;
  } catch (e) {
    say(`${label} -> ${describe(e)}`);
    return e;
  }
}
const errText = (r) => (r instanceof Error ? describe(r) : 'no error');
const one = (r, key) => (r instanceof Error ? undefined : r.rows[0]?.[key]);

// ---- one trap per process (R14) -----------------------------------------------------
// Each runs in a child with a smaller stack (TRAP_STACK_KB, as a browser worker's can be): a nesting
// the parser still accepts (under its depth limit of 500) then overflows the stack and traps.
const TRAP_STACK_KB = 400;
const TRAPS = {
  'parens': ['RETURN ((((1)))) nested 450 deep', () => 'RETURN ' + '('.repeat(450) + '1' + ')'.repeat(450) + ' AS x'],
  'lists': ['RETURN [[[[]]]] nested 450 deep', () => 'RETURN size(' + '['.repeat(450) + ']'.repeat(450) + ') AS x'],
};
if (process.argv[3] === '--trap') {
  const kind = process.argv[4];
  const mod = await cl.loadNode(VER);
  const { isWasmTrap } = await import(pathToFileURL(join(await cl.find(VER), 'trap.js')).href);
  const db = new mod.RelateDb();
  const outcome = (fn) => {
    try {
      fn();
      return { ok: true };
    } catch (e) {
      return { ok: false, ctor: e.constructor.name, message: e.message.split('\n')[0], upstream: isWasmTrap(e), ours: cl.isTrap(e) };
    }
  };
  const first = outcome(() => db.execute(TRAPS[kind][1](), null));
  const again = outcome(() => db.execute('RETURN 1 AS ok', null));
  let fresh;
  try {
    const db2 = new mod.RelateDb();
    fresh = cl.exec(db2, 'RETURN 1 AS ok').rows[0].ok === 1 ? 'works' : 'wrong answer';
  } catch (e) {
    fresh = describe(e);
  }
  console.log(JSON.stringify({ first, again, fresh }));
  process.exit(0);
}

// ---- the index cases (R9), shared by the probes and --index-timing ----------------------
const RANGE10 = "OPTIONS {indexProvider: 'range-1.0'}";
const UNIQUE = 'CREATE CONSTRAINT n_uq FOR (n:N) REQUIRE n.id IS UNIQUE';
const PLAIN = 'CREATE INDEX n_id FOR (n:N) ON (n.id)';
/** [label, DDL, seek]: seek is whether a lookup on :N(id) should seek an index (false: scan the label).
 * A plain CREATE INDEX is built and serves; a UNIQUE constraint's own backing index serves its key;
 * an equivalent index and constraint refuse the second statement in either order; and the
 * `OPTIONS {indexProvider: ...}` form older engines needed is a syntax error. */
const INDEX_CASES = [
  ['no index on :N(id)', [], false],
  [PLAIN, [PLAIN], true],
  ['CREATE CONSTRAINT n_uq ... IS UNIQUE', [UNIQUE], true],
  ['the UNIQUE, then CREATE INDEX on its key (the index refused)', [UNIQUE, PLAIN], true],
  ['CREATE INDEX, then the UNIQUE on its key (the UNIQUE refused)', [PLAIN, UNIQUE], true],
  [`CREATE INDEX n_id ... ${RANGE10} (refused: only indexConfig is an option)`, [`${PLAIN} ${RANGE10}`], false],
  ['CREATE INDEX $name FOR (n:N) ON (n.id), name as a parameter', ['CREATE INDEX $name FOR (n:N) ON (n.id)'], true],
];
/** A fresh in-memory store with ddl applied, then n :N nodes; the DDL outcomes. */
function indexStore(RelateDb, ddl, n) {
  const db = new RelateDb();
  const ddlResults = ddl.map((d) => {
    try {
      cl.exec(db, d, d.includes('$name') ? { name: 'n_id' } : null);
      return 'ok';
    } catch (e) {
      return describe(e);
    }
  });
  cl.exec(db, 'UNWIND range(0, $n - 1) AS i CREATE (:N {id: i})', { n });
  return { db, ddlResults };
}
/** The leaf operator of EXPLAIN's plan document (the envelope's `plan`), with its details. */
function planLeaf(db, q, params) {
  const env = JSON.parse(db.execute(q, JSON.stringify(params)));
  if (env.error != null) return { operator: 'error', details: env.error.split('\n')[0], notes: [] };
  let node = env.plan?.root;
  while (node?.children?.length) node = node.children[0];
  return { operator: node?.operator ?? 'none', details: node?.details ?? '', notes: (env.notifications ?? []).map((x) => x.code) };
}

if (process.argv[3] === '--index-timing') {
  // Timings vary by machine and load, so they never reach stdout or run.sh's default path.
  const { RelateDb } = await cl.loadNode(VER);
  const LOOKUPS = 300;
  const SMALL = 250;
  const LARGE = 4000;
  const keys = Array.from({ length: LOOKUPS }, (_, i) => (i * 37) % SMALL);
  const lookup = 'UNWIND $keys AS k MATCH (a:N {id: k}) RETURN count(a) AS c';
  const time = (db) => {
    const t = performance.now();
    cl.exec(db, lookup, { keys });
    return performance.now() - t;
  };
  console.error(`index timing: ${LOOKUPS} lookups over ${SMALL} and over ${LARGE} :N nodes, timed alternately, best of up to 5.`);
  console.error(`A label scan costs about ${LARGE / SMALL}x more over ${LARGE} nodes, a seek about the same.`);
  let wrong = 0;
  for (const [label, ddl, built] of INDEX_CASES) {
    const small = indexStore(RelateDb, ddl, SMALL);
    const large = indexStore(RelateDb, ddl, LARGE);
    for (const st of [small, large]) cl.exec(st.db, lookup, { keys: keys.slice(0, 20) });
    let s = Infinity;
    let l = Infinity;
    const start = performance.now();
    for (let r = 0; r < 5 && (r < 2 || performance.now() - start < 600); r++) {
      s = Math.min(s, time(small.db));
      l = Math.min(l, time(large.db));
    }
    small.db.free();
    large.db.free();
    const ratio = l / s;
    const verdict = ratio >= 4 ? 'scan' : ratio <= 2 ? 'seek' : 'unclear';
    const want = built ? 'seek' : 'scan';
    if (verdict !== want) wrong++;
    console.error(`  ${verdict.padEnd(7)} ratio ${ratio.toFixed(1).padStart(5)}  (${s.toFixed(1)} / ${l.toFixed(1)} ms; ` +
      `expected ${want})  ${label}`);
  }
  process.exit(wrong ? 1 : 0);
}

// ---- the probes -----------------------------------------------------------------------
const info = await cl.check(VER);
if (!info.ok) {
  console.error(`probes: ${info.reason}`);
  process.exit(1);
}
const mod = await cl.loadNode(VER);
const { RelateDb } = mod;
say(`# Relate WASM ${VER}: the surface example 33 relies on (harness/probes.mjs; NOTES.md has a row per R-id)`);
say(`bundle: npm's @relate/relate-wasm ${VER}, installed from package-lock.json (lib/relate_wasm.check)`);

section('version (R1)');
{
  const db = new RelateDb();
  const r = cl.exec(db, 'CALL dbms.components() YIELD name, versions RETURN name, versions ORDER BY name');
  for (const row of r.rows) say(`dbms.components: ${row.name} ${row.versions.join(', ')}`);
  const v = cl.version(db);
  say(`relate_wasm.version(db) -> ${v}`);
  pin('R1 (the bundle version)', v === VER, VER, v);
  db.free();
}

section('no transaction control (R2)');
{
  const db = new RelateDb();
  for (const q of ['BEGIN', 'START TRANSACTION', 'COMMIT', 'ROLLBACK']) {
    const r = show(db, q, q);
    pin('R2 (no transaction control)', r instanceof cl.RelateWasmError && r.category === 'syntax',
      `${q} to be a syntax error`, errText(r));
  }
  const text = 'CREATE (:S {i: 1}); CREATE (:S {i: nosuch}); CREATE (:S {i: 3})';
  say(`executeScript '${text}':`);
  let ran = [];
  let err = null;
  try {
    ran = cl.script(db, text);
  } catch (e) {
    err = e;
    ran = e.results ?? [];
  }
  ran.forEach((r, i) => say(`  statement ${i + 1}: ok, nodes_created ${r.stats.nodes_created}`));
  if (err) say(`  statement ${err.index + 1}: ${describe(err)}`);
  say(`  statements after it: not run`);
  const kept = one(show(db, '  MATCH (s:S) RETURN count(s)', 'MATCH (s:S) RETURN count(s) AS c'), 'c');
  say('  (statement 1 stays committed: there is nothing to roll back)');
  pin('R2 (executeScript keeps the statements before a failing one)', err?.index === 1 && kept === 1,
    'statement 2 to fail and 1 :S node to remain', `failure at ${err ? err.index + 1 : 'none'}, ${kept} :S`);
  db.free();
}

section('null and missing parameters (R3): a null matches nothing, a missing one is refused');
{
  const db = new RelateDb();
  cl.exec(db, "UNWIND ['m1', 'm2', 'm3'] AS id CREATE (:Memory {id: id})");
  say('3 :Memory nodes, ids m1-m3');
  const map = 'MATCH (m:Memory {id: $id}) RETURN count(m) AS c';
  const where = 'MATCH (m:Memory) WHERE m.id = $id RETURN count(m) AS c';
  const counts = [
    one(show(db, '{id: $id}, $id null', map, { id: null }, { allowNull: true }), 'c'),
    one(show(db, 'WHERE m.id = $id, $id null', where, { id: null }, { allowNull: true }), 'c'),
    one(show(db, 'WHERE m.id IS NOT NULL AND m.id = $id, $id null',
      'MATCH (m:Memory) WHERE m.id IS NOT NULL AND m.id = $id RETURN count(m) AS c', { id: null }, { allowNull: true }), 'c'),
  ];
  const guarded = one(show(db, 'WHERE $id IS NOT NULL AND m.id = $id, $id null (the parameter-side guard)',
    'MATCH (m:Memory) WHERE $id IS NOT NULL AND m.id = $id RETURN count(m) AS c', { id: null }, { allowNull: true }), 'c');
  pin('R3 (a bound null matches nothing)', counts.every((c) => c === 0) && guarded === 0,
    'every null form to match 0 of 3', `${counts.join(', ')} and ${guarded}`);
  const missing = [
    show(db, '{id: $id}, $id missing (params {})', map, {}, { allowNull: true }),
    (() => {
      const env = JSON.parse(db.execute(map, null));
      const e = env.error == null ? null : new cl.RelateWasmError(env.error);
      say(`{id: $id}, no params at all (execute(q, null)) -> ${e ? describe(e) : JSON.stringify(env.rows)}`);
      return e;
    })(),
  ];
  pin('R3 (a missing parameter is refused)',
    missing.every((r) => r instanceof cl.RelateWasmError && r.category === 'semantic' &&
      /ParameterMissing: Expected parameter\(s\): id/.test(r.message)),
    'two ParameterMissing refusals', missing.map(errText).join('; '));
  say('relate_wasm.exec refuses before the engine sees it (a forgotten argument is an error, not an empty answer):');
  const refusals = [
    show(db, '  {id: $id} with {id: null}', map, { id: null }),
    show(db, '  {id: $id} with {}', map, {}),
    show(db, '  {id: $id} with {id: undefined}', map, { id: undefined }),
    show(db, '  {id: $id} with {id: NaN}', map, { id: Number.NaN }),
  ];
  pin('R3 (lib/relate_wasm refusal)', refusals.every((r) => r instanceof TypeError), 'four refusals',
    refusals.map((r) => (r instanceof Error ? r.constructor.name : 'ran')).join(', '));
  show(db, '  {id: $id} with {id: "m2"}', map, { id: 'm2' });
  db.free();
}

section('indexes (R9): what serves a lookup, shown by the plan');
{
  {
    const db = new RelateDb();
    const lookups = cl.exec(db, 'SHOW INDEXES YIELD name, type, entityType, indexProvider RETURN name, type, entityType, indexProvider ORDER BY name').rows;
    say(`a fresh store already has ${lookups.length} indexes: ${lookups.map((x) => `${x.name} ${x.type} ${x.entityType} ${x.indexProvider}`).join('; ')}`);
    pin('R9 (built-in LOOKUP indexes)', lookups.length === 2 && lookups.every((x) => x.type === 'LOOKUP'), 'two LOOKUP indexes',
      JSON.stringify(lookups.map((x) => x.type)));
    db.free();
  }
  say(`Each case: a fresh store, the DDL, then 10 :N nodes; SHOW INDEXES on :N (the built-in LOOKUP indexes left`);
  say(`out); and the leaf operator of EXPLAIN MATCH (a:N {id: $k}) RETURN a.id AS id (the envelope's plan document).`);
  say(`Timing it: node harness/probes.mjs ${VER} --index-timing (stderr only; never part of this file).`);
  const ddlOf = new Map();
  for (const [label, ddl, want] of INDEX_CASES) {
    const { db, ddlResults } = indexStore(RelateDb, ddl, 10);
    ddlOf.set(label, ddlResults);
    const leaf = planLeaf(db, 'EXPLAIN MATCH (a:N {id: $k}) RETURN a.id AS id', { k: 1 });
    const indexes = cl.exec(db, "SHOW INDEXES YIELD name, type, indexProvider, owningConstraint, createStatement WHERE type <> 'LOOKUP' " +
      'RETURN name, type, indexProvider, owningConstraint, createStatement ORDER BY name').rows;
    db.free();
    say(`- ${label}`);
    say(`    DDL: ${ddlResults.length ? ddlResults.join('; ') : '(none)'}`);
    if (!indexes.length) say('    SHOW INDEXES: (none on :N)');
    for (const ix of indexes) {
      say(`    SHOW INDEXES: ${ix.name} ${ix.type} ${ix.indexProvider}, owningConstraint ${ix.owningConstraint ?? 'null'}, ` +
        `createStatement ${ix.createStatement === null ? 'null' : JSON.stringify(ix.createStatement)}`);
    }
    say(`    EXPLAIN: ${leaf.operator} ${leaf.details}${leaf.notes.length ? ` (notifications: ${leaf.notes.join(', ')})` : ''}`);
    const seek = leaf.operator === 'NodeIndexSeek';
    pin('R9 (index use)', seek === want, `${label}: ${want ? 'NodeIndexSeek' : 'a label scan'}`, `${leaf.operator} ${leaf.details}`);
  }
  const late = [INDEX_CASES[3], INDEX_CASES[4]].map(([label]) => ddlOf.get(label)[1]);
  say('The second of an equivalent index and UNIQUE is refused in either order (IF NOT EXISTS would skip it silently).');
  pin('R9 (either order refused)', /EquivalentSchemaRuleAlreadyExists/.test(late[0]) && /AlreadyExists/.test(late[1]),
    'EquivalentSchemaRuleAlreadyExists, then AlreadyExists', late.join('; '));
  const provider = ddlOf.get(INDEX_CASES[5][0])[0];
  pin('R9 (indexProvider is not an option)', /syntax: .*indexProvider/.test(provider), 'a syntax error naming indexProvider', provider);
}

section('0 and 0.0 (R5)');
{
  const db = new RelateDb();
  show(db, 'RETURN valueType(0), valueType(0.0), 0 = 0.0', 'RETURN valueType(0) AS i, valueType(0.0) AS f, 0 = 0.0 AS eq');
  const t = show(db, 'valueType($p) for $p = 0, 0.0, 3.0, 3.5 sent from JS',
    'RETURN valueType($a) AS a, valueType($b) AS b, valueType($c) AS c, valueType($d) AS d', { a: 0, b: 0.0, c: 3.0, d: 3.5 });
  show(db, 'valueType(toFloat($p)) for $p = 0', 'RETURN valueType(toFloat($p)) AS t', { p: 0 });
  show(db, 'valueType($e) for $e = [0.9, 0]', 'RETURN valueType($e) AS t', { e: [0.9, 0] });
  cl.exec(db, "CREATE VECTOR INDEX v FOR (n:V) ON n.e OPTIONS {indexConfig: {`vector.dimensions`: 2, `vector.similarity_function`: 'cosine'}}");
  say('a 2-dimension VECTOR index on :V(e):');
  show(db, '  CREATE (:V {e: $e}), $e = [0.9, 0]', 'CREATE (n:V {e: $e}) RETURN valueType(n.e) AS t', { e: [0.9, 0] });
  show(db, '  CREATE (:V {e: [x IN $e | toFloat(x)]}), $e = [0.9, 0]',
    'CREATE (n:V {e: [x IN $e | toFloat(x)]}) RETURN valueType(n.e) AS t', { e: [0.9, 0] });
  pin('R5 (an integral JS float binds as INTEGER)', one(t, 'b') === 'INTEGER NOT NULL' && one(t, 'c') === 'INTEGER NOT NULL',
    '0.0 and 3.0 to bind as INTEGER', `${one(t, 'b')}, ${one(t, 'c')}`);
  db.free();
}

section('dynamic labels and types (R7)');
{
  const db = new RelateDb();
  show(db, 'CREATE (n:$($l)), $l = "Made"', 'CREATE (n:$($l)) RETURN labels(n) AS l', { l: 'Made' });
  show(db, 'SET n:$($ls), a list', 'MATCH (n:Made) SET n:$($ls) RETURN labels(n) AS l', { ls: ['L1', 'L2'] });
  show(db, 'MATCH (n:$($l))', 'MATCH (n:$($l)) RETURN count(n) AS c', { l: 'L1' });
  show(db, 'REMOVE n:$($l)', 'MATCH (n:Made) REMOVE n:$($l) RETURN labels(n) AS l', { l: 'L2' });
  show(db, 'CREATE ()-[r:$($t)]->()', 'CREATE (:Dy)-[r:$($t)]->(:Dy) RETURN type(r) AS t', { t: 'DYN_REL' });
  const merge = 'MERGE (a:Dy {k: 1}) MERGE (b:Dy {k: 2}) MERGE (a)-[r:$($t)]->(b) RETURN type(r) AS t';
  show(db, 'MERGE (a)-[r:$($t)]->(b), twice', merge, { t: 'LINKS' });
  cl.exec(db, merge, { t: 'LINKS' });
  show(db, '  -[:LINKS]-> afterwards', 'MATCH ()-[r:LINKS]->() RETURN count(r) AS c');
  const nulls = [
    show(db, 'CREATE (n:$($l)), $l null', 'CREATE (n:$($l)) RETURN labels(n) AS l', { l: null }, { allowNull: true }),
    show(db, 'MATCH (n:$($l)), $l null (not a match-all)', 'MATCH (n:$($l)) RETURN count(n) AS c', { l: null }, { allowNull: true }),
    show(db, 'CREATE ()-[r:$($t)]->(), $t null', 'CREATE (:Dy)-[r:$($t)]->(:Dy) RETURN type(r) AS t', { t: null }, { allowNull: true }),
  ];
  const missingLabel = show(db, 'CREATE (n:$($l)), $l missing', 'CREATE (n:$($l)) RETURN labels(n) AS l', {}, { allowNull: true });
  show(db, 'CREATE (n:$($l)), $l = ""', 'CREATE (n:$($l)) RETURN labels(n) AS l', { l: '' });
  pin('R7 (a null dynamic label or type is a type error)', nulls.every((r) => r instanceof cl.RelateWasmError && r.category === 'type'),
    'three type errors', nulls.map(errText).join('; '));
  pin('R7 (a missing one is ParameterMissing)', missingLabel instanceof cl.RelateWasmError &&
    missingLabel.category === 'semantic' && /ParameterMissing/.test(missingLabel.message), 'ParameterMissing', errText(missingLabel));
  db.free();
}

section('compiled out of wasm32, or not callable (R8, R12)');
{
  const db = new RelateDb();
  const csv = [
    show(db, "LOAD CSV FROM 'file:///x.csv'", "LOAD CSV FROM 'file:///x.csv' AS r RETURN r"),
    show(db, "LOAD CSV WITH HEADERS FROM 'https://example.com/x.csv'", "LOAD CSV WITH HEADERS FROM 'https://example.com/x.csv' AS r RETURN r"),
  ];
  pin('R8 (LOAD CSV unavailable on WASM)', csv.every((r) => r instanceof cl.RelateWasmError && /^LOAD CSV file unavailable/.test(r.message)),
    'LOAD CSV file unavailable', csv.map(errText).join('; '));
  const cp = show(db, 'CALL db.checkpoint() (no checkpoint procedure: free() is the only checkpoint)', 'CALL db.checkpoint()');
  pin('R12 (no checkpoint procedure)', cp instanceof cl.RelateWasmError && /ProcedureNotFound: db\.checkpoint/.test(cp.message),
    'ProcedureNotFound: db.checkpoint', errText(cp));
  db.free();
}

section('cdc (R18)');
{
  const db = new RelateDb();
  const r = show(db, 'CALL cdc.current()', 'CALL cdc.current()');
  show(db, 'SHOW PROCEDURES lists cdc.current', "SHOW PROCEDURES YIELD name WHERE name = 'cdc.current' RETURN count(name) AS listed");
  pin('R18', r instanceof cl.RelateWasmError && /ProcedureNotFound: cdc\.current/.test(r.message),
    'ProcedureNotFound: cdc.current', errText(r));
  db.free();
}

section('timestamp() (R19: the statement clock)');
{
  const db = new RelateDb();
  const t = show(db, 'valueType(timestamp())', 'RETURN valueType(timestamp()) AS t');
  const p = show(db, 'collect(timestamp()) over 20,000 rows of one statement: one value',
    'UNWIND range(1, 20000) AS i WITH collect(timestamp()) AS ts RETURN size(ts) AS n, min(ts) = max(ts) AS pinned');
  show(db, 'timestamp() = datetime().epochMillis', 'RETURN timestamp() = datetime().epochMillis AS same');
  show(db, 'a relationship ts from timestamp() (an INTEGER)', 'CREATE (:A)-[r:R {ts: timestamp()}]->(:B) RETURN valueType(r.ts) AS t');
  pin('R19', one(t, 't') === 'INTEGER NOT NULL' && one(p, 'pinned') === true,
    'an INTEGER, one value per statement', `${errText(t) === 'no error' ? one(t, 't') : errText(t)}, pinned ${one(p, 'pinned')}`);
  db.free();
}

section('column names and identifiers (R6)');
{
  const db = new RelateDb();
  cl.exec(db, "CREATE (:P {name: 'a'})");
  const r = cl.exec(db, 'MATCH (p:P) RETURN [x IN [1,2] | x * 2], {a: 1}.a, CASE WHEN true THEN 1 END, $x, -1, p {.name}', { x: 1 });
  say('MATCH (p:P) RETURN [x IN [1,2] | x * 2], {a: 1}.a, CASE WHEN true THEN 1 END, $x, -1, p {.name}');
  say(`  columns: ${JSON.stringify(r.columns)}`);
  say('  (an unaliased column is named by its text, a map projection by its variable: give every console column an alias)');
  pin('R6 (column names)', r.columns[0] === '[x IN [1,2] | x * 2]' && r.columns[1] === '{a: 1}.a',
    'the expression text as the column name', JSON.stringify(r.columns.slice(0, 2)));
  show(db, 'CREATE (n:Ärzte {Größe: 1}) (unquoted Unicode)', 'CREATE (n:Ärzte {Größe: 1}) RETURN labels(n) AS l, n.Größe AS g');
  show(db, 'CREATE (:Café😀) (an emoji)', 'CREATE (:Café😀) RETURN 1 AS ok');
  db.free();
}

section('the wire envelope (R4)');
{
  const db = new RelateDb();
  show(db, 'DDL: CREATE INDEX', 'CREATE INDEX w_k FOR (n:W) ON (n.k)');
  const raw = JSON.parse(db.execute('RETURN 1 AS x', null));
  say(`an envelope's keys: ${Object.keys(raw).sort().join(', ')} (relate_wasm.exec keeps columns, rows and stats)`);
  const r = cl.exec(db, "CREATE p = (a:W {k: 1})-[r:T {w: 0.5}]->(b:W {k: 2}) RETURN a, r, p");
  say(`a node's keys: ${Object.keys(r.rows[0].a).join(', ')}`);
  say(`a relationship's keys: ${Object.keys(r.rows[0].r).join(', ')}`);
  say(`a path: a flat list of ${r.rows[0].p.length} (${r.rows[0].p.map((x) => ('type' in x ? 'relationship' : 'node')).join(', ')})`);
  const big = db.execute('RETURN 9007199254740993 AS big', null);
  say(`RETURN 9007199254740993: the envelope text holds it (${big.includes('9007199254740993')}), JSON.parse gives ${JSON.parse(big).rows[0].big}`);
  say(`execute(q, '[1]') (relate_wasm never sends this) -> ${describe(new cl.RelateWasmError(JSON.parse(db.execute('RETURN 1 AS x', '[1]')).error))}`);
  pin('R4 (the wire entities carry kind)', r.rows[0].a.kind === 'node' && r.rows[0].r.kind === 'relationship',
    'kind node and relationship', `${r.rows[0].a.kind}, ${r.rows[0].r.kind}`);
  db.free();
}

section('traps (R14)');
{
  const db = new RelateDb();
  say('No longer traps: the parser and the expression builder refuse these as errors, and the handle stays usable.');
  const deep = show(db, 'RETURN ((((1)))) nested 5,000 deep', 'RETURN ' + '('.repeat(5000) + '1' + ')'.repeat(5000) + ' AS x');
  const range = show(db, 'RETURN size(range(1, 300000000))', 'RETURN size(range(1, 300000000)) AS x');
  const after = show(db, '  the same handle afterwards: RETURN 1 AS ok', 'RETURN 1 AS ok');
  pin('R14 (refused, not trapped)', deep instanceof cl.RelateWasmError && /nesting depth/.test(deep.message) &&
    range instanceof cl.RelateWasmError && /expression-memory-limit/.test(range.detail) && !(after instanceof Error),
  'a nesting-depth syntax error, an expression-memory refusal, then a working handle', `${errText(deep)} / ${errText(range)}`);
  db.free();
  say(`Still traps, each in its own process with a ${TRAP_STACK_KB} KB stack (node --stack-size): a nesting under the parser's`);
  say('limit that overflows the stack. The default Node stack takes these; a browser worker\'s may not.');
  const me = fileURLToPath(import.meta.url);
  const shown = (o) => (o.ok ? 'no error' : `threw ${o.ctor}: ${o.message}; trap.js isWasmTrap ${o.upstream}, relate_wasm.isTrap ${o.ours}`);
  for (const [kind, [label]] of Object.entries(TRAPS)) {
    const child = spawnSync(process.execPath, [`--stack-size=${TRAP_STACK_KB}`, me, VER, '--trap', kind], { encoding: 'utf8' });
    process.stderr.write(child.stderr);
    if (child.status !== 0) {
      say(`${label} -> the probe process exited ${child.status}`);
      pins.push(`PIN: R14 changed: the ${kind} trap probe exited ${child.status}`);
      continue;
    }
    const { first, again, fresh } = JSON.parse(child.stdout.trim().split('\n').pop());
    say(`${label} -> ${shown(first)}`);
    say(`  the same handle again -> ${shown(again)}`);
    say(`  a new handle on the same instance -> ${fresh}`);
    pin('R14 (traps)', !first.ok && first.upstream && !again.ok && /recursive use of an object/.test(again.message) &&
      !again.upstream && again.ours, 'a trap, then `recursive use of an object` that only relate_wasm.isTrap catches',
    `${shown(first)} / ${shown(again)}`);
  }
}

section('a read-only handle in memory (R15): new RelateDb(true)');
{
  const db = new RelateDb(true);
  const allowed = [
    ['RETURN 1 AS ok', 'RETURN 1 AS ok'],
    ['EXPLAIN CREATE (:X) (a plan, nothing written)', 'EXPLAIN CREATE (:X)'],
  ];
  const refused = [
    ['CREATE (:X)', 'CREATE (:X)'],
    ['MERGE (x:X {k: 1}) (would create)', 'MERGE (x:X {k: 1}) RETURN x.k AS k'],
    ['CALL { CREATE (:X) }', 'CALL { CREATE (:X) }'],
    ['FOREACH (i IN [1] | CREATE (:X))', 'FOREACH (i IN [1] | CREATE (:X))'],
    ['PROFILE CREATE (:X)', 'PROFILE CREATE (:X)'],
    ['CALL { ... } IN TRANSACTIONS', 'UNWIND [1] AS i CALL { WITH i CREATE (:X) } IN TRANSACTIONS'],
    ['CREATE INDEX', 'CREATE INDEX x_k FOR (x:X) ON (x.k)'],
    ['CREATE CONSTRAINT', 'CREATE CONSTRAINT x_k FOR (x:X) REQUIRE x.k IS UNIQUE'],
    ['ALTER CURRENT GRAPH TYPE SET', 'ALTER CURRENT GRAPH TYPE SET { (:A => {name :: STRING NOT NULL}) }'],
  ];
  const noRows = [
    ['MATCH (n) CREATE (:X) (no rows)', 'MATCH (n) CREATE (:X)'],
    ['MATCH (n) SET n.x = 1 (no rows)', 'MATCH (n) SET n.x = 1'],
    ['MATCH (n) DETACH DELETE n (no rows)', 'MATCH (n) DETACH DELETE n'],
    ['DROP INDEX nosuch IF EXISTS', 'DROP INDEX nosuch IF EXISTS'],
  ];
  const okRuns = allowed.map(([l, q]) => show(db, l, q));
  const refusals = refused.map(([l, q]) => show(db, l, q));
  say('Refused per write performed, not per statement: with nothing to write, these succeed:');
  const quiet = noRows.map(([l, q]) => show(db, `  ${l}`, q));
  let reset;
  try {
    db.reset();
    reset = 'no error';
  } catch (e) {
    reset = `threw ${cl.classify(e.message)}: ${e.message.split('\n')[0]}`;
  }
  say(`reset() -> ${reset}`);
  const text = 'RETURN 1 AS a; CREATE (:X); RETURN 2 AS b';
  try {
    cl.script(db, text);
    say(`executeScript '${text}' -> no error`);
  } catch (e) {
    say(`executeScript '${text}' -> ${e.results.length} result, then ${describe(e)} at statement ${e.index + 1}`);
  }
  pin('R15 (read-only handle)', okRuns.every((r) => !(r instanceof Error)) &&
    refusals.every((r) => r instanceof cl.RelateWasmError && r.category === 'readonly') &&
    quiet.every((r) => !(r instanceof Error)) && reset === 'threw readonly: database is read-only',
    'reads and EXPLAIN to run, every write to be refused as read-only, reset() to throw',
    [...okRuns, ...refusals, ...quiet].map(errText).filter((s) => s !== 'no error' && !/read-only/.test(s)).join('; ') || reset);
  db.free();
  say('In OPFS (browser.txt): a read-only open of a store with data refuses SET and DELETE too, an');
  say("illegal edge reports the graph type's ConstraintValidationFailed before the read-only error, the store's");
  say('files stay byte-identical, and a read-only handle and a writer exclude each other (storage locked).');
}

if (pins.length) {
  for (const p of pins) {
    console.error(`${p}. Update expected/probes.txt and the row in NOTES.md together.`);
  }
  process.exitCode = 1;
}
