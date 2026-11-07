import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { chatStream, type ChatItem } from '../src/core/chatStream';
import { emptyCanvas } from '../src/core/canvas';
import type { BoardChange } from '../src/core/changes';
import { Store } from '../src/core/store';
import type { Actor, Board, Comment, Decision, Task, Thread } from '../src/core/types';
import { touchesChat } from '../src/cli/switcher/live';
import { removeScratch } from './platform';

// The chat's stream (T21): every conversation on a board as one, oldest
// first, each item with where it belongs. First on a real store, so the
// shapes are the board's own; then on boards made by hand, for the order;
// last, which of the board's changes bring the chat something to read again.

const me: Actor = { kind: 'human', name: 'Wassim' };
const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };
const sam: Actor = { kind: 'human', name: 'Sam' };

const where = (items: ChatItem[]) => items.map((item) => ({ by: item.author.name, body: item.body, place: item.place }));

describe('the chat’s stream, on a real board', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-chat-stream-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Roadmap' }, me).id;
  });
  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  it('holds every thread message, card comment and pinned part’s comment, each with where it belongs, and nothing else', () => {
    const general = store.startThread(boardId, '@Claude can you look at the flaky test?', me);
    store.postToThread(general.id, 'It passes alone and fails under load.', claude);
    const design = store.startThread(boardId, 'The picker feels cramped', me, { name: 'Design' });
    // A card a person adds waits in the backlog: the person sees it all the same.
    const [backlog] = store.planTasks(boardId, [{ title: 'Keep backlog quiet' }], me);
    assert.equal(backlog.status, 'backlog');
    store.addTaskComment(backlog.id, 'Is this feasible?', me);
    store.updateTask(backlog.id, { note: 'A progress note is not conversation' }, me);
    const decision = store.postDecision(boardId, { question: 'Open the tab on chat?', options: [{ label: 'Yes' }, { label: 'No' }] }, claude);
    store.addComment(decision.id, "Let's go with a.", me);
    const note = store.addBlock({ boardId }, { title: 'Plan', content: { type: 'note', text: 'Beta ships to ten teams.' } }, sam);
    const boardPin = store.pinComment(note.id, { kind: 'text', quote: 'ten teams' }, 'Which ten?', sam).pin;
    store.commentOnPin(boardPin.id, 'The ones on the wiki.', codex);
    const shot = store.addBlock({ taskId: backlog.id }, { title: 'Strip', content: { type: 'note', text: 'The strip after a stop.' } }, claude);
    const taskPin = store.pinComment(shot.id, { kind: 'text', quote: 'after a stop' }, 'This is the strip now.', claude).pin;

    // Written within the same few milliseconds, so in the board's order or by time: the order is the next tests'.
    const items = chatStream(store.getBoard(boardId));
    const task = { kind: 'task' as const, id: backlog.id, number: backlog.number, title: 'Keep backlog quiet' };
    const byBody = (list: ReturnType<typeof where>) => [...list].sort((a, b) => a.body.localeCompare(b.body));
    assert.deepEqual(byBody(where(items)), byBody([
      { by: 'Wassim', body: '@Claude can you look at the flaky test?', place: { kind: 'thread', id: general.id, title: general.title } },
      { by: 'Claude', body: 'It passes alone and fails under load.', place: { kind: 'thread', id: general.id, title: general.title } },
      { by: 'Wassim', body: 'The picker feels cramped', place: { kind: 'thread', id: design.id, title: 'The picker feels cramped', lens: 'Design' } },
      { by: 'Wassim', body: 'Is this feasible?', place: task },
      { by: 'Wassim', body: "Let's go with a.", place: { kind: 'decision', id: decision.id, number: decision.number, title: 'Open the tab on chat?' } },
      // The part as a comment on it quotes it, on the board context as on a card's canvas.
      { by: 'Sam', body: 'Which ten?', place: { kind: 'board', pin: { id: boardPin.id, quote: '“ten teams”' } } },
      { by: 'Codex', body: 'The ones on the wiki.', place: { kind: 'board', pin: { id: boardPin.id, quote: '“ten teams”' } } },
      { by: 'Claude', body: 'This is the strip now.', place: { ...task, pin: { id: taskPin.id, quote: '“after a stop”' } } },
    ]));
    const times = items.map((item) => Date.parse(item.at));
    assert.deepEqual(times, [...times].sort((a, b) => a - b), 'oldest first');
    assert.equal(new Set(items.map((item) => item.key)).size, items.length, 'each item has a key of its own');
    assert.ok(items.every((item) => typeof item.id === 'string' && item.id.length > 0));
  });

  it('carries a message’s reactions, and the title of its thread as the list shows it', () => {
    const started = store.startThread(boardId, 'Can we bundle Pi? The licence may not allow it, and we need an answer before the release goes out', me);
    const answered = store.postToThread(started.id, 'It allows it.', claude);
    const said = answered.messages.at(-1)!;
    store.react({ threadId: started.id }, { commentId: said.id, emoji: '👍' }, me);
    const items = chatStream(store.getBoard(boardId));
    assert.deepEqual(items.at(-1)!.reactions?.map((r) => [r.emoji, r.by.name]), [['👍', 'Wassim']]);
    assert.equal(items[0].reactions, undefined, 'none on a message without any');
    assert.ok(items[0].place.kind === 'thread' && items[0].place.title.startsWith('Can we bundle Pi?'));
  });
});

describe('the chat’s stream: its order', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 7, 12, minute)).toISOString();
  const comment = (id: string, author: Actor, body: string, minute: number): Comment => ({ id, author, body, createdAt: at(minute) });
  const thread = (id: string, messages: [string, Actor, string, number][], more: Partial<Thread> = {}): Thread => ({
    id,
    title: messages[0][2],
    startedBy: messages[0][1],
    startedAt: at(messages[0][3]),
    updatedAt: at(messages.at(-1)![3]),
    messages: messages.map(([mid, author, body, minute]) => ({ id: mid, author, body, at: at(minute) })),
    ...more,
  });
  const task = (id: string, number: number, title: string, comments: Comment[], status: Task['status'] = 'todo'): Task => ({ id, number, title, status, decisionIds: [], links: [], notes: [], comments, canvas: emptyCanvas(), createdBy: me, createdAt: at(0), updatedAt: at(0) });
  const decision = (id: string, number: number, question: string, comments: Comment[]): Decision => ({ id, number, question, comments, boardId: 'b', options: [], status: 'open', blocking: false, dependsOn: [], history: [], asks: [], criteria: [], marks: [], findings: [], canvas: emptyCanvas(), createdBy: claude, createdAt: at(0), updatedAt: at(0) });
  const boardOf = (more: Partial<Board>): Board => ({ id: 'b', title: 'B', createdBy: me, createdAt: at(0), updatedAt: at(0), seq: 0, nextDecisionNumber: 1, nextTaskNumber: 1, canvas: emptyCanvas(), decisions: [], tasks: [], activity: { actors: [], done: {}, reviewSentAt: {} }, ...more });

  it('merges every source by time, oldest first, whatever the card’s lane', () => {
    const board = boardOf({
      threads: [thread('th', [['m1', me, 'First', 1], ['m2', claude, 'Fifth', 5]], { lens: { name: 'General' } })],
      tasks: [task('t1', 17, 'Keep backlog quiet', [comment('c1', codex, 'Third', 3)], 'backlog'), task('t2', 18, 'Dropped work', [comment('c2', me, 'Sixth', 6)], 'dropped')],
      decisions: [decision('d1', 7, 'Open on chat?', [comment('c3', claude, 'Second', 2)])],
      canvas: { ...emptyCanvas(), pins: [{ id: 'p1', blockId: 'x', anchor: { kind: 'block' }, quote: 'Plan', author: sam, createdAt: at(4), discussion: { thread: [comment('c4', sam, 'Fourth', 4)] } }] },
    });
    const items = chatStream(board);
    assert.deepEqual(items.map((item) => item.body), ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth']);
    assert.deepEqual(items[0].place, { kind: 'thread', id: 'th', title: 'First' }, 'General is no lens to name');
  });

  it('keeps the board’s order for items written at the same moment', () => {
    const board = boardOf({
      threads: [thread('th', [['m1', me, 'In the thread', 1]])],
      tasks: [task('t1', 1, 'A task', [comment('c1', claude, 'On the task', 1)])],
      decisions: [decision('d1', 1, 'A decision', [comment('c2', claude, 'On the decision', 1)])],
    });
    assert.deepEqual(chatStream(board).map((item) => item.body), ['In the thread', 'On the task', 'On the decision']);
  });

  it('is empty for a board with no conversation, and leaves out a pin with no comments', () => {
    const board = boardOf({ canvas: { ...emptyCanvas(), pins: [{ id: 'p1', blockId: 'x', anchor: { kind: 'block' }, quote: 'Plan', author: sam, createdAt: at(4), taskId: 't9' }] } });
    assert.deepEqual(chatStream(board), []);
  });
});

describe('the board’s changes that touch the chat', () => {
  const change = (more: Partial<BoardChange>): BoardChange => ({ ver: 2, seq: 2, ...more });

  it('counts a thread, a comment and what names the card a comment is on', () => {
    assert.ok(touchesChat(change({ reload: true })), 'too much to say');
    assert.ok(touchesChat(change({ patch: [{ kind: 'thread', id: 'th', append: { messages: { from: 1, items: [{}] } } }] })));
    assert.ok(touchesChat(change({ patch: [{ kind: 'task', id: 't', append: { comments: { from: 0, items: [{}] } } }] })), 'a comment on a task');
    assert.ok(touchesChat(change({ patch: [{ kind: 'decision', id: 'd', set: { comments: [] } }] })), 'a reaction on a decision’s comment');
    assert.ok(touchesChat(change({ patch: [{ kind: 'task', id: 't', set: { title: 'Renamed' } }] })), 'a task renamed');
    assert.ok(touchesChat(change({ patch: [{ kind: 'decision', id: 'd', set: { question: 'Reworded?' } }] })), 'a question reworded');
    assert.ok(touchesChat(change({ patch: [{ kind: 'pin', id: 'p', owner: 'board', set: { discussion: { thread: [] } } }] })), 'a comment on a pinned part');
    assert.ok(touchesChat(change({ put: [{ kind: 'pin', id: 'p', owner: 'board', pos: 0, body: { discussion: { thread: [{}] } } }] })), 'a part pinned with a comment');
    assert.ok(touchesChat(change({ del: [{ kind: 'task', id: 't' }] })), 'a card deleted, with its discussion');
    assert.ok(touchesChat(change({ del: [{ kind: 'pin', id: 'p', owner: 'board' }] })), 'a pin of the board context gone, with its comments');
    assert.ok(touchesChat(change({ events: [{ seq: 2, at: '', actor: me, type: 'comment_added', summary: '' }] })));
  });

  it('leaves out what the chat doesn’t show', () => {
    assert.ok(!touchesChat(change({ patch: [{ kind: 'task', id: 't', append: { notes: { from: 0, items: [{}] } }, set: { status: 'in_progress' } }] })), 'a progress note');
    assert.ok(!touchesChat(change({ put: [{ kind: 'task', id: 't', pos: 0, body: { title: 'New', comments: [] } }] })), 'a new card, with nothing said on it yet');
    assert.ok(!touchesChat(change({ put: [{ kind: 'block', id: 'b', owner: 'board', pos: 0, body: {} }] })), 'a block');
    assert.ok(!touchesChat(change({ del: [{ kind: 'pin', id: 'p', owner: 'task:t' }] })), 'a pin on a card’s canvas, whose comments stay in its discussion');
    assert.ok(!touchesChat(change({ head: { title: 'Renamed board' }, events: [{ seq: 2, at: '', actor: me, type: 'board_updated', summary: '' }] })));
  });
});
