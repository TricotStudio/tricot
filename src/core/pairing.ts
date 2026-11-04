// Pairing: a person and one agent working side by side on a piece of the
// canvas in its full view (a website, a Google Doc). While they pair, what the
// person asks there is addressed to that agent, an @-mention it reads as
// asked of it, which wakes its wait at once (core/store/eventLog.ts); its
// steps show on the pin it was asked on (web/canvas/pairing/pinLine.tsx);
// and the view lists what was asked, each with its state. The agent is told
// it is being paired with while the session lasts (server/pairing.ts keeps
// sessions, in memory), and leaving sums the session up on the card
// (core/store/pairing.ts).
//
// What a session asked is read from the board, not kept apart: the comments
// the person wrote on the piece's pins since it started that @-mention the
// agent, one entry per pin. So the page's list and the summary agree, and
// nothing is lost when the server restarts mid-session.
//
// Types and words only: the browser imports this.

import { deliveryWords, stepText, type Delivery } from './delivery';
import { clip, samePerson, shortDuration } from './format';
import { findMentions, withoutLeadingMentions } from './mentions';
import { pinComments } from './pins';
import type { Comment, Decision, Pin, Task } from './types';

// A session ends when nothing has happened in it for this long: no request,
// and the person hasn't touched the view (the page says so with each beat).
export const PAIRING_IDLE_MS = 30 * 60_000;
// The page says it is still there this often; past PAIRING_GONE_MS without
// a word, it has gone (closed, asleep, crashed) and the session ends.
export const PAIRING_BEAT_MS = 60_000;
export const PAIRING_GONE_MS = 3 * 60_000;
// A comment's time is the server's, a session's start too, give or take.
const SLACK_MS = 2_000;

// A pairing session: a person pairing with an agent on a block's parts of one
// kind ('site' for a website's elements, 'doc' for a Google Doc's paragraphs).
export interface PairingSession {
  id: string;
  blockId: string;
  board: string; // the board's id
  part: string;
  person: string;
  agent: string;
  startedAt: string;
}

// How a session ended: the person left it (Browse, Close, another agent), it
// went idle, or the page went away.
export type PairingEnd = 'left' | 'idle' | 'gone';

// A request's text as it is sent while pairing: addressed to the agent, with
// its @-mention in front, unless it names one of the board's agents already
// (the person pointing it elsewhere on purpose).
export function addressTo(text: string, agent: string, agents: string[]): string {
  if (findMentions(text, [...agents, agent]).length > 0) return text;
  return `@${agent} ${text.trimStart()}`;
}

// Where a request stands: the agent is on it (or about to be), it replied
// (done), or it replied with something for the person (waiting on you).
export type RequestState = 'working' | 'done' | 'waiting';

export interface PairingRequest {
  pin: Pin;
  asked: Comment; // the first message to the agent on this pin in the session
  latest: Comment; // the person's latest message to it there
  state: RequestState;
  reply?: Comment; // the agent's reply since, if any
}

// Whether an agent's reply asks the person something back: it @-mentions
// them, or ends on a question.
export function asksBack(reply: Pick<Comment, 'body' | 'mentions'>, person: string): boolean {
  return Boolean(reply.mentions?.some((m) => samePerson(m, person))) || /\?["”’)\]]*\s*$/.test(reply.body.trim());
}

// What a session asked, in the order it was asked: each pin on the block the
// person wrote to the agent on since the session started.
export function pairingRequests(
  pins: Pin[],
  owner: { task?: Task; decision?: Decision },
  session: Pick<PairingSession, 'blockId' | 'person' | 'agent' | 'startedAt'>,
): PairingRequest[] {
  const since = Date.parse(session.startedAt) - SLACK_MS;
  const found: PairingRequest[] = [];
  for (const pin of pins) {
    if (pin.blockId !== session.blockId || !pin.discussion) continue;
    const comments = pinComments(pin, owner);
    const toAgent = comments.filter(
      (c) => c.author.kind === 'human' && samePerson(c.author.name, session.person) && Date.parse(c.createdAt) >= since && c.mentions?.some((m) => samePerson(m, session.agent)),
    );
    if (toAgent.length === 0) continue;
    const latest = toAgent.at(-1)!;
    const after = comments.slice(comments.indexOf(latest) + 1);
    const replies = after.filter((c) => c.author.kind === 'agent');
    const reply = replies.findLast((c) => samePerson(c.author.name, session.agent)) ?? replies.at(-1);
    // A person's word after the reply (another person's) leaves it with the agent again.
    const answered = reply && !after.slice(after.indexOf(reply) + 1).some((c) => c.author.kind === 'human');
    const state: RequestState = answered ? (asksBack(reply, session.person) ? 'waiting' : 'done') : pin.discussion.resolved ? 'done' : 'working';
    found.push({ pin, asked: toAgent[0], latest, state, ...(answered && { reply }) });
  }
  return found.sort((a, b) => Date.parse(a.asked.createdAt) - Date.parse(b.asked.createdAt));
}

// How long a session lasted, in a few words: "under a minute", "12 min", "1 h 5 min".
export function pairedFor(ms: number): string {
  if (ms < 60_000) return 'under a minute';
  return shortDuration(Math.round(ms / 60_000) * 60_000);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// A piece as a sentence names it: "the website "Tricot site"".
export const thePiece = (piece: string) => (/^the /i.test(piece) ? piece : `the ${piece}`);

// The line a session leaves on the card: "Paired 12 min with Claude on the
// website "Tricot site": 5 requests, 4 done, 1 open."
export function pairingSummary(input: { agent: string; piece: string; startedAt: string; endedAt: number; requests: Pick<PairingRequest, 'state'>[] }): string {
  const lasted = pairedFor(input.endedAt - Date.parse(input.startedAt));
  return `Paired ${lasted} with ${input.agent} on ${thePiece(input.piece)}: ${requestCount(input.requests)}.`;
}

// What a session asked, counted: "5 requests, 4 done, 1 open", "no requests".
export function requestCount(requests: Pick<PairingRequest, 'state'>[]): string {
  if (requests.length === 0) return 'no requests';
  const done = requests.filter((r) => r.state === 'done').length;
  return `${plural(requests.length, 'request')}, ${done} done, ${requests.length - done} open`;
}

// What the agent paired with is told while the session lasts, in get_board
// and its updates: who is pairing with it, on what, and how to answer.
export function pairingLine(session: Pick<PairingSession, 'person' | 'blockId'>, piece: string, where: string): string {
  return (
    `${session.person} is pairing with you on ${thePiece(piece)} (${where}) [block id: ${session.blockId}]: ` +
    `their requests there come straight to you, as @-mentions. Act on each as it comes, then reply on its pin after the change; ` +
    `they watch your steps on the pin while you work.`
  );
}

// The words under a request on its pin while the agent works on it: honest
// about what Tricot sees. Its step here, "Claude is on it · Editing
// index.html"; on the card with no step, "Claude is taking a look"; else
// where the request stands (core/delivery.ts): "Seen by Claude", "Delivered ·
// Claude is listening".
export function pinLineWords(delivery: Delivery, now: number): string | undefined {
  if (delivery.state === 'working' && delivery.step) return `${delivery.agent} is on it · ${stepText(delivery.step)}`;
  return deliveryWords(delivery, now);
}

// A request in the session's list, in a few words: what was asked, clipped.
export function requestWords(request: Pick<PairingRequest, 'asked'>): string {
  return clip(withoutLeadingMentions(request.asked.body, request.asked.mentions ?? []), 120);
}
