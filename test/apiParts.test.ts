import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { get, post } from '../src/core/route';
import { SEAT_NEEDED } from '../src/core/seats';
import { BoardError } from '../src/core/store';
import { NOT_A_PERSON } from '../src/server/access';
import { ApiParts, type ApiPart } from '../src/server/apiParts';
import { ask, serve, type Running } from './apiPartsKit';

// How the REST parts are served (server/apiParts.ts): the core's
// router mounts the parts it is given, after the gate that asks a person for
// every change and before the 404 and the error handler. An app with none
// serves the canvas alone.

// A part of a test's own: not a part's, so it shows what the position gives any part.
const zooRoutes = { look: get('/api/zoo'), feed: post('/api/zoo/:animal/feed'), close: post('/api/zoo/close') };
const zoo: ApiPart = {
  id: 'zoo',
  routes: zooRoutes,
  mount(_api, { on, seated, human, param }) {
    on(zooRoutes.look, (_req, res) => {
      res.json({ seen: 'lions' });
    });
    on(zooRoutes.feed, seated, (req, res) => {
      res.json({ fed: param(req, 'animal'), by: human('Sam').name });
    });
    on(zooRoutes.close, () => {
      throw new BoardError('The zoo is closed.', 'conflict');
    });
  },
};

describe('An app with no parts, the canvas alone', () => {
  let running: Running;
  before(async () => {
    running = await serve(new ApiParts());
  });
  after(() => running.stop());

  it('works as the canvas does: the board, its pages and blocks, a thread, and the routes of the core', async () => {
    assert.equal((await ask(running, 'program', 'GET', '/api/info')).status, 200);
    assert.equal((await ask(running, 'program', 'GET', '/api/boards')).status, 200);
    const made = await ask(running, 'terminal', 'POST', '/api/boards', { actor: 'Sam', title: 'Canvas only' });
    assert.equal(made.status, 201);
    const boardId = String(made.body.id);
    assert.equal((await ask(running, 'program', 'GET', `/api/boards/${boardId}`)).status, 200);
    const page = await ask(running, 'terminal', 'POST', `/api/boards/${boardId}/pages`, { actor: 'Sam', title: 'Sketch' });
    assert.equal(page.status, 201);
    const block = await ask(running, 'terminal', 'POST', '/api/canvas/blocks', { actor: 'Sam', pageId: page.body.id, content: { type: 'note', text: 'A note' } });
    assert.equal(block.status, 201);
    assert.equal((await ask(running, 'terminal', 'POST', `/api/boards/${boardId}/threads`, { actor: 'Sam', body: 'Hello' })).status, 201);
    assert.equal((await ask(running, 'seat', 'POST', `/api/boards/${boardId}/archive`)).status, 200, "a seat's change of the core's goes through its own gate");
  });
});

describe('A part mounted before the 404, whichever it is', () => {
  let running: Running;
  before(async () => {
    running = await serve(new ApiParts().add(zoo));
  });
  after(() => running.stop());

  it('keeps the gate: a change is a person\'s, and a route that asks a seat refuses a terminal', async () => {
    const program = await ask(running, 'program', 'POST', '/api/zoo/lion/feed');
    assert.deepEqual([program.status, program.body.error], [403, NOT_A_PERSON]);
    const terminal = await ask(running, 'terminal', 'POST', '/api/zoo/lion/feed');
    assert.deepEqual([terminal.status, terminal.body.code], [403, SEAT_NEEDED]);
    const seat = await ask(running, 'seat', 'POST', '/api/zoo/lion/feed');
    assert.deepEqual([seat.status, seat.body], [200, { fed: 'lion', by: 'Sam' }]);
  });
});
