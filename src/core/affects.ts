// What a decision could affect: the other decisions on its board it may
// change, or rests on, so whoever decides it has them at hand. People see them
// in the "Could affect" list on its panel, agents in get_decision.
//
// Agents name the ones they know matter, each with why (affects on
// post_decision and update_decision); those always show. Tricot finds the rest
// itself, the same way every time:
// - the decisions it depends on, and those that depend on it (always shown);
// - decisions a task implements together with it;
// - decisions in the same area;
// - decisions worded closely like it, through the search's matching (search.ts).
// Found ones are past decisions only (decided, provisional or deferred), the
// strongest reasons first, up to COULD_AFFECT_CAP in all, and a faint
// likeness of wording on its own is dropped.
//
// Once a person answers the decision, the listed ones settled before it may
// no longer hold: mayChange says which to offer to revisit, and revisitGroups
// which of those are likely (linked on purpose or through a task) and which
// only share an area or wording. Whether an answer contradicts another can't
// be known, so it is offered as "may change", and revisiting is asking agents
// to re-check them (a refresh each, asked together), never changing them.

import { describeChoice, listNames, samePerson } from './format';
import { similarDecisions } from './search';
import type { Actor, Board, Decision, Status, Task } from './types';

export const COULD_AFFECT_CAP = 6;
// How closely a decision must be worded like this one to be listed for that
// alone: a key word in both questions and another anywhere on it, say (search.ts).
export const MIN_WORDING = 3;

export type AffectReason =
  | { kind: 'named'; why: string; by: Actor } // an agent named it
  | { kind: 'neededBy' } // it depends on this one
  | { kind: 'dependsOn' } // this one depends on it
  | { kind: 'sharedTask'; tasks: Task[] } // a task implements both
  | { kind: 'area'; area: string }
  | { kind: 'wording'; score: number };

export interface Affected {
  decision: Decision;
  reasons: AffectReason[]; // the strongest first
  strength: number;
  tasks: Task[]; // the work built on it, but dropped tasks
}

// How strong each reason is. Several reasons add a little each beyond the
// strongest, and closer wording counts for more, up to a shared task's.
const WEIGHT: Record<AffectReason['kind'], number> = { named: 100, neededBy: 60, dependsOn: 50, sharedTask: 40, area: 20, wording: 15 };
const EXTRA_REASON = 5;

function weight(reason: AffectReason): number {
  return reason.kind === 'wording' ? WEIGHT.wording + Math.min(reason.score, 10) : WEIGHT[reason.kind];
}

// Linked on purpose, by an agent or a dependency: always listed, whatever its status.
const explicit = (affected: Affected) => affected.reasons.some((r) => r.kind === 'named' || r.kind === 'neededBy' || r.kind === 'dependsOn');

// What Tricot finds on its own is past decisions: settled, or parked.
const PAST: ReadonlySet<Status> = new Set<Status>(['decided', 'provisional', 'deferred']);

const byNumber = <T extends { number: number }>(a: T, b: T) => a.number - b.number;

export function builtOn(board: Board, decision: Decision): Task[] {
  return board.tasks.filter((t) => t.status !== 'dropped' && t.decisionIds.includes(decision.id)).sort(byNumber);
}

export function couldAffect(board: Board, decision: Decision, cap = COULD_AFFECT_CAP): Affected[] {
  const found = new Map<string, AffectReason[]>();
  const add = (id: string, reason: AffectReason) => {
    if (id === decision.id) return;
    const reasons = found.get(id);
    if (!reasons) found.set(id, [reason]);
    else if (!reasons.some((r) => r.kind === reason.kind)) reasons.push(reason);
  };

  for (const named of decision.affects ?? []) add(named.decisionId, { kind: 'named', why: named.why, by: named.by });
  for (const other of board.decisions) if (other.dependsOn.includes(decision.id)) add(other.id, { kind: 'neededBy' });
  for (const id of decision.dependsOn) add(id, { kind: 'dependsOn' });

  const shared = new Map<string, Task[]>();
  for (const task of builtOn(board, decision)) {
    for (const id of task.decisionIds) if (id !== decision.id) shared.set(id, [...(shared.get(id) ?? []), task]);
  }
  for (const [id, tasks] of shared) add(id, { kind: 'sharedTask', tasks });

  const area = decision.area?.toLowerCase();
  if (area) for (const other of board.decisions) if (other.area?.toLowerCase() === area) add(other.id, { kind: 'area', area: decision.area! });

  for (const [id, score] of similarDecisions(board, decision)) if (score >= MIN_WORDING) add(id, { kind: 'wording', score });

  const decisions = new Map(board.decisions.map((d) => [d.id, d]));
  const listed: Affected[] = [];
  for (const [id, reasons] of found) {
    const other = decisions.get(id);
    if (!other) continue; // a decision since deleted
    reasons.sort((a, b) => weight(b) - weight(a));
    const affected = { decision: other, reasons, strength: weight(reasons[0]) + EXTRA_REASON * (reasons.length - 1), tasks: builtOn(board, other) };
    if (explicit(affected) || PAST.has(other.status)) listed.push(affected);
  }
  const order = (a: Affected, b: Affected) => b.strength - a.strength || b.decision.number - a.decision.number;
  const always = listed.filter(explicit);
  const inferred = listed.filter((a) => !explicit(a)).sort(order).slice(0, Math.max(0, cap - always.length));
  return [...always, ...inferred].sort(order);
}

// ---- in words -----------------------------------------------------------------

const refs = (tasks: Task[], max = 3) => {
  const names = tasks.map((t) => `T${t.number}`);
  return names.length <= max ? listNames(names) : `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
};

// Why a decision is listed, in a few words: "same area: Shipping", "shares T91".
export function reasonWords(reason: AffectReason): string {
  switch (reason.kind) {
    case 'named':
      return reason.why;
    case 'neededBy':
      return 'depends on this';
    case 'dependsOn':
      return 'this depends on it';
    case 'sharedTask':
      return `shares ${refs(reason.tasks)}`;
    case 'area':
      return `same area: ${reason.area}`;
    case 'wording':
      return 'similar wording';
  }
}

// Where a listed decision stands: its answer, or its status when it has none
// standing. "b) Per seat", "for now b) Per seat", "deferred".
export function standingWords(decision: Decision): string {
  if (decision.status === 'decided' && decision.resolution) return describeChoice(decision);
  if (decision.status === 'provisional' && decision.resolution) return `for now ${describeChoice(decision)}`;
  return decision.status;
}

// ---- revisiting ---------------------------------------------------------------

const settled = (decision: Decision) => (decision.status === 'decided' || decision.status === 'provisional') && Boolean(decision.resolution);

// How long after answering a person is offered to revisit what it may change:
// it follows the answer, rather than greeting whoever opens an old card.
export const REVISIT_HOURS = 24;

// The listed decisions a person's answer may change, to offer to revisit:
// those already settled before the answer, and not since asked about or
// re-checked. Decisions it only rests on (it depends on them) are left out,
// unless an agent named them: an answer builds on those rather than changing
// them. None while the decision has no answer of a person's standing, once
// the answer is older than REVISIT_HOURS, or for anyone but who gave it
// (`viewer`, when given).
export function mayChange(decision: Decision, listed: Affected[], viewer?: string, now = Date.now()): Affected[] {
  const answer = decision.resolution;
  if (!settled(decision) || !answer || answer.by.kind !== 'human') return [];
  if (viewer !== undefined && !samePerson(answer.by.name, viewer)) return [];
  if (now - Date.parse(answer.at) > REVISIT_HOURS * 3_600_000) return [];
  return listed.filter(({ decision: other, reasons }) => {
    if (!settled(other) || other.resolution!.at >= answer.at) return false;
    if (other.refreshRequest) return false;
    if (other.refreshed && other.refreshed.at >= answer.at) return false;
    const named = reasons.some((r) => r.kind === 'named');
    return named || !reasons.some((r) => r.kind === 'dependsOn');
  });
}

// Linked to it on purpose or through the work: an agent named it, a
// dependency, or a task builds on both. A likeness of area or wording alone
// may be chance.
const LINKED: ReadonlySet<AffectReason['kind']> = new Set<AffectReason['kind']>(['named', 'neededBy', 'dependsOn', 'sharedTask']);
export const isLikely = (affected: Affected) => affected.reasons.some((r) => LINKED.has(r.kind));

// The decisions offered to revisit, as the prompt groups them: the likely
// ones, which start ticked, and those only in the same area or worded alike,
// which start unticked. Each keeps the order it was listed in.
export function revisitGroups(offered: Affected[]): { likely: Affected[]; lessLikely: Affected[] } {
  return { likely: offered.filter(isLikely), lessLikely: offered.filter((a) => !isLikely(a)) };
}

// Why the prompt lists a decision, in a small line under it: "a task builds
// on both", "same area", "similar wording", or the agent's own words.
export function revisitWhy(reason: AffectReason): string {
  switch (reason.kind) {
    case 'sharedTask':
      return reason.tasks.length === 1 ? 'a task builds on both' : `${reason.tasks.length} tasks build on both`;
    case 'area':
      return 'same area';
    default:
      return reasonWords(reason);
  }
}

// What the refresh asked for a decision to revisit says, for the agents who re-check it.
export function revisitNote(decision: Decision): string {
  const verb = decision.status === 'provisional' ? 'decided for now' : 'decided';
  return `#${decision.number} was just ${verb}: ${describeChoice(decision)}. It may change this one: check it still holds.`;
}

// ---- for agents ---------------------------------------------------------------

// The "Could affect" section of get_decision: each with its id, where it
// stands, the work built on it, and why it is listed.
export function couldAffectLines(listed: Affected[]): string[] {
  if (listed.length === 0) return [];
  const lines = listed.map(({ decision, reasons, tasks }) => {
    const built = tasks.length ? `; ${refs(tasks)} ${tasks.length === 1 ? 'builds' : 'build'} on it` : '';
    const why = reasons.map((r) => (r.kind === 'named' ? `${r.by.name}: "${r.why}"` : reasonWords(r))).join('; ');
    const stands = settled(decision) ? `${decision.status}: ${describeChoice(decision)}` : decision.status;
    return `- #${decision.number} [id: ${decision.id}] ${decision.question} (${stands}${built}) — ${why}`;
  });
  return [
    '',
    '## Could affect',
    'Other decisions this one may change or rests on: weigh them when you recommend, and name any others with affects (update_decision).',
    ...lines,
  ];
}
