// `npm start` and `npm run dev`: run the server from source, in this terminal.
// The `tricot` command (src/cli) starts the same server.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDir } from './dataDir';
import { startServer } from './start';
import { sourceLink } from './updates';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 4545);
  const host = process.env.HOST ?? '127.0.0.1';
  const dataDir = process.env.TRICOT_DATA_DIR ?? defaultDataDir();
  const dev = process.argv.includes('--dev');
  const pkg = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { version: string; repository?: unknown };

  const server = await startServer({
    port,
    host,
    dataDir,
    version: pkg.version,
    source: sourceLink(pkg.repository),
    webDir: path.join(projectRoot, 'dist/web'),
    hooksDir: path.join(projectRoot, 'hooks'),
    setupWeb: dev
      ? async (app, httpServer) => {
          const { createServer: createViteServer } = await import('vite');
          const vite = await createViteServer({
            configFile: path.join(projectRoot, 'vite.config.ts'),
            server: { middlewareMode: true, hmr: { server: httpServer } },
            appType: 'spa',
          });
          app.use(vite.middlewares);
        }
      : undefined,
  });

  console.log(`Tricot on ${server.token ? `${server.url}/?token=${server.token}` : server.url}`);
  console.log(`MCP endpoint:      ${server.mcpUrl}`);
  if (server.token) console.log('Agents send:       Authorization: Bearer <the same token>');
  console.log(`Boards stored in:  ${dataDir}`);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
