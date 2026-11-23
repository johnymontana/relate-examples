// The ontology as schema statements (web/ddl.js schemaStatements), in the order the store applies them.
// 1. The graph type: node labels with typed properties (NOT NULL from key and must_exist),
//    relationship types with their endpoints and typed properties.
ALTER CURRENT GRAPH TYPE SET {
  (:`Company` => {`aliases` :: LIST<STRING NOT NULL>, `country` :: STRING, `description` :: STRING, `embedding` :: VECTOR<FLOAT32 NOT NULL>(1536), `founded` :: DATE, `id` :: STRING NOT NULL, `name` :: STRING NOT NULL, `ticker` :: STRING}),
  (:`Event` => {`amount_usd` :: FLOAT, `announced_on` :: DATE, `id` :: STRING NOT NULL, `kind` :: STRING NOT NULL, `status` :: STRING NOT NULL, `summary` :: STRING}),
  (:`Industry` => {`id` :: STRING NOT NULL, `name` :: STRING NOT NULL}),
  (:`InvestmentFund` => {`id` :: STRING NOT NULL, `kind` :: STRING, `name` :: STRING NOT NULL}),
  (:`Person` => {`id` :: STRING NOT NULL, `name` :: STRING NOT NULL, `role` :: STRING}),
  (:`Product` => {`category` :: STRING, `id` :: STRING NOT NULL, `name` :: STRING NOT NULL}),
  (:`Regulator` => {`aliases` :: LIST<STRING NOT NULL>, `id` :: STRING NOT NULL, `jurisdiction` :: STRING, `name` :: STRING NOT NULL}),
  (:`Company` =>)-[:`ACQUIRES` => {`assertion` :: STRING, `evidence` :: STRING, `supported` :: FLOAT}]->(:`Company` =>),
  (:`Person` =>)-[:`CEO_OF` => {`assertion` :: STRING, `evidence` :: STRING, `since` :: DATE, `supported` :: FLOAT}]->(:`Company` =>),
  (:`Company` =>)-[:`COMPETES_WITH` => {`assertion` :: STRING, `evidence` :: STRING, `supported` :: FLOAT}]->(:`Company` =>),
  (:`Event` =>)-[:`EVENT_ACQUIRER` =>]->(:`Company` =>),
  (:`Event` =>)-[:`EVENT_TARGET` =>]->(:`Company` =>),
  (:`Person` =>)-[:`FOUNDED` => {`assertion` :: STRING, `evidence` :: STRING, `supported` :: FLOAT}]->(:`Company` =>),
  (:`Company` =>)-[:`HAS_STAKE_IN` => {`assertion` :: STRING, `evidence` :: STRING, `percentage` :: FLOAT, `supported` :: FLOAT}]->(:`Company` =>),
  (:`InvestmentFund` =>)-[:`INVESTED_IN` => {`amount_usd` :: FLOAT, `assertion` :: STRING, `evidence` :: STRING, `supported` :: FLOAT}]->(:`Company` =>),
  (:`Regulator` =>)-[:`INVESTIGATES` => {`assertion` :: STRING, `evidence` :: STRING, `supported` :: FLOAT}]->(:`Company` =>),
  (:`Company` =>)-[:`MAKES` => {`assertion` :: STRING, `evidence` :: STRING, `supported` :: FLOAT}]->(:`Product` =>),
  (:`Company` =>)-[:`OPERATES_IN` => {`assertion` :: STRING, `evidence` :: STRING, `supported` :: FLOAT}]->(:`Industry` =>),
  (:`Company` =>)-[:`PARTNERS_WITH` => {`assertion` :: STRING, `evidence` :: STRING, `supported` :: FLOAT}]->(:`Company` =>),
  (:`Company` =>)-[:`SUPPLIES` => {`assertion` :: STRING, `evidence` :: STRING, `supported` :: FLOAT}]->(:`Company` =>)
};
// 2. The source app's DDL (cypher.py); equals data/reference/ddl.cypher: yes
CREATE CONSTRAINT company_id_key IF NOT EXISTS FOR (n:Company) REQUIRE n.id IS NODE KEY;
CREATE CONSTRAINT company_name_exists IF NOT EXISTS FOR (n:Company) REQUIRE n.name IS NOT NULL;
CREATE CONSTRAINT company_ticker_unique IF NOT EXISTS FOR (n:Company) REQUIRE n.ticker IS UNIQUE;
CREATE CONSTRAINT company_name_country_unique IF NOT EXISTS FOR (n:Company) REQUIRE (n.name, n.country) IS UNIQUE;
CREATE CONSTRAINT person_id_key IF NOT EXISTS FOR (n:Person) REQUIRE n.id IS NODE KEY;
CREATE CONSTRAINT person_name_exists IF NOT EXISTS FOR (n:Person) REQUIRE n.name IS NOT NULL;
CREATE CONSTRAINT product_id_key IF NOT EXISTS FOR (n:Product) REQUIRE n.id IS NODE KEY;
CREATE CONSTRAINT product_name_exists IF NOT EXISTS FOR (n:Product) REQUIRE n.name IS NOT NULL;
CREATE CONSTRAINT industry_id_key IF NOT EXISTS FOR (n:Industry) REQUIRE n.id IS NODE KEY;
CREATE CONSTRAINT industry_name_exists IF NOT EXISTS FOR (n:Industry) REQUIRE n.name IS NOT NULL;
CREATE CONSTRAINT regulator_id_key IF NOT EXISTS FOR (n:Regulator) REQUIRE n.id IS NODE KEY;
CREATE CONSTRAINT regulator_name_exists IF NOT EXISTS FOR (n:Regulator) REQUIRE n.name IS NOT NULL;
CREATE CONSTRAINT investmentfund_id_key IF NOT EXISTS FOR (n:InvestmentFund) REQUIRE n.id IS NODE KEY;
CREATE CONSTRAINT investmentfund_name_exists IF NOT EXISTS FOR (n:InvestmentFund) REQUIRE n.name IS NOT NULL;
CREATE CONSTRAINT event_id_key IF NOT EXISTS FOR (n:Event) REQUIRE n.id IS NODE KEY;
CREATE CONSTRAINT event_kind_exists IF NOT EXISTS FOR (n:Event) REQUIRE n.kind IS NOT NULL;
CREATE CONSTRAINT event_status_exists IF NOT EXISTS FOR (n:Event) REQUIRE n.status IS NOT NULL;
CREATE FULLTEXT INDEX company_name_fulltext IF NOT EXISTS FOR (n:Company) ON EACH [n.name, n.description] OPTIONS {indexConfig: {`fulltext.analyzer`: 'standard-no-stop-words'}};
CREATE VECTOR INDEX company_embedding_vector IF NOT EXISTS FOR (n:Company) ON n.embedding OPTIONS {indexConfig: {`vector.dimensions`: 1536, `vector.similarity_function`: 'cosine'}};
