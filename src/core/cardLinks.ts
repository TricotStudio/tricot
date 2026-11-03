// Deleting a task or decision a person made by mistake. It is for good, as
// deleting a board is, once the person has read what links to it and
// confirmed (a board asks for its name typed out; a card needs no more than
// a second click). Nothing of the card is kept but its number, so text that
// names it reads as deleted and the number is never given again. Pure: the
// store deletes (store/cardDeletion.ts); this says what links to a card and
// how a deleted one reads.

import { clip, listNames } from './format';
import { findRefs, refLabel, type RefKind } from './refs';
import type { Block, Board, Canvas, DeletedCard, Decision, Task, Thread } from './types';

export type Card = { task: Task } | { decision: Decision };

// What a card is called in text: T12 or #8.
export function cardRef(card: Card): string {
  return 'task' in card ? `T${card.task.number}` : `#${card.decision.number}`;
}

// The deleted card a board remembers by this id, or by this kind and number.
export function deletedCard(board: Pick<Board, 'deletedCards'>, id: string): DeletedCard | undefined {
  return board.deletedCards?.find((c) => c.id === id);
}

export function deletedNumber(board: Pick<Board, 'deletedCards'>, kind: RefKind, number: number): DeletedCard | undefined {
  return board.deletedCards?.find((c) => c.kind === kind && c.number === number);
}

// Whether a stale task went stale because a person deleted the decision it
// built on: there is no decision to re-read, so it is checked without it.
export function staleFromDeleted(board: Pick<Board, 'decisions'>, task: Task): boolean {
  return Boolean(task.stale) && !board.decisions.some((d) => d.id === task.stale!.decisionId);
}

// A deleted card as agents read of it, when they ask for it by id.
export function deletedCardLine(card: DeletedCard): string {
  const what = card.kind === 'task' ? 'task' : 'decision';
  return `${refLabel(card)} was a ${what} ${card.by.name} deleted at ${card.at}. It's gone for good, with its canvas and discussion; nothing of it can be read or restored.`;
}

// What links to a card, for the confirmation before it is deleted.
export interface CardLinks {
  builtOn: Task[]; // a decision's: tasks built on it, which lose the link and are flagged stale
  neededBy: Decision[]; // a decision's: decisions that depend on it, which lose that link
  implements: Decision[]; // a task's: the decisions it implements
  threads: { title: string; made: boolean; gone: boolean }[]; // threads it came from (made) or shows in; gone once deleted
  pinnedFrom: string[]; // the canvases with a part of a block pinned to it: T3, #5, the board context
  namedIn: string[]; // the cards and threads whose text names it: T3, #5, the board context, thread "Logins"
}

// `blockText` reads a block's words, as search does (its kind's searchText,
// which only the server has), for canvases that name the card.
export function cardLinks(board: Board, card: Card, blockText: (block: Block) => (string | undefined)[]): CardLinks {
  const id = 'task' in card ? card.task.id : card.decision.id;
  const self = 'task' in card ? card.task : card.decision;
  const kind: RefKind = 'task' in card ? 'task' : 'decision';
  const number = self.number;
  const names = (text: string | undefined) => Boolean(text) && findRefs(text!, (k, n) => k === kind && n === number).length > 0;
  const others = {
    decisions: board.decisions.filter((d) => d.id !== id),
    tasks: board.tasks.filter((t) => t.id !== id),
  };

  // Threads: the one it came from, then those whose messages show it.
  const threads: CardLinks['threads'] = [];
  const from = self.fromThread;
  if (from) threads.push({ title: from.title, made: true, gone: !board.threads?.some((t) => t.id === from.id) });
  for (const thread of board.threads ?? []) {
    if (thread.id === from?.id) continue;
    const shows = (r: { kind: string; id: string }) => r.kind === kind && r.id === id;
    if (thread.messages.some((m) => m.refs?.some(shows)) || thread.pending?.some(shows)) threads.push({ title: thread.title, made: false, gone: false });
  }

  // Canvases elsewhere with a pin to it.
  const pinned = (canvas: Canvas) => canvas.pins.some((p) => (kind === 'task' ? p.taskId : p.decisionId) === id);
  const pinnedFrom = [
    ...(pinned(board.canvas) ? ['the board context'] : []),
    ...others.decisions.filter((d) => pinned(d.canvas)).map((d) => `#${d.number}`),
    ...others.tasks.filter((t) => pinned(t.canvas)).map((t) => `T${t.number}`),
  ];

  // Text that names it, card by card: what it says, its discussion and its canvas.
  const onCanvas = (canvas: Canvas) => canvas.blocks.some((b) => blockText(b).some(names));
  const namedIn = [
    ...(onCanvas(board.canvas) ? ['the board context'] : []),
    ...others.decisions
      .filter((d) => names(d.question) || names(d.context) || d.comments.some((c) => names(c.body)) || onCanvas(d.canvas))
      .map((d) => `#${d.number}`),
    ...others.tasks
      .filter((t) => names(t.title) || names(t.detail) || t.notes.some((n) => names(n.text)) || t.comments.some((c) => names(c.body)) || onCanvas(t.canvas))
      .map((t) => `T${t.number}`),
    ...(board.threads ?? []).filter((t: Thread) => t.messages.some((m) => names(m.body))).map((t) => `thread "${clip(t.title, 50)}"`),
  ];

  return {
    builtOn: 'decision' in card ? board.tasks.filter((t) => t.decisionIds.includes(id)) : [],
    neededBy: 'decision' in card ? others.decisions.filter((d) => d.dependsOn.includes(id)) : [],
    implements: 'task' in card ? card.task.decisionIds.flatMap((d) => board.decisions.filter((x) => x.id === d)) : [],
    threads,
    pinnedFrom,
    namedIn,
  };
}

// The links as sentences, saying what deleting the card does to each: for
// the confirmation, which names the cards (T3, #5) so they link.
export function cardLinkLines(links: CardLinks): string[] {
  const lines: string[] = [];
  const refs = (cards: { number: number }[], prefix: string) => listNames(cards.map((c) => `${prefix}${c.number}`));
  const verb = (n: number, one: string, many: string) => (n === 1 ? one : many);
  if (links.builtOn.length) {
    const n = links.builtOn.length;
    lines.push(`${refs(links.builtOn, 'T')} ${verb(n, 'builds', 'build')} on it: ${verb(n, 'it loses', 'they lose')} the link and ${verb(n, 'is', 'are')} flagged stale, so an agent re-checks ${verb(n, 'it', 'them')}.`);
  }
  if (links.neededBy.length) {
    const n = links.neededBy.length;
    lines.push(`${refs(links.neededBy, '#')} ${verb(n, 'depends', 'depend')} on it, and ${verb(n, 'loses', 'lose')} that link.`);
  }
  if (links.implements.length) lines.push(`It implements ${refs(links.implements, '#')}, which ${verb(links.implements.length, 'stays', 'stay')} as ${verb(links.implements.length, 'it is', 'they are')}.`);
  for (const thread of links.threads) {
    const how = thread.made ? 'It came from' : 'It shows in';
    lines.push(`${how} the thread "${clip(thread.title, 60)}"${thread.gone ? ', since deleted' : ', which stays and says it was deleted'}.`);
  }
  if (links.pinnedFrom.length) {
    lines.push(`A part of a block on ${listNames(links.pinnedFrom.map(canvasOf))} is pinned to it; ${verb(links.pinnedFrom.length, 'that pin goes', 'those pins go')}.`);
  }
  if (links.namedIn.length) {
    lines.push(`${capital(listNames(links.namedIn))} ${verb(links.namedIn.length, 'names', 'name')} it in ${verb(links.namedIn.length, 'its', 'their')} text, which will read as deleted.`);
  }
  return lines;
}

const canvasOf = (where: string) => (where === 'the board context' ? where : `${where}'s canvas`);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
