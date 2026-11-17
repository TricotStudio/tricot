import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BoardImage, Dirty } from '../src/core/store/boardRows';
import { BoardWriter } from '../src/core/store/boardTables';
import { EntityLists } from '../src/core/store/entityLists';
import { inTransaction } from '../src/core/store/sqlite';
import { MIGRATIONS, MigrationError, NewerDataError, openDatabase, userVersion, type Migration } from '../src/core/store/migrations';
import { Store } from '../src/core/store';
import { boardKey, type Actor, type Board } from '../src/core/types';
import { CardStore, TICKETS, type Card } from './madeUpCards';
import { eventsOf, legacyBoard } from './tables';
import { removeScratch, WINDOWS } from './platform';

const agent: Actor = { kind: 'agent', name: 'claude' };
const human: Actor = { kind: 'human', name: 'Sam' };
const modeOf = (file: string) => statSync(file).mode & 0o777;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const names = (dir: string, prefix = '') => readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();

// The registry of a Store that has the made-up kind of card, and what the board holds of it (a Board has no field for it).
const TICKET_LISTS = new EntityLists([{ list: TICKETS.list, kind: TICKETS.kind, owner: TICKETS.owner }]);
const ticketsOf = (board: Board) => (board as unknown as Record<string, Card[]>)[TICKETS.list];

// A board with something of everything: two cards of a made-up kind with canvases, pins, threads, a deletion, a block with a
// version, and many events.
function populate(store: CardStore, title: string): Board {
  const board = store.createBoard({ title, goal: 'Ship it' }, human);
  const first = store.postCard(board.id, { title: 'Which retry strategy?', detail: 'Backoff or fixed' }, agent);
  const second = store.postCard(board.id, { title: 'Wire it' }, agent);
  const note = store.addBlock({ boardId: board.id }, { content: { type: 'note', text: 'Context for everyone' } }, agent);
  store.updateBlock(note.id, { text: 'Context for everyone, reworded' }, agent);
  store.addBlock(store.ref(second), { content: { type: 'note', text: 'On the second card' } }, agent);
  const doomed = store.addBlock({ boardId: board.id }, { content: { type: 'note', text: 'Soon gone' } }, human);
  store.addBlock(store.ref(first), { content: { type: 'note', text: 'On the first card' } }, human);
  store.addGroup({ boardId: board.id }, { title: 'A group' }, human);
  store.addLink(note.id, doomed.id, 'depends on', human);
  store.pinComment(note.id, { kind: 'text', quote: 'Context' }, 'Look at this', human);
  store.startThread(board.id, 'What is left?', human);
  store.removeItem(doomed.id, human);
  for (let i = 0; i < 130; i++) store.commentOnCard(first.id, `Comment ${i}`, human);
  return board;
}

describe('Boards in SQLite', () => {
  let dir: string;
  const folders: string[] = [];
  const scratch = () => {
    const made = mkdtempSync(path.join(os.tmpdir(), 'tricot-sqlite-'));
    folders.push(made);
    return made;
  };

  beforeEach(() => {
    dir = scratch();
  });

  afterEach(() => {
    for (const made of folders.splice(0)) removeScratch(made);
  });

  describe('migrations', () => {
    const first: Migration = { name: 'one', up: (db) => db.exec('CREATE TABLE one (n INTEGER)') };
    const second: Migration = { name: 'two', up: (db) => db.exec('CREATE TABLE two (n INTEGER); INSERT INTO two VALUES (2)') };

    it('makes a new file at the newest version, without a backup of nothing', () => {
      const file = path.join(dir, 'tricot.db');
      const db = openDatabase(file, [first, second]);
      assert.equal(userVersion(db), 2);
      db.close();
      assert.ok(!existsSync(path.join(dir, 'backups')));
      const real = openDatabase(path.join(dir, 'real.db'));
      assert.equal(userVersion(real), MIGRATIONS.length);
      real.close();
    });

    it('copies the file first when it upgrades one, and runs only the migrations it lacks', { skip: WINDOWS && 'checks POSIX file modes' }, () => {
      const file = path.join(dir, 'tricot.db');
      openDatabase(file, [first]).close();
      const db = openDatabase(file, [first, second]);
      assert.equal(userVersion(db), 2);
      assert.deepEqual(db.prepare('SELECT n FROM two').all().map((r) => r.n), [2]);
      db.close();
      const [copy, ...more] = names(path.join(dir, 'backups'));
      assert.equal(more.length, 0);
      assert.match(copy, /^tricot-v1-.*\.db$/);
      assert.equal(modeOf(path.join(dir, 'backups', copy)), 0o600);
      assert.equal(modeOf(path.join(dir, 'backups')), 0o700);
      const old = openDatabase(path.join(dir, 'backups', copy), [first]);
      assert.equal(userVersion(old), 1, 'the copy is the file as it was');
      assert.deepEqual(old.prepare("SELECT name FROM sqlite_master WHERE name = 'two'").all(), []);
      old.close();
    });

    it('leaves the file as it was when a migration fails, and says where the copy is', () => {
      const file = path.join(dir, 'tricot.db');
      openDatabase(file, [first]).close();
      const broken: Migration = { name: 'broken', up: (db) => db.exec('CREATE TABLE half (n INTEGER); SELECT * FROM missing') };
      assert.throws(() => openDatabase(file, [first, second, broken]), (error: unknown) => {
        assert.ok(error instanceof MigrationError);
        assert.match(error.message, /to data version 3 \(broken\).*a copy from before is .*backups/);
        return true;
      });
      const db = openDatabase(file, [first, second]);
      assert.equal(userVersion(db), 2, 'the ones before it stand; the failed one left nothing');
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").all(), []);
      db.close();
    });

    it('refuses a file from a newer version, changing nothing', () => {
      const file = path.join(dir, 'tricot.db');
      openDatabase(file, [first, second]).close();
      const before = { sha: sha(file), files: names(dir) };
      assert.throws(() => openDatabase(file, [first]), (error: unknown) => {
        assert.ok(error instanceof NewerDataError);
        assert.match(error.message, /newer Tricot \(data version 2; this one understands up to 1\)\. Update Tricot to open it\. Nothing was changed\./);
        return true;
      });
      assert.deepEqual({ sha: sha(file), files: names(dir) }, before, 'not a byte, not a file');
    });
  });

  describe('data version 2: events and block versions in tables of their own', () => {
    type Legacy = ReturnType<typeof legacyBoard>;
    const count = (db: ReturnType<typeof openDatabase>, sql: string) => Number((db.prepare(sql).get() as { n: number }).n);

    // A database as data version 1 held a board: its events in rows of 100, and
    // each block carrying its versions in its own row, as the legacy board does.
    function version1(file: string, legacy: Legacy): void {
      const db = openDatabase(file, [MIGRATIONS[0]]);
      const { events, ...board } = legacy;
      inTransaction(db, () => {
        const put = db.prepare('INSERT INTO items (board, owner, kind, id, pos, body) VALUES (?, ?, ?, ?, ?, ?)');
        for (const op of new BoardImage(TICKET_LISTS).plan(board, Dirty.everything())) {
          if (op.type === 'header') db.prepare('INSERT INTO boards (key, id, pos, body) VALUES (?, ?, 0, ?)').run(boardKey(board), op.id, op.body);
          else if (op.type === 'put') put.run(boardKey(board), op.row.owner, op.row.kind, op.row.id, op.row.pos, op.row.body);
        }
        for (let at = 0; at < events.length; at += 100) {
          put.run(boardKey(board), '', 'events', String(at / 100).padStart(8, '0'), at / 100, JSON.stringify(events.slice(at, at + 100)));
        }
      });
      db.close();
    }

    async function legacyOf(title: string): Promise<{ legacy: Legacy; doomed: string }> {
      const source = new CardStore(scratch());
      source.load();
      const made = populate(source, title);
      const legacy = legacyBoard(source, made.id);
      const doomed = legacy.deleted![0].id;
      await source.flush();
      return { legacy, doomed };
    }

    it('copies a version 1 file first, then moves the events and versions out of the rows they were kept in', { skip: WINDOWS && 'checks POSIX file modes' }, async () => {
      const { legacy } = await legacyOf('Roadmap');
      assert.ok(legacy.events.length > 130, 'more events than one row holds');
      const file = path.join(dir, 'tricot.db');
      version1(file, legacy);

      const db = openDatabase(file, MIGRATIONS.slice(0, 2));
      assert.equal(userVersion(db), 2);
      const [copy, ...more] = names(path.join(dir, 'backups'));
      assert.equal(more.length, 0);
      assert.match(copy, /^tricot-v1-.*\.db$/);
      assert.equal(modeOf(path.join(dir, 'backups', copy)), 0o600);
      const old = openDatabase(path.join(dir, 'backups', copy), [MIGRATIONS[0]]);
      assert.equal(userVersion(old), 1, 'the copy is the file as it was');
      assert.equal(count(old, "SELECT COUNT(*) AS n FROM items WHERE kind = 'events'"), 2);
      assert.equal(count(old, "SELECT COUNT(*) AS n FROM items WHERE body LIKE '%\"versions\"%'"), 1);
      old.close();

      const key = boardKey(legacy);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM items WHERE kind = 'events'"), 0);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM items WHERE body LIKE '%\"versions\"%'"), 0, 'no block keeps its versions');
      assert.equal(count(db, `SELECT COUNT(*) AS n FROM events WHERE board = '${key}'`), legacy.events.length);
      assert.deepEqual(
        db.prepare('SELECT seq, type, actor_name, item_id FROM events WHERE board = ? ORDER BY seq LIMIT 2').all(key).map((r) => ({ ...r })),
        legacy.events.slice(0, 2).map((e) => ({ seq: e.seq, type: e.type, actor_name: e.actor.name, item_id: e.itemId ?? null })),
        'the columns are read out of each event',
      );
      assert.equal(count(db, `SELECT COUNT(*) AS n FROM block_versions WHERE board = '${key}'`), 1);
      assert.deepEqual(db.prepare('SELECT block, rev FROM block_versions').all().map((r) => r.rev), [1]);
      db.close();

      // The store reads it as the board it was, and goes on from the last event.
      const store = new CardStore(dir);
      store.load();
      // The migration of a board's shape (data version 7, shipped) gives a board that has none a task list and its counter, so the board a Store with no list of them reads has them from then on.
      assert.deepEqual(legacyBoard(store, legacy.id), { ...legacy, tasks: [], nextTaskNumber: 1 });
      const last = legacy.events.at(-1)!;
      assert.equal(store.getBoard(legacy.id).seq, last.seq);
      store.commentOnCard(ticketsOf(legacy)[0].id, 'After the move', human);
      assert.equal(eventsOf(store, legacy.id).at(-1)!.seq, last.seq + 1);
      await store.flush();
    });
  });

  describe('saving change by change', () => {
    it('survives the process being killed, and says nothing of SQLite being experimental', async () => {
      const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./crashChild.ts', import.meta.url)), dir], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (err += chunk));
      for (let waited = 0; !out.includes('\n') && waited < 20000; waited += 25) await sleep(25);
      assert.ok(out.includes('\n'), `the child said nothing: ${err}`);
      await sleep(300); // past the moment saves wait; nothing flushes
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
      const [boardId, cardId] = out.trim().split(' ');
      assert.match(err, /a warning of its own/, 'other warnings still show');
      assert.doesNotMatch(err, /SQLite|ExperimentalWarning: SQLite/);

      const store = new CardStore(dir);
      store.load();
      assert.equal(store.getBoard(boardId).title, 'Survives a kill');
      const { card } = store.cardOf(cardId);
      assert.equal(card.title, 'Still here?');
      assert.equal(card.canvas.blocks.length, 1);
      assert.deepEqual(eventsOf(store, boardId).map((e) => e.type), ['board_created', 'canvas_changed', 'canvas_changed']);
      await store.flush();
    });

    it('writes a board all or nothing: a change that fails half way leaves the rows as they were', () => {
      const db = openDatabase(path.join(dir, 'tricot.db'));
      const writer = new BoardWriter(db);
      const row = (id: string, body: string | null) => ({ type: 'put' as const, row: { scope: 'canvas:board', owner: 'board', kind: 'block', id, pos: 0, body: body as string } });
      inTransaction(db, () => writer.write('b', [row('one', '{}')]));
      assert.throws(() => inTransaction(db, () => writer.write('b', [row('two', '{}'), row('one', '{"changed":1}'), row('three', null)])));
      assert.deepEqual(db.prepare('SELECT id, body FROM items ORDER BY id').all().map((r) => [r.id, r.body]), [['one', '{}']]);
      db.close();
    });

    it('holds the database and its side files at 600, in a folder at 700', { skip: WINDOWS && 'checks POSIX file modes' }, async () => {
      const store = new Store(dir);
      store.load();
      store.createBoard({ title: 'Private' }, human);
      await sleep(100);
      const live = names(dir, 'tricot.db');
      assert.deepEqual(live, ['tricot.db', 'tricot.db-shm', 'tricot.db-wal']);
      for (const file of live) assert.equal(modeOf(path.join(dir, file)), 0o600, file);
      await store.flush();
      assert.equal(modeOf(path.join(dir, 'tricot.db')), 0o600);
      const reopened = new Store(dir);
      reopened.load();
      reopened.createBoard({ title: 'Again' }, human);
      await sleep(100);
      for (const file of names(dir, 'tricot.db')) assert.equal(modeOf(path.join(dir, file)), 0o600, file);
      await reopened.flush();
    });
  });
});
