// The boards a person opened on this browser, the latest first, for the board
// switcher (switcher.tsx): those come first, the rest by their last activity.

const KEY = 'tricot:recent-boards';
export const KEPT = 50;

// The ids with `id` at the front. A renamed board's earlier ids go, so it's
// listed once under the id it has now.
export function withOpened(recent: string[], id: string, aliases: string[] = []): string[] {
  const gone = new Set([id, ...aliases]);
  return [id, ...recent.filter((r) => !gone.has(r))].slice(0, KEPT);
}

// Boards opened here first, the latest first, then the rest, the latest change first.
export function byRecent<T extends { id: string; updatedAt: string }>(boards: T[], recent: string[]): T[] {
  const rank = new Map(recent.map((id, i) => [id, i]));
  const at = (board: T) => rank.get(board.id) ?? recent.length;
  return [...boards].sort((a, b) => at(a) - at(b) || b.updatedAt.localeCompare(a.updatedAt));
}

// Boards whose title and goal hold every word typed, in their order, with
// titles that hold them all first.
export function matching<T extends { title: string; goal?: string }>(boards: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return boards;
  const has = (text: string) => words.every((word) => text.toLowerCase().includes(word));
  const found = boards.filter((b) => has(`${b.title}\n${b.goal ?? ''}`));
  return [...found.filter((b) => has(b.title)), ...found.filter((b) => !has(b.title))];
}

export function readRecent(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

// The list without a deleted board, under any of its ids.
export function without(recent: string[], ids: string[]): string[] {
  return recent.filter((id) => !ids.includes(id));
}

// Takes a deleted board out of the boards opened here.
export function forgetOpened(ids: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(without(readRecent(), ids)));
  } catch {
    // Not remembered; the switcher only lists boards that exist.
  }
}

export function noteOpened(id: string, aliases?: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(withOpened(readRecent(), id, aliases)));
  } catch {
    // Not remembered; the switcher orders this board by its last activity.
  }
}
