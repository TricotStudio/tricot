import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { currentOs, isWindows } from '../src/platform/os';
import { dataDirIn, defaultDataPath, home, osHome, tmpDir } from '../src/platform/paths';
import { stopProcess } from '../src/platform/stop';
import { which } from '../src/platform/which';
import { lockFile } from '../src/platform/lock';
import { WINDOWS } from './platform';

const HOOK = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'hooks/tricot-approve.mjs');

describe('The platform layer', () => {
  let scratch: string;
  before(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-platform-'));
  });
  after(() => rmSync(scratch, { recursive: true, force: true }));

  it('gives the data folder under a home folder, and the home folder either way', () => {
    assert.equal(dataDirIn('/home/sam'), path.join('/home/sam', '.tricot'));
    assert.equal(defaultDataPath(), path.join(os.homedir(), '.tricot'));
    assert.equal(osHome(), os.homedir());
    assert.equal(tmpDir(), os.tmpdir());
    assert.equal(home({ HOME: '/elsewhere' }, 'linux'), '/elsewhere', "an environment's own HOME wins");
    assert.equal(home({}, 'linux'), os.homedir(), 'else the operating system says');
    assert.equal(home({ HOME: '/elsewhere', USERPROFILE: 'C:\\Users\\sam' }, 'win32'), 'C:\\Users\\sam', "on Windows it is USERPROFILE's, where the agents keep their settings (windowsLaunch.test.ts)");
  });

  it('names the operating system, which a caller can stand in for', () => {
    assert.equal(currentOs(), process.platform);
    assert.equal(isWindows(), process.platform === 'win32');
    assert.equal(isWindows('win32'), true);
    assert.equal(isWindows('darwin'), false);
    assert.equal(isWindows('linux'), false);
  });

  it("finds a program on the PATH it is given, and with Windows' extensions when it is Windows", () => {
    const bin = path.join(scratch, 'bin');
    mkdirSync(bin, { recursive: true });
    const plain = path.join(bin, 'agent');
    const cmd = path.join(bin, 'wagent.cmd');
    for (const file of [plain, cmd]) {
      writeFileSync(file, '#!/bin/sh\n');
      chmodSync(file, 0o755);
    }
    const env = { PATH: ['/no/such/folder', bin].join(path.delimiter) };
    assert.equal(which('agent', env, 'linux'), plain);
    assert.equal(which('wagent', env, 'win32'), cmd, '.cmd is tried on Windows');
    if (!WINDOWS) assert.equal(which('wagent', env, 'linux'), undefined, 'and only there');
    assert.equal(which('agent', {}), undefined, 'no PATH, no program');
    assert.equal(which('nothing-like-it', env), undefined);
  });

  it('stops a process, and its whole group when asked', { skip: WINDOWS && 'Windows has no process groups' }, async () => {
    for (const group of [false, true]) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      await new Promise((resolve) => child.once('spawn', resolve));
      const ended = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
      stopProcess(child.pid!, 'SIGTERM', { group });
      assert.equal(await ended, 'SIGTERM');
    }
    assert.throws(() => stopProcess(2 ** 22 + 12345), 'there is no such process');
  });

  // hooks/tricot-approve.mjs runs by itself from an agent's settings, so it can't
  // import the platform layer: it decides the default data folder on its own. Here
  // it is run with no --data and no TRICOT_DATA_DIR, and the only lock is in the
  // folder this layer gives: it finds it (it sends its request to the address the
  // lock names), and does not when the lock is anywhere else.
  describe('the approval hook', () => {
    const run = async (lockIn: (homeFolder: string) => string) => {
      const homeFolder = mkdtempSync(path.join(scratch, 'home-'));
      let reached = 0;
      const server = createServer((req, res) => {
        reached += 1;
        req.resume();
        res.statusCode = 500;
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as AddressInfo).port;
      try {
        const folder = lockIn(homeFolder);
        mkdirSync(folder, { recursive: true });
        writeFileSync(lockFile(folder), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), port, host: '127.0.0.1', instance: 'platform-test-instance', secret: 'platform-test-secret-platform-test-secret' }), { mode: 0o600 });
        const event = { session_id: 's1', cwd: scratch, permission_mode: 'default', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } };
        const hook = spawn(process.execPath, [HOOK, '--url', `http://127.0.0.1:${port}`, '--name', 'Claude'], { env: { PATH: process.env.PATH, HOME: homeFolder, USERPROFILE: homeFolder }, stdio: ['pipe', 'ignore', 'ignore'] });
        hook.stdin.end(JSON.stringify(event));
        await new Promise((resolve) => hook.once('close', resolve));
        return reached;
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    };

    it("looks for Tricot's lock in the folder the platform layer gives as the default", async () => {
      assert.ok((await run((homeFolder) => dataDirIn(homeFolder))) > 0, 'found the lock, so it asked Tricot');
    });

    it('does not find a lock kept anywhere else', async () => {
      assert.equal(await run((homeFolder) => path.join(homeFolder, '.not-tricot')), 0);
    });
  });
});
