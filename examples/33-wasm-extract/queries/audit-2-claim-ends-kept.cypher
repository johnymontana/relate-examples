// Audit: both ends of every kept claim are kept mentions (D10 rule 3)
// The gate joins each end to a kept mention (HEAD and TAIL edges). Expect 0 rows.
// Parameters: none. Read-only.
MATCH (c:_Claim)
WHERE c.band = 'keep'
OPTIONAL MATCH (c)-[:_HEAD]->(h:_Mention)
OPTIONAL MATCH (c)-[:_TAIL]->(t:_Mention)
WITH c, h, t
WHERE h IS NULL OR t IS NULL OR h.band <> 'keep' OR t.band <> 'keep'
RETURN c.key AS claim, h.band AS head_band, t.band AS tail_band
ORDER BY claim
