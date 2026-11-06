import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { panelTexts } from '../src/core/agents/registry';
import { deliveryOf, LISTEN_PHRASE, notListeningHere, sayTo, toWake, wakeWords, type AgentNow, type DeliveryInput } from '../src/core/delivery';
import {
  agentLine,
  agentToConnect,
  connectWords,
  FIRST_QUESTION,
  firstAsk,
  FirstRunError,
  firstRunSender,
  firstRunShows,
  folderLine,
  folderNote,
  helperLine,
  listenHintShows,
  shortTitle,
  type StartFolder,
} from '../src/core/firstRun';
import { needsAcross, type NeedsReport } from '../src/core/needs';
import type { AgentSkills } from '../src/core/skills';
import { Store } from '../src/core/store';
import type { Actor, Board, Reaction, Thread, ThreadDoor } from '../src/core/types';
import { createApp } from '../src/server/app';
import { Presence } from '../src/server/presence';
import { shownFrom, startFolder } from '../src/server/startFolder';
import { removeScratch } from './platform';

describe("The first run's project title", () => {
  it('takes a few words from the first clause, without its article', () => {
    assert.equal(shortTitle('A pricing page for the Pro plan: which tiers we show, what goes in each, and how annual billing reads.'), 'Pricing page for the Pro plan');
    assert.equal(shortTitle('retry logic for the API client'), 'Retry logic for the API client');
    assert.equal(shortTitle('The checkout redesign. We lose a third of buyers at the address step.'), 'Checkout redesign');
    assert.equal(shortTitle('An onboarding email series (five emails, one a day)'), 'Onboarding email series');
    assert.equal(shortTitle('Billing migration; Stripe or Paddle'), 'Billing migration');
    assert.equal(shortTitle('Should we move billing to Stripe?'), 'Should we move billing to Stripe');
  });

  it('starts at the first line with words, and leaves out "I\'m working on"', () => {
    assert.equal(shortTitle('\n\n  Checkout redesign\n\nWe want fewer drop-offs at the address step.'), 'Checkout redesign');
    assert.equal(shortTitle("I'm working on a launch plan for the mobile app"), 'Launch plan for the mobile app');
    assert.equal(shortTitle('We are currently working on the API client'), 'API client');
    assert.equal(shortTitle('A/B test for the checkout button'), 'A/B test for the checkout button', 'an article is a word of its own');
  });

  it('cuts a long clause at a word boundary, never the whole paragraph', () => {
    const paragraph =
      "we need to figure out how to price the new team plan and what goes in it and whether annual billing gets a discount and how we tell existing customers about the change without upsetting anyone who's on the old plan";
    const title = shortTitle(paragraph);
    assert.equal(title, 'We need to figure out how');
    assert.ok(paragraph.toLowerCase().startsWith(title.toLowerCase()), 'words from the sentence, in order');
    assert.ok(title.split(' ').length <= 7 && title.length <= 50);
    assert.equal(shortTitle('A launch plan for the new mobile app in March, with the marketing team and two agencies'), 'Launch plan for the new mobile app', 'a list cut at its comma, then to seven words');
    assert.equal(shortTitle('Retry logic for the API client and the webhook sender and the queue'), 'Retry logic for the API client', 'never ending on "and" or "the"');
    assert.equal(shortTitle('Internationalisation of the onboarding flow, accessibility review'), 'Internationalisation of the onboarding flow');
  });

  it('always gives a title, however odd the sentence', () => {
    assert.equal(shortTitle('The.'), 'The');
    assert.equal(shortTitle('???'), '???');
    const address = `https://example.com/${'a'.repeat(80)}`;
    assert.equal(shortTitle(address), address.slice(0, 50));
    assert.equal(shortTitle('“Quoted idea” for later'), 'Quoted idea for later');
    assert.equal(shortTitle('Docs site: http://localhost:3000/docs'), 'Docs site');
  });
});

describe('Where Tricot was started', () => {
  // Paths as this system writes them: on Windows, /Users/sam is D:\Users\sam.
  const at = (file: string) => path.resolve(file);
  const home = at('/Users/sam');
  const files = (...present: string[]) => (file: string) => present.map(at).includes(file);

  it('is shown from ~, the home folder as ~, and a folder outside it as it is', () => {
    assert.equal(shownFrom(at('/Users/sam/work/app'), home), '~/work/app');
    assert.equal(shownFrom(`${at('/Users/sam/work/app')}${path.sep}`, `${home}${path.sep}`), '~/work/app');
    assert.equal(shownFrom(at('/Users/sam'), home), '~');
    assert.equal(shownFrom(at('/srv/app'), home), at('/srv/app'));
    assert.equal(shownFrom(at('/Users/samuel/app'), home), at('/Users/samuel/app'), 'a neighbour of the home folder is not under it');
  });

  it("tells a project's folder from the home folder and from a folder that is neither", () => {
    assert.deepEqual(startFolder(at('/Users/sam/work/app'), home, files('/Users/sam/work/app/package.json')), { shown: '~/work/app', kind: 'project' });
    assert.deepEqual(startFolder(at('/Users/sam/work/app/src'), home, files('/Users/sam/work/app/.git')), { shown: '~/work/app/src', kind: 'project' }, 'inside a git repository');
    assert.deepEqual(startFolder(at('/Users/sam'), home, files('/Users/sam/.git', '/Users/sam/package.json')), { shown: '~', kind: 'home' }, 'the home folder is never the project');
    assert.deepEqual(startFolder(at('/Users/sam/Downloads'), home, files('/Users/sam/.git')), { shown: '~/Downloads', kind: 'other' }, "the home folder's own repository makes no folder under it a project");
    assert.deepEqual(startFolder(at('/srv/app'), home, files('/srv/app/go.mod')), { shown: at('/srv/app'), kind: 'project' });
  });

  it('says so near the welcome, gently when it is no project folder, and in the line under the field', () => {
    assert.deepEqual(folderLine({ shown: '~/work/app', kind: 'project' }), { lead: 'Started in', path: '~/work/app' });
    assert.deepEqual(folderLine({ shown: '~', kind: 'home' }), { lead: 'Started in your home folder: start Tricot inside a project folder to tie boards to it.' });
    assert.equal(Object.values(folderLine({ shown: '~/Downloads', kind: 'other' })).join(' '), "Started in ~/Downloads , which isn't a project folder: start Tricot inside one to tie boards to it.");
    const help = (folder?: StartFolder) => Object.values(helperLine(folder)).join(' ').replace(' ,', ',').trim();
    assert.equal(help({ shown: '~/work/app', kind: 'project' }), 'Tricot starts a project for it, here in ~/work/app, and asks your agent what it needs you to decide.');
    assert.equal(help({ shown: '~', kind: 'home' }), 'Tricot starts a project for it and asks your agent what it needs you to decide.');
    assert.equal(help(undefined), 'Tricot starts a project for it and asks your agent what it needs you to decide.');
  });

  it("notes a project's folder on the new board's context for agents, and only a project's", () => {
    assert.deepEqual(folderNote({ shown: '~/work/app', kind: 'project' }), { title: 'Project folder', text: 'Tricot was started in `~/work/app`: the folder this project is about.' });
    assert.equal(folderNote({ shown: '~', kind: 'home' }), undefined);
    assert.equal(folderNote({ shown: '~/Downloads', kind: 'other' }), undefined);
    assert.equal(folderNote(undefined), undefined);
  });
});

describe('When the first run shows', () => {
  const live = { archived: false };
  const archived = { archived: true };

  it('shows while no board is in use, archived ones aside', () => {
    assert.equal(firstRunShows([], false), true);
    assert.equal(firstRunShows([archived, archived], false), true);
    assert.equal(firstRunShows([archived, live], false), false);
  });

  it('holds while its send is under way, so the board it just made does not swap the page', () => {
    assert.equal(firstRunShows([live], true), true);
  });
});

describe("The first run's send", () => {
  type Board = { id: string; title: string; goal: string };
  type Thread = { id: string; boardId: string; body: string; door: ThreadDoor };

  const steps = (overrides: { failBoard?: number; failThread?: number } = {}) => {
    const calls = { boards: [] as Board[], threads: [] as Thread[], boardTries: 0, threadTries: 0 };
    let release: (() => void) | undefined;
    const gate = { hold: false };
    return {
      calls,
      gate,
      release: () => release?.(),
      steps: {
        createBoard: async (title: string, goal: string) => {
          calls.boardTries++;
          if (gate.hold) await new Promise<void>((resolve) => (release = resolve));
          if (calls.boardTries <= (overrides.failBoard ?? 0)) throw new Error('The disk is full');
          const board = { id: `b${calls.boards.length + 1}`, title, goal };
          calls.boards.push(board);
          return board;
        },
        startThread: async (boardId: string, body: string, door: ThreadDoor) => {
          calls.threadTries++;
          if (calls.threadTries <= (overrides.failThread ?? 0)) throw new Error('Request failed (502)');
          const thread = { id: `t${calls.threads.length + 1}`, boardId, body, door };
          calls.threads.push(thread);
          return thread;
        },
      },
    };
  };

  const sentence = '  A pricing page for the Pro plan: which tiers we show, what goes in each.  ';

  it('makes the project, titled from the sentence with the whole sentence as its goal, then asks on its Decisions', async () => {
    const { calls, steps: s } = steps();
    const sent = await firstRunSender(s)(sentence);
    assert.deepEqual(calls.boards, [{ id: 'b1', title: 'Pricing page for the Pro plan', goal: sentence.trim() }]);
    assert.deepEqual(calls.threads, [{ id: 't1', boardId: 'b1', body: firstAsk(sentence), door: 'decisions' }]);
    assert.equal(firstAsk(sentence), `${sentence.trim()}\n\n${FIRST_QUESTION}`, 'the sentence as written, then the ask');
    assert.equal(sent?.board.id, 'b1');
    assert.equal(sent?.thread.id, 't1');
  });

  it("notes the folder on the new board once, and a note that doesn't land leaves the question to go", async () => {
    const { calls, steps: s } = steps({ failThread: 1 });
    const noted: string[] = [];
    const send = firstRunSender({ ...s, noteFolder: async (boardId: string) => void noted.push(boardId) });
    await assert.rejects(send(sentence));
    assert.ok(await send(sentence), 'sent again, on the project already made');
    assert.deepEqual(noted, ['b1'], 'once, as the board is made');
    assert.equal(calls.boards.length, 1);

    const failing = steps();
    const sent = await firstRunSender({ ...failing.steps, noteFolder: () => Promise.reject(new Error('Canvas full')) })(sentence);
    assert.equal(sent?.thread.id, 't1');
  });

  it('sends once for a double click', async () => {
    const { calls, gate, release, steps: s } = steps();
    gate.hold = true;
    const send = firstRunSender(s);
    const first = send(sentence);
    const second = await send(sentence);
    assert.equal(second, undefined, 'the second press does nothing');
    release();
    assert.ok(await first);
    assert.equal(calls.boards.length, 1);
    assert.equal(calls.threads.length, 1);
    assert.equal(await send('   '), undefined, 'nothing to send');
  });

  it('says plainly what failed, and asks again on the project already made rather than making another', async () => {
    const { calls, steps: s } = steps({ failBoard: 1, failThread: 1 });
    const send = firstRunSender(s);
    await assert.rejects(send(sentence), (e: FirstRunError<Board>) => {
      assert.equal(e.message, "The project wasn't made. The disk is full.");
      assert.equal(e.board, undefined);
      return true;
    });
    await assert.rejects(send(sentence), (e: FirstRunError<Board>) => {
      assert.equal(e.message, "The project is made, but your question didn't send. Request failed (502). Send it again to ask.");
      assert.equal(e.board?.id, 'b1');
      return true;
    });
    const sent = await send(sentence);
    assert.equal(sent?.board.id, 'b1');
    assert.equal(calls.boards.length, 1, 'one project');
    assert.deepEqual(calls.threads.map((t) => t.boardId), ['b1']);
  });
});

describe("The first run's agent", () => {
  const agents = (found: string[]) =>
    ['claude', 'codex', 'pi', 'omp'].map((id) => ({ id, name: { claude: 'Claude Code', codex: 'Codex', pi: 'Pi', omp: 'OMP' }[id]!, found: found.includes(id) }));

  it("shows the command for the agent found on this computer, as the Connect panel builds it", () => {
    assert.deepEqual(agentToConnect(agents(['claude', 'codex'])), { tool: 'claude', name: 'Claude Code', found: true });
    assert.deepEqual(agentToConnect(agents(['pi'])), { tool: 'pi', name: 'Pi', found: true });
    const codex = agentToConnect(agents(['codex']));
    assert.equal(connectWords(codex), 'Codex is on this computer: run this once in a terminal, then start a new Codex session.');
    assert.equal(panelTexts('http://127.0.0.1:4545/mcp')[codex.tool], 'codex mcp add tricot --url "http://127.0.0.1:4545/mcp?agent=Codex"');
    assert.match(connectWords(agentToConnect(agents(['omp']))), /add this to its settings \(~\/\.omp\/agent\/mcp\.json\)/);
  });

  it("falls back to Claude Code, saying none was found, when there is none or no way to tell", () => {
    for (const none of [agents([]), undefined, [{ id: 'aider', name: 'Aider', found: true }]]) {
      const step = agentToConnect(none);
      assert.deepEqual(step, { tool: 'claude', name: 'Claude Code', found: false });
      assert.match(connectWords(step), /^Tricot didn't find an agent on this computer\. For Claude Code, run this once/);
    }
  });

  it('says what a connected agent does with the sentence, by how present it is', () => {
    assert.equal(agentLine({ name: 'Claude', state: 'listening' }), 'Claude is listening. It gets this the moment you send it.');
    assert.equal(agentLine({ name: 'Claude', state: 'working' }), 'Claude is connected. It sees this the next time it checks the board.');
    assert.match(agentLine({ name: 'Claude', state: 'away' }), /^Claude connected earlier but isn't checking now\./);
  });
});

describe('Telling a connected agent to listen', () => {
  const sam: Actor = { kind: 'human', name: 'Sam' };
  const at = '2026-11-03T12:00:00.000Z';
  const fresh = { activity: { actors: [{ actor: sam, at }], done: {}, reviewSentAt: {} }, tasks: [], decisions: [] } as unknown as Board;
  const thread = { id: 'th1', title: 'A pricing page', door: 'decisions', messages: [] } as unknown as Thread;
  const first = { id: 'm1', author: sam, at };
  const delivery = (input: Partial<DeliveryInput> = {}) => deliveryOf({ board: fresh, where: { thread }, said: first, after: [], agents: [], steps: [], ...input });
  const now: AgentNow = { name: 'Claude', state: 'listening', lastSeen: at };

  it('shows under the first run\'s line while the agent is connected but not listening', () => {
    assert.equal(listenHintShows({ state: 'working' }), true);
    assert.equal(listenHintShows({ state: 'away' }), true);
    assert.equal(listenHintShows({ state: 'listening' }), false, 'a listening agent gets it the moment it is sent');
  });

  it("shows under the first message on the new board, naming an agent connected anywhere, until one on the board has it", () => {
    const unseen = delivery();
    assert.deepEqual(unseen, { state: 'nobody' }, 'no agent on the new board');
    assert.equal(toWake(unseen, ['Claude', 'Codex']), 'Claude', 'the busiest connected agent');
    assert.equal(wakeWords('Claude', 'Claude Code', unseen!), 'Claude isn\'t listening yet. In Claude Code, say: “Start listening on Tricot”');
    assert.equal(LISTEN_PHRASE, 'Start listening on Tricot');
    assert.equal(toWake(unseen, []), undefined, 'no agent to name: the line offers Connect one, as before');

    const eyes = { emoji: '👀', by: { kind: 'agent', name: 'Claude' }, at } as Reaction;
    assert.equal(toWake(delivery({ said: { ...first, reactions: [eyes] }, agents: [{ ...now, state: 'working' }] }), ['Claude']), undefined, 'gone once it has seen it');
    assert.equal(toWake(delivery({ agents: [now] }), ['Claude']), undefined, 'gone while it listens on the board');
    assert.equal(toWake(delivery({ after: [{ author: { kind: 'agent', name: 'Claude' } }] }), ['Claude']), undefined, 'gone once it has replied');
  });

  it("has the chat bar say the agent isn't listening here, offering Connect one only when no agent is connected at all", () => {
    assert.equal(notListeningHere([], ['Claude', 'Codex']), "Claude isn't listening here", 'the agent the hint names, on a board no agent has been on');
    assert.equal(toWake(delivery(), ['Claude', 'Codex']), 'Claude', 'the same agent as the line under the message');
    assert.equal(notListeningHere(['Codex'], ['Claude', 'Codex']), "Codex isn't listening here", 'the one last on the board, gone quiet');
    assert.equal(notListeningHere([], []), undefined, 'none connected: "No agent listening" and Connect one');
    assert.equal(notListeningHere(['Codex'], []), undefined);
  });

  it('names the agent a message waits for when it has gone from the board, and says where to say it', () => {
    const waiting = delivery({ said: { ...first, mentions: ['Codex'] }, board: { ...fresh, activity: { ...fresh.activity, actors: [{ actor: { kind: 'agent', name: 'Codex' }, at }] } } as unknown as Board });
    assert.equal(waiting?.state, 'waiting');
    assert.equal(toWake(waiting, ['Claude']), 'Codex');
    assert.equal(wakeWords('Codex', 'Codex', waiting!), 'Codex isn\'t listening. In Codex, say: “Start listening on Tricot”');
    assert.equal(toWake({ state: 'waiting', agents: [], last: { name: 'Pi', at } }, ['Claude']), 'Pi', 'for any agent: the last one seen there');
    assert.equal(sayTo('Planner'), 'Say to Planner:', 'a tool Tricot does not know: to the agent by name');
  });
});

describe('Presence of an agent on no board', () => {
  const setup = () => {
    let now = 1_000_000;
    const presence = new Presence(() => {}, () => now);
    return { presence, advance: (ms: number) => (now += ms) };
  };
  const shown = (presence: Presence) => presence.agents().map((a) => [a.name, a.state, a.board]);

  it('notes an agent as connected before it touches a board, and lets it go quiet as others do', () => {
    const { presence, advance } = setup();
    presence.connect('Claude');
    assert.deepEqual(shown(presence), [['Claude', 'working', undefined]]);
    assert.deepEqual(presence.list('b1'), [], 'on no board');
    assert.deepEqual(presence.agents('b1'), [], 'nor on one asked about');
    advance(2 * 60_000 + 1);
    assert.deepEqual(shown(presence), [['Claude', 'away', undefined]], 'quiet, not gone');
    presence.close();
  });

  it('puts it on its board once it is there, and off it while a newer connection is busier', () => {
    const { presence, advance } = setup();
    presence.connect('Claude');
    presence.startWaiting('b1', 'Claude');
    assert.deepEqual(shown(presence), [['Claude', 'listening', 'b1']], 'listening on the board beats only connected');
    presence.stopWaiting('b1', 'Claude');
    advance(10 * 60_000);
    assert.deepEqual(shown(presence), [['Claude', 'away', 'b1']]);
    presence.connect('claude'); // a new session, before it is on a board again
    assert.deepEqual(shown(presence), [['Claude', 'working', undefined]], 'once, whatever the case of its name');
    presence.close();
  });
});

describe('An agent connecting before there is a project', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: Store;
  const clients: Client[] = [];
  const sam: Actor = { kind: 'human', name: 'Sam' };

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-first-run-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    for (const client of clients) await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  const connect = async (agent: string) => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=${agent}`)));
    return client;
  };
  const needs = async () => (await (await fetch(`${base}/api/needs?name=Sam`)).json()) as NeedsReport;

  it("gives the page the folder Tricot was started in, from ~, and nothing more", async () => {
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', folder: { shown: '~/work/app', kind: 'project' } });
    const other: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const info = await (await fetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}/api/info`)).json();
      assert.deepEqual(info.folder, { shown: '~/work/app', kind: 'project' });
      assert.equal((await (await fetch(`${base}/api/info`)).json()).folder, undefined, 'none given: none said');
    } finally {
      other.closeAllConnections();
      other.close();
    }
  });

  it('shows on Home as its session starts, with no board and no call made', async () => {
    assert.deepEqual((await needs()).agents, []);
    await connect('Fresh');
    const report = await needs();
    assert.deepEqual(report.agents.map((a) => [a.name, a.state, a.board]), [['Fresh', 'working', undefined]]);
    const agents = (await (await fetch(`${base}/api/agents`)).json()) as AgentSkills[];
    assert.deepEqual(agents.map((a) => [a.name, a.state, a.board]), [['Fresh', 'working', undefined]], "the user menu's list too");
  });

  it("goes onto a project's row once it works there, and is listed once", async () => {
    const client = await connect('Builder');
    const board = store.createBoard({ title: 'Pricing page' }, sam);
    await client.callTool({ name: 'get_board', arguments: { board_id: board.id } });
    const report = await needs();
    assert.deepEqual(report.projects[0].agents.map((a) => a.name), ['Builder']);
    assert.deepEqual(
      report.agents.filter((a) => a.name === 'Builder').map((a) => [a.state, a.board]),
      [['working', 'Pricing page']],
    );
    store.setArchived(board.id, true, sam);
    const archived = await needs();
    assert.deepEqual(archived.agents.filter((a) => a.name === 'Builder').map((a) => [a.state, a.board]), [['working', undefined]], 'on archived boards only: connected');
  });

  it('lists an agent on a board in use by that board, and one only connected with none, once each', () => {
    const board = store.getBoard(store.createBoard({ title: 'Launch' }, sam).id);
    const at = '2026-11-03T10:00:00.000Z';
    const report = needsAcross([board], 'Sam', {
      present: () => [{ name: 'Claude', lastSeen: at, state: 'working' }],
      connected: [
        { name: 'claude', lastSeen: at, state: 'listening' },
        { name: 'Codex', lastSeen: at, state: 'away' },
      ],
    });
    assert.deepEqual(
      report.agents.map((a) => [a.name, a.state, a.board]),
      [
        ['Claude', 'working', 'Launch'],
        ['Codex', 'away', undefined],
      ],
    );
  });
});
