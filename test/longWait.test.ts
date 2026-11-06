import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { agentKinds, agentOfMcpClient } from '../src/core/agents/registry';
import { Store } from '../src/core/store';
import type { WaitOptions } from '../src/core/store/inputs';
import { createApp } from '../src/server/app';
import { Hangups } from '../src/server/mcp/hangups';
import { CLIENT_LIMIT_MARGIN_SECONDS, longestWait, MAX_WAIT_SECONDS, UNKNOWN_CLIENT_WAIT_SECONDS } from '../src/server/mcp/session';
import { Presence } from '../src/server/presence';
import { letIn, type TestSeat } from './seatHelper';
import { removeScratch } from './platform';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

// An idle agent listens in long waits (T238): up to 15 minutes a call, less
// for a client that cuts a call sooner (its registry entry says), shown as
// listening throughout, and over the moment someone acts or the agent hangs up.

describe('how long one wait lasts, by the agent registry', () => {
  it('names each agent by the name its MCP client gives, once', () => {
    const names = agentKinds().map((kind) => kind.mcpClient.clientName);
    assert.equal(new Set(names).size, names.length);
    for (const kind of agentKinds()) assert.equal(agentOfMcpClient(kind.mcpClient.clientName)?.id, kind.id);
    assert.equal(agentOfMcpClient('Claude-Code')?.id, 'claude', 'whatever its case');
    assert.equal(agentOfMcpClient('cursor-vscode'), undefined);
    assert.equal(agentOfMcpClient(undefined), undefined);
  });

  it('waits 15 minutes for a client that lets a call run, and ends inside the limit of one that cuts it sooner', () => {
    assert.equal(MAX_WAIT_SECONDS, 15 * 60);
    const waits = Object.fromEntries(agentKinds().map((kind) => [kind.id, longestWait(kind.mcpClient.clientName)]));
    assert.deepEqual(waits, { claude: 900, codex: 270, pi: 900, omp: 270, gemini: 570, opencode: 270 });
    for (const kind of agentKinds()) {
      const limit = kind.mcpClient.callLimitSeconds;
      const expected = limit === undefined ? MAX_WAIT_SECONDS : Math.min(MAX_WAIT_SECONDS, limit - CLIENT_LIMIT_MARGIN_SECONDS);
      assert.equal(longestWait(kind.mcpClient.clientName), expected, kind.id);
    }
  });

  it('keeps a client it does not know to the wait every client managed before', () => {
    assert.equal(longestWait('cursor-vscode'), UNKNOWN_CLIENT_WAIT_SECONDS);
    assert.equal(longestWait(undefined), UNKNOWN_CLIENT_WAIT_SECONDS);
    assert.equal(UNKNOWN_CLIENT_WAIT_SECONDS, 240);
  });
});

describe('presence through a long wait', () => {
  it('shows an agent listening, and seen just now, for the whole of a 15-minute wait', () => {
    let now = 1_000_000;
    const changes: string[] = [];
    const presence = new Presence((id) => changes.push(id), () => now);
    presence.startWaiting('b1', 'Claude');
    for (let minute = 1; minute <= 15; minute++) {
      now += 60_000;
      presence.sweep();
      const [claude] = presence.list('b1');
      assert.equal(claude?.state, 'listening', `minute ${minute}`);
      assert.equal(claude.lastSeen, new Date(now).toISOString(), 'it hears what happens the moment it does');
      assert.deepEqual(presence.agents().map((a) => [a.name, a.state, a.lastSeen]), [['Claude', 'listening', new Date(now).toISOString()]]);
    }
    assert.deepEqual(changes, ['b1'], 'nothing flickers while it waits');

    presence.stopWaiting('b1', 'Claude');
    const ended = now;
    now += 3 * 60_000;
    presence.sweep();
    assert.deepEqual(presence.list('b1').map((a) => [a.state, a.lastSeen]), [['away', new Date(ended).toISOString()]], 'once the wait is over, as at any call');
    presence.close();
  });
});

// A response as Node gives it to the transport: closed when it has ended, or when its connection drops first.
function response(): ServerResponse & { end(): void; drop(): void } {
  const res = new EventEmitter() as EventEmitter & { writableFinished: boolean; end(): void; drop(): void };
  res.writableFinished = false;
  res.end = () => {
    res.writableFinished = true;
    res.emit('close');
  };
  res.drop = () => res.emit('close');
  return res as unknown as ServerResponse & { end(): void; drop(): void };
}

describe('Hangups', () => {
  it('aborts a call when its connection closes before the answer, and not after', () => {
    const hangups = new Hangups();
    const answered = response();
    hangups.watch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }, answered);
    const first = hangups.signal(1)!;
    assert.equal(first.aborted, false);
    answered.end();
    assert.equal(first.aborted, false, 'answered: nothing to end');
    assert.equal(hangups.signal(1), undefined, 'and forgotten');

    const dropped = response();
    hangups.watch([{ jsonrpc: '2.0', id: 'a', method: 'tools/call' }, { jsonrpc: '2.0', id: 'b', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }], dropped);
    const [a, b] = [hangups.signal('a')!, hangups.signal('b')!];
    dropped.drop();
    assert.ok(a.aborted && b.aborted, 'each request of a batch');
    assert.equal(hangups.signal('a'), undefined);
  });

  it('watches only requests', () => {
    const hangups = new Hangups();
    const res = response();
    hangups.watch({ jsonrpc: '2.0', id: 3, result: {} }, res);
    hangups.watch(undefined, res);
    assert.equal(hangups.signal(3), undefined);
    assert.equal(res.listenerCount('close'), 0);
  });
});

describe('long waits over MCP', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: Store;
  let seat: TestSeat;
  const clients: Client[] = [];
  // Each wait the store is asked for: how long it may last, and when it ended.
  const waits: { timeoutMs: number; ended: Promise<unknown> }[] = [];

  async function connect(clientName: string, agent: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const client = new Client({ name: clientName, version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=${agent}`));
    await client.connect(transport);
    clients.push(client);
    return { client, transport };
  }

  async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content.map((c) => c.text).join('\n\n');
  }

  async function post(route: string, body: Record<string, unknown>) {
    const sent = JSON.stringify({ actor: 'Wassim', ...body });
    const res = await fetch(`${base}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign('POST', `/api${route}`, sent) }, body: sent });
    assert.ok(res.ok, `${route}: ${res.status}`);
    return res.json();
  }

  const presenceOf = async (boardId: string) => ((await (await fetch(`${base}/api/boards/${boardId}`)).json()).presence as { name: string; state: string }[]).map((a) => [a.name, a.state]);

  // The wait the store was last asked for, once the call has reached it.
  async function nextWait(count: number) {
    const deadline = Date.now() + 3000;
    while (waits.length < count) {
      if (Date.now() > deadline) assert.fail('the call never started to wait');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return waits[count - 1];
  }

  // Resolves with how long `promise` took, failing if it takes over `ms`.
  async function within<T>(ms: number, promise: Promise<T>, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} took over ${ms}ms`)), ms)));
    try {
      return await Promise.race([promise, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function board(title: string) {
    const boardId = (await post('/boards', { title })).id as string;
    const task = await post(`/boards/${boardId}/tasks`, { title: 'Ship it' });
    return { boardId, taskId: task.id as string };
  }

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-long-wait-'));
    store = new Store(dir);
    store.load();
    const wait = store.waitForEvents.bind(store);
    store.waitForEvents = (boardId: string, since: number, options: WaitOptions) => {
      const ended = wait(boardId, since, options);
      waits.push({ timeoutMs: options.timeoutMs, ended });
      return ended;
    };
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

  it('lets Claude Code wait 15 minutes, listening throughout, and ends the wait the moment a person writes', async () => {
    const { client } = await connect('claude-code', 'Claude');
    const { boardId, taskId } = await board('Long wait');
    const cursor = Number((await callText(client, 'get_board', { board_id: boardId })).match(/Cursor: (\d+)/)![1]);

    const waiting = callText(client, 'wait_for_updates', { board_id: boardId, since: cursor, timeout_seconds: 3600 });
    const wait = await nextWait(waits.length + 1);
    assert.equal(wait.timeoutMs, MAX_WAIT_SECONDS * 1000, 'an hour asked, 15 minutes given');
    assert.deepEqual(await presenceOf(boardId), [['Claude', 'listening']]);

    await post(`/tasks/${taskId}/comments`, { body: 'Can you take this one?' });
    const heard = await within(2000, waiting, 'the wait after a comment');
    assert.match(heard, /Wassim \(human\) commented on T1 "Ship it": "Can you take this one\?"/);
  });

  it('waits as long as the client allows when the agent names no timeout, and less for one that cuts calls sooner', async () => {
    const { client } = await connect('codex-mcp-client', 'Codex');
    const { boardId, taskId } = await board('Codex waits');
    await callText(client, 'get_board', { board_id: boardId });

    const asked = async (args: Record<string, unknown>) => {
      const waiting = callText(client, 'wait_for_updates', { board_id: boardId, since: store.getBoard(boardId).seq, ...args });
      const { timeoutMs } = await nextWait(waits.length + 1);
      await post(`/tasks/${taskId}/comments`, { body: 'Ping' });
      await within(2000, waiting, 'the wait');
      return timeoutMs / 1000;
    };
    assert.equal(await asked({}), 270, "nothing asked: Codex's 5 minutes, less the margin");
    assert.equal(await asked({ timeout_seconds: 900 }), 270);
    assert.equal(await asked({ timeout_seconds: 20 }), 20, 'a shorter wait as asked');

    // A reply that keeps listening is held to the same.
    const replying = callText(client, 'comment', { task_id: taskId, body: 'On it.', then_wait: 3600 });
    assert.equal((await nextWait(waits.length + 1)).timeoutMs, 270_000);
    await post(`/tasks/${taskId}/comments`, { body: 'Thanks' });
    assert.match(await within(2000, replying, 'the reply'), /Thanks/);
  });

  it('keeps a client it does not know to 4 minutes', async () => {
    const { client } = await connect('some-other-client', 'Other');
    const { boardId, taskId } = await board('Other waits');
    const waiting = callText(client, 'wait_for_updates', { board_id: boardId, since: store.getBoard(boardId).seq, timeout_seconds: 900 });
    assert.equal((await nextWait(waits.length + 1)).timeoutMs, 240_000);
    await post(`/tasks/${taskId}/comments`, { body: 'Hello' });
    await within(2000, waiting, 'the wait');
  });

  it('ends a wait when the agent hangs up without cancelling it', async () => {
    const { client, transport } = await connect('claude-code', 'Claude');
    const { boardId } = await board('Hung up');
    await callText(client, 'get_board', { board_id: boardId });

    // The call as a client sends it, on a connection that then drops: no cancel comes.
    const hangUp = new AbortController();
    const count = waits.length + 1;
    const body = { jsonrpc: '2.0', id: 'gone-1', method: 'tools/call', params: { name: 'wait_for_updates', arguments: { board_id: boardId, since: store.getBoard(boardId).seq } } };
    const res = await fetch(`${base}/mcp?agent=Claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': transport.sessionId!, 'mcp-protocol-version': transport.protocolVersion! },
      body: JSON.stringify(body),
      signal: hangUp.signal,
    });
    assert.equal(res.status, 200);
    const wait = await nextWait(count);
    assert.equal(wait.timeoutMs, MAX_WAIT_SECONDS * 1000);
    assert.deepEqual(await presenceOf(boardId), [['Claude', 'listening']]);

    hangUp.abort();
    await within(2000, wait.ended, 'the wait after the agent hung up');
  });

  it('ends its waits when the server closes its connections, as it does when it stops', async () => {
    const { client } = await connect('claude-code', 'Claude');
    const { boardId } = await board('Stopping');
    const waiting = callText(client, 'wait_for_updates', { board_id: boardId, since: store.getBoard(boardId).seq }).catch(() => 'dropped');
    const wait = await nextWait(waits.length + 1);
    server.closeAllConnections();
    await within(2000, wait.ended, 'the wait after the server closed its connections');
    await client.close(); // its own end of the call gives up at once, not after its 60 seconds
    assert.equal(await waiting, 'dropped');
  });
});
