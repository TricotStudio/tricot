// Proves what adding an agent takes. It adds a throwaway "Acme Code" agent: a
// folder (core/agents/acme, with its index.ts and its server.ts holding its
// start for one session, its live-steps installer and what `tricot connect`
// says) and an import and an entry in the registry, and nothing else. It then
// checks the result end to end (types, `tricot` help and its unknown-command
// hint, `tricot acme`, `tricot connect`, the Connect panel's data, first run,
// usage, the live-steps installers, the web bundle), says exactly which files
// the change touched, and takes the agent out again, even when a check fails.
//
//   npx tsx scripts/check-new-agent.ts            add it, check it, remove it
//   npx tsx scripts/check-new-agent.ts install    add it and leave it, to look at
//   npx tsx scripts/check-new-agent.ts uninstall  take it out
//
// Nothing here is loaded by the app; it is the contract's own test. The
// checks that run Tricot's code use a temporary home and data folder.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const at = (...parts: string[]) => path.join(root, ...parts);

const FOLDER = at('src/core/agents/acme');
const REGISTRY = 'src/core/agents/registry.ts';
const SAVED = path.join(os.tmpdir(), 'tricot-check-new-agent.json'); // the registry as it was, in case a run is cut short

// What the registry takes to list an agent: its import, and its entry in the list.
const REGISTER = { imports: "import { claude } from './claude';", entry: /\[claude(?:, \w+)*\](?=;)/, add: ', acme]', from: "import { acme } from './acme';" } as const;

// The words only the server half holds: the web bundle must leave them out.
const SERVER_ONLY = 'acme-sample-session-flag';

// ---- the sample agent: everything it has is in these two files -------------------------------------

const INDEX = `// A throwaway agent, for scripts/check-new-agent.ts: Acme Code.
// What the page needs of it is here; what only the command and the server use is in server.ts.

import { shellCommand } from '../../connect';
import type { AgentKind } from '../agent';
import { server } from './server';

export const acme: AgentKind = {
  id: 'acme',
  name: 'Acme Code',
  boardName: 'Acme',
  command: 'acme-code',
  install: { commands: ['npm install -g acme-code'], windows: ['winget install Acme.Code'], more: 'https://acme.example/docs' },
  connect: {
    how: 'command',
    words: (url) => ['acme-code', 'mcp', 'add', 'tricot', url],
    lines: (url) => [shellCommand(['acme-code', 'mcp', 'add', 'tricot', url])],
    settings: '~/.acme/mcp.json',
    readsToken: false,
    remove: ['acme-code', 'mcp', 'remove', 'tricot'],
    list: 'acme-code mcp list',
  },
  panel: { intro: ['Run once in a terminal; Acme Code then has the board in every session.'], note: ['It shows on the board as “Acme”.'] },
  usage: { shares: 'tokens', source: 'acme' },

  ...server,
};
`;

const SERVER = `// What only the command and the server use of Acme Code: how it starts for one
// session, its live-steps installer (an extension, written here as the spec
// the installer takes), what \`tricot connect acme\` says.

import path from 'node:path';
import { extensionHookInstaller } from '../../../server/hooks/extensionHooks';
import type { AgentServerHalf } from '../agent';

export const server: AgentServerHalf = {
  hooks: extensionHookInstaller({
    id: 'acme',
    name: 'Acme Code',
    agentName: 'Acme',
    command: 'acme-code',
    folder: (target) => path.join(target.home, '.acme'),
    extensions: (target) => path.join(target.home, '.acme', 'extensions'),
    notes: ['It runs inside Acme Code.'],
    pickedUp: 'Acme Code loads it in its next session.',
  }),
  // Its client gives up on a call after 2 minutes, whatever progress comes.
  mcpClient: { clientName: 'acme-code', callLimitSeconds: 120 },
  session: ({ url, message, passthrough }) => ({ args: ['--flag', '${SERVER_ONLY}', '--board-url', url, ...passthrough, message], env: {} }),
  show({ out, url }) {
    out('Run once; Acme Code then has the board in every session:');
    out(\`  acme-code mcp add tricot \${url}\`);
  },
};
`;

// ---- adding and removing it ---------------------------------------------------------------------------

function registered(text: string): string {
  assert.ok(text.includes(REGISTER.imports), `${REGISTRY}: expected the import to follow`);
  const imported = text.replace(REGISTER.imports, `${REGISTER.imports}\n${REGISTER.from}`);
  const listed = imported.replace(REGISTER.entry, (match) => match.replace(/\]$/, REGISTER.add));
  assert.notEqual(listed, imported, `${REGISTRY}: nothing to register in`);
  return listed;
}

function install(): void {
  if (existsSync(FOLDER)) throw new Error('The sample is already installed: run uninstall.');
  const before = readFileSync(at(REGISTRY), 'utf8');
  writeFileSync(SAVED, JSON.stringify({ [REGISTRY]: before }));
  mkdirSync(FOLDER, { recursive: true });
  writeFileSync(path.join(FOLDER, 'index.ts'), INDEX);
  writeFileSync(path.join(FOLDER, 'server.ts'), SERVER);
  writeFileSync(at(REGISTRY), registered(before));
}

function uninstall(): void {
  rmSync(FOLDER, { recursive: true, force: true });
  if (!existsSync(SAVED)) return;
  const saved = JSON.parse(readFileSync(SAVED, 'utf8')) as Record<string, string>;
  for (const [file, text] of Object.entries(saved)) writeFileSync(at(file), text);
  rmSync(SAVED);
}

// ---- what changed ---------------------------------------------------------------------------------------

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

// ---- the check -------------------------------------------------------------------------------------------

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    throw new Error(`${command} ${args.join(' ')} failed:\n${stdout ?? ''}${stderr ?? ''}`.slice(0, 3000));
  }
}

// `tricot <args>` as a person runs it, on a temporary home and data folder, with
// nothing but the system's own folders on PATH (so Acme Code is not installed).
function tricot(home: string, args: string[]): { output: string; exitCode: number | null } {
  const result = spawnSync('npx', ['tsx', 'src/cli/tricot.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, TRICOT_DATA_DIR: path.join(home, 'data'), PATH: `/usr/bin:/bin:${path.dirname(process.execPath)}`, NO_COLOR: '1' },
  });
  return { output: `${result.stdout}${result.stderr}`, exitCode: result.status };
}

async function endToEnd(): Promise<void> {
  const home = mkdtempSync(path.join(os.tmpdir(), 'check-agent-'));
  const done: string[] = [];
  const ok = (what: string) => done.push(what);
  try {
    // the registry, and what reads it
    const { agentKinds, findAgent, panelTexts, agentsInCliOrder, installHints } = await import('../src/core/agents/registry');
    assert.deepEqual(agentKinds().map((kind) => kind.id), ['claude', 'codex', 'pi', 'omp', 'gemini', 'opencode', 'acme']);
    assert.equal(agentsInCliOrder().at(-1)?.id, 'acme', 'one without a place in the CLI order comes last');
    ok('the registry lists it, after the others');

    // CLI help, and the commands `tricot` knows
    const { commandHelp, isKnownCommand, mainHelp, unknownCommand } = await import('../src/cli/help');
    const { AGENTS, isAgentCommand } = await import('../src/cli/agentCommand');
    assert.ok(isKnownCommand('acme') && isAgentCommand('acme'));
    assert.match(commandHelp('acme')!, /^tricot acme: start the board and Acme Code together, in this terminal/);
    const main = mainHelp('1.0.0').replace(/\s+/g, ' '); // as wrapped, in one line
    assert.match(main, /Also codex, opencode, pi, omp and acme; several at once: tricot claude codex/);
    assert.match(main, /Connect claude, codex, pi, gemini or acme: shows its own command/, 'acme runs a command of its own, so `tricot connect` runs it');
    assert.equal(unknownCommand('acmee'), 'Unknown command "acmee". Did you mean "acme"?');
    assert.ok(AGENTS.acme.session);
    ok('CLI help: its command, the list of those that start, and the closest-command hint');

    // `tricot acme`: not installed here, so it says how to get it, and starts nothing
    const started = tricot(home, ['acme', '--board', 'x']);
    assert.equal(started.exitCode, 1);
    assert.match(started.output, /Acme Code isn't installed here, or isn't on your PATH: Tricot looked for `acme-code`/);
    assert.match(started.output, /Install it with:\n {2}npm install -g acme-code/);
    assert.match(started.output, /More ways: https:\/\/acme\.example\/docs/);
    assert.match(started.output, /Nothing was started\./);
    assert.deepEqual(installHints(findAgent('acme')!, true), { commands: ['winget install Acme.Code'], more: 'https://acme.example/docs' }, 'Windows has its own hints when it has them');
    assert.deepEqual(installHints(findAgent('acme')!, false), { commands: ['npm install -g acme-code'], more: 'https://acme.example/docs' });
    ok('`tricot acme` and the system-by-system install hints');

    // `tricot connect`
    const connected = tricot(home, ['connect', 'acme', '--print', '--port', '4999']);
    assert.equal(connected.exitCode, 0);
    assert.match(connected.output, /Run once; Acme Code then has the board in every session:\n {2}acme-code mcp add tricot "?http:\/\/127\.0\.0\.1:4999\/mcp\?agent=Acme"?/);
    const overview = tricot(home, ['connect', '--port', '4999']).output;
    assert.match(overview, /^ {2}acme-code mcp add tricot /m);
    assert.match(overview, /To have Tricot run one of these for you, after asking: tricot connect claude \(or codex, pi, gemini, acme\)\./);
    assert.match(tricot(home, ['connect', 'nope']).output, /Unknown agent "nope"\. Try: claude, codex, pi, omp, gemini, opencode, acme, mcp-json, url\./);
    ok('`tricot connect`: its --print, the overview, the list of names');

    // the Connect panel's data
    const texts = panelTexts('http://127.0.0.1:4545/mcp');
    assert.equal(texts.acme, 'acme-code mcp add tricot "http://127.0.0.1:4545/mcp?agent=Acme"');
    assert.equal(texts.other, 'http://127.0.0.1:4545/mcp');
    assert.deepEqual(findAgent('acme')!.panel.intro, ['Run once in a terminal; Acme Code then has the board in every session.']);
    ok('the Connect panel: its tab, its words and the command to copy');

    // first run
    const { agentToConnect, connectWords } = await import('../src/core/firstRun');
    const step = agentToConnect([{ id: 'acme', name: 'Acme Code', found: true }]);
    assert.deepEqual(step, { tool: 'acme', name: 'Acme Code', found: true });
    assert.equal(connectWords(step), 'Acme Code is on this computer: run this once in a terminal, then start a new Acme Code session.');
    ok('first run: it is offered when found, with its command');

    // usage
    const usage = await import('../src/core/usage');
    assert.ok(usage.USAGE_SOURCES.includes('acme'));
    assert.equal(usage.sharesOf('acme'), 'tokens');
    assert.equal(usage.toolOfSource('acme'), 'acme');
    assert.equal(usage.notSharedLine('acme', 'Acme Code'), 'Acme Code shares tokens and cost, not plan limits.');
    ok('usage: its source is accepted, and what it shares is said');

    // live steps: its installer is in the list, and sets up and takes out its files in a temporary home
    const { findHookInstaller, hookInstallers } = await import('../src/server/hooks');
    assert.equal(hookInstallers().at(-1)?.id, 'acme');
    const installer = findHookInstaller('acme')!;
    const target = { home, env: {} };
    assert.equal(installer.detect(target).found, false);
    const setup = { url: 'http://127.0.0.1:4545', source: at('hooks') };
    assert.equal(installer.install(target, setup).changed, true);
    assert.equal(installer.status(target).state, 'on');
    assert.equal(installer.detect(target).found, true);
    assert.equal(installer.uninstall(target).changed, true);
    assert.equal(installer.status(target).state, 'off');
    ok('live steps: its installer is listed, and sets up and removes its files');

    // how long one wait lasts for it: inside its client's own limit on a call
    const { longestWait, CLIENT_LIMIT_MARGIN_SECONDS } = await import('../src/server/mcp/session');
    assert.equal(longestWait('acme-code'), 120 - CLIENT_LIMIT_MARGIN_SECONDS);
    ok('a wait ends inside its client\'s limit on one call, known by the name its client gives');

    console.log(done.map((line) => `  ok  ${line}`).join('\n'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function check(): Promise<void> {
  const before = snapshot();
  install();
  try {
    const after = snapshot();
    const added = [...after.keys()].filter((f) => !before.has(f)).sort();
    const changed = [...after.keys()].filter((f) => before.has(f) && before.get(f) !== after.get(f)).sort();
    console.log(`Added the sample agent.\n  new files (${added.length}):\n${added.map((f) => `    ${f}`).join('\n')}\n  existing files changed (${changed.length}): ${changed.join(', ')}`);
    assert.equal(added.length, 2, 'two new files: the agent and its server half');
    assert.deepEqual(changed, [REGISTRY], 'only the registry changed');
    const saved = JSON.parse(readFileSync(SAVED, 'utf8')) as Record<string, string>;
    const gained = readFileSync(at(REGISTRY), 'utf8').split('\n').length - saved[REGISTRY].split('\n').length;
    assert.equal(gained, 1, `${REGISTRY} gained one line, its import (the entry is in an existing line)`);
    console.log('  ok  the registry gained its import and one entry in its list; nothing else existing changed');
    console.log('  typecheck...');
    run('npx', ['tsc', '--noEmit']);
    console.log('  ok  it compiles against the contract (index and server halves)');
    console.log('  end to end...');
    process.stdout.write(run('npx', ['tsx', 'scripts/check-new-agent.ts', 'e2e']));
    console.log('  web bundle...');
    const out = mkdtempSync(path.join(os.tmpdir(), 'check-agent-web-'));
    try {
      run('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir']);
      for (const text of ['Acme Code then has the board in every session', 'winget install Acme.Code']) {
        assert.ok(run('grep', ['-rl', text, path.join(out, 'assets')]).trim(), `the web bundle carries ${text}`);
      }
      assert.throws(() => run('grep', ['-rl', SERVER_ONLY, path.join(out, 'assets')]), 'the web bundle leaves out its server half');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    console.log('  ok  the web bundle carries its tab and its words, and leaves its server half out');
  } finally {
    uninstall();
    console.log('Took the sample out again.');
  }
  const final = snapshot();
  assert.deepEqual([...final.entries()].sort(), [...before.entries()].sort(), 'the tree is as it was');
}

const mode = process.argv[2] ?? 'check';
if (mode === 'install') install();
else if (mode === 'uninstall') uninstall();
else if (mode === 'e2e') await endToEnd();
else await check();
