import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { searchBoards, snippetAround, type SearchOptions, type SearchResult } from '../src/core/search';
import { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import { createApp } from '../src/server/app';
import { removeScratch } from './platform';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const sam: Actor = { kind: 'human', name: 'Sam' };

// What a result's ranges mark in its text.
const marked = (text: string, ranges: [number, number][]) => ranges.map(([s, e]) => text.slice(s, e));

describe('Search', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-search-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Login' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  const search = (query: string, options: SearchOptions = {}) =>
    searchBoards(store.listBoards().map((b) => store.getBoard(b.id)), query, { boardId, ...options });
  const one = (query: string, options: SearchOptions = {}): SearchResult => {
    const { results } = search(query, options);
    assert.equal(results.length, 1, `one result for "${query}": ${results.map((r) => `${r.kind} ${r.ref}`).join(', ')}`);
    return results[0];
  };

  it('finds decisions by question, context, options, answer and rationale', () => {
    const d = store.postDecision(
      boardId,
      {
        question: 'How do people sign in?',
        context: 'Most visitors come from **invite emails**.',
        options: [{ label: 'Magic links', description: 'A one-time link by email' }, { label: 'Passwords' }],
      },
      claude,
    );
    store.resolve(d.id, { optionId: 'a', rationale: 'Nobody remembers passwords; invites already carry an address' }, sam);

    const byQuestion = one('sign in');
    assert.equal(byQuestion.kind, 'decision');
    assert.equal(byQuestion.ref, `#${d.number}`);
    assert.deepEqual(byQuestion.target, { decisionId: d.id });
    assert.deepEqual(marked(byQuestion.title, byQuestion.titleRanges), ['sign in']);
    assert.equal(byQuestion.closed, 'decided', 'closed cards are found, and say so');
    assert.equal(byQuestion.status, 'decided');

    assert.equal(one('invite emails').snippet?.where, 'Context');
    assert.equal(one('invite emails').snippet?.text, 'Most visitors come from invite emails.', 'Markdown reads as text');
    assert.equal(one('one-time link').snippet?.where, 'Option a');
    assert.equal(one('remembers').snippet?.where, 'Rationale');
  });

  it('finds tasks by title, detail and progress notes', () => {
    const [task] = store.planTasks(boardId, [{ title: 'Build the login page', detail: 'Email field and a send button' }], claude);
    store.updateTask(task.id, { status: 'in_progress', note: 'Rate limiting done; styling next' }, claude);

    const byTitle = one('login page');
    assert.equal(byTitle.kind, 'task');
    assert.equal(byTitle.ref, `T${task.number}`);
    assert.deepEqual(byTitle.target, { taskId: task.id });
    assert.equal(byTitle.status, 'in_progress');
    assert.equal(byTitle.closed, undefined);
    assert.equal(one('send button').snippet?.where, 'Detail');
    assert.equal(one('rate limiting').snippet?.where, 'Note by Claude');
  });

  it('finds comments on decisions, on tasks and in pin threads on the board context', () => {
    const d = store.postDecision(boardId, { question: 'Session length?' }, claude);
    store.addComment(d.id, 'Thirty days feels long for shared laptops', sam);
    const [task] = store.planTasks(boardId, [{ title: 'Remember me' }], claude);
    store.addTaskComment(task.id, 'Should the checkbox default to off on kiosks?', sam);
    const note = store.addBlock({ boardId }, { title: 'Constraints', content: { type: 'note', text: 'SSO later' } }, sam);
    const { pin, comment } = store.pinComment(note.id, { kind: 'block' }, 'Which providers count as SSO here?', sam);

    const onDecision = one('shared laptops');
    assert.equal(onDecision.kind, 'comment');
    assert.equal(onDecision.ref, `#${d.number}`);
    assert.equal(onDecision.title, 'Session length?', "the owning card's title");
    assert.equal(onDecision.snippet?.where, 'Comment by Sam');
    assert.equal(onDecision.target.decisionId, d.id);
    assert.ok(onDecision.target.commentId);

    const onTask = one('kiosks');
    assert.equal(onTask.ref, `T${task.number}`);
    assert.equal(onTask.target.taskId, task.id);

    const inThread = one('providers', { kinds: ['comment'] });
    assert.equal(inThread.ref, 'Board Context');
    assert.deepEqual(inThread.target, { canvas: 'board', blockId: note.id, pinId: pin.id, commentId: comment.id });
  });

  it('finds findings, by summary and metrics', () => {
    const d = store.postDecision(boardId, { question: 'Which mailer?', options: [{ label: 'Postmark' }, { label: 'SES' }] }, claude);
    store.attachFinding(d.id, { optionId: 'b', summary: 'Cheapest at our volume', metrics: { p95_delivery: '4s' } }, claude);

    const found = one('cheapest');
    assert.equal(found.kind, 'finding');
    assert.equal(found.ref, `#${d.number}`);
    assert.equal(found.snippet?.where, 'Finding on option b');
    assert.equal(one('p95').snippet?.text, 'p95_delivery: 4s');
  });

  it('finds every kind of canvas block, on the board context and on cards', () => {
    const d = store.postDecision(boardId, { question: 'Login flow?' }, claude);
    const [task] = store.planTasks(boardId, [{ title: 'Ship it' }], claude);
    const add = (ref: { boardId?: string; decisionId?: string; taskId?: string }, title: string | undefined, content: never) =>
      store.addBlock(ref, { title, content }, claude);
    const note = add({ boardId }, 'Where things stand', { type: 'note', text: 'Magic links are **live** for staff' } as never);
    const table = add({ decisionId: d.id }, 'Providers', { type: 'table', columns: ['Name', 'Cost'], rows: [['Postmark', '$15'], ['Mailgun', '$35']] } as never);
    const checklist = add({ taskId: task.id }, undefined, { type: 'note', text: '- [ ] Write the welcome copy' } as never);
    const diagram = add({ decisionId: d.id }, undefined, {
      type: 'diagram',
      source: 'flowchart LR\n  A["Enter email"] -->|sends| B(Check inbox)\n  B --> C{Link valid?}',
    } as never);
    const image = add({ boardId }, undefined, { type: 'image', assetId: store.saveAsset(PNG), caption: 'Mock of the waiting screen' } as never);
    const link = add({ boardId }, 'Auth spec', { type: 'link', url: 'https://example.com/specs/auth' } as never);

    const onContext = one('live for staff');
    assert.equal(onContext.kind, 'block');
    assert.equal(onContext.ref, 'Board Context');
    assert.equal(onContext.title, 'Where things stand', "on the board context, the block's title");
    assert.equal(onContext.snippet?.text, 'Magic links are live for staff');
    assert.deepEqual(onContext.target, { canvas: 'board', blockId: note.id });

    const cell = one('mailgun');
    assert.equal(cell.ref, `#${d.number}`);
    assert.equal(cell.title, 'Login flow?', "on a card's canvas, the card's title");
    assert.equal(cell.snippet?.where, 'Table "Providers"');
    assert.equal(cell.snippet?.text, 'Mailgun · $35');
    assert.deepEqual(cell.target, { canvas: 'decision', decisionId: d.id, blockId: table.id });

    assert.deepEqual(one('welcome copy').target, { canvas: 'task', taskId: task.id, blockId: checklist.id });

    const chart = one('check inbox');
    assert.equal(chart.target.blockId, diagram.id);
    assert.equal(chart.snippet?.text, 'Enter email · Check inbox · Link valid? · sends', 'node and arrow text, without Mermaid syntax');
    assert.equal(search('flowchart').total, 0, 'the syntax itself is not searched');

    assert.equal(one('waiting screen').target.blockId, image.id);
    assert.equal(one('auth spec').target.blockId, link.id, 'a link by its title');
    assert.equal(one('example.com/specs').target.blockId, link.id, 'and by its address');
  });

  it('needs every word, each anywhere in the item', () => {
    store.postDecision(boardId, { question: 'Magic links or passwords?' }, claude);
    store.postDecision(boardId, { question: 'Magic numbers in config', context: 'Move them to env' }, claude);
    assert.equal(search('magic').total, 2);
    assert.equal(one('magic passwords').title, 'Magic links or passwords?');
    assert.equal(one('magic env').title, 'Magic numbers in config', 'one word in the question, one in the context');
    assert.equal(search('magic sso').total, 0);
    assert.equal(one('pass').title, 'Magic links or passwords?', 'a word matches the start of a longer one');
    assert.equal(search('words').total, 0, 'but not inside one');
  });

  it('ignores case and accents, and marks the words as written', () => {
    store.postDecision(boardId, { question: 'Café menu: crème brûlée or SORBET?' }, claude);
    const found = one('creme brulee');
    assert.deepEqual(marked(found.title, found.titleRanges), ['crème brûlée']);
    assert.deepEqual(marked(found.title, one('CAFÉ sorbet').titleRanges), ['Café', 'SORBET']);
    assert.equal(search('sign-in').total, 0);
    store.postDecision(boardId, { question: 'Where does the sign-in button go?' }, claude);
    assert.equal(one('sign in').title, 'Where does the sign-in button go?', 'hyphens read as spaces');
  });

  it('ranks a title match over a body match, the phrase over scattered words, then the latest', () => {
    const body = store.postDecision(boardId, { question: 'Copy for the landing page', context: 'Mention retry backoff' }, claude);
    const title = store.postDecision(boardId, { question: 'Retry backoff limits' }, claude);
    const scattered = store.postDecision(boardId, { question: 'Backoff after a failed retry' }, claude);
    assert.deepEqual(
      search('retry backoff').results.map((r) => r.target.decisionId),
      [title.id, scattered.id, body.id],
    );

    const older = store.postDecision(boardId, { question: 'Queue for webhooks' }, claude);
    const newer = store.postDecision(boardId, { question: 'Queue for emails' }, claude);
    store.getDecision(older.id).decision.updatedAt = '2026-01-01T00:00:00.000Z';
    store.getDecision(newer.id).decision.updatedAt = '2026-02-01T00:00:00.000Z';
    assert.deepEqual(
      search('queue').results.map((r) => r.target.decisionId),
      [newer.id, older.id],
      'equal matches: the latest first',
    );
  });

  it('includes closed cards unless asked for open ones only', () => {
    const decided = store.postDecision(boardId, { question: 'Email provider for login?' }, claude);
    store.resolve(decided.id, { answer: 'Postmark' }, sam);
    store.addComment(decided.id, 'Login emails need a dedicated stream', sam);
    const retired = store.postDecision(boardId, { question: 'Login with Myspace?' }, claude);
    store.retire(retired.id, 'Nobody asked', sam);
    const [done, open] = store.planTasks(boardId, [{ title: 'Login copy' }, { title: 'Login page' }], claude);
    store.updateTask(done.id, { status: 'done' }, sam);

    const all = search('login');
    assert.equal(all.total, 5);
    const closed = Object.fromEntries(all.results.map((r) => [r.target.commentId ? 'comment' : (r.target.decisionId ?? r.target.taskId), r.closed]));
    assert.deepEqual(closed, { [decided.id]: 'decided', [retired.id]: 'retired', [done.id]: 'done', [open.id]: undefined, comment: 'decided' });

    const openOnly = search('login', { openOnly: true });
    assert.deepEqual(openOnly.results.map((r) => r.target.taskId), [open.id], 'and what is on closed cards goes too');
  });

  it('searches the current board by default, and every board, archived ones too, when asked', () => {
    store.postDecision(boardId, { question: 'Retry policy here?' }, claude);
    const other = store.createBoard({ title: 'Billing' }, sam);
    store.postDecision(other.id, { question: 'Retry failed charges?' }, claude);
    store.setArchived(other.id, true, sam);

    assert.deepEqual(search('retry').results.map((r) => r.boardId), [boardId]);
    const everywhere = search('retry', { allBoards: true });
    assert.equal(everywhere.total, 2);
    const billing = everywhere.results.find((r) => r.boardId === other.id)!;
    assert.equal(billing.boardTitle, 'Billing');
    assert.equal(billing.boardArchived, true);
    assert.equal(search('retry', { boardId: 'no-such-board' }).total, 0);
  });

  it('filters by kind and limits the results, counting them all', () => {
    const d = store.postDecision(boardId, { question: 'Rollout plan?' }, claude);
    store.addComment(d.id, 'Rollout to staff first', sam);
    store.planTasks(boardId, [{ title: 'Rollout script' }, { title: 'Rollout dashboard' }], claude);
    assert.deepEqual(search('rollout', { kinds: ['task'] }).results.map((r) => r.kind), ['task', 'task']);
    assert.deepEqual(search('rollout', { kinds: ['decision', 'comment'] }).results.map((r) => r.kind).sort(), ['comment', 'decision']);
    const limited = search('rollout', { limit: 2 });
    assert.equal(limited.results.length, 2);
    assert.equal(limited.total, 4);
  });

  it('finds nothing for an empty or very short query', () => {
    store.postDecision(boardId, { question: 'A question' }, claude);
    for (const query of ['', '   ', 'a', '"q"']) assert.deepEqual(search(query), { results: [], total: 0 }, `"${query}"`);
  });

  it('cuts a long text to about 140 characters around the first match, keeping the ranges on the words', () => {
    const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6);
    store.postDecision(boardId, { question: 'Long context', context: `${filler}The real reason is quota exhaustion on Mondays. ${filler}` }, claude);
    const { snippet } = one('quota mondays');
    assert.ok(snippet);
    assert.ok(snippet.text.startsWith('…') && snippet.text.endsWith('…'), snippet.text);
    assert.ok(snippet.text.length <= 145, `${snippet.text.length} characters`);
    assert.deepEqual(marked(snippet.text, snippet.ranges), ['quota', 'Mondays']);

    const short = snippetAround('Short text with a match', [[18, 23]]);
    assert.deepEqual(short, { text: 'Short text with a match', ranges: [[18, 23]] });
    const atEnd = snippetAround(`${'word '.repeat(60)}finale`, [[300, 306]]);
    assert.ok(atEnd.text.endsWith('finale'));
    assert.deepEqual(marked(atEnd.text, atEnd.ranges), ['finale']);
  });
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

describe('Search over REST and MCP', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let client: Client;
  let store: Store;
  let boardId: string;
  let decisionId: string;
  let taskId: string;

  type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const get = async (route: string) => {
    const response = await fetch(`${base}/api${route}`);
    return { status: response.status, json: await response.json() };
  };

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-search-e2e-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Retry logic' }, sam).id;
    const d = store.postDecision(boardId, { question: 'Retry with exponential backoff?', options: [{ label: 'Yes' }, { label: 'No' }] }, claude);
    store.resolve(d.id, { optionId: 'a', rationale: 'Spreads load after outages' }, sam);
    decisionId = d.id;
    taskId = store.planTasks(boardId, [{ title: 'Add jitter to the backoff', decisionIds: [d.id] }], claude)[0].id;
    const other = store.createBoard({ title: 'Payments' }, sam);
    store.postDecision(other.id, { question: 'Backoff for webhooks?' }, claude);

    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Planner`)));
  });

  after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  it('searches a board, or every board, over REST', async () => {
    const board = await get(`/boards/${boardId}/search?q=backoff`);
    assert.equal(board.status, 200);
    assert.deepEqual(board.json.results.map((r: SearchResult) => r.ref).sort(), ['#1', 'T1']);
    assert.equal(board.json.total, 2);

    const tasks = await get(`/boards/${boardId}/search?q=backoff&kinds=task`);
    assert.deepEqual(tasks.json.results.map((r: SearchResult) => r.target.taskId), [taskId]);
    const open = await get(`/boards/${boardId}/search?q=backoff&open=1`);
    assert.deepEqual(open.json.results.map((r: SearchResult) => r.kind), ['task'], 'the decided decision is left out');

    const all = await get(`/boards/${boardId}/search?q=backoff&all=1`);
    assert.equal(all.json.total, 3);
    assert.equal((await get('/search?q=backoff&all=1')).json.total, 3, 'from no board at all');

    assert.deepEqual((await get(`/boards/${boardId}/search?q=b`)).json, { results: [], total: 0 }, 'a short query finds nothing');
    assert.equal((await get(`/boards/${boardId}/search?q=backoff&kinds=card`)).status, 400);
    assert.equal((await get('/search?q=backoff')).status, 400, 'no board and not all');
    assert.equal((await get('/boards/nope/search?q=backoff')).status, 404);
  });

  it('gives agents a search tool with ids to follow up on', async () => {
    const result = await call('search', { query: 'backoff', board_id: boardId });
    assert.ok(!result.isError, result.content[0].text);
    const text = result.content[0].text;
    assert.match(text, /^Found 2 for "backoff" on Retry logic \(closed cards included\)/);
    assert.match(text, new RegExp(`- #1 Retry with exponential backoff\\? \\(decided\\) \\[decision_id: ${decisionId}\\]`));
    assert.match(text, new RegExp(`- T1 Add jitter to the backoff \\(to do\\) \\[task_id: ${taskId}\\]`));

    const decision = await call('get_decision', { decision_id: decisionId });
    assert.match(decision.content[0].text, /Retry with exponential backoff/);

    const open = (await call('search', { query: 'backoff', board_id: boardId, include_closed: false })).content[0].text;
    assert.doesNotMatch(open, /#1/);
    const everywhere = (await call('search', { query: 'backoff', all_boards: true })).content[0].text;
    assert.match(everywhere, /across all boards/);
    assert.match(everywhere, /board "Payments"/);
    assert.match((await call('search', { query: 'nothing like it', board_id: boardId })).content[0].text, /^Nothing found/);

    const neither = await call('search', { query: 'backoff' });
    assert.ok(neither.isError);
    assert.match(neither.content[0].text, /board_id/);
    assert.match(client.getInstructions() ?? '', /search for an existing one/);
  });
});
