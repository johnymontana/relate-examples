// @ts-check
/** Repeatable exact-ID updates on the same tools used by the page. The calling harness
 * captures these statements for native replay as well. */
import assert from 'node:assert/strict';

/** @param {ReturnType<typeof import('../web/memory.js').createMemory>} memory */
export function checkCorrections(memory) {
  const at = '2026-04-05T19:00:00Z';
  const session = { id: 'trip-planning', title: 'Sunday · planning', startedAt: at };
  const visitor = { id: 'trip-you', title: 'Your turn', startedAt: at };
  const text = 'Maya is vegan now and no longer eats any animal products.';
  const diet = { id: 'maya-diet', kind: 'preference', text: 'Maya is vegetarian', gist: 'vegetarian', slot: 'maya/diet', about: ['Maya'] };
  const shellfish = { id: 'you-shellfish', kind: 'preference', text: 'You avoid shellfish', gist: 'shellfish', slot: 'you/shellfish', about: ['You'] };
  const first = { id: 'note-one', kind: 'note', text: 'First note', gist: 'first', about: [] };
  const second = { id: 'note-two', kind: 'note', text: 'Second note', gist: 'second', about: [] };

  memory.remember({
    session, message: { id: 'trip-1', seq: 1, text: 'Maya is vegetarian, and I avoid shellfish.', at },
    entities: [{ name: 'Maya', kind: 'person' }, { name: 'You', kind: 'person' }],
    memories: [diet, shellfish, first, second],
  });
  const input = {
    targetId: diet.id, session: visitor, message: { id: 'trip-2', seq: 2, at, text },
    memory: { id: 'replacement-2', gist: 'vegan' },
  };

  // No vector is required for a correction. The subject, slot and kind are copied from its target.
  assert.deepEqual(memory.correct(input), { status: 'applied', id: input.memory.id });
  const applied = memory.snapshot();
  const facts = applied.nodes.filter((n) => n.label === 'Memory');
  const replacement = facts.find((n) => n.props.id === input.memory.id);
  assert.equal(replacement.props.slot, diet.slot);
  assert.equal(replacement.props.kind, diet.kind);
  assert.equal(replacement.props.embedded, false);
  assert.deepEqual(facts.filter((n) => n.props.slot === diet.slot && n.props.current).map((n) => n.props.id), [input.memory.id]);
  const maya = applied.nodes.find((n) => n.label === 'Entity' && n.props.name === 'Maya');
  const message = applied.nodes.find((n) => n.label === 'Message' && n.props.id === input.message.id);
  assert.deepEqual(applied.rels.filter((r) => r.source === replacement.id && r.type === 'ABOUT').map((r) => r.target), [maya.id]);
  assert.deepEqual(applied.rels.filter((r) => r.source === message.id && r.type === 'MENTIONS').map((r) => r.target), [maya.id]);
  assert.deepEqual(memory.trace({ id: input.memory.id }).map((r) => [r.id, r.said, r.session, r.current]), [
    [input.memory.id, text, visitor.title, true],
    [diet.id, 'Maya is vegetarian, and I avoid shellfish.', session.title, false],
  ]);
  assert.deepEqual(memory.correct(input), { status: 'replayed', id: input.memory.id });
  const otherOperation = { ...input, message: { ...input.message, seq: 3, id: 'trip-3' }, memory: { id: 'replacement-3', gist: 'third' } };
  assert.deepEqual(memory.correct(otherOperation), { status: 'stale', id: null });
  assert.deepEqual(memory.correct({ ...otherOperation, targetId: 'absent' }), { status: 'stale', id: null });
  assert.deepEqual(memory.correct({ ...input, targetId: shellfish.id }), { status: 'stale', id: null });
  assert.deepEqual(memory.correct({ ...input, message: { ...input.message, text: 'A different correction' } }), { status: 'stale', id: null });
  assert.deepEqual(memory.snapshot(), applied);

  // Private notes share the empty slot and may have no ABOUT edge.
  const loose = { ...otherOperation, targetId: first.id, message: { ...otherOperation.message, text: 'Revised first note' } };
  assert.deepEqual(memory.correct(loose), { status: 'applied', id: loose.memory.id });
  const looseFacts = memory.snapshot().nodes.filter((n) => n.label === 'Memory');
  assert.deepEqual(looseFacts.filter((n) => !n.props.slot && n.props.current).map((n) => n.props.id).sort(), [second.id, loose.memory.id].sort());
  assert.equal(looseFacts.find((n) => n.props.id === shellfish.id).props.current, true);

  // The next scripted update replaces the visitor's current version in the same slot.
  const next = { ...diet, id: 'maya-pescatarian', text: 'Maya now eats fish', gist: 'pescatarian' };
  memory.remember({
    session, message: { id: 'trip-4', seq: 4, at, text: next.text },
    entities: [{ name: 'Maya', kind: 'person' }], memories: [next],
  });
  assert.deepEqual(memory.trace({ id: next.id }).map((r) => [r.id, r.current]), [[next.id, true], [input.memory.id, false], [diet.id, false]]);
  const later = memory.snapshot();
  assert.deepEqual(memory.correct(input), { status: 'replayed', id: input.memory.id });
  assert.deepEqual(memory.snapshot(), later);
}
