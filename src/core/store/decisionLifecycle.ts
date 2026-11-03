import { archive, guardHumanSettled, guardRetired } from './decisionRules';
import { BoardError } from './errors';
import type { ResolveInput } from './inputs';
import { label } from './labels';
import { answerAsks } from './people';
import type { BoardRepository } from './repository';
import { LIMITS, guardArchived, limited, optional, optionalLimited, required } from './validate';
import { clip, describeChoice, listNames } from '../format';
import type { Actor, Board, Decision } from '../types';

// A decision's answer: deciding, exploring, deferring, retiring and reopening it, and the work that goes stale when it changes.
export class DecisionLifecycle {
  constructor(private readonly repo: BoardRepository) {}

  // A person sets a card aside as no longer relevant. It leaves Open without
  // counting as decided, and work built on it goes stale. Reopening brings it back.
  retire(decisionId: string, reason: string | undefined, actor: Actor): Decision {
    if (actor.kind !== 'human') {
      throw new BoardError('Only people retire a decision. If it looks no longer relevant, say so in a comment.');
    }
    const { board, decision } = this.repo.getDecision(decisionId);
    guardArchived(board);
    if (decision.status === 'retired') throw new BoardError(`${label(decision)} is already retired.`);
    const why = limited(required(reason, 'reason'), LIMITS.note, 'A reason');
    const now = new Date().toISOString();
    archive(decision, actor, now, 'retired');
    decision.status = 'retired';
    decision.retirement = { text: why, by: actor, at: now };
    decision.resolution = undefined;
    decision.exploreRequest = undefined;
    decision.deferral = undefined;
    decision.planRequest = undefined;
    decision.refreshRequest = undefined;
    decision.updatedAt = now;
    const answering = answerAsks(decision, actor, now);
    this.repo.record(board, actor, 'decision_retired', `retired ${label(decision)} as no longer relevant: "${clip(why, 160)}"${answering}`, decision.id);
    this.markStale(board, decision, actor, `retired by ${actor.name} as no longer relevant`);
    return decision;
  }

  resolve(decisionId: string, input: ResolveInput, actor: Actor): Decision {
    const { board, decision } = this.repo.getDecision(decisionId);
    guardArchived(board);
    const answer = optional(input.answer);
    const rationale = optionalLimited(input.rationale, LIMITS.rationale, 'A rationale');
    if (!input.optionId === !answer) throw new BoardError('Provide exactly one of optionId or answer.');
    const picked = input.optionId ? decision.options.find((o) => o.id === input.optionId) : undefined;
    if (input.optionId && !picked) {
      throw new BoardError(`${label(decision)} has no option "${input.optionId}".`);
    }
    guardHumanSettled(decision, actor, 'answer it');
    guardRetired(decision, 'deciding it');
    if (picked?.outdated) {
      const why = picked.outdated.reason ? ` ("${clip(picked.outdated.reason, 120)}")` : '';
      throw new BoardError(
        `Option ${picked.id}) of ${label(decision)} is outdated${why}, so it can't be picked. Pick another, bring it back first, or answer in your own words.`,
      );
    }

    const now = new Date().toISOString();
    const standing = decision.status === 'decided' || decision.status === 'provisional' ? decision.resolution : undefined;
    const sameAnswer = standing?.optionId === input.optionId && (standing?.answer ?? undefined) === answer;
    const confirms =
      decision.status === 'provisional' &&
      !input.provisional &&
      decision.resolution?.optionId === input.optionId &&
      (decision.resolution?.answer ?? undefined) === answer;
    archive(decision, actor, now, confirms ? 'confirmed' : 'replaced');
    decision.resolution = {
      optionId: input.optionId,
      answer,
      rationale,
      by: actor,
      at: now,
    };
    decision.status = input.provisional ? 'provisional' : 'decided';
    decision.exploreRequest = undefined;
    decision.deferral = undefined;
    decision.refreshRequest = undefined;
    decision.updatedAt = now;
    const answering = answerAsks(decision, actor, now);

    const verb = input.provisional ? 'provisionally decided' : 'decided';
    const why = decision.resolution.rationale ? ` because "${clip(decision.resolution.rationale, 160)}"` : '';
    const summary = `${verb} ${label(decision)} → ${describeChoice(decision)}${why}${answering}`;
    this.repo.record(board, actor, 'decision_resolved', summary, decision.id);
    if (!standing || !sameAnswer) this.markStale(board, decision, actor, `re-decided by ${actor.name} → ${describeChoice(decision)}`);
    return decision;
  }

  requestExploration(decisionId: string, note: string | undefined, actor: Actor): Decision {
    const { board, decision } = this.repo.getDecision(decisionId);
    guardArchived(board);
    guardRetired(decision, 'exploring it');
    const text = optionalLimited(note, LIMITS.longNote, 'A note');
    const now = new Date().toISOString();
    archive(decision, actor, now, 'explore');
    decision.status = 'exploring';
    decision.exploreRequest = { text, by: actor, at: now };
    decision.resolution = undefined;
    decision.deferral = undefined;
    decision.planRequest = undefined;
    decision.updatedAt = now;
    const ask = decision.exploreRequest.text ? `: "${clip(decision.exploreRequest.text, 160)}"` : '';
    const answering = answerAsks(decision, actor, now);
    this.repo.record(board, actor, 'exploration_requested', `asked for exploration of ${label(decision)}${ask}${answering}`, decision.id);
    this.markStale(board, decision, actor, `sent back to explore by ${actor.name}`);
    return decision;
  }

  defer(decisionId: string, note: string | undefined, actor: Actor): Decision {
    const { board, decision } = this.repo.getDecision(decisionId);
    guardArchived(board);
    guardRetired(decision, 'deferring it');
    const text = optionalLimited(note, LIMITS.longNote, 'A note');
    const now = new Date().toISOString();
    archive(decision, actor, now, 'deferred');
    decision.status = 'deferred';
    decision.deferral = { text, by: actor, at: now };
    decision.resolution = undefined;
    decision.exploreRequest = undefined;
    decision.planRequest = undefined;
    decision.refreshRequest = undefined;
    decision.updatedAt = now;
    const why = decision.deferral.text ? `: "${clip(decision.deferral.text, 160)}"` : '';
    const answering = answerAsks(decision, actor, now);
    this.repo.record(board, actor, 'decision_deferred', `deferred ${label(decision)}${why}${answering}`, decision.id);
    this.markStale(board, decision, actor, `deferred by ${actor.name}`);
    return decision;
  }

  reopen(decisionId: string, actor: Actor): Decision {
    const { board, decision } = this.repo.getDecision(decisionId);
    guardArchived(board);
    if (decision.status === 'open') throw new BoardError(`${label(decision)} is already open.`);
    const retired = decision.status === 'retired';
    archive(decision, actor, new Date().toISOString(), 'reopened');
    decision.status = 'open';
    decision.resolution = undefined;
    decision.exploreRequest = undefined;
    decision.deferral = undefined;
    decision.planRequest = undefined;
    decision.retirement = undefined;
    decision.updatedAt = new Date().toISOString();
    const what = retired ? `brought back ${label(decision)}, which was retired` : `reopened ${label(decision)}`;
    this.repo.record(board, actor, 'decision_reopened', what, decision.id);
    this.markStale(board, decision, actor, retired ? `brought back by ${actor.name}` : `reopened by ${actor.name}`);
    return decision;
  }

  // Work built on a decision whose answer changed can't be trusted until
  // someone re-checks it, done work included.
  private markStale(board: Board, decision: Decision, actor: Actor, how: string): void {
    const affected = board.tasks.filter((t) => t.decisionIds.includes(decision.id));
    if (affected.length === 0) return;
    const at = new Date().toISOString();
    for (const task of affected) {
      task.stale = { decisionId: decision.id, reason: `#${decision.number} was ${how}`, at };
      task.updatedAt = at;
    }
    const names = affected.map((t) => `T${t.number}`);
    this.repo.alsoSave(board, { taskIds: affected.map((t) => t.id) });
    this.repo.record(board, actor, 'tasks_stale', `marked ${listNames(names)} stale: ${label(decision)} was ${how}`, decision.id);
  }
}
