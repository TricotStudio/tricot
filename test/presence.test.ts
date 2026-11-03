import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FOCUS_MS, Presence } from '../src/server/presence';

describe('Presence', () => {
  const setup = () => {
    let now = 1_000_000;
    const changes: string[] = [];
    const presence = new Presence((id) => changes.push(id), () => now);
    return { presence, changes, advance: (ms: number) => (now += ms) };
  };

  it('shows agents working, then not checking, and drops them after five quiet minutes', () => {
    const { presence, changes, advance } = setup();
    presence.seen('b1', 'Claude');
    presence.seen('b1', 'Claude');
    assert.deepEqual(presence.list('b1').map((a) => [a.name, a.state]), [['Claude', 'working']]);
    assert.deepEqual(changes, ['b1'], 'repeat calls are not news');
    assert.deepEqual(presence.list('b2'), []);

    advance(2 * 60_000 + 1);
    presence.sweep();
    assert.deepEqual(presence.list('b1').map((a) => [a.name, a.state]), [['Claude', 'away']]);
    assert.deepEqual(changes, ['b1', 'b1'], 'going quiet is news');

    advance(3 * 60_000);
    presence.sweep();
    assert.deepEqual(presence.list('b1'), []);
    assert.deepEqual(changes, ['b1', 'b1', 'b1'], 'leaving is news');
    presence.close();
  });

  it('shows an agent as listening while it waits, across back-to-back waits', () => {
    const { presence, changes, advance } = setup();
    presence.startWaiting('b1', 'Claude');
    assert.equal(presence.list('b1')[0].state, 'listening');

    advance(240_000);
    presence.stopWaiting('b1', 'Claude');
    presence.startWaiting('b1', 'Claude'); // calls again straight away
    presence.sweep();
    assert.equal(presence.list('b1')[0].state, 'listening');
    assert.deepEqual(changes, ['b1'], 'no flicker between waits');

    presence.stopWaiting('b1', 'Claude'); // and this time stops listening
    advance(20_000);
    presence.sweep();
    assert.deepEqual(presence.list('b1').map((a) => [a.name, a.state]), [['Claude', 'working']]);
    assert.deepEqual(changes, ['b1', 'b1']);
    presence.close();
  });

  it("puts an agent on the card its calls are about, moves it, and lets it go after a quiet minute", () => {
    const { presence, changes, advance } = setup();
    const focus = (board = 'b1') => presence.list(board).map((a) => [a.name, a.focus]);
    presence.seen('b1', 'Claude');
    assert.deepEqual(focus(), [['Claude', undefined]], 'board-level calls are about no card');

    presence.seen('b1', 'Claude', { kind: 'task', id: 't1' });
    assert.deepEqual(focus(), [['Claude', { kind: 'task', id: 't1' }]]);
    assert.equal(changes.length, 2, 'taking a look is news');

    advance(40_000);
    presence.seen('b1', 'Claude', { kind: 'task', id: 't1' }); // still on it: the minute starts again
    presence.seen('b1', 'Claude'); // get_board, get_updates: the card stays
    presence.startWaiting('b1', 'Claude');
    presence.stopWaiting('b1', 'Claude');
    assert.deepEqual(focus(), [['Claude', { kind: 'task', id: 't1' }]]);
    assert.equal(changes.length, 3, 'only the wait was news');

    presence.seen('b1', 'Claude', { kind: 'decision', id: 'd1' }); // one card at a time
    assert.deepEqual(focus(), [['Claude', { kind: 'decision', id: 'd1' }]]);
    assert.equal(changes.length, 4, 'moving to another card is news');

    presence.seen('b1', 'Codex', { kind: 'decision', id: 'd1' });
    assert.deepEqual(focus(), [
      ['Claude', { kind: 'decision', id: 'd1' }],
      ['Codex', { kind: 'decision', id: 'd1' }],
    ]);
    assert.deepEqual(focus('b2'), [], 'per board');

    advance(FOCUS_MS - 1);
    presence.seen('b1', 'Claude'); // a board-level call doesn't keep it there
    assert.deepEqual(focus(), [
      ['Claude', { kind: 'decision', id: 'd1' }],
      ['Codex', { kind: 'decision', id: 'd1' }],
    ]);
    const before = changes.length;
    advance(1);
    presence.sweep();
    assert.deepEqual(focus(), [
      ['Claude', undefined],
      ['Codex', undefined],
    ]);
    assert.equal(changes.length, before + 1, 'letting go is news');
    assert.deepEqual(presence.list('b1').map((a) => a.state), ['working', 'working'], 'still here, just on no card');
    presence.close();
  });
});
