// What one reply to a person costs in Tricot's own time, with no model in the
// loop. A scripted agent over MCP listens, reads what it needs and answers, as
// agents do; a scripted person over REST comments on a task, writes in a
// thread or @-mentions the agent on a decision, watches the board's live
// stream for the answer, reads it for a moment and writes again. It reports
// how long Tricot took at each step, and how many tool calls each reply cost
// the agent: in real use each call is a model turn, which costs far more.
//
//   npx tsx scripts/measure-reply.ts [base-url] [--rounds 21] [--flow today|one-turn] [--json file] [--show]
//
// --show prints each tool result the agent reads while it answers.
//
// Without a base URL it runs its own server on a free port, with a fresh data
// folder it removes after. The flows:
//   today     wait_for_updates, then read the card or thread (get_task,
//             get_thread, get_decision), then reply, then wait again
//   one-turn  reply with then_wait, which posts and then waits for the next
//             message in the same call, and read nothing else
// The default is one-turn when the server's comment tool takes then_wait.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const given = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const rounds = Number(option('rounds') ?? 21);
const PERSON = 'Sam';
const AGENT = 'Claude';
const READING_MS = 400; // the person reads the answer before writing again, so the agent is listening by then

type Kind = 'task' | 'thread' | 'mention';
const KINDS: Kind[] = ['task', 'thread', 'mention'];
const KIND_NAMES: Record<Kind, string> = { task: 'comment on a task', thread: 'thread message', mention: '@-mention on a decision' };

// ---- the server ------------------------------------------------------------------

async function ownServer(): Promise<{ base: string; close(): Promise<void> }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-measure-'));
  const { Store } = await import('../src/core/store');
  const { createApp } = await import('../src/server/app');
  const store = new Store(dir);
  store.load();
  const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      server.closeAllConnections();
      server.close();
      await store.flush();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const own = given ? undefined : await ownServer();
const base = given ?? own!.base;

// ---- the person, over REST and the live stream ---------------------------------------

async function rest(method: 'GET' | 'POST', route: string, body?: Record<string, unknown>) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body && JSON.stringify({ actor: PERSON, ...body }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${route}: ${json.error}`);
  return json;
}

// The board's stream as a page reads it: each agent comment or thread message
// it brings, with when it came.
interface Heard {
  at: number;
  type: string;
}
function watch(boardId: string): { ready: Promise<void>; next(): Promise<Heard>; stop(): void } {
  const controller = new AbortController();
  const queue: Heard[] = [];
  let waiting: ((heard: Heard) => void) | undefined;
  let open = () => {};
  const ready = new Promise<void>((resolve) => (open = resolve));
  void (async () => {
    const response = await fetch(`${base}/api/boards/${boardId}/stream`, { signal: controller.signal });
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (/^event: hello$/m.test(frame)) open();
          if (!/^event: change$/m.test(frame)) continue;
          const at = performance.now();
          const change = JSON.parse(/^data: (.*)$/m.exec(frame)![1]) as { events?: { type: string; actor: { kind: string } }[] };
          for (const event of change.events ?? []) {
            if (event.actor.kind !== 'agent' || !['comment_added', 'thread_replied'].includes(event.type)) continue;
            const heard = { at, type: event.type };
            if (waiting) {
              waiting(heard);
              waiting = undefined;
            } else queue.push(heard);
          }
        }
      }
    } catch {
      // stopped
    }
  })();
  return {
    ready,
    next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise((resolve) => (waiting = resolve))),
    stop: () => controller.abort(),
  };
}

// ---- the agent, over MCP ---------------------------------------------------------

const agent = new Client({ name: 'measure-reply', version: '1.0.0' });
await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=${AGENT}`)));
let calls = 0;
let answering = false; // past setting up the board

async function tool(name: string, input: Record<string, unknown>): Promise<string> {
  calls++;
  const result = (await agent.callTool({ name, arguments: input }, undefined, { timeout: 300_000 })) as { content: { type: string; text?: string }[]; isError?: boolean };
  const text = result.content.map((c) => c.text ?? '').join('\n\n');
  if (result.isError) throw new Error(`${name}: ${text}`);
  if (args.includes('--show') && answering) console.log(`\n>>> ${name}(${Object.keys(input).join(', ')}): ${text.length} chars\n${text}`);
  return text;
}

const { tools } = await agent.listTools();
const comment = tools.find((t) => t.name === 'comment')!;
const canThenWait = Boolean((comment.inputSchema.properties as Record<string, unknown> | undefined)?.then_wait);
const flow = option('flow') ?? (canThenWait ? 'one-turn' : 'today');
if (flow === 'one-turn' && !canThenWait) throw new Error("This server's comment tool doesn't take then_wait: measure it with --flow today.");

// ---- the board ---------------------------------------------------------------------

const boardId = (await rest('POST', '/boards', { title: 'Measuring replies' })).id as string;
const task = await rest('POST', `/boards/${boardId}/tasks`, { title: 'Ship the onboarding tour' });
const idOf = (text: string, label = 'id') => new RegExp(`\\[${label}: ([^\\]]+)\\]`).exec(text)![1];
const threadId = idOf(await tool('start_thread', { board_id: boardId, body: 'Where should the onboarding tour start?' }), 'thread id');
const decisionId = idOf(
  await tool('post_decision', {
    board_id: boardId,
    question: 'How many steps should the tour have?',
    options: [{ label: 'Three' }, { label: 'Two' }],
    recommend: 'b',
    recommendation_reason: 'The third step repeats the first.',
  }),
);
let cursor = Number(/Cursor: (\d+)/.exec(await tool('get_board', { board_id: boardId }))![1]);
calls = 0;
answering = true;

const LONG =
  ' To be concrete: the first step shows the board, the second the decision map, and the third shows the board again with the agents panel open, which people told us felt like a repeat. If we cut it, the agents panel needs a way in from the second step, perhaps a small "who is here" chip next to the map, which is what the design notes suggested last week.';
function message(round: number, kind: Kind): string {
  const ask = kind === 'mention' ? `@${AGENT} ` : '';
  return `${ask}Round ${round}: can you check whether the tour still needs its third step?${round % 4 === 0 ? LONG : ''}`;
}

// What the person wrote is answerable from the update alone when it is there
// whole, with the call that answers it.
function answerable(update: string, kind: Kind, body: string): boolean {
  const said = body.replace(`@${AGENT} `, '');
  const reply = kind === 'thread' ? `reply_in_thread(thread_id: ${threadId}` : kind === 'task' ? `comment(task_id: ${task.id}` : `comment(decision_id: ${decisionId}`;
  return update.includes(said) && update.includes(reply);
}

// Where an update asks for an answer, from its activity lines.
function placeIn(update: string): Kind {
  const lines = update.split('\nCursor: ')[0];
  if (lines.includes(`[thread id: ${threadId}]`)) return 'thread';
  if (lines.includes(`decision id: ${decisionId}`)) return 'mention';
  return 'task';
}

const READS: Record<Kind, [string, Record<string, unknown>]> = {
  task: ['get_task', { task_id: task.id }],
  thread: ['get_thread', { thread_id: threadId }],
  mention: ['get_decision', { decision_id: decisionId }],
};
const REPLIES: Record<Kind, [string, Record<string, unknown>]> = {
  task: ['comment', { task_id: task.id }],
  thread: ['reply_in_thread', { thread_id: threadId }],
  mention: ['comment', { decision_id: decisionId }],
};

// ---- the conversation ------------------------------------------------------------

interface Round {
  kind: Kind;
  posted: number; // the person sends it
  heard?: number; // the agent's call returns with it
  read?: number; // the agent has read the card or thread
  replying?: number; // the agent sends its answer
  seen?: number; // the person's stream brings the answer
  answerable?: boolean;
  chars: number; // what the agent read for this reply: the result that brought the message, the read, the reply's own
}
const log: Round[] = [];
const stream = watch(boardId);
await stream.ready;
const heard: ((at: number, update: string) => void)[] = [];
const nextHeard = () => new Promise<{ at: number; update: string }>((resolve) => heard.push((at, update) => resolve({ at, update })));

// The agent: listens, reads (today), answers, and listens again.
async function agentLoop(): Promise<void> {
  let update = await tool('wait_for_updates', { board_id: boardId, since: cursor, timeout_seconds: 60 });
  for (let i = 0; i < rounds; i++) {
    const hear = heard.shift();
    if (!hear) throw new Error(`Round ${i + 1}: the agent's call returned with nothing from the person:\n${update}`);
    hear(performance.now(), update);
    log[i].chars += update.length;
    cursor = Number(/Cursor: (\d+)/.exec(update)?.[1] ?? cursor);
    const kind = placeIn(update);
    if (flow === 'today') {
      const [read, input] = READS[kind];
      log[i].chars += (await tool(read, input)).length;
      log[i].read = performance.now();
    }
    const [reply, input] = REPLIES[kind];
    const last = i === rounds - 1;
    log[i].replying = performance.now();
    const body = `Yes: round ${i + 1} still needs it.`;
    // A reply with then_wait comes back with the next message: it counts for that one.
    if (flow === 'one-turn' && !last) update = await tool(reply, { ...input, body, then_wait: 60 });
    else {
      log[i].chars += (await tool(reply, { ...input, body })).length;
      if (!last) update = await tool('wait_for_updates', { board_id: boardId, since: cursor, timeout_seconds: 60 });
    }
  }
}

// The person: writes, waits to see the answer, reads it, writes again. The
// agent is listening before the first message, as it is before each next one.
async function personLoop(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, READING_MS));
  for (let i = 0; i < rounds; i++) {
    const kind = KINDS[i % KINDS.length];
    const body = message(i + 1, kind);
    const round: Round = { kind, posted: performance.now(), chars: 0 };
    log.push(round);
    const arrived = nextHeard();
    if (kind === 'task') await rest('POST', `/tasks/${task.id}/comments`, { body });
    else if (kind === 'thread') await rest('POST', `/threads/${threadId}/messages`, { body });
    else await rest('POST', `/decisions/${decisionId}/comments`, { body });
    const { at, update } = await arrived;
    round.heard = at;
    round.answerable = answerable(update, kind, body);
    round.seen = (await stream.next()).at;
    await new Promise((resolve) => setTimeout(resolve, READING_MS));
  }
}

const started = performance.now();
await Promise.all([agentLoop(), personLoop()]);
const took = performance.now() - started;
stream.stop();
await agent.close();
await own?.close();

// ---- the report ----------------------------------------------------------------

const ms = (n: number) => `${Math.round(n)} ms`;
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { median: at(0.5), p90: at(0.9), min: sorted[0], max: sorted.at(-1)! };
}
const steps = {
  heard: log.map((r) => r.heard! - r.posted),
  read: log.map((r) => (r.read === undefined ? 0 : r.read - r.heard!)),
  seen: log.map((r) => r.seen! - r.replying!),
  total: log.map((r) => r.heard! - r.posted + (r.read === undefined ? 0 : r.read - r.heard!) + (r.seen! - r.replying!)),
};
const perReply = calls / rounds;
const steady = flow === 'one-turn' ? 1 : 3;
const answered = log.filter((r) => r.answerable).length;

// What the agent reads per reply, in characters of tool results, and tokens
// at about four characters each. The first message on each card or thread
// (the first round of each kind) apart from follow-ups in the same discussion.
const first = log.slice(0, KINDS.length).map((r) => r.chars);
const followUps = log.slice(KINDS.length).map((r) => r.chars);
const size = (n: number) => `${Math.round(n).toLocaleString('en')} chars (≈${Math.round(n / 4).toLocaleString('en')} tokens)`;
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const rows = [
  ['Person posts → agent hears it (wait returns)', steps.heard],
  ['Agent reads the card or thread', steps.read],
  ["Agent replies → person's live stream shows it", steps.seen],
  ["Tricot's time per reply, in all", steps.total],
] as const;
const lines = [
  `Flow: ${flow}, ${rounds} rounds (${KINDS.map((k) => KIND_NAMES[k]).join(', ')} in turn), server ${given ?? 'in this process'}`,
  '',
  '| Step | median | p90 | min | max |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map(([name, values]) => {
    const s = stats(values);
    return `| ${name} | ${ms(s.median)} | ${ms(s.p90)} | ${ms(s.min)} | ${ms(s.max)} |`;
  }),
  '',
  `Tool calls per reply: ${perReply.toFixed(2)} (${calls} calls for ${rounds} replies; ${steady} once listening)`,
  `Answerable from the update alone (whole message and the call to reply): ${answered} of ${rounds}`,
  '',
  'What the agent reads per reply (tool results; tokens ≈ characters / 4):',
  `- first message on a card or thread: ${size(mean(first))} on average`,
  followUps.length
    ? `- follow-up in the same discussion: ${size(mean(followUps))} on average; the last, ${followUps.length} rounds in: ${size(followUps.at(-1)!)}`
    : '- follow-up in the same discussion: none (run more rounds)',
  `- in all: ${size(log.reduce((sum, r) => sum + r.chars, 0))} for ${rounds} replies`,
  '',
  `Wall time: ${ms(took)}, of which the person reading: ${ms((rounds + 1) * READING_MS)}`,
];
console.log(lines.join('\n'));

const json = option('json');
if (json) {
  const summary = Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, stats(v)]));
  const chars = { first: mean(first), followUps: mean(followUps), lastFollowUp: followUps.at(-1), total: log.reduce((sum, r) => sum + r.chars, 0) };
  writeFileSync(json, `${JSON.stringify({ flow, rounds, server: given ?? 'in-process', calls, perReply, answered, summary, chars, log }, null, 2)}\n`);
}
process.exit(0);
