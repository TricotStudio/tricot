// Threads: conversations on a board through which people work on the project
// with agents, e.g. "Can we bundle Pi in the app?", each through a lens
// (Legal, Design…) whose brief says how agents answer. Anyone starts one
// with a message, which titles it; agents answer in it. A person's message is
// for the agents it @-mentions, else for the agent its lens is routed to,
// else for any agent, the first to reply answering it, as comment mentions
// work (core/mentions.ts). A person can ask for another lens on one message
// (^Design, core/lensCommand.ts): it answers through that lens instead, and the
// next goes back to the thread's. The board's General thread is where people ask
// from the Board Context. A person can delete a thread once it's done, and
// bring it back (core/deletions.ts). These are the rules for that, and how
// agents read threads.

import { LENSES, lensAsked } from '../../hooks/tricot-lenses.mjs';
import { answerContext, quote, threadDiscussion, type Discussion, type Shown } from './answering';
import { cardOf, cardsOf, findCard, type BoardCard } from './cards';
import { blockLabel } from './canvas';
import { deletedCard } from './deletedCards';
import { deletedLately } from './deletions';
import { doorNote, doorPlace } from './doors';
import { clip, listNames, samePerson } from './format';
import { heldWords } from './agentTalk';
import { addressedTo, agentsIn, asHeard, asksToRun, asksYouToRun, peopleIn, skillCalled, skillInstructionLines, waitingMention, withoutLeadingMentions } from './mentions';
import type { AgentBrowserHalf } from './agents/agent';
import { pageName } from './scratchPad';
import { threadFile } from './fileThread';
import { blocksGone, blocksWords } from './threadSelection';
import { answeredBy, reactionsLine } from './reactions';
import { refKinds } from './refKinds';
import { LIMITS } from './schemas/limits';
import type { Actor, Block, Board, BoardEvent, Comment, FromThread, MessageLens, ScratchPage, Thread, ThreadLens, ThreadMessage, ThreadRef } from './types';
import type { Told } from './words';

export const THREAD_TEXT_LIMIT = LIMITS.message;
// About two lines in the threads list; a title was cut at 60 before.
export const TITLE_LENGTH = 100;
// get_board lists the latest threads; older ones are a search or get_thread away.
const LISTED = 12;

// A thread's title, from its first message: its first sentence, without the
// mentions it opens with, which only say who it's for, and a tag on one of
// `agents` with them ("@Claude:opus:high", agentTags.ts).
export function threadTitle(text: string, mentions: string[] = [], agents: string[] = []): string {
  const flat = withoutLeadingMentions(text, mentions, agents).replace(/\s+/g, ' ').trim();
  let title = flat.split(/(?<=[.?!])\s/)[0];
  title = title.charAt(0).toUpperCase() + title.slice(1);
  if (title.length <= TITLE_LENGTH) return title;
  const cut = title.slice(0, TITLE_LENGTH - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, '')}…`;
}

// A thread's title as people see it. One started when titles were cut
// shorter shows as much as a new one would, taken again from its first
// message; any other is as it was made.
export function shownTitle(thread: Pick<Thread, 'title' | 'general' | 'messages'>): string {
  const first = thread.messages[0];
  if (thread.general || !first || !thread.title.endsWith('…')) return thread.title;
  const title = threadTitle(first.body, first.mentions ?? []);
  return title.length > thread.title.length && title.startsWith(thread.title.slice(0, -1)) ? title : thread.title;
}

export function isThreadEvent(event: Pick<BoardEvent, 'type'>): boolean {
  return event.type.startsWith('thread_');
}

// ---- lenses ------------------------------------------------------------------
// What people look at the project through in a thread. General is the
// default: no brief, so agents answer as they would anyway. A lens of one's
// own is a name and a brief. The presets are in hooks/tricot-lenses.mjs, so
// the hook that reads ^Design in an agent's terminal (hooks/tricot-prompt.mjs)
// has the same list, and reads a ^Name the same way as the chat bar does
// (lensAsked, core/lensCommand.ts).

export { LENSES, lensAsked };

export const LENS_NAME_LIMIT = LIMITS.lensName;
export const LENS_BRIEF_LIMIT = LIMITS.lensBrief;

export function presetLens(name: string): { name: string; brief?: string } | undefined {
  return LENSES.find((l) => samePerson(l.name, name.trim()));
}

// A lens as the API takes it: a preset by name, one's own with its brief;
// null for General answered by any agent.
export function lensChoice(name: string, brief: string | undefined, agent: string | undefined): ThreadLens | null {
  const preset = presetLens(name);
  if (preset?.name === 'General' && !agent) return null;
  return { name: preset?.name ?? name, ...(!preset && brief ? { brief } : {}), ...(agent ? { agent } : {}) };
}

export function lensName(thread: Pick<Thread, 'lens'>): string {
  return thread.lens?.name ?? 'General';
}

// Whether two lenses are the same choice: name, brief and routing.
export function sameLens(a: ThreadLens | undefined, b: ThreadLens | undefined): boolean {
  return (a?.name ?? 'General') === (b?.name ?? 'General') && a?.brief === b?.brief && a?.agent === b?.agent;
}

// How a lens is told to agents answering: "Answer through its Legal lens:
// Review…". None for one without a brief.
export function lensNote(thread: Pick<Thread, 'lens'>): string | undefined {
  const lens = thread.lens;
  return lens?.brief ? `Answer through its ${lens.name} lens: ${lens.brief}` : undefined;
}

// The brief a lens carries: its own, or a preset's (a lens on one message is
// kept by its name alone, for a preset). General has none.
export function lensBrief(lens: MessageLens): string | undefined {
  return lens.brief ?? presetLens(lens.name)?.brief;
}

// What a lens asked for on one message (^Design, ThreadMessage.lens) tells
// the agent answering it, in place of the thread's lens: "For this message,
// answer through its Design lens instead of the thread's Legal lens: …". The
// next message goes back to the thread's lens. General asks for none.
export function messageLensNote(thread: Pick<Thread, 'lens'>, message: Pick<ThreadMessage, 'lens'>): string | undefined {
  const lens = message.lens;
  if (!lens) return undefined;
  const brief = lensBrief(lens);
  const threads = thread.lens ? `the thread's ${thread.lens.name} lens` : undefined;
  if (!brief) return `For this message, answer as you see fit${threads ? `, without ${threads}` : ''}.`;
  return `For this message, answer through its ${lens.name} lens${threads ? ` instead of ${threads}` : ''}: ${brief}`;
}

// What a ^Lens on a comment (Comment.lens) tells the agent answering it:
// "Answer this comment through the Design lens: …". Comments have no lens
// of their own to go back to.
export function commentLensNote(comment: Pick<ThreadMessage, 'lens'>): string | undefined {
  const lens = comment.lens;
  const brief = lens && lensBrief(lens);
  return brief ? `Answer this comment through the ${lens!.name} lens: ${brief}` : undefined;
}

// The same, as what follows the words naming a message in a line for agents.
function messageLensLine(thread: Thread, message: ThreadMessage): string {
  const note = messageLensNote(thread, message);
  return note ? ` ${note}` : '';
}

// The agents a message is for: those it @-mentions, else, for a person's
// message that mentions nobody, the agent the thread's lens is routed to.
export function messageAgents(board: Board, thread: Thread, message: ThreadMessage): string[] {
  const named = agentsIn(board, message.mentions);
  if (named.length || message.author.kind !== 'human' || message.mentions?.length) return named;
  return thread.lens?.agent ? [thread.lens.agent] : [];
}

// ---- what a thread led to --------------------------------------------------------
// An agent answering a thread passes its thread_id when it posts a decision,
// plans tasks, adds or updates a block or comments, or names what it made in
// its reply (refs). Each shows in the thread under the reply, as it is now:
// these find it on the board. A card made this way also keeps the thread it
// came from (fromThread).

// A card of a registered kind: its work is named by the kind (`decision`), and `card` reads it (core/cards.ts).
export interface CardWork {
  kind: string;
  card: BoardCard;
}

export type ThreadWork =
  | CardWork
  | { kind: 'block'; block: Block; on?: BoardCard; page?: ScratchPage } // none: on the board context
  | { kind: 'comment'; comment: Comment; on: BoardCard }
  | { kind: 'gone'; ref: ThreadRef }; // a block removed since, or a comment's card gone

export function threadWork(board: Board, ref: ThreadRef): ThreadWork {
  const gone = { kind: 'gone' as const, ref };
  if (ref.kind === 'comment') {
    const on = ref.on ? findCard(board, ref.on) : undefined;
    const comment = on?.comments.find((c) => c.id === ref.id);
    return on && comment ? { kind: 'comment', comment, on } : gone;
  }
  if (ref.kind === 'block') return blockWork(board, ref.id) ?? gone;
  const card = cardOf(board, ref.kind, ref.id);
  return card ? { kind: card.kind.kind, card } : gone;
}

function blockWork(board: Board, id: string): ThreadWork | undefined {
  const here = board.canvas.blocks.find((b) => b.id === id);
  if (here) return { kind: 'block', block: here };
  for (const on of cardsOf(board)) {
    const block = on.canvas.blocks.find((b) => b.id === id);
    if (block) return { kind: 'block', block, on };
  }
  for (const page of board.pages ?? []) {
    const block = page.canvas.blocks.find((b) => b.id === id);
    if (block) return { kind: 'block', block, page };
  }
  return undefined;
}

// Whether a thread shows this already, under a message or waiting for one.
export function showsWork(thread: Thread, ref: ThreadRef): boolean {
  const same = (r: ThreadRef) => r.kind === ref.kind && r.id === ref.id;
  return thread.messages.some((m) => m.refs?.some(same)) || Boolean(thread.pending?.some(same));
}

// Whether an agent is told what a thread led to: a card, a comment on one or a block on a card's canvas only
// where a group offers cards, and a block on the board context only where one offers it.
function workTold(board: Board, ref: ThreadRef, told?: Told): boolean {
  const work = threadWork(board, ref);
  if ('card' in work || work.kind === 'comment') return Boolean(told?.offers('cards'));
  if (work.kind === 'gone') return ref.kind === 'block' || Boolean(told?.offers('cards'));
  if (work.on) return Boolean(told?.offers('cards'));
  return Boolean(work.page) || Boolean(told?.offers('board-context'));
}

// What a thread led to, as agents read it: #57 [id: …] "Which logins?" (open).
function workLine(board: Board, ref: ThreadRef): string {
  const work = threadWork(board, ref);
  if ('card' in work) {
    const { card } = work;
    return `${card.label} [id: ${card.id}] "${clip(card.title, 80)}"${card.statusWords ? ` (${card.statusWords})` : ''}`;
  }
  switch (work.kind) {
    case 'block':
      return `${blockLabel(work.block)} [id: ${work.block.id}] ${work.on ? `on ${work.on.label}'s canvas` : work.page ? `on ${pageName(work.page)}` : 'on the board context'}`;
    case 'comment':
      return `a comment on ${work.on.label}`;
    case 'gone':
      return goneName(board, ref, cardLabel);
  }
}

// How a card of a kind is written by its number (T5, #12), where its kind says.
export type CardLabel = (kind: string, number: number) => string | undefined;

// How agents read a card's number, which the kinds of reference the process was given say (core/refKinds.ts): the
// page asks its registry of reference kinds instead (shared/refKinds.ts), so this stays out of what the page loads.
const cardLabel: CardLabel = (kind, number) => refKinds().label(kind, number);

// What a thread led to that is gone: a card a person deleted, by the number it
// had as `label` writes it; anything else by what it was, a block, a card of a
// kind `label` knows by its name, and any other as a card.
export function goneName(board: Board, ref: ThreadRef, label: CardLabel): string {
  const card = deletedCard(board, ref.id);
  const named = card && label(card.kind, card.number);
  if (named) return `${named}, since deleted`;
  return `a ${ref.kind === 'block' || label(ref.kind, 0) ? ref.kind : 'card'} since removed`;
}

// What a thread led to, in a word or two: #57, T80, note "Where things stand".
export function workName(board: Board, ref: ThreadRef): string {
  const work = threadWork(board, ref);
  if ('card' in work) return work.card.label;
  if (work.kind === 'block') return blockLabel(work.block);
  if (work.kind === 'comment') return `your comment on ${work.on.label}`;
  return goneName(board, ref, cardLabel);
}

// Where a card came from, for the reading of a card by its id (its `fromThread`).
export function fromThreadLine(board: Board, from: FromThread | undefined): string | undefined {
  if (!from) return undefined;
  const thread = board.threads?.find((t) => t.id === from.id);
  if (!thread) return `From thread "${clip(from.title, 60)}", since deleted.`;
  return `From ${named(thread)}: read it with get_thread.`;
}

// ---- who answers ---------------------------------------------------------------

// What a thread waits on from agents: a person's latest message, until the
// agents it's for (messageAgents) write after it or answer it with a 👍 or 👎
// (core/reactions.ts), or for one that's for no agent in particular, until any
// agent does. One that asks only people waits on them, not agents.
export interface Waiting {
  message: ThreadMessage;
  agents: string[]; // the agents it's for; none: any agent
}

export function threadWaiting(board: Board, thread: Thread): Waiting | undefined {
  const at = thread.messages.findLastIndex((m) => m.author.kind === 'human');
  if (at < 0) return undefined;
  const message = thread.messages[at];
  const since = thread.messages.slice(at + 1).filter((m) => m.author.kind === 'agent');
  const answered = (agent: string) => since.some((m) => samePerson(m.author.name, agent)) || answeredBy(message, agent);
  const agents = messageAgents(board, thread, message);
  if (agents.length) {
    const left = agents.filter((a) => !answered(a));
    return left.length ? { message, agents: left } : undefined;
  }
  const agentAnswered = message.reactions?.some((r) => r.by.kind === 'agent' && answeredBy(message, r.by.name));
  if (peopleIn(board, message.mentions).length || since.length || agentAnswered) return undefined;
  return { message, agents: [] };
}

// Whether a thread waits on this agent: asked of it, or of any agent.
export function waitsOn(waiting: Waiting | undefined, agent: string | undefined): boolean {
  return Boolean(waiting && (waiting.agents.length === 0 || (agent && waiting.agents.some((a) => samePerson(a, agent)))));
}

function who(actor: Actor): string {
  return `${actor.name} (${actor.kind})`;
}

// How a thread is named to agents: thread "Can we bundle Pi?" [thread id: …].
function named(thread: Thread): string {
  return `thread "${clip(thread.title, 60)}" [thread id: ${thread.id}]`;
}

const reply = (thread: Thread) => `reply_in_thread(thread_id: ${thread.id})`;

// What a message says once its opening mentions are taken off, a tag on one
// with them (agentTags.ts), quoted: for agents other than those it asks.
function said(board: Board, message: ThreadMessage, max = 300): string {
  return `"${clip(withoutLeadingMentions(message.body, message.mentions ?? [], agentsIn(board, message.mentions)), max)}"`;
}

// A message an agent is to answer, after the words naming it: whole, or for
// one its session has read, that it has (answering.ts); and what a tag asks
// of it (mentions.ts asHeard, `kind`: which agent it is).
function heard(board: Board, message: ThreadMessage, viewer: string | undefined, shown: Shown | undefined, kind?: AgentBrowserHalf): { quoted: string; ask: string } {
  const { text, ask } = asHeard(board, { author: message.author, text: message.body, mentions: message.mentions }, viewer, kind);
  return { quoted: quote(text, message.id, shown), ask };
}

// The thread's lens, for the General thread what people ask there, and for
// one started from a tab's chat bar what it aims at (doors.ts): what an agent
// answering is told after the message. A session is told it once, and again
// when it changes; it is the thread's heading (answering.ts).
function threadHeading(board: Board, thread: Thread, told?: Told): string | undefined {
  const notes = [lensNote(thread), thread.general && generalNote(thread, told), doorNote(thread, board, told)].filter(Boolean);
  return notes.length ? notes.join(' ') : undefined;
}

export function threadAsRead(board: Board, thread: Thread, told?: Told): Discussion {
  return threadDiscussion(thread, threadHeading(board, thread, told));
}

function through(board: Board, thread: Thread, shown?: Shown, told?: Told): string {
  const heading = threadHeading(board, thread, told);
  return heading && (!shown || shown.heading(`thread:${thread.id}`, heading)) ? ` ${heading}` : '';
}

// What an agent answering a message in a thread needs under its line (answering.ts).
function context(board: Board, thread: Thread, message: ThreadMessage, viewer: string | undefined, shown: Shown | undefined, told?: Told): string[] {
  return answerContext(threadAsRead(board, thread, told), message, viewer, shown);
}

// What the General thread aims at, where a group has it (`thread.general`): people ask there from the board context, which a server with none has not.
function generalNote(thread: Thread, told?: Told): string | undefined {
  return told?.line('thread.general', { id: thread.id });
}

// "asked you in thread …: "…". Reply with …", or for a skill request, "asks you
// to run /review in thread …: "args". Run it, then reply with …"; with what a
// tag asks of it (`kind`: which agent it is, mentions.ts taggedAsk).
function askedYou(board: Board, thread: Thread, message: ThreadMessage, viewer: string | undefined, shown?: Shown, kind?: AgentBrowserHalf, told?: Told): string {
  const { quoted, ask } = heard(board, message, viewer, shown, kind);
  const lens = messageLensLine(thread, message);
  if (asksYouToRun(message.skill, viewer)) return `${asksToRun(message.skill, viewer, `in ${named(thread)}`, reply(thread), 'get_thread')}${ask}${through(board, thread, shown, told)}${lens}`;
  return `asked you in ${named(thread)}${quoted}.${ask} Reply with ${reply(thread)}.${through(board, thread, shown, told)}${lens}`;
}

function forAnyAgent(board: Board, thread: Thread, message: ThreadMessage, shown?: Shown, told?: Told): string {
  return `${named(thread)}${heard(board, message, undefined, shown).quoted}. For any agent: the first to reply answers, with ${reply(thread)}.${through(board, thread, shown, told)}${messageLensLine(thread, message)}`;
}

// People's messages waiting on an agent, for get_board and an agent's
// updates, until one answers: "Sam asked you in thread …", and the lens
// to answer through. One for other agents is theirs, and left out for the
// agent reading it. With the agent's session (`shown`), one it has read says
// so instead of saying it again, and one an update above gave is left out.
// Another agent's message asking the agent reading it waits on it the same
// way, until it writes there or answers it with a 👍 or 👎 (agentAsking).
export function threadsDigest(board: Board, viewer?: string, shown?: Shown, kind?: AgentBrowserHalf, told?: Told): string | undefined {
  const lines = (board.threads ?? []).flatMap((thread) => {
    const waiting = threadWaiting(board, thread);
    const fromAgent = viewer ? agentAsking(board, thread, viewer) : undefined;
    const withContext = (message: ThreadMessage, line: string) => [[line, ...context(board, thread, message, viewer, shown, told)].join('\n')];
    const agentLine = fromAgent && fromAgent !== waiting?.message && !shown?.inThisResult(fromAgent.id) ? withContext(fromAgent, `${fromAgent.author.name} ${askedYou(board, thread, fromAgent, viewer, shown, kind, told)}`) : [];
    if (!waiting || shown?.inThisResult(waiting.message.id)) return agentLine;
    const { message, agents } = waiting;
    const by = message.author.name;
    if (agents.length === 0) return [...withContext(message, `${by} wrote in ${forAnyAgent(board, thread, message, shown, told)}`), ...agentLine];
    if (viewer && waitsOn(waiting, viewer)) return [...withContext(message, `${by} ${askedYou(board, thread, message, viewer, shown, kind, told)}`), ...agentLine];
    return viewer ? agentLine : [`${by} asked ${listNames(agents)} in ${named(thread)}: ${said(board, message)}. For ${listNames(agents)} only.`];
  });
  return lines.length ? lines.join('\n') : undefined;
}

// Another agent's latest message in a thread that @-mentions this one and
// waits on it: nothing from it there since, no 👍 or 👎 of its on it, and not
// held by the loop guard (agentTalk.ts).
export function agentAsking(board: Board, thread: Thread, viewer: string): ThreadMessage | undefined {
  const message = waitingMention(thread.messages, viewer);
  if (!message || message.author.kind !== 'agent') return undefined;
  return agentsIn(board, message.mentions).some((a) => samePerson(a, viewer)) ? message : undefined;
}

// A thread's event as the agent reading its updates sees it: a message asked
// of it, for another agent, or for any agent while nobody has answered it,
// and a new lens with its brief. None for the rest, which read as logged.
// A message for it comes whole, with what its session (`shown`) needs to
// answer it (answering.ts), and what a tag asks of it (`kind`: which agent it is).
export function threadEventLine(event: BoardEvent, board: Board, viewer: string | undefined, shown?: Shown, kind?: AgentBrowserHalf, told?: Told): string | undefined {
  const thread = isThreadEvent(event) ? board.threads?.find((t) => t.id === event.itemId) : undefined;
  if (!thread) return undefined;
  const lead = `- (${event.seq}) ${who(event.actor)}`;
  if (event.type === 'thread_lens_changed') {
    const routed = thread.lens?.agent ? ` A person's message there that @-mentions nobody is for ${thread.lens.agent}.` : '';
    return `${lead} ${event.summary} [thread id: ${thread.id}].${through(board, thread, undefined, told)}${routed}`;
  }
  const message = thread.messages.find((m) => (event.commentId ? m.id === event.commentId : m.at === event.at && m.author.kind === event.actor.kind && m.author.name === event.actor.name));
  if (!message) return undefined;
  const address = addressedTo(messageAgents(board, thread, message), viewer);
  if (address.to === 'others') return `${lead} asked ${listNames(address.agents)} in ${named(thread)}. Not for you; carry on.`;
  if (address.to === 'you' && message.held) return `${lead} mentioned you in ${named(thread)}: "${clip(withoutLeadingMentions(message.body, message.mentions ?? []), 200)}"; ${heldWords(message.held)}.`;
  const withContext = (line: string) => [line, ...context(board, thread, message, viewer, shown, told)].join('\n');
  if (address.to === 'you') return withContext(`${lead} ${askedYou(board, thread, message, viewer, shown, kind, told)}`);
  if (event.actor.kind !== 'human' || threadWaiting(board, thread)?.message !== message) return undefined;
  const wrote = event.type === 'thread_started' ? 'started' : 'wrote in';
  return withContext(`${lead} ${wrote} ${forAnyAgent(board, thread, message, shown, told)}`);
}

// Who a thread waits on, as get_board and get_thread say it.
function waitNote(waiting: Waiting | undefined, viewer: string | undefined): string | undefined {
  if (!waiting) return undefined;
  if (waiting.agents.length === 0) return 'waits on an agent';
  return waitsOn(waiting, viewer) ? 'waits on you' : `waits on ${listNames(waiting.agents)}`;
}

// A thread's lens as get_board lists it: Legal lens: "Review licences…",
// and the agent it's routed to.
function lensLine(thread: Thread): string {
  const lens = thread.lens;
  const brief = lens?.brief ? `: "${clip(lens.brief, 200)}"` : '';
  return `${lensName(thread)} lens${brief}${lens?.agent ? `, routed to ${lens.agent}` : ''}`;
}

// The board's threads, briefly, latest first, for get_board: the latest
// few, every one waiting on an agent, and those people deleted lately.
export function threadsSection(board: Board, viewer?: string, now = Date.now(), told?: Told): string | undefined {
  const threads = [...(board.threads ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const deleted = deletedLately(board.deleted, {}, now, 5, 'thread');
  if (threads.length === 0 && !deleted) return undefined;
  const shown = threads.flatMap((thread, i) => {
    const waiting = threadWaiting(board, thread);
    return i < LISTED || waiting ? [{ thread, waiting }] : [];
  });
  const lines = shown.map(({ thread, waiting }) => {
    const last = thread.messages.at(-1)!;
    const count = `${thread.messages.length} message${thread.messages.length === 1 ? '' : 's'}`;
    const note = waitNote(waiting, viewer);
    const general = thread.general ? (told?.line('thread.general.place', {}) ?? '') : '';
    const picked = thread.blockIds?.length ? ` with ${blocksWords(thread.blockIds.length)} selected` : '';
    const file = threadFile(board, thread);
    const door = file
      ? ` · started in Files${file.path ? ` about ${file.path}` : ''} [page id: ${file.page.id}; block id: ${file.blockId}]`
      : thread.pageId
        ? ` · started over Sketchbook page [page id: ${thread.pageId}]${picked}`
        : thread.door && doorPlace(thread.door, told)
          ? ` · started from ${doorPlace(thread.door, told)}`
          : '';
    return `- ${named(thread)}${general}${door} · ${lensLine(thread)} · ${count} · last by ${who(last.author)} at ${last.at}: ${said(board, last, 120)}${note ? ` · ${note}` : ''}`;
  });
  const older = threads.length - shown.length;
  if (older > 0) lines.push(`(${older} older thread${older === 1 ? '' : 's'}, none waiting on an agent.)`);
  const how = 'Read one with get_thread; answer in it with reply_in_thread, through its lens.';
  return [`## Threads (${threads.length})`, how, ...lines, deleted].filter(Boolean).join('\n');
}

// A thread in full, for get_thread: its lens, every message with its id
// (which react takes) and reactions, and who it waits on.
export function threadDetail(board: Board, thread: Thread, viewer?: string, told?: Told): string {
  const waiting = threadWaiting(board, thread);
  const lines = [`# Thread "${thread.title}" [thread id: ${thread.id}]`, `Started by ${who(thread.startedBy)} at ${thread.startedAt} on ${board.title} [board id: ${board.id}]`];
  const lens = thread.lens;
  lines.push(lens?.brief ? `Lens: ${lens.name}. Answer through it: ${lens.brief}` : `Lens: ${lensName(thread)}.`);
  if (lens?.agent) lines.push(`Routed to ${lens.agent}: a person's message that @-mentions nobody is for ${lens.agent}.`);
  const door = doorNote(thread, board, told);
  if (door) lines.push(door);
  const gone = blocksGone(board, thread);
  if (gone && threadFile(board, thread)) lines.push("The file's block has been removed from Files since.");
  else if (gone) lines.push(`${gone === 1 ? 'One of the blocks' : `${gone} of the blocks`} it was about ${gone === 1 ? 'has' : 'have'} been removed from the page since.`);
  if (waiting && waiting.agents.length === 0) lines.push(`It waits on an agent: the first to reply answers, with ${reply(thread)}.`);
  else if (waiting && waitsOn(waiting, viewer)) lines.push(`It waits on you: answer ${waiting.message.author.name}'s latest with ${reply(thread)}.`);
  else if (waiting) lines.push(`It waits on ${listNames(waiting.agents)}: not for you; carry on.`);
  lines.push('', `## Messages (${thread.messages.length})`);
  for (const message of thread.messages) {
    const address = addressedTo(messageAgents(board, thread, message), viewer);
    const asks = message.held ? ` (mentions you; ${heldWords(message.held)})` : asksYouToRun(message.skill, viewer) ? ` (asks you to run ${skillCalled(message.skill, viewer)})` : ' (asks you)';
    const tag = address.to === 'you' ? asks : address.to === 'others' ? ` (for ${listNames(address.agents)}: not for you)` : '';
    const via = message.via ? ` (via /${message.via})` : '';
    lines.push(`- ${who(message.author)} at ${message.at} [message id: ${message.id}]${via}${tag}: ${message.body.replace(/\n/g, '\n  ')}`);
    lines.push(...skillInstructionLines(message.skill, viewer));
    const own = messageLensNote(thread, message);
    if (own) lines.push(`  ${own}`);
    lines.push(...reactionsLine(message));
    const led = (message.refs ?? []).filter((ref) => workTold(board, ref, told));
    if (led.length) lines.push(`  Led to: ${led.map((ref) => workLine(board, ref)).join('; ')}`);
  }
  for (const { by, ...ref } of (thread.pending ?? []).filter((pending) => workTold(board, pending, told))) lines.push(`- ${who(by)} made, ahead of a reply: ${workLine(board, ref)}`);
  return lines.join('\n');
}
