// Audit: every published entity carries exactly its kind label, and every typed edge joins them (D16)
// Entities are (:_Entity:<Kind>); a kind label without a kept mention behind it is removed at publish.
// Expect 0 rows.
// Parameters: none. Read-only.
MATCH (e:_Entity)
WHERE e.kind IS NULL OR NOT e.kind IN labels(e) OR size(labels(e)) <> 2
   OR NOT EXISTS { MATCH (m:_Mention)-[:_OF]->(e) WHERE m.band = 'keep' }
RETURN 'entity' AS item, e.key AS key
UNION ALL
MATCH (m:_Mention)-[:_OF]->(e:_Entity)
WHERE m.band <> 'keep' OR e.key <> m.label + ':' + m.name
RETURN 'mention' AS item, m.key AS key
UNION ALL
MATCH (m:_Mention)
WHERE m.band = 'keep' AND NOT EXISTS { MATCH (m)-[:_OF]->(:_Entity) }
RETURN 'kept mention' AS item, m.key AS key
