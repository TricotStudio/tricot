// The real terminal's input settings follow the agent that shows: bracketed
// paste, focus reports, the mouse and how it is reported, the cursor keys,
// the keypad, the cursor's shape, and the keyboard protocols (keyboard.ts):
// the kitty keyboard's flags, so Shift+Enter comes as itself (CSI 13;2u),
// and xterm's modifyOtherKeys. Switching sets what differs, and leaving puts
// each back as a terminal starts.
//
// The kitty keyboard's flags are set only in a terminal that answered for
// them (host.ts asks it once, at the start); elsewhere nothing about them is
// ever written, so Ctrl+J and Option+Enter are as they were. modifyOtherKeys
// is only written once an agent has asked for it, and the agents only ask
// in a terminal they know has it.
import type { InputModes, MouseEncoding, MouseTracking } from './screen';

export const PLAIN_MODES: InputModes = {
  bracketedPaste: false,
  focus: false,
  mouse: 'none',
  mouseEncoding: 'default',
  cursorKeys: false,
  keypad: false,
  cursorStyle: 0,
  keyboard: 0,
  otherKeys: 0,
};

const TRACKING: Record<Exclude<MouseTracking, 'none'>, number> = { x10: 9, vt200: 1000, drag: 1002, any: 1003 };
const ENCODING: Record<Exclude<MouseEncoding, 'default'>, number> = { utf8: 1005, sgr: 1006, urxvt: 1015 };
const MOUSE_OFF = '\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?9l\x1b[?1006l\x1b[?1015l\x1b[?1005l';

const dec = (code: number, on: boolean) => `\x1b[?${code}${on ? 'h' : 'l'}`;

// What to write so a terminal set as `from` (unknown: anything) is set as
// `to`; `kitty`: it speaks the kitty keyboard protocol.
export function modeChanges(from: InputModes | undefined, to: InputModes, kitty = false): string {
  let out = '';
  if (from?.bracketedPaste !== to.bracketedPaste) out += dec(2004, to.bracketedPaste);
  if (from?.focus !== to.focus) out += dec(1004, to.focus);
  if (from?.cursorKeys !== to.cursorKeys) out += dec(1, to.cursorKeys);
  if (from?.keypad !== to.keypad) out += to.keypad ? '\x1b=' : '\x1b>';
  if (from?.mouse !== to.mouse || from?.mouseEncoding !== to.mouseEncoding) {
    out += MOUSE_OFF;
    if (to.mouse !== 'none') {
      if (to.mouseEncoding !== 'default') out += dec(ENCODING[to.mouseEncoding], true);
      out += dec(TRACKING[to.mouse], true);
    }
  }
  if (from?.cursorStyle !== to.cursorStyle) out += `\x1b[${to.cursorStyle} q`;
  if (kitty && from?.keyboard !== to.keyboard) out += `\x1b[=${to.keyboard};1u`;
  // Off as a terminal starts: written only once an agent has turned it on.
  if ((from?.otherKeys ?? 0) !== to.otherKeys) out += to.otherKeys ? `\x1b[>4;${to.otherKeys}m` : '\x1b[>4m';
  return out;
}
