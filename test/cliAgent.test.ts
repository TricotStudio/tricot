import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Key, TerminalKeys } from '../src/cli/boardPicker';
import { runCli, type CliContext, type CliResult } from '../src/cli/main';
import type { HostOutcome } from '../src/cli/switcher/host';
import type { AgentHost, SwitcherRun } from '../src/cli/switcher/run';
import type { AgentLaunch } from '../src/cli/terminal';
import { APPROVAL_STATUS, APPROVAL_TIMEOUT_S, PROMPT_TIMEOUT_S } from '../src/server/hooks/commandHooks';
import { lockFile, readLock } from '../src/platform/lock';
import type { RunningServer } from '../src/server/start';
import { removeScratch, WINDOWS } from './platform';

// `tricot claude`, `tricot codex` and `tricot opencode`: the board, then the
// agent in this terminal with the board for one session. PATH holds only fake
// agents, shell scripts that record their arguments and the names of their
// environment variables and do nothing else; HOME, the data folder and PATH
// are all made for the test under .review/. No real agent is run, and no
// real agent setting is read or written.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FAKE_AGENT = `#!/bin/sh
# A stand-in for an agent: records its arguments and the names (never the
# values) of its environment variables, then exits.
{
  printf 'command %s\\n' "$0"
  for arg in "$@"; do printf 'arg %s\\n' "$arg"; done
  export -p | while IFS= read -r line; do
    name=\${line#export }
    name=\${name#declare -x }
    name=\${name%%=*}
    case $name in ''|*[!A-Za-z0-9_]*) ;; *) printf 'env %s\\n' "$name" ;; esac
  done
} > "$FAKE_AGENT_LOG"
exit "\${FAKE_AGENT_EXIT:-0}"
`;

// The stand-ins for Pi and OMP also record what they were handed with -e while
// they run: Pi's extension file or OMP's folder with its .mcp.json, with their
// permissions and what is in them (PATH holds only the fake agents, so it uses
// the shell's own commands and /bin/ls).
const FAKE_WITH_FILES = `#!/bin/sh
{
  printf 'command %s\\n' "$0"
  for arg in "$@"; do printf 'arg %s\\n' "$arg"; done
  export -p | while IFS= read -r line; do
    name=\${line#export }
    name=\${name#declare -x }
    name=\${name%%=*}
    case $name in ''|*[!A-Za-z0-9_]*) ;; *) printf 'env %s\\n' "$name" ;; esac
  done
  if [ "$1" = "-e" ]; then
    file=$2
    folder=\${file%/*}
    if [ -d "$file" ]; then folder=$file; file=$file/.mcp.json; fi
    set -- $(/bin/ls -ld "$file")
    printf 'mode %s\\n' "$1"
    set -- $(/bin/ls -ldH "$folder")
    printf 'folder %s\\n' "$1"
    printf 'files %s\\n' "$(/bin/ls -A "$folder" | while IFS= read -r name; do printf '%s,' "$name"; done)"
    while IFS= read -r line; do printf 'ext %s\\n' "$line"; done < "$file"
  fi
} > "$FAKE_AGENT_LOG"
exit "\${FAKE_AGENT_EXIT:-0}"
`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

// Every file under a folder, with what it holds and when it last changed.
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const file = path.join(at, name);
      const stat = statSync(file);
      if (stat.isDirectory()) walk(file);
      else files[path.relative(dir, file)] = `${stat.mtimeMs} ${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
    }
  };
  walk(dir);
  return files;
}

// A terminal that types `keys` once the picker listens, and keeps what it drew.
function terminal(keys: (string | Key)[]): TerminalKeys & { drawn: string[] } {
  const queue = keys.map((key) => (typeof key === 'string' ? { name: key } : key));
  const term = {
    drawn: [] as string[],
    columns: 100,
    write: (text: string) => void term.drawn.push(text),
    listen(onKey: (key: Key) => void) {
      let stopped = false;
      const feed = () => {
        const key = queue.shift();
        if (!key || stopped) return;
        onKey(key);
        setImmediate(feed);
      };
      setImmediate(feed);
      return () => {
        stopped = true;
      };
    },
  };
  return term;
}

let scratch: string;
before(() => {
  mkdirSync(path.join(repo, '.review'), { recursive: true });
  scratch = mkdtempSync(path.join(repo, '.review', 'test-cli-agent-'));
});
after(() => removeScratch(scratch));

describe('tricot <agent>', { skip: WINDOWS && 'starts shell-script stand-ins for the agents, and uses TMPDIR' }, () => {
  let here: string;
  let home: string;
  let project: string;
  let bin: string;
  let dataDir: string;
  let root: string;
  let agentLog: string;
  let port: number;
  let out: string[];
  let err: string[];
  let opened: string[];
  let launches: AgentLaunch[];
  let questions: string[];
  const servers: RunningServer[] = [];

  // The stand-in runs the fake agent itself, without a terminal, as the real
  // one would run the real agent: the command found on PATH, with its arguments and environment.
  const launch = async (agent: AgentLaunch) => {
    launches.push(agent);
    const ran = spawnSync(agent.command, agent.args, { env: agent.env, cwd: agent.cwd, stdio: 'ignore' });
    return ran.status ?? 1;
  };
  // Several agents in this terminal (tricot claude codex): the stand-in
  // records what it would run, and ends as told.
  let hosted: SwitcherRun[];
  let hostOutcome: HostOutcome;
  let hostProblem: string | undefined;
  const host: AgentHost = {
    problem: () => hostProblem,
    run: async (run) => {
      hosted.push(run);
      return hostOutcome;
    },
  };
  interface Options {
    keys?: (string | Key)[];
    ask?: boolean;
    env?: Record<string, string>;
    realLaunch?: boolean;
    noTerminal?: boolean;
    // The terminal the strip runs in, as the stand-in host. Several agents
    // have it unless noTerminal; one agent runs on its own in most of these
    // tests, as it does without a terminal, unless this says it has it.
    terminal?: boolean;
    platform?: NodeJS.Platform;
  }
  let term: ReturnType<typeof terminal> | undefined;
  const ctx = (options: Options = {}, argv: string[] = []): CliContext => {
    const several = argv.slice(0, argv.indexOf('--') < 0 ? undefined : argv.indexOf('--')).filter((word) => ['claude', 'codex', 'opencode', 'gemini', 'pi', 'omp', 'goose', 'hermes', 'grok', 'copilot', 'cursor'].includes(word)).length > 1;
    const withHost = !options.noTerminal && (options.terminal ?? several);
    term = options.keys ? terminal(options.keys) : undefined;
    return {
      env: { TRICOT_DATA_DIR: dataDir, PORT: String(port), HOME: home, USERPROFILE: home, PATH: bin, FAKE_AGENT_LOG: agentLog, ...options.env },
      root,
      entry: path.join(repo, 'src/cli/tricot.ts'),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      open: (url) => opened.push(url),
      cwd: project,
      ...(withHost && { host }),
      ...(options.platform && { platform: options.platform }),
      ...(!options.realLaunch && { launch }),
      ...(term && { keys: term }),
      ...(options.ask !== undefined && {
        ask: async (question: string) => {
          questions.push(question);
          return options.ask!;
        },
      }),
    };
  };
  const run = async (argv: string[], options?: Options): Promise<CliResult> => {
    const result = await runCli(argv, ctx(options, argv));
    if (result.server) servers.push(result.server);
    return result;
  };
  const said = () => out.join('\n');
  // The approval and lens hooks a session of Claude Code gets, as Tricot's hooks/ in the package run them.
  const sessionHooksFor = (name: string, url: string) => ({
    PermissionRequest: [{ hooks: [{ type: 'command', command: `node "${path.join(root, 'hooks/tricot-approve.mjs')}" --name ${name} --url ${url}`, timeout: APPROVAL_TIMEOUT_S, statusMessage: APPROVAL_STATUS }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node "${path.join(root, 'hooks/tricot-prompt.mjs')}" --url ${url}`, timeout: PROMPT_TIMEOUT_S }] }],
  });
  // What the fake agent was started with.
  const recorded = () => {
    const lines = readFileSync(agentLog, 'utf8').split('\n');
    return {
      command: lines.find((l) => l.startsWith('command '))!.slice(8),
      args: lines.filter((l) => l.startsWith('arg ')).map((l) => l.slice(4)),
      env: lines.filter((l) => l.startsWith('env ')).map((l) => l.slice(4)),
      // Pi's and OMP's: what they were handed with -e while they ran, and the permissions of it and its folder.
      extension: lines.filter((l) => l.startsWith('ext ')).map((l) => l.slice(4)).join('\n'),
      mode: lines.find((l) => l.startsWith('mode '))?.slice(5),
      folderMode: lines.find((l) => l.startsWith('folder '))?.slice(7),
      files: lines.find((l) => l.startsWith('files '))?.slice(6),
    };
  };
  // A board running in this process, with boards on it, as `tricot` leaves it.
  const boardWith = async (...titles: string[]) => {
    const { server } = await run(['--no-open']);
    out.length = 0;
    const ids: string[] = [];
    for (const title of titles) {
      await new Promise((resolve) => setTimeout(resolve, 5)); // each updated after the last
      const res = await fetch(`${server!.url}/api/boards`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server!.url }, body: JSON.stringify({ actor: 'Sam', title }) });
      ids.push(((await res.json()) as { id: string }).id);
    }
    return { server: server!, ids };
  };

  beforeEach(async () => {
    here = mkdtempSync(path.join(scratch, 'run-'));
    home = path.join(here, 'home');
    project = path.join(home, 'work/app');
    mkdirSync(project, { recursive: true });
    // Each agent's own settings, with a tricot server of its own already: none may change.
    mkdirSync(path.join(home, '.claude'));
    writeFileSync(path.join(home, '.claude/settings.json'), '{"theme":"dark"}\n');
    writeFileSync(path.join(home, '.claude.json'), '{"mcpServers":{"tricot":{"type":"http","url":"http://127.0.0.1:4545/mcp"}}}\n');
    mkdirSync(path.join(home, '.codex'));
    writeFileSync(path.join(home, '.codex/config.toml'), '[mcp_servers.tricot]\nurl = "http://127.0.0.1:4545/mcp"\n');
    mkdirSync(path.join(home, '.config/opencode'), { recursive: true });
    writeFileSync(path.join(home, '.config/opencode/opencode.json'), '{"mcp":{}}\n');
    mkdirSync(path.join(home, '.omp/agent'), { recursive: true });
    writeFileSync(path.join(home, '.omp/agent/config.yml'), 'modelRoles:\n  default: anthropic/claude-haiku-5-5\n');
    writeFileSync(path.join(home, '.omp/agent/mcp.json'), '{"mcpServers":{"tricot":{"type":"http","url":"http://127.0.0.1:4545/mcp?agent=OMP"}}}\n');
    mkdirSync(path.join(home, '.pi/agent'), { recursive: true });
    writeFileSync(path.join(home, '.pi/agent/settings.json'), '{"defaultProvider":"anthropic"}\n');
    writeFileSync(path.join(home, '.pi/agent/mcp.json'), '{"mcpServers":{"tricot":{"url":"http://127.0.0.1:4545/mcp?agent=Pi"}}}\n');
    bin = path.join(here, 'bin');
    mkdirSync(bin);
    for (const agent of ['claude', 'codex', 'opencode']) writeFileSync(path.join(bin, agent), FAKE_AGENT, { mode: 0o755 });
    for (const agent of ['pi', 'omp']) writeFileSync(path.join(bin, agent), FAKE_WITH_FILES, { mode: 0o755 });
    agentLog = path.join(here, 'agent.log');
    dataDir = path.join(here, 'data');
    root = path.join(here, 'pkg');
    mkdirSync(path.join(root, 'dist/web'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{"name":"tricot","version":"9.9.9"}');
    writeFileSync(path.join(root, 'dist/web/index.html'), '<!doctype html><title>Tricot</title>');
    symlinkSync(path.join(repo, 'hooks'), path.join(root, 'hooks'));
    port = await freePort();
    out = [];
    err = [];
    opened = [];
    launches = [];
    questions = [];
    hosted = [];
    hostOutcome = { exits: [0, 0], quit: false };
    hostProblem = undefined;
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    if (readLock(dataDir)) await run(['stop']);
  });

  describe('with --board', () => {
    it('starts Claude Code on the board, connected for this session only', async () => {
      const { server, ids } = await boardWith('Roadmap');
      const before = snapshot(home);
      const { exitCode } = await run(['claude', '--board', ids[0], '--no-open']);
      assert.equal(exitCode, 0, err.join('\n'));
      assert.deepEqual(out, [
        `Tricot is running at ${server.url}.`,
        'Claude Code gets the board for this session only; its settings stay as they are.',
        'Approvals come to the board for this session.',
        'Starting Claude Code on "Roadmap"…',
        `> Use the Tricot board ${ids[0]} and start listening.`,
        `Tricot keeps running at ${server.url}; stop it with: tricot stop`,
      ]);
      const agent = recorded();
      assert.equal(agent.command, path.join(bin, 'claude'));
      assert.deepEqual(agent.args, [
        `Use the Tricot board ${ids[0]} and start listening.`,
        '--settings',
        JSON.stringify({ hooks: sessionHooksFor('Claude', server.url) }),
        '--allowedTools',
        'mcp__tricot__*',
        '--mcp-config',
        JSON.stringify({ mcpServers: { tricot: { type: 'http', url: `${server.mcpUrl}?agent=Claude&model=&effort=` } } }),
      ]);
      assert.ok(!agent.env.includes('TRICOT_TOKEN'));
      assert.equal(launches[0].cwd, project, 'in the folder the command ran in');
      assert.deepEqual(snapshot(home), before, 'no file in the home folder changed');
      assert.deepEqual(opened, []);
    });
  });

  describe('with a token, beyond this machine', () => {
    it('hands the token to the session, never to the screen or a file', async () => {
      const { server } = await run(['--no-open', '--host', '0.0.0.0']);
      const token = server!.token!;
      const res = await fetch(`${server!.url}/api/boards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: server!.url },
        body: JSON.stringify({ actor: 'Sam', title: 'Roadmap' }),
      });
      const { id } = (await res.json()) as { id: string };
      out.length = 0;
      const before = snapshot(home);

      assert.equal((await run(['claude', '--board', id])).exitCode, 0, err.join('\n'));
      assert.equal(JSON.parse(recorded().args.at(-1)!).mcpServers.tricot.headers.Authorization, `Bearer ${token}`);
      assert.equal(launches[0].env.TRICOT_TOKEN, token, "for Tricot's hooks, in its environment");
      assert.ok(recorded().args.slice(0, -1).every((arg) => !arg.includes(token)), 'in no argument but the server entry');
      assert.deepEqual(opened, [`${server!.url}/?token=${token}#/b/${id}`], 'the browser gets its cookie, as tricot opens it');

      assert.equal((await run(['codex', '--board', id, '--no-open'])).exitCode, 0, err.join('\n'));
      const codex = recorded();
      assert.ok(codex.args.includes('mcp_servers.tricot.bearer_token_env_var="TRICOT_TOKEN"'));
      assert.ok(!codex.args.join(' ').includes(token), 'not in its arguments');
      assert.ok(codex.env.includes('TRICOT_TOKEN'), 'in its environment');
      assert.equal(launches[1].env.TRICOT_TOKEN, token);

      assert.equal((await run(['pi', '--board', id, '--no-open'])).exitCode, 0, err.join('\n'));
      const pi = recorded();
      assert.ok(pi.env.includes('TRICOT_TOKEN'), 'in its environment');
      assert.equal(launches[2].env.TRICOT_TOKEN, token);
      assert.ok(!pi.args.join(' ').includes(token), 'not in its arguments');
      assert.ok(!pi.extension.includes(token), 'not in its file');
      assert.match(pi.extension, /"headers":\{"Authorization":"Bearer \$\{TRICOT_TOKEN\}"\}/, "which Pi fills in from its environment");

      assert.equal((await run(['omp', '--board', id, '--no-open'])).exitCode, 0, err.join('\n'));
      const omp = recorded();
      assert.ok(omp.env.includes('TRICOT_TOKEN'), 'in its environment');
      assert.equal(launches[3].env.TRICOT_TOKEN, token);
      assert.ok(!omp.args.join(' ').includes(token), 'not in its arguments');
      assert.ok(!omp.extension.includes(token), 'not in its file');
      assert.equal(JSON.parse(omp.extension).mcpServers.tricot.headers.Authorization, 'Bearer ${TRICOT_TOKEN}', 'which OMP fills in from its environment');

      writeFileSync(path.join(bin, 'copilot'), FAKE_AGENT, { mode: 0o755 });
      assert.equal((await run(['copilot', '--board', id, '--no-open'])).exitCode, 0, err.join('\n'));
      const copilot = recorded();
      assert.ok(copilot.env.includes('TRICOT_TOKEN'), 'in its environment');
      assert.equal(launches[4].env.TRICOT_TOKEN, token);
      assert.ok(!copilot.args.join(' ').includes(token), 'not in its arguments');
      assert.equal(JSON.parse(copilot.args[1]).mcpServers.tricot.headers.Authorization, 'Bearer ${TRICOT_TOKEN}', 'which Copilot fills in from its environment');

      assert.ok(!said().includes(token) && !err.join('\n').includes(token), 'never on screen');
      assert.deepEqual(snapshot(home), before);
    });
  });

  describe('the board', () => {
    it('is started in the background when none is running, and stops when the agent quits', async () => {
      const { server, ids } = await boardWith('Roadmap');
      await server.close();
      servers.length = 0;
      assert.equal(existsSync(lockFile(dataDir)), false);

      const { exitCode } = await run(['codex', '--board', ids[0], '--no-open']);
      assert.equal(exitCode, 0, err.join('\n'));
      assert.match(out[0], /^Tricot is running at http:\/\/127\.0\.0\.1:\d+ \(started in the background\)\.$/);
      assert.equal(out.at(-1), 'Tricot stopped, as no agent needs it now.');
      assert.equal(existsSync(lockFile(dataDir)), false, 'the board went with the agent');
      assert.match(recorded().args[1], /^mcp_servers\.tricot\.url="http:\/\/127\.0\.0\.1:\d+\/mcp\?agent=Codex&model=&effort="$/);
    });
  });
});
