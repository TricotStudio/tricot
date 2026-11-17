# Tricot

Tricot is a shared workspace where you and your agents work together on a board of pages, threads and files. Agents connect over MCP and show their work on the board's canvases instead of burying it in chat: notes, tables, diagrams, images, diffs, code and charts that you can read, edit and point at. You talk it through with them in threads, each through a lens such as Design or Legal, and they answer there, at your own pace, while they keep working.

![A Tricot board's Sketchbook page that an agent made, with a diagram of the checkout steps (one step pinned, with a comment thread), a table of where people leave and a note with a checklist, and a thread about the table and the note open in the panel beside it, with the agent's answer](docs/images/canvas.png)

## Install

Tricot is one download for every system, and needs Node 22.13 or newer. Which command to use:

- **macOS:** Homebrew, which brings Node.js along if you don't have it, or npm.
- **Linux:** npm.
- **Windows:** npm, in PowerShell or Command Prompt.

With npm, from the npm registry or straight from a [GitHub release](https://github.com/TricotStudio/tricot/releases):

```sh
# from the npm registry
npm install -g tricot

# or from a GitHub release
npm install -g https://github.com/TricotStudio/tricot/releases/download/v<version>/tricot-<version>.tgz
```

With Homebrew, on a Mac:

```sh
brew install tricotstudio/tap/tricot
```

To try it once without installing, run `npx tricot`.

Then connect your agents, in one command:

```sh
tricot connect
```

It finds the agents on your computer and asks one question before it changes anything: a list with a line for each agent, which you can tick all at once, and `?` to see everything it would change. A yes connects each agent to Tricot's board and adds a small hook, which shows what the agent is doing live on its card and, for the agents that take a prompt hook, makes asking it to "show me this on Tricot" in its own terminal make a page. For Claude Code and Codex it also adds a Tricot skill, one file in the agent's own folder that makes that request work even while Tricot is stopped. The hook sends none of your words anywhere, and the skill sends nothing at all. Before it changes a settings file it keeps a copy beside it, and `tricot connect --print` shows exactly what it would do, the skill's file included, and changes nothing. [More below](#connect-an-agent).

### On Windows

Tricot runs on Windows, but it was built on macOS and Windows support is new. Your boards are kept in `%USERPROFILE%\.tricot`. What doesn't work there yet:

- Several agents in one terminal (`tricot claude codex`): the switcher needs a pseudo-terminal, which Windows doesn't give it today. One agent (`tricot claude`) runs on its own, without the Tricot tab or the strip at the bottom.
- Agents' requests for permission don't reach the board yet: the agent asks in its own terminal, as it does when Tricot is closed.
- `tricot update` doesn't install the update itself: it prints the commands to run.
- `tricot stop` saves your boards before it stops only when you allow it once, in the board's page (it shows a code and waits a minute). Otherwise Windows ends Tricot at once, and the last moments of work may not be saved.

## Start

```sh
tricot
```

This starts the board (or finds the one already running), opens it in your browser, and prints how to connect an agent. Run `tricot connect` once, as above, so your agents have the board; start a new session of each agent after it.

Or start the board and your agent together, in one command:

```sh
tricot claude      # or: tricot codex, tricot opencode, tricot pi, tricot omp, tricot copilot
```

It asks which board to work on (`--board <id>` skips the question), opens it, and starts the agent in this terminal with the board for this session only, so the agent's own settings stay as they are. Anything after `--` goes to the agent, and when the agent quits the board stops with it, unless another agent still needs it. A board you started with `tricot` or `tricot start` keeps running; `tricot stop` ends any board.

Even one agent runs beside Tricot's own tab, with a strip at the bottom that says what it is doing: the tab opens on chat, with /threads to browse conversations and /status for your agents, requests for permission and the board's latest activity. Name several (`tricot claude codex`) and they share this terminal, one tab showing at a time, and Ctrl+\ switches ([more](docs/cli.md#several-agents-in-one-terminal)). Without a terminal, and on Windows, one agent runs on its own, without the tab or the strip.

## Connect an agent

Tricot works with any agent that speaks MCP. `tricot connect` finds the agents on your computer and connects them all in one step, after one question that covers each agent's hook and skill too (below); `tricot connect claude` (or `codex`, `pi`, `gemini`, `grok`, `copilot`, `omp`, `opencode`, `goose`, `hermes`, `cursor`) connects one; `--print` only shows what it would do. Or run the line for yours yourself, once, then start a new session:

```sh
# Claude Code
claude mcp add --scope user --transport http tricot "http://127.0.0.1:4545/mcp?agent=Claude"

# Codex
codex mcp add tricot --url "http://127.0.0.1:4545/mcp?agent=Codex"

# Gemini CLI
gemini mcp add --scope user --transport http tricot "http://127.0.0.1:4545/mcp?agent=Gemini"

# Pi
pi mcp add tricot --url "http://127.0.0.1:4545/mcp?agent=Pi"

# Grok Build
grok mcp add --scope user --transport http tricot "http://127.0.0.1:4545/mcp?agent=Grok"

# GitHub Copilot CLI
copilot mcp add --transport http --timeout 300000 tricot "http://127.0.0.1:4545/mcp?agent=Copilot"
```

`tricot connect` also sets up Tricot's hook for each agent that has one, in the same step and with the same yes. The hook shows what the agent is doing live on its card. For the agents that take a prompt hook, it also adds a short line for the agent when you ask to see something on Tricot ("show me the last dev log on Tricot"), or when a message opens with a lens such as `^Design`. It sends none of your words anywhere, and `tricot steps off` turns it off again. The other agents get live steps only, and Cursor has no hook yet, so those go by the wording of Tricot's tools when you ask to see something on Tricot. `tricot connect` ends by saying which agents it connected and which it left alone, and `tricot connect --print` says which have the prompt hook, which have live steps only, and which have no prompt hook; [Live steps](docs/cli.md#live-steps) lists the agents. Run it again whenever you like: what is already set up stays as it is, and an agent you answered for is not asked about twice.

For Claude Code and Codex, `tricot connect` also adds the Tricot skill, in the same step and with the same yes. It is one file, `tricot-show/SKILL.md`, in the folder the agent keeps its skills in (`~/.claude/skills`, `~/.codex/skills`), so it is still there when the agent's Tricot tools are not. It tells the agent to put what you ask to see on Tricot ("show me the last dev log on Tricot", "draw the architecture on the canvas") on a page with `tricot show`, hand you the link, and answer what you ask there, and to leave questions about Tricot's own code alone. It changes no settings. Before it replaces a skill an older Tricot wrote it keeps a copy beside it, and a skill file you edited yourself is left as it is. `tricot skill off` takes it out, and `tricot skill on` adds it again. The other agents have no skill to add yet. [The Tricot skill](docs/cli.md#the-tricot-skill) says more.

Cursor editor and CLI share MCP settings. `tricot connect cursor` adds Tricot
to `~/.cursor/mcp.json`, preserving other servers and keeping a backup.
`tricot connect cursor --print` shows the entry without changing anything.
For one project, merge that entry under `mcpServers` in `.cursor/mcp.json`.
Plain `tricot connect` detects Cursor from `cursor` on PATH or an existing
`~/.cursor` settings folder, even before its first MCP file exists.
Enable or approve Tricot in Cursor if prompted; in the CLI run
`agent mcp enable tricot`. On a token-protected board, set `TRICOT_TOKEN` in
the environment Cursor runs from; the header uses `${env:TRICOT_TOKEN}`.
Tricot does not start Cursor sessions or provide Cursor live steps, approval
forwarding or usage reporting yet. See [Cursor MCP configuration](https://cursor.com/docs/mcp)
and [Cursor CLI MCP](https://cursor.com/docs/cli/mcp).

OMP, OpenCode, Goose and Hermes Agent take it in their settings file. For OMP, in `~/.omp/agent/mcp.json`:

```json
{ "mcpServers": { "tricot": { "type": "http", "url": "http://127.0.0.1:4545/mcp?agent=OMP", "timeout": 300000 } } }
```

For OpenCode, in `~/.config/opencode/opencode.json`:

```json
{ "mcp": { "tricot": { "type": "remote", "url": "http://127.0.0.1:4545/mcp?agent=OpenCode", "timeout": 300000 } } }
```

For Goose, under `extensions` in `~/.config/goose/config.yaml` (on Windows, `%APPDATA%\Block\goose\config\config.yaml`):

```yaml
extensions:
  tricot:
    name: tricot
    type: streamable_http
    uri: "http://127.0.0.1:4545/mcp?agent=Goose"
    enabled: true
    timeout: 300
```

For Hermes Agent, under `mcp_servers` in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  tricot:
    url: "http://127.0.0.1:4545/mcp?agent=Hermes"
    timeout: 300
```

Any other MCP client connects to `http://127.0.0.1:4545/mcp` over Streamable HTTP; `tricot connect mcp-json` prints a config entry for it. `tricot connect <agent> --print` prints any of these again, and the Connect panel in Tricot shows them too.

## Tricot Canvas

Tricot Canvas is the board of pages, threads, files and agents. Start it with `tricot canvas`: it comes with the install, takes the same options as `tricot`, keeps your boards in the same data folder, opens in the browser and prints how to connect an agent, and `tricot status`, `tricot stop` and `tricot update` work on it. One data folder runs one Tricot at a time, so while another edition of Tricot runs on it, `tricot canvas` says so and asks you to stop it first with `tricot stop`, and `tricot` says the same while Canvas runs. It opens a data folder the other edition has used, shows its pages, threads and files, and leaves anything else kept there as it is. From a checkout of the source, `npm run build` and then `npm run canvas` start it on a scratch port and data folder while you try it (`PORT=4610 TRICOT_DATA_DIR=$(mktemp -d) npm run canvas`). [Contributing](CONTRIBUTING.md#tricot-canvas) says how it is built.

## Learn more

- [The `tricot` command](docs/cli.md): its commands, connecting agents, showing their steps live on your boards, and updating or removing it.
- [How Tricot works](docs/how-it-works.md): what people and agents do on a board: canvases and their blocks, pins, threads and lenses, files, and who's here.
- [MCP tools](docs/mcp-tools.md): the tools agents use, and what each one does.
- [Updates, configuration, and Google, Slack and Linear sign-in](docs/configuration.md): the daily update check, the environment variables, running Tricot on a network, connecting Google Docs, connecting Slack to read linked threads, and connecting Linear to read issues.
- [Contributing](CONTRIBUTING.md): building and running Tricot from its source code, and how the code is laid out.

## License

Tricot is open source under the [Apache License 2.0](LICENSE), free for anyone, companies included. The licence doesn't cover the name "Tricot" or its logo: a fork needs its own. Contributions are welcome under the [CLA](CLA.md); see [CONTRIBUTING.md](CONTRIBUTING.md).

Versions 0.1.0 and 0.1.1 were released under AGPL-3.0-only; later versions are under Apache-2.0.

Copyright © 2026 Tricot Studio.

## Credits

Canvases are built on [React Flow](https://reactflow.dev) by xyflow (MIT). The wordmark is set in [Cal Sans](https://github.com/calcom/font) by Cal.com (SIL Open Font License 1.1, in `src/web/fonts/OFL.txt`).

The installed package carries `THIRD_PARTY_NOTICES.md`: the name, version and full licence of every library bundled into it, which the build writes from what the bundles hold (`scripts/notices.mjs`).
