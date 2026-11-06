# Tricot: rules for agents

Tricot is a shared planning board for people and coding agents: a Node server (REST, SSE, MCP), a React page, and the `tricot` command. Layout and long form: [CONTRIBUTING.md](CONTRIBUTING.md#how-the-code-is-laid-out).

## Layers

- The page must not import Node or server code: the web bundle runs in the browser. Pinned by `test/bundle.test.ts`. A block kind's, connector's or agent's Node part goes in its `server.ts`, which the web build leaves out.
- Node code in `src/` asks which system it runs on only through `isWindows` or `currentOs`, and takes home, temp folders and PATH lookups from `src/platform/`: tests can stand in another system there. The page and `hooks/*.mjs` check on their own.
- Start a program that can be a Windows `.cmd` (agents, npm, npx) with `runProgram` or `execProgram` from `src/platform/run.ts`: they quote it safely. The pty switcher, which refuses Windows, is the exception.
- Put updating Tricot in `src/install/`. The CLI must not take OS or updating code from `src/server/`.
- Features in `src/web/` import one another one way: `shared/` imports no feature, and a feature reaches another only through its `index.ts`. Pinned by `test/webImports.test.ts`. The canvas and the connectors are the one pair that may reach each other's files.

## Adding a thing

- Block kind: a folder in `src/core/blocks/` and `src/web/canvas/blocks/`, and a line in each `registry.ts`. Nothing else switches on a block's type. Check with `npx tsx scripts/check-new-kind.ts`.
- Connector: a folder in `src/core/connectors/`, `src/server/connectors/` and `src/web/connectors/`, and a line in each `registry.ts`. Nothing else names a service. Check with `npx tsx scripts/check-new-connector.ts`.
- Agent: a folder in `src/core/agents/` (`index.ts` for the page, `server.ts` for the rest) and a line in its `registry.ts`. Code that handles every agent reads the registry, not a list of its own. An agent whose session makes a folder also goes in the sweep list in `src/cli/agentSessions/folder.ts`. Check with `npx tsx scripts/check-new-agent.ts`.
- Board MCP tool: one `defineTool` entry in its area's file in `src/server/mcp/tools/`, a row in `docs/mcp-tools.md` and a step label in `hooks/tricot-describe.mjs`. Pinned by `test/mcpTools.test.ts`. A connector's tools go in its `src/server/connectors/<id>/tools.ts`.
- CLI command: one entry in `COMMANDS` in `src/cli/commands.ts`, with its own options and help. Pinned by `test/cliCommands.test.ts`.
- REST route: one entry in `routes` in `src/core/routes.ts`. The server registers it with `routesOn`; the page calls it through `src/web/shared/api.ts` or `routeUrl`, and never writes an `/api` path by hand. Pinned by `test/routes.test.ts`.
- Page address: one entry in `src/core/pages.ts`. The page links with `linkTo` and never writes a `#/` address by hand. Pinned by `test/pages.test.ts`.
- Web code: in its feature's folder in `src/web/`, shared pieces in `src/web/shared/`. `styles.css` lists its sections in cascade order: add a section where it applies.
- Styles: draw with the theme tokens; never style for one theme. Pinned by `test/themes.test.ts`.

## Data

- Adding a block kind, or a value of an enum a board stores, must add a migration in `src/core/store/migrations.ts`: an older Tricot then refuses the data instead of failing on it. Pinned by `test/dataShape.test.ts`. [More](RELEASING.md).
- Never edit a migration that has shipped, `src/core/store/shapeDefaults.ts` included: add a new one.

## Security

- A route that acts as the person must check `asPerson` or `personOnly` in `src/server/access.ts`: other accounts on the computer can reach the port.
- The lock's secret goes only to `src/server/proof.ts` and the approval hook: never log, send or return it. `test/lock.test.ts` and `test/approvals.test.ts` check it never reaches commands, pages or replies.
- A connector in the core must not depend on a confidential secret: the code is public. Ship only what the service treats as public (a client ID, Google's Desktop client); otherwise sign in with PKCE, device flow or a token the person pastes.

## Systems and running things

- Code must work on macOS, Linux and Windows, or refuse with a message saying why; CI runs all three. A test that needs POSIX skips on Windows with its reason: `{ skip: WINDOWS && '…' }` from `test/platform.ts`.
- Run anything by hand on a scratch port and data folder (`PORT=4610 TRICOT_DATA_DIR=$(mktemp -d) npm start`): `~/.tricot` holds the person's own boards.
