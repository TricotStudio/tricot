// What a request names of the cards made for it, without naming a kind of card: a person asking agents about blocks on a
// Sketchbook page may ask for one kind of card (a part's: a decision, or tasks), and the cards that answer a request are
// kept on it by the name of their kind, as `<kind>Ids` (`decisionIds`), the way an event names the cards it is about
// (`<kind>Id`, core/cards.ts). A kind of card says that it can be asked for, and what is said of it, as `BoardCardKind.asked`;
// a process with no such kind finds no kind of request, and a request that names one is refused as unknown.

import { boardCardKinds } from './cards';

// What is said of a kind of card that a person can ask agents for (core/requests.ts says the rest of a request).
export interface CardAsk {
  kind: string; // how a request names it, as it is stored on the request: `tasks`
  asked: string; // the words that stand for what a person left to agents, and title the request's group: "Plan tasks from these"
  left: string; // what agents are told when the person left it to them: "They left what to plan to you."
  said(text: string): string; // what agents are told of the words the person typed: `They said: "…".`
  about(blocks: string, on: string): string; // what a request asks, after "asked agents": ` to plan tasks from 2 blocks on …`
  answerHow(boardId: string, requestId: string): string; // how an agent answers it, after taking it
  unmet(by: string, boardId: string, requestId: string): string; // why it cannot be finished before the card is made
  made: string; // what the agent did, in the note that finishes it with the cards: "Planned"
  noun: string; // what the person asked for, as a command says it: "tasks"
  tool: string; // the agent tool that makes the cards for a request, which a command that cannot make them names: `plan_tasks`
}

// The kind of card a request of this name asks for, if a kind registered says it can be asked for.
export function askedKind(name: string | undefined): { asked: CardAsk; card: string } | undefined {
  if (!name) return undefined;
  for (const { kind, asked } of boardCardKinds()) if (asked?.kind === name) return { asked, card: kind };
  return undefined;
}

const keyOf = (kind: string) => `${kind}Ids`;

// The ids of the cards of one kind a request (or a thread's cards, or an answer) names: `decisionIds` for `decision`.
export function requestCardIds(request: object, kind: string): string[] {
  const ids = (request as Record<string, unknown>)[keyOf(kind)];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

// How many cards, of whatever kinds are registered, a request names.
export const requestCardCount = (request: object): number => boardCardKinds().reduce((count, { kind }) => count + requestCardIds(request, kind).length, 0);

// The request with these cards of one kind added to the ones it names, each once.
export function addRequestCards(request: object, kind: string, ids: string[]): void {
  if (ids.length) (request as Record<string, unknown>)[keyOf(kind)] = [...new Set([...requestCardIds(request, kind), ...ids])];
}
