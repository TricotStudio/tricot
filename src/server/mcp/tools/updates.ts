import { skillsWords } from '../../../core/agents/registry';
import { tools } from '../../../core/schemas';
import { TAGGED, WHOLE } from '../wording';
import type { Phrases, Piece } from '../words';
import { defineTool, text, type Tool } from '../tool';
import type { ToolContext } from './context';

// How a session Tricot's terminal wakes is told to idle: its wait
// ends its turn while the terminal holds it (mcp/session.ts). In pieces, as
// every description of the wait is: a tool group says what to hand out before
// each wait (words.ts).
const WOKEN_WAIT: Piece[] = [
  [
    'idle',
    "How you idle: call it when you have nothing to do, and do as its reply says. While Tricot's terminal holds you to wake you, it returns at once with your updates and says to end your turn: end it, and Tricot types a line in your prompt when something on the board needs you. When the terminal doesn't hold you, it blocks until something concerns you, as a wait does, and says to keep waiting.",
  ],
  ['whole', ' A message for you comes whole: answer it, with then_wait to end your turn the same way.'],
];

// How a session that sleeps by `tricot listen` is told to idle: its
// wait gives the command, and ends its turn while the command runs
// (mcp/session.ts). The list of tools says it in place of the usual
// description (mcp.ts), once its client has said who it is.
const LISTEN_WAIT: Piece[] = [
  [
    'idle',
    'How you idle: call it when you have nothing to do, and do as its reply says. It returns at once with your updates and a `tricot listen` command: run that in the background, then end your turn. The command ends when something on the board needs you, and its end wakes you: call this again then.',
  ],
  ['whole', ' A message for you comes whole: answer it, with then_wait to end your turn the same way.'],
];
export const listenWait = (words: Phrases): string => words.say('wait_for_updates.listening', LISTEN_WAIT);

const PLAIN_WAIT: Piece[] = [
  ['block', "Block until something on the board concerns you, or until the timeout: how you listen. Call it whenever you're idle, and again each time it returns."],
  ['returns', ' It returns the moment a message, request or answer for you or any agent comes,'],
  ['acts', ' or a person acts on your work, with everything else that happened meanwhile.'],
  ['whole', ' A message for you comes whole: answer it, with then_wait to keep listening.'],
];

export function updateTools({ store, getActor, session, words }: ToolContext): Tool[] {
  return [
    defineTool({
      name: 'get_updates',
      title: 'Get updates',
      description:
        "Activity on a board since a cursor, from anyone but you: answers, requests, comments, thread messages, new questions, and what people asked of agents, each message for you whole. Returns the new cursor. Check it between steps: you can't be notified.",
      guide: {
        topic: 'conversation',
        text: [['unread', "Other tools' results also say when there's unread activity; act on it. "], ...WHOLE, ['gap', ' '], ...TAGGED],
      },
      schema: tools.get_updates,
      readOnly: true,
      catchesUp: true,
      handler: async ({ board_id, since }) => {
        const board = store.getBoard(board_id);
        return text(session.updates(board, since));
      },
    }),

    defineTool({
      name: 'wait_for_updates',
      title: 'Wait for updates',
      description: session.woken ? words.say('wait_for_updates.woken', WOKEN_WAIT) : words.say('wait_for_updates.plain', PLAIN_WAIT),
      guide: {
        topic: 'conversation',
        text: [
          ['idle', 'Idle means '],
          ['waiting', "you are waiting on people; people see on the board whether you're listening."],
          ['wait', ' A wait can be long, up to many minutes; the server caps it for your client. '],
          ...WHOLE,
          [
            'answer',
            " Answer from it, and pass then_wait to your reply to keep listening in the same call. A client that can sleep between turns (Claude Code, connected on its own) doesn't wait: its wait returns at once with a `tricot listen` command. Run that in the background, never in the foreground, and end your turn: it ends, printing one line, when something on the board needs you, and its end starts your next turn, in which you call wait_for_updates. One runs per board at a time; another says you already listen.",
          ],
        ],
      },
      schema: tools.wait_for_updates,
      readOnly: true,
      catchesUp: true,
      listens: true,
      handler: async ({ board_id, since, timeout_seconds }, extra) => {
        return text(await session.listen(store.getBoard(board_id), since, timeout_seconds, extra));
      },
    }),

    defineTool({
      name: 'report_skills',
      title: 'Report skills',
      description:
        'Tell Tricot which skills you have, so people can call them with "/" from a comment or a thread message. Call it once per session, with the whole list: it replaces what you reported before.',
      guide: {
        topic: 'conversation',
        text: [
          `Skills are ${skillsWords()}.`,
          'People then call them from a card comment or a thread message by typing "/". A message that starts with one of your skills reaches your updates as "asks you to run /name", with the rest of their text as its arguments: run it, then reply on that card or thread as usual, and your reply shows it was made via the skill.',
        ].join(' '),
      },
      schema: tools.report_skills,
      handler: async ({ skills }) => {
        const list = store.reportSkills(getActor().name, skills);
        session.skillsReported = true;
        const count = list.skills.length;
        return text(
          count === 0
            ? 'Cleared your skills: people see none of yours to call.'
            : `Reported ${count} skill${count === 1 ? '' : 's'}: people can call ${count === 1 ? 'it' : 'them'} with "/" from a card comment or a thread message. A request comes through your updates as "asks you to run /name".`,
        );
      },
    }),
  ];
}
