import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';
import { readGuide } from './guide';
import { removeScratch } from './platform';

type Agent = 'Claude' | 'Codex' | 'Gemini';
type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

// Three agents on one board: Claude hands Codex a question on a card and in a
// thread, Gemini reads it as Codex's, and Codex, waiting, wakes for it and
// answers. Then Claude and Codex go back and forth until the loop guard holds
// them, and a person's word lets them go again.
// The person's browser, let in as one of their seats (seatHelper.ts): it signs what needs one.
let seat: TestSeat;

describe('Agents tagging each other, over MCP', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: Store;
  const clients = {} as Record<Agent, Client>;

  async function callText(agent: Agent, name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = (await clients[agent].callTool({ name, arguments: args })) as ToolResult;
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content.map((c) => c.text).join('\n');
  }

  async function post(route: string, body: Record<string, unknown>) {
    const response = await fetch(`${base}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign('POST', `/api${route}`, JSON.stringify(body)) }, body: JSON.stringify(body) });
    return (await response.json()) as Record<string, unknown> & { id: string };
  }

  const seq = (boardId: string) => store.getBoard(boardId).seq;

  // A wait that starts now, and how long it took to come back.
  function waitFor(agent: Agent, boardId: string, since: number, seconds: number) {
    const start = performance.now();
    return callText(agent, 'wait_for_updates', { board_id: boardId, since, timeout_seconds: seconds }).then((text) => ({ text, ms: performance.now() - start }));
  }

  async function newBoard(title: string) {
    const boardId = (await post('/boards', { actor: 'Wassim', title })).id;
    for (const agent of Object.keys(clients) as Agent[]) await callText(agent, 'get_board', { board_id: boardId });
    const task = await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Split the store' });
    await post(`/tasks/${task.id}`, { actor: 'Wassim', status: 'todo' });
    return { boardId, taskId: task.id };
  }

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-agent-talk-mcp-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    seat = letIn(app);
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const agent of ['Claude', 'Codex', 'Gemini'] as const) {
      clients[agent] = new Client({ name: 'test-client', version: '1.0.0' });
      await clients[agent].connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=${agent}`)));
    }
  });

  after(async () => {
    for (const client of Object.values(clients)) await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  it('tells agents they can tag each other, on the board, and react rather than tag to thank', async () => {
    const instructions = clients.Claude.getInstructions() ?? '';
    assert.match(instructions, /- @-mention another agent to hand it a question or work, and answer agents as you'd answer people\. Keep it on the board; react to thank\./);
    assert.match(instructions, /@-mention to tell a person; ask_people to ask, which waits for an answer\./, 'as it was');
    const { tools } = await clients.Claude.listTools();
    const described = (name: string) => tools.find((t) => t.name === name)!.description ?? '';
    for (const name of ['comment', 'reply_in_thread']) assert.match(described(name), /another agent/);
    const guide = await readGuide(clients.Claude, 'conversation');
    for (const name of ['comment', 'reply_in_thread']) {
      const part = guide.split(`## ${name}\n`)[1].split('\n\n## ')[0];
      assert.match(part, /never in a side channel, and don't mention an agent just to thank or acknowledge: react instead/);
    }
    assert.match(guide, /or another agent \(@Codex\) to hand it a question or work/);
  });

  it("asks the agent named on a card: it wakes, reads it as asked of it, and the third leaves it", async () => {
    const { boardId, taskId } = await newBoard('Card');
    const since = seq(boardId);
    const codexWaits = waitFor('Codex', boardId, since, 20);
    await new Promise((r) => setTimeout(r, 100));
    const posted = await callText('Claude', 'comment', { task_id: taskId, body: '@Codex can you check the migration keeps old boards readable?' });
    assert.match(posted, /^Commented on T1\. Codex reads it as asked of it; its reply comes through your updates\./);

    const woke = await codexWaits;
    assert.ok(woke.ms < 5000, `woke in ${Math.round(woke.ms)} ms`);
    const asked = `Claude (agent) asked you on T1 [task id: ${taskId}]: "can you check the migration keeps old boards readable?". Reply with comment(task_id: ${taskId}).`;
    assert.ok(woke.text.includes(asked), woke.text);
    assert.match(await callText('Codex', 'get_updates', { board_id: boardId, since }), /Claude \(agent\) asked you on T1/);
    assert.match(await callText('Codex', 'get_board', { board_id: boardId }), /Claude asked you on T1 \[task id: \w+\]/);
    assert.match(await callText('Codex', 'get_task', { task_id: taskId }), /Claude \(agent\) at [^\n]+ \(asks you\): @Codex can you check/);

    const forGemini = await callText('Gemini', 'get_updates', { board_id: boardId, since });
    assert.match(forGemini, new RegExp(`Claude \\(agent\\) asked Codex on T1 \\[task id: ${taskId}\\]\\. Not for you; carry on\\.`));
    assert.doesNotMatch(forGemini, /asked you/);
    assert.doesNotMatch(await callText('Gemini', 'get_board', { board_id: boardId }), /asked you/);

    // Codex saw it, which the line under Claude's comment shows, and answers.
    const comment = store.getTask(taskId).task.comments[0];
    assert.deepEqual(comment.reactions?.map((r) => [r.emoji, r.by.name]), [['👀', 'Codex']]);
    await callText('Codex', 'comment', { task_id: taskId, body: 'Yes: old boards load, and the tests cover it.' });
    assert.doesNotMatch(await callText('Codex', 'get_board', { board_id: boardId }), /asked you on T1/, 'answered');
    assert.match(await callText('Claude', 'get_updates', { board_id: boardId, since }), /Codex \(agent\) commented on T1 "Split the store": "Yes: old boards load/);
  });

  it('asks the agent named in a thread the same way', async () => {
    const { boardId } = await newBoard('Thread');
    const thread = (await post(`/boards/${boardId}/threads`, { actor: 'Wassim', body: 'Can we bundle Pi in the app?' })) as unknown as { id: string };
    await callText('Claude', 'reply_in_thread', { thread_id: thread.id, body: 'I think so; licences next.' });
    const since = seq(boardId);
    const codexWaits = waitFor('Codex', boardId, since, 20);
    await new Promise((r) => setTimeout(r, 100));
    const replied = await callText('Claude', 'reply_in_thread', { thread_id: thread.id, body: '@Codex can you check the licences of its dependencies?' });
    assert.match(replied, /People see it in the thread\. Codex reads it as asked of it; its reply comes through your updates\./);

    const woke = await codexWaits;
    assert.ok(woke.ms < 5000, `woke in ${Math.round(woke.ms)} ms`);
    assert.match(woke.text, new RegExp(`Claude \\(agent\\) asked you in thread "Can we bundle Pi in the app\\?" \\[thread id: ${thread.id}\\]: "can you check the licences of its dependencies\\?"\\. Reply with reply_in_thread\\(thread_id: ${thread.id}\\)\\.`));
    assert.match(await callText('Codex', 'get_board', { board_id: boardId }), /Claude asked you in thread "Can we bundle Pi in the app\?"/);
    assert.match(await callText('Codex', 'get_thread', { thread_id: thread.id }), /\(asks you\): @Codex can you check the licences/);
    assert.match(await callText('Gemini', 'get_updates', { board_id: boardId, since }), /Claude \(agent\) asked Codex in thread "Can we bundle Pi in the app\?" \[thread id: \w+\]\. Not for you; carry on\./);

    await callText('Codex', 'reply_in_thread', { thread_id: thread.id, body: 'All MIT and Apache-2.0.' });
    assert.doesNotMatch(await callText('Codex', 'get_board', { board_id: boardId }), /asked you in thread/, 'answered');
  });

  it('holds a fifth back-and-forth with no person in between: news, not an ask, and no wake, until a person writes', async () => {
    const { boardId, taskId } = await newBoard('Loop');
    const turns: [Agent, string][] = [
      ['Claude', '@Codex can you check the diff?'],
      ['Codex', '@Claude looks fine; can you check mine?'],
      ['Claude', '@Codex done; anything else?'],
      ['Codex', '@Claude one more file, the store.'],
    ];
    for (const [agent, body] of turns) await callText(agent, 'comment', { task_id: taskId, body });

    const since = seq(boardId);
    const codexWaits = waitFor('Codex', boardId, since, 2);
    await new Promise((r) => setTimeout(r, 100));
    const held = await callText('Claude', 'comment', { task_id: taskId, body: '@Codex thanks, all good!' });
    assert.match(held, /Agents have gone back and forth here 5 times since a person last wrote, so it doesn't ask Codex or wake it\./);
    const waited = await codexWaits;
    assert.ok(waited.ms >= 1900, `the held mention woke Codex after ${Math.round(waited.ms)} ms`);
    const news = `Claude (agent) mentioned you on T1 [task id: ${taskId}]: "thanks, all good!"; agents have gone back and forth here 5 times, so wait for a person before replying.`;
    assert.ok(waited.text.includes(news), waited.text);
    assert.doesNotMatch(waited.text, /asked you/);
    assert.doesNotMatch(await callText('Codex', 'get_board', { board_id: boardId }), /asked you on T1/);
    assert.match(await callText('Codex', 'get_task', { task_id: taskId }), /\(mentions you; agents have gone back and forth here 5 times, so wait for a person before replying\): @Codex thanks/);

    // A person writes there: the next one asks again.
    await post(`/tasks/${taskId}/comments`, { actor: 'Wassim', body: 'Good, one last check on the store, then wrap up.' });
    const after = seq(boardId);
    await callText('Claude', 'comment', { task_id: taskId, body: '@Codex last look at the store?' });
    assert.match(await callText('Codex', 'get_updates', { board_id: boardId, since: after }), /Claude \(agent\) asked you on T1/);
  });
});
