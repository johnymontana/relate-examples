// Full-text search over the sentences the model read (the sentence_text index)
// SEARCH ORs the terms and scores by summed term hits.
// @param q STRING "decision transaction"  the search terms
MATCH (s:_Sentence)
WHERE $q IS NOT NULL
SEARCH s IN (FULLTEXT INDEX sentence_text FOR $q LIMIT 10) SCORE AS score
MATCH (s)-[:_IN]->(:_Section)-[:_OF]->(d:_Document)
RETURN d.title AS document, s.idx AS sentence, s.text AS text, score
ORDER BY score DESC, document, sentence
