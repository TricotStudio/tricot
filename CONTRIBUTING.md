<!-- A lawyer should review this file, CLA.md and LICENSE before outside contributions are accepted. -->

# Contributing to Tricot

Thanks for helping. Two things first.

## The licence, and your contribution

Tricot's core and command line are open source under the [Apache License, Version 2.0](LICENSE). Every contribution also needs the [Contributor Licence Agreement](CLA.md): You keep your copyright and give the Licensor the right to relicense Your contribution, commercially included. Read it, then comment "I have read the CLA and I agree to it" on Your first pull request. A pull request without that can't be merged.

## Working on the code

The source is at https://github.com/TricotStudio/tricot. Fork it there and send changes as pull requests.

```sh
git clone https://github.com/TricotStudio/tricot.git
cd tricot
npm install
npm test            # store unit tests + MCP/REST end-to-end tests
npm run typecheck
npm run dev         # the board on http://127.0.0.1:4545: server + Vite HMR on one port, restarts on server changes
```

`npm start` runs the server with the built UI instead, so build it first:

```sh
npm run build
npm start           # http://127.0.0.1:4545
```

Use a scratch port and data folder for anything you try by hand, so you don't touch your own boards:

```sh
PORT=4610 TRICOT_DATA_DIR=$(mktemp -d) npm start
```

To see a populated board, run `npm run demo` while the server is up. On a scratch port, give it the address: `npm run demo -- http://127.0.0.1:4610`. Resolving and deferring are a person's alone, so the demo leaves two decisions open for you; with `--let-in` it asks to be let in as a terminal does (allow it, by its code, in a browser you've let in) and resolves one and defers the other.

To see what the board's MCP tools cost agents, ask the running server: `curl http://127.0.0.1:4610/api/tool-costs`. It tallies every tool call since the server started, by tool and by agent: calls, and the average, largest and total size of what the agent sent and what it was answered, in tokens estimated at four characters each (`src/server/toolCosts.ts`). It keeps sizes only, never what was said.

To see the update notice without a release, start Tricot with `TRICOT_UPDATE_URL='data:application/json,{"version":"9.9.9"}'`: the check reads that instead of asking npm, even from a checkout.

Report a bug or suggest a change in the [issues](https://github.com/TricotStudio/tricot/issues). Open one before a large change, so we agree on the direction first.

## How the code is laid out

```
src/cli/           the `tricot` command (bundled with the server into dist/cli/command.js; bin.ts, the package's bin, checks the Node.js version first); commands.ts lists every command, one entry each
src/cli/switcher/  agents in a pseudo-terminal each, beside Tricot's own tab (chat, threads, your agents' status and requests for permission), with a strip at the bottom that switches between them (`tricot claude codex`); not on Windows
src/core/          domain model, store (all mutations + event log), agent-facing digests; routes.ts is the one table of REST routes the server serves and the page and the `tricot` command call (each connector's own are in its folder, gathered by the connector registry), pages.ts the one table of the page's addresses
src/core/store/    the Store's modules (core/store.ts hands each call to the one that owns it), the boards' SQLite file and event log under them, and migrations.ts, the versions of what a board stores
src/core/schemas/  the one schema set: what people send (the REST bodies), what agents send (the MCP tools' arguments) and what the Store takes, written from the same fields and limits
src/platform/      what differs between macOS, Linux and Windows: home, temp and data folders, finding a program, running and stopping one, opening the browser, file privacy, the server's lock, and the token a program sends to a board that listens beyond this machine
src/install/       updating Tricot in place: the handoff to the new version, the update check, a release's file
src/server/        Express app: REST + SSE for the UI, MCP endpoint (one session per agent; mcp/session.ts, and the tools in mcp/tools/, one file per area); start.ts starts it, for the command, `npm start` and `npm run dev` alike
src/server/sites/  the site server: a second listener, on this computer alone, that serves each website block at an origin of its own, with Tricot's frame script in its pages
src/server/hooks/  the live-steps installers, one per agent (named in its server.ts): each copies what it needs of hooks/ into the agent's folder and adds its lines to the agent's settings
src/web/           React UI, in a folder for each feature: shell/ (what every page is shown in: its top bar, your menu, the tab's title, the toasts and dialogs), board/ (a board's page), live/ (a board's live data), decisions/, tasks/, cards/ (what both kinds of card share), threads/ (the chat bar and the threads panel), conversation/ (discussion, delivery, reactions), inbox/ (what needs you, what is new), canvas/ (the whiteboard, React Flow), connectors/, agents/ (live steps, usage, the Live label, connecting an agent), access/ (seats, requests for permission), home/, update/, themes/, shared/ (the REST client, the page's addresses, hooks, components); App.tsx opens the page the address names in the shell; styles.css lists the page's shared styles (styles/) in the order they apply, and a feature's own styles sit beside its components
hooks/             what an agent runs or loads to send Tricot its steps, its permission prompts and its plan usage: the steps hook and the module that puts a step in words, Pi's, OMP's and OpenCode's extension and plugin, the approval hook, the usage script
scripts/           demo.ts seeds an example board through MCP and REST; the check-new-* scripts prove what adding a kind, a connector or an agent takes; the build, brand and release helpers
docs/              the guides the README links to: the command, how Tricot works, the MCP tools, configuration
test/              what `npm test` runs, a file per area; fixtures/ holds a database saved by each release
brand/             the mark's files and icons, made from the app's own mark by `npm run brand` (brand/README.md says which is for what)
packaging/         the Homebrew formula, written at each release (RELEASING.md)
```

Node code in `src/` asks `src/platform/` which system it runs on, and nothing else in `src/` reads `process.platform` (the page reads the browser's `navigator`, and the hooks, which run on their own, read it themselves). `isWindows`, and the functions that default to `currentOs()` (`home`, `which`, `launchOf`, `openCommand`), take a stand-in system, so tests check the Windows paths on any machine. A program that can be a Windows `.cmd` (agents, npm, npx) is started with `runProgram` or `execProgram` (`src/platform/run.ts`), which start a `.cmd` through `cmd.exe` with each word quoted so nothing in it runs as a command; the pty switcher, which refuses Windows, starts its helpers itself. `src/platform/` and `src/install/` sit under the server and the command, and import nothing from `src/server/`: what they share with the server lives down there, and the server re-exports it (`test/layers.test.ts`). A test that needs a POSIX shell, file modes, signals or a terminal skips on Windows with its reason: `{ skip: WINDOWS && '…' }` from `test/platform.ts`.

A board's MCP tool is one `defineTool` entry in its area's file in `src/server/mcp/tools/`, with a row in `docs/mcp-tools.md` and a step label in `hooks/tricot-describe.mjs` (`wait_for_updates` and `get_updates` have none on purpose); `test/mcpTools.test.ts` fails for a tool missing either. A connector's tools are `ConnectorTool` entries in its own `src/server/connectors/<id>/tools.ts`. A `tricot` command is one entry in `COMMANDS` in `src/cli/commands.ts`, with its own options and help; dispatch, both kinds of help and "did you mean" read it, and the agent commands come from the agent registry.

A REST route is one entry in `src/core/routes.ts`: its method and its path, with `:name` where a value goes. The server registers it from that entry (`routesOn` in `src/server/routing.ts`, whose handlers are Express's own) and the page builds its address from it (`get(routes.x)` and `post(routes.x)` in `src/web/shared/api.ts`, which fill the values in and encode them), as the `tricot` command and `src/platform/` do with `routeUrl(routes.x, …)` (a signed request signs that same address), so there is no path to write twice. A connector's own routes are a table in its core folder, `src/core/connectors/<id>/routes.ts`, written with the same helpers (`src/core/route.ts`) and listed on its kind; its server and web halves import that table, and `connectorRoutes()` in `src/core/connectors/registry.ts` gathers every connector's, so the app's table names no service. `src/core/routes.ts` imports nothing but those helpers, because the platform and the command's small modules load it (`test/layers.test.ts`). `test/routes.test.ts` fails for a route served without an entry in either table, or an `/api` address written by hand in the page, the command, the platform or updating.

A page's address is one entry in `src/core/pages.ts`: the pattern of its addresses, what the page reads from one, and the link to it. The page opens what the address names with `useRoute` and builds every link with `linkTo` (`src/web/shared/pages.ts`), and the server and the command build their links to a page from it too, so a link and the page it opens can't drift apart; `test/pages.test.ts` fails on an address written by hand in the page.

The features in `src/web/` import one another one way. `shared/` imports no feature; a feature reaches another only through that one's `index.ts`, the list of what it lets the others use, never a file inside it; and no features reach each other, however far round. `test/webImports.test.ts` reads every import in the page and names any that breaks this. The one pair that reach into each other's files are the canvas and the connectors: a connector draws on the canvas, and the canvas finds the connectors through their registry.

Every kind of canvas block (note, table, chart…) is a folder on each side: `src/core/blocks/<type>/` says what it is (`index.ts`: its name, size, how it is placed and shown, and how the parts of it people pin read and behave, in `pins.parts`; `server.ts`: making and changing it, the text agents read, search, pins, what REST and MCP take, which the web build leaves out) and `src/web/canvas/blocks/<type>/` how it is drawn and added. A kind is registered with an import and an entry in `src/core/blocks/registry.ts` and `src/web/canvas/blocks/registry.ts`, and nothing else switches on a block's type or on a pinned part's kind; `npx tsx scripts/check-new-kind.ts` adds a throwaway kind that way and checks it end to end. Only the website kind (`site`) has more: the site server, `src/server/sites/`, which serves each website at an origin of its own so its scripts never run at Tricot's. The kinds are internal to the repository: there is no plugin API.

A connector (Google, Figma, GitHub, Slack and Linear) is a folder on each of three sides: `src/core/connectors/<id>/` (who it is, the scopes it asks for in plain words, the links it recognises in `sources.ts`, how pins on its content are found, its REST routes in `routes.ts`; its `server.ts`, left out of the web build, holds what agents are told and its part of the store), `src/server/connectors/<id>/` (signing in, the sign-in kept in the data folder, reading and writing its documents, serving its REST routes and its MCP tools) and `src/web/connectors/<id>/` (its panel on the Connectors page, its marks, and its pieces on the canvas, such as Google's doc editor). The contract is `connector.ts` in each of the three, and each side's `registry.ts` lists the connectors with an import and an entry; the sign-in callback the Origin check lets through, the connectors line `list_boards` shows, the tools in `tools/list` and the links a card recognises all come from the registries, and nothing else names a service. A source of links that needs no sign-in (Figma, YouTube, Loom, GitHub) is smaller still: a recogniser in `src/core/sources/<name>.ts` and its mark in `src/web/canvas/sources/<name>.tsx`, with an import and an entry in each of their two registries. A connector for a service that has one builds on it: Figma's and GitHub's read a link with the plain source and add what they need once signed in (the file or the pull request to look up, and a card to show it on), and their sources are tried first. `npx tsx scripts/check-new-connector.ts` adds a throwaway connector and a throwaway source of links that way, checks them end to end (`test/routes.test.ts` among the checks), and takes them out. Connectors are internal to the repository too: there is no plugin API. The code is public, so a connector must not depend on a confidential secret: only what the service treats as public ships (a client ID, Google's Desktop client and its Picker key), and a service that wants a real secret is signed in to with PKCE, device flow or a token the person pastes.

An agent (Claude Code, Codex, Pi, OMP, Gemini CLI, OpenCode, Goose, Hermes Agent, Grok Build, Copilot CLI) is a folder, `src/core/agents/<id>/`: `index.ts` says who it is and what the page shows of it (its names, the command that joins it to a board or the file to edit, the Connect panel's words, what its usage shares, how to install it on each system, the models and thinking levels it can start on) and `server.ts`, which the web build leaves out, holds what only the command and the server use (how it starts for one session and its own flags for a model and thinking level, its live-steps hook installer, what `tricot connect` prints, the name its MCP client gives and how long that client lets one call run, which caps how long a wait for updates lasts). It is registered with an import and an entry in `src/core/agents/registry.ts`, and nothing else names an agent: `tricot <agent>` and `tricot connect`, their help, the Connect panel, first run, usage, the live-steps installers and the MCP server's waits all read that list. An installer or a session that needs files of its own can be a file in `src/server/hooks/` or `src/cli/agentSessions/` that `server.ts` imports, or be written inside `server.ts`. `npx tsx scripts/check-new-agent.ts` adds a throwaway agent that way, checks it end to end, and takes it out.

A theme is a CSS file of colour tokens in `src/web/themes/<id>.css` and a line in `src/web/themes/registry.ts`: its id, its label in the theme menu, and whether it is light or dark underneath (what the canvas, Mermaid diagrams and the browser's own controls are told). The file defines every token `light.css` does, under `:root[data-theme='<id>']`, with the `color-scheme` of its base; components draw with the tokens and none is written for one theme, which `test/themes.test.ts` checks. The menu lists what is registered, and the build writes the ids into the script that applies the theme before first paint. Following the OS shows the light or the dark theme; choosing any other one sticks.

## What could come next

- **Plan vs. what was built:** compare the files and PRs on each task with the decisions it implements, and flag drift.
- **Exploration runner:** on "Ask agents to explore", spawn one agent per option in its own git worktree and attach the results as findings automatically.
- **More block types:** live previews of a running prototype, timelines and file-touch maps.
