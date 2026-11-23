CREATE CONSTRAINT company_id_key IF NOT EXISTS FOR (n:Company) REQUIRE n.id IS NODE KEY
CREATE CONSTRAINT company_name_exists IF NOT EXISTS FOR (n:Company) REQUIRE n.name IS NOT NULL
CREATE CONSTRAINT company_ticker_unique IF NOT EXISTS FOR (n:Company) REQUIRE n.ticker IS UNIQUE
CREATE CONSTRAINT company_name_country_unique IF NOT EXISTS FOR (n:Company) REQUIRE (n.name, n.country) IS UNIQUE
CREATE CONSTRAINT person_id_key IF NOT EXISTS FOR (n:Person) REQUIRE n.id IS NODE KEY
CREATE CONSTRAINT person_name_exists IF NOT EXISTS FOR (n:Person) REQUIRE n.name IS NOT NULL
CREATE CONSTRAINT product_id_key IF NOT EXISTS FOR (n:Product) REQUIRE n.id IS NODE KEY
CREATE CONSTRAINT product_name_exists IF NOT EXISTS FOR (n:Product) REQUIRE n.name IS NOT NULL
CREATE CONSTRAINT industry_id_key IF NOT EXISTS FOR (n:Industry) REQUIRE n.id IS NODE KEY
CREATE CONSTRAINT industry_name_exists IF NOT EXISTS FOR (n:Industry) REQUIRE n.name IS NOT NULL
CREATE CONSTRAINT regulator_id_key IF NOT EXISTS FOR (n:Regulator) REQUIRE n.id IS NODE KEY
CREATE CONSTRAINT regulator_name_exists IF NOT EXISTS FOR (n:Regulator) REQUIRE n.name IS NOT NULL
CREATE CONSTRAINT investmentfund_id_key IF NOT EXISTS FOR (n:InvestmentFund) REQUIRE n.id IS NODE KEY
CREATE CONSTRAINT investmentfund_name_exists IF NOT EXISTS FOR (n:InvestmentFund) REQUIRE n.name IS NOT NULL
CREATE CONSTRAINT event_id_key IF NOT EXISTS FOR (n:Event) REQUIRE n.id IS NODE KEY
CREATE CONSTRAINT event_kind_exists IF NOT EXISTS FOR (n:Event) REQUIRE n.kind IS NOT NULL
CREATE CONSTRAINT event_status_exists IF NOT EXISTS FOR (n:Event) REQUIRE n.status IS NOT NULL
CREATE FULLTEXT INDEX company_name_fulltext IF NOT EXISTS FOR (n:Company) ON EACH [n.name, n.description] OPTIONS {indexConfig: {`fulltext.analyzer`: 'standard-no-stop-words'}}
CREATE VECTOR INDEX company_embedding_vector IF NOT EXISTS FOR (n:Company) ON n.embedding OPTIONS {indexConfig: {`vector.dimensions`: 1536, `vector.similarity_function`: 'cosine'}}
