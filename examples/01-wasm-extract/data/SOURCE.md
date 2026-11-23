# Where `data/` comes from

`data/` holds the create-context-graph ontologies and their Ontology Graph Spec v1 conversions
(`ontologies/`), the spec's schema (`ontology-spec/`), the 27 samples written for this example
(`samples/`), the Python `gliner2` fixture (`reference/`, written by `harness/reference.py`), and
edgextract's licence.

**edgextract.** This example re-implements the approach of
[raphaelmansuy/edgextract](https://github.com/raphaelmansuy/edgextract) at commit
`3f08b1dca84ebacffd5152cee37639a62df0fb93` (`3f08b1d`, 2026-10-04), and ports some of its code
to JavaScript, its rules unchanged: the markdown sentence splitter (`web/split.js`, from
`rust/edgextract/src/markdown.rs`), the canonical entity names (`web/names.js`, from
`names.rs`), and the gazetteer proposer, pronoun list and section planning in `web/pipeline.js`
(from `candidates.rs`, `ontology.rs` and `pipeline.rs`). `harness/ontology.mjs` checks the
splitter and the names against edgextract 0.1.0's own WASM (the npm package
`@raphael.mansuy/edgextract`, a dev dependency). The edge cases the harness feeds the pipeline
(`harness/fixtures.mjs`: bold markup, a code fence, negation and hedging, pronouns, overlapping
names, a prompt injection, kinds the ontology lacks, an event in front matter, a self-loop, a
document with no names and one with no sentence) follow the cases of edgextract's golden set;
their texts are new, written for create-context-graph's Financial Services ontology.

**Licence:** Apache License 2.0, copyright 2026 Raphael MANSUY. The licence text is in
[`LICENSE-edgextract.txt`](LICENSE-edgextract.txt), copied unchanged from the same commit.
edgextract ships no NOTICE file.

The page offers create-context-graph's 27 domains and their samples only; none of edgextract's
ontologies, golden documents or samples is bundled.

`reference/` is this example's Python `gliner2` fixture (`harness/reference.py`), recorded on
the Financial Services sample's sentences under the schema the page asks for that domain.

**`ontologies/ccg/` is not from edgextract.** It holds the 27 domain ontologies and their base
from [neo4j-labs/create-context-graph](https://github.com/neo4j-labs/create-context-graph) at
commit `707b168`, copied verbatim. They are Apache-2.0, by the neo4j-labs/create-context-graph
contributors: the YAML files carry no copyright header, and the repository's `LICENSE` has the
line "Copyright 2026 Neo4j Labs" after its terms and conditions. That `LICENSE` travels with the
files, unchanged, as `ontologies/ccg/LICENSE-create-context-graph.txt`, and the folder's own
[`SOURCE.md`](ontologies/ccg/SOURCE.md) says where each file comes from. `web/convert.js`
(`fromCreateContextGraph`) converts each to an Ontology Graph
Spec v1 document, with `_base.yaml` merged in as create-context-graph's `_merge_base` does, and
`node harness/convert.mjs` writes the conversions to `ontologies/ogs/ccg/` (their
[`SOURCE.md`](ontologies/ogs/SOURCE.md)), which the page and the harnesses load. Their agent tools
and default views become the documents' `canonicalQuery` tools, which the page's console lists and
runs (the example's README, "The ontology's tools").

**`samples/ccg/` is not from either upstream.** It holds 27 synthetic documents written for this
example, one per create-context-graph domain, each following one of that domain's document
templates (`document_templates` in its YAML; the template's id is in the document's front
matter). The people, organisations, identifiers, events and sites in them are fictional; the
cities and regions they mention are real (Edinburgh, Lisbon, Porto, Lahaina, Laikipia, …). No text
is copied from create-context-graph. Beside each document:

- `<domain>.gold.json`: its gold labels, in edgextract's golden-label format (`{entities:
  [{name, type}], relations: [{source, target, type}]}`), with the domain's own labels and
  relationship types (`Person`, `WORKS_FOR`). Names are written as the text writes them ("Pump
  P-12", "the peak vibration reading"), one kind per name in a document; the scoring keys them as
  the store keys entities (the example's README, "The graph model"), so "Deployment D-881" and
  "D-881" are one name. The documents are written in short declarative sentences, one fact each,
  in the words of the ontology's links (the README, "How the samples are written").
- `distractors.json`: per domain, the one hedged or negated claim the document makes ("Colm Brady
  may also have advised on the Trim Decision") as `{source, type, target}`. It is not in the gold, so
  a gate that keeps it loses precision; `score.txt` reports each one's band.

`samples.json` lists them with `group: "ccg"`, a `label` (the domain's name), a `blurb` (the
template and the document's title) and `gold`. Only the documents ship in `dist/`; the gold files
and the distractors are for the Node harness.

**`samples/heldout/` is not from either upstream either.** Six more documents written for this
example in the samples' style (cybersecurity, financial-services, healthcare, manufacturing,
product-management, wildlife-management), each with its gold and its distractor, and the same
fictional-names rule. The page does not list them; `score.txt` scores them beside the samples, and
no default or rule was set on them.
