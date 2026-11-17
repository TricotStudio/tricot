import type { z } from 'zod';
import type { CommonPatch, InputsOf, PatchesOf } from '../blocks/kind';
import type { RegisteredKinds } from '../blocks/registry';
import type { DiffSide } from '../blocks/diff/diff';
import type * as schemas from '../schemas/shared';
import type { Actor, Board, BoardEvent, Canvas, SceneView, ScratchPage } from '../types';

// What the Store takes, where a shell sends the same thing: the schemas' own
// types (core/schemas/shared.ts), so a field is written once.
export type LensInput = z.infer<typeof schemas.lensInput>;
// The canvas a call names: the board context's, a page's, or a card's by its kind's `<kind>Id` (a part adds `decisionId` and
// `taskId`). The kinds are the Store's, so a key that names a kind it has none of finds no card
// (store/repository.ts locate).
export interface CanvasRef {
  boardId?: string;
  pageId?: string;
}
export type NewGroup = z.infer<typeof schemas.newGroup>;
export type Move = z.infer<typeof schemas.move>;

// A block posted with its decision. The canvas has no groups yet, so a block
// names its group by title; blocks giving the same title share one.
export interface InlineBlock extends Omit<NewBlock, 'groupId' | 'x' | 'y'> {
  group?: string;
}

// What making a block of any kind takes: its type and what its kind reads.
export type BlockContent = InputsOf<RegisteredKinds>;

export interface NewBlock {
  content: BlockContent;
  title?: string;
  groupId?: string;
  optionId?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

// A change to a block: what any block takes, and the fields of every kind
// (a block refuses those that aren't its kind's).
export type BlockPatch = CommonPatch & PatchesOf<RegisteredKinds>;

// The part of a block a person or agent pins, before it is checked against the
// block. Words carry the text around them (from a selection) or which
// occurrence they are (from an agent); table ranges are 0-based and inclusive;
// a box is fractions of the image; an arrow is the n-th between its nodes.
export type PinPart =
  | { kind: 'text'; quote: string; prefix?: string; suffix?: string; occurrence?: number }
  | { kind: 'cells'; rows?: [number, number]; columns?: [number, number] }
  | { kind: 'box'; x: number; y: number; w: number; h: number }
  | { kind: 'node'; nodeId: string }
  | { kind: 'arrow'; from: string; to: string; n?: number }
  | { kind: 'line'; file: string; line: number; side?: DiffSide; last?: number } // a diff's line, on its new side unless said; on a code block, lines `line` to `last`
  | { kind: 'point'; category?: string; series?: string } // a chart's category, and series on a chart of several, by name; a series alone is the whole series
  // A spot on a 3D scene: a named object (by name or uuid), and a point, in
  // its coordinates (its middle, if none); or a point in the scene; and the
  // view it was seen from.
  | { kind: 'spot'; object?: string; x?: number; y?: number; z?: number; view?: SceneView }
  // Words in a Google Doc's paragraph, checked against the doc by the caller
  // (DocDrafts), which has it: the paragraph id at the doc's revision.
  | { kind: 'doc'; paragraph: string; revision: string; quote: string; prefix?: string; suffix?: string; title?: string }
  // An element on a page of a website block, as a person's view of the page
  // found it: checked against the block by its kind (core/blocks/site).
  | { kind: 'site'; page: string; selector: string; tag: string; text?: string; file?: string; line?: number }
  | { kind: 'block' };

// What a pin links to: one task or one decision on the block's board.
export interface PinTarget {}

export interface Located {
  board: Board;
  page?: ScratchPage; // a Sketchbook page: like the board context, it has no card
  canvas: Canvas;
}

export interface WaitOptions {
  accept?: (event: BoardEvent) => boolean; // a caller's view: excluded events do not wake it
  timeoutMs: number;
  signal?: AbortSignal;
  exclude?: Actor;
  limit?: number; // at most this many events: the first ones after the cursor
  settleMs?: number; // after the first event, wait this long to batch a burst; by default as settleAfter (eventLog.ts) says for it
}
