import { z } from 'zod';
import { agentKinds, findAgent } from '../../../core/agents/registry';
import { clip, listNames, samePerson } from '../../../core/format';
import { boardAgents } from '../../../core/mentions';
import { orchestratorName, STATUS_WORDS, VERDICT_WORDS, type SessionRole } from '../../../core/roles';
import { BoardError } from '../../../core/store';
import { fields } from '../../../core/schemas/fields';
import { boardKey, type Thread, type ThreadStatus } from '../../../core/types';
import { defineTool, text, type Tool } from '../tool';
import type { ToolGroup } from '../toolGroups';
import type { ToolContext } from './context';

// The tools and lines of a session's role (core/roles.ts), as a tool group that
// session alone has: its MCP address names the role (server/mcp.ts), so a
// session with none lists the board's tools and is told what it was, word for
// word. The role's line goes first, ahead of any part's: what a part says of
// how to work holds for the work, and this says which work is this session's.

const STATUSES = ['working', 'needs-you', 'in-review', 'done'] as const satisfies readonly ThreadStatus[];

// What set_thread_status says of each status, and of in review in full (core/roles.ts): work finished that waits on a
// person's OK before it is committed, which their verdict sets back to working.
const STATUS_ARG = 'working, needs-you, in-review or done';
const IN_REVIEW =
  "Set in-review in place of done when your work is finished but waits on a person's OK before you commit it: put what changed on the board first (a diff block, screenshots) with your thread_id so the review shows it, and summarise what changed. After their OK, commit and set done; if they send it back, it is working again. Work with nothing to commit goes straight to done.";

// What the owner is told once it set where its work stands: for done, that the coordinator tells the person; for in
// review, what comes next.
const statusSet = (thread: Thread, status: ThreadStatus, told: boolean): string =>
  `The work of thread "${clip(thread.title, 80)}" is ${STATUS_WORDS[status]}${status === 'done' && told ? ': the coordinator tells the person' : ''}${status === 'in-review' ? `: the person answers "${VERDICT_WORDS.approve}" or "${VERDICT_WORDS.changes}", which comes to you here as their message and sets it working again` : ''}.`;

// Where a message sent on to a thread of the board went, said to the coordinator that sent it: moved, when the thread
// it was asked in held nothing else and is gone, or quoted there, its thread answered with where it went.
function sentWords(routed: { from: Thread; to: Thread; moved: boolean }, whose: string): string {
  const where = `thread "${clip(routed.to.title, 80)}" [thread id: ${routed.to.id}]${whose}`;
  return routed.moved
    ? `Moved their message into ${where}. The thread they asked it in held nothing else, so it is gone, and the person is taken there.`
    : `Sent it to ${where}. You said where it went in "${clip(routed.from.title, 80)}", and the person is taken there.`;
}

// Tricot's terminal starts a role's session on its board, which its first message names: it has no board to find, and
// its instructions keep within what clients show (instructions.ts CLIENTS_SHOW), its role's line ahead of a part's.
const ROLE_BOARD = { name: 'role-board', replaces: 'find-board', text: '- Your board is the one your first message names.' };

export function roleGroup(role: SessionRole): ToolGroup {
  if (role.kind === 'pairing') return pairingGroup(role.thread);
  return role.kind === 'coordinator'
    ? {
        id: 'coordinator',
        tools: coordinatorTools,
        topics: { coordinating: 'being the coordinator: answering the chat bar, sending work on to threads and their owners' },
        after: 'start_thread',
        instructions: () => [
          {
            name: 'coordinator',
            before: 'neutral',
            text: "This session is the board's coordinator, over any role below: answer a quick question in place, send work and follow-ups of a thread on with route_to_thread, and never do the work yourself. read_guide coordinating says how.",
          },
          ROLE_BOARD,
        ],
      }
    : {
        id: 'orchestrator',
        tools: (context) => orchestratorTools(context, role.thread),
        topics: { orchestrating: "owning a thread's work: planning it, running subagents, reporting, asking and saying it is done" },
        after: 'start_thread',
        instructions: () => [
          {
            name: 'orchestrator',
            before: 'neutral',
            text: `This session owns thread [thread id: ${role.thread}] and its work, over any role below: run it through your own subagents, report and ask there, and close it with set_thread_status. read_guide orchestrating says how.`,
          },
          ROLE_BOARD,
        ],
      };
}

// A pairing session's (core/roles.ts): it owns the thread of one person's pairing on one page, acts on a small request
// itself and hands a big one to a background agent of its own, replies on each request's pin, and sets its thread done
// once the pairing ends.
function pairingGroup(thread: string): ToolGroup {
  return {
    id: 'pairing',
    tools: (context) => pairingTools(context, thread),
    topics: { pairing: "pairing with a person on one page: acting on a small request yourself, handing a big one to a background agent, replying on its pin, and closing the thread when the pairing ends" },
    after: 'start_thread',
    instructions: () => [
      {
        name: 'pairing',
        before: 'neutral',
        text: `This session pairs with one person on one page and owns its thread [thread id: ${thread}], over any role below: do small requests yourself, hand big ones to a background agent, reply on each request's pin, and set the thread done when the pairing ends. read_guide pairing says how.`,
      },
      ROLE_BOARD,
    ],
  };
}

function pairingTools({ store, getActor }: ToolContext, thread: string): Tool[] {
  return [
    defineTool({
      name: 'set_thread_status',
      title: 'Set thread status',
      description: `Say where the pairing you own stands: done once it ended, with a summary of what changed (which done needs); working again on a new request. A summary goes in the thread first.`,
      guide: {
        topic: 'pairing',
        text: [
          "A person is pairing with you on one page (a Sketchbook page, Files, or the board context), in the full view of any piece on it: get_board names it while they do. Their requests come as comments that @-mention you on pins on any of its blocks or files, one pin a part. Act on a small one yourself, right away: make the change (the block with update_block, the file it shows when it is in your repository), then reply on its pin with comment(pin_id) in a sentence or two. They watch your steps on the pin while you work.",
          "Hand a big one (several files, a long build or test run), or one on another piece while you are still on one, to a background agent of your own, with the pin's id and what was asked, so nothing queues; its steps show on the pins waiting on you too. Every request and reply passes through you, so you keep the whole page in mind: when its work is done, reply on that request's pin yourself.",
          'Keep to that page. Ask on the pin when a request is unclear, and do nothing the person did not ask for. Commit only when they ask.',
          'When Tricot tells you the pairing ended, set your thread done with a summary of what changed, in a sentence or two, for the person to read on Home. A request after that sets it back to working and wakes you.',
        ].join('\n'),
      },
      schema: {
        status: z.enum(STATUSES).describe(STATUS_ARG),
        summary: fields.message.optional().describe('What to say in the thread first, in Markdown and a sentence or two: for done, what changed on the page'),
      },
      handler: async ({ status, summary }) => {
        // Its summary is its one Done line on Home: done says what changed.
        if (status === 'done' && !summary?.trim()) throw new BoardError('Pass summary with done: what changed on the page, in a sentence or two, for the person to read on Home.');
        const owned = store.setThreadStatus(thread, status, getActor(), summary);
        return text(statusSet(owned, status, false));
      },
    }),
  ];
}

function coordinatorTools({ store, getActor, options }: ToolContext): Tool[] {
  return [
    defineTool({
      name: 'route_to_thread',
      title: 'Send on to a thread',
      description:
        "Send a person's message from the chat bar on to the thread it follows up (a question about that thread's work included), where it moves when it is all its own thread holds, or start a new thread for new work, which an agent Tricot starts owns. The person is taken where it went.",
      guide: {
        topic: 'coordinating',
        text: [
          "You are the board's coordinator: the chat bar's threads are yours, and you keep the whole picture so people needn't. Answer a quick question in place with reply_in_thread, unless it follows up a thread of the board: send that there. Anything that takes work, send on, and do none of it yourself.",
          'Work that belongs to a thread already (a follow-up, a change to something being built, a question about where its work stands): to_thread_id, from get_board\'s Threads. Its owner hears it at once. A message alone in a thread the chat bar just started moves there, and that thread goes, so the person\'s conversation stays one thread.',
          'New work: title (a few words, what the work is) and brief (what its owner should know besides the message: where to look, what was decided, what done looks like). Tricot starts an agent in your terminal to own it, named after the title; agent picks which (claude, codex), yours unless you say.',
          'One piece of work a thread: split an ask that holds two by sending it to each. Your updates tell you when a thread you sent work to is done: say so to the person in the thread they asked in, in a sentence, with what changed for them.',
        ].join('\n'),
      },
      schema: {
        thread_id: z.string().describe('The thread the person asked in'),
        message_id: z.string().describe('Their message, as get_thread lists it'),
        to_thread_id: z.string().optional().describe('A thread of the board the work belongs to: their message goes there'),
        title: fields.groupTitle.optional().describe('For new work: the title of the thread to start, a few words'),
        brief: fields.message.optional().describe("For new work: what its owner should know besides the person's message, in a few sentences"),
        agent: z.string().optional().describe('For new work: the agent Tricot starts to own it, by id (claude, codex); yours unless given'),
      },
      handler: async ({ thread_id, message_id, to_thread_id, title, brief, agent }) => {
        const actor = getActor();
        if (to_thread_id && (title || brief || agent)) throw new BoardError('Pass to_thread_id to send it to a thread of the board, or title (with brief) to start one: not both.');
        if (!to_thread_id && !title) throw new BoardError('Pass to_thread_id to send it to a thread of the board, or title (with brief) to start one for new work.');
        if (to_thread_id) {
          const routed = store.routeToThread(thread_id, message_id, actor, { threadId: to_thread_id });
          return text(sentWords(routed, routed.to.owner ? `, which ${routed.to.owner} owns: it hears it now` : ': no agent owns it, so whoever answers there takes it'));
        }
        const id = agent ?? options.presence?.sessionOf(actor.name)?.tool ?? agentKinds()[0].id;
        const kind = findAgent(id);
        if (!kind?.session) {
          const startable = agentKinds().filter((k) => k.session).map((k) => k.id);
          throw new BoardError(`Tricot can't start "${clip(id, 30)}" to own it: pass agent as one of ${listNames(startable)}.`);
        }
        const { board } = store.getThread(thread_id);
        const taken = [...boardAgents(board, store.presentAgents(boardKey(board))), ...(board.threads ?? []).flatMap((t) => (t.owner ? [t.owner] : []))];
        const owner = orchestratorName(kind.boardName, title!, taken);
        const { from, to } = store.routeToThread(thread_id, message_id, actor, { title: title!, brief, owner, launch: kind.id });
        return text(
          `Started thread "${clip(to.title, 80)}" [thread id: ${to.id}] for ${owner}, whom Tricot starts in your terminal to own it. You said where it went in "${clip(from.title, 80)}", and the person is taken there. Leave the work to ${owner}: your updates say when it is done.`,
        );
      },
    }),
  ];
}

function orchestratorTools({ store, getActor }: ToolContext, thread: string): Tool[] {
  return [
    defineTool({
      name: 'set_thread_status',
      title: 'Set thread status',
      description: `Say where the work of the thread you own stands: working, needs-you while it waits on a person's answer, in-review, or done. A summary goes in the thread first. ${IN_REVIEW}`,
      guide: {
        topic: 'orchestrating',
        text: [
          'You own one thread and its work: the coordinator sent it to you, and people follow it there. Read it with get_thread, then plan the work and do it through your own subagents: scouts to read and find what the work touches, workers to build, each in its own git worktree so they keep off each other\'s files. Run each in the background, never in the foreground: a person\'s message then reaches you while they work. Their steps show live in the thread.',
          'Report in the thread with reply_in_thread as the work moves, in a sentence or two: what changed for the person, not what each subagent did. Commit only when a person asks.',
          'When you need a person (a choice, an answer), ask in the thread and set needs-you; their reply sets it back to working and wakes you. When the work is done, set done with a summary of what changed and how to see it. A person who writes in it again sets it back to working.',
          `When the work is finished but waits on a person's OK before you commit it, set in-review in place of done. First put what changed on the board with your thread_id (a diff block of the change, screenshots of the result) so the review shows it, then set in-review with a summary of what changed. The person answers "${VERDICT_WORDS.approve}" or "${VERDICT_WORDS.changes}" with a note: either comes to you as their message and sets it back to working. After their OK, commit it, and set done only once it is committed, so done always means landed; sent back, make the changes and set in-review again. A plain reply leaves it in review: answer it there. Work with nothing to commit goes straight to done.`,
        ].join('\n'),
      },
      schema: {
        status: z.enum(STATUSES).describe(STATUS_ARG),
        summary: fields.message.optional().describe('What to say in the thread first, in Markdown and about three sentences: for in-review and done, what changed and how to see it'),
      },
      handler: async ({ status, summary }) => {
        const owned = store.setThreadStatus(thread, status, getActor(), summary);
        return text(statusSet(owned, status, true));
      },
    }),
  ];
}

// The coordinator's tools for an agent connected on its own (core/roles.ts LEAD_WORDS): listed once it takes the role
// on a board by listening there (mcp.ts), never before. It owns the threads it sends work to, so it names no agent to
// start, and says where the work of any of them stands.
export function leadTools({ store, getActor }: ToolContext, leads: (boardKey: string) => boolean): Tool[] {
  const lead = (threadId: string) => {
    const { board, thread } = store.getThread(threadId);
    if (!leads(boardKey(board))) throw new BoardError(`You don't coordinate ${clip(board.title, 60)}: listen on it with wait_for_updates to take the role.`);
    return thread;
  };
  return [
    defineTool({
      name: 'route_to_thread',
      title: 'Send on to a thread',
      description:
        "Send a person's message from the chat bar on to the thread it follows up (a question about that thread's work included), where it moves when it is all its own thread holds, or start a new thread for new work, which you own: hand its work to a background agent of your own with the thread id. The person is taken where it went.",
      schema: {
        thread_id: z.string().describe('The thread the person asked in'),
        message_id: z.string().describe('Their message, as get_thread lists it'),
        to_thread_id: z.string().optional().describe('A thread of the board the work belongs to: their message goes there'),
        title: fields.groupTitle.optional().describe('For new work: the title of the thread to start, a few words'),
        brief: fields.message.optional().describe("For new work: what the work needs besides the person's message, in a few sentences"),
      },
      handler: async ({ thread_id, message_id, to_thread_id, title, brief }) => {
        const actor = getActor();
        if (to_thread_id && (title || brief)) throw new BoardError('Pass to_thread_id to send it to a thread of the board, or title (with brief) to start one: not both.');
        if (!to_thread_id && !title) throw new BoardError('Pass to_thread_id to send it to a thread of the board, or title (with brief) to start one for new work.');
        lead(thread_id);
        if (to_thread_id) {
          const routed = store.routeToThread(thread_id, message_id, actor, { threadId: to_thread_id });
          const owner = routed.to.owner;
          return text(sentWords(routed, !owner ? ': no agent owns it, so whoever answers there takes it' : samePerson(owner, actor.name) ? ', which you own: take it up there, or hand it on with its thread id' : `, which ${owner} owns: it hears it now`));
        }
        const { from, to } = store.routeToThread(thread_id, message_id, actor, { title: title!, brief, owner: actor.name });
        return text(
          `Started thread "${clip(to.title, 80)}" [thread id: ${to.id}], which you own, its work at work. You said where it went in "${clip(from.title, 80)}", and the person is taken there. Hand its work now to a background agent of your own (your Agent tool) with the thread id ${to.id}: it reads the thread with get_thread first, reports there with reply_in_thread, and ends with set_thread_status.`,
        );
      },
    }),
    defineTool({
      name: 'set_thread_status',
      title: 'Set thread status',
      description: `Say where the work of a thread you own stands: working, needs-you while it waits on a person's answer, in-review, or done. A summary goes in the thread first. ${IN_REVIEW}`,
      schema: {
        thread_id: z.string().describe('A thread you own'),
        status: z.enum(STATUSES).describe(STATUS_ARG),
        summary: fields.message.optional().describe('What to say in the thread first, in Markdown and about three sentences: for in-review and done, what changed and how to see it'),
      },
      handler: async ({ thread_id, status, summary }) => {
        lead(thread_id);
        const owned = store.setThreadStatus(thread_id, status, getActor(), summary);
        return text(statusSet(owned, status, false));
      },
    }),
  ];
}
