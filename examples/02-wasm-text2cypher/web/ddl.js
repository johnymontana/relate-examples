// @ts-check
/**
 * ddl.js: the ontology compiled into schema statements Relate enforces.
 *
 *   graphTypeStatement(doc)   ALTER CURRENT GRAPH TYPE SET { … }: every node label with its typed
 *                             properties (NOT NULL from `key` and `must_exist`) and every relationship
 *                             type with its one source and one target label and typed properties
 *   graphTypeSpec(doc)        the { … } body alone, as SHOW CURRENT GRAPH TYPE prints it
 *   constraintStatements(doc) indexStatements(doc) allStatements(doc)
 *                             a byte for byte port of the source app's cypher.py (constraints, then
 *                             indexes), checked against data/reference/ddl.cypher on every run
 *   schemaStatements(doc)     [graph type, ...allStatements]: the order the store applies them
 *
 * The order matters. A successful ALTER CURRENT GRAPH TYPE SET drops every constraint the store had,
 * and once a label is in the graph type, an existence constraint on it outside the graph type is
 * refused (IncompatibleGraphTypeDependence) unless the graph type already says NOT NULL (NOTES.md).
 * So the graph type goes first and carries the existence rules; the DDL after it re-states them (a
 * no-op) and adds the key and unique constraints and the indexes.
 *
 * Shared by the engine worker and the Node harness: imports ontology.js and py.js only.
 */
import { iterConstraints, iterIndexes, legalRelationships, nodeLabel } from './ontology.js';
import { cmpStr, truthy } from './py.js';

export class DdlError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'DdlError';
  }
}

/** @param {unknown} m @returns {Record<string, any>} */
const map = (m) => (m && typeof m === 'object' && !Array.isArray(m) ? /** @type {Record<string, any>} */ (m) : {});

// ---- the graph type ------------------------------------------------------------------------------

/** Spec scalar types a Relate 1.3.0 graph type accepts as property types (probes.txt). */
const GRAPH_TYPE_SCALARS = new Set(['STRING', 'INTEGER', 'FLOAT', 'BOOLEAN', 'DATE', 'DURATION', 'POINT',
  'LOCAL DATETIME', 'LOCAL TIME', 'ZONED DATETIME', 'ZONED TIME', 'UUID']);
/** Spec vector coordinate types a graph type accepts, as VECTOR<T>(dimension). */
const VECTOR_COORDS = new Set(['FLOAT', 'FLOAT32', 'INTEGER', 'INTEGER8', 'INTEGER16', 'INTEGER32']);

/**
 * One ontology property type as a graph-type property type, in the spelling SHOW CURRENT GRAPH TYPE
 * reads back. A list's elements are NOT NULL (the engine refuses a nullable inner type), and so are
 * a vector's coordinates; a vector needs the property's `dimension`. ANY, LIST<ANY>
 * and the sized scalars (FLOAT32, INTEGER8/16/32) have no graph-type form and are refused.
 * @param {Record<string, any>} prop @param {string} where
 */
export function graphTypeOf(prop, where) {
  const t = prop.type;
  if (typeof t !== 'string') throw new DdlError(`${where}: no type`);
  if (GRAPH_TYPE_SCALARS.has(t)) return t;
  const list = /^LIST<(.+)>$/.exec(t);
  if (list && GRAPH_TYPE_SCALARS.has(list[1])) return `LIST<${list[1]} NOT NULL>`;
  const vec = /^VECTOR<(.+)>$/.exec(t);
  if (vec && VECTOR_COORDS.has(vec[1])) {
    if (!Number.isInteger(prop.dimension) || prop.dimension < 1) throw new DdlError(`${where}: ${t} needs a dimension`);
    return `VECTOR<${vec[1]} NOT NULL>(${prop.dimension})`;
  }
  throw new DdlError(`${where}: type ${t} has no graph-type form in Relate`);
}

/** @param {string} s */
const bt = (s) => `\`${s.replaceAll('`', '``')}\``;

/**
 * ` {…}` for a property map, sorted by name as the engine prints it; '' when there are none.
 * @param {Record<string, any>} props @param {string} where
 */
function propsSpec(props, where) {
  const items = Object.entries(props).sort((a, b) => cmpStr(a[0], b[0])).map(([pid, p]) =>
    `${bt(pid)} :: ${graphTypeOf(p, `${where}.${pid}`)}${truthy(p.key) || truthy(p.must_exist) ? ' NOT NULL' : ''}`);
  return items.length ? ` {${items.join(', ')}}` : '';
}

/**
 * The graph type's elements: node types sorted by label, then relationship types sorted by type
 * (code-point order). Throws DdlError when a relationship type has two signatures (a graph type
 * allows one source and one target label per type) or a property type has no graph-type form.
 * @param {Record<string, any>} doc
 */
export function graphTypeElements(doc) {
  const nodes = Object.entries(map(doc.nodes)).map(([nid, n]) => {
    const label = nodeLabel(n);
    return [label, `(:${bt(label)} =>${propsSpec(map(n.properties), `nodes.${nid}.properties`)})`];
  });
  /** @type {Map<string, string>} */
  const rels = new Map();
  const legal = legalRelationships(doc);
  for (const [rid, rel] of Object.entries(map(doc.relationships))) {
    const sig = legal[rid];
    if (rels.has(sig.type)) throw new DdlError(`relationships.${rid}: ${sig.type} has more than one signature; a graph type allows one`);
    rels.set(sig.type, `(:${bt(sig.from)} =>)-[:${bt(sig.type)} =>${propsSpec(map(rel.properties), `relationships.${rid}.properties`)}]->(:${bt(sig.to)} =>)`);
  }
  nodes.sort((a, b) => cmpStr(a[0], b[0]));
  const relList = [...rels.entries()].sort((a, b) => cmpStr(a[0], b[0]));
  return [...nodes.map((x) => x[1]), ...relList.map((x) => x[1])];
}

/**
 * The graph type body in the layout SHOW CURRENT GRAPH TYPE prints (one element per line), so the
 * store's readback can be compared with it as text. The readback also lists, after the elements,
 * every key and unique constraint created on a graph-typed label as a CONSTRAINT item (NOTES.md);
 * readbackElements() strips those.
 * @param {Record<string, any>} doc
 */
export function graphTypeSpec(doc) {
  const elements = graphTypeElements(doc);
  return elements.length ? `{\n  ${elements.join(',\n  ')}\n}` : '{}';
}

/**
 * A SHOW CURRENT GRAPH TYPE specification split into its elements and its CONSTRAINT items.
 * @param {string} spec
 */
export function readbackElements(spec) {
  const items = spec.split('\n').slice(1, -1).map((l) => l.trim().replace(/,$/, ''));
  return { elements: items.filter((x) => !x.startsWith('CONSTRAINT ')), constraints: items.filter((x) => x.startsWith('CONSTRAINT ')) };
}

/** @param {Record<string, any>} doc */
export function graphTypeStatement(doc) {
  return `ALTER CURRENT GRAPH TYPE SET ${graphTypeSpec(doc)}`;
}

// ---- constraints and indexes (cypher.py) ---------------------------------------------------------

/** @type {Record<string, string>} */
const CONSTRAINT_KIND = { KEY: 'NODE KEY', UNIQUE: 'UNIQUE', EXISTS: 'NOT NULL' };

/** @param {string[]} props @param {string} v */
function propsCypher(props, v) {
  return props.length === 1 ? `${v}.${props[0]}` : '(' + props.map((p) => `${v}.${p}`).join(', ') + ')';
}

/** One CREATE CONSTRAINT per declared constraint. @param {Record<string, any>} doc */
export function constraintStatements(doc) {
  const out = [];
  for (const c of iterConstraints(doc)) {
    let target;
    let req;
    if (c.element === 'node') {
      target = `FOR (n:${c.labelOrType})`;
      const kind = CONSTRAINT_KIND[c.type];
      if (kind === undefined) throw new DdlError(`constraint ${c.name}: type ${c.type} has no DDL here`);
      req = c.type === 'EXISTS' ? `REQUIRE ${propsCypher(c.properties, 'n')} IS NOT NULL`
        : `REQUIRE ${propsCypher(c.properties, 'n')} IS ${kind}`;
    } else {
      target = `FOR ()-[r:${c.labelOrType}]-()`;
      if (c.type === 'EXISTS') req = `REQUIRE ${propsCypher(c.properties, 'r')} IS NOT NULL`;
      else if (c.type === 'KEY') req = `REQUIRE ${propsCypher(c.properties, 'r')} IS RELATIONSHIP KEY`;
      else req = `REQUIRE ${propsCypher(c.properties, 'r')} IS ${c.type}`;
    }
    out.push(`CREATE CONSTRAINT ${c.name} IF NOT EXISTS ${target} ${req}`);
  }
  return out;
}

/** The OPTIONS clause for FULLTEXT and VECTOR indexes. @param {import('./ontology.js').Index} idx */
function indexOptions(idx) {
  if (idx.type === 'FULLTEXT') {
    const analyzer = idx.options['fulltext.analyzer'];
    if (truthy(analyzer)) return " OPTIONS {indexConfig: {`fulltext.analyzer`: '" + analyzer + "'}}";
  }
  if (idx.type === 'VECTOR') {
    const dims = idx.options['vector.dimensions'];
    const sim = idx.options['vector.similarity_function'] ?? 'cosine';
    const cfg = [];
    if (truthy(dims)) cfg.push(`\`vector.dimensions\`: ${Math.trunc(Number(dims))}`);
    cfg.push(`\`vector.similarity_function\`: '${sim}'`);
    return ' OPTIONS {indexConfig: {' + cfg.join(', ') + '}}';
  }
  return '';
}

/** One CREATE … INDEX per index declared in extensions. @param {Record<string, any>} doc */
export function indexStatements(doc) {
  const out = [];
  for (const idx of iterIndexes(doc)) {
    const props = idx.properties.map((p) => `n.${p}`).join(', ');
    if (idx.element === 'node') {
      if (idx.type === 'FULLTEXT') {
        out.push(`CREATE FULLTEXT INDEX ${idx.name} IF NOT EXISTS FOR (n:${idx.labelOrType}) ON EACH [${props}]` + indexOptions(idx));
      } else if (idx.type === 'VECTOR') {
        out.push(`CREATE VECTOR INDEX ${idx.name} IF NOT EXISTS FOR (n:${idx.labelOrType}) ON n.${idx.properties[0]}` + indexOptions(idx));
      } else if (idx.type === 'TEXT') {
        out.push(`CREATE TEXT INDEX ${idx.name} IF NOT EXISTS FOR (n:${idx.labelOrType}) ON (${props})`);
      } else {
        const kw = idx.type === 'POINT' ? 'POINT INDEX' : idx.type === 'LOOKUP' ? 'LOOKUP INDEX' : 'INDEX';
        out.push(`CREATE ${kw} ${idx.name} IF NOT EXISTS FOR (n:${idx.labelOrType}) ON (${props})`);
      }
    } else {
      const propsR = idx.properties.map((p) => `r.${p}`).join(', ');
      const kw = { FULLTEXT: 'FULLTEXT INDEX', TEXT: 'TEXT INDEX', VECTOR: 'VECTOR INDEX', POINT: 'POINT INDEX' }[idx.type] ?? 'INDEX';
      out.push(kw === 'FULLTEXT INDEX'
        ? `CREATE ${kw} ${idx.name} IF NOT EXISTS FOR ()-[r:${idx.labelOrType}]-() ON EACH [${propsR}]`
        : `CREATE ${kw} ${idx.name} IF NOT EXISTS FOR ()-[r:${idx.labelOrType}]-() ON (${propsR})`);
    }
  }
  return out;
}

/** Constraints first, then indexes: the source app's full DDL. @param {Record<string, any>} doc */
export function allStatements(doc) {
  return [...constraintStatements(doc), ...indexStatements(doc)];
}

/** Everything the store applies, in order. @param {Record<string, any>} doc */
export function schemaStatements(doc) {
  return [graphTypeStatement(doc), ...allStatements(doc)];
}
