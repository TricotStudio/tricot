// Starting the Tricot server, in one place: `npm start` and `npm run dev`
// (src/server/index.ts) and the `tricot` command (src/cli) all call
// startServer. It never assumes a terminal or a browser: it listens, holds the
// data folder's lock, and hands back what a shell needs to show and stop it.
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { Store } from '../core/store';
import { loadToken, isLoopbackHost, tokenFile } from './access';
import { createApp } from './app';
import { Connectors } from './connectors';
import { securePrivateDir } from './dataDir';
import { takeFailure } from './handoff';
import { builtPagePolicy, devPagePolicy } from './headers';
import { acquireLock, publishLock, releaseLock } from './lock';
import { Seats } from './seats';
import { SiteServer } from './sites/siteServer';
import { startFolder } from './startFolder';
import { Updates, type UpdatesOptions } from './updates';

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
    const store = new Store(dataDir);
    store.load();
    const connectors = new Connectors({ dataDir });
    const token = isLoopbackHost(host) ? undefined : loadToken(dataDir);
    if (token) console.log(`Listening on ${host}: every request needs the access token in ${tokenFile(dataDir)}.`);
    // Live steps go in the person's own agent settings, in their home folder;
    // the folder Tricot started in is where a project's own Claude hook is looked for.
    const liveSteps = options.hooksDir ? { target: { home: os.homedir(), project: process.cwd(), env: process.env }, source: options.hooksDir, url } : undefined;
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
    const folder = startFolder(process.cwd(), os.homedir());
    // An update that didn't finish is told once, here and on the page.
    const failed = takeFailure(dataDir);
    if (failed) console.warn(`${failed.message} (${failed.log})`);
    const updates = new Updates({ check: false, ...options.updates, current: options.version ?? '0.0.0', place: { port, host, dataDir, flags: options.updates?.flags } }, failed);
    // The browsers and terminals the person let in (seats.ts), kept in the data folder.
    const seats = new Seats({ dataDir });
    const app = createApp(store, { host, mcpUrl, connectors, version: options.version, source: options.source, token, liveSteps, pagePolicy, folder, updates, sites, seats });
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
        res.sendFile(path.join(webDir, 'index.html'));
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
    });
    // Asks what's out only now, so it never holds up the start.
    updates.start();

    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        updates.stop();
        await sites?.close();
        await store.flush();
        releaseLock(dataDir);
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      })());
    return { url, mcpUrl, token, port, host, dataDir, siteFrames: sites?.frameSource, close };
  } catch (error) {
    releaseLock(dataDir);
    throw error;
  }
}
