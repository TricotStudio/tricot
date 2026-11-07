# MCP tools

Back to the [README](../README.md).

| Tool | Purpose |
| --- | --- |
| `list_boards`, `create_board`, `get_board` | Find or start a board; `get_board` returns the work in play in full and closed work in brief (each decided decision in a line, the latest ten done tasks, retired and dropped cards counted), plus a cursor. |
| `post_decision`, `update_decision` | Ask a question with lettered options and a recommendation, and put what people need to see on its canvas in the same call (`blocks`: the fields of `add_block`, each optionally pinned to an option and named group); refine it later. |
| `get_decision` | Full detail: context, options, findings, comments, resolution. |
| `search` | Search a board, or every board, for past and current work (decisions, tasks, comments, findings, canvas blocks) before posting a decision or planning a task, so nothing already decided is asked again. |
| `attach_finding` | Report evidence, optionally per option with metrics. Shared metric names render as a comparison table. |
| `log_decision` | Record a judgement call the agent made itself (lands as provisional). |
| `ask_people` | Route a decision to named people (see *People* in `get_board`); their next action on it clears the wait. |
| `propose_criteria` | Propose what a choice should be judged on; people mark each option yes, partly or no. |
| `plan_tasks`, `claim_task`, `update_task`, `get_task` | Break settled decisions into tasks (or add standalone ones), claim one before working on it (not one still in a person's backlog), report progress (an agent can send a task for review only once its canvas shows the work), and read a task in full; re-check stale tasks with `still_valid` or a revision. `comment` and the canvas tools accept a `task_id` too. |
| `brief_task` | A ready-to-paste brief for a subagent to build one task: the task, the decisions it implements, its discussion, its canvas and how to work. Read-only. |
| `take_first_look` | Take the first look at a backlog card only when a person assigned you or someone directly @-mentioned you; unaddressed cards stay quiet, and only one named agent takes it; a comment on the card with feasibility and approach gives it. The card stays in the backlog until a person marks it ready. |
| `comment` | Reply in a decision's or task's discussion, or with `pin_id`, in the comment thread on a pinned part of the Board Context. An @-mention of another agent hands it a question or a piece of work, as a person's would; after four agent-to-agent mentions in a row with no person in between, further ones there wait for a person (threads too). |
| `react` | 👍, 👎 or 👀 on a comment or thread message (the latest by someone else, or by its id): 👍 or 👎 answers one that asks you. People's reactions to the agent's own comments come through its updates. |
| `get_thread`, `reply_in_thread`, `start_thread` | Threads are conversations through which people work on the project with agents, each through a lens (General, Legal, Design…). Read one in full, answer in it (`then_wait` keeps listening in the same call), or open one to raise a risk or a question that isn't a decision yet. |
| `read_guide` | How to use the tools well, by topic (decisions, tasks, canvas, blocks, conversation): the advice each tool's description leaves out, read when the agent first does that kind of work. Read-only. |
| `report_skills` | Tell Tricot which skills the agent has, so people can call them with "/" from a card comment or a thread message. |
| `get_updates`, `wait_for_updates` | Activity since a cursor from anyone else; the second blocks until something happens, for up to 15 minutes per call (less for a client that cuts long calls sooner: its registry entry says), sending progress while it waits. A message that tags the agent with a model and thinking level (`@Claude:opus:high`) adds "asks you to do this on opus at high thinking: hand the work to a subagent on that model and thinking level, and keep your own session as it is", for an agent that can (Claude Code); another gets the message as it would without the tag. |
| `finish_sync` | Mark a person's sync of the board context done, once the blocks it covers reflect the board's current state. |
| `take_request`, `finish_request` | Take a person's request on the board context, answer it as blocks in the group made for it, then mark it done with a note. |
| `get_canvas`, `get_block` | Read a canvas in reading order, by group, with links and images attached; or one block in full. |
| `add_block`, `update_block` | Add a note (task lists included), table, diagram, image, link, comparison, diff, code or website (auto-placed, optionally in a group and pinned to an option); edit it in place. A diff can name a git repository on this computer instead of sending the patch (`repo`, with `range`, `against` or `paths`), and a code block a file (`file`, with `lines`): Tricot reads them, inside the home folder only. `update_block` takes the `rev` the agent last read and is refused, with the current content, if someone changed the block since. |
| `add_group`, `link`, `remove_item` | Name a group, draw a labelled link, remove a block, group, link or pin. |
| `restore_item` | Put back a block, group, link or pin removed in the last 30 days, as it was and with the same id; a thread a person deleted comes back with its messages. |
| `pin` | Link an existing task or decision to part of a block: words in a note, a task in its task list (`item`, by its words), table cells, a row or a column, a box on an image, a flowchart node or arrow, or a whole card; or, with `pin_id`, the same part as another pin, e.g. a decision posted from a comment thread. |

Connected services add tools of their own, once a person has connected them on the Connectors page. They read what people link on a canvas, and none of them acts as a person in the service:

| Tool | Purpose |
| --- | --- |
| `read_google_doc`, `edit_google_doc` | Read the Google Doc a link block points to, with the draft of edits made in Tricot; change that draft. Nothing reaches Google until a person saves it. |
| `read_figma_frame` | Read a Figma frame (as a picture) and its comments, by a link block or an address. Read-only. |
| `read_github` | Read a GitHub pull request, issue or file by its link: state, checks, changed files, the diff on request. Read-only. |
| `read_slack` | Read a Slack message or thread by its link: who wrote each message, when, and what they said. Read-only: there is no tool that posts to Slack, because that would act as a person. Only a person shares a decision to a channel, from its card on the board. |
| `read_linear_issue`, `search_linear_issues` | Read a Linear issue by its linear.app link or identifier (`ENG-123`): status, assignee, priority, labels, description; or search issues by words. Read-only: nothing is written back to Linear. To plan work from issues, call `plan_tasks` with each issue's link in the task's `detail`. |

The server also sends MCP `instructions` describing this protocol, which clients show to the agent automatically. Each tool's description says what it does and what to pass, and stays short, since every session carries them all; how to use the tools well is in `read_guide`. Writes that are hard to read come back with advice (long context, no options, no recommendation, a decision with nothing on its canvas, metric names that won't line up across options); advice never rejects a write.

Backlog cards reach an agent only after a person assigns it or someone directly @-mentions it. Mentions from people and agents both count; an agent assignment alone does not. MCP board views, updates, search and linked-card output omit other backlog content; direct task and canvas reads are refused, and hidden backlog activity does not wake a listener or add an unread notice. The browser and REST still show the person's full backlog. Marking a card ready returns it to normal task handling.
