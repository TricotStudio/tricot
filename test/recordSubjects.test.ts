import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { Store } from '../src/core/store';
import { Assets } from '../src/core/store/assets';
import { BoardDb } from '../src/core/store/boardDb';
import { Boards } from '../src/core/store/boards';
import type { Dirty } from '../src/core/store/boardRows';
import { EntityLists } from '../src/core/store/entityLists';
import type { EventSubject } from '../src/core/store/eventTables';
import { BoardRepository } from '../src/core/store/repository';
import { CanvasOwners, composeParts, type StorePart } from '../src/core/store/storePart';
import type { Actor } from '../src/core/types';
import { CardStore, TICKETS, cardPart } from './madeUpCards';
import { removeScratch } from './platform';
import { renderDigest, runRecordScenario } from './recordScenario';

// Recording an event names what it is about by registered subject: `record(board, actor, type, summary, about,
// options)`, where `about` is `{ decision, item, task }` and the subjects are the ones the Store's parts registered.
// The subject says which list's row a change saves and which agent an event about it is for, so the repository names no
// list and looks up no task. What was stored did not change, and these tests hold it to that: the golden is a scenario of
// the core's own events and a made-up kind of card (test/recordScenario.ts); a part's, made on the code before events named their subjects, is
// in its counterpart of this file.

const sam: Actor = { kind: 'human', name: 'Sam' };
const claude: Actor = { kind: 'agent', name: 'Claude' };

// What the scenario reaches: the types of event it records and the keys its stored bodies have, or the digest proves little.
// (`held` is a held comment, which only a part's decisions have, and its scenario has it.)
const TYPES = 22;
const KEYS = ['mentions', 'commentId', 'forAgent', 'itemId'];

const scratch: string[] = [];
const folder = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-record-'));
  scratch.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of scratch.splice(0)) removeScratch(dir);
});

describe('What record writes', () => {
  it('stores exactly the events the golden holds, byte for byte, in a Store with a made-up kind of card, in one with its list alone and with no part', async () => {
    const digest = await runRecordScenario({ full: folder(), canvas: folder(), bare: folder() });
    const golden = readFileSync(path.join(import.meta.dirname, 'recordSubjects.digest.txt'), 'utf8').split('\n');
    const now = renderDigest(digest).split('\n');
    for (let line = 0; line < Math.max(golden.length, now.length); line++) assert.equal(now[line], golden[line], `line ${line + 1} of recordSubjects.digest.txt`);
    // The scenario reaches every kind of event and every shape of a body, or the digest proves little.
    assert.equal(digest.types.length, TYPES, 'every type of event');
    for (const key of KEYS) {
      assert.ok(digest.shapes.some((shape) => shape.split(',').includes(key)), `a body with ${key}`);
    }
  });
});

describe('A Store with no part', () => {
  it('records the core’s own events and refuses an event about a decision or a task', () => {
    const dir = folder();
    const store = new Store(dir, { parts: [] });
    store.load();
    const board = store.createBoard({ title: 'Bare' }, sam);
    const page = store.addPage(board.id, 'Sketch', sam);
    const thread = store.startThread(board.id, 'What next?', sam);
    store.requestSync(board.id, undefined, sam);
    const events = store.events(board.id, { order: 'asc' });
    assert.deepEqual(events.map((e) => e.type), ['board_created', 'canvas_changed', 'thread_started', 'sync_requested']);
    // An event's decision and task columns are a part's fields of it: the core's events have neither.
    assert.deepEqual(events.map((e) => [(e as { decisionId?: string }).decisionId, e.itemId, (e as { taskId?: string }).taskId]), [[undefined, undefined, undefined], [undefined, page.id, undefined], [undefined, thread.id, undefined], [undefined, undefined, undefined]]);

    const repo = new BoardRepository(dir, new EntityLists([]), new CanvasOwners([]), [], [], composeParts<unknown>([]).events);
    repo.load();
    const held = repo.getBoard(board.id);
    const seq = held.seq;
    for (const about of [{ decision: 'abc' }, { task: 'abc' }, { item: page.id, task: 'abc' }]) {
      assert.throws(() => repo.record(held, sam, 'comment_added', 'x', about), /keeps no events about a (decision|task), so it cannot record one/);
    }
    assert.equal(held.seq, seq, 'a refused event takes no number');
    assert.equal(repo.events(held, { order: 'asc' }).length, events.length, 'and is not stored');
    repo.record(held, sam, 'board_updated', 'a core event with nothing named');
    repo.record(held, sam, 'canvas_changed', 'a core event about an item', { item: page.id });
    repo.record(held, sam, 'canvas_changed', 'a subject named with nothing in it is not named', { decision: undefined, task: undefined });
    assert.equal(held.seq, seq + 3);
  });
});

// What each change that logged an event marked to be saved, as the database was told of it.
interface Marked {
  type: string;
  all: boolean;
  decisions: string[];
  tasks: string[];
  tickets: string[];
  pages: string[];
}
function watchMarks(): Marked[] {
  const seen: Marked[] = [];
  const changed = BoardDb.prototype.changed;
  mock.method(BoardDb.prototype, 'changed', function (this: BoardDb, key: string, dirty: Dirty) {
    for (const event of dirty.events) seen.push({ type: event.type, all: dirty.all, decisions: [...dirty.decisions], tasks: [...dirty.tasks], tickets: [...dirty.of('tickets')], pages: [...dirty.pages] });
    return changed.call(this, key, dirty);
  });
  return seen;
}

describe('What a change marks to be saved', () => {
  const stores: [string, (dir: string) => CardStore][] = [
    ['a Store with the made-up kind of card', (dir) => new CardStore(dir)],
    ['a part with its list and no kind of card', (dir) => new CardStore(dir, { parts: [cardPart(TICKETS, { cards: false })] })],
  ];

  for (const [name, make] of stores) {
    it(`is the row of the card for a change about a ticket, a page's row for one on a page, and every row for one about nothing, in ${name}`, () => {
      const store = make(folder());
      store.load();
      const seen = watchMarks();
      try {
        const board = store.createBoard({ title: 'Marks' }, sam);
        const ticket = store.postCard(board.id, { title: 'Which?' }, claude);
        const page = store.addPage(board.id, 'Page', sam);
        const note = store.addBlock({ pageId: page.id }, { content: { type: 'note', text: 'Words to pin.' } }, sam);
        seen.length = 0;

        const marks = (type: string, change: () => void) => {
          seen.length = 0;
          change();
          const [one, ...rest] = seen.filter((mark) => mark.type === type);
          assert.ok(one && rest.length === 0, `one ${type} event`);
          return { all: one.all, tickets: one.tickets, pages: one.pages };
        };
        const marked = (tickets: string[], pages: string[], all = false) => ({ all, tickets, pages });

        assert.deepEqual(marks('comment_added', () => store.commentOnCard(ticket.id, 'A word.', sam)), marked([ticket.id], []), 'about a ticket');
        assert.deepEqual(marks('canvas_changed', () => store.updateCard(ticket.id, { title: 'Which one?' }, claude)), marked([ticket.id], []), 'a change to the ticket itself');
        assert.deepEqual(marks('canvas_changed', () => store.addBlock(store.ref(ticket), { content: { type: 'note', text: 'On the ticket.' } }, claude)), marked([ticket.id], []), 'an item on a ticket\'s canvas');
        assert.deepEqual(marks('canvas_changed', () => store.addBlock({ pageId: page.id }, { content: { type: 'note', text: 'On a page.' } }, sam)), marked([], [page.id]), 'an item on a page');
        assert.deepEqual(marks('comment_added', () => store.pinComment(note.id, { kind: 'text', quote: 'pin' }, 'A comment.', sam)), marked([], [page.id]), 'a pin with a comment, on a page');
        assert.deepEqual(marks('thread_started', () => store.startThread(board.id, 'A thread.', sam)), marked([], []), 'a thread, which is no row of a list');
        assert.deepEqual(marks('board_updated', () => store.setStanding(board.id, 'Going well.', claude)), marked([], [], true), 'about nothing: anything could have changed');
      } finally {
        mock.restoreAll();
      }
    });
  }
});

describe('A subject a part registers', () => {
  const ticket: EventSubject = { name: 'ticket', column: 'task_id', list: 'tasks', agent: (board, id) => (id === 'owned' ? 'Rex' : (board as unknown as { tasks?: { id: string; assignee?: string }[] }).tasks?.find((t) => t.id === id)?.assignee) };

  function repositoryWith(dir: string, subjects: EventSubject[]) {
    const part: StorePart<unknown> = { name: 'tickets', subjects };
    const repo = new BoardRepository(dir, new EntityLists([]), new CanvasOwners([]), [], [], composeParts([part]).events);
    repo.load();
    const board = new Boards(repo, new Assets(dir, repo)).createBoard({ title: 'Tickets' }, sam);
    return { repo, board };
  }

  it('says which list’s row a change saves and which agent an event about it is for, with no list or task named in the repository', async () => {
    const { repo, board } = repositoryWith(folder(), [ticket]);
    const seen = watchMarks();
    try {
      repo.record(board, sam, 'comment_added', 'about a ticket', { ticket: 'owned' });
      repo.record(board, sam, 'comment_added', 'about a ticket, for all', { ticket: 'owned' }, { forAgent: null });
      repo.record(board, sam, 'comment_added', 'about a ticket, for another', { ticket: 'owned' }, { forAgent: 'Kit' });
      repo.record(board, sam, 'comment_added', 'about a ticket nobody has', { ticket: 'other' });
    } finally {
      mock.restoreAll();
    }
    await repo.flush();
    const events = repo.events(board, { order: 'asc' }).slice(1);
    assert.deepEqual(events.map((e) => e.forAgent), ['Rex', undefined, 'Kit', undefined]);
    assert.deepEqual(seen.slice(-4).map((s) => s.tasks), [['owned'], ['owned'], ['owned'], ['other']], 'the subject’s own list is the one marked');
    assert.deepEqual(seen.slice(-4).map((s) => s.all), [false, false, false, false]);
    assert.equal(seen.every((s) => s.decisions.length === 0), true);
  });

  it('is refused by a Store that registered no such subject, and one with no list or agent marks and defaults nothing', () => {
    const { repo, board } = repositoryWith(folder(), []);
    assert.throws(() => repo.record(board, sam, 'comment_added', 'x', { ticket: 'owned' }), /keeps no events about a ticket/);
    const bare = repositoryWith(folder(), [{ name: 'ticket', column: 'task_id' }]);
    bare.repo.record(bare.board, sam, 'comment_added', 'x', { ticket: 'owned' });
    assert.equal(bare.repo.events(bare.board, { order: 'asc' }).length, 2, 'it records; there is no row to save and no agent to default to');
  });
});
