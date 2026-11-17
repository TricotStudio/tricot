// The nodes and arrows of a Mermaid flowchart, read from its source so that
// pins on them can be checked and found again without drawing it. It reads
// the common syntax, not all of it: a part it can't read can't be pinned, and
// the diagram still renders as Mermaid draws it.

export interface FlowNode {
  id: string; // as the source names it: Retry in Retry(Retry it)
  label: string; // as it reads: its shape's text, or its id when it has none
}

export interface FlowArrow {
  id: string; // Mermaid's id for it, which its drawn path carries: L_Client_Retry_0
  from: string;
  to: string;
  n: number; // which of the arrows from `from` to `to` it is, from 0
  label?: string;
}

export interface Flowchart {
  nodes: FlowNode[];
  arrows: FlowArrow[];
}

const HEADER = /^(?:flowchart|flowchart-elk|graph)\b(?:[ \t]+(?:TB|TD|BT|RL|LR))?[ \t]*;?/;
// Lines that style, group or describe rather than draw nodes and arrows.
const NOT_DRAWN = /^(?:classDef|class|style|linkStyle|click|direction)[ \t]|^(?:accTitle|accDescr)[ \t]*[:{]|^end\b/;
// A node's id: `-` and `.` only where they can't start an arrow.
const NODE_ID = /^(?:[\p{L}\p{N}_$]|\.(?![-=])|-(?![-.>=]))+/u;
// The shapes around a node's text, longest opening first, with how each closes.
const SHAPES: [string, string[]][] = [
  ['(((', [')))']],
  ['((', ['))']],
  ['([', ['])']],
  ['[[', [']]']],
  ['[(', [')]']],
  ['{{', ['}}']],
  ['[/', ['/]', '\\]']],
  ['[\\', ['\\]', '/]']],
  ['[', [']']],
  ['(', [')']],
  ['{', ['}']],
  ['>', [']']],
];
// Arrows without text: -->, ---, -.->, ==>, <-->, --o, ~~~ and longer ones.
const ARROW = /^(?:[<ox]?(?:-{2,}[>ox]|-{3,}|={2,}[>ox]|={3,}|-\.+-[>ox]?)|~{3,})/;
// Arrows with text in them: -- text -->, == text ==>, -. text .->
const TEXT_ARROW = /^[<ox]?(?:--|==|-\.)[ \t]*([^-=.>\s].*?)[ \t]*(?:-{2,}[>ox]|-{3,}|={2,}[>ox]|={3,}|\.-+[>ox]?)/;

const ENTITIES: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ' };

// A node's or arrow's text as it reads: no quotes, tags or entity codes.
function cleanLabel(raw: string): string {
  let text = raw.trim();
  for (const mark of ['"', '`']) {
    if (text.length >= 2 && text.startsWith(mark) && text.endsWith(mark)) text = text.slice(1, -1);
  }
  return text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[#&](quot|amp|lt|gt|nbsp);/g, (_, name: string) => ENTITIES[name])
    .replace(/\s+/g, ' ')
    .trim();
}

// Reads a flowchart's nodes and arrows, in the order the source gives them.
// Null when the source isn't a flowchart (a sequence diagram, say).
export function readFlowchart(source: string): Flowchart | null {
  const lines = source
    .replace(/^\s*---\n[\s\S]*?\n---[ \t]*\n/, '') // front matter
    .split('\n')
    .filter((line) => !/^\s*%%/.test(line)); // comments and directives
  while (lines.length && !lines[0].trim()) lines.shift();
  const header = lines[0]?.trim().match(HEADER);
  if (!header) return null;
  lines[0] = lines[0].trim().slice(header[0].length);

  const labels = new Map<string, string>();
  const arrows: FlowArrow[] = [];
  const clusters = new Set<string>();
  const arrowIds = new Set<string>();

  const addArrow = (from: string, to: string, label: string | undefined, given?: string) => {
    const n = arrows.filter((a) => a.from === from && a.to === to).length;
    // As Mermaid numbers them: an id the source gives, else L_from_to_0, then _2, _3…
    const id = given && !arrows.some((a) => a.id === given) ? given : `L_${from}_${to}_${n === 0 ? 0 : n + 1}`;
    if (given) arrowIds.add(given);
    arrows.push({ id, from, to, n, ...(label ? { label } : {}) });
  };

  for (const line of lines) {
    let at = 0;
    const rest = () => line.slice(at);
    const skipSpace = () => {
      while (at < line.length && (line[at] === ' ' || line[at] === '\t')) at++;
    };

    // A node: its id, then optionally its shape and text, classes and metadata.
    const readNode = (): string | null => {
      const id = rest().match(NODE_ID)?.[0];
      if (!id) return null;
      at += id.length;
      if (!labels.has(id)) labels.set(id, id);
      const shape = SHAPES.find(([open]) => rest().startsWith(open));
      if (shape) {
        const [open, closes] = shape;
        let from = at + open.length;
        let text: string | null = null;
        // Quoted text may hold the closing brackets.
        if (line[from] === '"') {
          const end = line.indexOf('"', from + 1);
          if (end > 0) {
            text = line.slice(from, end + 1);
            from = end + 1;
          }
        }
        const ends = closes.map((close) => [line.indexOf(close, from), close.length] as const).filter(([i]) => i >= 0);
        if (ends.length === 0) return null;
        const [end, length] = ends.reduce((a, b) => (b[0] < a[0] ? b : a));
        labels.set(id, cleanLabel(text ?? line.slice(from, end)) || id);
        at = end + length;
      }
      const classes = rest().match(/^:::[\w-]+/);
      if (classes) at += classes[0].length;
      if (rest().startsWith('@{')) {
        const end = line.indexOf('}', at);
        if (end < 0) return null;
        const meta = line.slice(at + 2, end);
        const label = meta.match(/\blabel\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,]+))/);
        if (label) labels.set(id, cleanLabel(label[1] ?? label[2] ?? label[3]) || id);
        at = end + 1;
      }
      return id;
    };

    // Nodes joined by &, which an arrow joins all of.
    const readNodes = (): string[] | null => {
      const ids: string[] = [];
      for (;;) {
        skipSpace();
        const id = readNode();
        if (!id) return null;
        ids.push(id);
        skipSpace();
        if (line[at] !== '&') return ids;
        at++;
      }
    };

    const readArrow = (): { label?: string; id?: string } | null => {
      const given = rest().match(/^([^\s"@&;|]+)@(?=[-=~.<ox])/);
      if (given) at += given[0].length;
      const plain = rest().match(ARROW);
      const texted = plain ? null : rest().match(TEXT_ARROW);
      const arrow = plain ?? texted;
      if (!arrow) return null;
      at += arrow[0].length;
      let label = texted ? cleanLabel(texted[1]) : undefined;
      const piped = rest().match(/^[ \t]*\|([^|]*)\|/);
      if (piped) {
        label = cleanLabel(piped[1]);
        at += piped[0].length;
      }
      return { label: label || undefined, id: given?.[1] };
    };

    // Statements: a chain of nodes and arrows, up to a ; or the line's end.
    while (at < line.length) {
      skipSpace();
      if (line[at] === ';') {
        at++;
        continue;
      }
      if (at >= line.length || NOT_DRAWN.test(rest())) break;
      const subgraph = rest().match(/^subgraph\b[ \t]*/);
      if (subgraph) {
        const id = line.slice(at + subgraph[0].length).match(NODE_ID)?.[0];
        if (id) clusters.add(id);
        break;
      }
      let before: string[] | null = null;
      let joining: { label?: string; id?: string } | null = null;
      for (;;) {
        const group = readNodes();
        if (!group) break;
        if (before && joining) {
          for (const from of before) {
            for (const to of group) {
              const first = from === before[before.length - 1] && to === group[0];
              addArrow(from, to, joining.label, first ? joining.id : undefined);
            }
          }
        }
        skipSpace();
        const arrow = readArrow();
        if (!arrow) break;
        before = group;
        joining = arrow;
      }
      skipSpace();
      if (line[at] !== ';') break; // something it can't read: the rest of the line is left
    }
  }

  // Subgraphs and arrows given ids (e1@{ animate: true }) aren't nodes.
  const nodes = [...labels].filter(([id]) => !clusters.has(id) && !arrowIds.has(id)).map(([id, label]) => ({ id, label }));
  return { nodes, arrows };
}
