import { BoardError } from './errors';
import { label } from './labels';
import { LIMITS, limited } from './validate';
import { cleanArea, knownArea } from '../areas';
import { clip, samePerson } from '../format';
import type { Actor, Board, CardSnapshot, Decision, PastAnswer } from '../types';

export function optionLetter(index: number): string {
  if (index >= 26) throw new BoardError('A decision can have at most 26 options.');
  return String.fromCharCode(97 + index);
}

// A decision a human has settled (decided, or provisionally decided or
// deferred by a human) is theirs: agents may comment on it or post a new
// decision, but not change what the human answered.
export function guardHumanSettled(decision: Decision, actor: Actor, action: string): void {
  if (actor.kind !== 'agent') return;
  const settler =
    decision.status === 'decided' || decision.status === 'provisional'
      ? decision.resolution?.by
      : decision.status === 'deferred'
        ? decision.deferral?.by
        : decision.status === 'retired'
          ? decision.retirement?.by
          : undefined;
  if (settler?.kind !== 'human') return;
  const verb = { deferred: 'deferred', provisional: 'provisionally decided', retired: 'retired' }[decision.status as string] ?? 'decided';
  throw new BoardError(
    `${settler.name} ${verb} ${label(decision)}, so agents can't ${action}. Comment on it, or post a new decision if something has changed.`,
  );
}

// A retired card is set aside as no longer relevant: it is read, discussed and
// brought back, but not answered or changed while it is retired.
export function guardRetired(decision: Decision, action: string): void {
  if (decision.status !== 'retired') return;
  throw new BoardError(`${label(decision)} is retired as no longer relevant. Bring it back (reopen it) before ${action}.`);
}

// An area as stored: on one line, trimmed, limited, and spelled the way the
// board already spells it. Empty means none.
export function areaName(board: Board, value: string, except?: Decision): string | undefined {
  const area = limited(cleanArea(value), LIMITS.area, 'An area');
  return area ? (knownArea(board, area, except) ?? area) : undefined;
}

// A change of a decision's area, checked: null when it stays as it is. An
// area a person set is theirs, so agents can't change or clear it.
export function areaChange(board: Board, decision: Decision, value: string, actor: Actor): { area?: string } | null {
  const area = areaName(board, value, decision);
  const before = decision.area ?? '';
  if (actor.kind === 'agent' ? samePerson(area ?? '', before) : (area ?? '') === before) return null;
  const person = decision.areaPerson;
  if (actor.kind === 'agent' && person) {
    throw new BoardError(
      `${person.name} put ${label(decision)} in the area "${decision.area}", so agents can't change it. Leave it as it is, and suggest another area in a comment if one fits better.`,
    );
  }
  return { area };
}

export function snapshot(decision: Decision): CardSnapshot {
  return {
    question: decision.question,
    context: decision.context,
    options: decision.options.map((o) => ({ id: o.id, label: o.label, description: o.description, outdated: Boolean(o.outdated) })),
    recommendation: decision.recommendation?.optionId,
  };
}

// What changed on a card since a snapshot of it, briefly: "c outdated (global
// config was dropped)", "d added". The card and the agents' digest both show
// it after a refresh.
export function cardChanges(before: CardSnapshot, decision: Decision): string[] {
  const changes: string[] = [];
  if (decision.question !== before.question) changes.push('question reworded');
  if (decision.context !== before.context) changes.push('context updated');
  for (const option of decision.options) {
    const was = before.options.find((o) => o.id === option.id);
    if (!was) changes.push(`${option.id} added`);
    else if (option.outdated && !was.outdated) {
      changes.push(`${option.id} outdated${option.outdated.reason ? ` (${clip(option.outdated.reason, 80)})` : ''}`);
    } else if (!option.outdated && was.outdated) changes.push(`${option.id} brought back`);
    else if (option.label !== was.label || option.description !== was.description) changes.push(`${option.id} reworded`);
  }
  const recommended = decision.recommendation?.optionId;
  if (recommended !== before.recommendation) changes.push(recommended ? `recommends ${recommended}` : 'no recommendation');
  return changes;
}

// Moves the current answer into history before it is replaced or cleared.
export function archive(decision: Decision, actor: Actor, at: string, ended: PastAnswer['ended']): void {
  const { resolution, status } = decision;
  if (!resolution || (status !== 'decided' && status !== 'provisional')) return;
  const option = decision.options.find((o) => o.id === resolution.optionId);
  decision.history.push({ ...resolution, status, ended, endedBy: actor, endedAt: at, label: option?.label });
}
