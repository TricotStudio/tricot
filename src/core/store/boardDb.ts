import { existsSync } from 'node:fs';
import path from 'node:path';
import { BoardImage, Dirty, type Op } from './boardRows';
import { BoardWriter, readBoards } from './boardTables';
import { changeFrom } from './changes';
import type { EventQuery } from './eventTables';
import { importBoardFiles, removeBackedUpBoardFiles } from './jsonImport';
import { openDatabase } from './migrations';
import { inTransaction, type Database } from './sqlite';
import type { NewChange } from '../changes';
import type { Dismissed } from '../needs';
import type { AgentSkill, SkillList, TricotSkill } from '../skills';
import { boardKey, type Board, type BlockVersion, type BoardEvent } from '../types';

export const DATABASE_FILE = 'tricot.db';

// Changes are written a moment after they are made, so a burst of them is one
// write. Each write is one transaction of only what changed, so a crash
// leaves a board as it was before the write or after it, never half.
const SAVE_DELAY_MS = 20;
// A board someone is looking at is written at once (the same tick's changes
// still go together), so they see a change as soon as it is saved.
const WATCHED_DELAY_MS = 0;
const RETRY_DELAY_MS = 1000;
// A change names what it touched (see Dirty), and the save trusts that. As
// well, each board is compared whole this long after a save that did, so a
// change that named too little is still kept.
const RECONCILE_DELAY_MS = 30_000;
// The tests check every save: a change that named too little fails loudly.
export const CHECK_SAVES = Boolean(process.env.NODE_TEST_CONTEXT) || process.env.TRICOT_CHECK_SAVES === '1';

class MissedChange extends Error {}

// Boards on disk: one SQLite file in the data folder, read once at start and
// written change by change. This is the only part of the store that knows how
// boards are kept. A board is read as it is now; its events and its blocks'
// versions are in tables of their own, read when asked for (events(),
// versions()) after anything waiting to be written has been. What a save
// changed is told on, as a change to the board (core/changes.ts), once it is written.
export class BoardDb {
  private db: Database | undefined;
  private writer: BoardWriter | undefined;
  private readonly images = new Map<string, BoardImage>(); // board key -> what the database holds of it
  private readonly pending = new Map<string, Dirty>();
  private readonly unchecked = new Set<string>(); // boards saved on what a change said, not yet compared whole
  private readonly checked = new WeakMap<Dirty, { events: number; versions: number }>(); // what a check has already told of
  private saveTimer: NodeJS.Timeout | undefined;
  private saveDue = 0;
  private reconcileTimer: NodeJS.Timeout | undefined;
  // Whether each save is checked against the whole board; tests turn it off to look at the safety net.
  checking = CHECK_SAVES;
  // Runs on a board just before each write.
  beforeWrite: (board: Board) => void = () => {};
  // Runs with each write's change to the board, for viewers.
  afterWrite: (key: string, change: NewChange) => void = () => {};
  // Whether anyone is looking at a board now.
  watched: (key: string) => boolean = () => false;

  constructor(
    private readonly dataDir: string,
    private readonly findBoard: (key: string) => Board | undefined,
  ) {}

  private get file(): string {
    return path.join(this.dataDir, DATABASE_FILE);
  }

  // The connection, opened when first needed: JSON board files are imported
  // if that makes the database, and it is migrated to the newest version.
  private connection(): { db: Database; writer: BoardWriter } {
    if (!this.db || !this.writer) {
      if (!existsSync(this.file)) importBoardFiles(this.dataDir, this.file);
      this.db = openDatabase(this.file);
      this.writer = new BoardWriter(this.db);
    }
    return { db: this.db, writer: this.writer };
  }

  // Every board in the database, oldest first, with what its log says of who acted.
  readAll(): Board[] {
    const { db, writer } = this.connection();
    return readBoards(db).map(({ key, board, image }) => {
      this.images.set(key, image);
      board.activity = writer.events.activity(key);
      return board;
    });
  }

  // Writes a board whole, now, whatever it was thought to hold: for a board
  // just read and tidied.
  adopt(board: Board): void {
    this.beforeWrite(board);
    this.write(boardKey(board), Dirty.everything(), false);
  }

  // `dirty` is what a change touched, with the events and version changes it
  // made; it is written soon.
  changed(key: string, dirty: Dirty): void {
    const pending = this.pending.get(key);
    if (pending) pending.merge(dirty);
    else this.pending.set(key, dirty);
    this.scheduleWrite(this.watched(key) ? WATCHED_DELAY_MS : SAVE_DELAY_MS);
  }

  // Removes a board from the database, in every table that keys on it, in one
  // transaction: all of it or none. What was waiting to be written for it is
  // dropped, and so are its files (by any of its `ids`) in the JSON backups of an import.
  deleteBoard(key: string, ids: string[]): void {
    const { db, writer } = this.connection();
    inTransaction(db, () => writer.remove(key));
    try {
      removeBackedUpBoardFiles(this.dataDir, ids);
    } catch (error) {
      console.error(`Could not remove board ${key} from the JSON backups in ${this.dataDir}:`, error);
    }
    this.pending.delete(key);
    this.unchecked.delete(key);
    this.images.delete(key);
  }

  // ---- reading what has tables of its own -----------------------------------

  // A board's events, as the query says.
  events(key: string, query: EventQuery): BoardEvent[] {
    this.settle(key);
    return this.connection().writer.events.query(key, query);
  }

  countEvents(key: string, query: EventQuery): number {
    this.settle(key);
    return this.connection().writer.events.count(key, query);
  }

  // A block's versions, oldest first.
  versions(key: string, block: string): BlockVersion[] {
    this.settle(key);
    return this.connection().writer.versions.list(key, block);
  }

  version(key: string, block: string, rev: number): BlockVersion | undefined {
    this.settle(key);
    return this.connection().writer.versions.get(key, block, rev);
  }

  versionRevs(key: string, block: string): number[] {
    this.settle(key);
    return this.connection().writer.versions.revs(key, block);
  }

  // The pictures a board's versions show.
  versionAssets(key: string): string[] {
    this.settle(key);
    return this.connection().writer.versions.assetsOf(key);
  }

  // Whether any block's version, on any board, shows this picture.
  versionShows(assetId: string): boolean {
    this.settle();
    return this.connection().writer.versions.showsAsset(assetId);
  }

  // ---- what people dismissed from their Needs you --------------------------

  dismissedNeeds(person: string): Record<string, Dismissed> {
    return this.connection().writer.dismissals.of(person);
  }

  dismissNeeds(person: string, key: string, items: { key: string; at: string }[]): void {
    this.connection().writer.dismissals.dismiss(person, key, items);
  }

  // ---- what agents reported of their skills ---------------------------------

  agentSkills(): SkillList[] {
    return this.connection().writer.skills.all();
  }

  reportSkills(agent: string, skills: AgentSkill[], at: string): void {
    this.connection().writer.skills.replace(agent, skills, at);
  }

  // ---- the skills people add in Tricot ----------------------------------------

  tricotSkills(): TricotSkill[] {
    return this.connection().writer.tricotSkills.all();
  }

  putTricotSkill(skill: TricotSkill): void {
    this.connection().writer.tricotSkills.put(skill);
  }

  deleteTricotSkill(id: string): void {
    this.connection().writer.tricotSkills.remove(id);
  }

  // Writes what is waiting for a board (or for all) now, so what is read next is current.
  private settle(key?: string): void {
    for (const waiting of key === undefined ? [...this.pending.keys()] : [key]) this.writeWaiting(waiting, false);
  }

  // ---- checking saves, in tests --------------------------------------------

  // For tests that check saves (CHECK_SAVES): what is waiting is written, and
  // checked, but stays waiting; and every board can be written whole. Neither
  // does the tidying a save does, which is left to the real ones.
  checkWaiting(): void {
    for (const [key, dirty] of this.pending) {
      const copy = new Dirty();
      copy.merge(dirty);
      this.write(key, copy, this.checked.get(dirty));
      this.checked.set(dirty, { events: dirty.events.length, versions: dirty.versions.length });
    }
  }

  writeEverything(): void {
    for (const key of this.images.keys()) this.write(key, Dirty.everything());
  }

  // Writes what is waiting, and lets go of the file. A change after this opens it again.
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    clearTimeout(this.reconcileTimer);
    this.reconcileTimer = undefined;
    this.writePending();
    for (const key of this.unchecked) this.write(key, Dirty.everything());
    this.unchecked.clear();
    this.db?.close();
    this.db = this.writer = undefined;
  }

  private scheduleWrite(delay: number): NodeJS.Timeout | undefined {
    const due = Date.now() + delay;
    if (this.saveTimer) {
      if (this.saveDue <= due) return;
      clearTimeout(this.saveTimer);
    }
    this.saveDue = due;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.writePending();
    }, delay);
    return this.saveTimer;
  }

  private writePending(): void {
    for (const key of [...this.pending.keys()]) this.writeWaiting(key);
  }

  // Writes what is waiting for a board. The tidying a save does may itself
  // change the board, or read, which writes what is waiting: so what is
  // waiting is taken after it.
  private writeWaiting(key: string, tidy = true): void {
    if (!this.pending.has(key)) return;
    const board = this.findBoard(key);
    if (board && tidy) this.beforeWrite(board);
    const dirty = this.pending.get(key);
    if (!dirty) return;
    this.pending.delete(key);
    try {
      this.write(key, dirty, this.checked.get(dirty));
    } catch (error) {
      if (error instanceof MissedChange) throw error;
      // Whatever failed, it is tried again, whole, a little later, with the
      // events and versions it was to write.
      console.error(`Failed to save board ${key}:`, error);
      dirty.merge(Dirty.everything());
      const waiting = this.pending.get(key);
      if (waiting) dirty.merge(waiting);
      this.pending.set(key, dirty);
      this.scheduleWrite(RETRY_DELAY_MS)?.unref();
    }
  }

  // `told` is how many of the events and version changes in `dirty` viewers
  // have been told of already (a check of what is waiting, then the save), or
  // false not to tell them anything.
  private write(key: string, dirty: Dirty, told: { events: number; versions: number } | false = { events: 0, versions: 0 }): void {
    const board = this.findBoard(key);
    if (!board) return;
    const { db, writer } = this.connection();
    const image = this.images.get(key) ?? new BoardImage();
    const ops = image.plan(board, dirty);
    if (ops.length || dirty.events.length || dirty.versions.length) inTransaction(db, () => writer.write(key, ops, dirty.events, dirty.versions));
    const headBefore = image.header;
    image.apply(ops);
    this.images.set(key, image);
    if (told) this.tell(key, board, ops, headBefore, { events: dirty.events.slice(told.events), versions: dirty.versions.slice(told.versions) });
    if (dirty.all) this.unchecked.delete(key);
    else this.keepAnEyeOn(key, board, image);
    if (this.checking) this.checkTables(key, board);
  }

  // Tells viewers what the save changed.
  private tell(key: string, board: Board, ops: Op[], headBefore: string, saved: Pick<Dirty, 'events' | 'versions'>): void {
    const change = changeFrom(board, ops, { headBefore, ...saved });
    if (change) this.afterWrite(key, change);
  }

  private keepAnEyeOn(key: string, board: Board, image: BoardImage): void {
    if (this.checking) {
      const missed = image.plan(board, Dirty.everything());
      if (missed.length) {
        const what = missed.map((op) => (op.type === 'header' ? 'the board header' : `${op.type} ${op.row.kind} ${op.row.id}`));
        throw new MissedChange(`A change to board ${key} was saved without naming everything it touched: ${what.slice(0, 5).join(', ')}.`);
      }
    }
    this.unchecked.add(key);
    if (this.reconcileTimer) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      for (const unchecked of [...this.unchecked]) this.changed(unchecked, Dirty.everything());
    }, RECONCILE_DELAY_MS);
    this.reconcileTimer.unref();
  }

  // For tests: what the tables hold is what the board says. A block's
  // versionCount is how many versions it has; the log does not go past the board's seq.
  private checkTables(key: string, board: Board): void {
    const { writer } = this.connection();
    const counts = writer.versions.counts(key);
    const canvases = [board.canvas, ...board.decisions.map((d) => d.canvas), ...board.tasks.map((t) => t.canvas)];
    for (const block of canvases.flatMap((canvas) => canvas.blocks)) {
      const held = counts.get(block.id) ?? 0;
      if (held !== (block.versionCount ?? 0)) {
        throw new MissedChange(`Block ${block.id} of board ${key} says it has ${block.versionCount ?? 0} versions and the table holds ${held}.`);
      }
    }
    const [last] = writer.events.query(key, { limit: 1 });
    if (last && last.seq > board.seq) throw new MissedChange(`Board ${key} is at event ${board.seq} and its log goes on to ${last.seq}.`);
  }
}
