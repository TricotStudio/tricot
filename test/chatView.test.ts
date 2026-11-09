import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatItem, ChatPlace } from '../src/core/chatStream';
import type { Actor } from '../src/core/types';
import { ChatLayout, chatGeometry, chatLines, chatTints, renderChat, type ChatAnchor, type ChatViewData } from '../src/cli/switcher/chatView';
import { columns, type Rgb } from '../src/cli/switcher/strip';
import { DIM, linkAt, onBand, paint, webAddresses } from '../src/cli/switcher/tabView';
import { bandOf, messageRows, type Compose } from '../src/cli/switcher/threadsView';

// The chat's stream, drawn (T21): each item's head row (who, where it
// belongs, when), its text and reactions as a thread's messages are drawn, at
// a wide window and a narrow one; scrolled, and what it says with nothing to
// show; each item on its conversation's tint, and the line to type on on its
// band; and laid out only as it shows (T27), drawing what the whole stream
// laid out drew. The tab around it is switcherThreads.test.ts's.

const NOW = Date.parse('2026-11-07T16:30:00Z');
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const me: Actor = { kind: 'human', name: 'Wassim' };
const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };
const sam: Actor = { kind: 'human', name: 'Sam' };

let counter = 0;
const item = (author: Actor, body: string, msAgo: number, place: ChatPlace, more: Partial<ChatItem> = {}): ChatItem => {
  const id = `i${++counter}`;
  return { key: `${place.kind}:${id}`, id, author, body, at: ago(msAgo), place, ...more };
};
const T17: ChatPlace = { kind: 'task', id: 't17', number: 17, title: 'Keep backlog quiet' };
const D7: ChatPlace = { kind: 'decision', id: 'd7', number: 7, title: 'Open the Tricot tab on chat?' };
const THREAD: ChatPlace = { kind: 'thread', id: 'th', title: "Pick up Codex's work" };
const DESIGN: ChatPlace = { kind: 'thread', id: 'th2', title: 'Picker spacing', lens: 'Design' };
const T19_PIN: ChatPlace = { kind: 'task', id: 't19', number: 19, title: 'Stopped agents leave the strip', pin: { id: 'p2', quote: '“the strip after a stop”' } };
const BOARD_PIN: ChatPlace = { kind: 'board', pin: { id: 'p1', quote: '“Beta ships to ten teams”' } };

const STREAM: ChatItem[] = [
  item(codex, 'T17 is ready to review. The server filters backlog before it builds an MCP reply, so an agent never sees a backlog card it was not asked about.', 12 * MIN, T17),
  item(me, "Let's go with a.", 9 * MIN, D7),
  item(codex, 'Tighter: 8 px between rows.', 5 * MIN, DESIGN),
  item(claude, 'T17 is ready for you to review.', 2 * MIN, THREAD, { reactions: [{ emoji: '👍', by: me, at: ago(MIN) }, { emoji: '👀', by: sam, at: ago(MIN) }] }),
  item(sam, 'Which ten?', MIN, BOARD_PIN),
  item(claude, 'This is the strip now.', 10_000, T19_PIN),
];

const plain = (items: ChatItem[], width: number) => chatLines(items, width, 'Wassim', NOW).lines.map((parts) => parts.map(([text]) => text).join('').trimEnd());
const compose = (more: Partial<Compose> = {}): Compose => ({ text: '', cursor: 0, placeholder: 'What do you want to work through?', status: { text: 'New thread · Claude is listening.', tone: 'normal' }, ...more });
const view = (more: Partial<ChatViewData> = {}): ChatViewData => ({ items: STREAM, top: 'end', compose: compose(), me: 'Wassim', now: NOW, ...more });
const screen = (data: ChatViewData, cols: number, rows: number) => renderChat(data, cols, rows).plain.map((l) => l.trimEnd());

describe('the chat’s stream, drawn', () => {
  it('heads each item with who wrote it, where it belongs and when, at a wide window', () => {
    assert.deepEqual(plain(STREAM, 120), [
      '  Codex  agent · on T17 Keep backlog quiet · 12 min ago',
      '    T17 is ready to review. The server filters backlog before it builds an MCP reply, so an agent never sees a backlog',
      '    card it was not asked about.',
      "  You · on #7 Open the Tricot tab on chat? · 9 min ago",
      "    Let's go with a.",
      '  Codex  agent · in Design · Picker spacing · 5 min ago',
      '    Tighter: 8 px between rows.',
      "  Claude  agent · in Pick up Codex's work · 2 min ago",
      '    T17 is ready for you to review.',
      '    👍 You · 👀 Sam',
      '  Sam · on the board, about “Beta ships to ten teams” · 1 min ago',
      '    Which ten?',
      '  Claude  agent · on T19 Stopped agents leave the strip, about “the strip after a stop” · just now',
      '    This is the strip now.',
    ]);
  });

  it('cuts the part pinned first, then the title, and keeps the time unless the title would be left with next to nothing, at a narrow window', () => {
    const lines = plain(STREAM, 48);
    assert.deepEqual(lines, [
      '  Codex  agent · on T17 Keep back… · 12 min ago',
      '    T17 is ready to review. The server filters',
      '    backlog before it builds an MCP reply, so',
      '    an agent never sees a backlog card it was',
      '    not asked about.',
      '  You · on #7 Open the Tricot tab … · 9 min ago',
      "    Let's go with a.",
      '  Codex  agent · in Design · Picker spacing',
      '    Tighter: 8 px between rows.',
      '  Claude  agent · in Pick up Codex… · 2 min ago',
      '    T17 is ready for you to review.',
      '    👍 You · 👀 Sam',
      '  Sam · on the board · 1 min ago',
      '    Which ten?',
      '  Claude  agent · on T19 Stopped ag… · just now',
      '    This is the strip now.',
    ]);
    assert.ok(lines.every((line) => columns(line) <= 47), 'one column spare, as the thread view leaves');
    assert.equal(plain([item(sam, 'Which ten?', MIN, BOARD_PIN)], 64)[0], '  Sam · on the board, about “Beta ships to ten tea… · 1 min ago', 'the part, cut, while it has room');
  });

  it('cuts what it must at the narrowest', () => {
    const [head] = plain([item(claude, 'Hi', 3 * MIN, T17)], 34);
    assert.equal(head, '  Claude  agent · on T17 Keep ba…');
    // The head row; the text is cut by the window as it is drawn (paint), as a thread's is.
    for (const width of [34, 20, 12, 4]) assert.ok(columns(plain([item(claude, 'Hi', 3 * MIN, T17)], width)[0]) <= Math.max(1, width - 1), `${width}`);
  });

  it('draws words from the board safe: control characters as their pictures, never sent to the terminal', () => {
    const lines = plain([item({ kind: 'agent', name: 'Cl\u001b[31maude' }, 'Line one\u0007\nLine\ttwo ‮evil', MIN, { kind: 'task', id: 't', number: 3, title: 'Title\u001b]0;pwned\u0007 here' })], 120);
    assert.ok(lines.every((line) => !/[\u0000-\u001f\u007f-\u009f‪-‮]/.test(line)), lines.join('\n'));
    assert.equal(lines[1], '    Line one␇');
    assert.equal(lines[2], '    Line  two �evil');
  });

  it('marks an item on its way and one chosen, for what answers one to say so', () => {
    const [first] = STREAM;
    const lines = chatLines([first], 120, 'Wassim', NOW, new Set([first.key]), first.key).lines.map((parts) => parts.map(([text]) => text).join(''));
    assert.equal(lines[0], '❯ Codex  agent · on T17 Keep backlog quiet · sending…');
  });
});

describe('the chat’s stream, in its window', () => {
  it('shows the latest above the line, a blank row between, and the keys at the foot', () => {
    const rows = screen(view(), 120, 14);
    assert.deepEqual(rows, [
      "    Let's go with a.",
      '  Codex  agent · in Design · Picker spacing · 5 min ago',
      '    Tighter: 8 px between rows.',
      "  Claude  agent · in Pick up Codex's work · 2 min ago",
      '    T17 is ready for you to review.',
      '    👍 You · 👀 Sam',
      '  Sam · on the board, about “Beta ships to ten teams” · 1 min ago',
      '    Which ten?',
      '  Claude  agent · on T19 Stopped agents leave the strip, about “the strip after a stop” · just now',
      '    This is the strip now.',
      '',
      ' › What do you want to work through?',
      ' New thread · Claude is listening.',
      ' Enter new thread · ↑↓ PgUp PgDn scroll · Tab complete @ / · Esc threads · ^L lens',
    ]);
  });

  it('starts from the oldest when it all fits, and stays where it was scrolled to', () => {
    const fits = screen(view({ items: STREAM.slice(0, 2) }), 120, 14);
    assert.equal(fits[0], '  Codex  agent · on T17 Keep backlog quiet · 12 min ago');
    const top = screen(view({ top: 0 }), 80, 14);
    assert.equal(top[0], '  Codex  agent · on T17 Keep backlog quiet · 12 min ago');
    const { body } = chatGeometry(80, 14, 2);
    const total = chatLines(STREAM, 80, 'Wassim', NOW).lines.length;
    assert.ok(total > body, 'more than the window holds');
    assert.match(top.at(-4)!, /^ {2}↓ \d+ newer below$/, 'the row before the line says what is below');
    const typing = screen(view({ top: 0, compose: compose({ text: 'hello', cursor: 5 }) }), 80, 14);
    assert.match(typing.at(-4)!, /^ {2}↓ \d+ newer below$/);
    assert.equal(typing.at(-1), ' Enter new thread · ↑↓ PgUp PgDn scroll · Tab complete @ / · Esc clear · ^L lens');
  });

  it('says Enter goes back to the latest while scrolled up, sending what is typed, and only where Enter does', () => {
    const empty = screen(view({ top: 0, enterLatest: true }), 80, 14);
    assert.equal(empty.at(-4), '  ↓ 2 newer below · Enter for the latest');
    assert.equal(empty.at(-1), ' Enter latest · ↑↓ PgUp PgDn scroll · Tab complete @ / · Esc threads · ^L lens', 'in place of a new thread');
    const typed = screen(view({ top: 0, enterLatest: true, compose: compose({ text: 'sounds good, merge it', cursor: 21 }) }), 80, 14);
    assert.equal(typed.at(-4), '  ↓ 2 newer below · Enter sends and goes to the latest', 'the row stays while typing');
    assert.equal(typed.at(-1), ' Enter new thread · ↑↓ PgUp PgDn scroll · Tab complete @ / · Esc clear · ^L lens', 'Enter still sends');
    // Answering, and in a thread picked: Enter says latest in place of send.
    const replying = compose({ placeholder: 'Reply to Claude…', status: { text: 'to T19 Stopped agents leave the strip, the latest · Claude hears it', tone: 'normal' } });
    assert.equal(screen(view({ top: 0, enterLatest: true, compose: replying, replying: true }), 120, 14).at(-1), ' Enter latest · @ new thread · > elsewhere · Tab an earlier one · Esc threads · ↑↓ PgUp PgDn scroll');
    assert.equal(screen(view({ top: 0, enterLatest: true, compose: replying, replying: true }), 80, 14).at(-1), ' Enter latest · @ new thread · > elsewhere · Tab an earlier one · Esc threads', 'scrolling still goes first');
    assert.equal(screen(view({ top: 0, enterLatest: true, compose: { ...replying, text: 'ok', cursor: 2 }, replying: true }), 80, 14).at(-1), ' Enter send · ↑↓ PgUp PgDn scroll · Tab complete · Esc clear');
    const only = screen(view({ top: 0, enterLatest: true, compose: replying, replying: true, only: "Pick up Codex's work" }), 80, 14);
    assert.equal(only.at(-4), '  ↓ 2 newer below · Enter for the latest');
    assert.equal(only.at(-1), ' Enter latest · Tab react · Esc everything · ↑↓ PgUp PgDn scroll · ^L lens');
    // A message chosen keeps its keys; the row above the line still says Enter.
    const choosing = screen(view({ top: 0, enterLatest: true, compose: replying, replying: true, choosing: true, chosen: true, selected: STREAM[0].key }), 120, 14);
    assert.equal(choosing.at(-4), '  ↓ 2 newer below · Enter for the latest');
    assert.equal(choosing.at(-1), ' Tab ↑ earlier · ↓ later · 1 👍 · 2 👎 · 3 👀 · Esc the latest');
    // At the latest, Enter is as it was.
    const latest = screen(view({ enterLatest: true }), 80, 14);
    assert.equal(latest.at(-4), '');
    assert.equal(latest.at(-1), ' Enter new thread · ↑↓ PgUp PgDn scroll · Tab complete @ / · Esc threads');
    // Where Enter does something else (the commands' line, the panel's keys), the tab doesn't say it goes there, and neither row does.
    const elsewhere = screen(view({ top: 0, compose: compose({ text: '/', cursor: 1, navigation: true, placeholder: 'Choose /status, /threads or /new' }) }), 80, 14);
    assert.equal(elsewhere.at(-4), '  ↓ 2 newer below');
    assert.equal(elsewhere.at(-1), ' Enter go · Tab complete · Esc cancel');
    assert.equal(screen(view({ top: 0, compose: undefined }), 80, 14).at(-2), '  ↓ 1 newer below', 'the threads’ panel, or no line');
  });

  it('leaves Enter out of the row about newer items where the stream is too narrow for it, rather than cut it', () => {
    const narrow = screen(view({ top: 0, enterLatest: true, compose: compose({ text: 'ok', cursor: 2 }) }), 48, 14);
    assert.match(narrow.at(-4)!, /^ {2}↓ \d+ newer below$/, 'never "Enter for the latest" for a line that Enter would send');
    assert.match(screen(view({ top: 0, enterLatest: true }), 48, 14).at(-4)!, /^ {2}↓ \d+ newer below · Enter for the latest$/);
    assert.match(screen(view({ top: 0, enterLatest: true }), 30, 14).at(-4)!, /^ {2}↓ \d+ newer below$/);
  });

  it('cuts the keys to the width, and fits every size with the line and its cursor kept', () => {
    const narrow = screen(view(), 48, 20);
    assert.equal(narrow.at(-1), ' Enter  ↑↓ PgUp PgDn  Tab  Esc');
    for (const [cols, rows] of [[120, 30], [80, 24], [48, 12], [40, 9], [30, 6], [20, 3], [10, 1]]) {
      const frame = renderChat(view({ compose: compose({ text: 'looks good', cursor: 10 }) }), cols, rows);
      assert.equal(frame.rows.length, rows, `${cols}×${rows}`);
      assert.ok(frame.plain.every((l) => columns(l) <= cols), `${cols}×${rows}`);
      if (frame.cursor) assert.ok(frame.cursor.y >= 0 && frame.cursor.y < rows && frame.cursor.x < cols, `${cols}×${rows}`);
      if (rows >= 2) assert.ok(frame.plain.some((l) => l.startsWith(' › looks good')), `${cols}×${rows}: the line stays`);
    }
    assert.equal(chatGeometry(80, 9).gap, false, 'no blank row under ten rows');
  });

  it('says what it is waiting for, or why it can’t show, in the stream’s place', () => {
    const reading = screen(view({ items: [], status: { text: 'Reading the board…' }, compose: undefined }), 80, 12);
    assert.equal(reading[0], '  Reading the board…');
    assert.equal(reading.at(-1), ' ↑↓ PgUp PgDn scroll · Esc threads');
    const empty = screen(view({ items: [], status: { text: 'No conversations on the board yet.', hint: 'What you type below starts a thread.' } }), 80, 12);
    assert.deepEqual(empty.slice(0, 2), ['  No conversations on the board yet.', '  What you type below starts a thread.']);
    const failed = renderChat(view({ items: [], status: { text: 'The board could not be read: \u001b[2Jgone', tone: 'alert' }, compose: undefined }), 80, 12);
    assert.ok(!failed.plain[0].includes('\u001b'), 'a refusal from the board is drawn safe too');
  });

  it('says the keys of answering, of a message chosen, and Esc back to the latest from one', () => {
    const replying = compose({ placeholder: 'Reply to Claude…', status: { text: 'to T19 Stopped agents leave the strip, the latest · Claude hears it', tone: 'normal' } });
    assert.equal(screen(view({ compose: replying, replying: true }), 120, 14).at(-1), ' Enter send · @ new thread · > elsewhere · Tab an earlier one · Esc threads · ↑↓ PgUp PgDn scroll');
    assert.equal(screen(view({ compose: replying, replying: true }), 80, 14).at(-1), ' Enter send · @ new thread · > elsewhere · Tab an earlier one · Esc threads', 'scrolling goes first');
    assert.equal(screen(view({ compose: replying, replying: true }), 40, 14).at(-1), ' Enter  @  >  Tab  Esc', 'then the words');
    assert.equal(screen(view({ compose: { ...replying, text: 'ok', cursor: 2 }, replying: true }), 80, 14).at(-1), ' Enter send · ↑↓ PgUp PgDn scroll · Tab complete · Esc clear');
    const choosing = screen(view({ compose: replying, replying: true, choosing: true, chosen: true, selected: STREAM[3].key }), 120, 14);
    assert.equal(choosing.at(-1), ' Tab ↑ earlier · ↓ later · 1 👍 · 2 👎 · 3 👀 · Esc the latest');
    assert.ok(choosing.includes("❯ Claude  agent · in Pick up Codex's work · 2 min ago"), choosing.join('\n'));
    assert.equal(screen(view({ chosen: true }), 120, 14).at(-1), ' Enter new thread · ↑↓ PgUp PgDn scroll · Tab complete @ / · Esc the latest · ^L lens', 'a new thread asked for');
  });

  it('shows an item on its way as sending, and says which items show down to their last line', () => {
    const latest = renderChat(view({ sending: [STREAM[5].key] }), 120, 14);
    assert.ok(latest.plain.some((l) => l.trimEnd() === '  Claude  agent · on T19 Stopped agents leave the strip, about “the strip after a stop” · sending…'), latest.plain.join('\n'));
    assert.deepEqual(latest.seen, STREAM.slice(1).map((i) => i.key), 'the first is cut above');
    const top = renderChat(view({ top: 0 }), 80, 14);
    assert.ok(top.seen.includes(STREAM[0].key));
    assert.ok(!top.seen.includes(STREAM[5].key), 'the latest is below');
    assert.deepEqual(renderChat(view({ items: [], status: { text: 'Reading the board…' } }), 80, 14).seen, []);
  });

  it('puts what waits on the person elsewhere at the right of the keys', () => {
    const rows = screen(view({ notice: '1 waiting for your OK: /status' }), 120, 12);
    assert.match(rows.at(-1)!, /^ Enter new thread · .* {2,}1 waiting for your OK: \/status$/);
  });
});

// The backgrounds a painted row is drawn on, part by part (none: the
// terminal's own), and the end of the row's reset left out.
const backgrounds = (row: string): string[] =>
  [...row.replace(/\x1b\[0m(?:\x1b\[K)?$/, '').matchAll(/\x1b\[([0-9;]*)m/g)].map(([, sgr]) => /(?:^|;)(48;(?:5;\d+|2;\d+;\d+;\d+))$/.exec(sgr)?.[1] ?? '');
const DARK: Rgb = [30, 30, 30];
const LIGHT: Rgb = [255, 255, 255];
const at = (place: ChatPlace) => item(sam, 'Hi', MIN, place);
const thread = (id: string): ChatPlace => ({ kind: 'thread', id, title: id });

describe('the chat’s looks', () => {
  it('puts the line and the rows with it on one band across the window, the cursor where it was, and the keys under it plain', () => {
    for (const light of [false, true]) {
      const typed = compose({ text: '@Cl', cursor: 3, choices: [{ label: '@Claude' }, { label: '@Codex' }], at: 0, status: { text: 'to T19 Stopped agents leave the strip, the latest · Claude hears it', tone: 'normal' } });
      const frame = renderChat(view({ compose: typed }), 80, 14, light);
      const band = frame.rows.slice(-4, -1);
      assert.deepEqual(frame.plain.slice(-4, -1).map((l) => l.trimEnd()), [' Tab @Claude  @Codex', ' › @Cl', ' to T19 Stopped agents leave the strip, the latest · Claude hears it']);
      for (const [i, row] of band.entries()) {
        assert.ok(backgrounds(row).length && backgrounds(row).every((bg) => bg === bandOf(light)), `${light}, row ${i}: every part on the band`);
        assert.equal(columns(frame.plain.at(-4 + i)!), 80, 'across the window');
      }
      assert.ok(band[0].includes(`\x1b[0;1;${bandOf(light)}m@Claude`), 'the one Tab writes next stays bold');
      assert.ok(band[1].includes(`\x1b[0;1;${bandOf(light)}m › `), 'the prompt bold');
      assert.ok(band[2].includes(`\x1b[0;2;${bandOf(light)}m to T19`), 'who hears it dim');
      assert.deepEqual(frame.cursor, { x: 6, y: 11 }, 'the cursor after what is typed');
      assert.deepEqual(backgrounds(frame.rows.at(-1)!).filter(Boolean), [], 'the keys on the terminal’s own background');
      const empty = renderChat(view(), 80, 14, light).rows.at(-3)!;
      assert.ok(empty.includes(`\x1b[0;2;${bandOf(light)}mWhat do you want to work through?`), 'the placeholder dim on the band');
    }
    assert.notEqual(bandOf(false), '48;5;236', 'not the strip’s bar');
    assert.notEqual(bandOf(true), '48;5;254', 'not the strip’s bar');
  });

  it('says who is working on a row above the line, its spinner turning each second, and gives the row back once no one is (T38)', () => {
    const working = [{ name: 'Claude', words: 'Running the tests', lasted: '12 s' }, { name: 'Codex', words: 'Editing src/cli/switcher/tabView.ts' }];
    const busy = (now: number, cols = 100) => renderChat(view({ compose: compose({ working }), now }), cols, 14).plain.map((l) => l.trimEnd());
    const frame = busy(NOW - (NOW % 4000));
    assert.equal(frame.at(-4), ' ✻ Claude: Running the tests · 12 s  ·  Codex: Editing src/cli/switcher/tabView.ts');
    assert.equal(frame.at(-3), ' › What do you want to work through?', 'the line under it');
    assert.equal(busy(NOW - (NOW % 4000) + 1000).at(-4)!.slice(0, 3), ' ✳ ', 'the next turn a second on');
    const narrow = busy(NOW, 50).at(-4)!;
    assert.ok(columns(narrow) <= 49 && narrow.includes('Claude') && narrow.includes('Codex'), 'every name while it can: ' + narrow);
    const idle = renderChat(view({ compose: compose() }), 100, 14);
    assert.equal(idle.plain.at(-3)!.trimEnd(), ' › What do you want to work through?');
    assert.equal(renderChat(view({ compose: compose({ working }) }), 100, 14).plain.length, idle.plain.length, 'the same height: the row is the stream’s');
  });

  it('lists a / with a row per choice and what it does, as Claude Code does, scrolled so the next one shows', () => {
    const choices = [
      { label: '/status', note: 'Tricot command', description: 'Agents, approvals and board activity' },
      { label: '/threads', note: 'Tricot command', description: 'Browse conversations' },
      { label: '/review', note: 'Claude', description: 'Review the working tree' },
    ];
    const typed = (at: number, list: { label: string; note?: string; description: string }[] = choices) => compose({ text: '/', cursor: 1, choices: list, at, status: { text: 'Navigate in Tricot; no message is sent.', tone: 'normal' } });
    assert.deepEqual(renderChat(view({ compose: typed(1) }), 80, 24).plain.slice(-6, -2).map((l) => l.trimEnd()), [
      '   /status   Agents, approvals and board activity · Tricot command',
      ' ❯ /threads  Browse conversations · Tricot command',
      '   /review   Review the working tree · Claude',
      ' › /',
    ]);
    const many = Array.from({ length: 9 }, (_, i) => ({ label: `/s${i}`, description: `Skill ${i}` }));
    const listed = renderChat(view({ compose: typed(7, many) }), 80, 24).plain.slice(-9, -3).map((l) => l.trimEnd());
    assert.deepEqual(listed, [' ↑ /s2  Skill 2', '   /s3  Skill 3', '   /s4  Skill 4', '   /s5  Skill 5', '   /s6  Skill 6', ' ❯ /s7  Skill 7'], 'six rows at most, the one Tab is on in view');
    assert.equal(renderChat(view({ compose: typed(0, many) }), 80, 12).plain.slice(-6, -3).length, 3, 'fewer in a short window');
  });

  it('draws each item on its tint across the stream, its words keeping their looks, and what the stream says on the terminal’s own background', () => {
    const frame = renderChat(view(), 120, 14, false, DARK);
    const stream = frame.rows.slice(0, 10);
    for (const [i, row] of stream.entries()) {
      const shades = new Set(backgrounds(row));
      assert.equal(shades.size, 1, `row ${i}: one tint for the whole row`);
      assert.match([...shades][0], /^48;2;\d+;\d+;\d+$/, `row ${i}`);
      assert.equal(columns(frame.plain[i]), 120, `row ${i}: across the stream`);
    }
    assert.match(stream[1], /\x1b\[0;1;48;2;[\d;]+mCodex\x1b\[0;2;48;2;[\d;]+m {2}agent · /, 'who wrote it bold, "agent" dim');
    assert.equal(backgrounds(frame.rows[10]).filter(Boolean).length, 0, 'the blank row before the line is plain');
    const scrolled = renderChat(view({ top: 0 }), 80, 14, false, DARK);
    assert.match(scrolled.plain.at(-4)!, /newer below/);
    assert.equal(backgrounds(scrolled.rows.at(-4)!).filter(Boolean).length, 0, 'the row about newer items is plain');
    const reading = renderChat(view({ items: [], status: { text: 'Reading the board…' }, compose: undefined }), 80, 12, false, DARK);
    assert.ok(reading.rows.every((row) => !backgrounds(row).some(Boolean)), 'what it says in the stream’s place is plain');
  });

  it('gives neighbours of one conversation one band, and those of different ones different tints', () => {
    const T17_PIN: ChatPlace = { ...T17, pin: { id: 'p9', quote: '“a part”' } };
    const items = [at(T17), at(T17_PIN), at(D7), at(THREAD), at(DESIGN), at(BOARD_PIN), at({ kind: 'board', pin: { id: 'p3', quote: '“another part”' } }), at(T19_PIN)];
    const tints = chatTints(items, false, DARK);
    assert.equal(tints[0], tints[1], 'a comment on a part of a card is in the card’s discussion');
    for (let i = 2; i < items.length; i++) assert.notEqual(tints[i], tints[i - 1], `item ${i}: a thread, a card, and each pin on the board context are conversations of their own`);
    // Drawn: one band over both items, with nothing between.
    const frame = renderChat(view({ items: [item(codex, 'One', 3 * MIN, T17), item(me, 'Two', 2 * MIN, T17), item(sam, 'Three', MIN, D7)], top: 0 }), 80, 14, false, DARK);
    const shade = (y: number) => backgrounds(frame.rows[y])[0];
    assert.deepEqual([0, 1, 2, 3].map(shade), Array(4).fill(tints[0]));
    assert.notEqual(shade(4), shade(3), 'the next conversation on its own');
  });

  it('keeps a conversation’s tint where it shows again, and never gives two neighbours of different conversations one tint', () => {
    // Two conversations whose own hue is the same, found among many.
    const own = (place: ChatPlace) => chatTints([at(place)], false, DARK)[0];
    const places = Array.from({ length: 40 }, (_, i) => thread(`t${i}`));
    const twin = places.findIndex((p, i) => i > 0 && own(p) === own(places[0]));
    assert.ok(twin > 0, 'two of forty share a hue');
    const [a, b] = [places[0], places[twin]];
    const clash = chatTints([at(a), at(b), at(a)], false, DARK);
    assert.notEqual(clash[1], clash[0], 'the second takes another hue');
    assert.notEqual(clash[2], clash[1]);
    const other = places.find((p) => own(p) !== own(a))!;
    const apart = chatTints([at(a), at(other), at(a), at(other)], false, DARK);
    assert.equal(apart[0], apart[2], 'the same tint where it shows again');
    assert.equal(apart[1], apart[3]);
    assert.equal(apart[0], own(a), 'its own');
    // Over a long stream, in both looks, on both paths.
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % 12;
    const long = Array.from({ length: 300 }, () => at(places[next()]));
    for (const [light, from] of [[false, DARK], [true, LIGHT], [false, undefined], [true, undefined]] as const) {
      const tints = chatTints(long, light, from);
      for (let i = 1; i < long.length; i++) {
        const same = long[i].place === long[i - 1].place;
        assert.equal(tints[i] === tints[i - 1], same, `${light} ${from}: item ${i}`);
      }
    }
  });

  it('leans each tint a few percent from the background toward its hue, dark and light, where 24-bit colour is drawn', () => {
    const items = Array.from({ length: 6 }, (_, i) => at(thread(`c${i}`)));
    for (const [background, most] of [[DARK, 0.1], [[40, 44, 52], 0.1], [LIGHT, 0.08], [[253, 246, 227], 0.08]] as [Rgb, number][]) {
      const light = background[0] > 128;
      const tints = chatTints(items, light, background);
      for (const tint of tints) {
        const rgb = /^48;2;(\d+);(\d+);(\d+)$/.exec(tint)!.slice(1).map(Number);
        assert.ok(rgb.some((c, i) => c !== background[i]), `${tint}: off the background`);
        assert.ok(rgb.every((c, i) => Math.abs(c - background[i]) <= 255 * most && c >= 0 && c <= 255), `${tint}: within ${most * 100}% of ${background}`);
      }
      assert.ok(new Set(tints).size > 1, 'hues of their own');
    }
    assert.notDeepEqual(chatTints(items, false, DARK), chatTints(items, false, [40, 44, 52]), 'from the background given');
  });

  it('takes two greys in turns at each change of conversation without 24-bit colour', () => {
    const items = [at(T17), at(T17), at(D7), at(THREAD), at(T17), at(BOARD_PIN)];
    for (const light of [false, true]) {
      const tints = chatTints(items, light);
      const [one, two] = tints;
      assert.match(one, /^48;5;\d+$/);
      const other = tints[2];
      assert.notEqual(other, one);
      assert.deepEqual(tints, [one, two, other, one, other, one], `${light}`);
      assert.equal(one, two);
      assert.ok(!tints.includes(bandOf(light)), 'neither is the line’s band');
    }
    const frame = renderChat(view(), 120, 14);
    assert.ok(frame.rows.slice(0, 10).every((row) => backgrounds(row).length && backgrounds(row).every((bg) => /^48;5;\d+$/.test(bg))), 'drawn so where no background is given');
  });
});

// The stream as each frame drew it before frames laid out only what they
// show (T27): every item laid out, the first line shown counted from the
// oldest. Kept here as the reference the frame drawn now must match: its
// stream's rows, the items under them, and those shown down to their last line.
function wholeStream(view: ChatViewData, cols: number, body: number, light: boolean, tintFrom?: Rgb) {
  const { lines, starts } = chatLines(view.items, cols, view.me, view.now, new Set(view.sending), view.selected, view.only === undefined);
  const top = view.top as number | 'end';
  const at = Math.min(top === 'end' ? Infinity : top, Math.max(0, lines.length - body));
  const tints = chatTints(view.items, light, tintFrom);
  const rows: string[] = [];
  let item = 0;
  for (let n = at; n < Math.min(lines.length, at + body); n++) {
    while (item + 1 < starts.length && starts[item + 1] <= n) item++;
    rows.push(paint(onBand(lines[n], tints[item], cols), cols).line);
  }
  const seen = view.items.filter((_, i) => {
    const end = (starts[i + 1] ?? lines.length) - 1;
    return end >= at && end < at + body;
  });
  return { rows, seen: seen.map((i) => i.key), below: starts.filter((start) => start >= at + body).length, scrolled: at + body < lines.length, starts, total: lines.length };
}

// The anchor for the line `n` of the stream, counted from the oldest.
function anchorAt(items: ChatItem[], starts: number[], n: number): ChatAnchor {
  let index = 0;
  while (index + 1 < starts.length && starts[index + 1] <= n) index++;
  return { key: items[index].key, line: n - starts[index], index };
}

// A stream of `count` items, of every kind and length, from `seed`.
function made(count: number, seed: number): ChatItem[] {
  let state = seed;
  const next = (n: number) => ((state = (Math.imul(state, 1103515245) + 12345) >>> 0) >>> 16) % n;
  const words = 'the retry policy should wrap every outbound call so that we keep behaviour at existing call sites while the backoff stays bounded and visible'.split(' ');
  const authors = [me, claude, codex, sam];
  const places = [T17, D7, THREAD, DESIGN, T19_PIN, BOARD_PIN];
  return Array.from({ length: count }, (_, i) => {
    const body = Array.from({ length: 1 + next(60) }, () => words[next(words.length)]).join(' ');
    const extra = ['', '\n\n- a point\n- and another, longer, about what it costs and what it saves', '\n```\nconst x = 1;\n```', ` ${'w'.repeat(70)}`][next(4)];
    const reactions = next(4) ? undefined : [{ emoji: '👍' as const, by: authors[next(4)], at: ago(MIN) }];
    return item(authors[next(4)], body + extra, (count - i) * MIN * 7, places[next(6)], reactions && { reactions });
  });
}

describe('the chat’s stream, laid out only as it shows', () => {
  it('draws the frame the whole stream laid out drew, for boards, windows and scroll positions of every kind, its tints and counts included', () => {
    for (const [count, seed] of [[0, 1], [1, 2], [2, 3], [7, 4], [40, 5], [40, 6]]) {
      const items = made(count, seed);
      const layout = new ChatLayout(); // kept from frame to frame, as the tab keeps it
      for (const cols of [12, 30, 48, 80, 120]) {
        for (const rows of [6, 9, 14, 24]) {
          for (const only of [undefined, 'Picker spacing']) {
            const light = (cols + rows) % 2 === 1;
            const tintFrom = rows === 9 ? undefined : light ? LIGHT : DARK;
            const extra = items.length > 2 ? { sending: [items.at(-1)!.key], selected: items[Math.floor(items.length / 2)].key } : {};
            const base = view({ items, ...extra, ...(only && { only }) });
            const { body } = chatGeometry(cols, rows, 1 + Number(rows >= 8), { only: only !== undefined });
            const { total, starts } = wholeStream(base, cols, body, light, tintFrom);
            const tops = [...new Set(['end' as const, 0, 1, Math.floor(total / 3), Math.floor(total / 2), total - body - 1, total - body, total - 1, total + 4].filter((top) => top === 'end' || top >= 0))];
            for (const top of tops) {
              const want = wholeStream({ ...base, top }, cols, body, light, tintFrom);
              const anchored = typeof top === 'number' && top < total ? [anchorAt(items, starts, top)] : [];
              for (const [shown, shared] of [top, ...anchored].flatMap((t) => [[t, layout] as const, [t, undefined] as const])) {
                const name = `${count} items, ${cols}×${rows}${only ? ', one thread' : ''}, top ${JSON.stringify(shown)}${shared ? ', kept' : ''}`;
                const frame = renderChat({ ...base, top: shown, ...(shared && { layout: shared }) }, cols, rows, light, tintFrom);
                const from = Number(only !== undefined);
                assert.deepEqual(frame.rows.slice(from, from + want.rows.length), want.rows, `${name}: the rows`);
                assert.ok(frame.plain.slice(from + want.rows.length, from + body).every((row) => !row.trim()), `${name}: blank under the last`);
                assert.deepEqual(frame.seen, want.seen, `${name}: seen`);
                const newer = want.scrolled ? paint([[`  ↓ ${want.below ? `${want.below} newer` : 'more'} below`, DIM]], cols).plain : paint([], cols).plain;
                if (rows >= 10) assert.equal(frame.plain[from + body], newer, `${name}: below`);
              }
            }
          }
        }
      }
    }
  });

  it('keeps what shows where it is while scrolled up, as newer items come and older ones change', () => {
    const items = made(30, 9);
    const { starts } = wholeStream(view({ items }), 80, 10, false);
    const top = anchorAt(items, starts, starts[12] + 1);
    const layout = new ChatLayout();
    const before = renderChat(view({ items, top, layout }), 80, 14);
    const newer = [...items, item(sam, 'Something new.', 0, D7), item(claude, 'And more.', 0, THREAD)];
    const older = newer.map((it, i) => (i < 5 ? { ...it, body: `${it.body}\nEdited.`, reactions: [{ emoji: '👀' as const, by: sam, at: ago(0) }] } : it));
    for (const list of [newer, older, older.slice(3)]) {
      const after = renderChat(view({ items: list, top, layout }), 80, 14);
      assert.deepEqual(after.plain.slice(0, 10), before.plain.slice(0, 10), 'the same rows');
      assert.deepEqual(after.seen, before.seen);
    }
    const below = (frame: ReturnType<typeof renderChat>) => Number(/↓ (\d+) newer below/.exec(frame.plain[10])?.[1]);
    assert.equal(below(renderChat(view({ items: newer, top, layout }), 80, 14)), below(before) + 2, 'and two more below');
    const gone = renderChat(view({ items: items.filter((it) => it.key !== top.key), top, layout }), 80, 14);
    assert.equal(gone.plain[0].trimEnd(), plain([items[13]], 80)[0], 'the item it was kept by gone: from where it was');
  });

  it('lays out only the items that show, and those it scrolls over', () => {
    const items = made(200, 11);
    const touched = new Set<number>();
    const watched = items.map((it, i) => {
      const { body, ...rest } = it;
      return Object.defineProperty({ ...rest }, 'body', { enumerable: true, get: () => (touched.add(i), body) }) as ChatItem;
    });
    const layout = new ChatLayout();
    const drawn = (top: ChatViewData['top']) => {
      touched.clear();
      const rows = screen(view({ items: watched, top, layout }), 80, 14);
      return { rows, touched: [...touched] };
    };
    const latest = drawn('end');
    assert.deepEqual(latest.rows, screen(view({ items }), 80, 14), 'as the whole stream draws it');
    assert.ok(latest.touched.length > 0 && latest.touched.every((i) => i >= items.length - 10), `${latest.touched}`);
    const oldest = drawn(0);
    assert.ok(oldest.touched.every((i) => i < 10 || i >= items.length - 10), `the oldest, and the latest to know where the end is: ${oldest.touched}`);
  });

  it('keeps each item’s lines until something they show changes', () => {
    const items = made(20, 12);
    const layout = new ChatLayout();
    const lines = (list: ChatItem[], width = 80, now = NOW, selected?: string, sending?: string) => layout.lines(list, width, 'Wassim', now, new Set(sending ? [sending] : []), selected).of(list.length - 1);
    const kept = lines(items);
    assert.equal(lines(items), kept, 'drawn again: the same lines');
    assert.equal(lines([...items.slice(0, -1), { ...items.at(-1)! }]), kept, 'read from the board again, unchanged');
    assert.equal(lines(items, 80, NOW + 5_000), kept, 'its time says the same');
    const last = items.at(-1)!;
    const changes: [string, ChatItem[], number?, number?, string?, string?][] = [
      ['a reaction', [...items.slice(0, -1), { ...last, reactions: [{ emoji: '👀', by: sam, at: ago(0) }] }]],
      ['an edit', [...items.slice(0, -1), { ...last, body: 'Edited.' }]],
      ['the place renamed', [...items.slice(0, -1), { ...last, place: { ...THREAD, title: 'Renamed' } }]],
      ['another width', items, 79],
      ['its time', items, 80, NOW + 60 * MIN],
      ['chosen', items, 80, NOW, last.key],
      ['on its way', items, 80, NOW, undefined, last.key],
    ];
    for (const [name, list, width, now, selected, sending] of changes) {
      const before = lines(items);
      const fresh = lines(list, width, now, selected, sending);
      assert.notEqual(fresh, before, name);
      assert.deepEqual(fresh, new ChatLayout().lines(list, width ?? 80, 'Wassim', now ?? NOW, new Set(sending ? [sending] : []), selected).of(list.length - 1), `${name}: as laid out afresh`);
    }
  });

  it('says when each item whose head shows was written, for the tab to tell when a time it says would change', () => {
    const frame = renderChat(view({ sending: [STREAM[5].key] }), 120, 14);
    assert.deepEqual(frame.times, STREAM.slice(2, 5).map((it) => it.at), 'not the first, cut above, nor one on its way');
    assert.deepEqual(renderChat(view({ items: [], status: { text: 'Reading the board…' } }), 80, 14).times, []);
  });
});

// T36 (#11): a click on a link in the Tricot tab opens it, so the frame says where each is.
describe('links in the chat', () => {
  it('finds the web addresses in a text, without the punctuation after one or a bracket around it', () => {
    const urls = (text: string) => webAddresses(text).map((l) => l.url);
    assert.deepEqual(urls('See https://example.com/a?b=1, or http://127.0.0.1:4545.'), ['https://example.com/a?b=1', 'http://127.0.0.1:4545']);
    assert.deepEqual(urls('(at https://example.com/x) and [docs](https://en.wikipedia.org/wiki/Knit_(fabric))'), ['https://example.com/x', 'https://en.wikipedia.org/wiki/Knit_(fabric)']);
    assert.deepEqual(urls('file:///etc/passwd javascript:alert(1) https:// ftp://x.org'), [], 'web addresses alone, and whole ones');
  });

  it('draws a link underlined and says where it is, an address cut onto two rows going to the whole of it on each', () => {
    const url = 'https://example.com/a/very/long/path/that/wraps';
    const rows = messageRows(`Read ${url} first`, undefined, 30, 'Sam');
    const frame = rows.map((row) => paint(row, 30));
    assert.deepEqual(frame.map((r) => r.plain.trimEnd()), ['    Read', '    https://example.com/a/ver', '    y/long/path/that/wraps', '    first']);
    assert.deepEqual(frame.map((r) => r.links), [[], [{ from: 4, to: 29, url }], [{ from: 4, to: 26, url }], []]);
    assert.ok(frame[1].line.includes('\x1b[0;4mhttps://'), 'underlined');
    const tab = { rows: frame.map((r) => r.line), plain: frame.map((r) => r.plain), links: frame.map((r) => r.links) };
    assert.equal(linkAt(tab, 10, 2), url);
    assert.equal(linkAt(tab, 3, 1), undefined, 'beside it, nothing');
    assert.equal(linkAt(tab, 5, 0), undefined);
  });

  it('links the cards a message names to their pages, and leaves a number the board hasn’t, or one inside an address, as text', () => {
    const card = (kind: 'task' | 'decision', number: number) => (number === 36 ? `#/b/b1/${kind === 'task' ? 't' : 'd'}/x${number}` : undefined);
    const [row] = messageRows('See T36, #36 and T7 at https://x.org/T36', undefined, 80, 'Sam', card);
    assert.deepEqual(paint(row, 80).links, [
      { from: 8, to: 11, url: '#/b/b1/t/x36' },
      { from: 13, to: 16, url: '#/b/b1/d/x36' },
      { from: 27, to: 44, url: 'https://x.org/T36' },
    ]);
  });

  it('keeps a link on the stream’s tint', () => {
    const [row] = onBand([['go ', undefined], ['https://x.org', undefined, 'https://x.org']], '48;5;237', 20);
    assert.deepEqual(row, ['go ', '48;5;237']);
    assert.deepEqual(paint(onBand([['go '], ['https://x.org', undefined, 'https://x.org']], '48;5;237', 20), 20).links, [{ from: 3, to: 16, url: 'https://x.org' }]);
  });
});
