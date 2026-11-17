import type { Tool } from '../tool';
import { ToolGroups } from '../toolGroups';
import { boardTools } from './boards';
import { canvasTools } from './canvas';
import { commentTools } from './comments';
import { connectorTools } from './connectors';
import type { ToolContext } from './context';
import { guideTool } from './guide';
import { threadTools } from './threads';
import { updateTools } from './updates';

// Every tool the server registers: the board's own, by area (a new tool goes
// in its area's file, or in a file of its own added here), with the tools of
// each group registered for this server among them (options.groups,
// toolGroups.ts: a part's cards). read_guide comes
// last: it holds the guide every other tool writes, and the topics the
// groups add.
export function allTools(context: ToolContext): Tool[] {
  const board = [
    ...boardTools(context),
    ...commentTools(context),
    ...threadTools(context),
    ...canvasTools(context),
    ...updateTools(context),
    ...connectorTools(context),
  ];
  const { tools, topics } = (context.options.groups ?? new ToolGroups()).compose(board, context, context.words);
  return [...tools, guideTool(tools, topics, context.words)];
}
