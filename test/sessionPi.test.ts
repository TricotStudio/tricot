import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { piExtension, piSession } from '../src/cli/agentSessions/pi';
import { removeScratch, WINDOWS } from './platform';

// Pi for one session (cli/agentSessions/pi.ts): `-e <file>`, and the file adds
// the board as a server through Pi's extension API.
const scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-test-pi-'));
after(() => removeScratch(scratch));

const URL = 'http://127.0.0.1:4545/mcp?agent=Pi';
const setup = { url: URL, message: 'Use the Tricot board b1 and start listening.', passthrough: [] as string[] };

// What the extension asks Pi for, run against a stand-in for Pi's API.
async function registered(source: string): Promise<[string, unknown][]> {
  const file = path.join(scratch, `ext-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, source);
  const calls: [string, unknown][] = [];
  const mod = (await import(pathToFileURL(file).href)) as { default: (pi: unknown) => void };
  mod.default({ registerMcpServer: (name: string, config: unknown) => calls.push([name, config]) });
  return calls;
}

describe('Pi, for one session', () => {
  it("adds one server named tricot, at the board's address with Pi's name on it, that waits five minutes", async () => {
    assert.deepEqual(await registered(piExtension(URL, false)), [['tricot', { url: URL, timeout: 300 }]]);
  });

  it('with a token, sends it as a header Pi fills in from its environment: the token itself is nowhere in the file', async () => {
    const source = piExtension(URL, true);
    assert.deepEqual(await registered(source), [['tricot', { url: URL, headers: { Authorization: 'Bearer ${TRICOT_TOKEN}' }, timeout: 300 }]]);
    assert.ok(!source.includes('s3cret'));
  });

  it('a name or address with quotes in it is a string, never code', async () => {
    const odd = 'http://127.0.0.1:4545/mcp?agent=P"i\'`${1+1}\\';
    assert.deepEqual(await registered(piExtension(odd, false)), [['tricot', { url: odd, timeout: 300 }]]);
  });

  it('is started with -e and its file, then what came after --, then the first message', () => {
    const launch = piSession({ ...setup, passthrough: ['--model', 'sonnet'] });
    try {
      assert.equal(launch.args[0], '-e');
      assert.deepEqual([launch.args.slice(2)], [['--model', 'sonnet', setup.message]]);
      const file = launch.args[1];
      assert.equal(path.basename(file), 'tricot.js');
      if (!WINDOWS) assert.equal(statSync(file).mode & 0o777, 0o600);
      if (!WINDOWS) assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
      assert.match(readFileSync(file, 'utf8'), /pi\.registerMcpServer\("tricot", \{"url":"http:\/\/127\.0\.0\.1:4545\/mcp\?agent=Pi","timeout":300\}\)/);
      assert.deepEqual(launch.env, {});
    } finally {
      launch.cleanup!();
    }
  });

  it('keeps the token in its environment alone, and removes the folder when it is done, however often it is asked', () => {
    const launch = piSession({ ...setup, token: 's3cret' });
    const file = launch.args[1];
    assert.deepEqual(launch.env, { TRICOT_TOKEN: 's3cret' });
    assert.ok(!launch.args.join(' ').includes('s3cret'), 'not in an argument');
    assert.ok(!readFileSync(file, 'utf8').includes('s3cret'), 'not in the file');
    assert.equal(existsSync(file), true);
    launch.cleanup!();
    assert.equal(existsSync(path.dirname(file)), false);
    launch.cleanup!();
  });
});
