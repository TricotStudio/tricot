// Home's conversation: what a board's Home shows of it, worked out from the
// board alone, so the page (web/threads/timeline.tsx, relays.ts, relayCard.tsx,
// timelineWork.tsx) and the terminal (the Tricot tab's chat,
// cli/switcher/homeStream.ts) show the same conversation, each drawing it its
// own way. Pure functions over the board: the hooks, what is on its way and
// what a side remembers of the viewer are each side's, handed in.
//
// - What was said (`homeSaid`): what people asked from a chat bar and what the
//   coordinator answered, every message of the threads of the conversation
//   (core/roles.ts inConversation), with what is on its way. A coordinator's
//   word that it sent an ask on is drawn as a card under the ask, naming the
//   thread it went to, not as a message. Of a thread an agent owns, the
//   conversation keeps what was asked in it: the ask of a thread a person
//   started that an agent took on as its work, and a follow-up the coordinator
//   moved into it (ThreadMessage.movedFrom), each with the thread as its card.
// - Relays (`homeRelays`): what of the work handed out needs the viewer, at
//   when it was said. An agent's question in a thread an agent owns, while the
//   thread waits on a person (its latest agent message), or one that
//   @-mentions them, or one the side remembers it relayed while the thread
//   waited (`asked`, as a thread that moves on says nothing of it); it is
//   answered once a person writes in the thread after it. Work waiting for
//   their review (core/roles.ts), with the summary its agent wrote as it set it
//   so (its latest message, as a question is): answered once a person gives
//   their verdict, read from their message's words, when it folds to the
//   verdict, so it stays as approved or sent back after the thread moves on
//   with nothing remembered. A thread done, with the summary its agent wrote.
//   And what a part relays of its cards (a card blocked), which the part works
//   out and hands in.
// - The rows (`homeRows`): what was said and the relays by when, with the day
//   between them and where the viewer was last here, and the relays that came
//   while they were away as one stack once there are several.
// - The yarn: the conversation is one strand, and each thread an agent owns
//   runs in a lane of its own beside it (`lanesOf`), in the colour of where
//   its work stands (`threadTone`: at work, waiting on a person, waiting for
//   their review, sent on but not started, done), from where it was sent on to
//   where it is tied off. With a thread open, the same strands in the same
//   lanes are drawn against its messages: those not done before the
//   conversation starts (`strandsShown`, `conversationStart`), on the
//   conversation and with a thread open alike.
//
// Nothing here is a part's: threads are the core's, and a part's cards come
// in as relays it made.
import { samePerson } from './format';
import { inConversation, verdictOf, type ReviewVerdict } from './roles';
import { shownTitle } from './threads';
import type { Board, Thread, ThreadMessage } from './types';

// ---- where a thread an agent owns stands ---------------------------------------------

// Where its work stands, as its strand, its square and its card say it: at
// work, waiting on a person, finished and waiting for their review (in the
// in-review colour), sent on but not started yet (its owner is not on the
// board), or done.
export type StrandTone = 'working' | 'waiting' | 'review' | 'todo' | 'done';

// An agent on the board, as presence says it.
export interface OnBoard {
  name: string;
  state: string;
}

// The threads agents own: the work a coordinator handed out, every thread out of the conversation.
export const ownedThreads = (board: Pick<Board, 'threads'>): Thread[] => (board.threads ?? []).filter((t) => !inConversation(t));

// Whether a thread an agent owns is at work: its owner is on the board. Sent
// on but not started, it waits for its owner to come (Tricot's terminal starts
// it, core/roles.ts launchesOn).
export function threadStarted(thread: Pick<Thread, 'owner'>, onBoard: readonly OnBoard[]): boolean {
  return onBoard.some((a) => a.state !== 'away' && samePerson(a.name, thread.owner ?? ''));
}

export function threadTone(thread: Pick<Thread, 'owner' | 'status'>, onBoard: readonly OnBoard[]): StrandTone {
  if (thread.status === 'needs-you') return 'waiting';
  if (thread.status === 'in-review') return 'review';
  if (thread.status === 'done') return 'done';
  return threadStarted(thread, onBoard) ? 'working' : 'todo';
}

// What a card under an ask says of where its thread's work stands.
export const sentStateWords = (tone: StrandTone): string => (tone === 'waiting' ? 'Needs you' : tone === 'review' ? 'In review' : tone === 'done' ? 'Done' : tone === 'todo' ? 'Starting' : 'At work');

// An agent's name, without the work an orchestrator is named after ("Claude · Sign-in flow").
export const ownName = (agent: string): string => agent.split(' · ')[0];

// The first line of a text that says something, without what marks it up.
export const firstLine = (text: string): string => text.split('\n').find((line) => line.trim())?.replace(/^[#>*\-\s]+/, '') ?? '';

// ---- the strands ----------------------------------------------------------------------

// A thread an agent owns, as its strand: where its work stands, in words and
// as a tone, when it was started (where it knits off, unless a card says) and
// when its work was done (where it is tied off).
export interface Strand {
  id: string; // the thread's
  title: string;
  status: string; // "at work · 2/5", "needs you", "in review"
  tone: StrandTone;
  from: string;
  to?: string;
  live: boolean; // its agent has a step there now
}

// A thread's strand; `progress`, how far its agent's plan is, said while it is at work.
export function strandOf(thread: Thread, tone: StrandTone, progress?: { done: number; total: number }, live = false): Strand {
  const at = tone === 'working' && progress ? ` · ${progress.done}/${progress.total}` : '';
  return {
    id: thread.id,
    title: shownTitle(thread),
    status: tone === 'waiting' ? 'needs you' : tone === 'review' ? 'in review' : tone === 'done' ? 'done' : tone === 'todo' ? 'not started' : `at work${at}`,
    tone,
    from: thread.startedAt,
    ...(thread.status === 'done' && { to: thread.updatedAt }),
    live,
  };
}

// Each strand's lane, by when it ran: the lowest lane free since the strand
// before it there was tied off.
export function lanesOf(strands: readonly Pick<Strand, 'id' | 'from' | 'to'>[]): Map<string, number> {
  const lanes = new Map<string, number>();
  const freeAt: number[] = []; // by lane, when its last strand ended (Infinity while one runs)
  for (const strand of [...strands].sort((a, b) => a.from.localeCompare(b.from))) {
    const from = Date.parse(strand.from);
    let lane = freeAt.findIndex((end) => end < from);
    if (lane < 0) lane = freeAt.length;
    freeAt[lane] = strand.to ? Date.parse(strand.to) : Infinity;
    lanes.set(strand.id, lane);
  }
  return lanes;
}

// The strands beside the conversation: those not done before the first message said in it (`firstAt`).
export const strandsShown = <S extends Pick<Strand, 'to'>>(strands: readonly S[], firstAt: string | undefined): S[] => strands.filter((s) => !s.to || !firstAt || s.to >= firstAt);

// When the conversation starts, for `strandsShown`: the first thing said in it as Home draws it (`homeSaid`), the
// asks of the threads agents own and the follow-ups moved into them included, or what is on its way to it (`also`:
// when each was sent, which the board does not have yet), whichever is first. On the conversation and with a thread
// open alike, so the two have the same strands in the same lanes.
export function conversationStart(board: Pick<Board, 'threads'>, conversation: readonly Thread[], owned: readonly Thread[], also: readonly string[] = []): string | undefined {
  const said = homeSaid(board, conversation, owned, (thread) => thread.messages, (message) => message, (message) => message);
  return [said[0]?.message.at, ...also].filter((at): at is string => Boolean(at)).sort()[0];
}

// ---- what was said ----------------------------------------------------------------------

// A message of the conversation, as a side draws it (`item`: the message, or
// the message with what is on its way), with what came after it in its thread,
// whether it is its thread's first (which says where it was asked), and the
// threads it was sent on to.
export interface Said<T> {
  thread: Thread;
  item: T;
  message: ThreadMessage; // the item's message
  index: number; // its place among its thread's items as drawn, or among the messages of a thread an agent owns
  after: ThreadMessage[];
  first: boolean;
  sentOn: Thread[];
  taken?: true; // an ask whose own thread an agent took on as its work: its card is that thread
  inWork: boolean; // asked in the conversation, and in a thread an agent owns now
}

// Of a thread of the conversation: the threads each ask was sent on to, by
// the ask's id, and the coordinator's words that say so, which are drawn as
// the cards under the ask rather than as messages.
export function sentOnFrom(board: Pick<Board, 'threads'>, thread: Pick<Thread, 'messages'>): { sentFrom: Map<string, Thread[]>; words: Set<string> } {
  const sentFrom = new Map<string, Thread[]>();
  const words = new Set<string>();
  for (const message of thread.messages) {
    const to = message.sent && board.threads?.find((t) => t.id === message.sent!.threadId);
    if (!to || !thread.messages.some((m) => m.id === message.sent!.messageId)) continue;
    sentFrom.set(message.sent!.messageId, [...(sentFrom.get(message.sent!.messageId) ?? []), to]);
    words.add(message.id);
  }
  return { sentFrom, words };
}

// The conversation's messages, oldest first: every message of its threads
// (`conversation`, each drawn as `items` gives it, with what is on its way),
// but the coordinator's words that it sent one on; and what was asked in it of
// the threads agents own (`owned`), each the item `wrap` makes of it.
export function homeSaid<T>(
  board: Pick<Board, 'threads'>,
  conversation: readonly Thread[],
  owned: readonly Thread[],
  items: (thread: Thread) => readonly T[],
  messageOf: (item: T) => ThreadMessage,
  wrap: (message: ThreadMessage) => T,
): Said<T>[] {
  const said: Said<T>[] = [];
  for (const thread of owned) {
    thread.messages.forEach((message, i) => {
      if (message.author.kind !== 'human') return;
      const asked = i === 0 && thread.startedBy.kind === 'human';
      if (!asked && !message.movedFrom) return;
      said.push({ thread, item: wrap(message), message, index: i, after: thread.messages.slice(i + 1), first: asked, sentOn: [thread], ...(asked && { taken: true as const }), inWork: true });
    });
  }
  for (const thread of conversation) {
    const drawn = items(thread);
    const { sentFrom, words } = sentOnFrom(board, thread);
    drawn.forEach((item, i) => {
      const message = messageOf(item);
      if (words.has(message.id)) return;
      said.push({ thread, item, message, index: i, after: drawn.slice(i + 1).map(messageOf), first: i === 0, sentOn: sentFrom.get(message.id) ?? [], inWork: false });
    });
  }
  return said.sort((a, b) => a.message.at.localeCompare(b.message.at));
}

// The message a thread of the conversation is seen by, once it is in view:
// its latest, or, when that is the coordinator's word that it sent an ask on,
// the ask it is drawn under.
export function seenBy(thread: Pick<Thread, 'messages'>): string | undefined {
  const last = thread.messages.at(-1);
  return last && (last.sent ? last.sent.messageId : last.id);
}

// ---- relays -----------------------------------------------------------------------------

export type RelayKind = 'question' | 'review' | 'blocked' | 'done';

// A moment of a part's card that needs the viewer, as the part relays it: a
// card blocked, with what holds it in a line. `card` names the card, for a
// side that opens it by its kind and id.
export interface CardRelay {
  key: string;
  kind: 'blocked';
  title: string;
  label?: string; // its number before its title (T5)
  at: string; // when it moved there
  line: string;
  card?: { kind: string; id: string };
}

// A person's verdict on a review (core/roles.ts), as their message gave it: which, who gave it and when, the note after
// its words, and that message's id.
export interface Verdict {
  kind: ReviewVerdict; // approve: "Looks good, commit it"; changes: "Needs changes"
  by: string;
  at: string;
  note?: string;
  messageId: string;
}

// A relay: what it is, when it was said, the thread it came from (Reply
// answers in it, and its strand stitches into it) or the part's card, where
// it stands now (its thread's tone), the question or summary in full, who
// answered it first and what they said, and whether it needs the viewer.
// A review (work waiting for the viewer's OK before it is committed) is its
// agent's summary, and, once a person gave it, their verdict.
export interface Relay<C extends CardRelay = CardRelay> {
  key: string; // the relayed message's id, or the part's key for its card
  kind: RelayKind;
  at: string;
  title: string; // its thread's name, or its card's
  label?: string;
  thread?: Thread;
  by?: string; // the agent that asked or finished
  tone: StrandTone | 'blocked';
  body: string;
  answer?: { by: string; body: string };
  verdict?: Verdict; // a review's, once given
  needsYou: boolean; // a question not answered yet, a review with no verdict yet, or a card blocked
  card?: C; // a part's, as it relayed it
}

// The reviews in a thread, by the id of the agent's message each is: the latest agent message before a person's
// verdict, with that verdict; and, while the thread waits for review, its latest agent message (the summary its agent
// wrote as it set it so), with none yet. A verdict a person already gave that message stands, as their words say.
export function reviewsIn(thread: Pick<Thread, 'status' | 'messages'>): Map<string, Verdict | null> {
  const reviews = new Map<string, Verdict | null>();
  let latest: ThreadMessage | undefined;
  for (const message of thread.messages) {
    if (message.author.kind === 'agent') {
      latest = message;
      continue;
    }
    const given = latest && !reviews.has(latest.id) ? verdictOf(message.body) : undefined;
    if (given) reviews.set(latest!.id, { kind: given.verdict, by: message.author.name, at: message.at, ...(given.note && { note: given.note }), messageId: message.id });
  }
  if (thread.status === 'in-review' && latest && !reviews.has(latest.id)) reviews.set(latest.id, null);
  return reviews;
}

// A thread's relays, oldest first: its questions to the viewer, its work
// waiting for their review and, once done, its summary. `asked`: the questions
// the side remembers relaying while the thread waited on a person; `sending`:
// what the viewer is sending in it, the first of which answers its latest
// question at once (a reply leaves a review waiting: only a verdict answers it).
export function threadRelays(thread: Thread, name: string, tone: StrandTone, asked: ReadonlySet<string>, sending: readonly { body: string }[] = []): Relay<never>[] {
  const relays: Relay<never>[] = [];
  const last = thread.messages.findLast((m) => m.author.kind === 'agent');
  const title = shownTitle(thread);
  const reviews = reviewsIn(thread);
  thread.messages.forEach((message, i) => {
    if (message.author.kind !== 'agent') return;
    const base = { key: message.id, at: message.at, title, thread, by: message.author.name, tone, body: message.body };
    if (thread.status === 'done' && message === last) {
      relays.push({ ...base, kind: 'done', needsYou: false });
      return;
    }
    const review = reviews.get(message.id);
    if (review !== undefined) {
      const said = review && thread.messages.find((m) => m.id === review.messageId);
      relays.push({ ...base, kind: 'review', ...(review && { verdict: review }), ...(said && { answer: { by: said.author.name, body: said.body } }), needsYou: !review });
      return;
    }
    const waits = (thread.status === 'needs-you' && message === last) || Boolean(message.mentions?.some((n) => samePerson(n, name))) || asked.has(message.id);
    if (!waits) return;
    const reply = thread.messages.slice(i + 1).find((m) => m.author.kind === 'human');
    const mine = !reply && message === last ? sending[0] : undefined;
    const answer = reply ? { by: reply.author.name, body: reply.body } : mine ? { by: name, body: mine.body } : undefined;
    relays.push({ ...base, kind: 'question', ...(answer && { answer }), needsYou: !answer });
  });
  return relays;
}

// Every relay on the board, oldest first: the threads agents own, and what a part relays of its cards (`cards`).
export function homeRelays<C extends CardRelay>(
  board: Pick<Board, 'threads'>,
  name: string,
  onBoard: readonly OnBoard[],
  asked: ReadonlySet<string>,
  sending: (thread: Thread) => readonly { body: string }[],
  cards: readonly C[] = [],
): Relay<C>[] {
  const threads: Relay<C>[] = ownedThreads(board).flatMap((thread) => threadRelays(thread, name, threadTone(thread, onBoard), asked, sending(thread)));
  const blocked: Relay<C>[] = cards.map((card) => ({ key: card.key, kind: card.kind, at: card.at, title: card.title, ...(card.label && { label: card.label }), tone: 'blocked', body: card.line, needsYou: true, card }));
  return [...threads, ...blocked].sort((a, b) => a.at.localeCompare(b.at));
}

// The questions relayed while their thread waits on a person, for a side to
// remember: once the thread moves on, it says nothing of them.
export const askedWhileWaiting = (relays: readonly Relay<CardRelay>[]): string[] => relays.filter((r) => r.kind === 'question' && r.thread?.status === 'needs-you').map((r) => r.key);

// What a relay says of where it stands, after its name.
export function relayWords(relay: Pick<Relay, 'kind' | 'needsYou' | 'by' | 'tone' | 'verdict'>): string {
  if (relay.kind === 'blocked') return 'Blocked';
  if (relay.kind === 'done') return 'Done';
  if (relay.kind === 'review') return relay.verdict ? (relay.verdict.kind === 'approve' ? 'Approved' : 'Sent back') : 'Waits for your review';
  if (relay.needsYou) return `${ownName(relay.by ?? 'An agent')} asks you`;
  return relay.tone === 'working' ? 'Back at work' : relay.tone === 'todo' ? 'Waiting for its agent' : 'Answered'; // its thread done says so on its own card, never twice
}

// Who answered a question, and the first line of what they said: "You answered: “Tablets too.”".
export function answeredWords(relay: Pick<Relay, 'answer'>, name: string): string {
  const who = relay.answer && samePerson(relay.answer.by, name) ? 'You' : relay.answer?.by;
  return `${who} answered: “${firstLine(relay.answer?.body ?? '')}”`;
}

// What a review folds to once a person gave their verdict, and who gave it: "You approved it", "You sent it back: “The
// button still hides.”", "Pat approved it". None while it waits.
export function verdictWords(relay: Pick<Relay, 'verdict'>, name: string): string | undefined {
  const verdict = relay.verdict;
  if (!verdict) return undefined;
  const who = samePerson(verdict.by, name) ? 'You' : verdict.by;
  if (verdict.kind === 'approve') return `${who} approved it`;
  return `${who} sent it back${verdict.note ? `: “${firstLine(verdict.note)}”` : ''}`;
}

// Several that came in while the viewer was away, as one: what needs them
// first, then what was answered, then what was done, each the latest first,
// under a line that says how many threads (or pieces of work) moved.
export function relayStack<R extends Relay<CardRelay>>(relays: readonly R[]): { head: string; needs: R[]; answered: R[]; done: R[] } {
  const latest = (a: R, b: R) => b.at.localeCompare(a.at);
  const sources = new Set(relays.map((r) => r.thread?.id ?? r.key));
  const allThreads = relays.every((r) => r.thread);
  const what = allThreads ? (sources.size === 1 ? 'thread' : 'threads') : sources.size === 1 ? 'piece of work' : 'pieces of work';
  return {
    head: `${sources.size} ${what} moved while you were away`,
    needs: relays.filter((r) => r.needsYou).sort(latest),
    answered: relays.filter((r) => (r.kind === 'question' || r.kind === 'review') && !r.needsYou).sort(latest),
    done: relays.filter((r) => r.kind === 'done').sort(latest),
  };
}

// ---- the rows ---------------------------------------------------------------------------

// The viewer's visit, as the side keeps it: when they were last here (none
// on a first visit), and when this visit began.
export interface Visit {
  since: string | null;
  arrived: number;
}

// A row of the conversation: the day, where the viewer was last here,
// something said (with the said beside it, for the side to group them), a
// relay, or the relays that came while the viewer was away. `S` and `R` are
// the side's own said and relays, as it handed them in.
export type HomeRow<S extends Said<unknown> = Said<unknown>, R extends Relay<CardRelay> = Relay> =
  | { kind: 'day'; label: string; at: string }
  | { kind: 'since' }
  | { kind: 'said'; said: S; prev?: ThreadMessage; next?: ThreadMessage }
  | { kind: 'relay'; relay: R }
  | { kind: 'stack'; relays: R[]; at: string };

const DAY = 86_400_000;

// A day between messages, in the viewer's clock: Today, Yesterday, the day this week, else the date.
export function dayOf(iso: string, now: number): string {
  const at = new Date(iso);
  const today = new Date(now);
  if (at.toDateString() === today.toDateString()) return 'Today';
  if (at.toDateString() === new Date(now - DAY).toDateString()) return 'Yesterday';
  if (now - at.getTime() < 6 * DAY) return at.toLocaleDateString([], { weekday: 'long' });
  return at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// The rows, oldest first: what was said and the relays at when they came,
// those that came while the viewer was away (after `visit.since`, before it
// began) as one stack once there are several; a day's row before the first of
// each day, and "Since you were last here" before the first row after then
// that isn't the viewer's own.
export function homeRows<S extends Said<unknown>, R extends Relay<CardRelay>>(said: readonly S[], relays: readonly R[], me: string, visit: Visit, now: number): HomeRow<S, R>[] {
  const { since, arrived } = visit;
  const whileAway = since ? relays.filter((r) => r.at > since && Date.parse(r.at) <= arrived) : [];
  const stacked = new Set(whileAway.length > 1 ? whileAway.map((r) => r.key) : []);
  type Entry = { at: string; said?: S; relay?: R; stack?: R[] };
  const entries: Entry[] = [
    ...said.map((s) => ({ at: s.message.at, said: s })),
    ...relays.filter((r) => !stacked.has(r.key)).map((relay) => ({ at: relay.at, relay })),
    ...(stacked.size ? [{ at: whileAway[0].at, stack: whileAway }] : []),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const mineAt = (e: Entry) => Boolean(e.said && e.said.message.author.kind === 'human' && samePerson(e.said.message.author.name, me));
  const sinceAt = since ? entries.findIndex((e) => e.at > since && !mineAt(e)) : -1;
  const rows: HomeRow<S, R>[] = [];
  entries.forEach((e, i) => {
    const day = dayOf(e.at, now);
    if (i === 0 || dayOf(entries[i - 1].at, now) !== day) rows.push({ kind: 'day', label: day, at: e.at });
    if (i === sinceAt && i > 0) rows.push({ kind: 'since' });
    if (e.relay) rows.push({ kind: 'relay', relay: e.relay });
    else if (e.stack) rows.push({ kind: 'stack', relays: e.stack, at: e.at });
    else rows.push({ kind: 'said', said: e.said!, ...(entries[i - 1]?.said && { prev: entries[i - 1].said!.message }), ...(entries[i + 1]?.said && { next: entries[i + 1].said!.message }) });
  });
  return rows;
}
