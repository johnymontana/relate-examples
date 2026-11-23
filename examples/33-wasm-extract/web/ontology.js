// @ts-check
/**
 * ontology.js: an ontology, an Ontology Graph Specification v1 document (ogs.js), parsed,
 * validated, and kept in Relate as the document, a derived graph and an engine-enforced graph
 * type (D5, D8, D14, D15; findings E1, O1-O6; NOTES.md R7, R9, R16, R17). The ontology lives in
 * `neo4j`: there is no system_ontologies database, and the db.ontology.* procedures sit behind the
 * RELATE_PREVIEW=ontology preview gate, which the WASM build cannot open (it reads no environment)
 * (O1, O3, R17); the graph type holds only relationship types with one source and one target kind
 * (O5, R16).
 *
 * Shared by the engine worker, the page and the Node harness. It imports js-yaml (through ogs.js)
 * by its bare name (Node finds it in this example's node_modules; for the page, build.mjs and
 * harness/serve.mjs rewrite the specifier to the served asset path, since the CSP rules out an
 * inline import map and module workers ignore import maps), lib/replay.mjs (graph-type rendering
 * and sha256, by a relative path the same rewrite maps to assets/lib-<sha8>/) and gliner.js
 * (relation phrases). It never imports lib/relate_wasm.mjs: the functions that touch a database take
 * that module as `cl`.
 *
 *   const o = parseOntology(text, {bases});         // v1 (YAML or JSON), or a create-context-graph file converted; OntologyError
 *   o.doc; o.yaml; o.sha; o.convertedFrom;          // the v1 document, as YAML, its sha256, 'create-context-graph'|null
 *   o.tools;                                        // the document's tools, each with the element it sits on
 *   storeName(o);                                   // 'ex33-kg-financial-services' (D14)
 *   graphTypeSpec(o);                               // {spec, typed, untyped} (D15)
 *   applyOntology(db, o, cl);                       // writes the D8 layer, ALTERs the graph type (sync)
 *   ontologyFromStored(readOntology(db, cl));       // the stored v1 document parsed again
 *   ontologyCanary(db, cl);                         // {procedures: []} while db.ontology.* stays gated off
 *
 * One format, two inputs (parseOntology tells them apart by their keys):
 *   - an Ontology Graph Spec v1 document (`$schema`, or `nodes`): read as it is;
 *   - create-context-graph's domain files (`domain` or `entity_types`; data/ontologies/ccg/):
 *     converted to v1 first by convert.js (its header has the mapping), with the refusals its
 *     reader made before; o.convertedFrom is 'create-context-graph' and o.sourceSha the sha256 of
 *     the file, its `inherits` name and the base's text joined by NUL (ontologySha).
 *   Anything else is refused: a file with `$schema` and `domain`/`entity_types`, and edgextract's
 *   ontology YAML (`types`), which earlier builds converted and this one no longer reads (a store
 *   that holds such a file says so: ontologyFromStored, LEGACY_FORMAT).
 * The bundled ontologies are the converted documents (data/ontologies/ogs/ccg/, which
 * harness/ontology.mjs keeps equal to a fresh conversion of the originals beside them).
 *
 * A v1 document is checked against the spec's JSON Schema and the rules ogs.js lists (an endpoint
 * names a node, a constraint names a property beside it, the id rule, ...). Then the kinds and
 * links are built from it, as they were from the formats before, so what the model is asked and
 * every inference cache key (D7) are what they were (harness/ontology.mjs pins it per ontology):
 *   - kinds: the nodes in document order; a kind's id is its identifier label (`label`, or
 *     `labels.identifier`), its implied labels go with it onto published entities (store.js
 *     publish); its description is the node's (else, for a create-context-graph node, derived from
 *     the pole as kindDescription does; else the label); its colour neo4j:display's (else
 *     CCG_DEFAULT_COLOR in a create-context-graph document, DEFAULT_COLOR otherwise); its pole,
 *     subtype and origin come from the createContextGraph:pole extension (origin 'base' for
 *     `origin: base`, else 'own'), null and 'own' without it; aliases are the node's.
 *   - links: the relationship entries grouped by `type`, in the order each type first appears; a
 *     link's legal pairs are its entries' (from, to) identifier labels, in that order, and nothing
 *     else (government's ELIGIBLE_FOR is Citizen -> Program and Citizen -> Service, never more);
 *     symmetric when its entries carry the edgextract:symmetric extension (a symmetric link is legal
 *     either way round); origin 'base' when they carry createContextGraph:origin {origin: base};
 *     its description the first entry's that has one.
 *   - the gazetteer: the edgextract:gazetteer extension at the top level (name -> node id). Both
 *     extensions keep the names edgextract gave the two features (rule 1 and symmetric links are
 *     edgextract's), and any v1 document may carry them; no bundled one does.
 *   - `format`, which says how the model is asked: 'create-context-graph' for a document with the
 *     createContextGraph:domain extension, 'generic' for any other. Both take the same default
 *     cutoffs (store.js defaultGate).
 *   - the tools (o.tools, below): every node's, then every relationship entry's, in document order.
 *
 * What the model is asked (each kind's and link's `ask`, derived, never stored: ontologyFromStored
 * derives it again), chosen on the 27 samples (experiment B, README "What the model is asked"):
 *   a create-context-graph document: a kind by its label as text (labelText:
 *   "MaintenanceRecord" -> "maintenance record"), with "<subtype> in <name>" as its description for
 *   a domain kind with a subtype ("financial account in financial services"; `name` is the
 *   document's) and none for a base kind; a base kind that no relationship names and whose pole one
 *   of the domain's own kinds shares is not asked at all (ask null: the base's Object in all 27
 *   domains, Event in agent-memory and vacation-industry). It stays a kind, a _Kind and a node
 *   type; the model never proposes it. Two kinds that read alike are refused. A link: its phrase
 *   between its endpoints' label texts, one per legal pair, joined by " or " ("transaction
 *   transferred to account").
 *   any other document ('generic'): every kind by its label as text, with the node's own
 *   `description` (none when it has none), and every link as for create-context-graph, its phrase
 *   between its endpoints' label texts. Two kinds, or two links, that read alike are refused.
 *   Both: two links that read as one phrase are refused (gliner.js checkSchema refuses duplicate
 *   phrases), and so is a kind pair with more than 25 legal links (26 choices with NONE).
 *
 * The tools (OG2's interface): o.tools = [{anchor: {kind: 'node'|'relationship', key, label|type},
 * type, name, description, cypher, url, parameters}] in document order; `key` is the node's or
 * relationship entry's key in the document, `label` the node's identifier label (a node anchor),
 * `type` the relationship type (a relationship anchor); cypher and url are null when the tool has
 * none, parameters [] (each {name, type?, description?, ...} as the document has it). The spec
 * leaves each tool type's fields to its owner; these are read from canonicalQuery (cypher,
 * parameters) and externalRequest (url) tools, and any tool gets its name and description.
 *
 * The id rule (isOntologyId, ogs.js): letters with their combining marks, digits and `_`, at least
 * one letter or digit, NFC, at most 64 code points, and never a leading `_`. Every label and
 * relationship type this example writes for its own bookkeeping starts with `_` (_Document,
 * _Entity, _Claim, _IN, _OF, ... in store.js and below), so an ontology's kinds and links can take
 * any other name, Entity and Claim included, and never touch them. web/store.js uses the same rule
 * before an id reaches Cypher text, so what this module accepts the store writes. harness/ontology.mjs
 * pins the limits: Unicode ids (D8), relationship types checked too, the 64-character cap, two links
 * one phrase, a 26-choice kind pair refused at load.
 *
 * Keys and names written to the store (D8; D14's one ontology per store):
 *   (:_Ontology {id, version, title, format, spec, doc, sha, converted_from, source_sha, graph_type})
 *       doc: the v1 document as canonical JSON (ogs.js toCanonicalJson); sha: its sha256; spec:
 *       '1.0.0'; converted_from and source_sha: null for a document that came as v1. A store an
 *       earlier build wrote holds {yaml, inherits, base_yaml} instead of {spec, doc, ...}:
 *       ontologyFromStored converts that YAML as parseOntology does, and the next apply replaces
 *       those three properties with the document.
 *   (:_Kind {key: '<ontology id>:<KIND>', id, description, color, aliases, implied, pole, origin, ord, keep, drop})-[:_IN]->(:_Ontology)
 *       implied: the kind's implied labels (absent when it has none); pole: create-context-graph's
 *       pole_type (null without the pole extension); origin: 'base' for a kind the inherited base
 *       contributed, else 'own'. The gate's rule 2 reads both: a domain kind with the pole of a
 *       base kind specialises it (store.js, 'pole-specific')
 *   (:_LinkType {key: '<ontology id>:<REL>', id, phrase, description, symmetric, pairs, typed,
 *                untyped_reason, ord, keep, drop})-[:_DOMAIN|_RANGE]->(:_Kind), -[:_IN]->(:_Ontology)
 *   (:_Alias {name, ord})-[:_OF]->(:_Kind)                         the gazetteer
 * `pairs` is the legality the gate checks (D10 rule 4): the link's legal (source, target) kind pairs
 * as 'SOURCE|TARGET' strings, in the document's direction (a symmetric link is also legal reversed;
 * the gate and the audits honour `symmetric`). `_DOMAIN` and `_RANGE` edges are the union of those
 * pairs' sources and targets, for the ontology view (queries/05-ontology-graph.cypher); they are
 * not legality: PARTY_TO (Person -> Case, Organization -> Contract) has two of each, yet
 * Person -> Contract is illegal. keep and drop (the per-kind and per-link cutoffs of D10) are set
 * on creation only, so a re-applied ontology keeps cutoffs the gate has moved. `ord` is the
 * document order. Keywords work as labels, types, properties, aliases and map keys: `drop` is a
 * property here (l.drop).
 *
 * Graph types (D15, O4, O5, R16): every kind is a node type (:KIND => {name :: STRING NOT NULL});
 * a link with exactly one legal pair (and not symmetric across two kinds) is an edge type
 * (:S)-[:REL =>]->(:T), `typed`; the rest stay out of the graph type, with the reason, and only the
 * Cypher gate checks them. ALTER CURRENT GRAPH TYPE SET drops every existing constraint (R16;
 * plain indexes survive), so applyOntology ALTERs only when the elements change, and then
 * re-creates its UNIQUE constraints: a caller with constraints of its own (web/store.js) must
 * re-create them whenever applyOntology returns altered: true. Of what a v1 document declares,
 * this example enforces the labels, the relationship types with their endpoints, and `name`; the
 * other declared properties, constraints and cardinalities stay descriptive, because the extractor
 * writes only name, display, key and its own bookkeeping on an entity (README "The ontology format").
 */
import { relationPhrase } from './gliner.js';
import { rustTrim } from './names.js';
import { renderGraphType, sha256, splitGraphType } from '../../../lib/replay.mjs';
import {
  EXTENSIONS, OntologyError, SPEC_VERSION, cmpCodePoints, customOf, isMap, isOntologyId, loadText, nodeLabel, orderDocument,
  toCanonicalJson, toYaml, validateDocument,
} from './ogs.js';
import {
  CCG_DEFAULT_COLOR, DEFAULT_COLOR, MAX_RELATION_EDGES, MAX_TYPES, MIN_TYPES, fromCreateContextGraph, humanise, kindDescription,
} from './convert.js';

export { MAX_ID_CHARS, RESERVED_PREFIX, idProblem } from './ogs.js';
export {
  OntologyError, isOntologyId, cmpCodePoints, kindDescription, CCG_DEFAULT_COLOR, DEFAULT_COLOR, MIN_TYPES, MAX_TYPES, MAX_RELATION_EDGES,
};

export const MAX_CHOICE_OPTIONS = 26;
/** How the model is asked (Ontology.format): a create-context-graph document, or any other v1 document. */
export const FORMATS = Object.freeze(['create-context-graph', 'generic']);
/** What parseOntology reads: v1, and the format it converts. */
export const INPUTS = Object.freeze(['ontology-graph-spec', 'create-context-graph']);
/**
 * The format of an ontology file earlier builds converted and this one does not read: a store that
 * holds one as its YAML (pre-v1) is refused with this mark on the OntologyError (ontologyFromStored),
 * and the page offers to delete it (web/worker.js, the earlier-build banner).
 */
export const LEGACY_FORMAT = 'edgextract';
/** The labels and relationship types of the example's own graph (D8), all with the reserved prefix. */
export const INTERNAL_LABELS = Object.freeze(['_Document', '_Section', '_Sentence', '_Inference', '_InferencePart',
  '_Mention', '_Entity', '_Claim', '_Run', '_Verdict', '_Gold', '_Ontology', '_Kind', '_LinkType', '_Alias']);
export const INTERNAL_TYPES = Object.freeze(['_IN', '_OF', '_HEAD', '_TAIL', '_EVIDENCE', '_DOMAIN', '_RANGE', '_READ', '_ON', '_INFERRED']);
/** Every OPFS store of this example is named `ex33-kg-<slug>` (D14, D19). */
export const STORE_PREFIX = 'ex33-kg-';
/** Relate's OPFS name rule (1-64 of [A-Za-z0-9_-]), so a slug holds at most 56. */
export const MAX_STORE_NAME = 64;
/** The cutoffs a new Kind or LinkType starts with (E4); the gate may move them (D10). */
export const DEFAULT_CUTOFFS = Object.freeze({ keep: 0.8, drop: 0.2 });

/**
 * The store refused the ontology. code:
 *   'blocked'        existing data violates the new graph type (O5): offer "rebuild the graph"
 *                    (D14: drop the projection, apply again, re-publish from the trace);
 *   'other-ontology' the store already holds another ontology (D14: one per store);
 *   'mismatch'       SHOW CURRENT GRAPH TYPE does not read back the derived spec;
 *   'refused'        any other engine refusal (the engine's message is in .detail).
 */
export class OntologyApplyError extends Error {
  /**
   * @param {'blocked'|'other-ontology'|'mismatch'|'refused'} code
   * @param {string} message
   * @param {{detail?: string, current?: string|null}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'OntologyApplyError';
    this.code = code;
    this.detail = extra.detail ?? null;
    this.current = extra.current ?? null;
  }
}

/**
 * @typedef {{label: string, description: string|null}} KindAsk
 * @typedef {{id: string, key: string, description: string, aliases: string[], implied: string[], color: string, pole: string|null,
 *   subtype: string|null, origin: 'own'|'base', ask: KindAsk|null}} Kind
 *   key: the node's key in the document; implied: its implied labels; pole and subtype: create-context-graph's pole_type
 *   and subtype (null without the pole extension); origin: 'base' when the kind came from the inherited base; ask: the
 *   label and description the model is asked for (pipeline.modelSchema), null for a kind the model is not asked about
 * @typedef {{id: string, description: string, domain: string[], range: string[], symmetric: boolean, phrase: string,
 *   pairs: Array<[string, string]>, keys: string[], origin: 'own'|'base', ask: string}} Relation
 *   pairs: the legal (source, target) kinds in the document's direction; keys: the relationship entries' keys, one per
 *   pair; domain and range: their distinct sources and targets; origin: 'base' when the relationship type came from the
 *   inherited base; ask: the relation name the model is asked for, its phrase between its endpoints' label texts
 * @typedef {{name: string, description: string, tagline: string, emoji: string}} DomainInfo
 * @typedef {{anchor: {kind: 'node', key: string, label: string} | {kind: 'relationship', key: string, type: string},
 *   type: string, name: string, description: string, cypher: string|null, url: string|null, parameters: any[]}} Tool
 * @typedef {{format: 'create-context-graph'|'generic', spec: string, id: string, version: number, title: string,
 *   meta: DomainInfo|null, convertedFrom: 'create-context-graph'|'edgextract'|null, sourceSha: string|null, doc: any,
 *   types: Kind[], relations: Relation[], gazetteer: Object<string, string>, names: Array<[string, string]>,
 *   pairs: Array<[string, string, string]>, tools: Tool[], sha: string, yaml: string,
 *   report: {tools: any[], types: any[], dropped: string[]}|null}} Ontology
 *   format: how the model is asked; convertedFrom: the format the document was converted from ('edgextract' only
 *   in a store an earlier build wrote, ontologyFromStored); meta: the createContextGraph:domain extension's tagline
 *   and emoji with the document's name and description (null without it); doc: the v1 document (fields in the
 *   schema's order); yaml: ogs.js toYaml(doc); sha: sha256 of ogs.js toCanonicalJson(doc); pairs: every legal
 *   (source, link, target) triple, a symmetric link's reversed ones included; report: what a conversion decided
 *   (convert.js), null for a v1 input
 */

const uniq = (xs) => [...new Set(xs)];

/** The relations legal from kind src to kind tgt, in document order (ontology.rs relation_choice_criteria). */
function allowed(relations, src, tgt) {
  const has = (r, a, b) => r.pairs.some(([x, y]) => x === a && y === b);
  return relations.filter((r) => has(r, src, tgt) || (r.symmetric && has(r, tgt, src))).map((r) => r.id);
}

/** A legacy file's sha (D8): of its text, or of the text, the base's name and the base's text joined by NUL. */
export function ontologySha(text, inherits = null, baseText = null) {
  return inherits === null ? sha256(text) : sha256(`${text}\u0000${inherits}\u0000${baseText ?? ''}`);
}

/** edgextract's ontology YAML, which earlier builds converted: a mapping with `types` and none of v1's or create-context-graph's keys. */
function isLegacyFile(data) {
  return isMap(data) && Object.hasOwn(data, 'types') && !['$schema', 'nodes', 'domain', 'entity_types'].some((k) => Object.hasOwn(data, k));
}

/**
 * What a parsed text is: 'ontology-graph-spec' or 'create-context-graph'; anything else is refused,
 * edgextract's ontology YAML with an OntologyError marked legacyFormat (LEGACY_FORMAT).
 */
function inputOf(data) {
  if (!isMap(data)) throw new OntologyError('An ontology is a mapping (YAML or JSON): an Ontology Graph Spec v1 document, or a create-context-graph domain file');
  const ccg = Object.hasOwn(data, 'domain') || Object.hasOwn(data, 'entity_types');
  if (ccg && Object.hasOwn(data, '$schema')) {
    throw new OntologyError('This file mixes two formats: `$schema` marks an Ontology Graph Spec document, `domain` and ' +
      '`entity_types` are create-context-graph\'s. Keep one of them.');
  }
  if (ccg) return 'create-context-graph';
  if (Object.hasOwn(data, '$schema') || Object.hasOwn(data, 'nodes')) return 'ontology-graph-spec';
  if (isLegacyFile(data)) {
    const e = new OntologyError('This looks like edgextract\'s ontology YAML (`types`, `relations`, `gazetteer`), which this page no ' +
      'longer reads. Write it as an Ontology Graph Spec v1 document: `$schema`, `id`, `version`, `nodes` (one per type, with ' +
      '`label` and `description`) and `relationships` (one entry per pair: `type`, `from: {node}`, `to: {node}`); README ' +
      '"The ontology format" has the mapping.');
    /** @type {any} */ (e).legacyFormat = LEGACY_FORMAT;
    throw e;
  }
  throw new OntologyError('This is neither an Ontology Graph Spec v1 document (`$schema`, `nodes`) nor a create-context-graph ' +
    'domain file (`domain`, `entity_types`).');
}

/** The first problems of a document that failed its checks, as one message. @param {{stage: string|null, errors: any[]}} v */
function invalidMessage(v) {
  const n = v.errors.length;
  const what = v.stage === 'schema' ? 'does not follow the Ontology Graph Spec v1 schema' : 'breaks the rules this page needs';
  const shown = v.errors.slice(0, 5).map((e) => `${e.path || '(the document)'}: ${e.message}`).join('; ');
  return `This document ${what} (${n} problem${n === 1 ? '' : 's'}): ${shown}${n > 5 ? '; …' : ''}`;
}

/**
 * Parse and validate an ontology: a v1 document, or a create-context-graph file, converted (see the
 * header). Throws OntologyError with a plain-English reason (and .errors, with paths, for a v1
 * document that fails its checks; .legacyFormat for edgextract's ontology YAML, no longer read).
 * @param {string} text  YAML or JSON
 * @param {{bases?: Object<string, string>}} [opts]  bases: create-context-graph base ontologies by name, as a domain
 *   file's `inherits` names them ({_base: <the text of data/ontologies/ccg/_base.yaml>}); only a converted file needs one
 * @returns {Ontology}
 */
export function parseOntology(text, { bases = {} } = {}) {
  if (typeof text !== 'string') throw new TypeError('parseOntology: text must be a string');
  const data = loadText(text, /^\s*\{/.test(text) ? 'The JSON' : 'The YAML');
  const input = inputOf(data);
  if (input === 'ontology-graph-spec') return fromDocument(data);
  const c = fromCreateContextGraph(text, { bases: bases ?? {} });
  return fromDocument(c.doc, { convertedFrom: 'create-context-graph', sourceSha: ontologySha(text, c.inherits, c.baseText), report: c.report });
}

/**
 * The stored ontology (readOntology's row) parsed again: its v1 document, or, in a store an
 * earlier build wrote, its YAML (with the base it was stored with), converted. A v1 document an
 * earlier build converted from edgextract's YAML (converted_from 'edgextract') is read as any v1
 * document is ('generic'). A store whose YAML is edgextract's (written before the v1 documents) is
 * refused: an OntologyError marked legacyFormat, which the worker turns into the earlier-build banner.
 * @param {{doc?: string|null, converted_from?: string|null, source_sha?: string|null, yaml?: string|null,
 *   inherits?: string|null, base_yaml?: string|null}} row
 * @returns {Ontology}
 */
export function ontologyFromStored(row) {
  if (typeof row.doc === 'string') {
    let doc;
    try {
      doc = JSON.parse(row.doc);
    } catch (e) {
      throw new OntologyError(`the stored ontology document is not JSON (${String(/** @type {any} */ (e)?.message ?? e)})`);
    }
    const from = row.converted_from === 'create-context-graph' || row.converted_from === LEGACY_FORMAT ? row.converted_from : null;
    return fromDocument(doc, { convertedFrom: from, sourceSha: row.source_sha ?? null });
  }
  if (typeof row.yaml === 'string') {
    const bases = row.inherits ? { [row.inherits]: row.base_yaml ?? '' } : {};
    try {
      return parseOntology(row.yaml, { bases });
    } catch (e) {
      if (!(e instanceof OntologyError) || /** @type {any} */ (e).legacyFormat !== LEGACY_FORMAT) throw e;
      const r = new OntologyError('this store was written by an earlier build of this page for an ontology in edgextract\'s format, ' +
        'which this build no longer reads; delete it to free its space, or open another store');
      /** @type {any} */ (r).legacyFormat = LEGACY_FORMAT;
      throw r;
    }
  }
  throw new OntologyError('this store holds no ontology document');
}

/** The checks every document shares once kinds and links are known: phrases, the pair budget, choices per pair. */
function finish(kindIds, relations) {
  const byPhrase = new Map();
  for (const r of relations) {
    r.phrase = relationPhrase(r.id);
    const other = byPhrase.get(r.phrase);
    if (other) {
      throw new OntologyError(`The links ${other} and ${r.id} both read as "${r.phrase}" to the model. Rename one of them.`);
    }
    byPhrase.set(r.phrase, r.id);
  }
  /** @type {Array<[string, string, string]>} */
  const pairs = [];
  for (const src of kindIds) {
    for (const tgt of kindIds) {
      const rels = allowed(relations, src, tgt);
      if (rels.length + 1 > MAX_CHOICE_OPTIONS) {
        throw new OntologyError(`The pair ${src} → ${tgt} has ${rels.length + 1} options, above the limit of ` +
          `${MAX_CHOICE_OPTIONS} for one question. Split a relation.`);
      }
      for (const rel of rels) pairs.push([src, rel, tgt]);
    }
  }
  return pairs;
}

/**
 * The ontology a v1 document defines (see the header): checked (ogs.js validateDocument, then the
 * kind and pair limits), with kinds, links, asks, the gazetteer and the tools.
 * @param {any} input  the document
 * @param {{convertedFrom?: 'create-context-graph'|'edgextract'|null, sourceSha?: string|null, report?: any}} [opts]  'edgextract'
 *   only for a document an earlier build converted (ontologyFromStored)
 * @returns {Ontology}
 */
export function fromDocument(input, { convertedFrom = null, sourceSha = null, report = null } = {}) {
  if (!isMap(input)) throw new OntologyError('An Ontology Graph Spec document is a mapping (YAML or JSON)');
  const v = validateDocument(input);
  if (!v.ok) throw new OntologyError(invalidMessage(v), v.errors);
  const doc = orderDocument(input);
  const ccg = customOf(doc.extensions, EXTENSIONS.domain).length > 0;
  const nodeEntries = Object.entries(doc.nodes ?? {});
  /** @type {Map<string, string>} node key -> identifier label */
  const labelOfKey = new Map(nodeEntries.map(([key, n]) => [key, /** @type {string} */ (nodeLabel(n))]));

  /** @type {Kind[]} */
  const types = nodeEntries.map(([key, n]) => {
    const id = /** @type {string} */ (nodeLabel(n));
    const pole = customOf(n.extensions, EXTENSIONS.pole)[0]?.definition ?? null;
    const display = isMap(n.extensions?.[EXTENSIONS.display]) ? n.extensions[EXTENSIONS.display] : {};
    return {
      id,
      key,
      description: n.description ?? (pole ? kindDescription(pole.pole_type, pole.subtype) : id),
      aliases: n.aliases ?? [],
      implied: n.labels?.implied ?? [],
      color: display.color ?? (ccg ? CCG_DEFAULT_COLOR : DEFAULT_COLOR),
      pole: pole?.pole_type ?? null,
      subtype: pole?.subtype ?? null,
      origin: /** @type {'own'|'base'} */ (pole?.origin === 'base' ? 'base' : 'own'),
      ask: null,
    };
  });
  if (types.length < MIN_TYPES || types.length > MAX_TYPES) {
    throw new OntologyError(`An ontology needs between ${MIN_TYPES} and ${MAX_TYPES} kinds of name. ` +
      `This document has ${types.length} node${types.length === 1 ? '' : 's'}. Add another node, or split a large list.`);
  }
  const kindIds = new Set(types.map((t) => t.id));

  /** @type {Map<string, Relation>} */
  const byType = new Map();
  for (const [key, r] of Object.entries(doc.relationships ?? {})) {
    const rel = byType.get(r.type) ?? {
      id: r.type, description: '', domain: [], range: [], symmetric: customOf(r.extensions, EXTENSIONS.symmetric).length > 0,
      phrase: '', pairs: [], keys: [], origin: /** @type {'own'|'base'} */ ('own'), ask: '',
    };
    if (customOf(r.extensions, EXTENSIONS.origin).some((e) => e.definition?.origin === 'base')) rel.origin = 'base';
    if (rel.description === '' && typeof r.description === 'string') rel.description = r.description;
    rel.pairs.push([/** @type {string} */ (labelOfKey.get(r.from.node)), /** @type {string} */ (labelOfKey.get(r.to.node))]);
    rel.keys.push(key);
    byType.set(r.type, rel);
  }
  const relations = [...byType.values()];
  for (const r of relations) {
    r.domain = uniq(r.pairs.map((p) => p[0]));
    r.range = uniq(r.pairs.map((p) => p[1]));
  }
  const edges = relations.reduce((n, r) => n + r.pairs.length, 0);
  if (edges > MAX_RELATION_EDGES) {
    throw new OntologyError(`This ontology allows ${edges} kind-to-kind pairs, above the limit of ` +
      `${MAX_RELATION_EDGES}. Remove some relationships.`);
  }

  /** @type {Map<string, string>} */
  const names = new Map();
  for (const e of customOf(doc.extensions, EXTENSIONS.gazetteer)) {
    for (const [name, key] of Object.entries(e.definition)) names.set(rustTrim(name), /** @type {string} */ (labelOfKey.get(key)));
  }

  const pairs = finish(kindIds, relations);
  // A generic kind is asked with the node's own description (none when the node has none).
  const ownDescription = new Map(nodeEntries.map(([, n]) => [/** @type {string} */ (nodeLabel(n)),
    typeof n.description === 'string' && n.description.trim() !== '' ? n.description.trim() : null]));
  const asks = modelAsks(types, relations, ccg ? { domainName: typeof doc.name === 'string' ? doc.name : '' } : { ownDescription });
  for (const t of types) t.ask = asks.get(t.id) ?? null;

  const domainExt = customOf(doc.extensions, EXTENSIONS.domain)[0]?.definition;
  const str = (x) => (typeof x === 'string' ? x : '');
  return {
    format: ccg ? 'create-context-graph' : 'generic',
    spec: SPEC_VERSION,
    id: doc.id,
    version: doc.version,
    title: str(doc.name),
    meta: ccg ? { name: str(doc.name), description: str(doc.description), tagline: str(domainExt?.tagline), emoji: str(domainExt?.emoji) } : null,
    convertedFrom,
    sourceSha,
    doc,
    types,
    relations,
    gazetteer: Object.fromEntries(names),
    names: [...names],
    pairs,
    tools: toolsOf(doc, labelOfKey),
    sha: sha256(toCanonicalJson(doc)),
    yaml: toYaml(doc),
    report,
  };
}

/** The document's tools, each with its element (see the header). @param {any} doc @param {Map<string, string>} labelOfKey @returns {Tool[]} */
function toolsOf(doc, labelOfKey) {
  /** @type {Tool[]} */
  const out = [];
  const take = (anchor, tools) => {
    for (const t of tools ?? []) {
      out.push({
        anchor, type: t.type, name: typeof t.name === 'string' ? t.name : '', description: typeof t.description === 'string' ? t.description : '',
        cypher: typeof t.cypher === 'string' ? t.cypher : null, url: typeof t.url === 'string' ? t.url : null,
        parameters: Array.isArray(t.parameters) ? t.parameters : [],
      });
    }
  };
  for (const [key, n] of Object.entries(doc.nodes ?? {})) take({ kind: 'node', key, label: labelOfKey.get(key) }, n.tools);
  for (const [key, r] of Object.entries(doc.relationships ?? {})) take({ kind: 'relationship', key, type: r.type }, r.tools);
  return out;
}

/**
 * A label as the text the model reads (B's measurement on create-context-graph's samples): `_` as
 * spaces, a lower case letter or digit followed by a capital split, an acronym split from the word
 * after it, then lower case. labelText('MaintenanceRecord') -> 'maintenance record';
 * labelText('ThreatActor') -> 'threat actor'; labelText('GLAccount') -> 'gl account';
 * labelText('PERSON') -> 'person'; labelText('Person') -> 'person'.
 * @param {string} id
 */
export function labelText(id) {
  return String(id)
    .replace(/_+/g, ' ')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * What the model is asked (see the header): each kind's {label, description} or nothing, and each
 * link's `ask` (set on the relations). A create-context-graph document (domainName given): a domain
 * kind's description is "<subtype> in <domain>", a base kind's none, and a base kind no link names
 * whose pole a domain kind shares is not asked. Any other (ownDescription given): each kind with its
 * node's own description, or none; every kind is asked. Refuses two kinds, or two links, that would
 * read alike to the model.
 * @param {Kind[]} kinds
 * @param {Relation[]} relations  with their pairs and phrases (finish has run)
 * @param {{domainName?: string, ownDescription?: Map<string, string|null>}} how
 * @returns {Map<string, KindAsk|null>} kind id -> its ask (null: not asked)
 */
function modelAsks(kinds, relations, { domainName, ownDescription }) {
  const ccg = typeof domainName === 'string';
  const named = new Set(relations.flatMap((r) => r.pairs.flat()));
  const ownPoles = new Set(kinds.filter((k) => k.origin === 'own').map((k) => k.pole));
  const domain = (domainName ?? '').toLowerCase();
  /** @type {Map<string, KindAsk|null>} */
  const asks = new Map();
  /** @type {Map<string, string>} model label -> kind id */
  const byLabel = new Map();
  for (const k of kinds) {
    if (ccg && k.origin === 'base' && !named.has(k.id) && ownPoles.has(k.pole)) {
      asks.set(k.id, null);
      continue;
    }
    const label = labelText(k.id);
    const other = byLabel.get(label);
    if (other !== undefined) {
      throw new OntologyError(`The entity types ${other} and ${k.id} both read as "${label}" to the model. Rename one of them.`);
    }
    byLabel.set(label, k.id);
    if (!ccg) {
      asks.set(k.id, { label, description: ownDescription?.get(k.id) ?? null });
      continue;
    }
    const sub = k.origin === 'own' && typeof k.subtype === 'string' ? humanise(k.subtype) : '';
    asks.set(k.id, { label, description: sub ? `${sub} in ${domain}` : null });
  }
  /** @type {Map<string, string>} */
  const byAsk = new Map();
  for (const r of relations) {
    r.ask = r.pairs.map(([s, t]) => `${labelText(s)} ${r.phrase} ${labelText(t)}`).join(' or ');
    const other = byAsk.get(r.ask);
    if (other !== undefined) {
      throw new OntologyError(`The relationships ${other} and ${r.id} both read as "${r.ask}" to the model. Rename one of them.`);
    }
    byAsk.set(r.ask, r.id);
  }
  return asks;
}

// ---- store names (D14) --------------------------------------------------------------------------

/**
 * The OPFS slug for an ontology id: the id itself when it is 1-56 of [A-Za-z0-9_-], else an
 * ASCII fold of it plus the first 8 hex digits of its sha256 ('ärzte' -> 'arzte-1a2b3c4d').
 * @param {string} id
 */
export function storeSlug(id) {
  const room = MAX_STORE_NAME - STORE_PREFIX.length;
  if (new RegExp(`^[A-Za-z0-9_-]{1,${room}}$`).test(id)) return id;
  const hash = sha256(id).slice(0, 8);
  const fold = id.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, room - 9).replace(/_+$/, '');
  return fold ? `${fold}-${hash}` : hash;
}

/**
 * The store an ontology lives in (D14): `ex33-kg-<slug>`, at most 64 characters of
 * [A-Za-z0-9_-]; open it as `opfs://${storeName(o)}`.
 * @param {{id: string}} ontology
 */
export function storeName(ontology) {
  return STORE_PREFIX + storeSlug(ontology.id);
}

// ---- graph type (D15) -----------------------------------------------------------------------------

/** A backticked identifier (ids are validated, so this is belt and braces). */
export function bt(id) {
  return '`' + String(id).replaceAll('`', '``') + '`';
}

/**
 * Why a link cannot be an edge type of the graph type (R16: one source and one target label per
 * relationship type, no disjunction, O5), or null when it can.
 * @param {Relation} r
 */
function untypedReason(r) {
  const d = uniq(r.pairs.map((p) => p[0]));
  const g = uniq(r.pairs.map((p) => p[1]));
  if (r.pairs.length === 0) return 'domain or range is empty: the link can never hold';
  if (r.pairs.length > 1 && r.pairs.length !== d.length * g.length) {
    return `declared for ${r.pairs.length} kind pairs (${r.pairs.map(([s, t]) => `${s} -> ${t}`).join(', ')}): ` +
      'a graph type allows one source and one target kind per relationship type (R16)';
  }
  if (d.length > 1 && g.length > 1) return `domain and range have ${d.length} and ${g.length} kinds: a graph type allows one of each per relationship type (O5)`;
  if (d.length > 1) return `domain has ${d.length} kinds (${d.join(', ')}): a graph type allows one source kind (O5)`;
  if (g.length > 1) return `range has ${g.length} kinds (${g.join(', ')}): a graph type allows one target kind (O5)`;
  if (r.symmetric && d[0] !== g[0]) return `symmetric between ${d[0]} and ${g[0]}: a graph type fixes one direction`;
  return null;
}

/**
 * The graph type an ontology derives (D15), as the body of ALTER CURRENT GRAPH TYPE SET, in
 * the layout SHOW CURRENT GRAPH TYPE prints (lib/replay.mjs renderGraphType; elements sorted
 * by label and type, code-point order). A link is typed when it has exactly one legal pair.
 * @param {Ontology} o
 * @returns {{spec: string, elements: string[], typed: string[], untyped: Array<{id: string, reason: string}>}}
 */
export function graphTypeSpec(o) {
  const nodes = o.types.map((t) => t.id).sort(cmpCodePoints)
    .map((k) => `(:${bt(k)} => {\`name\` :: STRING NOT NULL})`);
  const typed = [];
  const untyped = [];
  const edges = [];
  for (const r of o.relations) {
    const reason = untypedReason(r);
    if (reason) untyped.push({ id: r.id, reason });
    else {
      typed.push(r.id);
      const [s, t] = r.pairs[0];
      edges.push([r.id, `(:${bt(s)} =>)-[:${bt(r.id)} =>]->(:${bt(t)} =>)`]);
    }
  }
  edges.sort((a, b) => cmpCodePoints(a[0], b[0]));
  const elements = [...nodes, ...edges.map((e) => e[1])];
  return { spec: renderGraphType(elements), elements, typed, untyped };
}

// ---- the ontology layer (D8, D15) ------------------------------------------------------------------

/** [label, property, index name, constraint name] of every lookup key in the ontology layer. The
 * index names are historical: each constraint's own backing RANGE index (named after the
 * constraint) serves the lookups (R9), so no standalone index is created. */
export const ONTOLOGY_KEYS = Object.freeze([
  ['_Ontology', 'id', 'ontology_id', 'ontology_id_unique'],
  ['_Kind', 'key', 'kind_key', 'kind_key_unique'],
  ['_LinkType', 'key', 'linktype_key', 'linktype_key_unique'],
  ['_Alias', 'name', 'alias_name', 'alias_name_unique'],
]);

/** The UNIQUE constraints; run after every ALTER CURRENT GRAPH TYPE SET too (R16). */
export const ONTOLOGY_CONSTRAINTS = Object.freeze(ONTOLOGY_KEYS.map(([label, prop, , constraint]) =>
  `CREATE CONSTRAINT ${constraint} IF NOT EXISTS FOR (n:${label}) REQUIRE n.${prop} IS UNIQUE`));

/** The parameterised writes, in order; the Ontology's sha is written last, as a commit marker (D9). */
const WRITES = {
  ontology: 'WITH $id AS oid WHERE oid IS NOT NULL MERGE (o:_Ontology {id: oid}) RETURN count(o) AS n',
  kinds: `UNWIND $kinds AS k
WITH k WHERE k.key IS NOT NULL
MATCH (o:_Ontology {id: $id}) WHERE $id IS NOT NULL
MERGE (x:_Kind {key: k.key})
ON CREATE SET x.keep = toFloat($keep), x.drop = toFloat($drop)
SET x.id = k.id, x.description = k.description, x.color = k.color, x.aliases = k.aliases, x.pole = k.pole, x.origin = k.origin, x.ord = k.ord,
    x.implied = CASE WHEN size(k.implied) > 0 THEN k.implied END
MERGE (x)-[:_IN]->(o)
RETURN count(x) AS n`,
  links: `UNWIND $links AS r
WITH r WHERE r.key IS NOT NULL
MATCH (o:_Ontology {id: $id}) WHERE $id IS NOT NULL
MERGE (l:_LinkType {key: r.key})
ON CREATE SET l.keep = toFloat($keep), l.drop = toFloat($drop)
SET l.id = r.id, l.phrase = r.phrase, l.description = r.description, l.symmetric = r.symmetric, l.pairs = r.pairs,
    l.typed = r.typed, l.untyped_reason = r.reason, l.ord = r.ord
MERGE (l)-[:_IN]->(o)
RETURN count(l) AS n`,
  domain: `UNWIND $pairs AS p
WITH p WHERE p.link IS NOT NULL AND p.kind IS NOT NULL
MATCH (l:_LinkType {key: p.link})
MATCH (k:_Kind {key: p.kind})
MERGE (l)-[:_DOMAIN]->(k)
RETURN count(*) AS n`,
  range: `UNWIND $pairs AS p
WITH p WHERE p.link IS NOT NULL AND p.kind IS NOT NULL
MATCH (l:_LinkType {key: p.link})
MATCH (k:_Kind {key: p.kind})
MERGE (l)-[:_RANGE]->(k)
RETURN count(*) AS n`,
  staleDomain: `MATCH (o:_Ontology {id: $id})<-[:_IN]-(l:_LinkType)-[r:_DOMAIN]->(k:_Kind)
WHERE $id IS NOT NULL AND NOT (l.id + '>' + k.id) IN $pairs
DELETE r
RETURN count(*) AS n`,
  staleRange: `MATCH (o:_Ontology {id: $id})<-[:_IN]-(l:_LinkType)-[r:_RANGE]->(k:_Kind)
WHERE $id IS NOT NULL AND NOT (l.id + '>' + k.id) IN $pairs
DELETE r
RETURN count(*) AS n`,
  aliases: `UNWIND $aliases AS a
WITH a WHERE a.name IS NOT NULL AND a.kind IS NOT NULL
MATCH (k:_Kind {key: a.kind})
MERGE (x:_Alias {name: a.name})
SET x.ord = a.ord
MERGE (x)-[:_OF]->(k)
RETURN count(x) AS n`,
  staleAliasKinds: `UNWIND $aliases AS a
WITH a WHERE a.name IS NOT NULL AND a.kind IS NOT NULL
MATCH (x:_Alias {name: a.name})-[r:_OF]->(k:_Kind)
WHERE k.key <> a.kind
DELETE r
RETURN count(*) AS n`,
  staleAliases: `MATCH (x:_Alias) WHERE NOT x.name IN $names
DETACH DELETE x
RETURN count(*) AS n`,
  staleKinds: `MATCH (o:_Ontology {id: $id})<-[:_IN]-(x:_Kind) WHERE $id IS NOT NULL AND NOT x.key IN $keys
DETACH DELETE x
RETURN count(*) AS n`,
  staleLinks: `MATCH (o:_Ontology {id: $id})<-[:_IN]-(x:_LinkType) WHERE $id IS NOT NULL AND NOT x.key IN $keys
DETACH DELETE x
RETURN count(*) AS n`,
  // converted_from and source_sha are null for a document that came as v1 (the SET removes them): the
  // only nulls this module passes, guarded by $id on the parameter side (R3). An earlier build's
  // yaml, inherits and base_yaml go: the document replaces them.
  commit: `MATCH (o:_Ontology {id: $id}) WHERE $id IS NOT NULL
SET o.version = $version, o.title = $title, o.format = $format, o.spec = $spec, o.doc = $doc,
    o.converted_from = $converted_from, o.source_sha = $source_sha, o.graph_type = $graph_type,
    o.yaml = null, o.inherits = null, o.base_yaml = null, o.sha = $sha
RETURN o.sha AS sha`,
};
/** Steps whose parameters may be null on purpose (relate_wasm.exec refuses a null parameter otherwise, R3). */
const NULLABLE_STEPS = new Set(['commit']);

/** A Kind's or LinkType's key: '<ontology id>:<ID>' (ids never hold ':'). */
export const kindKey = (o, kind) => `${o.id}:${kind}`;
export const linkKey = (o, rel) => `${o.id}:${rel}`;

/**
 * @typedef {{step: string, text: string, params: Object<string, any>|null, allowNull?: boolean}} Statement
 */

/**
 * The Cypher that keeps an ontology in the store: indexes (before the ALTER), constraints (after
 * it) and the parameterised writes of the D8 layer, all idempotent. No value is spliced into the
 * text; labels and types are fixed.
 * @param {Ontology} o
 * @param {{keep?: number, drop?: number}} [cutoffs]  for Kinds and LinkTypes created now
 * @returns {{indexes: Statement[], constraints: Statement[], writes: Statement[], graphType: ReturnType<typeof graphTypeSpec>}}
 */
export function ontologyStatements(o, { keep = DEFAULT_CUTOFFS.keep, drop = DEFAULT_CUTOFFS.drop } = {}) {
  const gt = graphTypeSpec(o);
  const reasons = new Map(gt.untyped.map((u) => [u.id, u.reason]));
  const kinds = o.types.map((t, ord) => ({
    key: kindKey(o, t.id), id: t.id, description: t.description, color: t.color, aliases: t.aliases, implied: t.implied ?? [],
    pole: t.pole ?? null, origin: t.origin ?? 'own', ord,
  }));
  const links = o.relations.map((r, ord) => ({
    key: linkKey(o, r.id), id: r.id, phrase: r.phrase, description: r.description, symmetric: r.symmetric,
    pairs: r.pairs.map(([s, t]) => `${s}|${t}`), typed: !reasons.has(r.id), reason: reasons.get(r.id) ?? null, ord,
  }));
  const side = (which) => o.relations.flatMap((r) => uniq(r[which]).map((k) => ({ link: linkKey(o, r.id), kind: kindKey(o, k), ids: `${r.id}>${k}` })));
  const domain = side('domain');
  const range = side('range');
  const aliases = o.names.map(([name, kind], ord) => ({ name, kind: kindKey(o, kind), ord }));
  const id = o.id;
  const w = (step, params) => ({ step, text: WRITES[step], params, allowNull: NULLABLE_STEPS.has(step) });
  const strip = (rows) => rows.map(({ link, kind }) => ({ link, kind }));
  return {
    constraints: ONTOLOGY_CONSTRAINTS.map((text) => ({ step: 'constraint', text, params: null })),
    writes: [
      w('ontology', { id }),
      w('kinds', { id, kinds, keep, drop }),
      w('links', { id, links, keep, drop }),
      w('domain', { pairs: strip(domain) }),
      w('range', { pairs: strip(range) }),
      w('staleDomain', { id, pairs: domain.map((p) => p.ids) }),
      w('staleRange', { id, pairs: range.map((p) => p.ids) }),
      w('aliases', { aliases }),
      w('staleAliasKinds', { aliases }),
      w('staleAliases', { names: aliases.map((a) => a.name) }),
      w('staleKinds', { id, keys: kinds.map((k) => k.key) }),
      w('staleLinks', { id, keys: links.map((l) => l.key) }),
      w('commit', {
        id, version: o.version, title: o.title, format: o.format, spec: o.spec, doc: toCanonicalJson(o.doc),
        converted_from: o.convertedFrom, source_sha: o.sourceSha, graph_type: gt.spec, sha: o.sha,
      }),
    ],
    graphType: gt,
  };
}

/**
 * The graph type's elements as the store has them now (CONSTRAINT entries left out), rendered.
 * @param {object} db  a RelateDb
 * @param {typeof import('../../../lib/relate_wasm.mjs')} cl
 */
export function currentGraphType(db, cl) {
  const { rows } = cl.exec(db, 'SHOW CURRENT GRAPH TYPE YIELD specification RETURN specification');
  return renderGraphType(splitGraphType(rows[0]?.specification ?? '{}').elements);
}

/**
 * The ontology a store holds, or null: {id, version, title, format, spec, doc, sha, converted_from,
 * source_sha, graph_type}, and, from a store an earlier build wrote, {yaml, inherits, base_yaml} in
 * place of spec, doc, converted_from and source_sha. sha is null while an apply is unfinished (it is
 * written last). ontologyFromStored() parses it again.
 * @param {object} db
 * @param {typeof import('../../../lib/relate_wasm.mjs')} cl
 */
export function readOntology(db, cl) {
  const { rows } = cl.exec(db, 'MATCH (o:_Ontology) RETURN o.id AS id, o.version AS version, o.title AS title, ' +
    'o.format AS format, o.spec AS spec, o.doc AS doc, o.sha AS sha, o.converted_from AS converted_from, ' +
    'o.source_sha AS source_sha, o.graph_type AS graph_type, o.yaml AS yaml, o.inherits AS inherits, o.base_yaml AS base_yaml ORDER BY id');
  if (rows.length > 1) throw new OntologyApplyError('other-ontology', `this store holds ${rows.length} ontologies (${rows.map((r) => r.id).join(', ')}); D14 keeps one per store`);
  return rows[0] ?? null;
}

/**
 * Keep `o` in the store: create the lookup indexes, ALTER the graph type when its elements
 * change (then re-create the UNIQUE constraints the ALTER dropped, R16), check the graph type
 * reads back, and write the D8 layer with the Ontology's sha last. Idempotent: applying the
 * same ontology again changes nothing and does not ALTER.
 *
 * Throws OntologyApplyError: 'blocked' when existing data violates the new graph type (O5;
 * the old type stays, nothing of the layer is written), 'other-ontology', 'mismatch', 'refused'.
 * After altered: true, every UNIQUE constraint outside this module is gone (R16): re-create it.
 * @param {object} db  a writable RelateDb
 * @param {Ontology} o
 * @param {typeof import('../../../lib/relate_wasm.mjs')} cl
 * @param {{keep?: number, drop?: number}} [cutoffs]
 * @returns {{id: string, sha: string, previousSha: string|null, altered: boolean, spec: string,
 *   typed: string[], untyped: Array<{id: string, reason: string}>}}
 */
export function applyOntology(db, o, cl, cutoffs = {}) {
  const st = ontologyStatements(o, cutoffs);
  const engine = (e, what) => {
    if (e instanceof cl.RelateWasmError) return new OntologyApplyError('refused', `${what}: ${e.message}`, { detail: e.detail });
    return e;
  };
  const before = readOntology(db, cl);
  if (before && before.id !== o.id) {
    throw new OntologyApplyError('other-ontology', `this store holds the ontology ${JSON.stringify(before.id)}, ` +
      `not ${JSON.stringify(o.id)}; each ontology has its own store (D14): open ${storeName(o)}`);
  }
  const current = currentGraphType(db, cl);
  const want = st.graphType.spec;
  let altered = false;
  if (current !== want) {
    try {
      cl.exec(db, `ALTER CURRENT GRAPH TYPE SET ${want}`);
      altered = true;
    } catch (e) {
      // A refused ALTER keeps the old graph type (O5); put back whatever constraints went (R16).
      for (const s of st.constraints) cl.exec(db, s.text);
      if (e instanceof cl.RelateWasmError && e.category === 'constraint') {
        throw new OntologyApplyError('blocked', 'the data in this store breaks the new graph type ' +
          `(${e.message.replace(/^.*?(?=ConstraintValidationFailed)/, '')}); rebuild the graph to apply it (D14)`, { detail: e.detail, current });
      }
      throw engine(e, 'ALTER CURRENT GRAPH TYPE');
    }
  }
  for (const s of st.constraints) {
    try { cl.exec(db, s.text); } catch (e) { throw engine(e, 'creating a UNIQUE constraint'); }
  }
  const got = currentGraphType(db, cl);
  if (got !== want) {
    throw new OntologyApplyError('mismatch', 'SHOW CURRENT GRAPH TYPE does not read back the derived graph type',
      { detail: `want ${want}\ngot ${got}`, current: got });
  }
  for (const s of st.writes) {
    try {
      cl.exec(db, s.text, s.params, s.allowNull ? { allowNull: true } : undefined);
    } catch (e) { throw engine(e, `writing the ontology (${s.step})`); }
  }
  return {
    id: o.id, sha: o.sha, previousSha: before?.sha ?? null, altered, spec: want,
    typed: st.graphType.typed, untyped: st.graphType.untyped,
  };
}

/**
 * D15's canary: the db.ontology.* procedures the engine has (O1, R17). They are document storage
 * for an ontology behind the RELATE_PREVIEW=ontology preview gate, which SHOW PROCEDURES respects,
 * and the WASM build reads no environment, so here they stay hidden and every call is refused by
 * the gate. Rows are the signal that the ontology document could move into them.
 * @param {object} db
 * @param {typeof import('../../../lib/relate_wasm.mjs')} cl
 * @returns {{procedures: string[]}}
 */
export function ontologyCanary(db, cl) {
  const { rows } = cl.exec(db, "SHOW PROCEDURES YIELD name WHERE name STARTS WITH 'db.ontology.' RETURN name ORDER BY name");
  return { procedures: rows.map((r) => r.name) };
}
