import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLOSED, dockOnArrival, type DockState } from '../src/web/threads/dockStays';

// The threads panel stays open while the person uses the board (T163), and
// closes on its close button, Escape, or a dismiss click: a plain click on
// empty space outside it that does nothing else (dismissClick.test.ts). It
// stays open across a board's tabs and a card's view, and across projects
// (src/web/threads/dockStays.ts).

describe('The threads panel as a board comes on screen', () => {
  const onThread: DockState = { ...CLOSED, open: true, page: 'thread', selected: 'th-a', drafts: { 'th-a': 'half a reply' } };
  const any = () => true;
  const none = () => false;

  it("is as it was on the page's first board", () => {
    assert.deepEqual(dockOnArrival(CLOSED, 'a', null, any), { state: CLOSED, list: false });
  });

  it("is as it was on the same board, back from a card's view or Home: open on the same thread, unless dismissed", () => {
    assert.deepEqual(dockOnArrival(onThread, 'a', { board: 'a', open: true }, any), { state: onThread, list: false });
    const dismissed = { ...onThread, open: false };
    assert.deepEqual(dockOnArrival(dismissed, 'a', { board: 'a', open: false }, any), { state: dismissed, list: false });
  });

  it("stays open on another project, on that project's threads list over New thread, keeping what was typed", () => {
    const { state, list } = dockOnArrival(CLOSED, 'b', { board: 'a', open: true }, any);
    assert.equal(list, true);
    assert.equal(state.open, true);
    assert.equal(state.page, 'new');
    const drafted = { ...CLOSED, drafts: { new: 'an idea' } };
    assert.deepEqual(dockOnArrival(drafted, 'b', { board: 'a', open: true }, any).state.drafts, { new: 'an idea' });
  });

  it('reopens the thread a project had open when the person comes back to it, while it is still there', () => {
    assert.deepEqual(dockOnArrival(onThread, 'a', { board: 'b', open: true }, any), { state: onThread, list: false });
    assert.equal(dockOnArrival(onThread, 'a', { board: 'b', open: true }, none).list, true, 'deleted since: its list');
    const dismissedThere = { ...onThread, open: false };
    assert.equal(dockOnArrival(dismissedThere, 'a', { board: 'b', open: true }, any).list, true, 'dismissed there: its list');
  });

  it('stays closed on another project when the person closed it, even where it was open', () => {
    assert.deepEqual(dockOnArrival(onThread, 'a', { board: 'b', open: false }, any), { state: { ...onThread, open: false }, list: false });
  });

  it("closes on another project when it's set to stay on a project's tabs only", () => {
    assert.deepEqual(dockOnArrival(CLOSED, 'b', { board: 'a', open: true }, any, 'closes'), { state: CLOSED, list: false });
    assert.deepEqual(dockOnArrival(onThread, 'a', { board: 'b', open: true }, any, 'closes'), { state: { ...onThread, open: false }, list: false });
    assert.deepEqual(dockOnArrival(onThread, 'a', { board: 'a', open: true }, any, 'closes'), { state: onThread, list: false }, 'its own tabs keep it');
  });
});
