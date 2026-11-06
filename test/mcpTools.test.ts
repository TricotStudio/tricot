import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe as hookStep } from '../hooks/tricot-describe.mjs';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { Connectors } from '../src/server/connectors';
import { INSTRUCTIONS } from '../src/server/mcp';
import { GUIDE_TOPICS, MAX_DESCRIPTION } from '../src/server/mcp/guide';
import { readGuide } from './guide';
import { removeScratch } from './platform';

type Listed = Awaited<ReturnType<Client['listTools']>>['tools'];

// The tool names in the first column of docs/mcp-tools.md: each in backticks.
function documentedTools(): Set<string> {
  const docs = readFileSync(path.join(import.meta.dirname, '..', 'docs', 'mcp-tools.md'), 'utf8');
  const names = new Set<string>();
  for (const row of docs.split('\n').filter((line) => line.startsWith('|'))) {
    const firstCell = row.split('|')[1] ?? '';
    for (const [, name] of firstCell.matchAll(/`([a-z_]+)`/g)) names.add(name);
  }
  return names;
}

describe('the MCP server and its tools', () => {
  let dir: string;
  let server: Server;
  let store: Store;
  let client: Client;
  let tools: Listed;

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-mcp-tools-'));
    store = new Store(dir);
    store.load();
    // With the connectors, so the tools they add are listed, documented and labelled like the board's own.
    const connectors = new Connectors({ dataDir: dir, google: { builtIn: null } });
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', version: '9.8.7', connectors });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Planner`)));
    tools = (await client.listTools()).tools;
  });

  after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  it('reports the version Tricot was started with', () => {
    assert.deepEqual(client.getServerVersion(), { name: 'tricot', version: '9.8.7' });
  });

  it('registers each tool once', () => {
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.length > 30, `only ${names.length} tools`);
  });

  it('documents every tool in docs/mcp-tools.md', () => {
    const documented = documentedTools();
    assert.deepEqual(tools.map((t) => t.name).filter((name) => !documented.has(name)), [], 'tools missing from docs/mcp-tools.md');
    const registered = new Set(tools.map((t) => t.name));
    assert.deepEqual([...documented].filter((name) => !registered.has(name)), [], 'tools in docs/mcp-tools.md that the server does not have');
  });

  it('gives every tool a step label in the agents hooks', () => {
    // wait_for_updates and get_updates have none on purpose: presence already says the agent is listening.
    const quiet = new Set(['wait_for_updates', 'get_updates']);
    const unlabelled = tools
      .map((t) => t.name)
      .filter((name) => !quiet.has(name))
      .filter((name) => /^Using Tricot: /.test(hookStep({ hook_event_name: 'PreToolUse', tool_name: `mcp__tricot__${name}`, tool_input: {} })?.text ?? ''));
    assert.deepEqual(unlabelled, [], 'tools without a label in hooks/tricot-describe.mjs');
    for (const name of quiet) assert.equal(hookStep({ hook_event_name: 'PreToolUse', tool_name: `mcp__tricot__${name}`, tool_input: {} }), undefined);
  });

  // Every session carries every description, schema and the instructions: the
  // how-to is in the guide, read when needed. The budget is what an agent reads
  // on connecting, in characters (about four to a token).
  it('keeps what every session carries short, and the how-to in the guide', async () => {
    const long = tools.filter((t) => (t.description ?? '').length > MAX_DESCRIPTION).map((t) => `${t.name}: ${t.description!.length}`);
    assert.deepEqual(long, [], `descriptions over ${MAX_DESCRIPTION} characters`);
    const carried = INSTRUCTIONS.length + tools.reduce((sum, t) => sum + (t.description ?? '').length + JSON.stringify(t.inputSchema).length, 0);
    assert.ok(carried <= 48_000, `${carried} characters on connecting`);
    assert.ok(tools.every((t) => !JSON.stringify(t.inputSchema).includes('$schema')), 'no schema dialect');
    assert.ok(tools.every((t) => !JSON.stringify(t.inputSchema).includes(String(Number.MAX_SAFE_INTEGER))), 'no safe-integer bounds');
  });

  it('gives each topic of the guide, and points each tool with a part in it there', async () => {
    const guide = tools.find((t) => t.name === 'read_guide')!;
    assert.deepEqual(guide.annotations, { readOnlyHint: true });
    for (const topic of GUIDE_TOPICS) {
      assert.match(guide.description ?? '', new RegExp(`${topic} \\(`), `read_guide lists ${topic}`);
      const text = await readGuide(client, topic);
      assert.ok(text.startsWith(`# Guide: ${topic}\n\n`), text.slice(0, 40));
      assert.ok(text.length > 400, `${topic} says something`);
      for (const [, name] of text.matchAll(/^## (\w+)$/gm)) {
        assert.match(tools.find((t) => t.name === name)!.description ?? '', new RegExp(`Guide: read_guide\\("${topic}"\\)\\.$`), name);
      }
    }
    for (const tool of tools) {
      const pointer = (tool.description ?? '').match(/Guide: read_guide\("(\w+)"\)\.$/);
      if (pointer) assert.match(await readGuide(client, pointer[1]), new RegExp(`^## ${tool.name}$`, 'm'), tool.name);
    }
    const refused = (await client.callTool({ name: 'read_guide', arguments: { topic: 'everything' } })) as { isError?: boolean };
    assert.equal(refused.isError, true);
  });

  it("checks a decision's blocks against add_block's fields, though it lists only their type", async () => {
    const blocks = (tools.find((t) => t.name === 'post_decision')!.inputSchema.properties as Record<string, { items: { properties: object } }>).blocks;
    assert.deepEqual(Object.keys(blocks.items.properties).sort(), ['group', 'option', 'title', 'type']);
    const board = store.createBoard({ title: 'Blocks' }, { name: 'Sam', kind: 'human' });
    const post = async (block: Record<string, unknown>) =>
      (await client.callTool({ name: 'post_decision', arguments: { board_id: board.id, question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], blocks: [block] } })) as { isError?: boolean; content: { text: string }[] };
    const bad = await post({ type: 'note', text: 3 });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /blocks\[0\]\.text must be a string\./);
    const chart = await post({ type: 'chart', kind: 'donut', columns: ['a', 'b'], rows: [['x', 1]] });
    assert.match(chart.content[0].text, /blocks\[0\]\.kind must be one of: bar, line, area, stacked-bar, pie\./);
    const good = await post({ type: 'note', text: 'Hello', option: 'a' });
    assert.ok(!good.isError, good.content[0].text);
    assert.match(good.content[0].text, /with 1 block on its canvas/);
  });

  it('marks what reads and what removes, and nothing else', () => {
    const hints = (name: string) => tools.find((t) => t.name === name)?.annotations;
    assert.deepEqual(hints('get_board'), { readOnlyHint: true });
    assert.deepEqual(hints('list_boards'), { readOnlyHint: true });
    assert.deepEqual(hints('remove_item'), { destructiveHint: true });
    assert.equal(hints('post_decision'), undefined);
  });
});
