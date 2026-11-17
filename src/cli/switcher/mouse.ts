// The mouse, as the real terminal reports it and as an agent asked for it
// (T30). Tricot keeps the terminal reporting presses and releases in every
// tab, in SGR (modes.ts terminalModes), so a click on the strip always
// switches; the router (keys.ts) reads each report here, and what reaches an
// agent is what it asked for: the tracking it set (presses only, presses and
// releases, drags, or any motion), in the encoding it set (the first one,
// UTF-8, SGR or URXVT), as a terminal set that way would have sent it.
import type { MouseEncoding, MouseTracking } from './screen';

// A report, as SGR gives it: `code` holds the button (0 left, 1 middle, 2
// right, 3 none, while moving), the modifiers (4 Shift, 8 Alt, 16 Ctrl), 32
// for motion, 64 for the wheel (64 up, 65 down, 66 and 67 sideways) and 128
// for the buttons past those. A release names its button, as SGR does.
export interface MouseReport {
  code: number;
  column: number; // from 1
  row: number; // from 1
  release: boolean;
}

// How the agent showing wants the mouse reported: none in the Tricot tab, or for an agent that didn't ask.
export interface MouseWanted {
  tracking: MouseTracking;
  encoding: MouseEncoding;
}

export const NO_MOUSE: MouseWanted = { tracking: 'none', encoding: 'default' };

const MODIFIERS = 4 | 8 | 16;
export const isMotion = (r: MouseReport): boolean => (r.code & 32) !== 0;
export const isWheel = (r: MouseReport): boolean => (r.code & (64 | 128)) === 64;
export const isPress = (r: MouseReport): boolean => !r.release && !isMotion(r) && !isWheel(r);
// The wheel turned up or down, with or without a modifier; sideways is neither.
export const wheelUp = (r: MouseReport): boolean => isWheel(r) && (r.code & 3) === 0;
export const wheelDown = (r: MouseReport): boolean => isWheel(r) && (r.code & 3) === 1;
export const isLeftPress = (r: MouseReport): boolean => isPress(r) && (r.code & ~MODIFIERS) === 0;
const buttonHeld = (r: MouseReport): boolean => (r.code & 3) !== 3;

// A report at the start of `text`, and the bytes it took: SGR (CSI < b;x;y M
// or m), or the first encoding (CSI M and three bytes, each 32 more than its
// number), whose release says no button: `pressed` names it, the button of
// the press before.
export function readMouse(text: string, pressed = 0): { report: MouseReport; raw: string } | undefined {
  const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(text);
  if (sgr) return { report: { code: Number(sgr[1]), column: Number(sgr[2]), row: Number(sgr[3]), release: sgr[4] === 'm' }, raw: sgr[0] };
  if (!text.startsWith('\x1b[M') || text.length < 6) return undefined;
  const raw = text.slice(0, 6);
  const code = raw.charCodeAt(3) - 32;
  const release = (code & (3 | 32 | 64)) === 3; // a button let go: not a motion, nor the wheel
  return { report: { code: release ? (code & ~3) | (pressed & 3) : code, column: raw.charCodeAt(4) - 32, row: raw.charCodeAt(5) - 32, release }, raw };
}

// The report as an agent tracking the mouse this way would get it, or none:
// presses alone, without their modifiers, for X10 (and not the wheel, as
// xterm.js has it); no motion for press-and-release; motion with a button
// held for drags; any motion for any.
export function forTracking(r: MouseReport, tracking: MouseTracking): MouseReport | undefined {
  switch (tracking) {
    case 'none':
      return undefined;
    case 'x10':
      return isPress(r) && (r.code & ~MODIFIERS) <= 2 ? { ...r, code: r.code & 3 } : undefined;
    case 'vt200':
      return isMotion(r) ? undefined : r;
    case 'drag':
      return isMotion(r) && !buttonHeld(r) ? undefined : r;
    case 'any':
      return r;
  }
}

// The bytes of a report in an encoding, as a latin1 string (one character a
// byte); none where the encoding can't say where it is: past column or row
// 223 in the first encoding, 2015 in UTF-8's.
export function encodeMouse(r: MouseReport, encoding: MouseEncoding): string | undefined {
  if (encoding === 'sgr') return `\x1b[<${r.code};${r.column};${r.row}${r.release ? 'm' : 'M'}`;
  const code = r.release ? (r.code & ~3) | 3 : r.code; // the older encodings say a release, not which button
  if (encoding === 'urxvt') return `\x1b[${code + 32};${r.column};${r.row}M`;
  const values = [code + 32, r.column + 32, r.row + 32];
  if (encoding === 'utf8') {
    if (values.some((v) => v > 0x7ff)) return undefined;
    return `\x1b[M${values.map((v) => Buffer.from(String.fromCharCode(v), 'utf8').toString('latin1')).join('')}`;
  }
  if (values.some((v) => v > 0xff)) return undefined;
  return `\x1b[M${String.fromCharCode(...values)}`;
}
