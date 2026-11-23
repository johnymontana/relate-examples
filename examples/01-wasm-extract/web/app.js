// @ts-check
/**
 * app.js: the page (NOTES.md D6, D11, D14, D16, D17). It holds no
 * database and no model: the engine worker (worker.js) owns the store and the model, and the
 * console worker (console.js) borrows the store one query at a time. This module wires the DOM
 * to them, keeps the per-viewer settings in localStorage under `ex01.*` (D14), and draws the
 * graphs through graphview.js.
 *
 * The page: three numbered steps in the left column (1 Domain: one picker of the
 * 27 bundled ontologies, which opens that ontology's store and puts its sample in the Document box;
 * 2 Model; 3 Extract, with the Document disclosure: the sample's text without its YAML front matter,
 * which is kept and extracted with it while the text is the sample's, a file, a title), and six tabs
 * that fill the rest of the viewport: Graph (an empty state saying what to do next, a progress banner
 * over the canvas while an extraction runs, a summary line after it, the view fitted after an
 * extraction and a store switch), Review, Ontology (the ontology as an NVL picture of its kinds and
 * links, and the v1 document's editor), Cutoffs, Console (editor first; the ontology's tools
 * collapsed below the results) and Store (the store picker, facts, download and restore). A store
 * switch clears the side panels and the console's result.
 *
 * The Document's title follows its text (the sample's id while it is the
 * sample, else its first heading, the file's name or "pasted-N"; a typed title is the user's), a title
 * the store holds for other text is asked about before extracting (replace it through Forget, keep
 * both, or cancel), the summary line says what this document kept before what the graph holds, and
 * the Store tab tells same-titled documents apart.
 *
 * Test hooks (harness/drive.mjs): every control has a data-testid (see index.html); <body> carries
 * data-engine (starting|ready|recycling|crashed|failed), data-store (the open store's name),
 * data-model (none|loading|ready|failed), data-busy (0|1) and data-extract (idle|planning|confirm|
 * duplicate|running|stopped|done|failed; duplicate: the store holds the title for other text, #dup asks); window.ex01 exposes {state, call(kind, args), graphView,
 * consoleView, ontologyView, ready, runConsole(query, params, {strict}), refreshGraph(),
 * restartEngine(), recycleEngine(), currentDoc()}; state.consoleQueries counts the queries sent to
 * the console worker; each GraphView counts its fits (fits) and measures the last one (lastFit:
 * zoom, nodes inside the canvas, the smallest kept node's radius on screen). The extraction's status
 * line carries data-sections-done and data-sections (the crash test kills between two sections).
 * The graph tab's counts line carries data-scope (doc|all, what it was drawn for), data-nodes,
 * data-rels, data-candidate-nodes and data-candidate-rels; the summary line data-entities, data-rels
 * and data-review (the store's) and data-doc-entities, data-doc-rels and data-doc-review (the
 * document's share).
 *
 * The ontology's tools (Ontology Graph Spec v1 `tools`, stats().ontology.tools): the console tab lists
 * the open store's, grouped by the element each sits on, each with its note (console.js toolCompat:
 * what it can do on an extracted graph), its Cypher, its parameters and Run; the graph tab's side
 * panel lists the tools of a clicked entity's kind (or relationship's type), with Run prefilled
 * with the entity's name in the one parameter that takes a name (console.js prefillPlan; a tool
 * whose parameters all have a value otherwise runs as a tool about the kind, and one with a
 * parameter left empty opens its card and asks for it, without running). A run is refused before
 * any lease when an argument is missing, empty or mistyped (console.js toolArgs, R3), and otherwise
 * runs as any console query does (read-only lease, watchdog), with lib/relate_wasm.mjs's strict
 * parameter check. The console's results leave out the extraction's own records (rows whose
 * top-level column is a _Mention, _Sentence, _OF, ...; such values dropped inside lists and maps;
 * console.js consoleResult) when "Hide the example's bookkeeping" is checked: it starts unchecked, so
 * every row shows, and a check is remembered (ex01.consoleHideBookkeeping = '1'; absent or '0': show);
 * the ontology layer and the entities always show.
 *
 * Engine lifecycle. WASM memory never shrinks, not even after free() or reset() (R13), so
 * after every RECYCLE_EVERY extractions the page waits until the engine worker is idle, closes the
 * store (free(), the only checkpoint, R12), then ends the worker and starts a fresh one: the store
 * reopens from its checkpoint (committed data survives, R24) and the model reloads from Cache
 * Storage, hashed again (models.js). Without the close, the fresh worker would replay the whole WAL
 * into memory and keep what the recycle gave back. A crash (a trap, R14) does the same without the
 * wait or the close. A worker terminated in the middle of a synchronous WASM call keeps its OPFS
 * handles for about 2 s in Chromium (R11), so a reopen after a crash retries `storage locked` for 6 s, and
 * the page says "reopened" only when it was; otherwise the crash banner offers a retry. One
 * sequence at a time replaces the engine: a recycle or a restart owns the workers it ends and
 * starts, handles their deaths itself (onEngineDeath leaves them alone), and never leaves two
 * engine workers alive.
 *
 * URL parameters: ?models=local fetches the weights from ./models/ (harness/serve.mjs, dev only);
 * ?test=1 lays graphs out with d3Force (deterministic, V6); ?watchdog=<ms> changes the console's
 * 10-second watchdog; ?recycle=<n> recycles the engine after n extractions instead of 10.
 */
import { GraphView } from './graphview.js';
import { labelColor } from './tonvl.js';
import * as models from './models.js';
import { capNote, consoleResult, cypherParams, hiddenNote, prefillPlan, storeIndexNames, toolArgs, toolCompat, toolParams } from './console.js';
import { ONTOLOGY_CONSTRAINTS, OntologyError, graphTypeSpec, parseOntology, storeName } from './ontology.js';
import { listStores } from './opfs.js';
import { FLOOR } from './pipeline.js';
import { DEFAULT_GATE, LOOKUP_INDEXES, STORE_CONSTRAINTS, STORE_FULLTEXT } from './store.js';

const PARAMS = new URLSearchParams(location.search);
const TEST = PARAMS.get('test') === '1';
const WATCHDOG_MS = Math.max(500, Number(PARAMS.get('watchdog')) || 10000);
/** Ask before an extraction that needs the model for more sentences than this (section 4). */
const ASK_ABOVE = 40;
/** Uploads above this size are refused. */
const MAX_UPLOAD = 2 * 1024 * 1024;
/** About this long per sentence with relations, small-v1, one thread (G8). */
const MS_PER_SENTENCE = 200;
/** The ontology a first visit opens (its store, D14); the Document box then holds its sample. */
const DEFAULT_ONTOLOGY = 'financial-services';
const CHANNEL = 'ex01-stores';
/** The tabs, in order (index.html); the last one shown is remembered (ex01.tab). */
const TABS = ['graph', 'review', 'ontology', 'cutoffs', 'console', 'store'];
/** Extractions one engine worker runs before the page recycles it (R13): its memory never shrinks. */
const RECYCLE_EVERY = Math.max(1, Math.floor(Number(PARAMS.get('recycle'))) || 10);

// ---- small helpers -------------------------------------------------------------------------------

/** @param {string} sel @returns {any} */
const $ = (sel) => document.querySelector(sel);
/** "9 entities, 1 relationship": a published graph's size, for status lines. @param {{entities: number, relationships: number}} p */
const graphSize = (p) => `${p.entities} ${p.entities === 1 ? 'entity' : 'entities'}, ${p.relationships} ${p.relationships === 1 ? 'relationship' : 'relationships'}`;
/** @param {string} tag @param {Record<string, any>} [attrs] @param {...(Node|string|null|undefined|false)} kids */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}
const f3 = (/** @type {any} */ x) => (typeof x === 'number' ? x.toFixed(3) : String(x));
const mb = (/** @type {number} */ n) => `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
/** localStorage, wrapped: it may be missing or throw (private windows, blocked site data). */
const local = {
  /** @param {string} k */ get(k) { try { return localStorage.getItem(`ex01.${k}`); } catch { return null; } },
  /** @param {string} k @param {string} v */ set(k, v) { try { localStorage.setItem(`ex01.${k}`, v); } catch { /* ignore */ } },
};
/** @param {string} s */
const cps = (s) => Array.from(String(s ?? ''));

/** A sentence with spans [start, end) in code points marked. @param {string} text @param {Array<[number, number]>} spans */
function marked(text, spans) {
  const chars = cps(text);
  const marks = new Array(chars.length).fill(false);
  for (const [a, b] of spans ?? []) {
    if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
    for (let i = Math.max(0, a); i < Math.min(chars.length, b); i++) marks[i] = true;
  }
  const out = h('span', { class: 'sentence' });
  let i = 0;
  while (i < chars.length) {
    let j = i;
    while (j < chars.length && marks[j] === marks[i]) j++;
    const piece = chars.slice(i, j).join('');
    out.append(marks[i] ? h('mark', { text: piece }) : piece);
    i = j;
  }
  return out;
}

function setBody(/** @type {Record<string, string>} */ attrs) {
  Object.assign(document.body.dataset, attrs);
}

function notice(/** @type {string} */ text, kind = '') {
  const n = $('#notice');
  n.className = `banner ${kind}`;
  n.textContent = text;
  n.hidden = !text;
}

/** @param {unknown} e */
function message(e) {
  if (e instanceof EngineFailure) return e.message;
  return e instanceof Error ? e.message : String(e);
}

// ---- the engine worker ---------------------------------------------------------------------------

/** An error the engine worker answered with; `code` says which (see worker.js). */
class EngineFailure extends Error {
  /** @param {{code?: string, message?: string, [k: string]: any}} err */
  constructor(err) {
    super(err?.message ?? 'the engine failed');
    this.name = 'EngineFailure';
    this.code = err?.code ?? 'error';
    this.info = err ?? {};
  }
}

class Engine {
  /**
   * @param {(ev: any) => void} onEvent
   * @param {(reason: string, eng: Engine) => void} onDeath
   */
  constructor(onEvent, onDeath) {
    this.seq = 0;
    /** @type {Map<number, {resolve: (v: any) => void, reject: (e: any) => void, kind: string}>} */
    this.pending = new Map();
    this.onEvent = onEvent;
    this.onDeath = onDeath;
    this.dead = false;
    /** why it died (die's reason), for the sequence that recovers from it */
    this.reason = '';
    /** a recycle or a restart owns this worker: its death is that sequence's to handle, not onEngineDeath's */
    this.owned = false;
    /** the recycle has sent `close`: calls wait for the fresh worker (call() below) */
    this.closing = false;
    /** extractions this worker ran (the recycle counts them, R13) */
    this.extractions = 0;
    this.w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'ex01-engine' });
    this.w.onmessage = (ev) => this.receive(ev.data);
    this.w.onerror = (ev) => {
      ev.preventDefault();
      this.die(`the engine worker stopped: ${ev.message || 'it could not start (module workers?)'}`);
    };
    this.w.onmessageerror = () => this.die('the engine worker sent a message the page could not read');
  }

  /** @param {any} msg */
  receive(msg) {
    if (msg && msg.event) {
      this.onEvent(msg);
      return;
    }
    const p = this.pending.get(msg?.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.data);
    else {
      const err = new EngineFailure(msg.error);
      p.reject(err);
      if (err.code === 'trap') queueMicrotask(() => this.die(err.message));
    }
  }

  /**
   * @param {string} kind
   * @param {Record<string, any>} [args]
   * @param {Transferable[]} [transfer]
   * @returns {Promise<any>}
   */
  call(kind, args = {}, transfer = []) {
    if (this.dead) return Promise.reject(new EngineFailure({ code: 'trap', message: 'the engine is restarting' }));
    if (this.closing) return Promise.reject(new EngineFailure({ code: 'recycled', message: 'the engine was recycled; try again' }));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, kind });
      this.w.postMessage({ ...args, id, kind }, transfer); // the envelope wins over any argument
    });
  }

  /** @param {string} reason */
  die(reason) {
    if (this.dead) return;
    this.dead = true;
    this.reason = reason;
    // An idle worker's lock goes at once; one inside a WASM call holds it about 2 s more (R11).
    // Committed data stays (R24).
    this.w.terminate();
    for (const p of this.pending.values()) p.reject(new EngineFailure({ code: 'trap', message: reason }));
    this.pending.clear();
    this.onDeath(reason, this);
  }

  /** End a worker on purpose (the recycle, R13, or a restart): no crash, no onDeath. */
  retire() {
    if (this.dead) return;
    this.dead = true;
    this.w.terminate();
    for (const p of this.pending.values()) p.reject(new EngineFailure({ code: 'recycled', message: 'the engine was recycled; try again' }));
    this.pending.clear();
  }
}

// ---- state ----------------------------------------------------------------------------------------

const state = {
  /** @type {Engine|null} */ engine: null,
  engineReady: false,
  /** @type {any} the open store, as open-store describes it */ store: null,
  /** @type {any} */ stats: null,
  /** @type {Array<{file: string, group: string, yaml: string, id: string, title: string, format: string, meta: any}>} the bundled v1 documents */ ontologies: [],
  /** @type {Array<{id: string, label: string}>} the picker's groups, in order (data/ontologies/index.json) */ ontologyGroups: [],
  /** @type {Record<string, string>} create-context-graph base ontologies by name ({_base: text}), for a pasted file's `inherits` */ bases: {},
  /** @type {{args: any, name: string, remove: boolean}|null} a store an earlier build wrote (the legacy banner; remove: its ontology
   * is edgextract's YAML, which this build no longer reads, so the banner deletes the store instead of emptying it) */ legacy: null,
  /** @type {Array<any>} */ samples: [],
  /**
   * The Document box's document: a bundled sample (`sample`, with `head`, its YAML front matter, kept out
   * of the text box and extracted with it while the box holds the sample's `body` unchanged), or the
   * user's text (sample null). `titleBy` says where the title came from: 'sample' (the
   * sample's id, while the box holds it), 'auto' (the text's first heading, else `fileName`, the file
   * loaded last, else "pasted" made unique against the store's documents), or 'user' (typed, never
   * overwritten until "Use the sample").
   * @type {{sample: any|null, head: string, body: string, titleBy: 'sample'|'auto'|'user', fileName: string}}
   */
  doc: { sample: null, head: '', body: '', titleBy: 'auto', fileName: '' },
  /** @type {Array<{file: string, text: string, title: string, doc: string, params: Array<{name: string, type: string, example: any, text: string}>}>} */ queries: [],
  model: { which: models.DEFAULT_MODEL, /** @type {any} */ loaded: null, loading: false },
  /** @type {string|null} */ lastDoc: null,
  /** @type {{text: string, title: string}|null} */ lastJob: null,
  /** @type {{job: {text: string, title: string, replaced?: number}, plan: any, same?: any[]}|null} an extraction waiting for its confirmation
   * (more than ASK_ABOVE sentences to ask the model about, or a title the store holds for other text: `same`) */ planned: null,
  /** claims and mentions that wait for a verdict (the Review tab's badge) */
  reviewOpen: 0,
  /** what the graph tab drew last: kept and candidate nodes (the empty state reads it) */
  drawn: { nodes: 0, candidates: 0 },
  extracting: false,
  consoleRunning: false,
  gate: { typeMargin: DEFAULT_GATE.typeMargin, relMargin: DEFAULT_GATE.relMargin, poleMargin: DEFAULT_GATE.poleMargin },
  /** the graph tab draws the review candidates beside the kept graph (ex01.graphCandidates) */
  candidates: true,
  tab: 'graph',
  tabId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  /** @type {{args: any, name: string}|null} */ blocked: null,
  restarts: 0,
  /** a store a restart could not reopen (the crash banner's retry) */
  /** @type {string|null} */ lostStore: null,
  /** @type {any} the bundled ontology whose id the open store's document has, when that document differs from it (applyStore) */ staleBundled: null,
  /** a console lease is out (between lend and reclaim) */
  lease: false,
  /** @type {Promise<void>|null} the recycle in progress (R13) */
  recycling: null,
  recycles: 0,
  /** @type {any[]} the open store's ontology tools (o.tools) */ tools: [],
  /** the ontology the tools section was drawn for (id and sha) */ toolsKey: '',
  /** @type {string[]|null} SHOW PROCEDURES's names, from the console worker's init (the tools' notes) */ procedures: null,
  /** @type {any|null} the tool whose Cypher the console's editor holds (its parameters' types and checks) */ editorTool: null,
  /** queries sent to the console worker (tests: a refused tool run sends none) */ consoleQueries: 0,
  /** the console leaves out the rows and drawn elements of the example's own bookkeeping (ex01.consoleHideBookkeeping '1'; off by default) */
  consoleHideBookkeeping: false,
  /** @type {{columns: string[], rows: any[], ontologyIds: Array<string|number>|null, status: string}|null} the console's last result (and its status line), drawn again when the toggle changes */ consoleResult: null,
  /** the model calls the running extraction needs (plan's needInference) and has made (worker `inference` events) */
  progress: { need: 0, asked: 0, sections: 0, done: 0, title: '' },
};
try {
  const g = JSON.parse(local.get('gate') ?? 'null');
  if (g && typeof g.typeMargin === 'number' && typeof g.relMargin === 'number') {
    state.gate = { typeMargin: g.typeMargin, relMargin: g.relMargin, poleMargin: typeof g.poleMargin === 'number' ? g.poleMargin : DEFAULT_GATE.poleMargin };
  }
} catch { /* defaults */ }
state.candidates = local.get('graphCandidates') !== '0';
state.consoleHideBookkeeping = local.get('consoleHideBookkeeping') === '1';

/** @returns {Engine} */
function engine() {
  if (!state.engine) throw new EngineFailure({ code: 'trap', message: 'the engine is not running' });
  return state.engine;
}

/**
 * One engine call. After the RECYCLE_EVERY-th extraction of a worker, the extraction's answer waits
 * for the recycle (R13) and says so (`recycled: true`), so what the caller does next goes to the
 * fresh worker.
 * @param {string} kind @param {Record<string, any>} [args] @param {Transferable[]} [transfer]
 */
async function call(kind, args = {}, transfer = []) {
  const e = engine();
  // The recycle is closing this worker's store (R12, R13): go to the fresh worker instead.
  if (e.closing && state.recycling) {
    await state.recycling;
    return call(kind, args, transfer);
  }
  const r = await e.call(kind, args, transfer);
  if (kind === 'extract' && r && typeof r === 'object') {
    e.extractions++;
    r.recycled = false;
    if (e.extractions >= RECYCLE_EVERY && e === state.engine && !e.dead && !e.owned) {
      await recycleEngine();
      r.recycled = true;
    }
  }
  return r;
}

let busyCount = 0;
/** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
async function busy(fn) {
  busyCount++;
  setBody({ busy: '1' });
  try {
    return await fn();
  } finally {
    busyCount--;
    if (!busyCount) setBody({ busy: '0' });
  }
}

function refreshStatus() {
  const parts = [];
  parts.push(state.engineReady ? 'Relate 1.2.0' : state.recycling ? 'engine recycling' : 'engine starting');
  parts.push(state.store ? `store ${state.store.name}` : 'no store open');
  parts.push(state.model.loaded ? `model ${state.model.loaded.which} loaded` : state.model.loading ? 'model loading' : 'no model loaded');
  $('#status').textContent = parts.join(' · ');
  updateExtractButton();
  renderEmptyState();
}

// ---- views ---------------------------------------------------------------------------------------

const layout = TEST ? 'd3Force' : 'forceDirected';
const graphView = new GraphView($('#graph-host'), { layout, onSelect: (sel) => showSelection(sel, $('#side'), 'graph') });
const consoleView = new GraphView($('#console-host'), { layout, onSelect: (sel) => showSelection(sel, $('#console-side'), 'console') });
const ontologyView = new GraphView($('#onto-host'), { layout, onSelect: (sel) => showOntologyElement(sel) });

const SIDE_HINT = 'Click a node or a relationship to see what it is and the sentences behind it. Faded ones, captioned "(review)", ' +
  'wait for your verdict: click one to accept or reject it.';
/** Put a side panel back to its hint (nothing selected). @param {HTMLElement} side @param {string} text */
function sideHint(side, text) {
  side.replaceChildren(h('p', { class: 'hint', text }));
}

/** An entity's name for a key the graph tab draws ('Person:DANA_WHITLOCK' -> 'Dana Whitlock'). @param {string} key */
function entityName(key) {
  const d = graphView.nodeData.get(key);
  return String(d?.properties?.name ?? (key.includes(':') ? key.slice(key.indexOf(':') + 1) : key));
}

/** A kind's colour chip, as the legend draws it. @param {string} kind */
function kindChip(kind) {
  const o = state.stats?.ontology;
  const sw = h('span', { class: 'swatch' });
  sw.style.background = labelColor(kind, (o?.kinds ?? []).map((/** @type {any} */ k) => k.id), o?.colors ?? {});
  return h('span', { class: 'chip', 'data-testid': 'side-kind' }, sw, kind);
}

/**
 * A rule and band in plain words, for evidence and review lines (the README's gate table; "band" is
 * the cutoff pair: keep at or above, drop at or below, review between).
 * @param {string|null|undefined} rule @param {string|null|undefined} band
 */
function plainRule(rule, band) {
  switch (rule) {
    case 'band': return band === 'keep' ? 'kept by its score' : band === 'drop' ? 'dropped by its score' : 'between the cutoffs';
    case 'gazetteer': return band === 'keep' ? 'a name the ontology lists' : 'overlaps a listed name';
    case 'verdict': return band === 'drop' ? 'rejected by you' : 'accepted by you';
    case 'claim-verdict': return 'kept with a claim you accepted';
    case 'pole-specific': return band === 'keep' ? 'kept, over its base kind' : band === 'drop' ? 'dropped, under its base kind' : 'between the cutoffs, over its base kind';
    case 'type-margin': return 'a close runner-up kind';
    case 'end-in-review': return 'an end in review';
    case 'hedged': return 'a hedged or negated sentence';
    case 'other-kind': return band === 'drop' ? 'read as another kind here' : 'also kept as another kind';
    case 'ambiguous': return 'another link for the pair';
    case 'reversed': return 'found both ways round';
    case 'illegal': return 'not allowed by the ontology';
    case 'unanchored': return 'an end with no entity';
    case 'self-loop': return 'both ends the same entity';
    case 'no-name': return 'not a name';
    case 'one-kind': return 'another kind took the words';
    case 'floor': return 'kept by the floor';
    default: return rule ? String(rule) : String(band ?? '');
  }
}
/** "financial-services, sentence 2" (idx counts from 0 in the store). @param {any} ev */
const sentenceAt = (ev) => `${ev.document ?? '?'}, sentence ${Number(ev.idx) + 1}`;
const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "a, b and c" @param {string[]} xs */
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

let selSeq = 0;
/** @param {import('./graphview.js').Selection|null} sel @param {HTMLElement} side @param {'graph'|'console'} where */
async function showSelection(sel, side, where) {
  // A newer selection (or a store switch) owns the panel: an answer for an older one is dropped.
  const token = String(++selSeq);
  side.dataset.sel = token;
  const current = () => side.dataset.sel === token;
  side.replaceChildren();
  if (!sel) {
    sideHint(side, where === 'graph' ? SIDE_HINT : 'Click a node or a relationship to see its labels and properties.');
    return;
  }
  if (sel.candidate && where === 'graph') {
    await showCandidate(sel, side);
    if (current()) sideTools(side, sel);
    return;
  }
  const props = sel.properties ?? {};
  // The console's results are any rows: their labels and stored properties, as they are.
  if (where === 'console') {
    const title = sel.kind === 'node' ? `${(sel.labels ?? []).join(':') || 'node'}` : `[:${sel.type}]`;
    side.append(h('h4', { text: title, 'data-testid': 'side-title' }), propsTable(props));
    if (sel.kind !== 'node' || sel.stub || !(sel.labels ?? []).includes('_Entity') || typeof props.key !== 'string' || !state.store) return;
    try {
      const d = await call('details', { node: props.key });
      if (current()) side.append(evidenceList(d));
    } catch (e) {
      side.append(h('p', { class: 'error-text', text: message(e) }));
    }
    return;
  }
  // The graph tab: an entity (its id is its key) or a typed fact, in words, with the sentences behind it.
  /** @type {any} */
  const ask = sel.kind === 'node' ? (sel.stub ? null : { node: sel.id }) : { rel: { a: sel.from, type: sel.type, b: sel.to } };
  side.append(h('h4', { 'data-testid': 'side-title', text: sel.kind === 'node' ? String(props.name ?? sel.id) : `${entityName(sel.from)} → ${entityName(sel.to)}` }));
  if (!ask || !state.store) {
    sideTools(side, sel);
    return;
  }
  try {
    const d = await call('details', ask);
    if (!current()) return;
    side.replaceChildren(...entityAbout(d), evidenceList(d), storedProperties(d.properties));
  } catch (e) {
    if (!current()) return;
    side.append(h('p', { class: 'error-text', text: message(e) }));
  }
  sideTools(side, sel);
}

/**
 * An entity or a typed fact in words (details' answer): its name, its kind (or type) as the legend
 * colours it, how often and where it was found. The store's bookkeeping (key, generation, docs as
 * ids, display when it is the name) stays in "Stored properties".
 * @param {any} d
 */
function entityAbout(d) {
  const p = d.properties ?? {};
  const docs = /** @type {string[]} */ (Array.isArray(p.docs) ? p.docs : []);
  const inDocs = docs.length ? ` in ${docs.length === 1 ? '' : `${docs.length} documents: `}${andList(docs)}` : '';
  if (d.what === 'node') {
    const shown = typeof p.display === 'string' && p.display !== p.name ? h('p', { class: 'hint', text: `Written as "${p.display}" where it was first kept.` }) : null;
    return [
      h('h4', { 'data-testid': 'side-title', text: String(p.name ?? d.title) }),
      h('p', { class: 'kind-line' }, kindChip(String(p.kind ?? '')), ' ', h('span', { class: 'hint', text: `mentioned ${plural(Number(p.mentions ?? d.evidence.length), 'time')}${inDocs}` })),
      ...(shown ? [shown] : []),
    ];
  }
  const claims = Array.isArray(p.claims) ? p.claims.length : d.evidence.length;
  return [
    h('h4', { 'data-testid': 'side-title', text: `${entityName(p.head)} → ${entityName(p.tail)}` }),
    h('p', { class: 'kind-line' }, h('span', { class: 'chip', 'data-testid': 'side-kind', text: String(p.type) }), ' ',
      h('span', { class: 'hint', text: `p ${f3(p.p)}, its best claim's score; from ${plural(claims, 'claim')}${inDocs}` })),
  ];
}

/** The sentences behind an entity or a fact, with the words marked. @param {any} d */
function evidenceList(d) {
  const box = h('div', {});
  box.append(h('p', { class: 'hint', text: `${plural(d.evidence.length, 'sentence')} behind it` }));
  const list = h('ul', { class: 'evidence', 'data-testid': 'evidence' });
  for (const ev of d.evidence) {
    const meta = d.what === 'node'
      ? `${sentenceAt(ev)} · "${ev.text}" · p ${f3(ev.p)} · ${plainRule(ev.rule ?? ev.source, 'keep')}`
      : `${sentenceAt(ev)} · p ${f3(ev.p)} · ${plainRule(ev.rule, ev.band)}`;
    list.append(h('li', { 'data-testid': 'evidence-item' }, marked(ev.sentence, ev.spans), h('div', { class: 'meta', text: meta })));
  }
  box.append(list);
  return box;
}

/** The store's own properties of an entity or fact, collapsed (the key is what Cypher matches on). @param {Record<string, any>} props */
function storedProperties(props) {
  return h('details', { class: 'props', 'data-testid': 'side-properties' }, h('summary', { text: 'Stored properties' }), propsTable(props));
}

/**
 * A review candidate in the graph tab's side panel: its claims (a relationship) or mentions (an
 * entity) in the review band, each with its band, the rule that put it there in a sentence, the
 * evidence sentence, and Accept / Reject, which write a verdict as the Review tab does.
 * @param {import('./graphview.js').Selection} sel @param {HTMLElement} side
 */
async function showCandidate(sel, side) {
  const ask = sel.kind === 'node' ? { candidate: { node: sel.id } } : { candidate: { rel: { a: sel.from, type: sel.type, b: sel.to } } };
  const title = sel.kind === 'node' ? `${sel.properties?.name ?? sel.id}` : `${entityName(sel.from)} → ${entityName(sel.to)}`;
  const kind = sel.kind === 'node' ? kindChip(String((sel.labels ?? []).find((l) => !l.startsWith('_')) ?? '')) : h('span', { class: 'chip', 'data-testid': 'side-kind', text: String(sel.type) });
  const head = () => [h('h4', { text: title, 'data-testid': 'side-title' }), h('p', { class: 'kind-line' }, kind, ' ', h('span', { class: 'band review', text: 'in review' }))];
  side.append(...head());
  if (!state.store) return;
  try {
    const d = await call('details', ask);
    const items = [...d.claims, ...d.mentions];
    side.replaceChildren(...head(),
      h('p', { class: 'hint', text: 'Drawn faded: the gate kept it out of the graph until you decide. Accept publishes it; Reject drops it.' }));
    if (!items.length) side.append(h('p', { class: 'hint', text: 'Nothing of it waits in review any more.' }));
    for (const x of items) side.append(reviewItem(x, { testid: 'candidate-item', after: (value) => candidateDecided(side, x, value, ask) }));
  } catch (e) {
    side.append(h('p', { class: 'error-text', text: message(e) }));
  }
}

/**
 * After a verdict from the side panel: say what it did (the graph is redrawn by then), then list
 * what of the same candidate still waits in review: one fact can rest on several claims (the same
 * sentence in two documents) and one entity on several mentions, and a verdict decides only one.
 * @param {HTMLElement} side @param {any} x @param {string} value @param {any} ask the candidate
 */
async function candidateDecided(side, x, value, ask) {
  const what = x.item === 'claim' ? `"${x.head}" -[${x.rel}]-> "${x.tail}"` : `"${x.text}" as ${x.label}`;
  const one = x.item === 'claim' ? 'this claim' : 'this mention';
  side.replaceChildren(h('p', { class: 'hint', 'data-testid': 'candidate-done', 'data-value': value,
    text: `${value === 'accept' ? 'Accepted' : 'Rejected'} ${what}: ${value === 'accept' ? `${one} is published, drawn as a kept fact` : `${one} is dropped`} (the Review tab lists the verdict).` }));
  if (!ask || !state.store) return;
  try {
    const d = await call('details', ask);
    const rest = [...d.claims, ...d.mentions];
    if (!rest.length) return;
    side.append(h('p', { class: 'hint', 'data-testid': 'candidate-rest', text: `${rest.length} more of it ${rest.length === 1 ? 'waits' : 'wait'} in review:` }));
    for (const y of rest) side.append(reviewItem(y, { testid: 'candidate-item', after: (v) => candidateDecided(side, y, v, ask) }));
  } catch (e) {
    side.append(h('p', { class: 'error-text', text: message(e) }));
  }
}

/** @param {Record<string, any>} props */
function propsTable(props) {
  const t = h('table');
  for (const [k, v] of Object.entries(props ?? {})) {
    t.append(h('tr', {}, h('td', { text: k }), h('td', { text: typeof v === 'number' && !Number.isInteger(v) ? f3(v) : Array.isArray(v) ? v.join(', ') : JSON.stringify(v) })));
  }
  return t;
}

// ---- tabs ----------------------------------------------------------------------------------------

/**
 * Show one tab (and remember it): the tab panel comes into view, NVL views draw what they hold.
 * @param {string} tab @param {{focus?: boolean}} [opts]  focus: move the keyboard focus to its tab button
 */
function showTab(tab, { focus = false } = {}) {
  state.tab = tab;
  local.set('tab', tab);
  for (const b of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[role="tab"]'))) {
    const on = b.getAttribute('data-tab') === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  for (const p of document.querySelectorAll('.tab')) /** @type {HTMLElement} */ (p).hidden = p.id !== `tab-${tab}`;
  $('#work').scrollIntoView({ block: 'nearest' });
  if (tab === 'graph') graphView.show();
  if (tab === 'console') consoleView.show();
  if (tab === 'ontology') ontologyView.show();
  if (tab === 'store') refreshStoreTab();
}
for (const b of document.querySelectorAll('[role="tab"]')) {
  b.addEventListener('click', () => showTab(/** @type {string} */ (b.getAttribute('data-tab'))));
  // The tab list's keys (WAI-ARIA tabs): the arrows move along it, Home and End to its ends.
  b.addEventListener('keydown', (/** @type {KeyboardEvent} */ ev) => {
    const i = TABS.indexOf(/** @type {string} */ (b.getAttribute('data-tab')));
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[ev.key];
    if (to === undefined) return;
    ev.preventDefault();
    showTab(TABS[(to + TABS.length) % TABS.length], { focus: true });
  });
}

// ---- data: ontologies, samples, queries ------------------------------------------------------------

/** @param {string} url */
async function text(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.text();
}

/**
 * The bundled ontologies (data/ontologies/index.json, written by build.mjs): {bases: {name: file},
 * groups: [{id, label, files}]}: Ontology Graph Spec v1 documents (data/ontologies/ogs/ccg/,
 * converted from create-context-graph's 27 domains). The bases (create-context-graph's _base.yaml)
 * are for a create-context-graph file pasted or uploaded into the editor, whose `inherits: _base`
 * names it.
 */
async function loadData() {
  const index = /** @type {{bases: Record<string, string>, groups: Array<{id: string, label: string, files: string[]}>}} */ (
    JSON.parse(await text('data/ontologies/index.json')));
  state.bases = Object.fromEntries(await Promise.all(Object.entries(index.bases ?? {}).map(async ([name, file]) => [name, await text(`data/ontologies/${file}`)])));
  state.ontologyGroups = index.groups.map((g) => ({ id: g.id, label: g.label }));
  state.ontologies = await Promise.all(index.groups.flatMap((g) => g.files.map(async (file) => {
    const yaml = await text(`data/ontologies/${file}`);
    const o = parseOntology(yaml, { bases: state.bases });
    return { file, group: g.id, yaml, id: o.id, title: o.title || o.id, format: o.format, meta: o.meta };
  })));
  state.samples = JSON.parse(await text('data/samples/samples.json'));
  const qfiles = /** @type {string[]} */ (JSON.parse(await text('queries/index.json')));
  state.queries = await Promise.all(qfiles.map(async (file) => parseQuery(file, await text(`queries/${file}`))));
}

/**
 * A saved query's header: the first comment line is its title, the others its description,
 * `// @param name TYPE <json example> description` its parameters.
 * @param {string} file @param {string} src
 */
function parseQuery(file, src) {
  const lines = src.split('\n');
  const head = [];
  for (const l of lines) {
    if (!l.startsWith('//')) break;
    head.push(l.replace(/^\/\/ ?/, ''));
  }
  /** @type {Array<{name: string, type: string, example: any, text: string}>} */
  const params = [];
  const doc = [];
  for (const l of head.slice(1)) {
    const m = /^@param\s+(\w+)\s+(\w+)\s+(.*)$/.exec(l);
    if (!m) { doc.push(l); continue; }
    const [, name, type, rest] = m;
    let example = null;
    let after = rest;
    // The example is one JSON value; the description follows it.
    for (let i = rest.length; i > 0; i--) {
      try {
        example = JSON.parse(rest.slice(0, i));
        after = rest.slice(i).trim();
        break;
      } catch { /* shorter */ }
    }
    params.push({ name, type: type.toUpperCase(), example, text: after });
  }
  return { file, text: src, title: head[0] ?? file, doc: doc.join(' '), params };
}

// ---- stores and ontologies -------------------------------------------------------------------------

/**
 * Open a store in the engine and show it.
 * @param {Record<string, any>} args  {yaml} or {name}
 * @param {{retryLocked?: boolean, quiet?: boolean}} [opts]  retryLocked: the worker retries `storage locked`
 *   for 6 s (a reopen after a crash, R11); quiet: no lock banner or notice on failure (the caller reports it)
 */
async function openStore(args, { retryLocked = false, quiet = false } = {}) {
  return busy(async () => {
    try {
      const r = await call('open-store', { ...args, bases: state.bases, cutoffs: {}, gate: state.gate, model: defaultsModel(), retryLocked });
      await showOpened(r);
      return r;
    } catch (e) {
      if (quiet) throw e;
      if (e instanceof EngineFailure && e.code === 'store' && (e.info.reason === 'legacy' || e.info.reason === 'legacy-ontology')) {
        const name = args.yaml ? safeStoreName(args.yaml) : args.name;
        const remove = e.info.reason === 'legacy-ontology';
        state.legacy = { args, name, remove };
        $('#legacy-text').textContent = remove
          ? `The store ${name} was made by an earlier version of this page for an ontology in edgextract's format, which this page no ` +
            'longer reads or bundles. Delete it to free its space: its documents, verdicts and cutoffs go.'
          : `The store ${name} was made by an earlier version of this page, whose internal labels this one ` +
            'no longer reads. Empty it to use it here: its documents, verdicts and cutoffs go, and the ontology stays.';
        $('#legacy-discard').textContent = remove ? 'Delete this store' : 'Empty it and open it again';
        $('#legacy-banner').dataset.remove = remove ? '1' : '0';
        $('#legacy-banner').hidden = false;
      } else if (e instanceof EngineFailure && e.code === 'locked') {
        const name = e.info.name ?? (args.yaml ? safeStoreName(args.yaml) : args.name);
        state.blocked = { args, name };
        $('#lock-text').textContent = `The store ${name} is open in another tab or window of this site, and a store has one owner at a time.`;
        $('#lock-banner').hidden = false;
      } else if (e instanceof EngineFailure && e.code === 'blocked') {
        notice(`${e.message}. "Rebuild the graph" drops the typed graph, applies the new ontology and publishes again from the stored candidates (no model call).`, 'warn');
        $('#rebuild').hidden = false;
        showTab('ontology');
      } else {
        notice(message(e), 'error');
      }
      throw e;
    }
  });
}

/** The store the views were last drawn for (a switch clears them; a reopen of the same one does not). */
let shownStore = '';

/** What every successful open-store ends with. @param {any} r  open-store's answer */
async function showOpened(r) {
  // A status line from the last store's cutoffs must not describe this one.
  $('#cutoffs-status').textContent = '';
  delete $('#cutoffs-status').dataset.belowFloor;
  $('#lock-banner').hidden = true;
  $('#legacy-banner').hidden = true;
  state.legacy = null;
  state.blocked = null;
  state.lostStore = null;
  $('#rebuild').hidden = true;
  const switched = r.name !== shownStore;
  shownStore = r.name;
  if (switched) storeSwitched();
  applyStore(r);
  local.set('store', r.name);
  const why = r.regatedBecause === 'cutoffs'
    ? `This store's default cutoffs moved to the defaults for ${modelLabel(r.stats.defaultsModel)} (the cutoffs you moved stay)`
    : 'The changed ontology was applied';
  notice(r.regated ? `${why}; the gate and the publish ran again: claims keep ${r.regated.gate.claims.keep}, ` +
    `review ${r.regated.gate.claims.review}, drop ${r.regated.gate.claims.drop}; typed graph ${graphSize(r.regated.published)}.` : '');
  await Promise.all([refreshGraph({ fit: switched }), refreshReview(), refreshStoreList()]);
  // The Document box follows the store's domain unless it holds the user's own text.
  await followDomain().catch(() => {});
}

/**
 * Another store is open now: nothing on the page may still describe the last one. The side panels go
 * back to their hints, the summary line, step 3's last result and the kept list go (with Continue,
 * whose document was the last store's), and the console's result is dropped.
 */
function storeSwitched() {
  if (!state.extracting) {
    const es = $('#extract-status');
    es.textContent = '';
    es.className = 'step-status';
    for (const k of ['sectionsDone', 'sections', 'inferences', 'hits', 'skipped']) delete es.dataset[k];
    $('#continue').hidden = true;
    state.lastJob = null;
    // A question asked about the last store's documents (a title it holds, a long extraction) is not this one's.
    $('#dup').hidden = true;
    $('#confirm').hidden = true;
    state.planned = null;
    if (['duplicate', 'confirm'].includes(document.body.dataset.extract ?? '')) setBody({ extract: 'idle' });
  }
  graphView.deselect();
  showSelection(null, $('#side'), 'graph');
  sideHint($('#onto-side'), ONTO_HINT);
  hideSummary();
  // "This document" was the last store's: draw all of this one's.
  /** @type {HTMLInputElement} */ ($('input[name="scope"][value="all"]')).checked = true;
  $('#scope-doc-label').title = 'The document extracted last (none yet in this visit: all are shown)';
  renderKept(null);
  state.lastDoc = null;
  state.consoleResult = null;
  renderTable([], []);
  consoleView.clear();
  $('#console-graph-area').hidden = true;
  sideHint($('#console-side'), 'Click a node or a relationship to see its labels and properties.');
  $('#console-hidden').textContent = '';
  const cs = $('#console-status');
  for (const k of ['code', 'rows', 'category', 'capped']) delete cs.dataset[k];
  cs.className = 'hint';
  cs.textContent = '';
}

/** The default ontology's bundled document (a first visit opens its store). */
function defaultOntologyYaml() {
  return (state.ontologies.find((o) => o.id === DEFAULT_ONTOLOGY) ?? state.ontologies[0]).yaml;
}

/** @param {string} yaml */
function safeStoreName(yaml) {
  try { return storeName(parseOntology(yaml, { bases: state.bases })); } catch { return '(unknown)'; }
}

/** @param {any} r  open-store's (or rebuild's, reset's) answer */
function applyStore(r) {
  state.store = r;
  state.stats = r.stats;
  setBody({ store: r.name });
  const o = r.stats.ontology;
  const bundled = state.ontologies.find((x) => x.id === o.id);
  $('#domain-select').value = bundled && bundled.yaml === o.yaml ? bundled.file : '';
  if (!$('#domain-select').value) ensureCustomOption(o.id);
  // A store whose document has a bundled ontology's id but differs from it (an earlier build's conversion,
  // such as one with the icon and size in neo4j:display, or an edit): say so, and offer the bundled one,
  // re-applied as the picker applies it (one re-gate; verdicts and the cutoffs you moved stay).
  state.staleBundled = bundled && bundled.yaml !== o.yaml ? bundled : null;
  $('#ontology-stale').hidden = !state.staleBundled;
  $('#ontology-stale-text').textContent = state.staleBundled
    ? `This store keeps a version of ${state.staleBundled.title} that differs from the bundled one (an earlier build's conversion, or an edit).` : '';
  renderOntologyAbout(o);
  renderOntologyGraph(o);
  renderTools(o);
  setYaml(o.yaml);
  const typed = r.applied ? `${r.applied.typed.length} typed links enforced by the graph type, ${r.applied.untyped.length} checked by the gate only` : '';
  $('#store-info').textContent = `${r.name}: ontology ${o.title} (${o.kinds.length} kinds, ${o.links.length} links${typed ? `; ${typed}` : ''}).` +
    (r.canary.procedures.length ? ` db.ontology.* exists now (${r.canary.procedures.join(', ')}): the ontology document could move into them (D15, NOTES.md R17).` : '');
  renderCutoffs();
  renderStoreFacts();
  renderDomainStatus();
  refreshStatus();
}

/** Step 1's line: the open store, and what it holds so far. */
function renderDomainStatus() {
  const s = state.stats;
  const el = $('#domain-status');
  if (!s) { el.textContent = ''; return; }
  el.textContent = `Store opfs://${s.name}: ${s.documents.length ? `${plural(s.documents.length, 'document')}, ${plural(s.entities, 'entity', 'entities')}, ${plural(s.facts, 'relationship')}` : 'nothing extracted yet'}.`;
  $('#step-domain').classList.toggle('done', true);
}

/** A source format's name in a sentence ('edgextract': a document an earlier build converted). @param {string|null|undefined} f */
const formatName = (f) => (f === 'create-context-graph' ? "create-context-graph's format" : f === 'edgextract' ? "edgextract's format, by an earlier build" : 'Ontology Graph Spec v1');

/**
 * The line under the picker: the domain's description and tagline (create-context-graph), or the
 * ontology's title (any other document), and where the document comes from.
 * @param {any} o  stats.ontology
 */
function renderOntologyAbout(o) {
  const bundled = state.ontologies.find((x) => x.id === o.id && x.yaml === o.yaml);
  const original = bundled ? bundled.file.replace(/^ogs\/ccg\//, '').replace(/\.ontology\.yaml$/, '.yaml') : '';
  const source = bundled
    ? `create-context-graph's ${original}, as an Ontology Graph Spec v1 document`
    : `this store's own Ontology Graph Spec v1 document${o.convertedFrom ? `, converted from ${formatName(o.convertedFrom)}` : ''}`;
  const what = o.meta ? `${o.meta.emoji ? `${o.meta.emoji} ` : ''}${o.meta.name}: ${o.meta.description}${o.meta.tagline ? ` (${o.meta.tagline})` : ''}` : o.title;
  $('#ontology-about').textContent = `${what}. From ${source}: ${plural(o.kinds.length, 'kind')} and ${plural(o.links.length, 'link')}, ` +
    `${plural((o.tools ?? []).length, 'tool')}.`;
  // Step 1 says the same in one line: the domain's description (its tagline is in the Ontology tab).
  $('#domain-about').textContent = o.meta ? `${o.meta.description}.` : `${o.title}: this store's own ontology document.`;
}

const ONTO_HINT = 'The ontology as a picture: each kind a node, coloured as in the graph tab, and each link a relationship between ' +
  'the kinds it may join. Click one to see what the model is asked and its cutoffs.';

/**
 * The Ontology tab's picture: the open store's kinds as nodes (coloured as the graph tab colours
 * them) and its links as relationships between the kinds each may join (a symmetric link once), in
 * NVL, fitted when the ontology changes.
 * @param {any} o  stats.ontology
 */
function renderOntologyGraph(o) {
  const kinds = (o.kinds ?? []).map((/** @type {any} */ k) => k.id);
  const nodes = kinds.map((/** @type {string} */ id) => ({ id, labels: [id], properties: { name: id } }));
  /** @type {any[]} */
  const rels = [];
  for (const l of o.links ?? []) {
    const seen = new Set();
    for (const pair of l.pairs ?? []) {
      const [a, b] = String(pair).split('|');
      if (l.symmetric && seen.has(`${b}|${a}`)) continue;
      seen.add(`${a}|${b}`);
      rels.push({ id: `${l.id}|${a}|${b}`, type: l.id, start_node: a, end_node: b, properties: { link: l.id } });
    }
  }
  const key = `${o.id}\u0000${o.sha}`;
  const changed = ontologyView.host.dataset.key !== key;
  ontologyView.host.dataset.key = key;
  ontologyView.host.dataset.kinds = String(nodes.length);
  ontologyView.host.dataset.pairs = String(rels.length);
  ontologyView.set({ nodes, rels }, { labelOrder: kinds, colors: o.colors ?? {} }, { fit: changed });
  if (changed) sideHint($('#onto-side'), ONTO_HINT);
  const legend = $('#onto-legend');
  legend.replaceChildren(h('span', { text: `${plural(nodes.length, 'kind')}, ${plural(o.links?.length ?? 0, 'link')} (${plural(rels.length, 'kind pair')} they may join)` }));
}

/** A kind or a link of the Ontology tab's picture, in its side panel. @param {import('./graphview.js').Selection|null} sel */
function showOntologyElement(sel) {
  const side = $('#onto-side');
  const o = state.stats?.ontology;
  if (!sel || !o) { sideHint(side, ONTO_HINT); return; }
  const cut = (/** @type {any} */ x) => `keeps at p ≥ ${f2(x.keep)}, drops at p ≤ ${f2(x.drop)} (${x.src === 'user' ? 'set by you' : 'the defaults'})`;
  if (sel.kind === 'node') {
    const k = o.kinds.find((/** @type {any} */ x) => x.id === sel.id);
    if (!k) { sideHint(side, ONTO_HINT); return; }
    const out = o.links.filter((/** @type {any} */ l) => (l.pairs ?? []).some((/** @type {string} */ p) => p.startsWith(`${k.id}|`))).map((/** @type {any} */ l) => l.id);
    const inn = o.links.filter((/** @type {any} */ l) => (l.pairs ?? []).some((/** @type {string} */ p) => p.endsWith(`|${k.id}`))).map((/** @type {any} */ l) => l.id);
    const tools = (o.tools ?? []).filter((/** @type {any} */ t) => t.anchor?.kind === 'node' && t.anchor.label === k.id).length;
    const asked = k.ask === null ? 'Not asked of the model: a domain kind covers its pole.' : k.ask ? `Asked of the model as "${k.ask.label}"${k.ask.description ? `: ${k.ask.description}` : ''}.` : '';
    side.replaceChildren(
      h('h4', { 'data-testid': 'side-title', text: k.id }),
      h('p', { class: 'kind-line' }, kindChip(k.id), ' ', h('span', { class: 'hint', text: k.origin === 'base' ? 'a base kind (create-context-graph\'s POLE+O)' : `a kind of this domain${k.pole ? ` (pole ${k.pole})` : ''}` })),
      ...(k.description ? [h('p', { class: 'about', text: k.description })] : []),
      ...(asked ? [h('p', { class: 'hint', text: asked })] : []),
      h('p', { class: 'hint', text: `Its cutoffs: ${cut(k)}.` }),
      h('p', { class: 'hint', text: `Links from it: ${out.length ? andList(out) : 'none'}; to it: ${inn.length ? andList(inn) : 'none'}. ${plural(tools, 'tool')} in the Console tab.` }));
    return;
  }
  const l = o.links.find((/** @type {any} */ x) => x.id === sel.type);
  if (!l) { sideHint(side, ONTO_HINT); return; }
  const pairs = (l.pairs ?? []).map((/** @type {string} */ p) => p.replace('|', ' → '));
  side.replaceChildren(
    h('h4', { 'data-testid': 'side-title', text: l.id }),
    h('p', { class: 'kind-line' }, h('span', { class: 'chip', text: l.typed ? 'typed: the graph type enforces it' : 'checked by the gate' }), ...(l.symmetric ? [' ', h('span', { class: 'chip', text: 'symmetric' })] : [])),
    h('p', { class: 'hint', text: `Asked of the model as "${l.ask ?? l.phrase}".` }),
    h('p', { class: 'hint', text: `It may join ${andList(pairs)}.` }),
    h('p', { class: 'hint', text: `Its cutoffs: ${cut(l)}.` }));
}

/** @param {string} id */
function ensureCustomOption(id) {
  const sel = $('#domain-select');
  let opt = sel.querySelector('option[value=""]');
  if (!opt) {
    opt = h('option', { value: '' });
    sel.prepend(opt);
  }
  opt.textContent = `${id} (this store's own document)`;
  sel.value = '';
}

async function refreshStoreList() {
  let stores = [];
  try { stores = await listStores(); } catch { /* OPFS unreadable */ }
  const sel = $('#store-select');
  sel.replaceChildren();
  const names = new Set(stores.map((s) => s.name));
  if (state.store && !names.has(state.store.name)) stores.unshift({ name: state.store.name, bytes: 0, empty: false });
  for (const s of stores) {
    sel.append(h('option', { value: s.name, disabled: s.empty && s.name !== state.store?.name, text: `${s.name}${s.empty ? ' (empty)' : ''}` }));
  }
  if (state.store) sel.value = state.store.name;
  const list = $('#store-list');
  list.replaceChildren(...stores.map((s) => h('li', { 'data-testid': 'store-entry', 'data-name': s.name },
    `${s.name} · ${mb(s.bytes)}${s.empty ? ' · empty' : ''}${s.name === state.store?.name ? ' · open here' : ''}`)));
  return stores;
}

/** @param {string} yaml */
function setYaml(yaml) {
  const ta = $('#yaml');
  if (ta.dataset.dirty === '1' && ta.value !== yaml) return; // keep an unsaved edit
  ta.value = yaml;
  ta.dataset.dirty = '0';
  validateYaml();
}

/**
 * The editor's controls the page adds next to index.html's textarea: a file input (an ontology from
 * disk: a v1 document in YAML or JSON, or a create-context-graph file, converted on load) and "Show
 * as v1" (the editor's create-context-graph text replaced by its v1 document).
 */
function ontologyEditorControls() {
  const row = $('#apply-ontology').parentElement;
  const file = h('input', { type: 'file', id: 'ontology-file', accept: '.yaml,.yml,.json', 'data-testid': 'ontology-file', hidden: true });
  const pick = h('button', { type: 'button', id: 'ontology-load', 'data-testid': 'ontology-load', text: 'Load a file…', onclick: () => file.click() });
  const toV1 = h('button', { type: 'button', id: 'ontology-to-v1', 'data-testid': 'ontology-to-v1', text: 'Show as v1', hidden: true, onclick: () => {
    try {
      const o = parseOntology($('#yaml').value, { bases: state.bases });
      $('#yaml').value = o.yaml;
      $('#yaml').dataset.dirty = '1';
      validateYaml();
    } catch { /* validateYaml shows why */ }
  } });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    if (f.size > MAX_UPLOAD) {
      notice(`${f.name} is over 2 MB.`, 'error');
      return;
    }
    const text = await f.text();
    const ta = $('#yaml');
    // Converted on load: the editor holds what Apply stores, the v1 document, in YAML.
    let loaded = text;
    let from = null;
    try {
      const o = parseOntology(text, { bases: state.bases });
      loaded = o.yaml;
      from = o.convertedFrom;
    } catch { /* shown as is, with its errors */ }
    ta.value = loaded;
    ta.dataset.dirty = '1';
    showTab('ontology');
    validateYaml(from ? `Loaded ${f.name}, converted from ${formatName(from)}.` : `Loaded ${f.name}.`);
  });
  row.append(pick, file, toV1);
}

/** @param {string} [lead]  a sentence to put first (what was just loaded) */
function validateYaml(lead = '') {
  const ta = $('#yaml');
  const out = $('#yaml-status');
  const toV1 = document.getElementById('ontology-to-v1');
  out.style.whiteSpace = 'pre-line';
  try {
    const o = parseOntology(ta.value, { bases: state.bases });
    const gt = graphTypeSpec(o);
    const same = state.store && state.stats?.ontology.id === o.id;
    out.className = 'hint ok-text';
    const legalPairs = o.relations.reduce((n, r) => n + r.pairs.length, 0);
    const what = o.convertedFrom
      ? `A valid ${o.convertedFrom} file, converted to Ontology Graph Spec v1: the v1 document is what is stored ("Show as v1" puts it here)`
      : 'A valid Ontology Graph Spec v1 document';
    out.textContent = `${lead ? `${lead} ` : ''}${what}: ${o.types.length} kinds, ${o.relations.length} links ` +
      `(${legalPairs} legal kind pairs), ${o.names.length} listed names, ${o.tools.length} tools; ${gt.typed.length} typed links. ` +
      `${same ? `Applies to ${storeName(o)}.` : `Opens its own store, ${storeName(o)}.`}`;
    out.dataset.valid = '1';
    out.dataset.format = o.convertedFrom ?? 'ontology-graph-spec';
    if (toV1) toV1.hidden = !o.convertedFrom;
    $('#apply-ontology').disabled = false;
  } catch (e) {
    out.className = 'hint error-text';
    // A v1 document's problems, one per line, each with its place in the document.
    const errors = e instanceof OntologyError ? e.errors ?? [] : [];
    out.textContent = (lead ? `${lead}\n` : '') + (errors.length
      ? [`Not a valid Ontology Graph Spec v1 document (${errors.length} problem${errors.length === 1 ? '' : 's'}):`,
        ...errors.slice(0, 12).map((x) => `${x.path || '(the document)'}: ${x.message}`), ...(errors.length > 12 ? [`… and ${errors.length - 12} more`] : [])].join('\n')
      : e instanceof OntologyError ? e.message : `Invalid: ${message(e)}`);
    out.dataset.valid = '0';
    out.dataset.format = '';
    if (toV1) toV1.hidden = true;
    $('#apply-ontology').disabled = true;
  }
}

let yamlTimer = 0;
$('#yaml').addEventListener('input', () => {
  $('#yaml').dataset.dirty = '1';
  clearTimeout(yamlTimer);
  yamlTimer = window.setTimeout(() => validateYaml(), 150);
});
ontologyEditorControls();
$('#apply-ontology').addEventListener('click', async () => {
  const yaml = $('#yaml').value;
  $('#yaml').dataset.dirty = '0';
  await openStore({ yaml }).catch(() => {});
});
$('#rebuild').addEventListener('click', () => busy(async () => {
  try {
    const r = await call('rebuild', { yaml: $('#yaml').value, bases: state.bases, gate: state.gate });
    $('#rebuild').hidden = true;
    applyStore(r);
    notice('Rebuilt: the typed graph was dropped, the ontology applied and the graph published again from the stored candidates.');
    await Promise.all([refreshGraph(), refreshReview()]);
  } catch (e) {
    notice(message(e), 'error');
  }
}));
$('#ontology-reapply').addEventListener('click', async () => {
  const b = state.staleBundled;
  if (!b) return;
  $('#ontology-reapply').disabled = true;
  try {
    $('#yaml').dataset.dirty = '0';
    await openStore({ yaml: b.yaml }).catch(() => {});
  } finally {
    $('#ontology-reapply').disabled = false;
  }
});
// Step 1: a domain is an ontology, its store and its sample. The sample goes into the Document box
// even when it held the user's text: picking a domain asks for its sample.
$('#domain-select').addEventListener('change', async () => {
  const file = $('#domain-select').value;
  const o = state.ontologies.find((x) => x.file === file);
  if (!o) return;
  $('#yaml').dataset.dirty = '0';
  const opened = await openStore({ yaml: o.yaml }).then(() => true, () => false);
  const sample = state.samples.find((x) => x.ontology === o.id);
  if (opened && sample) await useSample(sample);
});
$('#legacy-discard').addEventListener('click', async () => {
  const l = state.legacy;
  if (!l) return;
  $('#legacy-discard').disabled = true;
  try {
    if (!l.remove) {
      await openStore({ ...l.args, discardLegacy: true }).catch(() => {});
      return;
    }
    // A store whose ontology this build cannot read: delete it (worker delete-store), then open the default store.
    try {
      const r = await busy(() => call('delete-store', { name: l.name }));
      $('#legacy-banner').hidden = true;
      state.legacy = null;
      if (local.get('store') === l.name) local.set('store', '');
      await refreshStoreList();
      await openStore({ yaml: defaultOntologyYaml() }).catch(() => {});
      notice(r.deleted ? `Deleted ${r.deleted}.` : `${l.name} was already gone.`);
    } catch (e) {
      notice(message(e), 'error');
    }
  } finally {
    $('#legacy-discard').disabled = false;
  }
});
$('#store-select').addEventListener('change', async () => {
  const name = $('#store-select').value;
  if (name && name !== state.store?.name) await openStore({ name }).catch(() => {});
});

// ---- the handover between tabs (section 4: storage locked -> BroadcastChannel) -----------------------

const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
/** @type {Map<string, () => void>} */
const handoverWaiters = new Map();
if (channel) {
  channel.onmessage = async ({ data }) => {
    if (!data || data.from === state.tabId) return;
    if (data.type === 'release' && state.store && state.store.name === data.store) {
      const name = state.store.name;
      try {
        await call('stop');
        await call('close');
      } catch { /* the store is released when the worker ends anyway */ }
      state.store = null;
      setBody({ store: '' });
      refreshStatus();
      showMoved(name);
      channel.postMessage({ type: 'released', store: name, to: data.from, from: state.tabId });
    } else if (data.type === 'released' && data.to === state.tabId) {
      handoverWaiters.get(data.store)?.();
    }
  };
}

/** @param {string} name */
function showMoved(name) {
  $('#lock-text').textContent = `${name} moved to another tab of this site.`;
  state.blocked = { args: { name }, name };
  $('#handover').textContent = 'Take it back';
  $('#lock-banner').hidden = false;
}

$('#handover').addEventListener('click', async () => {
  const b = state.blocked;
  if (!b) return;
  $('#handover').disabled = true;
  try {
    const released = new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 15000);
      handoverWaiters.set(b.name, () => { clearTimeout(t); resolve(true); });
    });
    channel?.postMessage({ type: 'release', store: b.name, from: state.tabId });
    const ok = await released;
    handoverWaiters.delete(b.name);
    if (!ok) notice(`No tab answered for ${b.name}; if it is open in another window, close it there.`, 'warn');
    await openStore(b.args).catch(() => {});
  } finally {
    $('#handover').disabled = false;
    $('#handover').textContent = 'Move it to this tab';
  }
});

// ---- the model ---------------------------------------------------------------------------------------

async function renderModelChoices() {
  const box = $('#model-choices');
  box.replaceChildren(h('legend', { class: 'sr-only', text: 'GLiNER2.5 checkpoint' }));
  if (!models.pinned()) {
    box.append(h('p', { class: 'error-text', text: 'This copy of the page has no model pins (serve it through build.mjs or harness/serve.mjs).' }));
    $('#load-model').disabled = true;
    return;
  }
  for (const [key, m] of Object.entries(models.MODELS)) {
    let cached = '';
    try { cached = (await models.cacheStatus(key)).all ? ' · cached in this browser' : ''; } catch { /* no Cache Storage */ }
    const input = h('input', { type: 'radio', name: 'model', value: key, 'data-testid': `model-${key}`, checked: key === state.model.which });
    input.addEventListener('change', () => { state.model.which = key; local.set('model', key); renderModelButton(); });
    box.append(h('label', {}, input, h('span', {}, `${m.label} `, h('span', { class: 'size', text: `${mb(m.bytes)}${cached}` }))));
  }
  if (!$('#model-note').textContent) {
    $('#model-note').textContent = `From the Hugging Face Hub at a pinned revision, checked against its sha256, then cached in this browser.${PARAMS.get('models') === 'local' ? ' (?models=local: from this server)' : ''}`;
  }
  renderModelButton();
}

/** "small v1" for "GLiNER2.5 small v1". @param {string} which */
const shortModel = (which) => modelLabel(which).replace(/^GLiNER2\.5 /, '');

/** Step 2's button and badge: what Load would do now (nothing, when the chosen model is the loaded one). */
function renderModelButton() {
  const b = $('#load-model');
  const loaded = state.model.loaded?.which ?? null;
  if (!models.pinned()) return;
  if (state.model.loading) {
    b.disabled = true;
    b.textContent = 'Loading…';
  } else if (loaded && loaded === state.model.which) {
    b.disabled = true;
    b.textContent = `${shortModel(loaded)} loaded`;
    b.classList.remove('primary');
  } else {
    b.disabled = false;
    b.textContent = loaded ? `Load ${shortModel(state.model.which)} instead` : `Load ${shortModel(state.model.which)}`;
    b.classList.add('primary');
  }
  $('#step-model').classList.toggle('done', Boolean(loaded));
  updateExtractButton();
  renderEmptyState();
}

/** @param {string} which */
const modelLabel = (which) => models.MODELS[which]?.label ?? which;
/** The model whose default cutoffs a store opened now follows: the loaded one, else the one chosen. */
const defaultsModel = () => state.model.loaded?.which ?? state.model.which;

/**
 * Fetch (or read from the cache, hashed again) and load a model into the engine worker. When the
 * fetch fails while another model is loaded, that one stays loaded and in use (the worker frees the
 * old model only once the new files have arrived): data-model stays `ready`, with a note.
 * @param {string} which @param {{auto?: boolean}} [opts]
 */
async function loadModel(which, { auto = false } = {}) {
  if (state.model.loading) return;
  state.model.loading = true;
  const previous = state.model.loaded;
  setBody({ model: 'loading' });
  refreshStatus();
  const bar = $('#model-progress');
  const out = $('#model-status');
  bar.hidden = false;
  bar.value = 0;
  renderModelButton();
  out.className = 'step-status';
  out.textContent = `Fetching ${modelLabel(which)}…`;
  delete out.dataset.repaired;
  let last = 0;
  /** 'fetch' until the bytes are in hand; 'load' once the worker has them (and has let the old model go) */
  let stage = 'fetch';
  try {
    const t0 = performance.now();
    const got = await models.fetchModel(which, {
      onProgress: (p) => {
        const now = performance.now();
        if (now - last < 100 && p.loaded < p.total) return;
        last = now;
        bar.value = p.total ? p.loaded / p.total : 0;
        out.textContent = p.stage === 'checking' ? `Checking the sha256 of ${p.file}… (${mb(p.loaded)} of ${mb(p.total)})`
          : p.stage === 'checking-cache' ? `Checking the cached ${p.file}… (${mb(p.loaded)} of ${mb(p.total)})`
            : p.stage === 'cached' ? `Read ${p.file} from this browser's cache (${mb(p.loaded)} of ${mb(p.total)})`
              : `Downloading ${p.file}: ${mb(p.loaded)} of ${mb(p.total)}`;
      },
    });
    out.textContent = 'Starting the model in gliner-rs…';
    stage = 'load';
    const files = got.files;
    const r = await call('load-model', { which, info: got.info, files, gate: state.gate }, Object.values(files));
    state.model.loaded = { which, ...r, from: got.from, hashMs: got.hashMs };
    if (r.defaults) {
      // The open store's default cutoffs follow this model now (the ones you moved stay).
      if (r.regated) {
        $('#cutoffs-status').textContent = `${modelLabel(which)}'s default cutoffs apply to the cutoffs you have not moved; re-gated: claims keep ${r.regated.gate.claims.keep}, ` +
          `review ${r.regated.gate.claims.review}, drop ${r.regated.gate.claims.drop}; typed graph ${graphSize(r.regated.published)}.`;
        await refreshAll();
      } else {
        $('#cutoffs-status').textContent = `${modelLabel(which)}'s defaults (entities keep ≥ ${r.defaults.entKeep.toFixed(2)}, ` +
          `relationships keep ≥ ${r.defaults.relKeep.toFixed(2)}) apply to the cutoffs you have not moved; nothing needed re-gating.`;
        await refreshStats();
      }
    }
    local.set('model', which);
    setBody({ model: 'ready' });
    const from = got.from === 'cache' ? 'from this browser\'s cache, its sha256 checked again' : got.from === 'mixed' ? 'partly from the cache, partly downloaded; all checked' : 'downloaded and checked';
    const repaired = got.repaired.length
      ? ` The cached ${got.repaired.join(', ')} did not match the pinned sha256, so ${got.repaired.length === 1 ? 'it was' : 'they were'} deleted and downloaded again.`
      : '';
    out.textContent = `${modelLabel(which)} is ready (${from}).${repaired}`;
    out.title = `${((performance.now() - t0) / 1000).toFixed(1)} s${got.from !== 'network' ? `, ${(got.hashMs / 1000).toFixed(1)} s of it hashing the cached files` : ''}; ` +
      `${r.memoryMiB} MiB of WASM memory`;
    $('#model-note').textContent = (got.cacheWarning ? `Note: ${got.cacheWarning}. ` : '') +
      (got.persisted ? '' : 'The browser did not grant persistent storage, so it may evict the cached model.');
    out.className = got.cacheWarning || repaired ? 'step-status error-text' : 'step-status';
    if (got.repaired.length) out.dataset.repaired = got.repaired.join(',');
    renderModelChoices();
  } catch (e) {
    out.className = 'step-status error-text';
    if (stage === 'fetch' && previous && state.engine && !state.engine.dead) {
      // Nothing reached the worker: the previous model is still loaded there and stays in use.
      state.model.loaded = previous;
      setBody({ model: 'ready' });
      out.textContent = `Could not load ${modelLabel(which)}: ${message(e).replace(/[.\s]*$/, '.')} Still using ${modelLabel(previous.which)}.`;
    } else {
      state.model.loaded = null;
      setBody({ model: 'failed' });
      out.textContent = `${auto ? 'Could not load the cached model: ' : ''}${message(e)}`;
    }
  } finally {
    state.model.loading = false;
    bar.hidden = true;
    renderModelButton();
    refreshStatus();
  }
}
$('#load-model').addEventListener('click', () => loadModel(state.model.which));

// ---- documents and extraction ------------------------------------------------------------------------

/** A sample's YAML front matter (with the blank lines after it), and the rest. @param {string} t */
function splitFrontMatter(t) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n(?:[ \t]*\r?\n)*/.exec(t);
  return m ? { head: m[0], body: t.slice(m[0].length) } : { head: '', body: t };
}

/** The Document box holds a bundled sample's text, unchanged (its front matter is then extracted with it). */
const docIsSample = () => Boolean(state.doc.sample) && $('#text').value === state.doc.body;

/** Put a bundled sample in the Document box (titled by its id, as the harness titles samples; a typed title goes too). @param {any} s */
async function useSample(s) {
  const t = await text(`data/samples/${s.file}`);
  const { head, body } = splitFrontMatter(t);
  state.doc = { sample: s, head, body, titleBy: 'sample', fileName: '' };
  $('#text').value = body;
  $('#title').value = s.id;
  renderDoc();
}

/** A Markdown text's first heading (ATX, `#` to `######`, its closing #s dropped), or ''. @param {string} t */
function firstHeading(t) {
  const m = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/m.exec(t);
  const heading = (m?.[1] ?? '').replace(/[*_`]/g, '').trim();
  return heading.length > 80 ? `${heading.slice(0, 79)}…` : heading;
}

/**
 * The title the Document box's text gets when nobody typed one: its first heading, else
 * the name of the file it was loaded from, else "pasted" made unique against the store's document
 * titles ("pasted-2", ...). Worked out when the text changes, so an extraction that adds "pasted" to
 * the store does not rename the text it came from.
 */
function autoTitle() {
  const heading = firstHeading($('#text').value);
  if (heading) return heading;
  if (state.doc.fileName) return state.doc.fileName;
  const titles = new Set((state.stats?.documents ?? []).map((/** @type {any} */ d) => d.title));
  let name = 'pasted';
  for (let i = 2; titles.has(name); i++) name = `pasted-${i}`;
  return name;
}

/** The text changed: the title follows it unless the user typed one (the sample's id while it is the sample). */
function textEdited() {
  if (state.doc.titleBy !== 'user') {
    const sample = docIsSample();
    state.doc.titleBy = sample ? 'sample' : 'auto';
    $('#title').value = sample ? state.doc.sample.id : autoTitle();
  }
  renderDoc();
}

/** The user typed in the title: theirs from now on (an emptied title follows the text again). */
function titleTyped() {
  state.doc.titleBy = $('#title').value.trim() ? 'user' : docIsSample() ? 'sample' : 'auto';
  renderDoc();
}

/**
 * The Document box follows the open store's domain while it holds a sample or nothing: the store's
 * sample goes in. The user's own text stays.
 */
async function followDomain() {
  if (!state.stats) return;
  const oid = state.stats.ontology.id;
  const own = !docIsSample() && $('#text').value.trim() !== '';
  if (own || (docIsSample() && state.doc.sample.ontology === oid)) return;
  const s = state.samples.find((x) => x.ontology === oid);
  if (s) await useSample(s);
}

/** The document to extract: the text box (after the sample's front matter, while it is the sample) and its title (an empty one: autoTitle's). */
function currentDoc() {
  const body = $('#text').value;
  const sample = docIsSample();
  const t = sample ? `${state.doc.head}${body}` : body;
  const title = $('#title').value.trim() || (sample ? state.doc.sample.id : autoTitle());
  return { text: t, title };
}

/** The Document disclosure's summary and note, and step 3's button. */
function renderDoc() {
  const s = state.doc.sample;
  const sample = docIsSample();
  const { title } = currentDoc();
  $('#title').placeholder = $('#text').value.trim() ? title : 'untitled';
  $('#doc-name').textContent = sample ? `the ${s.label} sample` : $('#text').value.trim() ? `“${title}”` : 'empty';
  $('#doc-note').textContent = sample
    ? `${s.blurb} Its YAML front matter (where it comes from) is not shown here; it is kept with the text.`
    : s ? `Your text (edited from the ${s.label} sample): extracted as it is. "Use the sample" puts the sample back.` : '';
  $('#use-sample').hidden = sample || !state.samples.some((x) => x.ontology === state.stats?.ontology.id);
  updateExtractButton();
  renderEmptyState();
}

/** Step 3's button: what it extracts, or why it cannot yet. */
function updateExtractButton() {
  const b = $('#extract');
  const hint = $('#extract-hint');
  const sampleHere = docIsSample() && state.doc.sample.ontology === state.stats?.ontology.id && state.doc.titleBy !== 'user';
  const { title } = currentDoc();
  b.textContent = sampleHere ? 'Extract the sample' : `Extract “${title.length > 32 ? `${title.slice(0, 31)}…` : title}”`;
  let why = '';
  if (!state.store) why = 'Waiting for the store to open.';
  else if (state.model.loading) why = 'The model is loading (step 2).';
  else if (!state.model.loaded) why = 'Load the model first (step 2).';
  else if (!$('#text').value.trim()) why = 'The Document is empty: use the sample, load a file or paste text.';
  b.disabled = Boolean(why) || state.extracting;
  hint.textContent = state.extracting ? '' : why;
  $('#step-extract').classList.toggle('done', !why && Boolean(state.stats?.documents.length));
}

$('#text').addEventListener('input', () => textEdited());
$('#title').addEventListener('input', () => titleTyped());
$('#use-sample').addEventListener('click', async () => {
  const s = state.samples.find((x) => x.ontology === state.stats?.ontology.id);
  if (s) await useSample(s);
});
$('#load-file').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', async () => {
  const f = /** @type {File|undefined} */ ($('#file').files?.[0]);
  $('#file').value = '';
  if (!f) return;
  if (f.size > MAX_UPLOAD) {
    $('#extract-status').textContent = `${f.name} is ${mb(f.size)}; the page takes up to 2 MB.`;
    return;
  }
  $('#text').value = await f.text();
  state.doc = { sample: null, head: '', body: '', titleBy: state.doc.titleBy === 'user' ? 'user' : 'auto', fileName: f.name.replace(/\.(md|markdown|txt)$/i, '') };
  $('#doc-details').open = true;
  textEdited();
});

$('#extract').addEventListener('click', () => planAndExtract(currentDoc()));
$('#continue').addEventListener('click', () => state.lastJob && runExtract(state.lastJob));
$('#confirm-yes').addEventListener('click', () => {
  $('#confirm').hidden = true;
  if (state.planned) runExtract(state.planned.job, state.planned.plan);
  state.planned = null;
});
$('#confirm-no').addEventListener('click', () => {
  $('#confirm').hidden = true;
  state.planned = null;
  setBody({ extract: 'idle' });
  $('#extract-status').textContent = 'Cancelled.';
});
// A title the store already holds for other text: replace that document, keep both, or cancel.
$('#dup-replace').addEventListener('click', () => {
  const p = state.planned;
  $('#dup').hidden = true;
  state.planned = null;
  if (!p?.same) return;
  busy(async () => {
    const status = $('#extract-status');
    try {
      // The Store tab's Forget: the earlier document's trace goes; its cached inferences and verdicts stay.
      for (const d of p.same) await call('forget', { doc: d.id, gate: state.gate });
      await refreshStats();
    } catch (e) {
      setBody({ extract: 'failed' });
      status.className = 'step-status error-text';
      status.textContent = message(e);
      return;
    }
    p.job.replaced = p.same.length;
    await sizeCheckAndExtract(p.job, p.plan);
  });
});
$('#dup-add').addEventListener('click', () => {
  const p = state.planned;
  $('#dup').hidden = true;
  state.planned = null;
  if (p) sizeCheckAndExtract(p.job, p.plan);
});
$('#dup-cancel').addEventListener('click', () => {
  $('#dup').hidden = true;
  state.planned = null;
  setBody({ extract: 'idle' });
  $('#extract-status').textContent = 'Cancelled: change the title under Document, or extract it again and choose.';
  $('#doc-details').open = true;
  $('#title').focus();
});
$('#stop').addEventListener('click', async () => {
  if (!state.extracting) return;
  $('#stop').disabled = true;
  $('#extract-status').textContent = 'Stopping after the current section…';
  try { await call('stop'); } catch { /* not running any more */ }
});

/**
 * Step 3's Extract: plan it, then ask first when the store holds this title for other text (the plan's
 * document id is the text's sha256: never two documents titled the same without saying
 * so) or when it needs the model for many sentences, then extract.
 * @param {{text: string, title: string}} job
 */
async function planAndExtract(job) {
  const status = $('#extract-status');
  status.className = 'step-status';
  if (!job.text.trim()) { status.textContent = 'There is no text to extract.'; return; }
  if (new TextEncoder().encode(job.text).length > MAX_UPLOAD) { status.textContent = 'The text is over 2 MB.'; return; }
  if (!state.store) { status.textContent = 'Open a store first.'; return; }
  if (!state.model.loaded) { status.textContent = 'Load the model first (step 2).'; return; }
  $('#confirm').hidden = true;
  $('#dup').hidden = true;
  setBody({ extract: 'planning' });
  try {
    const plan = await call('plan', { text: job.text });
    const same = (state.stats?.documents ?? []).filter((/** @type {any} */ d) => d.title === job.title && d.id !== plan.doc);
    if (same.length) {
      state.planned = { job, plan, same };
      const one = same.length === 1;
      $('#dup-text').textContent = `This store already holds ${one ? 'a document' : `${same.length} documents`} titled “${job.title}”, with other text ` +
        `(${andList(same.map((/** @type {any} */ d) => plural(d.chars, 'character')))}). Replace ${one ? 'it' : 'them'} with this text, ` +
        `or keep both as documents of the same title? Or cancel and change the title under Document.`;
      $('#dup-replace').textContent = one ? 'Replace it' : `Replace all ${same.length}`;
      $('#dup').hidden = false;
      setBody({ extract: 'duplicate' });
      return;
    }
    await sizeCheckAndExtract(job, plan);
  } catch (e) {
    setBody({ extract: 'failed' });
    status.className = 'step-status error-text';
    status.textContent = message(e);
  }
}

/**
 * Ask first when more than ASK_ABOVE sentences need the model (section 4), else extract.
 * @param {{text: string, title: string, replaced?: number}} job @param {any} plan
 */
async function sizeCheckAndExtract(job, plan) {
  if (plan.needInference > ASK_ABOVE) {
    state.planned = { job, plan };
    $('#confirm-text').textContent = `${plan.sentences} sentences in ${plural(plan.sections, 'section')}; ` +
      `${plan.needInference} need the model (about ${Math.ceil(plan.needInference * MS_PER_SENTENCE / 1000)} s), ${plan.cached} are cached. ` +
      'You can stop after any section and continue later.';
    $('#confirm-yes').textContent = `Extract ${plan.needInference} sentences`;
    $('#confirm').hidden = false;
    setBody({ extract: 'confirm' });
    return;
  }
  await runExtract(job, plan);
}

/**
 * Extract a document: progress in step 3 and over the graph (a line per model call, worker.js
 * `inference` events, and per section), then the graph fitted to what was kept and a summary line:
 * what this document kept (the store's graph for it, the worker's `graph` with its id) and left in
 * review (the gate's count for it, extract's `gate.doc`), then what the graph holds.
 * @param {{text: string, title: string, replaced?: number}} job @param {any} [plan]  the worker's plan, when the caller has one
 */
async function runExtract(job, plan = null) {
  if (state.extracting) return;
  state.extracting = true;
  state.lastJob = job;
  setBody({ extract: 'running' });
  const status = $('#extract-status');
  const bar = $('#extract-progress');
  status.className = 'step-status';
  status.textContent = 'Extracting…';
  for (const k of ['sectionsDone', 'sections', 'inferences', 'hits', 'skipped']) delete status.dataset[k];
  hideSummary();
  renderKept(null);
  $('#continue').hidden = true;
  $('#stop').hidden = false;
  $('#stop').disabled = false;
  updateExtractButton();
  renderEmptyState();
  try {
    plan ??= await call('plan', { text: job.text }).catch(() => null);
    state.progress = { need: plan?.needInference ?? 0, cached: plan?.cached ?? 0, sentences: plan?.sentences ?? 0, asked: 0, sections: plan?.sections ?? 0, done: plan?.complete ?? 0, title: job.title };
    bar.hidden = false;
    $('#graph-progress').hidden = false;
    renderProgress();
    const r = await busy(() => call('extract', { text: job.text, title: job.title, gate: state.gate }));
    const c = r.counters;
    state.lastDoc = c.doc;
    if (c.status === 'stopped') {
      setBody({ extract: 'stopped' });
      status.textContent = `Stopped after ${c.written + c.skipped} of ${c.sections} sections (${c.inferences} inferences, ${c.hits} cache hits). Continue picks up where it stopped.`;
      $('#continue').hidden = false;
      await refreshAll();
    } else {
      const d = r.gate?.doc;
      Object.assign(status.dataset, { inferences: String(c.inferences), hits: String(c.hits), skipped: String(c.skipped) });
      status.textContent = `Read ${plural(c.sentences, 'sentence')}${c.sections > 1 ? ` in ${c.sections} sections` : ''}${c.skipped ? ` (${c.skipped} already complete)` : ''}: ` +
        `${c.inferences} asked of the model, ${c.hits} from the cache.` +
        (d ? ` Candidate relationships: ${d.claims.keep} kept, ${d.claims.review} to review, ${d.claims.drop} dropped.` : '');
      renderKept(d?.kept ?? []);
      await Promise.all([refreshGraph({ fit: true }), refreshReview(), refreshStats()]);
      // This document's share, from the store (not a difference of totals: the gate runs over every
      // document, so an extraction can move another document's candidates too).
      const mine = await call('graph', { doc: c.doc, candidates: false }).catch(() => null);
      showSummary(job, {
        entities: mine?.nodes.length ?? 0, relationships: mine?.rels.length ?? 0,
        review: d ? (d.mentions.review ?? 0) + (d.claims.review ?? 0) : 0,
      }, r.published);
      // `done` once the page shows the result (tests read the summary line and the kept facts then).
      setBody({ extract: 'done' });
    }
  } catch (e) {
    setBody({ extract: 'failed' });
    status.className = 'step-status error-text';
    status.textContent = message(e);
    if (state.lastJob) $('#continue').hidden = false;
  } finally {
    state.extracting = false;
    bar.hidden = true;
    $('#graph-progress').hidden = true;
    $('#stop').hidden = true;
    updateExtractButton();
    renderEmptyState();
  }
}

/** The running extraction's progress, in step 3 and over the graph. */
function renderProgress() {
  const p = state.progress;
  const sectionPart = p.sections > 1 ? ` · section ${Math.min(p.done + 1, p.sections)} of ${p.sections}` : '';
  let line;
  if (p.sections && p.done >= p.sections) line = 'Gating the candidates and publishing the graph…';
  else if (p.need && p.asked) line = `Asking the model about sentence ${p.asked} of ${p.need}${p.cached ? ` (${p.cached} more from the cache)` : ''}${sectionPart}`;
  else if (p.need) line = `Starting: ${plural(p.need, 'sentence')} to ask the model${p.cached ? `, ${p.cached} from the cache` : ''}${sectionPart}`;
  else line = `Reading ${plural(p.sentences, 'sentence')} from the inference cache${sectionPart}`;
  const frac = Math.max(p.sections ? p.done / p.sections : 0, p.need ? (p.asked - 1) / p.need : 0);
  $('#extract-progress').value = Math.max(0, Math.min(1, frac));
  $('#graph-progress-bar').value = Math.max(0, Math.min(1, frac));
  $('#extract-status').textContent = `${line}.`;
  $('#graph-progress-text').textContent = `Extracting “${p.title}”: ${line.charAt(0).toLowerCase()}${line.slice(1)}`;
}

/** The kept facts of the document just extracted, under step 3's status (data-fact: as extract.txt writes them). @param {any[]|null} kept */
function renderKept(kept) {
  const box = $('#kept');
  box.hidden = !kept || !kept.length;
  if (!kept) { box.replaceChildren(); return; }
  box.replaceChildren(...kept.map((k) => h('li', { 'data-testid': 'kept-fact', 'data-fact': `"${k.head}" -[${k.rel}]-> "${k.tail}" ${f3(k.p)}`,
    text: `${k.head} → ${k.rel} → ${k.tail} (${f3(k.p)})` })));
  if (kept.length) box.prepend(h('li', { class: 'hint', text: `Relationships kept from this document (${kept.length}):` }));
}

/** @param {any} ev */
function onEngineEvent(ev) {
  if (!state.extracting) return;
  if (ev.event === 'inference') {
    state.progress.asked = ev.n;
    renderProgress();
  } else if (ev.event === 'section') {
    state.progress.done = ev.section + 1;
    state.progress.sections = ev.sections;
    const status = $('#extract-status');
    status.dataset.sectionsDone = String(ev.section + 1);
    status.dataset.sections = String(ev.sections);
    renderProgress();
  }
}

/** "18 entities and 4 relationships" @param {{entities: number, relationships: number}} p */
const graphAnd = (p) => `${plural(p.entities, 'entity', 'entities')} and ${plural(p.relationships, 'relationship')}`;

/**
 * The line over the graph after an extraction: what this document kept and left waiting
 * for a verdict, then what the graph holds now, with Review (the store's count) and "Show only this
 * document" (or back to all of them).
 * @param {{title: string, replaced?: number}} job
 * @param {{entities: number, relationships: number, review: number}} mine  this document's share
 * @param {{entities: number, relationships: number}} published  the store's typed graph
 */
function showSummary(job, mine, published) {
  const n = state.reviewOpen;
  const el = $('#graph-summary');
  Object.assign(el.dataset, {
    entities: String(published.entities), rels: String(published.relationships), review: String(n),
    docEntities: String(mine.entities), docRels: String(mine.relationships), docReview: String(mine.review),
  });
  const k = mine.review;
  $('#graph-summary-text').textContent = `“${job.title}”${job.replaced ? ` (replacing the earlier ${job.replaced === 1 ? 'text' : 'texts'} of that title)` : ''}: ` +
    `kept ${graphAnd(mine)}; ${k ? `${k} ${k === 1 ? 'waits' : 'wait'} for your verdict` : 'nothing waits for your verdict'}. ` +
    `The graph now holds ${graphAnd(published)}.`;
  $('#graph-summary-review').textContent = `Review (${n}) →`;
  $('#graph-summary-review').hidden = !n;
  $('#scope-doc-label').title = `“${job.title}”, the document extracted last`;
  renderSummaryScope();
  el.hidden = false;
}
function hideSummary() {
  $('#graph-summary').hidden = true;
}
/** The summary line's scope button: "Show only this document" while all are drawn, else "Show all documents". */
function renderSummaryScope() {
  const b = $('#graph-summary-scope');
  const doc = /** @type {HTMLInputElement} */ (document.querySelector('input[name="scope"]:checked')).value === 'doc';
  b.hidden = !state.lastDoc;
  b.textContent = doc ? 'Show all documents' : 'Show only this document';
  b.dataset.scope = doc ? 'all' : 'doc';
}
$('#graph-summary-review').addEventListener('click', () => showTab('review', { focus: true }));
$('#graph-summary-close').addEventListener('click', () => hideSummary());
$('#graph-summary-scope').addEventListener('click', () => {
  const to = $('#graph-summary-scope').dataset.scope;
  /** @type {HTMLInputElement} */ (document.querySelector(`input[name="scope"][value="${to}"]`)).checked = true;
  renderSummaryScope();
  refreshGraph({ fit: true });
});

async function refreshAll() {
  await Promise.all([refreshGraph(), refreshReview(), refreshStats()]);
}

async function refreshStats() {
  if (!state.store) return;
  try {
    state.stats = await call('stats');
    state.store.stats = state.stats;
    renderCutoffs();
    renderStoreFacts();
    renderDomainStatus();
    renderEmptyState();
  } catch (e) {
    notice(message(e), 'error');
  }
}

// ---- the graph tab ----------------------------------------------------------------------------------

/**
 * Draw the open store's typed graph (and its review candidates, faded) in the graph tab.
 * @param {{fit?: boolean}} [opts]  fit: fit the view once the layout has placed it (an extraction, a store switch)
 */
async function refreshGraph({ fit = false } = {}) {
  if (!state.store) {
    graphView.clear();
    state.drawn = { nodes: 0, candidates: 0 };
    renderEmptyState();
    return;
  }
  const scope = /** @type {HTMLInputElement} */ (document.querySelector('input[name="scope"]:checked')).value;
  const doc = scope === 'doc' ? state.lastDoc : null;
  try {
    const g = await call('graph', { doc, candidates: state.candidates });
    // The review candidates are drawn beside the kept graph, faded (tonvl.js), and counted apart.
    const cand = g.candidates ?? { nodes: [], rels: [] };
    graphView.set({ nodes: [...g.nodes, ...cand.nodes], rels: [...g.rels, ...cand.rels] }, { labelOrder: g.labelOrder, colors: g.colors }, { fit });
    const counts = $('#graph-counts');
    counts.textContent = `${plural(g.nodes.length, 'entity', 'entities')}, ${plural(g.rels.length, 'relationship')}` +
      `${scope === 'doc' && !doc ? ' (no document extracted yet: all shown)' : ''}` +
      (state.candidates && cand.nodes.length + cand.rels.length ? ` · in review (faded): ${plural(cand.nodes.length, 'entity', 'entities')}, ${plural(cand.rels.length, 'relationship')}` : '');
    counts.title = state.candidates ? `Kept: ${g.nodes.length} entities, ${g.rels.length} relationships. In review, drawn faded: ${cand.nodes.length} entities, ${cand.rels.length} relationships.` : '';
    counts.dataset.scope = scope;
    counts.dataset.nodes = String(g.nodes.length);
    counts.dataset.rels = String(g.rels.length);
    counts.dataset.candidateNodes = String(cand.nodes.length);
    counts.dataset.candidateRels = String(cand.rels.length);
    state.drawn = { nodes: g.nodes.length, candidates: cand.nodes.length };
    renderLegend(g);
  } catch (e) {
    $('#graph-counts').textContent = message(e);
  }
  renderEmptyState();
}
for (const r of document.querySelectorAll('input[name="scope"]')) r.addEventListener('change', () => { renderSummaryScope(); refreshGraph({ fit: true }); });
$('#show-candidates').checked = state.candidates;
$('#show-candidates').addEventListener('change', () => {
  state.candidates = $('#show-candidates').checked;
  local.set('graphCandidates', state.candidates ? '1' : '0');
  refreshGraph();
});
$('#graph-fit').addEventListener('click', () => graphView.fit());

/**
 * The graph tab's empty state: what to do next when nothing is drawn (load the model, extract, or
 * review), with the button that does it. Hidden while an extraction runs (its progress shows) and
 * once anything is drawn.
 */
function renderEmptyState() {
  const el = $('#graph-empty');
  const action = $('#graph-empty-action');
  const set = (/** @type {string} */ id, /** @type {string} */ title, /** @type {string} */ textLine, /** @type {string} */ button = '') => {
    el.dataset.state = id;
    $('#graph-empty-title').textContent = title;
    $('#graph-empty-text').textContent = textLine;
    action.textContent = button;
    action.dataset.action = button ? id : '';
    action.hidden = !button;
    el.hidden = false;
  };
  if (state.extracting || state.drawn.nodes + state.drawn.candidates > 0) {
    el.hidden = true;
    el.dataset.state = state.extracting ? 'extracting' : 'drawn';
    return;
  }
  const s = state.stats;
  if (!state.store || !s) {
    set('no-store', 'Opening the store…', 'The domain picked in step 1 has its own store in this browser.');
  } else if (s.documents.length) {
    const n = state.reviewOpen;
    set('nothing-kept', 'Nothing kept yet', n
      ? `${n} ${n === 1 ? 'candidate waits' : 'candidates wait'} for your verdict in Review; accept the right ones, or lower the cutoffs in the Cutoffs tab.`
      : 'No candidate reached the cutoffs. Lower them in the Cutoffs tab, or extract another document.', n ? 'Open Review' : '');
  } else if (state.model.loading) {
    set('model-loading', 'Loading the model…', 'Then extract the sample (step 3): its knowledge graph appears here.');
  } else if (!state.model.loaded) {
    set('load-model', 'Nothing extracted yet', `First load the model (step 2, ${models.pinned() ? mb(models.MODELS[state.model.which]?.bytes ?? 0) : 'a download'} once, then cached), then extract the sample (step 3). ` +
      'GLiNER2.5 reads it sentence by sentence and the kept facts appear here as a graph.', models.pinned() ? `Load ${shortModel(state.model.which)}` : '');
  } else {
    set('extract', 'Ready to extract', 'Extract the sample (step 3), or open "Document" there to paste your own text. The kept facts appear here as a graph.', $('#extract').textContent);
  }
}
$('#graph-empty-action').addEventListener('click', () => {
  const a = $('#graph-empty-action').dataset.action;
  if (a === 'load-model') loadModel(state.model.which);
  else if (a === 'extract') planAndExtract(currentDoc());
  else if (a === 'nothing-kept') showTab('review', { focus: true });
});

/** The legend under the graph: each kind in its colour, then what a faded element is. @param {any} g */
function renderLegend(g) {
  const box = $('#legend');
  box.replaceChildren();
  const colors = g.colors ?? {};
  for (const k of /** @type {string[]} */ (g.labelOrder)) {
    const sw = h('span', { class: 'swatch' });
    sw.style.background = labelColor(k, g.labelOrder, colors);
    box.append(h('span', {}, sw, k));
  }
  if (state.candidates) {
    const sw = h('span', { class: 'swatch candidate' });
    box.append(h('span', { 'data-testid': 'legend-candidates' }, sw, 'faded, "(review)": waits for your verdict; click to accept or reject'));
  }
}

// ---- the review tab ---------------------------------------------------------------------------------

async function refreshReview() {
  const list = $('#review-list');
  if (!state.store) { list.replaceChildren(); return; }
  try {
    const r = await call('review');
    const open = [...r.claims, ...r.mentions].filter((x) => x.band === 'review');
    const decided = [...r.claims, ...r.mentions].filter((x) => x.rule === 'verdict' || x.rule === 'claim-verdict');
    $('#review-count').textContent = open.length ? String(open.length) : '';
    state.reviewOpen = open.length;
    list.replaceChildren(
      group(`To review (${open.length})`, open, 'Nothing waits for a verdict.'),
      group(`Decided by a verdict (${decided.length})`, decided, 'No verdicts yet.'),
    );
  } catch (e) {
    list.replaceChildren(h('p', { class: 'error-text', text: message(e) }));
  }
}

/** @param {string} title @param {any[]} items @param {string} empty */
function group(title, items, empty) {
  const g = h('div', { class: 'review-group' }, h('h3', { text: title }));
  if (!items.length) g.append(h('p', { class: 'hint', text: empty }));
  for (const x of items) g.append(reviewItem(x));
  return g;
}

const f2 = (/** @type {any} */ x) => (typeof x === 'number' ? x.toFixed(2) : String(x));

/**
 * One plain sentence: why a claim or a mention is where it is, by the rule that decided it (D10; the
 * README's gate table). Rows come from the worker's reviewItems (cutoffs, ends, the other kinds).
 * @param {any} x
 */
function explain(x) {
  const g = state.gate;
  const kinds = new Map((state.stats?.ontology.kinds ?? []).map((/** @type {any} */ k) => [k.id, k]));
  const owner = x.item === 'claim' ? x.rel : x.label;
  const cuts = x.keep != null && x.drop != null ? ` (${owner} keeps at ${f2(x.keep)} and drops at ${f2(x.drop)})` : '';
  const pole = (/** @type {string} */ id) => kinds.get(id)?.pole ?? null;
  const isBase = (/** @type {string} */ id) => kinds.get(id)?.origin === 'base';
  const others = /** @type {Array<{label: string, p: number}>} */ (x.others ?? []);
  switch (x.rule) {
    case 'band':
      if (x.band === 'keep') return `Its score ${f3(x.p)} reaches the keep cutoff${cuts}.`;
      if (x.band === 'drop') return `Its score ${f3(x.p)} is at or below the drop cutoff${cuts}.`;
      return `Its score ${f3(x.p)} lies between the cutoffs${cuts}, so it waits for a verdict.`;
    case 'type-margin': {
      const related = (/** @type {string} */ id) => pole(id) !== null && pole(id) === pole(x.label) && isBase(id) !== isBase(x.label);
      const r = others.find((o) => !related(o.label));
      return `Another kind for the same words, ${r ? `${r.label} (${f3(r.p)})` : 'a runner-up'}, scored within the type margin (${f2(g.typeMargin)}) of this one, so a person decides which kind it is.`;
    }
    case 'pole-specific': {
      const base = others.find((o) => isBase(o.label) && pole(o.label) !== null && pole(o.label) === pole(x.label));
      return `${x.label} took these words from ${base ? `the base kind ${base.label} (${f3(base.p)})` : 'the base kind of its pole'}, which it specialises, by scoring within the pole margin (${f2(g.poleMargin)}); ` +
        `at ${f3(x.p)} it is ${x.band === 'keep' ? 'kept' : x.band === 'review' ? 'below the keep cutoff' : 'dropped'}${cuts}.`;
    }
    case 'end-in-review': {
      const ends = [x.hband === 'review' ? `head "${x.hmtext}" (${x.hmlabel})` : '', x.tband === 'review' ? `tail "${x.tmtext}" (${x.tmlabel})` : ''].filter(Boolean);
      const both = ends.length > 1;
      return `Its score ${f3(x.p)} would keep it, but its ${ends.join(' and its ') || 'end'} ${both ? 'are' : 'is'} in review; accepting ${both ? 'those mentions' : 'that mention'}, or this claim, publishes it.`;
    }
    case 'hedged':
      return `Its sentence hedges or negates it ("${x.cue ?? 'a cue'}" before its later end), and the model scores that like a plain fact, so a person decides whether it holds.`;
    case 'other-kind':
      return x.band === 'drop'
        ? `These words are also kept here as ${x.alt ?? 'another kind'}, the kind this name keeps in the store, so this reading of them drops.`
        : `This name is also kept as ${x.alt ?? 'another kind'} in this store, the kind with the stronger evidence, so a person decides whether these are two things; accepting it keeps both.`;
    case 'ambiguous':
      return `This sentence also links the same two entities another way, scoring higher or within the relation margin (${f2(g.relMargin)}) of this link, so a person decides which link holds.`;
    case 'reversed':
      return `${x.rel} also came out the other way round in this sentence and is not symmetric, so a person decides its direction.`;
    case 'illegal':
      return `The ontology does not allow ${x.rel} from ${x.hk ?? 'this kind'} to ${x.tk ?? 'that kind'}.`;
    case 'unanchored':
      return 'An end of this claim joins no mention that is kept or in review, or joins one a verdict rejected, so there is nothing to publish it between.';
    case 'self-loop':
      return `Both ends are the same entity${x.headKey ? ` (${x.headKey})` : ''}, and a fact needs two.`;
    case 'no-name':
      return 'A pronoun, or text with no letter or digit to name an entity by, cannot be an entity.';
    case 'claim-verdict':
      return 'Kept because you accepted a claim that joins it.';
    case 'verdict':
      return `You ${x.verdict === 'reject' || x.band === 'drop' ? 'rejected' : 'accepted'} it, and the latest verdict wins over the cutoffs.`;
    case 'gazetteer':
      return x.band === 'keep' ? 'A name the ontology lists (its gazetteer), kept as that kind.' : 'It overlaps a name the ontology lists, which takes these words.';
    case 'one-kind':
      return 'Another kind scored higher on the same words and took them.';
    case 'floor':
      return 'Kept by the floor alone: the band rule is switched off.';
    default:
      return `Decided by ${x.rule}.`;
  }
}

/**
 * A claim or mention with its band, why it is there, its sentence and Accept / Reject.
 * @param {any} x
 * @param {{testid?: string, after?: (value: string) => void}} [opts]  testid: the element's data-testid;
 *   after: called once a verdict from this item has been written and the views refreshed
 */
function reviewItem(x, { testid = 'review-item', after } = {}) {
  const what = x.item === 'claim' ? `"${x.head}" -[${x.rel}]-> "${x.tail}"` : `"${x.text}" as ${x.label}`;
  const spans = x.item === 'claim' ? [[x.hs, x.he], [x.ts, x.te]] : [[x.ms, x.me]];
  const left = h('div', {},
    h('div', { class: 'what' }, what, ' ', h('span', { class: `band ${x.band}`, text: x.band })),
    h('div', { class: 'meta', text: `p ${f3(x.p)} · ${plainRule(x.rule, x.band)} · ${sentenceAt(x)}` }),
    h('div', { class: 'why', 'data-testid': 'why', text: explain(x) }),
    h('div', {}, marked(x.sentence, spans)));
  const accept = h('button', { type: 'button', class: 'small', 'data-testid': 'accept', text: 'Accept', disabled: x.verdict === 'accept' });
  const reject = h('button', { type: 'button', class: 'small', 'data-testid': 'reject', text: 'Reject', disabled: x.verdict === 'reject' });
  accept.addEventListener('click', async () => { if (await verdict(x.key, 'accept')) after?.('accept'); });
  reject.addEventListener('click', async () => { if (await verdict(x.key, 'reject')) after?.('reject'); });
  return h('div', { class: 'review-item', 'data-testid': testid, 'data-key': x.key, 'data-item': x.item, 'data-band': x.band, 'data-rule': x.rule },
    left, h('div', { class: 'row' }, accept, reject));
}

/** Write a verdict and refresh the views; true when it was written. @param {string} target @param {'accept'|'reject'} value */
async function verdict(target, value) {
  return busy(async () => {
    try {
      await call('verdict', { target, value, gate: state.gate });
      await refreshAll();
      return true;
    } catch (e) {
      notice(message(e), 'error');
      return false;
    }
  });
}

// ---- the cutoffs tab --------------------------------------------------------------------------------

function renderCutoffs() {
  $('#floor').textContent = FLOOR.toFixed(2);
  const s = state.stats;
  const d = s?.defaults;
  // format: how the ontology is asked and which defaults apply (create-context-graph's documents, or any other)
  const fmtName = s?.ontology.format === 'create-context-graph' ? "create-context-graph's ontologies" : 'Ontology Graph Spec v1 documents (asked as create-context-graph\'s are)';
  $('#cutoff-defaults').textContent = d
    ? `Defaults for ${fmtName} with ${modelLabel(s.defaultsModel)}: kinds keep at p ≥ ${d.entKeep.toFixed(2)}, drop at p ≤ ${d.entDrop.toFixed(2)}; ` +
      `links keep at p ≥ ${d.relKeep.toFixed(2)}, drop at p ≤ ${d.relDrop.toFixed(2)}. A cutoff you move is yours: loading the other model ` +
      'moves only the cutoffs still at their defaults.'
    : '';
  const moved = [...(s?.ontology.kinds ?? []), ...(s?.ontology.links ?? [])].filter((x) => x.src === 'user').length;
  $('#reset-cutoffs').disabled = !s;
  $('#reset-cutoffs').textContent = moved ? `Reset ${moved} moved cutoff${moved === 1 ? '' : 's'} to the defaults` : 'Reset to the defaults';
  const margins = $('#margins');
  margins.replaceChildren(h('div', { class: 'head', text: 'Margins' }), h('div', { class: 'head', text: '' }), h('div', { class: 'head', text: '' }));
  margins.append(
    h('div', { class: 'name', text: 'Type margin' }, h('small', { text: 'a runner-up kind this close sends the mention to review (rule 2)' })),
    slider('margin-type', state.gate.typeMargin, 0, 0.3, (v) => { state.gate.typeMargin = v; }, regate, false),
    h('div'),
    h('div', { class: 'name', text: 'Relation margin' }, h('small', { text: 'two links this close for one pair go to review (rule 6)' })),
    slider('margin-rel', state.gate.relMargin, 0, 0.3, (v) => { state.gate.relMargin = v; }, regate, false),
    h('div'),
    h('div', { class: 'name', text: 'Pole margin' }, h('small', { text: 'a domain kind this close below the base kind it specialises takes the words (rule 2; create-context-graph\'s POLE+O types)' })),
    slider('margin-pole', state.gate.poleMargin, 0, 1, (v) => { state.gate.poleMargin = v; }, regate, false),
    h('div'));
  for (const [what, box, rows] of /** @type {const} */ ([['kind', '#kind-cutoffs', s?.ontology.kinds ?? []], ['link', '#link-cutoffs', s?.ontology.links ?? []]])) {
    const el = $(box);
    el.replaceChildren(h('div', { class: 'head', text: what === 'kind' ? 'Kind' : 'Link' }), h('div', { class: 'head', text: 'keep at p ≥' }), h('div', { class: 'head', text: 'drop at p ≤' }));
    for (const row of rows) {
      const cut = { keep: Number(row.keep), drop: Number(row.drop) };
      const label = what === 'kind' ? row.id : `${row.id}`;
      const pairs = (row.pairs ?? []).map((/** @type {string} */ p) => p.replace('|', ' → '));
      const legal = pairs.length && pairs.length <= 3 ? `; ${pairs.join(', ')}` : pairs.length ? `; ${pairs.length} kind pairs` : '';
      const asked = what === 'link' ? `asked as "${row.ask ?? row.phrase}"` : row.ask === null ? 'not asked of the model (a domain kind covers its pole)' : row.ask ? `asked as "${row.ask.label}"${row.ask.description ? `: ${row.ask.description}` : ''}` : '';
      const sub = what === 'link' ? `${asked}${row.typed ? ', typed' : ''}${row.symmetric ? ', symmetric' : ''}${legal}` : `${row.description ?? ''}${asked ? `; ${asked}` : ''}`;
      const keep = slider(`cutoff-${what}-${row.id}-keep`, cut.keep, 0, 1, (v) => { cut.keep = v; if (cut.drop > v) cut.drop = v; }, () => setCutoff(what, row.id, cut));
      const drop = slider(`cutoff-${what}-${row.id}-drop`, cut.drop, 0, 1, (v) => { cut.drop = v; if (cut.keep < v) cut.keep = v; }, () => setCutoff(what, row.id, cut));
      const src = h('span', { class: `cut-src ${row.src === 'user' ? 'user' : ''}`, 'data-testid': `cutoff-src-${what}-${row.id}`, text: row.src === 'user' ? 'set by you' : 'default' });
      el.append(h('div', { class: 'name' }, label, ' ', src, h('small', { text: sub })), keep, drop);
    }
  }
}

/**
 * @param {string} testid @param {number} value @param {number} min @param {number} max
 * @param {(v: number) => void} onInput @param {() => void} onChange
 * @param {boolean} [cutoff]  a cutoff (warn below the floor); margins are not cutoffs
 */
function slider(testid, value, min, max, onInput, onChange, cutoff = true) {
  // Its accessible name says which cutoff it is (the value beside it is its label's only text).
  const name = testid.replace(/^margin-(\w+)$/, (_, m) => `${({ type: 'Type', rel: 'Relation', pole: 'Pole' })[m] ?? m} margin`)
    .replace(/^cutoff-(?:kind|link)-(.+)-(keep|drop)$/, (_, id, k) => `${id}: ${k === 'keep' ? 'keep at p at or above' : 'drop at p at or below'}`);
  const input = h('input', { type: 'range', min, max, step: 0.01, value: value.toFixed(2), 'data-testid': testid, 'aria-label': name });
  const val = h('span', { class: 'val', text: value.toFixed(2) });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    val.textContent = v.toFixed(2);
    onInput(v);
    if (cutoff) belowFloor(v);
  });
  input.addEventListener('change', onChange);
  return h('label', {}, input, val);
}

/** Below the floor no stored candidate exists: say how many sentences a re-inference would take. @param {number} v */
function belowFloor(v) {
  const el = $('#below-floor');
  if (v >= FLOOR) { el.hidden = true; return; }
  const n = state.stats?.inferredSentences ?? 0;
  el.hidden = false;
  el.textContent = `${v.toFixed(2)} is below the floor (${FLOOR.toFixed(2)}): the store holds no candidate under it, so this cutoff cannot see more. ` +
    `Seeing below the floor would mean running the model again on ${n} sentence${n === 1 ? '' : 's'}; the page never does that for a cutoff.`;
}

async function regate() {
  local.set('gate', JSON.stringify(state.gate));
  await busy(async () => {
    try {
      const r = await call('regate', { gate: state.gate });
      $('#cutoffs-status').textContent = `Re-gated: claims keep ${r.gate.claims.keep}, review ${r.gate.claims.review}, drop ${r.gate.claims.drop}; typed graph ${graphSize(r.published)}.`;
      await refreshAll();
    } catch (e) {
      $('#cutoffs-status').textContent = message(e);
    }
  });
}

/** Every cutoff back to the defaults of the store's format and the model (they follow the defaults again). */
async function resetCutoffs() {
  await busy(async () => {
    try {
      const r = await call('reset-cutoffs', { gate: state.gate });
      $('#cutoffs-status').textContent = `Every cutoff is back at its default and follows the defaults again. Claims keep ${r.gate.claims.keep}, review ${r.gate.claims.review}, ` +
        `drop ${r.gate.claims.drop}; typed graph ${graphSize(r.published)}. No model call.`;
      await refreshAll();
    } catch (e) {
      $('#cutoffs-status').textContent = message(e);
    }
  });
}
$('#reset-cutoffs').addEventListener('click', () => resetCutoffs());

/** @param {'kind'|'link'} what @param {string} id @param {{keep: number, drop: number}} cut */
async function setCutoff(what, id, cut) {
  await busy(async () => {
    try {
      const r = await call('cutoffs', { what, name: id, keep: cut.keep, drop: cut.drop, gate: state.gate });
      $('#cutoffs-status').textContent = `${id}: keep ≥ ${cut.keep.toFixed(2)}, drop ≤ ${cut.drop.toFixed(2)}. Claims keep ${r.gate.claims.keep}, review ${r.gate.claims.review}, drop ${r.gate.claims.drop}; ` +
        `typed graph ${graphSize(r.published)}. No model call.` +
        (r.belowFloor.sentences ? ` Below the floor: ${r.belowFloor.sentences} sentences would need re-inference.` : '');
      $('#cutoffs-status').dataset.belowFloor = String(r.belowFloor.sentences);
      await refreshAll();
    } catch (e) {
      $('#cutoffs-status').textContent = message(e);
    }
  });
}

// ---- the console (D11) -------------------------------------------------------------------------------

/** @type {Worker|null} */
let consoleWorker = null;
let consoleSeq = 0;
/** @type {Map<number, (msg: any) => void>} */
const consolePending = new Map();
/** @type {Promise<void>|null} */
let consoleInit = null;

function newConsoleWorker() {
  const w = new Worker(new URL('./console.js', import.meta.url), { type: 'module', name: 'ex01-console' });
  w.onmessage = (ev) => {
    const done = consolePending.get(ev.data?.id);
    if (done) {
      consolePending.delete(ev.data.id);
      done(ev.data);
    }
  };
  w.onerror = (ev) => {
    ev.preventDefault();
    killConsole({ code: 'trap', message: `the console worker stopped: ${ev.message || 'unknown'}` });
  };
  return w;
}

/**
 * End the console worker (no cancel API). An idle worker's lock goes at once; one inside a
 * query keeps the lent store's OPFS handles about 2 s more (R11), which the engine's reclaim
 * waits out. Calls still waiting get `error`, so no lease is left hanging.
 * @param {{code: string, message: string}} [error]
 */
function killConsole(error = { code: 'stopped', message: 'the console worker was stopped' }) {
  consoleWorker?.terminate();
  consoleWorker = null;
  consoleInit = null;
  const waiting = [...consolePending.values()];
  consolePending.clear();
  for (const done of waiting) done({ ok: false, error });
}

/** @param {any} msg @param {number} [timeout] @returns {Promise<any>} */
function consoleCall(msg, timeout = 0) {
  if (!consoleWorker) consoleWorker = newConsoleWorker();
  const w = consoleWorker;
  const id = ++consoleSeq;
  return new Promise((resolve) => {
    /** @type {number} */
    let timer = 0;
    consolePending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    if (timeout) {
      timer = window.setTimeout(() => {
        consolePending.delete(id);
        killConsole(); // no cancel API: end the worker, which frees the store (R11)
        resolve({ ok: false, error: { code: 'watchdog', message: `The query was still running after ${WATCHDOG_MS / 1000} s, so the console worker was stopped (Relate has no cancel). Bound variable-length patterns, e.g. *1..4.` } });
      }, timeout);
    }
    w.postMessage({ id, ...msg });
  });
}

async function ensureConsole() {
  if (!consoleInit) {
    consoleInit = consoleCall({ kind: 'init' }).then((r) => {
      if (!r.ok) { killConsole(); throw new EngineFailure(r.error); }
      if (Array.isArray(r.data?.procedures) && state.procedures === null) {
        state.procedures = r.data.procedures;
        refreshToolNotes();
      }
    });
  }
  return consoleInit;
}

/**
 * One console query under the lease (D11): lend -> read-only open, run, free -> reclaim. The
 * read-only handle is the engine's own guard (R15): a write that happens is refused, one that
 * matches nothing succeeds and writes nothing (R15). It waits for a recycle in progress (R13).
 * strict: an ontology tool's run, whose null, missing or NaN parameters lib/relate_wasm.mjs refuses (R3).
 * @param {string} query @param {Record<string, any>} [params] @param {{strict?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, data?: any, error?: any, leaseMs: number}>}
 */
async function runConsole(query, params = {}, { strict = false } = {}) {
  while (state.recycling) await state.recycling;
  if (!state.store) return { ok: false, error: { code: 'no-store', message: 'Open a store first.' }, leaseMs: 0 };
  await ensureConsole(); // outside the lease: loading the console's engine takes a moment
  const t0 = performance.now();
  /** @type {any} */
  let lend;
  try {
    lend = await call('lend');
  } catch (e) {
    return { ok: false, error: { code: e instanceof EngineFailure ? e.code : 'error', message: message(e) }, leaseMs: 0 };
  }
  state.lease = true;
  /** @type {any} */
  let res;
  try {
    state.consoleQueries++;
    res = await consoleCall({ kind: 'query', uri: lend.uri, query, params, strict: strict === true }, WATCHDOG_MS);
    if (!res.ok && res.error?.code === 'trap') killConsole();
  } finally {
    try {
      await call('reclaim');
    } catch (e) {
      res = { ok: false, error: { code: 'reclaim', message: `the engine could not take the store back: ${message(e)}` } };
    } finally {
      state.lease = false;
    }
  }
  return { ...res, leaseMs: Math.round(performance.now() - t0) };
}

function renderSavedQueries() {
  const sel = $('#saved-queries');
  for (const q of state.queries) sel.append(h('option', { value: q.file, text: `${q.file.replace(/\.cypher$/, '')}: ${q.title}` }));
}
$('#saved-queries').addEventListener('change', () => {
  const q = state.queries.find((x) => x.file === $('#saved-queries').value);
  state.editorTool = null;
  $('#query-doc').textContent = q ? `${q.title}. ${q.doc}` : '';
  if (q) $('#console-input').value = q.text.split('\n').filter((l) => !l.startsWith('//')).join('\n').trim();
  renderParams();
});
$('#console-input').addEventListener('input', () => {
  // A tool's description and note hold only while the editor holds its query unchanged.
  if (state.editorTool) $('#query-doc').textContent = editorTool() ? toolDoc(state.editorTool) : `Edited from the tool ${state.editorTool.name}: it runs as a console query, without the tool's checks.`;
  renderParams();
});

/** @type {Map<string, string>} values typed so far, by name */
const paramValues = new Map();
/** The tool whose query the editor holds unchanged (its checks apply to the console's Run), or null. */
const editorTool = () => (state.editorTool && $('#console-input').value.trim() === String(state.editorTool.cypher ?? '').trim() ? state.editorTool : null);
function renderParams() {
  const box = $('#console-params');
  const q = state.queries.find((x) => x.file === $('#saved-queries').value);
  const tool = editorTool();
  const tparams = tool ? toolParams(tool) : [];
  const names = cypherParams($('#console-input').value);
  box.replaceChildren();
  for (const name of names) {
    const tp = tparams.find((p) => p.name === name);
    const doc = q?.params.find((p) => p.name === name) ?? (tp ? { name, type: tp.type, example: tp.hint ?? tp.default ?? '', text: tp.description } : undefined);
    const initial = paramValues.get(name) ?? (doc ? (typeof doc.example === 'string' ? doc.example : JSON.stringify(doc.example)) : '');
    const input = h('input', { type: 'text', id: `console-param-${name}`, value: initial, 'data-testid': `param-${name}`, 'data-name': name, 'data-type': doc?.type ?? 'ANY', placeholder: doc?.type ?? 'a JSON value, or text' });
    input.addEventListener('input', () => paramValues.set(name, input.value));
    box.append(h('label', { for: `console-param-${name}`, text: `$${name}${doc ? ` (${doc.type})` : ''}`, title: doc?.text ?? '' }), input);
  }
}

/** The typed parameter values: STRING as typed, INTEGER/FLOAT as numbers, anything else as JSON or text. */
function readParams() {
  /** @type {Record<string, any>} */
  const out = {};
  for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('#console-params input'))) {
    const { name, type } = /** @type {{name: string, type: string}} */ (input.dataset);
    const v = input.value;
    if (type === 'STRING') out[name] = v;
    else if (type === 'INTEGER') out[name] = Number.parseInt(v, 10);
    else if (type === 'FLOAT') out[name] = Number(v);
    else if (type === 'BOOLEAN') out[name] = v.trim().toLowerCase() === 'true';
    else {
      try { out[name] = JSON.parse(v); } catch { out[name] = v; }
    }
  }
  return out;
}

/** The console's Run: the editor's query; a tool's query (unchanged in the editor) with the tool's checks (R3). */
async function consoleRun() {
  const tool = editorTool();
  if (tool) {
    /** @type {Record<string, string>} */
    const raw = {};
    for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('#console-params input'))) raw[input.dataset.name ?? ''] = input.value;
    const args = toolArgs(tool, raw);
    if (!args.ok) {
      const status = $('#console-status');
      status.className = 'hint error-text';
      status.dataset.code = 'refused';
      delete status.dataset.category;
      status.textContent = `Not run: ${args.problems.map((p) => p.message).join(' ')}`;
      return;
    }
    await consoleExec(tool.cypher, args.params, { strict: true });
    return;
  }
  await consoleExec($('#console-input').value, readParams());
}

/**
 * Run one query in the console and show it: the status line, the table, and NVL when the rows hold
 * graph elements. null when another console query is running.
 * @param {string} query @param {Record<string, any>} params @param {{strict?: boolean}} [opts]
 * @returns {Promise<any>}
 */
async function consoleExec(query, params, { strict = false } = {}) {
  if (state.consoleRunning) return null;
  state.consoleRunning = true;
  const status = $('#console-status');
  $('#console-run').disabled = true;
  status.className = 'hint';
  status.textContent = 'Running…';
  delete status.dataset.category;
  delete status.dataset.code;
  delete status.dataset.capped;
  try {
    const r = await busy(() => runConsole(query, params, { strict }));
    status.dataset.code = r.ok ? 'ok' : r.error?.code ?? 'error';
    if (!r.ok) {
      status.className = 'hint error-text';
      status.dataset.category = r.error?.category ?? '';
      status.textContent = `${r.error?.category ? `${r.error.category}: ` : ''}${r.error?.message ?? 'failed'}`;
      if (r.error?.code === 'watchdog') status.textContent += ' The store was taken back.';
      return r;
    }
    const d = r.data;
    status.dataset.rows = String(d.rows.length);
    // The status line counts every row the query returned; renderConsoleResult adds the graph cap's sentence,
    // from the graph it draws (the bookkeeping left out first, then capped: console.js consoleResult).
    const line = `${d.rows.length} row${d.rows.length === 1 ? '' : 's'} in ${d.ms} ms (lease ${r.leaseMs} ms, read-only handle).`;
    status.textContent = line;
    state.consoleResult = { columns: d.columns, rows: d.rows, ontologyIds: d.ontologyIds ?? null, status: line };
    renderConsoleResult();
    // The results come into view under the editor (the tab panel scrolls, not the page).
    ($('#console-graph-area').hidden ? $('#console-table') : $('#console-graph-area')).scrollIntoView({ block: 'nearest' });
    return r;
  } finally {
    state.consoleRunning = false;
    $('#console-run').disabled = false;
  }
}
/**
 * The console's last result in the table and NVL (console.js consoleResult). Every row shows by default;
 * with "Hide the example's bookkeeping" checked, a row whose top-level column is one of the extraction's own records
 * (a _Mention, _Sentence, _Claim ... node, an _OF, _HEAD ... relationship, or a path through one) is
 * left out, and inside lists and maps those values are dropped while the row stays; the ontology layer
 * (_Ontology, _Kind, _LinkType, _Alias and their relationships) and the entities show. NVL draws only
 * what the shown rows hold, capped after the filter, and the status line's cap sentence describes that
 * graph; the line beside the toggle says what was left out.
 */
function renderConsoleResult() {
  const d = state.consoleResult;
  const note = $('#console-hidden');
  if (!d) {
    note.textContent = '';
    return;
  }
  const v = consoleResult(d.rows, { hide: state.consoleHideBookkeeping, ontologyIds: d.ontologyIds });
  note.dataset.hidden = String(v.hidden);
  note.dataset.removed = String(v.removed);
  note.dataset.total = String(d.rows.length);
  note.textContent = hiddenNote(v);
  renderTable(d.columns, v.rows);
  const g = v.graph;
  const status = $('#console-status');
  if (status.dataset.code === 'ok' && d.status) {
    const cap = capNote(g);
    status.textContent = cap ? `${d.status} ${cap}` : d.status;
    if (g.capped) status.dataset.capped = `${g.nodes.length}/${g.total.nodes} ${g.rels.length}/${g.total.rels}`;
    else delete status.dataset.capped;
  }
  const area = $('#console-graph-area');
  if (g.nodes.length || g.rels.length) {
    area.hidden = false;
    const kinds = state.stats?.ontology.kinds.map((/** @type {any} */ k) => k.id) ?? [];
    consoleView.set(g, { labelOrder: kinds, colors: state.stats?.ontology.colors ?? {} });
    consoleView.show();
  } else {
    area.hidden = true;
    consoleView.clear();
  }
}
$('#console-hide-bookkeeping').checked = state.consoleHideBookkeeping;
$('#console-hide-bookkeeping').addEventListener('change', () => {
  state.consoleHideBookkeeping = $('#console-hide-bookkeeping').checked;
  local.set('consoleHideBookkeeping', state.consoleHideBookkeeping ? '1' : '0');
  renderConsoleResult();
});
$('#console-run').addEventListener('click', consoleRun);
$('#console-input').addEventListener('keydown', (/** @type {KeyboardEvent} */ ev) => {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); consoleRun(); }
});

/** @param {any} v */
function cell(v) {
  if (v === null || v === undefined) return h('span', { class: 'null', text: 'null' });
  if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && ('labels' in x || 'start_node' in x))) {
    return `path of ${v.filter((x) => 'start_node' in x).length} relationship(s)`;
  }
  if (v && typeof v === 'object' && Array.isArray(v.labels) && 'properties' in v) {
    const p = v.properties ?? {};
    return `(:${v.labels.join(':')} ${JSON.stringify(p.name ?? p.key ?? p.id ?? '')})`;
  }
  if (v && typeof v === 'object' && typeof v.type === 'string' && 'start_node' in v) return `[:${v.type}]`;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return JSON.stringify(v);
}

/** @param {string[]} columns @param {any[]} rows */
function renderTable(columns, rows) {
  const t = $('#console-table');
  t.replaceChildren();
  if (!columns?.length) return;
  t.append(h('thead', {}, h('tr', {}, ...columns.map((c) => h('th', { text: c })))));
  const body = h('tbody');
  for (const row of rows.slice(0, 1000)) body.append(h('tr', { 'data-testid': 'console-row' }, ...columns.map((c) => h('td', {}, cell(row[c])))));
  t.append(body);
  if (rows.length > 1000) t.append(h('caption', { text: `first 1000 of ${rows.length} rows` }));
}

// ---- the ontology's tools (Ontology Graph Spec v1 `tools`; README "The ontology's tools") ----------------

/** The index names SHOW INDEXES lists on any store this page made (harness/run.mjs checks them on all 27 samples' stores). */
const STORE_INDEX_NAMES = storeIndexNames(LOOKUP_INDEXES, [...STORE_CONSTRAINTS, ...ONTOLOGY_CONSTRAINTS, STORE_FULLTEXT]);
/** @type {Map<any, HTMLElement>} each tool's card in the console tab */
const toolCards = new Map();
/** What the tools' notes compare a query with: the open store's kinds (with what the model is asked) and links. */
const toolCtx = () => ({ kinds: state.stats?.ontology.kinds ?? [], links: state.stats?.ontology.links ?? [], procedures: state.procedures, indexes: STORE_INDEX_NAMES });
/** The element a tool sits on, as a label or a [:TYPE]. @param {any} t */
const anchorName = (t) => (t.anchor.kind === 'node' ? t.anchor.label : `[:${t.anchor.type}]`);
const CHIP = { rows: 'can return rows', empty: 'no rows here', error: 'errors here', 'error if reached': 'errors if reached', 'checked at run': 'checked at run', 'not run': 'not run here' };
/** @param {string} predict */
const chip = (predict) => h('span', { class: `tool-chip ${predict.replaceAll(' ', '-')}`, 'data-testid': 'tool-chip', text: CHIP[/** @type {keyof typeof CHIP} */ (predict)] ?? predict });

/**
 * The console tab's tools section for the open store's ontology (stats.ontology.tools), drawn once
 * per ontology (id and sha) so typed values survive a refresh; grouped by the element each tool sits
 * on, in document order.
 * @param {any} o  stats.ontology
 */
function renderTools(o) {
  const key = `${o.id}\u0000${o.sha}`;
  if (state.toolsKey === key) return;
  state.toolsKey = key;
  state.tools = Array.isArray(o.tools) ? o.tools : [];
  if (state.editorTool && !state.tools.includes(state.editorTool)) state.editorTool = null;
  toolCards.clear();
  const list = $('#tools-list');
  list.replaceChildren();
  $('#tools-count').textContent = `(${state.tools.length})`;
  $('#tools-box').dataset.count = String(state.tools.length);
  if (!state.tools.length) {
    $('#tools-about').textContent = `The ${o.title} document has no tools. An Ontology Graph Spec v1 document can give a node or a relationship tools (example queries for agents); create-context-graph's domains bring theirs.`;
    return;
  }
  $('#tools-about').textContent = `The example queries (tools) of the ${o.title} document, each on the element its query starts from. They were written for create-context-graph's ` +
    'full Neo4j graphs, while an extracted entity has only a name (and key, kind, display, docs), so each says what it can do here. ' +
    'Run checks the arguments first (a missing or empty one is refused, so a query never runs without a value it needs), then runs the query ' +
    'as any console query: through the read-only lease, with the 10 s watchdog.';
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const t of state.tools) {
    const k = `${t.anchor.kind}\u0000${anchorName(t)}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  for (const tools of groups.values()) {
    const t0 = tools[0];
    const sec = h('section', { class: 'tool-group', 'data-testid': 'tool-group', 'data-anchor': anchorName(t0) },
      h('h4', {}, anchorName(t0), ' ', h('small', { text: `${t0.anchor.kind}, ${tools.length} tool${tools.length === 1 ? '' : 's'}` })));
    for (const t of tools) {
      const card = toolCard(t);
      toolCards.set(t, card);
      sec.append(card);
    }
    list.append(sec);
  }
  if (state.procedures === null) ensureConsole().catch(() => {}); // the notes check procedures against SHOW PROCEDURES
}

/** Recompute every tool's note (SHOW PROCEDURES arrived, or the store's kinds changed). */
function refreshToolNotes() {
  for (const [t, card] of toolCards) {
    const note = toolCompat(t, toolCtx());
    card.dataset.predict = note.predict;
    const p = card.querySelector('[data-testid="tool-compat"]');
    if (p) p.textContent = note.text;
    card.querySelector('[data-testid="tool-chip"]')?.replaceWith(chip(note.predict));
  }
}

/** One tool's card. @param {any} t */
function toolCard(t) {
  const note = toolCompat(t, toolCtx());
  const card = h('details', { class: 'tool', 'data-testid': 'tool', 'data-tool': t.name, 'data-anchor': anchorName(t), 'data-predict': note.predict });
  card.append(h('summary', {}, h('code', { text: t.name }), h('span', { class: 'tool-type', text: t.type ?? '?' }), chip(note.predict),
    h('span', { class: 'tool-desc', text: t.description })));
  card.append(h('p', { class: 'hint', text: `On the ${t.anchor.kind} ${anchorName(t)} (${t.anchor.kind === 'node' ? 'nodes' : 'relationships'}/${t.anchor.key} in the document).` }));
  card.append(h('p', { class: 'tool-compat', 'data-testid': 'tool-compat', text: note.text }));
  if (t.type !== 'canonicalQuery' || typeof t.cypher !== 'string' || !t.cypher.trim()) {
    card.append(h('p', { class: 'hint', 'data-testid': 'tool-url', text: t.url ? `URL: ${t.url}` : 'No query and no URL.' }),
      h('p', { class: 'hint', text: 'Not run by this page: it makes no network calls (the site allows none but the model download), and it runs only canonicalQuery tools.' }));
    return card;
  }
  const status = h('span', { class: 'hint', 'data-testid': 'tool-status' });
  card.append(
    h('pre', { class: 'code tool-cypher', 'data-testid': 'tool-cypher', text: t.cypher.trim() }),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'small', 'data-testid': 'tool-copy', onclick: async () => {
        try {
          await navigator.clipboard.writeText(t.cypher.trim());
          status.textContent = 'Copied.';
        } catch {
          status.textContent = 'The clipboard is not available here: select the query to copy it.';
        }
      } }, 'Copy'),
      h('button', { type: 'button', class: 'small', 'data-testid': 'tool-load', onclick: () => loadTool(t, card) }, 'Load into editor')));
  const specs = toolParams(t);
  if (specs.length) {
    const grid = h('div', { class: 'params' });
    for (const sp of specs) grid.append(...toolParamField(sp));
    card.append(grid);
  } else card.append(h('p', { class: 'hint', text: 'No parameters.' }));
  card.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary small', 'data-testid': 'tool-run', onclick: () => runTool(t, card) }, 'Run'), status));
  return card;
}

/**
 * A parameter's label and input: name, type token, required marker, description, default, one_of.
 * The input starts at the default, else at the value the description suggests ("(default: 10)").
 * @param {ReturnType<typeof toolParams>[number]} sp
 */
function toolParamField(sp) {
  const initial = sp.default !== undefined ? (typeof sp.default === 'string' ? sp.default : JSON.stringify(sp.default)) : sp.hint ?? '';
  /** @type {HTMLInputElement|HTMLSelectElement} */
  let input;
  if (sp.oneOf || sp.type === 'BOOLEAN') {
    const options = sp.oneOf ? sp.oneOf.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))) : ['true', 'false'];
    input = h('select', {}, ...(sp.required ? [] : [h('option', { value: '', text: '' })]), ...options.map((v) => h('option', { value: v, text: v })));
    input.value = initial && options.includes(initial) ? initial : sp.required ? options[0] : '';
  } else if (sp.integer) input = h('input', { type: 'text', inputmode: 'numeric', value: initial, placeholder: `a whole number${sp.nonNegative ? ', 0 or more' : ''}` });
  else input = h('input', { type: 'text', value: initial, placeholder: sp.type });
  input.dataset.name = sp.name;
  input.dataset.initial = input.value;
  input.dataset.testid = `tool-param-${sp.name}`;
  input.setAttribute('aria-label', `$${sp.name} (${sp.type}${sp.required ? ', required' : ''})`);
  const help = [
    sp.description,
    sp.integer ? `a whole number${sp.nonNegative ? ' of 0 or more' : ''}: the query reads it through toInteger(), so the page refuses anything else and sends its digits as the STRING the tool declares` : '',
    sp.nonNegative && !sp.integer ? '0 or more: a LIMIT or SKIP count' : '',
    sp.default !== undefined ? `default ${JSON.stringify(sp.default)}` : '',
    sp.hint !== null && sp.default === undefined ? `${sp.hint} suggested by its description (not a default: clear it and the run is refused)` : '',
    sp.oneOf ? `one of ${sp.oneOf.map((v) => JSON.stringify(v)).join(', ')}` : '',
    sp.emptyOk ? "may be empty: the query tests it against '' itself" : '',
  ].filter(Boolean).join('; ');
  return [
    h('label', { title: sp.required ? 'required' : 'optional: empty takes the default' }, h('code', { text: `$${sp.name}` }), ' ', h('span', { class: 'tool-type', text: sp.integer ? `${sp.type} (whole number)` : sp.type }),
      sp.required ? h('span', { class: 'req', text: ' required' }) : null),
    h('div', {}, input, help ? h('div', { class: 'hint', text: help }) : null),
  ];
}

/** The text typed for each of a card's parameters. @param {HTMLElement} card @returns {Record<string, string>} */
function toolInputs(card) {
  /** @type {Record<string, string>} */
  const raw = {};
  for (const el of /** @type {NodeListOf<HTMLInputElement>} */ (card.querySelectorAll('[data-name]'))) raw[el.dataset.name ?? ''] = el.value;
  return raw;
}

/** Put a tool's query and its typed values into the console's editor (its checks then apply to the editor's Run). @param {any} t @param {HTMLElement} card */
function loadTool(t, card) {
  $('#saved-queries').value = '';
  $('#console-input').value = String(t.cypher).trim();
  state.editorTool = t;
  for (const [k, v] of Object.entries(toolInputs(card))) paramValues.set(k, v);
  $('#query-doc').textContent = toolDoc(t);
  renderParams();
}

/** The editor's line about a loaded tool: its name, element, description and note. @param {any} t */
function toolDoc(t) {
  const desc = String(t.description ?? '').trim();
  return `Tool ${t.name} on ${anchorName(t)}${desc ? `: ${desc}${/[.!?]$/.test(desc) ? '' : '.'}` : '.'} ${toolCompat(t, toolCtx()).text}`;
}

/**
 * Run a tool from its card: its arguments checked and typed first (toolArgs; nothing is sent when one
 * is missing, empty or mistyped, R3), then its query loaded into the editor and run as a console
 * query, strict. The card's status says what happened; the results show as any console query's.
 * @param {any} t @param {HTMLElement} card
 */
async function runTool(t, card) {
  const status = /** @type {HTMLElement} */ (card.querySelector('[data-testid="tool-status"]'));
  for (const k of ['code', 'rows', 'refused', 'category']) delete status.dataset[k];
  status.className = 'hint';
  const args = toolArgs(t, toolInputs(card));
  if (!args.ok) {
    status.className = 'hint error-text';
    status.dataset.code = 'refused';
    status.dataset.refused = args.problems.map((p) => p.name).join(',');
    status.textContent = `Not run: ${args.problems.map((p) => p.message).join(' ')}`;
    return;
  }
  loadTool(t, card);
  status.textContent = 'Running…';
  const r = await consoleExec(String(t.cypher), args.params, { strict: true });
  if (!r) {
    status.textContent = 'Another console query is running: try again when it is done.';
    status.dataset.code = 'busy';
    return;
  }
  status.dataset.code = r.ok ? 'ok' : r.error?.code ?? 'error';
  if (r.ok) {
    status.dataset.rows = String(r.data.rows.length);
    status.className = 'hint ok-text';
    status.textContent = `${r.data.rows.length} row${r.data.rows.length === 1 ? '' : 's'}, shown under the editor, above.`;
  } else {
    status.className = 'hint error-text';
    status.dataset.category = r.error?.category ?? '';
    status.textContent = `${r.error?.category ? `${r.error.category}: ` : ''}${String(r.error?.message ?? 'failed').split('\n')[0]}`;
  }
}

/**
 * The graph tab's side panel: the tools on a clicked entity's kind (or a relationship's type), each
 * with Run, prefilled with the entity's name where a parameter takes it (prefillPlan); Run opens the
 * console tab and runs it there, or opens the tool's card asking for its parameters.
 * @param {HTMLElement} side @param {import('./graphview.js').Selection} sel
 */
function sideTools(side, sel) {
  if (!state.tools.length) return;
  const kind = sel.kind === 'node' ? String(sel.properties?.kind ?? (sel.labels ?? []).find((l) => !l.startsWith('_')) ?? '') : '';
  const list = sel.kind === 'node'
    ? state.tools.filter((t) => t.anchor.kind === 'node' && t.anchor.label === kind)
    : state.tools.filter((t) => t.anchor.kind === 'relationship' && t.anchor.type === sel.type);
  const what = sel.kind === 'node' ? kind : `[:${sel.type}]`;
  // Nothing to offer, nothing shown (most relationship types have no tools).
  if (!list.length) return;
  const box = h('div', { class: 'side-tools', 'data-testid': 'side-tools', 'data-count': String(list.length) },
    h('h5', { text: `${what}'s tools in the ontology (${list.length})` }));
  const name = sel.kind === 'node' ? String(sel.properties?.name ?? '') : '';
  for (const t of list) {
    const runnable = t.type === 'canonicalQuery' && typeof t.cypher === 'string' && t.cypher.trim() !== '';
    // console.js prefillPlan: the entity's name goes only into a parameter that takes a name (never $limit or $id).
    // It runs when every parameter has a value (the name, a default, a suggested value, a first option): a tool
    // none of whose parameters takes the name then runs as one about the kind, at its start values. A parameter
    // with no value makes the button open the card and ask for it instead.
    const plan = prefillPlan(t, name, sel.kind === 'node' ? kind : undefined);
    const shownValues = Object.keys(plan.fill).length ? plan.fill : plan.values;
    const values = Object.entries(shownValues).map(([k, v]) => `$${k} = ${JSON.stringify(v)}`).join(', ');
    const label = plan.run ? (values ? `Run with ${values}` : 'Run') : `Open: fill ${plan.missing.map((x) => `$${x}`).join(', ')}`;
    box.append(h('div', { class: 'side-tool', 'data-testid': 'side-tool', 'data-tool': t.name },
      h('div', {}, h('code', { text: t.name }), ' ', chip(toolCompat(t, toolCtx()).predict)),
      h('div', { class: 'hint', text: t.description }),
      runnable
        ? h('button', { type: 'button', class: 'small', 'data-testid': 'side-tool-run', 'data-fill': JSON.stringify(plan.fill), 'data-run': plan.run ? '1' : '0',
          'data-kind-level': plan.kindLevel ? '1' : '0', title: plan.kindLevel && Object.keys(plan.values).length ? `No parameter takes the entity's name: it runs as a tool about ${what}, at these values.` : '',
          onclick: () => runToolFromSide(t, plan) }, label)
        : h('span', { class: 'hint', text: 'not run by this page' })));
  }
  side.append(box);
}

/**
 * The side panel's button: the console tab, the tool's card open, its inputs back at their start
 * (default, suggested value or empty) with the entity's name in the parameter that takes it, then Run;
 * or, when the plan does not run, the card asking for the parameters that have no value.
 * @param {any} t @param {ReturnType<typeof prefillPlan>} plan
 */
async function runToolFromSide(t, plan) {
  const card = toolCards.get(t);
  if (!card) return;
  showTab('console');
  $('#tools-box').open = true;
  /** @type {HTMLDetailsElement} */ (card).open = true;
  for (const el of /** @type {NodeListOf<HTMLInputElement>} */ (card.querySelectorAll('[data-name]'))) {
    const k = el.dataset.name ?? '';
    el.value = Object.hasOwn(plan.fill, k) ? plan.fill[k] : el.dataset.initial ?? '';
  }
  card.scrollIntoView({ block: 'nearest' });
  if (plan.run) {
    await runTool(t, card);
    return;
  }
  const status = /** @type {HTMLElement} */ (card.querySelector('[data-testid="tool-status"]'));
  for (const k of ['code', 'rows', 'refused', 'category']) delete status.dataset[k];
  status.className = 'hint';
  status.dataset.code = 'ask';
  const empty = plan.missing.map((x) => `$${x}`).join(', ');
  status.textContent = `Fill ${empty}, then Run: ${plan.missing.length === 1 ? 'it has' : 'they have'} no value` +
    `${plan.choice.param ? '' : ", and no parameter takes the entity's name"}.`;
  /** @type {HTMLElement|null} */ (card.querySelector(`[data-name="${CSS.escape(plan.missing[0] ?? '')}"]`))?.focus();
}

// ---- the store tab ----------------------------------------------------------------------------------

function renderStoreFacts() {
  const s = state.stats;
  const dl = $('#store-facts');
  dl.replaceChildren();
  if (!s) return;
  const add = (/** @type {string} */ k, /** @type {string} */ v, /** @type {string} */ id) => dl.append(h('dt', { text: k }), h('dd', { text: v, 'data-testid': id }));
  add('Store', `opfs://${s.name}`, 'fact-store');
  add('Ontology', `${s.ontology.title} (${s.ontology.id}, sha ${s.ontology.sha.slice(0, 12)})`, 'fact-ontology');
  add('Documents', String(s.documents.length), 'fact-documents');
  add('Cached inferences', `${s.inferences} (${s.inferredSentences} sentences read)`, 'fact-inferences');
  add('Typed graph', `${s.entities} entities, ${s.facts} relationships`, 'fact-graph');
  add('Verdicts', String(s.verdicts), 'fact-verdicts');
  add('Nodes by label', s.counts.labels.map((/** @type {any} */ x) => `${x.name} ${x.n}`).join(', '), 'fact-labels');
  add('Relationships by type', s.counts.types.map((/** @type {any} */ x) => `${x.name} ${x.n}`).join(', '), 'fact-types');
  add('WASM memory', `Relate ${s.memory.relateMiB} MiB, gliner-rs ${s.memory.glinerMiB} MiB (it never shrinks)`, 'fact-memory');
  const docs = $('#documents');
  // Documents titled the same (kept both) are told apart by their text's sha256 (the id).
  const seen = new Map();
  for (const d of s.documents) seen.set(d.title, (seen.get(d.title) ?? 0) + 1);
  const docName = (/** @type {any} */ d) => (seen.get(d.title) > 1 ? `${d.title} (text ${String(d.id).slice(0, 7)})` : d.title);
  docs.replaceChildren(...s.documents.map((/** @type {any} */ d) => {
    const forget = h('button', { type: 'button', class: 'small', 'data-testid': 'forget', text: 'Forget' });
    forget.addEventListener('click', () => forgetDoc(d.id, docName(d)));
    const stale = d.staleSentences
      ? h('span', { class: 'error-text', 'data-testid': 'document-stale', text: ` · ${d.staleSentences} sentence${d.staleSentences === 1 ? ' was' : 's were'} read under an earlier ` +
        'model schema (an earlier build of this page, or another version of the ontology): Forget it and extract it again to read it as this one asks ' })
      : '';
    return h('li', { 'data-testid': 'document', 'data-doc': d.id },
      `${docName(d)} · ${d.chars} characters · ${d.complete}/${d.sections} sections complete `, stale, forget);
  }));
  $('#native-commands').textContent = [
    `mkdir db && tar -xf ${s.name}.relate.tar -C db`,
    `relate --mode jsonl -d db 'MATCH (e:_Entity) RETURN e.kind AS kind, count(*) AS n'   # the 1.2.0 CLI; this first open adopts the directory`,
    `relate clone db ${s.name.replace(/^ex01-/, '')}.rl   # optional: a single-file bundle`,
  ].join('\n');
}

async function refreshStoreTab() {
  renderStoreFacts();
  await refreshStoreList();
  try {
    const est = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted?.();
    const dl = $('#store-facts');
    dl.append(h('dt', { text: 'This site\'s storage' }), h('dd', { 'data-testid': 'fact-usage', text: `${mb(est.usage ?? 0)} used of ${mb(est.quota ?? 0)}${persisted ? ', persistent' : ', not persistent (the browser may evict it)'}; shared by every example on this site` }));
  } catch { /* no estimate */ }
}

/** @param {string} id @param {string} title */
async function forgetDoc(id, title) {
  await busy(async () => {
    try {
      await call('forget', { doc: id, gate: state.gate });
      $('#store-op').textContent = `Forgot ${title}: its trace is gone; its cached inferences and verdicts stay.`;
      await refreshAll();
    } catch (e) {
      $('#store-op').textContent = message(e);
    }
  });
}

/** Save bytes or text as a file (a download). @param {BlobPart} data @param {string} name @param {string} type */
function save(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

$('#download-db').addEventListener('click', () => busy(async () => {
  const op = $('#store-op');
  op.textContent = 'Checkpointing and reading the store…';
  try {
    const r = await call('download');
    save(r.bytes, r.fileName, 'application/x-tar');
    op.textContent = `Downloaded ${r.fileName} (${mb(r.bytes.byteLength)}; a snapshot: graph.json and manifest.json, checkpoint ${r.summary.checkpoint_lsn}).`;
    op.dataset.file = r.fileName;
  } catch (e) {
    op.textContent = message(e);
    if (e instanceof EngineFailure && e.code === 'locked' && e.info?.released) {
      // Another tab took the store while this one read it (worker.js download): offer the handover.
      const name = e.info.name ?? state.store?.name;
      state.blocked = { args: { name }, name };
      $('#lock-text').textContent = `The store ${name} is open in another tab or window of this site, and a store has one owner at a time.`;
      $('#lock-banner').hidden = false;
    }
  }
}));

$('#download-dump').addEventListener('click', () => busy(async () => {
  const op = $('#store-op');
  try {
    const r = await call('dump');
    save(r.text, r.fileName, 'application/json');
    op.textContent = `Downloaded ${r.fileName} (lib/replay's format: load it natively with lib/replay.py).`;
    op.dataset.file = r.fileName;
  } catch (e) {
    op.textContent = message(e);
  }
}));

$('#restore-file').addEventListener('change', () => busy(async () => {
  const input = $('#restore-file');
  const f = /** @type {File|undefined} */ (input.files?.[0]);
  input.value = '';
  if (!f) return;
  const op = $('#store-op');
  const box = $('#restore-result');
  box.replaceChildren();
  op.textContent = `Checking ${f.name}…`;
  try {
    const bytes = await f.arrayBuffer();
    const r = await call('restore', { bytes, fileName: f.name }, [bytes]);
    const facts = h('dl', { class: 'facts', 'data-testid': 'restore-facts', 'data-name': r.name, 'data-digest': r.digest });
    const add = (/** @type {string} */ k, /** @type {string} */ v) => facts.append(h('dt', { text: k }), h('dd', { text: v }));
    add('Restored into', `opfs://${r.name}`);
    add('Input', `${r.summary.kind === 'raw' ? 'a raw OPFS store' : 'a directory database'}, ${r.summary.wal_frames} WAL frames, ${r.summary.ignored.length} dot entries skipped`);
    add('Ontology', r.ontology ? `${r.ontology.title || r.ontology.id} (${r.ontology.id})` : r.legacy ? 'written by an earlier build of this example' : 'none');
    add('Nodes by label', r.counts.labels.map((/** @type {any} */ x) => `${x.name} ${x.n}`).join(', ') || 'none');
    add('Graph type', r.spec);
    if (r.compare) {
      add(`Against ${r.compare.store}`, `counts ${r.compare.counts ? 'equal' : 'differ'}, graph type ${r.compare.spec ? 'equal' : 'differs'}, content digest ${r.compare.digest ? 'equal' : 'differs'}`);
      facts.dataset.compare = r.compare.counts && r.compare.spec && r.compare.digest ? 'equal' : 'differs';
    }
    box.append(facts);
    op.textContent = `Restored ${f.name} into ${r.name} and checked it read-only; switching to it.`;
    if (r.ontology) await openStore({ name: r.name });
    else if (r.legacy) {
      facts.dataset.legacy = '1';
      op.textContent = `${r.name} was written by an earlier build of this example (open it to empty it); it is listed, not opened.`;
    } else op.textContent = `${r.name} holds no ontology of this example; it is listed, not opened.`;
    await refreshStoreList();
  } catch (e) {
    op.textContent = message(e);
    op.className = 'hint error-text';
  }
}));

$('#reset').addEventListener('click', () => { $('#reset-confirm-row').hidden = false; });
$('#reset-cancel').addEventListener('click', () => { $('#reset-confirm-row').hidden = true; });
$('#reset-confirm').addEventListener('click', () => busy(async () => {
  $('#reset-confirm-row').hidden = true;
  try {
    const r = await call('reset');
    applyStore(r);
    $('#store-op').textContent = `${r.name} is empty again; its ontology and schema were applied anew.`;
    await refreshAll();
  } catch (e) {
    $('#store-op').textContent = message(e);
  }
}));

// ---- start-up, crashes ----------------------------------------------------------------------------

/** What this browser lacks for the page, in plain words (empty when nothing). */
function missingFeatures() {
  const miss = [];
  if (!window.isSecureContext) miss.push('a secure context (https or localhost)');
  if (typeof Worker !== 'function') miss.push('web workers');
  if (typeof WebAssembly !== 'object') miss.push('WebAssembly');
  if (!navigator.storage?.getDirectory) miss.push('the Origin Private File System (OPFS)');
  if (!crypto?.subtle) miss.push('WebCrypto');
  if (typeof caches === 'undefined') miss.push('Cache Storage');
  return miss;
}

/** @param {string} text */
function capability(text) {
  const el = $('#capability');
  el.textContent = text;
  el.hidden = !text;
}

/**
 * A new engine worker. With `open`, open-store goes out right behind init, so the worker opens that
 * store before anything else the page asks meanwhile (it runs jobs in arrival order); the worker
 * retries `storage locked` for 6 s (R11). `opened` settles to {ok, r} or {ok: false, e}.
 * state.engine is the new worker as soon as this is called (before its first await).
 * @param {{open?: string|null, phase?: 'starting'|'recycling'}} [opts]
 */
async function startEngine({ open = null, phase = 'starting', model = defaultsModel() } = {}) {
  state.engineReady = false;
  setBody({ engine: phase });
  // One engine worker at a time: whoever replaces it has ended it already; this is the safety net.
  if (state.engine && !state.engine.dead) state.engine.retire();
  const eng = new Engine(onEngineEvent, onEngineDeath);
  state.engine = eng;
  const init = eng.call('init');
  const opened = open
    ? eng.call('open-store', { name: open, cutoffs: {}, gate: state.gate, model, retryLocked: true })
      .then((r) => ({ ok: true, r, e: null }), (e) => ({ ok: false, r: null, e }))
    : null;
  const info = await init;
  if (!info.syncAccessHandle) {
    throw new EngineFailure({ code: 'capability', message: 'This browser has OPFS but not FileSystemFileHandle.createSyncAccessHandle in a worker, which Relate needs to keep a database. Use a current Chromium-based browser (Firefox is untested here; Safari is unknown).' });
  }
  state.engineReady = true;
  setBody({ engine: 'ready' });
  refreshStatus();
  return { info, opened };
}

/**
 * The crash banner. @param {string} text
 * @param {{retry?: boolean, reopened?: 'yes'|'no'|''}} [opts]  retry: offer "Try again" (reopen the store)
 */
function crashBanner(text, { retry = false, reopened = '' } = {}) {
  $('#crash-banner').hidden = !text;
  $('#crash-text').textContent = text;
  $('#crash-retry').hidden = !retry;
  $('#crash-banner').dataset.reopened = reopened;
}

/**
 * A worker died (a trap, R14, or a test's crash()). Only the current worker counts, and only when no
 * recycle or restart owns it: a replaced worker's death changes nothing, and a sequence that owns
 * its worker recovers from that worker's death itself (recycleEngine, restartEngine), so a crash
 * and a recycle never start engines side by side.
 * @param {string} reason @param {Engine} eng
 */
async function onEngineDeath(reason, eng) {
  if (eng !== state.engine || eng.owned) return;
  await recoverFromCrash(reason);
}

/**
 * The crash path: the banner, then a restart (at most three per page load).
 * @param {string} reason
 * @param {{store?: string|null, model?: string|null}} [what]  what to reopen and reload; by default
 *   the open (or lost) store and the loaded model
 */
async function recoverFromCrash(reason, what = {}) {
  setBody({ engine: 'crashed' });
  state.engineReady = false;
  crashBanner(`The engine stopped (${reason}). Restarting it: everything committed is kept.`);
  state.restarts++;
  if (state.restarts > 3) {
    crashBanner(`The engine stopped (${reason}). It crashed several times; reload the page. Everything committed is kept.`);
    return;
  }
  await restartEngine(what).catch((e) => crashBanner(`Restarting failed: ${message(e)}. Reload the page; everything committed is kept.`));
}

/**
 * Reopen a store into the running engine and show it; {ok, why}. The worker retries `storage locked`
 * for 6 s first: a worker ended inside a WASM call (a crash mid-section, a console query) holds the
 * store about 2 s (R11).
 * @param {Promise<{ok: boolean, r: any, e: any}>} opened
 */
async function settleReopen(opened) {
  const o = await opened;
  if (!o.ok) return { ok: false, why: message(o.e) };
  await showOpened(o.r);
  return { ok: true, why: '' };
}

/** Say what a restart or a retry left behind. @param {string|null} store @param {{ok: boolean, why: string}|null} reopen @param {string|null} model */
function reportRestart(store, reopen, model) {
  const modelText = model ? (state.model.loaded ? ', the model reloaded from the cache' : ', but the model did not load again (see the model panel)') : '';
  if (!store || reopen?.ok) {
    crashBanner(`The engine was restarted${store ? ` and ${store} reopened` : ''}${modelText}. Nothing committed was lost.`, { reopened: store ? 'yes' : '' });
    return;
  }
  state.lostStore = store;
  crashBanner(`The engine was restarted${modelText}, but ${store} could not be reopened: ${(reopen?.why ?? 'unknown').replace(/[.\s]*$/, '')}. ` +
    'Nothing committed was lost; try again in a moment.', { retry: true, reopened: 'no' });
}

/**
 * After a crash (or from a test): a new engine, the store reopened (or the banner says why not), the
 * model reloaded. It owns the new worker until it is done: if that one dies too, the restart
 * recovers through recoverFromCrash (which counts it) rather than onEngineDeath starting a second
 * engine beside it.
 * @param {{store?: string|null, model?: string|null}} [what]  default: the open (or lost) store and the loaded model
 */
async function restartEngine({ store = state.store?.name ?? state.lostStore, model = state.model.loaded?.which ?? null } = {}) {
  state.engine?.retire(); // a no-op after a crash; ends a live worker when a test calls this directly
  state.lostStore = store ?? null; // until it is reopened (showOpened clears it), the banner's retry knows it
  state.store = null;
  state.model.loaded = null;
  setBody({ model: 'none', store: '' });
  killConsole({ code: 'stopped', message: 'the engine restarted, so the console query was stopped' });
  const starting = startEngine({ open: store, model: model ?? state.model.which });
  const fresh = /** @type {Engine} */ (state.engine);
  fresh.owned = true;
  try {
    const { opened } = await starting;
    const reopen = opened ? await settleReopen(opened) : null;
    if (model && !fresh.dead) await loadModel(model, { auto: true });
    if (fresh.dead) throw new EngineFailure({ code: 'trap', message: fresh.reason });
    reportRestart(store, reopen, model);
    refreshStatus();
  } catch (e) {
    if (!fresh.dead) throw e;
    fresh.owned = false;
    await recoverFromCrash(fresh.reason, { store, model }); // the new worker died too
  } finally {
    fresh.owned = false;
  }
}

/** The crash banner's "Try again": reopen the store a restart could not. */
async function retryReopen() {
  const store = state.lostStore;
  if (!store) return;
  $('#crash-retry').disabled = true;
  try {
    if (!state.engine || state.engine.dead) {
      await restartEngine({ store });
      return;
    }
    let reopen;
    try {
      await openStore({ name: store }, { retryLocked: true, quiet: true });
      reopen = { ok: true, why: '' };
    } catch (e) {
      reopen = { ok: false, why: message(e) };
    }
    reportRestart(store, reopen, state.model.loaded?.which ?? null);
  } finally {
    $('#crash-retry').disabled = false;
  }
}
$('#crash-retry').addEventListener('click', () => { retryReopen(); });

/** How long the recycle waits for the old worker's close (its free() checkpoints the store, R12). */
const CLOSE_WAIT_MS = 30000;

/**
 * Recycle the engine worker (R13): WASM memory never shrinks, not even after free() or reset(),
 * so the page checkpoints the store (close = free(), the only checkpoint, R12), then ends
 * the worker. It waits until the worker is idle (no call in flight, no console lease, so its OPFS
 * lock goes at once, R11), closes the store, ends the worker and the console worker, and starts a
 * fresh engine that reopens the store from its checkpoint (committed data survives, R24) and
 * reloads the model from Cache Storage, hashed again. Without the close the fresh worker would
 * replay the whole WAL into memory on open and keep most of what the recycle gave back.
 * data-engine reads `recycling` meanwhile; console queries wait for it, and calls made while the
 * store closes go to the fresh worker. The recycle owns the old worker and then the fresh one: if
 * either dies meanwhile, it recovers as from a crash (recoverFromCrash), and onEngineDeath stays out.
 */
function recycleEngine() {
  if (state.recycling) return state.recycling;
  const old = state.engine;
  if (!old || old.dead || old.owned) return Promise.resolve(); // owned: a restart is replacing it already
  old.owned = true;
  state.recycling = busy(async () => {
    const store = state.store?.name ?? state.lostStore ?? null;
    const model = state.model.loaded?.which ?? null;
    state.engineReady = false;
    setBody({ engine: 'recycling' });
    refreshStatus();
    notice(`Recycling the engine after ${old.extractions} extraction${old.extractions === 1 ? '' : 's'}: WASM memory never shrinks, so the store is checkpointed and a fresh worker ` +
      `takes over${store ? `, reopens ${store}` : ''}${model ? ' and reloads the model from this browser\'s cache' : ''}. Nothing committed is lost.`);
    const t0 = performance.now();
    while ((old.pending.size || state.lease) && !old.dead && performance.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 50));
    if (!old.dead && !old.pending.size && !state.lease) {
      // free() is the only checkpoint (R12): the fresh worker then opens the checkpointed store
      // instead of replaying the whole WAL into memory.
      const closing = old.call('close');
      old.closing = true;
      /** @type {number} */
      let timer = 0;
      await Promise.race([closing.catch(() => {}), new Promise((r) => { timer = window.setTimeout(r, CLOSE_WAIT_MS); })]);
      clearTimeout(timer);
    }
    if (old.dead) {
      // It died while the recycle waited or closed: recover as from a crash (onEngineDeath left it to us).
      notice('');
      await recoverFromCrash(old.reason, { store, model });
      return;
    }
    old.retire();
    killConsole({ code: 'stopped', message: 'the engine was recycled, so the console query was stopped' });
    state.lostStore = store; // until the fresh worker reopens it (showOpened clears it): a restart or "Try again" knows it
    state.store = null;
    state.model.loaded = null;
    setBody({ store: '', model: model ? 'loading' : 'none' });
    const starting = startEngine({ open: store, phase: 'recycling', model: model ?? state.model.which });
    const fresh = /** @type {Engine} */ (state.engine);
    fresh.owned = true;
    try {
      const { opened } = await starting;
      const reopen = opened ? await settleReopen(opened) : null;
      if (model && !fresh.dead) await loadModel(model, { auto: true });
      if (fresh.dead) throw new EngineFailure({ code: 'trap', message: fresh.reason });
      state.recycles++;
      if (store && !reopen?.ok) {
        notice('');
        reportRestart(store, reopen, model);
      } else {
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        notice(`The engine was recycled to give back its memory in ${secs} s${store ? `: ${store} reopened` : ''}` +
          `${model ? (state.model.loaded ? ', the model reloaded from the cache' : ', but the model did not load again (see the model panel)') : ''}.`);
      }
    } catch (e) {
      notice('');
      if (fresh.dead) {
        // The fresh worker died while the recycle started it: recover as from a crash.
        fresh.owned = false;
        await recoverFromCrash(fresh.reason, { store, model });
        return;
      }
      // The extraction that asked for the recycle succeeded; the fresh engine did not start.
      setBody({ engine: 'failed' });
      crashBanner(`Recycling the engine failed: ${message(e).replace(/[.\s]*$/, '')}. Reload the page; everything committed is kept.`);
    } finally {
      fresh.owned = false;
    }
  }).finally(() => {
    state.recycling = null;
    refreshStatus();
  });
  return state.recycling;
}

async function main() {
  const miss = missingFeatures();
  if (miss.length) {
    capability(`This page needs ${miss.join(', ')}, which this browser does not offer here. It runs in current Chromium-based browsers.`);
    setBody({ engine: 'failed' });
    $('#status').textContent = 'Unsupported browser';
    return;
  }
  state.tab = local.get('tab') ?? 'graph';
  if (!TABS.includes(state.tab)) state.tab = 'graph';
  showTab(state.tab);
  renderEmptyState();
  updateExtractButton();
  const saved = local.get('model');
  if (saved && models.pinned() && models.MODELS[saved]) state.model.which = saved;
  try {
    await Promise.all([startEngine(), loadData()]);
  } catch (e) {
    setBody({ engine: 'failed' });
    capability(e instanceof EngineFailure && e.code === 'capability' ? e.message : `The page could not start: ${message(e)}`);
    $('#status').textContent = 'Could not start';
    return;
  }
  try {
    const est = await navigator.storage.estimate();
    if ((est.quota ?? 0) < 1e9) {
      notice(`This browser gives the site ${mb(est.quota ?? 0)} of storage; the model needs about 300 MB and the stores more. Loading may fail; caching surely will.`, 'warn');
    }
  } catch { /* no estimate */ }
  // Step 1's picker: each bundled ontology by its emoji and name (its description shows under the picker).
  for (const g of state.ontologyGroups) {
    const mine = state.ontologies.filter((x) => x.group === g.id);
    const group = h('optgroup', { label: `${g.label}'s ${mine.length} domains` });
    for (const o of mine) {
      const label = o.meta ? `${o.meta.emoji ? `${o.meta.emoji} ` : ''}${o.meta.name}` : `${o.title} (${o.id})`;
      group.append(h('option', { value: o.file, text: label, title: o.meta?.description ?? '' }));
    }
    $('#domain-select').append(group);
  }
  renderSavedQueries();
  renderParams();
  await renderModelChoices();
  const stores = await refreshStoreList();
  const last = local.get('store');
  const start = last && stores.some((s) => s.name === last && !s.empty) ? { name: last } : { yaml: defaultOntologyYaml() };
  // A remembered store that fails to open falls back to the default one, except when another tab
  // holds it (the lock banner offers the handover) or an earlier build wrote it (the earlier-build
  // banner offers to empty it): opening another store would hide that banner.
  await openStore(start).catch(async (e) => {
    const keepBanner = e instanceof EngineFailure && (e.code === 'locked' || (e.code === 'store' && (e.info.reason === 'legacy' || e.info.reason === 'legacy-ontology')));
    if (start.name && !keepBanner) await openStore({ yaml: defaultOntologyYaml() }).catch(() => {});
  });
  refreshStatus();
  if (models.pinned()) {
    try {
      if ((await models.cacheStatus(state.model.which)).all) await loadModel(state.model.which, { auto: true });
    } catch { /* not cached */ }
  }
}

const ready = main();

// @ts-ignore: the test hooks (harness/drive.mjs drives the page through them and the data-testid attributes)
window.ex01 = {
  state,
  ready,
  graphView,
  consoleView,
  ontologyView,
  currentDoc,
  /** @param {string} kind @param {Record<string, any>} [args] */
  call: (kind, args = {}) => call(kind, args),
  runConsole,
  refreshGraph,
  restartEngine,
  recycleEngine,
  loadModel,
  openStore,
  /** terminate the engine worker as a crash would (the crash tests, R24) */
  crash: () => engine().die('terminated by a test'),
};
