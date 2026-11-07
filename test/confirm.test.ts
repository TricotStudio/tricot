import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { askLine, confirm, Interrupted, yesNoAsker } from '../src/cli/confirm';
import { runUntilCtrlC, type CliResult } from '../src/cli/main';
import type { Key, TerminalKeys } from '../src/cli/terminalDraw';

const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

// A terminal that keeps what was written, and takes keys pressed while it listens.
interface Stand extends TerminalKeys {
  written: string[];
  listening: boolean;
  listened: number;
  press(...keys: (string | Key)[]): void;
}
function terminal(options: { columns?: number; color?: boolean } = {}): Stand {
  let listener: ((key: Key) => void) | undefined;
  const term: Stand = {
    written: [],
    listened: 0,
    columns: options.columns ?? 100,
    color: options.color ?? false,
    get listening() {
      return listener !== undefined;
    },
    write: (text) => void term.written.push(text),
    listen(onKey) {
      listener = onKey;
      term.listened += 1;
      return () => {
        if (listener === onKey) listener = undefined;
      };
    },
    press(...keys) {
      for (const key of keys) listener?.(typeof key === 'string' ? { name: key } : key);
    },
  };
  return term;
}

const typing = (char: string): Key => ({ name: char.toLowerCase(), sequence: char });
const CTRL_C: Key = { name: 'c', sequence: '\x03', ctrl: true };

// The lines last drawn, as the terminal shows them, colours and all.
const drawn = (term: Stand) => term.written.filter((text) => text.startsWith('\r')).map((text) => text.replace(/^\r\x1b\[J/, ''));
const shown = (term: Stand) => drawn(term).at(-1)!.replace(ANSI, '');
const everything = (term: Stand) => term.written.join('');

describe('a yes/no question as a Yes / No pair', () => {
  it('draws one line: the question, Yes and No, the default marked, and a hint', () => {
    const no = terminal();
    void confirm(no, 'Run it?', false);
    assert.equal(shown(no), 'Run it?   Yes  ❯ No  (←→ Enter, or y/n)');
    assert.equal(no.written[0], HIDE, 'the cursor is hidden while it listens');
    assert.equal(no.listening, true);

    const yes = terminal();
    void confirm(yes, 'Show the steps?', true);
    assert.equal(shown(yes), 'Show the steps? ❯ Yes    No  (←→ Enter, or y/n)');
  });

  it('moves the mark with the arrows, h and l, and Tab', () => {
    const term = terminal();
    void confirm(term, 'Run it?', false);
    term.press('left');
    assert.equal(shown(term), 'Run it? ❯ Yes    No  (←→ Enter, or y/n)');
    term.press('left');
    assert.equal(shown(term), 'Run it? ❯ Yes    No  (←→ Enter, or y/n)', 'it stops at the end');
    term.press('right');
    assert.equal(shown(term), 'Run it?   Yes  ❯ No  (←→ Enter, or y/n)');
    term.press('h');
    assert.equal(shown(term), 'Run it? ❯ Yes    No  (←→ Enter, or y/n)');
    term.press('l');
    assert.equal(shown(term), 'Run it?   Yes  ❯ No  (←→ Enter, or y/n)');
    term.press('tab');
    assert.equal(shown(term), 'Run it? ❯ Yes    No  (←→ Enter, or y/n)');
    term.press('tab');
    assert.equal(shown(term), 'Run it?   Yes  ❯ No  (←→ Enter, or y/n)');
  });

  it('answers what the mark is on at Enter', async () => {
    const yes = terminal();
    const first = confirm(yes, 'Run it?', false);
    yes.press('left', 'return');
    assert.equal(await first, 'yes');

    const no = terminal();
    const second = confirm(no, 'Run it?', true);
    no.press('right', 'enter');
    assert.equal(await second, 'no');

    const back = terminal();
    const third = confirm(back, 'Run it?', false);
    back.press('left', 'right', 'return');
    assert.equal(await third, 'no');
  });

  it('answers its default at a bare Enter: no for [y/N], yes for [Y/n]', async () => {
    const no = terminal();
    const first = confirm(no, 'Run it?', false);
    no.press('return');
    assert.equal(await first, 'no');

    const yes = terminal();
    const second = confirm(yes, 'Run it?', true);
    yes.press('return');
    assert.equal(await second, 'yes');

    const none = terminal();
    const third = confirm(none, 'Run it?');
    none.press('return');
    assert.equal(await third, 'no', 'no unless told');
  });

  it('answers y and n at once, in either case, wherever the mark is', async () => {
    for (const [key, fallback, answer] of [
      ['y', false, 'yes'],
      ['Y', false, 'yes'],
      ['n', true, 'no'],
      ['N', true, 'no'],
    ] as const) {
      const term = terminal();
      const asked = confirm(term, 'Run it?', fallback);
      term.press(typing(key));
      assert.equal(await asked, answer, key);
    }
    const moved = terminal();
    const asked = confirm(moved, 'Run it?', false);
    moved.press('left', typing('n'));
    assert.equal(await asked, 'no');
  });

  it('ignores Esc and the other keys, and keeps listening', async () => {
    const term = terminal();
    const asked = confirm(term, 'Run it?', false);
    const lines = drawn(term).length;
    term.press('escape', typing('x'), 'up', 'down', { name: 'y', sequence: '\x19', ctrl: true });
    assert.equal(term.listening, true);
    assert.equal(drawn(term).length, lines, 'nothing is redrawn');
    term.press(typing('y'));
    assert.equal(await asked, 'yes');
  });

  it('ends on Ctrl+C with interrupt, for the caller to act on, and leaves "cancelled"', async () => {
    const term = terminal();
    const asked = confirm(term, 'Run it?', false);
    term.press(CTRL_C);
    assert.equal(await asked, 'interrupt');
    assert.equal(shown(term), 'Run it? cancelled');
    assert.equal(term.listening, false, 'the terminal is let go of');
    assert.equal(term.written.at(-1), SHOW);
  });

  it('ends with left when what it asked about is answered elsewhere, and says so', async () => {
    const term = terminal();
    const abort = new AbortController();
    const asked = confirm(term, 'Allow?', false, abort.signal);
    assert.equal(term.listening, true);
    abort.abort();
    assert.equal(await asked, 'left');
    assert.equal(shown(term), 'Allow? (answered elsewhere)');
    assert.equal(term.listening, false);
    assert.equal(term.written.at(-1), SHOW);
    term.press(typing('y'));
    assert.equal(drawn(term).length, 2, 'a key after it ended does nothing');
  });

  it('asks nothing when it is answered elsewhere already', async () => {
    const term = terminal();
    const asked = await confirm(term, 'Allow?', false, AbortSignal.abort());
    assert.equal(asked, 'left');
    assert.equal(term.listened, 0);
    assert.equal(shown(term), 'Allow? (answered elsewhere)');
    assert.equal(everything(term).includes(HIDE), false);
  });

  it('answers once: a key and an abort together', async () => {
    const term = terminal();
    const abort = new AbortController();
    const asked = confirm(term, 'Allow?', false, abort.signal);
    term.press(typing('y'));
    abort.abort();
    assert.equal(await asked, 'yes');
    assert.equal(shown(term), 'Allow? Yes');
  });

  it('leaves the answer on screen, on a line of its own, and the cursor back', async () => {
    const term = terminal();
    const asked = confirm(term, 'Run it, adding the board?', false);
    term.press('left', 'return');
    await asked;
    assert.equal(shown(term), 'Run it, adding the board? Yes');
    assert.deepEqual(term.written.slice(-2), ['\n', SHOW]);
    assert.equal(everything(term).split(HIDE).length, 2, 'the cursor was hidden once');
    assert.equal(everything(term).split(SHOW).length, 2, 'and shown once');

    const no = terminal();
    const second = confirm(no, 'Run it?', false);
    no.press('return');
    await second;
    assert.equal(shown(no), 'Run it? No');
  });

  it('draws without colour on a terminal that has none', () => {
    const term = terminal({ color: false });
    void confirm(term, 'Run it?', false);
    term.press('left');
    assert.equal(everything(term).replace(/\x1b\[J|\x1b\[\?25[lh]/g, '').includes('\x1b'), false, 'no style, only the cursor and the redraw');
  });

  it('marks the highlighted one in colour on a terminal that has it', async () => {
    const term = terminal({ color: true });
    const asked = confirm(term, 'Run it?', false);
    assert.equal(drawn(term)[0], 'Run it?   Yes  \x1b[36m❯\x1b[39m \x1b[1mNo\x1b[22m  \x1b[2m(←→ Enter, or y/n)\x1b[22m');
    term.press(typing('y'));
    await asked;
    assert.equal(drawn(term).at(-1), 'Run it? \x1b[36mYes\x1b[39m');
  });

  it('keeps to one line where the question, the pair and any answer fit, with the hint when there is room for it', () => {
    const hinted = terminal({ columns: 100 });
    void confirm(hinted, 'x'.repeat(60), false);
    assert.equal(shown(hinted), `${'x'.repeat(60)}   Yes  ❯ No  (←→ Enter, or y/n)`);

    const tight = terminal({ columns: 100 });
    void confirm(tight, 'x'.repeat(75), false);
    assert.equal(shown(tight), `${'x'.repeat(75)}   Yes  ❯ No`, 'the hint is the first to go');
  });

  it('puts the cursor back and rejects when the terminal cannot be listened to', async () => {
    const term = terminal();
    term.listen = () => {
      throw new Error('not a terminal');
    };
    await assert.rejects(confirm(term, 'Run it?', false), /not a terminal/);
    assert.equal(term.written.at(-1), `\n${SHOW}`);
  });
});

// The admission a terminal asks about: the code in it is what the person checks.
const ADMISSION = 'A browser wants to act for you (Chrome on macOS, code 4271). Allow?';

describe('a question too long for one line with the pair', () => {
  // What was written once above the pair, as lines.
  const head = (term: Stand) => everything(term).replace(HIDE, '').split('\r\x1b[J')[0].split('\n').filter(Boolean);

  it('is written in full, wrapped, with the pair on a line of its own below it', () => {
    const term = terminal({ columns: 40 });
    void confirm(term, ADMISSION, false);
    assert.deepEqual(head(term), ['A browser wants to act for you (Chrome', 'on macOS, code 4271). Allow?']);
    assert.ok(head(term).join(' ').includes('code 4271'), 'the code is on screen');
    assert.equal(shown(term), '  Yes  ❯ No  (←→ Enter, or y/n)');
    assert.equal(term.written[0], `${HIDE}A browser wants to act for you (Chrome\non macOS, code 4271). Allow?\n`);
  });

  it('redraws only the pair on ←→, never the question', () => {
    const term = terminal({ columns: 40 });
    void confirm(term, ADMISSION, false);
    const before = term.written.length;
    term.press('left');
    assert.equal(shown(term), '❯ Yes    No  (←→ Enter, or y/n)');
    assert.deepEqual(term.written.slice(before), ['\r\x1b[J❯ Yes    No  (←→ Enter, or y/n)'], 'one write: back to the line start, clear, the pair');
    term.press('right');
    assert.equal(shown(term), '  Yes  ❯ No  (←→ Enter, or y/n)');
  });

  it('leaves the full question and the answer on the pair’s line, then the cursor back', async () => {
    const term = terminal({ columns: 40 });
    const asked = confirm(term, ADMISSION, false);
    term.press(typing('y'));
    assert.equal(await asked, 'yes');
    assert.equal(shown(term), '  Yes');
    assert.equal(everything(term).replace(HIDE, '').split('\r\x1b[J')[0], 'A browser wants to act for you (Chrome\non macOS, code 4271). Allow?\n');
    assert.deepEqual(term.written.slice(-2), ['\n', SHOW]);

    const no = terminal({ columns: 40 });
    const second = confirm(no, ADMISSION, false);
    no.press('return');
    await second;
    assert.equal(shown(no), '  No');
  });

  it('says it was answered elsewhere on that line, whether it was aborted while asking or before', async () => {
    const term = terminal({ columns: 40 });
    const abort = new AbortController();
    const asked = confirm(term, ADMISSION, false, abort.signal);
    abort.abort();
    assert.equal(await asked, 'left');
    assert.equal(shown(term), '  (answered elsewhere)');
    assert.equal(head(term).join(' ').includes('code 4271'), true);
    assert.equal(term.listening, false);
    assert.equal(term.written.at(-1), SHOW);

    const already = terminal({ columns: 40 });
    assert.equal(await confirm(already, ADMISSION, false, AbortSignal.abort()), 'left');
    assert.equal(already.listened, 0);
    assert.equal(shown(already), '  (answered elsewhere)');
    assert.deepEqual(head(already), ['A browser wants to act for you (Chrome', 'on macOS, code 4271). Allow?']);
    assert.equal(everything(already).includes(HIDE), false);
  });

  it('says cancelled on that line at Ctrl+C, and hands interrupt back', async () => {
    const term = terminal({ columns: 40 });
    const asked = confirm(term, ADMISSION, false);
    term.press(CTRL_C);
    assert.equal(await asked, 'interrupt');
    assert.equal(shown(term), '  cancelled');
    assert.equal(head(term).join(' ').includes('code 4271'), true);
    assert.equal(term.listening, false);
    assert.equal(term.written.at(-1), SHOW);
  });

  it('is never cut, at any width: all of it is on screen when it is answered, and no line is wider than the terminal', async () => {
    const long = 'A browser wants to act for you (Mozilla Firefox 139 on a Linux x86_64 machine called a-very-long-host-name, code 4271). Allow?';
    const squeezed = (text: string) => text.replace(/\s+/g, '');
    for (const question of [ADMISSION, long, "Remove every browser and terminal you've let in?", 'x'.repeat(90)]) {
      for (const columns of [10, 24, 30, 40, 60, 80, 100, 120, 200]) {
        const term = terminal({ columns });
        const asked = confirm(term, question, false);
        term.press('left');
        term.press(typing('n'));
        await asked;
        const width = Math.max(24, columns - 1);
        const written = everything(term).replace(/\x1b\[\?25[lh]/g, '');
        for (const line of written.split(/\r\x1b\[J|\n/).filter(Boolean)) assert.ok([...line].length <= width, `${columns} columns: "${line}" is ${[...line].length} wide`);
        const screen = `${written.split('\r\x1b[J')[0]}${shown(term)}`;
        assert.ok(squeezed(screen).includes(squeezed(question)), `${columns} columns: "${question.slice(0, 30)}…" whole`);
        assert.equal(screen.includes('…'), false, `${columns} columns: nothing cut`);
      }
    }
  });
});

describe('askLine', () => {
  // A terminal's line: Ctrl+C is read as the key here (readline's terminal mode), as at a terminal with output on a terminal too.
  const ctrlC = () => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { isTTY: true });
    let said = '';
    output.on('data', (chunk) => (said += chunk));
    setImmediate(() => input.write('\x03'));
    return { io: { input, output }, said: () => said.replace(ANSI, '') };
  };
  const lines = (answer: string) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let said = '';
    output.on('data', (chunk) => (said += chunk));
    input.end(`${answer}\n`);
    return { io: { input, output }, said: () => said };
  };

  it('asks the plain way, with [y/N] after the question, and a bare Enter is no', async () => {
    const a = lines('');
    assert.equal(await askLine('Run it?', false, a.io), false);
    assert.equal(a.said(), 'Run it? [y/N] ');
  });

  it('shows [Y/n] when a bare Enter is yes', async () => {
    const a = lines('');
    assert.equal(await askLine('Show the steps?', true, a.io), true);
    assert.equal(a.said(), 'Show the steps? [Y/n] ');
  });

  it('throws Interrupted on Ctrl+C, in the plain question and in the one the command asks', async () => {
    for (const ask of [(io: ReturnType<typeof ctrlC>['io']) => askLine('Run it?', false, io), (io: ReturnType<typeof ctrlC>['io']) => yesNoAsker(undefined, io)('Run it?', false)]) {
      const c = ctrlC();
      await assert.rejects(ask(c.io), (error) => error instanceof Interrupted);
      assert.equal(c.said().trimEnd(), 'Run it? [y/N]');
    }
  });

  it('takes y and yes in either case as yes, and anything else as no', async () => {
    for (const [answer, expected] of [['y', true], ['YES', true], ['Yes', true], ['n', false], ['no', false], ['maybe', false]] as const) {
      assert.equal(await askLine('Run it?', true, lines(answer).io), expected, answer);
    }
  });
});

describe('the question the command asks (ask)', () => {
  it('is the Yes / No pair where there are keys, answering as it does', async () => {
    const term = terminal();
    const ask = yesNoAsker(term);
    const yes = ask('Run it?', false);
    term.press('left', 'return');
    assert.equal(await yes, true);
    assert.equal(shown(term), 'Run it? Yes');

    const no = ask('Run it?');
    term.press('return');
    assert.equal(await no, false, 'no unless told');

    const dflt = ask('Show the steps?', true);
    term.press('return');
    assert.equal(await dflt, true);
  });

  it('stops the command on Ctrl+C, as the line question did: it throws Interrupted', async () => {
    const term = terminal();
    const asked = yesNoAsker(term)('Run it?', false);
    term.press(CTRL_C);
    await assert.rejects(asked, (error) => error instanceof Interrupted && error.message === 'Aborted with Ctrl+C');
    assert.equal(term.listening, false);
    assert.equal(term.written.at(-1), SHOW);
  });

  it('is a line, with [y/N] after the question, where there are no keys', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let said = '';
    output.on('data', (chunk) => (said += chunk));
    input.end('y\n');
    assert.equal(await yesNoAsker(undefined, { input, output })('Run it?', false), true);
    assert.equal(said, 'Run it? [y/N] ');
  });
});

describe('Ctrl+C at a question ends the command quietly (runUntilCtrlC)', () => {
  it('says that nothing was changed, and gives the exit code of a shell for Ctrl+C', async () => {
    const said: string[] = [];
    const result = await runUntilCtrlC(() => Promise.reject(new Interrupted()), (line) => said.push(line));
    assert.deepEqual(result, { exitCode: 130 });
    assert.deepEqual(said, ['Stopped: nothing was changed.']);
  });

  it('stops on the key the terminal read at the question', async () => {
    const term = terminal();
    const said: string[] = [];
    const result = runUntilCtrlC(async () => ({ exitCode: Number(await yesNoAsker(term)('Run it?', false)) }), (line) => said.push(line));
    term.press(CTRL_C);
    assert.deepEqual(await result, { exitCode: 130 });
    assert.deepEqual(said, ['Stopped: nothing was changed.']);
    assert.equal(term.listening, false);
    assert.equal(term.written.at(-1), SHOW);
  });

  it('gives what the command gave, and leaves other errors as they are', async () => {
    const said: string[] = [];
    const given: CliResult = { exitCode: 3 };
    assert.equal(await runUntilCtrlC(async () => given, (line) => said.push(line)), given);
    const other = Object.assign(new Error('Aborted with Ctrl+C'), { name: 'AbortError' });
    await assert.rejects(runUntilCtrlC(() => Promise.reject(other), (line) => said.push(line)), (error) => error === other);
    assert.deepEqual(said, []);
  });
});
