import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KeyboardState, legacyOf, readKey } from '../src/cli/switcher/keyboard';
import { modeChanges, PLAIN_MODES } from '../src/cli/switcher/modes';
import { AgentScreen } from '../src/cli/switcher/screen';
import { keyAs } from './switcher/harness';

// The keyboard protocols inside the switcher (T191): what each agent asks of
// the keyboard (the kitty keyboard's flags, per screen, and xterm's
// modifyOtherKeys), the answer to its question, what the real terminal is
// set to, and the keys read in the forms these protocols send.

describe("the kitty keyboard's flags, kept for each agent", () => {
  it('push, pop and set as the protocol says, a stack for each screen', () => {
    const k = new KeyboardState();
    assert.equal(k.flags(false), 0);
    k.push(false, 1);
    k.push(false, 5);
    assert.equal(k.flags(false), 5);
    assert.equal(k.flags(true), 0, 'the alternate screen has a stack of its own');
    k.set(false, 2, 2); // these bits on
    assert.equal(k.flags(false), 7);
    k.set(false, 4, 3); // these bits off
    assert.equal(k.flags(false), 3);
    k.set(false, 8, 1); // all of them
    assert.equal(k.flags(false), 8);
    k.pop(false, 1);
    assert.equal(k.flags(false), 1, 'back to what was under it');
    k.pop(false, 5);
    assert.equal(k.flags(false), 0, 'popped empty: all off');
    k.set(true, 5, 1);
    assert.equal(k.flags(true), 5, 'set with nothing pushed');
    k.pop(true, 1);
    assert.equal(k.flags(true), 0, 'and a pop that empties the stack resets them');
    for (let n = 1; n <= 10; n++) k.push(true, n);
    assert.equal(k.depth(true), 8, 'the oldest go when it is full');
    k.pop(true, 7);
    assert.equal(k.flags(true), 3);
    k.otherKeys = 2;
    k.reset();
    assert.deepEqual([k.flags(false), k.flags(true), k.depth(true), k.otherKeys], [0, 0, 0, 0]);
  });

  it("in an agent's screen: per screen, its question answered from its own flags when the real terminal speaks the protocol", async () => {
    const replies: string[] = [];
    const screen = new AgentScreen(40, 5, { reply: (data) => replies.push(data) }, {}, true);
    await screen.write('\x1b[>1u\x1b[?u');
    assert.equal(screen.inputModes.keyboard, 1);
    // As Claude Code does on its full screen: CSI < u, CSI > 5 u, modifyOtherKeys 2.
    await screen.write('\x1b[?1049h\x1b[<u\x1b[>5u\x1b[>4;2m\x1b[?u');
    assert.deepEqual([screen.inputModes.keyboard, screen.inputModes.otherKeys], [5, 2]);
    await screen.write('\x1b[=2;2u\x1b[?u');
    assert.equal(screen.inputModes.keyboard, 7);
    await screen.write('\x1b[>4m\x1b[<u\x1b[?1049l\x1b[?u');
    assert.deepEqual([screen.inputModes.keyboard, screen.inputModes.otherKeys], [1, 0], 'back on the main screen, its own flags');
    assert.deepEqual(replies, ['\x1b[?1u', '\x1b[?5u', '\x1b[?7u', '\x1b[?1u']);
    assert.equal(screen.text(0), '', 'and nothing of it drawn');
    await screen.write('\x1b[>4;1m\x1bc');
    assert.deepEqual([screen.inputModes.keyboard, screen.inputModes.otherKeys], [0, 0], 'a reset puts them back');
  });

  it("goes unanswered where the real terminal doesn't speak it, as there, but is still kept", async () => {
    const replies: string[] = [];
    const screen = new AgentScreen(40, 5, { reply: (data) => replies.push(data) });
    await screen.write('\x1b[>7u\x1b[?u\x1b[c');
    assert.deepEqual(replies, ['\x1b[?1;2c'], 'only the device attributes, which end its wait');
    assert.equal(screen.inputModes.keyboard, 7);
  });
});

describe('the real terminal, set for the agent showing', () => {
  it("gets the kitty keyboard's flags only if it speaks the protocol, and modifyOtherKeys only once an agent asked for it", () => {
    const claude = { ...PLAIN_MODES, keyboard: 5, otherKeys: 2 };
    assert.equal(modeChanges(PLAIN_MODES, claude, true), '\x1b[=5;1u\x1b[>4;2m');
    assert.equal(modeChanges(claude, PLAIN_MODES, true), '\x1b[=0;1u\x1b[>4m');
    assert.equal(modeChanges(PLAIN_MODES, claude, false), '\x1b[>4;2m', 'no kitty flags where it went unanswered');
    assert.ok(modeChanges(undefined, PLAIN_MODES, true).endsWith('\x1b[=0;1u'), 'set whole the first time');
    assert.doesNotMatch(modeChanges(undefined, PLAIN_MODES, false), /u|>4/, "and in a terminal like Apple's, nothing of either");
  });
});

describe('keys in the protocols’ forms', () => {
  const typed = (s: string) => {
    const key = readKey(s);
    assert.ok(key, JSON.stringify(s));
    assert.equal(key.raw, s);
    return legacyOf(key);
  };

  it('reads each as the bytes it would be without them', () => {
    assert.equal(typed('\x1b[92;5u'), '\x1c', 'Ctrl+\\');
    assert.equal(typed('\x1b[92;69u'), '\x1c', 'with Caps Lock on');
    assert.equal(typed('\x1b[27;5;92~'), '\x1c', "Ctrl+\\ as modifyOtherKeys sends it");
    assert.equal(typed('\x1b[13;2u'), '\r', 'Shift+Enter');
    assert.equal(typed('\x1b[27;2;13~'), '\r');
    assert.equal(typed('\x1b[27u'), '\x1b');
    assert.equal(typed('\x1b[99;5u'), '\x03');
    assert.equal(typed('\x1b[122;5u'), '\x1a');
    assert.equal(typed('\x1b[113u'), 'q');
    assert.equal(typed('\x1b[113;65u'), 'Q', 'Caps Lock');
    assert.equal(typed('\x1b[113:81;2u'), 'Q', 'Shift, with the shifted key said');
    assert.equal(typed('\x1b[38:49;2u'), '1', 'Shift+& on a French keyboard is 1');
    assert.equal(typed('\x1b[50;1;50u'), '2', 'with its text');
    assert.equal(typed('\x1b[57400u'), '1', "the keypad's 1");
    assert.equal(typed('\x1b[91u'), '[');
    assert.equal(typed('\x1b[120;3u'), '\x1bx', 'Alt+x');
    assert.equal(typed('\x1b[9;2u'), '\x1b[Z', 'Shift+Tab');
    assert.equal(typed('\x1b[1;1:2A'), '\x1b[A', 'an arrow held down');
    assert.equal(typed('\x1b[1;5A'), '\x1b[1;5A');
    assert.equal(typed('\x1b[5;1:2~'), '\x1b[5~');
  });

  it('has none for a release, a modifier alone, or a key with no old bytes', () => {
    assert.equal(typed('\x1b[92;5:3u'), undefined);
    assert.equal(readKey('\x1b[92;5:2u')?.event, 'repeat');
    assert.equal(typed('\x1b[1;1:3A'), undefined);
    assert.equal(typed('\x1b[57442;5u'), undefined, 'Left Ctrl');
    assert.equal(typed('\x1b[99;9u'), undefined, 'Super+C');
    assert.equal(typed('\x1b[57376u'), undefined, 'F13');
    assert.equal(typed('\x1b[99999999u'), undefined, 'nor, without failing, for one no key could be');
    assert.equal(typed('\x1b[97;1;99999999:98u'), 'b', 'and a text with one that no character could be');
  });

  it('leaves alone what is not a key in these forms', () => {
    for (const s of ['\x1b[A', '\x1b[3~', '\x1b[200~', '\x1b[201~', '\x1b[<0;3;4M', '\x1b[?5u', '\x1b[I', 'q', '\x1b']) assert.equal(readKey(s), undefined, JSON.stringify(s));
  });

  it("the test terminal sends them as kitty and Ghostty do, for the flags it's set to", () => {
    assert.equal(keyAs(0, 'shift+enter'), '\r');
    assert.equal(keyAs(5, 'shift+enter'), '\x1b[13;2u');
    assert.equal(keyAs(5, 'enter'), '\r');
    assert.equal(keyAs(5, 'ctrl+\\'), '\x1b[92;5u');
    assert.equal(keyAs(7, 'ctrl+\\'), '\x1b[92;5u\x1b[92;5:3u');
    assert.equal(keyAs(7, 'q'), 'q');
    assert.equal(keyAs(15, 'q'), '\x1b[113u\x1b[113;1:3u');
  });
});
