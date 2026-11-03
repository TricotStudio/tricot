#!/usr/bin/env node
// Tricot steps: shows what this agent is doing, one short line per step, on
// the Tricot card it is working on ("Reading src/web/Home.tsx", "Running npm
// test"). Claude Code, Codex and Gemini CLI run it on each hook event it is
// set up for, with the event as JSON on stdin
// (https://code.claude.com/docs/en/hooks, https://learn.chatgpt.com/docs/hooks,
// https://geminicli.com/docs/hooks/reference/); Tricot's hook installers
// (src/server/hooks/) set it up beside tricot-describe.mjs, which turns the
// event into the step, and take it away again.
//
//   node tricot-steps.mjs [--name Claude] [--url http://127.0.0.1:4545] [--narration] [--dry-run]
//
// It sends a description of the step, never what the agent read or wrote: no
// file contents, no command output, no prompt text, no query strings. A
// command is cut to its first words, so arguments that might hold a secret
// stay behind. A command or subagent that can take a while is sent as running
// when it starts (PreToolUse) and again when it ends (PostToolUse, or
// PostToolUseFailure), with how long it took, so its line stays live while it
// runs. With --narration (off unless asked for) it also sends the first line
// of each message Claude writes in the terminal (MessageDisplay): only what
// the terminal shows, never Claude's thinking. It fails silently and fast
// when Tricot isn't running, and it never holds the agent up: it exits
// within 1.5 seconds whatever happens, and is meant to run with "async":
// true, so the agent doesn't wait at all. Gemini CLI has no async hooks and
// waits for it, usually a few hundredths of a second; it reads anything the
// hook prints as its answer, so this prints nothing, on stdout or stderr.
// TRICOT_TOKEN, when set, is sent as the bearer token a board listening
// beyond this machine needs. No dependencies: Node 18 or newer.

import { describe } from './tricot-describe.mjs';

const HARD_LIMIT_MS = 1500;
const SEND_TIMEOUT_MS = 1000;
const MAX_INPUT = 8 * 1024 * 1024; // a Write's content can be large; past this the step is skipped

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const raw = await readInput();
  if (!raw) return;
  const step = describe(JSON.parse(raw), { narration: process.argv.includes('--narration') });
  if (!step) return;
  const body = { ...step, at: Date.now() };
  if (process.argv.includes('--dry-run')) {
    process.stdout.write(`${JSON.stringify(body)}\n`);
    return;
  }
  const url = option('url', 'http://127.0.0.1:4545').replace(/\/+$/, '');
  const name = option('name', 'Claude');
  const token = process.env.TRICOT_TOKEN;
  await fetch(`${url}/api/agents/${encodeURIComponent(name)}/steps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
}

// Whatever happens, it is gone within HARD_LIMIT_MS, and says nothing: a
// hook's failure is never the agent's problem.
setTimeout(() => process.exit(0), HARD_LIMIT_MS).unref();
main()
  .catch(() => {})
  .finally(() => process.exit(0));
