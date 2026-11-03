import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { decisionNeedsYou, needsInput } from '../src/core/attention';
import { boardDigest, decisionDetail, eventsDigest } from '../src/core/digest';
import { driftAge, driftChanges, driftOf } from '../src/core/freshness';
import { Store } from '../src/core/store';
import type { Actor, Decision } from '../src/core/types';
import { eventsOf } from './tables';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const wassim: Actor = { kind: 'human', name: 'Wassim' };
const DAY = 86_400_000;

describe('Morphable decisions', () => {
  let dir: string;
  let store: Store;
  let boardId: string;
  let decision: Decision;

  const events = () => eventsOf(store, boardId);
  const lastSummary = () => events().at(-1)!.summary;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-refresh-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Retry logic' }, wassim).id;
    decision = store.postDecision(
      boardId,
      {
        question: 'Which retry strategy should the API client use?',
        options: [{ label: 'Options object' }, { label: 'Wrapper function' }, { label: 'Client-level policy' }],
        recommend: 'c',
      },
      claude,
    );
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets a person ask agents to refresh the options, and an agent finish it with what changed', () => {
    assert.throws(() => store.requestRefresh(decision.id, undefined, claude), /Only people ask for a refresh/);
    store.requestRefresh(decision.id, 'Re-check now that #5 put config per environment', wassim);
    assert.equal(decision.refreshRequest?.by.name, 'Wassim');
    assert.equal(lastSummary(), `asked agents to refresh the options of #1 "Which retry strategy should the API client use?": "Re-check now that #5 put config per environment"`);
    assert.match(boardDigest(store.getBoard(boardId)), /Refresh requested on #1 \[id: \w+\] by Wassim \("Re-check now .+"\): re-check each/);
    assert.match(decisionDetail(store.getBoard(boardId), decision), /## Refresh requested\nBy Wassim \(human\) at \S+: "Re-check now .+"\nRe-check this card .+ pass refreshed: true/);
    assert.throws(() => store.updateDecision(decision.id, { refreshed: true }, wassim), /Agents finish a refresh/);

    store.updateDecision(
      decision.id,
      {
        reviseOptions: [{ id: 'c', outdated: true, reason: 'global config was dropped' }],
        addOptions: [{ label: 'Per-environment policy' }],
        recommend: 'd',
        refreshed: true,
        note: 'Config is per environment now, so a global policy no longer fits.',
      },
      claude,
    );
    assert.equal(decision.refreshRequest, undefined);
    assert.deepEqual(decision.refreshed?.changes, ['c outdated (global config was dropped)', 'd added', 'recommends d']);
    assert.equal(decision.refreshed?.requestedBy?.name, 'Wassim');
    assert.equal(
      lastSummary(),
      `refreshed #1 "Which retry strategy should the API client use?" (answering Wassim's request): c outdated (global config was dropped), d added, recommends d; note: "Config is per environment now, so a global policy no longer fits."`,
    );
    assert.equal(events().at(-1)!.type, 'refresh_finished');
    assert.match(decisionDetail(store.getBoard(boardId), decision), /## Last refreshed\nBy Claude \(agent\) at \S+, asked by Wassim: c outdated .+, d added, recommends d\. Note: Config/);
    // The asker is told, as an answer to them.
    assert.ok(needsInput(events().at(-1)!, store.getBoard(boardId), 'Wassim'));
    assert.ok(decisionNeedsYou(decision, store.getBoard(boardId), 'Wassim', [events().at(-1)!]));
    assert.ok(!needsInput(events().at(-1)!, store.getBoard(boardId), 'Sam'));

    // Unasked, an agent can re-check a card too; "no changes" is an answer.
    store.updateDecision(decision.id, { refreshed: true, note: 'Still holds' }, claude);
    assert.deepEqual(decision.refreshed?.changes, []);
    assert.match(lastSummary(), /^refreshed #1 ".+": no changes, the options still hold; note: "Still holds"$/);

    // A person can cancel a request they no longer need.
    store.requestRefresh(decision.id, undefined, wassim);
    store.cancelRefresh(decision.id, wassim);
    assert.equal(decision.refreshRequest, undefined);
    assert.equal(lastSummary(), 'cancelled the refresh of #1 "Which retry strategy should the API client use?"');
    store.requestRefresh(decision.id, undefined, wassim);
    store.resolve(decision.id, { optionId: 'a' }, wassim);
    assert.equal(decision.refreshRequest, undefined, 'answering it ends the request');
    assert.throws(() => store.updateDecision(decision.id, { refreshed: true, note: 'x', question: 'Reworded?' }, claude), /Wassim decided #1 .+ so agents can't reword it/);
  });

  it('lets a person ask agents to check a settled card still holds, which leaves it as it is', () => {
    store.resolve(decision.id, { optionId: 'b' }, wassim);
    store.requestRefresh(decision.id, '#2 was just decided: b) Per environment. It may change this one: check it still holds.', wassim);
    assert.equal(decision.status, 'decided');
    assert.match(lastSummary(), /^asked agents to check #1 ".+" still holds: "#2 was just decided/);
    const detail = decisionDetail(store.getBoard(boardId), decision);
    assert.match(detail, /## Refresh requested\nBy Wassim \(human\) at \S+: "#2 was just decided.+"\nIt is decided \(b\) Wrapper function\) and stays so: check its answer still holds/);
    assert.match(boardDigest(store.getBoard(boardId)), /Wassim asked agents to check it still holds: "#2 .+" \(re-check it, then update_decision with refreshed: true and a note\)/);

    // An agent answers with a note alone: the card, its options and its answer stay as they were.
    assert.throws(() => store.updateDecision(decision.id, { refreshed: true }, claude), /Say in note whether #1 .+ still holds/);
    assert.throws(
      () => store.updateDecision(decision.id, { refreshed: true, note: 'Holds', addOptions: [{ label: 'Another' }] }, claude),
      /Wassim decided #1 .+ so agents can't reword it/,
    );
    assert.throws(() => store.updateDecision(decision.id, { refreshed: true, note: 'Holds' }, wassim), /Agents finish a refresh/);
    store.updateDecision(decision.id, { refreshed: true, note: 'Still holds: the wrapper reads config per environment.' }, claude);
    assert.equal(decision.refreshRequest, undefined);
    assert.equal(decision.status, 'decided');
    assert.equal(decision.resolution?.optionId, 'b');
    assert.equal(decision.options.length, 3);
    assert.deepEqual(decision.refreshed?.changes, []);
    assert.equal(decision.refreshed?.requestedBy?.name, 'Wassim');
    assert.match(lastSummary(), /^refreshed #1 ".+" \(answering Wassim's request\): it stays decided \(b\) Wrapper function\); note: "Still holds: .+"$/);

    // Deferred and retired cards aren't refreshed.
    store.defer(decision.id, undefined, wassim);
    assert.throws(() => store.requestRefresh(decision.id, undefined, wassim), /is deferred; only open, exploring, decided and provisional cards are refreshed/);
  });

  it("keeps outdated options on the card, but they can't be picked or recommended", () => {
    store.updateDecision(decision.id, { reviseOptions: [{ id: 'c', outdated: true, reason: 'global config was dropped' }] }, claude);
    const c = decision.options.find((o) => o.id === 'c')!;
    assert.deepEqual([c.outdated?.reason, c.outdated?.by.name], ['global config was dropped', 'Claude']);
    assert.equal(decision.options.length, 3, 'nothing is deleted');
    assert.equal(decision.recommendation, undefined, 'the recommendation went with it');
    assert.match(lastSummary(), /revised #1 .+: marked c outdated \("global config was dropped"\), cleared the recommendation \(c is outdated\)$/);

    assert.throws(() => store.resolve(decision.id, { optionId: 'c' }, wassim), /Option c\) of #1 .+ is outdated \("global config was dropped"\), so it can't be picked/);
    assert.throws(() => store.resolve(decision.id, { optionId: 'c', provisional: true }, claude), /can't be picked/);
    assert.throws(() => store.updateDecision(decision.id, { recommend: 'c' }, claude), /Cannot recommend c\): it is outdated/);
    assert.throws(() => store.updateDecision(decision.id, { reviseOptions: [{ id: 'b', outdated: true }] }, claude), /Say why option b\) no longer applies/);
    assert.match(decisionDetail(store.getBoard(boardId), decision), /### c\) Client-level policy\nOUTDATED \(can't be picked\), marked by Claude \(agent\) at \S+: "global config was dropped"/);
    assert.match(boardDigest(store.getBoard(boardId)), /options: a\) Options object, b\) Wrapper function, c\) Client-level policy \(outdated\)/);

    // Marks and findings on it stay, marked as outdated.
    store.proposeCriteria(decision.id, [{ label: 'No silent behaviour change' }], claude);
    store.mark(decision.id, 'c1', 'c', 'yes', wassim);
    store.attachFinding(decision.id, { optionId: 'c', summary: 'Covered every call site', metrics: { sites: 60 } }, claude);
    const detail = decisionDetail(store.getBoard(boardId), decision);
    assert.match(detail, /\| c\) Client-level policy \(outdated\) \|/);
    assert.match(detail, /yes \(Wassim\)/);
    assert.match(detail, /Claude \(agent\) \[option c, now outdated\]: Covered every call site/);

    // It can be brought back, and picked again.
    store.updateDecision(decision.id, { reviseOptions: [{ id: 'c', outdated: false }] }, claude);
    assert.equal(c.outdated, undefined);
    assert.match(lastSummary(), /revised #1 .+: brought c back/);
    store.resolve(decision.id, { optionId: 'c' }, wassim);
  });

  it("lets people reword the card, keeps what it said before, and keeps agents off their options", () => {
    store.updateDecision(
      decision.id,
      {
        question: 'How should the API client retry?',
        context: 'Config is per environment now.',
        reviseOptions: [
          { id: 'b', label: 'Wrapper around fetch, behind a flag' },
          { id: 'c', outdated: true, reason: 'we dropped global config' },
        ],
        addOptions: [{ label: "Use the gateway's retries" }],
      },
      wassim,
    );
    assert.equal(
      lastSummary(),
      `revised #1 "How should the API client retry?": reworded the question (was "Which retry strategy should the API client use?"), added context, reworded b (was "Wrapper function"), marked c outdated ("we dropped global config"), added d) Use the gateway's retries, cleared the recommendation (c is outdated)`,
    );
    assert.equal(events().at(-1)!.type, 'decision_revised');
    assert.deepEqual(
      decision.revisions?.map((r) => [r.field, r.optionId, r.before, r.by.name]),
      [
        ['question', undefined, 'Which retry strategy should the API client use?', 'Wassim'],
        ['context', undefined, undefined, 'Wassim'],
        ['label', 'b', 'Wrapper function', 'Wassim'],
      ],
    );
    assert.match(decisionDetail(store.getBoard(boardId), decision), /## Earlier wording .+\n- question was "Which retry strategy .+"; changed by Wassim \(human\)[\s\S]+- b\) label was "Wrapper function"/);

    // Agents are told to re-check their recommendation.
    const since = events().length - 1;
    assert.match(
      eventsDigest(events().slice(since), store.getBoard(boardId).seq),
      new RegExp(`People changed what \\[id: ${decision.id}\\] offers: re-check your recommendation there`),
    );

    // b and d are Wassim's now; c's outdated mark is his too.
    assert.throws(() => store.updateDecision(decision.id, { reviseOptions: [{ id: 'b', label: 'Wrapper' }] }, claude), /Option b\) of #1 .+ is Wassim's \(they proposed or reworded it\), so agents can't change it/);
    assert.throws(() => store.updateDecision(decision.id, { reviseOptions: [{ id: 'd', outdated: true, reason: 'x' }] }, claude), /is Wassim's/);
    assert.throws(() => store.updateDecision(decision.id, { reviseOptions: [{ id: 'c', outdated: false }] }, claude), /Wassim marked option c\) outdated, so agents can't bring it back/);
    assert.match(decisionDetail(store.getBoard(boardId), decision), /### b\) Wrapper around fetch, behind a flag · Wassim's option/);
    store.updateDecision(decision.id, { reviseOptions: [{ id: 'a', description: 'Opt in per call with { retry }' }] }, claude);
    assert.match(lastSummary(), /revised #1 .+: revised a's description/);

    // A bad change leaves the card as it was.
    const before = structuredClone(decision);
    assert.throws(() => store.updateDecision(decision.id, { question: 'Changed?', reviseOptions: [{ id: 'z', label: 'x' }] }, wassim), /has no option "z"/);
    assert.throws(() => store.updateDecision(decision.id, { question: 'Changed?', addOptions: [{ label: 'New' }], recommend: 'c' }, wassim), /Cannot recommend c\): it is outdated/);
    assert.throws(() => store.updateDecision(decision.id, { context: 'Changed', addOptions: [{ label: ' ' }] }, wassim), /option label must not be empty/);
    assert.deepEqual(decision, before);
    store.updateDecision(decision.id, { addOptions: [{ label: 'Retry budget per client' }], recommend: 'e' }, wassim);
    assert.equal(decision.recommendation?.optionId, 'e', 'an option added in the same call can be recommended');
  });

  it('keeps the options of an answered card as they were answered, and earlier answers as they read', () => {
    store.resolve(decision.id, { optionId: 'b' }, wassim);
    assert.throws(() => store.updateDecision(decision.id, { reviseOptions: [{ id: 'b', label: 'Other' }] }, wassim), /is decided \(b\) Wrapper function\), so its options stay as they were answered\. Reopen it/);
    store.reopen(decision.id, wassim);
    store.updateDecision(decision.id, { reviseOptions: [{ id: 'b', label: 'Wrapper around fetch' }] }, wassim);
    assert.equal(decision.history[0].label, 'Wrapper function', 'the earlier answer keeps the wording that was chosen');
    assert.match(decisionDetail(store.getBoard(boardId), decision), /- decided b\) Wrapper function by Wassim \(human\); reopened by Wassim/);
  });

  it('retires a card as no longer relevant, marks work built on it stale, and brings it back', () => {
    store.resolve(decision.id, { optionId: 'a' }, wassim);
    const [task] = store.planTasks(boardId, [{ title: 'Add retry option', decisionIds: [decision.id] }], claude);

    assert.throws(() => store.retire(decision.id, 'Obsolete', claude), /Only people retire a decision/);
    assert.throws(() => store.retire(decision.id, '  ', wassim), /reason must not be empty/);
    store.retire(decision.id, 'The gateway retries for us now', wassim);
    assert.equal(decision.status, 'retired');
    assert.equal(decision.resolution, undefined);
    assert.deepEqual([decision.history[0].ended, decision.history[0].optionId], ['retired', 'a']);
    assert.equal(events().at(-2)!.summary, `retired #1 "Which retry strategy should the API client use?" as no longer relevant: "The gateway retries for us now"`);
    assert.match(task.stale?.reason ?? '', /#1 was retired by Wassim as no longer relevant/);
    assert.match(lastSummary(), /marked T1 stale/);

    // It leaves Open without counting as decided, and isn't answered while retired.
    const digest = boardDigest(store.getBoard(boardId));
    assert.match(digest, /## Retired: a person set these aside as no longer relevant; don't build on them \(1\)\n- #1 .+ — retired: "The gateway retries for us now"/);
    assert.doesNotMatch(digest, /## Open/);
    assert.deepEqual(store.listBoards()[0].counts, { open: 0, exploring: 0, provisional: 0, decided: 0, deferred: 0, retired: 1 });
    assert.throws(() => store.resolve(decision.id, { optionId: 'b' }, wassim), /is retired as no longer relevant\. Bring it back \(reopen it\) before deciding it/);
    assert.throws(() => store.updateDecision(decision.id, { question: 'Reworded?' }, claude), /Wassim retired #1 .+ so agents can't reword it/);
    assert.throws(() => store.planTasks(boardId, [{ title: 'More', decisionIds: [decision.id] }], claude), /is retired; tasks implement settled decisions/);
    assert.throws(() => store.retire(decision.id, 'again', wassim), /already retired/);
    store.addComment(decision.id, 'Agree, the gateway handles it', claude);

    store.reopen(decision.id, wassim);
    assert.equal(decision.status, 'open');
    assert.equal(decision.retirement, undefined);
    assert.equal(events().at(-2)!.summary, `brought back #1 "Which retry strategy should the API client use?", which was retired`);
    assert.match(task.stale?.reason ?? '', /#1 was brought back by Wassim/);
  });

  it('says a card may be out of date once it has waited and the board has moved on', () => {
    const other = store.postDecision(boardId, { question: 'Where does config live?', options: [{ label: 'Per environment' }] }, claude);
    store.updateDecision(decision.id, { dependsOn: [other.id] }, claude);
    const board = store.getBoard(boardId);
    decision.createdAt = decision.options[0].createdAt = decision.options[1].createdAt = decision.options[2].createdAt = ago(3);
    assert.equal(driftOf(board, decision), null, 'nothing has happened since');

    store.resolve(other.id, { optionId: 'a' }, wassim);
    const [task] = store.planTasks(boardId, [{ title: 'Move config', decisionIds: [other.id] }, { title: 'Chore' }], claude);
    store.claimTask(task.id, claude);
    store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'Done' } }, claude);
    store.updateTask(task.id, { status: 'done' }, claude);
    other.resolution!.at = task.doneAt = ago(2.5); // both since it was posted
    const drift = driftOf(board, decision)!;
    assert.deepEqual([drift.basis, drift.days], ['posted', 3]);
    assert.equal(`${driftAge(drift)}. Since then, ${driftChanges(drift)}.`, 'Posted 3 days ago. Since then, #2 was decided, and T1 was done.');
    assert.match(
      decisionDetail(board, decision),
      /May be out of date: posted 3 days ago, and since then #2 was decided, and T1 was done\. Re-check it against the app as it is now: refresh the options with update_decision \(refreshed: true\), or suggest retiring it in a comment\./,
    );
    assert.match(boardDigest(board), /- #1 .+\n  May be out of date: posted 3 days ago/);

    // Too recent to say, a refresh under way, or a card that isn't waiting: no note.
    assert.equal(driftOf(board, decision, Date.now() - 2 * DAY), null);
    store.requestRefresh(decision.id, undefined, wassim);
    assert.equal(driftOf(board, decision), null);
    store.cancelRefresh(decision.id, wassim);
    store.defer(decision.id, undefined, wassim);
    assert.equal(driftOf(board, decision), null);
    store.reopen(decision.id, wassim);

    // Refreshing it catches it up: only what happens after counts.
    store.updateDecision(decision.id, { refreshed: true }, claude);
    assert.equal(driftOf(board, decision), null);
    decision.refreshed!.at = ago(2);
    assert.equal(driftOf(board, decision), null, 'nothing settled since the refresh');
    task.doneAt = ago(1);
    assert.equal(`${driftAge(driftOf(board, decision)!)}`, 'Refreshed 2 days ago');

    // So does a person changing what it offers.
    store.updateDecision(decision.id, { reviseOptions: [{ id: 'b', label: 'Wrapper around fetch' }] }, wassim);
    assert.equal(driftOf(board, decision), null);
  });

  it('survives a reload', async () => {
    store.requestRefresh(decision.id, 'Check c', wassim);
    store.updateDecision(decision.id, { reviseOptions: [{ id: 'c', outdated: true, reason: 'dropped' }] }, wassim);
    await store.flush();
    const reloaded = new Store(dir);
    reloaded.load();
    const { decision: again } = reloaded.getDecision(decision.id);
    assert.equal(again.refreshRequest?.text, 'Check c');
    assert.equal(again.options[2].outdated?.reason, 'dropped');
    assert.equal(again.revisions, undefined, 'outdating rewords nothing');
  });
});
