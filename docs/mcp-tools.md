# MCP tools

Back to the [README](../README.md).

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
| `comment` | Reply in a decision's or task's discussion, or with `pin_id`, in the comment thread on a pinned part of the Board Context. An @-mention of another agent hands it a question or a piece of work, as a person's would; after four agent-to-agent mentions in a row with no person in between, further ones there wait for a person (threads too). |
| `react` | 👍, 👎 or 👀 on a comment or thread message (the latest by someone else, or by its id): 👍 or 👎 answers one that asks you. People's reactions to the agent's own comments come through its updates. |
| `get_updates`, `wait_for_updates` | Activity since a cursor from anyone else; the second blocks until something happens, for at most 4 minutes per call (MCP clients drop longer silent calls), sending progress while it waits. |
| `get_canvas`, `get_block` | Read a canvas in reading order, by group, with links and images attached; or one block in full. |
| `add_block`, `update_block` | Add a note (task lists included), table, diagram, image, link or comparison (auto-placed, optionally in a group and pinned to an option); edit it in place. `update_block` takes the `rev` the agent last read and is refused, with the current content, if someone changed the block since. |
| `add_group`, `link`, `remove_item` | Name a group, draw a labelled link, remove a block, group, link or pin. |
| `pin` | Link an existing task or decision to part of a block: words in a note, a task in its task list (`item`, by its words), table cells, a row or a column, a box on an image, a flowchart node or arrow, or a whole card; or, with `pin_id`, the same part as another pin, e.g. a decision posted from a comment thread. |

The server also sends MCP `instructions` describing this protocol, which clients show to the agent automatically. Writes that are hard to read come back with advice (long context, no options, no recommendation, a decision with nothing on its canvas, metric names that won't line up across options); advice never rejects a write.
