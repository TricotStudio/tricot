// Proves what adding a connector, and a source of links, takes. It adds a
// throwaway "Acme" connector (a service that recognises acme.example project
// links, has a panel on the Connectors page, one REST route and one read tool)
// and a throwaway "Pinboard" source of links (pinboard.example), each only as
// its own files plus an import and an entry in each registry that lists it. It
// then checks the result end to end (types, REST, MCP, the Origin check on the
// sign-in callback, agent text, the web bundle), says exactly which files the
// change touched, and takes both out again.
//
//   npx tsx scripts/check-new-connector.ts            add them, check them, remove them
//   npx tsx scripts/check-new-connector.ts install    add them and leave them, to look at
//   npx tsx scripts/check-new-connector.ts uninstall  take them out
//
// Nothing here is loaded by the app; it is the contract's own test.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const at = (...parts: string[]) => path.join(root, ...parts);

// What the connector is: a folder on each side, and what a source of links is: a file on each.
const FOLDERS = [at('src/core/connectors/acme'), at('src/server/connectors/acme'), at('src/web/connectors/acme')];
const FILES = [at('src/core/sources/pinboard.ts'), at('src/web/canvas/sources/pinboard.tsx')];
// The registries that list them, each with how a thing is added to it: its import, and its entry in the list.
const REGISTRIES = {
  'src/core/connectors/registry.ts': { imports: "import { google } from './google';", entry: /\[google(?:, \w+)*\](?=;)/, add: ', acme]', from: "import { acme } from './acme';" },
  'src/server/connectors/registry.ts': { imports: "import { googleServer } from './google';", entry: /\[googleServer(?:, \w+)*\](?=;)/, add: ', acmeServer]', from: "import { acmeServer } from './acme';" },
  'src/web/connectors/registry.ts': { imports: "import { google } from './google';", entry: /\[google(?:, \w+)*\](?=;)/, add: ', acme]', from: "import { acme } from './acme';" },
  'src/core/sources/registry.ts': { imports: "import { loom } from './loom';", entry: /\[figma, youtube, loom, github\]/, add: ', pinboard]', from: "import { pinboard } from './pinboard';" },
  'src/web/canvas/sources/registry.ts': { imports: "import { loom } from './loom';", entry: /\[figma, youtube, loom, github\]/, add: ', pinboard]', from: "import { pinboard } from './pinboard';" },
} as const;
const SAVED = path.join(os.tmpdir(), 'tricot-check-new-connector.json'); // the registries as they were, in case a run is cut short

// ---- the sample connector -------------------------------------------------------------------------

const CORE_INDEX = `// A throwaway connector, for scripts/check-new-connector.ts: Acme, a service with projects.
// What the browser needs of it is here; what only the server uses is in server.ts.

import type { ConnectorKind } from '../connector';
import { server } from './server';
import { acmeSources } from './sources';

export const acme: ConnectorKind = {
  id: 'acme',
  name: 'Acme',
  scopes: { 'acme.read': { label: 'See your Acme projects', agent: 'Acme projects' } },
  identity: { scopes: [], email: [] },
  sources: [acmeSources],
  agent: server.agent,
};
`;

const CORE_SOURCES = `// The Acme links Tricot recognises: acme.example/projects/<id>.

import { FRAME } from '../../sources/frame';
import type { LinkSourceKind } from '../../sources/types';

export const acmeSources: LinkSourceKind = {
  id: 'acme',
  hosts: ['acme.example'],
  embeds: 'Acme projects',
  read(_url, parts) {
    const id = parts[1];
    if (parts[0] !== 'projects' || !id || !/^[a-z0-9]{2,}$/.test(id)) return null;
    return {
      kind: 'Acme',
      what: 'project',
      ref: id,
      name: \`Acme project \${id}\`,
      site: 'Acme',
      mark: 'acme',
      fileId: id,
      embed: { url: \`https://acme.example/embed/\${id}\`, sandbox: FRAME, referrer: 'no-referrer', size: { w: 500, h: 360 }, blocked: "Acme won't show this inside the board." },
    };
  },
};
`;

const CORE_SERVER = `// What only the server uses of Acme in core: what agents are told about it.

import type { ConnectorServerHalf } from '../connector';

export const server: ConnectorServerHalf = {
  agent: { summary: () => ({ shows: 'the names of Acme projects', tools: 'Acme projects: read_acme_project' }) },
};
`;

const SERVER_INDEX = `// Acme's server half: no sign-in to do (a stand-in), one REST route and one MCP tool.

import { Router } from 'express';
import { z } from 'zod';
import { describeAccess, type ConnectorStatus } from '../../../core/connectors';
import type { ConnectorTool, ServerConnector, ServerConnectorKind } from '../connector';
import { ConnectorError } from '../oauth';

class Acme implements ServerConnector {
  readonly id = 'acme';
  readonly name = 'Acme';

  status(): ConnectorStatus {
    return {
      id: 'acme',
      name: 'Acme',
      state: 'connected',
      account: { email: 'ada@acme.example', scopes: ['acme.read'], connectedAt: '2026-01-01T00:00:00.000Z' },
      access: describeAccess(['acme.read'], ['acme.read']),
    };
  }

  startSignIn(): string {
    throw new ConnectorError('Acme has nothing to sign in to here.', 400);
  }

  async finishSignIn(): Promise<ConnectorStatus> {
    throw new ConnectorError('Acme has nothing to sign in to here.', 400);
  }

  failed(): void {}

  async disconnect() {
    return { revoked: false };
  }

  routes() {
    const router = Router();
    router.get('/projects/:id', (req, res) => res.json({ name: \`Acme project \${req.params.id}\` }));
    return router;
  }

  tools(): ConnectorTool[] {
    return [
      {
        name: 'read_acme_project',
        config: { title: 'Read Acme project', description: 'Read an Acme project by its id.', inputSchema: { project_id: z.string() }, annotations: { readOnlyHint: true } },
        async run(args) {
          return { content: [{ type: 'text' as const, text: \`Acme project \${args.project_id}: three open tasks.\` }] };
        },
      },
    ];
  }
}

export const acmeServer: ServerConnectorKind = { id: 'acme', create: () => new Acme() };
`;

const WEB_INDEX = `// Acme's web half: its panel on the Connectors page, the real name of a project on a link card, and its mark.

import type { WebConnector } from '../connector';

export const acme: WebConnector = {
  id: 'acme',
  Mark: () => <span className="connector-mark" aria-hidden>A</span>,
  serves: 'Acme projects panel',
  setup: { intro: 'Acme needs nothing set up.', files: [] },
  signOutHint: 'there is nothing to remove.',
  accessNote: () => 'Read-only: it names your projects.',
  fileInfo: async (id) => ({ name: \`Acme project \${id}\` }),
  marks: { acme: { tile: '#a1c3e0', glyph: <circle cx="16" cy="16" r="6" fill="#fff" /> } },
};
`;

// ---- the sample source of links ---------------------------------------------------------------------

const PINBOARD_CORE = `// A throwaway source of links, for scripts/check-new-connector.ts: pinboard.example/b/<name>.

import { FRAME } from './frame';
import type { LinkSourceKind } from './types';

export const pinboard: LinkSourceKind = {
  id: 'pinboard',
  hosts: ['pinboard.example'],
  embeds: 'Pinboard',
  read(_url, parts) {
    if (parts[0] !== 'b' || !parts[1]) return null;
    return {
      kind: 'Pinboard',
      name: 'Pinboard board',
      site: 'Pinboard',
      mark: 'pinboard',
      embed: { url: \`https://pinboard.example/embed/\${parts[1]}\`, sandbox: FRAME, referrer: 'no-referrer', size: { w: 480, h: 320 }, blocked: "Pinboard won't show this inside the board." },
    };
  },
};
`;

const PINBOARD_WEB = `import type { WebSource } from './mark';

export const pinboard: WebSource = {
  id: 'pinboard',
  marks: { pinboard: { tile: '#b2d4f6', glyph: <rect x="10" y="10" width="12" height="12" fill="#fff" /> } },
};
`;

// ---- adding and removing them --------------------------------------------------------------------------

function sources(): Record<string, string> {
  return {
    [at('src/core/connectors/acme/index.ts')]: CORE_INDEX,
    [at('src/core/connectors/acme/sources.ts')]: CORE_SOURCES,
    [at('src/core/connectors/acme/server.ts')]: CORE_SERVER,
    [at('src/server/connectors/acme/index.ts')]: SERVER_INDEX,
    [at('src/web/connectors/acme/index.tsx')]: WEB_INDEX,
    [at('src/core/sources/pinboard.ts')]: PINBOARD_CORE,
    [at('src/web/canvas/sources/pinboard.tsx')]: PINBOARD_WEB,
  };
}

// Registers one in a registry: its import, and its entry in the list.
function registered(file: string, how: (typeof REGISTRIES)[keyof typeof REGISTRIES]): string {
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes(how.imports), `${path.relative(root, file)}: expected the import to follow`);
  const imported = text.replace(how.imports, `${how.imports}\n${how.from}`);
  const listed = imported.replace(how.entry, (match) => match.replace(/\]$/, how.add));
  assert.notEqual(listed, imported, `${path.relative(root, file)}: nothing to register in`);
  return listed;
}

function install(): void {
  if (FOLDERS.some(existsSync) || FILES.some(existsSync)) throw new Error('The samples are already installed: run uninstall.');
  const saved: Record<string, string> = {};
  for (const file of Object.keys(REGISTRIES)) saved[file] = readFileSync(at(file), 'utf8');
  writeFileSync(SAVED, JSON.stringify(saved));
  for (const [file, text] of Object.entries(sources())) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  for (const [file, how] of Object.entries(REGISTRIES)) writeFileSync(at(file), registered(at(file), how));
}

function uninstall(): void {
  for (const folder of FOLDERS) rmSync(folder, { recursive: true, force: true });
  for (const file of FILES) rmSync(file, { force: true });
  if (!existsSync(SAVED)) return;
  const saved = JSON.parse(readFileSync(SAVED, 'utf8')) as Record<string, string>;
  for (const [file, text] of Object.entries(saved)) writeFileSync(at(file), text);
  rmSync(SAVED);
}

// ---- what changed ------------------------------------------------------------------------------------------

function snapshot(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.set(path.relative(root, full), createHash('sha1').update(readFileSync(full)).digest('hex'));
    }
  };
  for (const top of ['src', 'scripts', 'test', 'vite.config.ts', 'package.json']) {
    const full = at(top);
    if (statSync(full).isDirectory()) walk(full);
    else files.set(top, createHash('sha1').update(readFileSync(full)).digest('hex'));
  }
  return files;
}

// ---- the check ---------------------------------------------------------------------------------------------

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    throw new Error(`${command} ${args.join(' ')} failed:\n${stdout ?? ''}${stderr ?? ''}`.slice(0, 3000));
  }
}

async function endToEnd(): Promise<void> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { Store } = await import('../src/core/store');
  const { createApp } = await import('../src/server/app');
  const { Connectors } = await import('../src/server/connectors');

  const dir = mkdtempSync(path.join(os.tmpdir(), 'check-connector-'));
  const store = new Store(dir);
  store.load();
  const server = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', connectors: new Connectors({ dataDir: dir }) }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new Client({ name: 'check', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Checker`)));
  const call = async (name: string, args: object) => {
    const result = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as { content: { text: string }[]; isError?: boolean };
    return { text: result.content.map((c) => c.text).join('\n'), failed: Boolean(result.isError) };
  };
  // As Tricot's page asks: what a person does is taken from it alone (access.ts asPerson).
  const rest = async (method: string, route: string, body?: object, headers: Record<string, string> = {}) => {
    const page: Record<string, string> = method === 'GET' ? { 'Sec-Fetch-Site': 'same-origin' } : { Origin: base };
    const res = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...page, ...headers }, body: body && JSON.stringify(body) });
    const text = await res.text();
    let json: any = {};
    try {
      json = JSON.parse(text);
    } catch {
      // a page, not JSON
    }
    return { status: res.status, json, text };
  };
  const done: string[] = [];
  const ok = (what: string) => done.push(what);

  // what agents are told: its tool is listed, in its own words; the connectors line names it
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === 'read_acme_project');
  assert.ok(tool, 'tools/list has the connector\'s tool');
  assert.equal(tool!.description, 'Read an Acme project by its id.');
  assert.ok(tools.findIndex((t) => t.name === 'read_acme_project') > tools.findIndex((t) => t.name === 'restore_item'), 'after the board\'s own tools');
  assert.match((await call('list_boards', {})).text, /Connectors \(app-wide\): Acme, connected as ada@acme\.example \(Acme projects\)\. People's link cards show the names of Acme projects; Acme projects: read_acme_project\./);
  ok('tools/list lists its tool; list_boards says it is connected and what agents can do with it');

  // a tool call goes through the same wrapper as the board's own
  const board = (await call('create_board', { title: 'Acme' })).text.match(/\[id: ([^\]]+)\]/)![1];
  assert.equal((await call('read_acme_project', { project_id: 'p42' })).text, 'Acme project p42: three open tasks.');
  assert.equal((await call('read_acme_project', {})).failed, true);
  ok('MCP: its read tool runs, and its arguments are checked');

  // its links are recognised, and open in place; so is the sample source's
  const added = await call('add_block', { board_id: board, type: 'link', title: 'Roadmap', url: 'https://acme.example/projects/p42' });
  const id = added.text.match(/\[id: ([^\]]+)\]/)![1];
  assert.match((await call('get_block', { block_id: id })).text, /\(Acme project\) → https:\/\/acme\.example\/projects\/p42/);
  assert.equal((await rest('POST', `/api/canvas/blocks/${id}`, { actor: 'Sam', open: true })).status, 200); // people open links in place
  assert.match((await call('get_block', { block_id: id })).text, /\(Acme project, open in place\)/);
  const pin = await call('add_block', { board_id: board, type: 'link', url: 'https://pinboard.example/b/team' });
  assert.match((await call('get_block', { block_id: pin.text.match(/\[id: ([^\]]+)\]/)![1] })).text, /\(Pinboard\) → https:\/\/pinboard\.example\/b\/team/);
  const plain = await call('add_block', { board_id: board, type: 'link', url: 'https://example.com/x' });
  const refused = await rest('POST', `/api/canvas/blocks/${plain.text.match(/\[id: ([^\]]+)\]/)![1]}`, { actor: 'Sam', open: true });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /only links to Google Docs, Sheets and Slides, Acme projects, Figma, YouTube, Loom and Pinboard do\./);
  ok('links are recognised from the address; both open in place; the refusal names them among the rest');

  // its REST route and its place among the connectors
  assert.deepEqual((await rest('GET', '/api/connectors/acme/projects/p42')).json, { name: 'Acme project p42' });
  const listed = (await rest('GET', '/api/connectors')).json as { id: string; state: string }[];
  assert.deepEqual(listed.map((c) => [c.id, c.state]), [['google', 'not_set_up'], ['figma', 'ready'], ['github', 'ready'], ['acme', 'connected']]);
  assert.equal((await rest('POST', '/api/connectors/acme/start', {})).status, 400);
  assert.equal((await rest('POST', '/api/connectors/acme/start', { permissions: ['x'] })).status, 400);
  assert.equal((await rest('POST', '/api/connectors/nope/start', {})).status, 404);
  ok('REST: its route, its status among the connectors, and the sign-in steps refuse it in its own words');

  // the Origin check lets a service's sign-in come back to its callback, and nothing else from another site
  const callback = await rest('GET', '/api/connectors/acme/callback?error=access_denied', undefined, { Origin: 'https://evil.example' });
  assert.notEqual(callback.status, 403, 'the callback is let through');
  assert.equal((await rest('POST', '/api/connectors/acme/disconnect', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await rest('GET', '/api/connectors/acme/projects/p42', undefined, { Origin: 'https://evil.example' })).status, 403);
  ok('the Origin check exempts its sign-in callback (from the contract), and still refuses everything else from another site');

  await client.close();
  server.closeAllConnections();
  server.close();
  await store.flush();
  rmSync(dir, { recursive: true, force: true });
  console.log(done.map((line) => `  ok  ${line}`).join('\n'));
}

async function check(): Promise<void> {
  const before = snapshot();
  install();
  try {
    const after = snapshot();
    const added = [...after.keys()].filter((f) => !before.has(f)).sort();
    const changed = [...after.keys()].filter((f) => before.has(f) && before.get(f) !== after.get(f)).sort();
    console.log(`Added the sample connector and the sample source of links.\n  new files (${added.length}):\n${added.map((f) => `    ${f}`).join('\n')}\n  existing files changed (${changed.length}): ${changed.join(', ')}`);
    assert.deepEqual(changed, Object.keys(REGISTRIES).sort(), 'only the registries changed');
    const saved = JSON.parse(readFileSync(SAVED, 'utf8')) as Record<string, string>;
    for (const file of Object.keys(REGISTRIES)) {
      const gained = readFileSync(at(file), 'utf8').split('\n').length - saved[file].split('\n').length;
      assert.equal(gained, 1, `${file} gained one line, its import (the entry is in an existing line)`);
    }
    console.log('  ok  each registry gained its import and one entry in its list; nothing else existing changed');
    console.log('  typecheck...');
    run('npx', ['tsc', '--noEmit']);
    console.log('  ok  both compile against the contracts (core, server and web halves)');
    console.log('  end to end...');
    process.stdout.write(run('npx', ['tsx', 'scripts/check-new-connector.ts', 'e2e']));
    console.log('  web bundle...');
    const out = mkdtempSync(path.join(os.tmpdir(), 'check-connector-web-'));
    run('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir']);
    for (const text of ['Acme projects panel', '#a1c3e0', '#b2d4f6', 'https://acme.example/embed/', 'https://pinboard.example/embed/']) {
      assert.ok(run('grep', ['-rl', text, path.join(out, 'assets')]).trim(), `the web bundle carries ${text}`);
    }
    for (const text of ['the names of Acme projects', 'read_acme_project', 'three open tasks']) {
      assert.throws(() => run('grep', ['-rl', text, path.join(out, 'assets')]), `the web bundle leaves out ${text}`);
    }
    rmSync(out, { recursive: true, force: true });
    console.log('  ok  the web bundle carries its panel, marks and recognisers, and leaves its server half, its tool and its agent text out');
  } finally {
    uninstall();
    console.log('Took the samples out again.');
  }
  const final = snapshot();
  assert.deepEqual([...final.entries()].sort(), [...before.entries()].sort(), 'the tree is as it was');
}

const mode = process.argv[2] ?? 'check';
if (mode === 'install') install();
else if (mode === 'uninstall') uninstall();
else if (mode === 'e2e') await endToEnd();
else await check();
