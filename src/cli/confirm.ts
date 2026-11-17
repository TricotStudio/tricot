// A yes/no question in the `tricot` command, on one line where it fits: the
// question, then Yes and No, the one a bare Enter gives marked ❯ and bold. ←→ (or h and l,
// or Tab) move the mark and Enter answers what it is on; y and n answer at
// once, Enter included, whichever case. Esc is ignored, as are other keys: an
// empty answer is the default, but Esc isn't one. Ctrl+C is not read by the
// terminal as a signal in raw mode, so it comes back as `interrupt` for the
// caller to act on.
//
// It draws on the terminal it is given (boardPicker.ts has the same kind of
// terminal and look), the cursor hidden while it listens and shown again
// however it ends. Where the question and the pair don't fit on a line, the
// question is written in full, wrapped, and the pair is on a line below it. The
// answer stays on screen, as the board picker's does: "Run it…? Yes". Where stdout isn't a terminal there are no keys to
// read, and askLine asks the plain way, with [y/N] after the question.
import { chars, drawer, HIDE_CURSOR, lineWidth, SHOW_CURSOR, styles, type Key, type Styles, type TerminalKeys } from './terminalDraw';

// Ctrl+C at a question: nothing was changed and the command is to stop (the
// top level says so quietly, main.ts, with the exit code a shell gives Ctrl+C).
export class Interrupted extends Error {
  constructor() {
    super('Aborted with Ctrl+C');
    this.name = 'Interrupted';
  }
}

// `left`: what it asked about went away meanwhile (the signal aborted).
export type Confirmed = 'yes' | 'no' | 'left' | 'interrupt';

const HINT = '(←→ Enter, or y/n)';
const YES = 'Yes';
const NO = 'No';
const PAIR_WIDTH = 2 + YES.length + 2 + 2 + NO.length;
const ELSEWHERE = '(answered elsewhere)';

const option = (label: string, on: boolean, look: Styles) => (on ? `${look.accent('❯')} ${look.bold(label)}` : `  ${label}`);

// The question in lines no wider than `width`, broken between words, never cut.
function wrap(question: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of question.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      let rest = chars(word);
      while (rest.length > width) {
        if (line) lines.push(line);
        lines.push(rest.slice(0, width).join(''));
        rest = rest.slice(width);
        line = '';
      }
      const text = rest.join('');
      if (!line) line = text;
      else if (chars(line).length + 1 + rest.length <= width) line += ` ${text}`;
      else {
        lines.push(line);
        line = text;
      }
    }
    lines.push(line);
  }
  return lines;
}

// What is drawn for one question: the question on a line with the pair and the
// answer after it when it all fits, else the question in full, as lines written
// once, and the pair (with the hint where it fits) and then the answer on a
// line of its own below, the only one redrawn. The question is never cut: it
// may hold what the person has to check, such as a code.
function layout(question: string, width: number, look: Styles) {
  const stacked = chars(question).length + 1 + Math.max(PAIR_WIDTH, chars(ELSEWHERE).length) > width;
  const pair = (yesOn: boolean) => `${option(YES, yesOn, look)}  ${option(NO, !yesOn, look)}`;
  const withHint = (line: string, used: number) => (used + 2 + HINT.length <= width ? `${line}  ${look.dim(HINT)}` : line);
  return {
    head: stacked ? `${wrap(question, width).join('\n')}\n` : '',
    asking: (yesOn: boolean) => (stacked ? withHint(pair(yesOn), PAIR_WIDTH) : withHint(`${question} ${pair(yesOn)}`, chars(question).length + 1 + PAIR_WIDTH)),
    answered: (said: string) => (stacked ? `  ${said}` : `${question} ${said}`),
  };
}

export function confirm(term: TerminalKeys, question: string, fallback = false, cancelled?: AbortSignal): Promise<Confirmed> {
  const look = styles(Boolean(term.color));
  const { head, asking, answered } = layout(question, lineWidth(term), look);
  const draw = drawer(term);
  const leave = (said: string) => {
    draw([answered(said)]);
    term.write('\n');
  };
  if (cancelled?.aborted) {
    term.write(head);
    leave(look.dim(ELSEWHERE));
    return Promise.resolve('left');
  }
  return new Promise((resolve, reject) => {
    let yesOn = fallback;
    let done = false;
    let stop: (() => void) | undefined;
    const finish = (answer: Confirmed, said: string) => {
      if (done) return;
      done = true;
      cancelled?.removeEventListener('abort', onAbort);
      stop?.();
      leave(said);
      term.write(SHOW_CURSOR);
      resolve(answer);
    };
    const onAbort = () => finish('left', look.dim(ELSEWHERE));
    const answerOf = (yes: boolean) => finish(yes ? 'yes' : 'no', look.accent(yes ? YES : NO));
    const onKey = (key: Key) => {
      if (done) return;
      if (key.ctrl && key.name === 'c') return finish('interrupt', look.dim('cancelled'));
      const char = (key.sequence ?? '').toLowerCase();
      if (!key.ctrl && !key.meta && char === 'y') return answerOf(true);
      if (!key.ctrl && !key.meta && char === 'n') return answerOf(false);
      if (key.name === 'return' || key.name === 'enter') return answerOf(yesOn);
      const moved = key.name === 'left' || key.name === 'h' ? true : key.name === 'right' || key.name === 'l' ? false : key.name === 'tab' ? !yesOn : yesOn;
      if (moved !== yesOn) {
        yesOn = moved;
        draw([asking(yesOn)]);
      }
    };
    term.write(`${HIDE_CURSOR}${head}`);
    draw([asking(yesOn)]);
    try {
      stop = term.listen(onKey);
    } catch (error) {
      term.write(`\n${SHOW_CURSOR}`);
      reject(error);
      return;
    }
    if (done) stop();
    else cancelled?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---- where there are no keys ----------------------------------------------------------

export interface LineIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

// The plain question, answered with a line: [Y/n] or [y/N] says what a bare Enter is.
export async function askLine(question: string, fallback = false, io: LineIo = { input: process.stdin, output: process.stdout }): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface(io);
  // With a listener, readline reports Ctrl+C here instead of closing the line.
  const interrupt = new AbortController();
  rl.once('SIGINT', () => interrupt.abort());
  try {
    const answer = (await rl.question(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `, { signal: interrupt.signal })).trim();
    return answer === '' ? fallback : /^y(es)?$/i.test(answer);
  } catch (error) {
    throw interrupt.signal.aborted ? new Interrupted() : error;
  } finally {
    rl.close();
  }
}

// What the command's `ask` is, where stdin is a terminal: the Yes / No pair
// where there are keys to read it with, else a line. Ctrl+C ends the question
// as it ended the line one: it throws Interrupted, which stops the command with nothing changed.
export function yesNoAsker(keys: TerminalKeys | undefined, io?: LineIo): (question: string, fallback?: boolean) => Promise<boolean> {
  return async (question, fallback = false) => {
    if (!keys) return askLine(question, fallback, io);
    const answer = await confirm(keys, question, fallback);
    if (answer === 'interrupt') throw new Interrupted();
    return answer === 'yes';
  };
}
