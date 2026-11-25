// The threads list, as the chat bar's threads button opens it
// (web/threadsList.tsx): the board's conversation as one row, then the work
// handed out, each thread a row. What waits on the viewer comes first, then
// the rest by when they were last active, and the finished, quiet ones fold
// under Earlier. Each says where it was started and what it made. A card's own
// discussion is the card's, so isn't a thread here.
//
// The conversation is what people ask from a chat bar and what the board's
// agents answer there (inConversation): each ask is still a thread of its own
// as stored, read whole on the board's Home, and quick questions get no row of
// their own here.
//
// "Seen" is the viewer's: the last message they saw in each thread, by thread
// id, as their browser keeps it (web/threadsSeen.ts).

import { cardOf, cardsOf } from './cards';
import { doorName, isTabDoor, opensOn } from './doors';
import type { BoardViewName } from './pages';
import { fileLabel, fileTag, threadFile } from './fileThread';
import { clip, samePerson } from './format';
import { peopleIn } from './mentions';
import { inConversation } from './roles';
import { blocksWords } from './threadSelection';
import { threadWaiting, threadWork } from './threads';
import type { Board, Thread, ThreadMessage, ThreadRef } from './types';

// Whether a thread is part of the board's conversation rather than work: the one predicate, kept with the roles that
// give a thread its status (core/roles.ts), and read from here.
export { inConversation };

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
// theirs alone. In work, another agent's that @-mentions no one is for its
// owner (core/roles.ts), as the coordinator's brief that starts it is.
export function waitsOnYou(board: Pick<Board, 'activity'>, thread: Thread, me: string, seen: string | undefined): boolean {
  const last = thread.messages.at(-1);
  if (!last || last.author.kind !== 'agent') return false;
  if (!unseenMessages(thread, seen).includes(last)) return false;
  const people = peopleIn(board, last.mentions);
  if (people.length) return people.some((p) => samePerson(p, me));
  if (!inConversation(thread) && thread.owner && !samePerson(last.author.name, thread.owner)) return false;
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
    if (ref.kind === 'block') {
      if (threadWork(board, ref).kind === 'block') blocks += 1;
      continue;
    }
    const card = cardOf(board, ref.kind, ref.id);
    if (card?.fromThread?.id === thread.id) {
      labels.push(card.label);
      ids.push(card.id);
    }
  }
  if (blocks) labels.push(`${blocks} block${blocks === 1 ? '' : 's'}`);
  return { labels, ids };
}

// The cards made in what this viewer hasn't seen of a thread: its unseen
// messages, and what agents made ahead of a reply. Their own "needs you"
// stands for the thread.
export function unseenCards(board: Board, thread: Thread, seen: string | undefined): string[] {
  const refs = [...unseenMessages(thread, seen).flatMap((m) => m.refs ?? []), ...(thread.pending ?? [])];
  return madeCards(board, thread, refs).ids;
}

// Where a thread was started, as its tag in the list says it: Decisions,
// Tasks, Board Context (the General thread too), a Sketchbook page, with how
// many blocks were selected there when it was about them, or Files, with the
// file it is about (`board` says which; without it, such a thread reads as
// one over a block of a page). None for the open-ended door, the list itself,
// nor for an agent's thread.
export function threadTag(thread: Pick<Thread, 'door' | 'general' | 'pageId' | 'blockIds'>, board?: Pick<Board, 'pages'>): string | undefined {
  if (thread.general) return doorName('canvas');
  const file = board && threadFile(board, thread);
  if (file) return fileTag(file);
  if (thread.pageId) return thread.blockIds?.length ? `Sketchbook · ${blocksWords(thread.blockIds.length)}` : 'Sketchbook';
  return thread.door && thread.door !== 'threads' ? doorName(thread.door) : undefined;
}

// Where an ask of the conversation was asked, as Home's conversation tags it:
// "Asked on Tidy docs" over a Sketchbook page (with how many blocks were
// selected there), "Asked on oauth.ts" over a file in Files, else as the list
// tags a thread.
export function askedTag(thread: Pick<Thread, 'door' | 'general' | 'pageId' | 'blockIds'>, board: Pick<Board, 'pages'>): string | undefined {
  if (thread.general) return threadTag(thread, board);
  const file = threadFile(board, thread);
  if (file) return file.path ? `Asked on ${fileLabel(file.path, 40)}` : threadTag(thread, board);
  const page = thread.pageId ? board.pages?.find((p) => p.id === thread.pageId) : undefined;
  if (page) return `Asked on ${clip(page.title, 40)}${thread.blockIds?.length ? ` · ${blocksWords(thread.blockIds.length)}` : ''}`;
  return threadTag(thread, board);
}

// Where an ask of the conversation was asked, for its tag to open: the Sketchbook page it was asked over, or the
// file in Files (its path as its block names it). None for anywhere else, or a page or a file's block that is gone.
export function askedOn(thread: Pick<Thread, 'general' | 'pageId' | 'blockIds'>, board: Pick<Board, 'pages'>): { pageId: string; file?: string } | undefined {
  if (thread.general || !thread.pageId) return undefined;
  const file = threadFile(board, thread);
  if (file) return file.path ? { pageId: file.page.id, file: file.path } : undefined;
  return board.pages?.some((p) => p.id === thread.pageId) ? { pageId: thread.pageId } : undefined;
}

// The tab a thread opens on where no conversation is docked (a card's own
// view, Home, another board): the one it was started from, the General
// thread's Board Context, else the tab the registered doors open on (Decisions).
export function threadView(thread: Pick<Thread, 'door' | 'general'>): BoardViewName {
  if (thread.general) return 'canvas';
  return thread.door && isTabDoor(thread.door) ? thread.door : opensOn();
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

// The conversation's row: its threads together, by the latest message said in
// any of them.
export interface ConversationEntry {
  thread: Thread; // the thread that latest message is in
  last: ThreadMessage;
  unread: boolean; // someone else wrote in it since this viewer looked: what is new is marked there, and waits on no one
}

export interface ThreadGroups {
  conversation?: ConversationEntry; // none while nothing has been said in it
  waiting: ThreadEntry[]; // work on you, the latest first
  recent: ThreadEntry[]; // the latest first
  earlier: ThreadEntry[]; // finished and quiet, the latest first
}

const latestFirst = (a: ThreadEntry, b: ThreadEntry) => b.thread.updatedAt.localeCompare(a.thread.updatedAt);

// The conversation as its row shows it, for this viewer.
function conversationEntry(threads: Thread[], me: string, seen: ThreadsSeen | null): ConversationEntry | undefined {
  let latest: { thread: Thread; last: ThreadMessage } | undefined;
  for (const thread of threads) {
    const last = thread.messages.at(-1);
    if (last && (!latest || last.at > latest.last.at)) latest = { thread, last };
  }
  return latest && { ...latest, unread: Boolean(seen) && threads.some((t) => threadUnread(t, me, seen![t.id])) };
}

// The list, for this viewer: the conversation, then the work. With nothing
// remembered as seen (`seen` null), nothing waits on them, as on a first visit.
export function threadGroups(board: Board, me: string, seen: ThreadsSeen | null, now: number): ThreadGroups {
  const threads = board.threads ?? [];
  const conversation = conversationEntry(threads.filter(inConversation), me, seen);
  const groups: ThreadGroups = { ...(conversation && { conversation }), waiting: [], recent: [], earlier: [] };
  for (const thread of threads) {
    if (inConversation(thread)) continue;
    const last = seen?.[thread.id];
    const waiting = Boolean(seen) && waitsOnYou(board, thread, me, last);
    const entry: ThreadEntry = {
      thread,
      waiting,
      unread: Boolean(seen) && threadUnread(thread, me, last),
      tag: threadTag(thread, board),
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

// The work threads waiting on this viewer, the latest first: the threads
// button's count. An answer in the conversation they have yet to see is not
// counted: the conversation marks what is new itself.
export function threadsWaitingOn(board: Board, me: string, seen: ThreadsSeen | null): Thread[] {
  return waitingOn(board, me, seen).filter((t) => !inConversation(t));
}

// The threads of the conversation waiting on this viewer, the latest first:
// an answer to what they asked, or an agent's question to the board, that
// they have yet to see. The bell says them as one row (core/bell.ts).
export function conversationWaitingOn(board: Board, me: string, seen: ThreadsSeen | null): Thread[] {
  return waitingOn(board, me, seen).filter(inConversation);
}

// Every thread waiting on this viewer, the latest first.
export function waitingOn(board: Board, me: string, seen: ThreadsSeen | null): Thread[] {
  if (!seen) return [];
  return (board.threads ?? []).filter((t) => waitsOnYou(board, t, me, seen[t.id])).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// The decisions and tasks an agent made from a conversation this person is
// part of (one they started or wrote in), by id: what lands on the board from
// their own thread, which stays lit until they've seen it (web/justMade.ts).
export function cardsFromYourThreads(board: Board, me: string): string[] {
  const yours = new Set(
    (board.threads ?? [])
      .filter((t) => (t.startedBy.kind === 'human' && samePerson(t.startedBy.name, me)) || t.messages.some((m) => mine(m, me)))
      .map((t) => t.id),
  );
  return cardsOf(board)
    .filter((c) => c.createdBy?.kind === 'agent' && c.fromThread && yours.has(c.fromThread.id))
    .map((c) => c.id);
}
