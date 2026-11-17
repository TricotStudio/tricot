// How the conversation reads the cards of a board, through cards.ts rather than by the name of a kind of card: the comment an
// event added to a card, and the cards in the order the conversation lists them.

import { boardCardKinds, cardOf, cardsOfKind, eventCards, type BoardCard } from './cards';
import type { Board, BoardEvent, Comment } from './types';

// The comment an event added, found through the cards the event names (cards.ts `eventCards`): one event about a card can
// name others it links (a task's names the decision it answers), so each is tried in turn. The first card the event names
// that has a comment `matches` accepts, with that comment. None when the event names no card, or when none of the cards it
// names (one since deleted) holds one: `eventCard(event)` tells those apart.
export function eventCardComment(event: BoardEvent, board: Board, matches: (comment: Comment) => boolean): { card: BoardCard; comment: Comment } | undefined {
  for (const { kind, id } of eventCards(event)) {
    const card = cardOf(board, kind, id);
    const comment = card?.comments.find(matches);
    if (card && comment) return { card, comment };
  }
  return undefined;
}

// Every card on the board, the kind registered last first: the order the conversation lists them in (a task's discussion before a
// decision's), which a chat's items written at the same moment and the lines of a digest show.
export const cardsLastKindFirst = (board: Board): BoardCard[] => [...boardCardKinds()].reverse().flatMap(({ kind }) => cardsOfKind(board, kind));
