import type { CSSProperties, ReactNode } from 'react';
import type { OpenFile } from '../../core/fileThread';
import type { BoardPieceEntry, BoardRoute, BoardViewName } from '../../core/pages';
import type { AgentAround, BoardsReport, Project } from '../../core/projects';
import type { SearchKind, SearchResult } from '../../core/search';
import type { Block, Board, BoardSummary, Group, ScratchPage, ThreadDoor } from '../../core/types';
import type { AgentPresence, LiveBoard } from './api';
import type { Away, JustMade } from './boardHost';
import { RefKinds } from './refKinds';

// How a board's page is composed from views it is handed, rather than from the
// ones it names, so what a part adds can move to a repository of its own: the
// tabs, the pages of a card, the header's controls, the strip of what needs you,
// the changes feed, what Projects draws of a part's, what a board's Home lists in its Work, its part of the search palette, its
// wording of the name gate, its line in the live label's card and what it draws
// on the board context's canvas (the sync marks, the selection bar, the name a
// result or a card gives it) and the Keep in context of a Sketchbook page's
// blocks are registered here, as block kinds, connectors and agents register in
// theirs. The core registers the board's Home, the Sketchbook and the Files
// (web/board/coreViews.tsx), a page with parts the rest (its views, its cards' own pages,
// its strips and lists), and the board's page (web/board/BoardView.tsx) names none of them.
//
// The registry is each page's own, built where the page is (the entry's main,
// App.tsx) and handed to BoardViewsProvider, not a list every page shares:
// nothing is registered by loading a module, and it is never decided at run
// time from what the server says. A page with a view or a slot unregistered
// simply has no such tab, page or control: with a part's none, the board is its
// Home, the Sketchbook and the Files, with none of a part's strips or lists, and an
// address of one of a part's pages opens the board's landing.

export type { BoardRoute };

// What the page keeps for a registered side while a board is open: the state its
// views, controls and strips share (a part's notifications, its dismissals, a
// view of its own). It is made by the side's own hook (`useSession`) and handed
// back to what the side registered, which says what it is; the page never reads it.
export type BoardSession = unknown;

// What the page gives every view, control and page: the board, who is looking,
// where the address is, the model of what is new, and the session.
export interface BoardHost {
  board: LiveBoard;
  name: string;
  route: BoardRoute;
  shown: string; // the id of the view on screen ('' when the registry has none)
  away: Away;
  justMade: JustMade;
  session: BoardSession;
  onFile(file: OpenFile | undefined): void; // the Files view says which file is open, for the chat bar over it
}

// What the page has before the board is drawn, for a side's hook: the board may not be loaded yet.
export interface BoardSessionInput {
  board: LiveBoard | null;
  boardId: string;
  name: string;
  route: BoardRoute;
  away: Away;
}

// A tab's count, what follows it, and its dot.
export interface BoardTab {
  count?: number;
  more?: ReactNode;
  changed: boolean;
}

export interface BoardViewDef {
  // What the view is stored as (a thread's door, the address's view): 'canvas'
  // is the board context's, 'scratch' the Sketchbook.
  id: BoardViewName;
  // Other names it is opened by, each with where it leads: a part's address for another tab opens it, laid out as that tab does.
  also?: Record<BoardViewName, (boardId: string) => string>;
  // The pieces of a board's address that open it (core/pages.ts), which the page reads addresses with.
  address?: readonly BoardPieceEntry[];
  label?: string; // the tab's name; none, no tab (Files has a door)
  // Where the tab leads.
  link(boardId: string): string;
  // The tab's count and dot, from the board and what is new.
  tab?(host: BoardHost): BoardTab;
  // The tab goes before another's, else after the last.
  before?: BoardViewName;
  // A door before the tabs, for a view that is not a tab (the project folder's).
  door?(host: BoardHost): ReactNode;
  // What the chat bar over it is a door to (core/doors.ts).
  chat(host: BoardHost): ThreadDoor;
  // At the right end of the tabs' row, beside the changes feed.
  controls?(host: BoardHost): ReactNode;
  // The layout class it asks of the board's page ('overview' for board-layout-overview).
  layout?: string;
  // It draws its own conversation and chat bar (Home's), so the board's page
  // draws no chat bar or docked conversation over it: the view answers what
  // asks the dock to open a thread.
  holdsChat?: boolean;
  render(host: BoardHost): ReactNode;
}

// What a card's page is drawn inside: the top bar every view has, the bar for an
// archived board, and the strip of what needs the viewer.
export interface CardChrome {
  topbar: ReactNode;
  notice: ReactNode;
  needsYou: ReactNode;
}

// A card's own page, at its own address (a decision's, a task's): which card the
// address names, and its page, if the card is on the board (else the page is
// the view the address falls back on).
export interface CardPage {
  kind: string;
  address?: readonly BoardPieceEntry[]; // the card's own address
  idAt(route: BoardRoute): string | undefined;
  render(host: BoardHost, chrome: CardChrome): ReactNode | undefined;
}

// The Feed: the board's activity newest first, docked beside the board.
export interface BoardFeed {
  open(host: BoardHost): boolean;
  toggle(host: BoardHost): ReactNode;
  panel(host: BoardHost): ReactNode;
}

// What Projects (the list of boards, projects/Projects.tsx) draws that is a part's: the bell beside its search, the headline
// over the projects and the list of needs under it, each project's tag and
// column of work, and the first run that asks what the viewer is working on.
// `report` is the server's report of the boards in use (core/projects.ts), with
// the rows where a page with parts adds them. Projects is plain where a slot is not registered
// (Canvas registers none): a headline of its own, each project as its title, its
// description, the agents on it and when it last changed, and no first run.
export interface ProjectsSlots {
  controls(props: { report: BoardsReport | null; name: string }): ReactNode;
  needs(props: { report: BoardsReport; name: string }): ReactNode;
  headline?(props: { report: BoardsReport; name: string }): ReactNode;
  // What needs the viewer on a project, beside its title.
  projectTag?(props: { project: Project }): ReactNode;
  // What is on a project, in the row's column of its work (the status squares and what is settled).
  projectWork?(props: { project: Project }): ReactNode;
  // The first run, shown in place of the list while there are no boards.
  firstRun?: {
    shows(boards: BoardSummary[], sending: boolean): boolean;
    render(props: { name: string; agents: AgentAround[]; onSending(sending: boolean): void; onEveryWay(): void }): ReactNode;
  };
}

// The search palette's part that is a part's (board/search.tsx): its chips and
// what each kind of result is headed with, its wording, the chip that leaves
// out closed cards, and how a card's result shows its status. The palette is
// the canvas's (comments and canvases, as All, Comments and Canvas); a page
// that registers none searches only those and says so.
export interface SearchSlot {
  // Chips between All and Comments, one for each kind of card a part adds.
  filters: { key: string; label: string; kinds: SearchKind[] }[];
  // What a kind's results are headed with, for the kinds beyond the canvas's own.
  groups: Partial<Record<SearchKind, string>>;
  placeholder: string;
  hint: string; // under the field before anything is typed
  openOnly: { title: string }; // the chip that leaves out closed cards; its label is "Open only"
  // How a card's result shows where it stands: its status in words, the class that draws its marker, and the tag at the row's end.
  result(result: SearchResult): { status?: string; marker: string; tag: ReactNode };
}

// The page's own wording where a part's differs from plain words: what asks a
// person's name, and what it says the name is for.
export interface PageWords {
  nameGate: string;
}

// What the page gives a piece a page with parts draws on the board context's canvas: the board, who is looking, the
// canvas's own way to select blocks (none selects none) and to show a refusal.
export interface BoardContextTools {
  board: Board;
  name: string;
  select(ids: string[]): void;
  report(error: unknown): void;
}

// Where blocks went, said under them while they stay selected: the blocks it is about, and the line, which the
// canvas places (its inline style) and puts above them when there is no room below.
export interface KeptBlocks {
  blockIds: string[];
  notice(place: { style: CSSProperties; above: boolean }): ReactNode;
}

// What a page with parts adds to a Sketchbook page's blocks: copying them onto the board context, which a Canvas page has
// hidden, from a button in a block's menu and in a group's. The words are a part's, and so is the call.
export interface KeepInContext {
  label: string; // the button's, in both menus
  blockTitle(count: number): string; // its tooltip in a block's menu: `count` blocks, the one or those selected with it
  groupTitle: string; // and in a group's menu
  // Copies the blocks of the page and answers with the line that says where they went; a refusal is the caller's to show.
  run(tools: BoardContextTools & { page: ScratchPage; blockIds: string[] }): Promise<KeptBlocks>;
}

// What a page with parts adds to the board context's canvas, the canvas of the board itself (a part's board of context),
// which has no card and no page, and what it calls it where the page says where something is. Where a canvas is not
// the board context, and on a page with none registered, nothing here is drawn and nothing is named: a result
// names no canvas, and a card or a file that sits on the board's own canvas is said to be on "the board". The one
// piece that is for a Sketchbook page is `keep`.
export interface BoardContextSlot {
  name: string; // what the canvas is called in a result or a card, capitalised ("Board Context"); lower case in running words
  generalThread: string; // what a thread started from the board context's bar (its General thread) says it is for
  // The strip over the canvas's foot while two or more blocks are selected.
  selection(tools: BoardContextTools & { blockIds: string[] }): ReactNode;
  // In a selected block's toolbar, unless several blocks are selected.
  blockTool(tools: BoardContextTools & { block: Block }): ReactNode;
  // In each block's head, where another canvas shows the actor badge.
  blockMarks(props: { board: Board; name: string; block: Block }): ReactNode;
  // In the header of a group that has blocks, after its count, unless the board is read-only.
  groupTool(tools: BoardContextTools & { group: Group }): ReactNode;
  // On a Sketchbook page's blocks, unless the board is read-only: Keep in context.
  keep: KeepInContext;
}

// Home's Work, beside its conversation (threads/timelineWork.tsx): the work on a board by where it stands, in groups.
// The core lists the threads agents own under its four groups, by their ids ('needs-you', 'in-progress', 'to-do',
// 'done'); a part adds its own cards and groups with `withWork` (a part's tasks, with its backlog and its review), and
// with none registered Work lists the threads alone.
export type WorkGroupId = string;

export interface WorkGroup {
  id: WorkGroupId;
  label: string;
  hint?: string; // after its count, at the head's end
  before?: WorkGroupId; // a group it goes before; else after the last
  quiet?: boolean; // its rows a line each, the latest few shown until asked for the rest (as Done is)
}

// Its marker, in the colour of where it stands, from the one map of the status colours (styles/base.css,
// `--status-*`): not started yet (to do), at work (in progress), a person's turn (in review), blocked, done,
// or set aside for later (to do's, hollow).
export type WorkSquare = 'todo' | 'working' | 'waiting' | 'blocked' | 'done' | 'later';

// A row of Work: a piece of work where it stands.
export interface WorkRow {
  key: string;
  group: WorkGroupId;
  square: WorkSquare;
  title: string;
  label?: string; // a card's number before its title (T5)
  agent?: string; // the agent on it, whose mark leads its line
  line?: ReactNode; // under the title: what is happening on it now
  live?: boolean; // its agent has a step on it now
  progress?: { done: number; total: number }; // how far along its agent's plan is
  at: string; // when it last moved: the latest first in its group
  end?: string; // at the row's end, else when it last moved, said briefly
  thread?: string; // the thread whose strand pointing at it lights: the one it is, or the one it came from
  open(): void;
}

// A moment of a part's card that needs the viewer, which Home's conversation relays as it relays a thread's
// (threads/relays.ts): a card blocked, such as a task. It opens the card, as it has no thread to answer in.
export interface WorkRelay {
  key: string;
  kind: 'blocked';
  title: string;
  label?: string; // its number before its title (T5)
  at: string; // when it moved there
  line: string; // what holds it, in a line
  open(): void;
}

export interface WorkSlot {
  groups: WorkGroup[];
  rows(props: { board: Board; name: string }): WorkRow[];
  relays?(props: { board: Board; name: string }): WorkRelay[]; // what of its cards Home's conversation relays
}

const PLAIN_WORDS: PageWords = { nameGate: 'Your name is attached to what you add, so everyone can see who did what.' };

export class BoardViews {
  private readonly views: BoardViewDef[] = [];
  private readonly pages: CardPage[] = [];
  private landing: BoardViewName | undefined;
  private sessionHook: ((input: BoardSessionInput) => BoardSession) | undefined;
  private headerControls: ((host: BoardHost) => ReactNode) | undefined;
  private strip: ((host: BoardHost) => ReactNode) | undefined;
  private feedSlot: BoardFeed | undefined;
  private projectsSlots: ProjectsSlots | undefined;
  private searchSlot: SearchSlot | undefined;
  private wordsSet: PageWords | undefined;
  private boardContextSlot: BoardContextSlot | undefined;
  private agentWorkSlot: ((props: { board: Board; agent: AgentPresence }) => ReactNode) | undefined;
  private workSlot: WorkSlot | undefined;
  private refKindsSet: RefKinds | undefined;
  private readonly noRefKinds = new RefKinds();

  // Adds a view, in the order the page registers them (its tab goes where it
  // says). A second view of one id, or one named by an id another has, is a mistake in Tricot.
  add(view: BoardViewDef): void {
    const names = [view.id, ...Object.keys(view.also ?? {})];
    if (names.some((name) => this.find(name))) throw new Error(`There are two views of a board named ${view.id}.`);
    if (view.before && !this.views.some((other) => other.id === view.before)) throw new Error(`The view ${view.id} goes before ${view.before}, which is not registered.`);
    this.views.push(view);
  }

  addCardPage(page: CardPage): void {
    if (this.pages.some((other) => other.kind === page.kind)) throw new Error(`There are two pages of cards named ${page.kind}.`);
    this.pages.push(page);
  }

  // The view an address opens when it names none (the board's own address): one registration, not one of each.
  landOn(id: BoardViewName): void {
    if (this.landing) throw new Error('There are two landing views.');
    this.landing = id;
  }

  // The side's hook for a board's session, called by the board's page in every render, whatever the board.
  withSession(hook: (input: BoardSessionInput) => BoardSession): void {
    if (this.sessionHook) throw new Error('There are two sessions of a board.');
    this.sessionHook = hook;
  }

  withHeaderControls(controls: (host: BoardHost) => ReactNode): void {
    if (this.headerControls) throw new Error('There are two sets of header controls.');
    this.headerControls = controls;
  }

  withNeedsStrip(strip: (host: BoardHost) => ReactNode): void {
    if (this.strip) throw new Error('There are two strips of what needs you.');
    this.strip = strip;
  }

  withFeed(feed: BoardFeed): void {
    if (this.feedSlot) throw new Error('There are two feeds.');
    this.feedSlot = feed;
  }

  withProjects(slots: ProjectsSlots): void {
    if (this.projectsSlots) throw new Error('There are two sets of slots on Projects.');
    this.projectsSlots = slots;
  }

  withSearch(slot: SearchSlot): void {
    if (this.searchSlot) throw new Error('There are two search slots.');
    this.searchSlot = slot;
  }

  withWords(words: PageWords): void {
    if (this.wordsSet) throw new Error('There are two sets of page words.');
    this.wordsSet = words;
  }

  // What a page with parts draws on the board context's canvas and calls it; none, the canvas has no sync marks, no selection bar and no name,
  // and a Sketchbook page has no Keep in context.
  withBoardContext(slot: BoardContextSlot): void {
    if (this.boardContextSlot) throw new Error("There are two sets of tools for the board's own canvas.");
    this.boardContextSlot = slot;
  }

  // What an agent on a board is doing on a card, in the live label's card (a
  // line of the tasks it has in progress); none, nothing is said of its cards.
  withAgentWork(render: (props: { board: Board; agent: AgentPresence }) => ReactNode): void {
    if (this.agentWorkSlot) throw new Error('There are two renderers of what an agent is working on.');
    this.agentWorkSlot = render;
  }

  // What a part adds to Home's Work: its cards and the groups they stand in; none, Work lists the threads agents own.
  withWork(slot: WorkSlot): void {
    if (this.workSlot) throw new Error("There are two sets of work on a board's Home.");
    this.workSlot = slot;
  }

  // The kinds of card a text can name, for the board's page (refKinds.ts); none, no #12 or T5.
  withRefKinds(kinds: RefKinds): void {
    if (this.refKindsSet) throw new Error('There are two sets of reference kinds.');
    this.refKindsSet = kinds;
  }

  find(id: BoardViewName | undefined): BoardViewDef | undefined {
    return id === undefined ? undefined : this.views.find((view) => view.id === id || Object.hasOwn(view.also ?? {}, id));
  }

  // The view an address with none opens: the one claimed, else the first tab.
  landingView(): BoardViewDef | undefined {
    return this.find(this.landing) ?? this.tabs()[0] ?? this.views[0];
  }

  // Where the view of this name leads, by the name it is stored by or one it is opened by, else the board's own address.
  linkTo(boardId: string, id: BoardViewName): string | undefined {
    const view = this.find(id);
    return view && (Object.hasOwn(view.also ?? {}, id) ? view.also![id](boardId) : view.link(boardId));
  }

  // What an address opens: the view it names, else the landing.
  viewAt(id: BoardViewName | undefined): BoardViewDef | undefined {
    return this.find(id) ?? this.landingView();
  }

  // The views with a tab, in the order they go.
  tabs(): BoardViewDef[] {
    const tabs: BoardViewDef[] = [];
    for (const view of this.views.filter((v) => v.label !== undefined)) {
      const at = view.before ? tabs.findIndex((other) => other.id === view.before) : -1;
      if (at >= 0) tabs.splice(at, 0, view);
      else tabs.push(view);
    }
    return tabs;
  }

  // The pieces of a board's address the registered views and pages read, in the order they were registered (core/pages.ts pageAt).
  pieces(): BoardPieceEntry[] {
    return [...this.views.flatMap((view) => view.address ?? []), ...this.pages.flatMap((page) => page.address ?? [])];
  }

  doors(): BoardViewDef[] {
    return this.views.filter((view) => view.door);
  }

  cardPages(): readonly CardPage[] {
    return this.pages;
  }

  // The session of a side, if it registered one (a hook: the page calls it unconditionally).
  useSession(input: BoardSessionInput): BoardSession {
    return this.sessionHook?.(input);
  }

  controls(host: BoardHost): ReactNode {
    return this.headerControls?.(host);
  }

  needsStrip(host: BoardHost): ReactNode {
    return this.strip?.(host);
  }

  feed(): BoardFeed | undefined {
    return this.feedSlot;
  }

  projects(): ProjectsSlots | undefined {
    return this.projectsSlots;
  }

  search(): SearchSlot | undefined {
    return this.searchSlot;
  }

  // The page's wording: what a page with parts registered, else plain words that name no decision or task.
  words(): PageWords {
    return this.wordsSet ?? PLAIN_WORDS;
  }

  boardContext(): BoardContextSlot | undefined {
    return this.boardContextSlot;
  }

  agentWork(): ((props: { board: Board; agent: AgentPresence }) => ReactNode) | undefined {
    return this.agentWorkSlot;
  }

  work(): WorkSlot | undefined {
    return this.workSlot;
  }

  refKinds(): RefKinds {
    return this.refKindsSet ?? this.noRefKinds;
  }
}
