import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DATABASE_FILE } from '../src/core/store/boardDb';
import { MIGRATIONS, openDatabase, userVersion } from '../src/core/store/migrations';
import type { Database } from '../src/core/store/sqlite';
import { removeScratch } from './platform';

// Data version 7: what the repository gave each board as it loaded (a canvas,
// pins, comments, a rev, …) is now filled in once, by a migration, on a file at
// version 6 (see shapeDefaults.ts).
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tricot-0.1.3.db');
const V6 = MIGRATIONS.slice(0, 6);

const rowsOf = (db: Database, table: 'boards' | 'items') => db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3, 4`).all().map((row) => ({ ...row }));

describe('Data version 7: every board carries the fields it is read with', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-shape-'));
    file = path.join(dir, DATABASE_FILE);
    copyFileSync(FIXTURE, file);
  });
  afterEach(() => removeScratch(dir));

  it('changes not one row of a database at version 6 that already has them', () => {
    const db = openDatabase(file, V6);
    const rows = { boards: rowsOf(db, 'boards'), items: rowsOf(db, 'items') };
    db.close();
    const migrated = openDatabase(file);
    assert.equal(userVersion(migrated), MIGRATIONS.length);
    assert.deepEqual({ boards: rowsOf(migrated, 'boards'), items: rowsOf(migrated, 'items') }, rows);
    migrated.close();
  });
});
