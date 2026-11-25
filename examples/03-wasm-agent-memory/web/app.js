// @ts-check
/**
 * app.js: the page. A conversation on the left, the agent's memory on the right.
 *
 * The page thread holds no data of its own: every tool call goes to the engine worker
 * (engine.worker.js, Relate 1.2.0 WASM), and each answer brings back the statements that ran and
 * the whole store, which is what gets drawn (graph.js, with NVL), listed ("What it knows") and logged
 * ("Under the hood"). The agent's turns come from agent.js: scripted ones from a scenario file,
 * typed ones from rules.
 *
 * URL parameters: ?scenario=team|trip|code, ?autoplay=1, ?test=1 (no animation, no pacing and no
 * model in the tab: what harness/drive.mjs uses), ?embed=off|live (the model in the tab, whatever
 * ?test says). window.ex03 is the same page for scripts: next(), playAll(), send(text, intent),
 * query(cypher), state().
 */
import { freeTurn, mergePaths, plan, scriptedTurn } from './agent.js';
import { MODEL, createEmbedder, precomputed } from './embed.js';
import { createGraph, kindGroup } from './graph.js';

const SCENARIOS = ['team', 'trip', 'code'];
const params = new URLSearchParams(location.search);
const TEST = params.get('test') === '1';
const ANIMATE = !TEST && !matchMedia('(prefers-reduced-motion: reduce)').matches;
const THEME_KEY = 'ex03.theme';

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @template {keyof HTMLElementTagNameMap} K @param {K} tag @param {string} [cls] @param {string} [text] */
const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const wait = (/** @type {number} */ ms) => (ANIMATE && ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many) => `${n} ${n === 1 ? one : many}`;

const state = {
  /** @type {Record<string, any>} */ scenarios: {},
  /** @type {any} */ scenario: null,
  /** @type {ReturnType<typeof plan>} */ steps: [],
  cursor: 0,
  clock: 0,
  playing: false,
  busy: false,
  unscripted: false,
  edited: false,
  /** @type {Map<string,string>} */ savedSuggestions: new Map(),
  /** @type {{nodes: any[], rels: any[]}} */ snapshot: { nodes: [], rels: [] },
  /** @type {any[]} */ paths: [],
  calls: 0,
  ledgerDirty: true,
  /** @type {any} */ last: null,
};
/** @type {ReturnType<typeof createGraph>} */ let graph;
/** @type {ReturnType<typeof createEmbedder>} */ let embedder;

// ---- the engine worker ---------------------------------------------------------------------------

/** @type {Worker} */ let worker;
let rpcId = 0;
/** @type {Map<number, {resolve: (v: any) => void, reject: (e: any) => void}>} */ const waiting = new Map();

function startWorker() {
  worker = new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const p = waiting.get(e.data.id);
    if (!p) return;
    waiting.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.result);
    else p.reject(Object.assign(new Error(e.data.error), { trap: e.data.trap }));
  };
  worker.onerror = (e) => {
    for (const p of waiting.values()) p.reject(new Error(e.message || 'the engine worker failed to load'));
    waiting.clear();
  };
}
/** @param {string} op @param {Record<string, any>} [payload] @returns {Promise<any>} */
function rpc(op, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, op, ...payload });
  });
}

// ---- the embedding model, for texts the scripts did not foresee -------------------------------------

/**
 * The model in the tab (embed.worker.js), started the first time it is needed. `status` is what the
 * page says under the input: idle, loading, ready or failed.
 */
const live = {
  /** @type {Worker|null} */ worker: null,
  /** @type {Promise<void>|null} */ loading: null,
  /** @type {'idle'|'loading'|'ready'|'failed'|'off'} */ status: 'idle',
  id: 0,
  /** @type {Map<number, {resolve: (v: any) => void, reject: (e: any) => void}>} */ waiting: new Map(),
};

/** @param {string} text */
function embedStatus(text) {
  const el = $('embed-status');
  el.textContent = text;
  el.hidden = !text;
  $('retry-model').hidden = live.status !== 'failed';
  document.body.dataset.embed = live.status;
}

/** Reject every request to this instance before allowing a fresh embedding worker. @param {Error} error */
function modelFailed(error) {
  live.worker?.terminate();
  live.worker = null;
  for (const request of live.waiting.values()) request.reject(error);
  live.waiting.clear();
  live.status = 'failed';
  embedStatus(`Model unavailable (${error.message}). New notes and questions use word search. Notes saved without a vector stay searchable by their words.`);
}

/** @param {string} op @param {Record<string, any>} [payload] @returns {Promise<any>} */
function embedRpc(op, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++live.id;
    live.waiting.set(id, { resolve, reject });
    try {
      if (!live.worker) {
        const instance = new Worker(new URL('./embed.worker.js', import.meta.url), { type: 'module' });
        live.worker = instance;
        instance.onmessage = ({ data }) => {
          if (instance !== live.worker) return;
          if (data.progress) {
            embedStatus(`Downloading the embedding model: ${Math.round(100 * data.progress.loaded / data.progress.total)}% of 23 MB.`);
          } else if (data.phase === 'initializing') {
            embedStatus('Model files ready. Initializing the embedding model…');
          } else {
            const request = live.waiting.get(data.id);
            if (!request) return;
            if (!data.ok) { modelFailed(new Error(data.error)); return; }
            live.waiting.delete(data.id);
            request.resolve(data.result);
          }
        };
        instance.onerror = (event) => {
          if (instance === live.worker) modelFailed(new Error(event.message || 'Embedding worker failed to load.'));
        };
        instance.onmessageerror = () => {
          if (instance === live.worker) modelFailed(new Error('Could not read the embedding worker response.'));
        };
      }
      live.worker.postMessage({ id, op, ...payload });
    } catch (error) {
      modelFailed(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function loadModel() {
  if (live.status === 'ready') return Promise.resolve();
  if (!live.loading) {
    live.status = 'loading';
    embedStatus('Checking the model cache. First download is 23 MB.');
    live.loading = embedRpc('load').then(() => {
      live.status = 'ready';
      embedStatus('Model ready. New text can be searched by meaning.');
    }).finally(() => { live.loading = null; });
  }
  return live.loading;
}

/** @param {string[]} texts */
async function liveEmbed(texts) {
  if (live.status === 'failed') throw new Error('Embedding model unavailable');
  await loadModel();
  const vectors = await embedRpc('embed', { texts });
  embedStatus(`Embedded in this tab with ${MODEL.id.split('/')[1]}.`);
  return vectors;
}

// ---- what every engine answer updates --------------------------------------------------------------

/** @param {{calls?: any[], snapshot?: any}} res */
function applyOp(res) {
  if (res.calls) logCalls(res.calls);
  if (!res.snapshot) return;
  state.snapshot = res.snapshot;
  graph.update(res.snapshot);
  state.ledgerDirty = true;
  if (!$('pane-ledger').hidden) renderLedger();
  renderCounts();
  if (!$('inspector').hidden && res.calls?.some((c) => c.write && !c.error)) {
    if (detail) renderSelectedMemory();
    else inspect(res.snapshot.nodes.find((n) => String(n.id) === $('inspector').dataset.node) ?? null);
  }
  $('empty').hidden = res.snapshot.nodes.some((/** @type {any} */ n) => n.label === 'Entity' || n.label === 'Memory');
}

function renderCounts() {
  const by = (/** @type {string} */ l) => state.snapshot.nodes.filter((n) => n.label === l);
  const mem = by('Memory');
  const old = mem.filter((m) => m.props.current === false).length;
  const el = $('counts');
  const summary = `${by('Entity').length} entities · ${mem.length} memories${old ? ` (${old} replaced)` : ''}`;
  el.title = `In the store: ${state.snapshot.nodes.length} nodes (${by('Message').length} of them messages, ${by('Session').length} sessions) and ${state.snapshot.rels.length} relationships`;
  if (el.textContent === summary) return;
  el.replaceChildren();
  const part = (/** @type {number} */ n, /** @type {string} */ label) => {
    const b = h('b', '', String(n));
    el.append(b, ` ${label}`);
  };
  part(by('Entity').length, 'entities · ');
  part(mem.length, `memories${old ? ` (${old} replaced)` : ''}`);
}

// ---- Cypher, lightly coloured --------------------------------------------------------------------

const TOKEN = /('(?:[^'\\]|\\.)*')|(\$[A-Za-z_][A-Za-z0-9_]*)|\b(MATCH|OPTIONAL|MERGE|CREATE|SET|WITH|WHERE|RETURN|UNWIND|CALL|UNION|ALL|ORDER|BY|LIMIT|AS|ON|AND|OR|NOT|IN|IS|NULL|SEARCH|SCORE|FOR|VECTOR|FULLTEXT|INDEX|ANY|SHORTEST|COLLECT|CASE|WHEN|THEN|ELSE|END|DESC|ASC|DISTINCT|ALTER|CURRENT|GRAPH|TYPE|CONSTRAINT|REQUIRE|UNIQUE|OPTIONS|EACH|DELETE|DETACH|REMOVE|SHOW|YIELD|EXPLAIN|PROFILE)\b/g;
/** @param {string} text */
function cypher(text) {
  const pre = h('pre');
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) pre.append(text.slice(last, m.index));
    pre.append(h('span', m[1] ? 'str' : m[2] ? 'par' : 'kw', m[0]));
    last = m.index + m[0].length;
  }
  pre.append(text.slice(last));
  return pre;
}
/** A statement with what went in and what came back. @param {any} c */
function statementBlock(c) {
  const box = h('div', 'stmt');
  box.append(cypher(c.statement));
  const counters = Object.entries(c.stats ?? {}).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ');
  const bits = [];
  if (Object.keys(c.params ?? {}).length) bits.push(`parameters ${JSON.stringify(c.params)}`);
  bits.push(c.error ? `refused: ${c.error}` : c.write ? (counters || 'nothing changed') : plural(c.rows, 'row', 'rows'));
  bits.push(`${c.ms < 10 ? c.ms.toFixed(1) : Math.round(c.ms)} ms`);
  box.append(h('div', 'stmt-meta', bits.join(' · ')));
  return box;
}

/** @param {any[]} calls */
function logCalls(calls) {
  const list = $('calls');
  for (const c of calls) {
    state.calls++;
    const li = h('li');
    const d = /** @type {HTMLDetailsElement} */ (h('details'));
    const s = h('summary');
    s.append(h('span', 'n', String(state.calls)), h('span', `t${c.write ? ' write' : ''}`, c.tool),
      h('span', 'first', c.statement.replace(/\s+/g, ' ').slice(0, 140)),
      h('span', 'meta', `${c.error ? 'refused' : c.write ? 'write' : plural(c.rows, 'row', 'rows')} · ${c.ms < 10 ? c.ms.toFixed(1) : Math.round(c.ms)} ms`));
    d.append(s, statementBlock(c));
    li.append(d);
    list.append(li);
  }
  $('calls-count').textContent = String(state.calls);
  $('calls-sub').textContent = `(${state.calls}, oldest first)`;
  list.scrollTop = list.scrollHeight;
}

// ---- the conversation ------------------------------------------------------------------------------

const transcript = () => $('transcript');
/** @param {HTMLElement} node */
function say(node) {
  transcript().append(node);
  transcript().scrollTop = transcript().scrollHeight;
  return node;
}

/** @param {string} title @param {string} note */
function divider(title, note) {
  const d = h('div', 'session');
  d.append(h('div', 'session-title', title), h('div', 'session-note', note));
  say(d);
}

/** A tool card's frame: name, one-line summary, rows, and the statements behind it. */
function card(/** @type {string} */ name, /** @type {boolean} */ write, /** @type {Array<Node|string>} */ summary, /** @type {any[]} */ calls) {
  const c = h('div', `tool${write ? ' write' : ''}`);
  c.dataset.tool = name;
  const head = h('div', 'tool-head');
  const sum = h('span', 'tool-sum');
  sum.append(...summary);
  head.append(h('span', 'tool-name', name), sum);
  const rows = /** @type {HTMLUListElement} */ (h('ul', 'tool-rows'));
  const det = h('details');
  det.append(h('summary', '', calls.length === 1 ? 'the statement Relate ran' : `the ${calls.length} statements Relate ran`), ...calls.map(statementBlock));
  c.append(head, rows, det);
  return { el: c, rows };
}
const b = (/** @type {string} */ t) => h('b', '', t);

/** Rows beyond `keep` fold behind a "show more". @param {HTMLUListElement} list @param {HTMLElement[]} items @param {number} keep */
function fold(list, items, keep) {
  items.forEach((li, i) => { if (i >= keep) li.hidden = true; list.append(li); });
  if (items.length <= keep) return;
  const more = h('li', 'more');
  const btn = h('button', '', `and ${items.length - keep} more`);
  btn.addEventListener('click', () => { for (const li of items) li.hidden = false; more.remove(); });
  more.append(btn);
  list.append(more);
}

/** Light one row's path (and the entities its memory is about) while the pointer is on it, then put the turn's highlight back. */
function hoverPath(/** @type {HTMLElement} */ li, /** @type {{nodes: number[], rels: number[], about?: Array<{node: number, rel: number}>}} */ row) {
  li.classList.add('hoverable');
  const hit = row.nodes[row.nodes.length - 1];
  const paths = [{ nodes: row.nodes, rels: row.rels, strong: true }, ...(row.about ?? []).map((a) => ({ nodes: [hit, a.node], rels: [a.rel], strong: true, after: 2 * (row.nodes.length - 1) }))];
  li.addEventListener('pointerenter', () => { if (paths.every(pathExists)) graph.highlight(paths); });
  li.addEventListener('pointerleave', () => graph.highlight(state.paths));
}

/** How a search hit was found, as its badge says it: "meaning 0.37", "words", or both. @param {any} r */
function foundBy(r) {
  const meaning = r.by.includes('meaning');
  return `${meaning ? `meaning ${Number(r.similarity).toFixed(2)}` : ''}${meaning && r.by.includes('words') ? ' + ' : ''}${r.by.includes('words') ? 'words' : ''}`;
}

/** @param {string} question @param {any[]} rows @param {any[]} calls @param {boolean} embedded  whether the question had a vector */
function recallCard(question, rows, calls, embedded) {
  const found = rows.filter((r) => r.via !== 'graph');
  const parts = [
    [found.filter((r) => r.by.includes('meaning')).length, 'by meaning'],
    [found.filter((r) => !r.by.includes('meaning')).length, 'by their words'],
    [rows.filter((r) => r.via === 'graph').length, 'through the graph'],
  ].filter(([k]) => k);
  const summary = rows.length
    ? [b(plural(rows.length, 'memory', 'memories')), `: ${parts.map(([k, t]) => `${k} ${t}`).join(', ')}`]
    : ['nothing in memory matched'];
  if (!embedded) summary.push(' (the question has no vector: words only)');
  const c = card('recall', false, summary, calls);
  fold(c.rows, rows.map((r) => {
    const li = h('li');
    li.dataset.memory = r.id;
    const what = h('span', 'what', r.text);
    if (r.via === 'graph') {
      const t = h('span', 'trail', 'through ');
      r.through.forEach((/** @type {string} */ name, /** @type {number} */ i) => t.append(i ? ', then ' : '', b(name)));
      what.append(t);
    } else if (r.via === 'update') what.append(h('span', 'trail', `the match was “${r.replaced[0]}”, since replaced`));
    const badge = h('span', `how ${r.via === 'graph' ? 'graph' : r.by.includes('meaning') ? 'meaning' : 'words'}`, r.via === 'graph' ? 'graph' : foundBy(r));
    badge.title = r.via === 'graph' ? 'reached through shared entities' : r.by.includes('meaning')
      ? `found by the vector search: cosine similarity ${Number(r.similarity).toFixed(2)} with the question${r.by.includes('words') ? ', and by the full-text search' : ''}`
      : 'found by the full-text search';
    li.append(badge, what, h('span', 'cited'));
    hoverPath(li, r);
    return li;
  }), 4);
  return c.el;
}

/** @param {any[]} entities @param {any[]} memories @param {any} counts @param {any[]} calls */
function rememberCard(entities, memories, counts, calls) {
  const about = [...new Set(memories.flatMap((m) => m.about))];
  /** @type {Array<Node|string>} */
  const summary = [b(plural(memories.length, 'memory', 'memories'))];
  if (about.length) summary.push(` about ${about.join(', ')}`);
  if (counts.superseded) summary.push(` · replaces ${plural(counts.superseded, 'older memory', 'older memories')}`);
  if (!memories.length) summary.splice(0, summary.length, 'the message, with nothing to keep from it');
  const c = card('remember', true, summary, calls);
  for (const m of memories) {
    const li = h('li');
    const what = h('span', 'what', m.text);
    if (m.rationale) what.append(h('span', 'why', `because ${m.rationale}`));
    li.append(h('span', `how k-${m.kind}`, m.kind), what, h('span'));
    c.rows.append(li);
  }
  return c.el;
}

/** @param {string} from @param {string} to @param {any} row @param {any[]} calls */
function connectCard(from, to, row, calls) {
  const c = card('connect', false, row
    ? [b(from), ' to ', b(to), `: ${plural(row.hops, 'memory', 'memories')} apart`]
    : [b(from), ' and ', b(to), ': no chain of current memories'], calls);
  if (row) {
    const li = h('li');
    const what = h('span', 'what trail');
    row.trail.forEach((/** @type {string} */ t, /** @type {number} */ i) => what.append(i ? ' → ' : '', i % 2 ? t : b(t)));
    li.append(h('span', 'how graph', 'path'), what, h('span'));
    hoverPath(li, row);
    c.rows.append(li);
  }
  return c.el;
}

/** @param {any[]} rows @param {any[]} calls */
function traceCard(rows, calls) {
  const c = card('trace', false, rows.length ? ['the source of ', b(`“${rows[0].text}”`)] : ['no such memory'], calls);
  rows.forEach((r, i) => {
    const li = h('li');
    const what = h('span', 'what');
    what.append(`“${r.said}”`, h('span', 'trail', `${r.session} · ${r.at.slice(0, 10)}${r.current ? '' : ` · said “${r.text}”, since replaced`}`));
    li.append(h('span', `how${i ? ' update' : ''}`, i ? 'earlier' : 'source'), what, h('span'));
    hoverPath(li, r);
    c.rows.append(li);
  });
  return c.el;
}

/** The tools agent.js calls: each asks the worker, redraws, and adds its card to the transcript. */
function makeTools() {
  /** @param {string} tool @param {any} args */
  const call = async (tool, args) => {
    const res = await rpc('tool', { tool, args });
    applyOp(res);
    return res;
  };
  return {
    embed: (/** @type {string[]} */ texts) => embedder.embed(texts),
    recall: async (/** @type {any} */ a) => {
      const res = await call('recall', a);
      say(recallCard(a.question, res.result, res.calls, !!a.vector));
      await wait(420);
      return res.result;
    },
    connect: async (/** @type {any} */ a) => {
      const res = await call('connect', a);
      say(connectCard(a.from, a.to, res.result, res.calls));
      await wait(420);
      return res.result;
    },
    trace: async (/** @type {any} */ a) => {
      const res = await call('trace', a);
      say(traceCard(res.result, res.calls));
      await wait(420);
      return res.result;
    },
    remember: async (/** @type {any} */ a) => {
      const res = await call('remember', a);
      say(rememberCard(a.entities, a.memories, res.result, res.calls));
      await wait(520);
      return res.result;
    },
    entitiesNamed: async (/** @type {string} */ text) => (await call('entitiesNamed', text)).result,
  };
}

/** What the highlight shows, in words. @param {any} res @param {boolean} scripted */
function captionFor(res, scripted) {
  const node = document.createDocumentFragment();
  const step = res.steps.find((/** @type {any} */ s) => s.tool !== 'remember');
  if (!step) return null;
  if (step.tool === 'recall') {
    if (!step.rows.length) return null;
    const strong = new Set(res.highlight.paths.filter((/** @type {any} */ p) => p.strong).map((/** @type {any} */ p) => p.id)).size;
    const which = scripted ? `the ${strong === 1 ? 'one' : strong} the reply used` : strong === 1 ? 'the best one' : `the best ${strong}`;
    node.append('Recalled ', b(plural(step.rows.length, 'memory', 'memories')), `. Bright: ${which}, ${strong === 1 ? '' : 'each '}with the path that reached it.`);
  } else if (step.tool === 'connect') {
    if (!step.row) return null;
    node.append('The shortest chain of current memories from ', b(step.from), ' to ', b(step.to), '.');
  } else if (step.tool === 'trace') {
    node.append('Where a memory came from: the memory, the message that said it, the session.');
  }
  return node;
}

/** The persistent highlight and its activation point survive transient pointer previews. */
let highlightOwner = '';
/** @type {{memoryId: string, origin: HTMLElement|null, paths: any[]}|null} */
let detail = null;

/** @param {any[]} paths @param {Node|null} caption @param {string} [owner] */
function showHighlight(paths, caption, owner = 'turn') {
  if (owner !== 'detail') {
    detail = null;
    inspect(null);
    graph.select(null);
  }
  highlightOwner = caption ? owner : '';
  state.paths = paths;
  $('caption').hidden = !caption;
  $('caption-text').replaceChildren(...(caption ? [caption] : []));
  if (paths.length) graph.highlight(paths);
  else graph.clearHighlight();
}

/** @param {string} owner */
function clearOwnedHighlight(owner) {
  if (owner === highlightOwner) showHighlight([], null);
}

/** A stored memory and its subjects, as paths to light. @param {any} memory */
function memoryPaths(memory) {
  const about = state.snapshot.rels.filter((r) => r.source === memory.id && r.type === 'ABOUT');
  return about.length ? about.map((r) => ({ nodes: [memory.id, r.target], rels: [r.id], strong: true })) : [{ nodes: [memory.id], rels: [], strong: true }];
}

/** A previous turn's path may have been changed by the console. @param {any} path */
function pathExists(path) {
  const { nodes, rels } = state.snapshot;
  return path.nodes.every((/** @type {number} */ id) => nodes.some((n) => n.id === id))
    && path.rels.every((/** @type {number} */ id, /** @type {number} */ i) => {
      const r = rels.find((r) => r.id === id);
      return r && ((r.source === path.nodes[i] && r.target === path.nodes[i + 1])
        || (r.target === path.nodes[i] && r.source === path.nodes[i + 1]));
    });
}

/** @param {string} id @param {HTMLElement|null} origin @param {any[]} [paths] */
function selectMemory(id, origin, paths = []) {
  detail = { memoryId: id, origin, paths };
  showTab('graph');
  renderSelectedMemory();
  const box = $('inspector');
  box.focus({ preventScroll: true });
  box.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}

/** Re-read the selected fact from the store, including source links edited in the console. */
function renderSelectedMemory() {
  if (!detail?.memoryId) return;
  const memory = state.snapshot.nodes.find((n) => n.label === 'Memory' && n.props.id === detail.memoryId);
  graph.select(memory?.id ?? null);
  if (!memory) {
    showHighlight([], document.createTextNode('This memory is no longer in the store.'), 'detail');
    inspect(null);
    const box = $('inspector');
    box.hidden = false;
    box.append(h('h3', '', 'Memory unavailable'), h('p', '', 'The source for this citation is no longer in the current store.'), returnButton());
    return;
  }
  const valid = detail.paths.length && detail.paths.every(pathExists);
  const paths = valid ? detail.paths.map((p) => ({ ...p, strong: true })) : memoryPaths(memory);
  showHighlight(paths, document.createTextNode(memory.props.text), 'detail');
  inspect(memory);
}

/** Keep a row's group as well as its fact ID: one fact may appear under several entities. */
function closeDetail() {
  const origin = detail?.origin;
  showHighlight([], null);
  if (origin?.classList.contains('mem')) {
    showTab('ledger');
    const rows = /** @type {NodeListOf<HTMLButtonElement>} */ ($('pane-ledger').querySelectorAll('button.mem'));
    const row = Array.from(rows).find((r) => r.dataset.memory === origin.dataset.memory && r.dataset.entity === origin.dataset.entity);
    (row ?? $('tab-ledger')).focus();
  } else if (origin?.isConnected) {
    origin.focus();
    origin.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  } else $('tab-graph').focus();
}

function returnButton() {
  const from = detail?.origin;
  const label = from?.classList.contains('mem') ? 'Return to fact' : from ? 'Return to reply' : 'Close details';
  const button = h('button', '', label);
  button.addEventListener('click', closeDetail);
  return button;
}

/** @param {any} res  a TurnResult */
function replyBubble(res) {
  const m = h('div', 'msg agent');
  m.append(h('span', 'from', state.scenario.agent));
  const pathsFor = (/** @type {string} */ id) => res.highlight.paths.filter((/** @type {any} */ path) => path.id === id);
  for (const p of res.reply.parts) {
    if (p.text !== undefined) { m.append(p.text); continue; }
    const cite = res.reply.cites.find((/** @type {any} */ c) => c.id === p.cite);
    const btn = h('button', `cite${cite?.text ? '' : ' missing'}`, String(p.n));
    btn.title = cite?.text ?? 'not returned by any tool';
    btn.disabled = !cite?.text;
    btn.dataset.memory = p.cite;
    btn.setAttribute('aria-label', `Source ${p.n}: ${btn.title}`);
    btn.addEventListener('click', () => selectMemory(p.cite, btn, pathsFor(p.cite)));
    m.append(btn);
  }
  if (res.reply.related?.length) {
    const more = h('details', 'related');
    const rows = h('ul');
    for (const r of res.reply.related) {
      const li = h('li');
      const button = h('button', '', r.text);
      button.addEventListener('click', () => selectMemory(r.id, button, pathsFor(r.id)));
      let found = foundBy(r);
      if (r.via === 'graph') found = `Graph path through ${r.through.join(' → ')}`;
      if (r.via === 'update') found = `Current replacement · ${found}`;
      li.append(button, h('small', '', [found, r.session].filter(Boolean).join(' · ')));
      rows.append(li);
    }
    more.append(h('summary', '', `Related context (${res.reply.related.length})`), rows);
    m.append(more);
  }
  return m;
}

/**
 * One turn, scripted or typed: the user's message, the tool cards as they happen, the reply, the
 * highlight. The caller holds the page busy (setBusy) for the whole turn.
 * @param {string} userText @param {(tools: any) => Promise<any>} run @param {boolean} scripted
 */
async function turn(userText, run, scripted) {
  showHighlight([], null);
  transcript().querySelector('.intro')?.remove();
  say(h('div', 'msg user', userText));
  await wait(380);
  const dots = h('div', 'thinking');
  dots.append(h('i'), h('i'), h('i'));
  say(dots);
  let res;
  try {
    res = await run(makeTools());
  } finally {
    dots.remove();
  }
  // mark the recalled rows the reply cites
  for (const c of res.reply.cites) {
    for (const li of transcript().querySelectorAll(`.tool:last-of-type li[data-memory="${CSS.escape(c.id)}"] .cited`)) {
      li.replaceChildren(h('span', 'cite', String(c.n)));
    }
  }
  say(replyBubble(res));
  showHighlight(res.highlight.paths, captionFor(res, scripted));
  state.last = res;
  return res;
}

/** Mark the page busy or free: one turn at a time. @param {boolean} on */
function setBusy(on) {
  state.busy = on;
  document.body.dataset.busy = on ? '1' : '0';
  refreshControls();
}

/** The next scripted turn. */
async function next() {
  if (state.busy || state.cursor >= state.steps.length) return null;
  setBusy(true);   // before the first await, so a second click cannot start a second turn
  try {
    const step = state.steps[state.cursor++];
    if (step.firstOfSession) {
      divider(step.session.title, step.sessionIndex === 0
        ? 'The agent starts with an empty memory.'
        : 'A new session: the agent’s context is empty again. Only its memory carries over.');
      showHighlight([], null);
      await wait(500);
    }
    const seq = ++state.clock;
    const context = state.edited ? {
      edited: true,
      visitorMemoryIds: visitorMemories(),
      hasMemories: state.snapshot.nodes.some((n) => n.label === 'Memory'),
    } : undefined;
    const res = await turn(step.user, (tools) => scriptedTurn(tools, { ...step, seq, messageId: `${state.scenario.id}-${seq}` }, context), true);
    document.body.dataset.cursor = String(state.cursor);
    return res;
  } finally {
    setBusy(false);
  }
}

/** Stable domain IDs of memories sourced from this scenario's visitor session. */
function visitorMemories() {
  const { nodes, rels } = state.snapshot;
  const session = nodes.find((n) => n.label === 'Session' && n.props.id === `${state.scenario.id}-you`);
  if (!session) return new Set();
  const messages = new Set(rels.filter((r) => r.type === 'IN_SESSION' && r.target === session.id).map((r) => r.source));
  const memories = new Set(rels.filter((r) => r.type === 'FROM' && messages.has(r.target)).map((r) => r.source));
  return new Set(nodes.filter((n) => memories.has(n.id)).map((n) => n.props.id));
}

function visitorTurn() {
  if (!state.unscripted) {
    state.unscripted = true;
    divider('Your turn', 'Ask reads the stored memories. Save note keeps your words and links the people or subjects it recognizes.');
  }
  const seq = ++state.clock;
  const at = TEST ? '2026-01-01T00:00:00Z' : new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return {
    session: { id: `${state.scenario.id}-you`, title: 'Your turn', startedAt: at },
    seq, at, messageId: `${state.scenario.id}-${seq}`, noteId: `note-${seq}`,
  };
}

/** @param {string} text @param {'ask'|'save'} intent */
async function send(text, intent = 'ask') {
  const t = text.trim();
  if (!t || state.busy || document.body.dataset.ready !== '1') return null;
  setBusy(true);
  pause();
  try {
    const ctx = visitorTurn();
    const hasMemories = state.snapshot.nodes.some((n) => n.label === 'Memory');
    const suggestion = state.scenario.try.find((item) => item.text === t && item.intent === intent);
    const suggestedMemoryId = suggestion?.requires && state.savedSuggestions.get(suggestion.requires);
    const res = await turn(t, (tools) => freeTurn(tools, t, { ...ctx, intent, hasMemories, suggestedMemoryId }), false);
    const written = res.steps.find((step) => step.tool === 'remember');
    if (written?.counts.memories) {
      state.edited = true;
      if (suggestion) state.savedSuggestions.set(suggestion.id, written.memories[0].id);
    }
    return res;
  } finally {
    setBusy(false);
  }
}

/** @param {string} targetId @param {string} text */
async function replaceMemory(targetId, text) {
  const body = text.trim();
  if (!body || state.busy || document.body.dataset.ready !== '1') return false;
  setBusy(true);
  pause();
  try {
    const ctx = visitorTurn();
    const [embedding] = await embedder.embed([body]);
    const res = await rpc('tool', { tool: 'correct', args: {
      targetId, session: ctx.session, message: { id: ctx.messageId, seq: ctx.seq, text: body, at: ctx.at },
      memory: { id: ctx.noteId, gist: body.split(/\s+/).slice(0, 4).join(' '), embedding },
    } });
    applyOp(res);
    if (res.result.status === 'stale') {
      say(h('p', 'tool', 'That memory changed before the replacement could be saved. Select its current version to try again.'));
      return false;
    }
    state.edited = true;
    say(h('div', 'msg user', body));
    const detail = card('correct', true, [b('Replaced the selected memory'), ' and kept its source history.'], res.calls);
    say(detail.el);
    return true;
  } finally {
    setBusy(false);
  }
}

let playbackGeneration = 0;
async function playAll() {
  if (state.playing || state.busy || state.cursor >= state.steps.length) return;
  const generation = ++playbackGeneration;
  state.playing = true;
  refreshControls();
  try {
    while (generation === playbackGeneration && state.cursor < state.steps.length) {
      const res = await next();
      if (!res || generation !== playbackGeneration) break;
      const words = res.reply.parts.reduce((/** @type {number} */ n, /** @type {any} */ p) => n + (p.text ? p.text.split(/\s+/).length : 0), 0);
      await wait(Math.min(5200, 1500 + words * 110));
    }
  } finally {
    if (generation === playbackGeneration) {
      state.playing = false;
      refreshControls();
    }
  }
}
function pause() {
  playbackGeneration++;
  state.playing = false;
  refreshControls();
}

function refreshControls() {
  const ready = document.body.dataset.ready === '1';
  const left = state.steps.length - state.cursor;
  const play = /** @type {HTMLButtonElement} */ ($('play'));
  play.disabled = !ready || left === 0 || (state.busy && !state.playing);
  play.hidden = left === 0 && state.steps.length > 0;
  play.classList.toggle('playing', state.playing);
  /** @type {HTMLElement} */ (play.querySelector('span')).textContent = state.playing ? 'Pause' : state.cursor ? 'Continue' : 'Play';
  /** @type {HTMLButtonElement} */ ($('restart')).disabled = !ready || state.busy || (state.clock === 0 && !state.edited);
  const nextBtn = /** @type {HTMLButtonElement} */ ($('next'));
  nextBtn.hidden = left === 0;
  nextBtn.disabled = !ready || state.busy || state.playing;
  if (left) $('next-text').textContent = state.steps[state.cursor].user;
  $('chips').hidden = left !== 0;
  for (const chip of $('chips').querySelectorAll('button')) {
    const requirement = chip.dataset.requires;
    const memoryId = requirement && state.savedSuggestions.get(requirement);
    const missing = requirement && !state.snapshot.nodes.some((n) => n.label === 'Memory' && n.props.id === memoryId && n.props.current);
    chip.disabled = !ready || state.busy || !!missing;
  }
  refreshConsoleSamples();
  /** @type {HTMLButtonElement} */ ($('save-note')).disabled = !ready || state.busy;
  /** @type {HTMLInputElement} */ ($('input')).disabled = !ready;
  /** @type {HTMLButtonElement} */ ($('send')).disabled = !ready || state.busy;
  /** @type {HTMLButtonElement} */ ($('run')).disabled = !ready || state.busy;
}

// ---- "What it knows": the same store as a list ---------------------------------------------------

function renderLedger() {
  state.ledgerDirty = false;
  const pane = $('pane-ledger');
  pane.replaceChildren();
  const { nodes, rels } = state.snapshot;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memories = nodes.filter((n) => n.label === 'Memory');
  if (!memories.length) {
    pane.append(h('p', 'ledger-note', 'Nothing yet. This tab lists what the agent currently believes, entity by entity, and what each belief replaced.'));
    return;
  }
  pane.append(h('p', 'ledger-note', 'The same store as the graph, read as a list: what the agent believes now about each entity, and what that replaced. Select a memory to inspect its source.'));
  const out = (/** @type {number} */ id, /** @type {string} */ type) => rels.filter((r) => r.source === id && r.type === type).map((r) => r.target);
  const replacedBy = new Map(rels.filter((r) => r.type === 'SUPERSEDES').map((r) => [r.target, byId.get(r.source)]));
  const sessionOf = (/** @type {any} */ m) => {
    const msg = out(m.id, 'FROM')[0];
    const s = msg === undefined ? undefined : out(msg, 'IN_SESSION')[0];
    return s === undefined ? '' : byId.get(s)?.props.title ?? '';
  };
  /** @param {any} m @param {string} entity */
  const row = (m, entity) => {
    const li = h('li');
    const button = h('button', `mem${m.props.current === false ? ' old' : ''}`);
    button.dataset.memory = m.props.id;
    button.dataset.entity = entity;

    const kind = h('span', 'mem-kind', m.props.kind);
    kind.style.setProperty('--c', `var(--${{ decision: 'brand', preference: 'second', note: 'ink' }[/** @type {string} */ (m.props.kind)] ?? 'muted'})`);
    const text = h('span');
    text.append(h('span', 'mem-text', m.props.text));
    const sub = [];
    if (m.props.rationale) sub.push(`because ${m.props.rationale}`);
    if (m.props.current === false) sub.push(`replaced by “${replacedBy.get(m.id)?.props.text ?? '?'}”`);
    sub.push(sessionOf(m));
    text.append(h('span', 'mem-sub', sub.filter(Boolean).join(' · ')));
    button.append(kind, text);
    button.addEventListener('click', () => selectMemory(m.props.id, button));
    li.append(button);
    return li;
  };
  const order = (/** @type {any} */ a, /** @type {any} */ c) => Number(c.props.current) - Number(a.props.current) || c.props.seq - a.props.seq || (a.props.id < c.props.id ? -1 : 1);
  const entities = nodes.filter((n) => n.label === 'Entity').map((e) => ({
    e, mems: rels.filter((r) => r.type === 'ABOUT' && r.target === e.id).map((r) => byId.get(r.source)).filter(Boolean).sort(order),
  })).filter((x) => x.mems.length).sort((a, c) => c.mems.filter((m) => m.props.current).length - a.mems.filter((m) => m.props.current).length || (a.e.props.name < c.e.props.name ? -1 : 1));
  for (const { e, mems } of entities) {
    const sec = h('section', 'ent');
    const name = h('div', 'ent-name');
    name.append(h('i', `sw e-${kindGroup(e.props.kind)}`), e.props.name);
    const left = h('div');
    left.append(name, h('span', 'ent-kind', e.props.kind));
    const ul = h('ul');
    ul.append(...mems.map((m) => row(m, e.props.key)));
    sec.append(left, ul);
    pane.append(sec);
  }
  const loose = memories.filter((m) => !rels.some((r) => r.source === m.id && r.type === 'ABOUT')).sort(order);
  if (loose.length) {
    const sec = h('section', 'ent');
    const left = h('div');
    left.append(h('div', 'ent-name', 'Not linked'), h('span', 'ent-kind', 'names no known entity'));
    const ul = h('ul');
    ul.append(...loose.map((m) => row(m, '')));
    sec.append(left, ul);
    pane.append(sec);
  }
}

// ---- the inspector: one node's details ------------------------------------------------------------

/** @param {{id: number, label: string, props: Record<string, any>}|null} n */
function inspect(n) {
  const box = $('inspector');
  box.replaceChildren();
  box.hidden = !n;
  if (!n) { delete box.dataset.node; return; }
  box.dataset.node = String(n.id);
  const { nodes, rels } = state.snapshot;
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const close = h('button', 'close', '×');
  close.title = 'Close details';
  close.setAttribute('aria-label', 'Close details');
  close.addEventListener('click', closeDetail);
  const dl = h('dl');
  const add = (/** @type {string} */ k, /** @type {string|undefined|null} */ v) => { if (v !== undefined && v !== null && v !== '') dl.append(h('dt', '', k), h('dd', '', String(v))); };
  const p = n.props;
  box.append(close, h('div', 'insp-kind', n.label === 'Entity' ? p.kind : n.label === 'Memory' ? `${p.kind} · ${p.current === false ? 'replaced' : 'current'}` : n.label.toLowerCase()));
  if (n.label === 'Entity') {
    box.append(h('h3', '', p.name));
    const mems = rels.filter((r) => r.type === 'ABOUT' && r.target === n.id).map((r) => byId.get(r.source)).filter((m) => m && m.props.current !== false);
    if (mems.length) {
      const ul = h('ul');
      for (const m of mems) ul.append(h('li', '', m.props.text));
      box.append(ul);
    }
  } else if (n.label === 'Memory') {
    box.append(h('h3', '', p.text));
    add('because', p.rationale);
    add('slot', p.slot);
    const msg = byId.get(rels.find((r) => r.type === 'FROM' && r.source === n.id)?.target);
    add('Original message', msg ? `“${msg.props.text}”` : 'The source message is no longer in the store.');
    const s = msg ? byId.get(rels.find((r) => r.type === 'IN_SESSION' && r.source === msg.id)?.target) : null;
    add('Session', s?.props.title ?? (msg ? 'Source session unavailable' : null));
    add('Recorded', msg?.props.at);
    for (const edge of rels.filter((r) => r.type === 'SUPERSEDES' && (r.source === n.id || r.target === n.id))) {
      const earlier = edge.source === n.id;
      const version = byId.get(earlier ? edge.target : edge.source);
      if (!version) continue;
      const field = h('dd');
      const button = h('button', 'version-link', version.props.text);
      button.addEventListener('click', () => selectMemory(version.props.id, detail?.origin ?? null));
      field.append(button);
      dl.append(h('dt', '', earlier ? 'Earlier version' : 'Replaced by'), field);
    }
    add('vector', p.embedded ? `${MODEL.dims} numbers from ${MODEL.id.split('/')[1]}, in the vector index` : 'none: only its words will find it');
    box.append(dl);
    const actions = h('div', 'detail-actions');
    if (p.current) addCorrectionForm(box, actions, p.id);
    if (detail?.origin) actions.append(returnButton());
    box.append(actions);
  } else if (n.label === 'Message') {
    box.append(h('h3', '', `“${p.text}”`));
    add('at', p.at);
    box.append(dl);
  } else {
    box.append(h('h3', '', p.title));
    add('started', p.startedAt);
    box.append(dl);
  }
}

/** @param {HTMLElement} box @param {HTMLElement} actions @param {string} id */
function addCorrectionForm(box, actions, id) {
  const edit = h('button', '', 'Replace this memory');
  edit.type = 'button';
  edit.addEventListener('click', () => {
    if (state.busy) return;
    edit.hidden = true;
    const form = h('form');
    const label = h('label', '', 'Replacement text');
    label.htmlFor = 'replacement-text';
    const text = h('textarea');
    text.id = label.htmlFor;
    text.required = true;
    const save = h('button', 'primary', 'Save replacement');
    save.type = 'submit';
    const cancel = h('button', '', 'Cancel');
    cancel.type = 'button';
    function cancelEdit() {
      form.remove();
      edit.hidden = false;
      edit.focus();
    }
    cancel.addEventListener('click', cancelEdit);
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); cancelEdit(); }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!text.value.trim() || state.busy || save.disabled) return;
      save.disabled = true;
      cancel.disabled = true;
      guard(replaceMemory(id, text.value.trim()).then((saved) => {
        if (saved && !box.hidden) box.focus();
      }).finally(() => { save.disabled = false; cancel.disabled = false; }));
    });
    form.append(label, text, save, cancel);
    box.insertBefore(form, actions);
    text.focus();
  });
  actions.append(edit);
}

// ---- under the hood: the console -----------------------------------------------------------------

/** @type {Array<[string, string, number?]>} */
const SAMPLES = [
  ['What is current, by entity', `MATCH (e:Entity)<-[:ABOUT]-(m:Memory)
WHERE m.current
RETURN e.name AS entity, collect(m.text) AS memories
ORDER BY entity`],
  ['What changed', `MATCH (now:Memory)-[:SUPERSEDES]->(was:Memory)
RETURN was.text AS was, now.text AS now, now.rationale AS because`],
  ['From a session to what it taught', `MATCH p = (s:Session)<-[:IN_SESSION]-(:Message)<-[:FROM]-(m:Memory)-[:ABOUT]->(:Entity)
RETURN p LIMIT 8`],
  ['A malformed memory (refused)', `CREATE (:Memory {id: 'oops', text: 'no kind'})`],
  ['An edge the shape forbids (refused)', `MATCH (a:Entity), (b:Entity) WHERE a <> b
WITH a, b LIMIT 1
CREATE (a)-[:ABOUT]->(b)`, 2],
];

/** The forbidden-edge example must actually match an entity pair to reach validation. */
function refreshConsoleSamples() {
  const entityCount = state.snapshot.nodes.filter((n) => n.label === 'Entity').length;
  let missing = false;
  for (const button of $('samples').querySelectorAll('button[data-min-entities]')) {
    const sample = /** @type {HTMLButtonElement} */ (button);
    sample.disabled = entityCount < Number(sample.dataset.minEntities);
    missing ||= sample.disabled;
  }
  $('sample-hint').hidden = !missing;
}

/** A value as a table cell shows it: vectors and long lists summarised. @param {any} v @returns {string} */
function cell(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return String(v);
  if (v.type && v.dim && Array.isArray(v.values)) return `<vector of ${v.dim}>`;
  if (v.kind === 'node') return `(:${v.labels.join(':')} ${cell(Object.fromEntries(Object.entries(v.properties).filter(([k]) => k !== 'embedding')))})`;
  if (v.kind === 'relationship') return `-[:${v.type}]->`;
  if (Array.isArray(v)) {
    if (v.length && v.every((x) => x && typeof x === 'object' && (x.kind === 'node' || x.kind === 'relationship'))) {
      return v.map((x) => (x.kind === 'node' ? `(${x.properties.name ?? x.properties.gist ?? x.properties.title ?? x.labels[0]})` : `-[:${x.type}]-`)).join('');
    }
    return `[${v.map(cell).join(', ')}]`;
  }
  return `{${Object.entries(v).map(([k, x]) => `${k}: ${cell(x)}`).join(', ')}}`;
}

/** The nodes and paths in a result, as paths to highlight. @param {any[]} rows */
function pathsIn(rows) {
  /** @type {any[]} */ const paths = [];
  const visit = (/** @type {any} */ v) => {
    if (!v || typeof v !== 'object') return;
    if (v.kind === 'node') paths.push({ nodes: [v.id], rels: [], strong: true });
    else if (v.kind === 'relationship') paths.push({ nodes: [v.start_node, v.end_node], rels: [v.id], strong: true });
    else if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && (x.kind === 'node' || x.kind === 'relationship'))) {
      paths.push({ nodes: v.filter((x) => x.kind === 'node').map((x) => x.id), rels: v.filter((x) => x.kind === 'relationship').map((x) => x.id), strong: true });
    } else for (const x of Array.isArray(v) ? v : Object.values(v)) visit(x);
  };
  for (const r of rows) visit(r);
  return paths;
}

/** Paginate the retained result. Paging never sends a query back to the database.
 * @param {HTMLElement} out @param {string[]} columns @param {any[]} rows */
function resultTable(out, columns, rows) {
  const size = 100;
  let offset = 0;
  const wrap = h('div', 'table-wrap');
  const table = document.createElement('table');
  table.className = 'rows';
  const head = table.createTHead().insertRow();
  for (const col of columns) head.append(h('th', '', col));
  const body = table.createTBody();
  const previous = document.createElement('button');
  previous.textContent = 'Previous page';
  const next = document.createElement('button');
  next.textContent = 'Next page';
  const range = h('span');
  range.setAttribute('role', 'status');
  const draw = () => {
    const end = Math.min(offset + size, rows.length);
    body.replaceChildren();
    for (const row of rows.slice(offset, end)) {
      const tr = body.insertRow();
      for (const col of columns) tr.insertCell().textContent = cell(row[col]);
    }
    range.textContent = `Showing ${offset + 1}–${end} of ${rows.length} rows`;
    previous.disabled = !offset;
    next.disabled = end === rows.length;
  };
  if (rows.length > size) {
    const pager = h('div', 'row');
    pager.append(previous, range, next);
    previous.addEventListener('click', () => { offset -= size; draw(); });
    next.addEventListener('click', () => { offset += size; draw(); });
    out.append(pager);
  }
  wrap.append(table);
  out.append(wrap);
  draw();
}

/** Run a statement from the console. @param {string} text */
async function query(text) {
  if (state.busy) return null;
  pause();
  setBusy(true);
  try {
    const out = $('result');
    const res = await rpc('query', { cypher: text });
    applyOp(res);
    clearOwnedHighlight('console');
    out.replaceChildren();
    if (res.error) {
      const box = h('div', 'result-error');
      box.append(h('pre', '', res.error));
      out.append(box);
      out.dataset.state = 'error';
      return res;
    }
    out.dataset.state = 'ok';
    const changed = Object.entries(res.stats ?? {}).filter(([, n]) => /** @type {number} */ (n) > 0).map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`);
    if (changed.length) state.edited = true;
    const meta = h('div', 'result-meta', `${plural(res.rows.length, 'row', 'rows')}${changed.length ? ` · ${changed.join(', ')}` : ''}`);
    const paths = pathsIn(res.rows);
    if (paths.length) {
      const btn = h('button', '', 'shown in the Memory tab');
      btn.addEventListener('click', () => showTab('graph'));
      meta.append(' · ', btn);
      const cap = document.createDocumentFragment();
      cap.append('Graph elements returned by your statement (all rows).');
      showHighlight(paths, cap, 'console');
    }
    out.append(meta);
    if (res.columns.length && res.rows.length) resultTable(out, res.columns, res.rows);
    return res;
  } finally {
    setBusy(false);
  }
}

// ---- tabs, theme, scenarios ----------------------------------------------------------------------

/** @param {string} name */
function showTab(name) {
  for (const t of $('tabs').querySelectorAll('.tab')) {
    const on = /** @type {HTMLElement} */ (t).dataset.pane === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
    /** @type {HTMLElement} */ (t).tabIndex = on ? 0 : -1;
  }
  for (const p of ['graph', 'ledger', 'hood']) $(`pane-${p}`).hidden = p !== name;
  if (name === 'ledger' && state.ledgerDirty) renderLedger();
}

function intro() {
  const box = h('div', 'intro');
  const p = h('p');
  p.append(b('A scripted agent, a real database.'), ' Follow the conversation or try your own question. Every ',
    b('remember'), ' and ', b('recall'), ' runs against the Relate database in this tab.');
  const ol = h('ol');
  for (const t of ['Send the messages one at a time, or press Play.', 'Open a cited fact to see the message it came from.', 'Use Ask to read memory or Save note to add your own words.']) ol.append(h('li', '', t));
  box.append(p, ol);
  return box;
}

/** Start a conversation from an empty store. @param {string} id */
async function openScenario(id, restart = false) {
  if (state.busy || (!restart && state.scenario?.id === id)) return;
  if (state.edited) {
    pause();
    setBusy(true);
    const dialog = /** @type {HTMLDialogElement} */ ($('discard-dialog'));
    dialog.returnValue = 'keep';
    $('discard-description').textContent = `Your edits in “${state.scenario.title}” will be cleared.`;
    $('discard-changes').textContent = restart ? 'Discard changes and restart' : 'Discard changes and switch';
    try {
      const closed = new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
      dialog.showModal();
      await closed;
    } finally {
      setBusy(false);
    }
    if (dialog.returnValue !== 'discard') return;
  }
  pause();
  const sc = state.scenarios[id];
  Object.assign(state, { scenario: sc, steps: plan(sc), cursor: 0, clock: 0, unscripted: false, edited: false, paths: [], calls: 0, last: null });
  state.savedSuggestions.clear();
  /** @type {HTMLInputElement} */ ($('input')).value = '';
  $('title').textContent = sc.title;
  $('blurb').textContent = sc.blurb;
  for (const el of $('scenarios').querySelectorAll('button')) {
    const active = el.dataset.id === id;
    el.classList.toggle('active', active);
    el.setAttribute('aria-pressed', String(active));
  }
  transcript().replaceChildren(intro());
  $('calls').replaceChildren();
  $('result').replaceChildren();
  $('chips').replaceChildren(...sc.try.map((item) => {
    const paired = sc.try.some((other) => other.requires === item.id);
    const prefix = item.requires ? '2. Ask' : paired ? '1. Save note' : 'Ask';
    const chip = h('button', '', `${prefix} · ${item.text}`);
    chip.dataset.suggestion = item.id;
    if (item.requires) {
      chip.dataset.requires = item.requires;
      chip.title = 'Save the suggested note first.';
    }
    chip.addEventListener('click', () => guard(send(item.text, item.intent)));
    return chip;
  }));
  showHighlight([], null);
  setBusy(true);   // no turn may start on the old store while the new one opens
  try {
    const res = await rpc('open');
    $('graphtype').textContent = res.graphType;
    applyOp(res);
  } finally {
    setBusy(false);
  }
  document.body.dataset.scenario = id;
  document.body.dataset.cursor = '0';
  const url = new URL(location.href);
  url.searchParams.set('scenario', id);
  history.replaceState(null, '', url);
  refreshControls();
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* storage is off */ }
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  $('theme').addEventListener('click', () => {
    const now = document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const to = now === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = to;
    try { localStorage.setItem(THEME_KEY, to); } catch { /* storage is off */ }
    graph?.retheme();
  });
  // with no choice made, the page follows the system, and so does the graph
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => graph?.retheme());
}

/** @param {string} message @param {boolean} [restartable] */
function fail(message, restartable = false) {
  const banner = $('banner');
  banner.replaceChildren(message);
  if (restartable) {
    const btn = h('button', '', 'Start again');
    btn.style.marginLeft = '12px';
    btn.addEventListener('click', () => location.reload());
    banner.append(btn);
  }
  banner.hidden = false;
  document.body.dataset.ready = 'failed';
  $('engine').textContent = 'stopped';
  state.busy = false;
  pause();
}

async function boot() {
  if (!ANIMATE) document.body.classList.add('still');
  initTheme();
  // the legend sits under the graph and wraps on a narrow screen: the graph's box ends where it starts
  const legendHeight = () => $('pane-graph').style.setProperty('--legend-h', `${$('legend').offsetHeight + 18}px`);
  legendHeight();
  new ResizeObserver(legendHeight).observe($('legend'));
  graph = createGraph($('graph'), { animate: ANIMATE, onSelect: (n) => {
    if (n?.label === 'Memory') { selectMemory(n.props.id, null); return; }
    clearOwnedHighlight('detail');
    graph.select(n?.id ?? null);
    inspect(n);
  } });
  // the panel changed size (the window, the legend wrapping): put the camera back on the graph
  new ResizeObserver(() => graph.refit()).observe($('graph'));
  startWorker();
  const { version } = await rpc('init');
  document.body.dataset.relate = version;
  $('engine').textContent = `Relate ${version} · running in this tab`;
  // the scripts' vectors come with the page; the model itself is started only for a text they lack.
  // ?test=1 keeps it off (the regression run is offline), ?embed=live turns it back on.
  const vectors = await fetch(new URL('data/embeddings.json', location.href));
  if (!vectors.ok) throw new Error(`data/embeddings.json: HTTP ${vectors.status}`);
  const liveOn = params.get('embed') === 'live' || (!TEST && params.get('embed') !== 'off');
  if (!liveOn) live.status = 'off';
  embedder = createEmbedder({ known: precomputed(await vectors.json()), live: liveOn ? liveEmbed : null });
  embedStatus(liveOn ? 'The first new text downloads a 23 MB embedding model. Your words stay in this tab.' : '');
  $('retry-model').addEventListener('click', () => {
    if (live.status === 'failed') void loadModel().catch(() => {}); // modelFailed already reports the fallback
  });
  for (const id of SCENARIOS) {
    const r = await fetch(new URL(`data/scenarios/${id}.json`, location.href));
    if (!r.ok) throw new Error(`data/scenarios/${id}.json: HTTP ${r.status}`);
    state.scenarios[id] = await r.json();
    const btn = h('button', '', state.scenarios[id].title);
    btn.dataset.id = id;
    btn.addEventListener('click', () => { if (!state.busy) guard(openScenario(id)); });
    $('scenarios').append(btn);
  }
  $('samples').replaceChildren(...SAMPLES.map(([label, text, minimum]) => {
    const s = h('button', '', label);
    if (minimum) {
      s.dataset.minEntities = String(minimum);
      s.setAttribute('aria-describedby', 'sample-hint');
    }
    s.addEventListener('click', () => { /** @type {HTMLTextAreaElement} */ ($('cypher')).value = text; });
    return s;
  }));
  /** @type {HTMLTextAreaElement} */ ($('cypher')).value = SAMPLES[0][1];

  $('next').addEventListener('click', () => guard(next()));
  $('play').addEventListener('click', () => (state.playing ? pause() : guard(playAll())));
  $('restart').addEventListener('click', () => { if (!state.busy) guard(openScenario(state.scenario.id, true)); });
  $('free').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = /** @type {HTMLInputElement} */ ($('input'));
    const text = input.value;
    if (!text.trim() || state.busy || document.body.dataset.ready !== '1') return;
    input.value = '';
    guard(send(text, e.submitter?.id === 'save-note' ? 'save' : 'ask'));
  });
  $('run').addEventListener('click', () => { if (!state.busy) guard(query(/** @type {HTMLTextAreaElement} */ ($('cypher')).value)); });
  $('cypher').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') $('run').click(); });
  $('tabs').addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target).closest('.tab');
    if (t) showTab(/** @type {HTMLElement} */ (t).dataset.pane ?? 'graph');
  });
  $('tabs').addEventListener('keydown', (e) => {
    const tabs = Array.from(/** @type {NodeListOf<HTMLButtonElement>} */ ($('tabs').querySelectorAll('.tab')));
    const i = tabs.indexOf(/** @type {HTMLButtonElement} */ (e.target));
    if (i < 0) return;
    let target;
    switch (e.key) {
      case 'ArrowLeft': target = tabs[(i + tabs.length - 1) % tabs.length]; break;
      case 'ArrowRight': target = tabs[(i + 1) % tabs.length]; break;
      case 'Home': target = tabs[0]; break;
      case 'End': target = tabs[tabs.length - 1]; break;
      default: return;
    }
    e.preventDefault();
    showTab(target.dataset.pane ?? 'graph');
    target.focus();
  });
  $('caption-clear').addEventListener('click', () => {
    if (detail) closeDetail(); else showHighlight([], null);
  });
  $('inspector').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeDetail(); }
  });
  $('provenance').addEventListener('change', (e) => graph.setProvenance(/** @type {HTMLInputElement} */ (e.target).checked));

  const wanted = params.get('scenario');
  await openScenario(wanted && SCENARIOS.includes(wanted) ? wanted : SCENARIOS[0]);
  document.body.dataset.ready = '1';
  refreshControls();
  if (params.get('autoplay') === '1') guard(playAll());
}

/** A promise whose failure stops the page with a message rather than vanishing. @param {Promise<any>} p */
function guard(p) {
  return p.catch((err) => {
    fail(err?.trap ? 'The engine stopped (a WebAssembly trap). The memory lived in this tab, so it is gone.' : `Something failed: ${err?.message ?? err}`, true);
    return null;
  });
}

/** The store by kind, as the graph should show it: what a script compares with graph.stats(). */
function storedCounts() {
  const { nodes, rels } = state.snapshot;
  const n = (/** @type {string} */ l) => nodes.filter((x) => x.label === l).length;
  const r = (/** @type {string} */ t) => rels.filter((x) => x.type === t).length;
  return {
    entities: n('Entity'), memories: n('Memory'), messages: n('Message'), sessions: n('Session'),
    superseded: nodes.filter((x) => x.label === 'Memory' && x.props.current === false).length,
    about: r('ABOUT'), supersedes: r('SUPERSEDES'), from: r('FROM'), inSession: r('IN_SESSION'),
  };
}

Object.assign(window, {
  ex03: {
    next, playAll, send, query,
    /** NVL's scale, pan and node positions. */
    view: () => graph.view(),
    /** What a script needs to see: the store, what NVL holds, and the paths that should be lit. */
    state: () => ({
      scenario: state.scenario?.id, cursor: state.cursor, steps: state.steps.length, calls: state.calls,
      store: { nodes: state.snapshot.nodes.length, rels: state.snapshot.rels.length },
      stored: storedCounts(),
      drawn: graph.stats(),
      lit: mergePaths(state.paths),
      embed: live.status,
      last: state.last,
    }),
  },
});

boot().catch((err) => fail(`The page could not start: ${err?.message ?? err}`));
