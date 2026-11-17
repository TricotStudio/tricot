// The board picker `tricot claude` shows when it isn't given --board: the
// boards updated most recently, moved through with the arrow keys and picked
// with Enter, and "＋ New board…" last, which asks for a name (the folder's,
// to start with). Esc or Ctrl+C cancels. The board last used in this folder
// starts highlighted (chooseBoard.ts remembers it).
//
// It draws on the terminal it is given, in place (each key redraws the
// lines it drew), so tests feed it keys and read what it drew; terminal.ts
// is the real one, in raw mode, put back as it was however the picker ends.
import { cancels, chars, cut, drawer, HIDE_CURSOR, lineWidth, pad, readKeys, SHOW_CURSOR, styles, typed, type KeyReader, type Styles, type TerminalKeys } from './terminalDraw';

export type { Key, TerminalKeys } from './terminalDraw';

export interface PickerBoard {
  id: string;
  title: string;
  updatedAt: string;
}

export interface PickerOptions {
  question: string; // "Which board should Claude work on?"
  boards: PickerBoard[]; // most recently updated first
  lastHere?: string; // the board last used in this folder
  newName: string; // what the new board's name starts as: the folder's
  maxName: number; // the longest a board's title may be
  now?: number;
}

// The board picked, the name for a new one, or nothing: cancelled.
export type Picked = { board: PickerBoard } | { title: string } | undefined;

export const NEW_BOARD = '＋ New board…';
const HINT = '(↑↓ to move, Enter to pick, Esc to cancel)';
const NAME_PROMPT = 'Name the new board: ';

export async function pickBoard(term: TerminalKeys, options: PickerOptions): Promise<Picked> {
  const keys = readKeys(term);
  const draw = drawer(term);
  const look = styles(Boolean(term.color));
  const width = lineWidth(term);
  const count = options.boards.length + 1;
  let at = Math.max(0, options.boards.findIndex((board) => board.id === options.lastHere));
  const answered = (answer: string) => `${cut(options.question, width - 2)} ${look.accent(cut(answer, width - options.question.length - 1))}`;
  try {
    term.write(HIDE_CURSOR);
    for (;;) {
      draw(listLines(options, at, width, look));
      const key = await keys.next();
      if (cancels(key)) {
        draw([`${cut(options.question, width - 2)} ${look.dim('cancelled')}`]);
        return undefined;
      }
      if (key.name === 'up' || key.name === 'k') at = (at - 1 + count) % count;
      else if (key.name === 'down' || key.name === 'j') at = (at + 1) % count;
      else if (key.name === 'home') at = 0;
      else if (key.name === 'end') at = count - 1;
      else if (key.name === 'return' || key.name === 'enter') {
        if (at < options.boards.length) {
          draw([answered(options.boards[at].title)]);
          return { board: options.boards[at] };
        }
        const head = answered('New board');
        const title = await nameIt(term, keys, draw, head, options, width);
        return title === undefined ? undefined : { title };
      }
    }
  } finally {
    keys.stop();
    term.write(`\n${SHOW_CURSOR}`);
  }
}

// The new board's name, on a line of its own, edited as it is typed: Enter
// takes it, Backspace takes a character off, Ctrl+U clears it.
async function nameIt(term: TerminalKeys, keys: KeyReader, draw: (lines: string[]) => void, head: string, options: PickerOptions, width: number): Promise<string | undefined> {
  let text = options.newName.slice(0, options.maxName);
  const room = Math.max(8, width - NAME_PROMPT.length);
  const line = () => `${NAME_PROMPT}${chars(text).length > room ? `…${chars(text).slice(-(room - 1)).join('')}` : text}`;
  term.write(SHOW_CURSOR);
  for (;;) {
    draw([head, line()]);
    const key = await keys.next();
    if (cancels(key)) {
      draw([head, `${NAME_PROMPT}${styles(Boolean(term.color)).dim('cancelled')}`]);
      return undefined;
    }
    if (key.name === 'return' || key.name === 'enter') {
      if (text.trim()) {
        text = text.trim();
        draw([head, line()]);
        return text;
      }
    } else if (key.name === 'backspace') text = chars(text).slice(0, -1).join('');
    else if (key.ctrl && key.name === 'u') text = '';
    else if (typed(key)) text = chars(text + key.sequence).slice(0, options.maxName).join('');
  }
}

function listLines(options: PickerOptions, at: number, width: number, look: Styles): string[] {
  const now = options.now ?? Date.now();
  // Titles get up to 36 columns, less on a narrow terminal, keeping room for when each was updated.
  const longest = Math.max(NEW_BOARD.length, ...options.boards.map((board) => chars(board.title).length));
  const titleWidth = Math.max(NEW_BOARD.length, Math.min(36, longest, width - 5 - 18));
  const question = chars(options.question).length + HINT.length + 2 <= width ? `${options.question}  ${look.dim(HINT)}` : cut(options.question, width);
  const rows = options.boards.map((board, index) => {
    const here = board.id === options.lastHere ? '   · last used here' : '';
    const meta = cut(`updated ${updatedAgo(board.updatedAt, now)}${here}`, Math.max(0, width - titleWidth - 5));
    const title = pad(cut(board.title, titleWidth), titleWidth);
    return `${mark(index === at, look)}${index === at ? look.bold(title) : title}  ${look.dim(meta)}`;
  });
  const last = options.boards.length;
  return [question, ...rows, `${mark(at === last, look)}${at === last ? look.bold(NEW_BOARD) : NEW_BOARD}`];
}

const mark = (on: boolean, look: Styles) => (on ? ` ${look.accent('❯')} ` : '   ');

// How long ago, as a person says it: "3 min ago", "yesterday", "last week".
export function updatedAgo(iso: string, now = Date.now()): string {
  const minutes = (now - Date.parse(iso)) / 60_000;
  if (!(minutes >= 1)) return 'just now';
  if (minutes < 60) return `${Math.floor(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return 'last month';
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return 'over a year ago';
}
