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
} from '../../core/types';
import type { Emoji } from '../../core/reactions';
import type { ReactionPlace } from '../../core/store/reactions';
import type { LiveState } from '../../core/changes';
import type { BlockContent as StoreBlockContent, BlockPatch as StoreBlockPatch } from '../../core/store/inputs';
import type { ConnectorStatus } from '../../core/connectors';
import type { DeletionSummary } from '../../core/deletions';
import type { StartFolder } from '../../core/firstRun';
import type { CheckedState, UpdateState } from '../../core/update';
import type { Dismissed, NeedsReport } from '../../core/needs';
import type { AgentSkills, AgentTask, TricotSkill } from '../../core/skills';
import type { SearchKind, SearchResponse } from '../../core/search';
import type { LiveStepsAction, LiveStepsPreview, LiveStepsReport, LiveStepsResult, LiveStepsScope } from '../../core/liveSteps';
import type { AgentUsageReport } from '../../core/usage';
import type { PairingSession } from '../../core/pairing';
import type { ApprovalReply } from '../../core/approvals';
import { routes, routeUrl, type ParamNames, type PathParams, type Route, type UrlArgs } from '../../core/routes';
import { SEAT_GONE, SEAT_NEEDED, type AdmissionView, type SeatView } from '../../core/seats';
import { forgetSeat, letThisBrowserIn, signedHeaders } from './seat';

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
  | { kind: 'line'; file: string; line: number; side: 'new' | 'old'; last?: number } // a line of a diff or a code block; on a code block, lines `line` to `last`
  | { kind: 'point'; category?: string; series?: string } // a chart's bar, point or slice; a series alone, from its legend
  | { kind: 'spot'; object?: string; x: number; y: number; z: number; view?: SceneView } // a point on a 3D scene (on a named object, in its coordinates), and the view it was seen from
  | { kind: 'site'; page: string; selector: string; tag: string; text?: string; file?: string; line?: number }; // an element of a website's page

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

// What is consequential needs this browser to be one of the person's seats
// (seat.ts, T187): Tricot refuses it unsigned (seat_needed), and the request
// goes again signed, once this browser is let in, which it asks for then.
async function request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const text = body ? JSON.stringify(body) : undefined;
  const send = async (signed?: Record<string, string>) => {
    const response = await fetch(url, {
      method,
      headers: { ...(text && { 'Content-Type': 'application/json' }), ...signed },
      body: text,
    });
    return { response, data: await response.json().catch(() => ({})) };
  };
  let { response, data } = await send();
  for (let tries = 0; response.status === 403 && (data.code === SEAT_NEEDED || data.code === SEAT_GONE) && tries < 2; tries++) {
    if (data.code === SEAT_GONE) await forgetSeat();
    let signed = await signedHeaders(method, url, text ?? '');
    if (!signed && (await letThisBrowserIn())) signed = await signedHeaders(method, url, text ?? '');
    if (!signed) break;
    ({ response, data } = await send(signed));
  }
  if (!response.ok) {
    const error: RequestError = new Error(data.error ?? `Request failed (${response.status})`);
    error.status = response.status;
    if (typeof data.code === 'string') error.code = data.code;
    throw error;
  }
  return data as T;
}

// A call to a route of the table (core/routes.ts): `get(route)<Reply>(params, query)`
// and `post(route)<Reply>(body, params)`, the values its path takes put in, and
// encoded, by routeUrl. The route comes first so its path decides what is
// asked for; the reply's type is the caller's to say.
type Params<Path extends string> = [ParamNames<Path>] extends [never] ? [] : [params: PathParams<Path>];

export const get =
  <Path extends string>(route: Route<Path, 'GET'>) =>
  <T>(...args: UrlArgs<Path>) =>
    request<T>('GET', routeUrl(route, ...args));

export const post =
  <Path extends string>(route: Route<Path, 'POST'>) =>
  <T>(body: unknown, ...params: Params<Path>) =>
    request<T>('POST', routeUrl(route, ...(params as unknown as UrlArgs<Path>)), body);

export const api = {
  // `folder`: where Tricot was started, from ~ (Home's first run). `version`
  // and `source`, the repository's page: the foot of Home.
  info: () => get(routes.info)<{ mcpUrl: string; version?: string; source?: string; folder?: StartFolder }>(),
  // A newer Tricot, and how this one updates (server/updateRoutes.ts).
  update: () => get(routes.update)<UpdateState>(),
  // Update to the version the person was shown: 202 and the handover begins.
  startUpdate: (version: string) => post(routes.startUpdate)<UpdateState>({ version }),
  // Ask GitHub, then npm, now: the state, and what the check found.
  checkForUpdates: () => post(routes.checkForUpdates)<CheckedState>(undefined),
  boards: () => get(routes.boards)<BoardSummary[]>(),
  // What needs this person across boards; `seen` is the last event they saw on each (away.ts).
  needs: (name: string, seen: Record<string, number>) => get(routes.needs)<NeedsReport>(undefined, { name, seen: JSON.stringify(seen) }),
  // What this person dismissed from their Needs you, by board key; dismissing needs on a board, by key and time.
  dismissedNeeds: (name: string) => get(routes.dismissedNeeds)<Record<string, Dismissed>>(undefined, { name }),
  dismissNeeds: (name: string, board: string, items: { key: string; at: string }[]) =>
    post(routes.dismissNeeds)<Record<string, Dismissed>>({ name, board, items }),
  // The agents and the skills each reported; with a board, where each is on that board.
  agents: (boardId?: string) => get(routes.agents)<AgentSkills[]>(undefined, boardId ? { board: boardId } : undefined),
  // What an agent has claimed and not finished, on every board in use.
  agentWork: (name: string) => get(routes.agentWork)<AgentTask[]>({ name }),
  // An agent's plan usage, as its harness last said it, and with a board what
  // it did there since `day` and `week` (the person's today and week, ms).
  agentUsage: (name: string, query: { board?: string; day: number; week: number }) =>
    get(routes.agentUsage)<AgentUsageReport>({ name }, { ...(query.board && { board: query.board }), day: String(query.day), week: String(query.week) }),
  // The skills people add in Tricot, for one agent or (no agent) every agent.
  addSkill: (actor: string, skill: { name: string; description: string; instructions: string; agent?: string }) =>
    post(routes.addSkill)<TricotSkill>({ actor, ...skill }),
  editSkill: (id: string, actor: string, patch: { name?: string; description?: string; instructions?: string; agent?: string }) =>
    post(routes.editSkill)<TricotSkill>({ actor, ...patch }, { skillId: id }),
  deleteSkill: (id: string, actor: string) => post(routes.deleteSkill)<TricotSkill>({ actor }, { skillId: id }),
  // Each agent's live steps on this machine; what turning one on or off would
  // write; and doing it, with the fingerprint of the preview the person saw.
  liveSteps: () => get(routes.liveSteps)<LiveStepsReport>(),
  previewLiveSteps: (agent: string, actor: string, change: LiveStepsChange) =>
    post(routes.previewLiveSteps)<LiveStepsPreview>({ actor, ...change }, { agent }),
  applyLiveSteps: (agent: string, actor: string, change: LiveStepsChange & { fingerprint: string }) =>
    post(routes.applyLiveSteps)<LiveStepsResult>({ actor, ...change }, { agent }),
  // A person's answer to an agent waiting for their OK (server/approvalsRoutes.ts).
  answerApproval: (id: string, actor: string, reply: ApprovalReply) =>
    post(routes.answerApproval)<{ answered: true }>({ actor, ...reply }, { id }),
  // The browsers and terminals that act for the person (server/seatsRoutes.ts):
  // the list, removing one, and answering one that asks to be let in.
  seats: () => get(routes.seats)<SeatView[]>(),
  removeSeat: (id: string, actor: string) => post(routes.removeSeat)<SeatView[]>({ actor }, { id }),
  admissions: () => get(routes.admissions)<AdmissionView[]>(),
  answerAdmission: (id: string, actor: string, allow: boolean) => post(routes.answerAdmission)<unknown>({ actor, allow }, { id }),
  board: (id: string) => get(routes.board)<LiveBoard>({ boardId: id }),
  // Where the board is on the server, to check a page against.
  live: (id: string) => get(routes.boardLive)<LiveState>({ boardId: id }),
  events: (id: string, { unseenBy, ...query }: EventsQuery) => {
    const params = new URLSearchParams(Object.entries({ ...query, unseen_by: unseenBy }).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])));
    return get(routes.boardEvents)<EventsPage>({ boardId: id }, params);
  },
  createBoard: (actor: string, title: string, goal: string) => post(routes.createBoard)<Board>({ actor, title, goal }),
  updateBoard: (id: string, actor: string, patch: { title?: string; goal?: string }) =>
    post(routes.updateBoard)<Board>({ actor, ...patch }, { boardId: id }),
  archiveBoard: (id: string, actor: string, archived: boolean) =>
    post(archived ? routes.archiveBoard : routes.unarchiveBoard)<Board>({ actor }, { boardId: id }),
  // For good, once the board's title is typed; only an archived board.
  deleteBoard: (id: string, actor: string, confirm: string) => post(routes.deleteBoard)<{ ok: true }>({ actor, confirm }, { boardId: id }),
  // No block ids: sync all.
  requestSync: (id: string, actor: string, blockIds?: string[]) => post(routes.requestSync)<Board>({ actor, blockIds }, { boardId: id }),
  cancelSync: (id: string, actor: string) => post(routes.cancelSync)<Board>({ actor }, { boardId: id }),
  // Asks agents for something on the board context, e.g. an architecture view; or cancels that.
  askAgents: (id: string, actor: string, text: string) => post(routes.askAgents)<Board>({ actor, text }, { boardId: id }),
  cancelRequest: (id: string, requestId: string, actor: string) => post(routes.cancelRequest)<Board>({ actor }, { boardId: id, requestId }),
  // Threads: conversations with agents. Starting one is its first message.
  threads: (boardId: string) => get(routes.boardThreads)<Thread[]>({ boardId }),
  thread: (id: string) => get(routes.thread)<Thread>({ threadId: id }),
  // `door`: the tab whose chat bar started it, or the threads list (core/doors.ts).
  startThread: (boardId: string, actor: string, body: string, lens?: ThreadLens, door?: ThreadDoor) =>
    post(routes.startThread)<Thread>({ actor, body, lens, door }, { boardId }),
  postToThread: (id: string, actor: string, body: string) => post(routes.postToThread)<Thread>({ actor, body }, { threadId: id }),
  // A preset's name, or one's own with a brief; null for General.
  setThreadLens: (id: string, actor: string, lens: ThreadLens | null) => post(routes.setThreadLens)<Thread>({ actor, lens }, { threadId: id }),
  // A board's decisions, tasks, comments, findings and canvas blocks; no board, or all, searches every board.
  search: (boardId: string | undefined, q: string, options: { kinds?: SearchKind[]; all?: boolean; open?: boolean }) => {
    const params = new URLSearchParams({ q });
    if (options.kinds?.length) params.set('kinds', options.kinds.join(','));
    if (options.all || !boardId) params.set('all', '1');
    if (options.open) params.set('open', '1');
    return boardId ? get(routes.boardSearch)<SearchResponse>({ boardId }, params) : get(routes.search)<SearchResponse>(undefined, params);
  },
  postDecision: (boardId: string, actor: string, input: { question: string; context?: string; options?: string[]; area?: string }) =>
    post(routes.postDecision)<Decision>({ actor, ...input }, { boardId }),
  addOption: (id: string, actor: string, label: string) => post(routes.addOption)<Decision>({ actor, label }, { decisionId: id }),
  revise: (
    id: string,
    actor: string,
    patch: {
      question?: string;
      context?: string;
      options?: { id: string; label?: string; description?: string; outdated?: boolean; reason?: string }[];
    },
  ) => post(routes.reviseDecision)<Decision>({ actor, ...patch }, { decisionId: id }),
  // Files a card under an area (theme); '' clears it.
  setArea: (id: string, actor: string, area: string) => post(routes.setArea)<Decision>({ actor, area }, { decisionId: id }),
  requestRefresh: (id: string, actor: string, note?: string) => post(routes.requestRefresh)<Decision>({ actor, note }, { decisionId: id }),
  // After deciding `id`, asks agents to check the decisions it may change still hold, together.
  revisit: (id: string, actor: string, decisionIds: string[]) => post(routes.revisit)<Decision[]>({ actor, decisionIds }, { decisionId: id }),
  cancelRefresh: (id: string, actor: string) => post(routes.cancelRefresh)<Decision>({ actor }, { decisionId: id }),
  retire: (id: string, actor: string, note: string) => post(routes.retireDecision)<Decision>({ actor, note }, { decisionId: id }),
  resolve: (
    id: string,
    actor: string,
    input: { optionId?: string; answer?: string; rationale?: string; provisional?: boolean },
  ) => post(routes.resolveDecision)<Decision>({ actor, ...input }, { decisionId: id }),
  explore: (id: string, actor: string, note?: string) => post(routes.exploreDecision)<Decision>({ actor, note }, { decisionId: id }),
  defer: (id: string, actor: string, note?: string) => post(routes.deferDecision)<Decision>({ actor, note }, { decisionId: id }),
  reopen: (id: string, actor: string) => post(routes.reopenDecision)<Decision>({ actor }, { decisionId: id }),
  comment: (id: string, actor: string, body: string) => post(routes.commentOnDecision)<Decision>({ actor, body }, { decisionId: id }),
  requestPlan: (id: string, actor: string, note?: string) => post(routes.requestPlan)<Decision>({ actor, note }, { decisionId: id }),
  commentTask: (id: string, actor: string, body: string) => post(routes.commentOnTask)<Task>({ actor, body }, { taskId: id }),
  // A 👍, 👎 or 👀 on a comment or thread message, or taking one's own back.
  react: (place: ReactionPlace, commentId: string, actor: string, emoji: Emoji, remove: boolean) => {
    const body = { actor, emoji, ...(remove ? { remove } : {}) };
    if ('taskId' in place) return post(routes.reactToTaskComment)<Comment | ThreadMessage>(body, { taskId: place.taskId, commentId });
    if ('decisionId' in place) return post(routes.reactToDecisionComment)<Comment | ThreadMessage>(body, { decisionId: place.decisionId, commentId });
    if ('threadId' in place) return post(routes.reactToThreadMessage)<Comment | ThreadMessage>(body, { threadId: place.threadId, commentId });
    return post(routes.reactToPinComment)<Comment | ThreadMessage>(body, { pinId: place.pinId, commentId });
  },
  addTask: (boardId: string, actor: string, input: { title: string; decisionIds?: string[] }) => post(routes.addTask)<Task>({ actor, ...input }, { boardId }),
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
  ) => post(routes.updateTask)<Task>({ actor, ...patch }, { taskId: id }),
  // Dropping a task as work that won't be done, and bringing it back to the backlog or to do.
  dropTask: (id: string, actor: string, note?: string) => post(routes.dropTask)<Task>({ actor, ...(note ? { note } : {}) }, { taskId: id }),
  bringBackTask: (id: string, actor: string, to: 'backlog' | 'todo') => post(routes.bringBackTask)<Task>({ actor, to }, { taskId: id }),
  // What links to a card, in sentences, and deleting one made by mistake, for good.
  cardLinks: (card: { taskId: string } | { decisionId: string }) =>
    'taskId' in card ? get(routes.taskLinks)<{ lines: string[] }>({ taskId: card.taskId }) : get(routes.decisionLinks)<{ lines: string[] }>({ decisionId: card.decisionId }),
  deleteTask: (id: string, actor: string) => post(routes.deleteTask)<{ ok: true }>({ actor }, { taskId: id }),
  deleteDecision: (id: string, actor: string) => post(routes.deleteDecision)<{ ok: true }>({ actor }, { decisionId: id }),
  askPeople: (id: string, actor: string, names: string[], note?: string) => post(routes.askPeople)<Decision>({ actor, names, note }, { decisionId: id }),
  unask: (id: string, actor: string, name: string) => post(routes.unask)<Decision>({ actor, name }, { decisionId: id }),
  addCriterion: (id: string, actor: string, label: string) => post(routes.addCriterion)<Decision>({ actor, label }, { decisionId: id }),
  removeCriterion: (id: string, criterionId: string, actor: string) =>
    post(routes.removeCriterion)<Decision>({ actor }, { decisionId: id, criterionId }),
  mark: (id: string, actor: string, criterionId: string, optionId: string, value: MarkValue | null) =>
    post(routes.mark)<Decision>({ actor, criterionId, optionId, value }, { decisionId: id }),

  addBlock: (
    ref: CanvasRef,
    actor: string,
    input: { content: BlockContent; title?: string; x?: number; y?: number; w?: number; h?: number },
  ) => post(routes.addBlock)<Block>({ actor, ...ref, ...input }),
  updateBlock: (id: string, actor: string, patch: BlockPatch) => post(routes.updateBlock)<Block>({ actor, ...patch }, { id }),
  // What a block's kind makes of it (a table's Make a chart: a bar chart of its numbers, beside it); `left` names the columns of words it left out.
  deriveBlock: (blockId: string, actor: string) => post(routes.deriveBlock)<{ block: Block; left: string[] }>({ actor }, { id: blockId }),
  // A block's versions, newest (the current one) first; an earlier one in full;
  // and bringing one back, refused if the block moved on from blockRev.
  blockVersions: (id: string) => get(routes.blockVersions)<{ rev: number; versions: VersionSummary[] }>({ id }),
  blockVersion: (id: string, rev: number) => get(routes.blockVersion)<BlockVersion>({ id, rev }),
  restoreBlock: (id: string, actor: string, rev: number, blockRev: number) => post(routes.restoreBlock)<Block>({ actor, rev, blockRev }, { id }),
  // Deleting an earlier version, or all of them, which restoreItem undoes.
  deleteVersion: (id: string, actor: string, rev: number) => post(routes.deleteVersion)<{ ok: true; deleted: DeletedItem }>({ actor }, { id, rev }),
  deleteEarlierVersions: (id: string, actor: string) => post(routes.deleteEarlierVersions)<{ ok: true; deleted: DeletedItem }>({ actor }, { id }),
  moveItems: (ref: CanvasRef, actor: string, moves: Move[]) => post(routes.moveItems)<{ ok: true }>({ actor, ...ref, moves }),
  addGroup: (ref: CanvasRef, actor: string, input: { title: string; x: number; y: number; w: number; h: number }) =>
    post(routes.addGroup)<Group>({ actor, ...ref, ...input }),
  renameGroup: (id: string, actor: string, title: string) => post(routes.renameGroup)<Group>({ actor, title }, { id }),
  addLink: (actor: string, from: string, to: string) => post(routes.addLink)<Link>({ actor, from, to }),
  relabelLink: (id: string, actor: string, label: string) => post(routes.relabelLink)<Link>({ actor, label }, { id }),
  pinTask: (blockId: string, actor: string, input: { part: PinPart; text: string; ready: boolean }) =>
    post(routes.pinTask)<{ pin: Pin; task: Task }>({ actor, ...input }, { id: blockId }),
  pinQuestion: (blockId: string, actor: string, input: { part: PinPart; text: string }) =>
    post(routes.pinQuestion)<{ pin: Pin; decision: Decision }>({ actor, ...input }, { id: blockId }),
  // ask: a request for agents to act on the part, where its kind takes one (a website's element).
  pinComment: (blockId: string, actor: string, input: { part: PinPart; body: string; ask?: boolean }) =>
    post(routes.pinComment)<{ pin: Pin; comment: Comment }>({ actor, ...input }, { id: blockId }),
  commentOnPin: (pinId: string, actor: string, body: string) => post(routes.commentOnPin)<{ pin: Pin; comment: Comment }>({ actor, body }, { id: pinId }),
  resolvePin: (pinId: string, actor: string, resolved: boolean) => post(routes.resolvePin)<Pin>({ actor, resolved }, { id: pinId }),
  // Pairing with an agent on a piece in its full view (server/pairing.ts):
  // starting, the page's beat (active: the person did something since), and leaving.
  startPairing: (actor: string, input: { blockId: string; part: string; agent: string }) => post(routes.startPairing)<PairingSession>({ actor, ...input }),
  pairingBeat: (id: string, actor: string, active: boolean) => post(routes.pairingBeat)<PairingSession>({ actor, active }, { id }),
  endPairing: (id: string, actor: string) => post(routes.endPairing)<{ summary?: string }>({ actor }, { id }),
  // Leaving as the page goes away: sent even as it unloads.
  leavePairing: (id: string, actor: string) =>
    void fetch(routeUrl(routes.endPairing, { id }), { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor }) }).catch(() => undefined),
  // Removing an item keeps it aside for 30 days; restoring puts it back with
  // the same id, with notes on anything that couldn't come back.
  removeItem: (id: string, actor: string) => post(routes.removeItem)<{ ok: true; deleted: DeletedItem }>({ actor }, { id }),
  restoreItem: (id: string, actor: string) => post(routes.restoreItem)<{ restored: DeletedItem; notes: string[] }>({ actor }, { id }),
  // The new asset's id, and its picture's size when the server could read it.
  uploadImage: async (file: Blob): Promise<{ assetId: string; size: { width: number; height: number } | null }> => {
    const response = await fetch(routeUrl(routes.uploadAsset), { method: routes.uploadAsset.method, headers: { 'Content-Type': file.type }, body: file });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? `Upload failed (${response.status})`);
    const size = typeof data.width === 'number' && typeof data.height === 'number' ? { width: data.width, height: data.height } : null;
    return { assetId: data.assetId as string, size };
  },

  // App-wide connectors: their status, a sign-in (the service's page, opened
  // in a new tab) and signing out. A connector's own calls are in its web folder.
  connectors: () => get(routes.connectors)<ConnectorStatus[]>(),
  // permissions: more to allow than the connector has, e.g. ['docs'] for Google Docs.
  startConnector: (id: string, permissions?: string[]) => post(routes.startConnector)<{ url: string }>(permissions ? { permissions } : {}, { id }),
  disconnectConnector: (id: string) => post(routes.disconnectConnector)<{ connector: ConnectorStatus; revoked: boolean }>({}, { id }),
};
