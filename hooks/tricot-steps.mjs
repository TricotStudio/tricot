#!/usr/bin/env node
// Tricot steps: shows what this agent is doing, one short line per step, on
// the Tricot card it is working on ("Reading src/web/Home.tsx", "Running npm
// test"). Claude Code, Codex, Gemini CLI, Goose, Hermes, Grok Build and
// Copilot CLI run it on each hook event it is set up for, with the event as JSON on stdin
// (https://code.claude.com/docs/en/hooks, https://learn.chatgpt.com/docs/hooks,
// https://geminicli.com/docs/hooks/reference/,
// https://goose-docs.ai/docs/guides/context-engineering/hooks,
// https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks,
// https://docs.github.com/copilot/reference/hooks-reference); Tricot's hook installers
// (src/server/hooks/) set it up beside tricot-describe.mjs, which turns the
// event into the step, and take it away again.
//
//   node tricot-steps.mjs [--name Claude] [--url http://127.0.0.1:4545] [--narration] [--usage] [--copilot] [--dry-run]
//
// With --copilot (Copilot CLI's hook), the event is read as Copilot's: it
// looks like Claude Code's, with Copilot's own tool arguments (fromCopilot).
//
// With --usage (Codex's hook), at the end of each turn it also sends Codex's
// plan usage, numbers only, which tricot-usage.mjs (copied beside it) reads
// from the end of Codex's own session file: see that file for exactly what.
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

import { describe, fromCopilot } from './tricot-describe.mjs';

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

// With --usage (Codex), at the end of each turn: Codex's plan usage, read
// from the end of its own session file by tricot-usage.mjs, beside this
// file. Only numbers come back from it; undefined when there are none, or
// the module isn't there.
async function codexUsage(event) {
  if (!process.argv.includes('--usage') || event?.hook_event_name !== 'Stop') return undefined;
  try {
    const { fromRollout, readTail } = await import('./tricot-usage.mjs');
    return fromRollout(readTail(event.transcript_path));
  } catch {
    return undefined;
  }
}

async function main() {
  const raw = await readInput();
  if (!raw) return;
  const event = JSON.parse(raw);
  // Copilot CLI's events look like Claude Code's but aren't quite: its hook says so.
  const step = describe(process.argv.includes('--copilot') ? fromCopilot(event) : event, { narration: process.argv.includes('--narration') });
  const usage = await codexUsage(event);
  if (!step && !usage) return;
  const at = Date.now();
  const sends = [
    ...(step ? [['steps', { ...step, at }]] : []),
    ...(usage ? [['usage', { usage, at }]] : []),
  ];
  if (process.argv.includes('--dry-run')) {
    for (const [, body] of sends) process.stdout.write(`${JSON.stringify(body)}\n`);
    return;
  }
  const url = option('url', 'http://127.0.0.1:4545').replace(/\/+$/, '');
  const name = option('name', 'Claude');
  const token = process.env.TRICOT_TOKEN;
  await Promise.allSettled(
    sends.map(([route, body]) =>
      fetch(`${url}/api/agents/${encodeURIComponent(name)}/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      }),
    ),
  );
}

// Whatever happens, it is gone within HARD_LIMIT_MS, and says nothing: a
// hook's failure is never the agent's problem.
setTimeout(() => process.exit(0), HARD_LIMIT_MS).unref();
main()
  .catch(() => {})
  .finally(() => process.exit(0));
