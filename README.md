# Tricot

*Steer your agents.* A shared planning board where humans and agents make decisions together. Agents connect over MCP and post the questions they would otherwise ask in chat; humans answer on a live board, at their own pace, while agents keep working on whatever isn't blocked.

Built on ideas from Maggie Appleton's [Planning with Agents](https://maggieappleton.com/planning-agents): the board is a *boundary object* that each side reads in its own form (agents get compact Markdown through tools, humans get a visual board), plans stay open to revision, and agents gather evidence before humans commit.

## Quick start

Needs Node 22.13 or newer.

```sh
npm install -g tricot   # installs the tricot command on your computer
tricot                  # starts the board (or finds the one running), opens it, prints how to connect
```

With Homebrew, `brew install tricotstudio/tap/tricot` installs the same command, with Node.js if you don't have it.

The same `npm install -g tricot` updates it (`brew upgrade tricotstudio/tap/tricot` with Homebrew), and `npm uninstall -g tricot` removes the command; your boards stay in `~/.tricot` either way. To try it once without installing, `npx tricot` runs the same command.

`tricot status` shows where it runs, `tricot stop` stops it, `tricot connect [claude|codex|pi|omp|gemini|opencode|mcp-json|url]` prints the command that connects an agent, `tricot --background` keeps it running after the terminal closes, and `tricot update` updates it (see [Updates](#updates)). It uses one server per data folder (a `server.lock` inside it), so a second `tricot` reuses the first. `tricot --help` lists the options.

The first `tricot` in a terminal finds the agents on your machine (Claude Code, Codex, Pi, OMP, Gemini CLI, OpenCode) and asks once whether to show their steps live on your boards ("Reading src/app.ts", "Running npm test" on the card each one works on). It lists the files it would write for each agent; a yes adds a small hook to each agent's own settings, for every project, and a no is remembered too (in the data folder), so it isn't asked again. It never asks without a terminal, in CI, or with `--no-hooks`; `--verbose` shows every line first. `tricot hooks` shows where each agent stands, and `tricot hooks on|off [--agent claude|codex|pi|omp|gemini|opencode]` turns them on or off later, again showing the lines and asking first (`--yes` skips the question). Each agent's panel in Tricot has the same as a "Live steps" switch, which shows the exact files and lines before it writes anything; agents can't turn it on or off themselves. Codex runs a new hook only once you trust it in its `/hooks`, which Tricot says when it sets it up. None of this touches a project's own settings: a project that still has its hook from `tricot connect claude --hooks` keeps it, and each step still shows once (the board keeps one of the two copies).

`tricot connect claude --hooks`, run in a project, offers to add a Claude Code hook to its `.claude/settings.json` (it shows the JSON and asks first): the card Claude works on then shows what it is doing, one line per step ("Running npm test"), and a command or subagent that takes a while stays live until it ends ("Ran npm test (42 s)"). The same line shows under a message you're waiting on Claude to answer, and on the project's row on the home page. The hook sends no file contents or command output, runs in the background and does nothing when Tricot isn't running. With `--narration` it also sends the first line of each message Claude writes in the terminal (never its thinking); that is off unless you ask for it. `--remove-hooks` takes it out again.

From a checkout:

```sh
npm install
npm run build
npm start            # http://127.0.0.1:4545
```

Connect Claude Code (or any MCP client that speaks Streamable HTTP):

```sh
claude mcp add --transport http tricot http://127.0.0.1:4545/mcp
```

Add `?agent=Name` to the URL to label an agent on the board, e.g. when several agents share one board. Without it, the MCP client's own name is used.

To see a populated board, run `npm run demo` while the server is up.

## How a decision moves

| Status | Meaning for agents |
| --- | --- |
| **open** | Waiting on humans. Keep working on anything it doesn't block. |
| **exploring** | Humans want evidence first: research or prototype the options and report with `attach_finding`. |
| **provisional** | Proceed, but keep it cheap to change. Agent-made calls (`log_decision`) land here for humans to confirm. |
| **decided** | Binding. |
| **deferred** | Not now. Don't build on it; pick a reversible default. |

Every change is logged with who made it and when. The log doubles as the sync cursor agents poll with.

**Human decisions are protected.** Once a person has decided (or provisionally decided, or deferred) a question, agents can't reword it, add options, change the recommendation or answer it; they can still comment, attach findings and add canvas blocks. Answers that stop standing (replaced, confirmed, reopened, sent back to explore, deferred) are kept under *Earlier answers* with who ended them.

**Asking people.** A decision can be routed to named people, by an agent (`ask` on `post_decision`, or `ask_people`) or from the panel (*Ask someone*). It shows *waiting for Alex* on the card and lands under Alex's *Needs you*; questions waiting only on other people drop out of yours. The asked person's next comment, answer or criteria mark clears the wait, and the event says so, so whoever asked sees it in their updates.

**Reactions.** Under any comment or thread message, the smiley button adds 👍, 👎 or 👀; click your own again to take it back. A 👍 or 👎 on a comment that asks you something is your answer, so it leaves your *Needs you* without a reply, and the agent that wrote it reads it in its updates (*Sam reacted 👎 to your comment on T115*). Agents put 👀 on your comment the moment it reaches them, so you know it was seen; that is quiet, waking no other agent and adding nothing to the activity. Agents react too (`react`), when a reply would only say yes, no or seen.

**Criteria.** For choices that hinge on trade-offs, anyone can propose what the options should be judged on (agents with `propose_criteria`). Only people mark the matrix, clicking each cell through yes, partly and no: a mark is a human judgement, and agents read it as one in `get_decision`.

**Tasks.** Settled decisions turn into work: agents break them into tasks (`plan_tasks`), or you add tasks yourself, or you click *Ask agents to plan tasks* on a decision. A task can also stand alone (a bug, a chore, an idea) and be linked to a decision later; only linked tasks go stale. Tasks you add land in the **Backlog**, where you can shape them (detail, canvas, discussion) and agents can read and comment but can't take them; one click on *Mark ready* moves one to *To do*, where agents pick it up. Tasks agents plan from settled decisions go straight to *To do*. Open a task to see it like a decision: its own canvas for context and results, and a discussion with the agent doing it. Finished work waits under *Needs you* as *to review*: *Looks good* approves it, *Needs changes* sends it back to the agent with your note. Agents claim a task and report on it (in progress, in review with a PR link, blocked with a reason, done); they can't send one for review until its canvas shows the work, so you never review blind. The *Tasks* tab shows them in status lanes, and each decision's panel lists the work built on it. If a decision changes (reopened, sent back to explore, deferred or re-decided differently), every task built on it, done ones included, is marked **stale**. Agents can't move a stale task forward until they re-read the decision and confirm it still holds or revise it; you can clear the flag with *Still holds*. Any action that would set aside a standing answer asks for a second click first, and says which tasks would go stale. A task that won't be done can be **dropped** from its ⋯ menu, with a reason if you like: it leaves the lanes (*Dropped* at the head of *Done* shows them), stays readable and searchable, keeps its links, and *Bring it back* returns it to the backlog or to *To do*; agents see it as dropped and leave it. A task or decision made by mistake can be **deleted** from the same menu, for good: the dialog names what links to it, and asks you to confirm. Tasks built on a deleted decision lose the link and go stale, text that names it reads as deleted, and its number isn't given again. Only people drop, bring back or delete a card.

**Inbox and notifications.** A bell in the header of the board and of every decision lists what's new for you, one row per card, with what needs your input first (a question asked of you, a new question, a reply in a thread you're part of, an agent's call to confirm, a blocked task). Clicking a row opens the card; cards name new comments, and unread ones are highlighted inside the decision. From the inbox you can switch on a desktop notification and a soft chime for those same things while the board is in a background tab.

**Who's here.** *Live* in the header says which agents have used the board in the last five minutes, what each is doing, and which tasks they have in progress: *listening* (waiting on the board, so it sees you right away), *working* (busy between checks) or *not checking* (quiet for two minutes or more). Agents can't be pushed to, so every tool call also tells them about activity they haven't read yet. An agent that can run background subagents is told to orchestrate: it stays listening and hands each task to a subagent.

**Since you were away.** Leaving a board (switching tabs, closing it, going back to the list) records what you'd seen. When you return, what others changed since is marked: a dot on each touched card and tab, a *new* badge on changed canvas blocks, highlighted activity, and an *N new · Mark seen* control. Opening a card or selecting a block marks it seen.

## Canvases

Every board has a **board context**, the *Board Context* tab: a canvas where people and agents keep the board's global context and current state (goal, constraints, architecture, what's done). Agents read it before planning and update it as decisions settle and tasks finish. It's the first of a board's three tabs, in the order the work goes: *Board Context* to see where things stand, *Decisions* to settle what to do, then *Tasks* to do it. Every decision also has its own **canvas** for its evidence, and every task one for its context and results. Open a decision or task to see its canvas beside its panel.

A canvas is a whiteboard of typed blocks rather than freeform shapes, so both sides can read it: you see and edit the visual, agents read and write the structure.

| Block | You | Agents |
| --- | --- | --- |
| Note | Markdown, double-click to edit. A task list (`- [ ] step`) ticks in place, and the header says how far along it is (3 of 7 done) | `text`; `items` replaces its task list, keeping ticks where the words match. A `checklist` with `items` is still accepted and makes a note |
| Table | Double-click a cell to edit; add or remove rows and columns | `columns`, `rows` |
| Diagram | Rendered Mermaid, double-click to edit the source | `source` |
| Image | Paste a screenshot, drop a file, or use *Image* | `image_path` or `image_base64`; returned as images |
| Link | A card with the site's icon, title and host; click the title to open it. Tricot draws the icons of the sites people link most (GitHub, Figma, Google Docs, Notion, Jira and others) and a plain link icon for the rest, so nothing is fetched from the site for its card. Paste a web address or use *Link*; double-click to edit | `url` (http or https) and an optional `title`; listed as `link "Title" → url` |
| Comparison | The options' finding metrics side by side (decision canvases) | rendered from findings |

Layout meaning is explicit so agents don't have to infer it: **groups** have names, **links** between blocks have labels (drag from a block's right edge), and a block on a decision canvas can be **pinned** to the option it supports. Hover an option in the decision panel to highlight its evidence.

Your edits reach agents as specific updates: *checked "Audit call sites"*, *set "status" in row 3 to "done"*, *moved table "Audit" into group "Option b evidence"*. Plain moves and resizes sync to other viewers without being logged.

**Pins.** On any canvas you can pin a precise part of a block: select words in a note (a task in its task list included), click a table cell (drag for a range, click a column name for the column, or widen cells to their rows or columns in the prompt), drag a box on an image (it's numbered on the picture), click a node or an arrow in a flowchart diagram, or use *Pin* on a selected link card. The part turns amber and a prompt quotes it. On the Board Context, *Ask a question* comes first (⌘↵): it puts the prompt's first line to the board as a decision pinned to the part, with the rest and a quote of the part as its context, and agents propose options; people you @-mention in it are asked, and an agent you mention finds the prompt as the card's first comment. *Create task* adds a separate task titled by the prompt's first line, quoting the part and its block (in the backlog unless you tick *Ready now*; on a settled decision's canvas it implements that decision), and its chip gives the task's status and opens it. *Comment* keeps the conversation where it is: on a task's or decision's canvas the comment goes in that card's discussion with the part quoted above it (click the quote to see the part on the canvas; the part's 💬 chip counts its comments and jumps to them), and on the Board Context, which has no discussion, it starts a thread on the pin, which the chip opens. Agents reply there, and may pin a decision to the same part when it needs your call; *Resolve* closes the thread and quiets its chip, and a reply reopens it. The part stays blue. Pins follow their part through edits (words by the text around them, cells by their column names and contents, boxes as fractions of the picture, diagram nodes and arrows by their id in the Mermaid source); a part edited away shows as changed (*text changed*, *node removed*) and stays listed. Hover a chip and click its ✕ to unpin it: the task or decision it led to stays, and so do a card's comments (a Board Context thread goes with its pin). Agents see pins and open threads under their block in `get_canvas`, comments with their quotes in `get_task` and `get_decision`, see where work came from there too, and pin existing work to parts themselves with `pin`.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `list_boards`, `create_board`, `get_board` | Find or start a board; `get_board` returns decisions by status plus a cursor. |
| `post_decision`, `update_decision` | Ask a question with lettered options and a recommendation, and put what people need to see on its canvas in the same call (`blocks`: the fields of `add_block`, each optionally pinned to an option and named group); refine it later. |
| `get_decision` | Full detail: context, options, findings, comments, resolution. |
| `attach_finding` | Report evidence, optionally per option with metrics. Shared metric names render as a comparison table. |
| `log_decision` | Record a judgement call the agent made itself (lands as provisional). |
| `ask_people` | Route a decision to named people (see *People* in `get_board`); their next action on it clears the wait. |
| `propose_criteria` | Propose what a choice should be judged on; people mark each option yes, partly or no. |
| `plan_tasks`, `claim_task`, `update_task`, `get_task` | Break settled decisions into tasks (or add standalone ones), claim one before working on it (not one still in a person's backlog), report progress (an agent can send a task for review only once its canvas shows the work), and read a task in full; re-check stale tasks with `still_valid` or a revision. `comment` and the canvas tools accept a `task_id` too. |
| `comment` | Reply in a decision's or task's discussion, or with `pin_id`, in the comment thread on a pinned part of the Board Context. |
| `react` | 👍, 👎 or 👀 on a comment or thread message (the latest by someone else, or by its id): 👍 or 👎 answers one that asks you. People's reactions to the agent's own comments come through its updates. |
| `get_updates`, `wait_for_updates` | Activity since a cursor from anyone else; the second blocks until something happens, for at most 4 minutes per call (MCP clients drop longer silent calls), sending progress while it waits. |
| `get_canvas`, `get_block` | Read a canvas in reading order, by group, with links and images attached; or one block in full. |
| `add_block`, `update_block` | Add a note (task lists included), table, diagram, image, link or comparison (auto-placed, optionally in a group and pinned to an option); edit it in place. `update_block` takes the `rev` the agent last read and is refused, with the current content, if someone changed the block since. |
| `add_group`, `link`, `remove_item` | Name a group, draw a labelled link, remove a block, group, link or pin. |
| `pin` | Link an existing task or decision to part of a block: words in a note, a task in its task list (`item`, by its words), table cells, a row or a column, a box on an image, a flowchart node or arrow, or a whole card; or, with `pin_id`, the same part as another pin, e.g. a decision posted from a comment thread. |

The server also sends MCP `instructions` describing this protocol, which clients show to the agent automatically. Writes that are hard to read come back with advice (long context, no options, no recommendation, a decision with nothing on its canvas, metric names that won't line up across options); advice never rejects a write.

## Updates

When it starts, and then once a day, the server asks the npm registry for the latest version of `tricot` (`GET https://registry.npmjs.org/tricot/latest`). That request is all it sends: no identifier, not the version you run, nothing about your boards. The answer is kept in memory and in `update-check.json` in the data folder, so a restart within the day doesn't ask again. Offline, the check gives up after five seconds, tries again an hour later, and never holds up the start.

When a newer version is out, Home and each board's top bar say so quietly ("Tricot 0.2.0 is out"), with the release's notes when it has them and a link to what's new. **Update** installs it and restarts Tricot on the same address, with the same data folder and options; the page says "Updating to 0.2.0…" and reconnects by itself. **Skip this version** hides it until a newer one is out. How Tricot installs it depends on how you installed Tricot:

- With `npm install -g tricot`: `npm install -g tricot@<version>`, when npm's global folder is yours. When it needs administrator rights (a Node installed for the whole system), Tricot shows `npm install -g tricot@latest` with a Copy button, for you to run yourself, with `sudo` if that's how you installed it. Tricot never runs `sudo`.
- With Homebrew (`brew install tricotstudio/tap/tricot`): `brew upgrade tricotstudio/tap/tricot`, when Homebrew's folder is yours, or else that command to copy.
- With `npx tricot`: the new version, from npx's cache.

Anywhere else (on Windows, from a project's own `node_modules`, from a checkout) it shows the command to run instead. Every command runs as a program with its arguments, never through a shell. Before it restarts, Tricot checks that the new version is the one installed (`tricot --version`), so a Homebrew tap that hasn't caught up changes nothing. If the new version doesn't start, the old one is put back and started again; why is written to `update.log` in the data folder, and Tricot says so the next time you open it. A new version that changes how boards are stored keeps a copy of them in `backups/` first.

`tricot update` does the same from a terminal: it asks the registry, then updates the board that is running, or installs the new version when none is. `tricot --version` prints the version you have.

To turn the check off, set `TRICOT_NO_UPDATE_CHECK=1`, or start Tricot with `--no-update-check`. It is off as well when Tricot runs from a checkout (`npm start`, `npm run dev`) and in tests. `tricot update` still asks when you run it.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `4545` | |
| `HOST` | `127.0.0.1` | Binding wider than this machine turns on the access token; see below. |
| `TRICOT_NO_UPDATE_CHECK` | | `1` turns off the daily check for a newer Tricot; see [Updates](#updates). |
| `TRICOT_DATA_DIR` | `~/.tricot` | `tricot.db`, one SQLite file holding every board and saved change by change, each board's event log and each block's earlier versions in tables of their own, read a page at a time (with its `-wal` and `-shm` files while a server runs; a copy is kept in `backups/` before any upgrade of its format), `assets/` for images, `server.lock` while a server runs, and `token` once `HOST` is set beyond this machine. A data folder from one of the tool's earlier names is moved here on the first start. Boards from versions that kept one JSON file each are imported into the database on the first start, checked against it, and the files kept in `backup-json-<date>/`. The copies in `backups/` are whole databases, taken before upgrades, so a board you deleted can still be in an older one; delete old backups to be rid of it (deleting a board does remove its file from `backup-json-*/`). A database saved by a newer Tricot is refused, untouched. |

On `127.0.0.1` (the default) there is no token: one kept in your data folder couldn't stop a program running as you, and would only make every agent reconnect. What can still reach a local server is a web page open in your browser, so requests that carry an `Origin` other than the server's own are refused (403), and requests addressed to other hostnames are rejected (DNS-rebinding protection). No other site can show Tricot inside a frame of its own, either, and any request another site's page makes to Tricot (the browser says `Sec-Fetch-Site: cross-site`), such as a picture or a script pointing at the API, is refused (403), except opening Tricot in a tab and a connector's sign-in coming back. Agents and `curl` send neither header and pass. Tricot's pages carry a Content-Security-Policy that runs only Tricot's own scripts (and Google's Picker), frames only the players and viewers a link card opens in place, and shows pictures only from Tricot itself and `data:` URLs, so no picture on a board tells another site, or a device on your network, when you open it. The data folder is made private to your account (mode 700) and the files Tricot writes are 600, so other accounts on the computer can't read your boards. An open folder is tightened on start when it is `~/.tricot`, is new, or already holds Tricot's boards, lock or token; any other `TRICOT_DATA_DIR` keeps its mode, with a note on how to run `chmod 700` yourself.

No token also means that any program running as you on this computer can act on a local board, as any person or any agent. That includes an agent with a shell, which can call the REST API as easily as `curl` can. The steps a board leaves to people, such as deciding a question or deleting a card, are a convention that well-behaved agents keep by working through the MCP tools; they are not a wall that stops a program from taking those steps.

When `HOST` is set to listen on the network (`0.0.0.0`, a LAN address), Tricot makes a token once (kept in `<data folder>/token`) and requires it on everything: MCP, REST and the UI. Agents send `Authorization: Bearer <token>` (or `?token=` on the MCP URL for a client that can't set a header). Open `http://host:port/?token=<token>` once in the browser: it sets an HttpOnly, SameSite=Strict cookie and the board works normally after. `tricot` and `tricot connect` print the commands with the token in this mode. Agents may attach images by local file path only while the server is bound to localhost. Images are stored under `TRICOT_DATA_DIR/assets`, accepted only if their bytes are PNG, JPEG, GIF or WebP, and served with `nosniff`.

Network mode is plain HTTP with a token, so the token and your boards cross the network unencrypted. Use it only on a network you trust, or reach the server over an encrypted path instead: an SSH tunnel to a server left on `127.0.0.1` (`ssh -L 4545:127.0.0.1:4545 <host>`), or Tailscale. The `?token=` address also stays wherever it is pasted or run, such as an agent's MCP settings and your shell history, so those deserve the same care as the token itself.

## Google sign-in

Connectors → Google signs in with PKCE and a redirect back to this server on `127.0.0.1` (any port, so `tricot --port` works). It asks only for your email and `drive.file`: Tricot sees the Google Docs you choose with Google's Picker ("Choose a Google Doc" when adding a link, "Choose Google Docs" on the Connectors page, or "Choose in Google" on a doc's card), and nothing else in your Drive. Sign-ins made before this, with the wider scopes, keep working until you connect again.

**Tricot Studio: fill in the client once.** The client ships with Tricot, in `src/server/connectors/google/builtIn.ts`, so people only click Connect. Google treats a Desktop client as public (its ID and "secret" can ship); what protects a sign-in is PKCE and the loopback redirect.

1. In Tricot Studio's Google Cloud project, enable the Google Docs API, the Google Drive API and the Google Picker API.
2. Set up the OAuth consent screen (Google Auth Platform) and add the `drive.file` scope. It is not a sensitive or restricted scope, so it needs no security review.
3. Create an OAuth client of type **Desktop app**. Put its Client ID in `clientId` and its Client secret in `clientSecret`.
4. Create an API key, restrict it to the Google Picker API and to the HTTP referrers `http://127.0.0.1:*/*` and `http://localhost:*/*`, and put it in `pickerApiKey`. (The Picker's app ID is the project number, which is the digits that start the client ID, so there is nothing to add for it.)

Until `clientId` and `clientSecret` are filled in (values starting with `FILL_IN` count as empty), Tricot has no client of its own and asks people for one, as before: they create a Desktop client in their own Google Cloud project and save its JSON in the data folder as `google-client.json` (or the `client_secret_….json` Google downloads); to use the Picker with it they also add `"picker_api_key": "…"` inside its `"installed"` object. **A client file in the data folder always takes over from the built-in one**, and the Connectors page says which one is in use. None of these values is logged or sent anywhere but Google; the one thing the server hands the browser is a short-lived access token for Google's own Picker.

## Development

```sh
npm run dev        # server + Vite HMR on one port, restarts on server changes
npm test           # store unit tests + MCP/REST end-to-end tests
npm run typecheck
```

To see the update notice without a release, start Tricot with `TRICOT_UPDATE_URL='data:application/json,{"version":"9.9.9"}'`: the check reads that instead of asking npm, even from a checkout.

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

## Next steps

- **Plan vs. what was built:** compare the files and PRs on each task with the decisions it implements, and flag drift.
- **Exploration runner:** on "Ask agents to explore", spawn one agent per option in its own git worktree and attach the results as findings automatically.
- **More block types:** live previews of a running prototype, timelines and file-touch maps.

## License

Tricot's core and its command line (the `tricot` command) are open source under the [GNU Affero General Public License, version 3 only](LICENSE) (AGPL-3.0-only), free for everyone, companies of any size included. If you pass Tricot on, or let people use a changed version of it over a network, you offer them its source under the same licence. Anyone who can't do that, to embed Tricot in a closed product, to offer a changed Tricot without sharing the changes, or because their company's policy rules out the AGPL, can get a [commercial licence](COMMERCIAL.md) from Tricot Studio. Tricot Studio's desktop app and team features (shared boards, sign-in, roles and sync) are separate, closed-source products under their own terms. To contribute, open an [issue](https://github.com/TricotStudio/tricot/issues) or a pull request on GitHub, after reading [CONTRIBUTING.md](CONTRIBUTING.md) and the [CLA](CLA.md).

**Source:** https://github.com/TricotStudio/tricot. A running Tricot links to it from the foot of its home page (*Source*, beside its version), so anyone using one, over a network included, can find the code it runs.

"Tricot" is Tricot Studio's name, and the licence doesn't grant it: a fork needs a name of its own.

Copyright © 2026 Tricot Studio.

## Credits

Canvases are built on [React Flow](https://reactflow.dev) by xyflow (MIT). The wordmark is set in [Cal Sans](https://github.com/calcom/font) by Cal.com (SIL Open Font License 1.1, in `src/web/fonts/OFL.txt`).

The installed package carries `THIRD_PARTY_NOTICES.md`: the name, version and full licence of every library bundled into it, which the build writes from what the bundles hold (`scripts/notices.mjs`).
