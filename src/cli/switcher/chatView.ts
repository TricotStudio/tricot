// The chat's stream in the Tricot tab, drawn (threadsTab.ts holds what is
// shown and takes the keys; core/chatStream.ts gathers it): every conversation
// on the board as one, in the rows above the strip, with the line to type on
// under it, and the threads' panel at its side while it is open.
//
//   Codex  agent · on T17 Keep backlog quiet · 12 min ago
//     T17 is ready to review. The server filters backlog before it builds an
//     MCP reply.
//   You · on #7 Open the Tricot tab on chat · 9 min ago
//     Let's go with a.
//   Claude  agent · in Design · Picker spacing · 2 min ago
//     Tighter: 8 px between rows.
//     👍 You
//   Sam · on the board, about “Beta is close” · just now
//     Which beta?
//
//  › Reply to Sam…
//  to the board, about “Beta is close”, the latest · Claude hears it
//  Enter send · @ new thread · > elsewhere · Tab an earlier one · Esc threads
//
// Each item is who wrote it (You for the person, a person's name, or an
// agent's with "agent" after it), where it belongs, and when; under that its
// text, wrapped and drawn as a thread's messages are (threadsView.ts
// messageRows: as written, a control character as its picture, never sent to
// the terminal), and the line of its reactions. Where it belongs: "in" a
// thread, by its title with its lens before it unless it is General; "on" a
// task or a decision, by T17 or #7 and its title or question; a comment on a
// pinned part, on its card, or "on the board" for the board context, and
// "about" the part as the comment quotes it (core/chatStream.ts ChatPin).
// Words from the board are drawn safe (threadsView.ts safe). The place is cut
// to the width, the part first and then the title; the time goes only when
// the title would be left with next to nothing.
//
// A thread picked from the panel narrows the stream to it: its messages
// alone, under a first row that says so ("Only Picker spacing · Esc for
// everything"), each headed by who wrote it and when, as the place is the
// same for all.
//
// Each item sits on the tint of its conversation (a thread, a card's
// discussion, or a pin's on the board context), across the stream: its head
// row, its text and its reactions, so which conversation each item is part
// of shows at a glance. Items of one conversation in a row share one band. A
// conversation's tint comes from its key, so it is the same wherever it
// shows; but two conversations next to each other never share one, the
// second taking the next hue. Where the terminal draws 24-bit colour and
// said its background (OSC 11), a tint is that background leaned a few
// percent toward the hue: faint, to read on, yet plain beside its
// neighbours. Elsewhere two greys from the 256 take turns at each change of
// conversation. Words keep their looks on a tint: bold, dim, the alert
// colour. What the stream says in its place, the row about newer items and
// the row that says a thread is picked are on the terminal's own background.
//
// The stream starts at the oldest and is scrolled to the latest unless the
// person scrolled up. From ten rows a blank row parts it from the line; while
// scrolled up, that row says how many newer items are below, and, while Enter
// on the stream's line brings it back to the latest, that it does: "Enter for
// the latest" with nothing typed, "Enter sends and goes to the latest" with
// something (left out where the stream is too narrow for it). The line and the
// rows around it are the threads' own (threadsView.ts composeRows, lastRow),
// on the line's band, so they read the same in a thread and here; a window
// too short for all of it loses the stream's rows first. An item still on its
// way says "sending…" where its time would be, and the one chosen to answer
// has ❯ before who wrote it. The frame says which items show down to their
// last line (ChatFrame seen), for the tab to count a thread whose latest
// message shows as seen.
//
// A frame lays out only the items it shows: from the newest back until its
// rows are full, or from where the person scrolled to, each item's lines kept
// (ChatLayout) until what they show changes, or the width does. Scrolled up,
// the stream keeps its place by the item its first row is in (ChatAnchor), so
// newer items coming, or older ones changing, leave what shows where it is.
// The frame says too when the items whose heads show were written (ChatFrame
// times), for the tab to tell when a time they say would change.
//
// The threads' panel (threadsView.ts panelRows), and the lens picker or the
// question about deleting in its place, is at the stream's right in a window
// of a hundred columns or more, the stream narrower and a thin │ between
// them; in a narrower window it is over the stream. The line runs under both.
//
// The keys say what the line does. While it answers a message: Enter sends,
// @ starts a new thread, > sends elsewhere, Tab chooses an earlier message,
// Esc goes to the threads (or back to the latest, from one chosen); with
// something typed, Tab completes. While a thread is picked, Tab chooses a
// message of it to react to and Esc goes back to everything. While a message
// is chosen and nothing is typed: Tab or ↑ the one before, ↓ the one after,
// 1 2 3 react. While the line starts a thread, the keys are a new thread's;
// while it is the local commands', Enter goes. While the stream is scrolled
// up and nothing is typed, Enter says it goes to the latest, where it would
// say send or new thread. Scrolling, and the lens, are
// said last, so a narrow window loses them first. While the panel, the
// picker or the question has the keys, the keys are theirs (panelKeys).
import { samePerson } from '../../core/format';
import type { ChatItem, ChatPlace } from '../../core/chatStream';
import { refLabel } from '../../core/refs';
import { columns, fit, type Rgb } from './strip';
import { BOLD, DIM, ago, alertOf, cutParts, onBand, type Part, type TabFrame } from './tabView';
import { choiceRows, column, composeFoot, composeRows, framed, inputRows, lastRow, messageRows, panelGeometry, panelKeys, panelRows, safe, wrapLine, type CardLink, type Compose, type Laid, type PanelView } from './threadsView';

// The cards the stream can link to (CardLink), and what tells one board's
// cards from another's, or from the same board's before a card came or went.
export interface CardLinks {
  key: string;
  link: CardLink;
}

// From this many rows a blank row parts the stream from the line to type on.
export const GAP_FROM = 10;

export interface ChatGeometry {
  width: number; // the stream's columns: all of them, but for the panel's beside it
  body: number; // the rows the stream's lines take
  gap: boolean; // the row between the stream and the line
}

// `foot`: the rows the line and what goes with it take (composeFoot);
// `beside`: the panel's columns, beside the stream; `only`: a thread is
// picked, which the stream's first row says.
export function chatGeometry(cols: number, rows: number, foot = 0, shape: { beside?: number; only?: boolean } = {}): ChatGeometry {
  const gap = rows >= GAP_FROM;
  const width = shape.beside ? Math.max(1, cols - shape.beside - 1) : cols;
  return { width, body: Math.max(0, rows - 1 - foot - Number(gap) - Number(Boolean(shape.only))), gap };
}

// The fewest columns a part pinned is shown in, cut: fewer, and it is left out.
const PART_LEAST = 10;
const ABOUT = ', about ';

const used = (parts: Part[]) => parts.reduce((sum, [text]) => sum + columns(text), 0);

// Where an item belongs, as words: what leads (dim), the title, and the part pinned.
function placeWords(place: ChatPlace, card?: CardLink): { lead: Part[]; title: string; part?: string; link?: string } {
  if (place.kind === 'thread') return { lead: [['in ', DIM], ...(place.lens ? ([[`${safe(place.lens)} · `, DIM]] as Part[]) : [])], title: safe(place.title) };
  if (place.kind === 'board') return { lead: [['on ', DIM]], title: 'the board', part: safe(place.pin.quote) };
  const link = card?.(place.kind, place.number);
  const label = refLabel({ kind: place.kind, number: place.number });
  return { lead: [['on ', DIM], ...(link ? ([[label, undefined, link], [' ']] as Part[]) : ([[`${label} `]] as Part[]))], title: safe(place.title), ...(place.pin && { part: safe(place.pin.quote) }), ...(link && { link }) };
}

// The row that heads an item: who wrote it, where it belongs and when, cut to
// `width`; without where (`placed` false, the stream narrowed to one thread),
// as a thread's messages were headed: "Claude  agent · 2 min ago".
function headRow(item: ChatItem, width: number, me: string, now: number, sending: boolean, selected: boolean, placed: boolean, card?: CardLink): Part[] {
  const mine = item.author.kind === 'human' && samePerson(item.author.name, me);
  const agent = item.author.kind === 'agent';
  const who: Part[] = [selected ? ['❯ ', BOLD] : ['  '], [mine ? 'You' : safe(item.author.name), BOLD]];
  if (!placed) return cutParts([...who, [`  ${agent ? 'agent · ' : ''}${sending ? 'sending…' : ago(item.at, now)}`, DIM]], Math.max(1, width - 1));
  const lead: Part[] = [...who, [agent ? '  agent · ' : ' · ', DIM]];
  const where = placeWords(item.place, card);
  const when: Part = [` · ${sending ? 'sending…' : ago(item.at, now)}`, DIM];
  const room = width - 1 - used(lead) - used(where.lead);
  // The time stays unless the title would be left with next to nothing.
  const keepTime = room - used([when]) >= Math.min(8, columns(where.title));
  const titleRoom = Math.max(1, keepTime ? room - used([when]) : room);
  const title = fit(where.title, titleRoom);
  // The part pinned, with what is left: none when that is too little to read.
  const left = titleRoom - columns(title) - columns(ABOUT);
  const part: Part[] = where.part && left >= Math.min(PART_LEAST, columns(where.part)) ? [[`${ABOUT}${fit(where.part, left)}`, DIM]] : [];
  return cutParts([...lead, ...where.lead, where.link ? [title, undefined, where.link] : [title], ...part, ...(keepTime ? [when] : [])], Math.max(1, width - 1));
}

// An item's lines at `width`: its head row, its text and its reactions.
function itemLines(item: ChatItem, width: number, me: string, now: number, sending: boolean, selected: boolean, placed: boolean, card?: CardLink): Part[][] {
  return [headRow(item, width, me, now, sending, selected, placed, card), ...messageRows(item.body, item.reactions, width, me, card)];
}

// The stream's lines at `width`, every item's. `starts` is the line each item
// begins on. `sending`: the keys of items still on their way, which say so
// where their time would be; `selected`: the key of the one chosen, marked
// before who wrote it; `placed`: each head says where its item belongs (not
// in one thread picked). A frame lays out only what it shows (ChatLayout).
export function chatLines(items: ChatItem[], width: number, me: string, now: number, sending: ReadonlySet<string> = new Set(), selected?: string, placed = true): Laid {
  const lines: Part[][] = [];
  const starts: number[] = [];
  for (const item of items) {
    starts.push(lines.length);
    lines.push(...itemLines(item, width, me, now, sending.has(item.key), item.key === selected, placed));
  }
  return { lines, starts };
}

// ---- laying out only what shows ---------------------------------------------------------

// A line of the stream: the item it is in, by its place among the items, and
// the line of that item. The end, after the last line, is the item after the last.
export interface ChatAt {
  item: number;
  line: number;
}

// Where the stream is scrolled to, kept by the item its first line shown is
// in (by key) and the line of it, so newer items coming, or older ones
// changing, don't move what shows. `index` is where that item was, for when
// it is gone.
export interface ChatAnchor {
  key: string;
  line: number;
  index: number;
}

// The first line shown: the latest ('end'), a line counted from the oldest, or an anchor.
export type ChatTop = 'end' | number | ChatAnchor;

export const compareAt = (a: ChatAt, b: ChatAt): number => a.item - b.item || a.line - b.line;

// The stream's lines as one frame draws them, laid out as they are asked for:
// from the newest back as far as the window and the scrolling reach, each
// item's taken from the layout while it is unchanged.
export class ChatLines {
  private readonly laid = new Map<number, Part[][]>();

  constructor(
    readonly items: ChatItem[],
    private readonly layOut: (item: ChatItem) => Part[][],
  ) {}

  get end(): ChatAt {
    return { item: this.items.length, line: 0 };
  }

  of(index: number): Part[][] {
    let lines = this.laid.get(index);
    if (!lines) this.laid.set(index, (lines = this.layOut(this.items[index])));
    return lines;
  }

  // `count` lines on from `at`, or back for a count below none, stopping at the first line and at the end.
  move(at: ChatAt, count: number): ChatAt {
    let { item, line } = at;
    let left = Math.abs(count);
    if (count >= 0) {
      while (left > 0 && item < this.items.length) {
        const rest = this.of(item).length - line;
        if (left < rest) return { item, line: line + left };
        left -= rest;
        item++;
        line = 0;
      }
      return { item, line };
    }
    while (left > line && item > 0) {
      left -= line;
      item--;
      line = this.of(item).length;
    }
    return { item, line: Math.max(0, line - left) };
  }

  // The first line shown at the latest, `body` lines tall.
  last(body: number): ChatAt {
    return this.move(this.end, -body);
  }

  // The first line shown for `top`: never past the latest, so the rows stay full.
  find(top: ChatTop, body: number): ChatAt {
    const last = this.last(body);
    if (top === 'end') return last;
    const at = typeof top === 'number' ? this.move({ item: 0, line: 0 }, top) : this.anchored(top);
    return compareAt(at, last) > 0 ? last : at;
  }

  private anchored(anchor: ChatAnchor): ChatAt {
    const { items } = this;
    const item = items[anchor.index]?.key === anchor.key ? anchor.index : items.findIndex((it) => it.key === anchor.key);
    if (item < 0) return { item: Math.min(anchor.index, items.length), line: 0 }; // gone: where it was
    return { item, line: Math.min(anchor.line, this.of(item).length - 1) };
  }

  // `at` kept as the first line shown: at the latest, 'end', which stays there as more come.
  top(at: ChatAt, body: number): ChatTop {
    return compareAt(at, this.last(body)) >= 0 ? 'end' : { key: this.items[at.item].key, line: at.line, index: at.item };
  }
}

// What each item's lines were laid out for, beyond the frame's columns and person.
interface Kept {
  item: ChatItem;
  marks: string; // chosen, sending, and the time its head says
  lines: Part[][];
}

const sameItem = (a: ChatItem, b: ChatItem): boolean => a === b || (a.body === b.body && JSON.stringify([a.author, a.place, a.reactions]) === JSON.stringify([b.author, b.place, b.reactions]));

// The stream's layout, kept from frame to frame: each item's lines, laid out
// again only when something they show changes (its text, reactions, place,
// author, being chosen or on its way, the time its head says), and all of
// them at another width; and the tints, worked out again for other items.
export class ChatLayout {
  private shape = '';
  private readonly kept = new Map<string, Kept>();
  private tinted: { items: ChatItem[]; light: boolean; from: string; tints: string[] } | undefined;

  lines(items: ChatItem[], width: number, me: string, now: number, sending: ReadonlySet<string> = new Set(), selected?: string, placed = true, cards?: CardLinks): ChatLines {
    const shape = `${width}\u0000${me}\u0000${placed}\u0000${cards?.key ?? ''}`;
    if (shape !== this.shape) {
      this.kept.clear();
      this.shape = shape;
    } else if (this.kept.size > 2 * items.length + 64) {
      const here = new Set(items.map((item) => item.key));
      for (const key of this.kept.keys()) if (!here.has(key)) this.kept.delete(key);
    }
    return new ChatLines(items, (item) => {
      const going = sending.has(item.key);
      const marks = `${item.key === selected}\u0000${going ? '' : ago(item.at, now)}\u0000${going}`;
      const kept = this.kept.get(item.key);
      if (kept && kept.marks === marks && sameItem(kept.item, item)) {
        kept.item = item;
        return kept.lines;
      }
      const lines = itemLines(item, width, me, now, going, item.key === selected, placed, cards?.link);
      this.kept.set(item.key, { item, marks, lines });
      return lines;
    });
  }

  tints(items: ChatItem[], light: boolean, tintFrom?: Rgb): string[] {
    const from = tintFrom?.join(',') ?? '';
    const was = this.tinted;
    if (was?.items === items && was.light === light && was.from === from) return was.tints;
    return (this.tinted = { items, light, from, tints: chatTints(items, light, tintFrom) }).tints;
  }
}

// ---- the tints ---------------------------------------------------------------------

// The conversation an item is part of: a thread, a card's discussion, or a
// pin's on the board context.
export const conversationOf = (place: ChatPlace): string => (place.kind === 'board' ? `pin:${place.pin.id}` : `${place.kind}:${place.id}`);

// The hues the tints lean toward: six round the colour wheel, in an order
// that puts each far round it from the next, so a conversation that takes the
// next hue, to differ from the one before it, differs plainly.
const HUES: Rgb[] = [
  [255, 70, 120], // rose
  [40, 200, 60], // green
  [190, 80, 255], // violet
  [0, 200, 220], // teal
  [255, 170, 0], // amber
  [60, 110, 255], // blue
];

// How far each tint leans from the background toward its hue: faint, a
// little less on a light background, where a hue shows more.
const LEAN_DARK = 0.08;
const LEAN_LIGHT = 0.06;

// Without 24-bit colour, or not knowing the background, two greys from the
// 256 take turns, a shade off the background and apart from the line's band.
const GREYS = { dark: ['48;5;234', '48;5;235'], light: ['48;5;231', '48;5;255'] };

// A conversation's own hue, the same each time: from its key.
function hueOf(conversation: string): number {
  let hash = 2166136261;
  for (let i = 0; i < conversation.length; i++) hash = Math.imul(hash ^ conversation.charCodeAt(i), 16777619);
  return (hash >>> 0) % HUES.length;
}

// `background` leaned `amount` of the way toward `hue`, as an SGR background.
function leaned(background: Rgb, hue: Rgb, amount: number): string {
  return `48;2;${background.map((c, i) => Math.round(c + (hue[i] - c) * amount)).join(';')}`;
}

// The tint each item is drawn on, as an SGR background. With the terminal's
// background (`tintFrom`, given only where it draws 24-bit colour), each
// conversation's own hue leans it faintly; else two greys take turns. Items
// of one conversation in a row share one; one whose hue the conversation
// before it has takes the next. Worked out over all the items, not only those
// shown, so a tint stays put as the stream scrolls.
export function chatTints(items: ChatItem[], light: boolean, tintFrom?: Rgb): string[] {
  const tints: string[] = [];
  let last: string | undefined; // the conversation before
  let turn = -1; // its hue, or its grey
  for (const item of items) {
    const here = conversationOf(item.place);
    if (here !== last) {
      const own = tintFrom ? hueOf(here) : (turn + 1) % 2;
      turn = tintFrom && own === turn ? (own + 1) % HUES.length : own;
      last = here;
    }
    tints.push(tintFrom ? leaned(tintFrom, HUES[turn], light ? LEAN_LIGHT : LEAN_DARK) : GREYS[light ? 'light' : 'dark'][turn]);
  }
  return tints;
}

export interface ChatViewData {
  items: ChatItem[];
  top: ChatTop; // the first line shown, or 'end' for the latest
  layout?: ChatLayout; // the items laid out in frames before, to draw from while they are unchanged
  // Said in the stream's place when there is nothing in it to show: reading, why it can't be read, or that it is empty.
  status?: { text: string; hint?: string; tone?: 'alert' };
  compose?: Compose; // the line to type on, once the board is read
  sending?: string[]; // the keys of the items still on their way
  selected?: string; // the key of the item chosen to answer
  replying?: boolean; // the line answers a message, rather than starting a thread
  choosing?: boolean; // a message is chosen and nothing is typed: the keys move the choice and react
  chosen?: boolean; // Esc on the empty line goes back to the latest, from a message chosen or a new thread asked for
  // Enter on the stream's line brings a stream scrolled up back to the latest, sending what is typed if anything: not while another line has the keys, the board asks for this terminal to be let in first, or a new thread is on its way.
  enterLatest?: boolean;
  only?: string; // the title of the thread picked: the stream shows it alone, and its first row says so
  panel?: PanelView; // the threads' panel, beside the stream or over it
  me: string; // the person's name, as the board has it
  now: number;
  notice?: string; // what waits on the person elsewhere, for the last row
  cards?: CardLinks; // the cards a message can name, linked (T36)
}

// The frame, the keys of the items shown down to their last line, and when
// each item whose head row shows was written, for the tab to tell when the
// time a head says ("12 min ago") would change.
export interface ChatFrame extends TabFrame {
  seen: string[];
  times: string[];
}

// The row that says the stream shows one thread: "Only Picker spacing · Esc for everything".
function onlyRow(title: string, width: number): Part[] {
  const lead = '  Only ';
  const hint = ' · Esc for everything';
  return cutParts([[lead, DIM], [fit(safe(title), Math.max(8, width - 1 - columns(lead) - columns(hint))), BOLD], [hint, DIM]], Math.max(1, width - 1));
}

// The row before the line while the stream is scrolled up: how many newer
// items are below, then, while Enter brings it back to the latest (`enter`),
// that it does, sending what is typed (`typed`). Where the stream is too
// narrow for that, it is left out, rather than cut to words that leave out
// the sending.
function newerRow(below: number, width: number, enter: boolean, typed: boolean): Part[] {
  const lead = `  ↓ ${below ? `${below} newer` : 'more'} below`;
  const tail = !enter ? '' : typed ? ' · Enter sends and goes to the latest' : ' · Enter for the latest';
  return [[columns(lead + tail) <= width - 1 ? lead + tail : lead, DIM]];
}

// `tintFrom`: the terminal's background, where it draws 24-bit colour, for
// the tints to lean from (chatTints).
export function renderChat(view: ChatViewData, cols: number, rows: number, light = false, tintFrom?: Rgb): ChatFrame {
  const alert = alertOf(light);
  const { compose, panel } = view;
  const foot = compose ? composeFoot(rows, choiceRows(compose.choices), inputRows(compose.text, cols), Boolean(compose.working)) : undefined;
  const side = panel && panelGeometry(cols);
  const over = side !== undefined && !side.wide; // the panel over the stream, in a narrow window
  const only = view.only !== undefined;
  const { width, body, gap } = chatGeometry(cols, rows, foot?.rows ?? 0, { beside: side?.wide ? side.width : 0, only });
  const height = Math.max(0, rows - 1 - (foot?.rows ?? 0)); // the rows above the line

  // The stream's column: the row that says a thread is picked, its lines, and the row under them.
  const stream: Part[][] = [];
  let below = 0; // the items under the last line shown
  let scrolled = false;
  const seen: string[] = [];
  const times: string[] = [];
  if (only && !over) stream.push(onlyRow(view.only!, width));
  if (over) {
    // Out of sight: nothing of it is drawn, or seen.
  } else if (view.status) {
    const wrapped = (text: string, sgr?: string): Part[][] => wrapLine(safe(text), Math.max(1, width - 3)).map((line): Part[] => [[`  ${line}`, sgr]]);
    stream.push(...[...wrapped(view.status.text, view.status.tone === 'alert' ? alert : undefined), ...(view.status.hint ? wrapped(view.status.hint, DIM) : [])].slice(0, body));
  } else {
    // Only the items that show are laid out, each kept by the layout until it changes.
    const layout = view.layout ?? new ChatLayout();
    const sending = new Set(view.sending);
    const laid = layout.lines(view.items, width, view.me, view.now, sending, view.selected, !only, view.cards);
    // Each line on its item's tint, across the stream.
    const tints = layout.tints(view.items, light, tintFrom);
    let at = laid.find(view.top, body);
    for (let n = 0; n < body && at.item < view.items.length; n++) {
      const item = view.items[at.item];
      const lines = laid.of(at.item);
      if (at.line === 0 && !sending.has(item.key)) times.push(item.at);
      if (at.line === lines.length - 1) seen.push(item.key);
      stream.push(onBand(lines[at.line], tints[at.item], width));
      at = laid.move(at, 1);
    }
    // `at` is now the first line under those shown: the items from there on are below.
    scrolled = at.item < view.items.length;
    below = view.items.length - at.item - Number(at.line > 0);
  }
  if (!over) {
    while (stream.length < Number(only) + body) stream.push([]);
    if (gap) stream.push(scrolled ? newerRow(below, width, Boolean(view.enterLatest), Boolean(compose?.text)) : []);
  }

  // The panel beside it, a thin line between them, or over it.
  const out: Part[][] = [];
  if (panel && side) {
    const right = panelRows(panel, side.width, height, light);
    for (let y = 0; y < height; y++) out.push(over ? right[y] ?? [] : [...column(stream[y] ?? [], width), ['│', DIM], ...(right[y] ?? [])]);
  } else out.push(...stream);

  let cursor: { x: number; y: number } | undefined;
  if (compose && foot) {
    const drawn = composeRows(compose, foot, cols, light, view.now);
    cursor = { x: drawn.cursor.x, y: out.length + drawn.cursor.y };
    out.push(...drawn.rows);
  }

  const key = (k: string, words: string): Part[] => [[k, BOLD], ...(words ? [[` ${words}`] as Part] : [])];
  // `more`: scrolling and the lens, where they are said last, so a narrow window loses them first.
  const keysRow = (more: boolean, compact: boolean): Part[] => {
    const back = only ? 'everything' : 'threads';
    const esc: [string, string] = ['Esc', compose?.text ? 'clear' : view.chosen ? 'the latest' : back];
    // Scrolled up with nothing typed, Enter goes back to the latest, rather than sending.
    const enter = (words: string): [string, string] => ['Enter', view.enterLatest && scrolled && !compose?.text ? 'latest' : words];
    const later = (...keys: [string, string][]) => (more ? keys : []);
    const actions: [string, string][] = !compose
      ? [['↑↓ PgUp PgDn', 'scroll'], ['Esc', back]]
      : compose.navigation
        ? [['Enter', 'go'], ['Tab', 'complete'], ['Esc', 'cancel']]
        : view.choosing
          ? [['Tab ↑', 'earlier'], ['↓', 'later'], ['1', '👍'], ['2', '👎'], ['3', '👀'], esc]
          : view.replying && compose.text
            ? [['Enter', 'send'], ['↑↓ PgUp PgDn', 'scroll'], ['Tab', 'complete'], esc]
            : only
              ? [enter('send'), ['Tab', 'react'], esc, ...later(['↑↓ PgUp PgDn', 'scroll'], ['^L', 'lens'])]
              : view.replying
                ? [enter('send'), ['@', 'new thread'], ['>', 'elsewhere'], ['Tab', 'an earlier one'], esc, ...later(['↑↓ PgUp PgDn', 'scroll'])]
                : [enter('new thread'), ['↑↓ PgUp PgDn', 'scroll'], ['Tab', 'complete @ /'], esc, ...later(['^L', 'lens'])];
    // While a /, @ or > list shows, ↑ ↓ pick in it (T39); Page Up and Page Down still scroll.
    const said = compose?.picking ? actions.map(([k, words]): [string, string] => (k === '↑↓ PgUp PgDn' ? ['↑↓', 'pick'] : [k, words])) : actions;
    return [[' '], ...said.flatMap(([k, words], i) => [...(i ? [[compact ? '  ' : ' · '] as Part] : []), ...key(k, compact ? '' : words)])];
  };
  out.push(lastRow(panel?.keys ? panelKeys(panel) : keysRow, compose, foot, view.notice, cols, light));
  return { ...framed(out, rows, cols, cursor), seen, times };
}
