// What the `tricot` commands and the board they reach ask of each other, as
// one number: the protocol. The board says its own at GET
// /api/info, beside its version, and the oldest command's it still serves; a
// command that reaches a board reads both there (cli/boardVersion.ts) and
// refuses plainly, naming the update, when the board is too old for it or it
// is too old for the board, instead of failing on a route, a tool or an
// option the other lacks.
//
// A number of its own, not the version: the version moves with every release,
// most of which change nothing the commands ask of the board, and run from a
// checkout the version is the last release's while the code is newer (the
// board that handed 0.1.6 a `tricot listen` it didn't have said 0.1.6 too).
// The number changes in the same change as what it guards, so it travels with
// the code, whatever the package says.
//
// Raise PROTOCOL when the board starts serving something a command asks for (a
// route, an MCP tool or a reply it reads), or starts handing agents a command
// or an option: the commands that need it say so (cli/commands.ts needsBoard).
// Raise OLDEST_COMMAND to PROTOCOL's value when the board stops serving what
// older commands ask for: those then refuse, naming the update.
//
//   1  0.1.6 and before. A board that says no protocol is this one.
//   2  `tricot listen` and `tricot show`, and the routes and tools they use.
export const PROTOCOL = 2;

// The oldest command's protocol the board still serves.
export const OLDEST_COMMAND = 1;

// What GET /api/info says of the board's version, for a command to read.
export interface BoardInfo {
  app?: string; // 'tricot'
  version?: string;
  protocol?: number;
  oldestCommand?: number;
  parts?: string[]; // the board's API parts besides the core's (a part adds one); none said, by a board that predates it
}

const level = (value: unknown, otherwise: number): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : otherwise);

// The board's protocol: 1 from a board older than the number (0.1.6 and before).
export const protocolOf = (info: BoardInfo): number => level(info.protocol, 1);

// The oldest command's protocol it serves: any, from one that doesn't say.
export const oldestCommandOf = (info: BoardInfo): number => level(info.oldestCommand, 1);

// The ids of the API parts the board serves besides the core's: the full
// edition's one id with a part, [] on the canvas alone, and nothing from a board that doesn't say,
// which is not the same as none: it may be a part's, from before it said so. It
// is an addition to what the board says, so the protocol did not change with it.
export const partsOf = (info: BoardInfo): string[] | undefined =>
  Array.isArray(info.parts) && info.parts.every((id) => typeof id === 'string') ? info.parts : undefined;
