import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Store } from '../src/core/store';
import { DATABASE_FILE } from '../src/core/store/boardDb';
import { MIGRATIONS, openDatabase, userVersion, type Migration } from '../src/core/store/migrations';
import { dataBeforeStart, restoreAfterFailedUpdate } from '../src/core/store/restore';
import { removeScratch } from './platform';

// Undoing an update that didn't come up (install/handoff.ts): the copy the new
// version took when it started is put back, the file it left is kept, and
// nothing in backups is deleted.
describe('Putting the data back after a failed update', () => {
  let dir: string;
  let file: string;
  const known = MIGRATIONS.length;
  const newer: Migration = { name: 'what only the newer one reads', up: (db) => db.exec('CREATE TABLE from_the_newer_one (n INTEGER); INSERT INTO from_the_newer_one VALUES (1)') };
  const backups = () => (existsSync(path.join(dir, 'backups')) ? readdirSync(path.join(dir, 'backups')).sort() : []);
  const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
  const versionOf = (f: string, migrations: Migration[]) => {
    const db = openDatabase(f, migrations);
    try {
      return userVersion(db);
    } finally {
      db.close();
    }
  };
  const tables = (f: string, migrations: Migration[]) => {
    const db = openDatabase(f, migrations);
    try {
      return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    } finally {
      db.close();
    }
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-restore-'));
    file = path.join(dir, DATABASE_FILE);
    const store = new Store(dir);
    store.load();
    store.createBoard({ title: 'Before' }, { kind: 'human', name: 'Sam' });
    await store.flush();
  });
  afterEach(() => removeScratch(dir));

  it('leaves a file the old version reads as it is', () => {
    const before = dataBeforeStart(dir);
    assert.equal(before.version, known);
    const kept = sha(file);
    assert.deepEqual(restoreAfterFailedUpdate(dir, before, known), { kind: 'readable' });
    assert.equal(sha(file), kept);
    assert.deepEqual(backups(), []);
  });

  it('puts back the copy the newer version took, and keeps the file it left', () => {
    const before = dataBeforeStart(dir);
    openDatabase(file, [...MIGRATIONS, newer]).close(); // the new version starts: a copy, then its migration
    assert.equal(backups().length, 1);
    const [copy] = backups();
    const copySha = sha(path.join(dir, 'backups', copy));

    const result = restoreAfterFailedUpdate(dir, before, known);
    assert.equal(result.kind, 'restored');
    if (result.kind !== 'restored') return;
    assert.deepEqual([result.version, result.was], [known, known + 1]);
    assert.equal(result.backup, path.join(dir, 'backups', copy));

    assert.equal(versionOf(file, MIGRATIONS), known, 'the old version opens it');
    assert.ok(!tables(file, MIGRATIONS).includes('from_the_newer_one'));
    assert.ok(!existsSync(`${file}-wal`) && !existsSync(`${file}-shm`) && !existsSync(`${file}.restoring`));
    // Nothing deleted, nothing changed: the copy as it was, and what the new version left, whole.
    assert.equal(backups().length, 2);
    assert.equal(sha(path.join(dir, 'backups', copy)), copySha);
    assert.ok(tables(result.kept, [...MIGRATIONS, newer]).includes('from_the_newer_one'));
    assert.equal(versionOf(result.kept, [...MIGRATIONS, newer]), known + 1);
  });

  it('keeps what the new version wrote after it migrated, apart from the boards put back', async () => {
    const before = dataBeforeStart(dir);
    const db = openDatabase(file, [...MIGRATIONS, newer]);
    db.exec(`UPDATE boards SET body = json_set(body, '$.title', 'Changed by the newer one')`);
    db.close();
    const result = restoreAfterFailedUpdate(dir, before, known);
    assert.equal(result.kind, 'restored');
    if (result.kind !== 'restored') return;
    const store = new Store(dir);
    store.load();
    assert.deepEqual(store.listBoards().map((b) => b.title), ['Before']);
    await store.flush();
    const left = openDatabase(result.kept, [...MIGRATIONS, newer]);
    assert.deepEqual(left.prepare("SELECT json_extract(body, '$.title') AS title FROM boards").all().map((r) => r.title), ['Changed by the newer one']);
    left.close();
  });

  it("changes nothing when the new version took no copy, and says why", () => {
    const before = dataBeforeStart(dir);
    // The file is newer, but no copy came from this start: another's, already there, is not it.
    openDatabase(file, [...MIGRATIONS, newer]).close();
    const [other] = backups();
    const there = dataBeforeStart(dir);
    assert.ok(there.backups.has(other));
    const kept = sha(file);
    const result = restoreAfterFailedUpdate(dir, { ...there, version: before.version }, known);
    assert.equal(result.kind, 'failed');
    assert.match(result.kind === 'failed' ? result.why : '', /took no copy/);
    assert.equal(sha(file), kept);
    assert.equal(backups().length, 1);
  });

  it('changes nothing when the copy is not a database of the version the data was at', () => {
    const before = dataBeforeStart(dir);
    openDatabase(file, [...MIGRATIONS, newer]).close();
    const [copy] = backups();
    writeFileSync(path.join(dir, 'backups', copy), 'not a database');
    const kept = sha(file);
    const result = restoreAfterFailedUpdate(dir, before, known);
    assert.equal(result.kind, 'failed');
    assert.match(result.kind === 'failed' ? result.why : '', /couldn't be put back/);
    assert.equal(sha(file), kept, 'the file the new version left is as it was');
    assert.ok(!existsSync(`${file}.restoring`));
    assert.equal(backups().length, 1, 'and nothing was kept as there was nothing replaced');
  });

  it('picks the copy from this start, not one already there with the same version in its name', () => {
    // From an earlier upgrade: it sorts after any copy made now, and is not this start's.
    mkdirSync(path.join(dir, 'backups'));
    const older = path.join(dir, 'backups', `tricot-v${known}-2999-01-01T00-00-00-000Z.db`);
    copyFileSync(file, older);
    const before = dataBeforeStart(dir);
    openDatabase(file, [...MIGRATIONS, newer]).close();
    const result = restoreAfterFailedUpdate(dir, before, known);
    assert.equal(result.kind, 'restored');
    assert.notEqual(result.kind === 'restored' && result.backup, older);
    assert.ok(backups().includes(path.basename(older)), 'left where it is');
    assert.equal(backups().length, 3, 'the older, this start\'s, and what the new version left');
  });
});
