// @ts-check
/**
 * graph.js: the memory, drawn with NVL, the Neo4j Visualization Library (NOTES.md D5, ADR-0015).
 *
 * The page asks two things of the graph, and this module turns both into NVL calls:
 *
 *   It grows. update(snapshot) takes the whole store after each tool call and gives NVL the
 *   difference (addAndUpdateElementsInGraph, removeNodesWithIds). A new node grows in, an entity
 *   grows a little with each thing learnt about it, and the camera eases to keep it all in view.
 *
 *   It shows how a memory was reached. highlight(paths) takes the paths the engine returned:
 *   everything on a path the reply used is selected (NVL's ring), in the order the path was
 *   walked, each node pulsing as the path reaches it while the layout is held still; what the
 *   other returned paths touch stays as it is; everything else is disabled.
 *
 * What is drawn: an entity is a large node carrying its name, coloured by kind and sized by how
 * much is known about it; a memory is a smaller node between the entities it is about, carrying
 * its gist (the store keeps its text, vector and source); every relationship carries its type.
 * The camera is this module's, not NVL's fit (N3, N6): frame() and tick(). Messages and sessions are provenance: hidden until asked for, or until
 * a highlighted path runs through them. MENTIONS relationships are in the store and never drawn
 * (they repeat what ABOUT shows).
 *
 * Colours come from the page's CSS custom properties (--g-*: the Relate brand palette, one set per
 * theme), read when the graph is created and again on retheme().
 *
 * NVL draws to a canvas, so nothing here is in the DOM for a test to read. stats() reads back
 * what NVL itself holds (getNodes, getRelationships: which elements, which selected, which
 * disabled), and harness/drive.mjs checks that against the store and the returned paths.
 */
import { ClickInteraction, DragNodeInteraction, HoverInteraction, NVL, PanInteraction, ZoomInteraction } from 'vendor:nvl';

/** Entity kinds, grouped for colour. */
const GROUPS = /** @type {Record<string, string>} */ ({
  person: 'person', team: 'person',
  place: 'place',
  technology: 'tech', tool: 'tech',
  topic: 'topic', event: 'topic',
});
export const kindGroup = (/** @type {string} */ kind) => GROUPS[kind] ?? 'thing';

/** The relationship types that are drawn, each captioned with its type; a type not listed is not drawn. */
const EDGES = new Set(['ABOUT', 'SUPERSEDES', 'FROM', 'IN_SESSION']);

const STEP_MS = 130;
const clip = (/** @type {string} */ s, /** @type {number} */ n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const nodeKey = (/** @type {number} */ id) => `n${id}`;
const edgeKey = (/** @type {number} */ id) => `r${id}`;
const engineId = (/** @type {string} */ key) => Number(String(key).slice(1));

/** The --g-* colours of the current theme. */
function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (/** @type {string} */ name) => css.getPropertyValue(`--g-${name}`).trim();
  return {
    person: v('person'), place: v('place'), thing: v('thing'), tech: v('tech'), topic: v('topic'),
    memory: v('memory'), old: v('memory-old'), message: v('message'), session: v('session'),
    edge: v('edge'), edgeOld: v('edge-old'), hl: v('hl'), gap: v('gap'),
    disabled: v('disabled'), disabledFont: v('disabled-font'),
  };
}

/**
 * @param {HTMLElement} host  the element the graph fills
 * @param {{animate?: boolean, onSelect?: (node: any|null) => void}} [opts]
 *   animate: false applies a highlight at once instead of playing it out
 */
export function createGraph(host, { animate = true, onSelect } = {}) {
  const stage = document.createElement('div');
  stage.className = 'nvl';
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  host.append(stage, tip);

  let colors = palette();
  /** @type {Map<number, any>} */ const nodes = new Map();      // engine id -> view
  /** @type {Map<number, any>} */ const edges = new Map();      // engine id -> view
  /** @type {Set<string>} */ let drawnNodes = new Set();        // NVL ids
  /** @type {Set<string>} */ let drawnEdges = new Set();
  let provenance = false;
  /** @type {Set<number>} */ let revealed = new Set();          // provenance nodes a highlight needs
  /** @type {Map<string, {strong: boolean, step: number}>} */ let marks = new Map();
  /** The highlight is revealed up to this step (Infinity when it is not being played out). */
  let shownStep = Infinity;
  /** @type {number[]} */ let timers = [];
  /** @type {number|null} */ let selected = null;
  /**
   * NVL works in device pixels (N6). A node of size s is drawn with a radius of s * dpr layout
   * units, the layout keeps nodes apart in proportion, and a layout point p lands on the screen at
   * (p - pan) * scale / dpr + centre. So sizes here are plain CSS pixels, a scale of 1 draws a node
   * at exactly that size on any screen, and only the camera's arithmetic needs the pixel ratio.
   */
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  /** The visitor zoomed, panned or dragged: the camera is theirs until the graph next changes. */
  let handsOff = false;
  /** The layout is held still (every node pinned) while a path is being lit. */
  let held = false;
  /** Size animations in flight: NVL id -> {from, to, start, ms, pulse}. */
  /** @type {Map<string, {from: number, to: number, start: number, ms: number, pulse: boolean}>} */ const tweens = new Map();
  /** The size each drawn node was last given (its resting size, before any tween). @type {Map<string, number>} */ const rest = new Map();
  /** The camera follows the graph until this time (performance.now()). */
  let followUntil = 0;
  let raf = 0;
  /** @type {number[]} */ let fitTimers = [];

  const options = () => ({
    layout: 'd3Force',
    renderer: 'canvas',
    initialZoom: 1,
    minZoom: 0.1,
    maxZoom: 12,
    disableTelemetry: true,
    disableWebWorkers: true,
    callbacks: { onLayoutDone: () => follow(900) },
    styling: {
      defaultRelationshipColor: colors.edge,
      selectedBorderColor: colors.hl,
      selectedInnerBorderColor: colors.gap,
      dropShadowColor: colors.hl,
      disabledItemColor: colors.disabled,
      disabledItemFontColor: colors.disabledFont,
    },
  });
  const nvl = new NVL(stage, [], [], /** @type {any} */ (options()));
  const click = new ClickInteraction(nvl, { selectOnClick: false });
  const hover = new HoverInteraction(nvl, { drawShadowOnHover: true });
  const handlers = [new ZoomInteraction(nvl), new PanInteraction(nvl), new DragNodeInteraction(nvl), hover, click];
  click.updateCallback('onNodeClick', (/** @type {any} */ n) => select(engineId(n.id)));
  click.updateCallback('onCanvasClick', () => select(null));
  hover.updateCallback('onHover', (/** @type {any} */ el, /** @type {any} */ _hits, /** @type {MouseEvent} */ ev) => {
    const v = el && String(el.id).startsWith('n') ? nodes.get(engineId(el.id)) : null;
    if (v) showTip(v, ev); else tip.hidden = true;
  });
  stage.addEventListener('pointerleave', () => { tip.hidden = true; });
  // zooming, panning or dragging hands the camera to the visitor
  for (const type of ['wheel', 'pointerdown']) stage.addEventListener(type, () => { handsOff = true; followUntil = 0; }, { passive: true });

  // ---- the view model -------------------------------------------------------------------------

  /** @param {{id: number, label: string, props: Record<string, any>}} n */
  function describe(n) {
    if (n.label === 'Entity') return { type: 'entity', group: kindGroup(n.props.kind) };
    if (n.label === 'Memory') return { type: 'memory', group: n.props.kind };
    if (n.label === 'Session') return { type: 'session', group: 'session' };
    return { type: 'message', group: 'message' };
  }
  const isProvenance = (/** @type {any} */ v) => v.type === 'message' || v.type === 'session';
  const visible = (/** @type {any} */ v) => !isProvenance(v) || provenance || revealed.has(v.id);

  /**
   * A node's resting size: its radius in CSS pixels at a scale of 1. An entity grows with what is known about it
   * (one step per current memory, up to five), so the things the conversation keeps returning to
   * stand out; a memory is large enough to hold its gist, a replaced one a little smaller.
   * @param {any} v
   */
  function baseSize(v) {
    if (v.type === 'entity') return 34 + 3 * Math.min(5, v.degree ?? 0);
    if (v.type === 'memory') return v.props.current === false ? 27 : 30;
    if (v.type === 'session') return 30;
    return 20;
  }

  /** The size to draw a node at now: its resting size, or wherever its animation has got to. @param {any} v */
  function sizeNow(v) {
    const t = tweens.get(v.key);
    const to = rest.get(v.key) ?? baseSize(v);
    if (!t) return to;
    const k = Math.min(1, (performance.now() - t.start) / t.ms);
    if (t.pulse) return t.to * (1 + 0.16 * Math.sin(Math.PI * k));        // out and back
    const eased = 1 + 2.2 * (k - 1) ** 3 + 1.2 * (k - 1) ** 2;             // ease-out, a little past the end
    return t.from + (t.to - t.from) * eased;
  }

  /** A node as NVL takes it: its resting look, plus what the current highlight says. @param {any} v */
  function nodeSpec(v) {
    const p = v.props;
    const m = marks.get(v.key);
    const state = { size: sizeNow(v), pinned: held, selected: !!m?.strong && m.step <= shownStep, disabled: marks.size > 0 && !m, activated: selected === v.id };
    if (v.type === 'entity') {
      return { id: v.key, color: /** @type {any} */ (colors)[v.group], captions: [{ value: clip(p.name, 28), styles: ['bold'] }], ...state };
    }
    if (v.type === 'memory') {
      const old = p.current === false;
      return { id: v.key, color: old ? colors.old : colors.memory, captions: [{ value: clip(p.gist ?? '', 26), styles: old ? ['italic'] : [] }], ...state };
    }
    if (v.type === 'session') {
      return { id: v.key, color: colors.session, captions: [{ value: clip(p.title ?? '', 30) }], ...state };
    }
    return { id: v.key, color: colors.message, captions: [{ value: `“${p.seq}”` }], ...state };
  }

  /** @param {any} e */
  function edgeSpec(e) {
    const m = marks.get(e.key);
    const lit = !!m?.strong && m.step <= shownStep;
    const base = e.type === 'SUPERSEDES' ? colors.edgeOld : colors.edge;
    return {
      id: e.key, from: nodeKey(e.source), to: nodeKey(e.target), type: e.type,
      captions: [{ value: e.type }],
      color: lit ? colors.hl : base, width: lit ? 3.5 : e.type === 'SUPERSEDES' ? 2 : 1.4,
      selected: lit, disabled: marks.size > 0 && !m,
    };
  }

  /**
   * Draw the difference between the store and what is drawn.
   * @param {{nodes: Array<{id: number, label: string, props: Record<string, any>}>, rels: Array<{id: number, type: string, source: number, target: number}>}} snapshot
   */
  function update(snapshot) {
    const seen = new Set();
    for (const n of snapshot.nodes) {
      seen.add(n.id);
      const old = nodes.get(n.id);
      if (old) old.props = n.props;
      else nodes.set(n.id, { id: n.id, key: nodeKey(n.id), label: n.label, props: n.props, ...describe(n) });
    }
    for (const id of [...nodes.keys()]) if (!seen.has(id)) nodes.delete(id);
    const seenEdges = new Set();
    for (const r of snapshot.rels) {
      if (!EDGES.has(r.type) || !nodes.has(r.source) || !nodes.has(r.target)) continue;
      seenEdges.add(r.id);
      if (!edges.has(r.id)) edges.set(r.id, { ...r, key: edgeKey(r.id) });
    }
    for (const id of [...edges.keys()]) if (!seenEdges.has(id)) edges.delete(id);
    if (selected !== null && !nodes.has(selected)) select(null);
    sync();
  }

  /** Make NVL hold exactly what should be visible, in its current state. */
  function sync() {
    const wantNodes = [...nodes.values()].filter(visible);
    const keys = new Set(wantNodes.map((v) => v.key));
    const wantEdges = [...edges.values()].filter((e) => keys.has(nodeKey(e.source)) && keys.has(nodeKey(e.target)));
    const edgeKeys = new Set(wantEdges.map((e) => e.key));
    // how much is currently known about each entity: its ABOUT edges from current memories
    for (const v of wantNodes) v.degree = 0;
    for (const e of wantEdges) {
      if (e.type === 'ABOUT' && nodes.get(e.source)?.props.current !== false) { const t = nodes.get(e.target); if (t) t.degree++; }
    }
    const goneEdges = [...drawnEdges].filter((k) => !edgeKeys.has(k));
    const goneNodes = [...drawnNodes].filter((k) => !keys.has(k));
    if (goneEdges.length) nvl.removeRelationshipsWithIds(goneEdges);
    if (goneNodes.length) nvl.removeNodesWithIds(goneNodes);
    for (const k of goneNodes) { rest.delete(k); tweens.delete(k); }
    // a new node grows in; a node whose resting size changed grows or shrinks to it
    const now = performance.now();
    let changed = goneNodes.length > 0;
    for (const v of wantNodes) {
      const to = baseSize(v);
      const was = rest.get(v.key);
      if (was === undefined) {
        changed = true;
        if (animate) tweens.set(v.key, { from: to * 0.3, to, start: now, ms: 520, pulse: false });
      } else if (was !== to) {
        changed = true;
        if (animate) tweens.set(v.key, { from: sizeNow(v), to, start: now, ms: 420, pulse: false });
      }
      rest.set(v.key, to);
    }
    nvl.addAndUpdateElementsInGraph(/** @type {any} */ (wantNodes.map(nodeSpec)), /** @type {any} */ (wantEdges.map(edgeSpec)));
    drawnNodes = keys;
    drawnEdges = edgeKeys;
    if (changed) { handsOff = false; follow(3200); }
    if (tweens.size) run();
  }

  // ---- the camera and the animation loop ------------------------------------------------------

  /**
   * Where the camera should be to show everything drawn: the graph's box, radii included, fitted
   * into the panel with a margin, and never magnified past 1.6 (a handful of nodes should not
   * fill the panel).
   */
  function frame() {
    const held = nvl.getNodes();
    if (!held.length) return null;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const n of held) {
      const r = (n.size ?? 25) * dpr;
      x0 = Math.min(x0, n.x - r); y0 = Math.min(y0, n.y - r); x1 = Math.max(x1, n.x + r); y1 = Math.max(y1, n.y + r);
    }
    const box = stage.getBoundingClientRect();
    const margin = 30;
    const fitScale = dpr * Math.min((box.width - 2 * margin) / Math.max(1, x1 - x0), (box.height - 2 * margin) / Math.max(1, y1 - y0));
    return { scale: Math.min(fitScale, 1.6), x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  }

  /** Put the camera on the graph at once (unless the visitor has taken it). */
  function fitNow() {
    if (handsOff) return;
    const f = frame();
    if (f) nvl.setZoomAndPan(f.scale, f.x, f.y);
  }

  /** Keep the camera on the graph for a while: the layout is moving, or nodes are growing. @param {number} ms */
  function follow(ms) {
    if (!animate) {
      // no easing: fit now, and again as the layout comes to rest (it can take a few seconds)
      for (const t of fitTimers) clearTimeout(t);
      fitTimers = [0, 60, 400, 1000, 2200, 4000].map((d) => window.setTimeout(fitNow, d));
      return;
    }
    followUntil = Math.max(followUntil, performance.now() + ms);
    run();
  }

  function run() {
    if (!raf && animate) raf = requestAnimationFrame(tick);
  }

  /** One animation frame: advance the size tweens, ease the camera towards the graph. */
  function tick() {
    raf = 0;
    const now = performance.now();
    if (tweens.size) {
      const moving = [];
      for (const [key, t] of tweens) {
        const v = nodes.get(engineId(key));
        if (!v || !drawnNodes.has(key)) { tweens.delete(key); continue; }
        moving.push({ id: key, size: sizeNow(v) });
        if (now - t.start >= t.ms) tweens.delete(key);
      }
      if (moving.length) nvl.addAndUpdateElementsInGraph(/** @type {any} */ (moving), []);
    }
    // follow until the time is up and the camera has arrived (the layout may rest later than it says)
    let away = false;
    if (!handsOff) {
      const f = frame();
      if (f) {
        const pan = nvl.getPan();
        const k = nvl.getScale();
        away = Math.abs(f.scale - k) > 0.004 * k || Math.hypot(f.x - pan.x, f.y - pan.y) * k > 1.5;
        if (away) {
          const ease = 0.12;
          nvl.setZoomAndPan(k + (f.scale - k) * ease, pan.x + (f.x - pan.x) * ease, pan.y + (f.y - pan.y) * ease);
        }
      }
    }
    if (tweens.size || now < followUntil || (away && nvl.isLayoutMoving())) run();
    else if (away) window.setTimeout(run, 120);   // nearly there: finish at a slower beat
  }

  // ---- highlight ------------------------------------------------------------------------------

  function clearTimers() {
    for (const t of timers) clearTimeout(t);
    timers = [];
    held = false;
  }

  /**
   * Light the paths the engine returned. In each path rels[i] joins nodes[i] and nodes[i + 1], and
   * `after` delays a path by that many steps: elements are selected in that order.
   * @param {Array<{nodes: number[], rels: number[], strong: boolean, after?: number}>} paths
   */
  function highlight(paths) {
    if (!paths.length) { clearHighlight(); return { strong: 0, soft: 0 }; }
    clearTimers();
    /** @type {typeof marks} */ const next = new Map();
    const mark = (/** @type {string|undefined} */ key, /** @type {boolean} */ strong, /** @type {number} */ step) => {
      if (!key) return;
      const m = next.get(key);
      if (!m || (strong && !m.strong) || (strong === m.strong && step < m.step)) next.set(key, { strong, step });
    };
    const need = new Set();
    for (const p of paths) {
      const from = p.after ?? 0;
      p.nodes.forEach((id, i) => {
        const v = nodes.get(id);
        if (v && isProvenance(v)) need.add(id);
        mark(v?.key, p.strong, from + 2 * i);
      });
      p.rels.forEach((id, i) => mark(edges.get(id)?.key, p.strong, from + 2 * i + 1));
    }
    marks = next;
    revealed = need;
    const steps = [...new Set([...marks.values()].filter((m) => m.strong).map((m) => m.step))].sort((a, b) => a - b);
    if (animate && steps.length > 1) {
      // step everything else back first, then select along the paths, a step at a time; the
      // layout is held still meanwhile, so a pulsing node does not push its neighbours around
      shownStep = -1;
      held = true;
      sync();
      for (const s of steps) {
        timers.push(window.setTimeout(() => {
          shownStep = s;
          // each node pulses as the path reaches it
          const at = performance.now();
          for (const [key, m] of marks) {
            if (m.strong && m.step === s && key.startsWith('n') && rest.has(key)) tweens.set(key, { from: 0, to: /** @type {number} */ (rest.get(key)), start: at, ms: 420, pulse: true });
          }
          sync();
        }, 160 + s * STEP_MS));
      }
      timers.push(window.setTimeout(() => { shownStep = Infinity; held = false; sync(); follow(1500); }, 700 + steps[steps.length - 1] * STEP_MS));
    } else {
      shownStep = Infinity;
      sync();
      follow(1500);   // any update sets the layout moving again (N3): stay on the graph
    }
    const all = [...marks.values()];
    return { strong: all.filter((m) => m.strong).length, soft: all.filter((m) => !m.strong).length };
  }

  function clearHighlight() {
    clearTimers();
    shownStep = Infinity;
    if (!marks.size && !revealed.size) return;
    marks = new Map();
    revealed = new Set();
    sync();
    follow(1500);
  }

  // ---- interaction ----------------------------------------------------------------------------

  /** @param {any} v @param {MouseEvent} ev */
  function showTip(v, ev) {
    const p = v.props;
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'tip-kind';
    const body = document.createElement('div');
    body.className = 'tip-text';
    if (v.type === 'entity') { head.textContent = p.kind; body.textContent = p.name; }
    else if (v.type === 'memory') {
      head.textContent = p.current === false ? `${p.kind} · replaced` : p.kind;
      body.textContent = p.text;
      if (p.rationale) { const why = document.createElement('div'); why.className = 'tip-why'; why.textContent = `because ${p.rationale}`; body.append(why); }
    } else if (v.type === 'session') { head.textContent = 'session'; body.textContent = p.title; }
    else { head.textContent = `message ${p.seq}`; body.textContent = p.text; }
    tip.append(head, body);
    tip.hidden = false;
    const box = host.getBoundingClientRect();
    const x = Math.min(Math.max(8, ev.clientX - box.left - 130), box.width - 268);
    const y = ev.clientY - box.top;
    tip.style.left = `${x}px`;
    if (y + 110 > box.height) { tip.style.top = ''; tip.style.bottom = `${box.height - y + 14}px`; }
    else { tip.style.bottom = ''; tip.style.top = `${y + 18}px`; }
  }

  /** @param {number|null} id */
  function select(id) {
    selected = id !== null && nodes.has(id) && selected !== id ? id : null;
    sync();
    const v = selected === null ? null : nodes.get(selected);
    onSelect?.(v ? { id: v.id, label: v.label, props: v.props } : null);
  }

  return {
    update,
    highlight,
    clearHighlight,
    select,
    /** Fit the view again (the panel changed size). */
    refit: () => { handsOff = false; follow(600); },
    /** The theme changed: read the palette again and redraw in it, keeping positions. */
    retheme() {
      colors = palette();
      nvl.restart(/** @type {any} */ (options()), true);
      sync();
      follow(600);
    },
    /** Show or hide messages and sessions. @param {boolean} on */
    setProvenance(on) {
      provenance = on;
      sync();
    },
    /** NVL's view: its scale and pan, and where each node is (layout and screen). */
    view() {
      const box = stage.getBoundingClientRect();
      return { scale: nvl.getScale(), pan: nvl.getPan(), width: box.width, height: box.height,
        nodes: nvl.getNodes().map((n) => ({ id: n.id, x: n.x, y: n.y, size: n.size, client: n.clientPosition })) };
    },
    /** What NVL holds, for the page's counters and the browser test. */
    stats() {
      const held = nvl.getNodes();
      const rels = nvl.getRelationships();
      const view = (/** @type {any} */ n) => nodes.get(engineId(n.id));
      const count = (/** @type {string} */ t) => held.filter((n) => view(n)?.type === t).length;
      return {
        entities: count('entity'), memories: count('memory'), messages: count('message'), sessions: count('session'),
        superseded: held.filter((n) => view(n)?.type === 'memory' && view(n).props.current === false).length,
        edges: rels.length,
        selected: { nodes: held.filter((n) => n.selected).length, rels: rels.filter((r) => r.selected).length },
        disabled: { nodes: held.filter((n) => n.disabled).length, rels: rels.filter((r) => r.disabled).length },
        selectedMemories: held.filter((n) => n.selected && view(n)?.type === 'memory').map((n) => view(n).props.id),
        canvases: stage.querySelectorAll('canvas').length,
      };
    },
    destroy() {
      clearTimers();
      for (const t of fitTimers) clearTimeout(t);
      if (raf) cancelAnimationFrame(raf);
      for (const h of handlers) h.destroy();
      nvl.destroy();
      stage.remove();
      tip.remove();
    },
  };
}
