// What needs a person's input, as opposed to what they might like to know.
// Drives the "for you" rows in the inbox and which events may notify.

import { pendingAsks, samePerson } from './format';
import { eventComment, reactedBy } from './reactions';
import type { Board, BoardEvent, Decision, Task } from './types';

// What others changed after this person last looked (event `since`): the
// "new since you were away" a board's inbox lists. Reordering a lane, and a
// reaction to an agent's comment (logged for that agent), are in the log, but
// they aren't news.
export const NOT_NEWS = ['task_reordered', 'comment_reacted'];

export function unseenBy(events: BoardEvent[], since: number, me: string): BoardEvent[] {
  return events.filter(
    (e) => e.seq > since && !NOT_NEWS.includes(e.type) && !(e.actor.kind === 'human' && samePerson(e.actor.name, me)),
  );
}

// Whether this person has taken part in a decision, so replies on it are
// replies to them.
export function involvedIn(decision: Decision, me: string): boolean {
  const mine = (actor: { kind: string; name: string }) => actor.kind === 'human' && samePerson(actor.name, me);
  return (
    mine(decision.createdBy) ||
    decision.comments.some((c) => mine(c.author)) ||
    Boolean(decision.resolution && mine(decision.resolution.by)) ||
    decision.history.some((h) => mine(h.by) || mine(h.endedBy)) ||
    decision.asks.some((a) => samePerson(a.name, me)) ||
    decision.marks.some((m) => mine(m.by))
  );
}

function involvedInTask(task: Task, me: string): boolean {
  const mine = (actor: { kind: string; name: string }) => actor.kind === 'human' && samePerson(actor.name, me);
  return mine(task.createdBy) || task.comments.some((c) => mine(c.author)) || Boolean(task.claimedBy && mine(task.claimedBy));
}

// A board context comment thread this person started or wrote in.
function involvedInThread(board: Board, pinId: string | undefined, me: string): boolean {
  const mine = (actor: { kind: string; name: string }) => actor.kind === 'human' && samePerson(actor.name, me);
  const pin = board.canvas.pins.find((p) => p.id === pinId);
  return Boolean(pin?.discussion?.thread && (mine(pin.author) || pin.discussion.thread.some((c) => mine(c.author))));
}

export function needsInput(event: BoardEvent, board: Board, me: string): boolean {
  if (event.actor.kind === 'human' && samePerson(event.actor.name, me)) return false;
  // A comment or message they reacted to, they've seen; a 👍 or 👎 answered it.
  const said = eventComment(event, board)?.item;
  if (said && reactedBy(said, me)) return false;
  const decision = event.decisionId ? board.decisions.find((d) => d.id === event.decisionId) : undefined;
  switch (event.type) {
    case 'decision_asked':
      return Boolean(decision?.asks.some((a) => a.at === event.at && samePerson(a.name, me)));
    case 'decision_posted': {
      // A new question for the board, unless it was routed only to others.
      const waiting = decision ? pendingAsks(decision) : [];
      return waiting.length === 0 || waiting.some((a) => samePerson(a.name, me));
    }
    case 'comment_added': {
      // @-mentioned: asked of them, wherever the comment is.
      if (event.mentions?.some((m) => samePerson(m, me))) return true;
      const task = event.taskId ? board.tasks.find((t) => t.id === event.taskId) : undefined;
      if (task) return involvedInTask(task, me);
      if (!decision) return involvedInThread(board, event.itemId, me);
      return involvedIn(decision, me);
    }
    case 'refresh_finished': {
      // Agents answering this person's request to refresh the options: the
      // card's latest refresh is the one it keeps (its event is logged just
      // after the card says when it was refreshed).
      const asker = decision?.refreshed && event.at >= decision.refreshed.at ? decision.refreshed.requestedBy : undefined;
      return Boolean(asker && samePerson(asker.name, me));
    }
    case 'thread_started':
    case 'thread_replied': {
      // @-mentioned, or a reply in a thread this person wrote in.
      if (event.mentions?.some((m) => samePerson(m, me))) return true;
      const thread = board.threads?.find((t) => t.id === event.itemId);
      return Boolean(thread?.messages.some((m) => m.author.kind === 'human' && samePerson(m.author.name, me)));
    }
    case 'request_finished': {
      // Agents answering what this person asked for on the board context.
      const request = board.requests?.find((r) => r.id === event.itemId);
      return Boolean(request && samePerson(request.by.name, me));
    }
    case 'decision_resolved':
      // An agent's own call, waiting for a person to confirm it.
      return event.actor.kind === 'agent' && event.summary.startsWith('provisionally decided');
    case 'task_updated':
      // Blocked work, or finished work waiting for someone to check it.
      return /\b(marked it blocked|sent it for review)\b/.test(event.summary);
    default:
      return false;
  }
}

// Whether a card on the board waits on this person, for its "needs you"
// highlight. What the inbox flags as an event is held here for as long as it
// stands: a question asked of them, an agent's call to confirm. Replies to
// them, and new questions for the board, count while unseen, as in the inbox;
// an open question nobody was asked doesn't stay highlighted after that.
// `unseen` is what others changed since this person last looked.
export function decisionNeedsYou(decision: Decision, board: Board, me: string, unseen: BoardEvent[]): boolean {
  const waiting = pendingAsks(decision);
  const askedOfMe = waiting.some((a) => samePerson(a.name, me));
  const settled = decision.status === 'decided' || decision.status === 'deferred' || decision.status === 'retired';
  if (askedOfMe && !settled) return true;
  // Routed to other people, an agent's call waits for them to confirm.
  const agentCall = decision.status === 'provisional' && decision.resolution?.by.kind === 'agent';
  if (agentCall && (waiting.length === 0 || askedOfMe)) return true;
  return unseen.some(
    (e) =>
      e.decisionId === decision.id &&
      !e.taskId &&
      (e.type === 'comment_added' || e.type === 'refresh_finished' || (e.type === 'decision_posted' && decision.status === 'open')) &&
      needsInput(e, board, me),
  );
}

// The same for a task: work to review or unblock, or an unseen reply in a
// thread this person is part of, an @-mention among them (it tells, and is
// news until seen; only an ask on a decision holds). A stale task keeps its own amber
// outline instead; re-checking it falls to whoever builds it first. The
// backlog is people's own triage, so a task waiting there doesn't count.
export function taskNeedsYou(task: Task, board: Board, me: string, unseen: BoardEvent[]): boolean {
  if (task.status === 'in_review' || task.status === 'blocked') return true;
  return unseen.some((e) => e.taskId === task.id && e.type === 'comment_added' && needsInput(e, board, me));
}
