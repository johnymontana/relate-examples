# Example 03: the behaviours it depends on

Every engine and library behaviour this example depends on or pins, one row each. The ids are what the code,
the harnesses and `expected/` cite. **Pinned by** names the file whose run fails when the behaviour
changes (a `PIN:` line on stderr, or a diff against `expected/`). Every row was checked on
2026-11-26 against Relate 1.3.0 (npm `@relate/relate-wasm@1.3.0` and the `relate-db` 1.3.0 binding),
NVL 2.0.0 and Transformers.js 4.3.2 (with the onnxruntime-web it pins, 1.31.0-dev.20260914), and
S1 to S3 against the Ontology Graph Spec SDK 0.13.0 (npm `@neo4j/ontology-graph-spec`). The rows
were first written on Relate 1.2.0 and SDK 0.12.2. Only M4 changed with 1.3.0 (an empty or
modified full-text query is refused, and a `WHERE` is accepted); M3 and the rest held. Another
change reaches the printed output and no row: a result row's keys come in the order of the
`RETURN`, not sorted (01's R4), which reordered the keys in one line of the rules' violations.

Rows of the other examples hold here too, where this one touches the same engine surface. From
example 01's `NOTES.md`: no transactions in WASM (R2), the JSON envelope (R4), an integral number
binding as INTEGER (R5), and a trap leaving the handle unusable (R14). From example 02's: a graph
type owns the existence constraints on its labels and an `ALTER` drops the constraints already
there (P1, P2), so the graph type is applied first. The rows below are this example's own.

## Engine behaviours (Relate 1.3.0)

| id | behaviour | minimal repro | how the example copes | pinned by |
|---|---|---|---|---|
| M1 | A graph type with typed properties, required ones (`text :: STRING NOT NULL`) and optional ones (`rationale :: STRING`, and a sized vector, `embedding :: VECTOR<FLOAT32>(384)`), refuses a malformed node or edge on every write. A missing required property: `ConstraintValidationFailed: … requires properties`. A vector of the wrong length, or a value of the wrong type: `… property type`. An edge between the wrong labels: `endpoint label presence verification failed: expected Memory`. A node without an optional property is accepted (its `embedding IS NULL`), and so is a property the type does not declare. | `CREATE (:Memory {id: 'oops', text: 'no kind'})` | `web/memory.js` `SCHEMA[0]` declares the whole memory model, so a bad extraction, a vector from a model of another size or a stray edge is refused by the engine instead of being stored. The vector is typed but not required, so a memory stored while the embedding model is unavailable is kept and found by its words (D3). The console offers two refusals as samples. | probes.txt, native.txt (natively), browser.txt (from the console) |
| M2 | Under a graph type, `MERGE (n:L {key: …}) ON CREATE SET …` may fill the required properties: the check runs when the statement ends, not when the node is created. A `MERGE` on the key alone is refused (`requires properties`). | `MERGE (s:Session {id: 'n'})` | Every write is a `MERGE` with `ON CREATE SET` (`REMEMBER_MESSAGE`, `REMEMBER_MEMORIES`), which keeps remember idempotent (ADR-0006) under the graph type. | probes.txt, scenarios.txt (every remember replayed) |
| M3 | `SEARCH n IN (VECTOR INDEX … FOR <vector> LIMIT k) SCORE AS s` returns the k nearest, with `s = (1 + cosine) / 2`: 1 for the same direction, 0.5 for no similarity. It returns k rows however poor the match, a zero vector returns none, `LIMIT` inside the search is required, and a plain list parameter is accepted as the query vector. A node without a vector is never returned. | the probe's four memories, with vectors made for it (b at a cosine of 0.4 to a; c and d at 0), searched with a's: `a 1, b 0.7, c 0.5, d 0.5` | `RECALL` filters `WHERE similarity >= $floor` (0.6, a cosine of 0.2: D3) after the search, so an unrelated memory is not a hit, and returns the cosine itself (`2 * s - 1`). A question without a vector is searched with a zero vector, which finds nothing and leaves the full-text search to answer. Vectors go through `toFloat()` (R5). | probes.txt |
| M4 | `SEARCH n IN (FULLTEXT INDEX … FOR <text> LIMIT k)` ORs the text's terms and matches whole words: no stemming ("test" does not find "tests"). Since 1.3.0 the text is a query, not just words. An empty or blank text is refused (`Invalid fulltext query '': the query is empty`; it found nothing on 1.2.0). A `-`, `+` or `!` modifier on a term, grouping parentheses and a quoted multi-word phrase are refused (`Invalid fulltext query term '-y': a `-` clause modifier is not supported`; `… 'kenji bun': a literal term the analyzer reads as several is a phrase, which is not supported`), `*` matches every memory, `?` stands for one character, and a text with no word in it (`%`) finds nothing. Upper-case `AND` makes it a conjunction. A `WHERE` inside the search is accepted (1.2.0 refused it: `WHERE cannot be used together with 'FULLTEXT INDEX'`), under the vector filter's rules: comparisons joined by `AND` (`WHERE m.current = true`, `m.seq > 1`), while a bare boolean (`WHERE m.current`) is refused with `InvalidSearchFilterPredicate`. | `… FOR 'kenji bun' LIMIT 8` finds the memory with either word; `… FOR '' LIMIT 8` is refused; `… FOR 'kenji bun' WHERE m.current = true LIMIT 8` keeps the current ones | `web/embed.js` `terms()` gives the search a question's content words only (letters and digits, lower case), so "what", "do" and "you" are not terms and no operator can reach the engine. When a question has no content word but has a vector, `recall` passes `NO_WORDS` (`%`, in `web/memory.js`) instead of the empty text, so the full-text list is empty and the vector search answers alone. The statement uses no `WHERE` in the search. The vector search, which matches by meaning, covers the word forms and synonyms the full-text search misses. | probes.txt |
| M5 | One statement can hold two `SEARCH`es joined by `UNION ALL` inside `CALL () { … }` (a branch may return `null` for a column the other fills), aggregates over the union (the reciprocal-rank sum, `collect` of which search found each memory, `max` of the similarity), a quantified path, and a second `CALL (now, history) { … UNION ALL … }` whose branches return lists built from two paths. | `web/memory.js` `RECALL` | recall is that one statement: an agent logs, replays and evaluates one string, and the page shows one. | probes.txt, scenarios.txt, native.txt (the same rows natively) |
| M6 | Quantified path patterns: `(seed)<-[:SUPERSEDES]-*(now)` matches the seed itself at length 0; a predicate inside the repeated part (`(m:Memory WHERE m.current)`) keeps a path off replaced memories; `ANY SHORTEST` keeps one path per pair of ends. | Kenji to bun: 2 paths, `ANY SHORTEST` 1; repo to pnpm, linked only by a replaced memory: 0 | `RECALL` follows a hit to its current version and walks out over current memories only; `CONNECT` returns one chain. | probes.txt |
| M7 | A path arrives as a flat list (node, relationship, node, …), every node whole, its vector included (`{dim, type, values}`, 384 numbers). `id(n)` and `id(r)` are the elements' integer ids, and native Relate assigns the same ids to the same writes. | `MATCH p = (m:Memory)-[:SUPERSEDES]->(o) RETURN p` | The tools return `[n IN nodes(p) \| id(n)]` and the relationship ids instead of the path: a few integers per row, which is all the page needs to light it. The console still shows whole paths, and summarises a vector as `<vector of 384>`. | probes.txt, native.txt |
| M8 | `SHOW CURRENT GRAPH TYPE YIELD specification` prints the graph type with labels, relationship types and constraints each in name order, every name in backticks, a vector as `VECTOR<FLOAT32 NOT NULL>(384)`, and the uniqueness constraints created after it. `SHOW CONSTRAINTS` lists what the graph type holds under names the engine makes up (`constraint_<hex>`): one `NODE_PROPERTY_TYPE` per declared property, one `NODE_PROPERTY_EXISTENCE` per `NOT NULL`, a `RELATIONSHIP_SOURCE_LABEL` and a `RELATIONSHIP_TARGET_LABEL` per relationship type; 55 with the four named uniqueness constraints, each of which owns a `RANGE` index of its own name. The graph type says nothing of a property's values or of how many relationships a node has: `MATCH (m:Memory) WHERE NOT m.current SET m.current = true` is accepted. | `SHOW CURRENT GRAPH TYPE YIELD specification RETURN specification AS s` after `web/memory.js` `SCHEMA` | `web/ontology.js` `graphType` spells the graph type the document describes the same way, and the run fails unless the two texts are equal (D10): the document then declares exactly what the engine enforces. The document names only the uniqueness constraints. What the graph type does not say is the document's rules (D11), checked by statements. | ontology.txt, browser.txt (the tab's status line) |

## Library behaviours (NVL 2.0.0)

Example 01's findings about NVL (its V3–V8) hold here too: how it is bundled, that it renders in
headless Chromium, and that its `d3Force` layout is deterministic. These are this example's own.

| id | behaviour | how the example copes | pinned by |
|---|---|---|---|
| N1 | The canvas renderer writes a node's caption inside its circle, at a size that follows the node's, and cuts what does not fit. `captionAlign` moves the text within the circle, not outside it. `captionSize` takes whole numbers: with 1.5 the caption is not drawn at all. A relationship's caption runs along its line and is cut to the line's length. | A memory is a node large enough to hold two or three words (radius 30, an entity 34 to 49), and its `gist` is that short. The full text is in the tooltip, the inspector and the list. Nodes are kept small against the gap the layout leaves between them, so a relationship has room for its type. | not pinned (what NVL paints) |
| N2 | The default `forceDirected` layout spreads a graph of 15 nodes so widely that `fit` zooms out until NVL stops drawing captions. `d3Force` keeps the same graph compact. | `layout: 'd3Force'`, in the page and in the test alike. | not pinned (what NVL paints) |
| N3 | `fit(ids)` leaves a small graph in about half the panel, and jumps there. Nodes added to a running layout keep it moving after `onLayoutDone` has fired for the earlier ones. Any update to a node (its size, its `selected` flag) sets the layout moving again; `pinned: true` holds a node where it is. | `web/graph.js` has its own camera: `frame()` measures the graph from `getNodes()` and `tick()` eases `setZoomAndPan` towards it until it arrives, then leaves the camera alone until the graph next changes (or for good, once the visitor zooms, pans or drags). While a path is being lit every node is pinned, so a pulsing node does not push its neighbours. | browser.txt (every node inside the panel once the layout rests) |
| N4 | `addAndUpdateElementsInGraph` adds what is new and restyles what is there; `selected` draws a ring (and a glow on a relationship) in `styling.selectedBorderColor`, `disabled` greys an element out in `styling.disabledItemColor`. `getNodes()` and `getRelationships()` return each element with those flags as they were last set. `restart(options, true)` redraws with new styling and keeps positions. | The highlight is nothing but those two flags. `stats()` reads them back, and the browser section checks them against the store and the returned paths after every turn, and again after a theme change. | browser.txt |
| N5 | NVL draws to canvases (two of them) and adds no element per node, so no selector can find a node. Ids must be strings, unique across nodes and relationships. | Elements are `n<id>` and `r<id>` from the engine's integer ids. Hover and click come from NVL's interaction handlers, and the tooltip and inspector are the page's own HTML. | browser.txt |

| N6 | NVL works in device pixels. On a screen with a pixel ratio of 2, a node of size s is drawn with a radius of 2s layout units and the layout leaves twice the gap, so proportions hold; a layout point p lands on the screen at `(p - pan) * scale / ratio + centre`; and `fit` picks about the same `scale` whatever the ratio, which draws everything at half size. | Sizes are plain CSS pixels and never multiplied by the ratio. The camera's arithmetic carries it: a node's radius is `size * ratio` when measuring, and the fitting scale is multiplied by the ratio, so the graph is the same size on any screen. Measured at ratios 1 and 2: the same scale, 1.2 for five nodes and about 0.83 for fifteen. | browser.txt (at ratio 1) |
| N7 | With `layout: 'free'` NVL moves nothing: a node stays where `setNodePositions` puts it, in layout units (N6), and stays there when it is restyled, selected or disabled. A relationship from a node to itself is drawn as a small loop, and its caption is cut to the loop (`SUPE…`). | The Ontology tab's picture (`web/ontology-tab.js`) uses the free layout: `web/ontology.js` `picture` says where each circle goes, in CSS pixels, and the tab multiplies by the pixel ratio. Nothing moves unless the visitor drags it, so the camera is set once per picture (`web/graph.js` `frameOf`, shared with the Memory tab). The loop's full name is in its tooltip and in the detail under the picture. Seen at ratios 1 and 2: the same picture. | browser.txt (every circle inside the panel after each label is opened, at ratio 1) |
| N8 | A caption's size is the node's diameter divided by a step that `captionSize` picks (1, 2 or 3), and smaller again for a longer caption. A word too long for its line is broken with a hyphen, and what does not fit is cut with an ellipsis: at size 2 a seven-letter word breaks (`Messag-e`), at size 1 it fits. Two captions on a node are joined with a comma. | In the picture a label is one word at size 1, and a property's name is drawn at size 3, where the long ones break (`super-seded…`): the tooltip and the table under the picture have every name whole. How many nodes the store holds of each label is a line of text under the canvas, not a second caption. | not pinned (what NVL paints) |

## Library behaviours (Transformers.js 4.3.2, onnxruntime-web 1.31.0-dev)

The embedding model in the tab (`web/embed.worker.js`, D3). `run.sh` is offline and never loads the
model, so these are pinned by a check run by hand, online: `node harness/drive.mjs --smoke --live`.

| id | behaviour | how the example copes | pinned by |
|---|---|---|---|
| T1 | Transformers.js keeps every file it fetches in the Cache API, under one name for any page on the origin (`transformers-cache`), keyed by the file's Hub URL, and looks there before fetching. It does not check what it fetched against anything. | `env.cacheKey = 'ex03-models'` (ADR-0003). The worker fetches the model's four files itself, checks each against the sha256 pinned in `web/embed.js` `MODEL`, and only then puts it in that cache at the URL the library will ask for. The library finds all four there and fetches nothing. A file that does not match is refused and the page falls back to words. | `--live`: the only requests to another origin are the worker's four, and a second tab makes none |
| T2 | The library imports `onnxruntime-web/webgpu`, whose loader asks for the WebGPU-capable `.wasm` (27 to 28 MB), and by default loads the runtime's files from jsDelivr. Without cross-origin isolation, which GitHub Pages cannot provide (ADR-0002), there is no `SharedArrayBuffer` and so one thread. | `build.mjs` bundles the library with `onnxruntime-web/webgpu` aliased to `onnxruntime-web/wasm`, so the 14.3 MB `ort-wasm-simd-threaded.wasm` ships and nothing else is asked for. `env.backends.onnx.wasm.wasmPaths` is the page's own versioned directory, `numThreads` is 1, and the pipeline's `device` is `'wasm'`. One short text takes 10 to 50 ms. | `--live`: the runtime's files come from the site; browser.txt: the scripted page requests none of them |
| T3 | Given a `revision`, the pipeline still asks for `config.json` and `tokenizer_config.json` at `main` as well. | `env.remotePathTemplate` names the pinned revision outright, so every request the library makes is for a file the worker has already verified and cached. | `--live` (no request leaves the cache) |
| T4 | The npm packages `onnxruntime-web` and `onnxruntime-common` say `"license": "MIT"` and carry the notice in their source headers, but ship no licence file. | `data/LICENSE-onnxruntime.txt` is the MIT License with the copyright line of those headers (Microsoft Corporation), shipped next to the runtime; `build.mjs` checks its sha256. | the build |
| T5 | The model is dynamically quantised (q8), and its output depends on more than the text. In a batch, a text's vector shifts with its neighbours: a batch of 16 against one text at a time differs by up to 0.017 per component (a cosine of 0.994 between the two). And onnxruntime's native kernels (Transformers.js in Node) and its WebAssembly ones (the tab) differ by up to 0.03 per component for the same text. The WebAssembly build, on one thread, gives the same numbers every time. | Both `harness/embed.mjs` and the worker embed one text at a time, and `harness/embed.mjs` makes `data/embeddings.json` with the page's own worker in headless Chromium, not with the library's Node backend. A text then has the same vector in the file and in a visitor's tab. | `--live`: the tab's vectors for all 52 texts of the file differ from it by 0; `harness/embed.mjs --check` |

## Library behaviours (Ontology Graph Spec SDK 0.13.0)

The SDK that examples 01 and 02 read their ontologies with (ADR-0007), here in the harness only:
`harness/run.mjs` validates `data/agent-memory.ontology.json` through `lib/ogs.mjs` (D10). Example
01's Y1 (the SDK's YAML decoder) does not arise: the document is JSON.

| id | behaviour | minimal repro | how the example copes | pinned by |
|---|---|---|---|---|
| S1 | The decoder ignores a field the specification does not have (example 01's Y2): a misspelt `must_exist` decodes, and every validation set passes. | a property `{"type": "STRING", "requried": true}` | The SDK's own encoding of the document keeps only what it understood. The run compares it with the document as written, field by field, and lists what is missing with the reason (S2). Any other missing field fails the run as one the specification does not have. | ontology.txt |
| S2 | The encoder writes the long form and leaves out defaults: `label` becomes `labels.identifier`, `must_exist: true` an `EXISTS` constraint named `<property>_<Label>_exists`, and `vector.similarity_function: cosine`, the default, is dropped. | `GraphSpec.Json.encodeToString(GraphSpec.Json.decodeFromString(text))` | `web/ontology.js` reads the document as written and takes either form (`labelOf`, `constraintsOf`). The names the SDK gives the constraints it expands are not the engine's (M8), which is why the document writes `must_exist` short and names nothing but the uniqueness constraints. | ontology.txt (4 `label`, 19 `must_exist`, 1 default) |
| S3 | The `consistentSchema` validation set reports `missing_property_name` for every property that does not set `name`, though the specification makes `name` optional. | validate a document whose properties have no `name` with `Validations.consistentSchema` | Every property names itself (`"name": "kind"`), so the document passes all six sets. | ontology.txt |

## Design ids

The ids that carry a larger decision point to its ADR in [`docs/adr/`](../../docs/adr/README.md).

- **D1** (ADR-0017) The agent is scripted. A scenario file (`data/scenarios/*.json`, described in
  `data/SOURCE.md`) carries, per turn, what a model would have produced: the extraction for the
  user's message and the reply. `web/agent.js` runs the tools in between. A reply cites memories as
  `[[id]]`, and may cite only what its tool returned: `harness/run.mjs` fails on any other citation.
- **D2** (ADR-0016) The memory model follows Relate's cookbook recipes on agent memory, with these
  differences: one `:Memory` label with a `kind` (fact, decision, preference, note) instead of
  `:Fact` and `:Decision`, so that a graph type can declare every endpoint (01's R16); a `current`
  flag beside `supersededAt`; a `gist` of two or three words, which is what the graph draws; an
  explicit `id`; and a vector on each memory, typed by the graph type but not required (M1).
- **D3** (ADR-0017) The vectors are real: all-MiniLM-L6-v2, 8-bit quantised, 384 dimensions,
  mean-pooled and normalised (`web/embed.js` `MODEL` pins the revision and each file's sha256). The
  vector of every text the scripts use is in `data/embeddings.json`, made by `harness/embed.mjs`:
  each memory, each recalled question, each suggested message and the typed turns of the
  regression run. The page and the run read that file, so the scripted conversations load no
  model. A text the visitor types is embedded in the tab by the same model (`web/embed.worker.js`,
  T1 to T5), which is fetched the first time it is needed: 23 MB from the Hugging Face Hub and the
  15 MB runtime from the site, a few seconds on a fast connection, then cached. `?test=1` keeps
  the model off, and `?embed=off` or `?embed=live` overrides either way. Without a vector a text
  is stored and searched by its words, and the page says so. A vector hit needs a cosine of at
  least 0.2 (`RECALL_DEFAULTS.floor`, 0.6 on the engine's scale: M3): the model gives about 0 to
  unrelated sentences and 0.2 to 0.9 to a question and the memory that answers it. `probes.txt`
  prints pairs on both sides of that line.
- **D4** (ADR-0016) The store is in memory and rebuilt whenever a conversation starts or restarts.
  A new session is a divider in one conversation on one store. Typed turns go into a third session,
  "Your turn". Only messages that taught something are stored: a question leaves no `:Message`.
- **D5** (ADR-0015) The graph is drawn with NVL 2.0.0 (`web/graph.js`). An entity is a large node
  carrying its name, coloured by kind, and it grows with each current memory about it (up to
  five), so what the conversation keeps returning to stands out. A memory is a smaller node between
  the entities it is about, carrying its gist; a replaced memory is smaller and paler, with its
  gist in italics. Every relationship drawn carries its type: `ABOUT`, `SUPERSEDES`, `FROM`,
  `IN_SESSION`. Messages and sessions are provenance, hidden until asked for or until a highlighted
  path runs through them. `MENTIONS` relationships are stored and never drawn. A highlight is NVL's
  own `selected` and `disabled` (N4). Three things move: a new node grows in; the camera eases to
  keep the whole graph in view (N3, N6); a lit path is selected hop by hop, each node pulsing as
  the path reaches it. With `?test=1` or reduced motion, none of it is animated.
- **D6** (ADR-0017) The page draws only what the engine returns. The graph is `snapshot()` after
  each tool call. The highlight is the paths the tool's rows carry: a row the reply cites is
  selected, with the entities its memory is about; what the other rows touch is left as it is; the
  rest is disabled. The list ("What it knows") is read from the same snapshot.
- **D7** recall's ranking. Each search keeps 4; a memory's score is the sum of `1 / (60 + rank)`
  over the lists that found it; the best 4 are followed to their current versions; a memory reached
  through the graph scores half its seed's score per entity crossed, up to two entities away; the
  best path per memory wins and 8 rows come back. `via` says how each was reached: `search`,
  `update` (the current version of a hit that had been replaced) or `graph`. `by` says which
  search found the row's seed (`meaning`, `words` or both) and `similarity` is the seed's cosine
  with the question: the page's badge on each row ("meaning 0.40", "words", "graph").
- **D8** Typed turns have rules, not a model (`web/agent.js` `freeTurn`). Text that ends in a
  question mark or opens with a question word is a question: it goes to `connect` when it names two
  known entities and asks how they are linked, to `recall` otherwise, and on to `trace` when it
  asks for a source ("how do you know…"). Anything else is stored as a `note`, linked to the
  entities whose names it contains. The question or the note gets its vector as D3 says.
  `expected/typed.txt` has one of each, and a note and a question without a vector.
- **D9** (ADR-0015) The page follows the Relate brand kit v1.0 (`data/brand/README.txt`, supplied
  by the repository owner). Colours: navy, cyan, lime, blue, forest and white, declared in
  `web/style.css` as the kit's `relate-colors.json` gives them (`build.mjs` checks); dark is white
  on navy with cyan, light is navy on white with blue; surfaces and lines are navy stepped towards
  white, and the graph's two paler entity colours are blue and forest stepped the same way. The one
  colour outside the kit is `--danger`, for an engine error. Type: Public Sans (headings SemiBold,
  body Regular) and IBM Plex Mono for code, shipped from their fontsource packages. The logo is the
  supplied artwork, never retyped: white on navy, navy on white, 123px wide (the kit's minimum is
  120), with the kit's clear space. The favicon is the kit's. Archie, the mascot, appears once, in
  the empty memory, in the flair version on navy and the plain one on white. The "by Neo4j" lockup
  is not used.
- **D10** The memory model is also written down as a document of the Neo4j Ontology Graph
  Specification 1.1 (`data/agent-memory.ontology.json`; `data/SOURCE.md` says what it holds). It
  describes `web/memory.js` `SCHEMA` and adds what a schema cannot say: what each label, property
  and relationship type means, and the rules the engine does not enforce. `SCHEMA` stays what the
  engine is given. Example 02 derives its graph type from its ontology (ADR-0013); here the schema
  statements are themselves something the page shows and `expected/statements.cypher` pins, so
  they stay as written, and the run fails when the two stop agreeing: the graph type derived from
  the document (`web/ontology.js` `graphType`) must be the engine's own, byte for byte, and the
  engine's 55 constraints and two search indexes must be the ones the document lists (M8). The
  rules the engine does not enforce are held against every store the conversations build, after
  every turn (`expected/ontology.txt`). The harness validates the document through the
  specification's SDK and `lib/ogs.mjs`, as ADR-0007 has it (S1 to S3). The page reads the same
  file as written and does not ship the SDK: the document is fixed and already checked, and the
  SDK is 0.6 MB as example 02 ships it. What this repository adds to the document sits under
  `extensions.custom.relate-examples`, as the specification asks of custom data.
- **D11** The Ontology tab shows that document (`web/ontology-tab.js`), and everything it knows of
  it comes from `web/ontology.js`, which the harness calls too:
  - **The picture**, drawn with NVL in its free layout (N7, N8): a circle per label where the
    document's `display` puts it, a relationship per relationship type, and the properties of the
    label that is open on an arc on its far side from the others.
  - **Search** over names, aliases, allowed values and descriptions. Every word typed must be
    found, whole or as the beginning of a word, and what was found is left lit in the picture.
  - **One part's detail**: what the document says of it, what the engine enforces of it, and a
    link that lights the nodes or relationships it describes in the Memory tab. A node's
    inspector there links back to its label.
  - **The rules the engine does not enforce**: a property's allowed values and pattern, the
    number of relationships at each end, the document's five invariants, and that nothing stored
    is undeclared. Each is a statement that returns its violations, run when the visitor asks:
    a check is 18 statements, logged under the hood as `check`, which is why it does not run
    after every turn. A verdict is marked as of another store once the store changes. The
    console's last sample is a write the graph type accepts and two rules catch.
  - **The questions the document lists**, each run on the store when clicked (logged as `ask`).
    A parameter says which property it takes a value of, and the tab starts it on a value the
    store holds (`bind`): the document's example when the store has it, else the best-connected
    node.
  The tab only reads. Its statements go through the worker's `read` op.
