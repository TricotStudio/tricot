// The text of test/golden/data-schema-and-rows.txt, and the code that wrote it.
//
// The golden holds two things a later change to how the core reads and writes its data must leave exactly as they are:
//
// - the schema of a new data file at the current data version, as sqlite_master holds its text (every table, index,
//   generated column and constraint, in a fixed order), and
// - a digest of every table of each of the seven databases the releases left (test/fixtures/tricot-0.1.0.db to
//   tricot-0.1.6.db) after the project's own migrations have taken them to the current data version: the number of rows
//   and two sha256 of the rows, each as JSON in its own column order, sorted: `named`, in which the random ids a
//   fixture was made with are named by the order they first appear in (<id1>, <id2>, ...) and every time is <time>, so
//   it says what the migrations made of the rows and not which ids and clock a fixture happened to be saved with (the
//   seven fixtures hold the same board, so they agree), and `exact`, the rows as stored, to the byte.
//
// The migration is run on a copy by `openDatabase` with no part (core's migrations alone): no Store, and nothing of
// a part, is involved. The same input gives the same text every time (test/dataGolden.test.ts renders it twice).
//
// NEVER REGENERATE THIS FILE. It was written once, by the step that added it, from today's code, and its whole use is
// that it does not move: a later step that changes what the core stores must show it moved nothing. A builder must
// never set TRICOT_WRITE_DATA_GOLDEN: if the test fails, the code is what is wrong, and the file is right. The switch is
// off by default, and `writeGolden` refuses without it.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS, openDatabase, userVersion } from '../src/core/store/migrations';
import type { Database } from '../src/core/store/sqlite';
import { schemaLines } from './foreignRows';
import { removeScratch } from './platform';

export const GOLDEN_FILE = path.join(import.meta.dirname, 'golden', 'data-schema-and-rows.txt');
export const FIXTURES = path.join(import.meta.dirname, 'fixtures');
export const RELEASE_VERSIONS = ['0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6'];
export const WRITE_SWITCH = 'TRICOT_WRITE_DATA_GOLDEN';

type Row = Record<string, unknown>;

const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const MIN_ID = 4; // option ids and the like ('a', 'b') are not ids made by randomId

const plain = (rows: unknown[]): Row[] => (rows as Row[]).map((row) => ({ ...row }));
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

// Every id a body names: the value of `id`, of a key that ends in `Id` and the strings in a key that ends in `Ids`.
function bodyIds(value: unknown, add: (id: unknown) => void): void {
  if (Array.isArray(value)) return value.forEach((item) => bodyIds(item, add));
  if (typeof value !== 'object' || value === null) return;
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'id' || key.endsWith('Id')) add(inner);
    else if (key.endsWith('Ids') && Array.isArray(inner)) inner.forEach(add);
    bodyIds(inner, add);
  }
}

// The ids a database was made with, in the order they first appear: boards, then items (the board's own, then each
// canvas's), the events and the block versions, with those their bodies name. No order here depends on the value of an
// id, but for a tie between rows of the same place (two cards' canvases), which the ids break.
function idsInOrder(db: Database): string[] {
  const seen = new Set<string>();
  const add = (id: unknown) => {
    if (typeof id === 'string' && id.length >= MIN_ID) seen.add(id);
  };
  const body = (text: unknown) => bodyIds(JSON.parse(String(text)), add);
  for (const row of plain(db.prepare('SELECT key, id, body FROM boards ORDER BY pos').all())) {
    [row.key, row.id].forEach(add);
    body(row.body);
  }
  const items = db.prepare(`SELECT owner, id, body FROM items ORDER BY CASE WHEN owner = '' THEN 0 WHEN owner = 'board' THEN 1 ELSE 2 END, kind, pos, owner, id`).all();
  for (const row of plain(items)) {
    [String(row.owner).split(':')[1], row.id].forEach(add);
    body(row.body);
  }
  for (const row of plain(db.prepare('SELECT body FROM events ORDER BY board, seq').all())) body(row.body);
  for (const row of plain(db.prepare('SELECT block, body FROM block_versions ORDER BY board, rev, block').all())) {
    add(row.block);
    body(row.body);
  }
  return [...seen];
}

function normaliser(db: Database): (text: string) => string {
  const ids = idsInOrder(db);
  if (ids.length === 0) return (text) => text.replace(ISO_TIME, '<time>');
  const token = new Map(ids.map((id, i) => [id, `<id${i + 1}>`]));
  const pattern = new RegExp([...ids].sort((a, b) => b.length - a.length).map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return (text) => text.replace(pattern, (id) => token.get(id)!).replace(ISO_TIME, '<time>');
}

// One line a table: its name, how many rows, the digest of them with ids and times named, and the digest of the rows
// exactly as stored (the fixtures are fixed files, so these do not move either).
function tableLines(db: Database): string[] {
  const normalise = normaliser(db);
  const tables = plain(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).map((row) => String(row.name));
  return tables.map((table) => {
    const exact = plain(db.prepare(`SELECT * FROM "${table}"`).all()).map((row) => JSON.stringify(row));
    const named = exact.map(normalise).sort();
    return `${table} ${exact.length} named:${sha256(named.join('\n'))} exact:${sha256(exact.sort().join('\n'))}`;
  });
}

// What a release's database holds once the migrations have run on a copy of it.
export function migratedFixtureLines(version: string): string[] {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-golden-'));
  try {
    const file = path.join(dir, 'tricot.db');
    copyFileSync(path.join(FIXTURES, `tricot-${version}.db`), file);
    const db = openDatabase(file, MIGRATIONS, []);
    try {
      return [`user_version ${userVersion(db)}`, ...tableLines(db)];
    } finally {
      db.close();
    }
  } finally {
    removeScratch(dir);
  }
}

// A new data file's schema, as sqlite_master holds it, at the current data version.
export function freshSchemaLines(): string[] {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-golden-'));
  try {
    const file = path.join(dir, 'tricot.db');
    const db = openDatabase(file, MIGRATIONS, []);
    const version = userVersion(db);
    db.close();
    return [`data version ${version}`, ...schemaLines(file)];
  } finally {
    removeScratch(dir);
  }
}

const HEADER = [
  '# The data a Tricot stores: the schema of a new data file, and what the migrations make of each release\'s database.',
  '# Written once and never regenerated: a later change to what the core stores must leave this file as it is.',
  '# test/dataGolden.ts says how it is made, and test/dataGolden.test.ts compares it.',
];

export function renderGolden(): string {
  const parts = [HEADER.join('\n'), ['## a new data file', ...freshSchemaLines()].join('\n')];
  for (const version of RELEASE_VERSIONS) parts.push([`## Tricot ${version}'s database, migrated to data version ${MIGRATIONS.length}`, ...migratedFixtureLines(version)].join('\n'));
  return `${parts.join('\n\n')}\n`;
}

// Refuses unless the switch is set: it is off, and nobody turns it on.
export function writeGolden(): void {
  if (process.env[WRITE_SWITCH] !== '1') throw new Error(`${GOLDEN_FILE} is never regenerated: ${WRITE_SWITCH} is not set, and a builder must not set it.`);
  writeFileSync(GOLDEN_FILE, renderGolden());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeGolden();
