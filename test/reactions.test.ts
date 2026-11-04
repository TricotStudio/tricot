import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { needsInput, unseenBy } from '../src/core/attention';
import { eventsDigest, taskDetail } from '../src/core/digest';
import { pendingAsks } from '../src/core/format';
import { asksYou, mentionsDigest } from '../src/core/mentions';
import { needsFrom } from '../src/core/needs';
import { reactionGroups } from '../src/core/reactions';
import { Store } from '../src/core/store';
import { threadWaiting } from '../src/core/threads';
import type { Actor } from '../src/core/types';
import { createApp } from '../src/server/app';
import { eventsOf } from './tables';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };
const wassim: Actor = { kind: 'human', name: 'Wassim' };
const sam: Actor = { kind: 'human', name: 'Sam' };

const who = (reactions: { by: Actor }[] | undefined) => (reactions ?? []).map((r) => r.by.name);

describe('Reactions on comments', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-reactions-'));
    store = new Store(dir);
    store.load();
    store.presentAgents = () => ['Claude', 'Codex'];
    boardId = store.createBoard({ title: 'Roadmap' }, wassim).id;
    store.createBoard({ title: 'Other' }, sam); // Sam is a person the board knows
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const board = () => store.getBoard(boardId);
  const task = (title = 'Emoji reactions on comments') => store.planTasks(boardId, [{ title }], wassim, { ready: true })[0];
  const comments = (taskId: string) => store.getTask(taskId).task.comments;

  it('keeps one of each per person, and takes it back when they react again', () => {
    const t = task();
    store.addTaskComment(t.id, 'The mock is on the canvas.', claude);
    const [comment] = comments(t.id);
    store.react({ taskId: t.id }, { commentId: comment.id, emoji: '👍' }, wassim);
    store.react({ taskId: t.id }, { commentId: comment.id, emoji: '👍' }, sam);
    const again = store.react({ taskId: t.id }, { commentId: comment.id, emoji: '👍' }, wassim);
    assert.equal(again.changed, false, 'one 👍 each');
    store.react({ taskId: t.id }, { commentId: comment.id, emoji: '👀' }, wassim);
    assert.deepEqual(
      reactionGroups(comments(t.id)[0].reactions).map((g) => [g.emoji, who(g.reactions)]),
      [['👍', ['Wassim', 'Sam']], ['👀', ['Wassim']]],
      'by emoji, in the picker order',
    );
    assert.ok(comments(t.id)[0].reactions!.every((r) => r.at), 'each says when');

    store.react({ taskId: t.id }, { commentId: comment.id, emoji: '👍', remove: true }, wassim);
    assert.deepEqual(who(comments(t.id)[0].reactions), ['Sam', 'Wassim'], 'their 👍 is gone, their 👀 stays');
    const nothing = store.react({ taskId: t.id }, { commentId: comment.id, emoji: '👎', remove: true }, wassim);
    assert.equal(nothing.changed, false);
  });

  it('takes only 👍, 👎 and 👀, on someone else\'s comment, on a board that is not archived', () => {
    const t = task();
    store.addTaskComment(t.id, 'Mine', wassim);
    const [mine] = comments(t.id);
    assert.throws(() => store.react({ taskId: t.id }, { commentId: mine.id, emoji: '🎉' as never }, sam), /React with 👍, 👎 or 👀\./);
    assert.throws(() => store.react({ taskId: t.id }, { commentId: mine.id, emoji: '👍' }, wassim), /That's your own comment: react to someone else's\./);
    assert.throws(() => store.react({ taskId: t.id }, { commentId: 'nope', emoji: '👍' }, sam), /No comment or message "nope" on T1\./);
    store.setArchived(boardId, true, wassim);
    assert.throws(() => store.react({ taskId: t.id }, { commentId: mine.id, emoji: '👍' }, sam), /archived/i);
  });

  it('reacts to the latest comment by someone else when none is named', () => {
    const t = task();
    store.addTaskComment(t.id, 'First', wassim);
    store.addTaskComment(t.id, 'Second', wassim);
    store.addTaskComment(t.id, 'My own', claude);
    const { item } = store.react({ taskId: t.id }, { emoji: '👍' }, claude);
    assert.equal(item.body, 'Second');
    const fresh = task('Nothing yet');
    assert.throws(() => store.react({ taskId: fresh.id }, { emoji: '👍' }, claude), /Nobody else has written on T2 yet/);
  });

  it('works on a decision, in a thread, and on a pinned part of the board context', () => {
    const decision = store.postDecision(boardId, { question: 'Which emojis?', options: [{ label: 'Three' }, { label: 'Any' }] }, claude);
    store.addComment(decision.id, 'Three keeps it simple.', claude);
    store.react({ decisionId: decision.id }, { emoji: '👎' }, wassim);
    assert.deepEqual(who(store.getDecision(decision.id).decision.comments[0].reactions), ['Wassim']);

    const thread = store.startThread(boardId, 'Can agents react too?', wassim);
    store.postToThread(thread.id, 'Yes, with react.', claude);
    store.react({ threadId: thread.id }, { emoji: '👍' }, wassim);
    assert.deepEqual(who(store.getThread(thread.id).thread.messages[1].reactions), ['Wassim']);

    const note = store.addBlock({ boardId }, { content: { type: 'note', text: 'Reactions live on the comment.' } }, wassim);
    const { pin } = store.pinComment(note.id, { kind: 'block' }, 'Is that enough?', wassim);
    store.commentOnPin(pin.id, 'It is: nothing else stores them.', claude);
    store.react({ pinId: pin.id }, { emoji: '👀' }, wassim);
    assert.deepEqual(who(store.getBoard(boardId).canvas.pins[0].discussion!.thread![1].reactions), ['Wassim']);
  });

  it("drops an agent's 👀 when it answers with 👍 or 👎, and leaves a person's", () => {
    const t = task();
    store.addTaskComment(t.id, 'Use the eye emoji.', wassim);
    store.seeComments(boardId, claude, eventsOf(store, board()));
    assert.deepEqual(comments(t.id)[0].reactions?.map((r) => r.emoji), ['👀']);
    store.react({ taskId: t.id }, { emoji: '👍' }, claude);
    assert.deepEqual(comments(t.id)[0].reactions?.map((r) => r.emoji), ['👍']);
    store.react({ taskId: t.id }, { emoji: '👀' }, sam);
    store.react({ taskId: t.id }, { emoji: '👍' }, sam);
    assert.deepEqual(comments(t.id)[0].reactions?.map((r) => `${r.by.name} ${r.emoji}`), ['Claude 👍', 'Sam 👀', 'Sam 👍']);
  });

  describe("an agent's 👀 when what a person wrote reaches it", () => {
    it('shows on the comments its updates carry, once, without logging anything', () => {
      const t = task();
      store.addTaskComment(t.id, 'For whoever picks this up.', wassim);
      store.addTaskComment(t.id, '@Codex can you take this one?', wassim);
      const seq = board().seq;
      const events = store.eventsSince(boardId, 0, claude);
      assert.equal(store.seeComments(boardId, claude, events), 1, "not the comment that's for Codex");
      assert.deepEqual(comments(t.id).map((c) => who(c.reactions)), [['Claude'], []]);
      assert.equal(store.seeComments(boardId, claude, events), 0, 'once per agent per comment');
      assert.equal(store.seeComments(boardId, codex, events), 2);
      assert.deepEqual(comments(t.id).map((c) => who(c.reactions)), [['Claude', 'Codex'], ['Codex']]);
      assert.equal(board().seq, seq, 'no event: nobody wakes, nothing in the activity');
      assert.ok(comments(t.id).every((c) => c.reactions!.every((r) => r.emoji === '👀')));
    });

    it("leaves agents' comments, and what's asked of it, but not yet in an update, to what get_board names", () => {
      const t = task();
      store.addTaskComment(t.id, 'Status?', codex);
      store.addTaskComment(t.id, '@Claude can you review the diff?', wassim);
      // get_board names the comments asking it something; it brings no events.
      assert.equal(store.seeComments(boardId, claude), 1);
      assert.deepEqual(comments(t.id).map((c) => who(c.reactions)), [[], ['Claude']]);
      const thread = store.startThread(boardId, 'Anyone around?', wassim);
      assert.equal(store.seeComments(boardId, claude), 1, 'a thread message waiting on any agent');
      assert.deepEqual(who(store.getThread(thread.id).thread.messages[0].reactions), ['Claude']);
      store.setArchived(boardId, true, wassim);
      store.setArchived(boardId, false, wassim);
    });

    it("isn't an answer: the comment still waits on the agent", () => {
      const t = task();
      store.addTaskComment(t.id, '@Claude can you review the diff?', wassim);
      store.seeComments(boardId, claude);
      assert.match(mentionsDigest(board(), 'Claude') ?? '', /Wassim asked you on T1/);
    });
  });

  describe('a 👍 or 👎 as a reply', () => {
    it("answers a person's ask on a decision, so it leaves their Needs you", () => {
      const decision = store.postDecision(boardId, { question: 'Should 👎 ask for a reason?', options: [{ label: 'Yes' }, { label: 'No' }] }, claude);
      store.addComment(decision.id, '@Wassim is a plain "no" enough?', claude);
      assert.deepEqual(pendingAsks(store.getDecision(decision.id).decision).map((a) => a.name), ['Wassim']);
      assert.ok(needsFrom(board(), 'Wassim', []).some((n) => n.kind === 'asked'));

      store.react({ decisionId: decision.id }, { emoji: '👀' }, wassim);
      assert.equal(pendingAsks(store.getDecision(decision.id).decision).length, 1, '👀 only says it was seen');
      const { answered } = store.react({ decisionId: decision.id }, { emoji: '👍' }, wassim);
      assert.ok(answered);
      assert.deepEqual(pendingAsks(store.getDecision(decision.id).decision), []);
      assert.ok(!needsFrom(board(), 'Wassim', []).some((n) => n.kind === 'asked'));
      assert.match(eventsOf(store, board()).at(-1)!.summary, /\(answering an ask from Claude\)$/);
    });

    it("clears an agent's question to a person on a task from their Needs you, and its \"asks you\"", () => {
      const t = task();
      const since = board().seq;
      store.addTaskComment(t.id, '@Wassim should 👎 also ask me to explain?', claude);
      const unseen = () => unseenBy(store.eventsSince(boardId, since), since, 'Wassim');
      const comment = () => comments(t.id)[0];
      assert.ok(needsFrom(board(), 'Wassim', unseen()).some((n) => n.key === t.id));
      assert.ok(asksYou(comment(), comments(t.id), 'Wassim'));

      store.react({ taskId: t.id }, { emoji: '👍' }, wassim);
      assert.ok(!needsFrom(board(), 'Wassim', unseen()).some((n) => n.key === t.id), 'it leaves Needs you');
      assert.ok(!asksYou(comment(), comments(t.id), 'Wassim'), 'and the tag goes');
      assert.ok(!unseen().some((e) => e.type === 'comment_reacted'), "their own reaction isn't news to them");
      assert.ok(!unseenBy(eventsOf(store, board()), since, 'Sam').some((e) => e.type === 'comment_reacted'), "nor to anyone else's inbox");
    });

    it("counts an agent's 👍 as its answer to what asks it, and 👀 not", () => {
      const t = task();
      store.addTaskComment(t.id, '@Claude can you review the diff?', wassim);
      store.react({ taskId: t.id }, { emoji: '👍' }, claude);
      assert.equal(mentionsDigest(board(), 'Claude'), undefined);

      const thread = store.startThread(boardId, 'Can you check the updater?', wassim);
      store.react({ threadId: thread.id }, { emoji: '👀' }, claude);
      assert.ok(threadWaiting(board(), store.getThread(thread.id).thread), 'still waiting after 👀');
      const { answered } = store.react({ threadId: thread.id }, { emoji: '👎' }, claude);
      assert.ok(answered);
      assert.equal(threadWaiting(board(), store.getThread(thread.id).thread), undefined);
    });
  });

  describe("a person's reaction to an agent's comment", () => {
    it('reaches that agent alone, in plain words', async () => {
      const t = task();
      store.addTaskComment(t.id, 'Should 👎 also ask me to explain, or is it just a "no"?', claude);
      const since = board().seq;
      store.react({ taskId: t.id }, { emoji: '👎' }, wassim);
      const [event] = store.eventsSince(boardId, since);
      assert.equal(event.type, 'comment_reacted');
      assert.equal(event.forAgent, 'Claude');
      assert.equal(event.summary, 'reacted 👎 to Claude\'s comment on T1: "Should 👎 also ask me to explain, or is it just a "no"?"');

      const forClaude = eventsDigest(store.eventsSince(boardId, since, claude), board().seq, { board: board(), viewer: 'Claude' });
      assert.match(
        forClaude,
        new RegExp(`^- \\(${event.seq}\\) Wassim \\(human\\) reacted 👎 to your comment on T1 \\[task id: ${t.id}\\]: "Should 👎 also ask me to explain, or is it just a "no"\\?"\\. Read it as a no\\.\\n`),
      );
      assert.deepEqual(store.eventsSince(boardId, since, codex), [], "not in another agent's updates");
      assert.equal(store.countEvents(boardId, { since, exclude: codex }), 0, 'nor its unread');
      const quiet = await store.waitForEvents(boardId, board().seq, { timeoutMs: 80, exclude: codex, settleMs: 0 });
      const later = store.waitForEvents(boardId, board().seq, { timeoutMs: 80, exclude: codex, settleMs: 0 });
      store.react({ taskId: t.id }, { emoji: '👍' }, wassim);
      assert.deepEqual([quiet, await later], [[], []], "nor does it wake another agent's wait");

      store.react({ taskId: t.id }, { emoji: '👎', remove: true }, wassim);
      const took = eventsDigest(store.eventsSince(boardId, board().seq - 1, claude), board().seq, { board: board(), viewer: 'Claude' });
      assert.match(took, new RegExp(`Wassim \\(human\\) took back their 👎 on your comment on T1 \\[task id: ${t.id}\\]\\.`));
      assert.ok(!needsInput(store.eventsSince(boardId, since).at(-1)!, board(), 'Sam'));
    });

    it('logs nothing for reactions between people, or from agents', () => {
      const t = task();
      store.addTaskComment(t.id, 'Sam, look at this.', wassim);
      store.addTaskComment(t.id, 'Done.', claude);
      const seq = board().seq;
      store.react({ taskId: t.id }, { commentId: comments(t.id)[0].id, emoji: '👍' }, sam);
      store.react({ taskId: t.id }, { commentId: comments(t.id)[0].id, emoji: '👍' }, codex);
      store.react({ taskId: t.id }, { commentId: comments(t.id)[1].id, emoji: '👎' }, codex);
      assert.equal(board().seq, seq);
    });

    it('shows under the comment when the agent reads the card', () => {
      const t = task();
      store.addTaskComment(t.id, 'The mock is on the canvas.', claude);
      store.react({ taskId: t.id }, { emoji: '👍' }, wassim);
      store.react({ taskId: t.id }, { emoji: '👀' }, codex);
      const id = comments(t.id)[0].id;
      assert.match(
        taskDetail(board(), store.getTask(t.id).task, 'Claude'),
        new RegExp(`## Discussion\\n- Claude \\(agent\\) at \\S+ \\[comment id: ${id}\\]: The mock is on the canvas\\.\\n  Reactions: 👍 Wassim · 👀 Codex`),
      );
    });
  });
});

// Two agents and a person, as they are on a board: over MCP and REST.
describe('Reactions over MCP and REST', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: Store;
  const clients: Record<'Claude' | 'Codex', Client> = {} as never;

  type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
  const call = async (agent: 'Claude' | 'Codex', name: string, args: Record<string, unknown>) => (await clients[agent].callTool({ name, arguments: args })) as ToolResult;
  const callText = async (agent: 'Claude' | 'Codex', name: string, args: Record<string, unknown>) => {
    const result = await call(agent, name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content[0].text;
  };
  const post = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-reactions-mcp-'));
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

  async function boardWithTask(title: string) {
    const boardId = (await post('/boards', { actor: 'Wassim', title })).json.id as string;
    await callText('Claude', 'get_board', { board_id: boardId });
    await callText('Codex', 'get_board', { board_id: boardId });
    const task = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Emoji reactions' })).json;
    return { boardId, task, cursor: store.getBoard(boardId).seq };
  }

  it("puts the agent's 👀 on a person's comment its updates bring, quietly", async () => {
    const { boardId, task, cursor } = await boardWithTask('Eyes');
    await post(`/tasks/${task.id}/comments`, { actor: 'Wassim', body: 'Keep it to three emojis.' });
    const seq = store.getBoard(boardId).seq;
    // Codex is waiting meanwhile: the 👀 must not wake it.
    const waiting = callText('Codex', 'wait_for_updates', { board_id: boardId, since: seq, timeout_seconds: 1 });
    assert.match(await callText('Claude', 'get_updates', { board_id: boardId, since: cursor }), /Wassim \(human\) commented on T1/);
    const [comment] = store.getTask(task.id).task.comments;
    assert.deepEqual(comment.reactions?.map((r) => `${r.emoji} ${r.by.name}`), ['👀 Claude']);
    assert.equal(store.getBoard(boardId).seq, seq, 'nothing logged');
    assert.match(await waiting, /No new activity\. Cursor: \d+\nNothing yet after 1s/);
    const read = await call('Codex', 'get_task', { task_id: task.id });
    assert.ok(!read.content.some((c) => /Unread on this board/.test(c.text)), "Claude's 👀 is nothing unread for Codex");
    await callText('Claude', 'get_updates', { board_id: boardId, since: cursor });
    assert.equal(store.getTask(task.id).task.comments[0].reactions!.length, 1, 'once');
  });

  it('puts it on a thread message wait_for_updates brings, and on what get_board names as asked of it', async () => {
    const { boardId, task } = await boardWithTask('More eyes');
    const since = store.getBoard(boardId).seq;
    const waiting = callText('Claude', 'wait_for_updates', { board_id: boardId, since, timeout_seconds: 5 });
    const thread = (await post(`/boards/${boardId}/threads`, { actor: 'Wassim', body: 'Should agents react to each other?' })).json;
    assert.match(await waiting, /Wassim \(human\) started thread/);
    assert.deepEqual(store.getThread(thread.id).thread.messages[0].reactions?.map((r) => r.by.name), ['Claude']);

    await post(`/tasks/${task.id}/comments`, { actor: 'Wassim', body: '@Codex can you review it?' });
    await callText('Codex', 'get_board', { board_id: boardId });
    assert.deepEqual(store.getTask(task.id).task.comments[0].reactions?.map((r) => r.by.name), ['Codex']);
  });

  it("tells the agent a person reacted to its comment, and answers a person's ask with the react tool", async () => {
    const { boardId, task } = await boardWithTask('Answers');
    await callText('Claude', 'comment', { task_id: task.id, body: '@Wassim should 👎 also ask me to explain?' });
    const [comment] = store.getTask(task.id).task.comments;
    const since = store.getBoard(boardId).seq;
    const reacted = await post(`/tasks/${task.id}/comments/${comment.id}/reactions`, { actor: 'Wassim', emoji: '👎' });
    assert.equal(reacted.status, 200);
    assert.deepEqual(reacted.json.reactions.map((r: { emoji: string }) => r.emoji), ['👎']);
    const updates = await callText('Claude', 'get_updates', { board_id: boardId, since });
    assert.match(updates, /Wassim \(human\) reacted 👎 to your comment on T1 \[task id: \w+\]: "@Wassim should 👎 also ask me to explain\?"\. Read it as a no\./);
    assert.doesNotMatch(await callText('Codex', 'get_updates', { board_id: boardId, since }), /reacted/);

    await post(`/tasks/${task.id}/comments`, { actor: 'Wassim', body: '@Claude a plain no is enough.' });
    const answer = await callText('Claude', 'react', { task_id: task.id, emoji: '👍' });
    assert.equal(answer, `Reacted 👍 to Wassim's comment on T1: "@Claude a plain no is enough.". It counts as your reply, so it no longer waits on you. Wassim sees it under it.`);
    assert.doesNotMatch(await callText('Claude', 'get_board', { board_id: boardId }), /Wassim asked you on T1/);
    const [, said] = store.getTask(task.id).task.comments;
    assert.match(await callText('Claude', 'get_task', { task_id: task.id }), new RegExp(`\\[comment id: ${said.id}\\] \\(asks you\\): @Claude a plain no is enough\\.\\n  Reactions: 👍 Claude`));
    assert.equal(await callText('Claude', 'react', { task_id: task.id, comment_id: said.id, emoji: '👍', remove: true }), `Took back your 👍 on Wassim's comment on T1.`);
    const own = await call('Claude', 'react', { task_id: task.id, comment_id: comment.id, emoji: '👍' });
    assert.equal(own.content[0].text, "That's your own comment: react to someone else's.");
    const nowhere = await call('Claude', 'react', { emoji: '👍' });
    assert.equal(nowhere.content[0].text, 'Pass one of task_id, decision_id, thread_id or pin_id: where the comment is.');
  });
});
