// What people send about blocks (the REST bodies), put together from the
// kinds: the content of a block they add, and the fields of a change.

import { z } from 'zod';
import type { Shape } from './kind';
import { kinds } from './registry';
import type { BlockContent } from '../store/inputs';

// The content of a block people add: one object for each kind people can add.
export function createContent(): z.ZodType<BlockContent> {
  const objects = kinds().flatMap((kind) => (kind.people?.create ? [kind.people.create] : []));
  const types = kinds().flatMap((kind) => (kind.people?.create ? [kind.type] : []));
  const union = z.discriminatedUnion('type', objects as [(typeof objects)[number], ...typeof objects], {
    error: `A block's type is one of: ${types.join(', ')}.`,
  });
  return union as unknown as z.ZodType<BlockContent>; // the kinds' own types make up BlockContent
}

// The fields a change by a person may name; a field more than one kind reads
// takes what any of them takes.
export function patchFields(): Shape {
  const shape: Shape = {};
  for (const kind of kinds()) {
    for (const [name, schema] of Object.entries(kind.people?.patch ?? {})) {
      shape[name] = shape[name] && shape[name] !== schema ? z.union([shape[name], schema]) : schema;
    }
  }
  return shape;
}
