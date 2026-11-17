import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoardViews, type BoardViewDef } from '../src/web/shared/boardViews';
import { RefKinds } from '../src/web/shared/refKinds';

// The registry of a board's views (web/shared/boardViews.ts): what the board's
// page is composed from, so it names no view of a part's. Built per page, never by
// loading a module: the core registers the Sketchbook and the Files
// (web/board/coreViews.tsx), a part the rest, as its page has it.

const view = (id: string, rest: Partial<BoardViewDef> = {}): BoardViewDef => ({ id: id as never, link: (boardId) => `#/b/${boardId}/${id}`, chat: () => 'threads', render: () => null, ...rest });

describe('The registry of board views', () => {
  it('lists the tabs in the order they say: before another, else after the last', () => {
    const views = new BoardViews();
    views.add(view('scratch', { label: 'Sketchbook' }));
    views.add(view('files'));
    views.add(view('canvas', { label: 'Overview', before: 'scratch' }));
    views.add(view('tasks', { label: 'Tasks' }));
    assert.deepEqual(views.tabs().map((v) => v.id), ['canvas', 'scratch', 'tasks']);
    assert.deepEqual(views.doors().map((v) => v.id), [], 'a view with no door has none');
  });

  it("refuses a second view of one id or of a name another is opened by, and a view that goes before one that isn't there", () => {
    const views = new BoardViews();
    views.add(view('canvas', { also: { decisions: () => '#/decisions' } }));
    assert.throws(() => views.add(view('canvas')), /two views of a board named canvas/);
    assert.throws(() => views.add(view('decisions')), /two views of a board named decisions/);
    assert.throws(() => views.add(view('tasks', { before: 'nowhere' as never })), /goes before nowhere, which is not registered/);
  });

  it('opens the view an address names, by another name it is opened by too, else the landing', () => {
    const views = new BoardViews();
    views.add(view('scratch', { label: 'Sketchbook' }));
    views.add(view('canvas', { also: { decisions: () => '#/decisions' }, label: 'Overview', before: 'scratch' }));
    assert.equal(views.viewAt('decisions')?.id, 'canvas');
    assert.equal(views.viewAt('scratch')?.id, 'scratch');
    assert.equal(views.viewAt('tasks')?.id, 'canvas', 'a view that is not registered opens the landing, the first tab');
    assert.equal(views.viewAt(undefined)?.id, 'canvas');
    views.landOn('scratch');
    assert.equal(views.landingView()?.id, 'scratch', 'a claimed landing wins over the first tab');
    assert.equal(views.viewAt('tasks')?.id, 'scratch');
    assert.throws(() => views.landOn('canvas'), /two landing views/);
  });

  it('is nothing but empty when nothing is registered, and says so without throwing', () => {
    const views = new BoardViews();
    assert.deepEqual([views.tabs(), views.doors(), views.cardPages()], [[], [], []]);
    assert.equal(views.viewAt('canvas'), undefined);
    assert.equal(views.landingView(), undefined);
    assert.equal(views.useSession({} as never), undefined);
    assert.deepEqual([views.feed(), views.home(), views.controls({} as never), views.needsStrip({} as never)], [undefined, undefined, undefined, undefined]);
    assert.ok(views.refKinds() instanceof RefKinds);
    assert.equal(views.refKinds(), views.refKinds(), 'the same one each time');
    assert.deepEqual(views.refKinds().kinds(), [], 'none, so #12 and T5 stay text');
  });

  it('takes one of each slot and one page of a kind of card, and refuses a second', () => {
    const views = new BoardViews();
    views.addCardPage({ kind: 'task', idAt: () => undefined, render: () => undefined });
    assert.throws(() => views.addCardPage({ kind: 'task', idAt: () => undefined, render: () => undefined }), /two pages of cards named task/);
    views.withSession(() => 1);
    assert.throws(() => views.withSession(() => 2), /two sessions/);
    assert.equal(views.useSession({} as never), 1);
    views.withHeaderControls(() => null);
    assert.throws(() => views.withHeaderControls(() => null), /two sets of header controls/);
    views.withNeedsStrip(() => null);
    assert.throws(() => views.withNeedsStrip(() => null), /two strips/);
    views.withFeed({ open: () => false, toggle: () => null, panel: () => null });
    assert.throws(() => views.withFeed({ open: () => false, toggle: () => null, panel: () => null }), /two feeds/);
    views.withHome({ controls: () => null, needs: () => null });
    assert.throws(() => views.withHome({ controls: () => null, needs: () => null }), /two sets of slots on Home/);
    const kinds = new RefKinds();
    views.withRefKinds(kinds);
    assert.throws(() => views.withRefKinds(new RefKinds()), /two sets of reference kinds/);
    assert.equal(views.refKinds(), kinds);
  });

  it("says plain words, and has no search part and no line about an agent's tasks, until a part registers them, and takes each once", () => {
    const views = new BoardViews();
    assert.equal(views.search(), undefined, 'the palette searches comments and canvases alone');
    assert.equal(views.agentWork(), undefined);
    assert.doesNotMatch(views.words().nameGate, /decision|task|decided/i, 'the name gate names none of them');
    assert.equal(views.words(), views.words(), 'the same one each time');
    const search = { filters: [], groups: {}, placeholder: 'Search', hint: 'Find', openOnly: { title: 'Open' }, result: () => ({ marker: '', tag: null }) };
    views.withSearch(search);
    assert.throws(() => views.withSearch(search), /two search slots/);
    assert.equal(views.search(), search);
    views.withWords({ nameGate: 'A part says' });
    assert.throws(() => views.withWords({ nameGate: 'again' }), /two sets of page words/);
    assert.equal(views.words().nameGate, 'A part says');
    const work = () => null;
    views.withAgentWork(work);
    assert.throws(() => views.withAgentWork(work), /two renderers of what an agent is working on/);
    assert.equal(views.agentWork(), work);
  });

  it('draws and names nothing of the board context, and offers no Keep in context, until a part registers it, and takes it once', () => {
    const views = new BoardViews();
    assert.equal(views.boardContext(), undefined, 'no sync marks, no selection bar and no name for the board context canvas');
    const keep = { label: 'Keep it', blockTitle: () => 'one', groupTitle: 'group', run: () => Promise.reject(new Error('not asked')) };
    const slot = { name: 'Board Context', generalThread: 'A note.', selection: () => null, blockTool: () => null, blockMarks: () => null, groupTool: () => null, keep };
    views.withBoardContext(slot);
    assert.throws(() => views.withBoardContext(slot), /two sets of tools for the board's own canvas/);
    assert.equal(views.boardContext(), slot);
    assert.equal(views.boardContext()?.keep, keep, 'the Keep in context of a Sketchbook page comes with it');
  });
});
