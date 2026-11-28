# Example 01: real-world ontologies and documents, implementation plan

**Scope.** Example 01 only, worked in the worktree `.claude/worktrees/ex01-ontologies` on branch
`ex01-ontologies`, cut from `3e887b1` (the Relate 1.3.0 and SDK 0.13.0 upgrade). That commit is not
on `main` yet. It lives on `companies2-example01` with example 02's in-flight companies work, so
this branch lands after the upgrade reaches `main` (or carries it). Most of it is built: the
**Status** section below tracks what is done and what remains. It is a plan, not a record: the
decisions that met AGENTS.md's bar are ADR-0019 to ADR-0021, and no code or doc cites this file.

**Goal.** The page should feel like a real knowledge-extraction tool, not a toy:
1. **Forty domains in two families.** The 27 create-context-graph domains, rewritten as curated
   ontologies without the POLE+O layer. Beside them, the 13 solution packages of
   [neo4j/studio-agent-use-cases](https://github.com/neo4j/studio-agent-use-cases), whose
   reference ontologies are already written to a high standard.
2. **Ontologies a practitioner would recognise.** Each element has a real description, aliases,
   references to established vocabularies and realistic properties. Each ontology ships a set of
   example queries that answer real questions on the graph the page extracts, with the evidence.
3. **Documents that read like the real thing.** An SIU referral, a discharge summary, a post-incident
   review, an underwriting memo: 600 to 1,200 words with headings, tables, lists, identifiers, dates,
   amounts, hedges and negations. Gold labels are written fact by fact, so recall can be reported
   per writing phenomenon, not only as one number.

**First milestone (two vertical slices).** One domain from each family goes end to end before
anything is scaled:
- **Insurance Claims Fraud** (a studio package): vendored at a pinned commit, converted with its
  overlay, its SIU referral written with gold, its 11 queries as tools, scored, pinned in
  `expected/`, and pickable on the page.
- **Financial Services** (curated): POLE+O removed, enriched to the ontology bar, its compliance memo
  rewritten, its tools rewritten to return rows on the extracted graph.

Together the two slices exercise every new mechanism: the 1.0.0 reader, ask cues and the schema
budget, the vendoring script, the converter, gold v2, the corpus lint and the new scoring
breakdowns. Only after that do the other 38 domains follow, and they can be authored in parallel.

[Example README](README.md) · [Engine behaviours and design ids](NOTES.md) ·
[Repository decisions](../../docs/adr/README.md) · [The packages](https://github.com/neo4j/studio-agent-use-cases)

---

## Status (2026-11-27)

Local commits on `ex01-ontologies`, never pushed: `b0c2a2a` (the two slices and properties from
text), `8162d3f` (harness fixes, ADRs, browser tests), then `9295945` (all 40 domains, the
recalibrated defaults), then the full run recorded (the browser and native sections on the
curated corpus, the screenshot).

| Phase | State | Notes |
|---|---|---|
| 0 Gates and spikes | done | Licence: vendored with Neo4j's permission (ADR-0020). |
| 1 The reader | done | Spec 1.0.0 read as 1.1; cues, phrases and the schema budget (D22); key-from-name (D25); proposed identifiers (D26). |
| 2 The 13 packages | done | `b76f767`, verbatim with overlays; `convert.mjs --check` clean; the SDK and ajv agree on all 40 bundled documents. |
| 3 The 27 curated ontologies | done | The bar holds for 40 of 40 (`ontology.txt`). |
| 4 The corpus | done | 49 documents (40 primary, 9 companions) and 12 held out, gold v2, lint clean. |
| 5 Scoring and calibration | done | Precision-first (D23): entity keep 0.70, relation keep 0.20/0.15. base-v1 not recalibrated. |
| 6 Tools | mostly | Curated tools return rows for 292 of 386; packages' for 28 of 133 (written for their CSV data); 1 error (loans-and-mortgages `default-contagion-…`, `IN` on a non-list). "Every tool returns rows" is not met. |
| 7 The page | done | The full browser run passes end to end on the curated corpus (2026-11-27). The first one found five problems, all fixed: curated stores shown as "own document" (compare by sha, not YAML text); the sample's size question never answered by the test; `refreshNames` ignoring the `proper` rule on reopen (now `store.nameOfMention`, with a Node check that reopening changes nothing); the side panel showing a tool's example while asking for a value; the migration offer requiring `convertedFrom` (earlier builds' stores carry `format`). |
| 8 Harness and CI | done, over budget | Inference cache (D24), engine pool, CI cache. A full `./run.sh` takes about an hour (target was 25 minutes): subset the grids or the ablations. |
| 9a Reconcile with records | not started | Waits on 02's loader in `lib/`. |
| 9b Properties from text | done | D27, ADR-0021: values P 0.918 R 0.642. |
| 9c Aliases into one entity | not started | |
| 10 Records | mostly | ADR-0019 to 0021, NOTES D20-D27 and G12, README, THIRD_PARTY, `site.json`, AGENTS.md, CI, the screenshot (the curated Financial Services graph). |

**Scores at the defaults** (dev, 49 documents): entities P 0.903 R 0.800; relations P 0.917
R 0.221 (lists 53 of 531, tables 7 of 441); values P 0.918 R 0.642; 3 of 246 distractors kept.
Held out: entities P 0.868 R 0.728, relations P 0.944 R 0.233, 0 of 36 distractors kept.

**`expected/` state.** Every file is recorded from this code by one full `./run.sh --update`
(exit 0), each diff read and classified. `browser.txt` and `native.txt` now run on the curated
Financial Services and Software Engineering ontologies (D20): their kinds, links, tools and counts;
values read from text (D27: a click on TX-4471 shows its amount, side and trade date; the 16th
UNIQUE constraint is `_Attribute`'s key; sentences that could state a value take a second model
call, so the crash test's resume asks 24 calls, not 12); the new migration section (D20) and the
reset on the Financial Services store it empties. `extract.txt` gains the reopen check, `gate.txt`
names the Pine Clinic case as the inside join, and `review.txt` records the new mention-reject
target.

**Done this pass:** the full run recorded; `screenshot.png` retaken; `review.txt`'s
mention-reject case picks the lowest-scoring kept mention whose rejection unanchors a claim, tried on
a copy of the store; the known limits are in README ("Known limits of the rules") and NOTES (D22,
D26), each checked with a repro ("Ltd." does not split, being a listed abbreviation; "Plc.", "Corp."
and "GmbH." do).

**Before each commit:** the two name searches, `uv run pytest -q`, `node harness/convert.mjs --check`.

**Deferred to a later pass** (agreed 2026-11-27; each changes scope or `score.txt`, so each is a
decision, not a fix):
- **The run's budget** (Phase 8). A full `./run.sh` takes about an hour against the 25-minute
  target, which CI pays on every push to `main` (its job timeout is raised from 60 to 240 minutes
  as a stopgap; with every model answer cached, `run.mjs` takes about 51 minutes on a laptop, the
  scores and their grids most of it, and the browser section 13). Likely route: the per-setting
  grids and the "how the model is asked" comparison on a fixed subset of documents (as the floor
  invariant already uses one), with `score.txt` saying which. The dev and held-out scores stay on everything.
- **Tools that find nothing** (Phase 6, "Done means"). Curated tools return rows for 292 of 386 on
  their stores: revise the tools (or their documents) that a reader would expect to answer. The
  packages' queries (28 of 133) are verbatim and written for their CSV data: restate the goal for
  them (their notes already say what each can do on an extracted graph) rather than edit them.
  One package query errors (loans-and-mortgages `default-contagion-through-borrowers-and-guarantors`,
  `IN` on a non-list): report it upstream or note it.
- **The tools' notes that say "no rows" wrongly** (with the item above). `web/console.js`
  `toolCompat` predicts empty for 157 tools, and 78 of them return rows (`audit.txt`, "misses").
  Its property lists predate D27 and the bookkeeping labels: it treats every property outside
  `ENTITY_PROPERTIES` as never written, so a key the extractor now reads from text (`accountId`,
  `isin`, a course code) and a `_Claim`'s own fields (`band`, `htext`, `rel`, `p`, `rule`: every
  curated `claims-waiting-about-a-name`) are reported as never written, and the page shows that
  note. Fix: take the ontology's extracted properties and each bookkeeping label's fields into
  account, then re-record `audit.txt` and `browser.txt`.
- **9a** (reconcile the gold with the packages' records; waits on 02's loader in `lib/`) and **9c**
  (aliases into one entity).

---

## What this plan rests on

Each fact below was checked on 2026-11-26: against `neo4j/studio-agent-use-cases` at `b76f767`
(2026-11-17), cloned into the session scratchpad, and against this example's own reader in the
worktree. The probes were read-only scripts outside the repository.

| # | Finding | Consequence |
|---|---|---|
| F1 | The studio repository is public but has **no licence file** (GitHub reports `license: null`). Four packages (`business-entities`, `loans-and-mortgages`, `retail-banking`, `securities-reference-data`) adapt FIBO, which is MIT, and carry a `NOTICE.md` with FIBO's copyright lines. | ADR-0009 forbids shipping it as is. Phase 0 settles a licence route first, and the FIBO notices travel with whatever ships. |
| F2 | Every `ONTOLOGY.json` names spec **1.0.0** (`…/ontology-graph-spec/1.0.0/schema.json`). The schema file their skill bundles has the same content as our vendored 1.1.0 file (compared with sorted keys) **except `$id`**. | As published, `web/ogs.js` `checkDocument` refuses all 13 on `/schema` alone. With only the URI rewritten, **all 13 pass** the JSON Schema, the SDK's decode and `Validations.core`, the page's rules and limits, and `modelSchema`. Reading 1.0.0 is a lossless URI rewrite. |
| F3 | Their node descriptions are long and good: 386 to 2,732 characters per ontology (one kind's is 514). Today a non-create-context-graph node's description goes to GLiNER verbatim as `label:description` (`ontology.js` `modelAsks`), on every sentence. The create-context-graph asks are about 40 characters ("financial account in financial services"). | Long descriptions inflate every model call. The input-length collapse G10 makes this a real risk, not a cosmetic one. Phase 1 adds short **ask cues** and a **schema budget**, sized by spike S1. |
| F4 | Several studio kinds were modelled for CSV import, not prose: `PersonName`, `SSN`, `DOB`, `Session`, `Device`, `IP`, `Phase`, `Geo`, `Identifier`, `Listing`. Derived relation asks read badly: "session session uses device device", "identity has dob dob", "account is hosted country", "transaction benefits to account". | The overlay gives each link a natural phrase and marks per kind whether it is asked. Most of these kinds are still extractable spans (an IP, an e-mail, "Phase 3"). |
| F5 | Links with several endpoint pairs cannot be graph-type edges (R16), so the gate checks them alone. Those links: `attack-path-analysis` HAS_ACCESS_TO; `business-entities` OWNS, TRUSTEE_OF; `competitive-intelligence` TARGETS, TREATS; `configurable-bom` REQUIRES, HAS_OPTION (2 of its 3 links); `ev-route-planning` ROAD; `multi-omics` HAS_VALUE, FOUND_DIFFERENTIAL; `regulatory-dependency-mapping` DEPENDS_ON; `retail-banking` LOCATED_IN. | The machinery already handles this. The page should show which links the engine enforces and which only the gate checks (Phase 7). |
| F6 | `QUERIES.md` holds **175 queries**, each with a structured annotation block (`@name`, `@description`, `@params`, `@prerequisites`, `@returns`, `@usage`, `@tags`, `@sample`). GDS appears in 3 packages and APOC in 2. Most key on properties the extractor never writes (`claimID`, `amountClaimed`, `VIN`, dates). | They parse mechanically into `canonicalQuery` tools. The new key-from-name rule (Phase 1) and attributes from text (Phase 9) decide how many return rows. `toolCompat` already predicts the rest. |
| F7 | The engine's earlier product name occurs in `patient-journey/TESTS.md` and in files under `skills/create-solution-package/`. | Those files are never vendored. The vendoring script refuses any file that contains the name, and checks it by digest, so the name never appears in this repository. |
| F8 | Today's 27 samples are about 150 words each (4,040 words in all, 340 gold entities and 303 gold relations), written one fact per sentence ("Halvorsen Pryce Partners is located at Edinburgh."). The defaults were calibrated on them. README already says "for dense pasted prose, raise them". | Realistic documents will score lower at today's defaults. Phase 5 re-calibrates on a dev split, keeps a held-out split untouched, and reports precision first. |
| F9 | POLE+O lives in: the `_base.yaml` merge (`convert.js`); the `createContextGraph:pole` extension; kind descriptions such as "financial account (object)"; `modelAsks`' unasked base kinds (Object in all 27); gate rule 2's POLE preference (`poleMargin` 0.25, rule `pole-specific`); rule 2b's "a domain kind over a base kind" (`other-kind`). Many domains have no person or organisation kind of their own: Financial Services' own kinds are Account, Transaction, Decision, Policy and Security, so its people came only from the base. | Removing the base means each curated ontology must add the parties it really needs (Client, Advisor, Firm). Rules 2 and 2b go inert for documents without poles, and still serve pasted create-context-graph files. |
| F10 | CI: example 01 takes 16.5 of the job's 19 minutes, with a 60-minute timeout. A run asks gliner-rs about 1,000 questions. | A ten-fold larger corpus does not fit without a budget. Phase 8 adds a deterministic inference cache, keeps ablations on a fixed subset, and sets a question budget. |
| F11 | Example 02's in-flight branch (`6c97c3a`, not on this base) has `web/csv.js`, `web/load.js` (a load plan built from `data_source_mappings`), `web/ddl.js` and `web/conformance.js`. It also has the `extensions.custom.relate-examples` convention, with a cookbook of `{id, question, cypher, uses, teaches}`. | The system-of-record work (Phase 9) reuses that loader once it is lifted into `lib/` (ADR-0008). Phase 9 waits for that branch to merge. Tool fields follow 02's cookbook names. |

## Decisions to settle before Phase 1

**Settled on 2026-11-26 by the repository owner:**
- **A:** route B, vendor under Neo4j's permission, recorded in `THIRD_PARTY.md` as NVL's is.
- **B, C, D, F:** as recommended.
- **E:** frozen, as recommended.
- **Scope:** the milestone first, then all 40 domains in the same pass.
- **Authoring:** fanned out to parallel agents as a workflow.
- **Commits:** local commits on `ex01-ontologies` at each green milestone, never pushed.

| id | Decision | Recommendation | Alternatives |
|---|---|---|---|
| A | **Licence route for the studio content** (F1) | Ask the repository's maintainers to add a licence. Apache-2.0 would match create-context-graph and the spec. Then pin the commit that adds it, and vendor the allowlisted files verbatim with their `NOTICE.md`. | **B:** written permission from Neo4j, recorded in `THIRD_PARTY.md` the way NVL's is. **C:** vendor nothing: fetch the files at run time from `raw.githubusercontent.com` at a pinned commit with sha256 pins, the way the weights are fetched. That needs a CSP `connect-src` entry, `site.json` origins and an offline cache script (`scripts/fetch-studio.sh --check`), and is the heaviest route. Under every route, the documents, gold, overlays and tools written here are this repository's own. |
| B | **What "remove the POLE+O types" means** | Remove the merged base and the pole machinery from every bundled ontology. Name each kind for what the domain calls it (Patient, Clinician, Claimant, Advisor). `Person` or `Organization` survive only where the domain's own concept really is "any person" or "any organisation", as FIBO's Business Entities does. When queries need a common super-label, use a spec-native implied label (`Clinician => Person`), never a second kind the model is asked about. | Strict: no Person, Organization or Location anywhere, only role kinds. More "ontology-pure", but the model must tell roles apart from context alone, which pushes work into the review queue. |
| C | **Store identity** | Keep each ontology's `id` (`financial-services`), so `opfs://ex01-kg-financial-services` survives, and bump the document's `version` to `"2"`. Stores built under the create-context-graph version get a migration banner (below). | New ids give fresh stores, and orphan the old ones on the live site. |
| D | **Where this repository's additions live** | Under `extensions.custom.relate-examples`, as in 02 and 03: ask cues, the extract flag, the source and card, the about text. Example queries stay in `extensions.custom.tools`, the contract the page and the audit already use. Each tool gains `question` and `teaches`, named as in 02's cookbook. There is no second list of queries. | Move tools under `relate-examples.cookbook`: one convention across examples, but it breaks pasted documents that carry tools today. |
| E | **The model-parity fixture** | Freeze it. `data/reference/gliner2-small.json` and `model.txt` keep testing gliner-rs on the create-context-graph Financial Services sample and schema (built in memory from the verbatim originals). They pin the model, not the domain, so no `--reference` re-record is needed. | Re-record on the new sample: that needs Python gliner2 on torch (`run.sh --reference`) and buys nothing. |
| F | **Group ids and paths** | `domains` (the curated 27) and `studio` (the 13). Data lives in `data/ontologies/domains/`, `data/ontologies/studio/` and `data/samples/{domains,studio,heldout}/`. "ccg" stays the name of the verbatim create-context-graph originals only. | Keep `ccg` everywhere: less churn, but misleading once the documents are curated. |

---

## Delivery order

| Phase | Deliverable | Depends on | Size | Main files (relative to this example) |
|---|---|---|---|---|
| 0 | Licence route chosen; baseline recorded; spikes S1 to S4 answered | — | S | scratch only; `NOTES.md` rows for what the spikes pin |
| 1 | The reader takes spec 1.0.0 documents; ask cues; a schema budget; key-from-name; implied-label check | 0 (S1, S2) | M | `lib/ogs.mjs`, `web/ogs.js`, `web/ontology.js`, `web/store.js`, `harness/ontology.mjs` |
| 2 | The 13 packages vendored, converted with overlays, and bundled | 0 (A), 1 | M | `harness/vendor-studio.mjs` (new), `web/studio.js` (new), `harness/convert.mjs`, `data/ontologies/studio/`, `build.mjs` |
| 3 | The 27 curated ontologies (POLE+O out), held to the ontology bar | 1 | L | `data/ontologies/domains/*.ontology.yaml`, `harness/ontology.mjs` (the bar) |
| 4 | The corpus: 40 primary documents, case-file companions, held-out set, gold v2, corpus lint | 2, 3 (each document needs its ontology) | XL | `data/samples/**`, `harness/corpus.mjs` (new) |
| 5 | Scoring v2 and re-calibrated defaults | 4 | M | `web/store.js` (`scoreAgainstGold`, `defaultGate`), `harness/run.mjs` |
| 6 | Tools that answer on an extracted graph, audited | 2, 3, 4 | M | ontology documents, `web/console.js`, `harness/run.mjs` (audit) |
| 7 | The page: picker by industry, About drawer, case files, richer Ontology tab, migration banner | 2, 3, 4 | M | `web/app.js`, `web/index.html`, `web/style.css`, `web/worker.js`, `harness/drive.mjs` |
| 8 | Harness budget: inference cache, subset ablations, new outputs, CI | 4 | M | `harness/infer.mjs`, `run.sh`, `.github/workflows/examples.yml`, `ci/README.md` |
| 9 | Beyond: reconciliation with the package records; attributes from text | 2, 4, 5; 02's loader in `lib/` | L | `lib/` (lifted loader), `harness/reconcile.mjs` (new), `web/pipeline.js`, `web/store.js` |
| 10 | Records: ADRs, NOTES rows, README, SOURCE, THIRD_PARTY, `site.json`, AGENTS.md, screenshot | every phase, as it lands | M | `docs/adr/`, `NOTES.md`, `README.md`, `THIRD_PARTY.md`, `site.json`, `../../AGENTS.md` |

Phases 2 and 3 run side by side once Phase 1 lands. Phase 4 is the long pole, but it splits cleanly
by domain: once the bar, gold v2 and the corpus lint exist, each domain's document is independent
work. (If you want that fanned out to parallel agents, say so and it can run as a workflow, with
each document checked by the corpus lint and a reviewer agent.) Phase 9 is the stretch. It is
planned in full here, but it waits on 02's branch.

---

## Phase 0: gates and spikes

**Licence (decision A).** Nothing from the studio repository is committed until the route is
settled. The documents, gold and overlays can be drafted meanwhile, because they are ours.

**Baseline.** Run `./run.sh` on the base and record wall time per section, inference count, peak
memory, and today's `score.txt` totals. Every later phase compares against these numbers.

**Spikes.** Each is a throwaway script in the scratchpad. Its result decides a design here; a
behaviour it pins becomes a `NOTES.md` row with a minimal repro on 1.3.0.

| Spike | Question | How | Decides |
|---|---|---|---|
| S1 | What does description length cost, in accuracy and time? | Insurance Claims Fraud and Retail Banking: write 30 realistic sentences each with hand gold. Ask under four variants: label only; a hand-written cue of at most 12 words; the description's first sentence; the full description. Record entity and relation F1, ms per sentence and the schema's token count (the tokenizer's own count). Then push one variant past 512 and 736 tokens to see whether G10's collapse starts from schema length. | The cue rule, the fallback for documents without cues, and the schema budget (Phase 1). |
| S2 | Implied labels under a graph type | `ALTER CURRENT GRAPH TYPE SET { (:Clinician => :Person {name :: STRING NOT NULL}) }` when Person is not itself a node type. Then publish an entity with both labels, query `MATCH (p:Person)`, and run `lib/replay` round trips in WASM and natively. | Whether decision B's super-labels work (an addendum to R16, or a new row). |
| S3 | Cost per call against ontology size | Time `extract` for 4, 8, 12 and 16 kinds with 5 to 20 relation asks on one sentence set. | The per-ontology limits in the bar, and the corpus budget (Phase 8). |
| S4 | The splitter on realistic markdown | Run `split.js` on a draft document with tables, nested lists, block quotes, footnotes, a definition list and inline code. Count units over 500 bytes and see where they are cut. | The authoring rules (Phase 4), and edge-case fixtures that pin the splitter's behaviour on each structure. |

**Acceptance:** route A, B or C chosen and written down; the baseline table recorded; each spike's
answer written down with its numbers.

## Phase 1: the reader (spec 1.0.0, ask cues, a schema budget)

1. **Spec 1.0.0 documents.** Vendor the 1.0.0 schema from `neo4j/ontology-graph-spec` at the
   release tag it was published under (Apache-2.0, beside the 1.1.0 file in `data/ontology-spec/`).
   Pin in `ontology.txt` that the two files differ only in `$id`. Then:
   - `lib/ogs.mjs` gains `SPEC_1_0_URL` and `fromSpec10(doc)`, a pure URI rewrite that refuses
     anything else;
   - `web/ontology.js` `inputOf` recognises the input as `ontology-graph-spec-1.0.0`, and
     `fromDocument` records `converted_from`;
   - the editor says "names spec 1.0.0; read as 1.1.0 (the schemas differ only in their $id)", and
     **Show as 1.1** shows the result.

   A pasted studio `ONTOLOGY.json` then opens as it is. New NOTES row (Y3): SDK 0.13.0 decodes and
   validates a document naming 1.0.0 without complaint, while the page's own rule is what refused
   it. Check at implementation time whether 02 wants the same input; if it does, the change belongs
   in `lib/ogs.mjs` only.
2. **Ask cues.** A node may carry `extensions.custom.relate-examples.ask` (at most 12 words, no
   `:`). `modelAsks` uses it as the description it sends. Without a cue, a document's node
   description is cut to its first sentence and to the character budget S1 sets, so pasted rich
   documents stay usable. The current create-context-graph rule stays unchanged for converted
   create-context-graph files.
3. **Natural link phrases.** A relationship may carry `relate-examples.phrase` ("filed", "was
   treated by", "logged in from"). The ask becomes `<head label> <phrase> <tail label>`, which
   replaces the type-derived "claimant has claim claim". The rule refusing two links that read
   alike still applies.
4. **Kinds that are not asked.** `relate-examples.extract: false` on a node sets its ask to `null`
   (the mechanism the base's Object uses today). Links with an unasked end are not asked either.
   The kind stays a node type, so data loaded by other means (Phase 9) still fits the graph type.
5. **The schema budget.** A new limit in `web/ontology.js`: the asked schema's estimated token count
   (characters divided by the ratio S1 measured) must stay under the budget. A refusal names the
   three longest asks. `ontology.txt` pins the limit on a tampered document.
6. **Key from name.** When a kind's `key` property is not `name` and declares a `pattern`, publish
   copies the canonical name into the key property when it matches, for example
   `Claim.claimID = 'CL-004417'`. The value is checked against `pattern` and `one_of` in JS, never
   trusted from the model. Studio queries keyed on identifiers then work on extracted claims,
   vehicles (VIN) and CVEs. The graph type is unaffected (it enforces `name` only).
7. **Implied labels.** If S2 holds, `checkDocument` allows an implied label that no node declares
   (spec-legal already), and the README's "what is enforced" says what the store adds.

**Tests:** `ontology.txt` gains the 1.0.0 input, the cue and phrase rules, `extract: false`, the
budget refusal and key-from-name on tampered documents. `gate.txt`'s generic document changes only
where the first-sentence fallback changes its asks: name each such change in the commit message.

## Phase 2: the 13 solution packages

**Vendoring** (by hand, online; offline `--check`): `node harness/vendor-studio.mjs --commit <sha>`.
- It fetches through `gh api` only the allowlisted files of each package: `ONTOLOGY.json`,
  `QUERIES.md`, `human_description.md`, `NOTICE.md` (when present) and `SKILL.md` (for the card
  fields). Never `TESTS.md`, `SETUP.md`, `implementation-guidance.md`, `sample-data/` (unless
  Phase 9 needs a slice) or `skills/`.
- It writes each file byte for byte into `data/ontologies/studio/<id>/`, and a `SOURCE.md` table
  with every file's sha256, the commit and the licence.
- **The name guard.** It refuses any file in which a word's sha256 equals the pinned digest of the
  engine's earlier product name, lower-cased. The name itself is never written into the script.
- `--check` recomputes the digests offline. `run.sh` fails on a mismatch, and `harness/ontology.mjs`
  runs the same check.

**Overlays, ours** (`data/ontologies/studio/<id>.overlay.yaml`): what this example adds, keyed by
node and relationship ids:
- `display.colour` (the packages have positions but no colours), one hand-picked palette per
  package;
- `relate-examples.ask` cues, `relate-examples.phrase` link phrases and `extract` flags;
- per-tool fixes where a query needs one to run on Relate 1.3.0, each with the reason (an R row);
- document-level `relate-examples`: `{source: {repo, commit, package, files}, card: {title,
  category, description}, about: 'human_description.md', industry}`.

**The converter** (`web/studio.js`, pure, shared by the harness and the page): the upstream
document, its `QUERIES.md` and the overlay become the bundled document.
- The schema URI is rewritten (Phase 1) and the overlay merged.
- `QUERIES.md` is parsed into `canonicalQuery` tools:
  - `name` is a slug of `@name`; `description` is `@description`; `cypher` is the block without
    its annotation;
  - `parameters` come from `@params`, cross-checked against the `$name` tokens, with types inferred
    from the annotation and from usage (`paramBindings` already does the latter);
  - new fields: `question` (from `@name`), `teaches` (from `@usage`), `tags`, and
    `requires: [gds|apoc]` when the text calls them;
  - each tool is anchored by the existing `toolAnchor`.
- `node harness/convert.mjs` writes `data/ontologies/ogs/studio/<id>.ontology.yaml`, and `--check`
  compares without writing (the same contract as today).

**Pinned in `ontology.txt`:**
- each bundled document is byte for byte a fresh conversion;
- the conversion is lossless (strip the overlay and the URI to get the upstream document back);
- the tools parsed per package equal its count of cypher blocks (175 in all);
- every tool's parameters match its `$` tokens;
- where each tool lands;
- what each package's model is asked.

**Build and page:** `index.json` gains the `studio` group. `human_description.md` and `NOTICE.md`
ship beside each document. `site.json` credits and `THIRD_PARTY.md` gain the packages (and FIBO,
through their notices).

## Phase 3: the 27 curated ontologies

Each becomes a hand-written document, `data/ontologies/domains/<id>.ontology.yaml`, the source of
truth, in the style of 02's `companies.ontology.yaml` (comments allowed). The create-context-graph
originals stay verbatim in `data/ontologies/ccg/` as lineage and as the converter's test corpus.
Their conversions are no longer committed: `ontology.txt` pins a digest per conversion, so the
converter is still covered. The page still converts a pasted create-context-graph file with
`_base.yaml`, and rules 2 and 2b keep serving those files.

### The ontology bar (checked by `harness/ontology.mjs`, a new "bar" section)

Every curated document, and the 13 studio documents where the bar applies to the overlay, must have
the following. The lint prints one line per gap, and the run fails on any gap.

1. **Document `description`**: 80 to 200 words on scope, the questions it answers and what it leaves
   out. Document `version` is `"2"`, and `relate-examples.source` records the lineage:
   "derived from create-context-graph's `<id>.yaml` at `707b168`, Apache-2.0; changed: …", which
   Apache-2.0 §4(b) asks for.
2. **Every kind**:
   - a description of 1 to 3 sentences: what it is, how a text names one, and how it differs from
     its nearest neighbour;
   - `aliases` (the words texts use);
   - a `reference` where an established vocabulary exists (schema.org, FIBO, SNOMED CT, MITRE
     ATT&CK, the GO, …);
   - an ask cue of at most 12 words;
   - `display` with a colour and a hand-placed position (no more circle layout for curated ones);
   - a key constraint.
3. **Every link**: a description that states direction and cardinality, endpoint `count`,
   `min_count` or `max_count` where they are known, `aliases` (the verbs texts use) and a
   `relate-examples.phrase`.
4. **Properties**: realistic ones, with identifiers carrying `pattern`, vocabularies carrying
   `one_of`, and units and formats stated in descriptions. The extractor still writes only `name`
   (plus key-from-name, and Phase 9's attributes). The README says so plainly, so nobody expects a
   property the extractor cannot write.
5. **Size**: 6 to 14 kinds and at most 20 links, within S3's cost envelope. No two kinds whose cues
   S1 showed the model confuses, unless the gate's type margin is the documented answer.
6. **Competency questions, pinned**: 8 to 15 tools per ontology (Phase 6). **Every kind and every
   link is used by at least one tool** ("no orphan kind"), and every tool returns at least one row
   on its domain's sample store (the audit pins the counts).
7. **No create-context-graph extensions** (`createContextGraph:*`), no `pole`, and no base kinds
   unless decision B allows one.

### Starting points, domain by domain

"Today" lists the domain's own kinds; every domain also inherits the base Person, Organization,
Location, Event and Object today. The proposed kinds are a starting point, settled per domain by its
competency questions. The genre comes from each domain's own `document_templates`.

| Domain | Today | Proposed kinds (POLE+O replaced by role kinds) | Primary document | Companion (case file) |
|---|---|---|---|---|
| agent-memory | Agent, Conversation, Entity, Memory, ToolCall, Session | Agent, User, Session, Message, Memory, Tool, ToolCall, Entity, Preference | agent session review | memory snapshot |
| conservation | Site, Species, Program, Funding, Stakeholder, Monitoring | Site, Species, Habitat, Programme, Grant, Funder, PartnerOrganisation, Survey, Threat, Indicator | year-three impact assessment | donor update |
| cybersecurity | Asset, Vulnerability, Alert, Incident, ThreatActor, Control, User | Asset, Vulnerability (CVE), Technique (ATT&CK), Malware, Indicator, Alert, Incident, ThreatActor, Control, Analyst, Account | post-incident review | threat brief |
| data-journalism | Source, Story, Dataset, Claim, Correction, Investigation | Journalist, Editor, Source, Story, Dataset, Record, Claim, Correction, Investigation, Subject | fact-check report | FOIA request |
| digital-twin | Asset, Sensor, Reading, Alert, MaintenanceRecord, System | Plant, System, Asset, Component, Sensor, Alert, FailureMode, WorkOrder, Technician | root-cause analysis | alert digest |
| education | Student, Instructor, Course, Term, Enrollment, Assessment, Submission | Student, Instructor, Department, Programme, Course, Term, Assessment, Submission, LearningOutcome | progress board minutes | assignment brief |
| financial-services | Account, Transaction, Decision, Policy, Security | Client, Advisor, Firm, Account, Portfolio, Security, Transaction, Decision, Policy, Limit | compliance memo: concentration review | risk assessment |
| gaming | Player, Character, Item, Quest, Guild, Achievement | Player, Character, Guild, Item, Quest, Zone, Patch, Exploit, Achievement | exploit incident and balance analysis | patch notes |
| genai-llm-ops | Model, Experiment, Dataset, Prompt, Evaluation, Deployment | Model, Provider, Dataset, Benchmark, Prompt, Experiment, Evaluation, Deployment, Engineer, Incident | evaluation report | model card |
| gis-cartography | Feature, Layer, Survey, Coordinate, Boundary, MapProject | Surveyor, Survey, Parcel, Boundary, Feature, Layer, Datum, Authority, MapProject | boundary survey report | field notes |
| golf-sports | Course, Player, Round, Tournament, Handicap, Hole | Player, Caddie, Club, Course, Hole, Tournament, Round, Sponsor | tournament recap | course evaluation |
| government | Agency, Program, Policy, Regulation, Service, Citizen, Official, Budget | Agency, Official, Programme, Policy, Regulation, Legislation, Service, Budget, Grant, Jurisdiction | programme evaluation | budget memo |
| healthcare | Patient, Provider, Diagnosis, Treatment, Encounter, Facility, Medication | Patient, Clinician, Facility, Encounter, Diagnosis, Procedure, Medication, LabResult, Allergy | discharge summary | referral letter |
| hospitality | Hotel, Room, Reservation, Guest, Service, Staff | Hotel, Room, Guest, Reservation, StaffMember, Service, Complaint, Amenity | guest incident report | revenue report |
| legal | Case, Matter, Contract, Filing, Hearing, Counsel, Statute | Party, Counsel, LawFirm, Judge, Court, Case, Filing, Hearing, Contract, Clause, Statute | case summary | contract review |
| manufacturing | Machine, Part, WorkOrder, Supplier, QualityReport, ProductionLine | Plant, ProductionLine, Machine, Part, Lot, Supplier, NonConformance, CorrectiveAction, Operator | 8D quality report | supplier evaluation |
| oil-gas | Well, Reservoir, Equipment, Inspection, Permit, Formation | Operator, Field, Well, Formation, Reservoir, Equipment, Inspection, Permit, Regulator, Incident | daily drilling report | safety inspection |
| options-intelligence | Underlying, OptionsContract, ExposureLevel, Regime, KeyLevel, Trade, MarketEvent, Strategy | Desk, Trader, Underlying, OptionsContract, Strategy, Trade, KeyLevel, Regime, MarketEvent | market brief | trade journal |
| personal-knowledge | Note, Contact, Project, Topic, Bookmark, JournalEntry | Contact, Organisation, Project, Topic, Note, Book, Meeting, JournalEntry | weekly review | reading notes |
| product-management | Feature, Epic, UserPersona, Metric, Release, Feedback, Objective | Team, Objective, Metric, Epic, Feature, Release, Persona, CustomerAccount, Feedback, Experiment | PRD | user interview notes |
| real-estate | Property, Listing, Agent, Transaction, Inspection, Neighborhood | Property, Neighbourhood, Listing, Agent, Brokerage, Buyer, Seller, Lender, Inspection, Finding | inspection report | closing summary |
| retail-ecommerce | Customer, Product, Order, Review, Campaign, Category | Customer, Product, Brand, Category, Order, Return, Review, Campaign, Warehouse | support escalation | campaign post-mortem |
| scientific-research | Researcher, Paper, Dataset, Experiment, Grant, Institution | Researcher, Institution, Funder, Grant, Experiment, Method, Instrument, Dataset, Paper, Venue | grant progress report | peer review |
| software-engineering | Repository, Issue, PullRequest, Deployment, Service, Incident | Engineer, Team, Service, Repository, Library, PullRequest, Issue, Release, Deployment, Incident | incident postmortem | design doc |
| trip-planning | Destination, Hotel, Activity, Restaurant, Itinerary, Review | Traveller, Destination, Hotel, Restaurant, Activity, Flight, Booking, Itinerary | itinerary | booking confirmation |
| vacation-industry | Resort, Booking, Guest, Activity, Season, Package | Resort, Operator, Package, Activity, Season, Guest, Booking, Review | seasonal report | guest feedback |
| wildlife-management | Species, Individual, Sighting, Habitat, Camera, Threat | Ranger, ProtectedArea, Habitat, Species, Individual, Sighting, Camera, Patrol, Threat | camera-trap and patrol report | incident report |

Overlaps with the studio family (healthcare and patient-journey; financial-services and four FIBO
packages; cybersecurity and attack-path-analysis; manufacturing and configurable-bom; research,
multi-omics and competitive-intelligence) are deliberate. The curated documents are shaped for
narrative documents, the studio ones for their packages, and the About drawer says which is which.
Where a curated kind matches a FIBO or studio concept, its `reference` points at the same IRI.

## Phase 4: the corpus

### How each document is written: facts first

1. **A fact sheet first.** It is the gold: entities `{name, type, aliases}` and relations
   `{source, target, type, how}`. It covers every kind and every link of the ontology at least once
   (the coverage check) and tells one coherent story (the case).
2. **Then the prose.** The document realises the facts in its genre's real shape: front matter,
   headings, a table where the genre has one (a claims schedule, a medication list, a CVE table),
   lists, dates, amounts, identifiers. It is 600 to 1,200 words for a primary document and 300 to
   600 for a companion.
3. **A planned mix of how facts are said**, each tagged in gold as `how`, so recall can be reported
   per phenomenon:

   | `how` | Example | Reachable by a sentence-level model |
   |---|---|---|
   | `plain` | "Dana Whitlock advises Arjun Mehta." | yes |
   | `passive` | "ACC-2207 is managed by Colm Brady." | yes |
   | `apposition` | "Colm Brady, a director at Halvorsen Pryce, …" | yes |
   | `list` | "The ring used three vehicles: …" (one unit per item) | yes, per unit |
   | `table` | a markdown row (one unit per row, E2) | yes, per row |
   | `alias` | "Halvorsen Pryce Partners (HPP) … HPP's desk" | yes, if aliases resolve (see below) |
   | `nominal` | "the claimant's treating physician, Dr Imani Okafor" | yes |
   | `cross-sentence` | the head in one sentence, the tail in the next | **no** |
   | `coreference` | "She approved it." | **no** (pronouns are never resolved) |

   Unreachable facts stay in the gold on purpose. `score.txt` reports **reachable recall** (without
   them) beside **document recall** (with them), which is the honest picture of what sentence-level
   extraction leaves behind.
4. **Distractors: 3 to 5 per document, from several families:** negation ("never worked for"),
   hedge ("may have advised"), conditional ("if approved, the loan would be secured by"), future or
   plan ("will be transferred"), reported or alleged ("the claimant alleges"), and retracted ("the
   earlier report that … was corrected"). They are listed in `distractors` and are never in the
   gold. `score.txt` breaks down by family the distractors kept, sent to review and dropped.
5. **Aliases.** When a document introduces an abbreviation or a short name, the fact sheet records
   it. The scorer keys an entity by its canonical name, its aliases folded in. The publish step does
   not merge aliases today: that gap is measured, and Phase 9 may close it with the gazetteer
   extension the gate already has.

### Gold v2 (backward compatible)

```json
{
  "entities":    [{"name": "Halvorsen Pryce Partners", "type": "Firm", "aliases": ["HPP"]}],
  "relations":   [{"source": "Colm Brady", "target": "Halvorsen Pryce Partners", "type": "EMPLOYED_BY", "how": "apposition"}],
  "distractors": [{"source": "Colm Brady", "target": "Trim Decision", "type": "ADVISED", "family": "hedge"}],
  "case": "fs-concentration-2026"
}
```

`distractors.json` folds into each gold file. A gold file without `how` reads as `plain`, so old
fixtures still parse.

### Rules for the synthetic data

- **Fictional:** every person, company, account, claim and vehicle. **Real:** cities and regions,
  and public scientific, medical and regulatory vocabulary (disease names, gene and protein symbols,
  INN drug names, CVE ids, ATT&CK technique ids, FCA sourcebook references such as MIFIDPRU and
  SYSC).
- Identifiers and contact details use ranges that cannot reach anyone:
  - IP addresses from the RFC 5737 documentation blocks (192.0.2.0/24, 198.51.100.0/24,
    203.0.113.0/24);
  - e-mail at `example.com`, `.org` or `.net` (RFC 2606);
  - phone numbers from the drama ranges (Ofcom 01632 960xxx; US 555-01xx);
  - SSNs only in never-issued ranges (area 000, 666 or 9xx);
  - VINs that fail the check digit;
  - no card numbers at all.
- Every document's front matter says `synthetic: true` and what it was written from (the template,
  or the package and its sample-data slice).
- The corpus lint enforces these patterns: an IP outside the documentation blocks, an e-mail domain
  outside the reserved ones, or an SSN in an issued range fails the run.

### The 13 studio documents

Each narrates a slice of its package's own sample data, so its gold can be checked against the
records (Phase 9), and so every query the page runs finds familiar names.

| Package | Category | Kinds, links (graph type / gate only) | Queries | Document | Slice of the sample data |
|---|---|---|---|---|---|
| attack-path-analysis | Cybersecurity | 7, 7 (6/1) | 14 | penetration-test finding: internet to crown-jewel data | an exposed endpoint, a known-exploited CVE (real ids from `cves.csv`), the instance, the role it assumes, the policy, the cloud service |
| business-entities | Financial Services (FIBO) | 5, 12 (10/2) | 13 | beneficial-ownership due-diligence memo | an ownership chain across jurisdictions, a trust with trustee and beneficiary, directors, a politically-exposed flag |
| competitive-intelligence | Healthcare & Life Sciences | 7, 7 (5/2) | 11 | competitive landscape brief: BACE1 inhibitors in Alzheimer's | drug codes, sponsors, targets, trials and phases, and patents, from the sample data |
| configurable-bom | Manufacturing | 4, 3 (1/2) | 10 | engineering change notice for a configurable bicycle | assemblies, configuration groups (brakes, gears), part numbers (`P-CHAIN`, …) |
| ev-route-planning | Manufacturing | 3, 2 (1/1) | 21 | road-trip charging plan | the car, cities, stations, the road legs between them |
| identity-validation | Industry Agnostic | 9, 8 (8/0) | 15 | fraud analyst case note: a synthetic-identity cluster | identities sharing an SSN, phone, address and IP (in the safe ranges above) |
| insurance-claims-fraud | Insurance | 4, 5 (5/0) | 11 | SIU referral: a staged-accident ring | claimants with repeat claims, a recurring VIN, a concentrated treating professional, claim ids `CL-…` |
| loans-and-mortgages | Financial Services (FIBO) | 9, 12 (12/0) | 13 | mortgage underwriting memo | the applicant, application, product, appraisal, guarantor, officer, institution |
| multi-omics | Healthcare & Life Sciences | 11, 15 (13/2) | 14 | study results summary | project, samples, tissues, phenotype, differential genes and proteins, pathways, GO terms |
| patient-journey | Healthcare & Life Sciences | 8, 8 (8/0) | 14 | longitudinal care summary | encounters in order, observations, conditions, drugs, providers, specialities, organisations |
| regulatory-dependency-mapping | Financial Services | 2, 2 (1/1) | 12 | regulatory change impact memo | MIFIDPRU and SYSC sections and their cross-references |
| retail-banking | Financial Services (FIBO) | 12, 13 (12/1) | 14 | AML investigation narrative | customers, accounts, a transaction chain, sessions, devices and IPs, a shared passport |
| securities-reference-data | Financial Services (FIBO) | 7, 12 (12/0) | 13 | security master exception report | issuer, security, identifiers (ISIN, CUSIP), listings, exchanges, fund holdings, underwriters |

### Case files, splits and volume

- **Case files.** Eight flagship domains (financial-services, healthcare, cybersecurity, legal,
  insurance-claims-fraud, retail-banking, manufacturing, software-engineering) get one or two
  companion documents that share entities with the primary one. Extracting the whole case shows
  entities accumulating across documents (`queries/03-entities-across-documents.cypher`) and the
  same fact confirmed by two sources.
- **Splits.**
  - **dev:** the 40 primary documents and the companions. The page lists them, and the cutoffs are
    calibrated on them.
  - **held-out:** 12 documents: the 6 of today rewritten under the new ontologies, plus 6 new ones
    including 3 studio packages. They are never listed and never tune anything.
- **Volume** (estimate, checked against S3 before writing at scale): about 40,000 words of dev and
  about 8,000 of held-out, or about 2,600 sentences, against about 450 today. Gold: about 1,400
  entities and 1,200 relations.

### The corpus lint (`harness/corpus.mjs`, output `corpus.txt`, diffed)

For every document, it checks:
- every gold name and alias occurs in the text as the store would key it (`names.js`);
- every `reachable` relation has both ends in one unit of `split.js`, and every unreachable one
  does not (so the tags cannot lie);
- every relation is legal in the ontology, either way round for a symmetric link;
- the ontology's kinds and links are all covered across the domain's documents;
- no distractor is in the gold;
- the front matter and length are within budget;
- the synthetic-data patterns above hold.

It also prints the per-domain phenomenon and distractor mix, so the corpus's shape is reviewable
in a diff.

## Phase 5: scoring and calibration

- **Breakdowns** in `score.txt`: P, R and F1 overall, per domain, per family (domains and studio),
  per `how`, reachable against document recall, and distractors by family.
- **Calibration objective.** The defaults are chosen to maximise recall subject to kept-fact
  precision of at least 0.90 on dev, instead of F1. In a knowledge graph a wrong kept fact costs
  more than a fact left in review, and the review queue exists for the uncertain ones. Verify on
  held-out and report both. The F1-optimal grid point is still printed for comparison.
- **Per-kind reliability:** a table of predicted score band against observed precision, per kind and
  per link, on dev. G2 and E4 say the scores are not calibrated; this shows by how much, where.
  Per-ontology cutoff overrides (`relate-examples.cutoffs`) are allowed only where the grid shows a
  clear dev gain that holds on held-out, and each is listed in `score.txt`.
- **The hedge cue list** (`store.HEDGE_CUES`) is revisited on the distractor families: "alleged",
  "reportedly", "pending", "proposed", "if approved", "would". Each addition is measured on dev and
  checked on held-out, and the README says the list is blunt.
- **Ablations**, kept and extended: asked as ids, against the ontology's asks, against cues, against
  first sentences, against full descriptions. They run on a fixed subset (8 dev plus all held-out),
  not the whole corpus (Phase 8's budget).
- **Rules 2 and 2b** stay as they are, for pasted create-context-graph files; `gate.txt` keeps a
  create-context-graph fixture so they stay covered. The README says the POLE preference applies
  only to those files.

## Phase 6: example queries that answer on an extracted graph

Today 113 of 220 tools return nothing on the extracted samples, because they key on properties the
extractor never writes. The new standard is that every tool in a bundled ontology answers on the
graph the page builds, or says honestly why it cannot.

- **Categories**, so every ontology teaches the same moves. Each tool carries `question` (the
  natural-language question), `description`, `cypher`, `parameters` (with an example value, which
  prefills the form) and `teaches` (one sentence on the Cypher idea):
  - **lookup**: an entity by name, through a FULLTEXT index on `name` where the ontology declares
    one;
  - **neighbourhood**: everything one hop around an entity, typed;
  - **multi-hop**: the domain's signature path (claimant, then claim, then vehicle, then claim,
    then claimant);
  - **aggregation**: the domain's counting question, written to R20's rule;
  - **evidence**: a fact together with the sentences that support it. On the extracted graph each
    relationship carries `p`, `claims`, `sentences` and `docs`, and the trace reaches the words,
    so "why do we believe this?" is one query;
  - **review**: claims about an entity still waiting for a verdict;
  - **cross-document**: entities and facts confirmed by more than one document in the store.
- **Studio tools** are parsed as Phase 2 describes. `toolCompat` predicts their behaviour, and the
  audit records what actually happens for each: rows, no rows (and why), or errors (GDS or APOC
  absent; a Relate gap gets an R row). Key-from-name makes identifier-keyed ones work.
- **The audit** (`audit.txt`) runs every tool of every bundled ontology on its domain's sample store,
  with the example parameters, and pins its row count. The bar fails a curated tool with 0 rows. The
  existing toolCompat-against-actual comparison stays, and its misses are listed.
- **Saved queries** (`queries/`): add `09-evidence-for-a-fact`, `10-what-the-documents-say-about`
  and `11-facts-confirmed-twice`, each with its `@param` lines, so they run identically on WASM and
  natively (`native.txt`).

## Phase 7: the page

- **Picker.** One select, grouped by industry. The studio's closed card categories (Financial
  Services, Insurance, Healthcare & Life Sciences, Manufacturing, Cybersecurity, Industry Agnostic)
  are extended with a few for the curated domains (Public Sector, Media, Software, Travel &
  Hospitality, Science, Consumer). Each entry is badged with its family. The page still opens on
  Financial Services.
- **About this domain.** A drawer showing the document's description, the competency questions (its
  tools), and for studio packages their `human_description.md`. That needs a small in-house
  markdown renderer: headings, paragraphs, lists, tables, emphasis and code, and no raw HTML. It is
  written here, under the CSP, with its own test cases in `browser.txt`. No third-party renderer
  is added (ADR-0009).
- **Case files.** Under step 1, the documents of the domain's case, each with **Load**, and
  **Extract the whole case**, which extracts each in turn: per-section stop and continue, and
  verdicts, still work.
- **Ontology tab.** The NVL picture's side panel shows a kind's or link's description, aliases,
  reference (a link), properties with their types and patterns, cardinalities, the ask cue, whether
  the graph type or only the gate enforces it (F5), and the tools that use it.
- **Console.** Tools grouped by category, each headed by its `question`, parameters prefilled with
  their examples, and the toolCompat note as today.
- **Graph side panel.** "Questions about this entity": the tools anchored on its kind, prefilled with
  its name (`prefillChoice`, as today).
- **The migration banner**, below.
- **The screenshot** is retaken after the visible changes
  (`node harness/drive.mjs --smoke --screenshot screenshot.png`, against a local `./run.sh --site`).

### Stores built under the create-context-graph documents

On the live site, `ex01-kg-<id>` stores hold create-context-graph-converted documents, and their
data carries POLE+O labels. On open:
1. The worker sees a stored document converted from create-context-graph whose id matches a bundled
   curated document with a newer `version`.
2. A banner says: "Financial Services has a new ontology (version 2): real-world kinds instead of
   create-context-graph's POLE+O. This store holds N documents extracted under the old one. Rebuild
   and extract again (the model is asked again), or keep the old ontology."
3. **Rebuild** drops the typed projection, applies the new document and **re-extracts from the
   stored sentences**: `_Sentence.text` is kept, and extraction is per sentence anyway. Verdicts on
   mentions and claims that no longer exist are kept, but marked orphaned. The inference cache's
   keys change with the schema (D7), as O7 describes for the draft migration.
4. **Keep** leaves the store alone and remembers the choice (`ex01.keepOntology.<id>`).

`browser.txt` gains a store made by today's build (a committed fixture tar made with
`lib/opfsfmt.py`), opened by the new build, rebuilt, and compared with a fresh extraction.

## Phase 8: harness, budget, outputs

- **A deterministic inference cache for the harness.** `harness/infer.mjs` stores each answer under
  D7's key (model, revision, weights, gliner-rs build, schema, floor, sentence) in
  `.cache/ex01-infer/`. A cached answer is the same string a fresh call returns (G7 pins byte
  identity), so outputs do not change.
  - Each run re-asks a fixed 3% sample (and the three G7 questions) and fails on any difference;
  - `EX01_INFER_CACHE=off` forces every question;
  - CI keeps the directory in `actions/cache`, keyed on the weights' sha256 and the gliner-rs
    build, and a cold run is the proof.
  - A new design id records this. It is not an ADR, because it is easy to reverse.
- **Budget.** A cold run asks at most 3,500 questions, which fixes the ablation subset size. CI for
  01 takes at most 25 minutes cold and 12 warm. `EX01_INFER_THREADS` defaults to the runner's CPU
  count, capped by memory at about 700 MB per thread.
- **The browser section** extracts the Financial Services primary document (about 50 sentences, on
  one thread in Chromium), and a two-document case for the cross-document flow. Its equality with
  Node is kept.
- **Outputs.**
  - **New:** `corpus.txt` (Phase 4) and `reconcile.txt` (Phase 9).
  - **Changed, each change classified in the commit:** `ontology.txt` (bar, studio conversions,
    1.0.0 input, digest per create-context-graph conversion); `extract.txt`, `gate.txt`,
    `audit.txt`, `review.txt` and `score.txt` (new corpus); `browser.txt`; `native.txt` (new saved
    queries); `graph.cypher` (new stores).
  - **Unchanged:** `model.txt` and `probes.txt` (decision E; no engine change).
- `ci/changed-examples.sh` needs no change, since the new paths are inside the example.

## Phase 9: beyond the basics (stretch, planned)

### 9a. Reconcile with the system of record (studio packages)

Each studio document narrates rows of its package's sample data, so the page can show what a
real deployment would: what the document adds to, confirms in or contradicts in the records.

1. Vendor a slice of each package's `sample-data/` (the rows the document narrates and their
   neighbours, at most about 500 rows, licence permitting) into
   `data/samples/studio/<id>/records/`.
2. Load the slice through the document's own `data_source_mappings`, with 02's mapping-driven loader
   lifted into `lib/` (ADR-0008) once 02's branch merges. The same load plan runs on WASM and
   natively, and the digests must agree. `LOAD CSV` is compiled out of WASM (R8), so the loader
   uses parameterised `UNWIND` batches.
3. **Reconcile** the extracted graph with the reference store. Two graphs in one statement are
   refused (R17), so each side is queried separately and compared in JS on keyed sets: entities by
   key, facts by (head key, type, tail key). Each fact is **confirmed** (in both), **new** (only in
   the text), **contradicted** (the records link the head to another tail for a `count: 1` end), or
   **missing** (in the records' slice but not extracted).
4. The page gets a **Compare with the records** panel for studio domains, with each fact's sentence.
   `reconcile.txt` pins the counts. The gold must agree with the records (a lint), so a gold error
   shows up as a contradiction.

### 9b. Properties from text (moved into this pass on 2026-11-26, D27)

Declared properties the documents state (`Claim.amountClaimed`, `Claim.date`, `Transaction.amount`,
`Transaction.tradeDate`, `CVE.cvssScore`) become extractable when the overlay or the document marks
them, with `extensions.custom.relate-examples: {extract: true, ask?}` on the property (the spec
allows custom extensions on a property).

**What the model already does (spike S5).** gliner-rs's WASM entry point, `extractCli`, takes
GLiNER2's structures (records with fields) beside entities and relations in one call; `web/gliner.js`
passed `[]` until now. On "Karen Gonzalez filed CL-000761 on 9 January 2024, seeking £28,449" a
`claim` structure gives the reference (0.79), the amount (0.99) and the date (0.95), at about 150 to
200 ms more per sentence.

The spike also showed three failure modes the gate must catch:
- the anchor field picks spans of another kind ("CL-000761" as a VIN);
- a choice field answers without a span when the text says nothing ("grey" at 0.87);
- table rows give run-on spans at low scores.

**Design.**
1. **Ontology.**
   - A property may be marked `extract: true` only when it is a STRING (a choice field when it has
     `one_of`), INTEGER, FLOAT, DATE or BOOLEAN, and it is not `name` or the kind's key.
   - Its `ask` is the field's description.
   - The fields count toward the schema budget.
2. **The model's schema.** A kind with extracted properties is a structure, named by the kind's label
   text. Its first field, `name`, is the anchor ("the <kind> it is about"), then one field per
   property, named by its label text. `structures` join the cache key (D7) only when there are any,
   so no other document's keys move.
3. **Candidates.** Each structure instance gives one `(:_Attribute {kind, prop, anchor, text, value,
   valid, p})` per field that has a span in the sentence, linked `-[:_IN]->` its sentence.
   - The score `p` is the lower of the anchor's and the value's.
   - The value is parsed in JS by the property's type:
     - money and numbers have their symbols and separators stripped;
     - dates in the forms documents use become ISO;
     - `one_of` and `pattern` must hold.
   - `valid` records the result.
   - Every candidate at the floor is stored, as mentions and claims are.
4. **The gate** (rule 8, `attributes`, in Cypher, mirrored by the rule invariant's JS gate):
   - `unparsed` drops an invalid value;
   - `unanchored` drops one whose anchor is not a kept mention of the kind in the same sentence
     (span, else canonical name), and `end-in-review` holds one whose anchor is in review;
   - `band` applies the attribute cutoffs (keep 0.50, drop 0.30 to start; settled on the grid);
   - `hedged` sends a kept value in a hedged sentence to review;
   - `other-value` keeps one value per (entity, property), the best, and sends a different one to review.
5. **Publish** writes each kept value onto its entity as the declared type (DATE through `date()`),
   links `(:_Attribute)-[:_OF]->(:_Entity)` for the evidence, and removes a value no longer kept.
6. **Gold v2** gains `properties: [{entity, property, text, value}]`. The lint checks:
   - the entity is a gold entity of a kind whose property is extracted;
   - `text` occurs in the document;
   - it parses to `value`.
   `score.txt` and `domain.mjs` score the published values per document.
7. **The page.** The graph's side panel lists an entity's extracted properties with the sentence each
   came from; the Ontology tab marks the extracted properties.
8. **Where it starts.** Insurance Claims Fraud (`Claim.amountClaimed`, `Claim.date`) and Financial
   Services (`Transaction.amount`, `Transaction.tradeDate`, `Account.accountType`). Then every domain
   whose documents state values, in a follow-up authoring pass.

The packages' money and date queries (medical professionals by total claim value, …) are what this
unlocks on an extracted graph.

### 9c. Aliases into one entity

"Halvorsen Pryce Partners (HPP)" makes HPP an alias of the entity for the document, through the
gazetteer extension the gate already reads (`edgextract:gazetteer`), fed per document by a
parenthetical-abbreviation rule. It is measured against gold v2's `aliases`. It ships only if
held-out precision holds.

## Phase 10: records

- **ADRs.** The next free number on this base is 0019; re-check it against `main` and 02's branch
  when landing.
  - **ADR-0019**, "Example 01's bundled ontologies are curated documents; POLE+O is gone". It
    records decisions B, C, D and E and the migration. It is hard to reverse (stores, corpus and
    gold rest on it), surprising (a reader of today's README expects lossless conversions of
    create-context-graph, POLE+O base included), and the result of a trade-off (fidelity to the
    upstream against real-world modelling). It leaves ADR-0007 in force: every document is still
    read through the SDK and checked against the published schema.
  - **ADR-0020**, "Neo4j's solution packages as a second source": the licence route, the vendoring
    and the name guard.
  - Each is added to `docs/adr/README.md`.
- **NOTES.md.**
  - Y3: spec 1.0.0 documents through the SDK.
  - The S2 result (R16 addendum or a new R row).
  - A row for each Relate gap a studio query hits, re-verified on 1.3.0. Their RELATE.md records
    results on Relate 1.0.1, such as `shortestPath` between a node and itself; those are leads,
    never cited.
  - Design ids: D20 curated ontologies, D21 the studio packages and overlays, D22 cues, phrases and
    the schema budget, D23 the corpus method and gold v2, D24 the inference cache, D25 key-from-name.
- **README.** Rewrite "Using the page", "What the model is asked", "The samples and what they score",
  "Ontologies", "The ontology's tools", "Credits and licences" and "Files". The 27 becomes 40
  throughout. Add a section, "How the documents are written".
- **SOURCE.md** files for `domains/`, `studio/` and the samples. **THIRD_PARTY.md** and `site.json`
  `credits` (the packages, FIBO through their notices). `site.json` `summary` gets new card text.
- **AGENTS.md.** 01's line (domains, ids), the commands (`vendor-studio.mjs`, `corpus.mjs`), and a
  hard rule for the studio vendoring and the name guard.
- **The hard-rule checks before every commit:** the two name searches, the CSP and relative URLs
  (`site/build.mjs`), the per-origin names (`ex01.*`), `uv run pytest -q`,
  `node harness/convert.mjs --check`, and a full `./run.sh` read diff by diff.

---

## Risks

| Risk | Signal | Mitigation |
|---|---|---|
| The licence never comes | Phase 0 stalls | Route C (fetch at run time) keeps the studio family, or the curated 27 ship alone. Phases 1, 3, 4 (curated) and 5 do not depend on it. |
| Rich asks collapse extraction | S1 F1 drops, or calls slow sharply | Cues of at most 12 words, the schema budget, `extract: false` on prose-hostile kinds. |
| Realistic prose scores far lower | dev F1 well below today's 0.95 | Expected, and reported honestly: reachable against document recall, a precision-first objective, per-phenomenon rows. The page's review queue is the product answer. |
| The corpus outgrows CI | cold run over 25 minutes | Ablations on a subset, the inference cache, tighter document lengths. |
| Gold drifts from the text | corpus lint failures | Fact-first authoring, the lint, and gold agreement with the records (9a). |
| Curated ontologies over-fit the samples | tools pass only on their own document | Held-out documents run the tools too (the audit reports them, not pinned to at least one row). |
| Live-site stores break | browser migration test | The migration banner, the rebuild from stored sentences, and "keep". |
| The earlier product name leaks in | the name check | The vendoring allowlist and digest guard; the AGENTS.md checks before each commit. |

## Done means

- 40 domains on the page, each with an ontology that meets the bar (or, for studio packages, its
  upstream document plus an overlay that does), a primary document, gold v2, and tools that each
  return rows on its sample store.
- Example 01's README tells the truth about every number. `score.txt` reports dev and held-out with
  the breakdowns above, and no default was tuned on held-out.
- `./run.sh` passes offline and byte-stable, within the budget. `browser.txt` covers the new page
  flows and the migration. `native.txt` runs the new saved queries identically.
- ADR-0019 and ADR-0020 are accepted, the NOTES rows are re-verified on 1.3.0, and THIRD_PARTY.md
  and site credits are complete.

## Not in scope

No language model on the page. No change of engine, model or pin (ADR-0005). No server. No change to
OPFS, the console lease, download and restore beyond the migration fixture. No GDS or APOC emulation.
