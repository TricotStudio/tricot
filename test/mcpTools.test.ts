import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Connectors } from '../src/server/connectors';
import { canvasServer, type CanvasServer } from './canvasEdition';
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
  let canvas: CanvasServer;
  let client: Client;
  let tools: Listed;

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-mcp-tools-'));
    // With the connectors, so the tools they add are listed, documented and labelled like the board's own.
    canvas = await canvasServer({ connectors: new Connectors({ dataDir: dir, google: { builtIn: null } }) }, dir);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${canvas.base}/mcp?agent=Planner`)));
    tools = (await client.listTools()).tools;
  });

  after(async () => {
    await client.close();
    await canvas.stop();
    removeScratch(dir);
  });

  it('registers each tool once', () => {
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.length > 30, `only ${names.length} tools`);
  });

  it('documents every tool it lists in docs/mcp-tools.md', () => {
    const documented = documentedTools();
    assert.deepEqual(tools.map((t) => t.name).filter((name) => !documented.has(name)), [], 'tools missing from docs/mcp-tools.md');
  });

  it('gives each topic of the guide, and points each tool with a part in it there', async () => {
    const guide = tools.find((t) => t.name === 'read_guide')!;
    assert.deepEqual(guide.annotations, { readOnlyHint: true });
    for (const topic of (guide.inputSchema.properties?.topic as { enum: string[] }).enum) {
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

  it('marks what reads and what removes, and nothing else', () => {
    const hints = (name: string) => tools.find((t) => t.name === name)?.annotations;
    assert.deepEqual(hints('get_board'), { readOnlyHint: true });
    assert.deepEqual(hints('list_boards'), { readOnlyHint: true });
    assert.deepEqual(hints('remove_item'), { destructiveHint: true });
    assert.equal(hints('comment'), undefined);
  });
});
