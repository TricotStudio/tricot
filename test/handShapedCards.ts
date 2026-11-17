// Kinds of card for a shared test whose board is written by hand in the shape of a part's kinds of card (an object with an
// id, a number, a title or question and comments), since the readers of a board's cards find none until a kind is registered
// (core/cards.ts) and the core has no default. The names are the ones the fixtures use for the cards they hold, `decision`
// and `task`, and a task waits in the backlog and has an agent that follows it as a part's does (held to it by a part's own test). A test that wants a part's own kinds is one of its tests and registers those.

import { boardCardKind, useBoardCards, type BoardCardKind } from '../src/core/cards';
import { emptyCanvas } from '../src/core/canvas';
import type { Actor, Comment } from '../src/core/types';

interface Shaped {
  id: string;
  number: number;
  title?: string;
  question?: string;
  status?: string;
  comments: Comment[];
  createdBy?: Actor;
  fromThread?: { id: string; title: string };
  canvas?: ReturnType<typeof emptyCanvas>;
}

// What a task of a part's holds that the kinds below read: who works on it, and the agent it is for.
interface TaskShaped {
  status?: string;
  claimedBy?: Actor;
  assignee?: string;
}

const shaped = (kind: string, list: string, mark: string, more: Partial<BoardCardKind<Shaped>> = {}): BoardCardKind =>
  boardCardKind<Shaped>({
    kind,
    list,
    mark,
    number: (card) => card.number,
    title: (card) => card.title ?? card.question ?? '',
    comments: (card) => card.comments,
    canvas: (card) => card.canvas ?? emptyCanvas(),
    status: (card) => card.status as string,
    fromThread: (card) => card.fromThread,
    createdBy: (card) => card.createdBy as Actor,
    ...more,
  });

export const handShapedCards = (): BoardCardKind[] => [
  shaped('decision', 'decisions', '#'),
  shaped('task', 'tasks', 'T', {
    backlog: (card) => card.status === 'backlog',
    workedBy: (card) => ((card as TaskShaped).status === 'in_progress' ? (card as TaskShaped).claimedBy : undefined),
    followedBy: (card) => {
      const { assignee, claimedBy, status } = card as TaskShaped;
      return assignee || (claimedBy?.kind === 'agent' && status !== 'todo' ? claimedBy.name : undefined);
    },
  }),
];

// Registers them for the process, as a test file's setup does; it returns what puts back the kinds there were.
export const useHandShapedCards = (): (() => void) => useBoardCards(handShapedCards());
