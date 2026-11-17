// What agents are told about blocks, put together from the kinds: the type
// they may name, the fields each kind reads in add_block, update_block and the
// pin tool, and the sentences about each kind in the tools' descriptions.
// What is said about one kind is said by that kind (kind.agent).

import type { z } from 'zod';
import type { AnyKind, Shape } from './kind';
import { plain, type Piece, type Words } from '../words';
import { ADD_FIELDS, AGENT_KINDS, DOC_KINDS, PIN_FIELDS, UPDATE_FIELDS, UPDATE_SPECIALS, ordered } from './order';
import { kinds } from './registry';

const byType = (kind: AnyKind) => kind.type;

// The kinds a call reads: the registry's, and any `extra` a caller names that is not registered yet (a part's own schemas are
// made where its module loads, before its Store registers its kinds).
const withExtra = (extra: readonly AnyKind[]): readonly AnyKind[] => {
  const listed = kinds();
  const more = extra.filter((kind) => !listed.some((other) => other.type === kind.type));
  return more.length ? [...listed, ...more] : listed;
};

// A core listing of types with each kind a part adds put after the kind it says it follows there, or last.
const placed = (list: readonly string[], where: 'types' | 'docs', among: readonly AnyKind[]): string[] =>
  among.reduce<string[]>((order, kind) => {
    const follows = kind.follows?.[where];
    if (follows === undefined || order.includes(kind.type)) return order;
    const at = order.indexOf(follows);
    order.splice(at === -1 ? order.length : at + 1, 0, kind.type);
    return order;
  }, [...list]);

// Whether a server offers what a kind needs agents to be offered (`offeredBy`): the core's own says none.
export type Offers = (what: string) => boolean;
const offersNone: Offers = () => false;
const told = (kind: AnyKind, offers: Offers): boolean => kind.agent.offeredBy === undefined || offers(kind.agent.offeredBy);

// The kinds as agents list them, with those a group has to offer left out where it offers none.
function listed(offers: Offers = offersNone, extra: readonly AnyKind[] = []): AnyKind[] {
  const among = withExtra(extra);
  return ordered(among, placed(AGENT_KINDS, 'types', among), byType).filter((kind) => told(kind, offers));
}

// The types add_block takes: each kind's, and those a kind still answers to.
export function agentTypes(offers: Offers = offersNone, extra: readonly AnyKind[] = []): [string, ...string[]] {
  const types = listed(offers, extra).flatMap((kind) => [kind.type, ...(kind.agent.aliases ?? [])]);
  return ordered(types, placed(AGENT_KINDS, 'types', withExtra(extra)), (type) => type) as [string, ...string[]];
}

// The kind that makes a block of the type an agent named: its own, or the one it is now part of.
export function agentKind(type: unknown): AnyKind | undefined {
  return kinds().find((kind) => kind.type === type) ?? kinds().find((kind) => kind.agent.aliases?.includes(type as string));
}

// The fields of several kinds as one shape. A field more than one kind reads
// keeps the first's schema, and says what each says of it.
export function mergedShape(pick: (kind: AnyKind) => Shape | undefined, order: readonly string[]): Shape {
  const merged: Record<string, { schema: z.ZodType; said: string[] }> = {};
  for (const kind of listed()) {
    for (const [name, schema] of Object.entries(pick(kind) ?? {})) {
      const said = schema.description ? [schema.description] : [];
      if (merged[name]) merged[name].said.push(...said);
      else merged[name] = { schema, said };
    }
  }
  const shape: Shape = {};
  for (const [name, { schema, said }] of ordered(Object.entries(merged), order, ([name]) => name)) {
    shape[name] = said.length > 1 ? schema.describe(said.join('. ')) : schema; // one description stays the schema it was made with, which tool groups look up by it
  }
  return shape;
}

export const addFields = () => mergedShape((kind) => kind.agent.addShape, ADD_FIELDS);
export const updateFields = () => mergedShape((kind) => kind.agent.updateShape, UPDATE_FIELDS);
export const pinFields = () => mergedShape((kind) => kind.agent.pinShape, PIN_FIELDS);

const docOrder = (offers: Offers = offersNone) => ordered(kinds(), placed(DOC_KINDS, 'docs', kinds()), byType).filter((kind) => told(kind, offers));

// "Fields by type: note → text (Markdown); …", one entry from each kind, in
// full for the guide (read_guide), or in brief for add_block's description,
// in pieces: a tool group may add to an entry (core/words.ts).
export function fieldsWords(brief = false, offers: Offers = offersNone): Piece[] {
  const entry = (kind: AnyKind): Piece[] => {
    const words: Words = brief ? kind.agent.docs.brief : kind.agent.docs.add;
    return typeof words === 'string' ? [[kind.type, words]] : [...words];
  };
  return [['fields', 'Fields by type: '], ...docOrder(offers).flatMap((kind, at): Piece[] => [...(at > 0 ? [[`${kind.type}-next`, '; '] as Piece] : []), ...entry(kind)]), ['fields-end', '.']];
}

export const fieldsByType = (brief = false, offers: Offers = offersNone): string => plain(fieldsWords(brief, offers));

// Advice some kinds add after those entries in the guide.
export const guideSentences = (): string[] => docOrder().flatMap((kind) => (kind.agent.docs.guide ? [kind.agent.docs.guide] : []));
export const moreSentences = (): string[] => docOrder().flatMap((kind) => (kind.agent.docs.more ? [kind.agent.docs.more] : []));

// What update_block lists as a block's content fields: those each kind reads, then a clause for the kinds that need one.
export function contentFields(): string {
  const row = listed().flatMap((kind) => (kind.agent.docs.update ? [kind.agent.docs.update] : []));
  const clauses = ordered(kinds(), UPDATE_SPECIALS, byType).flatMap((kind) => (kind.agent.docs.updateSpecial ? [kind.agent.docs.updateSpecial] : []));
  return `${row.join(', ')}, and ${clauses.join('; ')}`;
}
