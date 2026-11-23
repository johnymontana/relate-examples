// Audit: nothing outside a complete section is gated or published (D9)
// A section's complete flag is written last; the gate reads complete sections only. Expect 0 rows
// after a finished run (an interrupted one leaves its section incomplete until it is resumed).
// Parameters: none. Read-only.
MATCH (sec:_Section)<-[:_IN]-(:_Sentence)<-[:_EVIDENCE]-(c:_Claim)
WHERE sec.complete <> true AND c.band IS NOT NULL
RETURN 'claim' AS item, c.key AS key
UNION ALL
MATCH (sec:_Section)<-[:_IN]-(:_Sentence)<-[:_IN]-(m:_Mention)
WHERE sec.complete <> true AND (m.band IS NOT NULL OR EXISTS { MATCH (m)-[:_OF]->(:_Entity) })
RETURN 'mention' AS item, m.key AS key
UNION ALL
MATCH (sec:_Section)
WHERE sec.complete <> true
RETURN 'section' AS item, sec.key AS key
