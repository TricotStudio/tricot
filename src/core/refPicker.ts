// Typing # in a composer to name a card: what is being typed after the #, and
// the board's cards that fit it, in the order the list shows them. Picking one
// writes T6 for a task or #6 for a decision, which refs.ts links. The list
// itself is web/mentions.tsx, beside the @ and / ones.

import type { RefKind } from './refs';
import type { Decision, Status, Task, TaskStatus } from './types';

// A card the list can offer: a task by its title, a decision by its question.
export interface PickableCard {
  kind: RefKind;
  number: number;
  title: string;
  status: TaskStatus | Status;
  updatedAt: string;
}

export function pickableCards(tasks: Iterable<Task>, decisions: Iterable<Decision>): PickableCard[] {
  return [
    ...[...tasks].map((t): PickableCard => ({ kind: 'task', number: t.number, title: t.title, status: t.status, updatedAt: t.updatedAt })),
    ...[...decisions].map((d): PickableCard => ({ kind: 'decision', number: d.number, title: d.question, status: d.status, updatedAt: d.updatedAt })),
  ];
}

// The #word just before the caret: a # that starts a word (not issue#3, a
// link's page#part or path/#3, an entity's &#32;, or ##), then letters and
// digits. A # alone at the start of a line is where a heading starts, so
// there it waits for the next letter: "# Title" never opens the list.
const TYPING = /(?:^|[^\p{L}\p{N}_.&#/@-])#([\p{L}\p{N}_-]{0,40})$/u;

export function readCardQuery(before: string): { at: number; query: string } | null {
  const match = before.match(TYPING);
  if (!match) return null;
  const query = match[1];
  const at = before.length - query.length - 1;
  if (!query && /(?:^|\n)[ \t]*$/.test(before.slice(0, at))) return null;
  // Not a number running into letters (#32px, #1a1a18, #T5a), and not a
  // colour written in full (#ff0000, #a1b2c3).
  if (/^[Tt]?\d+[^\d]/.test(query)) return null;
  if (/^(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(query) && /\d/.test(query)) return null;
  return { at, query };
}

// Cards still in play before those done with (a done or dropped task, a
// decided, deferred or retired question), then the latest first.
const SETTLED = new Set<string>(['done', 'dropped', 'decided', 'deferred', 'retired']);
const byPlayThenRecent = (a: PickableCard, b: PickableCard) =>
  Number(SETTLED.has(a.status)) - Number(SETTLED.has(b.status)) || b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number;

// Whether a title has a word that starts with the query (0), has the query
// anywhere (1), or neither (null). Case doesn't matter.
function wordFit(title: string, query: string): 0 | 1 | null {
  const lower = title.toLowerCase();
  if (lower.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(query)) || lower.startsWith(query)) return 0;
  return lower.includes(query) ? 1 : null;
}

// The cards that fit what's typed after the #, tasks first, then decisions,
// at most `limit` (each kind keeps half of it when the other has as many).
// - nothing: every card.
// - T, or T and digits (case doesn't matter): tasks only; with digits, those
//   whose number starts with them, the exact one first.
// - digits: tasks and decisions whose number starts with them, then those
//   whose title has a word starting with them (Node 22 for #22).
// - a word: cards with a word in the title starting with it, then those with
//   it anywhere in the title.
// Within each, cards still in play first, then the latest.
export function pickCards(cards: PickableCard[], typed: string, limit = 20): PickableCard[] {
  const query = typed.toLowerCase();
  const taskNumber = query.match(/^t(\d*)$/);
  const digits = taskNumber ? taskNumber[1] : /^\d+$/.test(query) ? query : null;
  const kinds: RefKind[] = taskNumber ? ['task'] : ['task', 'decision'];

  // Each fitting card's rank: lower comes first.
  const rank = (card: PickableCard): number[] | null => {
    if (!kinds.includes(card.kind)) return null;
    if (digits === '') return [];
    if (digits !== null) {
      const number = String(card.number);
      if (number.startsWith(digits)) return [0, number.length, card.number];
      if (taskNumber) return null;
      const fit = wordFit(card.title, digits);
      return fit === 0 ? [1] : null;
    }
    const fit = wordFit(card.title, query);
    return fit === null ? null : [fit];
  };

  const ranked = cards
    .map((card) => ({ card, rank: rank(card) }))
    .filter((r): r is { card: PickableCard; rank: number[] } => r.rank !== null)
    .sort((a, b) => {
      for (let i = 0; i < Math.max(a.rank.length, b.rank.length); i++) {
        const step = (a.rank[i] ?? 0) - (b.rank[i] ?? 0);
        if (step) return step;
      }
      return byPlayThenRecent(a.card, b.card);
    })
    .map((r) => r.card);

  const tasks = ranked.filter((c) => c.kind === 'task');
  const decisions = ranked.filter((c) => c.kind === 'decision');
  const half = Math.ceil(limit / 2);
  const taskCount = Math.min(tasks.length, Math.max(half, limit - decisions.length));
  return [...tasks.slice(0, taskCount), ...decisions.slice(0, limit - taskCount)];
}
