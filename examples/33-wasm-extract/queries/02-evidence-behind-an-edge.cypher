// The evidence behind the edges: each fact's claims, their sentences and documents (D16)
// Each published relationship lists the claim keys it stands for; this follows them to the
// sentences the model read, for every edge of any ontology (the first 200 rows). To look at one
// edge, add WHERE a.key = '<Kind>:<NAME>' after the first MATCH.
// Parameters: none. Read-only.
MATCH (a:_Entity)-[r]->(b:_Entity)
UNWIND r.claims AS k
WITH a, r, b, k WHERE k IS NOT NULL
MATCH (c:_Claim {key: k})-[:_EVIDENCE]->(s:_Sentence)-[:_IN]->(:_Section)-[:_OF]->(d:_Document)
RETURN a.key AS head, type(r) AS rel, b.key AS tail, d.title AS document, s.idx AS sentence, s.text AS text,
       c.htext AS head_text, c.ttext AS tail_text, round(c.p, 3) AS score, c.band AS band, c.rule AS rule
ORDER BY head, rel, tail, document, sentence, score DESC
LIMIT 200
