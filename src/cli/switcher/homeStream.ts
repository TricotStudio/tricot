// The chat's stream in the Tricot tab: the board's Home conversation
// (core/homeConversation.ts decides what it holds, as it does for the page's
// Home), as items the chat draws and answers (chatView.ts, homeView.ts,
// threadsTab.ts). What was said is a message; under an ask that was sent on,
// or whose own thread an agent took on, a card names the thread it went to
// and where its work stands; a relay is what of the work needs the person (an
// agent's question, a thread done, a part's card blocked); and the relays
// that came while they were away come as one stack, its head and its groups
// written before its first relay. The day, and where the person was last
// here, are written before the first item after them (`before`).
//
// Each item keeps a place the line can answer in: a message its thread, a card
// the thread it leads to, a relay its thread, or a card blocked its discussion
// (a card of a kind the terminal was given, cli/switcher/run.ts). Only
// messages are reacted to.
import { cardOf } from '../../core/cards';
import { samePerson } from '../../core/format';
import type { ChatItem, ChatPlace, NumberedPlace } from '../../core/chatStream';
import {
  askedWhileWaiting,
  homeRelays,
  homeRows,
  homeSaid,
  lanesOf,
  ownedThreads,
  relayStack,
  strandOf,
  strandsShown,
  threadTone,
  type CardRelay,
  type OnBoard,
  type Relay,
  type Strand,
  type StrandTone,
  type Visit,
} from '../../core/homeConversation';
import { inConversation } from '../../core/roles';
import { askedTag } from '../../core/threadList';
import { shownTitle } from '../../core/threads';
import type { Board, Thread } from '../../core/types';

// What an item of Home's conversation is, beyond its message.
export type HomeMark =
  | { kind: 'said'; tag?: string; inWork: boolean } // `inWork`: asked in the conversation, its thread an agent's work now
  | { kind: 'sent'; to: Thread; taken: boolean; tone: StrandTone } // the card under an ask: the thread it went to
  | { kind: 'relay'; relay: Relay; stacked: boolean; link?: string }; // `link`: a part's card's page on the board

// What is written before an item: the day, where the person was last here,
// the head of the relays that came while they were away (when the first and
// the last came) and the group each of those is in.
export type Divider =
  | { kind: 'day'; label: string }
  | { kind: 'since' }
  | { kind: 'away'; head: string; from: string; to: string }
  | { kind: 'group'; label: string; count: number; needsYou: boolean };

export interface StreamItem extends ChatItem {
  home?: HomeMark;
  before?: Divider[];
  sig?: string; // what its lines show beyond its message, for the layout to tell when to lay it out again
}

export interface HomeInput {
  board: Board;
  me: string;
  onBoard: readonly OnBoard[]; // the agents on the board, as presence says
  asked: ReadonlySet<string>; // the questions remembered relayed while their thread waited on a person
  visit: Visit;
  now: number;
  cards?: readonly CardRelay[]; // what a part relays of its cards
  link?: (card: { kind: string; id: string }) => string | undefined; // a part's card's page on the board
}

export interface HomeStream {
  items: StreamItem[];
  strands: Strand[]; // the threads agents own beside the conversation, those done before it began left out
  lanes: Map<string, number>;
  waiting: string[]; // the questions relayed while their thread waits on a person, to remember
}

const placeOf = (thread: Thread): ChatPlace => {
  const lens = thread.lens && thread.lens.name !== 'General' ? thread.lens.name : undefined;
  return { kind: 'thread', id: thread.id, title: shownTitle(thread), ...(lens && { lens }) };
};

// Where a relay is answered: its thread, or its card's discussion; none for a card of a kind this terminal doesn't know.
function relayPlace(board: Board, relay: Relay): ChatPlace | undefined {
  if (relay.thread) return placeOf(relay.thread);
  const card = relay.card?.card && cardOf(board, relay.card.card.kind, relay.card.card.id);
  return card ? ({ kind: card.kind.kind, id: card.id, number: card.number, title: card.title } as NumberedPlace) : undefined;
}

const relaySig = (relay: Relay, stacked: boolean): string =>
  JSON.stringify([relay.kind, relay.tone, relay.needsYou, relay.answer, relay.title, relay.label, relay.body, relay.by, stacked]);

export function homeStream({ board, me, onBoard, asked, visit, now, cards = [], link }: HomeInput): HomeStream {
  const conversation = (board.threads ?? []).filter(inConversation);
  const owned = ownedThreads(board);
  const said = homeSaid(board, conversation, owned, (thread) => thread.messages, (message) => message, (message) => message);
  const relays = homeRelays(board, me, onBoard, asked, () => [], cards);
  const items: StreamItem[] = [];
  let before: Divider[] = [];
  const push = (item: StreamItem) => {
    items.push(before.length ? { ...item, before, sig: `${item.sig ?? ''}\u0000${JSON.stringify(before)}` } : item);
    before = [];
  };
  const relayItem = (relay: Relay, stacked: boolean) => {
    const place = relayPlace(board, relay);
    const message = relay.thread?.messages.find((m) => m.id === relay.key);
    const page = relay.card?.card && link?.(relay.card.card);
    push({
      key: `relay:${relay.key}`,
      id: relay.key,
      author: { kind: 'agent', name: relay.by ?? '' },
      body: relay.body,
      at: relay.at,
      ...(message?.reactions?.length && { reactions: message.reactions }),
      // A card of a kind this terminal doesn't know has nowhere to be answered: it reads as the board's, and isn't chosen.
      place: place ?? { kind: 'board', pin: { id: '', quote: '' } },
      home: { kind: 'relay', relay, stacked, ...(page && { link: page }) },
      sig: relaySig(relay, stacked),
    });
  };
  for (const row of homeRows(said, relays, me, visit, now)) {
    if (row.kind === 'day') before.push({ kind: 'day', label: row.label });
    else if (row.kind === 'since') before.push({ kind: 'since' });
    else if (row.kind === 'relay') relayItem(row.relay, false);
    else if (row.kind === 'stack') {
      const { head, needs, answered, done } = relayStack(row.relays);
      before.push({ kind: 'away', head, from: row.relays[0].at, to: row.relays.at(-1)!.at });
      for (const [label, group, needsYou] of [['Needs you', needs, true], ['Answered', answered, false], ['Done', done, false]] as const) {
        if (!group.length) continue;
        before.push({ kind: 'group', label, count: group.length, needsYou });
        for (const relay of group) relayItem(relay, true);
      }
    } else {
      const { thread, message, first, inWork, sentOn, taken } = row.said;
      const tag = first ? askedTag(thread, board) : undefined;
      push({
        key: `thread:${thread.id}:${message.id}`,
        id: message.id,
        author: message.author,
        body: message.body,
        at: message.at,
        ...(message.reactions?.length && { reactions: message.reactions }),
        place: placeOf(thread),
        home: { kind: 'said', ...(tag && { tag }), inWork },
        sig: `${tag ?? ''}\u0000${inWork}`,
      });
      for (const to of sentOn) {
        const tone = threadTone(to, onBoard);
        push({
          key: `sent:${message.id}:${to.id}`,
          id: to.id,
          author: { kind: 'agent', name: to.owner ?? '' },
          body: '',
          at: message.at,
          place: placeOf(to),
          home: { kind: 'sent', to, taken: Boolean(taken), tone },
          sig: JSON.stringify([shownTitle(to), to.owner, tone, Boolean(taken)]),
        });
      }
    }
  }
  const strands = strandsShown(
    owned.map((thread) => strandOf(thread, threadTone(thread, onBoard))),
    said[0]?.message.at,
  );
  return { items, strands, lanes: lanesOf(strands), waiting: askedWhileWaiting(relays) };
}

// ---- what an item is for ---------------------------------------------------------------

const mine = (item: ChatItem, me: string) => item.author.kind === 'human' && samePerson(item.author.name, me);

// Whether Tab chooses it, to answer or open: what others said, a card, a relay that has a place to answer in.
export function choosable(item: StreamItem, me: string): boolean {
  const home = item.home;
  if (!home || home.kind === 'said') return !mine(item, me);
  if (home.kind === 'sent') return true;
  return Boolean(home.relay.thread || (item.place.kind !== 'board' && home.relay.card));
}

// Whether the line answers it while nothing else is chosen: what others said, and a question that needs the person.
export function answersLatest(item: StreamItem, me: string): boolean {
  const home = item.home;
  if (!home || home.kind === 'said') return !mine(item, me);
  return home.kind === 'relay' && home.relay.kind === 'question' && home.relay.needsYou;
}

// Whether 1 2 3 react to it: a message, a relay of one included.
export const reactable = (item: StreamItem): boolean => !item.home || item.home.kind === 'said' || (item.home.kind === 'relay' && item.home.relay.thread !== undefined);

// What Enter opens of it, chosen with nothing typed: the thread a card leads to, a relay's thread, the
// thread an ask is in now, or a part's card's page on the board.
export function opens(item: StreamItem): { thread: string } | { page: string } | undefined {
  const home = item.home;
  if (!home) return undefined;
  if (home.kind === 'sent') return { thread: home.to.id };
  if (home.kind === 'said') return home.inWork && item.place.kind === 'thread' ? { thread: item.place.id } : undefined;
  if (home.relay.thread) return { thread: home.relay.thread.id };
  return home.link ? { page: home.link } : undefined;
}
