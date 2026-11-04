import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boardDigest, eventsDigest } from '../src/core/digest';
import { barSends, DOOR_NAMES, doorNote, doorPlace } from '../src/core/doors';
import { Store } from '../src/core/store';
import { threadMade } from '../src/core/threadList';
import { threadDetail, threadsDigest } from '../src/core/threads';
import type { Actor, Board, Thread } from '../src/core/types';
import { createApp } from '../src/server/app';
import { INSTRUCTIONS } from '../src/server/mcp';
import { BAR_PLACEHOLDERS, doorOfView, listeningLabel, replyPlaceholder, replyingTo, viewOfDoor } from '../src/web/chatDoor';

// One chat bar on every tab: what's sent from it starts a thread through
// that tab's door, which the thread keeps, and agents are told what the door
// aims at (core/doors.ts). With no agent listening, the Decisions bar posts a
// plain question card instead.

const claude: Actor = { kind: 'agent', name: 'Claude' };
const wassim: Actor = { kind: 'human', name: 'Wassim' };

describe('Doors into a thread', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-doors-'));
    store = new Store(dir);
    store.load();
    store.presentAgents = () => ['Claude'];
    boardId = store.createBoard({ title: 'Ledgerly' }, wassim).id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the door a thread was started from, across a restart', async () => {
    const weighing = store.startThread(boardId, 'Not sure about the pricing page: one plan or three?', wassim, undefined, { door: 'decisions' });
    const work = store.startThread(boardId, 'The failed-payment email needs a second version', wassim, { name: 'Design' }, { door: 'tasks' });
    const view = store.startThread(boardId, 'Map the sign-up flow', wassim, undefined, { door: 'canvas' });
    const open = store.startThread(boardId, 'Are the VAT numbers right for Norway?', wassim, undefined, { door: 'threads' });
    const agents = store.startThread(boardId, 'Shall I tidy the canvas?', claude);
    assert.deepEqual([weighing, work, view, open, agents].map((t) => t.door), ['decisions', 'tasks', 'canvas', 'threads', undefined]);
    assert.deepEqual(work.lens, { name: 'Design', brief: work.lens!.brief }, 'the lens is kept beside it');
    await store.flush();
    const again = new Store(dir);
    again.load();
    assert.equal(again.getThread(weighing.id).thread.door, 'decisions');
    assert.equal(again.getThread(agents.id).thread.door, undefined);
    await again.flush();
  });

  it("tells agents what each door aims at, with the thread's id to link what they make", () => {
    const board = store.getBoard(boardId);
    const thread = (door: Thread['door']) => ({ id: 't1', door });
    assert.equal(
      doorNote(thread('decisions')),
      'It was started from the Decisions tab, so the aim is a decision card. Ask a question or two only if you need them, then post the card with post_decision(thread_id: t1) so it links back here, and reply. A direct question that already names its options becomes the card straight away, without more questions.',
    );
    assert.equal(
      doorNote(thread('tasks')),
      'It was started from the Tasks tab, so the aim is a task. Ask only what you need to know, then plan it with plan_tasks(thread_id: t1) so it links back here, and reply.',
    );
    assert.equal(
      doorNote(thread('canvas')),
      'It was started from the Board Context, so the aim is a view of the project as blocks on the board context. Add them with add_block(board_id, thread_id: t1) so they link back here, then reply.',
    );
    assert.equal(
      doorNote(thread('threads')),
      "It was started from the threads list, so it's open-ended: talk it through, and if it lands as a decision, a task or blocks, pass thread_id: t1 to what you make so it links back here.",
    );
    assert.equal(doorNote(thread(undefined)), undefined, "an agent's thread, or an older one, has no aim");
    assert.deepEqual(
      (['decisions', 'tasks', 'canvas', 'threads'] as const).map((d) => [DOOR_NAMES[d], doorPlace(d)]),
      [
        ['Decisions', 'the Decisions tab'],
        ['Tasks', 'the Tasks tab'],
        ['Board Context', 'the Board Context'],
        ['Threads', 'the threads list'],
      ],
    );

    // Wherever an agent meets the thread: its updates, what waits on it, get_board and get_thread.
    const since = board.seq;
    const started = store.startThread(boardId, 'Stripe or Paddle for billing?', wassim, { name: 'Legal' }, { door: 'decisions' });
    const aim = doorNote(started)!;
    const updates = eventsDigest(store.eventsSince(boardId, since), board.seq, { board, viewer: 'Claude' });
    assert.ok(updates.includes(`For any agent: the first to reply answers, with reply_in_thread(thread_id: ${started.id}). Answer through its Legal lens:`), updates);
    assert.ok(updates.includes(` ${aim}`), 'the aim follows the lens');
    assert.ok(threadsDigest(board, 'Claude')!.endsWith(aim));
    assert.match(boardDigest(board, 'Claude'), new RegExp(`\\[thread id: ${started.id}\\] · started from the Decisions tab · Legal lens`));
    assert.ok(threadDetail(board, started, 'Claude').includes(`\n${aim}\n`));
  });

  it('starts a thread from the bar, but posts a plain question on Decisions while no agent listens', () => {
    assert.equal(barSends('decisions', 1), 'thread');
    assert.equal(barSends('decisions', 0), 'question', 'nobody to turn it into a card');
    for (const door of ['tasks', 'canvas', 'threads'] as const) assert.equal(barSends(door, 0), 'thread', `${door}: it waits in its thread`);
  });
});

describe('The chat bar on each tab', () => {
  const board = (threads: Thread[], extra: Partial<Board> = {}) =>
    ({ decisions: [], tasks: [], threads, canvas: { blocks: [], groups: [], links: [], pins: [] }, ...extra }) as unknown as Board;
  const message = (author: Actor, refs?: Thread['messages'][number]['refs']) => ({ id: Math.random().toString(36).slice(2), author, body: 'Hi', at: '2026-11-02T10:00:00Z', ...(refs && { refs }) });

  it("says what each tab's door is for, and opens a thread on the tab it came from", () => {
    assert.deepEqual(
      (['decisions', 'tasks', 'canvas'] as const).map((view) => BAR_PLACEHOLDERS[doorOfView(view)]),
      ['What are you weighing?', 'What needs doing?', 'Ask agents for a view of the project…'],
    );
    assert.deepEqual(['decisions', 'tasks', 'canvas', 'threads', undefined].map((d) => viewOfDoor(d as Thread['door'])), ['decisions', 'tasks', 'canvas', undefined, undefined]);
  });

  it('names who a reply goes to, and who is listening', () => {
    const fresh = { messages: [message(wassim)] };
    assert.equal(replyPlaceholder(fresh, ['Claude']), 'Reply to Claude…', 'the one agent listening');
    assert.equal(replyPlaceholder(fresh, ['Claude', 'Codex']), 'Reply…');
    assert.equal(replyingTo({ messages: [message(wassim), message({ kind: 'agent', name: 'Codex' })] }, ['Claude']), 'Codex', 'the agent answering it');
    assert.equal(replyingTo({ lens: { name: 'Legal', agent: 'Pi' }, messages: [message(claude)] }, []), 'Pi', 'the lens routes it');
    assert.deepEqual([[], ['Claude'], ['Claude', 'Codex'], ['A', 'B', 'C']].map(listeningLabel), [undefined, 'Claude', 'Claude and Codex', '3 agents']);
  });

  it('names what a thread made, once each, leaving out cards a reply only named', () => {
    const canvas = { blocks: [], groups: [], links: [], pins: [] };
    const fromThread = { id: 't1', title: 'Pricing' };
    const decision = { id: 'd1', number: 78, comments: [{ id: 'c1' }], canvas, fromThread };
    const named = { id: 'd2', number: 12, comments: [], canvas }; // older, from nowhere
    const task = { id: 'k1', number: 48, comments: [], canvas, fromThread };
    const blocks = [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }];
    const made = board([], {
      decisions: [decision, named],
      tasks: [task],
      canvas: { blocks, groups: [], links: [], pins: [] },
    } as unknown as Partial<Board>);
    const thread = {
      id: 't1',
      messages: [
        message(claude, [{ kind: 'decision', id: 'd1' }, { kind: 'block', id: 'b1' }, { kind: 'comment', id: 'c1', on: 'd1' }]),
        message(claude, [{ kind: 'decision', id: 'd1' }, { kind: 'decision', id: 'd2' }, { kind: 'block', id: 'b2' }, { kind: 'task', id: 'gone' }]),
      ],
      pending: [{ kind: 'task' as const, id: 'k1', by: claude }, { kind: 'block' as const, id: 'b3', by: claude }],
    };
    assert.deepEqual(threadMade(made, thread), ['#78', 'T48', '3 blocks']);
    assert.deepEqual(threadMade(made, { id: 't1', messages: [message(wassim)] }), []);
  });
});

// Over REST and MCP, as the page and an agent reach the server.
describe('Doors over REST and MCP', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: Store;
  let client: Client;

  async function request(method: 'GET' | 'POST', route: string, body?: Record<string, unknown>) {
    const response = await fetch(`${base}/api${route}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json', Origin: base } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, json: await response.json() };
  }

  async function callText(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content.map((c) => c.text).join('\n');
  }

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-doors-mcp-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
  });

  after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts a thread from the Decisions bar, tells the agent its aim, and links the card it posts back to it", async () => {
    const boardId = (await request('POST', '/boards', { actor: 'Wassim', title: 'Ledgerly' })).json.id as string;
    await callText('get_board', { board_id: boardId });
    const since = store.getBoard(boardId).seq;
    const started = await request('POST', `/boards/${boardId}/threads`, { actor: 'Wassim', body: 'Stripe or Paddle for billing?', door: 'decisions' });
    assert.equal(started.status, 201);
    assert.equal(started.json.door, 'decisions');
    const threadId = started.json.id as string;
    assert.equal((await request('POST', `/boards/${boardId}/threads`, { actor: 'Wassim', body: 'Hi', door: 'kitchen' })).status, 400);

    const heard = await callText('wait_for_updates', { board_id: boardId, since, timeout_seconds: 1 });
    assert.ok(heard.includes(`It was started from the Decisions tab, so the aim is a decision card.`), heard);
    assert.ok(heard.includes(`post_decision(thread_id: ${threadId})`));
    assert.match(await callText('get_thread', { thread_id: threadId }), /\nIt was started from the Decisions tab, so the aim is a decision card\./);

    // A direct question that names its options: the agent posts the card straight away.
    const posted = await callText('post_decision', {
      board_id: boardId,
      question: 'Which payment provider runs subscriptions?',
      options: [{ label: 'Stripe' }, { label: 'Paddle' }],
      thread_id: threadId,
    });
    assert.match(posted, /It shows in thread "Stripe or Paddle for billing\?", under your reply/);
    await callText('reply_in_thread', { thread_id: threadId, body: 'Posted it as #1.' });
    const board = (await request('GET', `/boards/${boardId}`)).json as Board;
    assert.equal(board.decisions[0].fromThread?.id, threadId, 'the card links back');
    assert.deepEqual(threadMade(board, board.threads!.find((t) => t.id === threadId)!), ['#1']);
  });

  it('posts a plain question card when no agent is listening on Decisions', async () => {
    const boardId = (await request('POST', '/boards', { actor: 'Wassim', title: 'Quiet board' })).json.id as string;
    assert.equal(barSends('decisions', 0), 'question');
    // What the bar sends then: the question, as the old Ask a question bar did.
    const posted = await request('POST', `/boards/${boardId}/decisions`, { actor: 'Wassim', question: 'Do we ask for company size at sign-up?' });
    assert.equal(posted.status, 201);
    assert.equal(posted.json.status, 'open');
    assert.equal(posted.json.question, 'Do we ask for company size at sign-up?');
    assert.equal(store.getBoard(boardId).threads, undefined, 'no thread');
  });

  it("tells agents in its instructions that a thread's tab gives it an aim", () => {
    assert.match(INSTRUCTIONS, /People talk with you in threads, each with a lens \(Legal, Design\) and often a tab's aim: answer through both/);
  });
});
