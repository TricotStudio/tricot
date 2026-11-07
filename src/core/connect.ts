// What each agent is told to run to join a board. The Connect panel and the
// `tricot connect` command both build it here, so they say the same thing,
// quoted the same way. `url` is the MCP address already named (?agent=Pi). A
// `token` is only given when the board listens beyond this machine; Codex and
// Pi then read it from TRICOT_TOKEN, so it stays out of their config files.

export const TOKEN_ENV = 'TRICOT_TOKEN';

// The shell a command is shown for: zsh or bash (macOS and Linux), or
// PowerShell, the default in Windows Terminal. PowerShell 5, the one Windows
// ships with, has no `&&` and no `export`, and quotes a word differently.
export type Shell = 'posix' | 'powershell';

export const shellFor = (windows: boolean): Shell => (windows ? 'powershell' : 'posix');

// One word of a command, as it must be typed into zsh (the Mac's default shell)
// or bash: bare when every character is plain, in double quotes when nothing in
// it means anything there, else in single quotes. Unquoted, the `?` of an
// address is a glob to zsh ("no matches found"), and an `&` ends the command.
const PLAIN = /^[\w@%+:,./-][\w@%+=:,./-]*$/;
const LIVE_IN_DOUBLE_QUOTES = /[$`\\"!]/;

// In PowerShell a word is bare when it is made of letters, digits and a few
// marks that mean nothing there (not `,`, which makes a list, nor `%` or
// `~`, nor a leading `@`, which splats), else in single quotes, in which
// nothing means anything but the quote itself, written twice. PowerShell 5
// reads the curly single quotes as quotes too.
const POWERSHELL_PLAIN = /^[\w+:./\\-][\w+=:./\\@-]*$/;
const POWERSHELL_QUOTES = /['‘’‚‛]/g;

const powershellString = (text: string): string => `'${text.replace(POWERSHELL_QUOTES, (quote) => quote + quote)}'`;

export function shellQuote(word: string, shell: Shell = 'posix'): string {
  if (shell === 'powershell') return POWERSHELL_PLAIN.test(word) ? word : powershellString(word);
  if (PLAIN.test(word)) return word;
  if (!LIVE_IN_DOUBLE_QUOTES.test(word)) return `"${word}"`;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

// A command, to type as it is. In PowerShell a program whose name needs
// quotes is started with `&`: a quoted word alone is only a string there.
export function shellCommand(words: string[], shell: Shell = 'posix'): string {
  const line = words.map((word) => shellQuote(word, shell)).join(' ');
  return shell === 'powershell' && line.startsWith("'") ? `& ${line}` : line;
}

// Commands to run one after the other, the next only if the one before worked:
// one line with `&&`; in PowerShell 5, which has none, a line each.
export const shellChain = (commands: string[], shell: Shell = 'posix'): string => commands.join(shell === 'powershell' ? '\n' : ' && ');

// Setting an environment variable for what this shell runs next. `value` is
// a word as it is shown (a token, or <token>).
export function setEnvironment(name: string, value: string, shell: Shell = 'posix'): string {
  return shell === 'powershell' ? `$env:${name} = ${powershellString(value)}` : `export ${name}=${shellQuote(value)}`;
}

// What the person is told of the line that sets the token, in a sentence, and
// of the window it is run in.
export const tokenLineName = (shell: Shell = 'posix'): string => (shell === 'powershell' ? `the $env:${TOKEN_ENV} line` : 'the export');
export const shellNoun = (shell: Shell = 'posix'): string => (shell === 'powershell' ? 'PowerShell' : 'shell');

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
export function exportToken(token: string, shell: Shell = 'posix'): string {
  return setEnvironment(TOKEN_ENV, token, shell);
}

// Claude Code sends the token as a header, so it stays out of the URL and of
// `claude mcp list`. `scope` is where it keeps the entry: user (the default
// here: its own settings, every session in every folder) or project
// (.mcp.json). Its own default, local, is for the one folder the command is
// run in, which is not "every session". The words are what `tricot connect
// claude` runs; the command is what it prints, quoted for a shell.
export function claudeWords(url: string, { token, scope = 'user' }: { token?: string; scope?: string } = {}): string[] {
  const header = token ? ['--header', `Authorization: Bearer ${token}`] : [];
  return ['claude', 'mcp', 'add', '--scope', scope, '--transport', 'http', 'tricot', url, ...header];
}

export function claudeCommand(url: string, options: { token?: string; scope?: string; shell?: Shell } = {}): string {
  return shellCommand(claudeWords(url, options), options.shell);
}

// Codex's and Pi's `mcp add` have no header option; each reads a bearer token
// from an environment variable, which the command names and never holds.
function readingToken(words: string[], token: string | undefined, shell?: Shell): string[] {
  return token ? [exportToken(token, shell), shellCommand(words, shell)] : [shellCommand(words, shell)];
}

export function codexWords(url: string, token?: string): string[] {
  const add = ['codex', 'mcp', 'add', 'tricot', '--url', url];
  return token ? [...add, '--bearer-token-env-var', TOKEN_ENV] : add;
}

export function codexLines(url: string, token?: string, shell?: Shell): string[] {
  return readingToken(codexWords(url, token), token, shell);
}

// Pi: `pi mcp add` writes ~/.pi/agent/mcp.json. Its default exposure (codemode)
// reaches the board's tools through scripts, which works for them.
export function piWords(url: string, token?: string): string[] {
  const add = ['pi', 'mcp', 'add', 'tricot', '--url', url];
  return token ? [...add, '--bearer-token-env-var', TOKEN_ENV] : add;
}

export function piLines(url: string, token?: string, shell?: Shell): string[] {
  return readingToken(piWords(url, token), token, shell);
}

// Any other client that speaks Streamable HTTP, as an .mcp.json entry.
export function mcpJsonEntry(url: string, token?: string) {
  const headers = token ? { headers: { Authorization: `Bearer ${token}` } } : {};
  return { type: 'http', url, ...headers };
}

// OMP has no `mcp add` outside a session, so it is an entry for its mcp.json.
// Its calls time out after 30 seconds unless told otherwise, so the entry asks
// for 300 seconds (in milliseconds), and a wait for updates ends inside that
// (its registry entry, agents/omp/server.ts). A longer one here would not let
// waits run longer: entries people already have still say 300.
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
// Its calls wait up to 10 minutes by default, and a wait for updates ends inside that (agents/gemini/server.ts).
export function geminiWords(url: string, token?: string): string[] {
  const add = ['gemini', 'mcp', 'add', '--scope', 'user', '--transport', 'http'];
  return token ? [...add, '--header', `Authorization: Bearer \${${TOKEN_ENV}}`, 'tricot', url] : [...add, 'tricot', url];
}

export function geminiLines(url: string, token?: string, shell?: Shell): string[] {
  return readingToken(geminiWords(url, token), token, shell);
}

// Grok Build: `grok mcp add` keeps the entry in ~/.grok/config.toml for every
// session with --scope user (its default; `--scope project` is ./.grok/config.toml).
// It has a header option, stores the value as written and expands ${VAR} in
// a header when it loads its config, so with a token the header names
// TRICOT_TOKEN (single quotes keep the shell from expanding it) and the token
// stays out of the file. A call there may run for 100 minutes, so a wait for
// updates needs no limit of its own (agents/grok/server.ts).
export function grokWords(url: string, token?: string): string[] {
  const add = ['grok', 'mcp', 'add', '--scope', 'user', '--transport', 'http'];
  return token ? [...add, '--header', `Authorization: Bearer \${${TOKEN_ENV}}`, 'tricot', url] : [...add, 'tricot', url];
}

export function grokLines(url: string, token?: string, shell?: Shell): string[] {
  return readingToken(grokWords(url, token), token, shell);
}

// OpenCode 1 adds a server only by asking questions (`opencode mcp add`), so
// it is an entry for opencode.json, which OpenCode 2 reads too. Its {env:…}
// puts the token in from the environment. In OpenCode 1 a call gives up
// after a minute unless told otherwise, so the entry asks for 300 seconds, as
// OMP's does (OpenCode 2 reads it as the limit for connecting, listing and
// each call), and a wait for updates ends inside that (agents/opencode/server.ts).
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
export function opencode2Lines(url: string, token?: string, shell?: Shell): string[] {
  const add = ['opencode', 'mcp', 'add', 'tricot', '--url', url, '--global'];
  if (!token) return [shellCommand(add, shell)];
  return [exportToken(token, shell), shellCommand([...add, '--header', `Authorization=Bearer {env:${TOKEN_ENV}}`], shell)];
}

// Goose: `goose configure` only asks questions, so it is an entry for the
// extensions in its config.yaml (a YAML file: yamlText). A call gives up
// after the entry's timeout, in seconds (300 unless set), whatever progress
// comes, and the entry says it as OMP's does (agents/goose/server.ts). With a
// token, `headers` names TRICOT_TOKEN, which `env_keys` has Goose take from its
// environment, so the token stays out of the file. The entry is named
// tricot, so the tools Goose lists are tricot__… (the steps hook reads that).
// What of this is not confirmed is listed in agents/goose/index.ts.
export const GOOSE_FILE = '~/.config/goose/config.yaml';
export const GOOSE_WINDOWS_FILE = '%APPDATA%\\Block\\goose\\config\\config.yaml';

export function gooseEntry(url: string, token?: string) {
  const headers = token ? { env_keys: [TOKEN_ENV], headers: { Authorization: `Bearer \${${TOKEN_ENV}}` } } : {};
  return { name: 'tricot', type: 'streamable_http', uri: url, enabled: true, timeout: OMP_TIMEOUT_MS / 1000, ...headers };
}

export function gooseConfig(url: string, token?: string) {
  return { extensions: { tricot: gooseEntry(url, token) } };
}

// Hermes: `hermes mcp add` asks questions (it connects, then asks which tools
// to enable, and keeps a token in its own .env), so it is an entry for the
// mcp_servers in its config.yaml. A call gives up after `timeout` seconds
// (300 unless set), and the entry says so. Its ${VAR} in `headers` is filled
// from its environment or ~/.hermes/.env, and the connection fails when the
// variable is not set, so the token stays out of the file and a missing one is
// said. What of this is not confirmed is listed in agents/hermes/index.ts.
export const HERMES_FILE = '~/.hermes/config.yaml';

export function hermesEntry(url: string, token?: string) {
  const headers = token ? { headers: { Authorization: `Bearer \${${TOKEN_ENV}}` } } : {};
  return { url, timeout: OMP_TIMEOUT_MS / 1000, ...headers };
}

export function hermesConfig(url: string, token?: string) {
  return { mcp_servers: { tricot: hermesEntry(url, token) } };
}

// Claude Code's steps hook (`tricot steps on --agent claude --project`) and the other
// agents' are set up by the hook installers, in src/server/hooks/.

// Without its own `tricot` entry, OMP borrows Claude Code's and the agent
// shows on the board as "Claude".
export const OMP_WHY =
  'OMP also reads Claude Code\'s servers. Without an entry of its own named tricot it borrows that one, and shows on the board as "Claude".';
