import type { z } from 'zod';
import type { CommonPatch, InputsOf, PatchesOf } from '../blocks/kind';
import type { RegisteredKinds } from '../blocks/registry';
import type { DiffSide } from '../blocks/diff/diff';
import type * as schemas from '../schemas/shared';
import type { Actor, Board, Canvas, Decision, SceneView, Task } from '../types';

// What the Store takes, where a shell sends the same thing: the schemas' own
// types (core/schemas/shared.ts), so a field is written once.
export type NewOption = z.infer<typeof schemas.newOption>;
export type NewCriterion = z.infer<typeof schemas.newCriterion>;
// A change to one option. Nothing is deleted: an option that no longer applies
// is marked outdated, and can be brought back.
export type OptionChange = z.infer<typeof schemas.optionChange>;
export type ResolveInput = z.infer<typeof schemas.resolveInput>;
export type NewFinding = z.infer<typeof schemas.newFinding>;
export type LensInput = z.infer<typeof schemas.lensInput>;
export type NewTask = z.infer<typeof schemas.newTask>;
export type TaskPatch = z.infer<typeof schemas.taskPatch>;
export type CanvasRef = z.infer<typeof schemas.canvasRef>;
export type NewGroup = z.infer<typeof schemas.newGroup>;
export type Move = z.infer<typeof schemas.move>;

// A decision an agent names as one this could change or rests on (affects.ts).
export interface NewAffect {
  decisionId: string;
  why: string;
}

export interface NewDecision {
  question: string;
  context?: string;
  options?: NewOption[];
  recommend?: string; // option letter
  recommendationReason?: string;
  blocking?: boolean;
  dependsOn?: string[];
  affects?: NewAffect[]; // decisions it could change or rests on, each with why
  area?: string; // a short theme it belongs to, e.g. "Connectors"
  ask?: string[]; // names of people to route the question to
  askNote?: string;
  criteria?: NewCriterion[];
  blocks?: InlineBlock[]; // evidence for its canvas, posted with it
}

// A block posted with its decision. The canvas has no groups yet, so a block
// names its group by title; blocks giving the same title share one.
export interface InlineBlock extends Omit<NewBlock, 'groupId' | 'x' | 'y'> {
  group?: string;
}

export interface DecisionPatch {
  question?: string;
  context?: string;
  addOptions?: NewOption[];
  reviseOptions?: OptionChange[];
  recommend?: string;
  recommendationReason?: string;
  blocking?: boolean;
  dependsOn?: string[];
  affects?: NewAffect[]; // replaces the decisions it names; [] clears them
  area?: string; // '' clears it; agents can't change an area a person set
  refreshed?: boolean; // an agent finishing a refresh: it re-checked the card against the app as it is now
  note?: string; // with refreshed: what changed, or why it all still holds
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
  | { kind: 'line'; file: string; line: number; side?: DiffSide } // a diff's line, on its new side unless said
  | { kind: 'point'; category: string; series?: string } // a chart's category, and series on a chart of several, by name
  // A spot on a 3D scene: a named object (by name or uuid), and a point, in
  // its coordinates (its middle, if none); or a point in the scene; and the
  // view it was seen from.
  | { kind: 'spot'; object?: string; x?: number; y?: number; z?: number; view?: SceneView }
  // Words in a Google Doc's paragraph, checked against the doc by the caller
  // (DocDrafts), which has it: the paragraph id at the doc's revision.
  | { kind: 'doc'; paragraph: string; revision: string; quote: string; prefix?: string; suffix?: string; title?: string }
  | { kind: 'block' };

// What a pin links to: one task or one decision on the block's board.
export interface PinTarget {
  taskId?: string;
  decisionId?: string;
}

export interface Located {
  board: Board;
  decision?: Decision;
  task?: Task;
  canvas: Canvas;
}

export interface WaitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  exclude?: Actor;
  limit?: number; // at most this many events: the first ones after the cursor
  settleMs?: number; // after the first event, wait this long to batch a burst; by default as settleAfter (eventLog.ts) says for it
}
