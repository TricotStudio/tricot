import { peopleTextAdvice, withAdvice } from '../../../core/advice';
import { agentKinds } from '../../../core/agents/registry';
import { LENSES, threadAsRead, threadDetail, workName } from '../../../core/threads';
import { tools } from '../../../core/schemas';
import { listNames } from '../../../core/format';
import { BoardError } from '../../../core/store';
import { AGENT_TALK, THEN_WAIT, toAgentsNote } from '../wording';
import { defineTool, text, type Tool } from '../tool';
import type { ToolContext } from './context';
import { agentBoard } from '../backlog';

// What ^Name means in a person's message, for the guide: built from LENSES, so
// what the chat bar offers and what agents are told can't drift. The
// chat bar sends the lens with the message, and Tricot's prompt hook adds it
// in the agents whose live steps have one (their installer's lenses:
// hooks/tricot-prompt.mjs, or Pi's and OMP's extension); this is for an agent
// that gets ^Design as plain text. Read when the tools are made, once every
// agent has loaded.
const lensCommandGuide = () =>
  [
    "A person's message opening with ^Name (^Design) asks for that lens on it alone: answer it through that lens instead of the thread's; ^General asks for none.",
    `Your updates and Tricot's prompt hook (${agentKinds()
      .filter((kind) => kind.hooks.lenses)
      .map((kind) => kind.name)
      .join(', ')}) give the lens already; if ^Design reaches you as plain text, the lenses are:`,
    ...LENSES.filter((lens) => lens.brief).map((lens) => `^${lens.name}: ${lens.brief}`),
  ].join('\n');

export function threadTools({ store, getActor, words, session: { told } }: ToolContext): Tool[] {
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
          "A thread can be about blocks a person selected on a Sketchbook page, or about the file they had open in Files: its note says so and names them. Talk it through there first; reply_in_thread says what to make, and when.",
          'Your updates bring a message for you whole, with the messages before it you haven\'t seen: that is enough to answer it. Read the thread when you need more.',
          lensCommandGuide(),
        ].join(' '),
      },
      schema: tools.get_thread,
      readOnly: true,
      handler: async ({ thread_id }) => {
        const { board, thread } = store.getThread(thread_id);
        told.readAll(threadAsRead(board, thread, words));
        const view = agentBoard(board, getActor().name);
        return text(threadDetail(view, view.threads!.find((item) => item.id === thread.id)!, getActor().name, words));
      },
    }),

    defineTool({
      name: 'reply_in_thread',
      title: 'Reply in thread',
      description: [
        ['answer', "Answer in a thread, through its lens, and keep it short. Leave a message that's for another agent to it. Make what it needs first ("],
        ['blocks', 'blocks), passing this thread_id so it shows under your reply; refs adds other cards. '],
        ['mention', '@-mention to ask a person or hand another agent work.'],
        ['then-wait', ' then_wait posts, then listens in the same call.'],
      ],
      guide: {
        topic: 'conversation',
        text: [
          [
            'thread',
            "get_board and your updates give a thread's id. Leave a message that's for another agent to them; one for any agent is yours if you reply first. Answer in the thread itself, not in a comment elsewhere, through the thread's lens (its brief is in get_thread and your updates), or the one the message asks for with ^Name, and keep it short.",
          ],
          ['message', ''],
          ['pass', ' When you make something for the thread, pass this thread_id to '],
          ['tools', 'add_block and update_block'],
          ['shows', ': what you make then shows in the thread under your reply, live'],
          ['first', '. Make it first, then reply.'],
          ['refs', ' refs puts other cards under your reply too: one you made without thread_id, or one that already answers the question.'],
          [
            'selected',
            " A thread over blocks a person selected on a Sketchbook page (its note names them, and get_board says so) is for talking them through. Answer in plain text with your reasons, and don't make ",
          ],
          ['make', 'blocks until they ask for one or agree to what you suggest. When they say what to make'],
          ['straight', ', make it straight away with thread_id: what you make '],
          ['beside', 'shows beside them on the page, and links back to the thread.'],
          [
            'file',
            " A thread about a file a person had open in Files (its note names the file, and get_board says it was started in Files) is for talking that file through. Answer in plain text with your reasons, and change the file only once they ask for a change or agree to yours: read it in your repository first, as the block in Files is only a copy from when the file was last opened there.",
          ],
          ['ask', " To ask a person something, @-mention them (@Sam); to hand another agent a question or work, @-mention it (@Codex), and answer its mention as you would a person's."],
          ['talk', ` ${AGENT_TALK}`],
          ['then', ` ${THEN_WAIT}`],
        ],
      },
      schema: tools.reply_in_thread,
      handler: async ({ thread_id, body, refs }) => {
        const thread = store.postToThread(thread_id, body, getActor(), refs);
        told.read(thread.messages.at(-1)!.id);
        const { board } = store.getThread(thread_id);
        const count = `${thread.messages.length} message${thread.messages.length === 1 ? '' : 's'}`;
        const shown = thread.messages.at(-1)!.refs ?? [];
        const view = agentBoard(board, getActor().name);
        const under = shown.length ? `, with ${listNames(shown.map((ref) => workName(view, ref)))} under it` : '';
        const asks = toAgentsNote(board, thread.messages.at(-1)!);
        return text(withAdvice(`Replied in thread "${thread.title}" (${count})${under}. People see it in the thread.${asks}`, peopleTextAdvice(body, 'reply', words)));
      },
    }),

    defineTool({
      name: 'start_thread',
      title: 'Start thread',
      description: [
        ['open', 'Open a thread on a board to raise something with people'],
        ['kind', ': a risk you found, a question, a heads-up. Its first sentence titles it. Give it the lens it belongs to, e.g. Security for a way data could leak. Replies come through your updates.'],
      ],
      guide: {
        topic: 'conversation',
        text: [
          ['lenses', 'Lenses: General (the default), Legal, Design, Performance or Security, or a name of your own with lens_brief.'],
          ['mention', ' @-mention a person to ask them, or another agent (@Codex) to hand it a question or work.'],
          ['replies', ' Replies come through your updates: answer them with reply_in_thread.'],
        ],
      },
      schema: tools.start_thread,
      handler: async ({ board_id, body, lens, lens_brief }) => {
        if (lens_brief !== undefined && !lens) throw new BoardError('Pass lens_brief with lens: the name of the lens it describes.');
        const thread = store.startThread(board_id, body, getActor(), lens ? { name: lens, brief: lens_brief } : undefined);
        told.read(thread.messages[0].id); // it wrote it
        const through = thread.lens ? `, through the ${thread.lens.name} lens` : '';
        const asks = toAgentsNote(store.getThread(thread.id).board, thread.messages[0]);
        const started = `Started thread "${thread.title}" [thread id: ${thread.id}]${through}. People see it under Threads on the board; their replies come through your updates.${asks}`;
        return text(withAdvice(started, peopleTextAdvice(body, 'message', words)));
      },
    }),
  ];
}
