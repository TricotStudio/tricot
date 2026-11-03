// Reactions: a 👍, 👎 or 👀 left on someone else's comment or thread message,
// one of each per person or agent; leaving one again takes it back. They say
// in a click what a reply would say in words:
// - 👍 and 👎 answer what a comment asks of whoever leaves them: a person's 👍
//   on an agent's comment that @-mentions them is their reply, so it leaves
//   their Needs you, and an agent's on a person's is its answer too.
// - 👀 says it was seen. Agents leave theirs on their own when a person's
//   comment or message reaches them (get_board, get_updates,
//   wait_for_updates), once each, and quietly: nothing is logged, so no other
//   agent wakes and nobody's activity fills up. The chip shows up live.
// - A person's reaction to an agent's comment is logged for that agent alone
//   (BoardEvent.forAgent), so it reaches it in plain words ("Sam reacted 👎
//   to your comment on T115") and nobody else's updates.
// Reactions are kept on the comment or message itself; nothing else is stored.

import { clip, samePerson } from './format';
import type { Actor, Board, BoardEvent, Reaction } from './types';

export const EMOJIS = ['👍', '👎', '👀'] as const;
export type Emoji = (typeof EMOJIS)[number];

// What each is called, for buttons and the people reading a tooltip.
export const EMOJI_NAMES: Record<Emoji, string> = { '👍': 'Thumbs up', '👎': 'Thumbs down', '👀': 'Eyes' };

// What each says, to an agent a person reacted to.
const MEANS: Record<Emoji, string> = { '👍': 'Read it as a yes, or OK.', '👎': 'Read it as a no.', '👀': "They've seen it." };

// The ones that answer: a reply without words.
const ANSWERS: readonly Emoji[] = ['👍', '👎'];

export function isEmoji(value: unknown): value is Emoji {
  return (EMOJIS as readonly unknown[]).includes(value);
}

// Something people and agents react to: a comment, or a thread message.
export interface Reactable {
  id: string;
  author: Actor;
  reactions?: Reaction[];
}

const byActor = (actor: Actor) => (r: Reaction) => r.by.kind === actor.kind && samePerson(r.by.name, actor.name);

export function hasReaction(item: Pick<Reactable, 'reactions'>, emoji: Emoji, actor: Actor): boolean {
  return Boolean(item.reactions?.some((r) => r.emoji === emoji && byActor(actor)(r)));
}

// Whether this person or agent reacted to it at all: they have seen it.
export function reactedBy(item: Pick<Reactable, 'reactions'>, name: string): boolean {
  return Boolean(item.reactions?.some((r) => samePerson(r.by.name, name)));
}

// Whether this person or agent answered it with a 👍 or 👎.
export function answeredBy(item: Pick<Reactable, 'reactions'>, name: string): boolean {
  return Boolean(item.reactions?.some((r) => ANSWERS.includes(r.emoji) && samePerson(r.by.name, name)));
}

export function isAnswer(emoji: Emoji): boolean {
  return ANSWERS.includes(emoji);
}

// Adds a reaction, or takes it back: true if it changed anything. An agent's
// 👍 or 👎 says it has seen the comment, so its 👀 there goes.
export function setReaction(item: Reactable, emoji: Emoji, actor: Actor, on: boolean, at: string): boolean {
  const mine = byActor(actor);
  if (on === hasReaction(item, emoji, actor)) return false;
  let reactions = item.reactions ?? [];
  if (on) {
    if (actor.kind === 'agent' && isAnswer(emoji)) reactions = reactions.filter((r) => !(r.emoji === '👀' && mine(r)));
    reactions = [...reactions, { emoji, by: actor, at }];
  } else {
    reactions = reactions.filter((r) => !(r.emoji === emoji && mine(r)));
  }
  if (reactions.length) item.reactions = reactions;
  else delete item.reactions;
  return true;
}

// The reactions on something, by emoji in the picker's order, oldest first in each.
export function reactionGroups(reactions: Reaction[] | undefined): { emoji: Emoji; reactions: Reaction[] }[] {
  return EMOJIS.flatMap((emoji) => {
    const these = (reactions ?? []).filter((r) => r.emoji === emoji);
    return these.length ? [{ emoji, reactions: these }] : [];
  });
}

// The reactions as agents read them under a comment: "  Reactions: 👍 Sam · 👀 Claude, Codex".
export function reactionsLine(item: Pick<Reactable, 'reactions'>): string[] {
  const groups = reactionGroups(item.reactions);
  if (groups.length === 0) return [];
  return [`  Reactions: ${groups.map((g) => `${g.emoji} ${g.reactions.map((r) => r.by.name).join(', ')}`).join(' · ')}`];
}

// ---- what an agent is told -------------------------------------------------------

// The comment or thread message an event is about, by its id (events logged
// before they named it find none), and where it is: `on` for people ("on
// T115"), `where` for agents ("on T115 [task id: …]").
export function eventComment(event: Pick<BoardEvent, 'taskId' | 'decisionId' | 'itemId' | 'commentId'>, board: Board): { item: Reactable & { body: string }; where: string; on: string } | undefined {
  const id = event.commentId;
  if (!id) return undefined;
  if (event.taskId) {
    const task = board.tasks.find((t) => t.id === event.taskId);
    const comment = task?.comments.find((c) => c.id === id);
    return task && comment ? { item: comment, on: `T${task.number}`, where: `on T${task.number} [task id: ${task.id}]` } : undefined;
  }
  if (event.decisionId) {
    const decision = board.decisions.find((d) => d.id === event.decisionId);
    const comment = decision?.comments.find((c) => c.id === id);
    return decision && comment ? { item: comment, on: `#${decision.number}`, where: `on #${decision.number} [decision id: ${decision.id}]` } : undefined;
  }
  const thread = board.threads?.find((t) => t.id === event.itemId);
  const message = thread?.messages.find((m) => m.id === id);
  if (thread && message) {
    const named = `thread "${clip(thread.title, 60)}"`;
    return { item: message, on: `in ${named}`, where: `in ${named} [thread id: ${thread.id}]` };
  }
  const pin = board.canvas.pins.find((p) => p.id === event.itemId);
  const comment = pin?.discussion?.thread?.find((c) => c.id === id);
  if (!pin || !comment) return undefined;
  const about = `the board context, about "${clip(pin.quote, 60)}"`;
  return { item: comment, on: `on ${about}`, where: `on ${about} [pin id: ${pin.id}]` };
}

// What a person's reaction to an agent's comment is logged as, for people's
// activity: "reacted 👍 to Claude's comment on T115: "…"".
export function reactionSummary(emoji: Emoji, on: boolean, author: Actor, place: string, body: string, answering = ''): string {
  const whose = `${author.name}'s comment ${place}`;
  return on ? `reacted ${emoji} to ${whose}: "${clip(body, 120)}"${answering}` : `took back their ${emoji} on ${whose}`;
}

// The same as the agent whose comment it is reads it in its updates:
// "Sam (human) reacted 👎 to your comment on T115 [task id: …]: "…". Read it
// as a no." None for other events, or when the comment is gone.
export function reactionEventLine(event: BoardEvent, board: Board, viewer: string | undefined): string | undefined {
  if (event.type !== 'comment_reacted') return undefined;
  const found = eventComment(event, board);
  const [, took, emoji] = /^(reacted|took back their) (\S+)/u.exec(event.summary) ?? [];
  if (!found || !isEmoji(emoji)) return undefined;
  const lead = `- (${event.seq}) ${event.actor.name} (${event.actor.kind})`;
  const mine = viewer !== undefined && samePerson(found.item.author.name, viewer);
  const whose = mine ? 'your comment' : `${found.item.author.name}'s comment`;
  if (took !== 'reacted') return `${lead} took back their ${emoji} on ${whose} ${found.where}.`;
  return `${lead} reacted ${emoji} to ${whose} ${found.where}: "${clip(found.item.body, 120)}". ${MEANS[emoji]}`;
}
