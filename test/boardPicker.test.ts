import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NEW_BOARD, pickBoard, updatedAgo, type Key, type PickerOptions, type TerminalKeys } from '../src/cli/boardPicker';
import { recentBoards } from '../src/cli/chooseBoard';
import { claudeSession, codexSession, firstMessage, opencodeSession, sessionCommand } from '../src/core/sessions';
import type { BoardSummary } from '../src/core/types';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

// A terminal that types `keys`, one at a time, and keeps what was drawn on it.
function terminal(keys: (string | Key)[], columns = 100): TerminalKeys & { drawn: string[]; stopped: boolean } {
  const queue = keys.map((key) => (typeof key === 'string' ? { name: key } : key));
  const term = {
    drawn: [] as string[],
    stopped: false,
    columns,
    write: (text: string) => void term.drawn.push(text),
    listen(onKey: (key: Key) => void) {
      const feed = () => {
        const key = queue.shift();
        if (!key || term.stopped) return;
        onKey(key);
        setImmediate(feed);
      };
      setImmediate(feed);
      return () => {
        term.stopped = true;
      };
    },
  };
  return term;
}

const typing = (text: string): Key[] => [...text].map((c) => ({ name: c, sequence: c }));
// The lines last drawn, as the terminal shows them.
const screen = (term: { drawn: string[] }) => {
  const last = term.drawn.filter((text) => text.startsWith('\r')).at(-1) ?? '';
  return last.replace(/^\r(\x1b\[\d+A)?\x1b\[J/, '').split('\n');
};

const boards = [
  { id: 'roadmap-1', title: 'Tricot roadmap', updatedAt: minutesAgo(3) },
  { id: 'site-2', title: 'Tricot site', updatedAt: minutesAgo(60 * 30) },
  { id: 'hoi4-3', title: 'hoi4 designer', updatedAt: minutesAgo(60 * 24 * 8) },
];
const options = (more: Partial<PickerOptions> = {}): PickerOptions => ({
  question: 'Which board should Claude work on?',
  boards,
  newName: 'tricot',
  maxName: 200,
  now: NOW,
  ...more,
});

describe('the board picker', () => {
  it('lists the boards with when each was updated, and New board last', async () => {
    const term = terminal(['escape']);
    await pickBoard(term, options({ lastHere: 'site-2' }));
    const first = term.drawn.find((text) => text.startsWith('\r'))!.replace(/^\r\x1b\[J/, '').split('\n');
    assert.deepEqual(first, [
      'Which board should Claude work on?  (↑↓ to move, Enter to pick, Esc to cancel)',
      '   Tricot roadmap  updated 3 min ago',
      ' ❯ Tricot site     updated yesterday   · last used here',
      '   hoi4 designer   updated last week',
      `   ${NEW_BOARD}`,
    ]);
  });

  it('moves with the arrow keys, wrapping round, and Enter picks', async () => {
    assert.deepEqual(await pickBoard(terminal(['down', 'down', 'return']), options()), { board: boards[2] });
    assert.deepEqual(await pickBoard(terminal(['up', 'up', 'return']), options()), { board: boards[2] }, 'up from the top goes to New board, then the last board');
    assert.deepEqual(await pickBoard(terminal(['return']), options({ lastHere: 'hoi4-3' })), { board: boards[2] }, 'the board last used here starts highlighted');
    assert.deepEqual(await pickBoard(terminal(['return']), options({ lastHere: 'gone' })), { board: boards[0] }, 'one that is gone starts at the top');
  });

  it('collapses to the answer, and puts the cursor back', async () => {
    const term = terminal(['down', 'return']);
    await pickBoard(term, options());
    assert.deepEqual(screen(term), ['Which board should Claude work on? Tricot site']);
    assert.equal(term.drawn.at(-1), '\n\x1b[?25h', 'a new line, and the cursor shown again');
    assert.equal(term.stopped, true, 'the terminal is put back as it was');
  });

  it('cancels on Esc, Ctrl+C or Ctrl+D, putting the terminal back each time', async () => {
    for (const key of ['escape', { name: 'c', ctrl: true }, { name: 'd', ctrl: true }]) {
      const term = terminal(['down', key]);
      assert.equal(await pickBoard(term, options()), undefined);
      assert.equal(term.stopped, true);
      assert.deepEqual(screen(term), ['Which board should Claude work on? cancelled']);
      assert.equal(term.drawn.at(-1), '\n\x1b[?25h');
    }
  });

  it("asks a new board's name with the folder's filled in, and takes it as edited", async () => {
    const term = terminal(['end', 'return', ...typing('-app'), 'backspace', 'return']);
    assert.deepEqual(await pickBoard(term, options()), { title: 'tricot-ap' });
    assert.deepEqual(screen(term), ['Which board should Claude work on? New board', 'Name the new board: tricot-ap']);

    const cleared = terminal(['end', 'return', { name: 'u', ctrl: true }, 'return', ...typing('  Ops  '), 'return']);
    assert.deepEqual(await pickBoard(cleared, options()), { title: 'Ops' }, 'Ctrl+U clears it; Enter on nothing waits; spaces are trimmed');

    const escaped = terminal(['end', 'return', ...typing('x'), 'escape']);
    assert.equal(await pickBoard(escaped, options()), undefined, 'Esc cancels there too');
    assert.equal(escaped.stopped, true);
  });

  it('offers New board alone when there are no boards', async () => {
    const term = terminal(['return', 'return']);
    assert.deepEqual(await pickBoard(term, options({ boards: [] })), { title: 'tricot' });
  });

  it('keeps every line narrower than the terminal, so redrawing stays in place', async () => {
    const long = [{ id: 'a', title: 'A board with a very long title that goes on and on and on', updatedAt: minutesAgo(5) }];
    const term = terminal(['escape'], 40);
    await pickBoard(term, options({ boards: long, lastHere: 'a' }));
    const first = term.drawn.find((text) => text.startsWith('\r'))!.replace(/^\r\x1b\[J/, '').split('\n');
    for (const line of first) assert.ok([...line].length < 40, `"${line}" fits`);
    assert.match(first[1], /❯ A board with .*…  updated 5 min ago/);
  });

  it('styles the highlighted line only when the terminal has colours', async () => {
    const plain = terminal(['escape']);
    await pickBoard(plain, options());
    assert.ok(!plain.drawn.join('').includes('\x1b[36m'));
    const colourful = Object.assign(terminal(['escape']), { color: true });
    await pickBoard(colourful, options());
    assert.ok(colourful.drawn.join('').includes('\x1b[36m❯\x1b[39m'));
  });

  it('says how long ago as a person would', () => {
    assert.equal(updatedAgo(minutesAgo(0), NOW), 'just now');
    assert.equal(updatedAgo(minutesAgo(3), NOW), '3 min ago');
    assert.equal(updatedAgo(minutesAgo(60), NOW), '1 hour ago');
    assert.equal(updatedAgo(minutesAgo(60 * 5), NOW), '5 hours ago');
    assert.equal(updatedAgo(minutesAgo(60 * 30), NOW), 'yesterday');
    assert.equal(updatedAgo(minutesAgo(60 * 24 * 3), NOW), '3 days ago');
    assert.equal(updatedAgo(minutesAgo(60 * 24 * 9), NOW), 'last week');
    assert.equal(updatedAgo(minutesAgo(60 * 24 * 21), NOW), '3 weeks ago');
    assert.equal(updatedAgo(minutesAgo(60 * 24 * 400), NOW), 'over a year ago');
    assert.equal(updatedAgo('not a date', NOW), 'just now');
  });
});

describe('the boards it offers', () => {
  const summary = (id: string, minutes: number, archived = false): BoardSummary =>
    ({ id, title: id, archived, updatedAt: minutesAgo(minutes), counts: {}, blockingOpen: 0 }) as unknown as BoardSummary;

  it('lists the eight updated most recently, never an archived one, and always the one used here last', () => {
    const all = Array.from({ length: 12 }, (_, i) => summary(`b${i}`, i * 10)).concat(summary('archived', 1, true));
    assert.deepEqual(recentBoards(all).map((b) => b.id), ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7']);
    assert.deepEqual(recentBoards(all, 'b11').map((b) => b.id), ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b11']);
    assert.deepEqual(recentBoards(all, 'archived').map((b) => b.id).includes('archived'), false);
  });
});

// The arguments each agent starts with, for one session (core/sessions.ts).
describe('an agent with the board for one session', () => {
  const url = 'http://127.0.0.1:4545/mcp?agent=Claude';
  const message = firstMessage('roadmap-1');

  it('tells the agent the board, or to find one', () => {
    assert.equal(message, 'Use the Tricot board roadmap-1 and start listening.');
    assert.equal(firstMessage(), 'Use Tricot and start listening.');
  });

  it('gives Claude Code the server as --mcp-config JSON, last, after the message and anything passed through', () => {
    // --allowedTools is variadic: --mcp-config, next, ends it.
    assert.deepEqual(claudeSession({ url, message, passthrough: [] }), {
      args: [message, '--allowedTools', 'mcp__tricot__*', '--mcp-config', '{"mcpServers":{"tricot":{"type":"http","url":"http://127.0.0.1:4545/mcp?agent=Claude"}}}'],
      env: {},
    });
    const withToken = claudeSession({ url, token: 's3cret', message, passthrough: ['--model', 'opus'] });
    assert.deepEqual(withToken.args.slice(0, 5), [message, '--model', 'opus', '--allowedTools', 'mcp__tricot__*']);
    assert.equal(withToken.args[5], '--mcp-config');
    assert.deepEqual(JSON.parse(withToken.args[6]).mcpServers.tricot.headers, { Authorization: 'Bearer s3cret' });
    assert.deepEqual(withToken.env, {}, 'no hooks: nothing needs the token in its environment');
  });

  it("gives Claude Code Tricot's hooks as --settings, and the token for them in its environment", () => {
    const settings = { hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'node approve.mjs' }] }] } };
    const launch = claudeSession({ url, token: 's3cret', message, passthrough: [], settings });
    assert.deepEqual(launch.args.slice(0, 5), [message, '--settings', JSON.stringify(settings), '--allowedTools', 'mcp__tricot__*']);
    assert.equal(launch.args[5], '--mcp-config');
    assert.deepEqual(launch.env, { TRICOT_TOKEN: 's3cret' });
  });

  it('gives Codex -c overrides, with the token only in its environment', () => {
    const codexUrl = 'http://127.0.0.1:4545/mcp?agent=Codex';
    assert.deepEqual(codexSession({ url: codexUrl, message, passthrough: [] }), {
      args: ['-c', `mcp_servers.tricot.url="${codexUrl}"`, '-c', 'mcp_servers.tricot.enabled=true', '-c', 'mcp_servers.tricot.default_tools_approval_mode="approve"', message],
      env: {},
    });
    const withToken = codexSession({ url: codexUrl, token: 's3cret', message, passthrough: ['--model', 'o3'] });
    assert.deepEqual(withToken.args, [
      '-c',
      `mcp_servers.tricot.url="${codexUrl}"`,
      '-c',
      'mcp_servers.tricot.enabled=true',
      '-c',
      'mcp_servers.tricot.default_tools_approval_mode="approve"',
      '-c',
      'mcp_servers.tricot.bearer_token_env_var="TRICOT_TOKEN"',
      '--model',
      'o3',
      message,
    ]);
    assert.deepEqual(withToken.env, { TRICOT_TOKEN: 's3cret' });
  });

  it('gives OpenCode its entry in OPENCODE_CONFIG_CONTENT, keeping inline config the person set', () => {
    const ocUrl = 'http://127.0.0.1:4545/mcp?agent=OpenCode';
    const plain = opencodeSession({ url: ocUrl, message, passthrough: [] });
    assert.deepEqual(plain.args, ['--prompt', message]);
    assert.deepEqual(JSON.parse(plain.env.OPENCODE_CONFIG_CONTENT), { mcp: { tricot: { type: 'remote', url: ocUrl, enabled: true, timeout: 300000 } } });

    const theirs = JSON.stringify({ theme: 'dark', mcp: { other: { type: 'local' } } });
    const merged = opencodeSession({ url: ocUrl, token: 's3cret', message, passthrough: ['--model', 'x'], env: { OPENCODE_CONFIG_CONTENT: theirs } });
    assert.deepEqual(merged.args, ['--model', 'x', '--prompt', message]);
    assert.deepEqual(JSON.parse(merged.env.OPENCODE_CONFIG_CONTENT), {
      theme: 'dark',
      mcp: { other: { type: 'local' }, tricot: { type: 'remote', url: ocUrl, enabled: true, timeout: 300000, headers: { Authorization: 'Bearer s3cret' } } },
    });
    assert.ok(!merged.args.join(' ').includes('s3cret'));
  });

  it('names the command for the Connect panel', () => {
    assert.equal(sessionCommand('claude'), 'tricot claude');
    assert.equal(sessionCommand('codex', 'my board-1'), 'tricot codex --board "my board-1"');
  });
});
