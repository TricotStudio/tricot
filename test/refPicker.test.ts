import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickableCards, pickCards, readCardQuery, type PickableCard } from '../src/core/refPicker';
import { refLabel } from '../src/core/refs';
import type { Decision, Task } from '../src/core/types';

// A board's cards, as the list sees them: the later a day, the more recent.
const task = (number: number, title: string, status: PickableCard['status'], day: number): PickableCard => ({
  kind: 'task',
  number,
  title,
  status,
  updatedAt: `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`,
});
const decision = (number: number, title: string, status: PickableCard['status'], day: number): PickableCard => ({
  ...task(number, title, status, day),
  kind: 'decision',
});

const cards: PickableCard[] = [
  task(6, 'Retry failed webhooks', 'done', 20),
  task(60, 'Add a retry button', 'in_progress', 10),
  task(61, 'Ship the desktop app', 'todo', 12),
  task(7, 'Node 22 support', 'in_review', 15),
  task(8, 'Prefetch the board', 'dropped', 25),
  task(151, 'Type # to link a card', 'backlog', 5),
  decision(6, 'Which retry policy?', 'decided', 22),
  decision(15, 'Who holds the signing key?', 'open', 3),
  decision(16, 'Retries on the client?', 'exploring', 1),
  decision(2, 'Name the app', 'retired', 30),
];
const picked = (typed: string, limit?: number) => pickCards(cards, typed, limit).map(refLabel);

describe('Typing # to name a card', () => {
  it('lists every card on a bare #, tasks then decisions, those in play before those done with, latest first', () => {
    assert.deepEqual(picked(''), ['T7', 'T61', 'T60', 'T151', 'T8', 'T6', '#15', '#16', '#2', '#6']);
  });

  it('narrows to tasks on #T, and by number on #T6 or #t6, the exact one first', () => {
    assert.deepEqual(picked('T'), ['T7', 'T61', 'T60', 'T151', 'T8', 'T6']);
    assert.deepEqual(picked('t'), picked('T'));
    assert.deepEqual(picked('T6'), ['T6', 'T60', 'T61']);
    assert.deepEqual(picked('t6'), ['T6', 'T60', 'T61']);
    assert.deepEqual(picked('T15'), ['T151']);
    assert.deepEqual(picked('T9'), []);
  });

  it('takes digits alone as either kind by number, then a title word starting with them', () => {
    assert.deepEqual(picked('6'), ['T6', 'T60', 'T61', '#6']);
    assert.deepEqual(picked('1'), ['T151', '#15', '#16']);
    assert.deepEqual(picked('22'), ['T7'], 'Node 22 support');
  });

  it('finds words in titles, word starts before the middle of a word, case aside', () => {
    // Retry..., a retry button, Retries..., retry policy; then none mid-word here.
    assert.deepEqual(picked('retr'), ['T60', 'T6', '#16', '#6']);
    assert.deepEqual(picked('RETRY'), ['T60', 'T6', '#6']);
    assert.deepEqual(picked('fetch'), ['T8'], 'Prefetch, mid-word');
    assert.deepEqual(picked('app'), ['T61', '#2']);
    assert.deepEqual(picked('zebra'), []);
  });

  it('keeps the list short, each kind keeping half when the other has as many', () => {
    const many = [
      ...Array.from({ length: 30 }, (_, i) => task(i + 1, `Task ${i + 1}`, 'todo', 1)),
      ...Array.from({ length: 30 }, (_, i) => decision(i + 1, `Question ${i + 1}`, 'open', 1)),
    ];
    const list = pickCards(many, '');
    assert.equal(list.length, 20);
    assert.equal(list.filter((c) => c.kind === 'task').length, 10);
    // With few decisions, tasks take the room left.
    const fewDecisions = many.slice(0, 33);
    const kinds = pickCards(fewDecisions, '').map((c) => c.kind);
    assert.deepEqual([kinds.filter((k) => k === 'task').length, kinds.filter((k) => k === 'decision').length], [17, 3]);
    assert.equal(pickCards(many, 'T').length, 20);
  });

  it('reads a board’s tasks by title and its decisions by question', () => {
    const t = { number: 4, title: 'Sign the app', status: 'todo', updatedAt: 'x' } as Task;
    const d = { number: 9, question: 'Which updater?', status: 'open', updatedAt: 'y' } as Decision;
    assert.deepEqual(pickableCards([t], [d]), [
      { kind: 'task', number: 4, title: 'Sign the app', status: 'todo', updatedAt: 'x' },
      { kind: 'decision', number: 9, title: 'Which updater?', status: 'open', updatedAt: 'y' },
    ]);
  });
});

describe('Reading the #word before the caret', () => {
  it('opens on a # that starts a word, with what follows it', () => {
    assert.deepEqual(readCardQuery('See #'), { at: 4, query: '' });
    assert.deepEqual(readCardQuery('See #T6'), { at: 4, query: 'T6' });
    assert.deepEqual(readCardQuery('(#retry'), { at: 1, query: 'retry' });
    assert.deepEqual(readCardQuery('#retry'), { at: 0, query: 'retry' });
    assert.deepEqual(readCardQuery('Fixed in T5 and\n#6'), { at: 16, query: '6' });
  });

  it('stays shut mid-word, in a link, after a second #, and past a space', () => {
    assert.equal(readCardQuery('issue#3'), null);
    assert.equal(readCardQuery('https://example.com/page#intro'), null);
    assert.equal(readCardQuery('https://example.com/#'), null);
    assert.equal(readCardQuery('&#32'), null);
    assert.equal(readCardQuery('##'), null);
    assert.equal(readCardQuery('See #T6 '), null);
  });

  it('leaves a heading alone: a # at the start of a line waits for a letter', () => {
    assert.equal(readCardQuery('#'), null);
    assert.equal(readCardQuery('Intro\n#'), null);
    assert.equal(readCardQuery('Intro\n  #'), null);
    assert.equal(readCardQuery('# '), null);
    assert.equal(readCardQuery('# Title'), null);
    assert.equal(readCardQuery('## Plan'), null);
  });

  it('leaves colours, sizes and numbers running into letters alone', () => {
    assert.equal(readCardQuery('colour #1a1a18'), null);
    assert.equal(readCardQuery('colour #1a'), null);
    assert.equal(readCardQuery('the #ff0000 one'.slice(0, 11)), null);
    assert.equal(readCardQuery('a #a1b2c3'), null);
    assert.equal(readCardQuery('width #32px'), null);
    assert.equal(readCardQuery('see #T6a'), null);
    assert.equal(readCardQuery('version #3.5'), null);
    // A word that happens to be hex is still a word.
    assert.deepEqual(readCardQuery('the #cafe'), { at: 4, query: 'cafe' });
  });
});
