// @ts-check
/**
 * agent.js: the agent, without a model (NOTES.md D1, ADR-0014).
 *
 * A real agent would ask a language model twice per turn: once to extract entities and memories from
 * what the user said (structured output), and once to answer from what `recall` returned. Here both
 * are written ahead of time in a scenario file (data/scenarios/*.json): each turn carries the
 * extraction a model would have produced and the reply it would have given. Everything between the
 * two is real: the tools run the statements in memory.js on Relate, and the reply may only cite
 * memories the tool actually returned (a citation the engine did not return is reported as a problem,
 * and harness/run.mjs fails on it).
 *
 * Text the visitor types has no script. `freeTurn` handles it with rules, not a model: a question
 * goes to `recall` (or `connect`, when it asks how two known entities are linked) and the reply
 * lists what came back; anything else is stored word for word as a note, linked to the entities it
 * names.
 *
 * The page calls these with tools that message the engine worker; harness/run.mjs calls them with
 * tools that call memory.js directly. Both get the same TurnResult.
 *
 * @typedef {{recall: (a: {question: string}) => Promise<any[]>|any[],
 *            connect: (a: {from: string, to: string}) => Promise<any>|any,
 *            trace: (a: {id: string}) => Promise<any[]>|any[],
 *            remember: (a: any) => Promise<any>|any,
 *            entitiesNamed: (text: string) => Promise<any[]>|any[]}} Tools
 * @typedef {{nodes: number[], rels: number[], strong: boolean, id?: string, after?: number}} Path  rels[i] joins nodes[i] and nodes[i + 1]; `after` delays its lighting by that many steps
 * @typedef {{tool: string, [k: string]: any}} Step
 * @typedef {{user: string, session: {id: string, title: string, startedAt: string}, seq: number,
 *            steps: Step[], reply: {parts: Array<{text?: string, cite?: string, n?: number}>, cites: Array<{id: string, n: number, text: string|null}>},
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
 * strong when the reply cites it (or, with no citations, when it is among the first `strongest`),
 * and soft otherwise.
 * @param {string} replyText @param {Step[]} steps @param {string[]} problems @param {number} [strongest]
 */
function settle(replyText, steps, problems, strongest = 0) {
  const { parts, ids } = parseReply(replyText);
  /** @type {Path[]} */ const paths = [];
  const all = new Map();
  for (const step of steps) {
    const got = returned(step);
    for (const [id, m] of got) if (!all.has(id)) all.set(id, m);
    if (step.tool === 'connect' && step.row) paths.push({ nodes: step.row.nodes, rels: step.row.rels, strong: true });
    if (step.tool === 'trace') for (const r of step.rows) paths.push({ nodes: r.nodes, rels: r.rels, strong: true });
    if (step.tool === 'recall') {
      for (const [i, r] of step.rows.entries()) {
        const strong = ids.includes(r.id) || (ids.length === 0 && i < strongest);
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
  return { reply: { parts, cites }, highlight: { paths } };
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
 * @returns {Promise<TurnResult>}
 */
export async function scriptedTurn(tools, step) {
  /** @type {Step[]} */ const steps = [];
  /** @type {string[]} */ const problems = [];
  if (step.recall) {
    const question = typeof step.recall === 'object' && step.recall.question ? step.recall.question : step.user;
    steps.push({ tool: 'recall', question, rows: await tools.recall({ question }) });
  }
  if (step.connect) {
    const row = await tools.connect(step.connect);
    if (!row) problems.push(`connect found no chain from ${step.connect.from} to ${step.connect.to}`);
    steps.push({ tool: 'connect', ...step.connect, row });
  }
  if (step.trace) {
    const rows = await tools.trace({ id: step.trace });
    if (!rows.length) problems.push(`trace found no memory ${step.trace}`);
    steps.push({ tool: 'trace', id: step.trace, rows });
  }
  if (step.remember) {
    const entities = step.remember.entities ?? [];
    const memories = step.remember.memories ?? [];
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
  const { reply, highlight } = settle(step.reply, steps, problems);
  return { user: step.user, session: step.session, seq: step.seq, steps, reply, highlight, problems };
}

const ASKS = /^(who|whom|whose|what|when|where|why|which|how|is|are|was|were|am|do|does|did|can|could|should|would|will|have|has|tell me|remind me|show me|list|find|any)\b/i;
const SOURCE = /\b(how do you know|who told you|when did (i|we) (tell|say|mention)|where did (that|this|you) .*(come|hear|learn)|what is your source)\b/i;
const LINKS = /\b(connect(ed|ion|s)?|relat(ed|es|ion|ionship)|link(ed|s)?|between|path|to do with)\b/i;

/** Whether typed text is a question for the memory rather than something to store. @param {string} text */
export function isQuestion(text) {
  const t = text.trim();
  return /\?\s*$/.test(t) || ASKS.test(t);
}

/** A sentence's first words, as a note's short label. @param {string} text */
function gistOf(text) {
  const w = text.trim().split(/\s+/);
  return w.slice(0, 4).join(' ') + (w.length > 4 ? '…' : '');
}

const list = (/** @type {string[]} */ xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * One turn the visitor typed. No model: rules decide the tool, and the reply is assembled from the
 * tool's rows.
 * @param {Tools} tools
 * @param {string} text
 * @param {{session: {id: string, title: string, startedAt: string}, seq: number, at: string, messageId: string, noteId: string}} ctx
 * @returns {Promise<TurnResult>}
 */
export async function freeTurn(tools, text, ctx) {
  /** @type {Step[]} */ const steps = [];
  /** @type {string[]} */ const problems = [];
  let replyText;
  if (isQuestion(text)) {
    const named = LINKS.test(text) ? await tools.entitiesNamed(text) : [];
    if (named.length >= 2) {
      // the two entities in the order the question names them
      const folded = ` ${text.toLowerCase()} `;
      const [a, b] = [...named].sort((x, y) => folded.indexOf(x.name.toLowerCase()) - folded.indexOf(y.name.toLowerCase()));
      const row = await tools.connect({ from: a.name, to: b.name });
      steps.push({ tool: 'connect', from: a.name, to: b.name, row });
      replyText = row
        ? `${a.name} and ${b.name} are ${row.hops} ${row.hops === 1 ? 'memory' : 'memories'} apart: ${row.memories.map((/** @type {any} */ m) => `${m.text} [[${m.id}]]`).join(' → ')}`
        : `No chain of current memories links ${a.name} and ${b.name}.`;
    } else {
      const rows = await tools.recall({ question: text });
      steps.push({ tool: 'recall', question: text, rows });
      if (rows.length && SOURCE.test(text)) {
        // "how do you know…": the best match, traced to the message it came from
        const versions = await tools.trace({ id: rows[0].id });
        steps.push({ tool: 'trace', id: rows[0].id, rows: versions });
        replyText = versions.map((/** @type {any} */ v, /** @type {number} */ i) =>
          `${i === 0 ? 'You told me' : 'Before that, you told me'} in "${v.session}": "${v.said}"${i === 0 ? ` [[${v.id}]]` : ''}`).join('\n');
      } else if (!rows.length) {
        replyText = 'Nothing in memory matches that. Play the conversation first, or tell me something and then ask about it.';
      } else {
        const lines = rows.slice(0, 5).map((/** @type {any} */ r) => {
          const how = r.via === 'graph' ? ` (linked through ${r.through.join(' and ')})`
            : r.via === 'update' ? ` (this replaced: ${r.replaced[0]})` : '';
          return `${r.text}${how} [[${r.id}]]`;
        });
        replyText = `From memory:\n${lines.join('\n')}`;
      }
    }
  } else {
    const named = await tools.entitiesNamed(text);
    const memories = [{ id: ctx.noteId, kind: 'note', text: text.trim(), gist: gistOf(text), slot: '', about: named.map((/** @type {any} */ e) => e.name) }];
    const counts = await tools.remember({
      session: ctx.session,
      message: { id: ctx.messageId, seq: ctx.seq, text: text.trim(), at: ctx.at },
      entities: named.map((/** @type {any} */ e) => ({ name: e.name, kind: e.kind })),
      memories,
    });
    steps.push({ tool: 'remember', entities: [], memories, counts });
    replyText = named.length
      ? `Stored as a note, linked to ${list(named.map((/** @type {any} */ e) => e.name))}. There is no model on this page, so I kept your words as they are; an agent with a model would extract the entities and facts from them.`
      : 'Stored as a note. It names nothing I already know, so it is linked to no entity yet: search will still find it by its words.';
  }
  const { reply, highlight } = settle(replyText, steps, problems, 3);
  return { user: text.trim(), session: ctx.session, seq: ctx.seq, steps, reply, highlight, problems };
}
