import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { dismissable, needsFrom } from '../src/core/needs';
import { Store } from '../src/core/store';
import { cardsFromYourThreads, madeInWords, QUIET_AFTER, QUIET_AFTER_MADE, threadGroups, threadMade, threadTag, threadsWaitingOn, waitsOnYou, type ThreadsSeen } from '../src/core/threadList';
import type { Actor, Board, Thread } from '../src/core/types';
import { removeScratch } from './platform';

// The threads list (core/threadList.ts): every thread, waiting on you first,
// then the latest, the finished and quiet ones under Earlier, each with where
// it was started and what it made; and the threads waiting on you counted in
// "need you", each once.

const claude: Actor = { kind: 'agent', name: 'Claude' };
const wassim: Actor = { kind: 'human', name: 'Wassim' };
const sam: Actor = { kind: 'human', name: 'Sam' };
const DAY = 24 * 60 * 60 * 1000;

describe('The threads list', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-threadlist-'));
    store = new Store(dir);
    store.load();
    store.presentAgents = () => ['Claude'];
    boardId = store.createBoard({ title: 'Ledgerly' }, wassim).id;
    store.postDecision(boardId, { question: 'Monthly or yearly first?' }, sam); // Sam is one of the board's people
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  const board = () => store.getBoard(boardId);
  const thread = (id: string) => store.getThread(id).thread;
  // Seen up to each thread's latest message, as when the viewer has read them all.
  const seenAll = (): ThreadsSeen => Object.fromEntries((board().threads ?? []).map((t) => [t.id, t.messages.at(-1)!.id]));
  const seenUpTo = (t: Thread, index: number) => t.messages[index].id;
  // A thread last active `ago` milliseconds before `now`.
  const quiet = (t: Thread, now: number, ago: number) => {
    thread(t.id).updatedAt = new Date(now - ago).toISOString();
  };

  it("waits on you when an agent wrote last in your thread and you haven't seen it", () => {
    const t = store.startThread(boardId, 'Not sure about the pricing page: one plan or three?', wassim, undefined, { door: 'decisions' });
    const first = seenUpTo(thread(t.id), 0);
    assert.equal(waitsOnYou(board(), thread(t.id), 'Wassim', first), false, "it's the agent's turn");

    store.postToThread(t.id, 'Should a team that picked a plan get 14 days or 30?', claude);
    assert.equal(waitsOnYou(board(), thread(t.id), 'Wassim', first), true, 'an agent asked');
    assert.equal(waitsOnYou(board(), thread(t.id), 'wassim', undefined), true, 'never seen at all');
    assert.equal(waitsOnYou(board(), thread(t.id), 'Sam', undefined), false, "someone else's thread");
    assert.equal(waitsOnYou(board(), thread(t.id), 'Wassim', seenUpTo(thread(t.id), 1)), false, 'seen');

    store.postToThread(t.id, '14 days.', wassim);
    assert.equal(waitsOnYou(board(), thread(t.id), 'Wassim', first), false, 'answered, from another browser even');

    store.postToThread(t.id, '@Sam, does 14 days work for sales?', claude);
    assert.equal(waitsOnYou(board(), thread(t.id), 'Wassim', first), false, 'it asked someone else');
    assert.equal(waitsOnYou(board(), thread(t.id), 'Sam', undefined), true, 'mentioned, it waits on them');

    const asking = store.startThread(boardId, 'Shall I tidy the decision map?', claude);
    assert.equal(waitsOnYou(board(), thread(asking.id), 'Wassim', undefined), true, "an agent's question to the board's people");
    assert.equal(waitsOnYou(board(), thread(asking.id), 'Wassim', seenUpTo(thread(asking.id), 0)), false);
  });

  it('lists what waits on you first, then the latest, with finished and quiet ones under Earlier', () => {
    const now = Date.parse('2026-11-02T12:00:00Z');
    const start = (text: string, door: Thread['door']) => store.startThread(boardId, text, wassim, undefined, { door });
    const reply = (t: Thread, text: string) => store.postToThread(t.id, text, claude);

    const waiting = start('Trial length for teams from the pricing page', 'decisions');
    reply(waiting, 'Should a team that picked a plan get 14 days or 30?');
    const made = start('Stripe or Paddle for billing?', 'decisions');
    const card = store.postDecision(boardId, { question: 'Which payment provider runs subscriptions?', options: [{ label: 'Stripe' }, { label: 'Paddle' }] }, claude);
    store.addThreadWork(made.id, { kind: 'decision', id: card.id }, claude);
    reply(made, 'Posted it as a card.');
    const askedAgent = start('Map the sign-up flow', 'canvas');
    const talked = start('What should the second failed-payment email say?', 'tasks');
    reply(talked, 'Two versions, then?');
    const old = start('What do agencies compare us with?', 'threads');
    reply(old, 'Mostly spreadsheets.');
    const latest = start('The VAT numbers look off for Norway', 'threads');
    reply(latest, 'Good catch: the 2026 rate.');

    const seen = { ...seenAll(), [waiting.id]: seenUpTo(thread(waiting.id), 0) };
    quiet(waiting, now, 12 * 60_000);
    quiet(made, now, QUIET_AFTER_MADE + 60_000); // made its card, quiet a day: Earlier
    quiet(askedAgent, now, 3 * DAY); // waits on an agent: never Earlier
    quiet(talked, now, 2 * DAY); // made nothing, quiet two days: still Recent
    quiet(old, now, QUIET_AFTER + DAY); // made nothing, quiet over a week: Earlier
    quiet(latest, now, 2 * 60_000);

    const groups = threadGroups(board(), 'Wassim', seen, now);
    const titles = (entries: { thread: Thread }[]) => entries.map((e) => e.thread.title);
    assert.deepEqual(titles(groups.waiting), ['Trial length for teams from the pricing page']);
    assert.deepEqual(titles(groups.recent), ['The VAT numbers look off for Norway', 'What should the second failed-payment email say?', 'Map the sign-up flow'], 'the latest first');
    assert.deepEqual(titles(groups.earlier), ['Stripe or Paddle for billing?', 'What do agencies compare us with?']);
    assert.deepEqual(
      [...groups.waiting, ...groups.recent, ...groups.earlier].map((e) => [e.tag, e.made]),
      [
        ['Decisions', []],
        [undefined, []],
        ['Tasks', []],
        ['Board Context', []],
        ['Decisions', [`#${card.number}`]],
        [undefined, []],
      ],
      'where each was started, the open-ended door untagged, and what it made',
    );
    assert.deepEqual(threadsWaitingOn(board(), 'Wassim', seen).map((t) => t.id), [waiting.id], "the threads button's count");

    const fresh = threadGroups(board(), 'Wassim', null, now);
    assert.equal(fresh.waiting.length, 0, 'nothing seen remembered: nothing waits, as on a first visit');
    assert.equal(threadsWaitingOn(board(), 'Wassim', null).length, 0);
  });

  it('tags where a thread was started', () => {
    const tag = (door: Thread['door'], general?: true) => threadTag({ door, general });
    assert.deepEqual(
      [tag('decisions'), tag('tasks'), tag('canvas'), tag('threads'), tag(undefined), tag(undefined, true)],
      ['Decisions', 'Tasks', 'Board Context', undefined, undefined, 'Board Context'],
    );
  });

  it('names what agents made with its id: cards it made, blocks, but not cards a reply only named', () => {
    const t = store.startThread(boardId, 'Plan the billing settings page', wassim, undefined, { door: 'tasks' });
    const [task] = store.planTasks(boardId, [{ title: 'Wire the billing settings page' }], claude);
    store.addThreadWork(t.id, { kind: 'task', id: task.id }, claude);
    const block = store.addBlock({ boardId }, { title: 'Settings flow', content: { type: 'note', text: 'Plan, seats, invoices.' } }, claude);
    store.addThreadWork(t.id, { kind: 'block', id: block.id }, claude);
    const elsewhere = board().decisions[0];
    store.postToThread(t.id, `Planned it, and drew the flow. It follows #${elsewhere.number}.`, claude, [`#${elsewhere.number}`]);
    assert.deepEqual(threadMade(board(), thread(t.id)), [`T${task.number}`, '1 block']);
  });

  it('says what a thread made in plain words, without numbers', () => {
    assert.deepEqual(
      [[], ['#78'], ['T48'], ['T48', 'T49'], ['3 blocks'], ['1 block'], ['#78', 'T48'], ['#78', '#79', 'T48', '2 blocks']].map(madeInWords),
      [undefined, 'made a question', 'made a task', 'made 2 tasks', 'added 3 blocks', 'added a block', 'made a question and a task', 'made 2 questions and a task, added 2 blocks'],
    );
  });
});

describe('Threads waiting on you, in "need you"', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-threadneeds-'));
    store = new Store(dir);
    store.load();
    store.presentAgents = () => ['Claude'];
    boardId = store.createBoard({ title: 'Ledgerly' }, wassim).id;
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  const board = (): Board => store.getBoard(boardId);

  it('counts each thread waiting on you once, beside the cards, and not when its card already counts', () => {
    const open = store.postDecision(boardId, { question: 'Monthly or yearly first?', options: [{ label: 'Monthly' }, { label: 'Yearly' }] }, claude);
    const since = board().seq;
    const asked = store.startThread(boardId, 'Trial length for teams', wassim, undefined, { door: 'decisions' });
    const drafted = store.startThread(boardId, 'Not sure about the pricing page: one plan or three?', wassim, undefined, { door: 'decisions' });
    const seen: ThreadsSeen = Object.fromEntries([asked, drafted].map((t) => [t.id, t.messages[0].id]));
    store.postToThread(asked.id, 'Should a team that picked a plan get 14 days or 30?', claude);
    const card = store.postDecision(boardId, { question: 'How many plans on the pricing page?', options: [{ label: 'One' }, { label: 'Three' }] }, claude);
    store.addThreadWork(drafted.id, { kind: 'decision', id: card.id }, claude);
    store.postToThread(drafted.id, 'I drafted the card, leaning to one per-seat plan.', claude);

    const unseen = store.events(boardId, { since, unseenBy: 'Wassim' });
    const needs = needsFrom(board(), 'Wassim', unseen, {}, seen);
    assert.deepEqual(
      needs.map((n) => [n.kind, n.title]).sort(),
      [
        ['open', 'How many plans on the pricing page?'],
        ['open', 'Monthly or yearly first?'],
        ['thread', 'Trial length for teams'],
      ],
      "the drafted card stands for its thread; the threads' events add nothing more",
    );
    const waiting = needs.find((n) => n.kind === 'thread')!;
    assert.deepEqual(waiting.target, { kind: 'thread', id: asked.id, view: 'decisions' });
    assert.deepEqual([waiting.why, waiting.action, dismissable(waiting)], ['Claude replied', 'Reply', false]);
    assert.equal(open.status, 'open');

    assert.equal(needsFrom(board(), 'Wassim', unseen).length, 2, 'without what was seen, cards only, as Home counts');
    const read = { ...seen, [asked.id]: store.getThread(asked.id).thread.messages.at(-1)!.id };
    assert.equal(needsFrom(board(), 'Wassim', unseen, {}, read).filter((n) => n.kind === 'thread').length, 0, 'opened, it leaves');
    assert.equal(needsFrom(board(), 'Sam', [], {}, {}).filter((n) => n.kind === 'thread').length, 0, "not Sam's threads");
  });
});

describe('What an agent made from your conversation', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-justmade-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Ledgerly' }, wassim).id;
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  it('finds the cards an agent made from a thread you started or wrote in, and only those', () => {
    const mine = store.startThread(boardId, 'Not sure about the pricing page: one plan or three?', wassim, undefined, { door: 'decisions' });
    const sams = store.startThread(boardId, 'Which currencies at launch?', sam, undefined, { door: 'decisions' });
    const joined = store.startThread(boardId, 'The second failed-payment email', sam, undefined, { door: 'tasks' });
    store.postToThread(joined.id, 'Two versions, please.', wassim);
    const plans = store.postDecision(boardId, { question: 'How many plans should the pricing page show?' }, claude);
    store.addThreadWork(mine.id, { kind: 'decision', id: plans.id }, claude);
    const currencies = store.postDecision(boardId, { question: 'Which currencies do prices show in?' }, claude);
    store.addThreadWork(sams.id, { kind: 'decision', id: currencies.id }, claude);
    const [email] = store.planTasks(boardId, [{ title: 'Second failed-payment email' }], claude);
    store.addThreadWork(joined.id, { kind: 'task', id: email.id }, claude);
    const own = store.postDecision(boardId, { question: 'Monthly or yearly first?' }, wassim);
    store.addThreadWork(mine.id, { kind: 'decision', id: own.id }, wassim);
    store.postDecision(boardId, { question: 'Offer a lifetime deal?' }, claude); // from no thread

    const board = store.getBoard(boardId);
    assert.deepEqual(
      cardsFromYourThreads(board, 'Wassim').sort(),
      [plans.id, email.id].sort(),
      "your thread and one you wrote in; not Sam's, not a person's own card, not one from no thread",
    );
    assert.deepEqual(cardsFromYourThreads(board, 'sam').sort(), [currencies.id, email.id].sort());
  });
});
