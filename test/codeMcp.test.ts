import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { eventsOf } from './tables';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

// A file of `n` numbered lines, each different, so pins find them by their text.
const file = (n: number) => Array.from({ length: n }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n';

describe('Code blocks over MCP and REST', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let client: Client;
  let store: Store;

  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await call(name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content[0].text;
  }
  async function request(method: string, route: string, body?: Record<string, unknown>) {
    const response = await fetch(`${base}/api${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  }
  const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-code-mcp-'));
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

  it('tells agents about code blocks', async () => {
    const { tools } = await client.listTools();
    const add = tools.find((t) => t.name === 'add_block')!;
    assert.match(
      add.description ?? '',
      /When people are debugging or ask to see a file, add it as a code block \(type code, with its path and text\), the lines that matter highlighted\. People comment on the lines of diffs and code: get_canvas lists what they said under the block; answer each with comment\(pin_id\)\./,
    );
    assert.match(add.description ?? '', /code → path and text \(a source file as it is, or the lines that matter with start/);
    for (const field of ['path', 'highlight', 'start', 'total', 'commit', 'language']) {
      assert.ok((add.inputSchema.properties as Record<string, unknown>)[field], field);
      assert.ok((tools.find((t) => t.name === 'update_block')!.inputSchema.properties as Record<string, unknown>)[field], field);
    }
  });

  it('adds and updates code, shows it compactly to agents and in full on get_block, and keeps each version', async () => {
    const boardId = idOf(await callText('create_board', { title: 'Sign-in bug' }));

    const added = await callText('add_block', {
      board_id: boardId,
      type: 'code',
      path: 'src/server/connectors/oauth.ts',
      text: file(268),
      highlight: [[123, 130]],
      commit: '0be1135',
    });
    assert.equal(added.split('\n')[0], `Added code "src/server/connectors/oauth.ts" [id: ${idOf(added)}] (rev 1).`);
    const blockId = idOf(added);

    const canvas = await callText('get_canvas', { board_id: boardId });
    assert.match(
      canvas,
      /- code "src\/server\/connectors\/oauth\.ts" \[id: \w+\] · rev 1 · by Claude \(agent\)\n  src\/server\/connectors\/oauth\.ts · TypeScript · 268 lines · at 0be1135\n  Highlighted: lines 123–130\.\n  \(get_block for the text\)/,
    );
    assert.doesNotMatch(canvas, /line200/);
    const full = await callText('get_block', { block_id: blockId });
    assert.match(full, /Text:\n```ts\nconst line1 = 1;\n[\s\S]*const line268 = 268;\n```/);

    // People get the text with the board, to draw it.
    const board = (await request('GET', `/boards/${boardId}`)).json;
    assert.equal(board.canvas.blocks[0].text, file(268));
    assert.deepEqual(board.canvas.blocks[0].highlight, [[123, 130]]);

    // New text and a new highlight replace them; the earlier text is kept as a version and can come back.
    const changed = file(268).replace('const line125 = 125;', 'const line125 = 126; // fixed');
    assert.match(
      await callText('update_block', { block_id: blockId, rev: 1, text: changed, highlight: '125', commit: 'a5cdc0c' }),
      /^Updated code "src\/server\/connectors\/oauth\.ts" \[id: \w+\] \(now rev 2\)\.$/,
    );
    const versions = await callText('get_block', { block_id: blockId });
    assert.match(versions, /\/\/ fixed/);
    assert.match(versions, /- v2 \(current\) · [^\n]+ · Claude \(agent\) · replaced the text: now 268 lines; highlighted lines 125; now at a5cdc0c\n- v1 · [^\n]+ · Claude \(agent\) · made it/);
    const kept = await request('GET', `/canvas/blocks/${blockId}/versions/1`);
    assert.equal(kept.json.text, file(268));
    assert.deepEqual(kept.json.highlight, [[123, 130]]);
    assert.equal(kept.json.commit, '0be1135');
    assert.match(await callText('update_block', { block_id: blockId, rev: 2, restore_rev: 1 }), /^Restored v1 of code "src\/server\/connectors\/oauth\.ts"/);
    const restored = store.blockOf(blockId);
    assert.ok(restored.type === 'code' && restored.text === file(268) && restored.commit === '0be1135');
    assert.deepEqual(restored.type === 'code' && restored.highlight, [[123, 130]]);

    // Its title is its path: renaming it renames the file.
    await callText('update_block', { block_id: blockId, rev: 3, title: 'src/server/connectors/tokens.ts' });
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /changed the path to src\/server\/connectors\/tokens\.ts/);
  });

  it('refuses binary, oversize and misnumbered code, saying why', async () => {
    const boardId = idOf(await callText('create_board', { title: 'Refusals' }));
    const add = (args: Record<string, unknown>) => call('add_block', { board_id: boardId, type: 'code', path: 'a.ts', ...args });
    assert.match((await add({ text: 'PNG\u0000\u0001\u0002' })).content[0].text, /The text looks like a binary file, not text/);
    assert.match((await add({ text: 'x'.repeat(1024 * 1024 + 10) })).content[0].text, /The text is 1\.0 MB; a code block holds at most 1 MB\. Send the lines that matter, with start/);
    assert.match((await add({ text: file(12), start: 120, highlight: '10-12' })).content[0].text, /highlight 10–12 is outside the lines of text, which are numbered 120–131/);
    assert.match((await call('add_block', { board_id: boardId, type: 'code', text: 'x' })).content[0].text, /A code block needs path/);
    assert.match((await add({})).content[0].text, /A code block needs text/);
    // A title alone names it; a title as well as a path is left out, and said.
    const titled = await callText('add_block', { board_id: boardId, type: 'code', title: 'notes.md', text: '# Notes' });
    assert.match(titled, /^Added code "notes\.md"/);
    const both = await callText('add_block', { board_id: boardId, type: 'code', title: 'The bug', path: 'b.ts', text: 'b();' });
    assert.match(both, /A code block is named by its path \("b\.ts"\), so title was left out\./);
    // A long file with nothing highlighted opens on its first lines: the agent hears so.
    const long = await callText('add_block', { board_id: boardId, type: 'code', path: 'c.ts', text: file(100) });
    assert.match(long, /People see its first 40 of 100 lines until they unfold it\. Highlight the lines that matter/);
    // Other blocks have no code fields.
    const note = idOf(await callText('add_block', { board_id: boardId, type: 'note', text: 'Hi' }));
    assert.match((await call('update_block', { block_id: note, rev: 1, highlight: '1' })).content[0].text, /A note block has no highlight\./);
  });

  it('pins lines of an excerpt: found again by their text after an update, or no longer there', async () => {
    const boardId = idOf(await callText('create_board', { title: 'Lines' }));
    const taskId = idOf(await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Fix the temp file name' }] }));
    const blockId = idOf(
      await callText('add_block', { board_id: boardId, type: 'code', path: 'src/server/connectors/oauth.ts', text: file(12), start: 120, total: 268, highlight: '123-130' }),
    );

    // A person clicks line 126 and asks; on the board context it starts a thread on the line.
    const part = { kind: 'line', file: 'src/server/connectors/oauth.ts', line: 126, side: 'new' };
    const commented = await request('POST', `/canvas/blocks/${blockId}/pins/comment`, { actor: 'Wassim', part, body: 'Why random bytes rather than the process id?' });
    assert.equal(commented.status, 201);
    assert.equal(commented.json.pin.quote, 'const line7 = 7;');
    assert.deepEqual(commented.json.pin.anchor, { kind: 'line', file: 'src/server/connectors/oauth.ts', line: 126, side: 'new' });
    const pinId = commented.json.pin.id;
    await callText('comment', { pin_id: pinId, body: "Two sign-ins in one process would share a pid; random names can't collide." });

    // Agents pin by number, without the file, or by words on the line.
    assert.match(await callText('pin', { block_id: blockId, task_id: taskId, line: 129 }), /^Pinned line 129 of src\/server\/connectors\/oauth\.ts in code "src\/server\/connectors\/oauth\.ts" to T1/);
    assert.match(await callText('pin', { block_id: blockId, task_id: taskId, text: 'line11 = 11' }), /^Pinned line 130 of src\/server\/connectors\/oauth\.ts/);
    assert.match((await call('pin', { block_id: blockId, task_id: taskId, line: 10 })).content[0].text, /has no line 10: it holds lines 120–131 of 268, numbered as in the file/);
    assert.match((await call('pin', { block_id: blockId, task_id: taskId, file: 'store.ts', line: 125 })).content[0].text, /shows src\/server\/connectors\/oauth\.ts, not store\.ts/);
    assert.match((await call('pin', { block_id: blockId, task_id: taskId, text: 'nowhere' })).content[0].text, /"nowhere" isn't in code/);

    let canvas = await callText('get_canvas', { board_id: boardId });
    assert.match(canvas, /src\/server\/connectors\/oauth\.ts · TypeScript · lines 120–131 of 268\n  Highlighted: lines 123–130\./);
    assert.match(
      canvas,
      /\n  pinned line 126 of src\/server\/connectors\/oauth\.ts \("const line7 = 7;"\) → comment thread, open \[pin id: \w+\]; reply with comment\(pin_id\)\n    - Wassim \(human\) at [^\n]+: Why random bytes rather than the process id\?\n    - Claude \(agent\) at [^\n]+: Two sign-ins in one process/,
    );
    assert.match(canvas, /\n  pinned line 129 of src\/server\/connectors\/oauth\.ts \("const line10 = 10;"\) → T1 \(to do\)/);

    // Two lines inserted above: the pins follow their lines. Line 130's text is gone: its pin says so.
    const lines = file(12).split('\n');
    const next = ['// one', '// two', ...lines.slice(0, 10), '', ...lines.slice(11)].join('\n');
    await callText('update_block', { block_id: blockId, rev: 1, text: next });
    canvas = await callText('get_canvas', { board_id: boardId });
    assert.match(canvas, /pinned line 128 of src\/server\/connectors\/oauth\.ts \("const line7 = 7;"\) → comment thread, open/);
    assert.match(canvas, /pinned line 131 of src\/server\/connectors\/oauth\.ts \("const line10 = 10;"\) → T1/);
    assert.match(canvas, /pinned line 130 of src\/server\/connectors\/oauth\.ts \("const line11 = 11;"\) \(no longer there\) → T1/);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /replaced the text: now lines 120–133 of 268; line 130 of src\/server\/connectors\/oauth\.ts, pinned to T1, is no longer there/);

    // The text comes back in a later version: so does the line.
    await callText('update_block', { block_id: blockId, rev: 2, text: file(12) });
    canvas = await callText('get_canvas', { board_id: boardId });
    assert.match(canvas, /pinned line 130 of src\/server\/connectors\/oauth\.ts \("const line11 = 11;"\) → T1/);
    assert.match(canvas, /pinned line 126 of src\/server\/connectors\/oauth\.ts \("const line7 = 7;"\) → comment thread/);
  });

  it('lets people add code over REST, name it by its path, and refuses what it can’t hold', async () => {
    const boardId = idOf(await callText('create_board', { title: 'Dropped files' }));
    const add = (content: Record<string, unknown>) =>
      request('POST', '/canvas/blocks', { actor: 'Wassim', boardId, x: 400, y: 120, w: 500, h: 300, content: { type: 'code', ...content } });

    // Dropped from Finder: the browser gives only its name.
    const dropped = await add({ path: 'store.ts', text: file(30) });
    assert.equal(dropped.status, 201);
    assert.equal(dropped.json.path, 'store.ts');
    assert.equal(dropped.json.title, undefined);
    assert.deepEqual([dropped.json.x, dropped.json.y], [400, 120]);
    // Pasted with no name: untitled until named.
    const pasted = await add({ text: 'SELECT 1;' });
    assert.equal(pasted.status, 201);
    assert.match(await callText('get_canvas', { board_id: boardId }), /- untitled code \[id: \w+\] · rev 1 · by Wassim \(human\)\n  \(no path\) · 1 line/);

    // A person types its full path: that renames it, and the language holds.
    const renamed = await request('POST', `/canvas/blocks/${dropped.json.id}`, { actor: 'Wassim', path: 'src/core/store.ts', rev: 1 });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.path, 'src/core/store.ts');
    assert.equal(renamed.json.rev, 2);
    const canvas = await callText('get_canvas', { board_id: boardId });
    assert.match(canvas, /- code "src\/core\/store\.ts" \[id: \w+\] · rev 2 · by Wassim \(human\)\n  src\/core\/store\.ts · TypeScript · 30 lines/);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /^updated code "src\/core\/store\.ts" in the board context: changed the path to src\/core\/store\.ts$/);

    // A person clicks a line of it to comment, as on a diff.
    const part = { kind: 'line', file: 'src/core/store.ts', line: 3, side: 'new' };
    assert.equal((await request('POST', `/canvas/blocks/${dropped.json.id}/pins/comment`, { actor: 'Wassim', part, body: 'Why here?' })).status, 201);

    const binary = await add({ path: 'logo.png', text: '\u0089PNG\r\n\u001a\n\u0000\u0000' });
    assert.equal(binary.status, 400);
    assert.match(binary.json.error, /looks like a binary file/);
    const big = await add({ path: 'dump.sql', text: 'x'.repeat(1024 * 1024 + 1) });
    assert.equal(big.status, 400);
    assert.match(big.json.error, /a code block holds at most 1 MB/);
    const empty = await add({ path: 'blank.txt', text: '' });
    assert.equal(empty.status, 400);
    assert.match(empty.json.error, /is empty/);
  });
});
