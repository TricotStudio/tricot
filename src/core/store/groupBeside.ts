import type { Canvases } from './canvases';
import type { Located } from './inputs';
import { type BoardRepository, refOf } from './repository';
import { boxAround, placeOf, spotBeside } from '../canvas';
import type { Actor, Block, Group } from '../types';

// The group a request on a page starts with, beside its blocks: room for
// blocks, or for the cards a decision or tasks show as. It grows as they come.
export const BLOCKS_GROUP = { w: 560, h: 320 };
export const CARDS_GROUP = { w: 480, h: 200 };

// A group on a canvas for an answer, beside the blocks it is about when
// there are some on a page (to their right if there is room, else under them,
// and so on: canvas.ts spotBeside), else in the first free spot. What a
// request (store/requests.ts) and a thread over selected blocks
// (store/threads.ts) make to show what came of them. Not logged: the caller
// logs what it is for.
export function groupBeside(repo: BoardRepository, canvases: Canvases, located: Located, blocks: Block[], title: string, size: { w: number; h: number }, actor: Actor): Group {
  const { canvas } = located;
  let place = {};
  if (located.page && blocks.length) {
    const around = boxAround(blocks.map((b) => placeOf(canvas, b)));
    place = { ...spotBeside([...canvas.groups, ...canvas.blocks.filter((b) => !b.groupId)], around, size), ...size };
  }
  const group = canvases.newGroup(located, { title, ...place }, actor);
  canvas.groups.push(group);
  repo.indexItem(group.id, refOf(located));
  return group;
}
