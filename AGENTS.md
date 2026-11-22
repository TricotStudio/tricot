# Tricot: rules for agents

Tricot is a shared planning board for people and coding agents: a Node server (REST, SSE, MCP), a React page, and the `tricot` command. Each rule below is short; its long form, with the reference behind it, is in [CONTRIBUTING.md](CONTRIBUTING.md#how-the-code-is-laid-out). Read the long form of the area you change.

## Layers

- The page must not import Node or server code: the web bundle runs in the browser. A block kind's, connector's or agent's Node part goes in its `server.ts`, which the web build leaves out. Pinned by `test/bundle.test.ts`.
- Node code in `src/` asks which system it runs on only through `isWindows` or `currentOs`, and takes home, temp folders and PATH lookups from `src/platform/`: tests can stand in another system there. The page and `hooks/*.mjs` check on their own.
- Start a program that can be a Windows `.cmd` (agents, npm, npx) with `runProgram` or `execProgram` from `src/platform/run.ts`: they quote it safely. The pty switcher, which refuses Windows, is the exception.
- Put updating Tricot in `src/install/`. Pinned by `test/layers.test.ts`.
  - The CLI must not take OS or updating code from `src/server/`, and `src/platform/` and `src/install/` import nothing from it.
  - `src/core/routes.ts`, which they load, imports nothing but `src/core/route.ts`.
- Features in `src/web/` import one another one way: `shared/` imports no feature, and a feature reaches another only through its `index.ts`. The canvas and the connectors are the one pair that may reach each other's files. Pinned by `test/webImports.test.ts`.
- The core and the canvas side must not import the code of a part that adds kinds of card: name a new store module or page feature on its side, so the part plugs in without editing the core.
  - What the canvas needs of such a card (what a pinned part becomes, where a comment on a card's canvas or a pairing session's summary goes), it asks the registry of card kinds (`src/core/store/cardKinds.ts`), which a part fills where the Store is built (`src/core/store.ts`). Add to that registry rather than import a part's module.
  - A card's page address (what the Slack share links to) is the kind's `pageLink`, asked with `store.cardLink`.
  - The terminal's chat takes its kinds of card as `ChatCard`s (`src/cli/switcher/threadsSend.ts`) from `run.ts`; with none it links and comments on no card.
- Tricot Canvas is a second entry point, a separate build and start, never a mode read at run time. Pinned by `test/canvasPage.test.ts`, `test/canvasServer.test.ts` and `test/canvasAgent.test.ts`. [More](CONTRIBUTING.md#tricot-canvas).
  - The page: `src/web/canvasMain.tsx` and `canvasApp.tsx` build the registries with only the core's, and `vite build --mode canvas` writes `dist/canvas`. Register a thing a part adds to the page from that part's own page entry, never import it from a core feature, or it reaches Canvas's bundle.
  - The server: `canvasEdition()` (`src/server/canvasEdition.ts`) is empty registries of API parts and tool groups and a plain Store, so Canvas registers nothing of a part's. Its Store reads and writes no list, dismissal or event subject a part adds, and its replies carry no list or count of one.
  - A board's data is the same file, and Canvas leaves what a part stored alone, row by row: a rename leaves a card's `boardId` at the earlier id, an alias the part resolves, and a delete leaves the board's dismissals in their own table.
  - A part's style rules go in sheets of its own, imported by its page entry after `styles.css`, never by Canvas's.
- `tricot canvas` is the one `start` in `src/cli/boardCommands.ts` with `canvas` set, never a second copy of it. Pinned by `test/cliCanvas.test.ts`, and the restart by `test/handoff.test.ts` and `test/updates.test.ts`. [More](CONTRIBUTING.md#tricot-canvas).
  - `editionOf` in `src/edition.ts` is the one place that chooses an edition: it looks for `src/editionFull.ts` at that one fixed path and imports nothing else of it. It takes no search path or setting, so it is not a plugin API. `tricot`, `tricot start` and `npm start` start that edition where the file is and Canvas where it is not; `tricot canvas` and `npm run canvas` always start Canvas.
  - The package ships `dist/canvas` with `dist/web` (`files` in `package.json`, checked by `scripts/smoke-release.mjs`).
  - The lock's `edition` says which Tricot holds a data folder: a start of the other one refuses, naming the one that runs and `tricot stop`. An update restarts the same edition (`startArgs`, `restartCommand` in `src/install/handoff.ts`). The agent commands start what `tricot` starts when none runs, and use whichever runs.

## Adding a thing

- Block kind: a folder in `src/core/blocks/` and `src/web/canvas/blocks/`, and a line in each `registry.ts`. Check with `npx tsx scripts/check-new-kind.ts`. [More](CONTRIBUTING.md#how-the-code-is-laid-out).
  - Nothing else switches on a block's type, or on a pinned part's kind: a kind says how its parts read in `pins.parts`. Only the website kind (`site`) has more: its site server, in `src/server/sites/`.
  - A kind only a part adds is in no `registry.ts`, and nothing registers it by loading a module. Its page half is in the part's folder, registered with `useWebBlockKinds` (`src/web/canvas/blocks/registry.ts`) where the part's page entry starts, so the Canvas page has no such kind. Its core half is the `blockKinds` of the part's `StorePart`, which the Store registers when it is built (`useBlockKinds`, `src/core/blocks/registry.ts`).
  - A Store without the part reads a stored block of its type as an unknown block (`src/core/blocks/foreign.ts`): kept as it is, and made or changed by none.
- Connector: a folder in `src/core/connectors/`, `src/server/connectors/` and `src/web/connectors/`, and a line in each `registry.ts`. Nothing else names a service. Check with `npx tsx scripts/check-new-connector.ts`.
  - Its REST routes go in `src/core/connectors/<id>/routes.ts`, which the connector registry gathers.
  - The links it recognises go in `sources.ts` beside it, built on the service's plain link source when it has one.
- Link source that needs no sign-in: a file in `src/core/sources/` and `src/web/canvas/sources/`, and a line in each `registry.ts`. Check with `npx tsx scripts/check-new-connector.ts`.
- Kind of reference (what `#12` and `T5` in text name): an entry in the page's registry of reference kinds (`src/web/shared/refKinds.ts`), made by the feature that owns the card and handed to `RefsProvider` in `src/web/board/BoardView.tsx`. Pinned by `test/refKinds.test.ts`, `test/refMarks.test.ts`.
  - The shared Markdown, composers and links ask the registry and name no kind; with none registered, `#12` and `T5` stay text and `#` offers no list. The server and the terminal ask `src/core/refKinds.ts` the same way, which has no kind until a part or the terminal's edition (`SwitcherEdition.refKinds`) registers some.
- Kind of card, for what the canvas side of the page asks of a card by its id: an entry in the page's registry of card kinds (`src/web/shared/cardKinds.ts`), made by the feature that owns the card and handed to `CardKindsProvider` where the page is built. Pinned by `test/webCardKinds.test.ts`.
  - The canvas, the threads, the agents' panel and the connectors ask it with `useCardKinds` and name no route or address of a card. With none registered, the page offers no pin that becomes a card, leaves a card's link as text and lets a reaction on a card do nothing.
  - The words that name those kinds (`wordPinsWith`, `wordAgentPanelWith`, a kind's `workCard`, `requestCardsWith`, the `question`'s `note`) are registered beside them, never written in the core. With none, the words name no card.
- View of a board (a tab, a card's own page, a header control, the needs strip, the Feed, Projects' list of needs): an entry in the page's registry of board views (`src/web/shared/boardViews.ts`), registered by the side that owns it and handed to `BoardViewsProvider` where the page is built (Canvas's is `canvasBoardViews` in `src/web/canvasApp.tsx`). Pinned by `test/boardViews.test.ts`.
  - The core registers the board's Home, the Sketchbook and the Files (`src/web/board/coreViews.tsx`); a part registers its own views, slots, session (`withSession`) and wording, what Projects, the list of boards, draws of its cards (`ProjectsSlots`) and what its cards add to the Work of a board's Home (`withWork`) included.
  - `BoardView`, Projects and the board switcher import no part's feature: they ask the registry. With only the core's views, a board is its Home, the Sketchbook and the Files, and lands on its first tab, Home, unless the page claims another landing (`landOn`; neither Canvas nor a part's page does).
  - A board's Home (`src/web/threads/timeline.tsx`) holds its own conversation and chat bar (`holdsChat`): the board's page draws no dock over it, and it opens what asks the dock for a thread in its main pane (`useThreadsOpenHere`). Its one bar aims at the thread open, or for one message at a relay's thread after its Reply, with the bar's context chip, and sends through the dock's own code (`src/web/threads/send.ts`), never a path of its own. It reads threads as they are and stores nothing on the board (`src/web/threads/relays.ts`); a part's cards join its Work, and what it relays of them, only through `withWork`.
  - What a part draws on the board context's canvas, and its name, is one slot (`withBoardContext`), which `CanvasView` asks only on the board's own canvas. With none registered, that canvas draws no sync mark and no bar, and a block's and a group's menu on a Sketchbook page have no Keep item (the slot's `keep`).
- Share of a card through a connector (as Share to Slack): it is a part's, never the connector's. The part registers its page half with `useConnectorShares` (`src/web/connectors/registry.ts`) from its own page entry, and serves its route from its own table under `/api/connectors/<id>/…` through `kit.connectors`. The connector keeps only its sign-in, its reading and what it already offers (`call`). [More](CONTRIBUTING.md#how-the-code-is-laid-out).
- Agent: a folder in `src/core/agents/` (`index.ts` for the page, `server.ts` for the rest) and a line in its `registry.ts`. Check with `npx tsx scripts/check-new-agent.ts`.
  - Code that handles every agent reads the registry, not a list of its own.
  - An agent whose session makes a folder also goes in the sweep list in `src/cli/agentSessions/folder.ts`.
- Board MCP tool: one `defineTool` entry in its area's file in `src/server/mcp/tools/`, a row in `docs/mcp-tools.md` and a step label in `hooks/tricot-describe.mjs`. A connector's tools go in its `src/server/connectors/<id>/tools.ts`. Pinned by `test/mcpTools.test.ts`, which fails for a tool registered twice or missing its row or its label.
- Group of MCP tools, with the guide topics it adds: a `ToolGroup` in the registry each MCP server is built with (`src/server/mcp/toolGroups.ts`, `McpOptions.groups`, `toolGroups` in `createApp`), which a part fills. Nothing registers by loading a module. Pinned by `test/toolGroups.test.ts`.
  - A group says which board tool its tools follow (`after`), and answers a board tool's call that carries an argument it added (`answers`).
  - `read_guide` offers the topics of what is registered: a server with none lists none of a part's tools and answers a call to one as any unknown tool.
- Step labels of a part's tools ("Using Tricot: …"): in the part's own `hooks/tricot-labels.json`, which the package ships where the part is, never in `hooks/tricot-describe.mjs`, which names only the board's own tools and the connectors'. The server takes the same words from the part's `ToolGroup` (`stepLabels`), never from the file beside the hook, which a bundled server is not beside. Pinned by `test/mcpTools.test.ts`, `test/toolGroups.test.ts` and `test/connectAll.test.ts`. [More](CONTRIBUTING.md#how-the-code-is-laid-out).
- Line of the MCP instructions: a named line of `CORE` in `src/server/mcp/instructions.ts` when it is true with no part registered, and otherwise a line a `ToolGroup` adds with `instructions` (a group may list no tools and only add lines). Pinned by `test/instructions.test.ts` and the golden `test/golden/mcp-instructions-canvas.txt`.
  - A group's line names where it goes among the core's (`before`, `after`, `replaces`, or `in` a section) and never edits the text of one. A line the core and a part say differently has the core's version in `CORE` and the part's, which replaces it, in the part's own file.
  - A server with no group names no tool or word of a part. With a part registered every variant reads exactly as it did, and each stays under `MAX_INSTRUCTIONS`.
- Words of the board's own tools, guide and refusals that name a part's cards, status or board context: named pieces the core writes (`[name, text]`, in `src/server/mcp/words.ts`; `describedIn` for an argument), with a part's placed among them by a `ToolGroup`'s `phrasing` (`edits`, `params`, `lines`, and for a digest `parts` and `offers`). Pinned by `test/canvasAgent.test.ts`, `test/words.test.ts` and `test/canvasResults.test.ts`.
  - A group puts a piece `before`, `after` or in place of a piece of the core's, and never edits the text of one.
  - The arguments that take a card, and the board context's `board_id` on `get_canvas`, `add_block` and `add_group` (where the core asks for `page_id`), are a part's to add, not the core's. A tool that is only for the board context is a part's own tool.
  - A digest the core builds takes what a part says from `told` (`Told` in `src/core/words.ts`). With none it names no card, status, board context or sync, and tells no event of a part's kind: the log is the part's data and stays as it is.
  - A server with a part registered says every description, argument, topic and refusal exactly as it did: write a new sentence that names a card, the board context or a part's tool in pieces, with the part's words in its phrasing.
- CLI command: one entry in `COMMANDS` in `src/cli/commands.ts`, with its own options and help. Pinned by `test/cliCommands.test.ts`.
- REST route: one entry in `routes` in `src/core/routes.ts`. None writes an `/api` path by hand: the server registers a route with `routesOn`, the page calls it through `src/web/shared/api.ts` or `routeUrl`, and the command, `src/platform/` and `src/install/` through `routeUrl`, so a signed request signs that same address. Pinned by `test/routes.test.ts`. [More](CONTRIBUTING.md#how-the-code-is-laid-out).
  - The shared client holds the canvas's calls and the core's, and names no route of a part: a part's feature, like a connector, has an `api.ts` in its folder built on `get` and `post`.
  - A connector's routes go in its `src/core/connectors/<id>/routes.ts`. A part's go in a table of its own that imports nothing but `src/core/route.ts`, that nothing in the core or the canvas side imports, and that its API part declares. The core's table holds none of a part's routes.
- REST handlers of a part besides core: in an API part (`src/server/apiParts.ts`: an id and a `mount(api, kit)`), never in `src/server/api.ts`, which holds the core's. Pinned by `test/apiParts.test.ts`. [More](CONTRIBUTING.md#how-the-code-is-laid-out).
  - Register each route with the kit's `on`, and take `seated`, `personOnly`, `human`, `param` and `react` from the kit. `createApiRouter` mounts a part after the `peopleChange` gate and before the 404 and the error handler, so its routes keep the gate, their tiers and the shared error handler.
  - Never mount a part's own router at `/api` beside it: it would miss the gate and the error handler.
  - A part declares its routes as a table of its own (`routes` on the part) and serves each of them and no other: one served outside it, or one left unserved, stops startup.
  - Each app builds its own parts and hands them to `createApp`; nothing registers by loading a module. With none (`new ApiParts()`), the server is the canvas alone, which answers a part's route with the plain 404.
- Page address: one entry in `src/core/pages.ts` for a page of the core's, and one in a table of the part's own for a page of a part, whose pieces the part registers as the `address` of the view or card page that draws it. Pinned by `test/pages.test.ts`.
  - The page links with `linkTo` and goes with `go`, and never writes a `#/` address by hand.
  - A board's address is `#/b/<id>` and then a piece that the core or a registered view reads. One no piece reads is the board's own, which lands on the registry's default view.
  - Older addresses are not kept (no redirects): change an address and its old form opens the board's own.
- Web code: in its feature's folder in `src/web/`, shared pieces in `src/web/shared/`. `styles.css` lists its sections in cascade order: add a section where it applies.
- Styles: draw with the theme tokens; never style for one theme. Pinned by `test/themes.test.ts`.
  - Set what covers what with a layer of `styles/base.css` (`--z-popover`, `--z-dialog`…), or a number from 0 to 9 inside one part.
  - Draw a menu or popover that must rise above what holds it (a block, the thread dock, a row) at the page's root with `OnTop` and `usePlace` (`src/web/shared/onTop.tsx`): drawn inside, no z-index lifts it past its container.
  - A rule for a piece only a part draws goes in a sheet of that part's own, never in a shared sheet, which Canvas builds.
  - Colour where a piece of work stands (a square, a strand, a lane, a chip) with the `--status-*` tokens of `styles/base.css`, the one map Home and a part's cards share, never a status colour of its own choosing.

## Data

- Adding a block kind, or a value of an enum a board stores, must add a migration in `src/core/store/migrations.ts`: an older Tricot then refuses the data instead of failing on it. Pinned by `test/dataShape.test.ts` (the core's own types, `test/dataShape.core.json`). [More](RELEASING.md).
- Never edit a migration that has shipped, `src/core/store/shapeDefaults.ts` included: add a new one.
- A part besides core versions its own data: its migrations are a `DataPart` in `src/core/store/dataParts.ts`, the `data` of its `StorePart`, each naming the core data version it was written on (`core`), and its version is its row in `data_versions`. Add one at the end of its list. Pinned by `test/dataParts.test.ts`. [More](RELEASING.md).
  - Core's version stays `user_version`, and core never names a part.
  - A Store opens the database with the data parts of its own parts and no others. A part whose data the file holds in a newer version is off for that Store: its lists, owners and kinds of card are not registered, its rows stay foreign, and the Store says so once.
  - A Store with no part, such as Canvas's, neither writes nor touches a part's row.
- The check for which picture files are still in use (`Assets.removeUnusedAssets`) reads the stored rows as well as the boards in memory, whichever lists the store has registered: a picture only a part's card's canvas shows keeps its file in a store that does not read those rows. Pinned by `test/storePictures.test.ts`. [More](CONTRIBUTING.md#the-data-a-tricot-stores).
  - It reads every `block` and `deletion` row of every board and owner (`src/core/store/pictureRows.ts`) and the `block_versions` table's asset column. A new row kind or table that can name a picture is read there.
  - It never rewrites a row, and a row it cannot read keeps the pictures its text names.
- Every id the repository makes (`newPageId`, `newItemId`, `newThreadId`, `newRequestId`) and any id a part makes is checked against the ids of the rows the store does not read: a new generator must check them too. [More](CONTRIBUTING.md#the-data-a-tricot-stores).
- The store reads and writes only the rows of the lists it has registered (`src/core/store/entityLists.ts`): a list is its name on the Board, its row kind and the owner kind its canvas rows use. [More](CONTRIBUTING.md#the-data-a-tricot-stores).
  - Pages, threads, requests, deletions and a canvas's blocks, groups, links and pins are the core's own. A part registers its lists, and a Store given no parts has none.
  - `boardRows.ts`, `boardTables.ts`, `boardDb.ts` and `repository.ts` ask the registry for the lists, their dirty tracking, their indexes and what a row is: a new list is an entry there, never a name in them.
  - Every row of a list it has not registered (all of them, with `lists: []`) is foreign: never parsed, compared, rewritten or indexed, and deleted only with its whole board, its owner, kind and id kept so no new id is made twice. A board header keeps the keys it has no name for, in their order.
  - Stored data does not change with the registry: no migration, and the data tests stay as they are.
- A Store is built from parts (`src/core/store/storePart.ts`): `new Store(dir, { parts })`, each `StorePart` a name and what it gives the Store, each optional. `parts: []` and a plain `new Store(dir)` are a canvas alone. [More](CONTRIBUTING.md#the-data-a-tricot-stores).
  - The core Store imports no module of a part: a part's `modules` builds what its `cards` work over from the Store's own (`CoreModules`). Server code that Canvas also runs asks a kind by its name: `getCard(kind, id)`, `commentOnKind`, `sweepKinds`, `touchOnKind`.
  - `composeParts` refuses a part name, list, row kind, owner, table, event subject or kind of card that two parts both have, naming the part that came second.
  - A canvas owner is the kind of card that has a canvas of its own. `BoardRepository.locate` finds a canvas by a registered owner, and answers a ref to an unregistered owner's card as not found. `refOf`, `ownedCard`, `isCardCanvas` and `guardSync` name no owner.
  - A table a part keeps by board (`tables`: a `StoreTable`) is made by a migration, never by `build`. `BoardWriter` holds only the tables its Store's parts registered and calls each one's `removeBoard` when a board is deleted; a Store that did not register a table leaves its rows alone. The module that owns a table reaches it by its kind (`BoardRepository.table`): the core's code names none.
  - Events are read and written by the subjects a part registers (`subjects`; the core's own is `item`). `EventTables` (`src/core/store/eventTables.ts`) builds its filters from the registry and names no column of a part's. A query, or a `record` call's `about`, that names a subject the Store did not register is refused with a `BoardError`, never ignored. A new call site names its subject in `about`, never a column or a list. What `record` stores is pinned by `test/recordSubjects.test.ts`.
  - A pin's links come from stored data, so `recordCanvas` keeps only the subjects the Store registered (`EventRegistry.known`) and never throws halfway through a change.
  - What counts towards a board's activity beyond the latest of each actor is a rule a part gives (`activity`), so `activity()` holds no card-specific text.
  - The core's `types.ts` holds the core's types alone: a part adds its own by module augmentation, in a file of its own.
  - The core's readers (requests, threads, the conversation, search, Projects, the terminal's chat, the MCP server) find cards through the registries a part fills and name no kind of card. A place that names a kind of card by its type takes `CardKindName`, `SearchKind` or `ThreadDoor`.
  - A REST body that names a card takes the `<kind>Id` of a kind `store.cardKinds()` lists. An events query reads any other parameter as a kind, which a Store that keeps no events about it refuses in a sentence.
  - The card reading (`CardReading`, `src/core/cardReading.ts`), the board cards (`src/core/cards.ts`), the search cards, the reference kinds, the door words (`useDoors`) and the terminal's chat fields (`useChatFields`) stay process-wide by design: each process runs one edition. A test that builds Stores of both editions in one process registers what it needs. the work per project on Projects is the app's (`ProjectsOptions.work`).
  - A test of the core that needs a card makes a kind up, never a real one (`test/madeUpCards.ts`).

## Security

- A route that acts as the person must check `asPerson` or `personOnly` in `src/server/access.ts`: other accounts on the computer can reach the port.
- The lock's secret goes only to `src/server/proof.ts` and the approval hook: never log, send or return it. Pinned by `test/lock.test.ts` and `test/approvals.test.ts`, which check it never reaches commands, pages or replies.
- A connector in the core must not depend on a confidential secret: the code is public. Ship only what the service treats as public (a client ID, Google's Desktop client); otherwise sign in with PKCE, device flow or a token the person pastes.

## Tests

- The suite stays small and fast. Add a test only for stored data (a migration or a golden file), security, a contract at its edge (an agent tool, a REST route, or a registry these docs promise) or a smoke test of a page.
  - Extend an existing test or golden before adding a file.
  - Add no test file that drives Chrome.

## Systems and running things

- Code must work on macOS, Linux and Windows, or refuse with a message saying why.
  - CI runs Linux and Windows, not macOS: run the tests on a Mac yourself when a change touches what differs there (`src/platform/`, paths, processes, the pty switcher). Each release runs the whole suite on the Mac it is made on before it is tagged, and makes its Homebrew bottle there.
  - A test that needs POSIX skips on Windows with its reason: `{ skip: WINDOWS && '…' }` from `test/platform.ts`.
- Run anything by hand on a scratch port and data folder (`PORT=4610 TRICOT_DATA_DIR=$(mktemp -d) npm start`): `~/.tricot` holds the person's own boards.
