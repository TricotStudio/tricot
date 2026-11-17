// Pi for one session (`tricot pi`): `-e <file>` loads an extension for one run
// (https://pi.dev/docs/latest/extensions), and an extension can add an MCP
// server for the session it is loaded in with `pi.registerMcpServer` (the
// same entry as an `mcpServers` one in ~/.pi/agent/mcp.json, which Tricot
// never touches). Nothing is written to Pi's own folder: the extension is a
// small file in a folder made for this session (folder.ts), removed when Pi
// ends, and Pi's sign-in, models, sessions and settings are all where they were.
//
// With a token, the entry's header is `Bearer ${TRICOT_TOKEN}`, which Pi
// reads from its environment when it connects (its docs: `env` and `headers`
// values can use environment variables), so the token is in Pi's environment
// alone, as Codex's is: in no file, and not in the command line.
//
// The server is named tricot, as `tricot connect pi` names it. A server of that
// name in ~/.pi/agent/mcp.json (or a trusted project's .pi/mcp.json) takes
// precedence over one an extension adds (Pi's docs), so a person who has
// connected Pi by hand gets their own entry, which is the same board unless
// they changed it. Its calls wait 60 seconds unless told otherwise, so the
// entry asks for 300 (seconds, as Pi's docs have them; the same five minutes
// as OMP's and OpenCode's). Pi starts that over with each progress a wait for
// updates sends, so a wait may last longer (agents/pi/server.ts).
import { OMP_TIMEOUT_MS, TOKEN_ENV } from '../../core/connect';
import { SESSION_SERVER, type SessionLaunch, type SessionSetup } from '../../core/sessions';
import { sessionFolder, writeSessionFile } from './folder';

export const PI_EXTENSION_FILE = 'tricot.js';

// What the extension holds: Tricot's address with the agent's name on the board
// (?agent=Pi), and the header when the board needs a token. Plain JavaScript,
// which Pi loads as it does TypeScript, with no import.
export function piExtension(url: string, withToken: boolean): string {
  const entry = {
    url,
    ...(withToken && { headers: { Authorization: `Bearer \${${TOKEN_ENV}}` } }),
    timeout: OMP_TIMEOUT_MS / 1000,
  };
  return [
    "// Tricot's board for this Pi session only: made by `tricot pi`, removed when Pi ends.",
    'export default function (pi) {',
    `  pi.registerMcpServer(${JSON.stringify(SESSION_SERVER)}, ${JSON.stringify(entry)});`,
    '}',
    '',
  ].join('\n');
}

export function piSession({ url, token, message, passthrough }: SessionSetup): SessionLaunch {
  const folder = sessionFolder('pi');
  try {
    const file = writeSessionFile(folder.dir, PI_EXTENSION_FILE, piExtension(url, Boolean(token)));
    return { args: ['-e', file, ...passthrough, message], env: token ? { [TOKEN_ENV]: token } : {}, cleanup: folder.cleanup };
  } catch (error) {
    folder.cleanup();
    throw error;
  }
}
