// GitHub Copilot CLI (the `copilot` command): joins by its own command
// (`copilot mcp add`), with a header that names TRICOT_TOKEN for it to expand,
// and starts with the board for one session (`--additional-mcp-config`). What
// only the command and the server use of it is in server.ts.
//
// Confirmed from GitHub's own documentation (docs.github.com/copilot: the CLI
// command reference, the configuration directory reference, the hooks
// reference, "Adding MCP servers" and "Installing Copilot CLI") and its
// changelog (github.com/github/copilot-cli): the install commands; `copilot mcp
// add|get|remove|list`, --header, --timeout (milliseconds, 30 seconds unless
// set) and ~/.copilot/mcp-config.json ($COPILOT_HOME's when set); `${VAR}` in a
// remote server's headers; --additional-mcp-config for one session, winning
// over a server of the same name; --allow-tool with a server's name; -i;
// --model with its model ids, and --effort/--reasoning-effort with its levels;
// hooks in ~/.copilot/hooks/*.json, in Claude Code's shape and with its event
// names (its changelog, 1.0.6 and 1.0.21); that it reads AGENTS.md (and
// CLAUDE.md, GEMINI.md) in the repository's root and the working folder; /usage.
//
// Tried with Copilot CLI 1.0.107 (the npm package's macOS build, run with a
// scratch COPILOT_HOME and no prompt ever sent): `copilot mcp add` writes the
// entry as copilotWords gives it (type http, the header as written,
// "timeout": 300000) and refuses a name it has; `copilot mcp get tricot`
// prints its URL and exits 0, and exits 1 for a server it hasn't; its MCP
// client calls itself `copilot-cli` and joins a Tricot board (after trying
// MCP's newer server/discover, which Tricot doesn't know, it falls back to
// initialize); the session's server connects with its ${TRICOT_TOKEN} filled
// in from the environment, in place of the person's own tricot, and only with
// --enable-mcp-server when they turned theirs off.
//
// UNVERIFIED: no prompt was sent, so no tool call was seen.
// (1) Live steps: that Copilot runs Tricot's hook file as written, and the
//     fields and tool arguments of its events (fromCopilot in
//     hooks/tricot-describe.mjs lists what is assumed); a miss shows a step
//     in plainer words, or none, never a wrong one. Not even a SessionStart
//     hook ran before a first prompt where this was tried.
// (2) Whether a long call is cut at the entry's timeout whatever progress
//     comes: Tricot assumes so and ends a wait inside it (server.ts).
// (3) Windows: the folder is %USERPROFILE%\.copilot (its hooks reference)
//     and a hook's command runs in PowerShell; neither was tried.
// (4) A trusted project's .mcp.json (Claude Code's project file) wins over
//     the user's entry by its name: a `tricot` there, named for Claude, would
//     make Copilot show on the board as Claude in that project.

import { thinkingLevels } from '../../agentRules';
import { COPILOT_FILE, copilotLines, copilotWords } from '../../connect';
import type { AgentKind } from '../agent';
import { server } from './server';

export const copilot: AgentKind = {
  id: 'copilot',
  name: 'Copilot CLI',
  boardName: 'Copilot',
  command: 'copilot',
  install: {
    commands: ['npm install -g @github/copilot', 'brew install --cask copilot-cli', 'curl -fsSL https://gh.io/copilot-install | bash'],
    // Windows, as GitHub's install page gives them: WinGet, npm.
    windows: ['winget install GitHub.Copilot', 'npm install -g @github/copilot'],
    more: 'https://docs.github.com/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
  },
  connect: {
    how: 'command',
    words: copilotWords,
    lines: copilotLines,
    settings: COPILOT_FILE,
    readsToken: true,
    remove: ['copilot', 'mcp', 'remove', 'tricot'],
    list: 'copilot mcp list',
    get: ['copilot', 'mcp', 'get', 'tricot'],
  },
  panel: {
    intro: ['Run once in a terminal; Copilot CLI then has the board in every session.'],
    note: ['Copilot CLI asks before each board tool unless you allow them: ', { code: 'copilot --allow-tool=tricot' }, ' allows them all. It shows on the board as “Copilot”.'],
  },
  usage: { shares: 'none', notShared: 'Copilot keeps its usage to itself: see /usage in Copilot.' },
  // The models its command reference lists for --model, with auto, which
  // lets Copilot pick; any other it takes can be typed. Its --effort levels,
  // from the least (Copilot CLI 1.0.107's help also takes none and minimal).
  startsOn: {
    models: [
      { id: 'auto', label: 'Auto' },
      ...[
        'claude-sonnet-5.5',
        'claude-opus-5.5',
        'claude-haiku-5.5',
        'gpt-6.1-sol',
        'gpt-6.1-terra',
        'gpt-6-astra',
        'gpt-6-luna',
        'gpt-5.3-codex',
        'gemini-3.8-flash',
      ].map((id) => ({ id, label: id })),
    ],
    levels: thinkingLevels('low', 'medium', 'high', 'xhigh', 'max'),
  },
  // Its agent skills (~/.copilot/skills, listed by /skills): GitHub's "Adding agent skills for GitHub Copilot CLI".
  skills: 'skills',

  ...server,
};
