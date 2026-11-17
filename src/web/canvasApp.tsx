import { useState } from 'react';
import { NeedsBell } from './bell';
import { coreBoardViews } from './board';
import { Page } from './page';
import { BoardViews } from './shared/boardViews';
import { BoardViewsProvider } from './shared/boardViewsContext';
import { CardKinds } from './shared/cardKinds';
import { CardKindsProvider } from './shared/cardKindsContext';
import { Shell } from './shell';

// Tricot Canvas's page: the shell, Home, the board with its Sketchbook and
// Files, and its threads, built with no registry of a part's and importing none
// of its code: no kind of card, no reference to #12 or T5, and none of its
// views (shared/boardViews.ts), so a board has no Overview, Tasks, board context,
// inbox, Needs strip or Feed, and lands on the Sketchbook. Its header has the
// bell (bell/needsBell.tsx) where a page with parts has the notifications list: the threads, the
// mentions and the agents that wait on the viewer, with the switch of notifications.
// App.tsx builds the page with a part's.
export function canvasBoardViews(): BoardViews {
  const views = coreBoardViews(new BoardViews());
  views.withHeaderControls((host) => <NeedsBell {...host} />);
  return views;
}

export function CanvasApp() {
  const [cards] = useState(() => new CardKinds());
  const [views] = useState(canvasBoardViews);
  return (
    <CardKindsProvider kinds={cards}>
      <BoardViewsProvider views={views}>
        <Shell>{(name) => <Page name={name} />}</Shell>
      </BoardViewsProvider>
    </CardKindsProvider>
  );
}
