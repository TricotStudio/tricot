import { readFileSync } from 'node:fs';
import { duplicateAdvice, withAdvice } from '../../../core/advice';
import { blockLabel } from '../../../core/canvas';
import { cardOf, cardOwning } from '../../../core/cards';
import { contentFields, fieldsWords } from '../../../core/blocks/agent';
import { kindOf, kinds } from '../../../core/blocks/registry';
import { deletedLately } from '../../../core/deletions';
import { clip } from '../../../core/format';
import { canvasName } from '../../../core/pins';
import { linkTo } from '../../../core/pages';
import { pageName } from '../../../core/scratchPad';
import { MAX_INLINE_IMAGES, namesOneCanvas, tools } from '../../../core/schemas';
import { blockContentDigest, canvasDigest, pinLines } from '../../../core/digest';
import { BoardError, type CanvasRef, type Store } from '../../../core/store';
import type { Located } from '../../../core/store/inputs';
import { boardKey, type Block, type Board, type Canvas } from '../../../core/types';
import { defineTool, text, type Tool } from '../tool';
import { inThread } from '../wording';
import type { Phrases, Piece } from '../words';
import type { ToolContext } from './context';
import { agentBoard } from '../backlog';

// Which canvas a call names is a page; a group may add the board context and the canvases of its own cards (a part's
// decisions and tasks), and says so in this refusal.
const ONE_CANVAS: Piece[] = [
  ['pass', 'Pass '],
  ['board', ''],
  ['or', ''],
  ['page', 'page_id (a Sketchbook page).'],
];

// The canvas a call names: its board_id, page_id, or the `<kind>_id` of a kind of card the Store keeps (a group that offers
// cards adds those arguments).
function canvasRef(store: Store, args: { board_id?: string; page_id?: string }, words: Phrases): CanvasRef {
  const named = args as Record<string, string | undefined>;
  const kinds = store.cardKinds();
  const ref: CanvasRef = { boardId: args.board_id, pageId: args.page_id, ...Object.fromEntries(kinds.map((kind) => [`${kind}Id`, named[`${kind}_id`]])) };
  if (!namesOneCanvas(ref, kinds)) throw new BoardError(words.say('canvas.one', ONE_CANVAS));
  return ref;
}

// The canvas a located one is, on the board as this agent sees it (agentBoard),
// which leaves out what is pinned to cards still in a person's backlog.
function viewOf(board: Board, located: Located): Canvas {
  const { page } = located;
  const owner = cardOwning(located);
  if (owner) return cardOf(board, owner.kind.kind, owner.id)!.canvas;
  if (page) return board.pages!.find((item) => item.id === page.id)!.canvas;
  return board.canvas;
}

// A Sketchbook page's link, to give a person: the board's own address
// (app.ts), then the page's (core/pages.ts). None without the address.
function pageLink(address: string | undefined, boardId: string, pageId: string): string | undefined {
  return address ? `${address}/${linkTo.page(boardId, pageId)}` : undefined;
}

function imageContent(store: Store, assetId: string) {
  const { file, mimeType } = store.assetFile(assetId);
  return { type: 'image' as const, data: readFileSync(file).toString('base64'), mimeType };
}

// A block's versions for get_block, one line each, newest first.
function versionLines(store: Store, block: Block): string {
  const lines = store.versionSummaries(block.id).map(
    (v) => `- v${v.rev}${v.rev === block.rev ? ' (current)' : ''} · ${v.at} · ${v.by.name} (${v.by.kind})${v.change ? ` · ${v.change}` : ''}`,
  );
  return `Versions, newest first (restore one with update_block, restore_rev):\n${lines.join('\n')}`;
}

export function canvasTools({ store, getActor, options, session, words, blocks: { io, fill, fillChange, readContent } }: ToolContext): Tool[] {
  // Whether this agent hears what people say to it on a board as it comes
  // (presence.ts hears): else a page it makes tells it to listen.
  const hearsOn = (board: Board) => options.presence?.hears(boardKey(board), getActor().name) ?? true;

  return [
    defineTool({
      name: 'get_canvas',
      title: 'Get canvas',
      description: [
        ['read', 'Read a canvas (pass '],
        ['board', ''],
        ['or', ''],
        [
          'page',
          "page_id): every block in reading order by group, in full, with the links between blocks, the pins and people's comments under each block, and images attached. People edit blocks directly: treat their edits as instructions.",
        ],
      ],
      guide: {
        topic: 'canvas',
        text: [
          ['board', ''],
          [
            'edits',
            "People edit blocks directly. Treat their edits as instructions: a ticked item is done, a changed cell is a correction, a block moved into a group or a new link is a claim about how things relate. Pins are listed under their block: ",
          ],
          [
            'pins',
            "parts people commented on, with what they said on a diff's or code block's lines (answer on the line with comment(pin_id))",
          ],
          ['threads', ''],
          ['pins-end', '.'],
        ],
      },
      schema: tools.get_canvas,
      readOnly: true,
      handler: async (args) => {
        const located = store.getCanvas(canvasRef(store, args, words));
        const board = agentBoard(located.board, getActor().name);
        const { page } = located;
        const owner = cardOwning(located);
        const canvas = viewOf(board, located);
        const deleted = deletedLately(board.deleted, { ...owner?.link, pageId: page?.id });
        const content: ({ type: 'text'; text: string } | ReturnType<typeof imageContent>)[] = [
          { type: 'text', text: [canvasDigest(board, canvas, owner, page, words), deleted].filter(Boolean).join('\n\n') },
        ];
        const images = [...canvas.blocks]
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .flatMap((block) => {
            const assetId = kindOf(block.type).agent.picture?.(block);
            return assetId ? [{ block, assetId }] : [];
          });
        if (images.length && args.include_images !== false) {
          const attached = images.slice(0, MAX_INLINE_IMAGES);
          const rest = images.length - attached.length;
          content.push({
            type: 'text',
            text: `Attached images, in order: ${attached.map(({ block }) => `${blockLabel(block)} [id: ${block.id}]`).join(', ')}${rest ? `. ${rest} more: use get_block.` : ''}`,
          });
          for (const { assetId } of attached) content.push(imageContent(store, assetId));
        }
        return { content };
      },
    }),

    defineTool({
      name: 'get_block',
      title: 'Get block',
      description:
        'Read one canvas block in full, without truncation, with its earlier versions listed (update_block with restore_rev brings one back). Image blocks come back as the image itself.',
      schema: tools.get_block,
      readOnly: true,
      handler: async ({ block_id }) => {
        const located = store.canvasOf(block_id);
        const board = agentBoard(located.board, getActor().name);
        const canvas = viewOf(board, located);
        const block = canvas.blocks.find((b) => b.id === block_id);
        if (!block) throw new BoardError(`"${block_id}" is not a block.`);
        const header = `${blockLabel(block)} [id: ${block.id}] · rev ${block.rev}`;
        const pins = pinLines(board, canvas, block, words).join('\n');
        const versions = block.versionCount ? versionLines(store, block) : '';
        const content: ({ type: 'text'; text: string } | ReturnType<typeof imageContent>)[] = [
          { type: 'text', text: [`${header}\n${blockContentDigest(block, true)}`, pins, versions].filter(Boolean).join('\n\n') },
        ];
        const picture = kindOf(block.type).agent.picture?.(block);
        if (picture) content.push(imageContent(store, picture));
        return { content };
      },
    }),

    defineTool({
      name: 'add_block',
      title: 'Add block',
      description: [
        ['add', 'Add a block to a canvas (pass '],
        ['board', ''],
        ['or', ''],
        ['page', 'page_id), placed automatically, inside group_id if given. '],
        ...fieldsWords(true, (what) => words.offers(what)),
        ['new-version', ' A new version of something already on a canvas (a mock, a screenshot, a table) goes in that block: update_block on it, images included, not a new block.'],
      ],
      guide: {
        topic: 'blocks',
        text: [
          [
            'use',
            'Use a block when text alone carries the idea poorly: a table for comparable data, a Mermaid diagram for flows, states, sequences or architecture, a task list in a note for steps, an image for screenshots of prototypes or UI, a link for a doc, pull request or design file people should open. Notes are for short prose. Lead with the single visual that ',
          ],
          ['matters', 'matters most'],
          ['layout', "; don't build walls of blocks. Make layout meaning explicit: put related blocks in a named group (add_group)"],
          ['and', ' and '],
          ['link', 'connect blocks with labelled links (link)'],
          ['layout-end', '.'],
          [
            'answering',
            " Answering a thread over blocks a person selected on a Sketchbook page, add_block with that page_id and the thread_id puts the block in the group beside them, made if it isn't there yet. Add a block only for something new. A new version of something already on a canvas (a mock, a screenshot, a table) goes in that block: update_block on it, images included, not a new block. If you added a duplicate, remove the old one with remove_item: people should see only the latest version.",
          ],
        ],
      },
      schema: tools.add_block,
      handler: async (sent) => {
        const ref = canvasRef(store, sent, words);
        const thread = sent.thread_id ? store.threadOn(sent.thread_id, store.getCanvas(ref).board) : undefined;
        const args = await fill(sent); // a diff or file named on this computer, read
        const content = readContent(args)();
        // What a thread over selected blocks makes on their page goes in the group beside them, unless a group is named.
        const beside = thread && !args.group_id && ref.pageId && ref.pageId === thread.pageId ? store.threadGroup(thread.id, getActor()) : undefined;
        const block = store.addBlock(
          ref,
          { content, title: args.title, groupId: args.group_id ?? beside?.id, optionId: args.option, w: args.width, h: args.height },
          getActor(),
        );
        if (thread) store.addThreadWork(thread.id, { kind: 'block', id: block.id }, getActor());
        const placed = beside ? ` It is in group "${clip(beside.title, 60)}", beside the blocks the thread is about.` : '';
        const added = `Added ${blockLabel(block)} [id: ${block.id}] (rev ${block.rev}).${thread ? ` It shows in ${inThread(thread)}.` : ''}${placed}`;
        const { canvas } = store.canvasOf(block.id);
        const advice = [...(kindOf(block.type).agent.adviceAdded?.(block, args) ?? []), ...duplicateAdvice(block, canvas.blocks, getActor())];
        return text(withAdvice(added, advice));
      },
    }),

    defineTool({
      name: 'update_block',
      title: 'Update block',
      description: [
        ['change', 'Change a block in place, for each new version of it: its title, the content fields add_block takes for its type, '],
        ['or', 'or '],
        [
          'group',
          'its group ("" takes it out). Rows and items replace the whole list; items leave a note\'s prose alone. Pass the rev you last read: if someone changed the block since, it is refused with the current content to reapply your change to. Each change keeps the previous version: restore_rev brings one back (get_block lists them).',
        ],
      ],
      guide: {
        topic: 'blocks',
        text: [
          `Content fields by type: ${contentFields()}.`,
          "Rows replace the whole list. Items replace a note's task list and leave the prose around it alone; a task keeps its tick when its words match.",
          'Each content change keeps what the block showed before as a version: restore_rev brings one back (get_block lists them).',
          'Pass the rev you last read: if a person has changed the block since, the update is refused and you get the current content to reapply your change to.',
        ].join(' '),
      },
      schema: tools.update_block,
      handler: async (sent) => {
        const { block_id, rev, restore_rev, thread_id, ...changes } = sent;
        const thread = thread_id ? store.threadOn(thread_id, store.canvasOf(block_id).board) : undefined;
        if (restore_rev !== undefined && Object.values(changes).some((v) => v !== undefined)) {
          throw new BoardError('Pass restore_rev with block_id and rev only: it brings back the whole version. Change the block after, if you need to.');
        }
        const found = store.canvasOf(block_id).canvas.blocks.find((b) => b.id === block_id);
        const args = found ? await fillChange(sent, found) : sent; // a diff or file named on this computer, read
        const before = found && structuredClone(found); // as it was, for what the update did to it
        let block: Block;
        try {
          block =
            restore_rev !== undefined
              ? store.restoreBlock(block_id, restore_rev, getActor(), rev)
              : store.updateBlock(
                  block_id,
                  {
                    ...Object.assign({}, ...kinds().map((kind) => kind.agent.patch?.(args, io))),
                    title: args.title,
                    optionId: args.option === undefined ? undefined : args.option || null,
                    groupId: args.group_id === undefined ? undefined : args.group_id || null,
                  },
                  getActor(),
                  rev,
                );
        } catch (error) {
          if (!(error instanceof BoardError) || error.code !== 'conflict') throw error;
          const current = store.canvasOf(args.block_id).canvas.blocks.find((b) => b.id === args.block_id)!;
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `${error.message}\n\nCurrent content (rev ${current.rev}):\n${blockContentDigest(current, true)}` }],
          };
        }
        const updated =
          restore_rev !== undefined
            ? `Restored v${restore_rev} of ${blockLabel(block)} [id: ${block.id}] (now rev ${block.rev}). The version it replaced is kept.`
            : `Updated ${blockLabel(block)} [id: ${block.id}] (now rev ${block.rev}).`;
        if (thread) store.addThreadWork(thread.id, { kind: 'block', id: block.id }, getActor());
        const shown = thread ? `It shows in ${inThread(thread)}.` : '';
        const kind = kindOf(block.type);
        const noticed = before && before.type === block.type ? kind.agent.noticeUpdated?.(before, block, store.canvasOf(block.id).canvas.pins) : undefined;
        const notice = [updated, noticed, shown].filter(Boolean).join(' ');
        const advice = kind.agent.adviceUpdated?.(block, args) ?? [];
        return text(withAdvice(notice, advice));
      },
    }),

    defineTool({
      name: 'add_group',
      title: 'Add group',
      description: 'Add a named group to a canvas, then add blocks into it with group_id. The name says why the blocks belong together.',
      schema: tools.add_group,
      handler: async (args) => {
        const group = store.addGroup(canvasRef(store, args, words), { title: args.title }, getActor());
        return text(`Added group "${group.title}" [id: ${group.id}].`);
      },
    }),

    defineTool({
      name: 'add_page',
      title: 'Add Sketchbook page',
      description:
        'Add a Sketchbook page; fill it with add_block(page_id). When a person asks to see something on or in Tricot, its board or canvas ("show me the last dev log in tricot"), make a page showing it, pass asked: their words, and answer with its link.',
      guide: {
        topic: 'canvas',
        text: [
          ['sketchbook', 'The Sketchbook holds pages, each a canvas for an idea people are exploring with agents (get_board lists them, with their ids). Work on one as on any canvas, passing page_id: get_canvas, add_block, add_group. Its pins keep their own comment threads'],
          ['sketchbook-end', '.'],
          ['make', ' Make a page for a new idea someone asks you to explore, named after the idea'],
          ['filling', ''],
          ['rename', '; rename it with update_page when the idea changes. Only people delete a page, and arrange the pages.'],
          ['show', ' Show me on Tricot: when a person asks you, in your own terminal or anywhere, to see something on or in Tricot, the board or the canvas ("show me how signup works on Tricot", "show me the last dev log in tricot", "draw the auth flow on the board"), make a page named after it, with asked: their words in a line, fill it with what shows it best (a flow diagram, a table, screenshots, the code that matters), then answer with the link add_page returned and a sentence on what is on the page. Never open their browser yourself: the link is the answer. Tricot\'s prompt hook may add a line beside such a message saying so; it is a guess from their words, so when they meant code in a project named tricot ("show me the tests in tricot")'],
          ['show-end', ', do that instead.'],
          ['board', " Put it on the board you are working with (the one `tricot <agent>` started you on); otherwise on the board that fits the project in the folder you work in (list_boards). If more than one could fit, ask the person in the terminal which; if none does, ask before you make one: never create a board without asking."],
          ['yours', " The page is yours: what people ask on it, from its chat bar or about blocks they select, comes to you unless they @-mention another agent. If add_page says you aren't listening on the board, start once you've answered (wait_for_updates), so you answer them there as they work on the page."],
          ['without', ' Without your Tricot tools (Tricot wasn\'t running when your session started, or you aren\'t connected), do the same from your shell with `tricot show`: `tricot show <files> --title "<title>" --agent <your name> --asked "<their words>"` starts Tricot if needed, makes the page as you with a block for each file (.md a note, .mmd a diagram, .csv a table, any other file code) and prints its link to give them. It asks you to ask them which board when the folder doesn\'t say. `tricot show --listen --page <id> --agent <your name>`, run in the background, ends when they ask you something on the page, and `--reply` answers it; `tricot show --help` says the rest.'],
        ],
      },
      schema: tools.add_page,
      handler: async ({ board_id, title, asked }) => {
        const page = store.addPage(board_id, title, getActor(), { tool: session.agent()?.id, asked });
        const board = store.getPage(page.id).board;
        const added = `Added ${pageName(page)} [page id: ${page.id}] to the Sketchbook. Add blocks to it with add_block(page_id).`;
        const link = pageLink(options.address, board.id, page.id);
        const yours = 'What people ask on the page comes to you, unless they @-mention another agent.';
        const listen = hearsOn(board)
          ? ''
          : ` You aren't listening on this board, so what they ask there waits until you next check it: once you've given them the link, call wait_for_updates(board_id: ${board.id}) and do as it says, so you answer them on the page as they work.`;
        return text(`${added}${link ? ` Its link: ${link}\nOnce it shows what was asked, give the person this link to see it.` : ''} ${yours}${listen}`);
      },
    }),

    defineTool({
      name: 'update_page',
      title: 'Rename Sketchbook page',
      description: 'Rename a Sketchbook page.',
      schema: tools.update_page,
      handler: async ({ page_id, title }) => {
        const page = store.renamePage(page_id, title, getActor());
        const link = pageLink(options.address, store.getPage(page.id).board.id, page.id);
        return text(`Renamed it ${pageName(page)} [page id: ${page.id}].${link ? ` Its link, to give the person to see it: ${link}` : ''}`);
      },
    }),

    defineTool({
      name: 'link',
      title: 'Link blocks',
      description: 'Draw a labelled arrow between two blocks on the same canvas, e.g. "contradicts", "implements", "measured by".',
      schema: tools.link,
      handler: async ({ from_block_id, to_block_id, label }) => {
        const link = store.addLink(from_block_id, to_block_id, label, getActor());
        return text(`Linked [id: ${link.id}].`);
      },
    }),

    defineTool({
      name: 'remove_item',
      title: 'Remove canvas item',
      description: [
        ['remove', 'Remove a block (and its links and pins), a group (its blocks stay), a link, or a pin. Deletions are kept for 30 days: restore_item puts one back as it was. Threads'],
        ['delete', " are people's to delete."],
      ],
      schema: tools.remove_item,
      destructive: true,
      handler: async ({ id }) => {
        const deletion = store.removeItem(id, getActor());
        return text(`Removed ${deletion.label} [id: ${id}]. restore_item with this id puts it back.`);
      },
    }),

    defineTool({
      name: 'restore_item',
      title: 'Restore canvas item',
      description:
        'Put back a block, group, link or pin removed in the last 30 days, or a thread a person deleted, as it was and with the same id: a block with its links, pins and earlier versions, a thread with its messages. get_canvas lists what was deleted lately from a canvas, get_board the threads.',
      schema: tools.restore_item,
      handler: async ({ id }) => {
        const { deletion, notes } = store.restoreItem(id, getActor());
        if (deletion.kind === 'thread') return text(`Restored ${deletion.label} [thread id: ${id}], with its messages. People see it under Threads again.`);
        const where = canvasName(store.canvasOf(deletion.blockId ?? id));
        const missed = notes.length ? ` Not everything could come back: ${notes.join('; ')}.` : '';
        return text(`Restored ${deletion.label} [id: ${id}] (${where}).${missed}`);
      },
    }),
  ];
}
