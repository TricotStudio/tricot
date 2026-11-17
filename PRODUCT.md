# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A solo builder (a founder or developer) working alongside their own AI agents. The same person uses it for code (e.g. "how does signup work, and where do people drop out?") and for business work (e.g. a partnership and influencer growth plan). They talk it through at their own pace, between other work, often with the board open in a background tab while agents keep going.

Other people can use the same board, so it may occasionally have more than one human. The design centre is still one person with several agents.

Agents are the second audience. They never see the visual UI; they read and write the same board as compact Markdown through MCP tools.

## Product Purpose

*Work it out with your agents, where you can both see it.* Tricot replaces "the agent explains in chat, and the answer scrolls away" with a shared board. An agent shows what it found on a canvas of typed blocks (notes, tables, diagrams, images, diffs, code, charts) on a Sketchbook page, and the person talks it through with the agent in a thread, pins a comment to the exact part they mean, or points the agent at a file in their project.

Success: the person understands the work faster and steers it with less typing, agents are rarely waiting on a question that fits on a page, and what was worked out stays on the board instead of in a chat that scrolled away.

## Positioning

The board is a boundary object, after Maggie Appleton's *Planning with Agents*: one structure that each side reads in its own form. Humans get a visual board and canvases; agents get Markdown digests and typed tools. Judgement stays human: agents talk a thing through in plain words first, and make something only once the person asks for it or agrees to what the agent suggests.

## Operating Context

- Runs locally: `npm install -g tricot` (or Homebrew, or `npx tricot`), then `tricot connect` finds the agents on the computer and connects them in one step, with each agent's hook (live steps, and "show me this on Tricot" from the agent's own terminal where it takes a prompt hook) and, for Claude Code and Codex, a Tricot skill that makes that request work even with Tricot stopped, after one question; `tricot canvas` starts the board on `http://127.0.0.1:4545`, or finds the one already running, and prints how to connect each agent. Agents connect over MCP Streamable HTTP: Claude Code, Codex, Pi, OMP, Gemini CLI, OpenCode, Grok Build, GitHub Copilot CLI, or any client that speaks it.
- Home lists the projects, one row each with its title, its description, who is on it, when it last changed and what the agents on it are doing now; a new project is a title away.
- Live steps: with the person's yes, a small hook in each agent's own settings shows what it is doing ("Running npm test"), for all six of those agents. It sends one line per step, never file contents or command output.
- A board has a Sketchbook of pages (a canvas each, of typed blocks: note, with tickable task lists; table, diagram, image, link, diff, code, chart, scene, website) with named groups, labelled links, and pins on precise parts of a block that carry their own comment threads. It has threads, each through a lens (General, Legal, Design…), and a Files view of the project's folder, where a person reads a file, edits it, or pairs on it with an agent.
- Live and asynchronous at once: an SSE feed updates the board, "since you were away" marks what changed, and *Live* shows which agents are listening, working, or not checking.
- Every change is logged with who made it and when; the log is also the cursor agents poll with.
- It checks npm once a day for a newer Tricot and updates in place from the page or `tricot update`; that request carries nothing about the person or their boards.

## Capabilities and Constraints

- Web UI in React (Vite) with React Flow for canvases and Mermaid for diagrams; Express server with REST, SSE, and an MCP endpoint, bundled into the `tricot` command (Node 22.13 or newer). Boards live in one SQLite database, `tricot.db`, in `~/.tricot` (or `TRICOT_DATA_DIR`), with images in `assets/` beside it.
- Local-only by default: it binds to `127.0.0.1` with no token, refuses requests whose `Origin` isn't its own and requests addressed to other hostnames, and keeps the data folder private to the account. Any program running as the person can still act on a local board, so the steps left to people are a convention agents keep, not a wall. Set to listen beyond this machine (`HOST`), it requires a token on everything, over plain HTTP, so only on a trusted network or through a tunnel.
- Human identity is a self-chosen name stored in the browser; agents are labelled by `?agent=Name` or their MCP client name.
- Connectors are internal, not plugins: Google Docs (the person picks each doc), GitHub, Figma and Linear (read-only), plus link cards that recognise common sites without signing in.
- Terminology to keep: *board*, *page*, *Sketchbook*, *canvas*, *block*, *group*, *link*, *pin*, *thread*, *lens*, *live steps*.
- Open source: the core and the `tricot` command are under Apache-2.0, free for anyone, companies included, and contributions come under the CLA. The source is at https://github.com/TricotStudio/tricot, and every running Tricot links to it from Home.

## Brand Commitments

- Credit Maggie Appleton's [Planning with Agents](https://maggieappleton.com/planning-agents) as the origin of the idea.
- The name is Tricot, and it is Tricot Studio's: the licence doesn't grant it, so a fork needs a name of its own. The mark is a woven lattice, the wordmark is set in Cal Sans, and an agent at work shows as a thread knitting a row of loops.

## Evidence on Hand

- Future work must not invent users, testimonials, usage data or benchmarks.

## Product Principles

1. **The human steers; agents inform.** Agents talk a thing through in plain words first, and make something only once the person asks or agrees.
2. **Agents never wait idle.** Every surface should make it easy to unblock work fast and safe to leave the rest for later.
3. **One truth, two readings.** Anything a human can see or edit must have an explicit structure agents can read, and the reverse.
4. **Respect the human's attention.** Mark what changed since they looked, and keep everything else quiet.
5. **Local and private.** Data stays on the machine: no accounts, localhost by default, and outside services only when the person connects one.

## Accessibility & Inclusion

WCAG 2.2 AA is required in both light and dark themes: text and control contrast, visible keyboard focus, full keyboard operation, and respect for reduced-motion preferences.
