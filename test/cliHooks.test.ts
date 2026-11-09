import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ANSWER_FILE } from '../src/cli/hooks';
import { runCli, type CliContext, type CliResult } from '../src/cli/main';
import { claude } from '../src/server/hooks/claude';
import { codex } from '../src/server/hooks/codex';
import { gemini } from '../src/server/hooks/gemini';
import { copilot } from '../src/server/hooks/copilot';
import { grok } from '../src/server/hooks/grok';
import { opencode } from '../src/server/hooks/opencode';
import { pi } from '../src/server/hooks/pi';
import type { RunningServer } from '../src/server/start';
import { removeScratch } from './platform';

// The first `tricot` asks once whether to show the agents' steps, and
// `tricot steps` turns them on or off. Every agent folder is in a home made
// for the test and PATH is empty: no real agent settings are read or written,
// and no agent is run.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

describe('live steps from the terminal', () => {
  let scratch: string;
  let home: string;
  let project: string;
  let dataDir: string;
  let root: string;
  let port: number;
  let out: string[];
  let err: string[];
  let questions: string[];
  const servers: RunningServer[] = [];

  // A terminal answers `answer` (undefined: there is no terminal); a bare Enter takes the question's default.
  const ctx = (answer?: boolean | 'enter', env: Record<string, string> = {}): CliContext => ({
    env: { TRICOT_DATA_DIR: dataDir, PORT: String(port), HOME: home, USERPROFILE: home, PATH: '', ...env },
    root,
    entry: path.join(repo, 'src/cli/tricot.ts'),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    open: () => {},
    cwd: project,
    ...(answer !== undefined && {
      ask: async (question: string, fallback = false) => {
        questions.push(question);
        return answer === 'enter' ? fallback : answer;
      },
    }),
  });
  const run = async (argv: string[], answer?: boolean | 'enter', env?: Record<string, string>): Promise<CliResult> => {
    const result = await runCli(argv, ctx(answer, env));
    if (result.server) servers.push(result.server);
    return result;
  };
  // `tricot` started and stopped again, as a person opens and closes it.
  const startAndStop = async (answer?: boolean | 'enter', ...flags: string[]) => {
    const result = await run(['--no-open', ...flags], answer);
    assert.equal(result.exitCode, 0, err.join('\n'));
    await servers.pop()?.close();
    return result;
  };
  const said = () => out.join('\n');
  const target = () => ({ home, project, env: { PATH: '' } });
  const remembered = () => (existsSync(path.join(dataDir, ANSWER_FILE)) ? JSON.parse(readFileSync(path.join(dataDir, ANSWER_FILE), 'utf8')) : undefined);

  beforeEach(async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-cli-hooks-'));
    home = path.join(scratch, 'home');
    project = path.join(home, 'work/app');
    mkdirSync(project, { recursive: true });
    dataDir = path.join(scratch, 'data');
    root = path.join(scratch, 'pkg');
    mkdirSync(path.join(root, 'dist/web'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{"name":"tricot","version":"9.9.9"}');
    writeFileSync(path.join(root, 'dist/web/index.html'), '<!doctype html><title>Tricot</title>');
    symlinkSync(path.join(repo, 'hooks'), path.join(root, 'hooks'));
    port = await freePort();
    out = [];
    err = [];
    questions = [];
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    removeScratch(scratch);
  });

  describe('the first tricot', () => {
    it('asks once, in a terminal, with what it will write for each agent found, and a yes sets them up', async () => {
      mkdirSync(path.join(home, '.claude'));
      mkdirSync(path.join(home, '.codex'));
      await startAndStop('enter');
      assert.deepEqual(questions, ["Show your agents' steps live on your boards?"], 'one question; Enter is yes');
      assert.match(said(), /It found Claude Code and Codex on this machine/);
      assert.match(said(), /~\/\.claude\/hooks\/\{tricot-steps\.mjs, tricot-describe\.mjs, tricot-approve\.mjs, tricot-usage\.mjs, tricot-usage\.json\}, ~\/\.claude\/settings\.json/);
      assert.match(said(), /Claude Code and Codex also bring each permission prompt to the board, with the command or change it asks about/);
      assert.match(said(), /also pass on plan usage, numbers only/);
      assert.match(said(), /Every file and line: tricot --verbose/);
      assert.match(said(), /never file contents, command output or your prompts/);
      assert.equal(claude.status(target()).state, 'on');
      assert.equal(codex.status(target()).state, 'on');
      assert.equal(pi.status(target()).state, 'off', 'Pi is not on this machine');
      assert.equal(existsSync(path.join(home, '.pi')), false);
      assert.match(said(), /open \/hooks in Codex and trust Tricot's/, "Codex's trust is said after installing");
      assert.equal(json(path.join(home, '.claude/settings.json')).hooks.PreToolUse[0].hooks[0].command.includes(`--url http://127.0.0.1:${port}`), true);
      assert.equal(remembered().answer, 'yes');

      // Not asked again, even with an agent turned off since.
      claude.uninstall(target());
      questions = [];
      await startAndStop(true);
      assert.deepEqual(questions, []);
      assert.equal(claude.status(target()).state, 'off');
    });

    it('remembers a no, and changes nothing', async () => {
      mkdirSync(path.join(home, '.pi'));
      await startAndStop(false);
      assert.equal(questions.length, 1);
      assert.match(said(), /Nothing was changed\. Turn them on later with: tricot steps on/);
      assert.equal(pi.status(target()).state, 'off');
      assert.equal(existsSync(path.join(home, '.pi/agent')), false);
      assert.equal(remembered().answer, 'no');
      questions = [];
      await startAndStop(true);
      assert.deepEqual(questions, [], 'a no is remembered too');
    });

    it("doesn't ask without a terminal, in CI, or with --no-ask, and remembers nothing then", async () => {
      mkdirSync(path.join(home, '.claude'));
      await startAndStop(undefined);
      await startAndStop(true, '--no-ask');
      const ci = await run(['--no-open'], true, { CI: 'true' });
      await ci.server?.close();
      servers.pop();
      assert.deepEqual(questions, []);
      assert.equal(remembered(), undefined);
      assert.equal(claude.status(target()).state, 'off');
      assert.doesNotMatch(said(), /live on your boards/);
      // CI=false is no CI.
      await run(['--no-open'], false, { CI: 'false' }).then((r) => r.server?.close());
      servers.pop();
      assert.equal(questions.length, 1);
    });

    it("doesn't ask when no agent is found, or when every one found is on already", async () => {
      await startAndStop(true);
      assert.deepEqual(questions, []);
      assert.equal(remembered(), undefined, 'asked later, once an agent is here');

      mkdirSync(path.join(home, '.claude'));
      claude.install(target(), { url: 'http://127.0.0.1:1', source: path.join(repo, 'hooks') });
      await startAndStop(true);
      assert.deepEqual(questions, []);
    });

    it('asks for Gemini CLI and OpenCode like the others, and a yes sets them up', async () => {
      mkdirSync(path.join(home, '.gemini'));
      mkdirSync(path.join(home, '.config/opencode'), { recursive: true });
      await startAndStop('enter');
      assert.match(said(), /It found Gemini CLI and OpenCode on this machine/);
      assert.match(said(), /Gemini CLI +~\/\.gemini\/hooks\/\{tricot-steps\.mjs, tricot-describe\.mjs\}, ~\/\.gemini\/settings\.json/);
      assert.match(said(), /OpenCode +~\/\.config\/opencode\/plugins\/tricot-steps\.js, ~\/\.config\/opencode\/tricot-steps\/\{tricot-describe\.mjs, tricot-steps\.json\}/);
      assert.equal(gemini.status(target()).state, 'on');
      assert.equal(opencode.status(target()).state, 'on');
      assert.match(said(), /Gemini CLI waits for each hook/, 'what to know about it, said after installing');
      assert.equal(json(path.join(home, '.gemini/settings.json')).hooks.BeforeTool[0].hooks[0].command.includes(`--url http://127.0.0.1:${port}`), true);
      assert.deepEqual(json(path.join(home, '.config/opencode/tricot-steps/tricot-steps.json')), { name: 'OpenCode', url: `http://127.0.0.1:${port}` });
    });

    it('asks for Grok Build like the others, and a yes sets it up in its own hook file', async () => {
      mkdirSync(path.join(home, '.grok'));
      await startAndStop('enter');
      assert.match(said(), /It found Grok Build on this machine/);
      assert.match(said(), /Grok Build +~\/\.grok\/hooks\/\{tricot-steps\.mjs, tricot-describe\.mjs, tricot-steps\.json\}/);
      assert.equal(grok.status(target()).state, 'on');
      assert.match(said(), /Grok Build waits for each hook/, 'what to know about it, said after installing');
      assert.equal(json(path.join(home, '.grok/hooks/tricot-steps.json')).hooks.PreToolUse[0].hooks[0].command.includes(`--url http://127.0.0.1:${port}`), true);
    });

    it('asks for Copilot CLI like the others, and a yes sets it up in its own hook file', async () => {
      mkdirSync(path.join(home, '.copilot'));
      await startAndStop('enter');
      assert.match(said(), /It found Copilot CLI on this machine/);
      assert.match(said(), /Copilot CLI +~\/\.copilot\/hooks\/\{tricot-steps\.mjs, tricot-describe\.mjs, tricot-steps\.json\}/);
      assert.equal(copilot.status(target()).state, 'on');
      assert.match(said(), /Copilot CLI waits for each hook/, 'what to know about it, said after installing');
      const command: string = json(path.join(home, '.copilot/hooks/tricot-steps.json')).hooks.PreToolUse[0].hooks[0].command;
      assert.ok(command.includes(`--url http://127.0.0.1:${port}`) && command.endsWith(' --copilot'), command);
    });

    it('finds an agent by its command on PATH too', async () => {
      const bin = path.join(scratch, 'bin');
      mkdirSync(bin);
      writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const result = await run(['--no-open'], false, { PATH: bin });
      await result.server?.close();
      servers.pop();
      assert.match(said(), /It found Codex on this machine/);
    });

    it('shows every file and line with --verbose', async () => {
      mkdirSync(path.join(home, '.claude'));
      await startAndStop(false, '--verbose');
      assert.match(said(), /Claude Code would:/);
      assert.match(said(), /"PreToolUse"/);
      assert.doesNotMatch(said(), /Every file and line: tricot --verbose/);
    });

    it("leaves a project's own Claude hook from earlier as it is, and says nothing alarming about it", async () => {
      mkdirSync(path.join(home, '.claude'));
      claude.install(target(), { url: 'http://127.0.0.1:1', source: path.join(repo, 'hooks') }, 'project');
      const projectSettings = readFileSync(path.join(project, '.claude/settings.json'), 'utf8');
      await startAndStop('enter');
      assert.doesNotMatch(said(), /work\/app|twice|take.* out/i);
      assert.equal(claude.status(target()).state, 'on');
      assert.equal(readFileSync(path.join(project, '.claude/settings.json'), 'utf8'), projectSettings);
    });
  });

  describe('tricot steps', () => {
    it("says each agent's state, and where", async () => {
      mkdirSync(path.join(home, '.codex'));
      mkdirSync(path.join(home, '.pi'));
      pi.install(target(), { url: 'http://127.0.0.1:1', source: path.join(repo, 'hooks'), name: 'Pi' });
      codex.install(target(), { url: 'http://127.0.0.1:1', source: path.join(repo, 'hooks') });
      const result = await run(['steps', 'status']);
      assert.equal(result.exitCode, 0);
      const text = said();
      assert.match(text, /Claude Code +not on this machine/);
      assert.match(text, /Codex +on +~\/\.codex\/hooks\.json, sends as Codex/);
      assert.match(text, /Needs your OK in Codex's \/hooks/);
      assert.match(text, /Pi +on +~\/\.pi\/agent\/extensions\/tricot-steps\//);
      assert.match(text, /OMP +not on this machine/);

      out = [];
      assert.equal((await run(['steps'])).exitCode, 0, 'status is the default');
      assert.match(said(), /Live steps, for every project on this machine/);
      out = [];
      await run(['steps', 'status', '--agent', 'pi']);
      assert.doesNotMatch(said(), /Codex/);
    });

    it('turns them on and off, showing the lines and asking first', async () => {
      mkdirSync(path.join(home, '.claude'));
      mkdirSync(path.join(home, '.omp'));
      assert.equal((await run(['steps', 'on'], false)).exitCode, 0);
      assert.deepEqual(questions, ['Turn on live steps for Claude Code and OMP?']);
      assert.match(said(), /Claude Code, for every project, would:/);
      assert.match(said(), /add to ~\/\.claude\/settings\.json/);
      assert.match(said(), /Nothing was changed/);
      assert.equal(claude.status(target()).state, 'off');

      assert.equal((await run(['steps', 'on'], 'enter')).exitCode, 0);
      assert.equal(claude.status(target()).state, 'off', 'a bare Enter is no here');

      assert.equal((await run(['steps', 'on'], true)).exitCode, 0);
      assert.equal(claude.status(target()).state, 'on');
      assert.equal(existsSync(path.join(home, '.omp/agent/extensions/tricot-steps/index.ts')), true);
      assert.equal(remembered().how, 'steps on', 'the first tricot then asks nothing');

      out = [];
      assert.equal((await run(['steps', 'on', '--yes'])).exitCode, 0);
      assert.match(said(), /already on/);

      out = [];
      assert.equal((await run(['steps', 'off', '--agent', 'omp', '--yes'])).exitCode, 0);
      assert.match(said(), /delete ~\/\.omp\/agent\/extensions\/tricot-steps\/index\.ts/);
      assert.equal(existsSync(path.join(home, '.omp/agent/extensions/tricot-steps')), false);
      assert.equal(claude.status(target()).state, 'on', 'only that agent');

      assert.equal((await run(['steps', 'off', '--yes'])).exitCode, 0);
      assert.equal(claude.status(target()).state, 'off');
      out = [];
      assert.equal((await run(['steps', 'off', '--yes'])).exitCode, 0);
      assert.match(said(), /aren't on for any agent/);
    });

    it('names the agent with --name, for one agent', async () => {
      mkdirSync(path.join(home, '.claude'));
      assert.equal((await run(['steps', 'on', '--agent', 'claude', '--name', 'Claude (reviewer)', '--yes'])).exitCode, 0);
      assert.equal(claude.status(target()).sendsAs, 'Claude (reviewer)');
      assert.equal((await run(['steps', 'on', '--name', 'X', '--yes'])).exitCode, 1);
      assert.match(err.join('\n'), /--name is for one agent/);
    });

    it("never touches a project's own hook, and says calmly in status that it is there", async () => {
      mkdirSync(path.join(home, '.claude'));
      claude.install(target(), { url: 'http://127.0.0.1:1', source: path.join(repo, 'hooks') }, 'project');
      const projectSettings = readFileSync(path.join(project, '.claude/settings.json'), 'utf8');
      out = [];
      await run(['steps', 'status']);
      assert.match(said(), /~\/work\/app has its own hook from earlier, so steps show from that project/);
      assert.equal((await run(['steps', 'on', '--agent', 'claude', '--yes'])).exitCode, 0);
      assert.doesNotMatch(said(), /twice/);
      assert.equal((await run(['steps', 'off', '--agent', 'claude', '--yes'])).exitCode, 0);
      assert.equal((await run(['steps', 'on', '--agent', 'claude', '--yes'])).exitCode, 0);
      assert.equal(readFileSync(path.join(project, '.claude/settings.json'), 'utf8'), projectSettings, 'on, off and on again: untouched');
      out = [];
      await run(['steps', 'status']);
      assert.match(said(), /Also set up in ~\/work\/app from earlier; steps still show once/);
      assert.match(said(), /To tidy up: tricot steps off --agent claude --project, run in ~\/work\/app/);
      assert.equal((await run(['steps', 'on', '--keep-project-hook'])).exitCode, 1, 'no such option now');
    });

    it('fails with a reason, and changes nothing', async () => {
      mkdirSync(path.join(home, '.claude'));
      assert.equal((await run(['steps', 'on'])).exitCode, 1, 'no terminal, no --yes');
      assert.match(err.join('\n'), /add --yes; nothing was changed/);
      assert.equal((await run(['steps', 'on', '--agent', 'cursor', '--yes'])).exitCode, 1);
      assert.match(err.join('\n'), /no live steps for "cursor"/);
      assert.equal((await run(['steps', 'on', '--agent', 'pi', '--yes'])).exitCode, 1);
      assert.match(err.join('\n'), /Pi isn't on this machine/);
      assert.equal((await run(['steps', 'sideways'])).exitCode, 1);
      writeFileSync(path.join(home, '.claude/settings.json'), '{ not json');
      assert.equal((await run(['steps', 'on', '--yes'])).exitCode, 1);
      assert.match(err.join('\n'), /left as it is/);
      assert.equal(readFileSync(path.join(home, '.claude/settings.json'), 'utf8'), '{ not json');
      assert.equal(claude.status(target()).state, 'off');

      rmSync(path.join(home, '.claude'), { recursive: true });
      assert.equal((await run(['steps', 'on', '--yes'])).exitCode, 1);
      assert.match(err.join('\n'), /found none of Claude Code, Codex, Pi, OMP, Gemini CLI, OpenCode, Goose, Hermes Agent, Grok Build and Copilot CLI/);
    });
  });

  describe('the names it had before', () => {
    it('refuses `tricot hooks`, as any command it does not have, and writes nothing', async () => {
      mkdirSync(path.join(home, '.claude'));
      for (const argv of [['hooks'], ['hooks', 'status'], ['hooks', 'on', '--yes'], ['hooks', 'off', '--yes']]) {
        err.length = 0;
        assert.equal((await run(argv, true)).exitCode, 1, argv.join(' '));
        assert.deepEqual(err, ['Unknown command "hooks". Did you mean "steps"? (hooks was renamed)'], argv.join(' '));
      }
      assert.deepEqual(questions, []);
      assert.equal(claude.status(target()).state, 'off');
      assert.equal(remembered(), undefined);
    });

    it('refuses --no-hooks, --hooks and --remove-hooks, as options it does not have', async () => {
      mkdirSync(path.join(home, '.claude'));
      for (const flag of ['--no-hooks', '--hooks', '--remove-hooks']) {
        err.length = 0;
        const result = await run(['--no-open', flag], true);
        assert.equal(result.exitCode, 1, flag);
        assert.equal(result.server, undefined, `${flag}: nothing started`);
        assert.match(err.join('\n'), new RegExp(`Unknown option '${flag}'`));
      }
      assert.deepEqual(questions, [], 'and nothing was asked');
    });

    it('still starts from the line an update by Tricot 0.1.3 or earlier runs, which has --no-hooks in it, and asks nothing', async () => {
      mkdirSync(path.join(home, '.claude'));
      const result = await run(['start', '--port', String(port), '--host', '127.0.0.1', '--data', dataDir, '--no-open', '--no-hooks', '--no-update-check'], true);
      assert.equal(result.exitCode, 0, err.join('\n'));
      assert.ok(result.server, 'it started');
      assert.deepEqual(questions, []);
      assert.equal(remembered(), undefined);
      // The same flag typed with anything else around it is refused as above.
      await servers.pop()?.close();
      assert.equal((await run(['start', '--no-open', '--no-hooks'], true)).exitCode, 1);
    });
  });
});

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
