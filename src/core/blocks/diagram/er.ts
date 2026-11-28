// The entities and relationships of a Mermaid entity relationship diagram,
// read from its source as a flowchart's nodes and arrows are (flowchart.ts),
// into the same shape (readers.ts): an entity is a node, by its name in the
// source, its text the alias it is shown by (p[Person]) or its name, its
// attributes part of it; a relationship is an arrow from the entity named
// first to the one named second, the n-th between them, its text its label.
// It splits the source as Mermaid's own lexer does and reads the common
// syntax, not all of it: a part it can't read can't be pinned, and the
// diagram still renders as Mermaid draws it.

import { cleanLabel, type FlowArrow, type Flowchart } from './flowchart';
import type { DiagramReader } from './readers';

const HEADER = /^\s*erDiagram\b/;

type Kind = 'name' | 'card' | 'rel' | 'colon' | 'classes' | 'comma' | 'open' | 'close' | 'block' | 'class' | 'subgraph' | 'end' | 'nl' | 'skip' | 'other';
type Token = { kind: Kind; start: number; end: number };

// What Mermaid's lexer reads, in the order it tries it, case aside: notes for
// screen readers, quoted names, an entity's attributes (a block, read whole
// below), a relationship's cardinalities (||, }o, one or more, 0+…) and how
// it joins them (-- or to, .. or optionally to), names, and lines that style
// rather than draw.
const RULES: [RegExp, Kind][] = [
  [/accTitle\s*:[^\n]*|accDescr\s*:[^\n]*|accDescr\s*\{[^}]*\}?|[ \t\r]+/iy, 'skip'],
  [/\n+/y, 'nl'],
  [/"[^"]*"/y, 'name'],
  [/\{/y, 'block'],
  [/#/y, 'other'],
  [/,/y, 'comma'],
  [/:::/y, 'classes'],
  [/:/y, 'colon'],
  [/\[/y, 'open'],
  [/\]/y, 'close'],
  [/(?:style|classDef)\b[^\n]*/iy, 'skip'],
  [/class\b/iy, 'class'],
  [/subgraph\b/iy, 'subgraph'],
  [/end\b\s*/iy, 'end'],
  [/one or zero\b|one or more\b|one or many\b|1\+|\|o\b|zero or one\b|zero or more\b|zero or many\b|0\+|\}o\b|many\(0\)|many\(1\)|many\b|\}\||one\b|only one\b/iy, 'card'],
  [/[0-9]+\.[0-9]+/y, 'name'],
  [/1(?=\s+[A-Za-z_"']|\s+[0-9]|--|\.\.|\.-|-\.)/y, 'card'],
  [/1\b|[0-9]+/y, 'name'],
  [/\|\||o\||o\{|\|\{|u(?=[.\-|])/iy, 'card'],
  [/\.\.|--|to\b|optionally to\b|\.-|-\./iy, 'rel'],
  [/(?:[\u0080-￿]|[\w.*-])+/y, 'name'],
  [/[\s\S]/y, 'other'],
];
// A line that says "direction LR" (or TB, BT, RL) sets the diagram's direction, whatever else it says.
const DIRECTION = /[^\n]*direction\s+(?:TB|BT|RL|LR)[^\n]*/iy;

// The source split into tokens, as Mermaid's lexer splits it; an entity's
// attributes, up to the } that closes them, are one.
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  let lineStart = true;
  while (at < text.length) {
    if (lineStart) {
      DIRECTION.lastIndex = at;
      if (DIRECTION.test(text)) {
        at = DIRECTION.lastIndex;
        continue;
      }
    }
    for (const [rule, kind] of RULES) {
      rule.lastIndex = at;
      if (!rule.test(text)) continue;
      let end = rule.lastIndex;
      // Its attributes: their comments ("…") and backquoted names may hold a }.
      if (kind === 'block') {
        while (end < text.length && text[end] !== '}') {
          const mark = text[end];
          const close = mark === '"' || mark === '`' ? text.indexOf(mark, end + 1) : -1;
          end = close >= 0 ? close + 1 : end + 1;
        }
        end = Math.min(end + 1, text.length);
      }
      if (kind !== 'skip') tokens.push({ kind, start: at, end });
      lineStart = kind === 'nl' || kind === 'end' || (kind === 'skip' && lineStart);
      at = end;
      break;
    }
  }
  return tokens;
}

// Reads an entity relationship diagram's entities and relationships, in the
// order the source gives them. Null when the source isn't one.
export function readEr(source: string): Flowchart | null {
  const text = source
    .replace(/^\s*---\n[\s\S]*?\n---[ \t]*\n/, '') // front matter
    .split('\n')
    .filter((line) => !/^\s*%%/.test(line)) // comments and directives
    .join('\n');
  const header = text.match(HEADER);
  if (!header) return null;
  const body = text.slice(header[0].length);

  const aliases = new Map<string, string | undefined>(); // each entity by its name, with the alias it is shown by
  const clusters = new Set<string>(); // subgraphs, which aren't entities
  const arrows: FlowArrow[] = [];
  // As Mermaid keeps them: the first alias an entity is given stays.
  const meet = (name: string, alias?: string) => {
    if (!clusters.has(name) && !aliases.get(name)) aliases.set(name, alias);
  };

  // Statements end with their line, and a subgraph's end with its word.
  const statements: Token[][] = [[]];
  for (const token of tokenize(body)) {
    if (token.kind !== 'nl') statements[statements.length - 1].push(token);
    if (token.kind === 'nl' || token.kind === 'end') statements.push([]);
  }

  for (const statement of statements) {
    const kind = (i: number) => statement[i]?.kind;
    // A name as Mermaid takes it: a quoted one without its quotes.
    const name = (i: number) => body.slice(statement[i].start, statement[i].end).replace(/"/g, '');
    let at = 1;
    const skipClasses = () => {
      if (kind(at) !== 'classes') return;
      at++;
      while (kind(at) === 'name' || kind(at) === 'comma') at++;
    };

    // A subgraph groups entities: subgraph Sales, or subgraph sales [Sales team].
    if (kind(0) === 'subgraph') {
      if (kind(1) !== 'name') continue;
      const words: string[] = [];
      for (let i = 1; kind(i) === 'name'; i++) words.push(name(i));
      clusters.add(kind(2) === 'open' ? words[0] : words.join(' '));
      continue;
    }
    if (kind(0) !== 'name' || !name(0)) continue;
    const from = name(0);

    // An entity on its own, with its alias, its classes and its attributes: p[Person]:::hot { string name }.
    let alias: string | undefined;
    if (kind(1) === 'open' && kind(2) === 'name' && kind(3) === 'close') {
      alias = name(2);
      at = 4;
    }
    skipClasses();
    if (alias !== undefined || kind(at) !== 'card' || kind(at + 1) !== 'rel' || kind(at + 2) !== 'card' || kind(at + 3) !== 'name' || !name(at + 3)) {
      meet(from, alias);
      continue;
    }

    // A relationship, CUSTOMER ||--o{ ORDER : places, its label required.
    const to = name(at + 3);
    at += 4;
    skipClasses();
    if (kind(at) !== 'colon') continue;
    meet(from);
    meet(to);
    const n = arrows.filter((a) => a.from === from && a.to === to).length;
    const label = cleanLabel(body.slice(statement[at].end, statement[statement.length - 1].end));
    const id = `R_${from}_${to}_${n}`;
    // Names may hold _, so two pairs could make the same id: the later one is told apart by where it comes.
    arrows.push({ id: arrows.some((a) => a.id === id) ? `${id}~${arrows.length}` : id, from, to, n, ...(label ? { label } : {}) });
  }

  // A subgraph named before it is drawn is still not an entity.
  const nodes = [...aliases].filter(([id]) => !clusters.has(id)).map(([id, alias]) => ({ id, label: cleanLabel(alias ?? id) || id }));
  return { nodes, arrows };
}

export const er: DiagramReader = {
  kind: 'er',
  named: 'entity relationship diagram',
  words: { node: 'entity', nodes: 'entities', arrow: 'relationship', arrows: 'relationships' },
  link: '--',
  quotesText: true,
  read: readEr,
};
