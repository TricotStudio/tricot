import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { couldAffect, mayChange, revisitNote } from '../src/core/affects';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
type Schema = { properties?: Record<string, Schema>; description?: string; items?: Schema; required?: string[] };

// An agent names the decisions a new one could affect over MCP, and reads them
// back in get_decision; a person answers it on the board, asks for the one it
// may change to be checked, and the agent answers that refresh.
// The person's browser, let in as one of their seats (seatHelper.ts): it signs what needs one.
let seat: TestSeat;

describe('What a decision could affect, over MCP and REST', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let client: Client;
  let store: Store;

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  }

  async function callText(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await call(name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content.map((c) => c.text).join('\n\n');
  }

  async function post(route: string, body: Record<string, unknown>) {
    const response = await fetch(`${base}/api${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign('POST', `/api${route}`, JSON.stringify({ actor: 'Wassim', ...body })) },
      body: JSON.stringify({ actor: 'Wassim', ...body }),
    });
    const json = await response.json();
    assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(json)}`);
    return json;
  }

  const idOf = (posted: string) => /\[id: (\w+)\]/.exec(posted)![1];

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-affects-mcp-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    seat = letIn(app);
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

  it('shows agents the field in post_decision and update_decision, and says what it is for', async () => {
    const { tools } = await client.listTools();
    for (const name of ['post_decision', 'update_decision']) {
      const schema = tools.find((t) => t.name === name)!.inputSchema as Schema;
      const affects = schema.properties!.affects!;
      assert.ok(affects.description, `${name} describes affects`);
      assert.deepEqual(Object.keys(affects.items!.properties!).sort(), ['decision_id', 'why']);
      assert.deepEqual(affects.items!.required?.sort(), ['decision_id', 'why']);
    }
    const postDecision = tools.find((t) => t.name === 'post_decision')!;
    assert.match(postDecision.description ?? '', /Name past decisions it could change or rests on with affects, each with why: people see them beside it\./);
    assert.match(tools.find((t) => t.name === 'get_decision')!.description ?? '', /the other decisions it could affect, to weigh when you recommend/);
  });

  it('takes the decisions an agent names, keeps them on the board, and lists them in get_decision', async () => {
    const boardId = (await post('/boards', { title: 'Launch' })).id as string;
    const tiers = idOf(
      await callText('post_decision', {
        board_id: boardId,
        question: 'Which pricing tiers do we offer?',
        options: [{ label: 'Free and Pro' }, { label: 'Per seat' }],
        recommend: 'b',
      }),
    );
    const site = idOf(await callText('post_decision', { board_id: boardId, question: 'What does the website promise?', options: [{ label: 'Open source' }, { label: 'Source available' }], recommend: 'a' }));
    await post(`/decisions/${tiers}/resolve`, { optionId: 'b' });
    await post(`/decisions/${site}/resolve`, { optionId: 'a' });
    // Settled a while ago, before the question that may change them.
    for (const id of [tiers, site]) store.getDecision(id).decision.resolution!.at = new Date(Date.now() - 3_600_000).toISOString();

    const refused = await call('post_decision', { board_id: boardId, question: 'Q?', affects: [{ decision_id: 'nope', why: 'x' }] });
    assert.ok(refused.isError);
    assert.equal(refused.content[0].text, 'No decision "nope" on this board.');
    const blank = await call('post_decision', { board_id: boardId, question: 'Q?', affects: [{ decision_id: tiers, why: ' ' }] });
    assert.equal(blank.content[0].text, 'why must not be empty.');

    const licence = idOf(
      await callText('post_decision', {
        board_id: boardId,
        question: 'Which licence should the core ship under?',
        options: [{ label: 'MIT' }, { label: 'AGPL-3.0' }],
        recommend: 'b',
        affects: [{ decision_id: tiers, why: 'pricing assumes an open core' }],
      }),
    );
    const read = await callText('get_decision', { decision_id: licence });
    assert.match(read, new RegExp(`## Could affect\\n.+\\n- #1 \\[id: ${tiers}\\] Which pricing tiers do we offer\\? \\(decided: b\\) Per seat\\) — Claude: "pricing assumes an open core"`));
    assert.doesNotMatch(read, /#2 \[id: \w+\] What does the website promise/);

    // The board people get carries them too, as the panel reads them.
    const board = await (await fetch(`${base}/api/boards/${boardId}`)).json();
    const onBoard = board.decisions.find((d: { id: string }) => d.id === licence);
    assert.deepEqual(
      onBoard.affects.map((a: { decisionId: string; why: string; by: { name: string } }) => [a.decisionId, a.why, a.by.name]),
      [[tiers, 'pricing assumes an open core', 'Claude']],
    );

    // update_decision replaces the list, and the answer says so.
    const updated = await callText('update_decision', {
      decision_id: licence,
      affects: [
        { decision_id: tiers, why: 'pricing assumes an open core' },
        { decision_id: site, why: 'the site names the licence' },
      ],
    });
    assert.match(updated, /- #2 \[id: \w+\] What does the website promise\? \(decided: a\) Open source\) — Claude: "the site names the licence"/);
    const tooMany = await call('update_decision', { decision_id: licence, affects: Array.from({ length: 13 }, () => ({ decision_id: tiers, why: 'x' })) });
    assert.equal(tooMany.content[0].text, 'Name at most 12 decisions it could affect.');

    // A person answers it: both settled before it may change. They ask for #1 to be checked, never changing it.
    await post(`/decisions/${licence}/resolve`, { optionId: 'b' });
    const answered = store.getDecision(licence);
    const offered = mayChange(answered.decision, couldAffect(answered.board, answered.decision));
    assert.deepEqual(offered.map((a) => a.decision.number), [2, 1]);
    await post(`/decisions/${tiers}/refresh`, { note: revisitNote(answered.decision) });
    const asked = store.getDecision(tiers).decision;
    assert.equal(asked.status, 'decided');
    assert.equal(asked.refreshRequest?.text, '#3 was just decided: b) AGPL-3.0. It may change this one: check it still holds.');
    assert.deepEqual(mayChange(answered.decision, couldAffect(store.getBoard(boardId), answered.decision)).map((a) => a.decision.number), [2]);

    // The agent sees what is asked, checks it, and answers with a note; the card stays as decided.
    assert.match(await callText('get_decision', { decision_id: tiers }), /## Refresh requested\n.+\nIt is decided \(b\) Per seat\) and stays so/);
    const reworded = await call('update_decision', { decision_id: tiers, refreshed: true, note: 'Holds', question: 'Reworded?' });
    assert.match(reworded.content[0].text, /Wassim decided #1 .+ so agents can't reword it/);
    const checked = await callText('update_decision', { decision_id: tiers, refreshed: true, note: 'Still holds: Pro stays per seat under the AGPL.' });
    assert.match(checked, /^Re-checked #1, which stays decided; people see your note\./);
    assert.equal(store.getDecision(tiers).decision.resolution?.optionId, 'b');
    assert.equal(store.getDecision(tiers).decision.refreshRequest, undefined);
  });

  it('takes the ones a person picks after deciding as one request, which agents hear as one', async () => {
    const boardId = (await post('/boards', { title: 'Picker' })).id as string;
    const posted = async (question: string, extra: Record<string, unknown> = {}) =>
      idOf(await callText('post_decision', { board_id: boardId, question, options: [{ label: 'Yes' }, { label: 'No' }], ...extra }));
    const board = await posted('Which board should the agent join?');
    const install = await posted('How should people install Tricot?');
    for (const id of [board, install]) {
      await post(`/decisions/${id}/resolve`, { optionId: 'a' });
      store.getDecision(id).decision.resolution!.at = new Date(Date.now() - 3_600_000).toISOString();
    }
    const picker = await posted('Does the picker show on first run?', {
      affects: [
        { decision_id: board, why: 'the picker is how it joins' },
        { decision_id: install, why: 'first run follows the install' },
      ],
    });
    await post(`/decisions/${picker}/resolve`, { optionId: 'b' });
    const cursor = Number(/Cursor: (\d+)/.exec(await callText('get_board', { board_id: boardId }))![1]);

    const refused = await fetch(`${base}/api/decisions/${picker}/revisit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ actor: 'Wassim', decisionIds: [] }),
    });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /Pick at least one decision to check/);

    const waiting = callText('wait_for_updates', { board_id: boardId, since: cursor, timeout_seconds: 10 });
    await new Promise((r) => setTimeout(r, 100));
    const asked = await post(`/decisions/${picker}/revisit`, { decisionIds: [board, install] });
    assert.deepEqual(
      asked.map((d: { number: number; refreshRequest: { after: string } }) => [d.number, d.refreshRequest.after]),
      [
        [1, picker],
        [2, picker],
      ],
    );
    const updates = await waiting;
    const lines = updates.split('\n');
    // One event, then one line naming both, rather than a line each.
    assert.deepEqual(
      lines.filter((line) => /asked agents to check|asked you to check|Refresh requested/.test(line)),
      [
        `- (${cursor + 1}) Wassim (human) asked agents to check #1 and #2 still hold, after deciding #3 "Does the picker show on first run?": b) No [id: ${picker}]`,
        `Wassim asked you to check #1 [id: ${board}] and #2 [id: ${install}] still hold, after deciding #3 [id: ${picker}] (b) No), which may change them: re-check each against the board and the app as they are now (get_decision says how), then update_decision on each with refreshed: true and a note saying whether it holds.`,
      ],
    );
    assert.match(await callText('get_updates', { board_id: boardId, since: cursor }), /Wassim asked you to check #1 \[id: \w+\] and #2/);
    assert.match(await callText('get_board', { board_id: boardId }), /Wassim asked you to check #1 \[id: \w+\] and #2/);

    // Each is answered on its own card, as any refresh.
    for (const id of [board, install]) {
      assert.match(await callText('update_decision', { decision_id: id, refreshed: true, note: 'Still holds.' }), /^Re-checked #\d, which stays decided/);
    }
    assert.doesNotMatch(await callText('get_board', { board_id: boardId }), /asked you to check/);
  });
});
