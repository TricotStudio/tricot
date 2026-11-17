import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { acquireLock, findRunning, heldLock, heldSecret, LockHeldError, lockFile, publishLock, readLock, releaseLock } from '../src/platform/lock';
import { removeScratch, WINDOWS } from './platform';

// The lock holds a secret the approval hook checks the board's proofs with
// (src/server/proof.ts). It is for the server and the hook alone.
describe('the data folder lock, and the secret in it', () => {
  let scratch: string;
  const folders: string[] = [];
  before(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-lock-'));
  });
  after(() => removeScratch(scratch));
  afterEach(() => {
    for (const folder of folders.splice(0)) releaseLock(folder);
  });

  const folder = () => {
    const made = mkdtempSync(path.join(scratch, 'data-'));
    folders.push(made);
    return made;
  };
  const fileSecret = (dataDir: string): string => JSON.parse(readFileSync(lockFile(dataDir), 'utf8')).secret;
  const listening = async (): Promise<number> => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const { port } = probe.address() as AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    return port;
  };
  const place = (port: number) => ({ pid: process.pid, startedAt: new Date().toISOString(), port, host: '127.0.0.1', url: `http://127.0.0.1:${port}` });

  it('takes a new random secret on each start, in the lock from the first moment, private to this account', async () => {
    const dataDir = folder();
    await acquireLock(dataDir);
    const first = fileSecret(dataDir);
    assert.match(first, /^[\w-]{43}$/, '32 random bytes');
    if (!WINDOWS) assert.equal(statSync(lockFile(dataDir)).mode & 0o777, 0o600);
    releaseLock(dataDir);
    await acquireLock(dataDir);
    assert.notEqual(fileSecret(dataDir), first);
    const other = folder();
    await acquireLock(other);
    assert.notEqual(fileSecret(other), fileSecret(dataDir), 'one for each data folder');
  });

  it("is kept when the server says where it listens, and the file is closed to others again if it had been opened", async () => {
    const dataDir = folder();
    await acquireLock(dataDir);
    const secret = fileSecret(dataDir);
    if (!WINDOWS) chmodSync(lockFile(dataDir), 0o644);
    publishLock(dataDir, place(await listening()));
    assert.equal(fileSecret(dataDir), secret);
    if (!WINDOWS) assert.equal(statSync(lockFile(dataDir)).mode & 0o777, 0o600);
  });

  it('is given to the server that holds the port, and only while it holds it', async () => {
    const dataDir = folder();
    const port = await listening();
    await acquireLock(dataDir);
    assert.equal(heldSecret(port), undefined, 'not before it says where it listens');
    publishLock(dataDir, place(port));
    assert.equal(heldSecret(port), fileSecret(dataDir));
    assert.equal(heldSecret(port + 1), undefined, 'not for another port');
    assert.equal(heldSecret(undefined), undefined);
    assert.equal('secret' in (heldLock(port) ?? {}), false, 'the lock a route reads has none');
    releaseLock(dataDir);
    assert.equal(heldSecret(port), undefined);
  });

  it('is never in what the command and the other code read: readLock, findRunning, and the error of a second start', async () => {
    const dataDir = folder();
    await acquireLock(dataDir);
    const secret = fileSecret(dataDir);
    // The server's own address answers nothing here, so findRunning sees a lock with no address yet and finds the process alive.
    assert.equal('secret' in readLock(dataDir)!, false);
    assert.equal(JSON.stringify(readLock(dataDir)).includes(secret), false);
    const running = await findRunning(dataDir);
    assert.equal(JSON.stringify(running).includes(secret), false);
    await assert.rejects(
      () => acquireLock(dataDir),
      (error: unknown) => {
        assert.ok(error instanceof LockHeldError);
        assert.equal(`${error.message}\n${error.stack}\n${JSON.stringify(error.lock)}`.includes(secret), false);
        return true;
      },
    );
    assert.equal(fileSecret(dataDir), secret, 'the second start left the lock alone');
  });
});
