// graph.cypher: the typed knowledge graphs of the financial-services sample and of the harness's fixtures, which read the
// same ontology (expected/graph.cypher, harness/run.mjs). Each part runs on its own database.
// The typed knowledge graph of the ontology financial-services: 12 entities, 10 relationships.
// Written by web/store.js exportCypher (example 01): entities are (:_Entity:KIND {key: 'KIND:NAME'}),
// relationships carry the best score (p), the number of claims behind them, their documents and evidence.
CREATE CONSTRAINT entity_key_unique IF NOT EXISTS FOR (e:_Entity) REQUIRE e.key IS UNIQUE;
UNWIND [
  {key: 'Person:ARJUN_MEHTA', name: 'Arjun Mehta', docs: ['financial-services']},
  {key: 'Person:COLM_BRADY', name: 'Colm Brady', docs: ['financial-services']},
  {key: 'Person:DANA_WHITLOCK', name: 'Dana Whitlock', docs: ['financial-services']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Person`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Organization:HALVORSEN_PRYCE_PARTNERS', name: 'Halvorsen Pryce Partners', docs: ['financial-services']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Organization`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Location:EDINBURGH', name: 'Edinburgh', docs: ['financial-services']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Location`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Account:ACC_1980', name: 'ACC-1980', docs: ['financial-services']},
  {key: 'Account:ACC_2207', name: 'ACC-2207', docs: ['financial-services']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Account`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Transaction:TX_4471', name: 'TX-4471', docs: ['financial-services']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Transaction`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Decision:REBALANCING', name: 'Rebalancing Decision', docs: ['financial-services']},
  {key: 'Decision:TRIM', name: 'Trim Decision', docs: ['financial-services']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Decision`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Policy:CONCENTRATION_LIMIT', name: 'Concentration Limit Policy', docs: ['financial-services']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Policy`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Security:KWB_2031', name: 'KWB-2031', docs: ['financial-services']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Security`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {a: 'Person:COLM_BRADY', b: 'Organization:HALVORSEN_PRYCE_PARTNERS', p: 0.686, claims: 1, docs: ['financial-services'], evidence: ['Colm Brady works for Halvorsen Pryce Partners.']},
  {a: 'Person:DANA_WHITLOCK', b: 'Organization:HALVORSEN_PRYCE_PARTNERS', p: 0.66, claims: 1, docs: ['financial-services'], evidence: ['Dana Whitlock works for Halvorsen Pryce Partners.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`WORKS_FOR`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Organization:HALVORSEN_PRYCE_PARTNERS', b: 'Location:EDINBURGH', p: 0.485, claims: 1, docs: ['financial-services'], evidence: ['Halvorsen Pryce Partners is located at Edinburgh.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`LOCATED_AT`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Person:ARJUN_MEHTA', b: 'Account:ACC_1980', p: 0.463, claims: 1, docs: ['financial-services'], evidence: ['ACC-1980 is also owned by Arjun Mehta.']},
  {a: 'Person:ARJUN_MEHTA', b: 'Account:ACC_2207', p: 0.743, claims: 1, docs: ['financial-services'], evidence: ['ACC-2207 is owned by Arjun Mehta.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`OWNS`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Transaction:TX_4471', b: 'Security:KWB_2031', p: 0.472, claims: 1, docs: ['financial-services'], evidence: ['TX-4471 involves KWB-2031, a green bond.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`INVOLVES`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Decision:REBALANCING', b: 'Transaction:TX_4471', p: 0.446, claims: 1, docs: ['financial-services'], evidence: ['The Rebalancing Decision caused TX-4471 on 22 September.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`CAUSED`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Decision:REBALANCING', b: 'Policy:CONCENTRATION_LIMIT', p: 0.402, claims: 1, docs: ['financial-services'], evidence: ['The Rebalancing Decision applied the Concentration Limit Policy.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`APPLIED_POLICY`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Decision:REBALANCING', b: 'Person:COLM_BRADY', p: 0.639, claims: 1, docs: ['financial-services'], evidence: ['The Rebalancing Decision was advised by Colm Brady.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`ADVISED_BY`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Person:COLM_BRADY', b: 'Account:ACC_2207', p: 0.7, claims: 1, docs: ['financial-services'], evidence: ['Colm Brady manages ACC-2207, which Arjun Mehta owns.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`MANAGES`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
// The typed knowledge graph of the ontology financial-services: 21 entities, 5 relationships.
// Written by web/store.js exportCypher (example 01): entities are (:_Entity:KIND {key: 'KIND:NAME'}),
// relationships carry the best score (p), the number of claims behind them, their documents and evidence.
CREATE CONSTRAINT entity_key_unique IF NOT EXISTS FOR (e:_Entity) REQUIRE e.key IS UNIQUE;
UNWIND [
  {key: 'Person:EXTRACTOR', name: 'extractor', docs: ['injection']},
  {key: 'Person:INGRID_SOL', name: 'Ingrid Sol', docs: ['fence', 'hedge']},
  {key: 'Person:METFORMIN', name: 'Metformin', docs: ['unknown']},
  {key: 'Person:MIRA_HOLT', name: 'Mira Holt', docs: ['event', 'hedge', 'markup', 'pronouns']},
  {key: 'Person:PEOPLE', name: 'people', docs: ['empty']},
  {key: 'Person:TOMAS_REYES', name: 'Tomas Reyes', docs: ['hedge', 'markup', 'negation', 'unknown']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Person`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Organization:CALDER_BAY', name: 'Calder Bay', docs: ['overlap']},
  {key: 'Organization:CALDER_BAY_CAPITAL', name: 'Calder Bay Capital', docs: ['hedge', 'injection', 'markup', 'negation', 'overlap', 'pronouns']},
  {key: 'Organization:CINEMA', name: 'cinema', docs: ['unknown']},
  {key: 'Organization:COMMITTEE', name: 'the committee', docs: ['empty']},
  {key: 'Organization:DESK', name: 'the desk', docs: ['empty']},
  {key: 'Organization:ORION_LABS', name: 'Orion Labs', docs: ['unknown']},
  {key: 'Organization:PASSWORD_HUNTER2', name: 'password hunter2', docs: ['injection']},
  {key: 'Organization:PELL_STREET_PARTNERS', name: 'Pell Street Partners', docs: ['negation']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Organization`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Location:CALDER', name: 'Calder', docs: ['overlap']},
  {key: 'Location:LEEDS', name: 'Leeds', docs: ['event', 'injection', 'markup', 'unknown']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Location`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Event:LEEDS_WEALTH_FORUM', name: 'Leeds Wealth Forum', docs: ['event']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Event`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Account:ACC_5120', name: 'ACC-5120', docs: ['markup', 'pronouns']},
  {key: 'Account:LINDEN_BOND_FUND', name: 'Linden Bond Fund', docs: ['pronouns']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Account`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Decision:D_210', name: 'Decision D-210', docs: ['selfloop']},
  {key: 'Decision:D_211', name: 'Decision D-211', docs: ['selfloop']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Decision`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {a: 'Person:MIRA_HOLT', b: 'Organization:CALDER_BAY_CAPITAL', p: 0.757, claims: 2, docs: ['hedge', 'markup'], evidence: ['**Mira Holt** works for **Calder Bay Capital**, an asset manager located in Leeds.', 'Mira Holt definitely works for Calder Bay Capital.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`WORKS_FOR`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Organization:CALDER_BAY_CAPITAL', b: 'Location:LEEDS', p: 0.48, claims: 2, docs: ['injection', 'markup'], evidence: ['**Mira Holt** works for **Calder Bay Capital**, an asset manager located in Leeds.', 'The extractor still reads only the kinds the ontology names, and Calder Bay Capital is located in Leeds.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`LOCATED_AT`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Person:MIRA_HOLT', b: 'Event:LEEDS_WEALTH_FORUM', p: 0.749, claims: 1, docs: ['event'], evidence: ['Mira Holt participated in the Leeds Wealth Forum.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`PARTICIPATED_IN`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Person:TOMAS_REYES', b: 'Account:ACC_5120', p: 0.765, claims: 1, docs: ['markup'], evidence: ['- Tomas Reyes owns account ACC-5120.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`OWNS`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Person:MIRA_HOLT', b: 'Account:ACC_5120', p: 0.721, claims: 1, docs: ['markup'], evidence: ['- Mira Holt manages account ACC-5120.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`MANAGES`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
