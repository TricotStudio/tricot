import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { placePin } from '../src/core/pins';
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

  it("adds a person's comments on a part to its thread while its pin finds the part, and starts one on a line an agent's change took the pinned words from", async () => {
    const idOf = (text: string) => text.match(/\[(?:page )?id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Retries' }));
    const pageId = idOf(await callText('add_page', { board_id: boardId, title: 'Retry loop' }));
    const code = idOf(await callText('add_block', { page_id: pageId, type: 'code', path: 'src/retry.ts', text: 'let attempt = 0;\nwhile (attempt < 3) attempt++;' }));
    const comment = (body: string, ask = false) => post(`/canvas/blocks/${code}/pins/comment`, { actor: 'Sam', part: { kind: 'line', file: 'src/retry.ts', line: 1 }, body, ask });

    // Said twice about line 1 as it reads: one thread.
    const asked = (await comment('Start at one?', true)).json.pin;
    const more = await comment('So three tries are three.');
    assert.deepEqual([more.status, more.json.pin.id, more.json.pin.discussion.thread.length], [201, asked.id, 2]);

    // The agent's change takes the words away, and the person resolves the thread.
    await callText('update_block', { block_id: code, rev: 1, text: 'let attempt = 1;\nwhile (attempt <= 3) attempt++;' });
    assert.equal((await post(`/canvas/pins/${asked.id}/resolve`, { actor: 'Sam', resolved: true })).status, 200);

    // A new comment on line 1 is about what it holds now: a pin of its own, the old thread kept as it was, resolved.
    const fresh = await comment('Is <= right here?', true);
    assert.equal(fresh.status, 201);
    assert.notEqual(fresh.json.pin.id, asked.id);
    assert.deepEqual([fresh.json.pin.quote, fresh.json.pin.discussion.thread.length], ['let attempt = 1;', 1]);
    const board = await (await fetch(`${base}/api/boards/${boardId}`)).json();
    const old = board.pages[0].canvas.pins.find((p: { id: string }) => p.id === asked.id);
    assert.deepEqual([old.quote, old.discussion.thread.length, old.discussion.resolved.by.name], ['let attempt = 0;', 2, 'Sam']);
    assert.equal((await comment('And the wait between?')).json.pin.id, fresh.json.pin.id, 'the new pin finds its line: said again, it joins');
  });

  it("pins a sequence diagram's participants and messages as a flowchart's nodes and arrows, which agents read in its words and which find their part again", async () => {
    const idOf = (text: string) => text.match(/\[(?:page )?id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Sign-in' }));
    const pageId = idOf(await callText('add_page', { board_id: boardId, title: 'Sign-in flow' }));
    const source = [
      'sequenceDiagram',
      '  autonumber',
      '  actor U as User',
      '  participant S as Server',
      '  U->>+S: Sign in',
      '  Note over U,S: Over TLS',
      '  alt known',
      '    S-->>-U: 200',
      '  else refused',
      '    S--xU: 403',
      '  end',
      '  loop every minute',
      '    U-)S: heartbeat',
      '  end',
      '  DB->>S: rows',
    ].join('\n');
    const diagram = idOf(await callText('add_block', { page_id: pageId, type: 'diagram', title: 'Sign in', source }));
    const ask = (part: Record<string, unknown>, body: string) => post(`/canvas/blocks/${diagram}/pins/comment`, { actor: 'Sam', part, body, ask: true });

    // A participant by its id, quoted by the name it is shown by; a message by its ends and which of theirs, quoted with what it says.
    const server = await ask({ kind: 'node', nodeId: 'S' }, 'Call it the API');
    const refused = await ask({ kind: 'arrow', from: 'S', to: 'U', n: 1 }, 'Say 401');
    assert.deepEqual([server.status, server.json.pin.quote, server.json.pin.anchor], [201, 'Server', { kind: 'node', nodeId: 'S', label: 'Server' }]);
    assert.deepEqual([refused.status, refused.json.pin.quote, refused.json.pin.anchor], [201, 'Server → User: 403', { kind: 'arrow', from: 'S', to: 'U', n: 1, label: '403' }]);
    assert.match(await callText('get_canvas', { page_id: pageId }), /pinned participant "Server" \(id S\)[^\n]*\n[^\n]*\n {2}pinned message "Server → User: 403" \(S ->> U, text "403", occurrence 2\)/);
    const missing = await ask({ kind: 'node', nodeId: 'Gateway' }, 'What is this?');
    assert.deepEqual([missing.status, missing.json.error], [400, 'diagram "Sign in" has no participant "Gateway". Its participants: U, S and DB.']);

    // The agent renames Server and rewords the refusal: each pin finds its part. With Server and its messages gone, they let go.
    const placed = async () => {
      const canvas = (await (await fetch(`${base}/api/boards/${boardId}`)).json()).pages[0].canvas;
      const block = canvas.blocks.find((b: { id: string }) => b.id === diagram);
      return [server.json.pin.id, refused.json.pin.id].map((id: string) => placePin(block, canvas.pins.find((p: { id: string }) => p.id === id)));
    };
    await callText('update_block', { block_id: diagram, rev: 1, source: source.replace('S as Server', 'S as API').replace(': 403', ': 401') });
    assert.deepEqual(await placed(), [
      { kind: 'node', nodeId: 'S' },
      { kind: 'arrow', arrowId: 'M_S_U_1' },
    ]);
    await callText('update_block', { block_id: diagram, rev: 2, source: 'sequenceDiagram\n  actor U as User\n  participant G as Gateway\n  U->>G: Sign in\n  G-->>U: 200' });
    assert.deepEqual(await placed(), [null, null]);
    assert.match(await callText('get_canvas', { page_id: pageId }), /pinned participant "Server" \(id S\) \(participant removed\)[^\n]*\n[^\n]*\n {2}pinned message "Server → User: 403" [^\n]* \(message removed\)/);
  });

  it("pins a class diagram's classes and relations as a flowchart's nodes and arrows, which agents read in its words and which find their part again", async () => {
    const idOf = (text: string) => text.match(/\[(?:page )?id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Shop' }));
    const pageId = idOf(await callText('add_page', { board_id: boardId, title: 'Shop model' }));
    const source = [
      'classDiagram',
      '  class Customer["Shopper"]',
      '  class Order {',
      '    +int total',
      '    +place()',
      '  }',
      '  Order : +cancel()',
      '  <<entity>> Order',
      '  Customer "1" --> "*" Order : places',
      '  Customer --> Order : returns',
      '  Order *-- LineItem',
      '  note for Order "One per checkout"',
      '  namespace Billing {',
      '    class Invoice~T~',
      '  }',
      '  Invoice <.. Order',
    ].join('\n');
    const diagram = idOf(await callText('add_block', { page_id: pageId, type: 'diagram', title: 'Shop', source }));
    const ask = (part: Record<string, unknown>, body: string) => post(`/canvas/blocks/${diagram}/pins/comment`, { actor: 'Sam', part, body, ask: true });

    // A class by its name in the source, quoted by the name it is shown by; a relation by its classes in the source's
    // order and which of theirs, quoted with its label. Members, annotations, notes and namespaces are none of them.
    const customer = await ask({ kind: 'node', nodeId: 'Customer' }, 'Call it Client');
    const returns = await ask({ kind: 'arrow', from: 'Customer', to: 'Order', n: 1 }, 'Make it a dependency');
    assert.deepEqual([customer.status, customer.json.pin.quote, customer.json.pin.anchor], [201, 'Shopper', { kind: 'node', nodeId: 'Customer', label: 'Shopper' }]);
    assert.deepEqual(
      [returns.status, returns.json.pin.quote, returns.json.pin.anchor],
      [201, 'Shopper → Order: returns', { kind: 'arrow', from: 'Customer', to: 'Order', n: 1, label: 'returns' }],
    );
    assert.match(await callText('get_canvas', { page_id: pageId }), /pinned class "Shopper" \(id Customer\)[^\n]*\n[^\n]*\n {2}pinned relation "Shopper → Order: returns" \(Customer -- Order, text "returns", occurrence 2\)/);
    const missing = await ask({ kind: 'node', nodeId: 'Billing' }, 'What is this?');
    assert.deepEqual([missing.status, missing.json.error], [400, 'diagram "Shop" has no class "Billing". Its classes: Customer, Order, LineItem and Invoice.']);

    // The agent renames Shopper and adds a relation before the one pinned: each pin finds its part, the relation by its
    // label. With Customer gone, they let go.
    const placed = async () => {
      const canvas = (await (await fetch(`${base}/api/boards/${boardId}`)).json()).pages[0].canvas;
      const block = canvas.blocks.find((b: { id: string }) => b.id === diagram);
      return [customer.json.pin.id, returns.json.pin.id].map((id: string) => placePin(block, canvas.pins.find((p: { id: string }) => p.id === id)));
    };
    await callText('update_block', { block_id: diagram, rev: 1, source: source.replace('Shopper', 'Buyer').replace('  Customer "1"', '  Customer --> Order : browses\n  Customer "1"') });
    assert.deepEqual(await placed(), [
      { kind: 'node', nodeId: 'Customer' },
      { kind: 'arrow', arrowId: 'id_Customer_Order_3' },
    ]);
    await callText('update_block', { block_id: diagram, rev: 2, source: 'classDiagram\n  class Order\n  Order *-- LineItem' });
    assert.deepEqual(await placed(), [null, null]);
    assert.match(await callText('get_canvas', { page_id: pageId }), /pinned class "Shopper" \(id Customer\) \(class removed\)[^\n]*\n[^\n]*\n {2}pinned relation "Shopper → Order: returns" [^\n]* \(relation removed\)/);
  });

  it("pins a state diagram's states and transitions, its start and end markers by the composite they are in, which agents read in its words and which find their part again", async () => {
    const idOf = (text: string) => text.match(/\[(?:page )?id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Sign-in states' }));
    const pageId = idOf(await callText('add_page', { board_id: boardId, title: 'Session' }));
    const source = [
      'stateDiagram-v2',
      '  [*] --> Idle',
      '  state "Waiting for input" as Waiting',
      '  Idle --> Waiting : start',
      '  Waiting --> Busy',
      '  Waiting --> Busy : again',
      '  note right of Waiting : a note',
      '  state Busy {',
      '    [*] --> Working',
      '    Working --> [*]',
      '  }',
      '  state check <<choice>>',
      '  Busy --> check',
      '  check --> [*] : failed',
    ].join('\n');
    const diagram = idOf(await callText('add_block', { page_id: pageId, type: 'diagram', title: 'Session', source }));
    const ask = (part: Record<string, unknown>, body: string) => post(`/canvas/blocks/${diagram}/pins/comment`, { actor: 'Sam', part, body, ask: true });

    // A state by its id, quoted by the name it is shown by; a transition by its ends and which of theirs, quoted with what it says;
    // a composite's [*] is a point of its own, named as Mermaid names it.
    const waiting = await ask({ kind: 'node', nodeId: 'Waiting' }, 'Call it Ready');
    const again = await ask({ kind: 'arrow', from: 'Waiting', to: 'Busy', n: 1 }, 'Say retry');
    const enter = await ask({ kind: 'arrow', from: 'Busy_start', to: 'Working' }, 'Start by checking');
    assert.deepEqual([waiting.status, waiting.json.pin.quote, waiting.json.pin.anchor], [201, 'Waiting for input', { kind: 'node', nodeId: 'Waiting', label: 'Waiting for input' }]);
    assert.deepEqual([again.status, again.json.pin.quote, again.json.pin.anchor], [201, 'Waiting for input → Busy: again', { kind: 'arrow', from: 'Waiting', to: 'Busy', n: 1, label: 'again' }]);
    assert.deepEqual([enter.status, enter.json.pin.quote], [201, 'start of Busy → Working']);
    assert.match(await callText('get_canvas', { page_id: pageId }), /pinned state "Waiting for input" \(id Waiting\)[^\n]*\n[^\n]*\n {2}pinned transition "Waiting for input → Busy: again" \(Waiting --> Busy, text "again", occurrence 2\)/);
    const missing = await ask({ kind: 'node', nodeId: 'Done' }, 'What is this?');
    assert.deepEqual([missing.status, missing.json.error], [400, 'diagram "Session" has no state "Done". Its states: Idle, Waiting, Busy, Working, check, root_start, Busy_start, Busy_end and root_end.']);

    // The agent renames Waiting, rewords the transition and adds one before them: each pin finds its part. With Waiting and Busy gone, they let go.
    const placed = async () => {
      const canvas = (await (await fetch(`${base}/api/boards/${boardId}`)).json()).pages[0].canvas;
      const block = canvas.blocks.find((b: { id: string }) => b.id === diagram);
      return [waiting, again, enter].map(({ json }) => placePin(block, canvas.pins.find((p: { id: string }) => p.id === json.pin.id)));
    };
    const edited = source.replace('Waiting for input', 'Ready').replace(': again', ': retry').replace('[*] --> Idle', '[*] --> Idle\n  Idle --> Idle : tick');
    await callText('update_block', { block_id: diagram, rev: 1, source: edited });
    assert.deepEqual(await placed(), [
      { kind: 'node', nodeId: 'Waiting' },
      { kind: 'arrow', arrowId: 'T_Waiting_Busy_1' },
      { kind: 'arrow', arrowId: 'T_Busy_start_Working_0' },
    ]);
    await callText('update_block', { block_id: diagram, rev: 2, source: 'stateDiagram\n  [*] --> Idle\n  Idle --> Done\n  Done --> [*]' });
    assert.deepEqual(await placed(), [null, null, null]);
    assert.match(await callText('get_canvas', { page_id: pageId }), /pinned state "Waiting for input" \(id Waiting\) \(state removed\)[^\n]*\n[^\n]*\n {2}pinned transition "Waiting for input → Busy: again" [^\n]* \(transition removed\)/);
  });

  it("pins an entity relationship diagram's entities and relationships as a flowchart's nodes and arrows, which agents read in its words and which find their part again", async () => {
    const idOf = (text: string) => text.match(/\[(?:page )?id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Shop' }));
    const pageId = idOf(await callText('add_page', { board_id: boardId, title: 'Schema' }));
    const source = [
      'erDiagram',
      '  CUSTOMER ||--o{ ORDER : places',
      '  CUSTOMER {',
      '    string name PK "shown on invoices {sic}"',
      '  }',
      '  p[Person] {',
      '    string email',
      '  }',
      '  CUSTOMER |o--|| p : "is a"',
      '  ORDER only one to zero or more INVOICE : billed',
      '  ORDER ||..o{ INVOICE : "credit note"',
      '  "Delivery Address" }o--|| CUSTOMER : ""',
    ].join('\n');
    const diagram = idOf(await callText('add_block', { page_id: pageId, type: 'diagram', title: 'Orders', source }));
    const ask = (part: Record<string, unknown>, body: string) => post(`/canvas/blocks/${diagram}/pins/comment`, { actor: 'Sam', part, body, ask: true });

    // An entity by its name, quoted by the alias it is shown by; a relationship by its ends and which of theirs, quoted with its label.
    const person = await ask({ kind: 'node', nodeId: 'p' }, 'Call it Member');
    const credit = await ask({ kind: 'arrow', from: 'ORDER', to: 'INVOICE', n: 1 }, 'Make it one to one');
    assert.deepEqual([person.status, person.json.pin.quote, person.json.pin.anchor], [201, 'Person', { kind: 'node', nodeId: 'p', label: 'Person' }]);
    assert.deepEqual([credit.status, credit.json.pin.quote, credit.json.pin.anchor], [201, 'ORDER → INVOICE: credit note', { kind: 'arrow', from: 'ORDER', to: 'INVOICE', n: 1, label: 'credit note' }]);
    assert.match(await callText('get_canvas', { page_id: pageId }), /pinned entity "Person" \(id p\)[^\n]*\n[^\n]*\n {2}pinned relationship "ORDER → INVOICE: credit note" \(ORDER -- INVOICE, text "credit note", occurrence 2\)/);
    const missing = await ask({ kind: 'node', nodeId: 'SHIPMENT' }, 'What is this?');
    assert.deepEqual([missing.status, missing.json.error], [400, 'diagram "Orders" has no entity "SHIPMENT". Its entities: CUSTOMER, ORDER, p, INVOICE and Delivery Address.']);

    // The agent renames p and puts another relationship before the credit note: each pin finds its part, by its text. With both gone, they let go.
    const placed = async () => {
      const canvas = (await (await fetch(`${base}/api/boards/${boardId}`)).json()).pages[0].canvas;
      const block = canvas.blocks.find((b: { id: string }) => b.id === diagram);
      return [person.json.pin.id, credit.json.pin.id].map((id: string) => placePin(block, canvas.pins.find((p: { id: string }) => p.id === id)));
    };
    const renamed = source.replace('p[Person]', 'person[Person]').replace('|| p :', '|| person :').replace('  ORDER ||..o{', '  ORDER ||--|| INVOICE : "paid by"\n  ORDER ||..o{');
    await callText('update_block', { block_id: diagram, rev: 1, source: renamed });
    assert.deepEqual(await placed(), [
      { kind: 'node', nodeId: 'person' },
      { kind: 'arrow', arrowId: 'R_ORDER_INVOICE_2' },
    ]);
    await callText('update_block', { block_id: diagram, rev: 2, source: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  INVOICE }o--|| ORDER : for' });
    assert.deepEqual(await placed(), [null, null]);
    assert.match(await callText('get_canvas', { page_id: pageId }), /pinned entity "Person" \(id p\) \(entity removed\)[^\n]*\n[^\n]*\n {2}pinned relationship "ORDER → INVOICE: credit note" [^\n]* \(relationship removed\)/);
  });

  it('pins the labelled pieces of a kind no reader reads exactly, a mindmap\'s or a Gantt chart\'s, by their words, which find them again while the words stay', async () => {
    const idOf = (text: string) => text.match(/\[(?:page )?id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Launch' }));
    const pageId = idOf(await callText('add_page', { board_id: boardId, title: 'Launch plan' }));
    const mindmap = ['mindmap', '  root((Launch plan))', '    Research', '      id1[Interview users]', '    Build', '      b2(Beta release)'].join('\n');
    const gantt = ['gantt', '  title Launch schedule', '  dateFormat YYYY-MM-DD', '  section Design', '  Write the brief :a1, 2024-01-01, 7d', '  section Build', '  Build the API :after a1, 10d'].join('\n');
    const map = idOf(await callText('add_block', { page_id: pageId, type: 'diagram', title: 'Plan', source: mindmap }));
    const chart = idOf(await callText('add_block', { page_id: pageId, type: 'diagram', title: 'Schedule', source: gantt }));
    const ask = (block: string, nodeId: string, body: string) => post(`/canvas/blocks/${block}/pins/comment`, { actor: 'Sam', part: { kind: 'node', nodeId }, body, ask: true });

    // A piece by its text: a mindmap's node, a Gantt chart's task, kept as a node whose id is its words.
    const beta = await ask(map, 'Beta release', 'Call it Preview');
    const brief = await ask(chart, 'Write the brief', 'Two weeks, not one');
    assert.deepEqual([beta.status, beta.json.pin.quote, beta.json.pin.anchor], [201, 'Beta release', { kind: 'node', nodeId: 'Beta release', label: 'Beta release' }]);
    assert.deepEqual([brief.status, brief.json.pin.quote, brief.json.pin.anchor], [201, 'Write the brief', { kind: 'node', nodeId: 'Write the brief', label: 'Write the brief' }]);
    // Agents read a piece by its words alone: it has no id of its own in the source.
    assert.match(await callText('get_canvas', { page_id: pageId }), /\n {2}pinned piece "Beta release" → request to change the diagram,[^\n]*\n[^\n]*\n[\s\S]*\n {2}pinned piece "Write the brief" → /);
    const missing = await ask(map, 'Launch party', 'What is this?');
    assert.deepEqual([missing.status, missing.json.error], [400, 'diagram "Plan" has no piece "Launch party". Its pieces: Launch plan, Research, Interview users, Build and Beta release.']);

    // The agent moves and reshapes Beta release and moves the brief's dates: each pin finds its piece by its words. Reworded, they let go.
    const placed = async () => {
      const canvas = (await (await fetch(`${base}/api/boards/${boardId}`)).json()).pages[0].canvas;
      const pinned = (block: string, id: string) => placePin(canvas.blocks.find((b: { id: string }) => b.id === block), canvas.pins.find((p: { id: string }) => p.id === id));
      return [pinned(map, beta.json.pin.id), pinned(chart, brief.json.pin.id)];
    };
    await callText('update_block', { block_id: map, rev: 1, source: mindmap.replace('    Build\n      b2(Beta release)', '      b9[Beta release]\n    Build') });
    await callText('update_block', { block_id: chart, rev: 1, source: gantt.replace('section Design', 'section Plan').replace('2024-01-01, 7d', '2024-01-08, 14d') });
    assert.deepEqual(await placed(), [
      { kind: 'node', nodeId: 'Beta release' },
      { kind: 'node', nodeId: 'Write the brief' },
    ]);
    await callText('update_block', { block_id: map, rev: 2, source: mindmap.replace('Beta release', 'Preview') });
    await callText('update_block', { block_id: chart, rev: 2, source: gantt.replace('Write the brief', 'Draft the brief') });
    assert.deepEqual(await placed(), [null, null]);
    assert.match(await callText('get_canvas', { page_id: pageId }), /pinned piece "Beta release" \(piece removed\)[\s\S]*pinned piece "Write the brief" \(piece removed\)/);
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
