// Which fields of a change a kind of block takes, and what a block is told
// when a change names one it doesn't.

import type { AnyKind } from './kind';
import { PATCH_FIELDS, ordered } from './order';
import { kinds } from './registry';

// Fields that go together, said together: a note has no "columns or rows".
const SAID_TOGETHER: Record<string, string[]> = {
  columns: ['columns', 'rows'],
  rows: ['columns', 'rows'],
  unit: ['unit', 'subtitle', 'highlight'],
  subtitle: ['unit', 'subtitle', 'highlight'],
};

const or = (names: string[]) => (names.length <= 2 ? names.join(' or ') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`);

// The field of `patch` that blocks of `kind` don't have, as they are told it
// ("columns or rows"), or none when they take every field it names.
export function refusedField(kind: AnyKind, patch: object): string | undefined {
  const named = patch as Record<string, unknown>;
  const known = [...new Set(kinds().flatMap((k) => k.patchFields))];
  const takes = new Set(kind.patchFields);
  const field = ordered(known, PATCH_FIELDS, (name) => name).find((name) => named[name] !== undefined && !takes.has(name));
  if (field === undefined) return undefined;
  const together = SAID_TOGETHER[field];
  return together ? or(together.filter((name) => !takes.has(name))) : field;
}
