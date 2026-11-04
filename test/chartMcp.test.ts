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

const WEEK = {
  type: 'chart',
  kind: 'bar',
  title: 'Tasks done per day',
  subtitle: 'This week, all tasks on the board',
  unit: 'tasks',
  columns: ['Day', 'Done'],
  rows: [
    ['Mon', 3],
    ['Tue', 8],
    ['Wed', '12'],
    ['Thu', '16'],
    ['Fri', 14],
  ],
};

describe('Chart blocks over MCP and REST', () => {
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
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: body && JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  }
  const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-chart-mcp-'));
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

  it('tells agents how to pick a chart', async () => {
    const { tools } = await client.listTools();
    const add = tools.find((t) => t.name === 'add_block')!;
    assert.match(
      add.description ?? '',
      /Show numbers to people with a chart block, picking the form by the job: comparing → bar; change over time → line \(area for one series\); parts of a whole → pie, only with a few parts/,
    );
    assert.match(add.description ?? '', /chart → kind \(bar, line, area, stacked-bar or pie\) \+ columns \+ rows: the first column holds the categories/);
    assert.match(add.description ?? '', /Never mix units on one chart: make two\. A single number is a note, not a chart\./);
    for (const field of ['kind', 'unit', 'subtitle', 'highlight']) assert.ok((add.inputSchema.properties as Record<string, unknown>)[field], field);
    const pin = tools.find((t) => t.name === 'pin')!;
    assert.match(pin.description ?? '', /a chart's bar, point or slice \(category, and series on a chart of several\)/);
  });

  it('adds a chart, refuses what it cannot draw, and describes it compactly and in full', async () => {
    const boardId = idOf(await callText('create_board', { title: 'Throughput' }));
    const added = await callText('add_block', { board_id: boardId, ...WEEK });
    assert.match(added, /^Added chart "Tasks done per day" \[id: \w+\] \(rev 1\)\.$/);
    const blockId = idOf(added);

    const notNumber = await call('add_block', { board_id: boardId, ...WEEK, rows: [['Mon', 'three']] });
    assert.equal(notNumber.isError, true);
    assert.match(notNumber.content[0].text, /"three" in Done for "Mon" isn't a number\. Series cells are numbers, such as 1,234 or 12%/);
    const pie = await call('add_block', { board_id: boardId, type: 'chart', kind: 'pie', columns: ['Day', 'Opened', 'Done'], rows: [['Mon', 1, 2]] });
    assert.match(pie.content[0].text, /A pie shows one series/);
    const noKind = await call('add_block', { board_id: boardId, type: 'chart', columns: ['Day', 'Done'], rows: [['Mon', 1]] });
    assert.match(noKind.content[0].text, /A chart block needs kind: bar, line, area, stacked-bar or pie\./);
    const single = await callText('add_block', { board_id: boardId, type: 'chart', kind: 'bar', columns: ['Day', 'Done'], rows: [['Mon', 3]] });
    assert.match(single, /Advice \(nothing was rejected\):\n- It shows a single number: a note says that better than a chart/);

    const canvas = await callText('get_canvas', { board_id: boardId });
    assert.match(
      canvas,
      /- chart "Tasks done per day" \[id: \w+\] · rev 1 · by Claude \(agent\)\n  bar chart · 5 categories, Mon to Fri · in tasks\n  Subtitle: This week, all tasks on the board\n  Done: 3 tasks \(Mon\) to 16 tasks \(Thu\)\n  \(get_block for the table\)/,
    );
    const full = await callText('get_block', { block_id: blockId });
    assert.match(full, /bar chart · 5 categories, Mon to Fri · in tasks\nSubtitle: This week, all tasks on the board\n\| Day \| Done \|\n\| --- \| --- \|\n\| Mon \| 3 \|\n\| Tue \| 8 \|/);

    // People's copy carries the chart as data.
    const board = (await request('GET', `/boards/${boardId}`)).json;
    const block = board.canvas.blocks.find((b: { id: string }) => b.id === blockId);
    assert.equal(block.kind, 'bar');
    assert.deepEqual(block.rows[0], ['Mon', '3']);
    assert.equal(block.w, 480);
  });

  it('replaces the data or the kind with update_block, keeping each earlier version', async () => {
    const boardId = idOf(await callText('create_board', { title: 'Versions' }));
    const blockId = idOf(await callText('add_block', { board_id: boardId, ...WEEK }));

    const updated = await callText('update_block', { block_id: blockId, rev: 1, kind: 'line', rows: [...WEEK.rows.slice(0, 4), ['Fri', 15]], highlight: 'Thu' });
    assert.match(updated, /^Updated chart "Tasks done per day" \[id: \w+\] \(now rev 2\)\.$/);
    const refused = await call('update_block', { block_id: blockId, rev: 2, kind: 'pie', columns: ['Day', 'Done', 'Opened'], rows: [['Mon', 1, 2]] });
    assert.match(refused.content[0].text, /A pie shows one series/);
    const notAChart = idOf(await callText('add_block', { board_id: boardId, type: 'note', text: 'Hi' }));
    assert.match((await call('update_block', { block_id: notAChart, rev: 1, kind: 'bar' })).content[0].text, /A note block has no kind\./);

    const versions = await callText('get_block', { block_id: blockId });
    assert.match(versions, /^chart "Tasks done per day" \[id: \w+\] · rev 2\nline chart · 5 categories, Mon to Fri · in tasks · highlight "Thu"/);
    assert.match(versions, /- v2 \(current\) · [^\n]+ · Claude \(agent\) · made it a line chart; highlighted "Thu"; set Done for "Fri" to "15"\n- v1 · [^\n]+ · Claude \(agent\) · made it/);
    const kept = await request('GET', `/canvas/blocks/${blockId}/versions/1`);
    assert.equal(kept.json.kind, 'bar');
    assert.deepEqual(kept.json.rows[4], ['Fri', '14']);

    assert.match(await callText('update_block', { block_id: blockId, rev: 2, restore_rev: 1 }), /^Restored v1 of chart "Tasks done per day"/);
    const restored = store.blockOf(blockId);
    assert.equal(restored.type === 'chart' && restored.kind, 'bar');
    assert.equal(restored.type === 'chart' && restored.highlight, undefined);
    // A unit, subtitle or highlight is cleared with "".
    await callText('update_block', { block_id: blockId, rev: 3, subtitle: '', unit: '' });
    const cleared = store.blockOf(blockId);
    assert.ok(cleared.type === 'chart' && cleared.subtitle === undefined && cleared.unit === undefined);
  });

  it('pins a comment to a bar, finds it again by name when the data changes, and says when it is gone', async () => {
    const boardId = idOf(await callText('create_board', { title: 'Pins on charts' }));
    const taskId = idOf(await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Speed up search' }] }));
    const blockId = idOf(
      await callText('add_block', {
        task_id: taskId,
        type: 'chart',
        kind: 'bar',
        title: 'Latency',
        unit: 'ms',
        columns: ['Service', 'p50', 'p95'],
        rows: [
          ['Search', 120, 340],
          ['Payments', 80, 1200],
        ],
      }),
    );

    // A person clicks Payments' p95 bar and comments.
    const part = { kind: 'point', category: 'Payments', series: 'p95' };
    const commented = await request('POST', `/canvas/blocks/${blockId}/pins/comment`, { actor: 'Wassim', part, body: 'Why is this so slow?' });
    assert.equal(commented.status, 201);
    assert.equal(commented.json.pin.quote, 'Payments · p95: 1,200 ms');
    assert.equal(commented.json.comment.pin.quote, 'Latency · Payments · p95: 1,200 ms');
    const pinId = commented.json.pin.id;
    // The agent answers on it.
    assert.equal(
      await callText('comment', { pin_id: pinId, body: 'Card checks retry three times; T2 fixes it.' }),
      'Commented on T1 about Payments · p95: 1,200 ms in chart "Latency", in its discussion.',
    );
    // And links the task to the Search category with the pin tool.
    assert.match(await callText('pin', { block_id: blockId, task_id: taskId, category: 'search' }), /^Pinned Search in chart "Latency" to T1 \[pin id: \w+\]/);
    assert.match((await call('pin', { block_id: blockId, task_id: taskId, category: 'Billing' })).content[0].text, /chart "Latency" has no category "Billing"\. Its categories: "Search", "Payments"\./);
    assert.match((await call('pin', { block_id: blockId, task_id: taskId, category: 'Search', series: 'p99' })).content[0].text, /has no series "p99"\. Its series: "p50" and "p95"\./);
    const notChart = idOf(await callText('add_block', { task_id: taskId, type: 'note', text: 'Search' }));
    assert.match((await call('pin', { block_id: notChart, task_id: taskId, category: 'Search' })).content[0].text, /Points are pinned in charts; note "Search" is a note\./);

    let canvas = await callText('get_canvas', { task_id: taskId });
    assert.match(canvas, /\n  pinned Payments · p95: 1,200 ms → 2 comments in the discussion, quoting it \[pin id: \w+\]/);
    assert.match(canvas, /\n  pinned Search → T1 \(to do\)/);

    // New numbers, rows reordered: the pins follow their categories by name.
    await callText('update_block', { block_id: blockId, rev: 1, rows: [['Payments', 70, 450], ['Search', 110, 300], ['Docs', 20, 40]] });
    canvas = await callText('get_canvas', { task_id: taskId });
    assert.match(canvas, /pinned Payments · p95: 1,200 ms → 2 comments/);
    assert.doesNotMatch(canvas, /no longer there/);
    const board = store.getBoard(boardId);
    const pin = board.tasks[0].canvas.pins.find((p) => p.id === pinId)!;
    const block = store.blockOf(blockId);
    const { placePin } = await import('../src/core/pins');
    assert.deepEqual(placePin(block, pin), { kind: 'point', row: 0, series: 1 });

    // Payments goes: its pin says so, and the activity tells the agent.
    await callText('update_block', { block_id: blockId, rev: 2, rows: [['Search', 110, 300], ['Docs', 20, 40]] });
    canvas = await callText('get_canvas', { task_id: taskId });
    assert.match(canvas, /pinned Payments · p95: 1,200 ms \(no longer there\) → 2 comments/);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /Payments · p95: 1,200 ms, commented on, is no longer there/);
  });

  it('makes a chart from a table, next to it, over REST', async () => {
    const boardId = idOf(await callText('create_board', { title: 'Make a chart' }));
    const table = await request('POST', '/canvas/blocks', {
      actor: 'Wassim',
      boardId,
      title: 'Response times',
      x: 100,
      y: 80,
      w: 420,
      h: 220,
      content: { type: 'table', columns: ['Service', 'p50', 'Owner', 'p95'], rows: [['Search', '120', 'Ana', '340'], ['Payments', '80', 'Li', '1,200']] },
    });
    assert.equal(table.status, 201);
    const made = await request('POST', `/canvas/blocks/${table.json.id}/chart`, { actor: 'Wassim' });
    assert.equal(made.status, 201);
    const chart = made.json.block;
    assert.equal(chart.type, 'chart');
    assert.equal(chart.kind, 'bar');
    assert.equal(chart.title, 'Response times');
    assert.deepEqual(chart.columns, ['Service', 'p50', 'p95']);
    assert.deepEqual(chart.rows[1], ['Payments', '80', '1,200']);
    assert.deepEqual(made.json.left, ['Owner']);
    assert.deepEqual([chart.x, chart.y], [100 + 420 + 48, 80]); // beside the table
    assert.equal(chart.author.kind, 'human');
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /^added chart "Response times" in the board context/);

    // A second chart goes somewhere clear: the first is beside the table, and in the way under it.
    const second = (await request('POST', `/canvas/blocks/${table.json.id}/chart`, { actor: 'Wassim' })).json.block;
    const apart = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h || b.y >= a.y + a.h;
    assert.ok(apart(second, chart) && apart(second, table.json), 'it overlaps nothing');

    // A person changes its kind from the header, and edits its data.
    const kinded = await request('POST', `/canvas/blocks/${chart.id}`, { actor: 'Wassim', kind: 'stacked-bar', rev: 1 });
    assert.equal(kinded.json.kind, 'stacked-bar');
    const bad = await request('POST', `/canvas/blocks/${chart.id}`, { actor: 'Wassim', rows: [['Search', 'fast', '340']], rev: 2 });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /"fast" in p50 for "Search" isn't a number/);

    const words = await request('POST', '/canvas/blocks', { actor: 'Wassim', boardId, content: { type: 'table', columns: ['Option', 'Pros'], rows: [['A', 'fast']] } });
    const refused = await request('POST', `/canvas/blocks/${words.json.id}/chart`, { actor: 'Wassim' });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /no column of numbers to chart/);
    const notTable = await request('POST', `/canvas/blocks/${chart.id}/chart`, { actor: 'Wassim' });
    assert.match(notTable.json.error, /is not a table/);
  });
});
