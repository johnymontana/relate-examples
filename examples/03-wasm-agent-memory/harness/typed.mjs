// @ts-check
/**
 * harness/typed.mjs: the turns nobody scripted that the regression run types (typed.txt), in order,
 * after the "team" conversation. They are here, apart from run.mjs, because harness/embed.mjs needs
 * them too: each text in TYPED has its vector in data/embeddings.json, so the run needs no model.
 */
export const TYPED = [
  'Who owns the payments service?',
  'How are Priya and Dana connected?',
  'How are Priya and Postgres connected?',
  'Dana is on holiday in August',
  'Who is on leave this summer?',
  'How do you know Dana is on holiday?',
  'tomas now works on the payments service too',
  'What is Tomás working on?',
  'What about Kubernetes?',
  'And what do you know?',
];

/**
 * Two more, typed last, that have no vector on purpose (harness/embed.mjs leaves them out): what the
 * page does when the model in the tab cannot be loaded. The note is stored without a vector and the
 * question finds it by its words alone.
 */
export const TYPED_WITHOUT_VECTOR = [
  'The office moves in spring',
  'When does the office move?',
];
