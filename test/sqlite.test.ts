import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BoardDb } from '../src/core/store/boardDb';
import { BoardImage, Dirty, joinBoard, type Op, type StoredRow } from '../src/core/store/boardRows';
import { BoardWriter } from '../src/core/store/boardTables';
import { inTransaction } from '../src/core/store/sqlite';
import { MIGRATIONS, MigrationError, NewerDataError, openDatabase, userVersion, type Migration } from '../src/core/store/migrations';
import { splitLegacyBoard } from '../src/core/store/legacyBoard';
import { Store } from '../src/core/store';
import { boardKey, type Actor, type Board } from '../src/core/types';
import { jsonFolder, savedBoard } from './savedBoard';
import { eventsOf, legacyBoard, versionsOf } from './tables';
import { WINDOWS } from './platform';

const agent: Actor = { kind: 'agent', name: 'claude' };
const human: Actor = { kind: 'human', name: 'Sam' };
const modeOf = (file: string) => statSync(file).mode & 0o777;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const names = (dir: string, prefix = '') => readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();

// A board with something of everything: decisions, tasks, pins, threads, a deletion, a block with a version, and many events.
function populate(store: Store, title: string): Board {
  const board = store.createBoard({ title, goal: 'Ship it' }, human);
  const decision = store.postDecision(board.id, { question: 'Which retry strategy?', options: [{ label: 'Backoff' }, { label: 'Fixed' }] }, agent);
  store.resolve(decision.id, { optionId: 'a' }, human);
  const [task] = store.planTasks(board.id, [{ title: 'Wire it', decisionIds: [decision.id] }], agent, { ready: true });
  const note = store.addBlock({ boardId: board.id }, { content: { type: 'note', text: 'Context for everyone' } }, agent);
  store.updateBlock(note.id, { text: 'Context for everyone, reworded' }, agent);
  store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'On the task' } }, agent);
  const doomed = store.addBlock({ boardId: board.id }, { content: { type: 'note', text: 'Soon gone' } }, human);
  store.addBlock({ decisionId: decision.id }, { content: { type: 'note', text: 'On the decision' } }, human);
  store.addGroup({ boardId: board.id }, { title: 'A group' }, human);
  store.addLink(note.id, doomed.id, 'depends on', human);
  store.pinComment(note.id, { kind: 'text', quote: 'Context' }, 'Look at this', human);
  store.startThread(board.id, 'What is left?', human);
  store.removeItem(doomed.id, human);
  for (let i = 0; i < 130; i++) store.addComment(decision.id, `Comment ${i}`, human);
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
    mock.restoreAll();
    for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
  });

  // Boards as an earlier version left them: what a store saved, written out as JSON files.
  async function earlierFolder(...titles: string[]): Promise<{ folder: string; boards: Board[] }> {
    const source = new Store(scratch());
    source.load();
    const made = titles.map((title) => populate(source, title));
    const boards = made.map((b) => legacyBoard(source, b.id));
    await source.flush();
    const folder = jsonFolder(...boards);
    folders.push(folder);
    return { folder, boards };
  }

  describe('importing the JSON boards', () => {
    it('imports every board, finds them the same, and moves the files, with the rest left alone', async () => {
      const { folder, boards } = await earlierFolder('Roadmap', 'Website');
      // Not boards: a connector's file, and one that doesn't parse.
      writeFileSync(path.join(folder, 'google-client.json'), JSON.stringify({ installed: { client_id: 'x' } }));
      writeFileSync(path.join(folder, 'broken.json'), '{ not json');
      mkdirSync(path.join(folder, 'assets'));
      writeFileSync(path.join(folder, 'assets', 'pic.png'), 'png');
      const errors = mock.method(console, 'error', () => {});
      const logs = mock.method(console, 'log', () => {});

      const store = new Store(folder);
      store.load();
      for (const board of boards) assert.deepEqual(legacyBoard(store, board.id), board, 'with its events and versions');
      assert.match(String(logs.mock.calls[0].arguments[0]), /Moved 2 boards into .*tricot\.db\. The JSON files are kept in .*backup-json-\d{4}-\d\d-\d\d/);
      assert.match(String(errors.mock.calls[0].arguments[1] ?? errors.mock.calls[0].arguments[0]), /broken\.json|Unexpected|JSON/);
      await store.flush();

      assert.deepEqual(names(folder).filter((f) => f.endsWith('.json')), ['broken.json', 'google-client.json']);
      const [backup] = names(folder, 'backup-json-');
      assert.deepEqual(names(path.join(folder, backup)), boards.map((b) => `${b.id}.json`).sort());
      assert.ok(existsSync(path.join(folder, 'assets', 'pic.png')), 'images stay files');
      assert.deepEqual(JSON.parse(readFileSync(path.join(folder, backup, `${boards[0].id}.json`), 'utf8')), boards[0], 'the kept files are as they were');

      // The next start reads the database alone.
      rmSync(path.join(folder, backup), { recursive: true });
      const again = new Store(folder);
      again.load();
      for (const board of boards) assert.deepEqual(legacyBoard(again, board.id), board);
      assert.deepEqual(names(folder, 'backup-json-'), [], 'nothing imported twice');
      await again.flush();
    });

    it('keeps old boards exactly as they were, a missing list apart from an empty one', async () => {
      const bare = {
        id: 'bare-ab12', title: 'Bare', createdBy: human, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        seq: 0, nextDecisionNumber: 1, decisions: [], canvas: { blocks: [], groups: [], links: [] }, extra: { kept: [1, 2, 3] },
      };
      const empty = { ...bare, id: 'empty-cd34', nextTaskNumber: 1, tasks: [], threads: [], events: [], canvas: { blocks: [], groups: [], links: [], pins: [] } };
      const folder = jsonFolder(bare, empty);
      folders.push(folder);
      const store = new Store(folder);
      store.load();
      await store.flush();
      const read = (id: string) => savedBoard(folder, id);
      const { events: _events, ...emptyNow } = empty;
      assert.deepEqual(read('empty-cd34'), emptyNow, 'with no log of its own to hold');
      // The one with lists missing had them added as it was imported (shapeDefaults.ts), and kept what the store doesn't know.
      const tidied = read('bare-ab12');
      assert.deepEqual((tidied as Board & { extra: unknown }).extra, bare.extra);
      assert.deepEqual(tidied.canvas, { blocks: [], groups: [], links: [], pins: [] });
      assert.deepEqual(tidied.tasks, []);
    });

    it('stops, with the files untouched and nothing started, if a board would not come back the same', async () => {
      const { folder, boards } = await earlierFolder('Roadmap');
      // 1e400 reads as Infinity, which JSON can't hold: the copy in the database could not be the same.
      const text = readFileSync(path.join(folder, `${boards[0].id}.json`), 'utf8').replace('"seq":', '"odd": 1e400, "seq":').replace('"seq" :', '"odd": 1e400, "seq" :');
      writeFileSync(path.join(folder, `${boards[0].id}.json`), text);
      assert.match(text, /1e400/);
      const before = names(folder);

      const store = new Store(folder);
      assert.throws(() => store.load(), /Could not move your boards into the new database: Board "roadmap-\w+" came back different \(board\.odd/);
      assert.throws(() => store.load(), /untouched\. Nothing was started\./);
      assert.deepEqual(names(folder), before, 'no database, no leftovers, no backup folder');
      assert.equal(readFileSync(path.join(folder, `${boards[0].id}.json`), 'utf8'), text);
    });

    it('keeps the files if two of them are one board', async () => {
      const { folder, boards } = await earlierFolder('Roadmap');
      writeFileSync(path.join(folder, 'copy.json'), JSON.stringify({ ...boards[0] }));
      const store = new Store(folder);
      assert.throws(() => store.load(), /are the same board/);
      assert.ok(existsSync(path.join(folder, 'copy.json')));
      assert.ok(!existsSync(path.join(folder, 'tricot.db')));
    });

    it('starts empty when there are no boards, and ignores board files that turn up beside a database', async () => {
      const first = new Store(dir);
      first.load();
      await first.flush();
      assert.ok(existsSync(path.join(dir, 'tricot.db')));
      const { folder, boards } = await earlierFolder('Late');
      writeFileSync(path.join(dir, `${boards[0].id}.json`), readFileSync(path.join(folder, `${boards[0].id}.json`)));
      const second = new Store(dir);
      second.load();
      assert.deepEqual(second.listBoards(), []);
      await second.flush();
    });
  });

  describe('migrations', () => {
    const first: Migration = { name: 'one', up: (db) => db.exec('CREATE TABLE one (n INTEGER)') };
    const second: Migration = { name: 'two', up: (db) => db.exec('CREATE TABLE two (n INTEGER); INSERT INTO two VALUES (2)') };

    it('adds the table of dismissed needs to a version 2 file, after a copy of it', () => {
      const file = path.join(dir, 'tricot.db');
      openDatabase(file, MIGRATIONS.slice(0, 2)).close();
      const db = openDatabase(file);
      assert.equal(userVersion(db), MIGRATIONS.length);
      db.prepare('INSERT INTO need_dismissals (person, board, key, at) VALUES (?, ?, ?, ?)').run('sam', 'b', 'k', '2026-10-01T00:00:00.000Z');
      assert.deepEqual(db.prepare('SELECT person, key FROM need_dismissals').all().map((r) => ({ ...r })), [{ person: 'sam', key: 'k' }]);
      db.close();
      assert.match(names(path.join(dir, 'backups'))[0], /^tricot-v2-/);
    });

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

    it('stops the store from starting on a newer file, with its boards untouched', async () => {
      const store = new Store(dir);
      store.load();
      store.createBoard({ title: 'Mine' }, human);
      await store.flush();
      const file = path.join(dir, 'tricot.db');
      const newer = openDatabase(file, [...MIGRATIONS, first]);
      newer.close();
      const before = { sha: sha(file), files: names(dir) };
      const next = new Store(dir);
      assert.throws(() => next.load(), new RegExp(`saved by a newer Tricot \\(data version ${MIGRATIONS.length + 1}; this one understands up to ${MIGRATIONS.length}\\)`));
      assert.deepEqual({ sha: sha(file), files: names(dir) }, before);
    });
  });

  describe('data version 2: events and block versions in tables of their own', () => {
    type Legacy = ReturnType<typeof legacyBoard>;
    const count = (db: ReturnType<typeof openDatabase>, sql: string) => Number((db.prepare(sql).get() as { n: number }).n);

    // A database as data version 1 held a board: its events in rows of 100, and each block carrying its versions.
    function version1(file: string, legacy: Legacy): void {
      const db = openDatabase(file, [MIGRATIONS[0]]);
      const { board, events, versions } = splitLegacyBoard(legacy);
      inTransaction(db, () => {
        const put = db.prepare('INSERT INTO items (board, owner, kind, id, pos, body) VALUES (?, ?, ?, ?, ?, ?)');
        for (const op of new BoardImage().plan(board, Dirty.everything())) {
          if (op.type === 'header') db.prepare('INSERT INTO boards (key, id, pos, body) VALUES (?, ?, 0, ?)').run(boardKey(board), op.id, op.body);
          else if (op.type === 'put') put.run(boardKey(board), op.row.owner, op.row.kind, op.row.id, op.row.pos, op.row.body);
        }
        for (let at = 0; at < events.length; at += 100) {
          put.run(boardKey(board), '', 'events', String(at / 100).padStart(8, '0'), at / 100, JSON.stringify(events.slice(at, at + 100)));
        }
        for (const change of versions) {
          if (change.op !== 'add') continue;
          const row = db.prepare("SELECT body FROM items WHERE kind = 'block' AND id = ?").get(change.block) as { body: string };
          const body = JSON.stringify({ ...JSON.parse(row.body), versions: change.versions });
          db.prepare("UPDATE items SET body = ? WHERE kind = 'block' AND id = ?").run(body, change.block);
        }
      });
      db.close();
    }

    async function legacyOf(title: string): Promise<{ legacy: Legacy; doomed: string }> {
      const source = new Store(scratch());
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
        db.prepare('SELECT seq, type, actor_name, decision_id FROM events WHERE board = ? ORDER BY seq LIMIT 2').all(key).map((r) => ({ ...r })),
        legacy.events.slice(0, 2).map((e) => ({ seq: e.seq, type: e.type, actor_name: e.actor.name, decision_id: e.decisionId ?? null })),
        'the columns are read out of each event',
      );
      assert.equal(count(db, `SELECT COUNT(*) AS n FROM block_versions WHERE board = '${key}'`), 1);
      assert.deepEqual(db.prepare('SELECT block, rev FROM block_versions').all().map((r) => r.rev), [1]);
      db.close();

      // The store reads it as the board it was, and goes on from the last event.
      const store = new Store(dir);
      store.load();
      assert.deepEqual(legacyBoard(store, legacy.id), legacy);
      const last = legacy.events.at(-1)!;
      assert.equal(store.getBoard(legacy.id).seq, last.seq);
      store.addComment(legacy.decisions[0].id, 'After the move', human);
      assert.equal(eventsOf(store, legacy.id).at(-1)!.seq, last.seq + 1);
      await store.flush();
    });

    it("leaves the versions of a removed block in their table, to come back with it, and what a person deleted with the deletion", async () => {
      const { legacy, doomed } = await legacyOf('Roadmap');
      const file = path.join(dir, 'tricot.db');
      version1(file, legacy);
      // The removed block had versions in v1, inside the block the deletion keeps.
      const raw = openDatabase(file, [MIGRATIONS[0]]);
      const row = raw.prepare("SELECT body FROM items WHERE kind = 'deletion' AND id = ?").get(doomed) as { body: string };
      const deletion = JSON.parse(row.body);
      deletion.kept.block.rev = 2;
      deletion.kept.block.versions = [{ type: 'note', text: 'Soon gone, once', rev: 1, at: '2026-10-01T00:00:00.000Z', by: { kind: 'human', name: 'Sam' } }];
      deletion.kept.versions = [{ type: 'note', text: 'A deleted one', rev: 7, at: '2026-10-01T00:00:00.000Z', by: { kind: 'human', name: 'Sam' } }];
      raw.prepare("UPDATE items SET body = ? WHERE kind = 'deletion' AND id = ?").run(JSON.stringify(deletion), doomed);
      raw.close();

      const db = openDatabase(file);
      const body = JSON.parse((db.prepare("SELECT body FROM items WHERE kind = 'deletion' AND id = ?").get(doomed) as { body: string }).body);
      assert.equal(body.kept.block.versions, undefined, 'moved out of the block it kept');
      assert.equal(body.kept.versions.length, 1, 'what a person deleted from another block stays with its deletion');
      assert.deepEqual(db.prepare('SELECT block, rev FROM block_versions WHERE block = ?').all(doomed).map((r) => r.rev), [1]);
      db.close();

      const store = new Store(dir);
      store.load();
      store.restoreItem(doomed, human);
      const block = store.blockOf(doomed);
      assert.equal(block.versionCount, 1, 'it comes back with its versions');
      assert.deepEqual(versionsOf(store, doomed).map((v) => [v.rev, v.type === 'note' && v.text]), [[1, 'Soon gone, once']]);
      await store.flush();
    });

    it('does not open the file a second time as a version 1 one, and keeps the copy it made', async () => {
      const { legacy } = await legacyOf('Roadmap');
      const file = path.join(dir, 'tricot.db');
      version1(file, legacy);
      openDatabase(file, MIGRATIONS.slice(0, 2)).close();
      openDatabase(file, MIGRATIONS.slice(0, 2)).close();
      assert.equal(names(path.join(dir, 'backups')).length, 1, 'nothing to migrate, nothing to copy');
    });
  });

  describe('saving change by change', () => {
    const rowsOf = (board: Board): StoredRow[] => {
      const image = new BoardImage();
      const ops = image.plan(board, Dirty.everything());
      return ops.flatMap((op) => (op.type === 'put' ? [op.row] : []));
    };
    const headOf = (board: Board) => {
      const op = new BoardImage().plan(board, Dirty.everything()).find((o) => o.type === 'header');
      return (op as Extract<Op, { type: 'header' }>).body;
    };
    const kinds = (ops: Op[]) => ops.map((op) => (op.type === 'header' ? 'header' : `${op.type} ${op.row.kind}`)).sort();

    async function savedStore() {
      const store = new Store(dir);
      store.load();
      const board = populate(store, 'Roadmap');
      await store.flush();
      return savedBoard(dir, board.id);
    }

    it('holds a board as a header and a row for each part, and joins them back the same', async () => {
      const board = await savedStore();
      const rows = rowsOf(board);
      const count = (kind: string) => rows.filter((r) => r.kind === kind).length;
      assert.deepEqual([count('decision'), count('task'), count('thread'), count('deletion'), count('pin')], [1, 1, 1, 1, 1]);
      assert.equal(count('events'), 0, 'the event log is not among them');
      assert.ok(!headOf(board).includes('"activity"'), 'nor is what the log says of who acted');
      // How many versions a block has is the versions table's to say, so the rows don't carry it.
      const versioned = board.canvas.blocks.filter((b) => b.versionCount);
      assert.equal(versioned.length, 1);
      assert.ok(!rows.some((r) => r.body.includes('versionCount')));
      for (const block of versioned) delete block.versionCount;
      assert.deepEqual(joinBoard(headOf(board), rows).board, board);
    });

    it('writes only the part a change names, with the board header, which moves with every change', async () => {
      const board = await savedStore();
      const image = new BoardImage();
      image.apply(image.plan(board, Dirty.everything()));
      const total = image.rowCount;

      const task = board.tasks[0];
      task.title = 'Wire it, again';
      const named = new Dirty();
      named.tasks.add(task.id);
      assert.deepEqual(kinds(image.plan(board, named)), ['put task']);
      assert.deepEqual(kinds(image.plan(board, new Dirty())), [], 'what nothing names is not looked at');

      // A new event moves the header's seq and time, and nothing else of the board.
      board.seq++;
      board.updatedAt = '2026-11-01T00:00:00.000Z';
      const ops = image.plan(board, named);
      assert.deepEqual(kinds(ops), ['header', 'put task']);
      image.apply(ops);
      assert.equal(image.rowCount, total);

      // A block edited on a decision's canvas: that block's row.
      const decision = board.decisions[0];
      decision.canvas.blocks[0] = { ...decision.canvas.blocks[0], rev: 99 } as typeof decision.canvas.blocks[0];
      const onDecision = new Dirty();
      onDecision.decisions.add(decision.id);
      assert.deepEqual(kinds(image.plan(board, onDecision)), ['put block']);
      // A block taken off it: its row goes.
      decision.canvas.blocks.splice(0, 1);
      assert.ok(kinds(image.plan(board, onDecision)).includes('delete block'));
    });

    it('writes only what changed, even when it is told everything may have', async () => {
      const board = await savedStore();
      const image = new BoardImage();
      image.apply(image.plan(board, Dirty.everything()));
      assert.deepEqual(image.plan(board, Dirty.everything()), [], 'nothing changed, nothing to write');
      board.tasks[0].title = 'Different';
      assert.deepEqual(kinds(image.plan(board, Dirty.everything())), ['put task']);
    });

    it('keeps a change made a moment ago after a kill, without a flush', async () => {
      const store = new Store(dir);
      store.load();
      const board = store.createBoard({ title: 'Quick' }, human);
      await sleep(150);
      const other = new Store(dir); // the file as the disk has it, the first store still holding its connection
      other.load();
      assert.equal(other.getBoard(board.id).title, 'Quick');
      await other.flush();
      await store.flush();
    });

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
      const [boardId, decisionId] = out.trim().split(' ');
      assert.match(err, /a warning of its own/, 'other warnings still show');
      assert.doesNotMatch(err, /SQLite|ExperimentalWarning: SQLite/);

      const store = new Store(dir);
      store.load();
      assert.equal(store.getBoard(boardId).title, 'Survives a kill');
      const { decision } = store.getDecision(decisionId);
      assert.equal(decision.question, 'Still here?');
      assert.equal(decision.canvas.blocks.length, 1);
      assert.deepEqual(eventsOf(store, boardId).map((e) => e.type), ['board_created', 'decision_posted', 'canvas_changed']);
      await store.flush();
    });

    it('keeps a change that named too little, once the board is compared whole', async () => {
      const board = await savedStore();
      let boards: Board[] = [];
      const db = new BoardDb(dir, (key) => boards.find((b) => boardKey(b) === key));
      db.checking = false;
      boards = db.readAll();
      boards[0].decisions[0].question = 'Changed by hand';
      db.changed(boardKey(boards[0]), new Dirty());
      await db.flush();
      assert.equal(savedBoard(dir, board.id).decisions[0].question, 'Changed by hand');
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
