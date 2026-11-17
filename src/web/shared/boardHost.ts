import type { BoardEvent } from '../../core/types';

// What a board's page gives the views registered on it (boardViews.ts): the
// model of what is new since the viewer looked, which the page keeps (live/away.ts)
// for the Sketchbook's change dots and for a part's inbox and Overview alike, and the
// cards an agent made from the viewer's conversations (threads/justMade.ts).

// What happened since the viewer was last here, held for the visit (live/away.ts),
// oldest first, and when that was: the time of the last event they had seen
// then. Their own doing is in it too, for the stories of the cards others
// changed: it is never news by itself.
export interface Visit {
  events: BoardEvent[];
  sinceAt: string | null;
}

export interface Away {
  events: BoardEvent[]; // unseen events from others, oldest first
  isNew: (event: BoardEvent) => boolean;
  decisions: Set<string>; // decisions with unseen changes
  items: Set<string>; // canvas blocks, groups and links with unseen changes
  boardCanvasChanged: boolean;
  pagesChanged: ReadonlySet<string>; // Sketchbook pages with unseen changes
  sinceAt: string | null; // when the viewer last looked; later comments by others are unread
  visit: Visit; // since the viewer was last here, held for the visit
  markSeen: (id: string) => void;
  markAllSeen: () => void;
}

// A decision or task an agent made from a conversation the viewer is part of,
// lit until they have seen it.
export interface JustMade {
  held: ReadonlySet<string>; // lit until seen
  fading: ReadonlySet<string>; // seen, fading
  seen: (id: string, fade?: boolean) => void;
}
