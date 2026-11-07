import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Actor, Task, Thread } from '../src/core/types';
import { offeredAgent, pieceAgents, type AgentChoice } from '../src/web/canvas/pairing/offer';

// The agent a piece's full view offers to pair with (T20): the agent the
// piece names, even while it is away; otherwise listening, then working,
// the agent this browser last paired with breaking a tie, then the board's
// first agent; an agent picked in the view stays. One test per row of the
// table on T20's canvas, then the edges around them.

const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };
const sam: Actor = { kind: 'human', name: 'Sam' };

// The board's agents in the Pair menu's order, Claude at the top.
const board = (claudeState: AgentChoice['state'], codexState: AgentChoice['state']): AgentChoice[] => [
  { name: 'Claude', state: claudeState },
  { name: 'Codex', state: codexState },
];

type TaskPart = Pick<Task, 'status' | 'assignee' | 'claimedBy'>;
const task = (status: Task['status'], more: Partial<TaskPart> = {}): TaskPart => ({ status, ...more });

const block = (author: Actor = claude) => ({ id: 'b1', author });

// A thread whose reply named the block, routed to `agent` when given.
function thread(agent?: string, refs = [{ kind: 'block' as const, id: 'b1' }]): Thread {
  return {
    id: 'th1',
    title: 'Can you sketch the page?',
    startedBy: sam,
    startedAt: '2026-11-07T10:00:00.000Z',
    updatedAt: '2026-11-07T10:01:00.000Z',
    lens: agent ? { name: 'General', agent } : undefined,
    messages: [
      { id: 'm1', author: sam, body: 'Can you sketch the page?', at: '2026-11-07T10:00:00.000Z' },
      { id: 'm2', author: claude, body: 'Here it is.', at: '2026-11-07T10:01:00.000Z', refs },
    ],
  };
}

describe('the agent offered by ranking', () => {
  it('offers the one listening over one away you last paired with', () => {
    assert.equal(offeredAgent({ agents: board('listening', 'away'), last: 'Codex' }), 'Claude');
  });

  it('offers the one listening over one working you last paired with', () => {
    assert.equal(offeredAgent({ agents: board('listening', 'working'), last: 'Codex' }), 'Claude');
  });

  it('offers the one working over one away you last paired with', () => {
    assert.equal(offeredAgent({ agents: board('working', 'away'), last: 'Codex' }), 'Claude');
  });

  it('lets your last agent win a tie between two listening, or two working', () => {
    assert.equal(offeredAgent({ agents: board('listening', 'listening'), last: 'Codex' }), 'Codex');
    assert.equal(offeredAgent({ agents: board('working', 'working'), last: 'Codex' }), 'Codex');
    assert.equal(offeredAgent({ agents: board('listening', 'listening'), last: 'codex' }), 'Codex', 'as the board spells it');
  });

  it('offers the first of a tie your last agent is not in', () => {
    assert.equal(offeredAgent({ agents: board('listening', 'listening') }), 'Claude');
    assert.equal(offeredAgent({ agents: board('listening', 'listening'), last: 'Gemini' }), 'Claude');
  });

  it('offers the board’s first agent, at the top of the Pair menu, when both are away', () => {
    assert.equal(offeredAgent({ agents: board('away', 'away'), last: 'Codex' }), 'Claude');
    assert.equal(offeredAgent({ agents: board('away', 'unseen'), last: 'Codex' }), 'Claude');
    assert.equal(offeredAgent({ agents: board('unseen', 'unseen'), last: 'Codex' }), 'Claude');
  });

  it('offers nobody while no agent has been on the board', () => {
    assert.equal(offeredAgent({ agents: [], last: 'Codex' }), null);
    assert.equal(offeredAgent({ agents: [], picked: 'Codex', named: ['Codex'] }), null);
  });
});

describe('the agent picked in the view', () => {
  it('stays offered, even away, over one listening', () => {
    assert.equal(offeredAgent({ agents: board('listening', 'away'), picked: 'Codex' }), 'Codex');
  });

  it('stays offered over the agent the piece names', () => {
    const named = pieceAgents(block(), { task: task('in_progress', { assignee: 'Codex' }) });
    assert.equal(offeredAgent({ agents: board('listening', 'away'), picked: 'Claude', named }), 'Claude');
  });

  it('gives way once it is no longer among the board’s agents', () => {
    assert.equal(offeredAgent({ agents: board('away', 'listening'), picked: 'Gemini' }), 'Codex');
  });
});

describe('the agent a task names', () => {
  it('offers a ready or in-progress task’s assignee, even away, over one listening you last paired with', () => {
    for (const status of ['todo', 'in_progress'] as const) {
      const named = pieceAgents(block(), { task: task(status, { assignee: 'Codex' }) });
      assert.deepEqual(named, ['Codex']);
      assert.equal(offeredAgent({ agents: board('listening', 'away'), named, last: 'Claude' }), 'Codex', status);
    }
  });

  it('offers the agent that claimed it when nobody is assigned', () => {
    const named = pieceAgents(block(), { task: task('in_review', { claimedBy: codex }) });
    assert.deepEqual(named, ['Codex']);
    assert.equal(offeredAgent({ agents: board('listening', 'away'), named, last: 'Claude' }), 'Codex');
  });

  it('prefers the assignee to the agent that claimed it', () => {
    assert.deepEqual(pieceAgents(block(), { task: task('in_progress', { assignee: 'Codex', claimedBy: claude }) }), ['Codex']);
  });

  it('names nobody for a task released to do, or claimed by a person', () => {
    assert.deepEqual(pieceAgents(block(), { task: task('todo', { claimedBy: codex }) }), []);
    assert.deepEqual(pieceAgents(block(), { task: task('in_progress', { claimedBy: sam }) }), []);
  });

  it('leaves a backlog card’s assignee to the ranking', () => {
    const named = pieceAgents(block(), { task: task('backlog', { assignee: 'Codex' }) });
    assert.deepEqual(named, []);
    assert.equal(offeredAgent({ agents: board('listening', 'away'), named, last: 'Codex' }), 'Claude');
  });

  it('leaves an assignee who has never been on the board to the ranking', () => {
    const named = pieceAgents(block(), { task: task('todo', { assignee: 'Gemini' }) });
    assert.equal(offeredAgent({ agents: board('away', 'listening'), named }), 'Codex');
  });
});

describe('the agent a thread names', () => {
  it('offers the agent a block’s thread is routed to, over one listening you last paired with', () => {
    const named = pieceAgents(block(claude), { threads: [thread('Codex')] });
    assert.deepEqual(named, ['Codex']);
    assert.equal(offeredAgent({ agents: board('listening', 'away'), named, last: 'Claude' }), 'Codex');
  });

  it('offers the agent that made the block when its thread is routed to nobody', () => {
    const named = pieceAgents(block(codex), { threads: [thread()] });
    assert.deepEqual(named, ['Codex']);
    assert.equal(offeredAgent({ agents: board('listening', 'away'), named }), 'Codex');
  });

  it('finds a block a thread made ahead of its reply', () => {
    const waiting: Thread = { ...thread('Codex', []), pending: [{ kind: 'block', id: 'b1', by: codex }] };
    assert.deepEqual(pieceAgents(block(), { threads: [waiting] }), ['Codex']);
  });

  it('names nobody for a block no thread made, or a person’s in a thread routed to nobody', () => {
    assert.deepEqual(pieceAgents(block(codex), { threads: [thread('Codex', [{ kind: 'block', id: 'b2' }])] }), []);
    assert.deepEqual(pieceAgents(block(codex), {}), []);
    assert.deepEqual(pieceAgents(block(sam), { threads: [thread()] }), []);
  });
});

describe('a piece with no single agent to name', () => {
  it('falls back to the ranking on the board context or a decision, where nothing is named', () => {
    const named = pieceAgents(block(), { threads: [] });
    assert.deepEqual(named, []);
    assert.equal(offeredAgent({ agents: board('away', 'listening'), named, last: 'Claude' }), 'Codex');
    assert.equal(offeredAgent({ agents: board('away', 'working'), named, last: 'Claude' }), 'Codex');
    assert.equal(offeredAgent({ agents: board('away', 'away'), named, last: 'Codex' }), 'Claude');
  });

  it('falls back to the ranking when the task and the thread name different agents', () => {
    const named = pieceAgents(block(claude), { task: task('in_progress', { assignee: 'Codex' }), threads: [thread('Claude')] });
    assert.deepEqual(named, ['Codex', 'Claude']);
    assert.equal(offeredAgent({ agents: board('away', 'listening'), named }), 'Codex');
    assert.equal(offeredAgent({ agents: board('listening', 'away'), named }), 'Claude');
  });

  it('names one agent once, when the task and the thread agree', () => {
    const named = pieceAgents(block(claude), { task: task('in_progress', { assignee: 'Codex' }), threads: [thread('codex')] });
    assert.deepEqual(named, ['Codex']);
    assert.equal(offeredAgent({ agents: board('listening', 'away'), named }), 'Codex');
  });

  it('falls back to the ranking when two threads name different agents', () => {
    const named = pieceAgents(block(), { threads: [thread('Codex'), thread('Claude')] });
    assert.deepEqual(named, ['Codex', 'Claude']);
    assert.equal(offeredAgent({ agents: board('working', 'listening'), named, last: 'Claude' }), 'Codex');
  });
});
