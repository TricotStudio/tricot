import { BoardDb } from './boardDb';
import { Dirty } from './boardRows';
import { BoardError } from './errors';
import { EventLog } from './eventLog';
import type { EventQuery } from './eventTables';
import type { VersionChange } from './versionTables';
import type { Dismissed } from '../needs';
import type { AgentSkill, SkillList, TricotSkill } from '../skills';
import type { CanvasRef, Located } from './inputs';
import { randomId, slugify } from './validate';
import { deletedCardLine } from '../cardLinks';
import { emptyActivity, noteEvent } from '../activity';
import { MAX_VERSIONS, emptyCanvas } from '../canvas';
import { boardKey, type Actor, type Block, type BlockVersion, type Board, type BoardEvent, type Canvas, type Decision, type EventType, type Pin, type Task, type Thread } from '../types';

export function refOf(located: Located): CanvasRef {
  if (located.task) return { taskId: located.task.id };
  return located.decision ? { decisionId: located.decision.id } : { boardId: located.board.id };
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
  private decisionIndex = new Map<string, string>(); // decision id -> board id
  private itemIndex = new Map<string, CanvasRef>(); // canvas block/group/link id -> its canvas
  private taskIndex = new Map<string, string>(); // task id -> board id
  private threadIndex = new Map<string, string>(); // thread id -> board key, which follows a rename
  private readonly db: BoardDb;
  readonly log: EventLog;
  // The agents on a board now, by its key, from presence: the server sets it,
  // so a mention or an assignee can name an agent that has only read the board.
  presentAgents: (boardKey: string) => string[] = () => [];
  // The clock first looks keep time by (core/firstLook.ts), so tests can move it.
  now: () => number = Date.now;

  constructor(dataDir: string) {
    this.db = new BoardDb(dataDir, (key) => this.findBoard(key));
    this.db.afterWrite = (key, change) => this.log.publishChange(key, change);
    this.db.watched = (key) => this.log.hasViewers(key);
    this.log = new EventLog((boardId) => this.getBoard(boardId), (boardId) => this.findBoard(boardId), (board, query) => this.db.events(boardKey(board), query));
  }

  // Runs on a board just before each save.
  beforeSave(hook: (board: Board) => void): void {
    this.db.beforeWrite = hook;
  }

  load(): void {
    for (const board of this.db.readAll()) {
      try {
        board.activity ??= emptyActivity();
        board.canvas ??= emptyCanvas(); // boards saved before canvases existed
        board.tasks ??= [];
        board.nextTaskNumber ??= 1;
        this.boards.set(board.id, board);
        for (const alias of board.aliases ?? []) this.aliasIndex.set(alias, board.id);
        board.canvas.pins ??= []; // canvases saved before pins existed
        for (const task of board.tasks) {
          task.comments ??= [];
          task.canvas ??= emptyCanvas();
          task.canvas.pins ??= [];
          this.taskIndex.set(task.id, board.id);
          this.indexCanvas(task.canvas, { taskId: task.id });
          for (const block of task.canvas.blocks) block.rev ??= 1;
        }
        this.indexCanvas(board.canvas, { boardId: board.id });
        for (const block of board.canvas.blocks) block.rev ??= 1;
        for (const thread of board.threads ?? []) this.threadIndex.set(thread.id, boardKey(board));
        // Syncs asked for before people could select blocks had "Include mine";
        // an open one now reads as a sync of all, which leaves people's blocks alone.
        for (const record of [board.syncRequest, board.synced]) {
          if (record) delete (record as { includeMine?: boolean }).includeMine;
        }
        for (const decision of board.decisions) {
          decision.canvas ??= emptyCanvas();
          decision.canvas.pins ??= [];
          decision.history ??= [];
          decision.asks ??= [];
          decision.criteria ??= [];
          decision.marks ??= [];
          this.decisionIndex.set(decision.id, board.id);
          this.indexCanvas(decision.canvas, { decisionId: decision.id });
          for (const block of decision.canvas.blocks) block.rev ??= 1;
        }
      } catch (error) {
        console.error(`Skipping unreadable board ${board.id}:`, error);
        continue;
      }
      // What the board is, once tidied, is what the database should hold.
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

  getTask(taskId: string): { board: Board; task: Task } {
    const boardId = this.taskIndex.get(taskId);
    const board = boardId ? this.boards.get(boardId) : undefined;
    const task = board?.tasks.find((t) => t.id === taskId);
    if (!board || !task) throw new BoardError(this.deletedCard(taskId) ?? `No task with id "${taskId}".`, 'not_found');
    return { board, task };
  }

  getDecision(decisionId: string): { board: Board; decision: Decision } {
    const boardId = this.decisionIndex.get(decisionId);
    const board = boardId ? this.boards.get(boardId) : undefined;
    const decision = board?.decisions.find((d) => d.id === decisionId);
    if (!board || !decision) throw new BoardError(this.deletedCard(decisionId) ?? `No decision with id "${decisionId}".`, 'not_found');
    return { board, decision };
  }

  // What became of a card a person deleted, for whoever still holds its id.
  deletedCard(id: string): string | undefined {
    for (const board of this.boards.values()) {
      const card = board.deletedCards?.find((c) => c.id === id);
      if (card) return deletedCardLine(card);
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

  locate(ref: CanvasRef): Located {
    if (ref.taskId) {
      const { board, task } = this.getTask(ref.taskId);
      return { board, task, canvas: task.canvas };
    }
    if (ref.decisionId) {
      const { board, decision } = this.getDecision(ref.decisionId);
      if (ref.boardId && this.findBoard(ref.boardId) !== board) {
        throw new BoardError(`Decision "${decision.id}" is not on board "${ref.boardId}".`);
      }
      return { board, decision, canvas: decision.canvas };
    }
    if (!ref.boardId) throw new BoardError('Pass a board id, a decision id or a task id.');
    const board = this.getBoard(ref.boardId);
    return { board, canvas: board.canvas };
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
    return this.taskIndex.has(id);
  }

  hasDecision(id: string): boolean {
    return this.decisionIndex.has(id);
  }

  hasThread(id: string): boolean {
    return this.threadIndex.has(id);
  }

  indexItem(id: string, ref: CanvasRef): void {
    this.itemIndex.set(id, ref);
  }

  unindexItem(id: string): void {
    this.itemIndex.delete(id);
  }

  indexTask(id: string, boardId: string): void {
    this.taskIndex.set(id, boardId);
  }

  unindexTask(id: string): void {
    this.taskIndex.delete(id);
  }

  indexDecision(id: string, boardId: string): void {
    this.decisionIndex.set(id, boardId);
  }

  unindexDecision(id: string): void {
    this.decisionIndex.delete(id);
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
    for (const decision of board.decisions) {
      decision.boardId = id;
      this.decisionIndex.set(decision.id, id);
    }
    for (const task of board.tasks) this.taskIndex.set(task.id, id);
    this.indexCanvas(board.canvas, { boardId: id });
    this.db.changed(boardKey(board), Dirty.everything());
  }

  // Takes a board away for good: its rows in the database, then everything in
  // memory that finds it (by any of its ids), and viewers are told it is gone.
  removeBoard(board: Board): void {
    const key = boardKey(board);
    this.db.deleteBoard(key, [board.id, ...(board.aliases ?? [])]);
    for (const canvas of [board.canvas, ...board.decisions.map((d) => d.canvas), ...board.tasks.map((t) => t.canvas)]) {
      for (const item of [...canvas.blocks, ...canvas.groups, ...canvas.links, ...canvas.pins]) this.itemIndex.delete(item.id);
    }
    for (const decision of board.decisions) this.decisionIndex.delete(decision.id);
    for (const task of board.tasks) this.taskIndex.delete(task.id);
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
    while (this.decisionIndex.has(id));
    return id;
  }

  newThreadId(): string {
    let id: string;
    do id = randomId(8);
    while (this.threadIndex.has(id) || this.itemIndex.has(id));
    return id;
  }

  newRequestId(): string {
    const taken = new Set(this.allBoards().flatMap((b) => b.requests?.map((r) => r.id) ?? []));
    let id: string;
    do id = randomId(6);
    while (taken.has(id) || this.itemIndex.has(id));
    return id;
  }

  // `canvas` is the one the item goes on, which may not be indexed yet.
  newItemId(canvas?: Canvas): string {
    const onCanvas = (id: string) =>
      Boolean(canvas && [...canvas.blocks, ...canvas.groups, ...canvas.pins].some((item) => item.id === id));
    let id: string;
    do id = randomId(6);
    while (this.itemIndex.has(id) || this.decisionIndex.has(id) || this.taskIndex.has(id) || onCanvas(id));
    return id;
  }

  // ---- the event log -------------------------------------------------------

  record(
    board: Board,
    actor: Actor,
    type: EventType,
    summary: string,
    decisionId?: string,
    itemId?: string,
    taskId?: string,
    at = new Date().toISOString(),
    mentions?: string[], // who a comment or request @-mentions
    commentId?: string, // the comment or thread message the event is about
    // The one agent it's for, whose updates alone it reaches (and those of an
    // agent it @-mentions). None: the agent the task it's about is assigned
    // to, if any (core/assignee.ts). null: every agent.
    forAgent?: string | null,
    held?: boolean, // an agent's message to other agents that the loop guard holds (core/agentTalk.ts)
  ): void {
    const only = forAgent === null ? undefined : (forAgent ?? (taskId ? board.tasks.find((t) => t.id === taskId)?.assignee : undefined));
    const event: BoardEvent = {
      seq: ++board.seq,
      at,
      actor,
      type,
      decisionId,
      itemId,
      taskId,
      summary,
      ...(mentions?.length ? { mentions } : {}),
      ...(commentId ? { commentId } : {}),
      ...(only ? { forAgent: only } : {}),
      ...(held ? { held: true as const } : {}),
    };
    noteEvent(board.activity, event);
    board.updatedAt = event.at;
    const key = boardKey(board);
    const dirty = this.dirtyBy(board, decisionId, itemId, taskId);
    dirty.events.push(event);
    this.db.changed(key, dirty);
    this.log.publish(key, event);
  }

  // ---- reading the event log -----------------------------------------------

  events(board: Board, query: EventQuery): BoardEvent[] {
    return this.db.events(boardKey(board), query);
  }

  countEvents(board: Board, query: EventQuery): number {
    return this.db.countEvents(boardKey(board), query);
  }

  // ---- what people dismissed from their Needs you ---------------------------

  dismissedNeeds(person: string): Record<string, Dismissed> {
    return this.db.dismissedNeeds(person);
  }

  dismissNeeds(board: Board, person: string, items: { key: string; at: string }[]): void {
    this.db.dismissNeeds(person, boardKey(board), items);
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

  // What a change touched, for saving only that (see Dirty): the decision and
  // task it names, and what holds the item it names. A change that names
  // nothing, or an item no longer there, could have touched anything.
  private dirtyBy(board: Board, decisionId?: string, itemId?: string, taskId?: string): Dirty {
    const dirty = new Dirty();
    if (decisionId) dirty.decisions.add(decisionId);
    if (taskId) dirty.tasks.add(taskId);
    if (itemId) {
      const ref = this.itemIndex.get(itemId);
      if (ref?.decisionId) dirty.decisions.add(ref.decisionId);
      else if (ref?.taskId) dirty.tasks.add(ref.taskId);
      else if (this.decisionIndex.has(itemId)) dirty.decisions.add(itemId);
      else if (this.taskIndex.has(itemId)) dirty.tasks.add(itemId);
      else if (!ref && !this.threadIndex.has(itemId) && !board.requests?.some((r) => r.id === itemId)) dirty.all = true;
    }
    if (!decisionId && !itemId && !taskId) dirty.all = true;
    return dirty;
  }

  // What changed on the canvas, decision or task a ref names, or anything if none.
  private dirtyOn(ref?: CanvasRef): Dirty {
    const dirty = new Dirty();
    if (!ref) dirty.all = true;
    else if (ref.decisionId) dirty.decisions.add(ref.decisionId);
    else if (ref.taskId) dirty.tasks.add(ref.taskId);
    return dirty;
  }

  // A canvas change, logged against the decision or task that owns the canvas.
  // A pin's is logged against the work it links to where the owner leaves
  // room, so it shows in that task's or decision's history too.
  recordCanvas(located: Located, actor: Actor, summary: string, itemId: string, pin?: Pin): void {
    const now = new Date().toISOString();
    if (located.decision) located.decision.updatedAt = now;
    if (located.task) located.task.updatedAt = now;
    const decisionId = located.decision?.id ?? pin?.decisionId;
    const taskId = located.task?.id ?? pin?.taskId;
    // A change on an assigned task's canvas is for its agent; one elsewhere that links a part to it, for all.
    this.record(located.board, actor, 'canvas_changed', summary, decisionId, itemId, taskId, undefined, undefined, undefined, located.task ? undefined : null);
  }

  // A change that reached decisions or tasks its record() or touch() doesn't
  // name: these are saved too.
  alsoSave(board: Board, { decisionIds = [], taskIds = [] }: { decisionIds?: string[]; taskIds?: string[] }): void {
    const dirty = new Dirty();
    for (const id of decisionIds) dirty.decisions.add(id);
    for (const id of taskIds) dirty.tasks.add(id);
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
