import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Approval, ApprovalReply } from '../src/core/approvals';
import type { AdmissionView } from '../src/core/seats';
import type { BoardEvent } from '../src/core/types';
import type { Answers, AnswerOutcome } from '../src/cli/switcher/answers';
import { columns, type BoardLive } from '../src/cli/switcher/strip';
import { InputRouter } from '../src/cli/switcher/keys';
import { TabKeyReader, type TabKey } from '../src/cli/switcher/tabKeys';
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
      '   Allow    Allow for this session  ❯ Deny  (←→ Enter, or y/s/n)',
      '',
      ' Lately on the board',
      '   Wassim approved T183 and asked for a commit                        2 min ago',
      '   Codex commented on T190                                            5 min ago',
      '',
      '',
      '',
    ]);
    assert.equal(text.at(-1), ' o open the board · t threads · a add an agent · x stop one · q quit', 'the keys on the last row');
    assert.ok(plain.every((line) => columns(line) <= 80), 'nothing wider than the window');
  });

  it('fits a small window: the keys stay, then the request and its keys, then the agents', () => {
    const many = Array.from({ length: 20 }, (_, i) => `step ${i + 1}`).join('\n');
    const view = mockView({ approvals: [approval({ input: { command: many } })] });
    const small = renderTab(view, 60, 15).plain.map((l) => l.trimEnd());
    assert.equal(small.length, 15);
    assert.equal(small.at(-1), ' o open · t threads · a add · x stop · q quit', 'in fewer words, so none is cut');
    assert.ok(small.includes('   Allow    Allow for this session  ❯ Deny'), small.join('\n'));
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
      '   Allow    Session  ❯ Deny',
      ' o open · t threads · a add · x stop · q',
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
    assert.ok(plain.includes('   Allow  ❯ Deny  (←→ Enter, or y/n)   ↑↓ another'), 'no "for this session" where it is not offered');
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

  it('lists every agent to add, one to a row, one highlighted, with a few words on those that can not be started now', () => {
    const choices = [{ name: 'Claude Code' }, { name: 'Codex' }, { name: 'OpenCode', note: 'not installed' }, { name: 'Gemini CLI', note: 'connect it first' }, { name: 'Pi', note: 'connect it first' }, { name: 'OMP', note: 'connect it first' }];
    const add = renderTab(mockView({ prompt: { kind: 'add', choices, at: 1 } }), 100, 23);
    assert.deepEqual(add.plain.slice(-7).map((l) => l.trimEnd()), [
      ' Add which agent?   ↑↓ move · Enter pick · Esc cancel',
      '   1  Claude Code',
      ' ❯ 2  Codex',
      '   3  OpenCode     not installed',
      '   4  Gemini CLI   connect it first',
      '   5  Pi           connect it first',
      '   6  OMP          connect it first',
    ]);
    assert.equal(add.rows.length, 23, 'the rest of the tab gives way to the list');
    assert.ok(add.rows.at(-1)!.includes('\x1b[0;2mconnect it first'), 'the note is dimmed');
    assert.ok(add.rows.at(-5)!.includes('\x1b[0;1m ❯ \x1b[0;1m2\x1b[0;1m  Codex'), 'the highlighted row is bold');
    assert.ok(!add.rows.at(-6)!.includes('\x1b[0;1m  Claude'), 'the others are not');
    const notInstalled = renderTab(mockView({ prompt: { kind: 'add', choices, at: 2 } }), 100, 23).plain.slice(-7).map((l) => l.trimEnd());
    assert.equal(notInstalled[3], ' ❯ 3  OpenCode     not installed', 'a row that can not be started can be highlighted');
    assert.equal(renderTab(mockView({ prompt: { kind: 'add', choices: [], at: 0 } }), 100, 23).plain.at(-1)!.trimEnd(), ' Every agent is running. Esc back');
  });

  it('keeps the list in a narrow or short window: the question first, the highlighted row in view', () => {
    const choices = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((name) => ({ name }));
    const narrow = renderTab(mockView({ prompt: { kind: 'add', choices, at: 0 } }), 40, 23).plain.map((l) => l.trimEnd());
    assert.equal(narrow.at(-7), ' Add which agent?   Esc cancel', 'only Esc where the keys do not fit');
    const short = (at: number, rows: number) => renderTab(mockView({ prompt: { kind: 'add', choices, at } }), 60, rows).plain.map((l) => l.trimEnd());
    assert.deepEqual(short(0, 4), [' Add which agent?   ↑↓ move · Enter pick · Esc cancel', ' ❯ 1  One', '   2  Two', '   3  Three']);
    assert.deepEqual(short(5, 4), [' Add which agent?   ↑↓ move · Enter pick · Esc cancel', '   4  Four', '   5  Five', ' ❯ 6  Six']);
    assert.deepEqual(short(2, 4).slice(1), ['   2  Two', ' ❯ 3  Three', '   4  Four'], 'scrolled to the middle');
    assert.deepEqual(short(3, 1), [' Add which agent?   ↑↓ move · Enter pick · Esc cancel'], 'one row is the question');
  });

  it('shows a number only on the first nine rows of a long list', () => {
    const choices = Array.from({ length: 11 }, (_, i) => ({ name: `Agent ${i + 1}` }));
    const plain = renderTab(mockView({ prompt: { kind: 'add', choices, at: 10 } }), 80, 23).plain.map((l) => l.trimEnd());
    assert.deepEqual(plain.slice(-3), ['   9  Agent 9', '      Agent 10', ' ❯    Agent 11']);
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
    assert.equal(wide.keys, ' o open the board · t threads · a add an agent · x stop one · q quit', 'the keys stay on the last row');
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

  it('asks which agent to stop, one to a row and one highlighted, and to confirm a stop', () => {
    const choices = [{ number: 1, name: 'Claude' }, { number: 2, name: 'Codex' }, { number: 3, name: 'OpenCode' }];
    const stop = renderTab(mockView({ prompt: { kind: 'stop', choices, at: 0 } }), 80, 23).plain;
    assert.deepEqual(stop.slice(-4).map((l) => l.trimEnd()), [' Stop which agent?  ↑↓ move · Enter pick · Esc cancel', ' ❯ 1  Claude', '   2  Codex', '   3  OpenCode']);
    const second = renderTab(mockView({ prompt: { kind: 'stop', choices, at: 1 } }), 80, 23).plain;
    assert.deepEqual(second.slice(-3).map((l) => l.trimEnd()), ['   1  Claude', ' ❯ 2  Codex', '   3  OpenCode']);
    const tall = renderTab(mockView({ prompt: { kind: 'stop', choices, at: 2 } }), 80, 3).plain.map((l) => l.trimEnd());
    assert.deepEqual(tall, [' Stop which agent?  ↑↓ move · Enter pick · Esc cancel', '   2  Codex', ' ❯ 3  OpenCode'], 'a short window keeps the question and the highlighted row');
    assert.equal(renderTab(mockView({ prompt: { kind: 'stop', choices: [], at: 0 } }), 80, 23).plain.at(-1)!.trimEnd(), ' No agent is running. Esc back');
  });

  it("draws a request's answers as a row of choices, Deny highlighted to begin with, the session one only where it is offered", () => {
    const row = (view: Partial<TabView>, cols = 80) => renderTab(mockView(view), cols, 23).plain.map((l) => l.trimEnd()).find((l) => /Allow {2}/.test(l) && !/Waiting/.test(l));
    assert.equal(row({}), '   Allow    Allow for this session  ❯ Deny  (←→ Enter, or y/s/n)');
    assert.equal(row({ choice: 'allow' }), ' ❯ Allow    Allow for this session    Deny  (←→ Enter, or y/s/n)');
    assert.equal(row({ choice: 'session' }), '   Allow  ❯ Allow for this session    Deny  (←→ Enter, or y/s/n)');
    assert.equal(row({ approvals: [approval({ forSession: undefined })], choice: 'allow' }), ' ❯ Allow    Deny  (←→ Enter, or y/n)');
    assert.equal(row({ approvals: [approval({ forSession: undefined })], choice: 'session' }), '   Allow  ❯ Deny  (←→ Enter, or y/n)', 'a choice the request does not offer is Deny');

    // Where the row doesn't fit it gives up its hint, then the longer words, never a choice.
    assert.equal(row({}, 50), '   Allow    Allow for this session  ❯ Deny');
    assert.equal(row({}, 30), '   Allow    Session  ❯ Deny');

    // The highlighted choice is bold and the hint dim: no colour, so no theme's.
    const { rows } = renderTab(mockView({ choice: 'allow' }), 80, 23);
    const painted = rows.find((l) => l.includes('Allow for this session'))!;
    assert.match(painted, /\x1b\[0;1m❯ Allow/);
    assert.match(painted, /\x1b\[0;2m\(←→ Enter, or y\/s\/n\)/);
    assert.doesNotMatch(painted.replace(/\x1b\[0;[12]m|\x1b\[0m|\x1b\[K/g, ''), /\x1b/);
  });

  it('keeps every label where it is as the highlight moves: each choice has a two-column slot for the ❯', () => {
    const at = (rows: string[], label: string) => rows.map((l) => l.indexOf(label));
    const answers = (['allow', 'session', 'deny'] as const).map((choice) => renderTab(mockView({ choice }), 80, 23).plain.find((l) => l.includes('Allow for this session'))!);
    for (const label of ['Allow ', 'Allow for this session', 'Deny']) assert.equal(new Set(at(answers, label)).size, 1, `${label} stays put`);
    const stops = [false, true].map((yes) => renderTab(mockView({ prompt: { kind: 'confirm-stop', name: 'Codex', yes } }), 100, 23).plain.at(-1)!);
    for (const label of ['Yes', 'No']) assert.equal(new Set(at(stops, label)).size, 1, `${label} stays put`);
    const asking: AdmissionView = { id: 'ad1', code: '4271', kind: 'browser', label: 'Chrome on macOS', at: ago(2_000), expiresAt: ago(-178_000) };
    const pairs = [false, true].map((allow) => renderTab(mockView({ admission: { ...asking, allow } }), 100, 23).plain.find((l) => l.includes('Yes'))!);
    for (const label of ['Yes', 'No']) assert.equal(new Set(at(pairs, label)).size, 1, `${label} stays put`);
  });

  it('draws the arrows for another request after the choices, and drops the hint first', () => {
    const second = approval({ id: 'a2', forSession: undefined });
    const plain = (cols: number) => renderTab(mockView({ approvals: [approval(), second], selected: 0 }), cols, 23).plain.map((l) => l.trimEnd());
    assert.ok(plain(80).includes('   Allow    Allow for this session  ❯ Deny  (←→ Enter, or y/s/n)   ↑↓ another'));
    assert.ok(plain(70).includes('   Allow    Allow for this session  ❯ Deny   ↑↓ another'), plain(70).join('\n'));
  });

  it('keeps the row a request that is sealed has: no choices, the one key that asks to be let in', () => {
    const sealed: Approval = { id: 'a1', agent: 'Claude', harness: 'claude', tool: '', input: null, at: ago(5_000), sealed: true };
    const plain = renderTab(mockView({ approvals: [sealed], choice: 'allow' }), 80, 23).plain.map((l) => l.trimEnd());
    shows(plain, '   [y] let this terminal answer for you');
    assert.ok(!plain.some((l) => l.includes('Deny')), plain.join('\n'));
  });

  it('asks to stop with Yes and No, the highlighted one with ❯ and bold, the hint dim', () => {
    const last = (yes: boolean, cols = 100) => renderTab(mockView({ prompt: { kind: 'confirm-stop', name: 'Codex', yes } }), cols, 23).plain.map((l) => l.trimEnd()).slice(-2);
    assert.equal(last(false)[1], ' Stop Codex?    Yes  ❯ No  (←→ Enter, or y/n)');
    assert.equal(last(true)[1], ' Stop Codex?  ❯ Yes    No  (←→ Enter, or y/n)');
    assert.equal(last(false, 30)[1], ' Stop Codex?    Yes  ❯ No', 'the hint goes first');
    assert.deepEqual(last(false, 20), [' Stop Codex?', '   Yes  ❯ No'], 'then the pair goes under the question');
    const painted = renderTab(mockView({ prompt: { kind: 'confirm-stop', name: 'Codex', yes: true } }), 100, 23).rows.at(-1)!;
    assert.match(painted, /\x1b\[0;1m❯ Yes/);
    assert.match(painted, /\x1b\[0;2m\(←→ Enter, or y\/n\)/);
  });

  it('asks whether to let a browser act for the person with Yes and No, the question never cut, at any width', () => {
    const asking = (more: Partial<AdmissionView> = {}): AdmissionView => ({ id: 'ad1', code: '4271', kind: 'browser', label: 'Chrome on macOS', at: ago(2_000), expiresAt: ago(-178_000), ...more });
    const wide = renderTab(mockView({ admission: asking() }), 100, 23).plain.map((l) => l.trimEnd());
    assert.deepEqual(wide.slice(2, 5), [
      ' A browser wants to act for you (Chrome on macOS, code 4271). Allow?',
      "   Allow it only if the browser you're using shows 4271: it can then do all you do in Tricot.",
      '   Yes  ❯ No  (←→ Enter, or y/n · Esc later)',
    ]);
    const yes = renderTab(mockView({ admission: { ...asking(), allow: true } }), 100, 23).plain;
    shows(yes, ' ❯ Yes    No  (←→ Enter, or y/n · Esc later)');

    // In a narrow window the question takes the rows it needs, the code whole, and the pair is on the row below.
    const narrow = renderTab(mockView({ admission: asking() }), 40, 23).plain.map((l) => l.trimEnd());
    assert.deepEqual(narrow.slice(2, 5), [' A browser wants to act for you (Chrome', ' on macOS, code 4271). Allow?', "   Allow it only if the browser you're …"]);
    assert.ok(narrow.includes('   Yes  ❯ No  (Esc later)'), narrow.join('\n'));
    assert.ok(narrow.every((l) => columns(l) <= 40));
    const words = narrow.slice(2, 4).join(' ').replace(/\s+/g, ' ');
    assert.ok(words.includes('(Chrome on macOS, code 4271). Allow?'), 'the code and the question, whole');

    // A long label wraps over more rows: still whole, still before the pair.
    const label = "Tricot's terminal (tricot update --channel next --yes)";
    const long = renderTab(mockView({ admission: asking({ kind: 'terminal', label, code: '5310' }) }), 40, 30).plain.map((l) => l.trimEnd());
    const pair = long.findIndex((l) => l.startsWith('   Yes  ❯ No'));
    const asked = long.slice(2, long.findIndex((l) => l.startsWith('   Allow it only'))).join(' ').replace(/\s+/g, ' ').trim();
    assert.equal(asked, `A terminal wants to act for you (${label}, code 5310). Allow?`);
    assert.ok(pair > 0);
    assert.equal(renderTab(mockView({ admission: { ...asking(), sending: true } }), 100, 23).plain.some((l) => l.includes('Yes')), false, 'answering: the pair gives way');
  });
});

describe("the Tricot tab's keys", () => {
  it('reads letters, UTF-8 cut between reads, Enter, Esc, Backspace, the arrows, Home and End, Page Up and Page Down, Ctrl+U, Ctrl+L and a paste whole', () => {
    const reader = new TabKeyReader();
    const keys = (s: string | Buffer) => reader.read(typeof s === 'string' ? Buffer.from(s, 'latin1') : s);
    assert.deepEqual(keys('y'), [{ kind: 'text', text: 'y' }]);
    assert.deepEqual(keys('\r\x1b\x15\x7f\x0c\x03'), [{ kind: 'enter' }, { kind: 'escape' }, { kind: 'clear' }, { kind: 'backspace' }, { kind: 'lens' }, { kind: 'interrupt' }]);
    assert.deepEqual(keys('\x1b\r\n'), [{ kind: 'newline' }, { kind: 'newline' }], 'Option+Enter and Ctrl+J: a new line (T37)');
    assert.deepEqual(keys('\x1bb\x1bf\x1b\x7f\x17\x01\x05'), [{ kind: 'wordleft' }, { kind: 'wordright' }, { kind: 'deleteword' }, { kind: 'deleteword' }, { kind: 'home' }, { kind: 'end' }], 'Option+← → and Option+Backspace as macOS terminals send them, Ctrl+W, Ctrl+A and Ctrl+E');
    assert.deepEqual(keys('\x1b[A\x1bOB'), [{ kind: 'up' }, { kind: 'down' }]);
    assert.deepEqual(keys('\x1b[C\x1bOC\x1b[D\x1bOD'), [{ kind: 'right' }, { kind: 'right' }, { kind: 'left' }, { kind: 'left' }]);
    assert.deepEqual(keys('\x1b[H\x1bOH\x1b[1~\x1b[7~'), [{ kind: 'home' }, { kind: 'home' }, { kind: 'home' }, { kind: 'home' }]);
    assert.deepEqual(keys('\x1b[F\x1bOF\x1b[4~\x1b[8~'), [{ kind: 'end' }, { kind: 'end' }, { kind: 'end' }, { kind: 'end' }]);
    assert.deepEqual(keys('\x1b[15~\x1b[5~\x1b[6~'), [{ kind: 'other' }, { kind: 'pageup' }, { kind: 'pagedown' }], 'F5 is not Page Up');
    assert.deepEqual(keys('\x1b[5;1:2~\x1b[5;1:3~\x1b[6;1:1~'), [{ kind: 'pageup' }, { kind: 'pagedown' }], 'Page Up and Page Down in the kitty protocol’s form');
    assert.deepEqual(keys('\x1b[1;5H'), [{ kind: 'other' }], 'Ctrl+Home: a key it has no use for');
    assert.deepEqual(keys('\x1b[1;5C\x1b[1;5D\x1b[1;3C\x1b[1;3D'), [{ kind: 'wordright' }, { kind: 'wordleft' }, { kind: 'wordright' }, { kind: 'wordleft' }], 'Ctrl or Alt with an arrow: a word at a time');
    assert.deepEqual(keys('\x1b[1;2C'), [{ kind: 'other' }], 'a key it has no use for');
    const e = Buffer.from('é', 'utf8');
    assert.deepEqual(keys(e.subarray(0, 1)), []);
    assert.deepEqual(keys(e.subarray(1)), [{ kind: 'text', text: 'é' }]);
    assert.deepEqual(keys('\x1b[200~two\r\nlines'), []);
    assert.deepEqual(keys('\x1b[201~n'), [{ kind: 'paste', text: 'two\r\nlines' }, { kind: 'text', text: 'n' }]);
  });

  // T24: the router hands the tab a key split between two reads whole, an
  // arrow whose Esc came in a read of its own included.
  it('reads ↓ as ↓ when its Esc and the rest come in two reads, and Esc alone as Esc once the router has waited', async () => {
    const reader = new TabKeyReader();
    const keys: TabKey[] = [];
    const router = new InputRouter({ key: 0x1c, tricotTab: true, stripRow: () => 40, scrolling: () => false, emit: (a) => a.kind === 'send' && keys.push(...reader.read(a.data)), holdMs: 20 });
    router.feed('\x1b[B');
    router.feed('\x1b');
    router.feed('[B');
    assert.deepEqual(keys, [{ kind: 'down' }, { kind: 'down' }]);
    router.feed('\x1b');
    assert.equal(keys.length, 2, 'held');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(keys.slice(2), [{ kind: 'escape' }]);
    router.dispose();
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
    assert.deepEqual(keys('\x1b[1;1:2C\x1b[1;1:3C\x1b[1;1:1D\x1b[1;1:2D\x1b[1;1:3D'), [{ kind: 'right' }, { kind: 'left' }, { kind: 'left' }], 'an arrow held down, let go, and another');
    assert.deepEqual(keys('\x1b[1;2C\x1b[1;3D'), [{ kind: 'other' }, { kind: 'wordleft' }], 'with Shift, a key it has no use for; with Alt, a word left');
    assert.deepEqual(keys('\x1b[127;3u\x1b[13;3u'), [{ kind: 'deleteword' }, { kind: 'newline' }], 'Alt+Backspace and Alt+Enter');
    assert.deepEqual(keys('y\x1b[Dn'), [{ kind: 'text', text: 'y' }, { kind: 'left' }, { kind: 'text', text: 'n' }], 'in order with what is typed');
    assert.deepEqual(keys('\x1b[1;1:1H\x1b[1;1:2F\x1b[1;1:3H\x1b[1;1:1~\x1b[4;1:2~\x1b[4;1:3~'), [{ kind: 'home' }, { kind: 'end' }, { kind: 'home' }, { kind: 'end' }], 'Home and End, pressed, held down and let go');
    assert.deepEqual(keys('\x1b[99;5u\x1b[117;5u\x1b[108;5u\x1b[27;5;99~'), [{ kind: 'interrupt' }, { kind: 'clear' }, { kind: 'lens' }, { kind: 'interrupt' }]);
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
  pages: string[];
  links: string[];
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

function stand(more: { answers?: boolean; choices?: AddChoice[]; add?: (id: string) => Promise<string | undefined> } = {}): Stand {
  const s = {
    agents: [
      { number: 1, name: 'Claude', state: 'running', lastOutput: NOW },
      { number: 2, name: 'Codex', state: 'running', lastOutput: NOW - 60_000 },
    ] as TabAgent[],
    live: { board: 'roadmap-1', steps: [], approvals: [], presence: [], title: 'Roadmap', activity: [] } as BoardLive,
    answered: [] as { id: string; reply: ApprovalReply }[],
    opened: 0,
    pages: [] as string[],
    links: [] as string[],
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
    open: (page) => void (page ? s.pages.push(page) : s.opened++),
    openLink: (url) => void s.links.push(url),
    quit: () => void s.quits++,
    choices: () => more.choices ?? [{ id: 'opencode', name: 'OpenCode' }],
    add: (id) => {
      s.added.push(id);
      return more.add?.(id);
    },
    stop: (n) => void s.stopped.push(n),
  };
  const answers: Answers = {
    act: async () => ({ ok: false, error: 'Not used here.' }),
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

describe('a link clicked in the Tricot tab (T36)', () => {
  it('opens the board for its own address, a card for its page, and any other address as it is', () => {
    const s = stand();
    s.tab.link('http://127.0.0.1:5113');
    s.tab.link('#/b/roadmap-1/t/abc');
    s.tab.link('https://example.com/x');
    assert.deepEqual([s.opened, s.pages, s.links], [1, ['#/b/roadmap-1/t/abc'], ['https://example.com/x']]);
  });
});

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
    shows(s.screen(), '   Allow    Allow for this session  ❯ Deny  (←→ Enter, or y/s/n)');
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

  // T22: an agent added reads what it starts on from the board first, so
  // whether it started is known a moment later.
  it('says why an agent it adds did not start, once that is known', async () => {
    let settle: (problem: string | undefined) => void = () => {};
    const s = stand({ add: () => new Promise((resolve) => (settle = resolve)) });
    s.type('a1');
    assert.deepEqual(s.added, ['opencode']);
    assert.ok(!s.screen().some((l) => l.includes("didn't start")), 'nothing to say yet');
    settle("OpenCode didn't start: Tricot can't start OpenCode here.");
    await s.settle();
    shows(s.screen(), " OpenCode didn't start: Tricot can't start OpenCode here.");
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
    assert.deepEqual(s.screen().slice(-4).map((l) => l.trimEnd()), [' Add which agent?   ↑↓ move · Enter pick · Esc cancel', ' ❯ 1  OpenCode', '   2  Gemini CLI  not installed', '   3  Pi          connect it first']);
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
    assert.deepEqual(s.screen().slice(-3), [' Stop which agent?  ↑↓ move · Enter pick · Esc cancel', ' ❯ 1  Claude', '   2  Codex']);
    s.type('2');
    assert.match(s.screen().at(-1)!, /^ Stop Codex\? /);
    s.type('n');
    assert.deepEqual(s.stopped, [], 'anything but y keeps it');
    shows(s.screen(), ' Codex keeps running.');
    s.type('x2y');
    assert.deepEqual(s.stopped, [2]);
    shows(s.screen(), ' Stopped Codex.');

    s.type('q');
    assert.equal(s.quits, 1);
  });

  const three: AddChoice[] = [
    { id: 'opencode', name: 'OpenCode' },
    { id: 'gemini', name: 'Gemini CLI', note: 'not installed', problem: "Gemini CLI isn't installed here." },
    { id: 'pi', name: 'Pi' },
  ];
  // The row marked ❯ in the list drawn, or its text.
  const marked = (s: Stand) => {
    const rows = s.screen().filter((l) => l.startsWith(' ❯ '));
    assert.equal(rows.length, 1, 'one row is highlighted');
    return rows[0].slice(3).replace(/\s+/g, ' ').trim();
  };

  it('moves the highlight in the add list with the arrows and j k, wrapping both ways, and Home and End', () => {
    const s = stand({ choices: three });
    s.type('a');
    assert.equal(marked(s), '1 OpenCode');
    s.type('\x1b[B');
    assert.equal(marked(s), '2 Gemini CLI not installed', 'a row with a problem can be highlighted');
    s.type('\x1b[B\x1b[B');
    assert.equal(marked(s), '1 OpenCode', 'down from the last goes to the first');
    s.type('\x1b[A');
    assert.equal(marked(s), '3 Pi', 'up from the first goes to the last');
    s.type('\x1bOH');
    assert.equal(marked(s), '1 OpenCode', 'Home');
    s.type('\x1b[F');
    assert.equal(marked(s), '3 Pi', 'End');
    s.type('\x1b[1~');
    assert.equal(marked(s), '1 OpenCode');
    s.type('jj');
    assert.equal(marked(s), '3 Pi');
    s.type('k');
    assert.equal(marked(s), '2 Gemini CLI not installed');
    s.type('\x1b[1;1:2B\x1b[1;1:3B');
    assert.equal(marked(s), '3 Pi', 'an arrow in the keyboard protocol’s form');
    s.type('z\x1b[1;5C');
    assert.equal(marked(s), '3 Pi', 'other keys do nothing, and the list stays');
    assert.deepEqual(s.added, []);
  });

  it('starts the highlight on the first agent that can start now', () => {
    const s = stand({ choices: [{ id: 'gemini', name: 'Gemini CLI', note: 'not installed', problem: 'No.' }, { id: 'pi', name: 'Pi', note: 'connect it first', problem: 'Connect it.' }, ...three.slice(2)] });
    s.type('a');
    assert.equal(marked(s), '3 Pi');
    const none = stand({ choices: [{ id: 'gemini', name: 'Gemini CLI', note: 'not installed', problem: 'No.' }] });
    none.type('a');
    assert.equal(marked(none), '1 Gemini CLI not installed', 'with none that can, the first');
  });

  it('adds the agent Enter picks; a row with a problem says why, and starts nothing', () => {
    const s = stand({ choices: three });
    s.type('a\r');
    assert.deepEqual(s.added, ['opencode'], 'the highlight starts on the first');
    s.type('a\x1b[B\x1b[B\r');
    assert.deepEqual(s.added, ['opencode', 'pi']);
    assert.equal(s.screen().at(-1), ' o open the board · t threads · a add an agent · x stop one · q quit', 'the list is gone');
    s.type('a\x1b[B\r');
    assert.deepEqual(s.added, ['opencode', 'pi'], 'not installed: nothing started');
    shows(s.screen(), " Gemini CLI isn't installed here.");
    assert.equal(s.screen().at(-1), ' o open the board · t threads · a add an agent · x stop one · q quit');
  });

  it('keeps the numbers 1 to 9 as shortcuts, and Esc goes back, picking nothing', () => {
    const s = stand({ choices: three });
    s.type('a3');
    assert.deepEqual(s.added, ['pi'], 'the digit picks its row, wherever the highlight is');
    s.type('a\x1b[B1');
    assert.deepEqual(s.added, ['pi', 'opencode']);
    s.type('a5');
    assert.deepEqual(s.added, ['pi', 'opencode'], 'a number past the list does nothing');
    assert.equal(marked(s), '1 OpenCode', 'and the list stays');
    s.type('\x1b');
    assert.deepEqual(s.added, ['pi', 'opencode'], 'Esc: none');
    assert.equal(s.screen().at(-1), ' o open the board · t threads · a add an agent · x stop one · q quit');
    s.type('a\x03');
    assert.equal(s.screen().at(-1), ' o open the board · t threads · a add an agent · x stop one · q quit', 'Ctrl+C goes back too');
  });

  it('reaches every row of a list of more than nine with the arrows, though only nine have a digit', () => {
    const choices = Array.from({ length: 11 }, (_, i) => ({ id: `agent${i + 1}`, name: `Agent ${i + 1}` }));
    const s = stand({ choices });
    s.type('a\x1b[A');
    assert.equal(marked(s), 'Agent 11');
    s.type('\r');
    assert.deepEqual(s.added, ['agent11']);
    s.type('a\x1b[F\x1b[A\r');
    assert.deepEqual(s.added, ['agent11', 'agent10']);
    s.type('a9');
    assert.deepEqual(s.added.at(-1), 'agent9');
  });

  it('goes back at once from an add list with nothing in it', () => {
    const s = stand({ choices: [] });
    s.type('a');
    shows(s.screen(), ' Every agent is running. Esc back');
    s.type('j');
    assert.equal(s.screen().at(-1), ' o open the board · t threads · a add an agent · x stop one · q quit');
    s.type('a1');
    assert.equal(s.screen().at(-1), ' o open the board · t threads · a add an agent · x stop one · q quit', 'a digit too');
  });

  it('moves the highlight in the stop list, and Enter goes to the confirmation, which is as it was', () => {
    const s = stand();
    s.agents.push({ number: 3, name: 'OpenCode', state: 'running', lastOutput: NOW });
    s.type('x');
    assert.equal(marked(s), '1 Claude');
    s.type('\x1b[A');
    assert.equal(marked(s), '3 OpenCode', 'wraps up to the last');
    s.type('j');
    assert.equal(marked(s), '1 Claude', 'and down to the first');
    s.type('\x1b[F');
    assert.equal(marked(s), '3 OpenCode');
    s.type('\x1b[H\x1b[B');
    assert.equal(marked(s), '2 Codex');
    s.type('\r');
    assert.match(s.screen().at(-1)!, /^ Stop Codex\?    Yes  ❯ No/);
    assert.deepEqual(s.stopped, [], 'asks first');
    s.type('y');
    assert.deepEqual(s.stopped, [2]);
    s.type('x3');
    assert.match(s.screen().at(-1)!, /^ Stop OpenCode\?/, 'the digit is still the agent’s number');
    s.type('n');
    s.type('x\x1b');
    assert.equal(s.screen().at(-1), ' o open the board · t threads · a add an agent · x stop one · q quit', 'Esc: none');
    assert.deepEqual(s.stopped, [2]);
    s.type('x9');
    assert.equal(marked(s), '1 Claude', 'a number of no agent does nothing');
  });

  it('lists only the agents that are running to stop, and leaves the list if the one picked has ended meanwhile', () => {
    const s = stand();
    s.agents[0].state = 'ended';
    s.type('x');
    assert.equal(marked(s), '2 Codex');
    s.agents[1].state = 'ended';
    s.type('\r');
    assert.equal(s.screen().at(-1), ' o open the board · t threads · a add an agent · x stop one · q quit');
    assert.deepEqual(s.stopped, []);
    s.type('x');
    shows(s.screen(), ' No agent is running. Esc back');
  });

  // The answer highlighted in a request's row, or in a Yes / No pair: the one with ❯ before it.
  const leaning = (s: Stand) => {
    const row = s.screen().find((l) => /^ (❯| ) Allow /.test(l) && l.includes('Deny'))!;
    return /❯ (Allow for this session|Allow|Deny)/.exec(row)![1];
  };
  const pairOf = (s: Stand) => {
    const row = s.screen().find((l) => /Yes {2,4}(❯ )?No/.test(l))!;
    return /❯ (Yes|No)/.exec(row)![1];
  };

  it('moves along the answers with ← and →, wrapping, from Deny, and the row skips the session one where it is not offered', () => {
    const s = stand();
    s.tell({ approvals: [approval()] });
    assert.equal(leaning(s), 'Deny', 'a stray Enter never allows');
    s.type('\x1b[D');
    assert.equal(leaning(s), 'Allow for this session');
    s.type('\x1bOD');
    assert.equal(leaning(s), 'Allow');
    s.type('\x1b[D');
    assert.equal(leaning(s), 'Deny', 'wraps round');
    s.type('\x1b[C');
    assert.equal(leaning(s), 'Allow', 'and the other way');
    s.type('\x1b[1;1:2C\x1b[1;1:3C');
    assert.equal(leaning(s), 'Allow for this session', 'an arrow in the keyboard protocol’s form');
    s.type('\x1bOC');
    assert.equal(leaning(s), 'Deny');
    assert.deepEqual(s.answered, [], 'moving answers nothing');

    s.tell({ approvals: [approval({ id: 'a2', forSession: undefined })] });
    assert.equal(leaning(s), 'Deny');
    s.type('\x1b[D');
    assert.equal(leaning(s), 'Allow', 'no session choice to land on');
    s.type('\x1b[D');
    assert.equal(leaning(s), 'Deny');
  });

  it('answers with Enter as the highlight says: Deny first, so a bare Enter opens the reason, never allows', async () => {
    const s = stand();
    s.tell({ approvals: [approval()] });
    s.type('\r');
    assert.ok(s.tab.typing, 'Deny opens the reason line');
    assert.deepEqual(s.answered, []);
    shows(s.screen(), '   Tell Claude why (optional; it reads this). Enter deny · Esc back');
    s.type('too risky\r');
    await s.settle();
    assert.deepEqual(s.answered, [{ id: 'a1', reply: { behavior: 'deny', reason: 'too risky' } }]);
    shows(s.screen(), ' Denied: Claude reads your reason.');

    s.tell({ approvals: [approval({ id: 'a2' })] });
    s.type('\x1b[C\r'); // → Allow, Enter
    await s.settle();
    assert.deepEqual(s.answered[1], { id: 'a2', reply: { behavior: 'allow' } });
    shows(s.screen(), ' Allowed: Claude goes ahead.');

    s.tell({ approvals: [approval({ id: 'a3' })] });
    s.type('\x1b[D\r'); // ← Allow for this session, Enter
    await s.settle();
    assert.deepEqual(s.answered[2], { id: 'a3', reply: { behavior: 'allow', session: true } });
    shows(s.screen(), ' Allowed for this session: Claude goes ahead.');

    s.tell({ approvals: [approval({ id: 'a4' })] });
    s.type('\x1b[13u'); // Enter in the protocol's form
    assert.ok(s.tab.typing);
  });

  it('keeps y, s and n answering at once, wherever the highlight is, and Enter with nothing waiting does nothing', async () => {
    const s = stand();
    s.type('\r\x1b[D\x1b[C');
    assert.deepEqual(s.answered, []);
    assert.equal(s.tab.typing, false);
    s.tell({ approvals: [approval()] });
    s.type('\x1b[C'); // highlight: Allow
    s.type('n');
    assert.ok(s.tab.typing, 'n denies, whatever is highlighted');
    s.type('\x1b');
    s.type('s');
    await s.settle();
    assert.deepEqual(s.answered, [{ id: 'a1', reply: { behavior: 'allow', session: true } }]);
    s.tell({ approvals: [approval({ id: 'a2' })] });
    s.type('\x1b[D\x1b[D'); // highlight: Allow
    s.type('y');
    await s.settle();
    assert.deepEqual(s.answered[1], { id: 'a2', reply: { behavior: 'allow' } });
  });

  it('starts on Deny again when ↑ ↓ pick another request, and for each request that comes', () => {
    const s = stand();
    s.tell({ approvals: [approval(), approval({ id: 'a2', agent: 'Codex' })] });
    s.type('\x1b[C');
    assert.equal(leaning(s), 'Allow');
    s.type('\x1b[B');
    shows(s.screen(), ' › Codex wants to run a command in tricot:');
    assert.equal(leaning(s), 'Deny');
    s.type('\x1b[D');
    s.type('\x1b[A');
    assert.equal(leaning(s), 'Deny', 'back on the first, it is Deny again');
    s.type('\x1b[C');
    s.tell({ approvals: [approval({ id: 'a3' })] }); // the first is answered on the board: the next one shows
    assert.equal(leaning(s), 'Deny', 'what was highlighted was for the other');
  });

  it('keeps the reason line as it was: ← and → do nothing there, and Esc goes back to the choices', () => {
    const s = stand();
    s.tell({ approvals: [approval()] });
    s.type('n');
    s.type('no\x1b[D\x1b[Cway');
    shows(s.screen(), '   › noway');
    s.type('\x1b');
    assert.equal(leaning(s), 'Deny');
    s.type('\x1b[C\x1b[C');
    assert.equal(leaning(s), 'Allow for this session');
  });

  it('gives a sealed request no choices: ← → and Enter do nothing, and y still asks to be let in', async () => {
    const s = stand();
    s.seated = false;
    s.tell({ approvals: [{ id: 'a1', agent: 'Claude', harness: 'claude', tool: '', input: null, at: ago(5_000), sealed: true }] });
    s.type('\x1b[D\x1b[C\r');
    assert.equal(s.seatAsks, 0);
    assert.equal(s.tab.typing, false);
    assert.deepEqual(s.answered, []);
    s.type('y');
    await s.settle();
    assert.equal(s.seatAsks, 1);
  });

  it('asks to stop with No highlighted, ← → move, Enter answers it, y and n answer at once, Esc is No', () => {
    const s = stand();
    const ask = () => {
      s.type('x2');
      assert.equal(pairOf(s), 'No', 'starts on No');
    };
    ask();
    s.type('\r');
    assert.deepEqual(s.stopped, [], 'Enter on No keeps it');
    shows(s.screen(), ' Codex keeps running.');
    ask();
    s.type('\x1b[D');
    assert.equal(pairOf(s), 'Yes');
    s.type('\x1b[C');
    assert.equal(pairOf(s), 'No');
    s.type('\x1bOD\r');
    assert.deepEqual(s.stopped, [2], 'Enter on Yes stops it');
    shows(s.screen(), ' Stopped Codex.');
    assert.equal(s.screen().at(-1), ' o open the board · t threads · a add an agent · x stop one · q quit', 'the question is gone');
    ask();
    s.type('y');
    assert.deepEqual(s.stopped, [2, 2], 'y at once, whatever is highlighted');
    ask();
    s.type('\x1b[D');
    s.type('n');
    assert.deepEqual(s.stopped, [2, 2], 'n at once');
    shows(s.screen(), ' Codex keeps running.');
    ask();
    s.type('\x1b[D\x1b');
    assert.deepEqual(s.stopped, [2, 2], 'Esc is No, even with Yes highlighted');
    shows(s.screen(), ' Codex keeps running.');
    ask();
    s.type('\x03');
    assert.deepEqual(s.stopped, [2, 2], 'Ctrl+C too');
    assert.equal(s.screen().at(-1), ' o open the board · t threads · a add an agent · x stop one · q quit');
    s.type('x2\x1b[1;1:2D\x1b[1;1:3D\x1b[13u');
    assert.deepEqual(s.stopped, [2, 2, 2], 'in the protocol’s form: ← and Enter');
  });

  it('ignores other keys at "Stop Codex?": a slip leaves the question as it was', () => {
    const s = stand();
    s.type('x2');
    s.type('z\x1b[A\x1b[B\x1b[H\x7f q1 \x1b[1;5C');
    assert.equal(pairOf(s), 'No');
    assert.match(s.screen().at(-1)!, /^ Stop Codex\?    Yes {2}❯ No/, 'still asking');
    assert.deepEqual(s.stopped, []);
    assert.equal(s.quits, 0, 'q is not the tab’s while it asks');
    s.type('Y');
    assert.deepEqual(s.stopped, [2], 'a capital answers too');
  });

  it('keeps the approvals list moving with the arrows as before', () => {
    const s = stand();
    s.tell({ approvals: [approval({ id: 'a1', agent: 'Claude' }), approval({ id: 'a2', agent: 'Codex' })] });
    shows(s.screen(), ' › Claude wants to run a command in tricot:');
    s.type('\x1b[B');
    shows(s.screen(), ' › Codex wants to run a command in tricot:');
  });
});

// Seats (T187): a browser asking to act for the person, answered here with
// y or n; and what a terminal that isn't one of the person's seats shows of
// a request (who waits, not what they ask), and asking to be let in.
describe('the Tricot tab and seats', () => {
  const asking = (more: Partial<AdmissionView> = {}): AdmissionView => ({ id: 'ad1', code: '4271', kind: 'browser', label: 'Chrome on macOS', at: ago(2_000), expiresAt: ago(-178_000), ...more });

  it('asks "A browser wants to act for you (Chrome on macOS, code 4271). Allow?" with Yes and No, y allowing it', async () => {
    const s = stand();
    s.tell({ admissions: [asking()], approvals: [approval()] });
    const screen = s.screen();
    shows(screen, ' A browser wants to act for you (Chrome on macOS, code 4271). Allow?');
    shows(screen, "   Allow it only if the browser you're using shows 4271: it can then do all you do in Tricot.");
    shows(screen, '   Yes  ❯ No  (←→ Enter, or y/n · Esc later)');
    s.type('y');
    await s.settle();
    assert.deepEqual(s.admitted, [{ id: 'ad1', allow: true }]);
    assert.deepEqual(s.answered, [], 'y went to the browser asking, not to the request below it');
    shows(s.screen(), ' Chrome on macOS acts for you now.');
    assert.doesNotMatch(s.screen().join('\n'), /wants to act for you/, 'gone at once, as the stream catches up');
  });

  const pairRow = (s: Stand) => /❯ (Yes|No)/.exec(s.screen().find((l) => /Yes {2,4}(❯ )?No/.test(l))!)![1];

  it('asks with No highlighted: ← → move, Enter answers it, y and n answer at once, Esc is later', async () => {
    const s = stand();
    s.tell({ admissions: [asking()], approvals: [approval()] });
    assert.equal(pairRow(s), 'No');
    s.type('\x1b[D');
    assert.equal(pairRow(s), 'Yes');
    s.type('\x1b[C');
    assert.equal(pairRow(s), 'No');
    s.type('\x1bOC');
    assert.equal(pairRow(s), 'Yes', 'wraps round');
    assert.deepEqual(s.admitted, [], 'moving answers nothing');
    s.type('\r');
    await s.settle();
    assert.deepEqual(s.admitted, [{ id: 'ad1', allow: true }], 'Enter on Yes allows');
    assert.deepEqual(s.answered, [], 'and the request below it is not answered');
    assert.equal(s.tab.typing, false);

    s.tell({ admissions: [asking({ id: 'ad2' })] });
    assert.equal(pairRow(s), 'No', 'each one starts on No');
    s.type('\r');
    await s.settle();
    assert.deepEqual(s.admitted[1], { id: 'ad2', allow: false }, 'a bare Enter denies, as it did');

    s.tell({ admissions: [asking({ id: 'ad3' })] });
    s.type('\x1b[D');
    s.type('n');
    await s.settle();
    assert.deepEqual(s.admitted[2], { id: 'ad3', allow: false }, 'n at once, though Yes is highlighted');

    s.tell({ admissions: [asking({ id: 'ad4' })] });
    s.type('Y');
    await s.settle();
    assert.deepEqual(s.admitted[3], { id: 'ad4', allow: true }, 'y at once, though No is highlighted');

    s.tell({ admissions: [asking({ id: 'ad5' })] });
    s.type('\x1b[D\x1b');
    assert.equal(s.admitted.length, 4, 'Esc answers nothing');
    assert.doesNotMatch(s.screen().join('\n'), /wants to act for you/);
    shows(s.screen(), ' Left for now: it waits on the board until it lapses.');
  });

  it('answers once while the answer is on its way, whatever is typed', async () => {
    const s = stand();
    s.tell({ admissions: [asking()] });
    s.type('\x1b[D\r');
    s.type('\r\x1b[C\ry');
    await s.settle();
    assert.deepEqual(s.admitted, [{ id: 'ad1', allow: true }]);
  });

  it('keeps the whole question and its pair in a narrow window', () => {
    const s = stand();
    s.tell({ admissions: [asking()] });
    const screen = s.tab.render(40, 23).plain.map((l) => l.trimEnd());
    assert.ok(screen.join('\n').includes('code 4271). Allow?'), screen.join('\n'));
    assert.ok(screen.includes('   Yes  ❯ No  (Esc later)'), screen.join('\n'));
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
    shows(s.screen(), " A terminal wants to act for you (Tricot's terminal (tricot update), code 5310). Allow?");
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
    shows(s.screen(), '   Allow    Allow for this session  ❯ Deny  (←→ Enter, or y/s/n)');
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
