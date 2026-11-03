import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { eventsOf } from './tables';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

// A small change in git's form: one file, two hunks.
const PATCH = [
  'diff --git a/src/server/connectors/oauth.ts b/src/server/connectors/oauth.ts',
  'index 1111111..2222222 100644',
  '--- a/src/server/connectors/oauth.ts',
  '+++ b/src/server/connectors/oauth.ts',
  '@@ -10,3 +10,4 @@ export function writeTokenFile(file: string, tokens: Tokens): void {',
  '   const dir = path.dirname(file);',
  '   mkdirSync(dir, { recursive: true, mode: 0o700 });',
  '+  const tmp = `${file}.${process.pid}.tmp`;',
  '   writeFileSync(file, JSON.stringify(tokens), { mode: 0o600 });',
  '@@ -41,3 +42,3 @@ load(): void',
  '     for (const file of readdirSync(this.dataDir)) {',
  "-      if (!file.endsWith('.json')) continue;",
  "+      if (!file.endsWith('.json') || !looksLikeBoard(file)) continue;",
  '     }',
  'diff --git a/package-lock.json b/package-lock.json',
  'index 3333333..4444444 100644',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '@@ -1,1 +1,1 @@',
  '-{ "lockfileVersion": 2 }',
  '+{ "lockfileVersion": 3 }',
  '',
].join('\n');

describe('Diff blocks over MCP and REST', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let client: Client;
  let store: Store;

  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await call(name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content[0].text;
  }
  async function request(method: string, route: string, body?: Record<string, unknown>) {
    const response = await fetch(`${base}/api${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  }
  const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-diff-mcp-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
  });

  after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('tells agents about diff blocks', async () => {
    const { tools } = await client.listTools();
    const add = tools.find((t) => t.name === 'add_block')!;
    assert.match(add.description ?? '', /When you send code work for review, add a diff block too \(type diff, with the git diff of the work as patch\), next to the screenshots, with the files that matter as focus\./);
    assert.match(add.description ?? '', /diff → patch \(a unified diff, as git diff or git show prints it\), plus optional focus/);
    assert.ok((add.inputSchema.properties as Record<string, unknown>).patch);
    const pin = tools.find((t) => t.name === 'pin')!;
    assert.match(pin.description ?? '', /a line of a diff \(file and line, with side "old" for a removed line\)/);
  });

  it('adds and updates a diff, shows it compactly to agents and in full on get_block, and keeps each version', async () => {
    const boardId = idOf(await callText('create_board', { title: 'Connectors' }));
    const taskId = idOf(await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Google connector' }] }));

    const refused = await call('add_block', { task_id: taskId, type: 'diff', patch: 'Fixed it, see the branch.' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /That isn't a unified diff: it has no "diff --git" or "---"\/"\+\+\+" file headers\. Send the output of git diff or git show/);
    const missing = await call('add_block', { task_id: taskId, type: 'diff' });
    assert.match(missing.content[0].text, /A diff block needs patch/);

    const added = await callText('add_block', { task_id: taskId, type: 'diff', title: 'Token file', patch: PATCH, focus: ['oauth.ts', 'src/missing.ts'] });
    assert.match(added, /^Added diff "Token file" \[id: \w+\] \(rev 1\)\./);
    assert.match(added, /focus "src\/missing\.ts" named no file in the patch, so it was left out/);
    const blockId = idOf(added);

    const canvas = await callText('get_canvas', { task_id: taskId });
    assert.match(
      canvas,
      /- diff "Token file" \[id: \w+\] · rev 1 · by Claude \(agent\)\n  2 files, \+3 −2\. In focus: src\/server\/connectors\/oauth\.ts\.\n  - src\/server\/connectors\/oauth\.ts \+2 −1\n  - package-lock\.json \+1 −1 \(generated, starts folded\)\n  \(get_block for the patch\)/,
    );
    assert.doesNotMatch(canvas, /looksLikeBoard/);
    const full = await callText('get_block', { block_id: blockId });
    assert.match(full, /Patch:\n```diff\ndiff --git a\/src\/server\/connectors\/oauth\.ts[\s\S]*looksLikeBoard[\s\S]*\n```/);

    // People see the files, not the raw patch, in their copy of the board.
    const board = (await request('GET', `/boards/${boardId}`)).json;
    const block = board.tasks[0].canvas.blocks[0];
    assert.equal(block.type, 'diff');
    assert.equal(block.patch, undefined);
    assert.deepEqual(block.files.map((f: { path: string }) => f.path), ['src/server/connectors/oauth.ts', 'package-lock.json']);

    // A new patch replaces it; the earlier one is kept as a version and can come back.
    const next = PATCH.replace('|| !looksLikeBoard(file)', '|| !isBoardFile(file)');
    assert.match(await callText('update_block', { block_id: blockId, rev: 1, patch: next }), /^Updated diff "Token file" \[id: \w+\] \(now rev 2\)\.$/);
    const versions = await callText('get_block', { block_id: blockId });
    assert.match(versions, /isBoardFile/);
    assert.match(versions, /- v2 \(current\) · [^\n]+ · Claude \(agent\) · replaced the patch: now 2 files, \+3 −2\n- v1 · [^\n]+ · Claude \(agent\) · made it/);
    const restored = await callText('update_block', { block_id: blockId, rev: 2, restore_rev: 1 });
    assert.match(restored, /^Restored v1 of diff "Token file"/);
    assert.match(await callText('get_block', { block_id: blockId }), /looksLikeBoard/);
    const kept = await request('GET', `/canvas/blocks/${blockId}/versions/2`);
    assert.match(kept.json.patch, /isBoardFile/);
  });

  it('pins lines: agents with file and line, people with a comment, reported gone after an update', async () => {
    const boardId = idOf(await callText('create_board', { title: 'Review lines' }));
    const taskId = idOf(await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Token file' }] }));
    const blockId = idOf(await callText('add_block', { task_id: taskId, type: 'diff', patch: PATCH }));

    // A person clicks line 12 and comments; it goes in the task's discussion, quoting the line.
    const part = { kind: 'line', file: 'src/server/connectors/oauth.ts', line: 12, side: 'new' };
    const commented = await request('POST', `/canvas/blocks/${blockId}/pins/comment`, { actor: 'Wassim', part, body: 'Could two tabs race here?' });
    assert.equal(commented.status, 201);
    assert.equal(commented.json.comment.pin.quote, 'src/server/connectors/oauth.ts:12 · “const tmp = `${file}.${process.pid}.tmp`;”');
    // The agent answers on the line: in the same discussion, quoting it too.
    assert.equal(
      await callText('comment', { pin_id: commented.json.pin.id, body: 'The rename is atomic, so the last one wins.' }),
      'Commented on T1 about line 12 of src/server/connectors/oauth.ts in diff of 2 files, in its discussion.',
    );

    // An agent links the task to the removed line, on its old side.
    const pinned = await callText('pin', { block_id: blockId, task_id: taskId, file: 'oauth.ts', line: 42, side: 'old' });
    assert.match(pinned, /^Pinned old line 42 of src\/server\/connectors\/oauth\.ts in diff of 2 files to T1 \[pin id: \w+\]/);
    const wrong = await call('pin', { block_id: blockId, task_id: taskId, file: 'oauth.ts', line: 13, side: 'old' });
    assert.match(wrong.content[0].text, /has no old line 13 in diff of 2 files, but has a new one: pass side "new"\. The patch shows its old lines 10–12, 41–43\./);
    const notADiff = idOf(await callText('add_block', { task_id: taskId, type: 'note', text: 'Done' }));
    const onNote = await call('pin', { block_id: notADiff, task_id: taskId, file: 'oauth.ts', line: 12 });
    assert.match(onNote.content[0].text, /Lines are pinned in diffs and code blocks; note "Done" is a note\./);

    let canvas = await callText('get_canvas', { task_id: taskId });
    assert.match(
      canvas,
      /\n  pinned line 12 of src\/server\/connectors\/oauth\.ts \("const tmp = `\$\{file\}\.\$\{process\.pid\}\.tmp`;"\) → 2 comments in the discussion, quoting it \[pin id: \w+\]; answer on the line with comment\(pin_id\)\n    - Wassim \(human\) at [^\n]+: Could two tabs race here\?\n    - Claude \(agent\) at [^\n]+: The rename is atomic/,
    );
    assert.match(canvas, /\n  pinned old line 42 of src\/server\/connectors\/oauth\.ts \("if \(!file\.endsWith\('\.json'\)\) continue;"\) → T1 \(to do\)/);

    // The agent's next patch drops the line: its pin says so.
    const next = PATCH.replace('+  const tmp = `${file}.${process.pid}.tmp`;\n', '').replace('@@ -10,3 +10,4 @@', '@@ -10,3 +10,3 @@').replace('@@ -41,3 +42,3 @@', '@@ -41,3 +41,3 @@');
    await callText('update_block', { block_id: blockId, rev: 1, patch: next });
    canvas = await callText('get_canvas', { task_id: taskId });
    assert.match(canvas, /pinned line 12 of src\/server\/connectors\/oauth\.ts \("const tmp[^\n]*"\) \(no longer there\) → 2 comments/);
    assert.match(canvas, /pinned old line 42 of src\/server\/connectors\/oauth\.ts \("if[^\n]*"\) → T1/); // still there
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /line 12 of src\/server\/connectors\/oauth\.ts, commented on, is no longer there/);
  });
});
