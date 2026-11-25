import type { Canvases } from './canvases';
import { BoardError } from './errors';
import type { EventQuery } from './eventTables';
import { BLOCKS_GROUP, CARDS_GROUP, groupBeside } from './groupBeside';
import type { LensInput, Located } from './inputs';
import type { People } from './people';
import type { Pins } from './pins';
import type { BoardRepository } from './repository';
import { guardArchived, limited, optional, randomId, required } from './validate';
import { boardCardKindNamed, boardCardKinds, cardOf, cardsOfKind } from '../cards';
import { clip, listNames, samePerson } from '../format';
import { agentsIn, boardAgents } from '../mentions';
import { refKinds } from '../refKinds';
import { agentOnFile, onFiles } from '../fileThread';
import { requestCardsHeight, requestTitle } from '../requests';
import { pageLens, pageName } from '../scratchPad';
import { onBoardNow } from '../whoAnswers';
import { blocksWords, selectionBlocks, selectionGroup, selectionPage, threadCards } from '../threadSelection';
import { LENS_BRIEF_LIMIT, LENS_NAME_LIMIT, THREAD_TEXT_LIMIT, TITLE_LENGTH, lensName, presetLens, sameLens, showsWork, threadTitle, threadWork } from '../threads';
import { inConversation, STATUS_WORDS, verdictMessage, type ReviewVerdict } from '../roles';
import { type Actor, type Block, type Board, type Group, type MessageLens, type ScratchPage, type Thread, type ThreadDoor, type ThreadLens, type ThreadMessage, type ThreadRef, type ThreadStatus, boardKey } from '../types';

// How a thread starts besides its message and lens: as the board's General
// thread, or from a tab's chat bar (its door), over a Sketchbook page
// (pageId), with blocks selected there (blockIds: it is about them), or
// in Files, about the file open there (`file`: the path its block is
// named by, and how to make or bring up the block, which is done once the
// thread can start and no sooner); and the lens its first message asks for in
// a ^Name of its own (messageLens), which is not the thread's.
export interface ThreadStart {
  general?: boolean;
  door?: ThreadDoor;
  pageId?: string;
  blockIds?: string[];
  file?: { named: string; make: () => { page: ScratchPage; block: Block } };
  messageLens?: LensInput | null;
  // One a coordinator sends work to (routeToThread): its title, and the agent
  // that owns it, where its work stands and which agent Tricot starts as it.
  title?: string;
  owner?: { name: string; status?: ThreadStatus; launch?: string };
}

// Where a coordinator sends a person's message on to (core/roles.ts): a thread
// of the board, or a new one, titled, that an orchestrator owns, which Tricot's
// terminal starts as `launch`; or, with none, that the coordinator owns itself.
export type RouteTarget = { threadId: string } | { title: string; brief?: string; owner: string; launch?: string };

export interface Routed {
  from: Thread; // where it was asked
  to: Thread;
  started: boolean; // `to` is new
  moved: boolean; // the message moved to `to`, and `from`, which held nothing else, is gone
}

// Whether a thread holds nothing but the person's message sent on, as one the chat bar starts does until it is
// answered: none of its own blocks, cards or other messages, and no owner but the coordinator sending it on.
const alone = (thread: Thread, messageId: string, actor: Actor): boolean =>
  thread.messages.length === 1 && thread.messages[0].id === messageId && !thread.general && !thread.blockIds?.length && !thread.pending?.length && !thread.messages[0].refs?.length && (!thread.owner || samePerson(thread.owner, actor.name));

// How long a quote of the message sent on may be, in the thread it goes to.
const QUOTED = 4000;

// Why a thread of the board's conversation takes no status (setThreadStatus), and what to do instead: send the person's
// latest message not sent on yet to a thread of its own, whose status is then set.
function quickQuestionWords(thread: Thread): string {
  const sentOn = new Set(thread.messages.flatMap((m) => (m.sent ? [m.sent.messageId] : [])));
  const asked = thread.messages.findLast((m) => m.author.kind === 'human' && !sentOn.has(m.id));
  const send = asked
    ? `Send ${asked.author.name}'s message on with route_to_thread first (thread_id: ${thread.id}, message_id: ${asked.id}, and a title for new work)`
    : "Send a person's message on with route_to_thread first";
  return `Thread "${clip(thread.title, 60)}" is a quick question in the board's conversation, so it has no status to set: work goes in a thread of its own. ${send}, then say where the work stands in the thread it goes to.`;
}

// Threads: conversations through which people work on the project with agents. A person (or an agent)
// starts one with a message, and agents answer in it, through its lens. A message's @-mentions say which
// agents it's for. See core/threads.
export class Threads {
  constructor(
    private readonly repo: BoardRepository,
    private readonly people: People,
    private readonly canvases: Canvases,
    private readonly pins: Pins,
  ) {}

  // `general` starts the board's General thread (askInGeneral), titled so;
  // `door`, one a person started from a tab's chat bar, aimed at what that
  // tab holds (core/doors.ts); `pageId`, from the bar over a Sketchbook page,
  // about that page, and routed to the agent that made it while it is on the
  // board (core/scratchPad.ts, core/whoAnswers.ts);
  // `blockIds`, with blocks selected there, about them (core/threadSelection.ts);
  // `file`, in Files, about the file open there: its block on the Files canvas,
  // which the thread is started on (core/fileThread.ts), routed to the agent
  // last asked about the file while it is on the board.
  //
  // While coordinators are on the board (core/roles.ts), one a person starts
  // from a chat bar is the one it @-mentions, else the agent of its page or
  // file, or its lens's, where that is one, else the one seen last; one that
  // @-mentions another agent, or goes to an agent that coordinates nothing, is
  // no coordinator's.
  startThread(boardId: string, body: string, actor: Actor, lens?: LensInput | null, { general = false, door, pageId, blockIds, file, messageLens, title, owner: given }: ThreadStart = {}): Thread {
    const board = this.repo.getBoard(boardId);
    guardArchived(board);
    const text = limited(required(body, 'A message'), THREAD_TEXT_LIMIT, 'A message');
    if (file && (pageId !== undefined || blockIds?.length)) throw new BoardError("A thread about a file is started on the file alone: leave out the page and the blocks.");
    const over = pageId === undefined ? undefined : board.pages?.find((p) => p.id === pageId);
    if (pageId !== undefined && !over) throw new BoardError(`No Sketchbook page "${pageId}" on ${board.title}.`, 'not_found');
    const picked = blockIds?.length ? this.selectedOn(over, blockIds) : [];
    // Routed to the page's agent, or the agent last asked about the file, while it is on the board, as the chat bar names
    // it (core/whoAnswers.ts); else, as asked: once that agent has gone, the coordinator or any agent here takes it.
    const present = this.repo.presentAgents(boardKey(board));
    const asked = onBoardNow(over?.agent?.name ?? (file ? agentOnFile(board, file.named, boardAgents(board, present)) : undefined), present);
    const chosen = this.lensOf(board, asked ? pageLens({ agent: { name: asked } }, lens) : lens);
    const own = this.messageLensOf(chosen, messageLens);
    const id = this.repo.newThreadId();
    const now = new Date().toISOString();
    const { mentions, skill } = this.people.requestIn(board, text, actor);
    // A coordinator it @-mentions, alone among agents, takes it; one that mentions none goes to the agent it is routed to
    // where that coordinates, else to the one seen last.
    const fromBar = actor.kind === 'human' && !general && (door !== undefined || pageId !== undefined || file !== undefined);
    const named = agentsIn(board, mentions);
    const coordinators = fromBar && named.length <= 1 ? this.repo.coordinatorsOf(boardKey(board)) : [];
    const routedTo = chosen?.agent;
    const coordinator = coordinators.find((c) => samePerson(c, named[0] ?? routedTo ?? c));
    const owner = given ?? (coordinator ? { name: coordinator } : undefined);
    const titled = title === undefined ? undefined : threadTitle(limited(required(title, 'A title'), TITLE_LENGTH * 3, 'A title'));
    // Nothing above is left to refuse it, so a file's block is made only for a thread that starts.
    const onFile = file?.make();
    const page = onFile?.page ?? over;
    const selected = onFile ? [onFile.block] : picked;
    const thread: Thread = {
      id,
      title: general ? 'General' : (titled ?? threadTitle(text, mentions, agentsIn(board, mentions))),
      ...(general && { general: true as const }),
      ...(chosen && { lens: chosen }),
      ...(door && { door }),
      ...(page && { pageId: page.id }),
      ...(selected.length && { blockIds: selected.map((b) => b.id) }),
      ...(owner && { owner: owner.name }),
      ...(owner?.status && { status: owner.status }),
      ...(owner?.launch && { launch: owner.launch }),
      startedBy: actor,
      startedAt: now,
      updatedAt: now,
      messages: [{ id: randomId(8), author: actor, body: text, at: now, ...(own ? { lens: own } : {}), ...(mentions.length ? { mentions } : {}), ...(skill ? { skill } : {}) }],
    };
    const first = thread.messages[0];
    board.threads = [...(board.threads ?? []), thread];
    this.repo.indexThread(id, board);
    const about = onFile?.block.type === 'code' ? ` about ${onFile.block.path} on ${pageName(onFile.page)}` : selected.length ? ` about ${blocksWords(selected.length)} on ${pageName(page!)}` : '';
    const through = `${chosen ? `, through the ${chosen.name} lens` : ''}${own ? `, its first message through the ${own.name} lens` : ''}`;
    this.repo.record(board, actor, 'thread_started', `started thread "${clip(thread.title, 60)}"${about}${through}`, { item: id }, { at: now, mentions, commentId: first.id });
    return thread;
  }

  // A pairing session's thread (core/roles.ts pairingThread), made by the
  // person's first request in it: theirs, about the page paired on (none for
  // the board context) and no block of it, its first message what they asked,
  // owned by the session's agent at work, which Tricot's terminal starts as
  // `launch`. It is no chat bar's, so no coordinator takes it.
  startPairingThread(board: Board, page: ScratchPage | undefined, actor: Actor, title: string, body: string, owner: { name: string; launch: string }): Thread {
    guardArchived(board);
    const text = limited(required(body, 'A message'), THREAD_TEXT_LIMIT, 'A message');
    const id = this.repo.newThreadId();
    const now = new Date().toISOString();
    const thread: Thread = {
      id,
      title: threadTitle(limited(required(title, 'A title'), TITLE_LENGTH * 3, 'A title')),
      ...(page && { pageId: page.id }),
      owner: owner.name,
      status: 'working',
      launch: owner.launch,
      startedBy: actor,
      startedAt: now,
      updatedAt: now,
      messages: [{ id: randomId(8), author: actor, body: text, at: now }],
    };
    board.threads = [...(board.threads ?? []), thread];
    this.repo.indexThread(id, board);
    const where = page ? pageName(page) : 'the board context';
    this.repo.record(board, actor, 'thread_started', `started pairing thread "${clip(thread.title, 60)}" with ${owner.name}, on ${where}`, { item: id }, { at: now, commentId: thread.messages[0].id });
    return thread;
  }

  // The blocks a thread is started about, which must be on the page it is
  // started over, in canvas order.
  private selectedOn(page: ScratchPage | undefined, blockIds: string[]) {
    if (!page) throw new BoardError('Select blocks on a Sketchbook page to start a thread about them: pass the page too.');
    const wanted = new Set(blockIds);
    const blocks = page.canvas.blocks.filter((b) => wanted.has(b.id));
    const stray = [...wanted].filter((id) => !blocks.some((b) => b.id === id));
    if (stray.length) throw new BoardError(`${stray.length === 1 ? `"${stray[0]}" is` : `${stray.length} of them are`} not a block on ${pageName(page)}. Select blocks there.`);
    return blocks;
  }

  // The Board Context's Ask agents bar posted into the board's General thread,
  // which the first ask started; a deleted one is started again. The chat bar
  // starts a thread of its own through the Board Context's door now
  // (core/doors.ts); this stays for a page or script that still asks here.
  // Asking there replaced requests (core/requests.ts): older boards keep
  // theirs, and agents still take and finish them.
  askInGeneral(boardId: string, text: string, actor: Actor): Thread {
    if (actor.kind !== 'human') throw new BoardError('Only people ask from the Board Context; answer in the General thread with reply_in_thread.');
    const general = this.repo.getBoard(boardId).threads?.findLast((t) => t.general);
    return general ? this.postToThread(general.id, text, actor) : this.startThread(boardId, text, actor, undefined, { general: true });
  }

  // A new lens for a thread: agents answer through it from then on. General
  // (or null) takes it off.
  setThreadLens(threadId: string, lens: LensInput | null, actor: Actor): Thread {
    const { board, thread } = this.repo.getThread(threadId);
    guardArchived(board);
    const chosen = this.lensOf(board, lens);
    if (sameLens(thread.lens, chosen)) return thread;
    if (chosen) thread.lens = chosen;
    else delete thread.lens;
    const routed = chosen?.agent ? `, routed to ${chosen.agent}` : '';
    const summary = `set the lens of thread "${clip(thread.title, 60)}" to ${lensName(thread)}${routed}`;
    this.repo.record(board, actor, 'thread_lens_changed', summary, { item: thread.id });
    return thread;
  }

  // A lens as chosen: a preset by its name (its brief unless one is given),
  // or one's own, which needs a brief; and the agent it's routed to, one of
  // the board's. General with neither brief nor agent is no lens at all.
  private lensOf(board: Board, input: LensInput | null | undefined): ThreadLens | undefined {
    if (!input) return undefined;
    const name = limited(required(input.name, 'A lens name').replace(/\s+/g, ' '), LENS_NAME_LIMIT, 'A lens name');
    const preset = presetLens(name);
    const given = optional(input.brief)?.replace(/\s+/g, ' ');
    const brief = given ? limited(given, LENS_BRIEF_LIMIT, 'A lens brief') : preset?.brief;
    if (!preset && !brief) throw new BoardError(`A lens of your own needs a brief: a sentence or two on how agents should answer through "${name}".`);
    let agent: string | undefined;
    if (optional(input.agent)) {
      const agents = boardAgents(board, this.repo.presentAgents(boardKey(board)));
      agent = agents.find((a) => samePerson(a, input.agent!.trim()));
      if (!agent) {
        const known = agents.length ? ` Its agents: ${listNames(agents)}.` : ' No agent has used it yet.';
        throw new BoardError(`No agent named "${input.agent!.trim()}" on this board.${known}`);
      }
    }
    if (preset?.name === 'General' && !given && !agent) return undefined;
    return { name: preset?.name ?? name, ...(brief && { brief }), ...(agent && { agent }) };
  }

  // The lens a person asked for on one message (^Name), as it is kept: a
  // preset by its name, one's own with its brief. Never an agent. None when
  // none was asked, or it is the lens the thread already has: there is nothing
  // to say in place of it. General is kept where the thread has another lens,
  // for a message that asks for none.
  private messageLensOf(threadLens: Pick<ThreadLens, 'name' | 'brief'> | undefined, input: LensInput | null | undefined): MessageLens | undefined {
    if (!input) return undefined;
    const name = limited(required(input.name, 'A lens name').replace(/\s+/g, ' '), LENS_NAME_LIMIT, 'A lens name');
    const preset = presetLens(name);
    const brief = optional(input.brief)?.replace(/\s+/g, ' ');
    if (!preset && !brief) throw new BoardError(`A lens of your own needs a brief: a sentence or two on how agents should answer through "${name}".`);
    const lens: MessageLens = preset ? { name: preset.name } : { name, brief: limited(brief!, LENS_BRIEF_LIMIT, 'A lens brief') };
    const now = threadLens ?? { name: 'General' };
    return lens.name === now.name && lens.brief === (preset ? undefined : now.brief) ? undefined : lens;
  }

  // A message in a thread. One from whoever made work answering it (thread_id)
  // ahead of it shows that work under it, and the cards it names (refs: ids,
  // #N or TN) too. A person's may ask for a lens (^Name) on this message alone.
  // A person's message in a thread whose work waits on people or is done sets
  // it back to work, and Tricot starts its owner again if it is gone
  // (core/roles.ts). One in a thread whose work waits for their review leaves
  // it there: only their verdict sets it back (reviewThread).
  // `routed`: a coordinator's word that it sent a message on.
  // `movedFrom`: a person's message a coordinator moved here, from the thread it was asked in.
  postToThread(threadId: string, body: string, actor: Actor, refs: string[] = [], messageLens?: LensInput | null, routed?: { sent: NonNullable<ThreadMessage['sent']>; summary: string }, movedFrom?: string): Thread {
    const { board, thread } = this.repo.getThread(threadId);
    guardArchived(board);
    const text = limited(required(body, 'A message'), THREAD_TEXT_LIMIT, 'A message');
    const own = actor.kind === 'human' ? this.messageLensOf(thread.lens, messageLens) : undefined;
    const named = refs.map((raw) => this.threadRefOf(board, raw));
    const now = new Date().toISOString();
    const { mentions, skill } = this.people.requestIn(board, text, actor);
    const via = this.people.viaSkill(thread.messages, actor);
    const held = this.people.heldIn(board, thread.messages, actor, mentions);
    const mine = (p: { by: Actor }) => p.by.kind === actor.kind && samePerson(p.by.name, actor.name);
    const made = (thread.pending ?? []).filter(mine).map(({ by: _by, ...ref }) => ref);
    const pending = thread.pending?.filter((p) => !mine(p));
    if (pending?.length) thread.pending = pending;
    else delete thread.pending;
    // What it names shows again, should an earlier message show it too.
    const shown: ThreadRef[] = [];
    for (const ref of [...made, ...named]) if (!shown.some((r) => r.kind === ref.kind && r.id === ref.id)) shown.push(ref);
    // What it names that this agent made since the thread started, from nowhere else, came from it.
    // The log says what came first, even within a millisecond.
    const seqOf = (query: EventQuery) => this.repo.events(board, { ...query, order: 'asc', limit: 1 })[0]?.seq ?? -1;
    const started = seqOf({ types: ['thread_started'], itemId: thread.id });
    const fromHere: ThreadRef[] = [];
    for (const ref of named) {
      const item = cardOf(board, ref.kind, ref.id);
      if (!item || item.fromThread || !item.createdBy || !samePerson(item.createdBy.name, actor.name)) continue;
      const made = seqOf({ ...(item.kind.postedIn && { types: [item.kind.postedIn] }), [`${ref.kind}Id`]: item.id });
      if (made > started) {
        item.setFromThread({ id: thread.id, title: thread.title });
        fromHere.push(ref);
        this.besideBlocks(board, thread, ref, actor);
      }
    }
    this.repo.alsoSave(board, Object.fromEntries(boardCardKinds().map(({ kind }) => [`${kind}Ids`, fromHere.filter((r) => r.kind === kind).map((r) => r.id)])));
    const message: ThreadMessage = {
      id: randomId(8),
      author: actor,
      body: text,
      at: now,
      ...(own ? { lens: own } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(skill ? { skill } : {}),
      ...(via ? { via } : {}),
      ...(shown.length ? { refs: shown } : {}),
      ...(held ? { held } : {}),
      ...(routed && { sent: routed.sent }),
      ...(movedFrom && { movedFrom }),
    };
    thread.messages.push(message);
    thread.updatedAt = now;
    if (actor.kind === 'human' && (thread.status === 'needs-you' || thread.status === 'done')) thread.status = 'working';
    const summary = routed?.summary ?? `replied in thread "${clip(thread.title, 60)}"${own ? `, through the ${own.name} lens` : ''}: "${clip(text, 200)}"`;
    this.repo.record(board, actor, routed ? 'thread_routed' : 'thread_replied', summary, { item: thread.id }, { at: now, mentions, commentId: message.id, held: Boolean(held) });
    return thread;
  }

  // A coordinator sends a person's message on (core/roles.ts): to a thread of
  // the board, as its message quoting the person's, or to a new one that an
  // orchestrator owns, which it starts with that quote and the coordinator's
  // brief. Where it was asked, the coordinator says where it went, which
  // answers it there, and which the page follows (Thread.messages' `sent`).
  // A follow-up asked in a thread of its own that holds nothing else, as the
  // chat bar starts one, moves to the thread it follows up, as the person's
  // own message there, and the thread it was asked in goes: the person's
  // conversation stays one thread, and the page follows the message
  // (Thread.messages' `movedFrom`).
  routeToThread(fromThreadId: string, messageId: string, actor: Actor, target: RouteTarget): Routed {
    if (actor.kind !== 'agent') throw new BoardError("Only an agent sends a message on to a thread: a person moves to the thread and says it there.");
    const { board, thread: from } = this.repo.getThread(fromThreadId);
    guardArchived(board);
    const message = from.messages.find((m) => m.id === messageId);
    if (!message) throw new BoardError(`No message "${clip(messageId, 40)}" in thread "${clip(from.title, 60)}": pass a message id as get_thread lists it.`, 'not_found');
    if (message.author.kind !== 'human') throw new BoardError(`That message is ${message.author.name}'s: send on what a person asked.`);
    const before = from.messages.find((m) => m.sent?.messageId === messageId);
    const went = before && board.threads?.find((t) => t.id === before.sent!.threadId);
    if (went) throw new BoardError(`That message was sent on already, to thread "${clip(went.title, 60)}" [thread id: ${went.id}].`);
    const quoted = clip(message.body, QUOTED).split('\n').map((line) => `> ${line}`).join('\n');
    const asked = `${message.author.name} asked in "${clip(from.title, 60)}":\n\n${quoted}`;
    let to: Thread;
    let started = false;
    if ('threadId' in target) {
      to = this.threadOn(target.threadId, board);
      if (to.id === from.id) throw new BoardError("That's the thread it was asked in: send it to another, or answer it here with reply_in_thread.");
      if (alone(from, messageId, actor)) {
        this.postToThread(to.id, message.body, message.author, [], undefined, undefined, from.id);
        board.threads = board.threads!.filter((t) => t !== from);
        this.repo.unindexThread(from.id);
        this.repo.record(board, actor, 'thread_routed', `moved ${message.author.name}'s message from thread "${clip(from.title, 60)}", which held nothing else, into thread "${clip(to.title, 60)}"`, { item: to.id });
        return { from, to, started: false, moved: true };
      }
      // A follow-up sets its work back to work, as the person's own message would; one waiting for review stays there.
      if (to.status && to.status !== 'working' && to.status !== 'in-review') to.status = 'working';
      this.postToThread(to.id, asked, actor);
    } else {
      const brief = optional(target.brief);
      to = this.startThread(board.id, brief ? `${asked}\n\n${brief}` : asked, actor, undefined, { title: target.title, owner: { name: target.owner, status: 'working', launch: target.launch } });
      started = true;
    }
    const summary = `sent ${message.author.name}'s message in thread "${clip(from.title, 60)}" on to thread "${clip(to.title, 60)}"`;
    this.postToThread(from.id, `Sent to "${to.title}".`, actor, [], undefined, { sent: { threadId: to.id, messageId }, summary });
    return { from, to, started, moved: false };
  }

  // Where the work of a thread an agent owns stands (core/roles.ts): said by
  // its owner, or a person. A summary goes in the thread first. Only work has a
  // status: a thread of the board's conversation (a quick question a coordinator
  // owns) never gets one here, as that would make it work that nothing sent on,
  // and its work goes to a thread of its own with route_to_thread instead.
  setThreadStatus(threadId: string, status: ThreadStatus, actor: Actor, summary?: string): Thread {
    const { board, thread } = this.repo.getThread(threadId);
    guardArchived(board);
    if (!thread.owner) throw new BoardError(`Thread "${clip(thread.title, 60)}" has no owner, so its work has no status to set.`);
    if (actor.kind === 'agent' && !samePerson(actor.name, thread.owner)) throw new BoardError(`Thread "${clip(thread.title, 60)}" is ${thread.owner}'s: only its owner says where its work stands.`);
    if (inConversation(thread)) throw new BoardError(quickQuestionWords(thread));
    if (optional(summary)) this.postToThread(thread.id, summary!, actor);
    if (thread.status === status) return thread;
    thread.status = status;
    this.repo.record(board, actor, 'thread_status_changed', `marked the work of thread "${clip(thread.title, 60)}" ${STATUS_WORDS[status]}`, { item: thread.id });
    return thread;
  }

  // A person's verdict on work waiting for their review (core/roles.ts): it looks good and is to be committed, or it needs
  // changes, which the note says. Either is posted in the thread as their own message, in the verdict's words, so it is
  // for its owner and wakes it as any person's message does, and sets the work back to working: after an OK its owner
  // commits and then sets it done. Only work in review takes one.
  reviewThread(threadId: string, verdict: ReviewVerdict, actor: Actor, note?: string): Thread {
    const { board, thread } = this.repo.getThread(threadId);
    guardArchived(board);
    if (actor.kind !== 'human') throw new BoardError('Only a person reviews the work of a thread: say where your own work stands with set_thread_status.');
    if (thread.status !== 'in-review') {
      const where = thread.status ? `its work is ${STATUS_WORDS[thread.status]}` : 'it is a quick question in the board\'s conversation';
      throw new BoardError(`Thread "${clip(thread.title, 60)}" isn't waiting for a review: ${where}.`, 'conflict');
    }
    const said = optional(note);
    if (verdict === 'changes' && !said) throw new BoardError('Say what needs changing in note, so its owner knows.');
    this.postToThread(thread.id, verdictMessage(verdict, said), actor);
    thread.status = 'working';
    const what = verdict === 'approve' ? `approved the work of thread "${clip(thread.title, 60)}", to commit it` : `sent the work of thread "${clip(thread.title, 60)}" back, as it needs changes`;
    this.repo.record(board, actor, 'thread_status_changed', what, { item: thread.id });
    return thread;
  }

  // The thread an agent says it is answering, checked before it makes the
  // work: one on the same board.
  threadOn(threadId: string, board: Board): Thread {
    const found = this.repo.getThread(threadId);
    if (found.board !== board) {
      throw new BoardError(`Thread "${threadId}" is on ${found.board.title}, not ${board.title}: pass the thread you're answering on this board.`);
    }
    return found.thread;
  }

  // Work an agent made answering a thread shows in it, under its reply: made
  // after its latest message there, under that; else it waits for the reply.
  // A decision or task keeps where it came from. Shown once, however often
  // a block is updated.
  addThreadWork(threadId: string, ref: ThreadRef, actor: Actor): void {
    const { board, thread } = this.repo.getThread(threadId);
    const item = cardOf(board, ref.kind, ref.id);
    if (item && !item.fromThread) item.setFromThread({ id: thread.id, title: thread.title });
    if (item?.fromThread?.id === thread.id) this.besideBlocks(board, thread, ref, actor);
    if (!showsWork(thread, ref)) {
      const last = thread.messages.at(-1)!;
      if (last.author.kind === actor.kind && samePerson(last.author.name, actor.name)) last.refs = [...(last.refs ?? []), ref];
      else thread.pending = [...(thread.pending ?? []), { ...ref, by: actor }];
    }
    this.repo.touch(board, boardCardKindNamed(ref.kind) ? { [`${ref.kind}Id`]: ref.id } : { boardId: board.id });
  }

  // A thread over blocks selected on a page (core/threadSelection.ts): a
  // decision or task that came from it is pinned to the blocks still there,
  // and shown in the group beside them, made then and grown to fit.
  private besideBlocks(board: Board, thread: Thread, ref: ThreadRef, actor: Actor): void {
    if (!boardCardKindNamed(ref.kind)) return;
    const page = selectionPage(board, thread);
    if (!page || onFiles(page)) return; // a file's thread links back, and pins nothing: the Files canvas is seen a file at a time
    const blocks = selectionBlocks(board, thread).map((b) => b.id);
    if (blocks.length) {
      try {
        this.pins.pinBlocks(blocks, { [`${ref.kind}Id`]: ref.id }, actor);
      } catch (error) {
        // A canvas full of pins leaves it unpinned, not unmade: it still shows in the thread.
        if (!(error instanceof BoardError)) throw error;
      }
    }
    const group = this.groupOf(board, thread, page, CARDS_GROUP, actor);
    group.h = Math.max(group.h, requestCardsHeight(board, threadCards(board, thread)));
    this.repo.alsoSave(board, { pageIds: [page.id] });
  }

  // The group beside a thread's blocks, made the first time something is made
  // for it (or again, if a person removed it): titled from the thread's first
  // message, as a request's group is.
  private groupOf(board: Board, thread: Thread, page: ScratchPage, size: { w: number; h: number }, actor: Actor): Group {
    const existing = selectionGroup(board, thread);
    if (existing) return existing;
    const first = thread.messages[0];
    const located: Located = { board, page, canvas: page.canvas };
    const group = groupBeside(this.repo, this.canvases, located, selectionBlocks(board, thread), requestTitle(first.body, first.mentions ?? []), size, actor);
    thread.groupId = group.id;
    this.repo.alsoSave(board, { pageIds: [page.id] });
    return group;
  }

  // Where an agent puts the blocks it makes for a thread over selected blocks:
  // the group beside them, made if it isn't there yet. Not for any other thread.
  threadGroup(threadId: string, actor: Actor): Group | undefined {
    const { board, thread } = this.repo.getThread(threadId);
    const page = selectionPage(board, thread);
    return page && !onFiles(page) ? this.groupOf(board, thread, page, BLOCKS_GROUP, actor) : undefined;
  }

  // A card a reply names: one of a registered kind by id or by its number as the kind's references write it (#N, TN, or
  // #TN), or a block on any of the board's canvases by id.
  private threadRefOf(board: Board, raw: string): ThreadRef {
    const name = raw.trim();
    const number = /^(\D+)(\d+)$/.exec(name);
    for (const { kind, mark } of boardCardKinds()) {
      const marks = refKinds().find(kind)?.marks ?? [mark];
      const written = Boolean(number && marks.some((m) => m.toLowerCase() === number[1].toLowerCase()));
      const card = cardsOfKind(board, kind).find((c) => c.id === name || (written && c.number === Number(number![2])));
      if (card) return { kind: kind as ThreadRef['kind'], id: card.id };
    }
    if (threadWork(board, { kind: 'block', id: name }).kind === 'block') return { kind: 'block', id: name };
    const cards = boardCardKinds();
    const kinds = [...cards.map((c) => c.kind), 'block'];
    const marked = cards.map((c) => `${c.mark}N`);
    throw new BoardError(
      `No ${kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} or ${kinds.at(-1)}` : kinds[0]} "${clip(name, 40)}" on ${board.title} to show in the thread. Pass ids${marked.length ? `, ${marked.length > 1 ? `${marked.slice(0, -1).join(', ')} or ${marked.at(-1)}` : marked[0]}` : ''}.`,
    );
  }
}
