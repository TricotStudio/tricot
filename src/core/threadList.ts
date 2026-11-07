// The threads list: every thread on a board, wherever it was started, as the
// chat bar's threads button opens it (web/threadsList.tsx). What waits on the
// viewer comes first, then the rest by when they were last active, and the
// finished, quiet ones fold under Earlier. Each says where it was started and
// what it made. A card's own discussion is the card's, so isn't a thread here.
//
// "Seen" is the viewer's: the last message they saw in each thread, by thread
// id, as their browser keeps it (web/threadsSeen.ts).

import { DOOR_NAMES } from './doors';
import { samePerson } from './format';
import { peopleIn } from './mentions';
import { threadWaiting, threadWork } from './threads';
import type { Board, Thread, ThreadMessage, ThreadRef } from './types';

// The last message seen in each thread, by thread id.
export type ThreadsSeen = Record<string, string>;

const HOUR = 60 * 60 * 1000;
// A thread that made what it was for is finished once it has been quiet a day;
// one that made nothing, once it has been quiet a week.
export const QUIET_AFTER_MADE = 24 * HOUR;
export const QUIET_AFTER = 7 * 24 * HOUR;

const mine = (message: ThreadMessage, me: string) => message.author.kind === 'human' && samePerson(message.author.name, me);

// The messages after the last one this viewer saw: all of them for a thread
// they have never seen.
function unseenMessages(thread: Thread, seen: string | undefined): ThreadMessage[] {
  return thread.messages.slice(thread.messages.findIndex((m) => m.id === seen) + 1);
}

// Whether a thread waits on this person: it's their turn. An agent wrote last
// (it replied, or asked something) and they haven't seen it, in a thread that
// is theirs: one they wrote in, or one with no person in it yet (an agent's
// question to the board). An agent's message that @-mentions people is
// theirs alone.
export function waitsOnYou(board: Pick<Board, 'activity'>, thread: Thread, me: string, seen: string | undefined): boolean {
  const last = thread.messages.at(-1);
  if (!last || last.author.kind !== 'agent') return false;
  if (!unseenMessages(thread, seen).includes(last)) return false;
  const people = peopleIn(board, last.mentions);
  if (people.length) return people.some((p) => samePerson(p, me));
  const humans = thread.messages.filter((m) => m.author.kind === 'human');
  return humans.length === 0 || humans.some((m) => mine(m, me));
}

// Whether someone else wrote in it since this viewer last looked.
export function threadUnread(thread: Thread, me: string, seen: string | undefined): boolean {
  return unseenMessages(thread, seen).some((m) => !mine(m, me));
}

// What agents made with the thread's id, as it is now, in a word or two each:
// "#78", "T48", "3 blocks". A decision or task counts when it came from this
// thread (one a reply only named is another thread's, or nobody's); blocks
// count while they are still on the board. Comments are left out.
export function threadMade(board: Board, thread: Pick<Thread, 'id' | 'messages' | 'pending'>): string[] {
  return madeCards(board, thread, [...thread.messages.flatMap((m) => m.refs ?? []), ...(thread.pending ?? [])]).labels;
}

// What a thread made, as the list says it: in plain words rather than
// numbers. "made a question", "made 2 tasks", "added 3 blocks", "made a
// question and a task"; nothing for a thread that made nothing.
export function madeInWords(made: string[]): string | undefined {
  const some = (n: number, what: string) => (n === 1 ? `a ${what}` : `${n} ${what}s`);
  const questions = made.filter((label) => label.startsWith('#')).length;
  const tasks = made.filter((label) => /^T\d/.test(label)).length;
  const blocks = Number(made.find((label) => /^\d+ blocks?$/.test(label))?.split(' ')[0] ?? 0);
  const cards = [questions ? some(questions, 'question') : '', tasks ? some(tasks, 'task') : ''].filter(Boolean);
  const words = [cards.length ? `made ${cards.join(' and ')}` : '', blocks ? `added ${some(blocks, 'block')}` : ''].filter(Boolean);
  return words.length ? words.join(', ') : undefined;
}

function madeCards(board: Board, thread: Pick<Thread, 'id'>, refs: ThreadRef[]): { labels: string[]; ids: string[] } {
  const seen = new Set<string>();
  const labels: string[] = [];
  const ids: string[] = [];
  let blocks = 0;
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const work = threadWork(board, ref);
    if (work.kind === 'decision' && work.decision.fromThread?.id === thread.id) {
      labels.push(`#${work.decision.number}`);
      ids.push(work.decision.id);
    } else if (work.kind === 'task' && work.task.fromThread?.id === thread.id) {
      labels.push(`T${work.task.number}`);
      ids.push(work.task.id);
    } else if (work.kind === 'block') blocks += 1;
  }
  if (blocks) labels.push(`${blocks} block${blocks === 1 ? '' : 's'}`);
  return { labels, ids };
}

// The cards made in what this viewer hasn't seen of a thread: its unseen
// messages, and what agents made ahead of a reply. Their own "needs you"
// stands for the thread (core/needs.ts).
export function unseenCards(board: Board, thread: Thread, seen: string | undefined): string[] {
  const refs = [...unseenMessages(thread, seen).flatMap((m) => m.refs ?? []), ...(thread.pending ?? [])];
  return madeCards(board, thread, refs).ids;
}

// Where a thread was started, as its tag in the list says it: Decisions,
// Tasks, Board Context (the General thread too). None for the open-ended
// door, the list itself, nor for an agent's thread.
export function threadTag(thread: Pick<Thread, 'door' | 'general'>): string | undefined {
  if (thread.general) return DOOR_NAMES.canvas;
  return thread.door && thread.door !== 'threads' ? DOOR_NAMES[thread.door] : undefined;
}

// The tab a thread opens on where no conversation is docked (a card's own
// view, Home, another board): the one it was started from, the General
// thread's Board Context, else Decisions.
export function threadView(thread: Pick<Thread, 'door' | 'general'>): 'decisions' | 'tasks' | 'canvas' {
  if (thread.general) return 'canvas';
  return thread.door === 'tasks' || thread.door === 'canvas' ? thread.door : 'decisions';
}

// Whether a thread is done with for now: nothing in it waits on anyone, it
// made what it was for and has been quiet a day, or made nothing and has
// been quiet a week.
export function threadFinished(board: Board, thread: Thread, now: number): boolean {
  if (threadWaiting(board, thread)) return false;
  const quiet = now - Date.parse(thread.updatedAt);
  return quiet >= (threadMade(board, thread).length ? QUIET_AFTER_MADE : QUIET_AFTER);
}

export interface ThreadEntry {
  thread: Thread;
  waiting: boolean; // on this viewer: their turn
  unread: boolean; // someone else wrote since they looked
  tag?: string; // where it was started
  made: string[]; // #78, T48, 3 blocks
}

export interface ThreadGroups {
  waiting: ThreadEntry[]; // on you, the latest first
  recent: ThreadEntry[]; // the latest first
  earlier: ThreadEntry[]; // finished and quiet, the latest first
}

const latestFirst = (a: ThreadEntry, b: ThreadEntry) => b.thread.updatedAt.localeCompare(a.thread.updatedAt);

// The list, for this viewer. With nothing remembered as seen (`seen` null),
// nothing waits on them, as on a first visit.
export function threadGroups(board: Board, me: string, seen: ThreadsSeen | null, now: number): ThreadGroups {
  const groups: ThreadGroups = { waiting: [], recent: [], earlier: [] };
  for (const thread of board.threads ?? []) {
    const last = seen?.[thread.id];
    const waiting = Boolean(seen) && waitsOnYou(board, thread, me, last);
    const entry: ThreadEntry = {
      thread,
      waiting,
      unread: Boolean(seen) && threadUnread(thread, me, last),
      tag: threadTag(thread),
      made: threadMade(board, thread),
    };
    if (waiting) groups.waiting.push(entry);
    else if (threadFinished(board, thread, now)) groups.earlier.push(entry);
    else groups.recent.push(entry);
  }
  groups.waiting.sort(latestFirst);
  groups.recent.sort(latestFirst);
  groups.earlier.sort(latestFirst);
  return groups;
}

// The threads waiting on this viewer, the latest first: the threads button's count.
export function threadsWaitingOn(board: Board, me: string, seen: ThreadsSeen | null): Thread[] {
  if (!seen) return [];
  return (board.threads ?? []).filter((t) => waitsOnYou(board, t, me, seen[t.id])).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// The decisions and tasks an agent made from a conversation this person is
// part of (one they started or wrote in), by id: what lands on the board from
// their own thread, which stays lit until they've seen it (web/justMade.ts).
export function cardsFromYourThreads(board: Pick<Board, 'threads' | 'decisions' | 'tasks'>, me: string): string[] {
  const yours = new Set(
    (board.threads ?? [])
      .filter((t) => (t.startedBy.kind === 'human' && samePerson(t.startedBy.name, me)) || t.messages.some((m) => mine(m, me)))
      .map((t) => t.id),
  );
  return [...board.decisions, ...board.tasks].filter((c) => c.createdBy.kind === 'agent' && c.fromThread && yours.has(c.fromThread.id)).map((c) => c.id);
}
