import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Approval, ApprovalReply } from '../src/core/approvals';
import type { AdmissionView } from '../src/core/seats';
import type { BoardEvent } from '../src/core/types';
import type { Answers, AnswerOutcome } from '../src/cli/switcher/answers';
import { columns, type BoardLive } from '../src/cli/switcher/strip';
import { TabKeyReader } from '../src/cli/switcher/tabKeys';
import { asSent, renderTab, type TabView } from '../src/cli/switcher/tabView';
import { TricotTab, waitingFrom, type AddChoice, type TabAgent, type TabHost } from '../src/cli/switcher/tricotTab';

// The Tricot tab (T192): what it draws at each size, from what the board's
// stream says, and what its keys do: answering a request for permission
// (allow, for the session, deny with a reason, the arrows between several,
// the race with the board), opening the board, adding and stopping agents,
// quitting. The host's part is a stand-in here; switcherTabHost.test.ts runs
// the real host with stand-in agents.

const NOW = Date.parse('2026-11-04T15:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const approval = (more: Partial<Approval> = {}): Approval => ({
  id: 'a1',
  agent: 'Claude',
  harness: 'claude',
  tool: 'Bash',
  input: { command: 'rm -rf dist && npm run build', description: 'Rebuild the web bundle after the CSS change' },
  description: 'Rebuild the web bundle after the CSS change',
  cwd: '/Users/wassim/dev/tricot',
  forSession: ['Bash(npm run build:*)'],
  at: ago(5_000),
  ...more,
});
const event = (seq: number, name: string, summary: string, msAgo: number): BoardEvent => ({ seq, at: ago(msAgo), actor: { kind: name === 'Codex' ? 'agent' : 'human', name }, type: 'task_updated', summary });
const ACTIVITY = [event(12, 'Wassim', 'approved T183 and asked for a commit', 120_000), event(11, 'Codex', 'commented on T190', 300_000)];

// The screen has this row, exactly (its blank end aside); else it says what it has.
const shows = (screen: string[], row: string) => assert.ok(screen.some((l) => l.trimEnd() === row), `no row ${JSON.stringify(row)} in:\n${screen.join('\n')}`);

const mockView = (more: Partial<TabView> = {}): TabView => ({
  title: 'Tricot roadmap',
  url: 'http://127.0.0.1:4545',
  connected: true,
  agents: [
    { number: 1, name: 'Claude', doing: { words: 'Running npm test', tone: 'normal', lasted: '1 min 12 s' } },
    { number: 2, name: 'Codex', doing: { words: 'listening on the board', tone: 'normal' } },
  ],
  approvals: [approval()],
  selected: 0,
  activity: ACTIVITY,
  prompt: { kind: 'keys' },
  now: NOW,
  ...more,
});

describe('the Tricot tab, drawn', () => {
  it("matches the mock at 80×24: the board, the agents, what's waiting with its keys, the activity, the keys", () => {
    const { plain, rows } = renderTab(mockView(), 80, 23);
    assert.equal(rows.length, 23, 'every row above the strip');
    const text = plain.map((l) => l.trimEnd());
    assert.deepEqual(text.slice(0, 18), [
      ' Tricot · Tricot roadmap                                  http://127.0.0.1:4545',
      '',
      ' Your agents',
      '   1 Claude   Running npm test                                       1 min 12 s',
      '   2 Codex    Listening on the board',
      '',
      ' Waiting for your OK',
      '   Claude wants to run a command in tricot:',
      '     rm -rf dist && npm run build',
      '     “Rebuild the web bundle after the CSS change”',
      '   [y] allow   [s] allow for this session   [n] deny',
      '',
      ' Lately on the board',
      '   Wassim approved T183 and asked for a commit                        2 min ago',
      '   Codex commented on T190                                            5 min ago',
      '',
      '',
      '',
    ]);
    assert.equal(text.at(-1), ' o open the board · a add an agent · x stop one · q quit', 'the keys on the last row');
    assert.ok(plain.every((line) => columns(line) <= 80), 'nothing wider than the window');
  });

  it('fits a small window: the keys stay, then the request and its keys, then the agents', () => {
    const many = Array.from({ length: 20 }, (_, i) => `step ${i + 1}`).join('\n');
    const view = mockView({ approvals: [approval({ input: { command: many } })] });
    const small = renderTab(view, 60, 15).plain.map((l) => l.trimEnd());
    assert.equal(small.length, 15);
    assert.equal(small.at(-1), ' o open the board · a add an agent · x stop one · q quit');
    assert.ok(small.includes('   [y] allow   [s] allow for this session   [n] deny'), small.join('\n'));
    shows(small, '     step 1');
    assert.ok(small.some((l) => /^ {5}… \d+ more lines$/.test(l)), 'says how many lines it left out');
    shows(small, '   2 Codex    Listening on the board');
    assert.ok(!small.some((l) => l.includes('Lately on the board')), 'the activity goes first');

    // The keys to answer never show without what they answer.
    const tiny = renderTab(view, 40, 6).plain.map((l) => l.trimEnd());
    assert.deepEqual(tiny, [
      ' Tricot · Tricot roadmap',
      ' Waiting for your OK',
      '   Claude wants to run a command in tri…',
      '     step 1  … 19 more lines',
      '   [y] allow   [s] allow for this sessi…',
      ' o open the board · a add an agent · x …',
    ]);

    const big = renderTab(view, 120, 40).plain.map((l) => l.trimEnd());
    assert.ok(big.includes('     step 20'), 'all of it where there is room');
    assert.ok(big.some((l) => /^ {3}Codex commented on T190 {20,}5 min ago$/.test(l) && l.length === 119), big.join('\n'));
  });

  it('shows what the agent sent exactly, as plain text: control characters as their pictures', () => {
    assert.equal(asSent('echo \x1b[31mred\x07\tdone\x7f'), 'echo ␛[31mred␇  done␡');
    assert.equal(asSent('a‮b'), 'a�b');
    const { rows, plain } = renderTab(mockView({ approvals: [approval({ input: { command: 'printf "\x1b]0;pwned\x07"' } })] }), 80, 23);
    shows(plain, '     printf "␛]0;pwned␇"');
    assert.ok(!rows.join('').includes('\x1b]0;'), 'nothing it sent reaches the terminal as a sequence');
  });

  it('says when nothing waits, when the board is away, and an agent with no step', () => {
    const plain = renderTab(mockView({ approvals: [], connected: false, activity: [] }), 80, 23).plain.map((l) => l.trimEnd());
    assert.match(plain[0], /^ Tricot · Tricot roadmap +http:\/\/127\.0\.0\.1:4545 · connecting…$/);
    shows(plain, '   Nothing is waiting for you.');
    assert.ok(!plain.some((l) => l.includes('Lately')), 'as drawn');
  });

  it('with several waiting, marks the one the keys answer, lists the others, and says the arrows pick', () => {
    const second = approval({ id: 'a2', agent: 'Codex', harness: 'codex', tool: 'Bash', input: { command: 'git push origin main' }, description: undefined, forSession: undefined, cwd: '/work/app' });
    const plain = renderTab(mockView({ approvals: [approval(), second], selected: 1 }), 80, 23).plain.map((l) => l.trimEnd());
    shows(plain, ' Waiting for your OK · 2');
    assert.ok(plain.includes('   Claude wants to run a command in tricot'), 'the other, on one line');
    shows(plain, ' › Codex wants to run a command in app:');
    shows(plain, '     git push origin main');
    assert.ok(plain.includes('   [y] allow   [n] deny   ↑↓ another'), 'no "for this session" where it is not offered');
  });

  it('asks for the reason on one line, with the cursor where it goes, its end showing when it is long', () => {
    const frame = renderTab(mockView({ reason: 'Use npm run build instead' }), 80, 23);
    const plain = frame.plain.map((l) => l.trimEnd());
    const at = plain.indexOf('   Tell Claude why (optional; it reads this). Enter deny · Esc back');
    assert.ok(at > 0, plain.join('\n'));
    assert.equal(plain[at + 1], '   › Use npm run build instead');
    assert.deepEqual(frame.cursor, { x: 5 + 'Use npm run build instead'.length, y: at + 1 });
    const long = renderTab(mockView({ reason: 'x'.repeat(200) + 'END' }), 60, 23);
    assert.match(long.plain.find((l) => l.startsWith('   › '))!, /^ {3}› …x+END$/);
  });

  it('lists every agent to add, one to a row, with a few words on those that can not be started now', () => {
    const choices = [{ name: 'Claude Code' }, { name: 'Codex' }, { name: 'OpenCode', note: 'not installed' }, { name: 'Gemini CLI', note: 'connect it first' }, { name: 'Pi', note: 'connect it first' }, { name: 'OMP', note: 'connect it first' }];
    const add = renderTab(mockView({ prompt: { kind: 'add', choices } }), 100, 23);
    assert.deepEqual(add.plain.slice(-7).map((l) => l.trimEnd()), [
      ' Add which agent?   Esc cancel',
      '   1  Claude Code',
      '   2  Codex',
      '   3  OpenCode     not installed',
      '   4  Gemini CLI   connect it first',
      '   5  Pi           connect it first',
      '   6  OMP          connect it first',
    ]);
    assert.equal(add.rows.length, 23, 'the rest of the tab gives way to the list');
    assert.ok(add.rows.at(-1)!.includes('\x1b[0;2mconnect it first'), 'the note is dimmed');
    assert.deepEqual(renderTab(mockView({ prompt: { kind: 'add', choices } }), 40, 8).plain.map((l) => l.trimEnd()).slice(-3), ['   4  Gemini CLI   connect it first', '   5  Pi           connect it first', '   6  OMP          connect it first'], 'a short window keeps the last rows, the choices');
    assert.equal(renderTab(mockView({ prompt: { kind: 'add', choices: [] } }), 100, 23).plain.at(-1)!.trimEnd(), ' Every agent is running. Esc back');
  });

  // The rows above the keys that a note takes, as drawn.
  const noteRows = (text: string, cols: number, firstWord: string) => {
    const frame = renderTab(mockView({ note: { text, tone: 'alert' } }), cols, 23).plain.map((l) => l.trimEnd());
    const at = frame.findIndex((l) => l.startsWith(` ${firstWord}`));
    assert.ok(at > 0, frame.join('\n'));
    return { rows: frame.slice(at, frame.length - 1), keys: frame.at(-1) };
  };

  it('wraps a long note onto a few rows instead of cutting what matters off its end', () => {
    const text = "Connect Gemini CLI first, with: tricot connect gemini. Tricot can't start it for you yet: it adds a server only from a settings file.";
    const wide = noteRows(text, 80, 'Connect');
    assert.deepEqual(wide.rows, [" Connect Gemini CLI first, with: tricot connect gemini. Tricot can't start it", ' for you yet: it adds a server only from a settings file.']);
    assert.equal(wide.keys, ' o open the board · a add an agent · x stop one · q quit', 'the keys stay on the last row');
    const narrow = noteRows(text, 50, 'Connect');
    assert.deepEqual(narrow.rows, [' Connect Gemini CLI first, with: tricot connect', " gemini. Tricot can't start it for you yet: it", ' adds a server only from a settings file.'], 'the command is whole at 50 columns');
  });

  it('ends a note that is still too long after four rows in an ellipsis, never one that looks whole and is not', () => {
    const text = 'Update it with: npm install -g @google/gemini-cli@latest, and then run it again, and read the long and winding explanation of why this was needed, which goes on and on well past what four rows can hold at this width.';
    assert.deepEqual(noteRows(text, 50, 'Update').rows, [' Update it with: npm install -g', ' @google/gemini-cli@latest, and then run it', ' again, and read the long and winding explanation', ' of why this was needed, which goes on and on…']);
    // At 80 columns it takes three rows, and is whole.
    assert.deepEqual(noteRows(text, 80, 'Update').rows, [
      ' Update it with: npm install -g @google/gemini-cli@latest, and then run it',
      ' again, and read the long and winding explanation of why this was needed, which',
      ' goes on and on well past what four rows can hold at this width.',
    ]);
    // A word longer than a row is broken at the row's end, not lost; and what is cut says so.
    assert.deepEqual(noteRows(`See ${'x'.repeat(120)} now`, 50, 'See').rows, [' See', ` ${'x'.repeat(48)}`, ` ${'x'.repeat(48)}`, ` ${'x'.repeat(24)} now`]);
    assert.deepEqual(noteRows(`See ${'x'.repeat(300)} now`, 50, 'See').rows.map((l) => l.length), [4, 49, 49, 49]);
    assert.ok(noteRows(`See ${'x'.repeat(300)} now`, 50, 'See').rows[3].endsWith('…'));
  });

  it('asks which agent to stop, and to confirm a stop', () => {
    const stop = renderTab(mockView({ prompt: { kind: 'stop', choices: [{ number: 1, name: 'Claude' }, { number: 2, name: 'Codex' }] } }), 80, 23).plain;
    assert.equal(stop.at(-1)!.trimEnd(), ' Stop which agent?  1 Claude   2 Codex   Esc cancel');
    const sure = renderTab(mockView({ prompt: { kind: 'confirm-stop', name: 'Codex' } }), 100, 23).plain;
    assert.equal(sure.at(-1)!.trimEnd(), ' Stop Codex?  y stop · any other key keeps it');
  });
});

describe("the Tricot tab's keys", () => {
  it('reads letters, UTF-8 cut between reads, Enter, Esc, Backspace, the arrows, Ctrl+U and a paste whole', () => {
    const reader = new TabKeyReader();
    const keys = (s: string | Buffer) => reader.read(typeof s === 'string' ? Buffer.from(s, 'latin1') : s);
    assert.deepEqual(keys('y'), [{ kind: 'text', text: 'y' }]);
    assert.deepEqual(keys('\r\x1b\x7f\x15\x03'), [{ kind: 'enter' }, { kind: 'escape' }, { kind: 'backspace' }, { kind: 'clear' }, { kind: 'interrupt' }]);
    assert.deepEqual(keys('\x1b[A\x1bOB'), [{ kind: 'up' }, { kind: 'down' }]);
    assert.deepEqual(keys('\x1b[1;5C'), [{ kind: 'other' }], 'a key it has no use for');
    const e = Buffer.from('é', 'utf8');
    assert.deepEqual(keys(e.subarray(0, 1)), []);
    assert.deepEqual(keys(e.subarray(1)), [{ kind: 'text', text: 'é' }]);
    assert.deepEqual(keys('\x1b[200~two\r\nlines'), []);
    assert.deepEqual(keys('\x1b[201~n'), [{ kind: 'paste', text: 'two\r\nlines' }, { kind: 'text', text: 'n' }]);
  });

  // T191: typed as the terminal is being set back from an agent's keyboard
  // protocol, a key may come in its form; releases are no key at all.
  it('reads the same keys in the kitty keyboard protocol’s form (and modifyOtherKeys’), and lets releases and modifiers go', () => {
    const reader = new TabKeyReader();
    const keys = (s: string) => reader.read(Buffer.from(s, 'latin1'));
    const letters = ['y', 's', 'n', 'o', 'a', 'x', 'q'].map((ch) => `\x1b[${ch.charCodeAt(0)}u\x1b[${ch.charCodeAt(0)};1:3u`).join('');
    assert.deepEqual(keys(letters), [{ kind: 'text', text: 'ysnoaxq' }], 'each pressed and let go, with every key as CSI u');
    assert.deepEqual(keys('\x1b[13u\x1b[13;2u\x1b[27u\x1b[127u\x1b[127;1:3u'), [{ kind: 'enter' }, { kind: 'enter' }, { kind: 'escape' }, { kind: 'backspace' }]);
    assert.deepEqual(keys('\x1b[1;1:2A\x1b[1;1:3A\x1b[1;1:1B'), [{ kind: 'up' }, { kind: 'down' }], 'an arrow held down, let go, and another');
    assert.deepEqual(keys('\x1b[99;5u\x1b[117;5u\x1b[27;5;99~'), [{ kind: 'interrupt' }, { kind: 'clear' }, { kind: 'interrupt' }]);
    assert.deepEqual(keys('\x1b[57441;2u\x1b[121:89;2u\x1b[57441;1:3u'), [{ kind: 'text', text: 'Y' }], 'Shift alone is no key');
    assert.deepEqual(keys('y\x1b[110u!'), [{ kind: 'text', text: 'yn!' }], 'in order with what is typed plainly');
    assert.deepEqual(keys('\x1b[120;3u'), [{ kind: 'other' }], 'Alt+x: a key it has no use for');
  });

  it('answers with them as with the plain keys', async () => {
    const s = stand();
    s.tell({ approvals: [approval()] });
    s.type('\x1b[110u\x1b[110;1:3u'); // n
    assert.ok(s.tab.typing, 'typing a reason');
    s.type('\x1b[111u\x1b[107u\x1b[127u\x1b[107u'); // o k Backspace k
    s.type('\x1b[13u');
    await s.settle();
    assert.deepEqual(s.answered, [{ id: 'a1', reply: { behavior: 'deny', reason: 'ok' } }]);
    s.tell({ approvals: [approval({ id: 'a2' })] });
    s.type('\x1b[121u');
    await s.settle();
    assert.deepEqual(s.answered[1], { id: 'a2', reply: { behavior: 'allow' } });
  });
});

// ---- the controller, with a stand-in host and board -----------------------------------

interface Stand {
  tab: TricotTab;
  agents: TabAgent[];
  live: BoardLive;
  tell(more: Partial<BoardLive>): void;
  type(text: string): void;
  screen(): string[];
  answered: { id: string; reply: ApprovalReply }[];
  opened: number;
  quits: number;
  added: string[];
  stopped: number[];
  outcome: AnswerOutcome;
  // Seats (T187): admissions answered here, this terminal asking to be let in, and how that ends.
  admitted: { id: string; allow: boolean }[];
  seated: boolean;
  seatCode?: string;
  seatAsks: number;
  endSeat?: (end: 'admitted' | 'denied' | 'expired' | 'gone') => void;
  settle(): Promise<void>;
}

function stand(more: { answers?: boolean; choices?: AddChoice[] } = {}): Stand {
  const s = {
    agents: [
      { number: 1, name: 'Claude', state: 'running', lastOutput: NOW },
      { number: 2, name: 'Codex', state: 'running', lastOutput: NOW - 60_000 },
    ] as TabAgent[],
    live: { board: 'roadmap-1', steps: [], approvals: [], presence: [], title: 'Roadmap', activity: [] } as BoardLive,
    answered: [] as { id: string; reply: ApprovalReply }[],
    opened: 0,
    quits: 0,
    added: [] as string[],
    stopped: [] as number[],
    outcome: { ok: true } as AnswerOutcome,
    admitted: [] as { id: string; allow: boolean }[],
    seated: true,
    seatAsks: 0,
  } as Stand;
  const host: TabHost = {
    agents: () => s.agents,
    live: () => s.live,
    now: () => NOW,
    changed: () => {},
    open: () => void s.opened++,
    quit: () => void s.quits++,
    choices: () => more.choices ?? [{ id: 'opencode', name: 'OpenCode' }],
    add: (id) => void s.added.push(id),
    stop: (n) => void s.stopped.push(n),
  };
  const answers: Answers = {
    answer: async (id, reply) => {
      s.answered.push({ id, reply });
      return s.outcome;
    },
    held: async () => undefined,
    release: async () => {},
    admit: async (id, allow) => {
      s.admitted.push({ id, allow });
      return { ok: true };
    },
    askSeat: async () => {
      s.seatAsks++;
      s.seatCode = '8812';
      return { ok: true, code: '8812' };
    },
    seatEnded: () =>
      new Promise((resolve) => {
        s.endSeat = (end) => {
          s.seatCode = undefined;
          s.seated = end === 'admitted';
          resolve(end);
        };
      }),
    get seated() {
      return s.seated;
    },
    get seatCode() {
      return s.seatCode;
    },
    sign: () => ({}),
    admissions: async () => ({ ok: true, list: [] }),
    seats: async () => ({ ok: true, list: [] }),
  };
  s.tab = new TricotTab(host, { url: 'http://127.0.0.1:5113', title: 'Roadmap', ...(more.answers !== false && { answers }) });
  s.tell = (next) => (s.live = { ...s.live, ...next });
  s.type = (text) => s.tab.key(Buffer.from(text, 'utf8'));
  s.screen = () => s.tab.render(100, 30).plain.map((l) => l.trimEnd());
  s.settle = () => new Promise((resolve) => setImmediate(resolve));
  return s;
}

describe('the Tricot tab, live and answering', () => {
  it("shows each agent's step and for how long, listening, ended and stopped, from the board's stream", () => {
    const s = stand();
    s.tell({ steps: [{ agent: 'Claude', text: 'Running npm test', at: ago(72_000), running: true }], presence: [{ name: 'Codex', lastSeen: ago(1_000), state: 'listening' }], activity: ACTIVITY });
    let screen = s.screen();
    assert.ok(screen.some((l) => /^ {3}1 Claude {3}Running npm test +1 min 12 s$/.test(l)), screen.join('\n'));
    assert.ok(screen.includes('   2 Codex    Listening on the board'), screen.join('\n'));
    assert.ok(screen.some((l) => /^ {3}Wassim approved T183 and asked for a commit +2 min ago$/.test(l)), screen.join('\n'));
    s.agents[0] = { ...s.agents[0], state: 'ended', exitCode: 3 };
    s.agents[1] = { ...s.agents[1], state: 'ended', exitCode: 129, closing: true };
    screen = s.screen();
    assert.ok(screen.includes('   1 Claude   Ended (3)'), screen.join('\n'));
    assert.ok(screen.includes('   2 Codex    Stopped'), screen.join('\n'));
  });

  it('shows only its own agents’ requests, on this board or on none yet', () => {
    const live: BoardLive = {
      board: 'roadmap-1',
      steps: [],
      presence: [],
      approvals: [approval(), approval({ id: 'b', agent: 'Gemini' }), approval({ id: 'c', agent: 'codex', on: { board: 'roadmap-1', title: 'Roadmap' } }), approval({ id: 'd', on: { board: 'other-2', title: 'Other' } })],
    };
    assert.deepEqual(waitingFrom(['Claude', 'Codex'], live).map((a) => a.id), ['a1', 'c']);
  });

  it('allows with y, for the session with s where it is offered, and says what happened', async () => {
    const s = stand();
    s.tell({ approvals: [approval({ forSession: undefined })] });
    s.type('s');
    assert.deepEqual(s.answered, [], 'not offered: nothing sent');
    shows(s.screen(), ' "Allow for this session" isn\'t offered for this one: y allows it once.');
    s.type('y');
    await s.settle();
    assert.deepEqual(s.answered, [{ id: 'a1', reply: { behavior: 'allow' } }]);
    shows(s.screen(), ' Allowed: Claude goes ahead.');
    assert.ok(s.screen().includes('   Nothing is waiting for you.'), 'gone at once, before the stream says so');

    s.tell({ approvals: [approval({ id: 'a2' })] });
    s.type('s');
    await s.settle();
    assert.deepEqual(s.answered[1], { id: 'a2', reply: { behavior: 'allow', session: true } });
    shows(s.screen(), ' Allowed for this session: Claude goes ahead.');
  });

  it('denies with n, a reason typed on one line (Backspace, a paste), sent with Enter; Esc goes back', async () => {
    const s = stand();
    s.tell({ approvals: [approval()] });
    s.type('n');
    assert.ok(s.tab.typing, 'typing a reason');
    s.type('Use npm run buidl');
    s.type('\x7f\x7f\x7fild');
    s.type('\x1b[200~ instead,\nplease\x1b[201~');
    shows(s.screen(), '   › Use npm run build instead, please');
    s.type('y'); // a letter while typing is the reason's, not an answer
    assert.deepEqual(s.answered, []);
    s.type('\x7f\r');
    await s.settle();
    assert.deepEqual(s.answered, [{ id: 'a1', reply: { behavior: 'deny', reason: 'Use npm run build instead, please' } }]);
    shows(s.screen(), ' Denied: Claude reads your reason.');

    s.tell({ approvals: [approval({ id: 'a3' })] });
    s.type('n');
    s.type('nope');
    s.type('\x1b');
    assert.equal(s.tab.typing, false);
    assert.deepEqual(s.answered.length, 1, 'Esc sends nothing');
    shows(s.screen(), '   [y] allow   [s] allow for this session   [n] deny');
    s.type('n\r');
    await s.settle();
    assert.deepEqual(s.answered[1], { id: 'a3', reply: { behavior: 'deny' } }, 'no reason: none sent');
  });

  it('picks which one with the arrows, when several wait', async () => {
    const s = stand();
    s.tell({ approvals: [approval(), approval({ id: 'a2', agent: 'Codex' }), approval({ id: 'a3' })] });
    s.type('\x1b[B\x1b[B');
    assert.ok(s.screen().some((l) => l.startsWith(' › Claude')), 'as drawn');
    s.type('\x1b[A');
    s.type('y');
    await s.settle();
    assert.deepEqual(s.answered.map((a) => a.id), ['a2']);
    s.type('\x1b[A'); // round to the last
    s.type('y');
    await s.settle();
    assert.deepEqual(s.answered.map((a) => a.id), ['a2', 'a3']);
  });

  it('loses the race to the board calmly: says who answered first, and lets go of a reason being typed', async () => {
    const s = stand();
    s.tell({ approvals: [approval()] });
    s.outcome = { ok: false, gone: true, error: 'Already answered: Sam allowed it on the Tricot board.' };
    s.type('y');
    await s.settle();
    shows(s.screen(), ' Already answered: Sam allowed it on the Tricot board.');
    shows(s.screen(), '   Nothing is waiting for you.');

    s.tell({ approvals: [approval({ id: 'a2' })] });
    s.type('n');
    s.type('because');
    s.tell({ approvals: [] }); // answered on the board meanwhile
    const screen = s.screen();
    assert.equal(s.tab.typing, false);
    assert.ok(screen.includes(' It was answered meanwhile, on the board or in its own terminal.'), screen.join('\n'));

    s.tell({ approvals: [approval({ id: 'a4' })] });
    s.outcome = { ok: false, error: 'The board refused the answer (HTTP 500).' };
    s.type('y');
    await s.settle();
    shows(s.screen(), " Your answer to Claude didn't go through: The board refused the answer (HTTP 500).");
    assert.ok(s.screen().includes('   Claude wants to run a command in tricot:'), 'still waiting: try again');
  });

  it('says so when there is nothing to answer, or no board to answer with', () => {
    const s = stand({ answers: false });
    s.type('y');
    shows(s.screen(), ' Nothing is waiting for your OK.');
    s.tell({ approvals: [approval()] });
    s.type('y');
    assert.ok(s.screen().some((l) => l.startsWith(' Answering from here needs the board')), 'as drawn');
  });

  it('opens the board, adds an agent, stops one after a y, and quits', () => {
    const s = stand({
      choices: [
        { id: 'opencode', name: 'OpenCode' },
        { id: 'gemini', name: 'Gemini CLI', note: 'not installed', problem: "Gemini CLI isn't installed here." },
        { id: 'pi', name: 'Pi', note: 'connect it first', problem: "Tricot can't start Pi for you yet. Connect it once with: tricot connect pi" },
      ],
    });
    s.type('o');
    assert.equal(s.opened, 1);
    shows(s.screen(), ' Opened the board in your browser.');

    s.type('a');
    assert.deepEqual(s.screen().slice(-4).map((l) => l.trimEnd()), [' Add which agent?   Esc cancel', '   1  OpenCode', '   2  Gemini CLI  not installed', '   3  Pi          connect it first']);
    s.type('2');
    assert.deepEqual(s.added, []);
    shows(s.screen(), " Gemini CLI isn't installed here.");
    s.type('a3');
    assert.deepEqual(s.added, [], 'one that can not be started says why, and is not started');
    shows(s.screen(), " Tricot can't start Pi for you yet. Connect it once with: tricot connect pi");
    s.type('a1');
    assert.deepEqual(s.added, ['opencode']);
    s.type('a\x1b');
    assert.deepEqual(s.added, ['opencode'], 'Esc: none');

    s.type('x');
    assert.equal(s.screen().at(-1), ' Stop which agent?  1 Claude   2 Codex   Esc cancel');
    s.type('2');
    assert.match(s.screen().at(-1)!, /^ Stop Codex\? /);
    s.type('n');
    assert.deepEqual(s.stopped, [], 'anything but y keeps it');
    shows(s.screen(), ' Codex keeps running.');
    s.type('x2y');
    assert.deepEqual(s.stopped, [2]);
    shows(s.screen(), ' Stopping Codex: it is hung up, as when its window closes.');

    s.type('q');
    assert.equal(s.quits, 1);
  });
});

// Seats (T187): a browser asking to act for the person, answered here with
// y or n; and what a terminal that isn't one of the person's seats shows of
// a request (who waits, not what they ask), and asking to be let in.
describe('the Tricot tab and seats', () => {
  const asking = (more: Partial<AdmissionView> = {}): AdmissionView => ({ id: 'ad1', code: '4271', kind: 'browser', label: 'Chrome on macOS', at: ago(2_000), expiresAt: ago(-178_000), ...more });

  it('asks "A browser wants to act for you (Chrome on macOS, code 4271). Allow? [y/N]", y allowing it', async () => {
    const s = stand();
    s.tell({ admissions: [asking()], approvals: [approval()] });
    const screen = s.screen();
    shows(screen, ' A browser wants to act for you (Chrome on macOS, code 4271). Allow? [y/N]');
    shows(screen, "   Allow it only if the browser you're using shows 4271: it can then do all you do in Tricot.");
    shows(screen, '   [y] allow   [n] deny   Esc later');
    s.type('y');
    await s.settle();
    assert.deepEqual(s.admitted, [{ id: 'ad1', allow: true }]);
    assert.deepEqual(s.answered, [], 'y went to the browser asking, not to the request below it');
    shows(s.screen(), ' Chrome on macOS acts for you now.');
    assert.doesNotMatch(s.screen().join('\n'), /wants to act for you/, 'gone at once, as the stream catches up');
  });

  it('denies with n or Enter, leaves it with Esc, and says when it would be the first', async () => {
    const s = stand();
    s.tell({ admissions: [asking({ first: true })] });
    shows(s.screen(), "   It would be the first: from then on, only what you've let in can let others in.");
    s.type('\r');
    await s.settle();
    assert.deepEqual(s.admitted, [{ id: 'ad1', allow: false }]);
    shows(s.screen(), " Denied: Chrome on macOS doesn't act for you.");
    s.tell({ admissions: [asking({ id: 'ad2', code: '5310', kind: 'terminal', label: "Tricot's terminal (tricot update)" })] });
    shows(s.screen(), " A terminal wants to act for you (Tricot's terminal (tricot update), code 5310). Allow? [y/N]");
    s.type('\x1b');
    assert.doesNotMatch(s.screen().join('\n'), /wants to act for you/);
    shows(s.screen(), ' Left for now: it waits on the board until it lapses.');
    s.type('o');
    assert.equal(s.opened, 1, "the tab's own keys still work");
  });

  it("shows a request sealed until this terminal is let in, and y asks to let it in, with the code the person's browser shows", async () => {
    const s = stand();
    s.seated = false;
    s.tell({ approvals: [{ id: 'a1', agent: 'Claude', harness: 'claude', tool: '', input: null, at: ago(5_000), sealed: true }] });
    shows(s.screen(), '   Claude is waiting for your OK.');
    shows(s.screen(), "     This terminal can't see what it asks until you let it answer for you.");
    shows(s.screen(), '   [y] let this terminal answer for you');
    s.type('n');
    shows(s.screen(), ' Let this terminal answer for you first: y asks.');
    s.type('y');
    await s.settle();
    assert.equal(s.seatAsks, 1);
    assert.deepEqual(s.answered, [], 'nothing answered unseen');
    shows(s.screen(), "     Allow this terminal in Tricot's page, in a browser you've let in: it shows code 8812.");
    shows(s.screen(), '     Waiting for you there…');
    s.endSeat!('admitted');
    await s.settle();
    shows(s.screen(), ' This terminal answers for you now, until it closes.');
    // Let in, its stream comes again in full: the request with its keys.
    s.tell({ approvals: [approval()] });
    shows(s.screen(), '   [y] allow   [s] allow for this session   [n] deny');
    s.type('y');
    await s.settle();
    assert.deepEqual(s.answered, [{ id: 'a1', reply: { behavior: 'allow' } }]);
  });

  it('says so when it was denied in the browser, or nobody allowed it in time', async () => {
    const s = stand();
    s.seated = false;
    s.tell({ approvals: [{ id: 'a1', agent: 'Claude', harness: 'claude', tool: '', input: null, at: ago(5_000), sealed: true }] });
    s.type('y');
    await s.settle();
    s.endSeat!('denied');
    await s.settle();
    shows(s.screen(), " That was denied in the browser: this terminal still can't answer.");
    s.type('y');
    await s.settle();
    s.endSeat!('expired');
    await s.settle();
    shows(s.screen(), ' Nobody allowed it in time: y asks again.');
  });

  it('asks to be let in when the board says an answer needs a seat', async () => {
    const s = stand();
    s.outcome = { ok: false, needsSeat: true, error: 'Only a browser or terminal you\'ve let in can do this.' };
    s.tell({ approvals: [approval()] });
    s.type('y');
    await s.settle();
    assert.equal(s.seatAsks, 1);
  });
});
