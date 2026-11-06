import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Shown } from '../src/core/answering';
import { boardDigest, eventsDigest } from '../src/core/digest';
import { Store } from '../src/core/store';
import { BURST_SETTLE_MS, MESSAGE_SETTLE_MS } from '../src/core/store/eventLog';
import type { Actor } from '../src/core/types';
import { removeScratch } from './platform';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };
const wassim: Actor = { kind: 'human', name: 'Wassim' };
const sam: Actor = { kind: 'human', name: 'Sam' };

// A message as updates quote it whole: its lines kept, indented under the update's.
const whole = (text: string) => `"${text.trim().replace(/\n(?!\n)/g, '\n  ')}"`;

describe('Updates an agent answers from', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-answering-'));
    store = new Store(dir);
    store.load();
    store.presentAgents = () => ['Claude', 'Codex'];
    boardId = store.createBoard({ title: 'Onboarding' }, wassim).id;
    store.createBoard({ title: 'Other' }, sam); // Sam is one of the people
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  const board = () => store.getBoard(boardId);
  const updates = (since: number, viewer: Actor, shown?: Shown) =>
    eventsDigest(store.eventsSince(boardId, since, viewer), board().seq, { board: board(), viewer: viewer.name, shown });

  // A task with four comments on it, the agent's own among them.
  function discussed() {
    const [task] = store.planTasks(boardId, [{ title: 'Ship the onboarding tour' }], wassim, { ready: true });
    store.addTaskComment(task.id, 'I put the three steps on the canvas.', claude);
    store.addTaskComment(task.id, 'Looks fine to me.', sam);
    store.addTaskComment(task.id, 'The third step needs a review.', codex);
    store.addTaskComment(task.id, 'I can take the review.', claude);
    return task;
  }

  it("gives a person's comment whole, with the card, what came before it and the call that answers it", () => {
    const task = discussed();
    const since = board().seq;
    const long = `Can we cut the third step?\n\n${'It repeats the first, and people skip it. '.repeat(12)}`;
    assert.ok(long.length > 400);
    store.addTaskComment(task.id, long, wassim);
    const seq = board().seq;
    assert.equal(
      updates(since, claude, new Shown()),
      [
        `- (${seq}) Wassim (human) commented on T1 "Ship the onboarding tour": ${whole(long)}. Reply with comment(task_id: ${task.id}).`,
        '  T1 "Ship the onboarding tour": to do.',
        '  Before it (1 older in get_task):',
        '  - Sam (human): "Looks fine to me."',
        '  - Codex (agent): "The third step needs a review."',
        '  - you: "I can take the review."',
        '',
        `Cursor: ${seq}`,
      ].join('\n'),
    );
    // Without a session, it is still whole, without the context.
    assert.ok(updates(since, claude).startsWith(`- (${seq}) Wassim (human) commented on T1 "Ship the onboarding tour": ${whole(long)}. Reply with comment(task_id: ${task.id}).\n\nCursor`));
  });

  it("doesn't tell a session again what it has been told, and says how much it left out", () => {
    const task = discussed();
    const told = new Shown();
    const since = board().seq;
    store.addTaskComment(task.id, 'Can we cut the third step?', wassim);
    updates(since, claude, told);

    const next = board().seq;
    store.addTaskComment(task.id, 'And should the second say what agents are?', wassim);
    const seq = board().seq;
    assert.equal(
      updates(next, claude, told),
      [
        `- (${seq}) Wassim (human) commented on T1 "Ship the onboarding tour": "And should the second say what agents are?". Reply with comment(task_id: ${task.id}).`,
        "  Before it: 4 comments you've seen; 1 older in get_task.",
        '',
        `Cursor: ${seq}`,
      ].join('\n'),
      'no heading, nothing quoted again',
    );
    // The same update again names the comment without its text.
    assert.equal(
      updates(next, claude, told),
      `- (${seq}) Wassim (human) commented on T1 "Ship the onboarding tour" (you've seen it). Reply with comment(task_id: ${task.id}).\n\nCursor: ${seq}`,
    );
    // Its own reply is the session's too: the next message counts it as seen.
    const replied = store.addTaskComment(task.id, 'Yes: I will cut it.', claude).comments.at(-1)!;
    told.read(replied.id);
    const last = board().seq;
    store.addTaskComment(task.id, 'Thanks.', wassim);
    assert.match(updates(last, claude, told), /\n {2}Before it: 6 comments you've seen; 1 older in get_task\.\n/);
  });

  it('tells the card again once it changes, and gives others their messages', () => {
    const task = discussed();
    const told = new Shown();
    const since = board().seq;
    store.addTaskComment(task.id, 'Can we cut the third step?', wassim);
    assert.match(updates(since, claude, told), /\n {2}T1 "Ship the onboarding tour": to do\.\n/);
    store.claimTask(task.id, claude);
    const next = board().seq;
    store.addTaskComment(task.id, 'How is it going?', wassim);
    assert.match(updates(next, claude, told), /\n {2}T1 "Ship the onboarding tour": in progress, claimed by Claude\.\n {2}Before it: 4 comments you've seen; 1 older in get_task\.\n/);

    // One for Codex is Codex's: Claude reads that it's not for it, and nothing of it.
    const asked = board().seq;
    store.addTaskComment(task.id, '@Codex can you review the third step?', wassim);
    const forClaude = updates(asked, claude, told);
    assert.match(forClaude, new RegExp(`Wassim \\(human\\) asked Codex on T1 \\[task id: ${task.id}\\]\\. Not for you; carry on\\.\\n\\nCursor`));
    assert.doesNotMatch(forClaude, /review the third step/);
    assert.ok(updates(asked, codex, new Shown()).includes(`asked you on T1 [task id: ${task.id}]: "can you review the third step?". Reply with comment(task_id: ${task.id}).`));
  });

  it('leaves a person their comments for people, and a task claimed by another agent to it', () => {
    const task = discussed();
    store.claimTask(task.id, codex);
    const since = board().seq;
    store.addTaskComment(task.id, 'Can we cut the third step?', wassim);
    assert.equal(updates(since, claude, new Shown()), `- (${board().seq}) Wassim (human) commented on T1 "Ship the onboarding tour": "Can we cut the third step?"\n\nCursor: ${board().seq}`, 'as logged');
    assert.match(updates(since, codex, new Shown()), /"Can we cut the third step\?"\. Reply with comment\(task_id: \w+\)\.\n {2}T1 "Ship the onboarding tour": in progress, claimed by Codex\.\n/);
    const next = board().seq;
    store.addTaskComment(task.id, '@Sam what do you think?', wassim);
    assert.doesNotMatch(updates(next, codex, new Shown()), /Reply with/);
  });

  it("gives get_board's catch-up once: whole to a new session, then named", () => {
    const thread = store.startThread(boardId, 'Where should the tour start?', claude);
    store.postToThread(thread.id, 'On the board, I think.', sam);
    store.postToThread(thread.id, 'Can we start it on the decision map instead?', wassim);
    const told = new Shown();
    const first = boardDigest(board(), 'Claude', Date.now(), told);
    const said = `Wassim wrote in thread "Where should the tour start?" [thread id: ${thread.id}]: "Can we start it on the decision map instead?". For any agent: the first to reply answers, with reply_in_thread(thread_id: ${thread.id}).`;
    assert.ok(first.includes(`\n${said}\n  Before it:\n  - you: "Where should the tour start?"\n  - Sam (human): "On the board, I think."\n`), first);
    told.begin();
    const again = boardDigest(board(), 'Claude', Date.now(), told);
    assert.ok(again.includes(`\nWassim wrote in thread "Where should the tour start?" [thread id: ${thread.id}] (you've seen it). For any agent: the first to reply answers, with reply_in_thread(thread_id: ${thread.id}).\n`), again);
    assert.doesNotMatch(again, /Before it/);
    assert.ok(boardDigest(board(), 'Claude', Date.now(), new Shown()).includes(said), 'a new session is told it all once');
  });
});

describe('Settling a wait', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-settle-'));
    store = new Store(dir);
    store.load();
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  function setUp() {
    const board = store.createBoard({ title: 'Settling' }, wassim);
    const [task] = store.planTasks(board.id, [{ title: 'Tour' }], wassim, { ready: true });
    return { boardId: board.id, task };
  }

  const timed = async (waiting: Promise<unknown>, start: number) => {
    const events = (await waiting) as unknown[];
    return { events, ms: performance.now() - start };
  };

  it("returns a person's message soon, and batches what agents do", async () => {
    assert.ok(MESSAGE_SETTLE_MS * 4 < BURST_SETTLE_MS);
    const { boardId, task } = setUp();
    let start = performance.now();
    let waiting = store.waitForEvents(boardId, store.getBoard(boardId).seq, { timeoutMs: 5000, exclude: claude });
    store.addTaskComment(task.id, 'Can we cut the third step?', wassim);
    const person = await timed(waiting, start);
    assert.equal(person.events.length, 1);
    assert.ok(person.ms >= MESSAGE_SETTLE_MS - 5 && person.ms < BURST_SETTLE_MS - 250, `${Math.round(person.ms)} ms`);

    start = performance.now();
    waiting = store.waitForEvents(boardId, store.getBoard(boardId).seq, { timeoutMs: 5000, exclude: claude });
    store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'Step one' } }, codex);
    setTimeout(() => store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'Step two' } }, codex), 200);
    const burst = await timed(waiting, start);
    assert.equal(burst.events.length, 2, 'one update for the burst');
    assert.ok(burst.ms >= BURST_SETTLE_MS - 5, `${Math.round(burst.ms)} ms`);
  });

  it('brings a settling burst forward when a person writes, and never puts it off', async () => {
    const { boardId, task } = setUp();
    const start = performance.now();
    const waiting = store.waitForEvents(boardId, store.getBoard(boardId).seq, { timeoutMs: 5000, exclude: claude });
    store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'Step one' } }, codex);
    setTimeout(() => store.addTaskComment(task.id, 'Can we cut the third step?', wassim), 100);
    const { events, ms } = await timed(waiting, start);
    assert.equal(events.length, 2);
    assert.ok(ms < BURST_SETTLE_MS - 250, `${Math.round(ms)} ms`);
  });
});
