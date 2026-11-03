// Checklist blocks became notes with task lists (#83): one kind of block for
// both, its ticks in the note's Markdown. This moves what was saved as a
// checklist over, once: from the database (the data migration "checklists
// become notes") and from board files an earlier Tricot left (the JSON import).
// A block keeps its id, title, place and rev; each of its versions becomes the
// note it showed; a pin on an item, or on words in one, moves to the same words
// on that item's line, and keeps its id, so the comments that carry it stay
// with it. A pin whose item is gone pins the whole note instead.
//
// It reads the data as it was saved, so it is written against plain JSON and
// not the board's types, which have no checklists any more.

import type { Database } from './sqlite';
import { findQuote, findWords, inlineText, noteText, quoteAt } from '../pins';
import { tasksMarkdown, taskWords } from '../taskList';

type Json = Record<string, unknown>;

interface Item {
  id: string;
  text: string;
  done: boolean;
}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export const isChecklist = (value: unknown): value is Json => isObject(value) && value.type === 'checklist';

function itemsOf(checklist: Json): Item[] {
  if (!Array.isArray(checklist.items)) return [];
  return checklist.items.filter(isObject).map((item) => ({ id: String(item.id ?? ''), text: String(item.text ?? ''), done: item.done === true }));
}

// A checklist's items as a note's Markdown: "- [x] Ship" a line each.
export const checklistText = (checklist: Json): string => tasksMarkdown(itemsOf(checklist));

// A checklist block, or a version of one, as the note it is now: its items a
// task list, all else as it was.
export function asNote(checklist: Json): Json {
  const { items: _items, ...rest } = checklist;
  return { ...rest, type: 'note', text: checklistText(checklist) };
}

// Where a pin was in its checklist, as the checklist found it: the item (its
// index), and the words in it unless the pin is on the whole item.
function placeInChecklist(items: Item[], pin: Json, anchor: Json): { index: number; words: boolean } | null {
  const quote = String(pin.quote ?? '');
  if (anchor.kind === 'item') {
    const index = items.findIndex((i) => i.id === anchor.itemId);
    const found = index !== -1 ? index : items.findIndex((i) => i.text === quote);
    return found === -1 ? null : { index: found, words: false };
  }
  const around = { prefix: String(anchor.prefix ?? ''), suffix: String(anchor.suffix ?? '') };
  // Words in an item as it reads: its own first; failing that, reworded into another.
  const order = items.map((item, index) => ({ item, index })).sort((a, b) => Number(b.item.id === anchor.itemId) - Number(a.item.id === anchor.itemId));
  for (const { item, index } of order) if (findWords(inlineText(item.text), quote, around)) return { index, words: true };
  // Words pinned when items showed their Markdown, across some that no longer
  // shows (half a link): still in their item, which is what they pin now.
  const own = items.findIndex((i) => i.id === anchor.itemId);
  return own !== -1 && findQuote(items[own].text, quote, around) ? { index: own, words: false } : null;
}

// A pin on a checklist, on the note it became: on the same words, or the
// whole of the item's line, found by the text around them as a note's pins
// are. Null when its item is gone.
function placeOnNote(items: Item[], pin: Json, anchor: Json): { anchor: Json; quote: string } | null {
  const placed = placeInChecklist(items, pin, anchor);
  if (!placed) return null;
  const markdown = tasksMarkdown(items);
  const reads = noteText(markdown);
  const line = taskWords(markdown, placed.index + 1);
  if (!line) return null;
  const own = reads.slice(line.start, line.end);
  const around = { prefix: String(anchor.prefix ?? ''), suffix: String(anchor.suffix ?? '') };
  const words = placed.words ? findWords(own, String(pin.quote ?? ''), around) : null;
  const at = words ?? { start: 0, end: own.length };
  const quoted = quoteAt(reads, line.start + at.start, line.start + at.end);
  if (!quoted) return null;
  // Words keep the quote they were pinned with; a whole item reads as its line.
  const quote = words ? String(pin.quote) : quoted.quote;
  const moved = { kind: 'text', prefix: quoted.prefix, suffix: quoted.suffix };
  return findWords(reads, quote, moved) ? { anchor: moved, quote } : null;
}

// Whether a pin is on part of a checklist: an item, or words in one.
const onChecklistPart = (pin: Json, checklist: Json | undefined): boolean => {
  const anchor = pin.anchor;
  if (!isObject(anchor)) return false;
  return anchor.kind === 'item' || (anchor.kind === 'text' && (anchor.itemId !== undefined || checklist !== undefined));
};

// A pin as it is on the note its checklist became. Only pins on an item or on
// words in one change; one that can't be placed pins the whole note, keeping
// its quote, so the comments on it stay with the note rather than going.
export function pinOnNote(pin: Json, checklist: Json | undefined): Json {
  if (!onChecklistPart(pin, checklist)) return pin;
  const moved = checklist && placeOnNote(itemsOf(checklist), pin, pin.anchor as Json);
  return moved ? { ...pin, ...moved } : { ...pin, anchor: { kind: 'block' } };
}

// ---- in the database ------------------------------------------------------------

interface Row {
  board: string;
  owner: string;
  kind: string;
  id: string;
  body: string;
}

interface Kept {
  block?: Json;
  pins?: Json[];
  versions?: Json[];
}

// Every checklist a board's rows hold, on a canvas or kept by a deletion, and
// every pin on one, become notes and pins on them. The versions in their table follow.
export function moveChecklistRows(db: Database): void {
  const update = db.prepare('UPDATE items SET body = ? WHERE board = ? AND owner = ? AND kind = ? AND id = ?');
  const rows = (sql: string) => db.prepare(sql).all() as unknown as Row[];
  const blocks = rows(`SELECT board, owner, kind, id, body FROM items WHERE kind = 'block' AND json_extract(body, '$.type') = 'checklist'`);
  const deletions = rows(`SELECT board, owner, kind, id, body FROM items WHERE kind = 'deletion'`).map((row) => ({ row, body: JSON.parse(row.body) as Json }));

  // The checklists as they were, by board and id: on a canvas, else as a deletion keeps one.
  const key = (board: string, id: unknown) => `${board}\0${String(id)}`;
  const checklists = new Map<string, Json>();
  for (const { row, body } of deletions) {
    const block = (body.kept as Kept | undefined)?.block;
    if (isChecklist(block)) checklists.set(key(row.board, block.id), block);
  }
  for (const row of blocks) checklists.set(key(row.board, row.id), JSON.parse(row.body) as Json);

  const pins = rows(`SELECT board, owner, kind, id, body FROM items WHERE kind = 'pin' AND json_extract(body, '$.anchor.kind') IN ('item', 'text')`);
  for (const row of pins) {
    const pin = JSON.parse(row.body) as Json;
    const checklist = checklists.get(key(row.board, pin.blockId));
    if (!onChecklistPart(pin, checklist)) continue;
    update.run(JSON.stringify(pinOnNote(pin, checklist)), row.board, row.owner, row.kind, row.id);
  }
  for (const row of blocks) update.run(JSON.stringify(asNote(JSON.parse(row.body) as Json)), row.board, row.owner, row.kind, row.id);
  for (const { row, body } of deletions) {
    const kept = body.kept as Kept | undefined;
    if (!kept || !keptChecklists(kept, (id) => checklists.get(key(row.board, id)))) continue;
    update.run(JSON.stringify(body), row.board, row.owner, row.kind, row.id);
  }

  const versions = db.prepare(`SELECT board, block, rev, body FROM block_versions WHERE json_extract(body, '$.type') = 'checklist'`).all() as unknown as {
    board: string;
    block: string;
    rev: number;
    body: string;
  }[];
  const putVersion = db.prepare('UPDATE block_versions SET body = ? WHERE board = ? AND block = ? AND rev = ?');
  for (const v of versions) putVersion.run(JSON.stringify(asNote(JSON.parse(v.body) as Json)), v.board, v.block, v.rev);
}

// What a deletion keeps, moved over in place: a removed checklist, the pins
// on one, and versions deleted from one. `checklist` finds a block by id,
// for a pin whose block is still on its canvas. Says whether it changed anything.
function keptChecklists(kept: Kept, checklist: (id: unknown) => Json | undefined): boolean {
  let changed = false;
  const own = isChecklist(kept.block) ? kept.block : undefined;
  if (Array.isArray(kept.pins)) {
    kept.pins = kept.pins.map((pin) => {
      const on = own && pin.blockId === own.id ? own : checklist(pin.blockId);
      if (!onChecklistPart(pin, on)) return pin;
      changed = true;
      return pinOnNote(pin, on);
    });
  }
  if (own) {
    kept.block = asNote(own);
    changed = true;
  }
  if (Array.isArray(kept.versions) && kept.versions.some(isChecklist)) {
    kept.versions = kept.versions.map((v) => (isChecklist(v) ? asNote(v) : v));
    changed = true;
  }
  return changed;
}

// ---- in a board file --------------------------------------------------------------

type BoardLike = { canvas?: Json; decisions?: { canvas?: Json }[]; tasks?: { canvas?: Json }[]; deleted?: { kept?: Kept }[] };
type VersionsLike = { op: string; versions?: Json[] }[];

// A board as an earlier Tricot saved it, with its blocks' versions apart
// (legacyBoard.ts), moved over in place.
export function boardChecklistsToNotes(saved: unknown, changes: readonly unknown[]): void {
  const board = saved as BoardLike;
  const versions = changes as VersionsLike;
  const canvases = [board.canvas, ...(board.decisions ?? []).map((d) => d.canvas), ...(board.tasks ?? []).map((t) => t.canvas)].filter(isObject);
  const blocksOf = (canvas: Json) => (Array.isArray(canvas.blocks) ? (canvas.blocks as Json[]) : []);
  const checklists = new Map<unknown, Json>();
  for (const deletion of board.deleted ?? []) if (isChecklist(deletion.kept?.block)) checklists.set(deletion.kept.block.id, deletion.kept.block);
  for (const canvas of canvases) for (const block of blocksOf(canvas)) if (isChecklist(block)) checklists.set(block.id, block);

  for (const canvas of canvases) {
    if (Array.isArray(canvas.pins)) canvas.pins = (canvas.pins as Json[]).map((pin) => pinOnNote(pin, checklists.get(pin.blockId)));
    if (Array.isArray(canvas.blocks)) canvas.blocks = blocksOf(canvas).map((block) => (isChecklist(block) ? asNote(block) : block));
  }
  for (const deletion of board.deleted ?? []) if (deletion.kept) keptChecklists(deletion.kept, (id) => checklists.get(id));
  for (const change of versions) {
    if (change.op === 'add' && Array.isArray(change.versions)) change.versions = change.versions.map((v) => (isChecklist(v) ? asNote(v) : v));
  }
}
