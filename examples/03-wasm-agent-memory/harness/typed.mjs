// @ts-check
/**
 * harness/typed.mjs: the turns nobody scripted that the regression run types (typed.txt), in order,
 * after the "team" conversation. They are here, apart from run.mjs, because harness/embed.mjs needs
 * them too: each text in TYPED has its vector in data/embeddings.json, so the run needs no model.
 */
/** @typedef {{intent: 'ask'|'save', text: string}} TypedInput */
/** @type {TypedInput[]} */
export const TYPED = [
  { intent: 'ask', text: 'Who owns the payments service?' },
  { intent: 'ask', text: 'How are Priya and Dana connected?' },
  { intent: 'ask', text: 'How are Priya and Postgres connected?' },
  { intent: 'save', text: 'Dana is on holiday in August' },
  { intent: 'ask', text: 'Who is on leave this summer?' },
  { intent: 'ask', text: 'How do you know Dana is on holiday?' },
  { intent: 'save', text: 'tomas now works on the payments service too' },
  { intent: 'ask', text: 'What is Tomás working on?' },
  { intent: 'ask', text: 'What about Kubernetes?' },
  { intent: 'ask', text: 'And what do you know?' },
];

/**
 * Two more, typed last, that have no vector on purpose (harness/embed.mjs leaves them out): what the
 * page does when the model in the tab cannot be loaded. The note is stored without a vector and the
 * question finds it by its words alone.
 * @type {TypedInput[]}
 */
export const TYPED_WITHOUT_VECTOR = [
  { intent: 'save', text: 'The office moves in spring' },
  { intent: 'ask', text: 'When does the office move?' },
];
