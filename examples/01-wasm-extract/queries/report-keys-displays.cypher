// Entity keys with more than one display: the surface texts behind one KIND:NAME key
// edgextract's canonical names (E3) fold case, articles, possessives and punctuation, so "Acme Inc"
// and "Acme Inc." are one entity; the entity's name is its most frequent surface text.
// Parameters: none. Read-only.
MATCH (m:_Mention)-[:_OF]->(e:_Entity)
WITH e, m ORDER BY m.text
WITH e, collect(DISTINCT m.text) AS displays
WHERE size(displays) > 1
RETURN e.key AS entity, e.name AS name, displays
ORDER BY entity
