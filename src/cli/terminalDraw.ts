// What the board picker (boardPicker.ts) and the yes/no question (confirm.ts)
// draw and read with: the terminal's keys, a line or two redrawn in place, and
// the few styles and cuts that keep each line narrower than the terminal.
// terminal.ts is the real terminal, in raw mode; tests stand in for it.

export interface Key {
  name?: string; // as node:readline names it: up, down, return, escape, backspace, a…
  sequence?: string; // the characters typed
  ctrl?: boolean;
  meta?: boolean;
}

export interface TerminalKeys {
  write(text: string): void;
  columns?: number;
  color?: boolean;
  // Reads keys one at a time, the terminal in raw mode, until the function it
  // returns is called, which puts the terminal back as it was.
  listen(onKey: (key: Key) => void): () => void;
}

export const CSI = '\x1b[';
export const HIDE_CURSOR = `${CSI}?25l`;
export const SHOW_CURSOR = `${CSI}?25h`;

// ---- keys ------------------------------------------------------------------------

export const cancels = (key: Key) => key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'));

// A character typed, not a key that does something.
export const typed = (key: Key): key is Key & { sequence: string } =>
  !key.ctrl && !key.meta && typeof key.sequence === 'string' && key.sequence !== '' && !/[\x00-\x1f\x7f]/.test(key.sequence);

export interface KeyReader {
  next(): Promise<Key>;
  stop(): void;
}

// Keys as they come, one per call to next(), whether they came before it or after.
export function readKeys(term: TerminalKeys): KeyReader {
  const queue: Key[] = [];
  let waiting: ((key: Key) => void) | undefined;
  const stop = term.listen((key) => {
    if (!waiting) {
      queue.push(key);
      return;
    }
    const resolve = waiting;
    waiting = undefined;
    resolve(key);
  });
  return {
    next: () =>
      new Promise<Key>((resolve) => {
        const key = queue.shift();
        if (key) resolve(key);
        else waiting = resolve;
      }),
    stop,
  };
}

// ---- drawing ---------------------------------------------------------------------

// Draws lines in place of the ones it drew last: back to the first of them,
// clear to the end of the screen, write. Lines are kept narrower than the
// terminal, so none wraps and the count stays right.
export function drawer(term: TerminalKeys): (lines: string[]) => void {
  let drawn = 0;
  return (lines) => {
    term.write(`\r${drawn > 1 ? `${CSI}${drawn - 1}A` : ''}${CSI}J${lines.join('\n')}`);
    drawn = lines.length;
  };
}

export interface Styles {
  bold(text: string): string;
  dim(text: string): string;
  accent(text: string): string;
}

export const styles = (color: boolean): Styles => ({
  bold: (text) => (color ? `${CSI}1m${text}${CSI}22m` : text),
  dim: (text) => (color ? `${CSI}2m${text}${CSI}22m` : text),
  accent: (text) => (color ? `${CSI}36m${text}${CSI}39m` : text),
});

// The columns a line may use: one less than the terminal's, so the cursor never wraps.
// A terminal that says 0 hasn't said.
export const lineWidth = (term: TerminalKeys) => Math.max(24, (term.columns || 80) - 1);

export const chars = (text: string) => [...text];
export const cut = (text: string, max: number) => (chars(text).length <= max ? text : max <= 0 ? '' : `${chars(text).slice(0, max - 1).join('')}…`);
export const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - chars(text).length));
