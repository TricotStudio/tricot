import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BoardError, Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import { savedBoard } from './savedBoard';

const agent: Actor = { kind: 'agent', name: 'claude' };
const human: Actor = { kind: 'human', name: 'Wassim' };

describe('Store', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-test-'));
    store = new Store(dir);
    store.load();
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  function boardWithDecision() {
    const board = store.createBoard({ title: 'Retry logic', goal: 'Make API calls resilient' }, human);
    const decision = store.postDecision(
      board.id,
      {
        question: 'Which retry strategy?',
        options: [{ label: 'Options object' }, { label: 'Wrapper function' }, { label: 'Client policy' }],
        recommend: 'a',
        blocking: true,
      },
      agent,
    );
    return { board, decision };
  }

  it('letters options, numbers decisions and slugs board ids', () => {
    const { board, decision } = boardWithDecision();
    assert.match(board.id, /^retry-logic-[a-z2-9]{4}$/);
    assert.equal(decision.number, 1);
    assert.deepEqual(decision.options.map((o) => o.id), ['a', 'b', 'c']);
    assert.equal(decision.recommendation?.optionId, 'a');
    assert.equal(decision.status, 'open');
  });

  it('rejects recommending an option that does not exist', () => {
    const board = store.createBoard({ title: 'B' }, human);
    assert.throws(
      () => store.postDecision(board.id, { question: 'Q?', options: [{ label: 'x' }], recommend: 'c' }, agent),
      BoardError,
    );
  });

  it('requires exactly one of optionId or answer when resolving', () => {
    const { decision } = boardWithDecision();
    assert.throws(() => store.resolve(decision.id, {}, human), /exactly one/);
    assert.throws(() => store.resolve(decision.id, { optionId: 'a', answer: 'both' }, human), /exactly one/);
    assert.throws(() => store.resolve(decision.id, { optionId: 'z' }, human), /no option "z"/);
  });

  it('moves through statuses and clears stale state', () => {
    const { decision } = boardWithDecision();
    store.requestExploration(decision.id, 'prototype a and b', human);
    assert.equal(decision.status, 'exploring');
    assert.equal(decision.exploreRequest?.text, 'prototype a and b');

    store.resolve(decision.id, { optionId: 'b', rationale: 'smallest blast radius', provisional: true }, human);
    assert.equal(decision.status, 'provisional');
    assert.equal(decision.exploreRequest, undefined);

    store.reopen(decision.id, human);
    assert.equal(decision.status, 'open');
    assert.equal(decision.resolution, undefined);
    assert.throws(() => store.reopen(decision.id, human), /already open/);

    store.defer(decision.id, 'after launch', human);
    assert.equal(decision.status, 'deferred');
  });

  it('logs attributed events and filters out the caller', () => {
    const { board, decision } = boardWithDecision();
    store.resolve(decision.id, { optionId: 'a', rationale: 'covers all call sites' }, human);

    const all = store.eventsSince(board.id, 0);
    assert.deepEqual(all.map((e) => e.type), ['board_created', 'decision_posted', 'decision_resolved']);
    assert.match(all[2].summary, /decided #1 "Which retry strategy\?" → a\) Options object because "covers all call sites"/);

    const forAgent = store.eventsSince(board.id, 0, agent);
    assert.deepEqual(forAgent.map((e) => e.actor.name), ['Wassim', 'Wassim']);
  });

  it('wakes a waiting agent when a human acts, ignoring its own events', async () => {
    const { board, decision } = boardWithDecision();
    const since = board.seq;
    const waiting = store.waitForEvents(board.id, since, { timeoutMs: 5000, exclude: agent, settleMs: 10 });

    store.addComment(decision.id, 'agent talking to itself', agent);
    store.resolve(decision.id, { optionId: 'c' }, human);

    const events = await waiting;
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'decision_resolved');
  });

  it('returns an empty list when the wait times out', async () => {
    const { board } = boardWithDecision();
    const events = await store.waitForEvents(board.id, board.seq, { timeoutMs: 20, exclude: agent });
    assert.deepEqual(events, []);
  });

  it('persists boards and reloads them', async () => {
    const { board, decision } = boardWithDecision();
    store.attachFinding(decision.id, { optionId: 'a', summary: 'All 60 call sites covered', metrics: { 'call sites': 60 } }, agent);
    await store.flush();

    assert.equal(savedBoard(dir, board.id).decisions[0].findings[0].metrics?.['call sites'], 60);

    const reloaded = new Store(dir);
    reloaded.load();
    assert.equal(reloaded.getDecision(decision.id).decision.question, 'Which retry strategy?');
    assert.equal(reloaded.getBoard(board.id).seq, board.seq);
  });

  it('validates dependencies', () => {
    const { board, decision } = boardWithDecision();
    assert.throws(() => store.postDecision(board.id, { question: 'Q?', dependsOn: ['nope'] }, agent), /No decision "nope"/);
    const second = store.postDecision(board.id, { question: 'Backoff curve?', dependsOn: [decision.id] }, agent);
    assert.deepEqual(second.dependsOn, [decision.id]);
    assert.throws(() => store.updateDecision(second.id, { dependsOn: [second.id] }, agent), /itself/);
  });
});
