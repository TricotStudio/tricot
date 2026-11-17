import { blockName } from '../../../core/canvas';
import { answerable, pageAnswerHow, requestBlocks, requestCanvas, requestGroup } from '../../../core/requests';
import { pageName } from '../../../core/scratchPad';
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

// The board's own tools say nothing of a part: where a tool group has more to say, the text is written in pieces it
// places its own among (server/mcp/words.ts).
export function boardTools({ store, getActor, options, session, words }: ToolContext): Tool[] {
  return [
    defineTool({
      name: 'list_boards',
      title: 'List boards',
      description: [
        ['list', 'List planning boards with their goals'],
        ['read', ". Read the one that fits the work with get_board. If none fits, create_board with the objective; if it's ambiguous which, ask the person."],
      ],
      readOnly: true,
      handler: async () => {
        const boards = boardListDigest(store.listBoards(), words);
        return text(options.connectors ? `${boards}\n\n${options.connectors.line(words)}` : boards);
      },
    }),

    defineTool({
      name: 'create_board',
      title: 'Create board',
      description: [
        ['create', 'Create a planning board for a piece of work. The goal is the objective the '],
        ['serves', 'work serves.'],
      ],
      schema: tools.create_board,
      handler: async ({ title, goal, folder }) => {
        const board = store.createBoard({ title, goal, folder }, getActor());
        return text(boardDigest(board, undefined, undefined, undefined, undefined, words));
      },
    }),

    defineTool({
      name: 'set_project_folder',
      title: 'Set project folder',
      description: 'Set the board’s project folder: an existing directory inside home, outside key folders. Pass a full path or ~/…, or null to clear it.',
      schema: tools.set_project_folder,
      handler: async ({ board_id, folder }) => {
        const board = store.updateBoard(board_id, { folder }, getActor());
        return text(board.folder ? `Project folder: ${board.folder}` : 'The board has no project folder.');
      },
    }),

    defineTool({
      name: 'get_board',
      title: 'Get board',
      description: [
        ['read', 'Read a board: '],
        ['lists', 'requests, threads, people, areas and the update cursor.'],
      ],
      schema: tools.get_board,
      readOnly: true,
      catchesUp: (args) => args.area === undefined,
      handler: async ({ board_id }) => {
        const board = store.getBoard(board_id);
        const renamed = board.id === board_id ? '' : `\n\nThis board was renamed: its id is now ${board.id}. The old one still works.`;
        const nudge = session.skillsReported ? '' : `\n\n${SKILLS_NUDGE}`;
        session.told.begin();
        const view = agentBoard(board, getActor().name);
        const digest = boardDigest(view, getActor().name, store.now(), session.told, session.agent(), words);
        seeBoardComments(store, board, getActor(), undefined, words);
        const pairing = (options.pairing?.lines(boardKey(board), getActor().name) ?? []).map((line) => `\n\n${line}`).join('');
        return text(`${digest}${pairing}${renamed}${nudge}`);
      },
    }),

    defineTool({
      name: 'search',
      title: 'Search',
      description: [
        ['search', 'Search '],
        ['kinds', 'comments, findings and canvas blocks'],
        ['match', '. Every word must match; case and accents are ignored.'],
        ['read', ' Read results with '],
        ['results', 'get_block'],
        ['end', '.'],
      ],
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
          cards: words.offers('cards'),
          context: words.offers('board-context'),
        };
        const found = searchStore({ listBoards: () => store.listBoards(), getBoard: (id) => agentBoard(store.getBoard(id), getActor().name) }, args.query, options);
        const boardTitle = args.board_id ? store.getBoard(args.board_id).title : undefined;
        return text(searchDigest(found, args.query, { ...options, boardTitle }, words));
      },
    }),

    defineTool({
      name: 'take_request',
      title: 'Take request',
      description:
        "Take a person's request (get_board shows its request id). It returns the group for your answer: add blocks there (add_block with group_id), then finish_request.",
      guide: {
        topic: 'canvas',
        text: [
          [
            'group',
            'It returns the group for your answer: add your blocks there with add_block(group_id), then finish_request. A request that @-mentions other agents is theirs, and is refused.',
          ],
          ['board', ''],
          [
            'threads',
            " People now talk about blocks they select on a Sketchbook page in a thread, which you answer with reply_in_thread (read_guide(\"conversation\")). A request about blocks on a page is one asked before that: the blocks were the context, and what they typed is the request. Its group is beside the blocks, and get_board names them. They didn't pick what comes back: you choose what fits what they asked. ",
          ],
          ['pick', 'A'],
          ['view', ' view, a draft or a plain answer becomes blocks in the group.'],
          ['finish', ' Then finish_request with a note saying what you made and why: it is your reply to them.'],
          ['take', ' Take one with take_request, read the project as needed (code, '],
          ['read', "the blocks it is about), answer with visuals (diagrams, tables) as blocks in the request's group, and finish_request with a one-line note."],
        ],
      },
      schema: tools.take_request,
      handler: async ({ request_id, title }) => {
        // A request on the board context is answered there, which only a server whose group offers it has: without one it is no request.
        // The same for one that asks for a card (a decision or tasks), which a server with none can't answer.
        if (!answerable(store.getRequest(request_id).request, words)) throw new BoardError(`No request "${request_id}".`, 'not_found');
        const { request, group } = store.takeRequest(request_id, getActor(), title);
        const { board } = store.getRequest(request_id);
        const asked = `${request.by.name}'s request: "${request.text}"`;
        const place = requestCanvas(board, request)?.page;
        const on = place ? `page_id: ${place.id}` : `board_id: ${board.id}`;
        if (!group) return text(`You took ${asked}, but its group is gone: add a group with add_group(${on}) for your answer, then finish_request.`);
        const where = place ? `beside the blocks it is about on ${pageName(place)}` : 'on the board context';
        const blocks = requestBlocks(board, request);
        const read = place && !request.kind ? '.' : `: read them with get_canvas(${on}).`; // what to make says to read them
        const about = blocks.length ? ` It is about ${listNames(blocks.map((b) => `${blockName(b, 40)} [id: ${b.id}]`))}${read}` : '';
        // A request that asks for a card is answered by the tool group that makes it (a part's decision or tasks).
        const made = request.kind ? words.line(`take_request.${request.kind}`, { board: board.id, request: request.id }) : undefined;
        const answer =
          made ??
          (place
            ? `R${pageAnswerHow(board.id, request.id, place.id, group.id, words).slice(1)}`
            : `Build the answer there as blocks (add_block with ${on} and group_id: ${group.id}), reading the project as needed: diagrams and tables over prose. Then finish_request with a one-line note.`);
        return text(`Took ${asked}. Its group ${where} is "${group.title}" [group id: ${group.id}].${about} ${answer}`);
      },
    }),

    defineTool({
      name: 'finish_request',
      title: 'Finish request',
      description:
        "Mark a person's request done, once your answer is in its group. Only the agent who took it finishes it. The note is your reply: what you made, and why.",
      schema: tools.finish_request,
      handler: async ({ request_id, note }) => {
        const request = store.finishRequest(request_id, note, getActor());
        const { board } = store.getRequest(request_id);
        const group = requestGroup(board, request);
        const where = group ? ` in group "${group.title}"` : '';
        return text(`Finished ${request.by.name}'s request${where}; people see it's done, with your note.`);
      },
    }),
  ];
}
