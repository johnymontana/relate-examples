// Audit: typed edges and kept claims match one to one (D16)
// Every claim a published relationship lists is kept, of its type, between its ends; every kept
// claim is listed by exactly one published relationship. Expect 0 rows.
// Parameters: none. Read-only.
MATCH (a:_Entity)-[r]->(b:_Entity)
UNWIND r.claims AS k
WITH a, r, b, k WHERE k IS NOT NULL
OPTIONAL MATCH (c:_Claim {key: k})
WITH a, r, b, k, c
WHERE c IS NULL OR c.band <> 'keep' OR c.rel <> type(r)
   OR NOT ((c.head = a.key AND c.tail = b.key) OR (c.head = b.key AND c.tail = a.key))
RETURN 'edge' AS item, k AS key
UNION ALL
MATCH (c:_Claim)
WHERE c.band = 'keep'
OPTIONAL MATCH (:_Entity)-[r]->(:_Entity)
WHERE c.key IN r.claims
WITH c, count(r) AS edges
WHERE edges <> 1
RETURN 'claim' AS item, c.key AS key
