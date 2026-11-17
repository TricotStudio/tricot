// What a Tricot reads out of the database that an older Tricot may not: the
// kinds of block, and the values of the enums a board holds. dataShape.test.ts
// keeps it next to the data version (dataShape.core.json), for the core's own types;
// the shape with a part's types added is dataShape.json, kept by its own test.
//
// The kinds come from the registry. The enums are read from the source of the
// types that describe what is stored: a string union written out (`type Status
// = 'open' | …`, or a property typed `'human' | 'agent'`), and the values of
// the `kind`, `op` or `status` a union of shapes is told apart by (PinAnchor's
// kinds), and the names of an open set: an interface whose members are all
// `: true`, which the parts add to by augmenting it (a part's file of types), read
// where a type is `keyof` it (`type EventType = keyof EventTypeNames`) or a
// property is (`kind: keyof ThreadRefKinds`). TypeScript's own compiler can't
// be asked here, so this reads the text, which these files keep plain.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kinds } from '../src/core/blocks/registry';
import { EMOJIS } from '../src/core/reactions';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core');
// The files of the core whose types are what the database holds. A part that augments them adds its own file (a part's, in its own test), and reads the shape of all of them with `currentShape`.
export const CORE_TYPE_FILES = ['types.ts', 'deletions.ts'];

export interface DataShape {
  blockKinds: string[];
  enums: Record<string, string[]>;
}

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const literals = (text: string) => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);
const LITERAL_UNION = /^\s*\|?\s*'[^']*'(?:\s*\|\s*'[^']*')*\s*$/;

interface Declaration {
  type: 'type' | 'interface';
  name: string;
  body: string;
}

// `export type X = …;` and `export interface X { … }`, each to its end: a type's
// at the first `;` outside any brackets, an interface's at the brace that closes it.
// An interface an augmentation adds to (`interface X { … }` inside `declare module`) counts too.
function declarations(text: string): Declaration[] {
  const found: Declaration[] = [];
  for (const start of text.matchAll(/^[ \t]*(?:export )?(type|interface) (\w+)/gm)) {
    const type = start[1] as Declaration['type'];
    let depth = 0;
    let entered = false;
    let end = text.length;
    for (let i = start.index + start[0].length; i < text.length; i++) {
      const c = text[i];
      if ('{([<'.includes(c)) {
        depth++;
        entered = true;
      } else if ('})]>'.includes(c) && !(c === '>' && text[i - 1] === '=')) {
        depth--;
        if (type === 'interface' && entered && depth === 0) {
          end = i + 1;
          break;
        }
      } else if (c === ';' && type === 'type' && depth === 0) {
        end = i;
        break;
      }
    }
    found.push({ type, name: start[2], body: text.slice(start.index + start[0].length, end) });
  }
  return found;
}

// What is written at the top level of braces: a line of an interface, or a
// member of a union of object types.
function topLevel(body: string, depthWanted: number): string[] {
  const lines: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of body) {
    if (c === '{') {
      depth++;
      if (depth === depthWanted + 1) current += '{';
      continue;
    }
    if (c === '}') {
      depth--;
      if (depth < depthWanted) {
        lines.push(current);
        current = '';
      }
      continue;
    }
    if (depth === depthWanted) {
      if (c === ';' || c === ',' || c === '\n') {
        lines.push(current);
        current = '';
      } else current += c;
    }
  }
  lines.push(current);
  return lines.map((line) => line.trim()).filter(Boolean);
}

const OPEN_SET_NAME = /^(\w+)\??\s*:\s*true$/;
const KEYOF = /^\s*=?\s*keyof (\w+)\s*$/;

// The names an open set holds, over every file: the interfaces whose members are all `: true`, an augmentation's added to the core's.
function openSets(declared: Declaration[]): Record<string, string[]> {
  const sets: Record<string, string[]> = {};
  for (const { type, name, body } of declared) {
    if (type !== 'interface') continue;
    const lines = topLevel(body, 1);
    const names = lines.map((line) => OPEN_SET_NAME.exec(line)?.[1]);
    if (names.every((n) => n !== undefined)) sets[name] = [...(sets[name] ?? []), ...(names as string[])];
    else if (sets[name]) delete sets[name];
  }
  return sets;
}

function enumsIn(declared: Declaration[]): Record<string, string[]> {
  const enums: Record<string, string[]> = {};
  const sets = openSets(declared);
  const add = (name: string, values: string[]) => (enums[name] = [...new Set([...(enums[name] ?? []), ...values])].sort());
  for (const { type, name, body } of declared) {
    if (type === 'type') {
      const after = body.replace(/^\s*=/, '');
      const open = KEYOF.exec(after);
      if (open && sets[open[1]]) {
        add(name, sets[open[1]]);
        continue;
      }
      if (LITERAL_UNION.test(after)) {
        add(name, literals(after));
        continue;
      }
      // A union of shapes told apart by what one property is: `{ kind: 'text'; … } | …`.
      for (const line of topLevel(after, 1)) {
        const tag = /^(kind|op|status)\s*:\s*'([^']*)'$/.exec(line);
        if (tag) add(`${name}.${tag[1]}`, [tag[2]]);
      }
    } else {
      for (const line of topLevel(body, 1)) {
        const property = /^(\w+)\??\s*:\s*('[^']*'(?:\s*\|\s*'[^']*')+)$/.exec(line);
        if (property) add(`${name}.${property[1]}`, literals(property[2]));
        const opened = /^(\w+)\??\s*:\s*keyof (\w+)$/.exec(line);
        if (opened && sets[opened[2]]) add(`${name}.${opened[1]}`, sets[opened[2]]);
      }
    }
  }
  return enums;
}

export function currentShape(typeFiles: readonly string[] = CORE_TYPE_FILES): DataShape {
  const enums: Record<string, string[]> = {};
  const declared = typeFiles.flatMap((file) => declarations(withoutComments(readFileSync(path.join(src, file), 'utf8'))));
  Object.assign(enums, enumsIn(declared));
  enums.Emoji = [...EMOJIS].sort();
  const sorted = Object.fromEntries(Object.entries(enums).sort(([a], [b]) => a.localeCompare(b)));
  return { blockKinds: kinds().map((kind) => kind.type), enums: sorted };
}

// ---- the snapshot, kept beside the data version -----------------------------------

// The core's own shape, at the data version it names. A part's snapshot is dataShape.json: the shape of the core's types
// with its own added, which is what a release with a part has to keep.
export const SNAPSHOT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dataShape.core.json');

export interface Snapshot extends DataShape {
  dataVersion: number; // the version (the number of migrations) the shape was taken at
}

export const readSnapshot = (file: string = SNAPSHOT_FILE): Snapshot => JSON.parse(readFileSync(file, 'utf8')) as Snapshot;

// What differs, as lines a person can act on.
export function shapeChanges(was: DataShape, now: DataShape): string[] {
  const lines: string[] = [];
  const compare = (name: string, before: string[] = [], after: string[] = []) => {
    const added = after.filter((v) => !before.includes(v));
    const removed = before.filter((v) => !after.includes(v));
    if (added.length) lines.push(`${name}: added ${added.join(', ')}`);
    if (removed.length) lines.push(`${name}: removed ${removed.join(', ')}`);
  };
  compare('block kinds', was.blockKinds, now.blockKinds);
  for (const name of new Set([...Object.keys(was.enums), ...Object.keys(now.enums)])) compare(name, was.enums[name], now.enums[name]);
  return lines;
}

// A snapshot as the file holds it: one line to a block-kinds list and to each enum.
export function snapshotText(dataVersion: number, shape: DataShape): string {
  const lines = ['{', `  "dataVersion": ${dataVersion},`, `  "blockKinds": ${JSON.stringify(shape.blockKinds)},`, '  "enums": {'];
  const entries = Object.entries(shape.enums);
  entries.forEach(([name, values], i) => lines.push(`    ${JSON.stringify(name)}: ${JSON.stringify(values)}${i < entries.length - 1 ? ',' : ''}`));
  return [...lines, '  }', '}', ''].join('\n');
}

// Takes a snapshot again, once a migration has been added for what changed: it won't without one. `typeFiles` are the
// files of types the shape is read from, and `file` the snapshot.
export async function writeSnapshot(file: string, typeFiles: readonly string[] = CORE_TYPE_FILES): Promise<void> {
  const { MIGRATIONS } = await import('../src/core/store/migrations');
  const was = readSnapshot(file);
  const now = currentShape(typeFiles);
  if (shapeChanges(was, now).length && MIGRATIONS.length <= was.dataVersion) {
    console.error(`The shape changed, and there is no migration after data version ${was.dataVersion} to say so. Add one to MIGRATIONS first.`);
    process.exit(1);
  }
  writeFileSync(file, snapshotText(MIGRATIONS.length, now));
  console.log(`${path.basename(file)} is the shape at data version ${MIGRATIONS.length}.`);
}

// `npx tsx test/dataShape.ts --write` takes the core's snapshot again. A part's is taken again by its own script.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) await writeSnapshot(SNAPSHOT_FILE);
