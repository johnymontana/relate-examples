# Example 03's agent is scripted, and its memory is real

Status: superseded by ADR-0017 · Decided: 2026-11-24 (03's D1, D3, D6) · Scope: example 03

Example 03 is the Relate playground, rebuilt around one idea: Relate as the database an agent keeps
its memory in. It has to work the moment the page opens, in any browser, and its run has to be
byte-stable (ADR-0004). A model on the page would break both. Example 02's smallest model is a
1.1 GB download that needs WebGPU (ADR-0012), and no model's output can be diffed.

So **the page runs no model: no language model, and no embedding model.** The two things a model
would do are written ahead of time or replaced:

- **The agent's words are scripted** (D1). Each turn of a scenario file carries the extraction a
  model would have returned for the user's message (entities and memories) and the reply it would
  have given.
- **The embedder is a stand-in** (D3). `web/embed.js` hashes a text's words and character trigrams
  into 256 buckets. It measures shared wording, not shared meaning, and it is deterministic.

**Everything between the two is real** (D6). Every remember and recall is a statement that Relate's
WASM build runs in the tab: a typed write under a graph type, a real vector index and a real
full-text index, one recall statement that searches both and then walks the graph. The page draws
only what the engine returns: the graph is the store after each call, and the highlight is the paths
the statement returned. A scripted reply may cite only memories its tool returned; a citation the
engine did not return fails the run.

Text a visitor types has no script, so rules handle it (`freeTurn`): a question goes to recall, to
connect or on to trace, and the reply lists what came back; anything else is stored word for word
as a note, linked to the entities it names.

## Considered options

- **WebLLM, as in example 02**: a real agent, but a gigabyte before the first reply, WebGPU only,
  and nothing to diff. The playground is the first thing a visitor tries; it cannot start with a
  download. Rejected for this page.
- **A small embedding model in the tab**: tens of megabytes for better recall on scripted turns, and
  still a download before anything moves. Rejected.
- **Real embeddings computed ahead of time and shipped as data**: the scripted turns would recall by
  meaning, but a question a visitor types could not be embedded, so one index would hold two kinds
  of vector. Rejected.

## Consequences

- Recall cannot match by meaning. "Dinner" does not find "vegetarian". The travel scenario makes
  that its point: the memory is reached through the graph instead (who is coming on the trip), which
  is what the page is there to show.
- An application replaces two functions and keeps the rest: the extraction (a model's structured
  output instead of the scenario file) and `embed()` (an embedding model). The schema, the indexes
  and the tool statements take whatever they are given.
- The whole conversation is in `expected/scenarios.txt`: every tool call's rows, scores and paths.
