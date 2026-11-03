import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { boardEdit, boardsSignal, goalItem, headerActions, stillHeld } from '../src/web/boardChanges';
import { afterPress, menuStep, plainPress } from '../src/web/hooks';

const board = { title: 'Checkout redesign', goal: 'Get more buyers to pay' };

describe('Renaming a board from its row on Home', () => {
  it('asks for nothing when nothing changed, spaces aside', () => {
    assert.equal(boardEdit(board, { title: 'Checkout redesign', goal: 'Get more buyers to pay' }), null);
    assert.equal(boardEdit(board, { title: '  Checkout redesign ', goal: ' Get more buyers to pay' }), null);
    assert.equal(boardEdit({ title: 'No goal' }, { title: 'No goal', goal: '  ' }), null);
  });

  it('asks only for what changed, trimmed', () => {
    assert.deepEqual(boardEdit(board, { title: ' Checkout redesign: launch ', goal: 'Get more buyers to pay' }), { patch: { title: 'Checkout redesign: launch' } });
    assert.deepEqual(boardEdit(board, { title: 'Checkout redesign', goal: 'Fewer drop-offs ' }), { patch: { goal: 'Fewer drop-offs' } });
    assert.deepEqual(boardEdit(board, { title: 'Checkout', goal: '' }), { patch: { title: 'Checkout', goal: '' } }, 'an emptied goal clears it');
    assert.deepEqual(boardEdit({ title: 'No goal' }, { title: 'No goal', goal: 'Now one' }), { patch: { goal: 'Now one' } });
  });

  it('refuses an empty title, whatever else changed', () => {
    assert.deepEqual(boardEdit(board, { title: '   ', goal: 'Something new' }), { error: 'A board needs a title.' });
  });
});

describe("The ⋯ menu in a board's header", () => {
  it('is where a board is renamed and its goal changed, first, then its connectors and archiving', () => {
    assert.deepEqual(headerActions({}), ['rename', 'goal', 'connectors', 'archive']);
    assert.deepEqual(headerActions({ archived: undefined }), ['rename', 'goal', 'connectors', 'archive']);
  });

  it('still renames an archived board and changes its goal, and offers to unarchive or delete it', () => {
    const archived = { archived: { by: { kind: 'human', name: 'Sam' }, at: '2026-11-02T00:00:00.000Z' } };
    assert.deepEqual(headerActions(archived), ['rename', 'goal', 'connectors', 'unarchive', 'delete']);
    assert.ok(!headerActions({}).includes('delete'), 'only an archived board can be deleted');
  });

  it("names the goal's item as Home's rows do: edit one there is, add one there isn't", () => {
    assert.equal(goalItem(true), 'Edit the goal…');
    assert.equal(goalItem(false), 'Add a goal…');
  });
});

describe('Rows held off Home while they are archived', () => {
  it('holds a row while the list still shows it, and lets go once the list leaves it out', () => {
    const held = new Set(['a', 'b']);
    assert.equal(stillHeld(held, ['a', 'b', 'c']), held, 'the same set while nothing changed');
    assert.deepEqual([...stillHeld(held, ['b', 'c'])], ['b']);
    assert.deepEqual([...stillHeld(held, [])], []);
  });
});

describe('Moving through a menu from the keyboard', () => {
  it('steps with the arrows, wrapping around, and jumps with Home and End', () => {
    assert.equal(menuStep('ArrowDown', 0, 3), 1);
    assert.equal(menuStep('ArrowDown', 2, 3), 0);
    assert.equal(menuStep('ArrowUp', 0, 3), 2);
    assert.equal(menuStep('ArrowUp', 2, 3), 1);
    assert.equal(menuStep('ArrowRight', 1, 3), 2, 'a row of items, such as the reactions');
    assert.equal(menuStep('ArrowLeft', 1, 3), 0);
    assert.equal(menuStep('Home', 2, 3), 0);
    assert.equal(menuStep('End', 0, 3), 2);
  });

  it('starts from the first or the last item when none has the focus', () => {
    assert.equal(menuStep('ArrowDown', -1, 3), 0);
    assert.equal(menuStep('ArrowUp', -1, 3), 2);
  });

  it('leaves every other key, and an empty menu, alone', () => {
    assert.equal(menuStep('Enter', 0, 3), undefined);
    assert.equal(menuStep('r', 0, 3), undefined);
    assert.equal(menuStep('ArrowDown', -1, 0), undefined);
  });
});

// The docked conversation closes on a click outside it (threads.tsx): a plain
// one, and once the press is over, so the click lands where it was aimed.
describe('Clicking away from the docked conversation', () => {
  const press = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

  it('counts a plain press with the main button as a click away', () => {
    assert.equal(plainPress(press), true);
  });

  it('leaves right-clicks, middle clicks and modified clicks be', () => {
    assert.equal(plainPress({ ...press, button: 2 }), false, 'a right-click opens a menu');
    assert.equal(plainPress({ ...press, button: 1 }), false);
    assert.equal(plainPress({ ...press, metaKey: true }), false, 'opens a link in a new tab');
    assert.equal(plainPress({ ...press, ctrlKey: true }), false, "a Mac's right-click");
    assert.equal(plainPress({ ...press, shiftKey: true }), false, 'adds to a selection');
    assert.equal(plainPress({ ...press, altKey: true }), false);
  });

  describe('once the press is over', () => {
    const had = Object.getOwnPropertyDescriptor(globalThis, 'window');
    before(() => Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true }));
    after(() => (had ? Object.defineProperty(globalThis, 'window', had) : Reflect.deleteProperty(globalThis, 'window')));
    const tick = () => new Promise((resolve) => setTimeout(resolve));
    const release = (type = 'mouseup') => window.dispatchEvent(new Event(type));

    it('waits for the release, then for its click to be done, and runs once', async () => {
      let ran = 0;
      afterPress(() => ran++);
      await tick();
      assert.equal(ran, 0, 'not while the button is down');
      release();
      assert.equal(ran, 0, 'not before the click that follows the release');
      await tick();
      assert.equal(ran, 1);
      release();
      await tick();
      assert.equal(ran, 1, 'a later press is not this one');
    });

    it("ends with a drag's end, which has no release", async () => {
      let ran = 0;
      afterPress(() => ran++);
      release('dragend');
      await tick();
      assert.equal(ran, 1);
    });

    it('can be called off, before the release or after it', async () => {
      let ran = 0;
      const before = afterPress(() => ran++);
      before();
      release();
      await tick();
      const after = afterPress(() => ran++);
      release();
      after();
      await tick();
      assert.equal(ran, 0);
    });
  });
});

describe('Telling every tab that boards changed', () => {
  it("tells this tab's lists at once and the other tabs' over the channel, once each", async () => {
    const name = `tricot:boards-test-${process.pid}`;
    const here = boardsSignal(name);
    const there = boardsSignal(name); // another tab of the same browser
    try {
      const heard = { here: 0, there: 0, stopped: 0 };
      here.listen(() => heard.here++);
      const stop = here.listen(() => heard.stopped++);
      const arrived = new Promise<void>((resolve) =>
        there.listen(() => {
          heard.there++;
          resolve();
        }),
      );
      stop();

      here.notify();
      assert.equal(heard.here, 1, 'this tab hears it before the call returns');
      await arrived;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(heard, { here: 1, there: 1, stopped: 0 }, 'a tab does not hear its own message twice');
    } finally {
      here.close();
      there.close();
    }
  });
});
