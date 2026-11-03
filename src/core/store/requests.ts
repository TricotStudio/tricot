import type { Canvases } from './canvases';
import { BoardError } from './errors';
import type { Located } from './inputs';
import type { People } from './people';
import { type BoardRepository, refOf } from './repository';
import { LIMITS, guardArchived, limited, optional, required } from './validate';
import { clip, listNames, samePerson } from '../format';
import { agentsIn } from '../mentions';
import { REQUEST_TEXT_LIMIT, cancelRefusal, finishRefusal, isActive, keptRequests, requestTitle, takeRefusal } from '../requests';
import type { Actor, Board, ContextRequest, Group } from '../types';

// Requests on the board context. A person asks agents for something about the project, e.g. "Get me an
// architecture view of the project"; an agent takes it, answers in a group made for it, and finishes it
// with a note. See core/requests.
export class Requests {
  constructor(
    private readonly repo: BoardRepository,
    private readonly people: People,
    private readonly canvases: Canvases,
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
    board.requests = keptRequests([...(board.requests ?? []), request]);
    const whom = mentions.length ? listNames(mentions) : 'agents';
    this.repo.record(board, actor, 'request_asked', `asked ${whom}: "${clip(asked, 160)}"`, undefined, request.id, undefined, undefined, mentions);
    return request;
  }

  // The agent taking a request answers it in a new group on the board context,
  // titled from the request unless it names a better title. Taking one again
  // gives back the same group.
  takeRequest(requestId: string, actor: Actor, title?: string): { request: ContextRequest; group: Group | undefined } {
    const { board, request } = this.getRequest(requestId);
    guardArchived(board);
    const refused = takeRefusal(board, request, actor);
    if (refused) throw new BoardError(refused);
    if (request.status === 'working') return { request, group: board.canvas.groups.find((g) => g.id === request.groupId) };
    const located: Located = { board, canvas: board.canvas };
    const group = this.canvases.newGroup(located, { title: optional(title) ?? requestTitle(request.text, request.mentions) }, actor);
    board.canvas.groups.push(group);
    this.repo.indexItem(group.id, refOf(located));
    Object.assign(request, { status: 'working', takenBy: actor, groupId: group.id });
    const asker = `${request.by.name}'s request "${clip(request.text, 120)}"`;
    this.repo.record(board, actor, 'request_taken', `took ${asker}, answering in group "${clip(group.title, 40)}"`, undefined, request.id);
    return { request, group };
  }

  // Only the agent who took a request finishes it, once its answer is in the
  // group, with a one-line note on it.
  finishRequest(requestId: string, note: string, actor: Actor): ContextRequest {
    const { board, request } = this.getRequest(requestId);
    guardArchived(board);
    const refused = finishRefusal(board, request, actor);
    if (refused) throw new BoardError(refused);
    const text = limited(required(note, 'A note'), LIMITS.note, 'A note');
    const group = board.canvas.groups.find((g) => g.id === request.groupId);
    if (group && !board.canvas.blocks.some((b) => b.groupId === group.id)) {
      throw new BoardError(
        `Group "${clip(group.title, 60)}" is empty: add your answer there first (add_block with board_id: ${board.id} and group_id: ${group.id}), then finish_request.`,
      );
    }
    Object.assign(request, { status: 'done', note: text, doneAt: new Date().toISOString() });
    const asker = `${request.by.name}'s request "${clip(request.text, 120)}"`;
    this.repo.record(board, actor, 'request_finished', `finished ${asker}: "${clip(text, 160)}"`, undefined, request.id);
    return request;
  }

  // A person cancels an open request, or one an agent is working on; what the
  // agent added stays in its group. Cancelling one that's over changes nothing.
  cancelRequest(requestId: string, actor: Actor, boardId?: string): ContextRequest {
    const refused = cancelRefusal(actor);
    if (refused) throw new BoardError(refused);
    const { board, request } = this.getRequest(requestId, boardId);
    guardArchived(board);
    if (!isActive(request)) return request;
    const working = request.status === 'working' ? `, which ${request.takenBy!.name} was answering` : '';
    Object.assign(request, { status: 'cancelled', doneAt: new Date().toISOString() });
    const what = samePerson(request.by.name, actor.name) ? 'asking agents' : `${request.by.name}'s request`;
    this.repo.record(board, actor, 'request_cancelled', `cancelled ${what}: "${clip(request.text, 160)}"${working}`, undefined, request.id);
    return request;
  }
}
