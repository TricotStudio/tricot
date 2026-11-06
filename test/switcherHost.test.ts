import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { startHost, TRICOT_TAB, type Host, type HostedAgent } from '../src/cli/switcher/host';
import { SWITCH_KEY } from '../src/cli/switcher/keys';
import type { LiveFeed } from '../src/cli/switcher/live';
import type { BoardLive } from '../src/cli/switcher/strip';
import { alive, claudeLike, codexLike, COLOURS, fakeTerminal, keyAs, leftAfterReaping, node, sameScreen, sleep, tracked, waitFor, type FakeTerminal } from './switcher/harness';
import { WINDOWS } from './platform';

// The host with real agents (the stand-ins for Claude Code's full-screen
// renderer and for Codex, in pseudo-terminals of their own), drawing on a
// terminal the test plays (the harness's observer). After each step, what
// the terminal shows is what the agent showing believes is on its screen,
// row by row, colours and all, and the strip says what each one is doing.
// Each test closes its host however it ends, and nothing is left running
// after them all: no agent, no pty helper.

after(async () => assert.deepEqual(await leftAfterReaping(), [], 'nothing left running'));

const KEY = SWITCH_KEY;
const env = { ...process.env, TERM: 'xterm-256color' };
const agent = (name: string, script: string, ...args: string[]): HostedAgent => ({ name, command: node, args: [script, ...args], env, cwd: process.cwd() });
const CLAUDE = agent('Claude', claudeLike);
const CODEX = agent('Codex', codexLike, '--exit=3');

interface Running {
  host: Host;
  fake: FakeTerminal;
  shows(text: string, ms?: number): Promise<boolean>;
  agentShows(index: number, text: string, ms?: number): Promise<boolean>;
  strip(): Promise<string>;
  matches(): Promise<Awaited<ReturnType<typeof sameScreen>>>;
}

async function hosted(agents: HostedAgent[], test: (run: Running) => Promise<void>, options: { live?: LiveFeed; cols?: number; rows?: number; kitty?: boolean } = {}): Promise<void> {
  const fake = fakeTerminal(options.cols ?? 100, options.rows ?? 30, COLOURS, { kitty: options.kitty });
  const host = tracked(startHost({ agents, terminal: fake.terminal, key: KEY, closeMs: 1_500, ...(options.live && { live: options.live }) }));
  const run: Running = {
    host,
    fake,
    shows: (text, ms) =>
      waitFor(async () => {
        await fake.observer.settled();
        return fake.observer.text().includes(text);
      }, ms),
    agentShows: (index, text, ms) => waitFor(() => host.view().agents[index].screen.lines().join('\n').includes(text), ms),
    strip: async () => {
      await fake.observer.settled();
      return fake.observer.strip();
    },
    matches: async () => {
      // Settle: the next frame, after the agent's latest drawing.
      await sleep(60);
      const view = host.view();
      return sameScreen(fake.observer, view.agents[view.visible].screen);
    },
  };
  try {
    await host.started;
    await test(run);
  } finally {
    host.quit();
    await host.done;
  }
}

describe('several agents in one terminal', { timeout: 60_000, skip: WINDOWS && 'needs pseudo-terminals, which Windows has none of for Tricot' }, () => {
  it('shows the first agent, answers what each asks at startup, and switches with every colour in place', async () => {
    await hosted([CLAUDE, CODEX], async ({ host, fake, shows, agentShows, strip, matches }) => {
      assert.ok(await shows('Claude (stand-in)'), fake.observer.text());
      assert.ok(await shows('background rgb:1e1e/1e1e/1e1e'), "Claude asked the terminal's colours, and the host answered with the real terminal's");
      assert.ok(await agentShows(1, 'probes: kitty=no pos=1,1'), 'hidden Codex got answers at startup instead of waiting');
      let same = await matches();
      assert.ok(same.same, JSON.stringify(same.example));
      assert.match(await strip(), /^ ● 1 Claude · (working|idle) {3}○ 2 Codex · (working|idle) .*Ctrl\+\\ next · Ctrl\+\\ 1–2 pick · Ctrl\+\\ q quit $/);
      assert.equal(fake.raw, true, 'the terminal in raw mode');
      assert.ok(fake.observer.screen.altScreen, 'on its alternate screen, so nothing it had is lost');

      fake.type('\x1c');
      assert.ok(await shows('>_ Codex (stand-in)  100x29'), 'Codex, one row short for the strip');
      same = await matches();
      assert.ok(same.same, JSON.stringify(same.example));
      assert.match(fake.observer.screen.row(0), /48;2;\d+;60;\d+m/, "Codex's truecolour header, as it drew it");
      assert.equal(host.view().visible, 1);
      assert.match(await strip(), /○ 1 Claude .* ● 2 Codex/);
      // The terminal reads input the way Codex asked: all mouse motion, SGR, paste, focus.
      assert.deepEqual(fake.observer.screen.inputModes, host.view().agents[1].modes);
      assert.equal(fake.observer.screen.inputModes.mouse, 'any');
      assert.ok(await agentShows(1, 'events: focus in'), 'Codex is told it has the focus');

      await sleep(1_100);
      fake.type('\x1c1');
      assert.ok(await shows('Claude (stand-in)'));
      same = await matches();
      assert.ok(same.same, JSON.stringify(same.example));
      assert.equal(fake.observer.screen.inputModes.mouse, 'drag', "and back to Claude's");
    });
  });

  it('sends keys, Ctrl+C and pastes to the agent showing alone, the switch key twice as itself, and keeps Ctrl+Z from both', async () => {
    await hosted([CLAUDE, CODEX], async ({ host, fake, shows, agentShows }) => {
      assert.ok(await shows('last key: none yet'));
      fake.type('hello');
      assert.ok(await shows('> hello'));
      fake.type('\x03');
      assert.ok(await shows('last key: Ctrl+C (press again to exit)'));
      fake.type('\x1b[200~pasted \x1c text\x1b[201~');
      assert.ok(await shows('last key: paste "pasted \\u001c text"'), 'the paste, switch key and all');
      assert.equal(host.view().visible, 0, 'the switch key in a paste switched nothing');
      fake.type('\x1a');
      assert.ok(await shows('Ctrl+Z does nothing here'), fake.observer.strip());
      assert.ok(!host.view().agents[0].screen.lines().join('\n').includes('Ctrl+Z'), 'Claude never got it');
      const codex = host.view().agents[1].screen.lines().join('\n');
      assert.ok(!/key (68|03|1a)/.test(codex), 'Codex got none of it');

      fake.type('\x1c\x1c');
      assert.ok(await agentShows(0, 'last key: Ctrl+\\ (1c)'), 'twice: Claude gets Ctrl+\\ itself');
      assert.equal(host.view().visible, 0, 'and still shows');
      await sleep(1_100);
      fake.type('\x1c2');
      await waitFor(() => host.view().visible === 1);
      fake.type('X');
      assert.ok(await agentShows(1, 'events:'), 'typing now reaches Codex');
    });
  });

  it('switches on a click on the strip, when the agent showing has the mouse on', async () => {
    await hosted([CLAUDE, CODEX], async ({ host, fake, shows, strip }) => {
      assert.ok(await shows('Claude (stand-in)'));
      await waitFor(() => fake.observer.screen.inputModes.mouse !== 'none');
      const line = await strip();
      const x = line.indexOf('2 Codex') + 2;
      fake.type(`\x1b[<0;${x};30M\x1b[<0;${x};30m`);
      assert.ok(await waitFor(() => host.view().visible === 1));
    });
  });

  it('rings the bell for a hidden agent and says it wants you, until it shows', async () => {
    // Claude, hidden behind Codex, rings two seconds in, as when it finishes.
    await hosted([agent('Codex', codexLike), agent('Claude', claudeLike, '--bell-after=2000', '--notify-after=2200')], async ({ fake, shows, strip }) => {
      assert.ok(await shows('>_ Codex'));
      assert.doesNotMatch(await strip(), /wants you/);
      assert.ok(await waitFor(async () => / ○ 2 Claude · wants you /.test(await strip()), 6_000), await strip());
      assert.ok(fake.observer.written().includes('\x07'), 'the bell reached the terminal');
      assert.ok(await waitFor(() => fake.observer.written().includes('\x1b]9;Claude (stand-in) needs your attention\x07')), 'and the notification');
      await sleep(1_100);
      fake.type('\x1c');
      assert.ok(await waitFor(async () => / ● 2 Claude · (working|idle) /.test(await strip())), 'seen: it no longer wants you');
    });
  });

  it('resizes every agent with the window, and the terminal still matches after a switch', async () => {
    await hosted([CLAUDE, CODEX], async ({ fake, shows, matches }) => {
      assert.ok(await shows('100x29'));
      fake.resize(120, 36);
      assert.ok(await shows('120x35'), 'Claude, one row short for the strip');
      let same = await matches();
      assert.ok(same.same, JSON.stringify(same.example));
      fake.type('\x1c');
      assert.ok(await shows('>_ Codex (stand-in)  120x35'), 'Codex too, while hidden');
      same = await matches();
      assert.ok(same.same, JSON.stringify(same.example));
      assert.match(fake.observer.strip(), / ● 2 Codex/);
    });
  });

  it("says an agent ended, with its exit code, shows the next, and ends when they all have", async () => {
    const fake = fakeTerminal(100, 30);
    const host = tracked(startHost({ agents: [CLAUDE, CODEX], terminal: fake.terminal, key: KEY }));
    try {
      await host.started;
      await waitFor(() => host.view().agents.every((a) => a.screen.lines().join('').includes('stand-in')));
      await sleep(300);
      fake.type('\x1c');
      await waitFor(() => host.view().visible === 1);
      fake.type('X'); // Codex ends with 3
      assert.ok(await waitFor(() => host.view().agents[1].state === 'ended'), 'Codex ended');
      assert.ok(await waitFor(() => host.view().visible === 0), 'Claude shows');
      await fake.observer.settled();
      assert.ok(await waitFor(async () => (await fake.observer.settled(), / ✕ 2 Codex · ended \(3\) /.test(fake.observer.strip()))), fake.observer.strip());
      fake.type('\x03');
      await sleep(100);
      fake.type('\x03'); // Claude ends with 0
      const outcome = await host.done;
      assert.deepEqual(outcome, { exits: [0, 3], agents: [{ name: 'Claude' }, { name: 'Codex' }], quit: false });
      await fake.observer.settled();
      assert.equal(fake.observer.screen.altScreen, false, 'the terminal is back as it was');
      assert.equal(fake.raw, false);
    } finally {
      host.quit();
      await host.done;
    }
  });

  it('takes away what was made for an agent alone when it ends, and for the others when the host does, once each', async () => {
    const cleaned: string[] = [];
    const made = (name: string, script: string, ...args: string[]): HostedAgent => ({ ...agent(name, script, ...args), cleanup: () => void cleaned.push(name) });
    const fake = fakeTerminal(100, 30);
    const host = tracked(startHost({ agents: [made('Claude', claudeLike), made('Codex', codexLike, '--exit=3')], terminal: fake.terminal, key: KEY }));
    try {
      await host.started;
      await waitFor(() => host.view().agents.every((a) => a.screen.lines().join('').includes('stand-in')));
      await sleep(300);
      assert.deepEqual(cleaned, [], 'nothing taken away while they run');
      fake.type('\x1c');
      await waitFor(() => host.view().visible === 1);
      fake.type('X'); // Codex ends with 3
      assert.ok(await waitFor(() => host.view().agents[1].state === 'ended'), 'Codex ended');
      assert.deepEqual(cleaned, ['Codex'], "Codex's, as it ended; Claude is still running");
      fake.type('\x1c');
      await sleep(50);
      fake.type('q');
      await host.done;
      assert.deepEqual(cleaned.sort(), ['Claude', 'Codex'], "Claude's when the host closed; Codex's not again, or it ran twice");
    } finally {
      host.quit();
      await host.done;
    }
  });

  it("takes away what was made for an agent that couldn't start", async () => {
    const cleaned: string[] = [];
    const fake = fakeTerminal(100, 30);
    const broken: HostedAgent = { name: 'Gone', command: '/no/such/agent', args: [], env, cwd: process.cwd(), cleanup: () => void cleaned.push('Gone') };
    const host = tracked(startHost({ agents: [CLAUDE, broken], terminal: fake.terminal, key: KEY }));
    try {
      await host.started;
      await waitFor(() => host.view().agents[1]?.state === 'ended');
      assert.deepEqual(cleaned, ['Gone']);
    } finally {
      host.quit();
      await host.done;
    }
  });

  it('quits on the switch key then q: every agent is closed, and the terminal put back', async () => {
    const fake = fakeTerminal(100, 30);
    const host = tracked(startHost({ agents: [CLAUDE, CODEX], terminal: fake.terminal, key: KEY }));
    try {
      await host.started;
      await waitFor(() => host.view().agents.every((a) => a.pid > 0 && a.screen.lines().join('').includes('stand-in')));
      const pids = host.view().agents.map((a) => a.pid);
      assert.ok(pids.every(alive));
      fake.type('\x1c');
      await sleep(50);
      fake.type('q');
      const outcome = await host.done;
      assert.deepEqual(outcome, { exits: [undefined, undefined], agents: [{ name: 'Claude' }, { name: 'Codex' }], quit: true }, 'closed, not failed');
      assert.ok(await waitFor(() => !pids.some(alive), 4_000), 'no agent left running');
      await fake.observer.settled();
      const screen = fake.observer.screen;
      assert.equal(screen.altScreen, false);
      assert.equal(screen.cursor.visible, true);
      assert.deepEqual(screen.inputModes, { bracketedPaste: false, focus: false, mouse: 'none', mouseEncoding: 'default', cursorKeys: false, keypad: false, cursorStyle: 0, keyboard: 0, otherKeys: 0 });
    } finally {
      host.quit();
      await host.done;
    }
  });

  it("scrolls back through an agent's history in the scroll view, and says so of one that draws its own screen", async () => {
    const lines: HostedAgent = { name: 'Lines', command: node, args: ['-e', "for (let i = 1; i <= 100; i++) console.log('line ' + i); setInterval(() => {}, 1000)"], env, cwd: process.cwd() };
    await hosted([lines, CODEX], async ({ host, fake, shows }) => {
      const top = async () => (await fake.observer.settled(), fake.observer.screen.text(0));
      assert.ok(await shows('line 100'));
      assert.equal(await top(), 'line 73', '29 rows: the last 28 lines, and the cursor under them');
      fake.type('\x1c[');
      assert.ok(await waitFor(() => host.view().scrolling && host.view().visible === 0));
      assert.ok(await waitFor(async () => /Scrolling Lines/.test(fake.observer.strip())));
      fake.type('\x1b[5~\x1b[5~');
      assert.ok(await waitFor(async () => (await top()) === 'line 17'), await top());
      assert.ok(!fake.observer.text().includes('line 100'));
      fake.type('\x1b[H');
      assert.ok(await waitFor(async () => (await top()) === 'line 1'));
      fake.type('q');
      assert.ok(await waitFor(() => !host.view().scrolling));
      assert.ok(await waitFor(async () => (await top()) === 'line 73'));

      fake.type('\x1c');
      await waitFor(() => host.view().visible === 1);
      await sleep(1_100);
      fake.type('\x1c[');
      assert.ok(await shows('Codex draws its own screen: scroll inside it.'), fake.observer.strip());
      assert.equal(host.view().visible, 1, 'back on Codex');
      assert.equal(host.view().scrolling, false);
    });
  });


  it("says what each agent is doing from the board: its step, and a request for permission waiting for you", async () => {
    let live: BoardLive = { board: 'roadmap-1', steps: [], approvals: [], presence: [] };
    const listeners = new Set<() => void>();
    const feed: LiveFeed = { now: () => live, onChange: (l) => (listeners.add(l), () => listeners.delete(l)), reconnect: () => {}, stop: () => {} };
    const tell = (next: Partial<BoardLive>) => {
      live = { ...live, ...next };
      for (const l of listeners) l();
    };
    await hosted(
      [CLAUDE, CODEX],
      async ({ strip, shows }) => {
        assert.ok(await shows('Claude (stand-in)'));
        tell({ steps: [{ agent: 'Codex', text: 'Running npm test', at: new Date().toISOString(), running: true }] });
        assert.ok(await waitFor(async () => /○ 2 Codex · Running npm test/.test(await strip())), await strip());
        tell({ approvals: [{ id: 'a1', agent: 'Claude', harness: 'claude', tool: 'Bash', input: { command: 'npm test' }, at: new Date().toISOString() }] });
        assert.ok(await waitFor(async () => /● 1 Claude · waiting for your OK/.test(await strip())), await strip());
        tell({ approvals: [] });
        assert.ok(await waitFor(async () => !/waiting for your OK/.test(await strip())));
      },
      { live: feed, cols: 140 },
    );
  });
});

// T191: the keyboard protocols that tell Shift+Enter from Enter. The test
// terminal plays one that speaks the kitty keyboard protocol (Ghostty,
// iTerm2, kitty, WezTerm), or one that doesn't (Apple's Terminal); Claude's
// stand-in asks for it as Claude Code does, and shows what it gets.
describe('the keyboard protocols, for the agent showing', { timeout: 60_000, skip: WINDOWS && 'needs pseudo-terminals, which Windows has none of for Tricot' }, () => {
  const CLAUDE_KITTY = agent('Claude', claudeLike, '--keys=kitty');
  const flags = async (fake: FakeTerminal) => {
    await fake.observer.settled();
    const modes = fake.observer.screen.inputModes;
    return `${modes.keyboard},${modes.otherKeys}`;
  };

  it("sets the terminal to the flags of the agent showing, answers each agent from its own, and pops Tricot's on the way out", async () => {
    const fake = fakeTerminal(100, 30, COLOURS, { kitty: true });
    const host = tracked(startHost({ agents: [CLAUDE_KITTY, CODEX], terminal: fake.terminal, key: KEY, closeMs: 1_500 }));
    try {
      await host.started;
      const shows = (text: string) => waitFor(async () => (await fake.observer.settled(), fake.observer.text().includes(text)));
      assert.ok(await shows('keys: kitty 5, answered ?5u'), fake.observer.text());
      assert.ok(await waitFor(async () => (await flags(fake)) === '5,2'), "Claude's flags, and modifyOtherKeys, on the terminal");
      assert.ok(await waitFor(() => host.view().agents[1].screen.lines().join('\n').includes('probes: kitty=yes')), "Codex's question answered too, while hidden");

      fake.type(keyAs(5, 'ctrl+\\'));
      assert.ok(await shows('>_ Codex (stand-in)'), 'Ctrl+\\ as CSI 92;5u switches');
      assert.equal(await flags(fake), '0,0', "Codex's: it asked for none");
      await sleep(1_100);
      fake.type('\x1c1'); // the terminal is plain again, so Ctrl+\ comes as itself
      assert.ok(await waitFor(async () => host.view().visible === 0 && (await flags(fake)) === '5,2'), 'back on Claude, its flags back');

      fake.type(`${keyAs(5, 'ctrl+\\')}q`);
      assert.equal((await host.done).quit, true);
    } finally {
      host.quit();
      await host.done;
    }
    await fake.observer.settled();
    const written = fake.observer.written();
    assert.equal(written.split('\x1b[>0u').length - 1, 1, 'Tricot pushed once, as it began');
    assert.match(written, /\x1b\[<u\x1b\[0 q\x1b\[\?25h\x1b\[\?7h\x1b\[\?1049l$/, 'and popped as it left, before going back to the main screen');
    const keys = fake.observer.screen.keyboard;
    assert.deepEqual([keys.flags(true), keys.depth(true), keys.flags(false), keys.otherKeys], [0, 0, 0, 0], 'the terminal as it was');
  });

  it('brings Shift+Enter to the agent as CSI 13;2u, a new line, and never switches on a repeat or a release', async () => {
    await hosted(
      [CLAUDE_KITTY, CODEX],
      async ({ host, fake, shows }) => {
        assert.ok(await waitFor(async () => (await flags(fake)) === '5,2'));
        fake.type('first');
        fake.type(keyAs(5, 'shift+enter'));
        assert.ok(await shows('last key: Shift+Enter: a new line "\\u001b[13;2u"'), fake.observer.text());
        fake.type('second');
        assert.ok(await shows('> first↵second'));
        fake.type(keyAs(5, 'enter'));
        assert.ok(await shows('you said: first↵second'), 'Enter still sends');

        fake.type('\x1b[92;5:2u\x1b[92;5:3u'); // Ctrl+\ held down from before, then let go
        await sleep(300);
        assert.equal(host.view().visible, 0, 'no switch');
        assert.ok(await shows('last key: Enter'), 'and Claude got neither');
        fake.type(keyAs(7, 'ctrl+\\')); // pressed and let go, with releases reported
        fake.type(keyAs(7, '2'));
        assert.ok(await waitFor(() => host.view().visible === 1), 'the release leaves the digit to pick');
        await sleep(300);
        assert.doesNotMatch(host.view().agents[1].screen.lines().join('\n'), /key 1b 5b 39 32/, 'Codex never got the release');
      },
      { kitty: true },
    );
  });

  it('keeps the terminal plain in the Tricot tab, whose keys come in either form', async () => {
    let opened = 0;
    const fake = fakeTerminal(130, 30, COLOURS, { kitty: true });
    const host = tracked(startHost({ agents: [CLAUDE_KITTY], terminal: fake.terminal, key: KEY, closeMs: 1_500, tricot: { url: 'http://127.0.0.1:9', open: () => void opened++ } }));
    try {
      await host.started;
      assert.equal(host.view().visible, TRICOT_TAB);
      assert.ok(await waitFor(() => host.view().agents[0].screen.lines().join('\n').includes('answered ?5u')), 'Claude asked, hidden');
      assert.equal(await flags(fake), '0,0', 'the tab asks for nothing');
      fake.type('\x1c1');
      assert.ok(await waitFor(async () => (await flags(fake)) === '5,2'), "Claude's, as it shows");
      fake.type(`${keyAs(5, 'ctrl+\\')}0`);
      assert.ok(await waitFor(async () => host.view().visible === TRICOT_TAB && (await flags(fake)) === '0,0'), 'plain again in the tab');
      fake.type('\x1b[111u\x1b[111;1:3u'); // o, as a terminal still set for Claude would send it
      assert.ok(await waitFor(() => opened === 1), 'o opens the board');
      fake.type('\x1b[113u'); // q
      assert.equal((await host.done).quit, true);
    } finally {
      host.quit();
      await host.done;
    }
  });

  it("writes nothing of the kitty keyboard where the terminal doesn't speak it, and Ctrl+J and Option+Enter reach the agent as before", async () => {
    // As Claude Code in a terminal it doesn't know: it asks, and asks for nothing when unanswered.
    await hosted([agent('Claude', claudeLike, '--keys=ask'), CODEX], async ({ fake, shows }) => {
      assert.ok(await shows('keys: plain, no answer'), fake.observer.text());
      fake.type('a');
      fake.type('\n');
      assert.ok(await shows('last key: Ctrl+J: a new line "\\n"'));
      fake.type('b');
      fake.type('\x1b\r');
      assert.ok(await shows('last key: Option+Enter: a new line "\\u001b\\r"'));
      assert.ok(await shows('> a↵b↵'));
      const written = fake.observer.written();
      assert.equal(written.split('\x1b[?u').length - 1, 1, 'Tricot asked once');
      assert.doesNotMatch(written, /\x1b\[[<=>]\d*(;\d+)?u|\x1b\[>4/, 'and wrote nothing of either protocol');
    });
  });
});
