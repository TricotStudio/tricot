import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { StartFolder } from '../core/firstRun';
import type { Store } from '../core/store';
import { asPerson, crossSiteCheck, fromThisComputer, fromThisMachine, isLoopbackHost, keepRawBody, originCheck, requireToken, type PersonGate } from './access';
import { createApiRouter, peoplesCopy } from './api';
import { AnswerHosts } from './answerHosts';
import { APPROVAL_BODY_LIMIT, Approvals } from './approvals';
import { createApprovalsRouter, type ApprovalsRoutesOptions } from './approvalsRoutes';
import type { Connectors } from './connectors';
import { createConnectorsRouter } from './connectors/routes';
import { securityHeaders } from './headers';
import { createSitesRouter } from './sites/routes';
import type { SiteServer } from './sites/siteServer';
import { createLiveStepsRouter, type LiveStepsRoutesOptions } from './liveStepsRoutes';
import { instanceRoute } from './instanceRoute';
import { createMcpServer, type McpOptions } from './mcp';
import { PairingSessions } from './pairing';
import { Presence } from './presence';
import { Seats, type SeatNews } from './seats';
import { createSeatsRouter } from './seatsRoutes';
import { STEP_BODY_LIMIT, Steps } from './steps';
import { tunnelCheck } from './tunnelCheck';
import { createUpdateRouter } from './updateRoutes';
import type { Updates } from './updates';
import { Usage, USAGE_BODY_LIMIT } from './usage';
import { createUsageRouter } from './usageRoutes';

export function createApp(
  store: Store,
  options: {
    host: string;
    mcpUrl: string;
    connectors?: Connectors;
    version?: string;
    // The repository's page (package.json), for the Source link on Home.
    source?: string;
    token?: string;
    // Each agent's "Live steps" switch: where the person's agents keep their
    // settings, and Tricot's hook files. None: the switch isn't offered.
    liveSteps?: LiveStepsRoutesOptions;
    // The Content-Security-Policy of the UI's pages (headers.ts).
    pagePolicy?: () => string;
    // The folder Tricot was started in, from ~ (startFolder.ts), for Home's first run.
    folder?: StartFolder;
    // A newer Tricot, and updating to it (updates.ts). None: GET /api/update isn't served.
    updates?: Updates;
    // Where the board's websites are served (sites/siteServer.ts). None: on
    // the network, or in a test that doesn't serve them; pages are told so.
    sites?: SiteServer;
    // Who may answer an agent's request for permission, and how long a
    // hook's wait is held (approvalsRoutes.ts): tests set them.
    approvals?: ApprovalsRoutesOptions;
    // The person's seats (seats.ts, T187), kept in the data folder:
    // startServer gives them. None: kept in memory (tests).
    seats?: Seats;
  },
): Express {
  const app = express();
  app.disable('x-powered-by');
  const loopback = isLoopbackHost(options.host);
  if (!loopback && !options.token) throw new Error(`Listening on ${options.host} needs an access token.`);
  // Beyond this computer, no block names what is on it (a website's folder or dev server).
  store.localFiles = loopback;
  // First, so every response carries them, refusals and the UI included.
  app.use(securityHeaders(options.pagePolicy));
  // When local, refuse what came through a tunnel or a proxy (tunnelCheck.ts),
  // and requests addressed to other hostnames (DNS rebinding).
  if (loopback) app.use(tunnelCheck());
  if (loopback) app.use(localhostHostValidation());
  // Refuse web pages from other origins and requests from other sites, then
  // (beyond this machine) anyone without the token. All come before every
  // route, the UI included.
  app.use(originCheck(loopback));
  app.use(crossSiteCheck());
  if (!loopback && options.token) app.use(requireToken(options.token));
  // A step from an agent's harness is one short line: its body is read with a
  // small limit before the large one below can take it.
  app.use('/api/agents/:name/steps', express.json({ limit: STEP_BODY_LIMIT }));
  app.use('/api/agents/:name/usage', express.json({ limit: USAGE_BODY_LIMIT })); // a harness's plan usage, numbers only
  app.use('/api/agents/:name/approvals', express.json({ limit: APPROVAL_BODY_LIMIT })); // a request for permission: the tool's input, as sent
  // Large enough for MCP calls that carry base64 images. The body as it
  // came is kept too: a seat signs it (access.ts asPerson).
  app.use(express.json({ limit: '15mb', verify: keepRawBody }));
  app.set('json replacer', peoplesCopy);
  const presence = new Presence(
    () => {}, // pages hear of it through presence.subscribe, in live.ts
    Date.now,
    () => {
      try {
        store.lapseFirstLooks();
      } catch (error) {
        console.error('Checking first looks failed:', error);
      }
    },
  );
  // Agents present on a board can be mentioned and assigned before they've written to it.
  store.presentAgents = (key) => presence.list(key).map((a) => a.name);
  // Who acts as a person, and at which tier (access.ts asPerson): Tricot's
  // page, or one of the terminals registered here (answerHosts.ts); and for
  // what is consequential, one of the person's seats (seats.ts), or on the
  // network another device with the token. Every route that acts as a
  // person asks it, with the same terminals and seats.
  const hosts = options.approvals?.hosts ?? new AnswerHosts();
  const local = options.approvals?.fromThisMachine ?? fromThisMachine;
  const seats = options.seats ?? new Seats();
  app.locals.seats = seats;
  const device = loopback ? undefined : (req: Parameters<PersonGate>[0]) => !fromThisComputer(req);
  const person: PersonGate = (req, tier) => asPerson(req, tier, { hosts, seats, local, ...(device && { device }) });
  // Who acts for the person changed: said in the activity of every board in use.
  seats.onNews((news) => announceSeats(store, news));
  // Asking to be let in, answering, the person's list, a stream's ticket (seatsRoutes.ts).
  app.use('/api/seats', createSeatsRouter(seats, person));
  // Connectors are app-wide, set once for every board; their sign-in callback
  // stays behind the Host check above. What they add (a Google Doc's draft
  // lives on a link block) needs the store as well.
  if (options.connectors) app.use('/api/connectors', createConnectorsRouter(options.connectors, store, person));
  // People turn an agent's live steps on or off; agents can't (liveStepsRoutes.ts).
  if (options.liveSteps) app.use('/api/live-steps', createLiveStepsRouter({ person, ...options.liveSteps }));
  // Where a website block is served, and what a person's view found of its pinned elements (sites/routes.ts).
  app.use('/api/sites', createSitesRouter(store, options.sites));
  // What's out, and updating to it: from the page or `tricot update` (updateRoutes.ts).
  if (options.updates) app.use('/api/update', createUpdateRouter(options.updates, { person }));
  const steps = new Steps(store, presence);
  // Who is pairing with which agent on which piece (pairing.ts).
  const pairing = new PairingSessions(store);
  // Each agent's plan usage, from its harness, for its panel (usageRoutes.ts).
  app.use('/api/agents', createUsageRouter(store, new Usage()));
  // An agent's request for permission, waiting on the board for a person to
  // answer (approvals.ts): on the card the agent's steps are on.
  const approvals = new Approvals((agent, session, worker) => steps.placeOfSession(agent, session, worker));
  app.get('/api/instance', instanceRoute); // which run of Tricot this is, for the approval hook (instanceRoute.ts)
  app.use('/api', createApprovalsRouter(store, approvals, { ...options.approvals, hosts, seats, person }));
  app.use('/api', createApiRouter(store, { mcpUrl: options.mcpUrl, version: options.version, ...(options.source && { source: options.source }), ...(options.folder && { folder: options.folder }) }, presence, steps, pairing, approvals, person, seats));
  mountMcp(app, store, { allowFilePaths: loopback, presence, steps, pairing, connectors: options.connectors });
  return app;
}

// What the activity says when who acts for the person changes: on every
// board in use, as the person who did it. A terminal that ends goes quietly.
function announceSeats(store: Store, news: SeatNews): void {
  const name = news.kind === 'removed' ? news.by?.name : news.by.name;
  if (!name) return;
  const summary =
    news.kind === 'admitted'
      ? news.by.first
        ? `let the first browser act for them: ${news.seat.label}, by a keypress in Tricot's terminal`
        : `let ${news.seat.label} act for them, from ${news.by.label}`
      : news.kind === 'removed'
        ? `removed ${news.seat.label} from the browsers and terminals that act for them`
        : `said no to ${news.label} acting for them`;
  store.announceSeats(summary, { kind: 'human', name });
}

function rpcError(message: string) {
  return { jsonrpc: '2.0', error: { code: -32000, message }, id: null };
}

// One MCP session per connected agent. The agent's display name comes from
// `?agent=` on its MCP URL, falling back to the client's own name.
function mountMcp(app: Express, store: Store, mcpOptions: McpOptions): void {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  app.all('/mcp', async (req, res) => {
    const sessionId = req.header('mcp-session-id');
    let transport = sessionId ? sessions.get(sessionId) : undefined;

    if (!transport) {
      if (sessionId) {
        res.status(404).json(rpcError('Unknown session; send a new initialize request.'));
        return;
      }
      if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
        res.status(400).json(rpcError('Start a session with an initialize request.'));
        return;
      }
      const requested = typeof req.query.agent === 'string' ? req.query.agent.trim().slice(0, 60) : '';
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, created);
        },
      });
      created.onclose = () => {
        if (created.sessionId) sessions.delete(created.sessionId);
      };
      const server = createMcpServer(
        store,
        () => ({ kind: 'agent', name: requested || server.server.getClientVersion()?.name || 'agent' }),
        mcpOptions,
      );
      await server.connect(created);
      transport = created;
    }

    await transport.handleRequest(req, res, req.body);
  });
}
