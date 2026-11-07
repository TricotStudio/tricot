import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, afterEach, describe, it, mock } from 'node:test';
import { startHost, TRICOT_TAB, type Host, type HostedAgent, type HostTerminal } from '../src/cli/switcher/host';
import { SWITCH_KEY } from '../src/cli/switcher/keys';
import type { BoardLive } from '../src/cli/switcher/strip';
import { TricotTab, type TabHost } from '../src/cli/switcher/tricotTab';
import { BOLD, DIM, type Part } from '../src/cli/switcher/tabView';
import { KNIT_MS, wordmarkFits, wordmarkNext, wordmarkRows } from '../src/cli/switcher/wordmark';
import { claudeLike, fakeTerminal, leftAfterReaping, node, tracked, waitFor } from './switcher/harness';
import { WINDOWS } from './platform';

// The wordmark at the top of the Tricot tab: TRICOT knitted up a stitch at
// a time, bottom row first, left to right, then the top row, and then there
// for good, the board's title bold beside its top row and Tricot's address
// dim beside its bottom row. The knitting plays once, from when the tab is
// first drawn; any key, or leaving the tab, ends it (the wordmark whole) and
// the key still does what it always does. A window too narrow or short has
// the one-line header instead, and the wordmark back when it grows; with
// TRICOT_NO_ANIMATION=1 it is whole at once. Its frames are pure functions
// of how long the knitting has played (the first group); the tab decides
// when it starts and the host draws each stitch through its own scheduling,
// with a clock the tests step.

after(async () => assert.deepEqual(await leftAfterReaping(), [], 'nothing left running'));

const STITCH = 32;
const BOTTOM_STITCHES = 12;
const STITCHES = 28;
const TOP_ROW = ' ▀█▀ █▀▄ █ █▀▀ █▀█ ▀█▀';
const BOTTOM_ROW = '  █  █▀▄ █ █▄▄ █▄█  █';
const width = (row: Part[]) => row.reduce((sum, [text]) => sum + [...text].length, 0);
const plain = (rows: Part[][]) => rows.map((row) => row.map(([text]) => text).join('').trimEnd());
// Each row as the looks of its characters, one letter each: b bold, d dim, a space where there is none.
const looks = (row: Part[]) => row.map(([text, sgr]) => (sgr === BOLD ? 'b' : sgr === DIM ? 'd' : ' ').repeat([...text].length)).join('');

describe('the wordmark, frame by frame', () => {
  it('starts with the first stitch of the bottom row, at its left, dim', () => {
    const rows = wordmarkRows(0);
    assert.deepEqual(plain(rows), ['', '  █']);
    assert.equal(looks(rows[0]).trim(), '', 'nothing on the top row yet');
    assert.equal(looks(rows[1]).trim(), 'd');
  });

  it('knits the bottom row left to right, one stitch a frame, the one being knitted dim until it is bold', () => {
    assert.deepEqual(plain(wordmarkRows(3 * STITCH)), ['', '  █  █▀▄'], 'three stitches made, the fourth (the second letter’s ▄) dim');
    assert.equal(looks(wordmarkRows(3 * STITCH + 5)[1]).trimEnd(), '  b  bbd', 'bold up to the dim one');
    assert.deepEqual(plain(wordmarkRows(4 * STITCH)), ['', '  █  █▀▄ █']);
    assert.equal(looks(wordmarkRows(4 * STITCH)[1]).trimEnd(), '  b  bbb d');
  });

  it('finishes the bottom row before the top row starts', () => {
    const before = wordmarkRows((BOTTOM_STITCHES - 1) * STITCH);
    assert.equal(looks(before[0]).trim(), '', 'the top row is empty while the bottom is still knitting');
    assert.equal(looks(before[1]).trimEnd().at(-1), 'd', 'the last stitch of the bottom row is the one being knitted');
    const done = wordmarkRows(BOTTOM_STITCHES * STITCH);
    assert.equal(plain(done)[1], BOTTOM_ROW);
    assert.equal(looks(done[1]).includes('d'), false, 'the bottom row is all bold');
    assert.equal(looks(done[0]).trimEnd(), ' d', 'the top row starts: its first stitch, dim, at its left');
    assert.equal(plain(done)[0], ' ▀');
  });

  it('knits the top row after it, to the whole wordmark', () => {
    assert.equal(plain(wordmarkRows((BOTTOM_STITCHES + 7) * STITCH))[0], ' ▀█▀ █▀▄ █ █');
    const whole = wordmarkRows(STITCHES * STITCH);
    assert.deepEqual(plain(whole), [TOP_ROW, BOTTOM_ROW]);
    assert.ok(!looks(whole[0]).includes('d') && !looks(whole[1]).includes('d'), 'every stitch bold');
    assert.equal(STITCHES * STITCH, KNIT_MS, 'the knitting is over with the last stitch bold');
  });

  it('stays whole once knitted, however long after, and is whole when no time is given', () => {
    for (const at of [KNIT_MS, KNIT_MS + 500, KNIT_MS + 3_600_000, Infinity]) assert.deepEqual(wordmarkRows(at), wordmarkRows(KNIT_MS), `${at}`);
    assert.deepEqual(wordmarkRows(), wordmarkRows(KNIT_MS));
  });

  it('is the same width in every frame, so what is drawn beside it never moves', () => {
    for (let at = 0; at <= KNIT_MS; at += STITCH / 2) for (const row of wordmarkRows(at)) assert.equal(width(row), 22, `${at} ms`);
  });

  it('knits in under a second, a frame every 32 ms, and asks for none once it is whole', () => {
    assert.ok(KNIT_MS >= 800 && KNIT_MS <= 1_000, `${KNIT_MS}`);
    assert.equal(wordmarkNext(0), STITCH);
    assert.equal(wordmarkNext(STITCH + 10), STITCH - 10);
    assert.equal(wordmarkNext(KNIT_MS - 1), 1);
    assert.equal(wordmarkNext(KNIT_MS), undefined);
    assert.equal(wordmarkNext(KNIT_MS + 60_000), undefined);
    // Every change of frame is a time it asks for: none missed, none drawn twice over.
    let seen = JSON.stringify(wordmarkRows(0));
    let frames = 1;
    for (let at = 0; ; ) {
      const next = wordmarkNext(at);
      if (next === undefined) break;
      at += next;
      const now = JSON.stringify(wordmarkRows(at));
      if (now !== seen) frames++;
      seen = now;
    }
    assert.equal(frames, STITCHES + 1, 'a frame for every stitch, and the last one turning bold');
  });

  it('needs a window wide enough for the title and address beside it, and tall enough for the rest', () => {
    assert.equal(wordmarkFits(100, 24), true);
    assert.equal(wordmarkFits(50, 10), true);
    assert.equal(wordmarkFits(49, 24), false);
    assert.equal(wordmarkFits(100, 9), false);
  });
});

// ---- the tab ------------------------------------------------------------------------------------

const START = 1_000_000;
const HEADER = / Tricot · Roadmap {2,}http:\/\/127\.0\.0\.1:4545 · connecting…$/;
// The header's two rows with the wordmark knitted this far: the title and address start in the 26th column.
const knitted = (top: string, bottom: string) => [`${top.padEnd(25)}Roadmap`, `${bottom.padEnd(25)}http://127.0.0.1:4545 · connecting…`];
const WHOLE = knitted(TOP_ROW, BOTTOM_ROW);

function stage(options: { wordmark?: 'knit' | 'whole'; title?: string; choices?: number } = { wordmark: 'knit' }) {
  const s = {
    at: START,
    opened: 0,
    changes: 0,
    quits: 0,
    live: undefined as BoardLive | undefined,
  };
  const host: TabHost = {
    agents: () => [{ number: 1, name: 'Claude', state: 'running' }, { number: 2, name: 'Codex', state: 'running' }],
    live: () => s.live,
    now: () => s.at,
    changed: () => void s.changes++,
    open: () => void s.opened++,
    quit: () => void s.quits++,
    choices: () => Array.from({ length: options.choices ?? 1 }, (_, i) => ({ id: `agent${i}`, name: i ? `Agent ${i}` : 'OpenCode' })),
    add: () => undefined,
    stop: () => {},
  };
  const tab = new TricotTab(host, { url: 'http://127.0.0.1:4545', title: options.title ?? 'Roadmap', ...(options.wordmark && { wordmark: options.wordmark }) });
  const screen = (cols = 100, rows = 24) => tab.render(cols, rows).plain.map((line) => line.trimEnd());
  const elapse = (ms: number) => (s.at += ms);
  return { s, tab, screen, elapse };
}

describe('the Tricot tab has the wordmark at its top', () => {
  it('knits it from when the tab is first drawn, in place of the one-line header, the rest below as usual', () => {
    const { screen, elapse } = stage();
    elapse(5_000); // time passing before the first frame is no part of it
    let rows = screen();
    assert.deepEqual(rows.slice(0, 4), [...knitted('', '  █'), '', ' Your agents']);
    elapse(BOTTOM_STITCHES * STITCH + 7 * STITCH);
    rows = screen();
    assert.deepEqual(rows.slice(0, 2), knitted(' ▀█▀ █▀▄ █ █', BOTTOM_ROW), 'part way, the title and address where they will stay');
    assert.ok(!rows.some((line) => HEADER.test(line)), 'no one-line header');
    assert.ok(rows.at(-1)!.startsWith(' o open the board'), 'the keys stay on the last row');
  });

  it('is still there once the knitting ends, and long after, with the board’s title and Tricot’s address beside it', () => {
    const { screen, elapse } = stage();
    screen();
    elapse(KNIT_MS);
    assert.deepEqual(screen().slice(0, 5), [...WHOLE, '', ' Your agents', '   1 Claude   Idle']);
    elapse(10 * 60_000);
    assert.deepEqual(screen().slice(0, 2), WHOLE, 'ten minutes later');
    assert.ok(!screen().some((line) => HEADER.test(line)));
  });

  it('draws the title bold and the address dim, the address alone once the board’s stream is live', () => {
    const { tab, s, elapse } = stage();
    tab.render(100, 24);
    elapse(KNIT_MS);
    let frame = tab.render(100, 24);
    assert.ok(frame.rows[0].includes(`\x1b[0;${BOLD}mRoadmap`), JSON.stringify(frame.rows[0]));
    assert.ok(frame.rows[1].includes(`\x1b[0;${DIM}mhttp://127.0.0.1:4545 · connecting…`), JSON.stringify(frame.rows[1]));
    s.live = { board: 'roadmap', steps: [], approvals: [], presence: [], title: 'Roadmap for spring' };
    frame = tab.render(100, 24);
    assert.deepEqual(
      frame.plain.slice(0, 2).map((line) => line.trimEnd()),
      [`${TOP_ROW}   Roadmap for spring`, `${BOTTOM_ROW}    http://127.0.0.1:4545`],
      'the title as the stream names it',
    );
  });

  it('cuts the title and the address to fit in a narrow window that still has room for it', () => {
    const { screen, elapse } = stage({ wordmark: 'knit', title: 'A very long title for a board of the most wonderful plans' });
    screen(50, 24);
    elapse(KNIT_MS);
    const [top, bottom] = screen(50, 24);
    assert.equal(top, `${TOP_ROW}   A very long title for a…`);
    assert.equal(bottom, `${BOTTOM_ROW}    http://127.0.0.1:4545 ·…`);
    assert.ok([...top].length <= 49 && [...bottom].length <= 49, 'to the last column but one, as the header’s address ends');
    const untitled = stage({ wordmark: 'whole', title: '' });
    assert.deepEqual(untitled.screen().slice(0, 2), [TOP_ROW, WHOLE[1]], 'no title: the top row alone');
  });

  it('keeps the rows that matter most in a short window, losing the least important first', () => {
    const { screen, elapse } = stage();
    screen(100, 10);
    elapse(KNIT_MS);
    const whole = screen(100, 10);
    assert.equal(whole.length, 10);
    assert.deepEqual(whole.slice(0, 2), WHOLE, whole.join('\n'));
    assert.ok(whole.at(-1)!.startsWith(' o open the board'), 'the keys stay');
    assert.ok(whole.some((line) => line.includes('Your agents')), 'and what is most important of the rest');
  });

  it('has today’s one-line header in a window too narrow or too short, and its two rows again when the window grows', () => {
    const { tab, screen, elapse } = stage();
    assert.match(screen(49, 24)[0], /^ Tricot · Roadmap$/, 'too narrow: the header, cut as it always is');
    assert.equal(tab.nextFrame(), undefined, 'and no knitting');
    elapse(100);
    assert.match(screen(100, 9)[0], HEADER, 'too short');
    assert.deepEqual(screen(100, 24).slice(0, 2), WHOLE, 'grown: whole at once, as it had no room to knit');
    assert.equal(tab.nextFrame(), undefined);
    assert.match(screen(40, 24)[0], /^ Tricot · Roadmap$/, 'narrow again');
    assert.deepEqual(screen(100, 24).slice(0, 2), WHOLE, 'and back');
  });

  it('is whole when the window grows back from a size too small mid-knit', () => {
    const { tab, screen, elapse } = stage();
    screen();
    elapse(200);
    assert.match(screen(30, 24)[0], /^ Tricot · Roadmap$/);
    assert.equal(tab.nextFrame(), undefined, 'the knitting is over');
    elapse(10);
    assert.deepEqual(screen().slice(0, 2), WHOLE);
  });

  it('never draws half of it: the one-line header where the body has room for one row only', () => {
    const { tab, screen } = stage({ wordmark: 'whole', choices: 8 });
    tab.key(Buffer.from('a'));
    const rows = screen(100, 10);
    assert.match(rows[0], HEADER, rows.join('\n'));
    assert.equal(rows[1], ' Add which agent?   ↑↓ move · Enter pick · Esc cancel');
    assert.ok(!rows.some((line) => line.includes('▀█▀')));
  });

  it('is whole at once, with nothing to knit, with TRICOT_NO_ANIMATION=1', () => {
    const { tab, screen, elapse } = stage({ wordmark: 'whole' });
    assert.deepEqual(screen().slice(0, 2), WHOLE, 'on the first frame');
    assert.equal(tab.nextFrame(), undefined, 'and no frame asked for');
    elapse(300);
    assert.deepEqual(screen().slice(0, 2), WHOLE);
    assert.equal(tab.nextFrame(), undefined);
    assert.match(screen(49, 24)[0], /^ Tricot · Roadmap$/, 'a small window has the header all the same');
  });

  it('is the one-line header alone for a tab set up without it', () => {
    assert.match(stage({}).screen()[0], HEADER);
  });

  it('knits once: after the knitting ends it is whole, even were the clock back at the start', () => {
    const { tab, screen, elapse, s } = stage();
    screen();
    elapse(KNIT_MS + 1);
    assert.deepEqual(screen().slice(0, 2), WHOLE);
    s.at = START;
    assert.deepEqual(screen().slice(0, 2), WHOLE);
    assert.equal(tab.nextFrame(), undefined);
  });

  it('asks for its next frame while it knits, and for none once it is whole', () => {
    const { tab, screen, elapse } = stage();
    assert.equal(tab.nextFrame(), undefined, 'not before it is drawn');
    screen();
    assert.equal(tab.nextFrame(), STITCH);
    elapse(STITCH + 10);
    assert.equal(tab.nextFrame(), STITCH - 10, 'the next stitch');
    elapse(KNIT_MS - STITCH - 11);
    assert.equal(tab.nextFrame(), 1, 'the last stitch turning bold');
    elapse(1);
    screen();
    assert.equal(tab.nextFrame(), undefined, 'whole');
  });

  describe('any key ends the knitting at once, the wordmark whole, and still does what it does', () => {
    it('a opens the list of agents to add', () => {
      const { tab, screen, elapse } = stage();
      screen();
      elapse(200);
      tab.key(Buffer.from('a'));
      const rows = screen();
      assert.deepEqual(rows.slice(0, 2), WHOLE);
      assert.ok(rows.some((line) => line.startsWith(' Add which agent?')), rows.join('\n'));
      assert.equal(tab.nextFrame(), undefined);
    });

    it('t opens the threads below the wordmark, and Esc comes back to status', () => {
      const { tab, screen, elapse } = stage();
      screen();
      elapse(200);
      tab.key(Buffer.from('t'));
      const rows = screen();
      assert.deepEqual(rows.slice(0, 2), WHOLE);
      assert.ok(!rows.some((line) => line.includes('Your agents')), rows.join('\n'));
      assert.ok(rows.some((line) => /Threads/i.test(line)), rows.join('\n'));
      tab.key(Buffer.from('\x1b'));
      assert.deepEqual(screen().slice(0, 2), WHOLE);
    });

    it('o opens the board, an arrow key is a key too, and q quits', () => {
      const open = stage();
      open.screen();
      open.tab.key(Buffer.from('o'));
      assert.equal(open.s.opened, 1);
      assert.deepEqual(open.screen().slice(0, 2), WHOLE);
      const arrow = stage();
      arrow.screen();
      arrow.tab.key(Buffer.from('\x1b[A'));
      assert.deepEqual(arrow.screen().slice(0, 2), WHOLE);
      const quit = stage();
      quit.screen();
      quit.tab.key(Buffer.from('q'));
      assert.equal(quit.s.quits, 1);
    });

    it('asks to be drawn again, so it is whole at once', () => {
      const { tab, screen, s } = stage();
      screen();
      const before = s.changes;
      tab.key(Buffer.from('x'));
      assert.ok(s.changes > before);
    });
  });

  it('is whole, with no knitting left, for a tab that is closing', () => {
    const { tab, screen, elapse } = stage();
    screen();
    elapse(100);
    tab.closing();
    const rows = screen();
    assert.deepEqual(rows.slice(0, 2), WHOLE);
    assert.equal(rows.at(-1), ' Closing the agents…');
    assert.equal(tab.nextFrame(), undefined);
  });
});

// ---- the host ---------------------------------------------------------------------------------------

describe('the host draws it through its own scheduling', () => {
  const timers: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  let host: Host | undefined;

  afterEach(() => {
    host?.quit();
    host = undefined;
    globalThis.setTimeout = realSetTimeout;
    mock.timers.reset();
  });

  // A host with a Tricot tab and no agent, on a clock the test steps: timers and Date are the mock's.
  async function opened(options: { wordmark?: 'knit' | 'whole'; cols?: number; rows?: number }) {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const mocked = globalThis.setTimeout;
    timers.length = 0;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      timers.push(ms ?? 0);
      return mocked(fn, ms, ...rest);
    }) as typeof setTimeout;
    const input = new EventEmitter();
    const writes: string[] = [];
    const size = { cols: options.cols ?? 100, rows: options.rows ?? 24 };
    const resized: (() => void)[] = [];
    const terminal: HostTerminal = { input, write: (text) => void writes.push(text), size: () => size, onResize: (listener) => (resized.push(listener), () => {}) };
    const started = startHost({ agents: [], terminal, key: SWITCH_KEY, colours: {}, tricot: { url: 'http://127.0.0.1:4545', title: 'Roadmap', open: () => {}, choices: () => [{ id: 'codex', name: 'Codex' }], ...(options.wordmark && { wordmark: options.wordmark }) } });
    host = started;
    await started.started;
    const advance = (ms: number) => {
      for (let i = 0; i < ms; i++) mock.timers.tick(1);
    };
    const resize = (cols: number, rows: number) => {
      Object.assign(size, { cols, rows });
      for (const listener of resized) listener();
    };
    const tab = () => started.view().tab!.map((line) => line.trimEnd());
    return { host: started, input, writes, advance, resize, tab };
  }

  it('knits it up on the host’s own frames, then it stays, and nothing is left scheduled', async () => {
    const run = await opened({ wordmark: 'knit' });
    assert.deepEqual(run.tab().slice(0, 2), knitted('', '  █'), 'the first stitch on the first frame');
    run.advance(130);
    assert.deepEqual(run.tab().slice(0, 2), knitted('', '  █  █▀▄ █'), 'four stitches made and the fifth being knitted by 130 ms');
    run.advance(260);
    assert.deepEqual(run.tab().slice(0, 2), knitted(' ▀', BOTTOM_ROW), '390 ms: the bottom row whole and the top row begun');
    run.advance(510);
    assert.deepEqual(run.tab().slice(0, 2), WHOLE, 'whole at 900 ms');
    // The host's own once-a-second tick draws at 1,000 ms; between it and the next, nothing is asked for.
    run.advance(110);
    const written = run.writes.length;
    const scheduled = timers.length;
    run.advance(980);
    assert.equal(timers.length, scheduled, 'no frame asked for once it is whole');
    assert.equal(run.writes.length, written, 'and nothing drawn');
    assert.deepEqual(run.tab().slice(0, 2), WHOLE, 'still there');
  });

  it('draws a frame about every 32 ms while it knits', async () => {
    const run = await opened({ wordmark: 'knit' });
    const first = run.writes.length;
    run.advance(32 * 3 + 1);
    assert.equal(run.writes.length - first, 3, 'one draw a stitch');
    assert.ok(timers.some((ms) => ms > 0 && ms <= 32));
  });

  it('draws it whole at once with TRICOT_NO_ANIMATION=1, and keeps no frame scheduled', async () => {
    const run = await opened({ wordmark: 'whole' });
    assert.deepEqual(run.tab().slice(0, 2), WHOLE);
    const scheduled = timers.length;
    const written = run.writes.length;
    run.advance(900);
    assert.equal(run.writes.length, written);
    assert.equal(timers.length, scheduled);
  });

  it('has the one-line header in a narrow window', async () => {
    assert.match((await opened({ wordmark: 'knit', cols: 49 })).tab()[0], /^ Tricot · Roadmap/);
  });

  it('has the one-line header in a short window', async () => {
    assert.match((await opened({ wordmark: 'knit', rows: 10 })).tab()[0], /^ Tricot · Roadmap/, 'nine rows above the strip');
  });

  it('follows the window as it resizes: the header in a small one, the wordmark whole again when it grows', async () => {
    const run = await opened({ wordmark: 'knit' });
    run.advance(300);
    run.resize(40, 24);
    assert.match(run.tab()[0], /^ Tricot · Roadmap$/);
    const scheduled = timers.length;
    run.advance(600);
    assert.equal(timers.length, scheduled, 'no knitting in it');
    run.resize(100, 24);
    assert.deepEqual(run.tab().slice(0, 2), WHOLE);
  });

  it('is cut short by a key: the key acts, the wordmark is whole, and no frame is asked for after', async () => {
    const run = await opened({ wordmark: 'knit' });
    run.advance(200);
    run.input.emit('data', Buffer.from('a'));
    run.advance(10);
    const rows = run.tab();
    assert.deepEqual(rows.slice(0, 2), WHOLE);
    assert.ok(rows.some((line) => line.startsWith(' Add which agent?')), rows.join('\n'));
    const scheduled = timers.length;
    run.advance(900 - 210);
    assert.equal(timers.length, scheduled);
  });

  it('asks for no frame after the host quits', async () => {
    const run = await opened({ wordmark: 'knit' });
    run.advance(300);
    run.host.quit();
    await run.host.done;
    const scheduled = timers.length;
    const written = run.writes.length;
    run.advance(2_000);
    assert.equal(timers.length, scheduled);
    assert.equal(run.writes.length, written);
  });
});

describe('the host, with agents', { skip: WINDOWS && 'needs pseudo-terminals, which Windows has none of for Tricot' }, () => {
  const agent: HostedAgent = { name: 'Claude', id: 'claude', command: node, args: [claudeLike], env: { ...process.env, TERM: 'xterm-256color' }, cwd: process.cwd() };

  // The clock stands still until the test moves it, so the wordmark is where the test says.
  async function hosted(test: (run: { host: Host; type(text: string): void; clock: { at: number }; tab(): string[] }) => Promise<void>, options: { wordmark?: 'knit' | 'whole' } = { wordmark: 'knit' }) {
    const fake = fakeTerminal(100, 30);
    const clock = { at: START };
    const host = tracked(startHost({ agents: [agent], terminal: fake.terminal, key: SWITCH_KEY, closeMs: 1_500, now: () => clock.at, tricot: { url: 'http://127.0.0.1:4545', title: 'Roadmap', open: () => {}, ...options } }));
    try {
      await host.started;
      await test({ host, type: fake.type, clock, tab: () => host.view().tab!.map((line) => line.trimEnd()) });
    } finally {
      host.quit();
      await host.done;
    }
  }

  it('stays when you come back to the tab: leaving it mid-knit ends the knitting, never the wordmark', async () => {
    await hosted(async ({ host, type, clock, tab }) => {
      assert.ok(await waitFor(() => tab()[1]?.startsWith('  █ ')), tab().join('\n'));
      clock.at += 300;
      type('\x1c1');
      assert.ok(await waitFor(() => host.view().visible === 0));
      clock.at += 100;
      type('\x1c0');
      assert.ok(await waitFor(() => host.view().visible === TRICOT_TAB));
      assert.ok(await waitFor(() => tab()[0] === WHOLE[0]), `whole, though only 400 ms of the knitting had played:\n${tab().join('\n')}`);
      assert.equal(tab()[1], WHOLE[1]);
      clock.at += 5_000;
      type('\x1c1');
      assert.ok(await waitFor(() => host.view().visible === 0));
      type('\x1c0');
      assert.ok(await waitFor(() => host.view().visible === TRICOT_TAB));
      assert.deepEqual(tab().slice(0, 2), WHOLE);
    });
  });

  it('shows it whole as the switcher opens with the setting', async () => {
    await hosted(
      async ({ tab }) => {
        assert.ok(await waitFor(() => tab()[0] === WHOLE[0]), tab().join('\n'));
      },
      { wordmark: 'whole' },
    );
  });

  it('does not delay what is typed to an agent', async () => {
    await hosted(async ({ host, type, tab }) => {
      assert.ok(await waitFor(() => tab()[1]?.startsWith('  █ ')));
      type('\x1c1');
      assert.ok(await waitFor(() => host.view().visible === 0));
      assert.ok(await waitFor(() => host.view().agents[0].screen.lines().join('\n').includes('Claude (stand-in)')));
      type('hi');
      assert.ok(await waitFor(() => host.view().agents[0].screen.lines().join('\n').includes('> hi')), 'it reaches the agent with the wordmark half knitted');
    });
  });
});
