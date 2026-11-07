import { BoardError } from './errors';
import type { EventQuery } from './eventTables';
import type { LensInput } from './inputs';
import type { People } from './people';
import type { BoardRepository } from './repository';
import { guardArchived, limited, optional, randomId, required } from './validate';
import { clip, listNames, samePerson } from '../format';
import { agentsIn, boardAgents } from '../mentions';
import { LENS_BRIEF_LIMIT, LENS_NAME_LIMIT, THREAD_TEXT_LIMIT, lensName, presetLens, sameLens, showsWork, threadTitle, threadWork } from '../threads';
import { type Actor, type Board, type Thread, type ThreadDoor, type ThreadLens, type ThreadMessage, type ThreadRef, boardKey } from '../types';

// How a thread starts besides its message and lens: as the board's General
// thread, or from a tab's chat bar (its door).
export interface ThreadStart {
  general?: boolean;
  door?: ThreadDoor;
}

// Threads: conversations through which people work on the project with agents. A person (or an agent)
// starts one with a message, and agents answer in it, through its lens. A message's @-mentions say which
// agents it's for. See core/threads.
export class Threads {
  constructor(
    private readonly repo: BoardRepository,
    private readonly people: People,
  ) {}

  // `general` starts the board's General thread (askInGeneral), titled so;
  // `door`, one a person started from a tab's chat bar, aimed at what that
  // tab holds (core/doors.ts).
  startThread(boardId: string, body: string, actor: Actor, lens?: LensInput | null, { general = false, door }: ThreadStart = {}): Thread {
    const board = this.repo.getBoard(boardId);
    guardArchived(board);
    const text = limited(required(body, 'A message'), THREAD_TEXT_LIMIT, 'A message');
    const chosen = this.lensOf(board, lens);
    const id = this.repo.newThreadId();
    const now = new Date().toISOString();
    const { mentions, skill } = this.people.requestIn(board, text, actor);
    const thread: Thread = {
      id,
      title: general ? 'General' : threadTitle(text, mentions, agentsIn(board, mentions)),
      ...(general && { general: true as const }),
      ...(chosen && { lens: chosen }),
      ...(door && { door }),
      startedBy: actor,
      startedAt: now,
      updatedAt: now,
      messages: [{ id: randomId(8), author: actor, body: text, at: now, ...(mentions.length ? { mentions } : {}), ...(skill ? { skill } : {}) }],
    };
    const first = thread.messages[0];
    board.threads = [...(board.threads ?? []), thread];
    this.repo.indexThread(id, board);
    const through = chosen ? `, through the ${chosen.name} lens` : '';
    this.repo.record(board, actor, 'thread_started', `started thread "${clip(thread.title, 60)}"${through}`, undefined, id, undefined, now, mentions, first.id);
    return thread;
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
    this.repo.record(board, actor, 'thread_lens_changed', summary, undefined, thread.id);
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

  // A message in a thread. One from whoever made work answering it (thread_id)
  // ahead of it shows that work under it, and the cards it names (refs: ids,
  // #N or TN) too.
  postToThread(threadId: string, body: string, actor: Actor, refs: string[] = []): Thread {
    const { board, thread } = this.repo.getThread(threadId);
    guardArchived(board);
    const text = limited(required(body, 'A message'), THREAD_TEXT_LIMIT, 'A message');
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
      const item = ref.kind === 'decision' ? board.decisions.find((d) => d.id === ref.id) : ref.kind === 'task' ? board.tasks.find((t) => t.id === ref.id) : undefined;
      if (!item || item.fromThread || !samePerson(item.createdBy.name, actor.name)) continue;
      const made = seqOf(ref.kind === 'decision' ? { types: ['decision_posted'], decisionId: item.id } : { types: ['task_planned'], taskId: item.id });
      if (made > started) {
        item.fromThread = { id: thread.id, title: thread.title };
        fromHere.push(ref);
      }
    }
    this.repo.alsoSave(board, {
      decisionIds: fromHere.filter((r) => r.kind === 'decision').map((r) => r.id),
      taskIds: fromHere.filter((r) => r.kind === 'task').map((r) => r.id),
    });
    const message: ThreadMessage = {
      id: randomId(8),
      author: actor,
      body: text,
      at: now,
      ...(mentions.length ? { mentions } : {}),
      ...(skill ? { skill } : {}),
      ...(via ? { via } : {}),
      ...(shown.length ? { refs: shown } : {}),
      ...(held ? { held } : {}),
    };
    thread.messages.push(message);
    thread.updatedAt = now;
    const summary = `replied in thread "${clip(thread.title, 60)}": "${clip(text, 200)}"`;
    this.repo.record(board, actor, 'thread_replied', summary, undefined, thread.id, undefined, now, mentions, message.id, undefined, Boolean(held));
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
    const item = ref.kind === 'decision' ? board.decisions.find((d) => d.id === ref.id) : ref.kind === 'task' ? board.tasks.find((t) => t.id === ref.id) : undefined;
    if (item && !item.fromThread) item.fromThread = { id: thread.id, title: thread.title };
    if (!showsWork(thread, ref)) {
      const last = thread.messages.at(-1)!;
      if (last.author.kind === actor.kind && samePerson(last.author.name, actor.name)) last.refs = [...(last.refs ?? []), ref];
      else thread.pending = [...(thread.pending ?? []), { ...ref, by: actor }];
    }
    this.repo.touch(board, ref.kind === 'decision' ? { decisionId: ref.id } : ref.kind === 'task' ? { taskId: ref.id } : { boardId: board.id });
  }

  // A card a reply names: a decision or task by id, #N or TN (or #TN), or a
  // block on any of the board's canvases by id.
  private threadRefOf(board: Board, raw: string): ThreadRef {
    const name = raw.trim();
    const number = /^(#T|#|T)(\d+)$/i.exec(name);
    const decision = board.decisions.find((d) => d.id === name || (number?.[1] === '#' && d.number === Number(number[2])));
    if (decision) return { kind: 'decision', id: decision.id };
    const task = board.tasks.find((t) => t.id === name || (number?.[1].toUpperCase().endsWith('T') && t.number === Number(number[2])));
    if (task) return { kind: 'task', id: task.id };
    if (threadWork(board, { kind: 'block', id: name }).kind === 'block') return { kind: 'block', id: name };
    throw new BoardError(`No decision, task or block "${clip(name, 40)}" on ${board.title} to show in the thread. Pass ids, #N or TN.`);
  }
}
