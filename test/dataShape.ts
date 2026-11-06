// What a Tricot reads out of the database that an older Tricot may not: the
// kinds of block, and the values of the enums a board holds. dataShape.test.ts
// keeps it next to the data version (dataShape.json).
//
// The kinds come from the registry. The enums are read from the source of the
// types that describe what is stored: a string union written out (`type Status
// = 'open' | …`, or a property typed `'human' | 'agent'`), and the values of
// the `kind`, `op` or `status` a union of shapes is told apart by (PinAnchor's
// kinds). TypeScript's own compiler can't be asked here, so this reads the
// text, which these files keep plain.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kinds } from '../src/core/blocks/registry';
import { EMOJIS } from '../src/core/reactions';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core');
// The files whose types are what the database holds.
const TYPE_FILES = ['types.ts', 'deletions.ts'];

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
function declarations(text: string): Declaration[] {
  const found: Declaration[] = [];
  for (const start of text.matchAll(/^export (type|interface) (\w+)/gm)) {
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

function enumsIn(text: string): Record<string, string[]> {
  const enums: Record<string, string[]> = {};
  const add = (name: string, values: string[]) => (enums[name] = [...new Set([...(enums[name] ?? []), ...values])].sort());
  for (const { type, name, body } of declarations(withoutComments(text))) {
    if (type === 'type') {
      const after = body.replace(/^\s*=/, '');
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
      }
    }
  }
  return enums;
}

export function currentShape(): DataShape {
  const enums: Record<string, string[]> = {};
  for (const file of TYPE_FILES) Object.assign(enums, enumsIn(readFileSync(path.join(src, file), 'utf8')));
  enums.Emoji = [...EMOJIS].sort();
  const sorted = Object.fromEntries(Object.entries(enums).sort(([a], [b]) => a.localeCompare(b)));
  return { blockKinds: kinds().map((kind) => kind.type), enums: sorted };
}

// ---- the snapshot, kept beside the data version -----------------------------------

export const SNAPSHOT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dataShape.json');

export interface Snapshot extends DataShape {
  dataVersion: number; // the version (the number of migrations) the shape was taken at
}

export const readSnapshot = (): Snapshot => JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')) as Snapshot;

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

// `npx tsx test/dataShape.ts --write` takes the snapshot again, once a
// migration has been added for what changed: it won't without one.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  const { MIGRATIONS } = await import('../src/core/store/migrations');
  const was = readSnapshot();
  const now = currentShape();
  if (shapeChanges(was, now).length && MIGRATIONS.length <= was.dataVersion) {
    console.error(`The shape changed, and there is no migration after data version ${was.dataVersion} to say so. Add one to MIGRATIONS first.`);
    process.exit(1);
  }
  const lines = ['{', `  "dataVersion": ${MIGRATIONS.length},`, `  "blockKinds": ${JSON.stringify(now.blockKinds)},`, '  "enums": {'];
  const entries = Object.entries(now.enums);
  entries.forEach(([name, values], i) => lines.push(`    ${JSON.stringify(name)}: ${JSON.stringify(values)}${i < entries.length - 1 ? ',' : ''}`));
  writeFileSync(SNAPSHOT_FILE, [...lines, '  }', '}', ''].join('\n'));
  console.log(`dataShape.json is the shape at data version ${MIGRATIONS.length}.`);
}
