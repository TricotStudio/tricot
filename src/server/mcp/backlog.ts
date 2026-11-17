// Backlog visibility is decided before MCP renders any content. The browser
// and REST still read the whole board; a person's assignment or any direct mention makes
// a backlog card visible to the named agents, and ready cards are visible as usual. Which
// kinds of card can wait in the backlog is the kinds' own say (core/cards.ts `backlog`).
import { boardCardKinds, cardOf, cardOwning, cardsOf, cardsOfKind, eventCards, namedCards, type BoardCard } from '../../core/cards';
import { cardBacklogAgents } from '../../core/cardReading';
import { deletedCard } from '../../core/deletedCards';
import { samePerson } from '../../core/format';
import { canvasesOf } from '../../core/pins';
import type { Store } from '../../core/store';
import type { Actor, Board, BoardEvent, Canvas, ThreadRef } from '../../core/types';
import type { Told } from '../../core/words';

export function cardVisible(board: Board, card: BoardCard, agent: string): boolean {
  return !card.inBacklog || cardBacklogAgents(board, card, agent).some((name) => samePerson(name, agent));
}

// Whether a card the link names (a pin's, an event's) is one this agent may not read, when the board still has it.
const linksHidden = (board: Board, link: object, agent: string): boolean =>
  namedCards(link).some(({ kind, id }) => {
    const card = cardOf(board, kind, id);
    return card !== undefined && !cardVisible(board, card, agent);
  });

// Whether an agent reads an event in its updates: one about a card that can wait in the backlog only
// while it may read the card, and one about a card since deleted only when
// it knew the card (`known`: the cards its session was shown, which it adds
// to). The session's updates (mcp/session.ts) and what Tricot's terminal
// wakes it for (server/wakes.ts) read by this one rule.
export function eventVisibleTo(board: Board, event: BoardEvent, agent: string, known?: { has(id: string): boolean; add(id: string): void }): boolean {
  const backlogKinds = boardCardKinds().filter((kind) => kind.backlog);
  const named = eventCards(event).find((card) => backlogKinds.some((kind) => kind.kind === card.kind));
  const gone = event.itemId ? deletedCard(board, event.itemId) : undefined;
  const id = named?.id ?? (gone && backlogKinds.some((kind) => kind.kind === gone.kind) ? gone.id : undefined);
  if (!id) return true;
  const card = named ? cardOf(board, named.kind, named.id) : undefined;
  if (!card) return known?.has(id) ?? false;
  const visible = cardVisible(board, card, agent);
  if (visible) known?.add(id);
  return visible;
}

export function agentCanvas(board: Board, canvas: Canvas, agent: string): Canvas {
  const pins = canvas.pins.filter((pin) => !linksHidden(board, pin, agent));
  return pins.length === canvas.pins.length ? canvas : { ...canvas, pins };
}

export function agentBoard(board: Board, agent: string): Board {
  const hiddenCards = cardsOf(board).filter((card) => !cardVisible(board, card, agent));
  if (!hiddenCards.length) return board;
  const hidden = new Set(hiddenCards.flatMap((card) => [card.id, ...card.canvas.blocks.map((b) => b.id), ...card.canvas.pins.map((p) => p.id)]));
  const visibleRef = (ref: ThreadRef) => !hidden.has(ref.id) && (!ref.on || !hidden.has(ref.on));
  const lists = boardCardKinds().filter((kind) => kind.list in board).map((kind) => [
    kind.list,
    cardsOfKind(board, kind.kind)
      .filter((card) => cardVisible(board, card, agent))
      .map((card) => ({ ...(card.card as object), canvas: agentCanvas(board, card.canvas, agent) })),
  ]);
  return {
    ...board,
    ...Object.fromEntries(lists),
    canvas: agentCanvas(board, board.canvas, agent),
    pages: board.pages?.map((page) => ({ ...page, canvas: agentCanvas(board, page.canvas, agent) })),
    threads: board.threads?.map((thread) => ({
      ...thread,
      pending: thread.pending?.filter(visibleRef),
      messages: thread.messages.map((message) => ({ ...message, refs: message.refs?.filter(visibleRef) })),
    })),
    deleted: board.deleted?.filter((item) => !namedCards(item.on).some(({ id }) => hidden.has(id))),
  };
}

// Only leave eyes on comments that reached the agent. With no events, this
// keeps get_board's usual behavior: just the requests its digest quotes. A comment on a
// decision or a task reaches it only where a group offers cards (`told`): a server with
// none tells it nothing, so it leaves no 👀 on one.
export function seeBoardComments(store: Store, board: Board, actor: Actor, events?: BoardEvent[], told?: Told): void {
  const view = agentBoard(board, actor.name);
  const cards = told?.offers('cards') ?? false;
  const comments = new Set([
    ...(cards ? cardsOf(view).flatMap((card) => card.comments.map((comment) => comment.id)) : []),
    ...(view.threads ?? []).flatMap((thread) => thread.messages.map((message) => message.id)),
    ...canvasesOf(view).flatMap(({ canvas }) => canvas.pins.flatMap((pin) => (pin.discussion?.thread ?? []).map((comment) => comment.id))),
  ]);
  store.seeComments(board.id, actor, events, (item) => comments.has(item.id));
}

// Check all explicit card/canvas targets before a handler reads or changes
// them, and before presence marks the agent as looking at the card.
export function hiddenBacklogTarget(store: Store, args: Record<string, unknown>, agent: string): boolean {
  const cardKeys = boardCardKinds().filter((kind) => kind.backlog).map((kind) => ({ key: `${kind.kind}_id`, kind: kind.kind }));
  const ids = [...cardKeys.map(({ key }) => key), 'block_id', 'from_block_id', 'to_block_id', 'pin_id', 'group_id', 'id'];
  for (const key of ids) {
    const id = args[key];
    if (typeof id !== 'string') continue;
    try {
      const named = cardKeys.find((card) => card.key === key);
      if (named) {
        const found = store.findCard(named.kind, id);
        const card = found && cardOf(found.board, named.kind, id);
        if (found && card && !cardVisible(found.board, card, agent)) return true;
      } else {
        const located = store.canvasOf(id);
        const owner = cardOwning(located);
        if (owner && !cardVisible(located.board, owner, agent)) return true;
        const pin = located.canvas.pins.find((item) => item.id === id);
        if (pin && linksHidden(located.board, pin, agent)) return true;
      }
    } catch {
      // Removed canvas items are no longer indexed, but restoring one must
      // respect its card's visibility too.
      if (key === 'id') {
        for (const summary of store.listBoards()) {
          const board = store.getBoard(summary.id);
          const removed = board.deleted?.find((item) => item.id === id);
          if (!removed) continue;
          if ([removed.on, ...(removed.kept?.pins ?? [])].some((link) => linksHidden(board, link, agent))) return true;
        }
      }
      // The handler reports other missing or invalid ids in its usual way.
    }
  }
  return false;
}
