import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import type { BoardWork } from '../src/core/projects';
import { Store } from '../src/core/store';
import type { Actor, BoardSummary } from '../src/core/types';
import { canvasServer } from './canvasEdition';
import { CANVAS_ROOT, pageScript, type Results, type Said } from './canvasPageScript';
import { withHandWrittenCards } from './handWrittenCards';
import { CHROME, runInChrome } from './mermaidPage';
import { removeScratch } from './platform';

// Tricot Canvas's page, in headless Chrome, in the real components of web/canvasApp.tsx, over a board that a real
// Canvas server describes (the page's own requests are answered with what it answered), with a decision and a task
// written into what it said by hand, which the core cannot make and the page has no kind of card for. Canvas's Home says
// nothing of decisions, tasks, questions or what needs you: a headline, and each project as its title, its description,
// the agents on it and when it changed. Its board is its Home, the Sketchbook and the Files, landing on its Home, with the notification bell in the header
// where a part has the inbox, counting the threads that wait on the viewer, the comments that mention them and the agents
// waiting for their OK, with the switch of notifications in its panel, and no Overview, Tasks, Context, Needs strip
// or Feed. The page with a part, as its root component builds it, is its counterpart's.

const sam: Actor = { kind: 'human', name: 'Sam' };
const claude: Actor = { kind: 'agent', name: 'Claude' };

// What a Canvas server answers the page about one board with a page and a thread that waits on Sam, and what a server
// that kept decisions and tasks would add to it, written by hand: the cards on the board, their counts in the boards
// listed, and the work and what needs Sam in Home's projects.
async function fixture(): Promise<{ canvas: Said; plain: Said; boardId: string; thread: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-canvas-page-'));
  const made = new Store(dir);
  try {
    made.load();
    const board = made.createBoard({ title: 'Shop', goal: 'Take card payments' }, sam);
    const page = made.addPage(board.id, 'Checkout flow', sam);
    const steps = made.addBlock({ pageId: page.id }, { title: 'Steps', content: { type: 'note', text: 'Cart, address, pay.' } }, claude);
    made.pinComment(steps.id, { kind: 'text', quote: 'address' }, '@Sam should the address come before the cart?', claude);
    const thread = made.startThread(board.id, 'Can you sketch the address step?', sam, null, { door: 'threads', pageId: page.id });
    made.postToThread(thread.id, 'Sketched it on the page, tell me what to change.', claude);
    await made.flush();
    const server = await canvasServer({}, dir);
    try {
      const get = async (address: string) => (await fetch(`${server.base}${address}`)).json();
      const said: Said = {
        boards: await get('/api/boards'),
        needs: await get('/api/needs?name=Sam&seen=%7B%7D'),
        board: (await get(`/api/boards/${board.id}`)) as Said['board'],
        events: await get(`/api/boards/${board.id}/events?since=0&limit=500`),
        info: await get('/api/info'),
      };
      return { canvas: withCards(said, sam), plain: said, boardId: board.id, thread: thread.id };
    } finally {
      await server.stop();
    }
  } finally {
    removeScratch(dir);
  }
}

// The work a server that kept the two hand-written cards would report (what a part's boardWork makes of them).
const WORK: BoardWork = {
  squares: [
    { square: 'open', label: '#1 open: Which provider?' },
    { square: 'todo', label: 'T1 to do: Wire up Stripe' },
  ],
  decisions: 1,
  tasks: 1,
  decided: 0,
  done: 0,
};

function withCards(said: Said, by: Actor): Said {
  const { board } = withHandWrittenCards(said.board as never, by);
  const { decisions, tasks } = board as unknown as Record<'decisions' | 'tasks', unknown>;
  const [summary] = said.boards as (BoardSummary & { counts: Record<string, number> })[];
  const [project] = (said.needs as { projects: { needs: number; work: unknown }[] }).projects;
  return {
    ...said,
    board: { ...said.board, decisions, tasks },
    boards: [{ ...summary, counts: { ...summary.counts, open: 1 } }],
    needs: { ...(said.needs as object), projects: [{ ...project, needs: 1, work: WORK }] },
  };
}

const SKIP = { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' };
// What Canvas's Home may not say, in any of its words.
const FULL_HOME = /decision|task|question|needs? you|need you|nothing on it/i;

describe("Tricot Canvas's page, built with no registry of a part's", SKIP, () => {
  let results: Results;
  before(async () => {
    const data = await fixture();
    results = await runInChrome(pageScript(data.canvas, data.boardId, CANVAS_ROOT), { width: 1440, height: 900 }, 'reduced');
  });

  it("opens Home as the projects: a headline of its own, then each project as its title, its description, its agents and when it changed, and says nothing of decisions, tasks, questions or what needs you", () => {
    assert.equal(results.error, undefined);
    assert.deepEqual(results.errors, []);
    assert.equal(results.home.page, true);
    assert.equal(results.home.headline, 'Your projects');
    assert.deepEqual(results.home.rows.map(({ title, goal }) => ({ title, goal })), [{ title: 'Shop', goal: 'Take card payments' }]);
    const [row] = results.home.rows;
    assert.ok(row.plain && row.agent && row.when, 'a plain row with its agents and its time');
    assert.ok(!row.needs && !row.work && row.squares === 0, 'no needs tag, no column of work, no status squares');
    assert.ok(!results.home.needsList && !results.home.bell, 'no list of what needs you, and no bell');
    assert.doesNotMatch(results.home.main, FULL_HOME, results.home.main);
  });

  it('opens a board on its Home, with the Files door and its chat bar, and no Overview, Tasks, Context, inbox, Needs strip or Feed', () => {
    assert.match(results.board.hash, /^#\/b\/[^/]+\/home$/, "the landing, the board's Home, at its own address");
    assert.deepEqual(results.board.tabs.map((tab) => tab.replace(/ \d+$/, '')), ['Home', 'Sketchbook']);
    assert.ok(results.board.home && results.board.files && results.board.chat && !results.board.sketchbook);
    assert.ok(!results.board.inbox && !results.board.needs && !results.board.feed, 'what a part puts in the header and beside the tabs is not there');
    assert.doesNotMatch(results.board.body, /Overview|Tasks|Decisions|Context|Needs you|Feed/, results.board.body);
  });

  it('shows the bell in the header with the thread that waits on Sam and the comment that mentions him, a click on a row opens it where it is, and the notifications are off until switched on', () => {
    assert.deepEqual(results.sketchbook.bell, { label: 'Notifications: 2 new', count: '2' });
    assert.equal(results.panel?.open, true);
    assert.deepEqual(results.panel?.headings, ['Threads waiting on you', 'New mentions and replies']);
    assert.equal(results.panel?.rows.length, 2);
    assert.match(results.panel?.rows[0] ?? '', /Can you sketch the address step\? Claude Sketched it on the page/);
    assert.match(results.panel?.rows[1] ?? '', /Claude @Sam should the address come before the cart\? Mentioned you/);
    assert.deepEqual(results.panel?.notify, { label: 'Sound and desktop notifications', on: false });
    assert.deepEqual(results.opened, { panelClosed: true, docked: true, text: true });
    assert.equal(results.mention?.shown, true, 'the comment opens where it is said');
  });

  it("answers an address of one of a part's pages with the board's landing, its Home, and throws nothing", () => {
    assert.ok(results.fullAddress.page && results.fullAddress.home);
    assert.match(results.fullAddress.hash, /^#\/b\/[^/]+\/home$/);
    assert.deepEqual(results.fullAddress.tabs.map((tab) => tab.replace(/ \d+$/, '')), ['Home', 'Sketchbook']);
  });

  it("opens the board's Home: the conversation with its yarn, its own chat bar in place of the dock, and Work with the threads agents own and nothing of a part's", () => {
    const { timeline } = results;
    assert.ok(timeline.shown && timeline.yarn && timeline.bar, JSON.stringify(timeline));
    assert.equal(timeline.dock, false, 'no floating bar or docked panel over it');
    assert.ok(timeline.skein && !timeline.threadsInBar, 'the threads list opens from the ball at the top of the yarn, not from a button in the bar');
    assert.match(timeline.conversation, /Can you sketch the address step\?.*Sketched it on the page/);
    assert.match(timeline.work, /^Work Nothing open Nothing handed out yet/, 'no thread an agent owns, and none of the cards the board carries');
    assert.doesNotMatch(timeline.work, /T1|Wire up Stripe|review|backlog/i, timeline.work);
  });
});

// What a Canvas server answers about a board with no decision or task: no list of them in the board, no counts in the boards
// listed, and neither `work` nor `needs` on Home's projects (where Canvas has none, it says none). The page reads a missing list as an empty one, and shows what
// it shows over the same replies with the cards written in.
describe("Tricot Canvas's page, over replies that carry no decisions, tasks or counts", SKIP, () => {
  let plain: Results;
  let carried: Results;
  before(async () => {
    const data = await fixture();
    const board = data.plain.board as Record<string, unknown>;
    assert.deepEqual(['decisions', 'tasks'].filter((key) => key in board), [], 'the board carries no list');
    assert.equal('counts' in (data.plain.boards as BoardSummary[])[0], false, 'and the boards listed no counts');
    const [project] = (data.plain.needs as { projects: object[] }).projects;
    assert.deepEqual(['work', 'needs'].filter((key) => key in project), [], 'and the projects carry no work and no count of what needs the viewer');
    plain = await runInChrome(pageScript(data.plain, data.boardId, CANVAS_ROOT), { width: 1440, height: 900 }, 'reduced');
    carried = await runInChrome(pageScript(data.canvas, data.boardId, CANVAS_ROOT), { width: 1440, height: 900 }, 'reduced');
  });

  it('opens Home and the board with no error, and says what it says over replies that carry the cards', () => {
    assert.equal(plain.error, undefined);
    assert.deepEqual(plain.errors, []);
    assert.deepEqual(plain.home, carried.home);
    assert.deepEqual(plain.board, carried.board);
    assert.deepEqual(plain.sketchbook, carried.sketchbook);
    assert.deepEqual(plain.panel, carried.panel);
    assert.deepEqual(plain.timeline, carried.timeline);
  });
});
