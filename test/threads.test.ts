import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { needsInput } from '../src/core/attention';
import { boardDigest, decisionDetail, eventsDigest, taskDetail } from '../src/core/digest';
import { Store } from '../src/core/store';
import { LENSES, shownTitle, threadDetail, threadTitle, threadWaiting, threadWork, threadsDigest } from '../src/core/threads';
import type { Actor, Thread } from '../src/core/types';
import { createApp } from '../src/server/app';
import { eventsOf } from './tables';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };
const wassim: Actor = { kind: 'human', name: 'Wassim' };
const sam: Actor = { kind: 'human', name: 'Sam' };

describe('Thread titles', () => {
  it('takes the first sentence, without the mentions it opens with', () => {
    assert.equal(threadTitle('Can we bundle Pi in the app? It would save a download.'), 'Can we bundle Pi in the app?');
    assert.equal(threadTitle('@Codex  is the   retry\nlogic safe?', ['Codex']), 'Is the retry logic safe?');
    assert.equal(threadTitle('@Codex', ['Codex']), '@Codex', 'all mentions keeps its text');
  });

  it('keeps about two lines of the list, and clips a longer one at a word', () => {
    const whole = 'What would it take to ship the desktop app with built-in agents and our own login flow for teams';
    assert.equal(threadTitle(whole), whole, 'kept whole up to 100 characters');
    const title = threadTitle(`${whole}, from sign-up to the first invoice, without a separate admin console`);
    assert.equal(title, 'What would it take to ship the desktop app with built-in agents and our own login flow for teams…');
    assert.ok(title.length <= 100);
  });

  it('shows one cut at the old length in full again, from its first message', () => {
    const body = 'What would it take to ship the desktop app with built-in agents and our own login flow for teams? Think about it.';
    const message = { id: 'm1', author: wassim, body, at: '2026-11-01T10:00:00.000Z' };
    const thread = (title: string, extra: Partial<Thread> = {}) => ({ title, messages: [message], ...extra });
    const full = 'What would it take to ship the desktop app with built-in agents and our own login flow for teams?';
    assert.equal(shownTitle(thread('What would it take to ship the desktop app with built-in…')), full);
    assert.equal(shownTitle(thread(full)), full, 'a title made at the new length stays as it is');
    assert.equal(shownTitle(thread('General', { general: true })), 'General');
    assert.equal(shownTitle(thread('Something else entirely…')), 'Something else entirely…', 'not from its first message: left as it is');
  });
});

describe('Threads on a board', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-threads-'));
    store = new Store(dir);
    store.load();
    store.presentAgents = () => ['Claude', 'Codex'];
    boardId = store.createBoard({ title: 'Desktop app' }, wassim).id;
    store.postDecision(boardId, { question: 'Which shell?' }, sam); // Sam is one of the board's people
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts a thread from its first message and logs each message', () => {
    const thread = store.startThread(boardId, 'Can we bundle Pi in the app? People bring their own logins.', wassim);
    assert.equal(thread.title, 'Can we bundle Pi in the app?');
    assert.deepEqual(thread.startedBy, wassim);
    assert.equal(thread.messages.length, 1);
    assert.equal(thread.messages[0].body, 'Can we bundle Pi in the app? People bring their own logins.');
    const board = store.getBoard(boardId);
    assert.deepEqual(board.threads, [thread]);
    const started = eventsOf(store, board).at(-1)!;
    assert.equal(started.type, 'thread_started');
    assert.equal(started.summary, 'started thread "Can we bundle Pi in the app?"');
    assert.equal(started.itemId, thread.id);
    assert.equal(started.at, thread.messages[0].at);

    const replied = store.postToThread(thread.id, 'Bundling is fine: Pi is MIT. The logins are the catch, so I posted #2.', claude);
    assert.equal(replied, thread);
    assert.equal(thread.messages.length, 2);
    assert.deepEqual(thread.messages[1].author, claude);
    assert.equal(thread.updatedAt, thread.messages[1].at);
    const event = eventsOf(store, board).at(-1)!;
    assert.equal(event.type, 'thread_replied');
    assert.equal(event.summary, 'replied in thread "Can we bundle Pi in the app?": "Bundling is fine: Pi is MIT. The logins are the catch, so I posted #2."');
    assert.deepEqual(store.getThread(thread.id), { board, thread });
  });

  it('resolves mentions as comments do, and keeps them on the message and its event', () => {
    const thread = store.startThread(boardId, '@codex is the retry logic safe? @Sam may know too', wassim);
    assert.deepEqual(thread.messages[0].mentions, ['Codex', 'Sam']);
    assert.deepEqual(eventsOf(store, boardId).at(-1)!.mentions, ['Codex', 'Sam']);
    assert.equal(thread.title, 'Is the retry logic safe?');
    store.postToThread(thread.id, 'Thanks @Wassim', wassim);
    assert.equal(thread.messages[1].mentions, undefined, 'never the writer');
  });

  it('refuses empty and overlong messages, unknown threads and archived boards', () => {
    assert.throws(() => store.startThread(boardId, '   ', wassim), /A message must not be empty/);
    assert.throws(() => store.startThread(boardId, 'x'.repeat(10_001), wassim), /A message is too long \(max 10000 characters\)/);
    assert.throws(() => store.startThread('nope', 'Hello', wassim), /No board with id "nope"/);
    assert.throws(() => store.postToThread('nope', 'Hello', wassim), (e: Error & { code?: string }) => e.code === 'not_found' && /No thread with id "nope"/.test(e.message));
    const thread = store.startThread(boardId, 'Hello', wassim);
    store.setArchived(boardId, true, wassim);
    assert.throws(() => store.startThread(boardId, 'Again', wassim), /archived by Wassim, so it is read-only/);
    assert.throws(() => store.postToThread(thread.id, 'More', claude), /archived by Wassim, so it is read-only/);
    assert.equal(thread.messages.length, 1);
  });

  it('keeps threads across a restart, and finds them after a rename', async () => {
    const thread = store.startThread(boardId, 'Is the desktop app worth it?', wassim);
    store.updateBoard(boardId, { title: 'Desktop shell' }, wassim);
    assert.equal(store.getThread(thread.id).thread, thread);
    await store.flush();
    const again = new Store(dir);
    again.load();
    assert.equal(again.getThread(thread.id).thread.title, 'Is the desktop app worth it?');
    again.postToThread(thread.id, 'Yes.', claude);
    assert.equal(again.getThread(thread.id).thread.messages.length, 2);
    await again.flush();
  });

  it('waits on any agent until one replies, on the agents it mentions until they do, and not on agents for people', () => {
    const board = store.getBoard(boardId);
    const anyone = store.startThread(boardId, 'What is left before the desktop app?', wassim);
    assert.deepEqual(threadWaiting(board, anyone)?.agents, []);
    store.postToThread(anyone.id, 'Signing and the updater.', claude);
    assert.equal(threadWaiting(board, anyone), undefined, 'the first to reply answers it');

    const forCodex = store.startThread(boardId, '@Codex can you check the updater?', wassim);
    store.postToThread(forCodex.id, 'I can look too.', claude);
    assert.deepEqual(threadWaiting(board, forCodex)?.agents, ['Codex'], "Claude's reply doesn't answer what was Codex's");
    store.postToThread(forCodex.id, 'Checked: it is fine.', codex);
    assert.equal(threadWaiting(board, forCodex), undefined);

    const forSam = store.startThread(boardId, '@Sam which shell did we pick?', wassim);
    assert.equal(threadWaiting(board, forSam), undefined, 'asks a person, not agents');

    const raised = store.startThread(boardId, 'Heads-up: the updater needs a signing key.', claude);
    assert.equal(threadWaiting(board, raised), undefined, "an agent's own thread waits on people");
  });

  it('tells each agent what waits on it, and names threads in get_board', () => {
    const board = store.getBoard(boardId);
    const anyone = store.startThread(boardId, 'What is left before the desktop app?', wassim);
    const forCodex = store.startThread(boardId, '@Codex can you check the updater?', wassim);
    const forClaude = threadsDigest(board, 'Claude')!;
    assert.equal(
      forClaude,
      `Wassim wrote in thread "What is left before the desktop app?" [thread id: ${anyone.id}]: "What is left before the desktop app?". For any agent: the first to reply answers, with reply_in_thread(thread_id: ${anyone.id}).`,
      "Codex's is left out",
    );
    assert.ok(
      threadsDigest(board, 'Codex')!.includes(
        `Wassim asked you in thread "Can you check the updater?" [thread id: ${forCodex.id}]: "can you check the updater?". Reply with reply_in_thread(thread_id: ${forCodex.id}).`,
      ),
    );
    const digest = boardDigest(board, 'Claude');
    assert.match(digest, /## Threads \(2\)\nRead one with get_thread; answer in it with reply_in_thread, through its lens\./);
    assert.match(digest, new RegExp(`- thread "Can you check the updater\\?" \\[thread id: ${forCodex.id}\\] · General lens · 1 message · last by Wassim \\(human\\) at \\S+: "can you check the updater\\?" · waits on Codex`));
    assert.match(digest, new RegExp(`- thread "What is left before the desktop app\\?" \\[thread id: ${anyone.id}\\] · General lens · 1 message .+ · waits on an agent`));
    store.postToThread(anyone.id, 'Signing and the updater.', claude);
    assert.match(boardDigest(board, 'Claude'), /· 2 messages · last by Claude \(agent\) at \S+: "Signing and the updater\." *\n/, 'answered: no wait');
  });

  it('reads a message event as asked of the agent, for another, or for any agent until answered', () => {
    const board = store.getBoard(boardId);
    const since = board.seq;
    const forCodex = store.startThread(boardId, '@Codex can you check the updater?', wassim);
    const anyone = store.startThread(boardId, 'What is left?', wassim);
    const events = store.eventsSince(boardId, since);
    const forClaude = eventsDigest(events, board.seq, { board, viewer: 'Claude' });
    assert.match(forClaude, new RegExp(`- \\(\\d+\\) Wassim \\(human\\) asked Codex in thread "Can you check the updater\\?" \\[thread id: ${forCodex.id}\\]\\. Not for you; carry on\\.`));
    assert.match(forClaude, new RegExp(`- \\(\\d+\\) Wassim \\(human\\) started thread "What is left\\?" \\[thread id: ${anyone.id}\\]: "What is left\\?"\\. For any agent: the first to reply answers, with reply_in_thread\\(thread_id: ${anyone.id}\\)\\.`));
    const codexSees = eventsDigest(events, board.seq, { board, viewer: 'Codex' });
    assert.match(codexSees, /Wassim \(human\) asked you in thread "Can you check the updater\?" \[thread id: \w+\]: "can you check the updater\?"\. Reply with reply_in_thread/);
    store.postToThread(anyone.id, 'Signing.', codex);
    const later = eventsDigest(store.eventsSince(boardId, since), board.seq, { board, viewer: 'Claude' });
    assert.match(later, new RegExp(`- \\(\\d+\\) Wassim \\(human\\) started thread "What is left\\?" \\[thread id: ${anyone.id}\\]\\n`), 'answered: as logged');
    assert.match(later, /Codex \(agent\) replied in thread "What is left\?": "Signing\." \[thread id: \w+\]/);
  });

  it("counts an agent's reply in a thread a person wrote in as needing them, and mentions as asked of them", () => {
    const board = store.getBoard(boardId);
    const thread = store.startThread(boardId, 'What is left?', wassim);
    store.postToThread(thread.id, 'Signing.', claude);
    assert.equal(needsInput(eventsOf(store, board).at(-1)!, board, 'Wassim'), true);
    assert.equal(needsInput(eventsOf(store, board).at(-1)!, board, 'Sam'), false, 'not in it');
    store.postToThread(thread.id, '@Sam can you get the key?', wassim);
    assert.equal(needsInput(eventsOf(store, board).at(-1)!, board, 'Sam'), true);
  });
});

describe('Thread lenses', () => {
  let dir: string;
  let store: Store;
  let boardId: string;
  const legal = LENSES.find((l) => l.name === 'Legal')!.brief!;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-lenses-'));
    store = new Store(dir);
    store.load();
    store.presentAgents = () => ['Claude', 'Codex'];
    boardId = store.createBoard({ title: 'Desktop app' }, wassim).id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a preset with its brief, one of your own with yours, and General as no lens', async () => {
    const pi = store.startThread(boardId, 'Can we bundle Pi?', wassim, { name: 'legal' });
    assert.deepEqual(pi.lens, { name: 'Legal', brief: legal }, "a preset's name as the board spells it, with its brief");
    assert.equal(eventsOf(store, boardId).at(-1)!.summary, 'started thread "Can we bundle Pi?", through the Legal lens');
    const own = store.startThread(boardId, 'Is onboarding clear?', wassim, { name: '  Onboarding ', brief: 'Answer as a first-time user would  see it.', agent: 'codex' });
    assert.deepEqual(own.lens, { name: 'Onboarding', brief: 'Answer as a first-time user would see it.', agent: 'Codex' });
    assert.equal(store.startThread(boardId, 'Anything?', wassim, { name: 'General' }).lens, undefined);
    assert.equal(store.startThread(boardId, 'Anything else?', wassim).lens, undefined);
    assert.deepEqual(store.startThread(boardId, 'Who picks?', wassim, { name: 'General', agent: 'Claude' }).lens, { name: 'General', agent: 'Claude' });

    assert.throws(() => store.startThread(boardId, 'Hi', wassim, { name: 'Pricing' }), /A lens of your own needs a brief: a sentence or two on how agents should answer through "Pricing"\./);
    assert.throws(() => store.startThread(boardId, 'Hi', wassim, { name: 'x'.repeat(25), brief: 'Answer.' }), /A lens name is too long \(max 24 characters\)/);
    assert.throws(() => store.startThread(boardId, 'Hi', wassim, { name: 'Legal', brief: 'x'.repeat(301) }), /A lens brief is too long \(max 300 characters\)/);
    assert.throws(() => store.startThread(boardId, 'Hi', wassim, { name: 'Legal', agent: 'Gemini' }), /No agent named "Gemini" on this board\. Its agents: Claude and Codex\./);
    assert.equal(store.getBoard(boardId).threads!.length, 5, 'nothing started when refused');

    await store.flush();
    const again = new Store(dir);
    again.load();
    assert.deepEqual(again.getThread(own.id).thread.lens, own.lens);
  });

  it('changes a lens with an event, and does nothing when it is the same', () => {
    const thread = store.startThread(boardId, 'Can we bundle Pi?', wassim);
    const board = store.getBoard(boardId);
    const seq = board.seq;
    store.setThreadLens(thread.id, { name: 'General' }, wassim);
    assert.equal(board.seq, seq, 'General already');
    store.setThreadLens(thread.id, { name: 'Legal', agent: 'Codex' }, wassim);
    assert.deepEqual(thread.lens, { name: 'Legal', brief: legal, agent: 'Codex' });
    const changed = eventsOf(store, board).at(-1)!;
    assert.equal(changed.type, 'thread_lens_changed');
    assert.equal(changed.itemId, thread.id);
    assert.equal(changed.summary, 'set the lens of thread "Can we bundle Pi?" to Legal, routed to Codex');
    store.setThreadLens(thread.id, { name: 'Legal', agent: 'codex' }, wassim);
    assert.equal(board.seq, seq + 1, 'the same lens');
    store.setThreadLens(thread.id, null, wassim);
    assert.equal(thread.lens, undefined);
    assert.equal(eventsOf(store, board).at(-1)!.summary, 'set the lens of thread "Can we bundle Pi?" to General');
    store.setArchived(boardId, true, wassim);
    assert.throws(() => store.setThreadLens(thread.id, { name: 'Design' }, wassim), /archived by Wassim/);
  });

  it("tells agents the lens and its brief wherever they meet the thread", () => {
    const board = store.getBoard(boardId);
    const since = board.seq;
    const thread = store.startThread(boardId, 'Can we bundle Pi in the app?', wassim, { name: 'Legal' });
    const through = `Answer through its Legal lens: ${legal}`;
    assert.ok(threadsDigest(board, 'Claude')!.endsWith(`reply_in_thread(thread_id: ${thread.id}). ${through}`), 'waiting on an agent');
    const updates = eventsDigest(store.eventsSince(boardId, since), board.seq, { board, viewer: 'Claude' });
    assert.ok(updates.includes(`started thread "Can we bundle Pi in the app?" [thread id: ${thread.id}]: "Can we bundle Pi in the app?". For any agent: the first to reply answers, with reply_in_thread(thread_id: ${thread.id}). ${through}`), updates);
    const digest = boardDigest(board, 'Claude');
    assert.ok(digest.includes(`- thread "Can we bundle Pi in the app?" [thread id: ${thread.id}] · Legal lens: "${legal}" · 1 message`), digest);
    assert.match(threadDetail(board, thread, 'Claude'), new RegExp(`\\nLens: Legal\\. Answer through it: ${legal.replace(/[.?]/g, '\\$&')}\\n`));

    const before = board.seq;
    store.setThreadLens(thread.id, { name: 'Design' }, wassim);
    const design = LENSES.find((l) => l.name === 'Design')!.brief!;
    const changed = eventsDigest(store.eventsSince(boardId, before), board.seq, { board, viewer: 'Claude' });
    assert.equal(
      changed.split('\n')[0],
      `- (${before + 1}) Wassim (human) set the lens of thread "Can we bundle Pi in the app?" to Design [thread id: ${thread.id}]. Answer through its Design lens: ${design}`,
    );
    store.setThreadLens(thread.id, null, wassim);
    assert.match(threadDetail(board, thread, 'Claude'), /\nLens: General\.\n/);
    assert.doesNotMatch(threadsDigest(board, 'Claude')!, /Answer through/, 'General has no brief');
  });

  it('routes a person\'s message that mentions nobody to the lens\'s agent: "asked you" for it, "for Codex" for others', () => {
    const board = store.getBoard(boardId);
    store.postDecision(boardId, { question: 'Which shell?' }, sam); // Sam is one of the board's people
    const since = board.seq;
    const thread = store.startThread(boardId, 'Is the Pi licence fine to ship?', wassim, { name: 'Legal', agent: 'Codex' });
    assert.deepEqual(threadWaiting(board, thread)?.agents, ['Codex']);
    const events = store.eventsSince(boardId, since);
    assert.match(eventsDigest(events, board.seq, { board, viewer: 'Codex' }), /Wassim \(human\) asked you in thread "Is the Pi licence fine to ship\?" .+ Answer through its Legal lens/);
    assert.match(eventsDigest(events, board.seq, { board, viewer: 'Claude' }), /Wassim \(human\) asked Codex in thread "Is the Pi licence fine to ship\?" \[thread id: \w+\]\. Not for you; carry on\./);
    assert.equal(threadsDigest(board, 'Claude'), undefined, "Codex's");
    assert.match(threadsDigest(board, 'Codex')!, /^Wassim asked you in thread/);
    assert.match(threadDetail(board, thread, 'Claude'), /Routed to Codex: a person's message that @-mentions nobody is for Codex\.\n/);

    store.postToThread(thread.id, 'I can take a look too.', claude);
    assert.deepEqual(threadWaiting(board, thread)?.agents, ['Codex'], "an agent's message isn't routed, and Claude's doesn't answer Codex's");
    store.postToThread(thread.id, 'Yes: MIT. Keep its notice.', codex);
    assert.equal(threadWaiting(board, thread), undefined);
    store.postToThread(thread.id, '@Claude can you check the logins?', wassim);
    assert.deepEqual(threadWaiting(board, thread)?.agents, ['Claude'], 'a mention goes where it says');
    store.postToThread(thread.id, '@Sam do you know?', wassim);
    assert.equal(threadWaiting(board, thread), undefined, 'one for a person waits on them');
  });
});

describe('What a thread leads to', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-thread-work-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Desktop app' }, wassim).id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('shows work made ahead of a reply under that reply, and work made after it under it too', () => {
    const board = store.getBoard(boardId);
    const thread = store.startThread(boardId, 'Can we bundle Pi?', wassim, { name: 'Legal' });
    const decision = store.postDecision(boardId, { question: 'Which logins can Pi use?', options: [{ label: 'API keys' }, { label: 'Subscriptions too' }] }, claude);
    store.addThreadWork(thread.id, { kind: 'decision', id: decision.id }, claude);
    assert.deepEqual(decision.fromThread, { id: thread.id, title: 'Can we bundle Pi?' });
    assert.deepEqual(thread.pending, [{ kind: 'decision', id: decision.id, by: claude }], 'waits for the reply');
    const [task] = store.planTasks(boardId, [{ title: 'Bundle Pi with its notice' }], codex);
    store.addThreadWork(thread.id, { kind: 'task', id: task.id }, codex);

    store.postToThread(thread.id, 'Bundling is fine; the logins are your call, so I posted #1.', claude);
    assert.deepEqual(thread.messages[1].refs, [{ kind: 'decision', id: decision.id }]);
    assert.deepEqual(thread.pending, [{ kind: 'task', id: task.id, by: codex }], "Codex's waits for Codex's reply");

    const block = store.addBlock({ boardId }, { content: { type: 'note', text: 'Pi is MIT: keep its notice.' }, title: 'Licences' }, claude);
    store.addThreadWork(thread.id, { kind: 'block', id: block.id }, claude);
    store.updateBlock(block.id, { text: 'Pi is MIT: keep its notice in the About box.' }, claude);
    store.addThreadWork(thread.id, { kind: 'block', id: block.id }, claude);
    assert.deepEqual(thread.messages[1].refs, [{ kind: 'decision', id: decision.id }, { kind: 'block', id: block.id }], 'after its reply, under it, once');
    assert.equal(block.type === 'note' && block.text, 'Pi is MIT: keep its notice in the About box.');

    store.resolve(decision.id, { optionId: 'a', rationale: 'Keys only for now.' }, wassim);
    assert.equal(threadWork(board, { kind: 'decision', id: decision.id }).kind, 'decision');
    const detail = threadDetail(board, thread, 'Claude');
    assert.ok(detail.includes(`  Led to: #1 [id: ${decision.id}] "Which logins can Pi use?" (decided); note "Licences" [id: ${block.id}] on the board context`), detail);
    assert.ok(detail.endsWith(`- Codex (agent) made, ahead of a reply: T1 [id: ${task.id}] "Bundle Pi with its notice" (to do)`), detail);
    assert.match(decisionDetail(board, decision), new RegExp(`\\nFrom thread "Can we bundle Pi\\?" \\[thread id: ${thread.id}\\]: read it with get_thread\\.\\n`));
    assert.match(taskDetail(board, task), /\nFrom thread "Can we bundle Pi\?" \[thread id: \w+\]: read it with get_thread\.$/m);

    store.removeItem(block.id, wassim);
    assert.equal(threadWork(board, { kind: 'block', id: block.id }).kind, 'gone');
    assert.ok(threadDetail(board, thread).includes('; a block since removed'));
  });

  it('shows the cards a reply names, and takes one the agent made since the thread started as made from it', () => {
    const board = store.getBoard(boardId);
    const older = store.postDecision(boardId, { question: 'Which shell?' }, claude);
    const thread = store.startThread(boardId, 'What is left before the desktop app?', wassim);
    const posted = store.postDecision(boardId, { question: 'Who holds the signing key?' }, claude);
    const theirs = store.postDecision(boardId, { question: 'Which updater?' }, codex);
    const [task] = store.planTasks(boardId, [{ title: 'Sign the app' }], claude);
    const block = store.addBlock({ decisionId: posted.id }, { content: { type: 'note', text: 'Keys live in 1Password.' } }, claude);
    store.postToThread(thread.id, 'Signing and the updater: #2, T1, and #1 settled the shell.', claude, ['#2', 't1', older.id, theirs.id, block.id, '#2']);
    assert.deepEqual(thread.messages[1].refs, [
      { kind: 'decision', id: posted.id },
      { kind: 'task', id: task.id },
      { kind: 'decision', id: older.id },
      { kind: 'decision', id: theirs.id },
      { kind: 'block', id: block.id },
    ]);
    assert.deepEqual(posted.fromThread, { id: thread.id, title: 'What is left before the desktop app?' });
    assert.deepEqual(task.fromThread, posted.fromThread);
    assert.equal(older.fromThread, undefined, 'made before the thread');
    assert.equal(theirs.fromThread, undefined, "another agent's");
    assert.match(threadDetail(board, thread), /note "Keys live in 1Password\." \[id: \w+\] on #2's canvas/);
    // A task written with a hash, as people may write it.
    store.postToThread(thread.id, 'And #T1 is next.', claude, ['#T1']);
    assert.deepEqual(thread.messages.at(-1)!.refs, [{ kind: 'task', id: task.id }]);

    const before = thread.messages.length;
    assert.throws(() => store.postToThread(thread.id, 'See #9.', claude, ['#9']), /No decision, task or block "#9" on Desktop app to show in the thread\. Pass ids, #N or TN\./);
    assert.equal(thread.messages.length, before, 'nothing posted when refused');
    const other = store.createBoard({ title: 'Website' }, wassim);
    assert.throws(() => store.threadOn(thread.id, store.getBoard(other.id)), /Thread "\w+" is on Desktop app, not Website: pass the thread you're answering on this board\./);
  });
});

describe('Deleting a thread, and the General thread', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-thread-delete-'));
    store = new Store(dir);
    store.load();
    store.presentAgents = () => ['Claude', 'Codex'];
    boardId = store.createBoard({ title: 'Desktop app' }, wassim).id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets a person delete a thread, keeps what it led to, and brings it back as it was', async () => {
    const board = store.getBoard(boardId);
    const first = store.startThread(boardId, 'What is left?', wassim);
    const thread = store.startThread(boardId, 'Can we bundle Pi?', wassim, { name: 'Legal' });
    const last = store.startThread(boardId, 'Is onboarding clear?', wassim);
    const decision = store.postDecision(boardId, { question: 'Which logins can Pi use?' }, claude);
    store.addThreadWork(thread.id, { kind: 'decision', id: decision.id }, claude);
    store.postToThread(thread.id, 'Posted #1.', claude);

    assert.throws(() => store.removeItem(thread.id, claude), /Only people delete a thread, so "Can we bundle Pi\?" stays\. If it looks done, say so in it\./);
    const deletion = store.removeItem(thread.id, wassim);
    assert.deepEqual([deletion.id, deletion.kind, deletion.label], [thread.id, 'thread', 'thread "Can we bundle Pi?"']);
    assert.deepEqual(board.threads!.map((t) => t.id), [first.id, last.id]);
    const deleted = eventsOf(store, board).at(-1)!;
    assert.deepEqual([deleted.type, deleted.summary, deleted.itemId, deletion.seq], ['thread_deleted', 'deleted thread "Can we bundle Pi?"', thread.id, deleted.seq]);
    assert.throws(() => store.getThread(thread.id), (e: Error & { code?: string }) => e.code === 'not_found');
    assert.equal(board.decisions[0].question, 'Which logins can Pi use?', 'what it led to stays');
    assert.match(decisionDetail(board, decision), /\nFrom thread "Can we bundle Pi\?", since deleted\.$/m);
    assert.match(boardDigest(board, 'Claude'), new RegExp(`\\nDeleted lately: thread "Can we bundle Pi\\?" by Wassim, just now \\[id: ${thread.id}\\]\\. restore_item puts one back\\.`));

    // Kept across a restart, and back where it was, with all it said.
    await store.flush();
    const again = new Store(dir);
    again.load();
    const { deletion: back, notes } = again.restoreItem(thread.id, claude);
    assert.deepEqual([back.kind, notes], ['thread', []]);
    const restored = again.getBoard(boardId);
    assert.deepEqual(restored.threads!.map((t) => t.id), [first.id, thread.id, last.id]);
    const thatThread = again.getThread(thread.id).thread;
    assert.deepEqual([thatThread.lens?.name, thatThread.messages.length, thatThread.messages[1].refs], ['Legal', 2, [{ kind: 'decision', id: decision.id }]]);
    assert.equal(eventsOf(again, restored).at(-1)!.summary, 'restored thread "Can we bundle Pi?"');
    assert.equal(eventsOf(again, restored).at(-1)!.type, 'thread_restored');
    assert.match(decisionDetail(restored, restored.decisions[0]), /\nFrom thread "Can we bundle Pi\?" \[thread id: \w+\]: read it with get_thread\.$/m);
    assert.throws(() => again.restoreItem(thread.id, wassim), /Thread "Can we bundle Pi\?" was already restored by Claude/);
    again.postToThread(thread.id, 'Thanks.', wassim);
    again.setArchived(boardId, true, wassim);
    assert.throws(() => again.removeItem(thread.id, wassim), /archived by Wassim/);
    await again.flush();
  });

  it('posts what people ask from the Board Context in the General thread, which the first ask starts', () => {
    const board = store.getBoard(boardId);
    const general = store.askInGeneral(boardId, 'Get me an architecture view of the project', wassim);
    assert.deepEqual([general.title, general.general, general.lens], ['General', true, undefined]);
    assert.equal(eventsOf(store, board).at(-1)!.summary, 'started thread "General"');
    const forClaude = threadsDigest(board, 'Claude')!;
    assert.ok(
      forClaude.endsWith(`It's the board's General thread, where people ask from the Board Context: for a view of the project, answer with blocks on the board context (add_block with board_id and thread_id: ${general.id}), then reply.`),
      forClaude,
    );
    assert.match(boardDigest(board, 'Claude'), /\[thread id: \w+\] · the General thread, where people ask from the Board Context · General lens/);

    store.postToThread(general.id, 'Added it as a diagram.', claude);
    assert.equal(store.askInGeneral(boardId, '@Codex what is left to build?', wassim), general, 'the same thread');
    assert.deepEqual(threadWaiting(board, general)?.agents, ['Codex']);
    assert.equal(board.requests, undefined, 'no request any more');
    assert.throws(() => store.askInGeneral(boardId, 'Hi', claude), /Only people ask from the Board Context; answer in the General thread with reply_in_thread\./);

    store.removeItem(general.id, wassim);
    const next = store.askInGeneral(boardId, 'Draw a timeline', wassim);
    assert.notEqual(next.id, general.id, 'a deleted one is started again');
    store.restoreItem(general.id, wassim);
    assert.equal(store.askInGeneral(boardId, 'And the risks?', wassim), next, 'the latest General thread');
  });
});

// Two agents and a person talking in threads, over MCP and REST.
describe('Threads over MCP and REST', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: Store;
  const clients: Record<'Claude' | 'Codex', Client> = {} as never;
  type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

  async function call(agent: 'Claude' | 'Codex', name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return (await clients[agent].callTool({ name, arguments: args })) as ToolResult;
  }

  async function callText(agent: 'Claude' | 'Codex', name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await call(agent, name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content.map((c) => c.text).join('\n');
  }

  async function request(method: 'GET' | 'POST', route: string, body?: Record<string, unknown>) {
    const response = await fetch(`${base}/api${route}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, json: await response.json() };
  }

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-threads-mcp-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const agent of ['Claude', 'Codex'] as const) {
      clients[agent] = new Client({ name: 'test-client', version: '1.0.0' });
      await clients[agent].connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=${agent}`)));
    }
  });

  after(async () => {
    for (const client of Object.values(clients)) await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets a person start a thread over REST and an agent hear it, read it and reply', async () => {
    const boardId = (await request('POST', '/boards', { actor: 'Wassim', title: 'Desktop app' })).json.id as string;
    await callText('Claude', 'get_board', { board_id: boardId });
    const since = store.getBoard(boardId).seq;
    const started = await request('POST', `/boards/${boardId}/threads`, { actor: 'Wassim', body: 'Can we bundle Pi in the app?' });
    assert.equal(started.status, 201);
    const threadId = started.json.id as string;
    assert.equal(started.json.title, 'Can we bundle Pi in the app?');

    const heard = await callText('Claude', 'wait_for_updates', { board_id: boardId, since, timeout_seconds: 1 });
    const anyAgent = `For any agent: the first to reply answers, with reply_in_thread(thread_id: ${threadId}).`;
    assert.ok(heard.includes(`Wassim (human) started thread "Can we bundle Pi in the app?" [thread id: ${threadId}]: "Can we bundle Pi in the app?". ${anyAgent}`), heard);
    assert.ok(!heard.includes('Wassim wrote in thread'), 'what waits on an agent leaves out what the update above gave');

    const read = await callText('Claude', 'get_thread', { thread_id: threadId });
    assert.match(read, new RegExp(`^# Thread "Can we bundle Pi in the app\\?" \\[thread id: ${threadId}\\]\\nStarted by Wassim \\(human\\)`));
    assert.match(read, /It waits on an agent: the first to reply answers, with reply_in_thread/);
    assert.match(read, /## Messages \(1\)\n- Wassim \(human\) at \S+ \[message id: \w+\]: Can we bundle Pi in the app\?/);

    const replied = await callText('Claude', 'reply_in_thread', { thread_id: threadId, body: 'Yes: Pi is MIT. Logins are the catch; posted #1.' });
    assert.match(replied, /^Replied in thread "Can we bundle Pi in the app\?" \(2 messages\)\. People see it in the thread\./);
    assert.doesNotMatch(await callText('Codex', 'get_board', { board_id: boardId }), /Wassim wrote in thread/, 'answered by the first to reply');

    const listed = await request('GET', `/boards/${boardId}/threads`);
    assert.equal(listed.json.length, 1);
    const got = await request('GET', `/threads/${threadId}`);
    assert.deepEqual(got.json.messages.map((m: { author: Actor }) => m.author.name), ['Wassim', 'Claude']);
    const posted = await request('POST', `/threads/${threadId}/messages`, { actor: 'Wassim', body: '@Codex can you check the licence too?' });
    assert.equal(posted.status, 200);
    assert.deepEqual(posted.json.messages.at(-1).mentions, ['Codex']);
    assert.equal((await request('GET', '/threads/nope')).status, 404);
    assert.equal((await request('POST', '/threads/nope/messages', { actor: 'Wassim', body: 'Hi' })).status, 404);
    assert.equal((await request('POST', `/boards/${boardId}/threads`, { actor: 'Wassim', body: ' ' })).status, 400);
  });

  it('routes a mention to that agent: "asked you" for it, "for Codex" for the other', async () => {
    const boardId = (await request('POST', '/boards', { actor: 'Wassim', title: 'Licences' })).json.id as string;
    await callText('Claude', 'get_board', { board_id: boardId });
    await callText('Codex', 'get_board', { board_id: boardId });
    const since = store.getBoard(boardId).seq;
    const threadId = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Wassim', body: '@Codex is the Pi licence fine to ship?' })).json.id;

    const forCodex = await callText('Codex', 'get_updates', { board_id: boardId, since });
    const asked = `asked you in thread "Is the Pi licence fine to ship?" [thread id: ${threadId}]: "is the Pi licence fine to ship?". Reply with reply_in_thread(thread_id: ${threadId}).`;
    assert.match(forCodex, /- \(\d+\) Wassim \(human\) asked you in thread "Is the Pi licence fine to ship\?"/);
    assert.ok(forCodex.includes(`Wassim (human) ${asked}`), forCodex);
    assert.equal(forCodex.split(asked).length, 2, 'said once');
    const forClaude = await callText('Claude', 'wait_for_updates', { board_id: boardId, since, timeout_seconds: 1 });
    assert.match(forClaude, new RegExp(`- \\(\\d+\\) Wassim \\(human\\) asked Codex in thread "Is the Pi licence fine to ship\\?" \\[thread id: ${threadId}\\]\\. Not for you; carry on\\.`));
    assert.doesNotMatch(forClaude, /asked you/);
    assert.match(await callText('Claude', 'get_board', { board_id: boardId }), /· waits on Codex/);
    assert.match(await callText('Claude', 'get_thread', { thread_id: threadId }), /It waits on Codex: not for you; carry on\.\n[\s\S]*- Wassim \(human\) at \S+ \[message id: \w+\] \(for Codex: not for you\): @Codex is the Pi licence/);
    assert.match(await callText('Codex', 'get_thread', { thread_id: threadId }), /It waits on you: answer Wassim's latest with reply_in_thread/);

    await callText('Codex', 'reply_in_thread', { thread_id: threadId, body: 'Yes: MIT, keep its notice.' });
    assert.doesNotMatch(await callText('Codex', 'get_board', { board_id: boardId }), /asked you/, 'answered');
  });

  it('lets an agent start a thread, lists it in get_board, and refuses unknown ids and archived boards', async () => {
    const boardId = (await request('POST', '/boards', { actor: 'Wassim', title: 'Updater' })).json.id as string;
    const opened = await callText('Claude', 'start_thread', { board_id: boardId, body: 'Heads-up: the updater needs a signing key. Who holds it?' });
    const threadId = opened.match(/\[thread id: (\w+)\]/)![1];
    assert.match(opened, /^Started thread "Heads-up: the updater needs a signing key\." \[thread id: \w+\]\. People see it under Threads/);
    assert.equal(eventsOf(store, boardId).at(-1)!.summary, 'started thread "Heads-up: the updater needs a signing key."');
    const board = await callText('Codex', 'get_board', { board_id: boardId });
    assert.match(board, new RegExp(`## Threads \\(1\\)\\n.+\\n- thread "Heads-up: the updater needs a signing key\\." \\[thread id: ${threadId}\\] · General lens · 1 message · last by Claude \\(agent\\)`));
    assert.doesNotMatch(board, /waits on/, "an agent's thread waits on people");

    for (const [name, args, refused] of [
      ['get_thread', { thread_id: 'nope' }, /No thread with id "nope"/],
      ['reply_in_thread', { thread_id: 'nope', body: 'Hi' }, /No thread with id "nope"/],
      ['start_thread', { board_id: 'nope', body: 'Hi' }, /No board with id "nope"/],
      ['reply_in_thread', { thread_id: threadId, body: '  ' }, /A message must not be empty/],
    ] as const) {
      const result = await call('Codex', name, args);
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text, refused);
    }

    await request('POST', `/boards/${boardId}/archive`, { actor: 'Wassim' });
    for (const [name, args] of [
      ['reply_in_thread', { thread_id: threadId, body: 'Wassim holds it.' }],
      ['start_thread', { board_id: boardId, body: 'Another' }],
    ] as const) {
      const result = await call('Codex', name, args);
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text, /archived by Wassim, so it is read-only/);
    }
    const archived = await request('POST', `/threads/${threadId}/messages`, { actor: 'Wassim', body: 'Me.' });
    assert.equal(archived.status, 400);
    assert.match(await callText('Codex', 'get_thread', { thread_id: threadId }), /## Messages \(1\)/, 'still readable');
  });

  it('sets a lens over REST and from start_thread, and routes by it', async () => {
    const boardId = (await request('POST', '/boards', { actor: 'Wassim', title: 'Lenses' })).json.id as string;
    await callText('Claude', 'get_board', { board_id: boardId });
    await callText('Codex', 'get_board', { board_id: boardId });
    const started = await request('POST', `/boards/${boardId}/threads`, { actor: 'Wassim', body: 'Is the login flow safe?', lens: { name: 'Security', agent: 'Codex' } });
    assert.equal(started.status, 201);
    const security = LENSES.find((l) => l.name === 'Security')!.brief!;
    assert.deepEqual(started.json.lens, { name: 'Security', brief: security, agent: 'Codex' });
    const threadId = started.json.id as string;
    assert.match(await callText('Codex', 'get_board', { board_id: boardId }), /Wassim asked you in thread "Is the login flow safe\?" .+ Answer through its Security lens: Look for ways/);
    assert.doesNotMatch(await callText('Claude', 'get_board', { board_id: boardId }), /Wassim asked you/);

    const since = store.getBoard(boardId).seq;
    const own = { name: 'Onboarding', brief: 'Answer as someone opening the app for the first time.' };
    const changed = await request('POST', `/threads/${threadId}/lens`, { actor: 'Wassim', lens: own });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.json.lens, own);
    const heard = await callText('Claude', 'get_updates', { board_id: boardId, since });
    assert.ok(heard.includes(`Wassim (human) set the lens of thread "Is the login flow safe?" to Onboarding [thread id: ${threadId}]. Answer through its Onboarding lens: ${own.brief}`), heard);
    assert.match(heard, /\nWassim wrote in thread "Is the login flow safe\?" .+: "Is the login flow safe\?"\. For any agent: .+ Answer through its Onboarding lens/, 'no longer routed');
    // Claude has it now: get_board names it, without the message or the lens again.
    assert.match(
      await callText('Claude', 'get_board', { board_id: boardId }),
      new RegExp(`\\nWassim wrote in thread "Is the login flow safe\\?" \\[thread id: ${threadId}\\] \\(you've seen it\\)\\. For any agent: the first to reply answers, with reply_in_thread\\(thread_id: ${threadId}\\)\\.\\n`),
    );
    assert.equal((await request('POST', `/threads/${threadId}/lens`, { actor: 'Wassim', lens: { name: 'Pricing' } })).status, 400);
    assert.equal((await request('POST', `/threads/${threadId}/lens`, { actor: 'Wassim', lens: null })).json.lens, undefined);
    assert.equal((await request('POST', '/threads/nope/lens', { actor: 'Wassim', lens: null })).status, 404);

    const opened = await callText('Claude', 'start_thread', { board_id: boardId, body: 'Heads-up: the board payload is 1.4 MB.', lens: 'performance' });
    assert.match(opened, /^Started thread "Heads-up: the board payload is 1\.4 MB\." \[thread id: \w+\], through the Performance lens\./);
    const mine = await callText('Claude', 'start_thread', { board_id: boardId, body: 'Is the copy plain enough?', lens: 'Copy', lens_brief: 'Read it as a newcomer would.' });
    const mineId = mine.match(/\[thread id: (\w+)\]/)![1];
    assert.match(await callText('Codex', 'get_thread', { thread_id: mineId }), /\nLens: Copy\. Answer through it: Read it as a newcomer would\.\n/);
    for (const [args, refused] of [
      [{ board_id: boardId, body: 'Hi', lens: 'Copy' }, /A lens of your own needs a brief/],
      [{ board_id: boardId, body: 'Hi', lens_brief: 'Read it.' }, /Pass lens_brief with lens/],
    ] as const) {
      const result = await call('Claude', 'start_thread', args);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, refused);
    }
  });

  it('shows what an agent makes answering a thread under its reply, and links it back', async () => {
    const boardId = (await request('POST', '/boards', { actor: 'Wassim', title: 'Pi in the app' })).json.id as string;
    const threadId = (await request('POST', `/boards/${boardId}/threads`, { actor: 'Wassim', body: 'Can we bundle Pi?', lens: { name: 'Legal' } })).json.id as string;
    const posted = await callText('Claude', 'post_decision', {
      board_id: boardId,
      question: 'Which logins can built-in Pi use?',
      options: [{ label: 'API keys and local models' }, { label: 'Also subscriptions' }],
      thread_id: threadId,
    });
    assert.match(posted, /^Posted #1 \[id: \w+\] \(status: open\)\. It shows in thread "Can we bundle Pi\?", under your reply\. Keep working/);
    const decisionId = posted.match(/\[id: (\w+)\]/)![1];
    const planned = await callText('Claude', 'plan_tasks', { board_id: boardId, tasks: [{ title: 'Ship the Pi notice' }, { title: 'Key settings' }], thread_id: threadId });
    assert.match(planned, /\. They show in thread "Can we bundle Pi\?", under your reply\. claim_task/);
    const added = await callText('Claude', 'add_block', { board_id: boardId, type: 'note', title: 'Licences', text: 'Pi is MIT.', thread_id: threadId });
    const blockId = added.match(/\[id: (\w+)\]/)![1];
    assert.match(await callText('Claude', 'comment', { decision_id: decisionId, body: 'Subscriptions need approval.', thread_id: threadId }), /^Commented on #1\. It shows in thread/);

    const replied = await callText('Claude', 'reply_in_thread', { thread_id: threadId, body: 'Bundling is fine; logins are your call: #1.' });
    assert.match(replied, /^Replied in thread "Can we bundle Pi\?" \(2 messages\), with #1, T1, T2, note "Licences" and your comment on #1 under it\. People see it in the thread\./);
    const thread = store.getThread(threadId).thread;
    assert.deepEqual(thread.messages[1].refs!.map((r) => r.kind), ['decision', 'task', 'task', 'block', 'comment']);
    assert.equal(thread.pending, undefined);
    const updated = await callText('Claude', 'update_block', { block_id: blockId, rev: 1, text: 'Pi is MIT: keep its notice.', thread_id: threadId });
    assert.match(updated, /^Updated note "Licences" \[id: \w+\] \(now rev 2\)\. It shows in thread "Can we bundle Pi\?", under your reply\./);
    assert.equal(thread.messages[1].refs!.length, 5, 'shown once');

    assert.match(await callText('Codex', 'get_decision', { decision_id: decisionId }), new RegExp(`\\nFrom thread "Can we bundle Pi\\?" \\[thread id: ${threadId}\\]: read it with get_thread\\.`));
    const taskId = store.getBoard(boardId).tasks[0].id;
    assert.match(await callText('Codex', 'get_task', { task_id: taskId }), /\nFrom thread "Can we bundle Pi\?" \[thread id: \w+\]/);
    assert.match(await callText('Codex', 'get_thread', { thread_id: threadId }), /\n {2}Led to: #1 \[id: \w+\] "Which logins can built-in Pi use\?" \(open\); T1 .+ \(to do\); T2 .+; note "Licences" \[id: \w+\] on the board context; a comment on #1/);
    assert.equal((await request('GET', `/boards/${boardId}`)).json.decisions[0].fromThread.id, threadId, 'people get it with the board');

    const again = await callText('Codex', 'reply_in_thread', { thread_id: threadId, body: 'And #1 covers keys.', refs: ['#1', blockId] });
    assert.match(again, /\(3 messages\), with #1 and note "Licences" under it\./);
    const other = (await request('POST', '/boards', { actor: 'Wassim', title: 'Website' })).json.id as string;
    for (const [name, args, refused] of [
      ['post_decision', { board_id: other, question: 'Which host?', thread_id: threadId }, /is on Pi in the app, not Website/],
      ['comment', { pin_id: 'p1', body: 'Hi', thread_id: threadId }, /Pass thread_id with decision_id or task_id/],
      ['reply_in_thread', { thread_id: threadId, body: 'See T9.', refs: ['T9'] }, /No decision, task or block "T9"/],
      ['post_decision', { board_id: boardId, question: 'Which host?', thread_id: 'nope' }, /No thread with id "nope"/],
    ] as const) {
      const result = await call('Claude', name, args);
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text, refused);
    }
    assert.equal(store.getBoard(other).decisions.length, 0, 'nothing posted when refused');
    assert.equal(store.getBoard(boardId).decisions.length, 1);
  });

  it('lets a person delete a thread over REST, not an agent, and either bring it back; asks go to the General thread', async () => {
    const boardId = (await request('POST', '/boards', { actor: 'Wassim', title: 'Ask agents' })).json.id as string;
    await callText('Claude', 'get_board', { board_id: boardId });
    const since = store.getBoard(boardId).seq;
    const asked = await request('POST', `/boards/${boardId}/threads/general`, { actor: 'Wassim', body: 'Get me an architecture view of the project' });
    assert.equal(asked.status, 201);
    assert.deepEqual([asked.json.title, asked.json.general], ['General', true]);
    const generalId = asked.json.id as string;
    const heard = await callText('Claude', 'wait_for_updates', { board_id: boardId, since, timeout_seconds: 1 });
    assert.match(heard, /Wassim \(human\) started thread "General" \[thread id: \w+\]: "Get me an architecture view of the project"\. For any agent: .+ It's the board's General thread/);
    assert.equal((await request('POST', `/boards/${boardId}/threads/general`, { actor: 'Wassim', body: 'And the risks?' })).json.id, generalId);
    assert.equal(store.getBoard(boardId).requests, undefined);

    const removed = await call('Claude', 'remove_item', { id: generalId });
    assert.equal(removed.isError, true);
    assert.match(removed.content[0].text, /Only people delete a thread/);
    const deleted = await request('POST', `/canvas/items/${generalId}/delete`, { actor: 'Wassim' });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.json.deleted, { id: generalId, kind: 'thread', label: 'thread "General"' });
    const board = (await request('GET', `/boards/${boardId}`)).json;
    assert.deepEqual(board.threads, []);
    assert.equal(board.deleted[0].kept, undefined, "people's copy keeps what was deleted to itself");
    assert.match(await callText('Codex', 'get_board', { board_id: boardId }), /## Threads \(0\)\n.+\nDeleted lately: thread "General" by Wassim, just now \[id: \w+\]\. restore_item puts one back\./);
    assert.match(await callText('Codex', 'restore_item', { id: generalId }), /^Restored thread "General" \[thread id: \w+\], with its messages\. People see it under Threads again\./);
    assert.equal(store.getThread(generalId).thread.messages.length, 2);
    await request('POST', `/canvas/items/${generalId}/delete`, { actor: 'Wassim' });
    const back = await request('POST', `/canvas/items/${generalId}/restore`, { actor: 'Wassim' });
    assert.deepEqual(back.json, { restored: { id: generalId, kind: 'thread', label: 'thread "General"' }, notes: [] });
    assert.equal((await request('POST', `/boards/${boardId}/threads/general`, { actor: 'Wassim', body: ' ' })).status, 400);
  });
});
