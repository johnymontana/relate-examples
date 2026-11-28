# Example 01's bundled ontologies are curated, without the POLE+O base

Status: accepted · Decided: 2026-11-26 (01's D20, D22, D23) · Scope: example 01

Example 01 bundled create-context-graph's domain ontologies, converted to the Ontology Graph Spec
(ADR-0007). Each merged a generic POLE+O base (Person, Organization, Location, Event, Object) into
the domain, so every document was read as people, organisations and places first, and the domain's
own kinds were subtypes the gate had to prefer over the base (the POLE margin). Their samples were
short sentences written for the extractor ("X works for Y.").

**Each domain is now a curated Ontology Graph Spec 1.1 document** in
`data/ontologies/domains/<id>.ontology.yaml`, written for this repository: kinds named by the role
the domain gives them (Client, Advisor, Account, never a bare Person where the domain means a
client), with descriptions, aliases, references to public vocabularies, realistic properties and
tools that answer a practitioner's questions, each with its question, category and parameter
examples (D22). A kind is Person or Organization only where the domain really means any one.
Documents are written in the genre a practitioner would read (a compliance memo, a discharge
summary), with gold labels that say how each fact is stated and which claims the text makes
without asserting (D23), so the scores measure the extractor on real prose, tables and lists.

The page no longer converts create-context-graph's YAML for its picker. A store an earlier build
made under one of those versions keeps working, and the page offers to empty it and open it under
the curated version: its facts cannot carry over, because the kinds changed, and rebuilding them
from candidates of other kinds would invent facts.

**Consequences.** The POLE machinery (the base layer, `_Kind.pole`, the POLE margin) only serves
documents converted from create-context-graph, which the editor still accepts. Scores are lower
than the old corpus's, because the prose is harder; they are reported by how each fact is stated
(plain, list, table, cross-sentence) rather than as one number.
