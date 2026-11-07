// Where the line under the chat's stream sends what is typed (T21; threadsTab.ts
// holds the line and its keys): the conversation of the latest message from
// someone else, unless the person says otherwise. These are the pieces that
// work it out from the board, kept apart from the keys.
//
// A line that begins with > and a name of a place sends there instead: >T19
// a task's discussion, >#7 a decision's, and > with part of a thread's title
// (as many of the words after it as some title has, so the rest is the
// message) that thread. A > followed by a space is plain text, so a quoted
// line still reads as one. Tab completes the place as it does a name
// (threadsComplete.ts), writing T19, #7 or the thread's whole title. A place
// the board doesn't have, or words that are in several threads' titles, say
// why and send nothing.
//
// Under the line one row says where it goes and who hears it: "to T19
// Stopped agents leave the strip, the latest · Claude hears it". The title,
// and the part a pinned comment is about, are cut to leave room for the rest.
import type { ChatItem, ChatPlace } from '../../core/chatStream';
import { clip, samePerson } from '../../core/format';
import { refLabel } from '../../core/refs';
import { shownTitle } from '../../core/threads';
import type { Board, Comment, Decision, Task, Thread } from '../../core/types';
import { conversationOf } from './chatView';
import { columns, fit } from './strip';
import type { CommentOn } from './threadsSend';
import { safe } from './threadsView';

export type CardPlace = Exclude<ChatPlace, { kind: 'thread' }>;

const mine = (item: ChatItem, me: string) => item.author.kind === 'human' && samePerson(item.author.name, me);

// What others wrote, in the stream's order: what Tab chooses among, and what the line answers.
export const answerable = (items: ChatItem[], me: string): ChatItem[] => items.filter((item) => !mine(item, me));

// The latest message in the stream from someone else, which the line answers while nothing else is chosen.
export const latestFrom = (items: ChatItem[], me: string): ChatItem | undefined => items.findLast((item) => !mine(item, me));

export const taskPlace = (task: Pick<Task, 'id' | 'number' | 'title'>): ChatPlace => ({ kind: 'task', id: task.id, number: task.number, title: task.title });
export const decisionPlace = (decision: Pick<Decision, 'id' | 'number' | 'question'>): ChatPlace => ({ kind: 'decision', id: decision.id, number: decision.number, title: decision.question });
export function threadPlace(thread: Thread): ChatPlace {
  const lens = thread.lens && thread.lens.name !== 'General' ? thread.lens.name : undefined;
  return { kind: 'thread', id: thread.id, title: shownTitle(thread), ...(lens && { lens }) };
}

// ---- > and a place ----------------------------------------------------------------

// What a line that begins with > names: the place, and the message after it;
// or why it names none. Nothing for a line that doesn't begin so.
export type Named = { kind: 'place'; place: ChatPlace; text: string } | { kind: 'unknown'; why: string };

export const NAMING = "After > goes where it is for: T19, #7 or part of a thread's title.";

const words = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

export function named(text: string, board: Board): Named | undefined {
  if (!text.startsWith('>') || /^>\s/.test(text)) return undefined;
  const rest = text.slice(1);
  if (!rest) return { kind: 'unknown', why: NAMING };
  const first = /^\S+/.exec(rest)![0];
  const after = (end: number) => rest.slice(end).trim();
  const ref = /^([Tt]|#)(\d+)$/.exec(first);
  if (ref) {
    const number = Number(ref[2]);
    const label = `${ref[1] === '#' ? '#' : 'T'}${number}`;
    const card = ref[1] === '#' ? board.decisions.find((d) => d.number === number) : board.tasks.find((t) => t.number === number);
    if (!card) return { kind: 'unknown', why: `There is no ${label} on this board.` };
    return { kind: 'place', place: 'question' in card ? decisionPlace(card) : taskPlace(card), text: after(first.length) };
  }
  // Part of a thread's title: as many of the words as some title has.
  const threads = board.threads ?? [];
  const typed = [...rest.matchAll(/\S+/g)];
  for (let n = typed.length; n > 0; n--) {
    const end = typed[n - 1].index + typed[n - 1][0].length;
    const query = words(rest.slice(0, end));
    const fits = threads.filter((t) => words(shownTitle(t)).includes(query));
    if (!fits.length) continue;
    const exact = fits.filter((t) => words(shownTitle(t)) === query);
    const thread = fits.length === 1 ? fits[0] : exact.length === 1 ? exact[0] : undefined;
    if (!thread) return { kind: 'unknown', why: `“${clip(rest.slice(0, end), 40)}” is in ${fits.length} threads' titles: Tab chooses one.` };
    return { kind: 'place', place: threadPlace(thread), text: after(end) };
  }
  return { kind: 'unknown', why: `No thread's title has “${clip(first, 40)}” in it. ${NAMING}` };
}

// ---- Tab: the places > can name ----------------------------------------------------

export interface PlaceChoice {
  write: string; // what Tab writes after the >: T19, #7, or the thread's title
  label: string; // ">T19"
  note?: string; // the card's title, or "thread"
}

// The most places a > lists, as an @ lists names.
const PLACES_LISTED = 8;
const NOTE_LENGTH = 40;

// The places that fit what is typed after a >: a card by its number (T1
// lists T1, T17, T19), any of them by its title. Those whose number or title
// begins so come first, and among those alike the ones talked in latest.
export function placeChoices(board: Board, items: ChatItem[], query: string): PlaceChoice[] {
  const q = words(query);
  const latest = new Map<string, number>();
  items.forEach((item, i) => latest.set(conversationOf(item.place), i));
  const all = [
    ...board.tasks.map((t) => ({ key: `task:${t.id}`, ref: refLabel({ kind: 'task', number: t.number }), title: t.title, number: t.number })),
    ...board.decisions.map((d) => ({ key: `decision:${d.id}`, ref: refLabel({ kind: 'decision', number: d.number }), title: d.question, number: d.number })),
    ...(board.threads ?? []).map((t) => ({ key: `thread:${t.id}`, ref: undefined, title: shownTitle(t), number: 0, lens: t.lens && t.lens.name !== 'General' ? t.lens.name : undefined })),
  ];
  const rank = (ref: string | undefined, title: string): number => {
    if (!q) return 0;
    const r = ref?.toLowerCase();
    const t = words(title);
    return r === q ? 0 : r?.startsWith(q) ? 1 : t.startsWith(q) ? 2 : t.includes(q) ? 3 : -1;
  };
  return all
    .map((place) => ({ place, rank: rank(place.ref, place.title), at: latest.get(place.key) ?? -1 }))
    .filter(({ rank }) => rank >= 0)
    .sort((a, b) => a.rank - b.rank || b.at - a.at || a.place.number - b.place.number)
    .slice(0, PLACES_LISTED)
    .map(({ place }): PlaceChoice => {
      const title = place.title.replace(/\s+/g, ' ').trim();
      if (place.ref) return { write: place.ref, label: `>${place.ref}`, note: clip(title, NOTE_LENGTH) };
      return { write: title, label: `>${clip(title, NOTE_LENGTH)}`, note: 'lens' in place && place.lens ? `${place.lens} thread` : 'thread' };
    });
}

// ---- the row under the line -----------------------------------------------------------

// The fewest columns a pinned part is said in, cut: fewer, and it is left out.
const PART_LEAST = 10;
const ABOUT = ', about ';

// Where a place is, as the row says it after "to": a card's number and
// title, a thread's title, or the board, and the part a pinned comment is about.
function placeLabel(place: ChatPlace): { head: string; title: string; part?: string } {
  if (place.kind === 'thread') return { head: '', title: safe(place.title) };
  if (place.kind === 'board') return { head: '', title: 'the board', part: safe(place.pin.quote) };
  return { head: `${refLabel({ kind: place.kind, number: place.number })} `, title: safe(place.title), ...(place.pin && { part: safe(place.pin.quote) }) };
}

// "to T19 Stopped agents leave the strip, the latest · Claude hears it", cut
// to `cols`: the part pinned first, then the title. `how`: ", the latest",
// ", the one chosen", or nothing.
export function aimRow(place: ChatPlace, how: string, who: string, cols: number): string {
  const { head, title, part } = placeLabel(place);
  const rest = `${how} · ${who}`;
  const room = cols - 2 - columns(`to ${head}`) - columns(rest);
  let about = part ? `${ABOUT}${part}` : '';
  if (columns(title) + columns(about) > room) {
    const left = room - columns(title) - columns(ABOUT);
    about = part && left >= Math.min(PART_LEAST, columns(part)) ? `${ABOUT}${fit(part, left)}` : '';
  }
  return `to ${head}${fit(title, Math.max(8, room - columns(about)))}${about}${rest}`;
}

// ---- sending there --------------------------------------------------------------------

const pinsOf = (board: Board, place: CardPlace) =>
  place.kind === 'task' ? board.tasks.find((t) => t.id === place.id)?.canvas?.pins : place.kind === 'decision' ? board.decisions.find((d) => d.id === place.id)?.canvas?.pins : board.canvas.pins;

// Where a reply to a comment goes: about its pinned part while the pin is
// still there, else in its card's discussion. The place it shows at while
// on its way is the same, without the pin when that is gone.
export function replyOn(place: CardPlace, board: Board): { on: CommentOn; place: CardPlace } {
  if (place.kind === 'board') return { on: { kind: 'pin', id: place.pin.id }, place };
  if (place.pin && pinsOf(board, place)?.some((p) => p.id === place.pin!.id)) return { on: { kind: 'pin', id: place.pin.id }, place };
  const { pin: _gone, ...card } = place;
  return { on: { kind: place.kind, id: place.id }, place: card };
}

// Where a reaction to a comment goes: its card, a part pinned on its canvas
// included, or the pin on the board context whose thread it is in.
export const reactOn = (place: CardPlace): CommentOn => (place.kind === 'board' ? { kind: 'pin', id: place.pin.id } : { kind: place.kind, id: place.id });

// The board with `comment` where it is now: in place of the one it was (a
// reaction's answer), or the latest at `place` (a reply's), so it shows
// before the board is read again.
export function withComment(board: Board, place: CardPlace, comment: Comment): Board {
  const put = (comments: Comment[]) => (comments.some((c) => c.id === comment.id) ? comments.map((c) => (c.id === comment.id ? comment : c)) : [...comments, comment]);
  if (place.kind === 'task') return { ...board, tasks: board.tasks.map((t) => (t.id === place.id ? { ...t, comments: put(t.comments) } : t)) };
  if (place.kind === 'decision') return { ...board, decisions: board.decisions.map((d) => (d.id === place.id ? { ...d, comments: put(d.comments) } : d)) };
  const pins = board.canvas.pins.map((p) => (p.id === place.pin.id ? { ...p, discussion: { ...p.discussion, thread: put(p.discussion?.thread ?? []) } } : p));
  return { ...board, canvas: { ...board.canvas, pins } };
}
