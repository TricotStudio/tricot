import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { needsInput } from '../src/core/attention';
import { boardDigest, taskDetail } from '../src/core/digest';
import {
  FIRST_LOOK_MS,
  firstLookCue,
  firstLookDue,
  firstLookLapsed,
  firstLooksDigest,
  takeFirstLookRefusal,
} from '../src/core/firstLook';
import { BoardError, Store } from '../src/core/store';
import type { Actor, FirstLook } from '../src/core/types';
import { eventsOf } from './tables';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };
const wassim: Actor = { kind: 'human', name: 'Wassim' };
const MINUTE = 60_000;

describe('First looks', () => {
  let dir: string;
  let store: Store;
  let boardId: string;
  let clock: number;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-firstlook-'));
    store = new Store(dir);
    store.load();
    clock = Date.parse('2026-10-30T10:00:00.000Z');
    store.now = () => clock;
    store.presentAgents = () => ['Claude', 'Codex'];
    boardId = store.createBoard({ title: 'Roadmap' }, wassim).id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const add = (title: string, detail?: string) => store.planTasks(boardId, [{ title, detail }], wassim)[0];
  const board = () => store.getBoard(boardId);
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof BoardError, String(error));
      return error.message;
    }
    assert.fail('expected a refusal');
  };

  it('opens one on a card a person adds to the backlog, and none on cards agents plan or people mark ready', () => {
    const card = add('Dark mode toggle');
    assert.equal(card.status, 'backlog');
    assert.deepEqual(card.firstLook, { status: 'open', openedAt: card.createdAt });
    const [planned] = store.planTasks(boardId, [{ title: 'Wire the toggle' }], claude);
    assert.equal(planned.firstLook, undefined);
    const [ready] = store.planTasks(boardId, [{ title: 'Ship it' }], wassim, { ready: true });
    assert.equal(ready.status, 'todo');
    assert.equal(ready.firstLook, undefined);
    assert.match(eventsOf(store, board()).at(-3)!.summary, /added T1 "Dark mode toggle" to the backlog/);
  });

  it('loads older boards unchanged', async () => {
    const card = add('Dark mode toggle');
    delete card.firstLook; // as a board saved before first looks
    store.planTasks(boardId, [{ title: 'Wire it' }], claude);
    await store.flush();
    const reloaded = new Store(dir);
    reloaded.load();
    assert.ok(reloaded.getBoard(boardId).tasks.every((t) => t.firstLook === undefined));
    assert.equal(firstLooksDigest(reloaded.getBoard(boardId), 'Claude'), undefined);
  });

  it('lets exactly one agent take it; the other is told who has it', () => {
    const card = add('Dark mode toggle');
    store.takeFirstLook(card.id, claude);
    assert.equal(card.firstLook?.status, 'taken');
    assert.deepEqual((card.firstLook as Extract<FirstLook, { status: 'taken' }>).by, claude);
    assert.equal(refusal(() => store.takeFirstLook(card.id, codex)), 'Claude is taking the first look at T1; carry on with something else.');
    // Taking it again is fine, and changes nothing others see.
    const seq = board().seq;
    store.takeFirstLook(card.id, claude);
    assert.equal(board().seq, seq);
    assert.equal(eventsOf(store, board()).filter((e) => e.type === 'first_look_taken').length, 1);
    assert.equal(eventsOf(store, board()).find((e) => e.type === 'first_look_taken')!.summary, 'took the first look at T1 "Dark mode toggle"');
    assert.match(refusal(() => store.takeFirstLook(card.id, wassim)), /Only agents take a first look/);
  });

  it('leaves a card assigned to an agent, or @-mentioning one, to that agent', () => {
    const assigned = store.planTasks(boardId, [{ title: 'Review the diff', assignee: 'Codex' }], wassim)[0];
    assert.equal(
      refusal(() => store.takeFirstLook(assigned.id, claude)),
      "T1's first look is for Codex (assigned to Codex), so only Codex can take it; carry on with something else.",
    );
    store.takeFirstLook(assigned.id, codex);

    const mentioned = add('Header mock', '@Codex sketch the new header');
    assert.deepEqual(mentioned.firstLook, { status: 'open', openedAt: mentioned.createdAt, mentions: ['Codex'] });
    assert.match(refusal(() => store.takeFirstLook(mentioned.id, claude)), /T2's first look is for Codex \(Codex is @-mentioned on it\)/);

    // A person's comment mentioning an agent points it there too.
    const commented = add('Search filters');
    assert.equal(takeFirstLookRefusal(board(), commented, claude), undefined);
    store.addTaskComment(commented.id, '@Codex can you take this one?', wassim);
    assert.match(takeFirstLookRefusal(board(), commented, claude)!, /first look is for Codex/);
    store.takeFirstLook(commented.id, codex);

    // Editing the card's text re-reads who it's for.
    const edited = add('Billing page');
    store.updateTask(edited.id, { detail: 'For @Claude' }, wassim);
    assert.deepEqual(edited.firstLook && 'mentions' in edited.firstLook && edited.firstLook.mentions, ['Claude']);
    assert.match(takeFirstLookRefusal(board(), edited, codex)!, /first look is for Claude/);
  });

  it("is given by the taker's next comment, in one event that reaches the person", () => {
    const card = add('Dark mode toggle');
    store.takeFirstLook(card.id, claude);
    store.addTaskComment(card.id, 'Feasible next to Settings.', codex); // not the taker's
    assert.equal(card.firstLook?.status, 'taken');
    const seq = board().seq;
    store.addTaskComment(card.id, 'Feasible: CSS tokens already split light and dark. Approach: a toggle in the header.', claude);
    const look = store.getTask(card.id).task.firstLook as Extract<FirstLook, { status: 'done' }>;
    assert.equal(look.status, 'done');
    assert.deepEqual(look.by, claude);
    assert.equal(look.commentId, card.comments.at(-1)!.id);
    const events = eventsOf(store, board()).filter((e) => e.seq > seq);
    assert.equal(events.length, 1, 'one event: the comment');
    assert.equal(events[0].type, 'comment_added');
    assert.match(events[0].summary, /^gave T1 "Dark mode toggle" a first look: "Feasible: CSS tokens/);
    assert.ok(needsInput(events[0], board(), 'Wassim'), 'the person who added it has it in their inbox');
    assert.match(refusal(() => store.takeFirstLook(card.id, codex)), /T1 already had its first look: Claude gave it/);
    // Later comments are just comments.
    store.addTaskComment(card.id, 'One more thing.', claude);
    assert.match(eventsOf(store, board()).at(-1)!.summary, /^commented on T1/);
  });

  it("is given by an agent's comment when nobody has taken it, if it's for them", () => {
    const card = add('Dark mode toggle', 'For @Codex');
    store.addTaskComment(card.id, 'Looks doable.', claude);
    assert.equal(card.firstLook?.status, 'open', "not Claude's to give");
    store.addTaskComment(card.id, 'Doable in a day.', codex);
    assert.equal(card.firstLook?.status, 'done');
  });

  it('goes back to open after ten minutes without a comment, and tells agents', () => {
    const card = add('Dark mode toggle');
    store.takeFirstLook(card.id, claude);
    clock += 9 * MINUTE;
    assert.equal(store.lapseFirstLooks(), 0);
    assert.equal(card.firstLook?.status, 'taken');
    clock += MINUTE;
    assert.equal(store.lapseFirstLooks(), 1);
    assert.equal(card.firstLook?.status, 'open');
    const lapse = eventsOf(store, board()).at(-1)!;
    assert.equal(lapse.type, 'first_look_lapsed');
    assert.deepEqual(lapse.actor, claude);
    assert.equal(lapse.summary, `didn't comment on T1 "Dark mode toggle" within 10 minutes of taking its first look, so it's open again`);
    assert.match(firstLooksDigest(board(), 'Codex', clock)!, /T1 \[task id: \w+\] "Dark mode toggle" needs a first look/);
    store.takeFirstLook(card.id, codex);
    assert.equal(store.lapseFirstLooks(), 0);
  });

  it("stays the taker's while its calls are about the card, and lapses lazily on take", () => {
    const card = add('Dark mode toggle');
    store.takeFirstLook(card.id, claude);
    clock += 8 * MINUTE;
    store.keepFirstLook(card.id, claude);
    store.keepFirstLook(card.id, codex); // not theirs: no effect
    assert.equal(firstLookDue(card.firstLook), clock + FIRST_LOOK_MS);
    clock += 9 * MINUTE;
    assert.equal(store.lapseFirstLooks(), 0);
    clock += MINUTE;
    // No sweep ran: taking it checks first.
    store.takeFirstLook(card.id, codex);
    assert.deepEqual(card.firstLook && 'by' in card.firstLook && card.firstLook.by, codex);
    assert.deepEqual(
      eventsOf(store, board()).slice(-2).map((e) => e.type),
      ['first_look_lapsed', 'first_look_taken'],
    );
  });

  it('needs none once the card leaves the backlog', () => {
    const card = add('Dark mode toggle');
    store.updateTask(card.id, { status: 'todo' }, wassim);
    assert.equal(refusal(() => store.takeFirstLook(card.id, claude)), "T1 is no longer in the backlog (it's in To do), so it needs no first look.");
    assert.equal(firstLooksDigest(board(), 'Claude'), undefined);
    const [planned] = store.planTasks(boardId, [{ title: 'Wire it' }], claude);
    assert.match(refusal(() => store.takeFirstLook(planned.id, claude)), /needs no first look: only cards people add to the backlog get one/);
  });

  it('reads to agents as theirs to take, theirs to write, or for another agent', () => {
    const card = add('Dark mode toggle');
    const line = `T1 [task id: ${card.id}] "Dark mode toggle" needs a first look: take it with take_first_look, then comment on it with feasibility and approach (and a mock on its canvas for UI work). Don't claim it; it's in the backlog.`;
    assert.equal(firstLooksDigest(board(), 'Claude', clock), line);
    assert.ok(boardDigest(board(), 'Claude', clock).includes(`\n${line}\n`));
    assert.match(boardDigest(board(), 'Claude', clock), /T1 \[id: \w+\] Dark mode toggle — backlog, not ready · standalone \(no decision, so no stale warnings\) · needs a first look \(take_first_look\)/);

    store.takeFirstLook(card.id, claude);
    clock += 3 * MINUTE;
    assert.equal(
      firstLooksDigest(board(), 'Claude', clock),
      `You're taking the first look at T1 [task id: ${card.id}] "Dark mode toggle": comment on it with feasibility and approach (and a mock on its canvas for UI work). If you haven't commented within 7 minutes, it goes back to open. Don't claim it; it's in the backlog.`,
    );
    assert.equal(firstLooksDigest(board(), 'Codex', clock), undefined, "another agent's to write");
    assert.match(taskDetail(board(), card, 'Codex', clock), /Claude is taking its first look: leave it to them\./);
    assert.match(boardDigest(board(), 'Codex', clock), /backlog, not ready · standalone [^\n]* · Claude is taking its first look/);

    const forCodex = store.planTasks(boardId, [{ title: 'Review the diff', assignee: 'Codex' }], wassim)[0];
    assert.doesNotMatch(firstLooksDigest(board(), 'Claude', clock)!, /Review the diff/, "a card assigned to Codex isn't pushed at Claude");
    assert.match(
      firstLooksDigest(board(), undefined, clock)!,
      new RegExp(`T2 \\[task id: ${forCodex.id}\\] "Review the diff" needs a first look, for Codex: only Codex can take it\\.`),
    );
    assert.match(boardDigest(board(), 'Claude', clock), /Review the diff — backlog, not ready · assigned to Codex by Wassim · [^\n]*needs a first look, for Codex/, 'its task line says so');
    assert.match(firstLooksDigest(board(), 'Codex', clock)!, /"Review the diff" needs a first look, and it's for you \(assigned to you\): take it with take_first_look/);

    store.addTaskComment(card.id, 'Feasible; a header toggle.', claude);
    assert.match(taskDetail(board(), card, 'Codex', clock), /First look given by Claude at /);
  });

  it("shows people a quiet line while it's to come", () => {
    const card = add('Dark mode toggle');
    assert.deepEqual(firstLookCue(board(), card), { text: "Waiting for an agent's first look" });
    const forCodex = store.planTasks(boardId, [{ title: 'Review', assignee: 'Codex' }], wassim)[0];
    assert.deepEqual(firstLookCue(board(), forCodex), { text: "Waiting for Codex's first look" });
    store.takeFirstLook(card.id, claude);
    assert.deepEqual(firstLookCue(board(), card), { text: 'Claude is taking the first look', by: 'Claude' });
    store.addTaskComment(card.id, 'Feasible.', claude);
    assert.equal(firstLookCue(board(), card), undefined);
  });

  it('times a taken first look from its last call', () => {
    const taken: FirstLook = {
      status: 'taken',
      openedAt: '2026-10-30T09:00:00.000Z',
      by: claude,
      takenAt: '2026-10-30T10:00:00.000Z',
      activeAt: '2026-10-30T10:05:00.000Z',
    };
    assert.equal(firstLookDue(taken), Date.parse('2026-10-30T10:15:00.000Z'));
    assert.equal(firstLookLapsed(taken, Date.parse('2026-10-30T10:14:59.000Z')), false);
    assert.equal(firstLookLapsed(taken, Date.parse('2026-10-30T10:15:00.000Z')), true);
    assert.equal(firstLookLapsed({ status: 'open', openedAt: taken.openedAt }, Date.parse('2027-01-01')), false);
  });
});
