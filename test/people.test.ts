import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { boardDigest, decisionDetail } from '../src/core/digest';
import { peopleOn } from '../src/core/format';
import { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import { eventsOf } from './tables';
import { removeScratch } from './platform';

const agent: Actor = { kind: 'agent', name: 'planner' };
const sam: Actor = { kind: 'human', name: 'Sam' };
const alex: Actor = { kind: 'human', name: 'Alex' };

describe('Asking people', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-people-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Queues' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  const post = (extra = {}) =>
    store.postDecision(boardId, { question: 'Which queue?', options: [{ label: 'SQS' }, { label: 'Kafka' }], ...extra }, agent);

  it('waits for the people asked until they weigh in', () => {
    const decision = post({ ask: ['Alex', 'alex', 'Sam'], askNote: 'You run the brokers' });
    assert.deepEqual(decision.asks.map((a) => a.name), ['Alex', 'Sam'], 'names dedupe case-insensitively');
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /asked Alex and Sam about #1 "Which queue\?": "You run the brokers"/);
    assert.throws(() => store.askPeople(decision.id, ['ALEX'], undefined, agent), /already being waited on/);

    store.addComment(decision.id, 'agent chatter', agent);
    store.addComment(decision.id, 'Kafka, we already run it', { kind: 'human', name: 'alex' });
    assert.ok(decision.asks[0].answeredAt, "Alex's comment answers Alex");
    assert.equal(decision.asks[1].answeredAt, undefined, 'Sam is still waited on');
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /\(answering an ask from planner\)$/);

    store.unask(decision.id, 'sam', alex);
    assert.equal(decision.asks.length, 1);
    assert.throws(() => store.unask(decision.id, 'Sam', alex), /Nobody named "Sam" is being waited on/);
  });

  it('stamps asks with their event\'s exact time, so "asked of you" always matches', () => {
    const decision = post({ ask: ['Alex'] });
    const asked = eventsOf(store, boardId).find((e) => e.type === 'decision_asked' && e.decisionId === decision.id)!;
    assert.equal(decision.asks[0].at, asked.at);
    const later = store.askPeople(decision.id, ['Sam'], undefined, agent);
    assert.equal(later.asks.at(-1)!.at, eventsOf(store, boardId).at(-1)!.at);
  });

  it('posts nothing when its asks or criteria are invalid', () => {
    const before = store.getBoard(boardId);
    const [events, decisions] = [eventsOf(store, before).length, before.decisions.length];
    assert.throws(() => post({ ask: Array.from({ length: 11 }, (_, i) => `Person ${i}`) }), /at most 10 people/);
    assert.throws(() => post({ criteria: [{ label: 'x'.repeat(121) }] }), /criterion/i);
    assert.throws(() => post({ criteria: Array.from({ length: 13 }, (_, i) => ({ label: `Criterion ${i}` })) }), /at most 12/);
    const after = store.getBoard(boardId);
    assert.equal(after.decisions.length, decisions, 'no half-posted card');
    assert.equal(eventsOf(store, after).length, events, 'nothing logged');
    assert.equal(post({ criteria: [{ label: 'Cost' }], ask: ['Alex'] }).number, 1, 'numbering is not used up by failed posts');
  });

  it('only asks about decisions that are still open to input', () => {
    const decision = post();
    store.resolve(decision.id, { optionId: 'b' }, sam);
    assert.throws(() => store.askPeople(decision.id, ['Alex'], undefined, agent), /is decided; reopen it/);
    const provisional = post();
    store.resolve(provisional.id, { optionId: 'a', provisional: true }, agent);
    store.askPeople(provisional.id, ['Sam'], 'confirm?', agent); // asking someone to confirm an agent's call is fine
    store.resolve(provisional.id, { optionId: 'a' }, sam);
    assert.ok(provisional.asks[0].answeredAt);
  });

  it('lists the people who have acted on a board, most recent first', () => {
    const decision = post();
    store.addComment(decision.id, 'one', alex);
    store.addComment(decision.id, 'two', sam);
    assert.deepEqual(peopleOn(store.getBoard(boardId)).map((p) => p.name), ['Sam', 'Alex']);
    assert.match(boardDigest(store.getBoard(boardId)), /People: Sam, Alex/);
  });
});

describe('Criteria', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-criteria-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Retry' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  it('lets agents propose criteria but only people mark them', () => {
    const decision = store.postDecision(
      boardId,
      { question: 'Strategy?', options: [{ label: 'Options object' }, { label: 'Wrapper' }], criteria: [{ label: 'No silent change' }] },
      agent,
    );
    store.proposeCriteria(decision.id, [{ label: 'no SILENT change' }, { label: 'Small diff', description: 'under 200 lines' }], agent);
    assert.deepEqual(decision.criteria.map((c) => [c.id, c.label]), [['c1', 'No silent change'], ['c2', 'Small diff']]);

    assert.throws(() => store.mark(decision.id, 'c1', 'a', 'yes', agent), /Only people mark criteria/);
    assert.throws(() => store.removeCriterion(decision.id, 'c1', agent), /Only people remove criteria/);

    store.mark(decision.id, 'c1', 'a', 'yes', sam);
    store.mark(decision.id, 'c1', 'b', 'partly', sam);
    store.mark(decision.id, 'c1', 'b', 'no', alex); // replaces, attributed to Alex
    store.mark(decision.id, 'c2', 'a', 'yes', sam);
    store.mark(decision.id, 'c2', 'a', null, sam); // clears
    assert.deepEqual(decision.marks.map((m) => [m.criterionId, m.optionId, m.value, m.by.name]), [
      ['c1', 'a', 'yes', 'Sam'],
      ['c1', 'b', 'no', 'Alex'],
    ]);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /cleared the mark for a\) Options object on "Small diff"/);

    const detail = decisionDetail(store.getBoard(boardId), decision);
    assert.match(detail, /\| criterion \| a\) Options object \| b\) Wrapper \|/);
    assert.match(detail, /\| No silent change \[c1\] \| yes \(Sam\) \| no \(Alex\) \|/);
    assert.match(detail, /\| Small diff — under 200 lines \[c2\] \| · \| · \|/);

    store.removeCriterion(decision.id, 'c1', sam);
    assert.equal(decision.marks.length, 0, 'marks go with their criterion');
    store.proposeCriteria(decision.id, [{ label: 'Opt-out per call' }], sam);
    assert.equal(decision.criteria.at(-1)!.id, 'c3', 'ids are never reused');
  });

  it("stops agents adding criteria once a person has decided", () => {
    const decision = store.postDecision(boardId, { question: 'Q?', options: [{ label: 'a' }, { label: 'b' }] }, agent);
    store.resolve(decision.id, { optionId: 'a' }, sam);
    assert.throws(() => store.proposeCriteria(decision.id, [{ label: 'late' }], agent), /can't add criteria to it/);
    assert.throws(() => store.mark(decision.id, 'c9', 'a', 'yes', sam), /has no criterion "c9"/);
  });
});
