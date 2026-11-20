// The list plain `tricot connect` shows (connectAll.ts): one row per agent
// found on this computer, those it would connect ticked, moved through with the
// arrow keys and ticked or unticked with Space; Enter goes on with the ticked
// ones, Esc or Ctrl+C cancels. Rows that can't be ticked (an agent already
// connected, one Tricot can't connect) are shown with why, and the cursor
// passes them by.
//
// With more than one row to tick, the list opens with "All agents", a row that
// ticks every other tickable row: [-] while only some are ticked, [x] when all
// are, [ ] when none. Space on it ticks them all, and Space again clears them
// all (`a` does the same from any row). The cursor starts on the first agent,
// so a Space is never an "all" by accident; the master row is one up.
//
// `?` prints the longer explanation the caller gave (`details`) above the list,
// as plain lines the terminal scrolls, and draws the list again under it, so
// the list itself can say little and still show every file and line on request.
//
// It draws on the terminal it is given, in place, as the board picker does
// (boardPicker.ts), so tests feed it keys and read what it drew. The same rows
// are written once, without the cursor, where there are no keys to read
// (staticRows).
import { cancels, cut, drawer, HIDE_CURSOR, lineWidth, pad, readKeys, SHOW_CURSOR, styles, chars, type Styles, type TerminalKeys } from './terminalDraw';

export interface TickRow {
  label: string; // "Claude Code"
  note: string; // what it needs a decision about, or why it can't be ticked: empty when there is nothing to say
  // tick: it can be ticked (`ticked` says whether it starts so); done: there
  // already (✓); none: it can't be.
  kind: 'tick' | 'done' | 'none';
  ticked?: boolean;
}

export interface TickOptions {
  question: string; // "Connect them to your board?"
  rows: TickRow[];
  footer?: string; // a sentence under the rows, while the list is up
  details?: string[]; // what `?` shows; without it, there is no `?`
  // What Enter does in the hint ("connect"), and what the answer says once given: the ticked ones, none, or cancelled.
  words?: { enter?: string; chose?: (names: string) => string; none?: string; cancelled?: string };
  all?: false; // no "All agents" row, where ticking every one isn't a choice people make (which agents to start)
}

const MASTER = 'All agents';
const MASTER_AT = -1; // the cursor's place on it, in `stops`
const hintOf = (options: TickOptions) => `↑↓ move · space tick · enter ${options.words?.enter ?? 'connect'}${options.details ? ' · ? details' : ''}`;

// The rows ticked when Enter was pressed, by their place in the list; none: cancelled.
export async function pickTicked(term: TerminalKeys, options: TickOptions): Promise<number[] | undefined> {
  const keys = readKeys(term);
  let draw = drawer(term);
  const look = styles(Boolean(term.color));
  const width = lineWidth(term);
  const ticked = options.rows.map((row) => row.kind === 'tick' && Boolean(row.ticked));
  const movable = options.rows.flatMap((row, i) => (row.kind === 'tick' ? [i] : []));
  const master = movable.length > 1 && options.all !== false;
  const stops = master ? [MASTER_AT, ...movable] : movable; // where the cursor can be: a row's place, or the master row
  let at = master ? 1 : 0; // a place in `stops`
  const toggleAll = () => {
    const on = !movable.every((i) => ticked[i]);
    for (const i of movable) ticked[i] = on;
  };
  // The question with the answer after it where both fit, else the answer alone.
  const answered = (answer: string, shown: (text: string) => string) =>
    chars(options.question).length + 1 + chars(answer).length <= width ? `${options.question} ${shown(answer)}` : `${shown(cut(answer, width))}`;
  try {
    term.write(HIDE_CURSOR);
    for (;;) {
      draw(listLines(options, ticked, master, stops[at], width, look));
      const key = await keys.next();
      if (cancels(key)) {
        draw([answered(options.words?.cancelled ?? 'cancelled', look.dim)]);
        return undefined;
      }
      if (key.name === 'up' || key.name === 'k') at = (at - 1 + stops.length) % stops.length;
      else if (key.name === 'down' || key.name === 'j') at = (at + 1) % stops.length;
      else if (key.name === 'home') at = 0;
      else if (key.name === 'end') at = stops.length - 1;
      else if (key.name === 'space' || key.sequence === ' ') {
        if (stops[at] === MASTER_AT) toggleAll();
        else ticked[stops[at]] = !ticked[stops[at]];
      } else if (master && key.sequence === 'a') toggleAll();
      else if (options.details && key.sequence === '?') {
        draw([]);
        term.write(`${options.details.join('\n')}\n`);
        draw = drawer(term); // the list it drew is gone: it starts again under the explanation
      } else if (key.name === 'return' || key.name === 'enter') {
        const chosen = ticked.flatMap((on, i) => (on ? [i] : []));
        const names = master && movable.every((i) => ticked[i]) ? 'all agents' : chosen.map((i) => options.rows[i].label).join(', ');
        const said = options.words;
        draw([answered(names ? (said?.chose ?? ((ticked) => `Ticked: ${ticked}`))(names) : (said?.none ?? 'None ticked'), look.accent)]);
        return chosen;
      }
    }
  } finally {
    keys.stop();
    term.write(`\n${SHOW_CURSOR}`);
  }
}

// A row of the list as drawn: `on` is 'some' only for the master row.
interface Line {
  label: string;
  note: string;
  kind: TickRow['kind'];
  on: boolean | 'some';
}

const markOf = (line: Line) => (line.kind === 'done' ? ' ✓ ' : line.kind === 'none' ? ' – ' : line.on === 'some' ? '[-]' : line.on ? '[x]' : '[ ]');

const linesOf = (rows: TickRow[], ticked: boolean[]): Line[] => rows.map((row, i) => ({ label: row.label, note: row.note, kind: row.kind, on: ticked[i] }));

function rowLines(lines: Line[], width: number, look: Styles, cursor?: number, lead = '   '): string[] {
  const labelWidth = Math.max(...lines.map((line) => chars(line.label).length));
  return lines.map((line, i) => {
    const here = i === cursor;
    const start = cursor === undefined ? lead : here ? ` ${look.accent('❯')} ` : '   ';
    const room = Math.max(0, width - 3 - 4 - labelWidth - 2);
    const note = cut(line.note, room);
    const label = note ? pad(line.label, labelWidth) : line.label;
    const shown = !note ? '' : `  ${line.kind === 'tick' ? note : look.dim(note)}`;
    return `${start}${markOf(line)} ${here ? look.bold(label) : label}${shown}`;
  });
}

// Text broken at spaces into lines of at most `width` characters.
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && chars(line).length + 1 + chars(word).length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  return [...lines, line];
}

// The question, with the keys after it where they fit, else on a line of their own under the rows; the master row
// first when there is one, the footer last. `cursor`: a row's place, or the master row's.
function listLines(options: TickOptions, ticked: boolean[], master: boolean, cursor: number, width: number, look: Styles): string[] {
  const hint = hintOf(options);
  const fits = chars(options.question).length + chars(hint).length + 2 <= width;
  const question = fits ? `${options.question}  ${look.dim(hint)}` : cut(options.question, width);
  const rows = linesOf(options.rows, ticked);
  const own = rows.filter((row) => row.kind === 'tick');
  const all: Line = { label: MASTER, note: '', kind: 'tick', on: own.every((row) => row.on) ? true : own.some((row) => row.on) ? 'some' : false };
  const lines = master ? [all, ...rows] : rows;
  const here = master ? (cursor === MASTER_AT ? 0 : cursor + 1) : cursor;
  const footer = options.footer ? wrap(options.footer, width).map((line) => look.dim(line)) : [];
  return [question, ...rowLines(lines, width, look, here), ...(fits ? [] : [look.dim(cut(hint, width))]), ...footer];
}

// The rows as lines to print once, each in full: where there are no keys to
// tick with (--yes, --print, no terminal), ticked as they would start.
export function staticRows(rows: TickRow[]): string[] {
  return rowLines(linesOf(rows, rows.map((row) => row.kind === 'tick' && Boolean(row.ticked))), Infinity, styles(false), undefined, '  ');
}
