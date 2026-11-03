import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { INSTRUCTIONS, MAX_INSTRUCTIONS } from '../src/server/mcp';
import { eventsOf, versionsOf } from './tables';

type ToolResult = { content: { type: string; text: string; data?: string; mimeType?: string }[]; isError?: boolean };

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('MCP + REST end to end', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let client: Client;
  let store: Store;

  async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  }

  async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await call(name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content[0].text;
  }

  async function post(route: string, body: Record<string, unknown>) {
    const response = await fetch(`${base}/api${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  }

  before(async () => {
    // A dot-folder, like the default ~/.tricot.
    dir = mkdtempSync(path.join(os.tmpdir(), '.tricot-e2e-'));
    store = new Store(dir);
    store.load();
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
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes the protocol instructions and tools', async () => {
    assert.match(client.getInstructions() ?? '', /instead of asking questions in chat/);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        'add_block', 'add_group', 'ask_people', 'attach_finding', 'brief_task', 'claim_task', 'comment', 'create_board',
        'finish_request', 'finish_sync', 'get_block', 'get_board', 'get_canvas', 'get_decision', 'get_task', 'get_thread', 'get_updates',
        'link', 'list_boards', 'log_decision', 'pin', 'plan_tasks', 'post_decision', 'propose_criteria', 'react', 'remove_item', 'reply_in_thread',
        'report_skills', 'restore_item', 'search', 'start_thread', 'take_first_look', 'take_request', 'update_block', 'update_decision', 'update_task',
        'wait_for_updates',
      ],
    );
  });

  it('opens the instructions with the role, short enough that clients show them whole', async () => {
    // Claude Code shows agents about the first 4,096 characters, then cuts.
    const instructions = client.getInstructions() ?? '';
    assert.equal(instructions, INSTRUCTIONS);
    assert.ok(instructions.length <= MAX_INSTRUCTIONS, `${instructions.length} characters`);
    assert.ok(MAX_INSTRUCTIONS <= 3800);
    assert.ok(instructions.startsWith('Your role: chief of staff\n'), instructions.slice(0, 80));
    const role = instructions.slice(0, instructions.indexOf('\n\n'));
    assert.ok(role.length <= 1200, `the role is ${role.length} characters`);
    for (const said of [
      /Your main session stays on the board: it listens, answers people, reviews, merges and keeps the whole picture\./,
      /Hand each ready task to a background subagent: claim_task, then give it the brief from brief_task\. Don't build it in the main session\./,
      /When idle, listen: call wait_for_updates/,
      /Keep subagents off each other's files: a worktree or branch each\./,
      /Merge it, then send it for review with something to look at\./,
      /Commit only when a person asks\./,
      /Can't run subagents\? Do the tasks yourself, one at a time, checking the board between them\./,
    ]) {
      assert.match(role, said);
    }
    const brief = (await client.listTools()).tools.find((t) => t.name === 'brief_task')!;
    assert.match(brief.description ?? '', /claim_task, then hand this brief to a background subagent/);
    assert.equal(brief.annotations?.readOnlyHint, true);
    const claim = (await client.listTools()).tools.find((t) => t.name === 'claim_task')!;
    assert.match(claim.description ?? '', /hand it to a background subagent with the brief from brief_task/);
  });

  it('runs the full human/agent loop', async () => {
    const created = await callText('create_board', { title: 'Retry logic', goal: 'Resilient API calls' });
    const boardId = created.match(/\[id: ([^\]]+)\]/)![1];

    const posted = await callText('post_decision', {
      board_id: boardId,
      question: 'Which retry strategy?',
      context: 'Affects all 60 call sites.',
      options: [{ label: 'Options object' }, { label: 'Wrapper function' }, { label: 'Client policy' }],
      recommend: 'a',
      recommendation_reason: 'Covers every call site mechanically',
      blocking: true,
    });
    const decisionId = posted.match(/\[id: ([^\]]+)\]/)![1];

    const board = await callText('get_board', { board_id: boardId });
    assert.match(board, /## Open: waiting on people \(1\)/);
    assert.match(board, /a\) Options object ★/);
    const cursor = Number(board.match(/Cursor: (\d+)/)![1]);

    // The agent blocks; a human answers through the web API meanwhile.
    const waiting = callText('wait_for_updates', { board_id: boardId, since: cursor, timeout_seconds: 10 });
    await new Promise((r) => setTimeout(r, 100));
    const explore = await post(`/decisions/${decisionId}/explore`, { actor: 'Wassim', note: 'Prototype a and b' });
    assert.equal(explore.status, 200);

    const updates = await waiting;
    assert.match(updates, /Wassim \(human\) asked for exploration of #1 "Which retry strategy\?": "Prototype a and b"/);

    await callText('attach_finding', {
      decision_id: decisionId,
      option: 'a',
      summary: 'All call sites covered; 8 need judgement.',
      metrics: { 'call sites covered': 60, 'silent behaviour changes': 0 },
      links: ['branch: explore/retry-a'],
    });
    await callText('attach_finding', {
      decision_id: decisionId,
      option: 'b',
      summary: '16 call sites change behaviour silently.',
      metrics: { 'call sites covered': 60, 'silent behaviour changes': 16 },
    });

    const resolved = await post(`/decisions/${decisionId}/resolve`, { actor: 'Wassim', optionId: 'a', rationale: 'No silent changes' });
    assert.equal(resolved.json.status, 'decided');

    const detail = await callText('get_decision', { decision_id: decisionId });
    assert.match(detail, /## Resolution \(decided\)\na\) Options object — by Wassim \(human\)/);
    assert.match(detail, /Planner \(agent\) \[option b\]: 16 call sites/);

    // Agent-made calls land as provisional for the human to confirm.
    await callText('log_decision', {
      board_id: boardId,
      question: 'Max retry attempts?',
      choice: '3 attempts',
      rationale: 'Matches the existing client default',
      alternatives: ['5 attempts'],
    });
    const after = await callText('get_board', { board_id: boardId });
    assert.match(after, /## Provisional.*\n- #2 \[id: \w+\] Max retry attempts\? → a\) 3 attempts — by Planner \(agent\)/);
    assert.match(after, /## Decided: binding \(1\)/);
  });

  it('shares context through canvases in both directions', async () => {
    const boardId = (await callText('create_board', { title: 'Canvas' })).match(/\[id: ([^\]]+)\]/)![1];
    const decisionId = (
      await callText('post_decision', {
        board_id: boardId,
        question: 'Which strategy?',
        options: [{ label: 'Options object' }, { label: 'Wrapper' }],
      })
    ).match(/\[id: ([^\]]+)\]/)![1];
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];

    // Shared context in the board context (the board's own canvas).
    const steps = idOf(
      await callText('add_block', { board_id: boardId, type: 'checklist', title: 'Rollout', items: ['Audit call sites', 'Ship'] }),
    );
    await callText('add_block', { board_id: boardId, type: 'diagram', title: 'Retry flow', source: 'flowchart LR\n  call --> retry' });

    // Evidence on the decision canvas: grouped, pinned to an option, linked.
    const group = idOf(await callText('add_group', { decision_id: decisionId, title: 'Option b evidence' }));
    const table = idOf(
      await callText('add_block', {
        decision_id: decisionId,
        type: 'table',
        title: 'Call-site audit',
        columns: ['module', 'changes behaviour'],
        rows: [['payments', 'yes'], ['search', 'no']],
        group_id: group,
        option: 'b',
      }),
    );
    const imagePath = path.join(dir, 'shot.png');
    writeFileSync(imagePath, Buffer.from(PNG_BASE64, 'base64'));
    const shot = idOf(await callText('add_block', { decision_id: decisionId, type: 'image', image_path: imagePath, caption: 'Prototype' }));
    await callText('link', { from_block_id: shot, to_block_id: table, label: 'explains' });

    const canvas = await call('get_canvas', { decision_id: decisionId });
    const digest = canvas.content[0].text;
    assert.match(digest, /## Group "Option b evidence"/);
    assert.match(digest, /table "Call-site audit" \[id: \w+\] · rev 1 · pinned to b\) Wrapper/);
    assert.match(digest, /\| payments \| yes \|/);
    assert.match(digest, /image "Prototype" → table "Call-site audit": "explains"/);
    const image = canvas.content.find((c) => c.type === 'image');
    assert.equal(image?.mimeType, 'image/png');
    assert.equal(image?.data, PNG_BASE64);

    // A human ticks a task, which rewrites its line; the agent sees exactly what changed.
    const board = await (await fetch(`${base}/api/boards/${boardId}`)).json();
    const cursor = board.seq;
    const list = board.canvas.blocks.find((b: { id: string }) => b.id === steps);
    assert.equal(list.type, 'note', 'a checklist asked for is a note');
    assert.equal(list.text, '- [ ] Audit call sites\n- [ ] Ship');
    const patch = await post(`/canvas/blocks/${steps}`, { actor: 'Sam', text: '- [x] Audit call sites\n- [ ] Ship', rev: list.rev });
    assert.equal(patch.status, 200);
    const updates = await callText('get_updates', { board_id: boardId, since: cursor });
    assert.match(updates, /Sam \(human\) updated note "Rollout" in the board context: checked "Audit call sites"/);

    assert.match(await callText('get_board', { board_id: boardId }), /Board context: 2 blocks/);
    const boardCanvas = await callText('get_canvas', { board_id: boardId });
    assert.match(boardCanvas, /^# Board context: Canvas \[board id: /);
    assert.match(boardCanvas, /1\/2 done\n  - \[x\] Audit call sites/);
    assert.match(boardCanvas, /```mermaid\n  flowchart LR/);

    const removed = await callText('remove_item', { id: shot });
    assert.match(removed, /Removed/);
    assert.doesNotMatch(await callText('get_canvas', { decision_id: decisionId }), /explains/);
  });

  it('lets agents and people add links to any canvas, and refuses other schemes', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Links' }));

    const added = await callText('add_block', { board_id: boardId, type: 'link', url: 'https://www.figma.com/file/abc', title: 'Design file' });
    assert.match(added, /^Added link "Design file" \[id: \w+\] \(rev 1\)\./);
    const repo = idOf(await callText('add_block', { board_id: boardId, type: 'link', url: 'https://github.com/o/r' }));
    const missing = await call('add_block', { board_id: boardId, type: 'link', title: 'No address' });
    assert.match(missing.content[0].text, /A link block needs url\./);
    const script = await call('add_block', { board_id: boardId, type: 'link', url: 'javascript:alert(1)' });
    assert.equal(script.isError, true);
    assert.match(script.content[0].text, /A link must be an http or https address/);

    // Agents read them on one line each, and in the activity.
    const canvas = await callText('get_canvas', { board_id: boardId });
    assert.match(canvas, /\n- link "Design file" \(Figma\) → https:\/\/www\.figma\.com\/file\/abc \[id: \w+\] · rev 1 · by Planner \(agent\)\n/);
    assert.match(canvas, /\n- link "github\.com\/o\/r" \(GitHub repository\) → https:\/\/github\.com\/o\/r \[id: \w+\]/);
    assert.match(await callText('get_block', { block_id: repo }), /^link "github\.com\/o\/r" \[id: \w+\] · rev 1\n\(GitHub repository\) → https:\/\/github\.com\/o\/r$/);
    const cursor = (await (await fetch(`${base}/api/boards/${boardId}`)).json()).seq;
    assert.match(await callText('update_block', { block_id: repo, rev: 1, title: 'Repo' }), /Updated link "Repo"/);

    // People add and edit them over REST, on task canvases too.
    const taskId = idOf(await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Ship links' }] }));
    const onTask = await post('/canvas/blocks', { actor: 'Sam', taskId, title: 'Spec', content: { type: 'link', url: 'https://docs.example.com/spec' } });
    assert.equal(onTask.status, 201);
    assert.match(await callText('get_canvas', { task_id: taskId }), /- link "Spec" → https:\/\/docs\.example\.com\/spec/);
    const moved = await post(`/canvas/blocks/${repo}`, { actor: 'Sam', url: 'https://github.com/o/r2', rev: 2 });
    assert.equal(moved.status, 200);
    const refused = await post('/canvas/blocks', { actor: 'Sam', boardId, content: { type: 'link', url: 'data:text/html,hi' } });
    assert.equal(refused.status, 400);
    const updates = await callText('get_updates', { board_id: boardId, since: cursor });
    assert.match(updates, /Sam \(human\) added link "Spec" on the canvas of T1/);
    assert.match(updates, /Sam \(human\) updated link "Repo" in the board context: changed the address to https:\/\/github\.com\/o\/r2/);

    // Inline on a decision, pinned to an option; a bad address posts nothing.
    const question = { board_id: boardId, question: 'Which layout?', options: [{ label: 'Sidebar' }, { label: 'Tabs' }] };
    const posted = await callText('post_decision', {
      ...question,
      blocks: [{ type: 'link', url: 'https://figma.com/file/sidebar', title: 'Sidebar mock', option: 'a' }],
    });
    assert.match(
      await callText('get_canvas', { decision_id: idOf(posted) }),
      /- link "Sidebar mock" \(Figma\) → https:\/\/figma\.com\/file\/sidebar \[id: \w+\] · rev 1 · pinned to a\) Sidebar/,
    );
    const bad = await call('post_decision', { ...question, question: 'Which font?', blocks: [{ type: 'link', url: 'mailto:sam@example.com' }] });
    assert.match(bad.content[0].text, /^Block 1 in blocks: A link must be an http or https address.* Nothing was posted\./);
  });

  it('protects human decisions and edits from agents working on stale reads', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Integrity' }));
    const decisionId = idOf(
      await callText('post_decision', {
        board_id: boardId,
        question: 'Which queue?',
        options: [{ label: 'SQS' }, { label: 'Kafka' }],
        recommend: 'a',
      }),
    );
    await post(`/decisions/${decisionId}/resolve`, { actor: 'Sam', optionId: 'b', rationale: 'We already run Kafka' });

    const reword = await call('update_decision', { decision_id: decisionId, question: 'Which queue, really?' });
    assert.equal(reword.isError, true);
    assert.match(reword.content[0].text, /Sam decided #1 "Which queue\?", so agents can't reword it/);
    const answer = await call('log_decision', { decision_id: decisionId, choice: 'a', rationale: 'cheaper' });
    assert.equal(answer.isError, true);
    assert.ok(await callText('update_decision', { decision_id: decisionId, blocking: true }), 'planning metadata stays editable');

    // A human edits a block after the agent read it; the agent's stale write is refused.
    const table = idOf(
      await callText('add_block', { decision_id: decisionId, type: 'table', title: 'Costs', columns: ['item', 'cost'], rows: [['brokers', '3']] }),
    );
    const human = await post(`/canvas/blocks/${table}`, { actor: 'Sam', rev: 1, rows: [['brokers', '5']] });
    assert.equal(human.status, 200);
    const stale = await call('update_block', { block_id: table, rev: 1, rows: [['brokers', '4']] });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /changed since rev 1: it is now rev 2, last edited by Sam \(human\)/);
    assert.match(stale.content[0].text, /Current content \(rev 2\):\n\| item \| cost \|\n\| --- \| --- \|\n\| brokers \| 5 \|/);
    assert.match(await callText('update_block', { block_id: table, rev: 2, rows: [['brokers', '5'], ['storage', '2']] }), /now rev 3/);

    const restStale = await post(`/canvas/blocks/${table}`, { actor: 'Sam', rev: 2, title: 'x' });
    assert.equal(restStale.status, 409);
  });

  it('advises on walls of text without rejecting them', async () => {
    const boardId = (await callText('create_board', { title: 'Advice' })).match(/\[id: ([^\]]+)\]/)![1];
    const posted = await callText('post_decision', {
      board_id: boardId,
      question: 'How should we cache?',
      context: 'word '.repeat(300),
      options: [{ label: 'Redis' }, { label: 'In-process' }],
    });
    assert.match(posted, /^Posted #1/);
    assert.match(posted, /Advice \(nothing was rejected\):\n- The context is 300 words \(about 75 seconds to read\)/);
    assert.match(posted, /Add a recommendation with a reason/);
  });

  it('routes questions to people and leaves the judging to them', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'People' }));
    const seed = idOf(await callText('post_decision', { board_id: boardId, question: 'Warm-up?', options: [{ label: 'x' }, { label: 'y' }], recommend: 'a' }));
    await post(`/decisions/${seed}/comments`, { actor: 'Alex', body: 'hi' }); // Alex is now known on the board

    const posted = await callText('post_decision', {
      board_id: boardId,
      question: 'Retry strategy?',
      options: [{ label: 'Options object' }, { label: 'Wrapper' }],
      recommend: 'a',
      criteria: [{ label: 'No silent behaviour change' }, { label: 'Small diff' }],
      ask: ['alex', 'Jordna'],
      ask_note: 'You own the payments client',
    });
    const decisionId = idOf(posted);
    assert.match(posted, /"Jordna" has not acted on this board yet\. People here: Alex\./);
    assert.match(await callText('get_board', { board_id: boardId }), /People: Alex .*\n[\s\S]*Retry strategy\? \(waiting for alex and Jordna\)/);

    const cursor = Number((await callText('get_board', { board_id: boardId })).match(/Cursor: (\d+)/)![1]);
    const marked = await post(`/decisions/${decisionId}/marks`, { actor: 'Alex', criterionId: 'c1', optionId: 'b', value: 'no' });
    assert.equal(marked.status, 200);
    await post(`/decisions/${decisionId}/marks`, { actor: 'Alex', criterionId: 'c1', optionId: 'a', value: 'yes' });
    const updates = await callText('get_updates', { board_id: boardId, since: cursor });
    assert.match(updates, /Alex \(human\) marked b\) Wrapper "no" on "No silent behaviour change" for #2 "Retry strategy\?" \(answering an ask from Planner\)/);

    const detail = await callText('get_decision', { decision_id: decisionId });
    assert.match(detail, /- alex, by Planner \(agent\) at \S+: "You own the payments client" \(answered at /);
    assert.match(detail, /- Jordna, by Planner \(agent\) .*\(waiting\)/);
    assert.match(detail, /\| No silent behaviour change \[c1\] \| yes \(Alex\) \| no \(Alex\) \|\n\| Small diff \[c2\] \| · \| · \|/);

    assert.match(await callText('propose_criteria', { decision_id: decisionId, criteria: [{ label: 'Opt-out per call' }] }), /3 criteria/);
    const nudge = await callText('ask_people', { decision_id: decisionId, people: ['Alex'], note: 'and c3?' });
    assert.match(nudge, /waiting for Alex/);
    assert.doesNotMatch(nudge, /Advice/);
  });

  it('nudges, without refusing, text that people will read as a log', async () => {
    const idOf = (text: string) => text.match(/\[(?:thread )?id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Tone' }));
    const decisionId = idOf(await callText('post_decision', { board_id: boardId, question: 'Which tone?', options: [{ label: 'Warm' }, { label: 'Plain' }], recommend: 'a' }));
    await post(`/decisions/${decisionId}/resolve`, { actor: 'Sam', optionId: 'a' });
    const taskId = idOf(await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Write kindly', decision_ids: [decisionId] }] }));

    const plain = await callText('comment', { task_id: taskId, body: 'Sam, the new wording is on the canvas for you to look at.' });
    assert.doesNotMatch(plain, /Advice/);
    const logged = await callText('comment', { task_id: taskId, body: 'Committed as `3f16e19`. 462/462 tests pass.' });
    assert.match(logged, /^Commented on T1\.\n\nAdvice \(nothing was rejected\):\n- This comment opens with a label \("Committed as …"\)/);
    assert.match(logged, /- This comment quotes a test tally \("462\/462"\)/);
    assert.match(await callText('comment', { decision_id: decisionId, body: 'Built: the new wording [id: abc123].' }), /opens with a label[\s\S]*shows a raw id/);

    await callText('claim_task', { task_id: taskId });
    const note = await callText('update_task', { task_id: taskId, note: 'Done: wording changed. 12/12 tests pass.' });
    assert.match(note, /^T1 is in progress\.\n\nAdvice/);
    assert.match(note, /This note opens with a label \("Done:"\)/);
    assert.doesNotMatch(await callText('update_task', { task_id: taskId, note: 'Sam, I changed the wording and it reads better now.' }), /Advice/);

    const started = await callText('start_thread', { board_id: boardId, body: 'Built: a first draft of the wording.' });
    assert.match(started, /This message opens with a label/);
    const threadId = idOf(started);
    assert.match(await callText('reply_in_thread', { thread_id: threadId, body: 'Great question! 20/20 tests pass.' }), /This reply opens with praise[\s\S]*This reply quotes a test tally/);
    assert.doesNotMatch(await callText('reply_in_thread', { thread_id: threadId, body: 'Sam, the draft is ready for you.' }), /Advice/);
  });

  it('turns decisions into tasks and stops work when a decision changes', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Tasks' }));
    const decisionId = idOf(await callText('post_decision', { board_id: boardId, question: 'Strategy?', options: [{ label: 'Options object' }, { label: 'Wrapper' }], recommend: 'a' }));

    const early = await call('plan_tasks', { board_id: boardId, tasks: [{ title: 'Too early', decision_ids: [decisionId] }] });
    assert.equal(early.isError, true);
    await post(`/decisions/${decisionId}/resolve`, { actor: 'Sam', optionId: 'a' });

    const planned = await callText('plan_tasks', {
      board_id: boardId,
      tasks: [{ title: 'Add retry option', decision_ids: [decisionId] }, { title: 'Migrate call sites', decision_ids: [decisionId] }],
    });
    const [t1, t2] = [...planned.matchAll(/\[id: ([^\]]+)\]/g)].map((m) => m[1]);
    assert.match(await callText('claim_task', { task_id: t1 }), /Claimed T1/);
    await callText('add_block', { task_id: t1, type: 'checklist', title: 'Done', items: [{ text: 'Retry option added', done: true }] });
    await callText('update_task', { task_id: t1, status: 'in_review', link: 'https://example.test/pr/1' });

    const cursor = Number((await callText('get_board', { board_id: boardId })).match(/Cursor: (\d+)/)![1]);
    await post(`/decisions/${decisionId}/reopen`, { actor: 'Sam' });
    assert.match(await callText('get_updates', { board_id: boardId, since: cursor }), /Sam \(human\) marked T1 and T2 stale: #1 "Strategy\?" was reopened by Sam/);

    const refused = await call('update_task', { task_id: t1, status: 'done' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /is stale: #1 was reopened by Sam\. Re-read the decision/);
    assert.match(await callText('update_task', { task_id: t1, still_valid: true, status: 'done' }), /T1 is done/);

    // People move tasks and clear stale flags over REST.
    const cleared = await post(`/tasks/${t2}`, { actor: 'Sam', stillValid: true, status: 'blocked', note: 'Needs #1 again' });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.stale, undefined);
    const human = await post(`/boards/${boardId}/tasks`, { actor: 'Sam', title: 'Write docs', decisionIds: [decisionId] });
    assert.equal(human.status, 400, '#1 is open again, so no new tasks');
  });

  it("keeps tasks people add in the backlog, out of agents' reach until marked ready", async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Backlog' }));
    const added = await post(`/boards/${boardId}/tasks`, { actor: 'Sam', title: 'Login times out' });
    assert.equal(added.status, 201);
    assert.equal(added.json.status, 'backlog');
    const planned = idOf(await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Add retry option' }] }));
    assert.match(await callText('get_task', { task_id: planned }), /Status: to do/);

    const refused = await call('claim_task', { task_id: added.json.id });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /T1 "Login times out" is in the backlog: a person is still shaping it/);
    assert.match(await callText('get_board', { board_id: boardId }), /backlog, not ready \(1\):\n- T1 /);
    assert.match(await callText('comment', { task_id: added.json.id, body: 'Seen it too' }), /Commented on T1/);
    assert.equal((await call('update_task', { task_id: added.json.id, status: 'todo' })).isError, true);

    const ready = await post(`/tasks/${added.json.id}`, { actor: 'Sam', status: 'todo' });
    assert.equal(ready.json.status, 'todo');
    assert.match(await callText('get_updates', { board_id: boardId, since: 0 }), /Sam \(human\) updated T1 "Login times out": marked it ready/);
    assert.match(await callText('claim_task', { task_id: added.json.id }), /Claimed T1/);
  });

  it('accepts only real images over REST and serves them inertly', async () => {
    const upload = (body: Buffer, type: string) =>
      fetch(`${base}/api/assets`, { method: 'POST', headers: { 'Content-Type': type }, body: new Uint8Array(body) });
    const bad = await upload(Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml');
    assert.equal(bad.status, 400);

    const good = await upload(Buffer.from(PNG_BASE64, 'base64'), 'image/png');
    assert.equal(good.status, 201);
    const { assetId, width, height } = await good.json();
    assert.deepEqual([width, height], [1, 1], 'with its size, for a new block to start at');
    const served = await fetch(`${base}/api/assets/${assetId}`);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.match(served.headers.get('cache-control') ?? '', /immutable/);

    // A file that exists but can't be sent must not be cached as if it were
    // the image (browsers would keep showing the error for a year).
    chmodSync(path.join(dir, 'assets', assetId), 0o000);
    const failed = await fetch(`${base}/api/assets/${assetId}`);
    assert.notEqual(failed.status, 200);
    assert.doesNotMatch(failed.headers.get('cache-control') ?? '', /immutable/);
  });

  it('tells agents about unread activity and shows people who is here', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Presence' }));
    const decisionId = idOf(await callText('post_decision', { board_id: boardId, question: 'Q?', options: [{ label: 'x' }, { label: 'y' }], recommend: 'a' }));

    const board = await (await fetch(`${base}/api/boards/${boardId}`)).json();
    assert.deepEqual(board.presence.map((a: { name: string; state: string }) => [a.name, a.state]), [['Planner', 'working']]);

    // A person comments while the agent is busy elsewhere on the board.
    await post(`/decisions/${decisionId}/comments`, { actor: 'Sam', body: 'What about z?' });
    const result = await call('get_decision', { decision_id: decisionId });
    assert.match(result.content.at(-1)!.text, /^Unread on this board: 1 update from others since you last checked \(latest: Sam commented on #1 "Q\?": "What about z\?"\)\. Call get_updates with since: \d+\.$/);
    await callText('get_updates', { board_id: boardId, since: 0 });
    const after = await call('get_decision', { decision_id: decisionId });
    assert.equal(after.content.length, 1, 'caught up, so no notice');

    // While the agent waits, people see it listening.
    const waiting = callText('wait_for_updates', { board_id: boardId, since: 999, timeout_seconds: 2 });
    await new Promise((r) => setTimeout(r, 200));
    const during = await (await fetch(`${base}/api/boards/${boardId}`)).json();
    assert.equal(during.presence[0].state, 'listening');
    await waiting;
  });

  it('shows people which card an agent is taking a look at', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Taking a look' }));
    const planned = await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'One' }, { title: 'Two' }] });
    const [first, second] = [...planned.matchAll(/\[id: ([^\]]+)\]/g)].map((m) => m[1]);
    const decisionId = idOf(await callText('post_decision', { board_id: boardId, question: 'Q?', options: [{ label: 'x' }] }));
    const focus = async () => {
      const board = await (await fetch(`${base}/api/boards/${boardId}`)).json();
      return board.presence.map((a: { name: string; focus?: unknown }) => [a.name, a.focus]);
    };
    assert.deepEqual(await focus(), [['Planner', undefined]], 'planning and posting are about the board');

    await callText('get_task', { task_id: first });
    assert.deepEqual(await focus(), [['Planner', { kind: 'task', id: first }]]);
    const note = idOf(await callText('add_block', { task_id: second, type: 'note', text: 'What I found' }));
    assert.deepEqual(await focus(), [['Planner', { kind: 'task', id: second }]], 'one card at a time');

    await callText('get_board', { board_id: boardId });
    await callText('get_updates', { board_id: boardId, since: 0 });
    await callText('get_canvas', { board_id: boardId });
    assert.deepEqual(await focus(), [['Planner', { kind: 'task', id: second }]], 'the board and its context leave it be');

    await callText('get_decision', { decision_id: decisionId });
    assert.deepEqual(await focus(), [['Planner', { kind: 'decision', id: decisionId }]]);
    await callText('update_block', { block_id: note, rev: 1, title: 'Findings' });
    assert.deepEqual(await focus(), [['Planner', { kind: 'task', id: second }]], "a block leads to the card it's on");
  });

  it('keeps a renamed board reachable by its old id, with read cursors and presence intact', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const old = idOf(await callText('create_board', { title: 'Planning roadmap' }));
    const decisionId = idOf(await callText('post_decision', { board_id: old, question: 'Name?', options: [{ label: 'Tricot' }] }));

    const renamed = await post(`/boards/${old}`, { actor: 'Sam', title: 'Tricot roadmap' });
    assert.equal(renamed.status, 200);
    const id = renamed.json.id as string;
    assert.match(id, /^tricot-roadmap-[a-z2-9]{4}$/);

    // Old links still open the board, which says where it lives now.
    const board = await (await fetch(`${base}/api/boards/${old}`)).json();
    assert.equal(board.id, id);
    assert.equal(board.title, 'Tricot roadmap');
    assert.deepEqual(board.presence.map((a: { name: string }) => a.name), ['Planner'], 'presence followed the board');

    // The agent hears about the rename on its next call, and its old id still works.
    const result = await call('get_decision', { decision_id: decisionId });
    assert.match(result.content.at(-1)!.text, /^Unread on this board: 1 update .*Sam renamed the board to "Tricot roadmap"/);
    assert.match(await callText('get_board', { board_id: old }), new RegExp(`^# Tricot roadmap \\[id: ${id}\\][\\s\\S]*renamed: its id is now ${id}\\. The old one still works\\.\\n\\nTell Tricot your skills[^\\n]*$`));
    assert.match(await callText('post_decision', { board_id: old, question: 'Still here?' }), /Posted #2/);
    assert.match(await callText('get_updates', { board_id: id, since: 0 }), /Sam \(human\) renamed the board to "Tricot roadmap"/);
    assert.match(await callText('get_canvas', { board_id: old }), new RegExp(`board id: ${id}`));

    // People rename; agents only suggest.
    assert.equal((await post(`/boards/${old}`, { actor: 'Sam', title: '' })).status, 400);
    const { tools } = await client.listTools();
    assert.ok(!tools.some((t) => /rename|update_board/.test(t.name)));
  });

  it('archives a board: agents read it but cannot change it, and list_boards sets it apart', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Old experiment', goal: 'Done with it' }));
    const archived = await post(`/boards/${boardId}/archive`, { actor: 'Sam' });
    assert.equal(archived.status, 200);
    assert.equal(archived.json.archived.by.name, 'Sam');

    assert.match(await callText('get_board', { board_id: boardId }), /Archived by Sam \(human\) at \S+: read-only\./);
    const refused = await call('post_decision', { board_id: boardId, question: 'One more?' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /The board "Old experiment" was archived by Sam, so it is read-only/);
    assert.match(await callText('list_boards'), /\n\nArchived \(read-only\):\n- Old experiment \[id: [^\]]+\] — Done with it/);

    const human = await post(`/boards/${boardId}/decisions`, { actor: 'Sam', question: 'One more?' });
    assert.equal(human.status, 400);
    assert.match(human.json.error, /read-only/);
    const listed = await (await fetch(`${base}/api/boards`)).json();
    assert.equal(listed.find((b: { id: string }) => b.id === boardId).archived, true);

    assert.equal((await post(`/boards/${boardId}/unarchive`, { actor: 'Sam' })).status, 200);
    assert.match(await callText('post_decision', { board_id: boardId, question: 'One more?' }), /Posted #1/);
    const events = (await (await fetch(`${base}/api/boards/${boardId}/events?since=0&limit=500`)).json()).events.map((e: { summary: string }) => e.summary);
    assert.deepEqual(events.slice(1, 3), ['archived the board', 'unarchived the board']);
  });

  it('posts a decision with its visuals in one call, and reminds when there are none', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Visuals' }));
    const shot = path.join(dir, 'layout-a.png');
    writeFileSync(shot, Buffer.from(PNG_BASE64, 'base64'));
    const question = {
      board_id: boardId,
      question: 'Which layout?',
      options: [{ label: 'Sidebar' }, { label: 'Tabs' }],
      recommend: 'a',
    };

    const posted = await callText('post_decision', {
      ...question,
      blocks: [
        { type: 'table', title: 'Side by side', columns: ['', 'Sidebar', 'Tabs'], rows: [['Clicks to switch', '1', '2']] },
        { type: 'image', image_path: shot, caption: 'Sidebar prototype', option: 'a', group: 'Sidebar evidence' },
        { type: 'note', title: 'Why', text: 'Always visible', option: 'a', group: 'Sidebar evidence' },
        { type: 'diagram', source: 'flowchart LR\n  list --> tab', option: 'b' },
      ],
    });
    assert.match(posted, /^Posted #1 \[id: \w+\] \(status: open\) with 4 blocks on its canvas\./);
    assert.doesNotMatch(posted, /canvas is empty/);
    const decisionId = idOf(posted);
    const canvas = await call('get_canvas', { decision_id: decisionId });
    const digest = canvas.content[0].text;
    assert.match(digest, /table "Side by side" \[id: \w+\] · rev 1 · by Planner \(agent\)\n/);
    assert.match(digest, /## Group "Sidebar evidence" \[id: \w+\]\n- image "Sidebar prototype" \[id: \w+\] · rev 1 · pinned to a\) Sidebar[\s\S]*- note "Why" .* · pinned to a\) Sidebar/);
    assert.match(digest, /diagram .* · pinned to b\) Tabs/);
    assert.equal(canvas.content.find((c) => c.type === 'image')?.data, PNG_BASE64);
    const events = (await (await fetch(`${base}/api/boards/${boardId}/events?since=0&limit=500`)).json()).events.map((e: { summary: string }) => e.summary);
    assert.deepEqual(events.slice(1, 3), ['asked #1 "Which layout?"', 'added table "Side by side" on the canvas of #1 "Which layout?"']);
    assert.match(events[4], /added image "Sidebar prototype" on the canvas of #1 "Which layout\?" in group "Sidebar evidence" for option a/);

    // Nothing to look at: the post goes through, with a reminder.
    const bare = await callText('post_decision', { ...question, question: 'Which font?' });
    assert.match(bare, /\n- Its canvas is empty\. Put what the person needs to see to decide on it: the options side by side/);

    // A bad block, wherever it is, posts nothing.
    const missing = await call('post_decision', {
      ...question,
      question: 'Which icon set?',
      blocks: [{ type: 'note', text: 'fine' }, { type: 'image', image_path: path.join(dir, 'nope.png'), option: 'b' }],
    });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Block 2 in blocks: Cannot read ".*nope\.png" \(ENOENT\)\. Nothing was posted\./);
    const badPin = await call('post_decision', { ...question, question: 'Which icon set?', blocks: [{ type: 'note', text: 'x', option: 'z' }] });
    assert.match(badPin.content[0].text, /Block 1 in blocks: .*has no option "z"\. Nothing was posted\./);
    const board = await callText('get_board', { board_id: boardId });
    assert.doesNotMatch(board, /icon set/);
    assert.match(await callText('post_decision', { ...question, question: 'Which icon set?' }), /^Posted #3/);
  });

  it("refuses an agent's review until the task's canvas shows the work, but not a person's", async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Review' }));
    const planned = await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Fix login' }, { title: 'Bump deps' }] });
    const [taskId, other] = [...planned.matchAll(/\[id: ([^\]]+)\]/g)].map((m) => m[1]);
    await callText('claim_task', { task_id: taskId });

    const refused = await call('update_task', { task_id: taskId, status: 'in_review', link: 'https://example.test/pr/2' });
    assert.equal(refused.isError, true);
    assert.equal(
      refused.content[0].text,
      `T1 "Fix login" has nothing on its canvas to review. Add what shows the work to T1's canvas first (add_block with task_id: ${taskId}): a screenshot of the result, a checklist of what's done, or a note or diagram for work that isn't visual.`,
    );
    await callText('add_block', { task_id: taskId, type: 'checklist', title: 'Done', items: [{ text: 'Session cookie renewed', done: true }] });
    assert.match(await callText('update_task', { task_id: taskId, status: 'in_review', link: 'https://example.test/pr/2' }), /T1 is in review/);

    const human = await post(`/tasks/${other}`, { actor: 'Sam', status: 'in_review' });
    assert.equal(human.status, 200);
    assert.equal(human.json.status, 'in_review');
  });

  it('makes the commit part of the review: people approve it over REST, agents see it and report the hash', async () => {
    const update = (await client.listTools()).tools.find((t) => t.name === 'update_task')!;
    assert.match(update.description ?? '', /Don't post a "Commit …\?" card for a task's own work: people approve its commit with "Looks good, commit it"/);
    assert.match(update.description ?? '', /Then commit that task's work alone, from your main session, and pass the hash as commit/);
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Commits' }));
    const planned = await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Fix login' }, { title: 'Bump deps' }] });
    const [taskId, other] = [...planned.matchAll(/\[id: ([^\]]+)\]/g)].map((m) => m[1]);
    await callText('claim_task', { task_id: taskId });
    await callText('add_block', { task_id: taskId, type: 'checklist', title: 'Done', items: [{ text: 'Session cookie renewed', done: true }] });
    await callText('update_task', { task_id: taskId, status: 'in_review', link: 'https://example.test/pr/3' });
    const cursor = Number((await callText('get_board', { board_id: boardId })).match(/Cursor: (\d+)/)![1]);

    const early = await call('update_task', { task_id: taskId, commit: 'abc1234' });
    assert.equal(early.isError, true);
    assert.match(early.content[0].text, /^Nobody approved a commit of T1 "Fix login", so there's no hash to record\./);

    const notDone = await post(`/tasks/${other}`, { actor: 'Wassim', approveCommit: true });
    assert.deepEqual([notDone.status, notDone.json.error], [400, 'A commit is approved along with the work: pass status done.']);
    const approved = await post(`/tasks/${taskId}`, { actor: 'Wassim', status: 'done', approveCommit: true });
    assert.equal(approved.status, 200);
    assert.equal(approved.json.status, 'done');
    assert.deepEqual(approved.json.commit.approvedBy, { kind: 'human', name: 'Wassim' });

    const ask = `Wassim approved T1 [id: ${taskId}] and asked you to commit it. Commit that task's work alone, from your main session, then report the hash with update_task (commit); if there is nothing to commit, say why with update_task (nothing_to_commit).`;
    const updates = await callText('get_updates', { board_id: boardId, since: cursor });
    assert.match(updates, /Wassim \(human\) updated T1 "Fix login": approved it and asked for a commit/);
    assert.ok(updates.endsWith(`\n${ask}`), updates);
    assert.ok((await callText('wait_for_updates', { board_id: boardId, since: cursor, timeout_seconds: 1 })).includes(`\n${ask}`));
    assert.match(await callText('get_task', { task_id: taskId }), /\n\nWassim approved T1 and asked you to commit it\. Commit that task's work alone, from your main session, then report the hash with update_task \(commit\); if there is nothing to commit, say why with update_task \(nothing_to_commit\)\./);

    assert.equal(await callText('update_task', { task_id: taskId, commit: 'abc1234def' }), 'T1 is done, and its commit abc1234 is recorded.');
    assert.doesNotMatch(await callText('get_updates', { board_id: boardId, since: cursor }), /asked you to commit it/);
    assert.match(await callText('get_task', { task_id: taskId }), /\n\nCommitted as abc1234def; Wassim approved the commit\./);
    assert.equal((await post(`/tasks/${taskId}/comments`, { actor: 'Wassim', body: 'Thanks' })).json.commit.hash, 'abc1234def', 'people get the hash too');
  });

  it('lets an agent say there is nothing to commit: with the review, or answering an approved commit', async () => {
    const update = (await client.listTools()).tools.find((t) => t.name === 'update_task')!;
    assert.match(update.description ?? '', /send it for review with nothing_to_commit: why, and people are offered only "Looks good"/);
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'No commit' }));
    const planned = await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Plan the cut-over' }, { title: 'Spike the importer' }] });
    const [plan, spike] = [...planned.matchAll(/\[id: ([^\]]+)\]/g)].map((m) => m[1]);
    for (const id of [plan, spike]) {
      await callText('claim_task', { task_id: id });
      await callText('add_block', { task_id: id, type: 'checklist', title: 'Done', items: [{ text: 'Written up', done: true }] });
    }

    // With the review: only "Looks good" is on offer, so a commit approval is refused.
    assert.equal(await callText('update_task', { task_id: plan, status: 'in_review', nothing_to_commit: 'a plan; the doc is on the canvas' }), 'T1 is in review, and it has nothing to commit.');
    assert.match(await callText('get_task', { task_id: plan }), /\n\nNothing to commit: a plan; the doc is on the canvas\./);
    const asked = await post(`/tasks/${plan}`, { actor: 'Wassim', status: 'done', approveCommit: true });
    assert.deepEqual([asked.status, asked.json.error], [400, 'T1 "Plan the cut-over" has nothing to commit (a plan; the doc is on the canvas): approve it without a commit.']);
    assert.equal((await post(`/tasks/${plan}`, { actor: 'Wassim', status: 'done' })).json.status, 'done');

    // No commit approved: refused. Approved: the answer clears the reminder.
    await callText('update_task', { task_id: spike, status: 'in_review' });
    assert.equal((await post(`/tasks/${spike}`, { actor: 'Wassim', status: 'done' })).status, 200);
    const refused = await call('update_task', { task_id: spike, nothing_to_commit: 'a spike' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /^Nothing to commit is said when you send T2 "Spike the importer" for review/);
    await post(`/tasks/${spike}`, { actor: 'Wassim', approveCommit: true });
    assert.match(await callText('get_board', { board_id: boardId }), /asked you to commit it/);
    assert.equal(await callText('update_task', { task_id: spike, nothing_to_commit: 'a spike; findings on the canvas' }), 'T2 is done, and it has nothing to commit.');
    assert.doesNotMatch(await callText('get_board', { board_id: boardId }), /asked you to commit it/);
    const done = (await post(`/tasks/${spike}/comments`, { actor: 'Wassim', body: 'Thanks' })).json;
    assert.equal(done.noCommit.reason, 'a spike; findings on the canvas');
    assert.equal(done.commit, undefined);
  });

  it('lets agents work in a task: read it, comment on it, add to its canvas', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Task views' }));
    const taskId = idOf(await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Fix flaky test' }] }));
    await post(`/tasks/${taskId}/comments`, { actor: 'Sam', body: 'It fails on CI only' });
    assert.match(await callText('comment', { task_id: taskId, body: 'Looking at the CI logs' }), /Commented on T1/);
    await callText('add_block', { task_id: taskId, type: 'checklist', title: 'Repro', items: ['Run on CI image'] });
    const detail = await callText('get_task', { task_id: taskId });
    assert.match(detail, /Standalone: implements no decision\./);
    assert.match(detail, /## Discussion\n- Sam \(human\) at \S+ \[comment id: \w+\]: It fails on CI only\n- Planner \(agent\) at \S+ \[comment id: \w+\]: Looking at the CI logs/);
    assert.match(await callText('get_canvas', { task_id: taskId }), /# Canvas of T1 Fix flaky test \[task id: \w+\][\s\S]*\[ \] Run on CI image/);
  });

  it('shows agents the pins people make, and lets them pin work themselves', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Pins' }));
    const note = { type: 'note', text: '- Next: onboarding and the docs site\n- Pricing page for the beta' };
    const where = (await post('/canvas/blocks', { actor: 'Wassim', boardId, title: 'Where we are', content: note })).json.id;

    // A person selects words on the note and creates a task from them.
    const words = { kind: 'text', quote: 'onboarding and the docs site', prefix: 'Next: ', suffix: ' Pricing page' };
    const created = await post(`/canvas/blocks/${where}/pins/task`, { actor: 'Wassim', part: words, text: 'Draft the onboarding checklist' });
    assert.equal(created.status, 201);
    assert.equal(created.json.task.status, 'backlog');
    assert.equal(created.json.pin.taskId, created.json.task.id);
    const taskId = created.json.task.id;
    assert.match(
      await callText('get_canvas', { board_id: boardId }),
      new RegExp(`1 pin \\(parts of blocks[\\s\\S]*\\n  pinned "onboarding and the docs site" → T1 \\(backlog\\) \\[task id: ${taskId}; pin id: \\w+\\]`),
    );
    assert.match(await callText('get_task', { task_id: taskId }), /## Pinned from\n- "onboarding and the docs site" in note "Where we are" \(board context\) \[block id: \w+\], pinned by Wassim \(human\)/);

    // An agent pins work that already exists to the parts about it.
    const pricing = idOf(await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Pricing page' }] }));
    assert.match(
      await callText('pin', { block_id: where, task_id: pricing, text: 'Pricing page for the beta' }),
      /^Pinned "Pricing page for the beta" in note "Where we are" to T2 \[pin id: \w+\]\. People see it there/,
    );
    const table = idOf(
      await callText('add_block', { board_id: boardId, type: 'table', title: 'Retry budgets', columns: ['Service', 'Attempts'], rows: [['Payments', '5'], ['Search', '3']] }),
    );
    await callText('pin', { block_id: table, task_id: pricing, row: 2 });
    const cell = await callText('pin', { block_id: table, task_id: pricing, row: 1, column: 'attempts' });
    assert.match(cell, /^Pinned Payments · Attempts: 5 in table "Retry budgets" to T2/);
    const canvas = await callText('get_canvas', { board_id: boardId });
    assert.match(canvas, /\n  pinned Search row → T2 \(to do\)[^\n]*\n  pinned Payments · Attempts: 5 → T2 \(to do\)/);
    assert.match(await callText('get_block', { block_id: table }), /\n\npinned Search row → T2 \(to do\)/);
    assert.match(await callText('get_task', { task_id: pricing }), /## Pinned from\n- "Pricing page for the beta" in note[^\n]*\n- Search row in table "Retry budgets"/);

    const wrongColumn = await call('pin', { block_id: table, task_id: pricing, column: 'p95' });
    assert.equal(wrongColumn.isError, true);
    assert.match(wrongColumn.content[0].text, /has no column "p95"\. Its columns: "Service", "Attempts"\./);
    const words2 = await call('pin', { block_id: table, task_id: pricing, text: 'Search' });
    assert.match(words2.content[0].text, /Words are pinned in notes; table "Retry budgets" is a table\./);
    const theirs = await call('remove_item', { id: created.json.pin.id });
    assert.match(theirs.content[0].text, /Wassim made that pin, so only a person removes it/);

    // People ask a question about a part over REST, and link existing work.
    const asked = await post(`/canvas/blocks/${table}/pins/question`, { actor: 'Wassim', part: { kind: 'cells', columns: [1, 1] }, text: 'Too high?' });
    assert.equal(asked.status, 201);
    assert.deepEqual([asked.json.decision.question, asked.json.pin.decisionId], ['Too high?', asked.json.decision.id]);
    assert.match(
      await callText('get_decision', { decision_id: asked.json.decision.id }),
      /## Pinned from\n- Attempts column in table "Retry budgets" \(board context\)/,
    );
    const linked = await post(`/canvas/blocks/${where}/pins`, { actor: 'Wassim', part: { kind: 'text', quote: 'docs site' }, taskId });
    assert.equal(linked.status, 201);
    const missing = await post(`/canvas/blocks/${where}/pins/task`, { actor: 'Wassim', part: { kind: 'text', quote: 'refunds' }, text: 'x' });
    assert.deepEqual([missing.status, missing.json.error], [400, `"refunds" isn't in note "Where we are". Quote the words exactly as they read.`]);
    const unpinned = await post(`/canvas/items/${linked.json.id}/delete`, { actor: 'Wassim' });
    assert.equal(unpinned.status, 200);
    assert.match(await callText('get_updates', { board_id: boardId, since: 0 }), /Wassim \(human\) unpinned "docs site" in note "Where we are" \(board context\) from T1/);
  });

  it('lets people comment on pinned parts, and agents read and answer them', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Pin comments' }));

    // On a task's canvas, the comment goes in the task's discussion, quoting the part.
    const taskId = idOf(await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Ship the onboarding flow' }] }));
    const plan = idOf(await callText('add_block', { task_id: taskId, type: 'note', title: 'Plan', text: 'Sign-up with email, then a 3-step tour' }));
    const words = { kind: 'text', quote: 'then a 3-step tour', prefix: 'Sign-up with email, ', suffix: '' };
    const onTask = await post(`/canvas/blocks/${plan}/pins/comment`, { actor: 'Wassim', part: words, body: 'Is 3 steps too long for mobile?' });
    assert.equal(onTask.status, 201);
    assert.deepEqual(onTask.json.comment.pin, { id: onTask.json.pin.id, quote: '“then a 3-step tour”' });
    assert.match(
      await callText('get_task', { task_id: taskId }),
      /## Discussion\n- Wassim \(human\) at \S+ \[comment id: \w+\] on “then a 3-step tour” \[pin id: \w+\]: Is 3 steps too long for mobile\?/,
    );
    // get_task gave this session the comment whole, so its update names it without saying it again.
    assert.match(
      await callText('get_updates', { board_id: boardId, since: 0 }),
      new RegExp(`Wassim \\(human\\) commented on T1 "Ship the onboarding flow" about “then a 3-step tour” \\(you've seen it\\)\\. Reply with comment\\(task_id: ${taskId}\\)\\.\\n\\nCursor`),
    );
    assert.match(await callText('comment', { task_id: taskId, body: 'Each step fits a 390px screen.' }), /^Commented on T1\./);
    assert.match(await callText('get_canvas', { task_id: taskId }), /pinned "then a 3-step tour" → 1 comment in the discussion, quoting it/);

    // On the board context, it starts a thread on the pin.
    const where = (await post('/canvas/blocks', { actor: 'Wassim', boardId, title: 'Where we are', content: { type: 'note', text: 'Next: the docs site' } })).json.id;
    const started = await post(`/canvas/blocks/${where}/pins/comment`, { actor: 'Wassim', part: { kind: 'text', quote: 'docs site', prefix: 'Next: the ', suffix: '' }, body: 'Hosted or our own domain?' });
    assert.equal(started.status, 201);
    const pinId = started.json.pin.id;
    assert.equal(started.json.pin.discussion.thread.length, 1);
    assert.match(await callText('get_board', { board_id: boardId }), /1 comment thread on the board context waits for a reply/);
    const updates = await callText('get_updates', { board_id: boardId, since: 0 });
    assert.match(updates, new RegExp(`Wassim \\(human\\) commented on "docs site" in note "Where we are" \\(board context\\): "Hosted or our own domain\\?" \\[pin id: ${pinId}\\]`));
    assert.match(await callText('get_canvas', { board_id: boardId }), new RegExp(`→ comment thread, open \\[pin id: ${pinId}\\]; reply with comment\\(pin_id\\)\\n    - Wassim \\(human\\)`));

    // The agent replies there, and posts a decision on the same part for the person's call.
    assert.match(await callText('comment', { pin_id: pinId, body: 'Hosted ships this week.' }), /^Replied in the comment thread on "docs site" in note "Where we are", on the board context \(2 comments\)/);
    const decisionId = idOf(await callText('post_decision', { board_id: boardId, question: 'Docs: hosted or our own domain?', options: [{ label: 'Hosted' }, { label: 'Own domain' }] }));
    assert.match(await callText('pin', { pin_id: pinId, decision_id: decisionId }), /^Pinned "docs site" in note "Where we are" to #1 \[pin id: \w+\]/);
    const both = await call('pin', { pin_id: pinId, block_id: where, decision_id: decisionId });
    assert.match(both.content[0].text, /Pass block_id and the part, or pin_id/);
    const withPart = await call('pin', { pin_id: pinId, text: 'docs', decision_id: decisionId });
    assert.match(withPart.content[0].text, /With pin_id, leave out the part/);
    const twice = await call('comment', { pin_id: pinId, task_id: taskId, body: 'x' });
    assert.match(twice.content[0].text, /Pass decision_id, task_id or pin_id \(exactly one\)/);

    // A person replies and resolves it over REST; the agent sees it go quiet.
    const replied = await post(`/canvas/pins/${pinId}/comments`, { actor: 'Wassim', body: 'Hosted it is.' });
    assert.deepEqual([replied.status, replied.json.pin.discussion.thread.length], [200, 3]);
    const resolved = await post(`/canvas/pins/${pinId}/resolve`, { actor: 'Wassim', resolved: true });
    assert.deepEqual([resolved.status, resolved.json.discussion.resolved.by.name], [200, 'Wassim']);
    assert.match(await callText('get_canvas', { board_id: boardId }), /→ comment thread, resolved by Wassim \(human\), 3 comments/);
    assert.match(await callText('get_updates', { board_id: boardId, since: 0 }), /Wassim \(human\) resolved the comment thread on "docs site"/);
    const onCard = await post(`/canvas/pins/${onTask.json.pin.id}/resolve`, { actor: 'Wassim', resolved: true });
    assert.deepEqual([onCard.status, onCard.json.error], [400, '"then a 3-step tour" has no comment thread to resolve.']);
    const reopened = await post(`/canvas/pins/${pinId}/resolve`, { actor: 'Wassim', resolved: false });
    assert.equal(reopened.json.discussion.resolved, undefined);
  });

  it('lets agents pin boxes on images and parts of diagrams, and people unpin any pin', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Pins step 2' }));
    const signup = idOf(await callText('add_block', { board_id: boardId, type: 'image', title: 'Signup screen', image_base64: PNG_BASE64 }));
    const source = 'flowchart LR\n  C[Client] --> R(Retry)\n  R -->|5xx| A[API]';
    const flow = idOf(await callText('add_block', { board_id: boardId, type: 'diagram', title: 'Request flow', source }));

    // A person drags a box on the screenshot and creates a task from it.
    const box = { kind: 'box', x: 0.05, y: 0.6, w: 0.3, h: 0.12 };
    const created = await post(`/canvas/blocks/${signup}/pins/task`, { actor: 'Wassim', part: box, text: 'Make the button brand green' });
    assert.equal(created.status, 201);
    assert.equal(created.json.pin.quote, 'box 1');
    const brand = created.json.task.id;

    // An agent pins existing work to another box, a node and an arrow.
    const retries = idOf(await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Cap retries' }] }));
    assert.match(
      await callText('pin', { block_id: signup, task_id: retries, box: { x: 0.5, y: 0.1, w: 0.4, h: 0.2 } }),
      /^Pinned box 2 in image "Signup screen" to T2 \[pin id: \w+\]/,
    );
    const node = await callText('pin', { block_id: flow, task_id: retries, node: 'R' });
    assert.match(node, /^Pinned node "Retry" in diagram "Request flow" to T2 \[pin id: (\w+)\]/);
    assert.equal(await callText('pin', { block_id: flow, task_id: retries, node: 'retry' }), node, 'by its text, the same node: pinned once');
    assert.match(await callText('pin', { block_id: flow, task_id: retries, node: 'Retry', to_node: 'A' }), /^Pinned arrow "Retry → API" in diagram "Request flow" to T2/);
    const canvas = await callText('get_canvas', { board_id: boardId });
    assert.match(canvas, /\n  pinned box 1 \(x 0\.05, y 0\.6, w 0\.3, h 0\.12\) → T1 \(backlog\)[^\n]*\n  pinned box 2 \(x 0\.5, y 0\.1, w 0\.4, h 0\.2\) → T2 \(to do\)/);
    assert.match(canvas, /\n  pinned node "Retry" \(id R\) → T2 \(to do\)[^\n]*\n  pinned arrow "Retry → API" \(R --> A, text "5xx"\) → T2 \(to do\)/);
    assert.match(await callText('get_task', { task_id: retries }), /## Pinned from\n- box 2 in image "Signup screen"[^\n]*\n- node "Retry" in diagram "Request flow"[^\n]*\n- arrow "Retry → API" in diagram/);

    const refusals: [Record<string, unknown>, RegExp][] = [
      [{ block_id: flow, box: { x: 0, y: 0, w: 0.5, h: 0.5 } }, /Boxes are drawn on images; diagram "Request flow" is a diagram\./],
      [{ block_id: signup, box: { x: 0.8, y: 0, w: 0.5, h: 0.5 } }, /fractions of the image \(0 to 1\) from its top left, and stays inside it/],
      [{ block_id: signup, node: 'R' }, /Only diagrams have nodes and arrows; image "Signup screen" is an image\./],
      [{ block_id: flow, node: 'Queue' }, /diagram "Request flow" has no node "Queue"\. Its nodes: C, R and A\./],
      [{ block_id: flow, to_node: 'A' }, /to_node needs node/],
      [{ block_id: flow, node: 'C', to_node: 'A' }, /has no arrow from "C" to "A"/],
      [{ block_id: flow, node: 'R', row: 1 }, /Pin a diagram part with node \(and to_node for an arrow\) only/],
    ];
    for (const [args, refusal] of refusals) {
      const result = await call('pin', { task_id: retries, ...args });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(result.content[0].text, refusal);
    }

    // People unpin any pin, an agent's too; the work stays. Agents can't unpin a person's.
    const theirs = await call('remove_item', { id: created.json.pin.id });
    assert.match(theirs.content[0].text, /Wassim made that pin, so only a person removes it/);
    const nodePin = node.match(/pin id: (\w+)/)![1];
    assert.equal((await post(`/canvas/items/${nodePin}/delete`, { actor: 'Wassim' })).status, 200);
    assert.equal((await post(`/canvas/items/${created.json.pin.id}/delete`, { actor: 'Wassim' })).status, 200);
    const updates = await callText('get_updates', { board_id: boardId, since: 0 });
    assert.match(updates, /Wassim \(human\) unpinned node "Retry" in diagram "Request flow" \(board context\) from T2 "Cap retries"/);
    assert.match(updates, /Wassim \(human\) unpinned box 1 in image "Signup screen" \(board context\) from T1 "Make the button brand green"/);
    assert.match(await callText('get_task', { task_id: brand }), /# T1 \[id: \w+\] Make the button brand green\nStatus: backlog/);
    assert.doesNotMatch(await callText('get_canvas', { board_id: boardId }), /pinned (node "Retry"|box 1)/);
  });

  it('replaces an image in place, and points agents at their earlier version of a block', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const add = (await client.listTools()).tools.find((t) => t.name === 'add_block')!;
    assert.match(add.description ?? '', /A new version of something already on a canvas .* goes in that block: update_block on it, images included/);
    const boardId = idOf(await callText('create_board', { title: 'Mocks' }));
    const taskId = idOf(await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Connect screen' }] }));
    const added = await callText('add_block', { task_id: taskId, type: 'image', title: 'Connect screen (mock)', image_base64: PNG_BASE64 });
    assert.doesNotMatch(added, /Advice/);
    const shot = idOf(added);

    const v2 = Buffer.concat([Buffer.from(PNG_BASE64, 'base64'), Buffer.from('v2')]).toString('base64');
    assert.equal(
      await callText('update_block', { block_id: shot, rev: 1, image_base64: v2 }),
      `Updated image "Connect screen (mock)" [id: ${shot}] (now rev 2).`,
    );
    const read = await call('get_block', { block_id: shot });
    assert.match(read.content[0].text, / · rev 2\n/);
    assert.equal(read.content.find((c) => c.type === 'image')?.data, v2);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /^updated image "Connect screen \(mock\)" on the canvas of T1 .*: replaced the image$/);

    // Boxes on it stay put; the agent is asked to check them.
    await post(`/canvas/blocks/${shot}/pins/task`, { actor: 'Wassim', part: { kind: 'box', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, text: 'Bigger button' });
    await post(`/canvas/blocks/${shot}/pins/comment`, { actor: 'Wassim', part: { kind: 'box', x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, body: 'Copy?' });
    assert.equal(
      await callText('update_block', { block_id: shot, rev: 2, image_base64: PNG_BASE64 }),
      `Updated image "Connect screen (mock)" [id: ${shot}] (now rev 3). 2 boxes are pinned on this image: check they still point at the right parts.`,
    );

    const refusals: [Record<string, unknown>, RegExp][] = [
      [{ block_id: shot, rev: 3, image_path: '/x.png' }, /image_path or image_base64 \(exactly one\)/],
      [{ block_id: shot, rev: 3, image_base64: Buffer.from('not an image').toString('base64') }, /Only PNG, JPEG, GIF and WebP/],
      [{ block_id: idOf(await callText('add_block', { task_id: taskId, type: 'note', text: 'Notes' })), rev: 1 }, /A note block has no image/],
      [{ block_id: shot, rev: 1 }, /changed since rev 1: it is now rev 3/],
    ];
    for (const [args, refusal] of refusals) {
      const result = await call('update_block', { image_base64: PNG_BASE64, ...args });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(result.content[0].text, refusal);
    }

    // A near-duplicate of its own block gets a nudge; other blocks don't.
    const again = await callText('add_block', { task_id: taskId, type: 'image', title: 'Connect screen v2', image_base64: PNG_BASE64 });
    assert.match(
      again,
      new RegExp(`\\n\\nAdvice \\(nothing was rejected\\):\\n- You already have image "Connect screen \\(mock\\)" \\[id: ${shot}\\] here\\. If this is a new version of it, update that block instead and remove this one with remove_item\\.$`),
    );
    const assetId = (await (await fetch(`${base}/api/assets`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(Buffer.from(PNG_BASE64, 'base64')) })).json()).assetId;
    await post('/canvas/blocks', { actor: 'Wassim', taskId, title: 'Settings screen', content: { type: 'image', assetId } });
    const quiet = [
      await callText('add_block', { task_id: taskId, type: 'image', title: 'Settings screen (mock)', image_base64: PNG_BASE64 }), // a person's
      await callText('add_block', { task_id: taskId, type: 'table', title: 'Connect screen', columns: ['field'] }), // another type
      await callText('add_block', { task_id: taskId, type: 'image', image_base64: PNG_BASE64 }), // untitled
    ];
    for (const result of quiet) assert.doesNotMatch(result, /You already have/);
  });

  it('keeps earlier versions of blocks: people fetch them per block, agents read them in get_block', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Versions' }));
    const plan = idOf(await callText('add_block', { board_id: boardId, type: 'note', title: 'Plan', text: 'Ship Friday' }));
    await callText('update_block', { block_id: plan, rev: 1, text: 'Ship Monday' });
    await post(`/canvas/blocks/${plan}`, { actor: 'Wassim', rev: 2, text: 'Ship Tuesday' });

    // The board people load says how many versions a block has, not what they are.
    const board = await (await fetch(`${base}/api/boards/${boardId}`)).json();
    const sent = board.canvas.blocks.find((b: { id: string }) => b.id === plan);
    assert.equal(sent.versionCount, 2);
    assert.equal(sent.versions, undefined);
    assert.equal(versionsOf(store, plan).length, 2, 'the server keeps them');

    const listed = await (await fetch(`${base}/api/canvas/blocks/${plan}/versions`)).json();
    assert.equal(listed.rev, 3);
    assert.deepEqual(
      listed.versions.map((v: { rev: number; by: { name: string }; change: string }) => [v.rev, v.by.name, v.change]),
      [[3, 'Wassim', 'edited the text'], [2, 'Planner', 'edited the text'], [1, 'Planner', 'made it']],
    );
    const v1 = await (await fetch(`${base}/api/canvas/blocks/${plan}/versions/1`)).json();
    assert.deepEqual([v1.rev, v1.type, v1.text, v1.title], [1, 'note', 'Ship Friday', 'Plan']);
    assert.equal((await fetch(`${base}/api/canvas/blocks/${plan}/versions/7`)).status, 404);

    // Agents see them in get_block, one line each.
    const read = await callText('get_block', { block_id: plan });
    assert.match(
      read,
      /\n\nVersions, newest first \(restore one with update_block, restore_rev\):\n- v3 \(current\) · \S+ · Wassim \(human\) · edited the text\n- v2 · \S+ · Planner \(agent\) · edited the text\n- v1 · \S+ · Planner \(agent\) · made it$/,
    );
    assert.doesNotMatch(await callText('get_canvas', { board_id: boardId }), /Ship Friday|Ship Monday|newest first/, 'not in canvas digests');

    // People restore over REST; a stale view is refused.
    assert.equal((await post(`/canvas/blocks/${plan}/restore`, { actor: 'Wassim', rev: 1, blockRev: 2 })).status, 409);
    const restored = await post(`/canvas/blocks/${plan}/restore`, { actor: 'Wassim', rev: 1, blockRev: 3 });
    assert.equal(restored.status, 200);
    assert.deepEqual([restored.json.rev, restored.json.text, restored.json.versionCount, restored.json.versions], [4, 'Ship Friday', 3, undefined]);
    assert.match(await callText('get_updates', { board_id: boardId, since: 0 }), /Wassim \(human\) restored v1 of note "Plan" in the board context: edited the text/);

    // Agents restore with update_block, on its own.
    const mixed = await call('update_block', { block_id: plan, rev: 4, restore_rev: 2, title: 'x' });
    assert.equal(mixed.isError, true);
    assert.match(mixed.content[0].text, /Pass restore_rev with block_id and rev only/);
    assert.equal(
      await callText('update_block', { block_id: plan, rev: 4, restore_rev: 2 }),
      `Restored v2 of note "Plan" [id: ${plan}] (now rev 5). The version it replaced is kept.`,
    );
    const stale = await call('update_block', { block_id: plan, rev: 4, restore_rev: 3 });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /changed since rev 4[\s\S]*Current content \(rev 5\):\nShip Monday/);
    assert.match(await callText('get_block', { block_id: plan }), /- v5 \(current\) · \S+ · Planner \(agent\) · edited the text\n- v4 · /);
  });

  it('ends an idle wait with a hint to call again', async () => {
    const boardId = (await callText('create_board', { title: 'Idle' })).match(/\[id: ([^\]]+)\]/)![1];
    const result = await callText('wait_for_updates', { board_id: boardId, since: 1, timeout_seconds: 1 });
    assert.equal(result, 'No new activity. Cursor: 1\nNothing yet after 1s; call again to keep waiting.');
  });

  it('names ready work when an agent reads the board or waits', async () => {
    const boardId = (await callText('create_board', { title: 'Ready' })).match(/\[id: ([^\]]+)\]/)![1];
    const taskId = (await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Cut over' }] })).match(/\[id: ([^\]]+)\]/)![1];
    const ready = new RegExp(`Ready in to do: T1 \\[id: ${taskId}\\] Cut over\\. Before you wait, hand it to a subagent with the brief from brief_task \\(or claim it yourself\\)\\.`);
    assert.match(await callText('get_board', { board_id: boardId }), ready);
    const waited = await callText('wait_for_updates', { board_id: boardId, since: 99, timeout_seconds: 1 });
    assert.match(waited, /Nothing yet after 1s; call again to keep waiting\.\n/);
    assert.match(waited, ready);

    await callText('claim_task', { task_id: taskId });
    assert.doesNotMatch(await callText('wait_for_updates', { board_id: boardId, since: 99, timeout_seconds: 1 }), /Ready in to do/);
  });

  it('leads get_board with the chief of staff line only when tasks are ready for this agent', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Lead' }));
    assert.match(await callText('get_board', { board_id: boardId }), /^# Lead \[id: /, 'no tasks, nothing ready');

    store.planTasks(boardId, [{ title: 'Review the diff', assignee: 'Codex' }], { kind: 'agent', name: 'Codex' });
    const theirs = await callText('get_board', { board_id: boardId });
    assert.match(theirs, /^# Lead \[id: /, "a task assigned to another agent isn't this one's to hand out");
    assert.doesNotMatch(theirs, /Ready in to do/, 'nor named among the ready tasks');
    assert.match(theirs, /- T1 \[id: \w+\] Review the diff — to do · assigned to Codex by Codex/, 'the task list still has it');

    const mine = idOf(await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Cut over' }] }));
    const ready = await callText('get_board', { board_id: boardId });
    assert.ok(
      ready.startsWith(
        `You're the chief of staff here: hand each ready task to a subagent (brief_task gives its brief) and stay on the board. Ready: T2 [task id: ${mine}].\nCan't run subagents? Claim it and do it, checking the board in between.\n\n# Lead [id: ${boardId}]`,
      ),
      ready,
    );

    await callText('claim_task', { task_id: mine });
    assert.match(await callText('get_board', { board_id: boardId }), /^# Lead \[id: /, 'none ready once it is claimed');
  });

  it('briefs a subagent on a task, in any status, without changing anything', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Brief', goal: 'Resilient API calls' }));
    const decisionId = idOf(
      await callText('post_decision', {
        board_id: boardId,
        question: 'Which retry strategy?',
        options: [{ label: 'Options object', description: 'Each call takes retry options.' }, { label: 'Wrapper function' }],
      }),
    );
    await post(`/decisions/${decisionId}/comments`, { actor: 'Wassim', body: 'Keep the defaults conservative.' });
    await post(`/decisions/${decisionId}/resolve`, { actor: 'Wassim', optionId: 'a', rationale: 'Covers every call site' });
    const taskId = idOf(
      await callText('plan_tasks', {
        board_id: boardId,
        tasks: [{ title: 'Add retry option', detail: 'Every call takes retry options; 3 tries by default.', decision_ids: [decisionId] }],
      }),
    );
    await post(`/tasks/${taskId}/comments`, { actor: 'Wassim', body: 'Log each retry at debug level.' });
    await callText('add_block', { task_id: taskId, type: 'note', title: 'Plan', text: 'Start with the HTTP client, then the queue.' });
    await callText('add_block', { task_id: taskId, type: 'checklist', title: 'Steps', items: ['Options type', { text: 'Defaults', done: true }] });
    await callText('add_block', { task_id: taskId, type: 'table', title: 'Budgets', columns: ['Call', 'Tries'], rows: [['GET', '3']] });
    await callText('add_block', { task_id: taskId, type: 'image', title: 'Retry panel', caption: 'Settings, retries on', image_base64: PNG_BASE64 });
    const roadmap = idOf(await callText('add_block', { board_id: boardId, type: 'note', title: 'Roadmap', text: 'Retries ship first, then metrics.' }));
    await callText('pin', { block_id: roadmap, text: 'Retries ship first', task_id: taskId });
    // Built, then sent back with a note.
    await callText('claim_task', { task_id: taskId });
    await callText('update_task', { task_id: taskId, status: 'in_review', link: 'https://example.test/pr/9' });
    await post(`/tasks/${taskId}`, { actor: 'Wassim', status: 'in_progress', note: 'Back off for longer between tries.' });
    const seq = store.getBoard(boardId).seq;

    const brief = await callText('brief_task', { task_id: taskId });
    assert.match(brief, new RegExp(`^# Brief: T1 Add retry option\\nTask id: ${taskId} · board "Brief" \\[board id: ${boardId}\\] · status: in progress, claimed by Planner \\(agent\\)\\nBoard goal: Resilient API calls\\n`));
    assert.match(brief, /## The task\nT1: Add retry option\nEvery call takes retry options; 3 tries by default\.\n\n## What done looks like\n/);
    assert.match(brief, /## Latest from people \(newest first[^\n]*\n- Wassim \(human\) at \S+, note: Back off for longer between tries\.\n- Wassim \(human\) at \S+: Log each retry at debug level\./);
    assert.match(
      brief,
      /### #1 Which retry strategy\? \[decision id: \w+\]\nStatus: decided \(binding\)\nChosen: a\) Options object, by Wassim \(human\)\n  Each call takes retry options\.\nRationale: Covers every call site\n/,
    );
    assert.match(brief, /People's comments:\n- Wassim \(human\) at \S+: Keep the defaults conservative\./);
    assert.match(brief, /## Discussion \(oldest first\)\n- Wassim \(human\) at \S+: Log each retry at debug level\./);
    assert.match(brief, /- note "Plan" \(note\) \[block id: \w+\]\n  Start with the HTTP client, then the queue\./);
    assert.match(brief, /- note "Steps" \(note\) \[block id: \w+\]\n  1\/2 done\n  - \[ \] Options type\n  - \[x\] Defaults/);
    assert.match(brief, /- table "Budgets" \(table\) \[block id: \w+\]\n  \| Call \| Tries \|\n  \| --- \| --- \|\n  \| GET \| 3 \|/);
    assert.match(brief, /- image "Retry panel" \(image\) \[block id: \w+\]\n  Caption: Settings, retries on/);
    assert.match(brief, /## Pinned to this task\n- “Retries ship first” in note "Roadmap" \(board context\), pinned by Planner \(agent\)/);
    assert.match(brief, /## People and agents on the board\nPeople: Wassim\. [^\n]+\nAgents: Planner\./);
    assert.match(brief, /## How to work\n- Build only T1\. Work in your own git worktree or branch, and stay in it/);
    assert.match(brief, /\n- Don't commit\. /);
    assert.match(brief, /\n- Run the project's tests/);
    assert.match(brief, /\n- Bring back a patch or diff of your changes, screenshots of the result for UI work \(as file paths\), and a short report/);
    assert.match(brief, new RegExp(`If you can reach Tricot .+ check get_task \\(task_id: ${taskId}\\) between steps for new comments from people, and report progress with update_task .+ If you can't reach Tricot, report back to the main session instead\\.`));
    assert.equal(store.getBoard(boardId).seq, seq, 'reading a brief changes nothing on the board');
    assert.equal(store.getTask(taskId).task.status, 'in_progress');

    // Any status: a done task, and a standalone one with nothing on it.
    const bare = idOf(await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Bump deps' }] }));
    const plain = await callText('brief_task', { task_id: bare });
    assert.match(plain, /status: to do/);
    assert.match(plain, /No detail beyond the title/);
    assert.match(plain, /## Decisions it implements\nNone: it stands alone\./);
    assert.match(plain, /## On its canvas\nNothing yet\./);
    assert.doesNotMatch(plain, /## Latest from people|## Pinned to this task/);

    const unknown = await call('brief_task', { task_id: 'nope' });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /No task with id "nope"\./);
  });

  it("shows agents a person's sync request, keeps them off that person's blocks, and lets them finish it", async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Sync' }));
    const status = idOf(await callText('add_block', { board_id: boardId, type: 'note', title: 'Status', text: 'Nothing decided' }));
    const mine = await post('/canvas/blocks', { actor: 'Wassim', boardId, title: 'Constraints', content: { type: 'note', text: 'Ship by Friday' } });
    const cursor = Number((await callText('get_board', { board_id: boardId })).match(/Cursor: (\d+)/)![1]);

    const asked = await post(`/boards/${boardId}/sync`, { actor: 'Wassim' });
    assert.equal(asked.status, 200);
    assert.equal(asked.json.syncRequest.blockIds, undefined, 'Sync all');
    const updates = await callText('get_updates', { board_id: boardId, since: cursor });
    assert.match(updates, /Wassim \(human\) asked agents to sync the board context \(agent-made blocks\)/);
    assert.match(updates, /\nSync requested by Wassim \(human\) at \S+: bring the board context up to date/);
    assert.match(await callText('get_board', { board_id: boardId }), /Sync requested by Wassim \(human\)/);
    assert.match(await callText('wait_for_updates', { board_id: boardId, since: 99, timeout_seconds: 1 }), /call finish_sync/);
    assert.match(await callText('get_canvas', { board_id: boardId }), /note "Constraints" .+ Wassim's block: leave it during this sync/);

    const refused = await call('update_block', { block_id: mine.json.id, rev: 1, text: 'Ship next week' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /is Wassim's \(they made or edited it\), and Wassim's sync covers agent-made blocks only/);
    await callText('update_block', { block_id: status, rev: 1, text: 'Two decisions settled' });
    assert.match(await callText('finish_sync', { board_id: boardId, note: 'Updated the status' }), /Synced the board context of Sync/);

    const board = await (await fetch(`${base}/api/boards/${boardId}`)).json();
    assert.equal(board.syncRequest, undefined);
    assert.equal(board.synced.by.name, 'Planner');
    assert.equal(eventsOf(store, boardId).at(-1)!.summary, `synced the board context (answering Wassim's request): "Updated the status"`);
    assert.equal((await call('finish_sync', { board_id: boardId })).isError, true, 'nothing left to finish');

    // A person can cancel a request they no longer need. An old client's
    // "Include mine" is ignored: it asks for a sync of all.
    const old = await post(`/boards/${boardId}/sync`, { actor: 'Wassim', includeMine: true });
    assert.deepEqual(Object.keys(old.json.syncRequest).sort(), ['at', 'by']);
    const cancelled = await post(`/boards/${boardId}/sync/cancel`, { actor: 'Wassim' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.syncRequest, undefined);
    assert.equal(cancelled.json.synced.by.name, 'Planner', 'the last finished sync still shows');
  });

  it('shows agents the blocks a person selected to sync, and lets them refresh exactly those', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Sync selected' }));
    const built = idOf(await callText('add_block', { board_id: boardId, type: 'checklist', title: 'Built so far', items: ['Cards'] }));
    const status = idOf(await callText('add_block', { board_id: boardId, type: 'note', title: 'Where things stand', text: 'T44 open' }));
    const goal = (await post('/canvas/blocks', { actor: 'Wassim', boardId, title: 'Goal', content: { type: 'note', text: 'MVP' } })).json.id;
    const cursor = Number((await callText('get_board', { board_id: boardId })).match(/Cursor: (\d+)/)![1]);

    assert.equal((await post(`/boards/${boardId}/sync`, { actor: 'Wassim', blockIds: [] })).status, 400);
    const unknown = await post(`/boards/${boardId}/sync`, { actor: 'Wassim', blockIds: ['nope'] });
    assert.equal(unknown.status, 400);
    assert.match(unknown.json.error, /"nope" is not a block in the board context/);
    assert.equal((await post(`/boards/${boardId}/sync`, { actor: 'Wassim', blockIds: 'all' })).status, 400);

    const asked = await post(`/boards/${boardId}/sync`, { actor: 'Wassim', blockIds: [goal, built] });
    assert.equal(asked.status, 200);
    assert.deepEqual(asked.json.syncRequest.blockIds, [built, goal]);
    const selection = new RegExp(
      `bring the blocks Wassim selected in the board context up to date with the board: note "Built so far" \\[id: ${built}\\], note "Goal" \\[id: ${goal}\\]\\. Refresh exactly those`,
    );
    const updates = await callText('get_updates', { board_id: boardId, since: cursor });
    assert.match(updates, /Wassim \(human\) asked agents to sync 2 blocks in the board context: "Built so far", "Goal"/);
    assert.match(updates, selection);
    assert.match(await callText('get_board', { board_id: boardId }), selection);
    assert.match(await callText('wait_for_updates', { board_id: boardId, since: 99, timeout_seconds: 1 }), selection);
    const canvas = await callText('get_canvas', { board_id: boardId });
    assert.match(canvas, /note "Built so far" \[id: \S+\] .+ · in this sync\n/);
    assert.match(canvas, /note "Goal" \[id: \S+\] .+ · Wassim's block: in this sync\n/);
    assert.match(canvas, /note "Where things stand" \[id: \S+\] .+ · leave it during this sync\n/);

    await callText('update_block', { block_id: built, rev: 1, items: [{ text: 'Cards', done: true }, 'Sync selected'] });
    await callText('update_block', { block_id: goal, rev: 1, text: 'MVP: local-first, any agent tool' });
    const refused = await call('update_block', { block_id: status, rev: 1, text: 'All done' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /isn't in this sync: Wassim's sync covers only the blocks they selected/);
    const added = await call('add_block', { board_id: boardId, type: 'note', text: 'Risks' });
    assert.equal(added.isError, true);
    assert.match(added.content[0].text, /can't add blocks to the board context until it's finished/);

    assert.equal(
      await callText('finish_sync', { board_id: boardId, note: 'Ticked cards, reworded the goal' }),
      'Synced "Built so far" and "Goal" in the board context of Sync selected; people see they are up to date.',
    );
    const board = await (await fetch(`${base}/api/boards/${boardId}`)).json();
    assert.equal(board.syncRequest, undefined);
    assert.deepEqual(board.synced.blockIds, [built, goal]);
    assert.equal(
      eventsOf(store, boardId).at(-1)!.summary,
      `synced "Built so far" and "Goal" in the board context (answering Wassim's request): "Ticked cards, reworded the goal"`,
    );
    assert.equal(board.canvas.blocks.find((b: { id: string }) => b.id === goal).text, 'MVP: local-first, any agent tool');
    assert.equal(board.canvas.blocks.find((b: { id: string }) => b.id === status).text, 'T44 open');
    await callText('update_block', { block_id: status, rev: 1, text: 'All done' }); // free again
  });

  it('lets people ask agents on the board context, and an agent take it, answer in its group and finish it', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Ask agents' }));
    const cursor = Number((await callText('get_board', { board_id: boardId })).match(/Cursor: (\d+)/)![1]);
    const take = (await client.listTools()).tools.find((t) => t.name === 'take_request')!;
    // People ask in the General thread now; a board's older requests are still taken and finished.
    assert.match(take.description ?? '', /People now ask from the Board Context in the board's General thread: answer those there \(reply_in_thread\)\./);
    assert.match(take.description ?? '', /Take one with take_request, .+ finish_request with a one-line note\./);

    assert.equal((await post(`/boards/${boardId}/requests`, { actor: 'Wassim', text: '' })).status, 400);
    assert.equal((await post(`/boards/${boardId}/requests`, { actor: 'Wassim' })).status, 400);
    const tooLong = await post(`/boards/${boardId}/requests`, { actor: 'Wassim', text: 'x'.repeat(501) });
    assert.match(tooLong.json.error, /too long \(max 500 characters\)/);
    const asked = await post(`/boards/${boardId}/requests`, { actor: 'Wassim', text: 'Get me an architecture view of the project' });
    assert.equal(asked.status, 200);
    const request = asked.json.requests[0];
    assert.equal(request.status, 'open');
    assert.equal(request.by.name, 'Wassim');
    const pending = `Wassim asked agents on the board context [request id: ${request.id}]: "Get me an architecture view of the project". Take it with take_request, build the answer as blocks in its group, then finish_request with a one-line note.`;
    const updates = await callText('get_updates', { board_id: boardId, since: cursor });
    assert.match(updates, /Wassim \(human\) asked agents: "Get me an architecture view of the project"/);
    assert.ok(updates.endsWith(`\n${pending}`), updates);
    assert.ok((await callText('get_board', { board_id: boardId })).includes(pending));
    assert.ok((await callText('wait_for_updates', { board_id: boardId, since: 99, timeout_seconds: 1 })).includes(pending));

    const missing = await call('take_request', { request_id: 'nope' });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /No request "nope"/);
    const early = await call('finish_request', { request_id: request.id, note: 'Done' });
    assert.match(early.content[0].text, /Nobody has taken "Architecture view" yet/);
    const took = await callText('take_request', { request_id: request.id });
    const groupId = took.match(/\[group id: ([^\]]+)\]/)![1];
    assert.equal(
      took,
      `Took Wassim's request: "Get me an architecture view of the project". Its group on the board context is "Architecture view" [group id: ${groupId}]. Build the answer there as blocks (add_block with board_id: ${boardId} and group_id: ${groupId}), reading the project as needed: diagrams and tables over prose. Then finish_request with a one-line note.`,
    );
    assert.doesNotMatch(await callText('get_board', { board_id: boardId }), /Take it with take_request/);
    assert.match(await callText('get_board', { board_id: boardId }), /Planner is answering Wassim's request \[request id: \S+\] .+ in group "Architecture view"/);

    const empty = await call('finish_request', { request_id: request.id, note: 'Done' });
    assert.match(empty.content[0].text, /Group "Architecture view" is empty: add your answer there first/);
    await callText('add_block', { board_id: boardId, group_id: groupId, type: 'diagram', title: 'Modules', source: 'flowchart LR\n  web --> server --> core' });
    await callText('add_block', { board_id: boardId, group_id: groupId, type: 'table', title: 'Stores', columns: ['Module', 'Owns'], rows: [['core', 'boards']] });
    assert.match(await callText('get_canvas', { board_id: boardId }), /## Group "Architecture view" \[id: \S+\] · answers Wassim's request .+, taken by Planner\n- diagram "Modules"/);
    assert.equal(
      await callText('finish_request', { request_id: request.id, note: 'A module diagram and a table of what each owns' }),
      `Finished Wassim's request in group "Architecture view"; people see it's done, with your note.`,
    );

    let board = await (await fetch(`${base}/api/boards/${boardId}`)).json();
    const done = board.requests[0];
    assert.equal(done.status, 'done');
    assert.equal(done.takenBy.name, 'Planner');
    assert.equal(done.note, 'A module diagram and a table of what each owns');
    assert.equal(board.canvas.blocks.filter((b: { groupId?: string }) => b.groupId === groupId).length, 2);
    assert.deepEqual(
      eventsOf(store, board).slice(-4).map((e: { type: string }) => e.type),
      ['request_taken', 'canvas_changed', 'canvas_changed', 'request_finished'],
    );
    assert.equal((await call('finish_request', { request_id: request.id, note: 'Again' })).isError, true);
    assert.doesNotMatch(await callText('get_board', { board_id: boardId }), /request id/);

    // A person cancels one that's open; agents can't take it after.
    const second = (await post(`/boards/${boardId}/requests`, { actor: 'Sam', text: "What's left to build?" })).json.requests[1];
    assert.equal((await post(`/boards/${boardId}/requests/nope/cancel`, { actor: 'Wassim' })).status, 404);
    assert.equal((await post(`/boards/missing/requests/${second.id}/cancel`, { actor: 'Wassim' })).status, 404);
    const cancelled = await post(`/boards/${boardId}/requests/${second.id}/cancel`, { actor: 'Wassim' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.requests[1].status, 'cancelled');
    assert.equal(eventsOf(store, boardId).at(-1)!.summary, `cancelled Sam's request: "What's left to build?"`);
    assert.equal((await post(`/boards/${boardId}/requests/${second.id}/cancel`, { actor: 'Wassim' })).status, 200, 'over either way');
    const late = await call('take_request', { request_id: second.id });
    assert.match(late.content[0].text, /Sam's request "What's left to build" was cancelled, so there's nothing to take/);
    board = await (await fetch(`${base}/api/boards/${boardId}`)).json();
    assert.equal(board.canvas.groups.length, 1);
  });

  it('lets a person ask for a refresh, and an agent see it and complete it', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Refresh' }));
    const decisionId = idOf(
      await callText('post_decision', {
        board_id: boardId,
        question: 'Which retry strategy?',
        options: [{ label: 'Options object' }, { label: 'Wrapper function' }, { label: 'Client-level policy' }],
        recommend: 'c',
        recommendation_reason: 'One place to configure',
      }),
    );
    const cursor = Number((await callText('get_board', { board_id: boardId })).match(/Cursor: (\d+)/)![1]);

    const waiting = callText('wait_for_updates', { board_id: boardId, since: cursor, timeout_seconds: 10 });
    await new Promise((r) => setTimeout(r, 100));
    const asked = await post(`/decisions/${decisionId}/refresh`, { actor: 'Wassim', note: 'Config is per environment now' });
    assert.equal(asked.status, 200);
    assert.equal(asked.json.refreshRequest.by.name, 'Wassim');
    const updates = await waiting;
    assert.match(updates, /Wassim \(human\) asked agents to refresh the options of #1 "Which retry strategy\?": "Config is per environment now"/);
    assert.match(updates, new RegExp(`Refresh requested on #1 \\[id: ${decisionId}\\] by Wassim \\("Config is per environment now"\\)`));
    assert.match(await callText('get_updates', { board_id: boardId, since: cursor }), /Refresh requested on #1/);
    assert.match(
      await callText('get_board', { board_id: boardId }),
      /Wassim asked agents to refresh the options: "Config is per environment now" \(re-check it, then update_decision with refreshed: true\)/,
    );
    assert.match(await callText('get_decision', { decision_id: decisionId }), /## Refresh requested\nBy Wassim \(human\) at \S+: "Config is per environment now"\nRe-check this card/);
    const update = (await client.listTools()).tools.find((t) => t.name === 'update_decision')!;
    assert.match(update.description ?? '', /When a person asks for a refresh of a decision \(get_board, get_decision and your updates show it\), do it next/);

    const noReason = await call('update_decision', { decision_id: decisionId, revise_options: [{ option: 'c', outdated: '' }] });
    assert.equal(noReason.isError, true);
    assert.match(noReason.content[0].text, /Say why option c\) no longer applies/);
    const done = await callText('update_decision', {
      decision_id: decisionId,
      revise_options: [{ option: 'c', outdated: 'global config was dropped' }],
      add_options: [{ label: 'Per-environment policy', description: 'Follows where config lives now' }],
      recommend: 'd',
      recommendation_reason: 'Matches per-environment config',
      refreshed: true,
      note: 'Config moved per environment, so c no longer fits.',
    });
    assert.match(done, /^Refreshed #1; people see: c outdated \(global config was dropped\), d added, recommends d\./);
    assert.match(done, /### c\) Client-level policy\nOUTDATED \(can't be picked\)/);
    assert.match(done, /### d\) Per-environment policy ★ recommended/);

    let board = await (await fetch(`${base}/api/boards/${boardId}`)).json();
    let decision = board.decisions[0];
    assert.equal(decision.refreshRequest, undefined);
    assert.deepEqual(decision.refreshed.changes, ['c outdated (global config was dropped)', 'd added', 'recommends d']);
    assert.equal(eventsOf(store, boardId).at(-1)!.summary, `refreshed #1 "Which retry strategy?" (answering Wassim's request): c outdated (global config was dropped), d added, recommends d; note: "Config moved per environment, so c no longer fits."`);
    const outdatedPick = await post(`/decisions/${decisionId}/resolve`, { actor: 'Wassim', optionId: 'c' });
    assert.equal(outdatedPick.status, 400);
    assert.match(outdatedPick.json.error, /is outdated \("global config was dropped"\), so it can't be picked/);
    const asAgent = await call('log_decision', { decision_id: decisionId, choice: 'c', rationale: 'simplest' });
    assert.equal(asAgent.isError, true);

    // A person edits the card; agents get the change summary and a nudge.
    const before = board.seq;
    const revised = await post(`/decisions/${decisionId}/revise`, {
      actor: 'Wassim',
      question: 'How should the API client retry?',
      options: [
        { id: 'b', label: 'Wrapper around fetch, behind a flag' },
        { id: 'a', outdated: true, reason: 'per-call opt-in is gone' },
      ],
    });
    assert.equal(revised.status, 200);
    assert.equal(revised.json.options[0].outdated.reason, 'per-call opt-in is gone');
    assert.equal(revised.json.options[1].person.name, 'Wassim');
    const changed = await callText('get_updates', { board_id: boardId, since: before });
    assert.match(
      changed,
      /Wassim \(human\) revised #1 "How should the API client retry\?": reworded the question \(was "Which retry strategy\?"\), reworded b \(was "Wrapper function"\), marked a outdated \("per-call opt-in is gone"\)/,
    );
    assert.match(changed, new RegExp(`People changed what \\[id: ${decisionId}\\] offers: re-check your recommendation there`));
    const theirs = await call('update_decision', { decision_id: decisionId, revise_options: [{ option: 'b', label: 'Wrapper' }] });
    assert.match(theirs.content[0].text, /is Wassim's \(they proposed or reworded it\), so agents can't change it/);
    assert.equal((await post(`/decisions/${decisionId}/revise`, { actor: 'Wassim', options: [{ id: 'q', label: 'x' }] })).status, 400);

    // A request can be cancelled; only people ask or cancel.
    await post(`/decisions/${decisionId}/refresh`, { actor: 'Wassim' });
    const cancelled = await post(`/decisions/${decisionId}/refresh/cancel`, { actor: 'Wassim' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.refreshRequest, undefined);
    assert.doesNotMatch(await callText('get_board', { board_id: boardId }), /Refresh requested/);

    // Retired, it leaves Open; agents see why, and a person brings it back.
    assert.equal((await post(`/decisions/${decisionId}/retire`, { actor: 'Wassim', note: '' })).status, 400);
    const retired = await post(`/decisions/${decisionId}/retire`, { actor: 'Wassim', note: 'The gateway retries for us now' });
    assert.equal(retired.status, 200);
    assert.equal(retired.json.status, 'retired');
    assert.match(await callText('get_board', { board_id: boardId }), /## Retired: .+ \(1\)\n- #1 .+ — retired: "The gateway retries for us now"/);
    assert.match(await callText('get_decision', { decision_id: decisionId }), /## Retired as no longer relevant\nBy Wassim \(human\) at \S+: The gateway retries for us now\./);
    const reworded = await call('update_decision', { decision_id: decisionId, question: 'Still?' });
    assert.match(reworded.content[0].text, /Wassim retired #1 .+ so agents can't reword it/);
    const back = await post(`/decisions/${decisionId}/reopen`, { actor: 'Wassim' });
    assert.equal(back.json.status, 'open');
    board = await (await fetch(`${base}/api/boards/${boardId}`)).json();
    decision = board.decisions[0];
    assert.equal(decision.retirement, undefined);
    assert.equal(eventsOf(store, boardId).at(-1)!.summary, 'brought back #1 "How should the API client retry?", which was retired');
  });

  it('reports bad input as tool errors, not crashes', async () => {
    const result = await call('get_decision', { decision_id: 'missing' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No decision with id "missing"/);

    const rest = await post('/decisions/missing/resolve', { actor: 'Wassim', optionId: 'a' });
    assert.equal(rest.status, 404);
    const invalid = await post('/boards', { actor: '', title: 'x' });
    assert.equal(invalid.status, 400);
  });

  it('rejects requests with a foreign Host header', async () => {
    // fetch() won't let us override Host, so use a raw request.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/api/boards`, { headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});
