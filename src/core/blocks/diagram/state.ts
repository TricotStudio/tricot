// The states and transitions of a Mermaid state diagram (stateDiagram and
// stateDiagram-v2, which Mermaid draws alike), read from its source as a
// flowchart's nodes and arrows are (flowchart.ts), into the same shape
// (readers.ts): a state is a node, by its id in the source, its text the name
// it is shown by (its first description, else its id). A composite state is
// a node, and so is each state inside it; a choice, a fork and a join are
// nodes too. A transition is an arrow from one state to another, the n-th
// between them, its text what it says after the colon.
//
// The start and end markers ([*]) are nodes as Mermaid names them: the
// diagram's are root_start and root_end, those inside the composite Busy
// Busy_start and Busy_end, so a [*] in each composite is a point of its own.
// They read as "start", "end", "start of Busy" and "end of Busy", and are
// listed after the states. The concurrent regions of a composite (split by
// --) are read as the composite's, their markers included.
//
// It reads the common syntax, not all of it: a part it can't read can't be
// pinned, and the diagram still renders as Mermaid draws it.

import { cleanLabel, type FlowArrow, type Flowchart } from './flowchart';
import type { DiagramReader } from './readers';

const HEADER = /^stateDiagram(?:-v2)?(?=\s|$)/;
// A state as a transition or a statement names it: its id (no spaces, colons,
// dashes or braces) or the start or end marker, with any class (Idle:::hot).
const STATE = String.raw`(\[\*\]|[^:\s{-]+)(?::::[^:\s{-]+)?`;
// A transition: its states and what it says after a colon, up to a ;.
const TRANSITION = new RegExp(String.raw`^${STATE}[ \t]*-->[ \t]*${STATE}[ \t]*(?::([^;]*))?`);
// A state on its own, or with a description: Waiting : for input.
const NAMED = new RegExp(String.raw`^${STATE}[ \t]*(?::([^;]*))?$`);
// state Busy {, state "Doing work" as Busy {: a composite, or with its text a state of its own.
const COMPOSITE = /^state[ \t]+([^\s{]+)[ \t]*\{$/i;
const ALIASED = /^state[ \t]+"([^"]*)"[ \t]*as[ \t]+([^{]*?)[ \t]*(\{)?$/i;
// state if_ok <<choice>>, state f [[fork]]: a choice, a fork or a join.
const SPECIAL = /^state[ \t]+(.+?)[ \t]*(?:<<(?:choice|fork|join)>>|\[\[(?:choice|fork|join)\]\])/i;
// A note on a state, on one line or up to its end note; one on its own (note "…" as N) isn't drawn.
const NOTE = /^note[ \t]+(?:left|right)[ \t]+of[ \t]+([^:\s-]+)[ \t]*(:)?/i;
// Lines that style, lay out or describe rather than name states and
// transitions: Mermaid takes any line that sets a direction as doing so.
const NOT_DRAWN =
  /^(?:classDef|class|style|click|scale|hide[ \t]+empty[ \t]+description|accTitle|accDescr|note|state)\b|^--$|direction[ \t]+(?:TB|BT|RL|LR)/i;

// Reads a state diagram's states and transitions, in the order the source
// gives them, Mermaid's own. Null when the source isn't a state diagram.
export function readState(source: string): Flowchart | null {
  const lines = source
    .replace(/^\s*---\n[\s\S]*?\n---[ \t]*\n/, '') // front matter
    .split('\n')
    .filter((line) => !/^\s*(?:%%|#)/.test(line)) // comments and directives
    .map((line) => line.trim());
  while (lines.length && !lines[0]) lines.shift();
  const header = lines[0]?.match(HEADER);
  if (!header) return null;
  lines[0] = lines[0].slice(header[0].length).trim();

  const labels = new Map<string, string>();
  const described = new Set<string>();
  // The start and end markers met, by their id, with the composite each is in.
  const markers = new Map<string, { end: boolean; in?: string }>();
  const arrows: FlowArrow[] = [];
  const inside: string[] = []; // the composites the line is in, the innermost last

  // A state met, its text its first description.
  const meet = (id: string, description?: string) => {
    if (!labels.has(id)) labels.set(id, id);
    const text = description === undefined ? '' : cleanLabel(description);
    if (text && !described.has(id)) {
      labels.set(id, text);
      described.add(id);
    }
  };
  // A state as named, the [*] at a transition's start or end as Mermaid names it.
  const stateOf = (named: string, end: boolean): string => {
    if (named !== '[*]') {
      meet(named);
      return named;
    }
    const composite = inside.at(-1);
    const id = `${composite ?? 'root'}_${end ? 'end' : 'start'}`;
    if (!markers.has(id)) markers.set(id, { end, in: composite });
    return id;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line === '}') {
      inside.pop();
      continue;
    }
    const special = line.match(SPECIAL);
    if (special) {
      meet(special[1]);
      continue;
    }
    const composite = line.match(COMPOSITE);
    if (composite) {
      meet(composite[1]);
      inside.push(composite[1]);
      continue;
    }
    const aliased = line.match(ALIASED);
    if (aliased) {
      // state "Long name" as Ln : more text: the id is before the colon.
      const id = aliased[2].split(':')[0].trim();
      if (!id) continue;
      meet(id, aliased[1]);
      if (aliased[3]) inside.push(id);
      continue;
    }
    const note = line.match(NOTE);
    if (note) {
      meet(note[1]); // a note on a state Mermaid hasn't met draws it
      if (!note[2]) while (i + 1 < lines.length && !/^end[ \t]+note\b/i.test(lines[++i]));
      continue;
    }
    if (/^accDescr[ \t]*\{/i.test(line)) {
      while (!lines[i].includes('}') && i + 1 < lines.length) i++;
      continue;
    }
    if (NOT_DRAWN.test(line)) continue;
    const transition = line.match(TRANSITION);
    if (transition) {
      const from = stateOf(transition[1], false);
      const to = stateOf(transition[2], true);
      const n = arrows.filter((a) => a.from === from && a.to === to).length;
      const label = cleanLabel(transition[3] ?? '');
      arrows.push({ id: `T_${from}_${to}_${n}`, from, to, n, ...(label ? { label } : {}) });
      continue;
    }
    const named = line.match(NAMED);
    if (named && named[1] !== '[*]') meet(named[1], named[2]);
    else if (named) stateOf(named[1], false);
  }

  // The markers after the states, read by the composite they are in.
  const marker = ([id, { end, in: composite }]: [string, { end: boolean; in?: string }]) => {
    const word = end ? 'end' : 'start';
    return { id, label: composite ? `${word} of ${labels.get(composite) ?? composite}` : word };
  };
  return { nodes: [...[...labels].map(([id, label]) => ({ id, label })), ...[...markers].map(marker)], arrows };
}

export const state: DiagramReader = {
  kind: 'state',
  named: 'state diagram',
  words: { node: 'state', nodes: 'states', arrow: 'transition', arrows: 'transitions' },
  link: '-->',
  quotesText: true,
  read: readState,
};
