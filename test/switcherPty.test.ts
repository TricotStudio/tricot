import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { findPtyHelper, PTY_HELPERS, spawnPty, type Pty, type PtyExit, type PtyHelper } from '../src/cli/switcher/pty';
import { alive, fixtures, leftAfterReaping, node, sleep, trackPty, waitFor } from './switcher/harness';

// Each agent's own pseudo-terminal, through each helper this machine has:
// Perl's IO::Pty (macOS ships it), Python's pty module, and the `script`
// command. Every one starts the agent at the size asked, resizes it, passes
// keys through untouched, reports how it ended, and takes it down when
// Tricot goes, however Tricot goes. Nothing is left running after them all.

after(async () => assert.deepEqual(await leftAfterReaping(), [], 'nothing left running'));

// A tiny agent: says its size, then each resize and each key it gets, as hex.
const PROBE = `
const say = (s) => process.stdout.write(s + '\\n');
say('size ' + process.stdout.columns + 'x' + process.stdout.rows);
process.on('SIGWINCH', () => setTimeout(() => say('resized ' + process.stdout.columns + 'x' + process.stdout.rows), 20));
process.stdin.setRawMode(true);
process.stdin.on('data', (d) => { say('keys ' + d.toString('hex')); if (d.includes(0x71)) process.exit(5); });
`;

function run(helper: PtyHelper, command: string, args: string[], size = { cols: 77, rows: 21 }): { pty: Pty; output: () => string; exited: Promise<PtyExit> } {
  let output = '';
  const pty = trackPty(spawnPty(command, args, { ...size, helper, env: { ...process.env, TERM: 'xterm-256color' } }));
  pty.onData((data) => (output += data.toString()));
  return { pty, output: () => output, exited: new Promise((resolve) => pty.onExit(resolve)) };
}

for (const name of PTY_HELPERS) {
  const helper = findPtyHelper({ ...process.env, TRICOT_PTY: name });
  describe(`the ${name} pty helper`, { skip: 'problem' in helper && helper.problem, timeout: 30_000 }, () => {
    const it_ = helper as PtyHelper;

    it('starts the agent at the size asked, resizes it, and passes every key through as it was typed', async () => {
      const agent = run(it_, node, ['-e', PROBE]);
      assert.ok((await agent.pty.ready) > 0, 'its pid');
      assert.ok(await waitFor(() => agent.output().includes('size 77x21')), agent.output());
      agent.pty.resize(120, 40);
      assert.ok(await waitFor(() => agent.output().includes('resized 120x40')), agent.output());
      // Ctrl+C, an arrow, Ctrl+\, Ctrl+], a paste: bytes, not signals, in raw mode.
      agent.pty.write('\x03\x1b[A\x1c\x1d');
      assert.ok(await waitFor(() => agent.output().includes('keys 031b5b411c1d')), agent.output());
      agent.pty.write('q');
      assert.deepEqual(await agent.exited, { exitCode: 5 });
    });

    it("reports the agent's exit code, 128 and the signal when one ended it, and 127 when it can't start", async () => {
      assert.deepEqual(await run(it_, '/bin/sh', ['-c', 'exit 3']).exited, { exitCode: 3 });
      const missing = run(it_, '/no/such/agent', []);
      assert.equal((await missing.exited).exitCode, 127);
      // macOS and bash say "No such file or directory"; Linux's sh (dash) says "not found".
      assert.match(missing.output(), /No such file or directory|not found/);
      const sleeper = run(it_, '/bin/sleep', ['30']);
      await sleeper.pty.ready;
      await sleep(100);
      sleeper.pty.kill('SIGTERM');
      const ended = await sleeper.exited;
      assert.equal(ended.exitCode, 128 + 15);
    });

    it('hangs the agent up when Tricot lets go of it', async () => {
      const sleeper = run(it_, '/bin/sleep', ['30']);
      const pid = await sleeper.pty.ready;
      await sleep(100);
      sleeper.pty.dispose();
      await sleeper.exited;
      assert.ok(await waitFor(() => !alive(pid), 4_000), 'the agent is gone');
    });

    it('takes the agent down when Tricot is killed outright', async () => {
      const parent = spawn(node, ['--import', 'tsx', path.join(fixtures, 'ptyParent.ts'), name], { stdio: ['ignore', 'pipe', 'inherit'] });
      let said = '';
      parent.stdout.on('data', (data) => (said += data));
      let pid = 0;
      try {
        assert.ok(await waitFor(() => /^\d+\n/.test(said), 10_000), 'the agent started');
        pid = Number(said.trim());
        assert.ok(alive(pid));
        parent.kill('SIGKILL');
        assert.ok(await waitFor(() => !alive(pid), 5_000), 'the agent went with it');
      } finally {
        // However it went: the parent, and an agent that outlived it.
        parent.kill('SIGKILL');
        if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
      }
    });
  });
}

describe('finding a helper', () => {
  it('takes TRICOT_PTY when it names one, and says what is wrong when it names none', () => {
    assert.match((findPtyHelper({ ...process.env, TRICOT_PTY: 'tmux' }) as { problem: string }).problem, /use perl, python or script/);
    const found = findPtyHelper(process.env);
    assert.ok(!('problem' in found), 'this Mac has at least one');
    if (process.platform === 'darwin') assert.equal((found as PtyHelper).name, 'perl', "macOS's own Perl first");
  });
});
