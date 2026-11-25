// What concerns a listening agent: the events on a board it should act on.
// A wait ends for one of these (server/mcp/session.ts listen, for
// wait_for_updates and a reply's then_wait), and Tricot can wake an agent it
// started for one (cli/switcher). Everything else, such as another agent's
// progress, a canvas edit or a person's change of lens, reaches the agent in
// the updates of its next wake: nothing is lost, but nothing else wakes it.
// Each event is weighed against the board as it is when it's heard.
//
// It reads by the rules its updates read by, not a second set: who a message
// is for (delivery.ts meantFor), who a request is for (requests.ts), and, for
// the events of the cards, what the cards' reading says (cardReading.ts: which
// tasks are ready for it, which first look is asked of it, whose answer a
// decision waits on).
// What concerns an agent:
// - a message, mention or request for it or for any agent: a comment or
//   thread message, a request on the board context or about blocks on a
//   Sketchbook page (for a decision, tasks or anything), a first look asked
//   of it, a person pairing with it, the end of a pairing session of its own
//   whose thread is at work, a person asking agents to explore a card
//   or plan its tasks;
// - a question: a card a person posts;
// - an answer to its question: a person deciding, deferring or retiring a
//   card it posted, recommended, asked people about or is building on; a
//   person's 👍 or 👎 on its comment; a reply from whoever it @-mentioned;
// - a ready task it could claim;
// - a person's word on its work: a task sent back, approved, or with a
//   commit asked for;
// - a request to refresh a card or sync the board context;
// - the work of a thread it sent a person's message on to, done (core/roles.ts).

import { discussionAt, type Said } from './answering';
import { eventCardsLeading, cardOf } from './cards';
import { cardEventConcerns } from './cardReading';
import { meantFor, type Where } from './delivery';
import { samePerson } from './format';
import { eventComment, isAnswer, reactionIn } from './reactions';
import { requestFor } from './requests';
import { pairingThread } from './roles';
import { isThreadEvent } from './threads';
import type { Actor, Board, BoardEvent } from './types';

// Whether an event is for whoever reads it: one for a single agent
// (BoardEvent.forAgent) is for that agent alone among agents, and for any
// agent it @-mentions.
export function forReader(event: Pick<BoardEvent, 'forAgent' | 'mentions'>, reader: Actor): boolean {
  if (reader.kind !== 'agent' || !event.forAgent || samePerson(event.forAgent, reader.name)) return true;
  return Boolean(event.mentions?.some((m) => samePerson(m, reader.name)));
}

export const isAgent = (actor: Actor | undefined, agent: string) => actor?.kind === 'agent' && samePerson(actor.name, agent);

// Whether an event concerns this agent (by name), as the list above says.
// Never its own, one for another agent alone, or an agent's message the loop
// guard holds (agentTalk.ts).
export function concernsAgent(event: BoardEvent, board: Board, agent: string): boolean {
  const me = (actor: Actor | undefined) => isAgent(actor, agent);
  if (me(event.actor) || event.held || !forReader(event, { kind: 'agent', name: agent })) return false;
  const person = event.actor.kind === 'human';
  switch (event.type) {
    case 'comment_added':
    case 'thread_started':
    case 'thread_replied':
      return messageConcerns(event, board, agent);
    case 'request_asked': {
      const request = board.requests?.find((r) => r.id === event.itemId);
      return request?.status === 'open' && requestFor(request, agent);
    }
    case 'pairing_started':
      return Boolean(event.forAgent && samePerson(event.forAgent, agent));
    // A pairing's end concerns no one, but a session of its own's, which asks it to set its thread done while that is
    // at work (core/store/pairing.ts): the event is about that thread.
    case 'pairing_ended': {
      const thread = board.threads?.find((t) => t.id === event.itemId);
      return Boolean(event.forAgent && samePerson(event.forAgent, agent) && thread && pairingThread(thread) && thread.status !== 'done' && samePerson(thread.owner!, agent));
    }
    case 'thread_status_changed':
      return doneWhereItSent(event, board, agent);
    case 'sync_requested':
      return Boolean(board.syncRequest);
    case 'comment_reacted': {
      const reaction = reactionIn(event);
      return Boolean(reaction?.on && isAnswer(reaction.emoji) && me(eventComment(event, board)?.item.author));
    }
    default:
      // The events of the cards (a decision resolved, a task planned...) are the reading's to weigh (cardReading.ts).
      return cardEventConcerns(event, board, agent, person) ?? false;
  }
}

// A comment or thread message: for it or for any agent (meantFor), or a
// reply from whoever it @-mentioned there last.
function messageConcerns(event: BoardEvent, board: Board, agent: string): boolean {
  const where = placeOf(event, board);
  if (!where) return false;
  const found = discussionAt(event, board);
  const meant = meantFor(board, where, found?.said ?? { author: event.actor, mentions: event.mentions });
  if (meant && (meant.length === 0 || meant.some((name) => samePerson(name, agent)))) return true;
  return Boolean(found && answersIt(found.discussion.items, found.said, agent));
}

// Where a message is, as meantFor reads it: the card it is on (the one its event leads to, cards.ts), the thread or the
// board context. A card the board no longer has is nowhere.
function placeOf(event: BoardEvent, board: Board): Where | undefined {
  const named = eventCardsLeading(event)[0];
  if (named) {
    const card = cardOf(board, named.kind, named.id);
    return card && ({ [named.kind]: card.card } as Where);
  }
  if (isThreadEvent(event)) {
    const thread = board.threads?.find((t) => t.id === event.itemId);
    return thread && { thread };
  }
  return { boardContext: true };
}

// A thread this agent sent a person's message on to, its work now done
// (core/roles.ts): the coordinator tells the person.
function doneWhereItSent(event: BoardEvent, board: Board, agent: string): boolean {
  const thread = board.threads?.find((t) => t.id === event.itemId);
  if (thread?.status !== 'done') return false;
  return Boolean(board.threads?.some((t) => t.messages.some((m) => m.sent?.threadId === thread.id && isAgent(m.author, agent))));
}

// Whether a message answers what this agent asked: its last message before
// it there @-mentions whoever wrote it, and the loop guard didn't hold that.
function answersIt(items: Said[], said: Said, agent: string): boolean {
  const asked = items.slice(0, items.indexOf(said)).findLast((m) => isAgent(m.author, agent));
  return Boolean(asked && !asked.held && asked.mentions?.some((name) => samePerson(name, said.author.name)));
}
