# Example 02 writes queries with WebLLM on WebGPU, and uses canned queries without it

Status: accepted · Decided: 2026-11-23 (02's D4, D5) · Scope: example 02

With no backend (ADR-0002), the model that writes Cypher must run in the visitor's browser.
Example 02 uses **WebLLM 0.2.89** on WebGPU, in a worker. Its JSON-schema-constrained decoding
(W2) constrains every reply to `{"cypher": …}`.

The two models are **Qwen3.5 2B** (the default, 1.1 GB) and **Qwen3.5 4B** (2.4 GB). Both are
Apache-2.0 (ADR-0009), and WebLLM ships prebuilt libraries for both. Everything is fetched at pinned
revisions. WebLLM checks the model library, the chat config and the tokenizer against SRI hashes
(W3).

**Without WebGPU**, or with "canned answers" ticked, or with `?llm=canned`, the page uses the source
app's canned reference queries. The checks, Relate and the comparison run exactly as they would with
a model. This is also the mode CI tests: CI has no GPU, and model output is not byte-stable
(ADR-0004). The model itself is measured locally by `run.sh --llm-eval`, in the system Chrome, and
the results are recorded in the README.

## Considered options

- **Qwen2.5-Coder-3B**: a coder model, but its licence is not Apache-2.0. Left out.
- **Neo4j's Text2Cypher fine-tune of Gemma 3**: it exists only as a community GGUF, which WebLLM
  cannot load.
- **Refusing to run without WebGPU**: rejected. The ontology's checks and Relate's guard are worth
  showing on any browser.

## Consequences

- WebLLM's cache names are the documented exception to ADR-0003 (W1).
- A Qwen3.5 reply opens with an empty `<think></think>` block even with thinking off, so
  `parseReply` drops it (W5).
- The CSP's `connect-src` names `huggingface.co`, `*.hf.co` and `raw.githubusercontent.com`.
