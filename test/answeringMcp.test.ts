import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';
import { readGuide } from './guide';
import { removeScratch } from './platform';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

// An agent answering people over MCP: in one call with then_wait, and from
// updates that carry what it needs, told once per session.
// The person's browser, let in as one of their seats (seatHelper.ts): it signs what needs one.
let seat: TestSeat;

describe('Answering people in one call, over MCP and REST', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: Store;
  const clients: Client[] = [];

  async function connect(agent: string): Promise<Client> {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=${agent}`)));
    clients.push(client);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  }

  async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
    const result = await call(client, name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content.map((c) => c.text).join('\n\n');
  }

  async function post(route: string, body: Record<string, unknown>) {
    const response = await fetch(`${base}/api${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign('POST', `/api${route}`, JSON.stringify({ actor: 'Wassim', ...body })) },
      body: JSON.stringify({ actor: 'Wassim', ...body }),
    });
    assert.ok(response.ok, `${route}: ${response.status}`);
    return response.json();
  }

  // A board with a task ready for agents, and an agent that has read the board.
  async function setUp(title: string, agent: Client) {
    const boardId = (await post('/boards', { title })).id as string;
    const task = await post(`/boards/${boardId}/tasks`, { title: 'Ship the onboarding tour' });
    await post(`/tasks/${task.id}`, { status: 'todo' });
    await callText(agent, 'get_board', { board_id: boardId });
    return { boardId, taskId: task.id as string };
  }

  const until = async (check: () => boolean, what: string) => {
    const deadline = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > deadline) assert.fail(`never saw ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-answer-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    seat = letIn(app);
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    for (const client of clients) await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  it('describes then_wait on the tools that answer people', async () => {
    const claude = await connect('Claude');
    const { tools } = await claude.listTools();
    for (const name of ['comment', 'reply_in_thread', 'react']) {
      const tool = tools.find((t) => t.name === name)!;
      assert.ok((tool.inputSchema.properties as Record<string, unknown>).then_wait, name);
    }
    assert.match(tools.find((t) => t.name === 'comment')!.description ?? '', /then_wait posts, then listens in the same call/);
    assert.match(tools.find((t) => t.name === 'wait_for_updates')!.description ?? '', /A message for you comes whole: answer it, with then_wait to keep listening/);
    const guide = await readGuide(claude, 'conversation');
    assert.match(guide, /Pass then_wait \(seconds, as for wait_for_updates\): it posts first, then waits/);
    assert.match(guide, /comes whole, with the card's title and status, the messages before it you haven't seen, and the call that answers it/);
  });

  it('posts the reply first, then waits and brings back what comes next, without saying again what it has', async () => {
    const claude = await connect('Claude');
    const { boardId, taskId } = await setUp('One call', claude);
    const since = store.getBoard(boardId).seq;
    await post(`/tasks/${taskId}/comments`, { body: 'Can we cut the third step?' });
    const heard = await callText(claude, 'wait_for_updates', { board_id: boardId, since, timeout_seconds: 5 });
    assert.match(heard, new RegExp(`Wassim \\(human\\) commented on T1 "Ship the onboarding tour": "Can we cut the third step\\?"\\. Reply with comment\\(task_id: ${taskId}\\)\\.\\n {2}T1 "Ship the onboarding tour": to do\\.\\n`));

    let returned = false;
    const replying = call(claude, 'comment', { task_id: taskId, body: 'Yes: it repeats the first.', then_wait: 10 }).finally(() => (returned = true));
    await until(() => store.getTask(taskId).task.comments.some((c) => c.body === 'Yes: it repeats the first.'), 'the reply posted');
    assert.equal(returned, false, 'still listening once the reply is on the board');
    await post(`/tasks/${taskId}/comments`, { body: 'Great. And the second step?' });
    const result = await replying;
    assert.equal(result.content[0].text, 'Commented on T1.');
    const next = result.content[1].text;
    assert.match(next, new RegExp(`^- \\(\\d+\\) Wassim \\(human\\) commented on T1 "Ship the onboarding tour": "Great\\. And the second step\\?"\\. Reply with comment\\(task_id: ${taskId}\\)\\.\\n {2}Before it: 2 comments you've seen\\.\\n\\nCursor: \\d+`));
    assert.doesNotMatch(next, /to do\./, 'the card once');

    // The session's cursor moved on: a wait from it hears nothing new.
    const quiet = await call(claude, 'reply_in_thread', { thread_id: (await post(`/boards/${boardId}/threads`, { body: 'Where should the tour start?' })).id, body: 'On the board.', then_wait: 1 });
    assert.match(quiet.content[1].text, /^- \(\d+\) Wassim \(human\) started thread "Where should the tour start\?"/, 'what came while it wrote comes at once');
  });

  it('times out cleanly, shows the agent listening throughout, and refuses a bad reply without waiting', async () => {
    const codex = await connect('Codex'); // has never waited
    const { boardId, taskId } = await setUp('Listening', codex);
    await post(`/tasks/${taskId}/comments`, { body: 'Looks good.' });
    await callText(codex, 'get_updates', { board_id: boardId, since: store.getBoard(boardId).seq - 1 });

    const presence: { name: string; state: string }[][] = [];
    const abort = new AbortController();
    const stream = await fetch(`${base}/api/boards/${boardId}/stream`, { signal: abort.signal });
    void (async () => {
      const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
      let pending = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          pending += value;
          for (let end = pending.indexOf('\n\n'); end >= 0; end = pending.indexOf('\n\n')) {
            const frame = pending.slice(0, end);
            pending = pending.slice(end + 2);
            if (/^event: presence$/m.test(frame)) presence.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]));
          }
        }
      } catch {
        // closed
      }
    })();
    await until(() => presence.length > 0, 'the presence on connecting');
    const before = presence.length;

    const start = Date.now();
    const result = await call(codex, 'react', { task_id: taskId, emoji: '👍', then_wait: 1 });
    assert.ok(Date.now() - start >= 1000);
    assert.match(result.content[0].text, /^Reacted 👍 to Wassim's comment on T1: "Looks good\."/);
    assert.match(result.content[1].text, /^No new activity\. Cursor: \d+\nNothing yet after 1s; call again to keep waiting\./);
    const during = presence.slice(before).map((agents) => agents.find((a) => a.name === 'Codex')?.state);
    assert.ok(during.length > 0, 'presence was told');
    assert.deepEqual([...new Set(during)], ['listening'], 'never working while it reacted and waited');
    abort.abort();

    const refusedAt = Date.now();
    const refused = await call(codex, 'comment', { task_id: 'nope', body: 'Hello', then_wait: 30 });
    assert.equal(refused.isError, true);
    assert.equal(refused.content.length, 1);
    assert.ok(Date.now() - refusedAt < 2000, 'no wait after a refusal');
  });

  it('gives a new session the context once, and only what is new after', async () => {
    const first = await connect('Claude');
    const { boardId, taskId } = await setUp('Sessions', first);
    await post(`/tasks/${taskId}/comments`, { body: 'Can we cut the third step?' });
    await callText(first, 'comment', { task_id: taskId, body: 'Yes, it repeats the first.' });
    await post(`/tasks/${taskId}/comments`, { body: 'And the second step?' });
    await callText(first, 'comment', { task_id: taskId, body: 'It can stay.' });
    const since = store.getBoard(boardId).seq;
    const long = `Then let's ship two steps.\n\n${'The map shows the agents, so the panel needs a way in from it. '.repeat(6)}`;
    await post(`/tasks/${taskId}/comments`, { body: long });

    // The agent restarted: its new session hasn't been told any of it.
    const fresh = await connect('Claude');
    const told = await callText(fresh, 'get_updates', { board_id: boardId, since });
    assert.ok(told.includes(`: "${long.trim().replace(/\n(?!\n)/g, '\n  ')}". Reply with comment(task_id: ${taskId}).`), told);
    assert.ok(
      told.includes(
        [
          '  T1 "Ship the onboarding tour": to do.',
          '  Before it (1 older in get_task):',
          '  - you: "Yes, it repeats the first."',
          '  - Wassim (human): "And the second step?"',
          '  - you: "It can stay."',
        ].join('\n'),
      ),
      told,
    );
    const again = await callText(fresh, 'get_updates', { board_id: boardId, since });
    assert.match(again, /commented on T1 "Ship the onboarding tour" \(you've seen it\)\. Reply with comment/);
    assert.doesNotMatch(again, /Before it|to do\.|The map shows/, 'nothing told twice');

    const next = store.getBoard(boardId).seq;
    await post(`/tasks/${taskId}/comments`, { body: 'Agreed?' });
    const followUp = await callText(fresh, 'wait_for_updates', { board_id: boardId, since: next, timeout_seconds: 5 });
    assert.match(followUp, /: "Agreed\?"\. Reply with comment\(task_id: \w+\)\.\n {2}Before it: 4 comments you've seen; 1 older in get_task\.\n\nCursor/);

    // A session that read the card has all of it.
    await callText(first, 'get_task', { task_id: taskId });
    const later = store.getBoard(boardId).seq;
    await post(`/tasks/${taskId}/comments`, { body: 'Shipping it.' });
    assert.match(await callText(first, 'get_updates', { board_id: boardId, since: later }), /: "Shipping it\."\. Reply with comment\(task_id: \w+\)\.\n {2}Before it: 6 comments you've seen\.\n\nCursor/);
  });
});
