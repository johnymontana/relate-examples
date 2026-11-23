// @ts-check
/**
 * store.js: the trace, the inference cache, the gate, the review verdicts and the typed knowledge
 * graph of one ontology's store, all in Relate (D7-D10, D16, D17; NOTES.md R2-R9, R16, R19, O4).
 *
 * Shared by the engine worker (web/worker.js) and the Node harness (harness/run.mjs). Like
 * ontology.js it never imports lib/relate_wasm.mjs: every function takes the database handle `db` (a
 * RelateDb) and that module as `cl`. Everything is synchronous (WASM has no transaction
 * control, R2: each statement autocommits and a script keeps what ran before a failure, so
 * every write here is an idempotent MERGE and D9's completion markers are written last). Float
 * parameters go through toFloat() (R5: an integral JS number binds as INTEGER). No property map
 * reads a variable bound by another part of the same MATCH (older engines planned such a map
 * before its variable was bound, and it then matched every node; kept as a defensive rule); such
 * lookups are a second MATCH clause or a WHERE.
 *
 *   const s = openStore(db, cl, ontology);      // DDL + applyOntology + the R16 repair + the index check
 *   writeDocument / startRun / writeSection / finishRun     (web/pipeline.js drives these, D9)
 *   const g = gate(db, cl);                     // D10 rules 1-7 in Cypher -> {mentions, claims}
 *   const p = publish(db, cl);                  // D16: kept facts -> (:_Entity:KIND)-[:REL]->(:_Entity:KIND)
 *   addVerdict(db, cl, {target, value: 'accept'|'reject'})   // rule 7, latest wins
 *   scoreAgainstGold(db, cl, gold)              // P/R/F1 in Cypher against (:_Gold) rows
 *   exportCypher(db, cl)                        // graph.cypher: the typed graph as UNWIND batches
 *   dumpStore(db)                               // dump.json: canon(dump(db)) from lib/replay.mjs (D17)
 *
 * The schema (D8) this module adds to ontology.js's layer; keys are in MERGE maps, every lookup key
 * has a UNIQUE constraint whose backing RANGE index serves its lookups (R9; the one key without a
 * UNIQUE keeps its own plain index). Every label and relationship type the
 * example writes for its own bookkeeping starts with `_` (ontology.js RESERVED_PREFIX), which no
 * ontology id may (isOntologyId): the published graph is (:_Entity:<Kind>)-[:<TYPE>]->(:_Entity:<Kind>)
 * with the ontology's own labels and types, so a kind named Entity or Claim (create-context-graph's
 * agent-memory and data-journalism) is a second label on an _Entity and touches nothing internal.
 *   (:_Document {id: sha256(text), title, chars})
 *   (:_Section {key: '<doc>#s<n>', n, doc, complete})-[:_OF]->(:_Document)   complete=true written last (D9)
 *   (:_Sentence {key: '<doc>#<idx>', idx, doc, start, end, text, heading})-[:_IN]->(:_Section)
 *   (:_Inference {key, model, rev, weights, build, floor, schema, parts})<-[:_INFERRED]-(:_Sentence)
 *   (:_InferencePart {key: '<inference>#<n>', n, text})-[:_OF]->(:_Inference)  raw JSON, <= 16,000 chars each
 *   (:_Mention {key, doc, sentence, start, end, text, label, name, plain, p, source, band, rule, alt})-[:_IN]->(:_Sentence)
 *     name: the entity key's NAME (names.js mentionName with the kind's label words); plain: the same
 *     without the kind's words (titles still dropped), which rule 2b also compares; both refreshed on open;
 *     alt: the kind the name is kept as when rule 2b sent this one to review
 *   (:_Claim {key, doc, sentence, rel, p, hs, he, ts, te, htext, ttext, hjs, hje, tjs, tje, hkeys, tkeys,
 *            band, rule, cue, hm, tm, hk, tk, hn, tn, head, tail})-[:_EVIDENCE]->(:_Sentence)
 *     hs..he and ts..te are the model's spans; hjs..hje and tjs..tje the same spans without leading
 *     and trailing punctuation and whitespace (joinSpan), which rule 3 joins on; hkeys and tkeys the
 *     'KIND|NAME' an end would have as a mention of each kind (claimEndKeys), which rule 3 joins on when
 *     no mention contains the end; cue the hedge or negation cue rule 5's hedge cap found (HEDGE_CUES)
 *   (:_Claim)-[:_HEAD]->(:_Mention), -[:_TAIL]->(:_Mention)             written by the gate (rule 3)
 *   (:_Run {id: '<doc>#<n>', doc, model, rev, floor, sections, sentences, inferences, hits, status, ts})-[:_READ]->(:_Section)
 *   (:_Verdict {key: 'v<seq>', target, kind, value, ts, seq})-[:_ON]->(:_Claim|_Mention)
 *   (:_Entity:KIND {key: 'KIND:NAME', kind, norm, name, display, docs, mentions, generation})<-[:_OF]-(:_Mention)
 *   (:_Entity:KIND)-[:REL {p, claims, sentences, docs, generation}]->(:_Entity:KIND)
 *   (:_Gold {key, kind: 'doc'|'entity'|'relation', doc, title, src, rel, tgt})   (score only)
 * Offsets are Unicode code points into the document (D8), as split.js and gliner-rs count them.
 * `ts` is timestamp(), the statement clock (R19), with `seq` as the tie-break: two verdicts in one
 * statement share a `ts`, so "latest" is ts, then seq.
 * Keywords work as labels, types, properties, aliases and map keys: `drop` is a property (l.drop),
 * an alias and a map key (`AS drop`).
 */
import { schemaKey } from './gliner.js';
import { entityName, kindWords, mentionName } from './names.js';
import { applyOntology, isOntologyId, ONTOLOGY_KEYS } from './ontology.js';
import { canon, cmp, dump, sha256 } from '../../../lib/replay.mjs';

// ---- defaults -----------------------------------------------------------------------------------

/**
 * The gate's default cutoffs and margins on GLiNER2.5-small-v1, for every ontology: a
 * create-context-graph document, and any other document (Ontology.format 'generic', asked the
 * same way: label texts, links between their endpoints), which has no gold set of its own. Each
 * value is on a 0.05 grid, set on create-context-graph's 27 samples (written in short declarative
 * sentences, one fact each) with the model asked as pipeline.modelSchema asks
 * it and the gate as below, and checked on six held-out documents written the same way and never
 * tuned on (expected/score.txt "settling the defaults" and "the held-out set"). Kind and link cutoffs are stored per Kind and LinkType when a store is first opened, so the
 * page's sliders move them per kind afterwards (D10 rule 5); defaultGate() gives the set for another
 * model. They suit plainly written text and were calibrated on these samples: on denser prose (an
 * earlier, wordier version of the samples) relations score P 0.808 here, 0.867 at 0.60/0.45 and 0.958 at 0.75/0.60
 * (entities P 0.400, 0.432, 0.505), so raise them on the Cutoffs tab for such text.
 *   entKeep 0.50  entity F1 on the samples 0.935 at 0.40, 0.950 at 0.50, 0.939 at 0.60, 0.884 at 0.75;
 *                 below 0.60 more claims anchor on a kept end instead of waiting on one in review
 *                 (relation recall 0.888 at 0.40, 0.861 at 0.50, 0.759 at 0.60, 0.594 at 0.75). Domain
 *                 kinds score 0.5 to 0.9 where Person scores 0.99, so 0.75 left many of them in review.
 *   entDrop 0.30  the drop cutoffs decide only what waits in review (no kept fact moves): at 0.30 the
 *                 samples' queue holds 95 mentions (181 at 0.20)
 *   relKeep 0.35  relation precision is 1.000 from 0.30 to 0.70 on the samples while recall falls
 *                 (0.865 at 0.30, 0.861 at 0.35, 0.782 at 0.40, 0.281 at 0.60); 0.25 keeps a false
 *                 fact. Between 0.35 and 0.60 lie 189 true facts and 3 false ones, which rule 6 holds in
 *                 review. The hedge cap, not the band, keeps the distractors out: none is kept at any
 *                 keep from 0.25. Held out: relations P 0.979 R 0.723, no distractor kept.
 *   relDrop 0.20  E4's; at 0.30 the claims in review would fall from 53 to 37 and the best claims of 8
 *                 gold relations would drop (score.txt, "drop cutoffs")
 *   typeMargin 0.05  on the samples it sends 9 mentions to review; entity F1 0.953 at 0, 0.950 at 0.05
 *                    (one true entity more and one false fewer at 0: not moved on one entity)
 *   relMargin 0.05   D10's value; rule 6 sends 6 claims to review on the samples, at 0 as at 0.05 (a
 *                    weaker second link for one pair in one sentence goes whatever the margin)
 *   poleMargin 0.25  rule 2's POLE preference (create-context-graph's poles only): entity F1 0.925 with it
 *                    off, 0.950 at 0.25, 0.951 at 0.40 to 0.60 (score.txt, "the pole margin")
 * The margins are the page's (state.gate), the same for every model. (Earlier builds' defaults:
 * 0.75/0.20 and 0.60/0.20 before the samples were rewritten; edgextract's format had 0.85/0.70 from its golden set,
 * LEGACY_DEFAULTS.)
 */
export const DEFAULT_GATE = Object.freeze({
  entKeep: 0.5, entDrop: 0.3, relKeep: 0.35, relDrop: 0.2, typeMargin: 0.05, relMargin: 0.05, poleMargin: 0.25,
});

/** The model the defaults assume when none is named (models.js DEFAULT_MODEL). */
export const DEFAULT_MODEL = 'small';

/**
 * Per-model changes to the defaults (models.js keys). base-v1 keeps relations at 0.50: on the samples
 * relations P 0.952 R 0.726 there (P 0.949 R 0.733 at 0.35; P 0.978 R 0.287 at its earlier 0.90/0.90)
 * and entities F1 0.899 at the entity keep 0.50 (0.811 at 0.90). 0.35 would add 2 true facts and 1
 * false one here, and 3 and 9 false ones with no true one on the earlier, wordier samples. Its earlier 0.90/0.90 kept hedged claims out, which the hedge cap now does at every keep
 * pair from 0.35 to 0.95. On dense prose it costs precision as small-v1's do (relations P 0.748 here,
 * 0.887 at 0.90/0.90). Held out: relations P 0.980 R 0.738. The drops are DEFAULT_GATE's.
 */
export const MODEL_GATES = Object.freeze({
  base: Object.freeze({ relKeep: 0.5 }),
});

/**
 * The gate's defaults for an ontology and a model: DEFAULT_GATE with MODEL_GATES[model] over it.
 * Every format takes the same ones (create-context-graph's, as the page asks a generic document as it
 * asks create-context-graph's); the format stays an argument so a format of its own could have them.
 * @param {string} format  ontology.js Ontology.format ('create-context-graph' or 'generic')
 * @param {string} [model]  'small' or 'base' (models.js keys); another value gets small-v1's
 * @returns {Readonly<typeof DEFAULT_GATE>}
 */
export function defaultGate(format, model = DEFAULT_MODEL) {
  void format;
  const over = /** @type {Record<string, any>} */ (MODEL_GATES)[model] ?? {};
  return Object.freeze({ ...DEFAULT_GATE, ...over });
}

/**
 * The defaults stores were initialised with before cut_src existed (one set for every format, then
 * edgextract's: kinds 0.85/0.20, links 0.70/0.20): applyDefaultCutoffs counts a cutoff still at these
 * as a default, any other one as the user's.
 */
export const LEGACY_DEFAULTS = Object.freeze({ kind: Object.freeze({ keep: 0.85, drop: 0.2 }), link: Object.freeze({ keep: 0.7, drop: 0.2 }) });

/** The gate's rules in D10's order, by the names gate({off}) uses (the `rule` column names what decided each row). */
export const RULES = Object.freeze(['gazetteer', 'one-kind', 'name-kind', 'span-join', 'legality', 'band', 'hedge', 'ambiguity', 'verdicts']);

/** A character that is not a letter, a digit or `_` (Unicode): a cue's word boundary, the same in Cypher and JS. */
const NOT_WORD = '[^\\p{L}\\p{N}_]';
/**
 * The hedge and negation cues of rule 5's hedge cap (rule `hedged`), in the order they are tried:
 * [cue, regex body, case-insensitive, word boundary before]. Every cue has a word boundary after it.
 * "may" and "no" are lower case only, so the month May and "No. 4" are not cues (and a sentence that
 * starts with either is not caught); "n't" ends a word ("didn't"). small-v1 and base-v1 score
 * "Tomas Reyes never worked for Pell Street Partners." like a fact (0.63 and 0.95), and the band
 * cannot tell the two apart, so a person decides.
 */
export const HEDGE_CUES = Object.freeze([
  // negation
  ['not', 'not', true, true], ["n't", "n['\u2019]t", true, false], ['never', 'never', true, true], ['no', 'no', false, true],
  ['none', 'none', true, true], ['neither', 'neither', true, true], ['nor', 'nor', true, true], ['cannot', 'cannot', true, true],
  ['denied', 'den(?:y|ies|ied)', true, true], ['ruled out', 'ruled\\s+out', true, true],
  // hedges
  ['may', 'may', false, true], ['might', 'might', true, true], ['could', 'could', true, true], ['possibly', 'possibl[ey]', true, true],
  ['perhaps', 'perhaps', true, true], ['probably', 'probabl[ey]', true, true], ['likely', '(?:un)?likely', true, true],
  ['reportedly', 'reportedly', true, true], ['allegedly', 'alleged(?:ly)?', true, true], ['supposedly', 'supposedly', true, true],
  ['apparently', 'apparently', true, true], ['rumoured', 'rumou?r(?:ed|s)?', true, true], ['unconfirmed', 'unconfirmed', true, true],
  ['unverified', 'unverified', true, true], ['suspected', 'suspected', true, true], ['unclear', 'unclear', true, true],
  ['uncertain', 'uncertain', true, true], ['whether', 'whether', true, true], ['believed', 'believed', true, true],
  ['seems', 'seem(?:s|ed)?', true, true],
].map((c) => Object.freeze(c)));

/**
 * HEDGE_CUES as Cypher `=~` patterns (which match the whole string): `any`, one pattern for every cue
 * (each regex is compiled per row, so the gate tries this one first), and `cues`, [{cue, re}] one per cue.
 * @returns {{any: string, cues: Array<{cue: string, re: string}>}}
 */
export function hedgeCuePatterns() {
  const one = (body, ci) => (ci ? `(?i:${body})` : body);
  const left = HEDGE_CUES.filter((c) => c[3]).map(([, body, ci]) => one(body, ci)).join('|');
  const free = HEDGE_CUES.filter((c) => !c[3]).map(([, body, ci]) => one(body, ci)).join('|');
  return {
    any: `(?s).*(?:(?:^|${NOT_WORD})(?:${left})|(?:${free}))(?:${NOT_WORD}|$).*`,
    cues: HEDGE_CUES.map(([cue, body, ci, l]) => ({ cue, re: `(?s${ci ? 'i' : ''}).*${l ? `(?:^|${NOT_WORD})` : ''}(?:${body})(?:${NOT_WORD}|$).*` })),
  };
}

/**
 * HEDGE_CUES as JavaScript regular expressions, one per cue, searched anywhere: [[cue, RegExp]].
 * @returns {Array<[string, RegExp]>}
 */
export function hedgeCueRegExps() {
  return HEDGE_CUES.map(([cue, body, ci, l]) => [cue, new RegExp(`${l ? `(?:^|${NOT_WORD})` : ''}(?:${body})(?:${NOT_WORD}|$)`, ci ? 'iu' : 'u')]);
}

/** Inference JSON is stored in parts of at most this many characters (D7: a chunk size that keeps each property small). */
export const PART_CHARS = 16000;

/**
 * A label or relationship type this module writes into Cypher text (backticked): an ontology id,
 * by ontology.js's one id rule (isOntologyId: letters with their combining marks, digits and `_`,
 * NFC, at most 64 code points), so every id parseOntology accepts publishes and exports.
 * @param {unknown} id
 */
export const isIdent = (id) => isOntologyId(id);

/** The store refused something, or a check failed; `code` says which (index, publish, verdict, ...). */
export class StoreError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

// ---- DDL (D8, R9, R16) -----------------------------------------------------------------------------

/** [label, property, lookup index, UNIQUE constraint or null] for every key this module looks up. */
const KEYS = [
  ['_Document', 'id', 'document_id', 'document_id_unique'],
  ['_Section', 'key', 'section_key', 'section_key_unique'],
  ['_Sentence', 'key', 'sentence_key', 'sentence_key_unique'],
  ['_Inference', 'key', 'inference_key', 'inference_key_unique'],
  ['_InferencePart', 'key', 'inference_part_key', 'inference_part_key_unique'],
  ['_Mention', 'key', 'mention_key', 'mention_key_unique'],
  ['_Claim', 'key', 'claim_key', 'claim_key_unique'],
  ['_Run', 'id', 'run_id', 'run_id_unique'],
  ['_Verdict', 'key', 'verdict_key', 'verdict_key_unique'],
  ['_Verdict', 'target', 'verdict_target', null],
  ['_Entity', 'key', 'entity_key', 'entity_key_unique'],
  ['_Gold', 'key', 'gold_key', 'gold_key_unique'],
];

/** The one lookup index without a UNIQUE constraint (verdict_target). Idempotent: IF NOT EXISTS compares
 * names, so a store an earlier build made (with its index under this name) keeps the one it has. Every
 * other key's lookups are served by its constraint's backing RANGE index (NOTES.md R9: creating one
 * ourselves is refused as EquivalentSchemaRuleAlreadyExists, silently skipped under IF NOT EXISTS). */
export const STORE_INDEXES = Object.freeze(KEYS.filter((k) => !k[3]).map(([label, prop, index]) =>
  `CREATE INDEX ${index} IF NOT EXISTS FOR (n:${label}) ON (n.${prop})`));
/** The UNIQUE constraints; re-run after every successful ALTER CURRENT GRAPH TYPE SET (R16). */
export const STORE_CONSTRAINTS = Object.freeze(KEYS.filter((k) => k[3]).map(([label, prop, , c]) =>
  `CREATE CONSTRAINT ${c} IF NOT EXISTS FOR (n:${label}) REQUIRE n.${prop} IS UNIQUE`));
/** Full-text search over the sentences (the console's SEARCH, D11). */
export const STORE_FULLTEXT = 'CREATE FULLTEXT INDEX sentence_text IF NOT EXISTS FOR (s:_Sentence) ON EACH [s.text]';

/** Every RANGE lookup index the store must have built, this module's and ontology.js's: [name, label, property].
 * A constrained key's index is its constraint's backing index, named after the constraint (R9). */
const LOOKUPS = Object.freeze([...KEYS, ...ONTOLOGY_KEYS].map(([label, prop, index, constraint]) => [constraint ?? index, label, prop]));
/** Their names. */
export const LOOKUP_INDEXES = Object.freeze(LOOKUPS.map((x) => x[0]));

/** @typedef {typeof import('../../../lib/relate_wasm.mjs')} Cl */
/** @typedef {import('./ontology.js').Ontology} Ontology */

/** One statement; null and missing parameters are guarded in the Cypher (R3), so allow them. */
function q(db, cl, text, params = null) {
  return cl.exec(db, text, params, { allowNull: true });
}
/** The single count a write statement returns. */
function n(db, cl, text, params = null) {
  const { rows } = q(db, cl, text, params);
  return rows.length ? Number(rows[0].n ?? 0) : 0;
}

/** The store's indexes by name: {createStatement, on: 'label.property'}. */
function indexesByName(db, cl) {
  const { rows } = q(db, cl, 'SHOW INDEXES YIELD name, createStatement, labelsOrTypes, properties RETURN name, createStatement, labelsOrTypes, properties ORDER BY name');
  return new Map(rows.map((r) => [r.name, { createStatement: r.createStatement, on: `${(r.labelsOrTypes ?? []).join(',')}.${(r.properties ?? []).join(',')}` }]));
}

/**
 * The index check: every lookup index must exist with a createStatement (a null one would be an
 * index that was never built, whose lookups scan the label), on its own label and property. A UNIQUE
 * constraint's backing index is built and named after the constraint (R9), so the names checked are
 * the constraints'. Throws StoreError('index') naming the bad ones.
 * @param {object} db @param {Cl} cl
 * @returns {string[]} the checked index names
 */
export function checkLookupIndexes(db, cl) {
  const have = indexesByName(db, cl);
  const bad = LOOKUPS.filter(([name, label, prop]) => have.get(name)?.createStatement == null || have.get(name)?.on !== `${label}.${prop}`);
  if (bad.length) {
    const why = ([name, label, prop]) => {
      const h = have.get(name);
      if (!h) return `${name} (missing)`;
      if (h.on !== `${label}.${prop}`) return `${name} (on ${h.on}, not ${label}.${prop})`;
      return `${name} (createStatement null: never built)`;
    };
    throw new StoreError('index', `lookup index ${bad.map(why).join(', ')}; ` +
      'a UNIQUE constraint builds its own backing index (R9)');
  }
  return [...LOOKUP_INDEXES];
}

/**
 * A store an earlier build of this page wrote, before its own labels took the `_` prefix: one of
 * the lookup indexes exists on the unprefixed label (`document_id` on :Document). Its data is
 * invisible to this build, and `CREATE INDEX ... IF NOT EXISTS` would keep the old index under the
 * name. Throws StoreError('legacy') before anything is written; empty the store (reset) to use it.
 * The names checked are the standalone lookup indexes' (KEYS's and ONTOLOGY_KEYS's index column):
 * that build created them under those names, where this one relies on the constraints' backing
 * indexes (R9).
 * @param {object} db @param {Cl} cl
 */
export function refuseLegacyStore(db, cl) {
  const have = indexesByName(db, cl);
  const old = [...KEYS, ...ONTOLOGY_KEYS]
    .filter(([, , name]) => name)
    .map(([label, prop, index]) => [index, label, prop])
    .filter(([name, label, prop]) => have.get(name)?.on === `${label.slice(1)}.${prop}`).map(([name]) => name);
  if (old.length) {
    throw new StoreError('legacy', `this store was written by an earlier build of this page, before its own labels took a leading _ ` +
      `(index ${old[0]} is on :${have.get(old[0])?.on.split('.')[0]}); empty it to use it with this page, or open another store`);
  }
}

/** The store's UNIQUE constraints (idempotent). Run after every applyOntology that altered (R16). */
export function ensureConstraints(db, cl) {
  for (const c of STORE_CONSTRAINTS) q(db, cl, c);
}

/**
 * Keep `o` in the store (ontology.js applyOntology) and put back the store's UNIQUE constraints
 * when the ALTER dropped them (R16), then bring every default cutoff to the defaults for its format
 * and model (applyDefaultCutoffs). Returns applyOntology's result.
 * @param {object} db @param {Cl} cl @param {Ontology} o
 * @param {Partial<typeof DEFAULT_GATE>} [cutoffs]  over defaultGate(o.format, model)
 * @param {{model?: string}} [opts]  model: whose defaults ('small' or 'base', models.js keys)
 * @returns {ReturnType<typeof applyOntology> & {cutoffs: ReturnType<typeof applyDefaultCutoffs>}}
 */
export function applyOntologyToStore(db, cl, o, cutoffs = {}, { model = DEFAULT_MODEL } = {}) {
  const c = { ...defaultGate(o.format, model), ...cutoffs };
  const applied = applyOntology(db, o, cl, { keep: c.entKeep, drop: c.entDrop });
  if (applied.altered) ensureConstraints(db, cl); // R16: a successful SET dropped every UNIQUE
  return { ...applied, cutoffs: applyDefaultCutoffs(db, cl, o.format, model, cutoffs) };
}

/**
 * Bring every cutoff the user never moved to the defaults for `format` and `model`
 * (defaultGate, with `cutoffs` over it). Each Kind's and LinkType's cutoff pair carries `cut_src`:
 * 'default' while it follows the defaults, 'user' once a slider (setCutoffs) or setAllCutoffs moved
 * it. A Kind or LinkType created just now (ontology.js gives both one keep/drop pair) starts as a
 * default; a store written before cut_src existed counts a pair still at LEGACY_DEFAULTS as a
 * default and any other as the user's. So opening a store under another model, or a build with other
 * defaults, re-initialises only the cutoffs nobody moved. Idempotent.
 * @param {object} db @param {Cl} cl @param {string} format @param {string} [model]
 * @param {Partial<typeof DEFAULT_GATE>} [cutoffs]
 * @returns {{kinds: number, links: number, moved: number}} defaults set, and how many of them changed value
 */
export function applyDefaultCutoffs(db, cl, format, model = DEFAULT_MODEL, cutoffs = {}) {
  const c = { ...defaultGate(format, model), ...cutoffs };
  const out = { kinds: 0, links: 0, moved: 0 };
  for (const [label, what, keep, drop] of /** @type {const} */ ([['_Kind', 'kind', c.entKeep, c.entDrop], ['_LinkType', 'link', c.relKeep, c.relDrop]])) {
    const legacy = LEGACY_DEFAULTS[what];
    q(db, cl, `MATCH (x:${label}) WHERE x.cut_src IS NULL AND x.cut_init = true AND $keep IS NOT NULL AND $drop IS NOT NULL
SET x.cut_src = CASE WHEN x.keep = toFloat($keep) AND x.drop = toFloat($drop) THEN 'default' ELSE 'user' END`, { keep: legacy.keep, drop: legacy.drop });
    const { rows } = q(db, cl, `MATCH (x:${label}) WHERE (x.cut_src IS NULL OR x.cut_src = 'default') AND $keep IS NOT NULL AND $drop IS NOT NULL
WITH x, x.cut_src = 'default' AND (x.keep <> toFloat($keep) OR x.drop <> toFloat($drop)) AS moved
SET x.keep = toFloat($keep), x.drop = toFloat($drop), x.cut_init = true, x.cut_src = 'default'
RETURN count(x) AS n, sum(CASE WHEN moved THEN 1 ELSE 0 END) AS moved`, { keep, drop: Math.min(drop, keep) });
    out[what === 'kind' ? 'kinds' : 'links'] = Number(rows[0]?.n ?? 0);
    out.moved += Number(rows[0]?.moved ?? 0);
  }
  return out;
}

/**
 * Open (or create) the store for one ontology: the standalone lookup index, the full-text index,
 * the ontology (applyOntology, D15) with the constraint repair R16 needs and the default cutoffs for
 * its format and the model (applyOntologyToStore), the UNIQUE constraints, then the index check.
 * Idempotent; call it on every open. A store an earlier build wrote with unprefixed labels is
 * refused first, with nothing written (refuseLegacyStore, StoreError 'legacy').
 * @param {object} db @param {Cl} cl @param {Ontology} o
 * @param {Partial<typeof DEFAULT_GATE>} [cutoffs]  over the defaults, for cutoffs that follow them
 * @param {{model?: string}} [opts]  model: whose defaults ('small' or 'base'; the page's loaded or chosen model)
 * @returns {{ontology: ReturnType<typeof applyOntologyToStore>, indexes: string[]}}  ontology.cutoffs.moved: default
 *   cutoffs whose value changed (a model or a defaults change): the stored bands need a gate()
 */
export function openStore(db, cl, o, cutoffs = {}, { model = DEFAULT_MODEL } = {}) {
  refuseLegacyStore(db, cl);
  for (const s of STORE_INDEXES) q(db, cl, s);
  q(db, cl, STORE_FULLTEXT);
  const applied = applyOntologyToStore(db, cl, o, cutoffs, { model });
  ensureConstraints(db, cl);
  const indexes = checkLookupIndexes(db, cl);
  refreshNames(db, cl, o);
  return { ontology: applied, indexes };
}

/**
 * Each kind's label words (names.js kindWords of the label the model is asked, else of the kind id),
 * for its mentions' names: kind id -> words.
 * @param {Ontology} o
 * @returns {Map<string, string[]>}
 */
export function kindWordsOf(o) {
  return new Map(o.types.map((k) => [k.id, kindWords(k.ask?.label ?? k.id)]));
}

/**
 * Bring every mention's name and every claim's end keys to the current name rules (names.js
 * mentionName with the kind's label words; claimEndKeys), so a store an earlier build wrote keys its
 * entities as a fresh extraction would. Only what changed is written; idempotent.
 * @param {object} db @param {Cl} cl @param {Ontology} o
 * @returns {{mentions: number, claims: number}} rows rewritten
 */
export function refreshNames(db, cl, o) {
  const words = kindWordsOf(o);
  const ms = q(db, cl, 'MATCH (m:_Mention) RETURN m.key AS key, m.text AS text, m.label AS label, m.name AS name, m.plain AS plain').rows
    .map((r) => ({ key: r.key, was: `${r.name}|${r.plain}`, name: mentionName(String(r.text ?? ''), words.get(r.label) ?? []), plain: mentionName(String(r.text ?? '')) }))
    .filter((r) => `${r.name}|${r.plain}` !== r.was);
  const cs = q(db, cl, 'MATCH (c:_Claim) RETURN c.key AS key, c.htext AS htext, c.ttext AS ttext, c.hkeys AS hkeys, c.tkeys AS tkeys').rows
    .map((r) => ({ key: r.key, was: JSON.stringify([r.hkeys, r.tkeys]), hkeys: claimEndKeys(String(r.htext ?? ''), words), tkeys: claimEndKeys(String(r.ttext ?? ''), words) }))
    .filter((r) => JSON.stringify([r.hkeys, r.tkeys]) !== r.was);
  for (let i = 0; i < ms.length; i += 500) {
    q(db, cl, `UNWIND $rows AS r
WITH r WHERE r.key IS NOT NULL AND r.name IS NOT NULL AND r.plain IS NOT NULL
MATCH (m:_Mention {key: r.key})
SET m.name = r.name, m.plain = r.plain
RETURN count(m) AS n`, { rows: ms.slice(i, i + 500).map(({ key, name, plain }) => ({ key, name, plain })) });
  }
  for (let i = 0; i < cs.length; i += 500) {
    q(db, cl, `UNWIND $rows AS r
WITH r WHERE r.key IS NOT NULL AND r.hkeys IS NOT NULL AND r.tkeys IS NOT NULL
MATCH (c:_Claim {key: r.key})
SET c.hkeys = r.hkeys, c.tkeys = r.tkeys
RETURN count(c) AS n`, { rows: cs.slice(i, i + 500).map(({ key, hkeys, tkeys }) => ({ key, hkeys, tkeys })) });
  }
  return { mentions: ms.length, claims: cs.length };
}

/**
 * Move one kind's or link's cutoffs (the page's sliders; the next gate() uses them). The pair is
 * the user's from now on (cut_src 'user'): a change of model or defaults leaves it alone.
 * @param {object} db @param {Cl} cl
 * @param {{what: 'kind'|'link', id: string, keep: number, drop: number}} c
 */
export function setCutoffs(db, cl, { what, id, keep, drop }) {
  if (!(keep >= 0 && keep <= 1 && drop >= 0 && drop <= keep)) throw new StoreError('cutoffs', `cutoffs need 0 <= drop <= keep <= 1, not keep ${keep}, drop ${drop}`);
  const label = what === 'kind' ? '_Kind' : what === 'link' ? '_LinkType' : null;
  if (!label) throw new StoreError('cutoffs', `what: 'kind' or 'link', not ${JSON.stringify(what)}`);
  const got = n(db, cl, `MATCH (x:${label}) WHERE $id IS NOT NULL AND x.id = $id
SET x.keep = toFloat($keep), x.drop = toFloat($drop), x.cut_init = true, x.cut_src = 'user' RETURN count(x) AS n`, { id, keep, drop });
  if (got !== 1) throw new StoreError('cutoffs', `no ${label} ${JSON.stringify(id)} in this store`);
}

/**
 * Every kind's and link's cutoffs at once (the harness's grids). They count as the user's unless
 * src is 'default'.
 * @param {object} db @param {Cl} cl @param {{entKeep?: number, entDrop?: number, relKeep?: number, relDrop?: number}} c
 * @param {{src?: 'user'|'default'}} [opts]
 */
export function setAllCutoffs(db, cl, c, { src = 'user' } = {}) {
  if (src !== 'user' && src !== 'default') throw new StoreError('cutoffs', `src: 'user' or 'default', not ${JSON.stringify(src)}`);
  if (c.entKeep != null) {
    q(db, cl, 'MATCH (k:_Kind) WHERE $keep IS NOT NULL AND $drop IS NOT NULL AND $src IS NOT NULL SET k.keep = toFloat($keep), k.drop = toFloat($drop), k.cut_init = true, k.cut_src = $src',
      { keep: c.entKeep, drop: Math.min(c.entDrop ?? DEFAULT_GATE.entDrop, c.entKeep), src });
  }
  if (c.relKeep != null) {
    q(db, cl, 'MATCH (l:_LinkType) WHERE $keep IS NOT NULL AND $drop IS NOT NULL AND $src IS NOT NULL SET l.keep = toFloat($keep), l.drop = toFloat($drop), l.cut_init = true, l.cut_src = $src',
      { keep: c.relKeep, drop: Math.min(c.relDrop ?? DEFAULT_GATE.relDrop, c.relKeep), src });
  }
}

/**
 * Every kind's and link's cutoffs back to the defaults for `format` and `model`, all of them
 * following the defaults again (the page's "Reset to defaults").
 * @param {object} db @param {Cl} cl @param {string} format @param {string} [model]
 */
export function resetCutoffs(db, cl, format, model = DEFAULT_MODEL) {
  setAllCutoffs(db, cl, defaultGate(format, model), { src: 'default' });
}

/**
 * The ontology's kinds and links as stored: {oid, kinds: [{id, implied, keep, drop, src}], links: [{id, phrase, symmetric,
 * typed, pairs, keep, drop, src}], legal: [{d, rel, r}]}. implied: the kind's implied labels (the document's
 * labels.implied, [] for none), which publish adds beside the kind's own. src is 'default' or 'user'
 * (applyDefaultCutoffs). legal is every link's legal (source, target) pair in the document's direction
 * (_LinkType.pairs; a symmetric link is also legal reversed).
 */
export function storedOntology(db, cl) {
  const o = q(db, cl, 'MATCH (o:_Ontology) RETURN o.id AS id ORDER BY id').rows;
  if (o.length !== 1) throw new StoreError('ontology', `this store holds ${o.length} ontologies; open it with openStore first (D14: one per store)`);
  const kinds = q(db, cl, 'MATCH (k:_Kind)-[:_IN]->(:_Ontology) RETURN k.id AS id, k.implied AS implied, k.keep AS keep, k.drop AS drop, k.cut_src AS src, k.ord AS ord ORDER BY ord').rows
    .map((r) => ({ id: r.id, implied: r.implied ?? [], keep: r.keep, drop: r.drop, src: r.src ?? 'default' }));
  const links = q(db, cl, `MATCH (l:_LinkType)-[:_IN]->(:_Ontology)
RETURN l.id AS id, l.phrase AS phrase, l.symmetric AS symmetric, l.typed AS typed, l.pairs AS pairs, l.keep AS keep, l.drop AS drop, l.cut_src AS src, l.ord AS ord
ORDER BY ord`).rows
    .map((r) => ({ id: r.id, phrase: r.phrase, symmetric: r.symmetric, typed: r.typed, pairs: r.pairs ?? [], keep: r.keep, drop: r.drop, src: r.src ?? 'default' }));
  const legal = q(db, cl, `MATCH (l:_LinkType)-[:_IN]->(:_Ontology)
UNWIND l.pairs AS p
WITH l, split(p, '|') AS st WHERE size(st) = 2
RETURN st[0] AS d, l.id AS rel, st[1] AS r ORDER BY rel, d, r`).rows;
  return { oid: o[0].id, kinds, links, legal };
}

// ---- the inference cache (D7) ---------------------------------------------------------------------

/**
 * @typedef {{repo: string, rev: string, weights: string, build: string}} ModelInfo
 *   repo: the HF repo; rev: its revision; weights: model.safetensors's sha256; build: 'gliner-rs@4fa741e'
 */

/**
 * The cache key of one sentence (D7): the sha256 of canonical JSON over the model's repo and
 * revision, the weights' sha256, the gliner-rs build, the schema (gliner.js schemaKey: labels,
 * descriptions, relation phrases, threshold, overlap), the floor and the sentence text.
 * @param {{model: ModelInfo, schema: import('./gliner.js').Schema, floor: number, text: string}} k
 */
export function cacheKey({ model, schema, floor, text }) {
  for (const f of ['repo', 'rev', 'weights', 'build']) {
    if (typeof model?.[f] !== 'string' || model[f] === '') throw new StoreError('cache', `cacheKey: model.${f} must be a non-empty string`);
  }
  if (typeof text !== 'string') throw new StoreError('cache', 'cacheKey: text must be a string');
  // Keys in sorted order, so the JSON is canonical.
  return sha256(JSON.stringify({
    build: model.build, floor, model: model.repo, rev: model.rev, schema: schemaKey(schema), text, weights: model.weights,
  }));
}

/**
 * A cached inference's raw JSON, or null on a miss. An inference whose parts are not all there
 * (a write cut short) counts as a miss.
 * @param {object} db @param {Cl} cl @param {string} key
 * @returns {string|null}
 */
export function readInference(db, cl, key) {
  const { rows } = q(db, cl, `MATCH (i:_Inference {key: $key}) WHERE $key IS NOT NULL
OPTIONAL MATCH (p:_InferencePart)-[:_OF]->(i)
WITH i, p ORDER BY p.n
WITH i, collect(p.text) AS texts
RETURN i.parts AS parts, texts`, { key });
  if (!rows.length || rows[0].parts == null || rows[0].texts.length !== rows[0].parts) return null;
  return rows[0].texts.join('');
}

/** raw JSON -> parts of at most PART_CHARS UTF-16 units, never splitting a surrogate pair. */
export function splitParts(raw) {
  const parts = [];
  let i = 0;
  while (i < raw.length) {
    let j = Math.min(raw.length, i + PART_CHARS);
    if (j < raw.length && /[\ud800-\udbff]/.test(raw[j - 1])) j--;
    parts.push(raw.slice(i, j));
    i = j;
  }
  return parts.length ? parts : [''];
}

// ---- the trace: documents, runs and sections (D9) -------------------------------------------------

/** MERGE the document; its first title stays (the same text under two names is one document). */
export function writeDocument(db, cl, { id, title, chars }) {
  return n(db, cl, `WITH $id AS id WHERE id IS NOT NULL
MERGE (d:_Document {id: id})
ON CREATE SET d.title = $title, d.chars = $chars
RETURN count(d) AS n`, { id, title, chars });
}

/** Keys of the document's complete sections. */
export function completeSections(db, cl, docId) {
  const { rows } = q(db, cl, `MATCH (sec:_Section)-[:_OF]->(d:_Document {id: $doc}) WHERE $doc IS NOT NULL AND sec.complete = true
RETURN sec.key AS key ORDER BY key`, { doc: docId });
  return new Set(rows.map((r) => r.key));
}

/**
 * Start a run over one document: (:_Run {id: '<doc>#<n>'}) with zero counters and status 'running'.
 * @returns {string} the run id
 */
export function startRun(db, cl, { doc, model, floor, sections, sentences }) {
  const { rows } = q(db, cl, `MATCH (d:_Document {id: $doc}) WHERE $doc IS NOT NULL
OPTIONAL MATCH (r:_Run {doc: $doc})
WITH d, count(r) AS runs
CREATE (run:_Run {id: d.id + '#' + toString(runs + 1), doc: d.id, model: $model, rev: $rev, floor: toFloat($floor),
                 sections: $sections, sentences: $sentences, read: 0, inferences: 0, hits: 0, status: 'running', ts: timestamp()})
RETURN run.id AS id`, { doc, model: model.repo, rev: model.rev, floor, sections, sentences });
  if (rows.length !== 1) throw new StoreError('run', `startRun: no document ${doc}; writeDocument first`);
  return rows[0].id;
}

/** Update a run's counters, and its status ('running', 'done', 'stopped', 'failed'). */
export function updateRun(db, cl, id, { read, inferences, hits, status }) {
  n(db, cl, `MATCH (r:_Run {id: $id}) WHERE $id IS NOT NULL
SET r.read = $read, r.inferences = $inferences, r.hits = $hits, r.status = $status
RETURN count(r) AS n`, { id, read, inferences, hits, status });
}

/** Leading prepositions a relation span carries and an entity span leaves out ("by Tomas Ferreira"). */
const LEADING_PREPOSITIONS = /^(?:(?:about|at|by|for|from|in|into|near|of|on|over|to|under|with)\s+)+/iu;

/**
 * The keys rule 3's name join tries for a claim end that no mention contains: for each kind of the
 * ontology, 'KIND|NAME' with the NAME a mention of that kind with the end's text would have (names.js
 * entityName with the kind's label words), after leading punctuation and leading prepositions are
 * dropped, so "by the Blue Ridge agent." finds the mention "Blue Ridge agent" and "account ACC-2207"
 * the Account mention "ACC-2207". Ends with no name give no key.
 * @param {string} text  the end's span text
 * @param {Map<string, string[]>} words  kindWordsOf(o)
 * @returns {string[]}
 */
export function claimEndKeys(text, words) {
  const t = String(text).replace(/^[\p{P}\p{White_Space}]+/u, '').replace(LEADING_PREPOSITIONS, '');
  const out = [];
  for (const [id, w] of words) {
    const name = entityName(t, w);
    if (name !== '') out.push(`${id}|${name}`);
  }
  return out;
}

/** Unicode punctuation or whitespace: what joinSpan trims from a claim end. */
const JOIN_TRIM = /[\p{P}\p{White_Space}]/u;

/**
 * The span rule 3 joins a claim end on: [start, end) without leading and trailing Unicode
 * punctuation and whitespace, so "Acme Inc." joins the mention "Acme Inc". A span that is all
 * punctuation stays as it is. Offsets are code points; `text` is the span's own text.
 * @param {number} start @param {number} end @param {string} text
 * @returns {[number, number]}
 */
export function joinSpan(start, end, text) {
  const cps = Array.from(text);
  let a = 0;
  let b = cps.length;
  while (a < b && JOIN_TRIM.test(cps[a])) a++;
  while (b > a && JOIN_TRIM.test(cps[b - 1])) b--;
  return a < b ? [start + a, start + b] : [start, end];
}

/**
 * The D9 writes of one section, in a fixed order: (:_Section {complete: false}) first, then one
 * UNWIND ... MERGE statement per kind of row, the run's READ edge, and `SET sec.complete = true`
 * last. Every statement is idempotent, so a section cut short re-applies as no-ops plus whatever
 * was missing. Each statement's row count is checked.
 * @param {object} db @param {Cl} cl
 * @param {{doc: string, run: string, section: {key: string, n: number},
 *   sentences: Array<object>, parts: Array<object>, inferences: Array<object>, inferred: Array<object>,
 *   mentions: Array<object>, claims: Array<object>}} w
 * @param {(step: string) => void} [onStep]  called after each statement (a test hook: throwing there
 *   leaves the section incomplete, as a killed worker would)
 */
export function writeSection(db, cl, w, onStep) {
  const sec = w.section.key;
  /** @param {string} step @param {string} text @param {object} params @param {number} want */
  const step = (name, text, params, want) => {
    const got = n(db, cl, text, params);
    if (want !== undefined && got !== want) throw new StoreError('write', `section ${sec}: ${name} wrote ${got} of ${want} rows`);
    onStep?.(name);
  };
  step('section', `MATCH (d:_Document {id: $doc}) WHERE $doc IS NOT NULL AND $key IS NOT NULL
MERGE (sec:_Section {key: $key})
ON CREATE SET sec.complete = false, sec.n = $n, sec.doc = $doc
MERGE (sec)-[:_OF]->(d)
RETURN count(sec) AS n`, { doc: w.doc, key: sec, n: w.section.n }, 1);
  step('sentences', `UNWIND $rows AS r
WITH r WHERE r.key IS NOT NULL
MATCH (sec:_Section {key: $sec}) WHERE $sec IS NOT NULL
MERGE (s:_Sentence {key: r.key})
SET s.idx = r.idx, s.doc = r.doc, s.start = r.start, s.end = r.end, s.text = r.text, s.heading = r.heading
MERGE (s)-[:_IN]->(sec)
RETURN count(s) AS n`, { sec, rows: w.sentences }, w.sentences.length);
  step('parts', `UNWIND $rows AS r
WITH r WHERE r.key IS NOT NULL
MERGE (p:_InferencePart {key: r.key})
SET p.n = r.n, p.text = r.text
RETURN count(p) AS n`, { rows: w.parts }, w.parts.length);
  step('inferences', `UNWIND $rows AS r
WITH r WHERE r.key IS NOT NULL
MERGE (i:_Inference {key: r.key})
SET i.model = r.model, i.rev = r.rev, i.weights = r.weights, i.build = r.build, i.floor = toFloat(r.floor), i.schema = r.schema
RETURN count(i) AS n`, { rows: w.inferences }, w.inferences.length);
  step('inference parts', `UNWIND $rows AS r
WITH r WHERE r.key IS NOT NULL AND r.inference IS NOT NULL
MATCH (p:_InferencePart {key: r.key})
MATCH (i:_Inference {key: r.inference})
MERGE (p)-[:_OF]->(i)
RETURN count(p) AS n`, { rows: w.parts }, w.parts.length);
  // The part count is the inference's own commit marker: readInference needs every part.
  step('inference marker', `UNWIND $rows AS r
WITH r WHERE r.key IS NOT NULL
MATCH (i:_Inference {key: r.key})
SET i.parts = r.parts
RETURN count(i) AS n`, { rows: w.inferences }, w.inferences.length);
  step('inferred', `UNWIND $rows AS r
WITH r WHERE r.sentence IS NOT NULL AND r.inference IS NOT NULL
MATCH (s:_Sentence {key: r.sentence})
MATCH (i:_Inference {key: r.inference})
MERGE (s)-[:_INFERRED]->(i)
RETURN count(s) AS n`, { rows: w.inferred }, w.inferred.length);
  step('mentions', `UNWIND $rows AS r
WITH r WHERE r.key IS NOT NULL AND r.sentence IS NOT NULL
MATCH (s:_Sentence {key: r.sentence})
MERGE (m:_Mention {key: r.key})
SET m.doc = r.doc, m.sentence = r.sentence, m.start = r.start, m.end = r.end, m.text = r.text,
    m.label = r.label, m.name = r.name, m.plain = r.plain, m.p = toFloat(r.p), m.source = r.source
MERGE (m)-[:_IN]->(s)
RETURN count(m) AS n`, { rows: w.mentions }, w.mentions.length);
  const claims = w.claims.map((r) => {
    const [hjs, hje] = joinSpan(r.hs, r.he, r.htext);
    const [tjs, tje] = joinSpan(r.ts, r.te, r.ttext);
    return { ...r, hjs, hje, tjs, tje, hkeys: r.hkeys ?? null, tkeys: r.tkeys ?? null };
  });
  step('claims', `UNWIND $rows AS r
WITH r WHERE r.key IS NOT NULL AND r.sentence IS NOT NULL
MATCH (s:_Sentence {key: r.sentence})
MERGE (c:_Claim {key: r.key})
SET c.doc = r.doc, c.sentence = r.sentence, c.rel = r.rel, c.p = toFloat(r.p),
    c.hs = r.hs, c.he = r.he, c.ts = r.ts, c.te = r.te, c.htext = r.htext, c.ttext = r.ttext,
    c.hjs = r.hjs, c.hje = r.hje, c.tjs = r.tjs, c.tje = r.tje, c.hkeys = r.hkeys, c.tkeys = r.tkeys
MERGE (c)-[:_EVIDENCE]->(s)
RETURN count(c) AS n`, { rows: claims }, claims.length);
  step('read', `MATCH (run:_Run {id: $run}) WHERE $run IS NOT NULL AND $sec IS NOT NULL
MATCH (sec:_Section {key: $sec})
MERGE (run)-[:_READ]->(sec)
RETURN count(run) AS n`, { run: w.run, sec }, 1);
  step('complete', `MATCH (sec:_Section {key: $sec}) WHERE $sec IS NOT NULL
SET sec.complete = true
RETURN count(sec) AS n`, { sec }, 1);
}

/**
 * Delete one document's trace (sections, sentences, mentions, claims, runs; the document node too).
 * The inference cache and the verdicts stay: re-extracting the text costs no model call, and the
 * verdicts re-attach by key (they name their target's key, not its node). Re-publish afterwards.
 * @returns {{claims: number, mentions: number, sentences: number, sections: number, runs: number, documents: number}}
 */
export function forgetDocument(db, cl, docId) {
  const p = { doc: docId };
  const g = 'WHERE $doc IS NOT NULL';
  return {
    claims: n(db, cl, `MATCH (c:_Claim {doc: $doc}) ${g} DETACH DELETE c RETURN count(*) AS n`, p),
    mentions: n(db, cl, `MATCH (m:_Mention {doc: $doc}) ${g} DETACH DELETE m RETURN count(*) AS n`, p),
    sentences: n(db, cl, `MATCH (s:_Sentence {doc: $doc}) ${g} DETACH DELETE s RETURN count(*) AS n`, p),
    sections: n(db, cl, `MATCH (s:_Section {doc: $doc}) ${g} DETACH DELETE s RETURN count(*) AS n`, p),
    runs: n(db, cl, `MATCH (r:_Run {doc: $doc}) ${g} DETACH DELETE r RETURN count(*) AS n`, p),
    documents: n(db, cl, `MATCH (d:_Document {id: $doc}) ${g} DETACH DELETE d RETURN count(*) AS n`, p),
  };
}

// ---- verdicts (D10 rule 7) ------------------------------------------------------------------------

/**
 * Record a verdict on a claim or a mention. Verdicts are never edited: each one is a new
 * (:_Verdict {seq}) node, and the gate reads the latest per target (ORDER BY ts DESC, seq DESC).
 * A verdict names its target by key, so it survives the target being deleted and extracted again.
 * @param {object} db @param {Cl} cl
 * @param {{target: string, value: 'accept'|'reject'}} v
 * @returns {{key: string, seq: number, kind: 'claim'|'mention'}}
 */
export function addVerdict(db, cl, { target, value }) {
  if (value !== 'accept' && value !== 'reject') throw new StoreError('verdict', `a verdict is 'accept' or 'reject', not ${JSON.stringify(value)}`);
  if (typeof target !== 'string' || target === '') throw new StoreError('verdict', 'a verdict needs the target key');
  const kinds = q(db, cl, `OPTIONAL MATCH (c:_Claim {key: $t}) WHERE $t IS NOT NULL
OPTIONAL MATCH (m:_Mention {key: $t}) WHERE $t IS NOT NULL
RETURN c IS NOT NULL AS claim, m IS NOT NULL AS mention`, { t: target }).rows[0];
  const kind = kinds.claim ? 'claim' : kinds.mention ? 'mention' : null;
  if (!kind) throw new StoreError('verdict', `no claim or mention ${target}`);
  const label = kind === 'claim' ? '_Claim' : '_Mention';
  const { rows } = q(db, cl, `OPTIONAL MATCH (v:_Verdict)
WITH coalesce(max(v.seq), 0) + 1 AS seq
MATCH (x:${label} {key: $t}) WHERE $t IS NOT NULL AND $value IS NOT NULL
CREATE (nv:_Verdict {key: 'v' + toString(seq), target: $t, kind: $kind, value: $value, ts: timestamp(), seq: seq})-[:_ON]->(x)
RETURN nv.key AS key, nv.seq AS seq`, { t: target, value, kind });
  return { key: rows[0].key, seq: rows[0].seq, kind };
}

/** Every verdict, oldest first: [{key, seq, target, kind, value}]. */
export function listVerdicts(db, cl) {
  return q(db, cl, 'MATCH (v:_Verdict) RETURN v.key AS key, v.seq AS seq, v.target AS target, v.kind AS kind, v.value AS value ORDER BY seq').rows;
}

// ---- the gate (D10) --------------------------------------------------------------------------------

/** Mentions and claims of complete sections only (D9). */
const LIVE_M = 'MATCH (sec:_Section {complete: true})<-[:_IN]-(s:_Sentence)<-[:_IN]-(m:_Mention)';
const LIVE_C = 'MATCH (sec:_Section {complete: true})<-[:_IN]-(s:_Sentence)<-[:_EVIDENCE]-(c:_Claim)';
/** Rule names whose drop no verdict can override: the mention cannot key an entity. */
const FINAL_MENTION_RULES = ['no-name', 'off'];
/** Rules a claim verdict overrides: the bands, the hedge cap and rule 3's cap, not rule 3's join or rule 4. */
const OVERRIDABLE_CLAIM_RULES = ['band', 'floor', 'hedged', 'end-in-review', 'ambiguous', 'reversed'];

/**
 * The gate's statements, in order (D10). Each is idempotent; together they rewrite every
 * mention's and claim's `band` ('keep' | 'review' | 'drop') and `rule` (what decided it).
 * `poleMargin` is rule 2's specialisation margin (null switches the POLE preference off, as before
 * it existed); `off` switches whole rules off (RULES).
 * @param {{typeMargin?: number, relMargin?: number, poleMargin?: number|null, off?: string[]}} [opts]
 * @returns {Array<{rule: string, text: string, params: object|null}>}
 */
export function gateStatements({ typeMargin = DEFAULT_GATE.typeMargin, relMargin = DEFAULT_GATE.relMargin, poleMargin = DEFAULT_GATE.poleMargin, off = [] } = {}) {
  for (const r of off) if (!RULES.includes(r)) throw new StoreError('gate', `no rule ${JSON.stringify(r)} (rules: ${RULES.join(', ')})`);
  const on = (r) => !off.includes(r);
  /** @type {Array<{rule: string, text: string, params: object|null}>} */
  const st = [];
  const add = (rule, text, params = null) => st.push({ rule, text, params });

  // Verdicts whose target was deleted and extracted again get their ON edge back.
  add('reset', `MATCH (v:_Verdict) WHERE v.target IS NOT NULL AND NOT EXISTS { MATCH (v)-[:_ON]->() }
OPTIONAL MATCH (c:_Claim {key: v.target})
OPTIONAL MATCH (m:_Mention {key: v.target})
WITH v, coalesce(c, m) AS x WHERE x IS NOT NULL
MERGE (v)-[:_ON]->(x)
RETURN count(v) AS n`);
  add('reset', 'MATCH (m:_Mention) SET m.band = null, m.rule = null, m.prior = null, m.alt = null RETURN count(m) AS n');
  add('reset', `MATCH (c:_Claim)
SET c.band = null, c.rule = null, c.hm = null, c.tm = null, c.hk = null, c.tk = null, c.hn = null, c.tn = null,
    c.head = null, c.tail = null, c.amb = null, c.rev = null, c.cue = null
RETURN count(c) AS n`);
  add('reset', 'MATCH (:_Claim)-[r:_HEAD|_TAIL]->(:_Mention) DELETE r RETURN count(*) AS n');

  // 0. A pronoun, or a text with no canonical name (names.js), cannot key an entity (edgextract's
  //    rule); this guard comes first, so such a listed name never wins its span either.
  add('no-name', `${LIVE_M} WHERE m.name = ''
SET m.band = 'drop', m.rule = 'no-name' RETURN count(m) AS n`);
  // 1. Gazetteer: listed names are mentions with p = 1.0; they win their span.
  if (on('gazetteer')) {
    add('gazetteer', `${LIVE_M} WHERE m.band IS NULL AND m.source = 'gazetteer'
SET m.band = 'keep', m.rule = 'gazetteer' RETURN count(m) AS n`);
    // From the kept listed names (few, and none at all without a gazetteer) to the model mentions
    // overlapping them in their sentence: a kept g is live (the reset cleared every band, and the
    // statement above keeps live ones only), so its sentence is in a complete section. Starting from
    // every live mention with an EXISTS per mention cost about 50 ms a store on create-context-graph's
    // samples, which have no gazetteer.
    add('gazetteer', `MATCH (g:_Mention) WHERE g.source = 'gazetteer' AND g.band = 'keep'
MATCH (g)-[:_IN]->(s:_Sentence)<-[:_IN]-(m:_Mention)
WHERE m.band IS NULL AND m.source = 'model' AND g.start < m.end AND m.start < g.end
WITH DISTINCT m
SET m.band = 'drop', m.rule = 'gazetteer' RETURN count(m) AS n`);
  } else {
    add('gazetteer', `${LIVE_M} WHERE m.band IS NULL AND m.source = 'gazetteer' SET m.band = 'drop', m.rule = 'off' RETURN count(m) AS n`);
  }
  // 2. One kind per span: the best label wins and the others drop ('one-kind'). POLE+O
  //    (create-context-graph): a domain kind whose pole is a base kind's pole specialises that base
  //    kind (_Kind.pole, _Kind.origin). When the best label is a base kind and a specialising kind
  //    scored on the span within $pole_margin of it (and above its own drop cutoff, so rule 5 would
  //    not drop it), the best such kind wins instead, with rule 'pole-specific' (rule 5 still sets its
  //    band). A runner-up within $type_margin sends the winner to review ('type-margin'), unless rule
  //    5 would drop it anyway; a base kind and its own specialisation are never runners-up to each
  //    other. $pole_margin null: no POLE preference. A generic document's kinds have no pole: unchanged.
  //    Each mention's kind is looked up before the grouping, as [pole, base?, drop] in `info`,
  //    collected in the same row order as `ms`.
  if (on('one-kind')) {
    add('one-kind', `${LIVE_M} WHERE m.band IS NULL AND m.source = 'model' AND $type_margin IS NOT NULL AND $band IS NOT NULL AND $pole IS NOT NULL
OPTIONAL MATCH (k:_Kind) WHERE k.id = m.label
WITH m, [k.pole, coalesce(k.origin = 'base', false), k.drop] AS kinfo ORDER BY m.p DESC, m.label ASC
WITH m.sentence AS sk, m.start AS a, m.end AS b, collect(m) AS ms, collect(kinfo) AS info
WITH ms, info, range(0, size(ms) - 1) AS ix
WITH ms, info, ix, [i IN ix WHERE $pole AND info[0][1] = true AND info[0][0] IS NOT NULL
       AND info[i][1] = false AND info[i][0] = info[0][0]
       AND ms[i].p >= ms[0].p - toFloat($pole_margin)
       AND (NOT $band OR (info[i][2] IS NOT NULL AND ms[i].p > info[i][2]))] AS spec
WITH ms, info, ix, CASE WHEN size(spec) > 0 THEN spec[0] ELSE 0 END AS w
WITH ms, info, w, [i IN ix WHERE i <> w AND NOT ($pole AND info[w][0] IS NOT NULL AND info[i][0] IS NOT NULL AND info[i][0] = info[w][0] AND info[i][1] <> info[w][1])] AS rest
WITH ms, w, ms[w] AS best, CASE WHEN size(rest) > 0 THEN ms[rest[0]] ELSE null END AS second, info[w][2] AS bdrop
WITH ms, w, best, second IS NOT NULL AND second.p >= best.p - toFloat($type_margin)
     AND (NOT $band OR (bdrop IS NOT NULL AND best.p > bdrop)) AS close
UNWIND ms AS m
WITH m, best, close, w
WHERE m <> best OR close OR w > 0
SET m.band = CASE WHEN m = best AND close THEN 'review' WHEN m = best THEN null ELSE 'drop' END,
    m.rule = CASE WHEN m = best AND close THEN 'type-margin' WHEN m = best THEN 'pole-specific' ELSE 'one-kind' END
RETURN count(m) AS n`, { type_margin: typeMargin, band: on('band'), pole: poleMargin != null, pole_margin: poleMargin });
  }
  // 5 (mentions). Band, per kind: keep at p >= keep, drop at p <= drop, review between.
  if (on('band')) {
    add('band', `${LIVE_M} WHERE m.band IS NULL
MATCH (k:_Kind) WHERE k.id = m.label
SET m.band = CASE WHEN m.p >= k.keep THEN 'keep' WHEN m.p <= k.drop THEN 'drop' ELSE 'review' END, m.rule = coalesce(m.rule, 'band')
RETURN count(m) AS n`);
  } else {
    add('band', `${LIVE_M} WHERE m.band IS NULL SET m.band = 'keep', m.rule = coalesce(m.rule, 'floor') RETURN count(m) AS n`);
  }
  // 2b (mentions, after rule 5's band). One kind per name, across the store: a name kept as two kinds or
  //    more keeps one of them: a create-context-graph domain kind over a base kind (wider than rule 2's POLE
  //    preference, which needs one pole: "Brannoc" kept as Person and as Character keeps Character; off with
  //    it, when $pole_margin is null), else the kind with the highest score, then the most kept mentions,
  //    then the kind id. The other kinds' kept mentions go to review ('other-kind', m.alt the kind kept),
  //    and claims joined to them wait with them (rule 3's cap); one that overlaps a kept mention of the
  //    kind kept in its sentence ("Imani Okafor" as Person inside "Dr. Imani Okafor" as Provider) drops
  //    instead, the same words read twice. Names are compared twice: as entity keys (m.name: "ACC-2207"
  //    kept as Account and as Organization), then without the kinds' own words (m.plain: "August
  //    evaluation" kept as Evaluation, key AUGUST, and as Event, key AUGUST_EVALUATION). The gate cannot
  //    tell one thing the model typed two ways (every case on the samples) from two things that share a
  //    name; a person can, and accepting the mention keeps both.
  if (on('name-kind')) {
    for (const by of ['name', 'plain']) {
      add('name-kind', `${LIVE_M} WHERE m.band = 'keep' AND m.${by} IS NOT NULL AND m.${by} <> '' AND $pole IS NOT NULL
OPTIONAL MATCH (k:_Kind) WHERE k.id = m.label
WITH m.${by} AS nm, m.label AS label, k.pole AS pole, coalesce(k.origin = 'base', false) AS base, max(m.p) AS p, count(m) AS n
WITH nm, collect({label: label, pole: pole, base: base, p: p, n: n}) AS ks
WITH nm, ks WHERE size(ks) > 1
WITH nm, [x IN ks WHERE NOT ($pole AND x.base AND any(y IN ks WHERE NOT y.base))] AS cand
UNWIND cand AS c
WITH nm, c ORDER BY c.p DESC, c.n DESC, c.label ASC
WITH nm, head(collect(c)) AS win
${LIVE_M} WHERE m.band = 'keep' AND m.${by} = nm AND m.label <> win.label
OPTIONAL MATCH (w:_Mention)-[:_IN]->(s) WHERE w.band = 'keep' AND w.label = win.label AND w.${by} = nm AND w.start < m.end AND m.start < w.end
WITH m, win, count(w) AS over
SET m.band = CASE WHEN over > 0 THEN 'drop' ELSE 'review' END, m.rule = 'other-kind', m.alt = win.label
RETURN count(m) AS n`, { pole: poleMargin != null });
    }
  }
  // 7 (mentions). Verdicts override, latest wins; before the claims, which anchor on kept mentions.
  //    `prior` keeps the band rules 0-5 gave the mention, so rule 3 still sees where a rejected one was.
  if (on('verdicts')) {
    add('verdicts', `MATCH (m:_Mention) WHERE m.band IS NOT NULL AND m.key IS NOT NULL AND NOT m.rule IN $final
MATCH (v:_Verdict {target: m.key})
WITH m, v ORDER BY v.ts DESC, v.seq DESC
WITH m, head(collect(v)) AS v, m.band AS prior
SET m.prior = prior, m.band = CASE WHEN v.value = 'accept' THEN 'keep' ELSE 'drop' END, m.rule = 'verdict'
RETURN count(m) AS n`, { final: FINAL_MENTION_RULES });
  }

  // 3. Span join: each end, without leading and trailing punctuation and whitespace (joinSpan),
  //    joins the kept mention with the same span, else the smallest kept one containing it; with no
  //    kept one, the same among the mentions in review (an end in review: rule 5 caps the claim at
  //    review); with neither, the claim drops as unanchored. A dropped mention never anchors. A
  //    mention a verdict rejected keeps its place in that order (its `prior` band), and an end that
  //    would join it does not anchor: rejecting the mention a claim joins unanchors the claim, and
  //    never moves it to another mention (a larger "Dr. ..." one, say). Rule 3 reads the bands as
  //    rules 0-5 and the mention verdicts left them; accepted claims keep their ends below.
  //    An end no such mention contains (the model's relation spans carry words its entity spans leave
  //    out: "the Claims Notes Corpus", "by Tomas Ferreira", "account ACC-2207") joins, in the same
  //    order, a mention of its sentence whose 'KIND|NAME' is one the end would have as a mention of that
  //    kind (hkeys, tkeys: claimEndKeys). A rejected mention that contains the end still blocks it.
  //    (Off: any banded mention, smallest first, no name join and no cap.)
  const rejected = "(x.band = 'drop' AND x.rule = 'verdict' AND x.prior IN ['keep', 'review'])";
  const anchor = on('span-join') ? `(x.band IN ['keep', 'review'] OR ${rejected})` : 'x.band IS NOT NULL AND NOT x.rule IN $final';
  const first = on('span-join') ? "CASE WHEN x.band = 'keep' OR (x.band = 'drop' AND x.prior = 'keep') THEN 0 ELSE 1 END ASC, " : '';
  const joined = (v) => (on('span-join') ? `CASE WHEN ${v}.band IN ['keep', 'review'] THEN ${v} ELSE null END` : v);
  add('span-join', `${LIVE_C}
OPTIONAL MATCH (x:_Mention)-[:_IN]->(s) WHERE ${anchor} AND x.start <= coalesce(c.hjs, c.hs) AND coalesce(c.hje, c.he) <= x.end
WITH c, s, x ORDER BY ${first}x.end - x.start ASC, x.p DESC, x.label ASC, x.key ASC
WITH c, s, head(collect(x)) AS hx
OPTIONAL MATCH (x:_Mention)-[:_IN]->(s) WHERE hx IS NULL AND $names AND c.hkeys IS NOT NULL AND (x.label + '|' + x.name) IN c.hkeys AND ${anchor}
WITH c, s, hx, x ORDER BY ${first}x.end - x.start ASC, x.p DESC, x.label ASC, x.key ASC
WITH c, s, hx, head(collect(x)) AS nx
WITH c, s, coalesce(hx, nx) AS hx
WITH c, s, ${joined('hx')} AS hm
OPTIONAL MATCH (x:_Mention)-[:_IN]->(s) WHERE ${anchor} AND x.start <= coalesce(c.tjs, c.ts) AND coalesce(c.tje, c.te) <= x.end
WITH c, s, hm, x ORDER BY ${first}x.end - x.start ASC, x.p DESC, x.label ASC, x.key ASC
WITH c, s, hm, head(collect(x)) AS tx
OPTIONAL MATCH (x:_Mention)-[:_IN]->(s) WHERE tx IS NULL AND $names AND c.tkeys IS NOT NULL AND (x.label + '|' + x.name) IN c.tkeys AND ${anchor}
WITH c, hm, tx, x ORDER BY ${first}x.end - x.start ASC, x.p DESC, x.label ASC, x.key ASC
WITH c, hm, tx, head(collect(x)) AS nx
WITH c, hm, coalesce(tx, nx) AS tx
WITH c, hm, ${joined('tx')} AS tm
SET c.hm = hm.key, c.tm = tm.key, c.hk = hm.label, c.tk = tm.label, c.hn = hm.name, c.tn = tm.name,
    c.head = hm.label + ':' + hm.name, c.tail = tm.label + ':' + tm.name,
    c.band = CASE WHEN hm IS NULL OR tm IS NULL THEN 'drop' ELSE null END,
    c.rule = CASE WHEN hm IS NULL OR tm IS NULL THEN 'unanchored' ELSE null END
RETURN count(c) AS n`, { final: FINAL_MENTION_RULES, names: on('span-join') });
  add('span-join', `MATCH (c:_Claim) WHERE c.hm IS NOT NULL
MATCH (m:_Mention {key: c.hm})
MERGE (c)-[:_HEAD]->(m)
RETURN count(c) AS n`);
  add('span-join', `MATCH (c:_Claim) WHERE c.tm IS NOT NULL
MATCH (m:_Mention {key: c.tm})
MERGE (c)-[:_TAIL]->(m)
RETURN count(c) AS n`);
  // 7 (claims accepted, for their ends). A claim whose latest verdict accepts it keeps the two
  // mentions rule 3 joined it to, when both ends anchor, the (head kind, tail kind) pair is legal for
  // its link (rule 4: _LinkType.pairs, either way round when symmetric) and its ends are two entities;
  // those of them in review are kept with rule 'claim-verdict'. Only the joined mentions: a claim
  // whose end was rejected is unanchored above and keeps nothing, so no entity is published without
  // the accepted claim's edge. Every claim joined to such a mention sees it kept at rule 3's cap. A
  // mention's own verdict ran first and wins (it is no longer in review). (Rule 4 off: no legality.)
  if (on('verdicts') && on('span-join')) {
    add('verdicts', `MATCH (v:_Verdict) WHERE v.kind = 'claim' AND v.target IS NOT NULL
WITH v ORDER BY v.ts DESC, v.seq DESC
WITH v.target AS t, head(collect(v)) AS v
WITH t WHERE v.value = 'accept' AND $legality IS NOT NULL
MATCH (c:_Claim {key: t}) WHERE c.hm IS NOT NULL AND c.tm IS NOT NULL
OPTIONAL MATCH (l:_LinkType) WHERE l.id = c.rel
WITH c, l WHERE NOT $legality OR (l IS NOT NULL AND c.head <> c.tail AND (
    (c.hk + '|' + c.tk) IN coalesce(l.pairs, []) OR (l.symmetric = true AND (c.tk + '|' + c.hk) IN coalesce(l.pairs, []))))
MATCH (c)-[:_HEAD|_TAIL]->(m:_Mention) WHERE m.band = 'review'
WITH DISTINCT m
SET m.band = 'keep', m.rule = 'claim-verdict'
RETURN count(m) AS n`, { legality: on('legality') });
  }
  // 4. Legality: the (head kind, tail kind) pair is one of the link's legal pairs (_LinkType.pairs,
  //    'SOURCE|TARGET' in the YAML's direction), either way round for a symmetric link; then
  //    self-loops. Exact pairs, not domain x range: create-context-graph's PARTY_TO is
  //    Person -> Case and Organization -> Contract, never Person -> Contract (ontology.js).
  if (on('legality')) {
    add('legality', `MATCH (c:_Claim) WHERE c.band IS NULL AND c.hm IS NOT NULL AND c.tm IS NOT NULL
OPTIONAL MATCH (l:_LinkType) WHERE l.id = c.rel
WITH c, l IS NOT NULL AND (
    (c.hk + '|' + c.tk) IN coalesce(l.pairs, []) OR (l.symmetric = true AND (c.tk + '|' + c.hk) IN coalesce(l.pairs, []))
  ) AS legal
WITH c, legal WHERE NOT legal OR c.head = c.tail
SET c.band = 'drop', c.rule = CASE WHEN NOT legal THEN 'illegal' ELSE 'self-loop' END
RETURN count(c) AS n`);
  }
  // 5. Band, per link; then two caps on what the band keeps, in this order. The hedge cap: a claim
  //    goes to review ('hedged', the cue in c.cue) when its sentence, from its start to the end of the
  //    claim's later span, holds a hedge or negation cue (HEDGE_CUES), as in "Tomas Reyes never worked
  //    for Pell Street Partners", which the model scores like a fact; a cue after both spans ("..., which
  //    was not audited") does not count. Mentions are not capped. Then rule 3's cap: a claim goes to
  //    review ('end-in-review') while an end joins a mention in review. Accepting that mention, or the
  //    claim (rule 7, which keeps its ends above), lifts it; a verdict on the claim lifts either cap.
  if (on('band')) {
    add('band', `MATCH (c:_Claim) WHERE c.band IS NULL AND c.hm IS NOT NULL AND c.tm IS NOT NULL
MATCH (l:_LinkType) WHERE l.id = c.rel
SET c.band = CASE WHEN c.p >= l.keep THEN 'keep' WHEN c.p <= l.drop THEN 'drop' ELSE 'review' END, c.rule = 'band'
RETURN count(c) AS n`);
  } else {
    add('band', `MATCH (c:_Claim) WHERE c.band IS NULL AND c.hm IS NOT NULL AND c.tm IS NOT NULL
SET c.band = 'keep', c.rule = 'floor' RETURN count(c) AS n`);
  }
  if (on('hedge')) {
    const hp = hedgeCuePatterns();
    add('hedge', `MATCH (c:_Claim)-[:_EVIDENCE]->(s:_Sentence) WHERE c.band = 'keep' AND $any IS NOT NULL AND $cues IS NOT NULL
WITH c, substring(s.text, 0, CASE WHEN c.he > c.te THEN c.he ELSE c.te END - s.start) AS upto
WHERE upto =~ $any
WITH c, [x IN $cues WHERE upto =~ x.re | x.cue] AS hits
WHERE size(hits) > 0
SET c.band = 'review', c.rule = 'hedged', c.cue = hits[0]
RETURN count(c) AS n`, { any: hp.any, cues: hp.cues });
  }
  if (on('span-join')) {
    add('span-join', `MATCH (c:_Claim) WHERE c.band = 'keep'
MATCH (c)-[:_HEAD|_TAIL]->(m:_Mention) WHERE m.band = 'review'
WITH DISTINCT c
SET c.band = 'review', c.rule = 'end-in-review'
RETURN count(c) AS n`);
  }
  // 6. Ambiguity, over the kept band as rule 5 left it. One sentence, one link per ordered pair: when
  //    kept claims for one (head, tail) in one sentence name two links or more, every claim of a link
  //    other than the best-scoring one goes to review, and the best one's too when another link
  //    scored within $rel_margin of it ("Olu Bankole authored PR #4519" also scores REVIEWED). So do
  //    A->B and B->A of one non-symmetric link.
  if (on('ambiguity')) {
    add('ambiguity', `MATCH (c:_Claim) WHERE c.band = 'keep' AND $rel_margin IS NOT NULL
WITH c ORDER BY c.p DESC, c.rel ASC, c.key ASC
WITH c.sentence AS sk, c.head AS h, c.tail AS t, collect(c) AS cs
WITH cs, cs[0] AS best
WITH cs, best, [x IN cs WHERE x.rel <> best.rel] AS others
WITH cs, best, others WHERE size(others) > 0
WITH cs, best, any(x IN others WHERE x.p >= best.p - toFloat($rel_margin)) AS close
UNWIND cs AS c
WITH c, best, close WHERE c.rel <> best.rel OR close
SET c.amb = true
RETURN count(c) AS n`, { rel_margin: relMargin });
    add('ambiguity', `MATCH (c:_Claim) WHERE c.band = 'keep'
MATCH (d:_Claim) WHERE d.band = 'keep' AND d <> c AND d.sentence = c.sentence AND d.rel = c.rel AND d.head = c.tail AND d.tail = c.head
MATCH (l:_LinkType) WHERE l.id = c.rel AND l.symmetric = false
SET c.rev = true
RETURN count(c) AS n`);
    add('ambiguity', `MATCH (c:_Claim) WHERE c.band = 'keep' AND (c.amb = true OR c.rev = true)
SET c.band = 'review', c.rule = CASE WHEN c.amb = true THEN 'ambiguous' ELSE 'reversed' END
RETURN count(c) AS n`);
    add('ambiguity', 'MATCH (c:_Claim) WHERE c.amb IS NOT NULL OR c.rev IS NOT NULL SET c.amb = null, c.rev = null RETURN count(c) AS n');
  }
  // 7. Verdicts override the bands (rules 5 and 6), latest wins (ts, then seq: one statement's verdicts share a ts).
  if (on('verdicts')) {
    add('verdicts', `MATCH (c:_Claim) WHERE c.rule IN $rules AND c.key IS NOT NULL
MATCH (v:_Verdict {target: c.key})
WITH c, v ORDER BY v.ts DESC, v.seq DESC
WITH c, head(collect(v)) AS v
SET c.band = CASE WHEN v.value = 'accept' THEN 'keep' ELSE 'drop' END, c.rule = 'verdict'
RETURN count(c) AS n`, { rules: OVERRIDABLE_CLAIM_RULES });
  }
  return st;
}

/**
 * Run the gate (D10) over every mention and claim of the store's complete sections, write each
 * one's band and deciding rule, and return them (readGate). Cutoffs come from the stored Kinds
 * and LinkTypes; margins and switched-off rules from opts. No model call.
 * @param {object} db @param {Cl} cl
 * @param {{typeMargin?: number, relMargin?: number, poleMargin?: number|null, off?: string[]}} [opts]
 */
export function gate(db, cl, opts = {}) {
  for (const s of gateStatements(opts)) q(db, cl, s.text, s.params);
  return readGate(db, cl);
}

/**
 * The gate's last result: every banded mention and claim with the rule that decided it.
 * @returns {{mentions: Array<{key: string, doc: string, sentence: string, start: number, end: number, text: string,
 *   label: string, name: string, p: number, source: string, band: string, rule: string, alt: string|null}>,
 *   claims: Array<{key: string, doc: string, sentence: string, rel: string, p: number, htext: string, ttext: string,
 *   head: string|null, tail: string|null, band: string, rule: string, cue: string|null}>}}  cue: the hedge cap's (rule 'hedged')
 */
export function readGate(db, cl) {
  const mentions = q(db, cl, `MATCH (m:_Mention) WHERE m.band IS NOT NULL
RETURN m.key AS key, m.doc AS doc, m.sentence AS sentence, m.start AS start, m.end AS end, m.text AS text,
       m.label AS label, m.name AS name, m.p AS p, m.source AS source, m.band AS band, m.rule AS rule, m.alt AS alt
ORDER BY key`).rows;
  const claims = q(db, cl, `MATCH (c:_Claim) WHERE c.band IS NOT NULL
RETURN c.key AS key, c.doc AS doc, c.sentence AS sentence, c.rel AS rel, c.p AS p, c.htext AS htext, c.ttext AS ttext,
       c.head AS head, c.tail AS tail, c.band AS band, c.rule AS rule, c.cue AS cue
ORDER BY key`).rows;
  return { mentions, claims };
}

// ---- publish (D16) ------------------------------------------------------------------------------

/** An ontology id (isIdent), backticked: the only way an ontology id reaches Cypher text. */
export function ident(id) {
  if (!isIdent(id)) throw new StoreError('ident', `${JSON.stringify(id)} is not a label or type this store writes (ontology.js isOntologyId)`);
  return '`' + id + '`';
}

/**
 * The most frequent surface text, ties to the longest (the most informative: "Dr. Imani Okafor" over
 * "Imani Okafor", "account ACC-2207" over "ACC-2207"), then the smallest in code-point order.
 */
function display(texts) {
  const counts = new Map();
  for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || Array.from(b[0]).length - Array.from(a[0]).length || cmp(a[0], b[0]))[0][0];
}
const sorted = (xs) => [...new Set(xs)].sort(cmp);

/**
 * Write typed relationships of one link type (D16), validated against the stored ontology but not
 * against the gate: publish() is the only caller that should reach here with real data, and the
 * graph type refuses an illegal typed edge anyway (O4). audit.txt calls it with an illegal row.
 * @param {object} db @param {Cl} cl
 * @param {string} rel  a LinkType id of the stored ontology
 * @param {Array<{a: string, b: string, p: number, claims: string[], sentences: string[], docs: string[]}>} rows
 * @param {number} gen
 */
export function writeTypedEdges(db, cl, rel, rows, gen) {
  const { links } = storedOntology(db, cl);
  if (!links.some((l) => l.id === rel)) throw new StoreError('publish', `${JSON.stringify(rel)} is not a link of this store's ontology`);
  ident(rel);
  return n(db, cl, `UNWIND $rows AS r
WITH r WHERE r.a IS NOT NULL AND r.b IS NOT NULL AND $rel IS NOT NULL AND $gen IS NOT NULL
MATCH (a:_Entity {key: r.a})
MATCH (b:_Entity {key: r.b})
MERGE (a)-[x:$($rel)]->(b)
SET x.generation = $gen, x.p = toFloat(r.p), x.claims = r.claims, x.sentences = r.sentences, x.docs = r.docs
RETURN count(x) AS n`, { rel, rows, gen });
}

/**
 * Publish the gate's kept facts as the typed knowledge graph (D16): kept mentions become
 * (:_Entity {key: 'KIND:NAME'}) nodes with their kind label (SET e:$($kind)) and the kind's implied
 * labels (the document's labels.implied, _Kind.implied; none in the bundled ontologies), and with no other
 * label of the ontology's (one an earlier document implied is removed: the labels follow the document), linked from their
 * mentions by OF; kept claims become one (a)-[:REL]->(b) per (head, REL, tail), carrying the max p,
 * the claim keys, the evidence sentences and the documents. Then relationships of older
 * generations are deleted, and entities no longer kept lose their labels (REMOVE e:$($kind), and the implied ones) and
 * go. Idempotent by generation. Kinds and links are checked against the stored ontology first.
 * Run gate() first, with every rule on.
 * @param {object} db @param {Cl} cl
 */
export function publish(db, cl) {
  const onto = storedOntology(db, cl);
  const kinds = new Set(onto.kinds.map((k) => k.id));
  const links = new Map(onto.links.map((l) => [l.id, l]));
  const domainOf = new Map();
  for (const { d, rel, r } of onto.legal) domainOf.set(`${rel}|${d}|${r}`, true);
  const gen = Number(q(db, cl, 'OPTIONAL MATCH (e:_Entity) RETURN coalesce(max(e.generation), 0) AS g').rows[0].g) + 1;

  const kept = q(db, cl, `MATCH (m:_Mention) WHERE m.band = 'keep'
RETURN m.key AS mention, m.label AS kind, m.name AS norm, m.text AS text, m.doc AS doc ORDER BY mention`).rows;
  /** @type {Map<string, {key: string, kind: string, norm: string, texts: string[], docs: string[], mentions: string[]}>} */
  const ents = new Map();
  for (const m of kept) {
    if (!kinds.has(m.kind)) throw new StoreError('publish', `a kept mention has the kind ${JSON.stringify(m.kind)}, which the stored ontology does not list`);
    if (!m.norm) throw new StoreError('publish', `a kept mention (${m.mention}) has no canonical name`);
    const key = `${m.kind}:${m.norm}`;
    const e = ents.get(key) ?? { key, kind: m.kind, norm: m.norm, texts: [], docs: [], mentions: [] };
    e.texts.push(m.text);
    e.docs.push(m.doc);
    e.mentions.push(m.mention);
    ents.set(key, e);
  }
  const entityRows = [...ents.values()].sort((a, b) => cmp(a.key, b.key)).map((e) => {
    const d = display(e.texts);
    return { key: e.key, kind: e.kind, norm: e.norm, name: d, display: d, docs: sorted(e.docs), mentions: e.mentions.length };
  });

  const claims = q(db, cl, `MATCH (c:_Claim) WHERE c.band = 'keep'
RETURN c.key AS claim, c.rel AS rel, c.head AS head, c.tail AS tail, c.hk AS hk, c.tk AS tk, c.p AS p,
       c.sentence AS sentence, c.doc AS doc ORDER BY claim`).rows;
  /** @type {Map<string, Map<string, {a: string, b: string, p: number, claims: string[], sentences: string[], docs: string[]}>>} */
  const byRel = new Map();
  for (const c of claims) {
    const link = links.get(c.rel);
    if (!link) throw new StoreError('publish', `a kept claim has the link ${JSON.stringify(c.rel)}, which the stored ontology does not list`);
    if (!ents.has(c.head) || !ents.has(c.tail)) {
      throw new StoreError('publish', `kept claim ${c.claim} joins ${c.head} and ${c.tail}, not both kept entities: run gate() with every rule on first`);
    }
    let [a, b] = [c.head, c.tail];
    // One fact per symmetric pair: the ontology's own direction, else the smaller key first.
    if (link.symmetric) {
      const forward = domainOf.has(`${c.rel}|${c.hk}|${c.tk}`);
      const backward = domainOf.has(`${c.rel}|${c.tk}|${c.hk}`);
      if ((!forward && backward) || (forward && backward && cmp(b, a) < 0)) [a, b] = [b, a];
    }
    const k = `${a}\u0000${b}`;
    const rows = byRel.get(c.rel) ?? new Map();
    const row = rows.get(k) ?? { a, b, p: -1, claims: [], sentences: [], docs: [] };
    row.p = Math.max(row.p, c.p);
    row.claims.push(c.claim);
    row.sentences.push(c.sentence);
    row.docs.push(c.doc);
    rows.set(k, row);
    byRel.set(c.rel, rows);
  }

  const out = { generation: gen, entities: 0, labelled: 0, relabelled: 0, mentionLinks: 0, staleLinks: 0, relationships: 0, staleRelationships: 0, unlabelled: 0, removedEntities: 0 };
  out.entities = n(db, cl, `UNWIND $rows AS r
WITH r WHERE r.key IS NOT NULL AND $gen IS NOT NULL
MERGE (e:_Entity {key: r.key})
SET e.kind = r.kind, e.norm = r.norm, e.name = r.name, e.display = r.display, e.docs = r.docs, e.mentions = r.mentions,
    e.generation = $gen
RETURN count(e) AS n`, { rows: entityRows, gen });
  for (const { id: kind, implied } of onto.kinds) {
    ident(kind);
    out.labelled += n(db, cl, `MATCH (e:_Entity) WHERE $kind IS NOT NULL AND $gen IS NOT NULL AND e.kind = $kind AND e.generation = $gen
SET e:$($kind) RETURN count(e) AS n`, { kind, gen });
    for (const label of implied) {
      ident(label);
      n(db, cl, `MATCH (e:_Entity) WHERE $kind IS NOT NULL AND $label IS NOT NULL AND $gen IS NOT NULL AND e.kind = $kind AND e.generation = $gen
SET e:$($label) RETURN count(e) AS n`, { kind, label, gen });
    }
  }
  // The labels follow the document: an entity keeps only its kind, the kind's current implied labels and the
  // example's own `_` labels. A label an earlier document implied (or any other) goes, so a re-applied
  // ontology without implied labels takes them off the entities it had put them on.
  const allowed = new Map(onto.kinds.map((k) => [k.id, new Set([k.id, ...k.implied])]));
  /** @type {Map<string, string[]>} stray label -> the keys of the entities that carry it */
  const stray = new Map();
  for (const r of q(db, cl, `MATCH (e:_Entity) WHERE $gen IS NOT NULL AND e.generation = $gen
RETURN e.key AS key, e.kind AS kind, labels(e) AS labels ORDER BY key`, { gen }).rows) {
    for (const l of r.labels) {
      if (l.startsWith('_') || allowed.get(r.kind)?.has(l)) continue;
      stray.set(l, [...(stray.get(l) ?? []), r.key]);
    }
  }
  for (const label of [...stray.keys()].sort(cmp)) {
    out.relabelled += n(db, cl, `UNWIND $keys AS k
WITH k WHERE k IS NOT NULL AND $label IS NOT NULL
MATCH (e:_Entity {key: k})
REMOVE e:$($label) RETURN count(e) AS n`, { keys: stray.get(label), label });
  }
  const ofRows = [...ents.values()].flatMap((e) => e.mentions.map((mention) => ({ mention, entity: e.key })));
  out.mentionLinks = n(db, cl, `UNWIND $rows AS r
WITH r WHERE r.mention IS NOT NULL AND r.entity IS NOT NULL
MATCH (m:_Mention {key: r.mention})
MATCH (e:_Entity {key: r.entity})
MERGE (m)-[:_OF]->(e)
RETURN count(m) AS n`, { rows: ofRows });
  out.staleLinks = n(db, cl, `MATCH (m:_Mention)-[r:_OF]->(e:_Entity)
WHERE m.band IS NULL OR m.band <> 'keep' OR e.key <> m.label + ':' + m.name
DELETE r RETURN count(*) AS n`);
  for (const rel of [...byRel.keys()].sort(cmp)) {
    const rows = [...byRel.get(rel).values()].sort((x, y) => cmp(x.a, y.a) || cmp(x.b, y.b))
      .map((r) => ({ ...r, claims: sorted(r.claims), sentences: sorted(r.sentences), docs: sorted(r.docs) }));
    const got = writeTypedEdges(db, cl, rel, rows, gen);
    if (got !== rows.length) throw new StoreError('publish', `${rel}: wrote ${got} of ${rows.length} relationships`);
    out.relationships += got;
  }
  out.staleRelationships = n(db, cl, `MATCH (:_Entity)-[x]->(:_Entity) WHERE $gen IS NOT NULL AND (x.generation IS NULL OR x.generation <> $gen)
DELETE x RETURN count(*) AS n`, { gen });
  for (const { id: kind, implied } of onto.kinds) {
    out.unlabelled += n(db, cl, `MATCH (e:_Entity) WHERE $kind IS NOT NULL AND $gen IS NOT NULL AND e.kind = $kind AND e.generation <> $gen
REMOVE e:$($kind) RETURN count(e) AS n`, { kind, gen });
    for (const label of implied) {
      n(db, cl, `MATCH (e:_Entity) WHERE $kind IS NOT NULL AND $label IS NOT NULL AND $gen IS NOT NULL AND e.kind = $kind AND e.generation <> $gen
REMOVE e:$($label) RETURN count(e) AS n`, { kind, label, gen });
    }
  }
  out.removedEntities = n(db, cl, `MATCH (e:_Entity) WHERE $gen IS NOT NULL AND e.generation <> $gen
DETACH DELETE e RETURN count(*) AS n`, { gen });
  return out;
}

// ---- scoring (score.txt) ----------------------------------------------------------------------

/**
 * Load gold labels as (:_Gold) rows (idempotent). Names must already be canonical
 * (names.js normalizeEntityName), as edgextract's eval compares them.
 * @param {object} db @param {Cl} cl
 * @param {Array<{doc: string, title: string, entities: Array<{name: string, type: string}>,
 *   relations: Array<{src: string, rel: string, tgt: string}>}>} gold  doc: the document id (sha256 of its text)
 */
export function loadGold(db, cl, gold) {
  const rows = [];
  for (const g of gold) {
    rows.push({ key: `${g.doc}|doc`, kind: 'doc', doc: g.doc, title: g.title, src: '', rel: '', tgt: '' });
    for (const e of g.entities) rows.push({ key: `${g.doc}|e|${e.name}|${e.type}`, kind: 'entity', doc: g.doc, title: g.title, src: e.name, rel: e.type, tgt: '' });
    for (const r of g.relations) rows.push({ key: `${g.doc}|r|${r.src}|${r.rel}|${r.tgt}`, kind: 'relation', doc: g.doc, title: g.title, src: r.src, rel: r.rel, tgt: r.tgt });
  }
  return n(db, cl, `UNWIND $rows AS r
WITH r WHERE r.key IS NOT NULL
MERGE (g:_Gold {key: r.key})
SET g.kind = r.kind, g.doc = r.doc, g.title = r.title, g.src = r.src, g.rel = r.rel, g.tgt = r.tgt
RETURN count(g) AS n`, { rows });
}

/**
 * Leading honorifics the create-context-graph scoring ignores (names: 'honorific'), as the first
 * token of a canonical name: DR_IMANI_OKAFOR and IMANI_OKAFOR match. Their gold files name people
 * without a title ("Imani Okafor") where the text writes "Dr. Imani Okafor".
 */
export const HONORIFICS = Object.freeze(['DR', 'MR', 'MRS', 'MS', 'PROF']);

/** A canonical name without a leading honorific token (a bare DR stays). @param {string} name */
export function withoutHonorific(name) {
  for (const h of HONORIFICS) if (name.startsWith(`${h}_`) && name.length > h.length + 1) return name.slice(h.length + 1);
  return name;
}

/** withoutHonorific in Cypher, for the expression x; x itself with names: 'canonical'. */
function nameKey(x, names) {
  if (names === 'canonical') return x;
  return `CASE ${HONORIFICS.map((h) => `WHEN ${x} STARTS WITH '${h}_' AND size(${x}) > ${h.length + 1} THEN substring(${x}, ${h.length + 1})`).join(' ')} ELSE ${x} END`;
}

/** Predicted entities and relations per gold document, as edgextract's eval keys them. */
const PRED = {
  gate: {
    entities: (k) => `OPTIONAL MATCH (m:_Mention {doc: gd.doc}) WHERE m.band = 'keep'
WITH gd, collect(DISTINCT ${k('m.name')} + '|' + m.label) AS pred`,
    relations: (k) => `OPTIONAL MATCH (c:_Claim {doc: gd.doc}) WHERE c.band = 'keep'
WITH gd, collect(DISTINCT ${k('c.hn')} + '|' + ${k('c.tn')} + '|' + c.rel) AS pred`,
  },
  graph: {
    entities: (k) => `OPTIONAL MATCH (e:_Entity) WHERE gd.doc IN e.docs
WITH gd, collect(DISTINCT ${k('e.norm')} + '|' + e.kind) AS pred`,
    relations: (k) => `OPTIONAL MATCH (a:_Entity)-[r]->(b:_Entity) WHERE gd.doc IN r.docs
WITH gd, collect(DISTINCT ${k('a.norm')} + '|' + ${k('b.norm')} + '|' + type(r)) AS pred`,
  },
};
const GOLD = {
  entities: (k) => `OPTIONAL MATCH (g:_Gold {kind: 'entity', doc: gd.doc})
WITH gd, pred, collect(DISTINCT ${k('g.src')} + '|' + g.rel) AS gold`,
  relations: (k) => `OPTIONAL MATCH (g:_Gold {kind: 'relation', doc: gd.doc})
WITH gd, pred, collect(DISTINCT ${k('g.src')} + '|' + ${k('g.tgt')} + '|' + g.rel) AS gold`,
};

/**
 * Precision, recall and F1 against the (:_Gold) rows, in Cypher: per gold document and micro-
 * averaged over them (edgextract's eval: entities as (NAME, TYPE), relations as (SRC, TGT, REL)).
 * `from: 'gate'` scores the gate's kept mentions and claims (any rule switched off, nothing
 * published); `from: 'graph'` scores the published typed graph. Names are canonical on both sides
 * (names.js); with `names: 'honorific'` a leading honorific token is ignored as well
 * (withoutHonorific: Dr., Mr., Mrs., Ms., Prof.), as the create-context-graph samples are scored.
 * @param {object} db @param {Cl} cl
 * @param {Parameters<typeof loadGold>[2]} [gold]  loaded first when given
 * @param {{from?: 'gate'|'graph', names?: 'canonical'|'honorific'}} [opts]
 * @returns {{entities: {docs: object[], total: object}, relations: {docs: object[], total: object}}}
 */
export function scoreAgainstGold(db, cl, gold, { from = 'gate', names = 'canonical' } = {}) {
  if (gold) loadGold(db, cl, gold);
  if (names !== 'canonical' && names !== 'honorific') throw new StoreError('score', `names: 'canonical' or 'honorific', not ${JSON.stringify(names)}`);
  const k = (x) => nameKey(x, names);
  const prf = `WITH gd, pred, gold, size([x IN pred WHERE x IN gold]) AS tp
WITH gd, pred, gold, tp, size(pred) - tp AS fp, size(gold) - tp AS fn`;
  const out = {};
  for (const what of /** @type {const} */ (['entities', 'relations'])) {
    const base = `MATCH (gd:_Gold {kind: 'doc'}) WHERE gd.doc IS NOT NULL
${PRED[from][what](k)}
${GOLD[what](k)}
${prf}`;
    const docs = q(db, cl, `${base}
RETURN gd.title AS title, tp, fp, fn,
       CASE WHEN tp + fp > 0 THEN toFloat(tp) / (tp + fp) ELSE 0.0 END AS precision,
       CASE WHEN tp + fn > 0 THEN toFloat(tp) / (tp + fn) ELSE 0.0 END AS recall,
       [x IN pred WHERE NOT x IN gold] AS false_pos, [x IN gold WHERE NOT x IN pred] AS missed
ORDER BY title`).rows.map((r) => ({ ...r, f1: f1(r.precision, r.recall), false_pos: [...r.false_pos].sort(cmp), missed: [...r.missed].sort(cmp) }));
    // The micro-average: the documents' counts summed (one query fewer per call; the grids call this often).
    const t = { tp: 0, fp: 0, fn: 0 };
    for (const d of docs) for (const k of /** @type {const} */ (['tp', 'fp', 'fn'])) t[k] += Number(d[k]);
    const precision = t.tp + t.fp > 0 ? t.tp / (t.tp + t.fp) : 0;
    const recall = t.tp + t.fn > 0 ? t.tp / (t.tp + t.fn) : 0;
    out[what] = { docs, total: { ...t, precision, recall, f1: f1(precision, recall) } };
  }
  return /** @type {any} */ (out);
}
const f1 = (p, r) => (p + r > 0 ? (2 * p * r) / (p + r) : 0);

// ---- export (graph.cypher, D17) -------------------------------------------------------------------

/** A Cypher string literal (single quotes; backslash and quote escaped). */
function lit(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + "'";
}
function litValue(v) {
  if (Array.isArray(v)) return `[${v.map(litValue).join(', ')}]`;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === 'boolean') return String(v);
  return lit(v);
}
function litMap(obj) {
  return `{${Object.entries(obj).map(([k, v]) => `${k}: ${litValue(v)}`).join(', ')}}`;
}

/**
 * The typed knowledge graph as Cypher another database can run (graph.cypher): a UNIQUE constraint
 * on :_Entity(key) (its backing RANGE index serves the lookups, R9), then one
 * UNWIND-literal batch per kind and per link
 * type. Labels and types come from the stored ontology only, pass isIdent and are backticked;
 * values are literals; the order is deterministic (ontology order, then keys). With `docs`, only
 * the facts those documents support (and the entities they join) are written, their `docs` lists,
 * evidence, claim counts and best scores cut down to those documents. Documents are written by
 * title, scores to 3 decimals.
 * @param {object} db @param {Cl} cl
 * @param {{docs?: string[], batch?: number}} [opts]  docs: document ids
 * @returns {string}
 */
export function exportCypher(db, cl, { docs, batch = 100 } = {}) {
  const onto = storedOntology(db, cl);
  const titles = new Map(q(db, cl, 'MATCH (d:_Document) RETURN d.id AS id, d.title AS title').rows.map((r) => [r.id, r.title]));
  const keep = docs ? new Set(docs) : null;
  const within = (ds) => (keep ? ds.filter((d) => keep.has(d)) : ds);
  const docTitles = (ds) => sorted(within(ds).map((d) => titles.get(d) ?? d));
  const ents = q(db, cl, `MATCH (e:_Entity) WHERE e.kind IS NOT NULL
RETURN e.key AS key, e.kind AS kind, e.name AS name, e.docs AS docs ORDER BY key`).rows;
  const rels = q(db, cl, `MATCH (a:_Entity)-[r]->(b:_Entity)
RETURN a.key AS a, type(r) AS rel, b.key AS b, r.p AS p, r.claims AS claims, r.docs AS docs, r.sentences AS sentences
ORDER BY a, rel, b`).rows;
  const sentenceText = new Map(q(db, cl, `MATCH (a:_Entity)-[r]->(:_Entity) UNWIND r.sentences AS k
WITH k WHERE k IS NOT NULL
MATCH (s:_Sentence {key: k}) RETURN DISTINCT s.key AS key, s.text AS text`).rows.map((r) => [r.key, r.text]));
  // With `docs`, a relationship's claim count and best score come from those documents' claims only.
  const claimInfo = new Map(q(db, cl, `MATCH (:_Entity)-[r]->(:_Entity) UNWIND r.claims AS k
WITH k WHERE k IS NOT NULL
MATCH (c:_Claim {key: k}) RETURN DISTINCT c.key AS key, c.doc AS doc, c.p AS p`).rows.map((r) => [r.key, r]));
  const relRows = rels.filter((r) => within(r.docs).length > 0).map((r) => {
    if (!keep) return r;
    const claims = r.claims.filter((k) => keep.has(claimInfo.get(k)?.doc));
    return { ...r, claims, p: Math.max(...claims.map((k) => claimInfo.get(k).p)) };
  });
  const needed = new Set(relRows.flatMap((r) => [r.a, r.b]));
  const entRows = ents.filter((e) => within(e.docs).length > 0 || needed.has(e.key));
  const lines = [];
  const kindIds = onto.kinds.map((k) => k.id);
  const linkIds = onto.links.map((l) => l.id);
  lines.push(`// The typed knowledge graph of the ontology ${onto.oid}: ${entRows.length} entities, ${relRows.length} relationships.`);
  lines.push('// Written by web/store.js exportCypher (example 01): entities are (:_Entity:KIND {key: \'KIND:NAME\'}),');
  lines.push('// relationships carry the best score (p), the number of claims behind them, their documents and evidence.');
  lines.push('CREATE CONSTRAINT entity_key_unique IF NOT EXISTS FOR (e:_Entity) REQUIRE e.key IS UNIQUE;');
  const chunks = (xs) => {
    const out = [];
    for (let i = 0; i < xs.length; i += batch) out.push(xs.slice(i, i + batch));
    return out;
  };
  const impliedOf = new Map(onto.kinds.map((k) => [k.id, k.implied]));
  for (const kind of kindIds) {
    const rows = entRows.filter((e) => e.kind === kind);
    if (!rows.length) continue;
    // the kind's label, then its implied ones (the document's labels.implied)
    const label = [kind, ...(impliedOf.get(kind) ?? [])].map(ident).join(':');
    for (const part of chunks(rows)) {
      lines.push('UNWIND [');
      lines.push(part.map((e) => `  ${litMap({ key: e.key, name: e.name, docs: docTitles(e.docs) })}`).join(',\n'));
      lines.push('] AS row');
      lines.push('WITH row WHERE row.key IS NOT NULL');
      lines.push('MERGE (e:_Entity {key: row.key})');
      lines.push(`SET e:${label}, e.name = row.name, e.docs = row.docs;`);
    }
  }
  for (const rel of linkIds) {
    const rows = relRows.filter((r) => r.rel === rel);
    if (!rows.length) continue;
    const type = ident(rel);
    for (const part of chunks(rows)) {
      lines.push('UNWIND [');
      lines.push(part.map((r) => `  ${litMap({
        a: r.a, b: r.b, p: Math.round(r.p * 1000) / 1000, claims: r.claims.length, docs: docTitles(r.docs),
        evidence: sorted(r.sentences.filter((k) => !keep || keep.has(k.split('#')[0])).map((k) => sentenceText.get(k) ?? '')),
      })}`).join(',\n'));
      lines.push('] AS row');
      lines.push('WITH row WHERE row.a IS NOT NULL AND row.b IS NOT NULL');
      lines.push('MATCH (a:_Entity {key: row.a})');
      lines.push('MATCH (b:_Entity {key: row.b})');
      lines.push(`MERGE (a)-[r:${type}]->(b)`);
      lines.push('SET r.p = row.p, r.claims = row.claims, r.docs = row.docs, r.evidence = row.evidence;');
    }
  }
  const unknown = relRows.filter((r) => !linkIds.includes(r.rel)).map((r) => r.rel);
  if (unknown.length) throw new StoreError('export', `relationship types outside the ontology: ${sorted(unknown).join(', ')}`);
  return lines.join('\n') + '\n';
}

// ---- dump (D17) ------------------------------------------------------------------------------------

/**
 * The store as dump.json: canon(dump(db)) in lib/replay's format (D17, D18), which lib/replay.py
 * and lib/replay.mjs load. Never JSON.stringify a dump (its FLOATs would come back as INTEGERs).
 * @param {object} db
 * @returns {string}
 */
export function dumpStore(db) {
  return canon(dump(db));
}

/** Node and relationship counts by label and type, for reports: [{what, name, n}] sorted. */
export function counts(db, cl) {
  const labels = q(db, cl, 'MATCH (x) UNWIND labels(x) AS l RETURN l AS name, count(*) AS n ORDER BY name').rows;
  const types = q(db, cl, 'MATCH ()-[r]->() RETURN type(r) AS name, count(*) AS n ORDER BY name').rows;
  return { labels, types };
}
