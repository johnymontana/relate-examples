// @ts-check
/**
 * memory.js: an agent's memory as a graph in Relate 1.2.0, and the statements that write and read it.
 *
 * The engine worker (the page) and harness/run.mjs (Node) both call createMemory(db, exec), so the
 * page runs exactly the statements the regression run checks. Nothing here touches the DOM.
 *
 * The model (NOTES.md D2, ADR-0016), after Relate's own agent-memory recipes:
 *
 *   (:Message)-[:IN_SESSION]->(:Session)      what was said, and in which conversation
 *   (:Message)-[:MENTIONS]->(:Entity)         the people, projects, places a message names
 *   (:Memory)-[:FROM]->(:Message)             a fact, decision, preference or note, and where it came from
 *   (:Memory)-[:ABOUT]->(:Entity)             what it is about: a memory links the entities it names
 *   (:Memory)-[:SUPERSEDES]->(:Memory)        a newer memory in the same slot; nothing is deleted
 *
 * A graph type (SCHEMA[0]) makes that shape the engine's contract: a memory without its text, an
 * edge between the wrong labels, a vector of the wrong length are all refused (M1).
 *
 * Vectors are given to the tools, not made here (embed.js says where they come from): remember
 * takes each memory's, recall the question's. A memory or a question without one still works,
 * by its words alone.
 *
 * The tools, each a fixed statement with parameters:
 *   remember   three idempotent writes: the message and its entities, the memories, the supersessions
 *   recall     one read: vector search (by meaning) and full-text search (by words) fused by
 *              reciprocal rank, each hit followed to its current version and then out through
 *              shared entities
 *   connect    one read: the shortest chain of current memories between two entities
 *   trace      one read: a memory's source message and session, for each version in its history
 *   snapshot   what the page draws: every node and relationship (vectors left out)
 */
import { DIMS, terms, words } from './embed.js';

export const RELATE = '1.2.0';

/** The entity key for a name: its folded words ("Tomás" -> "tomas"), so a name matches however it is typed. @param {string} name */
export const entityKey = (name) => words(name).join(' ');

/** The graph type first (it owns the existence constraints on its labels, and an ALTER drops the others: example 02's P1, P2), then keys and the two search indexes. */
export const SCHEMA = [
  `ALTER CURRENT GRAPH TYPE SET {
  (:Session => {id :: STRING NOT NULL, title :: STRING NOT NULL, startedAt :: ZONED DATETIME NOT NULL}),
  (:Message => {id :: STRING NOT NULL, seq :: INTEGER NOT NULL, role :: STRING NOT NULL,
                text :: STRING NOT NULL, at :: ZONED DATETIME NOT NULL}),
  (:Entity => {key :: STRING NOT NULL, name :: STRING NOT NULL, kind :: STRING NOT NULL}),
  (:Memory => {id :: STRING NOT NULL, kind :: STRING NOT NULL, text :: STRING NOT NULL,
               gist :: STRING NOT NULL, slot :: STRING NOT NULL, seq :: INTEGER NOT NULL,
               at :: ZONED DATETIME NOT NULL, current :: BOOLEAN NOT NULL,
               rationale :: STRING, supersededAt :: ZONED DATETIME,
               embedding :: VECTOR<FLOAT32>(${DIMS})}),
  (:Message)-[:IN_SESSION]->(:Session),
  (:Message)-[:MENTIONS]->(:Entity),
  (:Memory)-[:FROM]->(:Message),
  (:Memory)-[:ABOUT]->(:Entity),
  (:Memory)-[:SUPERSEDES]->(:Memory)
}`,
  'CREATE CONSTRAINT session_id FOR (s:Session) REQUIRE s.id IS UNIQUE',
  'CREATE CONSTRAINT message_id FOR (m:Message) REQUIRE m.id IS UNIQUE',
  'CREATE CONSTRAINT entity_key FOR (e:Entity) REQUIRE e.key IS UNIQUE',
  'CREATE CONSTRAINT memory_id FOR (m:Memory) REQUIRE m.id IS UNIQUE',
  `CREATE VECTOR INDEX memory_embedding FOR (m:Memory) ON (m.embedding)
  OPTIONS {indexConfig: {\`vector.dimensions\`: ${DIMS}, \`vector.similarity_function\`: 'cosine'}}`,
  'CREATE FULLTEXT INDEX memory_text FOR (m:Memory) ON EACH [m.text]',
];

/** remember, statement 1: the session, the message, and every entity it mentions. */
export const REMEMBER_MESSAGE = `MERGE (s:Session {id: $session.id})
  ON CREATE SET s.title = $session.title, s.startedAt = datetime($session.startedAt)
MERGE (msg:Message {id: $message.id})
  ON CREATE SET msg.seq = $message.seq, msg.role = 'user', msg.text = $message.text,
                msg.at = datetime($message.at)
MERGE (msg)-[:IN_SESSION]->(s)
WITH msg
UNWIND $entities AS ent
MERGE (e:Entity {key: ent.key})
  ON CREATE SET e.name = ent.name, e.kind = ent.kind
MERGE (msg)-[:MENTIONS]->(e)
RETURN count(e) AS entities`;

/** remember, statement 2: each memory, with its vector when it has one, linked FROM the message and ABOUT its entities. */
export const REMEMBER_MEMORIES = `MATCH (msg:Message {id: $message.id})
UNWIND $memories AS mem
MERGE (m:Memory {id: mem.id})
  ON CREATE SET m.kind = mem.kind, m.text = mem.text, m.gist = mem.gist, m.slot = mem.slot,
                m.rationale = mem.rationale, m.seq = msg.seq, m.at = msg.at, m.current = true,
                m.embedding = CASE WHEN mem.embedding IS NULL THEN null
                                   ELSE vector([x IN mem.embedding | toFloat(x)], ${DIMS}, FLOAT32) END
MERGE (m)-[:FROM]->(msg)
WITH m, mem
CALL (m, mem) {
  UNWIND mem.about AS key
  MATCH (e:Entity {key: key})
  MERGE (m)-[:ABOUT]->(e)
  RETURN count(e) AS linked
}
RETURN count(m) AS memories, sum(linked) AS links`;

/** remember, statement 3: a new memory replaces the current one in its slot, which stays as history. */
export const REMEMBER_SUPERSEDE = `MATCH (new:Memory)-[:FROM]->(:Message {id: $message.id})
WHERE new.slot <> ''
CALL (new) {
  MATCH (old:Memory {slot: new.slot})
  WHERE old.current AND old.seq < new.seq
  RETURN old ORDER BY old.seq DESC, old.id LIMIT 1
}
SET old.current = false, old.supersededAt = new.at
MERGE (new)-[:SUPERSEDES]->(old)
RETURN count(old) AS superseded`;

/**
 * recall: one statement.
 *   1. Two searches over every memory, current or not. The vector index finds the memories whose
 *      meaning is closest to the question's (kept when the similarity is at least $floor); the
 *      full-text index finds the ones that share its words. Each list is ranked, and the two are
 *      fused by reciprocal rank, so a memory both searches find comes first.
 *   2. Each of the best $k follows SUPERSEDES back to the memory that is current now: the search
 *      may find what used to be true, and the graph knows what replaced it.
 *   3. From there, out through shared entities, up to two entities away, over current memories
 *      only. A linked memory scores half its seed's score per entity crossed.
 * Every row says how its seed was found (`by`: meaning, words or both; `similarity`: the cosine
 * when by meaning) and carries the path that reached it (node and relationship ids, and a readable
 * trail) and the entities the memory is about: that is what the page highlights.
 */
export const RECALL = `CALL () {
  MATCH (m:Memory)
  SEARCH m IN (VECTOR INDEX memory_embedding
               FOR vector([x IN $vector | toFloat(x)], ${DIMS}, FLOAT32) LIMIT $k) SCORE AS similarity
  WHERE similarity >= $floor
  WITH m, similarity ORDER BY similarity DESC, m.id
  WITH collect({m: m, similarity: similarity}) AS found
  UNWIND range(0, size(found) - 1) AS i
  RETURN found[i].m AS seed, i + 1 AS rank, 'meaning' AS by, found[i].similarity AS similarity
  UNION ALL
  MATCH (m:Memory)
  SEARCH m IN (FULLTEXT INDEX memory_text FOR $terms LIMIT $k) SCORE AS bm25
  WITH m ORDER BY bm25 DESC, m.id
  WITH collect(m) AS found
  UNWIND range(0, size(found) - 1) AS i
  RETURN found[i] AS seed, i + 1 AS rank, 'words' AS by, null AS similarity
}
WITH seed, sum(1.0 / (60 + rank)) AS rrf, collect(by) AS by, max(similarity) AS similarity
ORDER BY rrf DESC, seed.id LIMIT $k
MATCH history = (seed)<-[:SUPERSEDES]-*(now:Memory WHERE now.current)
CALL (now, history) {
  RETURN now AS hit, 0 AS hops, nodes(history) AS ns, relationships(history) AS rs
  UNION ALL
  MATCH link = ANY SHORTEST
    (now) (()-[:ABOUT]->(:Entity)<-[:ABOUT]-(x:Memory WHERE x.current)){1,2} (hit:Memory)
  WHERE hit <> now
  RETURN hit, length(link) / 2 AS hops,
         nodes(history) + tail(nodes(link)) AS ns, relationships(history) + relationships(link) AS rs
}
WITH hit, hops, ns, rs, seed <> now AS stale, rrf * (0.5 ^ hops) AS score, by, similarity
ORDER BY score DESC, hops, size(ns), ns[0].id
WITH hit, collect({score: score, hops: hops, stale: stale, ns: ns, rs: rs, by: by, similarity: similarity})[0] AS best
ORDER BY best.score DESC, hit.seq DESC, hit.id LIMIT $limit
RETURN hit.id AS id, hit.kind AS kind, hit.gist AS gist, hit.text AS text, hit.rationale AS rationale,
       CASE WHEN best.hops > 0 THEN 'graph' WHEN best.stale THEN 'update' ELSE 'search' END AS via,
       best.by AS by, round(2 * best.similarity - 1, 2) AS similarity,
       best.hops AS hops, round(best.score, 4) AS score,
       [n IN best.ns | id(n)] AS nodes, [r IN best.rs | id(r)] AS rels,
       [n IN best.ns | coalesce(n.name, n.gist)] AS trail,
       [n IN best.ns WHERE n:Entity | n.name] AS through,
       COLLECT { MATCH (hit)-[a:ABOUT]->(e:Entity)
                 RETURN {name: e.name, node: id(e), rel: id(a)} ORDER BY e.name } AS about,
       COLLECT { MATCH (hit)-[:SUPERSEDES]->+(old) RETURN old.text ORDER BY old.seq DESC, old.id } AS replaced,
       head([(hit)-[:FROM]->(:Message)-[:IN_SESSION]->(s:Session) | s.title]) AS session`;

/** connect: the shortest chain of current memories between two entities. */
export const CONNECT = `MATCH (a:Entity {key: $from}), (b:Entity {key: $to})
MATCH chain = ANY SHORTEST
  (a) (()<-[:ABOUT]-(m:Memory WHERE m.current)-[:ABOUT]->()){1,6} (b)
RETURN [n IN nodes(chain) | id(n)] AS nodes, [r IN relationships(chain) | id(r)] AS rels,
       [n IN nodes(chain) | coalesce(n.name, n.gist)] AS trail,
       [n IN nodes(chain) WHERE n:Memory | n {.id, .kind, .gist, .text}] AS memories,
       length(chain) / 2 AS hops`;

/** trace: where a memory came from, for it and for every version it replaced. */
export const TRACE = `MATCH (m:Memory {id: $id})
MATCH history = (m)-[:SUPERSEDES]->*(version:Memory)
MATCH source = (version)-[:FROM]->(msg:Message)-[:IN_SESSION]->(s:Session)
RETURN version.id AS id, version.kind AS kind, version.gist AS gist, version.text AS text,
       version.current AS current, msg.text AS said, s.title AS session, toString(msg.at) AS at,
       [n IN nodes(history) + tail(nodes(source)) | id(n)] AS nodes,
       [r IN relationships(history) + relationships(source) | id(r)] AS rels,
       [n IN nodes(history) + tail(nodes(source)) | coalesce(n.name, n.gist, n.title, 'message ' + toString(n.seq))] AS trail
ORDER BY version.seq DESC, id`;

/** The entities a text names: whole-word matches of an entity's key in the folded text. */
export const ENTITIES_NAMED = `MATCH (e:Entity)
WHERE $text CONTAINS ' ' + e.key + ' '
RETURN e.key AS key, e.name AS name, e.kind AS kind
ORDER BY size(e.key) DESC, key`;

/** snapshot: every node, without its vector (only whether it has one), and every relationship. */
export const SNAPSHOT_NODES = `MATCH (n)
RETURN id(n) AS id, labels(n)[0] AS label,
       n {.id, .key, .name, .kind, .title, .role, .seq, .text, .gist, .slot, .rationale, .current,
          at: toString(n.at), startedAt: toString(n.startedAt), supersededAt: toString(n.supersededAt),
          embedded: n.embedding IS NOT NULL} AS props
ORDER BY id`;
export const SNAPSHOT_RELS = `MATCH (a)-[r]->(b)
RETURN id(r) AS id, type(r) AS type, id(a) AS source, id(b) AS target
ORDER BY id`;

/**
 * Defaults for recall: seeds per search, rows returned, and the similarity a vector hit needs. The
 * engine's score is (1 + cosine) / 2 (M3): 0.6 is a cosine of 0.2, above what all-MiniLM-L6-v2 gives
 * two unrelated sentences and below what it gives a question and the memory that answers it (D3).
 */
export const RECALL_DEFAULTS = Object.freeze({ k: 4, limit: 8, floor: 0.6 });

/** Parameters as the page and the reports show them: a vector becomes a one-line summary. @param {any} v @returns {any} */
export function displayParams(v) {
  if (Array.isArray(v)) {
    if (v.length === DIMS && v.every((x) => typeof x === 'number')) {
      return v.some((x) => x !== 0) ? `<a vector of ${DIMS} numbers>` : `<no vector: ${DIMS} zeros>`;
    }
    return v.map(displayParams);
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, displayParams(x)]));
  return v;
}

/** Drop a map's null values (a snapshot's projection names every property of every label). @param {Record<string, any>} o */
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

/**
 * @typedef {{name: string, kind: string}} EntityIn
 * @typedef {{id: string, kind: string, text: string, gist: string, slot?: string, about: string[], rationale?: string, embedding?: number[]|null}} MemoryIn
 * @typedef {{tool: string, write: boolean, statement: string, params: Record<string, any>, stats: Record<string, number>, rows: any[], error: string|null}} Call
 */

/**
 * The memory tools over one database handle.
 * @param {any} db  a RelateDb
 * @param {(db: any, query: string, params?: object|null, opts?: object) => {columns: string[], rows: any[], stats: Record<string, number>}} exec  lib/relate_wasm.mjs exec
 * @param {{onCall?: (call: Call) => void}} [opts]  onCall sees every statement the tools run, in order
 */
export function createMemory(db, exec, { onCall } = {}) {
  /** write: null lets the result's counters say (the console). @param {string} tool @param {boolean|null} write @param {string} statement @param {Record<string, any>} [params] */
  const run = (tool, write, statement, params = {}) => {
    let res;
    try {
      res = exec(db, statement, params, { allowNull: true });
    } catch (err) {
      // a statement the engine refused is still a statement that ran: the log shows it, with the refusal
      onCall?.({ tool, write: write ?? false, statement, params, stats: {}, rows: [], error: String(/** @type {any} */ (err)?.message ?? err) });
      throw err;
    }
    onCall?.({ tool, write: write ?? Object.values(res.stats ?? {}).some((n) => n > 0), statement, params, stats: res.stats, rows: res.rows, error: null });
    return res;
  };

  return {
    /** Apply the graph type, the keys and the search indexes to an empty store. */
    schema() {
      for (const s of SCHEMA) run('schema', true, s);
      return { statements: SCHEMA.length };
    },

    /**
     * Store one message and what was extracted from it, each memory with its vector when the
     * caller has one. Idempotent: every write is a MERGE, and a supersession that already happened
     * matches nothing (ADR-0006).
     * @param {{session: {id: string, title: string, startedAt: string},
     *          message: {id: string, seq: number, text: string, at: string},
     *          entities: EntityIn[], memories: MemoryIn[]}} input
     */
    remember({ session, message, entities, memories }) {
      const ents = entities.map((e) => ({ key: entityKey(e.name), name: e.name, kind: e.kind }));
      const mems = memories.map((m) => ({
        id: m.id, kind: m.kind, text: m.text, gist: m.gist, slot: m.slot ?? '', rationale: m.rationale ?? null,
        about: m.about.map(entityKey), embedding: m.embedding ?? null,
      }));
      const a = run('remember', true, REMEMBER_MESSAGE, { session, message, entities: ents });
      const b = mems.length ? run('remember', true, REMEMBER_MEMORIES, { message: { id: message.id }, memories: mems }) : null;
      const c = mems.some((m) => m.slot) ? run('remember', true, REMEMBER_SUPERSEDE, { message: { id: message.id } }) : null;
      return {
        entities: a.rows[0]?.entities ?? 0,
        memories: b?.rows[0]?.memories ?? 0,
        links: b?.rows[0]?.links ?? 0,
        superseded: c?.rows[0]?.superseded ?? 0,
      };
    },

    /**
     * What the memory holds on a question: [] when the question has neither a vector nor a
     * content word. Without a vector the vector search finds nothing (a zero vector: M3) and the
     * full-text search carries on.
     * @param {{question: string, vector?: number[]|null, k?: number, limit?: number, floor?: number}} input
     */
    recall({ question, vector = null, k = RECALL_DEFAULTS.k, limit = RECALL_DEFAULTS.limit, floor = RECALL_DEFAULTS.floor }) {
      const t = terms(question);
      if (!t && !vector) return [];
      const rows = run('recall', false, RECALL, { vector: vector ?? new Array(DIMS).fill(0), terms: t, k, limit, floor }).rows;
      for (const r of rows) r.by = [...r.by].sort();   // collect() keeps no order worth relying on
      return rows;
    },

    /** The shortest chain of current memories between two entities, or null. @param {{from: string, to: string}} input */
    connect({ from, to }) {
      return run('connect', false, CONNECT, { from: entityKey(from), to: entityKey(to) }).rows[0] ?? null;
    },

    /** A memory's source, and that of each version it replaced (newest first). @param {{id: string}} input */
    trace({ id }) {
      return run('trace', false, TRACE, { id }).rows;
    },

    /** The entities whose names appear in a text, longest name first. @param {string} text */
    entitiesNamed(text) {
      return run('entities', false, ENTITIES_NAMED, { text: ` ${words(text).join(' ')} ` }).rows;
    },

    /** Every node and relationship, for the page to draw. */
    snapshot() {
      const nodes = exec(db, SNAPSHOT_NODES).rows.map((r) => ({ id: r.id, label: r.label, props: compact(r.props) }));
      const rels = exec(db, SNAPSHOT_RELS).rows;
      return { nodes, rels };
    },

    /** Any statement, as the "Under the hood" console runs it. @param {string} cypher */
    query(cypher) {
      return run('console', null, cypher);
    },
  };
}
