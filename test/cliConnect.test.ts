import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONNECT_TIMEOUT_MS, runCaptured, type CommandResult, type CommandToRun } from '../src/cli/connectAgent';
import { runCli, type CliContext, type CliResult } from '../src/cli/main';

// `tricot connect <agent>`: shows the agent's own command, asks, and runs it.
// Nothing here runs a real agent: PATH holds empty stand-ins (so the agents
// are found), and the command is run by a recorder the test hands the command
// (ctx.exec), which answers as the test says. HOME is never read or written.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'Zm9vYmFyYmF6cXV4-dG9rZW4tZm9yLXRlc3Rz-0123456789';

describe('tricot connect <agent>', () => {
  let scratch: string;
  let dataDir: string;
  let root: string;
  let bin: string;
  let port: number;
  let out: string[];
  let err: string[];
  let asked: string[];
  let ran: CommandToRun[];
  let answer: boolean;
  let result: CommandResult;
  let agentsHere: string[];

  const agentsOnPath = (names: string[]) => {
    rmSync(bin, { recursive: true, force: true });
    mkdirSync(bin, { recursive: true });
    for (const name of names) {
      const file = path.join(bin, name);
      writeFileSync(file, '#!/bin/sh\nexit 99\n'); // never run: ctx.exec stands in
      chmodSync(file, 0o755);
    }
  };

  const ctx = (options: { terminal?: boolean } = {}): CliContext => ({
    env: { TRICOT_DATA_DIR: dataDir, PORT: String(port), PATH: bin },
    root,
    entry: path.join(repo, 'src/cli/tricot.ts'),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    open: () => {},
    cwd: scratch,
    exec: async (command) => {
      ran.push(command);
      return result;
    },
    ...(options.terminal !== false && {
      ask: async (question) => {
        asked.push(question);
        return answer;
      },
    }),
  });

  const run = (...argv: string[]): Promise<CliResult> => runCli(argv, ctx());
  const runWithoutTerminal = (...argv: string[]): Promise<CliResult> => runCli(argv, ctx({ terminal: false }));
  const said = () => out.join('\n');
  const complained = () => err.join('\n');
  const everything = () => `${said()}\n${complained()}`;
  const url = (name: string) => `http://127.0.0.1:${port}/mcp?agent=${name}`;
  const withToken = () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, 'token'), `${TOKEN}\n`);
  };

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-connect-'));
    dataDir = path.join(scratch, 'data');
    root = path.join(scratch, 'pkg');
    bin = path.join(scratch, 'bin');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{"name":"tricot","version":"9.9.9"}');
    port = 45000 + Math.floor(Math.random() * 1000);
    out = [];
    err = [];
    asked = [];
    ran = [];
    answer = true;
    result = { exitCode: 0, stdout: '', stderr: '' };
    agentsHere = ['claude', 'codex', 'pi', 'gemini'];
    agentsOnPath(agentsHere);
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  describe('with a terminal to ask in', () => {
    it("shows Claude Code's command, asks which settings it changes, and runs it after y", async () => {
      result = { exitCode: 0, stdout: 'Added HTTP MCP server tricot to user config', stderr: '' };
      const { exitCode } = await run('connect', 'claude');
      assert.equal(exitCode, 0);
      assert.equal(ran.length, 1);
      assert.equal(ran[0].command, path.join(bin, 'claude'));
      assert.deepEqual(ran[0].args, ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'tricot', url('Claude')]);
      assert.equal(ran[0].timeoutMs, 30_000);
      assert.equal(ran[0].cwd, scratch);
      assert.deepEqual(ran[0].env, ctx().env);
      assert.match(said(), new RegExp(`^  claude mcp add --scope user --transport http tricot "http://127.0.0.1:${port}/mcp\\?agent=Claude"$`, 'm'));
      assert.match(said(), /adds a server named tricot to Claude Code's settings \(~\/\.claude\.json\), for every session/);
      assert.deepEqual(asked, ["Run it, adding the board to Claude Code's settings? [y/N] "]);
      assert.match(said(), /Added HTTP MCP server tricot to user config/);
      assert.match(said(), /Connected: Claude Code now has the board/);
      assert.deepEqual(err, []);
    });

    it('also shows the project-only command as a hint, and the steps hint once it worked', async () => {
      await run('connect', 'claude', '--board', 'plan');
      assert.match(said(), new RegExp(`for this project only .*run this yourself:\\n  claude mcp add --scope project --transport http tricot "http://127.0.0.1:${port}/mcp\\?agent=Claude"`));
      assert.ok(said().indexOf('Connected') < said().indexOf('tricot steps on --agent claude --project'), 'the steps hint comes after it worked');
      assert.match(said(), /Then tell the agent: Use the Tricot board plan\./);
    });

    it('says what Pi and Gemini CLI do with the board once it worked', async () => {
      await run('connect', 'pi');
      assert.match(said(), /codemode tool by default; add --exposure direct/);
      out.length = 0;
      await run('connect', 'gemini');
      assert.match(said(), /It asks before each board tool unless you add --trust\./);
    });

    it('runs nothing after n, and says so', async () => {
      answer = false;
      const { exitCode } = await run('connect', 'claude');
      assert.equal(exitCode, 0);
      assert.deepEqual(ran, []);
      assert.equal(asked.length, 1);
      assert.match(said(), /Nothing was changed\./);
      assert.match(said(), /claude mcp add/, 'it still showed the command');
    });

    it('asks as every agent, each naming its own settings', async () => {
      for (const [agent, settings] of [
        ['codex', "Codex's settings"],
        ['pi', "Pi's settings"],
        ['gemini', "Gemini CLI's settings"],
      ]) {
        asked.length = 0;
        await run('connect', agent);
        assert.match(asked[0], new RegExp(`adding the board to ${settings}\\? \\[y/N\\] $`), agent);
      }
    });

    it('runs the commands as printed for Codex, Pi and Gemini CLI, named on the board', async () => {
      await run('connect', 'codex');
      await run('connect', 'pi');
      await run('connect', 'gemini');
      assert.deepEqual(
        ran.map((c) => [path.basename(c.command), ...c.args]),
        [
          ['codex', 'mcp', 'add', 'tricot', '--url', url('Codex')],
          ['pi', 'mcp', 'add', 'tricot', '--url', url('Pi')],
          ['gemini', 'mcp', 'add', '--scope', 'user', '--transport', 'http', 'tricot', url('Gemini')],
        ],
      );
    });
  });

  describe('with --yes', () => {
    it('runs it without asking, and still shows the command', async () => {
      const { exitCode } = await run('connect', 'codex', '--yes');
      assert.equal(exitCode, 0);
      assert.deepEqual(asked, []);
      assert.equal(ran.length, 1);
      assert.match(said(), new RegExp(`^  codex mcp add tricot --url "http://127.0.0.1:${port}/mcp\\?agent=Codex"$`, 'm'));
    });

    it('runs it where there is no terminal to ask in', async () => {
      const { exitCode } = await runWithoutTerminal('connect', 'codex', '--yes');
      assert.equal(exitCode, 0);
      assert.equal(ran.length, 1);
    });
  });

  describe('without a terminal to ask in, and no --yes', () => {
    it('runs nothing, prints the instructions as --print does, and says what to do', async () => {
      const { exitCode } = await runWithoutTerminal('connect', 'claude');
      assert.equal(exitCode, 1);
      assert.deepEqual(ran, []);
      assert.deepEqual(asked, []);
      assert.match(said(), new RegExp(`^  claude mcp add --scope user --transport http tricot "http://127.0.0.1:${port}/mcp\\?agent=Claude"$`, 'm'));
      assert.match(said(), /Run once; Claude Code then has the board in every session/);
      assert.match(complained(), /Without a terminal to ask in, Tricot didn't run it\. Run the command above yourself, or add --yes to have Tricot run it; nothing was changed\./);
    });

    it('prints exactly what --print prints', async () => {
      await runWithoutTerminal('connect', 'gemini');
      const without = [...out];
      out.length = 0;
      await runWithoutTerminal('connect', 'gemini', '--print');
      assert.deepEqual(without, out);
    });
  });

  describe('with --print', () => {
    it('never runs anything, and asks nothing, even with --yes and a yes ready', async () => {
      for (const agent of ['claude', 'codex', 'pi', 'gemini']) {
        for (const flags of [['--print'], ['--print', '--yes']]) {
          const { exitCode } = await run('connect', agent, ...flags);
          assert.equal(exitCode, 0);
        }
      }
      assert.deepEqual(ran, []);
      assert.deepEqual(asked, []);
      assert.deepEqual(err, []);
    });

    it('prints the command, the project one and the steps hint for Claude Code, as before', async () => {
      await run('connect', 'claude', '--print');
      assert.match(said(), /^Run once; Claude Code then has the board in every session:$/m);
      assert.match(said(), /^  claude mcp add --scope user --transport http/m);
      assert.match(said(), /^Or for this project only \(writes \.mcp\.json, which you can commit\):$/m);
      assert.match(said(), /^  claude mcp add --scope project --transport http/m);
      assert.match(said(), /^  tricot steps on --agent claude --project$/m);
    });

    it('prints for an agent that is not on this computer', async () => {
      agentsOnPath([]);
      const { exitCode } = await run('connect', 'codex', '--print');
      assert.equal(exitCode, 0);
      assert.match(said(), /codex mcp add tricot/);
      assert.deepEqual(err, []);
    });
  });

  describe('when the agent is not on PATH', () => {
    it("runs nothing, prints the instructions, and says it isn't installed, with how to get it", async () => {
      agentsOnPath(['claude', 'pi', 'gemini']);
      const { exitCode } = await run('connect', 'codex', '--yes');
      assert.equal(exitCode, 1);
      assert.deepEqual(ran, []);
      assert.deepEqual(asked, []);
      assert.match(said(), /codex mcp add tricot --url/);
      assert.match(complained(), /Codex isn't installed here, or isn't on your PATH: Tricot looked for `codex`, so it ran nothing\./);
      assert.match(complained(), /npm install -g @openai\/codex/);
    });

    it('says so for an agent it has no install hint for', async () => {
      agentsOnPath([]);
      const { exitCode } = await run('connect', 'pi', '--yes');
      assert.equal(exitCode, 1);
      assert.deepEqual(ran, []);
      assert.match(complained(), /isn't installed here, or isn't on your PATH: Tricot looked for `pi`/);
    });
  });

  describe('when the agent says no', () => {
    it("shows the agent's own output, and exits 1", async () => {
      result = { exitCode: 1, stdout: '', stderr: 'error: something went wrong\nsecond line' };
      const { exitCode } = await run('connect', 'codex', '--yes');
      assert.equal(exitCode, 1);
      assert.match(complained(), /^  error: something went wrong\n  second line$/m);
      assert.match(complained(), /Codex didn't connect: its command ended with exit code 1\./);
      assert.doesNotMatch(said(), /Connected/);
    });

    it('says plainly when it already has a tricot entry, and how to replace it', async () => {
      result = { exitCode: 1, stdout: '', stderr: 'MCP server tricot already exists in user config' };
      assert.equal((await run('connect', 'claude', '--yes')).exitCode, 1);
      assert.match(complained(), /Claude Code already has a server named tricot\. To replace it, take that one out, then connect again:/);
      assert.match(complained(), /^  claude mcp remove tricot$/m);
      assert.match(complained(), /^  tricot connect claude$/m);

      err.length = 0;
      assert.equal((await run('connect', 'gemini', '--yes')).exitCode, 1);
      assert.match(complained(), /^  gemini mcp remove --scope user tricot$/m);
    });

    it('does not suggest replacing anything for another failure', async () => {
      result = { exitCode: 2, stdout: '', stderr: 'unknown option' };
      await run('connect', 'pi', '--yes');
      assert.doesNotMatch(complained(), /already has a server/);
    });

    it('says when the command could not start, and when it took too long', async () => {
      result = { stdout: '', stderr: '', problem: 'spawn EACCES' };
      assert.equal((await run('connect', 'pi', '--yes')).exitCode, 1);
      assert.match(complained(), /Pi's command didn't start: spawn EACCES\. Nothing was changed\./);

      err.length = 0;
      result = { stdout: 'working…', stderr: '', timedOut: true };
      assert.equal((await run('connect', 'pi', '--yes')).exitCode, 1);
      assert.match(complained(), /didn't finish within 30 seconds, so Tricot stopped it\. See whether the server was added with: pi mcp list/);
      assert.match(complained(), /^  working…$/m);
    });
  });

  describe("with the board's token", () => {
    beforeEach(withToken);

    it("gives Codex and Pi the token in the command's environment, never in its arguments or on screen", async () => {
      for (const agent of ['codex', 'pi']) {
        ran.length = 0;
        out.length = 0;
        err.length = 0;
        const { exitCode } = await run('connect', agent, '--yes', '--host', '0.0.0.0');
        assert.equal(exitCode, 0, agent);
        assert.equal(ran[0].env.TRICOT_TOKEN, TOKEN);
        assert.deepEqual(ran[0].args, ['mcp', 'add', 'tricot', '--url', `http://127.0.0.1:${port}/mcp?agent=${agent === 'codex' ? 'Codex' : 'Pi'}`, '--bearer-token-env-var', 'TRICOT_TOKEN']);
        assert.ok(!JSON.stringify(ran[0].args).includes(TOKEN), 'the token is not an argument');
        assert.ok(!everything().includes(TOKEN), `the token is not shown (${agent})`);
        assert.match(said(), new RegExp(`^  TRICOT_TOKEN=<token> ${agent} mcp add tricot --url .* --bearer-token-env-var TRICOT_TOKEN$`, 'm'));
        assert.match(said(), /<token> stands for this board's token/);
        assert.match(said(), /reads the token from TRICOT_TOKEN: set it in the shell/);
      }
    });

    it('gives Gemini CLI the header that names the variable, and the token in the environment', async () => {
      const { exitCode } = await run('connect', 'gemini', '--yes', '--host', '0.0.0.0');
      assert.equal(exitCode, 0);
      assert.deepEqual(ran[0].args, [
        'mcp', 'add', '--scope', 'user', '--transport', 'http', '--header', 'Authorization: Bearer ${TRICOT_TOKEN}', 'tricot', `http://127.0.0.1:${port}/mcp?agent=Gemini`,
      ]);
      assert.equal(ran[0].env.TRICOT_TOKEN, TOKEN);
      assert.ok(!JSON.stringify(ran[0].args).includes(TOKEN));
      assert.ok(!everything().includes(TOKEN));
    });

    it("keeps the token out of what the agent says back, should it repeat it", async () => {
      result = { exitCode: 1, stdout: '', stderr: `bad header: Bearer ${TOKEN}` };
      await run('connect', 'codex', '--yes', '--host', '0.0.0.0');
      assert.ok(!everything().includes(TOKEN));
      assert.match(complained(), /bad header: Bearer <token>/);
    });

    it('leaves Claude Code to the person: its command takes the token only as an argument', async () => {
      const { exitCode } = await run('connect', 'claude', '--yes', '--host', '0.0.0.0');
      assert.equal(exitCode, 1);
      assert.deepEqual(ran, []);
      assert.match(complained(), /Claude Code takes the token only as part of its command's own arguments/);
      assert.match(said(), new RegExp(`--header "Authorization: Bearer ${TOKEN}"`), 'the instructions, as --print shows them');
    });

    it("does not run when the token isn't in the data folder yet", async () => {
      rmSync(path.join(dataDir, 'token'));
      const { exitCode } = await run('connect', 'codex', '--yes', '--host', '0.0.0.0');
      assert.equal(exitCode, 1);
      assert.deepEqual(ran, []);
      assert.match(complained(), /needs its token, which isn't in .*data yet/);
      assert.match(said(), /export TRICOT_TOKEN="<token>"/, 'the instructions, with the placeholder, as before');
    });

    it('asks first as well, and runs nothing after n', async () => {
      answer = false;
      await run('connect', 'codex', '--host', '0.0.0.0');
      assert.equal(asked.length, 1);
      assert.deepEqual(ran, []);
    });
  });

  describe('with names that need care', () => {
    it('runs a name with a space as one argument, and shows it quoted', async () => {
      await run('connect', 'claude', '--yes', '--name', 'Claude Builder');
      assert.equal(ran[0].args.at(-1), `http://127.0.0.1:${port}/mcp?agent=Claude%20Builder`);
      assert.deepEqual(ran[0].args.slice(0, 7), ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'tricot']);
      assert.match(said(), /"http:\/\/127\.0\.0\.1:\d+\/mcp\?agent=Claude%20Builder"/);
    });

    it('never gives a shell a quote, a dollar or an ampersand to act on', async () => {
      const name = `Say "hi" & $HOME; \`id\` 'x'`;
      await run('connect', 'pi', '--yes', '--name', name);
      assert.equal(ran.length, 1);
      assert.equal(ran[0].args.length, 5, 'the address is one argument');
      assert.equal(ran[0].args[4], `http://127.0.0.1:${port}/mcp?agent=${encodeURIComponent(name)}`);
    });

    it('keeps a name with a quote in the steps hint, quoted for a shell', async () => {
      await run('connect', 'claude', '--yes', '--name', "O'Brien");
      assert.match(said(), /tricot steps on --agent claude --project --name "O'Brien"/);
    });
  });

  describe('OMP, OpenCode and any MCP client', () => {
    it('print as they did, say they cannot be run, and run nothing, even with --yes', async () => {
      for (const [agent, why] of [
        ['omp', "it's a file to edit"],
        ['opencode', "it's a file to edit"],
        ['mcp-json', "it's an entry for your client's settings"],
      ]) {
        out.length = 0;
        const { exitCode } = await run('connect', agent, '--yes');
        assert.equal(exitCode, 0, agent);
        assert.match(said(), new RegExp(`^Tricot can't run this one for you: ${why}\\.$`, 'm'), agent);
      }
      assert.deepEqual(ran, []);
      assert.deepEqual(asked, []);
    });

    it('prints the entry, with the note after it', async () => {
      await run('connect', 'omp');
      assert.match(said(), /~\/\.omp\/agent\/mcp\.json/);
      assert.ok(said().indexOf('"mcpServers"') < said().indexOf("Tricot can't run this one"));
    });

    it('keeps the address alone on the output for url, with the note on the other stream', async () => {
      await run('connect', 'url', '--name', 'Dev');
      assert.equal(out.at(-1), `http://127.0.0.1:${port}/mcp?agent=Dev`);
      assert.doesNotMatch(said(), /can't run/);
      assert.match(complained(), /Tricot can't run this one for you: it's an address for your client\./);
    });

    it('says nothing about running with --print', async () => {
      await run('connect', 'omp', '--print');
      assert.doesNotMatch(everything(), /can't run/);
    });
  });

  describe('without an agent', () => {
    it('prints the overview, and says how to connect one', async () => {
      const { exitCode } = await run('connect');
      assert.equal(exitCode, 0);
      assert.match(said(), /^Connect an agent \(once\):$/m);
      assert.match(said(), /To have Tricot run one of these for you, after asking: tricot connect claude \(or codex, pi, gemini\)\. Add --print to only see the command\./);
      assert.deepEqual(ran, []);
      assert.deepEqual(asked, []);
    });

    it('prints the same with --print', async () => {
      await run('connect');
      const plain = [...out];
      out.length = 0;
      await run('connect', '--print');
      assert.deepEqual(out, plain);
    });
  });

  describe('the help', () => {
    it('lists connect in the main help, and says its options in its own (cliHelp.test.ts has the rest)', async () => {
      await run('--help');
      assert.match(said(), /tricot connect \[agent\]\s+Connect claude, codex, pi or gemini: shows its own command, asks,/);
      out.length = 0;
      await run('connect', '--help');
      assert.match(said().replace(/\s+/g, ' '), /Connect claude, codex, pi or gemini: shows its own command, asks, and runs it\. --print only shows it/);
      assert.match(said(), /--print\s+Only show the command, run nothing/);
      assert.match(said(), /--yes\s+Don't ask \(it still shows what it changes\)/);
    });
  });
});

// The real runner, with a real child that is only node: the argument list
// reaches it as it is, with no shell between, its stdin closed, its output
// captured, and a limit on how long it may take.
describe('running the agent’s command', () => {
  const node = (script: string, ...args: string[]): CommandToRun => ({ command: process.execPath, args: ['-e', script, '--', ...args], env: { ...process.env, X_FROM_TRICOT: 'in the environment' }, timeoutMs: 10_000 });

  it('passes each argument as it is, whatever it holds, and the environment it was given', async () => {
    const odd = ['a b', '"q"', "it's", '$HOME', '`id`', 'http://h:1/mcp?agent=A%20B&x=1', ''];
    const done = await runCaptured(node('console.log(JSON.stringify(process.argv.slice(1))); console.error(process.env.X_FROM_TRICOT)', ...odd));
    assert.equal(done.exitCode, 0);
    assert.deepEqual(JSON.parse(done.stdout), odd);
    assert.equal(done.stderr.trim(), 'in the environment');
  });

  it('closes its input, so a command that waits for an answer gets none', async () => {
    const done = await runCaptured(node("process.stdin.on('end', () => console.log('input closed')); process.stdin.resume()"));
    assert.equal(done.exitCode, 0);
    assert.equal(done.stdout.trim(), 'input closed');
  });

  it('gives its exit code, and what it said', async () => {
    const done = await runCaptured(node("console.log('out'); console.error('err'); process.exit(3)"));
    assert.equal(done.exitCode, 3);
    assert.equal(done.stdout.trim(), 'out');
    assert.equal(done.stderr.trim(), 'err');
  });

  it('stops one that takes too long', async () => {
    const started = Date.now();
    const done = await runCaptured({ ...node('console.log("started"); setInterval(() => {}, 1000)'), timeoutMs: 400 });
    assert.equal(done.timedOut, true);
    assert.ok(Date.now() - started < 5000);
    assert.notEqual(done.exitCode, 0);
  });

  it('says when it could not start one', async () => {
    const done = await runCaptured({ ...node(''), command: path.join(os.tmpdir(), 'tricot-no-such-agent') });
    assert.match(done.problem ?? '', /ENOENT/);
  });

  it('allows 30 seconds', () => {
    assert.equal(CONNECT_TIMEOUT_MS, 30_000);
  });
});
