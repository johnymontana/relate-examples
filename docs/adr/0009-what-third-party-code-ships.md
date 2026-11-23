# Ship only what may be redistributed, with its notices; fetch the rest at run time

Status: accepted · Decided: b26e6cd; extended 2026-11-23 · Scope: repository

The site serves third-party code to the public. Each example's `THIRD_PARTY.md` sorts every
component into one of three groups:

- **Shipped** in `dist/` under `assets/<name>-<version>/`, with its licence text next to it. This
  covers only licences that allow redistribution (Apache-2.0, MIT, ISC, Unlicense). An NVL bundle
  ships notices only for the packages that actually put bytes into it, and keeps the files its `LEGAL`
  comments refer to.
- **Fetched at run time** from the original host, at a pinned revision, and never mirrored here.
  Each file is checked by hash wherever the loader allows (sha256 for the GLiNER2.5 weights, SRI for
  WebLLM's model library, chat config and tokenizer). Two cases fall here:
  - files that are large but free to redistribute: the GLiNER2.5 and Qwen3.5 weights from the
    Hugging Face Hub;
  - files whose repository carries no licence at all: WebLLM's model libraries from
    `mlc-ai/binary-mlc-llm-libs`, checked against SRI hashes (02's NOTES W3).
- **Used with permission**: NVL 2.0.0 is proprietary and shipped with Neo4j's permission. The
  repository owner confirmed that permission on 2026-10-08, and both examples' credits record it.

Models are chosen with this in mind as well. Example 02 takes only Apache-2.0 models, so
Qwen2.5-Coder-3B was left out (ADR-0012).

## Consequences

A new dependency is not done until it is in the example's `THIRD_PARTY.md` and `site.json`
`credits`. Its notices must also ship.
