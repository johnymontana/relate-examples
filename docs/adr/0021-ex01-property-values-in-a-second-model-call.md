# Example 01 reads property values in a second model call, and joins them by the mentions

Status: accepted · Decided: 2026-11-26 (01's D27, G12) · Scope: example 01

The extractor read entities and relations, so a claim's amount or a trade's date stayed in the
text. GLiNER2 also extracts structures (a record of fields per mention of an anchor), which
gliner-rs exposes, so an ontology can mark node properties to be read from text.

**The values are a second call, of structures alone**, made only for sentences that could hold a
value (a digit, or a word of a property's vocabulary). Asked in the same call, the structures
changed the model's entity and relation answers (G12): financial-services lost a relation and two
of its tools their rows. Apart, the first call and its cache keys are exactly what they are for an
ontology without extracted properties, so marking a property never moves the graph's scores. The
cost is a second inference for those sentences (about 40% more calls on the two ontologies that
read values).

**A value joins the entity the sentence names, not the model's anchor.** Alone, the model reads
values well and anchors them poorly (G12), so the gate's rule 8 joins a value to a kept mention of
its kind that the anchor names, else to the only entity of that kind in the sentence, else drops
it. Values are parsed by the property's declared type (`web/values.js`: amounts, full dates,
vocabularies), banded, capped by the hedge cues as claims are, and published on the entity as that
type, one per property, with `(:_Attribute)-[:_OF]->(:_Entity)` as their evidence. The text is
never stored as the value: a month without a day, or a percentage where an amount is declared, is
refused.

**Consequences.** Stores gain `_Attribute` nodes and DATE properties, so `lib/replay.mjs` now
writes DATE values in `lib/replay.py`'s typed sidecar, byte for byte. A value the model reads in a
sentence that names two entities of its kind, with nothing to tell them apart, is dropped rather
than guessed.
