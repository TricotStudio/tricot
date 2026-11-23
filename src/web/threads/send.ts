import { resolveMentions } from '../../core/mentions';
import { pageLens } from '../../core/scratchPad';
import { threadTitle } from '../../core/threads';
import type { Actor, MessageLens, ScratchPage, Thread, ThreadDoor, ThreadLens, ThreadMessage } from '../../core/types';
import { newestMine, outbox, type Outgoing } from '../conversation';
import { api } from '../shared/api';

// Sending to threads, wherever a conversation is drawn: the docked panel
// (threads.tsx) and Home's main pane (timeline.tsx). What is sent is drawn at
// once from the outbox (conversation/outbox.ts), and settles when the board
// has it. Each send says how to make it again, as plain data, so one a reload
// brought back "Not sent" can be sent with Retry: a reply by its thread, a
// new thread by what started it, with the stand-in Home draws it in until
// then (`unsentStarts`).

// A thread just started, drawn until the server has it: its first message is
// in the outbox. Nothing is sent to it, nor changed on it.
const LOCAL = 'local-';
export const isLocal = (thread: Pick<Thread, 'id'> | undefined): boolean => Boolean(thread?.id.startsWith(LOCAL));

// A message being sent, drawn until the board has it.
export function draftMessage(o: Outgoing, name: string, names: string[]): ThreadMessage {
  const mentions = resolveMentions(o.body, names);
  return { id: o.key, author: { kind: 'human', name }, body: o.body, at: o.at, ...(o.lens && { lens: o.lens }), ...(mentions.length && { mentions }) };
}

// A reply in a thread the server has.
interface Reply {
  threadId: string;
  name: string;
  text: string;
  own?: MessageLens;
  known: string[];
}
const postReply = async (r: Reply) => newestMine((await api.postToThread(r.threadId, r.name, r.text, r.own)).messages, r.known, r.name, r.text);
outbox.resends('thread-reply', (what) => postReply(what as Reply));

export function replyInThread(thread: Thread, name: string, text: string, own?: MessageLens): void {
  const reply: Reply = { threadId: thread.id, name, text, ...(own && { own }), known: thread.messages.map((m) => m.id) };
  outbox.send(`thread:${thread.id}`, text, reply.known, () => postReply(reply), own, { kind: 'thread-reply', with: reply });
}

export interface NewThread {
  boardId: string;
  name: string;
  names: string[]; // who the text can @-mention, for its title
  text: string;
  door: ThreadDoor;
  lens: ThreadLens | null;
  own?: MessageLens;
  page?: ScratchPage; // over a Sketchbook page, about it
  blockIds?: string[]; // and the blocks selected on it
  file?: string; // in Files, about the file at this path
  to?: string; // over a page or a file, the agent it goes to: the page's or the file's, while it is on the board (core/whoAnswers.ts)
}

// A new thread, its first message sent: the stand-in drawn until the server
// has it, and the server's thread once it answers (`made`, also told to
// `onMade`), which the outbox then draws the message in.
export function startThread(o: NewThread, onMade: (made: Thread) => void): { local: Thread; made: () => Thread | null } {
  const at = new Date().toISOString();
  const me: Actor = { kind: 'human', name: o.name };
  // Over a page, or a file, routed as the server will route it (core/scratchPad.ts pageLens, core/store/threads.ts).
  const routed = o.to ? pageLens({ agent: { name: o.to } }, o.lens) : o.lens;
  const local: Thread = {
    id: `${LOCAL}${Date.now().toString(36)}`,
    title: threadTitle(o.text, resolveMentions(o.text, o.names)),
    door: o.door,
    ...(o.page && { pageId: o.page.id }),
    ...(o.page && o.blockIds?.length && { blockIds: o.blockIds }),
    startedBy: me,
    startedAt: at,
    updatedAt: at,
    messages: [],
    ...(routed && { lens: routed }),
  };
  let answered: Thread | null = null;
  const start: Start = { boardId: o.boardId, name: o.name, text: o.text, lens: o.lens, door: o.door, own: o.own, pageId: o.page?.id, blockIds: o.blockIds, file: o.file, local };
  const post = async (key: string) => {
    const made = await postStart(start, key);
    answered = made;
    onMade(made);
    return { id: made.messages[0].id, place: `thread:${made.id}` };
  };
  outbox.send(`thread:${local.id}`, o.text, [], post, o.own, { kind: 'thread-start', with: start });
  return { local, made: () => answered };
}

// What starts a new thread, as plain data, and the stand-in drawn for it.
interface Start {
  boardId: string;
  name: string;
  text: string;
  lens: ThreadLens | null;
  door: ThreadDoor;
  own?: MessageLens;
  pageId?: string;
  blockIds?: string[];
  file?: string;
  local: Thread;
}
async function postStart(s: Start, key: string): Promise<Thread> {
  const made = await api.startThread(s.boardId, s.name, s.text, s.lens ?? undefined, s.door, s.own, s.pageId, s.blockIds, s.file);
  outbox.arrived(key, { id: made.messages[0].id, place: `thread:${made.id}` }); // drawn in the thread the server made under the same key
  return made;
}
outbox.resends('thread-start', async (what, key) => {
  const made = await postStart(what as Start, key);
  return { id: made.messages[0].id, place: `thread:${made.id}` };
});

// The stand-ins of the threads started on this board that a reload brought
// back not sent yet: Home draws them, as it drew them before the reload.
export function unsentStarts(boardId: string): Thread[] {
  return outbox.get().flatMap((o) => {
    const start = o.again?.kind === 'thread-start' ? (o.again.with as Start) : undefined;
    return start?.boardId === boardId && o.place === `thread:${start.local.id}` ? [start.local] : [];
  });
}
