// @ts-check
/**
 * agent.js: the agent, without a language model (NOTES.md D1, ADR-0017).
 *
 * A real agent would ask a language model twice per turn: once to extract entities and memories from
 * what the user said (structured output), and once to answer from what `recall` returned. Here both
 * are written ahead of time in a scenario file (data/scenarios/*.json): each turn carries the
 * extraction a model would have produced and the reply it would have given. Everything between the
 * two is real: the tools run the statements in memory.js on Relate, and the reply may only cite
 * memories the tool actually returned (a citation the engine did not return is reported as a problem,
 * and harness/run.mjs fails on it).
 *
 * Visitors choose Ask or Save note. Ask reads the store with recall, connect or trace. Save note
 * stores the literal text and links it to the entities it names (NOTES.md D8).
 *
 * Vectors come through `tools.embed` (web/embed.js): the scripts' texts have theirs ahead of time,
 * and a scripted turn without one is a problem; a typed text gets one from the model in the tab,
 * or goes without.
 *
 * The page calls these with tools that message the engine worker; harness/run.mjs calls them with
 * tools that call memory.js directly. Both get the same TurnResult.
 *
 * @typedef {{embed: (texts: string[]) => Promise<Array<number[]|null>>,
 *            recall: (a: {question: string, vector: number[]|null}) => Promise<any[]>|any[],
 *            connect: (a: {from: string, to: string}) => Promise<any>|any,
 *            trace: (a: {id: string}) => Promise<any[]>|any[],
 *            remember: (a: any) => Promise<any>|any,
 *            entitiesNamed: (text: string) => Promise<any[]>|any[]}} Tools
 * @typedef {{nodes: number[], rels: number[], strong: boolean, id?: string, after?: number}} Path  rels[i] joins nodes[i] and nodes[i + 1]; `after` delays its lighting by that many steps
 * @typedef {{tool: string, [k: string]: any}} Step
 * @typedef {{text?: string, cite?: string, n?: number}} Part
 * @typedef {{parts: Part[], related?: any[]}} Answer
 * @typedef {{user: string, session: {id: string, title: string, startedAt: string}, seq: number,
 *            steps: Step[], reply: {parts: Part[], related?: any[], cites: Array<{id: string, n: number, text: string|null}>},
 *            highlight: {paths: Path[]}, problems: string[]}} TurnResult
 */

const MINUTE = 60000;

/**
 * A scenario's turns in order, each with its session, its sequence number (1, 2, … across
 * sessions) and a fixed timestamp (the session's start plus three minutes per turn).
 * @param {any} scenario
 */
export function plan(scenario) {
  const steps = [];
  let seq = 0;
  for (const [si, session] of scenario.sessions.entries()) {
    const start = Date.parse(session.startedAt);
    for (const [ti, turn] of session.turns.entries()) {
      seq++;
      steps.push({
        ...turn,
        seq,
        sessionIndex: si,
        turnIndex: ti,
        firstOfSession: ti === 0,
        session: { id: `${scenario.id}-${session.id}`, title: session.title, startedAt: session.startedAt },
        messageId: `${scenario.id}-${seq}`,
        at: new Date(start + ti * 3 * MINUTE).toISOString().replace('.000Z', 'Z'),
      });
    }
  }
  return steps;
}

/**
 * A reply's text and its citations: `[[memory-id]]` marks a memory the sentence relies on.
 * @param {string} text
 * @returns {{parts: Array<{text?: string, cite?: string, n?: number}>, ids: string[]}}
 */
export function parseReply(text) {
  const parts = [];
  /** @type {string[]} */ const ids = [];
  let last = 0;
  for (const m of String(text).matchAll(/\s*\[\[([^\]]+)\]\]/g)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    if (!ids.includes(m[1])) ids.push(m[1]);
    parts.push({ cite: m[1], n: ids.indexOf(m[1]) + 1 });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return { parts, ids };
}

/** The memories a step returned: {id -> {text, nodes, rels}}. @param {Step} step */
function returned(step) {
  /** @type {Map<string, {text: string, nodes: number[], rels: number[]}>} */
  const out = new Map();
  if (step.tool === 'recall' || step.tool === 'trace') {
    for (const r of step.rows) out.set(r.id, { text: r.text, nodes: r.nodes, rels: r.rels });
  } else if (step.tool === 'connect' && step.row) {
    for (const m of step.row.memories) out.set(m.id, { text: m.text, nodes: step.row.nodes, rels: step.row.rels });
  }
  return out;
}

/**
 * The reply's citations resolved against what the tools returned, and the paths to highlight, in
 * the order the tools returned them: a chain or a trace is strong throughout; a recalled row is
 * strong when the reply cites it, and soft otherwise.
 * @param {Answer} answer @param {Step[]} steps @param {string[]} problems
 */
function settle(answer, steps, problems) {
  const ids = [...new Set(answer.parts.flatMap((p) => p.cite !== undefined ? [p.cite] : []))];
  const parts = answer.parts.map((p) => p.cite !== undefined ? { cite: p.cite, n: ids.indexOf(p.cite) + 1 } : p);
  /** @type {Path[]} */ const paths = [];
  const all = new Map();
  for (const step of steps) {
    const got = returned(step);
    for (const [id, m] of got) if (!all.has(id)) all.set(id, m);
    if (step.tool === 'connect' && step.row) paths.push({ nodes: step.row.nodes, rels: step.row.rels, strong: true });
    if (step.tool === 'trace') for (const r of step.rows) paths.push({ nodes: r.nodes, rels: r.rels, strong: true });
    if (step.tool === 'recall') {
      for (const r of step.rows) {
        const strong = ids.includes(r.id);
        paths.push({ nodes: r.nodes, rels: r.rels, strong, id: r.id });
        // then the entities the recalled memory is about, lit after the path that reached it
        const hit = r.nodes[r.nodes.length - 1];
        for (const a of r.about) paths.push({ nodes: [hit, a.node], rels: [a.rel], strong, id: r.id, after: 2 * (r.nodes.length - 1) });
      }
    }
  }
  const cites = ids.map((id, i) => {
    const m = all.get(id);
    if (!m) problems.push(`the reply cites ${id}, which no tool returned`);
    return { id, n: i + 1, text: m?.text ?? null };
  });
  return { reply: { parts, cites, ...(answer.related?.length ? { related: answer.related } : {}) }, highlight: { paths } };
}

/**
 * Paths merged into two sets of ids: what is on a strong path, and what is only on soft ones.
 * @param {Path[]} paths
 * @returns {{strong: {nodes: number[], rels: number[]}, soft: {nodes: number[], rels: number[]}}}
 */
export function mergePaths(paths) {
  const set = (/** @type {boolean} */ strong, /** @type {'nodes'|'rels'} */ k) => [...new Set(paths.filter((p) => p.strong === strong).flatMap((p) => p[k]))];
  const strong = { nodes: set(true, 'nodes'), rels: set(true, 'rels') };
  return {
    strong,
    soft: { nodes: set(false, 'nodes').filter((n) => !strong.nodes.includes(n)), rels: set(false, 'rels').filter((r) => !strong.rels.includes(r)) },
  };
}

/**
 * One scripted turn: read memory (recall, connect or trace), store what the message said
 * (remember), reply.
 * @param {Tools} tools
 * @param {ReturnType<typeof plan>[number]} step
 * @param {{edited?: boolean, visitorMemoryIds?: Set<string>, hasMemories?: boolean}} [context]
 * @returns {Promise<TurnResult>}
 */
export async function scriptedTurn(tools, step, context = {}) {
  /** @type {Step[]} */ const steps = [];
  /** @type {string[]} */ const problems = [];
  if (step.recall) {
    const question = typeof step.recall === 'object' && step.recall.question ? step.recall.question : step.user;
    const [vector] = await tools.embed([question]);
    if (!vector) problems.push(`no vector for the question ${JSON.stringify(question)}: run node harness/embed.mjs`);
    steps.push({ tool: 'recall', question, embedded: !!vector, rows: await tools.recall({ question, vector }) });
  }
  if (step.connect) {
    const row = await tools.connect(step.connect);
    if (!row && !context.edited) problems.push(`connect found no chain from ${step.connect.from} to ${step.connect.to}`);
    steps.push({ tool: 'connect', ...step.connect, row });
  }
  if (step.trace) {
    const rows = await tools.trace({ id: step.trace });
    if (!rows.length && !context.edited) problems.push(`trace found no memory ${step.trace}`);
    steps.push({ tool: 'trace', id: step.trace, rows });
  }
  if (step.remember) {
    const entities = step.remember.entities ?? [];
    const vectors = await tools.embed((step.remember.memories ?? []).map((/** @type {any} */ m) => m.text));
    const memories = (step.remember.memories ?? []).map((/** @type {any} */ m, /** @type {number} */ i) => ({ ...m, embedding: vectors[i] }));
    for (const m of memories) if (!m.embedding) problems.push(`no vector for the memory ${m.id}: run node harness/embed.mjs`);
    const counts = await tools.remember({
      session: step.session,
      message: { id: step.messageId, seq: step.seq, text: step.user, at: step.at },
      entities,
      memories,
    });
    if (counts.memories !== memories.length) problems.push(`remember stored ${counts.memories} of ${memories.length} memories`);
    const wanted = memories.reduce((n, m) => n + m.about.length, 0);
    if (counts.links !== wanted) problems.push(`remember linked ${counts.links} of ${wanted} entities (an "about" names an entity the turn does not list)`);
    steps.push({ tool: 'remember', entities, memories, counts });
  }
  let answer;
  if (context.edited) {
    const read = steps.find((s) => s.tool !== 'remember');
    if (read?.tool === 'recall') answer = recallAnswer(read.rows, { ...context, visitorMemoryIds: context.visitorMemoryIds ?? new Set() });
    else if (read?.tool === 'connect') answer = connectionAnswer(read);
    else if (read?.tool === 'trace') answer = sourceAnswer(read.rows, read.id);
    else answer = { parts: [{ text: 'The scripted write ran. Open What it knows to inspect the current memories.' }] };
  } else {
    answer = parseReply(step.reply);
  }
  const { reply, highlight } = settle(answer, steps, problems);
  return { user: step.user, session: step.session, seq: step.seq, steps, reply, highlight, problems };
}

const SOURCE = /\b(how do you know|who told you|when did (i|we) (tell|say|mention)|where did (that|this|you) .*(come|hear|learn)|what is your source)\b/i;
const LINKS = /\b(connect(ed|ion|s)?|relat(ed|es|ion|ionship)|link(ed|s)?|between|path|to do with)\b/i;

/** A sentence's first words, as a note's short label. @param {string} text */
function gistOf(text) {
  const w = text.trim().split(/\s+/);
  return w.slice(0, 4).join(' ') + (w.length > 4 ? '…' : '');
}

const list = (/** @type {string[]} */ xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** A literal reply drawn from current recall rows. In edited playback, include visitor-authored
 * matches even when the retrieval reached them through another memory.
 * A paired suggestion can identify the saved memory for its exercise. It must also be in the
 * result of the current recall.
 * @param {any[]} rows @param {{hasMemories?: boolean, visitorMemoryIds?: Set<string>, suggestedMemoryId?: string}} context
 * @returns {Answer} */
function recallAnswer(rows, { hasMemories, visitorMemoryIds, suggestedMemoryId }) {
  if (!rows.length) {
    const text = hasMemories === false
      ? 'Memory is empty. Play a conversation or save a note, then ask about it.'
      : 'No matching memory. Open What it knows to browse the stored facts.';
    return { parts: [{ text }] };
  }
  const suggested = rows.find((row) => row.id === suggestedMemoryId);
  const first = suggested ?? rows.find((row) => row.via !== 'graph') ?? rows[0];
  const main = visitorMemoryIds
    ? rows.filter((r) => r.id === first.id || r.via !== 'graph' || visitorMemoryIds.has(r.id))
    : [first];
  /** @type {Part[]} */ const parts = [];
  if (visitorMemoryIds) parts.push({ text: 'From the edited memory:' });
  for (const row of main) {
    let prefix = 'Closest matching memory: ';
    if (visitorMemoryIds) prefix = visitorMemoryIds.has(row.id) ? '\nYour note: ' : '\n';
    else if (suggested) prefix = row.via === 'graph' ? `Your saved note, linked through ${list(row.through)}: ` : 'Your saved note: ';
    parts.push({ text: prefix + row.text }, { cite: row.id });
  }
  return { parts, related: rows.filter((r) => !main.includes(r)) };
}

/** Trace an exact memory. When a search chose it, identify the match before quoting its source.
 * The original message can differ from today's value after a console edit.
 * @param {any[]} versions @param {string} id @param {any} [match] @returns {Answer} */
function sourceAnswer(versions, id, match) {
  const source = versions.find((v) => v.id === id);
  const fact = match ?? source;
  if (!fact) return { parts: [{ text: 'This memory has no available source message.' }] };
  const label = match ? 'Closest matching memory: ' : 'Stored memory: ';
  /** @type {Part[]} */ const parts = [{ text: label + fact.text }, { cite: id }];
  parts.push({ text: source
    ? `\nSource message from ${source.session}: “${source.said}”`
    : '\nThe original source message is unavailable.' });
  return { parts };
}

/** @param {Step} step @returns {Answer} */
function connectionAnswer({ from, to, row }) {
  if (!row) return { parts: [{ text: `No chain of current memories links ${from} and ${to}.` }] };
  /** @type {Part[]} */ const parts = [{ text: `${from} and ${to} are ${row.hops} ${row.hops === 1 ? 'memory' : 'memories'} apart: ` }];
  for (const [i, memory] of row.memories.entries()) {
    parts.push({ text: (i ? ' → ' : '') + memory.text }, { cite: memory.id });
  }
  return { parts };
}

/**
 * One turn the visitor typed. No model: rules decide the tool, and the reply is assembled from the
 * tool's rows.
 * @param {Tools} tools
 * @param {string} text
 * @param {{session: {id: string, title: string, startedAt: string}, seq: number, at: string, messageId: string, noteId: string, intent?: 'ask'|'save', hasMemories?: boolean, suggestedMemoryId?: string}} ctx
 * @returns {Promise<TurnResult>}
 */
export async function freeTurn(tools, text, ctx) {
  /** @type {Step[]} */ const steps = [];
  /** @type {string[]} */ const problems = [];
  let answer;
  const intent = ctx.intent ?? 'ask';
  if (intent === 'ask') {
    const wantsSource = SOURCE.test(text);
    const named = !wantsSource && LINKS.test(text) ? await tools.entitiesNamed(text) : [];
    if (named.length >= 2) {
      // the two entities in the order the question names them
      const folded = ` ${text.toLowerCase()} `;
      const [a, b] = [...named].sort((x, y) => folded.indexOf(x.name.toLowerCase()) - folded.indexOf(y.name.toLowerCase()));
      const row = await tools.connect({ from: a.name, to: b.name });
      const step = { tool: 'connect', from: a.name, to: b.name, row };
      steps.push(step);
      answer = connectionAnswer(step);
    } else {
      const [vector] = await tools.embed([text]);
      const rows = await tools.recall({ question: text, vector });
      steps.push({ tool: 'recall', question: text, embedded: !!vector, rows });
      const match = rows.find((r) => r.via !== 'graph') ?? rows[0];
      if (match && wantsSource) {
        const versions = await tools.trace({ id: match.id });
        steps.push({ tool: 'trace', id: match.id, rows: versions });
        answer = sourceAnswer(versions, match.id, match);
      } else {
        answer = recallAnswer(rows, ctx);
      }
    }
  } else if (intent === 'save') {
    const named = await tools.entitiesNamed(text);
    const [embedding] = await tools.embed([text.trim()]);
    const memories = [{ id: ctx.noteId, kind: 'note', text: text.trim(), gist: gistOf(text), slot: '', about: named.map((/** @type {any} */ e) => e.name), embedding }];
    const counts = await tools.remember({
      session: ctx.session,
      message: { id: ctx.messageId, seq: ctx.seq, text: text.trim(), at: ctx.at },
      entities: named.map((/** @type {any} */ e) => ({ name: e.name, kind: e.kind })),
      memories,
    });
    steps.push({ tool: 'remember', entities: [], memories, counts });
    const how = embedding ? '' : ' It has no vector (the embedding model is not loaded), so only its words will find it.';
    const message = named.length
      ? `Stored as a note, linked to ${list(named.map((/** @type {any} */ e) => e.name))}.`
      : 'Stored as a note. It has no links to known entities.';
    answer = { parts: [{ text: message + how }] };
  } else {
    throw new Error(`Unknown turn action: ${intent}`);
  }
  const { reply, highlight } = settle(answer, steps, problems);
  return { user: text.trim(), session: ctx.session, seq: ctx.seq, steps, reply, highlight, problems };
}
