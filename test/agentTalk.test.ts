import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AGENT_LOOP_LIMIT, heldRun, heldWords, loopAgents, loopRun, loopWords, sentNote, toAgents, type Talk } from '../src/core/agentTalk';
import { deliveryOf, deliveryWords, meantFor, type AgentNow, type DeliveryInput } from '../src/core/delivery';
import { mentionTag } from '../src/core/mentions';
import { Store } from '../src/core/store';
import { BURST_SETTLE_MS, MESSAGE_SETTLE_MS, settleAfter, wakes } from '../src/core/store/eventLog';
import type { Actor, Board, BoardEvent, Reaction, Task } from '../src/core/types';
import { eventsOf } from './tables';

// Agents tagging each other (core/agentTalk.ts): an agent's message that
// @-mentions another agent asks it, as a person's would, until the loop guard
// holds a run of them with no person in between.

const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };
const wassim: Actor = { kind: 'human', name: 'Wassim' };
const AGENTS = ['Claude', 'Codex', 'Gemini'];
const agentsOf = (names: string[] | undefined) => (names ?? []).filter((n) => AGENTS.includes(n));
const say = (author: Actor, mentions?: string[], held?: number): Talk => ({ author, ...(mentions && { mentions }), ...(held && { held }) });

describe('the loop guard, counted', () => {
  it('reads an agent message as for the other agents it names, and nobody else\'s', () => {
    assert.deepEqual(toAgents(say(claude, ['Codex']), agentsOf), ['Codex']);
    assert.deepEqual(toAgents(say(claude, ['Codex', 'Wassim']), agentsOf), ['Codex'], 'a person it names is no agent');
    assert.deepEqual(toAgents(say(claude, ['Claude', 'Codex']), agentsOf), ['Codex'], 'never itself');
    assert.deepEqual(toAgents(say(claude), agentsOf), [], 'a plain message');
    assert.deepEqual(toAgents(say(wassim, ['Codex']), agentsOf), [], "a person's mention reads as it always has");
  });

  it('counts agent-to-agent mentions since a person last wrote', () => {
    assert.equal(AGENT_LOOP_LIMIT, 4);
    assert.equal(loopRun([], agentsOf), 0);
    assert.equal(loopRun([say(claude, ['Codex']), say(codex, ['Claude'])], agentsOf), 2);
    assert.equal(loopRun([say(claude, ['Codex']), say(codex), say(claude, ['Codex'])], agentsOf), 2, "an agent's plain message neither counts nor ends the run");
    assert.equal(loopRun([say(claude, ['Codex']), say(codex, ['Claude']), say(wassim), say(claude, ['Codex'])], agentsOf), 1, "a person's message ends it");
    assert.equal(loopRun([say(claude, ['Codex']), say(wassim, ['Codex'])], agentsOf), 0, 'whatever the person says');
  });

  it('holds the fifth in a row, and every one after it, until a person writes', () => {
    const four = [say(claude, ['Codex']), say(codex, ['Claude']), say(claude, ['Codex']), say(codex, ['Claude'])];
    assert.equal(heldRun(four.slice(0, 3), say(codex, ['Claude']), agentsOf), undefined, 'the fourth still asks');
    assert.equal(heldRun(four, say(claude, ['Codex']), agentsOf), 5);
    assert.equal(heldRun([...four, say(claude, ['Codex'], 5)], say(codex, ['Claude']), agentsOf), 6);
    assert.equal(heldRun(four, say(claude), agentsOf), undefined, 'a plain message is never held');
    assert.equal(heldRun(four, say(wassim, ['Codex']), agentsOf), undefined, "nor a person's");
    assert.equal(heldRun([...four, say(wassim)], say(claude, ['Codex']), agentsOf), undefined, 'a person resets it');
  });

  it('names the agents of a held run for the page, until a person writes', () => {
    const run = [say(wassim), say(claude, ['Codex']), say(codex, ['Claude']), say(claude, ['Codex']), say(codex, ['Claude'])];
    assert.equal(loopAgents(run, agentsOf), undefined, 'nothing held yet');
    const held = [...run, say(claude, ['Codex'], 5)];
    assert.deepEqual(loopAgents(held, agentsOf), ['Claude', 'Codex']);
    assert.deepEqual(loopAgents([...held, say(codex, ['Gemini'], 6)], agentsOf), ['Claude', 'Codex', 'Gemini']);
    assert.equal(loopAgents([...held, say(wassim)], agentsOf), undefined);
    assert.equal(loopWords(['Claude', 'Codex']), "Claude and Codex have gone back and forth here; they'll wait for a person before tagging each other again.");
    assert.equal(heldWords(5), 'agents have gone back and forth here 5 times, so wait for a person before replying');
  });

  it('tells the agent posting whom it asked, or that the guard holds it', () => {
    assert.equal(sentNote(say(claude, ['Codex']), agentsOf), 'Codex reads it as asked of it; its reply comes through your updates.');
    assert.equal(sentNote(say(claude, ['Codex', 'Gemini']), agentsOf), 'Codex and Gemini read it as asked of them; their replies come through your updates.');
    assert.match(sentNote(say(claude, ['Codex'], 5), agentsOf)!, /^Agents have gone back and forth here 5 times since a person last wrote, so it doesn't ask Codex or wake it\. Wait for a person/);
    assert.equal(sentNote(say(claude), agentsOf), undefined);
    assert.equal(sentNote(say(wassim, ['Codex']), agentsOf), undefined);
  });
});

describe('the loop guard in the store', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-agent-talk-'));
    store = new Store(dir);
    store.load();
    store.presentAgents = () => ['Claude', 'Codex', 'Gemini'];
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  function setUp() {
    const board = store.createBoard({ title: 'Agents' }, wassim);
    const [task] = store.planTasks(board.id, [{ title: 'Split the store' }], wassim, { ready: true });
    return { boardId: board.id, task };
  }
  const last = (task: Task) => store.getTask(task.id).task.comments.at(-1)!;
  const bounce = (task: Task, times: number) => {
    for (let i = 0; i < times; i++) store.addTaskComment(task.id, i % 2 ? '@Claude done, over to you' : '@Codex can you check the next part?', i % 2 ? codex : claude);
  };

  it('holds the fifth agent-to-agent mention on a card, still posted and still a mention, until a person writes there', () => {
    const { boardId, task } = setUp();
    store.addTaskComment(task.id, '@Claude note to self: check the shim', claude);
    assert.equal(last(task).mentions, undefined, 'an agent never mentions itself');
    bounce(task, 4);
    assert.equal(last(task).held, undefined);
    store.addTaskComment(task.id, '@Codex and one more thing', claude);
    assert.deepEqual(last(task).mentions, ['Codex'], 'it still mentions Codex');
    assert.equal(last(task).held, 5);
    assert.equal(eventsOf(store, boardId).at(-1)!.held, true);
    assert.deepEqual(eventsOf(store, boardId).at(-1)!.mentions, ['Codex']);
    store.addTaskComment(task.id, '@Codex and another', claude);
    assert.equal(last(task).held, 6);

    store.addTaskComment(task.id, 'Thanks both, carry on.', wassim);
    store.addTaskComment(task.id, '@Codex picking it up again', claude);
    assert.equal(last(task).held, undefined, "a person's message resets it");
    assert.equal(eventsOf(store, boardId).at(-1)!.held, undefined);
  });

  it('holds a thread, a decision and a pin on the board context alike', () => {
    const { boardId } = setUp();
    const thread = store.startThread(boardId, '@Codex can you look at the licences?', claude);
    for (let i = 0; i < 3; i++) store.postToThread(thread.id, i % 2 ? '@Codex again' : '@Claude back to you', i % 2 ? claude : codex);
    store.postToThread(thread.id, '@Claude one more', codex);
    assert.equal(store.getThread(thread.id).thread.messages.at(-1)!.held, 5);
    assert.equal(eventsOf(store, boardId).at(-1)!.held, true);

    const decision = store.postDecision(boardId, { question: 'Which store?', options: [{ label: 'SQLite' }, { label: 'Files' }] }, claude);
    for (let i = 0; i < 5; i++) store.addComment(decision.id, i % 2 ? '@Claude yes' : '@Codex agree?', i % 2 ? codex : claude);
    assert.deepEqual(store.getDecision(decision.id).decision.comments.map((c) => c.held), [undefined, undefined, undefined, undefined, 5]);
  });

  it('wakes a waiting agent at once for another agent asking it, and not for a held one', async () => {
    const { boardId, task } = setUp();
    let start = performance.now();
    let waiting = store.waitForEvents(boardId, store.getBoard(boardId).seq, { timeoutMs: 5000, exclude: codex });
    store.addTaskComment(task.id, '@Codex can you check the diff?', claude);
    const events = await waiting;
    const asked = performance.now() - start;
    assert.equal(events.length, 1);
    assert.ok(asked >= MESSAGE_SETTLE_MS - 5 && asked < BURST_SETTLE_MS - 250, `${Math.round(asked)} ms: as soon as a person's`);

    bounce(task, 3); // four in a row now
    const since = store.getBoard(boardId).seq;
    start = performance.now();
    waiting = store.waitForEvents(boardId, since, { timeoutMs: 1200, exclude: codex });
    store.addTaskComment(task.id, '@Codex one more', claude);
    const held = await waiting;
    assert.ok(performance.now() - start >= 1150, 'the held one wakes no one: the wait runs its course');
    assert.deepEqual(held.map((e) => e.held), [true], 'and brings it once it ends');
  });

  it("leaves the agent asked its 👀 on another agent's message, not on a plain or a held one", () => {
    const { boardId, task } = setUp();
    const since = store.getBoard(boardId).seq;
    store.addTaskComment(task.id, 'Starting on the shim.', claude);
    store.addTaskComment(task.id, '@Codex can you check the diff?', claude);
    store.seeComments(boardId, codex, store.eventsSince(boardId, since, codex));
    const comments = store.getTask(task.id).task.comments;
    assert.equal(comments[0].reactions, undefined, 'not on a plain one');
    assert.deepEqual(comments[1].reactions?.map((r) => [r.emoji, r.by.name]), [['👀', 'Codex']]);
    assert.equal(store.seeComments(boardId, claude, store.eventsSince(boardId, since, claude)), 0, 'nor its own');

    bounce(task, 4);
    const before = store.getBoard(boardId).seq;
    store.addTaskComment(task.id, '@Codex one more', claude);
    store.seeComments(boardId, codex, store.eventsSince(boardId, before, codex));
    assert.equal(last(task).reactions, undefined, 'nor on a held one');
  });

  it('tags a held comment in get_task as a mention, not an ask', () => {
    const { task } = setUp();
    bounce(task, 5);
    const board = store.getTask(task.id).board;
    const comments = store.getTask(task.id).task.comments;
    assert.equal(mentionTag(board, comments[3], 'Claude'), ' (asks you)');
    assert.equal(mentionTag(board, comments[4], 'Codex'), ' (mentions you; agents have gone back and forth here 5 times, so wait for a person before replying)');
    assert.equal(mentionTag(board, comments[4], 'Gemini'), ' (for Codex: not for you)');
  });
});

describe('what wakes a wait', () => {
  const event = (fields: Partial<BoardEvent>): BoardEvent => ({ seq: 1, at: '2026-11-03T12:00:00Z', actor: claude, type: 'comment_added', summary: 'commented', ...fields });

  it("wakes an agent for another agent's message, at once when it asks it, and never for a held one", () => {
    assert.ok(wakes(event({ mentions: ['Codex'] }), codex));
    assert.ok(!wakes(event({ mentions: ['Codex'] }), claude), 'not its own');
    assert.ok(!wakes(event({ mentions: ['Codex'], held: true }), codex), 'not a held one');
    assert.ok(!wakes(event({ mentions: ['Codex'], held: true }), { kind: 'agent', name: 'Gemini' }), 'for any agent');
    assert.equal(settleAfter(event({ mentions: ['Codex'] }), codex), MESSAGE_SETTLE_MS);
    assert.equal(settleAfter(event({ mentions: ['Codex'] }), { kind: 'agent', name: 'Gemini' }), BURST_SETTLE_MS, 'not for the agent it names');
    assert.equal(settleAfter(event({ actor: wassim })), MESSAGE_SETTLE_MS);
    assert.equal(settleAfter(event({ type: 'canvas_changed', mentions: ['Codex'] }), codex), BURST_SETTLE_MS);
  });
});

describe('the line under an agent message to another agent', () => {
  const NOW = Date.parse('2026-11-03T12:00:00Z');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const task = { id: 't1', number: 5, status: 'in_progress', claimedBy: claude, comments: [] } as unknown as Task;
  const board = {
    activity: { actors: [{ actor: wassim, at: ago(60_000) }, { actor: claude, at: ago(30_000) }, { actor: codex, at: ago(90_000) }], done: {}, reviewSentAt: {} },
    tasks: [task],
    decisions: [],
  } as unknown as Board;
  const said = (fields: { mentions?: string[]; reactions?: Reaction[]; held?: number } = {}) => ({ id: 'c1', author: claude, at: ago(12_000), ...fields });
  const listening = (name: string, fields: Partial<AgentNow> = {}): AgentNow => ({ name, state: 'listening', lastSeen: ago(1_000), ...fields });
  const line = (input: Partial<DeliveryInput> & Pick<DeliveryInput, 'said'>) => {
    const delivery = deliveryOf({ board, where: { task }, after: [], agents: [], steps: [], ...input });
    return delivery && deliveryWords(delivery, NOW);
  };

  it('is for the agents it names, and none for its plain or held messages', () => {
    assert.deepEqual(meantFor(board, { task }, { author: claude, mentions: ['Codex'] }), ['Codex']);
    assert.equal(meantFor(board, { task }, { author: claude }), undefined, "not the task's agent, nor any agent");
    assert.equal(meantFor(board, { task }, { author: claude, mentions: ['Wassim'] }), undefined, 'for a person only');
    assert.equal(meantFor(board, { task }, { author: claude, mentions: ['Codex'], held: 5 }), undefined, 'held');
  });

  it('says what became of it, as under a person\'s message, until the agent it asks replies', () => {
    const asks = said({ mentions: ['Codex'] });
    const both = [listening('Claude'), listening('Codex')];
    assert.equal(line({ said: asks, agents: both }), 'Delivered · Codex is listening');
    assert.equal(line({ said: said({ mentions: ['Codex'], reactions: [{ emoji: '👀', by: codex, at: ago(5_000) }] }), agents: both }), 'Seen by Codex');
    assert.equal(line({ said: asks, agents: [listening('Codex', { state: 'working', focus: { kind: 'task', id: 't1' } })] }), 'Codex is taking a look');
    assert.equal(line({ said: asks, agents: both, after: [{ author: claude }] }), 'Delivered · Codex is listening', 'its own next message is no reply');
    assert.equal(line({ said: asks, agents: both, after: [{ author: codex }] }), undefined, "Codex's reply takes its place");
    assert.equal(line({ said: said({ mentions: ['Codex'], held: 5 }), agents: both }), undefined, 'none under a held one');
    assert.equal(line({ said: said(), agents: both }), undefined, 'none under a plain one');
  });
});
