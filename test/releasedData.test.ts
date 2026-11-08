import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Store } from '../src/core/store';
import { DATABASE_FILE } from '../src/core/store/boardDb';
import { readBoards } from '../src/core/store/boardTables';
import { MIGRATIONS, openDatabase, userVersion } from '../src/core/store/migrations';
import type { Actor } from '../src/core/types';
import { eventsOf, versionsOf } from './tables';
import { removeScratch } from './platform';

// The database each release left (test/fixtures/tricot-<version>.db), made by
// starting that release from its tag and posting a board through its MCP tools
// (scripts/db-fixture.mjs): a decision with two options and two blocks, a
// provisional decision, a task for it with a note and a comment, three blocks
// on the board's canvas, one of them reworded once (so it has a version) and a
// pin on it. Each release writes the data version it names here, so each is
// read by the migrations since (none, for a release at the latest), and by
// what reads the board now.
const RELEASES: [version: string, dataVersion: number][] = [
  ['0.1.0', 6],
  ['0.1.1', 6],
  ['0.1.2', 6],
  ['0.1.3', 6],
  ['0.1.4', 7],
  ['0.1.5', 7],
];
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const planner: Actor = { kind: 'agent', name: 'Planner' };
const sam: Actor = { kind: 'human', name: 'Sam' };

describe('Boards saved by each release', () => {
  let dir: string;
  let file: string;
  const stores: Store[] = [];

  const folderWith = (version: string) => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-released-'));
    file = path.join(dir, DATABASE_FILE);
    copyFileSync(path.join(FIXTURES, `tricot-${version}.db`), file);
  };
  const open = () => {
    const store = new Store(dir);
    store.load();
    stores.push(store);
    return store;
  };
  // What the file holds, read as it is, with only the migrations the release had run.
  const stored = (migrations = MIGRATIONS) => {
    const db = openDatabase(file, migrations);
    try {
      return { version: userVersion(db), boards: readBoards(db).map((saved) => saved.board) };
    } finally {
      db.close();
    }
  };

  beforeEach(() => {
    dir = '';
  });
  afterEach(async () => {
    for (const store of stores.splice(0)) await store.flush();
    if (dir) removeScratch(dir);
  });

  for (const [version, dataVersion] of RELEASES) {
    const migrated = dataVersion < MIGRATIONS.length;
    describe(`Tricot ${version}`, () => {
      beforeEach(() => folderWith(version));

      it(`left data version ${dataVersion}, which the first ${dataVersion} migrations are`, () => {
        const before = stored(MIGRATIONS.slice(0, dataVersion));
        assert.equal(before.version, dataVersion);
        assert.equal(before.boards.length, 1);
      });

      it(migrated ? 'is migrated after a copy of it, and its board reads back identical' : 'is at the latest data version, and its board reads back identical', async () => {
        const before = stored(MIGRATIONS.slice(0, dataVersion)).boards;
        const store = open();
        await store.flush();
        const after = stored();
        assert.equal(after.version, MIGRATIONS.length);
        assert.deepEqual(after.boards, before, 'every board, as the release saved it');
        const backups = existsSync(path.join(dir, 'backups')) ? readdirSync(path.join(dir, 'backups')) : [];
        if (migrated) {
          assert.equal(backups.length, 1);
          assert.match(backups[0], new RegExp(`^tricot-v${dataVersion}-.*\\.db$`));
        } else assert.deepEqual(backups, [], 'nothing to migrate, so nothing is backed up');
      });

      it('reads: its decisions, task, blocks, pin, versions and log', () => {
        const store = open();
        const [{ id }] = store.listBoards();
        const board = store.getBoard(id);
        assert.equal(board.title, 'Fixture board');
        assert.equal(board.goal, 'Check that boards from every release still read');
        assert.deepEqual(board.createdBy, planner);

        const [which, named] = board.decisions;
        assert.deepEqual([which.number, which.question, which.status, which.area, which.blocking], [1, 'Which store?', 'open', 'Storage', true]);
        assert.deepEqual(which.options.map((o) => o.label), ['SQLite', 'Files']);
        assert.equal(which.recommendation?.optionId, 'a');
        assert.deepEqual(which.canvas.blocks.map((b) => [b.type, b.title, b.optionId]), [['note', 'Why one file', 'a'], ['table', 'Compared', undefined]]);
        assert.deepEqual([named.number, named.status, named.resolution?.optionId, named.resolution?.rationale], [2, 'provisional', 'a', 'It is short.']);
        assert.deepEqual([which.history, which.asks, which.criteria, which.marks, which.canvas.pins], [[], [], [], [], []]);

        const [task] = board.tasks;
        assert.deepEqual([task.number, task.title, task.status, task.decisionIds], [1, 'Write the importer', 'todo', [named.id]]);
        assert.deepEqual(task.comments.map((c) => c.body), ['Started on it.']);
        const [steps] = task.canvas.blocks;
        assert.deepEqual([steps.type, steps.rev], ['note', 1]);
        assert.equal(steps.type === 'note' && steps.text, '- [x] Read\n- [ ] Write');

        assert.deepEqual(board.canvas.blocks.map((b) => [b.type, b.title, b.rev]), [['note', 'Notes', 2], ['table', 'Table', 1], ['diagram', 'Flow', 1]]);
        const [notes] = board.canvas.blocks;
        assert.equal(notes.type === 'note' && notes.text, 'First line\n\nSecond line, reworded');
        const [earlier, ...none] = versionsOf(store, notes.id);
        assert.equal(none.length, 0);
        assert.equal(earlier.type === 'note' && earlier.text, 'First line\n\nSecond line');
        const [pin] = board.canvas.pins;
        assert.deepEqual([pin.blockId, pin.quote, pin.decisionId], [notes.id, 'reworded', which.id]);
        assert.equal(board.nextTaskNumber, 2);
        assert.equal(board.nextDecisionNumber, 3);

        const log = eventsOf(store, board);
        assert.equal(log[0].type, 'board_created');
        assert.equal(log.at(-1)?.seq, board.seq);
        assert.ok(log.some((e) => e.type === 'decision_posted') && log.some((e) => e.type === 'task_planned'));
      });

      it('goes on working: a person answers, a task moves, and a restart reads it all', async () => {
        const store = open();
        const [{ id }] = store.listBoards();
        const [which] = store.getBoard(id).decisions;
        store.resolve(which.id, { optionId: 'a', rationale: 'Agreed' }, sam);
        store.addBlock({ boardId: id }, { content: { type: 'note', text: 'Added after the upgrade' } }, sam);
        await store.flush();

        const again = open();
        const board = again.getBoard(id);
        assert.equal(board.decisions[0].status, 'decided');
        assert.deepEqual(board.canvas.blocks.map((b) => b.title), ['Notes', 'Table', 'Flow', undefined]);
        assert.equal(eventsOf(again, board).length, board.seq);
      });
    });
  }
});
