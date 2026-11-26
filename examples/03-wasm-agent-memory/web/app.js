// @ts-check
/**
 * app.js: the page. A conversation on the left, the agent's memory on the right.
 *
 * The page thread holds no data of its own: every tool call goes to the engine worker
 * (engine.worker.js, Relate 1.2.0 WASM), and each answer brings back the statements that ran and
 * the whole store, which is what gets drawn (graph.js, with NVL), listed ("What it knows") and logged
 * ("Under the hood"). The agent's turns come from agent.js: scripted ones from a scenario file,
 * typed ones from rules. The Ontology tab (ontology-tab.js) shows the model the store keeps to, as
 * its document says it (data/agent-memory.ontology.json), and holds the store against it.
 *
 * URL parameters: ?scenario=team|trip|code, ?autoplay=1, ?test=1 (no animation, no pacing and no
 * model in the tab: what harness/drive.mjs uses), ?embed=off|live (the model in the tab, whatever
 * ?test says). window.ex03 is the same page for scripts: next(), playAll(), send(text),
 * query(cypher), state(), and ontology (the Ontology tab: show, find, select, check, ask, state).
 */
import { freeTurn, mergePaths, plan, scriptedTurn } from './agent.js';
import { MODEL, createEmbedder, precomputed } from './embed.js';
import { createGraph, kindGroup } from './graph.js';
import { createOntologyTab } from './ontology-tab.js';

const SCENARIOS = ['team', 'trip', 'code'];
const params = new URLSearchParams(location.search);
const TEST = params.get('test') === '1';
const ANIMATE = !TEST && !matchMedia('(prefers-reduced-motion: reduce)').matches;
const THEME_KEY = 'ex03.theme';

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} tag @param {string} [cls] @param {string} [text] */
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
  /** @type {{nodes: any[], rels: any[]}} */ snapshot: { nodes: [], rels: [] },
  /** @type {any[]} */ paths: [],
  calls: 0,
  ledgerDirty: true,
  /** @type {any} */ last: null,
};
/** @type {ReturnType<typeof createGraph>} */ let graph;
/** @type {ReturnType<typeof createEmbedder>} */ let embedder;
/** @type {ReturnType<typeof createOntologyTab>} */ let onto;

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
  /** @type {'idle'|'loading'|'ready'|'failed'|'off'} */ status: 'idle',
  id: 0,
  /** @type {Map<number, {resolve: (v: any) => void, reject: (e: any) => void}>} */ waiting: new Map(),
};

/** @param {string} text */
function embedStatus(text) {
  const el = $('embed-status');
  el.textContent = text;
  el.hidden = !text;
  document.body.dataset.embed = live.status;
}

/** @param {string} op @param {Record<string, any>} [payload] @returns {Promise<any>} */
function embedRpc(op, payload = {}) {
  if (!live.worker) {
    live.worker = new Worker(new URL('./embed.worker.js', import.meta.url), { type: 'module' });
    live.worker.onmessage = (e) => {
      if (e.data.progress) {
        embedStatus(`Fetching the embedding model, once: ${Math.round((100 * e.data.progress.loaded) / e.data.progress.total)}% of 23 MB`);
        return;
      }
      const p = live.waiting.get(e.data.id);
      if (!p) return;
      live.waiting.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result); else p.reject(new Error(e.data.error));
    };
    live.worker.onerror = (e) => {
      for (const p of live.waiting.values()) p.reject(new Error(e.message || 'the embedding worker failed to load'));
      live.waiting.clear();
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++live.id;
    live.waiting.set(id, { resolve, reject });
    /** @type {Worker} */ (live.worker).postMessage({ id, op, ...payload });
  });
}

/** Vectors for texts the page has none for, from the model in the tab. Throws when there is no model to be had. @param {string[]} texts */
async function liveEmbed(texts) {
  if (live.status === 'failed') throw new Error('no model');
  try {
    if (live.status !== 'ready') {
      live.status = 'loading';
      embedStatus('Starting the embedding model…');
      await embedRpc('load');
    }
    const vectors = await embedRpc('embed', { texts });
    live.status = 'ready';
    embedStatus(`Embedded in this tab with ${MODEL.id.split('/')[1]}: your text is compared by meaning, not only by its words.`);
    return vectors;
  } catch (err) {
    live.status = 'failed';
    embedStatus(`The embedding model could not be loaded (${/** @type {any} */ (err)?.message ?? err}). Your text is searched by its words only.`);
    throw err;
  }
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
  onto?.storeChanged();
  $('empty').classList.toggle('gone', res.snapshot.nodes.some((/** @type {any} */ n) => n.label === 'Entity' || n.label === 'Memory'));
}

function renderCounts() {
  const by = (/** @type {string} */ l) => state.snapshot.nodes.filter((n) => n.label === l);
  const mem = by('Memory');
  const old = mem.filter((m) => m.props.current === false).length;
  const el = $('counts');
  el.replaceChildren();
  const part = (/** @type {number} */ n, /** @type {string} */ label) => {
    const b = h('b', '', String(n));
    el.append(b, ` ${label}`);
  };
  part(by('Entity').length, 'entities · ');
  part(mem.length, `memories${old ? ` (${old} replaced)` : ''}`);
  el.title = `In the store: ${state.snapshot.nodes.length} nodes (${by('Message').length} of them messages, ${by('Session').length} sessions) and ${state.snapshot.rels.length} relationships`;
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
function card(/** @type {string} */ name, /** @type {boolean} */ write, /** @type {Node[]} */ summary, /** @type {any[]} */ calls) {
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
  li.addEventListener('pointerenter', () => graph.highlight(paths));
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

/** @param {any[]} paths @param {Node|null} caption */
function showHighlight(paths, caption) {
  state.paths = paths;
  if (!paths.length || !caption) {
    state.paths = [];
    $('caption').hidden = true;
    graph.clearHighlight();
    return;
  }
  $('caption-text').replaceChildren(caption);
  $('caption').hidden = false;
  graph.highlight(paths);
}

/** A stored memory and the entities it is about, as paths to light. @param {string} memoryId */
function memoryPaths(memoryId) {
  const m = state.snapshot.nodes.find((n) => n.label === 'Memory' && n.props.id === memoryId);
  if (!m) return [];
  const about = state.snapshot.rels.filter((r) => r.source === m.id && r.type === 'ABOUT');
  return about.length ? about.map((r) => ({ nodes: [m.id, r.target], rels: [r.id], strong: true })) : [{ nodes: [m.id], rels: [], strong: true }];
}

/** @param {any} res  a TurnResult */
function replyBubble(res) {
  const m = h('div', 'msg agent');
  m.append(h('span', 'from', state.scenario.agent));
  for (const p of res.reply.parts) {
    if (p.text !== undefined) { m.append(p.text); continue; }
    const cite = res.reply.cites.find((/** @type {any} */ c) => c.id === p.cite);
    const btn = h('button', `cite${cite?.text ? '' : ' missing'}`, String(p.n));
    btn.title = cite?.text ?? 'not returned by any tool';
    btn.dataset.memory = p.cite;
    btn.addEventListener('click', () => {
      // the path that reached this memory, when recall returned one; else the memory and what it is about
      const own = res.highlight.paths.filter((/** @type {any} */ x) => x.id === p.cite);
      const paths = own.length ? own.map((/** @type {any} */ x) => ({ ...x, strong: true })) : memoryPaths(p.cite);
      if (!paths.length) return;
      showTab('graph');
      graph.highlight(paths);
    });
    m.append(btn);
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
    const res = await turn(step.user, (tools) => scriptedTurn(tools, { ...step, seq, messageId: `${state.scenario.id}-${seq}` }), true);
    document.body.dataset.cursor = String(state.cursor);
    return res;
  } finally {
    setBusy(false);
  }
}

/** A turn the visitor typed. @param {string} text */
async function send(text) {
  const t = text.trim();
  if (!t || state.busy) return null;
  setBusy(true);
  try {
    pause();
    if (!state.unscripted) {
      state.unscripted = true;
      divider('Your turn · no script', 'From here rules pick the tool, and the reply is assembled from what it returns.');
    }
    const seq = ++state.clock;
    const now = TEST ? '2026-01-01T00:00:00Z' : new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    return await turn(t, (tools) => freeTurn(tools, t, {
      session: { id: `${state.scenario.id}-you`, title: 'Your turn', startedAt: now },
      seq, at: now, messageId: `${state.scenario.id}-${seq}`, noteId: `note-${seq}`,
    }), false);
  } finally {
    setBusy(false);
  }
}

async function playAll() {
  state.playing = true;
  refreshControls();
  while (state.playing && state.cursor < state.steps.length) {
    const res = await next();
    if (!res) break;
    const words = res.reply.parts.reduce((/** @type {number} */ n, /** @type {any} */ p) => n + (p.text ? p.text.split(/\s+/).length : 0), 0);
    await wait(Math.min(5200, 1500 + words * 110));
  }
  state.playing = false;
  refreshControls();
}
function pause() {
  state.playing = false;
  refreshControls();
}

function refreshControls() {
  const ready = document.body.dataset.ready === '1';
  const left = state.steps.length - state.cursor;
  const play = /** @type {HTMLButtonElement} */ ($('play'));
  play.disabled = !ready || left === 0;
  play.hidden = left === 0 && state.steps.length > 0;
  play.classList.toggle('playing', state.playing);
  /** @type {HTMLElement} */ (play.querySelector('span')).textContent = state.playing ? 'Pause' : state.cursor ? 'Continue' : 'Play';
  /** @type {HTMLButtonElement} */ ($('restart')).disabled = !ready || state.busy || state.clock === 0;
  const nextBtn = /** @type {HTMLButtonElement} */ ($('next'));
  nextBtn.hidden = left === 0;
  nextBtn.disabled = !ready || state.busy || state.playing;
  if (left) $('next-text').textContent = state.steps[state.cursor].user;
  $('chips').hidden = left !== 0;
  for (const el of $('chips').querySelectorAll('button')) /** @type {HTMLButtonElement} */ (el).disabled = !ready || state.busy;
  /** @type {HTMLInputElement} */ ($('input')).disabled = !ready;
  /** @type {HTMLButtonElement} */ ($('send')).disabled = !ready || state.busy;
  /** @type {HTMLButtonElement} */ ($('run')).disabled = !ready || state.busy;
  /** @type {HTMLButtonElement} */ ($('onto-check')).disabled = !ready || state.busy;
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
  pane.append(h('p', 'ledger-note', 'The same store as the graph, read as a list: what the agent believes now about each entity, and what that replaced. Click a memory to see it in the graph.'));
  const out = (/** @type {number} */ id, /** @type {string} */ type) => rels.filter((r) => r.source === id && r.type === type).map((r) => r.target);
  const replacedBy = new Map(rels.filter((r) => r.type === 'SUPERSEDES').map((r) => [r.target, byId.get(r.source)]));
  const sessionOf = (/** @type {any} */ m) => {
    const msg = out(m.id, 'FROM')[0];
    const s = msg === undefined ? undefined : out(msg, 'IN_SESSION')[0];
    return s === undefined ? '' : byId.get(s)?.props.title ?? '';
  };
  /** @param {any} m */
  const row = (m) => {
    const li = h('li', `mem${m.props.current === false ? ' old' : ''}`);
    li.dataset.memory = m.props.id;
    const kind = h('span', 'mem-kind', m.props.kind);
    kind.style.setProperty('--c', `var(--${{ decision: 'brand', preference: 'second', note: 'ink' }[/** @type {string} */ (m.props.kind)] ?? 'muted'})`);
    const text = h('span');
    text.append(h('span', 'mem-text', m.props.text));
    const sub = [];
    if (m.props.rationale) sub.push(`because ${m.props.rationale}`);
    if (m.props.current === false) sub.push(`replaced by “${replacedBy.get(m.id)?.props.text ?? '?'}”`);
    sub.push(sessionOf(m));
    text.append(h('span', 'mem-sub', sub.filter(Boolean).join(' · ')));
    li.append(kind, text);
    li.addEventListener('click', () => {
      showTab('graph');
      const cap = document.createDocumentFragment();
      cap.append('“', b(m.props.text), '” and the entities it is about.');
      showHighlight(memoryPaths(m.props.id), cap);
    });
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
    ul.append(...mems.map(row));
    sec.append(left, ul);
    pane.append(sec);
  }
  const loose = memories.filter((m) => !rels.some((r) => r.source === m.id && r.type === 'ABOUT')).sort(order);
  if (loose.length) {
    const sec = h('section', 'ent');
    const left = h('div');
    left.append(h('div', 'ent-name', 'Not linked'), h('span', 'ent-kind', 'names no known entity'));
    const ul = h('ul');
    ul.append(...loose.map(row));
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
  if (!n) return;
  const { nodes, rels } = state.snapshot;
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const close = h('button', 'close', '×');
  close.title = 'Close';
  close.addEventListener('click', () => graph.select(null));
  const dl = h('dl');
  const add = (/** @type {string} */ k, /** @type {string|undefined|null} */ v) => { if (v !== undefined && v !== null && v !== '') dl.append(h('dt', '', k), h('dd', '', String(v))); };
  const p = n.props;
  box.append(close, h('div', 'insp-kind', n.label === 'Entity' ? p.kind : n.label === 'Memory' ? `${p.kind}${p.current === false ? ' · replaced' : ''}` : n.label.toLowerCase()));
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
    add('from', msg ? `“${msg.props.text}”` : null);
    const s = msg ? byId.get(rels.find((r) => r.type === 'IN_SESSION' && r.source === msg.id)?.target) : null;
    add('session', s?.props.title);
    add('replaced', byId.get(rels.find((r) => r.type === 'SUPERSEDES' && r.source === n.id)?.target)?.props.text);
    add('replaced by', byId.get(rels.find((r) => r.type === 'SUPERSEDES' && r.target === n.id)?.source)?.props.text);
    add('vector', p.embedded ? `${MODEL.dims} numbers from ${MODEL.id.split('/')[1]}, in the vector index` : 'none: only its words will find it');
    box.append(dl);
  } else if (n.label === 'Message') {
    box.append(h('h3', '', `“${p.text}”`));
    add('at', p.at);
    box.append(dl);
  } else {
    box.append(h('h3', '', p.title));
    add('started', p.startedAt);
    box.append(dl);
  }
  const key = onto?.keyOf(n.label);
  if (key) {
    const model = h('button', 'onto-link insp-model', `what the model says of a ${n.label}`);
    model.dataset.testid = 'insp-model';
    model.addEventListener('click', () => { showTab('ontology'); onto.select(key); });
    box.append(model);
  }
}

// ---- under the hood: the console -----------------------------------------------------------------

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
CREATE (a)-[:ABOUT]->(b)`],
  ['A write the engine allows and the model forbids', `MATCH (m:Memory) WHERE NOT m.current
SET m.current = true`],
];

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

/** Run a statement from the console. @param {string} text */
async function query(text) {
  const out = $('result');
  const res = await rpc('query', { cypher: text });
  applyOp(res);
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
  const meta = h('div', 'result-meta', `${plural(res.rows.length, 'row', 'rows')}${changed.length ? ` · ${changed.join(', ')}` : ''}`);
  const paths = pathsIn(res.rows);
  if (paths.length) {
    const btn = h('button', '', 'shown in the Memory tab');
    btn.addEventListener('click', () => showTab('graph'));
    meta.append(' · ', btn);
    const cap = document.createDocumentFragment();
    cap.append('What your statement returned.');
    showHighlight(paths, cap);
  }
  out.append(meta);
  if (res.columns.length && res.rows.length) out.append(resultTable(res.columns, res.rows));
  return res;
}

/** Rows as a table, the first hundred. @param {string[]} columns @param {any[]} rows */
function resultTable(columns, rows) {
  const wrap = h('div', 'table-wrap');
  const table = h('table', 'rows');
  const head = h('tr');
  for (const c of columns) head.append(h('th', '', c));
  table.append(head);
  for (const r of rows.slice(0, 100)) {
    const tr = h('tr');
    for (const c of columns) tr.append(h('td', '', cell(r[c])));
    table.append(tr);
  }
  wrap.append(table);
  return wrap;
}

// ---- tabs, theme, scenarios ----------------------------------------------------------------------

/** @param {string} name */
function showTab(name) {
  for (const t of $('tabs').querySelectorAll('.tab')) {
    const on = /** @type {HTMLElement} */ (t).dataset.pane === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  }
  for (const p of ['graph', 'ledger', 'ontology', 'hood']) $(`pane-${p}`).hidden = p !== name;
  if (name === 'ledger' && state.ledgerDirty) renderLedger();
  if (name === 'ontology') onto?.show(); else onto?.hide();
}

function intro() {
  const box = h('div', 'intro');
  const p = h('p');
  p.append(b('A scripted agent, a real database.'), ' The agent’s words are written ahead of time. What it does with its memory is not: each ',
    b('remember'), ' and ', b('recall'), ' is a statement that Relate runs in this tab.');
  const ol = h('ol');
  for (const t of ['Send the messages one at a time, or press Play.', 'Watch the memory fill on the right, and light up when it is read.', 'Then type your own question.']) ol.append(h('li', '', t));
  box.append(p, ol);
  return box;
}

/** Start a conversation from an empty store. @param {string} id */
async function openScenario(id) {
  pause();
  const sc = state.scenarios[id];
  Object.assign(state, { scenario: sc, steps: plan(sc), cursor: 0, clock: 0, unscripted: false, paths: [], calls: 0, last: null });
  $('title').textContent = sc.title;
  $('blurb').textContent = sc.blurb;
  for (const el of $('scenarios').querySelectorAll('button')) el.classList.toggle('active', /** @type {HTMLElement} */ (el).dataset.id === id);
  transcript().replaceChildren(intro());
  $('calls').replaceChildren();
  $('result').replaceChildren();
  $('chips').replaceChildren(...(sc.try ?? []).map((/** @type {string} */ t) => {
    const c = h('button', '', t);
    c.addEventListener('click', () => send(t));
    return c;
  }));
  inspect(null);
  $('caption').hidden = true;
  graph.clearHighlight();
  setBusy(true);   // no turn may start on the old store while the new one opens
  try {
    const res = await rpc('open');
    $('graphtype').textContent = res.graphType;
    applyOp(res);
    onto.opened(res.graphType);
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
    onto?.retheme();
  });
  // with no choice made, the page follows the system, and so do the graphs
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { graph?.retheme(); onto?.retheme(); });
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
  graph = createGraph($('graph'), { animate: ANIMATE, onSelect: inspect });
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
  document.body.dataset.embed = live.status;
  // the model the store keeps to, as its document says it: the Ontology tab reads it as written
  const model = await fetch(new URL('data/agent-memory.ontology.json', location.href));
  if (!model.ok) throw new Error(`data/agent-memory.ontology.json: HTTP ${model.status}`);
  onto = createOntologyTab({
    doc: await model.json(),
    ui: { h, cypher, table: resultTable },
    // reads only: they are logged under the hood, and the engine is not handed a turn meanwhile
    read: async (tool, statements) => {
      setBusy(true);
      try {
        const res = await rpc('read', { tool, statements });
        applyOp(res);
        return res.results;
      } finally {
        setBusy(false);
      }
    },
    store: () => state.snapshot,
    idle: () => document.body.dataset.ready === '1' && !state.busy,
    showInMemory: (paths, caption) => {
      showTab('graph');
      const cap = document.createDocumentFragment();
      cap.append(caption);
      showHighlight(paths, cap);
    },
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
  $('samples').replaceChildren(...SAMPLES.map(([label, text]) => {
    const s = h('button', '', label);
    s.addEventListener('click', () => { /** @type {HTMLTextAreaElement} */ ($('cypher')).value = text; });
    return s;
  }));
  /** @type {HTMLTextAreaElement} */ ($('cypher')).value = SAMPLES[0][1];

  $('next').addEventListener('click', () => guard(next()));
  $('play').addEventListener('click', () => (state.playing ? pause() : guard(playAll())));
  $('restart').addEventListener('click', () => { if (!state.busy) guard(openScenario(state.scenario.id)); });
  $('free').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = /** @type {HTMLInputElement} */ ($('input'));
    const text = input.value;
    if (!text.trim() || state.busy) return;
    input.value = '';
    guard(send(text));
  });
  $('run').addEventListener('click', () => { if (!state.busy) guard(query(/** @type {HTMLTextAreaElement} */ ($('cypher')).value)); });
  $('cypher').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') $('run').click(); });
  $('tabs').addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target).closest('.tab');
    if (t) showTab(/** @type {HTMLElement} */ (t).dataset.pane ?? 'graph');
  });
  $('caption-clear').addEventListener('click', () => showHighlight([], null));
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
    /** The Ontology tab: show it, search it, select a part, check the store, ask a question. */
    ontology: {
      show: () => showTab('ontology'),
      find: (/** @type {string} */ text) => onto.find(text).map((x) => x.key),
      select: (/** @type {string|null} */ key) => onto.select(key),
      check: () => onto.check(),
      ask: (/** @type {string} */ id, /** @type {Record<string, any>} */ values) => onto.ask(id, values),
      state: () => onto.state(),
    },
  },
});

boot().catch((err) => fail(`The page could not start: ${err?.message ?? err}`));
