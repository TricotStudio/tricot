import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { MIGRATIONS } from '../src/core/store/migrations';
import { GOLDEN_FILE, RELEASE_VERSIONS, WRITE_SWITCH, freshSchemaLines, migratedFixtureLines, renderGolden, writeGolden } from './dataGolden';

// What the core stores, pinned in test/golden/data-schema-and-rows.txt: the schema of a new data file at the
// current data version, and a digest of every table of each database a release left (test/fixtures/tricot-0.1.0.db
// to 0.1.6.db) after the migrations have taken it to the current version. The decisions, the tasks and the
// tables that only they use are rows and columns of that data, and the core is to stop naming them without one
// stored byte moving. A later step that changes how the core reads or writes its data must leave this file exactly
// as it is.
//
// NEVER REGENERATE THE GOLDEN, and never set TRICOT_WRITE_DATA_GOLDEN (a builder must not): the file was written
// once from the code as it was, and its use is that it stays. When this test fails, the code moved the data, and the
// code is what to fix. `npx tsx test/dataGolden.ts` refuses to write without the switch, which is off.
describe('The data the core stores, pinned by a golden file', () => {
  const golden = readFileSync(GOLDEN_FILE, 'utf8');

  it('is the schema of a new data file and the migrated rows of every release, as written', () => {
    assert.equal(renderGolden(), golden);
  });

  it('renders the same text twice', () => {
    assert.equal(renderGolden(), renderGolden());
    for (const version of RELEASE_VERSIONS) assert.deepEqual(migratedFixtureLines(version), migratedFixtureLines(version));
    assert.deepEqual(freshSchemaLines(), freshSchemaLines());
  });

  it('holds the current data version, every release, and the tables a part reads', () => {
    assert.ok(golden.includes(`data version ${MIGRATIONS.length}\n`), 'the schema is at the current data version');
    for (const version of RELEASE_VERSIONS) assert.ok(golden.includes(`## Tricot ${version}'s database, migrated to data version ${MIGRATIONS.length}\nuser_version ${MIGRATIONS.length}\n`), `${version}'s database`);
    for (const table of ['boards', 'items', 'events', 'block_versions', 'need_dismissals']) assert.match(golden, new RegExp(`^table ${table} on ${table}: CREATE TABLE ${table} `, 'm'));
    assert.match(golden, /^index events_by_decision on events: .*WHERE decision_id IS NOT NULL$/m);
    assert.match(golden, /^index events_by_task on events: .*WHERE task_id IS NOT NULL$/m);
    const rows = golden.split('\n').filter((line) => /^items \d+ /.test(line));
    assert.equal(rows.length, RELEASE_VERSIONS.length, 'a digest of the items of each release');
    assert.ok(rows.every((line) => line.startsWith('items 10 ')), 'each fixture holds ten items: two decisions, a task, and the blocks, groups and pins on their canvases');
  });

  it('is only written when asked to by a switch that is off', () => {
    assert.notEqual(process.env[WRITE_SWITCH], '1', `${WRITE_SWITCH} is set: it must never be`);
    assert.throws(() => writeGolden(), /never regenerated/);
    assert.equal(readFileSync(GOLDEN_FILE, 'utf8'), golden);
  });
});
