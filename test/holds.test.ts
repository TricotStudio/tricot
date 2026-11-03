import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { heldTasks, waitsOn } from '../src/core/holds';
import { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const sam: Actor = { kind: 'human', name: 'Sam' };

describe('The work an open question holds', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-holds-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'B' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const board = () => store.getBoard(boardId);
  const decision = (id: string) => board().decisions.find((d) => d.id === id)!;
  const task = (id: string) => board().tasks.find((t) => t.id === id)!;
  const question = (q: string) => store.postDecision(boardId, { question: q, options: [{ label: 'Core first' }, { label: 'Desktop app' }] }, claude);
  const numbers = (items: { number: number }[]) => items.map((i) => i.number);

  it('holds work built on a question that is open again, until it is closed', () => {
    const shape = question('What shape?');
    store.resolve(shape.id, { optionId: 'a' }, sam);
    const [built, shipped] = store.planTasks(
      boardId,
      [
        { title: 'Build it', decisionIds: [shape.id] },
        { title: 'Ship it', decisionIds: [shape.id] },
      ],
      claude,
    );
    store.updateTask(shipped.id, { status: 'done' }, sam);
    assert.deepEqual(waitsOn(board(), task(built.id)), [], 'decided: nothing waits');

    store.reopen(shape.id, sam);
    assert.deepEqual(numbers(waitsOn(board(), task(built.id))), [shape.number]);
    assert.deepEqual(numbers(heldTasks(board(), decision(shape.id))), [built.number], 'done work waits on nothing');

    store.requestExploration(shape.id, undefined, sam);
    assert.deepEqual(numbers(heldTasks(board(), decision(shape.id))), [built.number], 'exploring still holds it');

    store.resolve(shape.id, { optionId: 'b', provisional: true }, claude);
    assert.deepEqual(heldTasks(board(), decision(shape.id)), [], 'a provisional answer is enough to build on');

    store.reopen(shape.id, sam);
    store.defer(shape.id, 'Later', sam);
    assert.deepEqual(waitsOn(board(), task(built.id)), [], 'deferred lets go of it');
    store.reopen(shape.id, sam);
    store.retire(shape.id, 'Moot', sam);
    assert.deepEqual(waitsOn(board(), task(built.id)), [], 'retired lets go of it');
  });

  it('holds a backlog task pinned to an open question, either way round', () => {
    const shape = question('What shape?');
    const sketch = store.addBlock({ decisionId: shape.id }, { title: 'Sketch', content: { type: 'note', text: 'Split the core from the shells' } }, sam);
    // Made from part of the question's canvas: unlinked, since it's open.
    const { task: made } = store.pinTask(sketch.id, { kind: 'text', quote: 'the core' }, { text: 'Re-architect the core' }, sam);
    assert.deepEqual(made.decisionIds, []);
    // A part of the task's own canvas pinned to the question.
    const [spike] = store.planTasks(boardId, [{ title: 'Spike the shell' }], sam);
    const notes = store.addBlock({ taskId: spike.id }, { title: 'Notes', content: { type: 'note', text: 'Depends on the shape' } }, sam);
    store.pin(notes.id, { kind: 'text', quote: 'the shape' }, { decisionId: shape.id }, claude);
    const [loose] = store.planTasks(boardId, [{ title: 'Unrelated' }], sam);

    assert.deepEqual(numbers(heldTasks(board(), decision(shape.id))), [made.number, spike.number]);
    assert.deepEqual(waitsOn(board(), task(loose.id)), []);

    store.updateTask(made.id, { status: 'todo' }, sam);
    assert.deepEqual(numbers(heldTasks(board(), decision(shape.id))), [spike.number], 'out of the backlog, a pin alone is only a reference');

    store.resolve(shape.id, { optionId: 'a' }, sam);
    assert.deepEqual(heldTasks(board(), decision(shape.id)), [], 'deciding it lets go');
  });

  it('lists every open question a task waits on, by number', () => {
    const first = question('First?');
    const second = question('Second?');
    for (const q of [second, first]) store.resolve(q.id, { optionId: 'a' }, sam);
    const [both] = store.planTasks(boardId, [{ title: 'Both', decisionIds: [second.id, first.id] }], claude);
    store.reopen(second.id, sam);
    store.reopen(first.id, sam);
    assert.deepEqual(numbers(waitsOn(board(), task(both.id))), [first.number, second.number]);
  });
});
