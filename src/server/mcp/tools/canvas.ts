import { readFileSync } from 'node:fs';
import { duplicateAdvice, withAdvice } from '../../../core/advice';
import { blockLabel } from '../../../core/canvas';
import { contentFields, fieldsByType } from '../../../core/blocks/agent';
import { kindOf, kinds } from '../../../core/blocks/registry';
import { deletedLately } from '../../../core/deletions';
import { canvasName, pinPart, pinTarget } from '../../../core/pins';
import { MAX_INLINE_IMAGES, ONE_CANVAS, namesOneCanvas, tools, type PinArgs } from '../../../core/schemas';
import { blockContentDigest, canvasDigest, pinLines } from '../../../core/digest';
import { BoardError, type CanvasRef, type PinPart, type Store } from '../../../core/store';
import type { Block } from '../../../core/types';
import { defineTool, text, type Tool } from '../tool';
import { inThread } from '../wording';
import type { ToolContext } from './context';
import { agentBoard } from '../backlog';

function canvasRef(args: { board_id?: string; decision_id?: string; task_id?: string }): CanvasRef {
  const ref = { boardId: args.board_id, decisionId: args.decision_id, taskId: args.task_id };
  if (!namesOneCanvas(ref)) throw new BoardError(ONE_CANVAS);
  return ref;
}

function imageContent(store: Store, assetId: string) {
  const { file, mimeType } = store.assetFile(assetId);
  return { type: 'image' as const, data: readFileSync(file).toString('base64'), mimeType };
}

// The part of a block a pin call names, checked against the block. Each kind
// reads the fields that name its parts (its own block's first): table rows and
// columns become 0-based ranges, an item's text becomes its id. Words, or
// nothing, pin words and the whole block.
function pinPartFrom(block: Block, args: PinArgs): PinPart {
  const own = kindOf(block.type);
  for (const kind of [own, ...kinds().filter((k) => k !== own)]) {
    const part = kind.agent.pinPart?.(block, args);
    if (part) return part;
  }
  if (args.text !== undefined) return { kind: 'text', quote: args.text, occurrence: args.occurrence };
  return { kind: 'block' };
}

// A block's versions for get_block, one line each, newest first.
function versionLines(store: Store, block: Block): string {
  const lines = store.versionSummaries(block.id).map(
    (v) => `- v${v.rev}${v.rev === block.rev ? ' (current)' : ''} · ${v.at} · ${v.by.name} (${v.by.kind})${v.change ? ` · ${v.change}` : ''}`,
  );
  return `Versions, newest first (restore one with update_block, restore_rev):\n${lines.join('\n')}`;
}

export function canvasTools({ store, getActor, blocks: { io, fill, fillChange, readContent } }: ToolContext): Tool[] {
  return [
    defineTool({
      name: 'get_canvas',
      title: 'Get canvas',
      description:
        "Read a canvas (pass board_id for the board context, decision_id or task_id): every block in reading order by group, in full, with the links between blocks, the pins and people's comments under each block, and images attached. People edit blocks directly: treat their edits as instructions.",
      guide: {
        topic: 'canvas',
        text: [
          "Every board has a board context (board_id): the canvas that holds the board's global context and current state (goal, constraints, architecture, what's done). Read it before planning, and keep it current: update it when a decision settles or a task finishes. Every decision and task also has its own canvas for its evidence and work; re-read a decision's before acting on it.",
          'People edit blocks directly. Treat their edits as instructions: a ticked item is done, a changed cell is a correction, a block moved into a group or a new link is a claim about how things relate.',
          "Pins are listed under their block: parts linked to tasks and decisions, and parts people commented on, with what they said on a diff's or code block's lines (answer on the line with comment(pin_id)) and the board context's comment threads.",
        ].join(' '),
      },
      schema: tools.get_canvas,
      readOnly: true,
      handler: async (args) => {
        const located = store.getCanvas(canvasRef(args));
        const board = agentBoard(located.board, getActor().name);
        const { decision, task } = located;
        const canvas = task ? board.tasks.find((item) => item.id === task.id)!.canvas : decision ? board.decisions.find((item) => item.id === decision.id)!.canvas : board.canvas;
        const deleted = deletedLately(board.deleted, { decisionId: decision?.id, taskId: task?.id });
        const content: ({ type: 'text'; text: string } | ReturnType<typeof imageContent>)[] = [
          { type: 'text', text: [canvasDigest(board, canvas, decision, task), deleted].filter(Boolean).join('\n\n') },
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
        const canvas = located.task ? board.tasks.find((item) => item.id === located.task!.id)!.canvas : located.decision ? board.decisions.find((item) => item.id === located.decision!.id)!.canvas : board.canvas;
        const block = canvas.blocks.find((b) => b.id === block_id);
        if (!block) throw new BoardError(`"${block_id}" is not a block.`);
        const header = `${blockLabel(block)} [id: ${block.id}] · rev ${block.rev}`;
        const pins = pinLines(board, canvas, block).join('\n');
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
        'Add a block to a canvas (pass board_id, decision_id or task_id), placed automatically, inside group_id if given.',
        fieldsByType(true),
        'A new version of something already on a canvas (a mock, a screenshot, a table) goes in that block: update_block on it, images included, not a new block.',
      ].join(' '),
      guide: {
        topic: 'blocks',
        text: [
          'Use a block when text alone carries the idea poorly: a table for comparable data, a Mermaid diagram for flows, states, sequences or architecture, a task list in a note for steps, an image for screenshots of prototypes or UI, a link for a doc, pull request or design file people should open. Notes are for short prose.',
          "Lead with the single visual that most changes the decision; don't build walls of blocks. Make layout meaning explicit: put related blocks in a named group (add_group), connect blocks with labelled links (link), and pin evidence to the option it supports (option).",
          "On a task's canvas, put what shows the work before you send it for review: screenshots of the result, a task list of what's done, and for code work a diff block.",
          'Add a block only for something new. A new version of something already on a canvas (a mock, a screenshot, a table) goes in that block: update_block on it, images included, not a new block. If you added a duplicate, remove the old one with remove_item: people should see only the latest version.',
        ].join(' '),
      },
      schema: tools.add_block,
      handler: async (sent) => {
        const ref = canvasRef(sent);
        const thread = sent.thread_id ? store.threadOn(sent.thread_id, store.getCanvas(ref).board) : undefined;
        const args = await fill(sent); // a diff or file named on this computer, read
        const content = readContent(args)();
        const block = store.addBlock(
          ref,
          { content, title: args.title, groupId: args.group_id, optionId: args.option, w: args.width, h: args.height },
          getActor(),
        );
        if (thread) store.addThreadWork(thread.id, { kind: 'block', id: block.id }, getActor());
        const added = `Added ${blockLabel(block)} [id: ${block.id}] (rev ${block.rev}).${thread ? ` It shows in ${inThread(thread)}.` : ''}`;
        const { canvas } = store.canvasOf(block.id);
        const advice = [...(kindOf(block.type).agent.adviceAdded?.(block, args) ?? []), ...duplicateAdvice(block, canvas.blocks, getActor())];
        return text(withAdvice(added, advice));
      },
    }),

    defineTool({
      name: 'update_block',
      title: 'Update block',
      description: [
        'Change a block in place, for each new version of it: its title, the content fields add_block takes for its type, the option it is pinned to ("" unpins) or its group ("" takes it out).',
        "Rows and items replace the whole list; items leave a note's prose alone.",
        'Pass the rev you last read: if someone changed the block since, it is refused with the current content to reapply your change to.',
        'Each change keeps the previous version: restore_rev brings one back (get_block lists them).',
      ].join(' '),
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
        const group = store.addGroup(canvasRef(args), { title: args.title }, getActor());
        return text(`Added group "${group.title}" [id: ${group.id}].`);
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
      name: 'pin',
      title: 'Pin work to part of a block',
      description:
        "Link an existing task or decision to part of a block (block_id), or to the same part as another pin (pin_id), so people see the work where they read about it. Name the part with the fields for the block's type; with none, the whole block. remove_item with the pin id undoes it.",
      guide: {
        topic: 'canvas',
        text: [
          'A pin shows people what the work is about where they read it, with its status. get_canvas lists pins under their block, and get_task and get_decision say where the work was pinned from. Pin existing work to the parts about it, e.g. during a sync.',
          'Pass pin_id instead of block_id and a part for the same part as that pin, e.g. a decision answering a comment thread there.',
          'The part: words in a note (text, with occurrence if they appear more than once); a task in a note (item, by its words), or words in one (item and text);',
          'table cells (row and/or column; to_row and to_column make a range; a row alone is the whole row, a column alone the whole column);',
          'a box on an image (box, as fractions of it), numbered on the image; a flowchart node (node, by its id in the Mermaid source)',
          "or the arrow (edge) from it to another (node and to_node); a line of a diff (file and line, with side \"old\" for a removed line); a chart's bar, point or slice (category, and series on a chart of several);",
          'or, with none of these, the whole block, e.g. a link card.',
        ].join(' '),
      },
      schema: tools.pin,
      handler: async (args) => {
        const work = { taskId: args.task_id, decisionId: args.decision_id };
        if (!args.block_id === !args.pin_id) throw new BoardError('Pass block_id and the part, or pin_id for the same part as that pin.');
        const { block_id: _block, pin_id: _pin, task_id: _task, decision_id: _decision, ...part } = args;
        if (args.pin_id && Object.values(part).some((v) => v !== undefined)) throw new BoardError("With pin_id, leave out the part: it's that pin's.");
        const { board, canvas } = store.canvasOf(args.pin_id ?? args.block_id!);
        const pinned = args.pin_id ? store.pinAlongside(args.pin_id, work, getActor()) : undefined;
        const block = canvas.blocks.find((b) => b.id === (pinned?.blockId ?? args.block_id));
        if (!block) throw new BoardError(`"${args.block_id}" is not a block.`);
        const pin = pinned ?? store.pin(block.id, pinPartFrom(block, args), work, getActor());
        const target = pinTarget(board, pin)!;
        return text(
          `Pinned ${pinPart(pin, block)} in ${blockLabel(block)} to ${target.ref} [pin id: ${pin.id}]. People see it there, linked, with ${target.ref}'s status.`,
        );
      },
    }),

    defineTool({
      name: 'remove_item',
      title: 'Remove canvas item',
      description:
        'Remove a block (and its links and pins), a group (its blocks stay), a link, or a pin. Deletions are kept for 30 days: restore_item puts one back as it was. If you added a duplicate of a block, remove the old one: people should see only the latest version. Threads, tasks and decisions are people\'s to delete.',
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
