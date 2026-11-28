// graph.cypher: the typed knowledge graphs of the financial-services documents (its curated ontology) and of the harness's fixtures
// (create-context-graph's financial-services, converted; expected/graph.cypher, harness/run.mjs). Each part runs on its own database.
// The typed knowledge graph of the ontology financial-services: 31 entities, 17 relationships.
// Written by web/store.js exportCypher (example 01): entities are (:_Entity:KIND {key: 'KIND:NAME'}),
// relationships carry the best score (p), the number of claims behind them, their documents and evidence.
CREATE CONSTRAINT entity_key_unique IF NOT EXISTS FOR (e:_Entity) REQUIRE e.key IS UNIQUE;
UNWIND [
  {key: 'Client:ARJUN_MEHTA', name: 'Arjun Mehta', docs: ['financial-services', 'financial-services/risk-review']},
  {key: 'Client:EILIDH_FRASER', name: 'Eilidh Fraser', docs: ['financial-services']},
  {key: 'Client:MEHTA_FAMILY_TRUST', name: 'Mehta Family Trust', docs: ['financial-services']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Client`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Advisor:COLM_BRADY', name: 'Colm Brady', docs: ['financial-services']},
  {key: 'Advisor:DANA_WHITLOCK', name: 'Dana Whitlock', docs: ['financial-services']},
  {key: 'Advisor:PRIYA_RAMAN', name: 'Priya Raman', docs: ['financial-services', 'financial-services/risk-review']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Advisor`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Firm:HALVORSEN_PRYCE_PARTNERS_LLP', name: 'Halvorsen Pryce Partners LLP', docs: ['financial-services', 'financial-services/risk-review']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Firm`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Account:ACC_1980', name: 'ACC-1980', docs: ['financial-services', 'financial-services/risk-review'], accountId: 'ACC-1980', accountType: 'advisory', wrapper: 'ISA'},
  {key: 'Account:ACC_2207', name: 'ACC-2207', docs: ['financial-services'], accountId: 'ACC-2207', accountType: 'discretionary', wrapper: 'null'},
  {key: 'Account:ACC_3315', name: 'ACC-3315', docs: ['financial-services'], accountId: 'ACC-3315', accountType: 'null', wrapper: 'null'},
  {key: 'Account:ACC_4102', name: 'ACC-4102', docs: ['financial-services'], accountId: 'ACC-4102', accountType: 'null', wrapper: 'null'},
  {key: 'Account:NORTHBROOK_INFRASTRUCTURE_ORDINARY_SHARES', name: 'Northbrook Infrastructure ordinary shares', docs: ['financial-services/risk-review'], accountId: 'null', accountType: 'null', wrapper: 'null'}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Account`, e.name = row.name, e.docs = row.docs, e.`accountId` = row.`accountId`, e.`accountType` = row.`accountType`, e.`wrapper` = row.`wrapper`;
UNWIND [
  {key: 'Security:GB00BKX5CN86', name: 'GB00BKX5CN86', docs: ['financial-services/risk-review'], isin: 'GB00BKX5CN86'},
  {key: 'Security:KESTREL_WATER_2031_GREEN_BOND', name: 'Kestrel Water 2031 green bond', docs: ['financial-services', 'financial-services/risk-review'], isin: 'null'},
  {key: 'Security:XS2391840357', name: 'XS2391840357', docs: ['financial-services'], isin: 'XS2391840357'}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Security`, e.name = row.name, e.docs = row.docs, e.`isin` = row.`isin`;
UNWIND [
  {key: 'Issuer:FENWICK_ASSET_MANAGEMENT', name: 'Fenwick Asset Management', docs: ['financial-services/risk-review']},
  {key: 'Issuer:FENWICK_GLOBAL_EQUITY_FUND', name: 'Fenwick Global Equity Fund', docs: ['financial-services/risk-review']},
  {key: 'Issuer:KESTREL_WATER_PLC', name: 'Kestrel Water plc', docs: ['financial-services']},
  {key: 'Issuer:NORTHBROOK_INFRASTRUCTURE_PLC', name: 'Northbrook Infrastructure plc', docs: ['financial-services']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Issuer`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Transaction:TX_4471', name: 'TX-4471', docs: ['financial-services'], transactionId: 'TX-4471', side: 'buy', amount: 410000, tradeDate: '2026-09-22'},
  {key: 'Transaction:TX_4480', name: 'TX-4480', docs: ['financial-services'], transactionId: 'TX-4480', side: 'sell', amount: 385500, tradeDate: '2026-09-22'},
  {key: 'Transaction:TX_4502', name: 'TX-4502', docs: ['financial-services'], transactionId: 'TX-4502', side: 'sell', amount: 140000, tradeDate: 'null'},
  {key: 'Transaction:TX_4519', name: 'TX-4519', docs: ['financial-services'], transactionId: 'TX-4519', side: 'null', amount: 'null', tradeDate: 'null'},
  {key: 'Transaction:TX_4611', name: 'TX-4611', docs: ['financial-services/risk-review'], transactionId: 'TX-4611', side: 'null', amount: 20000, tradeDate: 'null'},
  {key: 'Transaction:TX_4650', name: 'TX-4650', docs: ['financial-services/risk-review'], transactionId: 'TX-4650', side: 'null', amount: 'null', tradeDate: 'null'}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Transaction`, e.name = row.name, e.docs = row.docs, e.`transactionId` = row.`transactionId`, e.`side` = row.`side`, e.`amount` = CASE WHEN row.`amount` IS NULL THEN null ELSE toFloat(row.`amount`) END, e.`tradeDate` = CASE WHEN row.`tradeDate` IS NULL THEN null ELSE date(row.`tradeDate`) END;
UNWIND [
  {key: 'Decision:ISA_TOP_UP', name: 'ISA Top-up Decision', docs: ['financial-services/risk-review'], decidedOn: '2026-08-02'},
  {key: 'Decision:REBALANCING', name: 'Rebalancing Decision', docs: ['financial-services'], decidedOn: '2026-09-18'},
  {key: 'Decision:TRIM', name: 'Trim Decision', docs: ['financial-services'], decidedOn: 'null'}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Decision`, e.name = row.name, e.docs = row.docs, e.`decidedOn` = CASE WHEN row.`decidedOn` IS NULL THEN null ELSE date(row.`decidedOn`) END;
UNWIND [
  {key: 'Policy:CONCENTRATION_LIMIT', name: 'Concentration Limit Policy', docs: ['financial-services']},
  {key: 'Policy:SUITABILITY', name: 'Suitability Policy', docs: ['financial-services', 'financial-services/risk-review']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Policy`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Regulator:FINANCIAL_CONDUCT_AUTHORITY', name: 'Financial Conduct Authority', docs: ['financial-services']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Regulator`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {a: 'Client:ARJUN_MEHTA', b: 'Account:ACC_1980', p: 0.589, claims: 2, docs: ['financial-services', 'financial-services/risk-review'], evidence: ['Arjun Mehta owns ACC-1980, a stocks-and-shares ISA with a balanced mandate.', 'Arjun Mehta owns ACC-2207, a discretionary account, and ACC-1980, a stocks-and-shares ISA.']},
  {a: 'Client:ARJUN_MEHTA', b: 'Account:ACC_2207', p: 0.565, claims: 1, docs: ['financial-services'], evidence: ['Arjun Mehta owns ACC-2207, a discretionary account, and ACC-1980, a stocks-and-shares ISA.']},
  {a: 'Client:EILIDH_FRASER', b: 'Account:ACC_4102', p: 0.615, claims: 1, docs: ['financial-services'], evidence: ['Eilidh Fraser owns ACC-4102, a cautious income account that Dana Whitlock reviews each quarter.']},
  {a: 'Client:MEHTA_FAMILY_TRUST', b: 'Account:ACC_3315', p: 0.422, claims: 1, docs: ['financial-services'], evidence: ['The Mehta Family Trust, a second client in the same household, owns ACC-3315.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`OWNS`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Advisor:COLM_BRADY', b: 'Account:ACC_2207', p: 0.67, claims: 1, docs: ['financial-services'], evidence: ['Colm Brady manages ACC-2207.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`MANAGES`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Advisor:COLM_BRADY', b: 'Client:ARJUN_MEHTA', p: 0.708, claims: 1, docs: ['financial-services'], evidence: ['Colm Brady advises Arjun Mehta on both accounts and meets him twice a year in Edinburgh.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`ADVISES`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Advisor:DANA_WHITLOCK', b: 'Firm:HALVORSEN_PRYCE_PARTNERS_LLP', p: 0.247, claims: 1, docs: ['financial-services'], evidence: ['Dana Whitlock, the firm\'s compliance officer, works for Halvorsen Pryce Partners LLP, and so does Priya Raman, an analyst on the fixed-income desk.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`EMPLOYED_BY`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Account:ACC_1980', b: 'Firm:HALVORSEN_PRYCE_PARTNERS_LLP', p: 0.691, claims: 1, docs: ['financial-services/risk-review'], evidence: ['ACC-1980 is held at Halvorsen Pryce Partners LLP, and Priya Raman manages ACC-1980 under the firm\'s advisory service.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`HELD_AT`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Account:ACC_2207', b: 'Security:KESTREL_WATER_2031_GREEN_BOND', p: 0.425, claims: 1, docs: ['financial-services'], evidence: ['After TX-4471, ACC-2207 holds the Kestrel Water 2031 green bond, worth 14.2% of the account.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`HOLDS`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Transaction:TX_4471', b: 'Account:ACC_2207', p: 0.289, claims: 1, docs: ['financial-services'], evidence: ['On 22 September 2026, TX-4471 took account ACC-2207 over the firm\'s single-issuer limit.']},
  {a: 'Transaction:TX_4611', b: 'Account:ACC_1980', p: 0.27, claims: 1, docs: ['financial-services/risk-review'], evidence: ['TX-4611 was executed in ACC-1980 on 5 August 2026.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`EXECUTED_IN`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Transaction:TX_4471', b: 'Policy:CONCENTRATION_LIMIT', p: 0.239, claims: 1, docs: ['financial-services'], evidence: ['TX-4471 breached the Concentration Limit Policy, which caps exposure to any one issuer at 10% of an account\'s value.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`BREACHED`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Decision:ISA_TOP_UP', b: 'Advisor:PRIYA_RAMAN', p: 0.55, claims: 1, docs: ['financial-services/risk-review'], evidence: ['The ISA Top-up Decision was recorded on 2 August 2026 and was recommended by Priya Raman.']},
  {a: 'Decision:REBALANCING', b: 'Advisor:COLM_BRADY', p: 0.692, claims: 1, docs: ['financial-services'], evidence: ['The Rebalancing Decision was recommended by Colm Brady and applied the Suitability Policy: it moved ACC-2207 out of listed infrastructure equity and into investment-grade green bonds, in line with Arjun Mehta\'s stated preferences.']},
  {a: 'Decision:TRIM', b: 'Advisor:DANA_WHITLOCK', p: 0.569, claims: 1, docs: ['financial-services'], evidence: ['The Trim Decision was recommended by Dana Whitlock and approved by the committee by email the same day.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`RECOMMENDED_BY`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
UNWIND [
  {a: 'Decision:ISA_TOP_UP', b: 'Policy:SUITABILITY', p: 0.474, claims: 2, docs: ['financial-services/risk-review'], evidence: ['The ISA Top-up Decision applied the Suitability Policy, since the new money took the account\'s equity share to its agreed maximum.']},
  {a: 'Decision:REBALANCING', b: 'Policy:SUITABILITY', p: 0.522, claims: 1, docs: ['financial-services'], evidence: ['The Rebalancing Decision was recommended by Colm Brady and applied the Suitability Policy: it moved ACC-2207 out of listed infrastructure equity and into investment-grade green bonds, in line with Arjun Mehta\'s stated preferences.']}
] AS row
WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL
MATCH (a:_Entity {key: row.a})
MATCH (b:_Entity {key: row.b})
MERGE (a)-[r:`APPLIED`]->(b)
SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;
// The typed knowledge graph of the ontology financial-services: 16 entities, 5 relationships.
// Written by web/store.js exportCypher (example 01): entities are (:_Entity:KIND {key: 'KIND:NAME'}),
// relationships carry the best score (p), the number of claims behind them, their documents and evidence.
CREATE CONSTRAINT entity_key_unique IF NOT EXISTS FOR (e:_Entity) REQUIRE e.key IS UNIQUE;
UNWIND [
  {key: 'Person:EXTRACTOR', name: 'extractor', docs: ['injection']},
  {key: 'Person:INGRID_SOL', name: 'Ingrid Sol', docs: ['fence', 'hedge']},
  {key: 'Person:MIRA_HOLT', name: 'Mira Holt', docs: ['event', 'hedge', 'markup', 'pronouns']},
  {key: 'Person:TOMAS_REYES', name: 'Tomas Reyes', docs: ['hedge', 'markup', 'negation', 'unknown']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Person`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Organization:CALDER_BAY', name: 'Calder Bay', docs: ['overlap']},
  {key: 'Organization:CALDER_BAY_CAPITAL', name: 'Calder Bay Capital', docs: ['hedge', 'injection', 'markup', 'negation', 'overlap', 'pronouns']},
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
  {key: 'Account:ACC_5120', name: 'ACC-5120', docs: ['markup']},
  {key: 'Account:LINDEN_BOND_FUND', name: 'Linden Bond Fund', docs: ['pronouns']}
] AS row
WITH row WHERE row.key IS NOT NULL
MERGE (e:_Entity {key: row.key})
SET e:`Account`, e.name = row.name, e.docs = row.docs;
UNWIND [
  {key: 'Decision:D_210', name: 'Decision D-210', docs: ['selfloop']}
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
