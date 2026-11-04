#!/usr/bin/env node
// Tricot approvals: brings an agent's permission prompt ("may I run this?")
// to the Tricot board, where a person answers it, instead of the terminal.
// Claude Code and Codex run it on their PermissionRequest event, with the
// request as JSON on stdin, and wait for it
// (https://code.claude.com/docs/en/hooks#permissionrequest,
// https://learn.chatgpt.com/docs/hooks). It sends Tricot the request (the
// tool and its input, as the agent sent them), waits for the person's
// answer, and prints it as the agent's own decision. Tricot's hook installers
// (src/server/hooks/) set it up beside tricot-steps.mjs, and take it away again.
//
//   node tricot-approve.mjs [--name Claude] [--url http://127.0.0.1:4545] [--data ~/.tricot] [--codex]
//
// It never decides on its own. When Tricot isn't running (no lock, or nothing
// listens: it tries once more after a moment, so the terminal asks within a
// second), when Tricot goes away for a minute while it waits, when the
// request is too large to show, when Tricot refuses it, when what answers
// isn't the Tricot that holds the data folder (below, "is it Tricot?"), or
// when anything goes wrong, it prints nothing and exits 0: the agent then
// asks in the terminal as it always did. While it waits, a Tricot that
// restarts has forgotten the request; it asks again, for as long as Tricot
// may take to come back.
//
// When the agent stops waiting for it (its hook timeout, or a person answered
// in the terminal first, which ends this process), it tells Tricot, so the
// request leaves the board. An answer reaches only this process: Tricot
// gives it a key of its own to wait with.
//
// "Allow for this session" (Claude Code only; Codex has nothing like it
// yet) allows the request, and adds what Claude Code itself suggested for
// it, made to last this session only: never saved in a settings file. A
// suggestion to change the permission mode is taken only for "accept edits".
// It is offered only when the card can show every item it adds, in full;
// otherwise the card offers Allow once and Deny, and nothing more is added.
//
// TRICOT_TOKEN, when set, is sent as the bearer token a board listening
// beyond this machine needs. No dependencies: Node 18 or newer.

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CODEX = process.argv.includes('--codex');
const FIRST_RETRY_MS = 300; // at first, one more try after this, then the terminal asks
const FIRST_SEND_MS = 1_500; // and each try's own limit, for a Tricot that hangs
const AWAY_MS = 60_000; // how long Tricot may be gone while it waits (a restart)
const RETRY_MS = 500;
const WAIT_TIMEOUT_MS = 40_000; // a wait is answered within 25 s (server/approvals.ts WAIT_MS)
const SEND_TIMEOUT_MS = 3_000;
const MAX_STDIN = 1024 * 1024;
const MAX_REQUEST = 256 * 1024; // past this, a request is too large to show on the board
const MAX_MESSAGE = 2_000;
const CHECK_MS = 5_000; // the check that it is Tricot (lsof, the instance id): slow only on a busy computer
// What a card shows of "for this session": this many items, each in full up to
// this length (core/approvals.ts APPROVAL_SESSION_ITEMS and APPROVAL_SESSION_ITEM).
const SESSION_ITEMS = 20;
const SESSION_ITEM = 500;

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const URL_ = option('url', 'http://127.0.0.1:4545').replace(/\/+$/, '');
const NAME = option('name', CODEX ? 'Codex' : 'Claude');
const TOKEN = process.env.TRICOT_TOKEN;
// Where Tricot keeps its lock, as the tricot command finds it.
const DATA_DIR = path.resolve(option('data', undefined) || process.env.TRICOT_DATA_DIR || path.join(os.homedir(), '.tricot'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => (typeof value === 'string' && value.trim() !== '' ? value.slice(0, max) : undefined);

// ---- "for this session" (Claude Code) -------------------------------------------
// Claude Code suggests permission updates with each request
// (permission_suggestions): an allow rule, a mode, a folder. Echoed back,
// each made to last the session only, they are what "Allow for this
// session" allows. Anything else is left out.

function sessionPermissions(suggestions) {
  if (CODEX || !Array.isArray(suggestions)) return [];
  const kept = [];
  for (const s of suggestions) {
    if (!isObject(s)) continue;
    if (s.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules)) {
      const rules = s.rules
        .filter((r) => isObject(r) && typeof r.toolName === 'string' && (r.ruleContent === undefined || typeof r.ruleContent === 'string'))
        .map((r) => ({ toolName: r.toolName, ...(r.ruleContent !== undefined && { ruleContent: r.ruleContent }) }));
      if (rules.length) kept.push({ type: 'addRules', rules, behavior: 'allow', destination: 'session' });
    } else if (s.type === 'setMode' && s.mode === 'acceptEdits') {
      kept.push({ type: 'setMode', mode: 'acceptEdits', destination: 'session' });
    } else if (s.type === 'addDirectories' && Array.isArray(s.directories) && s.directories.every((d) => typeof d === 'string') && s.directories.length) {
      kept.push({ type: 'addDirectories', directories: s.directories, destination: 'session' });
    }
  }
  return kept;
}

// The same, in words for the board, one for each rule, mode and folder it
// adds: "Bash(npm run build:*)", "every file edit (accept edits)".
function sessionWords(permissions) {
  return permissions.flatMap((p) => {
    if (p.type === 'addRules') return p.rules.map((r) => (r.ruleContent === undefined ? r.toolName : `${r.toolName}(${r.ruleContent})`));
    if (p.type === 'setMode') return ['every file edit (accept edits)'];
    return p.directories.map((d) => `files in ${d}`);
  });
}

// What "Allow for this session" offers: `permissions` to add, and `words`, the
// card's items for them, one for one. Only when the card shows every item in
// full; else nothing at all, rather than more than the person saw.
function sessionOffer(suggestions) {
  const permissions = sessionPermissions(suggestions);
  const words = sessionWords(permissions);
  const shown = words.length > 0 && words.length <= SESSION_ITEMS && words.every((w) => w.length >= 1 && w.length <= SESSION_ITEM);
  return shown ? { permissions, words } : { permissions: [], words: [] };
}

// ---- the request, and the answer as the agent's decision ------------------------

function requestOf(event, words) {
  const input = event.tool_input === undefined ? {} : event.tool_input;
  return {
    harness: CODEX ? 'codex' : 'claude',
    tool: event.tool_name.slice(0, 200),
    input,
    ...(isObject(input) && text(input.description, 1_000) && { description: text(input.description, 1_000) }),
    ...(text(event.session_id, 120) && { session: text(event.session_id, 120) }),
    ...(text(event.agent_id, 120) && { worker: text(event.agent_id, 120) }),
    ...(text(event.agent_type, 60) && { role: text(event.agent_type, 60).trim() }),
    ...(text(event.cwd, 2_000) && { cwd: text(event.cwd, 2_000) }),
    ...(words.length && { forSession: words }),
    at: Date.now(),
  };
}

function decisionOf(answer, permissions) {
  if (!isObject(answer) || (answer.behavior !== 'allow' && answer.behavior !== 'deny')) return undefined;
  const decision =
    answer.behavior === 'allow'
      ? { behavior: 'allow', ...(answer.session === true && permissions.length && { updatedPermissions: permissions }) }
      : { behavior: 'deny', ...(typeof answer.message === 'string' && answer.message && { message: answer.message.slice(0, MAX_MESSAGE) }) };
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

// ---- is it Tricot? -----------------------------------------------------------------
// The hook believes only the Tricot that holds the data folder's lock
// (<data dir>/server.lock, src/server/lock.ts): the lock is for the address
// the hook sends to, its process is alive, that process alone listens on
// the port (lsof; Linux's /proc where lsof isn't installed), and the server
// says the instance id the lock holds, which is new on each start
// (GET /api/instance). The data folder is --data, else $TRICOT_DATA_DIR,
// else ~/.tricot, as the tricot command finds it.
//
// With no such lock, nothing is sent and the terminal asks. The rest of the
// check runs alongside the request, so the request reaches the board as
// fast as before, and one whose server fails the check is taken back. An
// answer is believed only once the check passes again, for the same run of
// Tricot the request was given to; so is a server that answers again after
// Tricot was away. A Tricot that restarted is asked again the same way.
//
// What this stops: a program that listens on Tricot's port while Tricot is
// down or restarting (the hook keeps trying for up to a minute then), takes
// the request, and answers "allow, for this session" to it and to every one
// after. What it doesn't stop: an agent that also rewrites Tricot's lock
// file (or this hook, or the agent's settings), which it can, as it runs as
// the same user (T188 frames the rest: an agent in a sandbox that can't
// reach Tricot's files or port). And where the server can't be placed at
// all (a board on another machine through --url, a data folder the hook
// isn't told of, a system with neither lsof nor /proc), the terminal asks:
// a token sent to whatever listens says nothing about who listens.

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
const EVERY_ADDRESS = ['0.0.0.0', '::'];
const LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof']; // the system's own, never one found first on PATH

const target = (() => {
  try {
    const url = new URL(URL_);
    return { host: url.hostname.replace(/^\[(.*)\]$/, '$1'), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
  } catch {
    return undefined;
  }
})();

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// The data folder's lock, when it names the address the hook sends to and
// its process is alive: one small file read, no more.
function lockHere() {
  let lock;
  try {
    lock = JSON.parse(readFileSync(path.join(DATA_DIR, 'server.lock'), 'utf8'));
  } catch {
    return undefined;
  }
  if (!target || !isObject(lock) || !Number.isInteger(lock.pid) || lock.pid <= 0 || lock.port !== target.port || !text(lock.instance, 200)) return undefined;
  const host = typeof lock.host === 'string' ? lock.host : '';
  const sameHost = host === target.host || (LOOPBACK.includes(target.host) && (LOOPBACK.includes(host) || EVERY_ADDRESS.includes(host)));
  return sameHost && alive(lock.pid) ? lock : undefined;
}

// Whether `pid`, and no other process, listens on `port`. Where neither
// lsof nor /proc can tell (Windows), it can't be placed: no.
function listensAlone(port, pid) {
  const lsof = LSOF.find((file) => existsSync(file));
  if (!lsof) return Promise.resolve(process.platform === 'linux' && procListensAlone(port, pid));
  return new Promise((resolve) => {
    execFile(lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: CHECK_MS }, (error, stdout) => {
      // It exits 1 when nothing listens, or when it couldn't read some other process's files.
      const ran = !error || (typeof error.code === 'number' && !error.killed);
      const pids = ran ? String(stdout).split('\n').map((line) => line.trim()).filter(Boolean) : [];
      resolve(pids.length > 0 && pids.every((p) => p === String(pid)));
    });
  });
}

// Linux without lsof: every socket listening on the port (/proc/net/tcp and
// tcp6, state 0A) is one of the process's open files (/proc/<pid>/fd).
function procListensAlone(port, pid) {
  const sockets = new Set();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let rows = [];
    try {
      rows = readFileSync(table, 'utf8').split('\n').slice(1);
    } catch {
      continue;
    }
    for (const row of rows) {
      const [, local, , state, , , , , , inode] = row.trim().split(/\s+/);
      if (state === '0A' && inode && parseInt(local?.split(':')[1] ?? '', 16) === port) sockets.add(`socket:[${inode}]`);
    }
  }
  if (sockets.size === 0) return false;
  const owned = new Set();
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const link = readlinkSync(`/proc/${pid}/fd/${fd}`);
        if (sockets.has(link)) owned.add(link);
      } catch {
        // closed meanwhile
      }
    }
  } catch {
    return false;
  }
  return owned.size === sockets.size;
}

// What the server at the address says it is: { pid, instance }.
async function instanceThere() {
  try {
    const res = await fetch(`${URL_}/api/instance`, { headers: { ...(TOKEN && { Authorization: `Bearer ${TOKEN}` }) }, signal: AbortSignal.timeout(CHECK_MS) });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

// Whether what answers at the address is the Tricot that `lock` names.
async function isTricot(lock) {
  const [alone, said] = await Promise.all([listensAlone(lock.port, lock.pid), instanceThere()]);
  return alone && isObject(said) && said.pid === lock.pid && said.instance === lock.instance;
}

// Whether it is still the run of Tricot that `asked` was given to.
async function stillTricot(asked) {
  const lock = lockHere();
  return lock !== undefined && lock.instance === asked.instance && (await isTricot(lock));
}

// ---- talking to Tricot ------------------------------------------------------------

let ticket; // { id, key, instance }: this process's request, and the run of Tricot it was given to

function post(route, body, ms) {
  return fetch(`${URL_}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(TOKEN && { Authorization: `Bearer ${TOKEN}` }) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
}

const withdraw = (asked) => post(`/api/approvals/${encodeURIComponent(asked.id)}/withdraw`, { key: asked.key }, 800).catch(() => {});

// Asks Tricot. Undefined when it can't be reached, refuses the request, or
// isn't the Tricot that holds the lock. At first (no `patience`) a Tricot
// that can't be reached is tried once more, a moment later, and then left:
// it is closed, and the terminal asks without making the person wait. A
// Tricot that went away while the hook waited (a restart) is tried again for
// up to `patience`.
async function ask(request, patience) {
  const until = Date.now() + (patience ?? 0);
  for (let tries = 1; ; tries++) {
    const lock = lockHere();
    if (lock) {
      const checked = isTricot(lock); // alongside the request, which isn't held up for it
      let asked;
      try {
        const res = await post(`/api/agents/${encodeURIComponent(NAME)}/approvals`, request, patience === undefined ? FIRST_SEND_MS : SEND_TIMEOUT_MS);
        if (!res.ok) return undefined;
        const body = await res.json();
        if (typeof body?.id !== 'string' || typeof body?.key !== 'string') return undefined;
        asked = { id: body.id, key: body.key, instance: lock.instance };
      } catch {
        asked = undefined;
      }
      if (asked) {
        ticket = asked; // should the agent stop waiting meanwhile, stopped() takes it back
        if (await checked) return asked;
        ticket = undefined;
        await withdraw(asked); // not the Tricot the lock names: the request is taken back, and the terminal asks
        return undefined;
      }
    }
    if (patience === undefined ? tries >= 2 : Date.now() + RETRY_MS > until) return undefined;
    await sleep(patience === undefined ? FIRST_RETRY_MS : RETRY_MS);
  }
}

// Waits for the person's answer: undefined when there won't be one here.
async function answerFor(request) {
  ticket = await ask(request);
  let lostSince;
  while (ticket) {
    let res;
    try {
      res = await post(`/api/approvals/${encodeURIComponent(ticket.id)}/wait`, { key: ticket.key }, WAIT_TIMEOUT_MS);
    } catch {
      res = undefined;
    }
    if (res?.status === 404) {
      // Tricot restarted and forgot it: ask again, for as long as it may be away.
      ticket = await ask(request, lostSince === undefined ? AWAY_MS : Math.max(0, AWAY_MS - (Date.now() - lostSince)));
      lostSince = undefined;
      continue;
    }
    if (res?.ok) {
      const body = await res.json().catch(() => undefined);
      const answered = body?.state === 'answered';
      // An answer, or a server back after Tricot was away: only from the run of Tricot asked.
      if ((answered || lostSince !== undefined) && !(await stillTricot(ticket))) return undefined;
      if (answered) return body.answer;
      lostSince = undefined;
      continue; // still waiting
    }
    if (res) return undefined; // refused: the terminal asks
    lostSince ??= Date.now();
    if (Date.now() - lostSince > AWAY_MS) return undefined;
    await sleep(1_000);
  }
  return undefined;
}

async function main() {
  const raw = await readInput();
  if (!raw) return;
  const event = JSON.parse(raw);
  if (!isObject(event) || event.hook_event_name !== 'PermissionRequest' || typeof event.tool_name !== 'string' || !event.tool_name) return;
  const offer = sessionOffer(event.permission_suggestions);
  const request = requestOf(event, offer.words);
  if (JSON.stringify(request).length > MAX_REQUEST) return; // too large to show: the terminal shows it
  const answer = await answerFor(request);
  ticket = undefined;
  // "For this session" adds exactly what the card listed: offer.words are those items.
  const decision = answer && decisionOf(answer, offer.permissions);
  if (!decision) return;
  await new Promise((resolve) => process.stdout.write(JSON.stringify(decision), resolve));
}

// The agent stopped waiting (a person answered in the terminal, or its
// timeout): the request leaves the board, and nothing is said.
async function stopped() {
  const was = ticket;
  ticket = undefined;
  if (was) await withdraw(was);
  process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => void stopped());

main()
  .catch(() => {})
  .finally(() => process.exit(0));
