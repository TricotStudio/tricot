// A card a person deleted for good, as a board remembers it (`deletedCards`): what the store says of it to whoever still
// holds its id. It names no kind of card: the label (T12, #8) is the kind's to give, and a part's cards give theirs
// through the store's owners (store/storePart.ts); cardLinks.ts is where a deletion is worked out.

import type { Board, DeletedCard } from './types';

// The deleted card a board remembers by this id.
export function deletedCard(board: Pick<Board, 'deletedCards'>, id: string): DeletedCard | undefined {
  return board.deletedCards?.find((c) => c.id === id);
}

// A deleted card as agents read of it, when they ask for it by id. `label` is how the card read: T12 or #8.
export function deletedCardLine(card: DeletedCard, label: string): string {
  return `${label} was a ${card.kind} ${card.by.name} deleted at ${card.at}. It's gone for good, with its canvas and discussion; nothing of it can be read or restored.`;
}
