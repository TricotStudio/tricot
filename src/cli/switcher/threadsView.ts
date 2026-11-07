// The board's threads in the Tricot tab, drawn as a panel beside the chat's
// stream (threadsTab.ts holds what is shown and takes the keys; chatView.ts
// draws the stream and puts the panel at its side): the list the page's
// threads button opens, in the rows above the line to type on.
//
//    Sam · in Pick up Codex's work · 22 min ago  │ Threads · 1 waiting on you
//      Codex left T17 half done. Can someone ta… │ Waiting on you · 1
//    Codex  agent · in Design · Picker spacing … │ ❯ ● Remember the thread pic…  just now
//      Tighter: 8 px between rows. The picture … │ Recent
//    Claude  agent · on T19 Stopped agents lea…  │     Design · Picker spaci…  15 min ago
//      ↓ 3 newer below                           │     Pick up Codex's work    22 min ago
//    ↑↓ pick · Enter read · n new · x delete · Esc close · l lens
//
// (the stream cut short here: it has two thirds of the window)
//
// A window of about a hundred columns or more has the panel at the stream's
// right, about a third of its width, a thin │ between them; a narrower one
// has it over the stream. The list is the page's (core/threadList.ts): what
// waits on the person first, then the rest by when they were last active,
// and the finished, quiet ones under Earlier, which show five until asked for
// the rest. A row is the title, with the lens before it unless it is General,
// and when it was last active; ● marks a thread waiting on the person, • one
// with replies they haven't seen. The ❯ before the highlighted row is bold
// while the panel has the keys, and dim while the line under the stream has
// them (a thread picked from it, which the stream then shows alone).
//
// The lens picker, and the question before a thread is deleted, take the
// panel's place. The picker has a row for each lens with its brief dimmed
// after the name, ❯ and bold on the highlighted one, ✓ before the current
// one. Asking for a lens of one's own, it says what to type and the line at
// the foot takes it (the same line, drawn as a reply's is). A refusal is the
// last row of the picker. While the panel, the picker or the question has the
// keys, the last row says them: the key for the lens last, so a narrow window
// or what waits on the person elsewhere cuts it first.
//
// The panel and the stream share the rest. A message's text is drawn as
// written (messageRows: Markdown included, a control character as its
// picture, tabView.ts asSent, never sent to the terminal), and under a
// message that has reactions, one line says them as the page's chips do, 👍
// 👎 👀 in that order with who left each (the person as You, in bold; two
// names and then a count: "Claude, Codex +2"), an agent's too.
//
// The foot has the line a message is typed on (› and the text, cut around
// the cursor, which the frame says the place of), with the row under it
// saying who will get the message or why it didn't go (threadsWho.ts), and,
// while an @ or / can be completed, the row above it listing what Tab
// completes to, the one written next in bold. The line runs under the stream
// and the panel, and it and its rows sit on one band across the window. A
// window too short for the rows around it keeps the line, and the row above
// it from six rows; one under eight rows says what is wrong in place of the
// keys, never anything else.
//
// The last row is the keys, and what waits on the person elsewhere. Words are
// in the terminal's own colours, with bold, dim and the alert colour. The
// line's band is the one background: a shade off the terminal's, from the
// 256 colours as the strip's bar is (bandOf), so what is being typed reads
// apart from the conversation above it; not the bar's shade, so the two
// don't read as one. The keys under it are on the terminal's own background.
import { samePerson } from '../../core/format';
import { reactionGroups } from '../../core/reactions';
import type { ThreadEntry, ThreadGroups } from '../../core/threadList';
import { shownTitle } from '../../core/threads';
import type { Reaction } from '../../core/types';
import { columns, columnsOf, fit, type Tone } from './strip';
import { BOLD, DIM, ago, alertOf, asSent, cutParts, oneLine, onBand, paint, tail, yesNo, type Part, type TabFrame } from './tabView';

// ---- what is in the list -----------------------------------------------------------

export type ListItem = { kind: 'thread'; entry: ThreadEntry } | { kind: 'more'; count: number };

// The id of the "show more" row, which no thread has.
export const MORE = '\u0000more';
export const itemId = (item: ListItem): string => (item.kind === 'thread' ? item.entry.thread.id : MORE);

// Earlier shows this many until asked for the rest, as the page's list does.
export const EARLIER_SHOWN = 5;

// The rows a key can pick, in the order they are drawn.
export function listItems(groups: ThreadGroups, allEarlier: boolean): ListItem[] {
  const threads = (entries: ThreadEntry[]): ListItem[] => entries.map((entry) => ({ kind: 'thread', entry }));
  const earlier = allEarlier ? groups.earlier : groups.earlier.slice(0, EARLIER_SHOWN);
  const hidden = groups.earlier.length - earlier.length;
  return [...threads(groups.waiting), ...threads(groups.recent), ...threads(earlier), ...(hidden ? [{ kind: 'more' as const, count: hidden }] : [])];
}

// ---- the window's shape --------------------------------------------------------------

// From this many columns the panel is beside the stream; under, it is over it.
export const WIDE_FROM = 100;
const INDENT = 4; // a message's text, under who wrote it

// The panel's columns in a window `cols` wide, and whether it is beside the
// stream: about a third of a wide window, from thirty to forty-four
// columns; all of a narrow one, over the stream.
export function panelGeometry(cols: number): { wide: boolean; width: number } {
  const wide = cols >= WIDE_FROM;
  return { wide, width: wide ? Math.min(44, Math.max(30, Math.floor(cols / 3))) : cols };
}

// The rows at the foot of a window `rows` tall for the line to type on: the
// line itself, the row under it saying who will get the message (from eight
// rows), and the row above it listing what Tab completes to while there is
// something to list (from six).
export interface Foot {
  candidates: boolean;
  status: boolean;
  rows: number;
}

export function composeFoot(rows: number, candidates: boolean): Foot {
  const status = rows >= 8;
  const listed = candidates && rows >= 6;
  return { candidates: listed, status, rows: 1 + Number(status) + Number(listed) };
}

// The first row lines can be scrolled to and still fill the rows: showing the latest.
export const maxTop = (total: number, body: number): number => Math.max(0, total - body);

// ---- a message, laid out ------------------------------------------------------------

export interface Laid {
  lines: Part[][];
  starts: number[]; // the line each message begins on
}

// One line of text cut into lines of at most `width` columns, at a space where
// there is one, and else inside a word. A line's own indentation (a code
// block's) goes on to the lines it is cut into, and a list item's ("- ", "* ",
// "1. ") goes on to under its text, not under its marker. Each character is
// measured once, its columns added to the row's so far, so a long message
// costs its length and not its length squared.
export function wrapLine(line: string, width: number): string[] {
  const out: string[] = [];
  const hang = /^ *(?:[-*+]|\d+[.)]) +/.exec(line)?.[0] ?? /^ */.exec(line)![0];
  const pad = ' '.repeat(Math.min(hang.length, Math.floor(width / 2)));
  const text = line.trimEnd();
  // A row is `lead` (nothing on the first, the pad on the rest), then the text from `from`.
  let lead = '';
  let from = 0;
  for (;;) {
    let used = lead.length; // the pad's spaces, a column each
    let at = from; // the first character that doesn't fit
    let space = -1; // the last space that does
    while (at < text.length) {
      const code = text.codePointAt(at)!;
      const size = columnsOf(code);
      if (used + size > width) break;
      if (code === 32) space = at;
      used += size;
      at += code > 0xffff ? 2 : 1;
    }
    if (at === text.length) {
      out.push(lead + text.slice(from));
      return out;
    }
    // At the end of what fits when a space comes next; else at the last space in it past the line's indentation, or
    // inside the word, taking one character at least: after the pad, even where it doesn't fit beside it (a wide one at
    // a width of two), so the row is never the pad alone.
    const cut = text[at] === ' ' ? at : space > pad.length ? space : at > from ? at : from + (text.codePointAt(from)! > 0xffff ? 2 : 1);
    out.push((lead + text.slice(from, cut)).trimEnd());
    const remainder = text.slice(cut).trimStart();
    if (!remainder) return out;
    from = text.length - remainder.length;
    lead = pad;
  }
}

// Names on a reaction before the rest are counted, as the page's chips do: "Claude, Codex +2".
const NAMED = 2;

const isMe = (by: Reaction['by'], me: string) => by.kind === 'human' && samePerson(by.name, me);

// "You", "Claude, Codex", "Claude, Codex +2".
function reactors(reactions: Reaction[], me: string): string {
  const all = reactions.map((r) => (isMe(r.by, me) ? 'You' : oneLine(r.by.name)));
  return all.length > NAMED ? `${all.slice(0, NAMED).join(', ')} +${all.length - NAMED}` : all.join(', ');
}

// The reactions under a message, on one line: "👍 You · 👀 Claude, Codex". The person's own are bold.
function reactionsLine(reactions: Reaction[] | undefined, me: string, width: number): Part[] | undefined {
  const groups = reactionGroups(reactions);
  if (!groups.length) return undefined;
  const parts: Part[] = [[' '.repeat(INDENT)]];
  groups.forEach(({ emoji, reactions: these }, i) => {
    if (i) parts.push([' · ', DIM]);
    parts.push([`${emoji} `], [reactors(these, me), these.some((r) => isMe(r.by, me)) ? BOLD : DIM]);
  });
  return cutParts(parts, width);
}

// A message's text under who wrote it, wrapped to `width` and indented, a
// control character as its picture (asSent), and the line of its reactions
// under it, if it has any: the chat's stream draws its items so (chatView.ts).
export function messageRows(body: string, reactions: Reaction[] | undefined, width: number, me: string): Part[][] {
  const rows: Part[][] = [];
  const room = Math.max(1, width - INDENT - 1);
  for (const text of body.split(/\r\n|\r|\n/)) for (const row of wrapLine(asSent(text), room)) rows.push(row ? [[' '.repeat(INDENT) + row]] : []);
  const reacted = reactionsLine(reactions, me, Math.max(1, width - 1));
  if (reacted) rows.push(reacted);
  return rows;
}

// ---- the panel ------------------------------------------------------------------------

export interface PanelView {
  // Said in the list's place when there is no list to show: reading, or why it can't be read.
  status?: { text: string; hint?: string; tone?: 'alert' };
  groups: ThreadGroups;
  allEarlier: boolean;
  at?: string; // the id of the row highlighted
  keys: boolean; // the panel (or the picker, or the question in its place) has the keys
  lens?: LensView; // the lenses to pick from, in the list's place
  deletion?: { title: string; yes: boolean; busy: boolean; said?: { text: string; tone: Tone } };
  undo?: boolean; // the last deletion can be undone from the list
  said?: { text: string; tone: Tone }; // what became of a deletion, or of undoing it
  now: number;
}

// A lens to pick, as a row.
export interface LensRow {
  name: string;
  brief?: string;
  current: boolean; // the thread's lens now
  fresh?: boolean; // the row that asks for a lens of one's own
}

// The lens picker: the thread it is for, the rows with the one highlighted,
// what Enter does, and what to say (a refusal), or, while a lens of one's own
// is asked for, what to type and what Enter does with it.
export interface LensView {
  title: string;
  rows: LensRow[];
  at: number;
  enter: 'set' | 'use'; // use: for a thread not started yet, which takes it with its first message
  said?: { text: string; tone: Tone };
  form?: { lines: string[]; enter: string };
}

// The line a message is typed on, at the foot under the stream.
export interface Compose {
  text: string;
  cursor: number; // an offset into the text
  navigation?: boolean; // the local command palette, without a message to send
  placeholder: string; // said in the line's place while nothing is typed
  // Who will get it, or why it did not go: the row under the line.
  status?: { text: string; tone: Tone };
  // What Tab completes to, one of them the next (or the one just written).
  choices?: { label: string; note?: string }[];
  at?: number;
}

// A line cut or padded to exactly `width` columns.
export function column(parts: Part[], width: number): Part[] {
  const cut = cutParts(parts, width);
  const used = cut.reduce((sum, [text]) => sum + columns(text), 0);
  return [...cut, [' '.repeat(Math.max(0, width - used))]];
}

function listLines(view: PanelView, width: number, light: boolean): { lines: Part[][]; on: number } {
  const alert = alertOf(light);
  const lines: Part[][] = [];
  let on = 0;
  const { groups } = view;
  const marker = view.keys ? BOLD : DIM;
  const heading = (text: string, count: number, sgr = BOLD) => lines.push([[` ${text}`, sgr], ...(count ? ([[` · ${count}`, DIM]] as Part[]) : [])]);
  const thread = ({ entry }: Extract<ListItem, { kind: 'thread' }>) => {
    const { thread: t, waiting, unread } = entry;
    const here = t.id === view.at;
    if (here) on = lines.length;
    const lens = t.lens && t.lens.name !== 'General' ? `${oneLine(t.lens.name)} · ` : '';
    const when = ago(t.updatedAt, view.now);
    const room = width - 5 - columns(lens);
    // The time stays unless the title would be left with next to nothing.
    const keepTime = room - columns(when) - 3 >= 8;
    const title = fit(oneLine(shownTitle(t)), Math.max(1, keepTime ? room - columns(when) - 3 : room));
    const gap = keepTime ? width - 5 - columns(lens) - columns(title) - columns(when) - 1 : 0;
    lines.push([[` ${here ? '❯' : ' '} `, marker], [waiting ? '● ' : unread ? '• ' : '  ', alert], ...(lens ? ([[lens, DIM]] as Part[]) : []), [title, waiting || here ? BOLD : undefined], ...(keepTime ? ([[' '.repeat(gap)], [when, DIM], [' ']] as Part[]) : [])]);
  };
  const some = groups.waiting.length + groups.recent.length + groups.earlier.length > 0;
  const items = listItems(groups, view.allEarlier);
  let next = 0;
  const rows = (count: number) => items.slice(next, (next += count));
  const drawn = (list: ListItem[]) => {
    for (const item of list) {
      if (item.kind === 'thread') thread(item);
      else {
        const here = view.at === MORE;
        if (here) on = lines.length;
        lines.push([[` ${here ? '❯' : ' '} `, marker], [`  Show ${item.count} more`, here ? BOLD : DIM]]);
      }
    }
  };
  if (groups.waiting.length) {
    heading('Waiting on you', groups.waiting.length, `${BOLD};${alert}`);
    drawn(rows(groups.waiting.length));
  }
  if (groups.recent.length) {
    if (groups.waiting.length || groups.earlier.length) heading('Recent', 0);
    drawn(rows(groups.recent.length));
  }
  if (groups.earlier.length) {
    heading('Earlier', 0);
    drawn(rows(items.length - next));
  }
  if (!some) lines.push([]);
  return { lines, on };
}

// Words from the board (an agent's name is among them) on one line, safe to draw.
export const safe = (text: string): string => asSent(oneLine(text));

// The lenses to pick from: the thread it is for, a row each with its brief, scrolled so the highlighted one shows.
function lensRows(lens: LensView, width: number, body: number, light: boolean): Part[][] {
  const head: Part[] = [[' Lens', BOLD], [` · ${fit(oneLine(lens.title), Math.max(1, width - 9))}`, DIM]];
  if (lens.form) return [head, ...lens.form.lines.flatMap((text) => wrapLine(text, Math.max(1, width - 3))).map((text): Part[] => [[`  ${text}`, DIM]]).slice(0, body)];
  const room = Math.max(0, body - (lens.said ? 1 : 0));
  // The briefs line up after the longest name, unless a name is long: then that one pushes its own.
  const named = Math.min(14, Math.max(...lens.rows.map((row) => columns(oneLine(row.name)))));
  const lines = lens.rows.map((row, i): Part[] => {
    const here = i === lens.at;
    const name = oneLine(row.name);
    const gap = ' '.repeat(Math.max(0, named - columns(name)) + 2);
    const brief = row.brief ? ([[gap], [fit(oneLine(row.brief), Math.max(0, width - 6 - Math.max(named, columns(name)) - 2)), DIM]] as Part[]) : [];
    return [[` ${here ? '❯' : ' '} `, BOLD], [row.current ? '✓ ' : '  '], [name, here ? BOLD : undefined], ...brief];
  });
  const first = lines.length <= room ? 0 : Math.min(Math.max(0, lens.at - Math.floor(room / 2)), lines.length - room);
  const said: Part[][] = lens.said ? [[[` ${safe(lens.said.text)}`, lens.said.tone === 'alert' ? alertOf(light) : DIM]]] : [];
  return [head, ...lines.slice(first, first + room), ...said];
}

// The panel's rows, `height` of them at most, `width` wide: the question
// about deleting, the lens picker, or the list under its heading, scrolled so
// the highlighted row shows.
export function panelRows(view: PanelView, width: number, height: number, light = false): Part[][] {
  const alert = alertOf(light);
  const body = Math.max(0, height - 1); // under the heading
  const wrapped = (text: string, sgr: string | undefined): Part[][] => wrapLine(safe(text), Math.max(1, width - 3)).map((line): Part[] => [[`  ${line}`, sgr]]);
  if (view.deletion) {
    const { title, said } = view.deletion;
    const lines: Part[][] = [[[' Delete thread?', BOLD]], ...wrapLine(safe(title), Math.max(1, width - 3)).slice(0, 2).map((line): Part[] => [[`  ${line}`, DIM]])];
    lines.push(...(said ? wrapped(said.text, said.tone === 'alert' ? alert : DIM) : wrapped('Its tasks and decisions stay. You can undo this.', DIM)));
    return lines.slice(0, body + 1);
  }
  if (view.lens) return lensRows(view.lens, width, body, light);
  const waiting = view.groups.waiting.length;
  const head: Part[] = [[' Threads', BOLD], ...(waiting ? ([[` · ${waiting} waiting on you`, alert]] as Part[]) : [])];
  const said: Part[][] = view.said?.text ? wrapped(view.said.text, view.said.tone === 'alert' ? alert : DIM) : [];
  if (view.status) {
    said.push([[`  ${view.status.text}`, view.status.tone === 'alert' ? alert : undefined]]);
    if (view.status.hint) said.push([[`  ${view.status.hint}`, DIM]]);
    return [head, ...said.slice(0, body)];
  }
  const { lines, on } = listLines(view, width, light);
  const room = Math.max(0, body - said.length);
  const first = lines.length <= room ? 0 : Math.min(Math.max(0, on - Math.floor(room / 2)), lines.length - room);
  return [head, ...said.slice(0, body), ...lines.slice(first, first + room)];
}

// The keys while the panel has them, for lastRow: the list's, the picker's or
// the question's. `more`: the key for the lens, said last; `compact`: the
// keys without their words, for a narrow window.
export function panelKeys(view: PanelView): (more: boolean, compact: boolean) => Part[] {
  const key = (k: string, words: string): Part[] => [[k, BOLD], ...(words ? [[` ${words}`] as Part] : [])];
  const sep: Part = [' · '];
  const thread = view.at !== undefined && view.at !== MORE;
  return (more, compact) => {
    if (view.deletion) return [[' '], ...(view.deletion.busy ? [['Deleting the thread…'] as Part] : [...yesNo(view.deletion.yes), sep, ...key('←→', compact ? '' : 'choose'), sep, ...key('Enter', compact ? '' : 'confirm'), sep, ...key('Esc', compact ? '' : 'cancel')])];
    if (view.lens?.form) return [[' '], ...key('Enter', view.lens.form.enter), sep, ...key('Esc', 'back to the lenses')];
    if (view.lens) return [[' '], ...key('↑↓', 'pick'), sep, ...key('Enter', view.lens.enter), sep, ...key('Esc', 'cancel')];
    const actions: [string, string][] = [['↑↓', compact ? '' : 'pick'], ['Enter', compact ? '' : 'read'], ['n', compact ? '' : 'new']];
    if (thread) actions.push(['x', 'delete']);
    if (view.undo) actions.push(['u', 'undo']);
    actions.push(['Esc', compact ? '' : 'close']);
    if (more && thread) actions.push(['l', 'lens']);
    return [[' '], ...actions.flatMap(([k, words], i) => [...(i ? [[compact ? '  ' : ' · '] as Part] : []), ...key(k, words)])];
  };
}

// ---- the foot, which the panel and the stream share --------------------------------

// The row of what Tab completes to: each by its label, the one Tab writes next in bold,
// shifted left so that one is in view.
function choicesRow(compose: Compose, cols: number): Part[] {
  const choices = compose.choices ?? [];
  const cells = choices.map(({ label, note }, i): Part[] => [[safe(label), i === (compose.at ?? 0) ? BOLD : undefined], ...(note ? ([[` ${safe(note)}`, DIM]] as Part[]) : []), ['  ']]);
  const width = (cell: Part[]) => cell.reduce((sum, [text]) => sum + columns(text), 0);
  const lead: Part = [' Tab ', DIM];
  const room = cols - columns(lead[0]) - 2;
  let first = 0;
  const at = Math.min(compose.at ?? 0, cells.length - 1);
  while (first < at && cells.slice(first, at + 1).reduce((sum, cell) => sum + width(cell), 0) > room) first++;
  return [lead, ...(first > 0 ? ([['… ', DIM]] as Part[]) : []), ...cells.slice(first).flat()];
}

// The line itself: a prompt, then what is typed (or what to type) cut to the
// width around the cursor, which is the column it stands at.
function lineRow(compose: Compose, cols: number): { parts: Part[]; x: number } {
  const prompt: Part = [' › ', BOLD];
  const room = Math.max(1, cols - columns(prompt[0]) - 1);
  if (!compose.text) return { parts: [prompt, [fit(safe(compose.placeholder), room), DIM]], x: columns(prompt[0]) };
  const before = asSent(compose.text.slice(0, compose.cursor));
  const after = asSent(compose.text.slice(compose.cursor));
  const near = columns(before) < room ? before : `…${tail(before, room - 2)}`;
  const rest = fit(after, Math.max(0, room - columns(near)));
  return { parts: [prompt, [near], [rest]], x: columns(prompt[0]) + columns(near) };
}

// The band the line to type on sits on, from the 256 colours: a shade off the
// terminal's background, light or dark, and not the strip's, so the two don't
// read as one.
export const bandOf = (light: boolean) => (light ? '48;5;253' : '48;5;237');

// The rows the line to type on takes at the foot (`foot`, composeFoot's),
// drawn on its band across the window: what Tab completes to above it, the
// line, and who will get it under it. `cursor` is where it stands: its
// column, and the line's row among these.
export function composeRows(compose: Compose, foot: Foot, cols: number, light = false): { rows: Part[][]; cursor: { x: number; y: number } } {
  const alert = alertOf(light);
  const rows: Part[][] = [];
  if (foot.candidates) rows.push(choicesRow(compose, cols));
  const typing = lineRow(compose, cols);
  const cursor = { x: typing.x, y: rows.length };
  rows.push(typing.parts);
  if (foot.status && compose.status) rows.push([[` ${safe(compose.status.text)}`, compose.status.tone === 'alert' ? alert : DIM]]);
  else if (foot.status) rows.push([]);
  return { rows: rows.map((row) => onBand(row, bandOf(light), cols)), cursor };
}

// The last row: the keys, and what waits on the person elsewhere at its right.
// `keysRow` gives them with the key for the lens or without it, and with their
// words or compact: the lens goes first, then the words, as the width needs.
// In a window too short for the row under the line, what is wrong takes the
// keys' place.
export function lastRow(keysRow: (lens: boolean, compact: boolean) => Part[], compose: Compose | undefined, foot: Foot | undefined, notice: string | undefined, cols: number, light = false): Part[] {
  const alert = alertOf(light);
  if (compose?.status?.tone === 'alert' && foot && !foot.status) return [[` ${safe(compose.status.text)}`, alert]];
  const noticeParts: Part[] = notice ? [[notice, alert], [' ']] : [];
  const used = (parts: Part[]) => parts.reduce((sum, [text]) => sum + columns(text), 0);
  const full = keysRow(true, false);
  const noticeWidth = noticeParts.length ? 3 + used(noticeParts) : 0;
  let keys = used(full) + noticeWidth > cols ? keysRow(false, false) : full; // the lens hint is the first to go
  if (used(keys) + noticeWidth > cols) keys = keysRow(false, true);
  return noticeParts.length && used(keys) + 3 + used(noticeParts) <= cols ? [...keys, [' '.repeat(cols - used(keys) - used(noticeParts))], ...noticeParts] : keys;
}

// Rows drawn as a frame `rows` tall: a window too short for them all loses
// those at the top first, so the line and the keys stay. `cursor` is the
// line's, among the rows, and is kept while it shows.
export function framed(parts: Part[][], rows: number, cols: number, cursor?: { x: number; y: number }): TabFrame {
  const cut = Math.max(0, parts.length - rows);
  const out: TabFrame = { rows: [], plain: [] };
  for (const row of parts.slice(cut)) {
    const { line, plain } = paint(row, cols);
    out.rows.push(line);
    out.plain.push(plain);
  }
  if (cursor && cursor.y >= cut) out.cursor = { x: Math.min(cols - 1, cursor.x), y: cursor.y - cut };
  return out;
}
