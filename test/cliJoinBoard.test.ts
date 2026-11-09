import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CommandConnect } from '../src/core/agents/agent';
import { agentKinds, findAgent } from '../src/core/agents/registry';
import type { Key, TerminalKeys } from '../src/cli/boardPicker';
import type { CommandResult, CommandToRun } from '../src/cli/connectAgent';
import { runCli, type CliContext, type CliResult } from '../src/cli/main';
import { lockFile } from '../src/platform/lock';
import type { RunningServer } from '../src/server/start';
import { removeScratch } from './platform';

// `tricot gemini`, and each agent Tricot can't start, with a board running
// (joinBoard.ts): it connects the agent as `tricot connect` does, asks which
// board as `tricot claude` does, and prints the sentence to tell the agent.
// The board runs in this process on a data folder made for the test. PATH
// holds empty stand-ins, so the agents are found, and their commands are run
// by a recorder the test hands the command (ctx.exec): no agent runs, and no
// agent's settings are read or written.
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

// A terminal that types `keys` once the picker listens, and keeps what it drew.
function terminal(keys: string[]): TerminalKeys & { drawn: string[] } {
  const queue: Key[] = keys.map((name) => ({ name }));
  const term = {
    drawn: [] as string[],
    columns: 100,
    write: (text: string) => void term.drawn.push(text),
    listen(onKey: (key: Key) => void) {
      let stopped = false;
      const feed = () => {
        const key = queue.shift();
        if (!key || stopped) return;
        onKey(key);
        setImmediate(feed);
      };
      setImmediate(feed);
      return () => {
        stopped = true;
      };
    },
  };
  return term;
}

// The agents Tricot can't start with the board for one session, as the registry says.
const connectFirst = agentKinds().filter((kind) => !kind.session);

describe('tricot <agent> for one Tricot cannot start, with a board running', () => {
  let scratch: string;
  let home: string;
  let project: string;
  let bin: string;
  let dataDir: string;
  let root: string;
  let port: number;
  let out: string[];
  let err: string[];
  // In the order they came: each question asked, and when the picker first drew.
  let events: string[];
  let ran: CommandToRun[];
  let asking: CommandToRun[];
  let answer: boolean;
  // What the agent says when asked what it has under the name tricot (its `get`): none, to begin with.
  let held: CommandResult;
  let term: ReturnType<typeof terminal> | undefined;
  const servers: RunningServer[] = [];

  interface Options {
    keys?: string[]; // a terminal to pick in, typing these
    ask?: boolean; // a terminal to answer in; false: none (no TTY)
  }
  const ctx = (options: Options = {}): CliContext => {
    term = options.keys ? terminal(options.keys) : undefined;
    if (term) {
      const write = term.write;
      term.write = (text: string) => {
        if (!events.includes('picker')) events.push('picker');
        write(text);
      };
    }
    return {
      env: { TRICOT_DATA_DIR: dataDir, PORT: String(port), HOME: home, USERPROFILE: home, PATH: bin },
      root,
      entry: path.join(repo, 'src/cli/tricot.ts'),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      open: () => {},
      cwd: project,
      platform: 'linux', // the commands it prints as zsh and bash take them
      exec: async (command) => {
        if (command.args.includes('get')) {
          asking.push(command);
          return held;
        }
        ran.push(command);
        return { exitCode: 0, stdout: 'MCP server "tricot" added to user settings. (http)', stderr: '' };
      },
      ...(term && { keys: term }),
      ...(options.ask !== false && {
        ask: async (question: string) => {
          events.push(question);
          return answer;
        },
      }),
    };
  };
  const run = async (argv: string[], options?: Options): Promise<CliResult> => {
    const result = await runCli(argv, ctx(options));
    if (result.server) servers.push(result.server);
    return result;
  };
  const said = () => out.join('\n');
  const drawn = () => term?.drawn.join('') ?? '';
  const url = (name: string) => `http://127.0.0.1:${port}/mcp?agent=${name}`;
  const sentence = (board: string) => `  Use the Tricot board ${board} and start listening.`;
  // A board running in this process, with boards on it, as `tricot` leaves it.
  const boardWith = async (...titles: string[]) => {
    const { server } = await run(['--no-open'], { ask: false });
    out.length = 0;
    const ids: string[] = [];
    for (const title of titles) {
      await new Promise((resolve) => setTimeout(resolve, 5)); // each updated after the last
      const res = await fetch(`${server!.url}/api/boards`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server!.url }, body: JSON.stringify({ actor: 'Sam', title }) });
      ids.push(((await res.json()) as { id: string }).id);
    }
    return { server: server!, ids };
  };

  beforeEach(async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-join-board-'));
    home = path.join(scratch, 'home');
    project = path.join(home, 'work/app');
    mkdirSync(project, { recursive: true });
    bin = path.join(scratch, 'bin');
    mkdirSync(bin);
    for (const kind of agentKinds()) writeFileSync(path.join(bin, kind.command), '#!/bin/sh\nexit 99\n', { mode: 0o755 }); // never run: ctx.exec stands in
    dataDir = path.join(scratch, 'data');
    root = path.join(scratch, 'pkg');
    mkdirSync(path.join(root, 'dist/web'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{"name":"tricot","version":"9.9.9"}');
    writeFileSync(path.join(root, 'dist/web/index.html'), '<!doctype html><title>Tricot</title>');
    port = await freePort();
    out = [];
    err = [];
    events = [];
    ran = [];
    asking = [];
    answer = true;
    held = { exitCode: 1, stdout: '', stderr: 'No MCP server named "tricot".' };
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    removeScratch(scratch);
  });

  it('applies to each agent the registry has no session for, Gemini CLI among them', () => {
    assert.ok(connectFirst.some((kind) => kind.id === 'gemini'));
    assert.ok(connectFirst.every((kind) => kind.cantStart), 'each says why it cannot be started');
  });

  it('says which board it found, offers to connect Gemini CLI, connects it on yes, then asks which board and prints the sentence', async () => {
    const { server, ids } = await boardWith('Older', 'Newer');
    const { exitCode } = await run(['gemini'], { keys: ['down', 'return'] });
    assert.equal(exitCode, 0, err.join('\n'));
    assert.deepEqual(out.slice(0, 3), [`Tricot is running at ${server.url}.`, `Boards in: ${dataDir}`, ''], 'the board and the data folder it looked at');
    assert.match(said(), /Gemini CLI has no command that says whether it has this board already \(gemini mcp list lists what it has\), so Tricot asks\./);
    assert.match(said(), new RegExp(`^  gemini mcp add --scope user --transport http tricot "http://127\\.0\\.0\\.1:${port}/mcp\\?agent=Gemini"$`, 'm'));
    assert.deepEqual(events, ["Run it, adding the board to Gemini CLI's settings?", 'picker'], 'the question, then the picker');
    assert.equal(ran.length, 1);
    assert.equal(ran[0].command, path.join(bin, 'gemini'));
    assert.deepEqual(ran[0].args, ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'tricot', url('Gemini')]);
    assert.match(said(), /Connected: Gemini CLI now has the board, in every session\./);
    assert.match(drawn(), /Which board should Gemini work on\?/);
    assert.deepEqual(out.slice(-3), ['', `Tricot can't start Gemini CLI for you yet: it adds a server only from a settings file. Start it yourself and tell it, for "Older":`, sentence(ids[0])]);
    assert.deepEqual(err, []);
  });

  it('runs nothing on no, and still asks which board', async () => {
    const { ids } = await boardWith('Roadmap');
    answer = false;
    assert.equal((await run(['gemini'], { keys: ['return'] })).exitCode, 0, err.join('\n'));
    assert.deepEqual(ran, []);
    assert.match(said(), /^Nothing was changed\.$/m);
    assert.equal(out.at(-1), sentence(ids[0]));
  });

  it('asks nothing when the agent says it has this board already', async () => {
    // No agent without a session has a `get` today (Gemini CLI and Grok Build
    // have no such command): Gemini CLI is lent one, as such an agent would have it.
    const way = findAgent('gemini')!.connect as CommandConnect;
    way.get = ['gemini', 'mcp', 'get', 'tricot'];
    try {
      const { ids } = await boardWith('Roadmap');
      held = { exitCode: 0, stdout: `tricot\n  URL: ${url('Gemini')}\n`, stderr: '' };
      assert.equal((await run(['gemini'], { keys: ['return'] })).exitCode, 0, err.join('\n'));
      assert.deepEqual(asking.map((c) => c.args), [['mcp', 'get', 'tricot']]);
      assert.match(said(), /^Gemini CLI is already connected to this board\. Nothing to do\.$/m);
      assert.doesNotMatch(said(), /so Tricot asks/);
      assert.deepEqual(events, ['picker'], 'no question, straight to the picker');
      assert.deepEqual(ran, []);
      assert.equal(out.at(-1), sentence(ids[0]));
    } finally {
      delete way.get;
    }
  });

  it('takes --board instead of asking which, and refuses one that is not there', async () => {
    const { ids } = await boardWith('Older', 'Newer');
    assert.equal((await run(['gemini', '--board', ids[0]], { keys: ['return'] })).exitCode, 0, err.join('\n'));
    assert.doesNotMatch(drawn(), /Which board/, 'no picker');
    assert.deepEqual(events, ["Run it, adding the board to Gemini CLI's settings?"]);
    assert.deepEqual(out.slice(-2), [`Tricot can't start Gemini CLI for you yet: it adds a server only from a settings file. Start it yourself and tell it, for "Older":`, sentence(ids[0])]);
    assert.doesNotMatch(said(), /Then tell the agent/, 'said once, after the board is found');
    out.length = 0;
    events = [];
    ran = [];
    for (const options of [{ keys: [] }, { ask: false }]) {
      err.length = 0;
      assert.equal((await run(['gemini', '--board', 'nope'], options)).exitCode, 1);
      assert.match(err.join('\n'), /There's no board "nope" on this Tricot\./);
      assert.deepEqual(events, [], 'said before anything is asked');
      assert.deepEqual(ran, []);
      assert.doesNotMatch(said(), /gemini mcp add|Use the Tricot board/);
    }
  });

  it('shows the entry for an agent that joins through a file, asking nothing, then asks which board', async () => {
    const { ids } = await boardWith('Roadmap');
    assert.equal((await run(['goose'], { keys: ['return'] })).exitCode, 0, err.join('\n'));
    assert.match(said(), new RegExp(`^ {4}uri: "http://127\\.0\\.0\\.1:${port}/mcp\\?agent=Goose"$`, 'm'));
    assert.match(said(), /Tricot can't run this one for you: it's a file to edit\./);
    assert.deepEqual(events, ['picker']);
    assert.deepEqual(ran, []);
    assert.match(said(), /Tricot can't start Goose for you yet: its flag for one session names the server after the board's address and can't send the board's token\. Start it yourself and tell it, for "Roadmap":/);
    assert.equal(out.at(-1), sentence(ids[0]));
  });

  it('does the same for each agent it cannot start, named on the board as it is', async () => {
    const { ids } = await boardWith('Roadmap');
    answer = false;
    for (const kind of connectFirst) {
      out.length = 0;
      events = [];
      assert.equal((await run([kind.id], { keys: ['return'] })).exitCode, 0, `${kind.id}: ${err.join('\n')}`);
      assert.match(drawn(), new RegExp(`Which board should ${kind.boardName} work on\\?`), kind.id);
      assert.equal(out.at(-1), sentence(ids[0]), kind.id);
      assert.ok(said().includes(`Tricot can't start ${kind.name} for you yet: ${kind.cantStart}.`), kind.id);
    }
    assert.deepEqual(ran, [], 'nothing run on no');
  });

  it("stops when the agent isn't installed, before asking which board", async () => {
    await boardWith('Roadmap');
    removeScratch(bin);
    mkdirSync(bin);
    assert.equal((await run(['gemini'], { keys: ['return'] })).exitCode, 1);
    assert.match(err.join('\n'), /Gemini CLI isn't installed here, or isn't on your PATH: Tricot looked for `gemini`/);
    assert.deepEqual(events, []);
    assert.deepEqual(ran, []);
  });

  it('says No board was picked when the picker is cancelled', async () => {
    await boardWith('Roadmap');
    answer = false;
    assert.equal((await run(['gemini'], { keys: ['escape'] })).exitCode, 130);
    assert.equal(out.at(-1), 'No board was picked, so there is nothing to tell Gemini CLI.');
  });

  describe('without a terminal', () => {
    it('asks nothing and runs nothing: it shows how to connect, and asks for --board', async () => {
      await boardWith('Roadmap');
      assert.equal((await run(['gemini'], { ask: false })).exitCode, 1);
      assert.match(said(), /^ {2}gemini mcp add --scope user --transport http tricot /m);
      assert.match(said(), /Without a terminal to ask in, Tricot connected nothing and can't ask which board\. Connect Gemini CLI as above if it doesn't have the board yet, then run tricot gemini --board <id>/);
      assert.deepEqual(events, []);
      assert.deepEqual(ran, []);
      assert.deepEqual(asking, []);
    });

    it('prints the sentence for the board --board names', async () => {
      const { ids } = await boardWith('Roadmap');
      assert.equal((await run(['gemini', '--board', ids[0]], { ask: false })).exitCode, 1);
      assert.match(said(), /Without a terminal to ask in, Tricot connected nothing: connect Gemini CLI as above if it doesn't have the board yet\./);
      assert.equal(out.at(-1), sentence(ids[0]));
      assert.deepEqual(events, []);
      assert.deepEqual(ran, []);
    });

    it('asks nothing where it could answer but not pick, and no --board', async () => {
      await boardWith('Roadmap');
      assert.equal((await run(['gemini'])).exitCode, 1); // a question could be answered, but there are no keys for the picker
      assert.match(said(), /can't ask which board/);
      assert.deepEqual(events, []);
      assert.deepEqual(ran, []);
    });
  });

  describe('with no board running', () => {
    it('shows how to connect, as before, and says where it looked: the data folder and the port', async () => {
      const { exitCode } = await run(['gemini'], { keys: ['return'] });
      assert.equal(exitCode, 1);
      assert.match(said(), /^\(Tricot isn't running yet; start it with: tricot\)$/m);
      assert.match(said(), /^ {2}gemini mcp add --scope user --transport http tricot /m);
      assert.match(said(), /Tricot can't start Gemini CLI for you yet: it adds a server only from a settings file, and this command leaves its settings alone\. Connect it once as above, then start it yourself\./);
      assert.equal(out.at(-1), `Tricot isn't running on ${dataDir} (port ${port}): once it is, tricot gemini offers to connect Gemini CLI and asks which board to tell it.`);
      assert.deepEqual(events, [], 'no question, no picker');
      assert.deepEqual(ran, []);
      assert.equal(existsSync(lockFile(dataDir)), false, 'no board started');
    });

    it('names the board --board gives in the sentence', async () => {
      assert.equal((await run(['gemini', '--board', 'plan'])).exitCode, 1);
      assert.match(said(), /then start it yourself and tell it:\n {2}Use the Tricot board plan and start listening\.\n/);
    });
  });
});
