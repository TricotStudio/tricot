import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readRef, refScanner } from '../src/core/refText';
import type { Actor, Board } from '../src/core/types';
import { Md } from '../src/web/shared/markdown';
import { RefKinds, type RefKind, type RefPicker } from '../src/web/shared/refKinds';
import { RefChip, RefsProvider, RefText } from '../src/web/shared/refs';

// How the page reaches the cards a text names (#12, T5) without naming a kind
// of card (src/web/shared/refKinds.ts): a page registers its kinds, and the shared Markdown, composers and links ask
// the registry, so a page with none registered is the canvas alone.

const sam: Actor = { kind: 'human', name: 'Sam' };

// A board with decision #3, task T5, and task T12, which Sam deleted for good.
const board = {
  id: 'b1',
  decisions: [{ id: 'd3', number: 3, status: 'decided', question: 'Which provider?', updatedAt: '2026-10-02T10:00:00.000Z' }],
  tasks: [
    { id: 't5', number: 5, status: 'todo', title: 'Wire up Stripe', updatedAt: '2026-10-03T10:00:00.000Z' },
    { id: 't6', number: 6, status: 'in_progress', title: 'Retry failed webhooks', updatedAt: '2026-10-04T10:00:00.000Z' },
  ],
  deletedCards: [{ kind: 'task', id: 't12', number: 12, by: sam, at: '2026-10-05T10:00:00.000Z' }],
} as unknown as Board;

const html = (node: ReactNode) => renderToStaticMarkup(node);
const md = (text: string, inline = false) => createElement(Md, { inline, children: text });
const withKinds = (kinds: RefKinds | undefined, node: ReactNode) => html(createElement(RefsProvider, { board, kinds, children: node }));
const nothing = new RefKinds();
const kind = (id: string, marks: string[], extra: Partial<RefKind> = {}): RefKind => ({ id, marks, on: () => ({ card: () => undefined, deletedBy: () => undefined }), ...extra });

describe('The registry of reference kinds', () => {
  it('lists its kinds in the order they were added, finds one by its id and says how a card of it reads', () => {
    const kinds = new RefKinds();
    assert.deepEqual(kinds.kinds(), [], 'a new registry has none');
    const [task, decision] = [kind('task', ['T', '#T']), kind('decision', ['#'])];
    kinds.add(task);
    kinds.add(decision);
    assert.deepEqual(kinds.kinds(), [task, decision]);
    assert.equal(kinds.find('decision'), decision);
    assert.equal(kinds.find('bug'), undefined);
    assert.equal(kinds.label('task', 5), 'T5', 'the first mark labels it, as the ones it is also written with are not');
    assert.equal(kinds.label('decision', 12), '#12');
    assert.equal(kinds.label('bug', 1), undefined);
  });

  it('refuses what is a mistake in Tricot and not in what a person typed', () => {
    const kinds = new RefKinds();
    kinds.add(kind('task', ['T', '#T']));
    assert.throws(() => kinds.add(kind('task', ['X'])), /two kinds of reference named task/);
    assert.throws(() => kinds.add(kind('bug', ['#T'])), /task and bug are both written with #T/, 'a text would name both');
    assert.throws(() => kinds.add(kind('bug', [])), /bug has no mark/);
    assert.deepEqual(kinds.kinds().map((k) => k.id), ['task'], 'a refused kind is not added');
    const picker: RefPicker = { name: 'Link a card', read: () => null, on: () => () => [] };
    kinds.pickWith(picker);
    assert.throws(() => kinds.pickWith(picker), /two # lists/);
    assert.equal(kinds.list(), picker);
  });

  it('has nothing to search a text for until a kind is added, and then only what the kinds registered are written with', () => {
    const kinds = new RefKinds();
    assert.equal(kinds.scanner(), undefined);
    assert.equal(kinds.list(), undefined);
    kinds.add(kind('task', ['T', '#T']));
    const known = () => true;
    assert.deepEqual(kinds.scanner()!.find('#3, T5 and #T6', known).map((r) => [r.kind, r.number]), [['task', 5], ['task', 6]], 'no kind has a # of its own yet');
    kinds.add(kind('decision', ['#']));
    assert.deepEqual(kinds.scanner()!.find('#3, T5 and #T6', known).map((r) => [r.kind, r.number]), [['decision', 3], ['task', 5], ['task', 6]], 'a kind added later is read at once');
  });

  it('reads the marks of a kind nothing else knows, so a new kind of card needs no change to the text code', () => {
    const scanner = refScanner([
      { kind: 'task', marks: ['T', '#T'] },
      { kind: 'page', marks: ['P'] },
    ]);
    const known = (k: string, n: number) => k === 'page' || n === 5;
    assert.deepEqual(scanner.find('P4 and T5, not T6 or #5', known), [
      { kind: 'page', number: 4, start: 0, end: 2 },
      { kind: 'task', number: 5, start: 7, end: 9 },
    ]);
    assert.throws(() => refScanner([{ kind: 'a', marks: ['T'] }, { kind: 'b', marks: ['T'] }]), /written with T/);
    assert.deepEqual(refScanner([]).find('#3 and T5', () => true), [], 'no kind, no reference');
    assert.deepEqual(readRef('page:4'), { kind: 'page', number: 4 });
  });
});

describe('With nothing registered', () => {
  // The canvas alone: a page given no kinds, or an empty registry, or no
  // provider at all, shows a text as it is.
  const texts = ['Per #3, T5 builds on it; #T5 and T12 too.', '| Task | Why |\n|---|---|\n| T5 | #3 |\n\n- [ ] T5', 'Unblocks T5, per **#3**'];

  it('leaves #12 and T5 as text in Markdown, whole and inline, as with no board at all', () => {
    for (const text of texts) {
      for (const inline of [false, true]) {
        const plain = html(md(text, inline));
        assert.doesNotMatch(plain, /ref-chip|data-ref/);
        assert.equal(withKinds(undefined, md(text, inline)), plain, `a page given no kinds: ${text}`);
        assert.equal(withKinds(nothing, md(text, inline)), plain, `an empty registry: ${text}`);
      }
    }
    assert.match(withKinds(nothing, md('Per #3 and T5')), /<p>Per #3 and T5<\/p>/);
  });

  it('leaves them as text in plain text and in a chip, and a deleted card too', () => {
    for (const kinds of [undefined, nothing]) {
      assert.equal(withKinds(kinds, createElement(RefText, { text: '#3, T5, #T5 and T12', inert: true })), '#3, T5, #T5 and T12');
      assert.equal(withKinds(kinds, createElement(RefChip, { kind: 'task', number: 5 }, 'T5')), 'T5', 'a chip with its words');
      assert.equal(withKinds(kinds, createElement(RefChip, { kind: 'task', number: 12 }, 'T12')), 'T12', 'a deleted card reads as the words it was written with');
      assert.equal(withKinds(kinds, createElement(RefChip, { kind: 'task', number: 5 })), 'task 5', 'and without them, as the kind it names');
    }
    assert.equal(html(createElement(RefText, { text: 'T5' })), 'T5', 'off a board');
  });

  it('has no # list to offer and nothing to search a text with', () => {
    assert.equal(nothing.list(), undefined);
    assert.equal(nothing.scanner(), undefined);
    assert.deepEqual(nothing.kinds(), []);
  });
});
