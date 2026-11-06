// OMP for one session (`tricot omp`): `-e <folder>` loads an extension package
// for one run, and OMP reads the MCP servers an extension package holds
// (a `.mcp.json` in its folder) as it does those of its own config, ranked
// just below ~/.omp/agent/mcp.json and above the Claude Code, Codex and Gemini
// CLI files it also reads (its docs, "Discovery and precedence"). So the
// session's folder holds one file, the board's entry: no extension code, and
// nothing in ~/.omp, where OMP's sign-in, models and sessions stay. (OMP's
// `--config` overlay is for its settings, not for servers.)
//
// With a token, the entry's header is `Bearer ${TRICOT_TOKEN}`, which OMP
// fills in from its environment when it loads the file (its docs: `${VAR}`
// placeholders), so the token is in OMP's environment alone, as Codex's is:
// in no file, and not in the command line.
//
// The server is named tricot, as `tricot connect omp` names it. One of that
// name in ~/.omp/agent/mcp.json (or a project's .omp/mcp.json) ranks above the
// session's, so a person who has connected OMP by hand gets their own entry.
// Without either, OMP would borrow Claude Code's tricot entry, and show on the
// board as "Claude" (OMP_WHY); the session's has OMP's own name on it.
import { ompConfig, TOKEN_ENV } from '../../core/connect';
import type { SessionLaunch, SessionSetup } from '../../core/sessions';
import { sessionFolder, writeSessionFile } from './folder';

export const OMP_SESSION_FILE = '.mcp.json';

export function ompSession({ url, token, message, passthrough }: SessionSetup): SessionLaunch {
  const folder = sessionFolder('omp');
  try {
    writeSessionFile(folder.dir, OMP_SESSION_FILE, `${JSON.stringify(ompConfig(url, token), null, 2)}\n`);
    return { args: ['-e', folder.dir, ...passthrough, message], env: token ? { [TOKEN_ENV]: token } : {}, cleanup: folder.cleanup };
  } catch (error) {
    folder.cleanup();
    throw error;
  }
}
