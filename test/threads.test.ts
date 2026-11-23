import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { useBoardCards } from '../src/core/cards';
import { atOnce, cleanRule, roleRule, ruleKeyOf, subagentWords } from '../src/core/agentRules';
import { answersForYou, commentsForYou } from '../src/core/bell';
import { batchWords, canvasBatches, canvasHoldings } from '../src/core/canvasBatches';
import { GAP_MS } from '../src/core/agentActivity';
import { conversationWaitingOn, inConversation, threadGroups, threadsWaitingOn, waitsOnYou } from '../src/core/threadList';
import { concernsAgent } from '../src/core/concerns';
import { doorNote } from '../src/core/doors';
import type { Told } from '../src/core/words';
import { CLOSE_AFTER_DELETE_MS, LEAD_WORDS, launchesOn, QUIET_CLOSE_MS } from '../src/core/roles';
import { Leads, leadsFile, RESUME_MS } from '../src/server/leads';
import { Presence, type AgentPresence } from '../src/server/presence';
import { heldBy } from '../src/server/wakes';
import { Steps, type StepInput } from '../src/server/steps';
import { Store } from '../src/core/store';
import { liveAgents, liveWords, reachedByAny } from '../src/core/liveAgents';
import { askedWhileWaiting, homeRelays, homeRows, homeSaid, ownedThreads, relayStack, relayWords, threadTone, verdictWords } from '../src/core/homeConversation';
import { homeStream } from '../src/cli/switcher/homeStream';
import { homeLines, REVIEW_HINT, type Colours } from '../src/cli/switcher/homeView';
import { ThreadsTab } from '../src/cli/switcher/threadsTab';
import { boardKey, type Actor, type BoardEvent, type Thread } from '../src/core/types';
import { askableCards } from './madeUpAsked';
import { removeScratch, WINDOWS } from './platform';
import { threadsServer, type ThreadsServer, type ToolResult } from './threadsServer';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

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

  // An agent shows on the board as what it is, though its address borrowed another agent's name (core/agents/registry.ts
  // sessionAgentName), and a thread a person starts over a page goes to the page's agent only while it is on the board, as
  // the chat bar names it (core/whoAnswers.ts).
  it("names an agent by its own client when its address borrowed another's, and sends a page's thread to who is on the board", async () => {
    const boardId = (await request('POST', '/boards', { actor: 'Sam', title: 'Work laptop' })).json.id as string;
    const pageBy = async (client: Client, title: string) => {
      const made = (await client.callTool({ name: 'add_page', arguments: { board_id: boardId, title } })) as ToolResult;
      return store.getPage(/\[page id: (\w+)\]/.exec(made.content[0].text)![1]).page;
    };
    const omp = { name: 'omp-coding-agent', version: '18.0.0' };
    const page = await pageBy(await server.connect('agent=Claude', omp), 'Sign-up flow');
    assert.equal(page.agent?.name, 'OMP', "OMP through Claude Code's entry shows as OMP");
    assert.equal((await pageBy(await server.connect('agent=Reviewer', omp), 'Review')).agent?.name, 'Reviewer', 'a name of its own is kept');
    const over = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: 'Shorter?', pageId: page.id })).json as Thread;
    assert.equal(over.lens?.agent, 'OMP', "the page's agent, on the board");
    const gone = store.addPage(boardId, 'Old notes', { kind: 'agent', name: 'Gone' });
    const overGone = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: 'Still right?', pageId: gone.id })).json as Thread;
    assert.equal(overGone.lens?.agent, undefined, "not the page's agent once it has gone: an agent on the board takes it");
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
    assert.ok((await said(coordinator, 'get_thread', { thread_id: toLast.id })).includes(`It's yours as the board's coordinator: answer a question here, but send anything that is work on with route_to_thread(thread_id: ${toLast.id})`), "told so of its own quick question");

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

    // What a person asked from a chat bar stays in the board's conversation, and only work has a thread of its own in the
    // list: the status tells them apart, as stored. The list is the conversation as one row, then the work; the threads
    // button counts the work waiting on Sam alone, and the bell says what agents answered him there as one row, at its
    // latest. Nothing an agent reads changes: get_board still lists every thread.
    await said(coordinator, 'reply_in_thread', { thread_id: toLast.id, body: 'Renamed it Shop front.' });
    const now = store.getBoard(boardId);
    const [askedNow, workNow, toLastNow] = [asked, work, toLast].map((t) => now.threads!.find((x) => x.id === t.id)!);
    assert.deepEqual([askedNow, toLastNow, workNow].map(inConversation), [true, true, false]);
    const groups = threadGroups(now, 'Sam', {}, Date.now());
    assert.equal(groups.conversation?.last.body, 'Renamed it Shop front.');
    assert.equal(groups.conversation?.unread, true);
    assert.deepEqual([...groups.waiting, ...groups.recent, ...groups.earlier].map((e) => e.thread.id), [work.id], 'no quick question has a row of its own');
    assert.deepEqual(threadsWaitingOn(now, 'Sam', {}).map((t) => t.id), [work.id], 'an answer in the conversation is not counted');
    assert.equal(waitsOnYou(now, { ...workNow, messages: workNow.messages.slice(0, 1) }, 'Sam', undefined), false, "the coordinator's brief that starts work is for its owner");
    assert.deepEqual(conversationWaitingOn(now, 'Sam', {}).map((t) => t.id), [toLast.id, asked.id]);
    const answer = answersForYou(now, 'Sam', {});
    assert.deepEqual([answer?.thread.id, answer?.said.body, answer?.answered, answer?.count], [toLast.id, 'Renamed it Shop front.', true, 2]);
    assert.equal(answersForYou(now, 'Sam', { [toLast.id]: toLastNow.messages.at(-1)!.id, [asked.id]: askedNow.messages.at(-1)!.id }), undefined, 'seen, it is not new');
    assert.match(await said(coordinator, 'get_board', { board_id: boardId }), /Rename the board/, 'an agent still reads every thread');

    // A person's search finds the threads' messages, each opening where it is: one in the conversation there, one in work
    // in its thread. An agent's search tool finds none: it reads a thread with get_thread.
    const found = async (q: string) => (await request('GET', `/boards/${boardId}/search?q=${q}`)).json.results as { kind: string; ref: string; target: Record<string, unknown> }[];
    const [renamed] = await found('renamed');
    assert.deepEqual([renamed.kind, renamed.ref, renamed.target], ['message', 'Conversation', { threadId: toLast.id, messageId: toLastNow.messages.at(-1)!.id, conversation: true }]);
    const [tablets] = await found('tablets%20too');
    assert.deepEqual([tablets.kind, tablets.ref, tablets.target], ['message', 'Thread', { threadId: work.id, messageId: workNow.messages.find((m) => m.body === 'Tablets too.')!.id }]);
    assert.deepEqual(await found('Sent'), [], "a coordinator's word that it sent an ask on is the card under the ask, not a message");
    assert.match(await said(coordinator, 'search', { board_id: boardId, query: 'tablets' }), /^Nothing found for "tablets"/);
    await request('POST', `/threads/${work.id}/messages`, { actor: 'Sam', body: 'iPads.' });
    assert.equal(store.getThread(work.id).thread.status, 'working', "a person's reply sets it back to work");

    // Finished work that waits on Sam's OK before it is committed is in review (core/roles.ts): a plain reply leaves it
    // there, and his verdict, which approves a commit and so needs a seat, is posted as his own message, for its owner,
    // and sets it back to working. Only work in review takes one.
    const review = `/threads/${work.id}/review`;
    assert.match(await said(owner, 'set_thread_status', { status: 'in-review', summary: 'Fixed on phones and iPads: the diff is on the board.' }), /is waiting for review: the person answers "Looks good, commit it" or "Needs changes"/);
    assert.match(await said(owner, 'get_thread', { thread_id: work.id }), /Its work is waiting for review\. A person answers "Looks good, commit it" or "Needs changes" with a note/, 'its owner is told what comes next');
    await request('POST', `/threads/${work.id}/messages`, { actor: 'Sam', body: 'Does it hold on Android?' });
    assert.equal(store.getThread(work.id).thread.status, 'in-review', 'a plain reply leaves it waiting for review');
    assert.equal((await request('POST', review, { actor: 'Sam', verdict: 'approve' })).status, 403, 'from the page alone, it asks for a seat');
    assert.deepEqual(await server.seated('POST', review, { actor: 'Sam', verdict: 'changes' }), { status: 400, json: { error: 'Say what needs changing in note, so its owner knows.' } });
    const verdictAt = store.getBoard(boardId).seq;
    const sentBack = await server.seated('POST', review, { actor: 'Sam', verdict: 'changes', note: 'The keyboard still covers it on Android.' });
    assert.equal(sentBack.status, 200);
    assert.deepEqual([sentBack.json.status, sentBack.json.messages.at(-1).author, sentBack.json.messages.at(-1).body], ['working', { kind: 'human', name: 'Sam' }, 'Needs changes.\n\nThe keyboard still covers it on Android.']);
    const verdictEvents = store.eventsSince(boardId, verdictAt);
    assert.deepEqual(verdictEvents.map((e) => e.type), ['thread_replied', 'thread_status_changed']);
    assert.equal(concernsAgent(verdictEvents[0], store.getBoard(boardId), work.owner!), true, 'his verdict is for its owner, and wakes it');
    assert.deepEqual(await server.seated('POST', review, { actor: 'Sam', verdict: 'approve' }), { status: 409, json: { error: `Thread "Sign-in on mobile" isn't waiting for a review: its work is at work.` } });
    await said(owner, 'set_thread_status', { status: 'in-review', summary: 'Fixed on Android too.' });
    const approved = await server.seated('POST', review, { actor: 'Sam', verdict: 'approve' });
    assert.deepEqual([approved.json.status, approved.json.messages.at(-1).body], ['working', 'Looks good, commit it.'], 'after his OK, its owner commits it');
    await said(owner, 'set_thread_status', { status: 'done', summary: 'Fixed on phones and iPads.' });
    assert.equal(concernsAgent(latest(), store.getBoard(boardId), 'Router'), true, 'the coordinator hears it is done');
    assert.equal(concernsAgent(latest(), store.getBoard(boardId), 'Codex'), false);
    assert.throws(() => store.setThreadStatus(work.id, 'working', { kind: 'agent', name: 'Codex' }), /only its owner says where its work stands/);

    // The terminal holding the owner hears where its thread stands; once it is done and the owner has slept an hour, to
    // close it, apart from those whose thread was deleted (server/wakes.ts); and, once the thread is deleted and its
    // undo is past, to close it: never before, so an Undo finds it there.
    const tending = new Presence(() => {});
    tending.started(work.owner!, { tool: 'claude', role: { kind: 'orchestrator', thread: work.id } });
    const fellAsleep = Date.now();
    const owners = (now: number, view: { asleep: boolean; at: number; since?: number } = { asleep: true, at: fellAsleep }, board = store.getBoard(boardId)) =>
      heldBy(store, tending, board, 'terminal-one', [{ name: work.owner!, ...view }], [], now);
    const first = owners(Date.now());
    assert.deepEqual([first.owners, first.closes, first.quiet], [[{ name: work.owner, status: 'done' }], undefined, undefined]);
    assert.equal(owners(fellAsleep + QUIET_CLOSE_MS - 1).quiet, undefined, 'not while it has slept less than an hour');
    assert.deepEqual([owners(fellAsleep + QUIET_CLOSE_MS).quiet, owners(fellAsleep + QUIET_CLOSE_MS).closes], [[work.owner], undefined], 'closed once it has slept an hour');
    const done = store.getBoard(boardId);
    const reviewing = { ...done, threads: done.threads!.map((t) => (t.id === work.id ? { ...t, status: 'in-review' as const } : t)) };
    assert.equal(owners(fellAsleep + QUIET_CLOSE_MS, undefined, reviewing).quiet, undefined, 'one whose work waits for review is kept');
    const owed = owners(fellAsleep + 2 * QUIET_CLOSE_MS, { asleep: true, at: fellAsleep + 1, since: verdictAt });
    assert.deepEqual([owed.agents[0].due !== undefined, owed.quiet], [true, undefined], 'nor one with something due, whose wake may have failed');
    assert.equal(owners(fellAsleep + 2 * QUIET_CLOSE_MS, { asleep: false, at: fellAsleep + 2 }).quiet, undefined, 'nor one at work on something');
    store.removeItem(work.id, { kind: 'human', name: 'Sam' });
    assert.equal(owners(Date.now()).closes, undefined, 'not while its undo is still offered');
    assert.deepEqual(owners(Date.now() + CLOSE_AFTER_DELETE_MS).closes, [work.owner], 'closed once its undo is past');
    tending.close();
  });

  // An agent connected on its own (core/roles.ts) has no terminal to start owners in: it takes the coordinator's role on
  // a board as it sleeps there by `tricot listen`, as each agent Tricot's terminal starts has it, is told so, lists the
  // role's tools from then on, and owns what it sends on; the chat bar's threads go to the one @-mentioned, else to the
  // one seen last; and the role goes with its session.
  it('makes each agent connected on its own a coordinator as it listens, owning the work it sends on', async () => {
    const boardId = (await request('POST', '/boards', { actor: 'Sam', title: 'On its own' })).json.id as string;
    const claudeCode = (version: string) => ({ name: 'claude-code', version });
    const said = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as ToolResult;
      assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
      return result.content.map((c) => c.text).join('\n');
    };
    const listed = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);
    const lead = await server.connect('agent=Lead', claudeCode('2.1.300'));
    assert.ok(!(await listed(lead)).includes('route_to_thread'), 'not before it listens');
    const changed = new Promise<void>((resolve) => lead.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()));
    const waited = await said(lead, 'wait_for_updates', { board_id: boardId, since: store.getBoard(boardId).seq });
    assert.ok(waited.includes(LEAD_WORDS), 'told it coordinates');
    await changed;
    assert.deepEqual((await listed(lead)).filter((name) => ['route_to_thread', 'set_thread_status'].includes(name)), ['route_to_thread', 'set_thread_status']);
    // A wait after another call, as an agent's next turn makes it (one at once is a spin, which waits).
    const again = async (client: Client) => {
      await said(client, 'get_board', { board_id: boardId });
      return said(client, 'wait_for_updates', { board_id: boardId, since: store.getBoard(boardId).seq, seconds: 1 });
    };
    assert.ok(!(await again(lead)).includes(LEAD_WORDS), 'told once');

    const other = await server.connect('agent=Other', claudeCode('2.1.300'));
    assert.ok((await said(other, 'wait_for_updates', { board_id: boardId, since: store.getBoard(boardId).seq })).includes(LEAD_WORDS), 'each that listens coordinates');
    assert.ok((await listed(other)).includes('route_to_thread'));
    const plain = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: 'Tidy the header.', door: 'canvas' })).json as Thread;
    assert.equal(plain.owner, 'Other', 'one that @-mentions none goes to the coordinator seen last');

    const asked = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: '@Lead make the footer sticky.', door: 'canvas' })).json as Thread;
    assert.equal(asked.owner, 'Lead', 'one that @-mentions a coordinator is its');
    const started = await said(lead, 'route_to_thread', { thread_id: asked.id, message_id: asked.messages[0].id, title: 'Sticky footer' });
    const work = store.getBoard(boardId).threads!.find((t) => t.title === 'Sticky footer')!;
    assert.deepEqual([work.owner, work.status, work.launch], ['Lead', 'working', undefined], 'its own, with no agent to start');
    assert.match(started, /which you own, its work at work\. .* Hand its work now to a background agent of your own/);
    assert.deepEqual(launchesOn(store.getBoard(boardId), () => false), [], 'no terminal starts anything for it');
    await said(lead, 'set_thread_status', { thread_id: work.id, status: 'needs-you', summary: 'Sticky on phones too?' });
    assert.equal(store.getThread(work.id).thread.status, 'needs-you');
    // A follow-up from the chat bar, alone in its thread, moves to the thread it follows up as Sam's, which takes it back
    // to work, and the thread it was asked in goes.
    const followUp = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: '@Lead is it sticky on tablets too?', door: 'canvas' })).json as Thread;
    const moved = await said(lead, 'route_to_thread', { thread_id: followUp.id, message_id: followUp.messages[0].id, to_thread_id: work.id });
    assert.match(moved, /^Moved their message into thread "Sticky footer" \[thread id: \S+\], which you own: .* so it is gone/);
    assert.ok(!store.getBoard(boardId).threads!.some((t) => t.id === followUp.id), 'the thread it was asked in is gone');
    const landed = store.getThread(work.id).thread;
    assert.deepEqual([landed.messages.at(-1)!.author.name, landed.messages.at(-1)!.body, landed.messages.at(-1)!.movedFrom, landed.status], ['Sam', '@Lead is it sticky on tablets too?', followUp.id, 'working']);
    // Over a page a coordinator made, the chat bar's thread is that coordinator's.
    const page = /\[page id: (\w+)\]/.exec(await said(lead, 'add_page', { board_id: boardId, title: 'Footer ideas' }))![1];
    const overPage = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: 'Which footer reads best?', pageId: page })).json as Thread;
    assert.equal(overPage.owner, 'Lead', "its page's agent, a coordinator");
    const loose = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: 'A note to self.' })).json as Thread;
    const refused = (await lead.callTool({ name: 'set_thread_status', arguments: { thread_id: loose.id, status: 'done' } })) as ToolResult;
    assert.match(refused.content[0].text, /has no owner/, 'only for a thread it owns');

    // A quick question it owns is the conversation's. What it is told of one, with the ask and in the thread, says to
    // answer a question there and send work on before anyone starts on it, in place of how to make what it asks for;
    // another agent reads the thread's aim as before. Its status is never set: that would make it work nothing sent on.
    const since = store.getBoard(boardId).seq;
    const ask = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: '@Lead can the footer fade in?', door: 'threads' })).json as Thread;
    const yours = `It's yours as the board's coordinator: answer a question here, but send anything that is work on with route_to_thread(thread_id: ${ask.id}) before anyone starts on it, to the thread it belongs to or to a new one.`;
    assert.ok((await said(lead, 'get_updates', { board_id: boardId, since })).includes(`It was started from the threads list. ${yours}`), 'with the ask');
    assert.ok((await said(lead, 'get_thread', { thread_id: ask.id })).includes(`It was started from the threads list. ${yours}`), 'in the thread');
    const asOther = await said(other, 'get_thread', { thread_id: ask.id });
    assert.ok(asOther.includes("so it's open-ended: talk it through") && !asOther.includes("It's yours as the board's coordinator"), 'another agent reads it as before');
    // A part's door keeps the card it aims at for the coordinator too, with the routing after it.
    const memos = { line: (id: string, vars: Record<string, string>) => (id === 'door.place.memos' ? 'the Memos tab' : id === 'door.memos' ? `${vars.from}, so the aim is a memo.` : undefined) } as unknown as Told;
    const viaMemos = { ...ask, door: 'memos' } as unknown as Thread;
    assert.equal(doorNote(viaMemos, undefined, memos, 'Lead'), `It was started from the Memos tab, so the aim is a memo. ${yours}`, "a part's door keeps its aim");
    assert.equal(doorNote(viaMemos, undefined, memos, 'Sam'), 'It was started from the Memos tab, so the aim is a memo.', 'and reads as before to anyone else');
    const overPageRead = await said(lead, 'get_thread', { thread_id: overPage.id });
    assert.ok(overPageRead.includes(`so it's about that page: read it with get_canvas(page_id: ${page}). It's yours as the board's coordinator`) && !overPageRead.includes('add_block(page_id'), 'over a page too');
    const quick = (await lead.callTool({ name: 'set_thread_status', arguments: { thread_id: ask.id, status: 'done', summary: 'It fades in now.' } })) as ToolResult;
    assert.ok(quick.isError);
    assert.equal(
      quick.content[0].text,
      `Thread "${store.getThread(ask.id).thread.title}" is a quick question in the board's conversation, so it has no status to set: work goes in a thread of its own. Send Sam's message on with route_to_thread first (thread_id: ${ask.id}, message_id: ${ask.messages[0].id}, and a title for new work), then say where the work stands in the thread it goes to.`,
    );
    assert.deepEqual([store.getThread(ask.id).thread.status, store.getThread(ask.id).thread.messages.length], [undefined, 1], 'still a quick question, with no summary posted');

    // Its name holds the role: a second session of it, as when its client connects again, lists the role's tools from the
    // start and serves the role at once, and keeps it when the first ends.
    const reconnected = await server.connect('agent=Lead', claudeCode('2.1.300'));
    assert.deepEqual((await listed(reconnected)).filter((name) => ['route_to_thread', 'set_thread_status'].includes(name)), ['route_to_thread', 'set_thread_status'], 'listed from the start');
    await said(reconnected, 'set_thread_status', { thread_id: work.id, status: 'done', summary: 'Sticky on every screen.' });
    await (lead.transport as StreamableHTTPClientTransport).terminateSession(); // its first session ends
    await lead.close();
    assert.equal(((await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: '@Lead and the footer links?', door: 'canvas' })).json as Thread).owner, 'Lead', 'kept by its other session');

    await (reconnected.transport as StreamableHTTPClientTransport).terminateSession(); // its last session ends
    await reconnected.close();
    const after = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: '@Lead and the header?', door: 'canvas' })).json as Thread;
    assert.equal(after.owner, undefined, 'its role went with its last session');
    assert.equal(((await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: 'And the logo?', door: 'canvas' })).json as Thread).owner, 'Other', 'the other keeps its own');
    assert.ok(!(await again(other)).includes(LEAD_WORDS), 'told once');
    // A session of its name that starts soon after takes the role back, its tools listed from the start (server/leads.ts).
    const back = await server.connect('agent=Lead', claudeCode('2.1.300'));
    assert.ok((await listed(back)).includes('route_to_thread'), 'taken back');
    assert.equal(((await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: '@Lead and the favicon?', door: 'canvas' })).json as Thread).owner, 'Lead');
  });

  // Tricot restarting ends every session at once: as it stops it keeps who coordinates which board, and a session of that
  // name that starts soon after takes the role back; a later one, or one after a stop that kept nothing, does not.
  it("carries a coordinator's role over a restart, for a few minutes", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tricot-leads-'));
    try {
      let now = Date.now();
      const stopping = new Leads({ dataDir, now: () => now });
      stopping.take('board-a', 'Lead', 'session-1');
      stopping.carryOut();
      if (!WINDOWS) assert.equal(statSync(leadsFile(dataDir)).mode & 0o777, 0o600, 'private to the person, as the rest of the data folder is');
      now += 30_000;
      const started = new Leads({ dataDir, now: () => now });
      assert.equal(existsSync(leadsFile(dataDir)), false, 'read once');
      assert.equal(started.holds('board-a', 'Lead'), false, 'no one coordinates until a session of its name starts');
      assert.equal(started.resume('Other', 'session-2'), false);
      assert.equal(started.resume('Lead', 'session-3'), true);
      assert.equal(started.holds('board-a', 'Lead'), true);
      started.carryOut();
      now += RESUME_MS + 1_000;
      assert.equal(new Leads({ dataDir, now: () => now }).resume('Lead', 'session-4'), false, 'too long after the stop');
    } finally {
      removeScratch(dataDir);
    }
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
      step({ text: 'Editing src/a.ts', worker: 'w1', role: 'Explore', files: ['src/a.ts'], thread: undefined }); // naming nothing of its own: where its session is
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

      // A subagent handed a thread of its own (core/roles.ts), which it named, has work of its own there.
      const other = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Sam', body: 'And the footer.' })).json as Thread;
      step({ text: 'Reading the thread', worker: 'w2', thread: other.id });
      step({ text: 'Updating its to-do list', worker: 'w2', tool: 'c4', thread: undefined, plan: { set: [{ text: 'Move the footer', status: 'now' }] } });
      step({ text: 'Editing src/footer.ts', worker: 'w2', thread: undefined, files: ['src/footer.ts'] });
      const handed = steps.work(boardKey(store.getBoard(boardId))).find((w) => w.thread === other.id)!;
      assert.deepEqual([handed.plan, handed.files], [[{ text: 'Move the footer', status: 'now' }], ['src/footer.ts']]);
      assert.deepEqual(steps.work(boardKey(store.getBoard(boardId))).find((w) => w.thread === thread.id)!.files, ['src/a.ts'], "and its session's stays its own");

      step({ text: 'Finished its turn', done: true });
      step({ text: 'Reading src/b.ts' });
      const next = steps.work(boardKey(store.getBoard(boardId))).find((w) => w.thread === thread.id)!;
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
    // How many agents a coordinator runs at once is its rule's, from 1 to 8; none, or one out of range, is the default 3.
    assert.equal(atOnce({ 'claude:coordinator': { orchestrators: 5 } }, 'claude'), 5);
    assert.equal(atOnce({}, 'claude'), 3);
    assert.deepEqual([cleanRule({ orchestrators: 9 }), cleanRule({ orchestrators: 2.5 }), cleanRule({ orchestrators: null })], [{}, {}, {}]);
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

// Which piece of work a change to a canvas belongs to (core/canvasBatches.ts), so what is new says an agent's run of
// blocks once: Studio's inbox shows each piece as one row.
describe('The pieces of work on the canvases', () => {
  it("folds what was made for a thread into it, what is on a card's canvas into the card, and a run on a page or the board context by who made it until a pause", () => {
    const sam: Actor = { kind: 'human', name: 'Sam' };
    const claude: Actor = { kind: 'agent', name: 'Claude' };
    const codex: Actor = { kind: 'agent', name: 'Codex' };
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-batches-'));
    const store = new Store(dir);
    try {
      store.load();
      const board = store.createBoard({ title: 'Site', goal: 'A landing page' }, sam);
      const page = store.addPage(board.id, 'Mood board', sam);
      const thread = store.startThread(board.id, 'Find references for the hero', sam, null, { pageId: page.id });
      const since = store.getBoard(board.id).seq;
      const note = (title: string) => ({ title, content: { type: 'note' as const, text: title } });
      // Claude answers the thread with a group and two notes, one in the group, passing the thread's id (add_block's thread_id).
      const group = store.addGroup({ pageId: page.id }, { title: 'References' }, claude);
      const made = [store.addBlock({ pageId: page.id }, { ...note('Warm'), groupId: group.id }, claude), store.addBlock({ pageId: page.id }, note('Cool'), claude)];
      for (const block of made) store.addThreadWork(thread.id, { kind: 'block', id: block.id }, claude);
      store.postToThread(thread.id, 'Two references, warm and cool.', claude);
      // Codex on the same page for no thread, then on the board context; Sam adds a note and takes it away, and comments on
      // Codex's summary and resolves it.
      const loose = [store.addBlock({ pageId: page.id }, note('Grid'), codex), store.addBlock({ pageId: page.id }, note('Type'), codex)];
      const summary = store.addBlock({ boardId: board.id }, note('Summary'), codex);
      const gone = store.addBlock({ pageId: page.id }, note('Draft'), sam);
      store.removeItem(gone.id, sam);
      const { pin } = store.pinComment(summary.id, { kind: 'text', quote: 'Summary' }, 'Is this current?', sam);
      store.resolvePin(pin.id, true, sam);

      const now = canvasHoldings(store.getBoard(board.id));
      const events = store.events(board.id, { since }).reverse();
      const batches = canvasBatches(now, events);
      const keysOf = (id: string, from = batches) => [...new Set(events.filter((e) => e.itemId === id).map((e) => from.get(e.seq)?.key))];
      const changes = (key: string) => events.filter((e) => batches.get(e.seq)?.key === key);
      // Made for the thread, the group by the block in it: one piece, keyed as the thread's own reply is.
      assert.deepEqual([...keysOf(group.id), ...keysOf(made[0].id), ...keysOf(made[1].id)], [thread.id, thread.id, thread.id]);
      assert.equal(batches.get(events.find((e) => e.type === 'thread_replied')!.seq), undefined);
      assert.equal(batchWords(now, changes(thread.id), { where: true }), 'added 2 notes and a group on Sketchbook page "Mood board"');
      // A run on the page by one agent is one piece; the board context's is another, and a block gone since is its own.
      const [run] = keysOf(loose[0].id);
      assert.deepEqual(keysOf(loose[1].id), [run]);
      assert.equal(batches.get(changes(run!)[0].seq)?.page?.id, page.id);
      assert.equal(batchWords(now, changes(run!)), 'added 2 notes');
      const [context] = keysOf(summary.id);
      assert.notEqual(context, run);
      assert.equal(batches.get(changes(context!)[0].seq)?.context, true);
      assert.deepEqual(keysOf(gone.id), [gone.id]);
      // Resolving a comment thread is no piece of work: it goes with the thread's comments, by the pin.
      assert.deepEqual(keysOf(pin.id), [undefined]);
      // A pause longer than a stretch of work starts another run.
      const later = (e: BoardEvent) => ({ ...e, at: new Date(Date.parse(e.at) + GAP_MS + 60_000).toISOString() });
      const paused = canvasBatches(now, events.map((e) => (e.itemId === loose[1].id ? later(e) : e)));
      assert.notEqual(keysOf(loose[1].id, paused)[0], keysOf(loose[0].id, paused)[0]);
      // A block made before the change says it changed; a change on a card's canvas is the card's.
      assert.equal(batchWords(now, changes(run!).slice(0, 1).map(later)), 'changed a note');
      const onCard = { ...events[0], seq: 10_000, itemId: 'elsewhere', decisionId: 'd7' } as BoardEvent;
      assert.equal(canvasBatches(now, [onCard]).get(10_000)?.key, 'd7');
    } finally {
      removeScratch(dir);
    }
  });
});

// Home's conversation (core/homeConversation.ts), which the page's Home and the terminal's chat both show: a quick question
// and its answer, an ask sent on with the card that leads to its thread, and what of that work needs the person; and the
// Tricot tab's chat drawing it (cli/switcher/homeStream.ts, homeView.ts), with the yarn at its left.
describe("Home's conversation", () => {
  it('holds the quick questions and their answers, a card for each ask sent on and the relays of the work, in the page and the terminal alike', async () => {
    const sam: Actor = { kind: 'human', name: 'Sam' };
    const router: Actor = { kind: 'agent', name: 'Router' };
    const owner: Actor = { kind: 'agent', name: 'Claude · Sign-in on mobile' };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-home-'));
    const store = new Store(dir);
    try {
      store.load();
      const board = store.createBoard({ title: 'Shop' }, sam);
      const quick = store.startThread(board.id, "What's left before the release?", sam, null, { door: 'threads' });
      await tick();
      store.postToThread(quick.id, 'The sign-in fix, then the changelog.', router);
      await tick();
      const ask = store.startThread(board.id, 'Fix sign-in on mobile.', sam, null, { door: 'threads' });
      await tick();
      store.postToThread(ask.id, 'Sending it to Claude.', router);
      await tick();
      const { to: work } = store.routeToThread(ask.id, ask.messages[0].id, router, { title: 'Sign-in on mobile', owner: owner.name, launch: 'claude' });
      await tick();
      const question = store.postToThread(work.id, 'Which tablets: iPads alone, or Android too?', owner).messages.at(-1)!;
      store.setThreadStatus(work.id, 'needs-you', owner);
      const now = store.getBoard(board.id);
      const onBoard = [{ name: 'Router', state: 'listening' }, { name: owner.name, state: 'working' }];

      // What was said, but the coordinator's word that it sent the ask on, which is the card under the ask; and the relay.
      const said = homeSaid(now, now.threads!.filter(inConversation), ownedThreads(now), (t) => t.messages, (m) => m, (m) => m);
      assert.deepEqual(
        said.map((s) => [s.message.body, s.sentOn.map((t) => t.title)]),
        [["What's left before the release?", []], ['The sign-in fix, then the changelog.', []], ['Fix sign-in on mobile.', ['Sign-in on mobile']], ['Sending it to Claude.', []]],
      );
      const relays = homeRelays(now, 'Sam', onBoard, new Set(), () => []);
      assert.deepEqual(relays.map((r) => [r.kind, r.key, r.needsYou, r.tone, relayWords(r)]), [['question', question.id, true, 'waiting', 'Claude asks you']]);
      assert.deepEqual(askedWhileWaiting(relays), [question.id], 'remembered, as it says nothing of it once its thread moves on');
      const later = { ...now, threads: now.threads!.map((t) => (t.id === work.id ? { ...t, status: 'working' as const } : t)) };
      assert.deepEqual(homeRelays(later, 'Sam', onBoard, new Set(), () => []), [], 'moved on, the thread no longer asks');
      assert.equal(homeRelays(later, 'Sam', onBoard, new Set([question.id]), () => []).length, 1, 'but one remembered stays');
      const rows = homeRows(said, relays, 'Sam', { since: said[1].message.at, arrived: Date.now() }, Date.now());
      assert.deepEqual(rows.map((row) => row.kind), ['day', 'said', 'said', 'said', 'since', 'said', 'relay'], "since then, from the first that isn't Sam's own");
      const atWork = later.threads.find((t) => t.id === work.id)!;
      assert.deepEqual([threadTone(atWork, onBoard), threadTone(atWork, [])], ['working', 'todo'], 'at work while its agent is on the board, not started before');

      // The terminal draws it: the card knits the work's strand off the conversation's, and the question stitches into it.
      const tab = new ThreadsTab({
        access: { me: 'Sam', read: async () => ({ ok: true, board: store.getBoard(board.id) }), skills: async () => [], send: {} as never },
        live: () => ({ board: board.id, steps: [], approvals: [], presence: onBoard.map((p) => ({ ...p, lastSeen: new Date().toISOString() }) as AgentPresence), chatVer: 1 }),
        now: () => Date.now(),
        changed: () => {},
        agents: () => [],
        askSeat: () => {},
        seatWords: () => undefined,
      });
      tab.start();
      tab.render(100, 24, false);
      await tick();
      const drawn = (cols: number, colours?: Colours) => tab.render(cols, 24, false, undefined, colours).plain.map((row) => row.trimEnd());
      const wide = drawn(100);
      const card = wide.find((row) => row.includes('↳ Sign-in on mobile · sent on to Claude  ■ Needs you'));
      assert.match(card ?? '', /^ ├─╮ /, 'the work knits off where the ask was sent on');
      assert.match(wide.find((row) => row.includes('Claude asks you')) ?? '', /^ │ • {3}■ Sign-in on mobile · Claude asks you · /);
      assert.ok(wide.some((row) => row.endsWith('Which tablets: iPads alone, or Android too?')));
      assert.ok(!wide.some((row) => row.includes('Sent to "')), "the coordinator's word is the card, not a message");
      assert.ok(wide.some((row) => row.includes('to Sign-in on mobile, the latest')), 'what is typed answers the question, in its thread');
      assert.match(drawn(50).find((row) => row.includes('↳')) ?? '', /^ ├╴ /, 'a narrow window keeps a column of marks');
      assert.match(drawn(100, 'none').find((row) => row.includes('-> Sign-in on mobile')) ?? '', /^ \+-\. /, 'and no colour, plain characters');
      // Tab chooses the latest (the question), then each one before (the coordinator's answer, the card under the ask);
      // Enter opens the card's thread, as the panel picks one.
      for (let n = 0; n < 3; n++) tab.key({ kind: 'tab' });
      assert.match(drawn(100).find((row) => row.includes('↳')) ?? '', /❯ {3}↳ Sign-in on mobile/);
      tab.key({ kind: 'enter' });
      assert.equal(drawn(100)[0], '  Only Sign-in on mobile · Esc for everything');

      // Work waiting for Sam's review (core/roles.ts) is relayed as a review: its owner's summary, needing him, in the
      // in-review colour, and its owner is not started meanwhile. A plain reply leaves it waiting; his verdict, read
      // from his message's words with nothing else stored, folds it, as approved or sent back, once the thread moves on.
      await tick();
      store.postToThread(work.id, 'iPads alone.', sam);
      await tick();
      store.setThreadStatus(work.id, 'in-review', owner, 'Fixed on phones and iPads: the diff is on the board.');
      const summary = store.getThread(work.id).thread.messages.at(-1)!;
      const reviews = () => homeRelays(store.getBoard(board.id), 'Sam', onBoard, new Set(), () => []).filter((r) => r.kind === 'review');
      const [waiting] = reviews();
      assert.deepEqual([waiting.key, waiting.at, waiting.body, waiting.tone, waiting.needsYou, relayWords(waiting), waiting.verdict], [summary.id, summary.at, summary.body, 'review', true, 'Waits for your review', undefined]);
      assert.equal(launchesOn(store.getBoard(board.id), () => false).length, 0, 'its owner is not started while its work waits for review');
      const stream = (at: number) => homeStream({ board: store.getBoard(board.id), me: 'Sam', onBoard, asked: new Set(), visit: { since: null, arrived: at }, now: at });
      const reviewLines = () => {
        const item = stream(Date.now()).items.find((i) => i.home?.kind === 'relay' && i.home.relay.kind === 'review')!;
        return homeLines(item, { width: 100, me: 'Sam', sending: false, selected: false, look: { colours: 'none', light: false } }).map((parts) => parts.map(([text]) => text).join('').trimEnd());
      };
      const lines = reviewLines();
      assert.match(lines[0], /Sign-in on mobile · Waits for your review · /, 'the terminal says the work waits for review');
      assert.ok(lines.includes(`    ${REVIEW_HINT}`), 'and where to give the verdict, as a reply there is a plain one');
      await tick();
      store.postToThread(work.id, 'Does it hold on Android?', sam);
      assert.deepEqual([store.getThread(work.id).thread.status, reviews()[0].needsYou], ['in-review', true], 'a plain reply leaves it waiting for review');
      assert.throws(() => store.reviewThread(work.id, 'changes', sam), /Say what needs changing in note/);
      await tick();
      store.reviewThread(work.id, 'changes', sam, 'The keyboard still covers it on Android.');
      const [sentBack] = reviews();
      assert.deepEqual([sentBack.key, sentBack.needsYou, sentBack.tone, relayWords(sentBack), verdictWords(sentBack, 'Sam')], [summary.id, false, 'working', 'Sent back', 'You sent it back: “The keyboard still covers it on Android.”']);
      assert.deepEqual(launchesOn(store.getBoard(board.id), () => false).map((l) => l.thread), [work.id], 'back at work, its owner is started again if it is gone');
      assert.match(reviewLines().at(-1)!, /^ {4}You sent it back: “The keyboard still covers it on Android\.”$/);
      await tick();
      store.setThreadStatus(work.id, 'in-review', owner, 'Fixed on Android too.');
      await tick();
      store.reviewThread(work.id, 'approve', sam);
      await tick();
      store.setThreadStatus(work.id, 'done', owner, 'Committed: fixed on phones and tablets.');
      const settled = homeRelays(store.getBoard(board.id), 'Sam', onBoard, new Set([question.id]), () => []).filter((r) => r.thread?.id === work.id);
      assert.deepEqual(
        settled.map((r) => [r.kind, r.needsYou, r.verdict ? verdictWords(r, 'Sam') : relayWords(r)]),
        [['question', false, 'Answered'], ['review', false, 'You sent it back: “The keyboard still covers it on Android.”'], ['review', false, 'You approved it'], ['done', false, 'Done']],
      );
      assert.deepEqual(relayStack(settled).answered.map((r) => r.kind), ['review', 'review', 'question'], 'answered, a review is among what was answered');
      assert.throws(() => store.reviewThread(work.id, 'approve', sam), /isn't waiting for a review: its work is done/);
    } finally {
      removeScratch(dir);
    }
  });
  it("says who is on a board by the work they own: the coordinator, the threads at work and who a message for any agent reaches", () => {
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
    const thread = (id: string, owner: string, status: Thread['status'], n: number) => ({ id, owner, status, updatedAt: at(n), messages: [] }) as unknown as Thread;
    const here = (name: string, state: AgentPresence['state'], coordinator?: true) => ({ name, state, lastSeen: at(9), ...(coordinator && { coordinator }) }) as AgentPresence;
    const board = { threads: [thread('a', 'Claude · Sign-in', 'working', 1), thread('b', 'Claude · Search', 'working', 2), thread('c', 'Claude · Docs', 'done', 3), thread('d', 'Claude · Cache', 'needs-you', 4)] };
    const claude = here('Claude', 'listening', true);
    const present = [claude, here('Claude · Sign-in', 'working'), here('Claude · Docs', 'asleep'), here('Claude · Cache', 'asleep')];

    const live = liveAgents(present, board);
    assert.equal(live.lead?.name, 'Claude');
    assert.deepEqual([live.atWork.map((t) => [t.thread.id, t.owner?.name]), live.needsYou.map((t) => t.thread.id), live.done.map((t) => t.thread.id), live.others], [[['b', undefined], ['a', 'Claude · Sign-in']], ['d'], ['c'], []], 'an owner is its thread, never an agent; one not started has no owner yet');
    assert.equal(liveWords(live), 'Claude · listening · 2 at work');
    assert.equal(liveWords(liveAgents([claude, here('Claude · Docs', 'asleep')], { threads: [thread('c', 'Claude · Docs', 'done', 3)] })), 'Claude · listening');
    assert.equal(liveWords(liveAgents([here('Pi', 'working')], { threads: [] })), 'Pi · working', 'one agent alone, as before');
    assert.equal(liveWords(liveAgents([here('Pi', 'working'), here('Codex', 'asleep')], { threads: [] })), '2 agents');
    assert.equal(liveWords(liveAgents([here('Pi', 'working'), here('Codex', 'asleep')], { threads: [thread('a', 'Claude', 'working', 1)] })), '2 agents · 1 at work');
    assert.equal(liveWords(liveAgents([], board)), '2 at work', 'none but work');
    assert.equal(liveWords(liveAgents([], { threads: [] })), 'No agents');

    assert.deepEqual(reachedByAny(present).map((a) => a.name), ['Claude'], 'a new message starts a thread its coordinator owns: only it is woken');
    const peers = [here('Pi', 'asleep'), here('Codex', 'listening'), here('Claude · Sign-in', 'working'), here('Gone', 'away')];
    assert.deepEqual(reachedByAny(peers).map((a) => a.name), ['Pi', 'Codex', 'Claude · Sign-in'], 'with no coordinator every agent that is not away, owners of work included');
  });
});
