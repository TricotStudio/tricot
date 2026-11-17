import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import { useBoardCards } from '../src/core/cards';
import { placeOf } from '../src/core/canvas';
import { concernsAgent } from '../src/core/concerns';
import { eventPlace } from '../src/core/eventPlace';
import { requestsDigest } from '../src/core/requests';
import { Store } from '../src/core/store';
import type { Actor, Block, Board, ScratchPage } from '../src/core/types';
import { removeScratch } from './platform';
import { askableCards } from './madeUpAsked';
import { eventsOf } from './tables';

// From a selection on a Sketchbook page to a request. A person
// selects blocks and asks agents about them. That is a request
// (core/requests.ts) whose group is made beside the blocks as it is asked,
// where the answer lands.

const sam: Actor = { kind: 'human', name: 'Sam' };
const note = (title: string, text: string, x: number, y: number) => ({ content: { type: 'note' as const, text }, title, x, y, w: 280, h: 160 });

// A page with two blocks side by side to select, and one apart.
function pageWithTwo(store: Store, boardId: string): { page: ScratchPage; idea: Block; questions: Block; other: Block } {
  const page = store.addPage(boardId, 'One view on project status', sam);
  const idea = store.addBlock({ pageId: page.id }, note('Idea', 'Merge the board context and decisions', 0, 0), sam);
  const questions = store.addBlock({ pageId: page.id }, note('Open questions', '- Who keeps the status current?', 0, 240), sam);
  const other = store.addBlock({ pageId: page.id }, note('Elsewhere', 'Not selected', 0, 900), sam);
  return { page, idea, questions, other };
}

// The kinds of card these tests' boards hold, as a part registers them (core/cards.ts): made up, as nothing here is a part's.
before(() => {
  useBoardCards(askableCards());
});

const pageOf = (board: Board, id: string) => board.pages!.find((p) => p.id === id)!;

describe('Asking agents about blocks selected on a Sketchbook page', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-selection-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Tricot roadmap' }, sam).id;
  });
  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  it('asks about two blocks, with its group beside them, for any agent', () => {
    const { page, idea, questions } = pageWithTwo(store, boardId);
    const request = store.askOnPage(page.id, { blockIds: [questions.id, idea.id], text: 'Which of these should lead?' }, sam);
    const board = store.getBoard(boardId);
    assert.equal(request.status, 'open');
    assert.equal(request.text, 'Which of these should lead?');
    assert.deepEqual(request.blockIds, [idea.id, questions.id], 'in canvas order');
    const group = pageOf(board, page.id).canvas.groups.find((g) => g.id === request.groupId)!;
    assert.ok(group, 'its group is on the page from the start');
    assert.equal(group.title, 'Which of these should lead');
    assert.ok(!board.canvas.groups.some((g) => g.id === group.id), 'not on the board context');
    const right = Math.max(...[idea, questions].map((b) => placeOf(pageOf(board, page.id).canvas, b)).map((r) => r.x + r.w));
    assert.ok(group.x > right && group.y === 0, `beside the blocks, to their right: ${group.x},${group.y}`);

    const asked = eventsOf(store, boardId).at(-1)!;
    assert.equal(asked.type, 'request_asked');
    assert.match(asked.summary, /^asked agents about 2 blocks on Sketchbook page "One view on project status": "Which of these should lead\?"$/);
    assert.ok(concernsAgent(asked, board, 'Claude'), 'it wakes a listening agent');
    assert.deepEqual(eventPlace(board, asked), { kind: 'page', id: page.id }, 'it leads to its page');

    const digest = requestsDigest(board, 'Claude')!;
    assert.match(digest, new RegExp(`Sam asked agents about 2 blocks on Sketchbook page "One view on project status" \\[page id: ${page.id}; request id: ${request.id}\\]: "Idea" \\[id: ${idea.id}\\] and "Open questions" \\[id: ${questions.id}\\]\\.`));
    assert.match(digest, /They asked: "Which of these should lead\?"\. Take it with take_request/);
    assert.match(digest, new RegExp(`add_block with page_id: ${page.id} and its group_id`));
  });
});
