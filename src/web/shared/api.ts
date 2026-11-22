import type {
  Block,
  BlockVersion,
  Board,
  BoardEvent,
  BoardSummary,
  Comment,
  Group,
  Link,
  MessageLens,
  Pin,
  ScratchPage,
  Thread,
  ThreadDoor,
  ThreadLens,
  ThreadMessage,
  VersionSummary,
} from '../../core/types';
import type { PresenceState } from '../../core/delivery';
import type { Emoji } from '../../core/reactions';
import type { LiveState } from '../../core/changes';
import type { Pasted } from '../../core/store/pasting';
import type { BlockContent as StoreBlockContent, BlockPatch as StoreBlockPatch, PinPart as StorePinPart } from '../../core/store/inputs';
import type { ConnectorStatus } from '../../core/connectors';
import type { DeletionSummary } from '../../core/deletions';
import type { StartFolder } from '../../core/firstRun';
import type { BoardsReport } from '../../core/projects';
import type { CheckedState, UpdateState } from '../../core/update';
import type { AgentSkills, TricotSkill } from '../../core/skills';
import type { SearchKind, SearchResponse } from '../../core/search';
import type { LiveStepsAction, LiveStepsPreview, LiveStepsReport, LiveStepsResult, LiveStepsScope } from '../../core/liveSteps';
import type { AgentUsageReport } from '../../core/usage';
import type { AgentRules } from '../../core/agentRules';
import type { PairingSession } from '../../core/pairing';
import type { ProjectFileText, ProjectFiles } from '../../core/projectFiles';
import type { ProjectSearch, ProjectSearchOptions } from '../../core/projectSearch';
import type { ApprovalReply } from '../../core/approvals';
import { routes, routeUrl, type ParamNames, type PathParams, type Route, type UrlArgs } from '../../core/routes';
import { SEAT_GONE, SEAT_NEEDED, type AdmissionView, type SeatView } from '../../core/seats';
import type { CardKindName } from '../../core/pins';
import { forgetSeat, letThisBrowserIn, signedHeaders } from './seat';

// Turning one agent's live steps on or off: which way, the name it sends
// steps as, and the scope (every project, or tidying up a project's own hook).
export type LiveStepsChange = { action: LiveStepsAction; name?: string; scope?: LiveStepsScope };

export type CanvasRef = { boardId?: string; decisionId?: string; taskId?: string; pageId?: string };

// A canvas item removed or restored: note "Where things stand", or v7 of it.
export type DeletedItem = Pick<DeletionSummary, 'id' | 'kind' | 'label'>;

// Agents seen on a board recently; sent with the board, never saved with it.
export interface AgentPresence {
  name: string;
  lastSeen: string;
  state: PresenceState;
  stuck?: true; // asleep, and a wake its terminal typed into it started no turn
  focus?: { kind: CardKindName; id: string }; // the card it is taking a look at, for a minute after its last call about it
  coordinator?: true; // the board's coordinator (core/roles.ts): the chat bar's threads go to it
}

// What an agent is doing now, from a hook in its harness (server/steps.ts): its
// latest step per session, on the stream only, never saved.
export interface AgentStep {
  agent: string;
  text: string; // "Running npm test"
  at: string;
  card?: { kind: CardKindName; id: string };
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

// The part of a block a person pins, as the store takes it (core/store/inputs.ts):
// words they selected (with the text around them), table cells, a box drawn
// on an image (as fractions of it), a diagram's node or arrow, or the whole block.
export type PinPart = StorePinPart;

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
// (seat.ts): Tricot refuses it unsigned (seat_needed), and the request
// goes again signed, once this browser is let in, which it asks for then.
async function request<T>(method: 'GET' | 'POST', url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const text = body ? JSON.stringify(body) : undefined;
  const send = async (signed?: Record<string, string>) => {
    const response = await fetch(url, {
      method,
      headers: { ...(text && { 'Content-Type': 'application/json' }), ...signed },
      body: text,
      signal,
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
  // `folder`: where Tricot was started, from ~ (Projects' first run). `version`
  // and `source`, the repository's page: the foot of Projects. `parts`: the ids of
  // the API parts it serves besides the core's (a part's one), none from a board
  // that does not say.
  info: () => get(routes.info)<{ mcpUrl: string; version?: string; source?: string; folder?: StartFolder; parts?: string[] }>(),
  // A newer Tricot, and how this one updates (server/updateRoutes.ts).
  update: () => get(routes.update)<UpdateState>(),
  // Update to the version the person was shown: 202 and the handover begins.
  startUpdate: (version: string) => post(routes.startUpdate)<UpdateState>({ version }),
  // Ask GitHub, then npm, now: the state, and what the check found.
  checkForUpdates: () => post(routes.checkForUpdates)<CheckedState>(undefined),
  boards: () => get(routes.boards)<BoardSummary[]>(),
  // The boards in use and the agents around them (core/projects.ts); `seen` is the last event the viewer saw on each board (live/away.ts).
  needs: (name: string, seen: Record<string, number>) => get(routes.needs)<BoardsReport>(undefined, { name, seen: JSON.stringify(seen) }),
  // The agents and the skills each reported; with a board, where each is on that board.
  agents: (boardId?: string) => get(routes.agents)<AgentSkills[]>(undefined, boardId ? { board: boardId } : undefined),
  // An agent's plan usage, as its harness last said it, and with a board what
  // it did there since `day` and `week` (the person's today and week, ms).
  agentUsage: (name: string, query: { board?: string; day: number; week: number }) =>
    get(routes.agentUsage)<AgentUsageReport>({ name }, { ...(query.board && { board: query.board }), day: String(query.day), week: String(query.week) }),
  // The model and thinking level each agent starts on, by agent id; and
  // setting one's, which is the person's alone (null: its own).
  agentRules: () => get(routes.agentRules)<{ rules: AgentRules }>(),
  setAgentRule: (agent: string, rule: { model: string | null; effort: string | null; orchestrators?: number | null }) => post(routes.setAgentRule)<{ rules: AgentRules }>(rule, { agent }),
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
  // The board's project files: the list, and one file's text for its preview (some of its lines, "120-180").
  projectFiles: (id: string) => get(routes.projectFiles)<ProjectFiles>({ boardId: id }),
  projectFile: (id: string, file: string, lines?: string) => get(routes.projectFile)<ProjectFileText>({ boardId: id }, { path: file, ...(lines ? { lines } : {}) }),
  // What is inside them: the lines that match, by file. `signal` cancels it, for a search typed over.
  searchProjectFiles: (id: string, { q, matchCase, word, regex }: ProjectSearchOptions, signal?: AbortSignal) =>
    request<ProjectSearch>('GET', routeUrl(routes.projectSearch, { boardId: id }, { q, ...(matchCase && { case: '1' }), ...(word && { word: '1' }), ...(regex && { regex: '1' }) }), undefined, signal),
  // Its code block on the board's Files canvas, made the first time, else brought up to the file.
  projectFileBlock: (id: string, actor: string, file: string) => post(routes.projectFileBlock)<{ block: Block; pageId: string }>({ actor, path: file }, { boardId: id }),
  // A person's edit to one, saved over it unless it changed since `base` (its hash as read): a 409 then.
  writeProjectFile: (id: string, actor: string, file: string, text: string, base: string) =>
    post(routes.projectFileWrite)<{ file: ProjectFileText; block: Block }>({ actor, path: file, text, base }, { boardId: id }),
  // The system's own folder dialog, opened on the computer Tricot runs on: the folder chosen, or none when cancelled.
  chooseFolder: () => post(routes.chooseFolder)<{ folder?: string }>({}),
  createBoard: (actor: string, title: string, goal: string, folder?: string) => post(routes.createBoard)<Board>({ actor, title, goal, folder }),
  updateBoard: (id: string, actor: string, patch: { title?: string; goal?: string; folder?: string | null }) =>
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
  // `messageLens`: the lens the message asks for with ^Name, on it alone: the thread's own is `lens`.
  // `pageId`: from the chat bar over a Sketchbook page; `blockIds`: with these blocks selected there, which it is about.
  // `file`: from the chat bar in Files, over the project file open there (its path from the project folder): the thread starts on its block.
  startThread: (boardId: string, actor: string, body: string, lens?: ThreadLens, door?: ThreadDoor, messageLens?: MessageLens, pageId?: string, blockIds?: string[], file?: string) =>
    post(routes.startThread)<Thread>({ actor, body, lens, door, messageLens, pageId, blockIds, file }, { boardId }),
  postToThread: (id: string, actor: string, body: string, messageLens?: MessageLens) => post(routes.postToThread)<Thread>({ actor, body, messageLens }, { threadId: id }),
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
  // A 👍, 👎 or 👀 on a thread message or a comment on a pin, or taking one's own back.
  reactInThread: (threadId: string, commentId: string, actor: string, emoji: Emoji, remove: boolean) =>
    post(routes.reactToThreadMessage)<Comment | ThreadMessage>({ actor, emoji, ...(remove ? { remove } : {}) }, { threadId, commentId }),
  reactOnPin: (pinId: string, commentId: string, actor: string, emoji: Emoji, remove: boolean) =>
    post(routes.reactToPinComment)<Comment | ThreadMessage>({ actor, emoji, ...(remove ? { remove } : {}) }, { pinId, commentId }),

  // The Sketchbook's pages: making one, renaming it, putting it right after another (or first, null), and deleting it for good.
  addPage: (boardId: string, actor: string, title: string) => post(routes.addPage)<ScratchPage>({ actor, title }, { boardId }),
  renamePage: (id: string, actor: string, title: string) => post(routes.updatePage)<ScratchPage>({ actor, title }, { pageId: id }),
  movePage: (id: string, actor: string, after: string | null) => post(routes.updatePage)<ScratchPage>({ actor, after }, { pageId: id }),
  deletePage: (id: string, actor: string) => post(routes.deletePage)<{ ok: true }>({ actor }, { pageId: id }),

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
  // Copies of blocks (and groups, and the links between them) from one canvas on this one, centred on `at`.
  pasteBlocks: (ref: CanvasRef, actor: string, input: { ids: string[]; at?: { x: number; y: number } }) =>
    post(routes.pasteBlocks)<Pasted>({ actor, ...ref, ...input }),
  addGroup: (ref: CanvasRef, actor: string, input: { title: string; x: number; y: number; w: number; h: number }) =>
    post(routes.addGroup)<Group>({ actor, ...ref, ...input }),
  renameGroup: (id: string, actor: string, title: string) => post(routes.renameGroup)<Group>({ actor, title }, { id }),
  addLink: (actor: string, from: string, to: string, weight?: 'thin' | 'medium' | 'thick') => post(routes.addLink)<Link>({ actor, from, to, weight }),
  relabelLink: (id: string, actor: string, label: string) => post(routes.relabelLink)<Link>({ actor, label }, { id }),
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
