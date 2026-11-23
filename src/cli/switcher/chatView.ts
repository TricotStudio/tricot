// The chat's stream in the Tricot tab, drawn (threadsTab.ts holds what is
// shown and takes the keys): the board's Home conversation, as the page's
// Home shows it (core/homeConversation.ts decides what it holds,
// homeStream.ts gathers it, homeView.ts draws its items and the yarn at their
// left), in the rows above the strip, with the line to type on under it, and
// the threads' panel at its side while it is open.
//
//    •     You · 2:14 PM
//    │       Fix sign-in on mobile: the button hides under the keyboard.
//    ├─╮       ↳ Sign-in on mobile · sent on to Claude  ■ At work
//    • │   Router  agent · 2:15 PM
//    │ │     Two things left: the sign-in fix, and the changelog.
//    │ •   ■ Sign-in on mobile · Claude asks you · 2:20 PM
//    │ │     Which tablets: iPads alone, or Android too?
//
//  › Answer Claude…
//  to Sign-in on mobile, the latest · Claude · Sign-in on mobile hears it
//  Enter send · @ new thread · > elsewhere · Tab an earlier one · Esc threads
//
// Its items are what was said in the conversation, the card under an ask that
// was sent on, and the relays of the work that need the person (homeView.ts
// says how each reads). Words from the board are drawn safe (threadsView.ts
// safe), and a message's text as a thread's messages are (threadsView.ts
// messageRows: as written, a control character as its picture, never sent to
// the terminal), with the line of its reactions.
//
// A thread picked (from the panel, or Enter on a card or a relay chosen)
// narrows the stream to it: its messages alone, under a first row that says
// so ("Only Picker spacing · Esc for everything"), each headed by who wrote it
// and how long ago, with no yarn.
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
// way says "sending…" where its time would be, and the one chosen has ❯
// before it. The frame says which items show down to their
// last line (ChatFrame seen), for the tab to count a thread whose latest
// message shows as seen.
//
// A frame lays out only the items it shows: from the newest back until its
// rows are full, or from where the person scrolled to, each item's lines kept
// (ChatLayout) until what they show changes, or the width or the colours do,
// laid out beside the yarn (homeView.ts yarnWidth), which each frame draws
// for the lines it shows (yarnParts). Scrolled up,
// the stream keeps its place by the item its first row is in (ChatAnchor), so
// newer items coming, or older ones changing, leave what shows where it is.
// The frame says too when the messages of a thread picked whose heads show
// were written (ChatFrame times), for the tab to tell when a time they say
// would change; Home's heads say the time in the clock, which doesn't.
//
// The threads' panel (threadsView.ts panelRows), and the lens picker or the
// question about deleting in its place, is at the stream's right in a window
// of a hundred columns or more, the stream narrower and a thin │ between
// them; in a narrower window it is over the stream. The line runs under both.
//
// The keys say what the line does. While it answers a message: Enter sends,
// @ starts a new thread, > sends elsewhere, Tab chooses an earlier one, Esc
// goes to the threads (or back to the latest, from one chosen); with
// something typed, Tab completes. While a thread is picked, Tab chooses a
// message of it to react to and Esc goes back to everything. While something
// is chosen and nothing is typed: Enter opens it where it leads somewhere (a
// card's thread, a relay's, a part's card's page), Tab or ↑ the one before, ↓
// the one after, and 1 2 3 react to a message. While the line starts a thread, the keys are a new thread's;
// while it is the local commands', Enter goes. While the stream is scrolled
// up and nothing is typed, Enter says it goes to the latest, where it would
// say send or new thread. Scrolling, and the lens, are
// said last, so a narrow window loses them first. While the panel, the
// picker or the question has the keys, the keys are theirs (panelKeys).
import { samePerson } from '../../core/format';
import type { ChatItem, ChatPlace } from '../../core/chatStream';
import type { StreamItem } from './homeStream';
import { homeLines, yarnParts, yarnWidth, type Colours, type HomeYarn, type Look } from './homeView';
import { columns, fit } from './strip';
import { BOLD, DIM, ago, alertOf, cutParts, type Part, type TabFrame } from './tabView';
import { choiceRows, column, composeFoot, composeRows, framed, inputRows, lastRow, messageRows, panelGeometry, panelKeys, panelRows, safe, wrapLine, type CardLink, type Compose, type PanelView } from './threadsView';

// The cards the stream can link to (CardLink), and what tells one board's
// cards from another's, or from the same board's before a card came or went.
export interface CardLinks {
  key: string;
  link: CardLink;
}

// The look lines are laid out in where none is said: the 256 colours, on a dark background.
const DEFAULT_LOOK: Look = { colours: '256', light: false };

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

// The row that heads a message of a thread picked: who wrote it and when, cut
// to `width`, as a thread's messages are headed: "Claude  agent · 2 min ago".
function headRow(item: ChatItem, width: number, me: string, now: number, sending: boolean, selected: boolean): Part[] {
  const mine = item.author.kind === 'human' && samePerson(item.author.name, me);
  const agent = item.author.kind === 'agent';
  const who: Part[] = [selected ? ['❯ ', BOLD] : ['  '], [mine ? 'You' : safe(item.author.name), BOLD]];
  return cutParts([...who, [`  ${agent ? 'agent · ' : ''}${sending ? 'sending…' : ago(item.at, now)}`, DIM]], Math.max(1, width - 1));
}

// An item's lines at `width`: an item of Home's conversation as homeView.ts
// draws it; a message of a thread picked, its head row, its text and its
// reactions.
function itemLines(item: StreamItem, width: number, me: string, now: number, sending: boolean, selected: boolean, look: Look, card?: CardLink): Part[][] {
  if (item.home) return homeLines(item, { width, me, sending, selected, look, card });
  return [headRow(item, width, me, now, sending, selected), ...messageRows(item.body, item.reactions, width, me, card)];
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
    readonly items: StreamItem[],
    private readonly layOut: (item: StreamItem) => Part[][],
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
  item: StreamItem;
  marks: string; // chosen, sending, and the time its head says
  lines: Part[][];
}

const sameItem = (a: StreamItem, b: StreamItem): boolean =>
  a === b || (a.body === b.body && a.sig === b.sig && Boolean(a.home) === Boolean(b.home) && JSON.stringify([a.author, a.place, a.reactions]) === JSON.stringify([b.author, b.place, b.reactions]));

// The stream's layout, kept from frame to frame: each item's lines, laid out
// again only when something they show changes (its text, reactions, place,
// author, what Home's conversation says of it, being chosen or on its way,
// the time its head says), and all of them at another width or look.
export class ChatLayout {
  private shape = '';
  private readonly kept = new Map<string, Kept>();

  lines(items: StreamItem[], width: number, me: string, now: number, sending: ReadonlySet<string> = new Set(), selected?: string, cards?: CardLinks, look: Look = DEFAULT_LOOK): ChatLines {
    const shape = `${width}\u0000${me}\u0000${cards?.key ?? ''}\u0000${look.colours}\u0000${look.light}`;
    if (shape !== this.shape) {
      this.kept.clear();
      this.shape = shape;
    } else if (this.kept.size > 2 * items.length + 64) {
      const here = new Set(items.map((item) => item.key));
      for (const key of this.kept.keys()) if (!here.has(key)) this.kept.delete(key);
    }
    return new ChatLines(items, (item) => {
      const going = sending.has(item.key);
      // Home's heads say the time in the clock, which stays; a thread's say how long ago.
      const marks = `${item.key === selected}\u0000${going || item.home ? '' : ago(item.at, now)}\u0000${going}`;
      const kept = this.kept.get(item.key);
      if (kept && kept.marks === marks && sameItem(kept.item, item)) {
        kept.item = item;
        return kept.lines;
      }
      const lines = itemLines(item, width, me, now, going, item.key === selected, look, cards?.link);
      this.kept.set(item.key, { item, marks, lines });
      return lines;
    });
  }
}

// The conversation an item is part of: a thread, a card's discussion, or a
// pin's on the board context; what a message on its way is matched by.
export const conversationOf = (place: ChatPlace): string => (place.kind === 'board' ? `pin:${place.pin.id}` : `${place.kind}:${place.id}`);

export interface ChatViewData {
  items: StreamItem[];
  yarn?: HomeYarn; // the yarn beside Home's conversation: none for a thread picked
  top: ChatTop; // the first line shown, or 'end' for the latest
  layout?: ChatLayout; // the items laid out in frames before, to draw from while they are unchanged
  // Said in the stream's place when there is nothing in it to show: reading, why it can't be read, or that it is empty.
  status?: { text: string; hint?: string; tone?: 'alert' };
  compose?: Compose; // the line to type on, once the board is read
  sending?: string[]; // the keys of the items still on their way
  selected?: string; // the key of the item chosen to answer
  replying?: boolean; // the line answers a message, rather than starting a thread
  choosing?: boolean; // something is chosen and nothing is typed: the keys move the choice, and react to a message
  opens?: boolean; // and Enter opens what it chose: the thread a card leads to, a relay's thread, a card's page
  reacts?: boolean; // and 1 2 3 react to it: it is a message
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

// `colours`: how much colour the terminal draws, for the yarn (homeView.ts).
export function renderChat(view: ChatViewData, cols: number, rows: number, light = false, colours: Colours = '256'): ChatFrame {
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
    // Only the items that show are laid out, each kept by the layout until it changes, beside the yarn.
    const layout = view.layout ?? new ChatLayout();
    const sending = new Set(view.sending);
    const look: Look = { colours, light };
    const yarn = only ? undefined : view.yarn;
    const gutter = yarnWidth(yarn, width);
    const laid = layout.lines(view.items, width - gutter.width, view.me, view.now, sending, view.selected, view.cards, look);
    let at = laid.find(view.top, body);
    for (let n = 0; n < body && at.item < view.items.length; n++) {
      const item = view.items[at.item];
      const lines = laid.of(at.item);
      if (at.line === 0 && !sending.has(item.key) && !item.home) times.push(item.at);
      if (at.line === lines.length - 1) seen.push(item.key);
      stream.push(yarn ? [...yarnParts(yarn, view.items, at.item, at.line, gutter.full, look), ...lines[at.line]] : lines[at.line]);
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
          ? [...(view.opens ? ([['Enter', 'open']] as [string, string][]) : []), ['Tab ↑', 'earlier'], ['↓', 'later'], ...(view.reacts ? ([['1', '👍'], ['2', '👎'], ['3', '👀']] as [string, string][]) : []), esc]
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
