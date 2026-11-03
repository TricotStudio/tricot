import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { StartFolder } from '../core/firstRun';
import type { Store } from '../core/store';
import { crossSiteCheck, isLoopbackHost, originCheck, requireToken } from './access';
import { createApiRouter, peoplesCopy } from './api';
import type { Connectors } from './connectors';
import { createConnectorsRouter } from './connectors/routes';
import { securityHeaders } from './headers';
import { createLiveStepsRouter, type LiveStepsRoutesOptions } from './liveStepsRoutes';
import { createMcpServer, type McpOptions } from './mcp';
import { Presence } from './presence';
import { STEP_BODY_LIMIT, Steps } from './steps';
import { createUpdateRouter } from './updateRoutes';
import type { Updates } from './updates';

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
  },
): Express {
  const app = express();
  app.disable('x-powered-by');
  const loopback = isLoopbackHost(options.host);
  if (!loopback && !options.token) throw new Error(`Listening on ${options.host} needs an access token.`);
  // First, so every response carries them, refusals and the UI included.
  app.use(securityHeaders(options.pagePolicy));
  // Reject requests addressed to other hostnames (DNS rebinding) when local.
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
  // Large enough for MCP calls that carry base64 images.
  app.use(express.json({ limit: '15mb' }));
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
  // Connectors are app-wide, set once for every board; their sign-in callback
  // stays behind the Host check above. What they add (a Google Doc's draft
  // lives on a link block) needs the store as well.
  if (options.connectors) app.use('/api/connectors', createConnectorsRouter(options.connectors, store));
  // People turn an agent's live steps on or off; agents can't (liveStepsRoutes.ts).
  if (options.liveSteps) app.use('/api/live-steps', createLiveStepsRouter(options.liveSteps));
  // What's out, and updating to it: from the page or `tricot update` (updateRoutes.ts).
  if (options.updates) app.use('/api/update', createUpdateRouter(options.updates));
  const steps = new Steps(store, presence);
  app.use('/api', createApiRouter(store, { mcpUrl: options.mcpUrl, version: options.version, ...(options.source && { source: options.source }), ...(options.folder && { folder: options.folder }) }, presence, steps));
  mountMcp(app, store, { allowFilePaths: loopback, presence, steps, connectors: options.connectors });
  return app;
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
