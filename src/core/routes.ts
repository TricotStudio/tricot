// Every REST route of the core and the canvas, once: its method and its path,
// with :name where a piece of the path is a value. The server registers its
// routes from this table (server/routing.ts), and the page and the `tricot`
// command build their addresses from it (routeUrl; web/shared/api.ts), so they
// can't drift apart, and test/routes.test.ts checks that nothing is served or
// called outside it. A connector's own routes are in its core folder
// (core/connectors/<id>/routes.ts), and the connector registry gathers them
// (connectorRoutes), so this table names no service. A part's are in a table
// of its own, which its API part declares
// (server/apiParts.ts), so this one names none of them.
// The MCP endpoint is not REST and is not here.
//
// No imports but what a route is (route.ts): the browser takes it too
// (test/bundle.test.ts), and the platform and the command's small modules load
// it, so it never brings the registry or the store with it (test/layers.test.ts).

import { del, get, post } from './route';

export { routeUrl, type HttpMethod, type ParamNames, type PathParams, type Query, type Route, type UrlArgs } from './route';

export const routes = {
  // ---- the app ------------------------------------------------------------------------
  info: get('/api/info'),
  chooseFolder: post('/api/folders/choose'), // the system's own folder dialog, opened on this computer, for a board's project folder
  instance: get('/api/instance'), // which run of Tricot this is, for the approval hook
  update: get('/api/update'),
  startUpdate: post('/api/update'),
  checkForUpdates: post('/api/update/check'),
  stop: post('/api/stop'),

  // ---- boards -------------------------------------------------------------------------
  boards: get('/api/boards'),
  needs: get('/api/needs'), // the boards in use and the agents around them, for Projects and the board switcher; what waits on a person is added by a part, when it is there
  createBoard: post('/api/boards'),
  board: get('/api/boards/:boardId'),
  updateBoard: post('/api/boards/:boardId'),
  archiveBoard: post('/api/boards/:boardId/archive'),
  unarchiveBoard: post('/api/boards/:boardId/unarchive'),
  deleteBoard: post('/api/boards/:boardId/delete'),
  boardLive: get('/api/boards/:boardId/live'),
  boardEvents: get('/api/boards/:boardId/events'),
  boardStream: get('/api/boards/:boardId/stream'),
  wakes: post('/api/boards/:boardId/wakes'), // the agents a Tricot terminal holds to wake there, and what's due for each
  listen: post('/api/boards/:boardId/listen'), // `tricot listen`: holds an agent connected on its own asleep there, until something concerns it
  boardSearch: get('/api/boards/:boardId/search'),
  projectFiles: get('/api/boards/:boardId/files'), // the files in the board's project folder, for its Files view
  projectFile: get('/api/boards/:boardId/files/read'), // one of them, ?path=src/index.ts (&lines=120-180), for its preview
  projectSearch: get('/api/boards/:boardId/files/search'), // ?q=text (&case=1 &word=1 &regex=1): the lines of its files that match, as an IDE's Find in Files, for Files' search of what is inside them
  projectImage: get('/api/boards/:boardId/files/image'), // a picture of them, ?path=docs/shot.png: its bytes, for its preview
  projectFileBlock: post('/api/boards/:boardId/files/block'), // its code block on the board's Files canvas, made the first time
  projectFileWrite: post('/api/boards/:boardId/files/write'), // a person's edit, saved over it, unless it changed since they opened it
  search: get('/api/search'),
  requestSync: post('/api/boards/:boardId/sync'),
  cancelSync: post('/api/boards/:boardId/sync/cancel'),
  askAgents: post('/api/boards/:boardId/requests'),
  cancelRequest: post('/api/boards/:boardId/requests/:requestId/cancel'),

  // ---- threads ------------------------------------------------------------------------
  boardThreads: get('/api/boards/:boardId/threads'),
  startThread: post('/api/boards/:boardId/threads'), // a thread from the chat bar; over a page (pageId, blockIds) or, in Files, about the open file (file)
  askInGeneral: post('/api/boards/:boardId/threads/general'),
  thread: get('/api/threads/:threadId'),
  postToThread: post('/api/threads/:threadId/messages'),
  setThreadLens: post('/api/threads/:threadId/lens'),
  reviewThread: post('/api/threads/:threadId/review'), // a person's verdict on work waiting for their review: looks good, commit it, or needs changes

  // ---- reactions, by where the comment is (a task's and a decision's belong to a part) -----
  reactToThreadMessage: post('/api/threads/:threadId/messages/:commentId/reactions'),
  reactToPinComment: post('/api/canvas/pins/:pinId/comments/:commentId/reactions'),

  // ---- the canvas ---------------------------------------------------------------------
  addPage: post('/api/boards/:boardId/pages'), // a Sketchbook page: a canvas of its own
  updatePage: post('/api/pages/:pageId'), // renamed, or moved among the pages
  deletePage: post('/api/pages/:pageId/delete'),
  askOnPage: post('/api/pages/:pageId/requests'), // a request about blocks selected on a page: the page starts a thread about them now (startThread, with blockIds)
  addBlock: post('/api/canvas/blocks'),
  updateBlock: post('/api/canvas/blocks/:id'),
  deriveBlock: post('/api/canvas/blocks/:id/chart'),
  blockVersions: get('/api/canvas/blocks/:id/versions'),
  blockVersion: get('/api/canvas/blocks/:id/versions/:rev'),
  deleteVersion: post('/api/canvas/blocks/:id/versions/:rev/delete'),
  deleteEarlierVersions: post('/api/canvas/blocks/:id/versions/delete'),
  restoreBlock: post('/api/canvas/blocks/:id/restore'),
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
  // and what each connector adds, under /api/connectors/<id>: in its own table (core/connectors/registry.ts connectorRoutes)
} as const;
