import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { pinLines } from '../src/core/digest';
import { addressTo, pairingRequests, type PairingSession } from '../src/core/pairing';
import { partAsks, partOf } from '../src/core/parts';
import { partQuote, pinLost, pinPart, placePin } from '../src/core/pins';
import { BoardError, Store } from '../src/core/store';
import type { Actor, Block, Pin, Task } from '../src/core/types';
import { createApp } from '../src/server/app';
import { PairingSessions } from '../src/server/pairing';
import { cellCovered, cellSpan, pointCovers } from '../src/web/canvas/pairing/pointing';
import { removeScratch } from './platform';

// Pairing on a table's cells, rows and columns, a chart's bars, points and
// series, and a 3D scene's named objects (T181), as on code, notes, diagrams
// and images (pairingPieces.test.ts): a request made there is addressed to
// the agent paired with, names the part as its pin does, and says what to
// change and with which tool; pins stay where the kind finds them again
// after the change, or are lost; and the view's pointing rules.

const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tricot-pairing-data-')));
after(() => removeScratch(scratch));

const sam: Actor = { kind: 'human', name: 'Sam' };
const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };
const AGENTS = ['Claude', 'Codex'];

type Json = Record<string, unknown>;
// A scene with two named boxes (one with a uuid, one without) and a light.
const crate = (more: Json = {}): Json => ({ type: 'Mesh', name: 'Crate', uuid: 'crate-1', geometry: 'g1', material: 'm1', position: [0, 0.5, 0], ...more });
const shelf = (more: Json = {}): Json => ({ type: 'Mesh', name: 'Shelf', geometry: 'g1', material: 'm1', position: [2, 0.5, 0], ...more });
const sceneOf = (...children: Json[]) =>
  JSON.stringify({
    metadata: { version: 4.6, type: 'Object' },
    geometries: [{ uuid: 'g1', type: 'BoxGeometry', width: 1, height: 1, depth: 1 }],
    materials: [{ uuid: 'm1', type: 'MeshStandardMaterial', color: '#3b6fd6' }],
    object: { type: 'Scene', children },
  });

// A board where Claude and Codex have worked, with a task whose canvas holds the three pieces.
function setUp() {
  const store = new Store(mkdtempSync(path.join(scratch, 'data-')));
  store.load();
  const board = store.createBoard({ title: 'Checkout' }, sam);
  const [task] = store.planTasks(board.id, [{ title: 'Tune retries' }], sam, { ready: true });
  store.addTaskComment(task.id, 'On it.', claude);
  store.addTaskComment(task.id, 'I can review.', codex);
  const at = { taskId: task.id };
  const table = store.addBlock(
    at,
    { title: 'Retry budgets', content: { type: 'table', columns: ['Service', 'Attempts', 'p95'], rows: [['Payments', '5', '1.8s'], ['Search', '3', '0.4s']] } },
    sam,
  ) as Extract<Block, { type: 'table' }>;
  const chart = store.addBlock(
    at,
    { title: 'Signups', content: { type: 'chart', kind: 'bar', columns: ['Day', 'Free', 'Paid'], rows: [['Mon', '12', '3'], ['Tue', '15', '4']], unit: 'people' } },
    claude,
  ) as Extract<Block, { type: 'chart' }>;
  const scene = store.addBlock(at, { title: 'Warehouse', content: { type: 'scene', scene: sceneOf(crate(), shelf()) } }, claude) as Extract<Block, { type: 'scene' }>;
  return { store, board, task, table, chart, scene };
}

// Sam asks the agent paired with, as the full view sends it.
function ask(store: Store, block: Block, part: Parameters<Store['pinComment']>[1], text: string, agent = 'Claude') {
  return store.pinComment(block.id, part, addressTo(text, agent, AGENTS), sam, { ask: true });
}

const pinOn = (store: Store, task: Task, id: string): Pin => store.getTask(task.id).task.canvas.pins.find((p) => p.id === id)!;
const blockOn = (store: Store, task: Task, id: string): Block => store.getTask(task.id).task.canvas.blocks.find((b) => b.id === id)!;
const placed = (store: Store, task: Task, block: Block, pin: Pin) => placePin(blockOn(store, task, block.id), pinOn(store, task, pin.id));
const asksFor = (store: Store, boardId: string, agent = 'Claude') => partAsks(store.getBoard(boardId), agent)?.split('\n') ?? [];

describe('Pairing on tables, charts and 3D scenes', () => {
  it('starts on each piece by its part, and tells the agent paired with what it is pairing on', () => {
    const { store, board, table, chart, scene } = setUp();
    const sessions = new PairingSessions(store);
    for (const [block, part, piece] of [
      [table, 'table', 'the table "Retry budgets"'],
      [chart, 'chart', 'the chart "Signups"'],
      [scene, 'scene', 'the scene "Warehouse"'],
    ] as const) {
      const session = sessions.start({ blockId: block.id, part, person: 'Sam', agent: 'Claude' });
      assert.equal(session.part, part);
      assert.deepEqual(sessions.lines(board.id, 'Claude'), [
        `Sam is pairing with you on ${piece} (T1's canvas) [block id: ${block.id}]: their requests there come straight to you, as @-mentions. Act on each as it comes, then reply on its pin after the change; they watch your steps on the pin while you work.`,
      ]);
      assert.deepEqual(sessions.lines(board.id, 'Codex'), []);
      sessions.end(session.id, 'Sam');
    }
    assert.throws(() => sessions.start({ blockId: table.id, part: 'chart', person: 'Sam', agent: 'Claude' }), (e: unknown) => e instanceof BoardError && /has no parts to pair on/.test(e.message));
    assert.throws(() => sessions.start({ blockId: scene.id, part: 'spot', person: 'Sam', agent: 'Claude' }), BoardError);
    sessions.stop();
  });

  it('names each kind of part, by its anchors, for the block it is on', () => {
    const { table, chart, scene } = setUp();
    assert.equal(partOf(table, 'cells')?.kind, 'table');
    assert.equal(partOf(chart, 'point')?.kind, 'chart');
    assert.equal(partOf(scene, 'spot')?.kind, 'scene');
    assert.equal(partOf(table, 'point'), undefined);
    assert.equal(partOf(scene, 'box'), undefined);
  });

  it("addresses a request on a table's cell, row or column to the agent, naming them by their headers, to change the table with update_block", () => {
    const { store, board, task, table } = setUp();
    const cell = ask(store, table, { kind: 'cells', rows: [0, 0], columns: [1, 1] }, 'make it 3');
    const row = ask(store, table, { kind: 'cells', rows: [1, 1] }, 'drop it');
    const columns = ask(store, table, { kind: 'cells', columns: [1, 2] }, 'rename them');
    assert.equal(cell.comment.body, '@Claude make it 3');
    assert.deepEqual([cell.comment.ask, cell.comment.askPart, cell.comment.mentions], [true, 'table', ['Claude']]);
    assert.deepEqual([pinPart(cell.pin, table), pinPart(row.pin, table), pinPart(columns.pin, table)], ['Payments · Attempts: 5', 'Search row', 'Attempts–p95 columns']);
    assert.equal(partQuote(cell.pin, table), 'Retry budgets · Payments · Attempts: 5');
    const asks = asksFor(store, board.id);
    const how = `Change the table with update_block (block_id: ${table.id}, rows: every row, as the table is to be; and columns, if they change), keeping the names of the columns you keep`;
    assert.equal(
      asks[0],
      `Sam asked you to change Payments · Attempts: 5 (row 1 under the header, column "Attempts") of the table "Retry budgets" [block id: ${table.id}], on T1's canvas: "@Claude make it 3". ` +
        `${how}, then reply in the thread with comment (pin_id: ${cell.pin.id}); people's view of the table reloads by itself.`,
    );
    assert.match(asks[1], /^Sam asked you to change Search row \(row 2 under the header, every column\) of the table "Retry budgets"/);
    assert.match(asks[2], /^Sam asked you to change Attempts–p95 columns \(every row, columns "Attempts" to "p95"\) of the table "Retry budgets"/);
    assert.match(partAsks(store.getBoard(board.id), 'Codex')!, /For Claude: not for you; carry on\.$/m);
    const lines = pinLines(store.getBoard(board.id), store.getTask(task.id).task.canvas, table).join('\n');
    assert.match(lines, /pinned Payments · Attempts: 5 → request to change the table, 1 comment in the discussion, quoting it \[pin id: \w+\]; change the table's columns and rows with update_block, then reply with comment\(pin_id\)/);
  });

  it('keeps table pins on their columns by name and their rows while they read the same; cells the agent rewrote are lost', () => {
    const { store, board, task, table } = setUp();
    const cell = ask(store, table, { kind: 'cells', rows: [1, 1], columns: [1, 1] }, 'make it 2').pin;
    const row = ask(store, table, { kind: 'cells', rows: [0, 0] }, 'add a p99').pin;
    const column = ask(store, table, { kind: 'cells', columns: [2, 2] }, 'in ms').pin;
    // A row added above, a column added: each pin follows its cells.
    store.updateBlock(table.id, { columns: ['Service', 'Attempts', 'p95', 'p99'], rows: [['Auth', '2', '0.2s', '0.3s'], ['Payments', '5', '1.8s', '2.1s'], ['Search', '3', '0.4s', '0.5s']] }, claude);
    assert.deepEqual(placed(store, task, table, cell), { kind: 'cells', rows: [2, 2], columns: [1, 1] });
    assert.deepEqual(placed(store, task, table, row), { kind: 'cells', rows: [1, 1], columns: null });
    assert.deepEqual(placed(store, task, table, column), { kind: 'cells', rows: null, columns: [2, 2] });
    assert.match(asksFor(store, board.id)[0], /Search · Attempts: 3 \(row 3 under the header, column "Attempts"\)/, 'its row as it is now');
    // The agent changes the cell asked about: that pin is lost, and listed apart; the others stay.
    store.updateBlock(table.id, { rows: [['Auth', '2', '0.2s', '0.3s'], ['Payments', '5', '1.8s', '2.1s'], ['Search', '2', '0.4s', '0.5s']] }, claude);
    assert.equal(placed(store, task, table, cell), null);
    assert.equal(pinLost(pinOn(store, task, cell.id)), 'cells changed');
    assert.deepEqual(placed(store, task, table, row), { kind: 'cells', rows: [1, 1], columns: null });
    assert.deepEqual(placed(store, task, table, column), { kind: 'cells', rows: null, columns: [2, 2] });
    assert.match(asksFor(store, board.id)[0], /asked you to change Search · Attempts: 3 \(row 2 under the header, column "Attempts"\) of the table "Retry budgets" .*, which is no longer there as pinned: "@Claude make it 2"\. Read the block with get_block/);
    // The row's cells changed, or the column renamed: those pins are lost too.
    store.updateBlock(table.id, { columns: ['Service', 'Attempts', 'p95 (ms)', 'p99'], rows: [['Auth', '2', '200', '300'], ['Payments', '4', '1800', '2100'], ['Search', '2', '400', '500']] }, claude);
    assert.equal(placed(store, task, table, row), null);
    assert.equal(placed(store, task, table, column), null);
  });

  it("addresses a request on a chart's bar, a category or a whole series, to change the chart's data", () => {
    const { store, board, chart } = setUp();
    const bar = ask(store, chart, { kind: 'point', category: 'Tue', series: 'Paid' }, 'make it 6');
    const series = ask(store, chart, { kind: 'point', series: 'Free' }, 'halve it');
    const category = ask(store, chart, { kind: 'point', category: 'mon' }, 'drop Monday');
    assert.deepEqual([bar.comment.askPart, series.comment.askPart], ['chart', 'chart']);
    assert.deepEqual(series.pin.anchor, { kind: 'point', series: 'Free' }, 'a series from the legend: no category');
    assert.deepEqual([bar.pin.quote, series.pin.quote, category.pin.quote], ['Tue · Paid: 4 people', 'Free series', 'Mon']);
    const asks = asksFor(store, board.id);
    assert.equal(
      asks[0],
      `Sam asked you to change the bar "Tue · Paid: 4 people" (category "Tue", series "Paid") of the chart "Signups" [block id: ${chart.id}], on T1's canvas: "@Claude make it 6". ` +
        `Change the chart's data with update_block (block_id: ${chart.id}, columns and rows: the whole table, the first column its categories, each other column a series), keeping the names of the categories and series you keep, ` +
        `then reply in the thread with comment (pin_id: ${bar.pin.id}); people's view of the chart reloads by itself.`,
    );
    assert.match(asks[1], /^Sam asked you to change series "Free" \(its bars in every category\) of the chart "Signups"/);
    assert.match(asks[2], /^Sam asked you to change category "Mon" \(its bars in every series\) of the chart "Signups"/);
    assert.throws(() => ask(store, chart, { kind: 'point', series: 'Trial' }, 'x'), /has no series "Trial"\. Its series: "Free" and "Paid"\./);
    assert.throws(() => ask(store, chart, { kind: 'point' }, 'x'), /Pin a chart's bar, point or slice by its category, or a whole series by its name\./);
  });

  it('names the marks of a line or a pie as points and slices', () => {
    const { store, board, task } = setUp();
    const line = store.addBlock({ taskId: task.id }, { title: 'Latency', content: { type: 'chart', kind: 'line', columns: ['Day', 'ms'], rows: [['Mon', '120'], ['Tue', '95']] } }, claude);
    const pie = store.addBlock({ taskId: task.id }, { title: 'Plans', content: { type: 'chart', kind: 'pie', columns: ['Plan', 'People'], rows: [['Free', '80'], ['Paid', '20']] } }, claude);
    ask(store, line, { kind: 'point', category: 'Tue' }, 'is this right?');
    ask(store, pie, { kind: 'point', category: 'Paid' }, 'make it 25');
    const asks = asksFor(store, board.id);
    assert.match(asks[0], /asked you to change the point "Tue: 95" \(category "Tue"\) of the chart "Latency"/);
    assert.match(asks[1], /asked you to change the slice "Paid: 20" \(category "Paid"\) of the chart "Plans"/);
  });

  it("keeps chart pins on their category and series by name, whatever the numbers; renamed or removed, they are lost", () => {
    const { store, task, chart } = setUp();
    const bar = ask(store, chart, { kind: 'point', category: 'Tue', series: 'Paid' }, 'make it 6').pin;
    const series = ask(store, chart, { kind: 'point', series: 'Free' }, 'halve it').pin;
    const category = ask(store, chart, { kind: 'point', category: 'Mon' }, 'drop Monday').pin;
    // New numbers, a day added in front, the series swapped round: each pin is found again by name.
    store.updateBlock(chart.id, { columns: ['Day', 'Paid', 'Free'], rows: [['Sun', '1', '9'], ['Mon', '3', '6'], ['Tue', '6', '8']] }, claude);
    assert.deepEqual(placed(store, task, chart, bar), { kind: 'point', row: 2, series: 0 });
    assert.deepEqual(placed(store, task, chart, series), { kind: 'point', row: null, series: 1 });
    assert.deepEqual(placed(store, task, chart, category), { kind: 'point', row: 1, series: null });
    // Monday dropped, Free renamed: those pins are lost; Tuesday's bar stays.
    store.updateBlock(chart.id, { columns: ['Day', 'Paid', 'Trial'], rows: [['Sun', '1', '9'], ['Tue', '6', '8']] }, claude);
    assert.equal(placed(store, task, chart, category), null);
    assert.equal(placed(store, task, chart, series), null);
    assert.equal(pinLost(pinOn(store, task, series.id)), 'no longer there');
    assert.deepEqual(placed(store, task, chart, bar), { kind: 'point', row: 1, series: 0 });
  });

  it("addresses a request on a 3D scene's named object, to change the scene's JSON whole; spots stay on their objects by name", () => {
    const { store, board, task, scene } = setUp();
    const onCrate = ask(store, scene, { kind: 'spot', object: 'crate-1', x: 0.1, y: 0.5, z: 0 }, 'make it red');
    const onShelf = ask(store, scene, { kind: 'spot', object: 'Shelf' }, 'twice as tall');
    assert.deepEqual([onCrate.comment.askPart, onCrate.pin.quote, onShelf.pin.quote], ['scene', 'spot 1 on "Crate"', 'spot 2 on "Shelf"']);
    const asks = asksFor(store, board.id);
    assert.equal(
      asks[0],
      `Sam asked you to change spot 1 on "Crate" (at x 0.1, y 0.5, z 0 on the object, uuid crate-1) of the 3D scene "Warehouse" [block id: ${scene.id}], on T1's canvas: "@Claude make it red". ` +
        `Change the scene with update_block (block_id: ${scene.id}, scene: its whole three.js JSON, as get_block gives it), keeping the name (and uuid) of each object you keep: spots stay on their objects by them, ` +
        `then reply in the thread with comment (pin_id: ${onCrate.pin.id}); people's view of the scene reloads by itself.`,
    );
    assert.match(asks[1], /asked you to change spot 2 on "Shelf" \(at x 0, y 0, z 0 on the object\) of the 3D scene "Warehouse"/);
    const lines = pinLines(store.getBoard(board.id), store.getTask(task.id).task.canvas, scene).join('\n');
    assert.match(lines, /→ request to change the 3D scene, 1 comment in the discussion, quoting it \[pin id: \w+\]; change the scene's JSON with update_block, keeping its objects' names, then reply with comment\(pin_id\)/);

    // The scene sent whole: the crate red and moved, the shelf taller. Both spots stay.
    store.updateBlock(scene.id, { scene: sceneOf(crate({ position: [1, 0.5, 1] }), shelf({ scale: [1, 2, 1] })) }, claude);
    assert.ok(placed(store, task, scene, onCrate.pin));
    assert.ok(placed(store, task, scene, onShelf.pin));
    // Renamed with its uuid kept, the crate keeps its spot; the shelf, gone, loses its own.
    store.updateBlock(scene.id, { scene: sceneOf(crate({ name: 'Red crate' })) }, claude);
    assert.ok(placed(store, task, scene, onCrate.pin));
    assert.equal(placed(store, task, scene, onShelf.pin), null);
    assert.equal(pinLost(pinOn(store, task, onShelf.pin.id)), 'object removed');
  });

  it("lists a session's requests on each piece, and sums them up on the card as it ends", () => {
    const { store, task, table, chart, scene } = setUp();
    const sessions = new PairingSessions(store);
    for (const [block, part, made] of [
      [table, 'table', { kind: 'cells', rows: [0, 0], columns: [1, 1] }],
      [chart, 'chart', { kind: 'point', series: 'Paid' }],
      [scene, 'scene', { kind: 'spot', object: 'Crate' }],
    ] as const) {
      const session = sessions.start({ blockId: block.id, part, person: 'Sam', agent: 'Claude' });
      const first = ask(store, block, made as never, 'change it');
      const asked = () => pairingRequests(store.getTask(task.id).task.canvas.pins, { task: store.getTask(task.id).task }, session as PairingSession).map((r) => r.state);
      assert.deepEqual(asked(), ['working']);
      store.commentOnPin(first.pin.id, 'Done.', claude);
      assert.deepEqual(asked(), ['done']);
      assert.equal(sessions.end(session.id, 'Sam')?.summary, `Paired under a minute with Claude on the ${part} "${block.title}": 1 request, 1 done, 0 open.`);
    }
    sessions.stop();
  });
});

describe("Pointing at a table's cells and a chart's marks, in the full view", () => {
  it('takes a drag over cells as a range, over the column names as columns, over the row numbers as rows', () => {
    assert.deepEqual(cellSpan([1, 1], [1, 1]), { rows: [1, 1], columns: [1, 1] }, 'a click: one cell');
    assert.deepEqual(cellSpan([3, 2], [1, 0]), { rows: [1, 3], columns: [0, 2] }, 'either way');
    assert.deepEqual(cellSpan([-1, 2], [4, 0]), { columns: [0, 2] }, 'from the header: whole columns');
    assert.deepEqual(cellSpan([2, -1], [0, 3]), { rows: [0, 2] }, "from the rows' numbers: whole rows");
    assert.deepEqual(cellSpan([1, 1], [-1, -1]), { rows: [0, 1], columns: [0, 1] }, 'straying onto the header or the numbers stops at the first');
  });

  it('marks the cells a range takes in, the header with whole columns and the numbers with whole rows', () => {
    const cell = { rows: [1, 1] as [number, number], columns: [2, 2] as [number, number] };
    assert.equal(cellCovered(cell, [1, 2]), true);
    assert.equal(cellCovered(cell, [1, 1]), false);
    assert.equal(cellCovered(cell, [-1, 2]), false, "a cell's column name isn't in it");
    const column = { rows: null, columns: [2, 2] as [number, number] };
    assert.equal(cellCovered(column, [-1, 2]), true);
    assert.equal(cellCovered(column, [7, 2]), true);
    assert.equal(cellCovered(column, [3, -1]), false);
    const row = { rows: [3, 3] as [number, number] };
    assert.equal(cellCovered(row, [3, -1]), true);
    assert.equal(cellCovered(row, [3, 0]), true);
    assert.equal(cellCovered(row, [-1, 0]), false);
  });

  it("marks a chart's bars by the category and series pinned, and a whole series' line and key", () => {
    const bar = { category: 1, series: 0 };
    const day = { category: 1, series: null };
    const free = { category: null, series: 0 };
    assert.deepEqual([pointCovers(bar, 1, 0), pointCovers(bar, 1, 1), pointCovers(bar, 0, 0)], [true, false, false]);
    assert.deepEqual([pointCovers(day, 1, 0), pointCovers(day, 1, 1), pointCovers(day, 1, null)], [true, true, true], "a category: its bars, its slice, its column");
    assert.deepEqual([pointCovers(free, 0, 0), pointCovers(free, 3, 0), pointCovers(free, 3, 1)], [true, true, false], 'a series: its bars in every category');
    assert.deepEqual([pointCovers(free, null, 0), pointCovers(free, null, 1), pointCovers(day, null, 0)], [true, false, false], "a series' line and key: only the series");
    assert.equal(pointCovers(free, 1, null), false, "a slice or a category's column isn't a series");
  });
});

describe('Pairing on a chart over the app', () => {
  let server: Server;
  let base: string;
  let agent: Client;
  let ctx: ReturnType<typeof setUp>;
  const rest = async (route: string, body: object) => {
    const res = await fetch(`${base}/api${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const call = async (name: string, args: object) => {
    const result = (await agent.callTool({ name, arguments: args as Record<string, unknown> })) as { content: { text: string }[] };
    return result.content.map((c) => c.text).join('\n');
  };

  before(async () => {
    ctx = setUp();
    server = createApp(ctx.store, { host: '127.0.0.1', mcpUrl: 'unused' }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    agent = new Client({ name: 'test', version: '1' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
  });
  after(async () => {
    await agent.close();
    server.closeAllConnections();
    server.close();
    await ctx.store.flush();
  });

  it("puts a request on a whole series straight to the agent, which changes the chart's rows with update_block; the pin stays on its series", async () => {
    const { board, chart, task } = ctx;
    const started = await rest('/pairing', { actor: 'Sam', blockId: chart.id, part: 'chart', agent: 'Claude' });
    assert.equal(started.status, 201);
    const session = started.json as PairingSession;
    const cursor = ctx.store.getBoard(board.id).seq;
    const waiting = call('wait_for_updates', { board_id: board.id, since: cursor, timeout_seconds: 30 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sent = Date.now();
    const asked = await rest(`/canvas/blocks/${chart.id}/pins/comment`, { actor: 'Sam', part: { kind: 'point', series: 'Free' }, body: addressTo('double it', session.agent, AGENTS), ask: true });
    assert.equal(asked.status, 201);
    const pin = asked.json.pin as Pin;
    const heard = await waiting;
    assert.ok(Date.now() - sent < 1500, `woke in ${Date.now() - sent} ms`);
    assert.ok(heard.includes(`Sam (human) asked you on T1 [task id: ${task.id}]: "double it". Change the chart's data with update_block, then reply with comment(pin_id: ${pin.id}).`), heard);
    assert.ok(heard.includes(`asked you to change series "Free" (its bars in every category) of the chart "Signups" [block id: ${chart.id}]`), heard);
    assert.ok(heard.includes('Sam is pairing with you on the chart "Signups"'), 'the session is named with it');

    const rev = ctx.store.getTask(task.id).task.canvas.blocks.find((b) => b.id === chart.id)!.rev;
    assert.match(await call('update_block', { block_id: chart.id, rev, rows: [['Mon', 24, 3], ['Tue', 30, 4]] }), /^Updated chart "Signups" \[id: \w+\] \(now rev 2\)/);
    await call('comment', { pin_id: pin.id, body: 'Doubled.' });
    const now = ctx.store.getTask(task.id).task.canvas;
    assert.deepEqual(placePin(now.blocks.find((b) => b.id === chart.id)!, now.pins.find((p) => p.id === pin.id)!), { kind: 'point', row: null, series: 0 }, 'still on Free');
    const ended = await rest(`/pairing/${session.id}/end`, { actor: 'Sam' });
    assert.equal(ended.json.summary, 'Paired under a minute with Claude on the chart "Signups": 1 request, 1 done, 0 open.');
    assert.equal(partAsks(ctx.store.getBoard(board.id), 'Claude'), undefined, 'answered: no longer waiting');
  });
});
