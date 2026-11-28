#!/usr/bin/env node
// @ts-check
/**
 * harness/run.mjs: example 03's Node sections. From the example's directory:
 *
 *   node harness/run.mjs [--out out] [--only statements,scenarios,typed,probes,ontology]
 *
 * Each section writes one deterministic report into --out (no timestamps, paths, timings or engine
 * ids), which run.sh diffs against expected/:
 *
 *   statements.cypher  the memory's schema and the statement behind each tool (web/memory.js), as
 *                      the page runs them
 *   scenarios.txt      every scripted conversation (data/scenarios/*.json) through web/agent.js and
 *                      web/memory.js on Relate 1.3.0 WASM, exactly as the page runs them: each tool
 *                      call's rows (how each memory was reached, its score and its trail), what was
 *                      stored, the reply and its citations; then the same writes replayed, which
 *                      must change nothing
 *   typed.txt          turns nobody scripted (web/agent.js freeTurn): which tool the rules pick,
 *                      and the reply assembled from what it returned
 *   probes.txt         M1...: the Relate 1.3.0 behaviours the example depends on, each a minimal
 *                      repro (NOTES.md has one row per probe); and what the embedding model's
 *                      vectors (data/embeddings.json) say about a few pairs of texts
 *   ontology.txt       the memory model as an Ontology Graph Spec document
 *                      (data/agent-memory.ontology.json, read by web/ontology.js): what the
 *                      specification's SDK says of it, that it describes exactly the schema the
 *                      engine holds, that every store the conversations build keeps the rules the
 *                      engine does not enforce, what its questions return, and what the Ontology
 *                      tab searches and draws (NOTES.md D10, D11, S1 to S3)
 *
 * It also writes out/replay.json (not diffed): the schema and every statement the scenarios ran,
 * with its parameters and rows, for harness/native.py (the same statements on native Relate), and
 * each turn's outcome and what the ontology section found, for harness/drive.mjs (the same in the page).
 *
 * A reply that cites a memory its tool did not return, or a probe that stops reproducing, prints
 * `PIN: <what> changed` on stderr and the run exits 1 (after writing every report, so the diff shows
 * what moved).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as sdk from '@neo4j/ontology-graph-spec';
import { VALIDATION_SETS, createOgs } from '../../../lib/ogs.mjs';
import * as rw from '../../../lib/relate_wasm.mjs';
import { freeTurn, mergePaths, plan, scriptedTurn } from '../web/agent.js';
import { DIMS, MODEL, contentWords, createEmbedder, precomputed, terms } from '../web/embed.js';
import * as M from '../web/memory.js';
import * as O from '../web/ontology.js';
import { TYPED, TYPED_WITHOUT_VECTOR } from './typed.mjs';

const EX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELATE = M.RELATE;
const SECTIONS = ['statements', 'scenarios', 'typed', 'probes', 'ontology'];
const SCENARIOS = ['team', 'trip', 'code'];

let failed = false;
/** @param {string} what */
const pin = (what) => {
  failed = true;
  process.stderr.write(`PIN: ${what} changed\n`);
};
const readJson = (/** @type {string} */ rel) => JSON.parse(fs.readFileSync(path.join(EX, rel), 'utf8'));
/** The scripts' vectors (harness/embed.mjs wrote them): the run embeds nothing itself. */
const KNOWN = precomputed(readJson('data/embeddings.json'));
const embedder = createEmbedder({ known: KNOWN });
/** Canonical JSON: object keys sorted. @param {any} v @returns {string} */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
/** An engine message's first line, with the engine's generated constraint names masked. */
const firstLine = (/** @type {unknown} */ e) => String(/** @type {any} */ (e)?.message ?? e).split('\n')[0]
  .replace(/`constraint_[0-9a-f]+`/g, '`constraint_<generated>`');

function args(/** @type {string[]} */ argv) {
  const opts = { out: path.join(EX, 'out'), only: SECTIONS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') opts.out = path.resolve(argv[++i]);
    else if (argv[i] === '--only') opts.only = argv[++i].split(',');
    else throw new Error(`run.mjs: unknown argument ${argv[i]}\nusage: node harness/run.mjs [--out DIR] [--only ${SECTIONS.join(',')}]`);
  }
  for (const s of opts.only) if (!SECTIONS.includes(s)) throw new Error(`run.mjs: unknown section ${s}`);
  return opts;
}

/** A reply as text: citations as [n]. @param {any} reply */
const replyText = (reply) => reply.parts.map((/** @type {any} */ p) => (p.text !== undefined ? p.text : ` [${p.n}]`)).join('');

/**
 * A tool step's lines for a report. Engine ids never appear: a path is shown by its trail.
 * @param {any} step @param {any} res  the TurnResult it belongs to
 */
function stepLines(step, res) {
  const out = [];
  const cited = (/** @type {string} */ id) => {
    const c = res.reply.cites.find((/** @type {any} */ x) => x.id === id);
    return c ? `[${c.n}]` : '   ';
  };
  if (step.tool === 'recall') {
    out.push(`  recall ${JSON.stringify(step.question)}${step.embedded ? '' : ' (no vector)'}: ${step.rows.length} row${step.rows.length === 1 ? '' : 's'}`);
    for (const r of step.rows) {
      const how = r.via === 'graph' ? '' : ` (by ${r.by.join(' and ')}${r.similarity === null ? '' : `, cosine ${r.similarity.toFixed(2)}`})`;
      out.push(`    ${cited(r.id)} ${r.score.toFixed(4)} ${r.via.padEnd(6)} ${r.id}: ${r.text}${how}`);
      out.push(`          path: ${r.trail.join(' > ')}${r.about.length ? `   about: ${r.about.map((/** @type {any} */ a) => a.name).join(', ')}` : ''}`);
      if (r.replaced.length) out.push(`          replaced: ${r.replaced.join(' | ')}`);
    }
  } else if (step.tool === 'connect') {
    out.push(`  connect ${step.from} -> ${step.to}: ${step.row ? `${step.row.hops} memories apart` : 'no chain'}`);
    if (step.row) out.push(`          path: ${step.row.trail.join(' > ')}`);
  } else if (step.tool === 'trace') {
    out.push(`  trace ${step.id}: ${step.rows.length} version${step.rows.length === 1 ? '' : 's'}`);
    for (const r of step.rows) {
      out.push(`    ${r.current ? 'current ' : 'replaced'} ${r.id}: ${r.text}`);
      out.push(`          said in ${JSON.stringify(r.session)} at ${r.at}: ${JSON.stringify(r.said)}`);
      out.push(`          path: ${r.trail.join(' > ')}`);
    }
  } else if (step.tool === 'remember') {
    const c = step.counts;
    out.push(`  remember: ${c.entities} entit${c.entities === 1 ? 'y' : 'ies'} mentioned, ${c.memories} memor${c.memories === 1 ? 'y' : 'ies'}, ${c.links} about-links, ${c.superseded} superseded`);
    for (const m of step.memories) out.push(`    + ${m.kind} ${m.id}${m.slot ? ` (slot ${m.slot})` : ''}: ${m.text}${m.rationale ? ` (because ${m.rationale})` : ''}`);
  }
  return out;
}

/** The counts of a store: nodes by label, relationships by type. @param {any} db */
function census(db) {
  const nodes = rw.exec(db, 'MATCH (n) RETURN labels(n)[0] AS l, count(*) AS n ORDER BY l').rows.map((r) => `${r.n} ${r.l}`).join(', ');
  const rels = rw.exec(db, 'MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS n ORDER BY t').rows.map((r) => `${r.n} ${r.t}`).join(', ');
  return { nodes, rels };
}

/**
 * A fresh store with the schema, and the memory tools over it, logging every call.
 * @param {any} mod @param {any[]} [log]
 */
function openStore(mod, log) {
  const db = new mod.RelateDb();
  const memory = M.createMemory(db, rw.exec, { onCall: (c) => log?.push(c) });
  memory.schema();
  return { db, memory };
}

// ---- statements --------------------------------------------------------------------------------

function statementsSection() {
  const lines = [
    '// Example 03: the statements behind the page (web/memory.js), written by harness/run.mjs.',
    '// The schema, applied to an empty store in this order; then one block per tool.',
    '',
    '// ---- schema ----',
  ];
  for (const s of M.SCHEMA) lines.push(`${s};`, '');
  for (const [name, text] of [
    ['remember (1 of 3): the session, the message, the entities it mentions', M.REMEMBER_MESSAGE],
    ['remember (2 of 3): the memories, each with its vector, its source and what it is about', M.REMEMBER_MEMORIES],
    ['remember (3 of 3): a new memory replaces the current one in its slot', M.REMEMBER_SUPERSEDE],
    ['recall: hybrid search, then the graph', M.RECALL],
    ['connect: the shortest chain of current memories between two entities', M.CONNECT],
    ['trace: where a memory, and each version it replaced, came from', M.TRACE],
    ['the entities a typed text names', M.ENTITIES_NAMED],
    ['snapshot: what the page draws (nodes)', M.SNAPSHOT_NODES],
    ['snapshot: what the page draws (relationships)', M.SNAPSHOT_RELS],
  ]) lines.push(`// ---- ${name} ----`, `${text};`, '');
  return `${lines.join('\n').trimEnd()}\n`;
}

// ---- scenarios ---------------------------------------------------------------------------------

/** @param {any} mod @param {{schema: string[], queries: any[], turns: Record<string, any[]>}} replay */
async function scenariosSection(mod, replay) {
  const say = [`# Example 03: the scripted conversations on Relate ${RELATE} WASM (harness/run.mjs), as the page runs them`, ''];
  say.push('Each turn: what the user said, what each memory tool returned, and the reply. In a recall row,');
  say.push('[n] marks a memory the reply cites, then its score, how it was reached (search: a search hit;');
  say.push('update: the current version of a hit that had been replaced; graph: linked through shared entities),');
  say.push('how a hit was found (by meaning: the vector search, with the cosine similarity; by words: the');
  say.push(`full-text search) and the path that reached it. Vectors: ${MODEL.id} (data/embeddings.json).`);
  for (const id of SCENARIOS) {
    const sc = readJson(`data/scenarios/${id}.json`);
    /** @type {any[]} */ const log = [];
    const { db, memory } = openStore(mod, log);
    log.length = 0;   // the schema is replayed from statements.cypher, not from the log
    say.push('', `## ${sc.title} (${id}): ${sc.sessions.length} sessions, ${sc.sessions.reduce((/** @type {number} */ n, /** @type {any} */ s) => n + s.turns.length, 0)} turns`);
    /** @type {any[]} */ const remembered = [];
    replay.turns[id] = [];
    for (const step of plan(sc)) {
      if (step.firstOfSession) say.push('', `### ${step.session.title}`);
      const res = await scriptedTurn(/** @type {any} */ ({ ...memory, embed: embedder.embed, remember: (/** @type {any} */ a) => { remembered.push(a); return memory.remember(a); } }), step);
      say.push('', `[${step.seq}] user: ${step.user}`);
      for (const s of res.steps) say.push(...stepLines(s, res));
      say.push(`  reply: ${replyText(res.reply)}`);
      const lit = mergePaths(res.highlight.paths);
      if (res.highlight.paths.length) say.push(`  highlighted: ${lit.strong.nodes.length} nodes and ${lit.strong.rels.length} relationships brightly, ${lit.soft.nodes.length} and ${lit.soft.rels.length} softly`);
      for (const p of res.problems) { say.push(`  PROBLEM: ${p}`); pin(`${id} turn ${step.seq}: ${p}`); }
      replay.turns[id].push({
        seq: step.seq,
        reply: replyText(res.reply),
        tools: res.steps.map((/** @type {any} */ s) => ({ tool: s.tool, ids: s.rows ? s.rows.map((/** @type {any} */ r) => `${r.id}/${r.via ?? ''}${r.by ? `/${r.by.join('+')}/${r.similarity}` : ''}`) : s.row ? s.row.trail : [] })),
        lit: [lit.strong.nodes.length, lit.strong.rels.length, lit.soft.nodes.length, lit.soft.rels.length],
      });
    }
    const before = census(db);
    say.push('', `the store: ${before.nodes}; ${before.rels}`);
    for (const c of log) replay.queries.push({ scenario: id, tool: c.tool, write: c.write, statement: c.statement, params: c.params, rows: c.rows });
    for (const a of remembered) memory.remember(a);
    const after = census(db);
    const same = canon(before) === canon(after);
    say.push(`every remember run a second time changes nothing: ${same ? 'yes' : `NO (${after.nodes}; ${after.rels})`}`);
    if (!same) pin(`${id}: remember is no longer idempotent`);
    db.free();
  }
  return `${say.join('\n')}\n`;
}

// ---- typed turns -------------------------------------------------------------------------------


/** @param {any} mod */
async function typedSection(mod) {
  const sc = readJson('data/scenarios/team.json');
  const { db, memory } = openStore(mod);
  const steps = plan(sc);
  const tools = /** @type {any} */ ({ ...memory, embed: embedder.embed });
  for (const step of steps) await scriptedTurn(tools, step);
  const say = [`# Example 03: turns nobody scripted (web/agent.js freeTurn), after the "${sc.title}" conversation`, ''];
  say.push('No language model: a question goes to recall (or to connect, when it asks how two known entities are');
  say.push('linked, or on to trace, when it asks for a source); anything else is stored word for word as a note,');
  say.push('linked to the entities it names. The reply is assembled from what the tool returned. In the page a typed');
  say.push('text gets its vector from the model in the tab; here each has one in data/embeddings.json, but the last');
  say.push('two, which have none on purpose: the note is stored and found by its words alone, as it is in a tab');
  say.push('that could not load the model.');
  let seq = steps.length;
  for (const text of [...TYPED, ...TYPED_WITHOUT_VECTOR]) {
    seq++;
    if (TYPED.includes(text) !== (embedder.source(text) === 'ahead')) pin(`data/embeddings.json and harness/typed.mjs (${text})`);
    const res = await freeTurn(tools, text, {
      session: { id: 'team-you', title: 'Your turn', startedAt: '2026-01-01T00:00:00Z' },
      seq, at: '2026-01-01T00:00:00Z', messageId: `team-${seq}`, noteId: `note-${seq}`,
    });
    say.push('', `[${seq}] user: ${text}`);
    for (const s of res.steps) say.push(...stepLines(s, res));
    say.push(...replyText(res.reply).split('\n').map((l, i) => (i ? `         ${l}` : `  reply: ${l}`)));
    for (const p of res.problems) { say.push(`  PROBLEM: ${p}`); pin(`typed turn ${JSON.stringify(text)}: ${p}`); }
  }
  const c = census(db);
  say.push('', `the store: ${c.nodes}; ${c.rels}`);
  db.free();
  return `${say.join('\n')}\n`;
}

// ---- probes ------------------------------------------------------------------------------------

/** @param {any} mod */
function probesSection(mod) {
  const say = [`# Example 03: the Relate ${RELATE} behaviours it depends on (harness/run.mjs; NOTES.md has one row per probe)`];
  /** @param {string} id @param {string} what @param {string[]} got @param {boolean} ok */
  const probe = (id, what, got, ok) => {
    say.push('', `${id} ${what}`, ...got.map((l) => `  ${l}`));
    if (!ok) pin(`${id} (${what})`);
  };
  /** @param {any} db @param {string} q @param {object} [p] */
  const attempt = (db, q, p) => {
    try { return { rows: rw.exec(db, q, p ?? null, { allowNull: true }).rows, error: null }; } catch (e) { return { rows: [], error: firstLine(e) }; }
  };
  /** Vectors made for the probes, so every similarity is known exactly: unit vectors along one axis, or between two. */
  const axis = (/** @type {number} */ i) => Array.from({ length: DIMS }, (_, k) => (k === i ? 1 : 0));
  const between = (/** @type {number} */ i, /** @type {number} */ j, /** @type {number} */ cos) => Array.from({ length: DIMS }, (_, k) => (k === i ? cos : k === j ? Math.sqrt(1 - cos * cos) : 0));
  const fresh = () => openStore(mod);
  const session = { id: 's', title: 'S', startedAt: '2026-01-01T00:00:00Z' };
  /** A store with four memories about tests and a repo: a along axis 0, b at a cosine of 0.4 to it, c and d each on an axis of its own. */
  const seeded = () => {
    const s = fresh();
    s.memory.remember({
      session, message: { id: 'p1', seq: 1, text: 'first', at: '2026-01-01T00:00:00Z' },
      entities: [{ name: 'tests', kind: 'topic' }, { name: 'pnpm', kind: 'tool' }, { name: 'repo', kind: 'repository' }, { name: 'Kenji', kind: 'person' }],
      memories: [
        { id: 'a', kind: 'fact', text: 'Run the tests with pnpm test', gist: 'run with', about: ['tests', 'pnpm'], embedding: axis(0) },
        { id: 'b', kind: 'decision', text: 'Use pnpm in the repo', gist: 'uses', slot: 'repo/pm', about: ['repo', 'pnpm'], embedding: between(0, 1, 0.4) },
        { id: 'c', kind: 'fact', text: 'Kenji reviews every change to the repo', gist: 'reviews', about: ['Kenji', 'repo'], embedding: axis(2) },
      ],
    });
    s.memory.remember({
      session, message: { id: 'p2', seq: 2, text: 'second', at: '2026-01-01T00:03:00Z' },
      entities: [{ name: 'repo', kind: 'repository' }, { name: 'bun', kind: 'tool' }],
      memories: [{ id: 'd', kind: 'decision', text: 'Use bun in the repo', gist: 'uses', slot: 'repo/pm', about: ['repo', 'bun'], embedding: axis(3) }],
    });
    return s;
  };

  {
    const { db } = fresh();
    const v = { v: axis(0) };
    const noText = attempt(db, `CREATE (:Memory {id: 'x', kind: 'fact', gist: 'g', slot: '', seq: 1, at: datetime('2026-01-01T00:00:00Z'), current: true, embedding: vector([x IN $v | toFloat(x)], ${DIMS}, FLOAT32)})`, v);
    const shortVector = attempt(db, "CREATE (:Memory {id: 'x', kind: 'fact', text: 't', gist: 'g', slot: '', seq: 1, at: datetime('2026-01-01T00:00:00Z'), current: true, embedding: vector([0.5, 0.5], 2, FLOAT32)})");
    const wrongType = attempt(db, `CREATE (:Memory {id: 'x', kind: 'fact', text: 't', gist: 'g', slot: '', seq: 'one', at: datetime('2026-01-01T00:00:00Z'), current: true, embedding: vector([x IN $v | toFloat(x)], ${DIMS}, FLOAT32)})`, v);
    rw.exec(db, "CREATE (:Entity {key: 'a', name: 'A', kind: 'thing'}), (:Entity {key: 'b', name: 'B', kind: 'thing'})");
    const wrongEnds = attempt(db, "MATCH (a:Entity {key: 'a'}), (b:Entity {key: 'b'}) CREATE (a)-[:ABOUT]->(b)");
    const extra = attempt(db, "MATCH (a:Entity {key: 'a'}) SET a.note = 'undeclared properties are allowed' RETURN a.note AS note");
    const left = rw.exec(db, 'MATCH (m:Memory) RETURN count(m) AS n').rows[0].n;
    const noVector = attempt(db, "CREATE (m:Memory {id: 'y', kind: 'note', text: 't', gist: 'g', slot: '', seq: 1, at: datetime('2026-01-01T00:00:00Z'), current: true}) RETURN m.embedding IS NULL AS none");
    probe('M1', 'the graph type refuses a malformed memory, on every write', [
      `a memory without its text: ${noText.error}`,
      `a vector of the wrong length: ${shortVector.error}`,
      `a string where an INTEGER is declared: ${wrongType.error}`,
      `ABOUT between two entities: ${wrongEnds.error}`,
      `a property the type does not declare: ${extra.error ?? `accepted (${extra.rows[0].note})`}`,
      `memories stored by the refused writes: ${left}`,
      `a memory without a vector (the property is typed, not required): ${noVector.error ?? `accepted (embedding IS NULL: ${noVector.rows[0].none})`}`,
    ], !!noText.error && !!shortVector.error && !!wrongType.error && !!wrongEnds.error && !extra.error && left === 0 && !noVector.error && noVector.rows[0].none === true);
    db.free();
  }
  {
    const { db } = fresh();
    const ok = attempt(db, `MERGE (s:Session {id: 'm'}) ON CREATE SET s.title = 'T', s.startedAt = datetime('2026-01-01T00:00:00Z') RETURN s.title AS title`);
    const bare = attempt(db, "MERGE (s:Session {id: 'n'}) RETURN s.id AS id");
    probe('M2', 'under the graph type, MERGE ... ON CREATE SET may fill the required properties: the check runs when the statement ends', [
      `MERGE with ON CREATE SET for title and startedAt: ${ok.error ?? `created (${ok.rows[0].title})`}`,
      `MERGE on the key alone: ${bare.error}`,
    ], !ok.error && !!bare.error);
    db.free();
  }
  {
    const { db } = seeded();
    const q = (/** @type {number[]} */ v) => attempt(db, `MATCH (m:Memory) SEARCH m IN (VECTOR INDEX memory_embedding FOR vector([x IN $v | toFloat(x)], ${DIMS}, FLOAT32) LIMIT 4) SCORE AS s RETURN m.id AS id, round(s, 3) AS s ORDER BY s DESC, id`, { v });
    const same = q(axis(0));
    const none = q(new Array(DIMS).fill(0));
    const raw = attempt(db, 'MATCH (m:Memory) SEARCH m IN (VECTOR INDEX memory_embedding FOR $v LIMIT 1) SCORE AS s RETURN m.id AS id', { v: axis(0) });
    const noLimit = attempt(db, 'MATCH (m:Memory) SEARCH m IN (VECTOR INDEX memory_embedding FOR $v) SCORE AS s RETURN m.id AS id', { v: axis(0) });
    rw.exec(db, "CREATE (:Memory {id: 'bare', kind: 'note', text: 'no vector', gist: 'bare', slot: '', seq: 9, at: datetime('2026-01-01T00:00:00Z'), current: true})");
    const bare = attempt(db, 'MATCH (m:Memory) SEARCH m IN (VECTOR INDEX memory_embedding FOR $v LIMIT 8) SCORE AS s RETURN m.id AS id ORDER BY s DESC, id', { v: axis(0) });
    probe('M3', 'SEARCH on a vector index: the k nearest, scored (1 + cosine) / 2, whatever their similarity', [
      `memory a's own vector (b is at a cosine of 0.4 to it, c and d at 0): ${same.rows.map((r) => `${r.id} ${r.s}`).join(', ')}`,
      `a zero vector (a question with no vector): ${none.error ?? `${none.rows.length} rows`}`,
      `a plain list parameter as the query vector: ${raw.error ?? raw.rows.map((r) => r.id).join(', ')}`,
      `without LIMIT inside the search: ${noLimit.error ?? 'accepted'}`,
      `with a fifth memory that has no vector, LIMIT 8: ${bare.error ?? bare.rows.map((r) => r.id).join(', ')}`,
    ], same.rows.map((r) => `${r.id} ${r.s}`).join() === 'a 1,b 0.7,c 0.5,d 0.5' && none.rows.length === 0 && !none.error && !raw.error && !!noLimit.error && bare.rows.map((r) => r.id).join() === 'a,b,c,d');
    db.free();
  }
  {
    const { db } = seeded();
    const q = (/** @type {string} */ t) => attempt(db, 'MATCH (m:Memory) SEARCH m IN (FULLTEXT INDEX memory_text FOR $t LIMIT 8) SCORE AS s RETURN m.id AS id ORDER BY s DESC, id', { t });
    const tests = q('tests');
    const test = q('test');
    const either = q('kenji bun');
    const empty = q('');
    const none = q(M.NO_WORDS);
    const star = q('*');
    const minus = q('-y');
    const plus = q('+y');
    const bang = q('!y');
    const parens = q('(kenji bun)');
    const phrase = q('"kenji bun"');
    const where = (/** @type {string} */ w) => attempt(db, `MATCH (m:Memory) SEARCH m IN (FULLTEXT INDEX memory_text FOR 'kenji bun' ${w} LIMIT 8) SCORE AS s RETURN m.id AS id ORDER BY id`, {});
    const whereEq = where("WHERE m.current = true");
    const whereBare = where('WHERE m.current');
    probe('M4', 'SEARCH on a full-text index: terms are ORed and matched whole, with no stemming; an empty query, a -, + or ! modifier, grouping parentheses and a quoted phrase are refused, * matches every memory, a query with no word in it finds nothing; WHERE takes comparisons', [
      `"tests": ${tests.rows.map((r) => r.id).join(', ')}`,
      `"test": ${test.rows.map((r) => r.id).join(', ')} (the same memory holds both words; "tests" alone would not match "test")`,
      `"kenji bun": ${either.rows.map((r) => r.id).join(', ')}`,
      `an empty query: ${empty.error ?? `${empty.rows.length} rows`}`,
      `"${M.NO_WORDS}" (memory.js NO_WORDS): ${none.error ?? `${none.rows.length} rows`}`,
      `"*": ${star.error ?? `${star.rows.length} rows`}`,
      `"-y": ${minus.error ?? `${minus.rows.length} rows`}`,
      `"+y": ${plus.error ?? `${plus.rows.length} rows`}`,
      `"!y": ${bang.error ?? `${bang.rows.length} rows`}`,
      `"(kenji bun)": ${parens.error ?? `${parens.rows.length} rows`}`,
      `"\\"kenji bun\\"" (a quoted phrase): ${phrase.error ?? `${phrase.rows.length} rows`}`,
      `WHERE m.current = true: ${whereEq.error ?? whereEq.rows.map((r) => r.id).join(', ')}`,
      `WHERE m.current (a bare boolean): ${whereBare.error ?? whereBare.rows.map((r) => r.id).join(', ')}`,
    ], tests.rows.map((r) => r.id).join() === 'a' && test.rows.map((r) => r.id).join() === 'a' && either.rows.length === 2 && !!empty.error && !none.error && none.rows.length === 0 && !star.error && star.rows.length > either.rows.length && !!minus.error && !!plus.error && !!bang.error && !!parens.error && !whereEq.error && whereEq.rows.length >= 1 && !!whereBare.error);
    db.free();
  }
  {
    const { db, memory } = seeded();
    // the question's vector sits on memory b (the replaced "Use pnpm"); its words are in a and b
    const rows = memory.recall({ question: 'Which package manager do we use, pnpm?', vector: between(0, 1, 0.4) });
    const b = rows.find((r) => r.id === 'd');
    const a = rows.find((r) => r.id === 'a');
    const c = rows.find((r) => r.id === 'c');
    probe('M5', 'one statement: two SEARCH lists joined by UNION ALL inside CALL () {}, fused by rank, then two graph steps', [
      ...rows.map((r) => `${r.score.toFixed(4)} ${r.via.padEnd(6)} ${r.id}: ${r.trail.join(' > ')}${r.via === 'graph' ? '' : ` (by ${r.by.join(' and ')}${r.similarity === null ? '' : `, cosine ${r.similarity.toFixed(2)}`})`}`),
      `the hit "Use pnpm" was replaced: recall returns its current version by following SUPERSEDES: ${b ? `${b.via} (${b.replaced.join(' | ')})` : 'missing'}`,
      `a memory that shares no word with the question is reached through an entity: ${c ? `${c.via}, through ${c.through.join(', ')}` : 'missing'}`,
    ], b?.via === 'update' && a?.via === 'search' && c?.via === 'graph' && rows.every((r) => r.id !== 'b'));
    db.free();
  }
  {
    const { db, memory } = seeded();
    // a second way from Kenji to bun, so that there is more than one path to choose from
    memory.remember({
      session, message: { id: 'p3', seq: 3, text: 'third', at: '2026-01-01T00:06:00Z' },
      entities: [{ name: 'Kenji', kind: 'person' }, { name: 'bun', kind: 'tool' }],
      memories: [{ id: 'e', kind: 'preference', text: 'Kenji likes bun', gist: 'likes', about: ['Kenji', 'bun'], embedding: axis(4) }],
    });
    const chain = "(a) (()<-[:ABOUT]-(m:Memory WHERE m.current)-[:ABOUT]->()){1,6} (b)";
    const zero = attempt(db, "MATCH (m:Memory {id: 'd'}) MATCH p = (m)<-[:SUPERSEDES]-*(now:Memory WHERE now.current) RETURN now.id AS id, length(p) AS len");
    const one = attempt(db, "MATCH (m:Memory {id: 'b'}) MATCH p = (m)<-[:SUPERSEDES]-*(now:Memory WHERE now.current) RETURN now.id AS id, length(p) AS len");
    const all = attempt(db, `MATCH (a:Entity {key: 'kenji'}), (b:Entity {key: 'bun'}) MATCH p = ${chain} RETURN count(p) AS paths, min(length(p)) AS shortest, max(length(p)) AS longest`);
    const any = attempt(db, `MATCH (a:Entity {key: 'kenji'}), (b:Entity {key: 'bun'}) MATCH p = ANY SHORTEST ${chain} RETURN [n IN nodes(p) | coalesce(n.name, n.gist)] AS trail`);
    const stale = attempt(db, `MATCH (a:Entity {key: 'repo'}), (b:Entity {key: 'pnpm'}) MATCH p = ANY SHORTEST ${chain} RETURN [n IN nodes(p) | coalesce(n.name, n.gist)] AS trail`);
    const through = attempt(db, "MATCH (a:Entity {key: 'repo'})<-[:ABOUT]-(m:Memory)-[:ABOUT]->(b:Entity {key: 'pnpm'}) RETURN m.id AS id, m.current AS current");
    probe('M6', 'quantified path patterns: a zero-length match, a predicate inside the repeated part, and ANY SHORTEST keeping one path per pair of ends', [
      `-[:SUPERSEDES]-* from the current memory: ${zero.error ?? zero.rows.map((r) => `${r.id}, length ${r.len}`).join('; ')}`,
      `-[:SUPERSEDES]-* from the one it replaced: ${one.error ?? one.rows.map((r) => `${r.id}, length ${r.len}`).join('; ')}`,
      `Kenji to bun over current memories, every path: ${all.error ?? `${all.rows[0].paths} paths, lengths ${all.rows[0].shortest} to ${all.rows[0].longest}`}`,
      `the same with ANY SHORTEST: ${any.error ?? `${any.rows.length} path: ${any.rows.map((r) => r.trail.join(' > ')).join('; ')}`}`,
      `repo to pnpm, whose only link is the replaced memory ${through.rows.map((r) => `${r.id} (current: ${r.current})`).join(', ')}: ${stale.error ?? `${stale.rows.length} paths`}`,
    ], zero.rows[0]?.len === 0 && one.rows[0]?.id === 'd' && one.rows[0]?.len === 1 && all.rows[0]?.paths === 2 && all.rows[0]?.shortest === 2 && all.rows[0]?.longest === 4
      && any.rows.length === 1 && any.rows[0].trail.length === 3 && through.rows.length === 1 && through.rows[0].current === false && stale.rows.length === 0 && !stale.error);
    db.free();
  }
  {
    const { db } = seeded();
    const env = JSON.parse(db.execute("MATCH p = (m:Memory {id: 'd'})-[:SUPERSEDES]->(o:Memory) RETURN p, [n IN nodes(p) | id(n)] AS ns, [r IN relationships(p) | id(r)] AS rs"));
    const p = env.rows[0].p;
    const shape = p.map((/** @type {any} */ x) => x.kind).join(', ');
    const joined = p[1].start_node === p[0].id && p[1].end_node === p[2].id;
    const ids = canon(env.rows[0].ns) === canon([p[0].id, p[2].id]) && canon(env.rows[0].rs) === canon([p[1].id]);
    const carried = Object.keys(p[0].properties.embedding ?? {}).sort().join(', ');
    probe('M7', 'a path arrives as a flat list (node, relationship, node), each node whole, vector included; id() gives the same integers', [
      `the path's elements: ${shape}`,
      `the relationship's start_node and end_node are its neighbours' ids: ${joined ? 'yes' : 'NO'}`,
      `id(n) and id(r) over nodes(p) and relationships(p) equal the elements' ids: ${ids ? 'yes' : 'NO'}`,
      `a node's vector in the envelope: {${carried}}, ${p[0].properties.embedding?.values?.length} values`,
    ], shape === 'node, relationship, node' && joined && ids && p[0].properties.embedding?.values?.length === DIMS);
    db.free();
  }

  say.push('', `## The embedding model's vectors (data/embeddings.json): ${MODEL.id} at ${MODEL.revision.slice(0, 7)}, ${MODEL.dtype}`);
  const cos = (/** @type {string} */ a, /** @type {string} */ b) => /** @type {number[]} */ (KNOWN.get(a)).reduce((sum, x, i) => sum + x * /** @type {number[]} */ (KNOWN.get(b))[i], 0);
  const norms = [...KNOWN.values()].map((v) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)));
  say.push(`${KNOWN.size} vectors of ${DIMS} numbers, each of length 1 (${Math.min(...norms).toFixed(3)} to ${Math.max(...norms).toFixed(3)})`);
  say.push(`content words of "What do you remember about the checkout rewrite?": ${contentWords('What do you remember about the checkout rewrite?').join(', ')}; the full-text query for it: ${JSON.stringify(terms('What do you remember about the checkout rewrite?'))}`);
  const pairs = /** @type {Array<[string, string, string]>} */ ([
    ['Is anyone unavailable in the coming days?', 'Tomás is away next week at a conference in Lisbon', 'meaning'],
    ['Who should I page about a billing outage?', 'Dana owns the payments service', 'meaning'],
    ['Can I refactor invoicing yet?', 'Do not change the billing module: it is frozen until the audit is done', 'meaning'],
    ['Who looks after sign-in?', 'Kenji owns the auth module: ask him before changing it', 'meaning'],
    ["I'm booking dinner for our first evening. Any dietary needs I should mention?", 'Maya is vegetarian', 'meaning'],
    ['Did we pick Postgres for checkout?', 'Use Postgres for the checkout rewrite', 'both'],
    ['Is anyone unavailable in the coming days?', 'Use Postgres for the checkout rewrite', 'neither'],
    ['Can I refactor invoicing yet?', 'Run the tests with pnpm test', 'neither'],
  ]);
  const floor = 2 * M.RECALL_DEFAULTS.floor - 1;
  for (const [a, b, kind] of pairs) {
    const c = cos(a, b);
    const shared = contentWords(a).filter((w) => contentWords(b).includes(w));
    say.push(`cosine ${c.toFixed(2)}  ${JSON.stringify(a)} / ${JSON.stringify(b)}: ${shared.length ? `shares ${shared.join(', ')}` : 'no shared word'}`);
    if ((kind === 'neither') !== (c < floor) || (kind === 'meaning' && shared.length)) pin(`the embedding model's vectors (${a} / ${b})`);
  }
  say.push(`A vector hit needs a cosine of at least ${floor.toFixed(2)} (the engine's score ${M.RECALL_DEFAULTS.floor}: M3). The first five pairs share no word and clear it:`);
  say.push('the full-text search cannot find them, the vector search does.');
  return `${say.join('\n')}\n`;
}

// ---- the ontology ------------------------------------------------------------------------------

/** Writes the store keeps to the graph type and the document forbids: what the tab's check is for. */
const BREAKS = [
  ['a replaced memory made current again', 'MATCH (m:Memory) WHERE NOT m.current SET m.current = true'],
  ['a property the document does not declare', "MATCH (e:Entity {key: 'dana'}) SET e.note = 'on holiday'"],
];
/** What the report and the browser section search the document for. */
const SEARCHES = ['decision', 'replaces', 'vector', 'source', 'conversation', 'memory kind', 'required date', 'slot', 'kubernetes'];

/** @param {any} mod @param {{ontology?: any}} replay */
async function ontologySection(mod, replay) {
  const file = 'data/agent-memory.ontology.json';
  const doc = readJson(file);
  const mine = O.own(doc);
  const nodes = /** @type {Record<string, any>} */ (doc.nodes);
  const rels = /** @type {Record<string, any>} */ (doc.relationships);
  const say = [`# Example 03: the memory model as an Ontology Graph Spec document (${file}, read by web/ontology.js)`, ''];
  say.push('What the specification\'s SDK says of the document, the document against the schema the engine holds');
  say.push('(web/memory.js SCHEMA), the rules the engine does not enforce against every store the conversations');
  say.push('build, what its questions return, and what the Ontology tab searches and draws.');
  const yes = (/** @type {boolean} */ ok, /** @type {string} */ what) => { if (!ok) pin(`the ontology: ${what}`); return ok ? 'yes' : 'NO'; };
  const same = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(a) === JSON.stringify(b);
  const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many) => `${n} ${n === 1 ? one : many}`;

  // ---- the document, and what the SDK makes of it
  const parts = O.outline(doc);
  const count = (/** @type {string} */ kind) => parts.filter((p) => p.kind === kind).length;
  const written = Object.values(nodes).flatMap((n) => Object.values(n.constraints ?? {}).map((c) => /** @type {any} */ (c).type));
  const tallyOf = (/** @type {string[]} */ xs) => [...new Set(xs)].sort().map((t) => `${xs.filter((x) => x === t).length} ${t}`).join(', ');
  say.push('', '## The document');
  say.push(`${doc.id}, version ${doc.version}: ${JSON.stringify(doc.name)} (${doc.schema})`);
  say.push(`${count('node')} labels, ${count('property')} properties, ${count('relationship')} relationship types, ${count('index')} indexes, ${count('invariant')} invariants, ${count('question')} questions`);
  say.push(`constraints as written: ${tallyOf(written)}; and must_exist on ${parts.filter((p) => p.kind === 'property' && p.def.must_exist).length} properties`);
  const sdkVersion = readJson('node_modules/@neo4j/ontology-graph-spec/package.json').version;
  // the document is JSON, so nothing here parses YAML: the SDK decodes it through lib/ogs.mjs (ADR-0007)
  const ogs = createOgs({ yaml: null, sdk, sdkVersion });
  say.push('', `### The specification's SDK (@neo4j/ontology-graph-spec ${sdkVersion}, through lib/ogs.mjs)`);
  for (const set of VALIDATION_SETS) {
    const r = ogs.validate(doc, [set]);
    say.push(`validation set ${set}: ${r.ok ? 'no issues' : r.issues.map((i) => `${i.code} at ${i.path}`).join('; ')}`);
    if (!r.ok) pin(`the ontology: the SDK's ${set} validation`);
  }
  const long = JSON.parse(ogs.encode(doc, 'json'));
  const decoded = Object.values(long.nodes).flatMap((n) => Object.values(/** @type {any} */ (n).constraints ?? {}).map((c) => /** @type {any} */ (c).type));
  say.push(`decoded, the shorthand becomes constraints: ${tallyOf(decoded)}`);
  say.push(`decoding the SDK's own encoding gives the same model again: ${yes(ogs.encode(long, 'json') === ogs.encode(doc, 'json'), 'the SDK round trip')}`);
  // The SDK's decoder ignores a field the specification does not have (S1), so a misspelt one would
  // pass every validation set. Its encoding keeps only what it understood: whatever of the written
  // document is missing from it must be shorthand (S2) or a default the encoder leaves out (S3).
  /** @type {Record<string, number>} */ const dropped = {};
  /** @type {string[]} */ const unexplained = [];
  const walk = (/** @type {any} */ a, /** @type {any} */ b, /** @type {string[]} */ at) => {
    if (a === null || typeof a !== 'object') { if (!same(a, b)) unexplained.push(`${at.join('/')} is ${JSON.stringify(a)}, the SDK has ${JSON.stringify(b)}`); return; }
    if (Array.isArray(a)) { if (!Array.isArray(b) || a.length !== b.length) unexplained.push(`${at.join('/')} is not the same list`); else a.forEach((x, i) => walk(x, b[i], [...at, String(i)])); return; }
    for (const k of Object.keys(a)) {
      if (b && typeof b === 'object' && k in b) { walk(a[k], b[k], [...at, k]); continue; }
      const node = at[0] === 'nodes' ? long.nodes[at[1]] : null;
      const why = k === 'label' && at.length === 2 && node?.labels?.identifier === a[k] ? 'label: shorthand for labels.identifier'
        : k === 'must_exist' && a[k] === true && at[2] === 'properties' && Object.values(node?.constraints ?? {}).some((c) => c.type === 'EXISTS' && same(c.properties, [at[3]])) ? 'must_exist: shorthand for an EXISTS constraint'
          : k === 'vector.similarity_function' && a[k] === 'cosine' ? 'vector.similarity_function: cosine is the default, which the encoder leaves out'
            : null;
      if (why) dropped[why] = (dropped[why] ?? 0) + 1; else unexplained.push(`${[...at, k].join('/')} is not a field of the specification`);
    }
  };
  walk(doc, long, []);
  say.push('fields of the document that the SDK\'s encoding of it does not have:');
  for (const why of Object.keys(dropped).sort()) say.push(`  ${dropped[why]} × ${why}`);
  say.push(`every other field is one the specification has: ${yes(unexplained.length === 0, `fields the specification does not have (${unexplained.slice(0, 3).join('; ')})`)}`);
  for (const u of unexplained) say.push(`  ${u}`);
  const texts = [...parts.filter((p) => ['node', 'property', 'relationship'].includes(p.kind)).map((p) => p.def.description ?? '')];
  say.push(`every label, property and relationship type has a description: ${yes(texts.every((t) => t.length > 0), 'a part without a description')} (${texts.length}; the longest is ${Math.max(...texts.map((t) => t.length))} characters of the 1024 allowed)`);

  // ---- the document and the engine
  say.push('', `## The document and the engine (Relate ${RELATE} WASM, after web/memory.js SCHEMA)`);
  const want = O.engineSchema(doc);
  {
    const { db } = openStore(mod);
    const cons = rw.exec(db, 'SHOW CONSTRAINTS').rows;
    const idx = rw.exec(db, 'SHOW INDEXES').rows;
    const of = (/** @type {string} */ t) => cons.filter((c) => c.type === t);
    const got = {
      types: of('NODE_PROPERTY_TYPE').map((c) => `${c.labelsOrTypes[0]}.${c.properties[0]} :: ${c.propertyType}`).sort(),
      exists: of('NODE_PROPERTY_EXISTENCE').map((c) => `${c.labelsOrTypes[0]}.${c.properties[0]}`).sort(),
      unique: of('NODE_PROPERTY_UNIQUENESS').map((c) => `${c.name} ${c.labelsOrTypes[0]}(${c.properties.join(', ')})`).sort(),
      sources: of('RELATIONSHIP_SOURCE_LABEL').map((c) => `${c.labelsOrTypes[0]} ${c.enforcedLabel}`).sort(),
      targets: of('RELATIONSHIP_TARGET_LABEL').map((c) => `${c.labelsOrTypes[0]} ${c.enforcedLabel}`).sort(),
      indexes: idx.filter((i) => i.type !== 'LOOKUP' && !i.owningConstraint).map((i) => `${i.name} ${i.type} ${i.labelsOrTypes.join(', ')}(${i.properties.join(', ')})`).sort(),
    };
    for (const [k, what] of /** @type {Array<[keyof typeof want, string]>} */ ([
      ['types', 'property types (PROPERTY_TYPE)'], ['exists', 'required properties (must_exist)'], ['unique', 'uniqueness constraints (UNIQUE), with their names'],
      ['sources', 'source labels (from)'], ['targets', 'target labels (to)'], ['indexes', 'search indexes, with their names'],
    ])) {
      say.push(`${what}: ${want[k].length} in the document, ${got[k].length} in the engine, the same: ${yes(same(want[k], got[k]), what)}`);
      if (k === 'unique' || k === 'indexes') for (const l of want[k]) say.push(`  ${l}`);
    }
    const described = Object.values(want).reduce((n, l) => n + l.length, 0) - want.indexes.length;
    say.push(`constraints the engine holds: ${cons.length}; described by the document: ${described}: ${yes(cons.length === described, 'an engine constraint the document does not describe')}`);
    const owned = idx.filter((i) => i.owningConstraint).map((i) => `${i.type} ${i.name}`).sort();
    say.push(`each uniqueness constraint owns a RANGE index of its own name, which the document therefore does not list: ${yes(same(owned, want.unique.map((u) => `RANGE ${u.split(' ')[0]}`)), 'the indexes the constraints own')}`);
    const vi = nodes.memory.extensions.indexes['memory-embedding'];
    const ddl = M.SCHEMA.find((s) => s.startsWith('CREATE VECTOR INDEX')) ?? '';
    say.push(`the vector index: ${vi.options['vector.dimensions']} dimensions, ${vi.options['vector.similarity_function']}, as the statement that creates it says: ${yes(vi.options['vector.dimensions'] === DIMS && nodes.memory.properties.embedding.dimension === DIMS && ddl.includes(`\`vector.dimensions\`: ${DIMS}`) && ddl.includes(`'${vi.options['vector.similarity_function']}'`), 'the vector index options')}`);
    const spec = rw.exec(db, 'SHOW CURRENT GRAPH TYPE YIELD specification RETURN specification AS s').rows[0].s;
    const derived = O.graphType(doc);
    say.push(`the graph type derived from the document (web/ontology.js graphType) is the engine's SHOW CURRENT GRAPH TYPE, byte for byte: ${yes(derived === spec, 'the derived graph type')}`);
    say.push(...derived.split('\n').map((l) => `  ${l}`));
    db.free();
  }

  // ---- the rules, against every store
  const list = O.rules(doc);
  const statements = list.reduce((n, r) => n + r.statements.length, 0);
  say.push('', '## The rules the engine does not enforce (web/ontology.js rules)');
  say.push(`${list.length} rules, ${statements} statements. Each statement returns the rule's violations, or the rows the rule is judged on:`);
  for (const r of list) {
    say.push(`${r.group.padEnd(10)} ${r.id}: ${r.says}`);
    for (const s of r.statements) say.push(`             ${s.text.replace(/\s+/g, ' ')}`);
  }
  /** @type {any} */ const forPage = { searches: {}, audit: [], questions: [], breaks: [] };
  say.push('', '### Every store the conversations build, after every turn');
  /** @type {Set<string>} */ const kinds = new Set();
  /** @type {Set<string>} */ const memoryKinds = new Set();
  /** @type {Array<{id: string, params: Record<string, any>, rows: any[]}>} */ let answers = [];
  /** @type {string[]} */ const bindings = [];
  for (const id of SCENARIOS) {
    const sc = readJson(`data/scenarios/${id}.json`);
    const { db, memory } = openStore(mod);
    const tools = /** @type {any} */ ({ ...memory, embed: embedder.embed });
    const check = () => O.audit(doc, (text, params) => memory.read('check', text, params).rows);
    let turns = 0;
    let held = 0;
    /** @type {string[]} */ const broken = [];
    const after = (/** @type {string} */ when) => {
      turns++;
      const bad = check().filter((r) => r.violations.length);
      if (bad.length) broken.push(`${when}: ${bad.map((r) => `${r.id} (${r.violations.join('; ')})`).join(', ')}`); else held++;
    };
    const steps = plan(sc);
    for (const step of steps) { await scriptedTurn(tools, step); after(`turn ${step.seq}`); }
    const scripted = turns;
    const snap = memory.snapshot();
    for (const n of snap.nodes) { if (n.label === 'Entity') kinds.add(n.props.kind); if (n.label === 'Memory') memoryKinds.add(n.props.kind); }
    // what each question returns here, with the parameters the tab would pick
    const asked = (mine.questions ?? []).map((/** @type {any} */ q) => {
      const { values } = O.bind(doc, q, snap);
      return { id: q.id, params: values, rows: memory.read('ask', q.cypher, values).rows };
    });
    bindings.push(`${id}: ${asked.map((a) => `${a.id}${Object.keys(a.params).length ? ` ${canon(a.params)}` : ''} ${plural(a.rows.length, 'row', 'rows')}`).join('; ')}`);
    if (id === 'team') {
      answers = asked;
      forPage.audit = check().map((r) => ({ id: r.id, violations: r.violations }));
      forPage.questions = asked;
      forPage.tally = O.tally(doc, snap);
      // then the writes the graph type allows and the document forbids, each on a store of its own
      for (const [what, statement] of BREAKS) {
        const other = openStore(mod);
        const t2 = /** @type {any} */ ({ ...other.memory, embed: embedder.embed });
        for (const step of steps) await scriptedTurn(t2, step);
        const stats = rw.exec(other.db, statement).stats;
        const bad = O.audit(doc, (text, params) => other.memory.read('check', text, params).rows).filter((r) => r.violations.length);
        forPage.breaks.push({ what, statement, changed: Object.values(stats ?? {}).some((n) => n > 0), broken: bad.map((r) => ({ id: r.id, violations: r.violations })) });
        other.db.free();
      }
      // and the turns nobody scripted
      let seq = steps.length;
      for (const text of [...TYPED, ...TYPED_WITHOUT_VECTOR]) {
        seq++;
        await freeTurn(tools, text, { session: { id: 'team-you', title: 'Your turn', startedAt: '2026-01-01T00:00:00Z' }, seq, at: '2026-01-01T00:00:00Z', messageId: `team-${seq}`, noteId: `note-${seq}` });
        after(`typed turn ${seq}`);
      }
      for (const n of memory.snapshot().nodes) if (n.label === 'Memory') memoryKinds.add(n.props.kind);
    }
    say.push(`${id}: ${scripted} scripted turns${turns > scripted ? ` and ${turns - scripted} typed` : ''}; every rule holds after each: ${yes(held === turns, `${id}: ${broken[0] ?? ''}`)} (${held} of ${turns})`);
    for (const b of broken) say.push(`  ${b}`);
    db.free();
  }
  say.push(`memory kinds stored: ${[...memoryKinds].sort().join(', ')}; the document's one_of names these and no other: ${yes(same([...memoryKinds].sort(), [...nodes.memory.properties.kind.one_of].sort()), 'Memory.kind one_of')}`);
  const listed = O.own(nodes.entity.properties.kind).used_by_the_scripts ?? [];
  say.push(`entity kinds the scripts use: ${[...kinds].sort().join(', ')}; the document lists the same: ${yes(same([...kinds].sort(), [...listed].sort()), 'the entity kinds the document lists')}`);
  say.push('', '### Writes the graph type allows and the document forbids (the team store after its scripted turns)');
  for (const b of forPage.breaks) {
    say.push(`${b.what}: ${b.statement}`);
    say.push(`  the engine accepts it: ${yes(b.changed, `the engine no longer accepts: ${b.statement}`)}; rules then broken: ${b.broken.length}`);
    for (const r of b.broken) say.push(`    ${r.id}: ${r.violations.join('; ')}`);
    if (!b.broken.length) pin(`the ontology: no rule catches ${b.what}`);
  }

  // ---- the questions
  say.push('', '## The questions the document lists (the team store after its scripted turns)');
  for (const a of answers) {
    const q = mine.questions.find((/** @type {any} */ x) => x.id === a.id);
    say.push(`${a.id}: ${q.question}${Object.keys(a.params).length ? ` ${canon(a.params)}` : ''}`);
    for (const r of a.rows) say.push(`  ${canon(r)}`);
    if (!a.rows.length) say.push('  no rows');
  }
  say.push('', 'The parameters the tab picks on each store (web/ontology.js bind), and how many rows come back:');
  say.push(...bindings);

  // ---- what the tab searches and draws
  say.push('', '## Search (web/ontology.js search): the parts that hold every word, best first');
  for (const text of SEARCHES) {
    const hits = O.search(doc, text);
    forPage.searches[text] = hits.map((h) => h.key);
    say.push(`${JSON.stringify(text)}: ${hits.length ? hits.slice(0, 6).map((h) => `${h.title.length > 44 ? `${h.title.slice(0, 43)}…` : h.title} (${h.kind}, ${h.where})`).join(' | ') : 'nothing'}${hits.length > 6 ? ` | and ${hits.length - 6} more` : ''}`);
  }
  say.push('', '## The picture (web/ontology.js picture): where the tab draws each label, and a label\'s properties around it');
  const apart = (/** @type {ReturnType<typeof O.picture>} */ pic) => pic.nodes.every((a, i) => pic.nodes.every((b, j) => i >= j || Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r));
  const base = O.picture(doc);
  say.push(`labels: ${base.nodes.map((n) => `${n.caption} (${n.x}, ${n.y})`).join(', ')}; relationship types: ${base.rels.map((r) => r.caption).join(', ')}`);
  for (const nid of Object.keys(nodes)) {
    const pic = O.picture(doc, { expanded: nid });
    const props = pic.nodes.filter((n) => n.kind === 'property');
    say.push(`${O.labelOf(nodes[nid])} opened: ${props.length} properties (${props.map((p) => `${p.caption}${p.required ? '' : '?'}`).join(', ')}); no two circles overlap: ${yes(apart(pic) && props.length === Object.keys(nodes[nid].properties).length, `the picture of ${nid}`)}`);
  }
  forPage.picture = { nodes: base.nodes.length, rels: base.rels.length, opened: Object.fromEntries(Object.keys(nodes).map((nid) => [nid, O.picture(doc, { expanded: nid }).nodes.length])) };
  forPage.graphType = O.graphType(doc);

  // ---- what the document says about the page and the code
  say.push('', '## What the document says about the page');
  const graph = fs.readFileSync(path.join(EX, 'web/graph.js'), 'utf8');
  const css = fs.readFileSync(path.join(EX, 'web/style.css'), 'utf8');
  const dark = css.slice(css.indexOf('color-scheme: dark'), css.indexOf('@media (prefers-color-scheme: light)'));
  const g = (/** @type {string} */ name) => new RegExp(`--g-${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(dark)?.[1];
  const groups = Object.fromEntries([...graph.slice(graph.indexOf('const GROUPS'), graph.indexOf('export const kindGroup')).matchAll(/(\w+): '(\w+)'/g)].map((m) => [m[1], m[2]]));
  const kc = O.own(nodes.entity.properties.kind);
  say.push(`the colour group of each entity kind is web/graph.js GROUPS: ${yes(same(groups, kc.colour_groups) && graph.includes(`?? '${kc.any_other_kind}'`), 'the entity kind colour groups')}`);
  const d = (/** @type {string} */ nid) => nodes[nid].extensions.display;
  const od = (/** @type {string} */ nid) => O.own(d(nid));
  say.push(`each node's colour is the dark theme's in web/style.css: ${yes(d('entity').colour === g('person') && d('memory').colour === g('memory') && od('memory').colour_when_replaced === g('memory-old') && d('message').colour === g('message') && d('session').colour === g('session')
    && same(od('entity').colour_by_group, Object.fromEntries(['person', 'place', 'tech', 'topic', 'thing'].map((k) => [k, g(k)]))), 'the display colours')} (${Object.keys(nodes).map((nid) => `${O.labelOf(nodes[nid])} ${d(nid).colour}`).join(', ')})`);
  const drawn = (/const EDGES = new Set\(\[([^\]]+)\]/.exec(graph)?.[1] ?? '').replace(/'/g, '').split(', ').sort();
  say.push(`the relationship types it says are drawn are web/graph.js EDGES: ${yes(same(drawn, Object.values(rels).filter((r) => !String(O.own(r).drawn).startsWith('never')).map((r) => r.type).sort()), 'the relationship types drawn')} (${drawn.join(', ')})`);
  const em = O.own(nodes.memory.properties.embedding);
  const worker = fs.readFileSync(path.join(EX, 'web/embed.worker.js'), 'utf8');
  say.push(`the embedding model is web/embed.js MODEL, pooled and normalised as the worker asks: ${yes(em.model === MODEL.id && em.quantisation === MODEL.dtype && worker.includes(`pooling: '${em.pooling}', normalize: ${em.normalised}`), 'the embedding model facts')} (${em.model}, ${em.quantisation}, ${em.pooling}, normalised)`);
  const named = Object.values(/** @type {Record<string, any>} */ (mine.tools)).flatMap((t) => t.statements);
  say.push(`every statement a tool names is one web/memory.js exports: ${yes(named.every((n) => typeof /** @type {any} */ (M)[n] === 'string'), 'the statements the tools name')} (${named.join(', ')})`);
  const writtenBy = Object.values(rels).map((r) => [r.type, O.own(r).written_by]);
  say.push(`each relationship type is MERGEd by the statement the document names: ${yes(writtenBy.every(([t, s]) => new RegExp(`MERGE \\([^)]*\\)-\\[:${t}\\]->`).test(/** @type {any} */ (M)[s] ?? '')), 'written_by')} (${writtenBy.map(([t, s]) => `${t} by ${s}`).join(', ')})`);
  const ids = /** @type {Record<string, string[]>} */ ({ nodes: Object.keys(nodes), relationships: Object.keys(rels), indexes: Object.keys(nodes.memory.extensions.indexes) });
  say.push(`the labels, relationship types and indexes the tools say they read and write are the document's own: ${yes(Object.values(/** @type {Record<string, any>} */ (mine.tools)).every((t) => Object.entries({ ...t.reads, ...t.writes }).every(([k, xs]) => /** @type {string[]} */ (xs).every((x) => ids[k].includes(x)))), 'the ids the tools name')}`);
  replay.ontology = forPage;
  return `${say.join('\n')}\n`;
}

// ---- main --------------------------------------------------------------------------------------

const opts = args(process.argv.slice(2));
fs.mkdirSync(opts.out, { recursive: true });
const mod = await rw.loadNode(RELATE);
const write = (/** @type {string} */ name, /** @type {string} */ text) => fs.writeFileSync(path.join(opts.out, name), text);
/** @type {{relate: string, schema: string[], queries: any[], turns: Record<string, any[]>, ontology?: any}} */
const replay = { relate: RELATE, schema: M.SCHEMA, queries: [], turns: {} };
if (opts.only.includes('statements')) write('statements.cypher', statementsSection());
if (opts.only.includes('scenarios')) write('scenarios.txt', await scenariosSection(mod, replay));
if (opts.only.includes('typed')) write('typed.txt', await typedSection(mod));
if (opts.only.includes('probes')) write('probes.txt', probesSection(mod));
if (opts.only.includes('ontology')) write('ontology.txt', await ontologySection(mod, replay));
if (opts.only.includes('scenarios')) write('replay.json', `${JSON.stringify(replay)}\n`);
process.exitCode = failed ? 1 : 0;
