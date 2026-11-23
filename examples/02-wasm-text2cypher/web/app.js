// @ts-check
/**
 * app.js: example 02's page. The source app (FastAPI, OpenAI, Neo4j) ran its four endpoints on a
 * server; here each is a module in the tab (README, "From the server app to the page"):
 *   /api/ontology, /api/ontology/raw   the ontology, read with the Ontology Graph Spec SDK (lib/ogs.mjs
 *                                      and ontology.js): the browser, the JSON document, the checks
 *   /api/graph                         Relate 1.2.0 (WebAssembly) in engine.worker.js: the demo graph,
 *                                      under the ontology's graph type, drawn with NVL
 *   /api/ask                           the model (WebLLM in llm.worker.js, or the canned answers) writes
 *                                      two queries, ontology-grounded first, then the bare one; each is
 *                                      checked and run by run.js in the engine worker; compare.js says
 *                                      what the ontology changed
 *
 * Development URL parameters: ?llm=canned (canned answers only, as CI runs the page), ?model=<id>.
 * The page publishes its state on <body data-*> for harness/drive.mjs: data-ready (1 once the
 * graph is loaded), data-llm (none, loading, ready, canned, failed), data-busy.
 */
import yaml from 'js-yaml';
import * as sdk from '@neo4j/ontology-graph-spec';
import { createOgs, SPEC_VERSION, VALIDATION_SETS } from '../../../lib/ogs.mjs';
import { buildBriefing } from './briefing.js';
import { cannedCypher } from './canned.js';
import { compare } from './compare.js';
import { DEFAULT_MODEL, MODELS, appConfig, modelById, parseReply, repairRequest, request, webgpuStatus } from './llm.js';
import { legalRelationships, loadOntology, nodeLabel, queryExamples } from './ontology.js';
import { cellText } from './run.js';

const SDK_VERSION = '0.12.2';
const params = new URLSearchParams(location.search);
const FORCE_CANNED = params.get('llm') === 'canned';
const ogs = createOgs({ yaml, sdk, sdkVersion: SDK_VERSION });

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {unknown} s */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** @param {string} k @param {string} v */
const setState = (k, v) => { document.body.dataset[k] = v; };

const state = {
  /** @type {Record<string, any> | null} */ doc: null,
  /** @type {any} */ graph: null,
  /** @type {any} */ canned: null,
  /** @type {any} */ load: null,
  /** @type {any} */ engine: null,
  /** @type {string | null} */ modelId: null,
  gpu: /** @type {{ok: boolean, reason: string}} */ ({ ok: false, reason: 'not checked' }),
  briefing: { grounded: '', bare: '' },
};

// ---- the engine worker ----------------------------------------------------------------------------------

/** @type {Worker | null} */ let worker = null;
let nextId = 1;
/** @type {Map<number, {resolve: (v: any) => void, reject: (e: any) => void}>} */
const pending = new Map();

function startWorker() {
  worker = new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.result);
    else p.reject(Object.assign(new Error(e.data.error), { trap: e.data.trap }));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(`the engine worker failed: ${e.message}`));
    pending.clear();
  };
}

/** @param {string} op @param {object} [m] @returns {Promise<any>} */
function call(op, m = {}) {
  if (!worker) startWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    /** @type {Worker} */ (worker).postMessage({ id, op, ...m });
  });
}

/** A trapped engine (NOTES.md): a new worker, the graph loaded again. */
async function restartEngine() {
  worker?.terminate();
  worker = null;
  await call('init');
  state.load = await call('load', { doc: state.doc, graph: state.graph });
}

/** Run one query in the engine; a trap restarts it once. @param {string} cypher */
async function run(cypher) {
  try {
    return await call('run', { cypher });
  } catch (e) {
    if (!(/** @type {any} */ (e).trap)) throw e;
    await restartEngine();
    return call('run', { cypher });
  }
}

// ---- the ontology ------------------------------------------------------------------------------------------

/** The ontology as the source app's /api/ontology shaped it. @param {Record<string, any>} doc */
function ontologyView(doc) {
  const legal = legalRelationships(doc);
  const nodes = Object.entries(doc.nodes ?? {}).map(([id, n]) => {
    const ext = n.extensions ?? {};
    return {
      id, label: nodeLabel(n), description: n.description, aliases: n.aliases ?? [], reference: n.reference,
      colour: ext.display?.colour, indexes: Object.keys(ext.indexes ?? {}).sort(),
      constraints: Object.values(n.constraints ?? {}).map((/** @type {any} */ c) => ({ type: c.type, properties: c.properties, name: c.name })),
      properties: Object.entries(n.properties ?? {}).map(([pid, p]) => ({
        name: pid, type: p.type, flags: ['key', 'unique', 'must_exist'].filter((f) => p[f]), one_of: p.one_of, pattern: p.pattern,
        description: p.description, dimension: p.dimension,
      })),
    };
  });
  const relationships = Object.entries(doc.relationships ?? {}).map(([rid, r]) => {
    const pick = (/** @type {any} */ end) => Object.fromEntries(['count', 'min_count', 'max_count'].filter((k) => end?.[k] !== undefined).map((k) => [k, end[k]]));
    return {
      id: rid, type: legal[rid].type, from: legal[rid].from, to: legal[rid].to, description: r.description,
      cardinality: { from: pick(r.from), to: pick(r.to) },
      properties: Object.entries(r.properties ?? {}).map(([pid, p]) => ({ name: pid, type: p.type, description: p.description, one_of: p.one_of })),
    };
  });
  return { name: doc.name, version: doc.version, description: doc.description, nodes, relationships, cookbook: queryExamples(doc) };
}

/** @param {ReturnType<typeof ontologyView>} ont */
function renderOntology(ont) {
  let h = `<p class="desc">${esc(ont.description || '')}</p><h2>Nodes</h2>`;
  for (const n of ont.nodes) {
    const dot = n.colour ? `<span style="color:${esc(n.colour)}">●</span> ` : '';
    h += `<details><summary>${dot}:${esc(n.label)}</summary><div class="body">`;
    if (n.description) h += `<p class="desc">${esc(n.description)}</p>`;
    if (n.aliases?.length) h += `<div class="meta">aliases: ${n.aliases.map(esc).join(', ')}</div>`;
    if (n.reference) h += `<div class="meta">reference: <code>${esc(n.reference)}</code></div>`;
    h += `<table class="props">${n.properties.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.type)}${p.dimension ? `(${esc(p.dimension)})` : ''}` +
      `${p.flags.length ? ` <span class="flag">${p.flags.join(', ')}</span>` : ''}` +
      `${p.one_of ? `<br><span class="oneof">one of: ${p.one_of.map(esc).join(' / ')}</span>` : ''}` +
      `${p.pattern ? `<br><span class="oneof">pattern: ${esc(p.pattern)}</span>` : ''}` +
      `${p.description ? `<br><span class="pdesc">${esc(p.description)}</span>` : ''}</td></tr>`).join('')}</table>`;
    if (n.constraints.length) h += `<div class="meta">constraints: ${n.constraints.map((c) => `${esc(c.type)}(${c.properties.map(esc).join('+')})`).join('; ')}</div>`;
    if (n.indexes.length) h += `<div class="meta">indexes: ${n.indexes.map(esc).join(', ')}</div>`;
    h += '</div></details>';
  }
  h += '<h2>Relationships</h2>';
  for (const r of ont.relationships) {
    const card = [r.cardinality.from, r.cardinality.to].some((c) => Object.keys(c).length)
      ? `${esc(JSON.stringify(r.cardinality.from))} → ${esc(JSON.stringify(r.cardinality.to))}` : '';
    h += `<details><summary><span class="relend">(:${esc(r.from)}) -[:${esc(r.type)}]-> (:${esc(r.to)})</span></summary><div class="body">`;
    if (card) h += `<div class="meta">cardinality: ${card}</div>`;
    if (r.description) h += `<p class="desc">${esc(r.description)}</p>`;
    if (r.properties.length) {
      h += `<table class="props">${r.properties.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.type)}` +
        `${p.one_of ? `<br><span class="oneof">one of: ${p.one_of.map(esc).join(' / ')}</span>` : ''}` +
        `${p.description ? `<br><span class="pdesc">${esc(p.description)}</span>` : ''}</td></tr>`).join('')}</table>`;
    }
    h += '</div></details>';
  }
  if (ont.cookbook?.length) {
    h += '<h2>Query cookbook <span class="dim">(extensions.custom)</span></h2>';
    h += ont.cookbook.map((/** @type {any} */ e) => `<details><summary>${esc(e.question)}</summary><div class="body"><pre class="cypher">${esc(e.cypher.trim())}</pre></div></details>`).join('');
  }
  $('ontology').innerHTML = `<h2>Ontology: ${esc(ont.name)} v${esc(ont.version)}</h2>${h}`;
}

/** The SDK's verdict per validation set, the graph type Relate enforces, the DDL. @param {any} loaded */
function renderChecks(loaded) {
  const counts = loaded.counts;
  let h = `<p class="meta">Read with js-yaml, decoded and validated by the Ontology Graph Spec SDK (npm @neo4j/ontology-graph-spec ${esc(SDK_VERSION)}, spec ${esc(SPEC_VERSION)}).
    The page needs <b>decode</b> and <b>core</b> clean; the other sets are the SDK's stricter profiles, shown for information.</p>`;
  for (const set of ['decode', ...VALIDATION_SETS]) {
    const n = counts[set] ?? 0;
    h += `<div class="set"><b>${esc(set)}</b><span class="${n ? (set === 'decode' || set === 'core' ? 'note bad' : 'note') : 'note ok'}">${n ? `${n} issue${n === 1 ? '' : 's'}` : 'clean'}</span></div>`;
  }
  const byCode = new Map();
  for (const i of loaded.issues) byCode.set(`${i.set}: ${i.code}`, [...(byCode.get(`${i.set}: ${i.code}`) ?? []), i]);
  if (byCode.size) {
    h += '<details><summary>The issues</summary><div class="body">';
    for (const [k, list] of byCode) h += `<div class="meta"><b>${esc(k)}</b> × ${list.length}, e.g. ${esc(list[0].path)}: ${esc(list[0].message)}</div>`;
    h += '</div></details>';
  }
  if (state.load) {
    h += `<p class="meta">Applied to Relate: a graph type (endpoints and typed properties, engine-enforced on every write), ${state.load.constraints} constraints and ${state.load.indexes} indexes, then ${state.load.nodes} nodes and ${state.load.relationships} relationships.</p>`;
    h += `<details><summary>SHOW CURRENT GRAPH TYPE</summary><pre>${esc(state.load.graphType)}</pre></details>`;
  }
  $('checks').innerHTML = h;
}

// ---- the graph (NVL) ------------------------------------------------------------------------------------

/** @type {any} */ let NVLLIB = null;
/** @type {{nvl: any, handlers: any[]}} */ let NVL_STATE = { nvl: null, handlers: [] };
/** @type {any} */ let GRAPH_DATA = null;

async function nvlLib() {
  NVLLIB ??= await import('vendor:nvl');
  return NVLLIB;
}

/** @param {'data'|'onto'} kind */
async function showGraph(kind) {
  for (const h of NVL_STATE.handlers) h.destroy();
  NVL_STATE.nvl?.destroy();
  NVL_STATE = { nvl: null, handlers: [] };
  $('graph').innerHTML = '';
  $('detail').style.display = 'none';
  const lib = await nvlLib();
  /** @type {any[]} */ let nodes;
  /** @type {any[]} */ let rels;
  /** @type {(k: string, id: string) => void} */ let onSelect;
  if (kind === 'data') {
    GRAPH_DATA ??= await call('graph');
    const g = GRAPH_DATA;
    nodes = g.nodes.map((/** @type {any} */ n) => ({ id: String(n.id), captions: [{ value: n.label }], color: n.color, size: 26 }));
    rels = g.edges.map((/** @type {any} */ e, /** @type {number} */ i) => ({
      id: `r${i}`, from: String(e.from), to: String(e.to), type: e.type, captions: [{ value: e.type }],
      color: (e.props?.assertion ?? 'asserted') === 'asserted' ? '#6FBF73' : '#F79767', width: 2,
    }));
    const nd = Object.fromEntries(g.nodes.map((/** @type {any} */ n) => [String(n.id), n]));
    const rd = Object.fromEntries(g.edges.map((/** @type {any} */ e, /** @type {number} */ i) => [`r${i}`, e]));
    onSelect = (k, id) => showDetail(k, id, nd, rd);
  } else {
    const ont = ontologyView(/** @type {any} */ (state.doc));
    nodes = ont.nodes.map((n) => ({ id: n.label, captions: [{ value: n.label }], color: n.colour || '#4C8EDA', size: 30 }));
    rels = ont.relationships.map((r) => ({ id: r.id, from: r.from, to: r.to, type: r.type, captions: [{ value: r.type }], color: '#8fb8d8', width: 2 }));
    const nd = Object.fromEntries(ont.nodes.map((n) => [n.label, n]));
    const rd = Object.fromEntries(ont.relationships.map((r) => [r.id, r]));
    onSelect = (k, id) => showOntoDetail(k, id, nd, rd);
  }
  const nvl = new lib.NVL($('graph'), nodes, rels, { layout: 'forceDirected', disableTelemetry: true, disableWebWorkers: true, initialZoom: 1 });
  const hs = [
    new lib.ZoomInteraction(nvl), new lib.PanInteraction(nvl), new lib.DragNodeInteraction(nvl),
    new lib.HoverInteraction(nvl, { drawShadowOnHover: true }), new lib.ClickInteraction(nvl, { selectOnClick: true }),
  ];
  hs[4].updateCallback('onNodeClick', (/** @type {any} */ node) => onSelect('node', node.id));
  hs[4].updateCallback('onRelationshipClick', (/** @type {any} */ rel) => onSelect('rel', rel.id));
  hs[4].updateCallback('onCanvasClick', () => { $('detail').style.display = 'none'; });
  NVL_STATE = { nvl, handlers: hs };
  // Fit once the layout settles (fit([]) does nothing: pass the node ids).
  const settle = () => (nvl.isLayoutMoving() ? setTimeout(settle, 300) : nvl.fit(nvl.getNodes().map((/** @type {any} */ n) => n.id)));
  setTimeout(settle, 400);
}

/** @param {string} kind @param {string} id @param {any} nd @param {any} rd */
function showOntoDetail(kind, id, nd, rd) {
  const el = $('detail');
  el.style.display = 'block';
  if (kind === 'node') {
    const n = nd[id];
    el.innerHTML = `<b>:${esc(n.label)}</b>${n.aliases?.length ? ` <span class="dim">(${n.aliases.map(esc).join(', ')})</span>` : ''}` +
      `${n.description ? `<br><span class="ev">${esc(n.description)}</span>` : ''}`;
  } else {
    const r = rd[id];
    el.innerHTML = `<b>(:${esc(r.from)}) -[:${esc(r.type)}]-&gt; (:${esc(r.to)})</b>${r.description ? `<br><span class="ev">${esc(r.description)}</span>` : ''}`;
  }
}

/** @param {string} kind @param {string} id @param {any} nd @param {any} rd */
function showDetail(kind, id, nd, rd) {
  const el = $('detail');
  el.style.display = 'block';
  if (kind === 'node') {
    const n = nd[id];
    const rows = Object.entries(n.props || {}).map(([k, v]) => `<b>${esc(k)}</b>: ${esc(Array.isArray(v) ? v.join(', ') : v)}`).join(' &nbsp;·&nbsp; ');
    el.innerHTML = `<b>${esc(n.label)}</b> <span class="dim">:${esc(n.group)}</span><br> &nbsp;${rows}`;
  } else {
    const e = rd[id];
    const p = e.props || {};
    el.innerHTML = `<b>${esc(e.type)}</b> ` +
      `${p.assertion ? ` assertion=<b style="color:${p.assertion === 'asserted' ? '#6FBF73' : '#F79767'}">${esc(p.assertion)}</b>` : ''}` +
      `${p.supported != null ? ` supported=${esc(p.supported)}` : ''}${p.evidence ? `<br><span class="ev">"${esc(p.evidence)}"</span>` : ''}`;
  }
}

// ---- the model -------------------------------------------------------------------------------------------

function modeText() {
  const llm = state.engine && state.modelId && !useCanned() ? `${modelById(state.modelId).label.replace(/ \(.*/, '')} (WebGPU, in this tab)` : 'canned answers';
  return `ontology: ${state.doc?.name} v${state.doc?.version} · llm: ${llm} · store: Relate ${state.load ? '1.2.0 (WASM, in this tab)' : '…'}`;
}
const useCanned = () => FORCE_CANNED || !state.engine || /** @type {HTMLInputElement} */ ($('use-canned')).checked;
function refreshMode() {
  $('mode').textContent = modeText();
  setState('llm', state.engine && !useCanned() ? 'ready' : document.body.dataset.llm === 'loading' ? 'loading' : document.body.dataset.llm === 'failed' ? 'failed' : 'canned');
}

/** @param {number} frac @param {string} text */
function progress(frac, text) {
  const p = /** @type {HTMLElement} */ (document.querySelector('.progress'));
  p.hidden = false;
  /** @type {HTMLElement} */ (p.querySelector('.bar')).style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
  /** @type {HTMLElement} */ (p.querySelector('.ptext')).textContent = text;
}

async function setupModels() {
  const sel = /** @type {HTMLSelectElement} */ ($('model'));
  for (const m of MODELS) sel.append(new Option(`${m.label} · ${m.licence}`, m.id));
  const want = params.get('model');
  sel.value = want && MODELS.some((m) => m.id === want) ? want : DEFAULT_MODEL;
  if (FORCE_CANNED) {
    $('gpu').textContent = 'Canned answers only (?llm=canned): the model is not offered.';
    sel.disabled = true;
    /** @type {HTMLInputElement} */ ($('use-canned')).checked = true;
    /** @type {HTMLInputElement} */ ($('use-canned')).disabled = true;
    refreshMode();
    return;
  }
  state.gpu = await webgpuStatus(navigator);
  if (!state.gpu.ok) {
    $('gpu').className = 'note bad';
    $('gpu').textContent = `No usable WebGPU here (${state.gpu.reason}). The page answers with the source app's canned reference queries instead; ` +
      'everything else (the ontology checks, Relate, the comparison) runs as it would with a model. A current Chrome or Edge on desktop, Safari 26, or Firefox on Windows or macOS has WebGPU.';
    /** @type {HTMLInputElement} */ ($('use-canned')).checked = true;
    /** @type {HTMLInputElement} */ ($('use-canned')).disabled = true;
    sel.disabled = true;
    refreshMode();
    return;
  }
  $('gpu').className = 'note ok';
  $('gpu').textContent = `WebGPU is available${state.gpu.adapter ? ` (${state.gpu.adapter})` : ''}. Pick a model and load it: the weights download once from the Hugging Face Hub and stay in this site's cache.`;
  /** @type {HTMLButtonElement} */ ($('load-model')).disabled = false;
  const webllm = await import('@mlc-ai/web-llm');
  const cached = [];
  for (const m of MODELS) if (await webllm.hasModelInCache(m.id, appConfig()).catch(() => false)) cached.push(m.id);
  $('model-note').textContent = cached.length ? `Cached in this browser: ${cached.map((id) => modelById(id).label.replace(/ \(.*/, '')).join(', ')}.` : 'No model cached yet.';
  if (cached.includes(sel.value)) loadModel(sel.value);
  refreshMode();
}

/** @param {string} id */
async function loadModel(id) {
  const btn = /** @type {HTMLButtonElement} */ ($('load-model'));
  btn.disabled = true;
  setState('llm', 'loading');
  const m = modelById(id);
  try {
    const webllm = await import('@mlc-ai/web-llm');
    if (state.engine) { await state.engine.unload().catch(() => {}); state.engine = null; }
    try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
    const t0 = performance.now();
    const engine = await webllm.CreateWebWorkerMLCEngine(
      new Worker(new URL('./llm.worker.js', import.meta.url), { type: 'module' }),
      id,
      { appConfig: appConfig(), initProgressCallback: (/** @type {any} */ p) => progress(p.progress ?? 0, p.text ?? '') },
    );
    state.engine = engine;
    state.modelId = id;
    progress(1, `${m.label}: ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    $('model-note').textContent = `${m.label} is loaded (${m.licence}; weights ${m.repo}@${m.revision.slice(0, 7)}). Questions are answered by it; tick "canned answers" to compare with the reference queries.`;
  } catch (e) {
    setState('llm', 'failed');
    $('model-note').className = 'note bad';
    $('model-note').textContent = `The model did not load: ${String(/** @type {any} */ (e)?.message ?? e).split('\n')[0]}. The page uses the canned answers.`;
  } finally {
    btn.disabled = false;
    refreshMode();
  }
}

/** One generation. @param {any} body  a chat.completions request (llm.js request or repairRequest) */
async function complete(body) {
  const t0 = performance.now();
  const reply = await state.engine.chat.completions.create(body);
  const text = reply.choices?.[0]?.message?.content ?? '';
  return { text, cypher: parseReply(text), seconds: (performance.now() - t0) / 1000, tokens: reply.usage?.completion_tokens ?? null };
}

const repairOn = () => /** @type {HTMLInputElement} */ ($('repair')).checked;

/**
 * One variant written and run: the model's query, checked and run; with "repair once" on and the
 * query refused or failed, one more turn that tells the model what went wrong (llm.js repairRequest).
 * @param {string} briefing @param {string} question
 */
async function writeAndRun(briefing, question) {
  const g = await complete(request(briefing, question));
  let report = await run(g.cypher);
  let seconds = g.seconds;
  let repaired = null;
  const problem = report.issues.length ? report.issues.join('; ') : report.error;
  if (repairOn() && problem) {
    const r = await complete(repairRequest(briefing, question, g.text, problem));
    seconds += r.seconds;
    repaired = { first: report.cypher, problem };
    report = await run(r.cypher);
  }
  return { report, seconds, repaired };
}

/** @param {{seconds: number, repaired: any}} w */
const howWritten = (w) => `${w.seconds.toFixed(1)} s to write${w.repaired ? `; repaired once (the first query: ${w.repaired.problem})` : ''}`;

// ---- ask ---------------------------------------------------------------------------------------------------

/** @param {any} v */
function rowsTable(v) {
  if (!v.rows?.length) return `<p class="exec">${v.error ? '' : '0 rows'}</p>`;
  const cols = v.columns?.length ? v.columns : Object.keys(v.rows[0]);
  return `<table class="rows"><tr>${cols.map((/** @type {string} */ c) => `<th>${esc(c)}</th>`).join('')}</tr>${
    v.rows.map((/** @type {any} */ r) => `<tr>${cols.map((/** @type {string} */ c) => `<td>${esc(cellText(r[c]))}</td>`).join('')}</tr>`).join('')}</table>` +
    (v.truncated ? '<p class="exec">(the first 200 rows)</p>' : '');
}

/** @param {string} id @param {string} title @param {any} v @param {string} [how] */
function renderCard(id, title, v, how = '') {
  const verdict = v.issues?.length
    ? `<div class="verdict bad">✗ blocked by ontology validation: ${v.issues.map(esc).join('; ')}</div>`
    : '<div class="verdict ok">✓ read-only · labels/types known · endpoints legal</div>';
  const notes = (v.notes ?? []).map((/** @type {string} */ n) => `<div class="verdict warn">⚠ Relate: ${esc(n)}</div>`).join('');
  const err = v.error ? `<div class="verdict bad">✗ ${esc(v.error)}</div>` : '';
  const el = $(id);
  el.hidden = false;
  el.innerHTML = `<h3>${title}</h3><div class="cypher">${esc(v.cypher)}</div>${verdict}${notes}${err}` +
    `<div class="exec">${v.rows?.length ?? 0} row(s) · ${esc(v.execution || '')}${how ? ` · ${esc(how)}` : ''}</div>${rowsTable(v)}`;
}

/** @param {string} id @param {string} title @param {string} text */
function pendingCard(id, title, text) {
  $(id).innerHTML = `<h3>${title}</h3><p class="pending"><span class="spinner"></span>${esc(text)}</p>`;
}

const TITLE_WITHOUT = 'WITHOUT the ontology (schema introspection only)';
const TITLE_WITH = 'WITH the ontology (descriptions · vocab · cookbook)';

/**
 * One question answered, without the page: {mode, with, without, notes, generation}. The canned
 * answers when useCanned(), else the model, grounded query first (D3). harness/drive.mjs and
 * harness/llm-eval.mjs call it as window.ex02.answer.
 * @param {string} q
 * @param {{onGrounded?: (r: any, how: string) => void, onBareStart?: () => void}} [hooks]
 */
async function answer(q, hooks = {}) {
  if (useCanned()) {
    const c = cannedCypher(q, /** @type {any} */ (state.canned));
    const withO = await run(c.with);
    hooks.onGrounded?.(withO, 'canned reference query');
    hooks.onBareStart?.();
    const withoutO = await run(c.without);
    return { mode: 'canned', with: withO, without: withoutO, notes: compare(withO, withoutO), generation: null };
  }
  const g = await writeAndRun(state.briefing.grounded, q);
  hooks.onGrounded?.(g.report, howWritten(g));
  hooks.onBareStart?.();
  const b = await writeAndRun(state.briefing.bare, q);
  return { mode: /** @type {string} */ (state.modelId), with: g.report, without: b.report, notes: compare(g.report, b.report), generation: { grounded: g, bare: b } };
}

async function ask() {
  const q = /** @type {HTMLInputElement} */ ($('q')).value.trim();
  if (!q || document.body.dataset.busy === '1') return;
  const btn = /** @type {HTMLButtonElement} */ ($('go'));
  btn.disabled = true;
  setState('busy', '1');
  btn.innerHTML = '<span class="spinner"></span>Generating &amp; running…';
  $('ab').hidden = false;
  $('compare').hidden = true;
  try {
    const canned = useCanned();
    pendingCard('card-with', TITLE_WITH, canned ? 'running…' : 'the model is writing the query…');
    pendingCard('card-without', TITLE_WITHOUT, canned ? 'waiting…' : 'waiting for the grounded query first…');
    const res = await answer(q, {
      onGrounded: (r, how) => renderCard('card-with', TITLE_WITH, r, how),
      onBareStart: () => { if (!canned) pendingCard('card-without', TITLE_WITHOUT, 'the model is writing the query…'); },
    });
    const g = res.generation;
    renderCard('card-without', TITLE_WITHOUT, res.without, g ? howWritten(g.bare) : 'canned reference query');
    const cmp = $('compare');
    cmp.hidden = false;
    cmp.innerHTML = `<ul>${res.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
  } catch (e) {
    const cmp = $('compare');
    cmp.hidden = false;
    cmp.innerHTML = `<ul><li>failed: ${esc(String(/** @type {any} */ (e)?.message ?? e))}</li></ul>`;
  } finally {
    btn.disabled = false;
    setState('busy', '0');
    btn.textContent = 'Generate & run';
  }
}

async function runOwn() {
  const text = /** @type {HTMLTextAreaElement} */ ($('own-cypher')).value.trim();
  if (!text) return;
  const v = await run(text);
  renderCard('own-card', 'Your query', v);
}

// ---- boot ----------------------------------------------------------------------------------------------------

/** @param {string} path */
async function fetchText(path) {
  const r = await fetch(new URL(path, location.href));
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
}

async function boot() {
  const [ontText, graphText, cannedText] = await Promise.all([
    fetchText('data/corporate-events.ontology.yaml'), fetchText('data/demo-graph.json'), fetchText('data/canned.json'),
  ]);
  const loaded = loadOntology(ontText, { ogs });
  if (!loaded.ok) throw new Error(`the ontology does not pass the SDK's core checks: ${loaded.issues.filter((i) => i.set === 'decode' || i.set === 'core').map((i) => i.message).join('; ')}`);
  state.doc = loaded.doc;
  state.graph = JSON.parse(graphText);
  state.canned = JSON.parse(cannedText);
  state.briefing = { grounded: buildBriefing(state.doc), bare: buildBriefing(state.doc, { bare: true }) };
  $('prompt-grounded').textContent = state.briefing.grounded;
  $('prompt-bare').textContent = state.briefing.bare;
  renderOntology(ontologyView(state.doc));
  $('jsonview').textContent = JSON.stringify(state.doc, null, 2);

  for (const s of state.canned.suggested) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = s;
    c.onclick = () => { /** @type {HTMLInputElement} */ ($('q')).value = s; ask(); };
    $('chips').append(c);
  }
  $('onttabs').addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target).closest('.tab');
    if (!(t instanceof HTMLElement)) return;
    document.querySelectorAll('#onttabs .tab').forEach((x) => x.classList.toggle('active', x === t));
    $('ontology').hidden = t.dataset.o !== 'browser';
    $('jsonview').hidden = t.dataset.o !== 'json';
    $('checks').hidden = t.dataset.o !== 'checks';
  });
  $('graphtabs').addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target).closest('.tab');
    if (!(t instanceof HTMLElement)) return;
    document.querySelectorAll('#graphtabs .tab').forEach((x) => x.classList.toggle('active', x === t));
    showGraph(/** @type {'data'|'onto'} */ (t.dataset.g));
  });
  $('go').onclick = ask;
  $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
  $('own-run').onclick = runOwn;
  $('load-model').onclick = () => loadModel(/** @type {HTMLSelectElement} */ ($('model')).value);
  $('use-canned').addEventListener('change', refreshMode);

  const info = await call('init');
  state.load = await call('load', { doc: state.doc, graph: state.graph });
  renderChecks(loaded);
  refreshMode();
  /** @type {HTMLButtonElement} */ ($('go')).disabled = false;
  /** @type {HTMLButtonElement} */ ($('own-run')).disabled = false;
  setState('relate', info.version);
  /** @type {any} */ (window).ex02 = { answer, run, state, loadModel, useCanned };
  setState('ready', '1');
  showGraph('data');
  setupModels().catch((e) => { $('gpu').className = 'note bad'; $('gpu').textContent = `Model setup failed: ${e?.message ?? e}`; refreshMode(); });
}

boot().catch((e) => {
  const b = $('banner');
  b.hidden = false;
  b.textContent = `The page could not start: ${String(e?.message ?? e)}`;
  setState('ready', 'failed');
});
