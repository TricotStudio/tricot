import { BoardError } from './errors';
import { clip } from '../format';
import { LIMITS } from '../schemas/limits';
import { mustNotBeEmpty, tooLong } from '../schemas/rules';
import type { Actor, Board } from '../types';

// The limits are the schemas': one set of numbers for every shell and the store.
export { LIMITS };

// 32 symbols without lookalikes (no l, o, 0, 1), so bytes map without bias.
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function randomId(length: number): string {
  let id = '';
  for (const byte of crypto.getRandomValues(new Uint8Array(length))) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return id;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

export function sameActor(a: Actor, b: Actor): boolean {
  return a.kind === b.kind && a.name === b.name;
}

export function required(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new BoardError(mustNotBeEmpty(field));
  return trimmed;
}

export function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function coord(value: number): number {
  if (!Number.isFinite(value)) throw new BoardError('Positions must be finite numbers.');
  return Math.round(Math.max(-100_000, Math.min(100_000, value)));
}

export function clampSize(w: number, h: number): { w: number; h: number } {
  if (!Number.isFinite(w) || !Number.isFinite(h)) throw new BoardError('Sizes must be finite numbers.');
  return { w: Math.round(Math.min(4000, Math.max(160, w))), h: Math.round(Math.min(4000, Math.max(90, h))) };
}

export function limited(value: string, max: number, field: string): string {
  if (value.length > max) throw new BoardError(tooLong(field, max));
  return value;
}

// A free text that may be left out or blank: none when it is, else trimmed and held to its limit.
export function optionalLimited(value: string | undefined, max: number, field: string): string | undefined {
  return value === undefined ? undefined : optional(limited(value, max, field));
}

export function commentText(body: string): string {
  return limited(required(body, 'comment'), LIMITS.comment, 'A comment');
}

// An archived board is kept as a record: it can be read, but nothing on it
// changes until a person unarchives it.
export function guardArchived(board: Board): void {
  if (!board.archived) return;
  throw new BoardError(
    `The board "${clip(board.title)}" was archived by ${board.archived.by.name}, so it is read-only. A person can unarchive it to make changes.`,
  );
}
