import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';
import { eventsOf } from './tables';
import { removeScratch, WINDOWS } from './platform';

type ToolResult = { content: { type: string; text: string; data?: string; mimeType?: string }[]; isError?: boolean };

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// The person's browser, let in as one of their seats (seatHelper.ts): it signs what needs one.
let seat: TestSeat;

// The core's tools and routes over MCP and REST, on the board context, Sketchbook pages, threads, requests and syncs. What a part adds
// (decisions, tasks, the pin tool, the instructions and the tool list a server with it gives) is in its counterpart of this file.
describe('MCP + REST end to end', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let client: Client;
  let store: Store;

  async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  }

  async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await call(name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content[0].text;
  }

  async function post(route: string, body: Record<string, unknown>) {
    const response = await fetch(`${base}/api${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign('POST', `/api${route}`, JSON.stringify(body)) },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  }

  before(async () => {
    // A dot-folder, like the default ~/.tricot.
    dir = mkdtempSync(path.join(os.tmpdir(), '.tricot-e2e-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    seat = letIn(app);
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Planner`)));
  });

  after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  it('accepts only real images over REST and serves them inertly', async () => {
    const upload = (body: Buffer, type: string) =>
      fetch(`${base}/api/assets`, { method: 'POST', headers: { 'Content-Type': type, Origin: base }, body: new Uint8Array(body) });
    const bad = await upload(Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml');
    assert.equal(bad.status, 400);

    const good = await upload(Buffer.from(PNG_BASE64, 'base64'), 'image/png');
    assert.equal(good.status, 201);
    const { assetId, width, height } = await good.json();
    assert.deepEqual([width, height], [1, 1], 'with its size, for a new block to start at');
    const served = await fetch(`${base}/api/assets/${assetId}`);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.match(served.headers.get('cache-control') ?? '', /immutable/);

    // A file that exists but can't be sent must not be cached as if it were
    // the image (browsers would keep showing the error for a year).
    if (!WINDOWS) {
      chmodSync(path.join(dir, 'assets', assetId), 0o000);
      const failed = await fetch(`${base}/api/assets/${assetId}`);
      assert.notEqual(failed.status, 200);
      assert.doesNotMatch(failed.headers.get('cache-control') ?? '', /immutable/);
    }
  });

  it('nudges, without refusing, thread messages that people will read as a log', async () => {
    const idOf = (text: string) => text.match(/\[(?:thread )?id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Tone' }));

    const started = await callText('start_thread', { board_id: boardId, body: 'Built: a first draft of the wording.' });
    assert.match(started, /This message opens with a label/);
    const threadId = idOf(started);
    assert.match(await callText('reply_in_thread', { thread_id: threadId, body: 'Great question! 20/20 tests pass.' }), /This reply opens with praise[\s\S]*This reply quotes a test tally/);
    assert.doesNotMatch(await callText('reply_in_thread', { thread_id: threadId, body: 'Sam, the draft is ready for you.' }), /Advice/);
  });

  it('archives a board: agents read it but cannot change it, and list_boards sets it apart', async () => {
    const idOf = (text: string) => text.match(/\[(?:thread )?id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Old experiment', goal: 'Done with it' }));
    const archived = await post(`/boards/${boardId}/archive`, { actor: 'Sam' });
    assert.equal(archived.status, 200);
    assert.equal(archived.json.archived.by.name, 'Sam');

    assert.match(await callText('get_board', { board_id: boardId }), /Archived by Sam \(human\) at \S+: read-only\./);
    const refused = await call('start_thread', { board_id: boardId, body: 'One more?' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /The board "Old experiment" was archived by Sam, so it is read-only/);
    assert.match(await callText('list_boards'), /\n\nArchived \(read-only\):\n- Old experiment \[id: [^\]]+\] — Done with it/);

    const human = await post(`/boards/${boardId}/threads`, { actor: 'Sam', body: 'One more?' });
    assert.equal(human.status, 400);
    assert.match(human.json.error, /read-only/);
    const listed = await (await fetch(`${base}/api/boards`)).json();
    assert.equal(listed.find((b: { id: string }) => b.id === boardId).archived, true);

    assert.equal((await post(`/boards/${boardId}/unarchive`, { actor: 'Sam' })).status, 200);
    assert.match(await callText('start_thread', { board_id: boardId, body: 'One more?' }), /^Started/);
    const events = (await (await fetch(`${base}/api/boards/${boardId}/events?since=0&limit=500`)).json()).events.map((e: { summary: string }) => e.summary);
    assert.deepEqual(events.slice(1, 3), ['archived the board', 'unarchived the board']);
  });

  it('replaces an image in place, and points agents at their earlier version of a block', async () => {
    const idOf = (text: string) => text.match(/\[(?:page )?id: ([^\]]+)\]/)![1];
    const add = (await client.listTools()).tools.find((t) => t.name === 'add_block')!;
    assert.match(add.description ?? '', /A new version of something already on a canvas .* goes in that block: update_block on it, images included/);
    const boardId = idOf(await callText('create_board', { title: 'Mocks' }));
    const pageId = idOf(await callText('add_page', { board_id: boardId, title: 'Connect screen' }));
    const added = await callText('add_block', { page_id: pageId, type: 'image', title: 'Connect screen (mock)', image_base64: PNG_BASE64 });
    assert.doesNotMatch(added, /Advice/);
    const shot = idOf(added);

    const v2 = Buffer.concat([Buffer.from(PNG_BASE64, 'base64'), Buffer.from('v2')]).toString('base64');
    assert.equal(
      await callText('update_block', { block_id: shot, rev: 1, image_base64: v2 }),
      `Updated image "Connect screen (mock)" [id: ${shot}] (now rev 2).`,
    );
    const read = await call('get_block', { block_id: shot });
    assert.match(read.content[0].text, / · rev 2\n/);
    assert.equal(read.content.find((c) => c.type === 'image')?.data, v2);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /^updated image "Connect screen \(mock\)" on Sketchbook page "Connect screen": replaced the image$/);

    // Boxes on it stay put; the agent is asked to check them.
    await post(`/canvas/blocks/${shot}/pins/comment`, { actor: 'Sam', part: { kind: 'box', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, body: 'Bigger button' });
    await post(`/canvas/blocks/${shot}/pins/comment`, { actor: 'Sam', part: { kind: 'box', x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, body: 'Copy?' });
    assert.equal(
      await callText('update_block', { block_id: shot, rev: 2, image_base64: PNG_BASE64 }),
      `Updated image "Connect screen (mock)" [id: ${shot}] (now rev 3). 2 boxes are pinned on this image: check they still point at the right parts.`,
    );

    const refusals: [Record<string, unknown>, RegExp][] = [
      [{ block_id: shot, rev: 3, image_path: '/x.png' }, /image_path or image_base64 \(exactly one\)/],
      [{ block_id: shot, rev: 3, image_base64: Buffer.from('not an image').toString('base64') }, /Only PNG, JPEG, GIF and WebP/],
      [{ block_id: idOf(await callText('add_block', { page_id: pageId, type: 'note', text: 'Notes' })), rev: 1 }, /A note block has no image/],
      [{ block_id: shot, rev: 1 }, /changed since rev 1: it is now rev 3/],
    ];
    for (const [args, refusal] of refusals) {
      const result = await call('update_block', { image_base64: PNG_BASE64, ...args });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(result.content[0].text, refusal);
    }

    // A near-duplicate of its own block gets a nudge; other blocks don't.
    const again = await callText('add_block', { page_id: pageId, type: 'image', title: 'Connect screen v2', image_base64: PNG_BASE64 });
    assert.match(
      again,
      new RegExp(`\\n\\nAdvice \\(nothing was rejected\\):\\n- You already have image "Connect screen \\(mock\\)" \\[id: ${shot}\\] here\\. If this is a new version of it, update that block instead and remove this one with remove_item\\.$`),
    );
    const assetId = (await (await fetch(`${base}/api/assets`, { method: 'POST', headers: { 'Content-Type': 'image/png', Origin: base }, body: new Uint8Array(Buffer.from(PNG_BASE64, 'base64')) })).json()).assetId;
    await post('/canvas/blocks', { actor: 'Sam', pageId, title: 'Settings screen', content: { type: 'image', assetId } });
    const quiet = [
      await callText('add_block', { page_id: pageId, type: 'image', title: 'Settings screen (mock)', image_base64: PNG_BASE64 }), // a person's
      await callText('add_block', { page_id: pageId, type: 'table', title: 'Connect screen', columns: ['field'] }), // another type
      await callText('add_block', { page_id: pageId, type: 'image', image_base64: PNG_BASE64 }), // untitled
    ];
    for (const result of quiet) assert.doesNotMatch(result, /You already have/);
  });

  it("keeps a shape's line and bold and an arrow's weight as an agent and a person set them, and tells agents of them", async () => {
    const idOf = (text: string) => text.match(/\[(?:page )?id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Sketches' }));
    const pageId = idOf(await callText('add_page', { board_id: boardId, title: 'Sign in' }));
    const box = idOf(await callText('add_block', { page_id: pageId, type: 'shape', shape: 'rectangle', text: 'Sign in', color: 'blue', line: 'thick', bold: true }));
    const label = idOf(await callText('add_block', { page_id: pageId, type: 'shape', shape: 'text', text: 'Step one', line: 'thick', bold: true }));
    let canvas = await callText('get_canvas', { page_id: pageId });
    assert.match(canvas, /\(blue, thick line, bold\)/);
    assert.match(canvas, /\(gray, medium, bold\)/, 'a label has no outline: its line is not kept');

    await callText('update_block', { block_id: box, rev: 1, line: 'thin', bold: false });
    canvas = await callText('get_canvas', { page_id: pageId });
    assert.match(canvas, /\(blue\)/);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /gave it a thin line; made its words plain$/);
    const refused = await call('update_block', { block_id: label, rev: 1, line: 'heavy' });
    assert.equal(refused.isError, true);

    // A person draws them from the page with the tools' options.
    const drawn = await post('/canvas/blocks', { actor: 'Sam', pageId, content: { type: 'shape', shape: 'ellipse', color: 'green', line: 'medium' } });
    assert.equal(drawn.status, 201, JSON.stringify(drawn.json));
    assert.match(await callText('get_canvas', { page_id: pageId }), /\(green, medium line\)/);
    const wrong = await post('/canvas/blocks', { actor: 'Sam', pageId, content: { type: 'shape', shape: 'ellipse', line: 'heavy' } });
    assert.equal(wrong.status, 400);

    // And an arrow between them, with its line's weight.
    const arrow = await post('/canvas/links', { actor: 'Sam', from: box, to: label, weight: 'thick' });
    assert.equal(arrow.status, 201, JSON.stringify(arrow.json));
    assert.equal(arrow.json.weight, 'thick');
    assert.match(await callText('get_canvas', { page_id: pageId }), / → .* \(thick line\) \[id: /);
    assert.equal((await post('/canvas/links', { actor: 'Sam', from: label, to: box, weight: 'heavy' })).status, 400);
    const plain = await post('/canvas/links', { actor: 'Sam', from: label, to: box, weight: 'thin' });
    assert.equal(plain.json.weight, undefined, 'thin is no weight: it is kept as none');

    // A free arrow, drawn anywhere else: a shape with its ends, told to agents by which way it points.
    const free = await post('/canvas/blocks', { actor: 'Sam', pageId, w: 200, h: 120, content: { type: 'shape', shape: 'arrow', line: 'medium', ends: [0.1, 0.1, 0.9, 0.9] } });
    assert.equal(free.status, 201, JSON.stringify(free.json));
    assert.deepEqual(free.json.ends, [0.1, 0.1, 0.9, 0.9]);
    assert.match(await callText('get_canvas', { page_id: pageId }), /arrow \(gray, pointing down-right, medium line\)/);
    const level = await post('/canvas/blocks', { actor: 'Sam', pageId, content: { type: 'shape', shape: 'arrow', ends: [0, 0.5, 1, 0.5] } });
    assert.equal(level.json.ends, undefined, 'left to right across its middle is no ends: kept as none');
    assert.equal((await post('/canvas/blocks', { actor: 'Sam', pageId, content: { type: 'shape', shape: 'arrow', ends: [0, 0, 1.5, 1] } })).status, 400);
    assert.equal((await post('/canvas/blocks', { actor: 'Sam', pageId, content: { type: 'shape', shape: 'arrow', ends: [0.5, 0.5, 0.5, 0.5] } })).status, 400);
    const drawn2 = idOf(await callText('add_block', { page_id: pageId, type: 'shape', shape: 'arrow', text: 'then', ends: [1, 0.5, 0, 0.5] }));
    assert.match(await callText('get_canvas', { page_id: pageId }), /arrow "then" \(gray, pointing left\)/);
    await callText('update_block', { block_id: drawn2, rev: 1, ends: [0.5, 1, 0.5, 0] });
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /pointed it up$/);
    const boxed = await post('/canvas/blocks', { actor: 'Sam', pageId, content: { type: 'shape', shape: 'rectangle', ends: [0.1, 0.1, 0.9, 0.9] } });
    assert.equal(boxed.json.ends, undefined, 'only an arrow keeps its ends');
  });

  it('ends an idle wait with a hint to call again', async () => {
    const boardId = (await callText('create_board', { title: 'Idle' })).match(/\[id: ([^\]]+)\]/)![1];
    const result = await callText('wait_for_updates', { board_id: boardId, since: 1, timeout_seconds: 1 });
    assert.equal(result, 'No new activity. Cursor: 1\nNothing yet after 1s; call again to keep waiting.');
  });

  it('reports bad input as tool errors, not crashes', async () => {
    const result = await call('get_thread', { thread_id: 'missing' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No thread with id "missing"/);

    const rest = await post('/threads/missing/messages', { actor: 'Sam', body: 'Hello' });
    assert.equal(rest.status, 404);
    const invalid = await post('/boards', { actor: '', title: 'x' });
    assert.equal(invalid.status, 400);
  });

  it('rejects requests with a foreign Host header', async () => {
    // fetch() won't let us override Host, so use a raw request.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/api/boards`, { headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});
