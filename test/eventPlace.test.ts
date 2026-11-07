import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { needsInput } from '../src/core/attention';
import { eventPlace } from '../src/core/eventPlace';
import { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import { eventsOf } from './tables';
import { removeScratch } from './platform';

// Where an event leads (core/eventPlace.ts): the one rule the Activity log,
// the inbox and a board's notifications open, here for each kind of event
// Tricot notifies of (core/attention.ts), each made by the store as agents
// and people make it. A click on a notification lands on what it was about.

const claude: Actor = { kind: 'agent', name: 'Claude' };
const sam: Actor = { kind: 'human', name: 'Sam' };

describe('Where an event leads', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-event-place-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'B' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  const board = () => store.getBoard(boardId);
  const last = () => eventsOf(store, boardId).at(-1)!;
  // The latest event, which Sam is notified of, and where it leads.
  const notified = () => {
    const event = last();
    assert.equal(needsInput(event, board(), 'Sam'), true, `Sam is notified of "${event.summary}"`);
    return { event, place: eventPlace(board(), event) };
  };
  // A question Sam asked and settled, for tasks to implement.
  const decision = () => {
    const d = store.postDecision(boardId, { question: 'Q?', options: [{ label: 'a' }, { label: 'b' }] }, sam);
    return store.resolve(d.id, { optionId: d.options[0].id }, sam);
  };

  it('opens the decision a question, an ask, a reply, a refresh or an agent’s call is about', () => {
    const asked = store.postDecision(boardId, { question: 'Which font?', options: [{ label: 'a' }, { label: 'b' }] }, claude);
    assert.deepEqual(notified().place, { kind: 'decision', id: asked.id }, 'a new question');
    store.askPeople(asked.id, ['Sam'], 'you know this', claude);
    assert.deepEqual(notified().place, { kind: 'decision', id: asked.id }, 'asked of Sam');
    store.addComment(asked.id, 'Leaning a.', claude);
    assert.deepEqual(notified().place, { kind: 'decision', id: asked.id }, 'a reply on it');
    store.resolve(asked.id, { optionId: asked.options[0].id, provisional: true }, claude);
    assert.deepEqual(notified().place, { kind: 'decision', id: asked.id }, "an agent's call to confirm");
  });

  it('opens the task a comment, an @-mention or blocked work is about, not its decision', () => {
    const d = decision();
    const [task] = store.planTasks(boardId, [{ title: 'Build it', decisionIds: [d.id] }], sam);
    store.addTaskComment(task.id, 'How should it look?', sam);
    store.addTaskComment(task.id, 'Like the mock.', claude);
    const reply = notified();
    assert.equal(reply.event.decisionId, d.id, 'the event names the task’s decision too');
    assert.deepEqual(reply.place, { kind: 'task', id: task.id });

    const [other] = store.planTasks(boardId, [{ title: 'Ship it' }], claude);
    store.addTaskComment(other.id, '@Sam can you check this?', claude);
    assert.deepEqual(notified().place, { kind: 'task', id: other.id }, 'an @-mention');
    store.updateTask(other.id, { status: 'blocked', note: 'need creds' }, claude);
    assert.deepEqual(notified().place, { kind: 'task', id: other.id }, 'blocked');
  });

  it('opens a comment on a pinned part of a card’s canvas on the card', () => {
    const [task] = store.planTasks(boardId, [{ title: 'Build it' }], claude);
    const note = store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'Three columns' } }, claude);
    const { pin } = store.pinComment(note.id, { kind: 'block' }, 'Why three?', sam);
    store.commentOnPin(pin.id, 'The grid has three.', claude);
    assert.deepEqual(notified().place, { kind: 'task', id: task.id });
  });

  it('opens a reply in a thread on that thread, with the tab it belongs to', () => {
    const fromTasks = store.startThread(boardId, 'What is left for launch?', sam, undefined, { door: 'tasks' });
    store.postToThread(fromTasks.id, 'Two tasks.', claude);
    const reply = notified();
    assert.equal(reply.event.type, 'thread_replied');
    assert.deepEqual(reply.place, { kind: 'thread', id: fromTasks.id, view: 'tasks' });

    const fromCanvas = store.startThread(boardId, 'Draw the architecture', sam, undefined, { door: 'canvas' });
    store.postToThread(fromCanvas.id, 'Here it is.', claude);
    assert.deepEqual(notified().place, { kind: 'thread', id: fromCanvas.id, view: 'canvas' });

    // The open-ended door, and no door at all, open on Decisions; the General thread on the Board Context.
    const open = store.startThread(boardId, 'Anything else?', sam, undefined, { door: 'threads' });
    store.postToThread(open.id, 'No.', claude);
    assert.deepEqual(notified().place, { kind: 'thread', id: open.id, view: 'decisions' });
    const general = store.askInGeneral(boardId, 'What changed today?', sam);
    store.postToThread(general.id, 'Two things.', claude);
    assert.deepEqual(notified().place, { kind: 'thread', id: general.id, view: 'canvas' });

    // A message that @-mentions Sam in a thread an agent started.
    const agents = store.startThread(boardId, '@Sam which region should we deploy to?', claude);
    assert.deepEqual(notified().place, { kind: 'thread', id: agents.id, view: 'decisions' });
  });

  it('opens the Board Context for a reply on a part of it, and for a request an agent finished', () => {
    const note = store.addBlock({ boardId }, { content: { type: 'note', text: 'Launch in May' } }, claude);
    const { pin } = store.pinComment(note.id, { kind: 'block' }, 'Still May?', sam);
    store.commentOnPin(pin.id, 'June now.', claude);
    assert.deepEqual(notified().place, { kind: 'board', view: 'canvas' }, 'a reply on the board context');

    const request = store.askAgents(boardId, 'Get me an architecture view', sam);
    const { group } = store.takeRequest(request.id, claude);
    store.addBlock({ boardId }, { content: { type: 'note', text: 'Web, server, store' }, groupId: group!.id } as never, claude);
    store.finishRequest(request.id, 'Added the architecture view.', claude);
    const finished = notified();
    assert.equal(finished.event.type, 'request_finished');
    assert.deepEqual(finished.place, { kind: 'board', view: 'canvas' });
  });

  it('leads nowhere for a card or thread deleted since', () => {
    const d = decision();
    store.addComment(d.id, 'Leaning a.', claude);
    const onDecision = notified().event;
    const [task] = store.planTasks(boardId, [{ title: 'Ship it' }], sam);
    store.addTaskComment(task.id, 'Started.', claude);
    const onTask = notified().event;
    const thread = store.startThread(boardId, 'What is left?', sam);
    store.postToThread(thread.id, 'Nothing.', claude);
    const inThread = notified().event;

    store.deleteDecision(d.id, sam);
    store.deleteTask(task.id, sam);
    store.removeItem(thread.id, sam);
    for (const event of [onDecision, onTask, inThread]) assert.equal(eventPlace(board(), event), undefined, event.summary);
  });

  it('opens what is left of a deleted task: the decision it implements, as the Activity log always has', () => {
    const d = decision();
    const [task] = store.planTasks(boardId, [{ title: 'Build it', decisionIds: [d.id] }], sam);
    store.addTaskComment(task.id, 'Started.', claude);
    const comment = notified().event;
    store.deleteTask(task.id, sam);
    assert.deepEqual(eventPlace(board(), comment), { kind: 'decision', id: d.id });
  });

  it('leads nowhere for what is about the board itself', () => {
    const created = eventsOf(store, boardId).find((e) => e.type === 'board_created')!;
    assert.equal(eventPlace(board(), created), undefined);
  });
});
