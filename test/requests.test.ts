import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  cancelRefusal,
  finishRefusal,
  requestsDigest,
} from '../src/core/requests';
import { Store } from '../src/core/store';
import type { Actor, Board, ContextRequest } from '../src/core/types';
import { eventsOf } from './tables';
import { removeScratch } from './platform';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };
const sam: Actor = { kind: 'human', name: 'Sam' };

describe('Request lifecycle rules', () => {
  const board = { canvas: { groups: [{ id: 'g1', title: 'Modules' }] } } as unknown as Board;
  const request = (patch: Partial<ContextRequest>): ContextRequest => ({
    id: 'r1',
    text: 'Get me an architecture view of the project',
    by: sam,
    at: '2026-10-30T10:00:00.000Z',
    status: 'open',
    ...patch,
  });

  it('lets only the agent who took a request finish it', () => {
    const working = request({ status: 'working', takenBy: claude, groupId: 'g1' });
    assert.equal(finishRefusal(board, working, claude), undefined);
    assert.match(finishRefusal(board, working, codex)!, /Claude took "Modules", so only they finish it/);
    assert.match(finishRefusal(board, working, sam)!, /Only the agent who took a request finishes it/);
    assert.match(finishRefusal(board, request({}), claude)!, /Nobody has taken "Architecture view" yet: take it with take_request/);
    assert.match(finishRefusal(board, request({ status: 'done', takenBy: claude }), claude)!, /already done/);
    assert.match(finishRefusal(board, request({ status: 'cancelled' }), claude)!, /was cancelled, so there's nothing to finish/);
  });

  it('lets only people cancel', () => {
    assert.equal(cancelRefusal(sam), undefined);
    assert.match(cancelRefusal(claude)!, /Only people cancel a request; finish it with finish_request instead/);
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
    boardId = store.createBoard({ title: 'Tricot' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  it('takes a request from a person, and shows it to agents until one takes it', () => {
    assert.throws(() => store.askAgents(boardId, '   ', sam), /A request must not be empty/);
    assert.throws(() => store.askAgents(boardId, 'x'.repeat(501), sam), /A request is too long \(max 500 characters\)/);
    assert.throws(() => store.askAgents(boardId, 'Diagram it', claude), /Only people ask agents on the board context/);

    const request = store.askAgents(boardId, '  Get me an architecture view\n of the project ', sam);
    assert.equal(request.text, 'Get me an architecture view of the project');
    assert.equal(request.status, 'open');
    assert.deepEqual(request.by, sam);
    assert.deepEqual(board().requests, [request]);
    const event = eventsOf(store, board()).at(-1)!;
    assert.equal(event.type, 'request_asked');
    assert.equal(event.itemId, request.id, 'leads to the board context');
    assert.equal(lastSummary(), 'asked agents: "Get me an architecture view of the project"');
    assert.equal(requestsDigest(board()), undefined, 'a digest that no group says the board context in leaves out what is asked there');
  });
});
