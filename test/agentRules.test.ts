import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  cleanRule,
  modelProblem,
  ruleFlags,
  ruleProblem,
  ruleWith,
  ruleWords,
  runningWords,
  runsOnOf,
  runsOnUrl,
  stripWords,
  type AgentRule,
  type AgentRules,
} from '../src/core/agentRules';
import { agentKinds, findAgent } from '../src/core/agents/registry';
import type { AgentSkills } from '../src/core/skills';
import { Store } from '../src/core/store';
import { AgentRulesStore, RULES_FILE } from '../src/server/agentRules';
import { createApp } from '../src/server/app';
import { kindOf, offersRule, RuleChip, ruleOwner } from '../src/web/agents/rule';
import { removeScratch, WINDOWS } from './platform';
import { letIn, type TestSeat } from './seatHelper';

// Each agent's rule (T22): the model and thinking level it starts on, the
// same on every board. Each agent says what it takes and how a rule becomes
// its own flags; the server keeps the rules in the data folder and lets the
// person alone change them; a session Tricot started says what it runs on.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let scratch: string;
before(() => {
  mkdirSync(path.join(repo, '.review'), { recursive: true });
  scratch = mkdtempSync(path.join(repo, '.review', 'test-agent-rules-'));
});
after(() => removeScratch(scratch));

const kind = (id: string) => findAgent(id)!;

describe("An agent's rule, as its own flags", () => {
  it('becomes each agent’s own words, each value an argument of its own', () => {
    const both: AgentRule = { model: 'some-model', effort: 'high' };
    assert.deepEqual(ruleFlags(kind('claude'), both), ['--model', 'some-model', '--effort', 'high']);
    assert.deepEqual(ruleFlags(kind('codex'), both), ['--model', 'some-model', '-c', 'model_reasoning_effort="high"']);
    assert.deepEqual(ruleFlags(kind('pi'), both), ['--model', 'some-model', '--thinking', 'high']);
    assert.deepEqual(ruleFlags(kind('omp'), both), ['--model=some-model', '--thinking=high']);
    assert.deepEqual(ruleFlags(kind('gemini'), { model: 'gemini-2.5-pro' }), ['--model', 'gemini-2.5-pro']);
    assert.deepEqual(ruleFlags(kind('opencode'), { model: 'anthropic/claude-sonnet-5' }), ['--model', 'anthropic/claude-sonnet-5']);
    assert.deepEqual(ruleFlags(kind('grok'), { model: 'grok-4.6' }), ['-m', 'grok-4.6']);
    assert.deepEqual(ruleFlags(kind('hermes'), { model: 'anthropic/claude-sonnet-5' }), ['--model', 'anthropic/claude-sonnet-5']);
    assert.deepEqual(ruleFlags(kind('copilot'), both), ['--model', 'some-model', '--reasoning-effort', 'high']);
    assert.throws(() => ruleFlags(kind('goose'), { model: 'gpt-6.1-sol' }), /Tricot can't start Goose on a model of your choosing/);
  });

  it('passes one alone, and nothing at all for its own settings', () => {
    assert.deepEqual(ruleFlags(kind('claude'), { model: 'opus' }), ['--model', 'opus']);
    assert.deepEqual(ruleFlags(kind('claude'), { effort: 'max' }), ['--effort', 'max']);
    assert.deepEqual(ruleFlags(kind('codex'), { effort: 'xhigh' }), ['-c', 'model_reasoning_effort="xhigh"']);
    for (const agent of agentKinds()) assert.deepEqual(ruleFlags(agent, {}), [], agent.id);
    assert.deepEqual(ruleFlags(kind('claude'), { model: '  ', effort: '' }), [], 'blank is nothing');
  });

  it('refuses a value that would read as an option, or holds a control character, before any agent sees it', () => {
    for (const model of ['--dangerously-skip-permissions', '-p', 'opus\n--yolo', 'opus\u001b[2J', 'a\u0000b', 'x'.repeat(121)]) {
      assert.ok(modelProblem(model), JSON.stringify(model));
      for (const agent of agentKinds()) assert.throws(() => ruleFlags(agent, { model }), Error, `${agent.id} ${JSON.stringify(model)}`);
    }
    assert.equal(modelProblem('anthropic/claude-opus-5-5'), undefined);
    assert.equal(modelProblem('llama3:8b'), undefined);
    assert.equal(modelProblem('claude-opus-4-6[1m]'), undefined);
  });

  it('takes only the thinking levels the agent has, and none from one that has none', () => {
    assert.match(ruleProblem(kind('claude'), { effort: 'ultra' })!, /^Claude Code's thinking level is one of low, medium, high, xhigh or max: "ultra" isn't one\.$/);
    assert.equal(ruleProblem(kind('codex'), { effort: 'ultra' }), undefined);
    assert.equal(ruleProblem(kind('pi'), { effort: 'off' }), undefined);
    assert.equal(ruleProblem(kind('omp'), { effort: 'auto' }), undefined);
    assert.match(ruleProblem(kind('copilot'), { effort: 'ultra' })!, /^Copilot CLI's thinking level is one of low, medium, high, xhigh or max: "ultra" isn't one\.$/);
    assert.equal(ruleProblem(kind('opencode'), { effort: 'high' }), 'OpenCode has no thinking level Tricot can set: its own settings decide it.');
    assert.throws(() => ruleFlags(kind('gemini'), { effort: 'high' }), /Gemini CLI has no thinking level/);
    assert.throws(() => ruleFlags(kind('codex'), { effort: '--yolo' }), /thinking level is one of/);
  });

  it('is declared by every agent the same way: suggestions and levels it can flag, each once', () => {
    for (const agent of agentKinds()) {
      assert.equal(Boolean(agent.startsOn), typeof agent.ruleFlags === 'function', `${agent.id}: what it takes and how it is flagged go together`);
      const takes = agent.startsOn;
      if (!takes) continue;
      const models = takes.models.map((m) => m.id);
      assert.equal(new Set(models).size, models.length, agent.id);
      for (const model of models) assert.equal(modelProblem(model), undefined, `${agent.id} suggests ${model}`);
      const levels = (takes.levels ?? []).map((l) => l.id);
      assert.equal(new Set(levels).size, levels.length, agent.id);
      for (const level of takes.levels ?? []) assert.ok(level.label && !/^-/.test(level.id), `${agent.id} ${level.id}`);
    }
    assert.deepEqual(kind('claude').startsOn!.models.map((m) => m.id), ['opus', 'sonnet', 'haiku', 'fable']);
    assert.deepEqual(kind('claude').startsOn!.levels!.map((l) => l.id), ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(agentKinds().filter((a) => !a.startsOn?.levels?.length).map((a) => a.id), ['gemini', 'opencode', 'goose', 'hermes', 'grok']);
    assert.deepEqual(agentKinds().filter((a) => !a.startsOn).map((a) => a.id), ['goose'], 'its session takes no model flag');
  });

  it('takes the command line’s values over the rule’s, one by one', () => {
    assert.deepEqual(ruleWith({ model: 'opus', effort: 'high' }, { model: 'sonnet' }), { model: 'sonnet', effort: 'high' });
    assert.deepEqual(ruleWith({ model: 'opus' }, { effort: 'low' }), { model: 'opus', effort: 'low' });
    assert.deepEqual(ruleWith(undefined, undefined), {});
    assert.deepEqual(cleanRule({ model: ' opus ', effort: null }), { model: 'opus' });
  });
});

describe('What an agent runs on, in words', () => {
  const claude = kind('claude');
  it('says the chip: the model by its name, the level after it, Default for a level alone, nothing for its own settings', () => {
    assert.equal(ruleWords(claude, { model: 'opus', effort: 'high' }), 'Opus · high');
    assert.equal(ruleWords(claude, { model: 'opus', effort: 'xhigh' }), 'Opus · extra high');
    assert.equal(ruleWords(claude, { model: 'claude-opus-4-6' }), 'claude-opus-4-6', 'a model of its own, as typed');
    assert.equal(ruleWords(claude, { effort: 'low' }), 'Default · low');
    assert.equal(ruleWords(claude, {}), undefined);
    assert.equal(ruleWords(kind('gemini'), { model: 'gemini-2.5-pro' }), 'gemini-2.5-pro', 'the model alone for an agent with no levels');
  });

  it('says what it runs on now, and that it holds until a restart once the rule changed', () => {
    assert.equal(runningWords(claude, { model: 'opus', effort: 'high' }, { model: 'opus', effort: 'high' }), 'Running on Opus · high');
    assert.equal(runningWords(claude, { model: 'opus', effort: 'high' }, { model: 'sonnet', effort: 'medium' }), 'On Opus · high till it restarts');
    assert.equal(runningWords(claude, {}, {}), 'Running on its own settings');
    assert.equal(runningWords(claude, {}, { model: 'opus' }), 'On its own settings till it restarts');
    assert.equal(runningWords(claude, undefined, { model: 'opus' }), undefined, "Tricot didn't start it: nothing is said");
  });

  it('says it in a few words for the terminal’s strip', () => {
    assert.equal(stripWords(claude, { model: 'opus', effort: 'high' }), 'Opus high');
    assert.equal(stripWords(kind('codex'), { model: 'gpt-6.1-sol', effort: 'xhigh' }), 'gpt-6.1-sol xhigh');
    assert.equal(stripWords(claude, { effort: 'max' }), 'max');
    assert.equal(stripWords(claude, {}), undefined);
  });

  it('goes to the server on the MCP address, and comes back from it, for a session Tricot started alone', () => {
    const url = runsOnUrl('http://127.0.0.1:4545/mcp?agent=Claude', { model: 'claude opus/4', effort: 'high' });
    assert.equal(url, 'http://127.0.0.1:4545/mcp?agent=Claude&model=claude%20opus%2F4&effort=high');
    assert.equal(runsOnUrl(url, {}), 'http://127.0.0.1:4545/mcp?agent=Claude&model=&effort=', 'said again, not twice');
    const query = (address: string) => Object.fromEntries(new URL(address).searchParams);
    assert.deepEqual(runsOnOf(query(url)), { model: 'claude opus/4', effort: 'high' });
    assert.deepEqual(runsOnOf(query(runsOnUrl('http://x/mcp?agent=A', {}))), {}, 'its own settings');
    assert.equal(runsOnOf(query('http://x/mcp?agent=A')), undefined, 'connected by hand: unknown');
    assert.deepEqual(runsOnOf({ model: `opus\u001b[2J${'x'.repeat(200)}` }), { model: `opus[2J${'x'.repeat(113)}` }, 'cut short, control characters out');
  });
});

describe("The rule's routes", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let seat: TestSeat;

  const listen = async (rules = new AgentRulesStore({ dataDir: dir })) => {
    const store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', agentRules: rules });
    seat = letIn(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  const page = () => ({ 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' });
  const set = (agent: string, body: unknown, headers?: Record<string, string>) => {
    const route = `/api/agent-rules/${agent}`;
    return fetch(`${base}${route}`, { method: 'POST', headers: headers ?? { ...page(), ...seat.sign('POST', route, JSON.stringify(body)) }, body: JSON.stringify(body) });
  };
  const read = async () => ((await (await fetch(`${base}/api/agent-rules`)).json()) as { rules: AgentRules }).rules;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(scratch, 'data-'));
    await listen();
  });
  afterEach(close);

  it('has none set at first: each agent starts on its own settings', async () => {
    assert.deepEqual(await read(), {});
  });

  it('lets the person set one from a browser they let in, and read it back', async () => {
    const res = await set('claude', { model: ' opus ', effort: 'high' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(((await res.json()) as { rules: AgentRules }).rules, { claude: { model: 'opus', effort: 'high' } });
    assert.equal((await set('codex', { model: 'gpt-6.1-sol', effort: null })).status, 200);
    assert.deepEqual(await read(), { claude: { model: 'opus', effort: 'high' }, codex: { model: 'gpt-6.1-sol' } });
    // Default for both takes the entry out.
    assert.equal((await set('codex', { model: null, effort: null })).status, 200);
    assert.deepEqual(await read(), { claude: { model: 'opus', effort: 'high' } });
  });

  it('refuses an agent, a script, or a page that is not one of the person’s seats', async () => {
    const body = { model: 'opus', effort: 'max' };
    // An agent or a script, as a program calls it: no page, no seat.
    const plain = await set('claude', body, { 'Content-Type': 'application/json' });
    assert.equal(plain.status, 403);
    assert.match(((await plain.json()) as { error: string }).error, /^Refused: people do this in Tricot's page/);
    // One passing for the page, unsigned: told it needs a seat.
    const unsigned = await set('claude', body, page());
    assert.equal(unsigned.status, 403);
    assert.equal(((await unsigned.json()) as { code?: string }).code, 'seat_needed');
    // One of the person's seats, but a signature that isn't for this request.
    const replayed = await set('claude', body, { ...page(), ...seat.sign('POST', '/api/agent-rules/codex', JSON.stringify(body)) });
    assert.equal(replayed.status, 403);
    assert.deepEqual(await read(), {}, 'nothing was set');
  });

  it("refuses what the agent can't take, saying why, and an agent Tricot doesn't know", async () => {
    const refused: [string, unknown, number, RegExp][] = [
      ['claude', { model: '--dangerously-skip-permissions' }, 400, /starts with -, so the agent would read it as an option/],
      ['claude', { model: 'opus\n--yolo' }, 400, /control character/],
      ['claude', { effort: 'ultra' }, 400, /one of low, medium, high, xhigh or max/],
      ['opencode', { effort: 'high' }, 400, /OpenCode has no thinking level Tricot can set/],
      ['claude', { model: 7 }, 400, /model/],
      ['nobody', { model: 'opus' }, 404, /doesn't know an agent called "nobody"/],
    ];
    for (const [agent, body, status, words] of refused) {
      const res = await set(agent, body);
      assert.equal(res.status, status, JSON.stringify(body));
      assert.match(((await res.json()) as { error: string }).error, words);
    }
    assert.deepEqual(await read(), {});
  });

  it('keeps the rules in the data folder, for its owner alone, outside every board, and they outlive a restart', async () => {
    assert.equal((await set('claude', { model: 'opus', effort: 'high' })).status, 200);
    assert.equal((await set('pi', { effort: 'minimal' })).status, 200);
    const file = path.join(dir, RULES_FILE);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, rules: { claude: { model: 'opus', effort: 'high' }, pi: { effort: 'minimal' } } });
    if (!WINDOWS) assert.equal(statSync(file).mode & 0o777, 0o600);
    const store = new Store(dir);
    store.load();
    assert.ok(!JSON.stringify(store.listBoards()).includes('opus'), 'no board carries it');
    await close();
    await listen();
    assert.deepEqual(await read(), { claude: { model: 'opus', effort: 'high' }, pi: { effort: 'minimal' } });
  });

  it('reads what it can of a file it finds, and starts every agent on its own settings when it can read none', async () => {
    writeFileSync(path.join(dir, RULES_FILE), JSON.stringify({ version: 1, rules: { claude: { model: 'opus', effort: 3 }, codex: 'x', pi: { model: '' } } }));
    assert.deepEqual(new AgentRulesStore({ dataDir: dir }).all(), { claude: { model: 'opus' } });
    writeFileSync(path.join(dir, RULES_FILE), '{ not json');
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (line: string) => void warned.push(line);
    try {
      assert.deepEqual(new AgentRulesStore({ dataDir: dir }).all(), {});
    } finally {
      console.warn = warn;
    }
    assert.match(warned[0], /couldn't read .*agent-rules\.json/);
  });

  it('hears what a session Tricot started runs on, and which agent it is, for its panel', async () => {
    const connect = async (query: string, clientName: string) => {
      const client = new Client({ name: clientName, version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?${query}`)));
      return client;
    };
    const started = await connect('agent=Claude&model=opus&effort=high', 'claude-code');
    const own = await connect('agent=Codex&model=&effort=', 'codex-mcp-client');
    const byHand = await connect('agent=Reviewer', 'claude-code');
    try {
      const agents = (await (await fetch(`${base}/api/agents`)).json()) as AgentSkills[];
      const of = (name: string) => agents.find((a) => a.name === name)!;
      assert.deepEqual([of('Claude').tool, of('Claude').runsOn], ['claude', { model: 'opus', effort: 'high' }]);
      assert.deepEqual([of('Codex').tool, of('Codex').runsOn], ['codex', {}], 'started on its own settings');
      assert.deepEqual([of('Reviewer').tool, of('Reviewer').runsOn], ['claude', undefined], "connected by hand: Claude Code, on what it doesn't say");
    } finally {
      await Promise.all([started.close(), own.close(), byHand.close()]);
    }
  });
});

describe("The chip in an agent's panel", () => {
  const claude = kind('claude');
  const draw = (rule: AgentRule, name = 'Claude') => renderToStaticMarkup(createElement(RuleChip, { kind: claude, name, rule, onSet: async () => {} }));

  it('names the rule in the assignee chip’s shape, dashed when nothing is set, closed until clicked', () => {
    const set = draw({ model: 'opus', effort: 'high' });
    assert.match(set, /^<button type="button" class="assignee-chip agent-rule-chip" aria-haspopup="dialog" aria-expanded="false" title="Claude starts on Opus · high\. Change it\."><span class="agent-rule-chip-label">Opus · high<\/span><svg class="assignee-caret"/);
    const own = draw({});
    assert.match(own, /class="assignee-chip agent-rule-chip is-any"/);
    assert.match(own, />Its own settings<\/span><svg/);
    assert.match(own, /title="Claude starts on its own settings\. Choose a model and thinking level\."/);
  });

  it('is for an agent Tricot starts that takes a model, known by its session or its name on the board', () => {
    assert.equal(kindOf({ name: 'Claude' })?.id, 'claude');
    assert.equal(kindOf({ name: 'Reviewer', tool: 'claude' })?.id, 'claude');
    assert.equal(kindOf({ name: 'Someone' }), undefined);
    assert.equal(offersRule(kindOf({ name: 'Codex' })), true);
    assert.equal(offersRule(kindOf({ name: 'Gemini' })), false, "Tricot can't start Gemini CLI yet");
    assert.equal(offersRule(undefined), false);
    assert.equal(ruleOwner(claude, 'Claude'), 'Claude');
    assert.equal(ruleOwner(claude, 'Reviewer'), 'Claude Code', 'the rule is the tool’s, on every board');
  });
});
