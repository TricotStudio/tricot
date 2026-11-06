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
// can't prove it is the Tricot that holds the data folder (below, "is it
// Tricot?"), or
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

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
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
// Where Tricot keeps its lock, as the tricot command finds it. The default is
// the one src/platform/paths.ts gives (test/platformPaths.test.ts holds them together).
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
// (<data dir>/server.lock, src/platform/lock.ts). Each start of Tricot writes
// a random secret in it, private to the person's account. With everything it
// asks, the hook sends a fresh random challenge (X-Tricot-Challenge), and the
// board answers with a proof (X-Tricot-Proof): the HMAC-SHA256, keyed by that
// secret, of the challenge and what the answer is about (src/server/proof.ts
// says each; test/approvals.test.ts runs it against this). The hook checks
// it, in constant time, with the secret it read from the lock. The data
// folder is --data, else $TRICOT_DATA_DIR, else ~/.tricot, as the tricot
// command finds it.
//
//   1. It reads the lock, which must name the address the hook sends to,
//      a process that is alive, and a secret; and be private to this account
//      (below). Otherwise nothing is sent and the terminal asks.
//   2. It asks GET /api/instance with a challenge, and goes on only with
//      the right proof: before that, nothing the agent wants to run is sent.
//   3. It sends the request with another challenge. The proof binds the id
//      Tricot gave it to the SHA-256 of the body Tricot read and the agent's
//      name it read from the path, which must be the ones the hook sent: a
//      program in between can't change what the person is shown, or whose
//      it is. A request whose proof is wrong is taken back.
//   4. Each wait carries a challenge of its own, and the proof binds the id
//      and all the hook acts on in the answer: that it is one, whether it
//      allows or denies, for the session, and the message. Only a proven
//      answer is printed.
//
// Every challenge is used once, so an answer taken from an earlier exchange
// is for another challenge and fails. A Tricot that restarts has a new
// secret, which the hook reads again when it asks again.
//
// What this stops: a program that listens on Tricot's port while Tricot is
// down or restarting (the hook keeps trying for up to a minute then), takes
// the request, and answers "allow, for this session" to it and to every one
// after: it has no secret, so no proof. It needs nothing of the system (no
// lsof, no /proc), so it works the same everywhere. What it doesn't stop: an
// agent that also reads Tricot's lock file (or rewrites it, this hook, or
// the agent's settings), which it can, as it runs as the same user (T188
// frames the rest: an agent in a sandbox that can't reach Tricot's files or
// port). And where the hook has no lock to read (a board on another machine
// through --url, a data folder the hook isn't told of), the terminal asks:
// a token sent to whatever listens says nothing about who listens. A Tricot
// from before T220 writes no secret: the terminal asks.

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
const EVERY_ADDRESS = ['0.0.0.0', '::'];
const CHALLENGE_HEADER = 'X-Tricot-Challenge';
const PROOF_HEADER = 'X-Tricot-Proof';
const MIN_SECRET = 32;

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

// The secret is only as private as the file that holds it: on a system with
// file modes, the lock must be this account's own and closed to others (600),
// in a folder no one else can write in. Where there are none (Windows), the
// account's own folders are what keeps it. `info` is the lock's own, from the
// descriptor it is read through (readLock), so it is the file read that is checked.
function privateToMe(info, file) {
  if (process.platform === 'win32') return true;
  try {
    const mine = process.getuid?.();
    const folder = statSync(path.dirname(file));
    return info.uid === mine && (info.mode & 0o077) === 0 && folder.uid === mine && (folder.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

// The lock, parsed: opened once, and what is read is the file checked, a
// regular file that may be relied on (privateToMe), not another one put in
// its place between a check by path and a read by path.
function readLock(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const info = fstatSync(fd);
    return info.isFile() && privateToMe(info, file) ? JSON.parse(readFileSync(fd, 'utf8')) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The data folder's secret, when its lock names the address the hook sends
// to, a process that is alive, and may be relied on: one small file read.
function secretHere() {
  const file = path.join(DATA_DIR, 'server.lock');
  const lock = readLock(file);
  if (!target || !isObject(lock) || !Number.isInteger(lock.pid) || lock.pid <= 0 || lock.port !== target.port) return undefined;
  if (typeof lock.secret !== 'string' || lock.secret.length < MIN_SECRET) return undefined;
  const host = typeof lock.host === 'string' ? lock.host : '';
  const sameHost = host === target.host || (LOOPBACK.includes(target.host) && (LOOPBACK.includes(host) || EVERY_ADDRESS.includes(host)));
  return sameHost && alive(lock.pid) ? lock.secret : undefined;
}

// What is proved (src/server/proof.ts): the same function.
const challenge = () => randomBytes(32).toString('base64url');
const macOf = (secret, purpose, asked, parts) => createHmac('sha256', secret).update(JSON.stringify(['tricot-approval/1', purpose, asked, ...parts])).digest();

// Whether the response carries the proof of `purpose` for `asked` (the
// challenge sent) and `parts`, made with `secret`. Compared in constant time.
function proves(res, secret, purpose, asked, parts) {
  const given = Buffer.from(res.headers.get(PROOF_HEADER) ?? '', 'base64url');
  const expected = macOf(secret, purpose, asked, parts);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// All the hook acts on in an answer (src/server/proof.ts answerParts).
const answerParts = (state, answer) =>
  state === 'answered' && isObject(answer) ? [state, String(answer.behavior), answer.session === true, typeof answer.message === 'string' ? answer.message : ''] : [state];

// ---- talking to Tricot ------------------------------------------------------------

let ticket; // { id, key, secret }: this process's request, and the secret of the run of Tricot it was given to

const bearer = () => (TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {});

function post(route, body, ms, asked) {
  return fetch(`${URL_}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(), ...(asked && { [CHALLENGE_HEADER]: asked }) },
    body,
    signal: AbortSignal.timeout(ms),
  });
}

const withdraw = (asked) => post(`/api/approvals/${encodeURIComponent(asked.id)}/withdraw`, JSON.stringify({ key: asked.key }), 800).catch(() => {});

// Whether what listens at the address proves it is the Tricot that holds
// `secret`: 'yes', 'no' (something answers, and can't), or 'closed' (nothing
// answers: Tricot may be coming up).
async function proveTricot(secret, ms) {
  const asked = challenge();
  try {
    const res = await fetch(`${URL_}/api/instance`, { headers: { ...bearer(), [CHALLENGE_HEADER]: asked }, signal: AbortSignal.timeout(ms) });
    await res.arrayBuffer();
    return res.ok && proves(res, secret, 'instance', asked, []) ? 'yes' : 'no';
  } catch {
    return 'closed';
  }
}

// Sends the request. The ticket for it when Tricot proves it read exactly
// this one; otherwise 'closed' (can't be reached), 'refused' (Tricot said
// no), or 'no' (not Tricot's proof: the request is taken back).
async function send(request, secret, ms) {
  const body = JSON.stringify(request);
  const asked = challenge();
  let res;
  let said;
  try {
    res = await post(`/api/agents/${encodeURIComponent(NAME)}/approvals`, body, ms, asked);
    said = res.ok ? await res.json() : undefined;
  } catch {
    return 'closed';
  }
  if (!said) return 'refused';
  if (typeof said.id !== 'string' || typeof said.key !== 'string') return 'no';
  const given = { id: said.id, key: said.key, secret };
  if (proves(res, secret, 'ask', asked, [said.id, createHash('sha256').update(body).digest('hex'), NAME.trim()])) return given;
  await withdraw(given); // not the Tricot the lock names: the request is taken back, and the terminal asks
  return 'no';
}

// Asks Tricot. Undefined when it can't be reached, refuses the request, or
// can't prove it is the Tricot that holds the lock. At first (no `patience`)
// a Tricot that can't be reached is tried once more, a moment later, and then
// left: it is closed, and the terminal asks without making the person wait.
// A Tricot that went away while the hook waited (a restart) is tried again
// for up to `patience`.
async function ask(request, patience) {
  const until = Date.now() + (patience ?? 0);
  for (let tries = 1; ; tries++) {
    const secret = secretHere();
    if (secret) {
      const ms = patience === undefined ? FIRST_SEND_MS : SEND_TIMEOUT_MS;
      const proved = await proveTricot(secret, ms); // before anything is sent
      if (proved === 'no') return undefined;
      if (proved === 'yes') {
        const sent = await send(request, secret, ms);
        if (typeof sent === 'object') return sent;
        if (sent !== 'closed') return undefined;
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
    const asked = challenge();
    let res;
    try {
      res = await post(`/api/approvals/${encodeURIComponent(ticket.id)}/wait`, JSON.stringify({ key: ticket.key }), WAIT_TIMEOUT_MS, asked);
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
      const state = body?.state;
      // Whatever it says, an answer or that it still waits, only as the run of Tricot asked proves it.
      if ((state !== 'answered' && state !== 'pending') || !proves(res, ticket.secret, 'wait', asked, [ticket.id, ...answerParts(state, body.answer)])) return undefined;
      if (state === 'answered') return body.answer;
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
