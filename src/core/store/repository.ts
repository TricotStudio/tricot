import { BoardDb } from './boardDb';
import { Dirty } from './boardRows';
import { dataParts, type DataPart } from './dataParts';
import { EntityLists } from './entityLists';
import { BoardError } from './errors';
import { EventLog } from './eventLog';
import { EventRegistry, type EventAbout, type EventQuery, type NamedSubject } from './eventTables';
import type { PartOff } from './migrations';
import type { PictureRow } from './pictureRows';
import type { VersionChange } from './versionTables';
import type { AgentSkill, SkillList, TricotSkill } from '../skills';
import type { CanvasRef, Located } from './inputs';
import { CanvasOwners, ownedCard, type BoardTable, type CanvasCard, type CanvasOwner, type StoreTable } from './storePart';
import { randomId, slugify } from './validate';
import { MAX_VERSIONS } from '../canvas';
import { deletedCard, deletedCardLine } from '../deletedCards';
import { canvasesOf } from '../pins';
import { boardKey, type Actor, type Block, type BlockVersion, type Board, type BoardActivity, type BoardEvent, type Canvas, type EventType, type Pin, type ScratchPage, type Thread } from '../types';

const capitalised = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

// The ref of the canvas a Located is: its owner's card (`<owner>Id`), its page or the board's.
export function refOf(located: Located): CanvasRef {
  if (located.page) return { pageId: located.page.id };
  const owned = ownedCard(located);
  return owned ? { [`${owned.owner}Id`]: owned.card.id } : { boardId: located.board.id };
}

// What `record` takes besides what the event is about.
export interface RecordOptions {
  at?: string; // when it happened, if not now
  mentions?: string[]; // who a comment or request @-mentions
  commentId?: string; // the comment or thread message the event is about
  // The one agent it's for, whose updates alone it reaches (and those of an agent it @-mentions). None: the agent the
  // subject it's about gives by default (a task's assignee), if any. null: every agent.
  forAgent?: string | null;
  held?: boolean; // an agent's message to other agents that the loop guard holds (core/agentTalk.ts)
}

// The boards in memory, and everything the domain modules share about them:
// finding a board, decision, task, thread or canvas item by id, making new
// ids, the event log and blocks' versions (which are in tables of their own,
// not on the board), and saving. Domain modules change boards through the
// objects it hands them, then say so with record() or touch(); they know
// nothing of files or listeners. Where boards are stored is BoardDb's
// business, and who hears about a change is EventLog's.
export class BoardRepository {
  private boards = new Map<string, Board>();
  private aliasIndex = new Map<string, string>(); // earlier board id -> current id
  private entityIndex = new Map<string, Map<string, string>>(); // list name ('decisions', 'tasks') -> card id -> board id
  private itemIndex = new Map<string, CanvasRef>(); // canvas block/group/link id -> its canvas
  private reserved = new Map<string, Set<string>>(); // board key -> ids of rows this store does not read, which no new id may be
  private pageIndex = new Map<string, string>(); // Sketchbook page id -> board id
  private threadIndex = new Map<string, string>(); // thread id -> board key, which follows a rename
  private readonly db: BoardDb;
  readonly log: EventLog;
  // The agents on a board now, by its key, from presence: the server sets it,
  // so a mention or an assignee can name an agent that has only read the board.
  presentAgents: (boardKey: string) => string[] = () => [];
  // The clock what runs out of time keeps time by, so tests can move it.
  now: () => number = Date.now;
  // Whether blocks may name what is on this computer (a website's folder or
  // dev server): only while the server listens on this computer alone; the
  // server sets it (server/app.ts).
  localFiles = true;
  // The agent tool that finishes a sync of the board context, which a part gives (StorePart.syncTool) for the refusals that
  // send an agent to it: none, and those say it in plain words.
  syncTool: string | undefined;

  // `lists` are the lists of cards the store reads and writes besides Sketchbook pages (entityLists.ts): none unless a
  // registry is given. Every other row of a board is left as the database holds it.
  // `owners` are the owners of those cards' canvases, which `locate` finds a canvas by (storePart.ts): none unless
  // others are given. `data` are the data parts of the parts the store is built from (dataParts.ts): the process-wide
  // list when none are given. `tables` are the tables the parts keep by board (storePart.ts): none when none are given.
  // `events` are the subjects events are about, which `record` names and a query asks by, and the rules for a board's
  // activity: the core's `item` alone unless others are given. A part found off, saved by a newer Tricot, is announced to `onPartsOff`,
  // once and before anything is read, for the Store to register the lists, owners, tables and subjects that are left (`use`).
  constructor(
    dataDir: string,
    private lists: EntityLists = new EntityLists(),
    private owners: CanvasOwners = new CanvasOwners(),
    data: readonly DataPart[] = dataParts(),
    tables: readonly StoreTable[] = [],
    private eventRegistry: EventRegistry = new EventRegistry(),
  ) {
    this.db = new BoardDb(dataDir, (key) => this.findBoard(key), lists, data, tables, eventRegistry);
    this.db.onPartsOff = (off) => this.onPartsOff(off);
    this.db.afterWrite = (key, change) => this.log.publishChange(key, change);
    this.db.watched = (key) => this.log.hasViewers(key);
    this.log = new EventLog((boardId) => this.getBoard(boardId), (boardId) => this.findBoard(boardId), (board, query) => this.db.events(boardKey(board), query));
  }

  // Runs when parts are found off, before the boards are read: the Store takes their lists, owners, tables and kinds of card away.
  onPartsOff: (off: PartOff[]) => void = () => {};

  // The lists, owners, tables and event subjects this repository reads, writes and finds canvases by from now on.
  use(lists: EntityLists, owners: CanvasOwners, tables: readonly StoreTable[], events: EventRegistry): void {
    this.lists = lists;
    this.owners = owners;
    this.eventRegistry = events;
    this.db.useParts(lists, tables, events);
  }

  // Runs on a board just before each save.
  beforeSave(hook: (board: Board) => void): void {
    this.db.beforeWrite = hook;
  }

  // Reads every board in the database. A board comes back whole: the fields
  // an earlier Tricot saved boards without were added by a migration
  // (shapeDefaults.ts), so nothing here fills in what a board lacks.
  load(): void {
    for (const board of this.db.readAll()) {
      try {
        this.boards.set(board.id, board);
        for (const alias of board.aliases ?? []) this.aliasIndex.set(alias, board.id);
        this.indexCards(board, board.id, true);
        this.indexCanvas(board.canvas, { boardId: board.id });
        for (const page of board.pages ?? []) {
          this.pageIndex.set(page.id, board.id);
          this.indexCanvas(page.canvas, { pageId: page.id });
        }
        for (const thread of board.threads ?? []) this.threadIndex.set(thread.id, boardKey(board));
        const foreign = this.db.foreignRows(boardKey(board));
        if (foreign.length) this.reserved.set(boardKey(board), new Set(foreign.map((row) => row.id)));
      } catch (error) {
        console.error(`Skipping unreadable board ${board.id}:`, error);
        continue;
      }
      // The board as the store keeps it, once its stale entries are pruned, is what the database should hold.
      this.db.adopt(board);
    }
  }

  // For tests that check saves (see checkSaves.ts).
  checkSaves(): void {
    this.db.checkWaiting();
  }

  saveEverything(): void {
    this.db.writeEverything();
  }

  // Writes what is waiting, and lets go of the database file.
  flush(): Promise<void> {
    return this.db.flush();
  }

  // ---- finding things ------------------------------------------------------

  allBoards(): Board[] {
    return [...this.boards.values()];
  }

  addBoard(board: Board): void {
    this.boards.set(board.id, board);
  }

  findBoard(boardId: string): Board | undefined {
    return this.boards.get(this.aliasIndex.get(boardId) ?? boardId);
  }

  // Takes a board's current id or any earlier one, so old links and agents
  // still holding an id from before a rename reach the board.
  getBoard(boardId: string): Board {
    const board = this.findBoard(boardId);
    if (!board) throw new BoardError(`No board with id "${boardId}".`, 'not_found');
    return board;
  }

  // The card of a registered kind with this id, and the board it is on, by the index of its list: none when no part registered
  // the kind, as when the card is not on a board.
  findCard(kind: string, id: string): { board: Board; card: CanvasCard } | undefined {
    const owner = this.owners.find(kind);
    const boardId = owner ? this.ids(owner.list).get(id) : undefined;
    const board = boardId ? this.boards.get(boardId) : undefined;
    const card = (board as unknown as Record<string, CanvasCard[] | undefined> | undefined)?.[owner!.list]?.find((c) => c.id === id);
    return board && card ? { board, card } : undefined;
  }

  // The kinds of card this repository keeps, by the name of their owner (`decision`, `task`), in the order they were registered.
  cardKinds(): string[] {
    return this.owners.registered.map((owner) => owner.owner);
  }

  // The owner of the cards whose canvases alone take a kind of block, if a part registered one.
  ownerTaking(blockType: string): CanvasOwner | undefined {
    return this.owners.taking(blockType);
  }

  // What refuses a block pinned to an option on a canvas with none, in a part's words if it has cards with options.
  noOptionsWords(): string {
    return this.owners.noOptions() ?? 'Only blocks on the canvas of a card with options can be pinned to an option.';
  }

  // The registered card with this id, whichever its kind: its kind's owner, its board and the card.
  findCardById(id: string): { owner: CanvasOwner; board: Board; card: CanvasCard } | undefined {
    for (const owner of this.owners.registered) {
      const found = this.findCard(owner.owner, id);
      if (found) return { owner, ...found };
    }
    return undefined;
  }

  // The same, refused when there is none: what became of the card if a person deleted it, else that no card of the kind has
  // the id.
  getCard(kind: string, id: string): { board: Board; card: CanvasCard } {
    const found = this.findCard(kind, id);
    if (!found) throw new BoardError(this.deletedCard(id) ?? `No ${kind} with id "${id}".`, 'not_found');
    return found;
  }

  getPage(pageId: string): { board: Board; page: ScratchPage } {
    const boardId = this.pageIndex.get(pageId);
    const board = boardId ? this.boards.get(boardId) : undefined;
    const page = board?.pages?.find((p) => p.id === pageId);
    if (!board || !page) throw new BoardError(`No Sketchbook page with id "${pageId}".`, 'not_found');
    return { board, page };
  }

  // What became of a card a person deleted, for whoever still holds its id.
  deletedCard(id: string): string | undefined {
    for (const board of this.boards.values()) {
      const card = deletedCard(board, id);
      const mark = card && this.owners.find(card.kind)?.mark;
      if (card && mark !== undefined) return deletedCardLine(card, `${mark}${card.number}`);
    }
    return undefined;
  }

  getThread(threadId: string): { board: Board; thread: Thread } {
    const key = this.threadIndex.get(threadId);
    const board = key ? this.findBoard(key) : undefined;
    const thread = board?.threads?.find((t) => t.id === threadId);
    if (!board || !thread) throw new BoardError(`No thread with id "${threadId}".`, 'not_found');
    return { board, thread };
  }

  // The canvas a ref names: a registered owner's card, a Sketchbook page or the board's.
  locate(ref: CanvasRef): Located {
    const named = this.owners.named(ref);
    if (named) {
      const { owner, id } = named;
      const { board, card } = this.getCard(owner.owner, id);
      if (owner.checksBoard && ref.boardId && this.findBoard(ref.boardId) !== board) {
        throw new BoardError(`${capitalised(owner.owner)} "${card.id}" is not on board "${ref.boardId}".`);
      }
      return { board, [owner.owner]: card, canvas: card.canvas } as unknown as Located;
    }
    if (ref.pageId) {
      const { board, page } = this.getPage(ref.pageId);
      if (ref.boardId && this.findBoard(ref.boardId) !== board) {
        throw new BoardError(`Sketchbook page "${page.id}" is not on board "${ref.boardId}".`);
      }
      return { board, page, canvas: page.canvas };
    }
    this.refuseUnregistered(ref);
    if (!ref.boardId) throw new BoardError('Pass a board id, a decision id, a task id or a Sketchbook page id.');
    const board = this.getBoard(ref.boardId);
    return { board, canvas: board.canvas };
  }

  // A ref that names a card of an owner no list here registers, as a store without a part's lists has none of
  // decisions or tasks: the card is not found, as any card not on a board is.
  private refuseUnregistered(ref: CanvasRef): void {
    for (const [key, id] of Object.entries(ref)) {
      if (key === 'boardId' || key === 'pageId' || !id || !key.endsWith('Id')) continue;
      throw new BoardError(this.deletedCard(id) ?? `No ${key.slice(0, -2)} with id "${id}".`, 'not_found');
    }
  }

  locateItem(itemId: string): Located {
    const ref = this.itemIndex.get(itemId);
    if (!ref) throw new BoardError(`No canvas block, group, link or pin with id "${itemId}".`, 'not_found');
    return this.locate(ref);
  }

  blockOf(blockId: string): Block {
    const block = this.locateItem(blockId).canvas.blocks.find((b) => b.id === blockId);
    if (!block) throw new BoardError(`"${blockId}" is not a block.`);
    return block;
  }

  // ---- the indexes ---------------------------------------------------------

  hasItem(id: string): boolean {
    return this.itemIndex.has(id);
  }

  hasTask(id: string): boolean {
    return this.ids('tasks').has(id);
  }

  hasDecision(id: string): boolean {
    return this.ids('decisions').has(id);
  }

  hasThread(id: string): boolean {
    return this.threadIndex.has(id);
  }

  hasPage(id: string): boolean {
    return this.pageIndex.has(id);
  }

  indexItem(id: string, ref: CanvasRef): void {
    this.itemIndex.set(id, ref);
  }

  unindexItem(id: string): void {
    this.itemIndex.delete(id);
  }

  // Finds a card of a registered list by its id, on the board it is on: what `load` does for every card, for one made while
  // the Store runs. A card of a list that is not registered is not found by it, so indexing one is for the part that
  // registered the list.
  indexCard(list: string, id: string, boardId: string): void {
    this.ids(list).set(id, boardId);
  }

  unindexCard(list: string, id: string): void {
    this.ids(list).delete(id);
  }

  indexTask(id: string, boardId: string): void {
    this.indexCard('tasks', id, boardId);
  }

  unindexTask(id: string): void {
    this.unindexCard('tasks', id);
  }

  indexDecision(id: string, boardId: string): void {
    this.indexCard('decisions', id, boardId);
  }

  unindexDecision(id: string): void {
    this.unindexCard('decisions', id);
  }

  // The ids of a registered list's cards, by the board each is on.
  private ids(list: string): Map<string, string> {
    let held = this.entityIndex.get(list);
    if (!held) this.entityIndex.set(list, (held = new Map()));
    return held;
  }

  // The cards of the registered lists on a board. A list that is not registered has none here, whatever the
  // database holds of it.
  private *cardsOf(board: Board): Generator<{ list: string; owner: string; card: { id: string; canvas: Canvas } }> {
    const held = board as unknown as Record<string, { id: string; canvas: Canvas }[] | undefined>;
    for (const { list, owner } of this.lists.registered) for (const card of held[list] ?? []) yield { list, owner, card };
  }

  // Indexes each registered card of a board by the board's id, and with `canvases`, what is on its canvas.
  private indexCards(board: Board, boardId: string, canvases = false): void {
    for (const { list, owner, card } of this.cardsOf(board)) {
      this.ids(list).set(card.id, boardId);
      if (canvases) this.indexCanvas(card.canvas, { [`${owner}Id`]: card.id });
    }
  }

  private unindexCards(board: Board): void {
    for (const { list, card } of this.cardsOf(board)) this.ids(list).delete(card.id);
  }

  // Whether an id is a row this store does not read, so that no new id may be it.
  private reservedId(id: string): boolean {
    for (const ids of this.reserved.values()) if (ids.has(id)) return true;
    return false;
  }

  // Whether an id is a card of a registered list or a row this store does not read.
  private taken(id: string): boolean {
    for (const held of this.entityIndex.values()) if (held.has(id)) return true;
    return this.reservedId(id);
  }

  indexPage(id: string, boardId: string): void {
    this.pageIndex.set(id, boardId);
  }

  unindexPage(id: string): void {
    this.pageIndex.delete(id);
  }

  indexThread(id: string, board: Board): void {
    this.threadIndex.set(id, boardKey(board));
  }

  unindexThread(id: string): void {
    this.threadIndex.delete(id);
  }

  indexCanvas(canvas: Canvas, ref: CanvasRef): void {
    for (const item of [...canvas.blocks, ...canvas.groups, ...canvas.links, ...canvas.pins]) this.itemIndex.set(item.id, ref);
  }

  // Gives a board a new id, keeping the old one as an alias.
  moveBoard(board: Board, id: string): void {
    const previous = board.id;
    board.aliases = [...(board.aliases ?? []), previous];
    board.id = id;
    this.boards.delete(previous);
    this.boards.set(id, board);
    for (const alias of board.aliases) this.aliasIndex.set(alias, id);
    for (const { list } of this.owners.registered.filter((owner) => owner.holdsBoardId)) {
      for (const card of (board as unknown as Record<string, { boardId: string }[] | undefined>)[list] ?? []) card.boardId = id;
    }
    this.indexCards(board, id);
    for (const page of board.pages ?? []) this.pageIndex.set(page.id, id);
    this.indexCanvas(board.canvas, { boardId: id });
    this.db.changed(boardKey(board), Dirty.everything());
  }

  // Takes a board away for good: its rows in the database, then everything in
  // memory that finds it (by any of its ids), and viewers are told it is gone.
  removeBoard(board: Board): void {
    const key = boardKey(board);
    this.db.deleteBoard(key);
    for (const { canvas } of canvasesOf(board)) {
      for (const item of [...canvas.blocks, ...canvas.groups, ...canvas.links, ...canvas.pins]) this.itemIndex.delete(item.id);
    }
    this.unindexCards(board);
    this.reserved.delete(key);
    for (const page of board.pages ?? []) this.pageIndex.delete(page.id);
    for (const thread of board.threads ?? []) this.threadIndex.delete(thread.id);
    for (const alias of board.aliases ?? []) this.aliasIndex.delete(alias);
    this.boards.delete(board.id);
    this.log.removeBoard(key);
  }

  // ---- ids -----------------------------------------------------------------

  // A slug of the title, so links say what the board is about, and a random suffix.
  newBoardId(title: string): string {
    const slug = slugify(title);
    let id: string;
    do id = slug ? `${slug}-${randomId(4)}` : randomId(8);
    while (this.boards.has(id) || this.aliasIndex.has(id));
    return id;
  }

  newDecisionId(): string {
    let id: string;
    do id = randomId(6);
    while (this.ids('decisions').has(id) || this.reservedId(id));
    return id;
  }

  newPageId(): string {
    let id: string;
    do id = randomId(6);
    while (this.pageIndex.has(id) || this.itemIndex.has(id) || this.taken(id));
    return id;
  }

  newThreadId(): string {
    let id: string;
    do id = randomId(8);
    while (this.threadIndex.has(id) || this.itemIndex.has(id) || this.reservedId(id));
    return id;
  }

  newRequestId(): string {
    const taken = new Set(this.allBoards().flatMap((b) => b.requests?.map((r) => r.id) ?? []));
    let id: string;
    do id = randomId(6);
    while (taken.has(id) || this.itemIndex.has(id) || this.reservedId(id));
    return id;
  }

  // `canvas` is the one the item goes on, which may not be indexed yet.
  newItemId(canvas?: Canvas): string {
    const onCanvas = (id: string) =>
      Boolean(canvas && [...canvas.blocks, ...canvas.groups, ...canvas.pins].some((item) => item.id === id));
    let id: string;
    do id = randomId(6);
    while (this.itemIndex.has(id) || this.taken(id) || this.pageIndex.has(id) || onCanvas(id));
    return id;
  }

  // ---- the event log -------------------------------------------------------

  // The activity of a board nothing has happened on, with the keys the Store's parts keep in it (eventTables.ts).
  emptyActivity(): BoardActivity {
    return this.eventRegistry.emptyActivity();
  }

  // `about` is what the event is about, by subject name: the core's `item` and the subjects the store's parts registered
  // (`decision` and `task` for a part's); a store that registered none refuses one that names it. A subject says which
  // row the change saves and which agent the event is for by default (eventTables.ts EventSubject).
  record(board: Board, actor: Actor, type: EventType, summary: string, about: EventAbout = {}, options: RecordOptions = {}): void {
    const named = this.eventRegistry.named(about);
    const { at = new Date().toISOString(), mentions, commentId, forAgent, held } = options;
    const only = forAgent === null ? undefined : (forAgent ?? this.eventRegistry.agentFor(board, named));
    const event: BoardEvent = {
      seq: ++board.seq,
      at,
      actor,
      type,
      ...this.subjectIds(named),
      summary,
      ...(mentions?.length ? { mentions } : {}),
      ...(commentId ? { commentId } : {}),
      ...(only ? { forAgent: only } : {}),
      ...(held ? { held: true as const } : {}),
    };
    this.eventRegistry.noteEvent(board.activity, event);
    board.updatedAt = event.at;
    const key = boardKey(board);
    const dirty = this.dirtyBy(board, named);
    dirty.events.push(event);
    this.db.changed(key, dirty);
    this.log.publish(key, event);
  }

  // What an event names, as the keys it is stored with: each subject's name and `Id` (`decisionId`, `itemId`, `taskId`), in
  // the order of the names, which is the order the event has always been written in.
  private subjectIds(named: readonly NamedSubject[]): Record<string, string> {
    return Object.fromEntries([...named].sort((a, b) => a.subject.name.localeCompare(b.subject.name)).map(({ subject, id }) => [`${subject.name}Id`, id]));
  }

  // ---- reading the event log -----------------------------------------------

  events(board: Board, query: EventQuery): BoardEvent[] {
    return this.db.events(boardKey(board), query);
  }

  countEvents(board: Board, query: EventQuery): number {
    return this.db.countEvents(boardKey(board), query);
  }

  // ---- the tables the parts keep by board ----------------------------------

  // A table a part registered, which the module that owns it reads and writes through: none when this store's parts
  // did not register it. The repository names none of them.
  table<T extends BoardTable>(kind: StoreTable<T>): T | undefined {
    return this.db.table(kind);
  }

  // ---- what agents reported of their skills ---------------------------------

  agentSkills(): SkillList[] {
    return this.db.agentSkills();
  }

  reportSkills(agent: string, skills: AgentSkill[]): void {
    this.db.reportSkills(agent, skills, new Date().toISOString());
  }

  // ---- the skills people add in Tricot ----------------------------------------

  tricotSkills(): TricotSkill[] {
    return this.db.tricotSkills();
  }

  putTricotSkill(skill: TricotSkill): void {
    this.db.putTricotSkill(skill);
  }

  deleteTricotSkill(id: string): void {
    this.db.deleteTricotSkill(id);
  }

  // ---- blocks' versions ----------------------------------------------------

  // A block's earlier versions, oldest first.
  versionsOf(board: Board, blockId: string): BlockVersion[] {
    return this.db.versions(boardKey(board), blockId);
  }

  versionOf(board: Board, blockId: string, rev: number): BlockVersion | undefined {
    return this.db.version(boardKey(board), blockId, rev);
  }

  // The pictures a board's earlier versions show.
  versionAssets(board: Board): string[] {
    return this.db.versionAssets(boardKey(board));
  }

  // Whether any block's earlier version, on any board, shows this picture.
  versionShows(assetId: string): boolean {
    return this.db.versionShows(assetId);
  }

  // The stored rows of a board that can name a picture: the rows this store does not read, a decision's canvas, included.
  pictureRows(board: Board): PictureRow[] {
    return this.db.pictureRows(boardKey(board));
  }

  // The stored rows of every board that can name a picture.
  allPictureRows(): PictureRow[] {
    return this.db.allPictureRows();
  }

  // Keeps versions among a block's, which holds the last MAX_VERSIONS: they
  // are new revs or ones it doesn't have. The block says how many it has now.
  addVersions(board: Board, block: Block, versions: BlockVersion[]): void {
    const count = Math.min(MAX_VERSIONS, (block.versionCount ?? 0) + versions.length);
    this.changeVersions(board, block, { op: 'add', block: block.id, versions }, count);
  }

  removeVersions(board: Board, block: Block, revs: number[]): void {
    this.changeVersions(board, block, { op: 'remove', block: block.id, revs }, Math.max(0, (block.versionCount ?? 0) - revs.length));
  }

  // Lets go of the versions of a block that is gone for good.
  dropVersions(board: Board, blockId: string): void {
    const dirty = new Dirty();
    dirty.versions.push({ op: 'drop', block: blockId });
    this.db.changed(boardKey(board), dirty);
  }

  // How many versions a block has, from the table: for one coming back to a canvas.
  countVersions(board: Board, blockId: string): number {
    return this.db.versionRevs(boardKey(board), blockId).length;
  }

  private changeVersions(board: Board, block: Block, change: VersionChange, count: number): void {
    const dirty = new Dirty();
    dirty.versions.push(change);
    this.db.changed(boardKey(board), dirty);
    if (count > 0) block.versionCount = count;
    else delete block.versionCount;
  }

  // What a change touched, for saving only that (see Dirty): the row of each
  // subject it names that keeps its rows in a list (a decision, a task), and
  // what holds the item it names. A change that names nothing, or an item no
  // longer there, could have touched anything.
  private dirtyBy(board: Board, named: readonly NamedSubject[]): Dirty {
    const dirty = new Dirty();
    let itemId: string | undefined;
    for (const { subject, id } of named) {
      if (!id) continue;
      if (subject.name === 'item') itemId = id;
      else if (subject.list) dirty.of(subject.list).add(id);
    }
    if (itemId) {
      const ref = this.itemIndex.get(itemId);
      const on = ref && this.cardOn(ref);
      const card = this.listOfCard(itemId);
      if (on) dirty.of(on.list).add(on.id);
      else if (ref?.pageId) dirty.pages.add(ref.pageId);
      else if (card) dirty.of(card).add(itemId);
      else if (this.pageIndex.has(itemId)) dirty.pages.add(itemId);
      else if (!ref && !this.threadIndex.has(itemId) && !board.requests?.some((r) => r.id === itemId)) dirty.all = true;
    }
    if (!named.some(({ id }) => id)) dirty.all = true;
    return dirty;
  }

  // The registered card whose canvas a ref names.
  private cardOn(ref: CanvasRef): { list: string; id: string } | undefined {
    const named = this.owners.named(ref);
    return named && { list: named.owner.list, id: named.id };
  }

  // The registered list that has a card with this id, if there is one.
  private listOfCard(id: string): string | undefined {
    return this.lists.registered.find(({ list }) => this.ids(list).has(id))?.list;
  }

  // What changed on the canvas, decision or task a ref names, or anything if none.
  private dirtyOn(ref?: CanvasRef): Dirty {
    const dirty = new Dirty();
    if (!ref) dirty.all = true;
    else {
      const card = this.cardOn(ref);
      if (card) dirty.of(card.list).add(card.id);
      else if (ref.pageId) dirty.pages.add(ref.pageId);
    }
    return dirty;
  }

  // A canvas change, logged against the decision or task that owns the canvas.
  // A pin's is logged against the work it links to where the owner leaves
  // room, so it shows in that task's or decision's history too.
  recordCanvas(located: Located, actor: Actor, summary: string, itemId: string, pin?: Pin): void {
    const now = new Date().toISOString();
    const owned = ownedCard(located);
    if (owned) owned.card.updatedAt = now;
    if (located.page) located.page.updatedAt = now;
    // The card whose canvas it is, and else the card a pin links to, for each kind of card (an owner). A pin's links are
    // stored data: a Store that registered no such subject leaves them out, and the event is about the item.
    const linked = pin ? this.owners.links(pin) : [];
    const cards = this.owners.registered.map(({ owner }) => [owner, (owned?.owner === owner ? owned.card.id : undefined) ?? linked.find((link) => link.owner.owner === owner)?.id] as const);
    const about = this.eventRegistry.known({ ...Object.fromEntries(cards.filter(([, id]) => id)), item: itemId });
    // A change on a canvas whose card has an agent it is for (an assigned task's) is for that agent; one elsewhere, which
    // may link a part to such a card, for all.
    const own = owned && this.eventRegistry.find(owned.owner)?.agent;
    this.record(located.board, actor, 'canvas_changed', summary, about, { forAgent: own ? undefined : null });
  }

  // A change that reached cards or pages its record() or touch() doesn't name: these are saved too. The cards are named by
  // their kind, `<kind>Ids` (`decisionIds`); a kind no part registered has no list to save.
  alsoSave(board: Board, { pageIds = [], ...cards }: { pageIds?: string[]; [kindIds: `${string}Ids`]: string[] | undefined }): void {
    const dirty = new Dirty();
    for (const { owner, list } of this.owners.registered) for (const id of cards[`${owner}Ids`] ?? []) dirty.of(list).add(id);
    for (const id of pageIds) dirty.pages.add(id);
    this.db.changed(boardKey(board), dirty);
  }

  // A change to show viewers but not worth logging. `ref` is the canvas,
  // decision or task it touched, if only one.
  touch(board: Board, ref?: CanvasRef): void {
    const key = boardKey(board);
    this.db.changed(key, this.dirtyOn(ref));
  }

  // A change with no event of its own to save: an agent's quiet activity.
  scheduleSave(board: Board, ref?: CanvasRef): void {
    this.db.changed(boardKey(board), this.dirtyOn(ref));
  }
}
