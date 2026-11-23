// @ts-check
/**
 * load.js: the demo graph into a Relate store, and the store back out as the page's graph.
 *
 *   applySchema(db, exec, doc)          the ontology's schema statements (ddl.js schemaStatements), in order
 *   loadGraph(db, exec, graph, doc)     schema, then data/demo-graph.json's nodes and edges with the same
 *                                       MERGEs the source app's load_demo.py ran against Neo4j;
 *                                       returns {statements, nodes, relationships}
 *   graphPayload(db, exec, doc)         {nodes: [{id, label, group, color, props}], edges: [{from, to,
 *                                       type, props}]}: the source app's /api/graph shape, read from the
 *                                       store with Cypher, sorted by id (nodes) and (from, type, to) (edges)
 *
 * `exec` is lib/relate_wasm.mjs's exec (one statement; an error envelope throws). The store is
 * in-memory and rebuilt on every visit, so there is no completion marker: Relate's WASM build has
 * no transactions (every statement autocommits), and a half-loaded store is simply loaded again.
 *
 * Shared by the engine worker and the Node harness.
 */
import { schemaStatements } from './ddl.js';
import { nodeColours } from './ontology.js';

/** The default colour of a label the ontology gives none (the source app's). */
export const DEFAULT_COLOUR = '#4C8EDA';

/** Dynamic labels and types (NOTES.md): one statement for every label and every type. */
export const MERGE_NODE = 'MERGE (n:$($label) {id: $id}) SET n += $props';
/**
 * `supported` is a probability: toFloat() keeps it FLOAT even when a value is integral, since an
 * integral JS number binds as INTEGER (and the graph type declares FLOAT).
 */
export const MERGE_EDGE = 'MATCH (a {id: $f}), (b {id: $t}) MERGE (a)-[r:$($type)]->(b) '
  + 'SET r += $props SET r.supported = toFloat($props.supported)';

/**
 * @typedef {(db: any, query: string, params?: object|null, opts?: {allowNull?: boolean}) => {columns: string[], rows: any[], stats: Record<string, number>}} Exec
 * @typedef {{nodes: Array<{id: string, label: string, props: Record<string, any>}>, edges: Array<{from: string, type: string, to: string, props: Record<string, any>}>}} DemoGraph
 */

/** @param {any} db @param {Exec} exec @param {Record<string, any>} doc */
export function applySchema(db, exec, doc) {
  const statements = schemaStatements(doc);
  for (const s of statements) exec(db, s);
  return statements.length;
}

/** @param {any} db @param {Exec} exec @param {DemoGraph} graph @param {Record<string, any>} doc */
export function loadGraph(db, exec, graph, doc) {
  const statements = applySchema(db, exec, doc);
  let nodes = 0;
  let relationships = 0;
  for (const n of graph.nodes) {
    exec(db, MERGE_NODE, { label: n.label, id: n.id, props: n.props });
    nodes++;
  }
  for (const e of graph.edges) {
    if (typeof e.props?.supported !== 'number') throw new Error(`edge ${e.from}-${e.type}->${e.to} has no numeric supported`);
    const { rows } = exec(db, `${MERGE_EDGE} RETURN count(r) AS n`, { f: e.from, t: e.to, type: e.type, props: e.props });
    if (rows[0]?.n !== 1) throw new Error(`edge ${e.from}-${e.type}->${e.to}: an end node is missing`);
    relationships++;
  }
  return { statements, nodes, relationships };
}

const NODES_Q = 'MATCH (n) RETURN n.id AS id, labels(n) AS labels, properties(n) AS props ORDER BY id';
const EDGES_Q = 'MATCH (a)-[r]->(b) RETURN a.id AS from, type(r) AS type, b.id AS to, properties(r) AS props '
  + 'ORDER BY from, type, to';

/** @param {any} db @param {Exec} exec @param {Record<string, any>} doc */
export function graphPayload(db, exec, doc) {
  const colours = nodeColours(doc);
  const nodes = exec(db, NODES_Q).rows.map((r) => {
    const group = r.labels[0];
    return { id: r.id, label: r.props.name ?? r.id, group, color: colours[group] ?? DEFAULT_COLOUR, props: r.props };
  });
  const edges = exec(db, EDGES_Q).rows.map((r) => ({ from: r.from, to: r.to, type: r.type, props: r.props }));
  return { nodes, edges };
}
