import { saying, type Piece, type Sayer } from '../../core/words';

// How a refusal ends: what the agent does when it needs a person to connect the service. The board's own comment is
// the way to ask; a tool group says its way of asking too (a part's ask_people), so a
// server with none names no tool it does not have.
export const askAPerson = (who: 'them' | 'a person', words?: Sayer): string => {
  const sentence: Piece[] = [
    ['ask', `Ask ${who} (comment`],
    ['ask-end', ") if you need it; don't retry until they have."],
  ];
  return saying(words, 'connector.ask', sentence);
};
