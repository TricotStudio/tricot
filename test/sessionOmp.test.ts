import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ompSession } from '../src/cli/agentSessions/omp';
import { WINDOWS } from './platform';

// OMP for one session (cli/agentSessions/omp.ts): `-e <folder>`, and the
// folder holds one file, the board's entry.
const URL = 'http://127.0.0.1:4545/mcp?agent=OMP';
const setup = { url: URL, message: 'Use the Tricot board b1 and start listening.', passthrough: [] as string[] };

describe('OMP, for one session', () => {
  it('is started with -e and a folder of its own, then what came after --, then the first message', () => {
    const launch = ompSession({ ...setup, passthrough: ['--model', 'opus'] });
    try {
      const [flag, folder, ...rest] = launch.args;
      assert.equal(flag, '-e');
      assert.deepEqual(rest, ['--model', 'opus', setup.message]);
      if (!WINDOWS) assert.equal(statSync(folder).mode & 0o777, 0o700, "private to this account's");
      assert.deepEqual(readdirSync(folder), ['.mcp.json'], 'one file, and no extension code');
      if (!WINDOWS) assert.equal(statSync(path.join(folder, '.mcp.json')).mode & 0o777, 0o600);
      assert.deepEqual(launch.env, {});
    } finally {
      launch.cleanup!();
    }
  });

  it("holds one http server named tricot, at the board's address with OMP's name on it, that waits five minutes", () => {
    const launch = ompSession(setup);
    try {
      assert.deepEqual(JSON.parse(readFileSync(path.join(launch.args[1], '.mcp.json'), 'utf8')), { mcpServers: { tricot: { type: 'http', url: URL, timeout: 300_000 } } });
    } finally {
      launch.cleanup!();
    }
  });

  it('with a token, sends it as a header OMP fills in from its environment: the token is in its environment alone', () => {
    const launch = ompSession({ ...setup, token: 's3cret' });
    try {
      const file = readFileSync(path.join(launch.args[1], '.mcp.json'), 'utf8');
      assert.deepEqual(JSON.parse(file).mcpServers.tricot.headers, { Authorization: 'Bearer ${TRICOT_TOKEN}' });
      assert.ok(!file.includes('s3cret'), 'not in the file');
      assert.ok(!launch.args.join(' ').includes('s3cret'), 'not in an argument');
      assert.deepEqual(launch.env, { TRICOT_TOKEN: 's3cret' });
    } finally {
      launch.cleanup!();
    }
  });

  it("says in a few plain words, no path and no raw error, when the folder can't be made", { skip: WINDOWS && 'Windows takes its temporary folder from TEMP, not TMPDIR' }, () => {
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = path.join(os.tmpdir(), 'tricot-no-such-folder-for-omp');
    try {
      assert.throws(() => ompSession(setup), (error: Error) => error.message === "Tricot couldn't make a folder for the session (ENOENT).");
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  it('removes its folder when OMP is done, however often it is asked', () => {
    const launch = ompSession(setup);
    const folder = launch.args[1];
    assert.equal(existsSync(folder), true);
    launch.cleanup!();
    assert.equal(existsSync(folder), false);
    launch.cleanup!();
  });
});
