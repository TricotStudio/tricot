import type { Canvases } from './canvases';
import { BoardError } from './errors';
import type { Located } from './inputs';
import type { People } from './people';
import type { Pins } from './pins';
import { BLOCKS_GROUP, CARDS_GROUP, groupBeside } from './groupBeside';
import type { BoardRepository } from './repository';
import { LIMITS, guardArchived, limited, optional, required } from './validate';
import { addRequestCards, askedKind, requestCardCount, requestCardIds } from '../askedCards';
import { boardCardKinds } from '../cards';
import { clip, listNames, samePerson } from '../format';
import { agentsIn } from '../mentions';
import {
  REQUEST_TEXT_LIMIT,
  askedAbout,
  cancelRefusal,
  finishRefusal,
  isActive,
  keptRequests,
  requestBlocks,
  requestCanvas,
  requestCards,
  requestCardsHeight,
  requestGroup,
  requestTitle,
  takeRefusal,
} from '../requests';
import { pageAsks, pageName } from '../scratchPad';
import type { Actor, Board, ContextRequest, Group, RequestKind } from '../types';
import type { EventAbout } from './eventTables';

// What a person asks about blocks they selected on a Sketchbook page: their
// words (none for a decision or tasks, left to agents), the blocks, and what
// they want back.
export interface PageAsk {
  text?: string;
  blockIds: string[];
  kind?: string; // one of the registered kinds of card a page can ask for: checked in askOnPage
}

// The cards an agent made answering a request, by the kind of each: `<kind>Id` for one (`decisionId`), `<kind>Ids` for
// several (`taskIds`).
export type RequestAnswer = Record<string, string | string[] | undefined>;

// The ids of the cards of one kind an answer names, whether it says one or several.
function answered(answer: RequestAnswer, kind: string): string[] {
  const one = answer[`${kind}Id`];
  const several = answer[`${kind}Ids`];
  return [...(typeof one === 'string' && one ? [one] : []), ...(Array.isArray(several) ? several : [])];
}

// Requests on the board context. A person asks agents for something about the project, e.g. "Get me an
// architecture view of the project"; an agent takes it, answers in a group made for it, and finishes it
// with a note. On a Sketchbook page a person asks about the blocks they selected, and the group is made
// beside them as they ask. See core/requests.
export class Requests {
  constructor(
    private readonly repo: BoardRepository,
    private readonly people: People,
    private readonly canvases: Canvases,
    private readonly pins: Pins,
  ) {}

  getRequest(requestId: string, boardId?: string): { board: Board; request: ContextRequest } {
    const boards = boardId ? [this.repo.getBoard(boardId)] : this.repo.allBoards();
    for (const board of boards) {
      const request = board.requests?.find((r) => r.id === requestId);
      if (request) return { board, request };
    }
    throw new BoardError(`No request "${requestId}"${boardId ? ` on board "${boardId}"` : ''}.`, 'not_found');
  }

  askAgents(boardId: string, text: string, actor: Actor): ContextRequest {
    if (actor.kind !== 'human') {
      throw new BoardError('Only people ask agents on the board context; add what you have with add_block instead.');
    }
    const board = this.repo.getBoard(boardId);
    guardArchived(board);
    const asked = limited(required(text, 'A request').replace(/\s+/g, ' '), REQUEST_TEXT_LIMIT, 'A request');
    const id = this.repo.newRequestId();
    // Mentioning agents makes it theirs alone to take.
    const mentions = agentsIn(board, this.people.mentionsIn(board, asked, actor));
    const request: ContextRequest = {
      id,
      text: asked,
      by: actor,
      at: new Date().toISOString(),
      status: 'open',
      ...(mentions.length ? { mentions } : {}),
    };
    board.requests = this.kept(board, request);
    const whom = mentions.length ? listNames(mentions) : 'agents';
    this.repo.record(board, actor, 'request_asked', `asked ${whom}: "${clip(asked, 160)}"`, { item: request.id }, { mentions });
    return request;
  }

  // A person asks agents about blocks they selected on a Sketchbook page: for
  // a decision about them, tasks planned from them, or anything, in their
  // words. Its group is made beside the blocks there and then, so the answer
  // lands by what it is about and the person sees where.
  askOnPage(pageId: string, input: PageAsk, actor: Actor): ContextRequest {
    if (actor.kind !== 'human') {
      throw new BoardError('Only people ask agents about blocks on a Sketchbook page; add what you have with add_block instead.');
    }
    const { board, page } = this.repo.getPage(pageId);
    guardArchived(board);
    const wanted = new Set(input.blockIds);
    if (wanted.size === 0) throw new BoardError('Select the blocks to ask about.');
    const blocks = page.canvas.blocks.filter((b) => wanted.has(b.id));
    const stray = [...wanted].filter((id) => !blocks.some((b) => b.id === id));
    if (stray.length) {
      throw new BoardError(`${stray.length === 1 ? `"${stray[0]}" is` : `${stray.length} of them are`} not a block on ${pageName(page)}. Select blocks there.`);
    }
    const typed = optional(input.text)?.replace(/\s+/g, ' ');
    // Only naming who it's for ("@Claude") leaves the rest to agents too.
    const named = typed ? this.people.mentionsIn(board, typed, actor) : [];
    const onlyNames = Boolean(typed && named.length && !typed.replace(/@[^\s,;]+[\s,;]*/g, '').trim());
    const wants = input.kind ? askedKind(input.kind)?.asked : undefined;
    if (input.kind && !wants) throw new BoardError(`Agents here cannot be asked for "${input.kind}".`);
    if ((!typed || onlyNames) && !wants) throw new BoardError('Say what you want from agents about these blocks.');
    const said = !typed ? wants!.asked : onlyNames ? `${typed} ${wants!.asked}` : typed;
    const text = limited(said, REQUEST_TEXT_LIMIT, 'A request');
    // Mentioning nobody, it is for the agent that made the page, if one did.
    const mentions = pageAsks(page, agentsIn(board, this.people.mentionsIn(board, text, actor)));
    const located: Located = { board, page, canvas: page.canvas };
    const request: ContextRequest = {
      id: this.repo.newRequestId(),
      text,
      by: actor,
      at: new Date().toISOString(),
      status: 'open',
      ...(mentions.length ? { mentions } : {}),
      pageId: page.id,
      blockIds: blocks.map((b) => b.id),
      ...(input.kind ? { kind: input.kind as RequestKind } : {}),
    };
    request.groupId = this.newGroupFor(located, request, requestTitle(text, mentions), actor).id;
    board.requests = this.kept(board, request);
    page.updatedAt = request.at;
    this.repo.alsoSave(board, { pageIds: [page.id] });
    const whom = mentions.length ? listNames(mentions) : 'agents';
    this.repo.record(board, actor, 'request_asked', `asked ${whom}${askedAbout(board, request)}: "${clip(text, 160)}"`, { item: request.id }, { mentions });
    return request;
  }

  // The agent taking a request answers it in a group made for it: on the
  // board context, titled from the request unless it names a better title; on
  // a page, the one made beside its blocks as it was asked (made again there
  // if a person removed it), renamed if it names a title. Taking one again
  // gives back the same group.
  takeRequest(requestId: string, actor: Actor, title?: string): { request: ContextRequest; group: Group | undefined } {
    const { board, request } = this.getRequest(requestId);
    guardArchived(board);
    const refused = takeRefusal(board, request, actor);
    if (refused) throw new BoardError(refused);
    const place = requestCanvas(board, request);
    if (!place) throw new BoardError(`The Sketchbook page ${request.by.name} asked on has been deleted, so there is nowhere to answer it. Leave it.`);
    if (request.status === 'working') return { request, group: requestGroup(board, request) };
    const located: Located = { board, canvas: place.canvas, ...(place.page ? { page: place.page } : {}) };
    const named = optional(title);
    let group = requestGroup(board, request);
    if (group && named) group.title = limited(named, LIMITS.title, 'A group title');
    group ??= this.newGroupFor(located, request, named ?? requestTitle(request.text, request.mentions), actor);
    Object.assign(request, { status: 'working', takenBy: actor, groupId: group.id });
    if (place.page) this.repo.alsoSave(board, { pageIds: [place.page.id] });
    const asker = `${request.by.name}'s request "${clip(request.text, 120)}"`;
    this.repo.record(board, actor, 'request_taken', `took ${asker}, answering in group "${clip(group.title, 40)}"`, { item: request.id });
    return { request, group };
  }

  // Whether an agent can answer a request with a card it is about to make
  // (post_decision or plan_tasks with request_id), checked before the card is
  // made: one on this board, open or taken by it, whose page is still there.
  checkAnswer(requestId: string, boardId: string, actor: Actor): void {
    const { board, request } = this.getRequest(requestId);
    if (board !== this.repo.getBoard(boardId)) throw new BoardError(`Request "${requestId}" is on board "${board.id}", not "${boardId}".`);
    guardArchived(board);
    const refused = request.status === 'open' ? takeRefusal(board, request, actor) : finishRefusal(board, request, actor);
    if (refused) throw new BoardError(refused);
    if (!requestCanvas(board, request)) throw new BoardError(`The Sketchbook page ${request.by.name} asked on has been deleted, so there is nothing to answer.`);
  }

  // A decision or tasks an agent made answering a request (checkAnswer first):
  // it takes the request if it was open, pins each card to the blocks the
  // request is about, and shows the cards in its group, which grows to fit.
  // The card a request asks for (a decision, or tasks) is its answer, and
  // finishes it, logged on the decision so it reads there too.
  answerWith(requestId: string, answer: RequestAnswer, actor: Actor): ContextRequest {
    const { board, request } = this.getRequest(requestId);
    const refused = request.status === 'open' ? takeRefusal(board, request, actor) : finishRefusal(board, request, actor);
    if (refused) throw new BoardError(refused);
    if (request.status === 'open') this.takeRequest(requestId, actor);
    const blocks = requestBlocks(board, request).map((b) => b.id);
    const made = boardCardKinds().map(({ kind }) => ({ kind, ids: answered(answer, kind) }));
    if (blocks.length) {
      for (const { kind, ids } of made) for (const id of ids) this.pins.pinBlocks(blocks, { [`${kind}Id`]: id }, actor);
    }
    for (const { kind, ids } of made) addRequestCards(request, kind, ids);
    const group = requestGroup(board, request);
    const page = requestCanvas(board, request)?.page;
    if (group) group.h = Math.max(group.h, requestCardsHeight(board, request));
    if (page) this.repo.alsoSave(board, { pageIds: [page.id] });
    const asked = askedKind(request.kind);
    if (asked && answered(answer, asked.card).length) {
      const named = listNames(requestCards(board, Object.fromEntries(made.map(({ kind, ids }) => [`${kind}Ids`, ids]))));
      this.finish(board, request, `${asked.asked.made} ${named}`, actor, { [asked.card]: answer[`${asked.card}Id`] as string | undefined });
    }
    return request;
  }

  // Only the agent who took a request finishes it, once its answer is in the
  // group, with a one-line note on it. One asking for a decision or tasks is
  // finished by them (answerWith).
  finishRequest(requestId: string, note: string, actor: Actor): ContextRequest {
    const { board, request } = this.getRequest(requestId);
    guardArchived(board);
    const refused = finishRefusal(board, request, actor);
    if (refused) throw new BoardError(refused);
    const text = limited(required(note, 'A note'), LIMITS.note, 'A note');
    const asked = askedKind(request.kind);
    if (asked && !requestCardIds(request, asked.card).length) throw new BoardError(asked.asked.unmet(request.by.name, board.id, request.id));
    const place = requestCanvas(board, request);
    const group = requestGroup(board, request);
    if (group && !requestCardCount(request) && !place?.canvas.blocks.some((b) => b.groupId === group.id)) {
      const on = place?.page ? `page_id: ${place.page.id}` : `board_id: ${board.id}`;
      throw new BoardError(`Group "${clip(group.title, 60)}" is empty: add your answer there first (add_block with ${on} and group_id: ${group.id}), then finish_request.`);
    }
    this.finish(board, request, text, actor);
    return request;
  }

  // A person cancels an open request, or one an agent is working on; what the
  // agent added stays in its group. Cancelling one that's over changes nothing.
  // A request on a page whose group holds nothing yet takes the group away.
  cancelRequest(requestId: string, actor: Actor, boardId?: string): ContextRequest {
    const refused = cancelRefusal(actor);
    if (refused) throw new BoardError(refused);
    const { board, request } = this.getRequest(requestId, boardId);
    guardArchived(board);
    if (!isActive(request)) return request;
    const working = request.status === 'working' ? `, which ${request.takenBy!.name} was answering` : '';
    Object.assign(request, { status: 'cancelled', doneAt: new Date().toISOString() });
    const place = requestCanvas(board, request);
    const group = requestGroup(board, request);
    if (place?.page && group && !requestCardCount(request) && !place.canvas.blocks.some((b) => b.groupId === group.id)) {
      place.canvas.groups.splice(place.canvas.groups.indexOf(group), 1);
      this.repo.unindexItem(group.id);
      this.repo.alsoSave(board, { pageIds: [place.page.id] });
    }
    const what = samePerson(request.by.name, actor.name) ? 'asking agents' : `${request.by.name}'s request`;
    this.repo.record(board, actor, 'request_cancelled', `cancelled ${what}: "${clip(request.text, 160)}"${working}`, { item: request.id });
    return request;
  }

  private finish(board: Board, request: ContextRequest, note: string, actor: Actor, about: EventAbout = {}): void {
    Object.assign(request, { status: 'done', note, doneAt: new Date().toISOString() });
    const asker = `${request.by.name}'s request "${clip(request.text, 120)}"`;
    this.repo.record(board, actor, 'request_finished', `finished ${asker}: "${clip(note, 160)}"`, { ...about, item: request.id });
  }

  // A group for a request's answer: on a page, beside the blocks it is about;
  // on the board context, in the first free spot.
  private newGroupFor(located: Located, request: ContextRequest, title: string, actor: Actor): Group {
    return groupBeside(this.repo, this.canvases, located, requestBlocks(located.board, request), title, request.kind ? CARDS_GROUP : BLOCKS_GROUP, actor);
  }

  // The board's requests with a new one: the open and working ones, those
  // whose group on a page shows the cards they led to, and the latest others.
  private kept(board: Board, request: ContextRequest): ContextRequest[] {
    return keptRequests([...(board.requests ?? []), request], undefined, (r) => Boolean(r.pageId && requestCardCount(r) > 0 && requestGroup(board, r)));
  }
}
