// Who will get what is being typed in the Tricot tab's threads, said under the
// line as the page's chat bar says who is listening (web/threads/chatBar.tsx):
// from the agents on the board now (the stream's presence, live.ts), and whom
// the message is for as agents read it (core/delivery.ts meantFor): those it
// @-mentions, else the agent a thread's lens routes to, else any agent. A
// message for people only asks no agent. Nothing is stored or sent: it is read
// from what the tab holds, on each drawing.
//
// The chat's stream answers comments too, in a task's or a decision's
// discussion or on a pinned part, and says who hears them in a few words
// after where they go (hearsIt): the agents the message @-mentions; else, on
// a task, its assignee, or the agent that claimed it once it is under way
// (meantFor again); else any agent on the board now. A backlog card is the
// exception, as agents leave one alone unless it is theirs or they were
// @-mentioned on it (core/firstLook.ts backlogAgents): with none of those
// here, only people see what is said there. With no agent here at all, the
// comment stays on the card, or the board, for people to see.
//
// A tag on an agent's mention (core/agentTags.ts, `@Claude:opus:high`) adds
// what that agent does this message on ("to Claude, on Opus at high
// thinking"); for one that can't take it, or a tag it can't read, the row
// says so in the alert colour before anything is sent, and the message still goes.
import { tagOn, tagWords } from '../../core/agentTags';
import type { AgentBrowserHalf } from '../../core/agents/agent';
import { backlogAgents } from '../../core/firstLook';
import { LISTEN_PHRASE, listeningLabel, meantFor, notListeningHere, replyingTo, sayTo, type Where } from '../../core/delivery';
import { listNames, samePerson } from '../../core/format';
import { findMentions, peopleIn, resolveMentions } from '../../core/mentions';
import type { Board, Thread } from '../../core/types';
import type { AgentPresence } from '../../server/presence';
import type { Tone } from './strip';

export interface WhoInput {
  board: Pick<Board, 'activity'>;
  thread?: Pick<Thread, 'lens' | 'messages'>; // the thread replied in; none: a new one
  text: string; // as typed
  names: string[]; // everyone a mention can name here
  presence: AgentPresence[];
  connected: string[]; // the agents this terminal runs, for naming one that isn't listening
  agents?: string[]; // the board's agents among `names`, whose mentions take a tag
  kindOf?: (name: string) => AgentBrowserHalf | undefined; // which agent one is, when known
}

// What the tags in a message ask, as the row says it: the agent each is for
// and what it does it on ("Claude, on Opus at high thinking"), or why one
// can't, in sentences. None without a tag.
function tagsIn({ text, names, agents = [], kindOf }: Pick<WhoInput, 'text' | 'names' | 'agents' | 'kindOf'>): { on: { name: string; words: string }[]; problems: string[] } | undefined {
  const tagged = findMentions(text, names, agents).filter((m) => m.tag);
  if (tagged.length === 0) return undefined;
  const on: { name: string; words: string }[] = [];
  const problems: string[] = [];
  for (const { name, tag } of tagged) {
    const kind = kindOf?.(name);
    const read = tagOn(kind, name, tag!);
    if ('problem' in read) problems.push(read.problem);
    else on.push({ name, words: tagWords(kind!, read.on) });
  }
  return { on, problems };
}

// The row's words with what the tags ask, or, alerting, why one can't be
// honoured, before them. `place`: where the message goes is said already
// ("to T19 …"), so what it runs on follows who hears it ("Claude hears it,
// on Opus at high thinking"); else it leads ("to Claude, on Opus at high thinking · …").
function withTags(said: { text: string; tone: Tone }, input: Pick<WhoInput, 'text' | 'names' | 'agents' | 'kindOf'>, place: boolean): { text: string; tone: Tone } {
  const tags = tagsIn(input);
  if (!tags) return said;
  if (tags.problems.length) return { text: `${tags.problems.join(' ')} ${said.text}`, tone: 'alert' };
  if (!place) return { text: `${tags.on.map(({ name, words }) => `to ${name}, ${words}`).join('; ')} · ${said.text}`, tone: said.tone };
  const on = tags.on.length === 1 ? `, ${tags.on[0].words}` : `; ${tags.on.map(({ name, words }) => `${name} ${words}`).join('; ')}`;
  return { text: `${said.text}${on}`, tone: said.tone };
}

// What becomes of a message: for people only; for agents by name, all here
// and listening or not; for one that isn't here; on a backlog card no agent
// here may read; for any agent, those here; or for any, with none here.
type Reach =
  | { kind: 'people'; names: string[] }
  | { kind: 'named'; names: string[]; listening: boolean }
  | { kind: 'gone'; name: string }
  | { kind: 'backlog' }
  | { kind: 'any'; names: string[] }
  | { kind: 'away'; words: string; agent: string }
  | { kind: 'none' };

const isWord = (count: number) => (count === 1 ? 'is' : 'are');
const hearWord = (count: number) => (count === 1 ? 'hears' : 'hear');

function reach(board: Pick<Board, 'activity'>, where: Where, { text, names, presence, connected }: Omit<WhoInput, 'board' | 'thread'>): Reach {
  const mentions = resolveMentions(text, names);
  const meant = meantFor(board, where, { author: { kind: 'human', name: '' }, mentions });
  if (!meant) return { kind: 'people', names: peopleIn(board, mentions) };
  const here = presence.filter((a) => a.state !== 'away');
  const stateOf = (name: string) => here.find((a) => samePerson(a.name, name))?.state;

  // For one agent, or several, by name: the thread's own when it names none.
  const replying = 'thread' in where && replyingTo(where.thread, here.map((a) => a.name));
  const named = meant.length ? meant : replying ? [replying] : [];
  if (named.length) {
    const gone = named.find((name) => !stateOf(name));
    if (gone) return { kind: 'gone', name: gone };
    return { kind: 'named', names: named, listening: named.every((name) => stateOf(name) === 'listening') };
  }

  // Any agent: those on the board now, and on a backlog card only those it is for.
  if ('task' in where && where.task.status === 'backlog') {
    const may = backlogAgents(board as Board, where.task);
    const reading = here.filter((a) => may.some((name) => samePerson(name, a.name)));
    return reading.length ? { kind: 'any', names: reading.map((a) => a.name) } : { kind: 'backlog' };
  }
  if (here.length) return { kind: 'any', names: here.map((a) => a.name) };
  const away = notListeningHere(presence.map((a) => a.name), connected);
  if (away) return { kind: 'away', words: away, agent: presence[0]?.name ?? connected[0] };
  return { kind: 'none' };
}

// The line: what happens to the message, and whether anyone is there to see
// it, after what its tags ask.
export function heardBy(input: WhoInput): { text: string; tone: Tone } {
  return withTags(heard(input), input, false);
}

function heard({ board, thread, ...input }: WhoInput): { text: string; tone: Tone } {
  const said = reach(board, thread ? { thread: thread as Thread } : { boardContext: true }, input);
  switch (said.kind) {
    case 'people':
      return { text: `For ${listNames(said.names)} only: no agent is asked.`, tone: 'normal' };
    case 'named': {
      const verb = isWord(said.names.length);
      if (said.listening) return { text: `${listNames(said.names)} ${verb} listening: this is seen at once.`, tone: 'normal' };
      return { text: `${listNames(said.names)} ${verb} between steps: this is seen at the next check of the board.`, tone: 'normal' };
    }
    case 'gone':
      return { text: `${said.name} isn't listening here. ${sayTo(said.name)} “${LISTEN_PHRASE}”`, tone: 'alert' };
    case 'any':
      return { text: `${listeningLabel(said.names)} ${isWord(said.names.length)} listening.`, tone: 'normal' };
    case 'away':
      return { text: `${said.words}. ${sayTo(said.agent)} “${LISTEN_PHRASE}”`, tone: 'alert' };
    case 'backlog': // a thread is on no card
    case 'none':
      return { text: 'No agent is listening on this board: what you send waits for one.', tone: 'alert' };
  }
}

// The same in a few words, for the stream's row, which says first where the
// message goes: "Claude hears it", "Claude and Codex hear it at the next
// check", "Claude isn't listening here", "only people see it: agents skip
// the backlog". `where`: a thread, a task's or a decision's discussion (a
// part pinned on a card's canvas is in it), or a part of the board context.
// What its tags ask follows: "Claude hears it, on Opus at high thinking".
export function hearsIt(where: Where, input: Omit<WhoInput, 'thread'>): { text: string; tone: Tone } {
  return withTags(hearsItThere(where, input), input, true);
}

function hearsItThere(where: Where, { board, ...input }: Omit<WhoInput, 'thread'>): { text: string; tone: Tone } {
  const said = reach(board, where, input);
  switch (said.kind) {
    case 'people':
      return { text: `for ${listNames(said.names)} only`, tone: 'normal' };
    case 'named':
      return { text: `${listNames(said.names)} ${hearWord(said.names.length)} it${said.listening ? '' : ' at the next check'}`, tone: 'normal' };
    case 'gone':
      return { text: `${said.name} isn't listening here`, tone: 'alert' };
    case 'any':
      return { text: `${listeningLabel(said.names)} ${hearWord(said.names.length)} it`, tone: 'normal' };
    case 'away':
      return { text: said.words, tone: 'alert' };
    case 'backlog':
      return { text: 'only people see it: agents skip the backlog', tone: 'normal' };
    case 'none':
      return { text: `no agent is listening: ${'thread' in where ? 'it waits for one' : 'people see it'}`, tone: 'alert' };
  }
}
