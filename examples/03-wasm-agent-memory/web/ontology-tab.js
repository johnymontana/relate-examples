// @ts-check
/**
 * ontology-tab.js: the Ontology tab. The memory model as its document says it
 * (data/agent-memory.ontology.json), drawn with NVL, searched, and held against the store.
 *
 * Everything it knows comes from ontology.js, which harness/run.mjs calls too (NOTES.md D10, D11):
 *   the picture     a node per label where the document places it, a relationship per
 *                   relationship type, and the properties of the label that is open on an arc
 *                   around it. A line under it says how many of each label the store holds now.
 *   the search      the parts that hold every word typed; what it found is lit in the picture
 *   the detail      one part as the document describes it, with what the engine enforces of it,
 *                   and a way to light the nodes or relationships it describes in the Memory tab
 *   the rules       what the engine does not enforce, each a statement that returns its
 *                   violations, run on the store as it is when the visitor asks
 *   the questions   the questions the document lists, each run on the store with parameters
 *                   picked from what the store holds
 *
 * The picture uses NVL's `free` layout (N7): the tab says where each node goes, so nothing moves
 * unless the visitor drags it, and the camera is this module's (graph.js frameOf). NVL draws to a
 * canvas, so a test reads NVL's own state back (stats), as it does for the Memory tab.
 *
 * The statements go to the engine through `read` (the worker's `read` op), which logs them under
 * the hood as `check` and `ask`. Nothing here writes to the store.
 */
import { ClickInteraction, DragNodeInteraction, HoverInteraction, NVL, PanInteraction } from 'vendor:nvl';
import { frameOf, palette } from './graph.js';
import { bind, bound, constraintsOf, facts, graphType, instances, judge, labelOf, outline, own, picture, rules, search, tally } from './ontology.js';

/** The palette entry of each label's node: the colours the Memory tab draws its nodes in. */
const COLOUR = /** @type {Record<string, string>} */ ({ session: 'session', message: 'message', entity: 'person', memory: 'memory' });
/** How the tab words a key of the document's own data, where the key alone would not say. */
const TERMS = /** @type {Record<string, string>} */ ({ drawn: 'drawn in the Memory tab', endpoints: 'its two ends', written_by: 'written by', searched_by: 'searched by', backed_by: 'backed by' });
const GROUPS = /** @type {Record<string, string>} */ ({ values: 'The values a property takes', counts: 'How many relationships a node has', invariants: 'What must hold between memories', declared: 'Nothing the model does not have' });
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many) => `${n} ${n === 1 ? one : many}`;
/** A key's two halves: `property:memory.kind` -> ['property', 'memory', 'kind']. @param {string} key */
const split = (key) => { const i = key.indexOf(':'); const [a, b] = key.slice(i + 1).split('.'); return [key.slice(0, i), a, b]; };

/**
 * The picture: NVL, holding what ontology.js picture() says to draw.
 * @param {HTMLElement} host
 * @param {{h: Function, onSelect: (key: string|null) => void, tipFor: (key: string) => [string, string]|null}} opts
 */
function createPicture(host, { h, onSelect, tipFor }) {
  const stage = h('div', 'nvl');
  const tip = h('div', 'tip');
  tip.hidden = true;
  host.append(stage, tip);
  let colors = palette();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  /** @type {ReturnType<typeof picture>} */ let pic = { nodes: [], rels: [] };
  /** @type {string|null} */ let selected = null;
  /** The keys a search found, or null when nothing is being searched for. @type {Set<string>|null} */ let lit = null;
  /** @type {Set<string>} */ let drawnNodes = new Set();
  /** @type {Set<string>} */ let drawnRels = new Set();
  /** The visitor panned or dragged: the camera is theirs until the picture next changes. */
  let handsOff = false;

  const options = () => ({
    layout: 'free',
    renderer: 'canvas',
    initialZoom: 1,
    minZoom: 0.2,
    maxZoom: 4,
    disableTelemetry: true,
    disableWebWorkers: true,
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
  // no zoom on the wheel: the picture sits in a pane that scrolls
  const handlers = [new PanInteraction(nvl), new DragNodeInteraction(nvl), hover, click];
  /** A property's line to its label is not a part of the model. @param {any} el */
  const part = (el) => (el && !String(el.id).startsWith('has:') ? String(el.id) : null);
  click.updateCallback('onNodeClick', (/** @type {any} */ n) => onSelect(part(n)));
  click.updateCallback('onRelationshipClick', (/** @type {any} */ r) => { if (part(r)) onSelect(part(r)); });
  click.updateCallback('onCanvasClick', () => onSelect(null));
  hover.updateCallback('onHover', (/** @type {any} */ el, /** @type {any} */ _hits, /** @type {MouseEvent} */ ev) => {
    const text = part(el) ? tipFor(/** @type {string} */ (part(el))) : null;
    if (!text) { tip.hidden = true; return; }
    tip.replaceChildren(h('div', 'tip-kind', text[0]), h('div', 'tip-text', text[1]));
    tip.hidden = false;
    const box = host.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(8, ev.clientX - box.left - 130), box.width - 268)}px`;
    const y = ev.clientY - box.top;
    if (y + 110 > box.height) { tip.style.top = ''; tip.style.bottom = `${box.height - y + 14}px`; } else { tip.style.bottom = ''; tip.style.top = `${y + 18}px`; }
  });
  stage.addEventListener('pointerleave', () => { tip.hidden = true; });
  stage.addEventListener('pointerdown', () => { handsOff = true; }, { passive: true });

  /** @param {ReturnType<typeof picture>['nodes'][number]} n */
  const nodeSpec = (n) => {
    const id = split(n.key)[1];
    const state = { size: n.r, pinned: true, selected: selected === n.key, disabled: !!lit && !lit.has(n.key) };
    // a caption is sized by its node and its length (N8): a label's one word fits at the smallest size, a property's name is drawn larger
    if (n.kind === 'property') return { id: n.key, color: n.required ? colors.property : colors.optional, captionSize: 3, captions: [{ value: n.caption, styles: n.required ? [] : ['italic'] }], ...state };
    return { id: n.key, color: /** @type {any} */ (colors)[COLOUR[id] ?? 'thing'], captionSize: 1, captions: [{ value: n.caption, styles: ['bold'] }], ...state };
  };
  /** @param {ReturnType<typeof picture>['rels'][number]} r */
  const relSpec = (r) => {
    const on = selected === r.key;
    const off = !!lit && !lit.has(r.kind === 'has' ? r.to : r.key);
    return { id: r.key, from: r.from, to: r.to, captions: r.caption ? [{ value: r.caption }] : [], captionSize: 2, color: on ? colors.hl : colors.edge, width: on ? 3 : r.kind === 'has' ? 1 : 1.6, selected: on, disabled: off };
  };

  /** Put the camera on the whole picture (unless the visitor has taken it). */
  function fit() {
    if (handsOff) return;
    const f = frameOf(pic.nodes.map((n) => ({ x: n.x * dpr, y: n.y * dpr, size: n.r })), stage.getBoundingClientRect(), dpr, { margin: 22, most: 1.35 });
    if (f) nvl.setZoomAndPan(f.scale, f.x, f.y);
  }

  /** Make NVL hold the picture, in its current state. @param {boolean} moved  the nodes are not where they were */
  function sync(moved) {
    const nodeKeys = new Set(pic.nodes.map((n) => n.key));
    const relKeys = new Set(pic.rels.map((r) => r.key));
    const goneRels = [...drawnRels].filter((k) => !relKeys.has(k));
    const goneNodes = [...drawnNodes].filter((k) => !nodeKeys.has(k));
    if (goneRels.length) nvl.removeRelationshipsWithIds(goneRels);
    if (goneNodes.length) nvl.removeNodesWithIds(goneNodes);
    nvl.addAndUpdateElementsInGraph(/** @type {any} */ (pic.nodes.map(nodeSpec)), /** @type {any} */ (pic.rels.map(relSpec)));
    drawnNodes = nodeKeys;
    drawnRels = relKeys;
    if (moved) {
      // the free layout keeps a node where it is put; positions are layout units, as sizes are (N6)
      nvl.setNodePositions(/** @type {any} */ (pic.nodes.map((n) => ({ id: n.key, x: n.x * dpr, y: n.y * dpr }))));
      handsOff = false;
      fit();
    }
  }

  return {
    /** @param {ReturnType<typeof picture>} next */
    draw(next) {
      const moved = next.nodes.length !== pic.nodes.length || next.nodes.some((n, i) => n.key !== pic.nodes[i].key);
      pic = next;
      sync(moved);
    },
    /** @param {string|null} key */
    select(key) { selected = key; sync(false); },
    /** @param {Set<string>|null} keys */
    light(keys) { lit = keys; sync(false); },
    refit() { handsOff = false; fit(); },
    retheme() {
      colors = palette();
      nvl.restart(/** @type {any} */ (options()), true);
      sync(true);
    },
    /** What NVL holds, for the browser test. */
    stats() {
      const held = nvl.getNodes();
      const rels = nvl.getRelationships();
      const box = stage.getBoundingClientRect();
      const scale = nvl.getScale();
      const outside = held.filter((n) => {
        const r = (n.size ?? 0) * scale;
        const c = /** @type {any} */ (n).clientPosition ?? { x: -1, y: -1 };
        return c.x - r < -1 || c.y - r < -1 || c.x + r > box.width + 1 || c.y + r > box.height + 1;
      }).length;
      return {
        labels: held.filter((n) => n.id.startsWith('node:')).length,
        properties: held.filter((n) => n.id.startsWith('property:')).length,
        types: rels.filter((r) => r.id.startsWith('relationship:')).length,
        lines: rels.filter((r) => r.id.startsWith('has:')).length,
        selected: [...held.filter((n) => n.selected).map((n) => n.id), ...rels.filter((r) => r.selected).map((r) => r.id)],
        disabled: held.filter((n) => n.disabled).length,
        captions: held.filter((n) => n.id.startsWith('node:')).map((n) => (n.captions ?? []).map((c) => c.value).join(' ')),
        outside,
        canvases: stage.querySelectorAll('canvas').length,
      };
    },
    destroy() {
      for (const x of handlers) x.destroy();
      nvl.destroy();
      stage.remove();
      tip.remove();
    },
  };
}

/**
 * @param {{doc: any,
 *          ui: {h: (tag: string, cls?: string, text?: string) => HTMLElement, cypher: (text: string) => HTMLElement, table: (columns: string[], rows: any[]) => HTMLElement},
 *          read: (tool: 'ask'|'check', statements: Array<{text: string, params: Record<string, any>}>) => Promise<Array<{columns: string[], rows: any[], error: string|null}>>,
 *          store: () => import('./ontology.js').Snapshot,
 *          idle: () => boolean,
 *          showInMemory: (paths: any[], caption: string) => void}} deps
 *   read: statements to the engine, answered in order. idle: the engine is free to take them.
 */
export function createOntologyTab({ doc, ui, read, store, idle, showInMemory }) {
  const { h, cypher, table } = ui;
  const parts = outline(doc);
  const byKey = new Map(parts.map((p) => [p.key, p]));
  const nodes = /** @type {Record<string, any>} */ (doc.nodes ?? {});
  const rels = /** @type {Record<string, any>} */ (doc.relationships ?? {});
  const list = rules(doc);
  const state = {
    /** @type {string|null} */ selected: 'node:memory',
    /** @type {string|null} */ expanded: 'memory',
    query: '',
    /** @type {ReturnType<typeof search>} */ hits: [],
    /** @type {ReturnType<typeof judge>|null} */ audit: null,
    stale: false,
    /** @type {{id: string, params: Record<string, any>, columns: string[], rows: any[], error: string|null}|null} */ answer: null,
    /** @type {boolean|null} */ engineAgrees: null,
    shown: false,
  };
  /** @type {ReturnType<typeof createPicture>|null} */ let pic = null;

  // ---- words for what the document says ----------------------------------------------------------

  const typeOf = (/** @type {any} */ p) => `${p.type}${p.dimension ? `(${p.dimension})` : ''}`;
  /** A property's rules in a few words. @param {any} n @param {string} pid */
  const rulesOf = (n, pid) => {
    const p = n.properties[pid];
    const f = facts(n, pid);
    const bits = [f.required ? 'required' : 'optional'];
    if (f.unique) bits.push(`unique${f.unique.name ? ` (${f.unique.name})` : ''}`);
    if (p.one_of) bits.push(`one of ${p.one_of.join(', ')}`);
    if (p.pattern) bits.push(`matches ${p.pattern}`);
    return bits.join(' · ');
  };
  const endWords = (/** @type {any} */ r, /** @type {'from'|'to'} */ end) => `every ${labelOf(nodes[r[end].node])} has ${bound(r[end])?.words ?? 'any number'} ${end === 'from' ? 'going out' : 'coming in'}`;
  const shape = (/** @type {any} */ r) => `(:${labelOf(nodes[r.from.node])})-[:${r.type}]->(:${labelOf(nodes[r.to.node])})`;
  const first = (/** @type {string} */ text) => { const m = /^.*?[.:](?=\s|$)/.exec(text ?? ''); return m ? m[0].replace(/:$/, '.') : text ?? ''; };

  /** A part's tooltip: a small heading and a line. @param {string} key @returns {[string, string]|null} */
  function tipFor(key) {
    const p = byKey.get(key);
    if (!p) return null;
    if (p.kind === 'node') return ['label', first(p.def.description)];
    if (p.kind === 'relationship') return [shape(p.def), first(p.def.description)];
    if (p.kind === 'property') return [`${typeOf(p.def)} · ${facts(nodes[/** @type {string} */ (p.owner)], p.id).required ? 'required' : 'optional'}`, first(p.def.description)];
    return null;
  }

  // ---- the picture and what is lit in it ----------------------------------------------------------

  /** The key NVL should show as selected: a part that is not drawn selects the label it belongs to. */
  const drawnKey = () => {
    const p = state.selected ? byKey.get(state.selected) : null;
    if (!p) return null;
    if (p.kind === 'node' || p.kind === 'relationship') return p.key;
    if (p.kind === 'property') return p.owner === state.expanded ? p.key : `node:${p.owner}`;
    return p.kind === 'index' ? `node:${p.owner}` : null;
  };
  /** What a search lights: each hit, and the label a hit belongs to. */
  const litKeys = () => {
    if (!state.query.trim()) return null;
    const keys = new Set();
    for (const hit of state.hits) {
      const p = /** @type {import('./ontology.js').Part} */ (byKey.get(hit.key));
      if (p.kind === 'node' || p.kind === 'relationship' || p.kind === 'property') keys.add(p.key);
      if (p.owner) keys.add(`node:${p.owner}`);
    }
    return keys;
  };
  function redraw() {
    if (!pic) return;
    pic.draw(picture(doc, { expanded: state.expanded }));
    pic.light(litKeys());
    pic.select(drawnKey());
  }

  // ---- the detail of one part -------------------------------------------------------------------

  /** A link that selects a part. @param {string} key @param {string} text @param {string} [cls] */
  const link = (key, text, cls = 'onto-link') => {
    const b = h('button', cls, text);
    b.type = 'button';
    b.dataset.key = key;
    b.addEventListener('click', () => select(key));
    return b;
  };
  /** A term and its value in a definition list; nothing when there is no value. */
  const term = (/** @type {HTMLElement} */ dl, /** @type {string} */ k, /** @type {string|Node|null|undefined} */ v) => {
    if (v === null || v === undefined || v === '') return;
    const dd = h('dd');
    dd.append(v);
    dl.append(h('dt', '', k), dd);
  };
  /** What this repository's own data says of a part, as terms. @param {HTMLElement} dl @param {Record<string, any>} data @param {string[]} [skip] */
  const ownTerms = (dl, data, skip = []) => {
    const show = (/** @type {any} */ v) => (Array.isArray(v) ? v.join(', ') : v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}: ${Array.isArray(x) ? x.join(', ') : x}`).join('; ') : v === true ? 'yes' : v === false ? 'no' : String(v));
    for (const [k, v] of Object.entries(data)) if (!skip.includes(k)) term(dl, TERMS[k] ?? k.replace(/_/g, ' '), show(v));
  };
  const outside = (/** @type {string} */ url) => {
    const a = /** @type {HTMLAnchorElement} */ (h('a', '', url.replace(/^https?:\/\//, '')));
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  };
  /** "N in the store", and a way to see them. @param {string} key @param {string} what */
  const stored = (key, what) => {
    const paths = instances(doc, key, store());
    const box = h('span');
    box.append(`${paths.length} in the store now`);
    if (paths.length) {
      const b = h('button', 'onto-link', 'show in Memory');
      b.type = 'button';
      b.dataset.testid = 'onto-show';
      b.addEventListener('click', () => showInMemory(paths, what));
      box.append(' · ', b);
    }
    return box;
  };

  function renderDetail() {
    const box = $('onto-detail');
    box.replaceChildren();
    const p = state.selected ? byKey.get(state.selected) : null;
    box.dataset.key = p?.key ?? '';
    if (!p || p.kind === 'question' || p.kind === 'invariant') {
      box.append(h('p', 'note', 'Click a label or a relationship type in the picture, or search, to read what the model says of it.'));
      return;
    }
    const d = p.def;
    const dl = h('dl');
    if (p.kind === 'node') {
      const cs = constraintsOf(d);
      const n = (/** @type {string} */ t) => cs.filter((c) => c.type === t).length;
      box.append(h('div', 'insp-kind', 'label'), h('h3', '', p.title), h('p', 'onto-desc', d.description));
      term(dl, 'also called', (d.aliases ?? []).join(', '));
      term(dl, 'see', d.reference ? outside(d.reference) : null);
      term(dl, 'stored', stored(p.key, `Every ${p.title} in the store.`));
      term(dl, 'the engine enforces', `the type of ${plural(n('PROPERTY_TYPE'), 'property', 'properties')}, the presence of ${n('EXISTS')}, and ${cs.filter((c) => c.type === 'UNIQUE').map((c) => `${c.name} (one node per ${c.properties.join(', ')})`).join(', ')}`);
      const drawn = own(d.extensions?.display);
      term(dl, 'in the Memory tab', drawn.caption ? `captioned with its ${drawn.caption}, with a radius of ${drawn.radius}, and shown ${drawn.shown}` : null);
      box.append(dl);
      const t = h('table', 'rows onto-props');
      const head = h('tr');
      for (const c of ['property', 'type', 'rules']) head.append(h('th', '', c));
      t.append(head);
      for (const pid of Object.keys(d.properties ?? {})) {
        const tr = h('tr');
        const name = h('td');
        name.append(link(`property:${p.id}.${pid}`, d.properties[pid].name ?? pid));
        tr.append(name, h('td', '', typeOf(d.properties[pid])), h('td', '', rulesOf(d, pid)));
        t.append(tr);
      }
      const wrap = h('div', 'table-wrap');
      wrap.append(t);
      box.append(wrap);
      const around = h('p', 'onto-around');
      const mine = Object.entries(rels).filter(([, r]) => r.from.node === p.id || r.to.node === p.id);
      around.append('Relationship types: ');
      mine.forEach(([rid, r], i) => around.append(i ? ' · ' : '', link(`relationship:${rid}`, shape(r))));
      box.append(around);
      const ix = Object.entries(d.extensions?.indexes ?? {});
      if (ix.length) {
        const line = h('p', 'onto-around');
        line.append('Indexes: ');
        ix.forEach(([iid, i], k) => line.append(k ? ' · ' : '', link(`index:${p.id}.${iid}`, `${/** @type {any} */ (i).name} (${/** @type {any} */ (i).type})`)));
        box.append(line);
      }
    } else if (p.kind === 'property') {
      const n = nodes[/** @type {string} */ (p.owner)];
      const f = facts(n, p.id);
      const kind = h('div', 'insp-kind');
      kind.append('a property of ', link(`node:${p.owner}`, labelOf(n)));
      box.append(kind, h('h3', '', p.title), h('p', 'onto-desc', d.description));
      term(dl, 'type', `${typeOf(d)}${f.typed ? ', which the engine checks on every write' : ''}`);
      term(dl, 'presence', f.required ? 'required: the engine refuses a node without it' : 'optional');
      term(dl, 'unique', f.unique ? `${f.unique.name ?? 'yes'}: no two nodes share a value` : null);
      if (d.one_of) {
        const values = own(d).values ?? {};
        const ul = h('ul', 'onto-values');
        for (const v of d.one_of) { const li = h('li'); li.append(h('code', '', v), values[v] ? ` ${values[v]}` : ''); ul.append(li); }
        term(dl, 'one of', ul);
      }
      term(dl, 'matches', d.pattern ? h('code', '', d.pattern) : null);
      if (d.one_of || d.pattern) term(dl, 'kept by', 'the agent, not the engine: see the rules below');
      term(dl, 'see', d.reference ? outside(d.reference) : null);
      term(dl, 'stored', stored(p.key, `Every ${labelOf(n)} that has ${d.name ?? p.id}.`));
      ownTerms(dl, own(d), ['values']);
      box.append(dl);
    } else if (p.kind === 'relationship') {
      box.append(h('div', 'insp-kind', 'relationship type'), h('h3', '', shape(d)), h('p', 'onto-desc', d.description));
      term(dl, 'also called', (d.aliases ?? []).join(', '));
      term(dl, 'see', d.reference ? outside(d.reference) : null);
      const from = h('span');
      from.append(link(`node:${d.from.node}`, labelOf(nodes[d.from.node])), `: ${endWords(d, 'from')}`);
      const to = h('span');
      to.append(link(`node:${d.to.node}`, labelOf(nodes[d.to.node])), `: ${endWords(d, 'to')}`);
      term(dl, 'from', from);
      term(dl, 'to', to);
      term(dl, 'stored', stored(p.key, `Every ${d.type} relationship in the store, with its two ends.`));
      ownTerms(dl, own(d));
      box.append(dl);
    } else {
      const n = nodes[/** @type {string} */ (p.owner)];
      const kind = h('div', 'insp-kind');
      kind.append(`${String(d.type).toLowerCase()} index on `, link(`node:${p.owner}`, labelOf(n)));
      box.append(kind, h('h3', '', p.title));
      term(dl, 'covers', `${d.labels.join(', ')}.${d.properties.join(', ')}`);
      for (const [k, v] of Object.entries(d.options ?? {})) if (k !== 'type') term(dl, k, String(v));
      ownTerms(dl, own(d));
      box.append(dl);
    }
  }

  // ---- search ------------------------------------------------------------------------------------

  function renderHits() {
    const ul = $('onto-results');
    ul.replaceChildren();
    const on = !!state.query.trim();
    ul.hidden = !on;
    $('onto-hits').textContent = on ? (state.hits.length ? plural(state.hits.length, 'part', 'parts') : 'nothing in the model says that') : '';
    for (const hit of state.hits) {
      const li = h('li');
      const b = link(hit.key, '', 'onto-hit');
      b.append(h('span', 'onto-kind', hit.kind === 'node' ? 'label' : hit.kind), h('span', 'onto-title', hit.title), h('span', 'onto-where', hit.where));
      li.append(b);
      ul.append(li);
    }
  }

  /** @param {string} text */
  function find(text) {
    state.query = text;
    state.hits = search(doc, text);
    renderHits();
    if (pic) pic.light(litKeys());
    return state.hits;
  }

  // ---- the rules ---------------------------------------------------------------------------------

  function renderRules() {
    const ul = $('onto-rules');
    ul.replaceChildren();
    const held = state.audit ? state.audit.filter((r) => !r.violations.length).length : 0;
    const s = store();
    const note = $('onto-check-note');
    note.dataset.state = !state.audit ? 'unchecked' : state.stale ? 'stale' : held === list.length ? 'held' : 'broken';
    note.textContent = !state.audit ? `${list.length} rules, not checked yet`
      : `${held === list.length ? `All ${list.length} rules hold` : `${list.length - held} of ${list.length} rules broken`}${state.stale ? ', but the store has changed since: check again' : ` for the ${plural(s.nodes.length, 'node', 'nodes')} and ${plural(s.rels.length, 'relationship', 'relationships')} in the store`}`;
    let group = '';
    list.forEach((r, i) => {
      if (r.group !== group) { group = r.group; ul.append(h('li', 'onto-group', GROUPS[group] ?? group)); }
      const got = state.audit?.[i] ?? null;
      const li = h('li', `onto-rule ${!got ? 'unchecked' : got.violations.length ? 'broken' : 'held'}`);
      li.dataset.rule = r.id;
      const det = /** @type {HTMLDetailsElement} */ (h('details'));
      const sum = h('summary');
      sum.append(h('span', 'onto-mark', !got ? '·' : got.violations.length ? '✕' : '✓'), h('span', 'onto-says', r.says));
      if (got?.violations.length) sum.append(h('span', 'onto-count', plural(got.violations.length, 'violation', 'violations')));
      det.append(sum);
      if (got?.violations.length) {
        const vs = h('ul', 'onto-violations');
        for (const v of got.violations.slice(0, 12)) vs.append(h('li', '', v));
        if (got.violations.length > 12) vs.append(h('li', '', `and ${got.violations.length - 12} more`));
        det.append(vs);
        det.open = true;
      }
      for (const text of r.statements.map((x) => x.text)) { const box = h('div', 'stmt'); box.append(cypher(text)); det.append(box); }
      li.append(det);
      ul.append(li);
    });
  }

  /** Run every rule's statements on the store as it is, and judge them. */
  async function check() {
    const results = await read('check', list.flatMap((r) => r.statements));
    const failed = results.find((r) => r.error);
    if (failed) throw new Error(`a rule's statement was refused: ${failed.error}`);
    state.audit = judge(list, results.map((r) => r.rows));
    state.stale = false;
    renderRules();
    return state.audit;
  }

  // ---- the questions ----------------------------------------------------------------------------

  const questions = /** @type {any[]} */ (own(doc).questions ?? []);

  function renderQuestions() {
    const ul = $('onto-questions');
    ul.replaceChildren();
    for (const q of questions) {
      const li = h('li');
      const b = h('button', `onto-q${state.answer?.id === q.id ? ' active' : ''}`, q.question);
      b.type = 'button';
      b.dataset.question = q.id;
      b.addEventListener('click', () => { if (idle()) ask(q.id).catch(() => {}); });
      li.append(b);
      ul.append(li);
    }
  }

  function renderAnswer() {
    const box = $('onto-answer');
    box.replaceChildren();
    const a = state.answer;
    box.dataset.question = a?.id ?? '';
    if (!a) return;
    const q = questions.find((x) => x.id === a.id);
    const { choices } = bind(doc, q, store());
    const names = Object.keys(q.parameters ?? {});
    if (names.length) {
      const row = h('div', 'onto-params');
      for (const name of names) {
        const lab = h('label', '', `$${name} `);
        const sel = /** @type {HTMLSelectElement} */ (h('select'));
        sel.dataset.param = name;
        const values = choices[name].includes(String(a.params[name])) ? choices[name] : [String(a.params[name]), ...choices[name]];
        for (const v of values) { const o = /** @type {HTMLOptionElement} */ (h('option', '', v)); o.value = v; o.selected = v === String(a.params[name]); sel.append(o); }
        sel.addEventListener('change', () => { if (idle()) ask(q.id, { ...a.params, [name]: sel.value }).catch(() => {}); });
        lab.append(sel);
        row.append(lab);
      }
      box.append(row);
    }
    const stmt = h('div', 'stmt');
    stmt.append(cypher(q.cypher));
    box.append(stmt);
    if (a.error) {
      const err = h('div', 'result-error');
      err.append(h('pre', '', a.error));
      box.append(err);
      return;
    }
    box.append(h('div', 'result-meta', a.rows.length ? plural(a.rows.length, 'row', 'rows') : store().nodes.length ? 'no rows: nothing in the store answers that' : 'no rows: the store is empty. Play the conversation first.'));
    if (a.rows.length) box.append(table(a.columns, a.rows));
  }

  /**
   * Run one of the document's questions on the store.
   * @param {string} id @param {Record<string, any>} [params]  left out: picked from the store (ontology.js bind)
   */
  async function ask(id, params) {
    const q = questions.find((x) => x.id === id);
    if (!q) throw new Error(`the document has no question ${id}`);
    const values = params ?? bind(doc, q, store()).values;
    const [res] = await read('ask', [{ text: q.cypher, params: values }]);
    state.answer = { id, params: values, columns: res.columns, rows: res.rows, error: res.error };
    renderQuestions();
    renderAnswer();
    return state.answer;
  }

  // ---- selecting ---------------------------------------------------------------------------------

  /** @param {string|null} key */
  function select(key) {
    const p = key ? byKey.get(key) : null;
    if (p?.kind === 'question') {
      $('onto-questions-h').scrollIntoView({ block: 'start' });
      if (idle()) ask(p.id).catch(() => {});
      return;
    }
    if (p?.kind === 'invariant') {
      const li = /** @type {HTMLElement|null} */ ($('onto-rules').querySelector(`[data-rule="${p.id}"]`));
      $('onto-rules-h').scrollIntoView({ block: 'start' });
      const det = li?.querySelector('details');
      if (det) det.open = true;
      return;
    }
    state.selected = p ? p.key : null;
    if (p?.kind === 'node') state.expanded = p.id;
    else if (p?.owner) state.expanded = p.owner;
    redraw();
    renderDetail();
  }

  /** How many of each label the store holds now, under the picture. */
  function renderCounts() {
    const t = tally(doc, store());
    const bits = Object.keys(nodes).map((nid) => `${t[`node:${nid}`]} ${labelOf(nodes[nid])}`);
    $('onto-counts').textContent = `The store holds ${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]} nodes now.`;
  }

  function refreshStatus() {
    const el = $('onto-status');
    el.dataset.state = state.engineAgrees === null ? 'unknown' : state.engineAgrees ? 'same' : 'different';
    el.textContent = state.engineAgrees === null ? ''
      : state.engineAgrees ? '✓ The engine enforces exactly this: the graph type derived from the document is, character for character, the one the engine reads back (under the hood).'
        : '✕ The graph type derived from the document is not the one the engine reads back.';
  }

  // ---- wiring ------------------------------------------------------------------------------------

  $('onto-q').addEventListener('input', (e) => find(/** @type {HTMLInputElement} */ (e.target).value));
  $('onto-check').addEventListener('click', () => { if (idle()) check().catch(() => {}); });
  renderDetail();
  renderRules();
  renderQuestions();
  renderCounts();

  return {
    /** The tab came into view: NVL needs a host with a size, so the picture is made now. */
    show() {
      state.shown = true;
      if (!pic) {
        pic = createPicture($('onto-graph'), { h, onSelect: (key) => select(key), tipFor });
        new ResizeObserver(() => pic?.refit()).observe($('onto-graph'));
        redraw();
      } else pic.refit();
      renderDetail();
    },
    hide() { state.shown = false; },
    /** The store changed: the counts move, and a check made before is of another store. */
    storeChanged() {
      renderCounts();
      if (state.audit && !state.stale) { state.stale = true; renderRules(); }
      if (state.shown) renderDetail();
    },
    /** A new store was opened: what was checked and asked is of the old one. @param {string} text  the graph type the engine reads back */
    opened(text) {
      state.engineAgrees = graphType(doc) === text;
      state.audit = null;
      state.stale = false;
      state.answer = null;
      refreshStatus();
      renderRules();
      renderQuestions();
      renderAnswer();
    },
    retheme() { pic?.retheme(); },
    /** The key of the part that describes a label, or null. @param {string} label */
    keyOf: (label) => { const hit = Object.entries(nodes).find(([, n]) => labelOf(n) === label); return hit ? `node:${hit[0]}` : null; },
    select,
    find,
    check,
    ask,
    /** What a script needs to see. */
    state: () => ({
      selected: state.selected,
      expanded: state.expanded,
      hits: state.hits.map((x) => x.key),
      audit: state.audit ? state.audit.map((r) => ({ id: r.id, violations: r.violations })) : null,
      stale: state.stale,
      answer: state.answer,
      engineAgrees: state.engineAgrees,
      drawn: pic ? pic.stats() : null,
    }),
  };
}
