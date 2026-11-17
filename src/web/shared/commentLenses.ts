import { LENSES } from '../../core/threads';
import { lensTone } from './lensTone';
import type { LensChoice } from './mentions';

// What ^ offers in a comment, where there is no thread lens to go back to:
// Tricot's lenses, General ticked, each in its tint with its brief.
const NO_LENS = 'No lens: agents answer as they see fit.';
export const COMMENT_LENSES: readonly LensChoice[] = LENSES.map(({ name, brief }) => ({
  name,
  brief: brief ?? NO_LENS,
  tone: lensTone({ name }),
  ...(name === 'General' && { current: true }),
}));
