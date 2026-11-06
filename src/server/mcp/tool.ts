import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { z, ZodRawShape } from 'zod';
import type { GuideTopic } from './guide';

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// One tool, as the agent meets it: its name, title and description, the
// arguments it takes (schema: none, for a tool that takes none), whether it
// leaves the board as it was (readOnly) or removes something (destructive),
// and what it does. A tool is defined in its area's file (tools/) and nowhere else.
//
// The description says what the tool does and what to pass: every session
// carries it, so it stays under MAX_DESCRIPTION. How to use the tool well (when,
// what people expect, how it fits the others) is its guide: read_guide gives it
// by topic, when the agent needs it (guide.ts).
export interface ToolDef<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  guide?: { topic: GuideTopic; text: string };
  schema?: Shape;
  readOnly?: boolean;
  destructive?: boolean;
  // How the session treats a call to it (session.ts): its result already brings the agent up to date on the board.
  catchesUp?: boolean;
  // It is how the agent listens: it shows as listening for the whole call, and isn't a look at any card.
  listens?: boolean;
  // It takes a first look at a card: the agent shows on the card only once it is given.
  takesFirstLook?: boolean;
  handler(args: z.output<z.ZodObject<Shape>>, extra: Extra): Promise<CallToolResult>;
}

// Any tool, whatever its arguments: what a list of them holds.
export type Tool = ToolDef<any>;

// Checks a tool's handler against its own schema, so its arguments are typed.
export function defineTool<Shape extends ZodRawShape = {}>(tool: ToolDef<Shape>): Tool {
  return tool;
}

// Where a tool's description sends the agent for its guide.
export const guidePointer = (topic: GuideTopic): string => `Guide: read_guide("${topic}").`;

// What the SDK is registered with: the annotations only where a tool has one.
export function configOf(tool: Tool): { title: string; description: string; inputSchema?: ZodRawShape; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } } {
  return {
    title: tool.title,
    description: tool.guide ? `${tool.description} ${guidePointer(tool.guide.topic)}` : tool.description,
    ...(tool.schema && { inputSchema: tool.schema }),
    ...(tool.readOnly && { annotations: { readOnlyHint: true } }),
    ...(tool.destructive && { annotations: { destructiveHint: true } }),
  };
}

export function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}
