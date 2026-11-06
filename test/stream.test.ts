import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BoardChange } from '../src/core/changes';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import type { Actor } from '../src/core/types';
import { removeScratch } from './platform';

const sam: Actor = { kind: 'human', name: 'Sam' };

interface Frame {
  event: string;
  id?: string;
  data: unknown;
  bytes: number;
}

// A board's stream, read frame by frame.
class Stream {
  readonly frames: Frame[] = [];
  private waiting: (() => void)[] = [];
  private readonly abort = new AbortController();

  static async open(url: string, headers: Record<string, string> = {}): Promise<Stream> {
    const stream = new Stream();
    const response = await fetch(url, { headers, signal: stream.abort.signal });
    assert.equal(response.status, 200);
    void stream.read(response.body!.getReader());
    return stream;
  }

  private async read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let pending = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        pending += decoder.decode(value, { stream: true });
        for (let end = pending.indexOf('\n\n'); end >= 0; end = pending.indexOf('\n\n')) {
          const text = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const fields = Object.fromEntries(text.split('\n').flatMap((line) => (line.includes(': ') ? [[line.slice(0, line.indexOf(': ')), line.slice(line.indexOf(': ') + 2)]] : [])));
          if (fields.event) this.frames.push({ event: fields.event, id: fields.id, data: JSON.parse(fields.data), bytes: text.length + 2 });
          for (const wake of this.waiting.splice(0)) wake();
        }
      }
    } catch {
      // closed
    }
  }

  // The frames of a kind, after the first `skip` of any kind.
  of(event: string): Frame[] {
    return this.frames.filter((f) => f.event === event);
  }

  async until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > deadline) assert.fail(`never saw ${what}; got ${this.frames.map((f) => f.event).join(', ')}`);
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  }

  close(): void {
    this.abort.abort();
  }
}

describe('A board stream', () => {
  let dir: string;
  let store: Store;
  let server: Server;
  let base: string;
  let boardId: string;
  let client: Client;
  const open: Stream[] = [];

  const stream = async (query = '', headers: Record<string, string> = {}) => {
    const s = await Stream.open(`${base}/api/boards/${boardId}/stream${query}`, headers);
    open.push(s);
    return s;
  };
  const get = async (route: string) => (await fetch(`${base}/api${route}`)).json();
  const post = async (route: string, body: Record<string, unknown>) =>
    (await fetch(`${base}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) })).json();

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-stream-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
    boardId = store.createBoard({ title: 'Live' }, sam).id;
    store.postDecision(boardId, { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }, sam);
  });

  after(async () => {
    for (const s of open) s.close();
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  it('says where the board is, who is on it, and then sends each change with the entity it touched', async () => {
    const live = await stream();
    await live.until(() => live.of('presence').length > 0, 'presence');
    assert.deepEqual(live.frames.map((f) => f.event).slice(0, 2), ['hello', 'presence']);
    const board = await get(`/boards/${boardId}`);
    assert.deepEqual(live.of('hello')[0].data, { ver: board.ver, seq: board.seq });
    assert.equal(typeof board.ver, 'number');

    const decisionId = board.decisions[0].id;
    await post(`/decisions/${decisionId}/comments`, { actor: 'Alex', body: 'Hello there' });
    await live.until(() => live.of('change').length > 0, 'a change');
    const frame = live.of('change')[0];
    const change = frame.data as BoardChange;
    assert.equal(frame.id, String(change.ver), 'numbered, so a page that reconnects says where it was');
    assert.equal(change.ver, board.ver + 1);
    assert.equal(change.events?.[0].summary.includes('commented'), true);
    assert.deepEqual(change.patch?.map((p) => [p.kind, p.id]), [['decision', decisionId]]);
    assert.ok(frame.bytes < 1500, `a comment is ${frame.bytes} bytes`);
  });

  it('sends an agent opening a board or a card as presence alone: no change, and nothing to fetch', async () => {
    const live = await stream();
    await live.until(() => live.of('presence').length > 0, 'presence');
    const changes = live.of('change').length;
    const seen = live.of('presence').length;

    await client.callTool({ name: 'get_board', arguments: { board_id: boardId } });
    await live.until(() => live.of('presence').length > seen, 'the agent on the board');
    const [agent] = live.of('presence').at(-1)!.data as { name: string; state: string }[];
    assert.deepEqual([agent.name, agent.state], ['Claude', 'working']);
    const decisionId = store.getBoard(boardId).decisions[0].id;
    await client.callTool({ name: 'get_decision', arguments: { decision_id: decisionId } });
    await live.until(() => (live.of('presence').at(-1)!.data as { focus?: unknown }[])[0].focus !== undefined, 'the agent on the card');
    const focused = live.of('presence').at(-1)!;
    assert.ok(focused.bytes < 200, `presence is ${focused.bytes} bytes`);
    assert.equal(focused.id, undefined, 'presence is not a numbered change');
    assert.equal(live.of('change').length, changes, 'reading is not changing: no change message');
  });

  it('sends what a page missed when it reconnects with the last change it had, and says reset when that is gone', async () => {
    const before = (await get(`/boards/${boardId}`)).ver;
    const decisionId = store.getBoard(boardId).decisions[0].id;
    await post(`/decisions/${decisionId}/comments`, { actor: 'Alex', body: 'While away 1' });
    await post(`/decisions/${decisionId}/comments`, { actor: 'Alex', body: 'While away 2' });

    const back = await stream(`?since=${before}`);
    await back.until(() => back.of('change').length >= 2, 'the missed changes');
    assert.deepEqual(back.of('change').map((f) => f.id), [String(before + 1), String(before + 2)]);
    assert.equal(back.of('reset').length, 0);

    const header = await stream('?since=1', { 'Last-Event-ID': String(before + 1) });
    await header.until(() => header.of('change').length >= 1, 'the change after the one in Last-Event-ID');
    assert.deepEqual(header.of('change').map((f) => f.id), [String(before + 2)], 'Last-Event-ID, which the browser sends itself, wins');

    const lost = await stream('?since=5');
    await lost.until(() => lost.of('reset').length > 0, 'a reset');
    assert.equal(lost.of('change').length, 0);

    const current = await stream(`?since=${store.changeVersion(boardId)}`);
    await current.until(() => current.of('presence').length > 0, 'presence');
    assert.equal(current.of('change').length, 0, 'nothing missed');
  });

  it('tells a page where the board is, for it to check itself against', async () => {
    const state = await get(`/boards/${boardId}/live`);
    const board = await get(`/boards/${boardId}`);
    assert.equal(state.ver, board.ver);
    assert.equal(state.seq, board.seq);
    assert.equal(state.tally.decisions, 1);
    assert.equal(state.tally.blocks, 0);
  });

  it('keeps hearing of a board after it is renamed, and an old id still opens the stream', async () => {
    const old = boardId;
    const live = await stream();
    await post(`/boards/${old}`, { actor: 'Sam', title: 'Live and renamed' });
    await live.until(() => live.of('change').some((f) => (f.data as BoardChange).head?.title === 'Live and renamed'), 'the rename');
    const renamed = live.of('change').find((f) => (f.data as BoardChange).head?.title)!.data as BoardChange;
    assert.equal(renamed.head?.id, store.getBoard(old).id);
    const again = await Stream.open(`${base}/api/boards/${old}/stream`);
    open.push(again);
    await again.until(() => again.of('hello').length > 0, 'hello by the old id');
  });
});
