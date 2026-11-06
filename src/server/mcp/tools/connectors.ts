import { defineTool, type Tool } from '../tool';
import type { ToolContext } from './context';

// The connectors' own tools, after the board's (read_google_doc, edit_google_doc…).
export function connectorTools({ store, getActor, options }: ToolContext): Tool[] {
  return (options.connectors?.tools(store) ?? []).map((connectorTool) =>
    defineTool({
      name: connectorTool.name,
      title: connectorTool.config.title,
      description: connectorTool.config.description,
      schema: connectorTool.config.inputSchema,
      readOnly: connectorTool.config.annotations?.readOnlyHint === true,
      handler: (args) => connectorTool.run(args, getActor()),
    }),
  );
}
