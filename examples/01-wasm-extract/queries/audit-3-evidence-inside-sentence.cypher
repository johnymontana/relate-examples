// Audit: every mention and claim lies inside its sentence, and its text is what the offsets cut
// Offsets are code points into the document (D8); substring() counts code points too. Expect 0 rows.
// Parameters: none. Read-only.
MATCH (c:_Claim)-[:_EVIDENCE]->(s:_Sentence)
WHERE NOT (s.start <= c.hs AND c.hs < c.he AND c.he <= s.end AND s.start <= c.ts AND c.ts < c.te AND c.te <= s.end)
   OR substring(s.text, c.hs - s.start, c.he - c.hs) <> c.htext
   OR substring(s.text, c.ts - s.start, c.te - c.ts) <> c.ttext
RETURN 'claim' AS item, c.key AS key
UNION ALL
MATCH (m:_Mention)-[:_IN]->(s:_Sentence)
WHERE NOT (s.start <= m.start AND m.start < m.end AND m.end <= s.end)
   OR substring(s.text, m.start - s.start, m.end - m.start) <> m.text
RETURN 'mention' AS item, m.key AS key
