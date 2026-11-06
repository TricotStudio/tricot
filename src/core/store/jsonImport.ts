import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { keepPrivate } from '../../platform/private';
import { BoardWriter, readBoards } from './boardTables';
import { BoardImage, Dirty, firstDifference } from './boardRows';
import { EventTables } from './eventTables';
import { splitLegacyBoard, type SplitBoard } from './legacyBoard';
import { openDatabase } from './migrations';
import { inTransaction } from './sqlite';
import { VersionTables } from './versionTables';
import { boardKey, type Board } from '../types';

// Tricot's boards used to be one JSON file each in the data folder. The first
// time it starts with such files and no database, they are copied into the
// database in one go and checked against it; the files are then moved, not
// deleted, into <data>/backup-json-<date>.
export class ImportError extends Error {}

interface BoardFile {
  file: string;
  board: Board;
}

// Every board file in the folder. Other JSON in it isn't a board (a
// connector's OAuth client file, say) and an unreadable file is reported; both
// are left where they are. A file still under a renamed board's earlier id
// (the server stopped mid-rename) is an older copy of it, and is left out.
function readBoardFiles(dataDir: string): { current: BoardFile[]; stale: BoardFile[] } {
  const files: BoardFile[] = [];
  for (const file of readdirSync(dataDir).sort()) {
    if (!file.endsWith('.json')) continue;
    try {
      const board = JSON.parse(readFileSync(path.join(dataDir, file), 'utf8')) as Board;
      if (typeof board?.id !== 'string' || !Array.isArray(board.decisions)) continue;
      files.push({ file, board });
    } catch (error) {
      console.error(`Skipping unreadable board file ${file}:`, error);
    }
  }
  const renamed = new Set(files.flatMap(({ board }) => board.aliases ?? []));
  return {
    current: files.filter(({ board }) => !renamed.has(board.id)),
    stale: files.filter(({ board }) => renamed.has(board.id)),
  };
}

// Reads the new file back and compares every board with the one imported:
// the board, its events, and its blocks' versions.
function verify(file: string, imported: SplitBoard[]): void {
  const db = openDatabase(file);
  try {
    const saved = readBoards(db);
    if (saved.length !== imported.length) {
      throw new ImportError(`${imported.length} boards went in and ${saved.length} came back.`);
    }
    const events = new EventTables(db);
    const versions = new VersionTables(db);
    for (const { board, events: logged, versions: changes } of imported) {
      const key = boardKey(board);
      const back = saved.find((s) => s.key === key)?.board;
      if (!back) throw new ImportError(`Board "${board.id}" did not come back.`);
      if (!isDeepStrictEqual(board, back)) {
        throw new ImportError(`Board "${board.id}" came back different (${firstDifference(board, back)}).`);
      }
      const eventsBack = events.query(key, { order: 'asc' });
      if (!isDeepStrictEqual(logged, eventsBack)) {
        throw new ImportError(`The events of board "${board.id}" came back different (${firstDifference(logged, eventsBack, 'events')}).`);
      }
      for (const change of changes) {
        if (change.op !== 'add') continue;
        const versionsBack = versions.list(key, change.block);
        if (!isDeepStrictEqual(change.versions, versionsBack)) {
          throw new ImportError(`The versions of block "${change.block}" on board "${board.id}" came back different.`);
        }
      }
    }
  } finally {
    db.close();
  }
}

function moveToBackup(dataDir: string, files: string[], today: Date): string {
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  let dir = path.join(dataDir, `backup-json-${date}`);
  for (let n = 2; existsSync(dir); n++) dir = path.join(dataDir, `backup-json-${date}-${n}`);
  mkdirSync(dir, { mode: 0o700 });
  for (const file of files) {
    renameSync(path.join(dataDir, file), path.join(dir, file));
    keepPrivate(path.join(dir, file));
  }
  return dir;
}

// A board deleted for good also leaves the JSON copies the import kept: each
// backup-json-* folder holds one <id>.json per board, under the id it had then.
// Whole-database copies in <data>/backups are left as they are.
export function removeBackedUpBoardFiles(dataDir: string, ids: string[]): void {
  const names = ids.filter((id) => /^[A-Za-z0-9_-]+$/.test(id)).map((id) => `${id}.json`);
  for (const folder of readdirSync(dataDir, { withFileTypes: true })) {
    if (!folder.isDirectory() || !folder.name.startsWith('backup-json-')) continue;
    for (const name of names) rmSync(path.join(dataDir, folder.name, name), { force: true });
  }
}

// Builds `file` from the board files in the folder, or does nothing when
// there are none. The database is made beside it and only takes its place once
// it has been read back and found the same; if anything differs, the board
// files are untouched, and this throws.
export function importBoardFiles(dataDir: string, file: string): void {
  const { current, stale } = readBoardFiles(dataDir);
  if (current.length === 0) return;
  const keys = new Set<string>();
  for (const { file: name, board } of current) {
    if (keys.has(boardKey(board))) throw new ImportError(`Two board files, one of them ${name}, are the same board "${boardKey(board)}".`);
    keys.add(boardKey(board));
  }

  const building = `${file}.importing`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(building + suffix, { force: true });
  try {
    const db = openDatabase(building);
    const split = current.map(({ board }) => splitLegacyBoard(board));
    try {
      const writer = new BoardWriter(db);
      inTransaction(db, () => {
        for (const { board, events, versions } of split) writer.write(boardKey(board), new BoardImage().plan(board, Dirty.everything()), events, versions);
      });
    } finally {
      db.close();
    }
    verify(building, split);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(building + suffix)) throw new ImportError(`${building}${suffix} was left behind.`);
    }
    renameSync(building, file);
  } catch (error) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(building + suffix, { force: true });
    throw new ImportError(
      `Could not move your boards into the new database: ${error instanceof Error ? error.message : error}\n` +
        `Your board files in ${dataDir} are untouched. Nothing was started.`,
    );
  }
  const backup = moveToBackup(dataDir, [...current, ...stale].map((f) => f.file), new Date());
  console.log(`Moved ${current.length} board${current.length === 1 ? '' : 's'} into ${file}. The JSON files are kept in ${backup}.`);
}
