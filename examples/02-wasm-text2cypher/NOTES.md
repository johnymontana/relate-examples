# Example 02: the behaviours it depends on

Every engine and library behaviour this example depends on or pins, one row each. The ids are what
the code, the harnesses and `expected/` cite. **Pinned by** names the file whose run fails when the
behaviour changes (a `PIN:` line on stderr, or a diff against `expected/`). Every row was checked
on 2026-11-26 against:
- Relate 1.3.0: npm `@relate/relate-wasm@1.3.0` and the `relate-db` 1.3.0 binding;
- WebLLM 0.2.89;
- the Ontology Graph Spec SDK 0.13.0.

Example 01's `NOTES.md` rows (R1…R24) hold for this example too, where it touches the same engine
surface: no transactions in WASM (R2), the JSON envelope (R4), an integral number binding as
INTEGER (R5), dynamic labels and types (R7), and a trap leaving the handle unusable (R14). The rows
below are this example's own.

## Engine behaviours (Relate 1.3.0)

| id | behaviour | minimal repro | how the example copes | pinned by |
|---|---|---|---|---|
| P1 | On a label the graph type declares, an existence constraint must come from the graph type: `CREATE CONSTRAINT … IS NOT NULL` fails `IncompatibleGraphTypeDependence: dependent constraints are managed by the graph type`, unless the graph type already declares the property `NOT NULL` (then `IF NOT EXISTS` is a no-op). | graph type `{name :: STRING}`, then `CREATE CONSTRAINT c FOR (n:A) REQUIRE n.name IS NOT NULL` | `web/ddl.js` derives a typed graph type from the ontology: every declared property with its type, `NOT NULL` for `key` and `must_exist`. The source app's DDL then runs unchanged after it. | probes.txt, queries.txt |
| P2 | `ALTER CURRENT GRAPH TYPE SET` drops the constraints the store had (example 01's R16). | a UNIQUE constraint, then the ALTER: `SHOW CONSTRAINTS` no longer lists it | The graph type goes first and the DDL after it (`web/ddl.js` `schemaStatements`). | probes.txt |
| P3 | The graph type refuses what the ontology forbids, on every write: a property of the wrong type, a missing NOT NULL property, a relationship between the wrong labels, a relationship property of the wrong type. Properties it does not declare are allowed. | `MATCH (q:Product), (p:Person) CREATE (q)-[:CEO_OF]->(p)`: `ConstraintValidationFailed: endpoint label presence verification failed: expected Person` | The demo graph loads under it; the page and README show the ontology as an engine-enforced contract. The page never writes after loading, so the graph type guards the load. | probes.txt, native.txt (the same refusal natively) |
| P4 | Graph-type property types: STRING, INTEGER, FLOAT, BOOLEAN, DATE, DURATION, POINT, LOCAL/ZONED DATETIME and TIME, UUID, `LIST<T NOT NULL>` and `VECTOR<T>(n)` are accepted. ANY, `LIST<ANY>`, a list without `NOT NULL` elements, and the sized FLOAT32 and INTEGER8/16/32 are refused. | `ALTER CURRENT GRAPH TYPE SET {(:A => {x :: FLOAT32})}` | `web/ddl.js` `graphTypeOf` maps the spec's tokens: `LIST<STRING>` becomes `LIST<STRING NOT NULL>`, and `VECTOR<FLOAT32>` with its `dimension` becomes `VECTOR<FLOAT32>(1536)`. It refuses, by name, a token the engine refuses (`DdlError`). | probes.txt |
| P5 | `EXPLAIN` plans without running. Its `notifications` name unknown labels, relationship types and property keys (`Neo.ClientNotification.Statement.Unknown*Warning`). It returns no plan rows, flags no writes, and does not fail on a missing parameter. | `EXPLAIN MATCH (a:Corporation)-[:BUYS]->(b) RETURN b.nme` | `web/run.js` reports the notifications as advisory "Relate:" notes and does not block on them: a property the ontology declares but the data lacks is still a fair query. A query EXPLAIN cannot plan (a syntax error) is not run. | probes.txt, validate.txt, browser.txt |
| P6 | A read-only in-memory handle (`new RelateDb(true)`) starts empty and refuses writes. | `new RelateDb(true).execute('MATCH (n) RETURN count(n)')`: 0 | The store cannot be loaded and then made read-only in memory. Generated queries run on the writable in-memory store, behind the ontology check (no write clause passes it) and P7. | probes.txt |
| P7 | The envelope's `stats` counters move on a write and stay at zero for a read or a write that matches nothing. | `CREATE (n:Tmp) DELETE n`: `labels_added 1` | `web/run.js`: when a run's counters move, the store is rebuilt from the demo graph before anything else reads it, and the report says so. | probes.txt |
| P8 | An integral JS number binds as INTEGER; `toFloat()` makes it FLOAT (example 01's R5). | `RETURN valueType($x)` with `{x: 1}` | `web/load.js` sets `r.supported = toFloat($props.supported)`, so the graph type's `supported :: FLOAT` holds for every edge. | probes.txt, queries.txt |
| P9 | `SHOW CURRENT GRAPH TYPE` prints properties sorted by name, vector coordinates `NOT NULL`, no `{}` for an element without properties, and later KEY and UNIQUE constraints as `CONSTRAINT` items. | the readback after an ALTER and a KEY constraint | `web/ddl.js` writes the graph type in that canonical form, so the readback compares equal element for element (`readbackElements`). | probes.txt, queries.txt |

## Library behaviours

| id | behaviour | how the example copes | pinned by |
|---|---|---|---|
| Y1 | The Ontology Graph Spec SDK's YAML decoder misreads plain YAML. An unquoted `type: LIST<STRING>` throws `Neo4jType does not contain element with name ''`. An unquoted URL followed by a single-quoted scalar throws too, and js-yaml's output of example 01's documents fails in it throughout. | `lib/ogs.mjs` parses YAML with js-yaml and decodes the JSON (`GraphSpec.Json`). `data/corporate-events.ontology.yaml` quotes its two `<…>` tokens anyway (data/SOURCE.md). | example 01's ontology.txt |
| Y2 | The SDK's decoder ignores fields the spec does not have and accepts an integer `version`. | The page reads one known document. Example 01, which takes documents from its users, runs the spec's JSON Schema first. | example 01's ontology.txt |
| W1 | WebLLM 0.2.89 caches under fixed Cache API names (`webllm/model`, `webllm/config`, `webllm/wasm`, or the same paths in OPFS). Its `AppConfig` has no option to rename them. | The one exception to the repository's per-example storage prefix (ADR-0003, site/README.md). The caches are keyed by model URL, so any example on the origin that pinned the same model would share the download. The page's own names would carry `ex02`; it has none. | README |
| W2 | WebLLM 0.2.89 takes a JSON Schema as `response_format: {type: 'json_object', schema: '<the schema as a string>'}`, enforced by XGrammar. JSON mode wants the model told to answer in JSON. | `web/llm.js` `request` puts the schema there and adds one line to the user message. The system message stays the source app's briefing, byte for byte. | briefing.txt (the briefing), llm-eval (the replies) |
| W3 | WebLLM checks a ModelRecord's `integrity` (SRI hashes of the chat config, the model library and the tokenizer) before using the files. | `web/llm.js` pins all three for both models. The model library comes from `mlc-ai/binary-mlc-llm-libs` at a pinned commit (that repository has no licence file, so the library is fetched, never redistributed). | llm-eval |
| W4 | Headless Chromium (Playwright's) gets SwiftShader, without `shader-f16`, so it cannot run the q4f16 models. The system Chrome reaches the real GPU even headless (`channel: 'chrome'`). | CI runs the page in canned mode, and the browser section checks the no-WebGPU fallback. `harness/llm-eval.mjs` uses the system Chrome. | browser.txt |
| W5 | With thinking turned off (`extra_body.enable_thinking: false`), a Qwen3.5 reply's content still opens with the empty `<think>\n\n</think>` block the template prefills, before the JSON the schema constrains. | `web/llm.js` `parseReply` drops leading think blocks, then reads the JSON (the whole text, else its first `{…}` object), then a fenced or bare query, as the source app did. | validate.txt (the cases), llm-eval |

## Design ids

The ids that carry a larger decision point to its ADR in [`docs/adr/`](../../docs/adr/README.md).

- **D1** (ADR-0011) A port, not a rewrite: the source app's prompts (`text2cypher.build_schema_prompt`), static validator (`validate_cypher`), DDL (`cypher.all_statements`), A/B notes (`main._compare`), canned answers and demo graph come over unchanged. `harness/capture_reference.py` captures them from the source once, and `harness/run.mjs` holds the JavaScript ports to them byte for byte.
- **D2** (ADR-0013) The store is in memory, rebuilt on every visit (38 nodes and 43 relationships load in milliseconds). There is no OPFS store, so there is no lock between tabs (example 01's R11) and no store layout to migrate.
- **D3** Two queries per question, run one after the other: the ontology-grounded one first, shown as soon as it is checked and run, then the bare one, then the comparison.
- **D4** (ADR-0012) Without WebGPU (or with "canned answers" ticked, or `?llm=canned`), the page uses the source app's canned reference queries. Everything else (the checks, Relate, the comparison) runs the same, and that is the mode CI tests.
- **D5** (ADR-0012, ADR-0009) Two Apache-2.0 models: Qwen3.5 2B (the default) and Qwen3.5 4B. Qwen2.5-Coder-3B was considered and left out: its licence is not Apache-2.0. Neo4j's Text2Cypher fine-tune of Gemma 3 exists only as a community GGUF, which WebLLM cannot load.
- **D6** (ADR-0007) The ontology is read with the official SDK (`lib/ogs.mjs`, shared with example 01). The page needs `decode` and `core` clean and shows the SDK's other validation sets for information: `consistentSchema` wants an explicit database `name` on every property, and `mappable` checks the import mappings.
- **D7** "Repair once", off by default: a query the ontology check refuses or Relate cannot run goes back to the model once, with the issues or the error verbatim (`web/llm.js` `repairRequest`), and the repaired query is checked and run like any other. Both variants get it, so the comparison stays fair. It is off by default so the page compares what each prompt gets on the first try, as the source app did.
