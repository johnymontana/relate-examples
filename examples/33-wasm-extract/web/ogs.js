// @ts-check
/**
 * ogs.js: the Ontology Graph Specification v1 (neo4j/graph-spec, branch
 * oskar/ontology-spec-v1-jsonschema at 35e74c0, Apache-2.0; vendored in data/ontology-spec/): a
 * document read from YAML or JSON, checked against the spec's JSON Schema and against the rules
 * this example needs, and written back out in one canonical form. The ontology format every other
 * module of the example reads (ontology.js builds its kinds and links from a v1 document; convert.js
 * turns create-context-graph's domain files into one).
 *
 * Shared by the engine worker, the page and the Node harness: no Node-only import. It imports
 * js-yaml by its bare name (build.mjs and harness/serve.mjs rewrite the specifier for the page) and
 * names.js (rustTrim).
 *
 *   const doc = parseDocument(text);           // YAML or JSON -> a plain object (OntologyError on a syntax error)
 *   validateSchema(doc);                       // [{path, keyword, message}]: the JSON Schema, as ajv reports it
 *   checkDocument(doc);                        // [{path, keyword: 'semantic', message}]: the rules below
 *   validateDocument(doc);                     // {ok, errors}: the schema first, then (when it holds) the rules
 *   toYaml(doc); toCanonicalJson(doc);         // the two serialisations (below)
 *
 * The schema check (validateSchema) is a small interpreter of exactly the JSON Schema 2020-12
 * keywords the spec's schema uses: $ref (to #/$defs/…), type, required, properties,
 * additionalProperties (false, true or a schema), propertyNames (minLength), items, minItems,
 * minimum, pattern (a `u` regular expression), enum, minLength, boolean schemas, and format as a
 * light check: `uri` is ajv-formats' fast form (a scheme, then no whitespace) and `regex` is
 * ajv-formats' check (a JavaScript regular expression, no \Z). Annotations ($id, $schema, title,
 * description) are ignored. Errors carry ajv's instancePath and keyword, so harness/ontology.mjs
 * compares the two validators error for error, on every bundled document and on tampered ones.
 * SCHEMA below is the vendored file's content; the harness pins that they are equal.
 *
 * The rules (checkDocument), run on a document the schema accepts. The spec's own, which its
 * schema cannot say: `$schema` names version 1.0.0 (this file's SCHEMA_ID); every node has a label
 * (`label`, or `labels.identifier`; both only when they agree); an endpoint names a node of the
 * document; a constraint's properties are declared on the same element (graph-spec's ADR-0010); `dimension`
 * goes with a VECTOR<…> type; `key` is not combined with `mustExist: false` or `unique: false`;
 * `count` is not combined with `min_count` or `max_count`, and `min_count` is at most `max_count`.
 * And this example's: every identifier label and implied or optional label, and every relationship
 * type, follows the id rule (isOntologyId: they become labels and relationship types in
 * Relate); one identifier label per node; one entry per (type, from, to); a node's implied and
 * optional labels differ from each other and from its identifier; the extensions this example reads
 * have the shape it reads (createContextGraph:pole, createContextGraph:origin,
 * createContextGraph:domain, edgextract:gazetteer, edgextract:symmetric, neo4j:display's color),
 * and a document with createContextGraph:domain gives every node a createContextGraph:pole; a
 * canonicalQuery tool's cypher, when it has one, is text, a tool's parameters are a list of
 * {name, ...}, and a node's or relationship's tools have distinct names.
 *
 * Serialisations. The spec has one wire format (absent means none: empty maps and lists are
 * never written). toYaml writes the document with each object's fields in the order the spec's
 * schema lists them, and the entries of `nodes`, `relationships` and each `properties` map in the
 * document's order; it is what data/ontologies/ogs/ holds and what the page's editor shows.
 * toCanonicalJson writes compact JSON with the keys of every spec-defined object sorted by code
 * point, except two things kept as they are: the order of the maps keyed by the document's own
 * names (`nodes`, `relationships`, `properties`), because this example asks the model about kinds
 * and links in that order (the order is part of every inference cache key, D7), and the content of
 * extension payloads and tools' owner-defined fields, which the spec says are carried untouched.
 * It is what the store keeps and what the ontology's sha256 is taken over.
 */
import yaml from 'js-yaml';
import { rustTrim } from './names.js';

/** The spec version this module reads. */
export const SPEC_VERSION = '1.0.0';
/** The schema's $id, which a v1 document's `$schema` names. */
export const SCHEMA_ID = 'https://neo4j.com/ontology-graph-spec/1.0.0/schema.json';

/** An ontology the rules refuse; the message is meant for the person who wrote it. errors: [{path, keyword, message}] when a v1 document failed its checks. */
export class OntologyError extends Error {
  /** @param {string} message @param {Array<{path: string, keyword: string, message: string}>} [errors] */
  constructor(message, errors = []) {
    super(message);
    this.name = 'OntologyError';
    this.errors = errors;
  }
}

// ---- the id rule (D8): one rule for every ontology id that becomes a label or a type ---------------

/** The longest kind or link id, in code points: ids become labels and relationship types. */
export const MAX_ID_CHARS = 64;
/**
 * Every label and relationship type starting with this is the example's own (store.js and the
 * ontology layer): an ontology id may not start with it (isOntologyId).
 */
export const RESERVED_PREFIX = '_';
/** A letter, digit or `_` first, then letters with their combining marks (Devanagari vowel signs and viramas, accents with no precomposed form), digits and `_`. */
const ID_CHARS = /^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*$/u;
const HAS_ALNUM = /[\p{L}\p{N}]/u;
const ID_RULE = `Ids hold letters (with their combining marks), digits and _ only, at most ${MAX_ID_CHARS} characters ` +
  '(any script; spaces become _; no emoji, - or :).';

/**
 * The id rule (D8), shared by every format and by web/store.js (ident): NFC, a letter, digit or `_`
 * first, then letters, combining marks, digits and `_`, at least one letter or digit, at most
 * MAX_ID_CHARS code points, and no leading `_` (RESERVED_PREFIX: the example's own labels and types).
 * Relate takes every such id as a label, a dynamic label, a relationship type and in a graph type
 * (harness/ontology.mjs pins a marked id end to end), and refuses emoji (probes.txt, NOTES.md R6).
 * @param {unknown} id
 * @returns {boolean}
 */
export function isOntologyId(id) {
  return typeof id === 'string' && ID_CHARS.test(id) && HAS_ALNUM.test(id) && !id.startsWith(RESERVED_PREFIX) &&
    id === id.normalize('NFC') && [...id].length <= MAX_ID_CHARS;
}

/** Why `id` breaks the id rule (a message for the ontology's author), or null. @param {string} what @param {string} id */
export function idProblem(what, id) {
  if (!ID_CHARS.test(id) || !HAS_ALNUM.test(id)) return `bad ${what} id: ${id}. ${ID_RULE}`;
  if (id.startsWith(RESERVED_PREFIX)) {
    return `bad ${what} id: ${id}. Ids that start with ${RESERVED_PREFIX} are kept for this example's own labels and ` +
      'relationship types (_Entity, _Claim, _Document, _IN, _OF, ...). Rename it.';
  }
  if (id !== id.normalize('NFC')) return `bad ${what} id: ${id}. It is not in Unicode NFC form; type it composed.`;
  const n = [...id].length;
  if (n > MAX_ID_CHARS) {
    const shown = n > 40 ? `${[...id].slice(0, 32).join('')}…` : id;
    return `The ${what} id ${shown} is ${n} characters long; ids become labels and relationship types, ` +
      `so they hold at most ${MAX_ID_CHARS}. Shorten it.`;
  }
  return null;
}

// ---- small helpers ---------------------------------------------------------------------------------

/** A plain mapping (not a list, null or a date). @param {unknown} v @returns {v is Record<string, any>} */
export const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
/** Set an own property, `__proto__` included (a name in a gazetteer, a property name). */
export function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  return obj;
}
/** Code-point order (Rust's str Ord), not UTF-16 order. @param {string} a @param {string} b */
export function cmpCodePoints(a, b) {
  const x = Array.from(a, (c) => /** @type {number} */ (c.codePointAt(0)));
  const y = Array.from(b, (c) => /** @type {number} */ (c.codePointAt(0)));
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
/** A JSON Pointer token (RFC 6901), as ajv writes instancePath. @param {string|number} k */
const ptr = (k) => `/${String(k).replaceAll('~', '~0').replaceAll('/', '~1')}`;
const show = (v) => (v === undefined ? 'nothing' : JSON.stringify(v));

/**
 * A YAML or JSON text as a value, in YAML's core schema (JSON is YAML; no dates, no merge keys),
 * one document only. Throws OntologyError with the line and column of a syntax error.
 * @param {string} text  @param {string} [what]  how the message names the text
 */
export function loadText(text, what = 'The YAML') {
  try {
    return yaml.load(text, { schema: yaml.CORE_SCHEMA });
  } catch (e) {
    const err = /** @type {any} */ (e);
    const where = err?.mark ? ` (line ${err.mark.line + 1}, column ${err.mark.column + 1})` : '';
    throw new OntologyError(`${what} does not parse: ${err?.reason ?? String(err?.message ?? err).split('\n')[0]}${where}`);
  }
}

/**
 * A v1 document's text (YAML or JSON) as a value. It is not checked here: validateDocument does that.
 * @param {string} text
 */
export function parseDocument(text) {
  if (typeof text !== 'string') throw new TypeError('parseDocument: text must be a string');
  return loadText(text, /^\s*[{[]/.test(text) ? 'The JSON' : 'The YAML');
}

// ---- the schema (data/ontology-spec/ontology-graph-spec.schema.json, verbatim) ----------------------

/** The spec's JSON Schema (draft 2020-12), as vendored; harness/ontology.mjs pins it equal to the file. */
export const SCHEMA = deepFreeze(/*@ogs:schema*/{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://neo4j.com/ontology-graph-spec/1.0.0/schema.json",
  "title": "Neo4j Ontology Graph Specification v1",
  "description": "Draft JSON Schema for the Ontology Graph spec v1 proposal (2026-09-25 doc state, working-session revision). Nodes and relationships are keyed by local ids; the label/type lives inside the entry. Types are tokens. Tools are core. Extensions ride the named extensions map: first-party keys, custom envelope under custom; extension payloads are never validated by this schema.",
  "type": "object",
  "required": ["$schema", "id", "version"],
  "additionalProperties": false,
  "properties": {
    "$schema": {
      "type": "string",
      "format": "uri",
      "description": "Spec link including the version. Meta-level; doubles as document-type marker."
    },
    "id": {
      "type": "string",
      "description": "Unique identifier of the ontology."
    },
    "version": {
      "type": "integer",
      "minimum": 0,
      "description": "The ontology's own version. Identity metadata, not lifecycle."
    },
    "name": { "type": "string" },
    "description": { "type": "string" },
    "nodes": {
      "type": "object",
      "description": "Map key is the identifier within the document, not the label. The label lives in label / labels.identifier, so label renames do not break references.",
      "additionalProperties": { "$ref": "#/$defs/node" }
    },
    "relationships": {
      "type": "object",
      "description": "Map key is the intra-document identifier; the relationship type lives in the type field. Several keys may share a type across different endpoint pairs, but note graph-type enforcement keys on the type alone and cannot distinguish pairs yet.",
      "additionalProperties": { "$ref": "#/$defs/relationshipEntry" }
    },
    "extensions": { "$ref": "#/$defs/extensionsMap" }
  },
  "$defs": {
    "propertyType": {
      "type": "string",
      "description": "Type token: a Neo4j scalar, ANY, LIST<...> or VECTOR<...> (a VECTOR may carry a companion dimension field on the property). Element types are always scalars: no nested lists, no lists of vectors. No union types in v1: a property is a single type or ANY.",
      "pattern": "^(ANY|LIST<ANY>|(STRING|INTEGER|FLOAT|BOOLEAN|DATE|TIME|LOCALTIME|DATETIME|LOCALDATETIME|DURATION|POINT|BYTES)|(LIST|VECTOR)<(STRING|INTEGER|FLOAT|BOOLEAN|DATE|TIME|LOCALTIME|DATETIME|LOCALDATETIME|DURATION|POINT|BYTES)>)$"
    },
    "labels": {
      "type": "object",
      "required": ["identifier"],
      "additionalProperties": false,
      "properties": {
        "identifier": { "type": "string", "description": "The identifying (main) label." },
        "implied": { "type": "array", "items": { "type": "string" } },
        "optional": { "type": "array", "items": { "type": "string" } }
      }
    },
    "constraint": {
      "description": "Constraint object form (the alternative to the mustExist/unique/key shorthand flags). Nameable, so tooling can reference individual constraints.",
      "type": "object",
      "required": ["constraint_type", "properties"],
      "additionalProperties": false,
      "properties": {
        "constraint_type": { "type": "string", "enum": ["key", "unique", "mustExist"] },
        "name": { "type": "string" },
        "properties": {
          "type": "array",
          "items": { "type": "string" },
          "minItems": 1
        }
      }
    },
    "property": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "type": { "$ref": "#/$defs/propertyType" },
        "dimension": {
          "type": "integer",
          "minimum": 1,
          "description": "VECTOR companion: element count. Absent = unconstrained."
        },
        "mustExist": { "type": "boolean" },
        "unique": { "type": "boolean" },
        "key": { "type": "boolean" },
        "one_of": {
          "type": "array",
          "description": "Allowed values. JSON Schema's word. Default value support."
        },
        "pattern": { "type": "string", "format": "regex" },
        "description": { "type": "string" },
        "aliases": { "type": "array", "items": { "type": "string" } },
        "reference": { "$ref": "#/$defs/reference" },
        "extensions": { "$ref": "#/$defs/extensionsMap" }
      }
    },
    "endpoint": {
      "type": "object",
      "required": ["node"],
      "additionalProperties": false,
      "description": "Endpoint cardinality: count is the exact form, min_count/max_count the ranged form; absent means unconstrained (0..*). Counts on to constrain relationships per from-instance; counts on from constrain per to-instance.",
      "properties": {
        "node": { "type": "string", "description": "A node id from the nodes map." },
        "count": { "type": "integer", "minimum": 0 },
        "min_count": { "type": "integer", "minimum": 0 },
        "max_count": { "type": "integer", "minimum": 1 }
      }
    },
    "reference": {
      "type": "string",
      "format": "uri",
      "description": "A single informational URI pointing at an external definition of this element (e.g. the original RDF resource)."
    },
    "tool": {
      "type": "object",
      "required": ["type"],
      "description": "Core tool definition for agents: type discriminates (canonicalQuery, externalRequest, ...), name and description are the readable surface; remaining fields are defined per tool type by its owner (cypher, url, ...). Definitions only, no behaviour.",
      "properties": {
        "type": { "type": "string" },
        "name": { "type": "string" },
        "description": { "type": "string" }
      },
      "additionalProperties": true
    },
    "extension": {
      "description": "Custom extension envelope, four fields: type required; $schema, name, definition optional. definition is free-form and never validated by this spec. Unknown extra fields are carried untouched.",
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": { "type": "string" },
        "$schema": { "type": "string", "format": "uri" },
        "name": { "type": "string" },
        "definition": true
      }
    },
    "extensionsMap": {
      "type": "object",
      "description": "Named extensions: first-party extensions as keys (neo4j:*), each shape defined by its owner, available in the ontology graph spec SDK, not validated by this spec. Custom extensions ride the fixed envelope under the reserved custom key.",
      "properties": {
        "custom": {
          "type": "array",
          "items": { "$ref": "#/$defs/extension" }
        }
      },
      "additionalProperties": true
    },
    "node": {
      "type": "object",
      "additionalProperties": false,
      "description": "Every node carries its label in label (shorthand for an identifier-only labels) or labels.identifier (when implied/optional labels exist). Not schema-enforced; a node with neither is meaningless.",
      "properties": {
        "label": { "type": "string", "description": "Shorthand for labels.identifier when no implied/optional labels exist." },
        "labels": { "$ref": "#/$defs/labels" },
        "description": { "type": "string" },
        "aliases": { "type": "array", "items": { "type": "string" } },
        "reference": { "$ref": "#/$defs/reference" },
        "properties": {
          "type": "object",
          "propertyNames": {
            "minLength": 1,
            "description": "Property names are non-empty (ADR-0010): the map key is the property's addressable name, the string constraint objects and extensions reference."
          },
          "additionalProperties": { "$ref": "#/$defs/property" }
        },
        "constraints": {
          "type": "array",
          "items": { "$ref": "#/$defs/constraint" }
        },
        "tools": {
          "type": "array",
          "items": { "$ref": "#/$defs/tool" }
        },
        "extensions": { "$ref": "#/$defs/extensionsMap" }
      }
    },
    "relationshipEntry": {
      "type": "object",
      "required": ["type", "from", "to"],
      "additionalProperties": false,
      "properties": {
        "type": { "type": "string", "description": "The relationship type. One-to-one with the map key in the common case; several keys may share a type across different endpoint pairs." },
        "from": { "$ref": "#/$defs/endpoint" },
        "to": { "$ref": "#/$defs/endpoint" },
        "description": { "type": "string" },
        "aliases": { "type": "array", "items": { "type": "string" } },
        "reference": { "$ref": "#/$defs/reference" },
        "properties": {
          "type": "object",
          "propertyNames": {
            "minLength": 1,
            "description": "Property names are non-empty (ADR-0010): the map key is the property's addressable name, the string constraint objects and extensions reference."
          },
          "additionalProperties": { "$ref": "#/$defs/property" }
        },
        "constraints": {
          "type": "array",
          "items": { "$ref": "#/$defs/constraint" }
        },
        "tools": {
          "type": "array",
          "items": { "$ref": "#/$defs/tool" }
        },
        "extensions": { "$ref": "#/$defs/extensionsMap" }
      }
    }
  }
}/*@ogs:schema-end*/);

/** @template T @param {T} v @returns {T} */
function deepFreeze(v) {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

// ---- the schema check ---------------------------------------------------------------------------------

/** ajv-formats' fast `uri` (formats.js fastFormats.uri at 3.0.1): a scheme, then no whitespace. */
const URI = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/)?[^\s]*$/i;
/** ajv-formats' `regex`: a JavaScript regular expression without a \Z anchor. @param {string} s */
function isRegex(s) {
  if (/[^\\]\\Z/.test(s)) return false;
  try {
    new RegExp(s); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
}
/** @type {Record<string, (s: string) => boolean>} */
const FORMATS = { uri: (s) => URI.test(s), regex: isRegex };

/** How a type error names the JSON Schema type it wanted. @type {Readonly<Record<string, string>>} */
const TYPE_WORDS = Object.freeze({ object: 'a mapping', array: 'a list', integer: 'an integer', null: 'null' });
/** A word with its indefinite article: 'an integer', 'a string'. @param {string} word */
const withArticle = (word) => `${/^[aeiou]/iu.test(word) ? 'an' : 'a'} ${word}`;

/** A JSON Schema type test as ajv makes it with strictNumbers (no NaN or Infinity). */
function hasType(type, v) {
  switch (type) {
    case 'object': return isMap(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: throw new Error(`ogs.js: the schema uses the type ${type}, which this validator does not know`);
  }
}

const KNOWN_KEYWORDS = new Set(['$schema', '$id', '$defs', '$ref', 'title', 'description', 'type', 'required', 'properties',
  'additionalProperties', 'propertyNames', 'items', 'minItems', 'minimum', 'pattern', 'enum', 'minLength', 'format']);

/**
 * The document checked against a JSON Schema (by default the spec's): every error, as ajv with
 * {allErrors: true} reports them ({path: instancePath, keyword, message}).
 * @param {unknown} doc
 * @param {any} [schema]
 * @returns {Array<{path: string, keyword: string, message: string}>}
 */
export function validateSchema(doc, schema = SCHEMA) {
  /** @type {Array<{path: string, keyword: string, message: string}>} */
  const errors = [];
  /** @param {string} ref */
  const resolve = (ref) => {
    if (!ref.startsWith('#/')) throw new Error(`ogs.js: only local $refs are supported, not ${ref}`);
    return ref.slice(2).split('/').reduce((s, k) => s?.[k.replaceAll('~1', '/').replaceAll('~0', '~')], schema);
  };
  /** @param {any} s @param {any} v @param {string} path */
  const walk = (s, v, path) => {
    if (s === true) return;
    if (s === false) { errors.push({ path, keyword: 'false schema', message: 'boolean schema is false' }); return; }
    for (const k of Object.keys(s)) if (!KNOWN_KEYWORDS.has(k)) throw new Error(`ogs.js: the schema uses ${k}, which this validator does not know`);
    if (s.$ref) walk(resolve(s.$ref), v, path);
    if (s.type !== undefined && !hasType(s.type, v)) errors.push({ path, keyword: 'type', message: `must be ${TYPE_WORDS[s.type] ?? withArticle(s.type)}, not ${show(v)}` });
    if (s.enum && !s.enum.some((x) => x === v)) errors.push({ path, keyword: 'enum', message: `must be one of ${s.enum.join(', ')}, not ${show(v)}` });
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errors.push({ path, keyword: 'minimum', message: `must be ${s.minimum} or more, not ${v}` });
    }
    if (typeof v === 'string') {
      if (s.minLength !== undefined && [...v].length < s.minLength) errors.push({ path, keyword: 'minLength', message: `must not be shorter than ${s.minLength} character${s.minLength === 1 ? '' : 's'}` });
      if (s.pattern !== undefined && !new RegExp(s.pattern, 'u').test(v)) {
        errors.push({ path, keyword: 'pattern', message: s.pattern === SCHEMA.$defs.propertyType.pattern
          ? `${show(v)} is not a type token (STRING, INTEGER, FLOAT, BOOLEAN, DATE, TIME, LOCALTIME, DATETIME, LOCALDATETIME, DURATION, POINT, BYTES, ANY, LIST<…> or VECTOR<…> of a scalar)`
          : `must match ${s.pattern}` });
      }
      if (s.format !== undefined) {
        const f = FORMATS[s.format];
        if (!f) throw new Error(`ogs.js: the schema uses the format ${s.format}, which this validator does not know`);
        if (!f(v)) errors.push({ path, keyword: 'format', message: s.format === 'uri' ? `${show(v)} is not a URI (a scheme such as https:, then no spaces)` : `${show(v)} is not a regular expression` });
      }
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errors.push({ path, keyword: 'minItems', message: `must list at least ${s.minItems} item${s.minItems === 1 ? '' : 's'}` });
      if (s.items !== undefined) v.forEach((x, i) => walk(s.items, x, path + ptr(i)));
    }
    if (isMap(v)) {
      for (const k of s.required ?? []) {
        if (!Object.hasOwn(v, k)) errors.push({ path, keyword: 'required', message: `\`${k}\` is missing` });
      }
      if (s.propertyNames !== undefined) {
        for (const k of Object.keys(v)) {
          const before = errors.length;
          walk(s.propertyNames, k, path);
          if (errors.length > before) {
            // ajv words a bad name twice: the subschema's error, then propertyNames' own.
            for (const e of errors.slice(before)) e.message = `the name ${show(k)}: ${e.message}`;
            errors.push({ path, keyword: 'propertyNames', message: `the name ${show(k)} is not a valid property name (names are non-empty, ADR-0010)` });
          }
        }
      }
      const props = s.properties ?? {};
      for (const [k, x] of Object.entries(v)) {
        if (Object.hasOwn(props, k)) walk(props[k], x, path + ptr(k));
        else if (s.additionalProperties === false) errors.push({ path, keyword: 'additionalProperties', message: `\`${k}\` is not a field here` });
        else if (s.additionalProperties !== undefined) walk(s.additionalProperties, x, path + ptr(k));
      }
    }
  };
  walk(schema, doc, '');
  return errors;
}

// ---- the rules (checkDocument) ----------------------------------------------------------------------------

/** The custom extension envelopes of one type in an `extensions` map. @param {any} ext @param {string} type */
export function customOf(ext, type) {
  return isMap(ext) && Array.isArray(ext.custom) ? ext.custom.filter((e) => isMap(e) && e.type === type) : [];
}
/** A node's identifier label (labels.identifier, else label), or null. @param {any} node */
export function nodeLabel(node) {
  if (!isMap(node)) return null;
  if (isMap(node.labels) && typeof node.labels.identifier === 'string') return node.labels.identifier;
  return typeof node.label === 'string' ? node.label : null;
}

/**
 * The extensions this example reads and the place each may sit. edgextract:gazetteer (rule 1's
 * listed names) and edgextract:symmetric keep the names edgextract gave the two features; any v1
 * document may carry them.
 */
export const EXTENSIONS = Object.freeze({
  pole: 'createContextGraph:pole',
  origin: 'createContextGraph:origin',
  domain: 'createContextGraph:domain',
  gazetteer: 'edgextract:gazetteer',
  symmetric: 'edgextract:symmetric',
  display: 'neo4j:display',
});

/**
 * The rules a schema-valid document must also follow (see the header): [{path, keyword: 'semantic', message}].
 * @param {any} doc  a document validateSchema accepted
 */
export function checkDocument(doc) {
  /** @type {Array<{path: string, keyword: string, message: string}>} */
  const errors = [];
  const err = (path, message) => errors.push({ path, keyword: 'semantic', message });
  if (doc.$schema !== SCHEMA_ID) {
    err('/$schema', `names ${show(doc.$schema)}; this page reads version ${SPEC_VERSION} of the Ontology Graph Spec, ${SCHEMA_ID}`);
  }
  const nodes = isMap(doc.nodes) ? doc.nodes : {};
  const rels = isMap(doc.relationships) ? doc.relationships : {};
  const ccg = customOf(doc.extensions, EXTENSIONS.domain).length > 0;

  /** @type {Map<string, string>} identifier label -> node id */
  const byLabel = new Map();
  /** Properties, constraints and tools of a node or relationship entry. @param {string} at @param {any} el */
  const element = (at, el) => {
    const props = isMap(el.properties) ? el.properties : {};
    for (const [name, p] of Object.entries(props)) {
      const pp = `${at}/properties${ptr(name)}`;
      if (p.dimension !== undefined && !(typeof p.type === 'string' && p.type.startsWith('VECTOR<'))) {
        err(`${pp}/dimension`, `goes with a VECTOR<…> type, not ${show(p.type ?? null)}`);
      }
      if (p.key === true && (p.mustExist === false || p.unique === false)) {
        err(pp, 'key implies unique and mustExist; it cannot go with mustExist: false or unique: false');
      }
    }
    (el.constraints ?? []).forEach((c, i) => {
      for (const name of c.properties) {
        if (!Object.hasOwn(props, name)) err(`${at}/constraints/${i}/properties`, `${show(name)} is not a property of this element (a constraint names properties declared beside it)`);
      }
    });
    const names = new Set();
    (el.tools ?? []).forEach((t, i) => {
      if (typeof t.name === 'string') {
        if (names.has(t.name)) err(`${at}/tools/${i}/name`, `two tools here are named ${show(t.name)}`);
        names.add(t.name);
      }
      if (t.type === 'canonicalQuery' && t.cypher !== undefined && typeof t.cypher !== 'string') {
        err(`${at}/tools/${i}/cypher`, `a canonicalQuery tool's query is text, not ${show(t.cypher)}`);
      }
      if (t.parameters !== undefined && (!Array.isArray(t.parameters) || t.parameters.some((x) => !isMap(x) || typeof x.name !== 'string' || x.name === ''))) {
        err(`${at}/tools/${i}/parameters`, 'parameters are a list of {name, type?, description?, ...}, each with a name');
      }
    });
  };

  for (const [key, node] of Object.entries(nodes)) {
    const at = `/nodes${ptr(key)}`;
    const id = nodeLabel(node);
    if (id === null) {
      err(at, 'has no label: give it `label` (or `labels` with an `identifier`)');
      continue;
    }
    if (typeof node.label === 'string' && isMap(node.labels) && node.label !== node.labels.identifier) {
      err(at, `\`label\` (${node.label}) and \`labels.identifier\` (${node.labels.identifier}) disagree; keep one of them`);
    }
    const bad = idProblem('label', id);
    if (bad) err(isMap(node.labels) ? `${at}/labels/identifier` : `${at}/label`, bad);
    const other = byLabel.get(id);
    if (other !== undefined) err(at, `the label ${id} already identifies the node ${show(other)}; one node per label`);
    else byLabel.set(id, key);
    if (isMap(node.labels)) {
      const seen = new Set([id]);
      for (const which of /** @type {const} */ (['implied', 'optional'])) {
        (node.labels[which] ?? []).forEach((l, i) => {
          const p = `${at}/labels/${which}/${i}`;
          const b = idProblem('label', l);
          if (b) err(p, b);
          else if (seen.has(l)) err(p, `the label ${l} is listed twice on this node`);
          seen.add(l);
        });
      }
    }
    element(at, node);
    const poles = customOf(node.extensions, EXTENSIONS.pole);
    if (poles.length > 1) err(`${at}/extensions/custom`, `more than one ${EXTENSIONS.pole}`);
    for (const e of poles) {
      const d = e.definition;
      if (!isMap(d) || typeof d.pole_type !== 'string' || d.pole_type.trim() === '' ||
        (d.subtype !== undefined && d.subtype !== null && typeof d.subtype !== 'string') ||
        (d.origin !== undefined && d.origin !== 'base' && d.origin !== 'domain')) {
        err(`${at}/extensions/custom`, `${EXTENSIONS.pole}'s definition is {pole_type, subtype?, origin?: base|domain}, not ${show(d)}`);
      }
    }
    if (ccg && poles.length === 0) err(at, `a create-context-graph document (${EXTENSIONS.domain}) gives every node a ${EXTENSIONS.pole} extension`);
    const display = isMap(node.extensions) ? node.extensions[EXTENSIONS.display] : undefined;
    if (display !== undefined && (!isMap(display) || (display.color !== undefined && typeof display.color !== 'string'))) {
      err(`${at}/extensions/${EXTENSIONS.display}`, `is a mapping whose color is text, not ${show(display)}`);
    }
  }

  /** @type {Map<string, string>} 'TYPE|from|to' -> relationship id */
  const triples = new Map();
  /** @type {Map<string, {symmetric: Set<boolean>, origin: Set<string>}>} */
  const byType = new Map();
  for (const [key, r] of Object.entries(rels)) {
    const at = `/relationships${ptr(key)}`;
    const bad = idProblem('relationship type', r.type);
    if (bad) err(`${at}/type`, bad);
    for (const end of /** @type {const} */ (['from', 'to'])) {
      if (!Object.hasOwn(nodes, r[end].node)) err(`${at}/${end}/node`, `${show(r[end].node)} is not a node of this document`);
      const { count, min_count: min, max_count: max } = r[end];
      if (count !== undefined && (min !== undefined || max !== undefined)) err(`${at}/${end}`, '`count` is the exact form; it does not go with min_count or max_count');
      if (min !== undefined && max !== undefined && min > max) err(`${at}/${end}`, `min_count ${min} is above max_count ${max}`);
    }
    const t = `${r.type}|${r.from.node}|${r.to.node}`;
    const dup = triples.get(t);
    if (dup !== undefined) err(at, `repeats ${show(dup)}: the same type between the same nodes`);
    else triples.set(t, key);
    element(at, r);
    const s = byType.get(r.type) ?? { symmetric: new Set(), origin: new Set() };
    s.symmetric.add(customOf(r.extensions, EXTENSIONS.symmetric).length > 0);
    for (const e of customOf(r.extensions, EXTENSIONS.origin)) {
      if (!isMap(e.definition) || (e.definition.origin !== 'base' && e.definition.origin !== 'domain')) {
        err(`${at}/extensions/custom`, `${EXTENSIONS.origin}'s definition is {origin: base|domain}, not ${show(e.definition)}`);
      } else s.origin.add(e.definition.origin);
    }
    byType.set(r.type, s);
  }
  for (const [type, s] of byType) {
    if (s.symmetric.size > 1) err('/relationships', `the entries of ${type} disagree on ${EXTENSIONS.symmetric}: put it on all of them or none`);
    if (s.origin.size > 1) err('/relationships', `the entries of ${type} disagree on ${EXTENSIONS.origin}`);
  }

  for (const e of customOf(doc.extensions, EXTENSIONS.gazetteer)) {
    const d = e.definition;
    if (!isMap(d)) {
      err('/extensions/custom', `${EXTENSIONS.gazetteer}'s definition maps names to node ids, not ${show(d)}`);
      continue;
    }
    for (const [name, kind] of Object.entries(d)) {
      if (rustTrim(name) === '') err('/extensions/custom', `${EXTENSIONS.gazetteer}: an empty name`);
      if (typeof kind !== 'string' || !Object.hasOwn(nodes, kind)) err('/extensions/custom', `${EXTENSIONS.gazetteer}: ${show(name)} maps to ${show(kind)}, which is not a node of this document`);
    }
  }
  for (const e of customOf(doc.extensions, EXTENSIONS.domain)) {
    if (e.definition !== undefined && !isMap(e.definition)) err('/extensions/custom', `${EXTENSIONS.domain}'s definition is a mapping, not ${show(e.definition)}`);
  }
  return errors;
}

/**
 * The schema, then (when the schema holds) the rules.
 * @param {unknown} doc
 * @returns {{ok: boolean, stage: 'schema'|'rules'|null, errors: Array<{path: string, keyword: string, message: string}>}}
 */
export function validateDocument(doc) {
  const schema = validateSchema(doc);
  if (schema.length) return { ok: false, stage: 'schema', errors: schema };
  const rules = checkDocument(doc);
  return { ok: rules.length === 0, stage: rules.length ? 'rules' : null, errors: rules };
}

// ---- serialisation ------------------------------------------------------------------------------------

/** Each spec-defined object's fields, in the order the schema lists them. */
const ORDER = {
  root: ['$schema', 'id', 'version', 'name', 'description', 'nodes', 'relationships', 'extensions'],
  node: ['label', 'labels', 'description', 'aliases', 'reference', 'properties', 'constraints', 'tools', 'extensions'],
  labels: ['identifier', 'implied', 'optional'],
  property: ['type', 'dimension', 'mustExist', 'unique', 'key', 'one_of', 'pattern', 'description', 'aliases', 'reference', 'extensions'],
  relationship: ['type', 'from', 'to', 'description', 'aliases', 'reference', 'properties', 'constraints', 'tools', 'extensions'],
  endpoint: ['node', 'count', 'min_count', 'max_count'],
  constraint: ['constraint_type', 'name', 'properties'],
  tool: ['type', 'name', 'description'],
  extension: ['type', '$schema', 'name', 'definition'],
};

/** A deep copy that keeps `__proto__` keys as own properties. @param {any} v */
function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isMap(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) setOwn(out, k, clone(x));
    return out;
  }
  return v;
}

/**
 * The document rebuilt with its known structure walked: `fixed(shape, obj)` makes a spec-defined
 * object from its fields (`order`: the field names in the order to write them), and the maps and
 * payloads are copied as they come. sort: true orders spec-defined fields by code point (canonical
 * JSON), else in the schema's order (YAML).
 * @param {any} doc @param {boolean} sort
 */
function shape(doc, sort) {
  /** @param {string[]} order @param {any} obj @param {Record<string, (v: any) => any>} [kids] */
  const fixed = (order, obj, kids = {}) => {
    if (!isMap(obj)) return clone(obj);
    const keys = Object.keys(obj);
    const known = order.filter((k) => keys.includes(k));
    const rest = keys.filter((k) => !order.includes(k));
    const all = sort ? [...keys].sort(cmpCodePoints) : [...known, ...rest];
    const out = {};
    for (const k of all) setOwn(out, k, kids[k] ? kids[k](obj[k]) : clone(obj[k]));
    return out;
  };
  /** @param {any} m @param {(v: any) => any} f  a map keyed by the document's own names: its order kept */
  const map = (m, f) => {
    if (!isMap(m)) return clone(m);
    const out = {};
    for (const [k, v] of Object.entries(m)) setOwn(out, k, f(v));
    return out;
  };
  const list = (l, f) => (Array.isArray(l) ? l.map(f) : clone(l));
  const extensions = (e) => {
    if (!isMap(e)) return clone(e);
    const keys = Object.keys(e).filter((k) => k !== 'custom');
    const named = sort ? keys.sort(cmpCodePoints) : keys;
    const out = {};
    for (const k of named) setOwn(out, k, clone(e[k]));
    if (Object.hasOwn(e, 'custom')) setOwn(out, 'custom', list(e.custom, (x) => fixed(ORDER.extension, x)));
    if (sort && Object.hasOwn(e, 'custom')) {
      // custom sorts among the named keys too
      const sorted = {};
      for (const k of Object.keys(out).sort(cmpCodePoints)) setOwn(sorted, k, out[k]);
      return sorted;
    }
    return out;
  };
  const property = (p) => fixed(ORDER.property, p, { extensions });
  const element = {
    properties: (m) => map(m, property),
    constraints: (l) => list(l, (c) => fixed(ORDER.constraint, c)),
    tools: (l) => list(l, (t) => fixed(ORDER.tool, t)),
    extensions,
  };
  const node = (n) => fixed(ORDER.node, n, { ...element, labels: (l) => fixed(ORDER.labels, l) });
  const endpoint = (x) => fixed(ORDER.endpoint, x);
  const rel = (r) => fixed(ORDER.relationship, r, { ...element, from: endpoint, to: endpoint });
  return fixed(ORDER.root, doc, { nodes: (m) => map(m, node), relationships: (m) => map(m, rel), extensions });
}

/** The document as a plain object with the schema's field order (what toYaml writes). @param {any} doc */
export function orderDocument(doc) {
  return shape(doc, false);
}

/**
 * The document as YAML: fields in the schema's order, maps in the document's order, block style,
 * long lines unfolded. Reading it back (parseDocument) gives an equal document.
 * @param {any} doc
 */
export function toYaml(doc) {
  return yaml.dump(shape(doc, false), { lineWidth: -1, noRefs: true });
}

/**
 * The document as canonical JSON (see the header): compact, spec-defined keys sorted, the
 * document's own maps and extension payloads in their order.
 * @param {any} doc
 */
export function toCanonicalJson(doc) {
  return JSON.stringify(shape(doc, true));
}
