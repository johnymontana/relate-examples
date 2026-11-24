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
  message, are written ahead of time: the two things a language model would produce. No model runs
  on the page, so it starts at once in any browser.
- **Its memory is real.** Every remember and recall is a statement that Relate 1.2.0, compiled to
  WebAssembly (npm `@relate/relate-wasm`), runs in the tab. A graph type makes the shape of a
  memory something the engine enforces. Recall is one statement: a vector search and a full-text
  search, fused, then two steps through the graph.
- **The page draws what the engine returns.** The graph is the store after each call, drawn with
  NVL, the Neo4j Visualization Library. The highlight is the paths the recall statement returned. A scripted reply may cite only memories its tool
  returned, and the run fails on any other citation.

Live: <https://johnymontana.github.io/relate-examples/03-wasm-agent-memory/> (deployed by the first
push to `main` that contains this example and passes CI).

The ids cited below are defined in [NOTES.md](NOTES.md): `M1`… are the Relate 1.2.0 behaviours this
example pins, and `D1`… its design decisions. The larger decisions are ADRs in
[`docs/adr/`](../../docs/adr/README.md):
- this example's own:
  - ADR-0014: a scripted agent, a real memory;
  - ADR-0015: the graph drawn with NVL, the page in Relate's brand;
  - ADR-0016: one typed `:Memory` label, in a store that lives in memory;
- the repository's, which it follows: ADR-0002 to ADR-0006, ADR-0008 and ADR-0009.

```bash
./run.sh              # offline, a few seconds: Node, then Chromium, then native Relate; diffed against expected/
./run.sh --site       # build dist/ and serve it at http://127.0.0.1:8703/relate-examples/03-wasm-agent-memory/ as Pages would
./run.sh --update     # accept this run's output as expected/
```

## Using the page

Pick one of three conversations, each two sessions and nine turns:

| Conversation | What it shows |
|---|---|
| A teammate that remembers | An assistant hears who leads what and which database was chosen. Three days later it knows, notices that the decision has since changed, and works out who is affected by an outage nobody linked to them. |
| A travel planner | A planner hears a few preferences. Asked later about dinner, a word none of its memories contain, it finds the dietary ones by following who is coming on the trip. |
| A coding agent's notes | A coding agent is told a repository's house rules. With an empty context the next day, it recalls where tests go, how to run them and whose module it is about to touch. |

| Part of the page | What it does |
|---|---|
| The conversation | **Send the next message** plays one turn, **Play** plays the rest. Between the user's message and the reply, a card shows each thing the agent did with its memory: **remember** (what it stored), **recall** (what it found, and how: by search, by following what replaced a match, or through the graph), **connect** (the chain between two entities) or **trace** (the message a memory came from). Each card opens to the statements Relate ran. A numbered mark in a reply is a citation: click it to see that memory in the graph. |
| Your own turns | Type a question and it goes to the same recall statement. Type anything else and it is stored as a note, linked to the entities it names. Rules decide, not a model (D8), and the reply says so. |
| Memory | The store, drawn with NVL. A large node is an entity, coloured by kind, and it grows as more is learnt about it. A smaller node between entities is a memory, carrying two or three words of it. A paler one has been replaced, and the memory that replaced it points at it. Every relationship shows its type (`ABOUT`, `SUPERSEDES`, and with provenance on, `FROM` and `IN_SESSION`). New nodes grow in, and the view eases to keep the whole graph in the panel. After a recall, the paths it returned are selected hop by hop, each node pulsing as the path reaches it, everything else steps back, and the caption says what you are looking at. Hover a row in a recall card to see that row's path alone. Hover a node for its text, click it for its details, drag it, zoom and pan. **Messages and sessions** adds the provenance. |
| What it knows | The same store as a list: what the agent believes now about each entity, and what each belief replaced. |
| Under the hood | Every statement run, in order, with its parameters, counters and time. The graph type as the engine reads it back. A box to run your own Cypher on the same store: two of the samples are writes the graph type refuses. Nodes and paths in a result are highlighted in the graph. |

URL parameters: `?scenario=team|trip|code`, `?autoplay=1`, `?test=1` (no animation and no pacing:
the browser section's mode).

## What a turn does

`web/agent.js` runs each turn the same way, whether it comes from a script or from the input box.
The engine worker and the Node harness call the same code.

1. **Read memory.** A turn that asks something calls one tool: `recall` with the user's words,
   `connect` with two entity names, or `trace` with a memory's id.
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
type, the vector as `VECTOR<FLOAT32>(256) NOT NULL`. The engine then refuses, on every write, a
memory without its text or its vector, a vector of the wrong length, and an `ABOUT` edge between two
entities (M1). The model has one `:Memory` label with a `kind`, not a label per kind, because a
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

1. **Two searches** over every memory, current or not: the vector index (keeping hits whose
   similarity is at least 0.56 on a scale where 0.5 means none, M3) and the full-text index (M4).
   Each list is ranked, and the two are fused by reciprocal rank, so a memory both searches found
   comes first.
2. **Each of the best four is followed to its current version**, along `SUPERSEDES` (M6). A search
   may well find what used to be true. Asked "Did we pick Postgres for checkout?", the best match
   is the Postgres decision, and the graph knows it was replaced: the row that comes back is the
   CockroachDB decision, marked `update`, with the Postgres one as what it replaced.
3. **From there, out through shared entities**, up to two entities away, over current memories
   only. A memory reached this way scores half its seed's score per entity crossed (D7).

Every row carries the path that reached it, as node and relationship ids (M7), and the entities
the memory is about. That is what the page selects in NVL (N4).

The third step is why the memory is a graph. "Payments is timing out in staging. Who needs to
know?" finds two memories by search: Dana owns the payments service, and the checkout rewrite
depends on it. Nobody said Priya or Tomás have anything to do with payments. They come back because
Priya leads the rewrite and Tomás works on it, and one more step away is the memory that Tomás is
away next week. [`expected/scenarios.txt`](expected/scenarios.txt) has every row of every recall,
with its score and path.

## What is scripted, and what an application would change

| On this page | In an application |
|---|---|
| The extraction for each message is in the scenario file (`remember.entities`, `remember.memories`). | A language model returns it as structured output. |
| The reply is in the scenario file, with citations checked against the tool's rows. | A language model writes it from the tool's rows. |
| `web/embed.js` hashes words and character trigrams into 256 buckets (D3). It scores shared wording, not meaning: "dinner" does not find "vegetarian" (`expected/probes.txt`). | An embedding model. The index, the search and the recall statement take whatever vectors they are given; the graph type's dimension changes with the model. |
| A typed message is routed by rules (D8). | The model chooses the tool. |
| The schema, the three remember statements, and the recall, connect and trace statements | The same. Over `relate serve --mcp` they are `write_cypher` and `read_cypher` calls. |

## Setup

From the repository root, the shared setup (README.md): `uv sync` (the `relate-db` 1.2.0 binding,
for the native section). Then:

```bash
cd examples/03-wasm-agent-memory
npm ci --omit=peer                 # exact pins: @relate/relate-wasm 1.2.0, NVL 2.0.0, the two typefaces, esbuild 0.28.2, playwright 1.63.0
npx playwright install chromium    # Playwright 1.63.0's Chromium, for the browser section (the same as examples 01 and 02)
./run.sh
```

- **Pins.** The Relate WASM bundle is pinned by its npm integrity in `package-lock.json`, and
  `lib/relate_wasm.mjs` refuses one that does not report 1.2.0. NVL and the two typefaces are
  pinned exactly in `package.json` and by integrity in the lockfile. `--omit=peer` skips NVL's
  unused neo4j-driver peer. The brand files are in `data/brand/` (`data/SOURCE.md`).
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
| `typed.txt` | `harness/run.mjs` | Eleven turns nobody scripted: questions, a question that asks for a source, two entities to connect, notes that name known entities and one that names none. |
| `probes.txt` | `harness/run.mjs` | M1–M7, each a minimal repro on Relate 1.2.0 WASM, and what the stand-in embedder does and does not find. |
| `browser.txt` | `harness/drive.mjs` | The page in headless Chromium against `dist/` at the Pages sub-path, with its production CSP: boot; the logo and both typefaces loaded; every scripted turn (equal to the Node section's, with what NVL holds equal to the store, what NVL has selected equal to the returned paths, and the rest disabled); the buttons; typed turns; the list; the console, with two refused writes and a result whose paths get highlighted; the toggles, a theme change among them; the whole graph inside the panel once the layout rests (N3); no console errors or CSP violations. NVL draws to a canvas, so these read NVL's own state, not pixels (N4, N5). |
| `native.txt` | `harness/native.py` | Every statement the conversations ran (53), replayed on native Relate 1.2.0 with the same parameters: the same rows, ids, scores and paths included. The graph type refuses the same writes natively. |

## The GitHub Pages site

`dist/` follows the site contract (site/README.md, ADR-0002):
- One CSP `<meta>`: `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`,
  `connect-src 'self'`. The page fetches nothing from any other origin.
- Relative URLs only.
- Every dependency in a versioned `assets/<name>-<version>/` directory, with its licence:
  - `relate-1.2.0`, 6.9 MB, of which the WASM is 2.6 MB compressed;
  - `nvl-2.0.0`, 1.3 MB;
  - `public-sans-5.3.0` and `ibm-plex-mono-5.3.0`;
  - `relate-brand-1.0`: the logo, favicons and mascot.
- 48 files, 8.8 MB.

`build.mjs` bundles the page and its worker with esbuild and keeps Relate and NVL outside the
bundles, so a code change never invalidates the versioned assets. It fails if the stylesheet's
brand colours differ from the kit's, or if the page names an asset the build did not write.

The page writes one storage key, `ex03.theme` in `localStorage` (ADR-0003). The origin is shared
with every other Pages site of the account (example 01's NOTES.md, "Changes the port made"): keep
nothing private in it. A typed note stays in the tab's memory and is gone when the tab closes.

## Browser support

A current browser with module workers and WebAssembly; the browser section runs it in Chromium.
Nothing needs WebGPU, OPFS or a download beyond the page. The graph needs a canvas. On a narrow screen the conversation sits
above the memory.

## Credits and licences

[THIRD_PARTY.md](THIRD_PARTY.md) has every component. In short:
- Relate 1.2.0 (Apache-2.0).
- NVL 2.0.0 (proprietary, used with Neo4j's permission).
- Public Sans and IBM Plex Mono (SIL Open Font License 1.1).
- The Relate logo, favicon and mascot, from the Relate brand kit v1.0: Relate's trademarks,
  supplied by the repository owner and used as the kit's rules say (NOTES.md D9).
- The memory model and the shape of the recall statement follow Relate's cookbook
  (<https://relatedb.ai/cookbook/>, Apache-2.0); nothing is copied from it (`data/SOURCE.md`).
- The conversations were written for this example. The people and projects are invented.

## Files

| Path | What |
|---|---|
| `web/` | the page: `index.html`, `style.css`, `app.js` (the page thread), `engine.worker.js` (Relate). The modules: `memory.js` (the schema and the tool statements), `agent.js` (scripted and typed turns), `embed.js` (the stand-in embedder), `graph.js` (the drawing, with NVL). `vendor-entry.mjs` is NVL's bundle entry. |
| `data/` | `scenarios/` (the three conversations), `brand/` (the brand kit's files the page uses), `SOURCE.md` (formats and provenance), `LICENSE-relate.txt` |
| `harness/` | `run.mjs` (the Node sections), `drive.mjs` (Chromium; `--smoke` against a deployed URL), `native.py` |
| `build.mjs`, `site.json`, `run.sh` | the static site, its entry in the Pages site, the regression run |
| `screenshot.png` | the picture on this example's card on the Pages index: turn 7 of the first conversation, dark theme. Retake it with `node harness/drive.mjs --smoke --screenshot screenshot.png` after `npm run build` |
| `expected/` | what `run.sh` diffs against |
| [`../../lib/relate_wasm.mjs`](../../lib/relate_wasm.mjs), [`../../lib/serve.mjs`](../../lib/serve.mjs) | shared with the other examples: the Relate WASM helpers, the Pages emulator |
