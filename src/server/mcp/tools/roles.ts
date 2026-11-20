import { z } from 'zod';
import { agentKinds, findAgent } from '../../../core/agents/registry';
import { clip, listNames } from '../../../core/format';
import { boardAgents } from '../../../core/mentions';
import { orchestratorName, STATUS_WORDS, type SessionRole } from '../../../core/roles';
import { BoardError } from '../../../core/store';
import { fields } from '../../../core/schemas/fields';
import { boardKey, type ThreadStatus } from '../../../core/types';
import { defineTool, text, type Tool } from '../tool';
import type { ToolGroup } from '../toolGroups';
import type { ToolContext } from './context';

// The tools and lines of a session's role (core/roles.ts), as a tool group that
// session alone has: its MCP address names the role (server/mcp.ts), so a
// session with none lists the board's tools and is told what it was, word for
// word. The role's line goes first, ahead of any part's: what a part says of
// how to work holds for the work, and this says which work is this session's.

const STATUSES = ['working', 'needs-you', 'done'] as const satisfies readonly ThreadStatus[];

// Tricot's terminal starts a role's session on its board, which its first message names: it has no board to find, and
// its instructions keep within what clients show (instructions.ts CLIENTS_SHOW), its role's line ahead of a part's.
const ROLE_BOARD = { name: 'role-board', replaces: 'find-board', text: '- Your board is the one your first message names.' };

export function roleGroup(role: SessionRole): ToolGroup {
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
            text: "This session is the board's coordinator, over any role below: answer a quick question in place, send work on with route_to_thread, and never do it yourself. read_guide coordinating says how.",
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

function coordinatorTools({ store, getActor, options }: ToolContext): Tool[] {
  return [
    defineTool({
      name: 'route_to_thread',
      title: 'Send on to a thread',
      description:
        "Send a person's message from the chat bar on to the thread its work belongs to, or start a new thread for new work, which an agent Tricot starts owns. Where it was asked, you say where it went, and the person is taken there.",
      guide: {
        topic: 'coordinating',
        text: [
          "You are the board's coordinator: the chat bar's threads are yours, and you keep the whole picture so people needn't. Answer a quick question in place with reply_in_thread. Anything that takes work, send on, and do none of it yourself.",
          'Work that belongs to a thread already (a follow-up, a change to something being built): to_thread_id, from get_board\'s Threads. Its owner hears it at once.',
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
          const { from, to } = store.routeToThread(thread_id, message_id, actor, { threadId: to_thread_id });
          const owner = to.owner ? `, which ${to.owner} owns: it hears it now` : ': no agent owns it, so whoever answers there takes it';
          return text(`Sent it to thread "${clip(to.title, 80)}" [thread id: ${to.id}]${owner}. You said where it went in "${clip(from.title, 80)}", and the person is taken there.`);
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
      description: "Say where the work of the thread you own stands: working, needs-you while it waits on a person, or done. A summary goes in the thread first.",
      guide: {
        topic: 'orchestrating',
        text: [
          'You own one thread and its work: the coordinator sent it to you, and people follow it there. Read it with get_thread, then plan the work and do it through your own subagents: scouts to read and find what the work touches, workers to build, each in its own git worktree so they keep off each other\'s files. Their steps show live in the thread.',
          'Report in the thread with reply_in_thread as the work moves, in a sentence or two: what changed for the person, not what each subagent did. Commit only when a person asks.',
          'When you need a person (a choice, an OK), ask in the thread and set needs-you; their reply sets it back to working and wakes you. When the work is done, set done with a summary of what changed and how to see it. A person who writes in it again sets it back to working.',
        ].join('\n'),
      },
      schema: {
        status: z.enum(STATUSES).describe('working, needs-you or done'),
        summary: fields.message.optional().describe('What to say in the thread first, in Markdown: for done, what changed and how to see it'),
      },
      handler: async ({ status, summary }) => {
        const owned = store.setThreadStatus(thread, status, getActor(), summary);
        return text(`The work of thread "${clip(owned.title, 80)}" is ${STATUS_WORDS[status]}${status === 'done' ? ': the coordinator tells the person' : ''}.`);
      },
    }),
  ];
}
