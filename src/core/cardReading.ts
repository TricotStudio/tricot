// How agents read a card that waits on people, and what a card's events mean to an agent: the two rules the core
// asks of whoever supplies cards, which a part does with its assignees and first looks.
//
// - A backlog card is left alone by agents unless it is theirs or they were @-mentioned on it (`backlogAgents`, which
//   the MCP session's visibility, the terminal's who-line and a message's reach read). The core knows the @-mentions in
//   a card's text and comments; the agents a person addressed it to besides them come from the reading
//   (`CardReading.addressed`).
// - An event about one of the cards (a decision posted or resolved, a task planned, updated, brought back, a first look
//   run out) concerns an agent where the reading says so (`CardReading.eventConcerns` and, for a task, `concerns`, read by
//   concerns.ts); with none, it concerns nobody.
// - What an agent's events say of its work, which usage counts (`CardReading.work`, agentActivity.ts).
//
// The reading is one for the process, set by whatever builds the Store (a StorePart's `reading`, store/storePart.ts)
// and by the terminal, which holds no Store; a Store whose parts give none leaves what was set as it is, as
// addDataPart's list is (store/dataParts.ts). With none set, the core's own rule stands: a card is for the agents it
// @-mentions, and no event about a task concerns an agent.

import type { AgentWork } from './agentActivity';
import type { BoardCard } from './cards';
import { samePerson } from './format';
import { agentsIn, boardAgents, resolveMentions } from './mentions';
import type { Board, BoardEvent, Comment } from './types';

// What the core reads of a card of the reading's: its text and its discussion.
export interface ReadCard {
  title: string;
  detail?: string;
  comments: Comment[];
}

export interface CardReading {
  // The agents a person addressed a card to, ahead of those its text and comments @-mention, in the order they count.
  addressed(task: ReadCard): string[];
  // Whether an event about this task concerns the agent: `person` is whether a person caused the event.
  concerns(board: Board, task: ReadCard, agent: string, person: boolean): boolean;
  // Whether an event of the cards' own (the ones the core's rules do not cover) concerns the agent, or none when the reading
  // does not know the event.
  eventConcerns?(event: BoardEvent, board: Board, agent: string, person: boolean): boolean | undefined;
  // What the agent's own events say of its work: the cards it took up and finished, and what it posted.
  work?: AgentWork;
}

let reading: CardReading | undefined;

// Sets the reading for the process, or, with none, goes back to the core's own rule.
export function useCardReading(next: CardReading | undefined): void {
  reading = next;
}

// The agents a card's text, or any comment on it, @-mentions, after those already named (`lead`), in the order they
// are named. A comment the loop guard holds asks nobody unless `includeHeld`. `viewer` names the agent reading when
// it has only read the board, so a mention of it counts.
export function agentsMentionedOn(board: Board, task: ReadCard, viewer: string | undefined, includeHeld: boolean, lead: readonly string[] = []): string[] {
  const text = [task.title, task.detail].filter(Boolean).join('\n');
  const mentioned = resolveMentions(text, boardAgents(board, viewer ? [viewer] : []));
  const agents = [...new Set([...lead, ...mentioned])];
  for (const comment of task.comments) {
    if (!includeHeld && comment.held) continue;
    for (const agent of agentsIn(board, comment.mentions)) if (!agents.some((a) => samePerson(a, agent))) agents.push(agent);
  }
  return agents;
}

// The agents allowed to read a backlog card: anyone may ask another agent for feedback on it, even where it is
// assigned, so a held comment's mention counts.
export function backlogAgents(board: Board, task: ReadCard, viewer?: string): string[] {
  return agentsMentionedOn(board, task, viewer, true, reading?.addressed(task));
}

// The same for a card of a board (cards.ts): the reading is of the card the kind holds, not the BoardCard around it.
export const cardBacklogAgents = (board: Board, card: BoardCard, viewer?: string): string[] => backlogAgents(board, card.card as ReadCard, viewer);

// Whether an event about a task concerns the agent, by the reading in force.
export function taskConcerns(board: Board, task: ReadCard, agent: string, person: boolean): boolean {
  return reading?.concerns(board, task, agent, person) ?? false;
}

// Whether an event of the cards' own concerns the agent, by the reading in force: none when it is not one the reading knows.
export function cardEventConcerns(event: BoardEvent, board: Board, agent: string, person: boolean): boolean | undefined {
  return reading?.eventConcerns?.(event, board, agent, person);
}

// What the agent's events say of its work, by the reading in force.
export const readingWork = (): AgentWork | undefined => reading?.work;
