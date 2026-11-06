import { Assets } from './store/assets';
import { Blocks } from './store/blocks';
import { CHECK_SAVES } from './store/boardDb';
import { Boards } from './store/boards';
import { Canvases } from './store/canvases';
import { CardDeletion } from './store/cardDeletion';
import { checkAfterEachCall } from './store/checkSaves';
import { Criteria } from './store/criteria';
import { DecisionLifecycle } from './store/decisionLifecycle';
import { Decisions } from './store/decisions';
import { Deletions } from './store/deletions';
import type { EventQuery } from './store/eventTables';
import { FirstLooks } from './store/firstLooks';
import type { BlockPatch, CanvasRef, DecisionPatch, LensInput, Located, Move, NewBlock, NewCriterion, NewDecision, NewFinding, NewGroup, NewTask, PinPart, PinTarget, ResolveInput, TaskPatch, WaitOptions } from './store/inputs';
import { Pairings } from './store/pairing';
import { People } from './store/people';
import { Pins } from './store/pins';
import { Reactions, type Reacted, type ReactionInput, type ReactionPlace } from './store/reactions';
import { BoardRepository } from './store/repository';
import { Requests } from './store/requests';
import { Skills } from './store/skills';
import { Sync } from './store/sync';
import { TaskLifecycle } from './store/taskLifecycle';
import { Tasks } from './store/tasks';
import { Threads, type ThreadStart } from './store/threads';
import { tallyOf, type BoardChange, type LiveState } from './changes';
import { connectorKinds } from './connectors/registry';
import type { Deletion } from './deletions';
import type { PairingEnd, PairingSession } from './pairing';
import type { Dismissed } from './needs';
import type { SkillList, TricotSkill } from './skills';
import type { PixelSize } from './blocks/image/image';
import type { Actor, Block, BlockVersion, Board, BoardEvent, BoardSummary, Comment, ContextRequest, Decision, Group, Link, MarkValue, Pin, Task, Thread, ThreadRef, VersionSummary } from './types';

export { BoardError } from './store/errors';
export type { Reacted, ReactionInput, ReactionPlace } from './store/reactions';
export type { EventQuery } from './store/eventTables';
export type {
  BlockContent, BlockPatch, CanvasRef, DecisionPatch, InlineBlock, LensInput, Move,
  NewAffect, NewBlock, NewCriterion, NewDecision, NewFinding, NewGroup, NewOption, NewTask, OptionChange, PinPart, PinTarget,
  ResolveInput, TaskPatch, WaitOptions,
} from './store/inputs';
export { checkImage, sniffImage } from './blocks/image/check';
export { inBlock, inBlockAsync } from './store/blockContent';
export { label, taskLabel } from './store/labels';
export { sameActor } from './store/validate';

// The Store is the one door onto the boards: the server and the tests call it, and it hands each call
// to the module in ./store that owns it (boards, decisions, tasks, canvases and blocks, pins, people and
// asks, threads, reactions, sync, deletions), all working over one BoardRepository, which holds the boards, their ids,
// the event log and saving. No rules live here: a rule is in the module that owns it.
export class Store {
  private readonly repo: BoardRepository;
  private readonly assets: Assets;
  private readonly people: People;
  private readonly criteria: Criteria;
  private readonly canvases: Canvases;
  private readonly blocks: Blocks;
  private readonly decisions: Decisions;
  private readonly firstLooks: FirstLooks;
  private readonly tasks: Tasks;
  private readonly pins: Pins;
  private readonly pairings: Pairings;
  private readonly threads: Threads;
  private readonly reactions: Reactions;
  private readonly deletions: Deletions;
  private readonly connectorParts: Map<string, object>;
  private readonly requests: Requests;
  private readonly sync: Sync;
  private readonly skills: Skills;
  private readonly boards: Boards;
  private readonly lifecycle: DecisionLifecycle;
  private readonly taskLifecycle: TaskLifecycle;
  private readonly cardDeletion: CardDeletion;

  constructor(dataDir: string) {
    this.repo = new BoardRepository(dataDir);
    this.assets = new Assets(dataDir, this.repo);
    this.people = new People(this.repo);
    this.criteria = new Criteria(this.repo);
    this.canvases = new Canvases(this.repo);
    this.blocks = new Blocks(this.repo, this.assets, this.canvases);
    this.decisions = new Decisions(this.repo, this.blocks, this.criteria, this.people);
    this.firstLooks = new FirstLooks(this.repo);
    this.tasks = new Tasks(this.repo, this.people, this.firstLooks);
    this.pins = new Pins(this.repo, this.tasks, this.decisions, this.people);
    this.pairings = new Pairings(this.repo, this.tasks, this.decisions);
    this.threads = new Threads(this.repo, this.people);
    this.reactions = new Reactions(this.repo);
    this.deletions = new Deletions(this.repo, this.assets);
    this.connectorParts = new Map(connectorKinds().flatMap((kind) => (kind.store ? [[kind.id, kind.store(this.repo)] as const] : [])));
    this.requests = new Requests(this.repo, this.people, this.canvases);
    this.sync = new Sync(this.repo);
    this.skills = new Skills(this.repo);
    this.boards = new Boards(this.repo, this.assets);
    this.lifecycle = new DecisionLifecycle(this.repo);
    this.taskLifecycle = new TaskLifecycle(this.repo);
    this.cardDeletion = new CardDeletion(this.repo, this.assets);
    this.repo.beforeSave((board) => this.deletions.pruneDeleted(board));
    if (CHECK_SAVES) checkAfterEachCall(this, Store.prototype, ['flush'], () => this.repo.saveEverything(), () => this.repo.checkSaves());
  }

  // The agents on a board now, by its key, from presence: the server sets it,
  // so a mention or an assignee can name an agent that has only read the board.
  get presentAgents(): (boardKey: string) => string[] {
    return this.repo.presentAgents;
  }
  set presentAgents(present: (boardKey: string) => string[]) {
    this.repo.presentAgents = present;
  }

  // Whether blocks may name what is on this computer (a website's folder or
  // dev server): the server says, by where it listens.
  get localFiles(): boolean {
    return this.repo.localFiles;
  }
  set localFiles(local: boolean) {
    this.repo.localFiles = local;
  }

  // The clock first looks and new tasks keep time by (core/firstLook.ts), so tests can move it.
  get now(): () => number {
    return this.repo.now;
  }
  set now(clock: () => number) {
    this.repo.now = clock;
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

  // What a person dismissed from their Needs you, by board key; and dismissing needs on a board (core/needs.ts).
  dismissedNeeds(person: string): Record<string, Dismissed> { return this.repo.dismissedNeeds(person); }
  dismissNeeds(boardId: string, person: string, items: { key: string; at: string }[]): void { return this.repo.dismissNeeds(this.repo.getBoard(boardId), person, items); }

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
  getTask(taskId: string): { board: Board; task: Task } { return this.repo.getTask(taskId); }
  getDecision(decisionId: string): { board: Board; decision: Decision } { return this.repo.getDecision(decisionId); }
  createBoard(input: { title: string; goal?: string }, actor: Actor): Board { return this.boards.createBoard(input, actor); }
  updateBoard(boardId: string, patch: { title?: string; goal?: string }, actor: Actor): Board { return this.boards.updateBoard(boardId, patch, actor); }
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
  getThread(threadId: string): { board: Board; thread: Thread } { return this.repo.getThread(threadId); }
  startThread(boardId: string, body: string, actor: Actor, lens?: LensInput | null, start?: ThreadStart): Thread { return this.threads.startThread(boardId, body, actor, lens, start); }
  askInGeneral(boardId: string, text: string, actor: Actor): Thread { return this.threads.askInGeneral(boardId, text, actor); }
  setThreadLens(threadId: string, lens: LensInput | null, actor: Actor): Thread { return this.threads.setThreadLens(threadId, lens, actor); }
  postToThread(threadId: string, body: string, actor: Actor, refs: string[] = []): Thread { return this.threads.postToThread(threadId, body, actor, refs); }
  threadOn(threadId: string, board: Board): Thread { return this.threads.threadOn(threadId, board); }
  addThreadWork(threadId: string, ref: ThreadRef, actor: Actor): void { return this.threads.addThreadWork(threadId, ref, actor); }
  postDecision(boardId: string, input: NewDecision, actor: Actor): Decision { return this.decisions.postDecision(boardId, input, actor); }
  updateDecision(decisionId: string, patch: DecisionPatch, actor: Actor): Decision { return this.decisions.updateDecision(decisionId, patch, actor); }
  requestRefresh(decisionId: string, note: string | undefined, actor: Actor): Decision { return this.decisions.requestRefresh(decisionId, note, actor); }
  askToRevisit(decisionId: string, decisionIds: string[], actor: Actor): Decision[] { return this.decisions.askToRevisit(decisionId, decisionIds, actor); }
  cancelRefresh(decisionId: string, actor: Actor): Decision { return this.decisions.cancelRefresh(decisionId, actor); }
  retire(decisionId: string, reason: string | undefined, actor: Actor): Decision { return this.lifecycle.retire(decisionId, reason, actor); }
  resolve(decisionId: string, input: ResolveInput, actor: Actor): Decision { return this.lifecycle.resolve(decisionId, input, actor); }
  requestExploration(decisionId: string, note: string | undefined, actor: Actor): Decision { return this.lifecycle.requestExploration(decisionId, note, actor); }
  defer(decisionId: string, note: string | undefined, actor: Actor): Decision { return this.lifecycle.defer(decisionId, note, actor); }
  reopen(decisionId: string, actor: Actor): Decision { return this.lifecycle.reopen(decisionId, actor); }
  addComment(decisionId: string, body: string, actor: Actor, pin?: Comment['pin'], ask?: string, askPart?: string): Decision { return this.decisions.addComment(decisionId, body, actor, pin, ask, askPart); }
  planTasks(boardId: string, inputs: NewTask[], actor: Actor, options: { ready?: boolean; backlog?: boolean } = {}): Task[] { return this.tasks.planTasks(boardId, inputs, actor, options); }
  addTaskComment(taskId: string, body: string, actor: Actor, pin?: Comment['pin'], ask?: string, askPart?: string): Task { return this.tasks.addTaskComment(taskId, body, actor, pin, ask, askPart); }
  // A 👍, 👎 or 👀 on a comment or thread message, or taking one back (core/reactions.ts).
  react(place: ReactionPlace, input: ReactionInput, actor: Actor): Reacted { return this.reactions.react(place, input, actor); }
  // An agent's 👀 on what people wrote that its get_board or updates (`events`) put in front of it.
  seeComments(boardId: string, viewer: Actor, events?: BoardEvent[]): number { return this.reactions.seeComments(boardId, viewer, events); }
  requestPlan(decisionId: string, note: string | undefined, actor: Actor): Decision { return this.decisions.requestPlan(decisionId, note, actor); }
  takeFirstLook(taskId: string, actor: Actor): Task { return this.firstLooks.takeFirstLook(taskId, actor); }
  keepFirstLook(taskId: string, actor: Actor): void { return this.firstLooks.keepFirstLook(taskId, actor); }
  lapseFirstLooks(board?: Board): number { return this.firstLooks.lapseFirstLooks(board); }
  claimTask(taskId: string, actor: Actor): Task { return this.tasks.claimTask(taskId, actor); }
  updateTask(taskId: string, patch: TaskPatch, actor: Actor): Task { return this.tasks.updateTask(taskId, patch, actor); }
  // A person sets a task aside as work that won't be done, and brings it back to the backlog or to do.
  dropTask(taskId: string, reason: string | undefined, actor: Actor): Task { return this.taskLifecycle.drop(taskId, reason, actor); }
  bringBackTask(taskId: string, to: 'backlog' | 'todo', actor: Actor): Task { return this.taskLifecycle.bringBack(taskId, to, actor); }
  // A person deletes a card made by mistake, for good, once they confirmed.
  deleteTask(taskId: string, actor: Actor): void { return this.cardDeletion.deleteTask(taskId, actor); }
  // What links to a task or decision, for the confirmation before deleting it.
  taskLinks(taskId: string): string[] { return this.cardDeletion.linksOf({ task: this.repo.getTask(taskId).task }); }
  decisionLinks(decisionId: string): string[] { return this.cardDeletion.linksOf({ decision: this.repo.getDecision(decisionId).decision }); }
  deleteDecision(decisionId: string, actor: Actor): void { return this.cardDeletion.deleteDecision(decisionId, actor); }
  askPeople(decisionId: string, names: string[], note: string | undefined, actor: Actor): Decision { return this.people.askPeople(decisionId, names, note, actor); }
  unask(decisionId: string, name: string, actor: Actor): Decision { return this.people.unask(decisionId, name, actor); }
  proposeCriteria(decisionId: string, inputs: NewCriterion[], actor: Actor): Decision { return this.criteria.proposeCriteria(decisionId, inputs, actor); }
  removeCriterion(decisionId: string, criterionId: string, actor: Actor): Decision { return this.criteria.removeCriterion(decisionId, criterionId, actor); }
  mark(decisionId: string, criterionId: string, optionId: string, value: MarkValue | null, actor: Actor): Decision { return this.criteria.mark(decisionId, criterionId, optionId, value, actor); }
  attachFinding(decisionId: string, input: NewFinding, actor: Actor): Decision { return this.decisions.attachFinding(decisionId, input, actor); }
  getCanvas(ref: CanvasRef): Located { return this.canvases.getCanvas(ref); }
  canvasOf(itemId: string): Located { return this.canvases.canvasOf(itemId); }
  addBlock(ref: CanvasRef, input: NewBlock, actor: Actor): Block { return this.blocks.addBlock(ref, input, actor); }
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
  addLink(fromId: string, toId: string, label: string | undefined, actor: Actor): Link { return this.canvases.addLink(fromId, toId, label, actor); }
  relabelLink(linkId: string, label: string, actor: Actor): Link { return this.canvases.relabelLink(linkId, label, actor); }
  pinTask(blockId: string, part: PinPart, input: { text: string; ready?: boolean }, actor: Actor): { pin: Pin; task: Task } { return this.pins.pinTask(blockId, part, input, actor); }
  pinQuestion(blockId: string, part: PinPart, input: { text: string }, actor: Actor): { pin: Pin; decision: Decision } { return this.pins.pinQuestion(blockId, part, input, actor); }
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
