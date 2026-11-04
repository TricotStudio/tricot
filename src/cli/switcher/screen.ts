// One agent's screen, kept by Tricot whether it shows or not: everything the
// agent draws goes into a terminal emulator (@xterm/headless, the one VS
// Code's terminal is built on), and the host paints the real terminal from
// the screen of the agent showing (host.ts). Switching agents is a repaint.
//
// The screen also stands in for the terminal where the agent can't reach
// the real one: it answers what agents ask at startup (device attributes and
// the cursor's position, which the emulator answers itself, and the
// terminal's colours, from what the real terminal said: colours below), so a
// hidden agent never waits; and it hands on what must reach the person
// (a bell, a desktop notification, a copy to the clipboard).
//
// It also notes what the emulator keeps to itself: whether the cursor shows,
// its shape, how the agent wants the mouse reported, and what it asked of the
// keyboard (keyboard.ts: the kitty keyboard's flags, per screen, and
// modifyOtherKeys) (inputModes), which the host gives the real terminal while
// this agent shows. Asked for the kitty keyboard's flags (CSI ? u), it
// answers with the agent's own, when the real terminal speaks the protocol;
// otherwise it says nothing, as such a terminal would.
// The package is CommonJS: its default export holds the classes, and its
// types come by name (erased, so Node never looks for named exports).
import xterm from '@xterm/headless';
import type { IBufferCell as BufferCell, IBufferLine as BufferLine, Terminal } from '@xterm/headless';
import { KeyboardState } from './keyboard';

// The real terminal's colours, as it answered OSC 10, 11 and 12: "rgb:1e1e/1e1e/1e1e".
export interface TerminalColours {
  foreground?: string;
  background?: string;
  cursor?: string;
}

export interface ScreenEvents {
  reply?(data: string): void; // an answer to the agent's question, for its input
  bell?(): void;
  notify?(sequence: string): void; // a desktop notification (OSC 9, 777, 99), as written
  progress?(sequence: string): void; // a progress report (OSC 9;4)
  clipboard?(sequence: string): void; // a copy to the clipboard (OSC 52)
}

export type MouseTracking = 'none' | 'x10' | 'vt200' | 'drag' | 'any';
export type MouseEncoding = 'default' | 'utf8' | 'sgr' | 'urxvt';

// How the agent wants its input: the real terminal is set the same way while it shows.
export interface InputModes {
  bracketedPaste: boolean;
  focus: boolean;
  mouse: MouseTracking;
  mouseEncoding: MouseEncoding;
  cursorKeys: boolean; // application cursor keys (DECCKM)
  keypad: boolean; // application keypad
  cursorStyle: number; // DECSCUSR: 0 is the terminal's own
  keyboard: number; // the kitty keyboard's flags, on the screen it is on (keyboard.ts)
  otherKeys: number; // xterm's modifyOtherKeys: 0 the terminal's own, 1 or 2
}

export interface Cursor {
  x: number;
  y: number;
  visible: boolean;
}

export const SCROLLBACK_LINES = 3_000;

const ESC = '\x1b';
const ST = `${ESC}\\`;
const ENCODINGS: Record<number, MouseEncoding> = { 1005: 'utf8', 1006: 'sgr', 1015: 'urxvt' };

export class AgentScreen {
  readonly term: Terminal;
  private cursorVisible = true;
  private cursorStyle = 0;
  private mouseEncoding: MouseEncoding = 'default';
  private readonly cell: BufferCell;
  readonly keyboard = new KeyboardState();

  // kitty: the real terminal speaks the kitty keyboard protocol, so the agent's question is answered.
  constructor(
    cols: number,
    rows: number,
    events: ScreenEvents = {},
    private readonly colours: TerminalColours = {},
    kitty = false,
  ) {
    this.term = new xterm.Terminal({
      cols,
      rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
      windowOptions: { getWinSizeChars: true },
    });
    this.cell = this.term.buffer.normal.getNullCell();
    const parser = this.term.parser;
    this.term.onData((data) => events.reply?.(data));
    this.term.onBell(() => events.bell?.());
    // Left to the emulator as well (false): these only note what it keeps to itself.
    const modes = (on: boolean) => (params: (number | number[])[]) => {
      for (const param of params.flat()) {
        if (param === 25) this.cursorVisible = on;
        const encoding = ENCODINGS[param];
        if (encoding && on) this.mouseEncoding = encoding;
        if (encoding && !on && this.mouseEncoding === encoding) this.mouseEncoding = 'default';
      }
      return false;
    };
    parser.registerCsiHandler({ prefix: '?', final: 'h' }, modes(true));
    parser.registerCsiHandler({ prefix: '?', final: 'l' }, modes(false));
    parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
      const style = params[0];
      this.cursorStyle = typeof style === 'number' ? style : 0;
      return false;
    });
    parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
      this.cursorVisible = true;
      return false;
    });
    parser.registerEscHandler({ final: 'c' }, () => {
      this.cursorVisible = true;
      this.cursorStyle = 0;
      this.mouseEncoding = 'default';
      this.keyboard.reset();
      return false;
    });
    // The keyboard protocols (keyboard.ts), which the emulator leaves alone:
    // kept here, for the screen the agent is on when it asks.
    const keys = this.keyboard;
    const alt = () => this.altScreen;
    const param = (params: (number | number[])[], at: number, fallback: number) => {
      const value = params[at];
      return (Array.isArray(value) ? value[0] : value) || fallback;
    };
    parser.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => (keys.push(alt(), param(params, 0, 0)), true));
    parser.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => (keys.pop(alt(), param(params, 0, 1)), true));
    parser.registerCsiHandler({ prefix: '=', final: 'u' }, (params) => (keys.set(alt(), param(params, 0, 0), param(params, 1, 1)), true));
    parser.registerCsiHandler({ prefix: '?', final: 'u' }, () => {
      if (kitty) events.reply?.(`${ESC}[?${keys.flags(alt())}u`);
      return true;
    });
    // CSI > 4 ; level m sets modifyOtherKeys; CSI > 4 m and CSI > m put it back, as CSI > 4 n turns it off.
    parser.registerCsiHandler({ prefix: '>', final: 'm' }, (params) => {
      const which = param(params, 0, 0);
      if (which === 4) keys.otherKeys = param(params, 1, 0);
      else if (which === 0 && params.length === 1) keys.otherKeys = 0;
      return true;
    });
    parser.registerCsiHandler({ prefix: '>', final: 'n' }, (params) => {
      if (param(params, 0, 0) === 4) keys.otherKeys = 0;
      return true;
    });
    // The real terminal's colours, for an agent picking a light or dark look.
    // "10;?;?" asks for 10 and 11 at once.
    for (const [first, key] of [
      [10, 'foreground'],
      [11, 'background'],
      [12, 'cursor'],
    ] as const) {
      parser.registerOscHandler(first, (data) => {
        const asks = data.split(';');
        if (!asks.every((ask) => ask === '?')) return false; // setting it: the emulator's
        const order = ['foreground', 'background', 'cursor'] as const;
        let answer = '';
        asks.forEach((_, at) => {
          const which = order[order.indexOf(key) + at];
          const value = which && this.colours[which];
          if (value) answer += `${ESC}]${first + at};${value}${ST}`;
        });
        if (answer) events.reply?.(answer);
        return true;
      });
    }
    parser.registerOscHandler(9, (data) => {
      if (/^4;/.test(data)) events.progress?.(`${ESC}]9;${data}${ST}`);
      else events.notify?.(`${ESC}]9;${data}\x07`);
      return true;
    });
    parser.registerOscHandler(777, (data) => {
      if (/^notify;/.test(data)) events.notify?.(`${ESC}]777;${data}\x07`);
      return true;
    });
    parser.registerOscHandler(99, (data) => {
      events.notify?.(`${ESC}]99;${data}${ST}`);
      return true;
    });
    parser.registerOscHandler(52, (data) => {
      if (!/;\?$/.test(data)) events.clipboard?.(`${ESC}]52;${data}\x07`);
      return true;
    });
  }

  // Resolves once the emulator has taken it in.
  write(data: Uint8Array | string): Promise<void> {
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  resize(cols: number, rows: number): void {
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(Math.max(1, cols), Math.max(1, rows));
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  get inputModes(): InputModes {
    const m = this.term.modes;
    return {
      bracketedPaste: m.bracketedPasteMode,
      focus: m.sendFocusMode,
      mouse: m.mouseTrackingMode,
      mouseEncoding: this.mouseEncoding,
      cursorKeys: m.applicationCursorKeysMode,
      keypad: m.applicationKeypadMode,
      cursorStyle: this.cursorStyle,
      keyboard: this.keyboard.flags(this.altScreen),
      otherKeys: this.keyboard.otherKeys,
    };
  }

  get cursor(): Cursor {
    const buffer = this.term.buffer.active;
    return { x: Math.min(buffer.cursorX, this.term.cols - 1), y: buffer.cursorY, visible: this.cursorVisible };
  }

  // On the alternate screen, the agent draws its whole window and keeps no history here.
  get altScreen(): boolean {
    return this.term.buffer.active.type === 'alternate';
  }

  // In the middle of a frame it asked to be shown whole (mode 2026).
  get synchronizing(): boolean {
    return this.term.modes.synchronizedOutputMode;
  }

  // Lines of history above the normal screen.
  get history(): number {
    return this.term.buffer.normal.baseY;
  }

  // Row y of what shows now, painted: its characters with their colours and
  // styles, as SGR codes the real terminal reads with its own palette.
  row(y: number): string {
    const buffer = this.term.buffer.active;
    return paintLine(buffer.getLine(buffer.baseY + y), this.term.cols, this.cell);
  }

  // Line `index` of the normal screen and its history (0 is the oldest kept).
  historyRow(index: number): string {
    return paintLine(this.term.buffer.normal.getLine(index), this.term.cols, this.cell);
  }

  // Row y as plain text, for tests and transcripts.
  text(y: number): string {
    const buffer = this.term.buffer.active;
    return buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '';
  }

  lines(): string[] {
    return Array.from({ length: this.term.rows }, (_, y) => this.text(y));
  }

  dispose(): void {
    this.term.dispose();
  }
}

// A cell's look as SGR parameters; '' for the terminal's own.
function sgrOf(cell: BufferCell): string {
  const codes: (number | string)[] = [];
  if (cell.isBold()) codes.push(1);
  if (cell.isDim()) codes.push(2);
  if (cell.isItalic()) codes.push(3);
  if (cell.isUnderline()) codes.push(4);
  if (cell.isBlink()) codes.push(5);
  if (cell.isInverse()) codes.push(7);
  if (cell.isInvisible()) codes.push(8);
  if (cell.isStrikethrough()) codes.push(9);
  if (cell.isOverline()) codes.push(53);
  const colour = (rgb: boolean, palette: boolean, value: number, base: number, bright: number, extended: number) => {
    if (rgb) codes.push(`${extended};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`);
    else if (palette) codes.push(value < 8 ? base + value : value < 16 ? bright + value - 8 : `${extended};5;${value}`);
  };
  colour(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor(), 30, 90, 38);
  colour(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor(), 40, 100, 48);
  return codes.join(';');
}

// One line as the real terminal should show it, from its first column: the
// cells' characters, a style change only where the style changes, and the
// blank end of the line erased rather than written. A wide character takes
// its two columns; the cell after it holds nothing of its own.
export function paintLine(line: BufferLine | undefined, cols: number, cell: BufferCell): string {
  if (!line) return '\x1b[0m\x1b[K';
  const parts: { sgr: string; text: string; width: number }[] = [];
  for (let x = 0; x < cols; x++) {
    if (!line.getCell(x, cell)) break;
    const width = cell.getWidth();
    if (width === 0) continue;
    const sgr = sgrOf(cell);
    const text = cell.getChars() || ' ';
    const last = parts.at(-1);
    if (last && last.sgr === sgr) {
      last.text += text;
      last.width += width;
    } else parts.push({ sgr, text, width });
  }
  // The blank end, in the terminal's own colours, is erased instead.
  const last = parts.at(-1);
  if (last && last.sgr === '') {
    const kept = last.text.replace(/ +$/, '');
    last.width -= last.text.length - kept.length;
    last.text = kept;
    if (!kept) parts.pop();
  }
  let out = '';
  let width = 0;
  for (const part of parts) {
    out += `\x1b[0${part.sgr ? `;${part.sgr}` : ''}m${part.text}`;
    width += part.width;
  }
  // Erasing at the last column would take its character too.
  return width < cols ? `${out}\x1b[0m\x1b[K` : `${out}\x1b[0m`;
}
