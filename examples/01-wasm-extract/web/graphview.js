// @ts-check
/**
 * graphview.js: one NVL view (NOTES.md D16, V3-V8), the only module that imports NVL
 * (through the esbuild vendor bundle, `npm run vendor` -> web/vendor/nvl.js; build.mjs serves it
 * from assets/nvl-2.0.0/). The page keeps three views, the graph tab, the ontology tab's picture and
 * the console, and reuses each one's NVL instance for every update: destroy() leaks about 0.1 MB (V8).
 *
 *   const view = new GraphView(hostElement, {layout: 'forceDirected', onSelect: (sel) => ...});
 *   view.set(graph, {labelOrder, colors}, {fit}); // graph: {nodes: [...], rels: [...]} in the wire shape
 *   view.counts();                             // {nodes, rels, candidates: {nodes, rels}} through NVL's API (tests read these)
 *
 * Rules:
 *   - NVL forces height: 100% on its container (V4), so it gets an inner frame and the host is
 *     sized by the page's CSS.
 *   - Elements come from tonvl.js (stubbed endpoints, captions, colours by the ontology's kinds).
 *   - An update keeps what is still there and pins it while the layout places the new elements,
 *     so a new extraction does not shuffle the graph (V8); pins are released when the layout
 *     settles. Elements that went away are removed.
 *   - The canvas renderer is the default; above 300 nodes the WebGL renderer takes over (V7: 1,000
 *     nodes lay out in 1.0 s against 3.8 s on canvas). It draws no captions.
 *   - Captions are labels of the view's own: NVL draws a node's caption inside
 *     its circle only once the circle is about 32 px across on screen, cut to its width, and a
 *     relationship's along it only when zoomed in, while its layout spaces nodes far apart, so at the
 *     zoom that fits a dozen nodes it draws none. Each node's caption (tonvl.js labelOf) is an HTML
 *     label under it, in a fixed font, and each relationship's type a smaller one, placed from NVL's
 *     own positions (getNodes' clientPosition) on every frame in which the zoom, the pan or a
 *     position changed, while the view is shown; NVL gets the elements without captions.
 *     A node's label goes under it, else over it, else beside it. A relationship's label
 *     sits on its own edge's midpoint, centred there and never moved elsewhere, with the canvas's
 *     colour behind it so the line breaks around it: along the edge, turned to read left to right,
 *     when the edge is no steeper than ROTATE_MAX and the line between the two circles has room for
 *     it and the arrowhead (REL_LABEL_SLACK); else level, when the line has room
 *     for the part of it a level label covers. Otherwise, or when it would cover a node or a label
 *     placed before it, it is hidden until a zoom makes room, or until the pointer asks: hovering or
 *     selecting a relationship shows its label, and hovering or selecting a node its own and its
 *     relationships' (class `focus`, above the rest). The order: kept nodes that end a kept
 *     relationship, kept relationships, the other kept nodes, review candidates' nodes, then
 *     candidates' relationships; and a relationship's label shows only when both its ends' labels do
 *     (an end with none, a stub, aside), so a type never sits between two unnamed dots. A review candidate's node label is italic and ends " (review)"; its
 *     relationship's is the type in italic (its faded line says the rest). A stub has none, and a
 *     self-loop's type shows only when hovered or selected. Labels exist up to LABEL_NODES nodes and
 *     LABEL_RELS relationships.
 *   - disableTelemetry: true (V8). The layout is forceDirected in the page and d3Force under test
 *     (?test=1), which is deterministic (V6).
 *   - The five interaction handlers (V5): click selects and reports a node or relationship (with
 *     its labels or type and properties) through onSelect, hover, drag, wheel zoom and pan.
 *   - A view that is hidden (display: none) when updated renders when show() is called, so NVL
 *     never measures a zero-sized container.
 *   - Review candidates (wire elements marked `candidate: true`, the graph tab's review band) are
 *     drawn faded by tonvl.js and counted apart: counts().nodes and .rels are the kept elements only,
 *     counts().candidates the candidates; a selection says whether it is one.
 *   - Fitting: the view fits itself on its first draw, after clear(), and after a set()
 *     with {fit: true} (the page asks after an extraction and a store switch), once the layout has
 *     placed the new elements; Fit (fit()) does it on demand, animated. A fit zooms between
 *     MIN_FIT_ZOOM and MAX_FIT_ZOOM (one node would otherwise fill the canvas). Each fit is counted
 *     (fits) and measured two frames later (lastFit: the zoom, how many nodes have their centre
 *     inside the canvas, how many labels show, how far a shown relationship label's centre lies
 *     from its edge's midpoint on screen, and whether one covers a shown node label), for tests.
 */
import { ClickInteraction, DragNodeInteraction, HoverInteraction, NVL, PanInteraction, ZoomInteraction } from './vendor/nvl.js';
import { NODE_SIZE, labelOf, toNvl } from './tonvl.js';

/** Above this many nodes the WebGL renderer is used (D16); it draws no captions, and the view no labels. */
export const WEBGL_ABOVE = 300;
/** A fit zooms in no further than this (one or two nodes would fill the canvas)... */
export const MAX_FIT_ZOOM = 1.5;
/** ... and out no further than this (a kept node 2 x 32 x 0.2 = 13 px across). */
export const MIN_FIT_ZOOM = 0.2;
/** A node whose radius on screen is under this many CSS pixels shows no label (labels would only pile up). */
export const LABEL_MIN_RADIUS = 2;
/** Views with more nodes, or more relationships, than these get no node labels, or no relationship labels. */
export const LABEL_NODES = WEBGL_ABOVE;
export const LABEL_RELS = 300;
/** A kept relationship's line width, and a review candidate's (tonvl.js gives 1 and 0.5). */
const REL_WIDTH = 2;
const CANDIDATE_REL_WIDTH = 1;
/** A relationship's label runs along its edge up to this angle from the level; a steeper edge gets a level label. */
export const ROTATE_MAX = (40 * Math.PI) / 180;
/**
 * What a relationship's label leaves of its line at least, the label being centred: this many CSS px, plus
 * twice the arrowhead (NVL draws a kept relationship's head about 9 units long, so 18 x the zoom).
 */
export const REL_LABEL_SLACK = 2;
/** A shown relationship label's centre lies within this many CSS px of its edge's midpoint (tests pin it). */
export const REL_LABEL_AT = 2;

/**
 * A label's box on screen: centre, half-sizes, and its angle as cos/sin (0 for a level label), with
 * the axis-aligned box around it for a quick reject.
 * @typedef {{cx: number, cy: number, hw: number, hh: number, c: number, s: number, a: number, x0: number, y0: number, x1: number, y1: number}} Box
 * @typedef {{x: number, y: number, r: number, x0: number, y0: number, x1: number, y1: number}} Circle
 */

/** @param {number} cx @param {number} cy @param {number} w @param {number} h @param {number} a  radians @returns {Box} */
function box(cx, cy, w, h, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const hw = w / 2;
  const hh = h / 2;
  const ex = hw * Math.abs(c) + hh * Math.abs(s);
  const ey = hw * Math.abs(s) + hh * Math.abs(c);
  return { cx, cy, hw, hh, c, s, a, x0: cx - ex, y0: cy - ey, x1: cx + ex, y1: cy + ey };
}
/** The same box, grown by dx and dy on each side (the room kept around a placed label). @param {Box} b @param {number} dx @param {number} dy */
const grow = (b, dx, dy) => box(b.cx, b.cy, 2 * b.hw + 2 * dx, 2 * b.hh + 2 * dy, b.a);
/** @param {{x0: number, y0: number, x1: number, y1: number}} p @param {{x0: number, y0: number, x1: number, y1: number}} q */
const aabbHit = (p, q) => p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1;
/** Whether a (turned) box and a circle overlap: the circle's centre in the box's frame, clamped. @param {Box} b @param {Circle} o */
function boxHitsCircle(b, o) {
  const dx = o.x - b.cx;
  const dy = o.y - b.cy;
  const lx = dx * b.c + dy * b.s;
  const ly = -dx * b.s + dy * b.c;
  const qx = Math.max(-b.hw, Math.min(b.hw, lx));
  const qy = Math.max(-b.hh, Math.min(b.hh, ly));
  return (lx - qx) ** 2 + (ly - qy) ** 2 < o.r * o.r;
}
/** Whether two (turned) boxes overlap: separating axes, two from each. @param {Box} p @param {Box} q */
function boxesHit(p, q) {
  const dx = q.cx - p.cx;
  const dy = q.cy - p.cy;
  for (const [ux, uy] of [[p.c, p.s], [-p.s, p.c], [q.c, q.s], [-q.s, q.c]]) {
    const rp = p.hw * Math.abs(ux * p.c + uy * p.s) + p.hh * Math.abs(-ux * p.s + uy * p.c);
    const rq = q.hw * Math.abs(ux * q.c + uy * q.s) + q.hh * Math.abs(-ux * q.s + uy * q.c);
    if (Math.abs(dx * ux + dy * uy) >= rp + rq) return false;
  }
  return true;
}

/**
 * @typedef {{kind: 'node', id: string, labels: string[], properties: Record<string, any>, stub?: boolean, candidate?: boolean}
 *   | {kind: 'rel', id: string, type: string, from: string, to: string, properties: Record<string, any>, candidate?: boolean}} Selection
 * @typedef {{labelOrder?: string[], colors?: Record<string, string>}} Styling
 */

export class GraphView {
  /**
   * @param {HTMLElement} host  sized by CSS
   * @param {{layout?: 'forceDirected'|'d3Force', onSelect?: (sel: Selection|null) => void}} [opts]
   */
  constructor(host, { layout = 'forceDirected', onSelect = () => {} } = {}) {
    this.host = host;
    this.frame = document.createElement('div');
    this.frame.className = 'nvl-frame';
    // The labels sit over the canvas and let every pointer event through to it.
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'nvl-labels';
    this.labelLayer.setAttribute('aria-hidden', 'true');
    host.prepend(this.frame, this.labelLayer);
    this.layout = layout;
    this.onSelect = onSelect;
    /** @type {any} */
    this.nvl = null;
    /** @type {any[]} */
    this.handlers = [];
    /** @type {Map<string, any>} */
    this.nodeData = new Map();
    /** @type {Map<string, any>} */
    this.relData = new Map();
    /**
     * Each label, by `n:<node id>` or `r:<relationship id>`: its element, its size once measured, what it
     * labels, its box where it was last placed (shown), and whether it is shown for the pointer (focus).
     * @type {Map<string, {el: HTMLElement, w: number, h: number, kind: 'node'|'rel', id: string, candidate: boolean, from?: string, to?: string, at?: Box|null, focus?: boolean}>}
     */
    this.labels = new Map();
    /** what the pointer is over, and what was clicked last: their labels show whatever the room (focus) */
    /** @type {{kind: 'node'|'rel', id: string}|null} */
    this.hovered = null;
    /** @type {{kind: 'node'|'rel', id: string}|null} */
    this.selected = null;
    /** the label loop's animation frame (0: not running), and what the last placement saw */
    this.raf = 0;
    this.placedKey = '';
    /** frames left in which the labels are placed whatever changed (an update, a layout, a drag) */
    this.dirty = 0;
    /** layouts finished since the view was made (tests wait on it) */
    this.layoutDone = 0;
    /** @type {Array<() => void>} */
    this.waiters = [];
    /** @type {string[]} */
    this.errors = [];
    /** @type {{graph: any, styling: Styling} | null} */
    this.pending = null;
    this.renderer = 'canvas';
    /** the next draw fits the view (its first, one after clear(), one asked for with set(..., {fit: true})) */
    this.fitWanted = true;
    /** fits done so far, and the last one's measure() two frames after it */
    this.fits = 0;
    /** @type {ReturnType<GraphView['measure']>|null} */
    this.lastFit = null;
  }

  /** Whether the host is displayed (NVL needs a measured container). */
  visible() {
    return this.host.offsetParent !== null && this.host.clientWidth > 0;
  }

  /** Create the NVL instance and its handlers, once. */
  ensure() {
    if (this.nvl) return this.nvl;
    const callbacks = {
      onLayoutDone: () => {
        this.layoutDone++;
        this.dirty = 30;
        for (const f of this.waiters.splice(0)) f();
      },
      onError: (/** @type {any} */ e) => this.errors.push(String(e?.message ?? e)),
    };
    this.nvl = new NVL(this.frame, [], [], {
      renderer: this.renderer,
      layout: this.layout,
      disableTelemetry: true,
      disableWebWorkers: true,
      initialZoom: 1,
      styling: { selectedBorderColor: '#1A1B1D', dropShadowColor: '#5C6BC0' },
    }, callbacks);
    const click = new ClickInteraction(this.nvl, { selectOnClick: true });
    const hover = new HoverInteraction(this.nvl, { drawShadowOnHover: true });
    const drag = new DragNodeInteraction(this.nvl);
    const zoom = new ZoomInteraction(this.nvl);
    const pan = new PanInteraction(this.nvl);
    click.updateCallback('onNodeClick', (/** @type {any} */ node) => {
      const d = this.nodeData.get(node.id);
      this.focusOn('selected', { kind: 'node', id: node.id });
      this.onSelect(d ? { kind: 'node', id: node.id, labels: d.labels, properties: d.properties, stub: d.stub, candidate: d.candidate === true } : null);
    });
    click.updateCallback('onRelationshipClick', (/** @type {any} */ rel) => {
      const d = this.relData.get(rel.id);
      this.focusOn('selected', { kind: 'rel', id: rel.id });
      this.onSelect(d ? { kind: 'rel', id: rel.id, type: d.type, from: d.from, to: d.to, properties: d.properties, candidate: d.candidate === true } : null);
    });
    click.updateCallback('onCanvasClick', () => {
      this.focusOn('selected', null);
      this.onSelect(null);
    });
    // The pointer over a relationship shows its label, over a node its own and its relationships' (focus).
    hover.updateCallback('onHover', (/** @type {any} */ _el, /** @type {any} */ hits) => {
      const n = hits?.nodes?.[0]?.data;
      const r = hits?.relationships?.[0]?.data;
      this.focusOn('hovered', n ? { kind: 'node', id: n.id } : r ? { kind: 'rel', id: r.id } : null);
    });
    // NVL reports hovering only while the pointer moves over the canvas: leaving it ends the hover.
    this.frame.addEventListener('mouseleave', () => this.focusOn('hovered', null));
    drag.updateCallback('onDrag', () => { this.dirty = 30; });
    this.handlers = [click, hover, drag, zoom, pan];
    return this.nvl;
  }

  /**
   * Show a graph: the whole state the view should hold (not a delta).
   * @param {{nodes: any[], rels: any[]}} graph  wire-shaped nodes and relationships (tonvl.js)
   * @param {Styling} [styling]
   * @param {{fit?: boolean}} [opts]  fit: fit the view once the layout has placed this graph
   */
  set(graph, styling = {}, { fit = false } = {}) {
    if (fit) this.fitWanted = true;
    this.pending = { graph, styling };
    if (this.visible()) this.flush();
  }

  /** Render a pending update; call it when the view's tab becomes visible. */
  show() {
    if (this.pending && this.visible()) this.flush();
    this.startLabels();
  }

  flush() {
    if (!this.pending) return;
    const { graph, styling } = this.pending;
    this.pending = null;
    const nvl = this.ensure();
    const m = toNvl(graph, { labelOrder: styling.labelOrder ?? [], colors: styling.colors ?? {} });
    const want = m.nodes.length > WEBGL_ABOVE ? 'webgl' : 'canvas';
    if (want !== this.renderer) {
      this.renderer = want;
      nvl.setRenderer(want);
    }
    // A node that turns from a review candidate into a kept entity (or back) keeps its id but not its
    // style: remove it and add it afresh, so no candidate caption or colour survives the update.
    const flipped = new Set([...this.nodeData].filter(([id, d]) => m.nodeData.has(id) && (d.candidate === true) !== (m.nodeData.get(id)?.candidate === true)).map(([id]) => id));
    if (flipped.size) {
      const attached = nvl.getRelationships().filter((/** @type {any} */ r) => flipped.has(r.from) || flipped.has(r.to)).map((/** @type {any} */ r) => r.id);
      if (attached.length) nvl.removeRelationshipsWithIds(attached);
      nvl.removeNodesWithIds([...flipped]);
    }
    const oldNodes = new Set(nvl.getNodes().map((/** @type {any} */ n) => n.id));
    const oldRels = new Set(nvl.getRelationships().map((/** @type {any} */ r) => r.id));
    const newNodes = new Set(m.nodes.map((n) => n.id));
    const newRels = new Set(m.rels.map((r) => r.id));
    const goneRels = [...oldRels].filter((id) => !newRels.has(id));
    const goneNodes = [...oldNodes].filter((id) => !newNodes.has(id));
    const kept = [...oldNodes].filter((id) => newNodes.has(id));
    const added = m.nodes.filter((n) => !oldNodes.has(n.id)).length + m.rels.filter((r) => !oldRels.has(r.id)).length;
    if (goneRels.length) nvl.removeRelationshipsWithIds(goneRels);
    if (goneNodes.length) nvl.removeNodesWithIds(goneNodes);
    // Pin what stays while the layout places the new elements (V8), then let go.
    for (const id of kept) nvl.pinNode(id);
    this.nodeData = m.nodeData;
    this.relData = m.relData;
    this.setLabels(m.nodes, m.rels);
    // NVL gets the elements without their captions: the view draws them as labels (see the header).
    const width = (/** @type {string} */ id) => (m.relData.get(id)?.candidate ? CANDIDATE_REL_WIDTH : REL_WIDTH);
    nvl.addAndUpdateElementsInGraph(m.nodes.map(({ caption, captions, ...n }) => n), m.rels.map(({ caption, captions, ...r }) => ({ ...r, width: width(r.id) })));
    const release = () => { if (kept.length) nvl.unPinNode(kept); };
    const fit = this.fitWanted && m.nodes.length > 0;
    if (fit) this.fitWanted = false;
    if (added > 0 || goneNodes.length) {
      // The layout places the new elements first; a layout that never reports done is fitted anyway.
      const timer = setTimeout(() => { release(); if (fit) this.fit({ animated: false }); }, 4000);
      this.waiters.push(() => {
        clearTimeout(timer);
        release();
        if (fit) this.fit({ animated: false });
      });
    } else {
      release();
      if (fit) requestAnimationFrame(() => this.fit({ animated: false }));
    }
    this.startLabels();
  }

  /**
   * One label per captioned node and per relationship (see the header), kept across updates by id,
   * and measured once while laid out but invisible.
   * @param {Array<{id: string, caption?: string, captions?: Array<{value: string, styles: string[]}>}>} nodes
   * @param {Array<{id: string, from: string, to: string, type: string}>} rels
   */
  setLabels(nodes, rels) {
    /** @type {Map<string, {text: string, kind: 'node'|'rel', id: string, candidate: boolean, from?: string, to?: string}>} */
    const want = new Map();
    if (nodes.length <= LABEL_NODES) {
      for (const n of nodes) {
        const d = this.nodeData.get(n.id);
        const text = d?.stub ? '' : labelOf(n);
        if (text) want.set(`n:${n.id}`, { text, kind: 'node', id: n.id, candidate: d?.candidate === true });
      }
    }
    if (rels.length <= LABEL_RELS) {
      for (const r of rels) {
        const d = this.relData.get(r.id);
        if (!d) continue;
        // A review candidate's type in italic, without " (review)": its faded, thinner line says so, and
        // the label stays short enough to fit along its edge.
        want.set(`r:${r.id}`, { text: r.type, kind: 'rel', id: r.id, candidate: d.candidate === true, from: r.from, to: r.to });
      }
    }
    for (const [key, l] of this.labels) {
      if (!want.has(key)) {
        l.el.remove();
        this.labels.delete(key);
      }
    }
    /** @type {Array<any>} */
    const fresh = [];
    for (const [key, w] of want) {
      let l = this.labels.get(key);
      if (!l) {
        const el = document.createElement('div');
        el.style.visibility = 'hidden';
        this.labelLayer.append(el);
        l = { el, w: 0, h: 0, kind: w.kind, id: w.id, candidate: false };
        this.labels.set(key, l);
      }
      if (l.el.textContent !== w.text || l.candidate !== w.candidate || !l.w) fresh.push(l);
      Object.assign(l, { kind: w.kind, id: w.id, candidate: w.candidate, from: w.from, to: w.to });
      l.el.className = `nvl-label${w.kind === 'rel' ? ' rel' : ''}${w.candidate ? ' candidate' : ''}`;
      l.el.textContent = w.text;
      l.el.title = w.text;
      l.el.dataset.label = key;
      l.el.dataset.shown = l.el.dataset.shown ?? '0';
    }
    // One layout for every new or changed label (they are laid out at the canvas's origin, invisible).
    for (const l of fresh) {
      l.w = l.el.offsetWidth;
      l.h = l.el.offsetHeight;
    }
    this.placedKey = '';
    this.dirty = 30;
  }

  /** Place the labels on each frame while the view is shown (they follow layout, zoom, pan and drag). */
  startLabels() {
    if (this.raf || !this.labels.size) return;
    const tick = () => {
      this.raf = 0;
      if (!this.nvl || !this.labels.size || !this.visible()) return;
      const key = `${this.nvl.getScale()}|${JSON.stringify(this.nvl.getPan())}|${this.host.clientWidth}x${this.host.clientHeight}`;
      if (this.dirty > 0 || this.nvl.isLayoutMoving() || key !== this.placedKey) {
        this.placeLabels();
        this.placedKey = key;
        if (this.dirty > 0) this.dirty--;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /**
   * What the pointer is over (`hovered`) or what was clicked last (`selected`) changed: their labels
   * show whatever the room, from the next frame.
   * @param {'hovered'|'selected'} which @param {{kind: 'node'|'rel', id: string}|null} what
   */
  focusOn(which, what) {
    const now = this[which];
    if ((now?.kind ?? '') === (what?.kind ?? '') && (now?.id ?? '') === (what?.id ?? '')) return;
    this[which] = what;
    this.dirty = Math.max(this.dirty, 2);
    this.startLabels();
  }

  /**
   * A relationship label's boxes on its edge's midpoint, in the order they are tried (see the header):
   * along the edge (when the edge is no steeper than ROTATE_MAX), then level; each with whether the
   * line between the two circles has room for it and REL_LABEL_SLACK (the arrowhead and a margin).
   * Empty when an end is not drawn; a self-loop's sits above its node, never with room.
   * @param {{w: number, h: number, from?: string, to?: string}} l @param {Map<string, Circle>} at @param {number} zoom
   * @returns {Array<{b: Box, room: boolean}>}
   */
  relBoxes(l, at, zoom) {
    const a = at.get(/** @type {string} */ (l.from));
    const z = at.get(/** @type {string} */ (l.to));
    if (!a || !z) return [];
    if (l.from === l.to) return [{ b: box(a.x, a.y - a.r - 4 - l.h / 2, l.w, l.h, 0), room: false }];
    const dx = z.x - a.x;
    const dy = z.y - a.y;
    const len = Math.hypot(dx, dy);
    let ang = Math.atan2(dy, dx);
    // Turned to read left to right.
    if (ang > Math.PI / 2) ang -= Math.PI;
    else if (ang <= -Math.PI / 2) ang += Math.PI;
    const mx = (a.x + z.x) / 2;
    const my = (a.y + z.y) / 2;
    // The line shows between the circles for `line` px (centred on the midpoint for equal circles);
    // a label covers `covered` px of it, and leaves the rest, at least the slack, to the line and its arrow.
    const line = Math.min(len / 2 - a.r, len / 2 - z.r) * 2;
    const slack = REL_LABEL_SLACK + 18 * Math.min(zoom, 1.5);
    const cos = Math.abs(Math.cos(ang));
    const sin = Math.abs(Math.sin(ang));
    const levelCovers = Math.min(cos > 1e-6 ? l.w / cos : Infinity, sin > 1e-6 ? l.h / sin : Infinity);
    const out = [];
    if (Math.abs(ang) <= ROTATE_MAX) out.push({ b: box(mx, my, l.w, l.h, ang), room: line - l.w >= slack });
    out.push({ b: box(mx, my, l.w, l.h, 0), room: line - levelCovers >= slack });
    return out;
  }

  /**
   * Each label at its node (under it, else over it, else beside it) or on its relationship's midpoint
   * (see the header), from NVL's positions, unless it would cover a node or a label placed before it
   * (the header's order) or fall off the canvas; then the labels the pointer asks for (focus).
   */
  placeLabels() {
    const zoom = this.nvl.getScale();
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    /** @type {Map<string, Circle>} */
    const at = new Map();
    /** @type {Circle[]} */
    const circles = [];
    for (const n of this.nvl.getNodes()) {
      const p = n.clientPosition;
      if (!p) continue;
      const r = (n.size ?? NODE_SIZE) * zoom;
      const c = { x: p.x, y: p.y, r, x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r };
      at.set(n.id, c);
      circles.push(c);
    }
    /** @type {Box[]} boxes taken by the labels placed so far, with a little room around each */
    const taken = [];
    const free = (/** @type {Box} */ b) => b.x0 >= 0 && b.y0 >= 0 && b.x1 <= W && b.y1 <= H &&
      !circles.some((o) => aabbHit(b, o) && boxHitsCircle(b, o)) && !taken.some((t) => aabbHit(b, t) && boxesHit(b, t));
    const all = [...this.labels.values()];
    // Kept nodes ending a kept relationship, kept relationships, the other kept nodes, candidates' nodes, then
    // candidates' relationships; a relationship's label shows only once both its ends are named (or have no
    // label: a stub), so a type never sits between two unnamed dots.
    const ends = new Set(all.filter((l) => l.kind === 'rel' && !l.candidate).flatMap((l) => [l.from, l.to]));
    const rank = (/** @type {any} */ l) => (l.kind === 'rel' ? (l.candidate ? 4 : 1) : l.candidate ? 3 : ends.has(l.id) ? 0 : 2);
    const named = (/** @type {string|undefined} */ id) => {
      const n = this.labels.get(`n:${id}`);
      return !n || n.el.dataset.shown === '1';
    };
    const order = all.map((l, i) => ({ l, k: rank(l) * 1e6 + i })).sort((p, q) => p.k - q.k).map((x) => x.l);
    const nodeBox = (/** @type {any} */ l, /** @type {Circle} */ n) => [
      box(n.x, n.y + n.r + 1 + l.h / 2, l.w, l.h, 0), box(n.x, n.y - n.r - 1 - l.h / 2, l.w, l.h, 0),
      box(n.x + n.r + 3 + l.w / 2, n.y, l.w, l.h, 0), box(n.x - n.r - 3 - l.w / 2, n.y, l.w, l.h, 0)];
    for (const l of order) {
      /** @type {Box|null} */
      let b = null;
      if (l.kind === 'node') {
        const n = at.get(l.id);
        if (n && n.r >= LABEL_MIN_RADIUS) b = nodeBox(l, n).find(free) ?? null;
      } else {
        b = named(l.from) && named(l.to) ? this.relBoxes(l, at, zoom).find((x) => x.room && free(x.b))?.b ?? null : null;
      }
      if (b) taken.push(l.kind === 'node' ? grow(b, 2, 1) : grow(b, 3, 1));
      this.putLabel(l, b, false);
    }
    // The pointer's: a hovered or selected relationship, or a node and its relationships.
    /** @type {Set<string>} */
    const focus = new Set();
    for (const f of [this.selected, this.hovered]) {
      if (!f) continue;
      if (f.kind === 'rel') focus.add(`r:${f.id}`);
      else {
        focus.add(`n:${f.id}`);
        for (const l of all) if (l.kind === 'rel' && (l.from === f.id || l.to === f.id)) focus.add(`r:${l.id}`);
      }
    }
    for (const key of focus) {
      const l = this.labels.get(key);
      if (!l || l.el.dataset.shown === '1') continue;
      const n = l.kind === 'node' ? at.get(l.id) : null;
      // A relationship's along its edge when that has room, else level (it reads best on a short edge).
      const rb = l.kind === 'rel' ? this.relBoxes(l, at, zoom) : [];
      const b = l.kind === 'node' ? (n ? nodeBox(l, n)[0] : null) : ((rb.find((x) => x.room) ?? rb[rb.length - 1])?.b ?? null);
      if (b) this.putLabel(l, b, true);
    }
  }

  /**
   * Show a label at a box (centred there, turned by its angle), or hide it (b null). data-shown: '1'
   * placed, 'focus' shown for the pointer, '0' hidden.
   * @param {any} l @param {Box|null} b @param {boolean} focus
   */
  putLabel(l, b, focus) {
    l.at = b;
    if (b) {
      const t = `translate(${Math.round(b.cx - l.w / 2)}px, ${Math.round(b.cy - l.h / 2)}px)${b.a ? ` rotate(${((b.a * 180) / Math.PI).toFixed(1)}deg)` : ''}`;
      if (l.el.style.transform !== t) l.el.style.transform = t;
    }
    const shown = b ? (focus ? 'focus' : '1') : '0';
    if (l.el.dataset.shown !== shown) {
      l.el.dataset.shown = shown;
      l.el.style.visibility = b ? 'visible' : 'hidden';
    }
    if (Boolean(l.focus) !== (shown === 'focus')) {
      l.focus = shown === 'focus';
      l.el.classList.toggle('focus', l.focus);
    }
  }

  /**
   * Zoom to every node, between MIN_FIT_ZOOM and MAX_FIT_ZOOM.
   * @param {{animated?: boolean}} [opts]
   */
  fit({ animated = true } = {}) {
    if (!this.nvl) return;
    const ids = this.nvl.getNodes().map((/** @type {any} */ n) => n.id);
    if (!ids.length) return;
    this.nvl.fit(ids, { animated, minZoom: MIN_FIT_ZOOM, maxZoom: MAX_FIT_ZOOM });
    // NVL applies a fit on its next frames: measure once it has (an animated fit takes longer).
    const n = ++this.fits;
    const measure = () => { if (this.fits === n && this.nvl) this.lastFit = this.measure(); };
    if (animated) setTimeout(measure, 1200);
    else requestAnimationFrame(() => requestAnimationFrame(() => { this.placeLabels(); measure(); }));
    this.dirty = 30;
  }

  /**
   * The viewport as it is (tests): NVL's zoom, how many nodes have their centre inside the canvas, how
   * many node labels there are and show; how many relationship labels there are and show, the
   * farthest a shown one's centre on screen (its element's box) lies from its edge's midpoint (relOff,
   * CSS px), and how many shown relationship labels cover a shown node label or a node (relOver).
   */
  measure() {
    const none = { zoom: 0, nodes: 0, inside: 0, labels: 0, labelled: 0, relLabels: 0, relLabelled: 0, relOff: 0, relOver: 0 };
    if (!this.nvl) return none;
    const zoom = this.nvl.getScale();
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    let inside = 0;
    const nodes = this.nvl.getNodes();
    /** @type {Map<string, Circle>} */
    const at = new Map();
    for (const n of nodes) {
      const p = n.clientPosition;
      if (p && p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h) inside++;
      if (p) {
        const r = (n.size ?? NODE_SIZE) * zoom;
        at.set(n.id, { x: p.x, y: p.y, r, x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r });
      }
    }
    const all = [...this.labels.values()];
    const shown = (/** @type {any} */ l) => l.el.dataset.shown === '1';
    const origin = this.labelLayer.getBoundingClientRect();
    let relOff = 0;
    let relOver = 0;
    const nodeBoxes = all.filter((l) => l.kind === 'node' && shown(l) && l.at).map((l) => /** @type {Box} */ (l.at));
    for (const l of all) {
      if (l.kind !== 'rel' || !shown(l) || !l.at) continue;
      const a = at.get(/** @type {string} */ (l.from));
      const z = at.get(/** @type {string} */ (l.to));
      const r = l.el.getBoundingClientRect();
      if (a && z) relOff = Math.max(relOff, Math.hypot(r.left + r.width / 2 - origin.left - (a.x + z.x) / 2, r.top + r.height / 2 - origin.top - (a.y + z.y) / 2));
      const b = /** @type {Box} */ (l.at);
      if (nodeBoxes.some((q) => aabbHit(b, q) && boxesHit(b, q)) || [...at.values()].some((o) => aabbHit(b, o) && boxHitsCircle(b, o))) relOver++;
    }
    return {
      zoom, nodes: nodes.length, inside,
      labels: all.filter((l) => l.kind === 'node').length,
      labelled: all.filter((l) => l.kind === 'node' && shown(l)).length,
      relLabels: all.filter((l) => l.kind === 'rel').length,
      relLabelled: all.filter((l) => l.kind === 'rel' && shown(l)).length,
      relOff: Math.round(relOff * 10) / 10,
      relOver,
    };
  }

  /** Drop NVL's selection (a store switch clears the side panel). */
  deselect() {
    try { this.nvl?.deselectAll(); } catch { /* nothing selected */ }
    this.focusOn('selected', null);
  }

  /** Remove everything (the view stays usable). */
  clear() {
    this.pending = null;
    this.fitWanted = true;
    this.hovered = null;
    this.selected = null;
    this.setLabels([], []);
    if (!this.nvl) return;
    const rels = this.nvl.getRelationships().map((/** @type {any} */ r) => r.id);
    const nodes = this.nvl.getNodes().map((/** @type {any} */ n) => n.id);
    if (rels.length) this.nvl.removeRelationshipsWithIds(rels);
    if (nodes.length) this.nvl.removeNodesWithIds(nodes);
    this.nodeData = new Map();
    this.relData = new Map();
  }

  /**
   * Node and relationship counts as NVL holds them (not pixels): `nodes` and `rels` count the kept
   * elements (stubs included), `candidates` the review candidates drawn beside them.
   */
  counts() {
    if (!this.nvl) return { nodes: 0, rels: 0, renderer: this.renderer, pending: Boolean(this.pending), candidates: { nodes: 0, rels: 0 } };
    const nodes = this.nvl.getNodes();
    const rels = this.nvl.getRelationships();
    const cn = nodes.filter((/** @type {any} */ n) => this.nodeData.get(n.id)?.candidate === true).length;
    const cr = rels.filter((/** @type {any} */ r) => this.relData.get(r.id)?.candidate === true).length;
    return { nodes: nodes.length - cn, rels: rels.length - cr, renderer: this.renderer, pending: Boolean(this.pending), candidates: { nodes: cn, rels: cr } };
  }

  /** Resolves after the next onLayoutDone, or after `ms`. @param {number} [ms] */
  whenLayoutDone(ms = 30000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      this.waiters.push(() => { clearTimeout(t); resolve(true); });
    });
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const h of this.handlers) h.destroy();
    this.handlers = [];
    this.nvl?.destroy();
    this.nvl = null;
  }
}
