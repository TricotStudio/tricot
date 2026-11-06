import { peopleTextAdvice, withAdvice } from '../../../core/advice';
import { threadAsRead, threadDetail, workName } from '../../../core/threads';
import { tools } from '../../../core/schemas';
import { listNames } from '../../../core/format';
import { BoardError } from '../../../core/store';
import { AGENT_TALK, THEN_WAIT, toAgentsNote } from '../wording';
import { defineTool, text, type Tool } from '../tool';
import type { ToolContext } from './context';

export function threadTools({ store, getActor, session: { told } }: ToolContext): Tool[] {
  return [
    defineTool({
      name: 'get_thread',
      title: 'Get thread',
      description:
        'Read a thread in full: its lens and how to answer through it, every message, who wrote it and when, and whether it waits on you. Your updates bring a message for you whole already: read the thread when you need more.',
      guide: {
        topic: 'conversation',
        text: [
          'Threads are conversations through which people work on the project with agents. get_board lists a board\'s threads, and your updates name each new message, "asked you" when it @-mentions you and "for Codex" when it\'s another agent\'s. A message that mentions no agent is for the agent its lens is routed to, if any, else for any agent: the first to reply answers it.',
          'Each thread has a lens (General, Legal, Design, Performance, Security, or one people named) whose brief says how to answer: as a reviewer of licences, as a product designer… Answer through it.',
          'Your updates bring a message for you whole, with the messages before it you haven\'t seen: that is enough to answer it. Read the thread when you need more.',
        ].join(' '),
      },
      schema: tools.get_thread,
      readOnly: true,
      handler: async ({ thread_id }) => {
        const { board, thread } = store.getThread(thread_id);
        told.readAll(threadAsRead(thread));
        return text(threadDetail(board, thread, getActor().name));
      },
    }),

    defineTool({
      name: 'reply_in_thread',
      title: 'Reply in thread',
      description: [
        "Answer in a thread, through its lens, and keep it short. Leave a message that's for another agent to it.",
        'Make what it needs first (a decision, tasks, blocks), passing this thread_id so it shows under your reply; refs adds other cards. Write #N for a decision and TN for a task, and @-mention to ask a person or hand another agent work.',
        'then_wait posts, then listens in the same call.',
      ].join(' '),
      guide: {
        topic: 'conversation',
        text: [
          "get_board and your updates give a thread's id. Leave a message that's for another agent to them; one for any agent is yours if you reply first.",
          "Answer in the thread itself, not in a comment elsewhere, through the thread's lens (its brief is in get_thread and your updates), and keep it short.",
          "When a message needs a person's decision, post one (post_decision); when it needs work, plan a task (plan_tasks); when it asks for a view of the project, add blocks to the board context (add_block with board_id).",
          'Pass this thread_id to those tools, and to update_block and comment: what you make then shows in the thread under your reply, live, and the decision or task links back to the thread. Make it first, then reply.',
          'refs puts other cards under your reply too: one you made without thread_id, or one that already answers the question.',
          'Say in your reply what you did, with #N for a decision and TN for a task (e.g. "Posted it as #57", "Planned T80"): the board links them.',
          'To ask a person something, @-mention them (@Sam); to hand another agent a question or work, @-mention it (@Codex), and answer its mention as you would a person\'s.',
          AGENT_TALK,
          THEN_WAIT,
        ].join(' '),
      },
      schema: tools.reply_in_thread,
      handler: async ({ thread_id, body, refs }) => {
        const thread = store.postToThread(thread_id, body, getActor(), refs);
        told.read(thread.messages.at(-1)!.id);
        const { board } = store.getThread(thread_id);
        const count = `${thread.messages.length} message${thread.messages.length === 1 ? '' : 's'}`;
        const shown = thread.messages.at(-1)!.refs ?? [];
        const under = shown.length ? `, with ${listNames(shown.map((ref) => workName(board, ref)))} under it` : '';
        const asks = toAgentsNote(board, thread.messages.at(-1)!);
        return text(withAdvice(`Replied in thread "${thread.title}" (${count})${under}. People see it in the thread.${asks}`, peopleTextAdvice(body, 'reply')));
      },
    }),

    defineTool({
      name: 'start_thread',
      title: 'Start thread',
      description:
        "Open a thread on a board to raise something with people that isn't a decision or a task yet: a risk you found, a question, a heads-up. Its first sentence titles it. Give it the lens it belongs to, e.g. Security for a way data could leak. Replies come through your updates.",
      guide: {
        topic: 'conversation',
        text: [
          'Lenses: General (the default), Legal, Design, Performance or Security, or a name of your own with lens_brief.',
          'For a clear choice between options, post a decision instead; for work, plan a task. Write #N for a decision and TN for a task, and @-mention a person to ask them, or another agent (@Codex) to hand it a question or work.',
          'Replies come through your updates: answer them with reply_in_thread.',
        ].join(' '),
      },
      schema: tools.start_thread,
      handler: async ({ board_id, body, lens, lens_brief }) => {
        if (lens_brief !== undefined && !lens) throw new BoardError('Pass lens_brief with lens: the name of the lens it describes.');
        const thread = store.startThread(board_id, body, getActor(), lens ? { name: lens, brief: lens_brief } : undefined);
        told.read(thread.messages[0].id); // it wrote it
        const through = thread.lens ? `, through the ${thread.lens.name} lens` : '';
        const asks = toAgentsNote(store.getThread(thread.id).board, thread.messages[0]);
        const started = `Started thread "${thread.title}" [thread id: ${thread.id}]${through}. People see it under Threads on the board; their replies come through your updates.${asks}`;
        return text(withAdvice(started, peopleTextAdvice(body, 'message')));
      },
    }),
  ];
}
