// Pins: precise parts of blocks linked to tasks and decisions. Shared by the
// server, which checks them and describes them to agents, and the web UI,
// which draws them.

import { kindOf } from './blocks/registry';
import type { PartLike } from './blocks/kind';
import type { DiffSide } from './blocks/diff/diff';
import { partHooks } from './parts';
import type { Block, Board, Canvas, Comment, Decision, Pin, PinAnchor, Task, TaskStatus } from './types';

type BoxAnchor = Extract<PinAnchor, { kind: 'box' }>;
type SpotAnchor = Extract<PinAnchor, { kind: 'spot' }>;

// How much text either side of pinned words is kept to find them again.
const CONTEXT = 32;

// Characters that are Markdown syntax as often as text. Pinned words are
// compared without them and with whitespace collapsed, so words a person
// selected on a rendered note still match the note's Markdown.
const MARKUP = new Set(['*', '_', '`', '~']);

// `text` as it is compared, and where each of its characters came from.
function loosen(text: string): { text: string; from: number[] } {
  let out = '';
  const from: number[] = [];
  let space = true; // leading whitespace is dropped
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (MARKUP.has(ch)) continue;
    const blank = /\s/.test(ch);
    if (blank && space) continue;
    space = blank;
    out += blank ? ' ' : ch;
    from.push(i);
  }
  return { text: out, from };
}

function sharedEnd(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function sharedStart(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

// Pinned words as they are stored and shown: on one line, trimmed.
export function cleanQuote(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// Finds pinned words in `text`: the given occurrence of the quote, or else
// the one whose surroundings best match those it was pinned with. Returns
// offsets in `text`, or null when the words aren't there any more.
export function findQuote(
  text: string,
  quote: string,
  around: { prefix?: string; suffix?: string; occurrence?: number } = {},
): { start: number; end: number } | null {
  const needle = loosen(quote).text.trim();
  if (!needle) return null;
  const hay = loosen(text);
  const { prefix = '', suffix = '', occurrence } = around;
  let best: { at: number; score: number } | null = null;
  let seen = 0; // occurrences passed, when looking for a given one
  for (let at = hay.text.indexOf(needle); at !== -1; at = hay.text.indexOf(needle, at + 1)) {
    if (occurrence !== undefined) {
      if (++seen < occurrence) continue;
      best = { at, score: 0 };
      break;
    }
    const before = hay.text.slice(Math.max(0, at - CONTEXT), at);
    const after = hay.text.slice(at + needle.length, at + needle.length + CONTEXT);
    const score = sharedEnd(before, prefix) + sharedStart(after, suffix);
    if (!best || score > best.score) best = { at, score };
  }
  if (!best) return null;
  return { start: hay.from[best.at], end: hay.from[best.at + needle.length - 1] + 1 };
}

// The words at [start, end) of `text`, with the text either side of them that
// finds them again after edits elsewhere. Null when there are no words there.
export function quoteAt(text: string, start: number, end: number): { quote: string; prefix: string; suffix: string } | null {
  const quote = cleanQuote(text.slice(start, end));
  if (!loosen(quote).text.trim()) return null;
  const hay = loosen(text);
  const first = hay.from.findIndex((i) => i >= start && !/\s/.test(text[i]));
  let last = hay.from.length - 1;
  while (last >= 0 && (hay.from[last] >= end || /\s/.test(text[hay.from[last]]))) last--;
  if (first === -1 || last < first) return null;
  return { quote, prefix: hay.text.slice(Math.max(0, first - CONTEXT), first), suffix: hay.text.slice(last + 1, last + 1 + CONTEXT) };
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  larr: '←',
  rarr: '→',
};

// An HTML entity as it reads: &amp; is &, &#39; and &#x27; are '. One it
// doesn't know stays as written.
function entity(whole: string, name: string): string {
  const code = name.startsWith('#x') || name.startsWith('#X') ? parseInt(name.slice(2), 16) : name.startsWith('#') ? Number(name.slice(1)) : NaN;
  if (!Number.isNaN(code)) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  return ENTITIES[name] ?? whole;
}

// Inline Markdown (a table cell, a caption) as it reads
// once rendered, near enough to find pinned words in: a link's address, a
// picture's (which reads as a link to it, by its alt text) and an escape's
// backslash don't show. Emphasis, code and strikethrough marks are ignored
// when comparing. Raw HTML tags are left out, as they are from the rendered
// text pins are found in (the board shows them as written, never renders them).
export function inlineText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\(\s*<?([^\s)>]*)>?[^)]*\)/g, (_, alt: string, src: string) => alt || src)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/&(#\d{1,7}|#[xX][\da-fA-F]{1,6}|[a-zA-Z]{2,8});/g, entity);
}

// A note's text as it reads once rendered, near enough to find pinned words
// in: Markdown syntax that doesn't show (list markers, task boxes, headings,
// a table's dashes, fences) is dropped, then its inline Markdown read as
// inlineText does, except that a picture shows no words.
export function noteText(markdown: string): string {
  const shown = markdown
    .split('\n')
    .filter((line) => !/^\s*(```|~~~)/.test(line) && !/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) && !/^\s{0,3}=+\s*$/.test(line))
    .filter((line) => !/^\s{0,3}\[[^\]]+\]:\s*\S/.test(line))
    .filter((line) => !(/^[\s|:-]*$/.test(line) && line.includes('|') && line.includes('-')))
    .map((line) => line.replace(/^\s{0,3}(>\s?)+/, '').replace(/^\s*(#{1,6}\s+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/, ''))
    .join('\n')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  return inlineText(shown);
}

// Finds pinned words in a text as it reads (a note's): the words as quoted,
// or, quoted with their Markdown (by an agent reading the source), the words
// as they read.
export function findWords(
  text: string,
  quote: string,
  around: { prefix?: string; suffix?: string; occurrence?: number } = {},
): { start: number; end: number } | null {
  const at = findQuote(text, quote, around);
  if (at) return at;
  const reads = inlineText(quote);
  return reads !== quote ? findQuote(text, reads, around) : null;
}

// ---- where a pin is now -----------------------------------------------------

export type PinPlace =
  | { kind: 'text'; start: number; end: number } // offsets in the note as it reads: noteText(note)
  | { kind: 'cells'; rows: [number, number] | null; columns: [number, number] | null } // null spans them all
  | BoxAnchor // where it was drawn
  | { kind: 'node'; nodeId: string }
  | { kind: 'arrow'; arrowId: string } // the id Mermaid gives its drawn path
  | { kind: 'line'; file: string; line: number; side: DiffSide; last?: number } // the file's path and the line's number now (and the last line's, for a range)
  | { kind: 'doc'; paragraph: string } // a Google Doc's paragraph, by its id in the draft
  | { kind: 'point'; row: number | null; series: number | null } // a chart's category (row) and series, if pinned; null: the whole category, or the whole series
  | SpotAnchor // where it was pinned on the scene
  | { kind: 'site'; page: string; selector: string } // an element of a website's page, found again in a person's view of it
  | { kind: 'block' };

// Where a pin's part is in its block now, or null once it has changed past
// finding: the words edited away, the cells changed. A part
// belongs to a kind of block: its kind says where it is.
export function placePin(block: Block, pin: Pin): PinPlace | null {
  if (pin.anchor.kind === 'block') return { kind: 'block' };
  return kindOf(block.type).pins?.place?.(block, pin) ?? null; // or a part this version doesn't know
}

// Whether a person asked agents to act on a pinned part, rather than just
// commenting, and the request: the first comment that asks.
export function pinAsk(comments: Comment[]): Comment | undefined {
  return comments.find((c) => c.ask);
}

// ---- describing pins ----------------------------------------------------------
// A part's kind says how it reads (its pins.parts, or its connector's pins:
// core/parts.ts); what is said here is the same for every kind of part.

// A card people pin whole, like a link, or a block.
function wholeWord(block?: Block): string {
  return (block && kindOf(block.type).pins?.whole?.word) || 'block';
}

// The pinned part in a phrase: "onboarding and the docs site" in quotes, the
// Search row, box 1, node "Retry", arrow "Client → Retry", the whole card.
// Takes a pin, or a part about to be pinned.
export function pinPart(pin: PartLike, block?: Block): string {
  if (pin.anchor.kind === 'block') return `the whole ${wholeWord(block)}`;
  return partHooks(pin.anchor.kind, block)?.name?.(pin) ?? pin.quote;
}

// A part as a prompt or a comment quotes it: the words in quotes, or the part
// named in its block: Retry budgets · Search row, Signup screen · box 1,
// Design file · the whole card.
export function partQuote(pin: PartLike, block?: Block): string {
  if (pin.anchor.kind === 'block') return `${pin.quote} · the whole ${wholeWord(block)}`;
  const own = partHooks(pin.anchor.kind, block)?.quote;
  if (own) return own(pin);
  const name = block ? block.title || kindOf(block.type).label : '';
  const part = pinPart(pin, block);
  return name ? `${name} · ${part}` : part;
}

// What a pin no longer finding its part means: "cells changed".
export function pinLost(pin: Pin, block?: Block): string {
  return partHooks(pin.anchor.kind, block)?.lost ?? 'text changed';
}

// Whether two anchors pin the same part: as its kind says (a box or a spot
// whatever number it was given, a website's element whatever it reads), or
// else when they are equal.
export function samePart(a: PinAnchor, b: PinAnchor, block?: Block): boolean {
  if (a.kind !== b.kind) return false;
  const same = partHooks(a.kind, block)?.same;
  return same ? same(a, b) : JSON.stringify(a) === JSON.stringify(b);
}

export const TASK_STATUS_WORDS: Record<TaskStatus, string> = {
  backlog: 'backlog',
  todo: 'to do',
  in_progress: 'in progress',
  in_review: 'in review',
  blocked: 'blocked',
  done: 'done',
  dropped: 'dropped',
};

// What a pin is linked to, as its chip reads: T33 in backlog, #12 open. Null
// for a pin people comment on, or one whose work is gone.
export function pinTarget(board: Board, pin: Pin): { ref: string; status: string; title: string; done: boolean } | null {
  if (pin.discussion) return null;
  if (pin.taskId) {
    const task = board.tasks.find((t) => t.id === pin.taskId);
    return task ? { ref: `T${task.number}`, status: TASK_STATUS_WORDS[task.status], title: task.title, done: task.status === 'done' || task.status === 'dropped' } : null;
  }
  const decision = board.decisions.find((d) => d.id === pin.decisionId);
  if (!decision) return null;
  const settled = decision.status === 'decided' || decision.status === 'deferred' || decision.status === 'retired';
  return { ref: `#${decision.number}`, status: decision.status, title: decision.question, done: settled };
}

export interface OwnedCanvas {
  canvas: Canvas;
  decision?: Decision;
  task?: Task;
}

// Every canvas on a board: its board context, then each decision's and task's.
export function canvasesOf(board: Board): OwnedCanvas[] {
  return [
    { canvas: board.canvas },
    ...board.decisions.map((decision) => ({ canvas: decision.canvas, decision })),
    ...board.tasks.map((task) => ({ canvas: task.canvas, task })),
  ];
}

// A canvas by its owner, briefly: board context, #3's canvas, T5's canvas.
export function canvasName(owner: { decision?: Decision; task?: Task }): string {
  if (owner.task) return `T${owner.task.number}'s canvas`;
  return owner.decision ? `#${owner.decision.number}'s canvas` : 'board context';
}

// The comments on a pinned part: those in its card's discussion that carry
// it, or on the board context, the pin's own thread.
export function pinComments(pin: Pin, owner: { decision?: Decision; task?: Task }): Comment[] {
  if (!pin.discussion) return [];
  const card = owner.task ?? owner.decision;
  return card ? card.comments.filter((c) => c.pin?.id === pin.id) : (pin.discussion.thread ?? []);
}

// The pins linked to a task or a decision, wherever they are on its board.
export function pinsTo(board: Board, target: { taskId?: string; decisionId?: string }): (OwnedCanvas & { pin: Pin; block: Block })[] {
  return canvasesOf(board).flatMap((owned) =>
    owned.canvas.pins
      .filter((pin) => (target.taskId ? pin.taskId === target.taskId : pin.decisionId === target.decisionId))
      .flatMap((pin) => {
        const block = owned.canvas.blocks.find((b) => b.id === pin.blockId);
        return block ? [{ ...owned, pin, block }] : [];
      }),
  );
}
