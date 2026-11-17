import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canvasServer } from './canvasEdition';

// What a server of Tricot Canvas tells an agent of a board that a part kept, with the words of its own it must not say, is
// in its counterpart of this file: it needs a part's own scenario to read by.

describe('The kinds of event a log can hold', () => {
  it('begin the status event as the log writes it, which Canvas does not tell', async () => {
    const server = await canvasServer();
    try {
      const board = server.store.createBoard({ title: 'Plain' }, { kind: 'human', name: 'Sam' });
      server.store.setStanding(board.id, 'Works.', { kind: 'agent', name: 'Claude' });
      const event = server.store.events(board.id, { order: 'asc' }).find((e) => e.type === 'board_updated')!;
      assert.match(event.summary, /^updated the status/);
    } finally {
      await server.stop();
    }
  });
});

