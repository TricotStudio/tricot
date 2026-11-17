import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { deliveryOf, deliveryWords, meantFor, type AgentNow, type DeliveryInput, type StepNow, type Where } from '../src/core/delivery';
import type { Actor, Board, Comment, Reaction, Thread } from '../src/core/types';
import { useHandShapedCards } from './handShapedCards';

// What becomes of a person's message to agents, as the line under it says it
// (core/delivery.ts), read from presence, reactions, steps and replies.

const NOW = Date.parse('2026-11-02T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const sam: Actor = { kind: 'human', name: 'Sam' };
const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };

// A task and a decision as these fixtures write them, with the fields the readers of a message look at: the types of both are
// a part's, which adds them to the core's types and to where a message can be (WhereCards).
interface Task {
  id: string;
  number: number;
  status: string;
  comments: Comment[];
  claimedBy?: Actor;
  assignee?: string;
}
interface Decision {
  id: string;
  number: number;
  comments: Comment[];
}
const task = (fields: Partial<Task> = {}): Task => ({ id: 't1', number: 5, status: 'todo', comments: [], ...fields });
const other = task({ id: 't2', number: 6 });
const decision: Decision = { id: 'd1', number: 3, comments: [] };
const onTask = (fields: Partial<Task> = {}) => ({ task: task(fields) }) as unknown as Where;
const onDecision = () => ({ decision }) as unknown as Where;
const thread = (fields: Partial<Thread> = {}): Thread => ({ id: 'th1', title: 'Ship it?', messages: [], ...fields }) as unknown as Thread;
const board = {
  activity: { actors: [{ actor: sam, at: ago(60_000) }, { actor: claude, at: ago(10 * 60_000) }, { actor: codex, at: ago(3 * 60 * 60_000) }], done: {}, reviewSentAt: {} },
  tasks: [task(), other],
  decisions: [decision],
} as unknown as Board;

// The fixtures above are cards of the kinds a part registers (core/cards.ts): a task is followed by its assignee or the agent that
// claimed it, a decision by none (test/handShapedCards.ts).
before(() => {
  useHandShapedCards();
});

const said = (fields: { mentions?: string[]; reactions?: Reaction[]; at?: string } = {}) => ({ id: 'c1', author: sam, at: fields.at ?? ago(12_000), ...fields });
const eyes = (by: Actor): Reaction => ({ emoji: '👀', by, at: ago(5_000) });
const listening = (name: string, fields: Partial<AgentNow> = {}): AgentNow => ({ name, state: 'listening', lastSeen: ago(1_000), ...fields });
const step = (fields: Partial<StepNow> = {}): StepNow => ({ agent: 'Claude', text: 'Running npm test', at: ago(3_000), card: { kind: 'task', id: 't1' }, ...fields });

function line(input: Partial<DeliveryInput> & Pick<DeliveryInput, 'said'>): string | undefined {
  const delivery = deliveryOf({ board, where: onTask(), after: [], agents: [], steps: [], ...input });
  return delivery && deliveryWords(delivery, NOW);
}

describe('who a message is for', () => {
  it('reads it as agents do: the agents it names, else the thread\'s or the task\'s agent, else any; nothing for people', () => {
    assert.deepEqual(meantFor(board, onTask(), { mentions: ['Claude'] }), ['Claude']);
    assert.equal(meantFor(board, onTask(), { mentions: ['Sam'] }), undefined, 'for a person only');
    assert.deepEqual(meantFor(board, onTask({ status: 'in_progress', claimedBy: codex }), {}), ['Codex'], 'the agent working on it');
    assert.deepEqual(meantFor(board, onTask({ status: 'todo', claimedBy: codex, assignee: 'Claude' }), {}), ['Claude'], 'its assignee');
    assert.deepEqual(meantFor(board, onTask({ status: 'in_progress', claimedBy: codex, assignee: 'Claude' }), {}), ['Claude'], 'its assignee, reassigned from the agent that had it');
    assert.deepEqual(meantFor(board, onTask({ assignee: 'Claude' }), { mentions: ['Codex'] }), ['Codex'], 'on an assigned task, the agent it names');
    assert.deepEqual(meantFor(board, { thread: thread({ lens: { name: 'Legal', agent: 'Codex' } }) }, {}), ['Codex'], 'a routed lens');
    assert.deepEqual(meantFor(board, onDecision(), {}), [], 'any agent');
  });
});

describe('the line under a message on a task assigned to one agent', () => {
  const assigned = onTask({ assignee: 'Claude' });
  const both = [listening('Claude'), listening('Codex')];

  it('follows its assignee alone, though another agent is listening too', () => {
    assert.equal(line({ where: assigned, said: said(), agents: both }), 'Delivered · Claude is listening');
    assert.equal(line({ where: assigned, said: said({ reactions: [eyes(claude)] }), agents: both }), 'Seen by Claude');
    assert.equal(line({ where: assigned, said: said({ reactions: [eyes(codex)] }), agents: both }), 'Delivered · Claude is listening', "another agent's 👀 isn't seen");
    assert.equal(line({ where: assigned, said: said(), agents: [listening('Claude'), listening('Codex', { state: 'working', focus: { kind: 'task', id: 't1' } })] }), 'Delivered · Claude is listening', "nor another agent's look");
    assert.equal(line({ where: assigned, said: said(), after: [{ author: codex }], agents: both }), 'Delivered · Claude is listening', "nor another agent's reply");
    assert.equal(line({ where: assigned, said: said(), after: [{ author: claude }], agents: both }), undefined, "the assignee's reply");
  });

  it('follows the agent a message there names', () => {
    assert.equal(line({ where: assigned, said: said({ mentions: ['Codex'], reactions: [eyes(codex)] }), agents: both }), 'Seen by Codex');
  });

  it('follows a new assignee once it changes', () => {
    assert.equal(line({ where: onTask({ assignee: 'Codex', status: 'in_progress', claimedBy: claude }), said: said({ reactions: [eyes(claude)] }), agents: both }), 'Delivered · Codex is listening');
  });
});

describe('the line under a message to an agent', () => {
  const asked = said({ mentions: ['Claude'] });

  it('gives way to the reply: a comment from the agent after it, or its 👍 or 👎', () => {
    assert.equal(line({ said: asked, after: [{ author: claude }], steps: [step()] }), undefined);
    assert.equal(line({ said: said({ mentions: ['Claude'], reactions: [{ emoji: '👍', by: claude, at: ago(1_000) }] }) }), undefined);
    assert.equal(line({ said: asked, after: [{ author: codex }], agents: [listening('Claude')] }), 'Delivered · Claude is listening', "Codex's reply doesn't answer what Claude was asked");
    const both = said({ mentions: ['Claude', 'Codex'] });
    assert.equal(line({ said: both, after: [{ author: claude }], agents: [listening('Codex')] }), 'Delivered · Codex is listening', 'still waits on the other');
  });

  it('says nothing under a message only for people', () => {
    assert.equal(line({ said: said({ mentions: ['Sam'] }), agents: [listening('Claude')] }), undefined);
  });
});
