import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
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

  // The live steps hook (hooks/tricot-describe.mjs) as a package without a part has it: copied alone into a folder, where the
  // part's own labels file (tricot-labels.json) is only there when the test puts it.
  const hookIn = async (name: string, labels?: string) => {
    const folder = path.join(dir, name);
    mkdirSync(folder, { recursive: true });
    copyFileSync(path.join(import.meta.dirname, '..', 'hooks', 'tricot-describe.mjs'), path.join(folder, 'tricot-describe.mjs'));
    if (labels !== undefined) writeFileSync(path.join(folder, 'tricot-labels.json'), labels);
    const { describe: step } = await import(pathToFileURL(path.join(folder, 'tricot-describe.mjs')).href);
    return (tool: string, input: object = {}, labels?: object) =>
      step({ hook_event_name: 'PreToolUse', tool_name: `mcp__tricot__${tool}`, tool_input: input }, labels && { labels }) as { text: string } | undefined;
  };

  it("puts each tool it lists in words in a live step, a part's tools in the part's own file if it has one", async () => {
    const plain = await hookIn('hook-plain');
    const quiet = ['get_updates', 'wait_for_updates'];
    for (const { name } of tools) {
      if (quiet.includes(name)) assert.equal(plain(name), undefined, `${name} says nothing`);
      else assert.ok(!plain(name)!.text.startsWith('Using Tricot:'), `${name} needs a step label in hooks/tricot-describe.mjs`);
    }
    const generic = { text: 'Using Tricot: claim work' };
    assert.deepEqual(plain('claim_work', { work_id: 'w_1' }), generic, 'a tool the hook does not know reads as any other, with no card named');
    const labelled = await hookIn('hook-labelled', JSON.stringify({ tools: { claim_work: 'Claiming the work', bad: 5 }, cards: { work_id: 'work' } }));
    assert.deepEqual(labelled('claim_work', { work_id: 'w_1', thread_id: 'th_1' }), { text: 'Claiming the work', work: 'w_1', thread: 'th_1' });
    assert.equal(labelled('bad')!.text, 'Using Tricot: bad', 'a label that is not words is left out');
    assert.equal(labelled('comment')!.text, plain('comment')!.text, "a part's file does not say the board's own tools");
    assert.deepEqual((await hookIn('hook-broken', '{ not json'))('claim_work'), generic, 'a file that cannot be read is as none');
    // The server does not run beside the file: it says the same words from its tool groups' (ToolGroup.stepLabels), and only those.
    const given = { tools: { claim_work: 'Claiming the work' }, cards: { work_id: 'work' } };
    assert.deepEqual(plain('claim_work', { work_id: 'w_1' }, given), { text: 'Claiming the work', work: 'w_1' });
    assert.deepEqual(labelled('claim_work', {}, {}), generic, 'none given, none said, whatever the file has');
  });

  it('marks what reads and what removes, and nothing else', () => {
    const hints = (name: string) => tools.find((t) => t.name === name)?.annotations;
    assert.deepEqual(hints('get_board'), { readOnlyHint: true });
    assert.deepEqual(hints('list_boards'), { readOnlyHint: true });
    assert.deepEqual(hints('remove_item'), { destructiveHint: true });
    assert.equal(hints('comment'), undefined);
  });
});
