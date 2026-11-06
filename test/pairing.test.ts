import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { deliveryOf, type StepNow } from '../src/core/delivery';
import { eventsDigest } from '../src/core/digest';
import { addressTo, asksBack, pairingLine, pairingRequests, pairingSummary, pinLineWords, PAIRING_GONE_MS, PAIRING_IDLE_MS, type PairingSession } from '../src/core/pairing';
import { pinComments } from '../src/core/pins';
import { BoardError, Store } from '../src/core/store';
import type { Actor, Block, Board, Comment, Pin, Task } from '../src/core/types';
import { createApp } from '../src/server/app';
import { PairingSessions } from '../src/server/pairing';
import { removeScratch } from './platform';

// Pairing with an agent on a piece in its full view (core/pairing.ts): what
// it is told, how what a person asks there reaches it, the agent's steps on
// the pin, the session's list, and the summary it leaves on the card.

const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tricot-pairing-')));
const home = path.join(scratch, 'home');
const siteFolder = path.join(home, 'projects', 'site');
mkdirSync(siteFolder, { recursive: true });
writeFileSync(path.join(siteFolder, 'index.html'), '<!doctype html><title>Home</title><h1 id="hero">Hello</h1>');
process.env.HOME = home;
process.env.USERPROFILE = home; // the home folder on Windows (os.homedir())
after(() => removeScratch(scratch));

const sam: Actor = { kind: 'human', name: 'Sam' };
const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };
const hero = { kind: 'site' as const, page: '/', selector: '#hero', tag: 'h1', text: 'One shared layer for you and your agents.', file: 'index.html' };
const lead = { kind: 'site' as const, page: '/', selector: 'body > main > p:nth-of-type(1)', tag: 'p', text: 'Plan with your agents.' };
const MIN = 60_000;

// A board where Claude and Codex have worked, with a task whose canvas holds a website.
function setUp() {
  const store = new Store(mkdtempSync(path.join(scratch, 'data-')));
  store.load();
  const board = store.createBoard({ title: 'Launch' }, sam);
  const [task] = store.planTasks(board.id, [{ title: 'Tighten the landing page' }], sam, { ready: true });
  store.addTaskComment(task.id, 'On it.', claude);
  store.addTaskComment(task.id, 'I can review.', codex);
  const site = store.addBlock({ taskId: task.id }, { content: { type: 'site', folder: siteFolder }, title: 'Tricot site' }, sam) as Extract<Block, { type: 'site' }>;
  return { store, board, task, site };
}

describe('Pairing, in words', () => {
  it('addresses a request to the agent paired with, unless it names an agent already', () => {
    const agents = ['Claude', 'Codex'];
    assert.equal(addressTo('make the heading shorter', 'Claude', agents), '@Claude make the heading shorter');
    assert.equal(addressTo('  make it shorter', 'Claude', agents), '@Claude make it shorter');
    assert.equal(addressTo('@Codex can you check the copy?', 'Claude', agents), '@Codex can you check the copy?', 'pointed elsewhere on purpose');
    assert.equal(addressTo('ask @Sam about it', 'Claude', agents), '@Claude ask @Sam about it', 'a person named is still asked through the agent');
    assert.equal(addressTo('me@example.com is the contact', 'Claude', agents), '@Claude me@example.com is the contact');
  });

  it('sums a session up, and tells the agent paired with what it means', () => {
    const startedAt = '2026-11-03T10:00:00.000Z';
    const states = [{ state: 'done' }, { state: 'done' }, { state: 'waiting' }, { state: 'done' }, { state: 'done' }] as const;
    assert.equal(
      pairingSummary({ agent: 'Claude', piece: 'website "Tricot site"', startedAt, endedAt: Date.parse(startedAt) + 12 * MIN + 10_000, requests: [...states] }),
      'Paired 12 min with Claude on the website "Tricot site": 5 requests, 4 done, 1 open.',
    );
    assert.equal(
      pairingSummary({ agent: 'Codex', piece: 'the Google Doc', startedAt, endedAt: Date.parse(startedAt) + 20_000, requests: [] }),
      'Paired under a minute with Codex on the Google Doc: no requests.',
    );
    assert.equal(
      pairingLine({ person: 'Wassim', blockId: 'b1' }, 'website "Tricot site"', "T135's canvas"),
      `Wassim is pairing with you on the website "Tricot site" (T135's canvas) [block id: b1]: their requests there come straight to you, as @-mentions. Act on each as it comes, then reply on its pin after the change; they watch your steps on the pin while you work.`,
    );
  });

  it('knows a reply that asks the person something back', () => {
    assert.equal(asksBack({ body: 'Shortened it to six words.' }, 'Sam'), false);
    assert.equal(asksBack({ body: 'Done. Should the subtitle go too?' }, 'Sam'), true);
    assert.equal(asksBack({ body: 'Which colour, @Sam: blue or ink?”', mentions: ['Sam'] }, 'Sam'), true);
  });
});

describe("A session's requests", () => {
  it('are what the person asked the agent on the piece since it started, one per pin, with where each stands', () => {
    const { store, board, task, site } = setUp();
    const before = store.pinComment(site.id, lead, '@Claude an older request', sam, { ask: true });
    const session: PairingSession = { id: 's1', blockId: site.id, board: board.id, part: 'site', person: 'Sam', agent: 'Claude', startedAt: new Date(Date.now() + 1000 * 5).toISOString() };
    const requests = (t: Task) => pairingRequests(store.getBoard(board.id).tasks.find((x) => x.id === t.id)!.canvas.pins, { task: store.getTask(t.id).task }, session);
    assert.deepEqual(requests(task), [], 'nothing asked since it started');

    // Asked a moment later, in the session.
    const later = (ms: number) => new Date(Date.parse(session.startedAt) + ms).toISOString();
    const at = (comment: Comment, ms: number) => (comment.createdAt = later(ms));
    const first = store.pinComment(site.id, hero, '@Claude make it shorter', sam, { ask: true });
    at(first.comment, 1000);
    const note = store.pinComment(site.id, { ...hero, selector: '#cta', tag: 'a', text: 'Start' }, 'Nice button.', sam);
    at(note.comment, 2000);
    const second = store.pinComment(site.id, lead, '@Claude and this one punchier', sam, { ask: true });
    at(second.comment, 3000);
    assert.equal(second.pin.id, before.pin.id, 'the same element keeps its thread');
    let list = requests(task);
    assert.deepEqual(
      list.map((r) => [r.pin.id, r.asked.body, r.state]),
      [
        [first.pin.id, '@Claude make it shorter', 'working'],
        [second.pin.id, '@Claude and this one punchier', 'working'],
      ],
      'a note is no request, and what was asked before the session is not in it',
    );

    at(store.commentOnPin(first.pin.id, 'Shortened it in index.html.', claude).comment, 4000);
    at(store.commentOnPin(second.pin.id, 'Done: "Plan with agents." Should the subtitle go too?', claude).comment, 5000);
    list = requests(task);
    assert.deepEqual(list.map((r) => r.state), ['done', 'waiting']);
    assert.equal(list[0].reply?.body, 'Shortened it in index.html.');

    at(store.commentOnPin(second.pin.id, '@Claude yes, drop it', sam).comment, 6000);
    assert.deepEqual(
      requests(task).map((r) => [r.state, r.latest.body]),
      [
        ['done', '@Claude make it shorter'],
        ['working', '@Claude yes, drop it'],
      ],
      'a follow-up puts it back with the agent',
    );
  });
});

describe('Live steps on the pin', () => {
  const board = (task: Task): Board => ({ activity: { actors: [{ actor: claude, at: new Date().toISOString() }] }, tasks: [task], decisions: [] }) as unknown as Board;
  const asked: Comment = { id: 'c1', author: sam, body: '@Claude make it shorter', createdAt: new Date(Date.now() - 20_000).toISOString(), ask: true, mentions: ['Claude'] };
  const task = { id: 't1', number: 135, comments: [asked], status: 'in_progress' } as unknown as Task;
  const said = { id: asked.id, author: asked.author, at: asked.createdAt, mentions: asked.mentions };
  const agents = [{ name: 'Claude', state: 'working' as const, lastSeen: new Date().toISOString() }];
  const step = (text: string, more: Partial<StepNow> = {}): StepNow => ({ agent: 'Claude', text, at: new Date(Date.now() - 2_000).toISOString(), ...more });

  it("shows the agent's latest step under the request while it is on this card, and nothing once it replied", () => {
    const working = deliveryOf({ board: board(task), where: { task }, said, after: [], agents, steps: [step('Editing index.html', { card: { kind: 'task', id: 't1' } })] })!;
    assert.equal(pinLineWords(working, Date.now()), 'Claude is on it · Editing index.html');
    const elsewhere = deliveryOf({ board: board(task), where: { task }, said, after: [], agents, steps: [step('Editing index.html', { card: { kind: 'task', id: 'other' } })] })!;
    assert.notEqual(elsewhere.state, 'working', "a step on another card isn't this request's");
    const before = deliveryOf({ board: board(task), where: { task }, said, after: [], agents, steps: [step('Reading README.md', { card: { kind: 'task', id: 't1' }, at: new Date(Date.now() - 60_000).toISOString() })] })!;
    assert.notEqual(before.state, 'working', 'a step from before the request is not about it');
    const replied = deliveryOf({ board: board(task), where: { task }, said, after: [{ author: claude }], agents, steps: [step('Editing index.html', { card: { kind: 'task', id: 't1' } })] })!;
    assert.equal(pinLineWords(replied, Date.now()), undefined);
  });

  it('falls back to where the request stands when there are no steps', () => {
    const seen = deliveryOf({ board: board(task), where: { task }, said: { ...said, reactions: [{ emoji: '👀', by: claude, at: new Date().toISOString() }] }, after: [], agents, steps: [] })!;
    assert.equal(pinLineWords(seen, Date.now()), 'Seen by Claude');
    const listening = deliveryOf({ board: board(task), where: { task }, said, after: [], agents: [{ ...agents[0], state: 'listening' }], steps: [] })!;
    assert.equal(pinLineWords(listening, Date.now()), 'Delivered · Claude is listening');
  });

  it('on the board context, takes a step on no card as here', () => {
    const where = { boardContext: true as const };
    const here = deliveryOf({ board: board(task), where, said, after: [], agents, steps: [step('Editing index.html')] })!;
    assert.equal(pinLineWords(here, Date.now()), 'Claude is on it · Editing index.html');
    const onCard = deliveryOf({ board: board(task), where, said, after: [], agents, steps: [step('Editing index.html', { card: { kind: 'task', id: 't1' } })] })!;
    assert.notEqual(onCard.state, 'working');
  });
});

describe('Pairing sessions', () => {
  it('tell the agent paired with as one starts, and while it lasts; no other agent', () => {
    const { store, board, site } = setUp();
    const sessions = new PairingSessions(store);
    const session = sessions.start({ blockId: site.id, part: 'site', person: 'Sam', agent: 'Claude' });
    assert.deepEqual([session.blockId, session.board, session.agent, session.person], [site.id, board.id, 'Claude', 'Sam']);
    const [started] = store.events(board.id, { since: 0, order: 'desc', limit: 1 });
    assert.deepEqual([started.type, started.summary, started.forAgent], ['pairing_started', `started pairing with Claude on the website "Tricot site" (T1's canvas)`, 'Claude']);
    assert.equal(store.eventsSince(board.id, started.seq - 1, codex).length, 0, 'not in another agent’s updates');
    const key = store.getBoard(board.id).id;
    assert.deepEqual(sessions.lines(key, 'Claude'), [
      `Sam is pairing with you on the website "Tricot site" (T1's canvas) [block id: ${site.id}]: their requests there come straight to you, as @-mentions. Act on each as it comes, then reply on its pin after the change; they watch your steps on the pin while you work.`,
    ]);
    assert.deepEqual(sessions.lines(key, 'Codex'), []);
    sessions.stop();
  });

  it('leave a summary on the card as one ends: the person’s, for the agent alone, asking nobody', () => {
    const { store, board, task, site } = setUp();
    const sessions = new PairingSessions(store);
    const session = sessions.start({ blockId: site.id, part: 'site', person: 'Sam', agent: 'Claude' });
    const asked = store.pinComment(site.id, hero, '@Claude make it shorter', sam, { ask: true });
    store.commentOnPin(asked.pin.id, 'Shortened it.', claude);
    store.pinComment(site.id, lead, '@Claude this one too', sam, { ask: true });
    assert.equal(sessions.end(session.id, 'Codex'), undefined, 'only the person ends it');
    const { summary } = sessions.end(session.id, 'Sam')!;
    assert.equal(summary, 'Paired under a minute with Claude on the website "Tricot site": 2 requests, 1 done, 1 open.');
    const comment = store.getTask(task.id).task.comments.at(-1)!;
    assert.deepEqual([comment.author, comment.body, comment.paired], [sam, summary, { agent: 'Claude', blockId: site.id }]);
    const [event] = store.events(board.id, { since: 0, order: 'desc', limit: 1 });
    assert.deepEqual([event.type, event.forAgent], ['comment_added', 'Claude']);
    const read = eventsDigest([event], event.seq, { board: store.getBoard(board.id), viewer: 'Claude' });
    assert.ok(read.startsWith(`- (${event.seq}) Sam (human) commented on T1 "Tighten the landing page": "${summary}"`), read);
    assert.doesNotMatch(read, /Reply with/, 'news, not a question');
    assert.deepEqual(sessions.lines(board.id, 'Claude'), [], 'over');
    assert.equal(sessions.end(session.id, 'Sam'), undefined, 'ends once');
    sessions.stop();
  });

  it('that asked nothing end with a line in the activity, and a new one on the same piece ends the last', () => {
    const { store, board, task, site } = setUp();
    const sessions = new PairingSessions(store);
    const first = sessions.start({ blockId: site.id, part: 'site', person: 'Sam', agent: 'Claude' });
    const comments = store.getTask(task.id).task.comments.length;
    const second = sessions.start({ blockId: site.id, part: 'site', person: 'Sam', agent: 'Codex' });
    const [ended, started] = store.events(board.id, { since: 0, order: 'desc', limit: 2 }).reverse();
    assert.deepEqual([ended.type, ended.forAgent], ['pairing_ended', 'Claude']);
    assert.equal(ended.summary, `stopped pairing with Claude on the website "Tricot site" (T1's canvas) after under a minute: no requests`);
    assert.deepEqual([started.type, started.forAgent], ['pairing_started', 'Codex']);
    assert.equal(store.getTask(task.id).task.comments.length, comments, 'no summary for a session that asked nothing');
    assert.equal(sessions.beat(first.id, 'Sam'), undefined);
    assert.equal(sessions.beat(second.id, 'Sam')?.agent, 'Codex');
    sessions.stop();
  });

  it('end once idle, or once the page stops saying it is there', () => {
    const { store, site } = setUp();
    let now = Date.now();
    const sessions = new PairingSessions(store, () => now);
    const idle = sessions.start({ blockId: site.id, part: 'site', person: 'Sam', agent: 'Claude' });
    for (let minute = 0; minute < 31; minute++) {
      now += MIN;
      sessions.beat(idle.id, 'Sam'); // the page is open, but nobody does anything
      sessions.sweep();
    }
    assert.equal(sessions.beat(idle.id, 'Sam'), undefined, `ended after ${PAIRING_IDLE_MS / MIN} min idle`);
    const busy = sessions.start({ blockId: site.id, part: 'site', person: 'Sam', agent: 'Claude' });
    for (let minute = 0; minute < 40; minute++) {
      now += MIN;
      sessions.beat(busy.id, 'Sam', true);
      sessions.sweep();
    }
    assert.ok(sessions.beat(busy.id, 'Sam'), 'a person at it keeps it');
    now += PAIRING_GONE_MS + 1000;
    sessions.sweep();
    assert.equal(sessions.beat(busy.id, 'Sam'), undefined, 'its page went away');
    sessions.stop();
  });

  it('are only on parts that take requests', () => {
    const { store, board } = setUp();
    const note = store.addBlock({ boardId: board.id }, { content: { type: 'note', text: 'Ship it' } }, sam);
    const sessions = new PairingSessions(store);
    assert.throws(() => sessions.start({ blockId: note.id, part: 'site', person: 'Sam', agent: 'Claude' }), (e: unknown) => e instanceof BoardError && /has no parts to pair on/.test(e.message));
    assert.throws(() => sessions.start({ blockId: note.id, part: 'text', person: 'Sam', agent: 'Claude' }), BoardError);
    sessions.stop();
  });
});

describe('Pairing over the app', () => {
  let server: Server;
  let base: string;
  let agent: Client;
  let other: Client;
  let ctx: ReturnType<typeof setUp>;
  const rest = async (route: string, body: object) => {
    const res = await fetch(`${base}/api${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const call = async (client: Client, name: string, args: object) => {
    const result = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as { content: { text: string }[] };
    return result.content.map((c) => c.text).join('\n');
  };

  before(async () => {
    ctx = setUp();
    server = createApp(ctx.store, { host: '127.0.0.1', mcpUrl: 'unused' }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    agent = new Client({ name: 'test', version: '1' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
    other = new Client({ name: 'test', version: '1' });
    await other.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Codex`)));
  });
  after(async () => {
    await agent.close();
    await other.close();
    server.closeAllConnections();
    server.close();
    await ctx.store.flush();
  });

  it('puts the request straight to the agent paired with: its wait wakes at once, and it reads it as asked of it, to answer on the pin', async () => {
    const { board, site } = ctx;
    const started = await rest('/pairing', { actor: 'Sam', blockId: site.id, part: 'site', agent: 'Claude' });
    assert.equal(started.status, 201);
    const session = started.json as PairingSession;
    const boardText = await call(agent, 'get_board', { board_id: board.id });
    assert.ok(boardText.includes(`Sam is pairing with you on the website "Tricot site" (T1's canvas) [block id: ${site.id}]`), boardText);
    assert.ok(!(await call(other, 'get_board', { board_id: board.id })).includes('is pairing with you'));

    const cursor = ctx.store.getBoard(board.id).seq;
    const waiting = call(agent, 'wait_for_updates', { board_id: board.id, since: cursor, timeout_seconds: 30 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sent = Date.now();
    // The page addresses it (core/pairing.ts addressTo) before sending.
    const asked = await rest(`/canvas/blocks/${site.id}/pins/comment`, { actor: 'Sam', part: hero, body: addressTo('make it shorter', session.agent, ['Claude', 'Codex']), ask: true });
    assert.equal(asked.status, 201);
    const heard = await waiting;
    assert.ok(Date.now() - sent < 1500, `woke in ${Date.now() - sent} ms`);
    const pin = asked.json.pin as Pin;
    assert.ok(heard.includes(`Sam (human) asked you on T1 [task id: ${ctx.task.id}]: "make it shorter". Change the site's file, then reply with comment(pin_id: ${pin.id}).`), heard);
    assert.ok(heard.includes(`Sam is pairing with you on the website "Tricot site"`), 'the session is named with it');

    const elsewhere = await call(other, 'get_updates', { board_id: board.id, since: cursor });
    assert.match(elsewhere, /Sam \(human\) asked Claude on T1 \[task id: \w+\]\. Not for you; carry on\./);

    await call(agent, 'comment', { pin_id: pin.id, body: 'Shortened it in index.html.' });
    const task = ctx.store.getTask(ctx.task.id).task;
    assert.equal(pinComments(ctx.store.getBoard(board.id).tasks[0].canvas.pins.find((p) => p.id === pin.id)!, { task }).at(-1)?.body, 'Shortened it in index.html.', 'the reply is on the pin');

    const beat = await rest(`/pairing/${session.id}/beat`, { actor: 'Sam', active: true });
    assert.equal(beat.status, 200);
    const ended = await rest(`/pairing/${session.id}/end`, { actor: 'Sam' });
    assert.equal(ended.json.summary, 'Paired under a minute with Claude on the website "Tricot site": 1 request, 1 done, 0 open.');
    assert.deepEqual((await rest(`/pairing/${session.id}/beat`, { actor: 'Sam' })).json, { error: 'This pairing session has ended.', ended: true });
    assert.ok(!(await call(agent, 'get_board', { board_id: board.id })).includes('is pairing with you'));
  });
});
