import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { applyChange, eventMatches, patchBody, sameTally, tallyOf, type BoardChange } from '../src/core/changes';
import { Store } from '../src/core/store';
import type { Actor, Board } from '../src/core/types';
import { peoplesCopy } from '../src/server/api';

const sam: Actor = { kind: 'human', name: 'Sam' };
const alex: Actor = { kind: 'human', name: 'Alex' };
const claude: Actor = { kind: 'agent', name: 'Claude' };

type Held = Board & { ver?: number };

const withoutVer = ({ ver: _ver, ...rest }: Held): Board => rest as Board;

// The board as a page gets it over the wire.
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value, peoplesCopy));

describe('Changes: what pages are sent instead of the board', () => {
  let dir: string;
  let store: Store;
  let boardId: string;
  let mirror: Held;
  let changes: BoardChange[];

  const board = (): Held => wire(store.getBoard(boardId));

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-changes-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Retries', goal: 'Fewer failed calls' }, sam).id;
    mirror = board();
    changes = [];
    store.subscribeChanges(boardId, (change) => {
      const sent = wire(change);
      changes.push(sent);
      const next = applyChange(mirror, sent);
      assert.ok(next, `a page could not take change ${JSON.stringify(sent).slice(0, 300)}`);
      mirror = next;
    });
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  // Applying every change leaves a page with the board as the server has it.
  const same = (what: string) => assert.deepEqual(withoutVer(mirror), board(), what);
  const last = () => changes.at(-1)!;

  it('keeps a page equal to the board through decisions, comments, criteria and answers', () => {
    const decision = store.postDecision(boardId, { question: 'How often?', context: 'Calls fail', options: [{ label: 'Twice' }, { label: 'Thrice' }], blocking: true }, claude);
    same('a decision posted');
    assert.deepEqual(last().put?.map((r) => [r.kind, r.id]), [['decision', decision.id]]);
    assert.equal(last().events?.[0].type, 'decision_posted');

    store.addComment(decision.id, 'Twice is plenty', sam);
    same('a comment');
    const [patch] = last().patch!;
    assert.deepEqual([patch.kind, patch.id, Object.keys(patch.append!)], ['decision', decision.id, ['comments']], 'only the new comment is sent');
    assert.equal(patch.append!.comments.from, 0);
    assert.equal(patch.append!.comments.items.length, 1);
    assert.equal(last().put, undefined);

    store.proposeCriteria(decision.id, [{ label: 'Cheap' }, { label: 'Safe' }], claude);
    same('criteria');
    store.mark(decision.id, 'c1', 'a', 'yes', sam);
    same('a mark');
    store.attachFinding(decision.id, { summary: 'Measured', optionId: 'a', metrics: { ms: 12 } }, claude);
    same('a finding');
    store.askPeople(decision.id, ['Alex'], 'Your call', sam);
    same('asking someone');
    store.updateDecision(decision.id, { reviseOptions: [{ id: 'b', label: 'Three times' }], question: 'How many times?' }, sam);
    same('revising it');
    store.resolve(decision.id, { optionId: 'a', rationale: 'Simple' }, sam);
    same('resolving it');
    store.reopen(decision.id, sam);
    same('reopening it');
    store.retire(decision.id, 'No longer relevant', sam);
    same('retiring it');
    store.reopen(decision.id, sam);
    store.requestRefresh(decision.id, 'Check it', sam);
    same('asking for a refresh');
  });

  it('keeps a page equal through tasks, claims, reviews and reordering', () => {
    const d1 = store.postDecision(boardId, { question: 'Strategy?', options: [{ label: 'A' }, { label: 'B' }] }, claude);
    store.resolve(d1.id, { optionId: 'a' }, sam);
    const [t1, t2, t3] = store.planTasks(boardId, [{ title: 'One', decisionIds: [d1.id] }, { title: 'Two', decisionIds: [d1.id] }, { title: 'Three', decisionIds: [d1.id] }], claude);
    same('tasks planned');
    assert.equal(last().put?.length, 3);
    store.claimTask(t1.id, claude);
    same('a claim');
    store.addBlock({ taskId: t1.id }, { content: { type: 'note', text: '- [x] Done' } }, claude);
    same('a block on its canvas');
    store.addTaskComment(t1.id, 'On it', claude);
    same('a task comment');
    store.updateTask(t1.id, { status: 'in_review', link: 'https://example.com/pr/1', note: 'Ready' }, claude);
    same('sent for review');
    assert.equal(mirror.activity.reviewSentAt[t1.id], store.getBoard(boardId).activity.reviewSentAt[t1.id], 'the board activity follows the events');
    store.updateTask(t1.id, { status: 'done', approveCommit: true }, sam);
    same('approved');
    store.updateTask(t3.id, { after: null }, sam);
    same('reordered');
    store.updateTask(t2.id, { status: 'blocked', note: 'Waiting' }, claude);
    same('blocked');
    store.reopen(d1.id, sam);
    same('a decision it builds on is reopened');
  });

  it('keeps a page equal through the canvas: blocks, versions, moves, groups, links, pins, removing and restoring', () => {
    const decision = store.postDecision(boardId, { question: 'Layout?', options: [{ label: 'Grid' }, { label: 'Free' }] }, claude);
    const ref = { decisionId: decision.id };
    const note = store.addBlock(ref, { title: 'Context', content: { type: 'note', text: 'One' } }, claude);
    same('a block');
    assert.deepEqual(last().put?.map((r) => [r.kind, r.owner, r.id]), [['block', `decision:${decision.id}`, note.id]]);
    store.updateBlock(note.id, { text: 'Two' }, sam);
    same('an edit');
    assert.equal(mirror.decisions[0].canvas.blocks[0].versionCount, 1, 'the version chip');
    store.updateBlock(note.id, { text: 'Three' }, sam);
    same('another edit');
    const table = store.addBlock({ boardId }, { title: 'Table', content: { type: 'table', columns: ['a', 'b'], rows: [['1', '2']] } }, claude);
    same('a block on the board canvas');

    store.moveItems({ boardId }, [{ id: table.id, x: 777, y: 333 }], sam);
    same('a move, which is not logged');
    assert.deepEqual(last().events, undefined);
    const moved = last().patch!.find((p) => p.id === table.id)!;
    assert.deepEqual(moved.set, { x: 777, y: 333 }, 'a move sends the new place and nothing of what the block holds');

    const group = store.addGroup({ boardId }, { title: 'Evidence' }, claude);
    same('a group');
    store.renameGroup(group.id, 'Proof', sam);
    same('renaming it');
    const other = store.addBlock({ boardId }, { title: 'Note', content: { type: 'note', text: 'Later' } }, claude);
    const link = store.addLink(table.id, other.id, 'because', sam);
    same('a link');
    store.relabelLink(link.id, 'so', sam);
    same('relabelling it');
    store.moveItems({ boardId }, [{ id: other.id, x: 20, y: 20, groupId: group.id }], sam);
    same('regrouping');

    store.pinComment(note.id, { kind: 'text', quote: 'Three', prefix: '', suffix: '' }, 'Check this', sam);
    same('a pin with a comment');
    store.pinTask(note.id, { kind: 'block' }, { text: 'Fix it' }, sam);
    same('a pin that is a task');
    const { pin } = store.pinComment(other.id, { kind: 'block' }, 'Looks off', sam);
    same('a comment on the board canvas, which keeps its own thread');
    store.commentOnPin(pin.id, 'Agreed', claude);
    same('a reply in it');
    store.resolvePin(pin.id, true, sam);
    same('resolving it');

    store.deleteVersion(note.id, 1, sam);
    same('deleting a version');
    assert.equal(mirror.decisions[0].canvas.blocks[0].versionCount, 1);
    store.restoreBlock(note.id, 2, sam);
    same('restoring a version');

    store.removeItem(other.id, sam);
    same('removing a block takes its links');
    assert.equal(mirror.deleted?.length, 2);
    assert.equal((mirror.deleted?.[0] as unknown as { kept?: unknown }).kept, undefined, 'what a deletion kept is not sent');
    store.restoreItem(other.id, sam);
    same('restoring it');
    store.removeItem(note.id, sam);
    same('removing a block with pins');
    store.restoreItem(note.id, sam);
    same('restoring it, back in its place');
  });

  it('sends a diff without its raw patch, as the board does', () => {
    store.addBlock({ boardId }, { content: { type: 'diff', patch: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n' } }, claude);
    same('a diff block');
    assert.equal(JSON.stringify(last()).includes('+++ b/x'), false);
  });

  it('keeps a page equal through threads, requests, syncs, renaming and archiving', () => {
    const thread = store.startThread(boardId, 'What about retries?', sam);
    same('a thread');
    store.postToThread(thread.id, 'Reply', claude);
    same('a reply');
    assert.ok(last().patch?.[0].append?.messages, 'a reply is its message, not the thread');
    store.askInGeneral(boardId, 'Anyone there?', sam);
    same('the General thread');
    const request = store.askAgents(boardId, 'Make an architecture view', sam);
    same('a request');
    const { group } = store.takeRequest(request.id, claude);
    same('taking it');
    store.addBlock({ boardId }, { content: { type: 'note', text: 'An answer' }, groupId: group!.id } as never, claude);
    same('its answer');
    store.finishRequest(request.id, 'Done', claude);
    same('finishing it');
    store.requestSync(boardId, undefined, sam);
    same('asking for a sync');
    store.finishSync(boardId, 'Synced', claude);
    same('finishing it');
    store.setThreadLens(thread.id, { name: 'Legal', brief: 'Be careful' }, sam);
    same('a lens');
    store.setArchived(boardId, true, sam);
    same('archiving');
    assert.ok(mirror.archived);
    store.setArchived(boardId, false, sam);
    same('unarchiving');
    assert.equal(mirror.archived, undefined, 'a field that went is dropped');
    const [first] = (store.getBoard(boardId).aliases ?? [boardId]).concat(boardId);
    store.updateBoard(first, { title: 'Retries, renamed' }, sam);
    same('renaming');
    assert.equal(mirror.id, store.getBoard(boardId).id);
    store.removeItem(thread.id, sam);
    same('deleting a thread');
    store.restoreItem(thread.id, sam);
    same('restoring it');
  });

  it('numbers changes one by one, and keeps the board seq with them', () => {
    store.postDecision(boardId, { question: 'One?' }, claude);
    store.postDecision(boardId, { question: 'Two?' }, claude);
    store.moveItems({ boardId }, [], sam);
    const vers = changes.map((c) => c.ver);
    assert.ok(vers.length >= 2);
    for (let i = 1; i < vers.length; i++) assert.equal(vers[i], vers[i - 1] + 1);
    assert.equal(store.changeVersion(boardId), vers.at(-1));
    assert.equal(last().seq, store.getBoard(boardId).seq);
    assert.deepEqual(store.liveState(boardId), { ver: vers.at(-1), seq: store.getBoard(boardId).seq, tally: tallyOf(store.getBoard(boardId)) });
  });

  it('keeps recent changes for a page that missed some, and says when they are gone', () => {
    const before = store.changeVersion(boardId);
    store.postDecision(boardId, { question: 'One?' }, claude);
    store.postDecision(boardId, { question: 'Two?' }, claude);
    const missed = store.changesSince(boardId, before)!;
    assert.deepEqual(missed.map((c) => c.ver), changes.map((c) => c.ver));
    assert.deepEqual(store.changesSince(boardId, store.changeVersion(boardId)), []);
    assert.equal(store.changesSince(boardId, before - 5), undefined, 'before what is kept');
    assert.equal(store.changesSince(boardId, store.changeVersion(boardId) + 1), undefined, 'from a different server run');
    for (let i = 0; i < 250; i++) store.addComment(store.getBoard(boardId).decisions[0].id, `Comment ${i}`, sam);
    assert.equal(store.changesSince(boardId, before), undefined, 'too long ago');
    assert.equal(store.changesSince(boardId, store.changeVersion(boardId) - 3)!.length, 3);
  });

  it('applies a change twice, or one the page already has, with the same result', () => {
    const decision = store.postDecision(boardId, { question: 'Twice?' }, claude);
    const ref = { decisionId: decision.id };
    store.addComment(decision.id, 'First', sam);
    store.addBlock(ref, { content: { type: 'note', text: 'Note' } }, claude);
    store.addComment(decision.id, 'Second', sam);
    const current = board();
    // A page that fetched the board after all of this still takes the changes sent before.
    let page: Held = { ...current, ver: changes[0].ver - 1 };
    for (const change of changes) page = applyChange(page, change)!;
    assert.deepEqual(withoutVer(page), current);
    for (const change of changes) page = applyChange(page, change)!;
    assert.deepEqual(withoutVer(page), current);
  });

  it('leaves what a change does not touch as it was, for a page to skip drawing', () => {
    const a = store.postDecision(boardId, { question: 'A?' }, claude);
    store.postDecision(boardId, { question: 'B?' }, claude);
    const before = mirror;
    store.addComment(a.id, 'Hi', sam);
    assert.notEqual(mirror.decisions[0], before.decisions[0]);
    assert.equal(mirror.decisions[1], before.decisions[1]);
    assert.equal(mirror.tasks, before.tasks);
    assert.equal(mirror.canvas, before.canvas);
  });

  it('cannot apply a patch to something the page does not have, or one that skips what came before', () => {
    const decision = store.postDecision(boardId, { question: 'A?' }, claude);
    store.addComment(decision.id, 'One', sam);
    store.addComment(decision.id, 'Two', sam);
    const empty: Held = { ...board(), decisions: [] };
    assert.equal(applyChange(empty, changes.at(-1)!), null, 'no such decision');
    const base = board();
    base.decisions[0].comments = [];
    assert.equal(applyChange(base, changes.at(-1)!), null, 'the second comment without the first');
    assert.equal(applyChange(board(), { ver: 1, seq: 1, reload: true }), null);
  });
});

describe('Change helpers', () => {
  it('patches field by field, and sends only what a list added', () => {
    assert.deepEqual(patchBody({ a: 1, b: 'x', c: [1], d: { e: 1 } }, { a: 1, b: 'y', c: [1, 2], d: { e: 1 } }), { set: { b: 'y' }, append: { c: { from: 1, items: [2] } } });
    assert.deepEqual(patchBody({ a: 1, gone: true }, { a: 1 }), { unset: ['gone'] });
    assert.deepEqual(patchBody({ c: [1, 2] }, { c: [2, 1] }), { set: { c: [2, 1] } }, 'a list that changed in place goes whole');
    assert.equal(patchBody({ a: { b: 1 } }, { a: { b: 1 } }), undefined);
  });

  it('matches events as the events route does', () => {
    const event = (type: string, actor: Actor, extra = {}) => ({ seq: 1, at: '', actor, type, summary: '', ...extra }) as never;
    assert.ok(eventMatches(event('comment_added', alex, { decisionId: 'd1' }), { decisionId: 'd1' }));
    assert.ok(!eventMatches(event('comment_added', alex, { decisionId: 'd2' }), { decisionId: 'd1' }));
    assert.ok(!eventMatches(event('task_updated', alex, { decisionId: 'd1', taskId: 't1' }), { taskId: 't2' }));
    assert.ok(eventMatches(event('comment_added', alex), { unseenBy: 'Sam' }));
    assert.ok(!eventMatches(event('comment_added', sam), { unseenBy: 'sam' }), 'their own doing');
    assert.ok(eventMatches(event('comment_added', claude), { unseenBy: 'Claude' }), 'an agent of the same name is not them');
    assert.ok(!eventMatches(event('task_reordered', alex), { unseenBy: 'Sam' }));
  });

  it('compares counts', () => {
    const a = tallyOf({ decisions: [], tasks: [], canvas: { blocks: [], groups: [], links: [], pins: [] } } as unknown as Board);
    assert.ok(sameTally(a, { ...a }));
    assert.ok(!sameTally(a, { ...a, blocks: 1 }));
  });
});

describe('Changes as the server sends them in real use', () => {
  it('batches a burst of changes into one, sent once they are saved, equal to the board', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-burst-'));
    try {
      // Without the test harness, which saves after every call.
      const env = { ...process.env, NODE_TEST_CONTEXT: undefined };
      const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./burstChild.ts', import.meta.url)), dir], { stdio: ['ignore', 'pipe', 'pipe'], env });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (err += chunk));
      await new Promise((resolve) => child.once('exit', resolve));
      assert.ok(out.trim(), `the child said nothing: ${err}`);
      const { before, after, changes } = JSON.parse(out) as { before: Held; after: Held; changes: BoardChange[] };
      assert.equal(changes.length, 1, 'three changes made in a burst are one message');
      assert.equal(changes[0].events?.length, 3);
      assert.ok(changes[0].put?.length === 1 && changes[0].patch?.length === 1);
      assert.deepEqual(withoutVer(applyChange(before, changes[0])!), after);
      assert.ok(JSON.stringify(changes[0]).length < 2500, 'small');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
