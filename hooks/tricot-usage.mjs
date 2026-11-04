#!/usr/bin/env node
// Tricot usage: passes an agent's plan usage to Tricot, as numbers only, for
// the Usage section of its panel. Two harnesses use it:
//
// - Claude Code runs it as its status line (https://code.claude.com/docs/en/statusline),
//   which is where Claude Code says how much of the plan's 5-hour and weekly
//   windows is used and when each resets. Tricot's live-steps installer sets
//   it up in ~/.claude/settings.json in place of the person's own status
//   line, which it keeps in tricot-usage.json beside this file and puts back
//   when live steps are turned off (src/server/hooks/usageLine.ts).
//
//     node tricot-usage.mjs [--name Claude] [--url http://127.0.0.1:4545]
//
//   It reads the status line's JSON on stdin and keeps only these numbers:
//   rate_limits.five_hour and .seven_day (used_percentage, resets_at),
//   context_window (used_percentage, context_window_size) and
//   cost.total_cost_usd. Never the transcript's path, the folder, the
//   session's name, the model or the repository. It sends them to Tricot
//   while it runs the person's own status line with the same input, and
//   prints what that prints, as it prints it, with its exit code. With none,
//   it prints nothing: Claude Code then shows an empty status line.
//
// - Codex's steps hook (tricot-steps.mjs --usage) imports it at each turn's
//   end, to read Codex's plan usage from the last 256 KB of Codex's own
//   session file (the hook's transcript_path), where Codex notes it in each
//   token_count event: only primary and secondary (used_percent,
//   window_minutes, resets_at or resets_in_seconds), plan_type and the token
//   totals. Nothing else of that file is kept, sent or written anywhere. A
//   compressed file (.zst) or one it can't read is skipped.
//
// It never reads a login and never asks a usage API. Sending gives up after
// a moment and every error is swallowed: Claude Code's status line and
// Codex's turn go on as they would without it. TRICOT_TOKEN, when set, is
// sent as the bearer token a board listening beyond this machine needs. No
// dependencies: Node 18 or newer.

import { spawn } from 'node:child_process';
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_FILE = 'tricot-usage.json';
export const TAIL_BYTES = 256 * 1024;
const SEND_TIMEOUT_MS = 400; // Claude Code waits for a status line to finish before showing it
const MAX_INPUT = 1024 * 1024;
const DEFAULT_URL = 'http://127.0.0.1:4545';

const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const count = (value) => {
  const n = number(value);
  return n !== undefined && n >= 0 ? Math.round(n) : undefined;
};
const percent = (value) => {
  const n = number(value);
  return n !== undefined && n >= 0 ? Math.min(n, 1000) : undefined;
};
const PLAN = /^[A-Za-z0-9 _.-]{1,32}$/;

// ---- Claude Code's status line ----------------------------------------------------------

const CLAUDE_WINDOWS = [
  ['five_hour', '5h', 300],
  ['seven_day', '7d', 7 * 24 * 60],
];

// The numbers Tricot keeps from Claude Code's status line input, and nothing
// else; undefined when it has none worth sending (a session before its first reply).
export function fromStatusLine(input) {
  const data = record(input);
  const limits = record(data.rate_limits);
  const windows = [];
  for (const [field, id, minutes] of CLAUDE_WINDOWS) {
    const window = record(limits[field]);
    const usedPercent = percent(window.used_percentage);
    const resets = number(window.resets_at); // seconds since the epoch
    if (usedPercent !== undefined && resets !== undefined && resets > 0) windows.push({ id, usedPercent, resetsAt: Math.round(resets * 1000), minutes });
  }
  const cost = number(record(data.cost).total_cost_usd);
  const contextWindow = record(data.context_window);
  const used = percent(contextWindow.used_percentage);
  const size = count(contextWindow.context_window_size);
  const usage = {
    source: 'claude-statusline',
    ...(windows.length > 0 && { windows }),
    ...(cost !== undefined && cost > 0 && { costUsd: cost }),
    ...(used !== undefined && size && { context: { usedPercent: used, window: size } }),
  };
  return usage.windows || usage.costUsd !== undefined || usage.context ? usage : undefined;
}

// ---- Codex's session file -----------------------------------------------------------------

// The end of Codex's session file: its last TAIL_BYTES, as text, and whether
// it begins mid-line. Only a plain .jsonl file named as Codex names its
// sessions (rollout-….jsonl) is read; a compressed one, anything else, or one
// that can't be read gives undefined.
export function readTail(file, bytes = TAIL_BYTES) {
  if (typeof file !== 'string' || !/^rollout.*\.jsonl$/.test(path.basename(file))) return undefined;
  let fd;
  try {
    if (!statSync(file).isFile()) return undefined; // never a pipe or a device, which could block
    fd = openSync(file, 'r');
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    return { text: buffer.subarray(0, read).toString('utf8'), cut: start > 0 };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const TOKEN_FIELDS = [
  ['input', 'input_tokens'],
  ['output', 'output_tokens'],
  ['cacheRead', 'cached_input_tokens'],
  ['cacheWrite', 'cache_write_input_tokens'],
  ['reasoning', 'reasoning_output_tokens'],
  ['total', 'total_tokens'],
];

function tokensOf(info) {
  const usage = record(record(info).total_token_usage);
  if (count(usage.total_tokens) === undefined) return undefined;
  return Object.fromEntries(TOKEN_FIELDS.map(([ours, theirs]) => [ours, count(usage[theirs]) ?? 0]));
}

// A Codex window: how much is used, and when it resets, as ms since the
// epoch (resets_at is in seconds; Codex 0.41 said resets_in_seconds, from
// when the event was written).
function windowOf(value, id, eventAt) {
  const window = record(value);
  const usedPercent = percent(window.used_percent);
  if (usedPercent === undefined) return undefined;
  const at = number(window.resets_at);
  const inSeconds = number(window.resets_in_seconds);
  const resetsAt = at !== undefined ? at * 1000 : inSeconds !== undefined ? eventAt + inSeconds * 1000 : undefined;
  if (resetsAt === undefined || resetsAt <= 0) return undefined;
  const minutes = count(window.window_minutes);
  return { id, usedPercent, resetsAt: Math.round(resetsAt), ...(minutes && { minutes }) };
}

// A limit that is the plan's own, not a model's alias of it.
const isPlanLimit = (limits) => limits.limit_id === undefined || limits.limit_id === null || limits.limit_id === 'codex';

// The plan usage in the end of a Codex session file (readTail): from its
// latest token_count events, the plan's windows, the plan and the session's
// token totals; undefined when there is none.
export function fromRollout(tail, now = Date.now()) {
  if (!tail || typeof tail.text !== 'string') return undefined;
  const lines = tail.text.split('\n');
  if (tail.cut) lines.shift(); // begins mid-line
  let tokens;
  let limits;
  let limitsAt = now;
  let fallback;
  for (let i = lines.length - 1; i >= 0 && !(tokens && limits); i--) {
    const line = lines[i];
    if (!line.includes('"token_count"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record(record(parsed).payload);
    if (parsed.type !== 'event_msg' || payload.type !== 'token_count') continue;
    tokens ??= tokensOf(payload.info);
    const snapshot = record(payload.rate_limits);
    if (limits || (!snapshot.primary && !snapshot.secondary)) continue;
    const written = Date.parse(typeof parsed.timestamp === 'string' ? parsed.timestamp : '');
    const at = Number.isFinite(written) ? written : now;
    if (isPlanLimit(snapshot)) [limits, limitsAt] = [snapshot, at];
    else fallback ??= [snapshot, at];
  }
  if (!limits && fallback) [limits, limitsAt] = fallback;
  const windows = limits ? [windowOf(limits.primary, '5h', limitsAt), windowOf(limits.secondary, '7d', limitsAt)].filter(Boolean) : [];
  const plan = limits && typeof limits.plan_type === 'string' && PLAN.test(limits.plan_type) ? limits.plan_type : undefined;
  if (!windows.length && !tokens) return undefined;
  return { source: 'codex-rollout', ...(plan && { plan }), ...(windows.length > 0 && { windows }), ...(tokens && { tokens }) };
}

// ---- sending -------------------------------------------------------------------------------

// Posts the numbers to Tricot; the answer isn't read, and nothing it does fails.
export async function postUsage(url, name, usage, { timeout = SEND_TIMEOUT_MS, send = globalThis.fetch, token = process.env.TRICOT_TOKEN } = {}) {
  if (!usage || typeof send !== 'function') return;
  try {
    const res = await send(`${String(url || DEFAULT_URL).replace(/\/+$/, '')}/api/agents/${encodeURIComponent(name || 'Claude')}/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: JSON.stringify({ usage, at: Date.now() }),
      signal: AbortSignal.timeout(timeout),
    });
    await res?.body?.cancel?.();
  } catch {
    // Tricot isn't running, or is slow: the numbers come again next time.
  }
}

// ---- the status line ---------------------------------------------------------------------------

// The person's own status line, as Tricot kept it when it put this one in its
// place: the settings' statusLine value, if they had one.
export function previousLine(file = new URL(`./${CONFIG_FILE}`, import.meta.url)) {
  try {
    const config = record(JSON.parse(readFileSync(file, 'utf8')));
    return config.had === true ? config.previous : undefined;
  } catch {
    return undefined;
  }
}

let running; // the person's status line, while it runs

// Runs the person's status line command, as Claude Code would (in a shell,
// with the same input and environment), its output going straight to Claude
// Code as it prints it. Resolves with its exit code.
export function runPrevious(command, input, { stdout = 'inherit', env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, { shell: true, stdio: ['pipe', stdout, 'inherit'], env });
    } catch {
      resolve(1);
      return;
    }
    running = child;
    child.on('error', () => resolve(1));
    child.on('close', (code, signal) => {
      running = undefined;
      resolve(code ?? (signal ? 1 : 0));
    });
    child.stdin.on('error', () => {}); // a command that doesn't read its input
    child.stdin.end(input);
  });
}

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function statusLine() {
  // Claude Code cancels a status line when a newer update comes: the person's goes with it.
  process.once('SIGTERM', () => {
    running?.kill('SIGTERM');
    process.exit(143);
  });
  const input = await readInput();
  let usage;
  try {
    usage = fromStatusLine(JSON.parse(input));
  } catch {
    usage = undefined;
  }
  // Sent while the person's status line runs; the send gives up within SEND_TIMEOUT_MS.
  const sent = postUsage(option('url', DEFAULT_URL), option('name', 'Claude'), usage);
  const previous = record(previousLine());
  const code = typeof previous.command === 'string' && previous.command.trim() ? await runPrevious(previous.command, input) : 0;
  await sent;
  return code;
}

// Run as the status line, not when imported (tricot-steps.mjs, tests). It
// writes nothing itself (the person's status line writes straight to Claude
// Code), so exiting at once loses nothing, and no idle connection holds it up.
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  statusLine().then(
    (code) => process.exit(code),
    () => process.exit(0),
  );
}
