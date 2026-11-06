import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENTS } from '../src/cli/agentCommand';
import { closestCommand, distance } from '../src/cli/help';
import { runCli, type CliResult } from '../src/cli/main';
import { listNames } from '../src/core/format';
import { lockFile } from '../src/platform/lock';

// `tricot --help` lists the commands and the options that go with starting or
// reaching the board; `tricot <command> --help` says what that command does and
// lists only the options it takes; an unknown command says the closest one, or
// where the commands are, and prints nothing else (cli/help.ts). Nothing here
// starts a board: help and unknown commands stop before anything runs.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('the help', () => {
  let scratch: string;
  let dataDir: string;
  let out: string[];
  let err: string[];
  let opened: string[];

  const run = async (...argv: string[]): Promise<CliResult> => {
    out = [];
    err = [];
    return runCli(argv, {
      env: { TRICOT_DATA_DIR: dataDir, PATH: path.join(scratch, 'no-agents') },
      root: scratch,
      entry: path.join(repo, 'src/cli/tricot.ts'),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      open: (url) => opened.push(url),
    });
  };
  // What a command's help says on standard output, with nothing on standard error.
  const helpOf = async (...argv: string[]): Promise<string> => {
    const { exitCode, server } = await run(...argv);
    assert.equal(exitCode, 0, argv.join(' '));
    assert.equal(server, undefined, `${argv.join(' ')} starts nothing`);
    assert.deepEqual(err, [], `${argv.join(' ')} prints nothing on standard error`);
    assert.equal(out.length, 1, 'one piece of text');
    return out[0];
  };
  // The options a help lists: its rows under "Options", by name.
  const flagsIn = (help: string): string[] => {
    const rows = help.slice(help.indexOf('\nOptions\n') + 9).split('\n\n')[0].split('\n');
    return rows.flatMap((row) => row.match(/^ {2}(?:-\w, )?(--[a-z-]+)/)?.slice(1) ?? []).sort();
  };
  const flat = (text: string) => text.replace(/\s+/g, ' ');

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-help-'));
    dataDir = path.join(scratch, 'data');
    mkdirSync(path.join(scratch, 'dist/web'), { recursive: true });
    writeFileSync(path.join(scratch, 'package.json'), '{"name":"tricot","version":"9.9.9"}');
    out = [];
    err = [];
    opened = [];
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  describe('tricot --help', () => {
    it('lists the commands and only the options that go with any of them, on one screen', async () => {
      const help = await helpOf('--help');
      assert.match(help, /^tricot 9\.9\.9: a shared planning board for you and your agents\n\nUsage\n {2}tricot \[start\] {10}Start the board, or find the running one, and open it\n/);
      for (const command of ['status', 'stop', 'connect [agent]', 'claude', 'steps', 'access', 'update']) assert.match(help, new RegExp(`\\n {2}tricot ${command.replace(/[[\]]/g, '\\$&')} +\\S`), command);
      assert.deepEqual(flagsIn(help), ['--background', '--data', '--help', '--no-open', '--no-update-check', '--port', '--version']);
      for (const own of ['--name', '--agent', '--project', '--narration', '--yes', '--board', '--no-ask', '--verbose']) assert.doesNotMatch(help, new RegExp(`\\n {2}${own}`), `${own} is under its command`);
      assert.match(help, /\n {2}-d, --background {3}Keep running after this terminal closes/);
      assert.match(help, /\n {2}-v, --version {6}Print the version/);
      assert.match(help, /\n {2}-h, --help {9}Show this help, or a command's: tricot <command> --help/);
      assert.ok(help.split('\n').length <= 30, `${help.split('\n').length} lines`);
      assert.match(help, /\n\nRun tricot <command> --help for what a command does and the options it takes\.$/, 'and points at the commands');
    });

    it('names the agent commands that start the agent and those that only show how to connect, from the agents table', async () => {
      const startable = Object.keys(AGENTS).filter((id) => AGENTS[id].session);
      const shown = Object.keys(AGENTS).filter((id) => !AGENTS[id].session);
      const [first, ...others] = startable;
      const main = flat(await helpOf('--help'));
      assert.match(main, new RegExp(`tricot ${first} Start the board and ${AGENTS[first].name} on it, in this terminal\\. Also ${listNames(others)}; several at once: tricot ${first} ${others[0]}`));
      if (shown.length) assert.match(main, new RegExp(`tricot ${shown[0]} Show how to connect ${AGENTS[shown[0]].name}`));
      for (const id of Object.keys(AGENTS)) {
        const help = flat(await helpOf(id, '--help'));
        assert.match(help, new RegExp(`^tricot ${id}: ${AGENTS[id].session ? `start the board and ${AGENTS[id].name} together` : `show how to connect ${AGENTS[id].name}`}`), id);
        if (AGENTS[id].session) {
          assert.match(help, new RegExp(`Any of ${listNames(startable)}\\.`), id);
          if (shown.length) assert.match(help, new RegExp(`${listNames(shown)} can't take the board for one session yet`), id);
        } else {
          assert.match(help, new RegExp(`tricot ${id} only shows how to connect it, as tricot connect ${id} --print does, and starts nothing`), id);
        }
      }
    });

    it('prints the version for -v and --version, even beside --help, and nothing else', async () => {
      for (const argv of [['--version'], ['-v'], ['--version', '--help'], ['-v', 'connect', '-h']]) {
        const { exitCode } = await run(...argv);
        assert.equal(exitCode, 0, argv.join(' '));
        assert.deepEqual(out, ['9.9.9'], argv.join(' '));
        assert.deepEqual(err, []);
      }
    });
  });

  describe('tricot <command> --help', () => {
    // Each command's own options, and what none of the others' lists has.
    const each: [command: string[], flags: string[]][] = [
      [['start'], ['--background', '--board', '--data', '--no-ask', '--no-open', '--no-update-check', '--port', '--verbose']],
      [['status'], ['--data']],
      [['stop'], ['--data']],
      [['connect'], ['--board', '--data', '--name', '--port', '--print', '--yes']],
      [['steps'], ['--agent', '--data', '--name', '--narration', '--port', '--project', '--yes']],
      [['access'], ['--data']],
      [['update'], ['--data', '--port']],
      [['claude'], ['--board', '--data', '--name', '--no-ask', '--no-open', '--no-update-check', '--port', '--verbose']],
      [['codex'], ['--board', '--data', '--name', '--no-ask', '--no-open', '--no-update-check', '--port', '--verbose']],
      [['opencode'], ['--board', '--data', '--name', '--no-ask', '--no-open', '--no-update-check', '--port', '--verbose']],
    ];

    it("shows the command's own options and no other command's", async () => {
      for (const [command, flags] of each) {
        const help = await helpOf(...command, '--help');
        assert.deepEqual(flagsIn(help), flags, command.join(' '));
        assert.match(help, new RegExp(`^tricot ${command[0] === 'start' ? '\\[start\\]' : command[0]}: `), 'it says what it is');
        assert.match(help, /\n\nUsage\n {2}tricot /);
        assert.match(help, /\n\nOptions\n {2}--/);
        assert.match(help, /\n\nAll the commands: tricot --help$/);
      }
    });

    it('shows the agents that only show how to connect with the options that does take', async () => {
      for (const id of Object.keys(AGENTS).filter((agent) => !AGENTS[agent].session)) {
        assert.deepEqual(flagsIn(await helpOf(id, '--help')), ['--board', '--data', '--name', '--port'], id);
      }
    });

    it('says each option as it always has, for the command that takes it', async () => {
      const connect = await helpOf('connect', '--help');
      assert.match(connect, /\n {2}--print {12}Only show the command, run nothing\n/);
      assert.match(connect, /\n {2}--yes {14}Don't ask \(it still shows what it changes\)\n/);
      assert.match(connect, /\n {2}--board <id> {7}Name this board in the connect instructions\n/);
      assert.match(connect, /\n {2}--port <n> {9}Port \(default \$PORT or 4545\)\n/);
      assert.match(flat(connect), /Connect claude, codex, pi or gemini: shows its own command, asks, and runs it\. --print only shows it \(omp, opencode, mcp-json and url are only ever shown/);

      const steps = flat(await helpOf('steps', '--help'));
      assert.match(steps, /Usage tricot steps \[status\|on\|off\] \[options\]/);
      assert.match(steps, /--agent <id> Just this agent \(claude, codex, pi, omp, gemini, opencode\)/);
      assert.match(steps, /--project on\/off, with --agent claude: only this project's \.claude\/settings\.json, not every project's \(on asks first\)/);
      assert.match(steps, /--narration on --project: also show the first line of each message Claude writes in the terminal \(never its thinking\); off unless asked for/);

      const start = await helpOf('--no-open', 'start', '--help');
      assert.match(start, /\n {2}--no-ask {11}Don't ask about live steps on the first start\n {2}--verbose {10}With that question: show every file and line first\n/);
      assert.match(start, /\n {2}--board <id> {7}Open this board\n/);
      assert.match(start, /\n {2}--no-update-check {2}Don't ask GitHub once a day whether a newer Tricot is out/);
      assert.match(start, /\n {2}-d, --background {3}Keep running after this terminal closes \(logs to <data>\/server\.log\)\n/);
    });

    it('is the same for several agents as for the first', async () => {
      const claude = await helpOf('claude', '--help');
      assert.equal(await helpOf('claude', 'codex', '--help'), claude);
      assert.equal(await helpOf('--help', 'claude', 'codex', 'opencode'), claude);
    });

    it('works with -h as with --help, wherever it comes', async () => {
      assert.equal(await helpOf('-h'), await helpOf('--help'));
      for (const command of ['connect', 'steps', 'status', 'claude']) {
        const help = await helpOf(command, '--help');
        assert.equal(await helpOf(command, '-h'), help, command);
        assert.equal(await helpOf('-h', command), help, command);
        assert.equal(await helpOf(command, '--print', '--help'), help, command);
      }
      assert.equal(await helpOf('steps', 'on', '--help'), await helpOf('steps', '--help'), 'with what it would have been given');
      assert.equal(await helpOf('access', 'revoke', '-h'), await helpOf('access', '--help'));
    });

    it('starts nothing, opens nothing, and writes nothing', async () => {
      for (const argv of [['--help'], ['start', '--help'], ['claude', '--help', '--board', 'x'], ['connect', 'claude', '-h'], ['update', '--help'], ['stop', '--help'], ['access', '-h']]) {
        const { exitCode, server } = await run(...argv);
        assert.equal(exitCode, 0, argv.join(' '));
        assert.equal(server, undefined);
      }
      assert.deepEqual(opened, []);
      assert.equal(existsSync(lockFile(dataDir)), false);
      assert.equal(existsSync(dataDir), false, 'not even the data folder');
    });

    it('is not what an agent gets after --: the words after it are the agent’s', async () => {
      // `tricot claude -- --help` goes on to the agent command (here with no agent on PATH, so it stops there).
      const { exitCode } = await run('claude', '--', '--help');
      assert.equal(exitCode, 1);
      assert.deepEqual(out, [], 'not the help of tricot');
      assert.match(err.join('\n'), /Claude Code isn't installed here/);
    });

    it('says what an unknown command says, for one that has no help', async () => {
      const { exitCode } = await run('hooks', '--help');
      assert.equal(exitCode, 1);
      assert.deepEqual(err, ['Unknown command "hooks". Did you mean "steps"? (hooks was renamed)']);
      assert.deepEqual(out, []);
      await run('foo', '-h');
      assert.deepEqual(err, ['Unknown command "foo". Run tricot --help to see the commands.']);
    });
  });

  describe('an unknown command', () => {
    const says = async (word: string, said: string[], ...rest: string[]) => {
      const { exitCode, server } = await run(word, ...rest);
      assert.equal(exitCode, 1, word);
      assert.equal(server, undefined);
      assert.deepEqual(err, said, `${word}: only that line, not the help`);
      assert.deepEqual(out, [], `${word}: nothing on standard output`);
      assert.deepEqual(opened, []);
      assert.equal(existsSync(lockFile(dataDir)), false, `${word} starts nothing`);
    };
    const didYouMean = (word: string, near: string) => [`Unknown command "${word}". Did you mean "${near}"?`];

    it('says the closest command or agent', async () => {
      const typos: [string, string][] = [
        ['stats', 'status'],
        ['stauts', 'status'],
        ['statu', 'status'],
        ['Status', 'status'],
        ['stp', 'stop'],
        ['strat', 'start'],
        ['step', 'steps'],
        ['conect', 'connect'],
        ['conncet', 'connect'],
        ['acess', 'access'],
        ['updat', 'update'],
        ['claud', 'claude'],
        ['codx', 'codex'],
        ['opnecd', 'opencode'],
        ['gemni', 'gemini'],
      ];
      for (const [typed, near] of typos) await says(typed, didYouMean(typed, near));
    });

    it('says so when the word with it has more after it, and when an option comes first', async () => {
      await says('stats', didYouMean('stats', 'status'), '--no-open');
      await says('conect', didYouMean('conect', 'connect'), 'claude', '--print');
      assert.equal((await run('--no-open', 'stats')).exitCode, 1);
      assert.deepEqual(err, didYouMean('stats', 'status'));
    });

    it('says where the commands are when none is close, not the help', async () => {
      for (const word of ['foo', 'help', 'xyzzy', 'dance', 'x', 'tricot', 'run']) await says(word, [`Unknown command "${word}". Run tricot --help to see the commands.`]);
    });

    it('says what the two names it had before were renamed to', async () => {
      await says('hooks', ['Unknown command "hooks". Did you mean "steps"? (hooks was renamed)']);
      await says('seats', ['Unknown command "seats". Did you mean "access"? (seats was renamed)']);
      await says('hooks', ['Unknown command "hooks". Did you mean "steps"? (hooks was renamed)'], 'on', '--yes');
      await says('seats', ['Unknown command "seats". Did you mean "access"? (seats was renamed)'], 'reset');
    });

    it('does not mistake a word of Object for a command', async () => {
      for (const word of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) await says(word, [`Unknown command "${word}". Run tricot --help to see the commands.`]);
    });

    it('measures a swap of two letters as one edit, and gives up beyond two, or three for longer names', () => {
      assert.equal(distance('stauts', 'status'), 1);
      assert.equal(distance('kitten', 'sitting'), 3);
      assert.equal(distance('', 'stop'), 4);
      assert.equal(closestCommand('stoop'), 'stop');
      assert.equal(closestCommand('sttus'), 'status');
      assert.equal(closestCommand('foo'), undefined, 'three edits from stop');
      assert.equal(closestCommand('hooks'), undefined, 'four from steps');
      assert.equal(closestCommand('opencd'), 'opencode', 'two edits');
      assert.equal(closestCommand('opnecd'), 'opencode', 'three, for a name of eight letters');
      assert.equal(closestCommand('stxyz'), undefined, 'three edits from stop, steps and start');
      assert.equal(closestCommand('stoppp'), 'stop', 'two edits');
      assert.equal(closestCommand('x'), undefined, 'a word of one letter is not near anything');
      assert.equal(closestCommand(''), undefined);
      assert.equal(closestCommand('step'), 'steps', 'of two as near, the one it starts like');
    });
  });

  describe('an unknown option', () => {
    // As before: the parser's message, then the help, nothing started; the help ends by pointing at the command's own.
    const refused = async (argv: string[], pointer: string) => {
      const { exitCode, server } = await run(...argv);
      assert.equal(exitCode, 1, argv.join(' '));
      assert.equal(server, undefined);
      assert.equal(err.length, 1, 'one message: the error, then the help');
      assert.match(err[0], /^Unknown option '--bogus'/);
      assert.match(err[0], /\n\ntricot 9\.9\.9: a shared planning board for you and your agents\n\nUsage\n {2}tricot \[start\] /);
      assert.ok(err[0].endsWith(`\n\n${pointer}`), `${argv.join(' ')}: ${err[0].slice(-120)}`);
      assert.equal(err[0].split('\n').length < 40, true, 'the help is short');
      assert.deepEqual(out, []);
      assert.equal(existsSync(lockFile(dataDir)), false);
    };

    it('says the error and the help, which ends by pointing at the help of the command given', async () => {
      await refused(['--bogus'], 'Run tricot <command> --help for what a command does and the options it takes.');
      await refused(['connect', '--bogus'], 'Run tricot connect --help for what it does and the options it takes.');
      await refused(['steps', 'on', '--bogus'], 'Run tricot steps --help for what it does and the options it takes.');
      await refused(['--bogus', 'claude'], 'Run tricot claude --help for what it does and the options it takes.');
      await refused(['--port', '4545', 'status', '--bogus'], 'Run tricot status --help for what it does and the options it takes.');
      await refused(['claude', 'codex', '--bogus'], 'Run tricot claude --help for what it does and the options it takes.');
      await refused(['claude', '--bogus', '--', '--help'], 'Run tricot claude --help for what it does and the options it takes.');
    });

    it('does not point at a command that is not one, and does not suggest an option', async () => {
      await refused(['foo', '--bogus'], 'Run tricot <command> --help for what a command does and the options it takes.');
      assert.doesNotMatch(err[0], /Did you mean/);
    });
  });
});
