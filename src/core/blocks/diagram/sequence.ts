// The participants and messages of a Mermaid sequence diagram, read from its
// source as a flowchart's nodes and arrows are (flowchart.ts), into the same
// shape (readers.ts): a participant or an actor is a node, by its id in the
// source, its text the name it is shown by; a message is an arrow from its
// sender to its receiver, the n-th between them, its text what it says. It
// reads the common syntax, not all of it: a part it can't read can't be
// pinned, and the diagram still renders as Mermaid draws it.

import { cleanLabel, type FlowArrow, type Flowchart } from './flowchart';
import type { DiagramReader } from './readers';

const HEADER = /^sequenceDiagram\b[ \t]*;?/;
// A participant or an actor, declared: participant A, actor B as Bob, create
// participant C, participant D@{ "type": "database" } as Data.
const DECLARED = /^(?:create[ \t]+)?(?:participant|actor)[ \t]+(.+?)(?:[ \t]+as[ \t]+(.+))?$/;
// Lines that group, note or number rather than declare or send: notes, the
// blocks (loop, alt and else, opt, par and and, critical and option, break,
// rect, box) and their end, activation, destruction, numbering, links, titles.
const NOT_SENT =
  /^(?:note|loop|alt|else|opt|par|par_over|and|critical|option|break|rect|box|end|activate|deactivate|destroy|autonumber|links?|properties|details|title|accTitle|accDescr)\b/i;
// A message: its sender, its arrow (the longest first), an activation mark, its receiver, and what it says after a colon.
const MESSAGE = /^(.+?)[ \t]*(<<-->>|<<->>|-->>|->>|--x|-x|--\)|-\)|-->|->)[ \t]*([+-]?)[ \t]*([^:]+?)[ \t]*(?::(.*))?$/;

// A participant's id as a message or a declaration names it, without its metadata (@{ … }).
const participantId = (raw: string) => raw.replace(/@\{.*\}\s*$/, '').trim();

// Reads a sequence diagram's participants and messages, in the order the
// source gives them. Null when the source isn't a sequence diagram.
export function readSequence(source: string): Flowchart | null {
  const lines = source
    .replace(/^\s*---\n[\s\S]*?\n---[ \t]*\n/, '') // front matter
    .split(/\n|;(?<!#\w+;)/) // a ; ends a statement too, unless it ends an entity code (#59;)
    .filter((line) => !/^\s*%%/.test(line)) // comments and directives
    .map((line) => line.trim());
  while (lines.length && !lines[0]) lines.shift();
  const header = lines[0]?.match(HEADER);
  if (!header) return null;
  lines[0] = lines[0].slice(header[0].length).trim();

  const labels = new Map<string, string>();
  const arrows: FlowArrow[] = [];
  const meet = (id: string, label?: string) => {
    if (label || !labels.has(id)) labels.set(id, label || labels.get(id) || id);
  };

  for (const line of lines) {
    if (!line || NOT_SENT.test(line)) continue;
    const declared = line.match(DECLARED);
    if (declared) {
      const id = participantId(declared[1]);
      if (id) meet(id, declared[2] ? cleanLabel(declared[2]) : undefined);
      continue;
    }
    const message = line.match(MESSAGE);
    if (!message) continue;
    const from = participantId(message[1]);
    const to = participantId(message[4]);
    if (!from || !to) continue;
    meet(from);
    meet(to);
    const n = arrows.filter((a) => a.from === from && a.to === to).length;
    const label = cleanLabel((message[5] ?? '').replace(/^[ \t]*(?:no)?wrap:/, ''));
    arrows.push({ id: `M_${from}_${to}_${n}`, from, to, n, ...(label ? { label } : {}) });
  }

  return { nodes: [...labels].map(([id, label]) => ({ id, label })), arrows };
}

export const sequence: DiagramReader = {
  kind: 'sequence',
  named: 'sequence diagram',
  words: { node: 'participant', nodes: 'participants', arrow: 'message', arrows: 'messages' },
  link: '->>',
  quotesText: true,
  read: readSequence,
};
