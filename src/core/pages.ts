// Every page of the web app the core knows, once: the address each is at, the page
// an address opens (pageAt), and the link to each (linkTo). The page reads the
// address and builds every link it shows from here (web/shared/pages.ts), and so
// do the server and the command when they link to one (the board an agent command
// opens), so a link and the page it opens can't drift apart: test/pages.test.ts
// checks that the page writes no address of its own. An address is the part after
// # (the server serves the same page at every path).
//
// Projects, the Connectors page and a board are the core's, and a board's address is
// its id, `#/b/<id>`, and then a piece the views name: the Sketchbook's pages, the
// project's Files, the board's Home with a thread open in it, and a pin are the core's own, and the rest is registered by what
// draws it (a part's, each parsed by `pieces` that
// `pageAt` is given). An address no piece reads is the board's own, which lands on
// the registry's default view (web/shared/boardViews.ts).
//
// No imports: the browser takes it too (test/bundle.test.ts).

// What a board's views are called, by the name stored for each (a thread's door,
// core/doors.ts): 'scratch' is the Sketchbook, at /sketchbook (it was the Scratch
// pad before), 'files' the board's project files, behind a
// folder icon before the tabs: not a named tab, but a view of its own all the
// same, and 'timeline' the board's Home, at /home: the conversation with its
// threads knitted off it, and the work beside it. The rest are what registers them.
export type BoardViewName = string;
export type CoreView = 'scratch' | 'files' | 'timeline';

const VIEW_PATHS: Record<CoreView, string> = { scratch: 'sketchbook', files: 'files', timeline: 'home' };

// What a piece of a board's address says once read: the view it opens, and
// whatever else the view that registered it needs of the address, by name (a
// card's id, how the Decisions are laid out). The route keeps it as it is,
// and what registered the piece reads it back.
export type BoardPiece = Readonly<Record<string, unknown>>;

// What a piece reads of an address, which the board's route takes as it is.
export interface BoardPieceRead {
  view?: BoardViewName;
  piece?: BoardPiece;
  pinId?: string;
  pageId?: string;
  threadId?: string;
  file?: string;
  pair?: true;
}

// A piece of a board's address, from the registered views: the pattern of what
// follows `#/b/<id>`, and what it reads from it.
export interface BoardPieceEntry {
  readonly pattern: RegExp;
  read(match: RegExpMatchArray): BoardPieceRead;
}

export type PageRoute =
  | { page: 'projects' } // the projects: every board, one row each
  | { page: 'connectors'; from?: string } // from: the board it was opened from
  // view: the view the address opens, none for the board's own address and a pin's, which open the registry's default;
  // piece: what a registered piece read of the address;
  // pinId: a pin on the board context or a Sketchbook page, to open; pageId: the Sketchbook page shown;
  // threadId: on the board's Home, the thread open in its main pane;
  // landing: the board's own address, which opens the default view, and the page moves there;
  // file: in the project files, the file shown, from the project folder; pair: opened to pair on;
  // line: the line of the file to show, from a search of what is inside the files
  | {
      page: 'board';
      boardId: string;
      view?: BoardViewName;
      piece?: BoardPiece;
      pinId?: string;
      pageId?: string;
      threadId?: string;
      landing?: true;
      file?: string;
      pair?: true;
      line?: number;
    };

export type BoardRoute = Extract<PageRoute, { page: 'board' }>;

// A value as one piece of an address, and back.
const piece = (value: string) => encodeURIComponent(value);
const valueOf = (piece: string | undefined) => (piece ? decodeURIComponent(piece) : undefined);

interface PageEntry {
  readonly pattern: RegExp;
  read(match: RegExpMatchArray, pieces: readonly BoardPieceEntry[]): PageRoute;
}

// The pieces the core reads itself, before the registered ones: a pin on the
// board context or a Sketchbook page, a page of the Sketchbook and the
// Sketchbook, the board's Home and a thread open in it, and the project files and the file shown in them.
const CORE_PIECES: readonly BoardPieceEntry[] = [
  { pattern: /^\/overview\/p\/([^/]+)/, read: (match) => ({ pinId: valueOf(match[1]) }) },
  { pattern: /^\/sketchbook\/([^/?]+)/, read: (match) => ({ view: 'scratch', pageId: valueOf(match[1]) }) },
  { pattern: /^\/sketchbook/, read: () => ({ view: 'scratch' }) },
  { pattern: /^\/home\/([^/?]+)/, read: (match) => ({ view: 'timeline', threadId: valueOf(match[1]) }) },
  { pattern: /^\/home(?![^/?])/, read: () => ({ view: 'timeline' }) },
  {
    pattern: /^\/files(?![^/?])(?:\?path=([^&]*)(&pair)?(?:&line=(\d+))?)?/,
    read: (match) => {
      const file = valueOf(match[1]);
      const line = Number(match[3]);
      return { view: 'files', ...(file ? { file } : {}), ...(file && match[2] ? { pair: true as const } : {}), ...(file && line > 0 ? { line } : {}) };
    },
  },
];

// The pages, in the order an address is tried against them: the pattern of
// each one's addresses, what it reads from one, and the link to it.
export const pages = {
  connectors: {
    pattern: /^#\/connectors(?:\?from=([^&]+))?/,
    read: (match: RegExpMatchArray): PageRoute => ({ page: 'connectors', from: valueOf(match[1]) }),
    // From a board, its Back link goes back to it.
    link: (from?: string) => (from ? `#/connectors?from=${piece(from)}` : '#/connectors'),
  },
  board: {
    // A board is its id, and then a piece of the core's, or one a registered
    // view reads. No piece reads what follows: the board's own address, which lands.
    pattern: /^#\/b\/([^/]+)/,
    read: (match: RegExpMatchArray, pieces: readonly BoardPieceEntry[]): PageRoute => {
      const boardId = decodeURIComponent(match[1]);
      const rest = (match.input ?? '').slice(match[0].length);
      for (const entry of [...CORE_PIECES, ...pieces]) {
        const found = entry.pattern.exec(rest);
        if (found) return { page: 'board', boardId, ...entry.read(found) };
      }
      return { page: 'board', boardId, landing: true };
    },
    // A board on one of the core's views, or its own address, which lands on the default view.
    link: (boardId: string, view?: CoreView) => `#/b/${piece(boardId)}${view ? `/${VIEW_PATHS[view]}` : ''}`,
    // Its project files, a file shown in them when given (its path from the project folder), opened to pair on when asked, or at a line.
    files: (boardId: string, file?: string, pair?: boolean, line?: number) =>
      `#/b/${piece(boardId)}/${VIEW_PATHS.files}${file ? `?path=${piece(file)}${pair ? '&pair' : ''}${line ? `&line=${line}` : ''}` : ''}`,
    // A pin on its board context, opened: its thread, or its block's full view at
    // it (a website's element). The page drops the pin from the address once it has
    // opened it, so the same link opens it again.
    pin: (boardId: string, pinId: string) => `#/b/${piece(boardId)}/overview/p/${piece(pinId)}`,
    // A page of its Sketchbook, shown. A pin on one opens there too: the page
    // finds the pin's page, and moves the address to it.
    scratchPage: (boardId: string, pageId: string) => `#/b/${piece(boardId)}/${VIEW_PATHS.scratch}/${piece(pageId)}`,
    // A thread, open in the board's Home's main pane, where it is read and answered.
    thread: (boardId: string, threadId: string) => `#/b/${piece(boardId)}/${VIEW_PATHS.timeline}/${piece(threadId)}`,
  },
  // Projects, the list of boards, is at #/, and is what any other address opens.
  projects: {
    pattern: /^/,
    read: (): PageRoute => ({ page: 'projects' }),
    link: () => '#/',
  },
} as const;

// The page an address opens, with the pieces of a board's address the registered
// views read (web/shared/boardViews.ts); none, the core's own.
export function pageAt(hash: string, pieces: readonly BoardPieceEntry[] = []): PageRoute {
  for (const page of Object.values(pages) as PageEntry[]) {
    const match = hash.match(page.pattern);
    if (match) return page.read(match, pieces);
  }
  return { page: 'projects' };
}

// What an address can ask of the page it opens, once: ?new on Projects focuses
// the new board field (the board switcher's New board), and ?ask on a board
// context focuses the chat bar (Projects' "Ask an agent for the first
// questions"). The page takes it off the address once it has read it.
export const flags = {
  newBoard: /\?new$/,
  ask: /\?ask$/,
} as const;

// Every link to a page of the core's, by what it opens.
export const linkTo = {
  projects: pages.projects.link,
  newBoard: () => `${pages.projects.link()}?new`,
  connectors: pages.connectors.link,
  board: pages.board.link,
  // The board context, the canvas of the board itself: it is shown where a part's
  // Overview hosts it, which is where this goes; a page with no view that shows it
  // opens the board's own address instead (it lands).
  context: (boardId: string) => `#/b/${piece(boardId)}/overview/context`,
  askAgents: (boardId: string) => `${linkTo.context(boardId)}?ask`,
  pin: pages.board.pin,
  page: pages.board.scratchPage,
  thread: pages.board.thread,
  files: pages.board.files,
};

// The same address on a board's current id: an old link, or the board being
// renamed, moves the page there with the rest of the address kept.
export const onBoard = (hash: string, boardId: string): string => hash.replace(/^#\/b\/[^/]+/, pages.board.link(boardId));
