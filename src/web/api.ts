import type {
  Block,
  BlockVersion,
  Board,
  BoardEvent,
  BoardSummary,
  Comment,
  Decision,
  Group,
  Link,
  MarkValue,
  Pin,
  SceneView,
  Task,
  TaskStatus,
  Thread,
  ThreadDoor,
  ThreadLens,
  ThreadMessage,
  VersionSummary,
} from '../core/types';
import type { Emoji } from '../core/reactions';
import type { ReactionPlace } from '../core/store/reactions';
import type { LiveState } from '../core/changes';
import type { BlockContent as StoreBlockContent, BlockPatch as StoreBlockPatch } from '../core/store/inputs';
import type { ConnectorStatus } from '../core/connectors';
import type { DeletionSummary } from '../core/deletions';
import type { StartFolder } from '../core/firstRun';
import type { UpdateState } from '../core/update';
import type { Dismissed, NeedsReport } from '../core/needs';
import type { AgentSkills, AgentTask, TricotSkill } from '../core/skills';
import type { SearchKind, SearchResponse } from '../core/search';
import type { LiveStepsAction, LiveStepsPreview, LiveStepsReport, LiveStepsResult, LiveStepsScope } from '../core/liveSteps';

// Turning one agent's live steps on or off: which way, the name it sends
// steps as, and the scope (every project, or tidying up a project's own hook).
export type LiveStepsChange = { action: LiveStepsAction; name?: string; scope?: LiveStepsScope };

export type CanvasRef = { boardId?: string; decisionId?: string; taskId?: string };

// A canvas item removed or restored: note "Where things stand", or v7 of it.
export type DeletedItem = Pick<DeletionSummary, 'id' | 'kind' | 'label'>;

// Agents seen on a board recently; sent with the board, never saved with it.
export interface AgentPresence {
  name: string;
  lastSeen: string;
  state: 'listening' | 'working' | 'away';
  focus?: { kind: 'task' | 'decision'; id: string }; // the card it is taking a look at, for a minute after its last call about it
}

// What an agent is doing now, from a hook in its harness (server/steps.ts): its
// latest step per session, on the stream only, never saved.
export interface AgentStep {
  agent: string;
  text: string; // "Running npm test"
  at: string;
  card?: { kind: 'task' | 'decision'; id: string };
  thread?: string; // the thread it is answering
  role?: string; // a subagent's type
  done?: boolean; // its turn ended
  running?: boolean; // it lasts until a step ending it comes (a test run)
  ended?: boolean; // the end of one that lasted, `ms` long when known: "Ran npm test"
  ms?: number;
  narration?: boolean; // a line of what the agent said
}

// `ver` is the number of the board's latest change when it was fetched: the
// stream goes on from there (core/changes.ts).
export type LiveBoard = Board & { presence?: AgentPresence[]; ver?: number };

// A page of a board's events (server: GET /api/boards/:id/events). With `since`
// they are oldest first, after that cursor; otherwise newest first, and `before`
// pages back. `more`: another page follows; `total`: how many match, whatever
// the page.
export interface EventsPage {
  events: BoardEvent[];
  more: boolean;
  total: number;
  seq: number;
}

export interface EventsQuery {
  since?: number;
  before?: number;
  limit?: number;
  decision?: string;
  task?: string;
  unseenBy?: string; // what others changed that this person hasn't seen
  actor?: string; // only what this agent did
}

// What a person's browser sends to make or change a block: what the board's
// kinds take (core/blocks/), so a kind's own fields are written once.
export type BlockContent = StoreBlockContent;

export type BlockPatch = StoreBlockPatch & {
  rev?: number; // the rev being edited; the server refuses the write if it has moved on
};

// The part of a block a person pins: words they selected (with the text
// around them), table cells, a box drawn on an image (as
// fractions of it), a diagram's node or arrow, or the whole block.
export type PinPart =
  | { kind: 'text'; quote: string; prefix: string; suffix: string }
  | { kind: 'cells'; rows?: [number, number]; columns?: [number, number] }
  | { kind: 'box'; x: number; y: number; w: number; h: number }
  | { kind: 'node'; nodeId: string }
  | { kind: 'arrow'; from: string; to: string; n: number }
  | { kind: 'block' }
  | { kind: 'line'; file: string; line: number; side: 'new' | 'old' } // a line of a diff or a code block
  | { kind: 'point'; category: string; series?: string } // a chart's bar, point or slice
  | { kind: 'spot'; object?: string; x: number; y: number; z: number; view?: SceneView }; // a point on a 3D scene (on a named object, in its coordinates), and the view it was seen from

export interface Move {
  id: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  groupId?: string | null;
}

// A refused request: the server's message, and its code when it gives one
// (a connector's, such as no_docs_permission).
export type RequestError = Error & { status?: number; code?: string };

export async function request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error: RequestError = new Error(data.error ?? `Request failed (${response.status})`);
    error.status = response.status;
    if (typeof data.code === 'string') error.code = data.code;
    throw error;
  }
  return data as T;
}

const decisionRoute = (id: string, action: string) => `/api/decisions/${encodeURIComponent(id)}/${action}`;

// Where a comment's reactions go: its card's, thread's or pin's comments.
function reactionRoute(place: ReactionPlace): string {
  if ('taskId' in place) return `/api/tasks/${encodeURIComponent(place.taskId)}/comments`;
  if ('decisionId' in place) return decisionRoute(place.decisionId, 'comments');
  if ('threadId' in place) return `/api/threads/${encodeURIComponent(place.threadId)}/messages`;
  return `/api/canvas/pins/${encodeURIComponent(place.pinId)}/comments`;
}

export const api = {
  // `folder`: where Tricot was started, from ~ (Home's first run). `version`
  // and `source`, the repository's page: the foot of Home.
  info: () => request<{ mcpUrl: string; version?: string; source?: string; folder?: StartFolder }>('GET', '/api/info'),
  // A newer Tricot, and how this one updates (server/updateRoutes.ts).
  update: () => request<UpdateState>('GET', '/api/update'),
  // Update to the version the person was shown: 202 and the handover begins.
  startUpdate: (version: string) => request<UpdateState>('POST', '/api/update', { version }),
  boards: () => request<BoardSummary[]>('GET', '/api/boards'),
  // What needs this person across boards; `seen` is the last event they saw on each (away.ts).
  needs: (name: string, seen: Record<string, number>) =>
    request<NeedsReport>('GET', `/api/needs?${new URLSearchParams({ name, seen: JSON.stringify(seen) })}`),
  // What this person dismissed from their Needs you, by board key; dismissing needs on a board, by key and time.
  dismissedNeeds: (name: string) => request<Record<string, Dismissed>>('GET', `/api/needs/dismissed?${new URLSearchParams({ name })}`),
  dismissNeeds: (name: string, board: string, items: { key: string; at: string }[]) =>
    request<Record<string, Dismissed>>('POST', '/api/needs/dismiss', { name, board, items }),
  // The agents and the skills each reported; with a board, where each is on that board.
  agents: (boardId?: string) => request<AgentSkills[]>('GET', `/api/agents${boardId ? `?${new URLSearchParams({ board: boardId })}` : ''}`),
  // What an agent has claimed and not finished, on every board in use.
  agentWork: (name: string) => request<AgentTask[]>('GET', `/api/agents/${encodeURIComponent(name)}/work`),
  // The skills people add in Tricot, for one agent or (no agent) every agent.
  addSkill: (actor: string, skill: { name: string; description: string; instructions: string; agent?: string }) =>
    request<TricotSkill>('POST', '/api/skills', { actor, ...skill }),
  editSkill: (id: string, actor: string, patch: { name?: string; description?: string; instructions?: string; agent?: string }) =>
    request<TricotSkill>('POST', `/api/skills/${encodeURIComponent(id)}`, { actor, ...patch }),
  deleteSkill: (id: string, actor: string) => request<TricotSkill>('POST', `/api/skills/${encodeURIComponent(id)}/delete`, { actor }),
  // Each agent's live steps on this machine; what turning one on or off would
  // write; and doing it, with the fingerprint of the preview the person saw.
  liveSteps: () => request<LiveStepsReport>('GET', '/api/live-steps'),
  previewLiveSteps: (agent: string, actor: string, change: LiveStepsChange) =>
    request<LiveStepsPreview>('POST', `/api/live-steps/${encodeURIComponent(agent)}/preview`, { actor, ...change }),
  applyLiveSteps: (agent: string, actor: string, change: LiveStepsChange & { fingerprint: string }) =>
    request<LiveStepsResult>('POST', `/api/live-steps/${encodeURIComponent(agent)}/apply`, { actor, ...change }),
  board: (id: string) => request<LiveBoard>('GET', `/api/boards/${encodeURIComponent(id)}`),
  // Where the board is on the server, to check a page against.
  live: (id: string) => request<LiveState>('GET', `/api/boards/${encodeURIComponent(id)}/live`),
  events: (id: string, { unseenBy, ...query }: EventsQuery) => {
    const params = new URLSearchParams(Object.entries({ ...query, unseen_by: unseenBy }).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])));
    return request<EventsPage>('GET', `/api/boards/${encodeURIComponent(id)}/events?${params}`);
  },
  createBoard: (actor: string, title: string, goal: string) =>
    request<Board>('POST', '/api/boards', { actor, title, goal }),
  updateBoard: (id: string, actor: string, patch: { title?: string; goal?: string }) =>
    request<Board>('POST', `/api/boards/${encodeURIComponent(id)}`, { actor, ...patch }),
  archiveBoard: (id: string, actor: string, archived: boolean) =>
    request<Board>('POST', `/api/boards/${encodeURIComponent(id)}/${archived ? 'archive' : 'unarchive'}`, { actor }),
  // For good, once the board's title is typed; only an archived board.
  deleteBoard: (id: string, actor: string, confirm: string) =>
    request<{ ok: true }>('POST', `/api/boards/${encodeURIComponent(id)}/delete`, { actor, confirm }),
  // No block ids: sync all.
  requestSync: (id: string, actor: string, blockIds?: string[]) =>
    request<Board>('POST', `/api/boards/${encodeURIComponent(id)}/sync`, { actor, blockIds }),
  cancelSync: (id: string, actor: string) => request<Board>('POST', `/api/boards/${encodeURIComponent(id)}/sync/cancel`, { actor }),
  // Asks agents for something on the board context, e.g. an architecture view; or cancels that.
  askAgents: (id: string, actor: string, text: string) =>
    request<Board>('POST', `/api/boards/${encodeURIComponent(id)}/requests`, { actor, text }),
  cancelRequest: (id: string, requestId: string, actor: string) =>
    request<Board>('POST', `/api/boards/${encodeURIComponent(id)}/requests/${encodeURIComponent(requestId)}/cancel`, { actor }),
  // Threads: conversations with agents. Starting one is its first message.
  threads: (boardId: string) => request<Thread[]>('GET', `/api/boards/${encodeURIComponent(boardId)}/threads`),
  thread: (id: string) => request<Thread>('GET', `/api/threads/${encodeURIComponent(id)}`),
  // `door`: the tab whose chat bar started it, or the threads list (core/doors.ts).
  startThread: (boardId: string, actor: string, body: string, lens?: ThreadLens, door?: ThreadDoor) =>
    request<Thread>('POST', `/api/boards/${encodeURIComponent(boardId)}/threads`, { actor, body, lens, door }),
  postToThread: (id: string, actor: string, body: string) =>
    request<Thread>('POST', `/api/threads/${encodeURIComponent(id)}/messages`, { actor, body }),
  // A preset's name, or one's own with a brief; null for General.
  setThreadLens: (id: string, actor: string, lens: ThreadLens | null) =>
    request<Thread>('POST', `/api/threads/${encodeURIComponent(id)}/lens`, { actor, lens }),
  // A board's decisions, tasks, comments, findings and canvas blocks; no board, or all, searches every board.
  search: (boardId: string | undefined, q: string, options: { kinds?: SearchKind[]; all?: boolean; open?: boolean }) => {
    const params = new URLSearchParams({ q });
    if (options.kinds?.length) params.set('kinds', options.kinds.join(','));
    if (options.all || !boardId) params.set('all', '1');
    if (options.open) params.set('open', '1');
    return request<SearchResponse>('GET', `/api${boardId ? `/boards/${encodeURIComponent(boardId)}` : ''}/search?${params}`);
  },
  postDecision: (boardId: string, actor: string, input: { question: string; context?: string; options?: string[]; area?: string }) =>
    request<Decision>('POST', `/api/boards/${encodeURIComponent(boardId)}/decisions`, { actor, ...input }),
  addOption: (id: string, actor: string, label: string) =>
    request<Decision>('POST', decisionRoute(id, 'options'), { actor, label }),
  revise: (
    id: string,
    actor: string,
    patch: {
      question?: string;
      context?: string;
      options?: { id: string; label?: string; description?: string; outdated?: boolean; reason?: string }[];
    },
  ) => request<Decision>('POST', decisionRoute(id, 'revise'), { actor, ...patch }),
  // Files a card under an area (theme); '' clears it.
  setArea: (id: string, actor: string, area: string) => request<Decision>('POST', decisionRoute(id, 'area'), { actor, area }),
  requestRefresh: (id: string, actor: string, note?: string) =>
    request<Decision>('POST', decisionRoute(id, 'refresh'), { actor, note }),
  cancelRefresh: (id: string, actor: string) => request<Decision>('POST', decisionRoute(id, 'refresh/cancel'), { actor }),
  retire: (id: string, actor: string, note: string) => request<Decision>('POST', decisionRoute(id, 'retire'), { actor, note }),
  resolve: (
    id: string,
    actor: string,
    input: { optionId?: string; answer?: string; rationale?: string; provisional?: boolean },
  ) => request<Decision>('POST', decisionRoute(id, 'resolve'), { actor, ...input }),
  explore: (id: string, actor: string, note?: string) =>
    request<Decision>('POST', decisionRoute(id, 'explore'), { actor, note }),
  defer: (id: string, actor: string, note?: string) =>
    request<Decision>('POST', decisionRoute(id, 'defer'), { actor, note }),
  reopen: (id: string, actor: string) => request<Decision>('POST', decisionRoute(id, 'reopen'), { actor }),
  comment: (id: string, actor: string, body: string) =>
    request<Decision>('POST', decisionRoute(id, 'comments'), { actor, body }),
  requestPlan: (id: string, actor: string, note?: string) =>
    request<Decision>('POST', decisionRoute(id, 'plan'), { actor, note }),
  commentTask: (id: string, actor: string, body: string) =>
    request<Task>('POST', `/api/tasks/${encodeURIComponent(id)}/comments`, { actor, body }),
  // A 👍, 👎 or 👀 on a comment or thread message, or taking one's own back.
  react: (place: ReactionPlace, commentId: string, actor: string, emoji: Emoji, remove: boolean) =>
    request<Comment | ThreadMessage>('POST', `${reactionRoute(place)}/${encodeURIComponent(commentId)}/reactions`, { actor, emoji, ...(remove ? { remove } : {}) }),
  addTask: (boardId: string, actor: string, input: { title: string; decisionIds?: string[] }) =>
    request<Task>('POST', `/api/boards/${encodeURIComponent(boardId)}/tasks`, { actor, ...input }),
  updateTask: (
    id: string,
    actor: string,
    patch: {
      status?: TaskStatus;
      note?: string;
      link?: string;
      stillValid?: boolean;
      decisionIds?: string[];
      approveCommit?: boolean;
      after?: string | null;
      assignee?: string | null; // the agent it's for; null for any agent
    },
  ) => request<Task>('POST', `/api/tasks/${encodeURIComponent(id)}`, { actor, ...patch }),
  // Dropping a task as work that won't be done, and bringing it back to the backlog or to do.
  dropTask: (id: string, actor: string, note?: string) =>
    request<Task>('POST', `/api/tasks/${encodeURIComponent(id)}/drop`, { actor, ...(note ? { note } : {}) }),
  bringBackTask: (id: string, actor: string, to: 'backlog' | 'todo') =>
    request<Task>('POST', `/api/tasks/${encodeURIComponent(id)}/bring-back`, { actor, to }),
  // What links to a card, in sentences, and deleting one made by mistake, for good.
  cardLinks: (card: { taskId: string } | { decisionId: string }) =>
    request<{ lines: string[] }>(
      'GET',
      'taskId' in card ? `/api/tasks/${encodeURIComponent(card.taskId)}/links` : decisionRoute(card.decisionId, 'links'),
    ),
  deleteTask: (id: string, actor: string) => request<{ ok: true }>('POST', `/api/tasks/${encodeURIComponent(id)}/delete`, { actor }),
  deleteDecision: (id: string, actor: string) => request<{ ok: true }>('POST', decisionRoute(id, 'delete'), { actor }),
  askPeople: (id: string, actor: string, names: string[], note?: string) =>
    request<Decision>('POST', decisionRoute(id, 'ask'), { actor, names, note }),
  unask: (id: string, actor: string, name: string) => request<Decision>('POST', decisionRoute(id, 'unask'), { actor, name }),
  addCriterion: (id: string, actor: string, label: string) =>
    request<Decision>('POST', decisionRoute(id, 'criteria'), { actor, label }),
  removeCriterion: (id: string, criterionId: string, actor: string) =>
    request<Decision>('POST', decisionRoute(id, `criteria/${encodeURIComponent(criterionId)}/delete`), { actor }),
  mark: (id: string, actor: string, criterionId: string, optionId: string, value: MarkValue | null) =>
    request<Decision>('POST', decisionRoute(id, 'marks'), { actor, criterionId, optionId, value }),

  addBlock: (
    ref: CanvasRef,
    actor: string,
    input: { content: BlockContent; title?: string; x?: number; y?: number; w?: number; h?: number },
  ) => request<Block>('POST', '/api/canvas/blocks', { actor, ...ref, ...input }),
  updateBlock: (id: string, actor: string, patch: BlockPatch) =>
    request<Block>('POST', `/api/canvas/blocks/${encodeURIComponent(id)}`, { actor, ...patch }),
  // What a block's kind makes of it (a table's Make a chart: a bar chart of its numbers, beside it); `left` names the columns of words it left out.
  deriveBlock: (blockId: string, actor: string) =>
    request<{ block: Block; left: string[] }>('POST', `/api/canvas/blocks/${encodeURIComponent(blockId)}/chart`, { actor }),
  // A block's versions, newest (the current one) first; an earlier one in full;
  // and bringing one back, refused if the block moved on from blockRev.
  blockVersions: (id: string) =>
    request<{ rev: number; versions: VersionSummary[] }>('GET', `/api/canvas/blocks/${encodeURIComponent(id)}/versions`),
  blockVersion: (id: string, rev: number) =>
    request<BlockVersion>('GET', `/api/canvas/blocks/${encodeURIComponent(id)}/versions/${rev}`),
  restoreBlock: (id: string, actor: string, rev: number, blockRev: number) =>
    request<Block>('POST', `/api/canvas/blocks/${encodeURIComponent(id)}/restore`, { actor, rev, blockRev }),
  // Deleting an earlier version, or all of them, which restoreItem undoes.
  deleteVersion: (id: string, actor: string, rev: number) =>
    request<{ ok: true; deleted: DeletedItem }>('POST', `/api/canvas/blocks/${encodeURIComponent(id)}/versions/${rev}/delete`, { actor }),
  deleteEarlierVersions: (id: string, actor: string) =>
    request<{ ok: true; deleted: DeletedItem }>('POST', `/api/canvas/blocks/${encodeURIComponent(id)}/versions/delete`, { actor }),
  moveItems: (ref: CanvasRef, actor: string, moves: Move[]) =>
    request<{ ok: true }>('POST', '/api/canvas/move', { actor, ...ref, moves }),
  addGroup: (ref: CanvasRef, actor: string, input: { title: string; x: number; y: number; w: number; h: number }) =>
    request<Group>('POST', '/api/canvas/groups', { actor, ...ref, ...input }),
  renameGroup: (id: string, actor: string, title: string) =>
    request<Group>('POST', `/api/canvas/groups/${encodeURIComponent(id)}`, { actor, title }),
  addLink: (actor: string, from: string, to: string) => request<Link>('POST', '/api/canvas/links', { actor, from, to }),
  relabelLink: (id: string, actor: string, label: string) =>
    request<Link>('POST', `/api/canvas/links/${encodeURIComponent(id)}`, { actor, label }),
  pinTask: (blockId: string, actor: string, input: { part: PinPart; text: string; ready: boolean }) =>
    request<{ pin: Pin; task: Task }>('POST', `/api/canvas/blocks/${encodeURIComponent(blockId)}/pins/task`, { actor, ...input }),
  pinQuestion: (blockId: string, actor: string, input: { part: PinPart; text: string }) =>
    request<{ pin: Pin; decision: Decision }>('POST', `/api/canvas/blocks/${encodeURIComponent(blockId)}/pins/question`, {
      actor,
      ...input,
    }),
  pinComment: (blockId: string, actor: string, input: { part: PinPart; body: string }) =>
    request<{ pin: Pin; comment: Comment }>('POST', `/api/canvas/blocks/${encodeURIComponent(blockId)}/pins/comment`, {
      actor,
      ...input,
    }),
  commentOnPin: (pinId: string, actor: string, body: string) =>
    request<{ pin: Pin; comment: Comment }>('POST', `/api/canvas/pins/${encodeURIComponent(pinId)}/comments`, { actor, body }),
  resolvePin: (pinId: string, actor: string, resolved: boolean) =>
    request<Pin>('POST', `/api/canvas/pins/${encodeURIComponent(pinId)}/resolve`, { actor, resolved }),
  // Removing an item keeps it aside for 30 days; restoring puts it back with
  // the same id, with notes on anything that couldn't come back.
  removeItem: (id: string, actor: string) =>
    request<{ ok: true; deleted: DeletedItem }>('POST', `/api/canvas/items/${encodeURIComponent(id)}/delete`, { actor }),
  restoreItem: (id: string, actor: string) =>
    request<{ restored: DeletedItem; notes: string[] }>('POST', `/api/canvas/items/${encodeURIComponent(id)}/restore`, { actor }),
  // The new asset's id, and its picture's size when the server could read it.
  uploadImage: async (file: Blob): Promise<{ assetId: string; size: { width: number; height: number } | null }> => {
    const response = await fetch('/api/assets', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? `Upload failed (${response.status})`);
    const size = typeof data.width === 'number' && typeof data.height === 'number' ? { width: data.width, height: data.height } : null;
    return { assetId: data.assetId as string, size };
  },

  // App-wide connectors: their status, a sign-in (the service's page, opened
  // in a new tab) and signing out. A connector's own calls are in its web folder.
  connectors: () => request<ConnectorStatus[]>('GET', '/api/connectors'),
  // permissions: more to allow than the connector has, e.g. ['docs'] for Google Docs.
  startConnector: (id: string, permissions?: string[]) =>
    request<{ url: string }>('POST', `/api/connectors/${encodeURIComponent(id)}/start`, permissions ? { permissions } : {}),
  disconnectConnector: (id: string) =>
    request<{ connector: ConnectorStatus; revoked: boolean }>('POST', `/api/connectors/${encodeURIComponent(id)}/disconnect`, {}),
};
