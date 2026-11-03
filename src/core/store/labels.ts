import type { Located } from './inputs';
import { blockLabel } from '../canvas';
import { deletedCard } from '../cardLinks';
import { clip } from '../format';
import type { Block, Board, Decision, Group, Task } from '../types';

export function label(decision: Decision): string {
  return `#${decision.number} "${clip(decision.question)}"`;
}

export function taskLabel(task: Task): string {
  return `T${task.number} "${clip(task.title, 60)}"`;
}

export function where(located: Located): string {
  if (located.task) return `on the canvas of ${taskLabel(located.task)}`;
  return located.decision ? `on the canvas of ${label(located.decision)}` : 'in the board context';
}

export function addedBlock(located: Located, block: Block): string {
  const group = located.canvas.groups.find((g) => g.id === block.groupId);
  const extras = [group && `in group "${clip(group.title, 40)}"`, block.optionId && `for option ${block.optionId}`].filter(Boolean);
  return `added ${blockLabel(block)} ${where(located)}${extras.length ? ` ${extras.join(' ')}` : ''}`;
}

export function addedGroup(located: Located, group: Group): string {
  return `added group "${clip(group.title, 50)}" ${where(located)}`;
}

// A deleted decision is named by the number it had.
export function decisionRefs(board: Board, ids: string[]): string {
  return ids.map((id) => `#${board.decisions.find((d) => d.id === id)?.number ?? deletedCard(board, id)?.number ?? '?'}`).join(', ');
}
