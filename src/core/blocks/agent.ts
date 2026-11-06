// What agents are told about blocks, put together from the kinds: the type
// they may name, the fields each kind reads in add_block, update_block and the
// pin tool, and the sentences about each kind in the tools' descriptions.
// What is said about one kind is said by that kind (kind.agent).

import type { z } from 'zod';
import type { AnyKind, Shape } from './kind';
import { ADD_FIELDS, AGENT_KINDS, DOC_KINDS, PIN_FIELDS, UPDATE_FIELDS, UPDATE_SPECIALS, ordered } from './order';
import { kinds } from './registry';

const byType = (kind: AnyKind) => kind.type;

// The kinds as agents list them.
function listed(): AnyKind[] {
  return ordered(kinds(), AGENT_KINDS, byType);
}

// The types add_block takes: each kind's, and those a kind still answers to.
export function agentTypes(): [string, ...string[]] {
  const types = listed().flatMap((kind) => [kind.type, ...(kind.agent.aliases ?? [])]);
  return ordered(types, AGENT_KINDS, (type) => type) as [string, ...string[]];
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
    shape[name] = said.length > 0 ? schema.describe(said.join('. ')) : schema;
  }
  return shape;
}

export const addFields = () => mergedShape((kind) => kind.agent.addShape, ADD_FIELDS);
export const updateFields = () => mergedShape((kind) => kind.agent.updateShape, UPDATE_FIELDS);
export const pinFields = () => mergedShape((kind) => kind.agent.pinShape, PIN_FIELDS);

const docOrder = () => ordered(kinds(), DOC_KINDS, byType);

// "Fields by type: note → text (Markdown); …", one entry from each kind, in
// full for the guide (read_guide), or in brief for add_block's description.
export function fieldsByType(brief = false): string {
  return `Fields by type: ${docOrder().map((kind) => (brief ? kind.agent.docs.brief : kind.agent.docs.add)).join('; ')}.`;
}

// Advice some kinds add after those entries in the guide.
export const guideSentences = (): string[] => docOrder().flatMap((kind) => (kind.agent.docs.guide ? [kind.agent.docs.guide] : []));
export const moreSentences = (): string[] => docOrder().flatMap((kind) => (kind.agent.docs.more ? [kind.agent.docs.more] : []));

// What update_block lists as a block's content fields: those each kind reads, then a clause for the kinds that need one.
export function contentFields(): string {
  const row = listed().flatMap((kind) => (kind.agent.docs.update ? [kind.agent.docs.update] : []));
  const clauses = ordered(kinds(), UPDATE_SPECIALS, byType).flatMap((kind) => (kind.agent.docs.updateSpecial ? [kind.agent.docs.updateSpecial] : []));
  return `${row.join(', ')}, and ${clauses.join('; ')}`;
}
