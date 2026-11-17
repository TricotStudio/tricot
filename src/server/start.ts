// Starting the Tricot server, in one place: `npm start` and `npm run dev`
// (src/server/index.ts) and the `tricot` command (src/cli) all call
// startServer. It never assumes a terminal or a browser: it listens, holds the
// data folder's lock, and hands back what a shell needs to show and stop it.
import { chooseFolder } from '../platform/chooseFolder';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import { Store, type StoreOptions } from '../core/store';
import { loadToken, isLoopbackHost, tokenFile } from './access';
import type { ApiParts } from './apiParts';
import { createApp } from './app';
import { Connectors } from './connectors';
import { securePrivateDir } from '../platform/dataDir';
import { takeFailure, type Command } from '../install/handoff';
import { builtPagePolicy, devPagePolicy } from './headers';
import { Leases } from './leases';
import type { ToolGroups } from './mcp/toolGroups';
import { acquireLock, publishLock, releaseLock } from '../platform/lock';
import { osHome } from '../platform/paths';
import { AgentRulesStore } from './agentRules';
import { Seats } from './seats';
import { SiteServer } from './sites/siteServer';
import { startFolder } from './startFolder';
import { CommitFiles } from './commitFiles';
import { Updates, type UpdatesOptions } from '../install/updates';

export interface StartOptions {
  port: number;
  dataDir: string;
  host?: string;
  version?: string;
  // The repository's page, from package.json (updates.ts sourceLink), for
  // the Source link at the foot of Home. None: no link.
  source?: string;
  // The built UI to serve; ignored when setupWeb is given (dev mode), which
  // serves pages whose scripts can't be known ahead (headers.ts).
  webDir: string;
  setupWeb?: (app: Express, httpServer: Server) => Promise<void>;
  // The package's hooks/ folder, which each agent's "Live steps" switch
  // copies from; none, and the switch isn't offered.
  hooksDir?: string;
  // The update check, and updating in place (updates.ts): from the `tricot`
  // command. None (`npm start`, `npm run dev`): no check, and the page is
  // told to update a checkout with git.
  updates?: UpdatesOptions;
  // Started by an agent command (tricot claude): stop when the last command
  // that needs it has quit (leases.ts). Not set: stays until stopped.
  stopWhenUnused?: boolean;
  // How long a command may be silent before it counts as gone (leases.ts); tests make it short.
  leaseGoneMs?: number;
  // How to run this Tricot's own `tricot` command: this Node, its options and
  // the command's script, from the `tricot` that starts it or `npm start`'s
  // checkout. A command the board hands an agent runs as it, so it is the
  // board's own version whatever `tricot` the agent's PATH finds.
  cli?: Command;
  // What the server is made of beyond the core, each as createApp and the Store take it (app.ts, store.ts): the
  // REST routes of the parts of Tricot (apiParts.ts), the groups of MCP tools (mcp/toolGroups.ts), the parts of the
  // Store (`storeParts`: its lists, the owners of canvases and the kinds of card, store/storePart.ts) and how the Store
  // is built (`store`, given `storeParts`: a Store with methods of its own, such as a part's). None
  // given: the core alone, a plain Store; an edition (canvasEdition.ts, a part's) gives them, and src/edition.ts
  // is the one place that chooses which.
  parts?: ApiParts;
  toolGroups?: ToolGroups;
  storeParts?: StoreOptions['parts'];
  store?: (dataDir: string, parts: StoreOptions['parts']) => Store;
  // Which Tricot this is, for the lock (what a second start on this folder is told, platform/lock.ts) and for
  // the restart after an update, which starts the same one (install/handoff.ts). canvasEdition() sets it.
  edition?: 'canvas';
}

// What an edition of Tricot gives startServer: the parts of the server and of its Store, and which Tricot it says it is.
export type Edition = Pick<StartOptions, 'parts' | 'toolGroups' | 'storeParts' | 'store' | 'edition'>;

// The Store a server is made of: the edition's, or a plain Store (scripts and tests build the same as the server does).
export function storeOf(edition: Pick<StartOptions, 'storeParts' | 'store'>, dataDir: string): Store {
  return edition.store ? edition.store(dataDir, edition.storeParts) : new Store(dataDir, { ...(edition.storeParts && { parts: edition.storeParts }) });
}

export interface RunningServer {
  url: string;
  mcpUrl: string;
  // Set when listening beyond this machine: what every request must carry.
  token?: string;
  port: number;
  host: string;
  dataDir: string;
  // What the pages' policy may frame of the board's websites
  // (sites/siteServer.ts): http://*.localhost:<port>. None on the network.
  siteFrames?: string;
  // Settles when no agent command needs this board any more, if an agent
  // command started it: the shell then closes it. Never otherwise.
  unused: Promise<void>;
  close(): Promise<void>;
}

export class PortInUseError extends Error {
  constructor(
    readonly port: number,
    host: string,
  ) {
    super(`Port ${port} on ${host} is already in use.`);
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(error.code === 'EADDRINUSE' ? new PortInUseError(port, host) : error),
    );
    server.listen(port, host, () => resolve());
  });
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const { port, dataDir, webDir } = options;
  const host = options.host ?? '127.0.0.1';
  const publicHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${publicHost}:${port}`;
  const mcpUrl = `${url}/mcp`;

  securePrivateDir(dataDir);
  // Two servers on one data folder would overwrite each other's saves.
  await acquireLock(dataDir);
  try {
    const store = storeOf(options, dataDir);
    store.load();
    const connectors = new Connectors({ dataDir });
    const token = isLoopbackHost(host) ? undefined : loadToken(dataDir);
    if (token) console.log(`Listening on ${host}: every request needs the access token in ${tokenFile(dataDir)}.`);
    // Live steps go in the person's own agent settings, in their home folder;
    // the folder Tricot started in is where a project's own Claude hook is looked for.
    const liveSteps = options.hooksDir ? { target: { home: osHome(), project: process.cwd(), env: process.env }, source: options.hooksDir, url } : undefined;
    // The board's websites are served from an address of their own on this
    // computer (sites/siteServer.ts): picked now, so the pages' policy may
    // frame it, and listened on once a page shows a website. Tricot on the
    // network serves none.
    const loopback = isLoopbackHost(host);
    const sites = loopback
      ? new SiteServer({ store, tricot: () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`], reserved: () => [port] })
      : undefined;
    await sites?.reserve();
    const frames = () => (sites?.frameSource ? [sites.frameSource] : []);
    const pagePolicy = options.setupWeb ? () => devPagePolicy(frames()) : builtPagePolicy(path.join(webDir, 'index.html'), frames);
    const folder = startFolder(process.cwd(), osHome());
    // An update that didn't finish is told once, here and on the page.
    const failed = takeFailure(dataDir);
    if (failed) console.warn(`${failed.message} (${failed.log})`);
    const updates = new Updates({ check: false, ...options.updates, current: options.version ?? '0.0.0', place: { port, host, dataDir, flags: options.updates?.flags, ...(options.stopWhenUnused && { stopWhenUnused: true }), ...(options.edition && { edition: options.edition }) } }, failed);
    // The browsers and terminals the person let in (seats.ts), kept in the data folder.
    const seats = new Seats({ dataDir });
    // The model and thinking level each agent starts on (agentRules.ts), kept in the data folder too.
    const agentRules = new AgentRulesStore({ dataDir });
    const leases = new Leases({ stopWhenUnused: options.stopWhenUnused, goneMs: options.leaseGoneMs });
    // An area's files, from the repository the board's agents were started in (commitFiles.ts).
    const commitFiles = new CommitFiles(dataDir);
    const app = createApp(store, { host, mcpUrl, connectors, version: options.version, source: options.source, token, liveSteps, pagePolicy, folder, updates, sites, seats, leases, agentRules, commitFiles, chooseFolder: () => chooseFolder(osHome()), ...(options.cli && { cli: options.cli }), ...(options.parts && { parts: options.parts }), ...(options.toolGroups && { toolGroups: options.toolGroups }) });
    const httpServer = createServer(app);
    if (options.setupWeb) {
      await options.setupWeb(app, httpServer);
    } else {
      if (!existsSync(path.join(webDir, 'index.html'))) {
        console.warn(`No built UI found in ${webDir}. Run \`npm run build\`, or use \`npm run dev\`.`);
      }
      app.use(express.static(webDir));
      app.use((req, res, next) => {
        if (req.method !== 'GET') return next();
        // With `root`, only the part of the path inside the build is checked
        // for dot folders. Whole, a path under ~/.nvm or ~/.volta is refused.
        res.sendFile('index.html', { root: path.resolve(webDir) });
      });
    }

    await listen(httpServer, port, host);

    publishLock(dataDir, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      port,
      host,
      url,
      mcpUrl,
      version: options.version,
      ...(options.stopWhenUnused && { startedBy: 'agent' as const }),
      ...(options.edition && { edition: options.edition }),
    });
    // Asks what's out only now, so it never holds up the start.
    updates.start();
    leases.start();

    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        updates.stop();
        leases.stop();
        await sites?.close();
        await store.flush();
        releaseLock(dataDir);
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      })());
    return { url, mcpUrl, token, port, host, dataDir, siteFrames: sites?.frameSource, unused: leases.unused, close };
  } catch (error) {
    releaseLock(dataDir);
    throw error;
  }
}
