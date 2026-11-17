import { emptyCanvas } from '../src/core/canvas';
import type { Actor, Board, Canvas, Comment } from '../src/core/types';

// A decision and a task written out by hand, for the pages that must show a board they have no kind of card for: the
// public core cannot make them (the Store's methods for them are a part's), but a board's JSON can hold them, and a page
// without their kinds must draw nothing of them and throw nothing.
const at = '2026-11-14T10:00:00.000Z';

// Their shape, written here: the public core's types hold no decision or task (a part's types add them), and a test of the
// pages never needs more than the fields a stored board carries. Each is structurally a part's own `Decision` and `Task`.
export interface HandWrittenDecision {
  id: string;
  number: number;
  boardId: string;
  question: string;
  options: { id: string; label: string; proposedBy: Actor; createdAt: string }[];
  status: 'open';
  blocking: false;
  dependsOn: string[];
  history: never[];
  asks: never[];
  criteria: never[];
  marks: never[];
  comments: Comment[];
  findings: never[];
  canvas: Canvas;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
}

export interface HandWrittenTask {
  id: string;
  number: number;
  title: string;
  decisionIds: string[];
  status: 'todo';
  links: string[];
  notes: never[];
  comments: Comment[];
  canvas: Canvas;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
}

export function handWrittenDecision(boardId: string, id: string, number: number, question: string, by: Actor): HandWrittenDecision {
  return {
    id,
    number,
    boardId,
    question,
    options: ['Stripe', 'Adyen'].map((label, index) => ({ id: String.fromCharCode(97 + index), label, proposedBy: by, createdAt: at })),
    status: 'open',
    blocking: false,
    dependsOn: [],
    history: [],
    asks: [],
    criteria: [],
    marks: [],
    comments: [],
    findings: [],
    canvas: emptyCanvas(),
    createdBy: by,
    createdAt: at,
    updatedAt: at,
  };
}

export function handWrittenTask(id: string, number: number, title: string, by: Actor, decisionIds: string[] = []): HandWrittenTask {
  return { id, number, title, decisionIds, status: 'todo', links: [], notes: [], comments: [], canvas: emptyCanvas(), createdBy: by, createdAt: at, updatedAt: at };
}

// The board with one of each added to its lists, as a stored board holds them.
export function withHandWrittenCards(board: Board, by: Actor): { board: Board; decision: HandWrittenDecision; task: HandWrittenTask } {
  const decision = handWrittenDecision(board.id, 'decision-1', 1, 'Which provider?', by);
  const task = handWrittenTask('task-1', 1, 'Wire up Stripe', by, [decision.id]);
  const lists = board as unknown as { decisions?: HandWrittenDecision[]; tasks?: HandWrittenTask[] };
  return { board: { ...board, decisions: [...(lists.decisions ?? []), decision], tasks: [...(lists.tasks ?? []), task] } as Board, decision, task };
}
