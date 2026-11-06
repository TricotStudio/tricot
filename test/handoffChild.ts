// A Tricot for handoff.test.ts to update: the real server (startServer), with
// the update options the `tricot` command gives it, except that npm, Homebrew
// and npx are stand-ins, and so is the `tricot` they install.
//
//   handoffChild.ts --pkg <dir> start --port <n> --host <h> --data <dir> --no-open --no-ask
//   handoffChild.ts --pkg <dir> --version
//   handoffChild.ts --as <version> start …       npx's stand-in: runs as that version
//
// <dir> is the installed package the stand-in npm or brew rewrites: the
// version in its package.json is the one this runs as. From the environment:
//   HANDOFF_ROOT     the package folder it says it runs from, which says how it was installed
//   HANDOFF_NPM      npm's stand-in, as JSON {command, args}
//   HANDOFF_BROKEN   a version that fails to start
//   HANDOFF_MIGRATES a version that migrates the boards to a data version newer than this code reads, then fails to start
//   HANDOFF_WEB      the built pages to serve, for screenshots
//   TRICOT_UPDATE_URL  what the registry says
//   TRICOT_RELEASES_URL  where GitHub's latest release is asked for (a stand-in)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DATABASE_FILE } from '../src/core/store/boardDb';
import { MIGRATIONS, openDatabase, type Migration } from '../src/core/store/migrations';
import type { Command } from '../src/install/handoff';
import { startServer } from '../src/server/start';
import { releasesFromEnv } from '../src/install/updates';

const here = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(here), '..');
const { values } = parseArgs({
  allowPositionals: true,
  options: {
    pkg: { type: 'string' },
    as: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    data: { type: 'string' },
    'no-open': { type: 'boolean' },
    'no-ask': { type: 'boolean' },
    'no-update-check': { type: 'boolean' },
    version: { type: 'boolean' },
  },
});

const version = values.as ?? (JSON.parse(readFileSync(path.join(values.pkg!, 'package.json'), 'utf8')) as { version: string }).version;
if (values.version) {
  console.log(version);
  process.exit(0);
}
if (process.env.HANDOFF_BROKEN === version) {
  console.error(`Tricot ${version} is broken on purpose.`);
  process.exit(3);
}
// A version whose data is newer than the one that started it: it migrates the
// boards (after the copy every migration starts with), writes in the form only
// it reads, and then fails to start.
if (process.env.HANDOFF_MIGRATES === version) {
  const newer: Migration = { name: 'what only the newer one reads', up: (db) => db.exec('CREATE TABLE from_the_newer_one (n INTEGER); INSERT INTO from_the_newer_one VALUES (1)') };
  openDatabase(path.join(values.data!, DATABASE_FILE), [...MIGRATIONS, newer]).close();
  console.error(`Tricot ${version} migrated the boards, and then failed on purpose.`);
  process.exit(3);
}

const node = (...args: string[]): Command => ({ command: process.execPath, args: ['--import', 'tsx', ...args] });
const self = node(here, ...(values.pkg ? ['--pkg', values.pkg] : ['--as', version]));
const server = await startServer({
  port: Number(values.port),
  host: values.host!,
  dataDir: values.data!,
  version,
  webDir: process.env.HANDOFF_WEB ?? path.join(values.data!, 'no-web'),
  updates: {
    root: process.env.HANDOFF_ROOT!,
    self,
    updater: node(path.join(repo, 'src/cli/tricot.ts'), '_handoff'),
    flags: values['no-update-check'] ? ['--no-update-check'] : [],
    check: !values['no-update-check'],
    url: process.env.TRICOT_UPDATE_URL,
    releases: releasesFromEnv(process.env).url,
    ...(process.env.HANDOFF_NPM && { npm: JSON.parse(process.env.HANDOFF_NPM) as Command }),
    npx: (v) => node(here, '--as', v),
  },
});
console.log(`Tricot ${version} on ${server.url}, pid ${process.pid}`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
