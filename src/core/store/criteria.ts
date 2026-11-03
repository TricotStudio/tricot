import { guardHumanSettled } from './decisionRules';
import { BoardError } from './errors';
import type { NewCriterion } from './inputs';
import { label } from './labels';
import { answerAsks } from './people';
import type { BoardRepository } from './repository';
import { LIMITS, guardArchived, limited, optional, required } from './validate';
import { clip, samePerson } from '../format';
import type { Actor, Board, Criterion, Decision, MarkValue } from '../types';

// A decision's criteria, and the marks people give each option against them.
export class Criteria {
  constructor(private readonly repo: BoardRepository) {}

  proposeCriteria(decisionId: string, inputs: NewCriterion[], actor: Actor): Decision {
    const { board, decision } = this.repo.getDecision(decisionId);
    guardArchived(board);
    guardHumanSettled(decision, actor, 'add criteria to it');
    const now = new Date().toISOString();
    this.addCriteria(board, decision, this.newCriteria(decision, inputs, actor, now), actor, now);
    return decision;
  }

  // The criteria to add, checked against those already on the decision. Throws
  // before anything changes.
  newCriteria(decision: Decision, inputs: NewCriterion[], actor: Actor, now: string): Criterion[] {
    const added: Criterion[] = [];
    let next = Math.max(0, ...decision.criteria.map((c) => Number(c.id.slice(1)) || 0)) + 1;
    for (const input of inputs) {
      const text = limited(required(input.label, 'criterion'), LIMITS.criterion, 'A criterion');
      if ([...decision.criteria, ...added].some((c) => samePerson(c.label, text))) continue;
      added.push({ id: `c${next++}`, label: text, description: optional(input.description), proposedBy: actor, createdAt: now });
    }
    if (added.length === 0) throw new BoardError('Those criteria are already on the decision.');
    if (decision.criteria.length + added.length > LIMITS.criteria) throw new BoardError(`A decision can have at most ${LIMITS.criteria} criteria.`);
    return added;
  }

  addCriteria(board: Board, decision: Decision, added: Criterion[], actor: Actor, now: string): void {
    decision.criteria.push(...added);
    decision.updatedAt = now;
    const verb = actor.kind === 'agent' ? 'proposed' : 'added';
    const labels = added.map((c) => `"${clip(c.label, 60)}"`).join(', ');
    this.repo.record(board, actor, 'criteria_changed', `${verb} criteria for ${label(decision)}: ${labels}`, decision.id);
  }

  removeCriterion(decisionId: string, criterionId: string, actor: Actor): Decision {
    if (actor.kind !== 'human') throw new BoardError('Only people remove criteria.');
    const { board, decision } = this.repo.getDecision(decisionId);
    guardArchived(board);
    const criterion = decision.criteria.find((c) => c.id === criterionId);
    if (!criterion) throw new BoardError(`${label(decision)} has no criterion "${criterionId}".`);
    decision.criteria = decision.criteria.filter((c) => c !== criterion);
    decision.marks = decision.marks.filter((m) => m.criterionId !== criterionId);
    decision.updatedAt = new Date().toISOString();
    this.repo.record(board, actor, 'criteria_changed', `removed criterion "${clip(criterion.label, 60)}" from ${label(decision)}`, decision.id);
    return decision;
  }

  // Marks are human judgement, so agents are refused outright.
  mark(decisionId: string, criterionId: string, optionId: string, value: MarkValue | null, actor: Actor): Decision {
    if (actor.kind !== 'human') {
      throw new BoardError('Only people mark criteria: a mark is a personal judgement. Attach findings with your evidence instead.');
    }
    const { board, decision } = this.repo.getDecision(decisionId);
    guardArchived(board);
    const criterion = decision.criteria.find((c) => c.id === criterionId);
    const option = decision.options.find((o) => o.id === optionId);
    if (!criterion) throw new BoardError(`${label(decision)} has no criterion "${criterionId}".`);
    if (!option) throw new BoardError(`${label(decision)} has no option "${optionId}".`);

    const existing = decision.marks.find((m) => m.criterionId === criterionId && m.optionId === optionId);
    if ((existing?.value ?? null) === value) return decision;
    const now = new Date().toISOString();
    decision.marks = decision.marks.filter((m) => m !== existing);
    if (value) decision.marks.push({ criterionId, optionId, value, by: actor, at: now });
    decision.updatedAt = now;
    const answering = answerAsks(decision, actor, now);

    const target = `${option.id}) ${clip(option.label, 40)}`;
    const summary = value
      ? `marked ${target} "${value}" on "${clip(criterion.label, 60)}" for ${label(decision)}${answering}`
      : `cleared the mark for ${target} on "${clip(criterion.label, 60)}" for ${label(decision)}`;
    this.repo.record(board, actor, 'criterion_marked', summary, decision.id);
    return decision;
  }
}
