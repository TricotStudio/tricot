// The classes and relations of a Mermaid class diagram, read from its source
// as a flowchart's nodes and arrows are (flowchart.ts), into the same shape
// (readers.ts): a class is a node, by its name in the source, its text the
// name it is shown by (its label, and its generic type: List<T>); a relation
// is an arrow between the two classes in the order the source names them,
// the n-th between them, its text its label. Member lines (Animal : +int age)
// and annotations name a class and draw no arrow; namespaces, notes, styles
// and clicks are neither. It reads the common syntax, not all of it: a part
// it can't read can't be pinned, and the diagram still renders as Mermaid
// draws it.

import { cleanLabel, type FlowArrow, type Flowchart } from './flowchart';
import type { DiagramReader } from './readers';

const HEADER = /^classDiagram(?:-v2)?\b[ \t]*/;
// A class's name: in backticks, or letters, digits and _ with - and . where they can't start a line (-- or ..);
// then its generic type, between tildes: List~T~.
const NAME = String.raw`(?:\x60([^\x60]+)\x60|((?:[\p{L}\p{N}_]|-(?!-)|\.(?!\.))+))(?:~([^~]*)~)?`;
// What each end of a relation draws: <| or |> inheritance, * composition, o aggregation, < or > dependency, () a lollipop.
const END = String.raw`(?:<\||\|>|\*|o(?![\p{L}\p{N}_])|<|>|\(\))`;
// A relation: a class, its cardinality, the line (-- or ..) with its ends, the other's cardinality, the other class.
const RELATION = new RegExp(String.raw`^${NAME}[ \t]*(?:"[^"]*")?[ \t]*(${END})?(?:--|\.\.)(${END})?[ \t]*(?:"[^"]*")?[ \t]*${NAME}$`, 'u');
// A class declared: class Animal, class List~T~, class Animal["An animal"], then its style, annotation or body.
const DECLARED = new RegExp(String.raw`^class[ \t]+${NAME}(?:[ \t]*\[[ \t]*"([^"]*)"[ \t]*\])?(.*)$`, 'u');
// A member line: Animal : +int age.
const MEMBER = new RegExp(String.raw`^${NAME}$`, 'u');
// Lines that note, style, link or describe rather than declare or relate.
const NOT_DRAWN = /^(?:note|style|classDef|cssClass|callback|link|click|namespace)\b|^(?:<<|\}|accTitle[ \t]*:|accDescr[ \t]*:)|direction[ \t]+(?:TB|BT|RL|LR)/;

// A name as the source gives it: in backticks or not, with its generic type apart.
const named = (match: RegExpMatchArray, at: number) => ({ id: (match[at] ?? match[at + 1]).trim(), type: match[at + 2] });

// The source's text before its first colon outside quotes and backticks (a
// relation, or the class of a member line), and after it (a relation's
// label, or the member). A colon starts no style (:::) here.
function splitLabel(line: string): [string, string | undefined] {
  let quote = '';
  for (let at = 0; at < line.length; at++) {
    const char = line[at];
    if (quote) quote = char === quote ? '' : quote;
    else if (char === '"' || char === '`') quote = char;
    else if (char === ':') return [line.slice(0, at).trim(), line.slice(at + 1)];
  }
  return [line.trim(), undefined];
}

// Reads a class diagram's classes and relations, in the order the source
// gives them. Null when the source isn't a class diagram.
export function readClassDiagram(source: string): Flowchart | null {
  const lines = source
    .replace(/^\s*---\n[\s\S]*?\n---[ \t]*\n/, '') // front matter
    .split('\n')
    .filter((line) => !/^\s*%%/.test(line)) // comments and directives
    .map((line) => line.trim());
  while (lines.length && !lines[0]) lines.shift();
  const header = lines[0]?.match(HEADER);
  if (!header) return null;
  lines[0] = lines[0].slice(header[0].length).trim();

  const classes = new Map<string, { label: string; type?: string }>();
  const arrows: FlowArrow[] = [];
  // As Mermaid does: a class keeps the generic type it is first named with, and the label it is last given.
  const meet = (id: string, type?: string, label?: string) => {
    const known = classes.get(id);
    if (!known) classes.set(id, { label: label || id, ...(type ? { type } : {}) });
    else if (label) known.label = label;
  };
  let relations = 0; // Mermaid numbers its relations' ids from 1, lollipops included: id_Animal_Duck_1
  let inside = false; // in a class's body of members, or a multi-line description, until its }

  for (const line of lines) {
    if (inside) {
      inside = !line.includes('}');
      continue;
    }
    if (!line || NOT_DRAWN.test(line)) continue;
    if (/^accDescr[ \t]*\{/.test(line)) {
      inside = !line.includes('}');
      continue;
    }
    const declared = line.match(DECLARED);
    if (declared) {
      const { id, type } = named(declared, 1);
      meet(id, type, declared[4] === undefined ? undefined : cleanLabel(declared[4]));
      const body = declared[5].indexOf('{');
      inside = body >= 0 && !declared[5].includes('}', body);
      continue;
    }
    const [head, text] = splitLabel(line);
    const relation = head.match(RELATION);
    if (relation) {
      relations++;
      const a = named(relation, 1);
      const b = named(relation, 6);
      const [start, end] = [relation[4], relation[5]];
      // A lollipop is an interface its class provides, drawn as a ring: no class, and no arrow to pin.
      if (start === '()' && !end) meet(b.id, b.type);
      else if (end === '()' && !start) meet(a.id, a.type);
      else {
        meet(a.id, a.type);
        meet(b.id, b.type);
        const n = arrows.filter((r) => r.from === a.id && r.to === b.id).length;
        const label = text === undefined ? '' : cleanLabel(text);
        arrows.push({ id: `id_${a.id}_${b.id}_${relations}`, from: a.id, to: b.id, n, ...(label ? { label } : {}) });
      }
      continue;
    }
    const member = text === undefined ? null : head.match(MEMBER);
    if (member) {
      const { id, type } = named(member, 1);
      meet(id, type);
    }
  }

  const nodes = [...classes].map(([id, { label, type }]) => ({ id, label: type ? `${label}<${type}>` : label }));
  return { nodes, arrows };
}

export const classDiagram: DiagramReader = {
  kind: 'class',
  named: 'class diagram',
  words: { node: 'class', nodes: 'classes', arrow: 'relation', arrows: 'relations' },
  link: '--',
  quotesText: true,
  read: readClassDiagram,
};
