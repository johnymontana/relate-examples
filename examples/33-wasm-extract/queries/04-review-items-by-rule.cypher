// Review items by rule: what the gate sent to a person, and why (D10)
// Claims and mentions in the review band, grouped by the rule that put them there: band (between
// the cutoffs, rule 5), type-margin and pole-specific (rule 2: a runner-up kind too close, or a
// domain kind that took its words from a base kind but scored below its keep cutoff), other-kind
// (rule 2b: the name is kept as another kind in the store), hedged (rule 5's hedge cap: the
// sentence hedges or negates the claim), end-in-review (rule 3's cap: an end is in review) and
// ambiguous or reversed (rule 6). The gate's other rule ids keep or drop: no-name (0), gazetteer (1),
// one-kind (2), other-kind (2b, a mention inside one of the kind kept), unanchored (3), illegal and
// self-loop (4), verdict and claim-verdict (7), floor and off (a rule switched off).
// Parameters: none. Read-only.
MATCH (c:_Claim)-[:_EVIDENCE]->(s:_Sentence)
WHERE c.band = 'review'
RETURN 'claim' AS item, c.rule AS rule, c.htext + ' -[' + c.rel + ']-> ' + c.ttext AS what,
       round(c.p, 3) AS score, s.text AS sentence, c.key AS key
UNION ALL
MATCH (m:_Mention)-[:_IN]->(s:_Sentence)
WHERE m.band = 'review'
RETURN 'mention' AS item, m.rule AS rule, m.text + ' (' + m.label + ')' AS what,
       round(m.p, 3) AS score, s.text AS sentence, m.key AS key
