import { Assets } from './store/assets';
import { Blocks } from './store/blocks';
import { CHECK_SAVES } from './store/boardDb';
import { Boards } from './store/boards';
import { Canvases } from './store/canvases';
import { CardKinds, type CardCommented, type CardKind, type CommentAbout } from './store/cardKinds';
import { checkAfterEachCall } from './store/checkSaves';
import { BoardError } from './store/errors';
import { dataParts } from './store/dataParts';
import { Deletions } from './store/deletions';
import type { EntityList } from './store/entityLists';
import type { EventQuery } from './store/eventTables';
import type { BlockPatch, CanvasRef, LensInput, Located, Move, NewBlock, NewGroup, PinPart, PinTarget, WaitOptions } from './store/inputs';
import { Pairings } from './store/pairing';
import { Pasting, type Paste, type Pasted } from './store/pasting';
import { People } from './store/people';
import { Pins } from './store/pins';
import { Reactions, type Reacted, type ReactionInput, type ReactionPlace } from './store/reactions';
import { BoardRepository } from './store/repository';
import { Requests, type PageAsk, type RequestAnswer } from './store/requests';
import { ScratchPad } from './store/scratchPad';
import { Skills } from './store/skills';
import { composeParts, partsOf, type CanvasCard, type CoreModules, type StorePart } from './store/storePart';
import { Sync } from './store/sync';
import { Threads, type RouteTarget, type Routed, type ThreadStart } from './store/threads';
import { useBlockKinds } from './blocks/registry';
import { useBoardCards } from './cards';
import { useCardReading } from './cardReading';
import { tallyOf, type BoardChange, type LiveState } from './changes';
import { connectorKinds } from './connectors/registry';
import type { Deletion } from './deletions';
import type { PairingEnd, PairingSession } from './pairing';
import type { SkillList, TricotSkill } from './skills';
import type { PixelSize } from './blocks/image/image';
import type { Actor, Block, BlockVersion, Board, BoardEvent, BoardSummary, Comment, ContextRequest, Group, Link, Pin, ScratchPage, Thread, ThreadRef, ThreadStatus, VersionSummary } from './types';

export { BoardError } from './store/errors';
export type { Reacted, ReactionInput, ReactionPlace } from './store/reactions';
export type { EventQuery } from './store/eventTables';
export type { BlockContent, BlockPatch, CanvasRef, InlineBlock, LensInput, Move, NewBlock, NewGroup, PinPart, PinTarget, WaitOptions } from './store/inputs';
export type { Paste, Pasted } from './store/pasting';
export type { PageAsk, RequestAnswer } from './store/requests';
export { checkImage, sniffImage } from './blocks/image/check';
export { inBlock, inBlockAsync } from './store/blockContent';
export { label, taskLabel } from './store/labels';
export { sameActor } from './store/validate';

// The Store is the one door onto the boards: the server and the tests call it, and it hands each call
// to the module in ./store that owns it (boards, decisions, tasks, canvases and blocks, pins, people and
// asks, threads, reactions, sync, deletions, the Sketchbook), all working over one BoardRepository, which holds the boards, their ids,
// the event log and saving. No rules live here: a rule is in the module that owns it.
// A project file as its code block on the Files canvas holds it: its path from
// its repository's top (or ~/… outside one), its text, and where that text is in it.
export interface FileBlockCode {
  path: string;
  text: string;
  start?: number;
  total?: number;
  commit?: string;
}

// How a Store is built. `parts` are what the Store is made of besides the core (store/storePart.ts): the lists of cards
// whose rows it reads and writes, the owners of their canvases, the kinds of card the canvas asks for, from the
// modules each part builds over the Store's own, and each part's own data version and migrations. A Store with `parts`
// migrates its own parts' data and no other's; one without migrates them together with those added to the process-wide
// list (`addDataPart`, store/dataParts.ts, read when the Store is built). A part whose data the file holds in a newer
// version than the part knows is off for the Store: it says so once, and the part's lists, owners and kinds of card are
// not registered, as in a Store built without the part. With none given, or `[]`, a canvas alone, which never parses,
// compares or writes a decision, a task or a row on their canvases, leaves each as the database holds it and keeps its id
// taken; a part's lists and owners with no kind of card are a part of their own, which no edition
// gives (Canvas's has no part), and a part's Store subclass has its whole part.
//
// `cards` and `lists` are the two options `parts` replaced, each replacing its half of the part a Store means by default
// (`cards`: the kinds of card, so a Store whose part has none is `cards: () => []`; `lists`: the lists, with their owners). They
// stay for the tests that build a Store with them, and go when those do; give a Store `parts` or these, not both. `Modules` is what `cards` is made over: the Store's own (`CoreModules`),
// and the part's when it builds its own.
export interface StoreOptions<Modules = CoreModules> {
  parts?: readonly StorePart<never>[];
  cards?: (modules: Modules) => CardKind[];
  lists?: readonly EntityList[];
}

export class Store {
  // Protected, not private, for the Store a part's own methods are added to (a part's Store subclass, and the test double CardStore in
  // test/madeUpCards.ts): they work over the repository and the modules the Store's own do. Nothing outside a subclass
  // reads them.
  protected readonly repo: BoardRepository;
  // The Store's own modules a part builds its modules from (`StorePart.modules`): what a subclass's methods work over too.
  protected readonly core: CoreModules;
  protected readonly pins: Pins;
  // The kinds of card, which first looks follow: they are a task's, so a Store with no kind of task leaves them as they are.
  protected readonly cards: CardKinds;
  private readonly assets: Assets;
  private readonly people: People;
  private readonly canvases: Canvases;
  private readonly blocks: Blocks;
  private readonly pasting: Pasting;
  private readonly pairings: Pairings;
  private readonly threads: Threads;
  private readonly reactions: Reactions;
  private readonly deletions: Deletions;
  private readonly connectorParts: Map<string, object>;
  private readonly requests: Requests;
  private readonly sync: Sync;
  private readonly skills: Skills;
  private readonly boards: Boards;
  private readonly scratchPad: ScratchPad;

  // `defaults` is the part the Store is made of when `options` give none (`partsOf`): none, a canvas alone. The Store that adds
  // a part's methods gives its whole part (a part's Store subclass).
  constructor(dataDir: string, options: StoreOptions<never> = {}, defaults?: StorePart<never>) {
    let parts = composeParts(partsOf(options, defaults));
    // The data parts the file is opened with: the parts' own, and the process-wide ones only for a Store given no parts.
    const data = options.parts ? parts.data : [...parts.data, ...dataParts()];
    // How agents read the parts' cards is the process's, not this Store's (cardReading.ts): a Store with no reading leaves
    // what an earlier one or the terminal set.
    if (parts.reading) useCardReading(parts.reading);
    // So do the kinds of board card (cards.ts): the readers that have only a board ask the process.
    const setsBoardCards = parts.boardCards.length > 0;
    if (setsBoardCards) useBoardCards(parts.boardCards);
    // And the kinds of block a part adds (blocks/registry.ts), which readers of a block with no Store at hand ask.
    const setsBlockKinds = parts.blockKinds.length > 0;
    if (setsBlockKinds) useBlockKinds(parts.blockKinds);
    this.repo = new BoardRepository(dataDir, parts.lists, parts.owners, data, parts.tables, parts.events);
    this.repo.syncTool = parts.syncTool;
    this.assets = new Assets(dataDir, this.repo);
    this.people = new People(this.repo);
    this.canvases = new Canvases(this.repo);
    this.blocks = new Blocks(this.repo, this.assets, this.canvases);
    this.pasting = new Pasting(this.repo, this.blocks, this.canvases);
    const core = (this.core = { repo: this.repo, assets: this.assets, blocks: this.blocks, people: this.people });
    // The parts' kinds of card, plugged into what the canvas needs of a card (store/cardKinds.ts): what a pinned part
    // becomes, and where a comment on a part of a card's canvas goes. The canvas names neither. Each is made over the
    // modules its part builds, or the Store's own when it builds none.
    const cards = (this.cards = new CardKinds());
    const built = new Map(parts.parts.flatMap((part) => (part.modules ? [[part.name, part.modules(core)] as const] : [])));
    const modulesOf = (part: StorePart<never>): never => (built.get(part.name) ?? core) as never;
    cards.replace(parts.cardKindsOver(modulesOf));
    // A part found off when the database opens is taken out of what is registered, before anything is read.
    this.repo.onPartsOff = (off) => {
      parts = parts.without(off.map(({ part }) => part));
      if (setsBoardCards) useBoardCards(parts.boardCards);
      if (setsBlockKinds) useBlockKinds(parts.blockKinds);
      this.repo.use(parts.lists, parts.owners, parts.tables, parts.events);
      this.repo.syncTool = parts.syncTool;
      cards.replace(parts.cardKindsOver(modulesOf));
    };
    this.pins = new Pins(this.repo, this.people, cards);
    this.pairings = new Pairings(this.repo, cards);
    this.threads = new Threads(this.repo, this.people, this.canvases, this.pins);
    this.reactions = new Reactions(this.repo);
    this.deletions = new Deletions(this.repo, this.assets);
    this.connectorParts = new Map(connectorKinds().flatMap((kind) => (kind.store ? [[kind.id, kind.store(this.repo)] as const] : [])));
    this.requests = new Requests(this.repo, this.people, this.canvases, this.pins);
    this.sync = new Sync(this.repo);
    this.skills = new Skills(this.repo);
    this.boards = new Boards(this.repo, this.assets, () => parts);
    this.scratchPad = new ScratchPad(this.repo, this.assets);
    this.repo.beforeSave((board) => this.deletions.pruneDeleted(board));
    this.checkEachCall(Store.prototype);
  }

  // For tests: each call on the Store is checked to have said what it changed (store/checkSaves.ts). A Store a part adds
  // methods to calls it for its own, once it is built.
  protected checkEachCall(prototype: object): void {
    if (CHECK_SAVES) checkAfterEachCall(this, prototype, ['flush', 'checkEachCall'], () => this.repo.saveEverything(), () => this.repo.checkSaves());
  }

  // The agents on a board now, by its key, from presence: the server sets it,
  // so a mention or an assignee can name an agent that has only read the board.
  get presentAgents(): (boardKey: string) => string[] {
    return this.repo.presentAgents;
  }
  set presentAgents(present: (boardKey: string) => string[]) {
    this.repo.presentAgents = present;
  }

  // The coordinators on a board now, by its key, the one seen last first, from
  // presence (core/roles.ts): the server sets it, so a thread a person starts
  // from a chat bar is one of theirs.
  get coordinatorsOf(): (boardKey: string) => string[] {
    return this.repo.coordinatorsOf;
  }
  set coordinatorsOf(coordinators: (boardKey: string) => string[]) {
    this.repo.coordinatorsOf = coordinators;
  }

  // Whether blocks may name what is on this computer (a website's folder or
  // dev server): the server says, by where it listens.
  get localFiles(): boolean {
    return this.repo.localFiles;
  }
  set localFiles(local: boolean) {
    this.repo.localFiles = local;
  }

  // The clock what runs out of time keeps time by, so tests can move it.
  get now(): () => number {
    return this.repo.now;
  }
  set now(clock: () => number) {
    this.repo.now = clock;
  }

  // The kinds of card this Store keeps, by name, in the order they were registered: none for a Store of no part. What a body
  // or a call may name a card by is a `<kind>Id` of one of these (schemas/shared.ts).
  cardKinds(): string[] {
    return this.repo.cardKinds();
  }

  // The address of a card's own page (core/pages.ts), by the kind of card it is: none for a kind no part registered.
  cardLink(kind: string, boardId: string, cardId: string): string | undefined {
    return this.cards.pageLink(kind, boardId, cardId);
  }

  load(): void {
    this.repo.load();
    // Deletions that ran out while the server was off go, with what only they kept.
    for (const board of this.repo.allBoards()) this.deletions.pruneDeleted(board);
  }

  flush(): Promise<void> { return this.repo.flush(); }
  subscribe(boardId: string, listener: (event: BoardEvent) => void): () => void { return this.repo.log.subscribe(boardId, listener); }
  // Each change to what is saved of a board (core/changes.ts), a moment after it is made, for the pages showing it.
  subscribeChanges(boardId: string, listener: (change: BoardChange) => void): () => void { return this.repo.log.subscribeChanges(boardId, listener); }
  // Told once if the board is deleted for good.
  subscribeDeleted(boardId: string, listener: () => void): () => void { return this.repo.log.subscribeDeleted(boardId, listener); }
  // The number of the board's latest change, and the changes after a number (none if they are no longer kept).
  changeVersion(boardId: string): number { return this.repo.log.version(boardId); }
  changesSince(boardId: string, ver: number): BoardChange[] | undefined { return this.repo.log.changesSince(boardId, ver); }
  // What a page compares with its own: the latest change, event, and how many of each the board has.
  liveState(boardId: string): LiveState {
    const board = this.repo.getBoard(boardId);
    return { ver: this.repo.log.version(boardId), seq: board.seq, tally: tallyOf(board) };
  }
  eventsSince(boardId: string, since: number, exclude?: Actor, limit?: number): BoardEvent[] { return this.repo.log.eventsSince(boardId, since, exclude, limit); }
  // A board's events as the query says, and how many there are: history pages, a card's own history, what a person hasn't seen.
  events(boardId: string, query: EventQuery): BoardEvent[] { return this.repo.log.events(boardId, query); }
  countEvents(boardId: string, query: EventQuery): number { return this.repo.countEvents(this.repo.getBoard(boardId), query); }
  waitForEvents(boardId: string, since: number, options: WaitOptions): Promise<BoardEvent[]> { return this.repo.log.waitForEvents(boardId, since, options); }

  // What agents reported of their skills, for the whole app (core/skills.ts): the lists, and an agent's new one, which replaces its last.
  agentSkills(): SkillList[] { return this.skills.list(); }
  reportSkills(agent: string, skills: { name: string; description: string }[]): SkillList { return this.skills.report(agent, skills); }
  // The skills people add in Tricot, for one agent or every agent, which a request carries to the agent.
  tricotSkills(): TricotSkill[] { return this.skills.tricot(); }
  addTricotSkill(person: string, input: { name: string; description: string; instructions: string; agent?: string }): TricotSkill { return this.skills.addTricot(person, input); }
  editTricotSkill(id: string, patch: { name?: string; description?: string; instructions?: string; agent?: string }): TricotSkill { return this.skills.editTricot(id, patch); }
  deleteTricotSkill(id: string): TricotSkill { return this.skills.deleteTricot(id); }

  listBoards(): BoardSummary[] { return this.boards.listBoards(); }
  getBoard(boardId: string): Board { return this.repo.getBoard(boardId); }
  // A card by the name of its kind (a canvas owner: `task`, `decision`) and its id, with its board: a lookup over the
  // repository, which server code asks of any Store. Refused as any card that is not on a board is, a kind no part registered
  // included. A part's Store subclass has the typed ones (`getTask`, `getDecision`).
  getCard(kind: string, id: string): { board: Board; card: CanvasCard } { return this.repo.getCard(kind, id); }
  // The same, or nothing when no card of the kind has the id: found by the index of the kind's list, not by a scan of the boards.
  findCard(kind: string, id: string): { board: Board; card: CanvasCard } | undefined { return this.repo.findCard(kind, id); }
  createBoard(input: { title: string; goal?: string; folder?: string }, actor: Actor): Board { return this.boards.createBoard(input, actor); }
  updateBoard(boardId: string, patch: { title?: string; goal?: string; folder?: string | null }, actor: Actor): Board { return this.boards.updateBoard(boardId, patch, actor); }
  // The board's status, as an agent writes it.
  setStanding(boardId: string, text: string, actor: Actor): Board { return this.boards.setStanding(boardId, text, actor); }
  setArchived(boardId: string, archived: boolean, actor: Actor): Board { return this.boards.setArchived(boardId, archived, actor); }
  deleteBoard(boardId: string, actor: Actor, confirm: string): void { return this.boards.deleteBoard(boardId, actor, confirm); }
  announceSeats(summary: string, actor: Actor): void { return this.boards.announceSeats(summary, actor); }
  requestSync(boardId: string, blockIds: string[] | undefined, actor: Actor): Board { return this.sync.requestSync(boardId, blockIds, actor); }
  cancelSync(boardId: string, actor: Actor): Board { return this.sync.cancelSync(boardId, actor); }
  finishSync(boardId: string, note: string | undefined, actor: Actor): Board { return this.sync.finishSync(boardId, note, actor); }
  getRequest(requestId: string, boardId?: string): { board: Board; request: ContextRequest } { return this.requests.getRequest(requestId, boardId); }
  askAgents(boardId: string, text: string, actor: Actor): ContextRequest { return this.requests.askAgents(boardId, text, actor); }
  takeRequest(requestId: string, actor: Actor, title?: string): { request: ContextRequest; group: Group | undefined } { return this.requests.takeRequest(requestId, actor, title); }
  finishRequest(requestId: string, note: string, actor: Actor): ContextRequest { return this.requests.finishRequest(requestId, note, actor); }
  cancelRequest(requestId: string, actor: Actor, boardId?: string): ContextRequest { return this.requests.cancelRequest(requestId, actor, boardId); }
  // About blocks a person selected on a Sketchbook page: asked of agents, answered with a decision or tasks (checked before they're made), or kept in the board context.
  askOnPage(pageId: string, input: PageAsk, actor: Actor): ContextRequest { return this.requests.askOnPage(pageId, input, actor); }
  checkAnswer(requestId: string, boardId: string, actor: Actor): void { return this.requests.checkAnswer(requestId, boardId, actor); }
  answerRequest(requestId: string, answer: RequestAnswer, actor: Actor): ContextRequest { return this.requests.answerWith(requestId, answer, actor); }
  keepInContext(pageId: string, blockIds: string[], actor: Actor): Pasted { return this.pasting.keep(pageId, blockIds, actor); }
  getThread(threadId: string): { board: Board; thread: Thread } { return this.repo.getThread(threadId); }
  startThread(boardId: string, body: string, actor: Actor, lens?: LensInput | null, start?: ThreadStart): Thread { return this.threads.startThread(boardId, body, actor, lens, start); }
  askInGeneral(boardId: string, text: string, actor: Actor): Thread { return this.threads.askInGeneral(boardId, text, actor); }
  setThreadLens(threadId: string, lens: LensInput | null, actor: Actor): Thread { return this.threads.setThreadLens(threadId, lens, actor); }
  postToThread(threadId: string, body: string, actor: Actor, refs: string[] = [], messageLens?: LensInput | null): Thread { return this.threads.postToThread(threadId, body, actor, refs, messageLens); }
  threadOn(threadId: string, board: Board): Thread { return this.threads.threadOn(threadId, board); }
  addThreadWork(threadId: string, ref: ThreadRef, actor: Actor): void { return this.threads.addThreadWork(threadId, ref, actor); }
  threadGroup(threadId: string, actor: Actor): Group | undefined { return this.threads.threadGroup(threadId, actor); }
  routeToThread(fromThreadId: string, messageId: string, actor: Actor, to: RouteTarget): Routed { return this.threads.routeToThread(fromThreadId, messageId, actor, to); }
  setThreadStatus(threadId: string, status: ThreadStatus, actor: Actor, summary?: string): Thread { return this.threads.setThreadStatus(threadId, status, actor, summary); }
  // What server code asks of a Store about a card, by the name of its kind: a comment on it, what its kind sweeps for lapsed
  // (first looks), and what an agent's call about it keeps. A Store with no such kind refuses the comment and leaves the rest.
  commentOnKind(kind: string, id: string, body: string, actor: Actor, about?: CommentAbout): CardCommented {
    const comment = this.cards.find(kind)?.commentOn;
    if (!comment) throw new BoardError(`Can't comment on a ${kind} here, as this Tricot has no ${kind}s.`);
    return comment(id, body, actor, about);
  }
  sweepKinds(board?: Board): number { return this.cards.sweep(board); }
  touchOnKind(kind: string, id: string, actor: Actor): void { this.cards.find(kind)?.touch?.(id, actor); }
  // A 👍, 👎 or 👀 on a comment or thread message, or taking one back (core/reactions.ts).
  react(place: ReactionPlace, input: ReactionInput, actor: Actor): Reacted { return this.reactions.react(place, input, actor); }
  // An agent's 👀 on what people wrote that its get_board or updates (`events`) put in front of it.
  seeComments(boardId: string, viewer: Actor, events?: BoardEvent[], accept?: Parameters<Reactions['seeComments']>[3]): number { return this.reactions.seeComments(boardId, viewer, events, accept); }
  // The Sketchbook's pages: a canvas each, made and renamed by people and agents, arranged and deleted by people.
  getPage(pageId: string): { board: Board; page: ScratchPage } { return this.repo.getPage(pageId); }
  addPage(boardId: string, title: string, actor: Actor, made?: { tool?: string; asked?: string }): ScratchPage { return this.scratchPad.addPage(boardId, title, actor, made); }
  renamePage(pageId: string, title: string, actor: Actor): ScratchPage { return this.scratchPad.renamePage(pageId, title, actor); }
  movePage(pageId: string, after: string | null, actor: Actor): ScratchPage { return this.scratchPad.movePage(pageId, after, actor); }
  deletePage(pageId: string, actor: Actor): void { return this.scratchPad.deletePage(pageId, actor); }
  // The board's Files canvas, and a project file's code block on it: found by the
  // path it names (from its repository's top), or made from `code`, the file as read, the first time.
  filesPage(boardId: string, actor: Actor): ScratchPage { return this.scratchPad.filesPage(boardId, actor); }
  fileBlock(boardId: string, code: FileBlockCode, actor: Actor): { block: Block; pageId: string; made: boolean } {
    const page = this.scratchPad.filesPage(boardId, actor);
    const found = page.canvas.blocks.find((b) => b.type === 'code' && b.path === code.path);
    if (found) return { block: found, pageId: page.id, made: false };
    return { block: this.blocks.addBlock({ pageId: page.id }, { content: { type: 'code', ...code } }, actor), pageId: page.id, made: true };
  }
  // The file's block, brought up to the file as it is now when the canvas had it already: an agent pairing on a file changes the file itself.
  syncFileBlock(boardId: string, code: FileBlockCode, actor: Actor): { block: Block; pageId: string; made: boolean } {
    const { block, pageId, made } = this.fileBlock(boardId, code, actor);
    // A block holds a first line of 1 as none, and a whole file's line count as none.
    const same = made || (block.type === 'code' && block.text === code.text && (block.start ?? 1) === (code.start ?? 1) && (block.total ?? 0) === (code.total ?? 0) && (block.commit ?? '') === (code.commit ?? ''));
    return { block: same ? block : this.updateBlock(block.id, { text: code.text, start: code.start, total: code.total ?? 0, commit: code.commit ?? '' }, actor), pageId, made };
  }
  // A thread started in Files about the file open there, on its block on the Files canvas:
  // made, or brought up to the file, only once the thread can start (core/fileThread.ts), so one that can't leaves no block behind.
  startThreadOnFile(boardId: string, body: string, actor: Actor, lens: LensInput | null | undefined, code: FileBlockCode, start: Pick<ThreadStart, 'door' | 'messageLens'> = {}): Thread {
    const make = () => {
      const { block, pageId } = this.syncFileBlock(boardId, code, actor);
      return { block, page: this.repo.getPage(pageId).page };
    };
    return this.threads.startThread(boardId, body, actor, lens, { ...start, door: start.door ?? 'threads', file: { named: code.path, make } });
  }
  getCanvas(ref: CanvasRef): Located { return this.canvases.getCanvas(ref); }
  canvasOf(itemId: string): Located { return this.canvases.canvasOf(itemId); }
  addBlock(ref: CanvasRef, input: NewBlock, actor: Actor): Block { return this.blocks.addBlock(ref, input, actor); }
  // Copies of blocks (and groups, with the links between them) from one canvas onto another, or the same one.
  pasteBlocks(ref: CanvasRef, input: Paste, actor: Actor): Pasted { return this.pasting.paste(ref, input, actor); }
  deriveBlock(blockId: string, actor: Actor): { block: Block; left: string[] } { return this.blocks.deriveBlock(blockId, actor); }
  updateBlock(blockId: string, patch: BlockPatch, actor: Actor, expectedRev?: number): Block { return this.blocks.updateBlock(blockId, patch, actor, expectedRev); }
  restoreBlock(blockId: string, rev: number, actor: Actor, expectedRev?: number): Block { return this.blocks.restoreBlock(blockId, rev, actor, expectedRev); }
  blockVersion(blockId: string, rev: number): BlockVersion { return this.blocks.blockVersion(blockId, rev); }
  versionSummaries(blockId: string): VersionSummary[] { return this.blocks.versionSummaries(blockId); }
  deleteVersion(blockId: string, rev: number, actor: Actor): Deletion { return this.deletions.deleteVersion(blockId, rev, actor); }
  deleteEarlierVersions(blockId: string, actor: Actor): Deletion { return this.deletions.deleteEarlierVersions(blockId, actor); }
  blockOf(blockId: string): Block { return this.repo.blockOf(blockId); }
  // A connector's part of the store (core/connectors/<id>/store.ts), such as where Google's drafts are kept.
  connectorStore<T extends object>(id: string): T {
    const part = this.connectorParts.get(id);
    if (!part) throw new Error(`The ${id} connector has no part in the store.`);
    return part as T;
  }
  addGroup(ref: CanvasRef, input: NewGroup, actor: Actor): Group { return this.canvases.addGroup(ref, input, actor); }
  renameGroup(groupId: string, title: string, actor: Actor): Group { return this.canvases.renameGroup(groupId, title, actor); }
  addLink(fromId: string, toId: string, label: string | undefined, actor: Actor, weight?: 'thin' | 'medium' | 'thick'): Link { return this.canvases.addLink(fromId, toId, label, actor, weight); }
  relabelLink(linkId: string, label: string, actor: Actor): Link { return this.canvases.relabelLink(linkId, label, actor); }
  pinComment(blockId: string, part: PinPart, body: string, actor: Actor, options: { ask?: boolean } = {}): { pin: Pin; comment: Comment } { return this.pins.pinComment(blockId, part, body, actor, options); }
  commentOnPin(pinId: string, body: string, actor: Actor): { pin: Pin; comment: Comment } { return this.pins.commentOnPin(pinId, body, actor); }
  resolvePin(pinId: string, resolved: boolean, actor: Actor): Pin { return this.pins.resolvePin(pinId, resolved, actor); }
  pin(blockId: string, part: PinPart, target: PinTarget, actor: Actor): Pin { return this.pins.pin(blockId, part, target, actor); }
  // Pairing sessions (core/pairing.ts): the piece one is on, its start and its end on the board, and what its agent is told.
  pairingPiece(blockId: string, part: string): { board: Board; block: Block; piece: string; where: string } { const { located, block, piece, where } = this.pairings.piece(blockId, part); return { board: located.board, block, piece, where }; }
  pairingStarted(session: PairingSession): void { return this.pairings.started(session); }
  pairingEnded(session: PairingSession, endedAt: number, why: PairingEnd): { summary: string; comment?: Comment } { return this.pairings.ended(session, endedAt, why); }
  pairingLine(session: PairingSession): string | undefined { return this.pairings.line(session); }
  pinAlongside(pinId: string, target: PinTarget, actor: Actor): Pin { return this.pins.pinAlongside(pinId, target, actor); }
  removeItem(itemId: string, actor: Actor): Deletion { return this.deletions.removeItem(itemId, actor); }
  restoreItem(itemId: string, actor: Actor): { deletion: Deletion; notes: string[] } { return this.deletions.restoreItem(itemId, actor); }
  moveItems(ref: CanvasRef, moves: Move[], actor: Actor): void { return this.canvases.moveItems(ref, moves, actor); }
  saveAsset(data: Uint8Array): string { return this.assets.saveAsset(data); }
  assetSize(assetId: string): PixelSize | null { return this.assets.assetSize(assetId); }
  assetFile(assetId: string): { file: string; mimeType: string } { return this.assets.assetFile(assetId); }
}
