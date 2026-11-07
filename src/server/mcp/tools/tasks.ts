import { peopleTextAdvice, withAdvice } from '../../../core/advice';
import { taskDiscussion } from '../../../core/answering';
import { FIRST_LOOK_MS } from '../../../core/firstLook';
import { boardAgents } from '../../../core/mentions';
import { taskBrief } from '../../../core/brief';
import { LIMITS, tools } from '../../../core/schemas';
import { clip } from '../../../core/format';
import { taskDetail } from '../../../core/digest';
import { boardKey } from '../../../core/types';
import { inThread } from '../wording';
import { defineTool, text, type Tool } from '../tool';
import type { ToolContext } from './context';
import { agentBoard } from '../backlog';

export function taskTools({ store, getActor, session: { told } }: ToolContext): Tool[] {
  return [
    defineTool({
      name: 'plan_tasks',
      title: 'Plan tasks',
      description:
        [
          'Plan tasks on a board, each linked to the settled decisions it implements (decision_ids), or standing alone (a bug, a chore). They go stale if a decision they implement changes. Search first.',
          `backlog: true opens them in the backlog for people to shape and mark ready: for a note for later, or a bug or follow-up outside your current work (at most ${LIMITS.backlogCards} an hour).`,
        ].join(' '),
      guide: {
        topic: 'tasks',
        text: [
          'When decisions settle (decided or provisional), break the work into tasks, each linked to the decisions it implements. People see them on the Tasks tab, and the tasks go stale if one of those decisions changes.',
          'A task can also stand alone (a bug, a chore), but link it whenever it implements a decision: only linked tasks are flagged stale when a decision changes. Keep each small enough to finish and review on its own.',
          'When a person asks for a task plan on a decision, do that first. Search first, so you don\'t plan a task twice. You can hand a task to an agent with assignee.',
          `When a person asks you to note something for later, or you notice a bug or follow-up outside your current work, open a backlog card with backlog: true instead of planning it into to do. Write down what you found in its detail: it gets no first look, and a person marks it ready. At most ${LIMITS.backlogCards} an hour.`,
        ].join(' '),
      },
      schema: tools.plan_tasks,
      handler: async ({ board_id, tasks, backlog, thread_id }) => {
        const thread = thread_id ? store.threadOn(thread_id, store.getBoard(board_id)) : undefined;
        const planned = store.planTasks(
          board_id,
          tasks.map((t) => ({ title: t.title, detail: t.detail, decisionIds: t.decision_ids ?? [], assignee: t.assignee })),
          getActor(),
          { backlog },
        );
        for (const task of planned) if (thread) store.addThreadWork(thread.id, { kind: 'task', id: task.id }, getActor());
        const line = (t: (typeof planned)[number]) => `T${t.number} [id: ${t.id}] ${t.title}${t.assignee ? ` (assigned to ${t.assignee})` : ''}`;
        const shown = thread ? ` ${planned.length === 1 ? 'It shows' : 'They show'} in ${inThread(thread)}.` : '';
        if (backlog) {
          const one = planned.length === 1;
          return text(
            `Opened ${planned.map(line).join('; ')} in the backlog.${shown} People shape ${one ? 'it' : 'them'} and mark ${one ? 'it' : 'them'} ready; don't claim or build ${one ? 'it' : 'them'} until then. Carry on with your current work.`,
          );
        }
        return text(`Planned ${planned.map(line).join('; ')}.${shown} claim_task before starting one, then hand it to a subagent with the brief from brief_task.`);
      },
    }),

    defineTool({
      name: 'get_task',
      title: 'Get task',
      description:
        "Read one task in full: status, the decisions it implements, detail, links, progress notes, its discussion, and what is on its canvas. Check it between steps for new comments, and reply with comment(task_id). When a person sends a task back, their note says what to fix. To hand the task to a subagent, brief_task gives all of this as one brief.",
      schema: tools.get_task,
      readOnly: true,
      handler: async ({ task_id }) => {
        const { board, task } = store.getTask(task_id);
        told.readAll(taskDiscussion(task));
        const view = agentBoard(board, getActor().name);
        return text(taskDetail(view, view.tasks.find((item) => item.id === task.id)!, getActor().name, store.now()));
      },
    }),

    defineTool({
      name: 'brief_task',
      title: 'Brief a subagent on a task',
      description: [
        'A ready-to-paste brief for a subagent to build one task: the task, the decisions it implements, its discussion, its canvas and how to work. Read-only, for a task in any status.',
        'As chief of staff, claim_task, then hand this brief to a background subagent and stay on the board.',
      ].join(' '),
      guide: {
        topic: 'tasks',
        text: [
          "The brief holds the task and what done looks like, the decisions it implements (question, chosen option, rationale, people's comments), its discussion and people's latest notes, what's on its canvas, pins pointing at it, the board's people and agents, and how to work (own worktree, no commits, run the tests, bring back a patch, screenshots and a report).",
          'As chief of staff, claim_task, then hand this brief to a background subagent and stay on the board. When the work comes back, review and merge it, then send it for review.',
        ].join(' '),
      },
      schema: tools.brief_task,
      readOnly: true,
      handler: async ({ task_id }) => {
        const { board, task } = store.getTask(task_id);
        const view = agentBoard(board, getActor().name);
        return text(taskBrief(view, view.tasks.find((item) => item.id === task.id)!, boardAgents(view, store.presentAgents(boardKey(board)))));
      },
    }),

    defineTool({
      name: 'claim_task',
      title: 'Claim task',
      description:
        [
          'Take a task before working on it, so nobody else starts it. Claim ready tasks from the top of to do: people order it, and the order is their priority. Claim the ones assigned to you first, then unassigned ones.',
          'Refused if it is in the backlog (claim it only once a person marks it ready), stale, claimed by another agent, or assigned to another agent.',
          'As chief of staff, claim it, then hand it to a background subagent with the brief from brief_task. Report with update_task.',
        ].join(' '),
      schema: tools.claim_task,
      handler: async ({ task_id }) => {
        const task = store.claimTask(task_id, getActor());
        return text(`Claimed T${task.number}; it is in progress. Hand it to a subagent with the brief from brief_task, and report with update_task.`);
      },
    }),

    defineTool({
      name: 'take_first_look',
      title: 'Take first look',
      description:
        "Take the first look at a backlog card only when a person assigned you or someone @-mentioned you (get_board and your updates name it), so no other agent does too; if you're refused, leave it. Then comment on the card with feasibility and approach, with a mock on its canvas for UI work: that comment gives the first look. Don't claim or build it until a person marks it ready.",
      guide: {
        topic: 'tasks',
        text: 'Leave backlog cards alone until a person assigns an agent or someone @-mentions one in their text or comments. Direct mentions from people or agents reveal the card; an agent assignment alone does not. The person’s assignee has first-look priority, else the mentioned agents may take it; only one takes it. Comment on the card with comment(task_id), with feasibility and approach; for UI work, add a mock to its canvas first. That comment gives the first look. The card stays in the backlog: don\'t claim or build it until a person marks it ready.',
      },
      schema: tools.take_first_look,
      takesFirstLook: true,
      handler: async ({ task_id }) => {
        const task = store.takeFirstLook(task_id, getActor());
        const minutes = FIRST_LOOK_MS / 60_000;
        return text(
          `You're taking the first look at T${task.number} "${clip(task.title, 80)}". Read it (get_task), then comment on it (comment with task_id: ${task.id}) with feasibility and approach, and for UI work add a mock to its canvas first (add_block with task_id: ${task.id}). Your comment gives the first look; if none comes within ${minutes} minutes of your last call about the card, it goes back to open for a directly mentioned agent or the person’s assignee. Don't claim or build it until a person marks it ready.`,
        );
      },
    }),

    defineTool({
      name: 'update_task',
      title: 'Update task',
      description:
        [
          'Report progress on a task: status (in_review with a link, once its canvas shows the work: refused while it is empty; blocked with what\'s in the way as note; done once verified; todo to release it), a note, or a link.',
          'Pass commit with the hash once you commit work a person approved with a commit (refused otherwise), or nothing_to_commit with in_review when the work isn\'t in the repository.',
          'On a stale task, pass still_valid: true or revise it.',
        ].join(' '),
      guide: {
        topic: 'tasks',
        text: [
          'Status: in_review with the PR or branch as link; blocked with what\'s in the way as note, and post_decision if a person has to resolve it; done once verified; todo to release it. Refer to cards as #N and TN in notes: the board links them.',
          'Before in_review, put what shows the work on the task\'s canvas (add_block with task_id): screenshots of the result, a task list of what\'s done, and for code work a diff block. in_review is refused while the canvas is empty.',
          'Commits are part of the review. Don\'t post a "Commit …?" card for a task\'s own work: people approve its commit with "Looks good, commit it", and your updates and get_task say so. Then commit that task\'s work alone, from your main session, and pass the hash as commit; it is refused when no commit was approved. "Looks good" alone approves without a commit. When the work isn\'t in the repository (a plan, a spike, a cut-over), send it for review with nothing_to_commit: why, and people are offered only "Looks good"; the same answers a commit someone already approved. Only work that spans several tasks, or isn\'t a task, needs a card of its own.',
          'A stale task means a decision it builds on changed: stop work on it and re-read the decision, then pass still_valid: true, or revise its title, detail or decision_ids. It can\'t move forward until you do.',
        ].join(' '),
      },
      schema: tools.update_task,
      handler: async (args) => {
        const task = store.updateTask(
          args.task_id,
          {
            status: args.status,
            note: args.note,
            link: args.link,
            title: args.title,
            detail: args.detail,
            decisionIds: args.decision_ids,
            stillValid: args.still_valid,
            commit: args.commit,
            nothingToCommit: args.nothing_to_commit,
            assignee: args.assignee === undefined ? undefined : args.assignee.trim() || null,
          },
          getActor(),
        );
        const committed = args.commit
          ? `, and its commit ${task.commit!.hash!.slice(0, 7)} is recorded`
          : args.nothing_to_commit
            ? ', and it has nothing to commit'
            : '';
        const updated = `T${task.number} is ${task.status.replace('_', ' ')}${committed}${task.stale ? '. It is still stale' : ''}.`;
        return text(withAdvice(updated, peopleTextAdvice(args.note, 'note')));
      },
    }),
  ];
}
