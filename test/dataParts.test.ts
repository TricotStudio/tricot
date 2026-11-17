import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Store } from '../src/core/store';
import { DATABASE_FILE } from '../src/core/store/databaseFile';
import { type DataPart, type PartMigration } from '../src/core/store/dataParts';
import { MIGRATIONS, MigrationError, NewerDataError, openData, openDatabase, partVersions, userVersion, type Migration } from '../src/core/store/migrations';
import { openPrivate, type Database } from '../src/core/store/sqlite';
import { removeScratch } from './platform';

// Each part of Tricot besides core keeps a data version of its own, in the
// data_versions table, while core's stays user_version. No part exists
// yet, so these add stand-ins: Extra, whose notes get a table and then a
// title, and Canvas, which comes later.
const K = MIGRATIONS.length; // core's data version now
const EXTRA: PartMigration[] = [
  { name: 'extra notes', core: K, up: (db) => db.exec("CREATE TABLE extra_notes (id TEXT PRIMARY KEY, text TEXT NOT NULL) STRICT; INSERT INTO extra_notes VALUES ('n1', 'First')") },
  { name: 'extra notes have a title', core: K, up: (db) => db.exec("ALTER TABLE extra_notes ADD COLUMN title TEXT NOT NULL DEFAULT 'Untitled'") },
];
const extra = (count: number, migrations: PartMigration[] = EXTRA): DataPart => ({ name: 'extra', migrations: migrations.slice(0, count) });
// A core migration newer than this Tricot's, for a newer Tricot to stand on.
const nextCore: Migration = { name: 'what only a newer core reads', up: (db) => db.exec('CREATE TABLE newer_core (n INTEGER)') };
const human = { kind: 'human' as const, name: 'Sam' };

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
// The file as it is, read without migrating it.
function look<T>(file: string, read: (db: Database) => T): T {
  const db = openPrivate(file);
  try {
    return read(db);
  } finally {
    db.close();
  }
}
const versions = (file: string) => look(file, (db) => ({ core: userVersion(db), parts: Object.fromEntries(partVersions(db)) }));
const tables = (file: string) => look(file, (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name));
const notes = (file: string) => look(file, (db) => db.prepare('SELECT * FROM extra_notes ORDER BY id').all().map((row) => ({ ...row })));

describe('A data version for each part', () => {
  let dir: string;
  let file: string;
  const backups = () => (existsSync(path.join(dir, 'backups')) ? readdirSync(path.join(dir, 'backups')).sort() : []);
  const open = (migrations: readonly Migration[], parts: readonly DataPart[]) => {
    const { db, off } = openData(file, migrations, parts);
    db.close();
    return off;
  };

  // A data folder with a board, saved by this Tricot, which has no part but core.
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-parts-'));
    file = path.join(dir, DATABASE_FILE);
    const store = new Store(dir);
    store.load();
    store.createBoard({ title: 'Kept' }, human);
    await store.flush();
  });
  afterEach(() => removeScratch(dir));

  it('makes a new file with core and every part at their newest, without a copy of nothing', () => {
    const fresh = path.join(dir, 'fresh', DATABASE_FILE);
    openDatabase(fresh, MIGRATIONS, [extra(2)]).close();
    assert.deepEqual(versions(fresh), { core: K, parts: { extra: 2 } });
    assert.ok(!existsSync(path.join(dir, 'fresh', 'backups')));
  });

  it('migrates a part added after core already has data, after a copy of the file', () => {
    assert.deepEqual(open(MIGRATIONS, [extra(2)]), []);
    assert.deepEqual(versions(file), { core: K, parts: { extra: 2 } });
    assert.deepEqual(notes(file), [{ id: 'n1', text: 'First', title: 'Untitled' }]);

    const [copy, ...more] = backups();
    assert.equal(more.length, 0);
    assert.match(copy, new RegExp(`^tricot-v${K}-\\d{4}-\\d\\d-\\d\\dT[\\d-]+Z\\.db$`), 'the file held no part yet, so the name says only core');
    const kept = path.join(dir, 'backups', copy);
    assert.deepEqual(versions(kept), { core: K, parts: {} }, 'the copy is the file as it was');
    assert.ok(!tables(kept).includes('extra_notes'));

    open(MIGRATIONS, [extra(2)]);
    assert.equal(backups().length, 1, 'nothing more to run, nothing more to copy');
  });

  it('copies the file once, before any part or core migrates, and names each part’s version after core’s', () => {
    open(MIGRATIONS, [extra(1)]);
    const [first] = backups();
    const canvas: DataPart = { name: 'canvas', migrations: [{ name: 'canvas marks', core: K + 1, up: (db) => db.exec('CREATE TABLE canvas_marks (n INTEGER)') }] };
    open([...MIGRATIONS, nextCore], [extra(2), canvas]);

    const copy = backups().find((name) => name !== first)!;
    assert.equal(backups().length, 2);
    assert.match(copy, new RegExp(`^tricot-v${K}-extra-v1-\\d{4}-.*\\.db$`));
    const kept = path.join(dir, 'backups', copy);
    assert.deepEqual(versions(kept), { core: K, parts: { extra: 1 } });
    assert.ok(!tables(kept).includes('newer_core') && !tables(kept).includes('canvas_marks'));
    assert.deepEqual(notes(kept), [{ id: 'n1', text: 'First' }], 'from before extra’s second migration');
    assert.deepEqual(versions(file), { core: K + 1, parts: { canvas: 1, extra: 2 } });
  });

  it('leaves alone a part whose data a newer Tricot saved, naming it, and opens the rest', () => {
    open(MIGRATIONS, [extra(2)]);
    const before = { notes: notes(file), backups: backups() };
    const off = open(MIGRATIONS, [extra(1)]);
    assert.equal(off.length, 1);
    assert.deepEqual({ ...off[0], message: undefined }, { part: 'extra', found: 2, known: 1, message: undefined });
    assert.match(off[0].message, /holds extra data saved by a newer Tricot \(extra data version 2; this one understands up to 1\)\. It is left as it is, and Tricot goes on without extra until it is updated\./);
    assert.deepEqual(versions(file).parts, { extra: 2 }, 'its version as the newer Tricot left it');
    assert.deepEqual({ notes: notes(file), backups: backups() }, before, 'nothing of it changed, and nothing to copy');
  });

  it('refuses a file whose core is newer whole, whatever its parts, changing nothing', () => {
    open([...MIGRATIONS, nextCore], [extra(1)]);
    const before = { sha: sha(file), files: readdirSync(dir).sort() };
    assert.throws(() => open(MIGRATIONS, [extra(2)]), (error: unknown) => {
      assert.ok(error instanceof NewerDataError);
      assert.match(error.message, new RegExp(`newer Tricot \\(data version ${K + 1}; this one understands up to ${K}\\)\\. Update Tricot to open it\\. Nothing was changed\\.`));
      return true;
    });
    assert.deepEqual({ sha: sha(file), files: readdirSync(dir).sort() }, before, 'not a byte, not a file');
  });

  it('leaves the file as it was before a part’s migration that fails, and says where the copy is', () => {
    open(MIGRATIONS, [extra(1)]);
    const broken: PartMigration = { name: 'broken', core: K, up: (db) => db.exec('CREATE TABLE half (n INTEGER); SELECT * FROM missing') };
    assert.throws(() => open(MIGRATIONS, [extra(3, [...EXTRA, broken])]), (error: unknown) => {
      assert.ok(error instanceof MigrationError);
      assert.match(error.message, /to extra data version 3 \(broken\): .*missing.*Nothing was lost; a copy from before is .*backups.*tricot-v\d+-extra-v1-/);
      return true;
    });
    assert.deepEqual(versions(file), { core: K, parts: { extra: 2 } }, 'the one before it stands');
    assert.ok(!tables(file).includes('half'), 'the failed one left nothing');
    assert.deepEqual(open(MIGRATIONS, [extra(2)]), []);
  });
});
