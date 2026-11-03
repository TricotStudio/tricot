// What a person asks of a GitHub link card: "Show the changes" adds a diff
// block of a pull request, "Bring in this file" a code block of a file at the
// commit its link names. Each goes onto the canvas the link is on, beside it.

import { clip } from '../../../core/format';
import { codeLines } from '../../../core/blocks/code/code';
import { githubTarget, type GithubTarget } from '../../../core/connectors/github/link';
import { defaultSize } from '../../../core/canvas';
import { BoardError, type Store } from '../../../core/store';
import type { CanvasRef } from '../../../core/store/inputs';
import type { Actor, Block } from '../../../core/types';
import { GithubError } from './connector';
import type { GithubReader } from './reader';

// A diff bigger than this is too much for a board.
export const BOARD_DIFF_MAX = 1_000_000;
const GAP = 48;

type LinkBlock = Extract<Block, { type: 'link' }>;

export class GithubBlocks {
  constructor(
    private readonly store: Store,
    private readonly reader: GithubReader,
  ) {}

  async showChanges(blockId: string, actor: Actor): Promise<Block> {
    const { link, target } = this.linkOf(blockId);
    if (target.kind !== 'pull') throw new BoardError('Only a pull request has changes to show.');
    const { text, truncated } = await this.reader.diff(target, BOARD_DIFF_MAX);
    if (truncated) {
      throw new GithubError(
        `This pull request's changes are bigger than Tricot shows on a board (over ${BOARD_DIFF_MAX / 1_000_000} MB). Open it on GitHub.`,
        413,
        'too_big',
      );
    }
    const card = await this.reader.card(target).catch(() => undefined);
    const title = card ? clip(`${card.repo} #${card.number}: ${card.title}`, 120) : `${target.owner}/${target.repo} #${target.number}`;
    return this.add(link, { type: 'diff', patch: text }, title, actor);
  }

  async bringInFile(blockId: string, actor: Actor): Promise<Block> {
    const { link, target } = this.linkOf(blockId);
    if (target.kind !== 'file') throw new BoardError('Only a link to a file can be brought in.');
    const file = await this.reader.file(target);
    const last = codeLines(file.text).length;
    const range = file.lines && file.lines[0] <= last ? ([file.lines[0], Math.min(file.lines[1], last)] as [number, number]) : undefined;
    return this.add(link, { type: 'code', path: file.path, text: file.text, commit: file.commit.slice(0, 10), ...(range ? { highlight: [range] } : {}) }, undefined, actor);
  }

  private linkOf(blockId: string): { link: LinkBlock; target: GithubTarget } {
    const block = this.store.canvasOf(blockId).canvas.blocks.find((b) => b.id === blockId);
    const target = block?.type === 'link' ? githubTarget(block.url) : null;
    if (block?.type !== 'link' || !target) throw new BoardError(`"${blockId}" is not a link to a GitHub pull request or file.`);
    return { link: block, target };
  }

  // Beside the link, where nothing is in the way; inside its group when it is in one.
  private add(link: LinkBlock, content: Parameters<Store['addBlock']>[1]['content'], title: string | undefined, actor: Actor): Block {
    const { board, canvas, task, decision } = this.store.canvasOf(link.id);
    const ref: CanvasRef = task ? { taskId: task.id } : decision ? { decisionId: decision.id } : { boardId: board.id };
    const size = defaultSize(content.type);
    const neighbours = [...canvas.blocks.filter((b) => b.groupId === link.groupId), ...(link.groupId ? [] : canvas.groups)];
    const clear = (spot: { x: number; y: number }) =>
      !neighbours.some((b) => spot.x < b.x + b.w + 16 && b.x < spot.x + size.w + 16 && spot.y < b.y + b.h + 16 && b.y < spot.y + size.h + 16);
    const spot = link.groupId
      ? undefined
      : [
          { x: link.x + link.w + GAP, y: link.y },
          { x: link.x, y: link.y + link.h + GAP },
        ].find(clear);
    return this.store.addBlock(ref, { content, title, groupId: link.groupId, ...spot }, actor);
  }
}
