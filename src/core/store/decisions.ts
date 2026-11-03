import type { Blocks } from './blocks';
import type { Criteria } from './criteria';
import { areaChange, areaName, cardChanges, guardHumanSettled, guardRetired, optionLetter, snapshot } from './decisionRules';
import { BoardError } from './errors';
import type { DecisionPatch, Located, NewAffect, NewDecision, NewFinding, NewOption, OptionChange } from './inputs';
import { label } from './labels';
import { type People, answerAsks, askMentioned } from './people';
import type { BoardRepository } from './repository';
import { LIMITS, commentText, guardArchived, limited, optional, randomId, required } from './validate';
import { emptyCanvas } from '../canvas';
import { clip, describeChoice, optionPerson, samePerson } from '../format';
import { peopleIn } from '../mentions';
import type { Actor, Affect, Board, Comment, Decision, Finding, Option, Revision } from '../types';

// What a person can ask agents to refresh: an unanswered card's options, or
// whether a settled card's answer still holds.
const REFRESHED: Decision['status'][] = ['open', 'exploring', 'decided', 'provisional'];

// Decisions: posting, rewording, commenting, findings and refreshes. Settling one (answer, defer, retire,
// reopen) is DecisionLifecycle; criteria and marks are Criteria; asking people is People.
export class Decisions {
  constructor(
    private readonly repo: BoardRepository,
    private readonly blocks: Blocks,
    private readonly criteria: Criteria,
    private readonly people: People,
  ) {}

  postDecision(boardId: string, input: NewDecision, actor: Actor): Decision {
    const board = this.repo.getBoard(boardId);
    guardArchived(board);
    const now = new Date().toISOString();
    const id = this.repo.newDecisionId();
    const area = input.area === undefined ? undefined : areaName(board, input.area);

    const decision: Decision = {
      id,
      number: board.nextDecisionNumber,
      boardId: board.id,
      question: required(input.question, 'question'),
      context: optional(input.context),
      options: [],
      status: 'open',
      ...(area && { area, ...(actor.kind === 'human' && { areaPerson: actor }) }),
      blocking: input.blocking ?? false,
      dependsOn: [],
      comments: [],
      findings: [],
      history: [],
      asks: [],
      criteria: [],
      marks: [],
      canvas: emptyCanvas(),
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
    };
    this.appendOptions(decision, input.options ?? [], actor, now);
    if (input.recommend) this.setRecommendation(decision, input.recommend, input.recommendationReason, actor, now);
    if (input.dependsOn) decision.dependsOn = this.validDependencies(board, decision.id, input.dependsOn);
    const affects = input.affects ? this.validAffects(board, decision, input.affects, actor, now) : [];
    if (affects.length) decision.affects = affects;
    // Its canvas is filled before the decision joins the board, so a bad block
    // leaves nothing half-posted.
    const located: Located = { board, decision, canvas: decision.canvas };
    const placed = this.blocks.placeInline(located, input.blocks ?? [], actor);
    // Criteria and asks are checked now too, for the same reason.
    const criteria = input.criteria?.filter((c) => c.label?.trim()) ?? [];
    const ask = input.ask?.filter((name) => name.trim()) ?? [];
    const newCriteria = criteria.length ? this.criteria.newCriteria(decision, criteria, actor, now) : [];
    const newAsks = ask.length ? this.people.newAsks(decision, ask, input.askNote) : undefined;

    board.nextDecisionNumber++;
    board.decisions.push(decision);
    this.repo.indexDecision(id, board.id);
    this.repo.indexCanvas(decision.canvas, { decisionId: id });
    const blocking = decision.blocking ? ' (blocking)' : '';
    this.repo.record(board, actor, 'decision_posted', `asked ${label(decision)}${blocking}`, decision.id);
    for (const { id: itemId, summary } of placed) this.repo.recordCanvas(located, actor, summary, itemId);
    if (newCriteria.length) this.criteria.addCriteria(board, decision, newCriteria, actor, now);
    if (newAsks) this.people.addAsks(board, decision, newAsks, actor);
    return decision;
  }

  // Rewording, revising options and finishing a refresh all keep what the card
  // said before (revisions), so nothing it offered is lost.
  updateDecision(decisionId: string, patch: DecisionPatch, actor: Actor): Decision {
    const { board, decision } = this.repo.getDecision(decisionId);
    guardArchived(board);
    const now = new Date().toISOString();
    const revising = Boolean(patch.reviseOptions?.length);
    // A settled card is refreshed by checking its answer still holds, leaving it as it is.
    const settled = decision.status === 'decided' || decision.status === 'provisional';
    const changesWording =
      patch.question !== undefined || patch.context !== undefined || patch.recommend !== undefined || Boolean(patch.addOptions?.length) || revising;
    const rewords = changesWording || (Boolean(patch.refreshed) && !settled);
    if (rewords) guardHumanSettled(decision, actor, 'reword it or change its options');
    if (rewords) guardRetired(decision, 'changing it');
    if (revising && settled) {
      throw new BoardError(
        `${label(decision)} is ${decision.status} (${describeChoice(decision)}), so its options stay as they were answered. Reopen it to change them.`,
      );
    }
    if (patch.refreshed && !REFRESHED.includes(decision.status)) {
      throw new BoardError(`${label(decision)} is ${decision.status}; only open, exploring, decided and provisional cards are refreshed.`);
    }
    if (patch.refreshed && actor.kind !== 'agent') {
      throw new BoardError('Agents finish a refresh. To change the card yourself, edit it; to stop waiting, cancel the refresh.');
    }
    if (patch.refreshed && settled && changesWording) {
      throw new BoardError(
        `${label(decision)} is ${decision.status} (${describeChoice(decision)}), so a refresh checks its answer still holds and leaves the card as it is: pass refreshed: true with a note alone. If it no longer holds, say so in a comment, so a person can reopen it.`,
      );
    }
    if (patch.refreshed && settled && !patch.note?.trim()) {
      throw new BoardError(`Say in note whether ${label(decision)} still holds, so people can judge it.`);
    }

    // Everything is checked before anything changes, so a bad call leaves the card as it was.
    const question = patch.question === undefined ? undefined : required(patch.question, 'question');
    const context = patch.context === undefined ? undefined : optional(patch.context);
    const dependsOn = patch.dependsOn === undefined ? undefined : this.validDependencies(board, decision.id, patch.dependsOn);
    const affects = patch.affects === undefined ? undefined : this.validAffects(board, decision, patch.affects, actor, now);
    const area = patch.area === undefined ? null : areaChange(board, decision, patch.area, actor);
    const changes = (patch.reviseOptions ?? []).map((change) => this.checkOptionChange(decision, change, actor));
    if (new Set(changes.map((c) => c.option.id)).size < changes.length) throw new BoardError('Change each option once per call.');
    const newOptions = patch.addOptions ?? [];
    for (const input of newOptions) required(input.label, 'option label');
    const letters = newOptions.map((_, i) => optionLetter(decision.options.length + i));
    if (patch.recommend !== undefined) {
      const existing = decision.options.find((o) => o.id === patch.recommend);
      if (!existing && !letters.includes(patch.recommend)) {
        throw new BoardError(`Cannot recommend "${patch.recommend}": ${label(decision)} has no such option.`);
      }
      const outdatedAfter = changes.find((c) => c.option === existing)?.outdated ?? Boolean(existing?.outdated);
      if (outdatedAfter) throw new BoardError(`Cannot recommend ${patch.recommend}): it is outdated. Recommend one that still applies.`);
    }
    const note = patch.note === undefined ? undefined : optional(limited(patch.note, LIMITS.note, 'A note'));

    const before = snapshot(decision);
    const wording: string[] = []; // what changed in what it offers
    const settings: string[] = []; // blocking, dependencies, recommendation
    const revise = (field: Revision['field'], before: string | undefined, optionId?: string) => {
      decision.revisions ??= [];
      decision.revisions.push({ field, optionId, before, by: actor, at: now });
      if (decision.revisions.length > 100) decision.revisions.shift();
    };
    if (question !== undefined && question !== decision.question) {
      revise('question', decision.question);
      wording.push(`reworded the question (was "${clip(decision.question, 120)}")`);
      decision.question = question;
    }
    if (patch.context !== undefined && context !== decision.context) {
      revise('context', decision.context);
      wording.push(decision.context ? (context ? 'rewrote the context' : 'cleared the context') : 'added context');
      decision.context = context;
    }
    for (const { option, label: newLabel, description, outdated, reason } of changes) {
      if (newLabel !== undefined && newLabel !== option.label) {
        revise('label', option.label, option.id);
        wording.push(`reworded ${option.id} (was "${clip(option.label, 80)}")`);
        option.label = newLabel;
      }
      if (description !== undefined && description !== option.description) {
        revise('description', option.description, option.id);
        wording.push(description ? `revised ${option.id}'s description` : `cleared ${option.id}'s description`);
        option.description = description;
      }
      if (newLabel !== undefined || description !== undefined) {
        option.revisedAt = now;
        if (actor.kind === 'human') option.person = actor;
      }
      if (outdated === true && !option.outdated) {
        option.outdated = { reason, by: actor, at: now };
        wording.push(`marked ${option.id} outdated${reason ? ` ("${clip(reason, 120)}")` : ''}`);
      } else if (outdated === false && option.outdated) {
        option.outdated = undefined;
        wording.push(`brought ${option.id} back`);
      }
    }
    if (patch.blocking !== undefined && patch.blocking !== decision.blocking) {
      decision.blocking = patch.blocking;
      settings.push(patch.blocking ? 'now blocking' : 'no longer blocking');
    }
    if (dependsOn !== undefined) {
      decision.dependsOn = dependsOn;
      settings.push('dependencies');
    }
    if (affects !== undefined) {
      const named = affects.map((a) => board.decisions.find((d) => d.id === a.decisionId)!).map((d) => `#${d.number}`);
      if (named.length || decision.affects?.length) settings.push(named.length ? `could affect ${named.join(', ')}` : 'names no decisions it could affect');
      decision.affects = affects.length ? affects : undefined;
    }
    if (area) {
      const was = decision.area;
      settings.push(area.area ? `area "${area.area}"${was ? ` (was "${was}")` : ''}` : `cleared the area (was "${was}")`);
      decision.area = area.area;
      // A person's area stays theirs; an agent's is open to change.
      decision.areaPerson = area.area && actor.kind === 'human' ? actor : undefined;
    }
    const added = this.appendOptions(decision, patch.addOptions ?? [], actor, now);
    for (const option of added) wording.push(`added ${option.id}) ${clip(option.label, 60)}`);
    if (patch.recommend !== undefined) {
      this.setRecommendation(decision, patch.recommend, patch.recommendationReason, actor, now);
      settings.push(`recommends ${patch.recommend}`);
    } else if (decision.recommendation && decision.options.find((o) => o.id === decision.recommendation!.optionId)?.outdated) {
      wording.push(`cleared the recommendation (${decision.recommendation.optionId} is outdated)`);
      decision.recommendation = undefined;
    }

    if (patch.refreshed) {
      const request = decision.refreshRequest;
      const summary = cardChanges(request?.before ?? before, decision);
      decision.refreshRequest = undefined;
      decision.refreshed = { by: actor, at: now, changes: summary, note, requestedBy: request?.by };
      decision.updatedAt = now;
      const answering = request ? ` (answering ${request.by.name}'s request)` : '';
      const stays = `it stays ${decision.status === 'provisional' ? 'decided for now' : 'decided'} (${describeChoice(decision)})`;
      const what = settled ? stays : summary.length ? summary.join(', ') : 'no changes, the options still hold';
      // The summary already says what it recommends now.
      const extra = [...settings.filter((c) => !c.startsWith('recommends')), ...(note ? [`note: "${clip(note, 200)}"`] : [])];
      this.repo.record(board, actor, 'refresh_finished', `refreshed ${label(decision)}${answering}: ${[what, ...extra].join('; ')}`, decision.id);
      return decision;
    }
    if (wording.length === 0 && settings.length === 0) throw new BoardError('Nothing to update.');

    // Filing a card under an area is logged but doesn't count as a change to
    // it, so giving a board's cards areas leaves their order and ages alone.
    if (!(area && wording.length === 0 && settings.length === 1)) decision.updatedAt = now;
    if (wording.length > 0 && wording.length === added.length) {
      const labels = added.map((o) => `${o.id}) ${clip(o.label, 40)}`).join(', ');
      this.repo.record(board, actor, 'option_added', `added option ${labels} to ${label(decision)}`, decision.id);
    } else if (wording.length > 0) {
      this.repo.record(board, actor, 'decision_revised', `revised ${label(decision)}: ${wording.join(', ')}`, decision.id);
    }
    if (settings.length > 0) {
      this.repo.record(board, actor, 'decision_updated', `updated ${label(decision)}: ${settings.join(', ')}`, decision.id);
    }
    return decision;
  }

  // One option change, checked against the option and who is making it.
  private checkOptionChange(decision: Decision, change: OptionChange, actor: Actor) {
    const option = decision.options.find((o) => o.id === change.id?.trim());
    if (!option) throw new BoardError(`${label(decision)} has no option "${change.id}".`);
    const person = optionPerson(option);
    if (actor.kind === 'agent' && person) {
      throw new BoardError(
        `Option ${option.id}) of ${label(decision)} is ${person.name}'s (they proposed or reworded it), so agents can't change it. Leave it as it is, and say in a comment or your refresh note if it looks out of date.`,
      );
    }
    const reason = change.reason === undefined ? undefined : optional(limited(change.reason, LIMITS.reason, 'A reason'));
    if (change.outdated === true && actor.kind === 'agent' && !reason && !option.outdated) {
      throw new BoardError(`Say why option ${option.id}) no longer applies (reason), so people can judge it.`);
    }
    if (change.outdated === false && option.outdated && actor.kind === 'agent' && option.outdated.by.kind === 'human') {
      throw new BoardError(
        `${option.outdated.by.name} marked option ${option.id}) outdated, so agents can't bring it back. Suggest it in a comment if it applies again.`,
      );
    }
    return {
      option,
      label: change.label === undefined ? undefined : limited(required(change.label, 'option label'), LIMITS.optionLabel, 'An option label'),
      description: change.description === undefined ? undefined : optional(limited(change.description, LIMITS.optionDescription, 'An option description')),
      outdated: change.outdated,
      reason,
    };
  }

  // A person asks agents to re-check a card against the app as it is now.
  // Asking again replaces the open request.
  requestRefresh(decisionId: string, note: string | undefined, actor: Actor): Decision {
    if (actor.kind !== 'human') {
      throw new BoardError('Only people ask for a refresh. To bring the options up to date yourself, use update_decision with refreshed: true.');
    }
    const { board, decision } = this.repo.getDecision(decisionId);
    guardArchived(board);
    if (!REFRESHED.includes(decision.status)) {
      throw new BoardError(`${label(decision)} is ${decision.status}; only open, exploring, decided and provisional cards are refreshed.`);
    }
    const now = new Date().toISOString();
    const text = note === undefined ? undefined : optional(limited(note, LIMITS.note, 'A note'));
    decision.refreshRequest = { text, by: actor, at: now, before: snapshot(decision) };
    decision.updatedAt = now;
    const said = text ? `: "${clip(text, 160)}"` : '';
    const answering = answerAsks(decision, actor, now);
    // A settled card keeps its answer: agents check it still holds.
    const what = decision.status === 'open' || decision.status === 'exploring' ? `refresh the options of ${label(decision)}` : `check ${label(decision)} still holds`;
    this.repo.record(board, actor, 'refresh_requested', `asked agents to ${what}${said}${answering}`, decision.id);
    return decision;
  }

  // Cancelling a refresh that has just finished is not an error: it is over either way.
  cancelRefresh(decisionId: string, actor: Actor): Decision {
    if (actor.kind !== 'human') throw new BoardError('Only people cancel a refresh; finish it with update_decision refreshed: true.');
    const { board, decision } = this.repo.getDecision(decisionId);
    guardArchived(board);
    const request = decision.refreshRequest;
    if (!request) return decision;
    decision.refreshRequest = undefined;
    decision.updatedAt = new Date().toISOString();
    const asker = samePerson(request.by.name, actor.name) ? '' : ` ${request.by.name} asked for`;
    this.repo.record(board, actor, 'refresh_cancelled', `cancelled the refresh of ${label(decision)}${asker}`, decision.id);
    return decision;
  }

  // `pin` is the part of the decision's canvas the comment is about, if any;
  // `ask`, what a person asks agents to do to it ("edit … in Google Doc …").
  addComment(decisionId: string, body: string, actor: Actor, pin?: Comment['pin'], ask?: string): Decision {
    const { board, decision } = this.repo.getDecision(decisionId);
    guardArchived(board);
    const now = new Date().toISOString();
    const text = commentText(body);
    const { mentions, skill } = this.people.requestIn(board, text, actor);
    const via = this.people.viaSkill(decision.comments, actor);
    const held = this.people.heldIn(board, decision.comments, actor, mentions);
    const comment: Comment = {
      id: randomId(8),
      author: actor,
      body: text,
      createdAt: now,
      ...(pin ? { pin } : {}),
      ...(ask ? { ask: true as const } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(skill ? { skill } : {}),
      ...(via ? { via } : {}),
      ...(held ? { held } : {}),
    };
    decision.comments.push(comment);
    decision.updatedAt = now;
    const answering = answerAsks(decision, actor, now);
    const asking = askMentioned(decision, peopleIn(board, mentions), actor, text, now);
    const about = pin ? ` about ${clip(pin.quote, 80)}` : '';
    const what = ask ? `asked agents, on ${label(decision)}, to ${ask}` : `commented on ${label(decision)}${about}`;
    this.repo.record(board, actor, 'comment_added', `${what}: "${clip(text, 200)}"${answering}${asking}`, decision.id, undefined, undefined, now, mentions, comment.id, undefined, Boolean(held));
    return decision;
  }

  // A person asks agents to break a settled decision into tasks.
  requestPlan(decisionId: string, note: string | undefined, actor: Actor): Decision {
    const { board, decision } = this.repo.getDecision(decisionId);
    guardArchived(board);
    if (decision.status !== 'decided' && decision.status !== 'provisional') {
      throw new BoardError(`${label(decision)} is ${decision.status}; only settled decisions can be planned.`);
    }
    const now = new Date().toISOString();
    const text = note === undefined ? undefined : optional(limited(note, LIMITS.note, 'A note'));
    decision.planRequest = { text, by: actor, at: now };
    decision.updatedAt = now;
    const said = text ? `: "${clip(text, 160)}"` : '';
    this.repo.record(board, actor, 'plan_requested', `asked for a task plan for ${label(decision)}${said}`, decision.id);
    return decision;
  }

  attachFinding(decisionId: string, input: NewFinding, actor: Actor): Decision {
    const { board, decision } = this.repo.getDecision(decisionId);
    guardArchived(board);
    if (input.optionId && !decision.options.some((o) => o.id === input.optionId)) {
      throw new BoardError(`${label(decision)} has no option "${input.optionId}".`);
    }
    const now = new Date().toISOString();
    const finding: Finding = {
      id: randomId(8),
      optionId: input.optionId,
      author: actor,
      summary: required(input.summary, 'summary'),
      metrics: input.metrics && Object.keys(input.metrics).length > 0 ? input.metrics : undefined,
      links: input.links?.length ? input.links : undefined,
      createdAt: now,
    };
    decision.findings.push(finding);
    decision.updatedAt = now;
    const target = input.optionId ? ` for option ${input.optionId}` : '';
    this.repo.record(board, actor, 'finding_attached', `reported findings${target} on ${label(decision)}: "${clip(finding.summary, 160)}"`, decision.id);
    return decision;
  }

  private appendOptions(decision: Decision, options: NewOption[], actor: Actor, now: string): Option[] {
    const added = options.map((input, i) => ({
      id: optionLetter(decision.options.length + i),
      label: required(input.label, 'option label'),
      description: optional(input.description),
      pros: input.pros?.map((p) => p.trim()).filter(Boolean),
      cons: input.cons?.map((c) => c.trim()).filter(Boolean),
      proposedBy: actor,
      createdAt: now,
    }));
    decision.options.push(...added);
    return added;
  }

  private setRecommendation(decision: Decision, optionId: string, reason: string | undefined, actor: Actor, now: string): void {
    const option = decision.options.find((o) => o.id === optionId);
    if (!option) throw new BoardError(`Cannot recommend "${optionId}": ${label(decision)} has no such option.`);
    if (option.outdated) throw new BoardError(`Cannot recommend ${optionId}): it is outdated. Recommend one that still applies.`);
    decision.recommendation = { optionId, reason: optional(reason), by: actor, at: now };
  }

  // The decisions an agent names as ones this could change or rests on, each
  // once, with why. One already named with the same why keeps when it was named.
  private validAffects(board: Board, decision: Decision, inputs: NewAffect[], actor: Actor, now: string): Affect[] {
    if (inputs.length > LIMITS.affects) throw new BoardError(`Name at most ${LIMITS.affects} decisions it could affect.`);
    const seen = new Set<string>();
    return inputs.map((input) => {
      const id = input.decisionId?.trim();
      if (id === decision.id) throw new BoardError('A decision cannot affect itself.');
      if (!board.decisions.some((d) => d.id === id)) throw new BoardError(`No decision "${input.decisionId}" on this board.`);
      if (seen.has(id)) throw new BoardError('Name each decision once in affects.');
      seen.add(id);
      const why = limited(required(input.why, 'why'), LIMITS.affectWhy, 'Why');
      const kept = decision.affects?.find((a) => a.decisionId === id && a.why === why);
      return kept ?? { decisionId: id, why, by: actor, at: now };
    });
  }

  private validDependencies(board: Board, selfId: string, ids: string[]): string[] {
    const unique = [...new Set(ids)];
    for (const id of unique) {
      if (id === selfId) throw new BoardError('A decision cannot depend on itself.');
      if (!board.decisions.some((d) => d.id === id)) throw new BoardError(`No decision "${id}" on this board.`);
    }
    return unique;
  }
}
