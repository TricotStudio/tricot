import { samePerson } from '../../core/format';
import { askable } from '../../core/lensCommand';
import { LENSES, presetLens } from '../../core/threads';
import type { MessageLens, ThreadLens } from '../../core/types';
import type { LensChoice } from '../shared/mentions';
import { lensTone } from './lensTone';

// What typing ^ in the chat bar offers (core/lensCommand.ts, shared/
// mentions.tsx): the presets, then the lens of one's own the thread has, if it
// has one that ^ can name (no space in it), each in its tint with its brief in
// a line; the thread's own lens is ticked, General when it has none. A pick is
// a lens for that message alone. Pure, so it reads without a page.

const GENERAL_BRIEF = 'No lens: agents answer as they see fit.';

export function lensChoices(thread: ThreadLens | undefined): LensChoice[] {
  const now = thread?.name ?? 'General';
  const own = thread && !presetLens(thread.name) && askable(thread.name) ? [{ name: thread.name, brief: thread.brief }] : [];
  return [...LENSES, ...own].map(({ name, brief }) => ({ name, brief: brief ?? GENERAL_BRIEF, tone: lensTone({ name }), ...(samePerson(name, now) && { current: true }) }));
}

// What a pick is kept as on the message: a preset by its name, the thread's
// own lens with its brief (it is a copy of what it was when sent). None for a
// name the choices don't have.
export function messageLensOf(name: string, thread: ThreadLens | undefined): MessageLens | undefined {
  const preset = presetLens(name);
  if (preset) return { name: preset.name };
  return thread?.brief && samePerson(thread.name, name) ? { name: thread.name, brief: thread.brief } : undefined;
}
