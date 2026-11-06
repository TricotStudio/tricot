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
import { renderTab } from '../src/cli/switcher/tabView';
import { runCli, type CliContext, type CliResult } from '../src/cli/main';
import { ANSWER_FILE } from '../src/cli/hooks';
import type { HostOutcome } from '../src/cli/switcher/host';
import type { AgentHost, SwitcherRun } from '../src/cli/switcher/run';
import type { AgentLaunch } from '../src/cli/terminal';
import { APPROVAL_STATUS, APPROVAL_TIMEOUT_S } from '../src/server/hooks/commandHooks';
import { claude as claudeHooks } from '../src/server/hooks/claude';
import { codex as codexHooks } from '../src/server/hooks/codex';
import { lockFile, readLock } from '../src/platform/lock';
import type { RunningServer } from '../src/server/start';
import { WINDOWS } from './platform';

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
after(() => rmSync(scratch, { recursive: true, force: true }));

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
    const several = argv.slice(0, argv.indexOf('--') < 0 ? undefined : argv.indexOf('--')).filter((word) => ['claude', 'codex', 'opencode', 'gemini', 'pi', 'omp'].includes(word)).length > 1;
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
      assert.match(said(), /Codex asks for approvals in the terminal: they come to the board once its live steps are on \(tricot steps on --agent codex\)/);

      assert.equal((await run(['opencode', '--board', ids[0], '--no-open'])).exitCode, 0, err.join('\n'));
      assert.deepEqual(recorded().args, ['--prompt', message]);
      assert.ok(recorded().env.includes('OPENCODE_CONFIG_CONTENT'));
      assert.deepEqual(JSON.parse(launches[1].env.OPENCODE_CONFIG_CONTENT!), {
        mcp: { tricot: { type: 'remote', url: `${server.mcpUrl}?agent=OpenCode`, enabled: true, timeout: 300000 } },
      });
      assert.deepEqual(snapshot(home), before, 'no file in the home folder changed');
    });

    it("starts Pi with an extension for the session, in a folder made for it and gone after, writing nothing of Pi's", async () => {
      const { server, ids } = await boardWith('Roadmap');
      const before = snapshot(home);
      const { exitCode } = await run(['pi', '--board', ids[0], '--no-open']);
      assert.equal(exitCode, 0, err.join('\n'));
      assert.deepEqual(out, [
        `Tricot is running at ${server.url}.`,
        'Pi gets the board for this session only; its settings stay as they are.',
        'Starting Pi on "Roadmap"…',
        `> Use the Tricot board ${ids[0]} and start listening.`,
        `Tricot keeps running at ${server.url}; stop it with: tricot stop`,
      ]);
      const pi = recorded();
      assert.equal(pi.command, path.join(bin, 'pi'));
      assert.deepEqual([pi.args[0], pi.args.slice(2)], ['-e', [`Use the Tricot board ${ids[0]} and start listening.`]]);
      const file = pi.args[1];
      assert.equal(path.basename(file), 'tricot.js');
      assert.equal(pi.mode?.slice(0, 10), '-rw-------', "its file, while Pi ran: this account's alone");
      assert.equal(pi.folderMode?.slice(0, 10), 'drwx------', 'and its folder');
      assert.match(pi.extension, new RegExp(`pi\\.registerMcpServer\\("tricot", \\{"url":"${server.mcpUrl.replaceAll('/', '\\/').replaceAll('.', '\\.')}\\?agent=Pi","timeout":300\\}\\)`));
      assert.ok(!pi.env.includes('TRICOT_TOKEN'));
      assert.equal(existsSync(path.dirname(file)), false, 'the folder is gone once Pi ended');
      assert.equal(launches[0].cwd, project);
      assert.deepEqual(snapshot(home), before, "no file in the home folder changed, ~/.pi's included, its own tricot entry too");
    });

    it("starts OMP with an extension folder for the session that holds the board's entry, and writes nothing of OMP's", async () => {
      const { server, ids } = await boardWith('Roadmap');
      const before = snapshot(home);
      const { exitCode } = await run(['omp', '--board', ids[0], '--no-open']);
      assert.equal(exitCode, 0, err.join('\n'));
      assert.deepEqual(out, [
        `Tricot is running at ${server.url}.`,
        'OMP gets the board for this session only; its settings stay as they are.',
        'Starting OMP on "Roadmap"…',
        `> Use the Tricot board ${ids[0]} and start listening.`,
        `Tricot keeps running at ${server.url}; stop it with: tricot stop`,
      ]);
      const omp = recorded();
      assert.equal(omp.command, path.join(bin, 'omp'));
      assert.deepEqual([omp.args[0], omp.args.slice(2)], ['-e', [`Use the Tricot board ${ids[0]} and start listening.`]]);
      const folder = omp.args[1];
      assert.equal(omp.folderMode?.slice(0, 10), 'drwx------', "its folder, while OMP ran: this account's alone");
      assert.equal(omp.mode?.slice(0, 10), '-rw-------');
      assert.equal(omp.files, '.mcp.json,', 'and nothing else in it');
      assert.deepEqual(JSON.parse(omp.extension), { mcpServers: { tricot: { type: 'http', url: `${server.mcpUrl}?agent=OMP`, timeout: 300000 } } });
      assert.ok(!omp.env.includes('TRICOT_TOKEN'));
      assert.equal(existsSync(folder), false, 'the folder is gone once OMP ended');
      assert.deepEqual(snapshot(home), before, "no file in the home folder changed, ~/.omp's included, its own tricot entry too");
    });

    it("says so when the folder for Pi's session can't be made, and starts nothing", async () => {
      const { ids } = await boardWith('Roadmap');
      const tmp = process.env.TMPDIR;
      process.env.TMPDIR = path.join(here, 'no-such-folder');
      try {
        assert.equal((await run(['pi', '--board', ids[0], '--no-open'])).exitCode, 1);
        assert.equal(err.join('\n'), "Pi didn't start: Tricot couldn't make a folder for the session (ENOENT).", 'plain words: no path, no raw error');
        assert.deepEqual(launches, []);
        err.length = 0;
        assert.equal((await run(['pi', 'codex', '--board', ids[0], '--no-open'])).exitCode, 1);
        assert.equal(err.join('\n'), "Pi and Codex didn't start: Tricot couldn't make a folder for the session (ENOENT).");
        assert.deepEqual(hosted, []);
      } finally {
        if (tmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = tmp;
      }
    });

    it("tells the Tricot tab in a few plain words when the folder for Pi's session can't be made, whole at 50 columns and at 80", async () => {
      const { server, ids } = await boardWith('Roadmap');
      hostOutcome = { exits: [0, 0], quit: false };
      assert.equal((await run(['claude', 'codex', '--board', ids[0], '--no-open'])).exitCode, 0, err.join('\n'));
      const { tricot } = hosted[0];
      const tmp = process.env.TMPDIR;
      process.env.TMPDIR = path.join(here, 'no-such-folder');
      let problem: string;
      try {
        problem = (tricot!.make!('pi') as { problem: string }).problem;
      } finally {
        if (tmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = tmp;
      }
      assert.equal(problem, "Pi didn't start: Tricot couldn't make a folder for the session (ENOENT).");
      for (const [cols, rows] of [[50, [" Pi didn't start: Tricot couldn't make a folder", ' for the session (ENOENT).']], [80, [" Pi didn't start: Tricot couldn't make a folder for the session (ENOENT)."]]] as const) {
        const frame: string[] = renderTab({ url: server.url, connected: true, agents: [], approvals: [], selected: 0, activity: [], prompt: { kind: 'keys' }, now: Date.now(), note: { text: problem, tone: 'alert' } }, cols, 12).plain.map((l) => l.trimEnd());
        assert.deepEqual(frame.slice(-1 - rows.length, -1), rows, `${cols} columns`);
      }
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

      assert.ok(!said().includes(token) && !err.join('\n').includes(token), 'never on screen');
      assert.deepEqual(snapshot(home), before);
    });
  });

  describe('the board', () => {
    it('is started in the background when none is running, and stops when the agent quits (test/stopWithAgents.test.ts)', async () => {
      const { server, ids } = await boardWith('Roadmap');
      await server.close();
      servers.length = 0;
      assert.equal(existsSync(lockFile(dataDir)), false);

      const { exitCode } = await run(['codex', '--board', ids[0], '--no-open']);
      assert.equal(exitCode, 0, err.join('\n'));
      assert.match(out[0], /^Tricot is running at http:\/\/127\.0\.0\.1:\d+ \(started in the background\)\.$/);
      assert.equal(out.at(-1), 'Tricot stopped, as no agent needs it now.');
      assert.equal(existsSync(lockFile(dataDir)), false, 'the board went with the agent');
      assert.match(recorded().args[1], /^mcp_servers\.tricot\.url="http:\/\/127\.0\.0\.1:\d+\/mcp\?agent=Codex"$/);
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

  it("prints how to connect the agent it can't start yet, and starts nothing", async () => {
    const { exitCode } = await run(['gemini']);
    assert.equal(exitCode, 1);
    assert.match(said(), /gemini mcp add --scope user/);
    assert.match(said(), /Tricot can't start Gemini CLI for you yet/);
    assert.equal(existsSync(lockFile(dataDir)), false);
    assert.deepEqual(launches, []);
  });

  it('lists the command in --help, and says what it does in its own help', async () => {
    await run(['--help']);
    assert.match(said(), /tricot claude {11}Start the board and Claude Code on it, in this terminal/);
    assert.match(said().replace(/\s+/g, ' '), /Also codex[^;]*; several at once: tricot claude codex/);
    assert.doesNotMatch(said(), /--switcher|--no-switcher|--switch-key/);
    out.length = 0;
    await run(['claude', '--help']);
    assert.match(said(), /^tricot claude: start the board and Claude Code together, in this terminal/);
    const flat = said().replace(/\s+/g, ' '); // however it wraps
    assert.match(flat, /with the Tricot tab and a strip at the bottom, as with several \(on its own without a terminal, and on Windows\)\./);
    assert.match(flat, /a strip at the bottom lists them all, and Ctrl\+\\ switches \(then a number picks one, q quits\)\. Any of claude, codex/);
    assert.match(flat, /anything after -- goes to the agent/);
    assert.doesNotMatch(said(), /--switcher|--no-switcher|--switch-key/);
    assert.deepEqual(launches, [], '--help starts nothing');
    assert.equal(existsSync(lockFile(dataDir)), false);
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
        "Codex asks for approvals in the terminal: they come to the board once its live steps are on (tricot steps on --agent codex), as Codex can't take hooks for one session.",
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
      // Every agent Tricot knows but those running; those it can't find on PATH say so.
      const byId = (running: string[]) => Object.fromEntries(tricot.choices!(running).map((c) => [c.id, c]));
      for (const agent of ['pi', 'omp']) rmSync(path.join(bin, agent));
      assert.deepEqual(Object.keys(byId(['claude', 'codex'])), ['opencode', 'gemini', 'pi', 'omp'], 'in the order Tricot lists them, those running left out');
      const missing = byId(['claude', 'codex']);
      assert.deepEqual(['opencode', 'gemini', 'pi', 'omp'].map((id) => missing[id].note), [undefined, 'not installed', 'not installed', 'not installed']);
      assert.equal(missing.gemini.name, 'Gemini CLI');
      assert.equal(missing.gemini.problem, "Gemini CLI isn't installed here, or isn't on your PATH: Tricot looked for `gemini`. Install it, then add it again.");
      // Installed, but not one Tricot can give the board for one session (Gemini CLI): connect it first, and why.
      writeFileSync(path.join(bin, 'gemini'), FAKE_AGENT, { mode: 0o755 });
      const first = byId(['claude']);
      assert.equal(first.gemini.note, 'connect it first');
      assert.equal(first.gemini.problem, "Connect Gemini CLI first, with: tricot connect gemini. Tricot can't start it for you yet: it adds a server only from a settings file.");
      assert.equal(first.codex.note, undefined);
      assert.ok(!('claude' in first), 'those running are left out');
      assert.equal((tricot.make!('gemini') as { problem: string }).problem, first.gemini.problem, 'picked, it says the same, and nothing is started');
      // What the tab shows of these, at a narrow window and a wide one: the command whole, the reason after it.
      for (const [cols, rows] of [[50, [' Connect Gemini CLI first, with: tricot connect', " gemini. Tricot can't start it for you yet: it", ' adds a server only from a settings file.']], [80, [" Connect Gemini CLI first, with: tricot connect gemini. Tricot can't start it", ' for you yet: it adds a server only from a settings file.']]] as const) {
        const frame: string[] = renderTab({ url: server.url, connected: true, agents: [], approvals: [], selected: 0, activity: [], prompt: { kind: 'keys' }, now: Date.now(), note: { text: first.gemini.problem!, tone: 'alert' } }, cols, 12).plain.map((l) => l.trimEnd());
        assert.deepEqual(frame.slice(-1 - rows.length, -1), rows, `${cols} columns`);
      }
      for (const [cols, rows] of [[50, [' Gemini CLI isn\'t installed here, or isn\'t on', ' your PATH: Tricot looked for `gemini`. Install', ' it, then add it again.']], [80, [" Gemini CLI isn't installed here, or isn't on your PATH: Tricot looked for", ' `gemini`. Install it, then add it again.']]] as const) {
        const frame: string[] = renderTab({ url: server.url, connected: true, agents: [], approvals: [], selected: 0, activity: [], prompt: { kind: 'keys' }, now: Date.now(), note: { text: missing.gemini.problem!, tone: 'alert' } }, cols, 12).plain.map((l) => l.trimEnd());
        assert.deepEqual(frame.slice(-1 - rows.length, -1), rows, `${cols} columns`);
      }
      rmSync(path.join(bin, 'gemini'));
      rmSync(path.join(bin, 'opencode'));
      assert.deepEqual(tricot.choices!(['claude']).slice(0, 2).map((c) => [c.id, c.note]), [
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

    it("starts Pi and OMP among the others, their folders taken away once the host is done, and one added from the Tricot tab the same", async () => {
      const { server, ids } = await boardWith('Roadmap');
      const before = snapshot(home);
      hostOutcome = { exits: [0, 0, 0], quit: false };
      assert.equal((await run(['codex', 'pi', 'omp', '--board', ids[0], '--no-open'])).exitCode, 0, err.join('\n'));
      const [codex, pi, omp] = hosted[0].agents;
      assert.deepEqual([codex.name, pi.name, omp.name], ['Codex', 'Pi', 'OMP']);
      assert.equal(pi.command, path.join(bin, 'pi'));
      assert.equal(omp.command, path.join(bin, 'omp'));
      assert.deepEqual([pi.args[0], pi.args.slice(2)], ['-e', [message(ids[0])]]);
      assert.deepEqual([omp.args[0], omp.args.slice(2)], ['-e', [message(ids[0])]]);
      assert.equal(pi.env.TERM, 'xterm-256color');
      assert.equal(codex.cleanup, undefined, 'only an agent that needed a folder has anything to take away');
      assert.equal(typeof pi.cleanup, 'function');
      assert.equal(typeof omp.cleanup, 'function');
      assert.equal(existsSync(pi.args[1]), false, "the host is done: Pi's folder is gone");
      assert.equal(existsSync(omp.args[1]), false, "and OMP's");

      const added = hosted[0].tricot!.make!('pi');
      assert.ok(!('problem' in added));
      assert.equal(added.name, 'Pi');
      assert.equal(added.args[0], '-e');
      assert.match(readFileSync(added.args[1], 'utf8'), new RegExp(`${server.mcpUrl.replaceAll('/', '\\/').replaceAll('.', '\\.')}\\?agent=Pi`));
      added.cleanup!();
      assert.equal(existsSync(added.args[1]), false, 'as the host does when it ends');
      const addedOmp = hosted[0].tricot!.make!('omp');
      assert.ok(!('problem' in addedOmp));
      assert.equal(JSON.parse(readFileSync(path.join(addedOmp.args[1], '.mcp.json'), 'utf8')).mcpServers.tricot.url, `${server.mcpUrl}?agent=OMP`);
      addedOmp.cleanup!();
      assert.equal(existsSync(addedOmp.args[1]), false);
      assert.deepEqual(snapshot(home), before);
    });

    it("makes no folder for an agent until it has found out who answers on the board, which waits on the network: a Ctrl+C then leaves none", async () => {
      const { ids } = await boardWith('Roadmap');
      const tmp = path.join(here, 'tmp');
      mkdirSync(tmp);
      const saved = { tmpdir: process.env.TMPDIR, fetch: globalThis.fetch };
      const seen: string[][] = [];
      process.env.TMPDIR = tmp;
      globalThis.fetch = async (input, init) => {
        if (String(input).endsWith(`/api/boards/${ids[0]}`)) seen.push(readdirSync(tmp)); // as the board is asked who acted on it
        return saved.fetch(input, init);
      };
      try {
        hostOutcome = { exits: [0, 0], quit: false };
        assert.equal((await run(['codex', 'pi', '--board', ids[0], '--no-open'])).exitCode, 0, err.join('\n'));
      } finally {
        globalThis.fetch = saved.fetch;
        if (saved.tmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = saved.tmpdir;
      }
      assert.ok(seen.length > 0, 'the board was asked');
      assert.deepEqual(seen.flat(), [], 'with no folder made yet');
      assert.deepEqual(readdirSync(tmp), [], 'and none left');
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
        [['claude', 'codex', '--name', 'Reviewer', '--board', 'x'], /--name names one agent: with several, each has its usual name on the board \(Claude and Codex\)/],
        [['claude', 'codex', '--board', 'x', '--', '--model', 'opus'], /Words after -- go to one agent/],
        [['claude', 'codex', '--board', 'x'], /Several agents at once need a terminal/, { noTerminal: true }],
        [['claude', 'codex', '--board', 'x'], /don't work on Windows yet/, { platform: 'win32' }],
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

    it('words that are not agents still go after --', async () => {
      assert.equal((await run(['claude', 'codex', 'fix'])).exitCode, 1);
      assert.match(err.join('\n'), /put them after --: tricot claude -- codex fix/);
    });

    // The strip, the Tricot tab and their key are not options: Ctrl+\ always,
    // and an old command line that names one gets the error any unknown option
    // does, with the help, before anything starts.
    it('no longer takes --switcher, --no-switcher or --switch-key: an unknown option, with the help, starting nothing', async () => {
      const gone: string[][] = [['--switcher'], ['--no-switcher'], ['--switch-key', 'ctrl-]']];
      for (const flag of gone) {
        for (const argv of [['claude', ...flag, '--board', 'x'], ['claude', 'codex', ...flag, '--board', 'x'], ['codex', ...flag], [...flag]]) {
          out.length = 0;
          err.length = 0;
          const { exitCode } = await run(argv, { terminal: true });
          assert.equal(exitCode, 1, argv.join(' '));
          const text = err.join('\n');
          assert.equal(err.length, 1, 'one message: the error, then the help');
          assert.match(text, new RegExp(`^Unknown option '${flag[0]}'`), argv.join(' '));
          assert.match(text, /\n\nUsage\n {2}tricot \[start\] /, 'followed by the help');
          assert.doesNotMatch(text.slice(text.indexOf('\n\nUsage')), /--switcher|--no-switcher|--switch-key/, 'which no longer lists them');
          assert.deepEqual(out, []);
          nothingStarted();
        }
      }
    });

    // One agent: the strip and the Tricot tab, on its own where that can't run.
    describe('one agent', () => {
      const bare = (reason: string) => {
        assert.equal(launches.length, 1, `${reason}: run on its own`);
        assert.deepEqual(hosted, [], `${reason}: no strip`);
      };

      it('runs with the strip and the Tricot tab by default, in a terminal', async () => {
        const { ids } = await boardWith('Roadmap');
        hostOutcome = { exits: [0], quit: false };
        const { exitCode } = await run(['claude', '--board', ids[0], '--no-open'], { terminal: true });
        assert.equal(exitCode, 0, err.join('\n'));
        assert.deepEqual(launches, [], 'not run on its own');
        assert.equal(hosted.length, 1);
        const [shown] = hosted;
        assert.deepEqual(shown.agents.map((a) => a.name), ['Claude']);
        assert.equal(shown.agents[0].command, path.join(bin, 'claude'));
        assert.deepEqual(shown.agents[0].args.slice(0, 1), [message(ids[0])]);
        assert.ok(shown.tricot, 'with the Tricot tab');
        assert.equal(shown.tricot.title, 'Roadmap');
        assert.ok(out.includes('Ctrl+\\ then q quits; the strip at the bottom says what Claude is doing.'));
        assert.ok(!out.some((line) => line.includes('runs on its own')), 'nothing to say about a fallback');
        for (const agent of ['codex', 'opencode']) {
          hosted.length = 0;
          assert.equal((await run([agent, '--board', ids[0], '--no-open'], { terminal: true })).exitCode, 0, err.join('\n'));
          assert.equal(hosted.length, 1, agent);
        }
        assert.deepEqual(launches, []);
      });

      it('takes --name and words after -- by default', async () => {
        const { ids } = await boardWith('Roadmap');
        hostOutcome = { exits: [0], quit: false };
        await run(['claude', '--board', ids[0], '--no-open', '--name', 'Reviewer', '--', '--model', 'opus'], { terminal: true });
        assert.deepEqual(hosted[0].agents.map((a) => a.name), ['Reviewer']);
        assert.deepEqual(hosted[0].agents[0].args.slice(0, 3), [message(ids[0]), '--model', 'opus']);
        assert.ok(hosted[0].agents[0].args.some((arg) => arg.includes('agent=Reviewer')));
        assert.deepEqual(launches, []);
      });

      it('runs on its own, as it always did, where the strip can not run: no terminal, Windows, no way to give it a terminal', async () => {
        const { ids } = await boardWith('Roadmap');
        const argv = ['claude', '--board', ids[0], '--no-open'];
        assert.equal((await run(argv, { noTerminal: true })).exitCode, 0, err.join('\n'));
        bare('no terminal');
        assert.ok(!out.some((line) => line.includes('runs on its own')), 'no terminal: nothing to say');
        launches.length = 0;
        assert.equal((await run(argv, { terminal: true, platform: 'win32' })).exitCode, 0, err.join('\n'));
        bare('Windows');
        launches.length = 0;
        out.length = 0;
        hostProblem = "Tricot runs each agent in a terminal of its own through Perl's IO::Pty, Python 3 or the script command, and found none of them here.";
        assert.equal((await run(argv, { terminal: true })).exitCode, 0, err.join('\n'));
        bare('no pty helper');
        assert.ok(out.includes(`Claude Code runs on its own, without the strip: ${hostProblem}`), 'says why, as the terminal could have had it');
        assert.deepEqual(recorded().args.slice(0, 1), [message(ids[0])]);
        // --name and words after -- still reach it.
        launches.length = 0;
        await run([...argv, '--name', 'Reviewer', '--', '--model', 'opus'], { noTerminal: true });
        assert.deepEqual(recorded().args.slice(0, 3), [message(ids[0]), '--model', 'opus']);
      });

      it('leaves what it can not start for one session as it was', async () => {
        assert.equal((await run(['gemini'], { terminal: true })).exitCode, 1);
        assert.match(said(), /Tricot can't start .* for you yet/);
        assert.equal(existsSync(lockFile(dataDir)), false);
        assert.deepEqual(hosted, []);
        assert.deepEqual(launches, []);
      });

      it('still refuses several agents with --name or words after --, as without a terminal', async () => {
        assert.equal((await run(['claude', 'codex', '--name', 'Reviewer', '--board', 'x'], { terminal: true })).exitCode, 1);
        assert.match(err.join('\n'), /--name names one agent/);
        assert.equal((await run(['claude', 'codex', '--board', 'x'], { noTerminal: true })).exitCode, 1);
        assert.match(err.join('\n'), /Several agents at once need a terminal/);
        assert.deepEqual(hosted, []);
      });
    });
  });
});
