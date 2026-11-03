# The tricot command

Back to the [README](../README.md).

## Commands

`tricot status` shows where it runs, `tricot stop` stops it, `tricot connect [claude|codex|pi|omp|gemini|opencode|mcp-json|url]` prints the command that connects an agent, `tricot --background` keeps it running after the terminal closes, and `tricot update` updates it (see [Updates](configuration.md#updates)). It uses one server per data folder (a `server.lock` inside it), so a second `tricot` reuses the first. `tricot --help` lists the options.

## Connecting an agent

Connect Claude Code (or any MCP client that speaks Streamable HTTP):

```sh
claude mcp add --transport http tricot http://127.0.0.1:4545/mcp
```

Add `?agent=Name` to the URL to label an agent on the board, e.g. when several agents share one board. Without it, the MCP client's own name is used.

## Live steps

The first `tricot` in a terminal finds the agents on your machine (Claude Code, Codex, Pi, OMP, Gemini CLI, OpenCode) and asks once whether to show their steps live on your boards ("Reading src/app.ts", "Running npm test" on the card each one works on). It lists the files it would write for each agent; a yes adds a small hook to each agent's own settings, for every project, and a no is remembered too (in the data folder), so it isn't asked again. It never asks without a terminal, in CI, or with `--no-hooks`; `--verbose` shows every line first. `tricot hooks` shows where each agent stands, and `tricot hooks on|off [--agent claude|codex|pi|omp|gemini|opencode]` turns them on or off later, again showing the lines and asking first (`--yes` skips the question). Each agent's panel in Tricot has the same as a "Live steps" switch, which shows the exact files and lines before it writes anything; agents can't turn it on or off themselves. Codex runs a new hook only once you trust it in its `/hooks`, which Tricot says when it sets it up. None of this touches a project's own settings: a project that still has its hook from `tricot connect claude --hooks` keeps it, and each step still shows once (the board keeps one of the two copies).

`tricot connect claude --hooks`, run in a project, offers to add a Claude Code hook to its `.claude/settings.json` (it shows the JSON and asks first): the card Claude works on then shows what it is doing, one line per step ("Running npm test"), and a command or subagent that takes a while stays live until it ends ("Ran npm test (42 s)"). The same line shows under a message you're waiting on Claude to answer, and on the project's row on the home page. The hook sends no file contents or command output, runs in the background and does nothing when Tricot isn't running. With `--narration` it also sends the first line of each message Claude writes in the terminal (never its thinking); that is off unless you ask for it. `--remove-hooks` takes it out again.

## Updating and removing it

The same `npm install -g tricot` updates it (`brew upgrade tricotstudio/tap/tricot` with Homebrew), and `npm uninstall -g tricot` removes the command; your boards stay in `~/.tricot` either way. To try it once without installing, `npx tricot` runs the same command.
