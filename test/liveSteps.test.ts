import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { liveStepsAgentFor, liveStepsLabel, type LiveStepsAgent, type LiveStepsPreview, type LiveStepsReport, type LiveStepsResult } from '../src/core/liveSteps';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';
import { applyLiveSteps, compactFiles, liveStepsAgents, planLiveSteps, type LiveStepsContext } from '../src/server/hooks';
import { claude } from '../src/server/hooks/claude';
import { NOT_A_PERSON } from '../src/server/access';
import { NOT_FROM_HERE } from '../src/server/liveStepsRoutes';

// Every agent folder here is in a home made for the test, and PATH is empty:
// nothing reads or writes a real agent's settings, and no agent is run.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(repo, 'hooks');
const URL_ = 'http://127.0.0.1:4800';

let scratch: string;
before(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-live-steps-'));
});
after(() => rmSync(scratch, { recursive: true, force: true }));

// A home with these agents' folders, and a project in it.
function homeWith(...folders: string[]): LiveStepsContext & { home: string; project: string } {
  const home = mkdtempSync(path.join(scratch, 'home-'));
  for (const folder of folders) mkdirSync(path.join(home, folder), { recursive: true });
  const project = path.join(home, 'work/app');
  mkdirSync(project, { recursive: true });
  return { home, project, target: { home, project, env: { PATH: '' } }, source: SOURCE, url: URL_ };
}
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const byId = (agents: LiveStepsAgent[], id: string) => agents.find((a) => a.id === id)!;

describe('Live steps, for the person', () => {
  it('says, for each agent, whether it is here and whether its steps are on, in words', () => {
    const ctx = homeWith('.claude', '.codex');
    let agents = liveStepsAgents(ctx);
    assert.deepEqual(
      agents.map((a) => [a.id, a.found, a.state, liveStepsLabel(a)]),
      [
        ['claude', true, 'off', 'Off'],
        ['codex', true, 'off', 'Off'],
        ['pi', false, 'off', 'Not installed on this machine'],
        ['omp', false, 'off', 'Not installed on this machine'],
        ['gemini', false, 'off', 'Not installed on this machine'],
        ['opencode', false, 'off', 'Not installed on this machine'],
      ],
    );
    assert.equal(byId(agents, 'claude').where, '~/.claude/settings.json');
    assert.equal(byId(agents, 'pi').where, '~/.pi/agent/extensions/tricot-steps/');
    assert.equal(byId(agents, 'gemini').where, '~/.gemini/settings.json');
    assert.equal(byId(agents, 'opencode').where, '~/.config/opencode/plugins/tricot-steps.js');

    applyLiveSteps(ctx, planLiveSteps(ctx, 'claude', 'on'));
    applyLiveSteps(ctx, planLiveSteps(ctx, 'codex', 'on'));
    agents = liveStepsAgents(ctx);
    assert.equal(liveStepsLabel(byId(agents, 'claude')), 'On · Claude Code, user settings');
    assert.equal(liveStepsLabel(byId(agents, 'codex')), 'On · Codex, user hooks');
    assert.equal(byId(agents, 'codex').trust, "Needs your OK in Codex's /hooks");
    assert.equal(byId(agents, 'claude').trust, undefined);
    assert.equal(byId(agents, 'claude').sendsAs, 'Claude');
  });

  it('finds the agent a name on the board runs in', () => {
    const ctx = homeWith('.claude', '.codex', '.pi');
    applyLiveSteps(ctx, planLiveSteps(ctx, 'pi', 'on', { name: 'Builder' }));
    const agents = liveStepsAgents(ctx);
    const found = (name: string) => liveStepsAgentFor(name, agents)?.id;
    assert.equal(found('Claude'), 'claude');
    assert.equal(found('claude (reviewer)'), 'claude');
    assert.equal(found('Codex'), 'codex');
    assert.equal(found('Builder'), 'pi', 'by the name its hook sends as');
    assert.equal(found('Claudette'), undefined);
    assert.equal(found('Gemini'), 'gemini');
    assert.equal(found('OpenCode'), 'opencode');
    assert.equal(found('Cursor'), undefined);
  });

  it('turns Gemini CLI and OpenCode on and off like the others, each in its own words', () => {
    const ctx = homeWith('.gemini', '.config/opencode');
    let agents = liveStepsAgents(ctx);
    assert.deepEqual([byId(agents, 'gemini').found, byId(agents, 'opencode').found], [true, true]);
    const gemini = planLiveSteps(ctx, 'gemini', 'on');
    assert.equal(gemini.sendsAs, 'Gemini');
    assert.equal(compactFiles(gemini.files), '~/.gemini/hooks/{tricot-steps.mjs, tricot-describe.mjs}, ~/.gemini/settings.json');
    assert.match(gemini.notes[0], /waits for each hook/);
    const opencode = planLiveSteps(ctx, 'opencode', 'on');
    assert.equal(opencode.sendsAs, 'OpenCode');
    assert.equal(compactFiles(opencode.files), '~/.config/opencode/plugins/tricot-steps.js, ~/.config/opencode/tricot-steps/{tricot-describe.mjs, tricot-steps.json}');
    applyLiveSteps(ctx, gemini);
    assert.match(applyLiveSteps(ctx, opencode).summary, /OpenCode loads it in its next session/);
    agents = liveStepsAgents(ctx);
    assert.equal(liveStepsLabel(byId(agents, 'gemini')), 'On · Gemini CLI, user settings');
    assert.equal(liveStepsLabel(byId(agents, 'opencode')), 'On · OpenCode, user plugins');
    assert.equal(byId(agents, 'gemini').trust, undefined, 'its user hooks need no trust');
    for (const id of ['gemini', 'opencode']) applyLiveSteps(ctx, planLiveSteps(ctx, id, 'off'));
    agents = liveStepsAgents(ctx);
    assert.deepEqual([byId(agents, 'gemini').state, byId(agents, 'opencode').state], ['off', 'off']);
    assert.equal(existsSync(path.join(ctx.home, '.config/opencode/tricot-steps')), false);
  });

  it('shows the exact files and lines before writing, and writes what was shown', () => {
    const ctx = homeWith('.claude');
    const settings = path.join(ctx.home, '.claude/settings.json');
    const plan = planLiveSteps(ctx, 'claude', 'on', { name: 'Claude' });
    assert.deepEqual(
      plan.files.map((f) => [f.path, f.does]),
      [
        ['~/.claude/hooks/tricot-steps.mjs', 'write'],
        ['~/.claude/hooks/tricot-describe.mjs', 'write'],
        ['~/.claude/hooks/tricot-approve.mjs', 'write'],
        ['~/.claude/hooks/tricot-usage.mjs', 'write'],
        ['~/.claude/hooks/tricot-usage.json', 'write'],
        ['~/.claude/settings.json', 'add'],
      ],
    );
    assert.match(plan.files[5].lines!, /"PreToolUse"/);
    assert.match(plan.files[5].lines!, /"PermissionRequest"/, 'the approval hook, in the lines shown');
    assert.match(plan.files[5].lines!, /"statusLine"/);
    assert.ok(plan.notes.some((n) => /permission to run something, the request comes to the card/.test(n)), 'and said in words');
    assert.equal(compactFiles(plan.files), '~/.claude/hooks/{tricot-steps.mjs, tricot-describe.mjs, tricot-approve.mjs, tricot-usage.mjs, tricot-usage.json}, ~/.claude/settings.json');
    assert.equal(existsSync(settings), false, 'a plan writes nothing');
    assert.equal(planLiveSteps(ctx, 'claude', 'on', { name: 'Claude' }).digest, plan.digest, 'the same plan, the same digest');
    assert.notEqual(planLiveSteps(ctx, 'claude', 'on', { name: 'Other' }).digest, plan.digest);

    const done = applyLiveSteps(ctx, plan);
    assert.equal(done.changed, true);
    assert.equal(done.agent.state, 'on');
    assert.ok(existsSync(settings));
    assert.equal(planLiveSteps(ctx, 'claude', 'on').unchanged, true, 'on already');

    const off = planLiveSteps(ctx, 'claude', 'off');
    assert.deepEqual(
      off.files.map((f) => [f.path, f.does]),
      [
        ['~/.claude/settings.json', 'remove'],
        ['~/.claude/hooks/tricot-steps.mjs', 'delete'],
        ['~/.claude/hooks/tricot-describe.mjs', 'delete'],
        ['~/.claude/hooks/tricot-approve.mjs', 'delete'],
        ['~/.claude/hooks/tricot-usage.mjs', 'delete'],
        ['~/.claude/hooks/tricot-usage.json', 'delete'],
      ],
    );
    assert.match(off.files[0].lines!, /tricot-steps\.mjs/, 'the lines it takes out');
    assert.match(off.files[0].lines!, /tricot-approve\.mjs/, 'the approval hook with them');
    assert.match(off.text, /take out of ~\/\.claude\/settings\.json/);
    assert.equal(applyLiveSteps(ctx, off).agent.state, 'off');
    assert.deepEqual(json(settings), {}, 'nothing of Tricot left');
    assert.equal(planLiveSteps(ctx, 'claude', 'off').unchanged, true);
  });

  it("won't set up an agent that isn't on this machine, nor one it doesn't know", () => {
    const ctx = homeWith();
    assert.throws(() => planLiveSteps(ctx, 'pi', 'on'), /Pi isn't on this machine/);
    assert.throws(() => planLiveSteps(ctx, 'cursor', 'on'), /no live steps for "cursor"/);
    assert.equal(existsSync(path.join(ctx.home, '.pi')), false);
  });

  describe("a project's own Claude Code hook", () => {
    const withProjectHook = () => {
      const ctx = homeWith('.claude');
      claude.install({ ...ctx.target, project: ctx.project }, { url: URL_, source: SOURCE }, 'project');
      return ctx;
    };

    it("never touches it turning steps on or off for every project, and says it is there", () => {
      const ctx = withProjectHook();
      const projectSettings = path.join(ctx.project, '.claude/settings.json');
      const before = readFileSync(projectSettings, 'utf8');
      assert.equal(liveStepsAgents(ctx)[0].alsoInProject, '~/work/app');
      for (const action of ['on', 'off'] as const) {
        const plan = planLiveSteps(ctx, 'claude', action);
        assert.equal(plan.scope, 'user');
        assert.deepEqual(plan.files.filter((f) => f.path.includes('work/app')), [], `${action}: nothing in the project`);
        assert.doesNotMatch(plan.text, /work\/app/);
        applyLiveSteps(ctx, plan);
        assert.equal(readFileSync(projectSettings, 'utf8'), before, `${action}: the project's settings as they were`);
        assert.equal(claude.status(ctx.target, 'project').state, 'on');
      }
      assert.match(applyLiveSteps(ctx, planLiveSteps(ctx, 'claude', 'on')).summary, /^Turned on\. Claude Code picks it up/);
      assert.equal(liveStepsAgents(ctx)[0].alsoInProject, '~/work/app', 'still said, quietly');
    });

    it('tidies it up on its own, as connect claude --remove-hooks does, only ever taking it out', () => {
      const ctx = withProjectHook();
      applyLiveSteps(ctx, planLiveSteps(ctx, 'claude', 'on'));
      const tidy = planLiveSteps(ctx, 'claude', 'off', { scope: 'project' });
      assert.equal(tidy.project, '~/work/app');
      assert.deepEqual(
        tidy.files.map((f) => [f.path, f.does]),
        [
          ['~/work/app/.claude/settings.json', 'remove'],
          ['~/work/app/.claude/hooks/tricot-steps.mjs', 'delete'],
          ['~/work/app/.claude/hooks/tricot-describe.mjs', 'delete'],
        ],
      );
      assert.notEqual(tidy.digest, planLiveSteps(ctx, 'claude', 'off').digest);
      const done = applyLiveSteps(ctx, tidy);
      assert.match(done.summary, /^Tidied up ~\/work\/app/);
      assert.equal(claude.status(ctx.target, 'project').state, 'off');
      assert.equal(claude.status(ctx.target, 'user').state, 'on', 'the one for every project stays');
      assert.equal(done.agent.alsoInProject, undefined);
      assert.throws(() => planLiveSteps(ctx, 'claude', 'on', { scope: 'project' }), /only taken out here/);
      assert.throws(() => planLiveSteps(homeWith('.codex'), 'codex', 'off', { scope: 'project' }), /no project hook/);
    });

    it('sees no project hook when Tricot was started in the home folder itself', () => {
      const ctx = homeWith('.claude');
      const home = { ...ctx, target: { ...ctx.target, project: ctx.home } };
      claude.install(home.target, { url: URL_, source: SOURCE });
      assert.equal(liveStepsAgents(home)[0].alsoInProject, undefined);
      assert.throws(() => planLiveSteps(home, 'claude', 'off', { scope: 'project' }), /no project hook/);
    });
  });
});

describe('The live steps routes', () => {
  let ctx: ReturnType<typeof homeWith>;
  let dir: string;
  let server: Server;
  let base: string;
  let local: boolean;
  let seat: TestSeat; // the person's browser, let in: changing live steps needs one of their seats

  const listen = async (options: Parameters<typeof createApp>[1]) => {
    const store = new Store(dir);
    store.load();
    const app = createApp(store, options);
    seat = letIn(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const page = () => ({ 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' });
  const post = (url: string, body: unknown, headers?: Record<string, string>) =>
    fetch(`${base}${url}`, { method: 'POST', headers: headers ?? { ...page(), ...seat.sign('POST', url, JSON.stringify(body)) }, body: JSON.stringify(body) });
  const preview = async (agent: string, body: Record<string, unknown>) => {
    const res = await post(`/api/live-steps/${agent}/preview`, { actor: 'Wassim', ...body });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as LiveStepsPreview;
  };

  beforeEach(async () => {
    ctx = homeWith('.claude', '.codex');
    dir = mkdtempSync(path.join(scratch, 'data-'));
    local = true;
    await listen({ host: '127.0.0.1', mcpUrl: 'unused', liveSteps: { ...ctx, fromThisMachine: () => local } });
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("lists each agent's live steps, and that they can be changed from here", async () => {
    const report = (await (await fetch(`${base}/api/live-steps`)).json()) as LiveStepsReport;
    assert.equal(report.canChange, true);
    assert.deepEqual(
      report.agents.map((a) => [a.id, a.found, a.state]),
      [
        ['claude', true, 'off'],
        ['codex', true, 'off'],
        ['pi', false, 'off'],
        ['omp', false, 'off'],
        ['gemini', false, 'off'],
        ['opencode', false, 'off'],
      ],
    );
  });

  it('previews, then applies only with the fingerprint of that preview', async () => {
    const shown = await preview('codex', { action: 'on', name: 'Codex' });
    assert.match(shown.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(shown.sendsAs, 'Codex');
    assert.deepEqual(
      shown.files.map((f) => f.path),
      ['~/.codex/hooks/tricot-steps.mjs', '~/.codex/hooks/tricot-describe.mjs', '~/.codex/hooks/tricot-approve.mjs', '~/.codex/hooks/tricot-usage.mjs', '~/.codex/hooks.json'],
    );
    assert.ok(shown.notes.some((n) => /trust/.test(n)), "Codex's /hooks is said before");
    assert.equal(existsSync(path.join(ctx.home, '.codex/hooks.json')), false, 'a preview writes nothing');

    const without = await post('/api/live-steps/codex/apply', { actor: 'Wassim', action: 'on', name: 'Codex' });
    assert.equal(without.status, 400);
    assert.match(((await without.json()) as { error: string }).error, /fingerprint of the preview/);

    const forged = await post('/api/live-steps/codex/apply', { actor: 'Wassim', action: 'on', name: 'Codex', fingerprint: 'a'.repeat(64) });
    assert.equal(forged.status, 409);

    const other = await post('/api/live-steps/codex/apply', { actor: 'Wassim', action: 'on', name: 'Someone else', fingerprint: shown.fingerprint });
    assert.equal(other.status, 409, "a fingerprint holds only for what it showed");
    assert.equal(existsSync(path.join(ctx.home, '.codex/hooks.json')), false);

    const applied = await post('/api/live-steps/codex/apply', { actor: 'Wassim', action: 'on', name: 'Codex', fingerprint: shown.fingerprint });
    assert.equal(applied.status, 200);
    const result = (await applied.json()) as LiveStepsResult;
    assert.equal(result.changed, true);
    assert.equal(result.summary, 'Turned on. Codex picks it up in its next session, once you trust it in /hooks.');
    assert.equal(result.agent.state, 'on');
    assert.ok(result.notes.some((n) => /\/hooks/.test(n)), "and said after: trust it in Codex's /hooks");
    assert.equal(json(path.join(ctx.home, '.codex/hooks.json')).hooks.PreToolUse.length, 1);

    const off = await preview('codex', { action: 'off' });
    assert.deepEqual(off.files.map((f) => f.does), ['remove', 'delete', 'delete', 'delete', 'delete']);
    const removed = (await (await post('/api/live-steps/codex/apply', { actor: 'Wassim', action: 'off', fingerprint: off.fingerprint })).json()) as LiveStepsResult;
    assert.equal(removed.agent.state, 'off');
    assert.match(removed.summary, /^Turned off\. Codex stops sending steps/);
  });

  it('writes nothing when what it would write changed after the preview', async () => {
    const shown = await preview('claude', { action: 'on', name: 'Claude' });
    // Something else sets it up in between, with another name.
    claude.install(ctx.target, { url: URL_, source: SOURCE, name: 'Elsewhere' });
    const before = readFileSync(path.join(ctx.home, '.claude/settings.json'), 'utf8');
    const res = await post('/api/live-steps/claude/apply', { actor: 'Wassim', action: 'on', name: 'Claude', fingerprint: shown.fingerprint });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /changed since you saw it/);
    assert.equal(readFileSync(path.join(ctx.home, '.claude/settings.json'), 'utf8'), before);
  });

  it('takes a fingerprint only from a preview this server gave', async () => {
    const shown = await preview('claude', { action: 'on', name: 'Claude' });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await listen({ host: '127.0.0.1', mcpUrl: 'unused', liveSteps: { ...ctx, fromThisMachine: () => true } });
    const res = await post('/api/live-steps/claude/apply', { actor: 'Wassim', action: 'on', name: 'Claude', fingerprint: shown.fingerprint });
    assert.equal(res.status, 409, 'restarted: a new key');
    assert.equal(existsSync(path.join(ctx.home, '.claude/settings.json')), false);
  });

  it("refuses agents and scripts: changes come from a person in Tricot's page", async () => {
    const requests: Record<string, string>[] = [
      { 'Content-Type': 'application/json' }, // an agent with curl
      // Not from Tricot's own page (one from another site or page is refused before this, as on every route).
      { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'none' },
    ];
    for (const headers of requests) {
      for (const route of ['preview', 'apply']) {
        const res = await post(`/api/live-steps/claude/${route}`, { actor: 'Wassim', action: 'on', fingerprint: 'a'.repeat(64) }, headers);
        assert.equal(res.status, 403, `${route} ${JSON.stringify(headers)}`);
        assert.equal(((await res.json()) as { error: string }).error, NOT_A_PERSON);
      }
    }
    const elsewhere = await post('/api/live-steps/claude/preview', { actor: 'Wassim', action: 'on' }, { ...page(), Origin: 'https://evil.example' });
    assert.equal(elsewhere.status, 403, 'another site, as for every route');
    assert.equal(existsSync(path.join(ctx.home, '.claude/settings.json')), false);
  });

  it('has no MCP tool for it', async () => {
    const client = new Client({ name: 'agent', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    assert.ok(names.length > 0);
    assert.deepEqual(names.filter((n) => /hook|live.?step/i.test(n)), []);
  });

  it('is changed only from the computer Tricot runs on', async () => {
    local = false;
    const report = (await (await fetch(`${base}/api/live-steps`)).json()) as LiveStepsReport;
    assert.equal(report.canChange, false);
    assert.equal(report.why, NOT_FROM_HERE);
    for (const route of ['preview', 'apply']) {
      const res = await post(`/api/live-steps/claude/${route}`, { actor: 'Wassim', action: 'on', fingerprint: 'a'.repeat(64) });
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { error: string }).error, NOT_FROM_HERE);
    }
  });

  it('needs the token beyond this machine, as every route does', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await listen({ host: '0.0.0.0', mcpUrl: 'unused', token: 'a-token-that-is-long-enough-for-tricot-123', liveSteps: { ...ctx } });
    assert.equal((await fetch(`${base}/api/live-steps`)).status, 401);
    const withToken = await fetch(`${base}/api/live-steps`, { headers: { Authorization: 'Bearer a-token-that-is-long-enough-for-tricot-123' } });
    assert.equal(withToken.status, 200);
  });

  it('says what is wrong with a request, and leaves settings it cannot read alone', async () => {
    const unknown = await post('/api/live-steps/cursor/preview', { actor: 'Wassim', action: 'on' });
    assert.equal(unknown.status, 404);
    const absent = await post('/api/live-steps/pi/preview', { actor: 'Wassim', action: 'on' });
    assert.equal(absent.status, 409);
    assert.match(((await absent.json()) as { error: string }).error, /isn't on this machine/);
    const sideways = await post('/api/live-steps/claude/preview', { actor: 'Wassim', action: 'sideways' });
    assert.equal(sideways.status, 400);
    assert.match(((await sideways.json()) as { error: string }).error, /"on" or "off"/);

    writeFileSync(path.join(ctx.home, '.claude/settings.json'), '{ not json');
    const broken = await post('/api/live-steps/claude/preview', { actor: 'Wassim', action: 'on' });
    assert.equal(broken.status, 409);
    assert.match(((await broken.json()) as { error: string }).error, /left as it is/);
    const report = (await (await fetch(`${base}/api/live-steps`)).json()) as LiveStepsReport;
    assert.match(liveStepsLabel(report.agents[0]), /^Can't read/);
  });

  it("leaves a project's own hook alone turning steps on, and tidies it up only on its own preview", async () => {
    claude.install({ ...ctx.target }, { url: URL_, source: SOURCE }, 'project');
    const shown = await preview('claude', { action: 'on', name: 'Claude' });
    assert.equal(shown.scope, 'user');
    assert.deepEqual(shown.files.filter((f) => f.path.includes('work/app')), []);
    await post('/api/live-steps/claude/apply', { actor: 'Wassim', action: 'on', name: 'Claude', fingerprint: shown.fingerprint });
    assert.equal(claude.status(ctx.target, 'project').state, 'on', 'untouched');
    const report = (await (await fetch(`${base}/api/live-steps`)).json()) as LiveStepsReport;
    assert.equal(report.agents[0].alsoInProject, '~/work/app');

    const tidy = await preview('claude', { action: 'off', scope: 'project' });
    assert.equal(tidy.project, '~/work/app');
    const other = await post('/api/live-steps/claude/apply', { actor: 'Wassim', action: 'off', fingerprint: tidy.fingerprint });
    assert.equal(other.status, 409, "a tidy-up's fingerprint doesn't turn steps off for every project");
    const done = (await (await post('/api/live-steps/claude/apply', { actor: 'Wassim', action: 'off', scope: 'project', fingerprint: tidy.fingerprint })).json()) as LiveStepsResult;
    assert.match(done.summary, /^Tidied up ~\/work\/app/);
    assert.equal(claude.status(ctx.target, 'project').state, 'off');
    assert.equal(claude.status(ctx.target, 'user').state, 'on');
    const turnOn = await post('/api/live-steps/claude/preview', { actor: 'Wassim', action: 'on', scope: 'project' });
    assert.equal(turnOn.status, 400);
  });
});
