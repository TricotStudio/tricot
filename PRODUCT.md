# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A solo builder (a founder or developer) planning alongside their own AI agents. The same person uses it for code decisions (e.g. "Which retry strategy should the API client use?") and for business work (e.g. a partnership and influencer growth plan). They answer at their own pace, between other work, often with the board open in a background tab while agents keep going.

Other people can be routed into a decision by name (*Ask someone*), so a board may occasionally have more than one human. The design centre is still one person with several agents.

Agents are the second audience. They never see the visual UI; they read and write the same board as compact Markdown through MCP tools.

## Product Purpose

*Steer your agents.* Tricot replaces "agent asks a question in chat and waits" with a shared board. Agents post each open question as a decision card with lettered options and a recommendation, then keep working on whatever isn't blocked. The human answers when it suits them, asks agents to explore first, or defers. Settled decisions turn into tasks that agents claim, report on, and hand back for review.

Success: the human makes better-informed calls with less interruption, agents are rarely idle or blocked, and there's a clear record of who decided what and why.

## Positioning

The board is a boundary object, after Maggie Appleton's *Planning with Agents*: one structure that each side reads in its own form. Humans get a visual board and canvases; agents get Markdown digests and typed tools. Plans stay open to revision: a changed decision marks every task built on it as stale until an agent re-checks it. Judgement stays human: only people decide, defer, or mark criteria; agent calls land as *provisional* for a person to confirm.

## Operating Context

- Runs locally: `npm install -g tricot` (or Homebrew, or `npx tricot`), then `tricot` starts the board on `http://127.0.0.1:4545`, or finds the one already running, and prints how to connect each agent. Agents connect over MCP Streamable HTTP: Claude Code, Codex, Pi, OMP, Gemini CLI, OpenCode, or any client that speaks it.
- The first run is a page, not a manual: until there is a project, Home asks "What are you working on?", and one sentence makes the project and asks the agent what it needs decided, with the command to connect the agent found on the machine beneath it.
- Live steps: with the person's yes, a small hook in each agent's own settings shows what it is doing on the card it works on ("Running npm test"), for all six of those agents. It sends one line per step, never file contents or command output.
- Decisions move through five statuses: open, exploring, provisional, decided, deferred. Tasks start in the person's backlog or in to do, move through their own lanes (in progress, in review, blocked, done), can go stale, and can be dropped.
- Every board has a project context canvas; every decision and task has its own canvas of typed blocks (note, with tickable task lists; table, diagram, image, link, comparison) with named groups, labelled links, blocks pinned to options, and pins on precise parts of a block that carry their own threads.
- Live and asynchronous at once: an SSE feed updates the board, an inbox and opt-in desktop notifications surface what needs the human, "since you were away" marks what changed, and *Live* shows which agents are listening, working, or not checking.
- Every change is logged with who made it and when; the log is also the cursor agents poll with.
- It checks npm once a day for a newer Tricot and updates in place from the page or `tricot update`; that request carries nothing about the person or their boards.

## Capabilities and Constraints

- Web UI in React (Vite) with React Flow for canvases and Mermaid for diagrams; Express server with REST, SSE, and an MCP endpoint, bundled into the `tricot` command (Node 22.13 or newer). Boards live in one SQLite database, `tricot.db`, in `~/.tricot` (or `TRICOT_DATA_DIR`), with images in `assets/` beside it.
- Local-only by default: it binds to `127.0.0.1` with no token, refuses requests whose `Origin` isn't its own and requests addressed to other hostnames, and keeps the data folder private to the account. Any program running as the person can still act on a local board, so the steps left to people are a convention agents keep, not a wall. Set to listen beyond this machine (`HOST`), it requires a token on everything, over plain HTTP, so only on a trusted network or through a tunnel.
- Human identity is a self-chosen name stored in the browser; agents are labelled by `?agent=Name` or their MCP client name.
- Connectors are internal, not plugins: Google Docs (the person picks each doc), GitHub and Figma, plus link cards that recognise common sites without signing in.
- Terminology to keep: *board*, *decision*, *option* (lettered a, b, c), *recommendation*, *finding*, *criteria* and *marks*, *ask*, *task*, *stale*, *project context*, *canvas*, *block*, *group*, *link*, *pin*, *thread*, *live steps*, *Needs you*.
- Open source: the core and the `tricot` command are under AGPL-3.0-only, with a commercial licence for anyone who can't meet it (`COMMERCIAL.md`), and contributions come under the CLA. The source is at https://github.com/TricotStudio/tricot, and every running Tricot links to it from Home. Tricot Studio's desktop app and its team features (shared boards, sign-in, roles and sync) are separate products, closed source.

## Brand Commitments

- Credit Maggie Appleton's [Planning with Agents](https://maggieappleton.com/planning-agents) as the origin of the idea.
- The name is Tricot, and it is Tricot Studio's: the licence doesn't grant it, so a fork needs a name of its own. The mark is a woven lattice, the wordmark is set in Cal Sans, and an agent at work shows as a thread knitting a row of loops.

## Evidence on Hand

- `scripts/demo.ts` seeds a realistic example board ("API client retry logic") with decisions in every status, findings with metrics, and canvas blocks.
- No users, testimonials, usage data, or benchmarks exist. Future work must not invent them.

## Product Principles

1. **The human decides; agents inform.** Never preselect or nudge toward the recommendation; agent judgement calls stay provisional until a person confirms them.
2. **Agents never wait idle.** Every surface should make it easy to unblock work fast and safe to leave the rest for later.
3. **One truth, two readings.** Anything a human can see or edit must have an explicit structure agents can read, and the reverse.
4. **Respect the human's attention.** Surface what needs them first, mark what changed since they looked, and keep everything else quiet.
5. **Local and private.** Data stays on the machine: no accounts, localhost by default, and outside services only when the person connects one.

## Accessibility & Inclusion

WCAG 2.2 AA is required in both light and dark themes: text and control contrast, visible keyboard focus, full keyboard operation (options are radios and must stay keyboard-selectable), and respect for reduced-motion preferences.
