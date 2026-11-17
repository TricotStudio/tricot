import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Store } from '../src/core/store';
import { DATABASE_FILE } from '../src/core/store/boardDb';
import type { Actor } from '../src/core/types';
import { CardStore, seedCards } from './madeUpCards';
import { removeScratch } from './platform';

// A picture file and an id are safe in a Store that does not load a card's rows. A Store with no entity list registered
// never reads a card or what is on its canvas, so the check for which picture files are still in use, which looked at the
// boards in memory, could not see a picture only a card's canvas shows, and a page, a board or a lapsed deletion took the file
// away. A backup holds only the database, so the loss cannot be recovered. The check now also reads the rows that name a picture,
// whichever lists are registered.

const sam: Actor = { kind: 'human', name: 'Sam' };

// A PNG's header: enough for the store to accept it as a picture.
function png(width: number, height: number): Uint8Array {
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), ...text('IHDR'), ...u32(width), ...u32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0]);
}

const onDisk = (dir: string, assetId: string) => existsSync(path.join(dir, 'assets', assetId));

describe('The check of pictures in use, in a Store with no list, over rows it does not read', () => {
  let dir: string;
  let store: Store | undefined;
  beforeEach(() => {
    store = undefined;
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-pictures-rows-'));
  });
  afterEach(async () => {
    await store?.flush().catch(() => {});
    removeScratch(dir);
  });

  // The key of the only board of `dir`, and a statement that puts a row into `items` of it.
  function withItems<T>(work: (put: (owner: string, kind: string, id: string, body: string) => void, key: string) => T): T {
    const sqlite = process.getBuiltinModule('node:sqlite')!;
    const db = new sqlite.DatabaseSync(path.join(dir, DATABASE_FILE));
    try {
      const { key } = db.prepare('SELECT key FROM boards').get() as { key: string };
      const insert = db.prepare('INSERT INTO items (board, owner, kind, id, pos, body) VALUES (?, ?, ?, ?, 0, ?)');
      return work((owner, kind, id, body) => void insert.run(key, owner, kind, id, body), key);
    } finally {
      db.close();
    }
  }

  const madeBoard = (): Promise<{ boardId: string; pageId: string }> =>
    seedCards(dir, (full) => {
      const boardId = full.createBoard({ title: 'Rows' }, sam).id;
      return { boardId, pageId: full.addPage(boardId, 'A page', sam).id };
    });

  it('keeps a picture a row names whose body cannot be read, because a file removed wrongly is lost for good', async () => {
    const { boardId, pageId } = await madeBoard();
    const full = new CardStore(dir);
    full.load();
    const unreadable = full.saveAsset(png(11, 11));
    const readable = full.saveAsset(png(12, 12));
    const unnamed = full.saveAsset(png(13, 13));
    for (const assetId of [unreadable, readable, unnamed]) full.addBlock({ pageId }, { content: { type: 'image', assetId } }, sam);
    await full.flush();
    withItems((put) => {
      put('ticket:aaaaaa', 'block', 'bbbbbb', `{ not json: "${unreadable}"`);
      put('memo:cccccc', 'block', 'dddddd', JSON.stringify({ id: 'dddddd', type: 'image', assetId: readable }));
      put('memo:cccccc', 'block', 'eeeeee', JSON.stringify({ id: 'eeeeee', type: 'note', text: `quoted ${unnamed} in a note` }));
    });
    store = new Store(dir, { parts: [] });
    store.load();
    store.deletePage(pageId, sam);
    await store.flush();
    assert.ok(onDisk(dir, unreadable), 'a row that cannot be read keeps the pictures it holds');
    assert.ok(onDisk(dir, readable), 'a block of a canvas the store does not read');
    assert.ok(!onDisk(dir, unnamed), "a note that only mentions a file's name does not show it, so this is a check that the rows are read");
    assert.ok(boardId);
  });

  it('looks for more pictures than one pass holds: a board deleted with hundreds of them keeps the one a foreign row shows', async () => {
    const { boardId } = await madeBoard();
    const other = new CardStore(dir);
    other.load();
    const second = other.createBoard({ title: 'Second' }, sam).id;
    const ids: string[] = [];
    for (let i = 0; i < 250; i++) {
      const assetId = other.saveAsset(png(10 + i, 10));
      ids.push(assetId);
      other.addBlock({ boardId: second }, { content: { type: 'image', assetId } }, sam);
    }
    await other.flush();
    withItems((put) => {
      put('ticket:aaaaaa', 'block', 'bbbbbb', JSON.stringify({ id: 'bbbbbb', type: 'image', assetId: ids[203] }));
    });
    store = new Store(dir, { parts: [] });
    store.load();
    store.setArchived(second, true, sam);
    store.deleteBoard(second, sam, 'Second');
    await store.flush();
    assert.deepEqual(ids.filter((assetId) => onDisk(dir, assetId)), [ids[203]], 'every picture goes but the one a row of the first board names, past the first pass');
    assert.ok(boardId);
  });
});
