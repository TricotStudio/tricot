import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { cardLinkLines, cardLinks } from '../src/core/cardLinks';
import { goneName } from '../src/core/threads';
import { applyChange } from '../src/core/changes';
import { boardDigest, eventsDigest, taskDetail } from '../src/core/digest';
import { needsFrom } from '../src/core/needs';
import { searchBoards } from '../src/core/search';
import { Store } from '../src/core/store';
import { DATABASE_FILE } from '../src/core/store/boardDb';
import { openDatabase } from '../src/core/store/migrations';
import { kindOf } from '../src/core/blocks/registry';
import type { Actor, Block, Board } from '../src/core/types';
import { peoplesCopy } from '../src/server/api';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';
import { eventsOf } from './tables';
import { removeScratch } from './platform';

const sam: Actor = { kind: 'human', name: 'Sam' };
const claude: Actor = { kind: 'agent', name: 'Claude' };

// A PNG's header: enough for the store to accept it as a picture.
function png(width: number, height: number): Uint8Array {
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), ...text('IHDR'), ...u32(width), ...u32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0]);
}

// The rows the database holds of one card: its own and its canvas's.
function rowsOfCard(dir: string, kind: 'task' | 'decision', id: string): number {
  const db = openDatabase(path.join(dir, DATABASE_FILE));
  try {
    const own = db.prepare('SELECT COUNT(*) AS n FROM items WHERE owner = ? AND kind = ? AND id = ?').get('', kind, id) as { n: number };
    const canvas = db.prepare('SELECT COUNT(*) AS n FROM items WHERE owner = ?').get(`${kind}:${id}`) as { n: number };
    return own.n + canvas.n;
  } finally {
    db.close();
  }
}

// The block versions the database holds of a block.
function versionRows(dir: string, blockId: string): number {
  const db = openDatabase(path.join(dir, DATABASE_FILE));
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM block_versions WHERE block = ?').get(blockId) as { n: number }).n;
  } finally {
    db.close();
  }
}

// The board as a page gets it over the wire.
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value, peoplesCopy));

// The person's browser, let in as one of their seats (seatHelper.ts): it signs what needs one.
let seat: TestSeat;

describe('Deleting a card made by mistake, for good', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-delete-card-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Retries' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  const decided = (question = 'How often to retry?') => {
    const d = store.postDecision(boardId, { question, options: [{ label: 'Twice' }, { label: 'Thrice' }] }, claude);
    store.resolve(d.id, { optionId: 'a' }, sam);
    return d;
  };
  const board = () => store.getBoard(boardId);

  it('is refused for agents and on an archived board, and removes nothing', () => {
    const [task] = store.planTasks(boardId, [{ title: 'Add retries' }], claude);
    const decision = decided();
    assert.throws(() => store.deleteTask(task.id, claude), /Only people delete a task\. If T1 was made by mistake, say so in a comment on it, and a person can delete it\./);
    assert.throws(() => store.deleteDecision(decision.id, claude), /Only people delete a decision\. If #1 was made by mistake/);
    store.setArchived(boardId, true, sam);
    assert.throws(() => store.deleteTask(task.id, sam), /read-only/);
    assert.equal(board().tasks.length, 1);
    assert.equal(board().decisions.length, 1);
  });

  it("refuses agents removing a card as if it were a canvas item, and says a deleted one can't come back", () => {
    const [task] = store.planTasks(boardId, [{ title: 'Add retries' }], claude);
    assert.throws(() => store.removeItem(task.id, claude), /T1 is a task, not a canvas item, and only people delete a task\. If it was made by mistake, say so in a comment on it/);
    assert.throws(() => store.removeItem(task.id, sam), /T1 is a task, not a canvas item: delete it from its ⋯ menu\./);
    store.deleteTask(task.id, sam);
    assert.throws(() => store.restoreItem(task.id, sam), /T1 was a task Sam deleted at \S+\. It's gone for good, with its canvas and discussion; nothing of it can be read or restored\./);
  });

  it('removes a task, its canvas, versions, pictures and comments, logs it, and never gives its number again', async () => {
    const decision = decided();
    const [task, other] = store.planTasks(boardId, [{ title: 'Add retries', decisionIds: [decision.id] }, { title: 'Tidy logs' }], claude);
    store.addTaskComment(task.id, 'Started on it', claude);
    const note = store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'Plan' } }, claude);
    store.updateBlock(note.id, { text: 'Plan, revised' }, claude); // an earlier version
    const mine = store.saveAsset(png(10, 10));
    const shared = store.saveAsset(png(20, 20));
    store.addBlock({ taskId: task.id }, { content: { type: 'image', assetId: mine } }, claude);
    store.addBlock({ taskId: task.id }, { content: { type: 'image', assetId: shared } }, claude);
    store.addBlock({ boardId }, { content: { type: 'image', assetId: shared } }, claude);
    const away = store.addBlock({ taskId: task.id }, { content: { type: 'image', assetId: store.saveAsset(png(30, 30)) } }, claude);
    const awayAsset = (away as { assetId: string }).assetId;
    store.removeItem(away.id, sam); // kept to restore, on the task's canvas
    // A part of a block elsewhere pinned to the task.
    const context = store.addBlock({ boardId }, { content: { type: 'note', text: 'Retry after QA' } }, sam);
    const pin = store.pin(context.id, { kind: 'text', quote: 'after QA' }, { taskId: task.id }, claude);
    await store.flush();
    assert.ok(rowsOfCard(dir, 'task', task.id) > 0);
    assert.ok(versionRows(dir, note.id) > 0);

    store.deleteTask(task.id, sam);

    assert.deepEqual(board().tasks.map((t) => t.id), [other.id]);
    assert.throws(() => store.getTask(task.id), /T1 was a task Sam deleted at \S+\. It's gone for good/);
    assert.throws(() => store.blockOf(note.id), /No canvas block/);
    assert.ok(!board().canvas.pins.some((p) => p.id === pin.id), 'the pin to it goes');
    assert.throws(() => store.canvasOf(pin.id), /No canvas block, group, link or pin/);
    assert.ok(!board().deleted?.some((d) => d.on.taskId === task.id), "what was kept from its canvas goes with it");
    assert.equal(existsSync(path.join(dir, 'assets', mine)), false, 'a picture only it showed');
    assert.equal(existsSync(path.join(dir, 'assets', awayAsset)), false, 'a picture only its deleted block showed');
    assert.equal(existsSync(path.join(dir, 'assets', shared)), true, 'the board context still shows this one');
    assert.deepEqual(board().deletedCards?.map((c) => [c.kind, c.id, c.number, c.by.name]), [['task', task.id, 1, 'Sam']]);
    const event = eventsOf(store, boardId).at(-1)!;
    assert.equal(event.type, 'card_deleted');
    assert.equal(event.summary, 'deleted T1 "Add retries"');
    assert.equal(event.taskId, task.id);

    const [next] = store.planTasks(boardId, [{ title: 'Add retries, again' }], claude);
    assert.equal(next.number, 3, 'T1 stays taken');

    await store.flush();
    assert.equal(rowsOfCard(dir, 'task', task.id), 0);
    assert.equal(versionRows(dir, note.id), 0);
  });

  it('flags the tasks built on a deleted decision stale, unlinked, and drops what depends on it', () => {
    const decision = decided();
    const later = store.postDecision(boardId, { question: 'Which backoff?', options: [{ label: 'Linear' }], dependsOn: [decision.id] }, claude);
    const [task, free] = store.planTasks(boardId, [{ title: 'Add retries', decisionIds: [decision.id] }, { title: 'Tidy logs' }], claude);

    store.deleteDecision(decision.id, sam);

    const { task: built } = store.getTask(task.id);
    assert.deepEqual(built.decisionIds, []);
    assert.equal(built.stale?.reason, '#1 was deleted by Sam');
    assert.equal(store.getTask(free.id).task.stale, undefined);
    assert.deepEqual(store.getDecision(later.id).decision.dependsOn, []);
    assert.throws(() => store.getDecision(decision.id), /#1 was a decision Sam deleted at \S+\. It's gone for good/);
    const [deleted, stale] = eventsOf(store, boardId).slice(-2);
    assert.equal(deleted.summary, 'deleted #1 "How often to retry?"');
    assert.equal(stale.type, 'tasks_stale');
    assert.equal(stale.summary, 'marked T1 stale: #1 "How often to retry?" was deleted, so it lost its link to it');

    // An agent re-checks it as it would after any change.
    assert.throws(
      () => store.updateTask(task.id, { status: 'done' }, claude),
      /T1 "Add retries" is stale: #1 was deleted by Sam\. Check it still makes sense without that decision, then update_task with still_valid: true/,
    );
    store.updateTask(task.id, { stillValid: true }, claude);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /confirmed it still holds after #1 changed/);
    const [next] = [store.postDecision(boardId, { question: 'Another?' }, claude)];
    assert.equal(next.number, 3, '#1 stays taken');
  });

  it("is gone from agents' views, search and Needs you", () => {
    const decision = store.postDecision(boardId, { question: 'Zebra or quagga?', options: [{ label: 'Zebra' }] }, claude);
    const [task] = store.planTasks(boardId, [{ title: 'Paint the stripes' }], claude);
    store.claimTask(task.id, claude);
    store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'Stripes' } }, claude);
    store.updateTask(task.id, { status: 'in_review' }, claude);
    const before = board();
    assert.ok(needsFrom(before, 'Sam', []).some((n) => n.key === decision.id));
    assert.ok(needsFrom(before, 'Sam', []).some((n) => n.key === task.id));

    store.deleteDecision(decision.id, sam);
    store.deleteTask(task.id, sam);

    const after = board();
    assert.deepEqual(needsFrom(after, 'Sam', []), []);
    assert.equal(searchBoards([after], 'zebra', { boardId }).total, 0);
    assert.equal(searchBoards([after], 'stripes', { boardId }).total, 0);
    const digest = boardDigest(after, 'Claude');
    assert.doesNotMatch(digest, /Zebra|stripes/);
    const events = eventsOf(store, boardId).slice(-2);
    assert.match(eventsDigest(events, after.seq), /- \(\d+\) Sam \(human\) deleted #1 "Zebra or quagga\?" \[id: \w+\]\n- \(\d+\) Sam \(human\) deleted T1 "Paint the stripes"/);
  });

  it('names what links to it, and what deleting it does to each', () => {
    const decision = decided();
    const thread = store.startThread(boardId, 'Can we retry less?', sam);
    const asked = store.postDecision(boardId, { question: 'Which backoff?', options: [{ label: 'Linear' }], dependsOn: [decision.id] }, claude);
    store.addThreadWork(thread.id, { kind: 'decision', id: decision.id }, claude);
    const [a, b] = store.planTasks(boardId, [{ title: 'Add retries', decisionIds: [decision.id] }, { title: 'Test retries', decisionIds: [decision.id] }], claude);
    store.addComment(asked.id, 'This follows #1, of course', sam);
    store.addTaskComment(b.id, 'Per #1', sam);
    const note = store.addBlock({ boardId }, { content: { type: 'note', text: 'Retry twice' } }, sam);
    store.pin(note.id, { kind: 'text', quote: 'twice' }, { decisionId: decision.id }, claude);

    const text = (block: Block) => kindOf(block.type).searchText(block);
    const links = cardLinks(board(), { decision: store.getDecision(decision.id).decision }, text);
    assert.deepEqual(links.builtOn.map((t) => t.number), [a.number, b.number]);
    assert.deepEqual(links.neededBy.map((d) => d.number), [asked.number]);
    assert.deepEqual(links.threads, [{ title: 'Can we retry less?', made: true, gone: false }]);
    assert.deepEqual(links.pinnedFrom, ['the board context']);
    assert.deepEqual(links.namedIn, ['#2', 'T2']);
    assert.deepEqual(cardLinkLines(links), [
      'T1 and T2 build on it: they lose the link and are flagged stale, so an agent re-checks them.',
      '#2 depends on it, and loses that link.',
      'It came from the thread "Can we retry less?", which stays and says it was deleted.',
      'A part of a block on the board context is pinned to it; that pin goes.',
      '#2 and T2 name it in their text, which will read as deleted.',
    ]);

    assert.deepEqual(store.taskLinks(a.id), ['It implements #1, which stays as it is.']);
    const [lone] = store.planTasks(boardId, [{ title: 'Alone' }], sam);
    assert.deepEqual(store.taskLinks(lone.id), []);
    // #T3 names T3, as T3 does.
    store.addComment(asked.id, 'Waiting on #T3', sam);
    assert.deepEqual(cardLinks(board(), { task: store.getTask(lone.id).task }, text).namedIn, ['#2']);
    assert.deepEqual(cardLinks(board(), { task: store.getTask(a.id).task }, text).namedIn, []);
    // A canvas's words count, as search reads them.
    store.addBlock({ taskId: lone.id }, { content: { type: 'note', text: 'See #1 for why' } }, sam);
    assert.match(store.decisionLinks(decision.id).at(-1)!, /^#2, T2 and T3 name it/);
  });

  it('leaves a thread it came from saying so, and text naming it as it was', () => {
    const thread = store.startThread(boardId, 'Plan the retries', sam);
    const [task] = store.planTasks(boardId, [{ title: 'Add retries' }], claude);
    store.addThreadWork(thread.id, { kind: 'task', id: task.id }, claude);
    store.postToThread(thread.id, 'I planned T1', claude);
    store.deleteTask(task.id, sam);
    const read = store.getThread(thread.id).thread;
    assert.equal(read.messages.at(-1)!.body, 'I planned T1', 'what people and agents wrote stays as written');
    const ref = read.messages.at(-1)!.refs!.find((r) => r.kind === 'task' && r.id === task.id)!;
    assert.equal(goneName(board(), ref), 'T1, since deleted', 'what it led to reads as deleted');
  });

  it('keeps a page showing the board equal to it through the deletion', () => {
    const decision = decided();
    const [task] = store.planTasks(boardId, [{ title: 'Add retries', decisionIds: [decision.id] }], claude);
    store.addBlock({ decisionId: decision.id }, { content: { type: 'note', text: 'Why twice' } }, claude);
    let mirror = wire(board()) as Board & { ver?: number };
    store.subscribeChanges(boardId, (change) => {
      const next = applyChange(mirror, wire(change));
      assert.ok(next, 'a page can take the change');
      mirror = next;
    });
    store.deleteDecision(decision.id, sam);
    store.deleteTask(task.id, sam);
    const { ver: _ver, ...shown } = mirror;
    assert.deepEqual(shown, wire(board()));
  });

  it('stays deleted after a restart, its number still taken', async () => {
    const decision = decided();
    const [task] = store.planTasks(boardId, [{ title: 'Add retries', decisionIds: [decision.id] }], claude);
    store.deleteDecision(decision.id, sam);
    await store.flush();
    const again = new Store(dir);
    again.load();
    const read = again.getBoard(boardId);
    assert.deepEqual(read.decisions, []);
    assert.deepEqual(read.deletedCards?.map((c) => c.number), [1]);
    assert.equal(again.getTask(task.id).task.stale?.reason, '#1 was deleted by Sam');
    assert.throws(() => again.getDecision(decision.id), /#1 was a decision Sam deleted/);
    assert.equal(again.postDecision(boardId, { question: 'Next?' }, claude).number, 2);
    assert.match(taskDetail(read, again.getTask(task.id).task), /STALE: #1 was deleted by Sam\. Check it still makes sense without that decision/);
    await again.flush();
  });
});

describe('Deleting a card over the API and MCP', () => {
  let dir: string;
  let store: Store;
  let server: Server;
  let base: string;
  let client: Client;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-delete-card-api-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    seat = letIn(app);
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
  });

  afterEach(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  const post = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign('POST', `/api${route}`, JSON.stringify(body)) }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: result.content.map((c) => c.text).join('\n'), isError: Boolean(result.isError) };
  };

  it('deletes for a person, with no number to type; agents read it as gone and can neither delete nor restore it', async () => {
    const board = store.createBoard({ title: 'Retries' }, sam);
    const decision = store.postDecision(board.id, { question: 'How often?', options: [{ label: 'Twice' }] }, claude);
    const [task] = store.planTasks(board.id, [{ title: 'Add retries' }], claude);
    await tool('get_task', { task_id: task.id });

    const removing = await tool('remove_item', { id: task.id });
    assert.equal(removing.isError, true);
    assert.match(removing.text, /T1 is a task, not a canvas item, and only people delete a task/);

    let result = await post(`/tasks/${task.id}/delete`, {});
    assert.equal(result.status, 400, 'a person says who they are');
    result = await post(`/tasks/${task.id}/delete`, { actor: 'Sam' });
    assert.deepEqual(result, { status: 200, body: { ok: true } });
    result = await post(`/decisions/${decision.id}/delete`, { actor: 'Sam' });
    assert.equal(result.status, 200);

    const read = await tool('get_task', { task_id: task.id });
    assert.equal(read.isError, true);
    assert.match(read.text, /T1 was a task Sam deleted at \S+\. It's gone for good/);
    assert.equal((await tool('get_decision', { decision_id: decision.id })).isError, true);
    const restoring = await tool('restore_item', { id: decision.id });
    assert.equal(restoring.isError, true);
    assert.match(restoring.text, /#1 was a decision Sam deleted/);
    const updates = await tool('get_updates', { board_id: board.id, since: 0 });
    assert.match(updates.text, /Sam \(human\) deleted T1 "Add retries"/);
    assert.match(updates.text, /Sam \(human\) deleted #1 "How often\?"/);

    const shown = (await (await fetch(`${base}/api/boards/${board.id}`)).json()) as Board;
    assert.deepEqual([shown.tasks, shown.decisions], [[], []]);
    assert.deepEqual(shown.deletedCards?.map((c) => `${c.kind}:${c.number}`), ['task:1', 'decision:1']);
  });

  it('names what links to a card for the confirmation', async () => {
    const board = store.createBoard({ title: 'Retries' }, sam);
    const decision = store.postDecision(board.id, { question: 'How often?', options: [{ label: 'Twice' }] }, claude);
    store.resolve(decision.id, { optionId: 'a' }, sam);
    const [task] = store.planTasks(board.id, [{ title: 'Add retries', decisionIds: [decision.id] }], claude);
    const links = (await (await fetch(`${base}/api/decisions/${decision.id}/links`)).json()) as { lines: string[] };
    assert.deepEqual(links.lines, ['T1 builds on it: it loses the link and is flagged stale, so an agent re-checks it.']);
    const taskLinks = (await (await fetch(`${base}/api/tasks/${task.id}/links`)).json()) as { lines: string[] };
    assert.deepEqual(taskLinks.lines, ['It implements #1, which stays as it is.']);
    assert.equal((await fetch(`${base}/api/tasks/nope/links`)).status, 404);
  });

  it('has no tool for agents', async () => {
    const { tools } = await client.listTools();
    assert.ok(!tools.some((t) => /delete_(task|decision|card)/.test(t.name)));
  });
});
