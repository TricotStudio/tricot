import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentKinds, agentOfSource, agentsInCliOrder, findAgent, installHints, panelTexts } from '../src/core/agents/registry';
import { USAGE_SOURCES } from '../src/core/usage';
import { hookInstallers } from '../src/server/hooks';

// The agent registry (core/agents/registry.ts): each agent says who it is once,
// in a browser-safe half and a server half, and what the half the page can't
// see claims has to agree with the half it can.
describe('the agent registry', () => {
  it('lists the agents in the Connect panel order, and the CLI in its own', () => {
    assert.deepEqual(agentKinds().map((kind) => kind.id), ['claude', 'codex', 'pi', 'omp', 'gemini', 'opencode']);
    assert.deepEqual(hookInstallers().map((installer) => installer.id), ['claude', 'codex', 'pi', 'omp', 'gemini', 'opencode']);
    assert.deepEqual(agentsInCliOrder().map((kind) => kind.id), ['claude', 'codex', 'opencode', 'gemini', 'pi', 'omp']);
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
    assert.deepEqual(agentKinds().filter((kind) => kind.cantStart).map((kind) => kind.id), ['gemini']);
  });

  it('connects by a command or by a file, and the panel has a text for each, and one for any other client', () => {
    assert.deepEqual(agentKinds().filter((kind) => kind.connect.how === 'file').map((kind) => kind.id), ['omp', 'opencode']);
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

  it('gives an agent the same install hints on every system unless it has its own for one', () => {
    const omp = findAgent('omp')!;
    assert.deepEqual(installHints(omp, false), { commands: ['curl -fsSL https://omp.sh/install | sh -s -- --binary'], more: 'https://github.com/can1357/oh-my-pi' });
    const own = { ...omp, install: { commands: ['a'], windows: ['b'] } };
    assert.deepEqual(installHints(own, true), { commands: ['b'] });
    assert.deepEqual(installHints(own, false), { commands: ['a'] });
    assert.deepEqual(installHints({ ...omp, install: { commands: ['a'] } }, true), { commands: ['a'] });
  });
});
