# The curated domains (`data/ontologies/domains/`)

Each `<domain>.ontology.yaml` is an Ontology Graph Spec 1.1 document written for this repository
(ADR-0019): kinds named by the role their domain gives them, with descriptions, aliases, properties,
the descriptions the model reads, link phrases, the properties read from text and tools, in the
`relate-examples` extension (`web/ogs.js` checks it). The list of domains follows create-context-graph's
(Apache-2.0); their kinds, wording and queries are this repository's, under its licence.

A `reference` on a kind or a property is a link to a public vocabulary (FIBO, schema.org, MITRE ATT&CK,
SNOMED CT and the like) that names the same concept. Nothing is copied from those vocabularies beyond the
concept's name.
