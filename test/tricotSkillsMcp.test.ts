import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { INSTRUCTIONS_CLIP } from '../src/core/mentions';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';
import { removeScratch } from './platform';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
type AgentName = 'Claude' | 'Codex';

const NOTES = 'Read the commits since the last tag.\nGroup them by area.\nWrite them in plain language, no jargon.';

// People add skills in Tricot; a request to run one carries its instructions to the agent, over MCP.
// The person's browser, let in as one of their seats (seatHelper.ts): it signs what needs one.
let seat: TestSeat;

describe('Tricot skills, over REST and MCP', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: Store;
  const clients = {} as Record<AgentName, Client>;

  async function call(agent: AgentName, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return (await clients[agent].callTool({ name, arguments: args })) as ToolResult;
  }

  async function callText(agent: AgentName, name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await call(agent, name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content[0].text;
  }

  async function post(route: string, body: Record<string, unknown>) {
    const response = await fetch(`${base}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign('POST', `/api${route}`, JSON.stringify(body)) }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  }

  async function get(route: string) {
    return (await fetch(`${base}/api${route}`)).json();
  }

  const skillsOf = async (agent: string, board?: string) =>
    (await get(board ? `/agents?board=${board}` : '/agents')).find((a: { name: string }) => a.name === agent).skills as { name: string; description: string; call?: string; tricot?: { id: string; instructions: string; agent?: string } }[];

  async function boardWithAgents(title: string): Promise<string> {
    const boardId = (await post('/boards', { actor: 'Wassim', title })).json.id as string;
    await callText('Claude', 'get_board', { board_id: boardId });
    await callText('Codex', 'get_board', { board_id: boardId });
    return boardId;
  }

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-tricot-skills-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    seat = letIn(app);
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const agent of ['Claude', 'Codex'] as const) {
      clients[agent] = new Client({ name: 'test-client', version: '1.0.0' });
      await clients[agent].connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=${agent}`)));
    }
    await callText('Claude', 'report_skills', { skills: [{ name: 'review', description: "Claude's own review" }, { name: 'avoid-ai-writing', description: 'Tighten prose' }] });
    await callText('Codex', 'report_skills', { skills: [{ name: 'lint', description: 'Lint the tree' }] });
  });

  after(async () => {
    for (const client of Object.values(clients)) await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  it('adds a skill for every agent or for one, lists it under each agent it is for, and keeps the own skills as reported', async () => {
    const made = await post('/skills', { actor: 'Wassim', name: '/release-notes', description: 'Write release notes from the last commits', instructions: NOTES });
    assert.equal(made.status, 201);
    assert.deepEqual({ name: made.json.name, agent: made.json.agent, createdBy: made.json.createdBy }, { name: 'release-notes', agent: undefined, createdBy: 'Wassim' });
    const just = await post('/skills', { actor: 'Wassim', name: 'codex-only', description: 'Only for Codex', instructions: 'Do the Codex thing.', agent: 'Codex' });
    assert.equal(just.json.agent, 'Codex');

    const claude = await skillsOf('Claude');
    assert.deepEqual(claude.map((s) => s.name), ['review', 'avoid-ai-writing', 'release-notes']);
    assert.deepEqual(claude[0], { name: 'review', description: "Claude's own review" }, 'its own, as it reported them');
    assert.deepEqual(claude[2].tricot, { id: made.json.id, instructions: NOTES });
    assert.deepEqual((await skillsOf('Codex')).map((s) => s.name), ['lint', 'release-notes', 'codex-only']);
    assert.deepEqual((await skillsOf('Codex'))[2].tricot, { id: just.json.id, instructions: 'Do the Codex thing.', agent: 'Codex' });
    const board = await boardWithAgents('Lists');
    assert.deepEqual((await skillsOf('Claude', board)).map((s) => s.name), ['review', 'avoid-ai-writing', 'release-notes'], 'the same for a board');
  });

  it('refuses a bad skill in the same words as an agent reporting it', async () => {
    const viaRest = async (body: Record<string, unknown>) => (await post('/skills', { actor: 'Wassim', description: 'd', instructions: 'i', name: 'ok', ...body })).json.error;
    const viaMcp = async (name: string) => (await call('Claude', 'report_skills', { skills: [{ name, description: 'd' }] })).content[0].text;
    for (const name of ['two words', '', 'x'.repeat(61)]) assert.equal(await viaRest({ name }), await viaMcp(name), `name "${name}"`);
    assert.equal(await viaRest({ name: 'two words' }), 'A skill name is one word, e.g. review or plugin:review.');
    assert.equal(await viaRest({ description: ' ' }), 'description must not be empty.');
    assert.equal(await viaRest({ instructions: '' }), 'instructions must not be empty.');
    assert.equal(await viaRest({ description: 'd'.repeat(201) }), 'A description is too long (max 200 characters).');
    assert.equal(await viaRest({ agent: 'a'.repeat(61) }), 'An agent is too long (max 60 characters).');
    assert.equal(await viaRest({ name: 'Release-Notes' }), 'There is a Tricot skill called /Release-Notes already.');
    assert.equal((await post('/skills', { actor: 'Wassim', name: 'Release-Notes', description: 'd', instructions: 'i' })).status, 409);
    assert.equal((await post('/skills', { name: 'x', description: 'd', instructions: 'i' })).json.error, 'actor is required.');
    assert.equal((await post('/skills/nope', { actor: 'Wassim', name: 'x' })).status, 404);
    assert.equal((await post('/skills/nope/delete', { actor: 'Wassim' })).status, 404);
  });

  it('sends a request on a task to the agent with the instructions, clipped in an update and whole in get_task', async () => {
    const boardId = await boardWithAgents('Task request');
    const task = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Ship v2' })).json;
    const since = store.getBoard(boardId).seq;
    const sent = (await post(`/tasks/${task.id}/comments`, { actor: 'Wassim', body: '@Claude /release-notes since v1.4, for customers' })).json.comments[0];
    assert.deepEqual(sent.skill, { name: 'release-notes', args: 'since v1.4, for customers', agents: ['Claude'], tricot: { instructions: NOTES, agents: ['Claude'] } });
    assert.deepEqual(sent.mentions, ['Claude']);

    const where = `T1 [task id: ${task.id}]`;
    const line = `asks you to run the Tricot skill /release-notes on ${where}: "since v1.4, for customers". Its instructions: ${NOTES.replace(/\n/g, ' ')} Follow them, then reply with comment(task_id: ${task.id}); your reply shows "via /release-notes".`;
    const updates = await callText('Claude', 'get_updates', { board_id: boardId, since });
    assert.ok(updates.includes(`Wassim (human) ${line}`), updates);
    assert.ok((await callText('Claude', 'get_board', { board_id: boardId })).includes(`Wassim ${line}`));
    const full = await callText('Claude', 'get_task', { task_id: task.id });
    assert.match(full, /\(asks you to run the Tricot skill \/release-notes\): @Claude \/release-notes since v1.4, for customers\n {2}Instructions of the Tricot skill \/release-notes:\n {4}Read the commits since the last tag\.\n {4}Group them by area\.\n {4}Write them in plain language, no jargon\./);
    const refused = await call('Codex', 'get_task', { task_id: task.id });
    assert.equal(refused.isError, true);
    const other = refused.content[0].text;
    assert.doesNotMatch(other, /Instructions of the Tricot skill/, "another agent's request doesn't carry theirs to it");
    assert.doesNotMatch(await callText('Codex', 'get_updates', { board_id: boardId, since }), /Its instructions/);

    await callText('Claude', 'comment', { task_id: task.id, body: 'Here are the notes: …' });
    assert.equal((await get(`/boards/${boardId}`)).tasks[0].comments[1].via, 'release-notes');
    assert.ok(!(await callText('Claude', 'get_board', { board_id: boardId })).includes('asks you to run'), 'answered');
  });

  it('cuts long instructions short in an update, and says where the whole text is', async () => {
    const long = Array.from({ length: 200 }, (_, i) => `step${i}`).join(' ');
    const made = await post('/skills', { actor: 'Wassim', name: 'long-one', description: 'Long', instructions: long });
    const boardId = await boardWithAgents('Long request');
    const task = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Do it' })).json;
    await post(`/tasks/${task.id}/comments`, { actor: 'Wassim', body: '@Claude /long-one' });
    const board = await callText('Claude', 'get_board', { board_id: boardId });
    const line = board.split('\n').find((l) => l.includes('asks you to run the Tricot skill /long-one'))!;
    assert.match(line, /Its instructions \(cut short; the whole text is in get_task\): step0 step1 /);
    assert.ok(line.includes('…'));
    assert.ok(line.length < INSTRUCTIONS_CLIP + 400, `${line.length} characters`);
    assert.ok(!line.includes('step199'));
    assert.ok((await callText('Claude', 'get_task', { task_id: task.id })).includes(`    ${long}`), 'whole in get_task');
    await post(`/skills/${made.json.id}/delete`, { actor: 'Wassim' });
  });

  it('sends one in a thread with the instructions, whole in get_thread', async () => {
    const boardId = await boardWithAgents('Thread request');
    const started = (await post(`/boards/${boardId}/threads`, { actor: 'Wassim', body: '@Codex /release-notes for the blog' })).json;
    assert.deepEqual(started.messages[0].skill.tricot, { instructions: NOTES, agents: ['Codex'] });
    const named = `thread "/release-notes for the blog" [thread id: ${started.id}]`;
    const asked = `asks you to run the Tricot skill /release-notes in ${named}: "for the blog". Its instructions: ${NOTES.replace(/\n/g, ' ')} Follow them, then reply with reply_in_thread(thread_id: ${started.id}); your reply shows "via /release-notes".`;
    assert.ok((await callText('Codex', 'get_board', { board_id: boardId })).includes(`Wassim ${asked}`));
    assert.ok((await callText('Codex', 'get_updates', { board_id: boardId, since: 0 })).includes(`Wassim (human) ${asked}`));
    const detail = await callText('Codex', 'get_thread', { thread_id: started.id });
    assert.match(detail, /\(asks you to run the Tricot skill \/release-notes\): @Codex \/release-notes for the blog\n {2}Instructions of the Tricot skill \/release-notes:\n {4}Read the commits/);
    assert.doesNotMatch(await callText('Claude', 'get_thread', { thread_id: started.id }), /Instructions of the Tricot skill/);
    await callText('Codex', 'reply_in_thread', { thread_id: started.id, body: 'Written.' });
    assert.equal((await get(`/threads/${started.id}`)).messages[1].via, 'release-notes');
  });

  it('keeps what a request carried when the skill changes or goes, and takes the new text for the next', async () => {
    const [notes] = store.tricotSkills();
    const boardId = await boardWithAgents('Edits');
    const task = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Edit' })).json;
    await post(`/tasks/${task.id}/comments`, { actor: 'Wassim', body: '@Claude /release-notes first' });
    const edited = await post(`/skills/${notes.id}`, { actor: 'Wassim', instructions: 'Just list the commits.', description: 'List the commits' });
    assert.equal(edited.status, 200);
    assert.equal(edited.json.instructions, 'Just list the commits.');
    assert.equal(edited.json.name, 'release-notes', 'the rest as it was');
    assert.equal((await skillsOf('Claude')).find((s) => s.name === 'release-notes')!.description, 'List the commits');
    await callText('Claude', 'comment', { task_id: task.id, body: 'First done.' });
    await post(`/tasks/${task.id}/comments`, { actor: 'Wassim', body: '@Claude /release-notes second' });
    const full = await callText('Claude', 'get_task', { task_id: task.id });
    assert.ok(full.includes(`    ${NOTES.split('\n')[0]}`), 'the first request keeps the text it carried');
    assert.ok(full.includes('    Just list the commits.'), 'the second takes the new');

    const renamed = await post(`/skills/${notes.id}`, { actor: 'Wassim', name: 'changelog' });
    assert.equal(renamed.json.name, 'changelog');
    const gone = (await post(`/tasks/${task.id}/comments`, { actor: 'Wassim', body: '@Claude /release-notes third' })).json.comments.at(-1);
    assert.equal(gone.skill, undefined, 'the old name is not a skill any more');
    await post(`/skills/${notes.id}/delete`, { actor: 'Wassim' });
    assert.ok(!(await skillsOf('Claude')).some((s) => s.name === 'changelog'));
    assert.equal((await post(`/tasks/${task.id}/comments`, { actor: 'Wassim', body: '@Claude /changelog fourth' })).json.comments.at(-1).skill, undefined);
    await callText('Claude', 'comment', { task_id: task.id, body: 'Second done.' });
    assert.ok((await callText('Claude', 'get_task', { task_id: task.id })).includes('    Just list the commits.'), 'a request already made still carries it');
  });

  it("names none: a skill for every agent is not asked of them all, and one for a single agent is", async () => {
    const all = await post('/skills', { actor: 'Wassim', name: 'triage', description: 'Triage', instructions: 'Triage the card.' });
    const boardId = await boardWithAgents('Who is asked');
    const task = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Triage me' })).json;
    const comment = async (body: string) => (await post(`/tasks/${task.id}/comments`, { actor: 'Wassim', body })).json.comments.at(-1);
    assert.equal((await comment('/triage this')).skill, undefined);
    assert.deepEqual((await comment('/codex-only this')).skill.agents, ['Codex']);
    assert.deepEqual((await comment('@Codex @Claude /triage this')).skill.tricot.agents.sort(), ['Claude', 'Codex']);
    await post(`/skills/${all.json.id}/delete`, { actor: 'Wassim' });
  });

  it("calls the Tricot skill /tricot:name when an agent has its own of that name, and the agent's own is /name", async () => {
    const clash = await post('/skills', { actor: 'Wassim', name: 'review', description: 'The Tricot review', instructions: 'Review it the Tricot way.' });
    const claude = await skillsOf('Claude');
    assert.deepEqual(claude.filter((s) => s.name === 'review').map((s) => [s.description, s.call]), [["Claude's own review", undefined], ['The Tricot review', 'tricot:review']]);
    assert.equal((await skillsOf('Codex')).find((s) => s.name === 'review')!.call, undefined, 'Codex has none of its own: /review is the Tricot one');

    const boardId = await boardWithAgents('Clash');
    const task = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Review' })).json;
    const since = store.getBoard(boardId).seq;
    const send = async (body: string) => (await post(`/tasks/${task.id}/comments`, { actor: 'Wassim', body })).json.comments.at(-1);
    assert.deepEqual((await send('@Claude /review the diff')).skill, { name: 'review', args: 'the diff', agents: ['Claude'] });
    const tricot = await send('@Claude /tricot:review the diff');
    assert.deepEqual(tricot.skill, { name: 'tricot:review', args: 'the diff', agents: ['Claude'], tricot: { instructions: 'Review it the Tricot way.', agents: ['Claude'] } });
    const mixed = await send('@Claude @Codex /review the diff');
    assert.deepEqual(mixed.skill.agents.sort(), ['Claude', 'Codex']);
    assert.deepEqual(mixed.skill.tricot.agents, ['Codex']);

    const forClaude = await callText('Claude', 'get_updates', { board_id: boardId, since });
    const lines = forClaude.split('\n').filter((l) => l.startsWith('- (') && l.includes('asks you to run'));
    assert.equal(lines.length, 3);
    assert.match(lines[0], /asks you to run \/review on T1 .*: "the diff"\. Run it, then reply/);
    assert.match(lines[1], /asks you to run the Tricot skill \/tricot:review on T1 .*: "the diff"\. Its instructions: Review it the Tricot way\. Follow them/);
    assert.match(lines[2], /asks you to run \/review on T1 .*: "the diff"\. Run it, then reply/, 'Claude runs its own, with no instructions, when both are asked');
    const forCodex = await callText('Codex', 'get_updates', { board_id: boardId, since });
    assert.match(forCodex, /asks you to run the Tricot skill \/review on T1 .*Its instructions: Review it the Tricot way\. Follow them/);
    await post(`/skills/${clash.json.id}/delete`, { actor: 'Wassim' });
  });

  it("shows an agent's activity and work for its panel", async () => {
    const boardId = await boardWithAgents('Panel');
    const task = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Panel work' })).json;
    await post(`/tasks/${task.id}`, { actor: 'Wassim', status: 'todo' });
    await callText('Claude', 'claim_task', { task_id: task.id });
    const work = await get('/agents/claude/work');
    assert.deepEqual(work.map((t: { id: string; number: number; boardId: string; boardTitle: string; status: string }) => [t.id, t.number, t.boardId, t.boardTitle, t.status]), [[task.id, 1, boardId, 'Panel', 'in_progress']]);
    assert.deepEqual(await get('/agents/Codex/work'), []);

    const mine = await get(`/boards/${boardId}/events?actor=claude`);
    assert.ok(mine.events.length >= 1);
    assert.ok(mine.events.every((e: { actor: { kind: string; name: string } }) => e.actor.kind === 'agent' && e.actor.name === 'Claude'));
    assert.equal(mine.total, mine.events.length);
    const all = await get(`/boards/${boardId}/events`);
    assert.ok(all.events.length > mine.events.length, 'the others are left out');
    assert.deepEqual((await get(`/boards/${boardId}/events?actor=Wassim`)).events, [], 'only agents');
    const seen = (await get('/agents')).find((a: { name: string }) => a.name === 'Claude');
    assert.deepEqual(seen.board.id, (await get('/agents?board=' + boardId)).find((a: { name: string }) => a.name === 'Claude').board.id);
  });

  it('reads each of several comments or messages made in the same millisecond as its own', async () => {
    const boardId = await boardWithAgents('Same millisecond');
    const task = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Quick' })).json;
    const since = store.getBoard(boardId).seq;
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      await post(`/tasks/${task.id}/comments`, { actor: 'Wassim', body: '@Claude first' });
      await post(`/tasks/${task.id}/comments`, { actor: 'Wassim', body: '@Codex second' });
      await post(`/tasks/${task.id}/comments`, { actor: 'Wassim', body: '@Claude third' });
      const thread = (await post(`/boards/${boardId}/threads`, { actor: 'Wassim', body: '@Claude one' })).json;
      await post(`/threads/${thread.id}/messages`, { actor: 'Wassim', body: '@Codex two' });
    } finally {
      mock.timers.reset();
    }
    const updates = await callText('Claude', 'get_updates', { board_id: boardId, since });
    const lines = updates.split('\n').filter((l) => l.startsWith('- ('));
    assert.equal(lines.length, 5, updates);
    assert.match(lines[0], /asked you on T1 .*: "first"\. /);
    assert.match(lines[1], /asked Codex on T1 .*Not for you/);
    assert.match(lines[2], /asked you on T1 .*: "third"\. /);
    assert.match(lines[3], /asked you in thread .*: "one"\. /);
    assert.match(lines[4], /asked Codex in thread .*Not for you/);
  });

  it('is kept when Tricot starts again', async () => {
    const made = await post('/skills', { actor: 'Wassim', name: 'kept', description: 'Kept', instructions: 'Keep it.', agent: 'Claude' });
    await store.flush();
    const reopened = new Store(dir);
    reopened.load();
    assert.deepEqual(reopened.tricotSkills().find((s) => s.name === 'kept'), made.json);
  });
});
