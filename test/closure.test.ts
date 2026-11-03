import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { decisionClosure, taskClosure } from '../src/core/closure';
import { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const sam: Actor = { kind: 'human', name: 'Sam' };

describe('Closed cards', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-closure-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'B' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const board = () => store.getBoard(boardId);
  const decision = (id: string) => store.getDecision(id).decision;
  const task = (id: string) => store.getTask(id).task;
  const post = () => store.postDecision(boardId, { question: 'Retries?', options: [{ label: 'Options object' }, { label: 'Wrapper' }] }, claude);

  it('closes decided and retired decisions, not provisional, deferred or open ones', () => {
    const d = post();
    assert.equal(decisionClosure(decision(d.id)), null);
    store.resolve(d.id, { optionId: 'a', provisional: true }, claude);
    assert.equal(decisionClosure(decision(d.id)), null, 'agents proceed, but a person has yet to confirm it');

    store.resolve(d.id, { optionId: 'a', rationale: 'Smallest change at the call sites' }, sam);
    const decided = decisionClosure(decision(d.id));
    assert.deepEqual(decided && { ...decided, at: undefined }, {
      kind: 'decided',
      by: sam,
      at: undefined,
      choice: 'a) Options object',
      rationale: 'Smallest change at the call sites',
    });

    store.defer(d.id, 'after launch', sam);
    assert.equal(decisionClosure(decision(d.id)), null, 'deferred is parked, not closed');

    store.retire(d.id, 'The gateway retries for us now', sam);
    const retired = decisionClosure(decision(d.id));
    assert.equal(retired?.kind, 'retired');
    assert.deepEqual(retired?.kind === 'retired' && [retired.by, retired.reason], [sam, 'The gateway retries for us now']);

    store.reopen(d.id, sam);
    assert.equal(decisionClosure(decision(d.id)), null);
  });

  it('says who moved a task to done, and whether they approved it from review', () => {
    const [t] = store.planTasks(boardId, [{ title: 'Ship it; approved it', decisionIds: [] }], claude);
    store.claimTask(t.id, claude);
    assert.equal(taskClosure(board(), task(t.id)), null);

    store.addBlock({ taskId: t.id }, { content: { type: 'note', text: 'Done: screenshots' } }, claude);
    store.updateTask(t.id, { status: 'in_review', note: 'marked it done; see the canvas' }, claude);
    assert.equal(taskClosure(board(), task(t.id)), null, 'in review is not closed, whatever the note or title says');

    store.updateTask(t.id, { status: 'done' }, sam);
    const approved = { kind: 'done', by: sam, at: task(t.id).doneAt, approved: true };
    assert.deepEqual(taskClosure(board(), task(t.id)), approved);
    store.updateTask(t.id, { note: 'marked it done; for the record' }, claude);
    assert.deepEqual(taskClosure(board(), task(t.id)), approved, 'a note that reads like the move is not the move');

    // Reopened and finished again without a review: done, but not approved.
    store.updateTask(t.id, { status: 'todo', note: 'One more screen' }, sam);
    assert.equal(taskClosure(board(), task(t.id)), null);
    store.claimTask(t.id, claude);
    store.updateTask(t.id, { status: 'done', note: 'Added it' }, claude);
    assert.deepEqual(taskClosure(board(), task(t.id)), { kind: 'done', by: claude, at: task(t.id).doneAt, approved: false });
  });
});
