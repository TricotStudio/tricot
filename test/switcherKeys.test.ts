import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InputRouter, SWITCH_KEY, type HostAction } from '../src/cli/switcher/keys';
import { encodeMouse, forTracking, readMouse, type MouseWanted } from '../src/cli/switcher/mouse';
import { sleep } from './switcher/harness';

// What the person types, sorted between Tricot and the agent showing: the
// switch key (Ctrl+\) and what follows it within a second, Ctrl+Z, clicks
// on the strip, the wheel and the scroll view's keys; everything else
// reaches the agent byte for byte, and a paste whole.

const KEY = 0x1c;
const STRIP_ROW = 30;

function router(options: { scrolling?: boolean; tricotTab?: boolean; mouse?: MouseWanted } = {}) {
  let clock = 1_000_000;
  const said: string[] = [];
  const show = (a: HostAction) => (a.kind === 'next' ? (a.again ? 'again' : 'next') : a.kind === 'send' ? `send ${JSON.stringify(a.data.toString('latin1'))}` : a.kind === 'pick' ? `pick ${a.index + 1}` : a.kind === 'click' ? `click ${a.column}` : a.kind === 'wheel' ? `wheel ${a.up ? 'up' : 'down'}` : a.kind === 'scroll' ? `scroll ${a.lines}` : a.kind === 'scroll-page' ? `page ${a.pages}` : a.kind === 'scroll-end' ? `end ${a.top ? 'top' : 'bottom'}` : a.kind);
  const state = { scrolling: options.scrolling ?? false };
  const mouse = options.mouse;
  const r = new InputRouter({ key: KEY, tricotTab: options.tricotTab, stripRow: () => STRIP_ROW, scrolling: () => state.scrolling, ...(mouse && { mouse: () => mouse }), emit: (a) => said.push(show(a)), now: () => clock, holdMs: 20 });
  return {
    r,
    said,
    state,
    type: (text: string) => r.feed(Buffer.from(text, 'latin1')),
    later: (ms: number) => (clock += ms),
  };
}

describe('the switch key', () => {
  it('goes to the next agent at once, and a digit within a second picks one', () => {
    const t = router();
    t.type('\x1c');
    assert.deepEqual(t.said, ['next']);
    t.type('2');
    assert.deepEqual(t.said, ['next', 'pick 2']);
    t.type('2');
    assert.deepEqual(t.said, ['next', 'pick 2', 'send "2"'], 'only once: a second digit is typed');
  });

  it('picks the Tricot tab with 0 when there is one (T192); without one, 0 is typed', () => {
    const t = router({ tricotTab: true });
    t.type('\x1c0');
    assert.deepEqual(t.said, ['next', 'pick 0']);
    t.type('0');
    assert.deepEqual(t.said, ['next', 'pick 0', 'send "0"'], 'once');
    const plain = router();
    plain.type('\x1c0');
    assert.deepEqual(plain.said, ['next', 'send "0"']);
  });

  it("lets a digit after the second through to the agent, and the key itself after it as next again", () => {
    const t = router();
    t.type('\x1c');
    t.later(1_001);
    t.type('3\x1c');
    assert.deepEqual(t.said, ['next', 'send "3"', 'next']);
  });

  it('pressed again within the second goes on to the next tab, and the second starts over; then q quits; then [ opens the scroll view', () => {
    const t = router();
    t.type('\x1c\x1c');
    assert.deepEqual(t.said, ['next', 'again']);
    t.type('\x1cq');
    assert.deepEqual(t.said.slice(2), ['again', 'quit']);
    t.type('\x1c[');
    assert.deepEqual(t.said.slice(4), ['next', 'scroll-view']);
  });

  it('goes on at every press, each one starting the second over, until a second passes without one', () => {
    const t = router();
    t.type('\x1c');
    for (let n = 0; n < 4; n++) {
      t.later(900);
      t.type('\x1c');
    }
    assert.deepEqual(t.said, ['next', 'again', 'again', 'again', 'again'], 'four seconds in all, one press at a time');
    assert.ok(t.r.armed);
    t.type('2');
    assert.deepEqual(t.said.slice(5), ['pick 2'], 'a digit after the last picks');
    t.type('\x1c');
    t.later(1_001);
    t.type('\x1c');
    assert.deepEqual(t.said.slice(6), ['next', 'next'], 'a press after the second has passed starts a new run');
  });

  it('never sends the switch key to the agent: a key between two presses ends the run, and the next press starts another', () => {
    const t = router();
    t.type('\x1c\x1c\x1c');
    t.type('a\x1cb');
    assert.deepEqual(t.said, ['next', 'again', 'again', 'send "a"', 'next', 'send "b"']);
  });

  it('leaves the arrows to the agent after it, as plain, SS3 and kitty forms', () => {
    const t = router();
    t.type('\x1c\x1b[D\x1bOC\x1b[1;1D');
    assert.deepEqual(t.said, ['next', `send ${JSON.stringify('\x1b[D\x1bOC\x1b[1;1D')}`]);
    const u = router();
    u.type('\x1b[92;5u\x1b[1;1:1C\x1b[1;1:3C');
    assert.deepEqual(u.said, ['next', 'send "\\u001b[1;1:1C\\u001b[1;1:3C"']);
    const v = router({ tricotTab: true });
    v.type('\x1c\x1b[A\x1b[B');
    assert.deepEqual(v.said, ['next', `send ${JSON.stringify('\x1b[A\x1b[B')}`]);
  });

  it('passes anything else after it through as typed, in one piece with what follows', () => {
    const t = router();
    t.type('ab\x1cxyz');
    assert.deepEqual(t.said, ['send "ab"', 'next', 'send "xyz"']);
  });

  it('is Ctrl+\\ alone, the byte the router is given', () => {
    assert.deepEqual(SWITCH_KEY, { byte: 0x1c, label: 'Ctrl+\\' });
    assert.equal(SWITCH_KEY.byte, KEY);
  });
});

describe('everything else', () => {
  it('reaches the agent byte for byte: control keys, arrows, Esc, UTF-8', () => {
    const t = router();
    const typed = Buffer.from('\x03\x1b[A\x1b\x1d hé ✅ 日本', 'utf8');
    t.r.feed(typed);
    assert.deepEqual(t.said, [`send ${JSON.stringify(typed.toString('latin1'))}`]);
  });

  it('keeps Ctrl+Z from the agent, which no one could bring back here', () => {
    const t = router();
    t.type('a\x1ab');
    assert.deepEqual(t.said, ['send "a"', 'suspend', 'send "b"']);
  });

  it('pastes whole, the switch key and Ctrl+Z inside it included', () => {
    const t = router();
    t.type('\x1b[200~one\x1ctwo\x1athree\x1b[201~\x1c');
    assert.deepEqual(t.said, ['send "\\u001b[200~one\\u001ctwo\\u001athree\\u001b[201~"', 'next']);
  });

  it('knows a paste goes on when its end comes in a later read, even split in two', () => {
    const t = router();
    t.type('\x1b[200~long paste \x1c');
    t.type('still pasting\x1b[20');
    assert.ok(t.r.pasting);
    t.type('1~\x1c');
    assert.ok(!t.r.pasting);
    assert.deepEqual(t.said, ['send "\\u001b[200~long paste \\u001c"', 'send "still pasting"', 'send "\\u001b[201~"', 'next']);
  });

  it('waits a moment for a paste mark cut short, then lets it through if no more comes', async () => {
    const t = router();
    t.type('\x1b[20');
    assert.deepEqual(t.said, [], 'held');
    t.type('0~a\x1cb\x1b[201~');
    assert.deepEqual(t.said, ['send "\\u001b[200~a\\u001cb\\u001b[201~"']);
    const u = router();
    u.type('x\x1b[');
    await sleep(60);
    assert.deepEqual(u.said, ['send "x"', 'send "\\u001b["']);
  });

  it('waits a moment for the rest of a key whose Esc ends a read: an arrow, Alt+key, Esc and Enter', () => {
    const t = router();
    t.type('a\x1b');
    assert.deepEqual(t.said, ['send "a"'], 'the Esc held');
    t.type('[B');
    assert.deepEqual(t.said.slice(1), ['send "\\u001b[B"'], '↓, as it would have come whole');
    t.type('\x1b');
    t.type('x');
    t.type('\x1b');
    t.type('\r');
    assert.deepEqual(t.said.slice(2), ['send "\\u001bx"', 'send "\\u001b\\r"']);
  });

  it('lets Esc pressed alone through once the wait is over, and only once', async () => {
    const t = router();
    t.type('\x1b');
    assert.deepEqual(t.said, [], 'held');
    await sleep(60);
    assert.deepEqual(t.said, ['send "\\u001b"']);
    t.type('[B');
    await sleep(60);
    assert.deepEqual(t.said, ['send "\\u001b"', 'send "[B"'], 'what comes after the wait is a key of its own');
    const twice = router();
    twice.type('\x1b');
    twice.type('\x1b');
    await sleep(60);
    assert.deepEqual(twice.said, ['send "\\u001b"', 'send "\\u001b"'], 'Esc twice: the first at once, the second after the wait');
  });

  it('keeps an Esc inside a paste with the paste, and one after the switch key goes on as before', async () => {
    const t = router();
    t.type('\x1b[200~a\x1b');
    t.type('b\x1b[201~');
    assert.deepEqual(t.said, ['send "\\u001b[200~a"', 'send "\\u001bb\\u001b[201~"']);
    const armed = router();
    armed.type('\x1c\x1b');
    await sleep(60);
    armed.type('2');
    assert.deepEqual(armed.said, ['next', 'send "\\u001b"', 'send "2"'], 'Esc is no second key: it goes on, and the switch key is spent');
    const alt = router();
    alt.type('\x1c\x1b');
    alt.type('2');
    assert.deepEqual(alt.said, ['next', 'send "\\u001b2"'], 'Alt+2 in two reads, as it would have come whole');
  });
});

// T30: the terminal reports the mouse in every tab. A click on the strip is
// Tricot's whatever the agent showing asked for; above it, the agent gets
// what it asked for and nothing more, in its own encoding, and the wheel it
// didn't ask for is the host's to scroll with.
describe('the mouse', () => {
  const SGR = (code: number, x: number, y: number, release = false) => `\x1b[<${code};${x};${y}${release ? 'm' : 'M'}`;
  const X10 = (code: number, x: number, y: number) => `\x1b[M${String.fromCharCode(32 + code, 32 + x, 32 + y)}`;
  const sent = (bytes: string) => `send ${JSON.stringify(bytes)}`;
  const NONE: MouseWanted = { tracking: 'none', encoding: 'default' };
  const SGR_ANY: MouseWanted = { tracking: 'any', encoding: 'sgr' };

  it('on the strip: a press of the left button picks the tab under it, whatever the agent showing asked for, and its drag and release go nowhere', () => {
    for (const mouse of [undefined, NONE, { tracking: 'vt200', encoding: 'sgr' }, SGR_ANY] as const) {
      const t = router({ ...(mouse && { mouse }) });
      t.type(`${SGR(0, 12, STRIP_ROW)}${SGR(32, 13, STRIP_ROW)}${SGR(32, 14, 5)}${SGR(0, 14, 5, true)}`);
      assert.deepEqual(t.said, ['click 12'], `${mouse?.tracking}: the click alone, even its release above the strip`);
      t.type(`${SGR(4, 3, STRIP_ROW)}${SGR(4, 3, STRIP_ROW, true)}`);
      assert.deepEqual(t.said, ['click 12', 'click 3'], 'Shift held too');
      t.type(`${SGR(2, 3, STRIP_ROW)}${SGR(2, 3, STRIP_ROW, true)}${SGR(35, 3, STRIP_ROW)}${SGR(64, 9, STRIP_ROW)}${SGR(65, 9, STRIP_ROW)}`);
      assert.equal(t.said.length, 2, 'another button, a move or the wheel over the strip does nothing');
    }
  });

  it('picks from the Tricot tab, where nothing above the strip is anyone’s but the wheel', () => {
    const t = router({ tricotTab: true, mouse: NONE });
    t.type(`${SGR(0, 2, STRIP_ROW)}${SGR(0, 2, STRIP_ROW, true)}`);
    assert.deepEqual(t.said, ['click 2']);
    t.type(`${SGR(0, 5, 3)}${SGR(0, 5, 3, true)}${SGR(35, 6, 3)}${SGR(64, 5, 3)}${SGR(65, 5, 3)}${SGR(66, 5, 3)}${SGR(69, 5, 3)}`);
    assert.deepEqual(t.said.slice(1), ['wheel up', 'wheel down', 'wheel down'], 'a click and a move go nowhere; the wheel, Shift held or not, scrolls; sideways it does nothing');
  });

  it('gives an agent that asked for presses and releases those and the wheel, as they came, and no motion', () => {
    const t = router({ mouse: { tracking: 'vt200', encoding: 'sgr' } });
    t.type(`${SGR(0, 5, 3)}${SGR(32, 6, 3)}${SGR(35, 7, 3)}${SGR(0, 6, 3, true)}${SGR(64, 5, 3)}${SGR(16, 1, 1)}`);
    assert.deepEqual(t.said, [sent(`${SGR(0, 5, 3)}${SGR(0, 6, 3, true)}${SGR(64, 5, 3)}${SGR(16, 1, 1)}`)]);
  });

  it('gives drags to one that asked for them, and every move to one that asked for any', () => {
    const drag = router({ mouse: { tracking: 'drag', encoding: 'sgr' } });
    drag.type(`${SGR(0, 5, 3)}${SGR(32, 6, 3)}${SGR(0, 6, 3, true)}${SGR(35, 7, 3)}`);
    assert.deepEqual(drag.said, [sent(`${SGR(0, 5, 3)}${SGR(32, 6, 3)}${SGR(0, 6, 3, true)}`)], 'a move with no button held is not a drag');
    const any = router({ mouse: SGR_ANY });
    any.type(`${SGR(35, 7, 3)}${SGR(51, 8, 3)}`);
    assert.deepEqual(any.said, [sent(`${SGR(35, 7, 3)}${SGR(51, 8, 3)}`)]);
  });

  it('gives one in X10 mode its presses alone, without modifiers, and leaves the wheel to the host', () => {
    const t = router({ mouse: { tracking: 'x10', encoding: 'default' } });
    t.type(`${SGR(0, 5, 3)}${SGR(0, 5, 3, true)}${SGR(20, 6, 3)}${SGR(32, 7, 3)}${SGR(64, 5, 3)}`);
    assert.deepEqual(t.said, [sent(`${X10(0, 5, 3)}${X10(0, 6, 3)}`), 'wheel up'], 'Shift+Ctrl and the left button is the left button');
  });

  it('re-encodes each report in the encoding the agent asked for: the first one, UTF-8, URXVT', () => {
    const first = router({ mouse: { tracking: 'any', encoding: 'default' } });
    first.type(`${SGR(0, 5, 3)}${SGR(32, 6, 3)}${SGR(2, 6, 3, true)}${SGR(65, 1, 1)}${SGR(0, 224, 3)}${SGR(0, 223, 3)}`);
    assert.deepEqual(first.said, [sent(`${X10(0, 5, 3)}${X10(32, 6, 3)}${X10(3, 6, 3)}${X10(65, 1, 1)}${X10(0, 223, 3)}`)], 'a release says 3, not its button; past column 223 the encoding can’t say where it is, so nothing goes');
    const utf8 = router({ mouse: { tracking: 'vt200', encoding: 'utf8' } });
    utf8.type(`${SGR(0, 5, 3)}${SGR(0, 300, 3, true)}`);
    assert.deepEqual(utf8.said, [sent(`\x1b[M %#\x1b[M#${Buffer.from(String.fromCharCode(332), 'utf8').toString('latin1')}#`)], 'column 300 as the two bytes of U+014C');
    const urxvt = router({ mouse: { tracking: 'vt200', encoding: 'urxvt' } });
    urxvt.type(`${SGR(0, 5, 3)}${SGR(0, 300, 3, true)}${SGR(64, 5, 3)}`);
    assert.deepEqual(urxvt.said, [sent('\x1b[32;5;3M\x1b[35;300;3M\x1b[96;5;3M')]);
  });

  it('reads the first encoding too, from a terminal without SGR: its release names the button pressed before', () => {
    const t = router({ mouse: { tracking: 'vt200', encoding: 'sgr' } });
    t.type(`${X10(0, 7, STRIP_ROW)}${X10(3, 7, STRIP_ROW)}`);
    assert.deepEqual(t.said, ['click 7']);
    t.type(`${X10(2, 4, 3)}${X10(3, 4, 3)}${X10(64, 4, 3)}`);
    assert.deepEqual(t.said.slice(1), [sent(`${SGR(2, 4, 3)}${SGR(2, 4, 3, true)}${SGR(64, 4, 3)}`)]);
  });

  it('ends a drag the agent began that leaves its window for the strip at its last row, and switches on nothing', () => {
    const t = router({ mouse: SGR_ANY });
    t.type(`${SGR(0, 5, 20)}${SGR(32, 6, STRIP_ROW)}${SGR(0, 7, STRIP_ROW, true)}${SGR(35, 7, STRIP_ROW)}`);
    assert.deepEqual(t.said, [sent(`${SGR(0, 5, 20)}${SGR(32, 6, STRIP_ROW - 1)}${SGR(0, 7, STRIP_ROW - 1, true)}`)], 'once let go, a move over the strip is no one’s');
  });

  it('gives the agent nothing in the scroll view, where the wheel scrolls', () => {
    const t = router({ scrolling: true, mouse: SGR_ANY });
    t.type(`${SGR(0, 5, 3)}${SGR(0, 5, 3, true)}${SGR(35, 6, 3)}${SGR(65, 5, 3)}${SGR(0, 4, STRIP_ROW)}`);
    assert.deepEqual(t.said, ['wheel down', 'click 4']);
  });

  it('waits for a report cut between two reads', () => {
    const t = router({ mouse: SGR_ANY });
    t.type('\x1b[<0;5');
    t.type(`;${STRIP_ROW}M`);
    assert.deepEqual(t.said, ['click 5']);
  });
});

describe('mouse reports', () => {
  it('read back as they were written, in each encoding a report can be read in', () => {
    const report = { code: 4 | 32, column: 120, row: 40, release: false };
    for (const encoding of ['sgr', 'default'] as const) assert.deepEqual(readMouse(encodeMouse(report, encoding)!)?.report, report, encoding);
    assert.equal(encodeMouse({ code: 0, column: 2016, row: 1, release: false }, 'utf8'), undefined, 'past column 2015, UTF-8 can’t say where it is either');
    assert.equal(forTracking({ code: 64, column: 1, row: 1, release: false }, 'none'), undefined, 'none is none');
  });
});

describe('the scroll view', () => {
  it('scrolls with the arrows, the page keys, Home, End and the wheel, and q or Esc goes back', async () => {
    const t = router({ scrolling: true });
    t.type('\x1b[5~\x1b[6~\x1b[A\x1bOB\x1b[H\x1b[F\x1b[<64;3;3M\x1b[<65;3;3M');
    assert.deepEqual(t.said, ['page 1', 'page -1', 'scroll 1', 'scroll -1', 'end top', 'end bottom', 'wheel up', 'wheel down']);
    t.type('zq');
    assert.deepEqual(t.said.slice(-1), ['leave-scroll'], 'other keys do nothing');
    t.type('\x1b');
    await sleep(60);
    assert.deepEqual(t.said.slice(-2), ['leave-scroll', 'leave-scroll'], 'Esc, once the wait is over');
  });

  it('scrolls with an arrow whose Esc came in a read of its own, rather than going back', () => {
    const t = router({ scrolling: true });
    t.type('\x1b');
    t.type('[B');
    assert.deepEqual(t.said, ['scroll -1']);
  });

  it('still takes the switch key', () => {
    const t = router({ scrolling: true });
    t.type('\x1c');
    assert.deepEqual(t.said, ['next']);
  });

  it('reads its keys in the keyboard protocols’ forms too, and a release scrolls nothing', () => {
    const t = router({ scrolling: true });
    t.type('\x1b[1;1:2A\x1b[1;1:3A\x1b[91;1:3u\x1b[107u\x1b[5;1:2~');
    assert.deepEqual(t.said, ['scroll 1', 'scroll 1', 'page 1'], 'an arrow held down, k, Page Up held down');
    t.type('\x1b[27u');
    assert.deepEqual(t.said.slice(-1), ['leave-scroll'], 'Esc as CSI 27u');
    t.type('\x1b[92;5u');
    assert.deepEqual(t.said.slice(-1), ['next']);
  });
});

// T191: once the agent showing has asked for the kitty keyboard protocol (or
// modifyOtherKeys), the real terminal sends keys in its form: Ctrl+\ as
// CSI 92;5u (CSI 27;5;92~), and with the flags asking for them, its repeats
// and its release.
describe('the switch key in the keyboard protocols’ forms', () => {
  it('switches on Ctrl+\\ as CSI 92;5u or CSI 27;5;92~, and the second key picks, quits or scrolls in either form', () => {
    const t = router({ tricotTab: true });
    t.type('\x1b[92;5u');
    assert.deepEqual(t.said, ['next']);
    t.type('2');
    t.type('\x1b[92;5u\x1b[51u'); // 3, with every key as CSI u (flag 8)
    t.type('\x1b[27;5;92~\x1b[48;1;48u'); // 0, with its text (flag 16)
    t.type('\x1b[92;5u\x1b[57401u'); // the keypad's 2
    t.type('\x1b[92;5u\x1b[91u');
    t.type('\x1b[92;5u\x1b[113u');
    assert.deepEqual(t.said, ['next', 'pick 2', 'next', 'pick 3', 'next', 'pick 0', 'next', 'pick 2', 'next', 'scroll-view', 'next', 'quit']);
  });

  it('never switches on a repeat or a release; they go nowhere, nor do those of the key after it', () => {
    const t = router();
    t.type('\x1b[92;5:2u\x1b[92;5:3u');
    assert.deepEqual(t.said, [], 'the switch key held down from before, then let go: nothing');
    t.type('\x1b[92;5u\x1b[92;5:2u\x1b[92;5:2u\x1b[92;5:3u');
    assert.deepEqual(t.said, ['next'], 'held down: one switch, no more');
    t.type('\x1b[57442;1:3u'); // Left Ctrl let go (flag 8)
    t.type('\x1b[50u\x1b[50;1:3u');
    assert.deepEqual(t.said, ['next', 'send "\\u001b[57442;1:3u"', 'pick 2'], 'a modifier let go leaves the second key to come; its release goes nowhere');
    t.type('\x1b[50u\x1b[50;1:3u');
    assert.deepEqual(t.said.slice(3), ['send "\\u001b[50u\\u001b[50;1:3u"'], 'let go, the same key is the agent’s again, release and all');
  });

  it('goes on at the next press and sends none of its forms to the agent, repeats and releases included, and keeps Ctrl+Z as CSI 122;5u, its release too', () => {
    const actions: HostAction[] = [];
    const r = new InputRouter({ key: KEY, stripRow: () => STRIP_ROW, scrolling: () => false, emit: (a) => actions.push(a), now: () => 1 });
    r.feed('\x1b[92;5u\x1b[92;5:2u\x1b[92;5:3u\x1b[92;5u\x1b[92;5:3u');
    r.feed('\x1b[27;5;92~\x1b[27;5;92~');
    assert.deepEqual(
      actions.map((a) => (a.kind === 'next' ? `next ${a.again}` : a.kind)),
      ['next false', 'next true', 'next true', 'next true'],
      'a press in each form goes on; repeats and releases go nowhere',
    );
    r.feed('\x1b[122;5u\x1b[122;5:3u');
    assert.deepEqual(
      actions.slice(4).map((a) => a.kind),
      ['suspend'],
    );
  });

  it('lets everything else through as it came, in one piece: Shift+Enter, Ctrl+C, releases', () => {
    const t = router();
    t.type('a\x1b[13;2ub\x1b[99;5u\x1b[97;1:3u');
    assert.deepEqual(t.said, ['send "a\\u001b[13;2ub\\u001b[99;5u\\u001b[97;1:3u"']);
  });

  it('waits a moment for one cut between two reads', () => {
    const t = router();
    t.type('\x1b[92;');
    assert.deepEqual(t.said, [], 'held');
    t.type('5u1');
    assert.deepEqual(t.said, ['next', 'pick 1']);
  });
});
