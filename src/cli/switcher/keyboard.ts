// The keyboard protocols that let an agent tell Shift+Enter from Enter
// (T191), as the switcher keeps them for each agent and reads the keys they
// bring.
//
// An app asks its terminal for more from the keyboard in one of two ways:
//
//   the kitty keyboard protocol (Ghostty, iTerm2, kitty, WezTerm, foot):
//   flags in a stack, one stack for the main screen and one for the
//   alternate screen. CSI > flags u pushes, CSI < n u pops n, CSI = flags ;
//   mode u sets the top (1 all, 2 these bits on, 3 these bits off), and
//   CSI ? u asks, answered CSI ? flags u by a terminal that speaks it. Keys
//   then come as CSI code[:shifted[:base]] [; mods[:event] [; text]] u, and
//   CSI 1 ; mods[:event] A (the arrows and others) or CSI n ; mods[:event] ~.
//
//   xterm's modifyOtherKeys: CSI > 4 ; level m (CSI > 4 m back to the
//   terminal's own). Keys then come as CSI 27 ; mods ; code ~.
//
// What the agents ask for (as of November 2026):
//   Claude Code, in a terminal it knows (Ghostty, iTerm2, kitty, WezTerm,
//   Warp, tmux) or one that answered CSI ? u: CSI < u, CSI > 5 u (tell keys
//   apart, with their shifted keys) and CSI > 4 ; 2 m, on the screen it
//   draws on; CSI > 4 m and CSI < u as it leaves.
//   Codex: CSI > 5 u in Ghostty and iTerm2, CSI > 7 u elsewhere (key
//   releases too), on each screen it uses, popped as it leaves each;
//   modifyOtherKeys (CSI > 4 ; 2 m) only inside tmux, and CSI > 4 ; 0 m as it
//   leaves.
//
// Each agent's screen keeps what it asked for (KeyboardState) and answers its
// question when the real terminal speaks the protocol (screen.ts); the real
// terminal is set to the flags of the agent showing (modes.ts); the router
// (keys.ts) and the Tricot tab (tabKeys.ts) read keys in any of these forms
// (readKey, legacyOf).

// Pushed flags kept per screen, as kitty and Ghostty keep: the oldest goes first.
const STACK_LIMIT = 8;

export class KeyboardState {
  private stacks = { main: [] as number[], alt: [] as number[] };
  private base = { main: 0, alt: 0 }; // the flags with nothing pushed: what CSI = sets then
  otherKeys = 0; // modifyOtherKeys: 0 the terminal's own, 1 or 2

  flags(alt: boolean): number {
    return this.stack(alt).at(-1) ?? this.base[alt ? 'alt' : 'main'];
  }

  depth(alt: boolean): number {
    return this.stack(alt).length;
  }

  push(alt: boolean, flags: number): void {
    const stack = this.stack(alt);
    stack.push(flags & 31);
    if (stack.length > STACK_LIMIT) stack.shift();
  }

  // Popping it empty resets every flag, as the protocol says.
  pop(alt: boolean, count: number): void {
    const stack = this.stack(alt);
    if (count >= stack.length) {
      stack.length = 0;
      this.base[alt ? 'alt' : 'main'] = 0;
    } else stack.length -= count;
  }

  set(alt: boolean, flags: number, mode: number): void {
    const now = this.flags(alt);
    const next = mode === 2 ? now | flags : mode === 3 ? now & ~flags : flags;
    const stack = this.stack(alt);
    if (stack.length) stack[stack.length - 1] = next & 31;
    else this.base[alt ? 'alt' : 'main'] = next & 31;
  }

  reset(): void {
    this.stacks = { main: [], alt: [] };
    this.base = { main: 0, alt: 0 };
    this.otherKeys = 0;
  }

  private stack(alt: boolean): number[] {
    return this.stacks[alt ? 'alt' : 'main'];
  }
}

// ---- keys -----------------------------------------------------------------------------

const SHIFT = 1;
const ALT = 2;
const CTRL = 4;
const SUPER = 8;
const HYPER = 16;
const META = 32;
const CAPS_LOCK = 64;
const NUM_LOCK = 128;
const LOCKS = CAPS_LOCK | NUM_LOCK;

export interface KeyEvent {
  raw: string; // the sequence, as it came
  code: number; // the key: its character unshifted, or the protocol's number (13 Enter, 27 Esc, 57441 Left Shift…)
  final: string; // 'u'; '~' or a letter for the keys kept in their old form (arrows, Page Up…)
  shifted?: number; // what it types with Shift, when the terminal says
  base?: number; // the same key on a US layout, when the terminal says
  mods: number; // SHIFT, ALT, CTRL, … and the locks
  event: 'press' | 'repeat' | 'release';
  text?: string; // what it types, when the terminal says
}

const CSI_U = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d*)(?::(\d+))?(?:;([\d:]*))?)?u/;
const MODIFY_OTHER = /^\x1b\[27;(\d+);(\d+)~/;
const OLD_FORM = /^\x1b\[(\d+);(\d*)(?::(\d+))?([~ABCDEFHPQS])/;
const EVENTS = ['press', 'press', 'repeat', 'release'] as const;

// A key in the kitty keyboard protocol's form or modifyOtherKeys' at the start
// of `s`, or the old form with modifiers or an event type (CSI 1 ; 2 A); none
// for anything else, the old forms without modifiers included (CSI A).
export function readKey(s: string): KeyEvent | undefined {
  if (s.charCodeAt(0) !== 0x1b || s[1] !== '[') return undefined;
  const event = (n: string | undefined) => EVENTS[Number(n) || 1] ?? 'press';
  const mods = (n: string | undefined) => Math.max(0, (Number(n) || 1) - 1);
  let m = CSI_U.exec(s);
  if (m) {
    const points = (m[6] ?? '').split(':').filter(Boolean).slice(0, 16).map(Number);
    const text = String.fromCodePoint(...points.filter((c) => c >= 0x20 && c <= 0x10ffff));
    return {
      raw: m[0],
      code: Number(m[1]),
      final: 'u',
      ...(m[2] && { shifted: Number(m[2]) }),
      ...(m[3] && { base: Number(m[3]) }),
      mods: mods(m[4]),
      event: event(m[5]),
      ...(text && { text }),
    };
  }
  m = MODIFY_OTHER.exec(s);
  if (m) return { raw: m[0], code: Number(m[2]), final: 'u', mods: mods(m[1]), event: 'press' };
  m = OLD_FORM.exec(s);
  if (m) return { raw: m[0], code: Number(m[1]), final: m[4], mods: mods(m[2]), event: event(m[3]) };
  return undefined;
}

// A key pressed alone that changes others: Shift, Ctrl, Alt, Super, Hyper,
// Meta, the ISO level shifts, and the locks.
export const isModifierKey = (e: KeyEvent): boolean => e.final === 'u' && ((e.code >= 57441 && e.code <= 57454) || (e.code >= 57358 && e.code <= 57360));

const FUNCTIONAL: Record<number, string> = { 27: '\x1b', 13: '\r', 9: '\t', 127: '\x7f', 57414: '\r' /* the keypad's Enter */ };

// The bytes a terminal without these protocols sends for the key (pressed or
// repeated): 'q', '\x1c' for Ctrl+\, '\r' for Shift+Enter, '\x1b[A' for an
// arrow. None for a release, a modifier pressed alone, or a key with no
// such bytes (Super+anything, F13, media keys).
export function legacyOf(e: KeyEvent): string | undefined {
  if (e.event === 'release' || isModifierKey(e)) return undefined;
  const mods = e.mods & ~LOCKS;
  if (mods & (SUPER | HYPER | META)) return undefined;
  if (e.final !== 'u') {
    const letter = e.final !== '~';
    return `\x1b[${mods ? `${e.code};${mods + 1}` : letter ? '' : e.code}${e.final}`;
  }
  const alt = mods & ALT ? '\x1b' : '';
  if (e.code === 9 && mods & SHIFT) return `${alt}\x1b[Z`;
  if (FUNCTIONAL[e.code] !== undefined) return alt + FUNCTIONAL[e.code];
  if (e.code >= 57399 && e.code <= 57408) return alt + String(e.code - 57399); // the keypad's digits
  if (e.code >= 0xe000 && e.code <= 0xf8ff) return undefined; // another of the protocol's own keys
  const shift = Boolean(mods & SHIFT);
  const ch = shift && e.shifted ? e.shifted : e.code;
  if (mods & CTRL) {
    // Ctrl+Space and Ctrl+@ are 0, Ctrl+? is DEL, and Ctrl+A to Ctrl+_ (Ctrl+\ among them) are 1 to 31.
    const control = ch === 0x20 ? 0 : ch === 0x3f ? 0x7f : ch >= 0x40 && ch <= 0x7e ? ch & 0x1f : undefined;
    return control === undefined ? undefined : alt + String.fromCharCode(control);
  }
  if (e.text) return alt + e.text;
  if (ch < 0x20 || ch > 0x10ffff) return undefined;
  const capsLock = Boolean(e.mods & CAPS_LOCK);
  const text = String.fromCodePoint(ch);
  return alt + (!(shift && e.shifted) && shift !== capsLock ? text.toUpperCase() : text);
}
