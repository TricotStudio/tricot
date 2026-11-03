// What an agent needs to answer a person's comment or thread message from its
// updates alone, without reading the card or thread first: the whole message,
// who wrote it, the card's title and status, the messages before it, and the
// call that answers it (the lines in mentions.ts, threads.ts and digest.ts say
// who it's for and how to reply). Each MCP session keeps what it has been
// shown (Shown), so a message's text reaches an agent once, and the context
// around it only as far as the agent hasn't read it: a follow-up in a
// discussion it is in costs a line or two, and a new session gets it once.

import { clip, samePerson } from './format';
import { TASK_STATUS_WORDS } from './pins';
import type { Actor, Board, BoardEvent, Decision, Pin, Task, Thread } from './types';

// Something said in a discussion: a comment, or a thread message.
export interface Said {
  id: string;
  author: Actor;
  body: string;
}

// A card's comments, a thread's messages, or the comment thread on a pin in
// the board context: where a message is.
export interface Discussion {
  key: string;
  items: Said[];
  noun: 'comment' | 'message';
  read: string; // the call that reads all of it
  heading?: string; // the card's title and status: told once per session, and again when it changes
}

export function taskDiscussion(task: Task): Discussion {
  const claimed = task.claimedBy && task.status !== 'todo' ? `, claimed by ${task.claimedBy.name}` : '';
  const heading = `T${task.number} "${clip(task.title, 80)}": ${TASK_STATUS_WORDS[task.status]}${claimed}.`;
  return { key: `task:${task.id}`, items: task.comments, noun: 'comment', read: 'get_task', heading };
}

export function decisionDiscussion(decision: Decision): Discussion {
  const option = decision.options.find((o) => o.id === decision.resolution?.optionId);
  const answer = decision.resolution ? (option ? `, ${option.id}) ${clip(option.label, 80)}` : ', answered in words') : '';
  const heading = `#${decision.number} "${clip(decision.question, 100)}": ${decision.status}${answer}.`;
  return { key: `decision:${decision.id}`, items: decision.comments, noun: 'comment', read: 'get_decision', heading };
}

// A thread's heading is its lens, which its lines say (threads.ts).
export function threadDiscussion(thread: Thread, heading?: string): Discussion {
  return { key: `thread:${thread.id}`, items: thread.messages, noun: 'message', read: 'get_thread', heading };
}

export function pinDiscussion(board: Board, pin: Pin): Discussion {
  return { key: `pin:${pin.id}`, items: pin.discussion?.thread ?? [], noun: 'comment', read: `get_canvas(board_id: ${board.id})` };
}

// The discussion an event added a comment or message to, and what was said,
// by the id the event gives (events logged before they gave one have none).
export function discussionAt(event: BoardEvent, board: Board): { discussion: Discussion; said: Said } | undefined {
  const id = event.commentId;
  if (!id) return undefined;
  const find = (discussion: Discussion | undefined) => {
    const said = discussion?.items.find((m) => m.id === id);
    return discussion && said ? { discussion, said } : undefined;
  };
  if (event.taskId) {
    const task = board.tasks.find((t) => t.id === event.taskId);
    return find(task && taskDiscussion(task));
  }
  if (event.decisionId) {
    const decision = board.decisions.find((d) => d.id === event.decisionId);
    return find(decision && decisionDiscussion(decision));
  }
  if (event.type.startsWith('thread_')) {
    const thread = board.threads?.find((t) => t.id === event.itemId);
    return find(thread && threadDiscussion(thread));
  }
  const pin = board.canvas.pins.find((p) => p.id === event.itemId);
  return find(pin && pinDiscussion(board, pin));
}

// What one MCP session has been shown of what people and agents said: the
// messages it got whole, those it glimpsed cut short as context, and each
// card's heading as it last saw it.
export class Shown {
  private readonly whole = new Set<string>();
  private readonly glimpsed = new Set<string>();
  private readonly headings = new Map<string, string>();
  private latest = new Set<string>(); // given in the result being made

  // A new result: a digest later in it leaves out what an update above gave.
  begin(): void {
    this.latest = new Set();
  }

  read(id: string): void {
    this.whole.add(id);
    this.latest.add(id);
  }

  // Shown as context, cut short; one short enough to show whole counts as read.
  glimpse(said: Said): void {
    if (said.body.length <= BEFORE_CLIP) this.whole.add(said.id);
    else this.glimpsed.add(said.id);
  }

  hasRead(id: string): boolean {
    return this.whole.has(id);
  }

  hasSeen(id: string): boolean {
    return this.whole.has(id) || this.glimpsed.has(id);
  }

  inThisResult(id: string): boolean {
    return this.latest.has(id);
  }

  // Whether a heading is news to the session: never shown, or changed since.
  // Answering yes records it as shown.
  heading(key: string, text: string): boolean {
    if (this.headings.get(key) === text) return false;
    this.headings.set(key, text);
    return true;
  }

  // A card or thread read in full (get_task, get_decision, get_thread).
  readAll(discussion: Discussion): void {
    for (const said of discussion.items) this.whole.add(said.id);
    if (discussion.heading) this.headings.set(discussion.key, discussion.heading);
  }
}

const BEFORE = 3; // messages before the one to answer, at most
const BEFORE_CLIP = 200;

// A message quoted whole, its lines kept and indented under the update's.
export function whole(text: string): string {
  return `"${text.trim().replace(/\n(?!\n)/g, '\n  ')}"`;
}

// What follows the words naming a message in an update: all of it, or for
// one this session has read already, that it has.
export function quote(text: string, id: string, shown: Shown | undefined): string {
  return shown?.hasRead(id) ? " (you've seen it)" : `: ${whole(text)}`;
}

function speaker(author: Actor, viewer: string | undefined): string {
  return author.kind === 'agent' && viewer && samePerson(author.name, viewer) ? 'you' : `${author.name} (${author.kind})`;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

// The lines under a message an agent is to answer, for its session: the
// card's heading if it's news to the session, then the messages before it
// since the last one the session was shown, the latest few cut short, with a
// count of the rest, so it knows nothing is missing. The message and what
// they show are the session's from then on. None for a message it has read
// already, nor without a session (a digest read on its own).
export function answerContext(discussion: Discussion, said: Said, viewer: string | undefined, shown: Shown | undefined): string[] {
  if (!shown) return [];
  if (shown.hasRead(said.id)) {
    shown.read(said.id); // a digest later in this result leaves it out too
    return [];
  }
  const lines: string[] = [];
  if (discussion.heading && shown.heading(discussion.key, discussion.heading)) lines.push(`  ${discussion.heading}`);
  const at = discussion.items.findIndex((m) => m.id === said.id);
  const before = at < 0 ? [] : discussion.items.slice(0, at);
  const listed = before.slice(before.findLastIndex((m) => shown.hasSeen(m.id)) + 1).slice(-BEFORE);
  const seen = before.filter((m) => shown.hasSeen(m.id)).length;
  const older = before.length - seen - listed.length; // never shown, and before what it was
  const counts = [seen && `${count(seen, discussion.noun)} you've seen`, older && `${older} older in ${discussion.read}`].filter(Boolean);
  if (listed.length) {
    lines.push(`  Before it${counts.length ? ` (${counts.join('; ')})` : ''}:`);
    for (const m of listed) lines.push(`  - ${speaker(m.author, viewer)}: "${clip(m.body, BEFORE_CLIP)}"`);
  } else if (counts.length) {
    lines.push(`  Before it: ${counts.join('; ')}.`);
  }
  for (const m of listed) shown.glimpse(m);
  shown.read(said.id);
  return lines;
}
