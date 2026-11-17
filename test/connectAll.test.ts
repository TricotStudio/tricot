import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentKind, CommandConnect, FileConnect } from '../src/core/agents/agent';
import { agentsInCliOrder, skillAgents } from '../src/core/agents/registry';
import type { Key, TerminalKeys } from '../src/cli/boardPicker';
import type { CommandResult, CommandToRun } from '../src/cli/connectAgent';
import { BACKUP_SUFFIX } from '../src/cli/connectFile';
import { SKILL_ANSWER_FILE } from '../src/cli/connectSkill';
import { ANSWER_FILE } from '../src/cli/hooks';
import { runCli, type CliContext, type CliResult } from '../src/cli/main';
import { hookInstallers, UnreadableSettings } from '../src/server/hooks';
import { removeScratch, WINDOWS } from './platform';

// Plain `tricot connect` (connectAll.ts), and `tricot connect <agent>` for an
// agent that joins through its settings file (connectFile.ts), for every agent
// the registry has: no agent's name is written here. Nothing runs a real
// agent: PATH holds empty stand-ins, and a recorder the test hands the command
// (ctx.exec) answers each agent's own command as the test says. HOME is the
// test's own, with the settings files it writes in it.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'Zm9vYmFyYmF6cXV4-dG9rZW4tZm9yLXRlc3Rz-0123456789';

type FileKind = AgentKind & { connect: FileConnect };
type CommandKind = AgentKind & { connect: CommandConnect };
const kinds = agentsInCliOrder();
const commandKinds = kinds.filter((kind): kind is CommandKind => kind.connect.how === 'command');
const fileKinds = kinds.filter((kind): kind is FileKind => kind.connect.how === 'file');
// The program each is found by: the one its command runs, or its own.
const programOf = (kind: AgentKind) => (kind.connect.how === 'command' ? kind.connect.words('http://h/mcp')[0] : kind.command);

// A settings file as people keep it: a comment, a setting, a server of their own.
const ownFile = (kind: FileKind) =>
  kind.connect.format === 'json'
    ? `{\n  // mine: keep this\n  "theme": "dark",\n  "${kind.connect.section}": {\n    "github": { "type": "local", "command": ["gh-mcp"] } // its own\n  }\n}\n`
    : `# mine: keep this\nprovider: anthropic\n${kind.connect.section}:\n  github:\n    command: gh-mcp   # its own\n\nmodel: some-model\n`;

// A terminal that types `keys` once the list listens, and keeps what it drew.
function terminal(keys: string[]): TerminalKeys & { drawn: string[] } {
  const queue: Key[] = keys.map((name) => (name === 'space' ? { name, sequence: ' ' } : name.length === 1 ? { name, sequence: name } : { name }));
  const term = {
    drawn: [] as string[],
    columns: 200,
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

describe('tricot connect, for every agent on this computer', () => {
  let scratch: string;
  let home: string;
  let bin: string;
  let dataDir: string;
  let root: string;
  let port: number;
  let out: string[];
  let err: string[];
  let asked: string[];
  let answer: boolean;
  let ran: string[][];
  let asking: string[];
  let held: Record<string, CommandResult>; // what each program says it has under the name tricot
  let term: ReturnType<typeof terminal> | undefined;
  let extraEnv: NodeJS.ProcessEnv;

  interface Options {
    keys?: string[]; // a terminal to tick in, typing these
    ask?: boolean; // false: no terminal at all
    platform?: NodeJS.Platform;
  }
  const env = () => ({ TRICOT_DATA_DIR: dataDir, PORT: String(port), PATH: bin, HOME: home, USERPROFILE: home, ...extraEnv });
  const ctx = (options: Options = {}): CliContext => {
    term = options.keys ? terminal(options.keys) : undefined;
    return {
      env: env(),
      root,
      entry: path.join(repo, 'src/cli/tricot.ts'),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      open: () => {},
      cwd: scratch,
      platform: options.platform ?? 'linux',
      exec: async (command: CommandToRun) => {
        const program = path.basename(command.command);
        if (command.args.includes('get')) {
          asking.push(program);
          return held[program] ?? { exitCode: 1, stdout: '', stderr: 'No MCP server named "tricot".' };
        }
        ran.push([program, ...command.args, ...(command.env.TRICOT_TOKEN ? [`(token ${command.env.TRICOT_TOKEN === TOKEN ? 'given' : 'wrong'})`] : [])]);
        return { exitCode: 0, stdout: `Added tricot to ${program}`, stderr: '' };
      },
      ...(term && { keys: term }),
      ...(options.ask !== false && {
        ask: async (question: string) => {
          asked.push(question);
          return answer;
        },
      }),
    };
  };
  const run = (argv: string[], options?: Options): Promise<CliResult> => runCli(['connect', ...argv], ctx(options));
  const said = () => out.join('\n');
  const complained = () => err.join('\n');
  const url = (kind: AgentKind) => `http://127.0.0.1:${port}/mcp?agent=${encodeURIComponent(kind.boardName)}`;
  const settingsOf = (kind: FileKind) => kind.settingsPath!({ home, env: env() });
  const writeSettings = (kind: FileKind, text: string) => {
    const file = settingsOf(kind);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  const onPath = (...found: AgentKind[]) => {
    for (const kind of found) writeFileSync(path.join(bin, programOf(kind)), '#!/bin/sh\nexit 99\n', { mode: 0o755 }); // never run: ctx.exec stands in
  };
  const hasBoard = (address: string): CommandResult => ({ exitCode: 0, stdout: `tricot\n  URL: ${address}\n`, stderr: '' });
  // Every agent here: those with a command on the PATH, those with a file by their settings file alone.
  const everyAgent = () => {
    onPath(...commandKinds);
    for (const kind of fileKinds) writeSettings(kind, ownFile(kind));
  };
  // The hook and the skill are offered with each connection: nobody has answered for them yet.
  const offerExtras = () => {
    rmSync(path.join(dataDir, ANSWER_FILE));
    rmSync(path.join(dataDir, SKILL_ANSWER_FILE));
  };
  const drawn = () => (term?.drawn ?? []).join('');
  // Its row in the list as printed: the mark ([x], [ ], ✓ or –), then its name.
  const row = (kind: AgentKind) => said().split('\n').find((line) => ROW.test(line) && line.slice(6).startsWith(`${kind.name} `));

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-connect-all-'));
    home = path.join(scratch, 'home');
    bin = path.join(scratch, 'bin');
    dataDir = path.join(scratch, 'data');
    root = path.join(scratch, 'pkg');
    for (const dir of [home, bin, root]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{"name":"tricot","version":"9.9.9"}');
    cpSync(path.join(repo, 'hooks'), path.join(root, 'hooks'), { recursive: true });
    port = 45000 + Math.floor(Math.random() * 1000);
    out = [];
    err = [];
    asked = [];
    answer = true;
    ran = [];
    asking = [];
    held = {};
    extraEnv = {};
    // These are about the connection: the hook it offers with it has been answered (no), as it is
    // for someone who said so at the first tricot, and so has the Tricot skill (no, for each agent
    // that has one).
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, ANSWER_FILE), JSON.stringify({ answer: 'no', at: new Date().toISOString(), how: 'asked' }));
    writeFileSync(path.join(dataDir, SKILL_ANSWER_FILE), JSON.stringify({ at: new Date().toISOString(), how: 'connect', agents: Object.fromEntries(skillAgents().map((kind) => [kind.id, 'no'])) }));
  });
  afterEach(() => removeScratch(scratch));

  describe('what it says', () => {
    // One command agent has the board at another address, as someone who ran another Tricot would.
    const another = () => commandKinds.find((kind) => kind.connect.get)!;
    beforeEach(() => {
      everyAgent();
      offerExtras();
      held[programOf(another())] = hasBoard('http://127.0.0.1:4545/mcp?agent=X');
    });

    it('asks one short question: a line for each agent, one sentence, no commands or addresses', async () => {
      const { exitCode } = await run([], { keys: ['return'] });
      assert.equal(exitCode, 0, complained());
      const list = drawn();
      assert.match(list, /Connect them to your board\?/);
      assert.match(list, /↑↓ move · space tick · enter connect · \? details/);
      assert.match(list, /\[[x-]\] All agents/);
      assert.match(list, new RegExp(`\\[ \\] ${another().name} +on another board \\(:4545\\): tick to switch`));
      assert.match(list, /Each also gets live steps \(all but .*\) and a skill \(/);
      assert.ok(!/http:\/\/|mcp add| runs /.test(list), `no command or address in the list:\n${list}`);
      assert.ok(out.includes(`Found ${commandKinds.length + fileKinds.length} agents on this computer.`), said());
      assert.ok(!said().includes('The hooks add'), 'the explanation waits for ?');
      assert.ok(!ran.some(([program]) => program === programOf(another())), "the one at another address isn't switched unless ticked");
      assert.match(said(), /^✓ Connected .*\. Start a new session in each\.$/m);
      assert.match(said(), new RegExp(`^ {2}Left alone: ${another().name}\\. To switch one on another board: tricot connect ${another().id}\\.$`, 'm'));
      assert.match(said(), /^ {2}Turn the live steps off any time: tricot steps off|^ {2}Turn off live steps with tricot steps off/m);
      // The ending is these three lines and nothing repeated after them.
      const [connected, left, turnOff, ...after] = out.slice(out.findIndex((line) => line.startsWith('✓ ')));
      assert.match(connected, /^✓ Connected /);
      assert.match(left, /^ {2}Left alone: /);
      assert.match(turnOff, /^ {2}Turn /);
      assert.deepEqual(after, []);
    });

    it('"All agents" ticks every row, those at another address too, and clears them again', async () => {
      // The cursor starts on the first agent: up goes to "All agents", where Space ticks all (some were ticked), Space clears, a ticks.
      await run([], { keys: ['up', 'space', 'space', 'down', 'a', 'return'] });
      const list = drawn();
      assert.ok(list.indexOf('[-] All agents') < list.indexOf('[x] All agents'), 'some ticked, then all');
      assert.ok(list.includes('[ ] All agents'), 'none ticked after the second Space');
      assert.ok(ran.some(([program, ...args]) => program === programOf(another()) && args.includes('remove')), 'the server at another address was replaced, as it was ticked');
      for (const kind of commandKinds) assert.ok(ran.some(([program]) => program === programOf(kind)), `${kind.id} was connected`);
    });

    it('shows everything on ?, then the list again', async () => {
      await run([], { keys: ['?', 'return'] });
      const list = drawn();
      assert.match(list, /The hooks? adds?:/);
      assert.match(list, /What each row does:/);
      assert.match(list, /mcp add/);
      assert.match(list, /\.tricot-backup/);
      assert.ok(list.split('All agents').length >= 3, 'the list is drawn again under the explanation');
    });

    it('is as full as ever with --print, and as short as the list with --yes', async () => {
      await run(['--print']);
      const printed = said();
      assert.match(printed, /^Tricot found \d+ agents on this computer/m);
      assert.match(printed, /The hooks add:/);
      assert.match(printed, /runs .*mcp add/);
      assert.match(printed, /has a server named tricot at http:\/\/127\.0\.0\.1:4545\/mcp\?agent=X: tick it to replace that one, running /);
      out = [];
      await run(['--yes']);
      assert.ok(!said().includes('The hooks add'));
      assert.match(said(), /^Each also gets live steps \(all but .*\) and a skill \(/m);
      assert.match(said(), /tricot connect --print shows what changes/);
      assert.match(said(), /--yes never switches an agent on another board/);
    });
  });

  describe('live steps', () => {
    it("copy a part's labels beside the describe when the package has them, and take them out with the rest", () => {
      const source = path.join(root, 'hooks');
      rmSync(path.join(source, 'tricot-labels.json'), { force: true }); // the package of a part has one: this one has none until the test makes it
      const target = { home, env: { PATH: bin } };
      const setup = { url: 'http://127.0.0.1:4545', source };
      let tried = 0;
      for (const installer of hookInstallers()) {
        try {
          installer.preview(target, setup);
        } catch (error) {
          if (error instanceof UnreadableSettings) continue; // settings the agent makes itself the first time it runs
          throw error;
        }
        tried++;
        const describeAt = installer.status(target).where.find((file) => path.basename(file) === 'tricot-describe.mjs')!;
        const labels = path.join(path.dirname(describeAt), 'tricot-labels.json');
        installer.install(target, setup);
        assert.equal(installer.status(target).state, 'on', installer.id);
        assert.ok(!existsSync(labels), `${installer.id}: no labels in the package, none written`);
        writeFileSync(path.join(source, 'tricot-labels.json'), '{"tools":{}}\n');
        assert.deepEqual(installer.preview(target, setup).changes.filter((change) => change.path === labels).map((change) => [change.does, change.same]), [['write', false]], installer.id);
        installer.install(target, setup);
        assert.equal(readFileSync(labels, 'utf8'), '{"tools":{}}\n', `${installer.id}: copied beside the describe`);
        assert.equal(installer.status(target).state, 'on', installer.id);
        assert.ok(installer.previewUninstall(target).changes.some((change) => change.path === labels && change.does === 'delete'), installer.id);
        installer.uninstall(target);
        assert.ok(!existsSync(labels), `${installer.id}: taken out with the rest`);
        assert.equal(installer.status(target).state, 'off', installer.id);
        rmSync(path.join(source, 'tricot-labels.json'));
      }
      assert.ok(tried >= hookInstallers().length - 1, `${tried} of ${hookInstallers().length} agents tried`);
    });
  });

  describe("an agent's settings file", () => {
    it('gets only Tricot\'s entry, after a copy of it is kept beside it, every other line as it was', async () => {
      for (const kind of fileKinds) writeSettings(kind, ownFile(kind));
      const { exitCode } = await run(['--yes']);
      assert.equal(exitCode, 0, complained());
      for (const kind of fileKinds) {
        const file = settingsOf(kind);
        const now = readFileSync(file, 'utf8');
        assert.equal(readFileSync(`${file}${BACKUP_SUFFIX}`, 'utf8'), ownFile(kind), `${kind.id}: the copy is the file as it was`);
        // Every line it had is there, in order; the last server's may have gained the comma JSON needs after it.
        const comma = (line: string) => line.replace(/,(?=\s*(\/\/.*)?$)/, '');
        const before = ownFile(kind).split('\n');
        let i = 0;
        for (const line of now.split('\n')) if (i < before.length && comma(line) === comma(before[i])) i++;
        assert.equal(i, before.length, `${kind.id}: every line it had is still there, in order:\n${now}`);
        assert.match(now, /mine: keep this/);
        assert.ok(now.includes(url(kind)), `${kind.id}: the entry, with the board's address`);
        assert.match(said(), new RegExp(`^${kind.name}: added its entry to .*\\(the file as it was is kept beside it, as ${path.basename(file).replace('.', '\\.')}\\.tricot-backup\\)\\.$`, 'm'));
      }
    });

    it("doesn't write through a link, and says so", { skip: WINDOWS && 'making a link needs more rights on Windows' }, async () => {
      const [kind] = fileKinds;
      const real = path.join(scratch, 'dotfiles', 'settings');
      mkdirSync(path.dirname(real), { recursive: true });
      writeFileSync(real, ownFile(kind));
      mkdirSync(path.dirname(settingsOf(kind)), { recursive: true });
      symlinkSync(real, settingsOf(kind));
      onPath(kind);
      await run(['--yes']);
      assert.equal(readFileSync(real, 'utf8'), ownFile(kind));
      assert.match(row(kind) ?? '', /can't: .* is a link \(to .*\), and Tricot doesn't write through links/);
    });
  });
});

// `tricot connect <agent>` for an agent that joins through its file.
describe('tricot connect <agent>, for an agent that joins through its settings file', () => {
  let scratch: string;
  let home: string;
  let bin: string;
  let dataDir: string;
  let root: string;
  let port: number;
  let out: string[];
  let err: string[];
  let asked: string[];
  let answer: boolean;

  const env = () => ({ TRICOT_DATA_DIR: dataDir, PORT: String(port), PATH: bin, HOME: home, USERPROFILE: home });
  const ctx = (terminalToo = true): CliContext => ({
    env: env(),
    root,
    entry: path.join(repo, 'src/cli/tricot.ts'),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    open: () => {},
    cwd: scratch,
    platform: 'linux',
    exec: async () => assert.fail('an agent that joins through its file has no command to run'),
    ...(terminalToo && {
      ask: async (question: string) => {
        asked.push(question);
        return answer;
      },
    }),
  });
  const run = (...argv: string[]) => runCli(['connect', ...argv], ctx());
  const said = () => out.join('\n');
  const complained = () => err.join('\n');
  const settingsOf = (kind: FileKind) => kind.settingsPath!({ home, env: env() });
  const writeSettings = (kind: FileKind, text: string) => {
    mkdirSync(path.dirname(settingsOf(kind)), { recursive: true });
    writeFileSync(settingsOf(kind), text);
  };

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-connect-file-'));
    home = path.join(scratch, 'home');
    bin = path.join(scratch, 'bin');
    dataDir = path.join(scratch, 'data');
    root = path.join(scratch, 'pkg');
    for (const dir of [home, bin, root]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{"name":"tricot","version":"9.9.9"}');
    port = 45000 + Math.floor(Math.random() * 1000);
    out = [];
    err = [];
    asked = [];
    answer = true;
  });
  afterEach(() => removeScratch(scratch));

  it("names TRICOT_TOKEN in the entry, never the token, and says where to set it", async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, 'token'), `${TOKEN}\n`);
    const [kind] = fileKinds;
    writeSettings(kind, ownFile(kind));
    assert.equal((await run(kind.id, '--yes', '--host', '0.0.0.0')).exitCode, 0, complained());
    const text = readFileSync(settingsOf(kind), 'utf8');
    assert.ok(!text.includes(TOKEN));
    assert.match(text, /TRICOT_TOKEN/);
    assert.match(said(), new RegExp(`^${kind.name} reads the token from TRICOT_TOKEN: set it in the shell ${kind.name} runs from, with export TRICOT_TOKEN=<token>`, 'm'));
  });
});

// A row of the list as printed: two spaces, its mark, a space, then the agent's name.
const ROW = /^ {2}(\[[x ]\]| ✓ | – ) /;
