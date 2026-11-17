// Runs the server from source, in this terminal: `npm start` and `npm run dev`
// (src/server/index.ts), and Canvas's `npm run canvas` and `npm run canvas:dev`
// (src/server/canvas.ts). The `tricot` command (src/cli) starts the same server.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { editionOf } from '../edition';
import { defaultDataPath } from '../platform/paths';
import { stopSignals } from '../platform/stop';
import { startServer } from './start';
import { sourceLink } from '../install/updates';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Tricot as it is with a part, or Canvas: the same server made of less (canvasEdition.ts), the edition chosen in src/edition.ts, serving
// the page built without a part (dist/canvas, vite.config.ts) and, in dev, Vite's own build of it.
async function main(asked: boolean): Promise<void> {
  const edition = await editionOf(asked);
  const canvas = edition.edition === 'canvas'; // Canvas is also what `npm start` runs where there is no edition with parts (src/edition.ts)
  const port = Number(process.env.PORT ?? 4545);
  const host = process.env.HOST ?? '127.0.0.1';
  const dataDir = process.env.TRICOT_DATA_DIR ?? defaultDataPath();
  const dev = process.argv.includes('--dev');
  const pkg = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { version: string; repository?: unknown };

  const server = await startServer({
    port,
    host,
    dataDir,
    version: pkg.version,
    source: sourceLink(pkg.repository),
    webDir: path.join(projectRoot, canvas ? 'dist/canvas' : 'dist/web'),
    hooksDir: path.join(projectRoot, 'hooks'),
    // This checkout's `tricot`, on the same Node with the same loader (tsx's
    // options): what a command the board hands an agent runs as.
    cli: { command: process.execPath, args: [...process.execArgv, path.join(projectRoot, 'src/cli/tricot.ts')] },
    ...edition,
    setupWeb: dev
      ? async (app, httpServer) => {
          const { createServer: createViteServer } = await import('vite');
          const vite = await createViteServer({
            configFile: path.join(projectRoot, 'vite.config.ts'),
            ...(canvas && { mode: 'canvas' }),
            server: { middlewareMode: true, hmr: { server: httpServer } },
            appType: 'spa',
          });
          app.use(vite.middlewares);
        }
      : undefined,
  });

  console.log(`${canvas ? 'Tricot Canvas' : 'Tricot'} on ${server.token ? `${server.url}/?token=${server.token}` : server.url}`);
  console.log(`MCP endpoint:      ${server.mcpUrl}`);
  if (server.token) console.log('Agents send:       Authorization: Bearer <the same token>');
  console.log(`Boards stored in:  ${dataDir}`);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  for (const signal of stopSignals()) process.on(signal, shutdown);
  void server.unused.then(shutdown); // asked to stop over HTTP (stopRoutes.ts)
}

export function runFromSource(options: { canvas?: boolean } = {}): void {
  main(options.canvas ?? false).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
