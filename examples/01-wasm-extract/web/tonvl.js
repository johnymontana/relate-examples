// @ts-check
/**
 * tonvl.js: Relate graph values -> NVL nodes and relationships (NOTES.md D16,
 * V4-V8). Pure, no DOM and no NVL import, so the console worker and Node can use it; only
 * graphview.js imports NVL. Ported from the NVL research spike (scratch/.../nvl/web/tonvl.mjs).
 *
 *   const g = collectGraph(rows);                 // nodes, relationships and paths found anywhere in a value
 *   const c = capGraph(g);                        // the console's cap: 1,000 drawn nodes, the relationships among them
 *   const m = toNvl(g, {labelOrder, colors, hasNode});
 *   // m.nodes / m.rels for new NVL(...) or nvl.addAndUpdateElementsInGraph(...); m.nodeData / m.relData
 *   // keep each element's labels or type and properties for the side panel.
 *
 * Input shapes (NOTES.md R4): a node is {id, kind, labels, properties}; a relationship is {id, kind, type,
 * start_node, end_node, properties}; a path is a flat list of both. The graph tab sends the same shape with
 * the entity key as the node id. Rules from the spike (V8):
 *   - ids are strings; node and relationship ids live in two maps (they may collide);
 *   - a relationship whose endpoint is missing would be dropped silently by NVL, so the endpoint
 *     is stubbed (a small grey node) unless `hasNode` says it is already drawn (incremental adds);
 *   - captions: name, display, title, text or id, the first that is a scalar, else the first label;
 *   - colours: the ontology's colour for a kind when it sets one, else the palette in the
 *     ontology's kind order, else a hash of the label (the same label has the same colour
 *     everywhere); relationships are grey and captioned with their type.
 *   - review candidates (the graph tab's facts in the review band, marked `candidate: true` on the
 *     wire): their kind's colour faded towards the background, a smaller node, a lighter and thinner
 *     relationship, and an italic caption ending " (review)". NVL 2.0 has no dashed style
 *     (graph-element.d.ts: color, size, width, caption, captions with font styles).
 *   - sizes: NODE_SIZE for a kept node, CANDIDATE_SIZE for a review candidate, STUB_SIZE for a stub.
 *     NVL draws a node's caption inside the circle, only when its radius on screen (size x zoom)
 *     reaches about 15.6 px, in a font of about a quarter of that radius, and cut to the circle's
 *     width, while its force layout spaces nodes 150 to 300 units apart whatever their size: at the
 *     zoom that fits a dozen nodes, no caption shows. So graphview.js draws each node's caption
 *     (labelOf: the text this module gives NVL) as a label of its own under the node, and NVL gets
 *     the nodes without captions.
 */

export const PALETTE = Object.freeze(['#4C8EDA', '#F79767', '#57C7E3', '#F16667', '#D9C8AE', '#8DCC93',
  '#ECB5C9', '#FFC454', '#DA7194', '#569480', '#C990C0', '#A5ABB6']);
export const REL_COLOR = '#8A92A0';
export const STUB_COLOR = '#E0E0E0';
/** A review candidate's relationship colour (lighter than REL_COLOR). */
export const CANDIDATE_REL_COLOR = '#D3D6DB';
/** The suffix a review candidate's caption carries. */
export const CANDIDATE_SUFFIX = ' (review)';
/** A kept node's size (NVL's radius at zoom 1), a review candidate's (smaller) and an endpoint stub's. */
export const NODE_SIZE = 32;
export const CANDIDATE_SIZE = 25;
export const STUB_SIZE = 12;

/** The text an NVL node from toNvl is captioned with ('' for none). @param {{caption?: string, captions?: Array<{value: string}>}} n */
export const labelOf = (n) => String(n.captions?.[0]?.value ?? n.caption ?? '');

/**
 * A colour faded towards a light grey (a review candidate's fill): `#RRGGBB` mixed 60% with #EEF0F2.
 * Anything else comes back unchanged.
 * @param {string} hex
 */
export function fade(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const bg = [0xee, 0xf0, 0xf2];
  return `#${[m[1], m[2], m[3]].map((x, i) => Math.round(parseInt(x, 16) * 0.4 + bg[i] * 0.6).toString(16).padStart(2, '0')).join('')}`;
}
const CAPTION_KEYS = ['name', 'display', 'title', 'text', 'id', 'key'];
/** Labels that say what layer a node is in rather than what it is: colour by the next label. */
const LAYER_LABELS = new Set(['_Entity']);

/**
 * A label's colour: colors[label] when given, else the palette in labelOrder, else FNV-1a.
 * @param {string|undefined} label
 * @param {string[]} [labelOrder]
 * @param {Record<string, string>} [colors]
 */
export function labelColor(label, labelOrder = [], colors = {}) {
  if (!label) return PALETTE[PALETTE.length - 1];
  if (colors[label]) return colors[label];
  const k = labelOrder.indexOf(label);
  if (k >= 0) return PALETTE[k % (PALETTE.length - 1)];
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return PALETTE[(h >>> 0) % (PALETTE.length - 1)];
}

/** @param {any} v */
export const isNode = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && 'id' in v &&
  Array.isArray(v.labels) && 'properties' in v;
/** @param {any} v */
export const isRel = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && 'id' in v &&
  typeof v.type === 'string' && 'start_node' in v && 'end_node' in v;

/**
 * @typedef {{id: string|number, labels: string[], properties: Record<string, any>}} WireNode
 * @typedef {{id: string|number, type: string, start_node: string|number, end_node: string|number, properties: Record<string, any>}} WireRel
 * @typedef {{nodes: Map<string, WireNode>, rels: Map<string, WireRel>}} Collected
 */

/**
 * Walk any value (rows, row maps, lists, paths) and collect its nodes and relationships, deduplicated.
 * @param {unknown} value
 * @param {Collected} [acc]
 * @returns {Collected}
 */
export function collectGraph(value, acc = { nodes: new Map(), rels: new Map() }) {
  if (Array.isArray(value)) {
    for (const v of value) collectGraph(v, acc);
    return acc;
  }
  if (!value || typeof value !== 'object') return acc;
  if (isNode(value)) {
    acc.nodes.set(String(/** @type {any} */ (value).id), /** @type {WireNode} */ (value));
    return acc;
  }
  if (isRel(value)) {
    acc.rels.set(String(/** @type {any} */ (value).id), /** @type {WireRel} */ (value));
    return acc;
  }
  for (const v of Object.values(value)) collectGraph(v, acc);
  return acc;
}

/** The console draws at most this many nodes, stubs included (a larger result would stall the page). */
export const MAX_DRAWN_NODES = 1000;
/** ... and at most this many relationships among them. */
export const MAX_DRAWN_RELS = 3000;

/**
 * What the console draws of a collected result: the first `maxNodes` nodes in result order and the
 * relationships among them, at most `maxRels`. A relationship whose end the result never returns
 * is kept while its stub (toNvl) still fits under maxNodes; one whose end was returned but cut is
 * left out. `total` counts the whole result; `capped` says whether anything was left out.
 * @param {Collected} g
 * @param {{maxNodes?: number, maxRels?: number}} [opts]
 * @returns {{nodes: WireNode[], rels: WireRel[], total: {nodes: number, rels: number}, capped: boolean}}
 */
export function capGraph(g, { maxNodes = MAX_DRAWN_NODES, maxRels = MAX_DRAWN_RELS } = {}) {
  /** @type {WireNode[]} */
  const nodes = [];
  for (const n of g.nodes.values()) {
    if (nodes.length >= maxNodes) break;
    nodes.push(n);
  }
  const drawn = new Set(nodes.map((n) => String(n.id)));
  /** @type {WireRel[]} */
  const rels = [];
  for (const r of g.rels.values()) {
    if (rels.length >= maxRels) break;
    const need = [...new Set([String(r.start_node), String(r.end_node)])].filter((id) => !drawn.has(id));
    if (need.some((id) => g.nodes.has(id))) continue; // an end the cap left out
    if (drawn.size + need.length > maxNodes) continue; // no room for its stubs
    for (const id of need) drawn.add(id);
    rels.push(r);
  }
  return { nodes, rels, total: { nodes: g.nodes.size, rels: g.rels.size }, capped: nodes.length < g.nodes.size || rels.length < g.rels.size };
}

/** The label a node is coloured and described by: its first non-layer label. @param {string[]} labels */
export function mainLabel(labels = []) {
  return labels.find((l) => !LAYER_LABELS.has(l)) ?? labels[0];
}

/** @param {WireNode} n */
function caption(n) {
  const p = n.properties || {};
  for (const k of CAPTION_KEYS) {
    const v = p[k];
    if (v !== null && v !== undefined && typeof v !== 'object') return String(v).slice(0, 40);
  }
  return mainLabel(n.labels) ?? String(n.id);
}

/**
 * @typedef {{id: string, caption?: string, captions?: Array<{value: string, styles: string[]}>, color: string, size: number}} NvlNode
 * @typedef {{id: string, from: string, to: string, type: string, caption?: string, captions?: Array<{value: string, styles: string[]}>, color: string, width: number}} NvlRel
 */

/**
 * Map collected graph values to NVL elements.
 * @param {Collected | {nodes: WireNode[], rels: WireRel[]} | unknown} input
 * @param {{labelOrder?: string[], colors?: Record<string, string>, hasNode?: (id: string) => boolean}} [opts]
 * @returns {{nodes: NvlNode[], rels: NvlRel[],
 *   nodeData: Map<string, {labels: string[], properties: Record<string, any>, stub?: boolean, candidate?: boolean}>,
 *   relData: Map<string, {type: string, from: string, to: string, properties: Record<string, any>, candidate?: boolean}>}}
 */
export function toNvl(input, { labelOrder = [], colors = {}, hasNode = () => false } = {}) {
  /** @type {Collected} */
  let g;
  const any = /** @type {any} */ (input);
  if (any && any.nodes instanceof Map && any.rels instanceof Map) g = any;
  else if (any && Array.isArray(any.nodes) && Array.isArray(any.rels)) g = collectGraph([any.nodes, any.rels]);
  else g = collectGraph(input);
  /** @type {Map<string, {labels: string[], properties: Record<string, any>, stub?: boolean, candidate?: boolean}>} */
  const nodeData = new Map();
  /** @type {Map<string, {type: string, from: string, to: string, properties: Record<string, any>, candidate?: boolean}>} */
  const relData = new Map();
  /** @type {NvlNode[]} */
  const nodes = [];
  for (const [id, n] of g.nodes) {
    const color = labelColor(mainLabel(n.labels), labelOrder, colors);
    if (/** @type {any} */ (n).candidate === true) {
      nodeData.set(id, { labels: n.labels, properties: n.properties ?? {}, candidate: true });
      nodes.push({ id, captions: [{ value: `${caption(n)}${CANDIDATE_SUFFIX}`, styles: ['italic'] }], color: fade(color), size: CANDIDATE_SIZE });
      continue;
    }
    nodeData.set(id, { labels: n.labels, properties: n.properties ?? {} });
    nodes.push({ id, caption: caption(n), color, size: NODE_SIZE });
  }
  /** @type {NvlRel[]} */
  const rels = [];
  for (const [id, r] of g.rels) {
    const from = String(r.start_node);
    const to = String(r.end_node);
    for (const end of [from, to]) {
      if (!nodeData.has(end) && !hasNode(end)) {
        nodeData.set(end, { labels: [], properties: {}, stub: true });
        nodes.push({ id: end, caption: '…', color: STUB_COLOR, size: STUB_SIZE });
      }
    }
    if (/** @type {any} */ (r).candidate === true) {
      relData.set(id, { type: r.type, from, to, properties: r.properties ?? {}, candidate: true });
      rels.push({ id, from, to, type: r.type, captions: [{ value: `${r.type}${CANDIDATE_SUFFIX}`, styles: ['italic'] }], color: CANDIDATE_REL_COLOR, width: 0.5 });
      continue;
    }
    relData.set(id, { type: r.type, from, to, properties: r.properties ?? {} });
    rels.push({ id, from, to, type: r.type, caption: r.type, color: REL_COLOR, width: 1 });
  }
  return { nodes, rels, nodeData, relData };
}
