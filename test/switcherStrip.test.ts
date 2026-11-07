import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import type { Approval } from '../src/core/approvals';
import { watchBoard } from '../src/cli/switcher/live';
import { agentWords, columns, isLight, renderStrip, rgbOf, type AgentNow, type BoardLive, type StripEntry } from '../src/cli/switcher/strip';
import type { AgentStep } from '../src/server/steps';
import { waitFor } from './switcher/harness';

// The strip under the agents: each one's name and what it is doing, from
// the board's stream where there is something (a request for permission, a
// step, listening), else from the terminal (a bell, drawing or not), and
// how it ended. The agent showing is marked; it fits any width.

const NOW = Date.parse('2026-11-04T15:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const running = (name: string): AgentNow => ({ name, state: 'running', lastOutput: NOW - 60_000 });
const step = (agent: string, text: string, more: Partial<AgentStep> = {}): AgentStep => ({ agent, text, at: ago(3_000), ...more });
const approval = (agent: string, more: Partial<Approval> = {}): Approval => ({ id: 'a1', agent, harness: 'claude', tool: 'Bash', input: { command: 'npm test' }, at: ago(1_000), ...more });
const live = (more: Partial<BoardLive> = {}): BoardLive => ({ board: 'roadmap-1', steps: [], approvals: [], presence: [], ...more });

describe("an agent's words in the strip", () => {
  it('says how it ended, with its exit code when that is not 0', () => {
    assert.deepEqual(agentWords({ name: 'Codex', state: 'ended', exitCode: 0 }, undefined, NOW), { words: 'ended', tone: 'quiet' });
    assert.deepEqual(agentWords({ name: 'Codex', state: 'ended', exitCode: 127 }, undefined, NOW), { words: 'ended (127)', tone: 'quiet' });
  });

  it("puts a request for permission waiting on the board first, then a hidden agent's bell, then its step", () => {
    const board = live({ approvals: [approval('Claude')], steps: [step('Claude', 'Running npm test')] });
    assert.deepEqual(agentWords(running('Claude'), board, NOW), { words: 'waiting for your OK', tone: 'alert' });
    assert.deepEqual(agentWords({ ...running('Claude'), wantsYou: true }, live({ steps: board.steps }), NOW), { words: 'wants you', tone: 'alert' });
    assert.deepEqual(agentWords(running('Claude'), live({ steps: board.steps }), NOW), { words: 'Running npm test', tone: 'normal' });
  });

  it("takes only its own: another agent's request, or one on another board, isn't its", () => {
    assert.equal(agentWords(running('Claude'), live({ approvals: [approval('Codex')] }), NOW).words, 'idle');
    const elsewhere = approval('Claude', { on: { board: 'other-2', title: 'Other' } });
    assert.equal(agentWords(running('Claude'), live({ approvals: [elsewhere] }), NOW).words, 'idle');
    const here = approval('claude', { on: { board: 'roadmap-1', title: 'Roadmap' } });
    assert.equal(agentWords(running('Claude'), live({ approvals: [here] }), NOW).words, 'waiting for your OK', 'names as people write them');
  });

  it('says how long a step that runs has run, and an ended one how long it took', () => {
    const tests = step('Codex', 'Running npm test', { running: true, at: ago(72_000) });
    assert.equal(agentWords(running('Codex'), live({ steps: [tests] }), NOW).words, 'Running npm test · 1 min 12 s');
    const ran = step('Codex', 'Ran npm test', { ended: true, ms: 42_000 });
    assert.equal(agentWords(running('Codex'), live({ steps: [ran] }), NOW).words, 'Ran npm test (42 s)');
  });

  it('says listening when the agent waits on the board, and dims a step gone quiet', () => {
    const presence = [{ name: 'Claude', lastSeen: ago(1_000), state: 'listening' as const }];
    assert.deepEqual(agentWords(running('Claude'), live({ presence }), NOW), { words: 'listening on the board', tone: 'normal' });
    const old = step('Claude', 'Reading src/cli/main.ts', { at: ago(60_000) });
    assert.deepEqual(agentWords(running('Claude'), live({ steps: [old] }), NOW), { words: 'Reading src/cli/main.ts', tone: 'quiet' });
    assert.equal(agentWords(running('Claude'), live({ steps: [step('Claude', 'x', { at: ago(10 * 60_000) })] }), NOW).words, 'idle', 'gone');
  });

  it('falls back to what the terminal shows without steps: starting, working, idle', () => {
    assert.equal(agentWords({ name: 'Codex', state: 'starting' }, undefined, NOW).words, 'starting');
    assert.equal(agentWords({ name: 'Codex', state: 'running', lastOutput: NOW - 500 }, undefined, NOW).words, 'working');
    assert.equal(agentWords({ name: 'Codex', state: 'running', lastOutput: NOW - 5_000 }, undefined, NOW).words, 'idle');
  });

  it("keeps a step's words on one line", () => {
    assert.equal(agentWords(running('Codex'), live({ steps: [step('Codex', 'Running\x1b[2J a\nb')] }), NOW).words, 'Running [2J a b');
  });
});

describe('the strip', () => {
  const entries: StripEntry[] = [
    { name: 'Claude', words: 'waiting for your OK', tone: 'alert', ended: false },
    { name: 'Codex', words: 'Running npm test', tone: 'normal', ended: false },
    { name: 'OpenCode', words: 'ended (127)', tone: 'quiet', ended: true },
  ];
  const hint = 'Ctrl+\\ next · Ctrl+\\ 1–3 pick · Ctrl+\\ q quit';

  it('lists every agent with its words, marks the one showing, and the keys at the right', () => {
    const strip = renderStrip(entries, 1, 150, hint);
    assert.equal(columns(strip.plain), 150);
    const labels = ' ○ 1 Claude · waiting for your OK   ● 2 Codex · Running npm test   ✕ 3 OpenCode · ended (127) ';
    assert.equal(strip.plain, `${labels}${' '.repeat(150 - labels.length - hint.length - 1)}${hint} `);
    assert.equal(renderStrip(entries, 1, labels.length + hint.length + 1, hint).plain.trimEnd(), labels.trimEnd(), 'the keys only with a space either side');
    assert.deepEqual(
      strip.ranges.map((r) => strip.plain.slice(r.from - 1, r.to - 1).trim()),
      ['○ 1 Claude · waiting for your OK', '● 2 Codex · Running npm test', '✕ 3 OpenCode · ended (127)'],
      'where a click picks each',
    );
    assert.ok(strip.line.endsWith('\x1b[0m'));
  });

  it('gives way as the window narrows: the words of the one showing and those wanting you, then names alone, then cut', () => {
    const some = renderStrip(entries, 1, 80, hint).plain;
    assert.equal(columns(some), 80);
    assert.match(some, /^ ○ 1 Claude · waiting for your OK {3}● 2 Codex · Running npm test {3}✕ 3 OpenCode +$/);
    const names = renderStrip(entries, 1, 40, hint).plain;
    assert.equal(names.trimEnd(), ' ○ 1 Claude   ● 2 Codex   ✕ 3 OpenCode');
    const cut = renderStrip(entries, 1, 20, hint).plain;
    assert.equal(columns(cut), 20);
    assert.match(cut, /…/);
  });

  it('lists the Tricot tab first, with no number, when there is one (T192)', () => {
    const withTab: StripEntry[] = [{ name: 'Tricot', words: '', tone: 'normal', ended: false, number: '' }, ...entries.map((e, at) => ({ ...e, number: String(at + 1) }))];
    const strip = renderStrip(withTab, 0, 150, 'Ctrl+\\ 0 to answer');
    assert.match(strip.plain, /^ ● Tricot {3}○ 1 Claude · waiting for your OK {3}○ 2 Codex · Running npm test {3}✕ 3 OpenCode · ended \(127\) +Ctrl\+\\ 0 to answer $/);
    assert.deepEqual(strip.ranges.map((r) => r.index), [0, 1, 2, 3]);
  });

  // T22: what each agent was started on, after its name, while there is room.
  it('says what an agent was started on after its name, and drops it first as the window narrows', () => {
    const ruled: StripEntry[] = [
      { name: 'Tricot', words: '', tone: 'normal', ended: false, number: '' },
      { name: 'Claude', words: 'Running npm test', tone: 'normal', ended: false, number: '1', runsOn: 'Opus high' },
      { name: 'Codex', words: 'idle', tone: 'quiet', ended: false, number: '2' },
    ];
    const keys = 'Ctrl+\\ next · Ctrl+\\ 0–2 pick · Ctrl+\\ q quit';
    const labels = ' ● Tricot   ○ 1 Claude · Opus high · Running npm test   ○ 2 Codex · idle ';
    const wide = renderStrip(ruled, 0, labels.length + keys.length + 2, keys);
    assert.equal(wide.plain, `${labels} ${keys} `);
    assert.equal(wide.plain.slice(wide.ranges[1].from - 1, wide.ranges[1].to - 1).trim(), '○ 1 Claude · Opus high · Running npm test', 'a click on it still picks Claude');
    // One column less, and it is the first to go: before the keys, and before any agent's words.
    const words = ' ● Tricot   ○ 1 Claude · Running npm test   ○ 2 Codex · idle ';
    const narrower = renderStrip(ruled, 0, labels.length + keys.length + 1, keys).plain;
    assert.match(narrower, new RegExp(`^${words.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')} +Ctrl\\+\\\\ next .* q quit $`));
    assert.equal(renderStrip(ruled, 0, words.length, keys).plain.trimEnd(), words.trimEnd(), 'the words stay once the keys have gone');
    // Narrower still, as before: the words of the one showing, then names alone, then cut.
    assert.equal(renderStrip(ruled, 1, 56, keys).plain.trimEnd(), ' ○ Tricot   ● 1 Claude · Running npm test   ○ 2 Codex');
    assert.equal(renderStrip(ruled, 1, 40, keys).plain.trimEnd(), ' ○ Tricot   ● 1 Claude   ○ 2 Codex');
    // Nothing set, nothing said.
    assert.match(renderStrip([{ ...ruled[1], runsOn: undefined }], 0, 80, 'keys').plain, /^ ● 1 Claude · Running npm test +keys $/);
  });

  it("takes the terminal's background into account", () => {
    assert.equal(isLight('rgb:ffff/ffff/ffff'), true);
    assert.equal(isLight('rgb:1e1e/1e1e/1e1e'), false);
    assert.equal(isLight('#fdf6e3'), true);
    assert.equal(isLight(undefined), false);
    assert.notEqual(renderStrip(entries, 0, 100, hint, true).line, renderStrip(entries, 0, 100, hint, false).line);
  });

  it("reads the terminal's background as red, green and blue, for the chat's tints", () => {
    assert.deepEqual(rgbOf('rgb:1e1e/1e1e/1e1e'), [30, 30, 30]);
    assert.deepEqual(rgbOf('rgb:ff/80/00'), [255, 128, 0]);
    assert.deepEqual(rgbOf('rgba:ffff/ffff/ffff/ffff'), [255, 255, 255]);
    assert.deepEqual(rgbOf('#fdf6e3'), [253, 246, 227]);
    assert.equal(rgbOf('not a colour'), undefined);
    assert.equal(rgbOf(undefined), undefined);
  });
});

describe("the board's stream, for the strip", () => {
  // A board's stream as server/live.ts sends it, from a server the test drives.
  async function fakeBoard(events: unknown[] = []) {
    const streams: ServerResponse[] = [];
    const asked: string[] = [];
    const server = createServer((req, res) => {
      asked.push(`${req.url} ${req.headers.authorization ?? ''}`);
      if (req.url?.includes('/events?')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events, more: false, total: events.length, seq: 1 }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('retry: 1000\n\n');
      res.write(`event: hello\ndata: {"ver":1,"seq":1}\n\n`);
      streams.push(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const send = (event: string, data: unknown) => {
      for (const res of streams) res.write(`event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`);
    };
    const drop = () => {
      for (const res of streams.splice(0)) res.destroy();
    };
    return { url, send, drop, asked, close: () => new Promise((resolve) => server.close(resolve)), connections: () => streams.length };
  }

  it('keeps the steps, requests and presence it sends, comes back after the board restarts, and stops when it is deleted', async () => {
    const board = await fakeBoard();
    const feed = watchBoard({ url: board.url, board: 'roadmap-1', headers: { Authorization: 'Bearer t0k' }, retryMs: 50 });
    let told = 0;
    feed.onChange(() => told++);
    try {
      assert.ok(await waitFor(() => feed.now() !== undefined));
      assert.deepEqual(board.asked, ['/api/boards/roadmap-1/stream Bearer t0k']);
      board.send('steps', [step('Codex', 'Running npm test', { at: new Date().toISOString() })]);
      board.send('approvals', [approval('Claude', { at: new Date().toISOString() })]);
      board.send('presence', [{ name: 'Codex', lastSeen: new Date().toISOString(), state: 'working' }]);
      board.send('change', { ver: 2 });
      assert.ok(await waitFor(() => feed.now()!.presence.length === 1));
      const now = Date.now();
      assert.equal(agentWords(running('Codex'), feed.now(), now).words, 'Running npm test');
      assert.equal(agentWords(running('Claude'), feed.now(), now).words, 'waiting for your OK');

      board.drop();
      assert.ok(await waitFor(() => feed.now() === undefined || feed.now()!.steps.length === 0), 'what it knew goes with the connection');
      assert.ok(await waitFor(() => board.connections() === 1 && feed.now() !== undefined), 'and it connects again');
      assert.equal(feed.now()!.steps.length, 0);

      board.send('deleted', {});
      assert.ok(await waitFor(() => feed.now() === undefined));
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(board.asked.length, 2, 'not again');
      assert.ok(told > 3);
    } finally {
      feed.stop();
      board.drop();
      await board.close();
    }
  });

  it('says nothing, and keeps trying, while no board answers', async () => {
    const feed = watchBoard({ url: 'http://127.0.0.1:9', board: 'roadmap-1', retryMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(feed.now(), undefined);
    feed.stop();
  });

  it("keeps, for the Tricot tab, the board's latest events and its title as changes bring them", async () => {
    const event = (seq: number, summary: string) => ({ seq, at: new Date().toISOString(), actor: { kind: 'human', name: 'Sam' }, type: 'task_updated', summary });
    const board = await fakeBoard([event(3, 'planned T3'), event(2, 'planned T2'), event(1, 'made the board')]);
    const feed = watchBoard({ url: board.url, board: 'roadmap-1', title: 'Roadmap', activity: 3, retryMs: 50 });
    try {
      assert.ok(await waitFor(() => feed.now()?.activity?.length === 3), 'read once on connecting');
      assert.equal(feed.now()!.title, 'Roadmap');
      assert.ok(board.asked.some((a) => a.startsWith('/api/boards/roadmap-1/events?limit=3 ')));
      board.send('change', { ver: 2, seq: 5, events: [event(4, 'commented on T3'), event(5, 'approved T3')], head: { title: 'Roadmap 2027' } });
      assert.ok(await waitFor(() => feed.now()!.activity![0].seq === 5));
      assert.deepEqual(feed.now()!.activity!.map((e) => e.summary), ['approved T3', 'commented on T3', 'planned T3'], 'newest first, as many as it keeps');
      assert.equal(feed.now()!.title, 'Roadmap 2027');
      board.send('change', { ver: 3, seq: 5, events: [event(5, 'approved T3')] });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(feed.now()!.activity!.filter((e) => e.seq === 5).length, 1, 'each once');
    } finally {
      feed.stop();
      board.drop();
      await board.close();
    }
  });
});
