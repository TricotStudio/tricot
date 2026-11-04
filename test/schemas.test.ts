import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describeIssues, LIMITS, people, tools } from '../src/core/schemas';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';
import { z } from 'zod';

// One schema set stands behind REST and MCP: the same bad input is refused in
// the same words whichever way it comes in. Each case sends one bad input
// through a REST route and the MCP tool that does the same, and expects both
// to say `message`. Fields that are named the same on both sides are used, so
// the message can be the same to the letter.

interface Ids {
  board: string;
  decision: string;
  task: string;
  thread: string;
  block: string;
  other: string;
}

interface Case {
  name: string;
  rest: (ids: Ids) => { method?: 'GET' | 'POST'; route: string; body?: Record<string, unknown> };
  mcp: (ids: Ids) => { tool: string; args: Record<string, unknown> };
  message: string;
  status?: number; // what REST answers: 400 unless it is an id that isn't there
}

const x = (n: number) => 'x'.repeat(n);
const human = { actor: 'Wassim' };

const CASES: Case[] = [
  // ---- boards ----
  {
    name: 'a board without a title',
    rest: () => ({ route: '/boards', body: { ...human } }),
    mcp: () => ({ tool: 'create_board', args: {} }),
    message: 'title is required.',
  },
  {
    name: 'a board whose title is not text',
    rest: () => ({ route: '/boards', body: { ...human, title: 5 } }),
    mcp: () => ({ tool: 'create_board', args: { title: 5 } }),
    message: 'title must be a string.',
  },
  {
    name: 'a board with a blank title',
    rest: () => ({ route: '/boards', body: { ...human, title: '   ' } }),
    mcp: () => ({ tool: 'create_board', args: { title: '   ' } }),
    message: 'title must not be empty.',
  },
  {
    name: 'a board with a title over the limit',
    rest: () => ({ route: '/boards', body: { ...human, title: x(LIMITS.boardTitle + 1) } }),
    mcp: () => ({ tool: 'create_board', args: { title: x(LIMITS.boardTitle + 1) } }),
    message: 'A board title is too long (max 200 characters).',
  },
  {
    name: 'a board with a goal over the limit',
    rest: () => ({ route: '/boards', body: { ...human, title: 'Goal', goal: x(LIMITS.goal + 1) } }),
    mcp: () => ({ tool: 'create_board', args: { title: 'Goal', goal: x(LIMITS.goal + 1) } }),
    message: 'A goal is too long (max 2000 characters).',
  },

  // ---- decisions ----
  {
    name: 'a decision without a question',
    rest: (ids) => ({ route: `/boards/${ids.board}/decisions`, body: { ...human } }),
    mcp: (ids) => ({ tool: 'post_decision', args: { board_id: ids.board } }),
    message: 'question is required.',
  },
  {
    name: 'a decision with a blank question',
    rest: (ids) => ({ route: `/boards/${ids.board}/decisions`, body: { ...human, question: ' ' } }),
    mcp: (ids) => ({ tool: 'post_decision', args: { board_id: ids.board, question: ' ' } }),
    message: 'question must not be empty.',
  },
  {
    name: 'a decision whose context is not text',
    rest: (ids) => ({ route: `/boards/${ids.board}/decisions`, body: { ...human, question: 'Q?', context: 7 } }),
    mcp: (ids) => ({ tool: 'post_decision', args: { board_id: ids.board, question: 'Q?', context: 7 } }),
    message: 'context must be a string.',
  },
  {
    name: 'a decision with an area over the limit',
    rest: (ids) => ({ route: `/boards/${ids.board}/decisions`, body: { ...human, question: 'Q?', area: x(LIMITS.area + 1) } }),
    mcp: (ids) => ({ tool: 'post_decision', args: { board_id: ids.board, question: 'Q?', area: x(LIMITS.area + 1) } }),
    message: 'An area is too long (max 60 characters).',
  },
  {
    name: 'a decision on a board that is not there',
    rest: () => ({ route: '/boards/no-such-board/decisions', body: { ...human, question: 'Q?' } }),
    mcp: () => ({ tool: 'post_decision', args: { board_id: 'no-such-board', question: 'Q?' } }),
    message: 'No board with id "no-such-board".',
    status: 404,
  },
  {
    name: 'a comment on a decision with no body',
    rest: (ids) => ({ route: `/decisions/${ids.decision}/comments`, body: { ...human } }),
    mcp: (ids) => ({ tool: 'comment', args: { decision_id: ids.decision } }),
    message: 'body is required.',
  },
  {
    name: 'a blank comment on a decision',
    rest: (ids) => ({ route: `/decisions/${ids.decision}/comments`, body: { ...human, body: '  ' } }),
    mcp: (ids) => ({ tool: 'comment', args: { decision_id: ids.decision, body: '  ' } }),
    message: 'comment must not be empty.',
  },
  {
    name: 'a comment on a decision over the limit',
    rest: (ids) => ({ route: `/decisions/${ids.decision}/comments`, body: { ...human, body: x(LIMITS.comment + 1) } }),
    mcp: (ids) => ({ tool: 'comment', args: { decision_id: ids.decision, body: x(LIMITS.comment + 1) } }),
    message: 'A comment is too long (max 10000 characters).',
  },
  {
    name: 'a comment on a decision that is not there',
    rest: () => ({ route: '/decisions/nope/comments', body: { ...human, body: 'Hi' } }),
    mcp: () => ({ tool: 'comment', args: { decision_id: 'nope', body: 'Hi' } }),
    message: 'No decision with id "nope".',
    status: 404,
  },
  {
    name: 'a comment on a task over the limit',
    rest: (ids) => ({ route: `/tasks/${ids.task}/comments`, body: { ...human, body: x(LIMITS.comment + 1) } }),
    mcp: (ids) => ({ tool: 'comment', args: { task_id: ids.task, body: x(LIMITS.comment + 1) } }),
    message: 'A comment is too long (max 10000 characters).',
  },
  {
    name: 'a comment on a task that is not there',
    rest: () => ({ route: '/tasks/nope/comments', body: { ...human, body: 'Hi' } }),
    mcp: () => ({ tool: 'comment', args: { task_id: 'nope', body: 'Hi' } }),
    message: 'No task with id "nope".',
    status: 404,
  },
  {
    name: 'people asked with none named',
    rest: (ids) => ({ route: `/decisions/${ids.decision}/ask`, body: { ...human, names: [] } }),
    mcp: (ids) => ({ tool: 'ask_people', args: { decision_id: ids.decision, people: [] } }),
    message: 'Ask at least one person.',
  },
  {
    name: 'more people asked than the limit',
    rest: (ids) => ({ route: `/decisions/${ids.decision}/ask`, body: { ...human, names: Array.from({ length: 11 }, (_, i) => `P${i}`) } }),
    mcp: (ids) => ({ tool: 'ask_people', args: { decision_id: ids.decision, people: Array.from({ length: 11 }, (_, i) => `P${i}`) } }),
    message: 'Ask at most 10 people at once.',
  },
  {
    name: 'a name over the limit',
    rest: (ids) => ({ route: `/decisions/${ids.decision}/ask`, body: { ...human, names: [x(LIMITS.name + 1)] } }),
    mcp: (ids) => ({ tool: 'ask_people', args: { decision_id: ids.decision, people: [x(LIMITS.name + 1)] } }),
    message: 'A name is too long (max 60 characters).',
  },
  {
    name: 'a note on an ask over the limit',
    rest: (ids) => ({ route: `/decisions/${ids.decision}/ask`, body: { ...human, names: ['Sam'], note: x(LIMITS.note + 1) } }),
    mcp: (ids) => ({ tool: 'ask_people', args: { decision_id: ids.decision, people: ['Sam'], note: x(LIMITS.note + 1) } }),
    message: 'A note is too long (max 2000 characters).',
  },
  {
    name: 'a criterion with a blank label',
    rest: (ids) => ({ route: `/decisions/${ids.decision}/criteria`, body: { ...human, label: ' ' } }),
    mcp: (ids) => ({ tool: 'propose_criteria', args: { decision_id: ids.decision, criteria: [{ label: ' ' }] } }),
    message: 'criterion must not be empty.',
  },
  {
    name: 'a criterion over the limit',
    rest: (ids) => ({ route: `/decisions/${ids.decision}/criteria`, body: { ...human, label: x(LIMITS.criterion + 1) } }),
    mcp: (ids) => ({ tool: 'propose_criteria', args: { decision_id: ids.decision, criteria: [{ label: x(LIMITS.criterion + 1) }] } }),
    message: 'A criterion is too long (max 120 characters).',
  },

  // ---- tasks ----
  {
    name: 'a task with a blank title',
    rest: (ids) => ({ route: `/boards/${ids.board}/tasks`, body: { ...human, title: ' ' } }),
    mcp: (ids) => ({ tool: 'plan_tasks', args: { board_id: ids.board, tasks: [{ title: ' ' }] } }),
    message: 'task title must not be empty.',
  },
  {
    name: 'a task with a title over the limit',
    rest: (ids) => ({ route: `/boards/${ids.board}/tasks`, body: { ...human, title: x(LIMITS.taskTitle + 1) } }),
    mcp: (ids) => ({ tool: 'plan_tasks', args: { board_id: ids.board, tasks: [{ title: x(LIMITS.taskTitle + 1) }] } }),
    message: 'A task title is too long (max 200 characters).',
  },
  {
    name: 'a task with detail over the limit',
    rest: (ids) => ({ route: `/boards/${ids.board}/tasks`, body: { ...human, title: 'T', detail: x(LIMITS.taskDetail + 1) } }),
    mcp: (ids) => ({ tool: 'plan_tasks', args: { board_id: ids.board, tasks: [{ title: 'T', detail: x(LIMITS.taskDetail + 1) }] } }),
    message: 'Task detail is too long (max 4000 characters).',
  },
  {
    name: 'a task update whose note is not text',
    rest: (ids) => ({ route: `/tasks/${ids.task}`, body: { ...human, note: 3 } }),
    mcp: (ids) => ({ tool: 'update_task', args: { task_id: ids.task, note: 3 } }),
    message: 'note must be a string.',
  },
  {
    name: 'a task update with a blank note',
    rest: (ids) => ({ route: `/tasks/${ids.task}`, body: { ...human, note: ' ' } }),
    mcp: (ids) => ({ tool: 'update_task', args: { task_id: ids.task, note: ' ' } }),
    message: 'note must not be empty.',
  },
  {
    name: 'a task update with a note over the limit',
    rest: (ids) => ({ route: `/tasks/${ids.task}`, body: { ...human, note: x(LIMITS.note + 1) } }),
    mcp: (ids) => ({ tool: 'update_task', args: { task_id: ids.task, note: x(LIMITS.note + 1) } }),
    message: 'A note is too long (max 2000 characters).',
  },
  {
    name: 'a task update with a link over the limit',
    rest: (ids) => ({ route: `/tasks/${ids.task}`, body: { ...human, link: x(LIMITS.taskLink + 1) } }),
    mcp: (ids) => ({ tool: 'update_task', args: { task_id: ids.task, link: x(LIMITS.taskLink + 1) } }),
    message: 'A link is too long (max 500 characters).',
  },
  {
    name: 'a task update with an assignee over the limit',
    rest: (ids) => ({ route: `/tasks/${ids.task}`, body: { ...human, assignee: x(LIMITS.name + 1) } }),
    mcp: (ids) => ({ tool: 'update_task', args: { task_id: ids.task, assignee: x(LIMITS.name + 1) } }),
    message: 'An assignee is too long (max 60 characters).',
  },
  {
    name: 'a task update with a blank nothing-to-commit reason',
    rest: (ids) => ({ route: `/tasks/${ids.task}`, body: { ...human, nothingToCommit: ' ' } }),
    mcp: (ids) => ({ tool: 'update_task', args: { task_id: ids.task, nothing_to_commit: ' ' } }),
    message: 'reason must not be empty.',
  },
  {
    name: 'a task update with a nothing-to-commit reason over the limit',
    rest: (ids) => ({ route: `/tasks/${ids.task}`, body: { ...human, nothingToCommit: x(LIMITS.noCommit + 1) } }),
    mcp: (ids) => ({ tool: 'update_task', args: { task_id: ids.task, nothing_to_commit: x(LIMITS.noCommit + 1) } }),
    message: 'A reason is too long (max 300 characters).',
  },
  {
    name: 'a task update with decision ids that are not a list',
    rest: (ids) => ({ route: `/tasks/${ids.task}`, body: { ...human, decisionIds: 'a' } }),
    mcp: (ids) => ({ tool: 'update_task', args: { task_id: ids.task, decision_ids: 'a' } }),
    message: 'decisionIds must be an array.', // MCP names it decision_ids
  },
  {
    name: 'a task that is not there',
    rest: () => ({ route: '/tasks/nope', body: { ...human, note: 'Hi' } }),
    mcp: () => ({ tool: 'update_task', args: { task_id: 'nope', note: 'Hi' } }),
    message: 'No task with id "nope".',
    status: 404,
  },

  // ---- reactions ----
  {
    name: 'a reaction that is not one of the three',
    rest: (ids) => ({ route: `/tasks/${ids.task}/comments/any/reactions`, body: { ...human, emoji: '🎉' } }),
    mcp: (ids) => ({ tool: 'react', args: { task_id: ids.task, emoji: '🎉' } }),
    message: 'emoji must be one of: 👍, 👎, 👀.',
  },
  {
    name: 'a reaction taken back that is not a yes or no',
    rest: (ids) => ({ route: `/tasks/${ids.task}/comments/any/reactions`, body: { ...human, emoji: '👍', remove: 'yes' } }),
    mcp: (ids) => ({ tool: 'react', args: { task_id: ids.task, emoji: '👍', remove: 'yes' } }),
    message: 'remove must be true or false.',
  },
  {
    name: 'a reaction to a comment that is not there',
    rest: (ids) => ({ route: `/tasks/${ids.task}/comments/nope/reactions`, body: { ...human, emoji: '👍' } }),
    mcp: (ids) => ({ tool: 'react', args: { task_id: ids.task, comment_id: 'nope', emoji: '👍' } }),
    message: 'No comment or message "nope" on T1.',
    status: 404,
  },

  // ---- threads ----
  {
    name: 'a thread started with no body',
    rest: (ids) => ({ route: `/boards/${ids.board}/threads`, body: { ...human } }),
    mcp: (ids) => ({ tool: 'start_thread', args: { board_id: ids.board } }),
    message: 'body is required.',
  },
  {
    name: 'a thread started with a blank body',
    rest: (ids) => ({ route: `/boards/${ids.board}/threads`, body: { ...human, body: ' ' } }),
    mcp: (ids) => ({ tool: 'start_thread', args: { board_id: ids.board, body: ' ' } }),
    message: 'A message must not be empty.',
  },
  {
    name: 'a thread started with a body over the limit',
    rest: (ids) => ({ route: `/boards/${ids.board}/threads`, body: { ...human, body: x(LIMITS.message + 1) } }),
    mcp: (ids) => ({ tool: 'start_thread', args: { board_id: ids.board, body: x(LIMITS.message + 1) } }),
    message: 'A message is too long (max 10000 characters).',
  },
  {
    name: 'a thread with a lens name over the limit',
    rest: (ids) => ({ route: `/boards/${ids.board}/threads`, body: { ...human, body: 'Hi', lens: { name: x(LIMITS.lensName + 1), brief: 'Answer.' } } }),
    mcp: (ids) => ({ tool: 'start_thread', args: { board_id: ids.board, body: 'Hi', lens: x(LIMITS.lensName + 1), lens_brief: 'Answer.' } }),
    message: 'A lens name is too long (max 24 characters).',
  },
  {
    name: 'a thread with a lens brief over the limit',
    rest: (ids) => ({ route: `/boards/${ids.board}/threads`, body: { ...human, body: 'Hi', lens: { name: 'Mine', brief: x(LIMITS.lensBrief + 1) } } }),
    mcp: (ids) => ({ tool: 'start_thread', args: { board_id: ids.board, body: 'Hi', lens: 'Mine', lens_brief: x(LIMITS.lensBrief + 1) } }),
    message: 'A lens brief is too long (max 300 characters).',
  },
  {
    name: 'a thread started on a board that is not there',
    rest: () => ({ route: '/boards/nope/threads', body: { ...human, body: 'Hi' } }),
    mcp: () => ({ tool: 'start_thread', args: { board_id: 'nope', body: 'Hi' } }),
    message: 'No board with id "nope".',
    status: 404,
  },
  {
    name: 'a reply with a body over the limit',
    rest: (ids) => ({ route: `/threads/${ids.thread}/messages`, body: { ...human, body: x(LIMITS.message + 1) } }),
    mcp: (ids) => ({ tool: 'reply_in_thread', args: { thread_id: ids.thread, body: x(LIMITS.message + 1) } }),
    message: 'A message is too long (max 10000 characters).',
  },
  {
    name: 'a reply in a thread that is not there',
    rest: () => ({ route: '/threads/nope/messages', body: { ...human, body: 'Hi' } }),
    mcp: () => ({ tool: 'reply_in_thread', args: { thread_id: 'nope', body: 'Hi' } }),
    message: 'No thread with id "nope".',
    status: 404,
  },

  // ---- the canvas ----
  {
    name: 'a group with a blank title',
    rest: (ids) => ({ route: '/canvas/groups', body: { ...human, boardId: ids.board, title: ' ' } }),
    mcp: (ids) => ({ tool: 'add_group', args: { board_id: ids.board, title: ' ' } }),
    message: 'group title must not be empty.',
  },
  {
    name: 'a group with a title over the limit',
    rest: (ids) => ({ route: '/canvas/groups', body: { ...human, boardId: ids.board, title: x(LIMITS.title + 1) } }),
    mcp: (ids) => ({ tool: 'add_group', args: { board_id: ids.board, title: x(LIMITS.title + 1) } }),
    message: 'A group title is too long (max 120 characters).',
  },
  {
    name: 'a link with a label over the limit',
    rest: (ids) => ({ route: '/canvas/links', body: { ...human, from: ids.block, to: ids.other, label: x(LIMITS.title + 1) } }),
    mcp: (ids) => ({ tool: 'link', args: { from_block_id: ids.block, to_block_id: ids.other, label: x(LIMITS.title + 1) } }),
    message: 'A link label is too long (max 120 characters).',
  },
  {
    name: 'a note block over the limit',
    rest: (ids) => ({ route: '/canvas/blocks', body: { ...human, boardId: ids.board, content: { type: 'note', text: x(LIMITS.text + 1) } } }),
    mcp: (ids) => ({ tool: 'add_block', args: { board_id: ids.board, type: 'note', text: x(LIMITS.text + 1) } }),
    message: 'Note text is too long (max 20000 characters).',
  },
  {
    name: 'a table with too many columns',
    rest: (ids) => ({ route: '/canvas/blocks', body: { ...human, boardId: ids.board, content: { type: 'table', columns: Array.from({ length: 21 }, (_, i) => `C${i}`), rows: [] } } }),
    mcp: (ids) => ({ tool: 'add_block', args: { board_id: ids.board, type: 'table', columns: Array.from({ length: 21 }, (_, i) => `C${i}`), rows: [] } }),
    message: 'Tables can have at most 20 columns.',
  },
  {
    name: 'a link block with an address that is not http',
    rest: (ids) => ({ route: '/canvas/blocks', body: { ...human, boardId: ids.board, content: { type: 'link', url: 'ftp://example.com' } } }),
    mcp: (ids) => ({ tool: 'add_block', args: { board_id: ids.board, type: 'link', url: 'ftp://example.com' } }),
    message: 'A link must be an http or https address, e.g. https://example.com.',
  },
  {
    name: 'a block on a canvas given two ways',
    rest: (ids) => ({ route: '/canvas/blocks', body: { ...human, boardId: ids.board, decisionId: ids.decision, content: { type: 'note', text: 'Hi' } } }),
    mcp: (ids) => ({ tool: 'add_block', args: { board_id: ids.board, decision_id: ids.decision, type: 'note', text: 'Hi' } }),
    message: 'Pass exactly one of board_id (board context), decision_id or task_id.',
  },
  {
    name: 'a block change with a title over the limit',
    rest: (ids) => ({ route: `/canvas/blocks/${ids.block}`, body: { ...human, title: x(LIMITS.title + 1) } }),
    mcp: (ids) => ({ tool: 'update_block', args: { block_id: ids.block, rev: 1, title: x(LIMITS.title + 1) } }),
    message: 'A title is too long (max 120 characters).',
  },
  {
    name: 'a block change with note text over the limit',
    rest: (ids) => ({ route: `/canvas/blocks/${ids.block}`, body: { ...human, text: x(LIMITS.text + 1) } }),
    mcp: (ids) => ({ tool: 'update_block', args: { block_id: ids.block, rev: 1, text: x(LIMITS.text + 1) } }),
    message: 'Note text is too long (max 20000 characters).',
  },
  {
    name: 'a block that is not there',
    rest: () => ({ route: '/canvas/blocks/nope', body: { ...human, title: 'Hi' } }),
    mcp: () => ({ tool: 'update_block', args: { block_id: 'nope', rev: 1, title: 'Hi' } }),
    message: 'No canvas block, group, link or pin with id "nope".',
    status: 404,
  },

  // ---- search ----
  {
    name: 'a search for a kind that is not one',
    rest: (ids) => ({ method: 'GET', route: `/boards/${ids.board}/search?q=word&kinds=bogus` }),
    mcp: (ids) => ({ tool: 'search', args: { board_id: ids.board, query: 'word', kinds: ['bogus'] } }),
    message: 'Unknown kind "bogus". Kinds: decision, task, comment, finding, block.',
  },

  // ---- skills ----
  {
    name: 'a skill whose name is not one word',
    rest: () => ({ route: '/skills', body: { ...human, name: 'two words', description: 'Does it', instructions: 'Do it.' } }),
    mcp: () => ({ tool: 'report_skills', args: { skills: [{ name: 'two words', description: 'Does it' }] } }),
    message: 'A skill name is one word, e.g. review or plugin:review.',
  },
  {
    name: 'a skill with a name over the limit',
    rest: () => ({ route: '/skills', body: { ...human, name: x(LIMITS.skillName + 1), description: 'Does it', instructions: 'Do it.' } }),
    mcp: () => ({ tool: 'report_skills', args: { skills: [{ name: x(LIMITS.skillName + 1), description: 'Does it' }] } }),
    message: 'A skill name is too long (max 60 characters).',
  },
];

// The person's browser, let in as one of their seats (seatHelper.ts): it signs what needs one.
let seat: TestSeat;

describe('REST and MCP refuse the same input in the same words', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let client: Client;
  let store: Store;
  let ids: Ids;

  async function rest(method: 'GET' | 'POST', route: string, body?: Record<string, unknown>) {
    const response = await fetch(`${base}/api${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign(method, `/api${route}`, method === 'POST' ? JSON.stringify(body ?? {}) : '') },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    return { status: response.status, json: (await response.json()) as Record<string, any> };
  }

  async function call(name: string, args: Record<string, unknown>) {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: Boolean(result.isError), text: result.content[0].text };
  }

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-schemas-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    seat = letIn(app);
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Planner`)));

    const board = (await rest('POST', '/boards', { ...human, title: 'Schemas' })).json.id as string;
    const decision = (await rest('POST', `/boards/${board}/decisions`, { ...human, question: 'Which?', options: ['One', 'Two'] })).json.id as string;
    const task = (await rest('POST', `/boards/${board}/tasks`, { ...human, title: 'Do it' })).json.id as string;
    const thread = (await rest('POST', `/boards/${board}/threads`, { ...human, body: 'Hello there' })).json.id as string;
    const block = (await rest('POST', '/canvas/blocks', { ...human, boardId: board, content: { type: 'note', text: 'One' } })).json.id as string;
    const other = (await rest('POST', '/canvas/blocks', { ...human, boardId: board, content: { type: 'note', text: 'Two' } })).json.id as string;
    ids = { board, decision, task, thread, block, other };
  });

  after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const c of CASES) {
    it(`refuses ${c.name}`, async () => {
      const r = c.rest(ids);
      const m = c.mcp(ids);
      const viaRest = await rest(r.method ?? 'POST', r.route, r.body);
      const viaMcp = await call(m.tool, m.args);
      assert.equal(viaRest.status, c.status ?? 400, `REST answered ${JSON.stringify(viaRest.json)}`);
      assert.equal(viaMcp.isError, true, `MCP answered ${viaMcp.text}`);
      if (c.name === 'a task update with decision ids that are not a list') {
        // The fields are named as each side writes them: decisionIds, decision_ids.
        assert.equal(viaRest.json.error, c.message);
        assert.equal(viaMcp.text, c.message.replace('decisionIds', 'decision_ids'));
        return;
      }
      assert.equal(viaRest.json.error, c.message);
      assert.equal(viaMcp.text, c.message);
    });
  }

  it('says nothing of the protocol when an agent leaves out a field', async () => {
    const refused = await call('post_decision', { board_id: ids.board });
    assert.doesNotMatch(refused.text, /MCP error|Input validation|Invalid arguments/);
  });

  it('says every problem in one answer, each once', async () => {
    const viaRest = await rest('POST', `/boards/${ids.board}/decisions`, { ...human, question: 4, context: 5 });
    const viaMcp = await call('post_decision', { board_id: ids.board, question: 4, context: 5 });
    assert.equal(viaRest.json.error, 'question must be a string. context must be a string.');
    assert.equal(viaMcp.text, 'question must be a string. context must be a string.');
  });

  it('takes exactly what the limits allow, counted as the store counts', async () => {
    // Trimmed text is counted trimmed, a tidied name on one line.
    const comment = `  ${x(LIMITS.comment)}  `;
    assert.equal((await rest('POST', `/decisions/${ids.decision}/comments`, { ...human, body: comment })).status, 200);
    assert.equal((await call('comment', { decision_id: ids.decision, body: comment })).isError, false);
    const area = `${x(LIMITS.area - 4)}  ${'y'.repeat(2)}`;
    assert.equal((await call('update_decision', { decision_id: ids.decision, area })).isError, false);
    const person = `${'z'.repeat(LIMITS.area - 4)}  ${'y'.repeat(2)}`;
    assert.equal((await rest('POST', `/decisions/${ids.decision}/area`, { ...human, area: person })).status, 200);
    const lens = { name: x(LIMITS.lensName), brief: x(LIMITS.lensBrief) };
    assert.equal((await rest('POST', `/boards/${ids.board}/threads`, { ...human, body: 'Lens', lens })).status, 201);
    assert.equal((await call('start_thread', { board_id: ids.board, body: 'Lens', lens: lens.name, lens_brief: lens.brief })).isError, false);
  });

  it('keeps the statuses each side takes: people can send a task to the backlog, agents cannot', async () => {
    const people = await rest('POST', `/tasks/${ids.task}`, { ...human, status: 'bogus' });
    assert.equal(people.json.error, 'status must be one of: backlog, todo, in_progress, in_review, blocked, done.');
    const agent = await call('update_task', { task_id: ids.task, status: 'bogus' });
    assert.equal(agent.text, 'status must be one of: todo, in_progress, in_review, blocked, done.');
  });

  it('holds a search to the limit each side set: people up to 200 results, agents 50', async () => {
    assert.equal((await rest('GET', `/boards/${ids.board}/search?q=word&limit=201`)).json.error, 'limit must be at most 200.');
    assert.equal((await call('search', { board_id: ids.board, query: 'word', limit: 51 })).text, 'limit must be at most 50.');
  });

  it('refuses a call that sends nothing at all, in the same words', async () => {
    assert.equal((await call('post_decision', {})).text, 'board_id is required. question is required.');
  });
});

describe('describeIssues', () => {
  const run = (schema: z.ZodType, value: unknown) => {
    const result = schema.safeParse(value);
    assert.equal(result.success, false);
    return describeIssues((result as { error: z.ZodError }).error);
  };

  it('names where a problem is, as the sender wrote it', () => {
    const schema = z.object({ tasks: z.array(z.object({ title: z.string(), n: z.number().int() })) });
    assert.equal(run(schema, { tasks: [{ title: 'A', n: 1 }, { n: 1.5 }] }), 'tasks[1].title is required. tasks[1].n must be a whole number.');
  });

  it('says what a list or a choice may hold', () => {
    assert.equal(run(z.object({ a: z.array(z.string()).min(2) }), { a: [] }), 'a needs at least 2 items.');
    assert.equal(run(z.object({ a: z.array(z.string()).max(1) }), { a: ['x', 'y'] }), 'a can have at most 1 items.');
    assert.equal(run(z.object({ a: z.enum(['x', 'y']) }), { a: 'z' }), 'a must be one of: x, y.');
    assert.equal(run(z.object({ a: z.string().max(3) }), { a: 'abcd' }), 'a is too long (max 3 characters).');
  });

  it('keeps a message a schema wrote', () => {
    assert.equal(run(z.object({ a: z.string().refine(() => false, { error: 'Say it plainly.' }) }), { a: 'x' }), 'Say it plainly.');
  });

  it('holds the people schemas and the agent schemas to the same rule for a field', () => {
    const person = people.comment.shape.body;
    const agent = tools.comment.body;
    for (const body of ['', ' ', x(LIMITS.comment + 1), 7, undefined]) {
      const a = person.safeParse(body);
      const b = agent.safeParse(body);
      assert.equal(a.success, b.success);
      if (!a.success && !b.success) assert.deepEqual(a.error.issues.map((i) => i.message), b.error.issues.map((i) => i.message));
    }
  });
});
