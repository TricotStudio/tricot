import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import { savedBoard } from './savedBoard';
import { eventsOf } from './tables';
import { removeScratch } from './platform';

const agent: Actor = { kind: 'agent', name: 'claude' };
const human: Actor = { kind: 'human', name: 'Wassim' };

describe('Renaming and archiving boards', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-boards-'));
    store = new Store(dir);
    store.load();
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  function populated() {
    const board = store.createBoard({ title: 'Planning roadmap', goal: 'Ship it' }, human);
    const decision = store.postDecision(board.id, { question: 'Name?', options: [{ label: 'Tricot' }] }, agent);
    store.resolve(decision.id, { optionId: 'a' }, human);
    const [task] = store.planTasks(board.id, [{ title: 'Rename', decisionIds: [decision.id] }], agent);
    const block = store.addBlock({ boardId: board.id }, { content: { type: 'note', text: 'Context' } }, agent);
    return { board, decision, task, block };
  }

  it('gives a renamed board a new id from its title, saves it under it and keeps the old id working', async () => {
    const { board, decision, task, block } = populated();
    const old = board.id;
    store.updateBoard(old, { title: 'Tricot roadmap' }, human);
    assert.match(board.id, /^tricot-roadmap-[a-z2-9]{4}$/);
    assert.deepEqual(board.aliases, [old]);
    assert.equal(store.getBoard(old), board);
    assert.equal(store.getDecision(decision.id).board.id, board.id);
    assert.equal(decision.boardId, board.id);
    assert.equal(store.getTask(task.id).board.id, board.id);
    assert.equal(store.canvasOf(block.id).board.id, board.id);
    assert.deepEqual(
      store.listBoards().map((b) => b.id),
      [board.id],
    );
    const event = eventsOf(store, board).at(-1)!;
    assert.deepEqual([event.type, event.actor, event.summary], ['board_updated', human, 'renamed the board to "Tricot roadmap"']);

    await store.flush();
    const saved = savedBoard(dir, board.id);
    assert.deepEqual(saved.aliases, [old]);
    assert.equal(saved.decisions[0].boardId, board.id, 'its decisions follow');

    const reloaded = new Store(dir);
    reloaded.load();
    assert.equal(reloaded.getBoard(old).id, board.id);
    assert.equal(reloaded.getDecision(decision.id).board.id, board.id);
    reloaded.postDecision(old, { question: 'Still reachable?' }, agent);
    await reloaded.flush();
  });

  it('keeps every earlier id across renames, and changes the link only when the title does', async () => {
    const { board } = populated();
    const first = board.id;
    store.updateBoard(first, { title: 'Tricot roadmap' }, human);
    const second = board.id;
    store.updateBoard(second, { title: 'Tricot plan' }, human);
    assert.deepEqual(board.aliases, [first, second]);
    for (const id of [first, second, board.id]) assert.equal(store.getBoard(id), board);

    // Same slug, e.g. a change of case: same link, still logged.
    const third = board.id;
    store.updateBoard(first, { title: 'Tricot Plan' }, human);
    assert.equal(board.id, third);
    assert.equal(eventsOf(store, board).at(-1)!.summary, 'renamed the board to "Tricot Plan"');

    store.updateBoard(board.id, { goal: 'One name everywhere' }, human);
    assert.equal(board.id, third);
    assert.equal(eventsOf(store, board).at(-1)!.summary, 'changed the goal to "One name everywhere"');
    const before = board.seq;
    store.updateBoard(board.id, { title: 'Tricot Plan', goal: ' One name everywhere ' }, human);
    assert.equal(board.seq, before, 'no change, nothing logged');

    await store.flush();
    assert.deepEqual(savedBoard(dir, third).aliases, [first, second]);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 0, 'no file per board');
  });

  it('leaves renaming to people', () => {
    const { board } = populated();
    assert.throws(() => store.updateBoard(board.id, { title: 'Agent name' }, agent), /Only people rename a board/);
    assert.throws(() => store.updateBoard(board.id, { title: '  ' }, human), /title must not be empty/);
    assert.equal(board.title, 'Planning roadmap');
  });

  it('wakes agents waiting on the old id when the board is renamed', async () => {
    const { board } = populated();
    const old = board.id;
    const waiting = store.waitForEvents(old, board.seq, { timeoutMs: 2000, exclude: agent, settleMs: 0 });
    store.updateBoard(old, { title: 'Tricot roadmap' }, human);
    store.postDecision(old, { question: 'After the rename?' }, human);
    const events = await waiting;
    assert.deepEqual(
      events.map((e) => e.type),
      ['board_updated', 'decision_posted'],
    );
  });

  it('archives a board read-only for everyone until a person unarchives it', () => {
    const { board, decision, task, block } = populated();
    assert.throws(() => store.setArchived(board.id, true, agent), /Only people archive/);
    store.setArchived(board.id, true, human);
    assert.deepEqual(board.archived?.by, human);
    assert.equal(eventsOf(store, board).at(-1)!.summary, 'archived the board');
    assert.equal(store.listBoards()[0].archived, true);

    const writes: [string, () => unknown][] = [
      ['post a decision', () => store.postDecision(board.id, { question: 'Q?' }, agent)],
      ['reword a decision', () => store.updateDecision(decision.id, { blocking: true }, agent)],
      ['decide', () => store.resolve(decision.id, { answer: 'x' }, human)],
      ['explore', () => store.requestExploration(decision.id, undefined, human)],
      ['defer', () => store.defer(decision.id, undefined, human)],
      ['reopen', () => store.reopen(decision.id, human)],
      ['comment', () => store.addComment(decision.id, 'Hi', human)],
      ['ask', () => store.askPeople(decision.id, ['Sam'], undefined, agent)],
      ['propose criteria', () => store.proposeCriteria(decision.id, [{ label: 'Fast' }], agent)],
      ['attach a finding', () => store.attachFinding(decision.id, { summary: 'Found' }, agent)],
      ['request a plan', () => store.requestPlan(decision.id, undefined, human)],
      ['plan tasks', () => store.planTasks(board.id, [{ title: 'More' }], agent)],
      ['claim a task', () => store.claimTask(task.id, agent)],
      ['update a task', () => store.updateTask(task.id, { note: 'Progress' }, agent)],
      ['comment on a task', () => store.addTaskComment(task.id, 'Hi', human)],
      ['add a block', () => store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'x' } }, agent)],
      ['edit a block', () => store.updateBlock(block.id, { text: 'y' }, human)],
      ['move a block', () => store.moveItems({ boardId: board.id }, [{ id: block.id, x: 0, y: 0 }], human)],
      ['add a group', () => store.addGroup({ boardId: board.id }, { title: 'G' }, human)],
      ['remove a block', () => store.removeItem(block.id, human)],
    ];
    const seq = board.seq;
    for (const [what, write] of writes) {
      assert.throws(write, /archived by Wassim, so it is read-only/, `${what} should be refused`);
    }
    assert.equal(board.seq, seq, 'nothing was logged');
    assert.equal(store.getCanvas({ boardId: board.id }).canvas.blocks.length, 1, 'reads still work');

    assert.throws(() => store.setArchived(board.id, false, agent), /Only people/);
    store.setArchived(board.id, false, human);
    assert.equal(board.archived, undefined);
    assert.equal(eventsOf(store, board).at(-1)!.summary, 'unarchived the board');
    store.addComment(decision.id, 'Back again', human);
  });

  it('lets a person rename an archived board, which stays archived, and keeps its old id working', () => {
    const { board } = populated();
    const old = board.id;
    store.setArchived(old, true, human);
    assert.throws(() => store.updateBoard(old, { title: 'Agent name' }, agent), /Only people rename a board/);

    store.updateBoard(old, { title: 'Old roadmap', goal: 'Kept for the record' }, human);
    assert.match(board.id, /^old-roadmap-[a-z2-9]{4}$/);
    assert.equal(store.getBoard(old), board);
    assert.equal(board.goal, 'Kept for the record');
    assert.deepEqual(board.archived?.by, human, 'still archived');
    const [listed] = store.listBoards();
    assert.deepEqual([listed.id, listed.title, listed.archived], [board.id, 'Old roadmap', true]);
    assert.equal(eventsOf(store, board).at(-1)!.summary, 'renamed the board to "Old roadmap"; changed the goal to "Kept for the record"');
    assert.throws(() => store.postDecision(old, { question: 'Q?' }, agent), /so it is read-only/, 'the rest stays read-only');
  });
});
