import type { Located } from './inputs';
import { blockLabel } from '../canvas';
import { cardOwning } from '../cards';
import { clip } from '../format';
import { pageName } from '../scratchPad';
import type { Block, Group } from '../types';

// A decision as a sentence names it: #12 "Which gateway?". The kinds of card a part adds say it (`named`).
export function label(decision: { number: number; question: string }): string {
  return `#${decision.number} "${clip(decision.question)}"`;
}

export function taskLabel(task: { number: number; title: string }): string {
  return `T${task.number} "${clip(task.title, 60)}"`;
}

// Where a canvas is, as a sentence of the log says it: a card's by the card's own name (cards.ts), a page's, the board context's.
export function where(located: Located): string {
  const card = cardOwning(located);
  if (card) return `on the canvas of ${card.named}`;
  if (located.page) return `on ${pageName(located.page)}`;
  return 'in the board context';
}

export function addedBlock(located: Located, block: Block): string {
  const group = located.canvas.groups.find((g) => g.id === block.groupId);
  const extras = [group && `in group "${clip(group.title, 40)}"`, block.optionId && `for option ${block.optionId}`].filter(Boolean);
  return `added ${blockLabel(block)} ${where(located)}${extras.length ? ` ${extras.join(' ')}` : ''}`;
}

export function addedGroup(located: Located, group: Group): string {
  return `added group "${clip(group.title, 50)}" ${where(located)}`;
}
