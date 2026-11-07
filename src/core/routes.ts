// Every REST route the server serves, once: its method and its path, with
// :name where a piece of the path is a value. The server registers its routes
// from this table (server/routing.ts) and the page builds its addresses from
// it (routeUrl; web/shared/api.ts), so the two can't drift apart, and
// test/routes.test.ts checks that nothing is served or called outside it.
// The MCP endpoint is not REST and is not here.
//
// No imports: the browser takes it too (test/bundle.test.ts).

export type HttpMethod = 'GET' | 'POST' | 'DELETE';

export interface Route<Path extends string = string, Method extends HttpMethod = HttpMethod> {
  readonly method: Method;
  readonly path: Path;
}

const get = <Path extends string>(path: Path): Route<Path, 'GET'> => ({ method: 'GET', path });
const post = <Path extends string>(path: Path): Route<Path, 'POST'> => ({ method: 'POST', path });
const del = <Path extends string>(path: Path): Route<Path, 'DELETE'> => ({ method: 'DELETE', path });

export const routes = {
  // ---- the app ------------------------------------------------------------------------
  info: get('/api/info'),
  instance: get('/api/instance'), // which run of Tricot this is, for the approval hook
  update: get('/api/update'),
  startUpdate: post('/api/update'),
  checkForUpdates: post('/api/update/check'),
  stop: post('/api/stop'),

  // ---- boards -------------------------------------------------------------------------
  boards: get('/api/boards'),
  createBoard: post('/api/boards'),
  board: get('/api/boards/:boardId'),
  updateBoard: post('/api/boards/:boardId'),
  archiveBoard: post('/api/boards/:boardId/archive'),
  unarchiveBoard: post('/api/boards/:boardId/unarchive'),
  deleteBoard: post('/api/boards/:boardId/delete'),
  boardLive: get('/api/boards/:boardId/live'),
  boardEvents: get('/api/boards/:boardId/events'),
  boardStream: get('/api/boards/:boardId/stream'),
  boardSearch: get('/api/boards/:boardId/search'),
  search: get('/api/search'),
  requestSync: post('/api/boards/:boardId/sync'),
  cancelSync: post('/api/boards/:boardId/sync/cancel'),
  askAgents: post('/api/boards/:boardId/requests'),
  cancelRequest: post('/api/boards/:boardId/requests/:requestId/cancel'),
  needs: get('/api/needs'),
  dismissedNeeds: get('/api/needs/dismissed'),
  dismissNeeds: post('/api/needs/dismiss'),

  // ---- threads ------------------------------------------------------------------------
  boardThreads: get('/api/boards/:boardId/threads'),
  startThread: post('/api/boards/:boardId/threads'),
  askInGeneral: post('/api/boards/:boardId/threads/general'),
  thread: get('/api/threads/:threadId'),
  postToThread: post('/api/threads/:threadId/messages'),
  setThreadLens: post('/api/threads/:threadId/lens'),

  // ---- decisions ----------------------------------------------------------------------
  postDecision: post('/api/boards/:boardId/decisions'),
  addOption: post('/api/decisions/:decisionId/options'),
  reviseDecision: post('/api/decisions/:decisionId/revise'),
  setArea: post('/api/decisions/:decisionId/area'),
  requestRefresh: post('/api/decisions/:decisionId/refresh'),
  cancelRefresh: post('/api/decisions/:decisionId/refresh/cancel'),
  revisit: post('/api/decisions/:decisionId/revisit'),
  retireDecision: post('/api/decisions/:decisionId/retire'),
  resolveDecision: post('/api/decisions/:decisionId/resolve'),
  exploreDecision: post('/api/decisions/:decisionId/explore'),
  deferDecision: post('/api/decisions/:decisionId/defer'),
  reopenDecision: post('/api/decisions/:decisionId/reopen'),
  deleteDecision: post('/api/decisions/:decisionId/delete'),
  decisionLinks: get('/api/decisions/:decisionId/links'),
  commentOnDecision: post('/api/decisions/:decisionId/comments'),
  requestPlan: post('/api/decisions/:decisionId/plan'),
  askPeople: post('/api/decisions/:decisionId/ask'),
  unask: post('/api/decisions/:decisionId/unask'),
  addCriterion: post('/api/decisions/:decisionId/criteria'),
  removeCriterion: post('/api/decisions/:decisionId/criteria/:criterionId/delete'),
  mark: post('/api/decisions/:decisionId/marks'),

  // ---- tasks --------------------------------------------------------------------------
  addTask: post('/api/boards/:boardId/tasks'),
  updateTask: post('/api/tasks/:taskId'),
  dropTask: post('/api/tasks/:taskId/drop'),
  bringBackTask: post('/api/tasks/:taskId/bring-back'),
  deleteTask: post('/api/tasks/:taskId/delete'),
  taskLinks: get('/api/tasks/:taskId/links'),
  commentOnTask: post('/api/tasks/:taskId/comments'),

  // ---- reactions, by where the comment is ---------------------------------------------
  reactToTaskComment: post('/api/tasks/:taskId/comments/:commentId/reactions'),
  reactToDecisionComment: post('/api/decisions/:decisionId/comments/:commentId/reactions'),
  reactToThreadMessage: post('/api/threads/:threadId/messages/:commentId/reactions'),
  reactToPinComment: post('/api/canvas/pins/:pinId/comments/:commentId/reactions'),

  // ---- the canvas ---------------------------------------------------------------------
  addBlock: post('/api/canvas/blocks'),
  updateBlock: post('/api/canvas/blocks/:id'),
  deriveBlock: post('/api/canvas/blocks/:id/chart'),
  blockVersions: get('/api/canvas/blocks/:id/versions'),
  blockVersion: get('/api/canvas/blocks/:id/versions/:rev'),
  deleteVersion: post('/api/canvas/blocks/:id/versions/:rev/delete'),
  deleteEarlierVersions: post('/api/canvas/blocks/:id/versions/delete'),
  restoreBlock: post('/api/canvas/blocks/:id/restore'),
  pinTask: post('/api/canvas/blocks/:id/pins/task'),
  pinQuestion: post('/api/canvas/blocks/:id/pins/question'),
  pinComment: post('/api/canvas/blocks/:id/pins/comment'),
  pinToCard: post('/api/canvas/blocks/:id/pins'),
  commentOnPin: post('/api/canvas/pins/:id/comments'),
  resolvePin: post('/api/canvas/pins/:id/resolve'),
  moveItems: post('/api/canvas/move'),
  pasteBlocks: post('/api/canvas/paste'), // copies of blocks from one canvas, here or on another board
  addGroup: post('/api/canvas/groups'),
  renameGroup: post('/api/canvas/groups/:id'),
  addLink: post('/api/canvas/links'),
  relabelLink: post('/api/canvas/links/:id'),
  removeItem: post('/api/canvas/items/:id/delete'),
  restoreItem: post('/api/canvas/items/:id/restore'),
  uploadAsset: post('/api/assets'),
  asset: get('/api/assets/:id'),
  siteAddress: get('/api/sites/:blockId'),

  // ---- pairing and live steps ---------------------------------------------------------
  startPairing: post('/api/pairing'),
  pairingBeat: post('/api/pairing/:id/beat'),
  endPairing: post('/api/pairing/:id/end'),
  stepsStream: get('/api/steps/stream'),
  recordStep: post('/api/agents/:name/steps'),
  liveSteps: get('/api/live-steps'),
  previewLiveSteps: post('/api/live-steps/:agent/preview'),
  applyLiveSteps: post('/api/live-steps/:agent/apply'),

  // ---- agents -------------------------------------------------------------------------
  agents: get('/api/agents'),
  agentWork: get('/api/agents/:name/work'),
  recordUsage: post('/api/agents/:name/usage'),
  agentUsage: get('/api/agents/:name/usage'),
  toolCosts: get('/api/tool-costs'), // what each MCP tool call costs agents, in tokens: sizes only
  agentRules: get('/api/agent-rules'), // the model and thinking level each agent starts on
  setAgentRule: post('/api/agent-rules/:agent'),
  addSkill: post('/api/skills'),
  editSkill: post('/api/skills/:skillId'),
  deleteSkill: post('/api/skills/:skillId/delete'),

  // ---- requests for permission --------------------------------------------------------
  registerHost: post('/api/approvals/hosts'),
  hostHeartbeat: post('/api/approvals/hosts/heartbeat'),
  hostRelease: post('/api/approvals/hosts/release'),
  requestApproval: post('/api/agents/:name/approvals'),
  waitForApproval: post('/api/approvals/:id/wait'),
  withdrawApproval: post('/api/approvals/:id/withdraw'),
  approvals: get('/api/approvals'),
  approvalsStream: get('/api/approvals/stream'),
  answerApproval: post('/api/approvals/:id/answer'),

  // ---- seats and the commands' leases -------------------------------------------------
  askToBeLetIn: post('/api/seats/admissions'),
  admission: get('/api/seats/admissions/:id'),
  admissions: get('/api/seats/admissions'),
  answerAdmission: post('/api/seats/admissions/:id/answer'),
  seats: get('/api/seats'),
  seatTicket: post('/api/seats/ticket'),
  seatBeat: post('/api/seats/beat'),
  seatRelease: post('/api/seats/release'),
  removeSeat: post('/api/seats/:id/remove'),
  takeLease: post('/api/leases'),
  beatLease: post('/api/leases/:id'),
  releaseLease: del('/api/leases/:id'),

  // ---- connectors ---------------------------------------------------------------------
  connectors: get('/api/connectors'),
  startConnector: post('/api/connectors/:id/start'),
  connectorCallback: get('/api/connectors/:id/callback'),
  disconnectConnector: post('/api/connectors/:id/disconnect'),

  githubDevice: get('/api/connectors/github/device'),
  githubStartDevice: post('/api/connectors/github/device/start'),
  githubPollDevice: post('/api/connectors/github/device/poll'),
  githubCancelDevice: post('/api/connectors/github/device/cancel'),
  githubToken: post('/api/connectors/github/token'),
  githubRepos: get('/api/connectors/github/repos'),
  githubCard: get('/api/connectors/github/cards/:owner/:repo/:kind/:number'),
  githubShowChanges: post('/api/connectors/github/blocks/:blockId/diff'),
  githubBringInFile: post('/api/connectors/github/blocks/:blockId/file'),

  figmaToken: post('/api/connectors/figma/token'),
  figmaFile: get('/api/connectors/figma/files/:fileId'),
  figmaBringIn: post('/api/connectors/figma/frames'),
  figmaRefresh: post('/api/connectors/figma/images/:blockId/refresh'),

  linearKey: post('/api/connectors/linear/key'),
  linearIssue: get('/api/connectors/linear/issues/:identifier'),

  slackThread: get('/api/connectors/slack/threads/:channel/:ts'),
  slackShareDecision: post('/api/connectors/slack/decisions/:decisionId/share'),

  googleFile: get('/api/connectors/google/files/:fileId'),
  googlePicker: post('/api/connectors/google/picker'),
  googleChosen: post('/api/connectors/google/chosen'),
  googleDoc: get('/api/connectors/google/docs/:blockId'),
  googleDocDraft: post('/api/connectors/google/docs/:blockId/draft'),
  googleDocDiscard: post('/api/connectors/google/docs/:blockId/discard'),
  googleDocSave: post('/api/connectors/google/docs/:blockId/save'),
  googleDocPins: post('/api/connectors/google/docs/:blockId/pins'),
  googleDocResolve: post('/api/connectors/google/docs/:blockId/resolve'),
} as const;

// The names in a path pattern: '/api/boards/:boardId/tasks' has boardId.
export type ParamNames<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}` ? Name | ParamNames<`/${Rest}`> : Path extends `${string}:${infer Name}` ? Name : never;

export type PathParams<Path extends string> = { [Name in ParamNames<Path>]: string | number };

export type Query = URLSearchParams | Record<string, string>;

// What routeUrl takes after the route: the path's values when it has any, then a query.
export type UrlArgs<Path extends string> = [ParamNames<Path>] extends [never] ? [params?: undefined, query?: Query] : [params: PathParams<Path>, query?: Query];

// A route's address with each value put in, encoded as one piece of the path,
// and the query after it when there is one. The values a path takes are the
// type's to check: one missing is a type error here, not a 404 there.
export function routeUrl<Path extends string>(route: Route<Path>, ...args: UrlArgs<Path>): string {
  const [params, query] = args as [Record<string, string | number> | undefined, Query | undefined];
  const path = route.path.replace(/:(\w+)/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new Error(`${route.method} ${route.path} needs ${name}.`);
    return encodeURIComponent(String(value));
  });
  const search = query === undefined ? '' : new URLSearchParams(query).toString();
  return search ? `${path}?${search}` : path;
}
