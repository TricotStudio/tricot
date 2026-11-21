import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { useBoardCards } from '../src/core/cards';
import { roleRule, ruleKeyOf, subagentWords } from '../src/core/agentRules';
import { commentsForYou } from '../src/core/bell';
import { concernsAgent } from '../src/core/concerns';
import { CLOSE_AFTER_DELETE_MS, launchesOn } from '../src/core/roles';
import { Presence } from '../src/server/presence';
import { heldBy } from '../src/server/wakes';
import { Steps, type StepInput } from '../src/server/steps';
import { Store } from '../src/core/store';
import { boardKey, type Actor, type Thread } from '../src/core/types';
import { askableCards } from './madeUpAsked';
import { removeScratch } from './platform';
import { threadsServer, type ThreadsServer, type ToolResult } from './threadsServer';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

// The kinds of card these tests' boards hold, as a part registers them (core/cards.ts): made up, as nothing here is a part's.
before(() => {
  useBoardCards(askableCards());
});

// Two agents and a person talking in threads, over MCP and REST.
describe('Threads over MCP and REST', () => {
  let server: ThreadsServer;
  let store: Store;
  const { callText, request } = {
    callText: (...args: Parameters<ThreadsServer['callText']>) => server.callText(...args),
    request: (...args: Parameters<ThreadsServer['request']>) => server.request(...args),
  };

  before(async () => {
    server = await threadsServer();
    store = server.store;
  });

  after(async () => {
    await server.stop();
  });

  it('lets a person start a thread over REST and an agent hear it, read it and reply', async () => {
    const boardId = (await request('POST', '/boards', { actor: 'Sam', title: 'Desktop app' })).json.id as string;
    await callText('Claude', 'get_board', { board_id: boardId });
    const since = store.getBoard(boardId).seq;
    const started = await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: 'Can we bundle Pi in the app?' });
    assert.equal(started.status, 201);
    const threadId = started.json.id as string;
    assert.equal(started.json.title, 'Can we bundle Pi in the app?');

    const heard = await callText('Claude', 'wait_for_updates', { board_id: boardId, since, timeout_seconds: 1 });
    const anyAgent = `For any agent: the first to reply answers, with reply_in_thread(thread_id: ${threadId}).`;
    assert.ok(heard.includes(`Sam (human) started thread "Can we bundle Pi in the app?" [thread id: ${threadId}]: "Can we bundle Pi in the app?". ${anyAgent}`), heard);
    assert.ok(!heard.includes('Sam wrote in thread'), 'what waits on an agent leaves out what the update above gave');

    const read = await callText('Claude', 'get_thread', { thread_id: threadId });
    assert.match(read, new RegExp(`^# Thread "Can we bundle Pi in the app\\?" \\[thread id: ${threadId}\\]\\nStarted by Sam \\(human\\)`));
    assert.match(read, /It waits on an agent: the first to reply answers, with reply_in_thread/);
    assert.match(read, /## Messages \(1\)\n- Sam \(human\) at \S+ \[message id: \w+\]: Can we bundle Pi in the app\?/);

    const replied = await callText('Claude', 'reply_in_thread', { thread_id: threadId, body: 'Yes: Pi is MIT. Logins are the catch; posted #1.' });
    assert.match(replied, /^Replied in thread "Can we bundle Pi in the app\?" \(2 messages\)\. People see it in the thread\./);
    assert.doesNotMatch(await callText('Codex', 'get_board', { board_id: boardId }), /Sam wrote in thread/, 'answered by the first to reply');

    const listed = await request('GET', `/boards/${boardId}/threads`);
    assert.equal(listed.json.length, 1);
    const got = await request('GET', `/threads/${threadId}`);
    assert.deepEqual(got.json.messages.map((m: { author: Actor }) => m.author.name), ['Sam', 'Claude']);
    const posted = await request('POST', `/threads/${threadId}/messages`, { actor: 'Sam', body: '@Codex can you check the licence too?' });
    assert.equal(posted.status, 200);
    assert.deepEqual(posted.json.messages.at(-1).mentions, ['Codex']);
    assert.equal((await request('GET', '/threads/nope')).status, 404);
    assert.equal((await request('POST', '/threads/nope/messages', { actor: 'Sam', body: 'Hi' })).status, 404);
    assert.equal((await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: ' ' })).status, 400);
  });

  // core/roles.ts: the coordinator takes the chat bar's threads and sends work on; the thread's owner hears what is said
  // there, says where its work stands, and the coordinator hears when it is done.
  it("lets a coordinator take the chat bar's threads and send work on to a thread an orchestrator owns", async () => {
    const boardId = (await request('POST', '/boards', { actor: 'Sam', title: 'Shop' })).json.id as string;
    const said = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as ToolResult;
      assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
      return result.content.map((c) => c.text).join('\n');
    };
    const coordinator = await server.connect('agent=Router&role=coordinator');
    await said(coordinator, 'get_board', { board_id: boardId });
    await callText('Claude', 'get_board', { board_id: boardId });
    const asked = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: 'Fix sign-in on mobile.', door: 'canvas' })).json as Thread;
    assert.equal(asked.owner, 'Router', "a thread a person starts from a chat bar is the coordinator's");
    const named = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: '@Claude what is this page?', door: 'canvas' })).json as Thread;
    assert.equal(named.owner, undefined, 'one that @-mentions an agent is for that agent');
    // Each agent Tricot starts coordinates: one @-mentioned takes the thread, and one that mentions none goes to the one seen last.
    const second = await server.connect('agent=Cody&role=coordinator');
    await said(second, 'get_board', { board_id: boardId });
    const toCody = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: '@Cody shorten the welcome email.', door: 'canvas' })).json as Thread;
    assert.equal(toCody.owner, 'Cody');
    await said(coordinator, 'get_board', { board_id: boardId });
    const toLast = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: 'Rename the board.', door: 'canvas' })).json as Thread;
    assert.equal(toLast.owner, 'Router', 'the coordinator seen last');

    const message = asked.messages[0].id;
    const started = await said(coordinator, 'route_to_thread', { thread_id: asked.id, message_id: message, title: 'Sign-in on mobile', brief: 'The button hides under the keyboard.', agent: 'claude' });
    const work = store.getBoard(boardId).threads!.find((t) => t.title === 'Sign-in on mobile')!;
    assert.deepEqual([work.owner, work.status, work.launch], ['Claude · Sign-in on mobile', 'working', 'claude']);
    assert.match(started, /^Started thread "Sign-in on mobile" \[thread id: \S+\] for Claude · Sign-in on mobile, whom Tricot starts/);
    assert.equal(work.messages[0].body, 'Sam asked in "Fix sign-in on mobile.":\n\n> Fix sign-in on mobile.\n\nThe button hides under the keyboard.');
    assert.deepEqual(store.getThread(asked.id).thread.messages.at(-1)!.sent, { threadId: work.id, messageId: message }, 'where it was asked, the coordinator says where it went');
    assert.deepEqual(launchesOn(store.getBoard(boardId), () => false), [{ thread: work.id, title: work.title, name: work.owner, agent: 'claude' }]);
    assert.deepEqual(launchesOn(store.getBoard(boardId), (name) => name === work.owner), [], 'none while its owner is on the board');
    // The board asks a terminal holding a coordinator of the owner's kind, and no other, to start it (server/wakes.ts):
    // Router is a Claude in one terminal, Cody a Codex in another; a terminal that holds no coordinator starts none.
    const presence = new Presence(() => {});
    const key = boardKey(store.getBoard(boardId));
    presence.started('Router', { tool: 'claude', role: { kind: 'coordinator' } });
    presence.started('Cody', { tool: 'codex', role: { kind: 'coordinator' } });
    presence.seen(key, 'Router');
    presence.seen(key, 'Cody');
    const holding = (holder: string, name: string) => heldBy(store, presence, store.getBoard(boardId), holder, [{ name, asleep: true, at: Date.now() }], []);
    assert.deepEqual(holding('terminal-one', 'Router').launches?.map((l) => l.name), [work.owner], "the Claude coordinator's terminal starts a Claude owner");
    assert.equal(holding('terminal-two', 'Cody').launches, undefined, "the Codex coordinator's terminal leaves it alone");
    assert.equal(holding('terminal-three', 'Claude').launches, undefined, 'a terminal that holds no coordinator starts none');
    presence.close();
    const twice = (await coordinator.callTool({ name: 'route_to_thread', arguments: { thread_id: asked.id, message_id: message, to_thread_id: named.id } })) as ToolResult;
    assert.match(twice.content[0].text, /was sent on already, to thread "Sign-in on mobile"/);

    // Its owner hears a person's plain message there, and another agent's; no one else does.
    const owner = await server.connect(`agent=${encodeURIComponent(work.owner!)}&role=orchestrator&thread=${work.id}`);
    await said(owner, 'get_thread', { thread_id: work.id });
    const latest = () => store.eventsSince(boardId, store.getBoard(boardId).seq - 1).at(-1)!;
    await request('POST', `/threads/${work.id}/messages`, { actor: 'Sam', body: 'Tablets too.' });
    const reply = latest();
    assert.equal(concernsAgent(reply, store.getBoard(boardId), work.owner!), true);
    assert.equal(concernsAgent(reply, store.getBoard(boardId), 'Codex'), false);

    await said(owner, 'set_thread_status', { status: 'needs-you', summary: 'Which tablets?' });
    assert.equal(store.getThread(work.id).thread.status, 'needs-you');
    await request('POST', `/threads/${work.id}/messages`, { actor: 'Sam', body: 'iPads.' });
    assert.equal(store.getThread(work.id).thread.status, 'working', "a person's reply sets it back to work");
    await said(owner, 'set_thread_status', { status: 'done', summary: 'Fixed on phones and iPads.' });
    assert.equal(concernsAgent(latest(), store.getBoard(boardId), 'Router'), true, 'the coordinator hears it is done');
    assert.equal(concernsAgent(latest(), store.getBoard(boardId), 'Codex'), false);
    assert.throws(() => store.setThreadStatus(work.id, 'working', { kind: 'agent', name: 'Codex' }), /only its owner says where its work stands/);

    // The terminal holding the owner hears where its thread stands, and, once the thread is deleted and its undo is past,
    // to close it (server/wakes.ts): never before, so an Undo finds it there.
    const tending = new Presence(() => {});
    tending.started(work.owner!, { tool: 'claude', role: { kind: 'orchestrator', thread: work.id } });
    const owners = (at: number) => heldBy(store, tending, store.getBoard(boardId), 'terminal-one', [{ name: work.owner!, asleep: true, at: Date.now() }], [], at);
    assert.deepEqual([owners(Date.now()).owners, owners(Date.now()).closes], [[{ name: work.owner, status: 'done' }], undefined]);
    store.removeItem(work.id, { kind: 'human', name: 'Sam' });
    assert.equal(owners(Date.now()).closes, undefined, 'not while its undo is still offered');
    assert.deepEqual(owners(Date.now() + CLOSE_AFTER_DELETE_MS).closes, [work.owner], 'closed once its undo is past');
    tending.close();
  });
});

// What the bell lists besides threads (core/bell.ts): a reply to a person's comment, but not one that @-mentions other people.
// core/agentWork.ts, the peek: what an agent session is working on, kept beside its steps and past them, and what the
// step route takes of it.
describe('What an agent is working on', () => {
  let server: ThreadsServer;
  before(async () => {
    server = await threadsServer();
  });
  after(async () => {
    await server.stop();
  });

  it('keeps its plan, the files it and its helpers changed this turn, and its last steps, and starts a turn with no file', async () => {
    const { store, request } = server;
    const boardId = (await request('POST', '/boards', { actor: 'Sam', title: 'Peek' })).json.id as string;
    const thread = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: 'Keep the button above the keyboard.' })).json as Thread;
    const steps = new Steps(store, undefined);
    try {
      let at = Date.now();
      const step = (input: StepInput) => steps.record('Claude', { session: 's1', thread: thread.id, at: (at += 10), ...input });
      step({ text: 'Updating its to-do list', tool: 'c1', plan: { set: [{ text: 'Find it', status: 'done' }, { text: 'Fix it', status: 'now' }] } });
      step({ text: 'Editing src/a.ts', worker: 'w1', role: 'Explore', files: ['src/a.ts'] });
      step({ text: 'Updating its to-do list', tool: 'c2', plan: { add: 'Test it' } });
      step({ text: 'Updating its to-do list', tool: 'c3', plan: { update: { id: '2', status: 'done' } } });
      step({ text: 'Running npm test', running: true, tool: 't1' });
      step({ text: 'Ran npm test', ended: true, tool: 't1', ms: 4100 });

      const [work] = steps.work(boardKey(store.getBoard(boardId)));
      assert.equal(work.agent, 'Claude');
      assert.equal(work.thread, thread.id);
      assert.deepEqual(work.plan, [{ text: 'Find it', status: 'done' }, { text: 'Fix it', status: 'done' }, { text: 'Test it', status: 'next' }], 'whole, an item added, an item checked off: none lost in a row');
      assert.deepEqual(work.files, ['src/a.ts'], "a helper's file is its session's");
      assert.deepEqual(work.trail.map((t) => [t.text, t.role, t.ms]).slice(-2), [['Updating its to-do list', undefined, undefined], ['Ran npm test', undefined, 4100]], "a step that lasted shows its end in its start's place");
      assert.ok(work.trail.some((t) => t.role === 'Explore'));

      step({ text: 'Finished its turn', done: true });
      step({ text: 'Reading src/b.ts' });
      const [next] = steps.work(boardKey(store.getBoard(boardId)));
      assert.deepEqual(next.files, [], 'a new turn has changed no file yet');
      assert.equal(next.plan?.length, 3, 'its plan stays');
    } finally {
      steps.close();
    }
  });

  it('takes a plan and files with a step, and refuses a list longer than it keeps', async () => {
    const { request } = server;
    const boardId = (await request('POST', '/boards', { actor: 'Sam', title: 'Peek route' })).json.id as string;
    const thread = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: 'Hello.' })).json as Thread;
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `Item ${i + 1}`, status: 'next' }));
    const sent = await request('POST', '/agents/Claude/steps', { text: 'Updating its to-do list', session: 's9', thread: thread.id, plan: { set: items(30) }, files: ['a.ts'] });
    assert.equal(sent.status, 201);
    const refused = await request('POST', '/agents/Claude/steps', { text: 'Updating its to-do list', session: 's9', thread: thread.id, plan: { set: items(31) } });
    assert.equal(refused.status, 400);
  });
});

// core/agentRules.ts: a role's model, set beside the agent's own, over it for those Tricot starts and told to an
// orchestrator for the subagents it runs.
describe('The model of each role', () => {
  it("starts a coordinator and an orchestrator on their role's rule over the agent's, and tells its scouts' and workers'", () => {
    assert.deepEqual(ruleKeyOf('claude:coordinator'), { agent: 'claude', role: 'coordinator' });
    assert.deepEqual(ruleKeyOf('claude'), { agent: 'claude' });
    assert.equal(ruleKeyOf('claude:chef'), undefined);
    const rules = { claude: { model: 'opus', effort: 'high' }, 'claude:orchestrator': { model: 'sonnet' }, 'claude:scout': { model: 'haiku' } };
    assert.deepEqual(roleRule(rules, 'claude', 'coordinator'), { model: 'opus', effort: 'high' }, "none set: the agent's own");
    assert.deepEqual(roleRule(rules, 'claude', 'orchestrator'), { model: 'sonnet', effort: 'high' }, 'its own over the agent\'s, one value at a time');
    assert.deepEqual(roleRule(rules, 'claude', 'worker'), {}, "a subagent's none set: the orchestrator's choice");
    assert.equal(subagentWords(rules, 'claude'), 'The person asks you to run your scouts on haiku: start each subagent so.');
    assert.equal(subagentWords({ claude: { model: 'opus' } }, 'claude'), undefined);
  });
});

describe("The bell's comments", () => {
  it("lists a reply to the viewer's comment and a mention of them, and leaves out a reply that @-mentions someone else", () => {
    const sam: Actor = { kind: 'human', name: 'Sam' };
    const pat: Actor = { kind: 'human', name: 'Pat' };
    const claude: Actor = { kind: 'agent', name: 'Claude' };
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-bell-'));
    const store = new Store(dir);
    try {
      store.load();
      const board = store.createBoard({ title: 'Shop', goal: 'Cards' }, sam);
      store.addPage(board.id, 'Checkout', pat);
      const page = store.getBoard(board.id).pages![0];
      const block = store.addBlock({ pageId: page.id }, { title: 'Steps', content: { type: 'note', text: 'Cart, address, pay.' } }, sam);
      const { pin } = store.pinComment(block.id, { kind: 'text', quote: 'address' }, 'Which address?', sam);
      const listed = (...bodies: string[]) => {
        const since = store.getBoard(board.id).seq;
        for (const body of bodies) store.commentOnPin(pin.id, body, claude);
        const now = store.getBoard(board.id);
        return commentsForYou(now, store.events(board.id, { since }).reverse(), 'Sam', {}).map((c) => `${c.why}: ${c.said.body}`);
      };
      assert.deepEqual(listed('@Pat can you answer this?'), []);
      assert.deepEqual(listed('The billing one.'), ['reply: The billing one.']);
      assert.deepEqual(listed('@Sam and @Pat, the billing one.'), ['mention: @Sam and @Pat, the billing one.']);
    } finally {
      removeScratch(dir);
    }
  });
});
