// The typed knowledge graph: every published fact (D16)
// What the gate keeps, as (:_Entity:<Kind>)-[:<TYPE>]->(:_Entity:<Kind>) with the ontology's own
// labels and relationship types (internal labels start with _); the page draws `path` with NVL.
// Scalar columns beside the path, so engines can be compared row for row (paths carry internal ids).
// Parameters: none. Read-only.
MATCH path = (a:_Entity)-[r]->(b:_Entity)
RETURN path, a.key AS head, type(r) AS rel, b.key AS tail, round(r.p, 3) AS score, size(r.claims) AS claims
ORDER BY head, rel, tail
LIMIT 500
