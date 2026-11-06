import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { boardDigest, LATEST_DONE } from '../src/core/digest';
import { Store } from '../src/core/store';
import type { Actor, Task } from '../src/core/types';
import { removeScratch } from './platform';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const sam: Actor = { kind: 'human', name: 'Sam' };

// get_board's budget for a board shaped like a long-running one: 100 decided
// decisions, 300 done tasks, 30 retired and 30 dropped, beside a little work
// in play. Agents read it when they connect and before each wait. Listing all
// of it in full made 127 KB here, about 32,000 tokens; in brief it makes 17 KB.
// Done tasks cost ten lines however many there are; each decided decision
// costs a line, about 130 bytes, so 100 of them take 13 KB. 20 KB, about
// 5,000 tokens, leaves room for the work in play, and is over the moment done
// tasks (about 90 KB more) or decided decisions (8 KB more) are listed in full.
const BUDGET = 20_000;

describe('get_board lists closed work in brief', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-closed-in-brief-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Roadmap', goal: 'Ship it' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  const digest = () => boardDigest(store.getBoard(boardId), 'Claude');
  const post = (n: number) =>
    store.postDecision(
      boardId,
      {
        question: `Should the importer keep the old field names for source ${n} after the move?`,
        area: 'Import',
        options: [{ label: 'Yes, map them once on import' }, { label: 'No, rename them everywhere' }],
        recommend: 'a',
      },
      claude,
    );
  const decide = (n: number) => {
    const d = post(n);
    store.addComment(d.id, 'Mapping once keeps old exports readable.', sam);
    return store.resolve(d.id, { optionId: 'a', rationale: 'Old exports must keep opening.' }, sam);
  };
  const finish = (tasks: Task[]) => {
    for (const t of tasks) {
      store.updateTask(t.id, { status: 'done', link: `https://github.com/acme/importer/pull/${t.number}`, note: 'Merged after review; the old exports open as before and the tests pass.' }, claude);
    }
  };
  // Fifty at a time, as plan_tasks takes them.
  const plan = (count: number, from: number): Task[] =>
    Array.from({ length: Math.ceil(count / 50) }, (_, batch) => {
      const titles = Array.from({ length: Math.min(50, count - batch * 50) }, (_, i) => `Import step ${from + batch * 50 + i}: read the old field names and write the new ones`);
      return store.planTasks(boardId, titles.map((title) => ({ title })), claude);
    }).flat();

  it('stays under its budget with hundreds of closed cards, and keeps the work in play in full', () => {
    const decided = Array.from({ length: 100 }, (_, i) => decide(i + 1));
    for (let i = 0; i < 30; i++) store.retire(post(200 + i).id, 'The importer is gone', sam);
    finish(plan(300, 1));
    for (const t of plan(30, 301)) store.dropTask(t.id, 'Not needed', sam);

    // Work in play.
    const open = post(300);
    const provisional = store.resolve(post(301).id, { optionId: 'b', provisional: true, rationale: 'Simpler for now' }, claude);
    const deferred = store.defer(post(302).id, 'After the move', sam);
    const [todo, doing, reviewing, blocked] = plan(4, 400);
    store.claimTask(doing.id, claude);
    store.claimTask(reviewing.id, claude);
    store.addBlock({ taskId: reviewing.id }, { content: { type: 'note', text: '- [x] Done' } }, claude);
    store.updateTask(reviewing.id, { status: 'in_review', link: 'https://github.com/acme/importer/pull/404' }, claude);
    store.claimTask(blocked.id, claude);
    store.updateTask(blocked.id, { status: 'blocked', note: 'Waiting on the new schema' }, claude);
    const [backlog] = store.planTasks(boardId, [{ title: 'Shape the export format' }], sam, { backlog: true });

    const text = digest();
    const size = Buffer.byteLength(text);
    assert.ok(size < BUDGET, `get_board is ${size} bytes, over its budget of ${BUDGET}`);

    // In play, in full, with what's asked of agents.
    assert.match(text, new RegExp(`## Open: waiting on people \\(1\\)\\n- #${open.number} \\[id: ${open.id}\\] .+ \\(area: Import\\) — options: a\\) Yes, map them once on import ★, b\\) No, rename them everywhere`));
    assert.match(text, new RegExp(`## Provisional: .+\\n- #${provisional.number} .+ → b\\) No, rename them everywhere — by Claude \\(agent\\): "Simpler for now"`));
    assert.match(text, new RegExp(`## Deferred: .+\\n- #${deferred.number} .+ — note: "After the move"`));
    for (const [t, lane] of [[todo, 'to do'], [doing, 'in progress'], [reviewing, 'in review'], [blocked, 'blocked'], [backlog, 'backlog, not ready']] as const) {
      assert.match(text, new RegExp(`\\n- T${t.number} \\[id: ${t.id}\\] ${t.title} — ${lane}`), `T${t.number} is listed in full`);
    }
    assert.match(text, new RegExp(`Ready in to do: T${todo.number} \\[id: ${todo.id}\\]`));

    // Each decided decision in a line: its question and answer, by id.
    assert.match(text, /## Decided: binding \(100\)\n/);
    assert.ok(text.includes(`\n- #${decided[0].number} [id: ${decided[0].id}] ${decided[0].question} → a) Yes, map them once on import\n`));
    assert.doesNotMatch(text, /Old exports must keep opening|— by Sam/, 'who decided it and why are in get_decision');

    // The latest ten done tasks, a count of the rest, and counts of what was set aside.
    assert.match(text, /\ndone \(300\), the latest 10:\n(- T\d+ \[id: \w+\] Import step \d+: .+ — by Claude \(agent\)\n){10}and 290 done before them\.\n/);
    assert.match(text, /\nRetired: 30 decisions a person set aside as no longer relevant; don't build on them\.\n/);
    assert.match(text, /\nDropped: 30 tasks a person set aside as work that won't be done; don't work on them\.\n/);
    assert.match(text, /Closed cards are summarised here: search finds anything older, and get_task and get_decision read any card in full\.$/);
    assert.doesNotMatch(text, /Merged after review|pull\/1\b|Not needed|The importer is gone/);

    // More closed cards don't make it longer, past their counts.
    finish(plan(150, 500));
    for (let i = 0; i < 20; i++) store.retire(post(600 + i).id, 'The importer is gone', sam);
    assert.ok(Buffer.byteLength(digest()) - size < 40, 'closed tasks and retired decisions cost a count, not a line each');
  });

  it('shows the done tasks finished last, not those changed last', () => {
    const tasks = plan(LATEST_DONE + 2, 1);
    finish(tasks);
    const at = (minutes: number) => new Date(Date.parse('2026-11-01T10:00:00.000Z') + minutes * 60_000).toISOString();
    tasks.forEach((t, i) => (store.getTask(t.id).task.doneAt = at(i)));
    // The first, finished again, comes first; the second, commented on since, stays with those done before.
    store.getTask(tasks[0].id).task.doneAt = at(100);
    store.addTaskComment(tasks[1].id, 'Still good', sam);

    const shown = [...digest().matchAll(/\n- T(\d+) \[id: \w+\] Import step/g)].map((m) => Number(m[1]));
    assert.deepEqual(shown, [1, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
    assert.match(digest(), /\nand 2 done before them\.\n/);
  });

  it('keeps what people ask of agents on a decided decision', () => {
    const d = decide(1);
    store.requestPlan(d.id, 'Split it by source', sam);
    store.requestRefresh(d.id, 'The schema moved', sam);
    assert.match(
      digest(),
      new RegExp(
        `\\n- #1 \\[id: ${d.id}\\] .+ → a\\) Yes, map them once on import — Sam asked agents to check it still holds: "The schema moved" \\(re-check it, then update_decision with refreshed: true and a note\\) — Sam asked for a task plan: "Split it by source" \\(use plan_tasks\\)\\n`,
      ),
    );
  });

  it('says nothing of closed cards on a board without any', () => {
    post(1);
    plan(1, 1);
    assert.doesNotMatch(digest(), /Closed cards|Retired:|Dropped:|\ndone \(/);
  });
});
