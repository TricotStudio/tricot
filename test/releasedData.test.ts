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
import type { Actor, Board, Canvas } from '../src/core/types';
import { eventsOf, versionsOf } from './tables';
import { removeScratch } from './platform';

// The database each release left (test/fixtures/tricot-<version>.db), made by
// starting that release from its tag and posting a board through its MCP tools
// (scripts/db-fixture.mjs): three blocks, one of them reworded once (so it
// has a version), on the board's canvas with a pin on it for the releases
// before Canvas (`board`), and on a Sketchbook page for Canvas's (`page`, no
// pin: Canvas has no tool that makes one); and, where a tree has them, the
// cards a part's tools make. Each release writes the data version it names
// here, so each is read by the migrations since (none, for a release at the
// latest), and by what reads the board now: the core's own, a Store that has
// no list of a part's cards. Its counterpart for a part reads the cards.
const RELEASES: [version: string, dataVersion: number, blocksOn: 'board' | 'page'][] = [
  ['0.1.0', 6, 'board'],
  ['0.1.1', 6, 'board'],
  ['0.1.2', 6, 'board'],
  ['0.1.3', 6, 'board'],
  ['0.1.4', 7, 'board'],
  ['0.1.5', 7, 'board'],
  ['0.1.6', 7, 'board'],
  ['0.0.3', 19, 'page'],
  ['0.0.4', 20, 'page'],
  ['0.0.5', 21, 'page'],
  ['0.0.6', 21, 'page'],
  ['0.0.7', 21, 'page'],
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

  // The canvas a release put its blocks on.
  const blocksOf = (board: Board, on: 'board' | 'page'): Canvas => (on === 'page' ? board.pages![0].canvas : board.canvas);

  for (const [version, dataVersion, on] of RELEASES) {
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

      it('reads: its blocks, pin, versions and log', () => {
        const store = open();
        const [{ id }] = store.listBoards();
        const board = store.getBoard(id);
        assert.equal(board.title, 'Fixture board');
        assert.equal(board.goal, 'Check that boards from every release still read');
        assert.deepEqual(board.createdBy, planner);

        const canvas = blocksOf(board, on);
        assert.deepEqual(canvas.blocks.map((b) => [b.type, b.title, b.rev]), [['note', 'Notes', 2], ['table', 'Table', 1], ['diagram', 'Flow', 1]]);
        const [notes] = canvas.blocks;
        assert.equal(notes.type === 'note' && notes.text, 'First line\n\nSecond line, reworded');
        const [earlier, ...none] = versionsOf(store, notes.id);
        assert.equal(none.length, 0);
        assert.equal(earlier.type === 'note' && earlier.text, 'First line\n\nSecond line');
        if (on === 'board') {
          const [pin] = canvas.pins;
          assert.deepEqual([pin.blockId, pin.quote], [notes.id, 'reworded']);
        }

        const log = eventsOf(store, board);
        assert.equal(log[0].type, 'board_created');
        assert.equal(log.at(-1)?.seq, board.seq);
      });

      it('goes on working: a person asks in a thread, a block is added, and a restart reads it all', async () => {
        const store = open();
        const [{ id }] = store.listBoards();
        const thread = store.startThread(id, 'Anything left before the upgrade?', sam);
        const page = on === 'page' ? store.getBoard(id).pages![0].id : undefined;
        store.addBlock(page ? { pageId: page } : { boardId: id }, { content: { type: 'note', text: 'Added after the upgrade' } }, sam);
        await store.flush();

        const again = open();
        const board = again.getBoard(id);
        assert.deepEqual(board.threads?.map((t) => t.id), [thread.id]);
        assert.deepEqual(blocksOf(board, on).blocks.map((b) => b.title), ['Notes', 'Table', 'Flow', undefined]);
        assert.equal(eventsOf(again, board).length, board.seq);
      });
    });
  }
});
