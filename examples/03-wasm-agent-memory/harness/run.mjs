#!/usr/bin/env node
// @ts-check
/**
 * harness/run.mjs: example 03's Node sections. From the example's directory:
 *
 *   node harness/run.mjs [--out out] [--only statements,scenarios,typed,probes]
 *
 * Each section writes one deterministic report into --out (no timestamps, paths, timings or engine
 * ids), which run.sh diffs against expected/:
 *
 *   statements.cypher  the memory's schema and the statement behind each tool (web/memory.js), as
 *                      the page runs them
 *   scenarios.txt      every scripted conversation (data/scenarios/*.json) through web/agent.js and
 *                      web/memory.js on Relate 1.2.0 WASM, exactly as the page runs them: each tool
 *                      call's rows (how each memory was reached, its score and its trail), what was
 *                      stored, the reply and its citations; then the same writes replayed, which
 *                      must change nothing
 *   typed.txt          turns nobody scripted (web/agent.js freeTurn): which tool the rules pick,
 *                      and the reply assembled from what it returned
 *   probes.txt         M1...: the Relate 1.2.0 behaviours the example depends on, each a minimal
 *                      repro (NOTES.md has one row per probe); and what the embedding model's
 *                      vectors (data/embeddings.json) say about a few pairs of texts
 *
 * It also writes out/replay.json (not diffed): the schema and every statement the scenarios ran,
 * with its parameters and rows, for harness/native.py (the same statements on native Relate), and
 * each turn's outcome, for harness/drive.mjs (the same turns in the page).
 *
 * A reply that cites a memory its tool did not return, or a probe that stops reproducing, prints
 * `PIN: <what> changed` on stderr and the run exits 1 (after writing every report, so the diff shows
 * what moved).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as rw from '../../../lib/relate_wasm.mjs';
import { freeTurn, mergePaths, plan, scriptedTurn } from '../web/agent.js';
import { DIMS, MODEL, contentWords, createEmbedder, precomputed, terms } from '../web/embed.js';
import * as M from '../web/memory.js';
import { TYPED, TYPED_WITHOUT_VECTOR } from './typed.mjs';

const EX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELATE = M.RELATE;
const SECTIONS = ['statements', 'scenarios', 'typed', 'probes'];
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
    const marks = q('who (really) reviews? a:b "x" -y +z ~ *');
    const empty = q('');
    probe('M4', 'SEARCH on a full-text index: terms are ORed and matched whole, with no stemming; punctuation is harmless; an empty query finds nothing', [
      `"tests": ${tests.rows.map((r) => r.id).join(', ')}`,
      `"test": ${test.rows.map((r) => r.id).join(', ')} (the same memory holds both words; "tests" alone would not match "test")`,
      `"kenji bun": ${either.rows.map((r) => r.id).join(', ')}`,
      `a query full of punctuation: ${marks.error ?? marks.rows.map((r) => r.id).join(', ')}`,
      `an empty query: ${empty.error ?? `${empty.rows.length} rows`}`,
    ], tests.rows.map((r) => r.id).join() === 'a' && test.rows.map((r) => r.id).join() === 'a' && either.rows.length === 2 && !marks.error && marks.rows.length >= 1 && empty.rows.length === 0 && !empty.error);
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

// ---- main --------------------------------------------------------------------------------------

const opts = args(process.argv.slice(2));
fs.mkdirSync(opts.out, { recursive: true });
const mod = await rw.loadNode(RELATE);
const write = (/** @type {string} */ name, /** @type {string} */ text) => fs.writeFileSync(path.join(opts.out, name), text);
/** @type {{relate: string, schema: string[], queries: any[], turns: Record<string, any[]>}} */
const replay = { relate: RELATE, schema: M.SCHEMA, queries: [], turns: {} };
if (opts.only.includes('statements')) write('statements.cypher', statementsSection());
if (opts.only.includes('scenarios')) {
  write('scenarios.txt', await scenariosSection(mod, replay));
  write('replay.json', `${JSON.stringify(replay)}\n`);
}
if (opts.only.includes('typed')) write('typed.txt', await typedSection(mod));
if (opts.only.includes('probes')) write('probes.txt', probesSection(mod));
process.exitCode = failed ? 1 : 0;
