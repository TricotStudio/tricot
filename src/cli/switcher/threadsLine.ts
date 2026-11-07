// The line a message is typed on in the Tricot tab's threads (threadsTab.ts):
// one line, however long, with a cursor that moves by character. Text typed or
// pasted goes in at the cursor, with a newline or a tab as a space and control
// characters left out, as the reason for a denial is read (tricotTab.ts); it
// stops at what it may hold (a message's, core/threads.ts THREAD_TEXT_LIMIT,
// unless a line is made with a smaller limit), the rest of a paste cut off. The cursor is an offset into the text, always
// between two characters (never inside a pair that makes one).
import { THREAD_TEXT_LIMIT } from '../../core/threads';
import type { TabKey } from './tabKeys';

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// Typed text as one line of printable characters.
export const oneLineOf = (text: string): string => text.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

export class Line {
  text = '';
  cursor = 0;

  constructor(private readonly limit: number = THREAD_TEXT_LIMIT) {}

  get empty(): boolean {
    return this.text === '';
  }

  insert(typed: string): void {
    const room = this.limit - this.text.length;
    let add = oneLineOf(typed).slice(0, Math.max(0, room));
    if (isHigh(add.charCodeAt(add.length - 1))) add = add.slice(0, -1); // half a character, cut by the limit
    this.text = this.text.slice(0, this.cursor) + add + this.text.slice(this.cursor);
    this.cursor += add.length;
  }

  backspace(): void {
    const from = this.before(this.cursor);
    this.text = this.text.slice(0, from) + this.text.slice(this.cursor);
    this.cursor = from;
  }

  clear(): void {
    this.set('');
  }

  // Replaces the text, the cursor at its end (or at `cursor`).
  set(text: string, cursor = text.length): void {
    this.text = text.slice(0, this.limit);
    this.cursor = Math.min(cursor, this.text.length);
  }

  left(): void {
    this.cursor = this.before(this.cursor);
  }

  right(): void {
    const code = this.text.charCodeAt(this.cursor);
    this.cursor = Math.min(this.text.length, this.cursor + (isHigh(code) && isLow(this.text.charCodeAt(this.cursor + 1)) ? 2 : 1));
  }

  home(): void {
    this.cursor = 0;
  }

  end(): void {
    this.cursor = this.text.length;
  }

  // The offset one character before `at`.
  private before(at: number): number {
    if (at <= 0) return 0;
    return isLow(this.text.charCodeAt(at - 1)) && isHigh(this.text.charCodeAt(at - 2)) ? at - 2 : at - 1;
  }
}

// What a key does to a line, if it is a key of the line's: typing and pasting,
// Backspace and Ctrl+U change the text ('typed'); the arrows and, while there
// is text, Home and End move the cursor ('moved'). None for any other key.
export function editLine(line: Line, key: TabKey): 'typed' | 'moved' | undefined {
  switch (key.kind) {
    case 'text':
    case 'paste':
      line.insert(key.text);
      return 'typed';
    case 'backspace':
      line.backspace();
      return 'typed';
    case 'clear':
      line.clear();
      return 'typed';
    case 'left':
      line.left();
      return 'moved';
    case 'right':
      line.right();
      return 'moved';
    case 'home':
    case 'end':
      if (line.empty) return undefined;
      if (key.kind === 'home') line.home();
      else line.end();
      return 'moved';
    default:
      return undefined;
  }
}
