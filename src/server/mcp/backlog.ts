// Backlog visibility is decided before MCP renders any content. The browser
// and REST still read the whole board; a person's assignment or any direct mention makes
// a backlog task visible to the named agents, and ready tasks are visible as usual.
import { backlogAgents } from '../../core/firstLook';
import { samePerson } from '../../core/format';
import type { Store } from '../../core/store';
import type { Actor, Board, BoardEvent, Canvas, Task, ThreadRef } from '../../core/types';

export function taskVisible(board: Board, task: Task, agent: string): boolean {
  return task.status !== 'backlog' || backlogAgents(board, task, agent).some((name) => samePerson(name, agent));
}

export function agentCanvas(board: Board, canvas: Canvas, agent: string): Canvas {
  const pins = canvas.pins.filter((pin) => !pin.taskId || !board.tasks.some((task) => task.id === pin.taskId && !taskVisible(board, task, agent)));
  return pins.length === canvas.pins.length ? canvas : { ...canvas, pins };
}

export function agentBoard(board: Board, agent: string): Board {
  const tasks = board.tasks.filter((task) => taskVisible(board, task, agent));
  if (tasks.length === board.tasks.length) return board;
  const hidden = new Set(board.tasks.filter((task) => !taskVisible(board, task, agent)).flatMap((task) => [task.id, ...task.canvas.blocks.map((b) => b.id), ...task.canvas.pins.map((p) => p.id)]));
  const visibleRef = (ref: ThreadRef) => !hidden.has(ref.id) && (!ref.on || !hidden.has(ref.on));
  return {
    ...board,
    tasks: tasks.map((task) => ({ ...task, canvas: agentCanvas(board, task.canvas, agent) })),
    canvas: agentCanvas(board, board.canvas, agent),
    decisions: board.decisions.map((decision) => ({ ...decision, canvas: agentCanvas(board, decision.canvas, agent) })),
    threads: board.threads?.map((thread) => ({
      ...thread,
      pending: thread.pending?.filter(visibleRef),
      messages: thread.messages.map((message) => ({ ...message, refs: message.refs?.filter(visibleRef) })),
    })),
    deleted: board.deleted?.filter((item) => !item.on.taskId || !hidden.has(item.on.taskId)),
  };
}

// Only leave eyes on comments that reached the agent. With no events, this
// keeps get_board's usual behavior: just the requests its digest quotes.
export function seeBoardComments(store: Store, board: Board, actor: Actor, events?: BoardEvent[]): void {
  const view = agentBoard(board, actor.name);
  const comments = new Set([
    ...view.tasks.flatMap((task) => task.comments.map((comment) => comment.id)),
    ...view.decisions.flatMap((decision) => decision.comments.map((comment) => comment.id)),
    ...(view.threads ?? []).flatMap((thread) => thread.messages.map((message) => message.id)),
    ...[view.canvas, ...view.tasks.map((task) => task.canvas), ...view.decisions.map((decision) => decision.canvas)]
      .flatMap((canvas) => canvas.pins.flatMap((pin) => (pin.discussion?.thread ?? []).map((comment) => comment.id))),
  ]);
  store.seeComments(board.id, actor, events, (item) => comments.has(item.id));
}

// Check all explicit task/canvas targets before a handler reads or changes
// them, and before presence marks the agent as looking at the card.
export function hiddenBacklogTarget(store: Store, args: Record<string, unknown>, agent: string): boolean {
  const ids = ['task_id', 'block_id', 'from_block_id', 'to_block_id', 'pin_id', 'group_id', 'id'];
  for (const key of ids) {
    const id = args[key];
    if (typeof id !== 'string') continue;
    try {
      if (key === 'task_id') {
        const { board, task } = store.getTask(id);
        if (!taskVisible(board, task, agent)) return true;
      } else {
        const { board, task, canvas } = store.canvasOf(id);
        if (task && !taskVisible(board, task, agent)) return true;
        const target = canvas.pins.find((pin) => pin.id === id)?.taskId;
        if (target && board.tasks.some((item) => item.id === target && !taskVisible(board, item, agent))) return true;
      }
    } catch {
      // Removed canvas items are no longer indexed, but restoring one must
      // respect its task's visibility too.
      if (key === 'id') {
        for (const summary of store.listBoards()) {
          const board = store.getBoard(summary.id);
          const removed = board.deleted?.find((item) => item.id === id);
          if (!removed) continue;
          const targets = [removed.on.taskId, ...(removed.kept?.pins ?? []).map((pin) => pin.taskId)];
          if (board.tasks.some((task) => targets.includes(task.id) && !taskVisible(board, task, agent))) return true;
        }
      }
      // The handler reports other missing or invalid ids in its usual way.
    }
  }
  return false;
}
