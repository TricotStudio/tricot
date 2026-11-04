import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Key, TerminalKeys } from '../src/cli/boardPicker';
import { FOLDER_BOARDS_FILE } from '../src/cli/chooseBoard';
import { runCli, type CliContext, type CliResult } from '../src/cli/main';
import { ANSWER_FILE } from '../src/cli/hooks';
import type { HostOutcome } from '../src/cli/switcher/host';
import type { AgentHost, SwitcherRun } from '../src/cli/switcher/run';
import type { AgentLaunch } from '../src/cli/terminal';
import { APPROVAL_STATUS, APPROVAL_TIMEOUT_S } from '../src/server/hooks/commandHooks';
import { claude as claudeHooks } from '../src/server/hooks/claude';
import { codex as codexHooks } from '../src/server/hooks/codex';
import { lockFile, readLock } from '../src/server/lock';
import type { RunningServer } from '../src/server/start';

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
after(() => rmSync(scratch, { recursive: true, force: true }));

describe('tricot <agent>', () => {
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
    platform?: NodeJS.Platform;
  }
  let term: ReturnType<typeof terminal> | undefined;
  const ctx = (options: Options = {}): CliContext => {
    term = options.keys ? terminal(options.keys) : undefined;
    return {
      env: { TRICOT_DATA_DIR: dataDir, PORT: String(port), HOME: home, PATH: bin, FAKE_AGENT_LOG: agentLog, ...options.env },
      root,
      entry: path.join(repo, 'src/cli/tricot.ts'),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      open: (url) => opened.push(url),
      cwd: project,
      ...(!options.noTerminal && { host }),
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
    const result = await runCli(argv, ctx(options));
    if (result.server) servers.push(result.server);
    return result;
  };
  const said = () => out.join('\n');
  // The approval hook a session of Claude Code gets, as Tricot's hooks/ in the package run it.
  const approvalHooksFor = (name: string, url: string) => ({
    PermissionRequest: [{ hooks: [{ type: 'command', command: `node "${path.join(root, 'hooks/tricot-approve.mjs')}" --name ${name} --url ${url}`, timeout: APPROVAL_TIMEOUT_S, statusMessage: APPROVAL_STATUS }] }],
  });
  // What the fake agent was started with.
  const recorded = () => {
    const lines = readFileSync(agentLog, 'utf8').split('\n');
    return {
      command: lines.find((l) => l.startsWith('command '))!.slice(8),
      args: lines.filter((l) => l.startsWith('arg ')).map((l) => l.slice(4)),
      env: lines.filter((l) => l.startsWith('env ')).map((l) => l.slice(4)),
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
    bin = path.join(here, 'bin');
    mkdirSync(bin);
    for (const agent of ['claude', 'codex', 'opencode']) writeFileSync(path.join(bin, agent), FAKE_AGENT, { mode: 0o755 });
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
        JSON.stringify({ hooks: approvalHooksFor('Claude', server.url) }),
        '--allowedTools',
        'mcp__tricot__*',
        '--mcp-config',
        JSON.stringify({ mcpServers: { tricot: { type: 'http', url: `${server.mcpUrl}?agent=Claude` } } }),
      ]);
      assert.ok(!agent.env.includes('TRICOT_TOKEN'));
      assert.equal(launches[0].cwd, project, 'in the folder the command ran in');
      assert.deepEqual(snapshot(home), before, 'no file in the home folder changed');
      assert.deepEqual(opened, []);
    });

    it('starts Codex with -c overrides, and OpenCode with its inline config, writing nothing', async () => {
      const { server, ids } = await boardWith('Roadmap');
      const before = snapshot(home);
      assert.equal((await run(['codex', '--board', ids[0], '--no-open'])).exitCode, 0, err.join('\n'));
      const message = `Use the Tricot board ${ids[0]} and start listening.`;
      assert.deepEqual(recorded().args, [
        '-c',
        `mcp_servers.tricot.url="${server.mcpUrl}?agent=Codex"`,
        '-c',
        'mcp_servers.tricot.enabled=true',
        '-c',
        'mcp_servers.tricot.default_tools_approval_mode="approve"',
        message,
      ]);
      assert.match(said(), /Starting Codex on "Roadmap"…/);
      assert.match(said(), /Codex asks for approvals in the terminal: they come to the board once its live steps are on \(tricot hooks on --agent codex\)/);

      assert.equal((await run(['opencode', '--board', ids[0], '--no-open'])).exitCode, 0, err.join('\n'));
      assert.deepEqual(recorded().args, ['--prompt', message]);
      assert.ok(recorded().env.includes('OPENCODE_CONFIG_CONTENT'));
      assert.deepEqual(JSON.parse(launches[1].env.OPENCODE_CONFIG_CONTENT!), {
        mcp: { tricot: { type: 'remote', url: `${server.mcpUrl}?agent=OpenCode`, enabled: true, timeout: 300000 } },
      });
      assert.deepEqual(snapshot(home), before, 'no file in the home folder changed');
    });

    it('passes what comes after -- to the agent, and names it with --name', async () => {
      const { server, ids } = await boardWith('Roadmap');
      const message = `Use the Tricot board ${ids[0]} and start listening.`;
      await run(['claude', '--board', ids[0], '--no-open', '--name', 'Reviewer', '--', '--model', 'opus', '--continue']);
      const config = JSON.stringify({ mcpServers: { tricot: { type: 'http', url: `${server.mcpUrl}?agent=Reviewer` } } });
      const settings = JSON.stringify({ hooks: approvalHooksFor('Reviewer', server.url) });
      assert.deepEqual(recorded().args, [message, '--model', 'opus', '--continue', '--settings', settings, '--allowedTools', 'mcp__tricot__*', '--mcp-config', config]);

      await run(['codex', '--board', ids[0], '--no-open', '--', '--model', 'o3', '--board', 'theirs']);
      assert.deepEqual(recorded().args, [
        '-c',
        `mcp_servers.tricot.url="${server.mcpUrl}?agent=Codex"`,
        '-c',
        'mcp_servers.tricot.enabled=true',
        '-c',
        'mcp_servers.tricot.default_tools_approval_mode="approve"',
        '--model',
        'o3',
        '--board',
        'theirs',
        message,
      ]);

      err.length = 0;
      assert.equal((await run(['claude', 'fix the bug'])).exitCode, 1);
      assert.match(err.join('\n'), /put them after --: tricot claude -- fix the bug/);
    });

    it("gives Claude Code Tricot's hooks for the session, leaving out what its own settings run already", async () => {
      const { server, ids } = await boardWith('Roadmap');
      const target = { home, env: {} };
      const hooksOf = () => {
        const at = recorded().args.indexOf('--settings');
        return at < 0 ? undefined : (JSON.parse(recorded().args[at + 1]) as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks;
      };
      // A yes to live steps, without the hook in its settings: steps and approvals, for this session.
      writeFileSync(path.join(dataDir, ANSWER_FILE), JSON.stringify({ answer: 'yes', at: new Date().toISOString(), how: 'asked' }));
      let before = snapshot(home);
      await run(['claude', '--board', ids[0], '--no-open']);
      assert.match(said(), /Approvals and live steps come to the board for this session\./);
      assert.deepEqual(Object.keys(hooksOf()!), ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SubagentStop', 'PermissionRequest']);
      assert.equal(hooksOf()!.PreToolUse[0].hooks[0].command, `node "${path.join(root, 'hooks/tricot-steps.mjs')}" --name Claude --url ${server.url}`);
      assert.deepEqual(snapshot(home), before, 'nothing written');

      // Set up in its own settings: nothing for the session, which would run them twice.
      claudeHooks.install(target, { url: server.url, source: path.join(repo, 'hooks') });
      before = snapshot(home);
      out.length = 0;
      await run(['claude', '--board', ids[0], '--no-open']);
      assert.equal(hooksOf(), undefined);
      assert.ok(recorded().args.includes('--allowedTools'), "Tricot's own tools still run without asking");
      assert.match(said(), /Approvals come to the board, through the hook in your Claude Code settings\./);
      assert.deepEqual(snapshot(home), before);

      // Codex: its own hooks or none, and it says which.
      codexHooks.install(target, { url: server.url, source: path.join(repo, 'hooks') });
      out.length = 0;
      await run(['codex', '--board', ids[0], '--no-open']);
      assert.match(said(), /Approvals come to the board, through the hook in your Codex settings\./);
      assert.ok(!recorded().args.some((arg) => arg.startsWith('hooks.')), 'never hooks through -c');
    });

    it('returns the agent’s exit code, and runs it in this terminal by default', async () => {
      const { ids } = await boardWith('Roadmap');
      const { exitCode } = await run(['claude', '--board', ids[0], '--no-open'], { realLaunch: true, env: { FAKE_AGENT_EXIT: '3' } });
      assert.equal(exitCode, 3);
      assert.equal(recorded().command, path.join(bin, 'claude'));
      assert.equal(launches.length, 0, 'the stand-in was not used');
    });

    it('opens the board in the browser, unless --no-open', async () => {
      const { server, ids } = await boardWith('Roadmap');
      await run(['codex', '--board', ids[0]]);
      assert.deepEqual(opened, [`${server.url}/#/b/${ids[0]}`]);
      assert.match(said(), /Opened the board "Roadmap" in your browser\./);
    });

    it("says so when there's no such board, and starts no agent", async () => {
      await boardWith('Roadmap');
      const { exitCode } = await run(['claude', '--board', 'nope', '--no-open']);
      assert.equal(exitCode, 1);
      assert.match(err.join('\n'), /There's no board "nope" on this Tricot/);
      assert.deepEqual(launches, []);
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

      assert.ok(!said().includes(token) && !err.join('\n').includes(token), 'never on screen');
      assert.deepEqual(snapshot(home), before);
    });
  });

  describe('the board', () => {
    it('is started in the background when none is running, and keeps running after the agent', async () => {
      const { server, ids } = await boardWith('Roadmap');
      await server.close();
      servers.length = 0;
      assert.equal(existsSync(lockFile(dataDir)), false);

      const { exitCode } = await run(['codex', '--board', ids[0], '--no-open']);
      assert.equal(exitCode, 0, err.join('\n'));
      const lock = readLock(dataDir)!;
      assert.notEqual(lock.pid, process.pid, 'in a process of its own');
      assert.equal(out[0], `Tricot is running at ${lock.url} (started in the background).`);
      assert.equal((await fetch(`${lock.url}/api/info`)).status, 200, 'still running');
      assert.equal(recorded().args[1], `mcp_servers.tricot.url="${lock.mcpUrl}?agent=Codex"`);
    });

    it('is reused when it is running', async () => {
      const { server, ids } = await boardWith('Roadmap');
      await run(['claude', '--board', ids[0], '--no-open']);
      assert.equal(out[0], `Tricot is running at ${server.url}.`);
      assert.equal(readLock(dataDir)!.pid, process.pid);
    });
  });

  describe('without --board', () => {
    it('picks a board in the terminal, remembers it for this folder, and highlights it next time', async () => {
      const { ids } = await boardWith('Older', 'Newer');
      const { exitCode } = await run(['claude', '--no-open'], { keys: ['down', 'return'] });
      assert.equal(exitCode, 0, err.join('\n'));
      assert.match(term!.drawn.join(''), /Which board should Claude work on\?/);
      assert.equal(recorded().args[0], `Use the Tricot board ${ids[0]} and start listening.`, 'the second listed: the older one');
      assert.match(said(), /Starting Claude Code on "Older"…/);
      const kept = JSON.parse(readFileSync(path.join(dataDir, FOLDER_BOARDS_FILE), 'utf8'));
      assert.equal(kept[project].board, ids[0], 'kept in the data folder, by the folder');
      assert.equal(existsSync(path.join(project, FOLDER_BOARDS_FILE)), false, 'nothing in the project');

      await run(['codex', '--no-open'], { keys: ['return'] });
      assert.match(term!.drawn.join(''), /Older\s+updated just now\s+· last used here/);
      assert.equal(recorded().args.at(-1), `Use the Tricot board ${ids[0]} and start listening.`, 'Enter takes the one used here last');
    });

    it("makes a new board, named after the folder unless it's changed", async () => {
      const { server } = await boardWith('Roadmap');
      const { exitCode } = await run(['claude', '--no-open'], { keys: ['up', 'return', ...[...' 2'].map((c) => ({ name: c, sequence: c })), 'return'] });
      assert.equal(exitCode, 0, err.join('\n'));
      assert.match(term!.drawn.join(''), /Name the new board: app/);
      const boards = (await (await fetch(`${server.url}/api/boards`)).json()) as { id: string; title: string }[];
      const made = boards.find((b) => b.title === 'app 2')!;
      assert.ok(made, 'the board is made');
      assert.equal(recorded().args[0], `Use the Tricot board ${made.id} and start listening.`);
      const board = (await (await fetch(`${server.url}/api/boards/${made.id}`)).json()) as { activity: { actors: { actor: { name: string } }[] } };
      assert.equal(board.activity.actors[0].actor.name, 'Sam', 'made by the person who uses these boards');
    });

    it('cancels on Esc or Ctrl+C, starting no agent', async () => {
      await boardWith('Roadmap');
      for (const key of ['escape', { name: 'c', ctrl: true }]) {
        out.length = 0;
        const { exitCode } = await run(['claude', '--no-open'], { keys: [key] });
        assert.equal(exitCode, 130);
        assert.match(said(), /Claude Code wasn't started\. Tricot keeps running/);
      }
      assert.deepEqual(launches, []);
      assert.equal(existsSync(agentLog), false);
    });

    it('stops without a terminal, and says to pass --board, before starting anything', async () => {
      const { exitCode } = await run(['claude']);
      assert.equal(exitCode, 1);
      assert.match(err.join('\n'), /Add --board <id>/);
      assert.equal(existsSync(lockFile(dataDir)), false, 'no board started');
      assert.deepEqual(launches, []);
    });
  });

  it('offers the first-run live-steps question, as tricot does, before starting the agent', async () => {
    const { ids } = await boardWith('Roadmap');
    const before = snapshot(home);
    await run(['claude', '--board', ids[0], '--no-open'], { ask: false });
    assert.deepEqual(questions, ["Show your agents' steps live on your boards? [Y/n] "]);
    assert.ok(said().indexOf('Nothing was changed') < said().indexOf('Starting Claude Code'));
    assert.deepEqual(snapshot(home), before, 'a no changes nothing');
    assert.equal(launches.length, 1);
  });

  it("says how to install an agent that isn't on PATH, and starts nothing, not even the board", async () => {
    rmSync(path.join(bin, 'claude'));
    const { exitCode } = await run(['claude', '--board', 'x']);
    assert.equal(exitCode, 1);
    assert.match(err.join('\n'), /Claude Code isn't installed here, or isn't on your PATH: Tricot looked for `claude`\./);
    assert.match(err.join('\n'), /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
    assert.match(err.join('\n'), /npm install -g @anthropic-ai\/claude-code/);
    assert.equal(existsSync(lockFile(dataDir)), false, 'no board started');
    assert.deepEqual(launches, []);
    assert.deepEqual(opened, []);
  });

  it("prints how to connect the agents it can't start yet, and starts nothing", async () => {
    for (const agent of ['gemini', 'pi', 'omp']) {
      out.length = 0;
      const { exitCode } = await run([agent]);
      assert.equal(exitCode, 1);
      assert.match(said(), new RegExp(`Tricot can't start (Gemini CLI|Pi|OMP) for you yet`));
    }
    assert.match(said(), /OMP has|\.omp\/agent\/mcp\.json/);
    assert.equal(existsSync(lockFile(dataDir)), false);
    assert.deepEqual(launches, []);
  });

  it('lists the command in --help', async () => {
    await run(['--help']);
    assert.match(said(), /tricot claude {11}Start the board, then Claude Code in this terminal/);
    assert.match(said(), /Also: tricot codex, tricot opencode/);
    assert.match(said(), /tricot claude codex {5}Start several agents on one board, in this terminal/);
    assert.match(said(), /--switch-key <key> With several agents: the key that switches \(default ctrl-\\\)/);
  });

  // `tricot claude codex`: several agents, one terminal (severalAgents.ts).
  // The stand-in host records what it would run; switcherHost.test.ts runs
  // the host itself, and switcherCli.test.ts all of it, in a terminal.
  describe('several agents', () => {
    const message = (id: string) => `Use the Tricot board ${id} and start listening.`;
    const nothingStarted = () => {
      assert.equal(existsSync(lockFile(dataDir)), false, 'no board started');
      assert.deepEqual(hosted, []);
      assert.deepEqual(launches, []);
    };

    it('starts Claude Code and Codex on one board, each exactly as alone, in this terminal, the first named showing first', async () => {
      const { server, ids } = await boardWith('Roadmap');
      const before = snapshot(home);
      const { exitCode } = await run(['claude', 'codex', '--board', ids[0], '--no-open']);
      assert.equal(exitCode, 0, err.join('\n'));
      assert.deepEqual(out, [
        `Tricot is running at ${server.url}.`,
        'Claude Code and Codex get the board for this session only; their settings stay as they are.',
        'Claude Code: approvals come to the board for this session.',
        "Codex asks for approvals in the terminal: they come to the board once its live steps are on (tricot hooks on --agent codex), as Codex can't take hooks for one session.",
        'Starting Claude Code and Codex on "Roadmap"…',
        `> ${message(ids[0])}`,
        'Ctrl+\\ switches between them, Ctrl+\\ then a number picks one, and Ctrl+\\ then q quits.',
        'Claude Code ended. Codex ended.',
        `Tricot keeps running at ${server.url}; stop it with: tricot stop`,
      ]);
      assert.equal(hosted.length, 1);
      const [run_] = hosted;
      assert.deepEqual(run_.key, { byte: 0x1c, label: 'Ctrl+\\' });
      assert.deepEqual(run_.live, { url: server.url, board: ids[0], dataDir });
      const [claude, codex] = run_.agents;
      assert.deepEqual([claude.name, codex.name], ['Claude', 'Codex'], 'each with its own name on the board');
      assert.equal(claude.command, path.join(bin, 'claude'));
      assert.equal(codex.command, path.join(bin, 'codex'));
      assert.deepEqual(claude.args, [
        message(ids[0]),
        '--settings',
        JSON.stringify({ hooks: approvalHooksFor('Claude', server.url) }),
        '--allowedTools',
        'mcp__tricot__*',
        '--mcp-config',
        JSON.stringify({ mcpServers: { tricot: { type: 'http', url: `${server.mcpUrl}?agent=Claude` } } }),
      ]);
      assert.deepEqual(codex.args, ['-c', `mcp_servers.tricot.url="${server.mcpUrl}?agent=Codex"`, '-c', 'mcp_servers.tricot.enabled=true', '-c', 'mcp_servers.tricot.default_tools_approval_mode="approve"', message(ids[0])]);
      assert.equal(claude.env.CLAUDE_CODE_NO_FLICKER, '1', "Claude Code in its full-screen renderer");
      assert.equal(codex.env.CLAUDE_CODE_NO_FLICKER, undefined);
      assert.equal(claude.env.TERM, 'xterm-256color');
      assert.equal(claude.env.HOME, home, 'the environment it would have had, and more');
      assert.equal(claude.cwd, project);
      assert.deepEqual(launches, [], 'none run on their own');
      assert.deepEqual(snapshot(home), before, 'no file in the home folder changed');
    });

    it('gives the Tricot tab the board, who answers there, and agents to add set up exactly as the others', async () => {
      const { server, ids } = await boardWith('Roadmap');
      hostOutcome = { exits: [0, 0, 0], agents: [{ name: 'Claude', id: 'claude' }, { name: 'Codex', id: 'codex' }, { name: 'OpenCode', id: 'opencode' }], quit: true };
      await run(['claude', 'codex', '--board', ids[0], '--no-open']);
      const { tricot } = hosted[0];
      assert.ok(tricot);
      assert.equal(tricot.title, 'Roadmap');
      assert.equal(tricot.actor, 'Sam', 'the person who last acted on the board');
      assert.deepEqual(tricot.choices!(['claude', 'codex']), [{ id: 'opencode', name: 'OpenCode' }], 'what Tricot can start and is not running');
      rmSync(path.join(bin, 'opencode'));
      assert.deepEqual(tricot.choices!(['claude']).map((c) => [c.id, c.note]), [
        ['codex', undefined],
        ['opencode', 'not installed'],
      ]);
      writeFileSync(path.join(bin, 'opencode'), FAKE_AGENT, { mode: 0o755 });
      const added = tricot.make!('opencode');
      assert.ok(!('problem' in added));
      assert.equal(added.name, 'OpenCode');
      assert.equal(added.command, path.join(bin, 'opencode'));
      assert.deepEqual(added.args, ['--prompt', message(ids[0])]);
      assert.equal(JSON.parse(added.env.OPENCODE_CONFIG_CONTENT!).mcp.tricot.url, `${server.mcpUrl}?agent=OpenCode`);
      assert.equal(added.env.TERM, 'xterm-256color');
      assert.equal(added.cwd, project);
      const again = tricot.make!('claude');
      assert.ok(!('problem' in again) && again.args.includes('--settings'), "Claude Code with Tricot's hooks for the session, as when named");
      assert.ok('problem' in tricot.make!('gemini'));
      tricot.open();
      assert.deepEqual(opened, [`${server.url}/#/b/${ids[0]}`], 'o opens the board, --no-open or not');
      assert.equal(out.at(-2), 'You quit. Claude Code ended. Codex ended. OpenCode ended.', 'those added are said too');
    });

    it('starts them in the order named, OpenCode too', async () => {
      const { ids } = await boardWith('Roadmap');
      hostOutcome = { exits: [0, 0, 0], quit: false };
      await run(['codex', 'opencode', 'claude', '--board', ids[0], '--no-open']);
      assert.deepEqual(hosted[0].agents.map((a) => a.name), ['Codex', 'OpenCode', 'Claude']);
      assert.ok(hosted[0].agents[1].env.OPENCODE_CONFIG_CONTENT);
      assert.match(said(), /Starting Codex, OpenCode and Claude Code on "Roadmap"…/);
    });

    it("returns the first agent's exit code other than 0, in the order named; one closed by quitting isn't a failure", async () => {
      const { ids } = await boardWith('Roadmap');
      const cases: [HostOutcome, number, string][] = [
        [{ exits: [0, 3], quit: false }, 3, 'Claude Code ended. Codex ended with exit code 3.'],
        [{ exits: [130, 127], quit: false }, 130, 'Claude Code ended with exit code 130. Codex ended with exit code 127.'],
        [{ exits: [undefined, 127], quit: true }, 127, 'You quit. Claude Code was closed. Codex ended with exit code 127.'],
        [{ exits: [undefined, undefined], quit: true }, 0, 'You quit. Claude Code was closed. Codex was closed.'],
      ];
      for (const [outcome, code, line] of cases) {
        out.length = 0;
        hostOutcome = outcome;
        assert.equal((await run(['claude', 'codex', '--board', ids[0], '--no-open'])).exitCode, code);
        assert.equal(out.at(-2), line);
        assert.match(out.at(-1)!, /^Tricot keeps running at /);
      }
    });

    it('asks which board once, for all of them', async () => {
      const { ids } = await boardWith('Older', 'Newer');
      assert.equal((await run(['claude', 'codex', '--no-open'], { keys: ['down', 'return'] })).exitCode, 0, err.join('\n'));
      assert.equal(term!.drawn.join('').split('Which board should Claude and Codex work on?').length - 1 > 0, true);
      assert.equal(hosted.length, 1);
      assert.ok(hosted[0].agents.every((a) => a.args.includes(message(ids[0]))), 'the same board for both');
    });

    it('refuses, before starting anything: an agent named twice, one that can’t start for one session, --name, words after --, no terminal, Windows', async () => {
      const refused: [string[], RegExp, Options?][] = [
        [['claude', 'claude', '--board', 'x'], /Claude Code is named twice: each agent runs once here\. Nothing was started\./],
        [['claude', 'gemini', '--board', 'x'], /Tricot can't start Gemini CLI for you yet: it adds a server only from a settings file.*connect Gemini CLI once with: tricot connect gemini Nothing was started\./],
        [['pi', 'codex', '--board', 'x'], /Tricot can't start Pi for you yet/],
        [['claude', 'codex', '--name', 'Reviewer', '--board', 'x'], /--name names one agent: with several, each has its usual name on the board \(Claude and Codex\)/],
        [['claude', 'codex', '--board', 'x', '--', '--model', 'opus'], /Words after -- go to one agent/],
        [['claude', 'codex', '--board', 'x'], /Several agents at once need a terminal/, { noTerminal: true }],
        [['claude', 'codex', '--board', 'x'], /don't work on Windows yet/, { platform: 'win32' }],
        [['claude', 'codex', '--board', 'x', '--switch-key', 'ctrl-c'], /--switch-key can't be ctrl-c: Ctrl\+C interrupts the agent/],
      ];
      for (const [argv, problem, options] of refused) {
        err.length = 0;
        assert.equal((await run(argv, options)).exitCode, 1, argv.join(' '));
        assert.match(err.join('\n'), problem);
      }
      hostProblem = "Tricot runs each agent in a terminal of its own through Perl's IO::Pty, Python 3 or the script command, and found none of them here.";
      err.length = 0;
      assert.equal((await run(['claude', 'codex', '--board', 'x'])).exitCode, 1);
      assert.match(err.join('\n'), /found none of them here\. Nothing was started\./);
      nothingStarted();
    });

    it("says how to install one that isn't on PATH, and starts none", async () => {
      rmSync(path.join(bin, 'codex'));
      assert.equal((await run(['claude', 'codex', '--board', 'x'])).exitCode, 1);
      assert.match(err.join('\n'), /Codex isn't installed here, or isn't on your PATH/);
      assert.match(err.join('\n'), /Then run tricot claude codex again\. Nothing was started\./);
      nothingStarted();
    });

    it('takes another switch key, and words that are not agents still go after --', async () => {
      const { ids } = await boardWith('Roadmap');
      await run(['claude', 'codex', '--board', ids[0], '--no-open', '--switch-key', 'ctrl-]']);
      assert.deepEqual(hosted[0].key, { byte: 0x1d, label: 'Ctrl+]' });
      assert.match(said(), /Ctrl\+\] switches between them/);
      err.length = 0;
      assert.equal((await run(['claude', 'codex', 'fix'])).exitCode, 1);
      assert.match(err.join('\n'), /put them after --: tricot claude -- codex fix/);
    });

    it('leaves one agent as it was, in this terminal, unless --switcher asks for the strip', async () => {
      const { ids } = await boardWith('Roadmap');
      await run(['claude', '--board', ids[0], '--no-open']);
      assert.equal(launches.length, 1);
      assert.equal(hosted.length, 0, 'no host for one agent');
      out.length = 0;
      hostOutcome = { exits: [0], quit: false };
      await run(['claude', '--switcher', '--board', ids[0], '--no-open', '--name', 'Reviewer', '--', '--model', 'opus']);
      assert.equal(launches.length, 1, 'not run on its own');
      assert.deepEqual(hosted[0].agents.map((a) => a.name), ['Reviewer']);
      assert.deepEqual(hosted[0].agents[0].args.slice(0, 3), [message(ids[0]), '--model', 'opus']);
      assert.ok(out.includes('Claude Code gets the board for this session only; its settings stay as they are.'));
      assert.ok(out.includes('Ctrl+\\ then q quits; the strip at the bottom says what Reviewer is doing.'));
    });
  });
});
