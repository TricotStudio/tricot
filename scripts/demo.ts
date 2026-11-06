// Seeds an example board through the same channels real participants use:
// an agent over MCP and a human over the web API. Usage:
//   npm run demo [-- http://127.0.0.1:4545] [--let-in]
//
// Resolving and deferring a decision are a person's alone, from a browser or
// terminal they let in (access.ts asPerson, tier B). The demo leaves those
// two decisions open for you to answer on the board. With --let-in it asks to
// be let in as a terminal does (`tricot update`): allow it, with the code it
// shows, in a browser you've let in, and it resolves one and defers the other.
// It never lets itself in: on a board with no seat yet that would take the
// first browser's place (seats.ts bootstrap).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { asThisTerminal, type ThisTerminal } from '../src/cli/terminalKey';

const args = process.argv.slice(2);
const letIn = args.includes('--let-in');
const base = args.find((arg) => !arg.startsWith('--')) ?? 'http://127.0.0.1:4545';
const human = 'Sam';

const agent = new Client({ name: 'demo', version: '1.0.0' });
await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=planner`)));

async function tool(name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await agent.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
  return result.content[0].text;
}

// As Tricot's page sends it, with its Origin: the board takes what a person
// does from its page alone (src/server/access.ts asPerson).
async function as_human(route: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}/api${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ actor: human, ...body }),
  });
  if (!response.ok) throw new Error(`${route}: ${(await response.json()).error}`);
  return response.json();
}

const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];

const boardId = idOf(
  await tool('create_board', {
    title: 'API client retry logic',
    goal: 'Make outbound API calls resilient without changing behaviour at existing call sites.',
  }),
);

const strategy = idOf(
  await tool('post_decision', {
    board_id: boardId,
    question: 'Which retry strategy should the API client use?',
    context:
      'There are **60 call sites** across 14 modules. Some already wrap calls in ad-hoc `try/catch` loops; those need to keep their current semantics.',
    options: [
      { label: 'Options object', description: 'Each call passes `{ retry: { attempts, backoff } }`.', pros: ['Explicit at every call site'], cons: ['Touches every call site'] },
      { label: 'Wrapper function', description: '`withRetry(fn, policy)` wraps any call.', pros: ['Composable', 'No client changes'], cons: ['Easy to double-wrap'] },
      { label: 'Client-level policy', description: 'Configure retries once on the client instance.', pros: ['Smallest diff'], cons: ['Implicit; hard to opt out per call'] },
    ],
    recommend: 'a',
    recommendation_reason: 'Explicit per-call config keeps behaviour visible where it changes.',
    blocking: true,
  }),
);

await as_human(`/decisions/${strategy}/explore`, {
  note: 'Prototype all three on branches and compare blast radius before I pick.',
});

const findings = [
  { option: 'a', summary: 'Covers every call site. Most edits are mechanical; 8 need a judgement call about existing loops.', metrics: { 'call sites covered': '60 / 60', 'mechanical edits': 52, 'judgement calls': 8, 'silent behaviour changes': 0, 'recovery p95': '1.8s' }, links: ['explore/retry-options-object'] },
  { option: 'b', summary: 'Covers every call site, but **16 silently change behaviour** where callers already retry.', metrics: { 'call sites covered': '60 / 60', 'mechanical edits': 44, 'judgement calls': 0, 'silent behaviour changes': 16, 'recovery p95': '1.7s' }, links: ['explore/retry-wrapper'] },
  { option: 'c', summary: 'Smallest diff, but 46 call sites use per-request clients the policy cannot reach.', metrics: { 'call sites covered': '14 / 60', 'mechanical edits': 14, 'judgement calls': 0, 'silent behaviour changes': 0, 'recovery p95': '2.4s' }, links: ['explore/retry-client-policy'] },
];
for (const finding of findings) await tool('attach_finding', { decision_id: strategy, ...finding });

await tool('post_decision', {
  board_id: boardId,
  question: 'Which backoff curve?',
  options: [
    { label: 'Exponential with full jitter', description: 'Random delay up to base·2ⁿ.' },
    { label: 'Fixed 500ms' },
    { label: 'Decorrelated jitter' },
  ],
  recommend: 'a',
  recommendation_reason: 'Spreads retries best when many clients fail at once.',
  depends_on: [strategy],
});

const posts = idOf(
  await tool('post_decision', {
    board_id: boardId,
    question: 'Should non-idempotent POSTs ever be retried?',
    context: 'Retrying a POST that already reached the server can create duplicates (e.g. double charges).',
    options: [
      { label: 'Never' },
      { label: 'Only with an idempotency key' },
      { label: 'Always' },
    ],
    recommend: 'b',
    recommendation_reason: 'The payments API already accepts `Idempotency-Key`; other POST endpoints could adopt it.',
    blocking: true,
  }),
);
await as_human(`/decisions/${posts}/comments`, { body: 'Do all our POST endpoints support idempotency keys today?' });
await tool('comment', { decision_id: posts, body: 'No: 9 of 23 do. The rest would need server changes, so (b) means "never" for those until they are updated.' });

await tool('log_decision', {
  board_id: boardId,
  question: 'Maximum retry attempts?',
  choice: '3 attempts',
  rationale: 'Matches the SDK default and limits load amplification during an outage.',
  alternatives: ['5 attempts'],
});

const config = idOf(
  await tool('post_decision', {
    board_id: boardId,
    question: 'Where should retry configuration live?',
    options: [{ label: 'Per-environment config file' }, { label: 'Hard-coded defaults' }],
  }),
);
const metrics = idOf(
  await tool('post_decision', {
    board_id: boardId,
    question: 'Expose retry metrics on the ops dashboard?',
    options: [{ label: 'Yes, per endpoint' }, { label: 'Aggregate only' }],
  }),
);
// A person's alone, signed by a seat (see the top of this file).
const seated: [string, Record<string, unknown>, string][] = [
  [`/decisions/${config}/resolve`, { optionId: 'a', rationale: 'Staging needs more aggressive retries than prod.' }, 'Where should retry configuration live?'],
  [`/decisions/${metrics}/defer`, { note: 'After launch.' }, 'Expose retry metrics on the ops dashboard?'],
];
let leftOpen = seated.map(([, , question]) => question);
if (letIn) {
  await asThisTerminal(
    base,
    {},
    async (headers, terminal: ThisTerminal) => {
      const asked = await terminal.letIn((line) => console.log(line));
      if (!asked.ok) {
        console.log(`Not let in (${asked.error}): leaving those decisions open.`);
        return;
      }
      for (const [route, body] of seated) {
        const text = JSON.stringify({ actor: human, ...body });
        const response = await fetch(`${base}/api${route}`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json', ...terminal.sign('POST', `/api${route}`, text) },
          body: text,
        });
        if (!response.ok) throw new Error(`${route}: ${(await response.json()).error}`);
      }
      leftOpen = [];
    },
    fetch,
    'npm run demo',
  );
}

// Shared context on the board canvas.
const constraints = idOf(
  await tool('add_block', {
    board_id: boardId,
    type: 'note',
    title: 'Constraints',
    text: '- No behaviour change at existing call sites\n- Payments must **never** double-charge\n- Ship before the Q4 freeze',
  }),
);
const flow = idOf(
  await tool('add_block', {
    board_id: boardId,
    type: 'diagram',
    title: 'Request flow',
    source: [
      'flowchart LR',
      '  caller[Call site] --> client[API client]',
      '  client -->|5xx or timeout| policy{Retry policy}',
      '  policy -->|attempts left| backoff[Backoff + jitter]',
      '  backoff --> client',
      '  policy -->|exhausted| fail[Surface error]',
    ].join('\n'),
  }),
);
await tool('link', { from_block_id: constraints, to_block_id: flow, label: 'constrains' });
await tool('add_block', {
  board_id: boardId,
  type: 'checklist',
  title: 'Rollout',
  items: [{ text: 'Audit call sites', done: true }, 'Pick a strategy', 'Idempotency keys on POSTs', 'Canary in staging'],
});

// Evidence on the strategy decision's own canvas.
const evidence = idOf(await tool('add_group', { decision_id: strategy, title: 'Why option b breaks callers' }));
const audit = idOf(
  await tool('add_block', {
    decision_id: strategy,
    group_id: evidence,
    option: 'b',
    type: 'table',
    title: 'Callers that already retry',
    columns: ['module', 'call sites', 'existing retry'],
    rows: [
      ['payments', '4', 'custom loop'],
      ['search', '6', 'library'],
      ['webhooks', '3', 'custom loop'],
      ['exports', '3', 'library'],
    ],
  }),
);
const doubled = idOf(
  await tool('add_block', {
    decision_id: strategy,
    group_id: evidence,
    option: 'b',
    type: 'note',
    title: 'Retries multiply',
    text: 'Wrapping a caller that already retries multiplies attempts: 3 × 3 = **9 calls** per request during an outage.',
  }),
);
await tool('link', { from_block_id: audit, to_block_id: doubled, label: 'causes' });
await tool('add_block', { decision_id: strategy, type: 'comparison', title: 'Prototype results' });
await tool('add_block', {
  decision_id: strategy,
  option: 'a',
  type: 'diagram',
  title: 'Option a: per-call config',
  source: ['flowchart TD', '  call["client.get(url, { retry })"] --> has{retry option?}', '  has -->|yes| run[Retry with that policy]', '  has -->|no| once[One attempt, as today]'].join('\n'),
});

await agent.close();
console.log(`Seeded board ${boardId}: ${base}/#/b/${boardId}`);
if (leftOpen.length)
  console.log(`Left open for you to resolve or defer on the board (or run the demo with --let-in): ${leftOpen.map((q) => `"${q}"`).join(', ')}`);
