import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { emptyActivity } from '../src/core/activity';
import { emptyCanvas } from '../src/core/canvas';
import { tallyOf, type BoardChange, type LiveState } from '../src/core/changes';
import type { Actor, BoardEvent } from '../src/core/types';
import type { AgentPresence, AgentStep, LiveBoard } from '../src/web/api';
import { EventFeed } from '../src/web/events';
import { BoardSession, type SourceLike } from '../src/web/liveBoard';

const sam: Actor = { kind: 'human', name: 'Sam' };
const alex: Actor = { kind: 'human', name: 'Alex' };

class FakeSource implements SourceLike {
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  send(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
  }
  get since(): number {
    return Number(new URL(this.url, 'http://x').searchParams.get('since'));
  }
}

const event = (seq: number, extra: Partial<BoardEvent> = {}): BoardEvent => ({ seq, at: `2026-01-01T00:00:0${seq}Z`, actor: alex, type: 'comment_added', summary: `event ${seq}`, ...extra });

// The change that adds a decision `id` as number `ver`.
const posted = (ver: number, id: string): BoardChange => ({
  ver,
  seq: ver,
  events: [event(ver, { decisionId: id, type: 'decision_posted' })],
  head: { seq: ver, updatedAt: `t${ver}` },
  put: [{ kind: 'decision', id, pos: 0, body: { id, number: ver, question: `Question ${id}?`, comments: [], options: [] } }],
});
const commented = (ver: number, id: string, from: number): BoardChange => ({
  ver,
  seq: ver,
  events: [event(ver, { decisionId: id })],
  head: { seq: ver },
  patch: [{ kind: 'decision', id, append: { comments: { from, items: [{ body: `comment ${from}` }] } } }],
});

describe('A page keeping a board live', () => {
  let served: LiveBoard;
  let sources: FakeSource[];
  let shown: LiveBoard[];
  let errors: (string | null)[];
  let fetched: number;
  let checked: number;
  let deleted: number;
  let state: () => LiveState;
  let feed: EventFeed;
  let session: BoardSession;

  const make = (held: LiveBoard | null = null, onSteps?: (steps: AgentStep[]) => void) => {
    session = new BoardSession({
      boardId: 'b1',
      held,
      onSteps,
      feed: () => feed,
      fetchBoard: async () => {
        fetched++;
        return structuredClone(served);
      },
      fetchLive: async () => {
        checked++;
        return state();
      },
      open: (url) => {
        const source = new FakeSource(url);
        sources.push(source);
        return source;
      },
      onBoard: (board) => shown.push(board),
      onError: (message) => errors.push(message),
      onLive: () => {},
      onDeleted: () => deleted++,
    });
    return session;
  };
  const latest = () => shown.at(-1)!;
  const source = () => sources.at(-1)!;
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    served = {
      id: 'b1',
      title: 'Live',
      seq: 3,
      ver: 100,
      decisions: [],
      tasks: [],
      canvas: emptyCanvas(),
      activity: emptyActivity(),
      presence: [],
    } as unknown as LiveBoard;
    sources = [];
    shown = [];
    errors = [];
    fetched = 0;
    checked = 0;
    deleted = 0;
    feed = new EventFeed();
    state = () => ({ ver: latest().ver!, seq: latest().seq, tally: tallyOf(latest()) });
  });

  afterEach(() => {
    session?.stop();
    mock.timers.reset();
  });

  it('fetches the board once, then listens from its change number and applies what comes', async () => {
    make().start();
    await settle();
    assert.equal(fetched, 1);
    assert.equal(source().since, 100, 'from the change the fetched board is at');
    assert.deepEqual(shown.map((b) => b.decisions.length), [0]);

    source().send('change', posted(101, 'd1'));
    source().send('change', commented(102, 'd1', 0));
    assert.deepEqual(latest().decisions.map((d) => [d.id, d.comments.length]), [['d1', 1]]);
    assert.equal(latest().ver, 102);
    assert.equal(latest().seq, 102);
    assert.equal(fetched, 1, 'no more fetching');
    assert.equal(checked, 0);
    assert.deepEqual(latest().activity.actors.map((a) => a.actor.name), ['Alex']);
  });

  it('feeds the events it is sent to the histories, from where it fetched', async () => {
    make().start();
    await settle();
    source().send('change', posted(101, 'd1'));
    source().send('change', commented(102, 'd1', 0));
    assert.deepEqual(feed.since(3, 102)?.map((e) => e.seq), [101, 102]);
    assert.deepEqual(feed.since(101, 102)?.map((e) => e.seq), [102]);
    assert.equal(feed.since(2, 102), undefined, 'from before the page fetched: ask the server');
    assert.equal(feed.since(3, 103), undefined, 'not caught up');
  });

  it('shows presence from its own message, which fetches and checks nothing', async () => {
    make().start();
    await settle();
    const agents: AgentPresence[] = [{ name: 'Claude', lastSeen: 'now', state: 'working', focus: { kind: 'task', id: 't1' } }];
    source().send('presence', agents);
    assert.deepEqual(latest().presence, agents);
    assert.equal(latest().ver, 100, 'it is not a change');
    assert.equal(fetched + checked, 1, 'only the first fetch');
    source().send('presence', []);
    assert.deepEqual(latest().presence, []);
    assert.equal(fetched + checked, 1);
  });

  it("hands agents' steps on as they come, apart from the board", async () => {
    const heard: AgentStep[][] = [];
    make(null, (steps) => heard.push(steps)).start();
    await settle();
    const boards = shown.length;
    const steps: AgentStep[] = [{ agent: 'Claude', text: 'Running npm test', at: '2026-01-01T00:00:00Z', card: { kind: 'task', id: 't1' } }];
    source().send('steps', steps);
    assert.deepEqual(heard, [steps]);
    assert.equal(shown.length, boards, 'the board is not redrawn for a step');
    assert.equal(fetched + checked, 1, 'nor fetched or checked');
  });

  it('ignores a change it has, and reconnects from where it was when one went missing', async () => {
    make().start();
    await settle();
    source().send('change', posted(101, 'd1'));
    source().send('change', posted(101, 'd1'));
    assert.equal(shown.length, 2, 'the repeat changed nothing');

    const first = source();
    first.send('change', commented(103, 'd1', 0)); // 102 never came
    assert.equal(first.closed, true);
    assert.equal(sources.length, 2);
    assert.equal(source().since, 101, 'it says where it was');
    assert.equal(latest().ver, 101, 'and applied nothing out of order');
    first.send('change', commented(104, 'd1', 0));
    assert.equal(latest().ver, 101, 'the old connection is not heard any more');

    // The server sends what was missed.
    source().send('change', commented(102, 'd1', 0));
    source().send('change', commented(103, 'd1', 1));
    assert.deepEqual(latest().decisions[0].comments.length, 2);
    assert.equal(latest().ver, 103);
    assert.equal(fetched, 1, 'caught up from the changes the server kept, not from the board');
  });

  it('fetches the board once when the server says the changes are gone, then listens from there', async () => {
    make().start();
    await settle();
    source().send('change', posted(101, 'd1'));
    served = { ...served, ver: 500, seq: 90, decisions: [{ id: 'd9', comments: [] }] } as unknown as LiveBoard;
    source().send('reset', { ver: 500 });
    await settle();
    assert.equal(fetched, 2);
    assert.deepEqual(latest().decisions.map((d) => d.id), ['d9']);
    assert.equal(source().since, 500);
    assert.equal(feed.since(90, 90)?.length, 0, 'the feed starts again from the fetched board');
  });

  it('fetches the board when a change cannot be applied or asks for it', async () => {
    make().start();
    await settle();
    source().send('change', commented(101, 'nobody', 0));
    await settle();
    assert.equal(fetched, 2, 'a change to something it does not have');
    source().send('change', { ver: 101, seq: 4, reload: true } satisfies BoardChange);
    await settle();
    assert.equal(fetched, 3, 'a change too big to send');
  });

  it('reconnects from its last change when the browser reconnects after sleep or a lost network', async () => {
    make().start();
    await settle();
    source().send('change', posted(101, 'd1'));
    const first = source();
    first.readyState = 2; // the browser gave up
    session.recheck();
    await settle();
    assert.equal(sources.length, 2);
    assert.equal(source().since, 101);
    assert.equal(fetched, 1);
  });

  it('goes on from the board it already holds, as when its board is renamed', async () => {
    const held = { ...served, ver: 7 } as LiveBoard;
    make(held).start();
    await settle();
    assert.equal(fetched, 0);
    assert.equal(source().since, 7);
  });

  it('stops and says so when the server says the board was deleted', async () => {
    make().start();
    await settle();
    source().send('deleted', {});
    assert.equal(deleted, 1);
    assert.equal(source().closed, true, 'it stops listening');
    session.recheck();
    await settle();
    assert.equal(sources.length, 1, 'and does not connect again');
    assert.equal(deleted, 1);
  });

  it('finds out the board is gone when the stream is refused and the server no longer knows it', async () => {
    make().start();
    await settle();
    const gone = new Error('No board with id "b1".') as Error & { status: number };
    gone.status = 404;
    state = () => {
      throw gone;
    };
    const refused = source();
    refused.readyState = 2;
    refused.onerror?.();
    await settle();
    assert.equal(deleted, 1);
    assert.ok(errors.every((message) => message === null), 'not an error to show');
  });

  it('shows an unknown board as an error, not as deleted, when it never had it', async () => {
    const missing = new Error('No board with id "b1".') as Error & { status: number };
    missing.status = 404;
    session = new BoardSession({
      boardId: 'b1',
      feed: () => feed,
      fetchBoard: async () => {
        throw missing;
      },
      fetchLive: async () => state(),
      open: (url) => new FakeSource(url),
      onBoard: (board) => shown.push(board),
      onError: (message) => errors.push(message),
      onLive: () => {},
      onDeleted: () => deleted++,
    });
    session.start();
    await settle();
    assert.equal(deleted, 0);
    assert.deepEqual(errors, ['No board with id "b1".']);
  });

  it('compares itself with the server, on its pings and when the tab is looked at again', async () => {
    make().start();
    await settle();
    source().send('change', posted(101, 'd1'));

    source().send('ping', { ver: 101, seq: 101, tally: tallyOf(latest()) });
    await settle();
    assert.equal(checked, 0, 'agreeing: nothing to do');

    const behind = source();
    behind.send('ping', { ver: 105, seq: 105, tally: tallyOf(latest()) });
    assert.equal(sources.length, 2, 'the server is further on: it listens again from where it was');
    assert.equal(source().since, 101);

    // Same change number but not the same board: looked at twice, then fetched.
    mock.timers.enable({ apis: ['setTimeout'] });
    const drift = { ver: 101, seq: 101, tally: { ...tallyOf(latest()), blocks: 4 } };
    state = () => drift;
    source().send('ping', drift);
    await settle();
    assert.equal(checked, 1);
    mock.timers.tick(400);
    await settle();
    assert.equal(checked, 2);
    await settle();
    assert.equal(fetched, 2, 'it fetches the board');
  });

  it('does not fetch for a difference that was only a change not yet announced', async () => {
    make().start();
    await settle();
    mock.timers.enable({ apis: ['setTimeout'] });
    const ahead = { ver: 100, seq: 100, tally: { ...tallyOf(latest()), decisions: 1 } };
    let calls = 0;
    state = () => (++calls === 1 ? ahead : { ver: 100, seq: 3, tally: tallyOf(latest()) });
    void session.verify();
    await settle();
    mock.timers.tick(400);
    await settle();
    assert.equal(checked, 2);
    assert.equal(fetched, 1);
  });

  it('replaces a connection that has gone quiet', async () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'] });
    make().start();
    await settle();
    assert.equal(sources.length, 1);
    mock.timers.tick(30_000);
    assert.equal(sources.length, 1, 'quiet for a while is fine: the server pings every 20 s');
    source().send('ping', { ver: 100, seq: 3, tally: tallyOf(latest()) });
    mock.timers.tick(40_000);
    assert.equal(sources.length, 1, 'a ping is heard');
    mock.timers.tick(20_000);
    assert.equal(sources.length, 2, 'nothing for 50 seconds');
    assert.equal(source().since, 100);
  });

  it('says when it cannot fetch the board, and tries again', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    let fail = true;
    const make2 = new BoardSession({
      boardId: 'b1',
      feed: () => feed,
      fetchBoard: async () => {
        fetched++;
        if (fail) throw new Error('Request failed (500)');
        return structuredClone(served);
      },
      fetchLive: async () => state(),
      open: (url) => {
        const s = new FakeSource(url);
        sources.push(s);
        return s;
      },
      onBoard: (board) => shown.push(board),
      onError: (message) => errors.push(message),
      onLive: () => {},
      onDeleted: () => deleted++,
    });
    session = make2;
    session.start();
    await settle();
    assert.deepEqual(errors, ['Request failed (500)']);
    fail = false;
    mock.timers.tick(3000);
    await settle();
    assert.deepEqual(errors, ['Request failed (500)', null]);
    assert.equal(shown.length, 1);
  });
});

describe('The events a page was sent', () => {
  it('answers from where it fetched, and says when it cannot', () => {
    const feed = new EventFeed();
    assert.equal(feed.since(0, 0), undefined, 'no board yet');
    feed.reset(10);
    assert.deepEqual(feed.since(10, 10), []);
    feed.push([{ ...event(11), actor: sam }, event(12)], 12);
    feed.push([event(12), event(13)], 13); // 12 again: held already
    assert.deepEqual(feed.since(10, 13)?.map((e) => e.seq), [11, 12, 13]);
    assert.deepEqual(feed.since(12, 13)?.map((e) => e.seq), [13]);
    assert.deepEqual(feed.since(11, 12)?.map((e) => e.seq), [12], 'up to the board event asked for');
    assert.equal(feed.since(9, 13), undefined);
    assert.equal(feed.since(13, 15), undefined);
  });

  it('lets go of the oldest, and says it no longer holds what it let go', () => {
    const feed = new EventFeed();
    feed.reset(0);
    feed.push(Array.from({ length: 1200 }, (_, i) => event(i + 1)), 1200);
    assert.equal(feed.since(0, 1200), undefined);
    assert.equal(feed.since(200, 1200)?.length, 1000);
  });
});
