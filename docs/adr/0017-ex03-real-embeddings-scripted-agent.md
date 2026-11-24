# Example 03's agent is scripted; its memory and its vectors are real

Status: accepted · Decided: 2026-11-24 (03's D1, D3, D6) · Scope: example 03 · Supersedes ADR-0014

ADR-0014 gave example 03 a scripted agent, a real store and a stand-in embedder that hashed words
and character trigrams. Its own consequence was that recall could not match by meaning: the vector
search was a second search by wording, and on a page that presents Relate as a database for agents
that was the weakest part. The repository owner asked for a real embedding model and for the
scripted questions to use vector and graph search together.

**The agent stays scripted** (D1) and **the page still draws only what the engine returns** (D6),
both as ADR-0014 decided and for its reasons: the page must work the moment it opens, in any
browser, and its run must be byte-stable (ADR-0004).

**The vectors are now real** (D3). Every vector comes from all-MiniLM-L6-v2 (`Xenova/all-MiniLM-L6-v2`
at a pinned revision, 8-bit quantised: 384 dimensions, 23 MB, Apache-2.0), and there are two ways
to get one:

- **Ahead of time, for every text the scripts use.** `harness/embed.mjs` computes them and commits
  them as `data/embeddings.json` (52 vectors, 54 kB compressed). The page and the regression run
  read the file, so the scripted conversations need no model, no network and no wait, and give the
  same rows everywhere.
- **In the tab, for what a visitor types.** A worker loads the same model through Transformers.js
  on onnxruntime-web's WebAssembly build, both shipped with the page, the first time a typed text
  has no vector. The model's four files are fetched from the Hugging Face Hub at the pinned
  revision, each checked against its pinned sha256, and kept in the Cache API as `ex03-models`
  (ADR-0003).

Both ways give the same vector for the same text, to the last digit, because the file is made by
the page's own worker in headless Chromium (T5). So the index holds one kind of vector, which was
ADR-0014's objection to shipping vectors as data.

A text with no vector (no network, or the model failed to load) is still stored and still found,
by its words: the graph type types the vector property and no longer requires it (M1), and recall's
full-text search carries on alone. The scripted conversations were rewritten so that their
questions share no word with what they find ("Who should I page about a billing outage?" finds
"Dana owns the payments service"), and each recall row says how it was found: by meaning, with the
cosine similarity, by its words, or through the graph.

This amends one detail of ADR-0016, whose decision stands: the vector property is
`VECTOR<FLOAT32>(384)`, no longer `VECTOR<FLOAT32>(256) NOT NULL`.

## Considered options

- **Keep the hash embedder**: nothing to download, but the page's vector search finds nothing a
  word search would not. Rejected: it is what this decision replaces.
- **Load the model when the page opens**: every vector made in the tab, no file to keep in step,
  but 37 MB before the first turn can run and a regression run that needs the network. Rejected.
- **Compute the file with the library's Node backend**: simpler than driving a browser, but
  onnxruntime's native and WebAssembly kernels give this quantised model vectors that differ by up
  to 0.03 per component (T5), so a typed question would be compared with vectors from a slightly
  different model. Rejected.
- **Ship the model with the site**: its licence allows it (ADR-0009), and the page would then fetch
  nothing from elsewhere. But it is 23 MB in every deployment for something most visits never
  load, and examples 01 and 02 already fetch their models from the Hub at pinned revisions.
  Rejected for now.
- **bge-small-en-v1.5 or snowflake-arctic-embed-xs**: tried on the scenarios' own sentences.
  all-MiniLM-L6-v2 separated them most cleanly: about 0 for unrelated pairs, 0.2 to 0.9 for a
  question and the memory that answers it, which is what lets one fixed floor (a cosine of 0.2)
  decide what counts as a hit.
- **A language model in the tab** stays rejected for this page, as in ADR-0014: a gigabyte before
  the first reply, WebGPU only, and nothing to diff.

## Consequences

- The page connects to `huggingface.co` and `*.hf.co`, but only once the visitor types something;
  the scripted conversations fetch nothing (`browser.txt` checks). `site.json` and the CSP name
  both origins.
- `dist/` grows from 9 MB to 24 MB (3.1 MB to 7.0 MB compressed). The 15 MB that was added, the
  embedding runtime, is requested only when the model is.
- A scripted text that changes needs `node harness/embed.mjs` rerun: the regression run fails on a
  scripted text without a vector, and `build.mjs` refuses a file made with another model.
- An application replaces one function fewer than before: the extraction and the reply are still
  the scenario file's, and a language model's in an application; the embedding call is already the
  real thing.
- The live path (the Hub fetch, the hash check, the cache, a second tab that fetches nothing, and
  the tab's vectors equal to the file's) is checked by hand with
  `node harness/drive.mjs --smoke --live`, never by `run.sh`, which stays offline.
