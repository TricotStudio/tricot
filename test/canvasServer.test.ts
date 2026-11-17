import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { partsOf, type BoardInfo } from '../src/core/protocol';
import { canvasEdition } from '../src/server/canvasEdition';
import { startServer, type RunningServer } from '../src/server/start';
import { removeScratch } from './platform';

// Tricot Canvas on the server: the same server made of less. canvasEdition() builds the
// registries a part's server fills empty (no REST part, no group of tools, no kind of card), startServer takes
// them (as src/server/canvas.ts hands them), and it serves the Canvas page's folder. What a part's server
// has that Canvas does not, side by side, is in its counterpart of this file.

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

describe('Tricot Canvas, started as the entry starts it', () => {
  const scratch: string[] = [];
  const running: RunningServer[] = [];

  afterEach(async () => {
    for (const server of running.splice(0)) await server.close();
    for (const dir of scratch.splice(0)) removeScratch(dir);
  });

  // A server over a data folder and a built page folder of its own, Canvas's.
  async function start(): Promise<RunningServer> {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tricot-canvas-start-'));
    const webDir = mkdtempSync(path.join(os.tmpdir(), 'tricot-canvas-web-'));
    scratch.push(dataDir, webDir);
    writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>Canvas page</title>');
    const server = await startServer({ port: await freePort(), dataDir, webDir, version: '9.8.7', ...canvasEdition() });
    running.push(server);
    return server;
  }

  it('serves the Canvas folder, lists no part in /api/info, and answers a route it does not have with the plain 404', async () => {
    const server = await start();
    const page = await fetch(`${server.url}/`);
    assert.match(await page.text(), /<title>Canvas page<\/title>/, "the folder it is given, which the entry sets to dist/canvas");
    const info = (await (await fetch(`${server.url}/api/info`)).json()) as BoardInfo;
    assert.deepEqual(info.parts, []);
    assert.deepEqual(partsOf(info), [], 'a command or the page knows it is Canvas, and not an older Tricot that said nothing');
    for (const address of ['/api/decisions/anything/links', '/api/not-a-route-of-tricot']) {
      const answer = await fetch(`${server.url}${address}`);
      assert.equal(answer.status, 404, address);
      assert.deepEqual(await answer.json(), { error: 'Not found' }, address);
    }
    const core = await fetch(`${server.url}/api/boards`);
    assert.equal(core.status, 200, "and the core's own routes are served");
  });

  it("lists the board's 26 tools over MCP, and none for a card", async () => {
    const server = await start();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.mcpUrl}?agent=Planner`)));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      assert.equal(names.length, 26 + 7, "the board's 26, and the connectors' 7, which the server gives every app");
      assert.deepEqual(['post_decision', 'plan_tasks', 'claim_task', 'get_task', 'get_decision', 'update_task', 'pin'].filter((name) => names.includes(name)), [], "none of the decisions' and tasks' tools");
      assert.ok(['get_board', 'start_thread', 'reply_in_thread', 'add_block'].every((name) => names.includes(name)));
    } finally {
      await client.close();
    }
  });
});
