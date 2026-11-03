import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { decisionNeedsYou, needsInput, taskNeedsYou } from '../src/core/attention';
import { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import { eventsOf } from './tables';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const sam: Actor = { kind: 'human', name: 'Sam' };
const alex: Actor = { kind: 'human', name: 'Alex' };

describe('What needs input', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-attention-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'B' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const board = () => store.getBoard(boardId);
  const last = () => eventsOf(store, board()).at(-1)!;
  const forSam = () => needsInput(last(), board(), 'sam');

  it('flags new questions, unless routed only to someone else', () => {
    store.postDecision(boardId, { question: 'Q1?', options: [{ label: 'a' }] }, claude);
    assert.equal(forSam(), true);
    const routed = store.postDecision(boardId, { question: 'Q2?', options: [{ label: 'a' }], ask: ['Alex'] }, claude);
    assert.equal(last().type, 'decision_asked');
    assert.equal(forSam(), false, 'asked of Alex');
    const posted = eventsOf(store, board()).find((e) => e.type === 'decision_posted' && e.decisionId === routed.id)!;
    assert.equal(needsInput(posted, board(), 'Sam'), false);
    assert.equal(needsInput(posted, board(), 'Alex'), true);
  });

  it('flags asks of you, replies in threads you are part of, agent calls and blocked tasks', () => {
    const d = store.postDecision(boardId, { question: 'Q?', options: [{ label: 'a' }, { label: 'b' }] }, claude);
    store.askPeople(d.id, ['Sam'], 'you know this', claude);
    assert.equal(forSam(), true);

    store.addComment(d.id, 'an aside', claude);
    assert.equal(forSam(), true, 'Sam was asked, so he is in the thread');
    assert.equal(needsInput(last(), board(), 'Alex'), false, 'Alex is not');

    store.resolve(d.id, { optionId: 'a', provisional: true }, claude);
    assert.equal(forSam(), true, "an agent's call to confirm");
    store.resolve(d.id, { optionId: 'a' }, sam);
    const [task] = store.planTasks(boardId, [{ title: 'Do it', decisionIds: [d.id] }], claude);
    assert.equal(forSam(), false, 'planning is news, not a request');
    store.updateTask(task.id, { status: 'blocked', note: 'need creds' }, claude);
    assert.equal(forSam(), true);
  });

  it('never flags your own actions or plain edits', () => {
    const d = store.postDecision(boardId, { question: 'Q?', options: [{ label: 'a' }] }, sam);
    assert.equal(forSam(), false, 'my own question');
    store.addComment(d.id, 'from Alex', alex);
    assert.equal(forSam(), true, 'a reply on a question I asked');
    store.addBlock({ boardId }, { content: { type: 'note', text: 'x' } }, claude);
    assert.equal(forSam(), false);
  });

  it('highlights cards while they wait on you, and replies to you until seen', () => {
    const post = (question: string, ask?: string[]) => store.postDecision(boardId, { question, options: [{ label: 'a' }], ask }, claude);
    const asked = post('Asked?', ['Sam']);
    const routed = post('Routed?', ['Alex']);
    const open = post('Open?');
    const call = post('Call?');
    store.resolve(call.id, { optionId: 'a', provisional: true }, claude);
    const decision = (id: string, unseen = eventsOf(store, board())) => decisionNeedsYou(store.getDecision(id).decision, board(), 'Sam', unseen);
    assert.equal(decision(asked.id, []), true, 'asked of Sam, seen or not');
    assert.equal(decision(routed.id), false, 'waiting for Alex');
    assert.equal(decision(open.id), true, 'a new question for the board');
    assert.equal(decision(open.id, []), false, 'no longer once seen');
    assert.equal(decision(call.id, []), true, "an agent's call to confirm");

    const [task] = store.planTasks(boardId, [{ title: 'Do it' }], claude);
    const taskForSam = (unseen = eventsOf(store, board())) => taskNeedsYou(store.getTask(task.id).task, board(), 'Sam', unseen);
    assert.equal(taskForSam(), false, 'planning is news, not a request');
    store.addTaskComment(task.id, 'How?', sam);
    store.addTaskComment(task.id, 'Like this.', claude);
    assert.equal(taskForSam(), true, 'a reply to Sam');
    assert.equal(taskForSam([]), false, 'seen');
    store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'Done like this' } }, claude);
    store.updateTask(task.id, { status: 'in_review' }, claude);
    assert.equal(taskForSam([]), true, 'work to review');

    const [idea] = store.planTasks(boardId, [{ title: 'Try a new layout' }], sam);
    assert.equal(taskNeedsYou(idea, board(), 'Sam', eventsOf(store, board())), false, "the backlog is Sam's own triage");
    store.updateTask(idea.id, { status: 'todo' }, sam);
    assert.equal(needsInput(last(), board(), 'Alex'), false, 'marking it ready is news, not a request');
  });
});
