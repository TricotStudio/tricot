import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CommandToRun } from '../src/cli/connectAgent';
import { runCli, type CliContext } from '../src/cli/main';
import { claudeCommand, codexLines, copilotLines, exportToken, geminiLines, grokLines, opencode2Lines, piLines, setEnvironment, shellChain, shellCommand, shellFor, shellQuote } from '../src/core/connect';
import { agentKinds, findAgent, installHints, panelTexts } from '../src/core/agents/registry';
import { howToUpdate, restartCommand } from '../src/install/handoff';
import { shellPath } from '../src/server/hooks/installer';
import { describe as describeStep } from '../hooks/tricot-describe.mjs';
import { removeScratch, WINDOWS } from './platform';

// What the person is shown to type, on Windows (PowerShell, the default in
// Windows Terminal), through the `platform` the commands take; and what is
// shown on macOS and Linux stays as it was.
const URL_ = 'http://127.0.0.1:4545/mcp?agent=Claude';
const TOKEN = 'Zm9vYmFyYmF6cXV4-dG9rZW4tZm9yLXRlc3Rz-0123456789';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Commands shown for PowerShell', () => {
  it('leaves a word bare when nothing in it means anything there, else single-quotes it, writing a quote twice', () => {
    for (const word of ['claude', '--scope', 'http://127.0.0.1:4545/mcp', 'C:\\Users\\sam\\x.tgz', 'a=b', 'tricot@1.2.3'.replace('@', '-')]) assert.equal(shellQuote(word, 'powershell'), word, word);
    assert.equal(shellQuote(URL_, 'powershell'), `'${URL_}'`, 'the ? and & of an address');
    assert.equal(shellQuote('', 'powershell'), "''");
    assert.equal(shellQuote('Authorization: Bearer abc', 'powershell'), "'Authorization: Bearer abc'");
    assert.equal(shellQuote("it's", 'powershell'), "'it''s'");
    assert.equal(shellQuote('it’s', 'powershell'), "'it’’s'", "PowerShell 5 takes a curly quote for a quote too");
    for (const word of ['a,b', '@x', '$env:X', '`id`', 'a;b', 'a|b', '(x)', '{x}', '#x', '%x%', '~', 'a"b']) assert.match(shellQuote(word, 'powershell'), /^'.*'$/s, word);
    assert.equal(shellQuote('$HOME `id` "x"', 'powershell'), '\'$HOME `id` "x"\'', 'nothing is expanded in single quotes');
  });

  it('starts a program whose name needs quotes with &, since a quoted word alone is only a string', () => {
    assert.equal(shellCommand(['C:\\Program Files\\x.exe', 'a b'], 'powershell'), "& 'C:\\Program Files\\x.exe' 'a b'");
    assert.equal(shellCommand(['claude', 'mcp'], 'powershell'), 'claude mcp');
  });

  it('sets an environment variable with $env:, and chains commands on lines of their own', () => {
    assert.equal(setEnvironment('TRICOT_TOKEN', TOKEN, 'powershell'), `$env:TRICOT_TOKEN = '${TOKEN}'`, 'always a string, even when it is plain');
    assert.equal(exportToken("a'b", 'powershell'), "$env:TRICOT_TOKEN = 'a''b'");
    assert.equal(shellChain(['tricot stop', 'tricot'], 'powershell'), 'tricot stop\ntricot');
    assert.equal(shellChain(['tricot stop', 'tricot'], 'posix'), 'tricot stop && tricot');
    assert.equal(shellFor(true), 'powershell');
    assert.equal(shellFor(false), 'posix');
  });

  it("gives each agent's connect command in PowerShell, with the token set on a line before it", () => {
    assert.equal(claudeCommand(URL_, { shell: 'powershell' }), `claude mcp add --scope user --transport http tricot '${URL_}'`);
    assert.equal(claudeCommand(URL_, { token: TOKEN, scope: 'project', shell: 'powershell' }), `claude mcp add --scope project --transport http tricot '${URL_}' --header 'Authorization: Bearer ${TOKEN}'`);
    const codexUrl = 'http://127.0.0.1:4545/mcp?agent=Codex';
    assert.deepEqual(codexLines(codexUrl, TOKEN, 'powershell'), [`$env:TRICOT_TOKEN = '${TOKEN}'`, `codex mcp add tricot --url '${codexUrl}' --bearer-token-env-var TRICOT_TOKEN`]);
    assert.deepEqual(piLines(codexUrl, undefined, 'powershell'), [`pi mcp add tricot --url '${codexUrl}'`]);
    assert.deepEqual(geminiLines(codexUrl, TOKEN, 'powershell').at(-1), `gemini mcp add --scope user --transport http --header 'Authorization: Bearer \${TRICOT_TOKEN}' tricot '${codexUrl}'`);
    assert.deepEqual(grokLines(codexUrl, TOKEN, 'powershell'), [`$env:TRICOT_TOKEN = '${TOKEN}'`, `grok mcp add --scope user --transport http --header 'Authorization: Bearer \${TRICOT_TOKEN}' tricot '${codexUrl}'`]);
    assert.deepEqual(opencode2Lines(codexUrl, TOKEN, 'powershell'), [`$env:TRICOT_TOKEN = '${TOKEN}'`, `opencode mcp add tricot --url '${codexUrl}' --global --header 'Authorization=Bearer {env:TRICOT_TOKEN}'`]);
    assert.deepEqual(copilotLines(codexUrl, TOKEN, 'powershell'), [`$env:TRICOT_TOKEN = '${TOKEN}'`, `copilot mcp add --transport http --timeout 300000 --header 'Authorization: Bearer \${TRICOT_TOKEN}' tricot '${codexUrl}'`]);
  });

  it('shows the same text as before on macOS and Linux, whether the shell is said or not', () => {
    assert.equal(claudeCommand(URL_), `claude mcp add --scope user --transport http tricot "${URL_}"`);
    assert.equal(claudeCommand(URL_, { shell: 'posix' }), claudeCommand(URL_));
    assert.deepEqual(codexLines(URL_, TOKEN), [`export TRICOT_TOKEN=${TOKEN}`, `codex mcp add tricot --url "${URL_}" --bearer-token-env-var TRICOT_TOKEN`]);
    assert.deepEqual(codexLines(URL_, TOKEN, 'posix'), codexLines(URL_, TOKEN));
    assert.deepEqual(opencode2Lines(URL_, TOKEN), opencode2Lines(URL_, TOKEN, 'posix'));
    assert.equal(shellCommand(['a b', "it's", '$x']), `"a b" "it's" '$x'`);
    assert.equal(exportToken('a b'), 'export TRICOT_TOKEN="a b"');
    assert.deepEqual(panelTexts('http://127.0.0.1:4545/mcp'), panelTexts('http://127.0.0.1:4545/mcp', 'posix'));
  });

  it('gives the Connect panel PowerShell commands when the page is on Windows', () => {
    const texts = panelTexts('http://127.0.0.1:4545/mcp', 'powershell');
    assert.equal(texts.claude, `claude mcp add --scope user --transport http tricot 'http://127.0.0.1:4545/mcp?agent=Claude'`);
    assert.equal(texts.codex, `codex mcp add tricot --url 'http://127.0.0.1:4545/mcp?agent=Codex'`);
    for (const kind of agentKinds()) if (kind.connect.how === 'command') assert.doesNotMatch(texts[kind.id], /"|&&|^export /m, kind.id);
  });

  it('gives the command to restart on a line for each, where there is no &&, and as before elsewhere', () => {
    const place = { port: 4600, host: '127.0.0.1', dataDir: 'C:\\Users\\sam\\boards of mine' };
    const defaults = { port: 4545, host: '127.0.0.1', dataDir: 'C:\\Users\\sam\\.tricot' };
    assert.equal(restartCommand(place, { defaults, platform: 'win32' }), "tricot stop --data 'C:\\Users\\sam\\boards of mine'\ntricot --port 4600 --data 'C:\\Users\\sam\\boards of mine'");
    assert.equal(restartCommand(place, { defaults, platform: 'win32', stop: false }), "tricot --port 4600 --data 'C:\\Users\\sam\\boards of mine'");
    assert.equal(restartCommand(place, { defaults, platform: 'win32', npx: true }), "npx tricot@latest stop --data 'C:\\Users\\sam\\boards of mine'\nnpx tricot@latest --port 4600 --data 'C:\\Users\\sam\\boards of mine'");
    const posix = { port: 4600, host: '127.0.0.1', dataDir: '/home/sam/boards of mine' };
    const posixDefaults = { port: 4545, host: '127.0.0.1', dataDir: '/home/sam/.tricot' };
    // Not given, the platform is this one's: on Windows, Windows'.
    for (const platform of WINDOWS ? (['darwin', 'linux'] as const) : ([undefined, 'darwin', 'linux'] as const)) {
      assert.equal(restartCommand(posix, { defaults: posixDefaults, ...(platform && { platform }) }), 'tricot stop --data "/home/sam/boards of mine" && tricot --port 4600 --data "/home/sam/boards of mine"');
    }
  });

  it('gives the update commands for PowerShell on Windows', () => {
    const place = { port: 4545, host: '127.0.0.1', dataDir: 'C:\\Users\\sam\\.tricot' };
    const defaults = place;
    const file = 'https://github.com/TricotStudio/tricot/releases/download/v0.2.0/tricot-0.2.0.tgz';
    const how = howToUpdate({ kind: 'npm-global', prefix: 'C:\\npm', writable: true }, place, { platform: 'win32', defaults, file });
    assert.ok(!how.self);
    assert.equal(how.command, `npm install -g ${file}`);
    assert.equal(how.restart, 'tricot stop\ntricot');
    const source = howToUpdate({ kind: 'source' }, place, { platform: 'win32', defaults });
    assert.ok(!source.self);
    assert.equal(source.command, 'git pull\nnpm install\nnpm run build');
    const mac = howToUpdate({ kind: 'source' }, { ...place, dataDir: '/x/.tricot' }, { platform: 'darwin', defaults: { ...defaults, dataDir: '/x/.tricot' } });
    assert.ok(!mac.self);
    assert.equal(mac.command, 'git pull && npm install && npm run build');
  });
});

describe('Where an agent is installed from, on Windows', () => {
  it("is Windows' own commands where the agent's docs give them, else the same as everywhere", () => {
    const first = (id: string, windows: boolean) => installHints(findAgent(id)!, windows).commands[0];
    assert.equal(first('claude', true), 'irm https://claude.ai/install.ps1 | iex');
    assert.equal(first('claude', false), 'curl -fsSL https://claude.ai/install.sh | bash');
    assert.equal(first('codex', true), 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"');
    assert.equal(first('pi', true), 'powershell -c "irm https://pi.dev/install.ps1 | iex"');
    assert.equal(first('omp', true), 'irm https://omp.sh/install.ps1 | iex');
    assert.equal(first('goose', true), 'Invoke-WebRequest -Uri "https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1" -OutFile "download_cli.ps1"; .\\download_cli.ps1');
    assert.equal(first('goose', false), 'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash');
    assert.equal(first('hermes', true), 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)');
    assert.equal(first('hermes', false), 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash');
    assert.deepEqual(installHints(findAgent('opencode')!, true).commands, ['npm install -g opencode-ai', 'scoop install opencode', 'choco install opencode']);
    // Gemini CLI's docs name no Windows command beyond npm's: the same list shows.
    assert.equal(findAgent('gemini')!.install.windows, undefined);
    assert.deepEqual(installHints(findAgent('gemini')!, true).commands, findAgent('gemini')!.install.commands);
    // Copilot CLI: WinGet, as GitHub's install page gives it first for Windows.
    assert.equal(first('copilot', true), 'winget install GitHub.Copilot');
    assert.equal(first('copilot', false), 'npm install -g @github/copilot');
    // Grok Build's install guide has its own PowerShell installer.
    assert.equal(first('grok', true), 'irm https://x.ai/cli/install.ps1 | iex');
    assert.equal(first('grok', false), 'curl -fsSL https://x.ai/cli/install.sh | bash');
    // Where Windows has its own list, it holds nothing made for macOS or Linux.
    for (const kind of agentKinds()) for (const command of kind.install.windows ?? []) assert.doesNotMatch(command, /\| *(ba)?sh\b|^brew /, `${kind.id}: a command for macOS or Linux on Windows`);
  });
});

describe('Hook commands on Windows', () => {
  it('writes the path of a hook script with forward slashes, which Git Bash, PowerShell and cmd.exe all leave alone', () => {
    assert.equal(shellPath('C:\\Users\\Sam Smith\\.claude\\hooks\\tricot-steps.mjs', 'win32'), '"C:/Users/Sam Smith/.claude/hooks/tricot-steps.mjs"');
    assert.equal(shellPath('\\\\server\\share\\tricot-steps.mjs', 'win32'), '"//server/share/tricot-steps.mjs"');
    assert.equal(shellPath('C:\\Users\\a$b\\x.mjs', 'win32'), '"C:/Users/a\\$b/x.mjs"', 'a $ still has its backslash, for bash');
  });

  it('writes it as before elsewhere', () => {
    assert.equal(shellPath('/home/sam/.claude/hooks/tricot-steps.mjs', 'linux'), '"/home/sam/.claude/hooks/tricot-steps.mjs"');
    assert.equal(shellPath('/home/a b/"x"/$y/`z`/a\\b', 'darwin'), '"/home/a b/\\"x\\"/\\$y/\\`z\\`/a\\\\b"');
    assert.equal(shellPath('/home/sam/x.mjs'), shellPath('/home/sam/x.mjs', 'linux'));
  });
});

describe('A step in words, on Windows', { skip: !WINDOWS && 'path.isAbsolute reads the paths of this system' }, () => {
  it('shows a path from the project, written with the system\'s separators, whichever way the command spells it', () => {
    const step = (tool_name: string, tool_input: unknown) => describeStep({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: 'C:\\proj' })?.text;
    assert.equal(step('Read', { file_path: 'C:\\proj\\src\\a.ts' }), 'Reading src\\a.ts');
    assert.equal(step('Bash', { command: 'node C:/proj/scripts/run.js --x' }), 'Running node scripts\\run.js');
    assert.equal(step('Bash', { command: 'node D:/elsewhere/run.js' }), 'Running node run.js', 'outside the project, just its name');
  });
});

// ---- the command's own text ----------------------------------------------------------------------

describe('tricot connect, on Windows', () => {
  let scratch: string;
  let dataDir: string;
  let bin: string;
  let out: string[];
  let err: string[];
  let ran: CommandToRun[];
  const port = 4545;

  const ctx = (platform?: NodeJS.Platform, env: NodeJS.ProcessEnv = {}): CliContext => ({
    env: { TRICOT_DATA_DIR: dataDir, PORT: String(port), PATH: bin, ...env },
    root: scratch,
    entry: path.join(repo, 'src/cli/tricot.ts'),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    open: () => {},
    cwd: scratch,
    ...(platform && { platform }),
    exec: async (command) => {
      if (command.args[1] === 'get') return { exitCode: 1, stdout: '', stderr: 'No MCP server named "tricot".' }; // the agent has none yet
      ran.push(command);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    ask: async () => true,
  });
  const said = () => out.join('\n');
  const withToken = () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, 'token'), `${TOKEN}\n`);
  };

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-windows-shell-'));
    dataDir = path.join(scratch, 'data');
    bin = path.join(scratch, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(scratch, 'package.json'), '{"name":"tricot","version":"9.9.9"}');
    for (const name of ['claude', 'codex']) {
      writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 99\n');
      chmodSync(path.join(bin, name), 0o755);
    }
    out = [];
    err = [];
    ran = [];
  });
  afterEach(() => removeScratch(scratch));

  it('prints the commands in PowerShell, and the token on a line of its own', async () => {
    withToken();
    await runCli(['connect', '--host', '0.0.0.0'], ctx('win32'));
    const url = (name: string) => `http://127.0.0.1:${port}/mcp?agent=${name}`;
    assert.match(said(), new RegExp(`^  \\$env:TRICOT_TOKEN = '${TOKEN}'$`, 'm'));
    assert.match(said(), new RegExp(`^  codex mcp add tricot --url '${url('Codex').replace(/[?]/g, '\\?')}' --bearer-token-env-var TRICOT_TOKEN$`, 'm'));
    assert.match(said(), /Codex, Pi, Gemini CLI, Grok Build and Copilot CLI read the token from TRICOT_TOKEN: run the \$env:TRICOT_TOKEN line in the PowerShell each runs from\./);
    assert.doesNotMatch(said(), /export TRICOT_TOKEN/);
  });

  it('prints them as before on macOS and Linux', async () => {
    withToken();
    await runCli(['connect', '--host', '0.0.0.0'], ctx('darwin'));
    assert.match(said(), new RegExp(`^  export TRICOT_TOKEN=${TOKEN}$`, 'm'));
    assert.match(said(), /Codex, Pi, Gemini CLI, Grok Build and Copilot CLI read the token from TRICOT_TOKEN: run the export in the shell each runs from\./);
  });

  it("says what it would run for Codex with the token in PowerShell: set the variable, then the command, and runs it with the token in its environment", async () => {
    withToken();
    const { exitCode } = await runCli(['connect', 'codex', '--host', '0.0.0.0', '--yes'], ctx('win32'));
    assert.equal(exitCode, 0, err.join('\n'));
    assert.match(said(), new RegExp(`Tricot would run:\\n  \\$env:TRICOT_TOKEN = '<token>'\\n  codex mcp add tricot --url '`));
    assert.doesNotMatch(said(), new RegExp(TOKEN), 'the token is never shown');
    assert.match(said(), /set it in the PowerShell Codex runs from, with \$env:TRICOT_TOKEN = '<token>' \(the token is in /);
    assert.equal(ran[0].env.TRICOT_TOKEN, TOKEN);
    assert.ok(!ran[0].args.includes(TOKEN));
  });

  it('keeps the line it printed for Codex with the token on macOS', async () => {
    withToken();
    await runCli(['connect', 'codex', '--host', '0.0.0.0', '--yes'], ctx('linux'));
    assert.match(said(), /Tricot would run:\n  TRICOT_TOKEN=<token> codex mcp add tricot --url "/);
    assert.match(said(), /set it in the shell Codex runs from, with export TRICOT_TOKEN=<token> \(the token is in /);
  });

  it("shows Claude Code's command single-quoted for PowerShell, with the steps hint's name quoted too", async () => {
    await runCli(['connect', 'claude', '--print', '--name', "Sam's reviewer"], ctx('win32'));
    assert.match(said(), /^ {2}claude mcp add --scope user --transport http tricot 'http:\/\/127\.0\.0\.1:4545\/mcp\?agent=Sam''s%20reviewer'$/m);
    assert.match(said(), /^ {2}tricot steps on --agent claude --project --name 'Sam''s reviewer'$/m);
  });

  it("says where to get an agent on Windows when it isn't there, from its own docs", async () => {
    rmSync(path.join(bin, 'claude'));
    const { exitCode } = await runCli(['claude'], ctx('win32'));
    assert.equal(exitCode, 1);
    assert.match(err.join('\n'), /Install it with:\n  irm https:\/\/claude\.ai\/install\.ps1 \| iex\nor:\n  winget install Anthropic\.ClaudeCode\nor:\n  npm install -g @anthropic-ai\/claude-code/);
  });
});
