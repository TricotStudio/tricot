import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { decisionAdvice, findingAdvice, noteAdvice } from '../src/core/advice';
import { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';

const agent: Actor = { kind: 'agent', name: 'planner' };
const sam: Actor = { kind: 'human', name: 'Sam' };
const alex: Actor = { kind: 'human', name: 'Alex' };

describe('Decision integrity', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-integrity-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Queues' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = () =>
    store.postDecision(boardId, { question: 'Which queue?', options: [{ label: 'SQS' }, { label: 'Kafka' }] }, agent);

  it('lets agents refine open and exploring decisions', () => {
    const decision = post();
    store.updateDecision(decision.id, { context: 'Throughput matters most.' }, agent);
    store.requestExploration(decision.id, 'benchmark both', sam);
    store.updateDecision(decision.id, { addOptions: [{ label: 'NATS' }], recommend: 'c' }, agent);
    assert.equal(decision.options.length, 3);
  });

  it("stops agents changing what a human settled, but not planning metadata", () => {
    const decision = post();
    store.resolve(decision.id, { optionId: 'b' }, sam);
    assert.throws(() => store.updateDecision(decision.id, { question: 'Which queue now?' }, agent), /Sam decided #1 "Which queue\?", so agents can't reword it/);
    assert.throws(() => store.updateDecision(decision.id, { addOptions: [{ label: 'NATS' }] }, agent), /can't reword it or change its options/);
    assert.throws(() => store.resolve(decision.id, { optionId: 'a', provisional: true }, agent), /can't answer it/);
    store.updateDecision(decision.id, { blocking: true, addOptions: [] }, agent);
    store.updateDecision(decision.id, { addOptions: [{ label: 'NATS' }] }, alex); // humans may

    const deferred = post();
    store.defer(deferred.id, 'after launch', sam);
    assert.throws(() => store.resolve(deferred.id, { optionId: 'a', provisional: true }, agent), /Sam deferred/);
  });

  it("lets an agent revise its own provisional call", () => {
    const decision = post();
    store.resolve(decision.id, { optionId: 'a', provisional: true }, agent);
    store.resolve(decision.id, { optionId: 'b', provisional: true }, agent);
    assert.equal(decision.resolution?.optionId, 'b');
    assert.equal(decision.history[0].ended, 'replaced');
  });

  it('keeps every earlier answer, with how and by whom it ended', () => {
    const decision = post();
    store.resolve(decision.id, { optionId: 'a', provisional: true, rationale: 'cheapest' }, agent);
    store.resolve(decision.id, { optionId: 'a' }, sam); // confirm
    store.reopen(decision.id, alex);
    store.resolve(decision.id, { optionId: 'b', rationale: 'already run it' }, alex);
    store.requestExploration(decision.id, 'measure lag', sam);

    assert.deepEqual(
      decision.history.map((h) => [h.status, h.optionId, h.by.name, h.ended, h.endedBy.name]),
      [
        ['provisional', 'a', 'planner', 'confirmed', 'Sam'],
        ['decided', 'a', 'Sam', 'reopened', 'Alex'],
        ['decided', 'b', 'Alex', 'explore', 'Sam'],
      ],
    );
    assert.equal(decision.history[0].rationale, 'cheapest');
  });
});

describe('Block revisions', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-rev-'));
    store = new Store(dir);
    store.load();
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('bumps on content changes only, and refuses stale writes', () => {
    const boardId = store.createBoard({ title: 'B' }, sam).id;
    const note = store.addBlock({ boardId }, { content: { type: 'note', text: 'v1' } }, agent);
    assert.equal(note.rev, 1);

    store.moveItems({ boardId }, [{ id: note.id, x: 500, y: 500 }], sam);
    store.updateBlock(note.id, { text: 'v1' }, sam, 1); // no-op
    assert.equal(note.rev, 1, 'moves and no-op edits keep the rev');

    store.updateBlock(note.id, { text: 'v2' }, sam, 1);
    assert.equal(note.rev, 2);
    assert.throws(
      () => store.updateBlock(note.id, { text: 'agent v2' }, agent, 1),
      (error: Error & { code?: string }) =>
        error.code === 'conflict' && /it is now rev 2, last edited by Sam \(human\)/.test(error.message),
    );
    assert.equal(note.type === 'note' && note.text, 'v2');
  });
});

describe('Legibility advice', () => {
  it('flags long context, missing options and missing recommendations', () => {
    assert.deepEqual(decisionAdvice({ context: 'short', options: [{ label: 'a' }, { label: 'b' }], recommend: 'a' }), []);
    const advice = decisionAdvice({ context: 'w '.repeat(500), options: [] });
    assert.match(advice[0], /500 words \(about 2 minutes to read\)/);
    assert.match(advice[1], /no options/);
    assert.match(decisionAdvice({ options: Array.from({ length: 6 }, (_, i) => ({ label: `${i}` })), recommend: '0' })[0], /6 options/);
    assert.equal(noteAdvice('w '.repeat(150)).length, 0);
    assert.match(noteAdvice('w '.repeat(260))[0], /260 words/);
  });

  it('asks for matching metric names across options', () => {
    const decision = {
      findings: [{ id: 'f', optionId: 'a', author: agent, summary: 's', metrics: { 'p95 latency': '1.8s', 'files touched': 12 }, createdAt: '' }],
    } as never;
    assert.match(findingAdvice(decision, { optionId: 'b', summary: 's' })[0], /Report the same metrics for option b/);
    const partial = findingAdvice(decision, { optionId: 'b', summary: 's', metrics: { 'p95 latency': '2s', latency: '2s' } });
    assert.match(partial[0], /missing "files touched"/);
    assert.match(partial[1], /"latency" won't line up/);
    assert.deepEqual(findingAdvice(decision, { optionId: 'a', summary: 's', metrics: { anything: 1 } }), []);
  });
});
