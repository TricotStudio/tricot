import { resolveMentions } from '../../core/mentions';
import { pageLens } from '../../core/scratchPad';
import { threadTitle } from '../../core/threads';
import type { Actor, MessageLens, ScratchPage, Thread, ThreadDoor, ThreadLens, ThreadMessage } from '../../core/types';
import { newestMine, outbox, type Outgoing } from '../conversation';
import { api } from '../shared/api';

// Sending to threads, wherever a conversation is drawn: the docked panel
// (threads.tsx) and Home's main pane (timeline.tsx). What is sent is drawn at
// once from the outbox (conversation/outbox.ts), and settles when the board
// has it.

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
export function replyInThread(thread: Thread, name: string, text: string, own?: MessageLens): void {
  const known = thread.messages.map((m) => m.id);
  outbox.send(`thread:${thread.id}`, text, known, async () => newestMine((await api.postToThread(thread.id, name, text, own)).messages, known, name, text), own);
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
  file?: { path: string; agent?: string }; // in Files, about a file, and the agent last asked about it
}

// A new thread, its first message sent: the stand-in drawn until the server
// has it, and the server's thread once it answers (`made`, also told to
// `onMade`), which the outbox then draws the message in.
export function startThread(o: NewThread, onMade: (made: Thread) => void): { local: Thread; made: () => Thread | null } {
  const at = new Date().toISOString();
  const me: Actor = { kind: 'human', name: o.name };
  // Over a page, or a file, routed as the server will route it (core/scratchPad.ts pageLens).
  const routed = o.page ? pageLens(o.page, o.lens) : o.file?.agent ? pageLens({ agent: { name: o.file.agent } }, o.lens) : o.lens;
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
  const post = async (key: string) => {
    const made = await api.startThread(o.boardId, o.name, o.text, o.lens ?? undefined, o.door, o.own, o.page?.id, o.blockIds, o.file?.path);
    const sent = { id: made.messages[0].id, place: `thread:${made.id}` };
    answered = made;
    outbox.arrived(key, sent); // drawn in the thread the server made under the same key
    onMade(made);
    return sent;
  };
  outbox.send(`thread:${local.id}`, o.text, [], post, o.own);
  return { local, made: () => answered };
}
