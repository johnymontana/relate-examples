// @ts-check
/**
 * ogs.js: the Neo4j Ontology Graph Specification, spec 1.1.0 (https://neo4j.com/docs/ontology-graph-spec/,
 * Apache-2.0; its JSON Schema vendored in data/ontology-spec/ from neo4j/ontology-graph-spec at tag
 * release/v0.12.2): a document read from YAML or JSON, checked against the spec's JSON Schema, the
 * spec's official SDK (npm @neo4j/ontology-graph-spec, through lib/ogs.mjs) and the rules this
 * example needs, and written back out in one canonical form. The ontology format every other module
 * of the example reads (ontology.js builds its kinds and links from a document; convert.js turns
 * create-context-graph's domain files into one).
 *
 * Shared by the engine worker, the page and the Node harness: no Node-only import. It imports
 * js-yaml and the SDK by their bare names (build.mjs and harness/serve.mjs rewrite the specifiers for
 * the page), lib/ogs.mjs by a relative path (rewritten to assets/lib-<sha8>/) and names.js (rustTrim).
 *
 *   const doc = parseDocument(text);           // YAML or JSON -> a plain object (OntologyError on a syntax error)
 *   validateSchema(doc);                       // [{path, keyword, message}]: the JSON Schema, as ajv reports it
 *   validateSpec(doc);                         // [{path, keyword: 'sdk:<code>', message}]: the SDK's decode and core validation
 *   checkDocument(doc);                        // [{path, keyword: 'semantic', message}]: the rules below
 *   validateDocument(doc);                     // {ok, stage, errors}: the schema, then the SDK, then the rules
 *   toYaml(doc); toCanonicalJson(doc);         // the two serialisations (below)
 *   isDraft(doc); fromDraft(doc);              // an earlier build's draft document, converted (lib/ogs.mjs)
 *
 * Three checks, in order, each only when the one before it holds. (1) The JSON Schema
 * (validateSchema), the spec's normative definition and the strict one: it refuses a field the
 * spec does not have, where the SDK's decoder drops it without a word (a leftover draft
 * `mustExist`, say). It is a small interpreter of exactly the JSON Schema 2020-12 keywords the
 * spec's schema uses: $ref (to #/$defs/…), type (a name or a list of names), required, properties,
 * additionalProperties (false or a schema), items, enum, const and oneOf (ajv's way: the branches'
 * errors and a oneOf error when no branch holds, only the oneOf error when several do).
 * Annotations ($id, $schema, title, description) are ignored. Errors carry ajv's instancePath and
 * keyword, so harness/ontology.mjs compares the two validators error for error, on every bundled
 * document and on tampered ones. SCHEMA below is the vendored file's content; the harness pins that
 * they are equal. (2) The SDK (validateSpec): GraphSpec.Json decodes the document and
 * Validations.core checks it (an endpoint names a node, a constraint names a property beside it,
 * `count` is not combined with `min_count` or `max_count`, `min_count` is at most `max_count`, …).
 * (3) This example's rules (checkDocument), which neither can say: `schema` names spec 1.1.0 (this
 * file's SCHEMA_ID); every node has a label (`label`, or `labels.identifier`; both only when they
 * agree); `dimension` goes with a VECTOR<…> type; `key` is not combined with `must_exist: false` or
 * `unique: false`; every identifier label and implied or optional label, and every relationship
 * type, follows the id rule (isOntologyId: they become labels and relationship types in Relate);
 * one identifier label per node; one entry per (type, from, to); a node's implied and optional
 * labels differ from each other and from its identifier; the extensions this example reads have
 * the shape it reads (createContextGraph:pole, createContextGraph:origin, createContextGraph:domain,
 * edgextract:gazetteer, edgextract:symmetric under `extensions.custom`; `display.colour`), and a
 * document with createContextGraph:domain gives every node a createContextGraph:pole; the tools
 * (`extensions.custom.tools`, a list) are {type, name, …} with distinct names per element, a
 * canonicalQuery tool's cypher, when it has one, is text, and a tool's parameters are a list of
 * {name, ...}.
 *
 * Serialisations. The spec has one wire format (absent means none: empty maps and lists are
 * never written). toYaml writes the document with each object's fields in the order the spec's
 * schema lists them, and the entries of the maps keyed by the document's own names (`nodes`,
 * `relationships`, `properties`, `constraints`, `indexes`, `extensions.custom`) in the document's
 * order; it is what data/ontologies/ogs/ holds and what the page's editor shows. YAML is read with
 * js-yaml and handed to the SDK as JSON, never through the SDK's own YAML decoder, which misreads
 * plain YAML (lib/ogs.mjs; NOTES.md Y1).
 * toCanonicalJson writes compact JSON with the keys of every spec-defined object sorted by code
 * point, except two things kept as they are: the order of the maps keyed by the document's own
 * names, because this example asks the model about kinds and links in that order (the order is
 * part of every inference cache key, D7), and the content of extension payloads (each
 * `extensions.custom` value, `display.custom`, an index's `options` and `custom`, the data source
 * tables and mappings), which the spec carries untouched. It is what the store keeps and what the
 * ontology's sha256 is taken over.
 */
import yaml from 'js-yaml';
import * as sdk from '@neo4j/ontology-graph-spec';
import { createOgs, FIELD_ORDER, SCHEMA_URL, SPEC_VERSION as LIB_SPEC_VERSION, isDraft as libIsDraft, fromDraft as libFromDraft, layoutPoint, OntologyError as LibOntologyError } from '../../../lib/ogs.mjs';

export { layoutPoint };
import { rustTrim } from './names.js';

/** The spec version this module reads. */
export const SPEC_VERSION = LIB_SPEC_VERSION;
/** The schema's $id, which a document's `schema` names. */
export const SCHEMA_ID = SCHEMA_URL;
/** The SDK version this example pins (package.json; build.mjs and harness/ontology.mjs check it). */
export const SDK_VERSION = '0.12.2';

/** An ontology the rules refuse; the message is meant for the person who wrote it. errors: [{path, keyword, message}] when a document failed its checks. */
export class OntologyError extends Error {
  /** @param {string} message @param {Array<{path: string, keyword: string, message: string}>} [errors] */
  constructor(message, errors = []) {
    super(message);
    this.name = 'OntologyError';
    this.errors = errors;
  }
}

const OGS = createOgs({ yaml, sdk, sdkVersion: SDK_VERSION });

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
 * A document's text (YAML or JSON) as a value. It is not checked here: validateDocument does that.
 * @param {string} text
 */
export function parseDocument(text) {
  if (typeof text !== 'string') throw new TypeError('parseDocument: text must be a string');
  return loadText(text, /^\s*[{[]/.test(text) ? 'The JSON' : 'The YAML');
}

// ---- the schema (data/ontology-spec/ontology-graph-spec.schema.json, verbatim) ----------------------

export const SCHEMA = deepFreeze(/*@ogs:schema*/{
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://neo4j.com/docs/ontology-graph-spec/1.1.0/schema.json",
    "title": "GraphModel",
    "type": "object",
    "properties": {
        "schema": {
            "type": "string",
            "description": "Schema specification uri used."
        },
        "version": {
            "type": "string",
            "description": "User-defined version of this model document, e.g. a revision number or label."
        },
        "id": {
            "type": "string",
            "description": "Unique identifier of the model, typically a kebab-case version of the name, used for referencing."
        },
        "name": {
            "type": "string",
            "description": "Human readable name for the model."
        },
        "description": {
            "type": "string",
            "description": "Description of the model."
        },
        "nodes": {
            "type": "object",
            "description": "Node definitions keyed by node id.",
            "additionalProperties": {
                "$ref": "#/$defs/Node"
            }
        },
        "relationships": {
            "type": "object",
            "description": "Relationship definitions keyed by relationship id.",
            "additionalProperties": {
                "$ref": "#/$defs/Relationship"
            }
        },
        "extensions": {
            "$ref": "#/$defs/GraphModelExtensions",
            "description": "Extensions to the model: data source tables, mappings and external custom data."
        }
    },
    "additionalProperties": false,
    "required": [
        "schema",
        "version",
        "id"
    ],
    "$defs": {
        "Node": {
            "type": "object",
            "description": "A node of the graph.",
            "properties": {
                "label": {
                    "type": [
                        "string",
                        "null"
                    ],
                    "description": "Shorthand for the identifying label. Expanded into labels when the model is decoded."
                },
                "labels": {
                    "$ref": "#/$defs/Labels",
                    "description": "Labels of the node."
                },
                "properties": {
                    "type": "object",
                    "description": "Properties of the node keyed by id.",
                    "additionalProperties": {
                        "$ref": "#/$defs/Property"
                    }
                },
                "constraints": {
                    "type": "object",
                    "description": "Constraints on the node keyed by id.",
                    "additionalProperties": {
                        "$ref": "#/$defs/NodeConstraint"
                    }
                },
                "extensions": {
                    "$ref": "#/$defs/NodeExtensions",
                    "description": "Extensions for the node."
                },
                "description": {
                    "type": "string",
                    "description": "Description of the node."
                },
                "aliases": {
                    "type": "array",
                    "description": "Alternative names for the node.",
                    "items": {
                        "type": "string"
                    }
                },
                "reference": {
                    "type": "string",
                    "description": "Reference or URI of an external resource describing the node."
                }
            },
            "required": [],
            "additionalProperties": false
        },
        "Labels": {
            "type": "object",
            "description": "The labels of a node.",
            "properties": {
                "identifier": {
                    "type": [
                        "string",
                        "null"
                    ],
                    "description": "The label which identifies the node."
                },
                "implied": {
                    "type": "array",
                    "description": "Labels implied by the node in addition to the identifier.",
                    "items": {
                        "type": "string"
                    }
                },
                "optional": {
                    "type": "array",
                    "description": "Labels which may be present on the node but aren't required.",
                    "items": {
                        "type": "string"
                    }
                },
                "extensions": {
                    "$ref": "#/$defs/LabelsExtensions",
                    "description": "Extensions for the labels."
                }
            },
            "required": [],
            "additionalProperties": false
        },
        "LabelsExtensions": {
            "type": "object",
            "description": "Extensions for the labels of a node.",
            "properties": {
                "custom": {
                    "type": "object",
                    "description": "User-defined arbitrary data.",
                    "additionalProperties": {}
                }
            },
            "required": [],
            "additionalProperties": false
        },
        "Property": {
            "type": "object",
            "description": "A property of a node or relationship.",
            "properties": {
                "type": {
                    "$ref": "#/$defs/Neo4jType",
                    "description": "Neo4j type of the property."
                },
                "dimension": {
                    "type": [
                        "integer",
                        "null"
                    ],
                    "description": "Dimension of the property when it holds a vector."
                },
                "must_exist": {
                    "type": [
                        "boolean",
                        "null"
                    ],
                    "description": "Shorthand for an existence constraint. Expanded into constraints when the model is decoded."
                },
                "unique": {
                    "type": [
                        "boolean",
                        "null"
                    ],
                    "description": "Shorthand for a uniqueness constraint. Expanded into constraints when the model is decoded."
                },
                "key": {
                    "type": [
                        "boolean",
                        "null"
                    ],
                    "description": "Shorthand for a key constraint. Expanded into constraints when the model is decoded."
                },
                "extensions": {
                    "$ref": "#/$defs/PropertyExtensions",
                    "description": "Extensions for the property."
                },
                "name": {
                    "type": [
                        "string",
                        "null"
                    ],
                    "description": "Name of the property in the database, when different from its id."
                },
                "description": {
                    "type": "string",
                    "description": "Description of the property."
                },
                "aliases": {
                    "type": "array",
                    "description": "Alternative names for the property.",
                    "items": {
                        "type": "string"
                    }
                },
                "reference": {
                    "type": "string",
                    "description": "Reference or URI of an external resource describing the property."
                },
                "pattern": {
                    "type": "string",
                    "description": "Pattern values of the property are expected to match."
                },
                "one_of": {
                    "type": "array",
                    "description": "Values the property is restricted to.",
                    "items": {
                        "type": "string"
                    }
                }
            },
            "required": [],
            "additionalProperties": false
        },
        "Neo4jType": {
            "type": "string",
            "description": "A Neo4j property type.",
            "enum": [
                "ANY",
                "LIST<ANY>",
                "BOOLEAN",
                "LIST<BOOLEAN>",
                "DATE",
                "LIST<DATE>",
                "DURATION",
                "LIST<DURATION>",
                "FLOAT32",
                "LIST<FLOAT32>",
                "FLOAT",
                "LIST<FLOAT>",
                "INTEGER8",
                "LIST<INTEGER8>",
                "INTEGER16",
                "LIST<INTEGER16>",
                "INTEGER32",
                "LIST<INTEGER32>",
                "INTEGER",
                "LIST<INTEGER>",
                "LOCAL DATETIME",
                "LIST<LOCAL DATETIME>",
                "LOCAL TIME",
                "LIST<LOCAL TIME>",
                "POINT",
                "LIST<POINT>",
                "STRING",
                "LIST<STRING>",
                "VECTOR<FLOAT>",
                "VECTOR<FLOAT32>",
                "VECTOR<INTEGER>",
                "VECTOR<INTEGER32>",
                "VECTOR<INTEGER16>",
                "VECTOR<INTEGER8>",
                "ZONED DATETIME",
                "LIST<ZONED DATETIME>",
                "ZONED TIME",
                "LIST<ZONED TIME>",
                "UUID"
            ]
        },
        "PropertyExtensions": {
            "type": "object",
            "description": "Extensions for a property.",
            "properties": {
                "custom": {
                    "type": "object",
                    "description": "User-defined arbitrary data.",
                    "additionalProperties": {}
                }
            },
            "required": [],
            "additionalProperties": false
        },
        "NodeConstraint": {
            "type": "object",
            "description": "A constraint on a node.",
            "properties": {
                "type": {
                    "$ref": "#/$defs/ConstraintType",
                    "description": "Type of the constraint."
                },
                "properties": {
                    "type": "array",
                    "description": "Ids of the properties the constraint covers.",
                    "items": {
                        "type": "string"
                    }
                },
                "extensions": {
                    "$ref": "#/$defs/NodeConstraintExtensions",
                    "description": "Extensions for the constraint."
                },
                "name": {
                    "type": [
                        "string",
                        "null"
                    ],
                    "description": "Name of the constraint in the database."
                }
            },
            "required": [
                "type",
                "properties"
            ],
            "additionalProperties": false
        },
        "ConstraintType": {
            "type": "string",
            "description": "The type of a constraint.",
            "enum": [
                "EXISTS",
                "KEY",
                "PROPERTY_TYPE",
                "UNIQUE"
            ]
        },
        "NodeConstraintExtensions": {
            "type": "object",
            "description": "Extensions for a node constraint.",
            "properties": {
                "custom": {
                    "type": "object",
                    "description": "User-defined arbitrary data.",
                    "additionalProperties": {}
                }
            },
            "required": [],
            "additionalProperties": false
        },
        "NodeExtensions": {
            "type": "object",
            "description": "Extensions for a node.",
            "properties": {
                "indexes": {
                    "type": "object",
                    "description": "Database indexes on this node keyed by id.",
                    "additionalProperties": {
                        "$ref": "#/$defs/NodeIndex"
                    }
                },
                "display": {
                    "oneOf": [
                        {
                            "type": "null"
                        },
                        {
                            "$ref": "#/$defs/NodeDisplay"
                        }
                    ],
                    "description": "Optional visual information of this node."
                },
                "custom": {
                    "type": "object",
                    "description": "User-defined arbitrary data.",
                    "additionalProperties": {}
                }
            },
            "required": [],
            "additionalProperties": false
        },
        "NodeIndex": {
            "type": "object",
            "description": "An index on a node.",
            "properties": {
                "type": {
                    "$ref": "#/$defs/IndexType",
                    "description": "Type of the index."
                },
                "labels": {
                    "type": "array",
                    "description": "Labels the index covers.",
                    "items": {
                        "type": "string"
                    }
                },
                "properties": {
                    "type": "array",
                    "description": "Ids of the properties the index covers.",
                    "items": {
                        "type": "string"
                    }
                },
                "options": {
                    "oneOf": [
                        {
                            "type": "null"
                        },
                        {
                            "$ref": "#/$defs/IndexOption"
                        }
                    ],
                    "description": "Configuration specific to the type of index."
                },
                "custom": {
                    "type": "object",
                    "description": "User-defined arbitrary data.",
                    "additionalProperties": {}
                },
                "name": {
                    "type": [
                        "string",
                        "null"
                    ],
                    "description": "Name of the index in the database."
                }
            },
            "required": [
                "type",
                "labels",
                "properties"
            ],
            "additionalProperties": false
        },
        "IndexType": {
            "type": "string",
            "description": "The type of an index.",
            "enum": [
                "FULLTEXT",
                "POINT",
                "RANGE",
                "TEXT",
                "VECTOR",
                "LOOKUP"
            ]
        },
        "IndexOption": {
            "oneOf": [
                {
                    "$ref": "#/$defs/FULLTEXT"
                },
                {
                    "$ref": "#/$defs/POINT"
                },
                {
                    "$ref": "#/$defs/VECTOR"
                }
            ],
            "description": "Configuration specific to the type of an index."
        },
        "FULLTEXT": {
            "type": "object",
            "description": "Configuration of a full-text index.",
            "properties": {
                "type": {
                    "type": "string",
                    "const": "FULLTEXT"
                },
                "fulltext.default_analyzer": {
                    "type": "string",
                    "description": "Analyzer used when the index doesn't specify one."
                },
                "fulltext.analyzer": {
                    "type": [
                        "string",
                        "null"
                    ],
                    "description": "Analyzer used by the index."
                },
                "fulltext.eventually_consistent": {
                    "type": "boolean",
                    "description": "Whether the index is eventually consistent, updating asynchronously after transactions commit."
                },
                "fulltext.eventually_consistent_apply_parallelism": {
                    "type": "integer",
                    "description": "Number of threads used to apply updates to an eventually consistent index."
                },
                "fulltext.eventually_consistent_refresh_interval": {
                    "type": "string",
                    "description": "How often an eventually consistent index is refreshed."
                },
                "fulltext.eventually_consistent_refresh_parallelism": {
                    "type": "integer",
                    "description": "Number of threads used to refresh an eventually consistent index."
                },
                "fulltext.eventually_consistent_index_update_queue_max_length": {
                    "type": "integer",
                    "description": "Maximum number of pending updates queued for an eventually consistent index."
                }
            },
            "required": [
                "type"
            ],
            "additionalProperties": false
        },
        "POINT": {
            "type": "object",
            "description": "Configuration of a point index.",
            "properties": {
                "type": {
                    "type": "string",
                    "const": "POINT"
                },
                "spatial.cartesian.min": {
                    "type": "array",
                    "description": "Lower bounds of the 2D cartesian space.",
                    "items": {
                        "type": "number"
                    }
                },
                "spatial.cartesian.max": {
                    "type": "array",
                    "description": "Upper bounds of the 2D cartesian space.",
                    "items": {
                        "type": "number"
                    }
                },
                "spatial.cartesian-3d.min": {
                    "type": "array",
                    "description": "Lower bounds of the 3D cartesian space.",
                    "items": {
                        "type": "number"
                    }
                },
                "spatial.cartesian-3d.max": {
                    "type": "array",
                    "description": "Upper bounds of the 3D cartesian space.",
                    "items": {
                        "type": "number"
                    }
                },
                "spatial.wgs-84.min": {
                    "type": "array",
                    "description": "Lower bounds of the 2D WGS-84 space.",
                    "items": {
                        "type": "number"
                    }
                },
                "spatial.wgs-84.max": {
                    "type": "array",
                    "description": "Upper bounds of the 2D WGS-84 space.",
                    "items": {
                        "type": "number"
                    }
                },
                "spatial.wgs-84-3d.min": {
                    "type": "array",
                    "description": "Lower bounds of the 3D WGS-84 space.",
                    "items": {
                        "type": "number"
                    }
                },
                "spatial.wgs-84-3d.max": {
                    "type": "array",
                    "description": "Upper bounds of the 3D WGS-84 space.",
                    "items": {
                        "type": "number"
                    }
                }
            },
            "required": [
                "type"
            ],
            "additionalProperties": false
        },
        "VECTOR": {
            "type": "object",
            "description": "Configuration of a vector index.",
            "properties": {
                "type": {
                    "type": "string",
                    "const": "VECTOR"
                },
                "vector.dimensions": {
                    "type": [
                        "integer",
                        "null"
                    ],
                    "description": "Number of dimensions of the indexed vectors."
                },
                "vector.similarity_function": {
                    "type": "string",
                    "description": "Function used to compare vectors, e.g. cosine or euclidean."
                },
                "vector.default_search_expansion_factor": {
                    "type": [
                        "number",
                        "null"
                    ],
                    "description": "Default expansion factor applied to searches of the index."
                },
                "vector.quantization.enabled": {
                    "type": "boolean",
                    "description": "Whether vector quantization is enabled."
                },
                "vector.quantization.type": {
                    "type": "string",
                    "description": "Type of vector quantization used."
                },
                "vector.hnsw.m": {
                    "type": "integer",
                    "description": "Maximum number of connections per node in the HNSW graph."
                },
                "vector.hnsw.ef_construction": {
                    "type": "integer",
                    "description": "Number of nearest neighbours considered when building the HNSW graph."
                }
            },
            "required": [
                "type"
            ],
            "additionalProperties": false
        },
        "NodeDisplay": {
            "type": "object",
            "description": "Visual information for a node.",
            "properties": {
                "x": {
                    "type": "number",
                    "description": "Horizontal position."
                },
                "y": {
                    "type": "number",
                    "description": "Vertical position."
                },
                "colour": {
                    "type": [
                        "string",
                        "null"
                    ],
                    "description": "Display colour of the node as a hex string, e.g. #FF8800."
                },
                "custom": {
                    "type": "object",
                    "description": "User-defined arbitrary data.",
                    "additionalProperties": {}
                }
            },
            "required": [
                "x",
                "y"
            ],
            "additionalProperties": false
        },
        "Relationship": {
            "type": "object",
            "description": "A relationship of the graph.",
            "properties": {
                "type": {
                    "type": "string",
                    "description": "Type of the relationship."
                },
                "from": {
                    "$ref": "#/$defs/RelationshipTarget",
                    "description": "The node the relationship starts at."
                },
                "to": {
                    "$ref": "#/$defs/RelationshipTarget",
                    "description": "The node the relationship ends at."
                },
                "properties": {
                    "type": "object",
                    "description": "Properties of the relationship keyed by id.",
                    "additionalProperties": {
                        "$ref": "#/$defs/Property"
                    }
                },
                "constraints": {
                    "type": "object",
                    "description": "Constraints on the relationship keyed by id.",
                    "additionalProperties": {
                        "$ref": "#/$defs/RelationshipConstraint"
                    }
                },
                "extensions": {
                    "$ref": "#/$defs/RelationshipExtensions",
                    "description": "Extensions for the relationship."
                },
                "description": {
                    "type": "string",
                    "description": "Description of the relationship."
                },
                "aliases": {
                    "type": "array",
                    "description": "Alternative names for the relationship.",
                    "items": {
                        "type": "string"
                    }
                },
                "reference": {
                    "type": "string",
                    "description": "Reference or URI of an external resource describing the relationship."
                }
            },
            "required": [
                "type",
                "from",
                "to"
            ],
            "additionalProperties": false
        },
        "RelationshipTarget": {
            "type": "object",
            "description": "One end of a relationship.",
            "properties": {
                "node": {
                    "type": "string",
                    "description": "Id of the node at this end."
                },
                "label": {
                    "type": "string",
                    "description": "Label of the node at this end."
                },
                "count": {
                    "type": [
                        "integer",
                        "null"
                    ],
                    "description": "Exact number of relationships per node at this end. Null when unconstrained."
                },
                "min_count": {
                    "type": [
                        "integer",
                        "null"
                    ],
                    "description": "Minimum number of relationships per node at this end."
                },
                "max_count": {
                    "type": [
                        "integer",
                        "null"
                    ],
                    "description": "Maximum number of relationships per node at this end."
                }
            },
            "required": [],
            "additionalProperties": false
        },
        "RelationshipConstraint": {
            "type": "object",
            "description": "A constraint on a relationship.",
            "properties": {
                "type": {
                    "$ref": "#/$defs/ConstraintType",
                    "description": "Type of the constraint."
                },
                "properties": {
                    "type": "array",
                    "description": "Ids of the properties the constraint covers.",
                    "items": {
                        "type": "string"
                    }
                },
                "extensions": {
                    "$ref": "#/$defs/RelationshipConstraintExtensions",
                    "description": "Extensions for the constraint."
                },
                "name": {
                    "type": [
                        "string",
                        "null"
                    ],
                    "description": "Name of the constraint in the database."
                }
            },
            "required": [
                "type",
                "properties"
            ],
            "additionalProperties": false
        },
        "RelationshipConstraintExtensions": {
            "type": "object",
            "description": "Extensions for a relationship constraint.",
            "properties": {
                "custom": {
                    "type": "object",
                    "description": "User-defined arbitrary data.",
                    "additionalProperties": {}
                }
            },
            "required": [],
            "additionalProperties": false
        },
        "RelationshipExtensions": {
            "type": "object",
            "description": "Extensions for a relationship.",
            "properties": {
                "indexes": {
                    "type": "object",
                    "description": "Indexes on this relationship keyed by id.",
                    "additionalProperties": {
                        "$ref": "#/$defs/RelationshipIndex"
                    }
                },
                "custom": {
                    "type": "object",
                    "description": "User-defined arbitrary data.",
                    "additionalProperties": {}
                }
            },
            "required": [],
            "additionalProperties": false
        },
        "RelationshipIndex": {
            "type": "object",
            "description": "An index on a relationship.",
            "properties": {
                "type": {
                    "$ref": "#/$defs/IndexType",
                    "description": "Type of the index."
                },
                "properties": {
                    "type": "array",
                    "description": "Ids of the properties the index covers.",
                    "items": {
                        "type": "string"
                    }
                },
                "options": {
                    "oneOf": [
                        {
                            "type": "null"
                        },
                        {
                            "$ref": "#/$defs/IndexOption"
                        }
                    ],
                    "description": "Configuration specific to the type of index."
                },
                "custom": {
                    "type": "object",
                    "description": "User-defined arbitrary data.",
                    "additionalProperties": {}
                },
                "name": {
                    "type": [
                        "string",
                        "null"
                    ],
                    "description": "Name of the index in the database."
                }
            },
            "required": [
                "type",
                "properties"
            ],
            "additionalProperties": false
        },
        "GraphModelExtensions": {
            "type": "object",
            "description": "Extensions for a graph model.",
            "properties": {
                "data_source_tables": {
                    "type": "object",
                    "description": "Data source table schemas keyed by table id.",
                    "additionalProperties": {
                        "$ref": "#/$defs/Table"
                    }
                },
                "data_source_mappings": {
                    "type": "object",
                    "description": "Sets of data source mappings from tables to nodes and relationships, often used for importing.",
                    "additionalProperties": {
                        "type": "array",
                        "items": {
                            "$ref": "#/$defs/Mapping"
                        }
                    }
                },
                "custom": {
                    "type": "object",
                    "description": "User-defined arbitrary data.",
                    "additionalProperties": {}
                }
            },
            "required": [],
            "additionalProperties": false
        },
        "Table": {
            "type": "object",
            "description": "A data source table schema.",
            "properties": {
                "source": {
                    "type": "string",
                    "description": "Where the table's data comes from."
                },
                "columns": {
                    "type": "array",
                    "description": "Columns of the table in their source order.",
                    "items": {
                        "$ref": "#/$defs/TableColumn"
                    }
                },
                "primary_keys": {
                    "type": "array",
                    "description": "Names of the columns making up the primary key.",
                    "items": {
                        "type": "string"
                    }
                },
                "foreign_keys": {
                    "type": "object",
                    "description": "Foreign keys of the table keyed by id.",
                    "additionalProperties": {
                        "$ref": "#/$defs/ForeignKey"
                    }
                },
                "custom": {
                    "type": "object",
                    "description": "User-defined arbitrary data.",
                    "additionalProperties": {}
                }
            },
            "required": [
                "source"
            ],
            "additionalProperties": false
        },
        "TableColumn": {
            "type": "object",
            "description": "A column of a data source table.",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Name of the column in the source. Unique within the table."
                },
                "type": {
                    "type": "string",
                    "description": "Data type of the column in the source."
                },
                "size": {
                    "type": "integer",
                    "description": "Size of the column."
                },
                "suggested": {
                    "$ref": "#/$defs/Neo4jType",
                    "description": "Neo4j type suggested for values of this column."
                },
                "supported": {
                    "type": "array",
                    "description": "Neo4j types values of this column can be converted to when using the import tool.",
                    "items": {
                        "$ref": "#/$defs/Neo4jType"
                    }
                },
                "nullable": {
                    "type": "boolean",
                    "description": "Whether the column can hold null values."
                },
                "dimension": {
                    "type": [
                        "integer",
                        "null"
                    ],
                    "description": "Dimension of the column when it holds vectors."
                },
                "custom": {
                    "type": "object",
                    "description": "User-defined arbitrary data.",
                    "additionalProperties": {}
                }
            },
            "required": [],
            "additionalProperties": false
        },
        "ForeignKey": {
            "type": "object",
            "description": "A foreign key of a table.",
            "properties": {
                "columns": {
                    "type": "array",
                    "description": "Names of the columns in this table which make up the key.",
                    "items": {
                        "type": "string"
                    }
                },
                "references": {
                    "$ref": "#/$defs/ForeignKeyReference",
                    "description": "The table and columns the key refers to."
                },
                "custom": {
                    "type": "object",
                    "description": "User-defined arbitrary data.",
                    "additionalProperties": {}
                }
            },
            "required": [
                "columns",
                "references"
            ],
            "additionalProperties": false
        },
        "ForeignKeyReference": {
            "type": "object",
            "description": "The target of a foreign key.",
            "properties": {
                "table": {
                    "type": "string",
                    "description": "Id of the referenced table."
                },
                "columns": {
                    "type": "array",
                    "description": "Names of the referenced columns.",
                    "items": {
                        "type": "string"
                    }
                },
                "custom": {
                    "type": "object",
                    "description": "User-defined arbitrary data.",
                    "additionalProperties": {}
                }
            },
            "required": [
                "table"
            ],
            "additionalProperties": false
        },
        "Mapping": {
            "oneOf": [
                {
                    "$ref": "#/$defs/NODE"
                },
                {
                    "$ref": "#/$defs/QUERY"
                },
                {
                    "$ref": "#/$defs/RELATIONSHIP"
                }
            ],
            "description": "A mapping from a data source table to the graph. Either a node, relationship or query mapping."
        },
        "NODE": {
            "type": "object",
            "description": "Maps rows of a table to nodes.",
            "properties": {
                "type": {
                    "type": "string",
                    "const": "NODE"
                },
                "node": {
                    "type": "string",
                    "description": "Id of the node being mapped."
                },
                "table": {
                    "type": "string",
                    "description": "Id of the source table."
                },
                "properties": {
                    "type": "object",
                    "description": "Mappings from property ids to source columns.",
                    "additionalProperties": {
                        "$ref": "#/$defs/PropertyMapping"
                    }
                },
                "mode": {
                    "$ref": "#/$defs/MappingMode",
                    "description": "Whether nodes are merged with existing nodes or always created."
                },
                "match_label": {
                    "type": [
                        "string",
                        "null"
                    ],
                    "description": "Label used to match existing nodes."
                },
                "key": {
                    "type": "array",
                    "description": "Ids of the properties which identify a node.",
                    "items": {
                        "type": "string"
                    }
                },
                "depends_on": {
                    "type": "string",
                    "description": "Id of another mapping in the same list which must be imported before this one. Empty when there is no dependency."
                },
                "id": {
                    "type": "string",
                    "description": "Optional id of this mapping, so other mappings in the same list can reference it in depends_on."
                }
            },
            "required": [
                "type",
                "node",
                "table",
                "properties"
            ],
            "additionalProperties": false
        },
        "PropertyMapping": {
            "type": "object",
            "description": "Maps a property to a source column.",
            "properties": {
                "column": {
                    "type": "string",
                    "description": "Name of the source column."
                }
            },
            "required": [
                "column"
            ],
            "additionalProperties": false
        },
        "MappingMode": {
            "type": "string",
            "description": "Write approach used when importing data (merged into existing data or always created).",
            "enum": [
                "MERGE",
                "CREATE"
            ]
        },
        "QUERY": {
            "type": "object",
            "description": "Maps the results of a query run against a table.",
            "properties": {
                "type": {
                    "type": "string",
                    "const": "QUERY"
                },
                "table": {
                    "type": "string",
                    "description": "Id of the source table."
                },
                "query": {
                    "type": "string",
                    "description": "The query to run."
                },
                "depends_on": {
                    "type": "string",
                    "description": "Id of another mapping in the same list which must be imported before this one. Empty when there is no dependency."
                },
                "id": {
                    "type": "string",
                    "description": "Optional id of this mapping, so other mappings in the same list can reference it in depends_on."
                }
            },
            "required": [
                "type",
                "table",
                "query"
            ],
            "additionalProperties": false
        },
        "RELATIONSHIP": {
            "type": "object",
            "description": "Maps rows of a table to relationships.",
            "properties": {
                "type": {
                    "type": "string",
                    "const": "RELATIONSHIP"
                },
                "relationship": {
                    "type": "string",
                    "description": "Id of the relationship being mapped."
                },
                "table": {
                    "type": "string",
                    "description": "Id of the source table."
                },
                "from_node": {
                    "$ref": "#/$defs/TargetMapping",
                    "description": "How the start node of the relationship is matched."
                },
                "to_node": {
                    "$ref": "#/$defs/TargetMapping",
                    "description": "How the end node of the relationship is matched."
                },
                "match_label": {
                    "type": [
                        "string",
                        "null"
                    ],
                    "description": "Label used to match existing relationships."
                },
                "properties": {
                    "type": "object",
                    "description": "Mappings from property ids to source columns.",
                    "additionalProperties": {
                        "$ref": "#/$defs/PropertyMapping"
                    }
                },
                "mode": {
                    "$ref": "#/$defs/MappingMode",
                    "description": "Whether relationships are merged with existing relationships or always created."
                },
                "key": {
                    "type": "array",
                    "description": "Ids of the properties which identify a relationship.",
                    "items": {
                        "type": "string"
                    }
                },
                "depends_on": {
                    "type": "string",
                    "description": "Id of another mapping in the same list which must be imported before this one. Empty when there is no dependency."
                },
                "id": {
                    "type": "string",
                    "description": "Optional id of this mapping, so other mappings in the same list can reference it in depends_on."
                }
            },
            "required": [
                "type",
                "relationship",
                "table",
                "from_node",
                "to_node"
            ],
            "additionalProperties": false
        },
        "TargetMapping": {
            "type": "object",
            "description": "Identifies a node at one end of a mapped relationship.",
            "properties": {
                "label": {
                    "type": "string",
                    "description": "Label of the node."
                },
                "properties": {
                    "type": "object",
                    "description": "Mappings from property ids to source columns used to match the node.",
                    "additionalProperties": {
                        "$ref": "#/$defs/PropertyMapping"
                    }
                }
            },
            "required": [],
            "additionalProperties": false
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

/** How a type error names the JSON Schema type it wanted. @type {Readonly<Record<string, string>>} */
const TYPE_WORDS = Object.freeze({ object: 'a mapping', array: 'a list', integer: 'an integer', null: 'null' });
/** A word with its indefinite article: 'an integer', 'a string'. @param {string} word */
const withArticle = (word) => `${/^[aeiou]/iu.test(word) ? 'an' : 'a'} ${word}`;
/** A type list in words: 'a string or null'. @param {string|string[]} t */
const typeWords = (t) => (Array.isArray(t) ? t : [t]).map((x) => TYPE_WORDS[x] ?? withArticle(x)).join(' or ');

/** A JSON Schema type test as ajv makes it with strictNumbers (no NaN or Infinity). */
function hasType(type, v) {
  if (Array.isArray(type)) return type.some((t) => hasType(t, v));
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
  'additionalProperties', 'items', 'enum', 'const', 'oneOf']);

/** JSON equality, as ajv's `const` and `enum` compare. @param {unknown} a @param {unknown} b @returns {boolean} */
function jsonEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (isMap(a) && isMap(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/**
 * The document checked against a JSON Schema (by default the spec's): every error, as ajv with
 * {allErrors: true} reports them ({path: instancePath, keyword, message}).
 * @param {unknown} doc
 * @param {any} [schema]
 * @returns {Array<{path: string, keyword: string, message: string}>}
 */
export function validateSchema(doc, schema = SCHEMA) {
  /** @param {string} ref */
  const resolve = (ref) => {
    if (!ref.startsWith('#/')) throw new Error(`ogs.js: only local $refs are supported, not ${ref}`);
    return ref.slice(2).split('/').reduce((s, k) => s?.[k.replaceAll('~1', '/').replaceAll('~0', '~')], schema);
  };
  const typeEnum = schema.$defs?.Neo4jType?.enum;
  /** @param {any} s @param {any} v @param {string} path @param {Array<{path: string, keyword: string, message: string}>} errors */
  const walk = (s, v, path, errors) => {
    if (s === true) return;
    if (s === false) { errors.push({ path, keyword: 'false schema', message: 'boolean schema is false' }); return; }
    for (const k of Object.keys(s)) if (!KNOWN_KEYWORDS.has(k)) throw new Error(`ogs.js: the schema uses ${k}, which this validator does not know`);
    if (s.$ref) walk(resolve(s.$ref), v, path, errors);
    if (s.type !== undefined && !hasType(s.type, v)) errors.push({ path, keyword: 'type', message: `must be ${typeWords(s.type)}, not ${show(v)}` });
    if (s.const !== undefined && !jsonEqual(s.const, v)) errors.push({ path, keyword: 'const', message: `must be ${show(s.const)}, not ${show(v)}` });
    if (s.enum && !s.enum.some((x) => jsonEqual(x, v))) {
      errors.push({ path, keyword: 'enum', message: s.enum === typeEnum
        ? `${show(v)} is not one of the spec's type tokens (STRING, INTEGER, FLOAT, BOOLEAN, DATE, ZONED DATETIME, LOCAL DATETIME, ZONED TIME, LOCAL TIME, DURATION, POINT, UUID, ANY, the sized INTEGER8/16/32 and FLOAT32, LIST<…> of most of them, VECTOR<…> of a number type)`
        : `must be one of ${s.enum.join(', ')}, not ${show(v)}` });
    }
    if (s.oneOf) {
      const branches = s.oneOf.map((b) => {
        /** @type {Array<{path: string, keyword: string, message: string}>} */
        const e = [];
        walk(b, v, path, e);
        return e;
      });
      const passing = branches.filter((e) => e.length === 0).length;
      if (passing === 0) {
        for (const e of branches) errors.push(...e);
        errors.push({ path, keyword: 'oneOf', message: 'matches none of the forms this field takes' });
      } else if (passing > 1) {
        errors.push({ path, keyword: 'oneOf', message: 'matches more than one of the forms this field takes' });
      }
    }
    if (Array.isArray(v) && s.items !== undefined) v.forEach((x, i) => walk(s.items, x, path + ptr(i), errors));
    if (isMap(v)) {
      for (const k of s.required ?? []) {
        if (!Object.hasOwn(v, k)) errors.push({ path, keyword: 'required', message: `\`${k}\` is missing` });
      }
      const props = s.properties ?? {};
      for (const [k, x] of Object.entries(v)) {
        if (Object.hasOwn(props, k)) walk(props[k], x, path + ptr(k), errors);
        else if (s.additionalProperties === false) errors.push({ path, keyword: 'additionalProperties', message: `\`${k}\` is not a field here` });
        else if (s.additionalProperties !== undefined) walk(s.additionalProperties, x, path + ptr(k), errors);
      }
    }
  };
  /** @type {Array<{path: string, keyword: string, message: string}>} */
  const errors = [];
  walk(schema, doc, '', errors);
  return errors;
}

// ---- the SDK check ------------------------------------------------------------------------------------

/** `$.nodes['a'].properties['b'].type` (a decoder path) as a JSON Pointer. @param {string} p */
function decoderPointer(p) {
  let out = '';
  const re = /\.([A-Za-z_][\w]*)|\['((?:[^'\\]|\\.)*)'\]|\[(\d+)\]/g;
  for (const m of p.replace(/^\$/, '').matchAll(re)) out += ptr(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * The SDK's decode and core validation (lib/ogs.mjs): [{path, keyword: 'sdk:<code>', message}].
 * @param {unknown} doc
 */
export function validateSpec(doc) {
  const v = OGS.validate(doc, ['core']);
  return v.issues.map((i) => {
    const at = /\bat path:? (\$\S*)/.exec(i.message);
    return {
      path: i.set === 'decode' ? (at ? decoderPointer(at[1]) : '') : i.path,
      keyword: `sdk:${i.code}`,
      message: i.message,
    };
  });
}

// ---- the rules (checkDocument) ----------------------------------------------------------------------------

/** One custom extension's value in an `extensions` map, or undefined. @param {any} ext @param {string} type */
export function custom(ext, type) {
  return isMap(ext) && isMap(ext.custom) && Object.hasOwn(ext.custom, type) ? ext.custom[type] : undefined;
}
/** An element's tools (`extensions.custom.tools`), or []. @param {any} el */
export function toolsOf(el) {
  const t = custom(el?.extensions, EXTENSIONS.tools);
  return Array.isArray(t) ? t : [];
}
/** A node's identifier label (labels.identifier, else label), or null. @param {any} node */
export function nodeLabel(node) {
  if (!isMap(node)) return null;
  if (isMap(node.labels) && typeof node.labels.identifier === 'string') return node.labels.identifier;
  return typeof node.label === 'string' ? node.label : null;
}

/**
 * The custom extensions this example reads, under `extensions.custom`, and the place each may sit.
 * edgextract:gazetteer (rule 1's listed names) and edgextract:symmetric keep the names edgextract
 * gave the two features; any document may carry them. `tools` holds the ontology's tools (the
 * published spec has no tool field).
 */
export const EXTENSIONS = Object.freeze({
  pole: 'createContextGraph:pole',
  origin: 'createContextGraph:origin',
  domain: 'createContextGraph:domain',
  gazetteer: 'edgextract:gazetteer',
  symmetric: 'edgextract:symmetric',
  tools: 'tools',
});

/**
 * The rules a schema- and SDK-valid document must also follow (see the header): [{path, keyword: 'semantic', message}].
 * @param {any} doc  a document validateSchema and validateSpec accepted
 */
export function checkDocument(doc) {
  /** @type {Array<{path: string, keyword: string, message: string}>} */
  const errors = [];
  const err = (path, message) => errors.push({ path, keyword: 'semantic', message });
  if (doc.schema !== SCHEMA_ID) {
    err('/schema', `names ${show(doc.schema)}; this page reads version ${SPEC_VERSION} of the Ontology Graph Spec, ${SCHEMA_ID}`);
  }
  const nodes = isMap(doc.nodes) ? doc.nodes : {};
  const rels = isMap(doc.relationships) ? doc.relationships : {};
  const ccg = custom(doc.extensions, EXTENSIONS.domain) !== undefined;

  /** @type {Map<string, string>} identifier label -> node id */
  const byLabel = new Map();
  /** Properties and tools of a node or relationship entry. @param {string} at @param {any} el */
  const element = (at, el) => {
    const props = isMap(el.properties) ? el.properties : {};
    for (const [name, p] of Object.entries(props)) {
      const pp = `${at}/properties${ptr(name)}`;
      if (p.dimension !== undefined && p.dimension !== null && !(typeof p.type === 'string' && p.type.startsWith('VECTOR<'))) {
        err(`${pp}/dimension`, `goes with a VECTOR<…> type, not ${show(p.type ?? null)}`);
      }
      if (p.key === true && (p.must_exist === false || p.unique === false)) {
        err(pp, 'key implies unique and must_exist; it cannot go with must_exist: false or unique: false');
      }
    }
    const tp = `${at}/extensions/custom/tools`;
    const raw = custom(el.extensions, EXTENSIONS.tools);
    if (raw !== undefined && !Array.isArray(raw)) {
      err(tp, `the tools are a list, not ${show(raw)}`);
      return;
    }
    const names = new Set();
    (raw ?? []).forEach((t, i) => {
      if (!isMap(t) || typeof t.type !== 'string' || t.type === '') {
        err(`${tp}/${i}`, `a tool is {type, name?, description?, …}, not ${show(t)}`);
        return;
      }
      if (t.name !== undefined && typeof t.name !== 'string') err(`${tp}/${i}/name`, `a tool's name is text, not ${show(t.name)}`);
      if (t.description !== undefined && typeof t.description !== 'string') err(`${tp}/${i}/description`, `a tool's description is text, not ${show(t.description)}`);
      if (typeof t.name === 'string') {
        if (names.has(t.name)) err(`${tp}/${i}/name`, `two tools here are named ${show(t.name)}`);
        names.add(t.name);
      }
      if (t.type === 'canonicalQuery' && t.cypher !== undefined && typeof t.cypher !== 'string') {
        err(`${tp}/${i}/cypher`, `a canonicalQuery tool's query is text, not ${show(t.cypher)}`);
      }
      if (t.parameters !== undefined && (!Array.isArray(t.parameters) || t.parameters.some((x) => !isMap(x) || typeof x.name !== 'string' || x.name === ''))) {
        err(`${tp}/${i}/parameters`, 'parameters are a list of {name, type?, description?, ...}, each with a name');
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
    if (typeof node.label === 'string' && isMap(node.labels) && typeof node.labels.identifier === 'string' && node.label !== node.labels.identifier) {
      err(at, `\`label\` (${node.label}) and \`labels.identifier\` (${node.labels.identifier}) disagree; keep one of them`);
    }
    const bad = idProblem('label', id);
    if (bad) err(isMap(node.labels) && typeof node.labels.identifier === 'string' ? `${at}/labels/identifier` : `${at}/label`, bad);
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
    const pole = custom(node.extensions, EXTENSIONS.pole);
    if (pole !== undefined && (!isMap(pole) || typeof pole.pole_type !== 'string' || pole.pole_type.trim() === '' ||
      (pole.subtype !== undefined && pole.subtype !== null && typeof pole.subtype !== 'string') ||
      (pole.origin !== undefined && pole.origin !== 'base' && pole.origin !== 'domain'))) {
      err(`${at}/extensions/custom/${EXTENSIONS.pole}`, `is {pole_type, subtype?, origin?: base|domain}, not ${show(pole)}`);
    }
    if (ccg && pole === undefined) err(at, `a create-context-graph document (${EXTENSIONS.domain}) gives every node a ${EXTENSIONS.pole} extension`);
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
      if (typeof r[end].node !== 'string') err(`${at}/${end}`, 'names its node with `node` (the node\'s id in this document)');
    }
    const t = `${r.type}|${r.from.node}|${r.to.node}`;
    const dup = triples.get(t);
    if (dup !== undefined) err(at, `repeats ${show(dup)}: the same type between the same nodes`);
    else triples.set(t, key);
    element(at, r);
    const s = byType.get(r.type) ?? { symmetric: new Set(), origin: new Set() };
    s.symmetric.add(custom(r.extensions, EXTENSIONS.symmetric) !== undefined);
    const origin = custom(r.extensions, EXTENSIONS.origin);
    if (origin !== undefined) {
      if (!isMap(origin) || (origin.origin !== 'base' && origin.origin !== 'domain')) {
        err(`${at}/extensions/custom/${EXTENSIONS.origin}`, `is {origin: base|domain}, not ${show(origin)}`);
      } else s.origin.add(origin.origin);
    }
    byType.set(r.type, s);
  }
  for (const [type, s] of byType) {
    if (s.symmetric.size > 1) err('/relationships', `the entries of ${type} disagree on ${EXTENSIONS.symmetric}: put it on all of them or none`);
    if (s.origin.size > 1) err('/relationships', `the entries of ${type} disagree on ${EXTENSIONS.origin}`);
  }

  const gaz = custom(doc.extensions, EXTENSIONS.gazetteer);
  if (gaz !== undefined) {
    if (!isMap(gaz)) {
      err(`/extensions/custom/${EXTENSIONS.gazetteer}`, `maps names to node ids, not ${show(gaz)}`);
    } else {
      for (const [name, kind] of Object.entries(gaz)) {
        if (rustTrim(name) === '') err(`/extensions/custom/${EXTENSIONS.gazetteer}`, 'an empty name');
        if (typeof kind !== 'string' || !Object.hasOwn(nodes, kind)) err(`/extensions/custom/${EXTENSIONS.gazetteer}`, `${show(name)} maps to ${show(kind)}, which is not a node of this document`);
      }
    }
  }
  const dom = custom(doc.extensions, EXTENSIONS.domain);
  if (dom !== undefined && dom !== null && !isMap(dom)) err(`/extensions/custom/${EXTENSIONS.domain}`, `is a mapping, not ${show(dom)}`);
  if (custom(doc.extensions, EXTENSIONS.tools) !== undefined) err(`/extensions/custom/${EXTENSIONS.tools}`, 'tools sit on a node or a relationship, not on the document');
  return errors;
}

/**
 * The schema, then (when the schema holds) the SDK, then (when the SDK accepts it) the rules.
 * @param {unknown} doc
 * @returns {{ok: boolean, stage: 'schema'|'sdk'|'rules'|null, errors: Array<{path: string, keyword: string, message: string}>}}
 */
export function validateDocument(doc) {
  const schema = validateSchema(doc);
  if (schema.length) return { ok: false, stage: 'schema', errors: schema };
  const spec = validateSpec(doc);
  if (spec.length) return { ok: false, stage: 'sdk', errors: spec };
  const rules = checkDocument(doc);
  return { ok: rules.length === 0, stage: rules.length ? 'rules' : null, errors: rules };
}

// ---- earlier builds' draft documents ------------------------------------------------------------------

/** Is this a document in the draft format earlier builds shipped (`$schema`)? @param {unknown} doc */
export const isDraft = (doc) => libIsDraft(doc);

/**
 * A draft document converted to the published format (lib/ogs.mjs DRAFT_MAPPING), or an
 * OntologyError naming what has no place there.
 * @param {any} doc
 */
export function fromDraft(doc) {
  try {
    return libFromDraft(doc);
  } catch (e) {
    if (e instanceof LibOntologyError) throw new OntologyError(`This draft Ontology Graph Spec document cannot be converted: ${e.message}`);
    throw e;
  }
}

// ---- serialisation ------------------------------------------------------------------------------------

/** Each spec-defined object's fields, in the order the schema lists them. */
const ORDER = {
  root: FIELD_ORDER.doc,
  node: FIELD_ORDER.node,
  labels: ['identifier', 'implied', 'optional', 'extensions'],
  property: FIELD_ORDER.property,
  relationship: FIELD_ORDER.relationship,
  endpoint: FIELD_ORDER.target,
  constraint: ['type', 'properties', 'extensions', 'name'],
  nodeExt: FIELD_ORDER.nodeExt,
  relExt: FIELD_ORDER.relExt,
  docExt: FIELD_ORDER.docExt,
  display: FIELD_ORDER.display,
  index: ['type', 'labels', 'properties', 'options', 'custom', 'name'],
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
 * The document rebuilt with its known structure walked: `fixed(order, obj)` makes a spec-defined
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
  const payloads = (/** @type {any} */ m) => map(m, clone);
  const nodeIndex = (x) => fixed(ORDER.index, x);
  const relIndex = (x) => fixed(ORDER.index.filter((k) => k !== 'labels'), x);
  const display = (d) => fixed(ORDER.display, d);
  const nodeExt = (e) => fixed(ORDER.nodeExt, e, { indexes: (m) => map(m, nodeIndex), display, custom: payloads });
  const relExt = (e) => fixed(ORDER.relExt, e, { indexes: (m) => map(m, relIndex), custom: payloads });
  const plainExt = (e) => fixed(['custom'], e, { custom: payloads });
  const docExt = (e) => fixed(ORDER.docExt, e, { custom: payloads });
  const property = (p) => fixed(ORDER.property, p, { extensions: plainExt });
  const constraint = (c) => fixed(ORDER.constraint, c, { extensions: plainExt });
  const element = {
    properties: (m) => map(m, property),
    constraints: (m) => map(m, constraint),
  };
  const node = (n) => fixed(ORDER.node, n, { ...element, labels: (l) => fixed(ORDER.labels, l, { extensions: plainExt }), extensions: nodeExt });
  const endpoint = (x) => fixed(ORDER.endpoint, x);
  const rel = (r) => fixed(ORDER.relationship, r, { ...element, from: endpoint, to: endpoint, extensions: relExt });
  return fixed(ORDER.root, doc, { nodes: (m) => map(m, node), relationships: (m) => map(m, rel), extensions: docExt });
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
