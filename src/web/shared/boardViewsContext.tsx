import { createContext, useContext, type ReactNode } from 'react';
import type { BoardViewName } from '../../core/pages';
import { linkTo } from '../../core/pages';
import { BoardViews } from './boardViews';

// The views the page has registered (boardViews.ts), for the board's page, Home and
// the board switcher to ask. Wrapped round the page where it is built (App.tsx);
// without a provider, as in a test, the page has none and shows no board.
const NO_VIEWS = new BoardViews();
const BoardViewsContext = createContext<BoardViews>(NO_VIEWS);

export function BoardViewsProvider({ views, children }: { views: BoardViews; children: ReactNode }) {
  return <BoardViewsContext.Provider value={views}>{children}</BoardViewsContext.Provider>;
}

export function useBoardViews(): BoardViews {
  return useContext(BoardViewsContext);
}

// Where a view leads, by the name a thread stores for its door ('decisions',
// 'tasks', 'canvas') or a view's own: the registered view's address, else the
// board's own address, which lands.
export function useViewLink(): (boardId: string, view: BoardViewName) => string {
  const views = useBoardViews();
  return (boardId, view) => views.linkTo(boardId, view) ?? linkTo.board(boardId);
}
