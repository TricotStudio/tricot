import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MIGRATIONS } from '../src/core/store/migrations';
import { currentShape, readSnapshot, shapeChanges } from './dataShape';

// An older Tricot that meets a kind of block, or a value of an enum, it doesn't
// know either fails on it ("Unknown block type") or shows the board wrong. The
// data version is what stops it opening the file at all, with a message that
// says to update. So a release that adds one must add a migration, even one
// that changes no data, which raises the version.
//
// dataShape.json is what the kinds and enums were at the data version it names.
// The test fails when what the code has differs from it, and when the version
// it names isn't the migrations' count, so neither can move alone.
describe('The data version', () => {
  const advice = (what: string[]) =>
    `${what.join('; ')}.\n` +
    "An older Tricot can't read these. Add a migration to MIGRATIONS in src/core/store/migrations.ts (one that changes no data will do, with a comment saying what it is for), " +
    'then run `npx tsx test/dataShape.ts --write` to take the new shape at the new data version.';

  it('is the one the snapshot of block kinds and enums was taken at', () => {
    assert.equal(readSnapshot().dataVersion, MIGRATIONS.length, 'run `npx tsx test/dataShape.ts --write`');
  });

  it('goes up when a block kind or an enum value is added or removed', () => {
    const changes = shapeChanges(readSnapshot(), currentShape());
    assert.deepEqual(changes, [], advice(changes));
  });

  it('reads the kinds and enums the board has, so the check above is not an empty one', () => {
    const { blockKinds, enums } = currentShape();
    assert.ok(blockKinds.includes('note') && blockKinds.includes('site'));
    assert.ok(enums.TaskStatus.includes('in_review'));
    assert.ok(enums['PinAnchor.kind'].includes('site') && enums['PinAnchor.kind'].includes('cells'), 'kinds of pin, told apart by their kind');
    assert.ok(enums.EventType.includes('card_deleted'));
    assert.ok(enums['Actor.kind'].includes('agent'), 'an enum on a property');
    assert.ok(Object.keys(enums).length >= 15);
  });

  it('notices a kind or value that is not in the snapshot', () => {
    const snapshot = readSnapshot();
    const grown = { blockKinds: [...snapshot.blockKinds, 'radar'], enums: { ...snapshot.enums, Status: [...snapshot.enums.Status, 'parked'] } };
    assert.deepEqual(shapeChanges(snapshot, grown), ['block kinds: added radar', 'Status: added parked']);
    assert.deepEqual(shapeChanges(grown, snapshot), ['block kinds: removed radar', 'Status: removed parked']);
  });
});
