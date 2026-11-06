import type { Tool } from '../tool';
import { boardTools } from './boards';
import { canvasTools } from './canvas';
import { commentTools } from './comments';
import { connectorTools } from './connectors';
import type { ToolContext } from './context';
import { guideTool } from './guide';
import { decisionTools } from './decisions';
import { taskTools } from './tasks';
import { threadTools } from './threads';
import { updateTools } from './updates';

// Every tool the server registers, by area: a new tool goes in its area's
// file, or in a file of its own added here. read_guide comes last: it holds
// the guide every other tool writes.
export function allTools(context: ToolContext): Tool[] {
  const tools = [
    ...boardTools(context),
    ...decisionTools(context),
    ...taskTools(context),
    ...commentTools(context),
    ...threadTools(context),
    ...canvasTools(context),
    ...updateTools(context),
    ...connectorTools(context),
  ];
  return [...tools, guideTool(tools)];
}
