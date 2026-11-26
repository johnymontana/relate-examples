// The canary: db.ontology.* procedures (D15)
// Empty on Relate 1.3.0 (O1, NOTES.md R17): they exist as document storage behind the
// RELATE_PREVIEW=ontology preview gate, which SHOW PROCEDURES respects, and the WASM build reads no
// environment, so here this stays empty.
// Rows mean a release ships them usable: the signal that the ontology document could move into them.
// Parameters: none. Read-only.
SHOW PROCEDURES YIELD name
WHERE name STARTS WITH 'db.ontology.'
RETURN name
ORDER BY name
