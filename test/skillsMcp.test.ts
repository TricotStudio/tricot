import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SKILLS_NUDGE } from '../src/core/skills';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { removeScratch } from './platform';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
type AgentName = 'Claude' | 'Codex';

const CLAUDE_SKILLS = [
  { name: 'avoid-ai-writing', description: 'Tighten prose so it reads as written by a person' },
  { name: 'review', description: 'Review a diff' },
];
const CODEX_SKILLS = [{ name: 'review', description: 'Review the working tree' }];

// Agents tell Tricot their skills; a person's message that starts with one is a request to that agent.
describe('Skills called with "/", over MCP and REST', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: Store;
  const clients = {} as Record<AgentName, Client>;

  async function connect(agent: AgentName): Promise<Client> {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=${agent}`)));
    return client;
  }

  async function call(agent: AgentName, name: string, args: Record<string, unknown> = {}, client = clients[agent]): Promise<ToolResult> {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  }

  async function callText(agent: AgentName, name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await call(agent, name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content[0].text;
  }

  async function post(route: string, body: Record<string, unknown>) {
    const response = await fetch(`${base}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  }

  async function get(route: string) {
    return (await fetch(`${base}/api${route}`)).json();
  }

  // A board both agents have looked at, so people can mention them.
  async function boardWithAgents(title: string): Promise<string> {
    const boardId = (await post('/boards', { actor: 'Wassim', title })).json.id as string;
    await callText('Claude', 'get_board', { board_id: boardId });
    await callText('Codex', 'get_board', { board_id: boardId });
    return boardId;
  }

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-skills-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const agent of ['Claude', 'Codex'] as const) clients[agent] = await connect(agent);
  });

  after(async () => {
    for (const client of Object.values(clients)) await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  it('asks an agent for its skills in get_board until it has reported, in each new session', async () => {
    const boardId = (await post('/boards', { actor: 'Wassim', title: 'Nudges' })).json.id as string;
    assert.ok((await callText('Claude', 'get_board', { board_id: boardId })).endsWith(SKILLS_NUDGE));
    assert.ok(!(await callText('Claude', 'wait_for_updates', { board_id: boardId, since: 0, timeout_seconds: 1 })).includes(SKILLS_NUDGE));
    assert.match(await callText('Claude', 'report_skills', { skills: CLAUDE_SKILLS }), /Reported 2 skills/);
    assert.ok(!(await callText('Claude', 'get_board', { board_id: boardId })).includes(SKILLS_NUDGE), 'gone after the report');
    assert.ok((await callText('Codex', 'get_board', { board_id: boardId })).includes(SKILLS_NUDGE), "another agent's report doesn't count");

    const next = await connect('Claude');
    try {
      const again = await call('Claude', 'get_board', { board_id: boardId }, next);
      assert.ok(again.content[0].text.includes(SKILLS_NUDGE), 'a new session is asked again');
      assert.match((await call('Claude', 'report_skills', { skills: [] }, next)).content[0].text, /Cleared your skills/);
      assert.deepEqual((await get('/agents')).find((a: { name: string }) => a.name === 'Claude').skills, []);
      await call('Claude', 'report_skills', { skills: CLAUDE_SKILLS }, next);
    } finally {
      await next.close();
    }
  });

  it('keeps each agent\'s skills app-wide and replaces them with a new report', async () => {
    await callText('Codex', 'report_skills', { skills: [{ name: '/review', description: 'Old   description\n on two lines' }, { name: 'review', description: 'dup' }, { name: 'prompts:lint', description: 'x'.repeat(500) }] });
    const [claude, codex] = ['Claude', 'Codex'].map(async (name) => (await get('/agents')).find((a: { name: string }) => a.name === name));
    assert.equal((await codex).skills.length, 2, 'a name once, slash off');
    assert.deepEqual((await codex).skills[0], { name: 'review', description: 'Old description on two lines' });
    assert.equal((await codex).skills[1].description.length, 200, 'long descriptions are clipped');
    assert.deepEqual((await claude).skills, CLAUDE_SKILLS);

    await callText('Codex', 'report_skills', { skills: CODEX_SKILLS });
    const after = (await get('/agents')).find((a: { name: string }) => a.name === 'Codex');
    assert.deepEqual(after.skills, CODEX_SKILLS, 'replaced, not added to');
    assert.match(after.reportedAt, /^\d{4}-\d\d-\d\dT/);
    // Kept in the data folder, not in a board: a fresh Store on it reads them.
    await store.flush();
    const reopened = new Store(dir);
    reopened.load();
    assert.deepEqual(reopened.agentSkills().find((l) => l.agent === 'Codex')!.skills, CODEX_SKILLS);
  });

  it('refuses a skill list that is not one, in the words REST would use', async () => {
    const refuse = async (skills: unknown) => {
      const result = await call('Claude', 'report_skills', { skills });
      assert.equal(result.isError, true);
      return result.content[0].text;
    };
    assert.equal(await refuse([{ name: 'two words', description: 'x' }]), 'A skill name is one word, e.g. review or plugin:review.');
    assert.equal(await refuse([{ name: '', description: 'x' }]), 'skill name must not be empty.');
    assert.equal(await refuse([{ name: 'x'.repeat(61), description: 'x' }]), 'A skill name is too long (max 60 characters).');
    assert.equal(await refuse([{ name: 'ok' }]), 'skills[0].description is required.');
    assert.equal(await refuse(Array.from({ length: 301 }, (_, i) => ({ name: `s${i}`, description: '' }))), 'Report at most 300 skills.');
    assert.deepEqual((await get('/agents')).find((a: { name: string }) => a.name === 'Claude').skills, CLAUDE_SKILLS, 'a refused report changes nothing');
  });

  it('sends a "/" request on a task to the agent that has the skill, with its args, and marks the reply', async () => {
    const boardId = await boardWithAgents('Task requests');
    const task = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Write the launch note' })).json;
    const since = store.getBoard(boardId).seq;
    const sent = await post(`/tasks/${task.id}/comments`, { actor: 'Wassim', body: '/avoid-ai-writing tighten the intro, keep it under 80 words' });
    const comment = sent.json.comments[0];
    assert.deepEqual(comment.skill, { name: 'avoid-ai-writing', args: 'tighten the intro, keep it under 80 words', agents: ['Claude'] });
    assert.deepEqual(comment.mentions, ['Claude']);

    const where = `T1 [task id: ${task.id}]`;
    const reply = `comment(task_id: ${task.id})`;
    const forClaude = await callText('Claude', 'get_updates', { board_id: boardId, since });
    assert.ok(
      forClaude.includes(`Wassim (human) asks you to run /avoid-ai-writing on ${where}: "tighten the intro, keep it under 80 words". Run it, then reply with ${reply}; your reply shows "via /avoid-ai-writing".`),
      forClaude,
    );
    const forCodex = await callText('Codex', 'get_updates', { board_id: boardId, since });
    assert.ok(!forCodex.includes(task.id), 'the unrequested agent receives no backlog content');
    assert.doesNotMatch(forCodex, /asks you/);

    assert.match(await callText('Claude', 'get_task', { task_id: task.id }), /Wassim \(human\) at \S+ \[comment id: \w+\] \(asks you to run \/avoid-ai-writing\): \/avoid-ai-writing tighten the intro/);
    assert.match(await callText('Claude', 'get_board', { board_id: boardId }), /Wassim asks you to run \/avoid-ai-writing on T1 .*: "tighten the intro, keep it under 80 words"/);
    assert.equal((await call('Codex', 'get_task', { task_id: task.id })).isError, true);

    await callText('Claude', 'comment', { task_id: task.id, body: 'Tightened it: 62 words now.' });
    await callText('Claude', 'comment', { task_id: task.id, body: 'And one more thing.' });
    const comments = (await get(`/boards/${boardId}`)).tasks[0].comments;
    assert.equal(comments[1].via, 'avoid-ai-writing');
    assert.equal(comments[2].via, undefined, 'only the reply that answers it');
    const seen = await callText('Claude', 'get_task', { task_id: task.id });
    assert.match(seen, /Claude \(agent\) at \S+ \[comment id: \w+\] \(via \/avoid-ai-writing\): Tightened it: 62 words now\./);
    assert.ok(!(await callText('Claude', 'get_board', { board_id: boardId })).includes('asks you to run'), 'answered');
  });

  it('addresses a request to the agent it opens with a mention of, and to every agent that has the skill otherwise', async () => {
    const boardId = await boardWithAgents('Who is asked');
    const decision = (await post(`/boards/${boardId}/decisions`, { actor: 'Wassim', question: 'Which logins?', options: ['A', 'B'] })).json;
    const pick = async (body: string) => (await post(`/decisions/${decision.id}/comments`, { actor: 'Wassim', body })).json.comments.at(-1);

    const toCodex = await pick('@Codex /review the oauth change');
    assert.deepEqual(toCodex.skill, { name: 'review', args: 'the oauth change', agents: ['Codex'] });
    assert.deepEqual(toCodex.mentions, ['Codex']);
    const toBoth = await pick('/review everything since Monday');
    assert.deepEqual(toBoth.skill.agents.sort(), ['Claude', 'Codex']);
    assert.deepEqual(toBoth.mentions.sort(), ['Claude', 'Codex']);
    const noArgs = await pick('@Claude /review');
    assert.deepEqual(noArgs.skill, { name: 'review', args: '', agents: ['Claude'] });
    const forClaude = await callText('Claude', 'get_decision', { decision_id: decision.id });
    assert.match(forClaude, /\(for Codex: not for you\): @Codex \/review the oauth change/);
    assert.match(forClaude, /\(asks you to run \/review\): @Claude \/review$/m);
    assert.match(await callText('Claude', 'get_board', { board_id: boardId }), new RegExp(`asks you to run /review on #1 \\[decision id: ${decision.id}\\]\\. Run it`));
  });

  it('leaves a message that only looks like a request as text', async () => {
    const boardId = await boardWithAgents('Plain text');
    const task = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Write it' })).json;
    const comment = async (body: string, actor = 'Wassim') => (await post(`/tasks/${task.id}/comments`, { actor, body })).json.comments.at(-1);
    for (const body of ['/nope do this', '/usr/bin is where it lives', 'please /review this', '@Gemini /review it', '@Wassim /review it', 'see https://example.com/review', '@Codex /avoid-ai-writing it']) {
      const made = await comment(body);
      assert.equal(made.skill, undefined, body);
    }
    // A person asks Claude to reply; its own text is never a skill request.
    await comment('@Claude please reply.');
    const fromAgent = await callText('Claude', 'comment', { task_id: task.id, body: '@Codex /review the diff' });
    assert.match(fromAgent, /Commented on T1/);
    const stored = (await get(`/boards/${boardId}`)).tasks[0].comments.at(-1);
    assert.equal(stored.skill, undefined);
    assert.equal(stored.via, undefined);
    assert.deepEqual(stored.mentions, ['Codex'], 'it is still a mention');
  });

  it('sends a "/" request in a thread, and marks the reply in it', async () => {
    const boardId = await boardWithAgents('Thread requests');
    const started = await post(`/boards/${boardId}/threads`, { actor: 'Wassim', body: '@Claude /avoid-ai-writing the README intro' });
    assert.equal(started.status, 201);
    const thread = started.json;
    assert.equal(thread.title, '/avoid-ai-writing the README intro');
    assert.deepEqual(thread.messages[0].skill, { name: 'avoid-ai-writing', args: 'the README intro', agents: ['Claude'] });

    const named = `thread "/avoid-ai-writing the README intro" [thread id: ${thread.id}]`;
    const asked = `asks you to run /avoid-ai-writing in ${named}: "the README intro". Run it, then reply with reply_in_thread(thread_id: ${thread.id}); your reply shows "via /avoid-ai-writing".`;
    assert.ok((await callText('Claude', 'get_board', { board_id: boardId })).includes(`Wassim ${asked}`));
    assert.ok((await callText('Claude', 'get_updates', { board_id: boardId, since: 0 })).includes(`Wassim (human) ${asked}`));
    assert.match(await callText('Claude', 'get_thread', { thread_id: thread.id }), /Wassim \(human\) at \S+ \[message id: \w+\] \(asks you to run \/avoid-ai-writing\): @Claude/);
    assert.match(await callText('Codex', 'get_thread', { thread_id: thread.id }), /\(for Claude: not for you\)/);

    await callText('Claude', 'reply_in_thread', { thread_id: thread.id, body: 'Done: the intro is two sentences now.' });
    const messages = (await get(`/threads/${thread.id}`)).messages;
    assert.equal(messages[1].via, 'avoid-ai-writing');
    assert.match(await callText('Codex', 'get_thread', { thread_id: thread.id }), /Claude \(agent\) at \S+ \[message id: \w+\] \(via \/avoid-ai-writing\): Done:/);

    // A later message is its own request.
    const next = await post(`/threads/${thread.id}/messages`, { actor: 'Wassim', body: '/review the new intro' });
    assert.deepEqual(next.json.messages.at(-1).skill.agents.sort(), ['Claude', 'Codex']);
    await callText('Claude', 'reply_in_thread', { thread_id: thread.id, body: 'Looks fine.' });
    assert.equal((await get(`/threads/${thread.id}`)).messages.at(-1).via, 'review');
  });

  it("lists agents and their skills for the UI, greyed when the agent isn't here", async () => {
    store.reportSkills('Gemini', [{ name: 'plan', description: 'Plan the work' }]);
    const boardA = await boardWithAgents('Here');
    const boardB = (await post('/boards', { actor: 'Wassim', title: 'Elsewhere' })).json.id as string;
    await callText('Claude', 'get_board', { board_id: boardB });
    const names = (list: { name: string }[]) => list.map((a) => a.name);

    const everywhere = await get('/agents');
    assert.deepEqual(names(everywhere).sort(), ['Claude', 'Codex', 'Gemini']);
    const gemini = everywhere.find((a: { name: string }) => a.name === 'Gemini');
    assert.deepEqual({ state: gemini.state, present: gemini.present, lastSeen: gemini.lastSeen }, { state: 'absent', present: false, lastSeen: undefined });
    assert.equal(everywhere.at(-1).name, 'Gemini', 'agents that are here come first');
    const claude = everywhere.find((a: { name: string }) => a.name === 'Claude');
    assert.equal(claude.present, true);
    assert.ok(['listening', 'working'].includes(claude.state), claude.state);
    assert.match(claude.lastSeen, /^\d{4}-/);

    const onA = await get(`/agents?board=${boardA}`);
    assert.equal(onA.find((a: { name: string }) => a.name === 'Codex').present, true);
    const onB = await get(`/agents?board=${boardB}`);
    const codexOnB = onB.find((a: { name: string }) => a.name === 'Codex');
    assert.deepEqual({ state: codexOnB.state, present: codexOnB.present }, { state: 'absent', present: false }, 'Codex has not been on that board');
    assert.equal(onB.find((a: { name: string }) => a.name === 'Claude').present, true);
    assert.deepEqual(codexOnB.skills, CODEX_SKILLS, 'its skills are listed all the same');

    const listening = call('Codex', 'wait_for_updates', { board_id: boardA, since: store.getBoard(boardA).seq, timeout_seconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await get(`/agents?board=${boardA}`)).find((a: { name: string }) => a.name === 'Codex').state, 'listening');
    await listening;

    assert.equal((await fetch(`${base}/api/agents?board=no-such-board`)).status, 404);
  });

  it('asks an absent agent that has the skill, which finds the request when it next connects', async () => {
    const boardId = (await post('/boards', { actor: 'Wassim', title: 'Runs next time' })).json.id as string;
    const task = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Plan the work' })).json;
    const sent = (await post(`/tasks/${task.id}/comments`, { actor: 'Wassim', body: '@Gemini /plan the next sprint' })).json.comments[0];
    assert.deepEqual(sent.skill, { name: 'plan', args: 'the next sprint', agents: ['Gemini'] });
    assert.deepEqual(sent.mentions, ['Gemini']);
  });
});
