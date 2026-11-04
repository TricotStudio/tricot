import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InputRouter, parseSwitchKey, type HostAction } from '../src/cli/switcher/keys';
import { sleep } from './switcher/harness';

// What the person types, sorted between Tricot and the agent showing: the
// switch key (Ctrl+\) and what follows it within a second, Ctrl+Z, clicks
// on the strip and the scroll view's keys; everything else reaches the
// agent byte for byte, and a paste whole.

const KEY = 0x1c;
const STRIP_ROW = 30;

function router(options: { scrolling?: boolean; tricotTab?: boolean } = {}) {
  let clock = 1_000_000;
  const said: string[] = [];
  const show = (a: HostAction) => (a.kind === 'send' ? `send ${JSON.stringify(a.data.toString('latin1'))}` : a.kind === 'pick' ? `pick ${a.index + 1}` : a.kind === 'click' ? `click ${a.column}` : a.kind === 'scroll' ? `scroll ${a.lines}` : a.kind === 'scroll-page' ? `page ${a.pages}` : a.kind === 'scroll-end' ? `end ${a.top ? 'top' : 'bottom'}` : a.kind);
  const state = { scrolling: options.scrolling ?? false };
  const r = new InputRouter({ key: KEY, tricotTab: options.tricotTab, stripRow: () => STRIP_ROW, scrolling: () => state.scrolling, emit: (a) => said.push(show(a)), now: () => clock, holdMs: 20 });
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

  it('twice sends the key itself to the agent you were on; then q quits; then [ opens the scroll view', () => {
    const t = router();
    t.type('\x1c\x1c');
    assert.deepEqual(t.said, ['next', 'literal']);
    t.type('\x1cq');
    assert.deepEqual(t.said.slice(2), ['next', 'quit']);
    t.type('\x1c[');
    assert.deepEqual(t.said.slice(4), ['next', 'scroll-view']);
  });

  it('passes anything else after it through as typed, in one piece with what follows', () => {
    const t = router();
    t.type('ab\x1cxyz');
    assert.deepEqual(t.said, ['send "ab"', 'next', 'send "xyz"']);
  });

  it('can be another control key, but not one the agents need', () => {
    assert.deepEqual(parseSwitchKey('ctrl-\\'), { byte: 0x1c, label: 'Ctrl+\\' });
    assert.deepEqual(parseSwitchKey('ctrl+]'), { byte: 0x1d, label: 'Ctrl+]' });
    assert.deepEqual(parseSwitchKey('C-g'), { byte: 0x07, label: 'Ctrl+G' });
    assert.deepEqual(parseSwitchKey('^_'), { byte: 0x1f, label: 'Ctrl+_' });
    for (const taken of ['ctrl-c', 'ctrl-m', 'ctrl-[', 'ctrl-z']) assert.match((parseSwitchKey(taken) as { problem: string }).problem, /can't be/);
    assert.match((parseSwitchKey('F12') as { problem: string }).problem, /takes a control key/);
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
    const v = router();
    v.type('\x1b');
    assert.deepEqual(v.said, ['send "\\u001b"'], 'a lone Esc goes at once');
  });
});

describe('the mouse', () => {
  it('on the strip: a click picks an agent and nothing reaches the agent; elsewhere it reaches the agent', () => {
    const t = router();
    t.type(`\x1b[<0;12;${STRIP_ROW}M\x1b[<0;12;${STRIP_ROW}m`);
    assert.deepEqual(t.said, ['click 12']);
    t.type('\x1b[<0;5;3M\x1b[<64;5;3M');
    assert.deepEqual(t.said.slice(1), ['send "\\u001b[<0;5;3M\\u001b[<64;5;3M"']);
    t.type(`\x1b[<32;9;${STRIP_ROW}M\x1b[<64;9;${STRIP_ROW}M`);
    assert.equal(t.said.length, 2, 'a drag or the wheel over the strip does nothing');
  });

  it('reads the older encoding too', () => {
    const t = router();
    t.type(`\x1b[M ${String.fromCharCode(32 + 7)}${String.fromCharCode(32 + STRIP_ROW)}\x1b[M#${String.fromCharCode(32 + 7)}${String.fromCharCode(32 + STRIP_ROW)}`);
    assert.deepEqual(t.said, ['click 7']);
  });
});

describe('the scroll view', () => {
  it('scrolls with the arrows, the page keys, Home, End and the wheel, and q or Esc goes back', () => {
    const t = router({ scrolling: true });
    t.type('\x1b[5~\x1b[6~\x1b[A\x1bOB\x1b[H\x1b[F\x1b[<64;3;3M\x1b[<65;3;3M');
    assert.deepEqual(t.said, ['page 1', 'page -1', 'scroll 1', 'scroll -1', 'end top', 'end bottom', 'scroll 3', 'scroll -3']);
    t.type('zq');
    assert.deepEqual(t.said.slice(-1), ['leave-scroll'], 'other keys do nothing');
    t.type('\x1b');
    assert.deepEqual(t.said.slice(-1), ['leave-scroll']);
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

  it('sends the switch key twice as it came, and keeps Ctrl+Z as CSI 122;5u, its release too', () => {
    const actions: HostAction[] = [];
    const r = new InputRouter({ key: KEY, stripRow: () => STRIP_ROW, scrolling: () => false, emit: (a) => actions.push(a), now: () => 1 });
    r.feed('\x1b[92;5u\x1b[92;5:3u\x1b[92;5u\x1b[92;5:3u');
    assert.deepEqual(
      actions.map((a) => a.kind),
      ['next', 'literal'],
    );
    assert.equal((actions[1] as { data: Buffer }).data.toString(), '\x1b[92;5u', 'the agent gets Ctrl+\\ in the form it asked for');
    r.feed('\x1b[122;5u\x1b[122;5:3u');
    assert.deepEqual(
      actions.slice(2).map((a) => a.kind),
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
