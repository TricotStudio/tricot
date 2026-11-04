import { BoardError } from './errors';
import type { PinPart } from './inputs';
import { label, taskLabel } from './labels';
import { blockIs } from '../blocks/shared';
import { kindOf } from '../blocks/registry';
import { partOf, partWords } from '../parts';
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

// Whether two anchors pin the same part. A box or a spot is the same whatever
// number it would be given; a website's element is its page's element,
// whatever it reads or wherever its file has it now.
export function samePart(a: PinAnchor, b: PinAnchor): boolean {
  if (a.kind === 'site' && b.kind === 'site') return a.page === b.page && a.selector === b.selector;
  if (a.kind === 'box' && b.kind === 'box') return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  if (a.kind === 'spot' && b.kind === 'spot') return a.x === b.x && a.y === b.y && a.z === b.z && a.name === b.name; // whatever it was seen from
  return JSON.stringify(a) === JSON.stringify(b);
}

// What a part says when its block isn't a kind that has it. A kind that has
// the part makes its anchor (kind.pins.anchor); these are the words for the
// parts there are, which a new kind of part adds to. A connector's parts
// (a Google Doc's paragraphs) say it themselves (connector.pins.missing).
const NOT_HERE: Partial<Record<PinPart['kind'], (block: Block) => string>> = {
  text: (block) => `Words are pinned in notes; ${blockIs(block)}.`,
  cells: (block) => `Only tables have cells; ${blockIs(block)}.`,
  box: (block) => `Boxes are drawn on images; ${blockIs(block)}.`,
  node: (block) => `Only diagrams have nodes and arrows; ${blockIs(block)}.`,
  arrow: (block) => `Only diagrams have nodes and arrows; ${blockIs(block)}.`,
  line: (block) => `Lines are pinned in diffs and code blocks; ${blockIs(block)}.`,
  point: (block) => `Points are pinned in charts; ${blockIs(block)}.`,
  spot: (block) => `Spots are pinned on 3D scenes; ${blockIs(block)}.`,
  site: (block) => `Elements are pinned on websites; ${blockIs(block)}.`,
  block: () => '',
};

// Turns the part someone pinned into an anchor that finds it again after
// edits, and the quote that shows it. Throws when the part isn't on the block.
// `pins` are the canvas's, which number boxes.
export function pinAnchor(block: Block, part: PinPart, pins: Pin[]): { anchor: PinAnchor; quote: string } {
  const kind = kindOf(block.type);
  if (part.kind === 'block') return { anchor: { kind: 'block' }, quote: block.title || kind.pins?.whole?.quote(block) || blockLabel(block) };
  const found = kind.pins?.anchor?.(block, part, pins);
  if (found) return found;
  const say = NOT_HERE[part.kind] ?? partWords(part.kind)?.missing;
  throw new BoardError(say ? say(block) : `Unknown kind of pin "${(part as { kind: string }).kind}".`);
}
