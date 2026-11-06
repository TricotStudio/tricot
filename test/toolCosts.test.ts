import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { routes } from '../src/core/routes';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { resultSize, ToolCosts, type CostLine, type ToolCostsReport } from '../src/server/toolCosts';
import { removeScratch } from './platform';

// What each board tool call costs an agent (server/toolCosts.ts): the tally
// itself, then every call an agent makes over MCP counted as it was sent and
// answered, and shown at GET /api/tool-costs with nothing of what was said.

describe('The tally of tool costs', () => {
  it('counts calls, and the average, largest and total of inputs and results, in tokens of four characters', () => {
    const costs = new ToolCosts(() => Date.parse('2026-11-05T09:00:00Z'));
    costs.record('Planner', 'get_board', { input: 30, result: 4000 });
    costs.record('Planner', 'get_board', { input: 30, result: 2001 });
    costs.record('Builder', 'comment', { input: 401, result: 80, error: true });
    costs.record('builder', 'get_canvas', { input: 20, result: 100, images: 2 });
    const report = costs.report();
    assert.equal(report.since, '2026-11-05T09:00:00.000Z');
    assert.equal(report.charsPerToken, 4);
    assert.deepEqual(report.tools.map((t) => t.name), ['get_board', 'get_canvas', 'comment'], 'the costliest results first');
    assert.deepEqual(report.tools[0], {
      name: 'get_board',
      calls: 2,
      errors: 0,
      images: 0,
      input: { average: 8, largest: 8, total: 15 },
      result: { average: 750, largest: 1000, total: 1501 },
    });
    assert.deepEqual(report.tools[2], { name: 'comment', calls: 1, errors: 1, images: 0, input: { average: 100, largest: 101, total: 101 }, result: { average: 20, largest: 20, total: 20 } });
    // One agent whatever its case, under the name it first called with.
    assert.deepEqual(report.agents.map((a) => [a.name, a.calls, a.images, a.errors, a.result.total]), [
      ['Planner', 2, 0, 0, 1501],
      ['Builder', 2, 2, 1, 45],
    ]);
    assert.deepEqual(report.total, { calls: 4, errors: 1, images: 2, input: { average: 30, largest: 101, total: 121 }, result: { average: 386, largest: 1000, total: 1546 } });
  });

  it('starts empty', () => {
    const report = new ToolCosts().report();
    assert.deepEqual([report.tools, report.agents], [[], []]);
    assert.deepEqual(report.total, { calls: 0, errors: 0, images: 0, input: { average: 0, largest: 0, total: 0 }, result: { average: 0, largest: 0, total: 0 } });
  });

  it('sizes the text an agent reads, and counts the images it is shown', () => {
    const size = resultSize({
      content: [
        { type: 'text', text: 'abcd' },
        { type: 'image', data: 'x'.repeat(10_000), mimeType: 'image/png' },
        { type: 'text', text: 'efg' },
      ],
    });
    assert.deepEqual(size, { chars: 7, images: 1 });
  });

  it('records a call that throws by the message the agent is answered with', async () => {
    const costs = new ToolCosts();
    await assert.rejects(costs.measure('Planner', 'get_task', { task_id: 'nope' }, () => Promise.reject(new Error('No task "nope".'))), /No task/);
    const [line] = costs.report().tools;
    assert.equal(line.errors, 1);
    assert.equal(line.result.total, Math.ceil('No task "nope".'.length / 4));
    assert.equal(line.input.total, Math.ceil(JSON.stringify({ task_id: 'nope' }).length / 4));
  });
});

describe('Tool costs over MCP', () => {
  let dir: string;
  let server: Server;
  let base: string;
  const clients: Client[] = [];

  type Result = { content: { type: string; text?: string }[]; isError?: boolean };
  // What one agent sent and was answered, by tool, in characters: the test's own tally.
  const seen = new Map<string, { calls: number; input: number; result: number; largest: number; errors: number }>();

  async function connect(agent: string): Promise<(name: string, args?: Record<string, unknown>) => Promise<Result>> {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=${agent}`)));
    clients.push(client);
    return async (name, args = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as Result;
      const chars = result.content.reduce((sum, item) => sum + (item.text?.length ?? 0), 0);
      const tally = seen.get(name) ?? { calls: 0, input: 0, result: 0, largest: 0, errors: 0 };
      tally.calls += 1;
      tally.input += JSON.stringify(args).length;
      tally.result += chars;
      tally.largest = Math.max(tally.largest, chars);
      if (result.isError) tally.errors += 1;
      seen.set(name, tally);
      return result;
    };
  }

  const report = async (): Promise<ToolCostsReport> => {
    const response = await fetch(`${base}${routes.toolCosts.path}`);
    assert.equal(response.status, 200);
    return (await response.json()) as ToolCostsReport;
  };

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-costs-'));
    const store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    for (const client of clients) await client.close();
    server.closeAllConnections();
    server.close();
    removeScratch(dir);
  });

  it('measures every call each agent makes, as it was sent and answered, and keeps nothing of it', async () => {
    assert.deepEqual((await report()).tools, [], 'nothing before the first call');
    const planner = await connect('Planner');
    const builder = await connect('Builder');
    await planner('list_boards');
    const made = await planner('create_board', { title: 'Retry logic, secretly', goal: 'Make outbound calls resilient.' });
    const boardId = /\[id: ([^\]]+)\]/.exec(made.content[0].text!)![1];
    await planner('get_board', { board_id: boardId });
    await builder('get_board', { board_id: boardId }); // with the planner's news, unread
    await builder('search', { board_id: boardId, query: 'backoff jitter' });
    assert.ok((await builder('get_task', { task_id: 'no-such-task' })).isError, 'an error is a call too');

    const costs = await report();
    const tokens = (chars: number) => Math.ceil(chars / 4);
    for (const [name, tally] of seen) {
      const line = costs.tools.find((t) => t.name === name) as CostLine;
      assert.ok(line, name);
      assert.equal(line.calls, tally.calls, name);
      assert.equal(line.errors, tally.errors, name);
      assert.equal(line.input.total, tokens(tally.input), `${name}: what the agent sent`);
      assert.equal(line.result.total, tokens(tally.result), `${name}: what it was answered`);
      assert.equal(line.result.largest, tokens(tally.largest), name);
      assert.equal(line.result.average, Math.round(tally.result / tally.calls / 4), name);
    }
    assert.equal(costs.tools.length, seen.size, 'every tool called, and none other');
    assert.deepEqual(costs.agents.map((a) => a.name).sort(), ['Builder', 'Planner']);
    assert.equal(costs.agents.find((a) => a.name === 'Planner')!.calls, 3);
    assert.equal(costs.total.calls, [...seen.values()].reduce((sum, t) => sum + t.calls, 0));
    const text = JSON.stringify(costs);
    for (const said of ['secretly', 'resilient', 'backoff', 'no-such-task', boardId]) assert.ok(!text.includes(said), `keeps nothing of "${said}"`);
  });
});
