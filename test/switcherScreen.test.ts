import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { modeChanges, PLAIN_MODES } from '../src/cli/switcher/modes';
import { AgentScreen, type ScreenEvents } from '../src/cli/switcher/screen';
import { COLOURS } from './switcher/harness';

// Each agent's screen (@xterm/headless), and painting the real terminal from
// it: what the real terminal shows after a paint is what the agent drew,
// cell by cell, in its colours. The "real terminal" here is another screen,
// fed only what the host would write.

const ROWS = 8;
const COLS = 40;

// What an agent might draw: every kind of colour, styles, wide characters,
// a line that fills the width, and blank cells with a background.
const DRAWING = [
  '\x1b[31mred\x1b[0m \x1b[92mbright\x1b[0m \x1b[38;5;200m256\x1b[0m \x1b[38;2;10;200;30mtrue\x1b[0m',
  '\x1b[1mbold\x1b[0m \x1b[2mdim\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munder\x1b[0m \x1b[7minverse\x1b[0m \x1b[9mstrike\x1b[0m',
  '\x1b[48;5;24m\x1b[38;5;231m on a background   \x1b[0m',
  '日本語 ✅ wide, then ascii',
  `\x1b[44m${'x'.repeat(COLS)}\x1b[0m`,
  '\x1b[43m     \x1b[0m (blank cells, coloured)',
].join('\r\n');

// Paints rows into the "real terminal", as the host does: only those that differ.
function painter(real: AgentScreen) {
  const painted: string[] = [];
  return async (from: AgentScreen) => {
    let out = '';
    for (let y = 0; y < from.rows; y++) {
      const row = from.row(y);
      if (painted[y] !== row) out += `\x1b[${y + 1};1H${row}`;
      painted[y] = row;
    }
    await real.write(out);
    return out.length;
  };
}

const sameRows = (a: AgentScreen, b: AgentScreen) => Array.from({ length: a.rows }, (_, y) => a.row(y) === b.row(y)).every(Boolean);

describe("an agent's screen, painted", () => {
  it('comes out on the real terminal exactly, colours, styles and wide characters included', async () => {
    const agent = new AgentScreen(COLS, ROWS);
    await agent.write(DRAWING);
    const real = new AgentScreen(COLS, ROWS);
    await painter(real)(agent);
    for (let y = 0; y < ROWS; y++) assert.equal(real.row(y), agent.row(y), `row ${y}`);
    assert.equal(real.text(3), '日本語 ✅ wide, then ascii');
    assert.match(agent.row(0), /\x1b\[0;31mred/, 'the 16 colours as their own codes, so the terminal keeps its palette');
    assert.match(agent.row(0), /38;5;200m256/);
    assert.match(agent.row(0), /38;2;10;200;30mtrue/);
    assert.ok(!agent.row(4).endsWith('\x1b[K'), 'a full row is not erased at its end, which would take its last character');
    assert.ok(agent.row(1).endsWith('\x1b[0m\x1b[K'), 'a short one is');
  });

  it('switches between two agents exactly, each time, writing only the rows that differ', async () => {
    const claude = new AgentScreen(COLS, ROWS);
    const codex = new AgentScreen(COLS, ROWS);
    await claude.write(DRAWING);
    await codex.write('\x1b[?1049h\x1b[H\x1b[48;2;40;60;220m\x1b[1;37m >_ Codex \x1b[0m\r\n\x1b[38;5;117m• Running npm test\x1b[0m');
    const real = new AgentScreen(COLS, ROWS);
    const paint = painter(real);
    await paint(claude);
    for (const shown of [codex, claude, codex, claude]) {
      await paint(shown);
      assert.ok(sameRows(real, shown), 'the real terminal shows the agent switched to');
    }
    assert.equal(await paint(claude), 0, 'nothing to write when nothing changed');
    await claude.write('\x1b[8;1Hchanged');
    const bytes = await paint(claude);
    assert.ok(bytes > 0 && bytes < 40, 'one row');
  });

  it('keeps a hidden agent current: what it drew while hidden shows when it comes back', async () => {
    const claude = new AgentScreen(COLS, ROWS);
    const codex = new AgentScreen(COLS, ROWS);
    const real = new AgentScreen(COLS, ROWS);
    const paint = painter(real);
    await paint(codex);
    await claude.write('\x1b[2J\x1b[Hdrawn while hidden \x1b[35mmagenta\x1b[0m');
    await paint(claude);
    assert.ok(sameRows(real, claude));
    assert.equal(real.text(0), 'drawn while hidden magenta');
  });

  it('keeps history above a normal screen, and none on the alternate one', async () => {
    const agent = new AgentScreen(COLS, 4);
    await agent.write(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\r\n'));
    assert.equal(agent.history, 6);
    assert.equal(new AgentScreen(COLS, 4).historyRow(0), '\x1b[0m\x1b[K');
    assert.match(agent.historyRow(0), /line 1\x1b/);
    await agent.write('\x1b[?1049h');
    assert.ok(agent.altScreen);
  });
});

describe('what the screen answers and hands on', () => {
  const events = () => {
    const seen: string[] = [];
    const handlers: ScreenEvents = {
      reply: (data) => seen.push(`reply ${JSON.stringify(data)}`),
      bell: () => seen.push('bell'),
      notify: (s) => seen.push(`notify ${JSON.stringify(s)}`),
      progress: (s) => seen.push(`progress ${JSON.stringify(s)}`),
      clipboard: (s) => seen.push(`clipboard ${JSON.stringify(s)}`),
    };
    return { seen, handlers };
  };

  it("answers what agents ask at startup, so a hidden one never waits: device attributes, the cursor's place, the terminal's colours", async () => {
    const { seen, handlers } = events();
    const screen = new AgentScreen(COLS, ROWS, handlers, COLOURS);
    await screen.write('\x1b[c\x1b[3;5H\x1b[6n\x1b]11;?\x1b\\\x1b]10;?;?\x07');
    assert.deepEqual(seen, [
      'reply "\\u001b[?1;2c"',
      'reply "\\u001b[3;5R"',
      `reply ${JSON.stringify(`\x1b]11;${COLOURS.background}\x1b\\`)}`,
      `reply ${JSON.stringify(`\x1b]10;${COLOURS.foreground}\x1b\\\x1b]11;${COLOURS.background}\x1b\\`)}`,
    ]);
    // Colours it doesn't know, it doesn't make up.
    const { seen: none, handlers: quiet } = events();
    await new AgentScreen(COLS, ROWS, quiet).write('\x1b]11;?\x07');
    assert.deepEqual(none, []);
  });

  it('hands on bells, notifications, progress and copies to the clipboard, but not a request to read it', async () => {
    const { seen, handlers } = events();
    const screen = new AgentScreen(COLS, ROWS, handlers);
    await screen.write('\x07\x1b]9;Claude needs you\x07\x1b]777;notify;Codex;done\x07\x1b]9;4;1;50\x07\x1b]52;c;aGVsbG8=\x07\x1b]52;c;?\x07');
    assert.deepEqual(seen, [
      'bell',
      'notify "\\u001b]9;Claude needs you\\u0007"',
      'notify "\\u001b]777;notify;Codex;done\\u0007"',
      'progress "\\u001b]9;4;1;50\\u001b\\\\"',
      'clipboard "\\u001b]52;c;aGVsbG8=\\u0007"',
    ]);
  });

  it('notes the input settings the agent asks for, and the cursor', async () => {
    const screen = new AgentScreen(COLS, ROWS);
    assert.deepEqual(screen.inputModes, PLAIN_MODES);
    await screen.write('\x1b[?2004h\x1b[?1004h\x1b[?1002h\x1b[?1006h\x1b[?1h\x1b=\x1b[5 q\x1b[?25l\x1b[>5u\x1b[>4;2m');
    assert.deepEqual(screen.inputModes, { bracketedPaste: true, focus: true, mouse: 'drag', mouseEncoding: 'sgr', cursorKeys: true, keypad: true, cursorStyle: 5, keyboard: 5, otherKeys: 2 });
    assert.equal(screen.cursor.visible, false);
    await screen.write('\x1b[?1006l\x1b[?25h');
    assert.equal(screen.inputModes.mouseEncoding, 'default');
    assert.equal(screen.cursor.visible, true);
    await screen.write('\x1b[?25l\x1bc');
    assert.deepEqual(screen.inputModes, PLAIN_MODES, 'a reset puts it all back');
    assert.equal(screen.cursor.visible, true);
  });
});

describe("the real terminal's settings", () => {
  it('are set whole the first time, then only where they differ, and put back as a terminal starts', () => {
    const codex = { ...PLAIN_MODES, bracketedPaste: true, focus: true, mouse: 'any' as const, mouseEncoding: 'sgr' as const };
    const first = modeChanges(undefined, codex);
    for (const part of ['\x1b[?2004h', '\x1b[?1004h', '\x1b[?1l', '\x1b>', '\x1b[?1006h', '\x1b[?1003h', '\x1b[0 q']) assert.ok(first.includes(part), JSON.stringify(part));
    assert.equal(modeChanges(codex, codex), '');
    const claude = { ...codex, mouse: 'drag' as const, focus: false };
    assert.equal(modeChanges(codex, claude), '\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?9l\x1b[?1006l\x1b[?1015l\x1b[?1005l\x1b[?1006h\x1b[?1002h');
    const back = modeChanges(claude, PLAIN_MODES);
    assert.ok(back.includes('\x1b[?2004l') && back.includes('\x1b[?1002l') && !back.includes('h'), JSON.stringify(back));
  });
});
