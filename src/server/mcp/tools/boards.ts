import { blockName, syncedBlocks } from '../../../core/canvas';
import { SKILLS_NUDGE } from '../../../core/skills';
import { searchDigest, searchStore } from '../../../core/search';
import { tools } from '../../../core/schemas';
import { listNames } from '../../../core/format';
import { boardDigest, boardListDigest } from '../../../core/digest';
import { BoardError } from '../../../core/store';
import { boardKey } from '../../../core/types';
import { defineTool, text, type Tool } from '../tool';
import type { ToolContext } from './context';
import { agentBoard, seeBoardComments } from '../backlog';

export function boardTools({ store, getActor, options, session }: ToolContext): Tool[] {
  return [
    defineTool({
      name: 'list_boards',
      title: 'List boards',
      description:
        "List planning boards with their goals and how many decisions are open. Read the one that fits the work with get_board. If none fits, create_board with the objective; if it's ambiguous which, ask the person.",
      readOnly: true,
      handler: async () => {
        const boards = boardListDigest(store.listBoards());
        return text(options.connectors ? `${boards}\n\n${options.connectors.line()}` : boards);
      },
    }),

    defineTool({
      name: 'create_board',
      title: 'Create board',
      description: 'Create a planning board for a piece of work. The goal is the objective the decisions serve.',
      schema: tools.create_board,
      handler: async ({ title, goal }) => {
        const board = store.createBoard({ title, goal }, getActor());
        return text(boardDigest(board));
      },
    }),

    defineTool({
      name: 'get_board',
      title: 'Get board',
      description:
        "Read a board: the tasks ready for you first, then the decisions grouped by status (each decided one in a line with its answer), the tasks by lane (to do top first: people order it by priority; done shows the latest ten), what people asked of agents, the board's threads, the People and Areas lines, and the cursor for get_updates. Retired and dropped cards are only counted: search finds older work, and get_decision and get_task read a card in full. Read it when you connect and before you wait, and hand out what's ready (brief_task).",
      schema: tools.get_board,
      readOnly: true,
      catchesUp: true,
      handler: async ({ board_id }) => {
        const board = store.getBoard(board_id);
        const renamed = board.id === board_id ? '' : `\n\nThis board was renamed: its id is now ${board.id}. The old one still works.`;
        const nudge = session.skillsReported ? '' : `\n\n${SKILLS_NUDGE}`;
        session.told.begin();
        const view = agentBoard(board, getActor().name);
        const digest = boardDigest(view, getActor().name, store.now(), session.told, session.agent());
        seeBoardComments(store, board, getActor());
        const pairing = (options.pairing?.lines(boardKey(board), getActor().name) ?? []).map((line) => `\n\n${line}`).join('');
        return text(`${digest}${pairing}${renamed}${nudge}`);
      },
    }),

    defineTool({
      name: 'search',
      title: 'Search',
      description:
        'Search a board for past and current work: decisions (question, context, options, answer, rationale), tasks (title, detail, notes), comments, findings and canvas blocks. Search before you post a decision or plan a task, so you don\'t ask again what\'s already decided. Every word must appear; case and accents are ignored. Closed cards (decided, retired, done, dropped) are included unless include_closed is false. Each result names its ids: read it with get_decision, get_task or get_block.',
      schema: tools.search,
      readOnly: true,
      handler: async (args) => {
        if (!args.board_id && !args.all_boards) throw new BoardError('Pass board_id, or all_boards: true to search every board.');
        const options = {
          boardId: args.board_id,
          allBoards: args.all_boards,
          kinds: args.kinds,
          openOnly: args.include_closed === false,
          limit: args.limit ?? 20,
        };
        const found = searchStore({ listBoards: () => store.listBoards(), getBoard: (id) => agentBoard(store.getBoard(id), getActor().name) }, args.query, options);
        const boardTitle = args.board_id ? store.getBoard(args.board_id).title : undefined;
        return text(searchDigest(found, args.query, { ...options, boardTitle }));
      },
    }),

    defineTool({
      name: 'finish_sync',
      title: 'Finish sync',
      description:
        "Mark a person's sync of the board context done, once the blocks it covers reflect the board's current state, with a one-line note on what changed. A sync of all may change only agents' blocks; a sync of selected blocks, exactly those (get_canvas marks them).",
      guide: {
        topic: 'canvas',
        text: [
          'When a person asks for a sync (get_board and your updates show it), do it next: re-read the board (decisions, tasks, recent activity with get_updates) and the board context, bring the blocks it covers up to date with the current state, pin existing work to the parts about it (pin), then call this with a one-line note on what changed.',
          "A sync of all covers the blocks agents made: update them or add new ones, but a block a person made or edited is theirs, and changes to it are refused. A sync of selected blocks names them (get_canvas marks each \"in this sync\" or \"leave it\"): refresh exactly those, people's included, since selecting is their OK; changes to other blocks, and new blocks, are refused until you finish.",
          'In the note, mention anything you had to leave that looks out of date.',
        ].join(' '),
      },
      schema: tools.finish_sync,
      handler: async ({ board_id, note }) => {
        const board = store.finishSync(board_id, note, getActor());
        const blocks = board.synced?.blockIds ? syncedBlocks(board.canvas, board.synced.blockIds) : [];
        if (blocks.length === 0) return text(`Synced the board context of ${board.title}; people see it is up to date.`);
        const names = listNames(blocks.map((b) => blockName(b)));
        return text(`Synced ${names} in the board context of ${board.title}; people see ${blocks.length === 1 ? 'it is' : 'they are'} up to date.`);
      },
    }),

    defineTool({
      name: 'take_request',
      title: 'Take request',
      description:
        "Take a person's request on the board context (get_board and your updates show them with a request id), e.g. \"Get me an architecture view of the project\". It makes a group for your answer and returns its id: add your blocks there (add_block with group_id), then finish_request.",
      guide: {
        topic: 'canvas',
        text: [
          "It makes a group on the board context for your answer and returns its id: add your blocks there with add_block(group_id), then finish_request. A request that @-mentions other agents is theirs, and is refused.",
          'People now ask from the Board Context in the board\'s General thread: answer those there (reply_in_thread). Requests are what they asked before, which a board may still have open.',
          'Take one with take_request, read the project as needed (code, decisions, tasks, the board context), answer with visuals (diagrams, tables) as blocks in the request\'s group, and finish_request with a one-line note.',
        ].join(' '),
      },
      schema: tools.take_request,
      handler: async ({ request_id, title }) => {
        const { request, group } = store.takeRequest(request_id, getActor(), title);
        const { board } = store.getRequest(request_id);
        const asked = `${request.by.name}'s request: "${request.text}"`;
        if (!group) return text(`You took ${asked}, but its group is gone: add a group with add_group(board_id: ${board.id}) for your answer, then finish_request.`);
        return text(
          `Took ${asked}. Its group on the board context is "${group.title}" [group id: ${group.id}]. Build the answer there as blocks (add_block with board_id: ${board.id} and group_id: ${group.id}), reading the project as needed: diagrams and tables over prose. Then finish_request with a one-line note.`,
        );
      },
    }),

    defineTool({
      name: 'finish_request',
      title: 'Finish request',
      description:
        "Mark a person's request on the board context done, once your answer is in its group. Only the agent who took it finishes it. The note says what you added, in a line.",
      schema: tools.finish_request,
      handler: async ({ request_id, note }) => {
        const request = store.finishRequest(request_id, note, getActor());
        const { board } = store.getRequest(request_id);
        const group = board.canvas.groups.find((g) => g.id === request.groupId);
        const where = group ? ` in group "${group.title}"` : '';
        return text(`Finished ${request.by.name}'s request${where}; people see it's done, with your note.`);
      },
    }),
  ];
}
