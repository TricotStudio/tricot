import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chatStream, type ChatPlace } from '../src/core/chatStream';
import { emptyCanvas } from '../src/core/canvas';
import type { Actor, Board, Comment, Decision, Pin, Task, Thread } from '../src/core/types';
import type { AgentPresence } from '../src/server/presence';
import { aimRow, answerable, latestFrom, NAMING, named, placeChoices, reactOn, replyOn, withComment, type CardPlace } from '../src/cli/switcher/chatAim';
import { hearsIt } from '../src/cli/switcher/threadsWho';

// Where the line under the chat's stream sends what is typed (T21): the
// latest message from someone else, a place named after a >, and what Tab
// lists for one; the row that says where it goes and who hears it there;
// and where a reply or a reaction goes on the board. The tab that holds the
// line is switcherThreads.test.ts's.

const NOW = Date.parse('2026-11-07T16:30:00Z');
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const me: Actor = { kind: 'human', name: 'Wassim' };
const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };
const sam: Actor = { kind: 'human', name: 'Sam' };

let counter = 0;
const comment = (author: Actor, body: string, msAgo: number, more: Partial<Comment> = {}): Comment => ({ id: `c${++counter}`, author, body, createdAt: ago(msAgo), ...more });
const thread = (id: string, title: string, messages: [Actor, string, number][], more: Partial<Thread> = {}): Thread => {
  const list = messages.map(([author, body, msAgo]) => ({ id: `m${++counter}`, author, body, at: ago(msAgo) }));
  return { id, title, startedBy: list[0].author, startedAt: list[0].at, updatedAt: list.at(-1)!.at, messages: list, ...more };
};
const task = (number: number, title: string, comments: Comment[], more: Partial<Task> = {}) => ({ id: `t${number}`, number, title, status: 'todo', comments, canvas: emptyCanvas(), ...more }) as unknown as Task;
const pinOn = (id: string, quote: string, discussion?: Pin['discussion']): Pin => ({ id, blockId: 'b1', anchor: { kind: 'text', prefix: '', suffix: '' }, quote, author: sam, createdAt: ago(60 * MIN), ...(discussion && { discussion }) });

const P2 = pinOn('p2', 'the strip after a stop', {});
const BETA = pinOn('p1', 'Beta ships to ten teams', { thread: [comment(sam, 'Which ten?', 25 * MIN)] });
const BOARD = {
  id: 'roadmap',
  title: 'Roadmap',
  threads: [
    thread('w', "Pick up Codex's work", [[me, "@Claude pick up Codex's work", 40 * MIN], [claude, 'T17 is ready for you to review.', 2 * MIN]]),
    thread('d', 'Picker spacing', [[codex, 'Tighter: 8 px between rows.', 30 * MIN]], { lens: { name: 'Design' } }),
    thread('l', 'Licence check', [[sam, 'Is MIT fine?', 50 * MIN]]),
  ],
  tasks: [
    task(1, 'Set up CI', []),
    task(17, 'Keep backlog quiet', [comment(codex, 'T17 is ready to review.', 12 * MIN)], { status: 'backlog' }),
    task(19, 'Stopped agents leave the strip', [comment(claude, 'This is the strip now.', 10 * MIN, { pin: { id: 'p2', quote: '“the strip after a stop”' } })], { status: 'in_progress', assignee: 'Claude', canvas: { ...emptyCanvas(), pins: [P2] } }),
  ],
  decisions: [{ id: 'd7', number: 7, question: 'Open the Tricot tab on chat?', comments: [comment(me, "Let's go with a.", MIN)] } as unknown as Decision],
  canvas: { ...emptyCanvas(), pins: [BETA] },
  activity: { actors: [me, claude, codex, sam].map((actor) => ({ actor, at: ago(0) })), done: {}, reviewSentAt: {} },
} as unknown as Board;
const ITEMS = chatStream(BOARD);

const T17: ChatPlace = { kind: 'task', id: 't17', number: 17, title: 'Keep backlog quiet' };
const T19: ChatPlace = { kind: 'task', id: 't19', number: 19, title: 'Stopped agents leave the strip' };
const T19_PIN: CardPlace = { ...T19, pin: { id: 'p2', quote: '“the strip after a stop”' } } as CardPlace;
const D7: ChatPlace = { kind: 'decision', id: 'd7', number: 7, title: 'Open the Tricot tab on chat?' };
const ON_BETA: CardPlace = { kind: 'board', pin: { id: 'p1', quote: '“Beta ships to ten teams”' } };

describe('what the stream’s line answers', () => {
  it('is the latest message from someone else: the person’s own are passed over', () => {
    assert.equal(ITEMS.at(-1)!.author.name, 'Wassim', 'the latest of all is the person’s');
    const latest = latestFrom(ITEMS, 'Wassim');
    assert.equal(latest?.body, 'T17 is ready for you to review.');
    assert.deepEqual(latest?.place, { kind: 'thread', id: 'w', title: "Pick up Codex's work" });
    assert.ok(answerable(ITEMS, 'wassim').every((item) => item.author.name !== 'Wassim'), 'the person, however written');
    assert.equal(latestFrom(ITEMS.filter((item) => item.author.name === 'Wassim'), 'Wassim'), undefined, 'none when only the person wrote');
  });
});

describe('a place named after >', () => {
  it('names a task by T and its number, a decision by # and its number, the rest being the message', () => {
    assert.deepEqual(named('>T19 Ship it', BOARD), { kind: 'place', place: T19, text: 'Ship it' });
    assert.deepEqual(named('>t19   ship it ', BOARD), { kind: 'place', place: T19, text: 'ship it' });
    assert.deepEqual(named('>#7 Yes, a.', BOARD), { kind: 'place', place: D7, text: 'Yes, a.' });
    assert.deepEqual(named('>T19', BOARD), { kind: 'place', place: T19, text: '' }, 'nothing after it yet');
  });

  it('names a thread by as many words of its title as some title has, the rest being the message', () => {
    assert.deepEqual(named('>picker 6 px then?', BOARD), { kind: 'place', place: { kind: 'thread', id: 'd', title: 'Picker spacing', lens: 'Design' }, text: '6 px then?' });
    assert.deepEqual(named(">Pick up Codex's work Thanks", BOARD), { kind: 'place', place: { kind: 'thread', id: 'w', title: "Pick up Codex's work" }, text: 'Thanks' });
    assert.deepEqual(named('>licence   MIT is fine', BOARD), { kind: 'place', place: { kind: 'thread', id: 'l', title: 'Licence check' }, text: 'MIT is fine' });
  });

  it('leaves a > followed by a space, or no > at the start, as plain text', () => {
    assert.equal(named('> a quoted line', BOARD), undefined);
    assert.equal(named('plain >T19', BOARD), undefined);
    assert.equal(named('', BOARD), undefined);
  });

  it('says why when it names nothing: a card the board doesn’t have, a title nobody has, words several titles have', () => {
    assert.deepEqual(named('>T99 hi', BOARD), { kind: 'unknown', why: 'There is no T99 on this board.' });
    assert.deepEqual(named('>#12 hi', BOARD), { kind: 'unknown', why: 'There is no #12 on this board.' });
    assert.deepEqual(named('>budget hi', BOARD), { kind: 'unknown', why: `No thread's title has “budget” in it. ${NAMING}` });
    assert.deepEqual(named('>pick hello', BOARD), { kind: 'unknown', why: "“pick” is in 2 threads' titles: Tab chooses one." });
    assert.deepEqual(named('>', BOARD), { kind: 'unknown', why: NAMING });
  });
});

describe('what Tab lists after a >', () => {
  const labels = (query: string) => placeChoices(BOARD, ITEMS, query).map((c) => `${c.label} ${c.note}`);

  it('lists cards by their number, the one that is it first, then those talked in latest, each with its title', () => {
    assert.deepEqual(labels('T1'), ['>T1 Set up CI', '>T19 Stopped agents leave the strip', '>T17 Keep backlog quiet']);
    assert.deepEqual(labels('#'), ['>#7 Open the Tricot tab on chat?']);
    assert.deepEqual(placeChoices(BOARD, ITEMS, 't19')[0], { write: 'T19', label: '>T19', note: 'Stopped agents leave the strip' });
  });

  it('lists threads by words of their title, writing the title whole, with the lens', () => {
    assert.deepEqual(labels('pick'), [">Pick up Codex's work thread", '>Picker spacing Design thread']);
    assert.equal(placeChoices(BOARD, ITEMS, 'spacing')[0].write, 'Picker spacing');
    assert.deepEqual(labels('the strip'), ['>T19 Stopped agents leave the strip'], 'a card by its title too');
  });

  it('lists everything for a > alone, the latest talked in first, and no more than eight; nothing for what fits nothing', () => {
    assert.deepEqual(labels('').slice(0, 3), ['>#7 Open the Tricot tab on chat?', ">Pick up Codex's work thread", '>T19 Stopped agents leave the strip']);
    assert.equal(labels('').length, 7);
    assert.deepEqual(labels('zzz'), []);
  });
});

describe('the row under the stream’s line', () => {
  it('says where it goes and who hears it, cutting the part pinned first and then the title', () => {
    assert.equal(aimRow(T19, ', the latest', 'Claude hears it', 80), 'to T19 Stopped agents leave the strip, the latest · Claude hears it');
    assert.equal(aimRow(T19_PIN, '', 'Claude hears it', 120), 'to T19 Stopped agents leave the strip, about “the strip after a stop” · Claude hears it');
    assert.equal(aimRow(T19_PIN, ', the one chosen', 'Claude hears it', 80), 'to T19 Stopped agents leave the strip, the one chosen · Claude hears it');
    assert.equal(aimRow(T19, ', the latest', 'Claude hears it', 50), 'to T19 Stopped ag…, the latest · Claude hears it');
    assert.equal(aimRow(ON_BETA, ', the latest', 'Sam', 80), 'to the board, about “Beta ships to ten teams”, the latest · Sam');
    assert.equal(aimRow({ kind: 'thread', id: 'w', title: "Pick up Codex's work" }, ', the latest', 'Claude hears it', 80), "to Pick up Codex's work, the latest · Claude hears it");
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(aimRow({ kind: 'thread', id: 'x', title: 'Bad\u001b[2J title\u0007' }, '', 'Claude hears it', 80)), 'drawn safe');
  });
});

describe('who hears it, in a few words', () => {
  const listening = (...names: string[]): AgentPresence[] => names.map((name) => ({ name, lastSeen: ago(0), state: 'listening' }));
  const hears = (where: Parameters<typeof hearsIt>[0], presence: AgentPresence[], text = '', connected: string[] = ['Claude']) =>
    hearsIt(where, { board: BOARD, text, names: ['Claude', 'Codex', 'Sam', 'Wassim'], presence, connected });
  const [w, d] = BOARD.threads!;
  const [, t17, t19] = BOARD.tasks;
  const [d7] = BOARD.decisions;

  it('in a thread: the agent it answers, and whether it is listening, between steps or not here', () => {
    assert.deepEqual(hears({ thread: w }, listening('Claude', 'Codex')), { text: 'Claude hears it', tone: 'normal' });
    assert.deepEqual(hears({ thread: w }, [{ name: 'Claude', lastSeen: ago(0), state: 'working' }]), { text: 'Claude hears it at the next check', tone: 'normal' });
    assert.deepEqual(hears({ thread: d }, listening('Claude')), { text: "Codex isn't listening here", tone: 'alert' }, 'the agent that wrote in it');
    assert.deepEqual(hears({ thread: w }, listening('Claude'), '@Sam what do you think?'), { text: 'for Sam only', tone: 'normal' });
  });

  it('on a task: its assignee, or the agent that claimed it once under way; else any agent here', () => {
    assert.deepEqual(hears({ task: t19 }, listening('Claude', 'Codex')), { text: 'Claude hears it', tone: 'normal' }, 'the assignee only');
    const claimed = { ...t19, assignee: undefined, claimedBy: codex } as Task;
    assert.deepEqual(hears({ task: claimed }, listening('Claude', 'Codex')), { text: 'Codex hears it', tone: 'normal' });
    assert.deepEqual(hears({ task: { ...claimed, claimedBy: undefined, status: 'todo' } as Task }, listening('Claude', 'Codex')), { text: 'Claude and Codex hear it', tone: 'normal' });
    assert.deepEqual(hears({ task: t19 }, listening('Codex')), { text: "Claude isn't listening here", tone: 'alert' });
  });

  it('on a backlog card: only people, unless an agent is @-mentioned or was on it', () => {
    assert.deepEqual(hears({ task: t17 }, listening('Claude', 'Codex')), { text: 'only people see it: agents skip the backlog', tone: 'normal' });
    assert.deepEqual(hears({ task: t17 }, listening('Claude', 'Codex'), '@Claude can you take it?'), { text: 'Claude hears it', tone: 'normal' });
    const mentioned = { ...t17, comments: [...t17.comments, comment(me, '@Codex look', MIN, { mentions: ['Codex'] })] } as Task;
    assert.deepEqual(hears({ task: mentioned }, listening('Claude', 'Codex')), { text: 'Codex hears it', tone: 'normal' });
  });

  it('on a decision or the board context: any agent here, and people only when none is', () => {
    assert.deepEqual(hears({ decision: d7 }, listening('Claude', 'Codex')), { text: 'Claude and Codex hear it', tone: 'normal' });
    assert.deepEqual(hears({ boardContext: true }, listening('A', 'B', 'C')), { text: '3 agents hear it', tone: 'normal' });
    assert.deepEqual(hears({ decision: d7 }, []), { text: "Claude isn't listening here", tone: 'alert' }, 'one this terminal runs');
    assert.deepEqual(hears({ decision: d7 }, [], '', []), { text: 'no agent is listening: people see it', tone: 'alert' });
    assert.deepEqual(hears({ thread: BOARD.threads![2] }, [], '', []), { text: 'no agent is listening: it waits for one', tone: 'alert' });
  });
});

describe('where an answer goes on the board', () => {
  it('replies about a pinned part while its pin is there, else in its card’s discussion', () => {
    assert.deepEqual(replyOn(ON_BETA, BOARD), { on: { kind: 'pin', id: 'p1' }, place: ON_BETA });
    assert.deepEqual(replyOn(T19_PIN, BOARD), { on: { kind: 'pin', id: 'p2' }, place: T19_PIN });
    const gone = { ...BOARD, tasks: BOARD.tasks.map((t) => ({ ...t, canvas: emptyCanvas() })) } as Board;
    assert.deepEqual(replyOn(T19_PIN, gone), { on: { kind: 'task', id: 't19' }, place: T19 });
    assert.deepEqual(replyOn(D7 as CardPlace, BOARD), { on: { kind: 'decision', id: 'd7' }, place: D7 });
  });

  it('reacts to a comment by its card, a pinned part’s included, or by its pin on the board context', () => {
    assert.deepEqual(reactOn(T19_PIN), { kind: 'task', id: 't19' });
    assert.deepEqual(reactOn(D7 as CardPlace), { kind: 'decision', id: 'd7' });
    assert.deepEqual(reactOn(ON_BETA), { kind: 'pin', id: 'p1' });
  });

  it('puts the board’s answer where it is: a reply after the rest, a reaction’s comment in place of the one it was', () => {
    const reply = comment(me, 'Ten teams.', 0);
    const replied = withComment(BOARD, ON_BETA, reply);
    assert.deepEqual(replied.canvas.pins[0].discussion?.thread?.map((c) => c.body), ['Which ten?', 'Ten teams.']);
    const [first] = BOARD.tasks[1].comments;
    const reacted = withComment(BOARD, T17 as CardPlace, { ...first, reactions: [{ emoji: '👍', by: me, at: ago(0) }] });
    assert.equal(reacted.tasks[1].comments.length, 1);
    assert.equal(reacted.tasks[1].comments[0].reactions?.[0].emoji, '👍');
    assert.deepEqual(withComment(BOARD, D7 as CardPlace, reply).decisions[0].comments.map((c) => c.body), ["Let's go with a.", 'Ten teams.']);
    assert.equal(BOARD.canvas.pins[0].discussion?.thread?.length, 1, 'the board as read is left as it was');
  });
});
