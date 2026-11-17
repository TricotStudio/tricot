// What only REST and MCP need of diagram blocks: the fields and schemas they read, and what agents are told.
// The web build leaves this file out (see vite.config.ts), so zod and the advice stay on the server.

import { z } from 'zod';
import type { DiagramTypes } from './index';
import { arrowQuote } from './quote';
import { readFlowchart, type Flowchart } from './flowchart';
import type { AgentHalf, BlockOf, PartWords, PeopleHalf, ServerHalf } from '../kind';
import { blockNamed, partAsksDigest, type AskWords } from '../asks';
import { pinWhere } from '../../digest';
import { pinPart } from '../../pins';
import { missing, more } from '../shared';
import { BoardError } from '../../store/errors';
import { blockLabel } from '../../canvas';
import { clip, listNames } from '../../format';
import { LIMITS, limited, required } from '../../store/validate';
import type { PinAnchor } from '../../types';

const diagramSource = (source: string | undefined) => limited(required(source, 'diagram source'), LIMITS.text, 'Diagram source');

// A diagram's words without its Mermaid syntax: a flowchart's node and arrow
// text, or for other kinds the text in quotes and brackets and after colons.
function diagramText(source: string): string {
  const chart = readFlowchart(source);
  if (chart) {
    // A node with no text of its own reads as its id: keep it only if it says something.
    const nodes = chart.nodes.filter((n) => n.label !== n.id || n.id.length > 3).map((n) => n.label);
    const labels = [...nodes, ...chart.arrows.flatMap((a) => (a.label ? [a.label] : []))];
    for (const match of source.matchAll(/^[ \t]*subgraph[ \t]+(.+)$/gm)) labels.push(match[1].replace(/^[\w-]+[ \t]*\[(.*)\]$/, '$1'));
    return [...new Set(labels.map((l) => l.replace(/^"|"$/g, '').trim()).filter(Boolean))].join(' · ');
  }
  const parts: string[] = [];
  const syntax = /"([^"\n]+)"|\[([^\]\n]+)\]|\(([^)\n]+)\)|\{([^}\n]+)\}|\|([^|\n]+)\||:[ \t]*([^\n]+)|^[ \t]*(?:title|section)[ \t]+([^\n]+)/gm;
  for (const match of source.matchAll(syntax)) {
    const text = match.slice(1).find((group) => group !== undefined);
    if (text?.trim()) parts.push(text.replace(/<br\s*\/?>/gi, ' ').trim());
  }
  return [...new Set(parts)].join(' · ');
}

// The diagram's flowchart, for pinning its nodes and arrows.
function flowchartOf(block: DiagramBlock): Flowchart {
  const chart = readFlowchart(block.source);
  if (!chart) throw new BoardError(`Nodes and arrows are pinned in flowcharts, and ${blockLabel(block)} isn't one. Pin the whole diagram instead.`);
  return chart;
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

type DiagramBlock = BlockOf<DiagramTypes>;

// A flowchart's nodes and arrows take requests (core/parts.ts): people point
// at a box, an arrow or its label in its full view and ask an agent to change
// it, which it does in the diagram's Mermaid source.
const part: PartWords = {
  kind: 'diagram',
  anchors: ['node', 'arrow'],
  ask: {
    verb: 'change',
    asking: 'asking agents to change it in the diagram',
    doing: "Change the diagram's source with update_block, then reply",
    act: "change the diagram's source with update_block, then ",
    request: 'request to change the diagram, ',
    what: 'the nodes and arrows of a diagram',
  },
};

const ask: AskWords = {
  part: ({ pin, block }) => `${pinPart(pin, block)}${pinWhere(pin, block)} of ${blockNamed(block, 'diagram')}`,
  how: ({ block }) => `Change the diagram's Mermaid source with update_block (block_id: ${block.id}, source: the whole source)`,
  view: 'the diagram',
};

export const agent: AgentHalf<DiagramTypes> = {
  addShape: { source: z.string().optional().describe('Mermaid diagram source, e.g. "flowchart LR\\n  A --> B"') },
  updateShape: { source: z.string().optional() },
  docs: { brief: 'diagram → source (Mermaid)', add: 'diagram → source (Mermaid)', update: 'source' },
  read(args) {
    if (!args.source) throw missing('diagram', 'source');
    const source = args.source as string;
    return () => ({ type: 'diagram', source });
  },
  patch: (args) => ({ source: args.source as string | undefined }),
  asks: partAsksDigest(part, ask),
  pinShape: {
    node: z.string().optional().describe('A flowchart node, by its id in the Mermaid source (or its text)'),
    to_node: z.string().optional().describe('With node: the arrow from node to this node; occurrence picks one of several'),
  },
  pinPart(block, args) {
    if (args.node === undefined && args.to_node === undefined) return undefined;
    if (args.node === undefined) throw new BoardError('to_node needs node: the arrow goes from node to to_node.');
    if (['text', 'item', 'row', 'to_row', 'column', 'to_column'].some((name) => args[name] !== undefined)) {
      throw new BoardError('Pin a diagram part with node (and to_node for an arrow) only.');
    }
    // A node by its id, or by its text as it reads.
    const chart = block.type === 'diagram' ? readFlowchart(block.source) : null;
    const nodeId = (name: string) =>
      chart?.nodes.find((n) => n.id === name.trim())?.id ?? chart?.nodes.find((n) => sameText(n.label, name))?.id ?? name.trim();
    if (args.to_node === undefined) return { kind: 'node', nodeId: nodeId(args.node as string) };
    return { kind: 'arrow', from: nodeId(args.node as string), to: nodeId(args.to_node as string), n: ((args.occurrence as number | undefined) ?? 1) - 1 };
  },
};

export const people: PeopleHalf = {
  create: z.object({ type: z.literal('diagram'), source: z.string() }),
  patch: { source: z.string().optional() },
  // A flowchart's node by its id, or its arrow by the nodes it joins (the n-th between them).
  parts: {
    node: z.object({ kind: z.literal('node'), nodeId: z.string() }),
    arrow: z.object({ kind: z.literal('arrow'), from: z.string(), to: z.string(), n: z.number().int().min(0).optional() }),
  },
};

export const server: ServerHalf<DiagramTypes> = {
  patchFields: ['source'],

  create: (input) => ({ source: diagramSource(input.source) }),

  change({ block, patch }) {
    if (patch.source === undefined) return undefined;
    const source = diagramSource(patch.source);
    return {
      apply() {
        block.source = source;
      },
    };
  },

  describe: (before, after) => (before.source !== after.source ? ['edited the diagram'] : []),
  snapshot: (block) => ({ source: block.source }),
  restorePatch: (version) => ({ source: version.source }),

  digest: (block, full) => ['```mermaid', full ? block.source : more(block.source), '```'].join('\n'),
  searchText: (block) => [diagramText(block.source)],

  anchor(block, part) {
    if (part.kind === 'node') {
      const chart = flowchartOf(block);
      const node = chart.nodes.find((n) => n.id === part.nodeId);
      if (!node) {
        const names = listNames(chart.nodes.slice(0, 20).map((n) => n.id));
        throw new BoardError(`${blockLabel(block)} has no node "${clip(part.nodeId, 60)}".${names ? ` Its nodes: ${names}.` : ''}`);
      }
      return { anchor: { kind: 'node', nodeId: node.id, label: node.label }, quote: clip(node.label, LIMITS.title) };
    }
    if (part.kind !== 'arrow') return undefined;
    const chart = flowchartOf(block);
    const arrows = chart.arrows.filter((a) => a.from === part.from && a.to === part.to);
    const n = part.n ?? 0;
    const arrow = Number.isInteger(n) ? arrows[n] : undefined;
    if (!arrow) {
      const ends = `from "${clip(part.from, 40)}" to "${clip(part.to, 40)}"`;
      throw new BoardError(
        arrows.length
          ? `${blockLabel(block)} has ${arrows.length} arrow${arrows.length === 1 ? '' : 's'} ${ends}, so arrow ${n + 1} isn't there.`
          : `${blockLabel(block)} has no arrow ${ends}.`,
      );
    }
    const anchor: PinAnchor = { kind: 'arrow', from: arrow.from, to: arrow.to, n: arrow.n, ...(arrow.label ? { label: arrow.label } : {}) };
    return { anchor, quote: arrowQuote(chart, arrow) };
  },
  part,

  agent,
  people,
};
