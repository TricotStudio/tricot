import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentKinds, agentOfSource, agentsInCliOrder, defaultAgent, findAgent, installHints, panelTexts, skillsWords } from '../src/core/agents/registry';
import { approvalHarnesses } from '../src/core/approvals';
import { agentToConnect } from '../src/core/firstRun';
import { orNames } from '../src/core/format';
import { stepsCommandUnder } from '../src/core/liveSteps';
import { approvals, tools } from '../src/core/schemas';
import { USAGE_SOURCES } from '../src/core/usage';
import { hookInstallers } from '../src/server/hooks';

// The agent registry (core/agents/registry.ts): each agent says who it is once,
// in a browser-safe half and a server half, and what the half the page can't
// see claims has to agree with the half it can.
describe('the agent registry', () => {
  it('lists the agents in the Connect panel order, and the CLI in its own', () => {
    assert.deepEqual(agentKinds().map((kind) => kind.id), ['claude', 'codex', 'pi', 'omp', 'gemini', 'opencode', 'goose', 'hermes', 'grok', 'copilot']);
    assert.deepEqual(hookInstallers().map((installer) => installer.id), ['claude', 'codex', 'pi', 'omp', 'gemini', 'opencode', 'goose', 'hermes', 'grok', 'copilot']);
    assert.deepEqual(agentsInCliOrder().map((kind) => kind.id), ['claude', 'codex', 'opencode', 'gemini', 'pi', 'omp', 'goose', 'hermes', 'grok', 'copilot']);
  });

  it('has each agent once, with the live-steps installer of the same id, name and board name', () => {
    const ids = agentKinds().map((kind) => kind.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const kind of agentKinds()) {
      assert.equal(kind.hooks.id, kind.id);
      assert.equal(kind.hooks.name, kind.name, kind.id);
      assert.equal(kind.hooks.agentName, kind.boardName, kind.id);
    }
  });

  it('starts exactly the agents that do not say why they cannot', () => {
    for (const kind of agentKinds()) {
      assert.equal(typeof kind.session === 'function', !kind.cantStart, kind.id);
      if (kind.sessionHooks) assert.ok(kind.session, `${kind.id} has hooks for a session it cannot start`);
    }
    assert.deepEqual(agentKinds().filter((kind) => kind.cantStart).map((kind) => kind.id), ['gemini', 'goose', 'hermes', 'grok']);
  });

  it('connects by a command or by a file, and the panel has a text for each, and one for any other client', () => {
    assert.deepEqual(agentKinds().filter((kind) => kind.connect.how === 'file').map((kind) => kind.id), ['omp', 'opencode', 'goose', 'hermes']);
    const texts = panelTexts('http://127.0.0.1:4545/mcp');
    assert.deepEqual(Object.keys(texts).sort(), [...agentKinds().map((kind) => kind.id), 'other'].sort());
    for (const kind of agentKinds()) assert.ok(texts[kind.id], kind.id);
  });

  it('takes usage from the sources the agents name, each once', () => {
    assert.deepEqual([...USAGE_SOURCES], ['claude-statusline', 'codex-rollout', 'pi', 'omp', 'opencode']);
    assert.equal(agentOfSource('claude-statusline')?.id, 'claude');
    assert.equal(agentOfSource('codex-rollout')?.id, 'codex');
    assert.equal(agentOfSource('nope'), undefined);
  });

  // Every list of agents is read from the registry (T266): each check below
  // compares what is shown with agentKinds(), so a new agent missing from one fails.
  it('brings to the board the permission prompts of the agents that say so, and only theirs', () => {
    for (const kind of agentKinds()) assert.equal(Boolean(kind.approvals), Boolean(kind.hooks.approvals), `${kind.id}: approvals, and its installer's approval hook`);
    assert.deepEqual(approvalHarnesses(), agentKinds().filter((kind) => kind.approvals).map((kind) => kind.id));
    assert.deepEqual(approvalHarnesses(), ['claude', 'codex']);
    const request = (harness: string) => approvals.request.safeParse({ harness, tool: 'Bash', input: { command: 'ls' } });
    for (const kind of agentKinds()) assert.equal(request(kind.id).success, Boolean(kind.approvals), kind.id);
    const refused = request('nope');
    assert.equal(refused.error?.issues[0]?.message, `harness is ${orNames(approvalHarnesses().map((id) => `"${id}"`))}.`);
    assert.equal(refused.error?.issues[0]?.message, 'harness is "claude" or "codex".');
  });

  it('says what each agent calls its skills, and names every agent in what report_skills says they are', () => {
    for (const kind of agentKinds()) assert.ok(kind.skills.trim(), `${kind.id} says what its skills are called`);
    assert.equal(
      skillsWords(),
      'Claude Code skills, Codex prompts, Pi or OMP skills, Gemini CLI or OpenCode skills and commands, Goose, Hermes Agent, Grok Build or Copilot CLI skills',
    );
    // One more agent is named, by what it calls them, with its neighbour when they call them the same.
    const acme = { name: 'Acme Code', skills: 'recipes' };
    assert.match(skillsWords([...agentKinds(), acme]), /, Grok Build or Copilot CLI skills, Acme Code recipes$/);
    assert.match(skillsWords([...agentKinds(), { ...acme, skills: 'skills' }]), /, Goose, Hermes Agent, Grok Build, Copilot CLI or Acme Code skills$/);
    assert.ok(String(tools.report_skills.skills.description).includes(`(${skillsWords()})`), 'the skills argument names them');
  });

  it('offers the first agent when none is found or chosen, and names the others beside it', () => {
    assert.equal(defaultAgent(), agentKinds()[0]);
    assert.deepEqual(agentToConnect(undefined), { tool: defaultAgent().id, name: defaultAgent().name, found: false });
    assert.deepEqual(agentToConnect(agentKinds().map(({ id, name }) => ({ id, name, found: false }))).tool, defaultAgent().id);
    const { command, others } = stepsCommandUnder('Claude (reviewer)');
    assert.equal(command, `tricot steps on --agent ${defaultAgent().id} --name "Claude (reviewer)"`);
    assert.deepEqual([defaultAgent().id, ...others], agentKinds().map((kind) => kind.id), 'the hint names every agent, in the registry order');
  });

  it('gives an agent the same install hints on every system unless it has its own for one', () => {
    const omp = findAgent('omp')!;
    assert.deepEqual(installHints(omp, false), { commands: ['curl -fsSL https://omp.sh/install | sh -s -- --binary'], more: 'https://github.com/can1357/oh-my-pi' });
    const own = { ...omp, install: { commands: ['a'], windows: ['b'] } };
    assert.deepEqual(installHints(own, true), { commands: ['b'] });
    assert.deepEqual(installHints(own, false), { commands: ['a'] });
    assert.deepEqual(installHints({ ...omp, install: { commands: ['a'] } }, true), { commands: ['a'] });
  });
});
