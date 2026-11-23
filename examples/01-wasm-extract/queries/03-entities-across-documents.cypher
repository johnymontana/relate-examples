// Entities across documents: the names more than one document supports
// An entity's key is KIND:NAME with edgextract's canonical name (names.js), so the same company
// in two notes is one node; e.docs holds the documents whose kept mentions name it.
// Parameters: none. Read-only.
MATCH (e:_Entity)
WHERE size(e.docs) > 1
UNWIND e.docs AS id
WITH e, id WHERE id IS NOT NULL
MATCH (d:_Document {id: id})
WITH e, d ORDER BY d.title
WITH e, collect(d.title) AS documents
RETURN e.key AS entity, e.kind AS kind, e.name AS name, documents
ORDER BY entity
