import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { blockPerson } from '../src/core/canvas';
import { boardDigest, canvasDigest } from '../src/core/digest';
import { Store } from '../src/core/store';
import type { Actor, Block } from '../src/core/types';
import { jsonFolder, savedBoard } from './savedBoard';
import { eventsOf } from './tables';
import { removeScratch } from './platform';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const wassim: Actor = { kind: 'human', name: 'Wassim' };
const sam: Actor = { kind: 'human', name: 'Sam' };

describe('Board context sync', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  const note = (title: string, actor: Actor) => store.addBlock({ boardId }, { title, content: { type: 'note', text: title } }, actor);
  const lastSummary = () => eventsOf(store, boardId).at(-1)!.summary;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-sync-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Retry logic' }, wassim).id;
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  it('records who asked, when, and which blocks they selected, if any', () => {
    const built = note('Built so far', claude);
    const goal = note('Goal', wassim);
    assert.throws(() => store.requestSync(boardId, undefined, claude), /Only people ask for a sync/);
    const board = store.requestSync(boardId, undefined, wassim);
    assert.equal(board.syncRequest?.by.name, 'Wassim');
    assert.equal(board.syncRequest?.blockIds, undefined, 'Sync all stores no blocks');
    assert.ok(Date.parse(board.syncRequest!.at));
    assert.equal(lastSummary(), 'asked agents to sync the board context (agent-made blocks)');
    assert.match(boardDigest(board), /Sync requested by Wassim \(human\) at .+ \(agent-made blocks only; .+\)\. Re-read .+ then call finish_sync\./);

    // Selected in any order, kept in canvas order, each once.
    store.requestSync(boardId, [goal.id, built.id, goal.id], wassim);
    assert.deepEqual(board.syncRequest?.blockIds, [built.id, goal.id], 'asking again replaces the request');
    assert.equal(lastSummary(), 'asked agents to sync 2 blocks in the board context: "Built so far", "Goal"');
    assert.match(
      boardDigest(board),
      new RegExp(`Sync requested by Wassim \\(human\\) at \\S+: bring the blocks Wassim selected in the board context up to date with the board: note "Built so far" \\[id: ${built.id}\\], note "Goal" \\[id: ${goal.id}\\]\\. Refresh exactly those, people's included; changes to other blocks, and new blocks, are refused`),
    );
    store.requestSync(boardId, [goal.id], wassim);
    assert.equal(lastSummary(), 'asked agents to sync 1 block in the board context: "Goal"');
    assert.throws(() => store.requestSync(boardId, [], wassim), /Select at least one block to sync, or sync all/);
    assert.throws(() => store.requestSync(boardId, ['nope'], wassim), /"nope" is not a block in the board context/);
    const decisionId = store.postDecision(boardId, { question: 'Backoff?' }, wassim).id;
    const evidence = store.addBlock({ decisionId }, { content: { type: 'note', text: 'Evidence' } }, wassim);
    assert.throws(() => store.requestSync(boardId, [evidence.id], wassim), /is not a block in the board context/);

    assert.throws(() => store.cancelSync(boardId, claude), /Only people cancel a sync/);
    store.cancelSync(boardId, sam);
    assert.equal(board.syncRequest, undefined);
    assert.equal(lastSummary(), 'cancelled the sync of 1 block in the board context Wassim asked for');
    store.requestSync(boardId, undefined, wassim);
    store.cancelSync(boardId, wassim);
    assert.equal(lastSummary(), 'cancelled the sync of the board context');
    const seq = board.seq;
    store.cancelSync(boardId, sam);
    assert.equal(board.seq, seq, 'nothing open, nothing to cancel');
    assert.doesNotMatch(boardDigest(board), /Sync requested/);

    store.setArchived(boardId, true, wassim);
    assert.throws(() => store.requestSync(boardId, undefined, wassim), /read-only/);
  });

  it('tells blocks people made or edited apart from agent-made ones', () => {
    const status = note('Status', claude);
    const constraints = note('Constraints', wassim);
    const plan = note('Plan', claude);
    assert.equal(blockPerson(status), undefined);
    assert.equal(blockPerson(constraints)?.name, 'Wassim');

    store.updateBlock(plan.id, { text: 'Plan, revised' }, sam);
    assert.equal(blockPerson(plan)?.name, 'Sam');
    store.updateBlock(plan.id, { text: 'Plan, revised again' }, claude);
    assert.equal(blockPerson(plan)?.name, 'Sam', "an agent's later edit doesn't hand it back to the agents");

    // Blocks saved before ownership was recorded go by who made and last edited them.
    const legacy = { ...status, person: undefined, updatedBy: sam } as Block;
    assert.equal(blockPerson(legacy)?.name, 'Sam');
  });

  it("refuses an agent's change to a person's block during a sync of all, but lets it add blocks", () => {
    const status = note('Status', claude);
    const constraints = note('Constraints', wassim);
    const budget = note('Budget', sam);
    store.updateBlock(constraints.id, { text: 'Constraints, tidied' }, claude); // no sync open: as before

    store.requestSync(boardId, undefined, wassim);
    store.updateBlock(status.id, { text: '3 decided' }, claude);
    assert.throws(
      () => store.updateBlock(constraints.id, { text: 'Rewritten' }, claude),
      /note "Constraints" in the board context is Wassim's \(they made or edited it\), and Wassim's sync covers agent-made blocks only, so agents can't change it\. .+ finish_sync/,
    );
    assert.throws(() => store.removeItem(budget.id, claude), /is Sam's .+ so agents can't remove it/);
    store.addBlock({ boardId }, { content: { type: 'note', text: 'New context' } }, claude);
    store.updateBlock(constraints.id, { text: 'Constraints, by hand' }, sam); // people edit as ever

    // Only the board context is synced: other canvases work as before.
    const decisionId = store.postDecision(boardId, { question: 'Backoff?' }, wassim).id;
    const evidence = store.addBlock({ decisionId }, { content: { type: 'note', text: 'Evidence' } }, wassim);
    store.updateBlock(evidence.id, { text: 'Evidence, measured' }, claude);
  });

  it('lets agents change exactly the selected blocks during a sync of them, people\'s included, and nothing else', () => {
    const status = note('Status', claude);
    const plan = note('Plan', claude);
    const constraints = note('Constraints', wassim);
    const budget = note('Budget', sam);

    store.requestSync(boardId, [status.id, constraints.id, budget.id], wassim);
    store.updateBlock(status.id, { text: '3 decided' }, claude);
    store.updateBlock(constraints.id, { text: 'Constraints, synced' }, claude);
    assert.equal(blockPerson(constraints)?.name, 'Wassim', 'still his after the agent synced it');
    store.updateBlock(budget.id, { text: 'Budget, synced' }, claude); // Sam's, but Wassim selected it
    assert.throws(
      () => store.updateBlock(plan.id, { text: 'Rewritten' }, claude),
      /note "Plan" in the board context isn't in this sync: Wassim's sync covers only the blocks they selected \("Status", "Constraints", "Budget"\), so agents can't change it\. .+ finish_sync/,
    );
    assert.throws(
      () => store.addBlock({ boardId }, { content: { type: 'note', text: 'New context' } }, claude),
      /Wassim's sync covers only the blocks they selected .+, so agents can't add blocks to the board context until it's finished/,
    );
    assert.throws(() => store.removeItem(plan.id, claude), /isn't in this sync: .+ so agents can't remove it/);
    store.updateBlock(plan.id, { text: 'Plan, by hand' }, wassim); // people edit as ever

    const decisionId = store.postDecision(boardId, { question: 'Backoff?' }, wassim).id;
    store.addBlock({ decisionId }, { content: { type: 'note', text: 'Evidence' } }, claude); // other canvases are free

    store.removeItem(budget.id, claude); // a selected block can go
    store.finishSync(boardId, undefined, claude);
    store.addBlock({ boardId }, { content: { type: 'note', text: 'New context' } }, claude);
    store.updateBlock(plan.id, { text: 'Plan, revised' }, claude);
  });

  it('completes when an agent finishes it, naming what it refreshed, and leaves agents free again', () => {
    const constraints = note('Constraints', wassim);
    const built = note('Built so far', claude);
    assert.throws(() => store.finishSync(boardId, undefined, claude), /No sync of the board context is open/);

    store.requestSync(boardId, undefined, wassim);
    const board = store.finishSync(boardId, 'Updated the status table', claude);
    assert.equal(board.syncRequest, undefined);
    assert.equal(board.synced?.by.name, 'Claude');
    assert.equal(board.synced?.note, 'Updated the status table');
    assert.equal(board.synced?.blockIds, undefined);
    assert.equal(lastSummary(), `synced the board context (answering Wassim's request): "Updated the status table"`);
    store.updateBlock(constraints.id, { text: 'Constraints, tidied' }, claude);

    store.requestSync(boardId, [built.id, constraints.id], sam);
    store.finishSync(boardId, 'Both current', claude);
    assert.deepEqual(board.synced?.blockIds, [constraints.id, built.id]);
    assert.equal(lastSummary(), `synced "Constraints" and "Built so far" in the board context (answering Sam's request): "Both current"`);
  });

  it('marks, for agents reading the board context during a sync, which blocks to refresh and which to leave', () => {
    note('Status', claude);
    const plan = note('Plan', claude);
    const constraints = note('Constraints', wassim);
    note('Budget', sam);
    const read = () => {
      const { board, canvas } = store.getCanvas({ boardId });
      return canvasDigest(board, canvas);
    };
    const line = (digest: string, title: string) => digest.split('\n').find((l) => l.startsWith('- ') && l.includes(`"${title}"`))!;
    assert.doesNotMatch(read(), /'s block|this sync/);
    store.requestSync(boardId, undefined, wassim);
    let digest = read();
    assert.match(digest, /Sync requested by Wassim/);
    assert.match(line(digest, 'Constraints'), / · Wassim's block: leave it during this sync$/);
    assert.doesNotMatch(line(digest, 'Status'), /this sync/);

    store.requestSync(boardId, [plan.id, constraints.id], wassim);
    digest = read();
    assert.match(line(digest, 'Plan'), / · in this sync$/);
    assert.match(line(digest, 'Constraints'), / · Wassim's block: in this sync$/);
    assert.match(line(digest, 'Status'), / · leave it during this sync$/);
    assert.match(line(digest, 'Budget'), / · Sam's block: leave it during this sync$/);
  });

  it('survives a reload', async () => {
    const constraints = note('Constraints', wassim);
    store.requestSync(boardId, [constraints.id], wassim);
    await store.flush();
    const reloaded = new Store(dir);
    reloaded.load();
    const board = reloaded.getBoard(boardId);
    assert.deepEqual(board.syncRequest?.by, wassim);
    assert.deepEqual(board.syncRequest?.blockIds, [constraints.id]);
    assert.equal(blockPerson(board.canvas.blocks.find((b) => b.id === constraints.id)!)?.name, 'Wassim');
  });

  it('loads boards saved with "Include mine", reading an open request as a sync of all', async () => {
    const constraints = note('Constraints', wassim);
    const status = note('Status', claude);
    await store.flush();
    const saved = savedBoard(dir, boardId);
    Object.assign(saved, {
      syncRequest: { by: wassim, at: '2026-10-01T10:00:00.000Z', includeMine: true },
      synced: { by: claude, at: '2026-09-30T10:00:00.000Z', note: 'Old sync', includeMine: false },
    });
    const old = jsonFolder(saved);

    const reloaded = new Store(old);
    reloaded.load();
    const board = reloaded.getBoard(boardId);
    assert.deepEqual(board.syncRequest, { by: wassim, at: '2026-10-01T10:00:00.000Z' });
    assert.deepEqual(board.synced, { by: claude, at: '2026-09-30T10:00:00.000Z', note: 'Old sync' });
    assert.match(boardDigest(board), /Sync requested by Wassim \(human\) .+ \(agent-made blocks only;/);
    reloaded.updateBlock(status.id, { text: 'Synced' }, claude);
    assert.throws(() => reloaded.updateBlock(constraints.id, { text: 'Rewritten' }, claude), /is Wassim's .+ covers agent-made blocks only/);
    reloaded.finishSync(boardId, undefined, claude);
    assert.equal(eventsOf(reloaded, boardId).at(-1)!.summary, "synced the board context (answering Wassim's request)");
    await reloaded.flush();
    removeScratch(old);
  });
});
