// Audit: every kept claim is legal by the ontology (D10 rule 4)
// (head kind, tail kind) is one of its link's legal pairs (_LinkType.pairs, 'SOURCE|TARGET'), either
// way round for a symmetric link, and never a self-loop. Expect 0 rows.
// Parameters: none. Read-only.
MATCH (c:_Claim)
WHERE c.band = 'keep'
  AND (c.head = c.tail OR NOT EXISTS {
    MATCH (l:_LinkType)
    WHERE l.id = c.rel
      AND ((c.hk + '|' + c.tk) IN l.pairs OR (l.symmetric = true AND (c.tk + '|' + c.hk) IN l.pairs))
  })
RETURN c.key AS claim, c.rel AS rel, c.hk AS head_kind, c.tk AS tail_kind, c.head AS head, c.tail AS tail
ORDER BY claim
