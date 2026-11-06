// Makes the database fixture of one released Tricot (test/fixtures/tricot-<version>.db):
// what that release writes, to be read by this one (test/releasedData.test.ts).
//
//   node scripts/db-fixture.mjs v0.1.3
//   node scripts/db-fixture.mjs v0.1.0 --tree <folder>   a checkout you already have of it
//
// It checks the tag out in a temporary worktree outside this folder, starts
// that version from source on a temporary data folder and a free port (its
// HOME is a temporary folder too, so nothing of yours is read or written),
// makes a small board through its MCP tools, stops it, and copies the database
// it left. Nothing in ~/.tricot, and no port you use, is touched. The worktree
// and the folders are removed after.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) {
  console.error('Usage: node scripts/db-fixture.mjs v<version> [--tree <folder>]');
  process.exit(1);
}
// The dependencies the release is run on: this folder's, or the nearest above it.
function modulesAbove(dir) {
  for (let at = dir; ; at = path.dirname(at)) {
    if (existsSync(path.join(at, 'node_modules'))) return path.join(at, 'node_modules');
    if (at === path.dirname(at)) throw new Error('No node_modules: run npm install.');
  }
}
const out = path.join(repo, 'test/fixtures', `tricot-${tag.slice(1)}.db`);

const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-fixture-'));
const given = process.argv[3] === '--tree' ? path.resolve(process.argv[4]) : undefined;
const tree = given ?? path.join(scratch, 'tree');
const dataDir = path.join(scratch, 'data');
const home = path.join(scratch, 'home');
mkdirSync(home);
let server;
let client;

try {
  if (!given) git('worktree', 'add', '--detach', tree, tag);
  if (!existsSync(path.join(tree, 'node_modules'))) symlinkSync(modulesAbove(repo), path.join(tree, 'node_modules'));
  const port = await freePort();
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: tree,
    env: { ...process.env, HOME: home, USERPROFILE: home, PORT: String(port), HOST: '127.0.0.1', TRICOT_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise((resolve) => server.once('exit', resolve));
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (chunk) => /Tricot on/.test(String(chunk)) && resolve());
    server.once('exit', (code) => reject(new Error(`${tag} stopped with ${code} before it listened`)));
  });

  const base = `http://127.0.0.1:${port}`;
  client = new Client({ name: 'db-fixture', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Planner`)));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0]?.text ?? '';
    if (result.isError) throw new Error(`${name} failed: ${text}`);
    return text;
  };
  const idOf = (text) => /\[id: ([^\]]+)\]/.exec(text)?.[1] ?? assertNever(text);
  const assertNever = (text) => {
    throw new Error(`No id in: ${text}`);
  };

  await call('create_board', { title: 'Fixture board', goal: 'Check that boards from every release still read' });
  const { boards } = await (await fetch(`${base}/api/boards`)).json().then((json) => (Array.isArray(json) ? { boards: json } : json));
  const boardId = boards.find((b) => b.title === 'Fixture board').id;

  const decisionId = idOf(
    await call('post_decision', {
      board_id: boardId,
      question: 'Which store?',
      context: 'Boards need somewhere to live.',
      options: [{ label: 'SQLite', description: 'One file' }, { label: 'Files', description: 'One file a board' }],
      recommend: 'a',
      recommendation_reason: 'One file is easier to back up.',
      area: 'Storage',
      blocking: true,
      blocks: [
        { type: 'note', title: 'Why one file', text: 'Backing up is **copying a file**.', option: 'a' },
        { type: 'table', title: 'Compared', columns: ['Store', 'Backup'], rows: [['SQLite', 'one file'], ['Files', 'a folder']] },
      ],
    }),
  );
  const loggedId = idOf(
    await call('log_decision', { board_id: boardId, question: 'Name the tool?', choice: 'Tricot', alternatives: ['Yarn'], rationale: 'It is short.', area: 'Naming' }),
  );

  const noteId = idOf(await call('add_block', { board_id: boardId, type: 'note', title: 'Notes', text: 'First line\n\nSecond line' }));
  await call('add_block', { board_id: boardId, type: 'table', title: 'Table', columns: ['A', 'B'], rows: [['1', '2']] });
  await call('add_block', { board_id: boardId, type: 'diagram', title: 'Flow', source: 'flowchart LR\n  A --> B' });
  // A second version of a block: its first is kept in the versions table.
  await call('update_block', { block_id: noteId, rev: 1, text: 'First line\n\nSecond line, reworded' });

  const taskId = idOf(await call('plan_tasks', { board_id: boardId, tasks: [{ title: 'Write the importer', detail: 'Read the old files.', decision_ids: [loggedId] }] }));
  await call('add_block', { task_id: taskId, type: 'note', title: 'Steps', text: '- [x] Read\n- [ ] Write' });
  await call('comment', { task_id: taskId, body: 'Started on it.' });
  await call('pin', { block_id: noteId, text: 'reworded', decision_id: decisionId });

  await client.close();
  client = undefined;
  server.kill('SIGTERM'); // it saves, and lets go of the database, as it stops
  await exited;
  if (existsSync(path.join(dataDir, 'tricot.db-wal'))) throw new Error('The database was left with a write-ahead log: not saved whole.');
  mkdirSync(path.dirname(out), { recursive: true });
  copyFileSync(path.join(dataDir, 'tricot.db'), out);
  console.log(`Wrote ${path.relative(repo, out)}`);
} finally {
  await client?.close().catch(() => {});
  if (server && server.exitCode === null) server.kill('SIGKILL');
  if (!given) {
    try {
      git('worktree', 'remove', '--force', tree);
    } catch {
      // never added
    }
  }
  rmSync(scratch, { recursive: true, force: true });
}
