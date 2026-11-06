import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { keepPrivate } from '../../platform/private';
import { DATABASE_FILE } from './boardDb';
import { BACKUP_DIR, MIGRATIONS, userVersion } from './migrations';
import { openPrivate } from './sqlite';

// Putting the data back as it was, for an update that has to be undone. A
// Tricot that starts on an older file copies it into <data>/backups first
// (migrations.ts), then migrates it; the old one refuses what that leaves
// (NewerDataError). So when an update's new version is stopped, its updater
// puts that copy back before the old version starts again.
//
// What the new version changed in the seconds it ran is not in the copy, and is
// not carried over: it was written in a shape the old version can't read, and
// no migration goes backwards. It isn't thrown away either: the file as the new
// version left it is kept in <data>/backups beside the copy, and nothing in
// backups is ever deleted or changed.

// What the data folder held when the new version was about to start.
export interface DataBefore {
  version: number | undefined; // the database's data version, none if there is no database
  backups: Set<string>; // the files in <data>/backups
}

export type RestoreOutcome =
  | { kind: 'readable' } // the file is one the old version reads: nothing to put back
  | { kind: 'restored'; backup: string; kept: string; version: number; was: number }
  | { kind: 'failed'; why: string; was: number };

const file = (dataDir: string) => path.join(dataDir, DATABASE_FILE);
const backupDir = (dataDir: string) => path.join(dataDir, BACKUP_DIR);

function backupNames(dataDir: string): string[] {
  try {
    return readdirSync(backupDir(dataDir));
  } catch {
    return [];
  }
}

// The data version of a database file, or undefined when it isn't one that opens.
function versionOf(db: string): number | undefined {
  if (!existsSync(db)) return undefined;
  let handle: ReturnType<typeof openPrivate> | undefined;
  try {
    handle = openPrivate(db);
    return userVersion(handle);
  } catch {
    return undefined;
  } finally {
    handle?.close();
  }
}

export function dataBeforeStart(dataDir: string): DataBefore {
  return { version: versionOf(file(dataDir)), backups: new Set(backupNames(dataDir)) };
}

// Undoes what a version that was started and stopped did to the data, when it
// left it in a version this one, `known`, can't read: by putting back the copy
// that version took when it started, and keeping what it left. Nothing is
// changed unless the copy is found, and is a database of the version the data
// was at. `known` is the newest data version this Tricot reads.
export function restoreAfterFailedUpdate(dataDir: string, before: DataBefore, known: number = MIGRATIONS.length): RestoreOutcome {
  const live = file(dataDir);
  const was = versionOf(live);
  if (was === undefined || was <= known) return { kind: 'readable' };
  const unreadable = (why: string): RestoreOutcome => ({ kind: 'failed', why, was });
  if (before.version === undefined) return unreadable('there was no database before it started');

  const prefix = `tricot-v${before.version}-`;
  const taken = backupNames(dataDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.db') && !before.backups.has(name))
    .sort()
    .at(-1);
  if (!taken) return unreadable(`it took no copy of the data when it started, so there is none to put back`);

  const backup = path.join(backupDir(dataDir), taken);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const kept = path.join(backupDir(dataDir), `tricot-failed-update-v${was}-${stamp}.db`);
  const putting = `${live}.restoring`;
  try {
    // The copy is checked as a copy: the original is only read.
    copyFileSync(backup, putting);
    const check = openPrivate(putting);
    try {
      const found = userVersion(check);
      if (found !== before.version) throw new Error(`${taken} is at data version ${found}, not ${before.version}`);
      const verdict = check.prepare('PRAGMA quick_check').get() as { quick_check: string };
      if (verdict.quick_check !== 'ok') throw new Error(`${taken} didn't pass SQLite's check (${verdict.quick_check})`);
    } finally {
      check.close();
    }

    // The file as the new version left it, whole, before anything replaces it.
    mkdirSync(backupDir(dataDir), { recursive: true, mode: 0o700 });
    const db = openPrivate(live);
    try {
      db.prepare('VACUUM INTO ?').run(kept);
    } finally {
      db.close();
    }
    keepPrivate(kept);

    // Its side files belong to it, and would be read as the copy's.
    for (const suffix of ['-wal', '-shm']) rmSync(live + suffix, { force: true });
    renameSync(putting, live);
  } catch (error) {
    rmSync(putting, { force: true });
    return unreadable(`the copy couldn't be put back (${error instanceof Error ? error.message : error})`);
  }
  return { kind: 'restored', backup, kept, version: before.version, was };
}
