import { skillsWords } from '../../../core/agents/registry';
import { tools } from '../../../core/schemas';
import { TAGGED, WHOLE } from '../wording';
import { defineTool, text, type Tool } from '../tool';
import type { ToolContext } from './context';

export function updateTools({ store, getActor, session }: ToolContext): Tool[] {
  return [
    defineTool({
      name: 'get_updates',
      title: 'Get updates',
      description:
        "Activity on a board since a cursor, from anyone but you: answers, requests, comments, thread messages, new questions, and what people asked of agents, each message for you whole. Returns the new cursor. Check it between steps: you can't be notified.",
      guide: {
        topic: 'conversation',
        text: `Other tools' results also say when there's unread activity; act on it. ${WHOLE} ${TAGGED}`,
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
      description:
        "Block until someone else acts on the board, or until the timeout: how you listen. Call it whenever you're idle, and again each time it returns. Before each wait, hand out the ready tasks it names. It returns the moment someone acts; leave out timeout_seconds to wait as long as the server allows. A message for you comes whole: answer it, with then_wait to keep listening.",
      guide: {
        topic: 'conversation',
        text: `Idle means your tasks are handed out to subagents, or you are waiting on people; people see on the board whether you're listening. Hand out the ready tasks a wait names with claim_task and brief_task. A wait can be long, up to many minutes; the server caps it for your client. ${WHOLE} Answer from it, and pass then_wait to your reply to keep listening in the same call.`,
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
