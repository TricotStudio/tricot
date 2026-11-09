import { BoardError } from './errors';
import type { PinPart } from './inputs';
import { label, taskLabel } from './labels';
import { kindOf } from '../blocks/registry';
import { partHooks, partOf } from '../parts';
import { blockLabel } from '../canvas';
import { pinPart, placePin } from '../pins';
import type { Block, Board, Pin, PinAnchor } from '../types';

// A pinned part and where it is: "the docs site" in note "Where we are";
// words in a Google Doc by the doc's name.
export function pinIn(pin: Pin, block: Block): string {
  return `${pinPart(pin, block)} in ${partOf(block, pin.anchor.kind)?.label?.(block, pin) ?? blockLabel(block)}`;
}

// Pins that were there and aren't any more, said as a change is.
export function lostPins(board: Board, block: Block, there: Pin[]): string[] {
  return there
    .filter((pin) => !placePin(block, pin))
    .map((pin) => `${pinPart(pin, block)}, ${pin.discussion ? 'commented on' : `pinned to ${pinRef(board, pin)}`}, is no longer there`);
}

// What a pin links to: T33, or with its title, T33 "Draft the docs".
export function pinRef(board: Board, pin: Pin, full = false): string {
  if (pin.discussion) return pin.discussion.thread ? 'a comment thread' : 'comments';
  const task = pin.taskId ? board.tasks.find((t) => t.id === pin.taskId) : undefined;
  if (task) return full ? taskLabel(task) : `T${task.number}`;
  const decision = board.decisions.find((d) => d.id === pin.decisionId);
  if (decision) return full ? label(decision) : `#${decision.number}`;
  return 'work that is gone';
}

// Turns the part someone pinned into an anchor that finds it again after
// edits, and the quote that shows it. Throws when the part isn't on the block.
// `pins` are the canvas's, which number boxes.
export function pinAnchor(block: Block, part: PinPart, pins: Pin[]): { anchor: PinAnchor; quote: string } {
  const kind = kindOf(block.type);
  if (part.kind === 'block') return { anchor: { kind: 'block' }, quote: block.title || kind.pins?.whole?.quote(block) || blockLabel(block) };
  const found = kind.pins?.anchor?.(block, part, pins);
  if (found) return found;
  // A block that isn't a kind that has the part: the part's own words say which have it.
  const say = partHooks(part.kind)?.missing;
  throw new BoardError(say ? say(block) : `Unknown kind of pin "${part.kind}".`);
}
