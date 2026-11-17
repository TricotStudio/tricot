#!/usr/bin/env node
// Tricot lenses in an agent's own terminal: a message that opens with ^ and
// a lens's name ("^Design please review this", "^legal: is this licence
// ok?") is answered through that lens, as one sent from the board's chat bar
// is. Claude Code, Codex, Gemini CLI and Hermes Agent run it on each prompt
// you send, before the model reads it, with the prompt as JSON on stdin
// (UserPromptSubmit, https://code.claude.com/docs/en/hooks#userpromptsubmit
// and https://learn.chatgpt.com/docs/hooks; Gemini CLI's BeforeAgent,
// https://geminicli.com/docs/hooks/reference/; Hermes's pre_llm_call,
// https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks). The
// first three take the answer in the same shape, under the event's own name;
// Hermes takes {"context": …}, which it adds to your message for that turn.
// A hook can't change what was typed, so it adds the lens's brief beside it,
// as context the model reads with the message: "Answer this message through
// the Design lens: …". The lenses are Tricot's presets, from
// tricot-lenses.mjs beside it. General, which has no brief, adds nothing; nor
// does a name that isn't a lens, for which it shows you a line saying so
// (Hermes has no such line: there, it adds nothing). Tricot's hook installers
// (src/server/hooks/) set it up beside tricot-steps.mjs, and take it away
// again. Pi and OMP do the same in Tricot's extension
// (tricot-steps-extension.ts), from the same lenses.
//
// It also reads the prompt for a person asking to see something on Tricot,
// the board or the canvas ("show me the last dev log in tricot"), with
// tricot-show.mjs beside it, and adds a line for the model with that prompt:
// make a Sketchbook page showing it and give its link, or run `tricot show`
// without the board's tools. Asked through a lens too, the model gets both.
// For such a prompt it also asks whether Tricot is running, at the address the
// installer gave it (--url, as tricot-steps.mjs has it), and when it isn't,
// the line says so, with the one step for the person: start Tricot, then run
// /mcp so the agent's tools reconnect (showContextFor says the rest). Pi and
// OMP do all that in their extension as well.
//
//   node tricot-prompt.mjs [--url http://127.0.0.1:4545]
//
// It sends none of the prompt anywhere, and Tricot needn't be running. For a
// prompt that asks to see something on Tricot, and only for one, it asks the
// board whether it is up: a request with none of the person's words in it (GET
// /api/info, with TRICOT_TOKEN, when set, as the bearer token a board beyond
// this machine needs), and, when the board doesn't answer, a look for `tricot
// show`. That holds the prompt up for a few milliseconds when Tricot is up,
// and for under a second when it is not. Any other prompt it is done with in a
// few hundredths of a second.
//
// It never stops a prompt: on any error, or past a second, it exits 0 having
// printed nothing, so the prompt goes through as typed (an agent reads exit 2
// as "stop this prompt", which it never uses, and it never prints Hermes's
// "block"). It prints nothing for a prompt that neither opens with ^ nor asks
// to see something on Tricot, and nothing but its JSON answer otherwise, which
// Gemini CLI needs. No dependencies: Node 18 or newer.

import { lensAsked, lensContext, unknownLensLine } from './tricot-lenses.mjs';
import { showContextFor } from './tricot-show.mjs';

const HARD_LIMIT_MS = 1000;
const MAX_INPUT = 8 * 1024 * 1024; // a pasted prompt can be large, and Hermes sends the conversation too; past this it goes as typed
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

// Where Tricot is, as the installer wrote it, as tricot-steps.mjs has it.
const URL_ = option('url', 'http://127.0.0.1:4545').replace(/\/+$/, '');

// The events it answers, each an agent's "a prompt was sent, before the model
// reads it": where that event has the prompt, how it takes what is added for
// the model, and how a line for the person, if it can show one.
const sameAsClaude = {
  prompt: (event) => event.prompt,
  context: (event, text) => ({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: text } }),
  say: (line) => ({ systemMessage: line }),
};
const EVENTS = {
  UserPromptSubmit: sameAsClaude, // Claude Code's and Codex's
  BeforeAgent: sameAsClaude, // Gemini CLI's
  // Hermes's: the message in extra.user_message, the brief as {"context": …}
  // (agent/shell_hooks.py), and no line for the person.
  pre_llm_call: {
    prompt: (event) => (isObject(event.extra) ? event.extra.user_message : undefined),
    context: (_event, text) => ({ context: text }),
  },
};

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

// What it prints for an event: as context for the model, the lens's brief
// and the line for a prompt that asks to see something on Tricot (which says
// when Tricot isn't running); a line for the person when the name isn't a
// lens; or nothing.
async function answerFor(event) {
  if (!isObject(event) || typeof event.hook_event_name !== 'string' || !Object.hasOwn(EVENTS, event.hook_event_name)) return undefined;
  const agent = EVENTS[event.hook_event_name];
  const prompt = agent.prompt(event);
  const asked = lensAsked(prompt);
  const said = asked && 'unknown' in asked ? agent.say?.(unknownLensLine(asked.unknown)) : undefined;
  const show = await showContextFor(prompt, { url: URL_, token: process.env.TRICOT_TOKEN });
  const context = [asked && 'lens' in asked ? lensContext(asked.lens) : undefined, show].filter(Boolean).join('\n\n');
  if (!said && !context) return undefined;
  return { ...said, ...(context && agent.context(event, context)) };
}

async function main() {
  const raw = await readInput();
  if (!raw) return;
  const answer = await answerFor(JSON.parse(raw));
  if (!answer) return;
  await new Promise((resolve) => process.stdout.write(JSON.stringify(answer), resolve));
}

// Whatever happens, it is gone within HARD_LIMIT_MS, and a failure says
// nothing: the prompt is never the hook's to stop.
setTimeout(() => process.exit(0), HARD_LIMIT_MS).unref();
main()
  .catch(() => {})
  .finally(() => process.exit(0));
