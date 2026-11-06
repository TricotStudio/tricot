import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { commentLine, pinLines } from '../src/core/digest';
import { addressTo, pairingRequests, type PairingSession } from '../src/core/pairing';
import { askRefusal, partAsks, partOf, partWords } from '../src/core/parts';
import { partQuote, pinPart, placePin } from '../src/core/pins';
import { BoardError, Store } from '../src/core/store';
import type { Actor, Block, Pin, Task } from '../src/core/types';
import { createApp } from '../src/server/app';
import { PairingSessions } from '../src/server/pairing';
import { boxBetween, isClick, lineSpan, placeBy, sentenceAt, spotBox, unionRect } from '../src/web/canvas/pairing/pointing';
import { removeScratch } from './platform';

// Pairing on a code block's lines, a note's words, a diagram's nodes and
// arrows, and boxes on an image (T180), as on a website and a Google Doc
// (pairing.test.ts): a request made there is addressed to the agent paired
// with, reads to it as asked of it, names the part, and says what to change
// and with which tool; the view's pointing rules; and pins after the change.

const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tricot-pairing-pieces-')));
after(() => removeScratch(scratch));

const sam: Actor = { kind: 'human', name: 'Sam' };
const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };
const AGENTS = ['Claude', 'Codex'];

// A PNG's signature and header: enough for the board to read its size.
function png(width: number, height: number): Uint8Array {
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), ...Buffer.from('IHDR'), ...u32(width), ...u32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0]);
}

const CART = ['export function total(items) {', '  let sum = 0;', '  for (const item of items) sum += item.price;', '  return sum;', '}'].join('\n');
const FLOW = 'flowchart LR\n  Client[Client] -->|on fail| Retry[Retry]\n  Retry --> Done[Done]';

// A board where Claude and Codex have worked, with a task whose canvas holds the four pieces.
function setUp() {
  const store = new Store(mkdtempSync(path.join(scratch, 'data-')));
  store.load();
  const board = store.createBoard({ title: 'Checkout' }, sam);
  const [task] = store.planTasks(board.id, [{ title: 'Tidy the cart' }], sam, { ready: true });
  store.addTaskComment(task.id, 'On it.', claude);
  store.addTaskComment(task.id, 'I can review.', codex);
  const at = { taskId: task.id };
  const code = store.addBlock(at, { content: { type: 'code', path: 'src/cart.ts', text: CART, commit: '4f2a9c1e0b7d' } }, claude) as Extract<Block, { type: 'code' }>;
  const note = store.addBlock(at, { title: 'Plan', content: { type: 'note', text: 'We ship the cart on Friday. Payments come later.' } }, sam) as Extract<Block, { type: 'note' }>;
  const diagram = store.addBlock(at, { title: 'Flow', content: { type: 'diagram', source: FLOW } }, claude) as Extract<Block, { type: 'diagram' }>;
  const assetId = store.saveAsset(png(1200, 800));
  const image = store.addBlock(at, { title: 'Checkout mock', content: { type: 'image', assetId } }, sam) as Extract<Block, { type: 'image' }>;
  return { store, board, task, code, note, diagram, image };
}

// Sam asks the agent paired with, as the full view sends it.
function ask(store: Store, block: Block, part: Parameters<Store['pinComment']>[1], text: string, agent = 'Claude') {
  return store.pinComment(block.id, part, addressTo(text, agent, AGENTS), sam, { ask: true });
}

const pinOn = (store: Store, task: Task, id: string): Pin => store.getTask(task.id).task.canvas.pins.find((p) => p.id === id)!;
const blockOn = (store: Store, task: Task, id: string): Block => store.getTask(task.id).task.canvas.blocks.find((b) => b.id === id)!;

describe('Pairing on code, notes, diagrams and images', () => {
  it('starts on each piece by its part, and tells the agent paired with what it is pairing on', () => {
    const { store, board, code, note, diagram, image } = setUp();
    const sessions = new PairingSessions(store);
    const pieces: [Block, string, string][] = [
      [code, 'code', 'the code "src/cart.ts"'],
      [note, 'note', 'the note "Plan"'],
      [diagram, 'diagram', 'the diagram "Flow"'],
      [image, 'image', 'the image "Checkout mock"'],
    ];
    for (const [block, part, piece] of pieces) {
      const session = sessions.start({ blockId: block.id, part, person: 'Sam', agent: 'Claude' });
      assert.equal(session.part, part);
      assert.deepEqual(sessions.lines(board.id, 'Claude'), [
        `Sam is pairing with you on ${piece} (T1's canvas) [block id: ${block.id}]: their requests there come straight to you, as @-mentions. Act on each as it comes, then reply on its pin after the change; they watch your steps on the pin while you work.`,
      ]);
      assert.deepEqual(sessions.lines(board.id, 'Codex'), []);
      sessions.end(session.id, 'Sam');
    }
    // A part that isn't the block's own is refused, as before.
    assert.throws(() => sessions.start({ blockId: code.id, part: 'note', person: 'Sam', agent: 'Claude' }), (e: unknown) => e instanceof BoardError && /has no parts to pair on/.test(e.message));
    assert.throws(() => sessions.start({ blockId: note.id, part: 'line', person: 'Sam', agent: 'Claude' }), BoardError);
    sessions.stop();
  });

  it('names each kind of part, by its anchors, for the block it is on', () => {
    const { code, note, diagram, image } = setUp();
    assert.equal(partOf(code, 'line')?.kind, 'code');
    assert.equal(partOf(note, 'text')?.kind, 'note');
    assert.equal(partOf(diagram, 'node')?.kind, 'diagram');
    assert.equal(partOf(diagram, 'arrow')?.kind, 'diagram');
    assert.equal(partOf(image, 'box')?.kind, 'image');
    assert.equal(partOf(note, 'line'), undefined);
    assert.equal(partWords('site')?.kind, 'site', "a website's elements are named as before");
    assert.equal(partWords('line'), undefined, "an anchor's kind isn't a part's name");
  });

  it('addresses a request on a code line to the agent, which reads what was pointed at, what to change and with which tool', () => {
    const { store, board, task, code } = setUp();
    const { pin, comment } = ask(store, code, { kind: 'line', file: 'src/cart.ts', line: 2 }, 'start from the saved total');
    assert.equal(comment.body, '@Claude start from the saved total');
    assert.deepEqual([comment.ask, comment.askPart, comment.mentions], [true, 'code', ['Claude']]);
    assert.equal(pinPart(pin, code), 'line 2 of src/cart.ts');
    assert.match(commentLine(comment), /on src\/cart\.ts:2 · “let sum = 0;” \[pin id: \w+, asking agents to change it in the code block\]/);
    const asks = partAsks(store.getBoard(board.id), 'Claude');
    assert.equal(
      asks,
      `Sam asked you to change line 2 ("let sum = 0;") of the code block "src/cart.ts" [block id: ${code.id}], on T1's canvas: "@Claude start from the saved total". ` +
        `Change src/cart.ts in your repository if you have it there (the block shows it at 4f2a9c1), and the block's text with update_block (block_id: ${code.id}, text: the lines it shows, changed), ` +
        `then reply in the thread with comment (pin_id: ${pin.id}); people's view of the code reloads by itself.`,
    );
    assert.match(partAsks(store.getBoard(board.id), 'Codex')!, /For Claude: not for you; carry on\.$/);
    const lines = pinLines(store.getBoard(board.id), store.getTask(task.id).task.canvas, code).join('\n');
    assert.match(lines, /→ request to change the code, 1 comment in the discussion, quoting it \[pin id: \w+\]; change the code block's text with update_block \(and the file it shows, if it is in your repository\), then reply with comment\(pin_id\)/);
  });

  it('takes a range of code lines, which keeps its length as the code around it changes', () => {
    const { store, board, task, code } = setUp();
    const { pin } = ask(store, code, { kind: 'line', file: 'src/cart.ts', line: 2, last: 4 }, 'use reduce');
    assert.deepEqual(pin.anchor, { kind: 'line', file: 'src/cart.ts', line: 2, side: 'new', last: 4 });
    assert.equal(pinPart(pin, code), 'lines 2–4 of src/cart.ts');
    assert.equal(partQuote(pin, code), 'src/cart.ts:2–4 · “let sum = 0;”');
    assert.match(partAsks(store.getBoard(board.id), 'Claude')!, /asked you to change lines 2–4 \(from "let sum = 0;"\) of the code block "src\/cart\.ts"/);
    assert.throws(() => store.pinComment(code.id, { kind: 'line', file: 'src/cart.ts', line: 4, last: 2 }, 'x', sam), /A range of lines runs down/);
    assert.throws(() => store.pinComment(code.id, { kind: 'line', file: 'src/cart.ts', line: 4, last: 9 }, 'x', sam), /has no line 9/);
    // A line added above: the range moves down with its first line.
    store.updateBlock(code.id, { text: `// The cart's total.\n${CART}` }, claude);
    assert.deepEqual(pinOn(store, task, pin.id).anchor, { kind: 'line', file: 'src/cart.ts', line: 3, side: 'new', last: 5 });
  });

  it("refuses a request on a diff's line, which takes comments only", () => {
    const { store, board } = setUp();
    const diff = store.addBlock({ boardId: board.id }, { content: { type: 'diff', patch: 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n' } }, claude);
    assert.throws(() => store.pinComment(diff.id, { kind: 'line', file: 'x.ts', line: 1 }, '@Claude change it', sam, { ask: true }), (e: unknown) => e instanceof BoardError && e.message === askRefusal());
    assert.equal(store.pinComment(diff.id, { kind: 'line', file: 'x.ts', line: 1 }, 'Looks right.', sam).comment.ask, undefined, 'a comment still pins');
  });

  it("addresses a request on a note's words, to rewrite the note's text", () => {
    const { store, board, task, note } = setUp();
    const { pin, comment } = ask(store, note, { kind: 'text', quote: 'We ship the cart on Friday.' }, 'say Thursday');
    assert.deepEqual([comment.askPart, comment.mentions], ['note', ['Claude']]);
    assert.equal(
      partAsks(store.getBoard(board.id), 'Claude'),
      `Sam asked you to rewrite "We ship the cart on Friday." in the note "Plan" [block id: ${note.id}], on T1's canvas: "@Claude say Thursday". ` +
        `Rewrite the note's text with update_block (block_id: ${note.id}, text: the whole note, in Markdown), then reply in the thread with comment (pin_id: ${pin.id}); people's view of the note reloads by itself.`,
    );
    // Words rewritten past finding: said so, still to answer on the pin.
    store.updateBlock(note.id, { text: 'We ship the cart on Thursday. Payments come later.' }, sam);
    assert.equal(placePin(blockOn(store, task, note.id), pinOn(store, task, pin.id)), null);
    assert.match(partAsks(store.getBoard(board.id), 'Claude')!, /asked you to rewrite "We ship the cart on Friday\." in the note "Plan" .*, which is no longer there as pinned: "@Claude say Thursday"\. Read the block with get_block, then reply in the thread with comment \(pin_id: \w+\)\./);
  });

  it("addresses a request on a diagram's box or arrow, to change its Mermaid source; a box renamed keeps its pin", () => {
    const { store, board, task, diagram } = setUp();
    const node = ask(store, diagram, { kind: 'node', nodeId: 'Retry' }, 'call it Retry later');
    const arrow = ask(store, diagram, { kind: 'arrow', from: 'Client', to: 'Retry' }, 'only on timeouts');
    assert.deepEqual([node.comment.askPart, arrow.comment.askPart], ['diagram', 'diagram']);
    const asks = partAsks(store.getBoard(board.id), 'Claude')!.split('\n');
    assert.equal(
      asks[0],
      `Sam asked you to change node "Retry" (id Retry) of the diagram "Flow" [block id: ${diagram.id}], on T1's canvas: "@Claude call it Retry later". ` +
        `Change the diagram's Mermaid source with update_block (block_id: ${diagram.id}, source: the whole source), then reply in the thread with comment (pin_id: ${node.pin.id}); people's view of the diagram reloads by itself.`,
    );
    assert.match(asks[1], /asked you to change arrow "Client → Retry" \(Client --> Retry, text "on fail"\) of the diagram "Flow"/);
    store.updateBlock(diagram.id, { source: FLOW.replace('Retry[Retry]', 'Retry[Retry later]') }, claude);
    assert.deepEqual(placePin(blockOn(store, task, diagram.id), pinOn(store, task, node.pin.id)), { kind: 'node', nodeId: 'Retry' });
    assert.ok(placePin(blockOn(store, task, diagram.id), pinOn(store, task, arrow.pin.id)));
  });

  it('addresses a request on a box drawn on an image, or a spot clicked, to make a new version; the box stays', () => {
    const { store, board, task, image } = setUp();
    const box = ask(store, image, { kind: 'box', x: 0.1, y: 0.2, w: 0.3, h: 0.25 }, 'make the button blue');
    const spot = spotBox({ x: 0.8, y: 0.5 }, { width: 1200, height: 800 });
    const clicked = ask(store, image, { kind: 'box', ...spot }, 'what is this?');
    assert.deepEqual([box.pin.quote, clicked.pin.quote, box.comment.askPart], ['box 1', 'box 2', 'image']);
    const [first] = partAsks(store.getBoard(board.id), 'Claude')!.split('\n');
    assert.equal(
      first,
      `Sam asked you to change box 1 (x 0.1, y 0.2, w 0.3, h 0.25, as fractions of the picture from its top left) on the image "Checkout mock" [block id: ${image.id}], on T1's canvas: "@Claude make the button blue". ` +
        `Make a new version of the picture and send it with update_block (block_id: ${image.id}, image_path or image_base64): the one it replaces stays in the block's history, and boxes stay where they were drawn, ` +
        `then reply in the thread with comment (pin_id: ${box.pin.id}); people's view of the image reloads by itself.`,
    );
    store.updateBlock(image.id, { image: png(1200, 800) }, claude);
    assert.equal(blockOn(store, task, image.id).rev, 2);
    assert.deepEqual(placePin(blockOn(store, task, image.id), pinOn(store, task, box.pin.id)), { kind: 'box', x: 0.1, y: 0.2, w: 0.3, h: 0.25, n: 1 });
  });

  it("lists a session's requests on each piece, and sums them up on the card as it ends", () => {
    const { store, board, task, code, note, diagram, image } = setUp();
    const sessions = new PairingSessions(store);
    const session = sessions.start({ blockId: code.id, part: 'code', person: 'Sam', agent: 'Claude' });
    const first = ask(store, code, { kind: 'line', file: 'src/cart.ts', line: 4 }, 'return early when empty');
    ask(store, code, { kind: 'line', file: 'src/cart.ts', line: 1 }, 'type the items');
    store.commentOnPin(first.pin.id, 'Done: it returns 0 for an empty cart.', claude);
    const asked = (blockId: string) =>
      pairingRequests(store.getTask(task.id).task.canvas.pins, { task: store.getTask(task.id).task }, { ...(session as PairingSession), blockId }).map((r) => r.state);
    assert.deepEqual(asked(code.id), ['done', 'working']);
    assert.equal(sessions.end(session.id, 'Sam')?.summary, 'Paired under a minute with Claude on the code "src/cart.ts": 2 requests, 1 done, 1 open.');
    for (const [block, part] of [
      [note, 'note'],
      [diagram, 'diagram'],
      [image, 'image'],
    ] as const) {
      const again = sessions.start({ blockId: block.id, part, person: 'Sam', agent: 'Claude' });
      assert.equal(sessions.end(again.id, 'Sam')?.summary, `Paired under a minute with Claude on the ${part} "${block.title}": no requests.`);
    }
    assert.ok(store.getBoard(board.id));
    sessions.stop();
  });
});

describe('Pointing at a part, in the full view', () => {
  it("takes the sentence under a click in a note's text", () => {
    const text = 'We ship the cart on Friday. Payments come later! Is that right?\nA heading\n\nLast one…';
    const at = (offset: number) => {
      const found = sentenceAt(text, offset);
      return found && text.slice(found.start, found.end);
    };
    assert.equal(at(3), 'We ship the cart on Friday.');
    assert.equal(at(27), 'We ship the cart on Friday.', 'just after its full stop');
    assert.equal(at(30), 'Payments come later!');
    assert.equal(at(55), 'Is that right?');
    assert.equal(at(text.indexOf('heading')), 'A heading', 'a line break ends one');
    assert.equal(at(text.indexOf('\n\n') + 1), null, 'a blank line has no words');
    assert.equal(at(text.length), 'Last one…');
  });

  it('takes a drag over code lines either way, and a click as one line', () => {
    assert.deepEqual(lineSpan(9, 4), { line: 4, last: 9 });
    assert.deepEqual(lineSpan(4, 9), { line: 4, last: 9 });
    assert.deepEqual(lineSpan(7, 7), { line: 7 });
  });

  it('draws a box on a picture, and takes a click as a small box round the spot, inside the picture', () => {
    assert.deepEqual(boxBetween({ x: 0.6, y: 0.7 }, { x: 0.2, y: 1.3 }), { x: 0.2, y: 0.7, w: 0.4, h: 0.3 });
    const spot = spotBox({ x: 0.5, y: 0.5 }, { width: 1000, height: 500 });
    assert.deepEqual(spot, { x: 0.485, y: 0.47, w: 0.03, h: 0.06 }, 'square on screen: 30 pixels each way');
    const edge = spotBox({ x: 1, y: 0 }, { width: 1000, height: 500 });
    assert.ok(edge.x + edge.w <= 1 && edge.y >= 0, 'kept inside');
    assert.equal(isClick({ x: 0, y: 0, w: 0.004, h: 0.2 }, { width: 1000, height: 500 }), true);
    assert.equal(isClick({ x: 0, y: 0, w: 0.1, h: 0.2 }, { width: 1000, height: 500 }), false);
  });

  it('opens a prompt under its part, or above it where there is no room, inside the stage', () => {
    const size = { width: 340, height: 230 };
    assert.deepEqual(placeBy({ x: 40, y: 100, w: 200, h: 20 }, { w: 1000, h: 800 }, size), { left: 40, top: 130, above: false });
    assert.deepEqual(placeBy({ x: 900, y: 700, w: 60, h: 20 }, { w: 1000, h: 800 }, size), { left: 648, top: 690, above: true });
    assert.deepEqual(placeBy({ x: 40, y: 300, w: 60, h: 20 }, { w: 1000, h: 600 }, { width: 340, height: 420 }), { left: 110, top: 168, above: false }, 'no room under or over: beside it');
    assert.deepEqual(placeBy({ x: 20, y: 300, w: 960, h: 20 }, { w: 1000, h: 600 }, { width: 340, height: 420 }), { left: 20, top: 432, above: true }, 'nor beside: on the side with more room, inside the stage');
    assert.deepEqual(placeBy({ x: 40, y: -400, w: 60, h: 20 }, { w: 1000, h: 600 }, size), { left: 40, top: 12, above: false }, 'its part scrolled away: at the top');
    assert.deepEqual(unionRect([{ x: 10, y: 20, w: 100, h: 18 }, { x: 10, y: 38, w: 140, h: 18 }]), { x: 10, y: 20, w: 140, h: 36 });
    assert.equal(unionRect([]), null);
  });
});

describe('Pairing on a code block over the app', () => {
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

  it('puts a request on a range of lines straight to the agent, which changes the block with update_block and replies on the pin', async () => {
    const { board, code, task } = ctx;
    const started = await rest('/pairing', { actor: 'Sam', blockId: code.id, part: 'code', agent: 'Claude' });
    assert.equal(started.status, 201);
    const session = started.json as PairingSession;
    const cursor = ctx.store.getBoard(board.id).seq;
    const waiting = call('wait_for_updates', { board_id: board.id, since: cursor, timeout_seconds: 30 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sent = Date.now();
    const asked = await rest(`/canvas/blocks/${code.id}/pins/comment`, {
      actor: 'Sam',
      part: { kind: 'line', file: 'src/cart.ts', line: 2, side: 'new', last: 3 },
      body: addressTo('use reduce', session.agent, AGENTS),
      ask: true,
    });
    assert.equal(asked.status, 201);
    const pin = asked.json.pin as Pin;
    const heard = await waiting;
    assert.ok(Date.now() - sent < 1500, `woke in ${Date.now() - sent} ms`);
    assert.ok(
      heard.includes(`Sam (human) asked you on T1 [task id: ${task.id}]: "use reduce". Change the code block's text with update_block (and the file it shows, if it is in your repository), then reply with comment(pin_id: ${pin.id}).`),
      heard,
    );
    assert.ok(heard.includes(`asked you to change lines 2–3 (from "let sum = 0;") of the code block "src/cart.ts" [block id: ${code.id}]`), heard);
    assert.ok(heard.includes('Sam is pairing with you on the code "src/cart.ts"'), 'the session is named with it');

    const reduced = CART.replace('  let sum = 0;\n  for (const item of items) sum += item.price;\n  return sum;', '  return items.reduce((sum, item) => sum + item.price, 0);');
    const rev = ctx.store.getTask(task.id).task.canvas.blocks.find((b) => b.id === code.id)!.rev;
    assert.match(await call('update_block', { block_id: code.id, rev, text: reduced }), /^Updated code "src\/cart\.ts" \[id: \w+\] \(now rev 2\)/);
    await call('comment', { pin_id: pin.id, body: 'Done: one reduce.' });
    const now = ctx.store.getTask(task.id).task.canvas.pins.find((p) => p.id === pin.id)!;
    assert.equal(placePin(ctx.store.getTask(task.id).task.canvas.blocks.find((b) => b.id === code.id)!, now), null, 'the lines it changed are no longer there as pinned: the view lists them apart');
    const ended = await rest(`/pairing/${session.id}/end`, { actor: 'Sam' });
    assert.equal(ended.json.summary, 'Paired under a minute with Claude on the code "src/cart.ts": 1 request, 1 done, 0 open.');
    assert.equal(partAsks(ctx.store.getBoard(board.id), 'Claude'), undefined, 'answered: no longer waiting');
  });
});
