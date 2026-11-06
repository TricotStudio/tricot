import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { ApprovalRequest } from '../src/core/approvals';
import { Store } from '../src/core/store';
import { holdAnswers } from '../src/cli/switcher/answers';
import { startHost, TRICOT_TAB, type Host, type HostedAgent, type HostOutcome, type TricotSetup } from '../src/cli/switcher/host';
import { SWITCH_KEY } from '../src/cli/switcher/keys';
import { watchBoard, type LiveFeed } from '../src/cli/switcher/live';
import { createApp } from '../src/server/app';
import { AnswerHosts } from '../src/server/answerHosts';
import type { AdmissionView } from '../src/core/seats';
import { letIn, type TestSeat } from './seatHelper';
import { claudeLike, codexLike, fakeTerminal, leftAfterReaping, node, repo, sleep, tracked, waitFor, type FakeTerminal } from './switcher/harness';
import { WINDOWS } from './platform';

// The Tricot tab in the real host (T192), with stand-in agents in
// pseudo-terminals of their own and a board running here: it shows first;
// Ctrl+\ goes round every tab, Ctrl+\ then 0 comes back to it and the digits
// still pick agents; what is typed in it stays in it, and what is typed in
// an agent's tab goes to that agent. A request for permission that comes in
// while an agent shows says so in the strip, and is answered from the tab
// (allow, deny with a reason) with this terminal's host key, which no agent
// is ever given. Agents are added and stopped from it, and q quits.
// Each test closes its host however it ends, and nothing is left running
// after them all: no agent, no pty helper.

const KEY = SWITCH_KEY;
let scratch: string;
before(() => {
  mkdirSync(path.join(repo, '.review'), { recursive: true });
  scratch = mkdtempSync(path.join(repo, '.review', 'test-tab-host-'));
});
after(async () => assert.deepEqual(await leftAfterReaping(), [], 'nothing left running'));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe('the Tricot tab, in the host', { timeout: 90_000, skip: WINDOWS && 'needs pseudo-terminals, which Windows has none of for Tricot' }, () => {
  let dir: string;
  let store: Store;
  let server: Server;
  let base: string;
  let board: string;
  let hosts: AnswerHosts;
  let probe: string;
  let dump: string;
  let browser: TestSeat; // the person's browser, let in: it lets the tab in
  const env = () => ({ ...process.env, TERM: 'xterm-256color', PROBE_FILE: dump, PROBE_NEXT: claudeLike });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(scratch, 'data-'));
    store = new Store(dir);
    store.load();
    hosts = new AnswerHosts();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', approvals: { hosts } });
    browser = letIn(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    board = store.createBoard({ title: 'Roadmap' }, { kind: 'human', name: 'Sam' }).id;
    // Claude's stand-in, after it notes the environment and arguments it was started with.
    probe = path.join(dir, 'probe.mjs');
    dump = path.join(dir, 'probe.json');
    writeFileSync(probe, "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.PROBE_FILE, JSON.stringify({ env: process.env, argv: process.argv }));\nawait import(process.env.PROBE_NEXT);\n");
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.flush();
  });

  interface Run {
    host: Host;
    fake: FakeTerminal;
    keys: string[]; // every host key the board gave
    opened: number;
    shows(text: string, ms?: number): Promise<boolean>;
    strip(): Promise<string>;
    screen(): Promise<string>;
  }

  async function hosted(agents: HostedAgent[], test: (run: Run) => Promise<void>): Promise<HostOutcome> {
    const fake = fakeTerminal(130, 30); // wide enough for the strip to keep its keys, whatever the agents say
    const keys: string[] = [];
    const watched: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).endsWith('/api/approvals/hosts') && res.status === 201) keys.push(((await res.clone().json()) as { key: string }).key);
      return res;
    };
    // As switcher/run.ts wires them: the board's stream sends the host key, for the requests waiting,
    // and once the terminal is let in as a seat, is signed, and connects again to read them in full.
    let live: LiveFeed | undefined;
    const answers = holdAnswers({ url: base, actor: 'Wassim', fetch: watched, seatPollMs: 20, onSeat: () => answers.seated && live?.reconnect() });
    live = watchBoard({ url: base, board, title: 'Roadmap', activity: 6, retryMs: 100, hostKey: answers.held, sign: (method, route) => answers.sign(method, route) });
    const run = { fake, keys, opened: 0 } as Run;
    const tricot: TricotSetup = {
      url: base,
      title: 'Roadmap',
      answers,
      open: () => void run.opened++,
      choices: (running) =>
        [
          { id: 'codex', name: 'Codex' },
          { id: 'opencode', name: 'OpenCode' },
        ].filter((c) => !running.includes(c.id)),
      make: (id) => (id === 'opencode' ? { name: 'OpenCode', id, command: node, args: [codexLike, '--name=OpenCode (stand-in)', '--exit=0'], env: env(), cwd: process.cwd() } : { problem: `Not ${id} here.` }),
    };
    const host = tracked(startHost({ agents, terminal: fake.terminal, key: KEY, live: live!, tricot, closeMs: 1_500 }));
    run.host = host;
    run.screen = async () => (await fake.observer.settled(), fake.observer.text());
    run.shows = (text, ms) => waitFor(async () => (await run.screen()).includes(text), ms);
    run.strip = async () => (await fake.observer.settled(), fake.observer.strip());
    try {
      await host.started;
      await test(run);
    } finally {
      host.quit();
      live!.stop();
      await answers.release();
    }
    return host.done;
  }

  const claude = (): HostedAgent => ({ name: 'Claude', id: 'claude', command: node, args: [probe], env: env(), cwd: process.cwd() });
  const codex = (): HostedAgent => ({ name: 'Codex', id: 'codex', command: node, args: [codexLike, '--exit=3'], env: env(), cwd: process.cwd() });
  const ask = async (command: string): Promise<{ id: string; key: string }> => {
    const body: ApprovalRequest = { harness: 'claude', tool: 'Bash', input: { command, description: 'Rebuild it' }, description: 'Rebuild it', cwd: '/work/tricot', session: 's1' };
    const res = await fetch(`${base}/api/agents/Claude/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return (await res.json()) as { id: string; key: string };
  };
  const answerOf = async (asked: { id: string; key: string }) => {
    const res = await fetch(`${base}/api/approvals/${asked.id}/wait`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: asked.key }) });
    return res.json();
  };

  it('opens first, routes the keys by tab, answers from the tab, adds and stops agents, and never gives an agent its key', async () => {
    const outcome = await hosted([claude(), codex()], async ({ host, fake, keys, shows, strip, screen }) => {
      // ---- first: the Tricot tab
      assert.ok(await shows(' Tricot · Roadmap'), await screen());
      assert.equal(host.view().visible, TRICOT_TAB);
      assert.ok(await waitFor(async () => /^ ● Tricot   ○ 1 Claude · .*○ 2 Codex · .*Ctrl\+\\ next · Ctrl\+\\ 0–2 pick · Ctrl\+\\ q quit $/.test(await strip())), await strip());
      assert.ok(await shows('   1 Claude   '), await screen());
      assert.ok(await shows('   Nothing is waiting for you.'));
      store.planTasks(board, [{ title: 'Ship the tab' }], { kind: 'human', name: 'Sam' });
      assert.ok(await shows(' Lately on the board'), 'the activity, from the stream');
      assert.ok(await shows('   Sam '), await screen());
      assert.equal(fake.observer.screen.inputModes.bracketedPaste, true, 'it reads a paste whole');
      assert.equal(fake.observer.screen.inputModes.mouse, 'none');

      // ---- what is typed in the tab stays in it
      fake.type('hello');
      await sleep(300);
      assert.ok(!host.view().agents[0].screen.lines().join('\n').includes('hello'), 'Claude never got it');

      // ---- Ctrl+\ goes to Claude, and what is typed reaches it
      fake.type('\x1c');
      assert.ok(await waitFor(() => host.view().visible === 0));
      assert.ok(await shows('Claude (stand-in)'), await screen());
      await sleep(1_100);
      fake.type('hi');
      assert.ok(await shows('> hi'), 'typing reaches Claude');

      // ---- a request comes in while Claude shows: the strip says so, and how to answer
      const first = await ask('rm -rf dist && npm run build');
      assert.ok(await waitFor(async () => / ● 1 Claude · waiting for your OK .*Ctrl\+\\ 0 to answer $/.test(await strip())), await strip());

      // ---- Ctrl+\ then 0: back to the tab. Not a seat yet, it sees that Claude waits, not what for: y asks to be let in
      fake.type('\x1c0');
      assert.ok(await waitFor(() => host.view().visible === TRICOT_TAB));
      assert.ok(await shows('   Claude is waiting for your OK.'), await screen());
      assert.ok(await shows('   [y] let this terminal answer for you'), await screen());
      assert.ok(!(await screen()).includes('rm -rf dist'), 'what it asks stays sealed');
      fake.type('y');
      assert.ok(await shows("it shows code"), await screen());
      const code = /it shows code (\d{4})/.exec(await screen())![1];
      // The person's browser shows the same code, and they click Allow there.
      const waiting = (await (await fetch(`${base}/api/seats/admissions`, { headers: { 'Sec-Fetch-Site': 'same-origin', ...browser.sign('GET', '/api/seats/admissions') } })).json()) as AdmissionView[];
      const mine = waiting.find((a) => a.code === code)!;
      const allow = JSON.stringify({ actor: 'Wassim', allow: true });
      const route = `/api/seats/admissions/${mine.id}/answer`;
      assert.equal((await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...browser.sign('POST', route, allow) }, body: allow })).status, 200);
      assert.ok(await shows(' This terminal answers for you now, until it closes.'), await screen());
      // ---- let in, the request shows in full, and y allows it
      assert.ok(await shows('   Claude wants to run a command in tricot:'), await screen());
      assert.ok(await shows('     rm -rf dist && npm run build'));
      assert.ok(await shows('   [y] allow   [n] deny'));
      assert.ok(await waitFor(async () => !/0 to answer/.test(await strip())), 'here, the strip no longer says how to answer');
      fake.type('y');
      assert.deepEqual(await answerOf(first), { state: 'answered', answer: { behavior: 'allow', by: 'Wassim', from: 'terminal' } });
      assert.ok(await shows(' Allowed: Claude goes ahead.'), await screen());
      assert.ok(await shows('   Nothing is waiting for you.'));

      // ---- n, a reason, Enter: denied with it
      const second = await ask('git push --force origin main');
      assert.ok(await shows('     git push --force origin main'), await screen());
      fake.type('n');
      assert.ok(await shows('   Tell Claude why (optional; it reads this). Enter deny · Esc back'));
      fake.type('Not on main, please');
      assert.ok(await shows('   › Not on main, please'));
      assert.equal(fake.observer.screen.cursor.visible, true, 'the cursor shows where the reason goes');
      fake.type('\r');
      assert.deepEqual(await answerOf(second), { state: 'answered', answer: { behavior: 'deny', message: "Wassim denied this in Tricot's terminal: Not on main, please", by: 'Wassim', from: 'terminal' } });

      // ---- Ctrl+\ then 2 still picks an agent, and 0 comes back
      fake.type('\x1c2');
      assert.ok(await waitFor(() => host.view().visible === 1));
      await sleep(1_100);
      fake.type('\x1c0');
      assert.ok(await waitFor(() => host.view().visible === TRICOT_TAB));

      // ---- o opens the board; a adds OpenCode, in a tab of its own
      fake.type('o');
      assert.ok(await shows(' Opened the board in your browser.'));
      fake.type('a');
      assert.ok(await shows(' Add which agent?   Esc cancel'), await screen());
      assert.ok(await shows('   1  OpenCode'), await screen());
      fake.type('1');
      assert.ok(await waitFor(() => host.view().visible === 2 && host.view().agents.length === 3));
      assert.ok(await shows('>_ OpenCode (stand-in)'), await screen());
      assert.ok(await waitFor(async () => / ○ Tricot .* ● 3 OpenCode /.test(await strip())), await strip());

      // ---- x stops Codex, after a y
      await sleep(1_100);
      fake.type('\x1c0');
      assert.ok(await waitFor(() => host.view().visible === TRICOT_TAB));
      fake.type('x');
      assert.ok(await shows(' Stop which agent?  1 Claude   2 Codex   3 OpenCode   Esc cancel'), await screen());
      fake.type('2');
      assert.ok(await shows(' Stop Codex?  y stop · any other key keeps it'));
      fake.type('y');
      assert.ok(await waitFor(() => host.view().agents[1].state === 'ended'), 'Codex ended');
      assert.ok(await shows('   2 Codex      Stopped'), await screen());
      assert.ok(await waitFor(async () => /✕ 2 Codex · stopped/.test(await strip())), await strip());

      // ---- its key went nowhere an agent can see
      assert.equal(keys.length, 1, 'registered once');
      const key = keys[0];
      const seen = JSON.parse(readFileSync(dump, 'utf8')) as { env: Record<string, string>; argv: string[] };
      assert.ok(seen.argv.length > 0 && Object.keys(seen.env).length > 0);
      assert.ok(!JSON.stringify(seen).includes(key), "not in Claude's environment or arguments");
      assert.ok(!execFileSync('ps', ['-axww', '-o', 'args='], { encoding: 'utf8' }).includes(key), "nor any process's arguments");
      for (const file of filesUnder(scratch)) assert.ok(!readFileSync(file, 'utf8').includes(key), `nor in ${file}`);

      // ---- q quits
      fake.type('q');
    });
    assert.equal(outcome.quit, true);
    assert.deepEqual(outcome.agents, [
      { name: 'Claude', id: 'claude' },
      { name: 'Codex', id: 'codex' },
      { name: 'OpenCode', id: 'opencode' },
    ]);
    assert.deepEqual(outcome.exits, [undefined, undefined, undefined], 'Codex was stopped, the others closed: none failed');
    assert.equal(hosts.size, 0, 'the board let go of its key');
  });

  it('stays on the Tricot tab when every agent has ended, until q', async () => {
    const outcome = await hosted([codex()], async ({ host, fake, shows, screen }) => {
      fake.type('\x1c');
      assert.ok(await waitFor(() => host.view().visible === 0));
      assert.ok(await shows('>_ Codex (stand-in)'));
      await sleep(1_100);
      fake.type('X'); // Codex ends with 3
      assert.ok(await waitFor(() => host.view().visible === TRICOT_TAB), 'back on the Tricot tab');
      assert.ok(await shows('   1 Codex   Ended (3)'), await screen());
      await sleep(500);
      assert.equal(await Promise.race([host.done.then(() => 'done'), sleep(50).then(() => 'still here')]), 'still here');
      fake.type('q');
    });
    assert.deepEqual(outcome.exits, [3]);
    assert.equal(outcome.quit, true);
  });
});

function filesUnder(folder: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(folder)) {
    const file = path.join(folder, name);
    if (statSync(file).isDirectory()) out.push(...filesUnder(file));
    else out.push(file);
  }
  return out;
}
