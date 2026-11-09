// What the person types, sorted between Tricot and the agent that shows
// (host.ts acts on it). Everything goes to the agent, byte for byte, except:
//
//   the switch key (Ctrl+\)                       next tab, at once, round the
//                                                 strip from the last to the first
//   … then, within a second:  0     the Tricot tab (T192), when there is one
//                             1–9   that agent
//                             q     quit: every agent is closed
//                             [     back, and scroll that agent's history
//                             the switch key again   the next tab again, and the
//                                   second starts over: pressed several times,
//                                   it goes round
//   Ctrl+Z                    nothing: an agent stopped here couldn't be brought back
//   a click on the strip      that tab, from any tab (T30): the terminal reports
//                             the mouse in every one (modes.ts)
//   the wheel                 where the agent showing didn't ask for the mouse: the
//                             host scrolls (its history, the chat, or ↑ ↓ for an
//                             agent drawing its own screen)
//
// The switch key is Tricot's alone: it never reaches an agent, in any form.
// Each of these keys counts in whichever form the real terminal sends it
// (keyboard.ts): as its byte, in the kitty keyboard protocol's form once the
// agent showing has asked for that (Ctrl+\ as CSI 92;5u), or in
// modifyOtherKeys' (CSI 27;5;92~). Only a press counts: a repeat or a release
// never switches, and those of a key taken here never reach an agent. A
// release, or a modifier pressed alone, leaves the second key to come.
// Pasted text (between the bracketed-paste marks) goes to the agent whole,
// switch key and all. A mark or a key split between two reads is waited for
// briefly, and so is an Esc that ends a read: it may begin an arrow or
// Alt+key whose rest comes in the next. Esc pressed alone goes on, once, when
// the wait is over.
// In the Tricot tab, what would go to an agent goes to the tab (tabKeys.ts
// reads it), the same way.
// In the scroll view, the arrows, Page Up and Down, Home and End and the
// wheel scroll; q or Esc goes back to the agent.
//
// The mouse: a press on the strip is Tricot's, and so are its drag and its
// release, wherever they land; the left button picks the tab under it.
// Above the strip, the agent showing gets what it asked for and nothing more,
// in the encoding it asked for (mouse.ts), and the wheel it didn't ask for
// goes to the host, as does a left press (the Tricot tab opens a link
// clicked there, T36); the rest goes nowhere. A drag the agent began that ends
// on the strip reaches it at its last row, as a terminal keeps a drag that
// leaves its window at the edge. In the scroll view, no report reaches the
// agent, and the wheel scrolls.
import { isModifierKey, legacyOf, readKey, type KeyEvent } from './keyboard';
import { encodeMouse, forTracking, isLeftPress, isPress, isWheel, NO_MOUSE, readMouse, wheelDown, wheelUp, type MouseReport, type MouseWanted } from './mouse';

export interface SwitchKey {
  byte: number; // 0x1c
  label: string; // "Ctrl+\"
}

// Ctrl+\ and no other: the agents need the rest of the control keys too much
// (Ctrl+C interrupts, Ctrl+] is Codex's own), and Ctrl+Z does nothing here.
export const SWITCH_KEY: SwitchKey = { byte: 0x1c, label: 'Ctrl+\\' };

export type HostAction =
  | { kind: 'send'; data: Buffer } // to the agent showing, or the Tricot tab
  | { kind: 'next'; again: boolean } // again: the switch key came within the second of the one before
  | { kind: 'pick'; index: number } // an agent, from 0; -1 the Tricot tab
  | { kind: 'quit' }
  | { kind: 'scroll-view' }
  | { kind: 'click'; column: number } // on the strip, from 1
  | { kind: 'wheel'; up: boolean } // a turn of it, not for the agent showing
  | { kind: 'point'; column: number; row: number } // a left press above the strip, not for the agent showing, from 1
  | { kind: 'suspend' } // Ctrl+Z
  | { kind: 'scroll'; lines: number } // up when positive
  | { kind: 'scroll-page'; pages: number }
  | { kind: 'scroll-end'; top: boolean }
  | { kind: 'leave-scroll' };

export interface RouterOptions {
  key: number;
  tricotTab?: boolean; // there is a Tricot tab: the switch key then 0 picks it
  stripRow(): number; // the strip's row, from 1
  scrolling(): boolean;
  mouse?(): MouseWanted; // how the agent showing asked for the mouse: none in the Tricot tab, or without one
  emit(action: HostAction): void;
  now?(): number;
  armMs?: number; // how long a second key may follow the switch key
  holdMs?: number; // how long a sequence cut between two reads is waited for
}

const ESC = '\x1b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const CTRL_Z = 0x1a;
export const ARM_MS = 1_000;
const HOLD_MS = 30;

// The start of something the router must see whole, cut off at the end of a
// read: a paste mark, a mouse report, a key in the protocols' forms, an arrow
// or Alt+key. An Esc alone counts, as it may begin any of them (the paste
// mark's test takes it).
const cutShort = (rest: string): boolean =>
  rest.length < 40 && (PASTE_START.startsWith(rest) || /^\x1b\[<[\d;]*$/.test(rest) || /^\x1b\[M[\s\S]{0,2}$/.test(rest) || /^\x1b\[[\d;:]*$/.test(rest));

const SCROLL_KEYS: [string, HostAction][] = [
  [`${ESC}[5~`, { kind: 'scroll-page', pages: 1 }],
  [`${ESC}[6~`, { kind: 'scroll-page', pages: -1 }],
  [`${ESC}[A`, { kind: 'scroll', lines: 1 }],
  [`${ESC}OA`, { kind: 'scroll', lines: 1 }],
  [`${ESC}[B`, { kind: 'scroll', lines: -1 }],
  [`${ESC}OB`, { kind: 'scroll', lines: -1 }],
  [`${ESC}[H`, { kind: 'scroll-end', top: true }],
  [`${ESC}OH`, { kind: 'scroll-end', top: true }],
  [`${ESC}[1~`, { kind: 'scroll-end', top: true }],
  [`${ESC}[F`, { kind: 'scroll-end', top: false }],
  [`${ESC}OF`, { kind: 'scroll-end', top: false }],
  [`${ESC}[4~`, { kind: 'scroll-end', top: false }],
  ['k', { kind: 'scroll', lines: 1 }],
  ['j', { kind: 'scroll', lines: -1 }],
  ['b', { kind: 'scroll-page', pages: 1 }],
  [' ', { kind: 'scroll-page', pages: -1 }],
  ['g', { kind: 'scroll-end', top: true }],
  ['G', { kind: 'scroll-end', top: false }],
];

export class InputRouter {
  private carry = '';
  private timer: NodeJS.Timeout | undefined;
  private armedUntil = 0;
  private inPaste = false;
  private readonly held = new Set<number>(); // keys whose press was taken here: their repeats and release are too
  private pressed = 0; // the mouse button last pressed, for a release in the first encoding, which doesn't say
  private mouseHeld: 'strip' | 'above' | undefined; // where the button held down was pressed
  private readonly now: () => number;

  constructor(private readonly options: RouterOptions) {
    this.now = options.now ?? Date.now;
  }

  get armed(): boolean {
    return this.now() < this.armedUntil;
  }

  get pasting(): boolean {
    return this.inPaste;
  }

  feed(chunk: Buffer | string): void {
    clearTimeout(this.timer);
    const text = this.carry + (typeof chunk === 'string' ? chunk : chunk.toString('latin1'));
    this.carry = '';
    this.route(text, true);
    if (this.carry) {
      this.timer = setTimeout(() => {
        const held = this.carry;
        this.carry = '';
        this.route(held, false);
      }, this.options.holdMs ?? HOLD_MS);
      this.timer.unref?.();
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  // Text is bytes as latin1, so each character is one byte, and what goes on is exactly what came.
  private route(s: string, mayHold: boolean): void {
    const { emit, key } = this.options;
    let out = '';
    const flush = () => {
      if (out) emit({ kind: 'send', data: Buffer.from(out, 'latin1') });
      out = '';
    };
    const act = (action: HostAction) => {
      flush();
      emit(action);
    };
    let i = 0;
    while (i < s.length) {
      if (this.inPaste) {
        const end = s.indexOf(PASTE_END, i);
        if (end < 0) {
          let keep = 0;
          if (mayHold) for (let k = Math.min(PASTE_END.length - 1, s.length - i); k > 0 && !keep; k--) if (s.endsWith(PASTE_END.slice(0, k))) keep = k;
          out += s.slice(i, s.length - keep);
          this.carry = s.slice(s.length - keep);
          break;
        }
        out += s.slice(i, end + PASTE_END.length);
        i = end + PASTE_END.length;
        this.inPaste = false;
        continue;
      }
      const rest = s.slice(i, i + 40);
      if (mayHold && s.charCodeAt(i) === 0x1b && s.length - i < 40 && cutShort(s.slice(i))) {
        this.carry = s.slice(i);
        break;
      }
      if (rest.startsWith(PASTE_START)) {
        if (this.options.scrolling()) act({ kind: 'leave-scroll' });
        this.armedUntil = 0;
        this.inPaste = true;
        out += PASTE_START;
        i += PASTE_START.length;
        continue;
      }
      const report = readMouse(rest, this.pressed);
      if (report) {
        this.mouse(report.report, act, (bytes) => (out += bytes));
        i += report.raw.length;
        continue;
      }
      const c = s.charCodeAt(i);
      const event = c === 0x1b ? readKey(rest) : undefined;
      if (event) {
        this.keyEvent(event, act, (raw) => (out += raw));
        i += event.raw.length;
        continue;
      }
      if (this.options.scrolling() && c !== key) {
        const hit = SCROLL_KEYS.find(([seq]) => rest.startsWith(seq));
        const other = /^\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|O.)/.exec(rest);
        if (hit) {
          act(hit[1]);
          i += hit[0].length;
        } else if (other) {
          i += other[0].length; // another key: nothing to scroll by
        } else {
          if (s[i] === 'q' || c === 0x1b) act({ kind: 'leave-scroll' });
          i++;
        }
        continue;
      }
      if (c === key) {
        this.switchKey(act);
        i++;
        continue;
      }
      if (this.armed) {
        this.armedUntil = 0;
        if (this.secondKey(s[i], act)) {
          i++;
          continue;
        }
      }
      if (c === CTRL_Z) {
        act({ kind: 'suspend' });
        i++;
        continue;
      }
      out += s[i];
      i++;
    }
    flush();
  }

  // The switch key: the next tab at once, a second key then picks; pressed
  // again within the second, it goes on to the next tab and the second starts over.
  private switchKey(act: (action: HostAction) => void): void {
    const again = this.armed;
    this.armedUntil = this.now() + (this.options.armMs ?? ARM_MS);
    act({ kind: 'next', again });
  }

  // The key after the switch key, as what it types: whether it was one that acts.
  private secondKey(ch: string | undefined, act: (action: HostAction) => void): boolean {
    if (ch === undefined || ch.length !== 1) return false;
    if ((ch >= '1' && ch <= '9') || (ch === '0' && this.options.tricotTab)) act({ kind: 'pick', index: Number(ch) - 1 });
    else if (ch === 'q' || ch === '[') act({ kind: ch === 'q' ? 'quit' : 'scroll-view' });
    else return false;
    return true;
  }

  // A key in the protocols' forms (keyboard.ts), sorted as its byte would be;
  // `pass` sends it on to the agent as it came.
  private keyEvent(e: KeyEvent, act: (action: HostAction) => void, pass: (raw: string) => void): void {
    const press = e.event === 'press';
    const typed = legacyOf(press ? e : { ...e, event: 'press' }); // what it is, held down or let go too
    const switchKey = typed === String.fromCharCode(this.options.key);
    // The switch key is Tricot's: its repeats and releases go nowhere, as do those of a key taken here.
    if (!press && (switchKey || this.held.has(e.code))) {
      if (e.event === 'release') this.held.delete(e.code);
      return;
    }
    const take = () => void this.held.add(e.code);
    if (this.options.scrolling() && !switchKey) {
      if (e.event === 'release') return;
      const hit = SCROLL_KEYS.find(([seq]) => seq === typed);
      if (hit) act(hit[1]);
      else if (typed === 'q' || typed === ESC) {
        take();
        act({ kind: 'leave-scroll' });
      }
      return;
    }
    if (switchKey) {
      this.switchKey(act);
      return;
    }
    if (e.event === 'release' || isModifierKey(e)) return pass(e.raw);
    this.held.delete(e.code); // pressed again: what was held of it is over
    if (this.armed) {
      this.armedUntil = 0;
      if (press && this.secondKey(typed, act)) return take();
    }
    if (press && typed === '\x1a') {
      take();
      return act({ kind: 'suspend' });
    }
    pass(e.raw);
  }

  // A mouse report (the header says where each goes); `pass` sends bytes on to the agent.
  private mouse(report: MouseReport, act: (action: HostAction) => void, pass: (bytes: string) => void): void {
    const strip = this.options.stripRow();
    const press = isPress(report);
    if (press) this.pressed = report.code;
    if (this.mouseHeld === 'strip' && !press && !isWheel(report)) {
      if (report.release) this.mouseHeld = undefined;
      return;
    }
    let r = report;
    if (r.row >= strip) {
      if (press) {
        this.mouseHeld = 'strip';
        if (isLeftPress(r)) act({ kind: 'click', column: r.column });
        return;
      }
      if (this.mouseHeld !== 'above' || isWheel(r)) return;
      r = { ...r, row: strip - 1 };
    }
    if (press) this.mouseHeld = 'above';
    else if (r.release) this.mouseHeld = undefined;
    const wheel = wheelUp(r) || wheelDown(r) ? { kind: 'wheel' as const, up: wheelUp(r) } : undefined;
    const wanted = this.options.scrolling() ? NO_MOUSE : (this.options.mouse?.() ?? NO_MOUSE);
    const kept = forTracking(r, wanted.tracking);
    if (kept) {
      const bytes = encodeMouse(kept, wanted.encoding);
      if (bytes) pass(bytes);
    } else if (wheel) act(wheel);
    else if (press && isLeftPress(r) && !this.options.scrolling()) act({ kind: 'point', column: r.column, row: r.row });
  }
}
