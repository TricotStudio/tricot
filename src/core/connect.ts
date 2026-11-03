// What each agent is told to run to join a board. The Connect panel and the
// `tricot connect` command both build it here, so they say the same thing,
// quoted the same way. `url` is the MCP address already named (?agent=Pi). A
// `token` is only given when the board listens beyond this machine; Codex and
// Pi then read it from TRICOT_TOKEN, so it stays out of their config files.

export const TOKEN_ENV = 'TRICOT_TOKEN';

// One word of a command, as it must be typed into zsh (the Mac's default shell)
// or bash: bare when every character is plain, in double quotes when nothing in
// it means anything there, else in single quotes. Unquoted, the `?` of an
// address is a glob to zsh ("no matches found"), and an `&` ends the command.
const PLAIN = /^[\w@%+:,./-][\w@%+=:,./-]*$/;
const LIVE_IN_DOUBLE_QUOTES = /[$`\\"!]/;

export function shellQuote(word: string): string {
  if (PLAIN.test(word)) return word;
  if (!LIVE_IN_DOUBLE_QUOTES.test(word)) return `"${word}"`;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

export function shellCommand(words: string[]): string {
  return words.map(shellQuote).join(' ');
}

// The MCP address with the agent's name on the board (replacing any it had),
// and with `token` the token too, for clients that can't send a header.
export function agentUrl(mcpUrl: string, name?: string, token?: string): string {
  const at = mcpUrl.indexOf('?');
  const base = at < 0 ? mcpUrl : mcpUrl.slice(0, at);
  const replaced = [name && 'agent', token && 'token'].filter(Boolean);
  const kept = at < 0 ? [] : mcpUrl.slice(at + 1).split('&').filter((pair) => pair && !replaced.includes(pair.split('=')[0]));
  const added = [name && `agent=${encodeURIComponent(name)}`, token && `token=${encodeURIComponent(token)}`];
  const query = [...kept, ...added].filter(Boolean).join('&');
  return query ? `${base}?${query}` : base;
}

// Has its own line, with no comment after it: zsh doesn't take comments from
// the keyboard unless told to, so a pasted `# ...` would become arguments.
export function exportToken(token: string): string {
  return `export ${TOKEN_ENV}=${shellQuote(token)}`;
}

// Claude Code sends the token as a header, so it stays out of the URL and of
// `claude mcp list`. `scope` is where it keeps the entry (project: .mcp.json).
export function claudeCommand(url: string, { token, scope }: { token?: string; scope?: string } = {}): string {
  const where = scope ? ['--scope', scope] : [];
  const header = token ? ['--header', `Authorization: Bearer ${token}`] : [];
  return shellCommand(['claude', 'mcp', 'add', ...where, '--transport', 'http', 'tricot', url, ...header]);
}

// Codex's and Pi's `mcp add` have no header option; each reads a bearer token
// from an environment variable.
function readingToken(add: string[], token?: string): string[] {
  return token ? [exportToken(token), shellCommand([...add, '--bearer-token-env-var', TOKEN_ENV])] : [shellCommand(add)];
}

export function codexLines(url: string, token?: string): string[] {
  return readingToken(['codex', 'mcp', 'add', 'tricot', '--url', url], token);
}

// Pi: `pi mcp add` writes ~/.pi/agent/mcp.json. Its default exposure (codemode)
// reaches the board's tools through scripts, which works for them.
export function piLines(url: string, token?: string): string[] {
  return readingToken(['pi', 'mcp', 'add', 'tricot', '--url', url], token);
}

// Any other client that speaks Streamable HTTP, as an .mcp.json entry.
export function mcpJsonEntry(url: string, token?: string) {
  const headers = token ? { headers: { Authorization: `Bearer ${token}` } } : {};
  return { type: 'http', url, ...headers };
}

// OMP has no `mcp add` outside a session, so it is an entry for its mcp.json.
// Its calls time out after 30 seconds unless told otherwise, and wait_for_updates
// holds for up to 240, so the entry asks for 300 seconds (in milliseconds).
export const OMP_TIMEOUT_MS = 300_000;

export function ompEntry(url: string, token?: string) {
  const headers = token ? { headers: { Authorization: `Bearer \${${TOKEN_ENV}}` } } : {};
  return { type: 'http', url, timeout: OMP_TIMEOUT_MS, ...headers };
}

export function ompConfig(url: string, token?: string) {
  return { mcpServers: { tricot: ompEntry(url, token) } };
}

export const OMP_FILE = '~/.omp/agent/mcp.json';

// Gemini CLI: `gemini mcp add` keeps the entry in the project's
// .gemini/settings.json unless told --scope user (~/.gemini/settings.json,
// every session). It has a header option, and expands ${VAR} in its settings
// when it loads them, so with a token the header names TRICOT_TOKEN (single
// quotes keep the shell from expanding it) and the token stays out of the file.
// Its calls wait up to 10 minutes by default, past wait_for_updates' 240 seconds.
export function geminiLines(url: string, token?: string): string[] {
  const add = ['gemini', 'mcp', 'add', '--scope', 'user', '--transport', 'http'];
  if (!token) return [shellCommand([...add, 'tricot', url])];
  return [exportToken(token), shellCommand([...add, '--header', `Authorization: Bearer \${${TOKEN_ENV}}`, 'tricot', url])];
}

// OpenCode 1 adds a server only by asking questions (`opencode mcp add`), so
// it is an entry for opencode.json, which OpenCode 2 reads too. Its {env:…}
// puts the token in from the environment. In OpenCode 1 a call gives up
// after a minute unless told otherwise, and wait_for_updates holds for up to
// 240 seconds, so the entry asks for 300, as OMP's does (OpenCode 2 reads it
// as the limit for connecting, listing and each call).
export function opencodeEntry(url: string, token?: string) {
  const headers = token ? { headers: { Authorization: `Bearer {env:${TOKEN_ENV}}` } } : {};
  return { type: 'remote', url, timeout: OMP_TIMEOUT_MS, ...headers };
}

export function opencodeConfig(url: string, token?: string) {
  return { mcp: { tricot: opencodeEntry(url, token) } };
}

export const OPENCODE_FILE = '~/.config/opencode/opencode.json';

// OpenCode 2 has a command for it, writing the same file with --global (a
// call there may run for 12 hours by default, so it needs no timeout).
export function opencode2Lines(url: string, token?: string): string[] {
  const add = ['opencode', 'mcp', 'add', 'tricot', '--url', url, '--global'];
  if (!token) return [shellCommand(add)];
  return [exportToken(token), shellCommand([...add, '--header', `Authorization=Bearer {env:${TOKEN_ENV}}`])];
}

// What the Connect panel shows, and its Copy button copies, for each agent
// tool: each named on the board as the tool is. `other` is the bare address,
// for any client's settings rather than a shell.
export type PanelTool = 'claude' | 'codex' | 'pi' | 'omp' | 'gemini' | 'opencode' | 'other';

export function panelTexts(mcpUrl: string): Record<PanelTool, string> {
  return {
    claude: claudeCommand(agentUrl(mcpUrl, 'Claude')),
    codex: codexLines(agentUrl(mcpUrl, 'Codex')).join('\n'),
    pi: piLines(agentUrl(mcpUrl, 'Pi')).join('\n'),
    omp: JSON.stringify(ompConfig(agentUrl(mcpUrl, 'OMP')), null, 2),
    gemini: geminiLines(agentUrl(mcpUrl, 'Gemini')).join('\n'),
    opencode: JSON.stringify(opencodeConfig(agentUrl(mcpUrl, 'OpenCode')), null, 2),
    other: mcpUrl,
  };
}

// Claude Code's steps hook (`tricot connect claude --hooks`) and the other
// agents' are set up by the hook installers, in src/server/hooks/.

// Without its own `tricot` entry, OMP borrows Claude Code's and the agent
// shows on the board as "Claude".
export const OMP_WHY =
  'OMP also reads Claude Code\'s servers. Without an entry of its own named tricot it borrows that one, and shows on the board as "Claude".';
