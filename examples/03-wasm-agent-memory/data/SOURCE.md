# Where example 03's data comes from

`scenarios/team.json`, `scenarios/trip.json` and `scenarios/code.json` were written for this example.
The people, teams, projects and trips in them are invented.

Each file is one scripted conversation (web/agent.js reads it):

| Field | What it is |
|---|---|
| `id`, `title`, `agent`, `blurb` | the conversation's key in the URL, its name in the page's header, the label on the agent's replies, and a sentence about what it shows |
| `try` | messages offered as chips once the script has finished. Each has a vector in `embeddings.json`, so the chips need no model |
| `sessions[]` | `id`, `title`, `startedAt` (a fixed ISO timestamp) and `turns[]`; a turn's time is the session's start plus three minutes per turn |
| `turns[].user` | what the user says |
| `turns[].remember` | the extraction a model would return for that message: `entities` (`name`, `kind`) and `memories` (`id`, `kind`: fact, decision or preference, `text`, `gist`: two or three words drawn on the graph, `about`: entity names, optional `slot` and `rationale`). A memory with a `slot` replaces the current memory in that slot. Every name in `about` must be in the same turn's `entities`. |
| `turns[].recall` | `true` to recall on the user's own words, or `{"question": "…"}`. The question needs a vector in `embeddings.json` |
| `turns[].connect` | `{"from": "…", "to": "…"}`: two entity names |
| `turns[].trace` | a memory id |
| `turns[].reply` | the agent's reply. `[[memory-id]]` cites a memory, and the tool in the same turn must have returned it: `harness/run.mjs` fails the run otherwise. |

The memory model and the shape of the recall statement follow two recipes in Relate's cookbook
(<https://relatedb.ai/cookbook/>, Apache-2.0): "Pick up where the last session left off" (entities,
facts and decisions drawn from messages, superseded by slot, never deleted) and "Find a note, then
what was decided since" (vector and full-text search fused by reciprocal rank, then a hop through
the graph). No text, data or statement is copied from them; NOTES.md D2 lists what this example
does differently.

`embeddings.json` holds the vector of every text the scripts use: each memory's `text`, each
recalled question, each `try` message and the typed turns of the regression run
(`harness/typed.mjs`). Its `model` names the embedding model (`web/embed.js` `MODEL`:
all-MiniLM-L6-v2, 8-bit quantised, at a pinned Hub revision) and `vectors` maps a text to its 384
numbers, mean-pooled, normalised and rounded to five places, one text per line. It is generated,
never edited: `node harness/embed.mjs` rewrites it with the page's own worker (NOTES.md T5) and
`--check` compares. A scripted text without a vector in it fails the regression run.

`LICENSE-relate.txt` is Relate's `LICENSE` at tag v1.2.0 (Apache-2.0), shipped next to the WASM
bundle; `build.mjs` checks its sha256. `LICENSE-onnxruntime.txt` is the MIT License with
onnxruntime's copyright line, shipped next to its WebAssembly build (NOTES.md T4).

## `brand/`

Files from the Relate brand kit v1.0 (November 2026), supplied by the repository owner on
2026-11-24 and copied here unmodified:

| File here | In the kit |
|---|---|
| `relate-logo-navy.svg`, `relate-logo-white.svg` | `01_Logo/SVG/` |
| `favicon.svg`, `favicon.ico`, `apple-touch-icon.png` | `03_Favicon/` (`PNG/` for the last) |
| `archie-mascot.svg`, `archie-mascot-flair.svg` | `04_Mascot/SVG/` |
| `relate-colors.json` | `06_Color/` |
| `README.txt` | the kit's root: its folders, colours and rules of thumb |

The rest of the kit (the PNG and PDF renditions, the icon alone, the social images, the "by Neo4j"
lockup and the 3D mascots) is not used and not copied. The logo, favicon and mascot are Relate's
trademarks: they ship with the page under the kit's rules, not under this repository's licence.
NOTES.md D9 says how the page follows the rules.
