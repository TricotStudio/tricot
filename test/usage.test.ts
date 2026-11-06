import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stepsExtension, type ExtensionApi, type Fetch, type StepsContext } from '../hooks/tricot-steps-extension';
import { fromRollout, fromStatusLine, readTail, TAIL_BYTES } from '../hooks/tricot-usage.mjs';
import { countActivity, GAP_MS, joinedLength } from '../src/core/agentActivity';
import { agentUsage } from '../src/core/schemas';
import { Store } from '../src/core/store';
import type { BoardEvent } from '../src/core/types';
import {
  asOf,
  liveWindows,
  notSharedLine,
  STALE_MS,
  timeUntil,
  tokenCount,
  tokensLine,
  usageLevel,
  windowLine,
  windowName,
  workingText,
  type AgentUsageReport,
} from '../src/core/usage';
import { createApp } from '../src/server/app';
import { planLiveSteps } from '../src/server/hooks';
import { claude } from '../src/server/hooks/claude';
import { codex } from '../src/server/hooks/codex';
import { opencode } from '../src/server/hooks/opencode';
import { mergeUsage, Usage } from '../src/server/usage';
import { removeScratch, WINDOWS } from './platform';

// A path as a hook command writes it: with forward slashes on Windows, which
// every shell there leaves alone (shellPath in src/server/hooks/installer.ts).
const asWritten = (file: string) => (WINDOWS ? file.replaceAll('\\', '/') : file);

// Plan usage, from each harness to an agent's panel. Every install runs in a
// home made for the test under .review/, and every session file is one the
// test writes: no real agent's settings or records are read, and no agent is run.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(repo, 'hooks');
const WRAPPER = path.join(SOURCE, 'tricot-usage.mjs');
const TRICOT_URL = 'http://127.0.0.1:4800';
const setup = { url: TRICOT_URL, source: SOURCE };

let scratch: string;
before(() => {
  mkdirSync(path.join(repo, '.review'), { recursive: true });
  scratch = mkdtempSync(path.join(repo, '.review', 'test-usage-'));
});
after(() => removeScratch(scratch));

const freshHome = () => ({ home: mkdtempSync(path.join(scratch, 'home-')), env: {} });
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// What Claude Code gives its status line, with what must never leave.
const STATUS_LINE_INPUT = {
  session_id: 'SECRET-session',
  session_name: 'SECRET name of the session',
  transcript_path: '/Users/me/.claude/projects/SECRET/abc.jsonl',
  cwd: '/Users/me/SECRET-project',
  model: { id: 'claude-opus-5-5', display_name: 'Opus' },
  workspace: { current_dir: '/Users/me/SECRET-project', project_dir: '/Users/me/SECRET-project', repo: { host: 'github.com', owner: 'SECRET', name: 'SECRET' } },
  version: '2.1.90',
  cost: { total_cost_usd: 3.125, total_duration_ms: 45000, total_lines_added: 156 },
  context_window: { total_input_tokens: 15500, context_window_size: 200000, used_percentage: 38, remaining_percentage: 62 },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1_900_000_000 },
    seven_day: { used_percentage: 41.2, resets_at: 1_900_300_000 },
    spend_limit: { used_percentage: 62.8, resets_at: 1_900_900_000, used_usd: 314.12 },
  },
  worktree: { name: 'SECRET', path: '/SECRET' },
};

// ---- Claude Code's status line --------------------------------------------------------

describe("the status line's numbers (hooks/tricot-usage.mjs)", () => {
  it('keeps only the plan windows, the cost and the context, as numbers', () => {
    const usage = fromStatusLine(STATUS_LINE_INPUT);
    assert.deepEqual(usage, {
      source: 'claude-statusline',
      windows: [
        { id: '5h', usedPercent: 23.5, resetsAt: 1_900_000_000_000, minutes: 300 },
        { id: '7d', usedPercent: 41.2, resetsAt: 1_900_300_000_000, minutes: 10080 },
      ],
      costUsd: 3.125,
      context: { usedPercent: 38, window: 200000 },
    });
    assert.doesNotMatch(JSON.stringify(usage), /SECRET|Users|Opus|2\.1\.90|github/);
    assert.equal(agentUsage.safeParse({ usage, at: Date.now() }).success, true, 'what the server takes');
  });

  it('sends nothing before a session has numbers, and skips a window it can only half read', () => {
    assert.equal(fromStatusLine({ session_id: 'x', transcript_path: '/SECRET', cost: { total_cost_usd: 0 }, context_window: { used_percentage: null } }), undefined);
    assert.equal(fromStatusLine('not an object'), undefined);
    const half = fromStatusLine({ rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: '5', resets_at: 1_900_000_000 } }, cost: { total_cost_usd: 0.5 } });
    assert.deepEqual(half, { source: 'claude-statusline', costUsd: 0.5 });
  });
});

// The wrapper as Claude Code runs it: the input on stdin, its output what the status line shows.
function runWrapper(script: string, input: string, args: string[] = []): Promise<{ code: number | null; stdout: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH } });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - started }));
    child.stdin.end(input);
  });
}

// A stand-in for Tricot that keeps what it is sent.
async function catcher(): Promise<{ server: Server; url: string; got: { url: string; body: unknown }[] }> {
  const got: { url: string; body: unknown }[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      got.push({ url: req.url ?? '', body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"kept":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, got };
}

describe('the status line, set up for Claude Code (hooks/tricot-usage.mjs)', () => {
  const files = (home: string) => ({
    settings: path.join(home, '.claude/settings.json'),
    wrapper: path.join(home, '.claude/hooks/tricot-usage.mjs'),
    kept: path.join(home, '.claude/hooks/tricot-usage.json'),
  });

  it("runs the person's own status line with the same input, prints its output as it is, with its exit code, and sends Tricot only numbers", { skip: WINDOWS && 'their status line here is a POSIX shell command (cat, printf)' }, async () => {
    const target = freshHome();
    const f = files(target.home);
    const theirs = { type: 'command', command: 'cat; printf "\\033[32mmine\\033[0m\\n"; exit 3', padding: 2 };
    write(f.settings, jsonText({ model: 'opus', statusLine: theirs }));
    claude.install(target, setup);
    const tricot = await catcher();
    try {
      const input = JSON.stringify(STATUS_LINE_INPUT);
      const ran = await runWrapper(f.wrapper, input, ['--name', 'Claude', '--url', tricot.url]);
      assert.equal(ran.code, 3, 'its exit code');
      assert.equal(ran.stdout, `${input}\u001b[32mmine\u001b[0m\n`, 'its output, byte for byte, after the same input');
      assert.equal(tricot.got.length, 1);
      assert.equal(tricot.got[0].url, '/api/agents/Claude/usage');
      const sent = tricot.got[0].body as { usage: unknown; at: number };
      assert.deepEqual(Object.keys(sent), ['usage', 'at']);
      assert.deepEqual(sent.usage, fromStatusLine(STATUS_LINE_INPUT));
      assert.doesNotMatch(JSON.stringify(sent), /SECRET|Users|transcript|session/);
    } finally {
      tricot.server.close();
    }
  });

  it('prints nothing and exits 0 with no status line of the person to run, and never fails when Tricot is closed', async () => {
    const target = freshHome();
    claude.install(target, setup);
    const ran = await runWrapper(files(target.home).wrapper, JSON.stringify(STATUS_LINE_INPUT), ['--url', 'http://127.0.0.1:9']);
    assert.deepEqual([ran.code, ran.stdout], [0, '']);
    assert.ok(ran.ms < 3000, `${ran.ms}ms`);
    const garbage = await runWrapper(files(target.home).wrapper, 'not json', ['--url', 'http://127.0.0.1:9']);
    assert.deepEqual([garbage.code, garbage.stdout], [0, '']);
  });

  it("puts the person's status line back exactly, and none when they had none", () => {
    const target = freshHome();
    const f = files(target.home);
    const original = { permissions: { allow: ['Bash(ls)'] }, statusLine: { type: 'command', command: '~/.claude/statusline.sh', padding: 2, refreshInterval: 5 }, theme: 'dark' };
    write(f.settings, jsonText(original));
    const before = readFileSync(f.settings, 'utf8');

    const preview = claude.preview(target, setup);
    assert.ok(preview.notes.some((n) => n.includes('`~/.claude/statusline.sh`') && /puts yours back exactly/.test(n)), preview.notes.join('\n'));
    assert.ok(preview.notes.some((n) => /numbers only/.test(n)));
    assert.equal(readFileSync(f.settings, 'utf8'), before, 'a preview writes nothing');

    claude.install(target, setup);
    const on = json(f.settings);
    assert.deepEqual(Object.keys(on), ['permissions', 'statusLine', 'theme', 'hooks'], "Tricot's line in the place of theirs");
    assert.deepEqual(on.statusLine, { type: 'command', command: `node "${asWritten(f.wrapper)}" --name Claude --url ${TRICOT_URL}`, padding: 2, refreshInterval: 5 });
    assert.deepEqual(json(f.kept), { had: true, previous: original.statusLine });
    assert.equal(readFileSync(f.wrapper, 'utf8'), readFileSync(WRAPPER, 'utf8'), 'written whole, not linked');
    assert.equal(claude.status(target).usage, 'on');

    // Turned on again (another name): what was kept stays theirs, never Tricot's own line.
    claude.install(target, { ...setup, name: 'Claude (builder)' });
    assert.deepEqual(json(f.kept), { had: true, previous: original.statusLine });

    const off = claude.previewUninstall(target);
    assert.ok(off.notes.includes('Your own status line goes back in its place: `~/.claude/statusline.sh`.'), off.notes.join('\n'));
    const switchedOff = planLiveSteps({ target, source: SOURCE, url: TRICOT_URL }, 'claude', 'off');
    assert.match(switchedOff.text, /Your own status line goes back in its place/, 'the switch and `tricot steps off` say it too');
    claude.uninstall(target);
    assert.equal(readFileSync(f.settings, 'utf8'), before, 'the settings as they were, to the byte');
    assert.equal(existsSync(f.wrapper) || existsSync(f.kept), false);

    // With no status line of their own: none again after.
    const bare = freshHome();
    const b = files(bare.home);
    write(b.settings, jsonText({ model: 'opus' }));
    const bareBefore = readFileSync(b.settings, 'utf8');
    assert.ok(claude.preview(bare, setup).notes.some((n) => /footer's hints/.test(n)));
    claude.install(bare, setup);
    assert.deepEqual(json(b.kept), { had: false });
    assert.deepEqual(json(b.settings).statusLine, { type: 'command', command: `node "${asWritten(b.wrapper)}" --name Claude --url ${TRICOT_URL}` });
    assert.ok(claude.previewUninstall(bare).notes.includes('Claude Code goes back to having no status line.'));
    claude.uninstall(bare);
    assert.equal(readFileSync(b.settings, 'utf8'), bareBefore);
  });

  it('notices a status line the person set since, says so, and leaves it alone', () => {
    const target = freshHome();
    const f = files(target.home);
    write(f.settings, jsonText({ statusLine: { type: 'command', command: 'echo old' } }));
    claude.install(target, setup);
    const settings = json(f.settings);
    settings.statusLine = { type: 'command', command: 'echo new, from /statusline' };
    write(f.settings, jsonText(settings));

    const status = claude.status(target);
    assert.equal(status.state, 'on', 'their steps are still on: not "partly", nothing to mend');
    assert.equal(status.usage, 'replaced');
    assert.equal(status.missing, undefined);

    const off = claude.previewUninstall(target);
    assert.ok(off.notes.includes('Your status line changed since Tricot set it up, so Tricot leaves it as it is.'));
    assert.doesNotMatch(off.changes[0].lines!, /statusLine/, 'only the hooks come out');
    claude.uninstall(target);
    assert.deepEqual(json(f.settings), { statusLine: { type: 'command', command: 'echo new, from /statusline' } });
    assert.equal(existsSync(f.kept), false);
  });

  it('says partly for steps set up before Tricot had plan usage, and turning on adds it', () => {
    const target = freshHome();
    const f = files(target.home);
    claude.install(target, setup);
    // As an older Tricot left it: the steps alone.
    rmSync(f.wrapper);
    rmSync(f.kept);
    const settings = json(f.settings);
    delete settings.statusLine;
    write(f.settings, jsonText(settings));
    const status = claude.status(target);
    assert.equal(status.state, 'partly');
    assert.deepEqual(status.missing, ['~/.claude/hooks/tricot-usage.mjs', '~/.claude/hooks/tricot-usage.json', 'the status line in ~/.claude/settings.json']);
    assert.equal(status.usage, 'off');
    claude.install(target, setup);
    assert.deepEqual([claude.status(target).state, claude.status(target).usage], ['on', 'on']);
  });

  it("is only for every project: a project's own hook gets no status line", () => {
    const target = { ...freshHome(), project: '' };
    target.project = path.join(target.home, 'app');
    mkdirSync(target.project, { recursive: true });
    const preview = claude.preview(target, setup, 'project');
    assert.deepEqual(
      preview.changes.map((c) => path.basename(c.path)),
      ['tricot-steps.mjs', 'tricot-describe.mjs', 'settings.json'],
    );
    assert.doesNotMatch(preview.text, /statusLine/);
  });
});

// ---- Codex's session file ------------------------------------------------------------------

const tokenLine = (rateLimits: unknown, extra: Record<string, unknown> = {}, timestamp = '2026-11-03T12:00:00.000Z') =>
  JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 840_000, cached_input_tokens: 310_000, output_tokens: 30_000, reasoning_output_tokens: 12_000, total_tokens: 870_000 }, last_token_usage: {}, model_context_window: 272000 },
      rate_limits: rateLimits,
      ...extra,
    },
  });

const SECRET_LINES = [
  JSON.stringify({ timestamp: '2026-11-03T11:59:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SECRET prompt "token_count"' }] } }),
  JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/me/SECRET', instructions: 'SECRET' } }),
];

describe("Codex's plan usage, from the end of its session file (hooks/tricot-usage.mjs)", () => {
  const rollout = (name: string, lines: string[]) => {
    const file = path.join(mkdtempSync(path.join(scratch, 'codex-')), name);
    write(file, `${lines.join('\n')}\n`);
    return file;
  };

  it('reads the windows with resets_at, the plan and the token totals from the last token_count', () => {
    const file = rollout('rollout-2026-11-03T11-58-00-abc.jsonl', [
      ...SECRET_LINES,
      tokenLine({ primary: { used_percent: 5, window_minutes: 300, resets_at: 1_800_000_000 } }),
      'garbage { not json',
      tokenLine({ primary: { used_percent: 26, window_minutes: 300, resets_at: 1_900_000_000 }, secondary: { used_percent: 41, window_minutes: 10080, resets_at: 1_900_400_000 }, plan_type: 'plus', credits: { balance: 'SECRET' } }),
      SECRET_LINES[0],
    ]);
    const usage = fromRollout(readTail(file));
    assert.deepEqual(usage, {
      source: 'codex-rollout',
      plan: 'plus',
      windows: [
        { id: '5h', usedPercent: 26, resetsAt: 1_900_000_000_000, minutes: 300 },
        { id: '7d', usedPercent: 41, resetsAt: 1_900_400_000_000, minutes: 10080 },
      ],
      tokens: { input: 840_000, output: 30_000, cacheRead: 310_000, cacheWrite: 0, reasoning: 12_000, total: 870_000 },
    });
    assert.doesNotMatch(JSON.stringify(usage), /SECRET|Users/);
    assert.equal(agentUsage.safeParse({ usage, at: Date.now() }).success, true);
  });

  it("works out a reset from resets_in_seconds (Codex 0.41), from when the event was written", () => {
    const written = Date.parse('2026-11-03T12:00:00.000Z');
    const file = rollout('rollout-old.jsonl', [tokenLine({ primary: { used_percent: 12.5, window_minutes: 300, resets_in_seconds: 3600 }, secondary: { used_percent: 3 } })]);
    assert.deepEqual(fromRollout(readTail(file))?.windows, [{ id: '5h', usedPercent: 12.5, resetsAt: written + 3_600_000, minutes: 300 }], 'a window with no reset is left out');
  });

  it('keeps the tokens when a turn has no rate limits, and prefers the plan’s own limit to a model’s', () => {
    assert.deepEqual(Object.keys(fromRollout(readTail(rollout('rollout-a.jsonl', [tokenLine(null)])))!), ['source', 'tokens']);
    const plan = { limit_id: 'codex', primary: { used_percent: 30, resets_at: 1_900_000_000 } };
    const model = { limit_id: 'codex_other', limit_name: 'Other', primary: { used_percent: 90, resets_at: 1_900_000_000 } };
    assert.equal(fromRollout(readTail(rollout('rollout-b.jsonl', [tokenLine(plan), tokenLine(model)])))?.windows?.[0].usedPercent, 30);
    assert.equal(fromRollout(readTail(rollout('rollout-c.jsonl', [tokenLine(model)])))?.windows?.[0].usedPercent, 90, 'the model’s, when it is all there is');
    assert.equal(fromRollout(readTail(rollout('rollout-d.jsonl', SECRET_LINES))), undefined);
  });

  it('reads only the last 256 KB, from a whole line, and skips compressed, misnamed and missing files', () => {
    const filler = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1000) } });
    const big = rollout('rollout-big.jsonl', [...Array.from({ length: 400 }, () => filler), tokenLine({ primary: { used_percent: 7, resets_at: 1_900_000_000 } })]);
    const tail = readTail(big)!;
    assert.equal(tail.cut, true);
    assert.ok(Buffer.byteLength(tail.text) <= TAIL_BYTES);
    assert.equal(fromRollout(tail)?.windows?.[0].usedPercent, 7);

    const line = tokenLine({ primary: { used_percent: 7, resets_at: 1_900_000_000 } });
    assert.equal(readTail(rollout('rollout-z.jsonl.zst', [line])), undefined, 'compressed');
    assert.equal(readTail(rollout('notes.jsonl', [line])), undefined, 'not a session file');
    assert.equal(readTail(path.join(scratch, 'rollout-gone.jsonl')), undefined);
    assert.equal(readTail(mkdtempSync(path.join(scratch, 'rollout-dir-'))), undefined);
    assert.equal(readTail(undefined), undefined);
  });

  it("is read by Codex's steps hook at the end of a turn, as installed, and sent beside the step", async () => {
    const target = freshHome();
    codex.install(target, setup);
    const hooks = json(path.join(target.home, '.codex/hooks.json'));
    assert.match(hooks.hooks.Stop[0].hooks[0].command, / --usage$/);
    assert.equal(codex.status(target).usage, 'on');
    const file = rollout('rollout-2026-11-03.jsonl', [...SECRET_LINES, tokenLine({ primary: { used_percent: 26, window_minutes: 300, resets_at: 1_900_000_000 }, plan_type: 'pro' })]);
    const script = path.join(target.home, '.codex/hooks/tricot-steps.mjs');
    const stop = { hook_event_name: 'Stop', session_id: 's', turn_id: 't', cwd: '/w', transcript_path: file, last_assistant_message: 'SECRET reply' };
    const ran = await runWrapper(script, JSON.stringify(stop), ['--dry-run', '--usage']);
    const [step, usage] = ran.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(step.done, true);
    assert.deepEqual(usage.usage, { source: 'codex-rollout', plan: 'pro', windows: [{ id: '5h', usedPercent: 26, resetsAt: 1_900_000_000_000, minutes: 300 }], tokens: { input: 840_000, output: 30_000, cacheRead: 310_000, cacheWrite: 0, reasoning: 12_000, total: 870_000 } });
    assert.doesNotMatch(ran.stdout, /SECRET|Users/);
    // Without --usage, or on another event, the file isn't read.
    const plain = await runWrapper(script, JSON.stringify(stop), ['--dry-run']);
    assert.equal(plain.stdout.trim().split('\n').length, 1);
    const pre = await runWrapper(script, JSON.stringify({ ...stop, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/w/a.ts' } }), ['--dry-run', '--usage']);
    assert.equal(pre.stdout.trim().split('\n').length, 1);
  });
});

// ---- the server ----------------------------------------------------------------------------

describe('POST /api/agents/:name/usage', () => {
  const valid = { usage: { source: 'codex-rollout', plan: 'plus', windows: [{ id: '5h', usedPercent: 26, resetsAt: 1_900_000_000_000, minutes: 300 }, { id: '7d:opus', usedPercent: 3, resetsAt: 1_900_000_000_000 }], tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 0, total: 6 }, costUsd: 0.5, context: { usedPercent: 10, window: 200000 } }, at: 1_800_000_000_000 };

  it('takes numbers and a closed set of names, and refuses anything else', () => {
    assert.equal(agentUsage.safeParse(valid).success, true);
    const refused = [
      { ...valid, extra: 1 },
      { ...valid, usage: { ...valid.usage, cwd: '/Users/me' } },
      { ...valid, usage: { ...valid.usage, source: 'gemini' } },
      { ...valid, usage: { ...valid.usage, plan: '/Users/me/secret' } },
      { ...valid, usage: { ...valid.usage, windows: [{ id: '1h', usedPercent: 1, resetsAt: 1 }] } },
      { ...valid, usage: { ...valid.usage, windows: [{ id: '5h', usedPercent: '26', resetsAt: 1 }] } },
      { ...valid, usage: { ...valid.usage, windows: [{ id: '5h', usedPercent: 1, resetsAt: 1, transcript: 'x' }] } },
      { ...valid, usage: { ...valid.usage, windows: [valid.usage.windows[0], valid.usage.windows[0]] } },
      { ...valid, usage: { ...valid.usage, windows: Array.from({ length: 9 }, (_, i) => ({ id: `7d:m${i}`, usedPercent: 1, resetsAt: 1 })) } },
      { ...valid, usage: { ...valid.usage, tokens: { ...valid.usage.tokens, total: -1 } } },
      { ...valid, usage: { ...valid.usage, tokens: { ...valid.usage.tokens, model: 'x' } } },
      { ...valid, usage: { ...valid.usage, costUsd: 'free' } },
      { ...valid, at: 'now' },
    ];
    for (const body of refused) assert.equal(agentUsage.safeParse(body).success, false, JSON.stringify(body));
  });

  it('keeps the latest per agent, drops repeats from the rate, and limits changes', () => {
    let now = 1_800_000_000_000;
    const usage = new Usage(() => now);
    const reading = (used: number) => ({ source: 'claude-statusline' as const, windows: [{ id: '5h', usedPercent: used, resetsAt: now + 3_600_000 }] });
    const first = reading(1);
    assert.deepEqual(usage.record('Claude', first, now), { kept: true });
    for (let i = 0; i < 20; i++) {
      now += 300;
      assert.deepEqual(usage.record('claude', first, now), { kept: true, same: true }, 'the same numbers, read again');
    }
    assert.equal(usage.get('CLAUDE')!.at, now, 'a repeat says when they were last read');
    const results = [2, 3, 4, 5, 6, 7, 8].map((used) => usage.record('Claude', reading(used), now).kept);
    assert.deepEqual(results, [true, true, true, true, true, true, false], 'a burst, then the rate');
    assert.equal(usage.get('Claude')!.windows![0].usedPercent, 7);
    now += 3_000;
    assert.equal(usage.record('Claude', reading(8), now).kept, true);
    assert.deepEqual(usage.record('Claude', reading(9), now - 60_000), { kept: false, reason: 'stale' });
  });

  it("keeps the plan's windows through a post without them, and starts afresh from another source", () => {
    const before = mergeUsage(undefined, { source: 'claude-statusline', windows: [{ id: '5h', usedPercent: 5, resetsAt: 9 }], costUsd: 4 }, 100);
    const next = mergeUsage(before, { source: 'claude-statusline', costUsd: 0.1, context: { usedPercent: 2, window: 200000 } }, 200);
    assert.deepEqual(next, { source: 'claude-statusline', windows: [{ id: '5h', usedPercent: 5, resetsAt: 9 }], costUsd: 0.1, context: { usedPercent: 2, window: 200000 }, at: 200, windowsAt: 100 });
    assert.deepEqual(mergeUsage(next, { source: 'pi', tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 2 } }, 300), {
      source: 'pi',
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 2 },
      at: 300,
    });
  });

  it('answers a harness and the page, behind the same rules as steps', async () => {
    const dir = mkdtempSync(path.join(scratch, 'store-'));
    const store = new Store(dir);
    store.load();
    const board = store.createBoard({ title: 'Usage board' }, { kind: 'human', name: 'Sam' });
    const claudeAgent = { kind: 'agent' as const, name: 'Claude' };
    const decision = store.postDecision(board.id, { question: 'Which?' }, claudeAgent);
    store.addComment(decision.id, 'A thought', claudeAgent);
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (body: unknown, name = 'Claude', headers: Record<string, string> = {}) =>
      fetch(`${base}/api/agents/${encodeURIComponent(name)}/usage`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    try {
      const sent = await post(valid);
      assert.equal(sent.status, 200);
      assert.equal((await post({ ...valid, usage: { ...valid.usage, cwd: '/x' } })).status, 400);
      assert.equal((await post({ ...valid, padding: 'x'.repeat(4000) })).status, 413, 'a small body only');
      assert.equal((await post(valid, 'Claude', { Origin: 'https://evil.example' })).status, 403, 'not from another site');

      const now = Date.now();
      const day = now - 60_000;
      const report = (await (await fetch(`${base}/api/agents/claude/usage?board=${board.id}&day=${day}&week=${day - 1000}`)).json()) as AgentUsageReport;
      assert.equal(report.usage?.plan, 'plus');
      assert.deepEqual(report.activity?.board, { id: board.id, title: 'Usage board' });
      assert.equal(report.activity?.week.decisionsPosted, 1);
      assert.equal(report.activity?.week.comments, 1);
      assert.equal(report.activity?.today.tasksFinished, 0);
      const none = (await (await fetch(`${base}/api/agents/Nobody/usage`)).json()) as AgentUsageReport;
      assert.deepEqual(none, {});
      assert.equal((await fetch(`${base}/api/agents/Claude/usage?board=nope`)).status, 404);
    } finally {
      server.close();
      await store.flush();
    }
  });
});

// ---- what the agent did on its board -------------------------------------------------------

describe('board activity, today and this week', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 3, 9, 0) + minutes * 60_000).toISOString();
  let seq = 0;
  const event = (minutes: number, type: BoardEvent['type'], summary = '', taskId?: string): BoardEvent => ({ seq: ++seq, at: at(minutes), actor: { kind: 'agent', name: 'Claude' }, type, summary, ...(taskId && { taskId }) });

  it('counts finished tasks once, decisions, comments and replies, and joins stretches of work', () => {
    const events = [
      event(-120, 'task_updated', 'claimed T4 "Old"', 't4'), // before the day: its time counts from the start
      event(0, 'task_updated', 'claimed T5 "Usage"', 't5'),
      event(5, 'comment_added', 'commented on T5'),
      event(70, 'task_updated', 'updated T5 "Usage": sent it for review; linked x', 't5'),
      event(71, 'task_updated', 'updated T5 "Usage": sent it for review', 't5'),
      event(80, 'task_updated', 'updated T4 "Old": marked it done and asked for a commit', 't4'),
      event(85, 'decision_posted', 'posted #9'),
      event(200, 'thread_replied', 'replied'),
      event(201, 'canvas_changed', 'added a block'),
    ];
    const since = Date.parse(at(0));
    const counts = countActivity(events, since, Date.parse(at(300)));
    assert.equal(counts.tasksFinished, 2);
    assert.equal(counts.decisionsPosted, 1);
    assert.equal(counts.comments, 2);
    // 0–80 (T4's and T5's claims to their ends, and the events between), 80–85, 199–201.
    assert.equal(counts.workingMs, (85 + 1) * 60_000);
    assert.deepEqual(countActivity(events, Date.parse(at(150)), Date.parse(at(300))), { tasksFinished: 0, decisionsPosted: 0, comments: 1, workingMs: 60_000 });
  });

  it('joins overlapping spans once, within the stretch asked for', () => {
    assert.equal(joinedLength([[0, 10], [5, 20], [30, 40], [35, 36]], 0, 100), 30);
    assert.equal(joinedLength([[0, 10], [5, 20]], 8, 12), 4);
    assert.equal(joinedLength([], 0, 1), 0);
    assert.ok(GAP_MS >= 10 * 60_000);
  });
});

// ---- the panel's words -----------------------------------------------------------------------

describe("the Usage section's words (core/usage.ts)", () => {
  const now = Date.UTC(2026, 10, 3, 12, 0);
  it('counts down to a reset, and drops a window whose reset has passed', () => {
    assert.equal(timeUntil(now + (86 * 60 + 20) * 1000, now), '1h 26m');
    assert.equal(timeUntil(now + 3 * 86_400_000 + 4 * 3_600_000 + 5, now), '3d 4h');
    assert.equal(timeUntil(now + 12 * 60_000 - 1, now), '12m');
    assert.equal(timeUntil(now + 30_000, now), 'under a minute');
    assert.equal(timeUntil(now - 1, now), undefined);
    assert.equal(windowLine({ id: '5h', usedPercent: 26.4, resetsAt: now + 86 * 60_000 }, now), '26% used · resets in 1h 26m');
    assert.equal(windowLine({ id: '7d', usedPercent: 0.2, resetsAt: now + 2 * 86_400_000 }, now), '<1% used · resets in 2d');
    assert.deepEqual(liveWindows([{ id: '5h', usedPercent: 1, resetsAt: now - 1 }, { id: '7d', usedPercent: 1, resetsAt: now + 1 }], now).map((w) => w.id), ['7d']);
  });

  it('names windows by their length, or their id', () => {
    assert.equal(windowName({ id: '5h', minutes: 300 }), '5-hour');
    assert.equal(windowName({ id: '7d', minutes: 10080 }), 'Weekly');
    assert.equal(windowName({ id: '5h' }), '5-hour');
    assert.equal(windowName({ id: '7d:opus' }), 'Weekly · opus');
    assert.equal(windowName({ id: '5h', minutes: 1440 }), '1-day');
  });

  it('says "as of" only for numbers more than a few minutes old', () => {
    const gb = { locale: 'en-GB', timeZone: 'UTC' };
    assert.equal(asOf(now - STALE_MS + 1000, now, gb), undefined);
    assert.equal(asOf(now - 20 * 60_000, now, gb), 'as of 11:40');
    assert.equal(asOf(now - 26 * 3_600_000, now, gb), 'as of Mon 10:00');
    assert.match(asOf(now - 30 * 86_400_000, now, gb)!, /^as of \d{2}\/\d{2}\/\d{4}$/);
    assert.equal(asOf(now - 20 * 60_000, now, { locale: 'en-US', timeZone: 'UTC' }), 'as of 11:40 AM', "in the person's own way of telling the time");
  });

  it('tints a bar only near the limit', () => {
    assert.deepEqual([0, 79.9, 80, 94.9, 95, 120].map(usageLevel), ['ok', 'ok', 'near', 'near', 'at', 'at']);
  });

  it('puts tokens, time and the quiet lines in a few words', () => {
    assert.deepEqual([940, 9_400, 12_400, 310_000, 1_234_567, 25_000_000].map(tokenCount), ['940', '9.4k', '12k', '310k', '1.2M', '25M']);
    assert.equal(tokensLine({ input: 840_000, output: 30_000, cacheRead: 310_000, cacheWrite: 0, reasoning: 0, total: 870_000 }), '870k tokens · 840k in, 30k out, 310k from cache');
    assert.deepEqual([0, 30_000, 45 * 60_000, 130 * 60_000, 120 * 60_000].map(workingText), ['none', 'under a minute', '45m', '2h 10m', '2h']);
    assert.equal(notSharedLine('gemini', 'Gemini CLI'), 'Gemini keeps its quota to itself: see /stats in Gemini.');
    assert.equal(notSharedLine('pi', 'Pi'), 'Pi shares tokens and cost, not plan limits.');
    assert.equal(notSharedLine('claude', 'Claude Code'), undefined);
  });
});

// ---- Pi, OMP and OpenCode: tokens and cost ------------------------------------------------------

describe('tokens and cost from Pi, OMP and OpenCode', () => {
  type Sent = { url: string; body: Record<string, unknown> };
  const fake = () => {
    const sent: Sent[] = [];
    const send: Fetch = async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return { body: { cancel: async () => {} } };
    };
    return { sent, send };
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it("adds up a Pi session's replies and sends them at the end of each turn, numbers only", async () => {
    const handlers = new Map<string, ((event: unknown, ctx: StepsContext) => void)[]>();
    const api: ExtensionApi = { on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]) };
    const emit = (event: string, payload: unknown, ctx: StepsContext) => (handlers.get(event) ?? []).forEach((h) => h(payload, ctx));
    const { sent, send } = fake();
    stepsExtension({ name: 'Pi', url: TRICOT_URL }, send)(api);
    const ctx: StepsContext = { cwd: '/w', sessionManager: { getSessionId: () => 'pi-1' } };
    const reply = (input: number, output: number, cost: number) => ({
      message: { role: 'assistant', content: [{ type: 'text', text: 'SECRET' }], usage: { input, output, cacheRead: 100, cacheWrite: 10, totalTokens: input + output + 110, cost: { input: 0, output: 0, total: cost } } },
    });
    emit('message_end', { message: { role: 'user', content: 'SECRET prompt' } }, ctx);
    emit('message_end', reply(1000, 200, 0.01), ctx);
    emit('message_end', reply(3000, 400, 0.02), ctx);
    emit('agent_end', { messages: ['SECRET'] }, ctx);
    await tick();
    const usage = sent.filter((s) => s.url.endsWith('/usage'));
    assert.equal(usage.length, 1);
    assert.equal(usage[0].url, `${TRICOT_URL}/api/agents/Pi/usage`);
    assert.deepEqual(usage[0].body.usage, { source: 'pi', tokens: { input: 4000, output: 600, cacheRead: 200, cacheWrite: 20, reasoning: 0, total: 4820 }, costUsd: 0.03 });
    assert.doesNotMatch(JSON.stringify(usage), /SECRET/);
    assert.equal(agentUsage.safeParse(usage[0].body).success, true);
  });

  it("adds up an OpenCode session's replies, each at its latest numbers, and sends them when it goes idle", async () => {
    const home = mkdtempSync(path.join(scratch, 'home-'));
    opencode.install({ home, env: {} }, { url: TRICOT_URL, source: SOURCE });
    const module = (await import(pathToFileURL(path.join(home, '.config/opencode/plugins/tricot-steps.js')).href)) as { default: { server(input: unknown): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> } };
    const { sent, send } = fake();
    const real = globalThis.fetch;
    globalThis.fetch = send as unknown as typeof fetch;
    let hooks: Record<string, (...args: unknown[]) => Promise<unknown>>;
    try {
      hooks = await module.default.server({ directory: '/w' });
    } finally {
      globalThis.fetch = real;
    }
    const event = (type: string, properties: unknown) => hooks.event({ event: { type, properties } });
    const info = (id: string, input: number, output: number, cost: number) => ({ info: { id, sessionID: 'oc-1', role: 'assistant', cost, tokens: { input, output, reasoning: 5, cache: { read: 50, write: 0 } }, parts: ['SECRET'] } });
    await event('message.updated', { info: { id: 'u1', sessionID: 'oc-1', role: 'user', tokens: { input: 999 } } });
    await event('message.updated', info('m1', 100, 10, 0.001)); // still streaming
    await event('message.updated', info('m1', 1000, 100, 0.01)); // its latest
    await event('message.updated', info('m2', 2000, 200, 0.02));
    await event('session.idle', { sessionID: 'oc-1' });
    await tick();
    const usage = sent.filter((s) => s.url.endsWith('/usage'));
    assert.equal(usage.length, 1);
    assert.deepEqual(usage[0].body.usage, { source: 'opencode', tokens: { input: 3000, output: 300, cacheRead: 100, cacheWrite: 0, reasoning: 10, total: 3410 }, costUsd: 0.03 });
    assert.doesNotMatch(JSON.stringify(usage), /SECRET/);
  });
});
