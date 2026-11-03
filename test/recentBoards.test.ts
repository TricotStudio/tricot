import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { byRecent, KEPT, matching, withOpened, without } from '../src/web/recentBoards';

const board = (id: string, updatedAt: string, title = id, goal?: string) => ({ id, title, goal, updatedAt });
const ids = (boards: { id: string }[]) => boards.map((b) => b.id);

describe('Recent boards', () => {
  it('moves the board just opened to the front, once', () => {
    assert.deepEqual(withOpened([], 'a'), ['a']);
    assert.deepEqual(withOpened(['a', 'b', 'c'], 'c'), ['c', 'a', 'b']);
    assert.deepEqual(withOpened(['c', 'a'], 'c'), ['c', 'a']);
  });

  it("drops a renamed board's earlier ids, so it's listed under the one it has now", () => {
    assert.deepEqual(withOpened(['old-x1', 'b', 'older-x1'], 'new-x1', ['older-x1', 'old-x1']), ['new-x1', 'b']);
  });

  it('forgets a deleted board under every id it had', () => {
    assert.deepEqual(without(['a', 'old-x1', 'b', 'new-x1'], ['new-x1', 'old-x1']), ['a', 'b']);
  });

  it(`keeps the latest ${KEPT}`, () => {
    const many = Array.from({ length: KEPT }, (_, i) => `b${i}`);
    const next = withOpened(many, 'new');
    assert.equal(next.length, KEPT);
    assert.equal(next[0], 'new');
    assert.equal(next.at(-1), `b${KEPT - 2}`);
  });

  it('lists the boards opened here first, the latest first, then the rest by their last change', () => {
    const boards = [
      board('quiet', '2026-10-01T00:00:00.000Z'),
      board('busy', '2026-10-30T00:00:00.000Z'),
      board('opened-long-ago', '2026-09-01T00:00:00.000Z'),
      board('just-opened', '2026-10-02T00:00:00.000Z'),
      board('busier', '2026-10-31T00:00:00.000Z'),
    ];
    assert.deepEqual(ids(byRecent(boards, ['just-opened', 'gone', 'opened-long-ago'])), [
      'just-opened',
      'opened-long-ago',
      'busier',
      'busy',
      'quiet',
    ]);
    assert.deepEqual(ids(byRecent(boards, [])), ['busier', 'busy', 'just-opened', 'quiet', 'opened-long-ago']);
    assert.deepEqual(ids(boards), ['quiet', 'busy', 'opened-long-ago', 'just-opened', 'busier'], 'leaves the list it was given as it was');
  });

  it('filters by every word typed, in the title or the goal, titles that match first', () => {
    const boards = [
      board('roadmap', '', 'Tricot roadmap', 'Tricot road to MVP'),
      board('retries', '', 'API client retry logic', 'Stop duplicate charges'),
      board('october', '', 'October Release', 'Ship the MVP in October'),
      board('partners', '', 'Partnership Program'),
    ];
    assert.deepEqual(ids(matching(boards, '')), ['roadmap', 'retries', 'october', 'partners']);
    assert.deepEqual(ids(matching(boards, '  ')), ['roadmap', 'retries', 'october', 'partners']);
    assert.deepEqual(ids(matching(boards, 'RETRY')), ['retries']);
    assert.deepEqual(ids(matching(boards, 'mvp')), ['roadmap', 'october']);
    assert.deepEqual(ids(matching(boards, 'october')), ['october']);
    assert.deepEqual(ids(matching(boards, 'ship october')), ['october']);
    assert.deepEqual(ids(matching(boards, 'road')), ['roadmap']);
    assert.deepEqual(ids(matching(boards, 'mvp road')), ['roadmap']);
    assert.deepEqual(ids(matching(boards, 'charges')), ['retries']);
    assert.deepEqual(ids(matching(boards, 'zebra')), []);
  });

  it('puts a title match ahead of a board that only matches on its goal', () => {
    const boards = [
      board('goal-only', '', 'Launch', 'Plan the roadmap for Q4'),
      board('title', '', 'Roadmap'),
    ];
    assert.deepEqual(ids(matching(boards, 'roadmap')), ['title', 'goal-only']);
  });
});
