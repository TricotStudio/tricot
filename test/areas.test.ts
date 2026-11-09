import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boardAreas } from '../src/core/areas';
import { boardDigest, decisionDetail } from '../src/core/digest';
import { BoardError, Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import { createApp } from '../src/server/app';
import { eventsOf } from './tables';
import { readGuide } from './guide';
import { removeScratch } from './platform';

const agent: Actor = { kind: 'agent', name: 'Claude' };
const human: Actor = { kind: 'human', name: 'Wassim' };

describe('Areas in the store', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-areas-'));
    store = new Store(dir);
    store.load();
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  it('stores an area trimmed, on one line, in the spelling the board already uses', () => {
    const board = store.createBoard({ title: 'B' }, human);
    const first = store.postDecision(board.id, { question: 'Q1?', area: '  Name   and\nmark ' }, agent);
    assert.equal(first.area, 'Name and mark');
    assert.equal(first.areaPerson, undefined, "an agent's area is open to change");
    const second = store.postDecision(board.id, { question: 'Q2?', area: 'name and MARK' }, agent);
    assert.equal(second.area, 'Name and mark');
    const none = store.postDecision(board.id, { question: 'Q3?', area: '   ' }, agent);
    assert.equal(none.area, undefined);
    assert.ok(!('area' in none), 'no empty key is saved');
    assert.throws(() => store.postDecision(board.id, { question: 'Q4?', area: 'x'.repeat(61) }, agent), /too long \(max 60/);
    assert.deepEqual(boardAreas(store.getBoard(board.id)), [{ name: 'Name and mark', count: 2 }]);
  });

  it("logs a change of area, without counting it as a change to the card", () => {
    const board = store.createBoard({ title: 'B' }, human);
    const decision = store.postDecision(board.id, { question: 'Which connector first?' }, agent);
    const updatedAt = (decision.updatedAt = '2026-10-01T00:00:00.000Z');
    store.updateDecision(decision.id, { area: 'Connectors' }, agent);
    store.updateDecision(decision.id, { area: 'Sync' }, agent);
    assert.equal(decision.area, 'Sync');
    assert.equal(decision.updatedAt, updatedAt, "order and ages on the board don't move");
    const events = eventsOf(store, board.id).filter((e) => e.type === 'decision_updated');
    assert.deepEqual(
      events.map((e) => e.summary),
      [
        'updated #1 "Which connector first?": area "Connectors"',
        'updated #1 "Which connector first?": area "Sync" (was "Connectors")',
      ],
    );
    // Along with another change, the card does change.
    store.updateDecision(decision.id, { area: 'Connectors', blocking: true }, agent);
    assert.notEqual(decision.updatedAt, updatedAt);
    assert.throws(() => store.updateDecision(decision.id, { area: 'connectors' }, agent), /Nothing to update/);
  });

  it("lets agents file settled cards, but never change or clear a person's area", () => {
    const board = store.createBoard({ title: 'B' }, human);
    const decision = store.postDecision(board.id, { question: 'Which mark?', options: [{ label: 'Wordmark' }] }, agent);
    store.resolve(decision.id, { optionId: 'a' }, human);
    // A person decided it, yet filing it is not rewording it.
    store.updateDecision(decision.id, { area: 'Branding' }, agent);
    assert.equal(decision.area, 'Branding');

    store.updateDecision(decision.id, { area: 'Name and mark' }, human);
    assert.deepEqual(decision.areaPerson, human);
    assert.throws(() => store.updateDecision(decision.id, { area: 'Branding' }, agent), (error: Error) => {
      assert.ok(error instanceof BoardError);
      assert.match(error.message, /Wassim put #1 "Which mark\?" in the area "Name and mark", so agents can't change it/);
      return true;
    });
    assert.throws(() => store.updateDecision(decision.id, { area: '' }, agent), /agents can't change it/);
    // Nor along with another change: nothing is applied.
    assert.throws(() => store.updateDecision(decision.id, { area: 'Branding', blocking: true }, agent), /agents can't change it/);
    assert.equal(decision.blocking, false);
    // The same area in another case is no change at all.
    assert.throws(() => store.updateDecision(decision.id, { area: 'name and mark' }, agent), /Nothing to update/);
    assert.equal(decision.area, 'Name and mark');

    // A person clearing it gives it back to everyone.
    store.updateDecision(decision.id, { area: '' }, human);
    assert.equal(decision.area, undefined);
    assert.equal(decision.areaPerson, undefined);
    store.updateDecision(decision.id, { area: 'Branding' }, agent);
    assert.equal(decision.area, 'Branding');
  });

  it("marks an area a person gives a new card as theirs", () => {
    const board = store.createBoard({ title: 'B' }, human);
    const decision = store.postDecision(board.id, { question: 'Q?', area: 'Shipping' }, human);
    assert.deepEqual(decision.areaPerson, human);
    assert.throws(() => store.updateDecision(decision.id, { area: 'Other' }, agent), /agents can't change it/);
  });

  it('loads boards saved before areas existed, unchanged', async () => {
    const board = store.createBoard({ title: 'Old' }, human);
    store.postDecision(board.id, { question: 'Q?' }, agent);
    await store.flush();
    const reloaded = new Store(dir);
    reloaded.load();
    const decision = reloaded.getBoard(board.id).decisions[0];
    assert.equal(decision.area, undefined);
    assert.match(boardDigest(reloaded.getBoard(board.id)), /Areas: none yet/);
  });

  it('shows agents the board\'s areas, and whose an area is', () => {
    const board = store.createBoard({ title: 'B' }, human);
    store.postDecision(board.id, { question: 'Q1?', area: 'Connectors' }, agent);
    store.postDecision(board.id, { question: 'Q2?', area: 'Connectors' }, agent);
    const mine = store.postDecision(board.id, { question: 'Q3?', area: 'Shipping' }, human);
    store.postDecision(board.id, { question: 'Q4?' }, agent);
    const digest = boardDigest(store.getBoard(board.id));
    assert.match(digest, /^Areas: Connectors \(2\), Shipping \(1\); 1 decision has none yet\. Reuse one when it fits\.$/m);
    assert.match(digest, /#3 \[id: \w+\] Q3\? \(area: Shipping\)/);
    assert.match(decisionDetail(store.getBoard(board.id), mine), /^Area: Shipping \(set by Wassim, so it's theirs: leave it\)$/m);
  });
});

describe('Areas over MCP and REST', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let client: Client;
  let store: Store;
  const old = { board: '', decision: '' };

  type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const callText = async (name: string, args: Record<string, unknown>) => {
    const result = await call(name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content[0].text;
  };
  const post = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-areas-e2e-'));
    // A board whose decision has no area, as one saved before areas existed, read back from disk.
    const earlier = new Store(dir);
    earlier.load();
    old.board = earlier.createBoard({ title: 'Old board' }, human).id;
    old.decision = earlier.postDecision(old.board, { question: 'Old question?' }, agent).id;
    await earlier.flush();
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: 'areas-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
  });

  after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  it('tells agents to give decisions areas, and describes the field', async () => {
    assert.match(client.getInstructions() ?? '', /Each open question is one decision card \(post_decision\): .+ and a short area \(theme\), reusing the board's areas\./);
    const { tools } = await client.listTools();
    assert.match(tools.find((t) => t.name === 'post_decision')!.description ?? '', /and an area \(theme\)/);
    assert.match(await readGuide(client, 'decisions'), /Give it an area \(theme\) so it joins the right row on the decision map\./);
    for (const name of ['post_decision', 'update_decision', 'log_decision']) {
      const tool = tools.find((t) => t.name === name)!;
      const area = (tool.inputSchema.properties as Record<string, { description?: string }>).area;
      assert.ok(area, `${name} takes an area`);
      assert.match(area.description ?? '', /reuse one of the board's areas/);
    }
  });

  it('reads an old board without areas as it was', async () => {
    const text = await callText('get_board', { board_id: old.board });
    assert.match(text, new RegExp(`^- #1 \\[id: ${old.decision}\\] Old question\\?$`, 'm'));
    assert.match(text, /Areas: none yet/);
  });

  it('sets areas from MCP and REST, and keeps a person\'s from agents', async () => {
    const created = await callText('create_board', { title: 'Areas' });
    const boardId = created.match(/\[id: ([^\]]+)\]/)![1];
    const posted = await callText('post_decision', { board_id: boardId, question: 'Which connector first?', area: 'Connectors' });
    const id = posted.match(/\[id: ([^\]]+)\]/)![1];
    await callText('log_decision', { board_id: boardId, question: 'Sync on save?', choice: 'Yes', rationale: 'Simplest', area: 'connectors' });
    const refused = await call('log_decision', { decision_id: id, choice: 'a', rationale: 'r', area: 'Other' });
    assert.ok(refused.isError);
    assert.match(refused.content[0].text, /area is for a new card/);

    const board = await callText('get_board', { board_id: boardId });
    assert.match(board, /^Areas: Connectors \(2\)\. Reuse one when it fits\.$/m);
    assert.match(board, /Which connector first\? \(area: Connectors\)/);

    // A person moves it over REST; it is theirs from then on.
    const moved = await post(`/decisions/${id}/area`, { actor: 'Wassim', area: '  Integrations ' });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.area, 'Integrations');
    assert.deepEqual(moved.json.areaPerson, { kind: 'human', name: 'Wassim' });
    assert.match(await callText('get_decision', { decision_id: id }), /^Area: Integrations \(set by Wassim, so it's theirs: leave it\)$/m);

    const overwrite = await call('update_decision', { decision_id: id, area: 'Connectors' });
    assert.ok(overwrite.isError);
    assert.match(overwrite.content[0].text, /Wassim put #1 "Which connector first\?" in the area "Integrations", so agents can't change it/);
    const cleared = await call('update_decision', { decision_id: id, area: '' });
    assert.ok(cleared.isError);
    assert.equal(store.getDecision(id).decision.area, 'Integrations');

    // People post with an area too, and the change shows in the activity.
    const asked = await post(`/boards/${boardId}/decisions`, { actor: 'Wassim', question: 'Rename the tab?', area: 'Views' });
    assert.equal(asked.status, 201);
    assert.equal(asked.json.area, 'Views');
    const events = eventsOf(store, boardId).map((e) => `${e.actor.name}: ${e.summary}`);
    assert.ok(events.includes('Wassim: updated #1 "Which connector first?": area "Integrations" (was "Connectors")'));

    // Bad input is refused like any other field.
    const long = await post(`/decisions/${id}/area`, { actor: 'Wassim', area: 'x'.repeat(61) });
    assert.equal(long.status, 400);
    const anonymous = await post(`/decisions/${id}/area`, { area: 'Views' });
    assert.equal(anonymous.status, 400);
  });
});
