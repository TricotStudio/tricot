// Every page of the web app, once: the address each is at, the page an
// address opens (pageAt), and the link to each (linkTo). The page reads the
// address and builds every link it shows from here (web/shared/pages.ts), and
// so do the server and the command when they link to one (a decision shared
// to Slack, the board an agent command opens), so a link and the page it
// opens can't drift apart: test/pages.test.ts checks that the page writes no
// address of its own. An address is the part after # (the server serves the
// same page at every path).
//
// No imports: the browser takes it too (test/bundle.test.ts).

// A board's tabs.
export type BoardViewName = 'decisions' | 'canvas' | 'tasks';

export type PageRoute =
  | { page: 'home' }
  | { page: 'connectors'; from?: string } // from: the board it was opened from
  | { page: 'board'; boardId: string; view: BoardViewName; decisionId?: string; taskId?: string };

// A value as one piece of an address, and back.
const piece = (value: string) => encodeURIComponent(value);
const valueOf = (piece: string | undefined) => (piece ? decodeURIComponent(piece) : undefined);

interface PageEntry {
  readonly pattern: RegExp;
  read(match: RegExpMatchArray): PageRoute;
}

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
    pattern: /^#\/b\/([^/]+)(?:\/(canvas|tasks|decisions)|\/d\/([^/]+)|\/t\/([^/]+))?/,
    read: (match: RegExpMatchArray): PageRoute => ({
      page: 'board',
      boardId: decodeURIComponent(match[1]),
      view: (match[2] as BoardViewName | undefined) ?? 'tasks', // a board opens on its tasks
      decisionId: valueOf(match[3]),
      taskId: valueOf(match[4]),
    }),
    // A board on one of its tabs, or on the one it opens on.
    link: (boardId: string, view?: BoardViewName) => `#/b/${piece(boardId)}${view ? `/${view}` : ''}`,
    // A card on it, opened.
    task: (boardId: string, taskId: string) => `#/b/${piece(boardId)}/t/${piece(taskId)}`,
    decision: (boardId: string, decisionId: string) => `#/b/${piece(boardId)}/d/${piece(decisionId)}`,
  },
  // Home is at #/, and is what any other address opens.
  home: {
    pattern: /^/,
    read: (): PageRoute => ({ page: 'home' }),
    link: () => '#/',
  },
} as const;

// The page an address opens.
export function pageAt(hash: string): PageRoute {
  for (const page of Object.values(pages) as PageEntry[]) {
    const match = hash.match(page.pattern);
    if (match) return page.read(match);
  }
  return { page: 'home' };
}

// What an address can ask of the page it opens, once: ?new on Home focuses
// the new board field (the board switcher's New board), and ?ask on a board
// context focuses the chat bar (Home's "Ask an agent for the first
// questions"). The page takes it off the address once it has read it.
export const flags = {
  newBoard: /\?new$/,
  ask: /\?ask$/,
} as const;

// Every link to a page, by what it opens.
export const linkTo = {
  home: pages.home.link,
  newBoard: () => `${pages.home.link()}?new`,
  connectors: pages.connectors.link,
  board: pages.board.link,
  askAgents: (boardId: string) => `${pages.board.link(boardId, 'canvas')}?ask`,
  task: pages.board.task,
  decision: pages.board.decision,
};

// The same address on a board's current id: an old link, or the board being
// renamed, moves the page there with the rest of the address kept.
export const onBoard = (hash: string, boardId: string): string => hash.replace(/^#\/b\/[^/]+/, pages.board.link(boardId));
