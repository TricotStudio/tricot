<!-- A lawyer should review this file, CLA.md and LICENSE before outside contributions are accepted. -->

# Contributing to Tricot

Thanks for helping. Two things first.

## The licence, and your contribution

Tricot's core and command line are open source under the [GNU Affero General Public License, version 3](LICENSE), and Tricot Studio also offers them under a [commercial licence](COMMERCIAL.md) to anyone who can't meet the AGPL. So that the Licensor can offer both, every contribution needs the [Contributor Licence Agreement](CLA.md): You keep your copyright and give the Licensor the right to relicense Your contribution, commercially included. Read it, then comment "I have read the CLA and I agree to it" on Your first pull request. A pull request without that can't be merged.

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

To see a populated board, run `npm run demo` while the server is up. On a scratch port, give it the address: `npm run demo -- http://127.0.0.1:4610`.

To see the update notice without a release, start Tricot with `TRICOT_UPDATE_URL='data:application/json,{"version":"9.9.9"}'`: the check reads that instead of asking npm, even from a checkout.

Report a bug or suggest a change in the [issues](https://github.com/TricotStudio/tricot/issues). Open one before a large change, so we agree on the direction first.

## How the code is laid out

```
src/cli/       the `tricot` command (bundled with the server into dist/cli/command.js; bin.ts, the package's bin, checks the Node.js version first)
src/core/      domain model, store (all mutations + event log), agent-facing digests
src/server/    Express app: REST + SSE for the UI, MCP endpoint (one session per agent); start.ts starts it, for the command, `npm start` and `npm run dev` alike
src/web/       React UI; src/web/canvas/ is the whiteboard (React Flow)
scripts/demo.ts  seeds an example board through MCP and REST
```

Every kind of canvas block (note, table, chart…) is a folder on each side: `src/core/blocks/<type>/` says what it is (`index.ts`: its name, size, how it is placed and shown; `server.ts`: making and changing it, the text agents read, search, pins, what REST and MCP take, which the web build leaves out) and `src/web/canvas/blocks/<type>/` how it is drawn and added. A kind is registered with an import and an entry in `src/core/blocks/registry.ts` and `src/web/canvas/blocks/registry.ts`, and nothing else switches on a block's type; `npx tsx scripts/check-new-kind.ts` adds a throwaway kind that way and checks it end to end. The kinds are internal to the repository: there is no plugin API.

A connector (Google today) is a folder on each of three sides: `src/core/connectors/<id>/` (who it is, the scopes it asks for in plain words, the links it recognises, how pins on its content are found; its `server.ts`, left out of the web build, holds what agents are told and its part of the store), `src/server/connectors/<id>/` (signing in, the sign-in kept in the data folder, reading and writing its documents, its REST routes and its MCP tools) and `src/web/connectors/<id>/` (its panel on the Connectors page, its marks, and its pieces on the canvas, such as Google's doc editor). The contract is `connector.ts` in each of the three, and each side's `registry.ts` lists the connectors with an import and an entry; the sign-in callback the Origin check lets through, the connectors line `list_boards` shows, the tools in `tools/list` and the links a card recognises all come from the registries, and nothing else names a service. A source of links that needs no sign-in (Figma, YouTube, Loom, GitHub) is smaller still: a recogniser in `src/core/sources/<name>.ts` and its mark in `src/web/canvas/sources/<name>.tsx`, with an import and an entry in each of their two registries. `npx tsx scripts/check-new-connector.ts` adds a throwaway connector and a throwaway source of links that way, checks them end to end, and takes them out. Connectors are internal to the repository too: there is no plugin API.

A theme is a CSS file of colour tokens in `src/web/themes/<id>.css` and a line in `src/web/themes/registry.ts`: its id, its label in the theme menu, and whether it is light or dark underneath (what the canvas, Mermaid diagrams and the browser's own controls are told). The file defines every token `light.css` does, under `:root[data-theme='<id>']`, with the `color-scheme` of its base; components draw with the tokens and none is written for one theme, which `test/themes.test.ts` checks. The menu lists what is registered, and the build writes the ids into the script that applies the theme before first paint. Following the OS shows the light or the dark theme; choosing any other one sticks.

## What could come next

- **Plan vs. what was built:** compare the files and PRs on each task with the decisions it implements, and flag drift.
- **Exploration runner:** on "Ask agents to explore", spawn one agent per option in its own git worktree and attach the results as findings automatically.
- **More block types:** live previews of a running prototype, timelines and file-touch maps.
