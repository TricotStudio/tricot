// The lenses the Tricot tab's threads offer (threadsTab.ts takes the keys,
// threadsView.ts draws them), as the page's lens menu does (web/threads/
// lenses.tsx): the presets first (core/threads.ts LENSES), then the lenses of
// the person's own that threads on the board already have, then "New lens…",
// which asks for a name and a brief of one's own. The current lens is marked,
// and the agent a lens is routed to stays when another lens is picked, as it
// does on the page (who answers is not set from here).
import { samePerson } from '../../core/format';
import { LENSES, LENS_BRIEF_LIMIT, LENS_NAME_LIMIT, lensChoice, presetLens } from '../../core/threads';
import type { Thread, ThreadLens } from '../../core/types';
import type { LensRow } from './threadsView';

export const NEW_LENS = 'New lens…';

// The rows to pick from, the current lens marked.
export function lensRows(threads: readonly Thread[], current: ThreadLens | undefined): LensRow[] {
  const now = current?.name ?? 'General';
  const own: ThreadLens[] = [];
  const lenses = [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((t) => t.lens);
  for (const lens of [current, ...lenses]) {
    if (lens && !presetLens(lens.name) && !own.some((o) => samePerson(o.name, lens.name))) own.push(lens);
  }
  const row = ({ name, brief }: { name: string; brief?: string }): LensRow => ({ name, ...(brief && { brief }), current: samePerson(name, now) });
  return [...LENSES.map(row), ...own.map(row), { name: NEW_LENS, brief: 'A name and a brief of your own.', current: false, fresh: true }];
}

// What picking a row sets: the lens as the API takes it (null for General), still routed to the agent it was.
export function lensPicked(row: Pick<LensRow, 'name' | 'brief'>, current: ThreadLens | undefined): ThreadLens | null {
  return lensChoice(row.name, row.brief, current?.agent);
}

// What the two steps of a lens of one's own ask, and the most each takes.
export const OWN_STEPS = {
  name: { limit: LENS_NAME_LIMIT, help: 'Name it, e.g. Pricing.', placeholder: 'Name, e.g. Pricing' },
  brief: { limit: LENS_BRIEF_LIMIT, help: 'Say how agents should answer through it, in a sentence or two.', placeholder: 'How agents should answer, in a sentence or two' },
};
