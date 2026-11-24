# 03 · The Relate playground as an agent's memory: a chat, Relate WASM, and the graph it fills, drawn with NVL

A conversation on the left, the agent's memory on the right. As the conversation goes on, the agent
writes what it learns into Relate, and the memory grows as a graph in front of you. In a later
session the agent is asked something, reads its memory back, and the page lights the paths that
read returned.

This is a new take on the [Relate playground](https://relatedb.ai/playground/). That page is a
query editor over a sample social graph. It shows that Relate runs Cypher, and it looks like the
console of a graph database. This one shows what Relate is for: a database an agent keeps inside
its own process and thinks with. The Cypher is still there, one tab away. The page wears Relate's
own brand: its colours, typefaces, logo and mascot.

- **The agent is scripted.** Its replies, and the entities and memories it extracts from each
  message, are written ahead of time: the two things a language model would produce. No language
  model runs on the page, so it starts at once in any browser.
- **Its memory is real.** Every remember and recall is a statement that Relate 1.2.0, compiled to
  WebAssembly (npm `@relate/relate-wasm`), runs in the tab. A graph type makes the shape of a
  memory something the engine enforces. Recall is one statement: a vector search and a full-text
  search, fused, then two steps through the graph.
- **Its vectors are real too.** Every memory and every question is embedded with all-MiniLM-L6-v2,
  a 23 MB sentence-embedding model, so recall matches by meaning: "Who should I page about a
  billing outage?" finds "Dana owns the payments service", which shares no word with it. The
  scripts' vectors are computed ahead of time and come with the page; what you type is embedded
  by the same model in the tab, fetched the first time you type.
- **The page draws what the engine returns.** The graph is the store after each call, drawn with
  NVL, the Neo4j Visualization Library. The highlight is the paths the recall statement returned. A scripted reply may cite only memories its tool
  returned, and the run fails on any other citation.

Live: <https://johnymontana.github.io/relate-examples/03-wasm-agent-memory/> (deployed by the first
push to `main` that contains this example and passes CI).

The ids cited below are defined in [NOTES.md](NOTES.md): `M1`… are the Relate 1.2.0 behaviours this
example pins, and `D1`… its design decisions. The larger decisions are ADRs in
[`docs/adr/`](../../docs/adr/README.md):
- this example's own:
  - ADR-0017: a scripted agent, a real memory and real vectors (it supersedes ADR-0014);
  - ADR-0015: the graph drawn with NVL, the page in Relate's brand;
  - ADR-0016: one typed `:Memory` label, in a store that lives in memory;
- the repository's, which it follows: ADR-0002 to ADR-0006, ADR-0008 and ADR-0009.

```bash
./run.sh              # offline, a few seconds: Node, then Chromium, then native Relate; diffed against expected/
./run.sh --site       # build dist/ and serve it at http://127.0.0.1:8703/relate-examples/03-wasm-agent-memory/ as Pages would
./run.sh --update     # accept this run's output as expected/
node harness/embed.mjs                  # after changing a scripted text: recompute data/embeddings.json (--check compares)
node harness/drive.mjs --smoke --live   # by hand, online: the embedding model in the tab (fetches 23 MB from the Hugging Face Hub)
```

## Using the page

Pick one of three conversations, each two sessions and nine or ten turns:

| Conversation | What it shows |
|---|---|
| A teammate that remembers | An assistant hears who leads what and which database was chosen. Three days later it knows, and notices that the decision has since changed. Asked whom to page about a billing outage and whether anyone is unavailable, in words it was never told, it finds the memories by meaning and the people affected through the graph. |
| A travel planner | A planner hears a few preferences. Asked later about dietary needs and about spending on accommodation, words none of its memories use, it finds them by meaning, and the graph adds who they apply to. |
| A coding agent's notes | A coding agent is told a repository's house rules. With an empty context the next day, it recalls where tests go, how to run them and whose module it is about to touch, and answers questions about invoicing and sign-in from the rules for the billing and auth modules. |

| Part of the page | What it does |
|---|---|
| The conversation | **Send the next message** plays one turn, **Play** plays the rest. Between the user's message and the reply, a card shows each thing the agent did with its memory: **remember** (what it stored), **recall** (what it found, and how each row was found: by meaning, with its cosine similarity to the question, by its words, or through the graph), **connect** (the chain between two entities) or **trace** (the message a memory came from). Each card opens to the statements Relate ran. A numbered mark in a reply is a citation: click it to see that memory in the graph. |
| Your own turns | Type a question and it goes to the same recall statement. Type anything else and it is stored as a note, linked to the entities it names. Rules decide which, not a model (D8), and the reply says so. Your text does get a real vector: the first time you type something the scripts did not foresee, the page fetches the embedding model (23 MB from the Hugging Face Hub, then cached) and embeds it in the tab; a line under the box says how it went. If the model cannot be loaded, your text is stored and searched by its words. Nothing you type leaves the tab. |
| Memory | The store, drawn with NVL. A large node is an entity, coloured by kind, and it grows as more is learnt about it. A smaller node between entities is a memory, carrying two or three words of it. A paler one has been replaced, and the memory that replaced it points at it. Every relationship shows its type (`ABOUT`, `SUPERSEDES`, and with provenance on, `FROM` and `IN_SESSION`). New nodes grow in, and the view eases to keep the whole graph in the panel. After a recall, the paths it returned are selected hop by hop, each node pulsing as the path reaches it, everything else steps back, and the caption says what you are looking at. Hover a row in a recall card to see that row's path alone. Hover a node for its text, click it for its details, drag it, zoom and pan. **Messages and sessions** adds the provenance. |
| What it knows | The same store as a list: what the agent believes now about each entity, and what each belief replaced. |
| Under the hood | Every statement run, in order, with its parameters, counters and time. The graph type as the engine reads it back. A box to run your own Cypher on the same store: two of the samples are writes the graph type refuses. Nodes and paths in a result are highlighted in the graph. |

URL parameters: `?scenario=team|trip|code`, `?autoplay=1`, `?test=1` (no animation, no pacing and
no model in the tab: the browser section's mode), `?embed=off|live` (the model in the tab off or
on, whatever `?test` says).

## What a turn does

`web/agent.js` runs each turn the same way, whether it comes from a script or from the input box.
The engine worker and the Node harness call the same code.

1. **Read memory.** A turn that asks something calls one tool: `recall` with the user's words and
   their vector, `connect` with two entity names, or `trace` with a memory's id.
2. **Write memory.** A turn that tells something calls `remember` with the message and its
   extraction: three statements (the message and its entities; the memories, each with its vector;
   the supersessions).
3. **Reply.** A scripted reply is text with `[[memory-id]]` citations, resolved against what step 1
   returned. A typed turn's reply is assembled from the tool's rows.

After every tool call the worker returns the statements that ran and the whole store, and the page
redraws from that.

## The memory

```
(:Message)-[:IN_SESSION]->(:Session)      what was said, and in which conversation
(:Message)-[:MENTIONS]->(:Entity)         the people, projects and places a message names
(:Memory)-[:FROM]->(:Message)             a fact, decision, preference or note, and where it came from
(:Memory)-[:ABOUT]->(:Entity)             what it is about: a memory links the entities it names
(:Memory)-[:SUPERSEDES]->(:Memory)        a newer memory in the same slot; nothing is deleted
```

The model follows Relate's cookbook recipes on agent memory (`data/SOURCE.md`); D2 lists what is
different here. `web/memory.js` holds the schema and every statement, and
[`expected/statements.cypher`](expected/statements.cypher) prints them as the page runs them.

**A graph type declares all of it**: four labels, five relationship types, every property with its
type, the vector as `VECTOR<FLOAT32>(384)`. The engine then refuses, on every write, a
memory without its text or its kind, a vector of the wrong length, and an `ABOUT` edge between two
entities (M1). The vector is typed but not required, so a memory can be stored before it has one. The model has one `:Memory` label with a `kind`, not a label per kind, because a
graph type takes one source label per relationship type (ADR-0016). After the graph type come four
uniqueness constraints, a vector index on `Memory.embedding` (cosine) and a full-text index on
`Memory.text`.

**A memory with a slot replaces the current one in that slot.** "Use CockroachDB for the checkout
rewrite" has the slot `checkout rewrite/database`, as "Use Postgres…" had. The older memory gets
`current = false` and a `supersededAt`, and the newer one points at it with `SUPERSEDES`. Nothing
is deleted, so the agent can say what used to be true.

**The store is in memory** and rebuilt when a conversation starts (D4). What the page calls a new
session is a divider in one conversation on one store: the agent's context is empty by
construction, since a scripted turn sees nothing but its own tool's rows. In an application, the
two sessions would be two processes opening one `agent.rl` file. A store that outlives the tab
(OPFS) was left out of this version (ADR-0016).

## Recall, in one statement

`RECALL` in `web/memory.js` (M5):

1. **Two searches** over every memory, current or not: the vector index, by meaning (keeping hits
   whose cosine similarity with the question is at least 0.2: M3, D3), and the full-text index, by
   words (M4). Each list is ranked, and the two are fused by reciprocal rank, so a memory both
   searches found comes first. Each row says which search found it, and how similar it was.
2. **Each of the best four is followed to its current version**, along `SUPERSEDES` (M6). A search
   may well find what used to be true. Asked "Did we pick Postgres for checkout?", the best match
   is the Postgres decision, and the graph knows it was replaced: the row that comes back is the
   CockroachDB decision, marked `update`, with the Postgres one as what it replaced.
3. **From there, out through shared entities**, up to two entities away, over current memories
   only. A memory reached this way scores half its seed's score per entity crossed (D7).

Every row carries the path that reached it, as node and relationship ids (M7), and the entities
the memory is about. That is what the page selects in NVL (N4).

The first step is why the vectors matter, and the third is why the memory is a graph. "Who should
I page about a billing outage?" shares no word with anything the agent was told, so the full-text
search finds nothing. The vector search finds four memories: Dana owns the payments service (a
cosine of 0.40), the checkout rewrite depends on it, Priya leads the rewrite, and Tomás works on
it. Nobody said Tomás is unreachable, and no search finds it: the memory that he is away next week
comes back through the graph, one entity away from the memory that he works on the rewrite.
[`expected/scenarios.txt`](expected/scenarios.txt) has every row of every recall, with its score,
how it was found and its path.

## What is scripted, and what an application would change

| On this page | In an application |
|---|---|
| The extraction for each message is in the scenario file (`remember.entities`, `remember.memories`). | A language model returns it as structured output. |
| The reply is in the scenario file, with citations checked against the tool's rows. | A language model writes it from the tool's rows. |
| Vectors come from all-MiniLM-L6-v2 (D3): from `data/embeddings.json` for the scripts' texts, from the model in the tab for typed ones. | The same call, to whichever embedding model the application uses. The index, the search and the recall statement take whatever vectors they are given; the graph type's dimension changes with the model. |
| A typed message is routed by rules (D8). | The model chooses the tool. |
| The schema, the three remember statements, and the recall, connect and trace statements | The same. Over `relate serve --mcp` they are `write_cypher` and `read_cypher` calls. |

## Setup

From the repository root, the shared setup (README.md): `uv sync` (the `relate-db` 1.2.0 binding,
for the native section). Then:

```bash
cd examples/03-wasm-agent-memory
ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=peer   # exact pins: @relate/relate-wasm 1.2.0, NVL 2.0.0, Transformers.js 4.3.2, the two typefaces, esbuild 0.28.2, playwright 1.63.0
npx playwright install chromium    # Playwright 1.63.0's Chromium, for the browser section (the same as examples 01 and 02)
./run.sh
```

- **Pins.** The Relate WASM bundle is pinned by its npm integrity in `package-lock.json`, and
  `lib/relate_wasm.mjs` refuses one that does not report 1.2.0. NVL and the two typefaces are
  pinned exactly in `package.json` and by integrity in the lockfile. `--omit=peer` skips NVL's
  unused neo4j-driver peer. The brand files are in `data/brand/` (`data/SOURCE.md`).
  Transformers.js is pinned the same way, and brings the onnxruntime-web it was built against.
  It also depends on `onnxruntime-node`, which nothing here loads: `ONNXRUNTIME_NODE_INSTALL=skip`
  stops that package's install script from fetching CUDA libraries on linux.
  The embedding model is pinned in `web/embed.js` `MODEL`: its Hub revision and the size and
  sha256 of each of its four files. `data/embeddings.json` names the model it was made with, and
  `build.mjs` refuses one made with another.
- **The embedding model is never needed to run or build.** `harness/embed.mjs` needs it, by hand,
  when a scripted text changes: it fetches the four files into `<repo>/.cache/ex03-embedder/`
  once, then works offline.
- **A new Relate release** moves with the repository's other pins (ADR-0005; AGENTS.md, "Engine
  pins move together"): here `package.json` and its lockfile, `ver` in `run.sh`, and `RELATE` in
  `web/memory.js` and `build.mjs`. Re-run `./run.sh` and re-check every NOTES.md row.
- **Node** 20 or later.

## `run.sh`

| Mode | Does |
|---|---|
| *(none)* | Offline: the Node sections, then the browser section, then the native section; diffs `out/` against `expected/`. |
| `--update` | Rewrites `expected/` from this run. Read the diff first. |
| `--site` | `npm run build`, then serves `dist/` at `/relate-examples/03-wasm-agent-memory/` as GitHub Pages does (`lib/serve.mjs`; `EX03_PORT`, default 8703). |

**`EXAMPLES_REQUIRE` keys.** Without a key, a missing piece prints `SKIP:` with the fix and exits 0.
When `EXAMPLES_REQUIRE` names the key, it fails instead (CI names both).

| Key | Needs | Without it |
|---|---|---|
| `wasm` | Node 20+, the Relate bundle reporting 1.2.0, every npm package at its pin | the whole example SKIPs |
| `browser` | Playwright's Chromium | the browser section is skipped (a note on stderr) |

The native section needs the project env's `relate-db` 1.2.0 (`uv sync`); another version fails.

### What the run checks

| File | From | What |
|---|---|---|
| `statements.cypher` | `harness/run.mjs` | The schema and the statement behind each tool, as the page runs them. |
| `scenarios.txt` | `harness/run.mjs` | All three conversations through `web/agent.js` and `web/memory.js` on Relate 1.2.0 WASM: every tool call's rows (score, how each memory was reached, its path), what each remember stored, every reply and its citations. Then every remember run a second time, which must change nothing. |
| `typed.txt` | `harness/run.mjs` | Twelve turns nobody scripted: questions, one that shares no word with the note it finds, one that asks for a source, two entities to connect, notes that name known entities; then a note and a question that have no vector, stored and found by their words. |
| `probes.txt` | `harness/run.mjs` | M1–M7, each a minimal repro on Relate 1.2.0 WASM, with vectors made for the probe so every similarity is known exactly. Then what the model's vectors say about eight pairs of the scripts' texts: five that share no word and are found by meaning, one found both ways, two unrelated. |
| `browser.txt` | `harness/drive.mjs` | The page in headless Chromium against `dist/` at the Pages sub-path, with its production CSP: boot; the logo and both typefaces loaded; every scripted turn (equal to the Node section's, with what NVL holds equal to the store, what NVL has selected equal to the returned paths, and the rest disabled); the buttons; typed turns, found by meaning with the vectors that come with the page, and two without a vector, found by words; the list; the console, with two refused writes and a result whose paths get highlighted; the toggles, a theme change among them; the whole graph inside the panel once the layout rests (N3); nothing requested from any other origin; no console errors or CSP violations. NVL draws to a canvas, so these read NVL's own state, not pixels (N4, N5). |
| `native.txt` | `harness/native.py` | Every statement the conversations ran (55), replayed on native Relate 1.2.0 with the same parameters: the same rows, ids, scores and paths included. The graph type refuses the same writes natively. |

## The GitHub Pages site

`dist/` follows the site contract (site/README.md, ADR-0002):
- One CSP `<meta>`: `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`,
  `connect-src 'self' https://huggingface.co https://*.hf.co`. The scripted conversations fetch
  nothing from any other origin. The embedding model's four files come from the Hugging Face Hub
  the first time the visitor types something the page has no vector for (`site.json` `connect`).
- Relative URLs only.
- Every dependency in a versioned `assets/<name>-<version>/` directory, with its licence:
  - `relate-1.2.0`, 6.9 MB, of which the WASM is 2.6 MB compressed;
  - `nvl-2.0.0`, 1.3 MB;
  - `transformers-4.3.2`, 14.9 MB (3.9 MB compressed): Transformers.js and onnxruntime-web's
    WebAssembly build, requested only when the embedding model is (T2);
  - `public-sans-5.3.0` and `ibm-plex-mono-5.3.0`;
  - `relate-brand-1.0`: the logo, favicons and mascot.
- `data/embeddings.json`, 169 kB (54 kB compressed): the scripts' vectors.
- 58 files, 23.9 MB (7.0 MB compressed). Without the embedding runtime, which a visit that only
  plays the scripts never requests, 9.0 MB (3.1 MB compressed).

`build.mjs` bundles the page and its two workers with esbuild and keeps Relate, NVL and
Transformers.js outside the bundles, so a code change never invalidates the versioned assets. It fails if the stylesheet's
brand colours differ from the kit's, or if the page names an asset the build did not write.

The page writes one storage key, `ex03.theme` in `localStorage` (ADR-0003). The origin is shared
with every other Pages site of the account (example 01's NOTES.md, "Changes the port made"): keep
nothing private in it. A typed note stays in the tab's memory and is gone when the tab closes.
The embedding model's files are kept in the Cache API as `ex03-models`.

## Browser support

A current browser with module workers and WebAssembly; the browser section runs it in Chromium.
Nothing needs WebGPU or OPFS, and the scripted conversations need no download beyond the page. Typing your own text fetches the embedding model once (23 MB, and the 15 MB runtime from this site); it runs on WebAssembly, one thread. The graph needs a canvas. On a narrow screen the conversation sits
above the memory.

## Credits and licences

[THIRD_PARTY.md](THIRD_PARTY.md) has every component. In short:
- Relate 1.2.0 (Apache-2.0).
- NVL 2.0.0 (proprietary, used with Neo4j's permission).
- Transformers.js 4.3.2 (Apache-2.0) and onnxruntime-web (MIT), shipped; all-MiniLM-L6-v2
  (Apache-2.0), fetched from the Hugging Face Hub at a pinned revision and never shipped.
- Public Sans and IBM Plex Mono (SIL Open Font License 1.1).
- The Relate logo, favicon and mascot, from the Relate brand kit v1.0: Relate's trademarks,
  supplied by the repository owner and used as the kit's rules say (NOTES.md D9).
- The memory model and the shape of the recall statement follow Relate's cookbook
  (<https://relatedb.ai/cookbook/>, Apache-2.0); nothing is copied from it (`data/SOURCE.md`).
- The conversations were written for this example. The people and projects are invented.

## Files

| Path | What |
|---|---|
| `web/` | the page: `index.html`, `style.css`, `app.js` (the page thread), `engine.worker.js` (Relate), `embed.worker.js` (the embedding model, started only for typed text). The modules: `memory.js` (the schema and the tool statements), `agent.js` (scripted and typed turns), `embed.js` (the pinned model, and where a text's vector comes from), `graph.js` (the drawing, with NVL). `vendor-entry.mjs` is NVL's bundle entry. |
| `data/` | `scenarios/` (the three conversations), `embeddings.json` (the vector of every text the scripts use), `brand/` (the brand kit's files the page uses), `SOURCE.md` (formats and provenance), `LICENSE-relate.txt`, `LICENSE-onnxruntime.txt` |
| `harness/` | `run.mjs` (the Node sections), `typed.mjs` (the typed turns it plays), `embed.mjs` (writes `data/embeddings.json`, by hand), `drive.mjs` (Chromium; `--smoke` against a deployed URL, `--live` for the model in the tab), `native.py` |
| `build.mjs`, `site.json`, `run.sh` | the static site, its entry in the Pages site, the regression run |
| `screenshot.png` | the picture on this example's card on the Pages index: turn 7 of the first conversation, dark theme. Retake it with `node harness/drive.mjs --smoke --screenshot screenshot.png` after `npm run build` |
| `expected/` | what `run.sh` diffs against |
| [`../../lib/relate_wasm.mjs`](../../lib/relate_wasm.mjs), [`../../lib/serve.mjs`](../../lib/serve.mjs) | shared with the other examples: the Relate WASM helpers, the Pages emulator |
