// The Decisions tab as a reference table: which section each decision sits
// in and in what order, the approvals folded into one row, and what its
// Answer, Built on it and Decided cells say. Pure, so the view only draws it.
//
// Sections: what needs a call (open, exploring, provisional) first, then what
// was decided, newest first, then what was set aside (deferred, retired).

import type { Board, Decision, Status, Task } from './types';

// A yes-or-no call to commit finished work, asked the same way each time.
// Since T55 a task's own commit is approved in its review; these cards remain
// for older approvals and work that spans several tasks.
export function isApproval(decision: Pick<Decision, 'question'>): boolean {
  return /^commit\b/i.test(decision.question.trimStart());
}

export type SectionKey = 'call' | 'decided' | 'aside';

// What the filter chips show. Decided leaves out the approvals, which have a
// chip of their own; Approvals shows them all, whatever their status.
export type TableFilter = 'all' | 'call' | 'decided' | 'approvals';

export const SECTION_OF: Record<Status, SectionKey> = {
  open: 'call',
  exploring: 'call',
  provisional: 'call',
  decided: 'decided',
  deferred: 'aside',
  retired: 'aside',
};

const SECTIONS: SectionKey[] = ['call', 'decided', 'aside'];

export interface Section {
  key: SectionKey;
  rows: Decision[];
  // Decided approvals, folded into one row at the head of Decided under All;
  // newest first. Empty in every other case.
  approvals: Decision[];
}

export interface Table {
  sections: Section[]; // only those with something in them
  counts: Record<TableFilter, number>;
}

// When a decision got where it is: settled, set aside, or for an open one its
// last change. What "newest first" goes by.
export function settledAt(decision: Decision): string {
  switch (decision.status) {
    case 'decided':
    case 'provisional':
      return decision.resolution?.at ?? decision.updatedAt;
    case 'deferred':
      return decision.deferral?.at ?? decision.updatedAt;
    case 'retired':
      return decision.retirement?.at ?? decision.updatedAt;
    default:
      return decision.updatedAt;
  }
}

const newest = (a: Decision, b: Decision) => settledAt(b).localeCompare(settledAt(a)) || b.number - a.number;

// What waits on the viewer leads, then blocking questions, then the latest.
function byUrgency(needsYou: (d: Decision) => boolean) {
  return (a: Decision, b: Decision) =>
    Number(needsYou(b)) - Number(needsYou(a)) ||
    Number(b.blocking && b.status === 'open') - Number(a.blocking && a.status === 'open') ||
    b.updatedAt.localeCompare(a.updatedAt) ||
    b.number - a.number;
}

// Deferred before retired: a deferred question is still to come back to.
const asideOrder = (a: Decision, b: Decision) => Number(a.status === 'retired') - Number(b.status === 'retired') || newest(a, b);

export function buildTable(
  decisions: readonly Decision[],
  options: {
    filter: TableFilter;
    needsYou: (decision: Decision) => boolean;
    matches?: ReadonlySet<string> | null; // a search's matches; none or null: every decision
  },
): Table {
  const { filter, needsYou, matches } = options;
  const shown = matches ? decisions.filter((d) => matches.has(d.id)) : [...decisions];
  const counts: Record<TableFilter, number> = {
    all: shown.length,
    call: shown.filter((d) => SECTION_OF[d.status] === 'call').length,
    decided: shown.filter((d) => d.status === 'decided' && !isApproval(d)).length,
    approvals: shown.filter(isApproval).length,
  };
  const order: Record<SectionKey, (a: Decision, b: Decision) => number> = {
    call: byUrgency(needsYou),
    decided: newest,
    aside: asideOrder,
  };
  const sections: Section[] = [];
  for (const key of SECTIONS) {
    if (filter === 'call' && key !== 'call') continue;
    if (filter === 'decided' && key !== 'decided') continue;
    const inSection = shown.filter((d) => SECTION_OF[d.status] === key).sort(order[key]);
    let rows = inSection;
    let approvals: Decision[] = [];
    if (filter === 'approvals') rows = inSection.filter(isApproval);
    else if (key === 'decided') {
      rows = inSection.filter((d) => !isApproval(d));
      if (filter === 'all') approvals = inSection.filter(isApproval);
    }
    if (rows.length + approvals.length > 0) sections.push({ key, rows, approvals });
  }
  return { sections, counts };
}

// ---- cells ------------------------------------------------------------------

export type Answer =
  | { kind: 'chosen'; letter: string; label: string } // decided, or decided for now
  | { kind: 'recommended'; letter: string; label: string } // not yet decided: what an agent recommends
  | { kind: 'words'; text: string } // a person's own answer, in place of the options
  | { kind: 'none'; text: string; note?: string }; // nothing picked: why, and what was said

export function answerOf(decision: Decision): Answer {
  const { status, resolution } = decision;
  if (resolution && (status === 'decided' || status === 'provisional')) {
    const option = resolution.optionId ? decision.options.find((o) => o.id === resolution.optionId) : undefined;
    if (option) return { kind: 'chosen', letter: option.id, label: option.label };
    const words = resolution.answer?.replace(/\s+/g, ' ').trim();
    return words ? { kind: 'words', text: words } : { kind: 'none', text: 'no answer given' };
  }
  if (status === 'deferred') return { kind: 'none', text: 'deferred', note: decision.deferral?.text?.trim() || undefined };
  if (status === 'retired') return { kind: 'none', text: 'retired', note: decision.retirement?.text?.trim() || undefined };
  const recommended = decision.options.find((o) => o.id === decision.recommendation?.optionId && !o.outdated);
  if (recommended) return { kind: 'recommended', letter: recommended.id, label: recommended.label };
  if (status === 'exploring') return { kind: 'none', text: 'exploring' };
  const live = decision.options.filter((o) => !o.outdated).length;
  return { kind: 'none', text: live ? `${live} option${live === 1 ? '' : 's'}, none recommended` : 'no options yet' };
}

// The tasks built on a decision, by number, but those dropped. While it is
// still open or being explored, they wait on it: it holds them.
export function builtOn(board: Pick<Board, 'tasks'>, decision: Decision): { tasks: Task[]; holds: boolean } {
  const tasks = board.tasks.filter((t) => t.decisionIds.includes(decision.id) && t.status !== 'dropped').sort((a, b) => a.number - b.number);
  return { tasks, holds: decision.status === 'open' || decision.status === 'exploring' };
}

// ---- time -------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// A short time for a table cell, in local time: 14:06 today, then yesterday,
// then the date (Oct 27), with the year once it isn't this one.
export function shortDate(iso: string, now: number): string {
  const at = new Date(iso);
  const today = new Date(now);
  if (sameDay(at, today)) return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(at, yesterday)) return 'yesterday';
  const date = `${MONTHS[at.getMonth()]} ${at.getDate()}`;
  return at.getFullYear() === today.getFullYear() ? date : `${date}, ${at.getFullYear()}`;
}

// In full, for a tooltip: Oct 27, 2026 at 14:06.
export function fullDate(iso: string): string {
  const at = new Date(iso);
  return `${MONTHS[at.getMonth()]} ${at.getDate()}, ${at.getFullYear()} at ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

// How long something has been waiting: 5m, 18h, 3d, 5w. Null under a minute.
export function shortAge(iso: string, now: number): string | null {
  const minutes = Math.max(0, (now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return null;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 14) return `${Math.floor(days)}d`;
  return `${Math.floor(days / 7)}w`;
}

// Since when an open question has been waiting: posted, or last reopened.
function openSince(decision: Decision): string {
  return decision.history
    .filter((h) => h.ended === 'reopened')
    .reduce((latest, h) => (h.endedAt > latest ? h.endedAt : latest), decision.createdAt);
}

// The Decided cell: who settled it and when, or for a question still to
// decide, how long it has been waiting. `title` says it in full.
export function whenOf(decision: Decision, now: number): { text: string; title: string } {
  const by = (who: { name: string } | undefined, at: string, verb: string) => ({
    text: who ? `${who.name} · ${shortDate(at, now)}` : shortDate(at, now),
    title: `${verb}${who ? ` by ${who.name}` : ''}, ${fullDate(at)}`,
  });
  switch (decision.status) {
    case 'open': {
      const since = openSince(decision);
      const age = shortAge(since, now);
      return { text: age ? `waiting ${age}` : 'asked just now', title: `Waiting since ${fullDate(since)}` };
    }
    case 'exploring': {
      const since = decision.exploreRequest?.at ?? decision.updatedAt;
      return { text: `exploring ${shortAge(since, now) ?? 'now'}`, title: `Being explored since ${fullDate(since)}` };
    }
    case 'provisional': {
      const at = settledAt(decision);
      const who = decision.resolution?.by.name;
      return {
        text: `to confirm ${shortAge(at, now) ?? 'now'}`,
        title: `Decided for now${who ? ` by ${who}` : ''}, ${fullDate(at)}; waiting for a person to confirm it`,
      };
    }
    case 'decided':
      return by(decision.resolution?.by, settledAt(decision), 'Decided');
    case 'deferred':
      return by(decision.deferral?.by, settledAt(decision), 'Deferred');
    case 'retired':
      return by(decision.retirement?.by, settledAt(decision), 'Retired');
  }
}
