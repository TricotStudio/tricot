import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  MAP,
  areaRows,
  dependsPath,
  duration,
  focusedDecisions,
  isApproval,
  layoutDecisionMap,
  statusCounts,
  timeScale,
  timeTicks,
  type Box,
  type DecisionMapLayout,
} from '../src/core/decisionMap';
import { Store } from '../src/core/store';
import type { Actor, Board, Decision } from '../src/core/types';

// Day and time labels are local; pin the zone so they read the same anywhere.
process.env.TZ = 'UTC';

const HOUR = 3_600_000;
const agent: Actor = { kind: 'agent', name: 'Claude' };
const human: Actor = { kind: 'human', name: 'Wassim' };
const NOW = Date.parse('2026-10-30T17:00:00Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function boxes(layout: DecisionMapLayout): (Box & { key: string })[] {
  return [...layout.nodes, ...layout.chips];
}

describe('decision map: pieces', () => {
  it('tells approvals from questions by their wording', () => {
    assert.equal(isApproval({ question: 'Commit the tasks work?' }), true);
    assert.equal(isApproval({ question: '  commit T17–T27?' }), true);
    assert.equal(isApproval({ question: 'Should we commit now?' }), false);
    assert.equal(isApproval({ question: 'Committee or solo review?' }), false);
  });

  it('reads durations the way the map labels them', () => {
    assert.equal(duration(20_000), '1m');
    assert.equal(duration(45 * 60_000), '45m');
    assert.equal(duration(75 * 60_000), '1h 15m');
    assert.equal(duration(18 * HOUR), '18h');
    assert.equal(duration(52 * HOUR), '2d 4h');
    assert.equal(duration(12 * 24 * HOUR), '12d');
  });

  it('counts statuses, decided first', () => {
    assert.equal(statusCounts([{ status: 'open' }, { status: 'decided' }, { status: 'decided' }, { status: 'exploring' }]), '2 decided, 1 open, 1 exploring');
    assert.equal(statusCounts([]), '');
  });

  it('squeezes quiet stretches into a narrow gap and keeps time running left to right', () => {
    const times = [0, HOUR, 2 * HOUR, 12 * HOUR, 13 * HOUR];
    const scale = timeScale(times, { x0: 0, x1: 1000, quietMs: 3 * HOUR, gapW: 30, pad: 16 });
    assert.equal(scale.segments.length, 2);
    assert.equal(scale.gaps.length, 1);
    assert.equal(scale.gaps[0].w, 30);
    assert.equal(scale.gaps[0].ms, 10 * HOUR);
    // Ten quiet hours take the gap and padding; two busy hours take far more.
    const quiet = scale.x(12 * HOUR) - scale.x(2 * HOUR);
    assert.equal(Math.round(quiet), 30 + 2 * 16);
    assert.ok(scale.x(2 * HOUR) - scale.x(0) > 5 * quiet);
    // Monotonic everywhere, including inside the gap.
    let last = -Infinity;
    for (let t = -HOUR; t <= 14 * HOUR; t += HOUR / 4) {
      const x = scale.x(t);
      assert.ok(x >= last, `x(${t / HOUR}h) went backwards`);
      last = x;
    }
    // The latest time sits at the right edge, less its padding.
    assert.equal(Math.round(scale.x(13 * HOUR)), 1000 - 16);
  });

  it("doesn't stretch a short history across the room", () => {
    const scale = timeScale([0, 10 * 60_000], { x0: 0, x1: 2000, maxPxPerHour: 600 });
    assert.ok(scale.pxPerHour <= 600);
    assert.ok(scale.segments[0].x0 > 1000, 'kept to the right, by now');
  });

  it('labels round local times, naming the day on the first of each', () => {
    const start = Date.parse('2026-10-29T20:10:00Z');
    const scale = timeScale([start, start + 3 * HOUR, NOW], { x0: 0, x1: 900 });
    const ticks = timeTicks(scale, NOW, 100);
    assert.ok(ticks.length >= 2);
    for (const tick of ticks) assert.match(tick.time, /^\d\d:\d\d$/);
    assert.equal(ticks[0].day, 'Yesterday');
    assert.equal(ticks.find((t) => t.t >= Date.parse('2026-10-30T00:00:00Z'))?.day, 'Today');
    for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].x - ticks[i - 1].x >= 80, 'labels keep apart');
  });

  it('routes a dependency around a decision that sits between the two', () => {
    const a = { x: 100, y: 0, w: 200, h: 40 };
    const between = { x: 100, y: 60, w: 200, h: 40 };
    const b = { x: 120, y: 120, w: 200, h: 40 };
    const around = dependsPath(a, b, [a, between, b]);
    assert.match(around, /^M100 20 C78 20/, 'round the left');
    const straight = dependsPath(a, b, [a, b]);
    assert.match(straight, /^M\d+(\.\d)? 40 V120$/, 'straight down when nothing is in the way');
  });
});

describe('decision map: layout', () => {
  let dir: string;
  let store: Store;
  let board: Board;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-map-'));
    store = new Store(dir);
    store.load();
    board = store.createBoard({ title: 'Map' }, human);
    const post = (question: string, area?: string, extra: object = {}) =>
      store.postDecision(board.id, { question, options: [{ label: 'Yes' }, { label: 'No' }], area, ...extra }, agent);
    const decide = (d: Decision, optionId = 'a') => store.resolve(d.id, { optionId }, human);
    const naming = post('What should we call it?', 'Name and mark'); // #1
    decide(naming);
    const mark = post('Which mark?', 'Name and mark'); // #2
    store.resolve(mark.id, { optionId: 'a', provisional: true }, agent);
    store.resolve(mark.id, { optionId: 'b' }, human); // replaces the agent's answer
    const sync = post('How should connectors sync?', 'Connectors'); // #3
    decide(sync);
    post('Which connector first?', ' connectors ', { ask: ['Wassim'] }); // #4, open, asked of the viewer; joins "Connectors"
    const approval = post('Commit the connectors work?'); // #5
    decide(approval);
    const loose = post('Where do logs go?'); // #6, no area
    decide(loose);
    post('Should the map replace the lanes?', 'Views', { dependsOn: [sync.id] }); // #7, open
    store.planTasks(board.id, [{ title: 'Build sync', decisionIds: [sync.id] }, { title: 'Sync tests', decisionIds: [sync.id] }], agent);
    store.planTasks(board.id, [{ title: 'Rename', decisionIds: [naming.id] }], agent);

    // Spread it over a day with a long quiet night.
    const times: Record<number, [number, number]> = { 1: [30, 29], 2: [28, 27.5], 3: [8, 7], 4: [3, 3], 5: [6, 5.5], 6: [27, 26], 7: [1, 1] };
    for (const d of board.decisions) {
      const [created, settled] = times[d.number];
      d.createdAt = at(created);
      d.updatedAt = at(settled);
      if (d.resolution) d.resolution.at = at(settled);
      for (const past of d.history) past.at = at(created - 0.1);
    }
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const layout = (options: Partial<Parameters<typeof layoutDecisionMap>[1]> = {}) =>
    layoutDecisionMap(board, { now: NOW, width: 1100, viewer: 'Wassim', show: 'all', ...options });

  it('puts decisions in rows by area, the most recently active first and No area last', () => {
    const map = layout();
    assert.deepEqual(
      map.rows.map((r) => r.name),
      ['Connectors', 'Views', 'Name and mark', 'No area'],
    );
    assert.equal(map.rows[0].counts, '1 decided, 1 open');
    assert.equal(map.rows[2].counts, '2 decided');
    // Rows stack without gaps or overlaps.
    for (let i = 1; i < map.rows.length; i++) assert.equal(map.rows[i].y, map.rows[i - 1].y + map.rows[i - 1].h);
  });

  it('sorts rows by activity, counting a waiting decision as active now', () => {
    const rows = areaRows(board.decisions.filter((d) => !isApproval(d)), new Date(NOW).toISOString());
    assert.equal(rows[0].latest, new Date(NOW).toISOString());
    assert.equal(rows.at(-1)!.key, '');
  });

  it('keeps approvals out of the rows, as ticks on the Commits track', () => {
    const map = layout();
    assert.ok(!map.nodes.some((n) => n.number === 5));
    assert.equal(map.commits?.count, 1);
    assert.equal(map.commits?.items[0].number, 5);
    assert.ok(map.commits!.y > map.rows.at(-1)!.y + map.rows.at(-1)!.h - 1);
  });

  it('places nothing on top of anything else, and everything inside its row', () => {
    for (const width of [760, 1100, 1600]) {
      const map = layout({ width });
      const all = boxes(map);
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) assert.ok(!overlaps(all[i], all[j]), `${all[i].key} overlaps ${all[j].key} at ${width}px`);
      }
      for (const node of map.nodes) {
        const row = map.rows.find((r) => node.y >= r.y && node.y + node.h <= r.y + r.h);
        assert.ok(row, `#${node.number} sits inside a row`);
        assert.ok(node.x >= MAP.labelWidth, `#${node.number} clears the row labels`);
      }
    }
  });

  it('runs time left to right, with open decisions at now and a bar back to when they were asked', () => {
    const map = layout();
    const node = (n: number) => map.nodes.find((d) => d.number === n && !d.replaced)!;
    assert.ok(node(1).x < node(3).x, 'yesterday before today');
    const open = node(4);
    assert.ok(open.pending && open.w === MAP.pendingW, 'open ones are wider');
    assert.ok(open.x + open.w <= map.nowX, 'left of now');
    assert.equal(open.call, true, 'asked of the viewer');
    assert.equal(open.meta, 'open · asked of you');
    assert.equal(node(7).call, false, 'open, but not asked of the viewer');
    assert.equal(node(1).title, 'Yes', 'a settled one shows its answer');
    assert.equal(node(1).sub, 'What should we call it?');
    assert.ok(map.gaps.length >= 1 && /quiet$/.test(map.gaps[0].label), 'the quiet night is squeezed');
  });

  it('shows the tasks built on a decision as a chip after it, linked by a line', () => {
    const map = layout();
    const sync = map.nodes.find((n) => n.number === 3)!;
    const chip = map.chips.find((c) => c.decisionId === sync.decisionId && c.role === 'built')!;
    assert.equal(chip.label, 'T1 +1');
    assert.ok(chip.x > sync.x + sync.w);
    assert.equal(Math.round(chip.y + chip.h / 2), Math.round(sync.y + sync.h / 2));
    assert.ok(map.edges.some((e) => e.kind === 'built' && e.key.startsWith(sync.key)));
  });

  it('links dependencies, and an answer to the one it replaced', () => {
    const map = layout();
    assert.ok(map.edges.some((e) => e.kind === 'depends'));
    const ghost = map.nodes.find((n) => n.replaced)!;
    assert.equal(ghost.number, 2);
    assert.equal(ghost.title, 'Yes');
    assert.equal(ghost.sub, 'replaced by Wassim');
    assert.ok(map.edges.some((e) => e.kind === 'replaced' && e.key.startsWith(ghost.key)));
  });

  it('shows open ones and what they touch: their areas and dependencies', () => {
    const shown = focusedDecisions(board.decisions.filter((d) => !isApproval(d))).map((d) => d.number);
    assert.deepEqual(shown.sort(), [3, 4, 7]);
    const map = layout({ show: 'open' });
    assert.deepEqual(map.rows.map((r) => r.name), ['Connectors', 'Views']);
  });

  it('says when nothing is open, and when there is nothing at all', () => {
    for (const d of board.decisions) if (d.status === 'open') d.status = 'deferred';
    assert.equal(layout({ show: 'open' }).empty, 'nothing-open');
    assert.equal(layout({ show: 'all' }).empty, undefined);
    const blank = store.createBoard({ title: 'Blank' }, human);
    assert.equal(layoutDecisionMap(blank, { now: NOW, width: 1000 }).empty, 'none');
  });

  it('leaves tasks and commits off when asked to', () => {
    const map = layout({ extras: false });
    assert.equal(map.chips.length, 0);
    assert.equal(map.commits, null);
    assert.ok(!map.edges.some((e) => e.kind === 'built' || e.kind === 'asked'));
  });
});
