// Which piece of work a change to a canvas belongs to, so what tells a person what is new can say a run of changes once:
// an agent that adds 13 images and a diff on a Sketchbook page while answering a thread did one thing, not 14. The log
// keeps every change as it was (a `canvas_changed` event for each block or group, store/repository.ts recordCanvas);
// this only reads which of them go together, and nothing new is recorded for it.
//
// A change belongs to:
// - the thread it was made for: the one whose work shows the block (as threads.ts showsWork reads it: the agent passed
//   its id), or, for a group, the thread whose group it is or whose work shows a block in it. By the thread's bare id,
//   as the thread's own events are, so the changes and the thread's reply are news together;
// - else the card whose canvas it is on, by the card's id, as the card's own events are (cards.ts eventCardsLeading);
// - else the Sketchbook page it is on and who changed it, in a run with no pause longer than GAP_MS (agentActivity.ts,
//   one stretch of work), and the board context and who changed it the same way;
// - a block or group gone since, which none of these finds, is its own, by its id.
// A change to a pin's comment thread (resolving it) belongs to none: it goes with the thread's comments, by the pin's id.
//
// A board is read once for many changes (canvasHoldings): one with hundreds of threads and pages is read again on
// each change to it while agents work.

import { GAP_MS } from './agentActivity';
import { kindOf } from './blocks/registry';
import { cardOwning, eventCardsLeading, type EventCard } from './cards';
import { listNames } from './format';
import { canvasesOf, threadCanvases, type OwnedCanvas } from './pins';
import { pageName } from './scratchPad';
import type { Actor, Block, Board, BoardEvent, Canvas, Group, ScratchPage, Thread } from './types';

export interface CanvasBatch {
  key: string; // the same for every change of the piece of work: a thread's id, a card's, or a run's own
  thread?: Thread; // made for it
  card?: EventCard; // on its canvas
  page?: ScratchPage; // a run on this Sketchbook page
  context?: true; // a run on the board context
}

// What a board's canvases hold, as the changes are read against it: the canvas each item is on, each block and
// group, the pins that hold a comment thread, and what each thread made.
export interface CanvasHoldings {
  canvasOf: Map<string, OwnedCanvas>; // by a block's, group's, link's or pin's id, and a page's own
  items: Map<string, Block | Group>;
  groupBlocks: Map<string, Block[]>; // the blocks in each group
  threadPins: Set<string>; // the pins with a comment thread, on the board context or a page
  blockThreads: Map<string, Thread>; // the first thread whose work shows a block: its messages' refs and pending
  groupThreads: Map<string, Thread>; // the first thread whose group it is (Thread.groupId)
  order: Map<Thread, number>; // the threads in the board's order: the first that made a change takes it
}

export function canvasHoldings(board: Board): CanvasHoldings {
  const held: CanvasHoldings = {
    canvasOf: new Map(),
    items: new Map(),
    groupBlocks: new Map(),
    threadPins: new Set(),
    blockThreads: new Map(),
    groupThreads: new Map(),
    order: new Map(),
  };
  const first = <V>(map: Map<string, V>, id: string, value: V) => map.has(id) || map.set(id, value);
  for (const on of canvasesOf(board)) {
    if (on.page) first(held.canvasOf, on.page.id, on);
    for (const items of [on.canvas.blocks, on.canvas.groups, on.canvas.links, on.canvas.pins]) for (const item of items) first(held.canvasOf, item.id, on);
    for (const item of [...on.canvas.blocks, ...on.canvas.groups]) first(held.items, item.id, item);
    for (const block of on.canvas.blocks) {
      if (!block.groupId) continue;
      const inGroup = held.groupBlocks.get(block.groupId);
      if (inGroup) inGroup.push(block);
      else held.groupBlocks.set(block.groupId, [block]);
    }
  }
  for (const { canvas } of threadCanvases(board)) for (const pin of canvas.pins) if (pin.discussion?.thread) held.threadPins.add(pin.id);
  for (const [index, thread] of (board.threads ?? []).entries()) {
    held.order.set(thread, index);
    if (thread.groupId) first(held.groupThreads, thread.groupId, thread);
    const refs = [...thread.messages.flatMap((m) => m.refs ?? []), ...(thread.pending ?? [])];
    for (const ref of refs) if (ref.kind === 'block') first(held.blockThreads, ref.id, thread);
  }
  return held;
}

// The piece of work each change among `events` belongs to, by the change's seq. Only canvas changes have one.
export function canvasBatches(held: CanvasHoldings, events: BoardEvent[]): Map<number, CanvasBatch> {
  const batches = new Map<number, CanvasBatch>();
  // The run going on in each place, for each actor: its batch and when it last changed.
  const runs = new Map<string, { batch: CanvasBatch; last: number }>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.type !== 'canvas_changed' || !event.itemId) continue;
    const id = event.itemId;
    if (held.threadPins.has(id)) continue;
    const thread = threadFor(held, id);
    if (thread) {
      batches.set(event.seq, { key: thread.id, thread });
      continue;
    }
    const on = held.canvasOf.get(id);
    const owner = on && cardOwning(on);
    const card = eventCardsLeading(event)[0] ?? (owner && { kind: owner.kind.kind, id: owner.id });
    if (card) {
      batches.set(event.seq, { key: card.id, card });
      continue;
    }
    if (!on) {
      batches.set(event.seq, { key: id });
      continue;
    }
    const place = on.page ? `page:${on.page.id}` : 'context';
    const run = `${place}|${actorKey(event.actor)}`;
    const at = Date.parse(event.at);
    const open = runs.get(run);
    if (open && at - open.last <= GAP_MS) {
      open.last = at;
      batches.set(event.seq, open.batch);
      continue;
    }
    const batch: CanvasBatch = { key: `${run}|${event.seq}`, ...(on.page ? { page: on.page } : { context: true as const }) };
    runs.set(run, { batch, last: at });
    batches.set(event.seq, batch);
  }
  return batches;
}

// What a piece of work did on the canvases, in a few words, as the threads list says what a thread made (threadList.ts
// madeInWords): "added 13 images and a diff", "added a note, changed 2 tables", with `where` "… on Sketchbook page "Mood
// board"" when it is all on one canvas. Each block or group once, by its kind's word; one counts as added when it was
// made no earlier than its first change here. None when nothing it changed is still there.
export function batchWords(held: CanvasHoldings, events: BoardEvent[], { where = false }: { where?: boolean } = {}): string | undefined {
  const firsts = new Map<string, BoardEvent>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.type === 'canvas_changed' && event.itemId && !firsts.has(event.itemId)) firsts.set(event.itemId, event);
  }
  const added: string[] = [];
  const changed: string[] = [];
  const canvases = new Map<Canvas, OwnedCanvas>();
  for (const [id, first] of firsts) {
    const item = held.items.get(id);
    const on = held.canvasOf.get(id);
    if (!item || !on) continue;
    canvases.set(on.canvas, on);
    const word = 'type' in item ? kindWord(item) : 'group';
    (Date.parse(item.createdAt) >= Date.parse(first.at) - MADE_MS ? added : changed).push(word);
  }
  const words = [added.length ? `added ${counted(added)}` : '', changed.length ? `changed ${counted(changed)}` : ''].filter(Boolean).join(', ');
  if (!words) return undefined;
  const [on] = canvases.values();
  return where && canvases.size === 1 ? `${words} ${canvasWhere(on)}` : words;
}

// A block is made a moment before its change is logged.
const MADE_MS = 5_000;

const actorKey = (actor: Actor) => `${actor.kind}:${actor.name.trim().toLowerCase()}`;

// The thread a block or group was made for: the first, in the board's order, that shows the block, whose group it is,
// or that shows a block in the group. A block gone since is still found by the thread that shows it.
function threadFor(held: CanvasHoldings, id: string): Thread | undefined {
  const inGroup = held.canvasOf.has(id) ? (held.groupBlocks.get(id) ?? []) : [];
  let thread: Thread | undefined;
  for (const candidate of [held.blockThreads.get(id), held.groupThreads.get(id), ...inGroup.map((block) => held.blockThreads.get(block.id))]) {
    if (candidate && (!thread || held.order.get(candidate)! < held.order.get(thread)!)) thread = candidate;
  }
  return thread;
}

// Where a canvas is, as a sentence of the log says it (store/labels.ts where).
function canvasWhere(on: OwnedCanvas): string {
  const card = cardOwning(on);
  if (card) return `on the canvas of ${card.named}`;
  return on.page ? `on ${pageName(on.page)}` : 'in the board context';
}

// A block as a count names it: its kind's noun, else its label as a word ("image", "3D scene").
function kindWord(block: Block): string {
  const kind = kindOf(block.type);
  return kind.noun ?? kind.label.charAt(0).toLowerCase() + kind.label.slice(1);
}

// "13 images and a diff": each word with how many, the most first.
function counted(words: string[]): string {
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const some = ([word, n]: [string, number]) => (n === 1 ? `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}` : `${n} ${word}s`);
  return listNames([...counts].sort((a, b) => b[1] - a[1]).map(some));
}
