import { presetLens } from '../../core/threads';
import type { ThreadLens } from '../../core/types';

// The class that tints a lens's chip (threads.css): each preset keeps its own,
// named after it; one of your own is plain. Pure, so the test that holds each
// preset to a tint of its own reads it without a page.
export function lensTone(lens: ThreadLens | undefined): string {
  const preset = presetLens(lens?.name ?? 'General');
  return `lens-${preset ? preset.name.toLowerCase() : 'own'}`;
}
