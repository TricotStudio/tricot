// The labelled pieces of a Mermaid diagram of a kind no other reader reads
// (readers.ts): a mindmap's nodes, a Gantt chart's tasks and sections, a pie
// chart's slices, a timeline's periods and events, a Git graph's commits,
// tags and branches, a journey's tasks, a quadrant chart's points, a kanban
// board's cards, a requirement, a C4 element... Each is a node whose id is its
// text as it reads, which the page finds by the words Mermaid draws
// (web/canvas/blocks/diagram/drawn/pieces.ts). It reads no arrows: where a
// kind draws an arrow's text, that text is a piece too. Titles and the
// names of axes and sections are pieces, being words the source writes;
// values, ticks, percentages and what Mermaid adds of its own are not. Two
// pieces with the same words are one node, which a pin marks both of.
//
// It reads each kind's common syntax (KINDS), and of a kind it doesn't know,
// a future one included, its titles and sections and the text in quotes and
// square brackets. A piece it can't read can't be pinned, and the diagram
// still renders as Mermaid draws it.

import { cleanLabel } from './flowchart';
import type { DiagramRead, DiagramReader } from './readers';

// A kind: what it is called, and the pieces its lines name (trimmed, without
// comments, accessibility text or the header's own word).
type Kind = { named: string; read(lines: string[]): string[] };

// The kinds other readers read exactly (flowchart.ts, sequence.ts,
// classDiagram.ts, state.ts, er.ts), which this one leaves to them: one they
// can't read is not read by its pieces either.
const READ_ELSEWHERE = /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram)/;

const titleOf = (line: string) => line.match(/^title[ \t]+(.+)$/)?.[1];
const sectionOf = (line: string) => line.match(/^(?:title|section)[ \t]+(.+)$/)?.[1];
const quoted = (text: string) => [...text.matchAll(/"([^"\n]*)"/g)].map((match) => match[1]);
// The items of a list, split at commas outside quotes: [jan, "feb, early", mar].
const items = (text: string) => (text.match(/"[^"]*"|[^,]+/g) ?? []).map((item) => item.trim());
const isNumber = (text: string) => /^[-+]?[\d.,]+%?$/.test(text);
// A call's arguments: Person(user, "Customer", "A customer").
const args = (text: string) => (text.match(/"[^"]*"|[^,]+/g) ?? []).map((arg) => arg.trim());

// A node with a shape, as a mindmap or a kanban board writes one: its text
// inside the shape (root((Plan)), id[Text], Ship))Go live(( ), else the line.
const SHAPED: Record<string, string> = { '((': '))', '))': '((', '{{': '}}', '[': ']', '(': ')', ')': '(' };
function shapedText(line: string): string {
  const shaped = line.match(/^[^\s[({)]*?(\(\(|\)\)|\{\{|\[|\(|\))(.*)$/);
  const close = shaped && SHAPED[shaped[1]];
  const inner = shaped?.[2].trimEnd();
  return close && inner?.endsWith(close) ? inner.slice(0, -close.length) : line;
}

// What a Gantt chart's lines set rather than draw.
const GANTT_SETTINGS = /^(?:dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|weekday|weekend|inclusiveEndDates|topAxis|displayMode|click)\b/i;
// The kinds of requirement, and an element, as a requirement diagram declares them.
const REQUIREMENT = /^(?:requirement|functionalRequirement|interfaceRequirement|performanceRequirement|physicalRequirement|designConstraint|element)[ \t]+("[^"]*"|[^\s{]+)/;
// A relationship, by its kind: a - satisfies -> b, or b <- satisfies - a.
const RELATIONSHIP = /^\S+[ \t]+<?-[ \t]*([A-Za-z]+)[ \t]*->?[ \t]+\S+$/;

const mindmap: Kind = { named: 'mindmap', read: (lines) => lines.filter((line) => !/^::icon\(|^:::/.test(line)).map(shapedText) };

const c4: Kind = {
  named: 'C4 diagram',
  // An element's name (its second argument), a relationship's text (its third: Rel(a, b, "Uses")).
  read: (lines) =>
    lines.flatMap((line) => {
      const title = titleOf(line);
      if (title) return [title];
      const call = line.match(/^(\w+)[ \t]*\((.*)\)[ \t]*\{?$/);
      if (!call || /^(?:Update|Add|Show|Hide|Lay_)/i.test(call[1])) return [];
      const given = args(call[2]);
      const named = given.find((arg) => /^\$label[ \t]*=/.test(arg))?.replace(/^\$label[ \t]*=[ \t]*/, '');
      const at = /^RelIndex/i.test(call[1]) ? 3 : /^(?:Bi)?Rel/i.test(call[1]) ? 2 : 1;
      const text = named ?? given[at];
      return text ? [text] : [];
    }),
};

// Each kind by its header's word, in lower case without -beta or -v2.
const KINDS: Record<string, Kind> = {
  mindmap,
  kanban: { named: 'kanban board', read: (lines) => mindmap.read(lines.map((line) => line.replace(/@\{.*\}[ \t]*$/, '').trimEnd())) },
  // A period and its events: 2004 : Facebook : Google, or more events under it.
  timeline: { named: 'timeline', read: (lines) => lines.flatMap((line) => [sectionOf(line) ?? line.split(/[ \t]*:(?:[ \t]+|$)/)].flat()) },
  gantt: {
    named: 'Gantt chart',
    read: (lines) => lines.flatMap((line) => [sectionOf(line) ?? (GANTT_SETTINGS.test(line) ? [] : (line.match(/^([^:]+?)[ \t]*:/)?.[1] ?? []))].flat()),
  },
  // A task and who does it: Make tea: 5: Me, Cat.
  journey: {
    named: 'user journey',
    read: (lines) =>
      lines.flatMap((line) => {
        const task = line.match(/^([^:]+?)[ \t]*:[^:]*:(.*)$/);
        return [sectionOf(line) ?? (task ? [task[1], ...items(task[2])] : [])].flat();
      }),
  },
  // A commit's id and tag, a branch's name.
  gitgraph: {
    named: 'Git graph',
    read: (lines) =>
      lines.flatMap((line) => {
        const named = (key: string) => [...line.matchAll(new RegExp(`\\b${key}[ \\t]*:[ \\t]*"([^"]*)"`, 'g'))].map((match) => match[1]);
        if (/^cherry-pick\b/.test(line)) return named('tag');
        const branch = line.match(/^(?:branch|checkout|switch|merge)[ \t]+("[^"]*"|[^\s"]+)/);
        return [...(branch ? [branch[1]] : []), ...named('id'), ...named('tag')];
      }),
  },
  pie: {
    named: 'pie chart',
    read: (lines) =>
      lines.flatMap((line) => {
        const title = titleOf(line.replace(/^showData\b[ \t]*/, ''));
        return [title ?? line.match(/^"([^"]*)"[ \t]*:/)?.[1] ?? []].flat();
      }),
  },
  // Its quadrants, points and the ends of its axes: x-axis Low Reach --> High Reach.
  quadrantchart: {
    named: 'quadrant chart',
    read: (lines) =>
      lines.flatMap((line) => {
        const axis = line.match(/^[xy]-axis[ \t]+(.+?)(?:[ \t]*-->[ \t]*(.*))?$/);
        if (axis) return [axis[1], axis[2] ?? ''];
        const point = line.match(/^(.+?)(?::::[\w-]+)?[ \t]*:[ \t]*\[/);
        return [titleOf(line) ?? line.match(/^quadrant-[1-4][ \t]+(.+)$/)?.[1] ?? point?.[1] ?? []].flat();
      }),
  },
  // Its title, its axes' titles and the categories along one: x-axis "Month" [jan, feb].
  xychart: {
    named: 'XY chart',
    read: (lines) =>
      lines.flatMap((line) => {
        const axis = line.match(/^[xy]-axis\b[ \t]*(.*)$/);
        if (!axis) return [titleOf(line) ?? []].flat();
        const title = axis[1].match(/^("[^"]*"|[^\s["\d-][^\s[]*)/)?.[1];
        const categories = items(axis[1].match(/\[(.*)\]/)?.[1] ?? '').filter((item) => !isNumber(item));
        return [...(title ? [title] : []), ...categories];
      }),
  },
  // Blocks, by their text or else their id, and the text on arrows: a["Front end"] b c, b -- "calls" --> c.
  block: {
    named: 'block diagram',
    read(lines) {
      const blocks = new Map<string, string | null>();
      const texts: string[] = [];
      const token =
        /"([^"]*)"|([\p{L}\p{N}_][\p{L}\p{N}_.]*)(?::\w+)*(?:[ \t]*(?:\[\[|\[\(|\(\(\(|\(\(|\(\[|\[\/|\[\\|\{\{|<\[|\[|\(|\{|>)[ \t]*("[^"]*"|[^"\])}>]*?)[ \t]*(?:\]\]|\)\]|\)\)\)|\)\)|\]\)|\/\]|\\\]|\}\}|\]>(?:\([^)]*\))?|\]|\)|\}))?(?::\d+)?/gu;
      for (const line of lines) {
        if (/^(?:columns|style|classDef|class|end)\b/.test(line)) continue;
        for (const [, text, id, shown] of line.matchAll(token)) {
          if (text !== undefined) texts.push(text);
          else if (id === 'block' || id === 'space') continue;
          else if (shown !== undefined) blocks.set(id, shown);
          else if (!blocks.has(id)) blocks.set(id, null);
        }
      }
      return [...[...blocks].map(([id, shown]) => shown ?? id), ...texts];
    },
  },
  // A requirement's or an element's name, and the kind of a relationship: a - satisfies -> b.
  requirementdiagram: {
    named: 'requirement diagram',
    read: (lines) => lines.flatMap((line) => [line.match(REQUIREMENT)?.[1] ?? line.match(RELATIONSHIP)?.[1] ?? []].flat()),
  },
  c4context: c4,
  c4container: c4,
  c4component: c4,
  c4dynamic: c4,
  c4deployment: c4,
  // A group's or a service's title: service db(database)[Database] in api.
  architecture: { named: 'architecture diagram', read: (lines) => lines.flatMap((line) => [line.match(/^(?:group|service)[ \t]+[\w-]+(?:\([^)]*\))?[ \t]*\[([^\]]*)\]/)?.[1] ?? []].flat()) },
  // A field: 0-15: "Source Port", +16: "Data".
  packet: { named: 'packet diagram', read: (lines) => lines.flatMap((line) => [titleOf(line) ?? line.match(/^(?:\d+(?:-\d+)?|\+\d+)[ \t]*:[ \t]*"([^"]*)"/)?.[1] ?? []].flat()) },
  // Its nodes, the first two values of each line: source,target,value.
  sankey: {
    named: 'Sankey diagram',
    read: (lines) =>
      lines.flatMap((line) =>
        [...line.matchAll(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)]
          .slice(0, 2)
          .map((match) => match[1].replace(/^"([\s\S]*)"$/, '$1').replace(/""/g, '"')),
      ),
  },
  // Its axes and curves, by their text or else their id: axis m["Math"], s; curve a["Alice"]{1, 2}.
  radar: {
    named: 'radar chart',
    read: (lines) =>
      lines.flatMap((line) => {
        const listed = line.match(/^(?:axis|curve)[ \t]+(.*)$/)?.[1];
        if (listed === undefined) return [titleOf(line) ?? []].flat();
        return [...listed.matchAll(/([\w-]+)[ \t]*(?:\[[ \t]*"?([^"\]]*)"?[ \t]*\])?(?:[ \t]*\{[^}]*\})?/g)].map((match) => match[2] ?? match[1]);
      }),
  },
  treemap: { named: 'treemap', read: (lines) => lines.flatMap((line) => [line.match(/^"([^"]*)"/)?.[1] ?? []].flat()) },
};

// A kind it doesn't know: its titles and sections, and its text in quotes and square brackets.
const anyKind: Kind = {
  named: 'diagram',
  read: (lines) =>
    lines.flatMap((line) => {
      const titled = sectionOf(line);
      if (titled) return [titled];
      const bracketed = [...line.matchAll(/\[([^\]"\n]+)\]/g)].map((match) => match[1]).filter((text) => !items(text).every(isNumber));
      return [...quoted(line), ...bracketed];
    }),
};

// Reads the labelled pieces of a diagram of a kind the other readers leave,
// in the order the source gives them, each once. Null when the source has no
// kind to read, or is of a kind another reader reads.
export function readPieces(source: string): DiagramRead | null {
  const front = source.match(/^\s*---\n([\s\S]*?)\n---[ \t]*\n/);
  const lines = (front ? source.slice(front[0].length) : source)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('%%'));
  const header = lines.shift()?.match(/^([A-Za-z][\w-]*)\b[ \t]*(.*)$/);
  if (!header || READ_ELSEWHERE.test(header[1])) return null;
  if (header[2]) lines.unshift(header[2]);

  // Accessibility text isn't drawn: accTitle: …, accDescr: … and accDescr { … }.
  let describing = false;
  const drawn = lines.filter((line) => {
    if (describing) return !(describing = !line.includes('}'));
    if (/^accDescr[ \t]*\{/.test(line)) return !(describing = !line.includes('}'));
    return !/^acc(?:Title|Descr)[ \t]*:/.test(line);
  });

  const word = header[1].toLowerCase().replace(/-(?:beta|v\d+)$/, '');
  const kind = KINDS[word] ?? anyKind;
  const title = front?.[1].match(/^title[ \t]*:[ \t]*(.+)$/m)?.[1];
  const texts = new Set([...(title ? [title] : []), ...kind.read(drawn)].map(cleanLabel).filter(Boolean));
  return { nodes: [...texts].map((text) => ({ id: text, label: text })), arrows: [], named: kind.named };
}

export const pieces: DiagramReader = {
  kind: 'pieces',
  named: 'diagram',
  words: { node: 'piece', nodes: 'pieces', arrow: 'arrow', arrows: 'arrows' },
  link: '-->',
  byText: true,
  read: readPieces,
};
