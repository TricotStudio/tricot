import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AGENTS } from '../src/cli/agentCommand';
import { COMMANDS, parseOptions, type CliCommand } from '../src/cli/commands';
import { closestCommand, commandHelp, isKnownCommand, mainHelp, unknownCommand } from '../src/cli/help';
import { runCli } from '../src/cli/main';
import { NO_OPEN } from '../src/cli/options';

// The table of commands (cli/commands.ts) is the one place a command is told: running
// it, `tricot --help`, its own help, the closest command to a typo and the options the
// parser takes all read it. These tests are about the table itself; what each command
// says and does is in cli.test.ts, cliHelp.test.ts and the others.
describe('the table of commands', () => {
  let scratch: string;
  let out: string[];
  let err: string[];

  const run = (...argv: string[]) => {
    out = [];
    err = [];
    return runCli(argv, {
      env: { TRICOT_DATA_DIR: path.join(scratch, 'data'), PATH: path.join(scratch, 'no-agents') },
      root: scratch,
      entry: path.join(scratch, 'tricot.ts'),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      open: () => undefined,
    });
  };

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-commands-'));
    writeFileSync(path.join(scratch, 'package.json'), '{"name":"tricot","version":"9.9.9"}');
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it('has each command once, and an entry for every agent the registry has', () => {
    const names = COMMANDS.map((command) => command.name);
    assert.equal(new Set(names).size, names.length);
    for (const id of Object.keys(AGENTS)) assert.ok(names.includes(id), id);
    assert.equal(names.length, Object.keys(AGENTS).length + 7, 'start, status, stop, connect, steps, access and update, and the agents');
  });

  it('says every option the same way wherever it is named: one type, one short name', () => {
    const shape = new Map<string, string>();
    for (const { name, options } of COMMANDS) {
      for (const option of options) {
        const here = `${option.type} ${option.short ?? ''}`;
        assert.equal(shape.get(option.name) ?? here, here, `--${option.name} in ${name}`);
        shape.set(option.name, here);
      }
    }
    assert.deepEqual(Object.keys(parseOptions()).filter((name) => !shape.has(name)).sort(), ['help', 'host', 'stop-with-agents', 'version']);
  });

  it('is what every command answers to: its help, its place in the main help, and its name as a typo', async () => {
    for (const { name, summary, help, options } of COMMANDS) {
      const text = commandHelp(name) ?? '';
      assert.ok(text.startsWith(help.title), name);
      for (const option of options) assert.ok(text.includes(option.usage), `${name} lists ${option.usage}`);
      assert.ok(isKnownCommand(name), name);
      if (summary) assert.ok(mainHelp('9.9.9').includes(summary.split(' ').slice(0, 4).join(' ')), `the main help has the line for ${name}`);
      assert.equal(unknownCommand(`${name}x`), `Unknown command "${name}x". Did you mean "${name}"?`);
    }
  });

  it('gives a typo as near to a command as to an agent to the command: the commands come before the agents', () => {
    // "eps" is one edit from steps and from pi, and shares no start with either.
    assert.equal(closestCommand('eps'), 'steps');
    assert.equal(closestCommand('tmps'), 'steps');
  });

  it('takes every command\'s options with every command, as it always has', async () => {
    for (const { options } of COMMANDS) {
      for (const option of options.filter((o) => o.type === 'boolean' && o.name !== 'help' && o.name !== 'version')) {
        const { exitCode } = await run('status', `--${option.name}`);
        assert.equal(exitCode, 1, `status --${option.name} is refused for nothing running, not for the option`);
        assert.match(out.join('\n'), /isn't running/);
      }
    }
  });

  it('makes a new command one entry: its run, its help, its line in --help, its options and its typo', async () => {
    const shout = { name: 'shout', type: 'string', usage: '--shout <word>', words: 'What to say' } as const;
    const entry: CliCommand = {
      name: 'shout',
      summary: 'Say something loud',
      options: [shout, NO_OPEN],
      help: { title: 'tricot shout: say something loud', usage: ['tricot shout [options]'], about: ['Says it.'] },
      run: async (env, { arg }) => {
        env.ctx.out(`${(env.values as { shout?: string }).shout ?? 'nothing'} ${arg ?? ''}`.trim());
        return { exitCode: 3 };
      },
    };
    COMMANDS.push(entry);
    try {
      assert.equal((await run('shout', 'twice', '--shout', 'hey')).exitCode, 3);
      assert.deepEqual(out, ['hey twice']);
      assert.equal((await run('shout', '--help')).exitCode, 0);
      assert.match(out[0], /^tricot shout: say something loud\n\nUsage\n {2}tricot shout \[options\]\n\nSays it\.\n\nOptions\n {2}--shout <word> {2,}What to say\n/);
      assert.equal((await run('--help')).exitCode, 0);
      assert.match(out[0], /\n {2}tricot shout {12}Say something loud\n/);
      assert.equal((await run('shuot')).exitCode, 1);
      assert.deepEqual(err, ['Unknown command "shuot". Did you mean "shout"?']);
    } finally {
      COMMANDS.splice(COMMANDS.indexOf(entry), 1);
    }
    assert.equal((await run('shout')).exitCode, 1);
    assert.match(err[0], /^Unknown command "shout"\./);
  });
});
