import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { unseenBy } from '../src/core/attention';
import { boardNeeds, boardWork, byUrgency, dismissable, FOLD_OVER, needLink, needRows, needsAcross, needsFrom, type NeedsReport, type PresentAgent } from '../src/core/needs';
import { linkTo, pageAt } from '../src/core/pages';
import { Store } from '../src/core/store';
import { boardKey, type Actor, type Board } from '../src/core/types';
import { createApp } from '../src/server/app';
import { eventsOf } from './tables';
import { removeScratch } from './platform';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const sam: Actor = { kind: 'human', name: 'Sam' };
const alex: Actor = { kind: 'human', name: 'Alex' };

describe('What needs you across boards', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-needs-'));
    store = new Store(dir);
    store.load();
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  const boards = () => store.listBoards().map((b) => store.getBoard(b.id));
  const ask = (boardId: string, question: string, extra = {}) =>
    store.postDecision(boardId, { question, options: [{ label: 'A' }, { label: 'B' }], ...extra }, claude);
  // A task an agent planned, claimed and moved on.
  const work = (boardId: string, title: string, status?: 'in_review' | 'blocked') => {
    const [task] = store.planTasks(boardId, [{ title }], claude);
    if (!status) return task;
    store.claimTask(task.id, claude);
    store.addBlock({ taskId: task.id }, { title: 'Result', content: { type: 'note', text: 'Where it got to.' } }, claude);
    return store.updateTask(task.id, { status, note: status === 'blocked' ? 'Needs a key' : 'Done, have a look' }, claude);
  };

  it('puts blocking questions and asks first, then reviews, calls to confirm, blocked work and the rest', () => {
    const b = store.createBoard({ title: 'Retries' }, sam).id;
    const open = ask(b, 'Log retries?');
    const confirm = ask(b, 'How many attempts?');
    store.resolve(confirm.id, { optionId: 'a', provisional: true }, claude);
    const blocked = work(b, 'Wire the backoff', 'blocked');
    const review = work(b, 'Add jitter', 'in_review');
    const blocking = ask(b, 'Retry POSTs?', { blocking: true });
    const asked = ask(b, 'Which queue?', { ask: ['Sam'] });
    const other = store.createBoard({ title: 'Launch' }, sam).id;
    const elsewhere = ask(other, 'Ship on Monday?');
    store.createBoard({ title: 'Quiet' }, sam);

    const report = needsAcross(boards(), 'sam');
    assert.equal(report.total, 7);
    assert.deepEqual(
      report.rows.slice(0, 5).map((r) => [r.ref, r.kind, r.why, r.action]),
      [
        [`#${blocking.number}`, 'blocking', 'blocking', 'Decide'],
        [`#${asked.number}`, 'asked', 'asked of you', 'Decide'],
        [`T${review.number}`, 'review', 'to review', 'Review'],
        [`#${confirm.number}`, 'confirm', "Claude's call, to confirm", 'Confirm'],
        [`T${blocked.number}`, 'blocked', 'blocked', 'Unblock'],
      ],
    );
    assert.deepEqual(
      report.rows.slice(5).map((r) => [r.board, r.ref, r.why]).sort(),
      [
        ['Launch', `#${elsewhere.number}`, 'open'],
        ['Retries', `#${open.number}`, 'open'],
      ],
      'then open questions, from every board',
    );
    assert.deepEqual(report.rows[0].target, { kind: 'decision', id: blocking.id });
    assert.equal(report.rows[0].square, 'blocking');
    assert.equal(report.rows[2].square, 'in_review');
    assert.deepEqual(
      report.projects.map((p) => [p.title, p.needs]).slice(0, 2).sort(),
      [
        ['Launch', 1],
        ['Retries', 6],
      ],
    );
    assert.deepEqual(report.projects[2], { ...report.projects[2], title: 'Quiet', needs: 0 }, 'boards needing you come first');
  });

  it('leaves out questions routed only to other people, and what you settled', () => {
    const b = store.createBoard({ title: 'Queues' }, sam).id;
    ask(b, 'Which broker?', { ask: ['Alex'] });
    const d = ask(b, 'Which region?');
    store.resolve(d.id, { optionId: 'a' }, sam);
    assert.deepEqual(boardNeeds(store.getBoard(b), 'Sam'), []);
    assert.equal(boardNeeds(store.getBoard(b), 'Alex')[0].why, 'asked of you');
  });

  it(`folds more than ${FOLD_OVER} of one kind on one board into one row`, () => {
    const b = store.createBoard({ title: 'Big' }, sam).id;
    const reviews = ['A', 'B', 'C', 'D'].map((t) => work(b, t, 'in_review'));
    const blocked = ['E', 'F', 'G'].map((t) => work(b, t, 'blocked'));
    const report = needsAcross(boards(), 'Sam');
    assert.equal(report.total, 7, 'the count is of items, not rows');
    assert.equal(report.rows.length, 4, 'four reviews fold; three blocked stay as they are');
    const [folded] = report.rows;
    assert.equal(folded.count, 4);
    assert.equal(folded.why, '4 to review');
    assert.equal(folded.action, 'Review');
    assert.equal(folded.ref, undefined);
    assert.equal(folded.title, `T${reviews[0].number}, T${reviews[1].number}, T${reviews[2].number} and T${reviews[3].number}`);
    assert.deepEqual(folded.target, { kind: 'board', view: 'tasks' });
    assert.deepEqual(
      report.rows.slice(1).map((r) => [r.ref, r.count]).sort(),
      blocked.map((t) => [`T${t.number}`, 1]),
    );
    assert.equal(new Set(report.rows.map((r) => r.key)).size, report.rows.length, 'row keys are unique');
  });

  it('leaves archived boards out', () => {
    const b = store.createBoard({ title: 'Old' }, sam).id;
    ask(b, 'Still relevant?', { blocking: true });
    assert.equal(needsAcross(boards(), 'Sam').total, 1);
    store.setArchived(b, true, sam);
    const report = needsAcross(boards(), 'Sam');
    assert.equal(report.total, 0);
    assert.deepEqual(report.projects, []);
    assert.deepEqual(boardNeeds(store.getBoard(b), 'Sam'), []);
  });

  // What the viewer's page has: the board as seen up to `seq`, what is unseen, and what they dismissed.
  const viewing = (boardId: string, seq: number, me = 'Sam') => ({
    seen: { [boardKey(store.getBoard(boardId))]: seq },
    unseen: (board: Board, since: number) => store.events(board.id, { since, unseenBy: me }),
    dismissed: store.dismissedNeeds(me),
  });

  describe('what only tells you clears once seen; what asks you stays', () => {
    it('shows a mention that only tags you as news to read, and clears it once you have seen the board', () => {
      const b = store.createBoard({ title: 'Mentions' }, sam).id;
      store.createBoard({ title: 'Elsewhere' }, alex);
      const task = work(b, 'Pick a font');
      const before = store.getBoard(b).seq;
      store.addTaskComment(task.id, '@Sam FYI: the 600 weight is in.', claude);

      assert.equal(needsAcross(boards(), 'Sam').total, 0, 'a board never opened here has nothing unseen');
      const [row] = needsAcross(boards(), 'Sam', viewing(b, before)).rows;
      assert.deepEqual([row.ref, row.kind, row.why, row.action], [`T${task.number}`, 'reply', 'Claude mentioned you', 'Read']);
      assert.equal(needsAcross(boards(), 'Alex', viewing(b, before, 'Alex')).total, 0, 'only the person mentioned');
      assert.equal(needsAcross(boards(), 'Sam', viewing(b, store.getBoard(b).seq)).total, 0, 'seen once the board has been');

      // The board's page: opening the card sees it too.
      const board = store.getBoard(b);
      const unseen = store.events(b, { since: before, unseenBy: 'Sam' });
      assert.deepEqual(needsFrom(board, 'Sam', unseen).map((n) => n.kind), ['reply']);
      assert.deepEqual(needsFrom(board, 'Sam', unseen.filter((e) => e.taskId !== task.id)), []);
    });

    it('keeps an open decision asked of you after you have seen it', () => {
      const b = store.createBoard({ title: 'Asks' }, sam).id;
      const asked = ask(b, 'Which queue?', { ask: ['Sam'] });
      const seq = store.getBoard(b).seq;
      store.addComment(asked.id, '@Sam this one is yours.', claude);
      const rows = needsAcross(boards(), 'Sam', viewing(b, store.getBoard(b).seq)).rows;
      assert.deepEqual(rows.map((r) => [r.ref, r.kind, r.why, r.action]), [[`#${asked.number}`, 'asked', 'asked of you', 'Decide']]);
      assert.deepEqual(needsAcross(boards(), 'Sam', viewing(b, seq)).rows.map((r) => r.kind), ['asked']);
    });

    it('keeps what ask_people asked until you answer', () => {
      const b = store.createBoard({ title: 'People' }, sam).id;
      const d = ask(b, 'Which broker?');
      store.addComment(d.id, 'I can take it.', sam); // Sam is one of the board's people
      store.askPeople(d.id, ['Sam'], 'You know the queue best', claude);
      const stays = () => needsAcross(boards(), 'Sam', viewing(b, store.getBoard(b).seq)).rows.map((r) => [r.ref, r.kind]);
      assert.deepEqual(stays(), [[`#${d.number}`, 'asked']]);
      store.addComment(d.id, 'Seen, not yet.', claude);
      assert.deepEqual(stays(), [[`#${d.number}`, 'asked']], 'still there after it has been seen');
      store.addComment(d.id, 'Use Kafka.', sam);
      assert.deepEqual(stays(), [[`#${d.number}`, 'open']], 'answered: no longer asked of you, and the question is still open');
    });
  });

  describe('dismissing', () => {
    it('hides a row that is not a decision, for that person, until something new happens on its card', async () => {
      const b = store.createBoard({ title: 'Reviews' }, sam).id;
      store.createBoard({ title: 'Other' }, alex);
      const task = work(b, 'Add jitter', 'in_review');
      const total = (me = 'Sam') => needsAcross(boards(), me, { dismissed: store.dismissedNeeds(me) }).total;
      assert.equal(total(), 1);

      const [row] = needsAcross(boards(), 'Sam').rows;
      assert.deepEqual(row.items, [{ key: task.id, at: row.at }]);
      store.dismissNeeds(b, 'sam', row.items);
      assert.equal(total(), 0, 'dismissed, whatever the case of the name');
      assert.equal(total('Alex'), 1, "dismissals are a person's own");
      assert.equal(boardNeeds(store.getBoard(b), 'Sam', [], store.dismissedNeeds('Sam')[boardKey(store.getBoard(b))]).length, 0);

      store.addTaskComment(task.id, 'Pushed a fix for the nits.', claude);
      assert.equal(total(), 1, 'new activity on the card brings it back');
      assert.equal(needsAcross(boards(), 'Sam').rows[0].kind, 'review');

      // Kept on the server: a new Store on the same data still has it.
      store.dismissNeeds(b, 'Sam', needsAcross(boards(), 'Sam').rows[0].items);
      await store.flush();
      store.load();
      assert.equal(total(), 0);
    });

    it('dismisses all of a folded row, and a reply you have not seen', () => {
      const b = store.createBoard({ title: 'Big' }, sam).id;
      ['A', 'B', 'C', 'D'].forEach((t) => work(b, t, 'in_review'));
      const [folded] = needsAcross(boards(), 'Sam').rows;
      assert.equal(folded.count, 4);
      assert.equal(folded.items.length, 4);
      store.dismissNeeds(b, 'Sam', folded.items);
      assert.equal(needsAcross(boards(), 'Sam', { dismissed: store.dismissedNeeds('Sam') }).total, 0);

      const mark = store.getBoard(b).seq;
      const [task] = store.planTasks(b, [{ title: 'Note' }], sam);
      store.addTaskComment(task.id, '@Sam heads up.', claude);
      const [reply] = needsAcross(boards(), 'Sam', viewing(b, mark)).rows;
      assert.equal(reply.kind, 'reply');
      store.dismissNeeds(b, 'Sam', reply.items);
      assert.equal(needsAcross(boards(), 'Sam', viewing(b, mark)).total, 0);
      store.addTaskComment(task.id, '@Sam and another thing.', claude);
      assert.equal(needsAcross(boards(), 'Sam', viewing(b, mark)).total, 1, 'a newer reply is news again');
    });

    it('does not offer dismissing on a decision, and keeps one listed even if a dismissal was sent', () => {
      const b = store.createBoard({ title: 'Decisions' }, sam).id;
      const blocking = ask(b, 'Retry POSTs?', { blocking: true });
      const asked = ask(b, 'Which queue?', { ask: ['Sam'] });
      const open = ask(b, 'Log retries?');
      const confirm = ask(b, 'How many attempts?');
      store.resolve(confirm.id, { optionId: 'a', provisional: true }, claude);
      work(b, 'Add jitter', 'in_review');
      work(b, 'Wire it', 'blocked');
      const rows = needsAcross(boards(), 'Sam').rows;
      assert.deepEqual(
        rows.map((r) => [r.ref, r.kind, dismissable(r)]),
        [
          [`#${blocking.number}`, 'blocking', false],
          [`#${asked.number}`, 'asked', false],
          [rows[2].ref, 'review', true],
          [`#${confirm.number}`, 'confirm', false],
          [rows[4].ref, 'blocked', true],
          [`#${open.number}`, 'open', false],
        ],
      );
      store.dismissNeeds(b, 'Sam', rows.flatMap((r) => r.items));
      const after = needsAcross(boards(), 'Sam', { dismissed: store.dismissedNeeds('Sam') });
      assert.deepEqual(after.rows.map((r) => r.kind), ['blocking', 'asked', 'confirm', 'open'], 'only the decisions are left, all of them');
    });

    it("counts the same in a board's pill as in the list", () => {
      const b = store.createBoard({ title: 'Counts' }, sam).id;
      store.createBoard({ title: 'Quiet' }, sam);
      ask(b, 'Retry POSTs?', { blocking: true });
      const review = work(b, 'Add jitter', 'in_review');
      const mark = store.getBoard(b).seq;
      store.addTaskComment(work(b, 'Pick a font').id, '@Sam FYI, done.', claude);
      const page = () => {
        const board = store.getBoard(b);
        const dismissed = store.dismissedNeeds('Sam')[boardKey(board)];
        return needsFrom(board, 'Sam', store.events(b, { since: mark, unseenBy: 'Sam' }), dismissed);
      };
      const list = () => needsAcross(boards(), 'Sam', viewing(b, mark));
      assert.equal(page().length, 3);
      assert.deepEqual([list().total, list().projects.find((p) => p.title === 'Counts')!.needs], [3, 3]);
      store.dismissNeeds(b, 'Sam', [{ key: review.id, at: store.getTask(review.id).task.updatedAt }]);
      assert.equal(page().length, 2);
      assert.deepEqual([list().total, list().rows.reduce((n, r) => n + r.count, 0), list().projects.find((p) => p.title === 'Counts')!.needs], [2, 2, 2]);
    });
  });

  it('flags replies you have not seen, a first look among them', () => {
    const b = store.createBoard({ title: 'Roadmap' }, sam).id;
    store.presentAgents = () => ['Claude'];
    const [card] = store.planTasks(b, [{ title: 'Redesign the homepage', assignee: 'Claude' }], sam);
    const before = store.getBoard(b).seq;
    store.takeFirstLook(card.id, claude);
    store.addTaskComment(card.id, 'Feasible: one endpoint and a new Home. Mock on the canvas.', claude);
    const seen = (seq: number) => ({ seen: { [boardKey(store.getBoard(b))]: seq }, unseen: (board: Board, since: number) => store.events(board.id, { since, unseenBy: 'Sam' }) });

    assert.equal(needsAcross(boards(), 'Sam').total, 0, 'a board never opened here has nothing unseen');
    const [row] = needsAcross(boards(), 'Sam', seen(before)).rows;
    assert.deepEqual([row.ref, row.kind, row.why, row.action, row.square], [`T${card.number}`, 'reply', 'Claude replied with a first look', 'Read', 'backlog']);
    assert.equal(needsAcross(boards(), 'Sam', seen(store.getBoard(b).seq)).total, 0, 'seen once you looked');

    store.addTaskComment(card.id, 'Also, the bell could go global.', claude);
    assert.equal(needsAcross(boards(), 'Sam', seen(before)).rows[0].why, 'Claude replied', 'the latest reply speaks');

    const d = ask(b, 'Which layout?');
    store.addComment(d.id, 'I prefer the list', sam);
    store.resolve(d.id, { optionId: 'a' }, sam);
    const mark = store.getBoard(b).seq;
    store.addComment(d.id, 'Built it that way.', claude);
    const reply = needsAcross(boards(), 'Sam', seen(mark)).rows.find((r) => r.ref === `#${d.number}`)!;
    assert.deepEqual([reply.kind, reply.why, reply.action], ['reply', 'Claude replied', 'Read']);
  });

  it('opens a reply on a part of the board context at its pin, a website’s element among them, and a finished request on the board context', () => {
    const b = store.createBoard({ title: 'Launch site' }, sam).id;
    const site = store.addBlock({ boardId: b }, { content: { type: 'site', url: 'http://localhost:5173/' } }, sam);
    const plans = { kind: 'site', page: '/pricing', selector: '#plans', tag: 'h2', text: 'Plans' } as const;
    const { pin } = store.pinComment(site.id, plans, 'Make the plans bolder.', sam, { ask: true });
    const request = store.askAgents(b, 'Get me an architecture view', sam);
    const before = store.getBoard(b).seq;
    // An agent pairing on the website answers on the element (T258), and another finishes the request.
    store.commentOnPin(pin.id, 'Made them bold.', claude);
    const { group } = store.takeRequest(request.id, claude);
    store.addBlock({ boardId: b }, { content: { type: 'note', text: 'Web, server, store' }, groupId: group!.id } as never, claude);
    store.finishRequest(request.id, 'Added the architecture view.', claude);
    const unseen = () => unseenBy(eventsOf(store, b), before, 'Sam');
    const needs = needsFrom(store.getBoard(b), 'Sam', unseen());

    const reply = needs.find((n) => n.key === pin.id)!;
    assert.deepEqual([reply.kind, reply.why, reply.action, reply.square], ['reply', 'Claude replied', 'Read', 'context']);
    assert.equal(reply.title, `“${pin.quote}” on the board context`);
    assert.deepEqual(reply.target, { kind: 'pin', id: pin.id });
    const address = needLink(b, reply.target);
    assert.equal(address, linkTo.pin(b, pin.id));
    assert.deepEqual(pageAt(address), { page: 'board', boardId: b, view: 'canvas', decisionId: undefined, taskId: undefined, pinId: pin.id }, 'the Board Context, opening the pin');

    const finished = needs.find((n) => n.key === request.id)!;
    assert.equal(finished.why, 'Claude answered your request');
    assert.deepEqual(finished.target, { kind: 'board', view: 'canvas' });
    assert.equal(needLink(b, finished.target), linkTo.board(b, 'canvas'));

    // Unpinned since, its thread went with it: nothing is left to read.
    store.removeItem(pin.id, sam);
    assert.equal(needsFrom(store.getBoard(b), 'Sam', unseen()).find((n) => n.key === pin.id), undefined);
  });

  it(`folds more than ${FOLD_OVER} replies on the board context into a row that opens it`, () => {
    const b = store.createBoard({ title: 'Notes' }, sam).id;
    const pins = ['A', 'B', 'C', 'D'].map((text) => {
      const note = store.addBlock({ boardId: b }, { content: { type: 'note', text } }, claude);
      return store.pinComment(note.id, { kind: 'block' }, `About ${text}?`, sam).pin;
    });
    const before = store.getBoard(b).seq;
    for (const pin of pins) store.commentOnPin(pin.id, 'Yes.', claude);
    const needs = needsFrom(store.getBoard(b), 'Sam', unseenBy(eventsOf(store, b), before, 'Sam'));
    assert.deepEqual(needs.map((n) => n.target), pins.map((p) => ({ kind: 'pin', id: p.id })));
    const [folded] = needRows(needs);
    assert.equal(folded.count, 4);
    assert.equal(folded.title, '4 on the board context');
    assert.deepEqual(folded.target, { kind: 'board', view: 'canvas' });
    assert.equal(needLink(b, folded.target), linkTo.board(b, 'canvas'));
  });

  it("lists one board's needs from the events its page has unseen, as Home does", () => {
    const b = store.createBoard({ title: 'Row' }, sam).id;
    const task = work(b, 'Wire the backoff', 'blocked');
    const before = store.getBoard(b).seq;
    const d = ask(b, 'Retry POSTs?', { blocking: true });
    store.addComment(d.id, 'I would not', sam);
    store.resolve(d.id, { optionId: 'a' }, sam);
    store.addComment(d.id, 'Built it that way.', claude);
    const board = store.getBoard(b);
    const unseen = unseenBy(eventsOf(store, board), before, 'Sam');

    const needs = needsFrom(board, 'Sam', unseen).sort(byUrgency);
    assert.deepEqual(needs, boardNeeds(board, 'Sam', store.events(b, { since: before, unseenBy: 'Sam' })).sort(byUrgency));
    assert.deepEqual(needs.map((n) => [n.ref, n.kind]), [[`T${task.number}`, 'blocked'], [`#${d.number}`, 'reply']]);
    // A card the page has opened is seen: its reply no longer needs you.
    const opened = unseen.filter((e) => e.decisionId !== d.id);
    assert.deepEqual(needsFrom(board, 'Sam', opened).map((n) => n.kind), ['blocked']);
    store.setArchived(b, true, sam);
    assert.deepEqual(needsFrom(store.getBoard(b), 'Sam', unseen), []);
  });

  it('shows each board at a glance: a square per item in play, what is settled, and its agents', () => {
    const b = store.createBoard({ title: 'Glance' }, sam).id;
    const blocking = ask(b, 'Retry POSTs?', { blocking: true });
    const exploring = ask(b, 'Which curve?');
    store.requestExploration(exploring.id, undefined, sam);
    const done = ask(b, 'Log them?');
    store.resolve(done.id, { optionId: 'a' }, sam);
    const deferred = ask(b, 'Metrics?');
    store.defer(deferred.id, undefined, sam);
    const busy = work(b, 'Wire it');
    store.claimTask(busy.id, claude);
    const backlog = store.planTasks(b, [{ title: 'Later' }], sam)[0];

    const work_ = boardWork(store.getBoard(b));
    assert.deepEqual(
      work_.squares.map((s) => s.square),
      ['blocking', 'exploring', 'in_progress', 'backlog', 'deferred'],
    );
    assert.equal(work_.squares[0].label, `#${blocking.number} open, blocking: Retry POSTs?`);
    assert.equal(work_.squares[2].label, `T${busy.number} in progress: Wire it`);
    assert.equal(work_.squares[3].label, `T${backlog.number} backlog: Later`);
    assert.deepEqual([work_.decided, work_.done, work_.decisions, work_.tasks], [1, 0, 4, 2]);

    const present = (board: Board): PresentAgent[] =>
      board.id === b
        ? [
            { name: 'Codex', lastSeen: new Date().toISOString(), state: 'listening' },
            { name: 'Claude', lastSeen: new Date().toISOString(), state: 'working' },
          ]
        : [];
    const report: NeedsReport = needsAcross(boards(), 'Sam', { present });
    const [project] = report.projects;
    assert.deepEqual(
      project.agents.map((a) => [a.name, a.state, a.on]),
      [
        ['Claude', 'working', `T${busy.number}`],
        ['Codex', 'listening', undefined],
      ],
      'working first, on the task it has in progress',
    );
    assert.deepEqual(project.lastAgent?.name, 'Claude');
    assert.deepEqual(
      report.agents.map((a) => [a.name, a.board]),
      [
        ['Claude', 'Glance'],
        ['Codex', 'Glance'],
      ],
    );
    const focused = needsAcross(boards(), 'Sam', {
      present: () => [{ name: 'Claude', lastSeen: new Date().toISOString(), state: 'working', focus: { kind: 'decision', id: blocking.id } }],
    });
    assert.equal(focused.projects[0].agents[0].on, `#${blocking.number}`, 'the card its calls are about comes first');
  });

  it('says no agent has been on a board that none has touched', () => {
    store.createBoard({ title: 'Empty' }, sam);
    const [project] = needsAcross(boards(), 'Sam').projects;
    assert.equal(project.lastAgent, undefined);
    assert.deepEqual(project.agents, []);
    assert.deepEqual(project.work, { squares: [], decisions: 0, tasks: 0, decided: 0, done: 0 });
  });
});

describe('GET /api/needs', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let client: Client;
  let store: Store;

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-needs-api-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
  });

  after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  const get = async (query: string) => {
    const response = await fetch(`${base}/api/needs?${query}`);
    return { status: response.status, json: await response.json() };
  };

  it("lists what needs a person across boards in use, with each board's agents", async () => {
    const live = store.createBoard({ title: 'Live' }, sam);
    const old = store.createBoard({ title: 'Old' }, sam);
    const d = store.postDecision(live.id, { question: 'Retry POSTs?', options: [{ label: 'No' }], blocking: true }, claude);
    store.postDecision(old.id, { question: 'Still?', options: [{ label: 'Yes' }] }, claude);
    store.setArchived(old.id, true, sam);
    await client.callTool({ name: 'get_board', arguments: { board_id: live.id } });

    const { status, json } = await get('name=Sam');
    assert.equal(status, 200);
    const report = json as NeedsReport;
    assert.equal(report.total, 1);
    assert.deepEqual(
      report.rows.map((r) => [r.board, r.ref, r.why, r.target]),
      [['Live', `#${d.number}`, 'blocking', { kind: 'decision', id: d.id }]],
    );
    assert.deepEqual(report.projects.map((p) => p.title), ['Live'], 'archived boards are left out');
    assert.deepEqual(report.projects[0].agents.map((a) => [a.name, a.state]), [['Claude', 'working']]);
    assert.deepEqual(report.agents.map((a) => [a.name, a.board]), [['Claude', 'Live']]);
  });

  it('reads what the person has seen, and refuses what it cannot read', async () => {
    const board = store.createBoard({ title: 'Seen' }, sam);
    store.presentAgents = () => ['Claude'];
    const [task] = store.planTasks(board.id, [{ title: 'Card', assignee: 'Claude' }], sam);
    const before = store.getBoard(board.id).seq;
    store.addTaskComment(task.id, 'Looks feasible.', claude);
    const unseen = await get(`name=Sam&seen=${encodeURIComponent(JSON.stringify({ [boardKey(board)]: before }))}`);
    assert.ok((unseen.json as NeedsReport).rows.some((r) => r.ref === `T${task.number}` && r.why === 'Claude replied with a first look'));
    const seen = await get(`name=Sam&seen=${encodeURIComponent(JSON.stringify({ [boardKey(board)]: store.getBoard(board.id).seq }))}`);
    assert.ok(!(seen.json as NeedsReport).rows.some((r) => r.ref === `T${task.number}`));

    assert.equal((await get('')).status, 400, 'a name is needed');
    const bad = await get('name=Sam&seen=not-json');
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /seen must be a JSON object/);
    assert.equal((await get(`name=Sam&seen=${encodeURIComponent('{"a":-1}')}`)).status, 400);
  });

  it('dismisses a need for a person, and brings it back on new activity', async () => {
    const board = store.createBoard({ title: 'Dismissals' }, sam);
    const [task] = store.planTasks(board.id, [{ title: 'Add jitter' }], claude);
    store.claimTask(task.id, claude);
    store.addBlock({ taskId: task.id }, { title: 'Result', content: { type: 'note', text: 'Where it got to.' } }, claude);
    store.updateTask(task.id, { status: 'in_review', note: 'Done' }, claude);
    const post = async (body: unknown) => {
      const response = await fetch(`${base}/api/needs/dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
      return { status: response.status, json: await response.json() };
    };
    const mine = (json: unknown) => (json as NeedsReport).rows.filter((r) => r.boardId === board.id);
    const [row] = mine((await get('name=Sam')).json);
    assert.equal(row.kind, 'review');

    const done = await post({ name: 'Sam', board: board.id, items: row.items });
    assert.equal(done.status, 200);
    assert.deepEqual(done.json, { [boardKey(board)]: { [task.id]: row.at } });
    assert.deepEqual(mine((await get('name=Sam')).json), []);
    assert.equal(mine((await get('name=Alex')).json).length, 1, "it is Sam's dismissal");
    assert.deepEqual(await (await fetch(`${base}/api/needs/dismissed?name=sam`)).json(), done.json);

    store.addTaskComment(task.id, 'One more thing.', claude);
    assert.equal(mine((await get('name=Sam')).json).length, 1);

    assert.equal((await post({ name: 'Sam', board: 'no-such-board', items: row.items })).status, 404);
    assert.equal((await post({ name: 'Sam', board: board.id, items: [] })).status, 400);
  });
});
