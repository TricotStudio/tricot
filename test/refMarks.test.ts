import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { boardCardKind, useBoardCards } from '../src/core/cards';
import { emptyCanvas } from '../src/core/canvas';
import type { ChatPlace } from '../src/core/chatStream';
import { RefMarks } from '../src/core/refMarks';
import { findRefs, refKinds, refLabel, useRefKinds } from '../src/core/refKinds';
import { searchBoards, titleField } from '../src/core/search';
import { registerSearchCard } from '../src/core/searchCards';
import { workName } from '../src/core/threads';
import type { Actor, Board, Comment, ThreadRef } from '../src/core/types';
import { aimRow, placeChoices } from '../src/cli/switcher/chatAim';
import { linksIn } from '../src/cli/switcher/threadsView';
import { RefKinds } from '../src/web/shared/refKinds';

// How the server and the terminal read #12 and T5 in text and label a card
// (src/core/refKinds.ts): they ask the kinds of reference the process has, and
// do not import a part's refs.ts. A process has no kind until it is given some; given
// a part's two (written out here) they read what they read before, and with none they
// find no reference and label no card, and nothing throws. The page's registry of
// reference kinds is refKinds.test.ts's.

const sam: Actor = { kind: 'human', name: 'Sam' };
const known = () => true;

// A part's two kinds as a process is given them.
const kindsOf = (): RefMarks => {
  const kinds = new RefMarks();
  kinds.add({ id: 'decision', marks: ['#'] });
  kinds.add({ id: 'task', marks: ['T', '#T'] });
  return kinds;
};

// Texts, and the references read in them with a part's two kinds (kind, number, start, end), as refs.ts read them before the
// terminal and the server asked the process's kinds.
const TEXTS: [string, [string, number, number, number][]][] = [
  ['See #12, T5 and #T7.', [['decision', 12, 4, 7], ['task', 5, 9, 11], ['task', 7, 16, 19]]],
  ['AT3, issue#3, &#32;, #32px, T3a, #3.5, t5 and T3… stay text', []],
  ['T05 and #0 are no cards, T123456 is one, T1234567 is not', [['task', 123456, 25, 32]]],
  ['Closes #3. Then T4, #T5, #6, and T8.', [['decision', 3, 7, 9], ['task', 4, 16, 18], ['task', 5, 20, 23], ['decision', 6, 25, 27], ['task', 8, 33, 35]]],
  ['', []],
];

// A task and a decision as the board holds them, written here with the fields these tests read: their types are a part's.
interface Task {
  id: string;
  number: number;
  title: string;
  status: string;
  comments: Comment[];
  canvas: ReturnType<typeof emptyCanvas>;
}
interface Decision {
  id: string;
  number: number;
  question: string;
  status: string;
  comments: Comment[];
  canvas: ReturnType<typeof emptyCanvas>;
  options: never[];
  updatedAt: string;
}
const task = (number: number, title: string): Task => ({ id: `t${number}`, number, title, status: 'todo', comments: [], canvas: emptyCanvas() });
const decision = (number: number, question: string): Decision => ({ id: `d${number}`, number, question, status: 'open', comments: [], canvas: emptyCanvas(), options: [], updatedAt: '2026-11-01T10:00:00.000Z' });
const board = {
  id: 'b1',
  title: 'Retries',
  canvas: emptyCanvas(),
  tasks: [task(19, 'Stopped agents leave the strip')],
  decisions: [decision(7, 'Which provider')],
  deletedCards: [{ kind: 'task', id: 't12', number: 12, by: sam, at: '2026-10-05T10:00:00.000Z' }],
} as unknown as Board;

const placeOf = (kind: 'task' | 'decision', number: number, title: string): ChatPlace => ({ kind, id: `${kind}${number}`, number, title }) as unknown as ChatPlace;

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe('The list of reference kinds', () => {
  it('refuses what is a mistake in Tricot and not in what a person typed, and says how a card reads', () => {
    const kinds = new RefMarks();
    assert.equal(kinds.scanner(), undefined, 'a new list has no kind to search for');
    kinds.add({ id: 'task', marks: ['T', '#T'] });
    assert.throws(() => kinds.add({ id: 'task', marks: ['X'] }), /two kinds of reference named task/);
    assert.throws(() => kinds.add({ id: 'bug', marks: ['#T'] }), /task and bug are both written with #T/);
    assert.throws(() => kinds.add({ id: 'bug', marks: [] }), /no mark to be written with/);
    assert.equal(kinds.label('task', 5), 'T5');
    assert.equal(kinds.label('bug', 5), undefined);
    assert.deepEqual(kinds.kinds().map((kind) => kind.id), ['task'], 'a kind refused is not kept');
  });

  it('is what the page’s registry is made of', () => {
    const kinds = new RefKinds();
    assert.ok(kinds instanceof RefMarks);
    kinds.add({ id: 'task', marks: ['T'], on: () => ({ card: () => undefined, deletedBy: () => undefined }) });
    assert.equal(kinds.label('task', 2), 'T2');
  });
});

describe('The kinds a process reads', () => {
  it('are none until it is given some, and then find and label what they did before', () => {
    assert.deepEqual(refKinds().kinds(), []);
    assert.deepEqual(findRefs('T5 and #12', known), []);
    assert.equal(refLabel('task', 5), '5');
    restore = useRefKinds(kindsOf());
    for (const [text, refs] of TEXTS) {
      assert.deepEqual(findRefs(text, known).map((ref) => [ref.kind, ref.number, ref.start, ref.end]), refs, text);
    }
    assert.deepEqual(findRefs('T5 and #12', (kind, number) => kind === 'task' && number === 5).map((ref) => ref.number), [5], 'only the cards the board has');
    assert.equal(refLabel('task', 5), 'T5');
    assert.equal(refLabel('decision', 12), '#12');
  });

  it('can be given others, and come back as they were', () => {
    restore = useRefKinds(kindsOf());
    const back = useRefKinds(new RefMarks());
    assert.deepEqual(findRefs('T5 and #12', known), []);
    back();
    assert.equal(findRefs('T5 and #12', known).length, 2);
  });

  it('read a kind of another Tricot beside, or instead of, a part’s', () => {
    const kinds = new RefMarks();
    kinds.add({ id: 'bug', marks: ['BUG-'] });
    restore = useRefKinds(kinds);
    assert.deepEqual(findRefs('BUG-4 and T5', known).map((ref) => [ref.kind, ref.number]), [['bug', 4]]);
    assert.equal(refLabel('bug', 4), 'BUG-4');
  });
});

// What a search finds on a board with decision #1, "Which provider", and task T1, "Add retries": the board is written here, as
// the board above is, so no Store has to make the cards.
function found(query: string) {
  const payments = { ...board, id: 'payments', title: 'Payments', tasks: [{ ...task(1, 'Add retries'), notes: [], links: [] }], decisions: [{ ...decision(1, 'Which provider'), findings: [] }], deletedCards: [] } as unknown as Board;
  // The search is given the kind of card the board's decisions are, and the words its own result is found by.
  const undo = [
    useBoardCards([
      boardCardKind<Decision>({ kind: 'decision', list: 'decisions', mark: '#', number: (card) => card.number, title: (card) => card.question, comments: (card) => card.comments, canvas: (card) => card.canvas }),
    ]),
    registerSearchCard({ owner: 'decision', standing: () => ({}), item: (card: Decision) => ({ fields: titleField(card.question), at: card.updatedAt }) }),
  ];
  try {
    return searchBoards([payments], query, { allBoards: true }).results;
  } finally {
    for (const back of undo.reverse()) back();
  }
}

describe('The terminal and the server with no kind of reference', () => {
  it('find no reference, label no card and throw nothing', () => {
    restore = useRefKinds(new RefMarks());
    const card = () => '#/somewhere';
    assert.deepEqual(linksIn('See T19, #7', card), [], 'a number no kind writes is text');
    assert.deepEqual(linksIn('See https://x.org/T19', card).map((link) => link.url), ['https://x.org/T19'], 'an address is still a link');
    assert.equal(workName(board, { kind: 'task', id: 't12' } as unknown as ThreadRef), 'a card since removed', 'a card of a kind nothing labels reads as a card');
    assert.equal(refLabel('task', 19), '19');
    assert.equal(aimRow(placeOf('task', 19, 'Stopped'), '', 'Claude hears it', 100), 'to 19 Stopped · Claude hears it', 'a card of a kind nothing labels reads as its number');
    assert.doesNotThrow(() => placeChoices(board, [], 'T'));
    assert.deepEqual(found('provider').map((result) => result.ref), ['1'], 'a card of a kind nothing labels reads as its number');
  });
});
