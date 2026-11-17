import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { keepPrivate } from '../../platform/private';

export type Database = DatabaseSync;
export type Statement = StatementSync;

type SqliteModule = typeof import('node:sqlite');

let sqlite: SqliteModule | undefined;

// node:sqlite prints "SQLite is an experimental feature" the first time it
// loads. That one warning is dropped; every other warning still shows.
function quietExperimentalSqliteWarning(): void {
  const emit = process.emit as (...args: unknown[]) => boolean;
  process.emit = function (this: unknown, name: unknown, payload: unknown, ...rest: unknown[]): boolean {
    const warning = payload as Partial<Error> | undefined;
    if (name === 'warning' && warning?.name === 'ExperimentalWarning' && /\bSQLite\b/.test(warning.message ?? '')) return false;
    return emit.call(this, name, payload, ...rest);
  } as typeof process.emit;
}

// Loaded on first use, after the warning is silenced, and not imported
// statically, so a bundle keeps it a plain run-time lookup of Node's own module.
function sqliteModule(): SqliteModule {
  if (sqlite) return sqlite;
  quietExperimentalSqliteWarning();
  const loaded = process.getBuiltinModule?.('node:sqlite');
  if (!loaded) throw new Error(`Tricot needs Node 22.13 or newer to store boards (this is ${process.version}).`);
  return (sqlite = loaded);
}

// Whether a commit waits for the disk. In real use it does (FULL), so not even
// a power cut loses a saved change, and asking for the save checks
// (TRICOT_CHECK_SAVES) leaves it so. Under the test runner every database is a
// scratch one, and the save checks commit after every call on the store
// (checkSaves.ts): there SQLite hands each commit to the system and goes on
// (OFF), which spares CI's Windows several milliseconds of flushing a commit.
// The same writes are made, in the same transactions, and read back the same;
// a process that is killed still keeps them. Only a power cut could lose them.
export const SYNCHRONOUS = process.env.NODE_TEST_CONTEXT ? 'OFF' : 'FULL';

// Opens the file, making it first with mode 600 when it is new: SQLite gives
// its -wal and -shm files the main file's mode, so all three are private.
export function openPrivate(file: string): Database {
  const { DatabaseSync } = sqliteModule();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!existsSync(file)) closeSync(openSync(file, 'a', 0o600));
  const db = new DatabaseSync(file);
  keepPrivate(file);
  return db;
}

export function inTransaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
