import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { canvasDigest } from '../src/core/digest';
import { noteText, placePin } from '../src/core/pins';
import { Store } from '../src/core/store';
import { pinOnNote } from '../src/core/store/checklistNotes';
import { MIGRATIONS, openDatabase, userVersion } from '../src/core/store/migrations';
import { proseOf, retick, setTask, taskLines, taskProgress, taskWords, withTasks } from '../src/core/taskList';
import type { Actor, Block, Pin } from '../src/core/types';
import { createApp } from '../src/server/app';
import { jsonFolder } from './savedBoard';
import { eventsOf, legacyBoard, versionsOf } from './tables';

const agent: Actor = { kind: 'agent', name: 'planner' };
const sam: Actor = { kind: 'human', name: 'Sam' };

describe('Task lists in notes', () => {
  describe('a tick', () => {
    const note = 'Before Friday:\n\n- [ ] Audit call sites\n- [x] Pick a strategy\n  - [ ] Ask payments\n\n1. [ ] Canary\n2) [X] Staging\n\n* [ ] Star\n+ [ ] Plus';

    it('rewrites only the box on its line, every other byte as it was', () => {
      const ticked = setTask(note, 3, true)!;
      assert.equal(ticked, note.replace('- [ ] Audit call sites', '- [x] Audit call sites'));
      assert.equal(ticked.length, note.length);
      assert.equal(setTask(ticked, 3, false), note, 'and back');
      assert.equal(setTask(note, 4, true), note, 'a done task ticked is as it was');
    });

    it('ticks nested, ordered and other bullets, and keeps a capital X when it unticks', () => {
      assert.match(setTask(note, 5, true)!, /\n {2}- \[x\] Ask payments\n/);
      assert.match(setTask(note, 7, true)!, /\n1\. \[x\] Canary\n/);
      assert.match(setTask(note, 8, false)!, /\n2\) \[ \] Staging\n/);
      assert.match(setTask(note, 10, true)!, /\n\* \[x\] Star\n/);
      assert.match(setTask(note, 11, true)!, /\n\+ \[x\] Plus$/);
    });

    it('keeps odd whitespace, tabs, quotes and Windows line ends as they were', () => {
      const odd = '-   [ ]   spaced out   \r\n\t- [ ]\ttabbed\r\n> - [ ] quoted\r\n- - [ ] inner';
      assert.equal(setTask(odd, 1, true), odd.replace('-   [ ]', '-   [x]'));
      assert.equal(setTask(odd, 2, true), odd.replace('\t- [ ]', '\t- [x]'));
      assert.equal(setTask(odd, 3, true), odd.replace('> - [ ]', '> - [x]'));
      assert.equal(setTask(odd, 4, true), odd.replace('- - [ ]', '- - [x]'));
      assert.deepEqual(
        taskLines(odd).map((t) => t.text),
        ['spaced out', 'tabbed', 'quoted', 'inner'],
        'the words, without the \\r',
      );
    });

    it('refuses a line with no box, and boxes that are only text', () => {
      assert.equal(setTask(note, 1, true), null, 'prose');
      assert.equal(setTask(note, 2, true), null, 'a blank line');
      assert.equal(setTask(note, 99, true), null, 'past the end');
      assert.equal(setTask('- [] not a box\n-[ ] nor this\n- [ ]no space', 1, true), null);
      assert.deepEqual(taskLines('- [] not a box\n-[ ] nor this\n- [ ]no space\n    - x'), []);
      assert.deepEqual(taskLines('```\n- [ ] in code\n```\n~~~md\n- [x] also code\n~~~\n- [ ] real'), [{ line: 7, done: false, text: 'real', lead: '- ' }]);
      assert.deepEqual(taskLines('- [ ] '), [], 'a box at the very end is not one yet');
    });

    it('is made again on a note someone changed meanwhile, on the same task', () => {
      const theirs = `New intro.\n\n${note}`;
      const again = retick(theirs, { line: 3, text: 'Audit call sites' }, true)!;
      assert.equal(again, theirs.replace('- [ ] Audit call sites', '- [x] Audit call sites'));
      assert.equal(retick(theirs, { line: 4, text: 'Pick a strategy' }, true), theirs, 'already so');
      assert.equal(retick(theirs.replace('Audit call sites', 'Audit callers'), { line: 3, text: 'Audit call sites' }, true), null, 'gone');
    });
  });

  it('counts how many tasks are done, and says so to agents', () => {
    assert.deepEqual(taskProgress('- [x] a\n- [ ] b\n  - [x] c\n\n```\n- [x] code\n```'), { done: 2, total: 3 });
    assert.deepEqual(taskProgress('No tasks here. [ ] - [x]'), { done: 0, total: 0 });
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-tasklist-'));
    const store = new Store(dir);
    store.load();
    try {
      const board = store.createBoard({ title: 'Progress' }, sam);
      const tasks = Array.from({ length: 7 }, (_, i) => `- [${i < 3 ? 'x' : ' '}] Step ${i + 1}`).join('\n');
      store.addBlock({ boardId: board.id }, { title: 'Steps', content: { type: 'note', text: `Where we are.\n\n${tasks}` } }, agent);
      store.addBlock({ boardId: board.id }, { title: 'Prose', content: { type: 'note', text: 'Nothing to tick.' } }, agent);
      const digest = canvasDigest(store.getBoard(board.id), store.getBoard(board.id).canvas);
      assert.match(digest, /note "Steps" \[id: \w+\][^\n]*\n {2}3\/7 done\n {2}Where we are\.\n/);
      assert.match(digest, /note "Prose" \[id: \w+\][^\n]*\n {2}Nothing to tick\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("an agent's list of items", () => {
    it('replaces the tasks where they were, keeping ticks where the words match and the prose around them', () => {
      const note = 'Before Friday:\n\n- [x] Audit call sites\n- [ ] Ship\n\nAsk Sam first.';
      assert.equal(
        withTasks(note, [{ text: 'Audit call sites' }, { text: 'Ship', done: true }, { text: 'Announce' }]),
        'Before Friday:\n\n- [x] Audit call sites\n- [x] Ship\n- [ ] Announce\n\nAsk Sam first.',
      );
      assert.equal(withTasks(note, [{ text: 'Audit call sites', done: false }]), 'Before Friday:\n\n- [ ] Audit call sites\n\nAsk Sam first.', 'an item can untick');
      assert.equal(proseOf(withTasks(note, [])), proseOf(note), 'no items, no tasks, the prose stays');
    });

    it('gathers tasks spread through the note where the first was, and keeps how each was written', () => {
      const note = 'Now:\n  * [x] Draft  \nThen some words.\n1. [ ] Review\r\nEnd.';
      assert.equal(
        withTasks(note, [{ text: 'Review' }, { text: 'Draft' }, { text: 'Ship it\n  today' }]),
        'Now:\n1. [ ] Review\r\n  * [x] Draft  \n  * [ ] Ship it today\nThen some words.\nEnd.',
      );
    });

    it('puts a task list at the end of a note that has none', () => {
      assert.equal(withTasks('Context.\n\n', [{ text: 'One' }, { text: 'Two', done: true }]), 'Context.\n\n- [ ] One\n- [x] Two');
      assert.equal(withTasks('', [{ text: 'One' }]), '- [ ] One');
    });
  });

  it("finds a task's words in the note as it reads", () => {
    const note = '# Plan\n\n```\ncode\n```\n- [ ] Read [the docs](https://x.dev) first\n- [x] **Ship**';
    const reads = noteText(note);
    const first = taskWords(note, 6)!;
    assert.equal(reads.slice(first.start, first.end), 'Read the docs first');
    const second = taskWords(note, 7)!;
    assert.equal(reads.slice(second.start, second.end), '**Ship**');
  });
});

// ---- checklists saved before #83 ----------------------------------------------------

describe('Checklists saved before they were notes', () => {
  const folders: string[] = [];
  const scratch = () => {
    const made = mkdtempSync(path.join(os.tmpdir(), 'tricot-checklists-'));
    folders.push(made);
    return made;
  };
  afterEach(() => {
    for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const items = [
    { id: 'i1', text: 'Board and tasks', done: true },
    { id: 'i2', text: 'Use **Stripe** Elements, see [docs](https://stripe.com/docs)', done: false },
    { id: 'i3', text: 'Pricing page', done: false },
  ];
  const asChecklist = (block: Record<string, unknown>, list: unknown[], extra: object = {}) => {
    const { text: _text, ...rest } = block;
    return { ...rest, type: 'checklist', items: list, ...extra };
  };
  const words = (block: Block, pin: Pin) => {
    const at = placePin(block, pin);
    assert.ok(at?.kind === 'text', `${pin.quote} is placed`);
    return block.type === 'note' ? noteText(block.text).slice(at.start, at.end) : '';
  };

  // A data folder as Tricot left it at data version 5, with checklists: made
  // as notes through the store, then written back as checklists were saved.
  async function savedWithChecklists() {
    const dir = scratch();
    const before = new Store(dir);
    before.load();
    const board = before.createBoard({ title: 'Launch' }, sam);
    const decision = before.postDecision(board.id, { question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'Not yet' }] }, agent);
    const launch = before.addBlock({ boardId: board.id }, { title: 'Launch', content: { type: 'note', text: 'v1' } }, agent);
    before.updateBlock(launch.id, { text: 'v2' }, agent);
    before.updateBlock(launch.id, { text: 'Board and tasks\nUse Stripe Elements, see docs\nPricing page\nOld step' }, sam);
    before.deleteVersion(launch.id, 1, sam);
    const review = before.addBlock({ decisionId: decision.id }, { title: 'Review', content: { type: 'note', text: 'Read the spec\nSign off' } }, agent);
    const old = before.addBlock({ boardId: board.id }, { title: 'Old', content: { type: 'note', text: 'Gone step' } }, agent);
    const pins = {
      item: before.pinTask(launch.id, { kind: 'text', quote: 'Use Stripe Elements, see docs' }, { text: 'Prototype Elements' }, sam).pin,
      words: before.pinComment(launch.id, { kind: 'text', quote: 'Pricing' }, 'Which tiers?', sam).pin,
      lost: before.pinComment(launch.id, { kind: 'text', quote: 'Old step' }, 'Still needed?', sam).pin,
      card: before.pinComment(review.id, { kind: 'text', quote: 'Sign off' }, 'Who signs?', sam).pin,
      kept: before.pinComment(old.id, { kind: 'text', quote: 'Gone step' }, 'Why was it dropped?', sam).pin,
    };
    before.removeItem(old.id, sam);
    await before.flush();

    const db = openDatabase(path.join(dir, 'tricot.db'));
    const body = (kind: string, id: string) => JSON.parse((db.prepare('SELECT body FROM items WHERE kind = ? AND id = ?').get(kind, id) as { body: string }).body);
    const put = (kind: string, id: string, value: unknown) => db.prepare('UPDATE items SET body = ? WHERE kind = ? AND id = ?').run(JSON.stringify(value), kind, id);
    const repin = (id: string, anchor: object, quote: string) => put('pin', id, { ...body('pin', id), anchor, quote });
    put('block', launch.id, asChecklist(body('block', launch.id), items));
    repin(pins.item.id, { kind: 'item', itemId: 'i2' }, items[1].text);
    repin(pins.words.id, { kind: 'text', prefix: '', suffix: ' page', itemId: 'i3' }, 'Pricing');
    repin(pins.lost.id, { kind: 'item', itemId: 'i9' }, 'Old step'); // its item was removed
    put('block', review.id, asChecklist(body('block', review.id), [{ id: 'r1', text: 'Read the spec', done: true }, { id: 'r2', text: 'Sign off', done: false }]));
    repin(pins.card.id, { kind: 'item', itemId: 'r2' }, 'Sign off');
    const removed = body('deletion', old.id);
    removed.kept.block = asChecklist(removed.kept.block, [{ id: 'o1', text: 'Gone step', done: true }]);
    removed.kept.pins[0] = { ...removed.kept.pins[0], anchor: { kind: 'item', itemId: 'o1' }, quote: 'Gone step' };
    put('deletion', old.id, removed);
    // The versions: v2 in its table, v1 kept by the deletion a person made of it.
    const was = (rev: number, list: unknown[]) => ({ title: 'Launch', type: 'checklist', items: list, rev, at: '2026-10-01T00:00:00.000Z', by: agent });
    db.prepare('UPDATE block_versions SET body = ? WHERE block = ? AND rev = 2').run(JSON.stringify(was(2, items.slice(0, 2))), launch.id);
    const dropped = body('deletion', `${launch.id}@v1`);
    dropped.kept.versions = [was(1, [{ id: 'i1', text: 'Board and tasks', done: false }])];
    put('deletion', `${launch.id}@v1`, dropped);
    db.exec('PRAGMA user_version = 5');
    db.close();
    return { dir, board, decision, launch, review, old, pins };
  }

  it('become notes once, with a copy of the file kept from before', async () => {
    const { dir, board, launch, review } = await savedWithChecklists();
    const store = new Store(dir);
    store.load();

    const [copy, ...more] = readdirSync(path.join(dir, 'backups'));
    assert.equal(more.length, 0);
    assert.match(copy, /^tricot-v5-.*\.db$/);
    const old = openDatabase(path.join(dir, 'backups', copy), MIGRATIONS.slice(0, 5));
    assert.equal(userVersion(old), 5, 'the copy is the file as it was');
    assert.equal((old.prepare(`SELECT COUNT(*) AS n FROM items WHERE json_extract(body, '$.type') = 'checklist'`).get() as { n: number }).n, 2);
    old.close();

    const note = store.blockOf(launch.id);
    assert.ok(note.type === 'note');
    assert.equal(note.text, '- [x] Board and tasks\n- [ ] Use **Stripe** Elements, see [docs](https://stripe.com/docs)\n- [ ] Pricing page');
    assert.deepEqual([note.id, note.title, note.rev, note.versionCount], [launch.id, 'Launch', 3, 1], 'its id, title, rev and versions');
    const reviewed = store.blockOf(review.id);
    assert.ok(reviewed.type === 'note' && reviewed.text === '- [x] Read the spec\n- [ ] Sign off');
    assert.match(canvasDigest(store.getBoard(board.id), store.getBoard(board.id).canvas), /note "Launch" \[id: \w+\][^\n]*\n {2}1\/3 done\n {2}- \[x\] Board and tasks/);

    // Nothing is left of checklists in the file.
    await store.flush();
    const db = openDatabase(path.join(dir, 'tricot.db'));
    for (const [table, column] of [['items', 'body'], ['block_versions', 'body']]) {
      const left = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE '%"type":"checklist"%' OR ${column} LIKE '%"kind":"item"%' OR ${column} LIKE '%"itemId"%'`).get() as { n: number };
      assert.equal(left.n, 0, table);
    }
    assert.equal(userVersion(db), MIGRATIONS.length);
    db.close();
    const again = new Store(dir);
    again.load();
    assert.equal(readdirSync(path.join(dir, 'backups')).length, 1, 'once: the next start has nothing to move');
  });

  it('keep their versions, as the notes they showed', async () => {
    const { dir, launch } = await savedWithChecklists();
    const store = new Store(dir);
    store.load();
    assert.deepEqual(
      versionsOf(store, launch.id).map((v) => [v.rev, v.type, v.type === 'note' && v.text]),
      [[2, 'note', '- [x] Board and tasks\n- [ ] Use **Stripe** Elements, see [docs](https://stripe.com/docs)']],
    );
    assert.deepEqual(
      store.versionSummaries(launch.id).map((v) => `v${v.rev}: ${v.change}`),
      ['v3: added task "Pricing page"', 'v2: '],
    );
    // A version a person deleted comes back as a note too, and restores.
    store.restoreItem(`${launch.id}@v1`, sam);
    assert.deepEqual(
      versionsOf(store, launch.id).map((v) => [v.rev, v.type === 'note' ? v.text : v.type]),
      [
        [1, '- [ ] Board and tasks'],
        [2, '- [x] Board and tasks\n- [ ] Use **Stripe** Elements, see [docs](https://stripe.com/docs)'],
      ],
    );
    const restored = store.restoreBlock(launch.id, 1, sam);
    assert.ok(restored.type === 'note' && restored.text === '- [ ] Board and tasks');
    assert.equal(restored.rev, 4);
  });

  it('move pins and comments on an item to its line, and keep one whose item is gone on the whole note', async () => {
    const { dir, board, decision, launch, review, pins } = await savedWithChecklists();
    const store = new Store(dir);
    store.load();
    const live = store.getBoard(board.id);
    const pinOf = (id: string) => [live.canvas, ...live.decisions.map((d) => d.canvas)].flatMap((c) => c.pins).find((p) => p.id === id)!;
    const note = store.blockOf(launch.id);
    assert.ok(note.type === 'note');

    const item = pinOf(pins.item.id);
    assert.equal(words(note, item), 'Use **Stripe** Elements, see docs', 'the whole of its line, as it reads');
    assert.equal(item.quote, 'Use **Stripe** Elements, see docs');
    assert.equal(item.taskId, pins.item.taskId, 'still linked to its task');

    const inItem = pinOf(pins.words.id);
    assert.deepEqual([words(note, inItem), inItem.quote], ['Pricing', 'Pricing']);
    assert.equal(inItem.discussion?.thread?.[0].body, 'Which tiers?', 'its comment thread with it');

    const lost = pinOf(pins.lost.id);
    assert.deepEqual(lost.anchor, { kind: 'block' }, 'on the whole note, not dropped');
    assert.equal(lost.quote, 'Old step', 'still saying what it was about');
    assert.equal(lost.discussion?.thread?.[0].body, 'Still needed?');
    assert.deepEqual(placePin(note, lost), { kind: 'block' });

    const card = pinOf(pins.card.id);
    assert.equal(words(store.blockOf(review.id), card), 'Sign off');
    const comment = live.decisions.find((d) => d.id === decision.id)!.comments.find((c) => c.pin?.id === card.id);
    assert.equal(comment?.body, 'Who signs?', "the card's comment still carries it");

    // And they hold through a tick, as a note's pins do.
    store.updateBlock(launch.id, { text: setTask(note.text, 3, true)! }, sam, 3);
    assert.match(eventsOf(store, board.id).at(-1)!.summary, /updated note "Launch" in the board context: checked "Pricing page"$/);
    assert.equal(words(store.blockOf(launch.id), inItem), 'Pricing');
  });

  it('come back from a deletion as notes, with their pins', async () => {
    const { dir, old, pins } = await savedWithChecklists();
    const store = new Store(dir);
    store.load();
    store.restoreItem(old.id, sam);
    const back = store.blockOf(old.id);
    assert.ok(back.type === 'note' && back.text === '- [x] Gone step');
    const pin = store.canvasOf(old.id).canvas.pins.find((p) => p.id === pins.kept.id)!;
    assert.equal(words(back, pin), 'Gone step');
    assert.equal(pin.discussion?.thread?.[0].body, 'Why was it dropped?');
  });

  it('in board files an earlier Tricot left become notes as they are imported', async () => {
    const source = new Store(scratch());
    source.load();
    const board = source.createBoard({ title: 'From files' }, sam);
    const list = source.addBlock({ boardId: board.id }, { title: 'Steps', content: { type: 'note', text: 'Ship it' } }, agent);
    source.updateBlock(list.id, { text: 'Ship it now' }, agent);
    const pinned = source.pinComment(list.id, { kind: 'text', quote: 'Ship' }, 'When?', sam).pin;
    const legacy = legacyBoard(source, board.id) as unknown as { canvas: { blocks: Record<string, unknown>[]; pins: Record<string, unknown>[] } };
    const [block] = legacy.canvas.blocks;
    const versions = (block.versions as Record<string, unknown>[]).map((v) => asChecklist(v, [{ id: 'a', text: 'Ship it', done: false }]));
    legacy.canvas.blocks[0] = asChecklist(block, [{ id: 'a', text: 'Ship it now', done: true }], { versions });
    legacy.canvas.pins[0] = { ...legacy.canvas.pins[0], anchor: { kind: 'text', prefix: '', suffix: ' it now', itemId: 'a' } };
    await source.flush();

    const dir = jsonFolder(legacy);
    folders.push(dir);
    const store = new Store(dir);
    store.load();
    const note = store.blockOf(list.id);
    assert.ok(note.type === 'note' && note.text === '- [x] Ship it now');
    assert.deepEqual(versionsOf(store, list.id).map((v) => v.type === 'note' && v.text), ['- [ ] Ship it']);
    const pin = store.canvasOf(list.id).canvas.pins.find((p) => p.id === pinned.id)!;
    assert.equal(words(note, pin), 'Ship');
    assert.ok(!existsSync(path.join(dir, `${board.id}.json`)), 'the file was moved aside, as imports do');
  });

  it('place pins made across half a link, or on emphasis quoted with its marks, on the words or their line', () => {
    const checklist = { id: 'b1', type: 'checklist', items: [{ id: 'i1', text: 'Read [the docs](https://stripe.com/docs) and **Stripe** Elements', done: false }] };
    const legacy = (quote: string, prefix: string, suffix: string) => ({ id: 'p', blockId: 'b1', anchor: { kind: 'text', prefix, suffix, itemId: 'i1' }, quote });
    const note = { id: 'b1', type: 'note', text: '- [ ] Read [the docs](https://stripe.com/docs) and **Stripe** Elements' } as unknown as Block;
    // The words a pin finds, as they read (emphasis marks aside).
    const moved = (pin: object) => {
      const after = pinOnNote(pin as Record<string, unknown>, checklist) as unknown as Pin;
      return [after.quote, words(note, after).replace(/\*/g, '')];
    };
    assert.deepEqual(moved(legacy('**Stripe** Elements', 'and ', '')), ['**Stripe** Elements', 'Stripe Elements']);
    assert.deepEqual(moved(legacy('the docs', 'Read [', '](https://stripe.com/docs) and')), ['the docs', 'the docs']);
    assert.deepEqual(
      moved(legacy('docs](https://stripe.com/docs) and', 'Read [the ', ' **Stripe** Elements')),
      ['Read the docs and **Stripe** Elements', 'Read the docs and Stripe Elements'],
      'words that no longer show pin their whole line',
    );
  });
});

// ---- agents that still ask for checklists ---------------------------------------------

describe('Agents asking for checklists, over MCP', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let client: Client;
  let store: Store;
  let boardId: string;

  type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const callText = async (name: string, args: Record<string, unknown>) => {
    const result = await call(name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content[0].text;
  };
  const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-checklist-mcp-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Planner`)));
  });

  beforeEach(async () => {
    boardId = idOf(await callText('create_board', { title: `Rollout ${Math.random()}` }));
  });

  after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('tells agents task lists live in notes, and still takes a checklist', async () => {
    const { tools } = await client.listTools();
    const add = tools.find((t) => t.name === 'add_block')!;
    const update = tools.find((t) => t.name === 'update_block')!;
    assert.match(add.description!, /note → text \(Markdown; task lists live in notes, as "- \[ \] step" lines people tick and "- \[x\] step" once done\); checklist → items, accepted for compatibility: it makes a note with that task list;/);
    assert.match(update.description!, /Items replace a note's task list and leave the prose around it alone; a task keeps its tick when its words match\./);
    const type = (add.inputSchema.properties as Record<string, { enum?: string[] }>).type;
    assert.deepEqual(type.enum?.slice(0, 3), ['note', 'table', 'checklist']);
    assert.doesNotMatch(add.description!, /a checklist for steps/);
  });

  it('makes a note with the task list an agent sends as a checklist', async () => {
    const added = await callText('add_block', { board_id: boardId, type: 'checklist', title: 'Rollout', items: ['Audit call sites', { text: 'Ship', done: true }] });
    assert.match(added, /^Added note "Rollout" \[id: \w+\] \(rev 1\)\./);
    assert.match(added, /Checklists are notes now/);
    const id = idOf(added);
    const block = store.blockOf(id);
    assert.ok(block.type === 'note' && block.text === '- [ ] Audit call sites\n- [x] Ship');
    assert.match(await callText('get_block', { block_id: id }), /^note "Rollout" \[id: \w+\] · rev 1\n1\/2 done\n- \[ \] Audit call sites\n- \[x\] Ship/);

    const note = await callText('add_block', { board_id: boardId, type: 'note', title: 'Plan', text: 'First the client.', items: ['Client', 'Queue'] });
    const plan = store.blockOf(idOf(note));
    assert.ok(plan.type === 'note' && plan.text === 'First the client.\n\n- [ ] Client\n- [ ] Queue');

    const refused = await call('add_block', { board_id: boardId, type: 'checklist', title: 'Empty' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /A checklist block needs items\./);
  });

  it("rewrites a former checklist's tasks from items, keeping ticks and the words a person wrote around them", async () => {
    const id = idOf(await callText('add_block', { board_id: boardId, type: 'checklist', title: 'Rollout', items: ['Audit call sites', 'Ship'] }));
    // A person ticks a task and writes around the list.
    const res = await fetch(`${base}/api/canvas/blocks/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'Sam', rev: 1, text: 'Before Friday:\n\n- [x] Audit call sites\n- [ ] Ship\n\nAsk Sam first.' }),
    });
    assert.equal(res.status, 200);

    const stale = await call('update_block', { block_id: id, rev: 1, items: ['Audit call sites', 'Ship', 'Announce'] });
    assert.equal(stale.isError, true, 'refused on the rev it read, as any change');
    assert.match(stale.content[0].text, /changed since rev 1[\s\S]*Current content \(rev 2\):\n1\/2 done\nBefore Friday:/);

    assert.equal(await callText('update_block', { block_id: id, rev: 2, items: ['Audit call sites', 'Ship', 'Announce'] }), `Updated note "Rollout" [id: ${id}] (now rev 3).`);
    const block = store.blockOf(id);
    assert.ok(block.type === 'note');
    assert.equal(block.text, 'Before Friday:\n\n- [x] Audit call sites\n- [ ] Ship\n- [ ] Announce\n\nAsk Sam first.');
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /updated note "Rollout" in the board context: added task "Announce"$/);

    const table = idOf(await callText('add_block', { board_id: boardId, type: 'table', columns: ['a'], rows: [['1']] }));
    const wrong = await call('update_block', { block_id: table, rev: 1, items: ['x'] });
    assert.match(wrong.content[0].text, /A table block has no items\./);
  });

  it('pins a task in a note by its words, as it pinned a checklist item', async () => {
    const id = idOf(await callText('add_block', { board_id: boardId, type: 'checklist', title: 'Rollout', items: ['Audit call sites', 'Ship it', 'Ship it'] }));
    const task = idOf(await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Ship' }] }));
    assert.match(await callText('pin', { block_id: id, item: 'ship it', task_id: task }), /^Pinned "Ship it" in note "Rollout" to T1/);
    assert.match(await callText('pin', { block_id: id, item: 'Audit call sites', text: 'call', task_id: task }), /^Pinned "call" in note "Rollout" to T1/);
    const missing = await call('pin', { block_id: id, item: 'Launch', task_id: task });
    assert.match(missing.content[0].text, /note "Rollout" has no task "Launch"\./);
    const block = store.blockOf(id);
    const pins = store.canvasOf(id).canvas.pins;
    assert.deepEqual(pins.map((p) => words(block, p)), ['Ship it', 'call']);
    const at = placePin(block, pins[0]);
    assert.ok(at?.kind === 'text' && at.start === noteText(block.type === 'note' ? block.text : '').indexOf('Ship it'), 'the first of the two');
  });

  const words = (block: Block, pin: Pin) => {
    const at = placePin(block, pin);
    assert.ok(at?.kind === 'text');
    return block.type === 'note' ? noteText(block.text).slice(at.start, at.end) : '';
  };
});
