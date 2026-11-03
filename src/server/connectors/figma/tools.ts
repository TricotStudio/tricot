// Figma's MCP tool: read a frame (as a picture) and its comments.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { figmaTarget } from '../../../core/connectors/figma/frame';
import { clip } from '../../../core/format';
import { BoardError, type Store } from '../../../core/store';
import type { ConnectorTool } from '../connector';
import { ConnectorError } from '../oauth';
import type { FigmaComment, FigmaFrames, FrameRead } from './frames';

const MAX_COMMENTS = 50;

const inputs = {
  block_id: z.string().optional().describe('A link block whose address is a Figma frame'),
  url: z.string().optional().describe('Or a Figma frame address (with node-id)'),
};

// What a person does about each way Figma can't be read, said for an agent.
const ACCESS: Record<string, string> = {
  not_connected: "Figma isn't connected, so agents can't read Figma frames. A person pastes a Figma token on the Connectors page. Ask them (comment or ask_people) if you need it; don't retry until they have.",
  needs_sign_in:
    'Figma no longer accepts the saved token. A person pastes a new one on the Connectors page. Ask them (comment or ask_people) if you need it; don\'t retry until they have.',
  token_refused:
    'Figma no longer accepts the saved token. A person pastes a new one on the Connectors page. Ask them (comment or ask_people) if you need it; don\'t retry until they have.',
};

function refusal(error: unknown): CallToolResult {
  if (!(error instanceof Error)) throw error;
  const message = error instanceof ConnectorError && error.code ? (ACCESS[error.code] ?? error.message) : error.message;
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

const day = (iso?: string) => (iso ? iso.slice(0, 10) : 'unknown date');

// The comments on a frame, each thread's replies under it, oldest first.
function commentLines(comments: FigmaComment[]): string[] {
  const roots = comments.filter((c) => !c.parent_id);
  const reply = (c: FigmaComment) => `${c.user?.handle ?? 'Someone'}, ${day(c.created_at)}: "${clip((c.message ?? '').replace(/\s+/g, ' '), 500)}"`;
  return roots.slice(0, MAX_COMMENTS).flatMap((root) => [
    `- ${reply(root)}${root.resolved_at ? ' (resolved)' : ''}`,
    ...comments.filter((c) => c.parent_id === root.id).map((c) => `  - ${reply(c)}`),
  ]);
}

export function frameText(read: FrameRead, address: string): string {
  const { comments } = read;
  const roots = comments.filter((c) => !c.parent_id).length;
  const edited = read.modifiedTime ? `, edited ${day(read.modifiedTime)}` : '';
  const head = `Figma frame "${clip(read.name, 120)}" in "${clip(read.fileName, 120)}"${edited}: ${address}`;
  if (read.commentsProblem) return `${head}\nComments: couldn't be read. ${read.commentsProblem}`;
  if (roots === 0) return `${head}\nComments: none on this frame.`;
  const more = roots > MAX_COMMENTS ? `\n(${roots - MAX_COMMENTS} more not shown)` : '';
  return `${head}\nComments (${roots}), with who and when:\n${commentLines(comments).join('\n')}${more}`;
}

export function figmaTools(store: Store, frames: FigmaFrames): ConnectorTool[] {
  return [
    {
      name: 'read_figma_frame',
      config: {
        title: 'Read Figma frame',
        description:
          "Read a Figma frame through the people's Figma connector: the frame as a picture, and its comments (who, what, when). Pass block_id of a link block pointing at a frame, or a frame url. Refused until a person connects Figma.",
        inputSchema: inputs,
        annotations: { readOnlyHint: true },
      },
      async run(args) {
        try {
          const { block_id, url } = args as { block_id?: string; url?: string };
          if (!block_id === !url) throw new BoardError('Pass either block_id or url.');
          const address = block_id ? linkAddress(store, block_id) : url!;
          const target = figmaTarget(address);
          if (!target) throw new BoardError("That isn't a Figma file address (figma.com/design/…).");
          if (!target.nodeId) {
            throw new BoardError('That link is to a whole Figma file. In Figma, select a frame and Copy link to selection, then pass that link.');
          }
          const read = await frames.read(target);
          return {
            content: [
              { type: 'text' as const, text: frameText(read, address) },
              { type: 'image' as const, data: read.picture.toString('base64'), mimeType: 'image/png' },
            ],
          };
        } catch (error) {
          return refusal(error);
        }
      },
    },
  ];
}

function linkAddress(store: Store, blockId: string): string {
  const block = store.blockOf(blockId);
  if (block.type !== 'link') throw new BoardError(`"${blockId}" is not a link block.`);
  return block.url;
}
