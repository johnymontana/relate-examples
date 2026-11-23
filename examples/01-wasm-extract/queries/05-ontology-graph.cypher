// The ontology as a graph: links, the kinds at their ends, and their legal pairs (D15)
// Derived from the stored v1 document (:_Ontology.doc). A link's legal pairs (`pairs`, 'SOURCE|TARGET') are what
// the gate checks; its _DOMAIN and _RANGE edges are the union of those sources and targets, for the
// view, not legality. Typed links are also enforced by the graph type.
// Parameters: none. Read-only.
MATCH path = (l:_LinkType)-[x:_DOMAIN|_RANGE]->(k:_Kind)
RETURN path, l.id AS link, type(x) AS side, k.id AS kind, l.pairs AS pairs, l.typed AS typed, l.symmetric AS symmetric,
       l.keep AS keep, l.drop AS drop
ORDER BY link, side, kind
