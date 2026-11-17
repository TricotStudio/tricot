import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactionPlace } from '../src/core/store/reactions';
import { CardKinds, type AgentWork, type CardKind, type CardLink, type PinAction } from '../src/web/shared/cardKinds';
import { CardAnchor, CardKindsProvider, useCardKinds } from '../src/web/shared/cardKindsContext';

// How the canvas side of the page reaches the cards (src/web/shared/cardKinds.ts)
// without naming a kind of card: a page registers its kinds, and the canvas, the
// threads, the agents' panel and the connectors ask the registry, so a page with none
// registered is the canvas alone.

const kind = (id: string, extra: Partial<CardKind> = {}): CardKind => ({ id, ...extra });
const action = (id: string, extra: Partial<PinAction> = {}): PinAction => ({ id, label: id, does: `does ${id}`, make: async () => id, ...extra });

describe('The page’s registry of card kinds', () => {
  it('lists its kinds in the order they were added, and finds one by its id', () => {
    const cards = new CardKinds();
    assert.deepEqual(cards.kinds(), [], 'a new registry has none');
    const [task, decision] = [kind('task'), kind('decision')];
    cards.add(task);
    cards.add(decision);
    assert.deepEqual(cards.kinds(), [task, decision]);
    assert.equal(cards.find('decision'), decision);
    assert.equal(cards.find('bug'), undefined);
  });

  it('refuses a second kind of one id, which is a mistake in Tricot and not in what a person did', () => {
    const cards = new CardKinds();
    cards.add(kind('task'));
    assert.throws(() => cards.add(kind('task')), /two kinds of card named task/);
    assert.equal(cards.kinds().length, 1);
  });

  it('says where a card is only when a kind of that id says', () => {
    const cards = new CardKinds();
    const link: CardLink = { href: '#/b/b1/t/t1', open() {} };
    cards.add(kind('task', { byId: (boardId, id) => (boardId === 'b1' && id === 't1' ? link : { href: `#/b/${boardId}/t/${id}`, open() {} }) }));
    cards.add(kind('decision'));
    assert.equal(cards.byId('task', 'b1', 't1'), link);
    assert.equal(cards.byId('task', 'b2', 't9')?.href, '#/b/b2/t/t9', 'by the board’s id and its own, whatever is on screen');
    assert.equal(cards.byId('decision', 'b1', 'd1'), undefined, 'a kind that says nothing of where its cards are');
    assert.equal(cards.byId('bug', 'b1', 'x'), undefined, 'a kind nobody registered');
  });

  it('offers the pin buttons of each kind on the canvas asked, in the order the kinds were added', () => {
    const cards = new CardKinds();
    cards.add(kind('decision', { pin: (on) => (on.card === null ? action('question') : undefined) }));
    cards.add(kind('task', { pin: () => action('task', { ready: true }) }));
    cards.add(kind('note'));
    assert.deepEqual(cards.pinActions({ card: null }).map((a) => a.id), ['question', 'task'], 'on the board context and a page');
    assert.deepEqual(cards.pinActions({ card: 'decision' }).map((a) => a.id), ['task'], 'a kind can offer nothing on a card’s own canvas');
    assert.deepEqual(new CardKinds().pinActions({ card: null }), [], 'with none registered, nothing to make of a pinned part');
  });

  it('has words for the pin menu only once they are registered, and at most one set', () => {
    const cards = new CardKinds();
    assert.equal(cards.pinWords(null), undefined);
    const words = (card: string | null) => ({ placeholder: `on ${card}`, label: 'Pin', hint: '' });
    cards.wordPinsWith(words);
    assert.deepEqual(cards.pinWords('task'), { placeholder: 'on task', label: 'Pin', hint: '' });
    assert.throws(() => cards.wordPinsWith(words), /two sets of words/);
  });

  it('has plain words for the agents’ panel, nothing that counts cards and no card of a request or a thread, until they are registered', () => {
    const cards = new CardKinds();
    assert.deepEqual(cards.activityRows(), []);
    assert.equal(cards.noWork('Claude'), 'Claude has nothing claimed right now.');
    assert.equal(cards.requestCards({ board: {} as never, request: {} }), null);
    assert.equal(cards.workCard('task', { board: {} as never, id: 't1', onOpen() {} }), null);
    cards.wordAgentPanelWith({ noWork: (agent) => `${agent} has none`, activityRows: [['tasksFinished', 'Finished']] });
    assert.throws(() => cards.wordAgentPanelWith({ noWork: () => '', activityRows: [] }), /two sets of words for the agents panel/);
    assert.equal(cards.noWork('Claude'), 'Claude has none');
    assert.deepEqual(cards.activityRows(), [['tasksFinished', 'Finished']]);
    cards.requestCardsWith(() => 'cards');
    assert.throws(() => cards.requestCardsWith(() => 'again'), /two renderers of the cards a request made/);
    assert.equal(cards.requestCards({ board: {} as never, request: {} }), 'cards');
    cards.add(kind('task', { workCard: ({ id }) => `card ${id}` }));
    assert.equal(cards.workCard('task', { board: {} as never, id: 't1', onOpen() {} }), 'card t1');
    assert.equal(cards.workCard('decision', { board: {} as never, id: 'd1', onOpen() {} }), null, 'a kind that is not there draws nothing');
  });

  it('hands a reaction to the first kind that takes its place, and to none when no kind does', () => {
    const cards = new CardKinds();
    const sent: string[] = [];
    // A card's place is named by its kind (`taskId`), which the core's ReactionPlace has none of: cast.
    const at = (place: Record<string, string>) => place as ReactionPlace;
    const taking = (id: string, key: string) => kind(id, { react: (place) => (key in place ? async (commentId) => void sent.push(`${id}:${commentId}`) : undefined) });
    cards.add(taking('task', 'taskId'));
    cards.add(taking('decision', 'decisionId'));
    void cards.reaction(at({ decisionId: 'd1' }))?.('c1', 'Sam', '👍', false);
    void cards.reaction(at({ taskId: 't1' }))?.('c2', 'Sam', '👍', false);
    assert.deepEqual(sent, ['decision:c1', 'task:c2']);
    assert.equal(cards.reaction({ threadId: 'th1' }), undefined, 'a thread’s reactions are not a card’s');
    assert.equal(new CardKinds().reaction(at({ taskId: 't1' })), undefined);
  });

  it('has a plain question, and lists what an agent has claimed, only from the kinds that have them', async () => {
    const cards = new CardKinds();
    assert.equal(cards.question(), undefined);
    assert.equal(cards.hasWork(), false);
    assert.deepEqual(await cards.work('Claude'), []);
    const asks = { post: async () => undefined };
    const work = (id: string): AgentWork => ({ id, ref: id, title: id, meta: '', href: `#${id}` });
    cards.add(kind('note'));
    cards.add(kind('decision', { question: asks }));
    cards.add(kind('task', { work: async (agent) => [work(`${agent}-1`), work(`${agent}-2`)] }));
    cards.add(kind('bug', { work: async () => [work('bug')] }));
    assert.equal(cards.question(), asks);
    assert.equal(cards.hasWork(), true);
    assert.deepEqual((await cards.work('Claude')).map((w) => w.id), ['Claude-1', 'Claude-2', 'bug'], 'each kind’s, in the order added');
  });

  it('is the page’s own, handed down by a provider, and a page given none sees none', () => {
    const seen = () => createElement(function Probe() {
      return createElement('i', null, useCardKinds().kinds().map((k) => k.id).join(','));
    });
    const some = new CardKinds();
    some.add(kind('task'));
    assert.equal(renderToStaticMarkup(createElement(CardKindsProvider, { kinds: some, children: seen() })), '<i>task</i>');
    assert.equal(renderToStaticMarkup(createElement(CardKindsProvider, { kinds: new CardKinds(), children: seen() })), '<i></i>');
    assert.equal(renderToStaticMarkup(seen()), '<i></i>', 'no provider, no kind');
  });

  it('draws a link to a card as a link, or, where no kind says where the card is, as the same words in a span', () => {
    const anchor = (href: string | undefined) => renderToStaticMarkup(createElement(CardAnchor, { href, className: 'work-card', title: 'T1', children: 'Wire up Stripe' }));
    assert.equal(anchor('#/b/b1/t/t1'), '<a class="work-card" href="#/b/b1/t/t1" title="T1">Wire up Stripe</a>');
    assert.equal(anchor(undefined), '<span class="work-card" title="T1">Wire up Stripe</span>');
  });
});
