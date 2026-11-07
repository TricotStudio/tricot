// Goose (Block's, now the Agentic AI Foundation's): `goose configure` only asks
// questions, so it is an entry for the extensions in its config.yaml, a YAML
// file. Tricot can't start it with the board for one session. What only the
// command and the server use of it is in server.ts.
//
// Confirmed from Goose's own documentation (goose-docs.ai) and its repository
// (github.com/aaif-goose/goose, read, not run): the file and its `extensions:`
// map, `type: streamable_http` with `uri`, `enabled` and `timeout` (seconds),
// `headers` and `env_keys` in its config-files page; `--with-streamable-http-extension`
// in its CLI page; hooks as plugins (`~/.agents/plugins/<name>/hooks/hooks.json`)
// in its hooks page; from its source, that `${VAR}` in `headers` is filled from
// the variables `env_keys` names, taken from Goose's environment, that its MCP
// client calls itself `goose-cli`, that a call has a fixed timeout, and that
// the extension a one-session flag adds is named after the address.
//
// UNVERIFIED: none of this was run (Goose is not installed where this was built).
// (1) That a released Goose, not just its main branch, reads the entry as
//     gooseEntry writes it: `headers` isn't in the extensions page's own
//     example, only in the config-files page's shapes and the source.
//     Two third-party guides write `type: http` with `url`; Goose's source has
//     neither (`streamable_http` and `uri`), so they were not followed.
// (2) That Goose Desktop, which reads the same file, calls its client
//     `goose-cli` too: if not, Tricot waits as it does for an unknown client
//     (240 seconds, inside the entry's 300), and nothing else changes.
// (3) Windows: hooks run `sh -c` (its source), so its steps need `sh` on PATH
//     there (Git Bash), and the config file is %APPDATA%\Block\goose\config\config.yaml
//     (its config-files page); neither was tried.
// (4) That it passes `tool_input` on PostToolUse and PostToolUseFailure, as its
//     hooks page says of tool events; the steps still work if not (a command
//     that ended says "Ran a command").

import { GOOSE_FILE, GOOSE_WINDOWS_FILE, gooseConfig } from '../../connect';
import { yamlText } from '../../yaml';
import type { AgentKind } from '../agent';
import { server } from './server';

export const goose: AgentKind = {
  id: 'goose',
  name: 'Goose',
  boardName: 'Goose',
  command: 'goose',
  install: {
    commands: ['curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash', 'brew install block-goose-cli'],
    // Windows, as goose-docs.ai lists it for PowerShell, its two steps as one line (it also installs from Git Bash with the script above).
    windows: ['Invoke-WebRequest -Uri "https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1" -OutFile "download_cli.ps1"; .\\download_cli.ps1'],
    more: 'https://goose-docs.ai/docs/getting-started/installation',
  },
  cliOrder: 7,
  cantStart: "its flag for one session names the server after the board's address and can't send the board's token",
  connect: { how: 'file', file: GOOSE_FILE, entry: (url, token) => yamlText(gooseConfig(url, token)) },
  panel: {
    intro: [
      'Goose has no command for this: ',
      { code: 'goose configure' },
      ' only asks questions. Add the entry under ',
      { code: 'extensions' },
      ' in ',
      { code: GOOSE_FILE },
      ' (merge it in if the file exists; on Windows the file is ',
      { code: GOOSE_WINDOWS_FILE },
      '). Goose Desktop reads the same file.',
    ],
    note: ['It shows on the board as “Goose”.'],
    firstRunBlock: true,
  },
  usage: { shares: 'none', notShared: 'Goose keeps its usage to itself: it can show its cost in its own session (GOOSE_CLI_SHOW_COST).' },
  // No startsOn: `goose session` takes no model or thinking flag (its CLI
  // page gives --model and --provider to `goose run` alone), so it starts on
  // its own settings.

  ...server,
};
