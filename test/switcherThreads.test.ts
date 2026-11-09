import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/core/store';
import { emptyCanvas } from '../src/core/canvas';
import { routes, routeUrl } from '../src/core/routes';
import type { AgentSkills } from '../src/core/skills';
import { setReaction, type Emoji } from '../src/core/reactions';
import type { Actor, Board, Comment, Decision, Pin, Task, Thread, ThreadLens, ThreadMessage } from '../src/core/types';
import type { Answers } from '../src/cli/switcher/answers';
import { watchBoard, type LiveFeed } from '../src/cli/switcher/live';
import { columns, type BoardLive } from '../src/cli/switcher/strip';
import { HOST_KEY_HEADER, holdAnswers } from '../src/cli/switcher/answers';
import { skillsReader, threadsReader } from '../src/cli/switcher/threadsRead';
import { TabKeyReader } from '../src/cli/switcher/tabKeys';
import { threadsAccess, threadsSender, type CommentOn, type CommentSent, type ThreadChanged, type ThreadReacted, type ThreadSent } from '../src/cli/switcher/threadsSend';
import { bandOf, panelGeometry, WIDE_FROM } from '../src/cli/switcher/threadsView';
import { chatGeometry, chatLines } from '../src/cli/switcher/chatView';
import { chatStream } from '../src/core/chatStream';
import { TricotTab, type AddChoice, type TabAgent, type TabHost } from '../src/cli/switcher/tricotTab';
import { createApp } from '../src/server/app';
import { LENS_BRIEF_LIMIT, LENS_NAME_LIMIT, THREAD_TEXT_LIMIT } from '../src/core/threads';
import { removeScratch } from './platform';

// The board's threads in the Tricot tab: "t" (or /threads) opens their panel
// beside the chat's stream, or over it in a narrow window; the list is the
// page's (waiting on you first, the quiet finished ones under Earlier); a
// thread picked from it narrows the stream to its messages, scrolled to the
// latest, with the line answering it; and both follow the board as its
// stream says things changed. The tab is a stand-in host with a board's
// threads that a test changes; the last tests run it against a real board
// and its stream.

const NOW = Date.parse('2026-11-04T15:00:00Z');
// The looks the tab draws with: bold, dim and the alert colour, the band the
// line to type on sits on, and the greys the stream's items take turns on
// where 24-bit colour isn't drawn (chatView.ts chatTints).
const BAND = bandOf(false);
const LOOKS = new RegExp(`^\\x1b\\[(?:0|0;1|0;2|0;1;38;5;214|0;38;5;214)(?:;(?:${BAND}|48;5;234|48;5;235))?m$`);
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const me: Actor = { kind: 'human', name: 'Wassim' };
const claude: Actor = { kind: 'agent', name: 'Claude' };

let counter = 0;
const message = (author: Actor, body: string, msAgo: number): ThreadMessage => ({ id: `m${++counter}`, author, body, at: ago(msAgo) });
const thread = (id: string, title: string, messages: ThreadMessage[], more: Partial<Thread> = {}): Thread => ({ id, title, startedBy: messages[0].author, startedAt: messages[0].at, updatedAt: messages.at(-1)!.at, messages, ...more });
// A thread the person began and an agent answered, `msAgo` ago.
const answered = (id: string, title: string, msAgo: number, more: Partial<Thread> = {}) => thread(id, title, [message(me, `${title}?`, msAgo + 1_000), message(claude, `About ${title}.`, msAgo)], more);

// A list row as drawn at `cols` columns: `left`, and when it was last active at the right edge.
const row = (left: string, when: string, cols = 80) => left.padEnd(cols - 1 - when.length) + when;
// A row of a window with the panel beside the stream: the stream's side and the panel's, each without the spaces after it.
const sides = (line: string): [string, string] => {
  const at = line.indexOf('│');
  return at < 0 ? [line.trimEnd(), ''] : [line.slice(0, at).trimEnd(), line.slice(at + 1).trimEnd()];
};
// The row that says the stream shows one thread alone.
const only = (title: string) => `  Only ${title} · Esc for everything`;
// The panel's keys, while it has them.
const PANEL_KEYS = ' ↑↓ pick · Enter read · n new · x delete · Esc close · l lens';
const shows = (screen: string[], row: string) => assert.ok(screen.some((l) => l.trimEnd() === row), `no row ${JSON.stringify(row)} in:\n${screen.join('\n')}`);
const lacks = (screen: string[], text: string) => assert.ok(!screen.some((l) => l.includes(text)), `unexpected ${JSON.stringify(text)} in:\n${screen.join('\n')}`);

// The board the threads are on: its people and agents as its activity names them, and its tasks.
const sam: Actor = { kind: 'human', name: 'Sam' };
function boardOf(threads: Thread[], more: { tasks?: Task[]; decisions?: Decision[]; pins?: Pin[]; actors?: Actor[] } = {}): Board {
  const actors = [me, claude, ...(more.actors ?? [])].map((actor) => ({ actor, at: ago(0) }));
  return { id: 'roadmap-1', title: 'Roadmap', threads, decisions: more.decisions ?? [], tasks: more.tasks ?? [], canvas: { ...emptyCanvas(), pins: more.pins ?? [] }, activity: { actors, done: {}, reviewSentAt: {} } } as unknown as Board;
}

interface Stand {
  tab: TricotTab;
  threads: Thread[];
  more: Parameters<typeof boardOf>[1]; // what else is on the board
  reads: number;
  failing?: string; // the board's answer to a read, when it is not the threads
  quits: number;
  opened: number; // how many times the board was opened in the browser
  choices: AddChoice[]; // the agents the tab can add
  added: string[]; // and those it asked the host to start, by id
  stopped: number[]; // the agents it asked the host to stop, by number
  seatAsked: number; // how many times this terminal asked to be let in
  agents: TabAgent[]; // those this terminal runs
  skills: AgentSkills[]; // what the board says each agent can be asked to run
  sent: { kind: 'start' | 'reply' | 'lens' | 'react' | 'remove' | 'restore' | 'comment' | 'reactToComment'; thread?: string; on?: CommentOn; text?: string; lens?: ThreadLens | null; message?: string; emoji?: Emoji; remove?: boolean }[]; // what the tab sent the board
  refusing?: { error: string; needsSeat?: boolean }; // the board's answer to what is sent, when it is a refusal
  gate?: Promise<void>; // what is sent waits on it
  live: BoardLive | undefined;
  now: number; // the host's clock
  type(text: string): void;
  change(threads: Thread[]): void; // the board's threads changed, and its stream says so
  screen(cols?: number, rows?: number): string[];
  settle(): Promise<void>;
  open(cols?: number, rows?: number): Promise<void>; // t, and the first read
}

function stand(threads: Thread[], more: { threads?: boolean; chat?: boolean; wordmark?: 'whole' } = {}): Stand {
  const s = { threads, more: {}, reads: 0, quits: 0, opened: 0, choices: [] as AddChoice[], added: [] as string[], stopped: [] as number[], seatAsked: 0, skills: [] as AgentSkills[], sent: [] as Stand['sent'], now: NOW } as Stand;
  s.live = { board: 'roadmap-1', steps: [], approvals: [], presence: [{ name: 'Claude', lastSeen: ago(0), state: 'listening' }], title: 'Roadmap', activity: [], chatVer: 1 };
  s.agents = [{ number: 1, name: 'Claude', state: 'running', lastOutput: NOW }];
  const host: TabHost = {
    agents: () => s.agents,
    live: () => s.live,
    now: () => s.now,
    changed: () => {},
    open: () => void s.opened++,
    quit: () => void s.quits++,
    choices: () => s.choices,
    add: (id) => void s.added.push(id),
    stop: (n) => void s.stopped.push(n),
  };
  // The board takes a message as the real one does: it is in its thread, and the stream says so.
  const take = async (kind: 'start' | 'reply', text: string, id?: string, lens?: ThreadLens): Promise<ThreadSent> => {
    s.sent.push({ kind, ...(id && { thread: id }), text, ...(lens && { lens }) });
    await s.gate;
    if (s.refusing) return { ok: false, ...s.refusing };
    const written = message(me, text, 0);
    const made = kind === 'start' ? thread(`new-${s.sent.length}`, text, [written], lens && { lens }) : (s.threads.find((t) => t.id === id) as Thread);
    const next = kind === 'start' ? made : { ...made, messages: [...made.messages, written], updatedAt: written.at };
    s.change(kind === 'start' ? [...s.threads, next] : s.threads.map((t) => (t.id === id ? next : t)));
    return { ok: true, thread: next };
  };
  // The board sets a lens as the real one does: General (null) takes it off.
  const setLens = async (id: string, lens: ThreadLens | null): Promise<ThreadSent> => {
    s.sent.push({ kind: 'lens', thread: id, lens });
    await s.gate;
    if (s.refusing) return { ok: false, ...s.refusing };
    const { lens: _was, ...rest } = s.threads.find((t) => t.id === id) as Thread;
    const next: Thread = { ...rest, ...(lens && { lens }) };
    s.change(s.threads.map((t) => (t.id === id ? next : t)));
    return { ok: true, thread: next };
  };
  // And a reaction: the message as it is then, which the board keeps.
  const react = async (id: string, messageId: string, emoji: Emoji, remove: boolean): Promise<ThreadReacted> => {
    s.sent.push({ kind: 'react', thread: id, message: messageId, emoji, remove });
    await s.gate;
    if (s.refusing) return { ok: false, ...s.refusing };
    const held = s.threads.find((t) => t.id === id) as Thread;
    const item = { ...held.messages.find((m) => m.id === messageId)! };
    setReaction(item, emoji, me, !remove, ago(0));
    s.change(s.threads.map((t) => (t.id === id ? { ...t, messages: t.messages.map((m) => (m.id === messageId ? item : m)) } : t)));
    return { ok: true, message: item };
  };
  // And a comment, on a card or about a pinned part, as the real one keeps it:
  // a part pinned on a card's canvas in its discussion, carrying the pin; one
  // on the board context in the pin's own thread.
  const onCard = (on: CommentOn, change: (comments: Comment[], pin?: Pin) => Comment[]) => {
    const more = s.more ?? {};
    const cardPin = (card: Task | Decision) => (card as { canvas?: { pins: Pin[] } }).canvas?.pins.find((p) => p.id === on.id);
    const cards = <T extends Task | Decision>(list: T[] | undefined, kind: 'task' | 'decision') =>
      list?.map((card) => (on.kind === kind && card.id === on.id ? { ...card, comments: change(card.comments) } : on.kind === 'pin' && cardPin(card) ? { ...card, comments: change(card.comments, cardPin(card)) } : card));
    const pins = more.pins?.map((p) => (on.kind === 'pin' && p.id === on.id ? { ...p, discussion: { ...p.discussion, thread: change(p.discussion?.thread ?? []) } } : p));
    s.more = { ...more, tasks: cards(more.tasks, 'task'), decisions: cards(more.decisions, 'decision'), pins };
  };
  const comment = async (on: CommentOn, text: string): Promise<CommentSent> => {
    s.sent.push({ kind: 'comment', on, text });
    await s.gate;
    if (s.refusing) return { ok: false, ...s.refusing };
    let written: Comment = { id: `c${++counter}`, author: me, body: text, createdAt: ago(0) };
    onCard(on, (comments, pin) => {
      if (pin) written = { ...written, pin: { id: pin.id, quote: `“${pin.quote}”` } };
      return [...comments, written];
    });
    s.change(s.threads);
    return { ok: true, comment: written };
  };
  const reactToComment = async (on: CommentOn, commentId: string, emoji: Emoji, remove: boolean): Promise<CommentSent> => {
    s.sent.push({ kind: 'reactToComment', on, message: commentId, emoji, remove });
    await s.gate;
    if (s.refusing) return { ok: false, ...s.refusing };
    let reacted: Comment | undefined;
    onCard(on, (comments) =>
      comments.map((c) => {
        if (c.id !== commentId) return c;
        reacted = { ...c };
        setReaction(reacted, emoji, me, !remove, ago(0));
        return reacted;
      }),
    );
    s.change(s.threads);
    return reacted ? { ok: true, comment: reacted } : { ok: false, error: `No comment "${commentId}" there.` };
  };
  const read = async () => {
    s.reads++;
    return s.failing === undefined ? { ok: true as const, board: boardOf(s.threads, s.more) } : { ok: false as const, error: s.failing };
  };
  const deleted = new Map<string, Thread>();
  const change = async (id: string, restore: boolean): Promise<ThreadChanged> => {
    s.sent.push({ kind: restore ? 'restore' : 'remove', thread: id });
    await s.gate;
    if (s.refusing) return { ok: false, ...s.refusing };
    if (restore) s.change([...s.threads, deleted.get(id)!]);
    else {
      deleted.set(id, s.threads.find((t) => t.id === id)!);
      s.change(s.threads.filter((t) => t.id !== id));
    }
    return { ok: true };
  };
  const seat = {
    seated: false,
    seatCode: undefined as string | undefined,
    askSeat: async () => {
      s.seatAsked++;
      seat.seatCode = '4271';
      return { ok: true as const, code: '4271' };
    },
    seatEnded: () => new Promise<never>(() => {}),
  };
  const answers = seat as unknown as Answers;
  s.tab = new TricotTab(host, { url: 'http://127.0.0.1:5113', title: 'Roadmap', answers, ...(more.wordmark && { wordmark: more.wordmark }), ...(more.threads !== false && { threads: { me: 'Wassim', read, skills: async () => s.skills, send: { start: (text, lens) => take('start', text, undefined, lens), reply: (id, text) => take('reply', text, id), lens: setLens, react, remove: (id) => change(id, false), restore: (id) => change(id, true), comment, reactToComment } } }) });
  if (more.threads !== false && !more.chat) (s.tab as unknown as { navigate(command: 'status'): void }).navigate('status');
  s.type = (text) => s.tab.key(Buffer.from(text, 'utf8'));
  s.change = (next) => {
    s.threads = next;
    s.live = { ...s.live!, chatVer: (s.live!.chatVer ?? 0) + 1 };
  };
  s.screen = (cols = 80, rows = 20) => s.tab.render(cols, rows).plain.map((l) => l.trimEnd());
  s.settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  s.open = async (cols = 80, rows = 20) => {
    s.type('t');
    s.screen(cols, rows); // drawing it asks the board
    await s.settle();
  };
  return s;
}

// What shows after a change: drawn once to read it, then once more to show it.
async function refreshed(s: Stand, cols = 80, rows = 20): Promise<string[]> {
  s.screen(cols, rows);
  await s.settle();
  return s.screen(cols, rows);
}

describe("the Tricot tab's threads: the panel", () => {
  it('opens with t, which the tab’s keys say, over the stream in a narrow window, and Esc goes back to the tab', async () => {
    const s = stand([answered('a', 'Flaky test', 5 * MIN)]);
    assert.equal(s.screen().at(-1), ' o open the board · t threads · a add an agent · x stop one · q quit');
    await s.open();
    const list = s.screen();
    assert.equal(list[0], ' Threads');
    assert.equal(list.at(-1), PANEL_KEYS);
    lacks(list, '│');
    lacks(list, 'About Flaky test.'); // the stream, under it
    s.type('\x1b');
    const tab = s.screen();
    assert.match(tab[0], /^ Tricot · Roadmap/);
    assert.equal(s.quits, 0);
    s.type('t');
    assert.equal(s.screen()[0], ' Threads', 'and t opens it again');
  });

  it('lists what waits on you first, then the rest by when they were last active, and folds the quiet finished ones under Earlier', async () => {
    const quiet = Array.from({ length: 7 }, (_, i) => answered(`q${i}`, `Old ${i}`, (9 + i) * DAY));
    const first = [answered('recent', 'Picker spacing', 2 * 60 * MIN, { lens: { name: 'Design' } }), answered('legal', 'Licence check', 60 * MIN, { lens: { name: 'Legal' } }), thread('ask', 'Can you look at the flaky test?', [message(me, '@Claude can you look at the flaky test in CI?', 3 * MIN)]), ...quiet];
    const s = stand(first);
    await s.open();
    // On a first visit everything is seen as it stands: nothing waits yet.
    lacks(s.screen(), 'Waiting on you');
    // Claude answers: now it is the person's turn in that thread.
    s.change(first.map((t) => (t.id === 'ask' ? thread('ask', t.title, [...t.messages, message(claude, 'It passes alone and fails under load. Raise it to 5 s?', 2 * MIN)]) : t)));
    const screen = await refreshed(s);
    assert.deepEqual(screen.slice(0, 15), [
      ' Threads · 1 waiting on you',
      ' Waiting on you · 1',
      row(' ❯ ● Can you look at the flaky test?', '2 min ago'),
      ' Recent',
      row('     Legal · Licence check', '1 h ago'),
      row('     Design · Picker spacing', '2 h ago'),
      ' Earlier',
      row('     Old 0', '9 d ago'),
      row('     Old 1', '10 d ago'),
      row('     Old 2', '11 d ago'),
      row('     Old 3', '12 d ago'),
      row('     Old 4', '13 d ago'),
      '     Show 2 more',
      '',
      '',
    ]);
    assert.ok(screen.every((l) => columns(l) <= 80));
  });

  it('folds a thread under Earlier by what it made and when, as the page does: a day for one that made a task, a week for one that made nothing', async () => {
    const made = thread('made', 'Plan the release', [message(me, 'Plan the release?', 2 * DAY + 1_000), { ...message(claude, 'Made T48.', 2 * DAY), refs: [{ kind: 'task', id: 'task-48' }] }]);
    const nothing = answered('nothing', 'Just a question', 2 * DAY);
    const s = stand([made, nothing]);
    s.more = { tasks: [{ id: 'task-48', number: 48, title: 'Release', comments: [], fromThread: { id: 'made', title: 'Plan the release' } } as unknown as Task] };
    await s.open();
    const screen = s.screen();
    assert.deepEqual(screen.slice(0, 5), [' Threads', ' Recent', row(' ❯   Just a question', '2 d ago'), ' Earlier', row('     Plan the release', '2 d ago')]);
  });

  it("counts an @-mention of a person on the board as theirs: a reply for Sam does not wait on you, one for you does", async () => {
    const mentioning = (id: string, who: string) => {
      const asked = message(me, 'Who decides?', 5 * MIN);
      return { first: thread(id, `For ${who}`, [asked]), later: thread(id, `For ${who}`, [asked, { ...message(claude, `@${who} it is yours to say.`, MIN), mentions: [who] }]) };
    };
    const forSam = mentioning('s', 'Sam');
    const forMe = mentioning('m', 'Wassim');
    const s = stand([forSam.first, forMe.first]);
    s.more = { actors: [sam] };
    await s.open();
    s.change([forSam.later, forMe.later]);
    const screen = await refreshed(s);
    assert.deepEqual(screen.slice(0, 5).map((l) => l.replace(/ +\d+ min ago$|just now$/, '')), [' Threads · 1 waiting on you', ' Waiting on you · 1', '   ● For Wassim', ' Recent', ' ❯ • For Sam']);
  });

  it('shows no lens for General, the lens before the title for any other, and a shorter title for a long one', async () => {
    const long = 'Should the export include closed cards, and in which order should the columns of each be written?';
    const s = stand([answered('g', 'General question', 3 * MIN, { lens: { name: 'General' } }), answered('l', long, 10 * MIN, { lens: { name: 'Security', brief: 'Look for ways it could leak.' } })]);
    await s.open(60);
    const screen = s.screen(60);
    shows(screen, row(' ❯   General question', '3 min ago', 60));
    shows(screen, row('     Security · Should the export include clos…', '10 min ago', 60));
    assert.ok(screen.every((l) => columns(l) <= 60));
  });

  it('cuts the title, and leaves out the time, when the window is too narrow for both', async () => {
    const s = stand([answered('a', 'Flaky test in the checkout flow', 3 * MIN)]);
    await s.open(24, 10);
    shows(s.screen(24, 10), ' ❯   Flaky test in the …');
  });

  it('moves the highlight with the arrows and j k, wrapping, and Home and End; the highlighted row has the ❯', async () => {
    const s = stand([answered('a', 'Alpha', 1 * MIN), answered('b', 'Beta', 2 * MIN), answered('c', 'Gamma', 3 * MIN)]);
    await s.open();
    const on = () => s.screen().find((l) => l.includes('❯'))!.trim().replace(/\s+\d+ min ago$/, '');
    assert.equal(on(), '❯   Alpha');
    s.type('j');
    assert.equal(on(), '❯   Beta');
    s.type('\x1b[B');
    assert.equal(on(), '❯   Gamma');
    s.type('j');
    assert.equal(on(), '❯   Alpha', 'wraps round at the end');
    s.type('k');
    assert.equal(on(), '❯   Gamma', 'and at the start');
    s.type('\x1b[A');
    assert.equal(on(), '❯   Beta');
    s.type('\x1b[H');
    assert.equal(on(), '❯   Alpha');
    s.type('\x1b[F');
    assert.equal(on(), '❯   Gamma');
    s.type('yqzo');
    assert.equal(on(), '❯   Gamma', 'other keys do nothing here');
    assert.equal(s.quits, 0, 'q does not quit from the panel');
  });

  it('shows the rest of Earlier on Enter at its last row, with the highlight on the first of them', async () => {
    const quiet = Array.from({ length: 7 }, (_, i) => answered(`q${i}`, `Old ${i}`, (9 + i) * DAY));
    const s = stand(quiet);
    await s.open();
    s.type('\x1b[F'); // the "Show 2 more" row
    shows(s.screen(), ' ❯   Show 2 more');
    s.type('\r');
    const screen = s.screen();
    lacks(screen, 'Show 2 more');
    shows(screen, row(' ❯   Old 5', '14 d ago'));
    shows(screen, row('     Old 6', '15 d ago'));
  });

  it('says there are no threads yet on an empty board', async () => {
    const s = stand([]);
    await s.open();
    const screen = s.screen();
    shows(screen, '  No threads yet.');
    assert.ok(screen.some((l) => l.includes('starts one')), screen.join('\n'));
    s.type('\r');
    s.type('j');
    s.type('\x1b');
    assert.match(s.screen()[0], /^ Tricot · /, 'Esc still goes back');
  });

  it('says so when it is reading, when the board is away, when it could not read, and when there is no board', async () => {
    const s = stand([answered('a', 'Alpha', MIN)]);
    s.live = undefined;
    s.type('t');
    shows(s.screen(), '  Connecting to the board…');
    assert.equal(s.reads, 0, 'nothing is asked of a board that is away');
    s.live = { board: 'roadmap-1', steps: [], approvals: [], presence: [], chatVer: 1 };
    shows(s.screen(), '  Reading the threads…');
    await s.settle();
    lacks(s.screen(), 'Reading the threads');

    const broken = stand([]);
    broken.failing = 'The board refused (HTTP 500).';
    await broken.open();
    shows(broken.screen(), '  The threads could not be read: The board refused (HTTP 500).');
    shows(broken.screen(), '  Esc goes back, and t tries again.');
    broken.failing = undefined;
    broken.type('\x1b');
    await broken.open();
    shows(broken.screen(), '  No threads yet.');
    assert.equal(broken.reads, 2, 'opened again, it asked again');

    const none = stand([], { threads: false });
    none.type('t');
    assert.ok(none.screen().some((l) => l.includes('Threads need the board')));
    none.type('\x1b');
    assert.match(none.screen()[0], /^ Tricot/);
  });
});

describe("the Tricot tab's threads: a thread picked", () => {
  const long = (lines: number) => Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n');
  const talk = thread('t', 'Flaky test', [message(me, '@Claude can you look at the flaky test in CI?', 3 * MIN), message(claude, 'It passes alone and fails under load.\n\nRaise it to 5 s?', 2 * MIN), message({ kind: 'human', name: 'Sam' }, 'Same here.', 30_000)]);

  it('shows every message with who wrote it, when, and its text, as written, under a row that says only it shows', async () => {
    const s = stand([talk]);
    await s.open();
    s.type('\r');
    const screen = s.screen();
    assert.deepEqual(screen.slice(0, 11), [
      only('Flaky test'),
      '  You  3 min ago',
      '    @Claude can you look at the flaky test in CI?',
      '  Claude  agent · 2 min ago',
      '    It passes alone and fails under load.',
      '',
      '    Raise it to 5 s?',
      '  Sam  just now',
      '    Same here.',
      '',
      '',
    ]);
    assert.equal(screen.at(-1), ' Enter send · Tab react · Esc everything · ↑↓ PgUp PgDn scroll · ^L lens');
    lacks(screen, '│'); // the panel is out of sight in a narrow window
  });

  it('wraps long text to the width, at spaces, and cuts a word longer than a row; Markdown is shown as written', async () => {
    const body = `# Plan\n\n- **poll** the port every 50 ms and give up after ten seconds with the last error it saw\n\`\`\`\n  indented code ${'y'.repeat(60)}\n\`\`\``;
    const s = stand([thread('t', 'Plan', [message(claude, body, MIN)])]);
    await s.open(40, 20);
    s.type('\r');
    const screen = s.screen(40, 20);
    assert.deepEqual(screen.slice(1, 13), [
      '  Claude  agent · 1 min ago',
      '    # Plan',
      '',
      '    - **poll** the port every 50 ms and',
      '      give up after ten seconds with',
      '      the last error it saw',
      '    ```',
      '      indented code',
      `      ${'y'.repeat(33)}`,
      `      ${'y'.repeat(27)}`,
      '    ```',
      '',
    ]);
    assert.ok(screen.every((l) => columns(l) <= 40));
  });

  it('continues a wrapped list item under its text, not under its marker; a plain line under its own indentation', async () => {
    const body = ['* a bulleted item that is long enough to be cut onto a second row', '12. a numbered item that is long enough to be cut onto a second row', '    nested text that is long enough to be cut onto a second row']
      .join('\n');
    const s = stand([thread('t', 'Lists', [message(claude, body, MIN)])]);
    await s.open(40, 20);
    s.type('\r');
    assert.deepEqual(s.screen(40, 20).slice(2, 9), [
      '    * a bulleted item that is long',
      '      enough to be cut onto a second',
      '      row',
      '    12. a numbered item that is long',
      '        enough to be cut onto a second',
      '        row',
      '        nested text that is long enough',
    ]);
  });

  it('starts at the latest message, and the arrows, Page Up, Page Down, Home and End scroll it', async () => {
    const s = stand([thread('t', 'Long', [message(me, 'Read this.', 5 * MIN), message(claude, long(30), 4 * MIN)])]);
    await s.open(80, 14); // 9 rows of conversation, under the row that says it is picked and over the one before the line
    s.type('\r');
    const rows = (cols = 80, n = 14) => s.screen(cols, n).slice(1, -4);
    const under = () => s.screen(80, 14).at(-4);
    // The latest at the bottom: its last line, with the thread's start out of sight above.
    assert.equal(rows().at(-1), '    line 30');
    assert.equal(under(), '', 'nothing newer below');
    s.type('\x1b[A');
    assert.equal(rows().at(-1), '    line 29', 'a line up');
    assert.equal(under(), '  ↓ more below · Enter for the latest');
    s.type('\x1b[B');
    assert.equal(rows().at(-1), '    line 30', 'and a line down, back at the latest');
    s.type('\x1b[B');
    assert.equal(rows().at(-1), '    line 30', 'no further than the latest');
    s.type('\x1b[5~');
    assert.equal(rows().at(-1), '    line 22', 'a page up (a row of overlap kept)');
    s.type('\x1b[6~');
    assert.equal(rows().at(-1), '    line 30', 'a page down');
    s.type('\x1b[H');
    assert.equal(rows()[0], '  You  5 min ago', 'Home: the first message');
    assert.equal(s.screen(80, 14)[0], only('Long'), 'under the row that says the thread is picked');
    s.type('\x1b[A');
    assert.equal(rows()[0], '  You  5 min ago', 'no further up than the start');
    s.type('\x1b[6~');
    assert.equal(rows()[0], '    line 6', 'a page is the rows less one');
    s.type('\x1b[F');
    assert.equal(rows().at(-1), '    line 30', 'End: the latest');
    s.type('\x1b[5~\x1b[5~\x1b[5~\x1b[5~\x1b[5~\x1b[5~\x1b[5~');
    assert.equal(rows()[0], '  You  5 min ago', 'Page Up keeps stopping at the start');
  });

  it('goes back to its latest with Enter on the empty line, which the keys say while it is scrolled up', async () => {
    const s = stand([thread('t', 'Long', [message(me, 'Read this.', 5 * MIN), message(claude, long(30), 4 * MIN)])]);
    await s.open(80, 14);
    s.type('\r');
    assert.equal(s.screen(80, 14).at(-1), ' Enter send · Tab react · Esc everything · ↑↓ PgUp PgDn scroll · ^L lens', 'at its latest, Enter sends');
    s.type('\x1b[H');
    const scrolled = s.screen(80, 14);
    assert.equal(scrolled.at(-4), '  ↓ more below · Enter for the latest');
    assert.equal(scrolled.at(-1), ' Enter latest · Tab react · Esc everything · ↑↓ PgUp PgDn scroll · ^L lens');
    s.type('\r');
    const back = s.screen(80, 14);
    assert.equal(back.slice(1, -4).at(-1), '    line 30', 'at the latest');
    assert.equal(back.at(-4), '');
    assert.equal(back[0], only('Long'), 'still picked');
    assert.deepEqual(s.sent, [], 'nothing sent');
  });

  it('goes back to the panel with Esc, and from the panel to the tab it was opened from with another', async () => {
    const s = stand([talk]);
    await s.open();
    s.type('\r');
    assert.equal(s.screen()[0], only('Flaky test'));
    s.type('\x1b');
    assert.equal(s.screen()[0], ' Threads');
    assert.equal(s.screen().at(-1), PANEL_KEYS);
    s.type('\x1b');
    assert.match(s.screen()[0], /^ Tricot · /);
    s.type('t');
    s.type('\r');
    s.type('\x03'); // Ctrl+C goes back as Esc does
    assert.equal(s.screen()[0], ' Threads');
    s.type('\x03');
    assert.match(s.screen()[0], /^ Tricot · /);
  });

  it('marks it seen once its latest message shows: it no longer waits on you', async () => {
    const asked = thread('t', 'Question', [message(me, 'Which one?', 5 * MIN)]);
    const s = stand([asked]);
    await s.open();
    s.change([thread('t', 'Question', [...asked.messages, message(claude, 'This one.', MIN)])]);
    shows(await refreshed(s), ' Waiting on you · 1');
    s.type('\r');
    s.screen(); // shown at its latest
    s.type('\x1b');
    lacks(s.screen(), 'Waiting on you');
    assert.equal(s.screen().filter((l) => l.includes('●')).length, 0);
  });

  it('shows what an agent or person sent as plain text: control characters as their pictures, never to the terminal', async () => {
    const hostile = thread('t', 'Title \x1b]0;pwned\x07 here', [message({ kind: 'agent', name: 'Cl\x1b[2Jaude' }, 'run \x1b[31mred\x1b[0m\tnow\x07\r\nsecond \x9b line ‮hidden', MIN)]);
    const s = stand([hostile]);
    await s.open();
    const list = s.tab.render(80, 20);
    assert.ok(!list.rows.join('').includes('\x1b]'), 'no title sequence in the panel');
    s.type('\r');
    const frame = s.tab.render(80, 20);
    const text = frame.plain.join('\n');
    assert.ok(text.includes('run ␛[31mred␛[0m  now␇'), text);
    assert.ok(text.includes('second � line �hidden'), text);
    assert.ok(text.includes('  Cl [2Jaude  agent · 1 min ago'), 'a name is on one line, its control characters gone');
    assert.ok(text.includes('  Only Title  ]0;pwned  here · Esc for everything'), 'and a title');
    // Colours the tab itself draws are `\x1b[0;1m` and the like; nothing else escapes.
    const raw = frame.rows.join('').replace(/\x1b\[[0-9;]*m|\x1b\[K/g, '');
    assert.ok(!raw.includes('\x1b'), 'nothing a message sent reaches the terminal as a sequence');
    assert.ok(!frame.plain.some((l) => /[\u0000-\u001f\u007f-\u009f]/.test(l)));
  });
});

describe("the Tricot tab's threads: live", () => {
  const flaky = thread('t', 'Flaky test', [message(me, 'Can you look at it?', 5 * MIN)]);

  it('reads again only when the stream says the threads changed, or connects again', async () => {
    const s = stand([flaky]);
    await s.open();
    for (let i = 0; i < 5; i++) await refreshed(s);
    assert.equal(s.reads, 1, 'drawn again and again, it reads once');
    s.live = { ...s.live!, steps: [{ agent: 'Claude', text: 'Running npm test', at: ago(1000), running: true }] };
    await refreshed(s);
    assert.equal(s.reads, 1, 'other news from the board is not about threads');
    s.change([flaky]);
    await refreshed(s);
    assert.equal(s.reads, 2);
    // The stream drops and comes back: the count goes on from where it was, so it reads again.
    s.live = undefined;
    s.screen();
    s.live = { board: 'roadmap-1', steps: [], approvals: [], presence: [], chatVer: 3 };
    await refreshed(s);
    assert.equal(s.reads, 3);
  });

  it('shows a message that arrives while the panel is showing: it moves its thread up and says it waits on you', async () => {
    const other = answered('o', 'Licence check', 60 * MIN);
    const s = stand([other, flaky]);
    await s.open();
    shows(s.screen(), row(' ❯   Flaky test', '5 min ago'));
    s.change([other, thread('t', 'Flaky test', [...flaky.messages, message(claude, 'It passes alone.', 10_000)])]);
    const screen = await refreshed(s);
    assert.deepEqual(screen.slice(0, 5), [' Threads · 1 waiting on you', ' Waiting on you · 1', row(' ❯ ● Flaky test', 'just now'), ' Recent', row('     Licence check', '1 h ago')]);
  });

  it('shows a new thread as it is started', async () => {
    const s = stand([flaky]);
    await s.open();
    lacks(s.screen(), 'Picker spacing');
    s.change([flaky, thread('p', 'Picker spacing', [message(claude, 'I have a question about the picker.', 20_000)])]);
    const screen = await refreshed(s);
    shows(screen, ' Waiting on you · 1');
    shows(screen, row('   ● Picker spacing', 'just now'));
    shows(screen, row(' ❯   Flaky test', '5 min ago')); // the highlight stays where it was
  });

  it('keeps the highlight on its thread when others move above it', async () => {
    const [alpha, beta] = [answered('a', 'Alpha', 10 * MIN), answered('b', 'Beta', 20 * MIN)];
    const s = stand([alpha, beta]);
    await s.open();
    s.type('j');
    s.change([alpha, beta, thread('c', 'Gamma', [message(me, 'Gamma?', MIN)])]);
    const screen = await refreshed(s);
    assert.deepEqual(screen.slice(0, 3).map((l) => l.replace(/ +\d+ min ago$/, '')), [' Threads', '     Gamma', '     Alpha']);
    shows(screen, row(' ❯   Beta', '20 min ago'));
  });

  it('shows a message that arrives in the thread picked, and stays at the latest', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const base = thread('t', 'Long', [message(me, 'Read this.', 5 * MIN), message(claude, lines, 4 * MIN)]);
    const s = stand([base]);
    await s.open(80, 14);
    s.type('\r');
    assert.equal(s.screen(80, 14).at(-5), '    line 30');
    s.change([thread('t', 'Long', [...base.messages, message(me, 'Thanks, that works.', 5_000)])]);
    const screen = await refreshed(s, 80, 14);
    assert.equal(screen.at(-5), '    Thanks, that works.', 'at the latest, it follows');
    assert.equal(screen.at(-6), '  You  just now');
  });

  it('keeps a thread scrolled up where it is as more arrives, and does not call what it has not seen read', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const base = thread('t', 'Long', [message(me, 'Read this.', 5 * MIN), message(claude, lines, 4 * MIN)]);
    const s = stand([base]);
    await s.open(80, 14);
    s.type('\r');
    s.type('\x1b[H');
    const top = s.screen(80, 14);
    s.change([thread('t', 'Long', [...base.messages, message(claude, 'And one more thing.', 5_000)])]);
    const screen = await refreshed(s, 80, 14);
    assert.deepEqual(screen.slice(0, -4), top.slice(0, -4), 'the same rows, though there is more below');
    assert.equal(screen.at(-4), '  ↓ 1 newer below · Enter for the latest');
    s.type('\x1b');
    assert.equal(s.screen(80, 14)[0], ' Threads · 1 waiting on you', 'not seen: it waits on you');
    s.type('\r');
    s.screen(80, 14);
    s.type('\x1b');
    assert.equal(s.screen(80, 14)[0], ' Threads', 'picked again, it shows at its latest, and is read');
  });

  it('goes back to the panel when the thread picked is deleted', async () => {
    const other = answered('o', 'Other', 30 * MIN);
    const s = stand([flaky, other]);
    await s.open();
    s.type('\r');
    assert.equal(s.screen()[0], only('Flaky test'));
    s.change([other]);
    const screen = await refreshed(s);
    assert.equal(screen[0], ' Threads');
    lacks(screen, 'Flaky test');
  });

  it('says on its last row what waits for your OK in the tab, which Esc goes back to', async () => {
    const s = stand([flaky]);
    s.live = { ...s.live!, approvals: [{ id: 'a1', agent: 'Claude', harness: 'claude', tool: 'Bash', input: { command: 'ls' }, at: ago(1000) }] };
    await s.open();
    const last = s.screen().at(-1)!;
    assert.match(last, /^ ↑↓  Enter  n  x delete  Esc +1 waiting for your OK: \/status$/);
    s.type('y');
    assert.equal(s.screen()[0], ' Threads', 'y does not answer from here');
  });
});

describe("the Tricot tab's threads: wide and narrow windows", () => {
  const talk = thread('t', 'Can you look at the flaky test?', [message(me, '@Claude can you look at the flaky test in CI?', 3 * MIN), message(claude, 'It passes alone and fails under load.', 2 * MIN)]);
  const legal = answered('l', 'Licence check', 60 * MIN, { lens: { name: 'Legal' } });

  it('is beside the stream from a hundred columns, a third of the window, and over it under', () => {
    assert.equal(WIDE_FROM, 100);
    assert.equal(panelGeometry(100).wide, true);
    assert.equal(panelGeometry(99).wide, false);
    assert.equal(panelGeometry(99).width, 99, 'over the stream, it takes all of it');
    assert.equal(panelGeometry(120).width, 40);
    assert.equal(panelGeometry(100).width, 33);
    assert.equal(panelGeometry(200).width, 44, 'and no more than forty-four columns');
  });

  it('sits at the stream’s right, a thin line between them, the whole stream still in view', async () => {
    const s = stand([talk, legal]);
    await s.open(120, 14);
    let screen = s.screen(120, 14);
    assert.ok(screen.every((l) => columns(l) <= 120));
    assert.deepEqual(sides(screen[0]), ['  You · in Legal · Licence check · 1 h ago', ' Threads']);
    assert.deepEqual(sides(screen[1]), ['    Licence check?', ' ❯   Can you look at the fl…  2 min ago']);
    assert.deepEqual(sides(screen[2]), ['  Claude  agent · in Legal · Licence check · 1 h ago', '     Legal · Licence check      1 h ago']);
    assert.equal(screen[0].indexOf('│'), 79, 'the stream keeps two thirds of the window');
    assert.equal(screen.at(-1), PANEL_KEYS);
    assert.equal(screen.filter((l) => l.includes('│')).length, 13, 'the line runs down to the keys');
    s.type('j');
    screen = s.screen(120, 14);
    assert.match(screen[2], /│ ❯   Legal · Licence check +1 h ago$/);
    assert.equal(sides(screen[0])[0], '  You · in Legal · Licence check · 1 h ago', 'the stream stays as it was');
  });

  it('picks a thread with Enter: the stream beside the panel shows it alone, the keys scroll it, and Esc gives them back to the panel', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const s = stand([thread('t', 'Long', [message(claude, lines, MIN)]), legal]);
    await s.open(120, 14);
    s.type('\r');
    const open = s.screen(120, 14);
    assert.equal(open.at(-1), ' Enter send · Tab react · Esc everything · ↑↓ PgUp PgDn scroll · ^L lens');
    assert.deepEqual(sides(open[0]), [only('Long'), ' Threads']);
    assert.match(open[1], /│ ❯   Long +1 min ago$/, 'the panel keeps its highlight');
    assert.equal(sides(open.at(-5)!)[0], '    line 30');
    s.type('\x1b[5~');
    assert.equal(sides(s.screen(120, 14).at(-5)!)[0], '    line 22');
    s.type('\x1b');
    const back = s.screen(120, 14);
    assert.equal(back.at(-1), PANEL_KEYS);
    lacks(back, 'Only Long');
    assert.match(back[1], /│ ❯   Long/, 'the same thread highlighted');
    s.type('j');
    assert.match(s.screen(120, 14)[2], /│ ❯   Legal · Licence check/);
  });

  it('shows which side has the keys: the panel’s ❯ is bold while it has them, and dim while the thread picked does', async () => {
    const s = stand([talk, legal]);
    await s.open(120, 14);
    const marker = () => s.tab.render(120, 14).rows.find((l) => l.includes('❯'))!.match(/(\x1b\[0;[12]m) ❯ /)![1];
    assert.equal(marker(), '\x1b[0;1m', 'the panel has the keys');
    s.type('\r');
    assert.equal(marker(), '\x1b[0;2m', 'the thread has them');
    s.type('\x1b');
    assert.equal(marker(), '\x1b[0;1m', 'the panel again');
  });

  it('covers the stream under a hundred columns, and a thread picked takes the whole window', async () => {
    const s = stand([talk, legal]);
    await s.open(99, 14);
    const list = s.screen(99, 14);
    lacks(list, '│');
    lacks(list, 'You');
    s.type('\r');
    const open = s.screen(99, 14);
    lacks(open, '│');
    assert.equal(open[0], only('Can you look at the flaky test?'));
    lacks(open, 'Licence check');
    s.type('\x1b');
    lacks(s.screen(99, 14), 'You');
    assert.equal(s.screen(99, 14)[0], ' Threads', 'the panel over it again');
  });

  it('draws with bold, dim and the alert colour only, and fits every size it is given', async () => {
    const s = stand([talk, legal]);
    await s.open(120, 14);
    s.change([talk, legal, thread('n', 'New', [message(claude, 'Hello?', 1_000)])]);
    await refreshed(s, 120, 14);
    for (const [cols, rows] of [[120, 14], [100, 3], [70, 1], [40, 2], [30, 8], [10, 5]] as const) {
      const frame = s.tab.render(cols, rows);
      assert.equal(frame.rows.length, rows, `${cols}×${rows}`);
      assert.ok(frame.plain.every((l) => columns(l) <= cols), `${cols}×${rows}:\n${frame.plain.join('\n')}`);
    }
    const frame = s.tab.render(120, 14);
    const sgr = new Set(frame.rows.join('').match(/\x1b\[[0-9;]*m/g));
    for (const code of sgr) assert.match(code, LOOKS, `only the tab's own looks: ${JSON.stringify(code)}`);
    const light = s.tab.render(120, 14, true).rows.join('');
    assert.ok(light.includes('38;5;130'), 'the alert colour follows the theme');
  });
});

describe("the Tricot tab's threads: writing", () => {
  const talk = thread('t', 'Flaky test', [message(me, '@Claude can you look at the flaky test in CI?', 3 * MIN), message(claude, 'It passes alone and fails under load.', 2 * MIN)]);
  const keys = { left: '\x1b[D', right: '\x1b[C', up: '\x1b[A', down: '\x1b[B', home: '\x1b[H', end: '\x1b[F', tab: '\t', enter: '\r', backspace: '\x7f', clear: '\x15', esc: '\x1b' };
  const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

  // The foot of the window: the keys, the row under the line, the line itself, and what Tab lists above it.
  const keysRow = (screen: string[]) => screen.at(-1)!;
  const statusRow = (screen: string[]) => screen.at(-2)!;
  const lineRow = (screen: string[]) => screen.at(-3)!;
  const listRow = (screen: string[]) => screen.at(-4)!;

  async function reading(more: Partial<Pick<Stand, 'skills'>> & { actors?: Actor[] } = {}, threads: Thread[] = [talk]): Promise<Stand> {
    const s = stand(threads);
    s.more = { actors: more.actors ?? [sam, { kind: 'agent', name: 'Claude Code' }, { kind: 'agent', name: 'Codex' }] };
    if (more.skills) s.skills = more.skills;
    await s.open();
    s.type('\r');
    return s;
  }

  describe('replying', () => {
    it('has the line at the foot of a thread picked, which takes what is typed, says where it goes and who gets it, and is where the cursor is', async () => {
      const s = await reading();
      const frame = s.tab.render(80, 20);
      assert.equal(lineRow(frame.plain.map((l) => l.trimEnd())), ' › Reply to Claude…', 'it names whom the reply answers');
      assert.equal(statusRow(frame.plain.map((l) => l.trimEnd())), ' to Flaky test · Claude hears it');
      assert.deepEqual(frame.cursor, { x: 3, y: 17 }, 'the cursor is on the line, at its start');
      s.type('Raise it to 5 s');
      const typed = s.tab.render(80, 20);
      assert.equal(typed.plain[17].trimEnd(), ' › Raise it to 5 s');
      assert.deepEqual(typed.cursor, { x: 3 + 15, y: 17 });
      assert.ok(s.tab.typing);
    });

    it('sends what is typed with Enter, shows it at once as sending, and as sent when the board has it', async () => {
      const s = await reading();
      let release!: () => void;
      s.gate = new Promise<void>((resolve) => (release = resolve));
      s.type('Raise it to 5 s?\r');
      assert.deepEqual(s.sent, [{ kind: 'reply', thread: 't', text: 'Raise it to 5 s?' }]);
      let screen = s.screen();
      const sending = screen.indexOf('  You  sending…');
      assert.ok(sending >= 0, screen.join('\n'));
      assert.equal(screen[sending + 1], '    Raise it to 5 s?', 'the message is there already');
      assert.equal(lineRow(screen), ' › Reply to Claude…', 'and the line is free for the next one');
      release();
      await s.settle();
      screen = await refreshed(s);
      lacks(screen, 'sending…');
      assert.ok(screen.some((l) => l === '  You  just now'), screen.join('\n'));
      assert.equal(screen.filter((l) => l === '    Raise it to 5 s?').length, 1, 'once, not the sent one and the read one');
      assert.equal(s.reads, 2, 'it read again once the board had it');
    });

    it('keeps the text on the line when the board refuses, with why under it, and sends it again on Enter', async () => {
      const s = await reading();
      s.refusing = { error: 'The board refused the message (HTTP 500).' };
      s.type('Raise it to 5 s?\r');
      await s.settle();
      let screen = s.screen();
      lacks(screen, 'sending…');
      assert.equal(screen.filter((l) => l === '    Raise it to 5 s?').length, 0, 'it is not shown as a message');
      assert.equal(lineRow(screen), ' › Raise it to 5 s?', 'the text is back on the line');
      assert.equal(statusRow(screen), ' The board refused the message (HTTP 500).');
      assert.ok(s.tab.render(80, 20).rows.at(-2)!.includes(`\x1b[0;38;5;214;${BAND}m`), 'in the alert colour, on the band');
      s.type('!');
      assert.equal(statusRow(s.screen()), ' to Flaky test · Claude hears it', 'typing on brings the line back to what it says');
      s.refusing = undefined;
      s.type('\r');
      await s.settle();
      screen = await refreshed(s);
      assert.equal(s.sent.length, 2);
      assert.equal(s.sent[1].text, 'Raise it to 5 s?!');
      assert.equal(lineRow(screen), ' › Reply to Claude…');
    });

    it('puts a refused text back before what was typed since, aimed at the thread it went to though another is picked meanwhile', async () => {
      const other = answered('o', 'Licence check', 60 * MIN);
      const s = await reading({}, [talk, other]);
      let release!: () => void;
      s.gate = new Promise<void>((resolve) => (release = resolve));
      s.refusing = { error: 'Nope.' };
      s.type('first\r');
      s.type('second');
      release();
      await s.settle();
      assert.equal(lineRow(s.screen()), ' › first second');

      // Away from it: the other thread picked.
      s.type(keys.clear);
      s.gate = new Promise<void>((resolve) => (release = resolve));
      s.type('third\r');
      s.type(keys.esc);
      s.type('j');
      s.type('\r');
      assert.equal(s.screen()[0], only('Licence check'));
      assert.equal(lineRow(s.screen()), ' › Reply to Claude…');
      release();
      await s.settle();
      assert.equal(lineRow(s.screen()), ' › third', 'the text is back');
      assert.equal(statusRow(s.screen()), ' Nope.');
      s.type('!');
      assert.equal(statusRow(s.screen()), ' to Flaky test · Claude hears it', 'aimed where it went, not at the thread picked now');
      assert.deepEqual(s.sent.map((m) => m.thread), ['t', 't']);
    });

    it('asks to be let in when the board says this terminal must be, keeping the text; Enter asks, and the code shows', async () => {
      const s = await reading();
      s.refusing = { error: 'This browser or terminal is no longer one you let in (it was removed): let it in again.', needsSeat: true };
      s.type('Raise it to 5 s?\r');
      await s.settle();
      assert.equal(lineRow(s.screen()), ' › Raise it to 5 s?');
      assert.equal(statusRow(s.screen()), ' This terminal must be let in first: Enter asks, and your text is kept.');
      assert.equal(s.sent.length, 1);
      s.type('\r');
      await s.settle();
      assert.equal(s.seatAsked, 1, 'Enter asked');
      assert.equal(s.sent.length, 1, 'and sent nothing');
      assert.equal(statusRow(s.screen()), ' Waiting for you to let this terminal in: code 4271.');
      assert.equal(lineRow(s.screen()), ' › Raise it to 5 s?', 'the text waits');
    });

    it('lets Esc clear what is typed first and leave with nothing typed, and Ctrl+C the same', async () => {
      const s = await reading();
      s.type('half a thought');
      s.type(keys.esc);
      assert.equal(lineRow(s.screen()), ' › Reply to Claude…');
      assert.equal(s.screen()[0], only('Flaky test'), 'still in the thread');
      s.type('and again\x03');
      assert.equal(s.screen()[0], only('Flaky test'));
      assert.equal(lineRow(s.screen()), ' › Reply to Claude…');
      s.type(keys.esc);
      assert.equal(s.screen()[0], ' Threads');
      assert.equal(s.tab.typing, false);
      s.type('t');
      assert.equal(s.screen()[0], ' Threads', 'a letter in the panel is not typed anywhere');
      s.type('n');
      assert.ok(s.tab.typing);
      s.type('Ctrl');
      s.type(keys.clear);
      assert.equal(lineRow(s.screen()), ' › What do you want to work through?', 'Ctrl+U clears the line');
    });

    it('does not take what is typed for the tab’s own keys: y n s q o a x t and j k type', async () => {
      const long = (lines: number) => Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n');
      const s = stand([thread('t', 'Long', [message(claude, long(30), MIN)])]);
      s.live = { ...s.live!, approvals: [{ id: 'a1', agent: 'Claude', harness: 'claude', tool: 'Bash', input: { command: 'ls' }, at: ago(1000) }] };
      await s.open(80, 14);
      s.type('\r');
      const before = s.screen(80, 14).slice(0, -3);
      s.type('ynsqoatx kj');
      assert.equal(s.quits, 0, 'q does not quit');
      assert.equal(lineRow(s.screen(80, 14)), ' › ynsqoatx kj');
      assert.deepEqual(s.screen(80, 14).slice(0, -3), before, 'and j k do not scroll');
      assert.equal(s.sent.length, 0);
      assert.ok(s.tab.typing);
      s.type(keys.esc);
      s.type(keys.esc);
      s.type(keys.esc);
      assert.match(s.screen()[0], /^ Tricot · /, 'Esc, Esc, Esc: the tab');
      assert.equal(s.tab.typing, false);
    });

    it('moves the cursor with ← → and inserts and deletes where it is; Home and End scroll with nothing typed and move it otherwise', async () => {
      const s = await reading();
      s.type('Rase it');
      const at = () => s.tab.render(80, 20).cursor!.x - 3;
      assert.equal(at(), 7);
      for (let i = 0; i < 5; i++) s.type(keys.left);
      assert.equal(at(), 2);
      s.type('i');
      assert.equal(lineRow(s.screen()), ' › Raise it');
      assert.equal(at(), 3);
      s.type(keys.right + keys.right + keys.right);
      s.type(keys.backspace);
      assert.equal(lineRow(s.screen()), ' › Raiseit');
      assert.equal(at(), 5);
      s.type(keys.home);
      assert.equal(at(), 0);
      s.type(keys.left);
      assert.equal(at(), 0, 'no further left');
      s.type(keys.end);
      assert.equal(at(), 7);
      s.type(keys.right);
      assert.equal(at(), 7, 'no further right');
      s.type('😀');
      assert.equal(at(), 9, 'an emoji is two columns');
      s.type(keys.left);
      assert.equal(at(), 7, 'and one step');
      s.type(keys.right);
      assert.equal(at(), 9);
      s.type(keys.backspace);
      assert.equal(lineRow(s.screen()), ' › Raiseit', 'Backspace takes the character, not half of it');
      assert.equal(at(), 7);
    });

    it('scrolls with ↑↓, Page Up, Page Down, Home and End while nothing is typed, and keeps its place when sending', async () => {
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
      const s = stand([thread('t', 'Long', [message(me, 'Read this.', 5 * MIN), message(claude, lines, 4 * MIN)])]);
      await s.open(80, 14);
      s.type('\r');
      s.type(keys.home);
      assert.equal(s.screen(80, 14)[2], '    Read this.');
      s.type('hello' + keys.home);
      s.type(keys.up);
      assert.equal(s.screen(80, 14)[2], '    Read this.', 'with text, Home moved the cursor, not the thread');
      s.type(keys.clear);
      s.type(keys.end);
      assert.equal(s.screen(80, 14).at(-5), '    line 30', 'End is the latest again');
    });

    it('takes a paste whole, its lines kept, tabs as spaces and control characters out, at the cursor (T37)', async () => {
      const s = await reading();
      s.type('A  B');
      s.type(keys.left + keys.left + keys.left);
      s.type(paste('one\r\ntwo\tthree\x07\nfour'));
      assert.deepEqual(s.screen().slice(-5, -2), [' › Aone', '   two three', '   four  B']);
      assert.equal(s.sent.length, 0, 'a newline in a paste does not send it');
      s.type(keys.end);
      s.type(paste('\n\n'));
      const frame = s.tab.render(80, 20);
      assert.deepEqual(frame.cursor, { x: 3, y: 17 }, 'two new lines, the cursor at the start of the last');
      assert.equal(frame.plain[13].trimEnd(), ' › Aone');
    });

    it('adds a new line with Option+Enter or Ctrl+J, Enter sending them all, and moves between its rows with ↑ ↓ (T37)', async () => {
      const s = await reading();
      s.type('first');
      s.type('\x1b\r');
      s.type('second');
      s.type('\n');
      s.type('third');
      assert.deepEqual(s.screen().slice(-5, -2), [' › first', '   second', '   third']);
      s.type(keys.up);
      s.type('!');
      assert.deepEqual(s.screen().slice(-5, -2), [' › first', '   secon!d', '   third'], '↑ keeps the column, or the end of a shorter row');
      s.type(keys.up + keys.up + keys.down + keys.down + keys.down);
      s.type('?');
      assert.equal(s.screen().at(-3), '   third?', 'from the last row, ↓ goes no further');
      s.type('\r');
      assert.equal(s.sent[0].text, 'first\nsecon!d\nthird?');
    });

    it('moves a word at a time with Option+← → in each form a terminal sends them, and deletes one with Option+Backspace or Ctrl+W (T37)', async () => {
      const s = await reading();
      s.type('one two  three');
      for (const [left, right] of [['\x1bb', '\x1bf'], ['\x1b[1;3D', '\x1b[1;3C'], ['\x1b[1;5D', '\x1b[1;5C']]) {
        s.type(left + left);
        s.type('^');
        assert.equal(lineRow(s.screen()), ' › one ^two  three', JSON.stringify(left));
        s.type(keys.backspace + right);
        s.type('$');
        assert.equal(lineRow(s.screen()), ' › one two$  three', JSON.stringify(right));
        s.type(keys.backspace + '\x05');
      }
      s.type('\x1b\x7f');
      assert.equal(lineRow(s.screen()), ' › one two');
      s.type('\x17');
      assert.equal(lineRow(s.screen()), ' › one');
      s.type('\x01!');
      assert.equal(lineRow(s.screen()), ' › !one', 'Ctrl+A to the start');
      s.type('\r');
      assert.equal(s.sent[0].text, '!one', 'what is left, sent');
    });

    it('wraps a long text onto rows, up to eight, those around the cursor shown, and sends it whole', async () => {
      const s = await reading();
      s.type(paste('x'.repeat(THREAD_TEXT_LIMIT - 3)));
      s.type(paste('abcdef'));
      s.type('Z');
      const frame = s.tab.render(80, 20);
      const foot = frame.plain.slice(10, 18);
      assert.ok(foot[0].startsWith(' ↑ x'), 'more above: ' + foot[0]);
      assert.ok(foot.slice(1).every((l) => l.startsWith('   x') || l.startsWith('   ')), foot.join('\n'));
      assert.ok(foot[7].trimEnd().endsWith('xabc'), 'the end of what was typed, the cursor in view: ' + foot[7]);
      assert.deepEqual(frame.cursor, { x: columns(foot[7].trimEnd()), y: 17 });
      s.type('\r');
      assert.equal(s.sent[0].text!.length, THREAD_TEXT_LIMIT, 'sent as long as a message may be');
      assert.ok(s.sent[0].text!.endsWith('xxxabc'));
      s.type(keys.clear);
      s.type('é'.repeat(5));
      assert.equal(lineRow(s.screen()), ' › ééééé');
    });
  });

  describe('starting a thread', () => {
    it('gives n in the panel the stream’s line, starting a thread: Enter starts it, and it is picked when the board has it', async () => {
      const s = stand([talk]);
      await s.open();
      s.type('n');
      let screen = s.screen();
      assert.equal(screen[0], '  You · in Flaky test · 3 min ago', 'the panel closed, the stream in view');
      assert.equal(lineRow(screen), ' › What do you want to work through?');
      assert.equal(statusRow(screen), ' New thread · Claude is listening.');
      assert.equal(keysRow(screen), ' Enter new thread · ↑↓ PgUp PgDn scroll · Tab complete @ / · Esc the latest');
      assert.ok(s.tab.typing);
      s.type('@Claude can you look at the picker?');
      assert.equal(statusRow(s.screen()), ' New thread · Claude is listening: this is seen at once.');
      let release!: () => void;
      s.gate = new Promise<void>((resolve) => (release = resolve));
      s.type('\r');
      assert.deepEqual(s.sent, [{ kind: 'start', text: '@Claude can you look at the picker?' }]);
      screen = s.screen();
      assert.equal(statusRow(screen), ' Starting the thread…');
      assert.equal(lineRow(screen), ' › @Claude can you look at the picker?', 'the text stays until the board has it');
      s.type('more');
      assert.equal(lineRow(s.screen()), ' › @Claude can you look at the picker?', 'and is held while it goes');
      release();
      await s.settle();
      screen = s.screen();
      assert.equal(screen[0], only('@Claude can you look at the picker?'), 'the new thread is picked');
      assert.equal(screen[1], '  You  just now');
      assert.equal(screen[2], '    @Claude can you look at the picker?');
      assert.equal(lineRow(screen), ' › Reply to Claude…', 'the line answers it');
      assert.equal(statusRow(screen), ' to @Claude can you look at the picker? · Claude hears it');
      s.type(keys.esc);
      assert.equal(lineRow(s.screen()), ' › Reply to Claude…', 'Esc: the whole stream, its line empty');
      assert.equal(statusRow(s.screen()), ' to Flaky test, the latest · Claude hears it');
    });

    it('starts from an empty board too, and a refusal keeps the text', async () => {
      const s = stand([]);
      await s.open();
      s.type('n');
      s.refusing = { error: 'A message is too long.' };
      s.type('Anyone there?\r');
      await s.settle();
      assert.equal(lineRow(s.screen()), ' › Anyone there?');
      assert.equal(statusRow(s.screen()), ' A message is too long.');
      assert.equal(s.screen()[0], '  No conversations on the board yet.', 'the stream it is started from stays');
      s.refusing = undefined;
      s.type('\r');
      await s.settle();
      assert.equal(s.screen()[0], only('Anyone there?'));
    });

    it('clears with Esc, then goes back to the latest with another, and an empty line sends nothing', async () => {
      const s = stand([talk]);
      await s.open();
      s.type('n\r');
      assert.equal(s.sent.length, 0, 'nothing typed, nothing sent');
      s.type('   \r');
      assert.equal(s.sent.length, 0, 'nor spaces');
      s.type('draft');
      s.type(keys.esc);
      assert.equal(lineRow(s.screen()), ' › What do you want to work through?');
      s.type(keys.esc);
      assert.equal(statusRow(s.screen()), ' to Flaky test, the latest · Claude hears it', 'back to answering the latest');
      s.type(keys.esc);
      assert.equal(keysRow(s.screen()), PANEL_KEYS, 'and then the panel');
      assert.equal(s.tab.typing, false);
      s.type('j');
      assert.equal(s.screen()[0], ' Threads');
      s.type('n');
      assert.equal(lineRow(s.screen()), ' › What do you want to work through?', 'and its draft is gone');
    });

    it('does not start one before the board is read', async () => {
      const s = stand([talk]);
      s.live = undefined;
      s.type('t');
      s.type('n');
      assert.equal(s.tab.typing, false);
    });

    it('closes the panel in a wide window too, the row under the line saying a new thread is being started', async () => {
      const s = stand([talk]);
      await s.open(120, 14);
      assert.ok(s.screen(120, 14).some((l) => l.includes('│')));
      s.type('n');
      const screen = s.screen(120, 14);
      lacks(screen, '│');
      assert.equal(statusRow(screen), ' New thread · Claude is listening.');
      assert.equal(lineRow(screen), ' › What do you want to work through?');
    });
  });

  describe('completing with Tab', () => {
    it('completes an @ and the start of a name to the one it fits, with a space after', async () => {
      const s = await reading();
      s.type('Is @Sa');
      assert.equal(listRow(s.screen()), ' ❯ @Sam  person', 'a row each, as the / list has (T39)');
      s.type('\t');
      assert.equal(lineRow(s.screen()), ' › Is @Sam');
      assert.deepEqual(s.tab.render(80, 20).cursor, { x: 3 + 'Is @Sam '.length, y: 17 }, 'the cursor after it');
      s.type('can you?');
      assert.equal(lineRow(s.screen()), ' › Is @Sam can you?');
    });

    it('lists those that fit, agents before people and those here first, and cycles through them with each Tab', async () => {
      const s = await reading();
      s.type('@C');
      assert.deepEqual(s.screen().slice(-6, -3), [' ❯ @Claude       listening', '   @Claude Code  not connected', '   @Codex        not connected'], 'a row each, an agent with what it is doing (T39)');
      assert.equal(lineRow(s.screen()), ' › @C');
      s.type('\t');
      assert.equal(lineRow(s.screen()), ' › @Claude');
      s.type('\t');
      assert.equal(lineRow(s.screen()), ' › @Claude Code');
      s.type('\t');
      assert.equal(lineRow(s.screen()), ' › @Codex');
      s.type('\t');
      assert.equal(lineRow(s.screen()), ' › @Claude', 'and round again');
      assert.deepEqual(s.screen().slice(-6, -3).map((l) => l.slice(3, 15).trimEnd()), ['@Claude', '@Claude Code', '@Codex'], 'the list stays while cycling');
      const marked = (at: number) => s.screen()[s.screen().length - 6 + at].startsWith(' ❯ ');
      assert.ok(marked(0), 'the one written is marked');
      s.type('\t');
      assert.ok(marked(1));
      s.type('x');
      assert.equal(lineRow(s.screen()), ' › @Claude Code x', 'a letter ends the cycle');
      assert.equal(s.screen().at(-4)!.trim(), '', 'and the list with it, there being nothing to complete');
    });

    it('moves through the @ list with ↑ ↓ rather than scrolling, wrapping at the ends (T39)', async () => {
      const s = await reading();
      s.type('@C');
      s.type(keys.down);
      assert.equal(lineRow(s.screen()), ' › @Claude');
      s.type(keys.down);
      assert.equal(lineRow(s.screen()), ' › @Claude Code');
      assert.ok(s.screen().at(-5)!.startsWith(' ❯ @Claude Code'));
      s.type(keys.up + keys.up);
      assert.equal(lineRow(s.screen()), ' › @Codex', 'up from the first goes round to the last');
      s.type('x' + keys.clear + 'plain words');
      assert.equal(keysRow(s.screen()), ' Enter send · ↑↓ PgUp PgDn scroll · Tab complete · Esc clear', 'with no list, the arrows scroll again');
    });

    it('completes a name with a space in it, typed in part, and in the middle of a message', async () => {
      const s = await reading();
      s.type('Hi @Claude C');
      assert.equal(listRow(s.screen()), ' ❯ @Claude Code  not connected');
      s.type('\t');
      assert.equal(lineRow(s.screen()), ' › Hi @Claude Code');
      s.type(keys.clear);
      s.type('ask @Co now');
      for (let i = 0; i < 4; i++) s.type(keys.left);
      s.type('\t\t');
      assert.equal(lineRow(s.screen()), ' › ask @Codex now', 'the space that follows is not doubled');
      assert.deepEqual(s.tab.render(80, 20).cursor, { x: 3 + 'ask @Codex '.length, y: 17 });
    });

    it('leaves a word that is no @ alone, and Tab with nothing to complete does nothing', async () => {
      const s = await reading();
      s.type('me@sa mail');
      s.type('\t');
      assert.equal(lineRow(s.screen()), ' › me@sa mail');
      s.type(keys.clear);
      s.type('@Nobody');
      s.type('\t');
      assert.equal(lineRow(s.screen()), ' › @Nobody');
      assert.equal(s.screen().at(-4)!.trim(), '');
      s.type(keys.clear);
      s.type('\t');
      assert.equal(lineRow(s.screen()), ' › Reply to Claude…');
    });

    it('completes a "/" to an agent’s skill, written as the page writes it, in front of the message', async () => {
      const s = await reading({ skills: [{ name: 'Claude', state: 'listening', present: true, skills: [{ name: 'review', description: 'Review a diff' }, { name: 'release', description: 'Cut a release' }, { name: 'plan', description: 'Plan work' }] }, { name: 'Codex', state: 'idle', present: false, skills: [{ name: 'review', description: 'Review it, Codex’s way' }] }] });
      s.type('please /re');
      await s.settle();
      assert.deepEqual(s.screen().slice(-6, -3).map((l) => l.trimEnd()), [
        ' ❯ /review   Review a diff · Claude',
        '   /release  Cut a release · Claude',
        '   /review   Review it, Codex’s way · Codex',
      ], 'a row each, with what it does and whose it is');
      s.type('\t');
      assert.equal(lineRow(s.screen()), ' › @Claude /review please');
      s.type('\t');
      assert.equal(lineRow(s.screen()), ' › @Claude /release please');
      s.type('\t');
      assert.equal(lineRow(s.screen()), ' › @Codex /review please');
      s.type(keys.clear);
      s.type('/pl\t');
      assert.equal(lineRow(s.screen()), ' › @Claude /plan');
      s.type(keys.clear);
      s.type('@Sam /re\t');
      assert.equal(lineRow(s.screen()), ' › @Claude /review', 'the mention that only said who it was for is replaced');
    });

    it('reads what each agent can run from the board when a "/" is typed, and not before', async () => {
      let reads = 0;
      const s = await reading({ skills: [{ name: 'Claude', state: 'listening', present: true, skills: [{ name: 'review', description: 'Review a diff' }] }] });
      const was = s.tab as unknown as { threads: { host: { access: { skills(): Promise<AgentSkills[]> } } } };
      const inner = was.threads.host.access.skills;
      was.threads.host.access.skills = async () => (reads++, inner());
      s.type('no slash, @Sa');
      await s.settle();
      assert.equal(reads, 0);
      s.type(keys.clear + '/r');
      await s.settle();
      s.type('e');
      await s.settle();
      assert.equal(reads, 1, 'once, kept for a minute');
    });

    it('says nothing is listed for a "/" no agent has reported', async () => {
      const s = await reading();
      s.type('/re\t');
      await s.settle();
      assert.equal(lineRow(s.screen()), ' › /re', 'unchanged');
    });
  });

  describe('who will get it', () => {
    const say = async (setup: (s: Stand) => void, typed = '') => {
      const s = await reading();
      setup(s);
      if (typed) s.type(typed);
      return statusRow(s.screen());
    };

    it('names the agent a reply goes to, and whether it is listening or between steps', async () => {
      assert.equal(await say(() => {}), ' to Flaky test · Claude hears it');
      assert.equal(await say((s) => (s.live = { ...s.live!, presence: [{ name: 'Claude', lastSeen: ago(0), state: 'working' }] })), ' to Flaky test · Claude hears it at the next check');
    });

    it('says an agent that is not here isn’t listening', async () => {
      assert.equal(await say((s) => (s.live = { ...s.live!, presence: [{ name: 'Claude', lastSeen: ago(0), state: 'away' }] })), " to Flaky test · Claude isn't listening here");
    });

    it('follows the mentions typed: who it is for, and for people only', async () => {
      assert.equal(await say((s) => (s.live = { ...s.live!, presence: [{ name: 'Claude', lastSeen: ago(0), state: 'listening' }, { name: 'Codex', lastSeen: ago(0), state: 'working' }] }), '@Codex take this '), ' to Flaky test · Codex hears it at the next check');
      assert.equal(await say(() => {}, '@Sam what do you think? '), ' to Flaky test · for Sam only');
      assert.equal(await say(() => {}, '@Codex you? '), " to Flaky test · Codex isn't listening here", 'an agent named that is not here');
    });

    it('says who is listening for a new thread, and that none is when none is', async () => {
      const s = stand([talk]);
      s.live = { ...s.live!, presence: [{ name: 'Claude', lastSeen: ago(0), state: 'listening' }, { name: 'Codex', lastSeen: ago(0), state: 'working' }] };
      await s.open();
      s.type('n');
      assert.equal(statusRow(s.screen()), ' New thread · Claude and Codex are listening.');
      s.live = { ...s.live!, presence: [{ name: 'A', lastSeen: ago(0), state: 'listening' }, { name: 'B', lastSeen: ago(0), state: 'listening' }, { name: 'C', lastSeen: ago(0), state: 'listening' }] };
      assert.equal(statusRow(s.screen()), ' New thread · 3 agents are listening.');
      s.live = { ...s.live!, presence: [{ name: 'Claude', lastSeen: ago(0), state: 'away' }] };
      assert.equal(statusRow(s.screen(120)), " New thread · Claude isn't listening here. Say to Claude: “Start listening on Tricot”");
      s.live = { ...s.live!, presence: [] };
      assert.equal(statusRow(s.screen(120)), " New thread · Claude isn't listening here. Say to Claude: “Start listening on Tricot”", 'one this terminal runs, not on the board yet');
      s.agents = [];
      assert.equal(statusRow(s.screen()), ' New thread · No agent is listening on this board: what you send waits for one.');
    });
  });

  // A tag after an agent's name, for one message (core/agentTags.ts): Tab
  // completes its models, then its levels, and the row under the line says
  // what the message runs on, or, alerting, that the agent can't switch.
  describe('a tag for one message', () => {
    const here = (s: Stand) => (s.live = { ...s.live!, presence: [{ name: 'Claude', lastSeen: ago(0), state: 'listening' }, { name: 'Codex', lastSeen: ago(0), state: 'listening' }] });

    it("lists the agent's models after its name and a colon, then its levels after another, and Tab writes each", async () => {
      const s = await reading();
      s.type('@Claude:');
      assert.equal(listRow(s.screen()), ' Tab opus  sonnet  haiku  fable');
      s.type('\t');
      assert.equal(lineRow(s.screen()), ' › @Claude:opus', 'the model, with nothing after it, for a colon');
      s.type('\t');
      assert.equal(lineRow(s.screen()), ' › @Claude:sonnet', 'each Tab the next');
      s.type(':');
      assert.equal(listRow(s.screen()), ' Tab low  medium  high  xhigh  max');
      s.type('h');
      assert.equal(listRow(s.screen()), ' Tab high');
      s.type('\t');
      assert.equal(lineRow(s.screen()), ' › @Claude:sonnet:high', 'a level ends the tag, with a space');
      s.type('redo it');
      assert.equal(lineRow(s.screen()), ' › @Claude:sonnet:high redo it');
    });

    it('takes a colon after a name Tab wrote in the place of its space, so the models follow', async () => {
      const s = await reading();
      s.type('@Cla\t');
      assert.equal(lineRow(s.screen()), ' › @Claude');
      s.type(':');
      assert.equal(lineRow(s.screen()), ' › @Claude:');
      assert.equal(listRow(s.screen()), ' Tab opus  sonnet  haiku  fable');
      s.type(keys.clear + '@Sa\t:');
      assert.equal(lineRow(s.screen()), ' › @Sam :', "a person's name keeps its space");
    });

    it('lists nothing after the name of an agent that cannot take a tag', async () => {
      const s = await reading();
      s.type('@Codex:');
      assert.equal(s.screen().at(-4)!.trim(), '');
      s.type('\t');
      assert.equal(lineRow(s.screen()), ' › @Codex:', 'Tab writes nothing');
    });

    it('says under the line what a new thread runs on', async () => {
      const s = stand([talk]);
      here(s);
      s.more = { actors: [sam, { kind: 'agent', name: 'Codex' }] };
      await s.open();
      s.type('n');
      s.type('@Claude:opus:high can you redo the picker spacing?');
      assert.equal(statusRow(s.screen(160)), ' New thread · to Claude, on Opus at high thinking · Claude is listening: this is seen at once.');
      s.type(keys.clear + '@Claude:opus can you?');
      assert.equal(statusRow(s.screen(160)), ' New thread · to Claude, on Opus · Claude is listening: this is seen at once.', 'until a level is chosen, the model alone');
      s.type(keys.clear + '@Claude can you?');
      assert.equal(statusRow(s.screen(160)), ' New thread · Claude is listening: this is seen at once.', 'a plain mention as before');
    });

    it("says, in the alert colour, that an agent that can't switch will use its own, and a tag Claude can't read", async () => {
      const s = stand([talk]);
      here(s);
      s.more = { actors: [sam, { kind: 'agent', name: 'Codex' }] };
      await s.open();
      s.type('n');
      s.type('@Codex:gpt-6.1-sol:high can you check the migration order?');
      assert.equal(statusRow(s.screen(160)), " New thread · Codex can't switch models for one message: it will use its own. Codex is listening: this is seen at once.");
      assert.ok(s.tab.render(160, 20).rows.at(-2)!.includes('38;5;214'), 'in the alert colour');
      s.type(keys.clear + '@Claude:opus:ultra go');
      assert.equal(statusRow(s.screen(200)), ' New thread · Claude\'s thinking level is one of low, medium, high, xhigh or max: "ultra" isn\'t one. Claude will use its own. Claude is listening: this is seen at once.');
      s.type(keys.clear + '@Claude:opus:high go');
      assert.ok(!s.tab.render(160, 20).rows.at(-2)!.includes('38;5;214'), 'and not for one it takes');
      s.type('\r');
      assert.deepEqual(s.sent.at(-1), { kind: 'start', text: '@Claude:opus:high go' }, 'sent as written');
    });

    it('says what a reply runs on after who hears it', async () => {
      const s = await reading();
      s.type('@Claude::high and the header?');
      assert.equal(statusRow(s.screen(120)), ' to Flaky test · Claude hears it, at high thinking');
    });
  });

  describe('what it is made of', () => {
    it('reads Tab, Shift+Tab, ← and → as keys of their own, in the forms a terminal sends them', () => {
      const read = (text: string) => new TabKeyReader().read(Buffer.from(text, 'latin1'));
      assert.deepEqual(read('\t'), [{ kind: 'tab' }]);
      assert.deepEqual(read('\x1b[Z'), [{ kind: 'backtab' }]);
      assert.deepEqual(read('\x1b[D\x1b[C\x1bOD\x1bOC'), [{ kind: 'left' }, { kind: 'right' }, { kind: 'left' }, { kind: 'right' }]);
      assert.deepEqual(read('\x1b[9u\x1b[9;2u'), [{ kind: 'tab' }, { kind: 'backtab' }], 'and in the keyboard protocol’s');
    });

    it('sends through the routes table and says why when the board did not take it', async () => {
      const calls: { route: string; body: Record<string, unknown> }[] = [];
      let reply: unknown;
      const sender = threadsSender('roadmap-1', { act: async (route, body) => (calls.push({ route, body }), reply as never) });
      const made = thread('n', 'Hello', [message(me, 'Hello', 0)]);
      reply = { ok: true, reply: made };
      assert.deepEqual(await sender.start('Hello'), { ok: true, thread: made });
      assert.deepEqual(await sender.reply('a thread/1', 'Yes'), { ok: true, thread: made });
      assert.deepEqual(calls, [
        { route: '/api/boards/roadmap-1/threads', body: { body: 'Hello', door: 'threads' } },
        { route: '/api/threads/a%20thread%2F1/messages', body: { body: 'Yes' } },
      ]);
      reply = { ok: false, error: 'Let it in.', needsSeat: true };
      assert.deepEqual(await sender.reply('t', 'Yes'), { ok: false, error: 'Let it in.', needsSeat: true });
      reply = { ok: false, error: 'No such thread.', gone: true };
      assert.deepEqual(await sender.reply('t', 'Yes'), { ok: false, error: 'No such thread.' });
      reply = { ok: true, reply: { not: 'a thread' } };
      assert.deepEqual(await sender.reply('t', 'Yes'), { ok: false, error: "The board's answer wasn't a thread." });
    });

    it('comments on a card or about a pinned part, and reacts to a comment by where it is, through the routes table', async () => {
      const calls: { route: string; body: Record<string, unknown> }[] = [];
      let reply: unknown;
      const sender = threadsSender('roadmap-1', { act: async (route, body) => (calls.push({ route, body }), reply as never) });
      const said: Comment = { id: 'c9', author: me, body: 'Yes', createdAt: ago(0) };
      reply = { ok: true, reply: { id: 't1', title: 'A task', comments: [{ ...said, id: 'c1', body: 'Before' }, said] } };
      assert.deepEqual(await sender.comment({ kind: 'task', id: 't1' }, 'Yes'), { ok: true, comment: said }, 'a card answers with itself: its latest comment');
      reply = { ok: true, reply: { id: 'd7', question: 'Which?', comments: [said] } };
      assert.deepEqual(await sender.comment({ kind: 'decision', id: 'd7' }, 'Yes'), { ok: true, comment: said });
      reply = { ok: true, reply: { pin: { id: 'p1' }, comment: said } };
      assert.deepEqual(await sender.comment({ kind: 'pin', id: 'p1' }, 'Yes'), { ok: true, comment: said });
      reply = { ok: true, reply: said };
      await sender.reactToComment({ kind: 'task', id: 't1' }, 'c9', '👍', false);
      await sender.reactToComment({ kind: 'decision', id: 'd7' }, 'c9', '👎', true);
      assert.deepEqual(await sender.reactToComment({ kind: 'pin', id: 'p1' }, 'c9', '👀', false), { ok: true, comment: said });
      assert.deepEqual(calls, [
        { route: routeUrl(routes.commentOnTask, { taskId: 't1' }), body: { body: 'Yes' } },
        { route: routeUrl(routes.commentOnDecision, { decisionId: 'd7' }), body: { body: 'Yes' } },
        { route: routeUrl(routes.commentOnPin, { id: 'p1' }), body: { body: 'Yes' } },
        { route: routeUrl(routes.reactToTaskComment, { taskId: 't1', commentId: 'c9' }), body: { emoji: '👍' } },
        { route: routeUrl(routes.reactToDecisionComment, { decisionId: 'd7', commentId: 'c9' }), body: { emoji: '👎', remove: true } },
        { route: routeUrl(routes.reactToPinComment, { pinId: 'p1', commentId: 'c9' }), body: { emoji: '👀' } },
      ]);
      reply = { ok: false, error: 'The board is archived.' };
      assert.deepEqual(await sender.comment({ kind: 'task', id: 't1' }, 'Yes'), { ok: false, error: 'The board is archived.' });
      reply = { ok: true, reply: { pin: { id: 'p1' } } };
      assert.deepEqual(await sender.comment({ kind: 'pin', id: 'p1' }, 'Yes'), { ok: false, error: "The board's answer wasn't a comment." });
    });
  });

  describe('in a narrow window and a wide one', () => {
    it('fits at 70 columns with a reply half typed, the row under it and the keys, and at 120 beside the panel', async () => {
      const s = await reading();
      s.type('Raise the timeout to 5 s and see if the');
      const narrow = s.screen(70, 14);
      assert.ok(narrow.every((l) => columns(l) <= 70));
      assert.equal(narrow[0], only('Flaky test'));
      assert.equal(lineRow(narrow), ' › Raise the timeout to 5 s and see if the');
      assert.equal(statusRow(narrow), ' to Flaky test · Claude hears it');
      assert.equal(keysRow(narrow), ' Enter send · ↑↓ PgUp PgDn scroll · Tab complete · Esc clear');
      const wide = s.screen(120, 14);
      assert.ok(wide.every((l) => columns(l) <= 120));
      assert.deepEqual(sides(wide[0]), [only('Flaky test'), ' Threads']);
      assert.match(wide[1], /^ {2}You {2}3 min ago +│ ❯   Flaky test +2 min ago$/);
      assert.equal(lineRow(wide), ' › Raise the timeout to 5 s and see if the', 'the line runs under both');
      assert.equal(keysRow(wide), ' Enter send · ↑↓ PgUp PgDn scroll · Tab complete · Esc clear');
    });

    it('puts the line and the rows with it on one band across the window, under both columns, with the keys plain under it', async () => {
      const s = await reading();
      s.type('@C');
      for (const [cols, light] of [[120, false], [70, true]] as const) {
        const frame = s.tab.render(cols, 14, light);
        assert.deepEqual(frame.plain.slice(-6, -3).map((l) => l.trimEnd()), [' ❯ @Claude       listening', '   @Claude Code  not connected', '   @Codex        not connected']);
        for (const y of [-6, -5, -4, -3, -2]) {
          const codes = frame.rows.at(y)!.replace(/\x1b\[0m(?:\x1b\[K)?$/, '').match(/\x1b\[[0-9;]*m/g)!;
          assert.ok(codes.every((code) => code.endsWith(`;${bandOf(light)}m`)), `${cols}: row ${y}, every part on the band`);
          assert.equal(columns(frame.plain.at(y)!), cols, `${cols}: row ${y}, across the window`);
        }
        assert.ok(!frame.rows.at(-7)!.includes('48;'), 'the thread above it on the terminal’s own background');
        assert.ok(!frame.rows.at(-1)!.includes('48;'), 'and the keys under it');
        assert.deepEqual(frame.cursor, { x: 5, y: 11 }, 'the cursor after what is typed, on the line');
      }
    });

    it('draws the line and what goes with it at every size it is given, with the cursor on it', async () => {
      const s = await reading();
      s.type('@C so what do you think of ' + 'a very long reply '.repeat(8));
      for (const [cols, rows] of [[120, 14], [100, 6], [70, 5], [70, 8], [40, 4], [30, 9], [20, 3], [10, 5], [80, 2]] as const) {
        const frame = s.tab.render(cols, rows);
        assert.equal(frame.rows.length, rows, `${cols}×${rows}`);
        assert.ok(frame.plain.every((l) => columns(l) <= cols), `${cols}×${rows}:\n${frame.plain.join('\n')}`);
        if (frame.cursor) {
          assert.ok(frame.cursor.x < cols && frame.cursor.y < rows, `${cols}×${rows}: ${JSON.stringify(frame.cursor)}`);
          assert.match(frame.plain[frame.cursor.y], /^ [ ›↑↓] /, `the cursor is on the line at ${cols}×${rows}`);
        }
      }
      const sgr = new Set(s.tab.render(120, 14).rows.join('').match(/\x1b\[[0-9;]*m/g));
      for (const code of sgr) assert.match(code, LOOKS, `only the tab's own looks: ${JSON.stringify(code)}`);
    });

    it('draws a name from the board as plain text, however odd, on the line’s rows', async () => {
      const hostile: Actor = { kind: 'agent', name: 'Cl\x1b[2Jaude\x07' };
      const s = await reading({ actors: [hostile] });
      s.type('@Cl');
      const frame = s.tab.render(80, 20);
      const raw = frame.rows.join('').replace(/\x1b\[[0-9;]*m|\x1b\[K/g, '');
      assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(raw), 'nothing a name holds reaches the terminal as a sequence');
      assert.ok(frame.plain.some((l) => l.includes('@Cl [2Jaude')), frame.plain.join('\n'));
    });

    it('shows what is at the foot when the window is too short for all of it: the line, and the status in place of the keys', async () => {
      const s = await reading();
      s.type('@C');
      const short = s.screen(80, 7);
      assert.equal(short.at(-3), ' ❯ @Claude  listening', 'the list from six rows, a row of it');
      assert.equal(short.at(-2), ' › @C');
      assert.equal(keysRow(short), ' Enter send · ↑↓ pick · Tab complete · Esc clear', 'the arrows pick in the list (T39)');
      const tiny = s.screen(80, 5);
      assert.equal(tiny.at(-2), ' › @C');
      s.live = { ...s.live!, presence: [] };
      s.agents = [];
      assert.equal(s.screen(80, 5).at(-1), " to Flaky test · Claude isn't listening here", 'what is wrong takes the place of the keys');
    });
  });
});

describe("the Tricot tab's threads: the lens", () => {
  const CTRL_L = '\x0c';
  const CLEAR = '\x15';
  const flaky = answered('a', 'Flaky test', 5 * MIN);
  const legal = answered('b', 'Licence check', 60 * MIN, { lens: { name: 'Legal' } });
  const pricing = answered('c', 'Pricing page', 90 * MIN, { lens: { name: 'Pricing', brief: 'Weigh cost against value.' } });
  const PRESETS = ['General', 'Legal', 'Design', 'Performance', 'Security', 'Architect', 'Marketing'];

  // The picker's rows: the name of each, in order, with the one highlighted and the one marked.
  const rowsOf = (screen: string[]) => screen.slice(1).filter((l) => /^ [❯ ] [✓ ] \S/.test(l));
  const nameOf = (line: string) => line.slice(5).split('  ')[0].trim();
  const highlighted = (screen: string[]) => nameOf(rowsOf(screen).find((l) => l.startsWith(' ❯'))!);
  const marked = (screen: string[]) => rowsOf(screen).filter((l) => l[3] === '✓').map(nameOf);
  const keysRow = (screen: string[]) => screen.at(-1)!;

  async function listing(threads: Thread[] = [flaky, legal, pricing]): Promise<Stand> {
    const s = stand(threads);
    s.more = { actors: [sam] };
    await s.open();
    return s;
  }

  describe('from the panel', () => {
    it('opens with l over the highlighted thread: the presets first, then the lenses of one’s own the board has, then New lens…, the current one marked and highlighted', async () => {
      const s = await listing();
      assert.match(keysRow(s.screen()), /n new · x delete · Esc close · l lens$/, 'the panel says so');
      s.type('l');
      const screen = s.screen();
      assert.equal(screen[0], ' Lens · Flaky test');
      assert.deepEqual(rowsOf(screen).map(nameOf), [...PRESETS, 'Pricing', 'New lens…']);
      assert.equal(rowsOf(screen)[0], ' ❯ ✓ General', 'General, as the thread has none');
      assert.deepEqual(marked(screen), ['General']);
      assert.match(rowsOf(screen)[1], /^ {5}Legal {8}Review licences, terms of service and privacy\./, 'each with its brief, which line up');
      assert.match(rowsOf(screen).at(-2)!, /^ {5}Pricing {6}Weigh cost against value\.$/);
      assert.equal(keysRow(screen), ' ↑↓ pick · Enter set · Esc cancel');
      lacks(screen, 'Licence check');
      assert.ok(screen.every((l) => columns(l) <= 80));
    });

    it('starts on the thread’s own lens, a preset or one of its own', async () => {
      const s = await listing();
      s.type('jl');
      assert.equal(s.screen()[0], ' Lens · Licence check');
      assert.equal(highlighted(s.screen()), 'Legal');
      assert.deepEqual(marked(s.screen()), ['Legal']);
      s.type('\x1b');
      s.type('jl');
      assert.equal(highlighted(s.screen()), 'Pricing');
      assert.deepEqual(marked(s.screen()), ['Pricing']);
    });

    it('moves with the arrows and j k, wrapping, and Home and End; Esc cancels and changes nothing', async () => {
      const s = await listing();
      s.type('l');
      s.type('\x1b[B');
      assert.equal(highlighted(s.screen()), 'Legal');
      s.type('j');
      assert.equal(highlighted(s.screen()), 'Design');
      s.type('k\x1b[A');
      assert.equal(highlighted(s.screen()), 'General');
      s.type('\x1b[A');
      assert.equal(highlighted(s.screen()), 'New lens…', 'up from the first goes round to the last');
      s.type('\x1b[B');
      assert.equal(highlighted(s.screen()), 'General');
      s.type('\x1b[F');
      assert.equal(highlighted(s.screen()), 'New lens…');
      s.type('\x1b[H');
      assert.equal(highlighted(s.screen()), 'General');
      s.type('x');
      assert.equal(highlighted(s.screen()), 'General', 'a letter that is no key does nothing');
      s.type('j\x1b');
      assert.deepEqual(s.sent, []);
      assert.equal(s.screen()[0], ' Threads', 'the panel again');
      assert.equal(keysRow(s.screen()), PANEL_KEYS);
      assert.equal(s.quits, 0);
      s.type('\x1b');
      assert.match(s.screen()[0], /^ Tricot · /, 'and Esc after it goes back to the tab, as before');
    });

    it('sets the lens on Enter through the board, and the panel then shows it before the title', async () => {
      const s = await listing();
      s.type('l\x1b[B\x1b[B');
      s.type('\r');
      assert.deepEqual(s.sent, [{ kind: 'lens', thread: 'a', lens: { name: 'Design' } }]);
      await s.settle();
      const screen = await refreshed(s);
      assert.equal(screen[0], ' Threads', 'the picker closes');
      shows(screen, row(' ❯   Design · Flaky test', '5 min ago'));
      assert.equal(s.threads[0].lens?.name, 'Design');
    });

    it('sets General as no lens at all, and keeps the agent a lens is routed to when another is picked', async () => {
      const routed = answered('r', 'Routed', 3 * MIN, { lens: { name: 'Design', agent: 'Claude' } });
      const s = await listing([routed, legal]);
      s.type('l');
      assert.equal(highlighted(s.screen()), 'Design', 'it starts on the thread’s lens');
      s.type('\x1b[H\x1b[B'); // Legal
      s.type('\r');
      await s.settle();
      assert.deepEqual(s.sent, [{ kind: 'lens', thread: 'r', lens: { name: 'Legal', agent: 'Claude' } }], 'the agent stays');
      s.type('jl');
      s.type('\x1b[H\r');
      await s.settle();
      assert.deepEqual(s.sent.at(-1), { kind: 'lens', thread: 'b', lens: null }, 'General is none');
      const screen = await refreshed(s);
      lacks(screen, 'General');
      shows(screen, row(' ❯   Licence check', '1 h ago'));
    });

    it('does not take Enter again while the board is setting it, and shows that it is', async () => {
      const s = await listing();
      let release!: () => void;
      s.gate = new Promise<void>((resolve) => (release = resolve));
      s.type('jl');
      s.type('\r');
      s.type('\r\x1b[B\x1b');
      assert.equal(s.sent.length, 1);
      assert.ok(s.screen().includes(' Setting the lens…'), s.screen().join('\n'));
      assert.equal(highlighted(s.screen()), 'Legal', 'the keys wait');
      release();
      await s.settle();
      assert.equal(s.screen()[0], ' Threads');
    });

    it('asks for a lens of one’s own in two steps, a name and then a brief, on the line at the foot', async () => {
      const s = await listing();
      s.type('l\x1b[F\r');
      let screen = s.screen(80, 14);
      assert.equal(screen[0], ' Lens · Flaky test');
      assert.equal(screen[1], '  Name it, e.g. Pricing.');
      assert.equal(screen.at(-3), ' › Name, e.g. Pricing');
      assert.equal(screen.at(-2), ` 0 of ${LENS_NAME_LIMIT} characters`);
      assert.equal(keysRow(screen), ' Enter next · Esc back to the lenses');
      assert.ok(s.tab.typing);
      s.type('Compliance');
      assert.equal(s.screen(80, 14).at(-3), ' › Compliance');
      assert.equal(s.screen(80, 14).at(-2), ` 10 of ${LENS_NAME_LIMIT} characters`);
      s.type('\r');
      screen = s.screen(80, 14);
      assert.equal(screen[1], '  Name: Compliance');
      assert.equal(screen[2], '  Say how agents should answer through it, in a sentence or two.');
      assert.equal(screen.at(-3), ' › How agents should answer, in a sentence or two');
      assert.equal(keysRow(screen), ' Enter next · Esc back to the lenses'.replace('next', 'use this lens'));
      assert.deepEqual(s.sent, []);
      s.type('Check each claim against our terms.\r');
      await s.settle();
      assert.deepEqual(s.sent, [{ kind: 'lens', thread: 'a', lens: { name: 'Compliance', brief: 'Check each claim against our terms.' } }]);
      const after = await refreshed(s);
      shows(after, row(' ❯   Compliance · Flaky test', '5 min ago'));
      s.type('l');
      assert.deepEqual(marked(s.screen()), ['Compliance'], 'and it is now one of the lenses of one’s own, current, the one most lately used first');
      assert.deepEqual(rowsOf(s.screen()).slice(-3).map(nameOf), ['Compliance', 'Pricing', 'New lens…']);
    });

    it('holds a lens name and brief to the limits, asks for both, and will not take a preset’s name', async () => {
      const s = await listing();
      s.type('l\x1b[F\r');
      s.type('\r');
      assert.equal(s.screen(80, 14).at(-2), ' Give it a name first.');
      s.type('x'.repeat(LENS_NAME_LIMIT + 10));
      assert.equal(s.screen(80, 14).at(-3), ` › ${'x'.repeat(LENS_NAME_LIMIT)}`, 'no more than the name may hold');
      assert.equal(s.screen(80, 14).at(-2), ` ${LENS_NAME_LIMIT} of ${LENS_NAME_LIMIT} characters`, 'and the first message is gone with typing');
      s.type(CLEAR + ' legal ');
      s.type('\r');
      assert.equal(s.screen(80, 14).at(-2), ' Legal is one of the lenses already: name yours something else.');
      assert.equal(s.screen(80, 14)[1], '  Name it, e.g. Pricing.', 'still on the name');
      s.type(CLEAR + 'Pricing 2\r');
      s.type('\r');
      assert.equal(s.screen(80, 14).at(-2), ' Say how agents should answer through it first.');
      s.type('y'.repeat(LENS_BRIEF_LIMIT + 5));
      assert.equal(s.screen(80, 14).at(-2), ` ${LENS_BRIEF_LIMIT} of ${LENS_BRIEF_LIMIT} characters`);
      s.type('\x1b');
      assert.equal(highlighted(s.screen(80, 14)), 'New lens…', 'Esc goes back to the lenses, with nothing sent');
      assert.deepEqual(s.sent, []);
      assert.ok(!s.tab.typing);
      s.type('\x1b');
      assert.equal(s.screen()[0], ' Threads');
    });

    it('keeps the choice and says why when the board refuses, and sets it when Enter is pressed again', async () => {
      const s = await listing();
      s.type('l\x1b[B\x1b[B');
      s.refusing = { error: 'The board refused the lens (HTTP 500).' };
      s.type('\r');
      await s.settle();
      let screen = s.screen();
      assert.equal(screen[0], ' Lens · Flaky test', 'the picker stays');
      assert.equal(highlighted(screen), 'Design', 'where it was');
      assert.ok(screen.includes(' The board refused the lens (HTTP 500).'), screen.join('\n'));
      assert.ok(s.tab.render(80, 20).rows.some((r) => r.includes('\x1b[0;38;5;214m The board refused')), 'in the alert colour');
      s.type('j');
      assert.ok(!s.screen().some((l) => l.includes('refused')), 'moving clears it');
      s.type('k');
      s.refusing = undefined;
      s.type('\r');
      await s.settle();
      assert.equal(s.threads[0].lens?.name, 'Design');
      assert.equal(s.screen()[0], ' Threads');
    });

    it('asks to be let in when the board says this terminal must be, and keeps the choice', async () => {
      const s = await listing();
      s.type('jl');
      s.refusing = { error: 'Not a seat.', needsSeat: true };
      s.type('\r');
      await s.settle();
      assert.ok(s.screen().includes(' This terminal must be let in first: Enter asks, and your choice is kept.'), s.screen().join('\n'));
      s.type('\r');
      assert.equal(s.seatAsked, 1, 'Enter asked');
      assert.equal(highlighted(s.screen()), 'Legal');
    });

    it('goes when its thread is deleted meanwhile, and does nothing on an empty board', async () => {
      const s = await listing();
      s.type('jl');
      s.change([flaky]);
      s.screen();
      await s.settle();
      assert.equal(s.screen()[0], ' Threads', 'the thread is gone, and the picker with it');
      const empty = await listing([]);
      empty.type('l');
      assert.equal(empty.screen()[0], ' Threads');
      assert.match(keysRow(empty.screen()), /^ ↑↓ pick · Enter read · n new · Esc close$/, 'and it does not offer l');
    });

    it('sits in the panel’s place beside the stream at 120 columns, and over it at 80', async () => {
      const s = await listing();
      s.type('l');
      const wide = s.screen(120, 14);
      assert.equal(sides(wide[0])[1], ' Lens · Flaky test');
      assert.match(wide[1], /│ ❯ ✓ General/);
      assert.equal(wide[0].indexOf('│'), 79, 'the stream stays in view beside it');
      assert.ok(wide.every((l) => columns(l) <= 120));
      assert.equal(s.screen(80, 14).filter((l) => l.includes('│')).length, 0, 'over the stream when narrow');
      for (const [cols, rows] of [[100, 6], [70, 5], [40, 4], [30, 12], [20, 3], [10, 5], [80, 2]] as const) {
        const frame = s.tab.render(cols, rows);
        assert.equal(frame.rows.length, rows, `${cols}×${rows}`);
        assert.ok(frame.plain.every((l) => columns(l) <= cols), `${cols}×${rows}:\n${frame.plain.join('\n')}`);
      }
      const short = s.screen(80, 6);
      assert.ok(short.some((l) => l.startsWith(' ❯ ✓ General')), 'a short window keeps the highlighted row in view');
      s.type('\x1b[F');
      assert.ok(s.screen(80, 6).some((l) => l.startsWith(' ❯   New lens…')), short.join('\n'));
      const sgr = new Set(s.tab.render(120, 14).rows.join('').match(/\x1b\[[0-9;]*m/g));
      for (const code of sgr) assert.match(code, LOOKS, `only the tab's own looks: ${JSON.stringify(code)}`);
    });
  });

  describe('in a thread picked', () => {
    const open = async (more: Thread[] = [flaky, legal, pricing]): Promise<Stand> => {
      const s = await listing(more);
      s.type('\r');
      return s;
    };

    it('opens with Ctrl+L, which no letter on the line is, in the panel’s place beside the thread, and Esc leaves what was typed as it was', async () => {
      const s = await open();
      assert.match(keysRow(s.screen()), /Esc everything · ↑↓ PgUp PgDn scroll · \^L lens$/);
      s.type('half a repl');
      s.type(CTRL_L);
      const wide = s.screen(120, 16);
      assert.deepEqual(sides(wide[0]), [only('Flaky test'), ' Lens · Flaky test']);
      assert.equal(keysRow(wide), ' ↑↓ pick · Enter set · Esc cancel');
      assert.equal(wide.some((l) => l.startsWith(' › ')), false, 'the line is out of the way while a lens is picked');
      s.type('\x1b');
      assert.deepEqual(sides(s.screen(120, 16)[0]), [only('Flaky test'), ' Threads'], 'the thread still picked, the panel back');
      assert.equal(s.screen(120, 16).at(-3), ' › half a repl', 'and what was typed');
      s.type('y');
      assert.equal(s.screen(120, 16).at(-3), ' › half a reply');
    });

    it('sets the lens of the thread picked, which the panel shows before its title, and the line is back with its text', async () => {
      const s = await open();
      s.type('hello');
      s.type(CTRL_L + '\x1b[B\x1b[B\r');
      await s.settle();
      assert.deepEqual(s.sent, [{ kind: 'lens', thread: 'a', lens: { name: 'Design' } }]);
      const screen = await refreshed(s, 120, 16);
      assert.match(screen[1], /│ ❯   Design · Flaky test +5 min ago$/);
      assert.equal(screen.at(-3), ' › hello');
      assert.ok(screen.at(-1)!.startsWith(' Enter send'));
    });

    it('takes the picker at 80 columns over the thread, and Esc gives the thread back', async () => {
      const s = await open();
      s.type(CTRL_L);
      const screen = s.screen();
      assert.equal(screen[0], ' Lens · Flaky test');
      assert.equal(screen.filter((l) => l.includes('You  5 min ago')).length, 0, 'the thread is out of the way');
      s.type('\x1b');
      assert.equal(s.screen()[0], only('Flaky test'));
    });

    it('keeps the thread the picker is for, though others move: it is by the thread, not the row', async () => {
      const s = await open();
      s.type(CTRL_L);
      s.change([legal, flaky, pricing]);
      s.screen();
      await s.settle();
      s.type('\x1b[B\r');
      await s.settle();
      assert.deepEqual(s.sent, [{ kind: 'lens', thread: 'a', lens: { name: 'Legal' } }]);
    });
  });

  describe('for a new thread', () => {
    it('is chosen with Ctrl+L on the new thread’s line before it is started, and the thread starts with it', async () => {
      const s = await listing();
      s.type('n');
      assert.match(keysRow(s.screen(120)), /^ Enter new thread · ↑↓ PgUp PgDn scroll · Tab complete @ \/ · Esc the latest · \^L lens$/);
      s.type('Is the font licence fine?');
      s.type(CTRL_L);
      assert.equal(s.screen()[0], ' Lens · New thread');
      assert.equal(keysRow(s.screen()), ' ↑↓ pick · Enter use · Esc cancel');
      assert.equal(highlighted(s.screen()), 'General');
      s.type('\x1b[B\r');
      assert.deepEqual(s.sent, [], 'nothing is sent: it goes with the first message');
      const wide = s.screen(120, 14);
      assert.match(wide.at(-2)!, /^ New thread · Legal · /, 'the row under the line says which lens');
      assert.equal(wide.at(-3), ' › Is the font licence fine?', 'and the text is as it was');
      s.type('\r');
      await s.settle();
      assert.deepEqual(s.sent, [{ kind: 'start', text: 'Is the font licence fine?', lens: { name: 'Legal' } }]);
      const screen = await refreshed(s, 120, 14);
      assert.equal(screen[0], only('Is the font licence fine?'), 'the thread started is picked');
      s.type('\x1b');
      s.type('/new\r');
      assert.match(s.screen(120, 14).at(-2)!, /^ New thread · Claude/, 'the next new thread begins as General again');
    });

    it('may be a lens of one’s own, and is kept when the board refuses the thread, and forgotten when it is cancelled', async () => {
      const s = await listing();
      s.type('n' + CTRL_L + '\x1b[F\r');
      s.type('Pricing 2\rWhat would a buyer pay?\r');
      assert.equal(s.sent.length, 0);
      assert.match(s.screen(120, 14).at(-2)!, /^ New thread · Pricing 2 · /);
      s.type('Should it be per seat?');
      s.refusing = { error: 'No.' };
      s.type('\r');
      await s.settle();
      assert.equal(s.screen(120, 14).at(-2), ' No.');
      s.type(CTRL_L);
      assert.deepEqual(marked(s.screen()), ['Pricing 2'], 'still there to try again, the current one');
      s.type('\x1b');
      s.type('\x1b\x1b'); // the text cleared, and then back to answering the latest
      s.type('/new\r');
      assert.match(s.screen(120, 14).at(-2)!, /^ New thread · Claude/);
      assert.deepEqual(s.sent.map((m) => m.lens), [{ name: 'Pricing 2', brief: 'What would a buyer pay?' }]);
    });
  });
});

describe("the Tricot tab's threads: reactions", () => {
  const codex: Actor = { kind: 'agent', name: 'Codex' };
  const first = message(me, 'Can you look at the flaky test?', 4 * MIN);
  const reply = message(claude, 'It passes alone and fails under load.', 3 * MIN);
  const again = message(me, 'Does it fail on main too?', 2 * MIN);
  const last = message(claude, 'Yes, on main as well.', MIN);
  const talk = thread('t', 'Flaky test', [first, reply, again, last]);
  const MARKED = '❯ Claude  agent · 1 min ago';
  const CHOSEN_ROW = ' to Flaky test, the one chosen · Claude hears it';
  // The person's own name in bold, on the tint its message sits on.
  const boldName = (name: string) => new RegExp(`\\x1b\\[0;1(?:;48;5;23[45])?m${name}`);
  const keys = { up: '\x1b[A', down: '\x1b[B', backspace: '\x7f', clear: '\x15', esc: '\x1b' };
  const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
  const keysRow = (screen: string[]) => screen.at(-1)!;
  const statusRow = (screen: string[]) => screen.at(-2)!;
  const lineRow = (screen: string[]) => screen.at(-3)!;
  const marked = (screen: string[]) => screen.filter((l) => l.startsWith('❯ ') || l.includes('│❯ ')).map((l) => l.slice(l.indexOf('❯')).trim());

  async function reading(threads: Thread[] = [talk]): Promise<Stand> {
    const s = stand(threads);
    s.more = { actors: [sam, codex] };
    await s.open();
    s.type('\r');
    return s;
  }
  // After a key that went to the board: the board's answer is taken, and the tab has read again.
  async function afterwards(s: Stand, cols = 80, rows = 20): Promise<string[]> {
    await s.settle();
    return refreshed(s, cols, rows);
  }
  const under = (screen: string[], text: string) => screen[screen.indexOf(text) + 1];
  const reactionRows = (screen: string[]) => screen.filter((l) => /^ {4}[👍👎👀]/u.test(l));

  describe('choosing a message', () => {
    it('chooses the latest message of someone else’s with Tab on an empty line, marks it, and says what the keys do', async () => {
      const s = await reading();
      assert.match(keysRow(s.screen()), /Tab react · Esc everything · ↑↓ PgUp PgDn scroll · \^L lens$/);
      s.type('\t');
      const screen = s.screen();
      assert.deepEqual(marked(screen), [MARKED]);
      assert.equal(statusRow(screen), CHOSEN_ROW);
      assert.equal(keysRow(screen), ' Tab ↑ earlier · ↓ later · 1 👍 · 2 👎 · 3 👀 · Esc the latest');
      assert.equal(lineRow(screen), ' › Reply to Claude…', 'the line is where it was');
      assert.ok(s.tab.typing);
      assert.ok(screen.every((l) => columns(l) <= 80));
    });

    it('moves between the messages of others with ↑ ↓, passing your own, and stops at the first and the last', async () => {
      const s = await reading();
      s.type('\t');
      s.type(keys.up);
      assert.deepEqual(marked(s.screen()), ['❯ Claude  agent · 3 min ago'], 'your own message between them is passed');
      s.type(keys.up);
      assert.deepEqual(marked(s.screen()), ['❯ Claude  agent · 3 min ago'], 'and the first of theirs is the first');
      s.type(keys.down);
      assert.deepEqual(marked(s.screen()), [MARKED]);
      s.type(keys.down);
      assert.deepEqual(marked(s.screen()), [MARKED], 'and the last is the last');
    });

    it('names whose message is chosen, and a person’s as well as an agent’s', async () => {
      const said = message(sam, 'I could try it on main.', 30_000);
      const s = await reading([thread('t', 'Flaky test', [first, reply, said])]);
      s.type('\t');
      assert.equal(lineRow(s.screen()), ' › Reply to Sam…');
      assert.deepEqual(marked(s.screen()), ['❯ Sam  just now']);
      s.type(keys.up);
      assert.equal(lineRow(s.screen()), ' › Reply to Claude…');
    });

    it('lets go of the message with Esc, keeps it while an answer is typed, and with none chosen Esc goes back to everything', async () => {
      const s = await reading();
      s.type('\t');
      s.type(keys.esc);
      assert.deepEqual(marked(s.screen()), []);
      assert.equal(s.screen()[0], only('Flaky test'), 'Esc let go of the message, not of the thread');
      assert.equal(statusRow(s.screen()), ' to Flaky test · Claude hears it');
      s.type('\t');
      s.type('x');
      assert.deepEqual(marked(s.screen()), [MARKED], 'a letter answers the one chosen');
      assert.equal(lineRow(s.screen()), ' › x');
      s.type('\t');
      assert.deepEqual(marked(s.screen()), [MARKED], 'with something on the line, Tab is for completing, not for choosing');
      s.type(keys.clear);
      s.type(paste('pasted'));
      assert.equal(lineRow(s.screen()), ' › pasted');
      s.type(keys.clear);
      s.type(keys.esc);
      assert.deepEqual(marked(s.screen()), []);
      s.type(keys.esc);
      assert.equal(s.screen()[0], ' Threads', 'and with none chosen, Esc goes on back to the panel');
    });

    it('does not choose while a reply is on its way, and never the message sending: the choice is among what the board has', async () => {
      const s = await reading();
      s.gate = new Promise<void>(() => {});
      s.type('Raise it to 5 s?\r');
      s.type('\t');
      const screen = s.screen();
      assert.ok(screen.includes('  You  sending…'));
      assert.deepEqual(marked(screen), [MARKED]);
      s.type(keys.down + keys.down);
      assert.deepEqual(marked(s.screen()), [MARKED], 'the message sending is not one to go down to');
    });

    it('says there is nothing to react to in a thread of one’s own messages, and chooses nothing', async () => {
      const s = await reading([thread('o', 'Notes', [message(me, 'A note to myself.', MIN)])]);
      s.type('\t');
      assert.match(statusRow(s.screen()), /^ There is nothing to react to here: reactions go to what others wrote/);
      assert.deepEqual(marked(s.screen()), []);
      assert.ok(s.tab.render(80, 20).rows.at(-2)!.includes(`\x1b[0;38;5;214;${BAND}m`), 'in the alert colour, on the band');
    });

    it('scrolls to show the message chosen, whichever way it moves, and says there is more', async () => {
      const long = Array.from({ length: 9 }, (_, i) => [message(me, `Question ${i}`, (30 - 2 * i) * MIN), message(claude, `Answer ${i} runs on and on, so it takes two lines at least in a narrow window.`, (29 - 2 * i) * MIN)]).flat();
      const s = await reading([thread('t', 'Long', long)]);
      const view = () => s.screen(50, 12);
      s.type('\t');
      assert.equal(marked(view()).length, 1, 'the latest');
      for (let i = 0; i < 9; i++) {
        assert.equal(marked(view()).length, 1, `message ${i} from the end is in view`);
        s.type(keys.up);
      }
      assert.ok(view().some((l) => l.includes('Answer 0')), 'the first answer, at the top');
      assert.equal(marked(view()).length, 1);
      for (let i = 0; i < 9; i++) {
        s.type(keys.down);
        assert.equal(marked(view()).length, 1, `message ${i} on the way down is in view`);
      }
      assert.ok(view().some((l) => l.includes('Answer 8')));
    });

    it('draws at every size it is given, with the cursor on the line, in the tab’s own looks', async () => {
      const s = await reading();
      s.type('\t');
      for (const [cols, rows] of [[120, 14], [100, 6], [70, 5], [40, 4], [30, 9], [20, 3], [10, 5], [80, 2]] as const) {
        const frame = s.tab.render(cols, rows);
        assert.equal(frame.rows.length, rows, `${cols}×${rows}`);
        assert.ok(frame.plain.every((l) => columns(l) <= cols), `${cols}×${rows}:\n${frame.plain.join('\n')}`);
        if (frame.cursor) assert.ok(frame.cursor.x < cols && frame.cursor.y < rows);
      }
      const wide = s.screen(120, 14);
      assert.ok(wide.some((l) => l.startsWith(MARKED) && l.includes('│')), 'beside the panel, the marker is at the stream’s edge');
      const sgr = new Set(s.tab.render(120, 14).rows.join('').match(/\x1b\[[0-9;]*m/g));
      for (const code of sgr) assert.match(code, LOOKS, `only the tab's own looks: ${JSON.stringify(code)}`);
    });

    it('lets go of a message that is deleted meanwhile', async () => {
      const s = await reading();
      s.type('\t');
      s.change([thread('t', 'Flaky test', [first, reply, again])]);
      s.screen();
      await s.settle();
      s.type(keys.down);
      assert.deepEqual(marked(s.screen()), [], 'it is no longer chosen');
    });
  });

  describe('reacting', () => {
    it('leaves 👍 on the message with 1, shows it under the message, and takes it back with 1 again', async () => {
      const s = await reading();
      s.type('\t1');
      assert.deepEqual(s.sent, [{ kind: 'react', thread: 't', message: last.id, emoji: '👍', remove: false }]);
      let screen = await afterwards(s);
      assert.equal(under(screen, '    Yes, on main as well.'), '    👍 You');
      assert.deepEqual(marked(screen), [MARKED], 'the message stays chosen');
      assert.match(s.tab.render(80, 20).rows.join(''), boldName('You'), 'one’s own is bold');
      s.type('1');
      assert.deepEqual(s.sent.at(-1), { kind: 'react', thread: 't', message: last.id, emoji: '👍', remove: true }, 'pressed again, it is taken back');
      screen = await afterwards(s);
      assert.notEqual(under(screen, '    Yes, on main as well.'), '    👍 You');
      assert.deepEqual(reactionRows(screen), []);
    });

    it('leaves 👎 with 2 and 👀 with 3, each its own, shown in that order whichever came first', async () => {
      const s = await reading();
      s.type('\t3');
      await afterwards(s);
      s.type('2');
      const screen = await afterwards(s);
      assert.deepEqual(s.sent.map((m) => m.emoji), ['👀', '👎']);
      assert.equal(under(screen, '    Yes, on main as well.'), '    👎 You · 👀 You');
    });

    it('reacts to the message chosen, not the latest', async () => {
      const s = await reading();
      s.type('\t' + keys.up + '3');
      await s.settle();
      assert.deepEqual(s.sent, [{ kind: 'react', thread: 't', message: reply.id, emoji: '👀', remove: false }]);
    });

    it('reacts to no other key, nor to a number that is no reaction: it is typed, answering the one chosen', async () => {
      const s = await reading();
      s.type('\t');
      s.type('4');
      assert.equal(s.sent.length, 0);
      assert.deepEqual(marked(s.screen()), [MARKED], 'a 4 is typed, as any letter is');
      assert.equal(lineRow(s.screen()), ' › 4');
    });

    it('takes one at a time: a second key waits out the first', async () => {
      const s = await reading();
      let release!: () => void;
      s.gate = new Promise<void>((resolve) => (release = resolve));
      s.type('\t12');
      assert.equal(s.sent.length, 1);
      release();
      await s.settle();
      s.type('2');
      await s.settle();
      assert.deepEqual(s.sent.map((m) => m.emoji), ['👍', '👎']);
    });

    it('shows what others left, an agent’s included, under their messages: who, in order, a few named and the rest counted', async () => {
      const liked = { ...reply, reactions: [{ emoji: '👍' as const, by: sam, at: ago(MIN) }, { emoji: '👍' as const, by: codex, at: ago(MIN) }, { emoji: '👍' as const, by: claude, at: ago(MIN) }, { emoji: '👀' as const, by: claude, at: ago(MIN) }] };
      const seen = { ...again, reactions: [{ emoji: '👀' as const, by: claude, at: ago(MIN) }] };
      const mine = { ...last, reactions: [{ emoji: '👎' as const, by: me, at: ago(MIN) }, { emoji: '👀' as const, by: codex, at: ago(MIN) }] };
      const s = await reading([thread('t', 'Flaky test', [first, liked, seen, mine])]);
      const screen = s.screen();
      assert.equal(under(screen, '    It passes alone and fails under load.'), '    👍 Sam, Codex +1 · 👀 Claude');
      assert.equal(under(screen, '    Does it fail on main too?'), '    👀 Claude', 'an agent’s 👀 on a message of the person’s own');
      assert.equal(under(screen, '    Yes, on main as well.'), '    👎 You · 👀 Codex');
      assert.equal(screen.filter((l) => l.startsWith('    👍')).length, 1);
      assert.match(s.tab.render(80, 20).rows.join(''), boldName('You'), 'the person’s own is bold');
      assert.doesNotMatch(s.tab.render(80, 20).rows.join(''), boldName('Sam'), 'those of others are not');
      assert.ok(s.screen(24, 12).every((l) => columns(l) <= 24), 'and cut to the width');
    });

    it('shows a reaction an agent leaves as it arrives, in the thread picked', async () => {
      const s = await reading();
      assert.deepEqual(reactionRows(s.screen()), []);
      s.change([thread('t', 'Flaky test', [first, reply, again, { ...last, reactions: [{ emoji: '👀', by: claude, at: ago(0) }] }])]);
      const screen = await refreshed(s);
      assert.equal(under(screen, '    Yes, on main as well.'), '    👀 Claude');
    });

    it('keeps the choice, and says why under the line, when the board refuses; the reaction is not shown, and the key tries again', async () => {
      const s = await reading();
      s.type('\t');
      s.refusing = { error: 'The board refused the reaction (HTTP 500).' };
      s.type('1');
      await s.settle();
      let screen = s.screen();
      assert.equal(statusRow(screen), ' The board refused the reaction (HTTP 500).');
      assert.ok(s.tab.render(80, 20).rows.at(-2)!.includes(`\x1b[0;38;5;214;${BAND}m`), 'in the alert colour, on the band');
      assert.deepEqual(marked(screen), [MARKED], 'the choice is kept');
      assert.deepEqual(reactionRows(screen), []);
      s.refusing = undefined;
      s.type('1');
      screen = await afterwards(s);
      assert.equal(statusRow(screen), CHOSEN_ROW, 'the refusal is gone');
      assert.equal(under(screen, '    Yes, on main as well.'), '    👍 You');
    });

    it('asks to be let in when the board says this terminal must be', async () => {
      const s = await reading();
      s.type('\t');
      s.refusing = { error: 'Not a seat.', needsSeat: true };
      s.type('1');
      await s.settle();
      assert.equal(statusRow(s.screen()), ' This terminal must be let in first: Enter asks, and your text is kept.');
      s.type('\r');
      assert.equal(s.seatAsked, 1);
    });
  });
});

describe("the Tricot tab's chat: the stream", () => {
  const codex: Actor = { kind: 'agent', name: 'Codex' };
  const comment = (author: Actor, body: string, msAgo: number, more: Partial<Comment> = {}): Comment => ({ id: `c${++counter}`, author, body, createdAt: ago(msAgo), ...more });
  const card = (number: number, title: string, comments: Comment[], status: Task['status'] = 'todo') => ({ id: `t${number}`, number, title, status, comments }) as unknown as Task;
  const question = (number: number, text: string, comments: Comment[]) => ({ id: `d${number}`, number, question: text, comments }) as unknown as Decision;
  const pinned = (quote: string, comments: Comment[]): Pin => ({ id: 'p1', blockId: 'b1', anchor: { kind: 'text', prefix: '', suffix: '' }, quote, author: sam, createdAt: comments[0].createdAt, discussion: { thread: comments } });
  const pick = thread('w', "Pick up Codex's work", [message(me, "@Claude pick up Codex's work on T17", 40 * MIN), message(claude, 'T17 is ready for you to review.', 2 * MIN)]);
  const design = thread('d', 'Picker spacing', [message(codex, 'Tighter: 8 px between rows.', 30 * MIN)], { lens: { name: 'Design' } });
  const backlog = card(17, 'Keep backlog quiet', [comment(codex, 'T17 is ready to review.', 12 * MIN)], 'backlog');
  const decided = question(7, 'Open the Tricot tab on chat?', [comment(me, "Let's go with a.", 9 * MIN)]);
  const beta = pinned('Beta ships to ten teams', [comment(sam, 'Which ten?', 25 * MIN)]);
  const keysRow = (screen: string[]) => screen.at(-1)!;
  const statusRow = (screen: string[]) => screen.at(-2)!;
  const lineRow = (screen: string[]) => screen.at(-3)!;
  const keys = { up: '\x1b[A', down: '\x1b[B', pageup: '\x1b[5~', pagedown: '\x1b[6~', home: '\x1b[H', end: '\x1b[F', esc: '\x1b', ctrlL: '\x0c' };

  async function chatting(threads: Thread[] = [pick, design], more: Stand['more'] = { tasks: [backlog], decisions: [decided], pins: [beta], actors: [codex, sam] }, cols = 120, rows = 20): Promise<Stand> {
    const s = stand(threads, { chat: true });
    s.more = more;
    s.screen(cols, rows);
    await s.settle();
    return s;
  }

  it('opens on every conversation on the board, oldest first, each with where it belongs: threads, card discussions and pinned parts, backlog included', async () => {
    const s = await chatting();
    assert.deepEqual(s.screen(120, 20), [
      "  You · in Pick up Codex's work · 40 min ago",
      "    @Claude pick up Codex's work on T17",
      '  Codex  agent · in Design · Picker spacing · 30 min ago',
      '    Tighter: 8 px between rows.',
      '  Sam · on the board, about “Beta ships to ten teams” · 25 min ago',
      '    Which ten?',
      '  Codex  agent · on T17 Keep backlog quiet · 12 min ago',
      '    T17 is ready to review.',
      "  You · on #7 Open the Tricot tab on chat? · 9 min ago",
      "    Let's go with a.",
      "  Claude  agent · in Pick up Codex's work · 2 min ago",
      '    T17 is ready for you to review.',
      '',
      '',
      '',
      '',
      '',
      ' › Reply to Claude…',
      " to Pick up Codex's work, the latest · Claude hears it",
      ' Enter send · @ new thread · > elsewhere · Tab an earlier one · Esc threads · ↑↓ PgUp PgDn scroll',
    ]);
    assert.ok(s.tab.typing, 'letters are text');
    lacks(s.screen(120, 20), '│'); // no list beside it, however wide
  });

  it('shows a comment on a card as it comes, at the latest', async () => {
    const s = await chatting();
    s.more = { ...s.more, tasks: [{ ...backlog, comments: [...backlog.comments, comment(claude, 'I can take it once it is ready.', 5_000)] }] };
    s.change(s.threads); // the board's stream says its conversations changed
    const screen = await refreshed(s, 120, 20);
    assert.equal(screen[12], '  Claude  agent · on T17 Keep backlog quiet · just now');
    assert.equal(screen[13], '    I can take it once it is ready.');
  });

  it('scrolls with ↑ ↓, Page Up and Page Down, Home and End while nothing is typed, and stays where it was scrolled to as more comes', async () => {
    const s = await chatting();
    const first = "  You · in Pick up Codex's work · 40 min ago";
    const latest = (screen: string[]) => screen.at(-5)!;
    assert.equal(latest(s.screen(80, 12)), '    T17 is ready for you to review.', 'at the latest');
    s.type(keys.home);
    assert.equal(s.screen(80, 12)[0], first);
    assert.match(s.screen(80, 12).at(-4)!, /^ {2}↓ \d newer below · Enter for the latest$/);
    s.type(keys.down);
    assert.equal(s.screen(80, 12)[0], "    @Claude pick up Codex's work on T17");
    s.type(keys.up);
    assert.equal(s.screen(80, 12)[0], first);
    s.type(keys.pagedown);
    assert.notEqual(s.screen(80, 12)[0], first);
    s.type(keys.pageup);
    assert.equal(s.screen(80, 12)[0], first);
    // Scrolled up, what comes leaves it where it is.
    s.more = { ...s.more, decisions: [{ ...decided, comments: [...decided.comments, comment(claude, 'Building it now.', 5_000)] }] };
    s.change(s.threads);
    assert.equal((await refreshed(s, 80, 12))[0], first);
    s.type(keys.end);
    assert.equal(latest(s.screen(80, 12)), '    Building it now.');
    // Something typed: Home and End are the line's, ↑ ↓ still scroll.
    s.type('ok');
    s.type(keys.home);
    assert.equal(latest(s.screen(80, 12)), '    Building it now.');
    assert.equal(lineRow(s.screen(80, 12)), ' › ok');
    assert.equal(s.tab.render(80, 12).cursor?.x, 3, 'the cursor went to the start of the line');
    s.type(keys.up);
    assert.notEqual(latest(s.screen(80, 12)), '    Building it now.');
  });

  it('scrolls with the mouse’s wheel as ↑ ↓ do, a line for each, while something is typed too, and not under the panel over it (T30)', async () => {
    const latest = (screen: string[]) => screen.at(-5)!;
    const s = await chatting();
    const byKeys = await chatting();
    s.screen(80, 12);
    byKeys.screen(80, 12);
    s.tab.wheel(3);
    byKeys.type(keys.up.repeat(3));
    assert.deepEqual(s.screen(80, 12), byKeys.screen(80, 12), 'three lines up, as ↑ three times');
    s.tab.wheel(-3);
    assert.equal(latest(s.screen(80, 12)), '    T17 is ready for you to review.', 'and down again to the latest');
    s.type('ok');
    s.tab.wheel(3);
    assert.notEqual(latest(s.screen(80, 12)), '    T17 is ready for you to review.');
    assert.equal(lineRow(s.screen(80, 12)), ' › ok', 'what is typed stays');

    const under = await chatting();
    under.screen(80, 12);
    under.type(keys.esc); // the threads' panel, over the stream in a narrow window
    under.screen(80, 12);
    under.tab.wheel(3);
    under.type(keys.esc);
    assert.equal(latest(under.screen(80, 12)), '    T17 is ready for you to review.', 'the stream under the panel stayed');

    const status = stand([pick]);
    const before = status.screen(80, 12);
    status.tab.wheel(3);
    assert.deepEqual(status.screen(80, 12), before, 'the status view has nothing to scroll');
  });

  it('scrolls, and brings a message chosen into view, as it did when each frame laid out the whole stream', async () => {
    // Messages of every length, in two threads and a card's discussion.
    let seed = 3;
    const next = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) % n;
    const words = 'the retry policy should wrap every outbound call so that we keep behaviour at existing call sites'.split(' ');
    const said = () => Array.from({ length: 1 + next(40) }, () => words[next(words.length)]).join(' ') + (next(5) ? '' : '\n\n- one\n- two');
    const authors = [me, claude, codex, sam];
    const long = Array.from({ length: 24 }, (_, i) => message(authors[next(4)], said(), (90 - i * 3) * MIN));
    const threads = [thread('w', "Pick up Codex's work", long.slice(0, 12)), thread('d', 'Picker spacing', long.slice(12), { lens: { name: 'Design' } })];
    const notes = Array.from({ length: 6 }, (_, i) => comment(authors[next(4)], said(), (88 - i * 7) * MIN));
    const s = await chatting(threads, { tasks: [card(17, 'Keep backlog quiet', notes)], actors: [codex, sam] }, 80, 14);
    const { body } = chatGeometry(80, 14, 2);
    let items = chatStream(boardOf(s.threads, s.more));
    // The keys as they were, on the whole stream laid out: a line counted from the oldest, or the latest.
    let top: number | 'end' = 'end';
    let chosen: string | undefined;
    const laid = () => chatLines(items, 80, 'Wassim', NOW, new Set(), chosen);
    const shownAt = (total: number) => Math.min(top === 'end' ? Infinity : top, Math.max(0, total - body));
    const scroll = (key: string) => {
      const total = laid().lines.length;
      const last = Math.max(0, total - body);
      const now = shownAt(total);
      const page = Math.max(1, body - 1);
      const target = ({ up: now - 1, down: now + 1, pageup: now - page, pagedown: now + page, home: 0, end: last } as Record<string, number>)[key];
      const to = Math.min(Math.max(0, target), last);
      top = to >= last ? 'end' : to;
    };
    const reveal = () => {
      const { lines, starts } = laid();
      const index = items.findIndex((it) => it.key === chosen);
      const first = starts[index];
      const end = (starts[index + 1] ?? lines.length) - 1;
      const last = Math.max(0, lines.length - body);
      const now = shownAt(lines.length);
      const to = first < now ? first : end >= now + body ? Math.min(first, end - body + 1) : now;
      top = to >= last ? 'end' : to;
    };
    const others = () => items.filter((it) => !(it.author.kind === 'human' && it.author.name === 'Wassim'));
    const press = (key: string) => {
      if (chosen && ['up', 'down', 'tab', 'backtab'].includes(key)) {
        const list = others();
        const at = list.findIndex((it) => it.key === chosen);
        chosen = list[Math.min(Math.max(0, at + (key === 'up' || key === 'tab' ? -1 : 1)), list.length - 1)].key;
        reveal();
      } else if (key === 'tab') {
        chosen = others().at(-1)!.key;
        reveal();
      } else if (key === 'esc') chosen = undefined;
      else if (key !== 'backtab') scroll(key);
    };
    const sent = { up: '\x1b[A', down: '\x1b[B', pageup: '\x1b[5~', pagedown: '\x1b[6~', home: '\x1b[H', end: '\x1b[F', tab: '\t', backtab: '\x1b[Z', esc: '\x1b' } as Record<string, string>;
    const choices = ['up', 'up', 'down', 'down', 'pageup', 'pagedown', 'home', 'end', 'tab', 'tab', 'backtab', 'esc'];
    for (let step = 0; step < 240; step++) {
      if (step === 120) {
        // More comes, at the latest, wherever the stream is scrolled to.
        s.more = { ...s.more, tasks: [card(17, 'Keep backlog quiet', [...notes, comment(sam, said(), 5_000)])] };
        s.change(s.threads);
        await refreshed(s, 80, 14);
        items = chatStream(boardOf(s.threads, s.more));
      }
      const key = choices[next(choices.length)];
      if (key === 'esc' && !chosen) continue; // it would open the threads
      press(key);
      s.type(sent[key]);
      const { lines, starts } = laid();
      const at = shownAt(lines.length);
      const want = lines.slice(at, at + body).map((parts) => parts.map(([text]) => text).join('').trimEnd());
      const screen = s.screen(80, 14);
      assert.deepEqual(screen.slice(0, want.length), want, `step ${step}, ${key}`);
      const below = starts.filter((start) => start >= at + body).length;
      assert.equal(/↓ (\d+ newer|more) below/.exec(screen[body])?.[1], at + body < lines.length ? (below ? `${below} newer` : 'more') : undefined, `step ${step}, ${key}: below`);
    }
  });

  it('asks the host’s tick to draw it again only once a time it shows would change', async () => {
    const s = await chatting();
    s.screen(120, 20);
    assert.equal(s.tab.due(s.now), false, 'just drawn');
    s.now += 25_000;
    assert.equal(s.tab.due(s.now), false, 'every head still says the same: "2 min ago", "9 min ago"…');
    s.now += 10_000;
    assert.equal(s.tab.due(s.now), true, '"2 min ago" is now "3 min ago"');
    assert.ok(s.screen(120, 20).includes("  Claude  agent · in Pick up Codex's work · 3 min ago"));
    assert.equal(s.tab.due(s.now), false, 'drawn with it');
    // The threads over the stream, in a narrow window: their times alone.
    s.type(keys.esc);
    s.screen(80, 20);
    s.now += 20_000;
    assert.equal(s.tab.due(s.now), false);
    s.now += 40_000; // "3 min ago" is now "4 min ago"
    assert.equal(s.tab.due(s.now), true, 'a thread’s time changed');
    // The status view says what agents are doing, and for how long: drawn each time.
    const status = stand([pick]);
    status.screen();
    assert.equal(status.tab.due(status.now), true);
  });

  describe('back to the latest with Enter', () => {
    const latest = (screen: string[]) => screen.at(-5)!;
    // The row about newer items, wherever the foot leaves it.
    const newer = (screen: string[]) => screen.find((l) => /^ {2}↓ /.test(sides(l)[0]));

    it('takes a stream scrolled up back to the latest on an empty line, says so above the line and in the keys, and leaves Esc as it was', async () => {
      const s = await chatting();
      const before = s.screen(80, 12);
      s.type('\r');
      assert.deepEqual(s.screen(80, 12), before, 'at the latest already, Enter on an empty line changes nothing');
      assert.equal(keysRow(before), ' Enter send · @ new thread · > elsewhere · Tab an earlier one · Esc threads');
      s.type(keys.home);
      const scrolled = s.screen(80, 12);
      assert.match(scrolled.at(-4)!, /^ {2}↓ \d newer below · Enter for the latest$/);
      assert.equal(keysRow(scrolled), ' Enter latest · @ new thread · > elsewhere · Tab an earlier one · Esc threads');
      s.type('\r');
      const back = s.screen(80, 12);
      assert.equal(latest(back), '    T17 is ready for you to review.');
      assert.equal(back.at(-4), '', 'nothing newer below');
      assert.equal(keysRow(back), keysRow(before));
      assert.deepEqual(s.sent, [], 'nothing sent');
      // Esc on the empty line still opens the threads, scrolled up or not; Enter there is the panel's.
      s.type(keys.home);
      s.type(keys.esc);
      const panel = s.screen(120, 12);
      assert.match(panel[0], /│ Threads$/);
      assert.match(sides(newer(panel)!)[0], /^ {2}↓ \d newer below$/, 'the panel has the keys: Enter picks a thread');
    });

    it('keeps the row about newer items while typing, saying Enter sends and goes to the latest, which it does', async () => {
      const s = await chatting();
      s.screen(80, 12); // the size the keys scroll by
      s.type(keys.home);
      s.type('sounds good, merge it');
      const typing = s.screen(80, 12);
      assert.match(typing.at(-4)!, /^ {2}↓ \d newer below · Enter sends and goes to the latest$/);
      assert.equal(keysRow(typing), ' Enter send · ↑↓ PgUp PgDn scroll · Tab complete · Esc clear');
      s.type('\r');
      assert.deepEqual(s.sent, [{ kind: 'reply', thread: 'w', text: 'sounds good, merge it' }]);
      const sent = s.screen(80, 12);
      assert.equal(latest(sent), '    sounds good, merge it', 'at the latest, shown as sending');
      assert.equal(sent.at(-4), '');
      await s.settle();
    });

    it('lets what Enter did first come first: a command typed, and asking for this terminal to be let in', async () => {
      const s = await chatting();
      s.screen(80, 12);
      s.type(keys.home);
      s.type('/threads');
      assert.match(newer(s.screen(80, 12))!, /^ {2}↓ \d newer below$/, 'Enter runs the command, and sends nothing');
      s.type('\r');
      assert.match(s.screen(120, 12)[0], /│ Threads$/);
      assert.deepEqual(s.sent, []);

      const seat = await chatting();
      seat.screen(80, 12);
      seat.type('\t'); // the latest of someone else's, chosen
      seat.refusing = { error: 'Not a seat.', needsSeat: true };
      seat.type('1');
      await seat.settle();
      seat.type(keys.home);
      const asking = seat.screen(80, 12);
      assert.equal(statusRow(asking), ' This terminal must be let in first: Enter asks, and your text is kept.');
      assert.match(newer(asking)!, /^ {2}↓ \d newer below$/, 'Enter asks first');
      seat.type('\r');
      assert.equal(seat.seatAsked, 1);
      const asked = seat.screen(80, 12);
      assert.match(newer(asked)!, /^ {2}↓ \d newer below · Enter for the latest$/, 'still scrolled up, and now Enter goes down');
      seat.type('\r');
      assert.equal(newer(seat.screen(80, 12)), undefined, 'at the latest');
      assert.equal(seat.seatAsked, 1);
    });

    it('goes back to the latest from a message chosen further up, as End does, the choice kept', async () => {
      const s = await chatting();
      s.screen(80, 12);
      s.type('\t\t\t\t'); // back to Codex's in Picker spacing, near the top
      const chosen = s.screen(80, 12);
      assert.ok(chosen.some((l) => l.startsWith('❯ Codex  agent · in Design · Picker spacing')), chosen.join('\n'));
      assert.match(chosen.at(-4)!, /^ {2}↓ \d newer below · Enter for the latest$/);
      assert.equal(keysRow(chosen), ' Tab ↑ earlier · ↓ later · 1 👍 · 2 👎 · 3 👀 · Esc the latest', 'the keys of a message chosen');
      s.type('\r');
      const back = s.screen(80, 12);
      assert.equal(latest(back), '    T17 is ready for you to review.');
      assert.match(statusRow(back), /the one chosen/, 'what is typed still answers it');
      assert.equal(keysRow(back), keysRow(chosen));
      assert.deepEqual(s.sent, []);
    });
  });

  it('starts a thread with an @ at the start of the line, which is picked, and Esc goes back to the whole stream', async () => {
    const s = await chatting();
    s.type('@Claude can you look at the picker?');
    assert.equal(statusRow(s.screen(120, 20)), ' New thread · Claude is listening: this is seen at once.');
    s.type('\r');
    await s.settle();
    assert.deepEqual(s.sent, [{ kind: 'start', text: '@Claude can you look at the picker?' }]);
    assert.equal(s.screen(120, 20)[0], only('@Claude can you look at the picker?'), 'the new thread is picked');
    s.type(keys.esc);
    const back = s.screen(120, 20);
    assert.equal(statusRow(back), " to Pick up Codex's work, the latest · Claude hears it", 'back on the stream it was started from, which answers the latest again');
    assert.equal(back[12], '  You · in @Claude can you look at the picker? · just now');
    s.type(keys.esc);
    assert.match(s.screen(120, 20)[0], /│ Threads$/, 'Esc on an empty line opens the threads beside it');
    assert.equal(s.tab.typing, false);
  });

  it('says the lens a new thread begins with under the line, and the picker takes the window while it is chosen', async () => {
    const s = await chatting();
    s.type(keys.ctrlL);
    assert.match(s.screen(80, 20)[0], /^ Lens · New thread/);
    s.type(`${keys.down}\r`);
    assert.match(statusRow(s.screen(80, 20)), /^ New thread · Legal · /);
    assert.equal(lineRow(s.screen(80, 20)), ' › What do you want to work through?');
  });

  it('says why it shows nothing: reading, a board with no conversation, a board that can’t be read', async () => {
    const s = stand([], { chat: true });
    assert.equal(s.screen()[0], '  Reading the board…');
    await s.settle();
    assert.deepEqual(s.screen().slice(0, 3), ['  No conversations on the board yet.', '  What you type below starts a thread; its replies, and comments on cards, show', '  here as they come.']);
    const failing = stand([], { chat: true });
    failing.failing = 'The board is away.';
    failing.screen();
    await failing.settle();
    assert.equal(failing.screen()[0], '  The board could not be read: The board is away.');
    assert.equal(keysRow(failing.screen()), ' ↑↓ PgUp PgDn scroll · Esc threads');
  });

  describe('the threads’ panel beside it', () => {
    // Each side of the first row: a heading of the old threads view, were it drawn.
    const oldHeads = (screen: string[]) => sides(screen[0]).filter((side) => /^ (?:Thread(?: · |$)|New thread(?: · |$)|Commands$)/.test(side));

    it('opens with /threads beside the stream from a hundred columns, the stream narrower on its left, and over it under', async () => {
      const s = await chatting();
      s.type('/threads\r');
      const wide = s.screen(120, 20);
      assert.deepEqual(sides(wide[0]), ["  You · in Pick up Codex's work · 40 min ago", ' Threads']);
      assert.match(wide[1], /^ {4}@Claude pick up Codex's work on T17 +│ ❯   Pick up Codex's work +2 min ago$/);
      assert.match(wide[2], /│ {5}Design · Picker spaci… +30 min ago$/);
      assert.equal(wide[0].indexOf('│'), 79, 'two thirds for the stream, a thin line, a third for the panel');
      assert.equal(wide.at(-1), PANEL_KEYS);
      assert.ok(!wide.some((l) => l.startsWith(' › ')), 'the line gives way while the panel has the keys');
      assert.equal(s.tab.typing, false);
      const narrow = s.screen(80, 20);
      assert.equal(narrow[0], ' Threads');
      lacks(narrow, '│');
      lacks(narrow, 'Codex  agent');
      assert.equal(narrow.at(-1), PANEL_KEYS);
    });

    it('moves its highlight with ↑ ↓; Enter shows the thread alone, at its latest, and the line answers it', async () => {
      const s = await chatting();
      s.type('/threads\r');
      s.type(keys.down);
      assert.match(s.screen(120, 20)[2], /│ ❯   Design · Picker spaci…/);
      s.type(keys.up);
      assert.match(s.screen(120, 20)[1], /│ ❯   Pick up Codex's work/);
      s.type(`${keys.down}\r`);
      const screen = s.screen(120, 20);
      assert.deepEqual(screen.slice(0, 3).map((l) => sides(l)[0]), [only('Picker spacing'), '  Codex  agent · 30 min ago', '    Tighter: 8 px between rows.']);
      assert.ok(!screen.some((l) => sides(l)[0].includes('T17')), 'only its messages');
      assert.match(screen[2], /│ ❯   Design · Picker spaci…/, 'the panel beside it, its highlight on the thread');
      assert.equal(lineRow(screen), ' › Reply to Codex…');
      assert.equal(statusRow(screen), " to Picker spacing · Codex isn't listening here");
      assert.equal(keysRow(screen), ' Enter send · Tab react · Esc everything · ↑↓ PgUp PgDn scroll · ^L lens');
      assert.ok(s.tab.typing);
      s.type('@Claude try 6 px\r');
      await s.settle();
      assert.deepEqual(s.sent, [{ kind: 'reply', thread: 'd', text: '@Claude try 6 px' }], 'an @ at the start is a mention in the thread, not a new one');
      const after = await refreshed(s, 120, 20);
      assert.ok(after.some((l) => sides(l)[0] === '    @Claude try 6 px'), after.join('\n'));
      assert.equal(sides(after[0])[0], only('Picker spacing'), 'still picked');
    });

    it('takes Esc a step at a time: what is typed, then the thread picked back to everything with the panel, then the panel', async () => {
      const s = await chatting();
      s.type(`/threads\r${keys.down}\rok`);
      s.type(keys.esc);
      assert.equal(sides(s.screen(120, 20)[0])[0], only('Picker spacing'), 'first what is typed is cleared');
      s.type(keys.esc);
      let screen = s.screen(120, 20);
      assert.equal(sides(screen[0])[0], "  You · in Pick up Codex's work · 40 min ago", 'then everything');
      assert.match(screen[2], /│ ❯   Design · Picker spaci…/, 'the same thread highlighted');
      assert.equal(screen.at(-1), PANEL_KEYS, 'the panel has the keys again');
      s.type(keys.esc);
      screen = s.screen(120, 20);
      lacks(screen, '│');
      assert.equal(lineRow(screen), ' › Reply to Claude…', 'then it closes, and the line answers the latest');
      assert.ok(s.tab.typing);
    });

    it('in a narrow window shows the thread picked over all of it, and Esc goes back to the panel over the stream, then closes it', async () => {
      const s = await chatting();
      s.type('/threads\r');
      assert.equal(s.screen(80, 20)[0], ' Threads');
      s.type(`${keys.down}\r`);
      const screen = s.screen(80, 20);
      assert.equal(screen[0], only('Picker spacing'));
      lacks(screen, '│');
      lacks(screen, ' Threads');
      s.type(keys.esc);
      assert.equal(s.screen(80, 20)[0], ' Threads');
      assert.match(s.screen(80, 20)[2], /^ ❯   Design · Picker spacing/);
      s.type(keys.esc);
      assert.equal(s.screen(80, 20)[0], "  You · in Pick up Codex's work · 40 min ago");
    });

    it('marks what waits on you, and a thread read in the stream beside it is unmarked in the same frame', async () => {
      const s = await chatting();
      s.screen(120, 12);
      s.type(keys.home);
      s.change(s.threads.map((t) => (t.id === 'w' ? { ...t, messages: [...t.messages, message(claude, 'Also: T18 is next.', 5_000)] } : t)));
      await refreshed(s, 120, 12);
      s.type('/threads\r');
      let screen = s.screen(120, 12);
      assert.equal(sides(screen[0])[1], ' Threads · 1 waiting on you', 'scrolled out of sight in the stream, it is not read');
      assert.equal(sides(screen[1])[1], ' Waiting on you · 1');
      assert.match(screen[2], /│ ❯ ● Pick up Codex's work +2 min ago$/);
      s.type('\r');
      screen = s.screen(120, 12);
      assert.equal(sides(screen[0])[1], ' Threads', 'picked, it shows at its latest: read, and the panel says so at once');
      lacks(screen, '●');
    });

    it('deletes the thread highlighted, asking in the panel’s place, and undoes it with u', async () => {
      const s = await chatting();
      s.type(`/threads\r${keys.down}x`);
      let screen = s.screen(120, 20);
      assert.deepEqual(screen.slice(0, 2).map((l) => sides(l)[1]), [' Delete thread?', '  Picker spacing']);
      assert.equal(sides(screen[0])[0], "  You · in Pick up Codex's work · 40 min ago", 'the stream in view beside it');
      assert.match(screen.at(-1)!, /❯ No · ←→ choose · Enter confirm · Esc cancel$/);
      s.type('y');
      await s.settle();
      screen = await refreshed(s, 120, 20);
      assert.deepEqual(s.sent, [{ kind: 'remove', thread: 'd' }]);
      assert.equal(sides(screen[1])[1], '  Thread deleted. Press u to undo.');
      assert.ok(!screen.some((l) => l.includes('Picker spaci')), 'gone from the panel and the stream');
      assert.match(screen.at(-1)!, /u undo/);
      s.type('u');
      await s.settle();
      screen = await refreshed(s, 120, 20);
      assert.deepEqual(s.sent.at(-1), { kind: 'restore', thread: 'd' });
      assert.match(screen.find((l) => l.includes('│ ❯ '))!, /Design · Picker spaci…/, 'back, and highlighted');
    });

    it('sets the lens of the thread highlighted with l, the picker in the panel’s place', async () => {
      const s = await chatting();
      s.type('/threads\rl');
      const screen = s.screen(120, 20);
      assert.deepEqual(sides(screen[0]), ["  You · in Pick up Codex's work · 40 min ago", " Lens · Pick up Codex's work"]);
      assert.equal(screen.at(-1), ' ↑↓ pick · Enter set · Esc cancel');
      s.type(`${keys.down}\r`);
      await s.settle();
      assert.deepEqual(s.sent, [{ kind: 'lens', thread: 'w', lens: { name: 'Legal' } }]);
      const after = await refreshed(s, 120, 20);
      assert.match(after[1], /│ ❯   Legal · Pick up Codex'… +2 min ago$/);
      assert.equal(after.at(-1), PANEL_KEYS, 'the panel has the keys again');
    });

    it('keeps the panel and the thread picked while another tab shows, and through the status view and back', async () => {
      const s = await chatting();
      s.type(`/threads\r${keys.down}\r`);
      const before = s.screen(120, 20);
      s.tab.endKnitting(); // what the host does as another tab shows; the Tricot tab is not drawn meanwhile
      assert.deepEqual(s.screen(120, 20), before, 'back on it, as it was');
      s.type('/status\r');
      assert.ok(s.screen(120, 20).some((l) => l.includes('Your agents')));
      s.type(keys.esc);
      assert.deepEqual(s.screen(120, 20), before, 'and from the status view');
      s.type(keys.esc);
      assert.equal(s.screen(120, 20).at(-1), PANEL_KEYS, 'the panel still open behind the thread');
    });

    it('opens no view of its own: no key puts a thread, a new thread or the commands in the stream’s place', async () => {
      for (const cols of [120, 80]) {
        const s = await chatting();
        const keysTyped = ['/threads\r', '\r', keys.ctrlL, keys.esc, '\t', keys.esc, keys.esc, 'n', keys.esc, keys.esc, '/', keys.esc, 'x', keys.esc, 'l', keys.esc, keys.esc, keys.esc, '@Claude hi\r', keys.esc, '/status\r', 't', '\r', keys.esc, keys.esc, '/', keys.esc, keys.esc, '/new\r', keys.ctrlL, keys.esc];
        for (const key of keysTyped) {
          s.type(key);
          await s.settle();
          const screen = s.screen(cols, 20);
          assert.deepEqual(oldHeads(screen), [], `${cols} columns, after ${JSON.stringify(key)}:\n${screen.join('\n')}`);
        }
      }
    });
  });

  describe('answering', () => {
    const inner = (s: Stand) => s.tab as unknown as { threads: { list(): void } };
    const at = (screen: string[], head: string) => assert.ok(screen.includes(head), `no row ${JSON.stringify(head)} in:\n${screen.join('\n')}`);
    const chosen = (screen: string[]) => screen.filter((row) => row.startsWith('❯ '));

    it('answers the latest message from someone else, passing over your own: a reply in its thread, shown at once as sending', async () => {
      const s = await chatting();
      s.more = { ...s.more, decisions: [{ ...decided, comments: [...decided.comments, comment(me, 'And ship it.', MIN)] }] };
      s.change(s.threads);
      const latest = await refreshed(s, 120, 20);
      at(latest, '  You · on #7 Open the Tricot tab on chat? · 1 min ago');
      assert.equal(statusRow(latest), " to Pick up Codex's work, the latest · Claude hears it", 'your own, the latest of all, is passed over');
      assert.equal(lineRow(latest), ' › Reply to Claude…');
      let open!: () => void;
      s.gate = new Promise((resolve) => (open = resolve));
      s.type('Thanks, I will look\r');
      assert.deepEqual(s.sent, [{ kind: 'reply', thread: 'w', text: 'Thanks, I will look' }]);
      const sending = s.screen(120, 20);
      at(sending, "  You · in Pick up Codex's work · sending…");
      at(sending, '    Thanks, I will look');
      assert.equal(lineRow(sending), ' › Reply to Claude…', 'the line is empty again');
      open();
      await s.settle();
      const sent = await refreshed(s, 120, 20);
      at(sent, "  You · in Pick up Codex's work · just now");
      lacks(sent, 'sending…');
    });

    it('holds where it was aimed once typing starts, though a newer message arrives, and follows the latest again once the line is empty', async () => {
      const s = await chatting();
      s.type('Looks good');
      s.more = { ...s.more, decisions: [{ ...decided, comments: [...decided.comments, comment(sam, 'Agreed?', 5_000)] }] };
      s.change(s.threads);
      const held = await refreshed(s, 120, 20);
      at(held, '  Sam · on #7 Open the Tricot tab on chat? · just now');
      assert.equal(statusRow(held), " to Pick up Codex's work · Claude hears it", 'where typing began, which is no longer the latest');
      s.type('\r');
      await s.settle();
      assert.deepEqual(s.sent, [{ kind: 'reply', thread: 'w', text: 'Looks good' }]);
      assert.equal(statusRow(await refreshed(s, 120, 20)), ' to #7 Open the Tricot tab on chat?, the latest · Claude hears it', 'empty, it follows the latest');
      s.type('x');
      s.more = { ...s.more, tasks: [{ ...backlog, comments: [...backlog.comments, comment(claude, 'Still quiet?', 1_000)] }] };
      s.change(s.threads);
      assert.equal(statusRow(await refreshed(s, 120, 20)), ' to #7 Open the Tricot tab on chat? · Claude hears it');
      s.type('\x7f');
      assert.equal(statusRow(s.screen(120, 20)), ' to T17 Keep backlog quiet, the latest · only people see it: agents skip the backlog', 'emptied, it follows the latest again');
    });

    it('sends where > names: a task by T and its number, a decision by #, a thread by words of its title; Tab completes each, listed with its title', async () => {
      const t19 = { ...card(19, 'Stopped agents leave the strip', [], 'in_progress'), assignee: 'Claude' } as Task;
      const s = await chatting(undefined, { tasks: [backlog, t19], decisions: [decided], pins: [beta], actors: [codex, sam] });
      s.type('>T1');
      const listing = s.screen(120, 20);
      assert.deepEqual(listing.slice(-5, -3), [' ❯ >T17  Keep backlog quiet', '   >T19  Stopped agents leave the strip'], 'a row each, with its title (T39)');
      assert.equal(statusRow(listing), " Where to? T19, #7 or part of a thread's title: Tab chooses.");
      s.type(keys.down);
      assert.equal(lineRow(s.screen(120, 20)), ' › >T17', '↓ picks in the list, as Tab does (T39)');
      s.type(keys.up);
      assert.equal(lineRow(s.screen(120, 20)), ' › >T19', '↑ from the first goes round to the last');
      s.type(keys.down);
      assert.equal(lineRow(s.screen(120, 20)), ' › >T17', 'and ↓ round to the first');
      s.type('\t');
      assert.equal(lineRow(s.screen(120, 20)), ' › >T19', 'Tab again: the next');
      assert.equal(statusRow(s.screen(120, 20)), ' to T19 Stopped agents leave the strip · Claude hears it');
      s.type('Ship it when green\r');
      await s.settle();
      s.type('>#7 Yes, a.\r');
      await s.settle();
      s.type('>pick\t');
      assert.equal(lineRow(s.screen(120, 20)), " › >Pick up Codex's work", 'the thread talked in latest first');
      s.type('\x1b[Z');
      assert.equal(lineRow(s.screen(120, 20)), ' › >Picker spacing', 'Shift+Tab: the other way round');
      s.type('Try 6 px\r');
      await s.settle();
      assert.deepEqual(s.sent, [
        { kind: 'comment', on: { kind: 'task', id: 't19' }, text: 'Ship it when green' },
        { kind: 'comment', on: { kind: 'decision', id: 'd7' }, text: 'Yes, a.' },
        { kind: 'reply', thread: 'd', text: 'Try 6 px' },
      ]);
      at(await refreshed(s, 120, 20), '  You · on T19 Stopped agents leave the strip · just now');
    });

    it('takes a > followed by a space as plain text, so a quoted line answers the latest', async () => {
      const s = await chatting();
      s.type('> it passes alone');
      assert.equal(statusRow(s.screen(120, 20)), " to Pick up Codex's work, the latest · Claude hears it");
      s.type('\r');
      await s.settle();
      assert.deepEqual(s.sent, [{ kind: 'reply', thread: 'w', text: '> it passes alone' }]);
    });

    it('says why it can’t go where a > names, and sends nothing: no such card, words in several titles, nothing after it', async () => {
      const s = await chatting();
      const refuses = async (typed: string, why: string) => {
        s.type(`\x15${typed}`);
        assert.equal(statusRow(s.screen(120, 20)), ` ${why}`, typed);
        s.type('\r');
        await s.settle();
        assert.equal(statusRow(s.screen(120, 20)), ` ${why}`, `${typed}, after Enter`);
        assert.equal(lineRow(s.screen(120, 20)), ` › ${typed}`, 'the text is kept');
      };
      await refuses('>T99 hello', 'There is no T99 on this board.');
      await refuses('>#12 hello', 'There is no #12 on this board.');
      await refuses('>pick hello', "“pick” is in 2 threads' titles: Tab chooses one.");
      await refuses('>budget hello', "No thread's title has “budget” in it. After > goes where it is for: T19, #7 or part of a thread's title.");
      s.type('\x15>T17');
      s.type('\r');
      await s.settle();
      assert.equal(statusRow(s.screen(120, 20)), ' Write what to say after T17.');
      assert.deepEqual(s.sent, []);
    });

    it('chooses with Tab on an empty line the latest of someone else’s, then each Tab one further back, Shift+Tab and ↓ one later: ❯ marks it, and the reply goes where it is', async () => {
      const s = await chatting();
      s.type('\t');
      let screen = s.screen(120, 20);
      assert.deepEqual(chosen(screen), ["❯ Claude  agent · in Pick up Codex's work · 2 min ago"]);
      assert.equal(statusRow(screen), " to Pick up Codex's work, the one chosen · Claude hears it");
      assert.equal(keysRow(screen), ' Tab ↑ earlier · ↓ later · 1 👍 · 2 👎 · 3 👀 · Esc the latest');
      const steps: [string, string, string][] = [
        ['\t', '❯ Codex  agent · on T17 Keep backlog quiet · 12 min ago', ' to T17 Keep backlog quiet, the one chosen · only people see it: agents skip the backlog'],
        ['\t', '❯ Sam · on the board, about “Beta ships to ten teams” · 25 min ago', ' to the board, about “Beta ships to ten teams”, the one chosen · Claude hears it'],
        ['\t', '❯ Codex  agent · in Design · Picker spacing · 30 min ago', " to Picker spacing, the one chosen · Codex isn't listening here"],
        ['\t', '❯ Codex  agent · in Design · Picker spacing · 30 min ago', " to Picker spacing, the one chosen · Codex isn't listening here"], // the earliest stops it; your own are passed over
        ['\x1b[Z', '❯ Sam · on the board, about “Beta ships to ten teams” · 25 min ago', ' to the board, about “Beta ships to ten teams”, the one chosen · Claude hears it'],
        [keys.down, '❯ Codex  agent · on T17 Keep backlog quiet · 12 min ago', ' to T17 Keep backlog quiet, the one chosen · only people see it: agents skip the backlog'],
        [keys.up, '❯ Sam · on the board, about “Beta ships to ten teams” · 25 min ago', ' to the board, about “Beta ships to ten teams”, the one chosen · Claude hears it'],
      ];
      for (const [key, mark, row] of steps) {
        s.type(key);
        screen = s.screen(120, 20);
        assert.deepEqual(chosen(screen), [mark]);
        assert.equal(statusRow(screen), row);
      }
      s.type('Ten teams, yes');
      screen = s.screen(120, 20);
      assert.deepEqual(chosen(screen), ['❯ Sam · on the board, about “Beta ships to ten teams” · 25 min ago'], 'typing answers the one chosen');
      assert.equal(statusRow(screen), ' to the board, about “Beta ships to ten teams”, the one chosen · Claude hears it');
      assert.equal(keysRow(screen), ' Enter send · ↑↓ PgUp PgDn scroll · Tab complete · Esc clear');
      s.type('\r');
      await s.settle();
      assert.deepEqual(s.sent, [{ kind: 'comment', on: { kind: 'pin', id: 'p1' }, text: 'Ten teams, yes' }]);
      const after = await refreshed(s, 120, 20);
      assert.deepEqual(chosen(after), [], 'sent, it follows the latest again');
      assert.equal(statusRow(after), " to Pick up Codex's work, the latest · Claude hears it");
      at(after, '  You · on the board, about “Beta ships to ten teams” · just now');
    });

    it('shows the one chosen when it is scrolled out of sight', async () => {
      const s = await chatting();
      s.screen(80, 12);
      s.type('\t\t\t\t');
      assert.deepEqual(chosen(s.screen(80, 12)), ['❯ Codex  agent · in Design · Picker spacing · 30 min ago']);
    });

    it('takes Esc in turn: it clears what is typed, then goes back from the one chosen to the latest, then to the threads', async () => {
      const s = await chatting();
      s.type('\t\tTake it');
      s.type(keys.esc);
      let screen = s.screen(120, 20);
      assert.equal(lineRow(screen), ' › Reply to Codex…', 'cleared');
      assert.equal(statusRow(screen), ' to T17 Keep backlog quiet, the one chosen · only people see it: agents skip the backlog', 'still the one chosen');
      s.type(keys.esc);
      screen = s.screen(120, 20);
      assert.deepEqual(chosen(screen), []);
      assert.equal(statusRow(screen), " to Pick up Codex's work, the latest · Claude hears it");
      assert.equal(keysRow(screen), ' Enter send · @ new thread · > elsewhere · Tab an earlier one · Esc threads · ↑↓ PgUp PgDn scroll');
      s.type(keys.esc);
      assert.match(s.screen(120, 20)[0], /│ Threads$/, 'the threads beside the stream');
      // /new asks for a new thread, which Esc goes back from to the latest.
      s.type('/new\r');
      screen = s.screen(120, 20);
      assert.equal(statusRow(screen), ' New thread · Claude is listening.');
      assert.equal(keysRow(screen), ' Enter new thread · ↑↓ PgUp PgDn scroll · Tab complete @ / · Esc the latest · ^L lens');
      s.type(keys.esc);
      assert.equal(statusRow(s.screen(120, 20)), " to Pick up Codex's work, the latest · Claude hears it");
    });

    it('starts a thread with the lens chosen for one with Ctrl+L', async () => {
      const s = await chatting();
      s.type(`${keys.ctrlL}${keys.down}\r`);
      assert.match(statusRow(s.screen(80, 20)), /^ New thread · Legal · /);
      s.type('Is MIT fine?\r');
      await s.settle();
      assert.equal(s.sent[0].kind, 'start');
      assert.equal(s.sent[0].lens?.name, 'Legal');
    });

    it('replies about a part pinned on a card while the pin is there, and in the card’s discussion once it is gone', async () => {
      const strip: Pin = { id: 'p2', blockId: 'b2', anchor: { kind: 'text', prefix: '', suffix: '' }, quote: 'the strip after a stop', author: sam, createdAt: ago(5 * MIN), discussion: {} };
      const t19 = { ...card(19, 'Stopped agents leave the strip', [comment(claude, 'This is the strip now.', MIN, { pin: { id: 'p2', quote: '“the strip after a stop”' } })], 'in_progress'), assignee: 'Claude', canvas: { ...emptyCanvas(), pins: [strip] } } as Task;
      const s = await chatting(undefined, { tasks: [backlog, t19], decisions: [decided], pins: [beta], actors: [codex, sam] });
      assert.equal(statusRow(s.screen(120, 20)), ' to T19 Stopped agents leave the strip, about “the strip after a stop”, the latest · Claude hears it');
      s.type('Good\r');
      await s.settle();
      at(await refreshed(s, 120, 20), '  You · on T19 Stopped agents leave the strip, about “the strip after a stop” · just now');
      s.more = { ...s.more, tasks: s.more?.tasks?.map((t) => (t.id === 't19' ? ({ ...t, canvas: emptyCanvas() } as Task) : t)) };
      s.change(s.threads);
      await refreshed(s, 120, 20);
      s.type('And the numbers\r');
      await s.settle();
      assert.deepEqual(s.sent, [
        { kind: 'comment', on: { kind: 'pin', id: 'p2' }, text: 'Good' },
        { kind: 'comment', on: { kind: 'task', id: 't19' }, text: 'And the numbers' },
      ]);
    });

    it('keeps a refused reply on the line, with why, aimed where it was sent though a newer message arrives', async () => {
      const s = await chatting();
      s.refusing = { error: 'The board is archived.' };
      s.type('Thanks\r');
      await s.settle();
      let screen = s.screen(120, 20);
      assert.equal(lineRow(screen), ' › Thanks');
      assert.equal(statusRow(screen), ' The board is archived.');
      lacks(screen, 'sending…');
      s.more = { ...s.more, decisions: [{ ...decided, comments: [...decided.comments, comment(sam, 'Agreed?', 5_000)] }] };
      s.change(s.threads);
      await refreshed(s, 120, 20);
      s.type(' a lot');
      assert.equal(statusRow(s.screen(120, 20)), " to Pick up Codex's work · Claude hears it");
      s.refusing = undefined;
      s.type('\r');
      await s.settle();
      assert.deepEqual(s.sent.at(-1), { kind: 'reply', thread: 'w', text: 'Thanks a lot' });
    });

    it('reacts to the one chosen with 1 2 3, by where it is: a thread’s message, a card’s comment, a pinned part’s', async () => {
      const s = await chatting();
      s.type('\t1');
      await s.settle();
      s.type('\t2');
      await s.settle();
      s.type('\t3');
      await s.settle();
      assert.deepEqual(s.sent, [
        { kind: 'react', thread: 'w', message: pick.messages[1].id, emoji: '👍', remove: false },
        { kind: 'reactToComment', on: { kind: 'task', id: 't17' }, message: backlog.comments[0].id, emoji: '👎', remove: false },
        { kind: 'reactToComment', on: { kind: 'pin', id: 'p1' }, message: beta.discussion!.thread![0].id, emoji: '👀', remove: false },
      ]);
      const screen = await refreshed(s, 120, 20);
      const under = (head: string) => screen[screen.indexOf(head) + 2];
      assert.equal(under("  Claude  agent · in Pick up Codex's work · 2 min ago"), '    👍 You');
      assert.equal(under('  Codex  agent · on T17 Keep backlog quiet · 12 min ago'), '    👎 You');
      assert.equal(under('❯ Sam · on the board, about “Beta ships to ten teams” · 25 min ago'), '    👀 You');
      s.type('3');
      await s.settle();
      assert.deepEqual(s.sent.at(-1), { kind: 'reactToComment', on: { kind: 'pin', id: 'p1' }, message: beta.discussion!.thread![0].id, emoji: '👀', remove: true }, 'again takes yours back');
      s.refusing = { error: 'The board is archived.' };
      s.type('1');
      await s.settle();
      assert.equal(statusRow(s.screen(120, 20)), ' The board is archived.');
    });

    it('counts a thread as seen once its latest message shows in the stream, and not while it is scrolled out of sight', async () => {
      const arrives = (s: Stand) => s.change(s.threads.map((t) => (t.id === 'w' ? { ...t, messages: [...t.messages, message(claude, 'Also: T18 is next.', 5_000)] } : t)));
      const listHead = (s: Stand) => {
        inner(s).threads.list();
        return s.screen(80, 12)[0];
      };
      const shown = await chatting();
      arrives(shown);
      assert.equal((await refreshed(shown, 80, 12)).at(-5), '    Also: T18 is next.');
      assert.equal(listHead(shown), ' Threads', 'read in the stream: it waits on nobody');
      const away = await chatting();
      away.screen(80, 12);
      away.type(keys.home);
      arrives(away);
      lacks(await refreshed(away, 80, 12), 'Also: T18 is next.');
      away.type(keys.end);
      away.screen(80, 12);
      assert.equal(listHead(away), ' Threads', 'scrolled to, it is read');
      const unread = await chatting();
      unread.screen(80, 12);
      unread.type(keys.home);
      arrives(unread);
      await refreshed(unread, 80, 12);
      assert.equal(listHead(unread), ' Threads · 1 waiting on you', 'scrolled out of sight, it is not');
    });

    it('still starts a thread when nothing in the stream is from someone else', async () => {
      const s = await chatting([thread('n', 'My notes', [message(me, 'Remember the picker', 5 * MIN)])], { tasks: [], decisions: [], pins: [], actors: [] });
      let screen = s.screen(120, 20);
      assert.equal(lineRow(screen), ' › What do you want to work through?');
      assert.equal(statusRow(screen), ' New thread · Claude is listening.');
      s.type('\t');
      assert.equal(statusRow(s.screen(120, 20)), ' There is no message from anyone else to answer: what you type starts a thread.');
      s.type('A fresh one\r');
      await s.settle();
      assert.deepEqual(s.sent, [{ kind: 'start', text: 'A fresh one' }]);
      screen = s.screen(120, 20);
      assert.equal(screen[0], only('A fresh one'), 'it is picked');
    });

    it('fits its keys to the width: scrolling goes first, then the words', async () => {
      const s = await chatting();
      assert.equal(keysRow(s.screen(80, 20)), ' Enter send · @ new thread · > elsewhere · Tab an earlier one · Esc threads');
      assert.equal(keysRow(s.screen(48, 20)), ' Enter  @  >  Tab  Esc');
      for (const [cols, rows] of [[120, 24], [80, 10], [40, 6], [30, 3], [10, 1]]) {
        s.type('\t');
        const frame = s.tab.render(cols, rows);
        assert.equal(frame.rows.length, rows);
        assert.ok(frame.plain.every((l) => columns(l) <= cols), `${cols}×${rows}`);
      }
    });
  });
});

describe('the Tricot tab starts on chat', () => {
  // The chat's stream shows: the row under the line says a new thread is where what is typed goes.
  const onStream = (screen: string[]) => screen.at(-2)!.startsWith(' New thread · ');

  it('starts with a composer under the knitted header, and status shortcut letters are messages', async () => {
    const s = stand([], { chat: true, wordmark: 'whole' });
    s.screen();
    await s.settle();
    const initial = s.screen();
    assert.ok(initial[0].includes('█▀▄'));
    assert.ok(initial.some((l) => l.includes('New thread')));
    lacks(initial, 'Your agents');
    s.live = { ...s.live!, approvals: [{ id: 'a1', agent: 'Claude', harness: 'claude', tool: 'Bash', input: { command: 'ls' }, at: ago(1000) }] };
    s.type('ynsaxqo');
    const typing = s.screen();
    assert.ok(typing.some((l) => l.includes('› ynsaxqo')));
    assert.ok(typing.some((l) => l.includes('1 waiting for your OK: /status')));
    assert.equal(s.quits, 0);
    assert.equal(s.sent.length, 0);
    s.type('\r');
    await s.settle();
    assert.deepEqual(s.sent, [{ kind: 'start', text: 'ynsaxqo' }]);
    assert.ok(s.screen().some((l) => l.includes('ynsaxqo')));
  });

  it('navigates with /status, /threads and /new without posting the commands', async () => {
    const s = stand([answered('a', 'Existing conversation', MIN)], { chat: true });
    s.screen();
    await s.settle();
    s.type('/status\r');
    assert.ok(s.screen().some((l) => l.includes('Your agents')));
    s.type('/threads\r');
    assert.equal(s.screen()[0], ' Threads');
    assert.ok(s.screen().some((l) => l.includes('Existing conversation')));
    s.type('/new\r');
    assert.ok(onStream(s.screen()), 'back on the stream, whose line starts a thread');
    assert.equal(s.screen()[0], '  You · in Existing conversation · 1 min ago');
    assert.equal(s.sent.length, 0);
    s.type('A fresh conversation\r');
    await s.settle();
    assert.deepEqual(s.sent, [{ kind: 'start', text: 'A fresh conversation' }]);
  });

  it('shows local commands separately from agent skills and leaves an addressed skill as a message', async () => {
    const s = stand([], { chat: true });
    s.skills = [{ name: 'Claude', state: 'listening', present: true, skills: [{ name: 'status', description: 'Report agent status' }] }];
    s.screen();
    await s.settle();
    s.type('/');
    await s.settle();
    assert.ok(s.screen().some((l) => l.includes('/status   Agents, approvals and board activity · Tricot command')));
    s.type('\t');
    assert.ok(s.screen().some((l) => l.includes('› /status')));
    s.type('\x15@Claude /status\r');
    await s.settle();
    assert.deepEqual(s.sent, [{ kind: 'start', text: '@Claude /status' }]);
  });

  it('moves through the command menu with arrows and Enter', async () => {
    const s = stand([], { chat: true });
    s.screen();
    await s.settle();
    s.type('/\x1b[B\r');
    assert.ok(s.screen().some((l) => l.includes('Your agents')));
    s.type('/\x1b[A');
    assert.equal(s.screen().at(-3), ' › /quit', 'up from the first goes round to the last command');
    assert.equal(s.screen().at(-2), ' Quit, closing every agent; no message is sent.', 'and the row under the line says what Enter runs');
    s.type('\x1b[A\x1b[A\x1b[A\x1b[A\r');
    assert.ok(onStream(s.screen()), 'up four more is /new');
    assert.equal(s.quits, 0);
    assert.equal(s.sent.length, 0);
    s.type('/th\r');
    assert.equal(s.screen()[0], ' Threads', 'Enter accepts the matching local command');
  });

  it('keeps moving through the / list with ↑ ↓ on an agent’s skill, rather than scrolling', async () => {
    const s = stand([], { chat: true });
    s.skills = [{ name: 'Claude', state: 'listening', present: true, skills: [{ name: 'review', description: 'Review the change' }, { name: 'ship', description: 'Ship it' }] }];
    s.screen();
    await s.settle();
    s.type('/');
    await s.settle();
    s.type('\x1b[A');
    assert.ok(s.screen().some((l) => l.includes('› @Claude /ship')), 'up from the first goes round to the last skill');
    s.type('\x1b[A');
    assert.ok(s.screen().some((l) => l.includes('› @Claude /review')), 'up again is the skill before it');
    s.type('\x1b[A');
    assert.ok(s.screen().some((l) => l.includes('› /quit')), 'and then the last command');
    s.type('\x1b[B\x1b[B');
    assert.ok(s.screen().some((l) => l.includes('› @Claude /ship')), 'down goes forward through the skills too');
    s.type('\x1b[B');
    assert.ok(s.screen().some((l) => l.includes('› /status')), 'and round to the first');
    assert.equal(s.sent.length, 0);
  });

  it('keeps a conversation draft when opening and cancelling the local palette', async () => {
    const s = stand([], { chat: true });
    s.screen();
    await s.settle();
    s.type('A draft for later');
    const inner = s.tab as unknown as { threads: { list(): void; start(): void } };
    inner.threads.list();
    s.type('/');
    assert.equal(s.screen()[0], ' Threads', 'the panel stays');
    assert.equal(s.screen().at(-3), ' › /', 'the commands’ line at its foot');
    assert.equal(s.screen().at(-2), ' Agents, approvals and board activity; no message is sent.', 'what Enter runs: the first command');
    s.type('\x1b');
    assert.equal(s.screen()[0], ' Threads');
    assert.equal(s.screen().at(-1), ' ↑↓ pick · Enter read · n new · Esc close', 'the keys back with the panel');
    s.type('/new\r');
    assert.ok(s.screen().some((l) => l.includes('› A draft for later')));
    assert.equal(s.sent.length, 0);
  });

  it('cancels the status command palette back to status, without applying a command or sending text', async () => {
    const s = stand([], { chat: true });
    s.screen();
    await s.settle();
    s.type('/status\r/');
    assert.equal(s.screen()[0], '  No conversations on the board yet.', 'the chat behind the commands’ line');
    assert.equal(s.screen().at(-3), ' › /');
    assert.equal(s.screen().at(-1), ' Enter go · Tab complete · Esc cancel');
    s.type('\x1b');
    assert.ok(s.screen().some((l) => l.includes('Your agents')));
    assert.equal(s.sent.length, 0);
    s.type('\x1b');
    assert.ok(onStream(s.screen()));
    assert.equal(s.screen()[0], '  No conversations on the board yet.');
  });

  it('returns from status to the thread that was picked, after cancelling its palette', async () => {
    const s = stand([answered('a', 'Existing conversation', MIN)], { chat: true });
    s.screen();
    await s.settle();
    s.type('/threads\r\r');
    assert.equal(s.screen()[0], only('Existing conversation'));
    s.type('/status\r/\x1b\x1b');
    assert.equal(s.screen()[0], only('Existing conversation'));
    assert.equal(s.sent.length, 0);
  });

  it('keeps refused messages, and fits the header, notices and cursor at narrow and short sizes', async () => {
    const s = stand([], { chat: true, wordmark: 'whole' });
    s.screen();
    await s.settle();
    s.refusing = { error: 'The board did not answer.' };
    s.type('Please check this\r');
    await s.settle();
    assert.ok(s.screen().some((l) => l.includes('› Please check this')));
    assert.ok(s.screen().some((l) => l.includes('The board did not answer.')));
    for (const [cols, rows] of [[120, 24], [80, 10], [40, 6], [30, 3], [10, 1]]) {
      const frame = s.tab.render(cols, rows);
      assert.equal(frame.rows.length, rows);
      assert.ok(frame.plain.every((l) => columns(l) <= cols));
      if (frame.cursor) assert.ok(frame.cursor.y >= 0 && frame.cursor.y < rows && frame.cursor.x < cols);
    }
  });
});

// T257: the status view's a, x, o and q as /add, /stop, /open and /quit in
// the chat. The list or question shows at the chat's foot, in place of its
// keys, with the status view's keys; the host is asked as the keys ask it;
// and nothing typed as a command goes to the board.
describe("the Tricot tab's chat: the status view's keys as commands", () => {
  // The chat's line, empty, answering Claude in the stream, and the row under it.
  const LINE = ' › Reply to Claude…';
  const AIM = ' to Flaky test, the latest · Claude hears it';
  const CHAT_KEYS = ' Enter send · @ new thread · > elsewhere · Tab an earlier one · Esc threads';
  const onChat = (screen: string[]) => screen.slice(-3).join('\n') === [LINE, AIM, CHAT_KEYS].join('\n');
  const three: AddChoice[] = [
    { id: 'opencode', name: 'OpenCode' },
    { id: 'gemini', name: 'Gemini CLI', note: 'not installed', problem: "Gemini CLI isn't installed here." },
    { id: 'pi', name: 'Pi' },
  ];
  // On the chat, with a conversation in its stream and two agents running.
  async function chat(): Promise<Stand> {
    const s = stand([thread('a', 'Flaky test', [message(claude, 'It fails under load.', MIN)])], { chat: true });
    s.agents.push({ number: 2, name: 'Codex', state: 'running', lastOutput: NOW });
    s.choices = three;
    s.screen();
    await s.settle();
    return s;
  }

  it('lists them after /status, /threads and /new as Tricot commands, the row under the line saying what Enter runs', async () => {
    const s = await chat();
    s.type('/');
    const all = s.screen(200, 20);
    assert.deepEqual(all.slice(-9, -3).map((l) => l.trimEnd()), [
      ' ❯ /status   Agents, approvals and board activity · Tricot command',
      '   /threads  Browse conversations · Tricot command',
      '   /new      Start a new thread · Tricot command',
      "   /add      Add an agent that isn't running · Tricot command",
      '   /stop     Stop a running agent · Tricot command',
      ' ↓ /open     Open the board in your browser · Tricot command',
    ], 'a row each with what it does, six at most');
    assert.equal(all.at(-2), ' Agents, approvals and board activity; no message is sent.');
    for (const [typed, words] of [['/add', "Add an agent that isn't running"], ['/sto', 'Stop a running agent'], ['/o', 'Open the board in your browser'], ['/quit', 'Quit, closing every agent'], ['/st', 'Agents, approvals and board activity']]) {
      s.type(`\x15${typed}`);
      assert.equal(s.screen().at(-2), ` ${words}; no message is sent.`, typed);
    }
    s.type('\x15/add claude');
    assert.equal(s.screen().at(-2), AIM, 'with more after it, a message, as before');
    assert.deepEqual([s.opened, s.quits, s.added, s.stopped, s.sent], [0, 0, [], [], []], 'nothing is run or sent while typing');
  });

  it('/add lists the agents not running at the chat’s foot, as a does; Esc goes back to the chat as it was', async () => {
    const s = await chat();
    s.type('/add\r');
    let screen = s.screen();
    assert.deepEqual(screen.slice(-4), [' Add which agent?   ↑↓ move · Enter pick · Esc cancel', ' ❯ 1  OpenCode', '   2  Gemini CLI  not installed', '   3  Pi'], 'in place of the chat’s keys');
    assert.ok(screen.some((l) => l.includes('It fails under load.')), 'the chat above it');
    assert.deepEqual(screen.slice(-6, -4), [LINE, AIM], 'its line above it, empty: the command is not kept');
    assert.equal(s.tab.render(80, 20).cursor, undefined, 'the list has the keys, not the line');
    assert.equal(s.tab.typing, false);
    s.type('jz');
    assert.equal(s.screen().at(-2), ' ❯ 2  Gemini CLI  not installed', 'its keys are the list’s, and other letters do nothing');
    assert.ok(!s.screen().some((l) => l.includes('› jz') || l.includes('› z')));
    s.type('\x1b');
    assert.ok(onChat(s.screen()), 'back on the chat, as it was');
    assert.deepEqual([s.added, s.sent], [[], []], 'Esc: nothing added, nothing sent');
    s.type('/add\r\r');
    assert.deepEqual(s.added, ['opencode'], 'Enter picks the highlighted one, as in the status view');
    assert.ok(onChat(s.screen()));
    s.type('/add\r3');
    assert.deepEqual(s.added, ['opencode', 'pi'], 'and a digit its row');
    assert.equal(s.sent.length, 0);
  });

  it('/add says why an agent that can’t start didn’t, at the chat’s foot, until the next key', async () => {
    const s = await chat();
    s.type('/add\r2');
    let screen = s.screen();
    assert.deepEqual(screen.slice(-4), [LINE, AIM, " Gemini CLI isn't installed here.", CHAT_KEYS], 'above the chat’s keys');
    assert.deepEqual(s.added, []);
    s.type('h');
    screen = s.screen();
    assert.ok(!screen.some((l) => l.includes("isn't installed")), 'gone with the next key');
    assert.equal(screen.at(-3), ' › h', 'which is typed as ever');
    s.choices = [];
    s.type('\x15/add\r');
    assert.equal(s.screen().at(-1), ' Every agent is running. Esc back');
    s.type('x');
    assert.ok(onChat(s.screen()), 'any key goes back from an empty list, and is not typed');
  });

  it('/stop lists the agents running, asks "Stop it?" as x does, and goes back to the chat on Esc or No', async () => {
    const s = await chat();
    s.type('/stop\r');
    assert.deepEqual(s.screen().slice(-3), [' Stop which agent?  ↑↓ move · Enter pick · Esc cancel', ' ❯ 1  Claude', '   2  Codex']);
    s.type('2');
    assert.match(s.screen().at(-1)!, /^ Stop Codex\? {4}Yes {2}❯ No {2}\(←→ Enter, or y\/n\)$/);
    s.type('\x1b');
    assert.deepEqual(s.screen().slice(-4), [LINE, AIM, ' Codex keeps running.', CHAT_KEYS], 'Esc is No, back on the chat');
    assert.deepEqual(s.stopped, []);
    s.type('/stop\r\x1b');
    assert.ok(onChat(s.screen()), 'Esc from the list goes back too');
    assert.deepEqual(s.stopped, []);
    s.type('/stop\r\x1b[B\r\x1b[D\r');
    assert.deepEqual(s.stopped, [2], 'Enter on Yes stops it, as in the status view');
    assert.deepEqual(s.screen().slice(-2), [' Stopped Codex.', CHAT_KEYS]);
    s.type('/stop\r1y');
    assert.deepEqual(s.stopped, [2, 1], 'y answers at once');
    assert.equal(s.sent.length, 0);
  });

  it('/open opens the board and says so at the chat’s foot; /quit quits', async () => {
    const s = await chat();
    s.type('/open\r');
    assert.equal(s.opened, 1);
    assert.deepEqual(s.screen().slice(-4), [LINE, AIM, ' Opened the board in your browser.', CHAT_KEYS], 'still on the chat');
    s.type('/o\r');
    assert.equal(s.opened, 2, 'from the start of its name, as /th is /threads');
    assert.equal(s.quits, 0);
    s.type('/quit\r');
    assert.equal(s.quits, 1);
    assert.equal(s.sent.length, 0, 'none went to the board');
  });

  it('acts in the status view when picked on the line of commands its / opens, and Esc stays there', async () => {
    const s = await chat();
    s.type('/status\r/add\r');
    let screen = s.screen();
    assert.ok(screen.some((l) => l.includes('Your agents')), 'the status view, its list at its foot');
    assert.equal(screen.at(-4), ' Add which agent?   ↑↓ move · Enter pick · Esc cancel');
    s.type('\x1b');
    screen = s.screen();
    assert.ok(screen.some((l) => l.includes('Your agents')));
    assert.equal(screen.at(-1), ' o open the board · t threads · a add an agent · x stop one · q quit');
    s.type('/open\r');
    assert.equal(s.opened, 1);
    shows(s.screen(), ' Opened the board in your browser.');
    s.type('\x1b');
    assert.ok(onChat(s.screen()), 'Esc there goes back to the chat');
    assert.ok(!s.screen().some((l) => l.includes('Opened the board')), 'what was said in the status view stays there');
  });

  it('opens its list over the threads’ panel too, and Esc gives the panel its keys back', async () => {
    const s = await chat();
    s.type('/threads\r');
    assert.equal(s.screen()[0], ' Threads');
    s.type('/stop\r');
    assert.equal(s.screen()[0], ' Threads');
    assert.equal(s.screen().at(-3), ' Stop which agent?  ↑↓ move · Enter pick · Esc cancel');
    s.type('\x1b');
    assert.equal(s.screen()[0], ' Threads');
    assert.equal(s.screen().at(-1), PANEL_KEYS);
  });

  it('keeps the status view’s keys as they were', async () => {
    const s = await chat();
    s.type('/status\r');
    s.type('a1x2yo');
    assert.deepEqual([s.added, s.stopped, s.opened], [['opencode'], [2], 1]);
    s.type('q');
    assert.equal(s.quits, 1);
  });

  it('fits its list at the chat’s foot at narrow and short sizes', async () => {
    const s = stand([], { chat: true, wordmark: 'whole' });
    s.choices = three;
    s.screen();
    await s.settle();
    for (const typed of ['/add\r', '/stop\r', '/stop\r1']) {
      s.type(typed);
      for (const [cols, rows] of [[120, 24], [80, 10], [40, 6], [30, 3], [10, 1]]) {
        const frame = s.tab.render(cols, rows);
        assert.equal(frame.rows.length, rows, `${typed} ${cols}×${rows}`);
        assert.ok(frame.plain.every((l) => columns(l) <= cols));
        assert.equal(frame.cursor, undefined);
      }
      s.type('\x1b');
    }
    s.type('/open\r');
    for (const [cols, rows] of [[120, 24], [80, 10], [40, 6], [30, 3], [10, 1]]) {
      const frame = s.tab.render(cols, rows);
      assert.equal(frame.rows.length, rows, `${cols}×${rows}`);
      assert.ok(frame.plain.every((l) => columns(l) <= cols));
      if (frame.cursor) assert.ok(frame.cursor.y >= 0 && frame.cursor.y < rows && frame.cursor.x < cols);
    }
  });
});

describe("the Tricot tab's threads: deletion", () => {
  it('asks about the highlighted thread, starts on No, and cancels without a request', async () => {
    const s = stand([answered('a', 'Flaky test', MIN), answered('b', 'Pricing', 2 * MIN)]);
    await s.open();
    s.screen();
    s.type('\x1b[B');
    for (const cancel of ['\r', 'n', '\x1b', '\x03']) {
      s.type('x');
      shows(s.screen(), ' Delete thread?');
      shows(s.screen(), '  Pricing');
      assert.match(s.screen().at(-1)!, /  Yes  ❯ No/);
      s.type(cancel);
      assert.equal(s.screen()[0], ' Threads');
      assert.equal(s.sent.length, 0);
    }
    s.type('x');
    s.type('\x1b[200~y\r\x1b[201~');
    assert.equal(s.sent.length, 0, 'pasting cannot confirm a deletion');
    assert.equal(s.screen()[0], ' Delete thread?');
  });

  it('deletes once, shows undo even with no threads, and restores the same conversation', async () => {
    const original = answered('a', 'Flaky test', MIN);
    const s = stand([original]);
    await s.open();
    s.screen();
    s.type('x\x1b[D');
    assert.match(s.screen().at(-1)!, /❯ Yes    No/);
    let release!: () => void;
    s.gate = new Promise<void>((resolve) => (release = resolve));
    s.type('\r');
    s.type('y\r\x1b');
    assert.match(s.screen().at(-1)!, /Deleting the thread/);
    assert.deepEqual(s.sent, [{ kind: 'remove', thread: 'a' }]);
    release();
    await s.settle();
    const empty = s.screen();
    shows(empty, '  Thread deleted. Press u to undo.');
    shows(empty, '  No threads yet.');
    assert.match(empty.at(-1)!, /u undo/);
    s.type('u');
    await s.settle();
    assert.deepEqual(s.threads, [original]);
    assert.deepEqual(s.sent.at(-1), { kind: 'restore', thread: 'a' });
    assert.match(s.screen().find((l) => l.includes('Flaky test'))!, /❯/);
    assert.doesNotMatch(s.screen().at(-1)!, /u undo/);
  });

  it('keeps the thread and undo after refusals, and asks to let the terminal in before retrying', async () => {
    const s = stand([answered('a', 'Flaky test', MIN)]);
    await s.open();
    s.screen();
    s.refusing = { error: 'Let this terminal in.', needsSeat: true };
    s.type('xy');
    await s.settle();
    assert.equal(s.threads.length, 1);
    assert.ok(s.screen().some((l) => l.includes('Enter asks')));
    s.type('\r');
    assert.equal(s.seatAsked, 1);
    s.refusing = undefined;
    s.type('y');
    await s.settle();
    s.refusing = { error: 'The board did not answer.' };
    s.type('u');
    await s.settle();
    shows(s.screen(), '  The board did not answer.');
    assert.match(s.screen().at(-1)!, /u undo/);
    s.refusing = { error: 'Let this terminal in.', needsSeat: true };
    s.type('u');
    await s.settle();
    assert.ok(s.screen().some((l) => l.includes('u asks')));
    s.type('u');
    assert.equal(s.seatAsked, 1, 'the admission already pending is not asked twice');
    s.refusing = undefined;
    s.type('u');
    await s.settle();
    assert.equal(s.threads.length, 1);
  });

  it('closes a confirmation if its thread goes away, and never deletes the next thread instead', async () => {
    const a = answered('a', 'Flaky test', MIN);
    const b = answered('b', 'Pricing', 2 * MIN);
    const s = stand([a, b]);
    await s.open();
    s.screen();
    s.type('x\x1b[C');
    s.change([b]);
    await refreshed(s);
    assert.equal(s.screen()[0], ' Threads');
    s.type('y');
    assert.equal(s.sent.length, 0);
    assert.deepEqual(s.threads, [b]);
  });

  it('keeps delete and undo as text in a conversation and a new thread', async () => {
    const s = stand([answered('a', 'Flaky test', MIN)]);
    await s.open();
    s.screen();
    s.type('\rxu');
    assert.ok(s.screen().some((l) => l.includes('› xu')));
    s.type('\x1b\x1bnxu');
    assert.ok(s.screen().some((l) => l.includes('› xu')));
    assert.equal(s.sent.length, 0);
  });

  it('keeps a draft when its thread is deleted and restored elsewhere', async () => {
    const a = answered('a', 'Flaky test', MIN);
    const s = stand([a]);
    await s.open();
    s.screen();
    s.type('\rA reply in progress');
    s.change([]);
    await refreshed(s);
    assert.equal(s.screen()[0], ' Threads');
    s.change([a]);
    await refreshed(s);
    s.type('\r');
    assert.ok(s.screen().some((l) => l.includes('› A reply in progress')));
  });

  it('does not resurrect a deleted thread when a read begun before deletion returns late', async () => {
    const a = answered('a', 'Flaky test', MIN);
    const s = stand([a]);
    await s.open();
    s.screen();
    const tab = s.tab as unknown as { threads: { host: { access: { read(): Promise<{ ok: true; board: Board }> } } } };
    const access = tab.threads.host.access;
    const read = access.read;
    let release!: () => void;
    access.read = async () => {
      access.read = read;
      const stale = await read();
      await new Promise<void>((resolve) => (release = resolve));
      return stale;
    };
    s.change([a]);
    s.screen();
    await s.settle();
    s.type('xy');
    await s.settle();
    assert.equal(s.threads.length, 0);
    release();
    await s.settle();
    const shown = await refreshed(s);
    shows(shown, '  No threads yet.');
    assert.match(shown.at(-1)!, /u undo/);
  });

  it('fits the delete choices and undo hints in narrow windows without emitting controls from a title', async () => {
    const s = stand([answered('a', 'Hostile\x1b[2J\u202etitle', MIN)]);
    await s.open();
    s.screen();
    s.type('x');
    for (const [cols, rows] of [[120, 14], [80, 10], [40, 6], [30, 3], [10, 1]]) {
      const frame = s.tab.render(cols, rows);
      assert.equal(frame.rows.length, rows);
      assert.ok(frame.plain.every((l) => columns(l) <= cols));
      assert.ok(!frame.rows.join('').includes('\x1b[2J'));
      assert.ok(!frame.plain.join('').includes('\u202e'));
      if (cols >= 40) assert.match(frame.plain.at(-1)!, /Yes.*❯ No.*Esc/);
    }
    s.type('y');
    await s.settle();
    assert.match(s.screen(40, 6).at(-1)!, /u undo.*Esc/);
  });
});

// ---- against a real board --------------------------------------------------------------------

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let scratch: string;
before(() => {
  mkdirSync(path.join(repo, '.review'), { recursive: true });
  scratch = mkdtempSync(path.join(repo, '.review', 'test-threads-'));
});
after(() => removeScratch(scratch));

async function waitUntil(check: () => boolean, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

describe('the Tricot tab’s threads, on a real board', () => {
  let store: Store;
  let server: Server;
  let feed: LiveFeed;
  let base: string;
  let board: string;

  beforeEach(async () => {
    store = new Store(mkdtempSync(path.join(scratch, 'data-')));
    store.load();
    server = await new Promise<Server>((resolve) => {
      const listening = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' }).listen(0, '127.0.0.1', () => resolve(listening));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    board = store.createBoard({ title: 'Roadmap' }, me).id;
  });
  afterEach(async () => {
    feed.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.flush();
  });

  it('reads the threads through the routes table and follows the stream: a new thread, then a reply in the one picked', async () => {
    feed = watchBoard({ url: base, board, title: 'Roadmap', retryMs: 100 });
    assert.ok(await waitUntil(() => feed.now() !== undefined), 'the stream connected');
    const host: TabHost = { agents: () => [], live: () => feed.now(), now: Date.now, changed: () => {}, open: () => {}, quit: () => {}, choices: () => [], add: () => undefined, stop: () => {} };
    const noSend = async (): Promise<ThreadSent> => ({ ok: false, error: 'Not used here.' });
    const noReact = async (): Promise<ThreadReacted> => ({ ok: false, error: 'Not used here.' });
    const noComment = async (): Promise<CommentSent> => ({ ok: false, error: 'Not used here.' });
    const tab = new TricotTab(host, { url: base, title: 'Roadmap', threads: { me: 'Wassim', read: threadsReader({ url: base, board }), skills: async () => [], send: { start: noSend, reply: noSend, lens: noSend, react: noReact, remove: noSend, restore: noSend, comment: noComment, reactToComment: noComment } } });
    const screen = () => tab.render(100, 14).plain;
    tab.key(Buffer.from('/status\rt'));
    assert.ok(await waitUntil(() => screen().some((l) => l.includes('No threads yet.'))), screen().join('\n'));

    const started = store.startThread(board, '@Claude can you look at the flaky test?', me);
    assert.ok(await waitUntil(() => screen().some((l) => l.includes('can you look at the flaky test?'))), screen().join('\n'));
    tab.key(Buffer.from('\r'));
    assert.ok(screen().some((l) => l.includes('  You  ')));

    store.postToThread(started.id, 'It passes alone and fails under load.', claude);
    assert.ok(await waitUntil(() => screen().some((l) => l.includes('It passes alone and fails under load.'))), screen().join('\n'));
    assert.ok(screen().some((l) => l.includes('  Claude  agent · ')));
  });

  it('starts a thread and replies in it through the routes table, as the person: this terminal’s key in the header, the name and the door in the body, and the board has them', async () => {
    feed = watchBoard({ url: base, board, title: 'Roadmap', retryMs: 100 });
    assert.ok(await waitUntil(() => feed.now() !== undefined), 'the stream connected');
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const keys: string[] = [];
    const watched: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const url = String(input);
      if (url.endsWith('/api/approvals/hosts') && res.status === 201) keys.push(((await res.clone().json()) as { key: string }).key);
      if (init?.method === 'POST' && /\/threads/.test(url)) seen.push({ url: url.slice(base.length), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return res;
    };
    const answers = holdAnswers({ url: base, actor: 'Wassim', fetch: watched });
    try {
      const host: TabHost = { agents: () => [], live: () => feed.now(), now: Date.now, changed: () => {}, open: () => {}, quit: () => {}, choices: () => [], add: () => undefined, stop: () => {} };
      const tab = new TricotTab(host, { url: base, title: 'Roadmap', answers, threads: threadsAccess({ url: base, board, me: 'Wassim', answers }) });
      const screen = () => tab.render(100, 16).plain;
      tab.key(Buffer.from('/status\rt'));
      assert.ok(await waitUntil(() => screen().some((l) => l.includes('No threads yet.'))), screen().join('\n'));
      tab.key(Buffer.from('nCan you look at the flaky test?\r'));
      assert.ok(await waitUntil(() => screen()[0].trimEnd() === only('Can you look at the flaky test?')), screen().join('\n'));
      const [thread] = store.getBoard(board).threads!;
      assert.equal(thread.door, 'threads', 'started from the threads list, which is the door that fits');
      assert.equal(thread.lens, undefined, 'as General');
      assert.deepEqual(thread.startedBy, me);

      tab.key(Buffer.from('Raise it to 5 s?\r'));
      assert.ok(await waitUntil(() => store.getThread(thread.id).thread.messages.length === 2), 'the board has the reply');
      assert.deepEqual(store.getThread(thread.id).thread.messages[1].author, me);
      assert.equal(store.getThread(thread.id).thread.messages[1].body, 'Raise it to 5 s?');
      assert.ok(await waitUntil(() => screen().some((l) => l.trimEnd() === '    Raise it to 5 s?') && !screen().some((l) => l.includes('sending…'))), screen().join('\n'));

      assert.equal(seen.length, 2);
      assert.equal(seen[0].url, `/api/boards/${board}/threads`);
      assert.deepEqual(seen[0].body, { actor: 'Wassim', body: 'Can you look at the flaky test?', door: 'threads' });
      assert.equal(seen[1].url, `/api/threads/${thread.id}/messages`);
      assert.deepEqual(seen[1].body, { actor: 'Wassim', body: 'Raise it to 5 s?' });
      for (const sent of seen) {
        assert.equal(sent.headers[HOST_KEY_HEADER], keys[0], 'as the terminal the board gave a key');
        assert.equal(sent.headers['Content-Type'], 'application/json');
        assert.ok(!JSON.stringify(sent.body).includes(keys[0]) && !sent.url.includes(keys[0]), 'the key is only in its header');
      }
    } finally {
      await answers.release();
    }
  });

  it('answers a pinned part’s comment, a task’s and a decision’s from the stream, and reacts to a comment, through the routes table, as the person', async () => {
    feed = watchBoard({ url: base, board, title: 'Roadmap', retryMs: 100 });
    assert.ok(await waitUntil(() => feed.now() !== undefined), 'the stream connected');
    const [task] = store.planTasks(board, [{ title: 'Keep backlog quiet' }], me);
    store.addTaskComment(task.id, 'Is this feasible?', claude);
    const decision = store.postDecision(board, { question: 'Open the tab on chat?', options: [{ label: 'Yes' }, { label: 'No' }] }, claude);
    store.addComment(decision.id, 'I would go with Yes.', claude);
    const note = store.addBlock({ boardId: board }, { title: 'Plan', content: { type: 'note', text: 'Beta ships to ten teams.' } }, sam);
    const pin = store.pinComment(note.id, { kind: 'text', quote: 'ten teams' }, 'Which ten?', sam).pin;
    const answers = holdAnswers({ url: base, actor: 'Wassim' });
    try {
      const host: TabHost = { agents: () => [], live: () => feed.now(), now: Date.now, changed: () => {}, open: () => {}, quit: () => {}, choices: () => [], add: () => undefined, stop: () => {} };
      const tab = new TricotTab(host, { url: base, title: 'Roadmap', answers, threads: threadsAccess({ url: base, board, me: 'Wassim', answers }) });
      const screen = () => tab.render(100, 20).plain;
      assert.ok(await waitUntil(() => screen().some((l) => l.includes('Which ten?'))), screen().join('\n'));
      const said = () => store.getBoard(board);
      tab.key(Buffer.from('The ones on the wiki.\r'));
      assert.ok(await waitUntil(() => said().canvas.pins.find((p) => p.id === pin.id)?.discussion?.thread?.length === 2), 'the board has the reply about the part');
      assert.deepEqual(said().canvas.pins[0].discussion?.thread?.[1].author, me);
      tab.key(Buffer.from(`>T${task.number} Yes, once it is ready.\r`));
      assert.ok(await waitUntil(() => said().tasks[0].comments.length === 2), 'and the comment on the task');
      assert.deepEqual(said().tasks[0].comments[1].author, me);
      assert.equal(said().tasks[0].comments[1].body, 'Yes, once it is ready.');
      tab.key(Buffer.from(`>#${decision.number} Yes.\r`));
      assert.ok(await waitUntil(() => said().decisions[0].comments.length === 2), 'and on the decision');
      assert.deepEqual(said().decisions[0].comments[1].author, me);
      assert.ok(await waitUntil(() => screen().some((l) => l.includes('Yes.')) && !screen().some((l) => l.includes('sending…'))), screen().join('\n'));
      tab.key(Buffer.from('\t\t1')); // Sam's, then Claude's on the decision: 👍
      assert.ok(await waitUntil(() => said().decisions[0].comments[0].reactions?.some((r) => r.emoji === '👍' && r.by.name === 'Wassim') === true), 'the board has the reaction');
      assert.ok(await waitUntil(() => screen().some((l) => l.trim() === '👍 You')), screen().join('\n'));
    } finally {
      await answers.release();
    }
  });

  it('reacts to a message, sets a thread’s lens and starts a thread with one through the routes table, as the person, and shows an agent’s reaction too', async () => {
    feed = watchBoard({ url: base, board, title: 'Roadmap', retryMs: 100 });
    assert.ok(await waitUntil(() => feed.now() !== undefined), 'the stream connected');
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const keys: string[] = [];
    const watched: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const url = String(input);
      if (url.endsWith('/api/approvals/hosts') && res.status === 201) keys.push(((await res.clone().json()) as { key: string }).key);
      if (init?.method === 'POST' && /\/threads/.test(url)) seen.push({ url: url.slice(base.length), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return res;
    };
    const answers = holdAnswers({ url: base, actor: 'Wassim', fetch: watched });
    try {
      const host: TabHost = { agents: () => [], live: () => feed.now(), now: Date.now, changed: () => {}, open: () => {}, quit: () => {}, choices: () => [], add: () => undefined, stop: () => {} };
      const tab = new TricotTab(host, { url: base, title: 'Roadmap', answers, threads: threadsAccess({ url: base, board, me: 'Wassim', answers }) });
      const screen = () => tab.render(100, 18).plain;
      const press = (keysTyped: string) => tab.key(Buffer.from(keysTyped));
      const started = store.startThread(board, '@Claude can you look at the flaky test?', me);
      const answered = store.postToThread(started.id, 'It passes alone and fails under load.', claude);
      const said = answered.messages.at(-1)!;
      const mine = (emoji: string) => store.getThread(started.id).thread.messages[1].reactions?.some((r) => r.emoji === emoji && r.by.kind === 'human' && r.by.name === 'Wassim');
      press('/status\rt');
      assert.ok(await waitUntil(() => screen().some((l) => l.includes('Flaky') || l.includes('flaky test?'))), screen().join('\n'));
      press('\r');

      press('\t1');
      assert.ok(await waitUntil(() => mine('👍') === true), 'the board has the 👍, as the person');
      const row = (text: string) => screen().some((l) => sides(l)[0] === text);
      assert.ok(await waitUntil(() => row('    👍 You')), screen().join('\n'));
      store.react({ threadId: started.id }, { commentId: said.id, emoji: '👀' }, { kind: 'agent', name: 'Codex' });
      assert.ok(await waitUntil(() => row('    👍 You · 👀 Codex')), 'an agent’s counts too:\n' + screen().join('\n'));
      press('1');
      assert.ok(await waitUntil(() => mine('👍') === false), 'pressed again, it is taken back');
      assert.ok(await waitUntil(() => row('    👀 Codex')), screen().join('\n'));

      press('\x1b');
      press('\x0c\x1b[B\r');
      assert.ok(await waitUntil(() => store.getThread(started.id).thread.lens?.name === 'Legal'), 'the board has the lens');
      assert.ok(await waitUntil(() => screen().some((l) => l.includes('│ ❯   Legal · '))), screen().join('\n'));

      press('\x1b');
      press('n\x0c\x1b[F\rPricing\rWeigh cost against value.\rShould it be per seat?\r');
      assert.ok(await waitUntil(() => store.getBoard(board).threads!.length === 2), 'the board has the new thread');
      const [, fresh] = store.getBoard(board).threads!;
      assert.deepEqual(fresh.lens, { name: 'Pricing', brief: 'Weigh cost against value.' });

      const [react, unreact, lens, start] = seen.filter((s) => /reactions$|\/lens$/.test(s.url) || s.url === `/api/boards/${board}/threads`);
      assert.equal(react.url, `/api/threads/${started.id}/messages/${said.id}/reactions`);
      assert.deepEqual(react.body, { actor: 'Wassim', emoji: '👍' });
      assert.deepEqual(unreact.body, { actor: 'Wassim', emoji: '👍', remove: true });
      assert.equal(lens.url, `/api/threads/${started.id}/lens`);
      assert.deepEqual(lens.body, { actor: 'Wassim', lens: { name: 'Legal' } });
      assert.equal(start.url, `/api/boards/${board}/threads`);
      assert.deepEqual(start.body, { actor: 'Wassim', body: 'Should it be per seat?', door: 'threads', lens: { name: 'Pricing', brief: 'Weigh cost against value.' } });
      for (const sent of [react, unreact, lens, start]) {
        assert.equal(sent.headers[HOST_KEY_HEADER], keys[0], 'as the terminal the board gave a key');
        assert.ok(!JSON.stringify(sent.body).includes(keys[0]) && !sent.url.includes(keys[0]), 'the key is only in its header');
      }
    } finally {
      await answers.release();
    }
  });

  it('says why when the board refuses a lens or a reaction, through the routes table', async () => {
    const answers = holdAnswers({ url: base, actor: 'Wassim' });
    try {
      const send = threadsAccess({ url: base, board, me: 'Wassim', answers }).send;
      const started = store.startThread(board, 'Anyone there?', me);
      const reply = await send.lens(started.id, { name: 'Pricing' });
      assert.equal(reply.ok, false, 'a lens of one’s own needs a brief');
      assert.match(!reply.ok ? reply.error : '', /needs a brief/);
      const own = await send.react(started.id, started.messages[0].id, '👍', false);
      assert.equal(own.ok, false, 'not to one’s own message');
      assert.match(!own.ok ? own.error : '', /your own message/);
      const gone = await send.react(started.id, 'no-such-message', '👍', false);
      assert.equal(gone.ok, false);
    } finally {
      await answers.release();
    }
  });

  it('reads what each agent can run, through the routes table', async () => {
    store.reportSkills('Claude', [{ name: 'review', description: 'Review a diff' }]);
    const skills = await skillsReader({ url: base, board })();
    assert.deepEqual(skills.find((a) => a.name === 'Claude')?.skills.map((k) => k.name), ['review']);
    assert.deepEqual(await skillsReader({ url: 'http://127.0.0.1:1', board, timeoutMs: 500 })(), [], 'none when the board is away');
  });

  it('opens on chat, sends a message, follows its reply, and navigates locally on a real board', async () => {
    feed = watchBoard({ url: base, board, retryMs: 100 });
    assert.ok(await waitUntil(() => feed.now() !== undefined));
    const answers = holdAnswers({ url: base, actor: 'Wassim' });
    try {
      const asked: string[] = []; // what the tab asked of the host
      const host: TabHost = { agents: () => [{ number: 1, name: 'Claude', state: 'running', lastOutput: Date.now() }], live: () => feed.now(), now: Date.now, changed: () => {}, open: () => void asked.push('open'), quit: () => void asked.push('quit'), choices: () => [{ id: 'codex', name: 'Codex' }], add: (id) => void asked.push(`add ${id}`), stop: (n) => void asked.push(`stop ${n}`) };
      const tab = new TricotTab(host, { url: base, title: 'Roadmap', answers, wordmark: 'whole', threads: threadsAccess({ url: base, board, me: 'Wassim', answers }) });
      const screen = () => tab.render(80, 18).plain;
      const press = (keys: string) => tab.key(Buffer.from(keys));
      assert.ok(await waitUntil(() => screen().some((l) => l.includes('What do you want to work through?'))));
      press('@Claude check the licence\r');
      assert.ok(await waitUntil(() => (store.getBoard(board).threads ?? []).length === 1));
      const started = store.getBoard(board).threads![0];
      store.postToThread(started.id, 'The licence allows it.', claude);
      assert.ok(await waitUntil(() => screen().some((l) => l.includes('The licence allows it.'))));
      press('/status\r');
      assert.ok(screen().some((l) => l.includes('Your agents')));
      press('/threads\r');
      assert.ok(screen().some((l) => l.includes('check the licence')));
      press('/new\r');
      assert.ok(screen().some((l) => l.includes('What do you want to work through?')));
      press('/add\r1/stop\r1y/open\r/quit\r'); // T257: the status view's a, x, o and q
      assert.deepEqual(asked, ['add codex', 'stop 1', 'open', 'quit']);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal((store.getBoard(board).threads ?? []).length, 1);
      assert.deepEqual(store.getThread(started.id).thread.messages.map((m) => m.body), ['@Claude check the licence', 'The licence allows it.']);
    } finally {
      await answers.release();
    }
  });

  it('deletes and undoes from the terminal as the person, preserves its work, and refuses a plain API caller', async () => {
    feed = watchBoard({ url: base, board, retryMs: 100 });
    assert.ok(await waitUntil(() => feed.now() !== undefined));
    const started = store.startThread(board, 'Can we bundle Pi?', me, { name: 'Legal' });
    store.postToThread(started.id, 'Checking the licence.', claude);
    const decision = store.postDecision(board, { question: 'Which licence?' }, claude);
    store.addThreadWork(started.id, { kind: 'decision', id: decision.id }, claude);
    const original = structuredClone(store.getThread(started.id).thread);
    const unauthorised = (restore: boolean) => fetch(`${base}${routeUrl(restore ? routes.restoreItem : routes.removeItem, { id: started.id })}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: 'Wassim' }),
    });
    assert.equal((await unauthorised(false)).status, 403);
    const answers = holdAnswers({ url: base, actor: 'Wassim' });
    try {
      const host: TabHost = { agents: () => [], live: () => feed.now(), now: Date.now, changed: () => {}, open: () => {}, quit: () => {}, choices: () => [], add: () => undefined, stop: () => {} };
      const tab = new TricotTab(host, { url: base, title: 'Roadmap', answers, threads: threadsAccess({ url: base, board, me: 'Wassim', answers }) });
      const screen = () => tab.render(80, 18).plain;
      const press = (keys: string) => tab.key(Buffer.from(keys));
      press('/status\rt');
      assert.ok(await waitUntil(() => screen().some((l) => l.includes('Can we bundle Pi?'))));
      press('x\x1b[C\r');
      assert.ok(await waitUntil(() => store.getBoard(board).threads!.length === 0));
      assert.ok(await waitUntil(() => screen().at(-1)!.includes('u undo')));
      assert.equal(store.getBoard(board).decisions[0].id, decision.id);
      assert.equal((await unauthorised(true)).status, 403);
      press('u');
      assert.ok(await waitUntil(() => store.getBoard(board).threads!.length === 1));
      assert.ok(await waitUntil(() => screen().some((l) => l.includes('Can we bundle Pi?'))));
      assert.deepEqual(store.getThread(started.id).thread, original);
      assert.doesNotMatch(screen().at(-1)!, /u undo/);
    } finally {
      await answers.release();
    }
  });

  it('counts only the changes that touch the board’s conversations, for the tab to read again on', async () => {
    feed = watchBoard({ url: base, board, retryMs: 100 });
    assert.ok(await waitUntil(() => feed.now() !== undefined));
    const counted = () => feed.now()?.chatVer;
    const quiet = async (why: string) => {
      const before = counted();
      await new Promise((resolve) => setTimeout(resolve, 300)); // long enough for the stream to bring it
      assert.equal(counted(), before, why);
    };
    const moves = async (why: string, act: () => void) => {
      const before = counted();
      act();
      assert.ok(await waitUntil(() => counted() !== before), why);
    };
    const first = counted();
    assert.equal(typeof first, 'number', 'it counts from the first news the stream gives');
    const decision = store.postDecision(board, { question: 'Which store?', options: [{ label: 'SQLite' }, { label: 'Files' }] }, claude);
    const [task] = store.planTasks(board, [{ title: 'Keep backlog quiet' }], me);
    await quiet('a card with nothing said on it is no conversation');
    store.updateTask(task.id, { note: 'Started on it' }, claude);
    await quiet('nor is a progress note');
    let started!: Thread;
    await moves('a thread started', () => (started = store.startThread(board, 'Anyone there?', me)));
    await moves('a reply in it', () => store.postToThread(started.id, 'Yes.', claude));
    await moves('a comment on a task, in the backlog', () => store.addTaskComment(task.id, 'Is this feasible?', me));
    await moves('a comment on a decision', () => store.addComment(decision.id, 'SQLite, I think.', claude));
    const note = store.addBlock({ boardId: board }, { title: 'Plan', content: { type: 'note', text: 'Beta ships to ten teams.' } }, me);
    await quiet('a block');
    await moves('a comment on a part of the board context', () => store.pinComment(note.id, { kind: 'text', quote: 'ten teams' }, 'Which ten?', me));
    await moves('a task renamed, which its comments are labelled with', () => store.updateTask(task.id, { title: 'Keep the backlog quiet' }, me));
  });

  it('shows a comment on a card in the chat’s stream as it comes, on a real board', async () => {
    feed = watchBoard({ url: base, board, retryMs: 100 });
    assert.ok(await waitUntil(() => feed.now() !== undefined));
    const host: TabHost = { agents: () => [], live: () => feed.now(), now: Date.now, changed: () => {}, open: () => {}, quit: () => {}, choices: () => [], add: () => undefined, stop: () => {} };
    const noSend = async (): Promise<ThreadSent> => ({ ok: false, error: 'Not used here.' });
    const noReact = async (): Promise<ThreadReacted> => ({ ok: false, error: 'Not used here.' });
    const noComment = async (): Promise<CommentSent> => ({ ok: false, error: 'Not used here.' });
    const tab = new TricotTab(host, { url: base, title: 'Roadmap', threads: { me: 'Wassim', read: threadsReader({ url: base, board }), skills: async () => [], send: { start: noSend, reply: noSend, lens: noSend, react: noReact, remove: noSend, restore: noSend, comment: noComment, reactToComment: noComment } } });
    const screen = () => tab.render(100, 16).plain.map((l) => l.trimEnd());
    assert.ok(await waitUntil(() => screen()[0] === '  No conversations on the board yet.'), screen().join('\n'));
    const [task] = store.planTasks(board, [{ title: 'Keep backlog quiet' }], me);
    store.addTaskComment(task.id, '@Claude is this feasible?', me);
    assert.ok(await waitUntil(() => screen().includes(`  You · on T${task.number} Keep backlog quiet · just now`)), screen().join('\n'));
    store.addTaskComment(task.id, 'Yes: the server can filter it.', claude);
    assert.ok(await waitUntil(() => screen().includes('    Yes: the server can filter it.')), screen().join('\n'));
    assert.ok(screen().includes(`  Claude  agent · on T${task.number} Keep backlog quiet · just now`));
  });

  it('says why when the board will not give them', async () => {
    feed = watchBoard({ url: base, board, retryMs: 100 });
    assert.ok(await waitUntil(() => feed.now() !== undefined));
    const read = threadsReader({ url: base, board: 'no-such-board' });
    const result = await read();
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : '', /\S/);
    const away = await threadsReader({ url: 'http://127.0.0.1:1', board, timeoutMs: 500 })();
    assert.equal(away.ok, false);
    assert.match(!away.ok ? away.error : '', /^The board didn't answer: /);
  });
});
