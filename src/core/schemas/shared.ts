import { z } from 'zod';
import { EMOJIS } from '../reactions';
import { fields } from './fields';

// What people and agents send in the same shape: nested inside a call, in the
// words the core uses. The Store's input types are these, inferred. Each shell
// puts its own envelope around them (REST bodies, MCP tool arguments).

// A reaction as people and agents send it: one of the three (core/reactions.ts),
// or with remove, taking one's own back. REST and the react tool take these
// fields as they are; each names the comment its own way.
export const reactionInput = z.object({
  emoji: z.enum(EMOJIS),
  remove: z.boolean().optional(),
});

// A thread's lens as people or agents choose it: a preset's name (General,
// Legal…), or a name of one's own with a brief; and optionally an agent.
export const lensInput = z.object({
  name: fields.lensName,
  brief: fields.lensBrief.optional(),
  agent: z.string().optional(),
});

// The canvas a call is about: the board's, a Sketchbook page's, or a card's, which a kind of card names by its `<kind>Id`
// (a part's `decisionId` and `taskId`). The kinds are the Store's (`store.cardKinds()`), not the schema's: a body names
// them through `canvasBody`, which is made for the kinds a Store keeps (store/inputs.ts CanvasRef is its type).
// The ids that name a card in a body or a call: a `<kind>Id` for each kind given, each optional.
export const cardIdsOf = (kinds: readonly string[]) => z.object(Object.fromEntries(kinds.map((kind) => [`${kind}Id`, z.string().optional()])));

// A call names exactly one canvas: the board context's, a page's, or a card's of one of these kinds (an MCP call's `<kind>_id` arguments, read by the tool).
export function namesOneCanvas(ref: object, kinds: readonly string[]): boolean {
  const named = ref as Record<string, unknown>;
  return [named.boardId, named.pageId, ...kinds.map((kind) => named[`${kind}Id`])].filter(Boolean).length === 1;
}

// The refusal, in the words agents are told, naming the kinds of card there are to name one by.
export function oneCanvasWords(kinds: readonly string[]): string {
  const names = ['board_id (board context)', ...kinds.map((kind) => `${kind}_id`), 'page_id (a Sketchbook page)'];
  return `Pass exactly one of ${names.slice(0, -1).join(', ')} or ${names.at(-1)}.`;
}

// The canvas a body names: the board's, a page's or a card's, exactly one. `base` is the schema of the rest of the body, whose
// own fields (`groupId`) are not canvases. The ids of the kinds of card a Store keeps are checked as strings; an id of a kind
// it keeps none of still counts as the canvas named, and is left for the Store to answer as it does for any card it has not
// (store/repository.ts locate: `No decision with id "d1".`), not read as the board's.
export function canvasBody(kinds: readonly string[], base: { shape: object }) {
  const own = new Set(Object.keys(base.shape));
  const named = (body: Record<string, unknown>) => Object.entries(body).filter(([key, id]) => key.endsWith('Id') && !own.has(key) && typeof id === 'string' && id !== '');
  return z
    .looseObject({ boardId: z.string().optional(), pageId: z.string().optional(), ...cardIdsOf(kinds).shape })
    .refine((body) => named(body).length === 1, { error: oneCanvasWords(kinds) })
    .transform((body) => Object.fromEntries(named(body)) as Record<string, string>);
}

export const newGroup = z.object({
  title: fields.groupTitle,
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
});

export const move = z.object({
  id: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number().optional(),
  h: z.number().optional(),
  groupId: z.string().nullable().optional(), // blocks only; positions are relative to the group
});
