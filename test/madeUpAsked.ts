// Two made-up kinds of card for a shared test whose boards hold cards the core reads by their kind (core/cards.ts): a thread's
// work, the cards a request names, the number a reply writes a card by. They are named `decision` and `task` and marked `#` and
// `T`, as the data of such a test is, but say nothing of a part's: a decision can be asked for (a request of kind `decision`),
// a task can be asked for as `tasks`, and each says its words as plain ones. Register them in the test's setup, as
// `useBoardCards(askableCards())`; a test of a part's own words registers its own in one of its test files.

import { boardCardKind, type BoardCardKind } from '../src/core/cards';
import type { CardAsk } from '../src/core/askedCards';
import { emptyCanvas } from '../src/core/canvas';
import type { Actor, Comment } from '../src/core/types';

interface Card {
  id: string;
  number: number;
  title?: string;
  status?: string;
  comments: Comment[];
  createdBy: Actor;
  fromThread?: { id: string; title: string };
}

const asks = (kind: string, word: string): CardAsk => ({
  kind,
  asked: `Make ${word}`,
  left: `They left ${word} to you.`,
  said: (text) => `They said: "${text}".`,
  about: (blocks, on) => ` for ${word} about ${blocks}${on}`,
  answerHow: (boardId, requestId) => `make ${word} for request ${requestId} on ${boardId}.`,
  unmet: (by, boardId, requestId) => `${by} asked for ${word}: make it for request ${requestId} on ${boardId}.`,
  made: 'Made',
  noun: word,
  tool: `make_${kind}`,
});

const kindOf = (kind: string, list: string, mark: string, request: string, event: string): BoardCardKind =>
  boardCardKind<Card>({
    kind,
    list,
    mark,
    number: (card) => card.number,
    title: (card) => card.title ?? '',
    comments: (card) => card.comments,
    canvas: () => emptyCanvas(),
    status: (card) => card.status ?? 'open',
    setFromThread: (card, from) => {
      card.fromThread = from;
    },
    postedIn: event,
    heights: (_cards, named) => (named ? [named * 40] : []),
    asked: asks(request, kind),
    fromThread: (card) => card.fromThread,
    createdBy: (card) => card.createdBy,
  });

export const askableCards = (): BoardCardKind[] => [kindOf('decision', 'decisions', '#', 'decision', 'decision_posted'), kindOf('task', 'tasks', 'T', 'tasks', 'task_planned')];
