// @ts-check
/**
 * lib/ogs.mjs: the published Neo4j Ontology Graph Specification, spec 1.1.0
 * (https://neo4j.com/docs/ontology-graph-spec/), read through its official SDK, npm
 * `@neo4j/ontology-graph-spec` (each example pins its own copy in package.json and
 * package-lock.json). Examples 01 and 02 and their harnesses share it, in Node and in the browser.
 *
 * It imports nothing. createOgs({yaml, sdk}) takes js-yaml and the SDK module from its caller, so
 * each example resolves its own pinned copies and a page passes the copies it serves:
 *
 *   import yaml from 'js-yaml';
 *   import * as sdk from '@neo4j/ontology-graph-spec';
 *   const ogs = createOgs({ yaml, sdk });
 *   ogs.parse(text)               YAML or JSON text -> a plain object (YAML core schema, one document)
 *   ogs.decode(doc)               the SDK's GraphModel (GraphSpec.Json.decodeFromString), OntologyError if refused
 *   ogs.validate(doc, sets)       {ok, issues: [{set, code, path, message}]}: the SDK's validation sets
 *   ogs.encode(doc, 'yaml'|'json') the SDK's own serialisation of the decoded model
 *   ogs.sdkVersion                the SDK version the caller passed (for reports)
 *
 * The plain object, not the SDK model, is what callers read: the SDK expands shorthand (`key`,
 * `unique`, `must_exist`, `label`) into constraints and labels on decode, and both examples
 * read the document as written.
 *
 * Why decode goes through JSON. The SDK's YAML decoder misreads an unquoted plain scalar that
 * contains `<…>` (`type: LIST<STRING>`, `type: VECTOR<FLOAT32>`: valid YAML) and throws
 * `Neo4jType does not contain element with name ''`; quoted, the same document decodes. js-yaml
 * reads the YAML and the SDK decodes the JSON of the result, so any valid YAML works.
 *
 * Draft documents. Example 01 shipped documents in a draft of the spec (neo4j/graph-spec, branch
 * oskar/ontology-spec-v1-jsonschema at 35e74c0: `$schema`, an integer `version`, `mustExist`,
 * `neo4j:display`, `custom` as a list of {type, definition}, node `tools`). isDraft(doc) recognises
 * one and fromDraft(doc) converts it, losslessly, into a published document (DRAFT_MAPPING below).
 */

export const SPEC_VERSION = '1.1.0';
export const SCHEMA_URL = `https://neo4j.com/docs/ontology-graph-spec/${SPEC_VERSION}/schema.json`;
/** The `$schema` of the draft example 01 used to ship. */
export const DRAFT_SCHEMA_URL = 'https://neo4j.com/ontology-graph-spec/1.0.0/schema.json';
/** The SDK's validation sets, in the order a report lists them (`all` is their union). */
export const VALIDATION_SETS = Object.freeze(['core', 'labelled', 'consistentSchema', 'mappable', 'bulkImportable', 'wellConstrained']);

export class OntologyError extends Error {
  /** @param {string} message @param {Array<{set: string, code: string, path: string, message: string}>} [issues] */
  constructor(message, issues = []) {
    super(message);
    this.name = 'OntologyError';
    this.issues = issues;
  }
}

/** A plain mapping (not a list, null or a date). @param {unknown} v @returns {v is Record<string, any>} */
export const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/** The first line of an SDK exception, without its `JSON input: …` excerpt. @param {unknown} e */
function sdkMessage(e) {
  const msg = String(/** @type {any} */ (e)?.message ?? e);
  return msg.split('\n')[0].trim();
}

/**
 * @param {{yaml: any, sdk: any, sdkVersion?: string}} deps  js-yaml's default export and the SDK module
 */
export function createOgs({ yaml, sdk, sdkVersion = 'unknown' }) {
  const { GraphSpec, GraphModel, Validations } = sdk;
  if (!GraphSpec?.Json || !GraphModel?.validate || !Validations) throw new TypeError('createOgs: sdk is not @neo4j/ontology-graph-spec');

  /**
   * A YAML or JSON text as a value, in YAML's core schema (JSON is YAML; no dates, no merge keys),
   * one document only. Throws OntologyError with the line and column of a syntax error.
   * @param {string} text @param {string} [what] how the message names the text
   */
  function parse(text, what) {
    if (typeof text !== 'string') throw new TypeError('parse: text must be a string');
    const name = what ?? (/^\s*[{[]/.test(text) ? 'The JSON' : 'The YAML');
    try {
      return yaml.load(text, { schema: yaml.CORE_SCHEMA });
    } catch (e) {
      const err = /** @type {any} */ (e);
      const where = err?.mark ? ` (line ${err.mark.line + 1}, column ${err.mark.column + 1})` : '';
      throw new OntologyError(`${name} does not parse: ${err?.reason ?? String(err?.message ?? err).split('\n')[0]}${where}`);
    }
  }

  /** The SDK's model of a plain document. @param {unknown} doc */
  function decode(doc) {
    if (!isMap(doc)) throw new OntologyError('An ontology document is a mapping', [{ set: 'decode', code: 'not_a_mapping', path: '', message: 'the document is not a mapping' }]);
    try {
      return GraphSpec.Json.decodeFromString(JSON.stringify(doc));
    } catch (e) {
      const message = sdkMessage(e);
      throw new OntologyError(`The Ontology Graph Spec SDK refuses the document: ${message}`, [{ set: 'decode', code: 'decode', path: '', message }]);
    }
  }

  /**
   * The SDK's validation of a plain document. A document the SDK cannot decode gives one issue of
   * set 'decode' and nothing else.
   * @param {unknown} doc @param {readonly string[]} [sets]
   */
  function validate(doc, sets = ['core']) {
    let model;
    try {
      model = decode(doc);
    } catch (e) {
      if (e instanceof OntologyError) return { ok: false, issues: e.issues };
      throw e;
    }
    /** @type {Array<{set: string, code: string, path: string, message: string}>} */
    const issues = [];
    for (const set of sets) {
      const list = Validations[set];
      if (!list) throw new TypeError(`validate: unknown validation set ${set}`);
      for (const i of GraphModel.validate(model, list).asJsReadonlyArrayView()) {
        issues.push({ set, code: String(i.code), path: String(i.path ?? ''), message: String(i.message ?? '') });
      }
    }
    return { ok: issues.length === 0, issues };
  }

  /** The SDK's own serialisation. @param {unknown} doc @param {'yaml'|'json'} format */
  function encode(doc, format) {
    const model = decode(doc);
    return format === 'yaml' ? GraphSpec.Yaml.encodeToString(model) : GraphSpec.Json.encodeToString(model);
  }

  return { parse, decode, validate, encode, sdkVersion };
}

// ---- draft documents ----------------------------------------------------------------------------

/**
 * How fromDraft maps a draft document (left) onto the published format (right).
 * Exported for the examples' docs and harnesses; fromDraft is the implementation.
 */
export const DRAFT_MAPPING = Object.freeze([
  ['$schema: https://neo4j.com/ontology-graph-spec/1.0.0/schema.json', `schema: ${SCHEMA_URL}`],
  ['version: <integer>', 'version: "<integer>" (a string)'],
  ['property mustExist', 'property must_exist'],
  ['type DATETIME, LOCALDATETIME, TIME, LOCALTIME (also inside LIST<…>)', 'type ZONED DATETIME, LOCAL DATETIME, ZONED TIME, LOCAL TIME'],
  ['type BYTES', 'refused: the published spec has no byte type'],
  ['node extensions.neo4j:display {color, caption, …}', 'node extensions.display {x, y, colour, custom: {caption, …}}: x and y from layoutPoint()'],
  ['extensions.custom [{type: T, definition: D}, …] (document, node, relationship, property)', 'extensions.custom {T: D, …} (T: {} without a definition)'],
  ['any other <namespace>:<name> extension key E', 'extensions.custom.E'],
  ['node or relationship tools [...]', 'extensions.custom.tools [...] on the same element'],
  ['constraints [{constraint_type: key|unique|mustExist, name?, properties}]', 'constraints {<name, else kind_props>: {type: KEY|UNIQUE|EXISTS, properties, name?}}'],
  ['custom envelope with $schema or name', 'extensions.custom.T: {definition, $schema, name, …}'],
]);

/** Is this a draft document (example 01's earlier format)? @param {unknown} doc */
export function isDraft(doc) {
  return isMap(doc) && Object.hasOwn(doc, '$schema') && !Object.hasOwn(doc, 'schema');
}

/**
 * A node's place on a circle of radius 300 around the origin, the first node at the top and the
 * rest clockwise in document order: whole numbers, the same for the same node count. The draft
 * had no coordinates and the published `display` requires them.
 * @param {number} i @param {number} n
 */
export function layoutPoint(i, n) {
  const a = (2 * Math.PI * i) / Math.max(n, 1) - Math.PI / 2;
  const r = (v) => {
    const x = Math.round(300 * v);
    return Object.is(x, -0) ? 0 : x;
  };
  return { x: r(Math.cos(a)), y: r(Math.sin(a)) };
}

/** Field orders of the published schema (ontology-graph-spec.schema.json, 1.1.0). */
const ORDER = Object.freeze({
  doc: ['schema', 'version', 'id', 'name', 'description', 'nodes', 'relationships', 'extensions'],
  node: ['label', 'labels', 'properties', 'constraints', 'extensions', 'description', 'aliases', 'reference'],
  property: ['type', 'dimension', 'must_exist', 'unique', 'key', 'extensions', 'name', 'description', 'aliases', 'reference', 'pattern', 'one_of'],
  relationship: ['type', 'from', 'to', 'properties', 'constraints', 'extensions', 'description', 'aliases', 'reference'],
  target: ['node', 'label', 'count', 'min_count', 'max_count'],
  nodeExt: ['indexes', 'display', 'custom'],
  relExt: ['indexes', 'custom'],
  docExt: ['data_source_tables', 'data_source_mappings', 'custom'],
  display: ['x', 'y', 'colour', 'custom'],
});

/**
 * A copy of obj with the keys in `order` first (in that order), then any others in their own order.
 * @param {Record<string, any>} obj @param {readonly string[]} order
 */
export function ordered(obj, order) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of order) if (Object.hasOwn(obj, k) && obj[k] !== undefined) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!order.includes(k) && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Draft type tokens the published spec spells differently (its Neo4jType enum). */
export const DRAFT_TYPES = Object.freeze({
  DATETIME: 'ZONED DATETIME', LOCALDATETIME: 'LOCAL DATETIME', TIME: 'ZONED TIME', LOCALTIME: 'LOCAL TIME',
});

/** A draft type token in the published spelling. @param {unknown} t @param {string} where */
export function typeFromDraft(t, where) {
  if (typeof t !== 'string') return t;
  const m = /^(LIST|VECTOR)<(.+)>$/.exec(t);
  const scalar = m ? m[2] : t;
  if (scalar === 'BYTES') throw new OntologyError(`${where}: type ${t} has no equivalent in the published spec`);
  const mapped = Object.hasOwn(DRAFT_TYPES, scalar) ? DRAFT_TYPES[/** @type {keyof typeof DRAFT_TYPES} */ (scalar)] : scalar;
  return m ? `${m[1]}<${mapped}>` : mapped;
}

/**
 * A draft `custom` list as a published map: an envelope {type: T, definition: D} becomes T: D (T: {}
 * when it has no definition, since the SDK refuses a null value); one that also carries `$schema`,
 * `name` or other fields becomes T: {definition: D, $schema, name, …}, so nothing is lost. A type may
 * appear once per list.
 * @param {unknown} list @param {string} where
 */
function customMap(list, where) {
  if (list === undefined) return undefined;
  if (isMap(list)) return { ...list };
  if (!Array.isArray(list)) throw new OntologyError(`${where}: extensions.custom is neither a list nor a mapping`);
  /** @type {Record<string, any>} */
  const out = {};
  for (const [i, entry] of list.entries()) {
    if (!isMap(entry) || typeof entry.type !== 'string' || entry.type === '') {
      throw new OntologyError(`${where}: extensions.custom[${i}] has no type`);
    }
    if (Object.hasOwn(out, entry.type)) throw new OntologyError(`${where}: extensions.custom has two ${entry.type} entries; the published format keeps one per type`);
    const { type, definition, ...rest } = entry;
    // The SDK refuses a null custom value: an envelope with no definition (a flag, such as
    // edgextract:symmetric) becomes an empty mapping.
    const def = definition === undefined || definition === null ? {} : definition;
    out[type] = Object.keys(rest).length ? { ...(definition === undefined ? {} : { definition }), ...rest } : def;
  }
  return out;
}

/** Draft constraint kinds and their published names. */
const DRAFT_CONSTRAINTS = Object.freeze({ key: 'KEY', unique: 'UNIQUE', mustExist: 'EXISTS' });

/**
 * A draft `constraints` list ({constraint_type, name?, properties}) as a published map, keyed by
 * the constraint's name, else by `<kind>_<properties joined by _>` (with `_2`, `_3`, … on a clash).
 * @param {unknown} list @param {string} where
 */
function constraintsFrom(list, where) {
  if (list === undefined) return undefined;
  if (isMap(list)) return { ...list };
  if (!Array.isArray(list)) throw new OntologyError(`${where}: constraints is neither a list nor a mapping`);
  /** @type {Record<string, any>} */
  const out = {};
  for (const [i, c] of list.entries()) {
    if (!isMap(c)) throw new OntologyError(`${where}.constraints[${i}] is not a mapping`);
    const { constraint_type: kind, name, properties, ...rest } = c;
    if (!Object.hasOwn(DRAFT_CONSTRAINTS, kind)) throw new OntologyError(`${where}.constraints[${i}]: constraint_type ${JSON.stringify(kind)} is not key, unique or mustExist`);
    if (Object.keys(rest).length) throw new OntologyError(`${where}.constraints[${i}] has fields the published format has no place for (${Object.keys(rest).join(', ')})`);
    const base = typeof name === 'string' && name !== '' ? name : `${kind}_${(Array.isArray(properties) ? properties : []).join('_')}`;
    let id = base;
    for (let n = 2; Object.hasOwn(out, id); n++) id = `${base}_${n}`;
    out[id] = ordered({ type: DRAFT_CONSTRAINTS[/** @type {keyof typeof DRAFT_CONSTRAINTS} */ (kind)], properties, name }, ['type', 'properties', 'extensions', 'name']);
  }
  return out;
}

/**
 * A draft `extensions` object as a published one: `custom` becomes a map, every other key (a
 * `<namespace>:<name>` extension) moves into it, and `neo4j:display` becomes `display` on nodes.
 * @param {unknown} ext @param {'doc'|'node'|'rel'|'property'} kind @param {string} where
 * @param {{x: number, y: number}} [point] the node's coordinates
 * @param {any[]} [tools] the element's draft `tools`
 */
function extensionsFrom(ext, kind, where, point, tools) {
  if (ext !== undefined && !isMap(ext)) throw new OntologyError(`${where}: extensions is not a mapping`);
  const src = ext ?? {};
  /** @type {Record<string, any>} */
  const out = {};
  const custom = customMap(src.custom, where) ?? {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'custom') continue;
    if (kind === 'node' && k === 'neo4j:display') {
      if (!isMap(v)) throw new OntologyError(`${where}: extensions.neo4j:display is not a mapping`);
      const { color, ...rest } = v;
      out.display = ordered({ x: point?.x ?? 0, y: point?.y ?? 0, colour: color, custom: Object.keys(rest).length ? rest : undefined }, ORDER.display);
    } else if ((kind === 'node' || kind === 'rel') && k === 'indexes') {
      out.indexes = v;
    } else if (kind === 'doc' && (k === 'data_source_tables' || k === 'data_source_mappings')) {
      out[k] = v;
    } else {
      if (Object.hasOwn(custom, k)) throw new OntologyError(`${where}: extension ${k} is both a key and a custom entry`);
      custom[k] = v;
    }
  }
  if (tools !== undefined) {
    if (Object.hasOwn(custom, 'tools')) throw new OntologyError(`${where}: tools is both a field and a custom entry`);
    custom.tools = tools;
  }
  if (Object.keys(custom).length) out.custom = custom;
  if (!Object.keys(out).length) return undefined;
  const order = kind === 'node' ? ORDER.nodeExt : kind === 'rel' ? ORDER.relExt : kind === 'doc' ? ORDER.docExt : [];
  return ordered(out, order);
}

/** @param {unknown} props @param {string} where */
function propertiesFrom(props, where) {
  if (props === undefined) return undefined;
  if (!isMap(props)) throw new OntologyError(`${where}: properties is not a mapping`);
  /** @type {Record<string, any>} */
  const out = {};
  for (const [pid, p] of Object.entries(props)) {
    if (!isMap(p)) throw new OntologyError(`${where}.properties.${pid} is not a mapping`);
    const { mustExist, extensions, ...rest } = p;
    const q = { ...rest };
    if (q.type !== undefined) q.type = typeFromDraft(q.type, `${where}.properties.${pid}`);
    if (mustExist !== undefined) {
      if (Object.hasOwn(q, 'must_exist')) throw new OntologyError(`${where}.properties.${pid} has both mustExist and must_exist`);
      q.must_exist = mustExist;
    }
    const ext = extensionsFrom(extensions, 'property', `${where}.properties.${pid}`);
    if (ext) q.extensions = ext;
    out[pid] = ordered(q, ORDER.property);
  }
  return out;
}

/**
 * A draft document as a published one (DRAFT_MAPPING). The input is not changed. Anything the
 * mapping does not name is carried as it is; the SDK's validation then judges the result.
 * @param {Record<string, any>} doc
 */
export function fromDraft(doc) {
  if (!isDraft(doc)) throw new OntologyError('fromDraft: not a draft document (it has no $schema, or it has schema)');
  const { $schema, version, nodes, relationships, extensions, ...rest } = doc;
  /** @type {Record<string, any>} */
  const out = { ...rest, schema: SCHEMA_URL, version: version === undefined ? undefined : String(version) };
  if (nodes !== undefined) {
    if (!isMap(nodes)) throw new OntologyError('nodes is not a mapping');
    const ids = Object.keys(nodes);
    out.nodes = {};
    for (const [i, nid] of ids.entries()) {
      const n = nodes[nid];
      if (!isMap(n)) throw new OntologyError(`nodes.${nid} is not a mapping`);
      const { properties, constraints, extensions: next, tools, ...nrest } = n;
      const q = { ...nrest };
      const props = propertiesFrom(properties, `nodes.${nid}`);
      if (props) q.properties = props;
      const cons = constraintsFrom(constraints, `nodes.${nid}`);
      if (cons) q.constraints = cons;
      const ext = extensionsFrom(next, 'node', `nodes.${nid}`, layoutPoint(i, ids.length), tools);
      if (ext) q.extensions = ext;
      out.nodes[nid] = ordered(q, ORDER.node);
    }
  }
  if (relationships !== undefined) {
    if (!isMap(relationships)) throw new OntologyError('relationships is not a mapping');
    out.relationships = {};
    for (const [rid, r] of Object.entries(relationships)) {
      if (!isMap(r)) throw new OntologyError(`relationships.${rid} is not a mapping`);
      const { properties, constraints, extensions: rext, from, to, tools, ...rrest } = r;
      const q = { ...rrest };
      const cons = constraintsFrom(constraints, `relationships.${rid}`);
      if (cons) q.constraints = cons;
      if (from !== undefined) q.from = isMap(from) ? ordered(from, ORDER.target) : from;
      if (to !== undefined) q.to = isMap(to) ? ordered(to, ORDER.target) : to;
      const props = propertiesFrom(properties, `relationships.${rid}`);
      if (props) q.properties = props;
      const ext = extensionsFrom(rext, 'rel', `relationships.${rid}`, undefined, tools);
      if (ext) q.extensions = ext;
      out.relationships[rid] = ordered(q, ORDER.relationship);
    }
  }
  const ext = extensionsFrom(extensions, 'doc', 'the document');
  if (ext) out.extensions = ext;
  return ordered(out, ORDER.doc);
}

export const FIELD_ORDER = ORDER;
