# Example 03: the behaviours it depends on

Every engine and library behaviour this example depends on or pins, one row each. The ids are what the code,
the harnesses and `expected/` cite. **Pinned by** names the file whose run fails when the behaviour
changes (a `PIN:` line on stderr, or a diff against `expected/`). Every row was checked on
2026-11-24 against Relate 1.2.0 (npm `@relate/relate-wasm@1.2.0` and the `relate-db` 1.2.0 binding)
and NVL 2.0.0.

Rows of the other examples hold here too, where this one touches the same engine surface. From
example 01's `NOTES.md`: no transactions in WASM (R2), the JSON envelope (R4), an integral number
binding as INTEGER (R5), and a trap leaving the handle unusable (R14). From example 02's: a graph
type owns the existence constraints on its labels and an `ALTER` drops the constraints already
there (P1, P2), so the graph type is applied first. The rows below are this example's own.

## Engine behaviours (Relate 1.2.0)

| id | behaviour | minimal repro | how the example copes | pinned by |
|---|---|---|---|---|
| M1 | A graph type with typed properties, a sized vector among them (`embedding :: VECTOR<FLOAT32>(256) NOT NULL`), and optional typed ones (`rationale :: STRING`) refuses a malformed node or edge on every write. A missing required property: `ConstraintValidationFailed: … requires properties`. A vector of the wrong length, or a value of the wrong type: `… property type`. An edge between the wrong labels: `endpoint label presence verification failed: expected Memory`. A property the type does not declare is accepted. | `CREATE (:Memory {id: 'oops', text: 'no kind, no vector'})` | `web/memory.js` `SCHEMA[0]` declares the whole memory model, so a bad extraction, a vector from the wrong model or a stray edge is refused by the engine instead of being stored. The console offers both refusals as samples. | probes.txt, native.txt (natively), browser.txt (from the console) |
| M2 | Under a graph type, `MERGE (n:L {key: …}) ON CREATE SET …` may fill the required properties: the check runs when the statement ends, not when the node is created. A `MERGE` on the key alone is refused (`requires properties`). | `MERGE (s:Session {id: 'n'})` | Every write is a `MERGE` with `ON CREATE SET` (`REMEMBER_MESSAGE`, `REMEMBER_MEMORIES`), which keeps remember idempotent (ADR-0006) under the graph type. | probes.txt, scenarios.txt (every remember replayed) |
| M3 | `SEARCH n IN (VECTOR INDEX … FOR <vector> LIMIT k) SCORE AS s` returns the k nearest, with `s = (1 + cosine) / 2`: 1 for the same direction, 0.5 for no similarity. It returns k rows however poor the match, a zero vector returns none, `LIMIT` inside the search is required, and a plain list parameter is accepted as the query vector. | the probe's four memories, searched with one memory's own text: `a 1, b 0.702, c 0.5, d 0.5` | `RECALL` filters `WHERE similarity >= $floor` (0.56) after the search, so an unrelated memory is not a hit. `recall()` does not run at all for a question with no content words. Vectors go through `toFloat()` (R5). | probes.txt |
| M4 | `SEARCH n IN (FULLTEXT INDEX … FOR <text> LIMIT k)` ORs the text's terms and matches whole words: no stemming ("test" does not find "tests"). Punctuation in the text is harmless, and an empty text finds nothing. It takes no `WHERE`. | `… FOR 'kenji bun' LIMIT 8` finds the memory with either word | `web/embed.js` `terms()` gives the search a question's content words only, so "what", "do" and "you" are not terms. The vector list, which hashes character trigrams, covers the word forms the full-text list misses. | probes.txt |
| M5 | One statement can hold two `SEARCH`es joined by `UNION ALL` inside `CALL () { … }`, an aggregate over the union (the reciprocal-rank sum), a quantified path, and a second `CALL (now, history) { … UNION ALL … }` whose branches return lists built from two paths. | `web/memory.js` `RECALL` | recall is that one statement: an agent logs, replays and evaluates one string, and the page shows one. | probes.txt, scenarios.txt, native.txt (the same rows natively) |
| M6 | Quantified path patterns: `(seed)<-[:SUPERSEDES]-*(now)` matches the seed itself at length 0; a predicate inside the repeated part (`(m:Memory WHERE m.current)`) keeps a path off replaced memories; `ANY SHORTEST` keeps one path per pair of ends. | Kenji to bun: 2 paths, `ANY SHORTEST` 1; repo to pnpm, linked only by a replaced memory: 0 | `RECALL` follows a hit to its current version and walks out over current memories only; `CONNECT` returns one chain. | probes.txt |
| M7 | A path arrives as a flat list (node, relationship, node, …), every node whole, its vector included (`{dim, type, values}`, 256 numbers). `id(n)` and `id(r)` are the elements' integer ids, and native Relate assigns the same ids to the same writes. | `MATCH p = (m:Memory)-[:SUPERSEDES]->(o) RETURN p` | The tools return `[n IN nodes(p) \| id(n)]` and the relationship ids instead of the path: a few integers per row, which is all the page needs to light it. The console still shows whole paths, and summarises a vector as `<vector of 256>`. | probes.txt, native.txt |

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

## Design ids

The ids that carry a larger decision point to its ADR in [`docs/adr/`](../../docs/adr/README.md).

- **D1** (ADR-0014) The agent is scripted. A scenario file (`data/scenarios/*.json`, described in
  `data/SOURCE.md`) carries, per turn, what a model would have produced: the extraction for the
  user's message and the reply. `web/agent.js` runs the tools in between. A reply cites memories as
  `[[id]]`, and may cite only what its tool returned: `harness/run.mjs` fails on any other citation.
- **D2** (ADR-0016) The memory model follows Relate's cookbook recipes on agent memory, with these
  differences: one `:Memory` label with a `kind` (fact, decision, preference, note) instead of
  `:Fact` and `:Decision`, so that a graph type can declare every endpoint (01's R16); a `current`
  flag beside `supersededAt`; a `gist` of two or three words, which is what the graph draws; an
  explicit `id`; and a vector on every memory.
- **D3** (ADR-0014) The embedder is a stand-in, `web/embed.js`: a text's content words (weight 1)
  and their character trigrams (weight 0.5), hashed with FNV-1a into 256 signed buckets and
  L2-normalised. It scores shared wording, not meaning. `probes.txt` prints what it does and does
  not find.
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
- **D6** (ADR-0014) The page draws only what the engine returns. The graph is `snapshot()` after
  each tool call. The highlight is the paths the tool's rows carry: a row the reply cites is
  selected, with the entities its memory is about; what the other rows touch is left as it is; the
  rest is disabled. The list ("What it knows") is read from the same snapshot.
- **D7** recall's ranking. Each search keeps 4; a memory's score is the sum of `1 / (60 + rank)`
  over the lists that found it; the best 4 are followed to their current versions; a memory reached
  through the graph scores half its seed's score per entity crossed, up to two entities away; the
  best path per memory wins and 8 rows come back. `via` says how each was reached: `search`,
  `update` (the current version of a hit that had been replaced) or `graph`.
- **D8** Typed turns have rules, not a model (`web/agent.js` `freeTurn`). Text that ends in a
  question mark or opens with a question word is a question: it goes to `connect` when it names two
  known entities and asks how they are linked, to `recall` otherwise, and on to `trace` when it
  asks for a source ("how do you know…"). Anything else is stored as a `note`, linked to the
  entities whose names it contains. `expected/typed.txt` has one of each.
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
