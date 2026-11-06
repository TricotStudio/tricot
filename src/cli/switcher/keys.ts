// What the person types, sorted between Tricot and the agent that shows
// (host.ts acts on it). Everything goes to the agent, byte for byte, except:
//
//   the switch key (Ctrl+\)                       next tab, at once
//   … then, within a second:  0     the Tricot tab (T192), when there is one
//                             1–9   that agent
//                             q     quit: every agent is closed
//                             [     back, and scroll that agent's history
//                             the switch key again   back, and send it the key
//   Ctrl+Z                    nothing: an agent stopped here couldn't be brought back
//   a click on the strip      that agent (when the agent showing has the mouse on)
//
// Each of these keys counts in whichever form the real terminal sends it
// (keyboard.ts): as its byte, in the kitty keyboard protocol's form once the
// agent showing has asked for that (Ctrl+\ as CSI 92;5u), or in
// modifyOtherKeys' (CSI 27;5;92~). Only a press counts: a repeat or a release
// never switches, and those of a key taken here never reach an agent. A
// release, or a modifier pressed alone, leaves the second key to come.
// Pasted text (between the bracketed-paste marks) goes to the agent whole,
// switch key and all. A mark or a key split between two reads is waited for
// briefly.
// In the Tricot tab, what would go to an agent goes to the tab (tabKeys.ts
// reads it), the same way.
// In the scroll view, the arrows, Page Up and Down, Home and End and the
// wheel scroll; q or Esc goes back to the agent.
import { isModifierKey, legacyOf, readKey, type KeyEvent } from './keyboard';

export interface SwitchKey {
  byte: number; // 0x1c
  label: string; // "Ctrl+\"
}

// Ctrl+\ and no other: the agents need the rest of the control keys too much
// (Ctrl+C interrupts, Ctrl+] is Codex's own), and Ctrl+Z does nothing here.
export const SWITCH_KEY: SwitchKey = { byte: 0x1c, label: 'Ctrl+\\' };

export type HostAction =
  | { kind: 'send'; data: Buffer } // to the agent showing, or the Tricot tab
  | { kind: 'next' }
  | { kind: 'pick'; index: number } // an agent, from 0; -1 the Tricot tab
  | { kind: 'literal'; data: Buffer } // the switch key twice: the second, as it came
  | { kind: 'quit' }
  | { kind: 'scroll-view' }
  | { kind: 'click'; column: number } // on the strip, from 1
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
// read: a paste mark, a mouse report, a key in the protocols' forms.
const cutShort = (rest: string): boolean =>
  rest.length >= 2 && rest.length < 40 && (PASTE_START.startsWith(rest) || /^\x1b\[<[\d;]*$/.test(rest) || /^\x1b\[M[\s\S]{0,2}$/.test(rest) || /^\x1b\[[\d;:]*$/.test(rest));

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
      const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
      if (sgr) {
        this.mouse(Number(sgr[1]), Number(sgr[2]), Number(sgr[3]), sgr[4] === 'M', sgr[0], act, (raw) => (out += raw));
        i += sgr[0].length;
        continue;
      }
      if (rest.startsWith(`${ESC}[M`) && rest.length >= 6) {
        // The legacy report: three bytes, each 32 more than its number; 3 is a release.
        const raw = rest.slice(0, 6);
        const button = raw.charCodeAt(3) - 32;
        this.mouse(button, raw.charCodeAt(4) - 32, raw.charCodeAt(5) - 32, (button & 3) !== 3, raw, act, (r) => (out += r));
        i += 6;
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
        this.switchKey(s[i], act);
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

  // The switch key: the next tab at once, a second key then picks; twice, the
  // key itself goes to the agent, as it came.
  private switchKey(raw: string, act: (action: HostAction) => void): void {
    if (this.armed) {
      this.armedUntil = 0;
      act({ kind: 'literal', data: Buffer.from(raw, 'latin1') });
      return;
    }
    this.armedUntil = this.now() + (this.options.armMs ?? ARM_MS);
    act({ kind: 'next' });
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
      this.switchKey(e.raw, act);
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

  // A mouse report: on the strip, a press of the left button picks an agent
  // and nothing reaches the agent; in the scroll view, the wheel scrolls.
  private mouse(button: number, column: number, row: number, press: boolean, raw: string, act: (action: HostAction) => void, pass: (raw: string) => void): void {
    if (row === this.options.stripRow()) {
      if (press && (button & ~(4 | 8 | 16)) === 0) act({ kind: 'click', column });
      return;
    }
    if (this.options.scrolling()) {
      if (button & 64) act({ kind: 'scroll', lines: button & 1 ? -3 : 3 });
      return;
    }
    pass(raw);
  }
}
