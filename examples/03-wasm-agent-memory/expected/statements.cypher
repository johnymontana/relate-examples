// Example 03: the statements behind the page (web/memory.js), written by harness/run.mjs.
// The schema, applied to an empty store in this order; then one block per tool.

// ---- schema ----
ALTER CURRENT GRAPH TYPE SET {
  (:Session => {id :: STRING NOT NULL, title :: STRING NOT NULL, startedAt :: ZONED DATETIME NOT NULL}),
  (:Message => {id :: STRING NOT NULL, seq :: INTEGER NOT NULL, role :: STRING NOT NULL,
                text :: STRING NOT NULL, at :: ZONED DATETIME NOT NULL}),
  (:Entity => {key :: STRING NOT NULL, name :: STRING NOT NULL, kind :: STRING NOT NULL}),
  (:Memory => {id :: STRING NOT NULL, kind :: STRING NOT NULL, text :: STRING NOT NULL,
               gist :: STRING NOT NULL, slot :: STRING NOT NULL, seq :: INTEGER NOT NULL,
               at :: ZONED DATETIME NOT NULL, current :: BOOLEAN NOT NULL,
               rationale :: STRING, supersededAt :: ZONED DATETIME,
               embedding :: VECTOR<FLOAT32>(256) NOT NULL}),
  (:Message)-[:IN_SESSION]->(:Session),
  (:Message)-[:MENTIONS]->(:Entity),
  (:Memory)-[:FROM]->(:Message),
  (:Memory)-[:ABOUT]->(:Entity),
  (:Memory)-[:SUPERSEDES]->(:Memory)
};

CREATE CONSTRAINT session_id FOR (s:Session) REQUIRE s.id IS UNIQUE;

CREATE CONSTRAINT message_id FOR (m:Message) REQUIRE m.id IS UNIQUE;

CREATE CONSTRAINT entity_key FOR (e:Entity) REQUIRE e.key IS UNIQUE;

CREATE CONSTRAINT memory_id FOR (m:Memory) REQUIRE m.id IS UNIQUE;

CREATE VECTOR INDEX memory_embedding FOR (m:Memory) ON (m.embedding)
  OPTIONS {indexConfig: {`vector.dimensions`: 256, `vector.similarity_function`: 'cosine'}};

CREATE FULLTEXT INDEX memory_text FOR (m:Memory) ON EACH [m.text];

// ---- remember (1 of 3): the session, the message, the entities it mentions ----
MERGE (s:Session {id: $session.id})
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
RETURN count(e) AS entities;

// ---- remember (2 of 3): the memories, each with its vector, its source and what it is about ----
MATCH (msg:Message {id: $message.id})
UNWIND $memories AS mem
MERGE (m:Memory {id: mem.id})
  ON CREATE SET m.kind = mem.kind, m.text = mem.text, m.gist = mem.gist, m.slot = mem.slot,
                m.rationale = mem.rationale, m.seq = msg.seq, m.at = msg.at, m.current = true,
                m.embedding = vector([x IN mem.embedding | toFloat(x)], 256, FLOAT32)
MERGE (m)-[:FROM]->(msg)
WITH m, mem
CALL (m, mem) {
  UNWIND mem.about AS key
  MATCH (e:Entity {key: key})
  MERGE (m)-[:ABOUT]->(e)
  RETURN count(e) AS linked
}
RETURN count(m) AS memories, sum(linked) AS links;

// ---- remember (3 of 3): a new memory replaces the current one in its slot ----
MATCH (new:Memory)-[:FROM]->(:Message {id: $message.id})
WHERE new.slot <> ''
CALL (new) {
  MATCH (old:Memory {slot: new.slot})
  WHERE old.current AND old.seq < new.seq
  RETURN old ORDER BY old.seq DESC, old.id LIMIT 1
}
SET old.current = false, old.supersededAt = new.at
MERGE (new)-[:SUPERSEDES]->(old)
RETURN count(old) AS superseded;

// ---- recall: hybrid search, then the graph ----
CALL () {
  MATCH (m:Memory)
  SEARCH m IN (VECTOR INDEX memory_embedding
               FOR vector([x IN $vector | toFloat(x)], 256, FLOAT32) LIMIT $k) SCORE AS similarity
  WHERE similarity >= $floor
  WITH m ORDER BY similarity DESC, m.id
  WITH collect(m) AS found
  UNWIND range(0, size(found) - 1) AS i
  RETURN found[i] AS seed, i + 1 AS rank
  UNION ALL
  MATCH (m:Memory)
  SEARCH m IN (FULLTEXT INDEX memory_text FOR $terms LIMIT $k) SCORE AS bm25
  WITH m ORDER BY bm25 DESC, m.id
  WITH collect(m) AS found
  UNWIND range(0, size(found) - 1) AS i
  RETURN found[i] AS seed, i + 1 AS rank
}
WITH seed, sum(1.0 / (60 + rank)) AS rrf
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
WITH hit, hops, ns, rs, seed <> now AS stale, rrf * (0.5 ^ hops) AS score
ORDER BY score DESC, hops, size(ns), ns[0].id
WITH hit, collect({score: score, hops: hops, stale: stale, ns: ns, rs: rs})[0] AS best
ORDER BY best.score DESC, hit.seq DESC, hit.id LIMIT $limit
RETURN hit.id AS id, hit.kind AS kind, hit.gist AS gist, hit.text AS text, hit.rationale AS rationale,
       CASE WHEN best.hops > 0 THEN 'graph' WHEN best.stale THEN 'update' ELSE 'search' END AS via,
       best.hops AS hops, round(best.score, 4) AS score,
       [n IN best.ns | id(n)] AS nodes, [r IN best.rs | id(r)] AS rels,
       [n IN best.ns | coalesce(n.name, n.gist)] AS trail,
       [n IN best.ns WHERE n:Entity | n.name] AS through,
       COLLECT { MATCH (hit)-[a:ABOUT]->(e:Entity)
                 RETURN {name: e.name, node: id(e), rel: id(a)} ORDER BY e.name } AS about,
       COLLECT { MATCH (hit)-[:SUPERSEDES]->+(old) RETURN old.text ORDER BY old.seq DESC, old.id } AS replaced,
       head([(hit)-[:FROM]->(:Message)-[:IN_SESSION]->(s:Session) | s.title]) AS session;

// ---- connect: the shortest chain of current memories between two entities ----
MATCH (a:Entity {key: $from}), (b:Entity {key: $to})
MATCH chain = ANY SHORTEST
  (a) (()<-[:ABOUT]-(m:Memory WHERE m.current)-[:ABOUT]->()){1,6} (b)
RETURN [n IN nodes(chain) | id(n)] AS nodes, [r IN relationships(chain) | id(r)] AS rels,
       [n IN nodes(chain) | coalesce(n.name, n.gist)] AS trail,
       [n IN nodes(chain) WHERE n:Memory | n {.id, .kind, .gist, .text}] AS memories,
       length(chain) / 2 AS hops;

// ---- trace: where a memory, and each version it replaced, came from ----
MATCH (m:Memory {id: $id})
MATCH history = (m)-[:SUPERSEDES]->*(version:Memory)
MATCH source = (version)-[:FROM]->(msg:Message)-[:IN_SESSION]->(s:Session)
RETURN version.id AS id, version.kind AS kind, version.gist AS gist, version.text AS text,
       version.current AS current, msg.text AS said, s.title AS session, toString(msg.at) AS at,
       [n IN nodes(history) + tail(nodes(source)) | id(n)] AS nodes,
       [r IN relationships(history) + relationships(source) | id(r)] AS rels,
       [n IN nodes(history) + tail(nodes(source)) | coalesce(n.name, n.gist, n.title, 'message ' + toString(n.seq))] AS trail
ORDER BY version.seq DESC, id;

// ---- the entities a typed text names ----
MATCH (e:Entity)
WHERE $text CONTAINS ' ' + e.key + ' '
RETURN e.key AS key, e.name AS name, e.kind AS kind
ORDER BY size(e.key) DESC, key;

// ---- snapshot: what the page draws (nodes) ----
MATCH (n)
RETURN id(n) AS id, labels(n)[0] AS label,
       n {.id, .key, .name, .kind, .title, .role, .seq, .text, .gist, .slot, .rationale, .current,
          at: toString(n.at), startedAt: toString(n.startedAt), supersededAt: toString(n.supersededAt)} AS props
ORDER BY id;

// ---- snapshot: what the page draws (relationships) ----
MATCH (a)-[r]->(b)
RETURN id(r) AS id, type(r) AS type, id(a) AS source, id(b) AS target
ORDER BY id;
