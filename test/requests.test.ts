import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { needsInput } from '../src/core/attention';
import { boardDigest, canvasDigest } from '../src/core/digest';
import {
  KEPT_REQUESTS,
  STARTERS,
  cancelRefusal,
  finishRefusal,
  keptRequests,
  requestTitle,
  requestsDigest,
  takeRefusal,
} from '../src/core/requests';
import { Store } from '../src/core/store';
import type { Actor, Board, ContextRequest } from '../src/core/types';
import { eventsOf } from './tables';
import { removeScratch } from './platform';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };
const wassim: Actor = { kind: 'human', name: 'Wassim' };
const sam: Actor = { kind: 'human', name: 'Sam' };

describe('Titles for what people ask agents', () => {
  it('drops the asking and keeps what is wanted', () => {
    assert.equal(requestTitle('Get me an architecture view of the project'), 'Architecture view');
    assert.equal(requestTitle('Can you please draw the data model?'), 'Data model');
    assert.equal(requestTitle('Hey, could you summarize the decisions so far for me?'), 'Decisions so far');
    assert.equal(requestTitle('I would like to see a comparison of the tools'), 'Comparison of the tools');
    assert.equal(requestTitle('Make a list of all endpoints'), 'List of all endpoints', 'one verb, then one article');
    assert.equal(requestTitle('Give us an overview of this app.'), 'Overview');
    assert.equal(requestTitle('Explain how sync works. Include the edge cases.'), 'How sync works', 'the first sentence');
    assert.equal(requestTitle('  show   me what\nchanged this week '), 'What changed this week');
    assert.equal(requestTitle('Lists of things'), 'Lists of things', 'only whole words are asking');
  });

  it('keeps words that are all asking, and clips long ones at a word', () => {
    assert.equal(requestTitle('please'), 'Please');
    assert.equal(requestTitle('Get me'), 'Get me');
    const long = requestTitle('A comparison of the MCP tools and the REST routes, with which ones people use most');
    assert.equal(long, 'Comparison of the MCP tools and the REST…');
    assert.ok(long.length <= 48);
  });

  it('titles each starter as its label', () => {
    for (const starter of STARTERS) assert.equal(requestTitle(starter.text), starter.label);
  });
});

describe('Request lifecycle rules', () => {
  const board = { canvas: { groups: [{ id: 'g1', title: 'Modules' }] } } as unknown as Board;
  const request = (patch: Partial<ContextRequest>): ContextRequest => ({
    id: 'r1',
    text: 'Get me an architecture view of the project',
    by: wassim,
    at: '2026-10-30T10:00:00.000Z',
    status: 'open',
    ...patch,
  });

  it('lets agents take an open request, and the one who took it take it again', () => {
    assert.equal(takeRefusal(board, request({}), claude), undefined);
    assert.match(takeRefusal(board, request({}), wassim)!, /Only agents take a request/);
    const working = request({ status: 'working', takenBy: claude, groupId: 'g1' });
    assert.equal(takeRefusal(board, working, claude), undefined);
    assert.equal(takeRefusal(board, working, codex), `Claude already took "Modules": it's theirs to finish.`, 'named by its group');
    assert.match(takeRefusal(board, request({ status: 'done', takenBy: claude }), codex)!, /"Architecture view" is done: Claude finished it/);
    assert.match(takeRefusal(board, request({ status: 'cancelled' }), claude)!, /Wassim's request "Architecture view" was cancelled/);
  });

  it('lets only the agent who took a request finish it', () => {
    const working = request({ status: 'working', takenBy: claude, groupId: 'g1' });
    assert.equal(finishRefusal(board, working, claude), undefined);
    assert.match(finishRefusal(board, working, codex)!, /Claude took "Modules", so only they finish it/);
    assert.match(finishRefusal(board, working, wassim)!, /Only the agent who took a request finishes it/);
    assert.match(finishRefusal(board, request({}), claude)!, /Nobody has taken "Architecture view" yet: take it with take_request/);
    assert.match(finishRefusal(board, request({ status: 'done', takenBy: claude }), claude)!, /already done/);
    assert.match(finishRefusal(board, request({ status: 'cancelled' }), claude)!, /was cancelled, so there's nothing to finish/);
  });

  it('lets only people cancel', () => {
    assert.equal(cancelRefusal(sam), undefined);
    assert.match(cancelRefusal(claude)!, /Only people cancel a request; finish it with finish_request instead/);
  });

  it('keeps every open or working request, and the latest others', () => {
    const many = Array.from({ length: KEPT_REQUESTS + 3 }, (_, i) =>
      request({ id: `r${i}`, status: i === 0 ? 'working' : i === 1 ? 'open' : i % 2 ? 'done' : 'cancelled' }),
    );
    const kept = keptRequests(many);
    assert.equal(kept.length, KEPT_REQUESTS);
    assert.deepEqual(kept.slice(0, 3).map((r) => r.id), ['r0', 'r1', 'r5'], 'the three oldest finished ones go');
    assert.equal(keptRequests(many.slice(0, 5)).length, 5);
    const open = Array.from({ length: KEPT_REQUESTS + 2 }, (_, i) => request({ id: `o${i}` }));
    assert.equal(keptRequests(open).length, KEPT_REQUESTS + 2, 'open ones are never dropped');
  });
});

describe('People asking agents on the board context', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  const board = () => store.getBoard(boardId);
  const lastSummary = () => eventsOf(store, board()).at(-1)!.summary;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-requests-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Tricot' }, wassim).id;
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  it('takes a request from a person, and shows it to agents until one takes it', () => {
    assert.throws(() => store.askAgents(boardId, '   ', wassim), /A request must not be empty/);
    assert.throws(() => store.askAgents(boardId, 'x'.repeat(501), wassim), /A request is too long \(max 500 characters\)/);
    assert.throws(() => store.askAgents(boardId, 'Diagram it', claude), /Only people ask agents on the board context/);

    const request = store.askAgents(boardId, '  Get me an architecture view\n of the project ', wassim);
    assert.equal(request.text, 'Get me an architecture view of the project');
    assert.equal(request.status, 'open');
    assert.deepEqual(request.by, wassim);
    assert.deepEqual(board().requests, [request]);
    const event = eventsOf(store, board()).at(-1)!;
    assert.equal(event.type, 'request_asked');
    assert.equal(event.itemId, request.id, 'leads to the board context');
    assert.equal(lastSummary(), 'asked agents: "Get me an architecture view of the project"');
    const line = `Wassim asked agents on the board context [request id: ${request.id}]: "Get me an architecture view of the project". Take it with take_request, build the answer as blocks in its group, then finish_request with a one-line note.`;
    assert.equal(requestsDigest(board()), line);
    assert.ok(boardDigest(board()).includes(`\n${line}\n`));
  });

  it('makes a group titled from the request when an agent takes it, and only the taker finishes it', () => {
    const { id } = store.askAgents(boardId, 'Get me an architecture view of the project', wassim);
    assert.throws(() => store.takeRequest(id, wassim), /Only agents take a request/);
    assert.throws(() => store.finishRequest(id, 'Done', claude), /Nobody has taken "Architecture view" yet/);
    assert.throws(() => store.takeRequest('nope', claude), /No request "nope"/);

    const { request, group } = store.takeRequest(id, claude);
    assert.equal(request.status, 'working');
    assert.deepEqual(request.takenBy, claude);
    assert.equal(group!.title, 'Architecture view');
    assert.equal(request.groupId, group!.id);
    assert.deepEqual(board().canvas.groups, [group]);
    assert.equal(lastSummary(), `took Wassim's request "Get me an architecture view of the project", answering in group "Architecture view"`);
    const seq = board().seq;
    assert.equal(store.takeRequest(id, claude).group, group, 'taking it again gives the same group');
    assert.equal(board().seq, seq);
    assert.throws(() => store.takeRequest(id, codex), /Claude already took "Architecture view": it's theirs to finish/);
    assert.match(requestsDigest(board())!, new RegExp(`Claude is answering Wassim's request \\[request id: ${id}\\] .+ in group "Architecture view" \\[group id: ${group!.id}\\]`));
    const { canvas } = store.getCanvas({ boardId });
    assert.match(canvasDigest(board(), canvas), new RegExp(`## Group "Architecture view" \\[id: ${group!.id}\\] · answers Wassim's request \\[request id: ${id}\\] ".+", taken by Claude`));

    assert.throws(() => store.finishRequest(id, 'Done', claude), /Group "Architecture view" is empty: add your answer there first \(add_block with board_id: \S+ and group_id: \S+\)/);
    const block = store.addBlock({ boardId }, { content: { type: 'diagram', source: 'flowchart LR\n  core --> server' }, groupId: group!.id }, claude);
    assert.equal(block.groupId, group!.id);
    assert.throws(() => store.finishRequest(id, 'Done', codex), /Claude took "Architecture view", so only they finish it/);
    assert.throws(() => store.finishRequest(id, ' ', claude), /A note must not be empty/);
    const done = store.finishRequest(id, 'A module diagram, with how REST and MCP reach the store', claude);
    assert.equal(done.status, 'done');
    assert.equal(done.note, 'A module diagram, with how REST and MCP reach the store');
    assert.ok(Date.parse(done.doneAt!));
    assert.equal(lastSummary(), `finished Wassim's request "Get me an architecture view of the project": "A module diagram, with how REST and MCP reach the store"`);
    assert.equal(requestsDigest(board()), undefined, 'nothing left for agents');
    assert.throws(() => store.finishRequest(id, 'Again', claude), /already done/);
    assert.throws(() => store.takeRequest(id, codex), /is done: Claude finished it/);

    // The person who asked hears it's done; others don't need to.
    const finished = eventsOf(store, board()).at(-1)!;
    assert.equal(needsInput(finished, board(), 'Wassim'), true);
    assert.equal(needsInput(finished, board(), 'Sam'), false);
  });

  it('names the group as the agent says', () => {
    const { id } = store.askAgents(boardId, "What's left to build?", wassim);
    assert.equal(store.takeRequest(id, claude, 'Left to build, by area').group!.title, 'Left to build, by area');
    assert.equal(store.takeRequest(store.askAgents(boardId, 'Risks?', wassim).id, claude, '  ').group!.title, 'Risks');
  });

  it('lets people cancel an open or working request, and agents not', () => {
    const open = store.askAgents(boardId, 'List the risks and open questions', wassim);
    assert.throws(() => store.cancelRequest(open.id, claude), /Only people cancel a request/);
    store.cancelRequest(open.id, wassim);
    assert.equal(open.status, 'cancelled');
    assert.ok(open.doneAt);
    assert.equal(lastSummary(), 'cancelled asking agents: "List the risks and open questions"');
    assert.throws(() => store.takeRequest(open.id, claude), /was cancelled, so there's nothing to take/);
    const seq = board().seq;
    store.cancelRequest(open.id, sam);
    assert.equal(board().seq, seq, "one that's over stays as it is");

    const working = store.askAgents(boardId, 'Draw a timeline of the project so far', wassim);
    const { group } = store.takeRequest(working.id, claude);
    store.cancelRequest(working.id, sam);
    assert.equal(lastSummary(), `cancelled Wassim's request: "Draw a timeline of the project so far", which Claude was answering`);
    assert.ok(board().canvas.groups.includes(group!), 'its group stays');
    assert.throws(() => store.finishRequest(working.id, 'Done', claude), /cancelled, so there's nothing to finish\. What you added stays in its group/);
    assert.throws(() => store.cancelRequest(working.id, wassim, 'another-board'), /No board with id "another-board"/);

    store.setArchived(boardId, true, wassim);
    assert.throws(() => store.askAgents(boardId, 'Anything', wassim), /read-only/);
  });

  it("lets the agent answering a request add to its group during someone's sync of selected blocks", () => {
    const status = store.addBlock({ boardId }, { title: 'Status', content: { type: 'note', text: 'T44 open' } }, claude);
    const { id } = store.askAgents(boardId, 'Get me an architecture view of the project', wassim);
    const { group } = store.takeRequest(id, claude);
    store.requestSync(boardId, [status.id], sam);
    const block = store.addBlock({ boardId }, { content: { type: 'note', text: 'core, server, web' }, groupId: group!.id }, claude);
    store.updateBlock(block.id, { text: 'core, server, web, connectors' }, claude);
    assert.throws(
      () => store.addBlock({ boardId }, { content: { type: 'note', text: 'Elsewhere' } }, claude),
      /can't add blocks to the board context until it's finished/,
    );
    assert.throws(
      () => store.addBlock({ boardId }, { content: { type: 'note', text: 'Not mine' }, groupId: group!.id }, codex),
      /can't add blocks to the board context until it's finished/,
      'only for the agent who took it',
    );
  });

  it('keeps the last few requests, and survives a reload', async () => {
    for (let i = 0; i < KEPT_REQUESTS + 4; i++) {
      const { id } = store.askAgents(boardId, `Question ${i}`, wassim);
      if (i > 0) store.cancelRequest(id, wassim);
    }
    const kept = board().requests!;
    assert.equal(kept.length, KEPT_REQUESTS);
    assert.equal(kept[0].text, 'Question 0', 'the open one stays');
    assert.equal(kept[1].text, 'Question 5');
    await store.flush();
    const reloaded = new Store(dir);
    reloaded.load();
    assert.deepEqual(reloaded.getBoard(boardId).requests, kept);
    assert.equal(reloaded.getRequest(kept[0].id).request.status, 'open');
  });
});
