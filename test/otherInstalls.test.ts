import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CommandResult, CommandToRun } from '../src/cli/connectAgent';
import { unknownCommand } from '../src/cli/help';
import { runCli, type CliContext } from '../src/cli/main';
import { findInstalls, olderThanBoard, removalOf } from '../src/cli/otherInstalls';
import { removeScratch, WINDOWS } from './platform';
import { registrySays } from './updateFixtures';

// Two Tricots installed: an old `npm install -g` under nvm that comes first on
// the PATH, and Homebrew's newer one. Nothing here runs either: ctx.exec
// stands in, and answers `--version` as each would.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Tricot installed twice', { skip: WINDOWS && 'lays out the installs with symbolic links and scripts' }, () => {
  let scratch: string;
  let dataDir: string;
  let npmBin: string; // the old one, first on the PATH
  let brewBin: string;
  let npmRoot: string; // its package folder: what the old command runs from
  let brewRoot: string;
  let out: string[];
  let err: string[];
  let versions: Record<string, string | undefined>; // by file asked
  let asked: CommandToRun[];

  const install = (root: string, bin: string, version: string, target: string) => {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '#!/bin/sh\n');
    chmodSync(target, 0o755);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'tricot', version }));
    mkdirSync(bin, { recursive: true });
    symlinkSync(path.relative(bin, target), path.join(bin, 'tricot'));
  };

  const ctx = (root: string, extra: Partial<CliContext> = {}): CliContext => ({
    env: { TRICOT_DATA_DIR: dataDir, PORT: '45999', PATH: [npmBin, brewBin].join(path.delimiter) },
    root,
    entry: path.join(repo, 'src/cli/tricot.ts'),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    open: () => {},
    exec: async (command): Promise<CommandResult> => {
      asked.push(command);
      const version = versions[command.command];
      return version === undefined ? { exitCode: 1, stdout: '', stderr: 'broken' } : { exitCode: 0, stdout: `${version}\n`, stderr: '' };
    },
    ...extra,
  });

  const boardRuns = (version: string) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, 'server.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), version }));
  };

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-installs-'));
    dataDir = path.join(scratch, 'data');
    out = [];
    err = [];
    asked = [];
    npmBin = path.join(scratch, '.nvm', 'versions', 'node', 'v22.1.0', 'bin');
    npmRoot = path.join(scratch, '.nvm', 'versions', 'node', 'v22.1.0', 'lib', 'node_modules', 'tricot');
    install(npmRoot, npmBin, '0.1.1', path.join(npmRoot, 'dist', 'cli', 'tricot.js'));
    brewBin = path.join(scratch, 'homebrew', 'bin');
    const cellar = path.join(scratch, 'homebrew', 'Cellar', 'tricot', '0.1.4');
    brewRoot = path.join(cellar, 'libexec', 'lib', 'node_modules', 'tricot');
    mkdirSync(brewRoot, { recursive: true });
    install(brewRoot, brewBin, '0.1.4', path.join(cellar, 'bin', 'tricot'));
    versions = { [path.join(brewBin, 'tricot')]: '0.1.4', [path.join(npmBin, 'tricot')]: '0.1.1' };
  });
  afterEach(() => removeScratch(scratch));

  describe('what the PATH holds', () => {
    it('lists each install once, the first one running, with its version and how to remove it', async () => {
      const found = await findInstalls(ctx(npmRoot), '0.1.1');
      assert.deepEqual(
        found.map(({ file, runs, here, version, remove }) => ({ file, runs, here, version, remove })),
        [
          { file: path.join(npmBin, 'tricot'), runs: true, here: true, version: '0.1.1', remove: 'npm uninstall -g tricot' },
          { file: path.join(brewBin, 'tricot'), runs: false, here: false, version: '0.1.4', remove: 'brew uninstall tricotstudio/tap/tricot' },
        ],
      );
      assert.match(found[0].removeNote ?? '', /Node v22\.1\.0.*nvm use v22\.1\.0/);
      assert.equal(found[1].removeNote, undefined);
    });

    it('asks only the others their version, with a short limit, and never this command', async () => {
      await findInstalls(ctx(npmRoot), '0.1.1');
      assert.deepEqual(asked.map(({ command, args, timeoutMs }) => ({ command, args, timeoutMs })), [{ command: path.join(brewBin, 'tricot'), args: ['--version'], timeoutMs: 3000 }]);
    });

    it('counts a folder listed twice, or two links to one file, once', async () => {
      const twice = ctx(npmRoot);
      twice.env.PATH = [npmBin, brewBin, npmBin, brewBin].join(path.delimiter);
      assert.equal((await findInstalls(twice, '0.1.1')).length, 2);
      const alias = path.join(scratch, 'alias');
      mkdirSync(alias);
      symlinkSync(path.join(brewBin, 'tricot'), path.join(alias, 'tricot'));
      twice.env.PATH = [npmBin, brewBin, alias].join(path.delimiter);
      assert.equal((await findInstalls(twice, '0.1.1')).length, 2);
    });

    it('says nothing of a version it cannot read: a failure, an answer that is not a version, a command that cannot run', async () => {
      for (const exec of [
        async (): Promise<CommandResult> => ({ exitCode: 1, stdout: '0.1.4', stderr: '' }),
        async (): Promise<CommandResult> => ({ exitCode: 0, stdout: 'Node.js is too old', stderr: '' }),
        async (): Promise<CommandResult> => ({ stdout: '', stderr: '', timedOut: true }),
        async (): Promise<CommandResult> => ({ stdout: '', stderr: '', problem: 'spawn failed' }),
        async (): Promise<CommandResult> => {
          throw new Error('refused');
        },
      ]) {
        const found = await findInstalls(ctx(npmRoot, { exec }), '0.1.1');
        assert.equal(found[1].version, undefined);
      }
      const none = await findInstalls(ctx(npmRoot, { exec: undefined }), '0.1.1');
      assert.equal(none[1].version, undefined, 'with nothing to run it with, none is run');
    });

    it('infers how the Homebrew one is removed when this command runs from it, and marks that one', async () => {
      const found = await findInstalls(ctx(brewRoot), '0.1.4');
      assert.deepEqual(found.map((i) => i.here), [false, true]);
      assert.deepEqual(asked.map((a) => a.command), [path.join(npmBin, 'tricot')]);
    });

    it('gives no command for a file it cannot tell the origin of', () => {
      const loose = path.join(scratch, 'loose', 'tricot');
      mkdirSync(path.dirname(loose));
      writeFileSync(loose, '#!/bin/sh\n');
      assert.deepEqual(removalOf(loose), {});
    });
  });

  describe('tricot update', () => {
    const update = (root: string, latest = '0.1.4') => {
      const context = ctx(root);
      context.env.TRICOT_UPDATE_URL = registrySays({ name: 'tricot', version: latest });
      return runCli(['update'], context);
    };

    it('says the command is older than the board, lists both installs, and gives the command to remove the old one', async () => {
      boardRuns('0.1.4');
      const { exitCode } = await update(npmRoot);
      assert.equal(exitCode, 0);
      assert.deepEqual(out, [
        'This command is 0.1.1 but the board runs 0.1.4.',
        'Tricot is installed more than once on your PATH, and the first one is what `tricot` runs:',
        `  ${path.join(npmBin, 'tricot')}  0.1.1  (runs when you type tricot, this command)`,
        `  ${path.join(brewBin, 'tricot')}  0.1.4`,
        "Tricot removes nothing itself. To remove the one you don't want:",
        `  ${path.join(npmBin, 'tricot')} (0.1.1, installed under Node v22.1.0, so run \`nvm use v22.1.0\` first):`,
        '    npm uninstall -g tricot',
        'Tricot 0.1.4 is the latest.',
      ]);
      assert.deepEqual(err, []);
    });

    it('names no install when the PATH holds only this one, and removes nothing', async () => {
      boardRuns('0.1.4');
      const context = ctx(npmRoot);
      context.env.PATH = npmBin;
      context.env.TRICOT_UPDATE_URL = registrySays({ name: 'tricot', version: '0.1.4' });
      await runCli(['update'], context);
      assert.deepEqual(out, ['This command is 0.1.1 but the board runs 0.1.4.', 'Tricot 0.1.4 is the latest.']);
      assert.deepEqual(asked, []);
    });

    it('stays quiet when the command is as new as the board, whatever else the PATH holds', async () => {
      boardRuns('0.1.4');
      await update(brewRoot);
      assert.deepEqual(out, ['Tricot 0.1.4 is the latest.']);
      assert.deepEqual(asked, [], 'no other install is asked anything');
    });

    it('stays quiet when no board is running: the command is the one asked about', async () => {
      await update(npmRoot, '0.1.1');
      assert.deepEqual(out, ['Tricot 0.1.1 is the latest.']);
      assert.deepEqual(asked, []);
    });

    it('lets --version stay the command’s own', async () => {
      boardRuns('0.1.4');
      await runCli(['--version'], ctx(npmRoot));
      assert.deepEqual(out, ['0.1.1']);
      assert.deepEqual(asked, []);
    });

    it('gives a neutral line for an install it cannot tell the origin of', () => {
      const lines = olderThanBoard(
        [
          { file: '/opt/mine/bin/tricot', runs: true, here: true, version: '0.1.1' },
          { file: '/opt/homebrew/bin/tricot', runs: false, here: false, version: '0.1.4' },
        ],
        '0.1.1',
        '0.1.4',
      );
      assert.ok(lines.includes('  /opt/mine/bin/tricot (0.1.1): remove that file, with whatever installed it'), lines.join('\n'));
    });
  });

  describe('a command it does not know', () => {
    it('names the other install when its version is another one', async () => {
      const { exitCode } = await runCli(['claud'], ctx(brewRoot));
      assert.equal(exitCode, 1);
      assert.deepEqual(err, [`Unknown command "claud". Did you mean "claude"? This \`tricot\` is 0.1.4, and 0.1.1 is installed at ${npmBin}.`]);
    });

    it('says the same for --help of one', async () => {
      await runCli(['nonsense', '--help'], ctx(npmRoot));
      assert.deepEqual(err, [`Unknown command "nonsense". Run tricot --help to see the commands. This \`tricot\` is 0.1.1, and 0.1.4 is installed at ${brewBin}.`]);
    });

    it('says nothing of another install with the same version, or one whose version it cannot read', async () => {
      versions[path.join(brewBin, 'tricot')] = '0.1.1';
      await runCli(['nonsense'], ctx(npmRoot));
      versions[path.join(brewBin, 'tricot')] = undefined;
      await runCli(['nonsense'], ctx(npmRoot));
      assert.deepEqual(err, Array(2).fill('Unknown command "nonsense". Run tricot --help to see the commands.'));
    });

    it('is the same line as before when there is no other install', async () => {
      const context = ctx(npmRoot);
      context.env.PATH = npmBin;
      await runCli(['nonsense'], context);
      assert.deepEqual(err, [unknownCommand('nonsense')]);
    });
  });
});
