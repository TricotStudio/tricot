import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { taskClosure } from '../src/core/closure';
import { boardDigest, commitsDigest, decisionDetail, taskDetail } from '../src/core/digest';
import { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import { eventsOf } from './tables';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const other: Actor = { kind: 'agent', name: 'codex' };
const sam: Actor = { kind: 'human', name: 'Sam' };

describe('Tasks', () => {
  let dir: string;
  let store: Store;
  let boardId: string;
  let decided: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-tasks-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Retry' }, sam).id;
    decided = store.postDecision(boardId, { question: 'Strategy?', options: [{ label: 'Options object' }, { label: 'Wrapper' }] }, claude).id;
    store.resolve(decided, { optionId: 'a' }, sam);
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const plan = (titles: string[], decisionIds = [decided]) =>
    store.planTasks(boardId, titles.map((title) => ({ title, decisionIds })), claude);

  it('plans tasks only against settled decisions, all or nothing', () => {
    const open = store.postDecision(boardId, { question: 'Backoff?', options: [{ label: 'x' }, { label: 'y' }] }, claude).id;
    assert.throws(
      () => store.planTasks(boardId, [{ title: 'Fine', decisionIds: [decided] }, { title: 'Too early', decisionIds: [open] }], claude),
      /#2 "Backoff\?" is open; tasks implement settled decisions/,
    );
    assert.equal(store.getBoard(boardId).tasks.length, 0, 'the valid task was not saved either');

    const [t1, t2] = plan(['Add retry option to client', 'Migrate call sites']);
    assert.deepEqual([t1.number, t2.number, t1.status], [1, 2, 'todo']);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /planned T2 "Migrate call sites" for #1/);
  });

  it('lets one agent claim a task and report on it', () => {
    const [task] = plan(['Add retry option']);
    store.claimTask(task.id, claude);
    assert.throws(() => store.claimTask(task.id, other), /claimed by Claude \(agent\)/);
    assert.throws(() => store.updateTask(task.id, { status: 'done' }, other), /claimed by Claude/);
    assert.throws(() => store.updateTask(task.id, { status: 'blocked' }, claude), /Say what is blocking it/);

    store.addBlock({ taskId: task.id }, { content: { type: 'note', text: '- [x] Retry option added' } }, claude);
    store.updateTask(task.id, { status: 'in_review', link: 'https://github.com/x/y/pull/7', note: 'Ready' }, claude);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /updated T1 "Add retry option": sent it for review; linked https:\/\/github\.com\/x\/y\/pull\/7; noted "Ready"/);
    store.updateTask(task.id, { status: 'done' }, sam); // people can always move a task
    assert.equal(task.status, 'done');
    assert.throws(() => store.claimTask(task.id, claude), /is done/);
  });

  it('marks every task built on a changed decision stale, done ones included', () => {
    const [done, doing, other2] = plan(['Shipped', 'In flight', 'Unrelated']);
    store.updateTask(done.id, { status: 'done' }, claude);
    store.claimTask(doing.id, claude);
    const unrelated = store.postDecision(boardId, { question: 'Max attempts?', options: [{ label: '3' }] }, claude).id;
    store.resolve(unrelated, { optionId: 'a' }, sam);
    store.updateTask(other2.id, { decisionIds: [unrelated] }, claude);

    store.resolve(decided, { optionId: 'a', rationale: 'still a' }, sam); // same answer: nothing stale
    assert.equal(done.stale, undefined);

    store.reopen(decided, sam);
    assert.match(done.stale!.reason, /^#1 was reopened by Sam$/);
    assert.ok(doing.stale);
    assert.equal(other2.stale, undefined);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /marked T1 and T2 stale: #1 "Strategy\?" was reopened by Sam/);

    store.resolve(decided, { optionId: 'b' }, sam);
    assert.match(doing.stale!.reason, /re-decided by Sam → b\) Wrapper/);
  });

  it('holds stale work until someone re-checks it', () => {
    const [task] = plan(['Add retry option']);
    store.claimTask(task.id, claude);
    store.requestExploration(decided, 'measure first', sam);
    assert.throws(() => store.updateTask(task.id, { status: 'done' }, claude), /T1 "Add retry option" is stale: #1 was sent back to explore by Sam/);
    assert.throws(() => store.claimTask(task.id, claude), /is stale/);
    store.updateTask(task.id, { status: 'blocked', note: 'waiting on #1' }, claude); // allowed while stale

    store.resolve(decided, { optionId: 'a' }, sam);
    store.updateTask(task.id, { stillValid: true, status: 'in_progress' }, claude);
    assert.equal(task.stale, undefined);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /confirmed it still holds after #1 changed; moved it to in progress/);

    store.defer(decided, 'later', sam);
    store.updateTask(task.id, { detail: 'Only for GETs now' }, claude); // revising also clears it
    assert.equal(task.stale, undefined);
  });

  it('shows tasks to agents, stale ones first', () => {
    const [a, b] = plan(['Add retry option', 'Migrate call sites']);
    store.claimTask(b.id, claude);
    store.updateTask(b.id, { note: 'Half the modules done' }, claude);
    store.reopen(decided, sam);
    store.updateTask(a.id, { stillValid: true }, sam);

    const board = store.getBoard(boardId);
    const digest = boardDigest(board);
    assert.match(digest, /## Tasks \(2\)\nStale, re-check first \(1\):\n- T2 \[id: \w+\] Migrate call sites — in progress, Claude \(agent\) · implements #1 · last note \(Claude\): "Half the modules done" · STALE: #1 was reopened by Sam; re-check before continuing/);
    assert.match(digest, /to do \(1\):\n- T1 \[id: \w+\] Add retry option — to do · implements #1$/m);
    assert.match(decisionDetail(board, board.decisions[0]), /## Tasks built on this\n- T1 .*\n- T2 /);
  });

  it('lets a person ask agents for a plan, answered by planning', () => {
    const open = store.postDecision(boardId, { question: 'Backoff?', options: [{ label: 'x' }] }, claude).id;
    assert.throws(() => store.requestPlan(open, undefined, sam), /only settled decisions can be planned/);
    const decision = store.requestPlan(decided, 'small PRs please', sam);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /asked for a task plan for #1 "Strategy\?": "small PRs please"/);
    assert.match(boardDigest(store.getBoard(boardId)), /Sam asked for a task plan: "small PRs please" \(use plan_tasks\)/);

    plan(['Add retry option', 'Migrate call sites']);
    assert.equal(decision.planRequest, undefined);
    const summaries = eventsOf(store, boardId).slice(-2).map((e) => e.summary);
    assert.match(summaries[0], /planned T1 "Add retry option" for #1 \(answering Sam's request for a plan\)/);
    assert.doesNotMatch(summaries[1], /answering/);

    store.requestPlan(decided, undefined, sam);
    store.reopen(decided, sam);
    assert.equal(decision.planRequest, undefined, 'reopening cancels the request');
  });

  it('allows tasks with no decision, linked later', () => {
    const [chore] = store.planTasks(boardId, [{ title: 'Fix flaky test' }], claude);
    assert.deepEqual(chore.decisionIds, []);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /^planned T1 "Fix flaky test"$/);
    assert.match(boardDigest(store.getBoard(boardId)), /T1 \[id: \w+\] Fix flaky test — to do · standalone \(no decision, so no stale warnings\)/);

    store.reopen(decided, sam);
    assert.equal(chore.stale, undefined, 'unlinked work never goes stale');
    store.resolve(decided, { optionId: 'a' }, sam);

    store.updateTask(chore.id, { decisionIds: [decided] }, sam);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /now implements #1/);
    store.reopen(decided, sam);
    assert.ok(chore.stale, 'once linked, it goes stale with its decision');
    store.updateTask(chore.id, { decisionIds: [] }, sam);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /unlinked it from its decisions/);
  });

  it('gives each task its own discussion and canvas', () => {
    const [task] = plan(['Add retry option']);
    store.addTaskComment(task.id, 'Use the existing backoff helper', sam);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /commented on T1 "Add retry option": "Use the existing backoff helper"/);
    assert.equal(eventsOf(store, boardId).at(-1)!.taskId, task.id);

    const block = store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'PR screenshot here' } }, claude);
    const event = eventsOf(store, boardId).at(-1)!;
    assert.match(event.summary, /added note "PR screenshot here" on the canvas of T1 "Add retry option"/);
    assert.deepEqual([event.taskId, event.itemId], [task.id, block.id]);
    assert.throws(() => store.addBlock({ taskId: task.id }, { content: { type: 'comparison' } }, claude), /decision canvas/);
    assert.match(taskDetail(store.getBoard(boardId), task), /## Discussion\n- Sam \(human\) at \S+ \[comment id: \w+\]: Use the existing backoff helper[\s\S]*## Canvas\nnote "PR screenshot here"/);
  });

  it('words reviews as approvals or requests for changes', () => {
    const [task] = plan(['Add retry option']);
    store.claimTask(task.id, claude);
    store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'Retries on 5xx' } }, claude);
    store.updateTask(task.id, { status: 'in_review' }, claude);
    assert.throws(() => store.updateTask(task.id, { status: 'in_progress' }, sam), /Say what needs changing/);
    store.updateTask(task.id, { status: 'in_progress', note: 'Handle 429s too' }, sam);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /updated T1 "Add retry option": sent it back for changes; noted "Handle 429s too"/);
    assert.equal(task.claimedBy?.name, 'Claude', 'the work stays with whoever built it');

    store.updateTask(task.id, { status: 'in_review' }, claude);
    store.updateTask(task.id, { status: 'done' }, sam);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /: approved it$/);
  });

  it('approves the work and its commit in one review, then records the hash the agent reports', () => {
    const [task] = plan(['Add retry option']);
    store.claimTask(task.id, claude);
    store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'Retries on 5xx' } }, claude);
    store.updateTask(task.id, { status: 'in_review' }, claude);

    // Only a person approves a commit, and only with the work.
    assert.throws(() => store.updateTask(task.id, { status: 'done', approveCommit: true }, claude), /^Error: Only people approve commits, when they review the work\.$/);
    assert.throws(() => store.updateTask(task.id, { approveCommit: true }, sam), /A commit is approved along with the work: pass status done\./);
    assert.equal(task.status, 'in_review');

    store.updateTask(task.id, { status: 'done', approveCommit: true }, sam);
    assert.equal(task.status, 'done');
    assert.deepEqual(task.commit, { approvedBy: sam, approvedAt: task.doneAt });
    assert.equal(task.claimedBy?.name, 'Claude', 'the commit falls to whoever built it');
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /^updated T1 "Add retry option": approved it and asked for a commit$/);
    assert.deepEqual(taskClosure(store.getBoard(boardId), task), { kind: 'done', by: sam, at: task.doneAt, approved: true });

    // Agents are asked for it wherever they look, until they report the hash.
    const ask = "Sam approved T1 and asked you to commit it. Commit that task's work alone, from your main session, then report the hash with update_task (commit); if there is nothing to commit, say why with update_task (nothing_to_commit).";
    assert.ok(taskDetail(store.getBoard(boardId), task).includes(`\n\n${ask}`));
    assert.ok(boardDigest(store.getBoard(boardId)).includes(`Sam approved T1 [id: ${task.id}] and asked you to commit it.`));
    assert.match(boardDigest(store.getBoard(boardId)), /T1 \[id: \w+\] Add retry option — done, Claude \(agent\) · .* · commit approved by Sam, not reported yet/);

    assert.throws(() => store.updateTask(task.id, { commit: 'not a hash' }, claude), /Pass the commit hash in commit, e\.g\. "abc1234"\./);
    store.updateTask(task.id, { commit: ' ABC1234DEF ' }, claude);
    assert.equal(task.commit?.hash, 'abc1234def');
    assert.ok(task.commit?.committedAt);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /^updated T1 "Add retry option": committed it as abc1234$/);
    assert.equal(commitsDigest(store.getBoard(boardId)), undefined);
    assert.match(taskDetail(store.getBoard(boardId), task), /\n\nCommitted as abc1234def; Sam approved the commit\./);
    assert.match(boardDigest(store.getBoard(boardId)), /committed as abc1234 \(commit approved by Sam\)/);
    assert.equal(taskClosure(store.getBoard(boardId), task)?.kind, 'done', 'reporting the hash is not a move to done');

    // Reopened, the work changes, so the approved commit goes with it.
    store.updateTask(task.id, { status: 'todo', note: 'One more case' }, sam);
    assert.equal(task.commit, undefined);
    assert.throws(() => store.updateTask(task.id, { commit: 'abc1234' }, claude), /Nobody approved a commit of T1/);
  });

  it('approves without a commit, and refuses a hash nobody asked for', () => {
    const [task, chore] = plan(['Add retry option', 'Bump a dependency']);
    store.claimTask(task.id, claude);
    store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'Retries on 5xx' } }, claude);
    store.updateTask(task.id, { status: 'in_review' }, claude);
    store.updateTask(task.id, { status: 'done' }, sam);
    assert.equal(task.commit, undefined);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /: approved it$/);

    const seq = store.getBoard(boardId).seq;
    assert.throws(() => store.updateTask(task.id, { commit: 'abc1234', note: 'Committed' }, claude), {
      message:
        `Nobody approved a commit of T1 "Add retry option", so there's no hash to record. ` +
        `People approve a commit when they review the work ("Looks good, commit it"); until one does, don't commit it.`,
    });
    assert.deepEqual([task.notes, store.getBoard(boardId).seq], [[], seq], 'nothing was applied');
    assert.equal(commitsDigest(store.getBoard(boardId)), undefined);

    // A person can still ask for one on done work, and done straight from another lane says so too.
    store.updateTask(task.id, { approveCommit: true }, sam);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /: asked for a commit$/);
    assert.equal(store.getTask(task.id).task.commit?.approvedBy.name, 'Sam');
    store.updateTask(chore.id, { status: 'done', approveCommit: true }, sam);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /: marked it done and asked for a commit$/);
    assert.deepEqual(taskClosure(store.getBoard(boardId), chore), { kind: 'done', by: sam, at: chore.doneAt, approved: false });
  });

  it('sends work for review with nothing to commit, and approving it asks for no commit', () => {
    const [task] = plan(['Plan the cut-over']);
    store.claimTask(task.id, claude);
    store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'The plan' } }, claude);
    assert.throws(() => store.updateTask(task.id, { status: 'in_review', nothingToCommit: '  ' }, claude), /reason must not be empty\./);
    assert.throws(() => store.updateTask(task.id, { status: 'in_review', nothingToCommit: 'x'.repeat(301) }, claude), /A reason is too long \(max 300 characters\)\./);
    assert.equal(task.status, 'in_progress');

    store.updateTask(task.id, { status: 'in_review', nothingToCommit: 'a plan; the doc is on the canvas' }, claude);
    assert.equal(task.noCommit?.reason, 'a plan; the doc is on the canvas');
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /sent it for review; said there is nothing to commit: a plan; the doc is on the canvas$/);
    assert.match(taskDetail(store.getBoard(boardId), task), /Status: in review[^\n]*\n.*\n\nNothing to commit: a plan; the doc is on the canvas\./);
    assert.throws(() => store.updateTask(task.id, { status: 'done', approveCommit: true }, sam), /T1 .* has nothing to commit \(a plan; the doc is on the canvas\): approve it without a commit\./);
    assert.equal(task.status, 'in_review');

    store.updateTask(task.id, { status: 'done' }, sam);
    assert.equal(task.commit, undefined);
    assert.equal(task.noCommit?.reason, 'a plan; the doc is on the canvas', 'it stays on the done task, where a hash would be');
    assert.equal(commitsDigest(store.getBoard(boardId)), undefined);
    assert.match(taskDetail(store.getBoard(boardId), task), /\n\nNothing to commit: a plan; the doc is on the canvas\./);

    // Sent back and sent for review again, it says it afresh.
    store.updateTask(task.id, { status: 'in_progress', note: 'One more thing' }, sam);
    assert.equal(task.noCommit, undefined);
    store.updateTask(task.id, { status: 'in_review' }, claude);
    assert.equal(task.noCommit, undefined, 'by default there is something to commit');
  });

  it('answers an approved commit with nothing to commit, which clears the reminder and records why', () => {
    const [task, other] = plan(['Spike the importer', 'Add retry option']);
    store.claimTask(task.id, claude);
    store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'Findings' } }, claude);
    store.updateTask(task.id, { status: 'in_review' }, claude);

    // Nobody approved a commit yet: there is nothing to answer.
    const noAnswer = /Nothing to commit is said when you send T1 .* for review \(status in_review\), or answers a commit a person approved on done work that has no hash yet\./;
    assert.throws(() => store.updateTask(task.id, { status: 'done', nothingToCommit: 'a spike' }, sam), noAnswer);
    assert.equal(task.status, 'in_review');
    store.updateTask(task.id, { status: 'done' }, sam);
    assert.throws(() => store.updateTask(task.id, { nothingToCommit: 'a spike' }, claude), noAnswer);
    assert.equal(task.noCommit, undefined);

    store.updateTask(task.id, { approveCommit: true }, sam);
    assert.ok(commitsDigest(store.getBoard(boardId)));
    assert.throws(() => store.updateTask(task.id, { nothingToCommit: 'a spike', commit: 'abc1234' }, claude), /Nothing to commit contradicts a commit/);
    assert.throws(() => store.updateTask(task.id, { nothingToCommit: '' }, claude), /reason must not be empty\./);
    assert.ok(task.commit && !task.noCommit, 'nothing was applied');

    store.updateTask(task.id, { nothingToCommit: 'a spike; findings on the canvas' }, claude);
    assert.equal(task.status, 'done');
    assert.equal(task.commit, undefined);
    const { noCommit } = store.getTask(task.id).task;
    assert.equal(noCommit?.reason, 'a spike; findings on the canvas');
    assert.equal(noCommit?.by.name, 'Claude');
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /^updated T1 "Spike the importer": found nothing to commit: a spike; findings on the canvas$/);
    assert.equal(commitsDigest(store.getBoard(boardId)), undefined);
    assert.match(boardDigest(store.getBoard(boardId)), /T1 .* done, Claude \(agent\) · .* · nothing to commit: a spike; findings on the canvas/);
    assert.deepEqual(taskClosure(store.getBoard(boardId), task), { kind: 'done', by: sam, at: task.doneAt, approved: true });

    // A commit that has its hash is no longer waiting on an answer.
    store.updateTask(other.id, { status: 'done', approveCommit: true }, sam);
    store.updateTask(other.id, { commit: 'abc1234' }, claude);
    assert.throws(() => store.updateTask(other.id, { nothingToCommit: 'a spike' }, claude), /Nothing to commit is said when you send T2/);

    // Reopened, it is work again.
    store.updateTask(task.id, { status: 'todo', note: 'Do more' }, sam);
    assert.equal(task.noCommit, undefined);
  });

  it("holds an agent's review until the task's canvas shows the work", () => {
    const [task, chore] = plan(['Add retry option', 'Bump a dependency']);
    store.claimTask(task.id, claude);
    const before = store.getBoard(boardId).seq;
    assert.throws(
      () => store.updateTask(task.id, { status: 'in_review', link: 'https://github.com/x/y/pull/8', note: 'Ready' }, claude),
      {
        message:
          `T1 "Add retry option" has nothing on its canvas to review. Add what shows the work to T1's canvas first ` +
          `(add_block with task_id: ${task.id}): a screenshot of the result, a checklist of what's done, or a note or diagram for work that isn't visual.`,
      },
    );
    assert.deepEqual([task.status, task.links, task.notes, store.getBoard(boardId).seq], ['in_progress', [], [], before], 'nothing was applied');

    // A group alone shows nothing; a block does.
    store.addGroup({ taskId: task.id }, { title: 'Result' }, claude);
    assert.throws(() => store.updateTask(task.id, { status: 'in_review' }, claude), /has nothing on its canvas to review/);
    store.addBlock({ taskId: task.id }, { content: { type: 'note', text: '- [x] Retry option added' } }, claude);
    store.updateTask(task.id, { status: 'in_review', link: 'https://github.com/x/y/pull/8' }, claude);
    assert.equal(task.status, 'in_review');

    // People moving a task by hand are never held up.
    store.updateTask(chore.id, { status: 'in_review' }, sam);
    assert.equal(chore.status, 'in_review');
  });

  it('keeps tasks people add in the backlog until they mark them ready', () => {
    const [issue] = store.planTasks(boardId, [{ title: 'Login times out', decisionIds: [decided] }], sam);
    const [planned] = plan(['Add retry option']);
    assert.deepEqual([issue.status, planned.status], ['backlog', 'todo'], 'agent-planned work goes straight to to do');
    assert.match(eventsOf(store, boardId).at(-2)!.summary, /^added T1 "Login times out" for #1 to the backlog$/);

    // Agents can work on it with the person, but not take it or move it.
    assert.throws(() => store.claimTask(issue.id, claude), /T1 "Login times out" is in the backlog: a person is still shaping it\. .*claim it once they mark it ready/);
    assert.throws(() => store.updateTask(issue.id, { status: 'todo' }, claude), /is in the backlog/);
    assert.throws(() => store.updateTask(planned.id, { status: 'backlog' }, claude), /Only people move tasks to the backlog/);
    store.addTaskComment(issue.id, 'Seen in the logs too', claude);
    store.addBlock({ taskId: issue.id }, { content: { type: 'note', text: 'Stack trace' } }, claude);
    store.updateTask(issue.id, { note: 'Probably the session cookie' }, claude);
    assert.equal(issue.status, 'backlog');

    const board = store.getBoard(boardId);
    assert.match(boardDigest(board), /backlog, not ready \(1\):\n- T1 \[id: \w+\] Login times out — backlog, not ready · implements #1/);
    assert.match(taskDetail(board, issue), /Status: backlog, not ready · [\s\S]*Not ready: a person is still shaping it/);

    store.updateTask(issue.id, { status: 'todo' }, sam);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /updated T1 "Login times out": marked it ready$/);
    store.claimTask(issue.id, claude);
    assert.equal(issue.status, 'in_progress');

    // A person can put work back for more shaping; that releases the claim.
    store.updateTask(issue.id, { status: 'backlog' }, sam);
    assert.equal(issue.claimedBy, undefined);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /moved it to the backlog$/);
  });

  it('survives a reload', async () => {
    const [task] = plan(['Add retry option']);
    await store.flush();
    const reloaded = new Store(dir);
    reloaded.load();
    reloaded.claimTask(task.id, claude);
    assert.equal(reloaded.planTasks(boardId, [{ title: 'Next', decisionIds: [decided] }], claude)[0].number, 2);
  });
});
