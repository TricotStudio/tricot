import { ApiParts } from './apiParts';
import { ToolGroups } from './mcp/toolGroups';
import type { Edition } from './start';

// What Tricot Canvas is on the server: the core and the canvas, with no
// part. Every registry a server with a part fills is built empty, so there are no
// REST routes of the parts of Tricot (a part's route answers the plain 404, and
// /api/info lists no part), no groups of MCP tools (an agent has the board's
// own 26 tools, and the core's short neutral instructions), and a Store of no
// part: a plain Store, which reads and writes none of a part's lists, owners,
// dismissals or event subjects, and is named for what it is (`edition`),
// which the lock says and an update restarts. A board's data is the same: what
// a server with a part stored of its cards stays in it, untouched, for
// the next one to open; this file names none of a part's, so it builds in
// a tree without them. Each call builds registries of its own, as an app does.
// What a person calls it, as every edition says its own name.
export const CANVAS_TITLE = 'Tricot Canvas';

export function canvasEdition(): Edition {
  return { parts: new ApiParts(), toolGroups: new ToolGroups(), edition: 'canvas' };
}
